// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentStudioStore } from "@/lib/agent-studio/store";
import type { WorkVersion } from "@/lib/agent-studio/types";
const state = vi.hoisted(() => ({ config: null as unknown, store: null as unknown as AgentStudioStore, root: "" }));
vi.mock("@/lib/agent-studio/store", async original => ({ ...await original<typeof import("@/lib/agent-studio/store")>(), studioStore: () => state.store }));
vi.mock("@/lib/paths", () => ({ getOutputDir: () => state.root }));
vi.mock("@/lib/agent-studio/ai-nodes-client", () => ({ callAiNodes: vi.fn(), aiNodesConfigured: () => true }));
vi.mock("@/lib/object-storage-server", async original => ({ ...await original<typeof import("@/lib/object-storage-server")>(), uploadToObjectStorage: vi.fn() }));
vi.mock("@/lib/agent-studio/catalog", () => ({ recordAgentProgress: vi.fn(), syncAgentWork: vi.fn() }));
vi.mock("@/lib/agent-studio/engine", () => ({ cropUrl:vi.fn(),hasVideoKey:vi.fn(),initializeVersion:vi.fn(),prepareCrop:vi.fn(),reconcileTask:vi.fn(),recoverWork:vi.fn(),rememberKey:vi.fn() }));
vi.mock("@/lib/server-object-storage", () => ({ requireServerObjectStorage: () => { if (!state.config) throw new Error("Configure local storage"); return state.config; } }));
import { superResolve } from "@/lib/agent-studio/super-resolution";
import { callAiNodes } from "@/lib/agent-studio/ai-nodes-client";
import { uploadToObjectStorage } from "@/lib/object-storage-server";
const c = { endpoint: "https://tos-s3-cn-beijing.volces.com", region: "cn-beijing", bucket: "test-bucket", accessKeyId: "test-ak", secretAccessKey: "test-secret" };
let workId: string, dir: string, db: Database.Database;
const current = () => state.store.work(workId).versions[0].superResolution!;
beforeEach(async () => {
  vi.clearAllMocks(); state.config = c; state.root = await mkdtemp(join(tmpdir(), "clipforge-sr-test-"));
  db = new Database(":memory:"); state.store = new AgentStudioStore(db);
  workId = state.store.create({ title: "Test", sourceAssetId: "a", sourceName: "a", sourceUrl: "/a", duration: 9, brief: "test", runtimeId: null, resolution: "480p", voice: "female" }).id;
  state.store.update(workId, w => { w.status = "completed"; w.versions.push({ id: "version", status: "completed", outputUrl: "/original.mp4" } as WorkVersion); });
  dir = join(state.root, "agent-studio", workId, "versions", "version"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "final.mp4"), "original");
  vi.mocked(uploadToObjectStorage).mockResolvedValue("https://test-bucket.tos-s3-cn-beijing.volces.com/input.mp4?input-signature");
  vi.mocked(callAiNodes).mockImplementation(async (cmd, id) => cmd === "submit" ? { workflow_id: id, run_id: "run-1" } : { status: "RUNNING", stage: "processing" });
});
afterEach(async () => { db.close(); await rm(state.root, { recursive: true, force: true }); vi.unstubAllGlobals(); });
describe("Agent Studio super resolution", () => {
  it("rejects storage credentials at the HTTP boundary without submitting a task", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/agent-studio/works/[id]/route");
    const response = await POST(new NextRequest(`http://localhost/api/agent-studio/works/${workId}`, { method:"POST", body: JSON.stringify({action:"upscale",operation:"start",versionId:"version",objectStorage:c}) }), {params:Promise.resolve({id:workId})});
    expect(response.status).toBe(400);expect(await response.text()).not.toContain("test-secret");expect(callAiNodes).not.toHaveBeenCalled();expect(uploadToObjectStorage).not.toHaveBeenCalled();
  });
  it("signs distinct PUT and GET URLs for the same output without sending storage credentials", async () => {
    await superResolve(workId, "version", "start");
    const [cmd, id, raw] = vi.mocked(callAiNodes).mock.calls[0], request = raw as { request_id: string; input_url: string; target: string; video_preset: string; output: { put_url: string; read_url?: string; headers: object } };
    expect(cmd).toBe("submit"); expect(id).toBe(`media-sr-${request.request_id}`); expect(request.target).toBe("1080p"); expect(request.video_preset).toBe("base");
    const put = new URL(request.output.put_url);
    const read = new URL(request.output.read_url!);
    expect(put.hostname).toBe("test-bucket.tos-s3-cn-beijing.volces.com");
    expect(read.origin + read.pathname).toBe(put.origin + put.pathname);
    expect(read.searchParams.get("X-Amz-Expires")).toBe("172800");
    expect(read.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(read.searchParams.get("X-Amz-Signature")).not.toBe(put.searchParams.get("X-Amz-Signature"));
    expect(JSON.stringify(request)).not.toMatch(/test-secret|secretAccessKey|accessKeyId/);
    expect(put.searchParams.get("X-Amz-Expires")).toBe("172800"); expect(request.output.headers).toEqual({ "Content-Type": "video/mp4" });
    expect(current().runId).toBe("run-1"); expect(JSON.stringify(state.store.work(workId))).not.toMatch(/test-secret|test-ak|X-Amz|input-signature/);
    expect(state.store.work(workId).versions[0].outputUrl).toBe("/original.mp4");
  });
  it("deduplicates concurrent clicks and later retries against a saved pending workflow", async () => {
    await Promise.all([superResolve(workId, "version", "start"), superResolve(workId, "version", "start")]);
    await superResolve(workId, "version", "start"); expect(callAiNodes).toHaveBeenCalledTimes(1);
  });
  it("keeps ambiguous submissions durable and queries the same workflow instead of resubmitting", async () => {
    vi.mocked(callAiNodes).mockRejectedValueOnce(new Error("secret signed URL")); await superResolve(workId, "version", "start");
    expect(current().status).toBe("unknown"); expect(current().error).not.toContain("secret"); const id = current().workflowId;
    await superResolve(workId, "version", "start"); await superResolve(workId, "version", "status");
    expect(callAiNodes).toHaveBeenCalledTimes(2); expect(vi.mocked(callAiNodes).mock.calls[1]).toEqual(["status", id]); expect(current().status).toBe("processing");
  });
  it("does not submit when upload fails", async () => {
    vi.mocked(uploadToObjectStorage).mockRejectedValueOnce(new Error("secret")); await superResolve(workId, "version", "start");
    expect(current().status).toBe("failed"); expect(callAiNodes).not.toHaveBeenCalled();
  });
  // Value: protects=interrupted uploads can recover without submitting an uncertain workflow twice; fails_when=pre-submit recovery is absent; why_new=upload rejection cannot model process loss; seam=none
  it("recovers a persisted interrupted upload and permits a deliberate retry", async () => {
    await superResolve(workId, "version", "start");
    const interruptedId = current().requestId;
    state.store.update(workId, w => {
      for (const task of [w.versions[0].superResolution, ...w.versions[0].superResolutions!]) {
        task!.status = "submitting"; delete task!.apiCallId;
      }
    });
    vi.mocked(callAiNodes).mockClear(); vi.mocked(uploadToObjectStorage).mockClear();
    await superResolve(workId, "version", "status");
    expect(current().status).toBe("failed"); expect(current().error).toContain("no workflow submitted");
    expect(callAiNodes).not.toHaveBeenCalled(); expect(uploadToObjectStorage).not.toHaveBeenCalled();
    await superResolve(workId, "version", "restart");
    expect(current().requestId).not.toBe(interruptedId); expect(current().status).toBe("processing");
    expect(state.store.work(workId).versions[0].superResolutions).toHaveLength(2);
    expect(callAiNodes).toHaveBeenCalledTimes(1);
  });
  it("rejects empty and oversized input before uploading", async () => {
    await writeFile(join(dir, "final.mp4"), ""); await expect(superResolve(workId, "version", "start")).rejects.toThrow("200MB");
    const { truncate } = await import("node:fs/promises"); await truncate(join(dir, "final.mp4"), 200_000_001);
    await expect(superResolve(workId, "version", "start")).rejects.toThrow("200MB"); expect(uploadToObjectStorage).not.toHaveBeenCalled();
  });
  it("rejects non-TOS storage and incomplete video versions", async () => {
    state.config = { ...c, endpoint: "http://localhost:9000" }; await expect(superResolve(workId, "version", "start")).rejects.toThrow("HTTPS"); state.config = c;
    state.store.update(workId, w => { w.versions[0].status = "generating"; });
    await expect(superResolve(workId, "version", "start")).rejects.toThrow("completed"); expect(callAiNodes).not.toHaveBeenCalled();
  });
  it("refreshes only the existing destination after expiration", async () => {
    await superResolve(workId, "version", "start"); const id = current().workflowId, key = current().objectKey;
    vi.mocked(callAiNodes).mockResolvedValueOnce({ status: "RUNNING", stage: "waiting_for_output_url" }); await superResolve(workId, "version", "status");
    expect(current().status).toBe("waiting_for_output_url");
    state.config = { ...c, bucket: "other-bucket" }; await expect(superResolve(workId, "version", "refresh")).rejects.toThrow("original TOS"); state.config = c;
    await superResolve(workId, "version", "refresh"); expect(vi.mocked(callAiNodes).mock.calls.at(-1)?.slice(0, 2)).toEqual(["set-output", id]); expect(current().objectKey).toBe(key); expect(current().status).toBe("processing");
    const refreshed = vi.mocked(callAiNodes).mock.calls.at(-1)?.[2] as { put_url: string; read_url: string };
    expect(new URL(refreshed.read_url).pathname).toBe(new URL(refreshed.put_url).pathname);
    expect(new URL(refreshed.read_url).searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });
  it("waits for Temporal to confirm cancellation", async () => {
    await superResolve(workId, "version", "start"); await superResolve(workId, "version", "cancel"); expect(current().status).toBe("processing");
    vi.mocked(callAiNodes).mockResolvedValueOnce({ status: "CANCELED" }); await superResolve(workId, "version", "status"); expect(current().status).toBe("cancelled");
  });
  // Value: protects=only matching video PUT receipts publish completion; fails_when=result identity or transport checks are removed; why_new=existing completion receipt was valid; seam=none
  it.each([{ request_id: "other-task" }, { media_type: "image" }, { upload_mode: "managed_s3" }])("rejects a mismatched completion receipt %j", async change => {
    await superResolve(workId, "version", "start");
    vi.mocked(callAiNodes).mockResolvedValueOnce({ status: "COMPLETED" }).mockResolvedValueOnce({ request_id: current().requestId, media_type: "video", upload_mode: "presigned_put", width: 1080, height: 1920, bytes: 6, sha256: "a".repeat(64), ...change });
    await expect(superResolve(workId, "version", "status")).rejects.toThrow("Invalid upscale result");
    expect(current().status).toBe("processing"); expect(current().outputUrl).toBeUndefined();
    expect(state.store.work(workId).versions[0].outputUrl).toBe("/original.mp4");
  });
  it("publishes stable metadata on completion without downloading the result or trusting an upstream read URL", async () => {
    await superResolve(workId, "version", "start");
    const hash = createHash("sha256").update("result").digest("hex");
    vi.mocked(callAiNodes).mockResolvedValueOnce({ status: "COMPLETED" }).mockResolvedValueOnce({ request_id: current().requestId, media_type: "video", upload_mode: "presigned_put", width:1080,height:1920,bytes:6,sha256:hash,download_url:"https://attacker.invalid" });
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher); state.config=null;
    await superResolve(workId,"version","status");
    expect(current().status).toBe("completed"); expect(current().outputUrl).toBe(`/api/agent-studio/resources/${current().requestId}`); expect(current().result).toEqual({sha256:hash,bytes:6,width:1080,height:1920}); expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(join(dir,"final.mp4"),"utf8")).toBe("original");
  });
});

describe("upscale parameters and independent retries", () => {
  it.each([{seed:-1},{seed:1.2},{seed:2147483648},{target:"4k"},{capabilityId:"unknown"},{videoPreset:"turbo"},{put_url:"https://example.com"}])("rejects unsupported parameters %s before upload or submission", async p => {
    await expect(superResolve(workId,"version","start",p)).rejects.toThrow(); expect(uploadToObjectStorage).not.toHaveBeenCalled(); expect(callAiNodes).not.toHaveBeenCalled();
  });
  it("passes explicit v1 parameters to the upstream contract", async () => {
    await superResolve(workId,"version","start",{seed:0,videoPreset:"base",target:"1080p",capabilityId:"media.super_resolution.v1"});
    expect(vi.mocked(callAiNodes).mock.calls[0][2]).toMatchObject({seed:0,video_preset:"base",target:"1080p"}); expect(current().parameters?.seed).toBe(0);
  });
  it("allows a deliberate rerun after completion, keeping every earlier output and always reading the original video", async () => {
    await superResolve(workId,"version","start");
    const first = {...current(),status:"completed" as const,outputUrl:"/old-upscale.mp4"};
    state.store.update(workId,w=>{w.versions[0].superResolution=first;w.versions[0].superResolutions=[first];});
    await Promise.all([superResolve(workId,"version","restart",{seed:42}),superResolve(workId,"version","restart",{seed:42})]);
    const history=state.store.work(workId).versions[0].superResolutions!; expect(history).toHaveLength(2); expect(history[0].outputUrl).toBe("/old-upscale.mp4"); expect(history[1].requestId).not.toBe(first.requestId); expect(history[1].parameters?.seed).toBe(42);
    expect(callAiNodes).toHaveBeenCalledTimes(2); expect(vi.mocked(uploadToObjectStorage).mock.calls.at(-1)?.[1]).toBe(await realpath(join(dir,"final.mp4")));
    await superResolve(workId,"version","restart"); expect(callAiNodes).toHaveBeenCalledTimes(2);
  });
  it("continues to block new runs while the previous submission is unknown", async () => {
    vi.mocked(callAiNodes).mockRejectedValueOnce(new Error("timeout")); await superResolve(workId,"version","start");
    await superResolve(workId,"version","restart",{seed:7}); expect(callAiNodes).toHaveBeenCalledTimes(1); expect(current().status).toBe("unknown");
  });
});

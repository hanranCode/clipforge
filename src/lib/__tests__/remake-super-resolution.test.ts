// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, root: "", config: null as unknown, configured: true }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paths", () => ({ getUploadsDir: () => state.root, getDataDir: () => dirname(state.root) }));
vi.mock("@/lib/agent-studio/ai-nodes-client", () => ({ callAiNodes: vi.fn(), aiNodesConfigured: () => state.configured }));
vi.mock("@/lib/object-storage-server", async original => ({ ...await original<typeof import("@/lib/object-storage-server")>(), uploadToObjectStorage: vi.fn() }));
vi.mock("@/lib/server-object-storage", () => ({ getServerObjectStorage: () => state.config, requireServerObjectStorage: () => { if (!state.config) throw new Error("Configure server storage"); return state.config; } }));
vi.mock("@/lib/media-resource-cache", async original => ({ ...await original<typeof import("@/lib/media-resource-cache")>(), cachedVideo: vi.fn() }));
vi.mock("@/lib/media-probe", () => ({ probeMedia: vi.fn() }));
import { upscaleRemake, remakeUpscaleTasks } from "@/lib/remake/super-resolution";
import { callAiNodes } from "@/lib/agent-studio/ai-nodes-client";
import { uploadToObjectStorage } from "@/lib/object-storage-server";
import { cachedVideo } from "@/lib/media-resource-cache";
import { probeMedia } from "@/lib/media-probe";
import { GET, POST } from "@/app/api/remake/upscale/[id]/route";
const config = { endpoint: "https://tos-s3-cn-beijing.volces.com", region: "cn-beijing", bucket: "test-bucket", accessKeyId: "private-ak", secretAccessKey: "private-sk" };
let sqlite: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>, resultFile: string;
const current = () => remakeUpscaleTasks("original").at(-1)!;
const context = { params: Promise.resolve({ id: "original" }) };
const query = () => GET(new NextRequest("http://localhost/api/remake/upscale/original"), context);
beforeEach(async () => {
  vi.clearAllMocks(); state.config = config; state.configured = true;
  state.root = join(await mkdtemp(join(tmpdir(), "clipforge-remake-sr-")), "uploads");
  await mkdir(join(state.root, "_library"), { recursive: true });
  await writeFile(join(state.root, "_library", "original.mp4"), "original");
  resultFile = join(state.root, "result.mp4"); await writeFile(resultFile, "upscaled");
  sqlite = new Database(":memory:"); db = drizzle(sqlite, { schema }); state.db = db;
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.libraryAssets).values({ id: "original", mediaType: "video", filePath: "/api/files/_library/original.mp4", title: "复刻成片", tags: ["视频复刻"], width: 480, height: 854, durationSec: 9 }).run();
  vi.mocked(uploadToObjectStorage).mockResolvedValue("https://bucket/input.mp4?private-signature");
  vi.mocked(cachedVideo).mockResolvedValue(resultFile);
  vi.mocked(probeMedia).mockImplementation(async path => ({ width: path === resultFile ? 1080 : 480, height: path === resultFile ? 1920 : 854, duration: 9, hasAudio: true, frameRate: 30, videoCodec: "h264", audioCodec: "aac", format: "mp4" }));
  vi.mocked(callAiNodes).mockImplementation(async (cmd, id) => cmd === "submit" ? { workflow_id: id, run_id: "run-1" } : { status: "RUNNING" });
});
afterEach(async () => { sqlite.close(); await rm(dirname(state.root), { recursive: true, force: true }); });
async function complete() {
  vi.mocked(callAiNodes).mockResolvedValueOnce({ status: "COMPLETED" }).mockResolvedValueOnce({ request_id: current().requestId, media_type: "video", upload_mode: "presigned_put", width: 1080, height: 1920, bytes: 8, sha256: createHash("sha256").update("upscaled").digest("hex") });
  await upscaleRemake("original", "status");
}
describe("remake 1080p upscale", () => {
  it("persists before upload, submits 1080p and keeps the original file/record", async () => {
    vi.mocked(uploadToObjectStorage).mockImplementationOnce(async () => {
      expect(current().status).toBe("submitting"); return "https://bucket/input.mp4?private-signature";
    });
    await upscaleRemake("original", "start", { target: "1080p", seed: 42 });
    expect(current()).toMatchObject({ status: "processing", parameters: { target: "1080p", seed: 42 }, runId: "run-1" });
    expect(vi.mocked(callAiNodes).mock.calls[0][2]).toMatchObject({ input_url: "https://bucket/input.mp4?private-signature", target: "1080p", video_preset: "base", seed: 42 });
    const payload = vi.mocked(callAiNodes).mock.calls[0][2] as { output: { put_url: string; read_url: string } };
    const read = new URL(payload.output.read_url), put = new URL(payload.output.put_url);
    expect(read.origin + read.pathname).toBe(put.origin + put.pathname);
    expect(read.searchParams.get("X-Amz-Expires")).toBe("172800");
    expect(read.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(read.searchParams.get("X-Amz-Signature")).not.toBe(put.searchParams.get("X-Amz-Signature"));
    expect(await readFile(join(state.root, "_library/original.mp4"), "utf8")).toBe("original");
    const snapshot = await (await query()).json();
    expect(snapshot.tasks).toHaveLength(1); expect(JSON.stringify(snapshot)).not.toMatch(/private-sk|private-signature|private-ak/);
  });
  it("deduplicates pending submits and recovers unknown submissions by the same workflow ID", async () => {
    vi.mocked(callAiNodes).mockRejectedValueOnce(new Error("private details"));
    await Promise.all([upscaleRemake("original", "start"), upscaleRemake("original", "start")]);
    expect(current().status).toBe("unknown"); const id = current().workflowId;
    await upscaleRemake("original", "restart"); await upscaleRemake("original", "status");
    expect(vi.mocked(callAiNodes).mock.calls.map(c => c.slice(0, 2))).toEqual([["submit", id], ["status", id]]);
    expect(remakeUpscaleTasks("original")).toHaveLength(1);
  });
  it("archives a verified result as a separate reusable library video with original lineage", async () => {
    await upscaleRemake("original", "start"); await complete();
    expect(current().status).toBe("completed"); expect(current().outputUrl).toMatch(/^\/api\/files\/_library\/remake-upscale-.*\.mp4$/);
    const asset = db.select().from(schema.libraryAssets).where(eq(schema.libraryAssets.id, `remake-upscale-${current().requestId}`)).get()!;
    expect(asset).toMatchObject({ width: 1080, height: 1920, sourceUrl: "/api/files/_library/original.mp4", importSource: "generated" });
    expect(await readFile(join(state.root, "_library", asset.filePath.split("/").at(-1)!), "utf8")).toBe("upscaled");
    expect(await readFile(join(state.root, "_library/original.mp4"), "utf8")).toBe("original");
    await upscaleRemake("original", "start"); await upscaleRemake("original", "status");
    expect(callAiNodes).toHaveBeenCalledTimes(3); expect(db.select().from(schema.libraryAssets).all()).toHaveLength(2);
  });
  it("recovers a failed output download on GET without submitting or rerunning inference", async () => {
    await upscaleRemake("original", "start"); vi.mocked(cachedVideo).mockRejectedValueOnce(new Error("unreachable"));
    await expect(complete()).rejects.toThrow("archiving");
    expect(current().status).toBe("completed"); expect(current().outputUrl).toBeUndefined();
    const result = await query(); expect(result.status).toBe(200); expect(current().outputUrl).toBeTruthy();
    expect(callAiNodes).toHaveBeenCalledTimes(3);
  });
  // Value: protects=only duration/audio-preserving 1080P results enter the library; fails_when=media validation is removed; why_new=existing case covered only low resolution; seam=none
  it.each([
    { width: 480, height: 854, duration: 9, hasAudio: true },
    { width: 1080, height: 1920, duration: 9, hasAudio: false },
    { width: 1080, height: 1920, duration: 12, hasAudio: true },
  ])("rejects an invalid upscale before publishing: %j", async output => {
    await upscaleRemake("original", "start");
    vi.mocked(probeMedia).mockResolvedValueOnce({ ...output, frameRate: 30 } as Awaited<ReturnType<typeof probeMedia>>);
    await expect(complete()).rejects.toThrow("archiving");
    expect(current().outputUrl).toBeUndefined(); expect(db.select().from(schema.libraryAssets).all()).toHaveLength(1);
  });
  it("supports deliberate reruns with separate IDs while retaining prior outputs", async () => {
    await upscaleRemake("original", "start"); await complete(); const first = { ...current() };
    await upscaleRemake("original", "restart", { seed: 7 });
    expect(remakeUpscaleTasks("original")).toHaveLength(2);
    expect(remakeUpscaleTasks("original")[0].outputUrl).toBe(first.outputUrl); expect(current().requestId).not.toBe(first.requestId);
    expect(uploadToObjectStorage).toHaveBeenLastCalledWith(config, await realpath(join(state.root, "_library/original.mp4")));
  });
  it("does not submit if the local service or storage is unconfigured", async () => {
    state.configured = false; await expect(upscaleRemake("original", "start")).rejects.toThrow("Configure AI Nodes");
    state.configured = true; state.config = null; await expect(upscaleRemake("original", "start")).rejects.toThrow("server storage");
    expect(callAiNodes).not.toHaveBeenCalled();
  });
  it("rejects uploaded credentials and cross-origin mutation requests", async () => {
    const send = (payload: unknown, origin?: string) => POST(new NextRequest("http://localhost/api/remake/upscale/original", { method: "POST", headers: origin ? { origin } : {}, body: JSON.stringify(payload) }), context);
    expect((await send({ operation: "start", objectStorage: config })).status).toBe(400);
    expect((await send({ operation: "start" }, "https://evil.example.com")).status).toBe(403);
    expect(callAiNodes).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { AgentStudioStore } from "@/lib/agent-studio/store";
import type { AgentJob, AgentPlan } from "@/lib/agent-studio/types";
import type { StudioVideoChoice } from "@/lib/agent-studio/video-models";
const state = vi.hoisted(() => ({ store: null as unknown as AgentStudioStore }));
vi.mock("@/lib/agent-studio/store", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/agent-studio/store")>(), studioStore: () => state.store }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/asr-server", () => ({ transcribeSourceChunk: vi.fn() }));
vi.mock("@/lib/edge-tts", () => ({ generateSpeechFreeDetailed: vi.fn() }));
import { advanceGeneration, rememberKey } from "@/lib/agent-studio/engine";
let db: Database.Database;
const plan: AgentPlan = { summary: "New presenter", preserve: ["Product"], change: ["Voice"], notes: [], productCrop: null, segments: [{ duration: 9, script: "介绍产品。", prompt: "A fictional presenter demonstrates five bins." }] };
function generation(video?: StudioVideoChoice) {
  const s = state.store, r = s.register("test", "codex");
  const w = s.create({ title: "Test", sourceAssetId: "x", sourceUrl: "/api/files/test.mp4", sourceName: "test", duration: 9, brief: "new presenter", runtimeId: r.runtime.id, resolution: "480p", voice: "female", video });
  const analysis = s.enqueue(w.id, "plan"); s.claim(r.runtime.id); s.completePlan(analysis.id, plan);
  const version = s.approve(w.id, 5, JSON.stringify(plan)); rememberKey(version.id, "test-only-not-a-real-key");
  s.update(w.id, w => { w.versions[0].prepared = true; });
  const job = s.claim(r.runtime.id) as AgentJob; return { work: w, version, job };
}
beforeEach(() => { db = new Database(":memory:"); state.store = new AgentStudioStore(db); });
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("paid video submission boundary (fully mocked network)", () => {
  it("submits Bailian and polls the frozen workspace/model even if future work settings change", async () => {
    const baseUrl = "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1";
    const { work, job } = generation({ provider: "alibaba", model: "wan3.0-video", baseUrl });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ output: { task_id: "bailian-paid-123", task_status: "PENDING" } }))
      .mockResolvedValueOnce(Response.json({ output: { task_id: "bailian-paid-123", task_status: "RUNNING" } }));
    vi.stubGlobal("fetch", fetcher);
    await advanceGeneration(job);
    expect(state.store.work(work.id).versions[0].receipts[0]).toMatchObject({ state: "submitted", taskId: "bailian-paid-123" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${baseUrl}/services/aigc/video-generation/video-synthesis`);
    expect(new Headers(init.headers).get("X-DashScope-Async")).toBe("enable");
    expect(JSON.parse(init.body)).toMatchObject({ model: "wan3.0-video", input: { prompt: expect.stringContaining("准确说出") }, parameters: { resolution: "480P", duration: 9, ratio: "9:16", audio: true } });
    state.store.update(work.id, current => { current.video = { provider: "volcengine", model: "doubao-seedance-2-0-mini-260615" }; current.resolution = "720p"; });
    await advanceGeneration(job);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe(`${baseUrl}/tasks/bailian-paid-123`);
    expect(fetcher.mock.calls[1][1].method).toBe("GET");
  });

  it("honours the selected Ark model and custom endpoint", async () => {
    const { job } = generation({ provider: "volcengine", model: "doubao-seedance-2-0-260128", baseUrl: "https://ark.example.com/api/v3" });
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "cgt-selected-123456" }));
    vi.stubGlobal("fetch", fetcher);
    // The selected standard model needs a larger pre-approved reserve than Mini.
    state.store.update(job.workId, w => { w.versions[0].budgetCny = 20; });
    await advanceGeneration(job);
    expect(fetcher.mock.calls[0][0]).toBe("https://ark.example.com/api/v3/contents/generations/tasks");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).model).toBe("doubao-seedance-2-0-260128");
  });
  it("persists a task ID and only polls that ID on the next advance", async () => {
    const {work, job} = generation(); const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: "cgt-test-123456" })).mockResolvedValueOnce(Response.json({status:"running"})); vi.stubGlobal("fetch", fetcher);
    await advanceGeneration(job); expect(state.store.work(work.id).versions[0].receipts[0]).toMatchObject({ state: "submitted", taskId: "cgt-test-123456" });
    await advanceGeneration(job); expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[0][1].method).toBe("POST"); expect(fetcher.mock.calls[1][1].method).toBe("GET"); expect(fetcher.mock.calls[1][0]).toContain("/cgt-test-123456");
    const payload = JSON.parse(fetcher.mock.calls[0][1].body); expect(payload.model).toBe("doubao-seedance-2-0-mini-260615"); expect(payload.resolution).toBe("480p"); expect(payload.content).toHaveLength(1);
  });
  it("an ambiguous submission is retained as unknown and never automatically posted again", async () => {
    const {work, job} = generation(); const fetcher = vi.fn().mockRejectedValue(new Error("network timeout")); vi.stubGlobal("fetch", fetcher);
    await expect(advanceGeneration(job)).rejects.toThrow("network timeout"); expect(state.store.work(work.id).versions[0].receipts[0].state).toBe("unknown"); await expect(advanceGeneration(job)).rejects.toThrow("未知"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves an upstream task receipt if cancellation occurs while POST is in flight", async () => {
    const {work, job} = generation(); vi.stubGlobal("fetch", vi.fn(async () => { state.store.cancel(work.id); return Response.json({id:"cgt-cancelled-123456"}); }));
    await advanceGeneration(job); const saved = state.store.work(work.id); expect(saved.status).toBe("cancelled"); expect(saved.versions[0].receipts[0].taskId).toBe("cgt-cancelled-123456"); await expect(advanceGeneration(job)).rejects.toThrow("租约");
  });
  it("retains a definitive provider rejection as unsubmitted, without a task ID", async () => {
    const { work, job } = generation(); const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: "InvalidApiKey", message: "invalid credentials" } }, { status: 401 })); vi.stubGlobal("fetch", fetcher);
    await expect(advanceGeneration(job)).rejects.toThrow("401"); expect(state.store.work(work.id).versions[0].receipts[0]).toMatchObject({ state: "pending" }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("checks remaining budget before any provider call", async () => {
    const {work, job} = generation(); state.store.update(work.id, w => { w.versions[0].budgetCny = 0; }); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await expect(advanceGeneration(job)).rejects.toThrow("预算不足"); expect(fetcher).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { AgentStudioStore } from "@/lib/agent-studio/store";
import type { AgentJob, AgentPlan } from "@/lib/agent-studio/types";
const state = vi.hoisted(() => ({ store: null as unknown as AgentStudioStore }));
vi.mock("@/lib/agent-studio/store", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/agent-studio/store")>(), studioStore: () => state.store }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/asr-server", () => ({ transcribeSourceChunk: vi.fn() }));
vi.mock("@/lib/edge-tts", () => ({ generateSpeechFreeDetailed: vi.fn() }));
import { advanceGeneration, rememberKey } from "@/lib/agent-studio/engine";
let db: Database.Database;
const plan: AgentPlan = { summary: "New presenter", preserve: ["Product"], change: ["Voice"], notes: [], productCrop: null, segments: [{ duration: 9, script: "介绍产品。", prompt: "A fictional presenter demonstrates five bins." }] };
function generation() {
  const s = state.store, r = s.register("test", "codex");
  const w = s.create({ title: "Test", sourceAssetId: "x", sourceUrl: "/api/files/test.mp4", sourceName: "test", duration: 9, brief: "new presenter", runtimeId: r.runtime.id, resolution: "480p", voice: "female" });
  const analysis = s.enqueue(w.id, "plan"); s.claim(r.runtime.id); s.completePlan(analysis.id, plan);
  const version = s.approve(w.id, 5, JSON.stringify(plan)); rememberKey(version.id, "test-only-not-a-real-key");
  s.update(w.id, w => { w.versions[0].prepared = true; });
  const job = s.claim(r.runtime.id) as AgentJob; return { work: w, version, job };
}
beforeEach(() => { db = new Database(":memory:"); state.store = new AgentStudioStore(db); });
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("paid video submission boundary (fully mocked network)", () => {
  it("persists a task ID and only polls that ID on the next advance", async () => {
    const {work, job} = generation(); const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: "cgt-test-123456" })).mockResolvedValueOnce(Response.json({status:"running"})); vi.stubGlobal("fetch", fetcher);
    await advanceGeneration(job); expect(state.store.work(work.id).versions[0].receipts[0]).toEqual({ state: "submitted", taskId: "cgt-test-123456" });
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
    await expect(advanceGeneration(job)).rejects.toThrow("401"); expect(state.store.work(work.id).versions[0].receipts[0]).toEqual({ state: "pending" }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("checks remaining budget before any provider call", async () => {
    const {work, job} = generation(); state.store.update(work.id, w => { w.versions[0].budgetCny = 0; }); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await expect(advanceGeneration(job)).rejects.toThrow("预算不足"); expect(fetcher).not.toHaveBeenCalled();
  });
});

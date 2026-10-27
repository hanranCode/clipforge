// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { join } from "path";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown, active: new Set<string>(), start: vi.fn().mockResolvedValue("resumed"), createProvider: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/providers", () => ({ createProvider: state.createProvider }));
vi.mock("@/lib/pipeline-runner", () => ({ isPipelineRunActive: (id: string) => state.active.has(id), startPipelineRun: state.start }));
vi.mock("@/lib/transcript-render-runner", () => ({ reconcileTranscriptRenders: vi.fn() }));
import { GET } from "@/app/api/tasks/route";
import { POST as queryVideoTask } from "@/app/api/ai/video/task/route";
import { GET as getPipeline, POST as postPipeline } from "@/app/api/project/[id]/pipeline/route";
import { getLatestPipelineRun } from "@/lib/pipeline-history";
import { parseTaskFeed, taskHref } from "@/lib/task-feed";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
beforeAll(() => { state.db = db; migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") }); });
beforeEach(() => {
  db.delete(schema.projects).run();
  db.delete(schema.aiTasks).run();
  db.delete(schema.batchJobs).run();
  state.active.clear();
  state.start.mockClear();
  state.createProvider.mockReset();
  db.insert(schema.projects).values([{ id: "project-a", name: "项目 A" }, { id: "project-b", name: "项目 B" }]).run();
});
afterAll(() => sqlite.close());

const sameTime = new Date("2026-09-16T00:00:00Z");
function run(values: Partial<typeof schema.pipelineRuns.$inferInsert> & { id: string }) {
  db.insert(schema.pipelineRuns).values({ projectId: "project-a", createdAt: sameTime, ...values }).run();
}
async function feed() { return parseTaskFeed(await (await GET()).json()); }

describe("任务发现和恢复状态", () => {
  it("moves old unconfirmed Atlas tasks to attention without querying any provider", async () => {
    db.insert(schema.aiTasks).values({ id: "old-atlas", provider: "atlas-cloud", model: "bytedance/seedance-2.0/reference-to-video",
      taskId: "old-paid-task", status: "submitted", createdAt: sameTime, updatedAt: sameTime }).run();
    db.insert(schema.aiTasks).values({ id: "fresh-ark", provider: "volcengine", model: "doubao-seedance-2-0-mini-260615",
      taskId: "fresh-task", status: "submitted" }).run();
    const result = await feed();
    expect(result.active.map((task) => task.id)).toEqual(["fresh-ark"]);
    expect(result.attention).toMatchObject([{ id: "old-atlas", kind: "paid_unknown", provider: "atlas-cloud", status: "unknown" }]);
    expect(state.createProvider).not.toHaveBeenCalled();
  });

  it("rejects querying a persisted Ark task on Atlas before contacting the provider", async () => {
    db.insert(schema.aiTasks).values({ id: "ark-task", provider: "volcengine", model: "doubao-seedance-2-0-mini-260615",
      taskId: "ark-paid-task", status: "submitted" }).run();
    const result = await queryVideoTask(new NextRequest("http://localhost/api/ai/video/task", {
      method: "POST", body: JSON.stringify({ provider: "atlas-cloud", apiKey: "test-key", taskId: "ark-paid-task" }),
    }));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "TASK_PROVIDER_MISMATCH", provider: "volcengine", recoverable: false });
    expect(state.createProvider).not.toHaveBeenCalled();
    expect(db.select().from(schema.aiTasks).get()?.status).toBe("submitted");
  });

  it("resumes on the original platform and links a remake task to its draft", async () => {
    db.insert(schema.projects).values({ id: "remake", name: "复刻草稿", sourceType: "remake" }).run();
    db.insert(schema.aiTasks).values({ id: "ark-task", projectId: "remake", provider: "volcengine", model: "doubao-seedance-2-0-mini-260615",
      taskId: "ark-paid-task", status: "submitted" }).run();
    expect(taskHref((await feed()).active[0])).toBe("/project/remake?id=remake");
    const poll = vi.fn().mockResolvedValue({ status: "completed", result: { videoUrls: ["https://tos.example.com/result.mp4"] } });
    state.createProvider.mockReturnValue({ getTaskStatus: poll });
    const result = await queryVideoTask(new NextRequest("http://localhost/api/ai/video/task", {
      method: "POST", body: JSON.stringify({ provider: "volcengine", apiKey: "ark-key", taskId: "ark-paid-task" }),
    }));
    expect(result.status).toBe(200);
    expect(state.createProvider).toHaveBeenCalledWith(expect.objectContaining({ name: "volcengine" }));
    expect(db.select().from(schema.aiTasks).get()?.status).toBe("completed");
  });

  it("中断任务落库后多次刷新仍保留，接替任务成功后移除", async () => {
    run({ id: "orphan", status: "running", stage: "stock_fill" });
    for (let i = 0; i < 3; i++) {
      const result = await feed();
      expect(result.attention).toMatchObject([{ id: "orphan", kind: "pipeline_interrupted", stage: "stock_fill" }]);
      expect(result.active).toEqual([]);
    }
    expect(getLatestPipelineRun("project-a")).toMatchObject({ status: "failed", error: "interrupted" });
    run({ id: "replacement", status: "done" });
    expect((await feed()).attention).toEqual([]);
  });

  it("同秒重试以插入顺序识别最新任务，活动合成不重复展示", async () => {
    run({ id: "z-old", status: "failed" });
    db.insert(schema.compositions).values({ id: "composition", projectId: "project-a", status: "composing" }).run();
    run({ id: "a-new", status: "running", compositionId: "composition" });
    state.active.add("a-new");
    expect(getLatestPipelineRun("project-a")?.id).toBe("a-new");
    const result = await feed();
    expect(result.attention).toEqual([]);
    expect(result.active).toMatchObject([{ kind: "pipeline", id: "a-new" }]);
  });

  it("保留各项目最新失败并提供对应恢复入口，不向任务摘要暴露错误详情", async () => {
    run({ id: "a", status: "failed", error: "sensitive provider error" });
    run({ id: "b", projectId: "project-b", status: "failed", error: "interrupted" });
    const result = await feed();
    expect(result.attention).toHaveLength(2);
    const failed = result.attention.find((row) => row.id === "a")!;
    expect(failed.kind).toBe("pipeline_failed");
    expect(taskHref(failed)).toBe("/project/project-a/script");
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("全部运行批次都有各自进度，终止批次不再展示", async () => {
    db.insert(schema.batchJobs).values([{ id: "one", total: 3 }, { id: "two", total: 2 }, { id: "cancelled", status: "cancelled" }]).run();
    db.insert(schema.batchJobItems).values([
      { id: "1", jobId: "one", productId: "p", productName: "p", status: "done" },
      { id: "2", jobId: "one", productId: "p", productName: "p", status: "failed" },
      { id: "3", jobId: "two", productId: "p", productName: "p", status: "done" },
    ]).run();
    expect((await feed()).active).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "one", done: 1, failed: 1, total: 3 }),
      expect.objectContaining({ id: "two", done: 1, failed: 0, total: 2 }),
    ]));
    expect((await feed()).active).toHaveLength(2);
    expect((await GET()).headers.get("Cache-Control")).toBe("no-store");
  });

  it("项目查询及续跑也使用同秒内最新断点", async () => {
    run({ id: "z-earlier", status: "failed", stage: "judge", scriptId: "old-script" });
    run({ id: "a-later", status: "failed", stage: "compose", scriptId: "new-script" });
    const context = { params: Promise.resolve({ id: "project-a" }) };
    const url = "http://localhost/api/project/project-a/pipeline";
    expect(await (await getPipeline(new NextRequest(url), context)).json()).toMatchObject({ run: { id: "a-later" } });
    expect((await postPipeline(new NextRequest(url, { method: "POST", body: JSON.stringify({ resume: true }) }), context)).status).toBe(202);
    expect(state.start).toHaveBeenCalledWith(expect.objectContaining({ fromStage: "compose", scriptId: "new-script" }));
  });
});

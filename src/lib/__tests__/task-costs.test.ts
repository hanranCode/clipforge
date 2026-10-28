// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
import { backfillWanCallCosts, projectCosts } from "@/lib/project-costs";
import { reconcileVideoCall } from "@/lib/video-call-cost";
import { bailianVideoRate, bailianVideoUsage } from "@/lib/remake/pricing";
import { estimateMediaCost, listPriceFor } from "@/lib/model-pricing";
const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
beforeAll(() => { state.db = db; migrate(db, { migrationsFolder: "drizzle" }); });
beforeEach(() => { db.delete(schema.apiCalls).run(); db.delete(schema.settings).run(); });
afterAll(() => sqlite.close());
const insert = (id: string, values: Partial<typeof schema.apiCalls.$inferInsert> = {}) => db.insert(schema.apiCalls).values({ id, projectId: "project", modelType: "video", provider: "alibaba", model: "wan3.0-video", taskId: id, usage: { videoSeconds: 9 }, request: { detail: { duration: 9, inputVideoSeconds: 9, extra: { resolution: "480P" } } }, ...values }).run();

describe("Wan pricing and persistent task cost", () => {
  it("uses official tiers, regional rates and CNY picker labels without an exchange-rate guess", () => {
    expect(["480p", "720p", "1080p"].map(r => bailianVideoRate("wan3.0-video", r))).toEqual([0.3, 0.6, 1.2]);
    expect(bailianVideoRate("wan3.0-video-prime", "1080p")).toBe(1.8);
    expect(bailianVideoRate("wan3.0-video", "480p", "https://dashscope-intl.aliyuncs.com")).toBe(0.37471);
    expect(listPriceFor({ provider: "alibaba", id: "wan3.0-video", mediaType: "video" })).toMatchObject({ currency: "CNY", amount: 0.3, unit: "second" });
    expect(estimateMediaCost({ provider: "alibaba", model: "wan3.0-video", mediaType: "video", resolution: "720p", videoSeconds: 9, inputVideoSeconds: 9 })).toMatchObject({ totalCny: 10.8 });
    expect(estimateMediaCost({ provider: "alibaba", model: "wan3.0-video", mediaType: "video" }).totalCny).toBeUndefined();
  });
  it("backfills old calls, separates currencies, retains retries and excludes definitive failures", () => {
    insert("old"); insert("retry"); insert("failed", { status: "failed" });
    insert("tts", { provider: "tts", modelType: "tts", cost: { currency: "USD", totalUsd: 0.02, source: "pricebook" } });
    insert("unknown", { provider: "ai-nodes", usage: null });
    backfillWanCallCosts();
    expect(db.select().from(schema.apiCalls).where(eq(schema.apiCalls.id, "old")).get()?.cost).toMatchObject({ currency: "CNY", totalCny: 5.4 });
    expect(projectCosts().get("project")).toEqual({ calls: 5, totalCny: 10.8, totalUsd: 0.02, unpricedCalls: 1 });
    expect(projectCosts().get("project")).toEqual(projectCosts().get("project"));
    db.delete(schema.apiCalls).run();
    expect(projectCosts().get("project")).toEqual({ calls: 5, totalCny: 10.8, totalUsd: 0.02, unpricedCalls: 1 });
  });
  it("patches the original task after resume using billed input + output once, then refunds a definitive failure", async () => {
    insert("paid");
    projectCosts();
    db.delete(schema.apiCalls).run();
    const usage = { duration: 18.5, input_video_duration: 9, output_video_duration: 9.5, SR: 720 };
    expect(bailianVideoUsage(usage)).toMatchObject({ billedVideoSeconds: 18.5, videoSeconds: 9.5 });
    for (let i = 0; i < 2; i++) await reconcileVideoCall("alibaba", "paid", { taskId: "paid", status: "completed", result: { taskId: "paid", modelId: "wan3.0-video", videoUrls: ["https://cdn.example.com/result.mp4"], duration: 9.5, extra: { usage } } });
    expect(db.select().from(schema.apiCalls).all()).toHaveLength(0);
    expect(projectCosts().get("project")).toMatchObject({ calls: 1, totalCny: 11.1 });
    await reconcileVideoCall("another-provider", "paid", { taskId: "paid", status: "failed" });
    expect(projectCosts().get("project")?.totalCny).toBe(11.1);
    await reconcileVideoCall("alibaba", "paid", { taskId: "paid", status: "failed" });
    expect(projectCosts().get("project")?.totalCny).toBe(0);
  });
});

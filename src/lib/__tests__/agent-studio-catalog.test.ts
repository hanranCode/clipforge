// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import { AgentStudioStore } from "@/lib/agent-studio/store";
import type { AgentPlan, WorkVersion } from "@/lib/agent-studio/types";
const state = vi.hoisted(() => ({ db: null as unknown, store: null as unknown as AgentStudioStore, root: "" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paths", () => ({ getUploadsDir: () => join(state.root, "uploads"), getOutputDir: () => join(state.root, "output"), getDataDir: () => state.root, fileNameOf: (s: string) => s?.split("/").at(-1) }));
vi.mock("@/lib/agent-studio/store", async original => ({ ...await original<typeof import("@/lib/agent-studio/store")>(), studioStore: () => state.store }));
vi.mock("@/lib/media-probe", () => ({ probeMedia: vi.fn(async () => ({width:1080,height:1920,duration:9,hasAudio:true,frameRate:24})) }));
import { syncAgentCatalog, recordAgentProgress, agentResultAssetId } from "@/lib/agent-studio/catalog";
import { GET as materials } from "@/app/api/materials/route";
import { GET as calls } from "@/app/api/api-calls/route";
import { GET as projects } from "@/app/api/project/route";
import { GET as works } from "@/app/api/works/route";
let sql: Database.Database, studioSql: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>, workId: string, dir: string;
const plan: AgentPlan = { summary: "An Agent video", preserve: [], change: [], notes: [], productCrop: { frame: 0, x: 0, y: 0, width: 1, height: 1 }, segments: [{ duration: 9, script: "test", prompt: "product video" }] };
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), "agent-catalog-")); sql = new Database(":memory:"); studioSql = new Database(":memory:");
  db = drizzle(sql, { schema }); state.db = db; migrate(db, { migrationsFolder: "drizzle" }); state.store = new AgentStudioStore(studioSql);
  workId = state.store.create({ title: "Agent work", sourceAssetId: "a", sourceUrl: "/api/files/source.mp4", sourceName: "source", duration: 9, brief: "remake", runtimeId: null, resolution: "480p", voice: "female" }).id;
  dir = join(state.root, "output", "agent-studio", workId, "versions", "version"); await mkdir(dir, { recursive: true });
  for (const file of ["final.mp4", "poster.jpg", "product.jpg", "segment-0.mp4", "upscaled-first.mp4"]) await writeFile(join(dir, file), file);
  const v: WorkVersion = { id: "version", number: 1, status: "completed", prepared: true, plan, budgetCny: 5, estimatedCny: 2, costCny: 2.088722, receipts: [{ state: "completed", taskId: "cgt-original", file: join(dir, "segment-0.mp4"), tokens: 90814, costCny: 2.088722 }], outputUrl: `/api/output/agent-studio/${workId}/versions/version/final.mp4`, posterUrl: `/api/output/agent-studio/${workId}/versions/version/poster.jpg`, sourceId: null, editorUrl: null, error: null, createdAt: Date.now() - 10000, completedAt: Date.now() - 5000, superResolution: { requestId: "first", workflowId: "media-sr-first", runId: "run-1", status: "completed", objectKey: "result.mp4", storage: { endpoint: "https://tos-s3-cn-shanghai.volces.com", region: "cn-shanghai", bucket: "test" }, outputUrl: "/api/output/upscaled-first.mp4", createdAt: Date.now() - 4000 } };
  state.store.update(workId, w => { w.status = "completed"; w.importKey = "old-production"; w.versions = [v]; });
});
afterEach(async () => { sql.close(); studioSql.close(); await rm(state.root, { recursive: true, force: true }); });
describe("Agent cross-surface catalog", () => {
  it("uses each version's actual video provider/model in assets and call logs", async () => {
    state.store.update(workId, w => { w.versions[0].video = { provider: "alibaba", model: "wan3.0-video", resolution: "720p", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1" }; w.versions[0].receipts[0].costEstimated = true; });
    await syncAgentCatalog();
    const calls = db.select().from(schema.apiCalls).all();
    expect(calls.find(call => call.scene === "agent_video")).toMatchObject({ provider: "alibaba", model: "wan3.0-video", endpoint: "services/aigc/video-generation/video-synthesis" });
    const assets = db.select().from(schema.assets).all();
    expect(assets.find(asset => asset.id === agentResultAssetId("version"))).toMatchObject({ provider: "alibaba", model: "wan3.0-video" });
  });
  it("backfills final videos, segments, derived images and legacy upscales with stable project/parent links", async () => {
    await syncAgentCatalog(); await syncAgentCatalog();
    const a = db.select().from(schema.assets).all(); expect(a).toHaveLength(5);
    expect(a.find(x => x.id === "agent-upscale-first")!.createdAt!.getTime()).toBeGreaterThan(a.find(x => x.id === agentResultAssetId("version"))!.createdAt!.getTime());
    expect(a.every(a => a.projectId === workId && (a.filePath?.startsWith(`/api/files/${workId}/agent-library/`) || a.filePath === "/api/agent-studio/resources/first"))).toBe(true);
    const version = state.store.work(workId).versions[0]; expect(version.artifacts?.find(a => a.role === "upscale")?.parentAssetId).toBe(agentResultAssetId("version"));
    expect(a.find(a => a.id === "agent-upscale-first")?.filePath).toBe("/api/agent-studio/resources/first");
    expect(a.find(a => a.id === "agent-version-poster")?.provider).toBe("local");
  });
  it("creates one historical receipt log and one workflow log, preserving measured CNY without inventing USD", async () => {
    await syncAgentCatalog(); await syncAgentCatalog();
    const rows = db.select().from(schema.apiCalls).all(); expect(rows).toHaveLength(2); expect(rows.every(r => r.projectId === workId)).toBe(true);
    const video = rows.find(r => r.scene === "agent_video")!; expect(video.usage?.completionTokens).toBe(90814); expect(video.cost).toBeNull(); expect(video.response?.detail).toMatchObject({ costCny: 2.088722, origin: "imported_receipt" });
    expect(JSON.stringify(rows)).not.toMatch(/X-Amz|put_url|read_url|secretAccessKey/);
  });
  it("registers completed cloud resource metadata even when local render files are gone", async () => {
    await rm(dir,{recursive:true});
    state.store.update(workId,w=>{w.versions[0].superResolution!.result={sha256:"a".repeat(64),bytes:100,width:1080,height:1920};});
    await syncAgentCatalog();
    expect(db.select().from(schema.assets).all()).toMatchObject([{id:"agent-upscale-first",filePath:"/api/agent-studio/resources/first"}]);
    const rows=await (await materials(new NextRequest("http://localhost/api/materials"))).json();
    expect(rows.items[0]).toMatchObject({mediaType:"video",width:1080,height:1920,sizeBytes:100});
  });
  it("keeps removed library entries removed on a later work update", async () => {
    await syncAgentCatalog(); db.delete(schema.assets).where(eq(schema.assets.id, "agent-version-poster")).run();
    state.store.update(workId, w => { w.title = "Renamed"; }); await syncAgentCatalog(); expect(db.select().from(schema.assets).all()).toHaveLength(4);
  });
  it("adds subsequent upscales without replacing earlier results or API records", async () => {
    await syncAgentCatalog(); await writeFile(join(dir, "upscaled-second.mp4"), "second");
    state.store.update(workId, w => { const v = w.versions[0], first = v.superResolution!; const second = { ...first, requestId: "second", workflowId: "media-sr-second", outputUrl: "/api/output/upscaled-second.mp4", parameters: { capabilityId: "media.super_resolution.v1" as const, target: "1080p" as const, videoPreset: "base" as const, seed: 9 } }; v.superResolutions = [first, second]; v.superResolution = second; });
    await syncAgentCatalog(); expect(db.select().from(schema.assets).all()).toHaveLength(6); expect(db.select().from(schema.apiCalls).all()).toHaveLength(3);
  });
  it("provides Agent detail links in projects, finished works, material details and API call rows", async () => {
    const projectRows = await (await projects()).json(); expect(projectRows.find((p: { id: string }) => p.id === workId)).toMatchObject({ sourceType: "agent", agentWorkId: workId });
    const materialRows = await (await materials(new NextRequest("http://localhost/api/materials"))).json();
    expect(materialRows.items.find((a: { id: string }) => a.id === "agent-upscale-first")).toMatchObject({ detailHref: `/agent-studio/${workId}?version=version`, parentAssetId: "agent-version-result", projectId: workId });
    const apiRows = await (await calls(new NextRequest("http://localhost/api/api-calls"))).json(); expect(apiRows.items[0].projectHref).toBe(`/agent-studio/${workId}`);
    const feed = await (await works()).json(); expect(feed.works).toHaveLength(2); expect(feed.works[0].detailHref).toBe(`/agent-studio/${workId}?version=version`);
  });
  it("logs unconfirmed submissions before there is a provider task ID, without archiving nonexistent media", () => {
    state.store.update(workId, w => { w.versions[0].receipts = [{ state: "unknown", apiCallId: "attempt-1", submittedAt: Date.now(), error: "Submission unconfirmed" }]; w.versions[0].superResolution = undefined; });
    recordAgentProgress(state.store.work(workId)); expect(db.select().from(schema.apiCalls).all()).toMatchObject([{ id: "attempt-1", status: "failed", taskId: null }]);
  });
});

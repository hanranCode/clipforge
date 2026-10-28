// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import type { AgentWork, SuperResolutionTask } from "@/lib/agent-studio/types";
const state = vi.hoisted(() => ({ db: null as unknown, works: [] as AgentWork[], tasks: {} as Record<string, SuperResolutionTask[]>, cachedFile: "", render: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/agent-studio/store", () => ({ studioStore: () => ({ works: () => state.works }) }));
vi.mock("@/lib/remake/super-resolution", () => ({ remakeUpscaleTasks: (id: string) => state.tasks[id] || [] }));
vi.mock("@/lib/agent-studio/resources", () => ({ agentResourceFile: async () => ({ file: state.cachedFile }) }));
vi.mock("@/lib/media-probe", () => ({ probeMedia: async () => ({ width: 480, height: 854 }) }));
vi.mock("@/lib/platform-export", () => ({ renderPlatformExport: state.render, previewPlatformExport: vi.fn() }));
import { GET } from "@/app/api/project/[id]/publish-videos/route";
import { POST } from "@/app/api/project/[id]/export-platform/route";
const root = realpathSync(mkdtempSync(join(tmpdir(), "clipforge-publish-variants-")));
const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
function file(path: string) { const full = join(root, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, "video"); return full; }
function sr(id: string, date: number, status: SuperResolutionTask["status"] = "completed"): SuperResolutionTask {
  return { requestId: id, workflowId: id, status, objectKey: id, storage: { endpoint: "https://storage.example.com", region: "test", bucket: "test" }, outputUrl: `/api/agent-studio/resources/${id}`, createdAt: date, completedAt: date, result: { sha256: "a".repeat(64), bytes: 5, width: 1080, height: 1920 } };
}
beforeAll(() => { state.db = db; vi.stubEnv("APP_DATA_DIR", root); migrate(db, { migrationsFolder: "drizzle" }); state.cachedFile = file("cache/agent-media/upscale.mp4"); });
beforeEach(() => { state.works = []; state.tasks = {}; state.render.mockClear(); db.delete(schema.compositions).run(); db.delete(schema.projects).run(); db.delete(schema.libraryAssets).run(); });
afterAll(() => { sqlite.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function read(sourceId: string, projectId = "project") { return GET(new NextRequest(`http://localhost/api/project/${projectId}/publish-videos?sourceId=${sourceId}`), { params: Promise.resolve({ id: projectId }) }); }
async function render(compositionId: string, projectId = "project") { return POST(new NextRequest(`http://localhost/api/project/${projectId}/export-platform`, { method: "POST", body: JSON.stringify({ compositionId, platform: "douyin" }) }), { params: Promise.resolve({ id: projectId }) }); }
function agent() {
  file("output/agent-studio/work/versions/v1/final.mp4");
  state.works = [{ id: "work", projectId: "project", title: "Agent", sourceAssetId: "source", sourceUrl: "/source", sourceName: "source", duration: 9, brief: "test", runtimeId: null, status: "completed", resolution: "480p", voice: "original", plan: null, posterUrl: null, error: null, createdAt: 1, updatedAt: 1, versions: [{ id: "v1", number: 1, status: "completed", plan: { summary: "", preserve: [], change: [], notes: [], segments: [], productCrop: null }, budgetCny: 5, estimatedCny: 1, costCny: 1, receipts: [], outputUrl: "/final", posterUrl: null, sourceId: null, editorUrl: null, error: null, createdAt: 1, completedAt: 1, superResolutions: [sr("older", 2), sr("latest", 3), sr("pending", 4, "processing")] }] }];
}
it("defaults to the latest completed upscale of the same Agent take, exposes actual resolution, and exports verified cache bytes", async () => {
  agent();
  const response = await read("agent-v1"); expect(response.status).toBe(200);
  const group = await response.json();
  expect(group.preferredId).toBe("agent-upscale-latest");
  expect(group.videos.map((v: { id: string }) => v.id)).toEqual(["agent-upscale-latest", "agent-upscale-older", "agent-v1"]);
  expect(group.videos[0]).toMatchObject({ width: 1080, height: 1920, originalId: "agent-v1", kind: "upscale" });
  expect(group.videos[2]).toMatchObject({ width: 480, height: 854 });
  expect((await (await read("agent-upscale-older")).json()).preferredId).toBe("agent-upscale-latest");
  expect((await render(group.preferredId)).status).toBe(200);
  expect(state.render.mock.lastCall?.[0].sourcePath).toBe(state.cachedFile);
  expect((await read("agent-v1", "other-project")).status).toBe(404);
  state.render.mockClear(); expect((await render(group.preferredId, "other-project")).status).toBe(400); expect(state.render).not.toHaveBeenCalled();
  state.works[0].versions[0].superResolutions = [];
  expect((await (await read("agent-v1")).json()).preferredId).toBe("agent-v1");
});
it("links a remake's verified upscale to its original and never selects an incomplete or another take", async () => {
  const original = file("uploads/_library/original.mp4"); const upscale = file("uploads/_library/upscaled.mp4");
  db.insert(schema.projects).values({ id: "project", name: "Remake", sourceType: "remake" }).run();
  db.insert(schema.libraryAssets).values([{ id: "asset", title: "Original", mediaType: "video", filePath: "/api/files/_library/original.mp4", tags: ["视频复刻"] }, { id: "remake-upscale-sr", title: "Upscale", mediaType: "video", filePath: "/api/files/_library/upscaled.mp4", width: 1080, height: 1920 }]).run();
  db.insert(schema.compositions).values({ id: "remake-asset", projectId: "project", status: "done", outputPath: original }).run();
  state.tasks.asset = [{ ...sr("sr", 2), outputUrl: "/api/files/_library/upscaled.mp4" }, sr("pending", 3, "failed")];
  const group = await (await read("remake-asset")).json();
  expect(group.preferredId).toBe("remake-upscale-sr");
  expect(group.videos).toHaveLength(2);
  expect((await render(group.preferredId)).status).toBe(200); expect(state.render.mock.lastCall?.[0].sourcePath).toBe(upscale);
  expect((await read("remake-upscale-sr", "other-project")).status).toBe(404);
  expect((await read("remake-missing")).status).toBe(404);
});

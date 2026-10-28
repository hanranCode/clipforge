// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import * as schema from "@/lib/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, root: "", source: "" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paths", () => ({ getOutputDir: () => state.root, getDataDir: () => state.root }));
vi.mock("@/lib/agent-studio/ai-nodes-client", () => ({ aiNodesConfigured: () => true, callAiNodes: vi.fn() }));
vi.mock("@/lib/server-object-storage", () => ({ requireServerObjectStorage: () => ({ endpoint: "https://tos.example.com", region: "test", bucket: "test" }), sameStorage: () => true }));
vi.mock("@/lib/object-storage-server", () => ({ objectKeyFor: () => "result.mp4", presignUrl: () => "https://tos.example.com/result.mp4?signature=private", uploadToObjectStorage: vi.fn() }));
vi.mock("@/lib/media-resource-cache", async original => ({ ...await original<object>(), cachedVideo: vi.fn(async () => state.source) }));
import { LitForgeProvider } from "@/lib/providers/litforge";
import { LITFORGE_MODELS, litforgeCapability } from "@/lib/litforge/catalog";
import { litforgeRequest, litforgeOutputFile, controlLitforgeTask } from "@/lib/litforge/server";
import { callAiNodes } from "@/lib/agent-studio/ai-nodes-client";
import { cachedVideo } from "@/lib/media-resource-cache";
import { prepareStudioVideo } from "@/lib/agent-studio/video-provider";
import { uploadToObjectStorage } from "@/lib/object-storage-server";
import type { VideoOptions } from "@/lib/providers/types";
let sql: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const provider = () => new LitForgeProvider({ name: "litforge", apiKey: "", baseUrl: "" });
const options = (modelId: string): VideoOptions => ({ modelId, mode: "video-to-video", prompt: "Person walks.", width: 832, height: 480, duration: modelId === LITFORGE_MODELS.reference ? 5 : 4, referenceImageUrls: ["https://input.example.com/person.jpg"], referenceVideoUrls: ["https://input.example.com/source.mp4"] });
beforeEach(async () => {
  vi.clearAllMocks();
  state.root = await mkdtemp(join(tmpdir(), "litforge-test-")); state.source = join(state.root, "cache.mp4"); await writeFile(state.source, "verified-video");
  sql = new Database(":memory:"); db = drizzle(sql, { schema }); migrate(db, { migrationsFolder: "drizzle" }); state.db = db;
  vi.mocked(callAiNodes).mockImplementation(async (command, id) => command === "submit" ? { workflow_id: id, run_id: "run-test" } : command === "status" ? { status: "RUNNING" } : { request_id: id.replace(/^(?:media-sr|wan-animate|wan-vace)-/, ""), media_type: "video", upload_mode: "presigned_put", sha256: "a".repeat(64), bytes: 14, width: 832, height: 480, fps: 16, frames: 81 });
});
afterEach(async () => { sql.close(); await rm(state.root, { recursive: true, force: true }); });

it("publishes three versioned capabilities and routes each model to its own encrypted Workflow contract", async () => {
  const models = await provider().listModels("video"); expect(models).toHaveLength(3); expect(await provider().listModels("image")).toEqual([]);
  for (const model of models) {
    const p = provider(), request = options(model.id); if (model.id === LITFORGE_MODELS.upscale) request.referenceImageUrls = [];
    const receipt = await p.submitVideoTask(request), capability = litforgeCapability(model.id);
    expect(receipt.taskId.startsWith(capability.prefix + "-")).toBe(true);
    const call = vi.mocked(callAiNodes).mock.calls.at(-1)!;
    expect(call).toEqual(["submit", receipt.taskId, expect.objectContaining({ schema_version: "1", request_id: expect.any(String), output: expect.any(Object) }), capability]);
    expect(call[2]).toMatchObject(model.id === LITFORGE_MODELS.reference ? { mode: "control_reference", control_type: "canny", fps: 16, num_frames: 81, reference_image_urls: request.referenceImageUrls } : model.id === LITFORGE_MODELS.replace ? { mode: "replace", fps: 30, num_frames: 117, reference_image_url: request.referenceImageUrls![0] } : { input_url: request.referenceVideoUrls![0], target: "1080p" });
  }
  expect(JSON.stringify(db.select().from(schema.settings).all())).not.toMatch(/signature=|person\.jpg|source\.mp4|Person walks/);
});
it("persists the attempt before submission and never submits again after an uncertain acknowledgment or restart", async () => {
  vi.mocked(callAiNodes).mockImplementation(async command => { if (command === "submit") { expect(db.select().from(schema.settings).all()).toHaveLength(1); throw new Error("secret signature network timeout"); } return { status: "RUNNING" }; });
  const { taskId } = await provider().submitVideoTask(options(LITFORGE_MODELS.reference));
  expect(JSON.stringify(db.select().from(schema.settings).all())).toContain('"status":"unknown"');
  expect(await provider().getTaskStatus(taskId)).toMatchObject({ status: "processing", taskId });
  expect(vi.mocked(callAiNodes).mock.calls.filter(c => c[0] === "submit")).toHaveLength(1);
});
it("validates output identity and metadata then materializes verified bytes at a stable local URL", async () => {
  const { taskId } = await provider().submitVideoTask(options(LITFORGE_MODELS.reference));
  vi.mocked(callAiNodes).mockImplementation(async (command, id) => command === "status" ? { status: "COMPLETED" } : { request_id: id.slice("wan-vace-".length), media_type: "video", upload_mode: "presigned_put", sha256: "a".repeat(64), bytes: 14, width: 832, height: 480, frames: 81, fps: 16 });
  const status = await provider().getTaskStatus(taskId);
  expect(status.status).toBe("completed"); expect(cachedVideo).toHaveBeenCalledWith(expect.objectContaining({ sha256: "a".repeat(64), objectKey: "result.mp4" }));
  const result = status.result!; if (!("videoUrls" in result)) throw new Error("Expected video");
  expect(await readFile(litforgeOutputFile(result.videoUrls[0])!, "utf8")).toBe("verified-video");
  vi.mocked(callAiNodes).mockClear(); await provider().getTaskStatus(taskId); expect(callAiNodes).not.toHaveBeenCalled();
  expect(litforgeOutputFile("/api/output/litforge/../../secret")).toBeNull();
});
it("rejects a mismatched output and only refreshes output URLs during the upstream waiting stage", async () => {
  const { taskId } = await provider().submitVideoTask(options(LITFORGE_MODELS.reference));
  vi.mocked(callAiNodes).mockResolvedValue({ status: "COMPLETED", request_id: "other" });
  await expect(provider().getTaskStatus(taskId)).rejects.toThrow("identity"); expect(cachedVideo).not.toHaveBeenCalled();
  await expect(controlLitforgeTask(taskId, "refresh")).rejects.toThrow("waiting");
  vi.mocked(callAiNodes).mockResolvedValue({ status: "RUNNING", stage: "waiting_for_output_url" });
  await controlLitforgeTask(taskId, "refresh"); expect(vi.mocked(callAiNodes).mock.calls.at(-1)?.[0]).toBe("set-output");
});
it.each([0, 3])("rejects %i Studio references during preparation before an in-flight submission can be marked", async count => {
  vi.mocked(uploadToObjectStorage).mockResolvedValue("https://input.example.com/control.mp4");
  const content = [{ type: "text", text: "Person walks." }, ...Array.from({ length: count }, () => ({ type: "image_url", image_url: { url: "https://input.example.com/person.jpg" } }))];
  await expect(prepareStudioVideo({ provider: "litforge", model: LITFORGE_MODELS.reference, resolution: "480p" }, "", content, state.root, 0, 5)).rejects.toThrow("reference");
  expect(callAiNodes).not.toHaveBeenCalled(); expect(db.select().from(schema.settings).all()).toHaveLength(0);
});
it("rejects an oversized composed Studio prompt during preflight, and exposes definitive input rejection to API callers", async () => {
  vi.mocked(uploadToObjectStorage).mockResolvedValue("https://input.example.com/control.mp4");
  await expect(prepareStudioVideo({ provider: "litforge", model: LITFORGE_MODELS.reference, resolution: "480p" }, "", [{ type: "text", text: "x".repeat(4001) }, { type: "image_url", image_url: { url: "https://input.example.com/person.jpg" } }], state.root, 0, 5)).rejects.toThrow("Prompt too long");
  await expect(provider().submitVideoTask({ ...options(LITFORGE_MODELS.reference), duration: 6 })).rejects.toMatchObject({ code: "INVALID_REQUEST", statusCode: 400 });
  expect(callAiNodes).not.toHaveBeenCalled();
});
it.each([
  { modelId: LITFORGE_MODELS.reference, duration: 6 },
  { modelId: LITFORGE_MODELS.replace, referenceImageUrls: ["https://a.example/1", "https://a.example/2"] },
  { modelId: LITFORGE_MODELS.replace, duration: 11 },
  { modelId: LITFORGE_MODELS.reference, width: 1080, height: 1920 },
  { modelId: LITFORGE_MODELS.reference, referenceAudioUrls: ["https://audio.example/test.wav"] },
  { modelId: LITFORGE_MODELS.reference, referenceVideoUrls: [] },
  { modelId: LITFORGE_MODELS.replace, referenceVideoUrls: ["http://local/input.mp4"] },
  { modelId: LITFORGE_MODELS.upscale, seed: -1 },
])("rejects unsupported capability inputs before creating a Workflow: %j", patch => {
  expect(() => litforgeRequest({ ...options(patch.modelId), ...patch }, "request-1")).toThrow();
  expect(callAiNodes).not.toHaveBeenCalled(); expect(db.select().from(schema.settings).all()).toHaveLength(0);
});

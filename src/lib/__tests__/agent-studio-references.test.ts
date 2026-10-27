// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import { AgentStudioStore } from "@/lib/agent-studio/store";
import { parseAgentPlan, type AgentJob, type AgentPlan } from "@/lib/agent-studio/types";
import { resolveSegmentReferences, usesProductCrop, validatePlanReferences, type ReferenceInput } from "@/lib/agent-studio/reference-types";

const state = vi.hoisted(() => ({ directory: "", db: null as unknown, store: null as unknown as AgentStudioStore }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory, getUploadsDir: () => join(state.directory, "uploads"), getOutputDir: () => join(state.directory, "output") }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/agent-studio/store", async original => ({ ...await original<typeof import("@/lib/agent-studio/store")>(), studioStore: () => state.store }));
vi.mock("@/lib/agent-studio/catalog", () => ({ syncAgentWork: vi.fn(), recordAgentProgress: vi.fn() }));
vi.mock("@/lib/media-probe", () => ({ probeMedia: vi.fn(async (file: string) => ({ duration: file.endsWith(".mp3") ? 1 : 9, width: 64, height: 64, hasAudio: false, frameRate: 24 })) }));
vi.mock("@/lib/asr-server", () => ({ transcribeSourceChunk: vi.fn() }));
vi.mock("@/lib/edge-tts", () => ({ generateSpeechFreeDetailed: vi.fn(async () => ({ audio: Buffer.from("audio fixture") })) }));
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFrameAtTime: vi.fn(async (_input: string, _time: number, output: string) => output) }));
vi.mock("node:child_process", async original => ({ ...await original<object>(), execFile: vi.fn((_bin: string, args: string[], _options: unknown, callback: (error: Error | null, stdout?: string) => void) => {
  writeFile(args.at(-1)!, "audio fixture").then(() => callback(null, ""), callback);
}) }));

import { captureReferences, freezeReferenceSnapshot, parseReferenceInputs, readReferenceImage, referenceFile } from "@/lib/agent-studio/reference-assets";
import { advanceGeneration, initializeVersion, planningContext, referenceContent, rememberKey } from "@/lib/agent-studio/engine";
import { POST } from "@/app/api/agent-studio/works/[id]/route";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
let mainDb: Database.Database, studioDb: Database.Database;
const inputs: ReferenceInput[] = [
  { id: "product-one", role: "product", sourceId: "browser-product-1", name: "收纳盒", description: "白色收纳盒", imageUrl: "/api/files/product.png", facts: { price: "¥29", category: "home" } },
  { id: "product-two", role: "product", sourceId: "browser-product-2", name: "抽纸", description: "三层抽纸", imageUrl: "/api/files/product.png" },
  { id: "presenter", role: "presenter", sourceId: "browser-presenter", name: "虚拟小林", description: "蓝色衣服", imageUrl: "/api/files/presenter.png" },
  { id: "scene", role: "scene", sourceId: "room", name: "client title", description: "client description", imageUrl: "/api/files/untrusted.png" },
];
const plan: AgentPlan = { summary: "在目标场地演示商品", preserve: ["节奏"], change: ["商品、人像、场景"], notes: [], productCrop: null, segments: [
  { duration: 5, script: "展示收纳盒。", prompt: "Presenter in scene demonstrates organizer", references: { product: "product-one", presenter: "presenter", scene: "scene" } },
  { duration: 4, script: "展示抽纸。", prompt: "Tissue closeup in scene", references: { product: "product-two", presenter: null, scene: "scene" } },
] };
beforeEach(async () => {
  vi.clearAllMocks(); state.directory = await mkdtemp(join(tmpdir(), "clipforge-refs-")); await mkdir(join(state.directory, "uploads"));
  for (const file of ["product.png", "presenter.png", "room.png"]) await writeFile(join(state.directory, "uploads", file), png);
  await writeFile(join(state.directory, "uploads", "source.mp4"), "source fixture");
  mainDb = new Database(":memory:"); const db = drizzle(mainDb, { schema }); migrate(db, { migrationsFolder: "drizzle" }); state.db = db;
  db.insert(schema.libraryAssets).values({ id: "room", mediaType: "image", title: "真实场地标题", description: "明亮的浴室", filePath: "/api/files/room.png" }).run();
  studioDb = new Database(":memory:"); state.store = new AgentStudioStore(studioDb);
});
afterEach(async () => { mainDb.close(); studioDb.close(); vi.unstubAllGlobals(); await rm(state.directory, { recursive: true, force: true }); });
async function reviewed() {
  const s = state.store, runtime = s.register("Test", "codex").runtime;
  s.heartbeat(runtime.id, { version: "clipforge-agent/2" });
  const references = await captureReferences("work", inputs);
  const work = s.create({ title: "Remake", sourceAssetId: "source", sourceName: "source", sourceUrl: "/api/files/source.mp4", duration: 9, brief: "use selected materials", runtimeId: runtime.id, resolution: "480p", voice: "female", references }, "work");
  const job = s.enqueue(work.id, "plan"); s.claim(runtime.id); s.completePlan(job.id, structuredClone(plan));
  return { work, runtime };
}
const request = (data: object) => POST(new NextRequest("http://localhost/api/agent-studio/works/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), { params: Promise.resolve({ id: "work" }) });

describe("reference capture, planning and immutable versions", () => {
  it("preserves source labels in immutable snapshots and resolves a scene's actual library source", async () => {
    const references = await captureReferences("work", [{ ...inputs[0], source: "ai_generated" }, { ...inputs[3], source: "ai_generated" }]);
    expect(references[0].source).toBe("ai_generated"); expect(references[1].source).toBe("user_upload");
    const frozen = await freezeReferenceSnapshot("work", "source-version", { capturedAt: 1, items: references });
    expect(frozen.items.map(item => item.source)).toEqual(["ai_generated", "user_upload"]);
    expect(frozen.items[0].imageUrl).toContain("/versions/source-version/");
  });
  it("captures browser metadata, resolves scene records on the server and gives the CLI local image paths", async () => {
    const { work, runtime } = await reviewed(), saved = state.store.work(work.id);
    expect(saved.references?.[0]).toMatchObject({ name: "收纳盒", facts: { price: "¥29" }, bytes: png.length });
    expect(saved.references?.[3]).toMatchObject({ name: "真实场地标题", description: "明亮的浴室" });
    const context = await planningContext({ workId: work.id, runtimeId: runtime.id } as AgentJob);
    expect(context.references).toHaveLength(4);
    expect(context.references[0].path).toContain("/uploads/agent-references/work/selected/");
    expect(await readFile(context.references[0].path)).toEqual(png);
  });
  it("rejects a stale daemon that would ignore target images until it is restarted", async () => {
    const { work, runtime } = await reviewed(); state.store.heartbeat(runtime.id, { version: "clipforge-agent/1" });
    await expect(planningContext({ workId: work.id, runtimeId: runtime.id } as AgentJob)).rejects.toThrow("重启");
  });
  it("requires explicit reference confirmation, then persists files, metadata and assignments independently of the libraries", async () => {
    await reviewed();
    const approve = { action: "approve", budget: 10, plan: JSON.stringify(plan), apiKey: "test-key", productConfirmed: true };
    expect((await request(approve)).status).toBe(400);
    expect(state.store.work("work").versions).toHaveLength(0);
    // Library files can be deleted after capture; approval still has its own images.
    await rm(join(state.directory, "uploads", "product.png"));
    expect((await request({ ...approve, referencesConfirmed: true })).status).toBe(200);
    const version = state.store.work("work").versions[0];
    expect(version.prepared).toBe(true);
    expect(version.referenceSnapshot?.items[0].imageUrl).toContain(`/versions/${version.id}/`);
    const manifest = JSON.parse(await readFile(join(state.directory, "output/agent-studio/work/versions", version.id, "references.json"), "utf8"));
    expect(manifest.segments[1]).toEqual(plan.segments[1].references);
    state.store.update("work", work => { work.references![0].name = "changed"; work.plan!.segments[0].references = { product: null }; });
    expect(state.store.work("work").versions[0].referenceSnapshot?.items[0].name).toBe("收纳盒");
    const snapshotFile = await referenceFile(version.referenceSnapshot!.items[0].imageUrl);
    expect(await readFile(snapshotFile)).toEqual(png);
    // Reopening the durable store preserves the same version snapshot.
    expect(new AgentStudioStore(studioDb).work("work").versions[0].referenceSnapshot).toEqual(version.referenceSnapshot);
  });
  it("submits only each segment's allocated images, labels their roles and preserves single-submit recovery", async () => {
    const { runtime } = await reviewed(); const s = state.store;
    const version = s.approve("work", 10, JSON.stringify(plan)); await initializeVersion("work", version.id); rememberKey(version.id, "test-key");
    const current = s.work("work"), frozen = current.versions[0];
    const first = await referenceContent(current, frozen, 0), second = await referenceContent(current, frozen, 1);
    expect(first.filter((v: unknown) => (v as { type: string }).type === "image_url")).toHaveLength(3);
    expect(second.filter((v: unknown) => (v as { type: string }).type === "image_url")).toHaveLength(2);
    expect(JSON.stringify(second)).toContain("抽纸"); expect(JSON.stringify(second)).not.toContain("虚拟小林"); expect(JSON.stringify(second)).not.toContain("收纳盒");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: "cgt-reference-123456" })).mockResolvedValueOnce(Response.json({ status: "running" })); vi.stubGlobal("fetch", fetcher);
    const job = s.claim(runtime.id)!;
    await advanceGeneration(job); await advanceGeneration(job);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[0][1].method).toBe("POST"); expect(fetcher.mock.calls[1][1].method).toBe("GET");
    const payload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload.content.filter((v: { type: string }) => v.type === "image_url")).toHaveLength(3);
    expect(payload.content[0].text).toContain("虚拟主播"); expect(payload.content[0].text).toContain("场地背景");
  });
  it("detects a corrupt version image before any paid submission and keeps the receipt pending", async () => {
    const { runtime } = await reviewed(); const s = state.store, version = s.approve("work", 10, JSON.stringify(plan));
    await initializeVersion("work", version.id); rememberKey(version.id, "test-key");
    await writeFile(await referenceFile(s.work("work").versions[0].referenceSnapshot!.items[0].imageUrl), "corrupt");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(advanceGeneration(s.claim(runtime.id)!)).rejects.toThrow("损坏");
    expect(fetcher).not.toHaveBeenCalled(); expect(s.work("work").versions[0].receipts[0].state).toBe("pending");
  });
  it("invalidates a reviewed plan when the material selection changes, without mutating a past snapshot", async () => {
    await reviewed();
    const response = await request({ action: "plan", brief: "new target", references: [] });
    expect(response.status).toBe(200); expect(state.store.work("work").plan).toBeNull(); expect(state.store.work("work").references).toEqual([]);
    expect((await request({ action: "approve", budget: 10, plan: JSON.stringify(plan), apiKey: "test-key", productConfirmed: true, referencesConfirmed: true })).status).toBe(400);
  });
});

describe("reference boundaries and old-plan compatibility", () => {
  it.each(["/api/files/../secret.png", "/api/files/%2e%2e/secret.png", "file:///etc/passwd", "https://example.com/image.png", "data:image/png;base64,aA=="])("rejects unsupported source paths: %s", async imageUrl => {
    await expect(captureReferences("work", [{ ...inputs[0], imageUrl }])).rejects.toThrow();
  });
  it("rejects symlink escapes, oversized files and disguised non-images", async () => {
    await writeFile(join(state.directory, "private.png"), png); await symlink(join(state.directory, "private.png"), join(state.directory, "uploads/escape.png"));
    await expect(referenceFile("/api/files/escape.png")).rejects.toThrow("超出");
    await writeFile(join(state.directory, "uploads/product.png"), Buffer.alloc(20 * 1024 * 1024 + 1));
    await expect(captureReferences("work", [inputs[0]])).rejects.toThrow("20MB");
    await writeFile(join(state.directory, "uploads/product.png"), "<html>not an image</html>");
    await expect(captureReferences("work", [inputs[0]])).rejects.toThrow("Unsupported reference format");
  });
  it("rejects missing scenes, duplicate IDs and model-invented or cross-role assignments", async () => {
    await expect(captureReferences("work", [{ ...inputs[3], sourceId: "missing" }])).rejects.toThrow();
    expect(() => parseReferenceInputs([inputs[0], inputs[0]])).toThrow();
    const references = await captureReferences("work", inputs);
    for (const product of ["missing", "presenter"]) expect(() => validatePlanReferences({ ...plan, segments: [{ ...plan.segments[0], references: { product } }] }, references)).toThrow();
    expect(() => parseAgentPlan({ ...plan, segments: [{ ...plan.segments[0], duration: 9, references: { product: { command: "bad" } } }] }, 9)).toThrow();
  });
  it("inherits defaults, supports omission, retains legacy crops and never falls back when a chosen asset is missing", async () => {
    const references = await captureReferences("work", inputs);
    expect(resolveSegmentReferences({ ...plan.segments[0], references: undefined }, references).map(item => item.id)).toEqual(["product-one", "presenter", "scene"]);
    expect(resolveSegmentReferences({ ...plan.segments[0], references: { product: null, presenter: null, scene: null } }, references)).toEqual([]);
    const cropPlan = { ...plan, productCrop: { frame: 0, x: 0, y: 0, width: 1, height: 1 } };
    expect(usesProductCrop(cropPlan, 0, references)).toBe(false);
    const legacy = { ...cropPlan, segments: [{ duration: 9, script: "legacy", prompt: "legacy" }] };
    expect(parseAgentPlan(legacy, 9)).toEqual(legacy); expect(usesProductCrop(legacy, 0, [])).toBe(true);
    await rm(await referenceFile(references[0].imageUrl));
    await expect(readReferenceImage(references[0])).rejects.toThrow();
    await expect(freezeReferenceSnapshot("work", "version", { capturedAt: 1, items: references })).rejects.toThrow();
  });
});

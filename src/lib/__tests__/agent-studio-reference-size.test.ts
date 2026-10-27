// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { AgentStudioStore } from "@/lib/agent-studio/store";
import type { AgentPlan } from "@/lib/agent-studio/types";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";

const state = vi.hoisted(() => ({ directory: "", store: null as unknown as AgentStudioStore }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory, getUploadsDir: () => join(state.directory, "uploads"), getOutputDir: () => join(state.directory, "output") }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/agent-studio/store", async original => ({ ...await original<typeof import("@/lib/agent-studio/store")>(), studioStore: () => state.store }));
vi.mock("@/lib/agent-studio/catalog", () => ({ syncAgentWork: vi.fn(), recordAgentProgress: vi.fn() }));
vi.mock("@/lib/asr-server", () => ({ transcribeSourceChunk: vi.fn() }));
vi.mock("@/lib/edge-tts", () => ({ generateSpeechFreeDetailed: vi.fn(async () => {
  // One second of silent PCM audio; real ffmpeg can read it, with no network TTS.
  const audio = Buffer.alloc(48044); audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(48000, 40);
  return { audio };
}) }));
import { advanceGeneration, cropUrl, initializeVersion, prepareCrop, rememberKey } from "@/lib/agent-studio/engine";
import { captureReferences, readReferenceImage } from "@/lib/agent-studio/reference-assets";
import { videoReferenceImage } from "@/lib/agent-studio/reference-image";

const exec = promisify(execFile);
const plan: AgentPlan = { summary: "商品演示", preserve: [], change: [], notes: [], productCrop: { frame: 0, x: 0, y: 0, width: 0.4, height: 1 }, segments: [{ duration: 9, script: "介绍商品。", prompt: "Demonstrate product" }] };
let db: Database.Database;
async function image(path: string, size: string) {
  await exec(ffmpegBin(), ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=${size}`, "-frames:v", "1", path]);
}
beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "clipforge-reference-size-"));
  db = new Database(":memory:"); state.store = new AgentStudioStore(db);
});
afterEach(async () => { db.close(); vi.unstubAllGlobals(); await rm(state.directory, { recursive: true, force: true }); });

describe("Agent product reference minimum size (real ffmpeg, mocked paid endpoint)", () => {
  it("keeps a narrow product ROI intact while preparing a provider-compatible image", async () => {
    const analysis = join(state.directory, "output/agent-studio/work/analysis"); await mkdir(analysis, { recursive: true });
    await image(join(analysis, "frame-0.jpg"), "600x600");
    await prepareCrop("work", plan);
    const path = cropUrl({ id: "work", plan } as Parameters<typeof cropUrl>[0])!.replace("/api/output/", "output/");
    const info = await probeMedia(join(state.directory, path));
    expect(info.width).toBe(300); expect(info.height).toBe(600);
    const { stdout: pixels } = await exec(ffmpegBin(), ["-v", "error", "-i", join(state.directory, path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-frames:v", "1", "pipe:1"], { encoding: "buffer", maxBuffer: 1024 * 1024 });
    const edge = (300 * 300) * 3, center = (300 * 300 + 150) * 3;
    expect([...pixels.subarray(edge, edge + 3)].every(channel => channel > 240)).toBe(true);
    expect(pixels[center]).toBeGreaterThan(230); expect(pixels[center + 1]).toBeLessThan(30); expect(pixels[center + 2]).toBeLessThan(30);
  });

  it("recovers an already prepared 240x600 crop without rewriting its approved snapshot", async () => {
    const s = state.store, runtime = s.register("test", "codex").runtime;
    const work = s.create({ title: "Crop", sourceAssetId: "video", sourceUrl: "/api/files/source.mp4", sourceName: "video", duration: 9, brief: "crop", runtimeId: runtime.id, resolution: "480p", voice: "female" });
    const analysis = s.enqueue(work.id, "plan"); s.claim(runtime.id); s.completePlan(analysis.id, plan);
    const version = s.approve(work.id, 10, JSON.stringify(plan));
    const dir = join(state.directory, "output/agent-studio", work.id, "versions", version.id); await mkdir(dir, { recursive: true });
    const product = join(dir, "product.jpg"); await image(product, "240x600"); const original = await readFile(product);
    s.update(work.id, w => { w.versions[0].prepared = true; }); rememberKey(version.id, "test-key");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const ref = body.content.find((item: { type: string }) => item.type === "image_url");
      const sent = join(state.directory, "sent-image"); await writeFile(sent, Buffer.from(ref.image_url.url.split(",")[1], "base64"));
      const info = await probeMedia(sent);
      if (info.width < 300 || info.height < 300) return Response.json({ error: { code: "InvalidParameter", message: `expected the width to be at least 300px, but received a ${info.width}x${info.height}px image instead` } }, { status: 400 });
      return Response.json({ id: "cgt-size-regression" });
    }); vi.stubGlobal("fetch", fetcher);
    await advanceGeneration(s.claim(runtime.id)!);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(s.work(work.id).versions[0].receipts[0].state).toBe("submitted");
    expect(await readFile(product)).toEqual(original);
  });

  it("pads allocated product and presenter snapshots before the paid boundary and preserves their hashes", async () => {
    await mkdir(join(state.directory, "uploads"));
    await image(join(state.directory, "uploads/product.png"), "240x600");
    await image(join(state.directory, "uploads/presenter.png"), "600x240");
    const references = await captureReferences("work", [
      { id: "product", sourceId: "product", role: "product", name: "商品", description: "", imageUrl: "/api/files/product.png" },
      { id: "presenter", sourceId: "presenter", role: "presenter", name: "主播", description: "", imageUrl: "/api/files/presenter.png" },
    ]);
    const s = state.store, runtime = s.register("test", "codex").runtime;
    const work = s.create({ title: "Selected references", sourceAssetId: "video", sourceUrl: "/api/files/source.mp4", sourceName: "video", duration: 9, brief: "references", runtimeId: runtime.id, resolution: "480p", voice: "female", references }, "work");
    const selectedPlan = { ...plan, productCrop: null };
    const analysis = s.enqueue(work.id, "plan"); s.claim(runtime.id); s.completePlan(analysis.id, selectedPlan);
    const version = s.approve(work.id, 10, JSON.stringify(selectedPlan)); await initializeVersion(work.id, version.id); rememberKey(version.id, "test-key");
    const snapshots = s.work(work.id).versions[0].referenceSnapshot!.items;
    const originals = await Promise.all(snapshots.map(item => readReferenceImage(item)));
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const content = JSON.parse(init.body as string).content.filter((item: { type: string }) => item.type === "image_url");
      expect(content).toHaveLength(2);
      for (const [index, ref] of content.entries()) {
        const sent = join(state.directory, `sent-${index}.png`); await writeFile(sent, Buffer.from(ref.image_url.url.split(",")[1], "base64"));
        const info = await probeMedia(sent); expect(info.width).toBeGreaterThanOrEqual(300); expect(info.height).toBeGreaterThanOrEqual(300);
      }
      return Response.json({ id: "cgt-selected-size-regression" });
    }); vi.stubGlobal("fetch", fetcher);
    await advanceGeneration(s.claim(runtime.id)!); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await Promise.all(snapshots.map(item => readReferenceImage(item)))).toEqual(originals);
  });

  it("passes an already valid reference through byte-for-byte and rejects undecodable images locally", async () => {
    const path = join(state.directory, "valid.png"); await image(path, "400x600"); const data = await readFile(path);
    expect(await videoReferenceImage(data, "image/png")).toBe(`data:image/png;base64,${data.toString("base64")}`);
    await expect(videoReferenceImage(Buffer.from("broken"), "image/png")).rejects.toThrow();
  });
});

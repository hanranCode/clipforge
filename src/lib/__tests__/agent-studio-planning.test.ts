// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AgentStudioStore } from "@/lib/agent-studio/store";
import type { AgentJob } from "@/lib/agent-studio/types";
const state = vi.hoisted(() => ({ directory: "", duration: 9.6, store: null as unknown as AgentStudioStore }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory, getUploadsDir: () => join(state.directory, "uploads"), getOutputDir: () => join(state.directory, "output") }));
vi.mock("@/lib/agent-studio/store", async original => ({ ...await original<typeof import("@/lib/agent-studio/store")>(), studioStore: () => state.store }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/edge-tts", () => ({ generateSpeechFreeDetailed: vi.fn() }));
vi.mock("@/lib/media-probe", () => ({ probeMedia: vi.fn(async () => ({ duration: state.duration, width: 496, height: 864, hasAudio: true, frameRate: 25 })) }));
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFrameAtTime: vi.fn(async (_file: string, time: number, output: string) => time < state.duration ? output : undefined) }));
vi.mock("@/lib/asr-server", () => ({ transcribeSourceChunk: vi.fn(async () => ({ text: "原片口播" })) }));
import { planningContext } from "@/lib/agent-studio/engine";
import { extractFrameAtTime } from "@/lib/video-composer/frame-extract";
import { transcribeSourceChunk } from "@/lib/asr-server";
let database: Database.Database;
beforeEach(async () => { vi.clearAllMocks(); state.directory = await mkdtemp(join(tmpdir(), "clipforge-analysis-")); await mkdir(join(state.directory, "uploads")); await writeFile(join(state.directory, "uploads", "source.mp4"), "local fixture"); database = new Database(":memory:"); state.store = new AgentStudioStore(database); });
afterEach(async () => { database.close(); await rm(state.directory, { recursive: true, force: true }); });
describe("reference preparation preserves true source bounds", () => {
  it.each([9.6, 26.9])("extracts six valid frames and complete speech from a %ss source", async duration => {
    state.duration = duration;
    const w = state.store.create({ title: "Fractional reference", sourceAssetId: "source", sourceUrl: "/api/files/source.mp4", sourceName: "source", duration: Math.round(duration), brief: "new presenter", runtimeId: null, resolution: "480p", voice: "female" });
    const context = await planningContext({ workId: w.id } as AgentJob);
    expect(context.frames).toHaveLength(6); expect(context.duration).toBe(Math.round(duration));
    const times = vi.mocked(extractFrameAtTime).mock.calls.map(call => call[1]);
    expect(times.every(time => time >= 0 && time < duration)).toBe(true);
    expect(times.at(-1)).toBeGreaterThan(duration - .2);
    expect(transcribeSourceChunk).toHaveBeenCalledWith(expect.objectContaining({ start: 0, duration, sourceDuration: duration }));
  });
});

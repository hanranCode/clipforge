// @vitest-environment node
// Regression: ISSUE-002 — publication must preserve unknown self-hosted GPU costs.
// Found by /qa on 2026-10-28
// Report: docs/litforge-fullflow-verification-20261028.md
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { AgentStudioStore } from "@/lib/agent-studio/store";
import type { WorkVersion } from "@/lib/agent-studio/types";
const state = vi.hoisted(() => ({ root: "", db: null as unknown, store: null as unknown as AgentStudioStore }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.root, getOutputDir: () => join(state.root, "output"), getUploadsDir: () => join(state.root, "uploads") }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/agent-studio/store", async original => ({ ...await original<typeof import("@/lib/agent-studio/store")>(), studioStore: () => state.store }));
vi.mock("@/lib/asr-server", () => ({ transcribeSourceChunk: vi.fn(async () => ({ text: "测试口播", words: [], segments: [], silenceRanges: [], model: "test-asr" })) }));
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { publishImportedVersion } from "@/lib/agent-studio/engine";
let sql: Database.Database, studioSql: Database.Database;
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), "studio-publish-"));
  sql = new Database(":memory:"); studioSql = new Database(":memory:");
  const db = drizzle(sql, { schema }); state.db = db; migrate(db, { migrationsFolder: "drizzle" });
  state.store = new AgentStudioStore(studioSql); await mkdir(join(state.root, "uploads"));
});
afterEach(async () => { sql.close(); studioSql.close(); await rm(state.root, { recursive: true, force: true }); });
it.each(["litforge", "volcengine"])("publishes %s through real local composition without changing its cost meaning", async provider => {
  const video = { provider, model: provider === "litforge" ? "litforge/wan-vace-reference-v1" : "doubao-seedance-2-0-mini-260615", resolution: "480p" as const };
  const work = state.store.create({ title: "Publication regression", sourceAssetId: "fixture", sourceUrl: "/api/files/source.mp4", sourceName: "fixture", duration: 4, brief: "test", runtimeId: null, resolution: "480p", voice: "female", video });
  const dir = join(state.root, "output", "agent-studio", work.id, "versions", "version"); await mkdir(dir, { recursive: true });
  const file = join(dir, "segment-0.mp4");
  await promisify(execFile)(ffmpegBin(), ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x96:r=24:d=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-c:a", "aac", "-shortest", file]);
  const version: WorkVersion = { id: "version", number: 1, status: "generating", video, prepared: true,
    plan: { summary: "Test", preserve: [], change: [], notes: [], productCrop: null, segments: [{ duration: 4, script: "测试口播", prompt: "Test" }] },
    budgetCny: 5, estimatedCny: 0, costCny: provider === "litforge" ? null : 1.25,
    receipts: [{ state: "completed", taskId: "fixture-task", file, ...(provider !== "litforge" && { costCny: 1.25 }) }],
    outputUrl: null, posterUrl: null, sourceId: null, editorUrl: null, error: null, createdAt: Date.now(), completedAt: null };
  state.store.update(work.id, w => { w.status = "generating"; w.versions = [version]; });
  await publishImportedVersion(state.store.work(work.id), version);
  const saved = state.store.work(work.id).versions[0];
  expect(saved.status).toBe("completed"); expect(saved.outputUrl).toContain("/final.mp4");
  expect(saved.costCny).toBe(provider === "litforge" ? null : 1.25);
});

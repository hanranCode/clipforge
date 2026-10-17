// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { execFile } from "child_process";
import { promisify } from "util";
import { copyFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import type { ObjectStorageConfig } from "@/lib/object-storage";
import { ffmpegBin } from "@/lib/ffmpeg-path";

const state = vi.hoisted(() => ({ directory: "", database: undefined as unknown, failUpload: false, objects: new Set<string>(), puts: 0, simulatedSize: 0 }));
vi.mock("fs/promises", async (original) => {
  const fs = await original<typeof import("fs/promises")>();
  return { ...fs, stat: async (...args: Parameters<typeof fs.stat>) => {
    const info = await fs.stat(...args);
    if (state.simulatedSize) info.size = state.simulatedSize;
    return info;
  } };
});
vi.mock("@/lib/paths", () => ({ getUploadsDir: () => `${state.directory}/uploads`, getDataDir: () => state.directory }));
vi.mock("@/lib/db", () => ({ getDb: () => state.database }));
const exec = promisify(execFile);
const config: ObjectStorageConfig = { endpoint: "https://tos-s3-cn-beijing.volces.com", region: "cn-beijing", bucket: "test-bucket", prefix: "clipforge", accessKeyId: "test-key", secretAccessKey: "test-secret" };
let connection: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;
let source: string;

beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "clipforge-reference-test-"));
  connection = new Database(":memory:");
  database = drizzle(connection, { schema }); state.database = database;
  migrate(database, { migrationsFolder: join(process.cwd(), "drizzle") });
  state.objects.clear(); state.puts = 0; state.failUpload = false; state.simulatedSize = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url); const identity = parsed.origin + parsed.pathname;
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
    if (init.method === "HEAD") return new Response(null, { status: state.objects.has(identity) ? 200 : 404 });
    expect(init.method).toBe("PUT"); state.puts++;
    if (state.failUpload) return new Response("<Error><Message>Upload failed</Message></Error>", { status: 500 });
    expect(init.body).toBeInstanceOf(Uint8Array); state.objects.add(identity); return new Response(null, { status: 200 });
  }));
  source = join(state.directory, "source.wav");
  await exec(ffmpegBin(), ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", source]);
});
afterEach(async () => { connection?.close(); await rm(state.directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("persistent MD5 reference library", () => {
  it("archives paid results above the input limit and rejects files above the result limit", async () => {
    const { registerReferenceFile, resolveReferenceResource } = await import("@/lib/reference-resource-server");
    state.simulatedSize = 201 * 1024 * 1024;
    const saved = await registerReferenceFile(config, source, "Paid result");
    expect(saved.id).toMatch(/^md5-/);
    expect((await resolveReferenceResource(config, saved.id)).id).toBe(saved.id);
    expect(state.puts).toBe(1);
    state.simulatedSize = 301 * 1024 * 1024;
    await expect(registerReferenceFile(config, source)).rejects.toThrow("300MB");
    expect(state.puts).toBe(1);
  });

  it("deduplicates identical files across paths, concurrent callers and module restarts", async () => {
    const { registerReferenceFile, fileMd5 } = await import("@/lib/reference-resource-server");
    const other = join(state.directory, "same-bytes.wav"); await copyFile(source, other);
    const [a, b] = await Promise.all([registerReferenceFile(config, source, "原声"), registerReferenceFile(config, other, "重复音轨")]);
    expect(a.md5).toBe(await fileMd5(source)); expect(a.id).toBe(b.id); expect(a.path).toBe(b.path);
    expect(a.url.startsWith("https://test-bucket.tos-s3-cn-beijing.volces.com/")).toBe(true);
    expect(a.objectUrl).not.toContain("X-Amz"); expect(a.objectKey).toContain(`/md5/${a.md5}.wav`);
    expect(database.select().from(schema.libraryAssets).all()).toHaveLength(1);
    expect(database.select().from(schema.referenceCloudCopies).all()).toHaveLength(1);
    expect(state.puts).toBe(1);
    vi.resetModules();
    const fresh = await import("@/lib/reference-resource-server");
    const restored = await fresh.resolveReferenceResource(config, a.id);
    expect(restored.md5).toBe(a.md5); expect(state.puts).toBe(1);
    expect(JSON.stringify(database.select().from(schema.referenceCloudCopies).all())).not.toContain("test-secret");
  });

  it("isolates buckets and restores a missing cloud object using the same content key", async () => {
    const { registerReferenceFile } = await import("@/lib/reference-resource-server");
    const a = await registerReferenceFile(config, source);
    await registerReferenceFile({ ...config, bucket: "another-bucket" }, source);
    expect(state.puts).toBe(2); expect(database.select().from(schema.referenceCloudCopies).all()).toHaveLength(2);
    await registerReferenceFile(config, source); expect(state.puts).toBe(2);
    state.objects.delete(a.objectUrl);
    const restored = await registerReferenceFile(config, source);
    expect(restored.objectKey).toBe(a.objectKey); expect(state.puts).toBe(3);
    expect(database.select().from(schema.libraryAssets).all()).toHaveLength(1);
  });

  it("keeps a local library row after upload failure and safely retries without a false cloud mapping", async () => {
    const { registerReferenceFile } = await import("@/lib/reference-resource-server");
    state.failUpload = true;
    await expect(registerReferenceFile(config, source)).rejects.toThrow("上传失败");
    expect(database.select().from(schema.libraryAssets).all()).toHaveLength(1);
    expect(database.select().from(schema.referenceCloudCopies).all()).toHaveLength(0);
    state.failUpload = false;
    const result = await registerReferenceFile(config, source);
    expect(result.md5).toMatch(/^[a-f0-9]{32}$/);
    expect(database.select().from(schema.libraryAssets).all()).toHaveLength(1);
    expect(database.select().from(schema.referenceCloudCopies).all()).toHaveLength(1);
  });
});

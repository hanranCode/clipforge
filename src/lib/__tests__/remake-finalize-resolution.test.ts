// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ root: "", assets: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.root, getUploadsDir: () => join(state.root, "uploads") }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ insert: () => ({ values: (value: Record<string, unknown>) => ({ returning: async () => { state.assets.push(value); return [{ ...value, id: "final-asset" }]; } }) }) }) }));
import { POST } from "@/app/api/remake/finalize/route";
import { probeMedia } from "@/lib/media-probe";
import { ffmpegBin } from "@/lib/ffmpeg-path";
const exec = promisify(execFile);
beforeAll(async () => {
  state.root = await mkdtemp(join(tmpdir(), "clipforge-remake-final-"));
  await mkdir(join(state.root, "uploads"));
  await exec(ffmpegBin(), ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:size=1920x1080:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", join(state.root, "uploads/source.mp4")]);
});
afterAll(async () => { await rm(state.root, { recursive: true, force: true }); });
it.each([undefined, ["480p"], ["720p", "480p"]])("encodes a 1080p reference's finished remake at 480p for %s", async resolutions => {
  const response = await POST(new NextRequest("http://localhost/api/remake/finalize", { method: "POST", body: JSON.stringify({ jobId: "test-finalize", sourcePath: "/api/files/source.mp4", segments: [{ start: 0, end: 4, path: "/api/files/source.mp4", edited: true }], audioMode: "keep", resolutions }) }));
  expect(response.status).toBe(200);
  const final = await response.json();
  const file = join(state.root, "uploads", final.url.replace("/api/files/", ""));
  const media = await probeMedia(file);
  expect(media.width).toBe(854); expect(media.height).toBe(480); expect(media.hasAudio).toBe(true);
  expect(media.duration).toBeCloseTo(4, 1);
  expect(state.assets.at(-1)).toMatchObject({ width: 854, height: 480 });
}, 30_000);
it("rejects an invalid assembly tier before encoding", async () => {
  const response = await POST(new NextRequest("http://localhost/api/remake/finalize", { method: "POST", body: JSON.stringify({ jobId: "test-finalize", sourcePath: "/api/files/source.mp4", segments: [{ start: 0, end: 4, path: "/api/files/source.mp4" }], resolutions: ["wrong"] }) }));
  expect(response.status).toBe(400);
});

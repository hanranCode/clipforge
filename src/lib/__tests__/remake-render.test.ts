// @vitest-environment node
import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";
import { assembleRemake, cutSegment, sliceAudio } from "@/lib/remake/render";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("remake audio alignment in FFmpeg", () => {
  it("cuts video and audio on fractional boundaries and assembles short/silent generated results without shifting the timeline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clipforge-remake-")); dirs.push(dir);
    const source = join(dir, "source.mp4");
    await exec(ffmpegBin(), ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=30:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
    const video = join(dir, "cut.mp4"); const audio = join(dir, "cut.mp3");
    const span = { start: 2.5, end: 7.125 };
    await cutSegment(source, span, video); await sliceAudio(source, span, audio);
    expect(Math.abs((await probeMedia(video)).duration - 4.625)).toBeLessThan(0.1);
    expect(Math.abs((await probeMedia(audio)).duration - 4.625)).toBeLessThan(0.1);
    const short = join(dir, "short.mp4"); const silent = join(dir, "silent.mp4"); const output = join(dir, "final.mp4");
    await cutSegment(source, { start: 0, end: 3.6 }, short);
    await exec(ffmpegBin(), ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=160x90:rate=24:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    await assembleRemake({ workDir: dir, segments: [{ start: 0, end: 4, file: short }, { start: 4, end: 8, file: silent }], width: 320, height: 180, frameRate: 30, audio: { mode: "generated" }, outPath: output });
    const probe = await probeMedia(output);
    expect(probe.hasAudio).toBe(true); expect(probe.width).toBe(320);
    expect(Math.abs(probe.duration - 8)).toBeLessThan(0.15);
    const first = await exec(ffmpegBin(), ["-v", "info", "-ss", "1", "-i", output, "-t", "1", "-af", "volumedetect", "-f", "null", "-"]);
    const second = await exec(ffmpegBin(), ["-v", "info", "-ss", "5", "-i", output, "-t", "1", "-af", "volumedetect", "-f", "null", "-"]);
    expect(first.stderr).toMatch(/mean_volume: -(?:1\d|2\d)\./);
    expect(second.stderr).toMatch(/mean_volume: -91\./);
  }, 30_000);
});

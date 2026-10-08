/**
 * ffmpeg side of 视频复刻: cut the source into the planned segments, lay the re-dub onto the
 * source timeline, and stitch edited + untouched segments back into one clip with the chosen audio.
 *
 * Every segment is re-encoded to the source's exact size, frame rate and length before concat, so a
 * model clip that came back a few frames short or at another resolution cannot shift what follows.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile } from "fs/promises";
import { join } from "path";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { placeDubCues, type DubCue, type TimeSpan } from "@/lib/remake/plan";

const execFileAsync = promisify(execFile);
const RUN = { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 };

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(ffmpegBin(), ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], RUN);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr ? `ffmpeg 处理失败：${stderr.split("\n").slice(-3).join(" ")}` : "ffmpeg 处理失败");
  }
}

const sec = (n: number) => n.toFixed(3);
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Frame-accurate cut (re-encoded, so it can start between keyframes); keeps the audio */
export async function cutSegment(sourcePath: string, span: TimeSpan, outPath: string): Promise<void> {
  await ffmpeg([
    "-ss", sec(span.start),
    "-i", sourcePath,
    "-t", sec(span.end - span.start),
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    outPath,
  ]);
}

/** Slice of an audio track (the dub's share of one segment, sent as the lip-sync reference) */
export async function sliceAudio(sourcePath: string, span: TimeSpan, outPath: string): Promise<void> {
  await ffmpeg(["-ss", sec(span.start), "-i", sourcePath, "-t", sec(span.end - span.start), "-c:a", "libmp3lame", "-b:a", "128k", outPath]);
}

/**
 * Filter graph for the dub track. Each line owns the slot from its start to the next line's start:
 * it is sped up (capped) to fit, padded with silence and cut to exactly that slot, so concatenating
 * the slots after a leading delay reproduces the subtitle timeline without drift.
 */
export function dubFilterGraph(
  cues: Array<DubCue & { audioSeconds: number }>,
  duration: number,
): string {
  const placed = placeDubCues(cues, duration);
  const parts = placed.map((p, i) => {
    const tempo = p.tempo > 1.001 ? `,atempo=${p.tempo}` : "";
    return `[${i}:a]aformat=sample_rates=44100:channel_layouts=mono${tempo},apad,atrim=0:${sec(p.slot)},asetpts=PTS-STARTPTS[s${i}]`;
  });
  const labels = placed.map((_, i) => `[s${i}]`).join("");
  const leadMs = Math.round((placed[0]?.start ?? 0) * 1000);
  return [
    ...parts,
    `${labels}concat=n=${placed.length}:v=0:a=1[cat]`,
    `[cat]adelay=${leadMs}:all=1,apad,atrim=0:${sec(duration)}[out]`,
  ].join(";");
}

/** Mix the per-line TTS files into one track as long as the clip */
export async function buildDubTrack(
  lines: Array<DubCue & { audioSeconds: number; file: string }>,
  duration: number,
  outPath: string,
): Promise<void> {
  if (!lines.length) throw new Error("没有可配音的字幕");
  const scriptPath = `${outPath}.filter.txt`;
  await writeFile(scriptPath, dubFilterGraph(lines, duration));
  await ffmpeg([
    ...lines.flatMap((line) => ["-i", line.file]),
    "-filter_complex_script", scriptPath,
    "-map", "[out]",
    "-c:a", "aac", "-b:a", "160k",
    outPath,
  ]);
}

export type FinalAudio = { mode: "keep"; sourcePath: string } | { mode: "mute" } | { mode: "dub"; dubPath: string };

/**
 * Normalise every segment to the source geometry and length, concatenate, and attach the audio.
 * `segments` are in timeline order and together cover the source.
 */
export async function assembleRemake(input: {
  workDir: string;
  segments: Array<TimeSpan & { file: string }>;
  width: number;
  height: number;
  frameRate: number;
  audio: FinalAudio;
  outPath: string;
}): Promise<void> {
  const width = even(input.width);
  const height = even(input.height);
  const fps = Math.round(input.frameRate * 1000) / 1000 || 30;
  const normalised: string[] = [];
  for (const [i, seg] of input.segments.entries()) {
    const out = join(input.workDir, `norm-${i}.mp4`);
    await ffmpeg([
      "-i", seg.file,
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=3`,
      "-t", sec(seg.end - seg.start),
      "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      out,
    ]);
    normalised.push(out);
  }
  const listPath = join(input.workDir, "concat.txt");
  await writeFile(listPath, normalised.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const total = input.segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const audioArgs =
    input.audio.mode === "keep"
      ? ["-i", input.audio.sourcePath, "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "160k"]
      : input.audio.mode === "dub"
        ? ["-i", input.audio.dubPath, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "160k"]
        : ["-map", "0:v:0", "-an"];
  await ffmpeg([
    "-f", "concat", "-safe", "0", "-i", listPath,
    ...audioArgs,
    "-c:v", "copy",
    "-t", sec(total),
    "-movflags", "+faststart",
    input.outPath,
  ]);
}

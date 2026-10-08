import "@/lib/api-call-store";
import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import { apiError } from "@/lib/api-error";
import { probeMedia } from "@/lib/media-probe";
import { estimateSpeechSeconds } from "@/lib/tts";
import { mapWithConcurrency } from "@/lib/concurrency";
import { isJobId, jobDir, jobFileUrl } from "@/lib/remake/jobs";
import { buildDubTrack, sliceAudio } from "@/lib/remake/render";
import { cuesForSegment, type DubCue } from "@/lib/remake/plan";
import { parseDubVoice, synthesizeLine } from "@/lib/remake/voice";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * POST /api/remake/dub — re-voice the subtitles in the presenter's voice.
 * body: { jobId, duration, cues: [{ id, start, end, text }], voice, segments: [{ index, start, end }] }
 *
 * Each line is synthesised, fitted into its slot on the source timeline and mixed into one track as
 * long as the clip; each segment also gets its own slice, which the edit request sends as @音频1 so
 * the new mouth movements follow the new voice.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isJobId(body.jobId)) return apiError(req, "无效的任务", "Invalid job", 400);
  const duration = Number(body.duration);
  if (!(duration > 0)) return apiError(req, "无效的视频时长", "Invalid duration", 400);
  const voice = parseDubVoice(body.voice);
  if (!voice) return apiError(req, "请先为主播设置配音音色", "Set a dubbing voice for the presenter first", 400);
  const cues: DubCue[] = (Array.isArray(body.cues) ? body.cues : [])
    .map((c) => c as Record<string, unknown>)
    .map((c) => ({ id: String(c.id ?? ""), start: Number(c.start), end: Number(c.end), text: typeof c.text === "string" ? c.text.trim() : "" }))
    .filter((c) => c.text && c.start >= 0 && c.end > c.start && c.start < duration)
    .sort((a, b) => a.start - b.start)
    .slice(0, 300);
  if (!cues.length) return apiError(req, "没有可配音的字幕", "No subtitle lines to dub", 400);
  const segments = (Array.isArray(body.segments) ? body.segments : [])
    .map((s) => s as Record<string, unknown>)
    .map((s) => ({ index: Number(s.index), start: Number(s.start), end: Number(s.end) }))
    .filter((s) => Number.isInteger(s.index) && s.end > s.start);

  try {
    const dir = await jobDir(body.jobId);
    const lines = await mapWithConcurrency(cues, 4, async (cue) => {
      const audio = await synthesizeLine(cue.text, voice, { scene: "remake_dub" });
      const file = join(dir, `line-${createHash("sha1").update(`${cue.text}|${JSON.stringify(voice)}`).digest("hex").slice(0, 16)}.mp3`);
      await writeFile(file, audio);
      const probed = await probeMedia(file).catch(() => null);
      return { ...cue, file, audioSeconds: probed?.duration || estimateSpeechSeconds(cue.text) };
    });
    const stamp = Date.now();
    const dubName = `dub-${stamp}.m4a`;
    const dubFile = join(dir, dubName);
    await buildDubTrack(lines, duration, dubFile);

    const segmentAudio: Record<number, string> = {};
    for (const seg of segments) {
      if (!cuesForSegment(cues, seg).length) continue;
      const name = `dub-${stamp}-seg-${seg.index}.mp3`;
      await sliceAudio(dubFile, seg, join(dir, name));
      segmentAudio[seg.index] = jobFileUrl(body.jobId, name);
    }
    return NextResponse.json({
      dubPath: jobFileUrl(body.jobId, dubName),
      segmentAudio,
      lines: lines.map((l) => ({ id: l.id, audioSeconds: l.audioSeconds, slot: l.end - l.start })),
    });
  } catch (error) {
    return apiError(req, error instanceof Error ? error.message : "配音生成失败", "Dubbing failed", 500);
  }
}

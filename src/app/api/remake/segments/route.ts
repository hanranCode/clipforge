import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { join } from "path";
import { apiError } from "@/lib/api-error";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { isJobId, jobDir } from "@/lib/remake/jobs";
import { cutSegment, sliceAudio } from "@/lib/remake/render";
import { validRemakeSegments } from "@/lib/remake/plan";
import { probeMedia } from "@/lib/media-probe";
import { requireReferenceStorage, registerReferenceFile } from "@/lib/reference-resource-server";
import type { ReferenceResource } from "@/lib/reference-resource";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/remake/segments — cut the source into the planned segments (the clips each edit request
 * sends as @视频1). body: { jobId, path, segments: [{ index, start, end }] }. A cut that already
 * exists for the same span is reused, so re-planning only cuts what changed.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isJobId(body.jobId)) return apiError(req, "无效的任务", "Invalid job", 400);
  const sourcePath = resolveUploadFilePath(typeof body.path === "string" ? body.path : "");
  if (!sourcePath) return apiError(req, "无效的视频路径", "Invalid video path", 400);
  const segments = Array.isArray(body.segments) ? body.segments : [];
  try {
    requireReferenceStorage(body.objectStorage);
    const probe = await probeMedia(sourcePath);
    if (!validRemakeSegments(segments, probe.duration)) return apiError(req, "分段需在视频范围内且每段为 4–10 秒", "Segments must be inside the video and 4–10 seconds long", 400);
    const dir = await jobDir(body.jobId);
    const out: Array<{ index: number; path: string; audioPath?: string; resource: ReferenceResource; audioResource?: ReferenceResource }> = [];
    for (const { index, start, end } of segments) {
      const name = `seg-${index}-${Math.round(start * 1000)}-${Math.round(end * 1000)}.mp4`;
      const file = join(dir, name);
      const exists = await stat(file).then((s) => s.size > 0).catch(() => false);
      if (!exists) await cutSegment(sourcePath, { start, end }, file);
      const audioName = name.replace(/\.mp4$/, ".mp3");
      if (probe.hasAudio) {
        const audioFile = join(dir, audioName);
        if (!await stat(audioFile).then((s) => s.size > 0).catch(() => false)) await sliceAudio(sourcePath, { start, end }, audioFile);
      }
      const resource = await registerReferenceFile(body.objectStorage, file, `片段 ${index + 1} · ${start}–${end}s`);
      const audioResource = probe.hasAudio ? await registerReferenceFile(body.objectStorage, join(dir, audioName), `原声 ${index + 1} · ${start}–${end}s`) : undefined;
      out.push({ index, path: resource.path, resource, ...(audioResource && { audioPath: audioResource.path, audioResource }) });
    }
    return NextResponse.json({ segments: out });
  } catch (error) {
    return apiError(req, error instanceof Error ? error.message : "分段失败", "Failed to cut segments", 500);
  }
}

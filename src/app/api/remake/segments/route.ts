import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { join } from "path";
import { apiError } from "@/lib/api-error";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { isJobId, jobDir, jobFileUrl } from "@/lib/remake/jobs";
import { cutSegment } from "@/lib/remake/render";
import { REMAKE_MAX_SEGMENT_SEC, REMAKE_MIN_SEGMENT_SEC } from "@/lib/remake/plan";

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
  if (!segments.length || segments.length > 40) return apiError(req, "分段数量无效", "Invalid segment count", 400);

  try {
    const dir = await jobDir(body.jobId);
    const out: Array<{ index: number; path: string }> = [];
    for (const raw of segments) {
      const seg = raw as Record<string, unknown>;
      const index = Number(seg.index);
      const start = Number(seg.start);
      const end = Number(seg.end);
      const length = end - start;
      // a hair of tolerance: planned bounds are rounded to the millisecond
      if (!Number.isInteger(index) || !(start >= 0) || length < REMAKE_MIN_SEGMENT_SEC - 0.01 || length > REMAKE_MAX_SEGMENT_SEC * 2 + 0.01) {
        return apiError(req, "分段时长需在 4–30 秒之间", "Each segment must be 4–30 seconds", 400);
      }
      const name = `seg-${index}-${Math.round(start * 1000)}-${Math.round(end * 1000)}.mp4`;
      const file = join(dir, name);
      const exists = await stat(file).then((s) => s.size > 0).catch(() => false);
      if (!exists) await cutSegment(sourcePath, { start, end }, file);
      out.push({ index, path: jobFileUrl(body.jobId, name) });
    }
    return NextResponse.json({ segments: out });
  } catch (error) {
    return apiError(req, error instanceof Error ? error.message : "分段失败", "Failed to cut segments", 500);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import { join } from "path";
import { apiError } from "@/lib/api-error";
import { safeFetch } from "@/lib/ssrf-guard";
import { isJobId, jobDir, jobFileUrl } from "@/lib/remake/jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 300 * 1024 * 1024;

/**
 * POST /api/remake/result — keep one edited segment: provider result URLs expire within hours, so the
 * clip is downloaded into the job the moment it lands. body: { jobId, index, url }
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isJobId(body.jobId)) return apiError(req, "无效的任务", "Invalid job", 400);
  const index = Number(body.index);
  const url = typeof body.url === "string" ? body.url : "";
  if (!Number.isInteger(index) || index < 0) return apiError(req, "无效的分段", "Invalid segment", 400);
  if (!/^https?:\/\//.test(url)) return apiError(req, "缺少有效的视频地址", "Missing a valid video URL", 400);
  try {
    const res = await safeFetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) return apiError(req, `结果下载失败（${res.status}）`, `Result download failed (${res.status})`, 502);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return apiError(req, "结果视频为空或过大", "Result video is empty or too large", 502);
    const name = `result-${index}-${Date.now()}.mp4`;
    await writeFile(join(await jobDir(body.jobId), name), buf);
    return NextResponse.json({ path: jobFileUrl(body.jobId, name) });
  } catch (error) {
    return apiError(req, error instanceof Error ? error.message : "结果保存失败", "Failed to save the result", 500);
  }
}

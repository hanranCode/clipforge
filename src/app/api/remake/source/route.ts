import { NextRequest, NextResponse } from "next/server";
import { stat, writeFile } from "fs/promises";
import { join } from "path";
import { apiError } from "@/lib/api-error";
import { probeMedia } from "@/lib/media-probe";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { detectSceneTimes } from "@/lib/video-composer/contact-sheet";
import { jobDir, jobFileUrl, newJobId } from "@/lib/remake/jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

/**
 * POST /api/remake/source — open a remake job on a source clip.
 *  - JSON `{ path }`: a clip already on this machine (asset library / any /api/files path), used in place.
 *  - multipart `file`: an upload, stored in the job directory.
 * Returns the probe (duration, size, frame rate, audio) plus scene changes, which the segment
 * planner snaps its cuts to.
 */
export async function POST(req: NextRequest) {
  const jobId = newJobId();
  let filePath: string;
  let publicPath: string;
  const isJson = (req.headers.get("content-type") ?? "").includes("application/json");
  if (isJson) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const ref = typeof body.path === "string" ? body.path : "";
    const resolved = ref ? resolveUploadFilePath(ref) : null;
    if (!resolved) return apiError(req, "请选择一个素材库视频", "Choose a video from the library", 400);
    const size = await stat(resolved).then((s) => (s.isFile() ? s.size : -1)).catch(() => -1);
    if (size < 0) return apiError(req, "视频文件不存在", "Video file not found", 404);
    if (size > MAX_FILE_SIZE) return apiError(req, "视频超过 200MB 大小限制", "Video exceeds the 200MB limit", 400);
    filePath = resolved;
    publicPath = ref;
  } else {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return apiError(req, "文件过大或上传中断，请重试", "The file is too large or the upload was interrupted", 413);
    }
    const file = form.get("file") as File | null;
    if (!file) return apiError(req, "请上传视频文件", "Please upload a video file", 400);
    if (!EXT_BY_MIME[file.type]) return apiError(req, "仅支持 mp4/webm/mov 视频", "Only mp4/webm/mov videos are supported", 400);
    if (file.size > MAX_FILE_SIZE) return apiError(req, "视频超过 200MB 大小限制", "Video exceeds the 200MB limit", 400);
    const name = `source.${EXT_BY_MIME[file.type]}`;
    filePath = join(await jobDir(jobId), name);
    publicPath = jobFileUrl(jobId, name);
    await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
  }

  try {
    const probe = await probeMedia(filePath);
    if (!probe.duration || !probe.width) {
      return apiError(req, "无法读取视频信息，文件可能损坏", "Could not read the video — the file may be corrupt", 400);
    }
    // scene changes are a nicety for where to cut; a failure must not block the job
    const sceneTimes = await detectSceneTimes(filePath, 0.3).catch(() => [] as number[]);
    await jobDir(jobId);
    return NextResponse.json({
      jobId,
      path: publicPath,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      frameRate: probe.frameRate,
      hasAudio: probe.hasAudio,
      sceneTimes,
    });
  } catch (error) {
    console.error("remake source failed:", error);
    return apiError(req, "视频解析失败", "Failed to read the video", 500);
  }
}

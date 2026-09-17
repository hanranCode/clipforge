import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir, stat } from "fs/promises";
import { join } from "path";
import { getDataDir } from "@/lib/paths";
import { probeMedia } from "@/lib/media-probe";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { classifyAssetMedia } from "@/lib/asset-library";
import { detectSceneTimes } from "@/lib/video-composer/contact-sheet";
import { shotPlanFromCuts } from "@/lib/replicate-plan";
import { apiError, errText } from "@/lib/api-error";
import { CUT_THRESHOLD_DEFAULT, cutsFromShots, orientationOf } from "@/lib/reference-analysis";
import { createAnalysis, loadAnalysis, viewOf } from "@/lib/reference-analysis-store";

/** Single-file limit (matches the materials route; the model tier's own cap is 50MB/15s, reported per-mode) */
const MAX_FILE_SIZE = 80 * 1024 * 1024;
const ALLOWED_MIME = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const EXT_BY_MIME: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

/**
 * Resolve a reference video the caller already has on this machine — a clip in the asset
 * library, or any other `/api/files/...` asset. Nothing is copied: the file is analysed where
 * it lies and the same path is handed back, so the model tier can upload it later.
 *
 * `resolveUploadFilePath` is what keeps this from being an arbitrary-file-read: a path that
 * escapes the uploads root resolves to null and is refused.
 */
async function resolveLibraryReference(
  req: NextRequest,
  ref: unknown,
): Promise<{ filePath: string; publicPath: string } | NextResponse> {
  if (typeof ref !== "string" || !ref.trim()) {
    return apiError(req, "请选择一个素材库视频", "Choose a video from the library", 400);
  }
  const publicPath = ref.trim();
  if (classifyAssetMedia(publicPath) !== "video") {
    return apiError(req, "参考素材必须是视频", "The reference material must be a video", 400);
  }
  const filePath = resolveUploadFilePath(publicPath);
  if (!filePath) {
    return apiError(req, "素材路径无效", "Invalid material path", 400);
  }
  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    return apiError(req, "素材文件不存在，可能已被删除", "The material file no longer exists", 404);
  }
  if (size > MAX_FILE_SIZE) {
    return apiError(req, "参考视频超过 80MB 大小限制", "Reference video exceeds the 80MB size limit", 400);
  }
  return { filePath, publicPath };
}

/**
 * POST /api/replicate/analyze — REAL reference-video analysis for the viral-replication flow
 * (replaces the clone page's old fake 600ms "analysis" that returned a hardcoded 6-card structure).
 *
 * Two ways to name the reference, one analysis:
 *  - `multipart/form-data` with `file=<video>` — an upload, saved under uploads/replicate/.
 *  - `application/json` with `{ path: "/api/files/..." }` — a clip already in the asset library,
 *    analysed in place rather than copied.
 *
 * Either way it probes the file, detects scene cuts with ffmpeg (the same detector as the contact
 * sheet), and returns the shot-duration skeleton plus the ready-to-use referenceStructure block.
 *
 * This is S0 (ingest) + S1 (cuts) of the breakdown pipeline: the result is persisted as a
 * `reference_analyses` row whose id comes back as `analysisId`, and the later stages
 * (/analyze/cut, /analyze/frames) work on that row.
 */
export async function POST(req: NextRequest) {
  const isJson = (req.headers.get("content-type") ?? "").includes("application/json");
  let filePath: string;
  let publicPath: string;

  if (isJson) {
    const body = await req.json().catch(() => ({}));
    const resolved = await resolveLibraryReference(req, (body as Record<string, unknown>).path);
    if (resolved instanceof NextResponse) return resolved;
    ({ filePath, publicPath } = resolved);
  } else {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return apiError(req, "无效的表单数据", "Invalid form data", 400);
    }
    const file = formData.get("file") as File | null;
    if (!file) return apiError(req, "请上传参考视频文件", "Please upload a reference video file", 400);
    if (file.size > MAX_FILE_SIZE) {
      return apiError(req, "参考视频超过 80MB 大小限制", "Reference video exceeds the 80MB size limit", 400);
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return apiError(req, "仅支持 mp4/webm/mov 视频", "Only mp4/webm/mov videos are supported", 400);
    }
    const dir = join(getDataDir(), "uploads", "replicate");
    await mkdir(dir, { recursive: true });
    // renamed on save (original filename never reused — same policy as the materials route)
    const name = `ref-${Date.now()}.${EXT_BY_MIME[file.type] ?? "mp4"}`;
    filePath = join(dir, name);
    publicPath = `/api/files/replicate/${name}`;
    await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
  }

  try {
    const probe = await probeMedia(filePath);
    if (!probe.duration) {
      return apiError(req, "无法读取视频时长，文件可能损坏", "Could not read the video duration — the file may be corrupt", 400);
    }
    const cutStarted = Date.now();
    const detected = await detectSceneTimes(filePath, CUT_THRESHOLD_DEFAULT);
    const shots = shotPlanFromCuts(detected, probe.duration);

    const row = await createAnalysis({
      ingest: {
        path: publicPath,
        source: isJson ? "library" : "upload",
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        frameRate: probe.frameRate,
        hasAudio: probe.hasAudio,
        orientation: orientationOf(probe.width, probe.height),
      },
      cuts: {
        threshold: CUT_THRESHOLD_DEFAULT,
        detected,
        cuts: cutsFromShots(shots),
        shots,
        edited: false,
        revision: 1,
        durationMs: Date.now() - cutStarted,
      },
    });
    // the view keeps the one-shot fields (path/shots/referenceStructure/modelTierEligible…)
    return NextResponse.json(viewOf(row));
  } catch (error) {
    console.error("Reference video analysis failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "参考视频分析失败", "Reference video analysis failed") },
      { status: 500 }
    );
  }
}

/** GET /api/replicate/analyze?id=<analysisId> — the stored breakdown, every stage so far. */
export async function GET(req: NextRequest) {
  const row = await loadAnalysis(req.nextUrl.searchParams.get("id"));
  if (!row?.ingest) return apiError(req, "拆解记录不存在", "Breakdown not found", 404);
  return NextResponse.json(viewOf(row));
}

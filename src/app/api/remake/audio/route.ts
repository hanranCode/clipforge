import { NextRequest } from "next/server";
import { apiError } from "@/lib/api-error";
import { extractAsrAudioChunk } from "@/lib/asr-audio-chunk";
import { resolveUploadFilePath } from "@/lib/remote-image";

export const runtime = "nodejs";

/**
 * GET /api/remake/audio?path=&start=&duration= — one bounded mono 16 kHz PCM chunk of the source,
 * for the in-browser Whisper worker that turns the clip's speech into the re-dub script.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const filePath = resolveUploadFilePath(params.get("path") ?? "");
  if (!filePath) return apiError(req, "无效的视频路径", "Invalid video path", 400);
  const start = Number(params.get("start"));
  const duration = Number(params.get("duration"));
  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0) {
    return apiError(req, "无效的音频区间", "Invalid audio range", 400);
  }
  try {
    const pcm = await extractAsrAudioChunk({ inputPath: filePath, startSeconds: start, durationSeconds: duration, signal: req.signal });
    return new Response(new Uint8Array(pcm), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(req, error instanceof Error ? error.message : "音频提取失败", "Audio extraction failed", 500);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { apiError, errText } from "@/lib/api-error";
import { asrFailure, parseServerAsrEngine, transcribeSourceChunk } from "@/lib/asr-server";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { ASR_CHUNK_SECONDS } from "@/lib/transcript-checkpoint";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/remake/asr — one chunk of the remake source transcribed on the server: SenseVoice on
 * the local CPU (default) or Fish Audio's cloud. Counterpart of /api/remake/audio + the
 * in-browser Whisper worker.
 *
 * body: { engine?: "sensevoice" | "fish", path, start, duration, language?, apiKey? (fish only) }
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { engine?: unknown; path?: unknown; start?: unknown; duration?: unknown; language?: unknown; apiKey?: unknown };
  const filePath = resolveUploadFilePath(typeof body.path === "string" ? body.path : "");
  if (!filePath) return apiError(req, "无效的视频路径", "Invalid video path", 400);
  const engine = parseServerAsrEngine(body.engine);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (engine === "fish" && !apiKey) return apiError(req, "未配置 Fish Audio API Key——先在设置里填写", "No Fish Audio API key — add it in Settings first", 400);
  const start = Number(body.start);
  const duration = Number(body.duration);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0 || duration > ASR_CHUNK_SECONDS) {
    return apiError(req, "无效的音频区间", "Invalid audio range", 400);
  }
  try {
    const chunk = await transcribeSourceChunk({
      engine,
      inputPath: filePath,
      start,
      duration,
      language: typeof body.language === "string" ? body.language : undefined,
      apiKey,
      signal: req.signal,
    });
    return NextResponse.json(chunk);
  } catch (error) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("Remake ASR failed:", error);
    const failure = asrFailure(error);
    return NextResponse.json({ error: errText(req, failure.zh, failure.en), ...(failure.code && { code: failure.code }) }, { status: failure.status });
  }
}

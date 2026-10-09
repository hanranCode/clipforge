import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { apiError, errText } from "@/lib/api-error";
import { asrFailure, parseServerAsrEngine, transcribeSourceChunk } from "@/lib/asr-server";
import { getDb } from "@/lib/db";
import { mediaSources } from "@/lib/db/schema";
import { ASR_CHUNK_SECONDS } from "@/lib/transcript-checkpoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SAFE_ID = /^[a-zA-Z0-9-]+$/;

/**
 * POST /api/project/:id/media/:mediaId/asr — server-side counterpart of the /audio chunk route:
 * cut one bounded chunk and transcribe it with SenseVoice on the local CPU (default) or Fish
 * Audio's cloud, returning a TranscriptDocument chunk the editor feeds into the same checkpoint
 * flow as the in-browser Whisper worker.
 *
 * body: { engine?: "sensevoice" | "fish", start, duration, language?, apiKey? (fish only) }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mediaId: string }> },
) {
  const { id, mediaId } = await params;
  if (!SAFE_ID.test(id) || !SAFE_ID.test(mediaId)) return apiError(req, "无效的素材ID", "Invalid media ID", 400);
  const body = (await req.json().catch(() => ({}))) as { engine?: unknown; start?: unknown; duration?: unknown; language?: unknown; apiKey?: unknown };
  const engine = parseServerAsrEngine(body.engine);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (engine === "fish" && !apiKey) return apiError(req, "未配置 Fish Audio API Key——先在设置里填写", "No Fish Audio API key — add it in Settings first", 400);
  const start = Number(body.start ?? 0);
  const requestedDuration = Number(body.duration ?? ASR_CHUNK_SECONDS);
  if (!Number.isFinite(start) || !Number.isFinite(requestedDuration) || start < 0 || requestedDuration <= 0 || requestedDuration > ASR_CHUNK_SECONDS) {
    return apiError(req, "无效的音频分块范围", "Invalid audio chunk range", 400);
  }

  try {
    const db = getDb();
    const [source] = await db.select().from(mediaSources).where(and(eq(mediaSources.id, mediaId), eq(mediaSources.projectId, id))).limit(1);
    if (!source) return apiError(req, "素材不存在", "Media source not found", 404);
    if (!source.hasAudio) return apiError(req, "这个视频没有可转写的音轨", "This video has no audio track to transcribe", 422);
    const sourceDuration = source.duration / 1000;
    if (start >= sourceDuration) return apiError(req, "音频分块起点超出素材时长", "Audio chunk starts after the media ends", 416);
    const chunk = await transcribeSourceChunk({
      engine,
      inputPath: source.filePath,
      start,
      duration: Math.min(requestedDuration, sourceDuration - start),
      language: typeof body.language === "string" ? body.language : undefined,
      apiKey,
      sourceDuration,
      signal: req.signal,
    });
    return NextResponse.json(chunk);
  } catch (error) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("ASR chunk failed:", error);
    const failure = asrFailure(error);
    return NextResponse.json({ error: errText(req, failure.zh, failure.en), ...(failure.code && { code: failure.code }) }, { status: failure.status });
  }
}

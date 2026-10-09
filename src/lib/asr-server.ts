/**
 * Server-side transcription dispatch shared by the transcript editor's and the remake page's /asr
 * routes: cut one bounded PCM chunk, run it through the chosen engine, and turn engine failures
 * into status + zh/en messages the client can show (and, for a missing local model, act on).
 */
import { extractAsrAudioChunk } from "@/lib/asr-audio-chunk";
import { fishAsrErrorPair, transcribeChunkWithFish } from "@/lib/fish-asr";
import type { ServerAsrEngine } from "@/lib/local-asr";
import { SenseVoiceModelMissingError, transcribeChunkWithSenseVoice } from "@/lib/sensevoice-asr";
import { ASR_CHUNK_SECONDS } from "@/lib/transcript-checkpoint";
import type { TranscriptDocument } from "@/lib/transcript-editor";

export function parseServerAsrEngine(value: unknown): ServerAsrEngine {
  // SenseVoice is the default; Fish only when asked for explicitly
  return value === "fish" ? "fish" : "sensevoice";
}

export async function transcribeSourceChunk(input: {
  engine: ServerAsrEngine;
  inputPath: string;
  start: number;
  duration: number;
  language?: string;
  apiKey?: string;
  sourceDuration?: number;
  signal?: AbortSignal;
}): Promise<TranscriptDocument> {
  const pcm = await extractAsrAudioChunk({ inputPath: input.inputPath, startSeconds: input.start, durationSeconds: input.duration, signal: input.signal });
  const common = {
    pcm,
    language: input.language,
    offsetSeconds: input.start,
    sourceDuration: input.sourceDuration,
    chunkIndex: Math.floor(input.start / ASR_CHUNK_SECONDS),
    signal: input.signal,
  };
  return input.engine === "fish"
    ? transcribeChunkWithFish({ ...common, apiKey: input.apiKey ?? "" })
    : transcribeChunkWithSenseVoice(common);
}

/** Status + user-facing message for a failed chunk. `code: "model_missing"` tells the client to download the model. */
export function asrFailure(error: unknown): { status: number; zh: string; en: string; code?: string } {
  if (error instanceof SenseVoiceModelMissingError) {
    return { status: 409, code: "model_missing", zh: "SenseVoice 模型还没下载——先在设置 → 语音识别里下载（约 240MB）", en: "The SenseVoice model is not downloaded yet — download it under Settings → Speech recognition (~240 MB)" };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/sherpa-onnx|Could not find sherpa/i.test(message)) {
    return { status: 500, zh: `本地识别引擎加载失败（sherpa-onnx）：${message}`, en: `Could not load the local recognizer (sherpa-onnx): ${message}` };
  }
  if (error && typeof error === "object" && (error as { name?: string }).name === "FishAsrError") {
    return { status: 502, ...fishAsrErrorPair(error) };
  }
  return { status: 500, zh: `语音识别失败：${message}`, en: `Speech recognition failed: ${message}` };
}

/**
 * Fish Audio cloud ASR (POST https://api.fish.audio/v1/asr) — the default transcription engine.
 *
 * Why: the in-browser Whisper tiny/base/small models are far too weak on Chinese speech. Fish's
 * transcribe-1-pro handles Mandarin well and returns word-level timestamps, so it drops into the
 * same chunked checkpoint flow as the local worker: the server cuts one bounded PCM chunk,
 * computes silence ranges from it locally, ships it to Fish as 16-bit WAV and maps the reply to
 * a TranscriptDocument chunk with source-time offsets.
 *
 * Request: multipart/form-data, `model` header (exact lowercase id, otherwise Fish silently bills
 * and serves transcribe-1), ignore_timestamps=false to get `segments` (word-level {text,start,end}
 * in seconds). Audio events and speaker diarization are turned off: their inline markers would
 * leak into subtitle text.
 */
import { FISH_ASR_MODEL, FISH_ASR_MODEL_ID } from "@/lib/local-asr";
import { ASR_SAMPLE_RATE } from "@/lib/transcript-checkpoint";
import {
  detectSilenceRanges,
  segmentsFromWords,
  type TranscriptDocument,
  type TranscriptWord,
} from "@/lib/transcript-editor";

export const FISH_ASR_URL = "https://api.fish.audio/v1/asr";

/** Mono float32 PCM → 16-bit PCM WAV (5 min at 16 kHz ≈ 9.6 MB, well inside Fish's limits). */
export function pcmF32ToWav(samples: Float32Array, sampleRate = ASR_SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

export interface FishAsrResponse {
  text?: string;
  duration?: number;
  segments?: Array<{ text?: unknown; start?: unknown; end?: unknown }>;
  language_code?: string;
}

/** Inline markers Fish can emit even with events/diarization off: <|speaker:0|>, [laughter], (笑) cues */
const MARKER_RE = /<\|[^|>]*\|>|\[[^\]]*\]/g;

export function cleanFishText(text: string): string {
  return text.replace(MARKER_RE, " ").replace(/\s+/g, " ").trim();
}

/** Map Fish word-level segments to transcript words, shifted into source time. */
export function wordsFromFishResponse(data: FishAsrResponse, offsetSeconds = 0, chunkIndex = 0): TranscriptWord[] {
  return (data.segments ?? []).flatMap((segment, index) => {
    const text = cleanFishText(String(segment.text ?? ""));
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return [{ id: `c${chunkIndex + 1}w${index + 1}`, text, start: Math.max(0, start + offsetSeconds), end: Math.max(0, end + offsetSeconds) }];
  });
}

export class FishAsrError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "FishAsrError";
  }
}

/** Transcribe one PCM chunk (f32le @ 16 kHz, as cut by extractAsrAudioChunk) with Fish. */
export async function transcribeChunkWithFish(input: {
  pcm: Buffer;
  apiKey: string;
  language?: string;
  offsetSeconds?: number;
  sourceDuration?: number;
  chunkIndex?: number;
  signal?: AbortSignal;
}): Promise<TranscriptDocument> {
  const samples = new Float32Array(input.pcm.buffer.slice(input.pcm.byteOffset, input.pcm.byteOffset + input.pcm.byteLength));
  const offsetSeconds = Math.max(0, input.offsetSeconds ?? 0);
  const chunkIndex = Math.max(0, Math.round(input.chunkIndex ?? 0));
  const language = input.language && input.language !== "auto" ? input.language : "";

  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(pcmF32ToWav(samples))], { type: "audio/wav" }), "chunk.wav");
  if (language) form.append("language", language);
  form.append("ignore_timestamps", "false");
  form.append("tag_audio_events", "false");
  form.append("diarize", "false");

  const res = await fetch(FISH_ASR_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, model: FISH_ASR_MODEL },
    body: form,
    signal: input.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new FishAsrError(`Fish ASR ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`, res.status);
  }
  const data = (await res.json()) as FishAsrResponse;
  const words = wordsFromFishResponse(data, offsetSeconds, chunkIndex);
  const chunkDuration = samples.length / ASR_SAMPLE_RATE;
  return {
    version: 1,
    text: cleanFishText(data.text ?? "") || segmentsFromWords(words).map((s) => s.text).join(" "),
    language: language || data.language_code || "auto",
    duration: Math.max(offsetSeconds + chunkDuration, input.sourceDuration ?? 0),
    model: FISH_ASR_MODEL_ID,
    device: "cloud",
    words,
    segments: segmentsFromWords(words),
    silenceRanges: detectSilenceRanges(samples, ASR_SAMPLE_RATE).map((r) => ({ start: r.start + offsetSeconds, end: r.end + offsetSeconds })),
    createdAt: new Date().toISOString(),
  };
}

/** User-facing zh/en message for a failed Fish call (bad key, no balance, oversized audio…). */
export function fishAsrErrorPair(error: unknown): { zh: string; en: string } {
  if (error instanceof FishAsrError) {
    if (error.status === 401 || error.status === 403) return { zh: "Fish Audio API Key 无效或无权限，请在设置里检查", en: "Fish Audio rejected the API key — check it in Settings" };
    if (error.status === 402) return { zh: "Fish Audio 账户余额不足", en: "Fish Audio account balance is insufficient" };
    if (error.status === 413) return { zh: "音频分块过大，Fish Audio 拒收", en: "The audio chunk is too large for Fish Audio" };
    if (error.status === 429) return { zh: "Fish Audio 请求过于频繁，请稍后重试", en: "Fish Audio rate limit hit — retry in a moment" };
    return { zh: `Fish Audio 转写失败：${error.message}`, en: `Fish Audio transcription failed: ${error.message}` };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { zh: `云端转写失败：${message}`, en: `Cloud transcription failed: ${message}` };
}

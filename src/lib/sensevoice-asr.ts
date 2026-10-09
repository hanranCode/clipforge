/**
 * SenseVoice-Small (FunAudioLLM / 阿里 FunASR family) on the local CPU via sherpa-onnx — the default
 * transcription engine. Free, offline, and far more accurate on Chinese than the in-browser
 * Whisper models; on an M-series CPU a 5-minute chunk decodes in a few seconds.
 *
 * SenseVoice is a non-streaming model built for utterances up to ~30 s, so each PCM chunk is first
 * split by silero VAD into speech segments (≤ 20 s), each segment is decoded, and the per-token
 * timestamps are mapped back into source time. Tokens give start times only; a word ends where the
 * next one starts, capped so a word never swallows the pause after it (the word editor cuts on
 * these boundaries).
 *
 * The native addon is loaded lazily (serverExternalPackages keeps it out of the bundle) and the
 * recognizer is cached on globalThis, so the ~0.5 s model load happens once per server process.
 */
import { senseVoiceModelPaths, isSenseVoiceModelReady } from "@/lib/sensevoice-model";
import { SENSEVOICE_MODEL_ID } from "@/lib/local-asr";
import { ASR_SAMPLE_RATE } from "@/lib/transcript-checkpoint";
import {
  detectSilenceRanges,
  segmentsFromWords,
  type TranscriptDocument,
  type TranscriptWord,
} from "@/lib/transcript-editor";

/** Longest a single token/word may last when the next token is far away */
const MAX_WORD_SECONDS = 0.6;
const MIN_WORD_SECONDS = 0.04;
/** silero VAD window for 16 kHz audio */
const VAD_WINDOW = 512;

// ---- minimal typings for the parts of sherpa-onnx-node we use (the package ships JSDoc only) ----
interface SherpaResult { lang: string; text: string; tokens: string[]; timestamps: number[] }
interface SherpaStream { acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void }
interface SherpaRecognizer { createStream(): SherpaStream; decodeAsync(stream: SherpaStream): Promise<unknown>; getResult(stream: SherpaStream): SherpaResult }
interface SherpaVad { acceptWaveform(samples: Float32Array): void; isEmpty(): boolean; front(enableExternalBuffer?: boolean): { samples: Float32Array; start: number }; pop(): void; flush(): void }
interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad;
}

export class SenseVoiceModelMissingError extends Error {
  constructor() {
    super("SenseVoice model is not downloaded");
    this.name = "SenseVoiceModelMissingError";
  }
}

const registry = globalThis as typeof globalThis & {
  clipforgeSenseVoice?: Map<string, Promise<SherpaRecognizer>>;
  clipforgeSenseVoiceQueue?: Promise<unknown>;
};

async function loadSherpa(): Promise<SherpaModule> {
  const mod = (await import("sherpa-onnx-node")) as unknown as SherpaModule & { default?: SherpaModule };
  return mod.OfflineRecognizer ? mod : (mod.default as SherpaModule);
}

/** SenseVoice language hint: auto-detect unless the user pinned zh / en / ja / ko / yue. */
export function senseVoiceLanguage(language?: string): string {
  return language && ["zh", "en", "ja", "ko", "yue"].includes(language) ? language : "auto";
}

function recognizer(language: string): Promise<SherpaRecognizer> {
  const cache = (registry.clipforgeSenseVoice ??= new Map());
  let pending = cache.get(language);
  if (!pending) {
    pending = (async () => {
      const sherpa = await loadSherpa();
      const paths = senseVoiceModelPaths();
      return new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: ASR_SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: paths.model, language, useInverseTextNormalization: 1 },
          tokens: paths.tokens,
          numThreads: 4,
          provider: "cpu",
          debug: 0,
        },
      });
    })();
    pending.catch(() => cache.delete(language));
    cache.set(language, pending);
  }
  return pending;
}

/** One decode at a time per process: parallel chunk requests would just fight over the same CPU cores. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = (registry.clipforgeSenseVoiceQueue ?? Promise.resolve()).then(task, task);
  registry.clipforgeSenseVoiceQueue = run.catch(() => undefined);
  return run;
}

const CJK_RE = /[㐀-鿿぀-ヿ가-힯豈-﫿]/;
const PUNCT_ONLY_RE = /^[\s\p{P}\p{S}]+$/u;

/**
 * Turn SenseVoice tokens (CJK characters, SentencePiece pieces where a leading space / ▁ starts a
 * new English word, standalone punctuation) into transcript words. Punctuation is glued onto the
 * preceding word so sentence-end detection in segmentsFromWords keeps working.
 */
export function wordsFromSenseVoiceTokens(input: {
  tokens: string[];
  timestamps: number[];
  /** Segment start / end in source seconds */
  segmentStart: number;
  segmentEnd: number;
  idPrefix: string;
}): TranscriptWord[] {
  const built: Array<{ text: string; start: number; lastTokenAt: number }> = [];
  input.tokens.forEach((token, index) => {
    const at = input.segmentStart + (Number(input.timestamps[index]) || 0);
    const raw = token.replace(/▁/g, " ");
    const text = raw.trim();
    if (!text) return;
    const last = built.at(-1);
    if (PUNCT_ONLY_RE.test(text)) {
      if (last) last.text += text;
      return;
    }
    const continues = last
      && !raw.startsWith(" ")
      && !CJK_RE.test(text)
      && !CJK_RE.test(last.text.slice(-1))
      && !/[\p{P}]$/u.test(last.text);
    if (continues) {
      last.text += text;
      last.lastTokenAt = at;
    } else {
      built.push({ text, start: at, lastTokenAt: at });
    }
  });
  return built.map((word, index) => {
    const next = built[index + 1]?.start ?? input.segmentEnd;
    const end = Math.max(word.start + MIN_WORD_SECONDS, Math.min(next, word.lastTokenAt + MAX_WORD_SECONDS));
    return { id: `${input.idPrefix}w${index + 1}`, text: word.text, start: word.start, end };
  });
}

/** Split a mono 16 kHz chunk into speech segments with silero VAD. */
function speechSegments(sherpa: SherpaModule, samples: Float32Array): Array<{ start: number; samples: Float32Array }> {
  const vad = new sherpa.Vad({
    sileroVad: { model: senseVoiceModelPaths().vad, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.4, maxSpeechDuration: 20, windowSize: VAD_WINDOW },
    sampleRate: ASR_SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  }, Math.ceil(samples.length / ASR_SAMPLE_RATE) + 30);
  const out: Array<{ start: number; samples: Float32Array }> = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      out.push({ start: segment.start, samples: Float32Array.from(segment.samples) });
      vad.pop();
    }
  };
  for (let offset = 0; offset < samples.length; offset += VAD_WINDOW) {
    const window = samples.subarray(offset, offset + VAD_WINDOW);
    vad.acceptWaveform(window.length === VAD_WINDOW ? window : Float32Array.from({ length: VAD_WINDOW }, (_, i) => window[i] ?? 0));
    drain();
  }
  vad.flush();
  drain();
  return out;
}

/** Transcribe one PCM chunk (f32le @ 16 kHz, as cut by extractAsrAudioChunk) with SenseVoice. */
export async function transcribeChunkWithSenseVoice(input: {
  pcm: Buffer;
  language?: string;
  offsetSeconds?: number;
  sourceDuration?: number;
  chunkIndex?: number;
  signal?: AbortSignal;
}): Promise<TranscriptDocument> {
  if (!(await isSenseVoiceModelReady())) throw new SenseVoiceModelMissingError();
  const samples = new Float32Array(input.pcm.buffer.slice(input.pcm.byteOffset, input.pcm.byteOffset + input.pcm.byteLength));
  const offsetSeconds = Math.max(0, input.offsetSeconds ?? 0);
  const chunkIndex = Math.max(0, Math.round(input.chunkIndex ?? 0));
  const language = senseVoiceLanguage(input.language);

  const { words, texts, detected } = await serialized(async () => {
    const sherpa = await loadSherpa();
    const asr = await recognizer(language);
    const words: TranscriptWord[] = [];
    const texts: string[] = [];
    const langs = new Map<string, number>();
    const segments = speechSegments(sherpa, samples);
    for (const [index, segment] of segments.entries()) {
      input.signal?.throwIfAborted();
      const stream = asr.createStream();
      stream.acceptWaveform({ samples: segment.samples, sampleRate: ASR_SAMPLE_RATE });
      await asr.decodeAsync(stream);
      const result = asr.getResult(stream);
      const segmentStart = offsetSeconds + segment.start / ASR_SAMPLE_RATE;
      const segmentEnd = segmentStart + segment.samples.length / ASR_SAMPLE_RATE;
      words.push(...wordsFromSenseVoiceTokens({
        tokens: result.tokens ?? [],
        timestamps: result.timestamps ?? [],
        segmentStart,
        segmentEnd,
        idPrefix: `c${chunkIndex + 1}s${index + 1}`,
      }));
      if (result.text?.trim()) texts.push(result.text.trim());
      const lang = (result.lang ?? "").replace(/[<|>]/g, "");
      if (lang) langs.set(lang, (langs.get(lang) ?? 0) + segment.samples.length);
    }
    const detected = [...langs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { words, texts, detected };
  });

  const chunkDuration = samples.length / ASR_SAMPLE_RATE;
  const cjk = texts.some((text) => CJK_RE.test(text));
  return {
    version: 1,
    text: texts.join(cjk ? "" : " "),
    language: language !== "auto" ? language : detected || "auto",
    duration: Math.max(offsetSeconds + chunkDuration, input.sourceDuration ?? 0),
    model: SENSEVOICE_MODEL_ID,
    device: "cpu",
    words,
    segments: segmentsFromWords(words),
    silenceRanges: detectSilenceRanges(samples, ASR_SAMPLE_RATE).map((r) => ({ start: r.start + offsetSeconds, end: r.end + offsetSeconds })),
    createdAt: new Date().toISOString(),
  };
}

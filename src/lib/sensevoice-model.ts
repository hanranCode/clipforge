/**
 * SenseVoice-Small model files: where they live, whether they are present, and a one-shot
 * background download with progress.
 *
 * The weights (~240 MB int8) are too large to ship in the repo or the installer, so they are
 * fetched on first use into <data>/models/. hf-mirror.com goes first because huggingface.co is
 * often unreachable from mainland China; every file has a second source.
 *
 * Model choice: the official FunAudioLLM SenseVoiceSmall export (2024-07-17). The newer
 * "2025-09-09" sherpa-onnx package is a Cantonese fine-tune (WSYue) — it tags Mandarin as yue,
 * drops punctuation and spells English letter by letter, so it is deliberately not used.
 */
import { createWriteStream } from "fs";
import { mkdir, rename, rm, stat } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { getDataDir } from "@/lib/paths";

const REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";

export const SENSEVOICE_FILES = [
  {
    name: "model.int8.onnx",
    bytes: 239_233_841,
    urls: [`https://hf-mirror.com/${REPO}/resolve/main/model.int8.onnx`, `https://huggingface.co/${REPO}/resolve/main/model.int8.onnx`],
  },
  {
    name: "tokens.txt",
    bytes: 315_894,
    urls: [`https://huggingface.co/${REPO}/resolve/main/tokens.txt`, `https://hf-mirror.com/${REPO}/resolve/main/tokens.txt`],
  },
  {
    name: "silero_vad.onnx",
    bytes: 643_854,
    urls: [
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
      "https://hf-mirror.com/csukuangfj/vad/resolve/main/silero_vad.onnx",
    ],
  },
] as const;

export const SENSEVOICE_TOTAL_BYTES = SENSEVOICE_FILES.reduce((sum, file) => sum + file.bytes, 0);

export function senseVoiceModelDir(): string {
  return join(getDataDir(), "models", "sensevoice-small-int8-2024-07-17");
}

export function senseVoiceModelPaths() {
  const dir = senseVoiceModelDir();
  return { model: join(dir, "model.int8.onnx"), tokens: join(dir, "tokens.txt"), vad: join(dir, "silero_vad.onnx") };
}

export interface SenseVoiceModelStatus {
  state: "missing" | "downloading" | "ready" | "error";
  receivedBytes: number;
  totalBytes: number;
  error?: string;
}

const registry = globalThis as typeof globalThis & {
  clipforgeSenseVoiceDownload?: { promise: Promise<void>; receivedBytes: number; error?: string };
};

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** All three files present and non-empty (a .part rename only happens after a complete download). */
export async function isSenseVoiceModelReady(): Promise<boolean> {
  const dir = senseVoiceModelDir();
  const sizes = await Promise.all(SENSEVOICE_FILES.map((file) => fileSize(join(dir, file.name))));
  return sizes.every((size) => size > 0);
}

export async function senseVoiceModelStatus(): Promise<SenseVoiceModelStatus> {
  const job = registry.clipforgeSenseVoiceDownload;
  if (job && !job.error) return { state: "downloading", receivedBytes: job.receivedBytes, totalBytes: SENSEVOICE_TOTAL_BYTES };
  if (await isSenseVoiceModelReady()) return { state: "ready", receivedBytes: SENSEVOICE_TOTAL_BYTES, totalBytes: SENSEVOICE_TOTAL_BYTES };
  if (job?.error) return { state: "error", receivedBytes: job.receivedBytes, totalBytes: SENSEVOICE_TOTAL_BYTES, error: job.error };
  return { state: "missing", receivedBytes: 0, totalBytes: SENSEVOICE_TOTAL_BYTES };
}

async function downloadOne(url: string, target: string, onBytes: (n: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  const part = `${target}.part`;
  const counter = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  counter.on("data", (chunk: Buffer) => onBytes(chunk.length));
  try {
    await pipeline(counter, createWriteStream(part));
    const expected = Number(res.headers.get("content-length"));
    const got = await fileSize(part);
    if (Number.isFinite(expected) && expected > 0 && got !== expected) throw new Error(`incomplete download (${got}/${expected}) ${url}`);
    if (got === 0) throw new Error(`empty download ${url}`);
    await rename(part, target);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

/**
 * Start (or join) the background download. Returns immediately; poll senseVoiceModelStatus().
 * Files already on disk are skipped, so a failed run resumes at file granularity.
 */
export function startSenseVoiceDownload(): void {
  const current = registry.clipforgeSenseVoiceDownload;
  if (current && !current.error) return;
  const job: { promise: Promise<void>; receivedBytes: number; error?: string } = { promise: Promise.resolve(), receivedBytes: 0 };
  registry.clipforgeSenseVoiceDownload = job;
  job.promise = (async () => {
    const dir = senseVoiceModelDir();
    await mkdir(dir, { recursive: true });
    for (const file of SENSEVOICE_FILES) {
      const target = join(dir, file.name);
      if ((await fileSize(target)) > 0) {
        job.receivedBytes += file.bytes;
        continue;
      }
      const errors: string[] = [];
      let done = false;
      for (const url of file.urls) {
        const before = job.receivedBytes;
        try {
          await downloadOne(url, target, (n) => { job.receivedBytes += n; });
          job.receivedBytes = before + file.bytes;
          done = true;
          break;
        } catch (error) {
          job.receivedBytes = before;
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (!done) throw new Error(`${file.name}: ${errors.join("; ")}`);
    }
  })().then(
    () => { if (registry.clipforgeSenseVoiceDownload === job) registry.clipforgeSenseVoiceDownload = undefined; },
    (error) => { job.error = error instanceof Error ? error.message : String(error); },
  );
}

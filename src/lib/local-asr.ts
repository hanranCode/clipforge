import type { TranscriptDocument } from "@/lib/transcript-editor";

export const LOCAL_ASR_MODELS = [
  {
    id: "onnx-community/whisper-tiny_timestamped",
    label: "Tiny",
    description: "速度优先，适合先跑通和较短素材",
  },
  {
    id: "onnx-community/whisper-base_timestamped",
    label: "Base",
    description: "更大容量，下载与转写耗时更长",
  },
  {
    id: "onnx-community/whisper-small_timestamped",
    label: "Small",
    description: "更大容量的本地候选，需要更多内存；按样本评测后选用",
  },
] as const;

export type LocalAsrModel = (typeof LOCAL_ASR_MODELS)[number]["id"];
export type LocalAsrDevice = "webgpu" | "wasm";

export function isLocalAsrModel(value: unknown): value is LocalAsrModel {
  return LOCAL_ASR_MODELS.some((model) => model.id === value);
}

/** Fish Audio cloud ASR (server-side, see src/lib/fish-asr.ts) — far better on Chinese than local Whisper */
export const FISH_ASR_MODEL = "transcribe-1-pro";
/** Transcript model id stored on media sources / checkpoints for Fish runs */
export const FISH_ASR_MODEL_ID = `fish:${FISH_ASR_MODEL}`;

export function isFishAsrModel(value: unknown): value is typeof FISH_ASR_MODEL_ID {
  return value === FISH_ASR_MODEL_ID;
}

/** SenseVoice-Small via sherpa-onnx on the server CPU (see src/lib/sensevoice-asr.ts) — the default engine */
export const SENSEVOICE_MODEL_ID = "sensevoice:small-int8-2024-07-17";

export function isSenseVoiceModel(value: unknown): value is typeof SENSEVOICE_MODEL_ID {
  return value === SENSEVOICE_MODEL_ID;
}

export type AsrModelId = LocalAsrModel | typeof FISH_ASR_MODEL_ID | typeof SENSEVOICE_MODEL_ID;
/** Engines that run in the Next server (the browser only posts chunk ranges to /asr routes) */
export type ServerAsrEngine = "sensevoice" | "fish";

/** Every transcript engine the editor accepts: SenseVoice, Fish cloud ASR and the in-browser Whisper models */
export function isAsrModel(value: unknown): value is AsrModelId {
  return isLocalAsrModel(value) || isFishAsrModel(value) || isSenseVoiceModel(value);
}

export function serverAsrEngine(model: AsrModelId): ServerAsrEngine | null {
  return isSenseVoiceModel(model) ? "sensevoice" : isFishAsrModel(model) ? "fish" : null;
}
export interface AsrWorkerRequest {
  type: "transcribe";
  audio: Float32Array;
  model: LocalAsrModel;
  language: string;
  preferWebGpu: boolean;
  offsetSeconds?: number;
  sourceDuration?: number;
  chunkIndex?: number;
}

export type AsrWorkerMessage =
  | { type: "device"; device: LocalAsrDevice; fallback?: boolean }
  | { type: "progress"; phase: "loading" | "transcribing"; progress: number; detail?: string }
  | { type: "complete"; transcript: TranscriptDocument }
  | { type: "error"; error: string };

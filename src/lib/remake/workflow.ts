import { getVideoParamSpec } from "@/lib/providers/atlas-video-params";
import { ARK_REMAKE_MODELS, DEFAULT_REMAKE_MODEL, isWanRemakeModel, remakeEditParams, remakeProviderForModel, resolveRemakeChoice } from "./model";

/** Parameters saved independently for each reviewed segment. */
export interface SegmentSettings {
  /** Absent in legacy Atlas drafts. */
  provider?: string;
  model: string;
  prompt: string;
  resolution: string;
  generate_audio: boolean;
  watermark: boolean;
  return_last_frame: boolean;
  output_format: "mp4" | "mov";
  draft: boolean;
  useSourceAudio: boolean;
}

export function defaultSegmentSettings(model: string = DEFAULT_REMAKE_MODEL, provider?: string): SegmentSettings {
  const choice = resolveRemakeChoice(model, provider);
  if (choice.provider === "litforge") return { provider: choice.provider, model: choice.model, prompt: "", resolution: "480p", generate_audio: false, watermark: false, return_last_frame: false, output_format: "mp4", draft: false, useSourceAudio: false };
  return { model: choice.model, ...(choice.provider !== "atlas-cloud" && { provider: choice.provider }), prompt: "", resolution: "480p", generate_audio: true,
    watermark: false, return_last_frame: false, output_format: "mp4", draft: false, useSourceAudio: true };
}

export function remakeResolutions(model: string): readonly string[] {
  if (remakeProviderForModel(model) === "litforge") return ["480p"];
  if (remakeProviderForModel(model) === "alibaba") return ["480p", "720p", "1080p"];
  if (remakeProviderForModel(model) === "volcengine") {
    if (model === ARK_REMAKE_MODELS[2]) return ["480p", "720p"];
    return model === ARK_REMAKE_MODELS[1] ? ["480p", "720p", "1080p", "4k"] : ["480p", "720p", "1080p"];
  }
  return getVideoParamSpec(model)?.resolutionEnum ?? [];
}

/** Allow only documented controls; framing and task type remain valid edit constraints. */
export function segmentEditParams(model: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  if (remakeProviderForModel(model) === "litforge") {
    if (input.resolution !== undefined && input.resolution !== "480p") throw new Error("INVALID_RESOLUTION");
    return { resolution: "480p" };
  }
  const isBailian = remakeProviderForModel(model) === "alibaba";
  const out: Record<string, unknown> = { ...remakeEditParams(model), resolution: isBailian ? "480P" : "480p" };
  if (input.resolution !== undefined) {
    if (typeof input.resolution !== "string" || !remakeResolutions(model).includes(isBailian ? input.resolution.toLowerCase() : input.resolution)) throw new Error("INVALID_RESOLUTION");
    out.resolution = isBailian ? input.resolution.toUpperCase() : input.resolution;
  }
  for (const key of ["generate_audio", "watermark"]) {
    if (key === "watermark" && isWanRemakeModel(model) && !isBailian) continue;
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new Error(`INVALID_${key.toUpperCase()}`);
      out[key === "generate_audio" && isWanRemakeModel(model) ? "audio" : key] = input[key];
    }
  }
  // The client sends the normalized Atlas body back as extra; preserve audio=false too.
  if (isWanRemakeModel(model) && input.audio !== undefined) {
    if (typeof input.audio !== "boolean") throw new Error("INVALID_AUDIO");
    out.audio = input.audio;
  }
  if (isBailian) out.prompt_extend = true;
  if (model === DEFAULT_REMAKE_MODEL) {
    for (const key of ["return_last_frame", "draft"]) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== "boolean") throw new Error(`INVALID_${key.toUpperCase()}`);
        out[key] = input[key];
      }
    }
    if (input.output_format !== undefined) {
      if (input.output_format !== "mp4" && input.output_format !== "mov") throw new Error("INVALID_OUTPUT_FORMAT");
      out.output_format = input.output_format;
    }
  }
  if (remakeProviderForModel(model) === "volcengine") {
    if (input.return_last_frame !== undefined) {
      if (typeof input.return_last_frame !== "boolean") throw new Error("INVALID_RETURN_LAST_FRAME");
      out.return_last_frame = input.return_last_frame;
    }
  }
  return out;
}

/** Assemble at the lowest selected native tier; source geometry only determines aspect ratio. */
export function remakeOutputSize(width: number, height: number, resolutions: unknown = ["480p"]): { width: number; height: number } {
  if (!Array.isArray(resolutions) || !resolutions.length || !resolutions.every(r => typeof r === "string" && /^(480p|720p|1080p|1440p|4k)(?:$|[- &])/i.test(r))) throw new Error("INVALID_RESOLUTION");
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error("INVALID_DIMENSIONS");
  const short = Math.min(...resolutions.map((r: string) => /^4k/i.test(r) ? 2160 : parseInt(r, 10)));
  const factor = short / Math.min(width, height);
  return { width: Math.max(2, Math.round(width * factor / 2) * 2), height: Math.max(2, Math.round(height * factor / 2) * 2) };
}

export interface ReviewRun {
  status: string;
  path?: string;
  key?: string;
  approved?: boolean;
}

export function isSegmentApproved(run: ReviewRun | undefined, key: string): boolean {
  return Boolean(run?.path && run.approved && run.key === key && ["done", "skipped"].includes(run.status));
}

/** The first unapproved or changed segment is the gate for every later paid request. */
export function firstUnapprovedSegment(keys: string[], runs: Record<number, ReviewRun>): number {
  const index = keys.findIndex((key, i) => !isSegmentApproved(runs[i], key));
  return index < 0 ? keys.length : index;
}

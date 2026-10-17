import { getVideoParamSpec } from "@/lib/providers/atlas-video-params";
import { DEFAULT_REMAKE_MODEL, isWanRemakeModel, remakeEditParams, resolveRemakeModel } from "./model";

/** Parameters saved independently for each reviewed segment. */
export interface SegmentSettings {
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

export function defaultSegmentSettings(model: string = DEFAULT_REMAKE_MODEL): SegmentSettings {
  return { model: resolveRemakeModel(model), prompt: "", resolution: "720p", generate_audio: true,
    watermark: false, return_last_frame: false, output_format: "mp4", draft: false, useSourceAudio: true };
}

/** Allow only documented controls; framing and task type remain valid edit constraints. */
export function segmentEditParams(model: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  const out = remakeEditParams(model);
  const spec = getVideoParamSpec(model);
  if (input.resolution !== undefined) {
    if (typeof input.resolution !== "string" || !spec?.resolutionEnum?.includes(input.resolution)) throw new Error("INVALID_RESOLUTION");
    out.resolution = input.resolution;
  }
  for (const key of ["generate_audio", "watermark"]) {
    if (key === "watermark" && isWanRemakeModel(model)) continue;
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
  return out;
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

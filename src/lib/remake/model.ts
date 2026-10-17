/** Atlas Cloud reference endpoints supported by the video-remake workflow. */
export const REMAKE_PROVIDER = "atlas-cloud";
export const REMAKE_MODELS = [
  "bytedance/seedance-2.5/reference-to-video",
  "bytedance/seedance-2.0/reference-to-video",
  "alibaba/wan-3.0/reference-to-video",
  "alibaba/wan-3.0-prime/reference-to-video",
] as const;
export const DEFAULT_REMAKE_MODEL = REMAKE_MODELS[0];

export function isWanRemakeModel(model: string): boolean {
  return model === REMAKE_MODELS[2] || model === REMAKE_MODELS[3];
}

export function remakeMaxImages(model: string): number {
  return model === DEFAULT_REMAKE_MODEL ? 30 : isWanRemakeModel(model) ? 10 : 9;
}

export function remakeMaxAudios(model: string): number {
  return isWanRemakeModel(model) ? 5 : 10;
}

export function isRemakeModel(provider: string, model: string): boolean {
  return provider === REMAKE_PROVIDER && (REMAKE_MODELS as readonly string[]).includes(model);
}

/** Old platform/model choices fall back to 2.5 rather than submitting to another platform. */
export function resolveRemakeModel(model: string | undefined): string {
  return model && isRemakeModel(REMAKE_PROVIDER, model) ? model : DEFAULT_REMAKE_MODEL;
}

/** Seedance follows the reference clip; Wan uses smart duration and adaptive framing. */
export function remakeEditParams(model: string): Record<string, unknown> {
  return {
    duration: -1,
    ratio: "adaptive",
    ...(model === DEFAULT_REMAKE_MODEL && { omni_reference_task_type: "edit" }),
  };
}

/** Atlas addresses references with @ImageN / @VideoN / @AudioN; accept old draft notation. */
export function normalizeRemakePrompt(prompt: string): string {
  return prompt.replace(/@图片(\d+)/g, "@Image$1").replace(/@视频(\d+)/g, "@Video$1").replace(/@音频(\d+)/g, "@Audio$1");
}

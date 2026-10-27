/** Only provider/model pairs with a verified video-edit request contract belong here. */
export const REMAKE_PROVIDER = "atlas-cloud";
export const REMAKE_MODELS = [
  "bytedance/seedance-2.5/reference-to-video",
  "bytedance/seedance-2.0/reference-to-video",
  "alibaba/wan-3.0/reference-to-video",
  "alibaba/wan-3.0-prime/reference-to-video",
] as const;
export const DEFAULT_REMAKE_MODEL = REMAKE_MODELS[0];
export const ARK_REMAKE_MODELS = ["doubao-seedance-2-5-260628", "doubao-seedance-2-0-260128", "doubao-seedance-2-0-mini-260615"] as const;
export const BAILIAN_REMAKE_MODELS = ["wan3.0-video", "wan3.0-video-prime"] as const;
export const REMAKE_PROVIDERS = [REMAKE_PROVIDER, "volcengine", "alibaba"] as const;

export function remakeModelsFor(provider: string): readonly string[] {
  return provider === REMAKE_PROVIDER ? REMAKE_MODELS : provider === "volcengine" ? ARK_REMAKE_MODELS : provider === "alibaba" ? BAILIAN_REMAKE_MODELS : [];
}

/** Infer the provider only for legacy choices/drafts that did not store one. */
export function remakeProviderForModel(model: string): string {
  if ((BAILIAN_REMAKE_MODELS as readonly string[]).includes(model)) return "alibaba";
  return (ARK_REMAKE_MODELS as readonly string[]).includes(model) ? "volcengine" : REMAKE_PROVIDER;
}

export function resolveRemakeChoice(model: string | undefined, provider?: string): { provider: string; model: string } {
  const selectedProvider = provider || remakeProviderForModel(model ?? "");
  return model && isRemakeModel(selectedProvider, model)
    ? { provider: selectedProvider, model }
    : { provider: REMAKE_PROVIDER, model: DEFAULT_REMAKE_MODEL };
}

export function isWanRemakeModel(model: string): boolean {
  return model === REMAKE_MODELS[2] || model === REMAKE_MODELS[3] || (BAILIAN_REMAKE_MODELS as readonly string[]).includes(model);
}

export function remakeMaxImages(model: string): number {
  return model === DEFAULT_REMAKE_MODEL ? 30 : isWanRemakeModel(model) ? 10 : 9;
}

export function remakeMaxAudios(model: string): number {
  if (remakeProviderForModel(model) === "volcengine") return 3;
  return isWanRemakeModel(model) ? 5 : 10;
}

export function isRemakeModel(provider: string, model: string): boolean {
  return remakeModelsFor(provider).includes(model);
}

/** Unknown legacy model IDs retain the Atlas default. */
export function resolveRemakeModel(model: string | undefined): string {
  return resolveRemakeChoice(model).model;
}

/** Seedance follows the reference clip; Wan uses smart duration and adaptive framing. */
export function remakeEditParams(model: string): Record<string, unknown> {
  return {
    duration: -1,
    ratio: "adaptive",
    ...((model === DEFAULT_REMAKE_MODEL || model === ARK_REMAKE_MODELS[0]) && { omni_reference_task_type: "edit" }),
  };
}

/** Atlas addresses references with @ImageN / @VideoN / @AudioN; accept old draft notation. */
export function normalizeRemakePrompt(prompt: string): string {
  return prompt.replace(/@图片(\d+)/g, "@Image$1").replace(/@视频(\d+)/g, "@Video$1").replace(/@音频(\d+)/g, "@Audio$1");
}

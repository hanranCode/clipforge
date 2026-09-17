import type { GenMediaType } from "@/lib/gen-params";

/**
 * Per-application model slots.
 *
 * One "default image model" + one "default video model" forced every node onto the same
 * (often the priciest) model: a creator who wants the flagship for reference-to-video but a
 * cheap model for plain keyframes had no way to say so. Each slot below names ONE real call
 * site; an empty slot follows the media type's default, so existing installs keep working
 * unchanged and the defaults stay the one-click path.
 */
export type ModelUsage =
  /** assets: plain keyframe per shot (text-to-image) */
  | "textToImage"
  /** assets: product-fidelity redraw + storyboard grid anchored on presenter/product refs */
  | "referenceImage"
  /** assets: per-shot motion from the keyframe (image-to-video) */
  | "imageToVideo"
  /** assets / script: every keyframe rides one reference-to-video film call */
  | "referenceVideo"
  /** presenters: the 2x2 turnaround sheet generated from an appearance description */
  | "characterSheet"
  /** clone: model-tier one-shot replication of the reference video */
  | "cloneReplicate";

export type ModelUsageStage = "assets" | "presenters" | "clone";

export interface ModelUsageDef {
  id: ModelUsage;
  mediaType: GenMediaType;
  stage: ModelUsageStage;
}

/** Display order: grouped by stage, image before video within a stage */
export const MODEL_USAGES: readonly ModelUsageDef[] = [
  { id: "textToImage", mediaType: "image", stage: "assets" },
  { id: "referenceImage", mediaType: "image", stage: "assets" },
  { id: "imageToVideo", mediaType: "video", stage: "assets" },
  { id: "referenceVideo", mediaType: "video", stage: "assets" },
  { id: "characterSheet", mediaType: "image", stage: "presenters" },
  { id: "cloneReplicate", mediaType: "video", stage: "clone" },
];

export const MODEL_USAGE_STAGES: readonly ModelUsageStage[] = ["assets", "presenters", "clone"];

/**
 * A slot's own choice. The provider is stored with the model because a model id alone is not
 * unique across platforms — the same id served by two enabled platforms would otherwise bill
 * whichever the catalog happened to list first. An empty provider matches by id only (legacy).
 */
export interface UsageModelChoice {
  provider: string;
  model: string;
}

/** Legacy entries (a bare model id string) are still read; writes always use the object form */
export type UsageModels = Partial<Record<ModelUsage, UsageModelChoice | string>>;

export interface UsageModelSource {
  defaultImageModel: string;
  defaultVideoModel: string;
  /** "" = not pinned: the default model is matched by id on any enabled platform */
  defaultImageProvider?: string;
  defaultVideoProvider?: string;
  usageModels?: UsageModels;
}

export function modelUsageDef(usage: ModelUsage): ModelUsageDef {
  return MODEL_USAGES.find((u) => u.id === usage)!;
}

/** The slot's own choice, normalised; null when the slot follows the default */
export function usageChoice(source: Pick<UsageModelSource, "usageModels">, usage: ModelUsage): UsageModelChoice | null {
  const raw = source.usageModels?.[usage];
  const choice = typeof raw === "string" ? { provider: "", model: raw } : raw;
  const model = choice?.model?.trim();
  return model ? { provider: choice?.provider?.trim() ?? "", model } : null;
}

/** The model a call site should bill against: its own slot if set, else the media type's default */
export function modelForUsage(source: UsageModelSource, usage: ModelUsage): string {
  const own = usageChoice(source, usage);
  if (own) return own.model;
  return modelUsageDef(usage).mediaType === "image" ? source.defaultImageModel : source.defaultVideoModel;
}

/** The platform pinned for that model ("" = match the model id on any enabled platform) */
export function providerForUsage(source: UsageModelSource, usage: ModelUsage): string {
  const own = usageChoice(source, usage);
  if (own) return own.provider;
  return (modelUsageDef(usage).mediaType === "image" ? source.defaultImageProvider : source.defaultVideoProvider) ?? "";
}

/** Whether the slot carries its own model (false = follows the default) */
export function hasUsageOverride(source: Pick<UsageModelSource, "usageModels">, usage: ModelUsage): boolean {
  return usageChoice(source, usage) !== null;
}

/** Set or clear (null / empty model) one slot; returns a new map without empty entries */
export function withUsageModel(current: UsageModels | undefined, usage: ModelUsage, choice: UsageModelChoice | null): UsageModels {
  const next: UsageModels = { ...(current ?? {}) };
  const model = choice?.model.trim();
  if (choice && model) next[usage] = { provider: choice.provider.trim(), model };
  else delete next[usage];
  return next;
}

/**
 * Find the catalog entry a (provider, model) pair points at. A pinned provider must match;
 * an unpinned one takes the first entry with that id, which is how every install worked before.
 */
export function findModelFor<T extends { id: string; provider: string }>(models: readonly T[], modelId: string, provider?: string): T | undefined {
  if (!modelId) return undefined;
  return models.find((m) => m.id === modelId && (!provider || m.provider === provider));
}

import { getVideoModelCapabilities } from "@/lib/model-capabilities";

/**
 * What a generation model is FOR, in the words a creator picks by: 文生视频 / 参考生视频 / 首尾帧…
 * Shown as tags in model pickers so choosing a model per application does not mean memorising ids.
 */
export type ModelScenario =
  | "textToImage"
  | "imageToImage"
  | "referenceImage"
  | "textToVideo"
  | "imageToVideo"
  | "firstLastFrame"
  | "referenceVideo"
  | "videoEdit"
  | "nativeAudio";

export const MODEL_SCENARIO_ORDER: readonly ModelScenario[] = [
  "textToImage",
  "imageToImage",
  "referenceImage",
  "textToVideo",
  "imageToVideo",
  "firstLastFrame",
  "referenceVideo",
  "videoEdit",
  "nativeAudio",
];

export interface ScenarioModel {
  id: string;
  provider?: string;
  mediaType?: string;
  modes?: readonly string[];
  supportsAudio?: boolean;
  extra?: Record<string, unknown>;
}

function isScenario(value: unknown): value is ModelScenario {
  return typeof value === "string" && (MODEL_SCENARIO_ORDER as readonly string[]).includes(value);
}

/**
 * Scenarios for one catalog entry. A provider that states them (`extra.scenarios`, e.g. the curated
 * Volcengine lineup) is taken at its word; otherwise they are derived from the declared modes and the
 * endpoint id plus capabilities the app already knows. Reference support is NOT borrowed from a sibling
 * endpoint: a text-to-video entry stays untagged even when a reference-to-video twin exists, because
 * that twin is listed (and billed) as its own entry.
 */
export function modelScenarios(model: ScenarioModel): ModelScenario[] {
  const declared = model.extra?.scenarios;
  if (Array.isArray(declared)) {
    const list = declared.filter(isScenario);
    return MODEL_SCENARIO_ORDER.filter((s) => list.includes(s));
  }

  const modes = new Set(model.modes ?? []);
  const found = new Set<ModelScenario>();
  if (model.mediaType === "image") {
    if (modes.has("text-to-image")) found.add("textToImage");
    if (modes.has("image-to-image")) found.add("imageToImage");
  } else if (model.mediaType === "video") {
    if (modes.has("text-to-video")) found.add("textToVideo");
    if (modes.has("image-to-video")) found.add("imageToVideo");
    if (modes.has("video-to-video") || /reference-to-video/i.test(model.id)) found.add("referenceVideo");
    const caps = getVideoModelCapabilities(model.id, model.supportsAudio, model.provider);
    if (caps.lastFrame === true) found.add("firstLastFrame");
    if (model.supportsAudio || caps.nativeAudio === true) found.add("nativeAudio");
  }
  return MODEL_SCENARIO_ORDER.filter((s) => found.has(s));
}

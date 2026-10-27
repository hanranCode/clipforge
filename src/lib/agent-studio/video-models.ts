import { ARK_REMAKE_MODELS, BAILIAN_REMAKE_MODELS, REMAKE_MODELS } from "@/lib/remake/model";
import { remakeOfficialPrice } from "@/lib/remake/pricing";

export type StudioResolution = "480p" | "720p" | "1080p";
export interface StudioVideoChoice { provider: string; model: string; baseUrl?: string }
export interface StudioVideoSnapshot extends StudioVideoChoice { resolution: StudioResolution }
export const MINI_MODEL = ARK_REMAKE_MODELS[2];
export const LEGACY_VIDEO: StudioVideoChoice = { provider: "volcengine", model: MINI_MODEL };
export const STUDIO_VIDEO_MODELS = [
  ...ARK_REMAKE_MODELS.map((model, i) => ({ provider: "volcengine", model, name: ["Seedance 2.5", "Seedance 2.0", "Seedance 2.0 Mini"][i] })),
  ...BAILIAN_REMAKE_MODELS.map((model, i) => ({ provider: "alibaba", model, name: i ? "Wan 3.0 Prime" : "Wan 3.0" })),
  ...REMAKE_MODELS.map((model, i) => ({ provider: "atlas-cloud", model, name: ["Seedance 2.5", "Seedance 2.0", "Wan 3.0", "Wan 3.0 Prime"][i] })),
];
export function studioVideoModel(choice: StudioVideoChoice) {
  return STUDIO_VIDEO_MODELS.find(m => m.provider === choice.provider && m.model === choice.model);
}
export function studioResolutions(choice: StudioVideoChoice): StudioResolution[] {
  return choice.model === MINI_MODEL ? ["480p", "720p"] : ["480p", "720p", "1080p"];
}
/** Credential-free snapshots. Never accept an arbitrary object into a durable work document. */
export function parseStudioVideo(value: unknown): StudioVideoChoice {
  if (!value || typeof value !== "object") throw new Error("请选择视频供应商和模型 / Select a video provider and model");
  const raw = value as Record<string, unknown>;
  if (typeof raw.provider !== "string" || typeof raw.model !== "string" || !studioVideoModel({ provider: raw.provider, model: raw.model })) throw new Error("工作室暂不支持此视频模型 / Unsupported studio video model");
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : "";
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || baseUrl.length > 2048) throw new Error("视频 Endpoint 无效 / Invalid video endpoint");
  }
  return { provider: raw.provider, model: raw.model, ...(baseUrl && { baseUrl }) };
}
export function studioSnapshot(work: { video?: StudioVideoChoice; resolution: StudioResolution }, version?: { video?: StudioVideoSnapshot }): StudioVideoSnapshot {
  // Pre-feature versions ALWAYS used Mini, irrespective of the work's next-version selection.
  return version ? version.video ?? { ...LEGACY_VIDEO, resolution: work.resolution } : { ...(work.video ?? LEGACY_VIDEO), resolution: work.resolution };
}
export function studioVideoCost(duration: number, video: StudioVideoSnapshot, reserve = true): number {
  let amount: number;
  if (video.provider === "volcengine") {
    const [width, height] = video.resolution === "480p" ? [496, 864] : video.resolution === "720p" ? [720, 1280] : [1080, 1920];
    const rate = video.model === MINI_MODEL ? 23 : video.model === ARK_REMAKE_MODELS[0] ? 77 : 46;
    amount = duration * width * height * 24 / 1024 * rate / 1_000_000;
  } else if (video.provider === "alibaba") {
    // Upper regional list rates; no promotional discounts. This workflow sends no input video.
    // https://help.aliyun.com/zh/model-studio/model-pricing (2026-10-27)
    const tier = ["480p", "720p", "1080p"].indexOf(video.resolution);
    amount = duration * (video.model.endsWith("prime") ? [0.5, 1.03, 2.05] : [0.375, 0.75, 1.5])[tier];
  } else {
    // Planning reserve, NOT a currency quote or an account bill: 8 CNY/USD plus resolution headroom.
    amount = duration * (remakeOfficialPrice(video.model)?.perSecondUsd ?? 0) * 8 * (video.resolution === "480p" ? 1 : video.resolution === "720p" ? 2 : 4);
  }
  return Math.ceil(amount * (reserve ? 1.15 : 1) * 100) / 100;
}

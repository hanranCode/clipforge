import type { SuperResolutionParameters } from "./types";

/** Mirrors the upstream v1 schema; deployment availability is separate from schema support. */
export function upscaleCapability() {
  const turbo = (process.env.AI_NODES_VIDEO_PRESETS || "base").split(",").map(s => s.trim()).includes("turbo");
  return { id: "media.super_resolution.v1" as const, targets: ["1080p"] as const, presets: [{ id: "base" as const, available: true }, { id: "turbo" as const, available: turbo }], seed: { default: 1, min: 0, max: 2147483647 }, maxInputBytes: 200_000_000 };
}
export function parseUpscaleParameters(value?: unknown): SuperResolutionParameters {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("超分参数无效 / Invalid upscale parameters");
  const p = (value ?? {}) as Record<string, unknown>;
  if (Object.keys(p).some(k => !["capabilityId", "target", "videoPreset", "seed"].includes(k))) throw new Error("不支持的超分参数 / Unsupported upscale parameter");
  const capability = upscaleCapability();
  if (p.capabilityId !== undefined && p.capabilityId !== capability.id || p.target !== undefined && p.target !== "1080p") throw new Error("不支持的超分能力或分辨率 / Unsupported capability or resolution");
  const videoPreset = p.videoPreset ?? "base", seed = p.seed ?? 1;
  if (!capability.presets.some(x => x.id === videoPreset && x.available)) throw new Error("此视频预设尚未部署 / Video preset is not deployed");
  if (!Number.isInteger(seed) || Number(seed) < 0 || Number(seed) > 2147483647) throw new Error("Seed 必须为0–2147483647的整数 / Seed must be an integer from 0 to 2147483647");
  return { capabilityId: capability.id, target: "1080p", videoPreset: videoPreset as "base" | "turbo", seed: Number(seed) };
}

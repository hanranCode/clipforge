/** Official Atlas starting prices in USD per generated second, verified 2026-10-16. */
const REMAKE_PRICES: Record<string, number> = {
  "bytedance/seedance-2.5/reference-to-video": 0.134,
  "bytedance/seedance-2.0/reference-to-video": 0.09,
  "alibaba/wan-3.0/reference-to-video": 0.04,
  "alibaba/wan-3.0-prime/reference-to-video": 0.061,
};

/** Official list rates, verified 2026-10-28. Promotions/free quotas are account-specific.
 * Wan 3 bills BOTH input-video and output-video seconds at the output resolution's rate.
 * https://help.aliyun.com/zh/model-studio/model-pricing
 */
export function bailianVideoRate(model: string, resolution = "480p", baseUrl = ""): number | undefined {
  if (!/^wan3\.0-video(-prime)?$/.test(model)) return undefined;
  const tier = ["480p", "720p", "1080p"].indexOf(resolution.toLowerCase());
  if (tier < 0) return undefined;
  const international = /singapore|ap-southeast-1|dashscope-intl/i.test(baseUrl);
  return (model.endsWith("prime")
    ? international ? [0.495838, 1.020844, 2.041687] : [0.45, 0.9, 1.8]
    : international ? [0.37471, 0.74942, 1.49884] : [0.3, 0.6, 1.2])[tier];
}

/** Wan3 usage.duration already includes input + output. Never add input a second time.
 * https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference
 */
export function bailianVideoUsage(value: unknown) {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const seconds = (key: string) => typeof raw[key] === "number" && Number.isFinite(raw[key]) && Number(raw[key]) >= 0 ? Number(raw[key]) : undefined;
  return { inputVideoSeconds: seconds("input_video_duration"), videoSeconds: seconds("output_video_duration"), billedVideoSeconds: seconds("duration"), resolution: [480, 720, 1080].includes(Number(raw.SR)) ? `${raw.SR}p` : undefined };
}

export function remakeOfficialPrice(model: string): { perSecondUsd: number; url: string } | undefined {
  const perSecondUsd = REMAKE_PRICES[model];
  return typeof perSecondUsd === "number"
    ? { perSecondUsd, url: `https://www.atlascloud.ai/models/${model}` }
    : undefined;
}

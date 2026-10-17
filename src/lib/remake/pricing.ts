/** Official Atlas starting prices in USD per generated second, verified 2026-10-16. */
const REMAKE_PRICES: Record<string, number> = {
  "bytedance/seedance-2.5/reference-to-video": 0.134,
  "bytedance/seedance-2.0/reference-to-video": 0.09,
  "alibaba/wan-3.0/reference-to-video": 0.04,
  "alibaba/wan-3.0-prime/reference-to-video": 0.061,
};

export function remakeOfficialPrice(model: string): { perSecondUsd: number; url: string } | undefined {
  const perSecondUsd = REMAKE_PRICES[model];
  return typeof perSecondUsd === "number"
    ? { perSecondUsd, url: `https://www.atlascloud.ai/models/${model}` }
    : undefined;
}

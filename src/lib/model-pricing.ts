/**
 * Model price book — the cost side of the API call log.
 *
 * Every provider publishes prices in its own shape (per 1M tokens, per image, per video second,
 * per call), and none of them expose a machine-readable price on the generation response. So the
 * log records what it can *measure* (tokens, images, seconds, characters, latency) and multiplies
 * it by the best rate available, in this order:
 *
 *   1. a rate the provider itself published for that model (Atlas' catalog `priceBase`), passed in
 *      by the caller as `unitPriceUsd`;
 *   2. `data/model-pricing.json`, so a user whose contract price differs can correct the numbers
 *      without a rebuild (see PRICE_OVERRIDE_FILE below for the shape);
 *   3. the built-in table below.
 *
 * Rates below are list prices in USD collected 2026-09 and are ESTIMATES: tiers, regions and
 * promotions move them constantly. Anything the table cannot place returns `source: "unknown"`
 * with no amount — the UI then shows the measured units alone rather than inventing a number.
 */

/** Which settings-level model slot a call belongs to (the log's primary filter). */
export type ModelType = "text" | "vision" | "image" | "video" | "tts";

/** Text/vision rate, USD per 1M tokens. */
export interface TokenRate {
  input: number;
  output: number;
  /** Cache-read rate when the provider bills cached prompt tokens cheaper. */
  cachedInput?: number;
}

/** Media rate: exactly one of the unit fields applies. */
export interface MediaRate {
  /** USD per generated image. */
  perImage?: number;
  /** USD per second of generated video. */
  perVideoSecond?: number;
  /** USD per call, for models billed flat regardless of length. */
  perCall?: number;
  /** USD per 1M characters (TTS). */
  perMillionChars?: number;
}

export interface PriceBook {
  /** Matched against the model id, first hit wins — order matters (put specific ids first). */
  token: Array<{ match: string; rate: TokenRate }>;
  media: Array<{ match: string; rate: MediaRate }>;
}

/**
 * `data/model-pricing.json` — same shape as PriceBook, merged ahead of the built-ins.
 * The file is read by the server-only loader in model-pricing-file.ts; this module stays free of
 * `fs` so it can be bundled into client components that only need the estimators and formatters.
 */
export const PRICE_OVERRIDE_FILE = "model-pricing.json";

/**
 * Built-in list prices (USD, collected 2026-09).
 * `match` is a case-insensitive regular expression source tested against the model id.
 */
export const BUILT_IN_PRICES: PriceBook = {
  token: [
    // OpenAI
    { match: "^gpt-5(\\.\\d+)?-nano", rate: { input: 0.05, output: 0.4, cachedInput: 0.005 } },
    { match: "^gpt-5(\\.\\d+)?-mini", rate: { input: 0.25, output: 2, cachedInput: 0.025 } },
    { match: "^gpt-5", rate: { input: 1.25, output: 10, cachedInput: 0.125 } },
    { match: "^gpt-4\\.1-nano", rate: { input: 0.1, output: 0.4, cachedInput: 0.025 } },
    { match: "^gpt-4\\.1-mini", rate: { input: 0.4, output: 1.6, cachedInput: 0.1 } },
    { match: "^gpt-4\\.1", rate: { input: 2, output: 8, cachedInput: 0.5 } },
    { match: "^gpt-4o-mini", rate: { input: 0.15, output: 0.6, cachedInput: 0.075 } },
    { match: "^gpt-4o", rate: { input: 2.5, output: 10, cachedInput: 1.25 } },
    { match: "^o4-mini", rate: { input: 1.1, output: 4.4, cachedInput: 0.275 } },
    { match: "^o3-mini", rate: { input: 1.1, output: 4.4, cachedInput: 0.55 } },
    { match: "^o3", rate: { input: 2, output: 8, cachedInput: 0.5 } },
    // Anthropic
    { match: "claude.*opus", rate: { input: 15, output: 75, cachedInput: 1.5 } },
    { match: "claude.*sonnet", rate: { input: 3, output: 15, cachedInput: 0.3 } },
    { match: "claude.*haiku", rate: { input: 0.8, output: 4, cachedInput: 0.08 } },
    // Google
    { match: "gemini.*flash-lite", rate: { input: 0.1, output: 0.4 } },
    { match: "gemini.*flash", rate: { input: 0.3, output: 2.5, cachedInput: 0.075 } },
    { match: "gemini.*pro", rate: { input: 1.25, output: 10, cachedInput: 0.31 } },
    // DeepSeek
    { match: "deepseek.*(reasoner|r1)", rate: { input: 0.55, output: 2.19, cachedInput: 0.14 } },
    { match: "deepseek", rate: { input: 0.27, output: 1.1, cachedInput: 0.07 } },
    // Alibaba Qwen
    { match: "^qwen.*max", rate: { input: 1.6, output: 6.4 } },
    { match: "^qwen.*turbo", rate: { input: 0.05, output: 0.2 } },
    { match: "^qwen.*plus", rate: { input: 0.4, output: 1.2 } },
    { match: "^qwen", rate: { input: 0.07, output: 0.28 } },
    // Zhipu / Moonshot / ByteDance / MiniMax
    { match: "glm.*flash", rate: { input: 0, output: 0 } },
    { match: "glm", rate: { input: 0.6, output: 2.2 } },
    { match: "(moonshot|kimi)", rate: { input: 0.6, output: 2.5 } },
    { match: "doubao.*lite", rate: { input: 0.04, output: 0.1 } },
    { match: "doubao", rate: { input: 0.11, output: 0.28 } },
    { match: "minimax", rate: { input: 0.3, output: 1.2 } },
    // Open-weight models on inference platforms (SiliconFlow / fal / Replicate tiers)
    { match: "llama-?3\\.?\\d*-?70b", rate: { input: 0.3, output: 0.4 } },
    { match: "llama", rate: { input: 0.06, output: 0.06 } },
    { match: "mistral|mixtral", rate: { input: 0.2, output: 0.6 } },
  ],
  media: [
    // ---- images (USD per image) ----
    { match: "flux.*schnell", rate: { perImage: 0.003 } },
    { match: "flux.*(pro|1\\.1)", rate: { perImage: 0.04 } },
    { match: "flux", rate: { perImage: 0.025 } },
    { match: "(stable-diffusion|sd3|sdxl)", rate: { perImage: 0.035 } },
    { match: "gpt-image", rate: { perImage: 0.04 } },
    { match: "(nano-banana|gemini.*image|imagen)", rate: { perImage: 0.04 } },
    { match: "seedream", rate: { perImage: 0.03 } },
    { match: "qwen-image|wanx.*image", rate: { perImage: 0.02 } },
    { match: "(ideogram|recraft)", rate: { perImage: 0.06 } },
    // ---- video (USD per generated second) ----
    { match: "veo-?3.*fast", rate: { perVideoSecond: 0.15 } },
    { match: "veo", rate: { perVideoSecond: 0.4 } },
    { match: "sora.*pro", rate: { perVideoSecond: 0.3 } },
    { match: "sora", rate: { perVideoSecond: 0.1 } },
    { match: "kling.*(master|pro)", rate: { perVideoSecond: 0.28 } },
    { match: "kling", rate: { perVideoSecond: 0.07 } },
    { match: "seedance.*lite", rate: { perVideoSecond: 0.03 } },
    { match: "seedance", rate: { perVideoSecond: 0.06 } },
    { match: "(hailuo|minimax.*video)", rate: { perVideoSecond: 0.08 } },
    { match: "wan-?2", rate: { perVideoSecond: 0.05 } },
    { match: "hunyuan.*video", rate: { perVideoSecond: 0.05 } },
    { match: "ltx", rate: { perVideoSecond: 0.02 } },
    // ---- speech (USD per 1M characters) ----
    { match: "gpt-4o.*tts|tts-1-hd", rate: { perMillionChars: 30 } },
    { match: "tts-1", rate: { perMillionChars: 15 } },
    { match: "(speech|minimax.*audio|elevenlabs)", rate: { perMillionChars: 100 } },
  ],
};

/** Endpoints that never bill: a local Ollama, or a keyless free pool. */
export function isFreeEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  return /:11434(\/|$)|\bollama\b|127\.0\.0\.1|localhost|pollinations\.ai/i.test(baseUrl);
}

let overrides: PriceBook | null = null;

/** Install the user's price overrides (see model-pricing-file.ts); null clears them. */
export function setPriceOverrides(book: PriceBook | null): void {
  overrides = book;
}

/** Built-ins plus any user override (override entries are matched first). */
export function getPriceBook(): PriceBook {
  if (!overrides) return BUILT_IN_PRICES;
  return {
    token: [...overrides.token, ...BUILT_IN_PRICES.token],
    media: [...overrides.media, ...BUILT_IN_PRICES.media],
  };
}

function matchRate<T>(entries: Array<{ match: string; rate: T }>, model: string): T | undefined {
  const id = model.toLowerCase();
  for (const entry of entries) {
    try {
      if (new RegExp(entry.match, "i").test(id)) return entry.rate;
    } catch {
      // a bad regex in an override file is skipped, not fatal
    }
  }
  return undefined;
}

/** Look up the per-1M-token rate for a model id. Exported for tests and the settings screen. */
export function tokenRateFor(model: string, book: PriceBook = getPriceBook()): TokenRate | undefined {
  return matchRate(book.token, model);
}

/** Look up the media rate for a model id. */
export function mediaRateFor(model: string, book: PriceBook = getPriceBook()): MediaRate | undefined {
  return matchRate(book.media, model);
}

/** Where a recorded amount came from — shown next to the number so an estimate is never mistaken for an invoice. */
export type CostSource = "provider" | "override" | "pricebook" | "free" | "unknown";

/** Cost breakdown persisted with each call record. */
export interface ApiCallCost {
  currency: "USD";
  /** Prompt-side cost (tokens in / reference inputs). Omitted when not separable. */
  inputUsd?: number;
  /** Completion-side cost (tokens out / generated media). */
  outputUsd?: number;
  totalUsd?: number;
  source: CostSource;
  /** Human-readable rate actually applied, e.g. "$2.50/$10.00 per 1M tokens". */
  rateNote?: string;
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export interface TokenUsageInput {
  model: string;
  baseUrl?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  book?: PriceBook;
}

/**
 * Cost of one chat completion. Cached prompt tokens are billed at the cache-read rate when the
 * provider reports them and the model publishes one, so a cache-heavy run is not overstated.
 */
export function estimateTokenCost(input: TokenUsageInput): ApiCallCost {
  if (isFreeEndpoint(input.baseUrl)) {
    return { currency: "USD", inputUsd: 0, outputUsd: 0, totalUsd: 0, source: "free", rateNote: "local / free endpoint" };
  }
  const rate = tokenRateFor(input.model, input.book ?? getPriceBook());
  if (!rate) return { currency: "USD", source: "unknown" };
  const prompt = Math.max(0, input.promptTokens ?? 0);
  const cached = Math.min(Math.max(0, input.cachedTokens ?? 0), prompt);
  const fresh = prompt - cached;
  const completion = Math.max(0, input.completionTokens ?? 0);
  const inputUsd = (fresh * rate.input + cached * (rate.cachedInput ?? rate.input)) / 1_000_000;
  const outputUsd = (completion * rate.output) / 1_000_000;
  return {
    currency: "USD",
    inputUsd: round6(inputUsd),
    outputUsd: round6(outputUsd),
    totalUsd: round6(inputUsd + outputUsd),
    source: "pricebook",
    rateNote: `$${rate.input}/$${rate.output} per 1M tokens`,
  };
}

export interface MediaCostInput {
  model: string;
  mediaType: "image" | "video" | "tts";
  /** Number of images produced. */
  imageCount?: number;
  /** Billed video length in seconds. */
  videoSeconds?: number;
  /** Characters sent to a speech model. */
  charCount?: number;
  /** Price the provider itself published for this model (USD per call) — wins over the table. */
  unitPriceUsd?: number;
  book?: PriceBook;
}

/** Cost of one media generation call. */
export function estimateMediaCost(input: MediaCostInput): ApiCallCost {
  if (Number.isFinite(input.unitPriceUsd) && (input.unitPriceUsd as number) >= 0) {
    const unit = input.unitPriceUsd as number;
    const total = unit * Math.max(1, input.imageCount ?? 1);
    return { currency: "USD", outputUsd: round6(total), totalUsd: round6(total), source: "provider", rateNote: `$${unit} per call` };
  }
  const rate = mediaRateFor(input.model, input.book ?? getPriceBook());
  if (!rate) return { currency: "USD", source: "unknown" };

  let total: number | undefined;
  let note: string | undefined;
  if (rate.perCall != null) {
    total = rate.perCall * Math.max(1, input.imageCount ?? 1);
    note = `$${rate.perCall} per call`;
  } else if (input.mediaType === "image" && rate.perImage != null) {
    total = rate.perImage * Math.max(1, input.imageCount ?? 1);
    note = `$${rate.perImage} per image`;
  } else if (input.mediaType === "video" && rate.perVideoSecond != null) {
    const seconds = input.videoSeconds && input.videoSeconds > 0 ? input.videoSeconds : 5;
    total = rate.perVideoSecond * seconds;
    note = `$${rate.perVideoSecond} per second × ${seconds}s`;
  } else if (input.mediaType === "tts" && rate.perMillionChars != null) {
    total = (rate.perMillionChars * Math.max(0, input.charCount ?? 0)) / 1_000_000;
    note = `$${rate.perMillionChars} per 1M chars`;
  }
  if (total == null) return { currency: "USD", source: "unknown" };
  return { currency: "USD", outputUsd: round6(total), totalUsd: round6(total), source: "pricebook", rateNote: note };
}

/** Compact money formatting: sub-cent amounts keep their significant digits instead of rounding to $0.00. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

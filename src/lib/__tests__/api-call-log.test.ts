import { describe, expect, it } from "vitest";
import {
  buildPayload,
  sanitizeForLog,
  sanitizeString,
  safeEndpoint,
  withLogDefaults,
  MAX_FIELD_CHARS,
} from "@/lib/api-call-log";
import {
  extractChatResult,
  parseSseCompletion,
  promptSummary,
  providerLabel,
  readUsage,
  summarizeMessages,
} from "@/lib/llm-call-log";
import {
  BUILT_IN_PRICES,
  estimateMediaCost,
  estimateTokenCost,
  formatUsd,
  isFreeEndpoint,
  tokenRateFor,
} from "@/lib/model-pricing";

describe("log sanitizing", () => {
  it("never persists a credential, whatever it is nested under", () => {
    const clean = sanitizeForLog({
      model: "gpt-4o",
      apiKey: "sk-live-secret",
      nested: { api_key: "sk-2", Authorization: "Bearer x", headers: { "x-api-key": "sk-3" } },
    }) as Record<string, unknown>;
    expect(JSON.stringify(clean)).not.toContain("sk-live-secret");
    expect(clean.apiKey).toBe("[redacted]");
    expect((clean.nested as Record<string, unknown>).api_key).toBe("[redacted]");
  });

  it("replaces inline media with a size placeholder instead of copying megabytes into the DB", () => {
    const dataUri = `data:image/png;base64,${"A".repeat(200_000)}`;
    const shortened = sanitizeString(dataUri);
    expect(shortened).toMatch(/^\[inline image\/png, ~\d+KB\]$/);
    expect(shortened.length).toBeLessThan(60);
  });

  it("flags a bare base64 blob that arrives without a data: prefix", () => {
    expect(sanitizeString("A".repeat(4000))).toMatch(/^\[base64 blob/);
  });

  it("truncates long prose but keeps it readable", () => {
    const long = "字".repeat(MAX_FIELD_CHARS + 500);
    const cut = sanitizeString(long);
    expect(cut.startsWith("字".repeat(20))).toBe(true);
    expect(cut).toContain("+500 chars");
  });

  it("caps arrays so one huge list cannot bloat a row", () => {
    const capped = sanitizeForLog(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(capped).toHaveLength(25);
    expect(capped[24]).toBe("[+76 more]");
  });

  it("survives a cyclic structure", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => sanitizeForLog(cyclic)).not.toThrow();
  });

  it("keeps a payload serializable and summarized", () => {
    const payload = buildPayload("  hello   world  ", { text: "hello world" });
    expect(payload.summary).toBe("hello world");
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});

describe("endpoint + context helpers", () => {
  it("keeps host and path but drops the query string a key could hide in", () => {
    expect(safeEndpoint("https://api.deepseek.com/v1/chat/completions?key=secret")).toEqual({
      baseUrl: "https://api.deepseek.com",
      endpoint: "/v1/chat/completions",
    });
  });

  it("lets the call site's own context win over the library default", () => {
    const merged = withLogDefaults({ modelType: "text", projectId: "p1" }, { modelType: "text", scene: "script_generate" });
    expect(merged).toEqual({ modelType: "text", scene: "script_generate", projectId: "p1" });
    expect(withLogDefaults({ modelType: "vision", scene: "quality_eval" }, { modelType: "text", scene: "script_generate" }).scene).toBe("quality_eval");
  });
});

describe("chat request/response extraction", () => {
  it("flattens multimodal messages and counts the images", () => {
    const { messages, imageCount } = summarizeMessages([
      { role: "system", content: "you are a director" },
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
    expect(imageCount).toBe(1);
    expect(messages[1].content).toContain("[inline image]");
    expect(promptSummary(messages)).toContain("describe this");
  });

  it("reads usage including cached and reasoning token details", () => {
    expect(
      readUsage({
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 1000 },
        completion_tokens_details: { reasoning_tokens: 120 },
      }),
    ).toEqual({ promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cachedTokens: 1000, reasoningTokens: 120 });
  });

  it("pulls answer text out of a completion body", () => {
    const result = extractChatResult({
      choices: [{ message: { content: "{\"scripts\":[]}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    expect(result.text).toBe('{"scripts":[]}');
    expect(result.finishReason).toBe("stop");
    expect(result.usage.completionTokens).toBe(4);
  });

  it("re-assembles a streamed answer and its trailing usage frame", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"第一"}}]}',
      'data: {"choices":[{"delta":{"content":"镜"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"usage":{"prompt_tokens":800,"completion_tokens":40}}',
      "data: [DONE]",
    ].join("\n\n");
    const parsed = parseSseCompletion(sse);
    expect(parsed.text).toBe("第一镜");
    expect(parsed.finishReason).toBe("stop");
    expect(parsed.usage.promptTokens).toBe(800);
  });

  it("keeps whatever arrived when a stream is cut off mid-frame", () => {
    const parsed = parseSseCompletion('data: {"choices":[{"delta":{"content":"half"}}]}\n\ndata: {"choices":[{"del');
    expect(parsed.text).toBe("half");
    expect(parsed.usage.promptTokens).toBeUndefined();
  });

  it("labels an LLM call by its host", () => {
    expect(providerLabel("https://api.openai.com")).toBe("api.openai.com");
  });
});

describe("cost estimation", () => {
  it("bills prompt and completion tokens at the model's published rates", () => {
    const cost = estimateTokenCost({ model: "gpt-4o", promptTokens: 1_000_000, completionTokens: 1_000_000 });
    expect(cost.inputUsd).toBe(2.5);
    expect(cost.outputUsd).toBe(10);
    expect(cost.totalUsd).toBe(12.5);
    expect(cost.source).toBe("pricebook");
  });

  it("bills cached prompt tokens at the cheaper cache-read rate", () => {
    const cost = estimateTokenCost({ model: "gpt-4o", promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 });
    expect(cost.inputUsd).toBe(1.25);
  });

  it("charges nothing for a local endpoint even on a priced model name", () => {
    const cost = estimateTokenCost({ model: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1", promptTokens: 9_000_000 });
    expect(cost.totalUsd).toBe(0);
    expect(cost.source).toBe("free");
  });

  it("reports unknown rather than guessing when a model is not in the book", () => {
    const cost = estimateTokenCost({ model: "some-private-finetune-v9", promptTokens: 5000 });
    expect(cost.source).toBe("unknown");
    expect(cost.totalUsd).toBeUndefined();
  });

  it("prefers a specific model entry over the family fallback", () => {
    expect(tokenRateFor("gpt-4o-mini")?.input).toBe(0.15);
    expect(tokenRateFor("gpt-4o")?.input).toBe(2.5);
  });

  it("prices video per generated second and images per image", () => {
    expect(estimateMediaCost({ model: "kling-v2-master", mediaType: "video", videoSeconds: 10 }).totalUsd).toBeCloseTo(2.8, 6);
    expect(estimateMediaCost({ model: "flux-schnell", mediaType: "image", imageCount: 4 }).totalUsd).toBeCloseTo(0.012, 6);
  });

  it("lets a price published by the platform beat the built-in table", () => {
    const cost = estimateMediaCost({ model: "kling-v2-master", mediaType: "video", videoSeconds: 10, unitPriceUsd: 0.14 });
    expect(cost.totalUsd).toBe(0.14);
    expect(cost.source).toBe("provider");
  });

  it("charges speech by character count", () => {
    expect(estimateMediaCost({ model: "tts-1", mediaType: "tts", charCount: 100_000 }).totalUsd).toBeCloseTo(1.5, 6);
  });

  it("recognises the endpoints that never bill", () => {
    expect(isFreeEndpoint("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isFreeEndpoint("https://gen.pollinations.ai/v1")).toBe(true);
    expect(isFreeEndpoint("https://api.openai.com/v1")).toBe(false);
  });

  it("keeps sub-cent amounts visible instead of rounding them to zero", () => {
    expect(formatUsd(0.00042)).toBe("$0.0004");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(3.456)).toBe("$3.46");
  });

  it("ships a price book whose patterns all compile", () => {
    for (const entry of [...BUILT_IN_PRICES.token, ...BUILT_IN_PRICES.media]) {
      expect(() => new RegExp(entry.match, "i")).not.toThrow();
    }
  });
});

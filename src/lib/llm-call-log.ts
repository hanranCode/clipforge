/**
 * Recording layer for OpenAI-compatible chat calls.
 *
 * Wired in as the innermost fetch of `createLLMClient`, so it sees exactly what went over the wire:
 * every SDK retry, every one of our own replays (token-cap / optional-param recovery) and every
 * failure is its own row, which is what makes the log usable for "why was I billed twice for this
 * script?". The wrapper never consumes the response the caller will read — JSON answers are read
 * from a clone, streamed answers are tee'd and accumulated in the background — and a logging error
 * is swallowed rather than surfaced.
 */

import {
  buildPayload,
  recordApiCall,
  safeEndpoint,
  type ApiCallContext,
  type ApiCallUsage,
} from "@/lib/api-call-log";
import { estimateTokenCost } from "@/lib/model-pricing";

/** Largest streamed body accumulated for logging (a long script is ~40KB of SSE). */
const MAX_STREAM_CHARS = 512_000;

interface ChatRequestShape {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  response_format?: unknown;
}

/** One message flattened for the log: text kept, inline images reduced to a marker. */
export interface LoggedMessage {
  role: string;
  content: string;
  images?: number;
}

/** Flatten chat messages; returns the cast plus whether any image part was present. */
export function summarizeMessages(messages: unknown): { messages: LoggedMessage[]; imageCount: number } {
  if (!Array.isArray(messages)) return { messages: [], imageCount: 0 };
  let imageCount = 0;
  const flattened = messages.map((raw): LoggedMessage => {
    const message = (raw ?? {}) as { role?: unknown; content?: unknown };
    const role = typeof message.role === "string" ? message.role : "unknown";
    if (typeof message.content === "string") return { role, content: message.content };
    if (!Array.isArray(message.content)) return { role, content: "" };
    let images = 0;
    const text = message.content
      .map((part) => {
        const item = (part ?? {}) as { type?: unknown; text?: unknown; image_url?: { url?: unknown } };
        if (item.type === "text" && typeof item.text === "string") return item.text;
        if (item.type === "image_url") {
          images += 1;
          const url = typeof item.image_url?.url === "string" ? item.image_url.url : "";
          return url.startsWith("data:") ? "[inline image]" : `[image ${url.slice(0, 120)}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    imageCount += images;
    return { role, content: text, ...(images > 0 && { images }) };
  });
  return { messages: flattened, imageCount };
}

/** The prompt line shown in the list: the last user turn, or the last turn of any role. */
export function promptSummary(messages: LoggedMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content.trim());
  return (lastUser ?? messages[messages.length - 1])?.content ?? "";
}

/** Pull usage counters out of an OpenAI-shaped `usage` object. */
export function readUsage(usage: unknown): ApiCallUsage {
  const raw = (usage ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const promptDetails = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (raw.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    promptTokens: num(raw.prompt_tokens),
    completionTokens: num(raw.completion_tokens),
    totalTokens: num(raw.total_tokens),
    cachedTokens: num(promptDetails.cached_tokens),
    reasoningTokens: num(completionDetails.reasoning_tokens),
  };
}

/** Answer text + usage from a non-streamed chat completion body. */
export function extractChatResult(body: unknown): { text: string; finishReason?: string; usage: ApiCallUsage } {
  const raw = (body ?? {}) as { choices?: unknown; usage?: unknown };
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  const first = (choices[0] ?? {}) as { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown };
  const content = typeof first.message?.content === "string" ? first.message.content : "";
  const reasoning = typeof first.message?.reasoning_content === "string" ? first.message.reasoning_content : "";
  return {
    text: content || reasoning,
    finishReason: typeof first.finish_reason === "string" ? first.finish_reason : undefined,
    usage: readUsage(raw.usage),
  };
}

/**
 * Re-assemble a streamed answer from raw SSE text.
 * Providers differ on whether a final `usage` frame is sent; when it is absent the row keeps the
 * text and simply has no token counts, which the UI renders as "—" rather than as zero.
 */
export function parseSseCompletion(sse: string): { text: string; finishReason?: string; usage: ApiCallUsage } {
  let text = "";
  let finishReason: string | undefined;
  let usage: ApiCallUsage = {};
  for (const line of sse.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const frame = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }>;
        usage?: unknown;
      };
      const delta = frame.choices?.[0]?.delta;
      if (typeof delta?.content === "string") text += delta.content;
      else if (typeof delta?.reasoning_content === "string") text += delta.reasoning_content;
      const reason = frame.choices?.[0]?.finish_reason;
      if (typeof reason === "string") finishReason = reason;
      if (frame.usage) usage = readUsage(frame.usage);
    } catch {
      // a partial frame at the tail of a cut-off stream is expected — keep what parsed
    }
  }
  return { text, finishReason, usage };
}

/** Read a stream to the end (capped), without disturbing the copy the caller consumes. */
async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
      if (out.length > MAX_STREAM_CHARS) break;
    }
  } catch {
    // the caller aborted or the connection dropped — log what arrived
  } finally {
    reader.cancel().catch(() => {});
  }
  return out;
}

/**
 * fetch wrapper that writes one api_calls row per HTTP attempt.
 * `context` says which settings slot and business scene the call belongs to; it is supplied by
 * whoever built the client, since the wire format alone cannot tell a script call from a judge call.
 */
export function loggingFetch(
  context: ApiCallContext,
  baseFetch: typeof fetch = fetch,
): (url: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const { baseUrl, endpoint } = safeEndpoint(href);
    const startedAt = Date.now();

    // Only completions are recorded. Catalog reads (GET /models) cost nothing and would bury the
    // calls that do; they are recognisable by having no JSON request body at all.
    let request: ChatRequestShape | undefined;
    try {
      if (typeof init?.body === "string") request = JSON.parse(init.body) as ChatRequestShape;
    } catch {
      // non-JSON body (never the case for chat completions) — pass through unrecorded
    }
    if (!request?.messages) return baseFetch(url, init);
    const model = typeof request.model === "string" ? request.model : "unknown";
    const { messages, imageCount } = summarizeMessages(request.messages);
    const modelType = context.modelType === "text" && imageCount > 0 ? "vision" : context.modelType;
    const requestPayload = buildPayload(promptSummary(messages), {
      model,
      messages,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.max_tokens !== undefined && { max_tokens: request.max_tokens }),
      ...(request.max_completion_tokens !== undefined && { max_completion_tokens: request.max_completion_tokens }),
      ...(request.response_format !== undefined && { response_format: request.response_format }),
      ...(request.stream === true && { stream: true }),
    });
    const common = { ...context, modelType, provider: providerLabel(baseUrl), model, baseUrl, endpoint, request: requestPayload };

    let response: Response;
    try {
      response = await baseFetch(url, init);
    } catch (error) {
      void recordApiCall({
        ...common,
        status: "failed",
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        ...(imageCount > 0 && { usage: { imageCount } }),
      });
      throw error;
    }

    const latencyMs = Date.now() - startedAt;
    const contentType = response.headers.get("content-type") ?? "";
    const streamed = contentType.includes("text/event-stream");

    // A streamed answer is logged when it finishes: tee so the caller's copy is untouched, and let
    // the recording run in the background rather than holding up the first token.
    if (streamed && response.body) {
      const [forCaller, forLog] = response.body.tee();
      void drain(forLog).then((sse) => {
        const { text, finishReason, usage } = parseSseCompletion(sse);
        return recordApiCall({
          ...common,
          status: response.ok ? "success" : "failed",
          httpStatus: response.status,
          latencyMs,
          streamed: true,
          response: buildPayload(text, { text, ...(finishReason && { finishReason }) }),
          usage: { ...usage, ...(imageCount > 0 && { imageCount }) },
          cost: estimateTokenCost({ model, baseUrl, ...usage }),
        });
      });
      return new Response(forCaller, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    const text = await response.clone().text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      void recordApiCall({
        ...common,
        status: "failed",
        httpStatus: response.status,
        latencyMs,
        response: buildPayload(text.slice(0, 500), parsed ?? text.slice(0, 2000)),
        error: `HTTP ${response.status}`,
        ...(imageCount > 0 && { usage: { imageCount } }),
      });
      return response;
    }

    const { text: answer, finishReason, usage } = extractChatResult(parsed);
    void recordApiCall({
      ...common,
      status: "success",
      httpStatus: response.status,
      latencyMs,
      response: buildPayload(answer, { text: answer, ...(finishReason && { finishReason }) }),
      usage: { ...usage, ...(imageCount > 0 && { imageCount }) },
      cost: estimateTokenCost({ model, baseUrl, ...usage }),
    });
    return response;
  };
}

/** Host as the provider label for LLM calls — "api.deepseek.com" says more here than "openai". */
export function providerLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "llm";
  } catch {
    return baseUrl || "llm";
  }
}

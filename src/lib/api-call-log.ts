/**
 * API call log — the write side of "API 调用记录".
 *
 * Every model call in the app funnels through one of three chokepoints (the LLM client factory in
 * llm-error.ts, the media provider factory in providers/index.ts, the TTS helper in tts.ts), so
 * recording happens there rather than at ~20 call sites. Each of them hands this module a context
 * (which settings slot, which scene, which project) plus the raw request/response, and this module
 * is responsible for three things the call sites must never have to think about:
 *
 *  - Safety. An API key must never reach the database, and neither must a 4MB base64 reference
 *    image. `sanitizeForLog` redacts credential-shaped keys and swaps data URIs/blobs for size
 *    placeholders BEFORE anything is serialized.
 *  - Size. Prompts and completions are truncated per field and the whole payload is capped, so one
 *    pathological call cannot bloat the DB.
 *  - Best effort. A logging failure is swallowed: recording a call must never break the call.
 *
 * This module holds only what is safe to bundle anywhere: types, sanitizers and a sink indirection.
 * The database writer lives in api-call-store.ts and installs itself through `setApiCallSink` at
 * server startup (src/instrumentation.ts) — two of the three chokepoints are reachable from client
 * components (the script page imports a helper out of the script engine), so a static import of the
 * database here would drag better-sqlite3 and `fs` into the browser bundle.
 */

import type { ApiCallCost, ModelType } from "@/lib/model-pricing";

/** Longest single string kept inside a payload. */
export const MAX_FIELD_CHARS = 4000;
/** Longest serialized payload (request or response) kept per row. */
export const MAX_PAYLOAD_CHARS = 24_000;

/** Business purpose of a call. Free-form by design (a new scene needs no migration), but these are
 *  the ones the app emits today and the ones the UI knows how to label. */
export const API_CALL_SCENES = [
  "script_generate",
  "script_regenerate",
  "shot_rewrite",
  "script_judge",
  "script_translate",
  "product_analysis",
  "media_analysis",
  "quality_eval",
  "semantic_match",
  "publish_copy",
  "ad_template",
  "topic_script",
  "shot_image",
  "shot_video",
  "storyboard",
  "character_sheet",
  "video_repair",
  "clone_remake",
  "tts_speech",
  "connection_test",
] as const;
export type ApiCallScene = (typeof API_CALL_SCENES)[number] | (string & {});

/** Measured units behind the cost. Whatever the provider did not report stays undefined. */
export interface ApiCallUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Prompt tokens served from the provider's cache (billed cheaper when the model supports it). */
  cachedTokens?: number;
  /** Thinking tokens, when a reasoning model reports them separately. */
  reasoningTokens?: number;
  /** Characters sent to a speech model. */
  charCount?: number;
  /** Images returned. */
  imageCount?: number;
  /** Billed video length in seconds. */
  videoSeconds?: number;
  /** Bytes of binary output (speech). */
  outputBytes?: number;
  /** Output geometry, when known, e.g. "1080x1920". */
  resolution?: string;
}

/** Sanitized request/response body plus the one-line version shown in the list. */
export interface ApiCallPayload {
  /** Single line for the table row — the prompt, or the answer, trimmed. */
  summary?: string;
  /** Structured, sanitized detail shown when a row is expanded. */
  detail?: unknown;
}

/** What a chokepoint knows about the call it is making. */
export interface ApiCallContext {
  modelType: ModelType;
  scene?: ApiCallScene;
  projectId?: string;
  shotId?: number;
}

export interface RecordApiCallInput extends ApiCallContext {
  provider: string;
  model: string;
  baseUrl?: string;
  endpoint?: string;
  status?: "success" | "failed";
  httpStatus?: number;
  latencyMs?: number;
  streamed?: boolean;
  request?: ApiCallPayload;
  response?: ApiCallPayload;
  usage?: ApiCallUsage;
  cost?: ApiCallCost;
  error?: string;
  taskId?: string;
}

/**
 * Fill in the parts of a context the call site did not specify.
 * Call sites closest to the user (an API route) know the project; the library function underneath
 * knows the scene — this merges the two without either having to know about the other.
 */
export function withLogDefaults(context: ApiCallContext | undefined, defaults: ApiCallContext): ApiCallContext {
  return {
    ...defaults,
    ...(context ?? {}),
    modelType: context?.modelType ?? defaults.modelType,
    scene: context?.scene ?? defaults.scene,
  };
}

// ==================== sanitizing ====================

/** Field names whose value is a credential and must never be persisted. */
const SECRET_KEYS = /^(api[-_]?key|apikey|authorization|auth|token|access[-_]?token|secret|password|bearer|x-api-key)$/i;
/** Fields that carry media the log references by URL instead of copying. */
const BASE64_LIKE = /^[A-Za-z0-9+/=\s]{512,}$/;

function describeDataUri(value: string): string {
  const meta = value.slice(5, value.indexOf(",") === -1 ? 40 : value.indexOf(","));
  const mime = meta.split(";")[0] || "application/octet-stream";
  const approxBytes = Math.round((value.length * 3) / 4);
  return `[inline ${mime}, ~${(approxBytes / 1024).toFixed(0)}KB]`;
}

/** Shorten one string: data URIs and raw base64 become size placeholders, long text is cut. */
export function sanitizeString(value: string, maxChars = MAX_FIELD_CHARS): string {
  if (value.startsWith("data:")) return describeDataUri(value);
  if (value.length > 512 && BASE64_LIKE.test(value)) return `[base64 blob, ~${(value.length / 1024).toFixed(0)}KB]`;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[+${value.length - maxChars} chars]`;
}

/**
 * Recursively strip credentials and shrink oversized values.
 * Depth- and width-limited so a cyclic or enormous structure cannot hang the writer.
 */
export function sanitizeForLog(value: unknown, depth = 0, maxChars = MAX_FIELD_CHARS): unknown {
  if (depth > 6) return "[…]";
  if (value == null) return value;
  if (typeof value === "string") return sanitizeString(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, 24).map((item) => sanitizeForLog(item, depth + 1, maxChars));
    return value.length > 24 ? [...kept, `[+${value.length - 24} more]`] : kept;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 48)) {
      if (SECRET_KEYS.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitizeForLog(raw, depth + 1, maxChars);
    }
    return out;
  }
  return undefined;
}

/** Sanitize, then cap the serialized size so one row can never be huge. */
export function buildPayload(summary: string | undefined, detail: unknown): ApiCallPayload {
  const clean = sanitizeForLog(detail);
  let serialized = "";
  try {
    serialized = JSON.stringify(clean) ?? "";
  } catch {
    return { summary: summary?.slice(0, 500), detail: "[unserializable]" };
  }
  return {
    ...(summary && { summary: summary.replace(/\s+/g, " ").trim().slice(0, 500) }),
    detail: serialized.length > MAX_PAYLOAD_CHARS ? JSON.parse(truncateJson(serialized)) : clean,
  };
}

/** Last-resort size cap: keep the payload valid JSON by replacing it with a marker object. */
function truncateJson(serialized: string): string {
  return JSON.stringify({ truncated: true, bytes: serialized.length, preview: serialized.slice(0, 4000) });
}

/** Host + path of an endpoint, with query string and credentials removed. */
export function safeEndpoint(url: string): { baseUrl: string; endpoint: string } {
  try {
    const parsed = new URL(url);
    return { baseUrl: `${parsed.protocol}//${parsed.host}`, endpoint: parsed.pathname };
  } catch {
    return { baseUrl: "", endpoint: url.slice(0, 200) };
  }
}

// ==================== recording ====================

/** What a recorder must implement. Installed on the server by api-call-store.ts. */
export interface ApiCallSink {
  record(input: RecordApiCallInput): Promise<string | null>;
  update(id: string | null, patch: UpdateApiCallPatch): Promise<void>;
}

/** Fields a row can gain after it was first written (async video tasks finish minutes later). */
export type UpdateApiCallPatch = Partial<
  Pick<RecordApiCallInput, "status" | "response" | "usage" | "cost" | "error" | "latencyMs" | "taskId">
>;

/** No-op default: in the browser, and in unit tests, calls are simply not recorded. */
let sink: ApiCallSink = {
  record: async () => null,
  update: async () => {},
};

/** Install the real recorder (server only). */
export function setApiCallSink(next: ApiCallSink): void {
  sink = next;
}

/** Record one call. Returns the row id, or null when nothing recorded it. Never throws. */
export async function recordApiCall(input: RecordApiCallInput): Promise<string | null> {
  try {
    return await sink.record(input);
  } catch (error) {
    console.warn("API 调用记录写入失败（不影响本次调用）:", error);
    return null;
  }
}

/** Patch a row written before its result was known. Never throws. */
export async function updateApiCall(id: string | null, patch: UpdateApiCallPatch): Promise<void> {
  if (!id) return;
  try {
    await sink.update(id, patch);
  } catch (error) {
    console.warn("API 调用记录更新失败:", error);
  }
}

// ==================== reading ====================

export interface ApiCallFilters {
  modelType?: ModelType;
  scene?: string;
  provider?: string;
  model?: string;
  status?: "success" | "failed";
  projectId?: string;
  /** epoch ms, inclusive */
  since?: number;
  until?: number;
  search?: string;
}

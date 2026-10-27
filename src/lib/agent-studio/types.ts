import { parseSegmentReferences, type AgentReference, type ReferenceSnapshot, type SegmentReferences } from "./reference-types";
import type { StudioVideoChoice, StudioVideoSnapshot, StudioResolution } from "./video-models";
export { MINI_MODEL } from "./video-models";
export const AGENT_CLIS = ["codex", "claude", "hermes-agent", "deepseek-harness"] as const;
export type AgentCli = typeof AGENT_CLIS[number];
export const AGENT_CLI_LABELS: Record<AgentCli, string> = { codex: "Codex CLI", claude: "Claude Code", "hermes-agent": "Hermes Agent", "deepseek-harness": "DeepSeek Harness" };
export const AGENT_CLI_COMMANDS: Record<AgentCli, string> = { codex: "codex", claude: "claude", "hermes-agent": "hermes", "deepseek-harness": "dsh" };
export type WorkStatus = "draft" | "queued" | "planning" | "review" | "generating" | "completed" | "attention" | "cancelled";
export interface AgentRuntime {
  id: string; name: string; cli: AgentCli; model: string; enabled: boolean;
  lastSeen: number | null; connected: boolean; version: string | null; host: string | null;
  createdAt: number;
}
export interface ProductCrop { frame: number; x: number; y: number; width: number; height: number }
export interface AgentSegment { duration: number; script: string; prompt: string; references?: SegmentReferences }
export interface AgentPlan {
  summary: string; preserve: string[]; change: string[]; notes: string[];
  segments: AgentSegment[]; productCrop: ProductCrop | null;
}
export interface SegmentReceipt {
  state: "pending" | "submitting" | "submitted" | "completed" | "unknown";
  taskId?: string; tokens?: number; costCny?: number; file?: string;
  costEstimated?: boolean;
  apiCallId?: string; submittedAt?: number; error?: string;
}
export interface WorkVersion {
  video?: StudioVideoSnapshot;
  referenceSnapshot?: ReferenceSnapshot;
  superResolution?: SuperResolutionTask;
  superResolutions?: SuperResolutionTask[];
  artifacts?: AgentArtifact[];
  id: string; number: number; status: "queued" | "generating" | "completed" | "attention" | "cancelled";
  hypitUrl?: string; prepared?: boolean; plan: AgentPlan; budgetCny: number; estimatedCny: number; costCny: number | null;
  receipts: SegmentReceipt[]; outputUrl: string | null; posterUrl: string | null;
  sourceId: string | null; editorUrl: string | null; error: string | null;
  createdAt: number; completedAt: number | null;
}
export interface SuperResolutionTask {
  requestId: string; workflowId: string; runId?: string;
  status: "submitting" | "processing" | "waiting_for_output_url" | "unknown" | "completed" | "failed" | "cancelled";
  objectKey: string;
  storage: { endpoint: string; region: string; bucket: string; pathStyle?: boolean };
  outputUrl?: string; error?: string; createdAt: number;
  parameters?: SuperResolutionParameters; completedAt?: number; apiCallId?: string;
  result?: { sha256: string; bytes: number; width: number; height: number };
}
export interface SuperResolutionParameters { capabilityId: "media.super_resolution.v1"; target: "1080p"; videoPreset: "base" | "turbo"; seed: number }
export interface AgentArtifact { id: string; role: "result" | "segment" | "poster" | "reference" | "upscale"; title: string; url: string; parentAssetId?: string }
/** Read pre-history works without discarding the first real upscale. */
export function superResolutionTasks(v: Pick<WorkVersion, "superResolution" | "superResolutions">): SuperResolutionTask[] {
  const tasks = new Map((v.superResolutions ?? []).map(t => [t.requestId, t]));
  if (v.superResolution) tasks.set(v.superResolution.requestId, v.superResolution);
  return [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
}
export interface AgentWork {
  video?: StudioVideoChoice;
  references?: AgentReference[];
  id: string; title: string; sourceAssetId: string; sourceUrl: string; sourceName: string;
  importKey?: string; duration: number; brief: string; runtimeId: string | null; status: WorkStatus;
  resolution: StudioResolution; voice: "female" | "male" | "original";
  plan: AgentPlan | null; versions: WorkVersion[]; posterUrl: string | null;
  projectId: string | null; error: string | null; createdAt: number; updatedAt: number;
}
export interface AgentEvent { id: number; workId: string; kind: "user" | "agent" | "system" | "error"; text: string; createdAt: number }
export interface AgentJob {
  id: string; workId: string; runtimeId: string; kind: "plan" | "generate" | "editor";
  versionId: string | null; status: "queued" | "running" | "completed" | "failed" | "cancelled";
  leaseUntil: number; createdAt: number;
}
export const runtimeOnline = (r: Pick<AgentRuntime, "enabled" | "lastSeen">, now = Date.now()) => r.enabled && r.lastSeen !== null && now - r.lastSeen < 45_000;
export function estimateVideoCny(duration: number, resolution: "480p" | "720p") {
  const [width, height] = resolution === "480p" ? [496, 864] : [720, 1280];
  // Native frame/token accounting varies slightly. Reserve 15% above the nominal quote.
  return Math.ceil(duration * width * height * 24 / 1024 * 23 / 1_000_000 * 115) / 100;
}

/** Model output is data, never executable instructions, filesystem paths or a price authority. */
export function parseAgentPlan(value: unknown, duration: number): AgentPlan {
  if (!value || typeof value !== "object") throw new Error("Agent 未返回有效方案 / Invalid Agent plan");
  const v = value as Record<string, unknown>;
  const text = (s: unknown, max: number) => { if (typeof s !== "string" || !s.trim() || s.length > max) throw new Error("方案内容不完整 / Incomplete plan"); return s.trim(); };
  const list = (s: unknown) => Array.isArray(s) ? s.slice(0, 12).map(x => text(x, 800)) : [];
  if (!Array.isArray(v.segments) || !v.segments.length || v.segments.length > 24) throw new Error("方案需要包含可执行的分段 / Missing segments");
  const segments = v.segments.map((raw: unknown) => {
    const s = raw as Record<string, unknown>;
    if (!s || !Number.isInteger(s.duration) || Number(s.duration) < 4 || Number(s.duration) > 15) throw new Error("每段需为4–15秒 / Each segment must be 4–15s");
    return { duration: Number(s.duration), script: text(s.script, 1600), prompt: text(s.prompt, 6000), ...(s.references !== undefined && { references: parseSegmentReferences(s.references) }) };
  });
  if (Math.abs(segments.reduce((n, s) => n + s.duration, 0) - Math.round(duration)) > 0) throw new Error("分段总时长需与作品一致 / Segment duration mismatch");
  let productCrop: ProductCrop | null = null;
  if (v.productCrop !== null && v.productCrop !== undefined) {
    const c = v.productCrop as Record<string, unknown>;
    if (!Number.isInteger(c.frame) || Number(c.frame) < 0 || Number(c.frame) > 5 || ![c.x, c.y, c.width, c.height].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
      || Number(c.width) < 0.1 || Number(c.height) < 0.1 || Number(c.x) + Number(c.width) > 1 || Number(c.y) + Number(c.height) > 1) throw new Error("商品裁切区域无效 / Invalid product crop");
    productCrop = { frame: Number(c.frame), x: Number(c.x), y: Number(c.y), width: Number(c.width), height: Number(c.height) };
  }
  return { summary: text(v.summary, 3000), preserve: list(v.preserve), change: list(v.change), notes: list(v.notes), segments, productCrop };
}

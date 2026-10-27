import { copyFile, mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiCalls, assets, projects } from "@/lib/db/schema";
import { getOutputDir, getUploadsDir } from "@/lib/paths";
import { buildPayload } from "@/lib/api-call-log";
import { studioStore } from "./store";
import { agentResourceUrl, migrateAgentResource } from "./resources";
import { superResolutionTasks, type AgentArtifact, type AgentWork, type WorkVersion } from "./types";
import { studioSnapshot } from "./video-models";

/** Stable IDs let live publication and historical reconciliation converge without duplicate rows. */
export const agentResultAssetId = (versionId: string) => `agent-${versionId}-result`;
export const agentProjectHref = (workId: string, versionId?: string) => `/agent-studio/${workId}${versionId ? `?version=${encodeURIComponent(versionId)}` : ""}`;
export function syncAgentProject(w: AgentWork) {
  const db = getDb();
  const values = { name: w.title, sourceType: "agent" as const, status: w.versions.some(v => v.status === "completed") ? "done" as const : "draft" as const, sourceVideoUrl: w.sourceUrl, updatedAt: new Date(w.updatedAt) };
  db.insert(projects).values({ id: w.projectId || w.id, ...values, createdAt: new Date(w.createdAt) }).onConflictDoUpdate({ target: projects.id, set: values }).run();
}
/** One call record per actual submission/run, patched from durable receipts; no signed URLs. */
export function syncAgentCalls(w: AgentWork) {
  const db = getDb();
  for (const v of w.versions) {
    const video = studioSnapshot(w, v);
    v.receipts.forEach((r, index) => {
      if (!r.apiCallId && !r.taskId) return;
      const segment = v.plan.segments[index];
      const state = r.state, failed = Boolean(r.error);
      const values = { modelType: "video" as const, scene: "agent_video", projectId: w.projectId || w.id, shotId: index + 1, provider: video.provider, model: video.model, endpoint: video.provider === "volcengine" ? "contents/generations/tasks" : video.provider === "alibaba" ? "services/aigc/video-generation/video-synthesis" : "model/generateVideo", status: failed ? "failed" as const : "success" as const, taskId: r.taskId ?? null,
        request: buildPayload(segment?.prompt, { workId: w.id, versionId: v.id, duration: segment?.duration, resolution: video.resolution, prompt: segment?.prompt }),
        response: buildPayload(state, { state, taskId: r.taskId, costCny: r.costCny, costEstimated: r.costEstimated, output: v.artifacts?.find(a => a.id === `agent-${v.id}-segment-${index}`)?.url, origin: w.importKey ? "imported_receipt" : "live" }),
        usage: { ...(r.tokens !== undefined && { completionTokens: r.tokens }), ...(segment && { videoSeconds: segment.duration }), resolution: video.resolution }, error: r.error ?? null };
      db.insert(apiCalls).values({ id: r.apiCallId || `agent-call-${v.id}-${index}`, ...values, createdAt: new Date(r.submittedAt || v.createdAt) }).onConflictDoUpdate({ target: apiCalls.id, set: values }).run();
    });
    for (const sr of superResolutionTasks(v)) {
      if (!sr.apiCallId && !sr.runId && sr.status !== "unknown") continue;
      const values = { modelType: "video" as const, scene: "agent_upscale", projectId: w.projectId || w.id, provider: "ai-nodes", model: `flashvsr-plus-${sr.parameters?.videoPreset || "base"}`, endpoint: "MediaSuperResolutionWorkflowV1", taskId: sr.workflowId, status: ["failed", "cancelled"].includes(sr.status) ? "failed" as const : "success" as const,
        request: buildPayload(`${w.title} · V${v.number} → 1080P`, { workId: w.id, versionId: v.id, ...sr.parameters, target: "1080p", sourceAssetId: agentResultAssetId(v.id) }),
        response: buildPayload(sr.status, { state: sr.status, workflowId: sr.workflowId, runId: sr.runId, output: sr.outputUrl }), error: sr.error ?? null, ...(sr.completedAt && { latencyMs: sr.completedAt - sr.createdAt }) };
      db.insert(apiCalls).values({ id: sr.apiCallId || `agent-upscale-${sr.requestId}`, ...values, createdAt: new Date(sr.createdAt) }).onConflictDoUpdate({ target: apiCalls.id, set: values }).run();
    }
  }
}
export function recordAgentProgress(w: AgentWork) {
  // Logging must not turn an acknowledged provider task into an ambiguous failed submission.
  try { syncAgentProject(w); syncAgentCalls(w); } catch { /* durable receipts remain the source for reconciliation */ }
}

async function archive(w: AgentWork, v: WorkVersion) {
  const video = studioSnapshot(w, v);
  if (!/^[a-zA-Z0-9-]+$/.test(w.id) || !/^[a-zA-Z0-9-]+$/.test(v.id)) return;
  const root = join(getOutputDir(), "agent-studio", w.id, "versions", v.id);
  const dir = existsSync(root) ? await realpath(root) : null, upload = join(getUploadsDir(), w.projectId || w.id, "agent-library");
  if (dir && !dir.startsWith(await realpath(join(getOutputDir(), "agent-studio")) + sep)) throw new Error("Agent 版本目录无效");
  const known = new Set(v.artifacts?.map(a => a.id));
  const resultId = agentResultAssetId(v.id);
  const entries: Array<{ id: string; file: string; role: AgentArtifact["role"]; title: string; parentAssetId?: string; provider: string; model: string; prompt?: string; sr?: ReturnType<typeof superResolutionTasks>[number] }> = [];
  const add = (id: string, file: string, role: AgentArtifact["role"], title: string, provider: string, model: string, prompt?: string, parentAssetId?: string) => entries.push({ id, file, role, title, provider, model, prompt, parentAssetId });
  if (v.status === "completed" && v.outputUrl) {
    add(resultId, "final.mp4", "result", `${w.title} · V${v.number}`, video.provider, video.model, v.plan.summary);
    add(`agent-${v.id}-poster`, "poster.jpg", "poster", `${w.title} · V${v.number} · 封面`, "local", "video-frame", "从生成成片提取的封面 / Frame extracted from the generated video", resultId);
  }
  if (v.prepared && v.plan.productCrop) add(`agent-${v.id}-reference`, "product.jpg", "reference", `${w.title} · V${v.number} · 商品参考`, "local", "product-crop", "用户确认的商品裁切参考 / Approved product crop");
  v.receipts.forEach((r, i) => { if (r.state === "completed" && r.file) add(`agent-${v.id}-segment-${i}`, `segment-${i}.mp4`, "segment", `${w.title} · V${v.number} · ${i + 1}`, video.provider, video.model, v.plan.segments[i]?.prompt, resultId); });
  for (const sr of superResolutionTasks(v)) if (sr.status === "completed" && sr.outputUrl) {
    add(`agent-upscale-${sr.requestId}`, `upscaled-${sr.requestId}.mp4`, "upscale", `${w.title} · V${v.number} · 1080P · ${superResolutionTasks(v).indexOf(sr) + 1}`, "ai-nodes", `flashvsr-plus-${sr.parameters?.videoPreset || "base"}`, JSON.stringify(sr.parameters || { target: "1080p", videoPreset: "base", seed: 1 }), resultId);
    entries[entries.length - 1].sr = sr;
  }
  for (const entry of entries) {
    const createdAt = new Date(entry.sr?.completedAt || entry.sr?.createdAt || v.completedAt || v.createdAt);
    if (entry.sr?.result) {
      const url = agentResourceUrl(entry.sr.requestId), artifact: AgentArtifact = { id: entry.id, role: "upscale", title: entry.title, url, parentAssetId: resultId };
      if (!known.has(entry.id)) getDb().insert(assets).values({ id: entry.id, projectId: w.projectId || w.id, shotId: 0, type: "ai_generated", filePath: url, provider: entry.provider, model: entry.model, prompt: entry.prompt, sourceUrl: agentProjectHref(w.id, v.id), status: "done", selected: false, thumbnailPath: v.posterUrl, createdAt, objectKey: entry.sr.objectKey, objectBucket: entry.sr.storage.bucket, objectUploadedAt: new Date(entry.sr.completedAt || entry.sr.createdAt) }).onConflictDoNothing().run();
      else getDb().update(assets).set({ filePath: url, createdAt }).where(eq(assets.id, entry.id)).run();
      const old = v.artifacts?.find(a => a.id === entry.id);
      if (!old || old.url !== url) studioStore().update(w.id, current => { const version = current.versions.find(x => x.id === v.id)!; version.artifacts ??= []; const index = version.artifacts.findIndex(a => a.id === entry.id); if (index < 0) version.artifacts.push(artifact); else version.artifacts[index] = artifact; });
      continue;
    }
    if (known.has(entry.id)) { getDb().update(assets).set({ createdAt }).where(eq(assets.id, entry.id)).run(); continue; }
    if (!dir || !existsSync(join(dir, entry.file))) continue;
    const source = await realpath(join(dir, entry.file)); if (!source.startsWith(dir + sep)) throw new Error("Agent 产物超出版本目录");
    const ext = entry.file.endsWith(".jpg") ? "jpg" : "mp4", file = join(upload, `${entry.id}.${ext}`);
    await mkdir(upload, { recursive: true });
    if (!existsSync(file)) await copyFile(source, file);
    const url = `/api/files/${w.projectId || w.id}/agent-library/${entry.id}.${ext}`;
    const artifact: AgentArtifact = { id: entry.id, role: entry.role, title: entry.title, url, ...(entry.parentAssetId && { parentAssetId: entry.parentAssetId }) };
    getDb().insert(assets).values({ id: entry.id, projectId: w.projectId || w.id, shotId: entry.role === "segment" ? Number(entry.file.match(/segment-(\d+)/)?.[1] || 0) + 1 : 0, type: entry.role === "reference" ? "product_image" : "ai_generated", filePath: url, provider: entry.provider, model: entry.model, prompt: entry.prompt, sourceUrl: agentProjectHref(w.id, v.id), status: "done", selected: false, thumbnailPath: ext === "mp4" && v.posterUrl ? v.posterUrl : null, createdAt, ...(entry.sr && { objectKey: entry.sr.objectKey, objectBucket: entry.sr.storage.bucket, objectUploadedAt: new Date(entry.sr.completedAt || entry.sr.createdAt) }) }).onConflictDoNothing().run();
    studioStore().update(w.id, current => { const version = current.versions.find(x => x.id === v.id)!; version.artifacts ??= []; if (!version.artifacts.some(a => a.id === entry.id)) version.artifacts.push(artifact); });
    known.add(entry.id);
  }
}
const syncing = new Map<string, Promise<void>>();
const reconciled = new Map<string, string>();
export async function syncAgentWork(w: AgentWork) {
  const existing = syncing.get(w.id); if (existing) return existing;
  if (reconciled.get(w.id) === JSON.stringify(w)) return;
  const job = (async () => { syncAgentProject(w); for (const v of w.versions) { for (const sr of superResolutionTasks(v)) await migrateAgentResource(w, v, sr); const current = studioStore().work(w.id); await archive(current, current.versions.find(x => x.id === v.id)!); } const current = studioStore().work(w.id); syncAgentProject(current); syncAgentCalls(current); reconciled.set(w.id, JSON.stringify(current)); })();
  syncing.set(w.id, job); try { await job; } finally { syncing.delete(w.id); }
}
/** Also reconciles pre-feature imported works using their existing receipts; never invokes a model. */
export async function syncAgentCatalog() { for (const w of studioStore().works()) await syncAgentWork(w); }
export function agentArtifactIndex() {
  return new Map(studioStore().works().flatMap(w => w.versions.flatMap(v => (v.artifacts || []).map(a => [a.id, { ...a, workId: w.id, versionId: v.id, detailHref: agentProjectHref(w.id, v.id), ...(a.role === "upscale" && superResolutionTasks(v).find(t => `agent-upscale-${t.requestId}` === a.id)?.result) }] as const))));
}

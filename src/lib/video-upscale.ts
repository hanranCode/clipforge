import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isObjectStorageConfigured, type ObjectStorageConfig } from "@/lib/object-storage";
import { objectKeyFor, presignUrl, uploadToObjectStorage } from "@/lib/object-storage-server";
import { requireServerObjectStorage } from "@/lib/server-object-storage";
import { assertVideoResource } from "@/lib/media-resource-cache";
import { callAiNodes, aiNodesConfigured } from "@/lib/agent-studio/ai-nodes-client";
import { parseUpscaleParameters } from "@/lib/agent-studio/upscale-options";
import type { SuperResolutionTask } from "@/lib/agent-studio/types";

export type UpscaleAction = "start" | "restart" | "status" | "refresh" | "cancel";
export const upscalePending = (task: SuperResolutionTask) => ["submitting", "processing", "waiting_for_output_url", "unknown"].includes(task.status);
export interface UpscaleSource {
  key: string;
  inputFile: () => Promise<string>;
  tasks: () => SuperResolutionTask[];
  append: (task: SuperResolutionTask) => void;
  update: (id: string, change: (task: SuperResolutionTask) => void) => void;
  resourceUrl: (id: string) => string;
  onCompleted?: (task: SuperResolutionTask) => Promise<void>;
  onSubmitted?: () => void;
  logPrefix: string;
}
const active = new Set<string>();
const LINK_SECONDS = 48 * 3600;
export function upscaleStorageConfig(): ObjectStorageConfig {
  const c = requireServerObjectStorage();
  if (!isObjectStorageConfigured(c)) throw new Error("请先配置火山引擎对象存储 / Configure Volcengine TOS");
  const url = new URL(c.endpoint);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || !/^tos-s3-[a-z0-9-]+\.volces\.com$/.test(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("请使用火山 TOS 的 HTTPS S3 Endpoint / Use a Volcengine TOS HTTPS S3 endpoint");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket)) throw new Error("TOS Bucket 名称无效 / Invalid TOS bucket");
  return c;
}
const identity = (c: ObjectStorageConfig) => ({ endpoint: c.endpoint.trim().replace(/\/+$/, ""), region: c.region.trim(), bucket: c.bucket.trim(), pathStyle: Boolean(c.pathStyle) });
const destination = (c: ObjectStorageConfig, key: string) => ({
  put_url: presignUrl(c, { method: "PUT", key, expiresSeconds: LINK_SECONDS }),
  read_url: presignUrl(c, { method: "GET", key, expiresSeconds: LINK_SECONDS }),
  headers: { "Content-Type": "video/mp4" },
});

/** Persist a unique workflow before uploading/submitting; uncertainty only permits querying that ID. */
export async function runVideoUpscale(source: UpscaleSource, action: UpscaleAction, options?: unknown, requestId?: string) {
  if (active.has(source.key)) return;
  active.add(source.key);
  const update = source.update;
  try {
    // With no active local operation, a submitting task without the durable
    // pre-submit marker was interrupted during upload. No workflow was started.
    // Once the marker exists, preserve uncertainty and only query that workflow.
    for (const task of source.tasks()) {
      if (task.status === "submitting" && !task.apiCallId) {
        update(task.requestId, t => { t.status = "failed"; t.error = "输入视频上传中断，未提交超分 / Input upload interrupted; no workflow submitted"; });
      }
    }
    if (action === "start" || action === "restart") {
      const parameters = parseUpscaleParameters(options), history = source.tasks();
      if (history.some(upscalePending) || action === "start" && history.some(t => t.status === "completed")) return;
      if (!aiNodesConfigured()) throw new Error("请先配置 AI Nodes Temporal 连接与证书 / Configure AI Nodes Temporal credentials first");
      const c = upscaleStorageConfig(), file = await source.inputFile(), info = await stat(file);
      if (!info.isFile() || !info.size || info.size > 200_000_000) throw new Error("视频需为非空文件且不超过200MB / Video must be nonempty and at most 200MB");
      const id = randomUUID();
      const task: SuperResolutionTask = { requestId: id, workflowId: `media-sr-${id}`, status: "submitting", objectKey: objectKeyFor(c, "upscaled.mp4"), storage: identity(c), parameters, createdAt: Date.now() };
      source.append(task);
      let inputUrl: string;
      try { inputUrl = await uploadToObjectStorage(c, file); }
      catch { update(id, t => { t.status = "failed"; t.error = "输入视频上传失败，未提交超分 / Input upload failed; no workflow submitted"; }); return; }
      update(id, t => { t.apiCallId = `${source.logPrefix}-${id}`; });
      try {
        const result = await callAiNodes("submit", task.workflowId, { schema_version: "1", request_id: id, input_url: inputUrl, target: parameters.target, video_preset: parameters.videoPreset, seed: parameters.seed, output: destination(c, task.objectKey) });
        if (result.workflow_id !== task.workflowId || typeof result.run_id !== "string") throw new Error("Invalid submission receipt");
        update(id, t => { t.status = "processing"; t.runId = result.run_id as string; });
        source.onSubmitted?.();
      } catch { update(id, t => { t.status = "unknown"; t.error = "提交结果待确认，请查询原任务 / Submission unconfirmed; query existing workflow"; }); }
      return;
    }
    const history = source.tasks();
    const task = requestId ? history.find(t => t.requestId === requestId) : history.find(upscalePending) || history.at(-1);
    if (requestId && !task) throw new Error("超分任务不存在 / Upscale task not found");
    if (!task) return;
    if (task.status === "completed") { await source.onCompleted?.(task); return; }
    if (!upscalePending(task)) return;
    if (action === "cancel") { await callAiNodes("cancel", task.workflowId); return; }
    if (action === "refresh") {
      if (task.status !== "waiting_for_output_url") throw new Error("任务尚未请求更新上传地址 / Workflow is not waiting for an output URL");
      const c = upscaleStorageConfig();
      if (JSON.stringify(identity(c)) !== JSON.stringify(task.storage)) throw new Error("请恢复此任务提交时的 TOS Endpoint、区域与 Bucket / Restore this task's original TOS configuration");
      await callAiNodes("set-output", task.workflowId, destination(c, task.objectKey));
      update(task.requestId, t => { t.status = "processing"; delete t.error; });
      return;
    }
    const response = await callAiNodes("status", task.workflowId);
    if (response.status === "COMPLETED") {
      const result = await callAiNodes("result", task.workflowId);
      if (result.request_id !== task.requestId || result.media_type !== "video" || result.upload_mode !== "presigned_put" || !Number.isInteger(result.bytes) || typeof result.sha256 !== "string") throw new Error("超分结果校验失败 / Invalid upscale result");
      const metadata = { sha256: result.sha256 as string, bytes: Number(result.bytes), width: Number(result.width), height: Number(result.height) };
      assertVideoResource({ ...metadata, storage: task.storage, objectKey: task.objectKey });
      update(task.requestId, t => { t.status = "completed"; t.completedAt = Date.now(); t.result = metadata; t.outputUrl = source.resourceUrl(task.requestId); delete t.error; });
      await source.onCompleted?.(source.tasks().find(t => t.requestId === task.requestId)!);
    } else if (["FAILED", "CANCELED", "TERMINATED", "TIMED_OUT"].includes(String(response.status))) {
      update(task.requestId, t => { t.status = response.status === "CANCELED" ? "cancelled" : "failed"; t.error = `AI Nodes: ${response.status}`; });
    } else if (response.status === "RUNNING") {
      update(task.requestId, t => { t.status = response.stage === "waiting_for_output_url" ? "waiting_for_output_url" : "processing"; delete t.error; });
    } else throw new Error("AI Nodes 任务状态无法确认 / Unable to confirm workflow status");
  } finally { active.delete(source.key); }
}

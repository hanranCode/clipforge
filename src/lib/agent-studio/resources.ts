import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { existsSync } from "node:fs";
import { getOutputDir } from "@/lib/paths";
import { probeMedia } from "@/lib/media-probe";
import { cachedVideo, hashFile, type VideoResource } from "@/lib/media-resource-cache";
import { studioStore } from "./store";
import { superResolutionTasks, type AgentWork, type WorkVersion, type SuperResolutionTask } from "./types";

export const agentResourceUrl = (requestId: string) => `/api/agent-studio/resources/${requestId}`;
function saveResult(w: AgentWork, v: WorkVersion, task: SuperResolutionTask, result: SuperResolutionTask["result"]) {
  studioStore().update(w.id, work => {
    const version = work.versions.find(x => x.id === v.id)!;
    for (const sr of [version.superResolution, ...(version.superResolutions || [])]) if (sr?.requestId === task.requestId) { sr.result = result; sr.outputUrl = agentResourceUrl(sr.requestId); }
  });
}
export async function legacyResourceFile(w: AgentWork, v: WorkVersion, task: SuperResolutionTask) {
  if (![w.id, v.id, task.requestId].every(id => /^[a-zA-Z0-9-]+$/.test(id))) return undefined;
  const file = join(getOutputDir(), "agent-studio", w.id, "versions", v.id, `upscaled-${task.requestId}.mp4`);
  if (!existsSync(file)) return undefined;
  const [path, root] = await Promise.all([realpath(file), realpath(getOutputDir())]);
  return path.startsWith(root + sep) ? path : undefined;
}
/** Upgrade pre-cache completed results from their existing local file, without a cloud read. */
export async function migrateAgentResource(w: AgentWork, v: WorkVersion, task: SuperResolutionTask) {
  if (task.status !== "completed") return;
  if (task.result) { if (task.outputUrl !== agentResourceUrl(task.requestId)) saveResult(w, v, task, task.result); return; }
  const file = await legacyResourceFile(w, v, task); if (!file) return;
  const [info, media, sha256] = await Promise.all([stat(file), probeMedia(file), hashFile(file)]);
  const result = { sha256, bytes: info.size, width: media.width, height: media.height };
  await cachedVideo({ ...result, storage: task.storage, objectKey: task.objectKey }, file);
  saveResult(w, v, task, result);
}
export async function agentResourceFile(requestId: string) {
  for (const w of studioStore().works()) for (const v of w.versions) {
    const task = superResolutionTasks(v).find(t => t.requestId === requestId);
    if (!task) continue;
    if (task.status !== "completed") throw new Error("资源尚未完成 / Resource is not ready");
    await migrateAgentResource(w, v, task);
    const current = superResolutionTasks(studioStore().work(w.id).versions.find(x => x.id === v.id)!).find(t => t.requestId === requestId)!;
    if (!current.result) throw new Error("资源元数据尚不可用 / Resource metadata is unavailable");
    const r: VideoResource = { ...current.result, storage: current.storage, objectKey: current.objectKey };
    const file = await cachedVideo(r, await legacyResourceFile(w, v, current));
    return { file, resource: r };
  }
  throw new Error("NOT_FOUND");
}
export async function agentResourceSource(url: string) {
  const match = /^\/api\/agent-studio\/resources\/([a-zA-Z0-9-]+)$/.exec(url);
  return match ? (await agentResourceFile(match[1])).file : null;
}

import { copyFile, link, mkdir, realpath, rename, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiCalls, libraryAssets, settings } from "@/lib/db/schema";
import { getUploadsDir } from "@/lib/paths";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { cachedVideo } from "@/lib/media-resource-cache";
import { probeMedia } from "@/lib/media-probe";
import { buildPayload } from "@/lib/api-call-log";
import { runVideoUpscale, upscalePending, type UpscaleAction } from "@/lib/video-upscale";
import type { SuperResolutionTask } from "@/lib/agent-studio/types";

const taskKey = (id: string) => `remake-upscale:${id}`;
export function remakeUpscaleSource(id: string) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("NOT_FOUND");
  const asset = getDb().select().from(libraryAssets).where(eq(libraryAssets.id, id)).get();
  if (!asset || asset.mediaType !== "video" || !asset.tags.includes("视频复刻")) throw new Error("NOT_FOUND");
  return asset;
}
export function remakeUpscaleTasks(id: string): SuperResolutionTask[] {
  const row = getDb().select().from(settings).where(eq(settings.key, taskKey(id))).get();
  if (!row) return [];
  const value = row.value as { tasks?: SuperResolutionTask[] };
  if (!value || !Array.isArray(value.tasks)) throw new Error("超分记录无效，请检查服务端数据 / Invalid upscale history");
  return value.tasks;
}
function save(id: string, tasks: SuperResolutionTask[]) {
  const value = { tasks }, updatedAt = new Date();
  getDb().insert(settings).values({ key: taskKey(id), value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
  for (const task of tasks) {
    if (!task.apiCallId) continue;
    const values = { modelType: "video" as const, scene: "remake_upscale", provider: "ai-nodes", model: `flashvsr-plus-${task.parameters?.videoPreset || "base"}`, endpoint: "MediaSuperResolutionWorkflowV1", taskId: task.workflowId,
      status: ["failed", "cancelled"].includes(task.status) ? "failed" as const : "success" as const,
      request: buildPayload("视频复刻 → 1080P", { sourceAssetId: id, ...task.parameters }),
      response: buildPayload(task.status, { state: task.status, workflowId: task.workflowId, output: task.outputUrl }), error: task.error ?? null };
    getDb().insert(apiCalls).values({ id: task.apiCallId, ...values, createdAt: new Date(task.createdAt) }).onConflictDoUpdate({ target: apiCalls.id, set: values }).run();
  }
}
function update(id: string, requestId: string, change: (task: SuperResolutionTask) => void) {
  const tasks = remakeUpscaleTasks(id), task = tasks.find(t => t.requestId === requestId);
  if (!task) throw new Error("NOT_FOUND");
  change(task); save(id, tasks);
}
async function inputFile(url: string) {
  const path = resolveUploadFilePath(url);
  if (!path) throw new Error("原成片没有本地文件 / The original video is not available locally");
  const [file, root] = await Promise.all([realpath(path), realpath(getUploadsDir())]);
  if (!file.startsWith(root + sep)) throw new Error("视频文件无效 / Invalid video file");
  return file;
}
/** Archive verified bytes separately so a super-resolved result is also reusable from the library. */
async function archive(id: string, task: SuperResolutionTask) {
  if (!task.result) throw new Error("超分结果元数据缺失 / Missing upscale metadata");
  const source = remakeUpscaleSource(id), libraryId = `remake-upscale-${task.requestId}`;
  const existing = getDb().select().from(libraryAssets).where(eq(libraryAssets.id, libraryId)).get();
  if (existing) { update(id, task.requestId, t => { t.outputUrl = existing.filePath; delete t.error; }); return; }
  try {
    const file = await cachedVideo({ ...task.result, storage: task.storage, objectKey: task.objectKey });
    const [media, original] = await Promise.all([probeMedia(file), probeMedia(await inputFile(source.filePath))]);
    if (Math.min(media.width, media.height) < 1080 || media.width !== task.result.width || media.height !== task.result.height || Math.abs(media.duration - original.duration) > 0.5 || original.hasAudio && !media.hasAudio) throw new Error("Invalid upscale media");
    const directory = join(getUploadsDir(), "_library"), name = `${libraryId}.mp4`, output = join(directory, name);
    await mkdir(directory, { recursive: true });
    try { await link(file, output); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        const partial = `${output}.partial`;
        try { await copyFile(file, partial); await rename(partial, output); }
        finally { await rm(partial, { force: true }); }
      }
    }
    const filePath = `/api/files/_library/${name}`;
    getDb().insert(libraryAssets).values({ id: libraryId, mediaType: "video", importSource: "generated", provider: "ai-nodes", model: `flashvsr-plus-${task.parameters?.videoPreset || "base"}`,
      filePath, title: `${source.title} · 1080P`, sourceUrl: source.filePath, prompt: JSON.stringify(task.parameters), tags: ["视频复刻", "1080P超分"],
      sizeBytes: task.result.bytes, width: media.width, height: media.height, durationSec: media.duration, objectKey: task.objectKey, objectBucket: task.storage.bucket, objectEndpoint: task.storage.endpoint,
    }).onConflictDoNothing().run();
    update(id, task.requestId, t => { t.outputUrl = filePath; delete t.error; });
  } catch {
    update(id, task.requestId, t => { delete t.outputUrl; t.error = "超分已完成，结果下载或校验未完成，请重新查询 / Upscale finished; query again to archive and verify the result"; });
    throw new Error("超分结果下载或校验未完成，请重新查询原任务 / Query the existing upscale again to finish archiving");
  }
}
export async function syncRemakeUpscales(id: string) {
  remakeUpscaleSource(id);
  for (const task of remakeUpscaleTasks(id)) if (task.status === "completed" && !task.outputUrl) await archive(id, task);
}
export async function upscaleRemake(id: string, action: UpscaleAction, parameters?: unknown, requestId?: string) {
  const source = remakeUpscaleSource(id);
  await runVideoUpscale({ key: `remake/${id}`, logPrefix: "remake-upscale", tasks: () => remakeUpscaleTasks(id), inputFile: () => inputFile(source.filePath),
    append: task => {
      getDb().transaction(() => {
        const tasks = remakeUpscaleTasks(id);
        if (tasks.some(upscalePending) || action === "start" && tasks.some(t => t.status === "completed")) throw new Error("此成片已有超分任务，请查询原任务 / An upscale already exists");
        save(id, [...tasks, task]);
      });
    }, update: (requestId, change) => update(id, requestId, change),
    resourceUrl: () => "", onCompleted: task => archive(id, task),
  }, action, parameters, requestId);
}

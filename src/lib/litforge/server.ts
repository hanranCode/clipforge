import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { getOutputDir } from "@/lib/paths";
import { objectKeyFor, presignUrl, uploadToObjectStorage } from "@/lib/object-storage-server";
import { requireServerObjectStorage, sameStorage } from "@/lib/server-object-storage";
import { assertVideoResource, cachedVideo, type VideoResource } from "@/lib/media-resource-cache";
import { callAiNodes, aiNodesConfigured } from "@/lib/agent-studio/ai-nodes-client";
import { LITFORGE_MODELS, litforgeCapability, type LitforgeCapability } from "./catalog";
import type { TaskStatus, VideoOptions } from "@/lib/providers/types";

interface Receipt {
  requestId: string; workflowId: string; runId?: string; model: string; status: "submitting" | "processing" | "waiting_for_output_url" | "unknown" | "failed" | "cancelled";
  objectKey: string; storage: VideoResource["storage"]; createdAt: number; result?: VideoResource; duration?: number;
  expected?: { width: number; height: number; frames: number; fps: number };
  hasAudio?: boolean;
}
const key = (id: string) => `litforge-task:${id}`;
function save(r: Receipt) {
  const value = r, updatedAt = new Date();
  getDb().insert(settings).values({ key: key(r.workflowId), value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
}
export function litforgeReceipt(id: string): Receipt {
  if (!/^(?:wan-vace|wan-animate|media-sr)-[a-f0-9-]{36}$/.test(id)) throw new Error("LitForge 任务ID无效 / Invalid task ID");
  const row = getDb().select().from(settings).where(eq(settings.key, key(id))).get();
  if (!row) throw new Error("LitForge 任务不存在 / Task not found");
  return row.value as Receipt;
}
export function litforgeOutputFile(url: string): string | null {
  const match = /^\/api\/output\/litforge\/((?:wan-vace|wan-animate|media-sr)-[a-f0-9-]{36})\.mp4$/.exec(url);
  return match ? join(getOutputDir(), "litforge", `${match[1]}.mp4`) : null;
}
export function callLitforge(command: Parameters<typeof callAiNodes>[0], id: string, payload?: unknown, capability: LitforgeCapability = litforgeCapability(LITFORGE_MODELS.upscale)) {
  return callAiNodes(command, id, payload, capability);
}
function https(value: string | undefined) {
  if (!value) throw new Error("LitForge 缺少参考素材 / Missing reference media");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password) throw new Error("LitForge 参考素材需要 HTTPS/443 地址 / References require HTTPS/443 URLs");
  return value;
}
/** Validate model semantics before writing an attempt or submitting any Workflow. */
export function litforgeRequest(options: VideoOptions, requestId: string) {
  const capability = litforgeCapability(options.modelId);
  const images = options.referenceImageUrls ?? (options.firstFrameUrl ? [options.firstFrameUrl] : []);
  const videos = options.referenceVideoUrls ?? (options.referenceVideoUrl ? [options.referenceVideoUrl] : []);
  if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 2147483647)) throw new Error("Invalid seed");
  if (options.referenceAudioUrls?.length) throw new Error("LitForge 不接收参考音频；口播在本地合成 / Audio must be composed locally");
  if (options.modelId === LITFORGE_MODELS.upscale) {
    if (videos.length !== 1) throw new Error("超分需要一条源视频 / Upscale requires one video");
    return { schema_version: "1", request_id: requestId, input_url: https(videos[0]), target: "1080p", video_preset: "base", seed: options.seed ?? 1 };
  }
  const replace = options.modelId === LITFORGE_MODELS.replace;
  if (images.length < 1 || images.length > (replace ? 1 : 2) || videos.length !== 1) throw new Error(replace ? "人物替换需要一张人物参考图和一条单人视频 / Replace requires one portrait and one single-person video" : "VACE 参考生成需要一条控制视频及1–2张参考图 / VACE requires one control video and 1–2 reference images");
  if (!replace && !options.prompt.trim()) throw new Error("VACE 需要非空提示词 / Prompt required");
  const duration = options.duration ?? (replace ? 77 / 30 : 5);
  const frames = (replace ? Math.floor((duration * capability.fps - 1) / 4) : Math.ceil((duration * capability.fps - 1) / 4)) * 4 + 1;
  if (!Number.isFinite(duration) || duration <= 0 || frames < 5 || frames > capability.maxFrames) throw new Error(replace ? "人物替换单段最长10秒 / Replace supports up to 10 seconds" : "VACE 单段最长5秒，请重新分段 / VACE supports up to 5 seconds per segment");
  const width = options.width ?? 480, height = options.height ?? 832;
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 1280 && n % 16 === 0) || width * height > 1280 * 720) throw new Error("LitForge 宽高需为16倍数，面积不超过720P / Invalid dimensions");
  const seed = options.seed ?? 42;
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw new Error("Invalid seed");
  if (options.prompt.length > 4000 || (options.negativePrompt?.length ?? 0) > 4000) throw new Error("LitForge 提示词最多4000字符 / Prompt too long");
  return { schema_version: "1", request_id: requestId, mode: replace ? "replace" : "control_reference", prompt: options.prompt, negative_prompt: options.negativePrompt ?? "", width, height, seed, num_frames: frames, fps: capability.fps, steps: replace ? 20 : 50, audio: replace && options.audioEnabled ? "copy_source" : "none", video_url: https(videos[0]),
    ...(replace ? { reference_image_url: https(images[0]), retarget: "none", relighting: true } : { control_type: "canny", reference_image_urls: images.map(https) }) };
}
export async function submitLitforgeVideo(options: VideoOptions) {
  if (!aiNodesConfigured()) throw new Error("请配置服务端 AI Nodes Caller 凭据 / Configure server Caller credentials");
  options = await prepareLitforgeOptions(options);
  const capability = litforgeCapability(options.modelId), id = randomUUID();
  const request = litforgeRequest(options, id), c = requireServerObjectStorage();
  const receipt: Receipt = { requestId: id, workflowId: `${capability.prefix}-${id}`, model: options.modelId, status: "submitting", objectKey: objectKeyFor(c, "litforge.mp4"), storage: { endpoint: c.endpoint, region: c.region, bucket: c.bucket, pathStyle: Boolean(c.pathStyle) }, createdAt: Date.now(), duration: options.duration };
  if ("num_frames" in request) receipt.expected = { width: request.width, height: request.height, frames: request.num_frames, fps: request.fps };
  if ("audio" in request) receipt.hasAudio = request.audio === "copy_source";
  // Save the deterministic handle before the network; never resubmit when acknowledgment is lost.
  save(receipt);
  try {
    const result = await callLitforge("submit", receipt.workflowId, { ...request, output: output(receipt) }, capability);
    if (result.workflow_id !== receipt.workflowId || typeof result.run_id !== "string") throw new Error("Invalid receipt");
    receipt.runId = result.run_id; receipt.status = "processing";
  } catch { receipt.status = "unknown"; }
  save(receipt);
  return { taskId: receipt.workflowId, modelId: options.modelId };
}
export async function prepareLitforgeOptions(options: VideoOptions): Promise<VideoOptions> {
  const rawImages = options.referenceImageUrls ?? (options.firstFrameUrl ? [options.firstFrameUrl] : []);
  // Validate counts, time, dimensions and prompt before even uploading the immutable images.
  litforgeRequest({ ...options, referenceImageUrls: rawImages.map(() => "https://validation.example/image") }, "validate");
  requireServerObjectStorage();
  options = { ...options, referenceImageUrls: await Promise.all(rawImages.map(uploadLitforgeImage)) };
  litforgeRequest(options, "validate");
  return options;
}
/** Agent references are immutable data images; only the uploaded URL enters the encrypted Workflow. */
export async function uploadLitforgeImage(value: string): Promise<string> {
  if (value.startsWith("https:")) return https(value);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match || value.length > 28_000_000) throw new Error("参考图需要 HTTPS 或有效图片 / Invalid reference image");
  const dir = await mkdtemp(join(tmpdir(), "litforge-reference-"));
  try {
    const file = join(dir, match[1] === "image/png" ? "ref.png" : match[1] === "image/webp" ? "ref.webp" : "ref.jpg");
    await writeFile(file, Buffer.from(match[2], "base64"), { mode: 0o600 });
    return await uploadToObjectStorage(requireServerObjectStorage(), file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function output(r: Receipt) {
  const c = requireServerObjectStorage();
  if (!sameStorage(c, r.storage)) throw new Error("请恢复任务提交时的对象存储配置 / Restore original object storage");
  return { put_url: presignUrl(c, { method: "PUT", key: r.objectKey, expiresSeconds: 48 * 3600 }), read_url: presignUrl(c, { method: "GET", key: r.objectKey, expiresSeconds: 48 * 3600 }), headers: { "Content-Type": "video/mp4" } };
}
async function completed(r: Receipt): Promise<TaskStatus> {
  const file = await cachedVideo(r.result!);
  const dir = join(getOutputDir(), "litforge"); await mkdir(dir, { recursive: true });
  const final = join(dir, `${r.workflowId}.mp4`), partial = `${final}.${randomUUID()}.partial`;
  try { await copyFile(file, partial); await rename(partial, final); } finally { await rm(partial, { force: true }); }
  return { taskId: r.workflowId, status: "completed", result: { taskId: r.workflowId, modelId: r.model, videoUrls: [`/api/output/litforge/${r.workflowId}.mp4`], ...(r.expected && { duration: r.expected.frames / r.expected.fps }), ...(r.model !== LITFORGE_MODELS.upscale && { hasAudio: r.hasAudio ?? false }), extra: { sha256: r.result!.sha256, bytes: r.result!.bytes, width: r.result!.width, height: r.result!.height } } };
}
export async function litforgeTaskStatus(id: string): Promise<TaskStatus> {
  const r = litforgeReceipt(id), capability = litforgeCapability(r.model);
  if (r.result) return completed(r);
  const state = await callLitforge("status", id, undefined, capability);
  if (["FAILED", "TIMED_OUT", "TERMINATED", "CANCELED"].includes(String(state.status))) { r.status = state.status === "CANCELED" ? "cancelled" : "failed"; save(r); return { taskId: id, status: r.status, error: `LitForge: ${state.status}` }; }
  if (state.status === "RUNNING") { r.status = state.stage === "waiting_for_output_url" ? "waiting_for_output_url" : "processing"; save(r); return { taskId: id, status: "processing", ...(state.stage === "waiting_for_output_url" && { error: "等待刷新输出地址 / Refresh output destination" }) }; }
  if (state.status !== "COMPLETED") throw new Error("LitForge 提交状态待确认，请查询原任务 / Query the original task; submission unconfirmed");
  const value = await callLitforge("result", id, undefined, capability);
  if (value.request_id !== r.requestId || value.media_type !== "video" || value.upload_mode !== "presigned_put" || typeof value.sha256 !== "string") throw new Error("LitForge 结果身份无效 / Invalid result identity");
  const result: VideoResource = { storage: r.storage, objectKey: r.objectKey, sha256: value.sha256, bytes: Number(value.bytes), width: Number(value.width), height: Number(value.height) };
  assertVideoResource(result);
  if (r.model !== LITFORGE_MODELS.upscale && (value.fps !== capability.fps || !Number.isInteger(value.frames) || Number(value.frames) < 5 || Number(value.frames) > capability.maxFrames)) throw new Error("LitForge 输出帧率或帧数无效 / Invalid output timeline");
  if (r.expected && (value.width !== r.expected.width || value.height !== r.expected.height || value.frames !== r.expected.frames || value.fps !== r.expected.fps)) throw new Error("LitForge 输出与提交参数不一致 / Output does not match submitted parameters");
  r.result = result; save(r);
  return completed(r);
}
export async function controlLitforgeTask(id: string, operation: "cancel" | "refresh") {
  const r = litforgeReceipt(id);
  if (r.result) return;
  if (operation === "refresh") {
    const state = await callLitforge("status", id, undefined, litforgeCapability(r.model));
    if (state.status !== "RUNNING" || state.stage !== "waiting_for_output_url") throw new Error("任务未等待输出地址 / Not waiting for output destination");
  }
  await callLitforge(operation === "cancel" ? "cancel" : "set-output", id, operation === "refresh" ? output(r) : undefined, litforgeCapability(r.model));
}

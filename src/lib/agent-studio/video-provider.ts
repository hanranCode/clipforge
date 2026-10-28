import { join } from "node:path";
import { AlibabaProvider } from "@/lib/providers/alibaba";
import { AtlasCloudProvider } from "@/lib/providers/atlas-cloud";
import { LitForgeProvider } from "@/lib/providers/litforge";
import { prepareLitforgeOptions } from "@/lib/litforge/server";
import { ProviderError } from "@/lib/providers/base";
import { uploadToObjectStorage } from "@/lib/object-storage-server";
import type { ObjectStorageConfig } from "@/lib/object-storage";
import { requireServerObjectStorage } from "@/lib/server-object-storage";
import type { VideoOptions } from "@/lib/providers/types";
import type { StudioVideoSnapshot } from "./video-models";

export class StudioRequestError extends Error { constructor(message: string, readonly rejected: boolean) { super(message); } }
export async function arkRequest(path: string, key: string, baseUrl?: string, body?: unknown) {
  const response = await fetch(`${baseUrl || "https://ark.cn-beijing.volces.com/api/v3"}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90_000) });
  const json = await response.json();
  if (!response.ok) throw new StudioRequestError(`火山引擎 ${response.status}: ${String(json.error?.code || "")} ${String(json.error?.message || "请求失败").slice(0, 500)}`, response.status >= 400 && response.status < 500 && response.status !== 408);
  return json;
}
function provider(video: StudioVideoSnapshot, apiKey: string) {
  const config = { name: video.provider, apiKey, baseUrl: video.baseUrl || "" };
  return video.provider === "litforge" ? new LitForgeProvider(config) : video.provider === "alibaba" ? new AlibabaProvider(config) : new AtlasCloudProvider(config);
}
/** Upload audio before marking a paid submission in flight. Bailian requires a remotely reachable audio URL. */
export async function prepareStudioVideo(video: StudioVideoSnapshot, apiKey: string, content: unknown[], directory: string, index: number, duration: number, storage?: ObjectStorageConfig): Promise<VideoOptions> {
  if (video.provider === "atlas-cloud" && !content.some(item => Boolean((item as { image_url?: unknown }).image_url))) {
    throw new Error("Atlas参考生视频需要参考图；请添加商品/主播/场地图片，或选择百炼/火山的纯文字生成 / This Atlas model requires a reference image");
  }
  const images: string[] = [], audios: string[] = [];
  let prompt = "";
  for (const raw of content) {
    const item = raw as { type: string; text?: string; image_url?: { url: string }; audio_url?: { url: string } };
    if (item.type === "text") prompt = item.text || "";
    if (item.image_url) images.push(item.image_url.url);
    if (item.audio_url && video.provider !== "litforge") {
      const file = join(directory, `voice-${index}.wav`);
      const remote = video.provider === "atlas-cloud"
        ? await new AtlasCloudProvider({ name: video.provider, apiKey, baseUrl: video.baseUrl || "" }).uploadLocalMedia(file)
        : await uploadToObjectStorage(storage ?? requireServerObjectStorage(), file);
      audios.push(remote);
    }
  }
  const height = video.provider === "litforge" ? 832 : video.resolution === "480p" ? 864 : video.resolution === "720p" ? 1280 : 1920;
  const width = video.provider === "litforge" ? 480 : video.resolution === "480p" ? 496 : video.resolution === "720p" ? 720 : 1080;
  const control = video.provider === "litforge" ? await uploadToObjectStorage(requireServerObjectStorage(), join(directory, `source-${index}.mp4`)) : undefined;
  const options: VideoOptions = { modelId: video.model, mode: images.length ? "video-to-video" : "text-to-video", prompt, width, height, duration, audioEnabled: true,
    ...(control && { referenceVideoUrls: [control] }),
    referenceImageUrls: images, referenceAudioUrls: audios,
    extra: video.provider === "alibaba" ? { resolution: video.resolution.toUpperCase(), ratio: "9:16", prompt_extend: true } : { resolution: video.resolution, ratio: "9:16" } };
  return video.provider === "litforge" ? prepareLitforgeOptions(options) : options;
}
export async function submitStudioVideo(video: StudioVideoSnapshot, key: string, content: unknown[], duration: number, options?: VideoOptions): Promise<string> {
  try {
    if (video.provider === "volcengine") {
      const result = await arkRequest("/contents/generations/tasks", key, video.baseUrl, { model: video.model, content, duration, ratio: "9:16", resolution: video.resolution, generate_audio: true, watermark: false });
      if (!result.id || typeof result.id !== "string") throw new Error("云端响应缺少任务ID");
      return result.id;
    }
    if (!options) throw new Error("视频请求尚未准备");
    return (await provider(video, key).submitVideoTask(options)).taskId;
  } catch (error) {
    if (error instanceof ProviderError && error.statusCode && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408) throw new StudioRequestError(error.message, true);
    throw error;
  }
}
export async function studioTaskStatus(video: StudioVideoSnapshot, key: string, taskId: string) {
  if (video.provider === "volcengine") return arkRequest(`/contents/generations/tasks/${encodeURIComponent(taskId)}`, key, video.baseUrl);
  const status = await provider(video, key).getTaskStatus(taskId);
  const result = status.result;
  return { status: status.status === "completed" ? "succeeded" : status.status === "cancelled" ? "cancelled" : status.status,
    usage: result?.extra?.usage as Record<string, unknown> | undefined, model: result?.modelId || undefined, content: { video_url: result && "videoUrls" in result ? result.videoUrls[0] : undefined },
    error: { message: status.error, code: status.errorCode } };
}

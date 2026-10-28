import { BaseProvider, ProviderError } from "./base";
import type { MediaType, Model, VideoOptions } from "./types";
import { LITFORGE_CAPABILITIES } from "@/lib/litforge/catalog";
import { litforgeTaskStatus, prepareLitforgeOptions, submitLitforgeVideo } from "@/lib/litforge/server";
import { uploadToObjectStorage } from "@/lib/object-storage-server";
import { requireServerObjectStorage } from "@/lib/server-object-storage";

/** Temporary native adapter; public provider identity stays independent of its execution transport. */
export class LitForgeProvider extends BaseProvider {
  readonly name = "litforge";
  readonly displayName = "LitForge";
  async generateImage(): Promise<never> { throw new ProviderError("LitForge 暂未开放图片接口 / Image API unavailable", "UNSUPPORTED_MODE", this.name, 400); }
  async submitVideoTask(options: VideoOptions) {
    let prepared: VideoOptions;
    try { prepared = await prepareLitforgeOptions(options); }
    catch (e) { throw new ProviderError(e instanceof Error ? e.message : "LitForge input rejected", "INVALID_REQUEST", this.name, 400); }
    return submitLitforgeVideo(prepared);
  }
  async generateVideo(options: VideoOptions) {
    const { taskId } = await this.submitVideoTask(options);
    const status = await this.waitForTask(taskId);
    if (!status.result || !("videoUrls" in status.result)) throw new Error("Missing video result");
    return status.result;
  }
  async getTaskStatus(taskId: string) { return litforgeTaskStatus(taskId); }
  async uploadLocalMedia(filePath: string) { return uploadToObjectStorage(requireServerObjectStorage(), filePath); }
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    if (mediaType === "image") return [];
    return LITFORGE_CAPABILITIES.map(c => ({ id: c.model, name: c.name, provider: this.name, mediaType: "video", modes: ["video-to-video"], supportsAudio: false, extra: { capabilityId: c.id, workflow: c.workflow, maxFrames: c.maxFrames, fps: c.fps } }));
  }
}

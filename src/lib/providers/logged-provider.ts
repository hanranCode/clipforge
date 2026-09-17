/**
 * Recording layer for media generation (image / video).
 *
 * Applied by `createProvider`, so every platform and every call site is covered by construction —
 * including the two-phase video flow, where the row is written the moment the task is submitted and
 * patched when the result lands minutes later. That ordering matters: a submitted task is billed
 * whether or not the app is still around to see it finish, so the log must not wait for success.
 *
 * Read-only calls (listModels, getTaskStatus polling, uploads) are deliberately NOT recorded: they
 * cost nothing and would bury the generations that do.
 */

import type {
  AIProvider,
  ImageOptions,
  ImageResult,
  MediaType,
  Model,
  ProviderLogContext,
  TaskStatus,
  VideoOptions,
  VideoResult,
} from "./types";
import { buildPayload, recordApiCall, updateApiCall, type ApiCallUsage } from "@/lib/api-call-log";
import { estimateMediaCost } from "@/lib/model-pricing";
import { getCachedAtlasEntry } from "./atlas-catalog";

/** Published per-call price, when the platform's already-fetched catalog carries one (never fetches). */
function publishedUnitPrice(provider: string, modelId: string): number | undefined {
  if (provider !== "atlas-cloud") return undefined;
  const raw = Number(getCachedAtlasEntry(modelId)?.priceBase);
  return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/** The inputs worth keeping: prompt, mode, geometry, and where the reference media came from. */
function imageRequestDetail(options: ImageOptions) {
  const { referenceImageUrl, referenceImageUrls, ...rest } = options;
  const references = [referenceImageUrl, ...(referenceImageUrls ?? [])].filter(Boolean) as string[];
  return { ...rest, ...(references.length > 0 && { references }) };
}

function videoRequestDetail(options: VideoOptions) {
  const { firstFrameUrl, lastFrameUrl, referenceImageUrls, referenceVideoUrls, referenceAudioUrls, ...rest } = options;
  const references = [
    ...(firstFrameUrl ? [`first:${firstFrameUrl}`] : []),
    ...(lastFrameUrl ? [`last:${lastFrameUrl}`] : []),
    ...(referenceImageUrls ?? []).map((u) => `image:${u}`),
    ...(referenceVideoUrls ?? []).map((u) => `video:${u}`),
    ...(referenceAudioUrls ?? []).map((u) => `audio:${u}`),
  ];
  return { ...rest, ...(references.length > 0 && { references }) };
}

function geometry(options: { width?: number; height?: number }): string | undefined {
  return options.width && options.height ? `${options.width}x${options.height}` : undefined;
}

/**
 * Wrap a provider so its billable calls land in api_calls.
 * The returned object delegates everything else straight through, so provider-specific extras
 * (uploadLocalMedia, catalogMetadata) keep working unchanged.
 */
export function withApiLogging(provider: AIProvider, context: ProviderLogContext = {}): AIProvider {
  // submitVideoTask → waitForTask happen on the same provider instance within one request, so the
  // task id is enough to reunite the completion with the row opened at submit time.
  const pendingRows = new Map<string, { rowId: string | null; startedAt: number; options: VideoOptions }>();

  const logged: AIProvider = {
    get name() {
      return provider.name;
    },
    get displayName() {
      return provider.displayName;
    },
    get catalogMetadata() {
      return provider.catalogMetadata;
    },

    async generateImage(options: ImageOptions): Promise<ImageResult> {
      const startedAt = Date.now();
      const base = {
        ...context,
        modelType: "image" as const,
        scene: context.scene ?? "shot_image",
        provider: provider.name,
        model: options.modelId,
        endpoint: "generateImage",
        request: buildPayload(options.prompt, imageRequestDetail(options)),
      };
      try {
        const result = await provider.generateImage(options);
        const usage: ApiCallUsage = {
          imageCount: result.imageUrls?.length || options.count || 1,
          ...(geometry(options) && { resolution: geometry(options) }),
        };
        void recordApiCall({
          ...base,
          status: "success",
          latencyMs: Date.now() - startedAt,
          taskId: result.taskId,
          response: buildPayload(result.imageUrls?.[0], { imageUrls: result.imageUrls, seed: result.seed }),
          usage,
          cost: estimateMediaCost({
            model: options.modelId,
            mediaType: "image",
            imageCount: usage.imageCount,
            unitPriceUsd: publishedUnitPrice(provider.name, options.modelId),
          }),
        });
        return result;
      } catch (error) {
        void recordApiCall({
          ...base,
          status: "failed",
          latencyMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async generateVideo(options: VideoOptions): Promise<VideoResult> {
      const startedAt = Date.now();
      const base = {
        ...context,
        modelType: "video" as const,
        scene: context.scene ?? "shot_video",
        provider: provider.name,
        model: options.modelId,
        endpoint: "generateVideo",
        request: buildPayload(options.prompt, videoRequestDetail(options)),
      };
      try {
        const result = await provider.generateVideo(options);
        const seconds = result.duration ?? options.duration;
        void recordApiCall({
          ...base,
          status: "success",
          latencyMs: Date.now() - startedAt,
          taskId: result.taskId,
          response: buildPayload(result.videoUrls?.[0], { videoUrls: result.videoUrls, hasAudio: result.hasAudio }),
          usage: { ...(seconds && { videoSeconds: seconds }), ...(geometry(options) && { resolution: geometry(options) }) },
          cost: estimateMediaCost({
            model: options.modelId,
            mediaType: "video",
            videoSeconds: seconds,
            unitPriceUsd: publishedUnitPrice(provider.name, options.modelId),
          }),
        });
        return result;
      } catch (error) {
        void recordApiCall({
          ...base,
          status: "failed",
          latencyMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    ...(provider.submitVideoTask && {
      async submitVideoTask(options: VideoOptions) {
        const startedAt = Date.now();
        const submitted = await provider.submitVideoTask!(options).catch(async (error: unknown) => {
          await recordApiCall({
            ...context,
            modelType: "video",
            scene: context.scene ?? "shot_video",
            provider: provider.name,
            model: options.modelId,
            endpoint: "submitVideoTask",
            request: buildPayload(options.prompt, videoRequestDetail(options)),
            status: "failed",
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        });
        const seconds = options.duration;
        // Written as "success" with the cost already attributed: the task is billed at submission,
        // and waitForTask only downgrades it if the provider itself reports a failure.
        const rowId = await recordApiCall({
          ...context,
          modelType: "video",
          scene: context.scene ?? "shot_video",
          provider: provider.name,
          model: submitted.modelId || options.modelId,
          endpoint: "submitVideoTask",
          request: buildPayload(options.prompt, videoRequestDetail(options)),
          status: "success",
          latencyMs: Date.now() - startedAt,
          taskId: submitted.taskId,
          response: buildPayload("任务已提交", { taskId: submitted.taskId, modelId: submitted.modelId }),
          usage: { ...(seconds && { videoSeconds: seconds }), ...(geometry(options) && { resolution: geometry(options) }) },
          cost: estimateMediaCost({
            model: submitted.modelId || options.modelId,
            mediaType: "video",
            videoSeconds: seconds,
            unitPriceUsd: publishedUnitPrice(provider.name, submitted.modelId || options.modelId),
          }),
        });
        pendingRows.set(submitted.taskId, { rowId, startedAt, options });
        return submitted;
      },
    }),

    ...(provider.waitForTask && {
      async waitForTask(taskId: string, options?: { interval?: number; maxAttempts?: number }) {
        const pending = pendingRows.get(taskId);
        try {
          const status = await provider.waitForTask!(taskId, options);
          if (pending) {
            pendingRows.delete(taskId);
            const result = status.result;
            const videoUrls = result && "videoUrls" in result ? result.videoUrls : undefined;
            const failed = status.status === "failed" || status.status === "cancelled";
            void updateApiCall(pending.rowId, {
              status: failed ? "failed" : "success",
              latencyMs: Date.now() - pending.startedAt,
              response: buildPayload(videoUrls?.[0] ?? status.error, { videoUrls, status: status.status }),
              ...(status.error && { error: status.error }),
            });
          }
          return status;
        } catch (error) {
          if (pending) {
            pendingRows.delete(taskId);
            // Lost contact ≠ refunded: the row stays a billed call and records why the result never arrived.
            void updateApiCall(pending.rowId, {
              latencyMs: Date.now() - pending.startedAt,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      },
    }),

    ...(provider.uploadLocalMedia && {
      uploadLocalMedia: (filePath: string) => provider.uploadLocalMedia!(filePath),
    }),

    getTaskStatus: (taskId: string): Promise<TaskStatus> => provider.getTaskStatus(taskId),
    listModels: (mediaType?: MediaType, options?: { refresh?: boolean }): Promise<Model[]> =>
      provider.listModels(mediaType, options),
  };

  return logged;
}

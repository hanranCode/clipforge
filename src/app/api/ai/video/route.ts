import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { toRemoteUsableImage, resolveUploadFilePath } from "@/lib/remote-image";
import { apiError, errText } from "@/lib/api-error";
import { recordAiTask, updateAiTask } from "@/lib/ai-tasks";
import { sanitizeGenerationControlSummary } from "@/lib/video-repair-plan";
import { isObjectStorageConfigured } from "@/lib/object-storage";
import { uploadToObjectStorage } from "@/lib/object-storage-server";

/** A local reference that neither the provider nor a configured bucket can turn into a URL */
class MissingMediaHost extends Error {}

// AI video generation.
//
// Two-phase flow (issue #16): submit the paid task, persist the provider task ID to
// ai_tasks IMMEDIATELY, then poll. A poll timeout/crash no longer loses the task —
// the error response carries the task ID and the row stays recoverable ("unknown"),
// so the client can resume via /api/ai/video/task instead of paying again.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { provider: providerName, model, prompt, imageUrl, lastImageUrl, mode, apiKey, baseUrl, options, projectId, shotId, referenceVideoUrls, referenceImageUrls, referenceAudioUrls } = body;
  const controlPlan = sanitizeGenerationControlSummary(body.controlPlan);

  if (!providerName || !model) {
    return apiError(req, "缺少必要参数", "Missing required parameters");
  }

  if (!apiKey) {
    return apiError(req, "缺少 API Key，请先在设置中配置对应平台", "Missing API Key, please configure the corresponding platform in settings first");
  }

  try {
    const provider = createProvider({
      name: providerName,
      apiKey,
      baseUrl,
      logContext: { scene: typeof body.scene === "string" ? body.scene : "shot_video", projectId, shotId },
    });

    const firstFrameUrl = await toRemoteUsableImage(imageUrl);
    // Keyframe chaining: pin the clip's last frame to the next
    // shot's keyframe so the transition is generated inside the clip (seamless on hard concat)
    const lastFrameUrl = lastImageUrl ? await toRemoteUsableImage(lastImageUrl) : undefined;

    // Reference-to-video inputs (viral replication): reference IMAGES may travel as Base64
    // like first frames, but reference VIDEOS / AUDIO must be real URLs — local /api/files paths
    // go to the provider's own temporary hosting (Atlas /model/uploadMedia), or, for a provider
    // without one (Volcengine Ark), to the user's S3-compatible bucket as a presigned URL
    const objectStorage = isObjectStorageConfigured(body.objectStorage) ? body.objectStorage : null;
    const toRemoteMedia = async (ref: unknown): Promise<string | null> => {
      if (typeof ref !== "string" || !ref) return null;
      // http(s) URLs and Ark asset-library IDs (asset://…) go to the provider as they are
      if (ref.startsWith("http") || ref.startsWith("asset://")) return ref;
      const localPath = resolveUploadFilePath(ref);
      if (!localPath) throw new MissingMediaHost();
      if (provider.uploadLocalMedia) return provider.uploadLocalMedia(localPath);
      if (objectStorage) return uploadToObjectStorage(objectStorage, localPath);
      throw new MissingMediaHost();
    };
    let refVideos: string[] | undefined;
    let refImages: string[] | undefined;
    let refAudios: string[] | undefined;
    try {
      if (Array.isArray(referenceVideoUrls) && referenceVideoUrls.length > 0) {
        refVideos = (await Promise.all((referenceVideoUrls as unknown[]).slice(0, 3).map(toRemoteMedia))).filter((u): u is string => !!u);
      }
      if (Array.isArray(referenceAudioUrls) && referenceAudioUrls.length > 0) {
        refAudios = (await Promise.all((referenceAudioUrls as unknown[]).slice(0, 3).map(toRemoteMedia))).filter((u): u is string => !!u);
      }
    } catch (error) {
      if (!(error instanceof MissingMediaHost)) throw error;
      return apiError(
        req,
        "参考视频/音频需要公网可访问的地址：该平台不提供素材上传，请在 设置 → 对象存储 配置一个 S3 兼容存储桶",
        "Reference video/audio needs a publicly reachable URL: this platform has no upload endpoint — configure an S3-compatible bucket under Settings → Object storage",
      );
    }
    if (Array.isArray(referenceImageUrls) && referenceImageUrls.length > 0) {
      const imageRefs = (referenceImageUrls as unknown[]).filter((ref): ref is string => typeof ref === "string" && Boolean(ref)).slice(0, 9);
      refImages = (await Promise.all(imageRefs.map(toRemoteUsableImage))).filter(
        (u): u is string => !!u
      );
    }

    const videoOptions = {
      modelId: model,
      mode: mode || (imageUrl ? "image-to-video" : "text-to-video"),
      prompt: prompt || "",
      firstFrameUrl,
      ...(lastFrameUrl && { lastFrameUrl }),
      ...(refVideos?.length && { referenceVideoUrls: refVideos }),
      ...(refImages?.length && { referenceImageUrls: refImages }),
      ...(refAudios?.length && { referenceAudioUrls: refAudios }),
      ...options,
    };

    // legacy single-phase path for providers without two-phase task support
    if (!provider.submitVideoTask || !provider.waitForTask) {
      const result = await provider.generateVideo(videoOptions);
      return NextResponse.json(result);
    }

    // Phase 1: submit. Mode/model capability is validated inside the provider BEFORE any
    // billable call; base.request() never auto-retries this POST on timeout (money safety).
    const startTime = Date.now();
    const { taskId, modelId } = await provider.submitVideoTask(videoOptions);

    // Persist the paid task before polling starts — this row is the recovery handle.
    const rowId = await recordAiTask({
      projectId,
      shotId,
      provider: providerName,
      model: modelId,
      mediaType: "video",
      mode: videoOptions.mode,
      prompt: videoOptions.prompt,
      taskId,
      ...(controlPlan && { controlPlan }),
    });

    // Phase 2: wait. Transient status-query failures are tolerated inside waitForTask;
    // if it still fails, the task is marked "unknown"/"failed" but never dropped.
    try {
      const finalStatus = await provider.waitForTask(taskId, { interval: 5000 });
      const result = finalStatus.result;
      const videoUrls = result && "videoUrls" in result ? result.videoUrls : undefined;
      if (!videoUrls || videoUrls.length === 0) {
        await updateAiTask(rowId, { status: "unknown", error: "任务完成但未返回视频地址" });
        return NextResponse.json(
          { error: errText(req, "任务完成但未返回视频地址", "Task completed but returned no video URL"), taskId, modelId, recoverable: true },
          { status: 502 }
        );
      }
      await updateAiTask(rowId, { status: "completed", resultUrls: videoUrls, error: null });
      return NextResponse.json({
        taskId,
        videoUrls,
        modelId,
        duration: videoOptions.duration,
        processingTime: Date.now() - startTime,
        hasAudio: videoOptions.audioEnabled ?? false,
      });
    } catch (error) {
      // definitive provider-side failure vs. lost contact (task may still be running & billed)
      const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await updateAiTask(rowId, { status: failed ? "failed" : "unknown", error: message });
      return NextResponse.json(
        {
          error: failed
            ? message
            : errText(
                req,
                `${message}。任务 ID ${taskId} 已保存，可在素材页恢复查询，请勿重复提交`,
                `${message}. Task ID ${taskId} has been saved and can be recovered from the assets page — do not resubmit`
              ),
          taskId,
          modelId,
          recoverable: !failed,
        },
        { status: failed ? 500 : 504 }
      );
    }
  } catch (error) {
    // a provider's 4xx (bad input, rejected reference) is the caller's to fix, not a server fault
    const status = error instanceof ProviderError && error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) console.error("生视频失败:", error);
    else console.warn("生视频请求被拒绝:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : errText(req, "生视频失败", "Video generation failed"),
        ...(error instanceof ProviderError && { code: error.code }),
      },
      { status }
    );
  }
}

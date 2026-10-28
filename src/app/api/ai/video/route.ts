import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { toRemoteUsableImage, resolveUploadFilePath } from "@/lib/remote-image";
import { apiError, errText } from "@/lib/api-error";
import { recordAiTask, updateAiTask } from "@/lib/ai-tasks";
import { sanitizeGenerationControlSummary } from "@/lib/video-repair-plan";
import { isObjectStorageConfigured } from "@/lib/object-storage";
import { uploadToObjectStorage } from "@/lib/object-storage-server";
import { isRemakeModel, normalizeRemakePrompt, remakeMaxImages, remakeMaxAudios } from "@/lib/remake/model";
import { segmentEditParams } from "@/lib/remake/workflow";
import { validPromptReferences } from "@/lib/remake/references";
import { requireReferenceStorage, resolveReferenceResource } from "@/lib/reference-resource-server";

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

  const isRemake = body.scene === "video_remake";
  if (isRemake && (!isRemakeModel(providerName, model) || mode !== "video-to-video")) {
    return apiError(req, "视频复刻需要支持编辑的平台与模型：Atlas Cloud 的 Seedance/Wan、火山引擎 Seedance，或阿里百炼 wan3.0-video / wan3.0-video-prime", "Video remake requires a supported edit model from Atlas Cloud, Volcengine Seedance, or Alibaba Bailian wan3.0-video / wan3.0-video-prime", 400);
  }
  if (isRemake && (!Array.isArray(referenceVideoUrls) || referenceVideoUrls.length !== 1 || typeof referenceVideoUrls[0] !== "string" || !referenceVideoUrls[0].trim())) {
    return apiError(req, "视频复刻需要一条源视频", "Video remake requires exactly one source video", 400);
  }
  const maxImages = isRemake ? remakeMaxImages(model) : 9;
  if (isRemake && Array.isArray(referenceImageUrls) && referenceImageUrls.length > maxImages) {
    return apiError(req, `当前模型最多使用 ${maxImages} 张参考图`, `This model supports at most ${maxImages} reference images`, 400);
  }
  let editParams: Record<string, unknown> | undefined;
  if (isRemake) {
    if ([referenceImageUrls, referenceAudioUrls].some((refs) => refs !== undefined && (!Array.isArray(refs) || refs.some((url: unknown) => typeof url !== "string" || !url.trim())))) {
      return apiError(req, "参考资源无效", "Invalid reference resources", 400);
    }
    if (!validPromptReferences(normalizeRemakePrompt(typeof prompt === "string" ? prompt : ""), { image: referenceImageUrls?.length ?? 0, video: 1, audio: referenceAudioUrls?.length ?? 0 })) {
      return apiError(req, "提示词引用了不存在的素材，请重新选择参考资源", "Prompt references unavailable media; select the reference again", 400);
    }
    const maxAudios = remakeMaxAudios(model);
    if (Array.isArray(referenceAudioUrls) && referenceAudioUrls.length > maxAudios) {
      return apiError(req, `参考音频无效（最多 ${maxAudios} 条）`, `Invalid reference audio (up to ${maxAudios} clips)`, 400);
    }
    try { requireReferenceStorage(body.objectStorage); editParams = segmentEditParams(model, options?.extra ?? {}); }
    catch (error) { return apiError(req, `编辑参数无效：${(error as Error).message}`, `Invalid edit parameters: ${(error as Error).message}`, 400); }
  }

  try {
    const provider = createProvider({
      name: providerName,
      apiKey,
      baseUrl,
      logContext: { scene: typeof body.scene === "string" ? body.scene : "shot_video", projectId, shotId },
    });

    const firstFrameUrl = isRemake ? undefined : await toRemoteUsableImage(imageUrl);
    // Keyframe chaining: pin the clip's last frame to the next
    // shot's keyframe so the transition is generated inside the clip (seamless on hard concat)
    const lastFrameUrl = !isRemake && lastImageUrl ? await toRemoteUsableImage(lastImageUrl) : undefined;

    // Reference-to-video inputs (viral replication): reference IMAGES may travel as Base64
    // like first frames, but reference VIDEOS / AUDIO must be real URLs — local /api/files paths
    // go to the provider's own temporary hosting (Atlas /model/uploadMedia), or, for a provider
    // without one (Volcengine Ark), to the user's S3-compatible bucket as a presigned URL
    const objectStorage = isObjectStorageConfigured(body.objectStorage) ? body.objectStorage : null;
    const toRemoteMedia = async (ref: unknown): Promise<string | null> => {
      if (typeof ref !== "string" || !ref) return null;
      if (ref.startsWith("http")) return ref;
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
      if (isRemake) {
        const config = body.objectStorage;
        requireReferenceStorage(config);
        const ids = body.referenceResourceIds;
        const resolve = async (urls: unknown, kind: "images" | "videos" | "audios", mediaType: "image" | "video" | "audio") => {
          if (urls === undefined) return undefined;
          if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string" || !url.trim())) throw new Error("参考资源无效");
          const refs = ids?.[kind] ?? urls;
          if (!Array.isArray(refs) || refs.length !== urls.length || refs.some((ref) => typeof ref !== "string" || !ref)) throw new Error("参考资源与 URL 数量不一致");
          const out: string[] = [];
          for (const ref of refs) {
            const resource = await resolveReferenceResource(config, ref);
            if (resource.mediaType !== mediaType) throw new Error("参考资源分类不匹配");
            out.push(resource.url);
          }
          return out;
        };
        refVideos = await resolve(referenceVideoUrls, "videos", "video");
        refImages = await resolve(referenceImageUrls, "images", "image");
        refAudios = await resolve(referenceAudioUrls, "audios", "audio");
      } else if (Array.isArray(referenceVideoUrls) && referenceVideoUrls.length > 0) {
        refVideos = (await Promise.all((referenceVideoUrls as unknown[]).slice(0, 3).map(toRemoteMedia))).filter((u): u is string => !!u);
      }
      if (!isRemake && Array.isArray(referenceAudioUrls) && referenceAudioUrls.length > 0) {
        refAudios = (await Promise.all((referenceAudioUrls as unknown[]).slice(0, isRemake ? 10 : 3).map(toRemoteMedia))).filter((u): u is string => !!u);
      }
    } catch (error) {
      if (!(error instanceof MissingMediaHost)) throw error;
      return apiError(
        req,
        "参考视频/音频需要公网可访问的地址：该平台不提供素材上传，请在 设置 → 对象存储 配置一个 S3 兼容存储桶",
        "Reference video/audio needs a publicly reachable URL: this platform has no upload endpoint — configure an S3-compatible bucket under Settings → Object storage",
      );
    }
    if (!isRemake && Array.isArray(referenceImageUrls) && referenceImageUrls.length > 0) {
      const imageRefs = (referenceImageUrls as unknown[]).filter((ref): ref is string => typeof ref === "string" && Boolean(ref)).slice(0, maxImages);
      // Ark has no upload endpoint: with a bucket configured, a local image goes out as a presigned
      // URL like the video beside it instead of a multi-MB inline Base64 body
      const toImageRef = async (ref: string) => {
        const localPath = !provider.uploadLocalMedia && objectStorage ? resolveUploadFilePath(ref) : null;
        if (localPath) {
          try {
            return await uploadToObjectStorage(objectStorage!, localPath);
          } catch {
            // fall back to Base64 below
          }
        }
        return toRemoteUsableImage(ref);
      };
      refImages = (await Promise.all(imageRefs.map(toImageRef))).filter(
        (u): u is string => !!u
      );
    }

    const videoOptions = {
      ...(isRemake && { inputVideoSeconds: options?.duration }),
      modelId: model,
      mode: mode || (imageUrl ? "image-to-video" : "text-to-video"),
      prompt: prompt || "",
      firstFrameUrl,
      ...(lastFrameUrl && { lastFrameUrl }),
      ...(refVideos?.length && { referenceVideoUrls: refVideos }),
      ...(refImages?.length && { referenceImageUrls: refImages }),
      ...(refAudios?.length && { referenceAudioUrls: refAudios }),
      ...options,
      ...(isRemake && {
        modelId: model,
        mode: "video-to-video",
        // Resolution is an explicit generation tier; reference dimensions must not select a tier.
        width: undefined,
        height: undefined,
        prompt: normalizeRemakePrompt(prompt || ""),
        firstFrameUrl: undefined,
        lastFrameUrl: undefined,
        audioPrompt: undefined,
        voiceover: undefined,
        referenceVideoUrls: refVideos,
        referenceImageUrls: refImages,
        referenceAudioUrls: refAudios,
        audioEnabled: typeof editParams?.audio === "boolean" ? editParams.audio : typeof editParams?.generate_audio === "boolean" ? editParams.generate_audio : options?.audioEnabled,
        extra: editParams,
      }),
    };

    // legacy single-phase path for providers without two-phase task support
    if (!provider.submitVideoTask || !provider.waitForTask) {
      const result = await provider.generateVideo(videoOptions);
      return NextResponse.json(result);
    }

    // Phase 1: submit. Mode/model capability is validated inside the provider BEFORE any
    // billable call; base.request() never auto-retries this POST on timeout (money safety).
    const startTime = Date.now();
    req.signal.throwIfAborted();
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

    // Let remakes save the paid task handle before a long, interruptible polling request.
    if (isRemake && body.wait === false) {
      return NextResponse.json({ taskId, modelId, status: "submitted", recoverable: true });
    }

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
        ...(result && "extra" in result && { extra: result.extra }),
        ...(result && "lastFrameUrl" in result && { lastFrameUrl: result.lastFrameUrl }),
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
    const privacyRejection = providerName === "volcengine" && error instanceof ProviderError
      && error.code === "InputImageSensitiveContentDetected.PrivacyInformation";
    const contentIndex = error instanceof Error ? Number(/content\[(\d+)\]/.exec(error.message)?.[1]) : NaN;
    const imageToken = isRemake && contentIndex >= 1 && contentIndex <= (referenceImageUrls?.length ?? 0) ? ` @Image${contentIndex}` : "";
    const requestId = error instanceof Error ? /Request id:\s*([\w-]+)/i.exec(error.message)?.[1] : undefined;
    return NextResponse.json(
      {
        error: privacyRejection ? errText(req,
          `火山引擎拒绝了参考图片${imageToken}：检测到可能包含真人，当前请求未创建任务。请移除该图片，或使用当前账号和模型支持的人物素材接入方式后重试。`,
          `Volcengine rejected reference image${imageToken} because it may contain a real person. No task was created. Remove the image or use a person-reference method supported by your account and model.`)
          : error instanceof Error ? error.message : errText(req, "生视频失败", "Video generation failed"),
        ...(error instanceof ProviderError && { code: error.code }),
        provider: providerName,
        ...(status >= 400 && status < 500 && { recoverable: false }),
        ...(requestId && { requestId }),
      },
      { status }
    );
  }
}

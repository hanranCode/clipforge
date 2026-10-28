/**
 * Alibaba Bailian Provider implementation
 * Supports Wan (Wanxiang) video generation and Qwen image generation models
 * Docs: https://help.aliyun.com/zh/model-studio/
 */

import { BaseProvider, ProviderError } from './base'
import { bailianVideoUsage } from '@/lib/remake/pricing'
import type {
  ProviderConfig,
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  TaskStatusEnum,
  Model,
  MediaType,
} from './types'

// ==================== Alibaba Bailian API response types ====================

interface AliResponse<T = unknown> {
  request_id: string
  output: T
  usage?: Record<string, unknown>
}

interface AliAsyncOutput {
  task_id: string
  task_status: string
}

interface AliTaskOutput {
  task_id: string
  task_status: string
  task_metrics?: {
    TOTAL?: number
    SUCCEEDED?: number
    FAILED?: number
  }
  results?: Array<{
    url?: string
    code?: string
    message?: string
  }>
  video_url?: string
  cover_image_url?: string
  error_code?: string
  error_message?: string
  /** Wan 3.0 reports a failed task as code/message */
  code?: string
  message?: string
  submit_time?: string
  end_time?: string
}

// ==================== Wan 3.0 (all-in-one) ====================

const WAN_OMNI_SCENARIOS = ['textToVideo', 'imageToVideo', 'firstLastFrame', 'referenceVideo', 'videoEdit', 'nativeAudio']
const WAN_OMNI_MAX_IMAGES = 10
const WAN_OMNI_MAX_CLIPS = 5
const WAN_OMNI_RATIOS: Array<[string, number]> = [['21:9', 21 / 9], ['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4], ['9:16', 9 / 16]]

/** Wan 3.0 takes one `media` array (images, video, audio) instead of the 2.x img_url fields */
export function isWanOmniModel(modelId: string): boolean {
  return /^wan3(\.|-|$)/i.test(modelId)
}

/** Wan names references "图1 / 视频1 / 音频1"; the app writes Seedance-style "@图片1 / @视频1 / @音频1" */
export function toWanReferenceSyntax(prompt: string): string {
  return prompt.replace(/@(?:图片|Image)(\d+)/gi, '图$1')
    .replace(/@(?:视频|Video)(\d+)/gi, '视频$1')
    .replace(/@(?:音频|Audio)(\d+)/gi, '音频$1')
}

function wanResolution(width?: number, height?: number): string | undefined {
  if (!width || !height) return undefined
  const short = Math.min(width, height)
  return short >= 1080 ? '1080P' : short >= 720 ? '720P' : '480P'
}

function wanRatio(width?: number, height?: number): string {
  if (!width || !height) return 'adaptive'
  const r = width / height
  return WAN_OMNI_RATIOS.reduce((best, cur) => (Math.abs(cur[1] - r) < Math.abs(best[1] - r) ? cur : best))[0]
}

/**
 * Wan 3.0 request body. First/last frames and reference media are mutually exclusive modes; when a
 * caller sends both, the frames ride along as reference images. Media order defines numbering
 * (images, videos and audio are counted separately), so it follows the option arrays as given.
 */
export function buildWanOmniBody(options: VideoOptions): Record<string, unknown> {
  const images = options.referenceImageUrls ?? []
  const videos = options.referenceVideoUrls ?? (options.referenceVideoUrl ? [options.referenceVideoUrl] : [])
  const audios = options.referenceAudioUrls ?? []
  const hasReferences = images.length + videos.length + audios.length > 0
  const media: Array<{ type: string; url: string }> = []
  const frames = [options.firstFrameUrl, options.lastFrameUrl].filter((u): u is string => Boolean(u))
  if (hasReferences) {
    for (const url of [...frames, ...images].slice(0, WAN_OMNI_MAX_IMAGES)) media.push({ type: 'reference_image', url })
  } else {
    if (options.firstFrameUrl) media.push({ type: 'first_frame', url: options.firstFrameUrl })
    if (options.lastFrameUrl) media.push({ type: 'last_frame', url: options.lastFrameUrl })
  }
  for (const url of videos.slice(0, WAN_OMNI_MAX_CLIPS)) media.push({ type: 'reference_video', url })
  for (const url of audios.slice(0, WAN_OMNI_MAX_CLIPS)) media.push({ type: 'reference_audio', url })

  let prompt = toWanReferenceSyntax(options.prompt)
  if (options.audioEnabled && options.voiceover && !hasReferences) prompt = `${prompt}。旁白："${options.voiceover}"`

  return {
    model: options.modelId,
    input: {
      prompt,
      ...(media.length > 0 && { media }),
    },
    parameters: {
      ...(wanResolution(options.width, options.height) && { resolution: wanResolution(options.width, options.height) }),
      ratio: videos.length > 0 ? 'adaptive' : wanRatio(options.width, options.height),
      ...(options.duration != null && { duration: options.duration }),
      audio: options.audioEnabled ?? false,
      watermark: false,
      ...(options.seed != null && { seed: options.seed }),
      ...options.extra,
    },
  }
}

// ==================== Provider implementation ====================

export class AlibabaProvider extends BaseProvider {
  readonly name = 'alibaba'
  readonly displayName = '阿里百炼'

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl?.trim().replace(/\/+$/, '') || 'https://dashscope.aliyuncs.com/api/v1',
    })
  }

  /**
   * Get authentication headers - Alibaba Bailian uses API-Key auth
   */
  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
    }
  }

  /**
   * Generate an image
   */
  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const body = {
      model: options.modelId,
      input: {
        prompt: options.prompt,
        negative_prompt: options.negativePrompt,
        ...(options.referenceImageUrl && {
          ref_img: options.referenceImageUrl,
        }),
      },
      parameters: {
        size: options.width && options.height
          ? `${options.width}*${options.height}`
          : undefined,
        n: options.count ?? 1,
        guidance_scale: options.guidanceScale,
        steps: options.steps,
        seed: options.seed,
        ...options.extra,
      },
    }

    // use the async task API
    const response = await this.request<AliResponse<AliAsyncOutput>>(
      '/services/aigc/text2image/image-synthesis',
      {
        method: 'POST',
        body,
        headers: {
          'X-DashScope-Async': 'enable',
        },
      }
    )

    // guard: async submission occasionally returns 200 but without output/task_id; accessing .task_id would throw TypeError
    if (!response.output?.task_id) {
      throw new ProviderError('未返回任务ID', 'NO_TASK_ID', this.name)
    }
    const taskId = response.output.task_id

    // poll until result is ready
    const finalStatus = await this.pollTaskStatus(taskId)

    // the status API does not echo back the model; backfill using the caller's modelId
    const result = this.requireResult(finalStatus.result) as ImageResult
    result.modelId = options.modelId
    return result
  }

  /**
   * Submit a video task without waiting (two-phase: the route persists the task ID before polling)
   */
  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    const wan3 = isWanOmniModel(options.modelId)
    if (wan3 && /^https:\/\/dashscope\.aliyuncs\.com\/api\/v1$/i.test(this.config.baseUrl)) {
      throw new ProviderError('Wan 3.0 需要业务空间 Endpoint，请在设置 → AI 平台 → 阿里百炼填写 https://<WorkspaceId>.<地域>.maas.aliyuncs.com/api/v1，并使用同地域 API Key', 'BAILIAN_ENDPOINT_REQUIRED', this.name, 400)
    }
    const response = await this.request<AliResponse<AliAsyncOutput>>(
      wan3 ? '/services/aigc/video-generation/video-synthesis' : '/services/aigc/video-generation/generation',
      {
        method: 'POST',
        body: wan3 ? buildWanOmniBody(options) : this.buildLegacyVideoBody(options),
        headers: {
          'X-DashScope-Async': 'enable',
        },
      }
    )

    // guard: async submission occasionally returns 200 but without output/task_id; accessing .task_id would throw TypeError
    if (!response.output?.task_id) {
      throw new ProviderError('未返回任务ID', 'NO_TASK_ID', this.name)
    }
    return { taskId: response.output.task_id, modelId: options.modelId }
  }

  /**
   * Generate a video
   */
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const { taskId } = await this.submitVideoTask(options)

    // poll with a longer interval since video generation takes more time
    const finalStatus = await this.pollTaskStatus(taskId, {
      interval: 5000,
    })

    // the status API does not echo back the model; backfill using the caller's modelId
    const result = this.requireResult(finalStatus.result) as VideoResult
    result.modelId = options.modelId
    return result
  }

  /** Request body for the Wan 2.x single-image endpoints */
  private buildLegacyVideoBody(options: VideoOptions): Record<string, unknown> {
    // models that support audio embed the voiceover into the prompt
    let prompt = options.prompt
    if (options.audioEnabled && options.voiceover) {
      prompt = `${options.prompt}. 旁白: "${options.voiceover}"`
    }

    return {
      model: options.modelId,
      input: {
        prompt,
        negative_prompt: options.negativePrompt,
        ...(options.firstFrameUrl && {
          img_url: options.firstFrameUrl,
        }),
        ...(options.referenceVideoUrl && {
          video_url: options.referenceVideoUrl,
        }),
      },
      parameters: {
        size: options.width && options.height
          ? `${options.width}*${options.height}`
          : undefined,
        duration: options.duration,
        fps: options.fps,
        motion_strength: options.motionStrength,
        guidance_scale: options.guidanceScale,
        seed: options.seed,
        // pass through audio parameters
        ...(options.audioEnabled && {
          enable_audio: true,
          ...(options.audioPrompt && { audio_prompt: options.audioPrompt }),
        }),
        ...options.extra,
      },
    }
  }

  /**
   * Query task status
   */
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const response = await this.request<AliResponse<AliTaskOutput>>(
      `/tasks/${taskId}`
    )

    const data = response.output
    if (!data?.task_id || !data.task_status) {
      throw new ProviderError('未返回有效任务状态', 'INVALID_TASK_STATUS', this.name)
    }
    const status = this.mapStatus(data.task_status)

    const taskStatus: TaskStatus = {
      taskId: data.task_id,
      status,
      createdAt: data.submit_time,
      updatedAt: data.end_time,
    }

    // calculate progress
    if (data.task_metrics) {
      const total = data.task_metrics.TOTAL ?? 1
      const succeeded = data.task_metrics.SUCCEEDED ?? 0
      taskStatus.progress = Math.round((succeeded / total) * 100)
    }

    // parse image result
    if (status === 'completed' && data.results && data.results.length > 0) {
      const validResults = data.results.filter((r) => r.url)
      if (validResults.length > 0) {
        taskStatus.result = {
          taskId: data.task_id,
          imageUrls: validResults.map((r) => r.url!),
          modelId: '',
        }
      }
    }

    // parse video result
    if (status === 'completed' && data.video_url) {
      taskStatus.result = {
        taskId: data.task_id,
        videoUrls: [data.video_url],
        coverImageUrl: data.cover_image_url,
        modelId: '',
        ...(response.usage && { extra: { usage: response.usage } }),
        ...(bailianVideoUsage(response.usage).videoSeconds != null && { duration: bailianVideoUsage(response.usage).videoSeconds }),
      }
    }

    // failure info
    if (status === 'failed') {
      taskStatus.error = data.error_message ?? data.message
      taskStatus.errorCode = data.error_code ?? data.code
    }

    return taskStatus
  }

  /**
   * List available models
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    // Wan 3.0 contract verified against the official docs (2026-10-27).
    // docs: https://help.aliyun.com/zh/model-studio/image-to-video-api-reference/
    const models: Model[] = [
      // ==================== Video generation (Wan series) ====================
      // --- wan3.0 (all-in-one: text / first-last frame / reference / video edit) ---
      // docs: https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference
      {
        id: 'wan3.0-video',
        name: '万相 3.0',
        description: '万相 3.0 全能参考，文/图/参考生视频，支持视频编辑与原生音频（参考视频 ≤15 秒）',
        modes: ['text-to-video', 'image-to-video', 'video-to-video'],
        mediaType: 'video',
        supportsAudio: true,
        provider: this.name,
        extra: { scenarios: WAN_OMNI_SCENARIOS },
      },
      {
        id: 'wan3.0-video-prime',
        name: '万相 3.0 Prime',
        description: '万相 3.0 高速版，能力对齐标准版，出片更快',
        modes: ['text-to-video', 'image-to-video', 'video-to-video'],
        mediaType: 'video',
        supportsAudio: true,
        provider: this.name,
        extra: { scenarios: WAN_OMNI_SCENARIOS },
      },
      // --- wan2.6 series (latest) ---
      {
        id: 'wan2.6-i2v-flash',
        name: '万相 2.6 Flash (图生视频)',
        description: '万相 2.6 快速图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'wan2.6-i2v',
        name: '万相 2.6 (图生视频)',
        description: '万相 2.6 标准图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      // --- wan2.5 series ---
      {
        id: 'wan2.5-i2v-preview',
        name: '万相 2.5 Preview (图生视频)',
        description: '万相 2.5 预览版图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      // --- wan2.2 series ---
      {
        id: 'wan2.2-i2v-plus',
        name: '万相 2.2 Plus (图生视频)',
        description: '万相 2.2 高质量图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      // --- wanx2.1 series (legacy, kept for compatibility) ---
      {
        id: 'wanx2.1-i2v-turbo',
        name: '万相 2.1 Turbo (图生视频)',
        description: '万相 2.1 快速图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'wanx2.1-i2v-plus',
        name: '万相 2.1 Plus (图生视频)',
        description: '万相 2.1 高质量图生视频',
        modes: ['image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      // ==================== Image generation ====================
      {
        id: 'wanx-v1',
        name: '通义万相 (文生图)',
        description: '通义万相文生图模型',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'qwen-vl-max',
        name: '通义千问 VL Max',
        description: '通义千问视觉语言模型（图片理解/分析）',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
    ]

    if (mediaType) {
      return models.filter((m) => m.mediaType === mediaType)
    }

    return models
  }

  // ==================== Private methods ====================

  /** Map Alibaba Bailian task status to unified status */
  private mapStatus(aliStatus: string): TaskStatusEnum {
    const statusMap: Record<string, TaskStatusEnum> = {
      PENDING: 'pending',
      RUNNING: 'processing',
      SUCCEEDED: 'completed',
      FAILED: 'failed',
      CANCELED: 'cancelled',
      UNKNOWN: 'pending',
    }
    return statusMap[aliStatus] ?? 'pending'
  }
}

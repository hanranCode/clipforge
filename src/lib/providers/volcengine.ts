/**
 * VolcEngine (Ark) provider implementation
 * Official API docs:
 * - Image (Seedream) sync: POST /api/v3/images/generations  https://www.volcengine.com/docs/82379/1541523
 * - Video (Seedance) async: POST /api/v3/contents/generations/tasks + GET /tasks/{id}  https://www.volcengine.com/docs/82379/1366799
 * Auth: Authorization: Bearer <ARK_API_KEY>
 * Note: the legacy visual.volcengineapi.com Visual service requires AK/SK signing and is deprecated; all calls now go through Ark.
 */

import { BaseProvider, ProviderError } from './base'
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

// ==================== Ark API response types ====================

/** Image generation response (OpenAI-compatible: data[].url) */
interface ArkImageResponse {
  model?: string
  data?: Array<{ url?: string; b64_json?: string; size?: string }>
  images?: string[] // some API docs return an images array instead; handled for compatibility
  error?: { code?: string; message?: string }
}

/** Video task creation response */
interface ArkTaskCreateResponse {
  id: string
  error?: { code?: string; message?: string }
}

/** Video task query response */
interface ArkTaskQueryResponse {
  id: string
  model?: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  content?: { video_url?: string; last_frame_url?: string }
  error?: { code?: string; message?: string }
}

/** Ark content-role caps (Content Generation API schema; verified against a production integration) */
const ARK_MAX_REFERENCE_IMAGES = 9
const ARK_MAX_REFERENCE_VIDEOS = 3
const ARK_MAX_REFERENCE_AUDIOS = 3

/** Map width/height to an Ark video ratio */
function toRatio(width?: number, height?: number): string {
  const w = width ?? 0
  const h = height ?? 0
  if (w > h) return '16:9'
  if (h > w) return '9:16'
  if (w === h && w > 0) return '1:1'
  return 'adaptive'
}

/** Map width/height to an Ark image size; falls back to "2K" when outside Ark's pixel range (model picks aspect ratio from prompt) */
function toImageSize(width?: number, height?: number): string {
  const w = width ?? 0
  const h = height ?? 0
  const total = w * h
  // Ark total pixel range [2560x1440=3686400, 4096x4096=16777216]
  if (total >= 3686400 && total <= 16777216) return `${w}x${h}`
  return '2K'
}

export class VolcEngineProvider extends BaseProvider {
  readonly name = 'volcengine'
  readonly displayName = '火山引擎'

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
    })
  }

  /** Ark authenticates with a Bearer API key */
  protected getAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` }
  }

  /**
   * Generate an image (Seedream — synchronous, no polling needed)
   */
  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const body: Record<string, unknown> = {
      model: options.modelId,
      prompt: options.prompt,
      size: toImageSize(options.width, options.height),
      response_format: 'url',
      watermark: false,
      // image-to-image / edit: pass image (URL or base64)
      ...(options.referenceImageUrl && { image: options.referenceImageUrl }),
      ...options.extra,
    }

    const resp = await this.request<ArkImageResponse>('/images/generations', {
      method: 'POST',
      body,
    })

    if (resp.error) {
      throw new ProviderError(
        `火山方舟图像生成失败: ${resp.error.message ?? resp.error.code}`,
        resp.error.code ?? 'ARK_IMAGE_ERROR',
        this.name
      )
    }

    // Prefer data[].url; fall back to images[] string array for compatibility
    const urls = (resp.data?.map((d) => d.url).filter(Boolean) as string[]) ?? []
    if (urls.length === 0 && Array.isArray(resp.images)) {
      urls.push(...resp.images)
    }
    if (urls.length === 0) {
      throw new ProviderError('图像生成成功但未返回 URL', 'NO_RESULT', this.name)
    }

    return {
      taskId: 'sync',
      imageUrls: urls,
      modelId: options.modelId,
    }
  }

  /**
   * Build the content array per the Ark Content Generation API role protocol:
   * image_url entries carry role first_frame / last_frame / reference_image (≤9),
   * video_url entries role reference_video (≤3), audio_url entries role
   * reference_audio (≤3). Overflow is truncated client-side — the API hard-rejects it.
   */
  private buildVideoContent(options: VideoOptions): Array<Record<string, unknown>> {
    let text = options.prompt
    if (options.audioEnabled && options.audioPrompt && !text.includes(options.audioPrompt)) {
      text = `${text}。${options.audioPrompt}`
    } else if (options.audioEnabled && options.voiceover && !options.audioPrompt) {
      text = `${options.prompt}。旁白：「${options.voiceover}」`
    }
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
    if (options.firstFrameUrl) {
      content.push({ type: 'image_url', image_url: { url: options.firstFrameUrl }, role: 'first_frame' })
    }
    if (options.lastFrameUrl) {
      content.push({ type: 'image_url', image_url: { url: options.lastFrameUrl }, role: 'last_frame' })
    }
    for (const url of (options.referenceImageUrls ?? []).slice(0, ARK_MAX_REFERENCE_IMAGES)) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of (options.referenceVideoUrls ?? []).slice(0, ARK_MAX_REFERENCE_VIDEOS)) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of (options.referenceAudioUrls ?? []).slice(0, ARK_MAX_REFERENCE_AUDIOS)) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    }
    return content
  }

  /**
   * Phase 1 of the two-phase contract (paid-task safety): submit and return the task ID
   * immediately so the caller can persist it BEFORE polling — a lost poll then recovers
   * the paid task instead of double-billing a resubmit.
   */
  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    const body: Record<string, unknown> = {
      model: options.modelId,
      content: this.buildVideoContent(options),
      ratio: toRatio(options.width, options.height),
      ...(options.duration != null && { duration: options.duration }),
      generate_audio: options.audioEnabled ?? false,
      watermark: false,
      // always ask for the clip's real final frame — it feeds tail-frame chaining and
      // sequential continuation past the single-call duration cap
      return_last_frame: true,
      ...(options.seed != null && { seed: options.seed }),
      ...options.extra,
    }

    const created = await this.request<ArkTaskCreateResponse>(
      '/contents/generations/tasks',
      { method: 'POST', body }
    )
    if (created.error || !created.id) {
      throw new ProviderError(
        `火山方舟视频任务创建失败: ${created.error?.message ?? '未返回任务 ID'}`,
        created.error?.code ?? 'ARK_TASK_ERROR',
        this.name
      )
    }
    return { taskId: created.id, modelId: options.modelId }
  }

  /**
   * Generate a video (Seedance — async task + polling). Prefer submitVideoTask +
   * waitForTask when the task ID must be persisted before polling.
   */
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const { taskId } = await this.submitVideoTask(options)
    const finalStatus = await this.pollTaskStatus(taskId, { interval: 5000 })
    const result = this.requireResult(finalStatus.result) as VideoResult
    result.modelId = options.modelId
    return result
  }

  /**
   * Query task status (video async tasks only)
   */
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const data = await this.request<ArkTaskQueryResponse>(
      `/contents/generations/tasks/${taskId}`
    )
    const status = this.mapStatus(data.status)

    const taskStatus: TaskStatus = { taskId: data.id, status }

    if (status === 'completed' && data.content?.video_url) {
      taskStatus.result = {
        taskId: data.id,
        videoUrls: [data.content.video_url],
        modelId: data.model ?? '',
        hasAudio: undefined,
        // real final frame (return_last_frame:true) — the seam primitive for chaining
        ...(data.content.last_frame_url && { lastFrameUrl: data.content.last_frame_url }),
      }
    }
    if (status === 'failed') {
      taskStatus.error = data.error?.message
      taskStatus.errorCode = data.error?.code
    }
    return taskStatus
  }

  /** Map Ark task status to unified status */
  private mapStatus(s: ArkTaskQueryResponse['status']): TaskStatusEnum {
    switch (s) {
      case 'queued':
        return 'pending'
      case 'running':
        return 'processing'
      case 'succeeded':
        return 'completed'
      case 'failed':
        return 'failed'
      case 'cancelled':
        return 'cancelled'
      default:
        return 'processing'
    }
  }

  catalogMetadata?: { source: 'static' | 'live' | 'cache' | 'stale'; updatedAt?: string; fallback?: boolean }

  /**
   * Fetch available model list.
   *
   * Ark's API-key data plane has no model-list endpoint (GET /models answers 404 — the listing
   * API, ListFoundationModels, needs AK/SK signing), so the catalog is the curated lineup below.
   * It used to carry only 5 entries, which hid most of what an Ark account can actually call.
   * A best-effort GET /models still runs: a proxy / future Ark release that serves it adds any
   * Seedream / SeedEdit / Seedance ids we do not list yet. Endpoint ids (ep-…) and anything
   * else go in via custom models.
   * Source: https://www.volcengine.com/docs/82379
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    this.catalogMetadata = { source: 'static' }
    const models: Model[] = VOLCENGINE_MODELS.map((m) => ({ ...m, provider: this.name }))
    const known = new Set(models.map((m) => m.id))
    for (const id of await this.probeLiveModelIds()) {
      if (known.has(id)) continue
      const type = arkMediaTypeOf(id)
      if (!type) continue
      known.add(id)
      models.push({
        id,
        name: id,
        modes: type === 'image' ? ['text-to-image', 'image-to-image'] : ['text-to-video', 'image-to-video'],
        mediaType: type,
        provider: this.name,
      })
    }
    if (mediaType) return models.filter((m) => m.mediaType === mediaType)
    return models
  }

  /** GET /models, never throwing and never slower than a few seconds; [] when unsupported */
  private async probeLiveModelIds(): Promise<string[]> {
    if (!this.config.apiKey) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
      const res = await fetch(`${this.config.baseUrl}/models`, { headers: this.getAuthHeaders(), signal: controller.signal })
      if (!res.ok) return []
      const data = (await res.json()) as { data?: Array<{ id?: unknown }> }
      const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
      if (ids.length) this.catalogMetadata = { source: 'live', updatedAt: new Date().toISOString() }
      return ids
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Classify a live Ark id; chat / embedding models are not generation targets here */
export function arkMediaTypeOf(id: string): MediaType | null {
  if (/seedream|seededit/i.test(id)) return 'image'
  if (/seedance/i.test(id)) return 'video'
  return null
}

type CatalogEntry = Omit<Model, 'provider'>

/**
 * Curated Ark lineup (2026-09). `extra.scenarios` states what each model is for (picker tags):
 * Seedance 2.x takes multimodal references (images / video / audio), 1.0 Lite I2V takes 1–4
 * reference images, Seedream 4+ fuses multiple reference images. Ids carry the release date suffix Ark requires; a model the
 * account has not activated returns an explicit Ark error at submit time rather than billing.
 */
export const VOLCENGINE_MODELS: CatalogEntry[] = [
  // ==================== Video generation (Seedance) ====================
  {
    // Announced 2026-07-31; Ark API access is rolling out gradually — accounts
    // without access yet should stay on 2.0 (id verified against Ark pricing mirrors)
    id: 'doubao-seedance-2-5-260628',
    name: 'Seedance 2.5',
    description: '字节豆包视频生成 2.5，4-30 秒原生音频/人声，支持编辑/延展（方舟陆续开放中，未开通可先用 2.0）',
    modes: ['text-to-video', 'image-to-video'],
    mediaType: 'video',
    supportsAudio: true,
    extra: { scenarios: ['textToVideo', 'imageToVideo', 'firstLastFrame', 'referenceVideo', 'videoEdit', 'nativeAudio'] },
  },
  {
    id: 'doubao-seedance-2-0-260128',
    name: 'Seedance 2.0',
    description: '字节豆包视频生成 2.0，电影级画质，支持原生音频',
    modes: ['text-to-video', 'image-to-video'],
    mediaType: 'video',
    supportsAudio: true,
    extra: { scenarios: ['textToVideo', 'imageToVideo', 'firstLastFrame', 'referenceVideo', 'videoEdit', 'nativeAudio'] },
  },
  {
    id: 'doubao-seedance-2-0-fast-260128',
    name: 'Seedance 2.0 Fast',
    description: '豆包视频 2.0 快速版，出片更快更便宜',
    modes: ['text-to-video', 'image-to-video'],
    mediaType: 'video',
    supportsAudio: true,
    extra: { scenarios: ['textToVideo', 'imageToVideo', 'firstLastFrame', 'referenceVideo', 'nativeAudio'] },
  },
  {
    id: 'doubao-seedance-2-0-mini-260615',
    name: 'Seedance 2.0 Mini',
    description: '豆包视频 2.0 轻量版，低成本批量出片',
    modes: ['text-to-video', 'image-to-video'],
    mediaType: 'video',
    extra: { scenarios: ['textToVideo', 'imageToVideo', 'firstLastFrame'] },
  },
  {
    id: 'doubao-seedance-1-5-pro-251215',
    name: 'Seedance 1.5 Pro',
    description: '豆包视频 1.5 Pro，文/图生视频，支持原生音频',
    modes: ['text-to-video', 'image-to-video'],
    mediaType: 'video',
    supportsAudio: true,
    extra: { scenarios: ['textToVideo', 'imageToVideo', 'firstLastFrame', 'nativeAudio'] },
  },
  {
    id: 'doubao-seedance-1-0-pro-250528',
    name: 'Seedance 1.0 Pro',
    description: '豆包视频 1.0 Pro，文/图生视频',
    modes: ['text-to-video', 'image-to-video'],
    mediaType: 'video',
    extra: { scenarios: ['textToVideo', 'imageToVideo', 'firstLastFrame'] },
  },
  {
    id: 'doubao-seedance-1-0-pro-fast-251015',
    name: 'Seedance 1.0 Pro Fast',
    description: '豆包视频 1.0 Pro 快速版',
    modes: ['text-to-video', 'image-to-video'],
    mediaType: 'video',
    extra: { scenarios: ['textToVideo', 'imageToVideo'] },
  },
  {
    id: 'doubao-seedance-1-0-lite-i2v-250428',
    name: 'Seedance 1.0 Lite I2V',
    description: '豆包视频 1.0 轻量版 · 图生视频（首帧/首尾帧/参考图）',
    modes: ['image-to-video'],
    mediaType: 'video',
    extra: { scenarios: ['imageToVideo', 'firstLastFrame', 'referenceVideo'] },
  },
  {
    id: 'doubao-seedance-1-0-lite-t2v-250428',
    name: 'Seedance 1.0 Lite T2V',
    description: '豆包视频 1.0 轻量版 · 文生视频',
    modes: ['text-to-video'],
    mediaType: 'video',
    extra: { scenarios: ['textToVideo'] },
  },
  // ==================== Image generation (Seedream / SeedEdit) ====================
  {
    id: 'doubao-seedream-5-0-260128',
    name: 'Seedream 5.0',
    description: '豆包图像 5.0，强中文理解、排版与质感（带货商品图佳）',
    modes: ['text-to-image', 'image-to-image'],
    mediaType: 'image',
    extra: { scenarios: ['textToImage', 'imageToImage', 'referenceImage'] },
  },
  {
    id: 'doubao-seedream-4-5-251128',
    name: 'Seedream 4.5',
    description: '豆包图像 4.5，4K 输出，多图参考与编辑',
    modes: ['text-to-image', 'image-to-image'],
    mediaType: 'image',
    extra: { scenarios: ['textToImage', 'imageToImage', 'referenceImage'] },
  },
  {
    id: 'doubao-seedream-4-0-250828',
    name: 'Seedream 4.0',
    description: '豆包图像 4.0，多图参考输入，商品保真编辑',
    modes: ['text-to-image', 'image-to-image'],
    mediaType: 'image',
    extra: { scenarios: ['textToImage', 'imageToImage', 'referenceImage'] },
  },
  {
    id: 'doubao-seedream-3-0-t2i-250415',
    name: 'Seedream 3.0 T2I',
    description: '豆包图像 3.0 · 文生图',
    modes: ['text-to-image'],
    mediaType: 'image',
    extra: { scenarios: ['textToImage'] },
  },
  {
    id: 'doubao-seededit-3-0-i2i-250628',
    name: 'SeedEdit 3.0 I2I',
    description: '豆包图像编辑 3.0 · 图生图（指令编辑）',
    modes: ['image-to-image'],
    mediaType: 'image',
    extra: { scenarios: ['imageToImage'] },
  },
]

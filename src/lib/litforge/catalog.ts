/** Versioned atomic contracts. Add capabilities here without changing the transport. */
export const LITFORGE_MODELS = {
  reference: "litforge/wan-vace-reference-v1",
  replace: "litforge/wan-animate-replace-v1",
  upscale: "litforge/media-sr-v1",
} as const;
export const LITFORGE_CAPABILITIES = [
  { id: "media.super_resolution.v1", cli: "media-sr", prefix: "media-sr", workflow: "MediaSuperResolutionWorkflowV1", queue: "media-sr-h800-v1", model: LITFORGE_MODELS.upscale, name: "LitForge · 1080P 视频超分", fps: 0, maxFrames: 18000 },
  { id: "media.character_animation.v1", cli: "wan-animate", prefix: "wan-animate", workflow: "MediaCharacterAnimationWorkflowV1", queue: "media-wan-animate-h800-v1", model: LITFORGE_MODELS.replace, name: "LitForge · Wan2.2 人物替换", fps: 30, maxFrames: 301 },
  { id: "media.video_edit.v1", cli: "wan-vace", prefix: "wan-vace", workflow: "MediaVideoEditWorkflowV1", queue: "media-wan-vace-h800-v1", model: LITFORGE_MODELS.reference, name: "LitForge · VACE 参考视频生成", fps: 16, maxFrames: 81 },
] as const;
export type LitforgeCapability = typeof LITFORGE_CAPABILITIES[number];
export function litforgeCapability(model: string): LitforgeCapability {
  const value = LITFORGE_CAPABILITIES.find(c => c.model === model);
  if (!value) throw new Error("不支持的 LitForge 模型 / Unsupported LitForge model");
  return value;
}
export function providerCredentialsReady(name: string, setting?: { enabled?: boolean; apiKey?: string }): boolean {
  return Boolean(setting?.enabled && (name === "litforge" || setting.apiKey));
}

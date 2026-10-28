/** Shared client/server description. Dimensions refer to the actual media, never target settings. */
export interface PublishVideo {
  id: string;
  url: string | null;
  label?: string | null;
  createdAt?: string | number | null;
  width?: number;
  height?: number;
  kind?: "original" | "upscale";
  originalId?: string;
}
export interface PublishVideoFamily { videos: PublishVideo[]; preferredId: string }
export function videoResolution(video?: Pick<PublishVideo, "width" | "height">): string | null {
  return video?.width && video.height ? `${video.width} × ${video.height}` : null;
}

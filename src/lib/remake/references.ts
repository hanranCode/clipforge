import type { ReferenceResource } from "@/lib/reference-resource";
import type { RemakeImage } from "./plan";

/** Keep provider input on TOS while using the durable local copy for previews. */
export function remakeImageFromResource(resource: ReferenceResource, label = resource.label): RemakeImage {
  if (resource.mediaType !== "image") throw new Error("请选择图片参考素材");
  return { id: resource.id, url: resource.url, thumbUrl: resource.path, label, resource };
}

/** Keep image tokens bound to their media when the visible reference list changes. */
export function remapImageReferences(prompt: string, previous: string[], next: string[]): string {
  return prompt.replace(/@Image(\d+)\b/gi, (token, number: string) => {
    const id = previous[Number(number) - 1];
    const index = id ? next.indexOf(id) : -1;
    return index >= 0 ? `@Image${index + 1}` : `@RemovedImage${number}`;
  });
}

export function validPromptReferences(prompt: string, counts: { image: number; video: number; audio: number }): boolean {
  if (/@RemovedImage\d+/i.test(prompt)) return false;
  return [...prompt.matchAll(/@(Image|Video|Audio)(\d+)\b/gi)].every((match) => {
    const number = Number(match[2]);
    return number >= 1 && number <= counts[match[1].toLowerCase() as keyof typeof counts];
  });
}

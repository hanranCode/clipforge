/** Provenance is independent from media type and from the subject's real/virtual identity. */
export const MATERIAL_SOURCES = ["ai_generated", "user_upload", "link_import", "agent_remake", "video_remake", "stock_footage", "product_image", "example", "manual", "unknown"] as const;
export type MaterialSource = typeof MATERIAL_SOURCES[number];
export interface ImageProvenance { source?: MaterialSource; imageSources?: Record<string, MaterialSource> }
export const isMaterialSource = (value: unknown): value is MaterialSource => MATERIAL_SOURCES.includes(value as MaterialSource);

/** Backfill only paths with a known producer. Do not guess a portrait's identity from its pixels. */
export function imageSource(url: string, provenance: ImageProvenance = {}): MaterialSource {
  const recorded = provenance.imageSources?.[url];
  if (isMaterialSource(recorded)) return recorded;
  if (/^\/examples\//.test(url)) return "example";
  if (/^\/api\/files\/(product-generated|library-generated)\//.test(url) || /^\/api\/files\/characters\/(?:image-|sheet-|portrait-)/.test(url)) return "ai_generated";
  if (/^\/api\/(?:files|output)\/agent-studio\//.test(url) || /^\/api\/agent-studio\/resources\//.test(url)) return "agent_remake";
  return isMaterialSource(provenance.source) ? provenance.source : "unknown";
}
export function imageSources(urls: readonly string[], provenance: ImageProvenance = {}): MaterialSource[] {
  return [...new Set(urls.length ? urls.map(url => imageSource(url, provenance)) : [isMaterialSource(provenance.source) ? provenance.source : "unknown"])];
}
export function matchesSource(sources: readonly MaterialSource[], filter: string) { return !filter || sources.includes(filter as MaterialSource); }

export function materialSource(item: { source?: MaterialSource; origin?: string; detailHref?: string; sourceUrl?: string | null; projectType?: string | null; tags?: string[] }): MaterialSource {
  if (isMaterialSource(item.source)) return item.source;
  if (item.projectType === "agent" || item.detailHref?.startsWith("/agent-studio/") || item.sourceUrl?.startsWith("/agent-studio/")) return "agent_remake";
  if (item.projectType === "remake" || item.tags?.includes("视频复刻")) return "video_remake";
  return isMaterialSource(item.origin) ? item.origin : "unknown";
}

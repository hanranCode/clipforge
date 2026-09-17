/**
 * Cross-project asset library (素材库) — the read model behind /materials.
 *
 * Nothing new is recorded for it: every generated image and video already lands in the `assets`
 * table with its provenance (which project and shot asked for it, which platform and model made it,
 * the prompt and the control plan that produced it, and for stock footage the source link, author
 * and licence). This module turns those rows into one browsable, filterable feed, which also means
 * the library is complete for material generated before the page existed.
 *
 * Pure functions only — the route supplies the rows, so everything here is unit-testable.
 */

/**
 * Source of a piece of material. The first four mirror assets.type; `link_import` only ever comes
 * from the library's own import door (a URL the user pasted), which has no `assets` row behind it.
 */
export type AssetOrigin = "ai_generated" | "product_image" | "user_upload" | "stock_footage" | "link_import";

export const ASSET_ORIGINS: AssetOrigin[] = [
  "ai_generated",
  "stock_footage",
  "user_upload",
  "link_import",
  "product_image",
];

export type AssetMediaType = "image" | "video";

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;

/** Video or image, decided by the stored file path (the DB has no media-type column). */
export function classifyAssetMedia(filePath: string | null | undefined): AssetMediaType {
  return filePath && VIDEO_EXT.test(filePath) ? "video" : "image";
}

/**
 * One row as the page consumes it — a generated asset or an imported one.
 *
 * `projectId` is null exactly for library imports: they belong to nobody until someone reaches for
 * them, so there is no project to link to and no shot to name.
 */
export interface AssetLibraryItem {
  id: string;
  projectId: string | null;
  projectName: string | null;
  shotId: number | null;
  mediaType: AssetMediaType;
  origin: AssetOrigin;
  /** Playable/viewable URL (always a local /api/files path — provider URLs expire). */
  url: string | null;
  thumbnailUrl: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  /** Generation inputs beyond the prompt: mode, reference media, audio plan. */
  inputs: AssetGenerationInputs | null;
  sourceUrl: string | null;
  author: string | null;
  license: string | null;
  /** Import-only: what the importer named and described the material as, and how they tagged it. */
  title?: string | null;
  description?: string | null;
  tags?: string[];
  /** True when this take is the one feeding composition (several takes may exist per shot). */
  selected: boolean;
  status: string;
  sizeBytes: number | null;
  createdAt: string | null;
}

/** The parts of a generation control plan worth showing next to the output. */
export interface AssetGenerationInputs {
  mode?: string;
  referenceCount?: number;
  references?: string[];
  audioMode?: string;
  durationSeconds?: number;
}

/** Narrow a stored control plan down to display inputs (shape-tolerant: old rows lack fields). */
export function readGenerationInputs(plan: unknown): AssetGenerationInputs | null {
  if (!plan || typeof plan !== "object") return null;
  const raw = plan as Record<string, unknown>;
  const references = Array.isArray(raw.referenceInputs)
    ? (raw.referenceInputs as Array<Record<string, unknown>>)
        .map((item) => (typeof item?.url === "string" ? item.url : ""))
        .filter(Boolean)
        .slice(0, 8)
    : undefined;
  const inputs: AssetGenerationInputs = {
    ...(typeof raw.mode === "string" && { mode: raw.mode }),
    ...(references?.length && { references, referenceCount: references.length }),
    ...(typeof raw.audioMode === "string" && { audioMode: raw.audioMode }),
    ...(typeof raw.generatedDuration === "number" && { durationSeconds: raw.generatedDuration }),
  };
  return Object.keys(inputs).length > 0 ? inputs : null;
}

export interface AssetLibraryFilters {
  mediaType?: AssetMediaType;
  origin?: AssetOrigin;
  provider?: string;
  model?: string;
  projectId?: string;
  /** Free text over prompt / model / project name. */
  search?: string;
  /** Only takes currently feeding composition. */
  selectedOnly?: boolean;
}

/**
 * Apply the filters the database cannot: media type comes from the file extension and search spans
 * a joined project name, so both are resolved after the rows are read.
 */
export function filterAssetItems(items: AssetLibraryItem[], filters: AssetLibraryFilters): AssetLibraryItem[] {
  const query = filters.search?.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.mediaType && item.mediaType !== filters.mediaType) return false;
    if (filters.origin && item.origin !== filters.origin) return false;
    if (filters.provider && item.provider !== filters.provider) return false;
    if (filters.model && item.model !== filters.model) return false;
    if (filters.projectId && item.projectId !== filters.projectId) return false;
    if (filters.selectedOnly && !item.selected) return false;
    if (query) {
      const haystack = [
        item.prompt,
        item.model,
        item.provider,
        item.projectName,
        item.author,
        item.title,
        item.description,
        ...(item.tags ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/** Distinct values for the filter menus, each with its count, most used first. */
export function facetCounts(items: AssetLibraryItem[], key: "provider" | "model" | "origin" | "mediaType"): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = item[key];
    if (!value) continue;
    counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Human-readable file size. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

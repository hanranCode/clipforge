/**
 * Which files may be unlinked when a shot's takes are deleted.
 *
 * Asset rows do NOT own their file exclusively. `persistAssetSource` returns an existing
 * `/api/files/...` path untouched, so a row can point at the project's product photo, at a
 * local-material-library file, or at a plain per-shot upload — all of which other shots, other
 * takes, or the project itself still need. Unlinking those would destroy data far outside the
 * shot the user asked to clear.
 *
 * So only a file this app minted for one specific take is deletable: `persistAssetSource`
 * writes those as `<prefix>-<shotId>-<epochMs>-<uuid8>.<ext>` directly in the project's upload
 * directory. Everything else stays on disk; project deletion reclaims the directory wholesale.
 *
 * Pure functions, no I/O — the caller resolves paths and unlinks.
 */

/** Exact shape `persistAssetSource` mints: prefix, shot id, timestamp, short uuid. */
const GENERATED_BASENAME = /^[A-Za-z0-9-]+-\d+-\d+-[0-9a-f]{8}\.(png|jpe?g|webp|mp4)$/i;

/**
 * Whether this path is a take-owned generated file sitting directly in the project's upload
 * directory. Nested paths (`.../materials/x.mp4`), other projects and foreign naming all fail.
 */
export function isOwnedTakeFile(projectId: string, filePath: string | null | undefined): boolean {
  if (!filePath || !projectId) return false;
  const prefix = `/api/files/${projectId}/`;
  if (!filePath.startsWith(prefix)) return false;
  const basename = filePath.slice(prefix.length);
  if (!basename || basename.includes("/")) return false;
  return GENERATED_BASENAME.test(basename);
}

/** The file columns of an asset row that can point at media on disk. */
export interface AssetFileRef {
  filePath?: string | null;
  thumbnailPath?: string | null;
}

/**
 * Paths to unlink after `removed` rows are gone: their owned files, minus anything a surviving
 * row still points at (an i2v take and the image take it was generated from share a keyframe).
 * Deduplicated, order-stable.
 */
export function takeFilesToDelete(
  projectId: string,
  removed: AssetFileRef[],
  surviving: AssetFileRef[],
): string[] {
  const stillReferenced = new Set<string>();
  for (const row of surviving) {
    if (row.filePath) stillReferenced.add(row.filePath);
    if (row.thumbnailPath) stillReferenced.add(row.thumbnailPath);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of removed) {
    for (const path of [row.filePath, row.thumbnailPath]) {
      if (!path || seen.has(path) || stillReferenced.has(path)) continue;
      if (!isOwnedTakeFile(projectId, path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

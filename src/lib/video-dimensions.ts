import { stat } from "node:fs/promises";
import { probeMedia } from "@/lib/media-probe";
import { TtlCache } from "@/lib/ttl-cache";
const cache = new TtlCache<Promise<{ width?: number; height?: number }>>(5 * 60_000, 400);
/** A bounded probe cache avoids launching ffprobe again for every works-card render. */
export async function videoDimensions(path: string | null | undefined): Promise<{ width?: number; height?: number }> {
  if (!path) return {};
  try {
    const file = await stat(path);
    const key = `${path}:${file.size}:${file.mtimeMs}`;
    const known = cache.get(key);
    if (known) return known;
    const result = probeMedia(path).then(p => p.width > 0 && p.height > 0 ? { width: p.width, height: p.height } : {}).catch(() => ({}));
    cache.set(key, result);
    return result;
  } catch { return {}; }
}

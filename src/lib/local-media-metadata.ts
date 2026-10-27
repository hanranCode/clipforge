import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, stat, writeFile, rename, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { getDataDir, getOutputDir } from "@/lib/paths";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { probeMedia } from "@/lib/media-probe";

export interface LocalMediaMetadata { width: number; height: number; durationSec: number }
const jobs = new Map<string, Promise<Partial<LocalMediaMetadata>>>();
/** Only inspect local files. Browsing a library card never downloads a cloud video. */
export async function localVideoMetadata(url: string): Promise<Partial<LocalMediaMetadata>> {
  let file = resolveUploadFilePath(url);
  if (!file && url.startsWith("/api/output/")) {
    const root = getOutputDir(), candidate = join(root, url.slice("/api/output/".length));
    if (candidate.startsWith(root + sep)) file = candidate;
  }
  if (!file) return {};
  const existing = jobs.get(file); if (existing) return existing;
  const path = file;
  const task = (async () => {
    let temp: string | undefined;
    try {
      const info = await stat(path), fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const dir = join(getDataDir(), "cache", "media-metadata"), key = createHash("sha256").update(path).digest("hex"), target = join(dir, `${key}.json`);
      try { const cached = JSON.parse(await readFile(target, "utf8")); if (cached.fingerprint === fingerprint && Number.isInteger(cached.width) && Number.isInteger(cached.height) && cached.width > 0 && cached.height > 0) return { width: cached.width, height: cached.height, durationSec: cached.durationSec }; } catch { /* cache miss */ }
      const media = await probeMedia(path); if (!media.width || !media.height) return {};
      const result = { width: media.width, height: media.height, durationSec: media.duration };
      await mkdir(dir, { recursive: true }); temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ fingerprint, ...result })); await rename(temp, target);
      return result;
    } catch { return {}; }
    finally { if (temp) await rm(temp, { force: true }).catch(() => {}); }
  })();
  jobs.set(path, task); try { return await task; } finally { jobs.delete(path); }
}

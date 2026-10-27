import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rename, rm, link, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { getDataDir } from "@/lib/paths";
import { presignUrl } from "@/lib/object-storage-server";
import { requireServerObjectStorage, sameStorage } from "@/lib/server-object-storage";

export interface VideoResource {
  sha256: string; bytes: number; width: number; height: number;
  storage: { endpoint: string; region: string; bucket: string; pathStyle?: boolean }; objectKey: string;
}
export function assertVideoResource(r: VideoResource) {
  if (!/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.bytes) || r.bytes < 1 || r.bytes > 2_000_000_000 || !Number.isInteger(r.width) || !Number.isInteger(r.height) || r.width < 1 || r.height < 1) throw new Error("视频资源元数据无效 / Invalid video resource metadata");
}
export async function hashFile(path: string) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const verified = new Map<string, string>();
async function cacheHit(path: string, r: VideoResource) {
  try {
    const info = await stat(path); if (!info.isFile() || info.size !== r.bytes) return false;
    const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (verified.get(path) === fingerprint) return true;
    if (await hashFile(path) !== r.sha256) return false;
    verified.set(path, fingerprint); return true;
  } catch { return false; }
}
const inFlight = new Map<string, Promise<string>>();
/** Content-addressed, restart-safe cache. A cache hit never signs or contacts object storage. */
export async function cachedVideo(r: VideoResource, localSource?: string): Promise<string> {
  assertVideoResource(r);
  const dir = join(getDataDir(), "cache", "agent-media"), file = join(dir, `${r.sha256}.mp4`);
  const ongoing = inFlight.get(file); if (ongoing) return ongoing;
  const job = (async () => {
    if (await cacheHit(file, r)) return file;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const partial = `${file}.${randomUUID()}.partial`;
    try {
      if (localSource && await cacheHit(localSource, r)) {
        try { await link(localSource, partial); } catch { await copyFile(localSource, partial); }
      } else {
        const c = requireServerObjectStorage();
        if (!sameStorage(c, r.storage)) throw new Error("本地存储配置与资源不匹配 / Local storage does not match this resource");
        const url = presignUrl(c, { method: "GET", key: r.objectKey, expiresSeconds: 900 });
        const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
        if (!res.ok || !res.body) throw new Error("Cloud read failed");
        const hash = createHash("sha256"); let bytes = 0;
        async function* chunks() {
          const reader = res.body!.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              bytes += value.length; if (bytes > r.bytes) throw new Error("Resource too large"); hash.update(value); yield value;
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
        await pipeline(chunks(), createWriteStream(partial, { flags: "wx", mode: 0o600 }));
        if (bytes !== r.bytes || hash.digest("hex") !== r.sha256) throw new Error("Resource checksum mismatch");
      }
      await rename(partial, file);
      return file;
    } catch (e) {
      if (e instanceof Error && /本地/.test(e.message)) throw e;
      throw new Error("视频资源读取或校验失败，请重试 / Video resource could not be read or verified");
    } finally { await rm(partial, { force: true }); }
  })();
  inFlight.set(file, job); try { return await job; } finally { inFlight.delete(file); }
}

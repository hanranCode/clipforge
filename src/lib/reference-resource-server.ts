import { createHash, randomUUID } from "crypto";
import { constants, createReadStream } from "fs";
import { copyFile, link, mkdir, mkdtemp, rm, stat } from "fs/promises";
import { basename, extname, join, relative, sep } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { libraryAssets, referenceCloudCopies } from "@/lib/db/schema";
import { getUploadsDir } from "@/lib/paths";
import { probeMedia } from "@/lib/media-probe";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { safeFetch } from "@/lib/ssrf-guard";
import { isObjectStorageConfigured, type ObjectStorageConfig } from "@/lib/object-storage";
import { objectLocation, presignUrl, PRESIGN_READ_SECONDS, putObjectFile } from "@/lib/object-storage-server";
import type { ReferenceResource } from "@/lib/reference-resource";

const MAX_BYTES = 200 * 1024 * 1024;
// Paid result downloads already admit 300MB. Archiving and later resolution must keep them usable.
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const TYPES: Record<string, ReferenceResource["mediaType"]> = {
  jpg: "image", jpeg: "image", png: "image", webp: "image",
  mp4: "video", mov: "video", webm: "video", m4v: "video",
  mp3: "audio", wav: "audio", m4a: "audio",
};
const inFlight = new Map<string, Promise<ReferenceResource>>();

export function requireReferenceStorage(value: unknown): asserts value is ObjectStorageConfig {
  if (!isObjectStorageConfigured(value)) throw new Error("请先在设置 → 对象存储配置火山 TOS，再上传或生成参考素材");
}

export async function fileMd5(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function destinationId(config: ObjectStorageConfig, md5: string): string {
  return createHash("sha256").update(JSON.stringify([
    config.endpoint.trim().replace(/\/+$/, ""), config.region.trim(), config.bucket.trim(),
    (config.prefix ?? "").trim().replace(/^\/+|\/+$/g, ""), Boolean(config.pathStyle), md5,
  ])).digest("hex");
}

/** Durable local copy + one library record + a cloud mapping per MD5 and destination. */
export async function registerReferenceFile(config: ObjectStorageConfig, file: string, label = basename(file)): Promise<ReferenceResource> {
  requireReferenceStorage(config);
  const info = await stat(file);
  const ext = extname(file).slice(1).toLowerCase().replace(/^jpeg$/, "jpg");
  const mediaType = TYPES[ext];
  if (!mediaType || !info.isFile() || !info.size || info.size > MAX_ARCHIVE_BYTES) throw new Error("参考文件类型或大小无效（最多 300MB）");
  const md5 = await fileMd5(file);
  const identity = destinationId(config, md5);
  const pending = inFlight.get(identity);
  if (pending) return pending;
  const operation = (async () => {
    const db = getDb();
    const probe = await probeMedia(file);
    if (mediaType === "audio" ? !probe.hasAudio || probe.width > 0 : !probe.width || !probe.height) throw new Error("参考素材内容无效");
    if (mediaType === "image" && !["mjpeg", "png", "webp"].includes(probe.videoCodec ?? "")) throw new Error("参考图片格式无效");
    const name = `md5-${md5}.${ext}`;
    const pool = join(getUploadsDir(), "_library");
    await mkdir(pool, { recursive: true });
    const durableFile = join(pool, name);
    if (file !== durableFile) {
      const temporary = join(pool, `.${randomUUID()}.part`);
      try {
        await copyFile(file, temporary, constants.COPYFILE_EXCL);
        try { await link(temporary, durableFile); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally { await rm(temporary, { force: true }); }
    }
    const row = db.transaction((tx) => {
      const known = tx.select().from(libraryAssets).where(eq(libraryAssets.contentMd5, md5)).get();
      if (known) return known;
      const localRelative = relative(getUploadsDir(), file);
      const originalUrl = !localRelative.startsWith("..") && !localRelative.startsWith(sep) ? `/api/files/${localRelative.split(sep).join("/")}` : "";
      const imported = originalUrl ? tx.select().from(libraryAssets).where(eq(libraryAssets.filePath, originalUrl)).get() : undefined;
      if (imported) {
        tx.update(libraryAssets).set({ contentMd5: md5 }).where(eq(libraryAssets.id, imported.id)).run();
        return { ...imported, contentMd5: md5 };
      }
      tx.insert(libraryAssets).values({ id: `md5-${md5}`, contentMd5: md5, mediaType, filePath: `/api/files/_library/${name}`,
        title: label.slice(0, 240), tags: ["视频复刻", "参考素材"], sizeBytes: info.size,
        width: probe.width || null, height: probe.height || null, durationSec: probe.duration || null,
      }).onConflictDoNothing().run();
      return tx.select().from(libraryAssets).where(eq(libraryAssets.contentMd5, md5)).get();
    });
    if (!row) throw new Error("参考素材入库失败");
    const [existing] = await db.select().from(referenceCloudCopies).where(eq(referenceCloudCopies.id, identity)).limit(1);
    const prefix = (config.prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
    const key = existing?.objectKey ?? `${prefix ? `${prefix}/` : ""}md5/${md5}.${ext}`;
    // Verify availability/credentials before billing, and recover lifecycle expiry without a new key.
    const head = await fetch(presignUrl(config, { method: "HEAD", key, expiresSeconds: 900 }), { method: "HEAD", signal: AbortSignal.timeout(30_000) });
    const needsUpload = head.status === 404;
    if (needsUpload) await putObjectFile(config, durableFile, key);
    else if (!head.ok) throw new Error(`对象存储检查失败（${head.status}），未重复上传`);
    const location = objectLocation(config, key);
    const objectUrl = `${location.origin}${location.path}`;
    const uploadedAt = needsUpload ? new Date() : existing?.uploadedAt ?? new Date();
    if (!existing || needsUpload) await db.insert(referenceCloudCopies).values({ id: identity, contentMd5: md5, endpoint: config.endpoint.trim(),
      bucket: config.bucket.trim(), objectKey: key, objectUrl, uploadedAt }).onConflictDoUpdate({ target: referenceCloudCopies.id, set: { objectUrl, uploadedAt } });
    await db.update(libraryAssets).set({ objectKey: key, objectBucket: config.bucket.trim(), objectEndpoint: config.endpoint.trim(), objectUrl, objectUploadedAt: uploadedAt }).where(eq(libraryAssets.id, row.id));
    return { id: row.id, md5, mediaType, label: row.title, path: row.filePath, objectUrl, objectKey: key,
      bucket: config.bucket.trim(), endpoint: config.endpoint.trim(),
      url: presignUrl(config, { method: "GET", key, expiresSeconds: PRESIGN_READ_SECONDS }),
      expiresAt: new Date(Date.now() + PRESIGN_READ_SECONDS * 1000).toISOString(),
    };
  })();
  inFlight.set(identity, operation);
  try { return await operation; } finally { inFlight.delete(identity); }
}

/** Adopt local or external library/product/presenter references into the same URL pipeline. */
export async function resolveReferenceResource(config: ObjectStorageConfig, ref: string, label?: string): Promise<ReferenceResource> {
  requireReferenceStorage(config);
  if (/^[\w-]{1,64}$/.test(ref)) {
    const [row] = await getDb().select().from(libraryAssets).where(eq(libraryAssets.id, ref)).limit(1);
    if (!row) throw new Error("参考资源不存在");
    const file = resolveUploadFilePath(row.filePath);
    if (!file) throw new Error("参考资源没有本地文件");
    return registerReferenceFile(config, file, label ?? row.title);
  }
  const local = ref.startsWith("/api/files/") ? resolveUploadFilePath(ref) : null;
  if (local) return registerReferenceFile(config, local, label);
  if (!/^https?:\/\//i.test(ref)) throw new Error("请选择本地素材或有效的参考文件 URL");
  const response = await safeFetch(ref, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error("无法下载参考素材");
  const extension = extname(new URL(ref).pathname).slice(1).toLowerCase();
  const mimeExt: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav" };
  const ext = TYPES[extension] ? extension : mimeExt[response.headers.get("content-type")?.split(";")[0] ?? ""];
  if (!ext) { await response.body.cancel(); throw new Error("不支持的参考素材格式"); }
  await mkdir(getUploadsDir(), { recursive: true });
  const dir = await mkdtemp(join(getUploadsDir(), "reference-import-"));
  const file = join(dir, `reference.${ext}`);
  let size = 0;
  try {
    const bounded = async function* () {
      for await (const chunk of Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0])) {
        size += chunk.length; if (size > MAX_BYTES) throw new Error("参考文件超过 200MB"); yield chunk;
      }
    };
    await pipeline(bounded(), createWriteStream(file, { flags: "wx" }));
    return await registerReferenceFile(config, file, label ?? `参考素材.${ext}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, libraryAssets } from "@/lib/db/schema";
import { apiError } from "@/lib/api-error";
import { isObjectStorageConfigured } from "@/lib/object-storage";
import { PRESIGN_SHARE_SECONDS, presignUrl, putObjectFile } from "@/lib/object-storage-server";
import { resolveUploadFilePath } from "@/lib/remote-image";

export const runtime = "nodejs";

const SAFE_ID = /^[\w-]{1,64}$/;

/** A library item is either an import (library_assets) or a generated take (assets); ids are UUIDs, so they never collide. */
async function findItem(id: string) {
  const db = getDb();
  const [imported] = await db.select().from(libraryAssets).where(eq(libraryAssets.id, id)).limit(1);
  if (imported) return { kind: "library" as const, row: imported };
  const [generated] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (generated) return { kind: "asset" as const, row: generated };
  return null;
}

/**
 * POST /api/materials/:id/cloud — the library's cloud copy of one item.
 *
 *   { action: "upload", objectStorage }                 → mirror the local file into the bucket
 *   { action: "url", objectStorage, expiresSeconds? }   → private presigned GET (default 3600 s)
 *
 * The storage config travels in the body like every other credential in this app (it lives in the
 * browser's settings store, never on the server).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return apiError(req, "无效的素材ID", "Invalid asset ID", 400);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const config = body.objectStorage;
  if (!isObjectStorageConfigured(config)) {
    return apiError(req, "请先在 设置 → 对象存储 完成配置", "Configure object storage under Settings first", 400);
  }

  const found = await findItem(id);
  if (!found) return apiError(req, "素材不存在", "Asset not found", 404);
  const { kind, row } = found;
  const bucket = config.bucket.trim();

  if (body.action === "url") {
    if (!row.objectKey) return apiError(req, "该素材尚未上传至对象存储", "This asset is not in object storage yet", 409);
    if (row.objectBucket && row.objectBucket !== bucket) {
      return apiError(
        req,
        `该素材上传在存储桶「${row.objectBucket}」，与当前配置的「${bucket}」不一致`,
        `This asset was uploaded to bucket "${row.objectBucket}", not the configured "${bucket}"`,
        409,
      );
    }
    const requested = Number(body.expiresSeconds);
    const expiresSeconds = Number.isFinite(requested) && requested > 0 ? Math.min(604800, Math.round(requested)) : PRESIGN_SHARE_SECONDS;
    const url = presignUrl(config, { method: "GET", key: row.objectKey, expiresSeconds });
    return NextResponse.json({ url, expiresSeconds, expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString() });
  }

  if (body.action !== "upload") return apiError(req, "未知操作", "Unknown action", 400);

  const localPath = row.filePath ? resolveUploadFilePath(row.filePath) : null;
  if (!localPath) return apiError(req, "该素材没有本地文件可上传", "This asset has no local file to upload", 400);
  try {
    const key = await putObjectFile(config, localPath);
    const uploadedAt = new Date();
    const patch = { objectKey: key, objectBucket: bucket, objectUploadedAt: uploadedAt };
    if (kind === "library") await getDb().update(libraryAssets).set(patch).where(eq(libraryAssets.id, id));
    else await getDb().update(assets).set(patch).where(eq(assets.id, id));
    return NextResponse.json({ objectKey: key, objectBucket: bucket, objectUploadedAt: uploadedAt.toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return apiError(req, "本地文件已不存在，无法上传", "The local file is gone, nothing to upload", 410);
    }
    return NextResponse.json({ error: message || "对象存储上传失败" }, { status: 502 });
  }
}

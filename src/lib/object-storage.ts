/**
 * S3-compatible object storage — the bridge that turns a local clip into a URL a cloud model can
 * fetch. Volcengine Ark takes reference videos only as public URLs (no local paths, no Base64), and
 * unlike Atlas it has no upload endpoint of its own. Any S3-compatible bucket works: Volcengine TOS
 * (`https://tos-s3-cn-beijing.volces.com`), Aliyun OSS, AWS S3, Cloudflare R2, MinIO.
 *
 * Objects stay private: uploads and reads both go through short-lived SigV4 presigned URLs, so the
 * bucket never needs public-read. This module is client-safe (settings UI reads it); signing and
 * upload live in object-storage-server.ts.
 */

export interface ObjectStorageConfig {
  /** Service endpoint, e.g. https://tos-s3-cn-beijing.volces.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix for everything ClipForge uploads, e.g. "clipforge/" */
  prefix?: string;
  /** bucket in the path (MinIO / some proxies) instead of the host */
  pathStyle?: boolean;
}

export function isObjectStorageConfigured(value: unknown): value is ObjectStorageConfig {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"].every(
    (k) => typeof c[k] === "string" && (c[k] as string).trim().length > 0,
  );
}


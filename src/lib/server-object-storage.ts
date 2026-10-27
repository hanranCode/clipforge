import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@/lib/paths";
import { isObjectStorageConfigured, type ObjectStorageConfig } from "@/lib/object-storage";

/** Credentials are provisioned on the host, never supplied by an upscale HTTP request. */
export function serverStorageConfigPath() {
  return process.env.CLIPFORGE_OBJECT_STORAGE_FILE || join(getDataDir(), "private", "object-storage.json");
}
export function getServerObjectStorage(): ObjectStorageConfig | null {
  const env = process.env;
  const fromEnv = { endpoint: env.TOS_ENDPOINT, region: env.TOS_REGION, bucket: env.TOS_BUCKET, accessKeyId: env.TOS_ACCESS_KEY_ID, secretAccessKey: env.TOS_SECRET_ACCESS_KEY, prefix: env.TOS_PREFIX, pathStyle: env.TOS_PATH_STYLE === "true" };
  if (isObjectStorageConfigured(fromEnv)) return fromEnv;
  try {
    const file = serverStorageConfigPath(), info = statSync(file);
    if (!info.isFile() || info.size > 32_768 || process.platform !== "win32" && (info.mode & 0o077) !== 0) return null;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObjectStorageConfigured(value) ? value : null;
  } catch { return null; }
}
export function requireServerObjectStorage(): ObjectStorageConfig {
  const c = getServerObjectStorage();
  if (!c) throw new Error("请在本地服务配置对象存储（私密文件或环境变量） / Configure object storage on the local server");
  return c;
}
export function serverStorageStatus() {
  const c = getServerObjectStorage();
  return { configured: Boolean(c), configPath: serverStorageConfigPath(), ...(c && { destination: { endpoint: c.endpoint, region: c.region, bucket: c.bucket } }) };
}
export function sameStorage(c: ObjectStorageConfig, location: { endpoint: string; region: string; bucket: string; pathStyle?: boolean }) {
  return c.endpoint.trim().replace(/\/+$/, "") === location.endpoint.replace(/\/+$/, "") && c.region.trim() === location.region && c.bucket.trim() === location.bucket && Boolean(c.pathStyle) === Boolean(location.pathStyle);
}

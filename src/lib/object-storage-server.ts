import { createHmac, createHash, randomUUID } from "crypto";
import type { ObjectStorageConfig } from "@/lib/object-storage";

/**
 * Server half of object storage: SigV4 presigning and upload. Hand-rolled SigV4 (query-string form)
 * instead of the AWS SDK — two presigns do not justify a multi-megabyte dependency.
 */

/** Long enough for a queued Seedance task to fetch its input; SigV4 allows up to 7 days */
export const PRESIGN_READ_SECONDS = 24 * 3600;

/** RFC 3986 encoding as SigV4 wants it ("/" kept in paths only) */
function encode(value: string, keepSlash = false): string {
  const out = encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, "/") : out;
}

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
const sha256Hex = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");

/** 20130524T000000Z */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Where an object lives: host + canonical path, honouring path-style */
export function objectLocation(config: ObjectStorageConfig, key: string): { origin: string; host: string; path: string } {
  const url = new URL(config.endpoint.trim().replace(/\/+$/, ""));
  const bucket = config.bucket.trim();
  const host = config.pathStyle ? url.host : `${bucket}.${url.host}`;
  const path = config.pathStyle ? `/${encode(bucket)}/${encode(key, true)}` : `/${encode(key, true)}`;
  return { origin: `${url.protocol}//${host}`, host, path };
}

/** SigV4 query-string presigned URL (UNSIGNED-PAYLOAD, only `host` signed) */
export function presignUrl(
  config: ObjectStorageConfig,
  input: { method: "GET" | "PUT"; key: string; expiresSeconds: number; now?: Date },
): string {
  const { origin, host, path } = objectLocation(config, input.key);
  const now = input.now ?? new Date();
  const datetime = amzDate(now);
  const day = datetime.slice(0, 8);
  const region = config.region.trim();
  const scope = `${day}/${region}/s3/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId.trim()}/${scope}`,
    "X-Amz-Date": datetime,
    "X-Amz-Expires": String(Math.min(604800, Math.max(1, Math.round(input.expiresSeconds)))),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encode(k)}=${encode(query[k])}`)
    .join("&");
  const canonicalRequest = [input.method, path, canonicalQuery, `host:${host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", datetime, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${config.secretAccessKey.trim()}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return `${origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function objectKeyFor(config: ObjectStorageConfig, fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "bin";
  const prefix = (config.prefix ?? "").trim().replace(/^\/+/, "");
  const normalized = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
  const day = new Date().toISOString().slice(0, 10);
  return `${normalized}${day}/${randomUUID()}.${ext}`;
}

/**
 * Upload a local file and return a presigned GET URL a model can fetch. Throws with the storage
 * service's own message so a wrong key / bucket / region is visible instead of a later model error.
 */
export async function uploadToObjectStorage(config: ObjectStorageConfig, filePath: string): Promise<string> {
  const { readFile } = await import("fs/promises");
  const { basename } = await import("path");
  const name = basename(filePath);
  const key = objectKeyFor(config, name);
  const body = await readFile(filePath);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const res = await fetch(presignUrl(config, { method: "PUT", key, expiresSeconds: 900 }), {
    method: "PUT",
    headers: { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    const message = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
    throw new Error(`对象存储上传失败（${res.status}${code ? ` ${code}` : ""}）${message ? `：${message}` : ""}`);
  }
  return presignUrl(config, { method: "GET", key, expiresSeconds: PRESIGN_READ_SECONDS });
}

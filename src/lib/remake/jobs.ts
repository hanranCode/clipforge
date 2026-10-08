import { mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { getUploadsDir } from "@/lib/paths";

/**
 * A remake job is a working directory under uploads/remake/<jobId>: segment cuts, dub audio and
 * downloaded model results live there, servable at /api/files/remake/<jobId>/… — which is also
 * what lets them be uploaded to a provider or bucket as references.
 */
const SAFE_JOB = /^[a-zA-Z0-9-]{8,64}$/;

export function newJobId(): string {
  return randomUUID();
}

export function isJobId(value: unknown): value is string {
  return typeof value === "string" && SAFE_JOB.test(value);
}

export async function jobDir(jobId: string): Promise<string> {
  if (!isJobId(jobId)) throw new Error("INVALID_JOB");
  const dir = join(getUploadsDir(), "remake", jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function jobFileUrl(jobId: string, name: string): string {
  return `/api/files/remake/${jobId}/${encodeURIComponent(name)}`;
}

import { NextRequest, NextResponse } from "next/server";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { apiError } from "@/lib/api-error";
import { isObjectStorageConfigured } from "@/lib/object-storage";
import { uploadToObjectStorage } from "@/lib/object-storage-server";

export const runtime = "nodejs";

/**
 * POST /api/storage/test — round-trip a tiny file through the configured bucket: upload with a
 * presigned PUT, then read it back through the presigned GET a model would be given. Both halves
 * matter: a wrong region signs a PUT that fails, a bucket policy can still block the GET.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const config = (body as Record<string, unknown>).objectStorage;
  if (!isObjectStorageConfigured(config)) {
    return apiError(req, "请填写完整的对象存储配置", "Fill in every object storage field", 400);
  }
  const dir = await mkdtemp(join(tmpdir(), "clipforge-storage-"));
  try {
    const file = join(dir, "clipforge-check.txt");
    const marker = `clipforge ${Date.now()}`;
    await writeFile(file, marker);
    const url = await uploadToObjectStorage(config, file);
    const res = await fetch(url);
    const text = await res.text().catch(() => "");
    if (!res.ok || text !== marker) {
      return apiError(req, `上传成功，但预签名地址读取失败（${res.status}）`, `Upload worked, but reading back through the presigned URL failed (${res.status})`, 502);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "对象存储测试失败" }, { status: 502 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

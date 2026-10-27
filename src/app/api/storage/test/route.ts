import { NextRequest, NextResponse } from "next/server";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { apiError } from "@/lib/api-error";
import { requireServerObjectStorage } from "@/lib/server-object-storage";
import { localRequest, fail, body } from "@/lib/agent-studio/http";
import { isObjectStorageConfigured } from "@/lib/object-storage";
import { uploadToObjectStorage } from "@/lib/object-storage-server";

export const runtime = "nodejs";

/**
 * POST /api/storage/test — round-trip a tiny file through the configured bucket: upload with a
 * presigned PUT, then read it back through the presigned GET a model would be given. Both halves
 * matter: a wrong region signs a PUT that fails, a bucket policy can still block the GET.
 */
export async function POST(req: NextRequest) {
  let payload;
  try { localRequest(req, true); payload = await body(req); } catch(e) { return fail(e); }
  if (Object.keys(payload).length) return apiError(req, "存储检测不接受凭据，请配置本地服务", "Storage checks do not accept credentials", 400);
  let config; try { config = requireServerObjectStorage(); } catch(e) { return fail(e); }
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
  } catch {
    return apiError(req, "对象存储测试失败，请核对本地服务配置与桶权限", "Storage test failed; check local server configuration and bucket permissions", 502);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

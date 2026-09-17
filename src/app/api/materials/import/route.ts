import { NextRequest, NextResponse } from "next/server";
import { join } from "path";
import { getUploadsDir } from "@/lib/paths";
import { getDb } from "@/lib/db";
import { libraryAssets } from "@/lib/db/schema";
import { apiError } from "@/lib/api-error";
import { safeFetch } from "@/lib/ssrf-guard";
import { classifyMaterial, MATERIAL_MAX_BYTES } from "@/lib/material-library";
import { storeLocalMaterial } from "@/lib/local-material-library";
import {
  normalizeImportMetadata,
  remoteFileName,
  urlBaseName,
  type LibraryImportMetadata,
} from "@/lib/library-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Where imported material lives. `_library` cannot collide with a project directory: project ids
 * are validated as `[a-zA-Z0-9-]+` everywhere they reach the filesystem, so none can start with `_`.
 */
const LIBRARY_DIR = () => join(getUploadsDir(), "_library");
const LIBRARY_URL = (name: string) => `/api/files/_library/${encodeURIComponent(name)}`;

/** A download may legitimately take minutes; the per-hop default in safeFetch is far too short. */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** One code, one bilingual message. Anything unrecognised is a 500 with the reason kept server-side. */
function failure(req: NextRequest, error: unknown): NextResponse {
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "INVALID_TITLE":
      return apiError(req, "请填写素材名称", "Enter a name for the material", 400);
    case "INVALID_DESCRIPTION":
      return apiError(req, "描述最长 2000 个字符", "The description can be at most 2,000 characters", 400);
    case "INVALID_TAGS":
      return apiError(req, "最多 12 个标签，每个不超过 32 个字符", "Use up to 12 tags, at most 32 characters each", 400);
    case "INVALID_SOURCE_URL":
      return apiError(req, "原始链接必须是 http/https 地址", "The source link must be an http/https URL", 400);
    case "MATERIAL_SIZE":
      return apiError(req, "文件不能为空，且不能超过 80MB", "Files must be nonempty and at most 80 MB", 413);
    case "UNSUPPORTED_MATERIAL":
      return apiError(req, "仅支持 MP4、WebM、MOV、M4V、JPG、PNG、WebP", "Only MP4, WebM, MOV, M4V, JPG, PNG and WebP are supported", 415);
    case "UNSUPPORTED_REMOTE_TYPE":
      return apiError(
        req,
        "这个链接返回的不是视频或图片文件。请用 Chrome 视频下载助手一类的插件取到直链（通常以 .mp4 结尾）后再粘贴，页面地址无法直接下载。",
        "That link does not return a video or image file. Use a browser download helper to get the direct media URL (it usually ends in .mp4) — a page address cannot be downloaded directly.",
        415,
      );
    case "INVALID_MATERIAL":
      return apiError(req, "文件无法读取，或真实格式与扩展名不一致", "The file cannot be read or its actual format does not match its extension", 422);
    case "INCOMPLETE_MATERIAL":
      return apiError(req, "文件未传完，请重试", "The transfer is incomplete; please retry", 422);
    case "DOWNLOAD_FAILED":
      return apiError(req, "下载失败，请检查链接是否仍然有效", "The download failed — check whether the link is still valid", 502);
    default:
      break;
  }
  if (req.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return apiError(req, "导入已取消", "Import cancelled", 499);
  }
  // A body that arrives truncated (over the proxy's buffer ceiling, or a dropped connection) reaches
  // us as an unparseable multipart envelope. Say that, rather than reporting a generic server error.
  if (error instanceof Error && /FormData|multipart/i.test(error.message)) {
    return apiError(req, "文件过大或上传中断，请重试", "The file is too large or the upload was interrupted; please retry", 413);
  }
  // A blocked address is the SSRF guard talking; its message is already user-facing Chinese.
  if (error instanceof Error && /URL|内网|主机|重定向|http\/https/.test(error.message)) {
    return apiError(req, error.message, "The link could not be fetched: it is not a reachable public address", 400);
  }
  console.error("素材导入失败:", error instanceof Error ? error.message : error);
  return apiError(req, "导入失败，请重试", "Import failed; please retry", 500);
}

/** Write the bytes to the library pool, then record what the importer told us about them. */
async function saveImport(
  stream: ReadableStream<Uint8Array>,
  fileName: string,
  metadata: LibraryImportMetadata,
  importSource: "upload" | "link",
  options: { signal?: AbortSignal; expectedBytes?: number },
) {
  const { material } = await storeLocalMaterial(LIBRARY_DIR(), fileName, stream, options);
  const [row] = await getDb()
    .insert(libraryAssets)
    .values({
      mediaType: material.mediaType,
      importSource,
      filePath: LIBRARY_URL(material.name),
      ...metadata,
      sizeBytes: material.sizeBytes,
      width: material.width ?? null,
      height: material.height ?? null,
      durationSec: material.durationSec ?? null,
    })
    .returning();
  return row;
}

/**
 * Import material into the cross-project library.
 *
 * Two request shapes, one destination:
 *  - `multipart/form-data` with a `file` part — the ordinary file picker.
 *  - `application/json` with a `url` — the server downloads the link itself, which is what makes a
 *    browser download-helper extension useful here: paste the direct media URL it exposes instead of
 *    saving to Downloads and picking the file back up.
 *
 * Either way the bytes are streamed to disk, content-hashed, probed with ffprobe and rejected if the
 * real format disagrees with the extension — so an expired CDN link that answers with an HTML error
 * page never lands in the library as a "video".
 */
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const body = (await req.json()) as Record<string, unknown>;
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (!url) return apiError(req, "请填写视频链接", "Enter a video link", 400);

      // The source link defaults to the link the material came from — that is its provenance.
      const metadata = normalizeImportMetadata(
        { ...body, sourceUrl: body.sourceUrl ?? url },
        urlBaseName(url),
      );

      const signal = AbortSignal.any([req.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
      const response = await safeFetch(url, { signal });
      if (!response.ok || !response.body) throw new Error("DOWNLOAD_FAILED");

      const fileName = remoteFileName(url, response.headers.get("content-type"));
      const declaredLength = Number(response.headers.get("content-length"));
      // Trust content-length as an integrity check only when the body is not re-encoded in transit.
      const expectedBytes =
        !response.headers.get("content-encoding") && Number.isSafeInteger(declaredLength) && declaredLength > 0
          ? declaredLength
          : undefined;
      if (expectedBytes !== undefined && expectedBytes > MATERIAL_MAX_BYTES) throw new Error("MATERIAL_SIZE");

      const row = await saveImport(response.body, fileName, metadata, "link", { signal, expectedBytes });
      return NextResponse.json({ item: row }, { status: 201 });
    }

    if (!contentType.includes("multipart/form-data")) {
      return apiError(req, "请求格式无效", "Invalid request format", 415);
    }

    const declared = req.headers.get("content-length");
    const declaredBytes = declared === null ? undefined : Number(declared);
    if (
      declaredBytes !== undefined &&
      (!Number.isSafeInteger(declaredBytes) || declaredBytes > MATERIAL_MAX_BYTES + 64 * 1024)
    ) {
      throw new Error("MATERIAL_SIZE");
    }

    if (!req.body) return apiError(req, "请选择要上传的素材文件", "Choose a material file to upload", 400);
    // A chunked upload declares no length, so the ceiling has to be enforced on the bytes themselves.
    let received = 0;
    const bounded = req.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > MATERIAL_MAX_BYTES + 64 * 1024) throw new Error("MATERIAL_SIZE");
          controller.enqueue(chunk);
        },
      }),
    );
    const form = await new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: bounded,
      duplex: "half",
      signal: req.signal,
    } as RequestInit).formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return apiError(req, "请选择要上传的素材文件", "Choose a material file to upload", 400);
    }
    if (!classifyMaterial(file.name)) throw new Error("UNSUPPORTED_MATERIAL");
    if (!file.size || file.size > MATERIAL_MAX_BYTES) throw new Error("MATERIAL_SIZE");

    const metadata = normalizeImportMetadata(Object.fromEntries(form.entries()), file.name);
    const row = await saveImport(file.stream(), file.name, metadata, "upload", {
      signal: req.signal,
      expectedBytes: file.size,
    });
    return NextResponse.json({ item: row }, { status: 201 });
  } catch (error) {
    return failure(req, error);
  }
}

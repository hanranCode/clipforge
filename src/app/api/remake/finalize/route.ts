import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { rm, stat } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";
import { apiError } from "@/lib/api-error";
import { getDb } from "@/lib/db";
import { libraryAssets } from "@/lib/db/schema";
import { getUploadsDir } from "@/lib/paths";
import { probeMedia } from "@/lib/media-probe";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { storeLocalMaterial } from "@/lib/local-material-library";
import { isJobId, jobDir } from "@/lib/remake/jobs";
import { assembleRemake, type FinalAudio } from "@/lib/remake/render";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * POST /api/remake/finalize — stitch the edited and untouched segments back together, attach the
 * chosen audio, and file the result in the asset library.
 * body: { jobId, sourcePath, segments: [{ start, end, path }], audioMode: keep|mute|dub, dubPath?, title, description? }
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isJobId(body.jobId)) return apiError(req, "无效的任务", "Invalid job", 400);
  const sourcePath = resolveUploadFilePath(typeof body.sourcePath === "string" ? body.sourcePath : "");
  if (!sourcePath) return apiError(req, "无效的源视频", "Invalid source video", 400);

  const segments: Array<{ start: number; end: number; file: string }> = [];
  for (const raw of Array.isArray(body.segments) ? body.segments : []) {
    const seg = raw as Record<string, unknown>;
    const file = resolveUploadFilePath(typeof seg.path === "string" ? seg.path : "");
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!file || !(end > start)) return apiError(req, "分段数据无效", "Invalid segment data", 400);
    segments.push({ start, end, file });
  }
  if (!segments.length) return apiError(req, "没有可合成的分段", "No segments to assemble", 400);
  segments.sort((a, b) => a.start - b.start);

  let audio: FinalAudio;
  if (body.audioMode === "dub") {
    const dubPath = resolveUploadFilePath(typeof body.dubPath === "string" ? body.dubPath : "");
    if (!dubPath) return apiError(req, "缺少配音音轨", "Missing the dub track", 400);
    audio = { mode: "dub", dubPath };
  } else if (body.audioMode === "mute") {
    audio = { mode: "mute" };
  } else {
    audio = { mode: "keep", sourcePath };
  }

  const title = (typeof body.title === "string" && body.title.trim() ? body.title.trim() : "视频复刻").slice(0, 120);
  const description = typeof body.description === "string" ? body.description.slice(0, 2000) : null;

  const dir = await jobDir(body.jobId);
  const outPath = join(dir, `final-${Date.now()}.mp4`);
  try {
    const probe = await probeMedia(sourcePath);
    await assembleRemake({ workDir: dir, segments, width: probe.width, height: probe.height, frameRate: probe.frameRate, audio, outPath });
    const size = (await stat(outPath)).size;
    const { material } = await storeLocalMaterial(
      join(getUploadsDir(), "_library"),
      `${title}.mp4`,
      Readable.toWeb(createReadStream(outPath)) as ReadableStream<Uint8Array>,
      { expectedBytes: size },
    );
    const [row] = await getDb()
      .insert(libraryAssets)
      .values({
        mediaType: "video",
        importSource: "upload",
        filePath: `/api/files/_library/${encodeURIComponent(material.name)}`,
        title,
        description,
        tags: ["视频复刻"],
        sizeBytes: material.sizeBytes,
        width: material.width ?? null,
        height: material.height ?? null,
        durationSec: material.durationSec ?? null,
      })
      .returning();
    return NextResponse.json({ id: row.id, url: row.filePath, durationSec: row.durationSec });
  } catch (error) {
    console.error("remake finalize failed:", error);
    return apiError(req, error instanceof Error ? error.message : "合成失败", "Failed to assemble the remake", 500);
  } finally {
    await rm(outPath, { force: true });
  }
}

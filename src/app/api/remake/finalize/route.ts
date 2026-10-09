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
import { assembleRemake, cutSegment, type FinalAudio } from "@/lib/remake/render";
import type { LibrarySegment } from "@/lib/asset-library";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * POST /api/remake/finalize — stitch the edited and untouched segments back together, attach the
 * chosen audio, and file the result in the asset library.
 * body: { jobId, sourcePath, segments: [{ start, end, path, edited? }], audioMode: keep|mute|dub, dubPath?, title, description? }
 *
 * A remake made of several segments is filed as ONE library video that carries its parts: each part
 * is cut from the finished video (so it has the final audio and geometry) and stored alongside it,
 * so the library can play the whole clip or any single segment.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isJobId(body.jobId)) return apiError(req, "无效的任务", "Invalid job", 400);
  const sourcePath = resolveUploadFilePath(typeof body.sourcePath === "string" ? body.sourcePath : "");
  if (!sourcePath) return apiError(req, "无效的源视频", "Invalid source video", 400);

  const segments: Array<{ start: number; end: number; file: string; edited: boolean }> = [];
  for (const raw of Array.isArray(body.segments) ? body.segments : []) {
    const seg = raw as Record<string, unknown>;
    const file = resolveUploadFilePath(typeof seg.path === "string" ? seg.path : "");
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!file || !(end > start)) return apiError(req, "分段数据无效", "Invalid segment data", 400);
    segments.push({ start, end, file, edited: seg.edited !== false });
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
  const stamp = Date.now();
  const outPath = join(dir, `final-${stamp}.mp4`);
  const partPaths: string[] = [];
  const libraryDir = join(getUploadsDir(), "_library");
  const fileToLibrary = async (file: string, name: string) => {
    const { material } = await storeLocalMaterial(
      libraryDir,
      name,
      Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
      { expectedBytes: (await stat(file)).size },
    );
    return material;
  };
  try {
    const probe = await probeMedia(sourcePath);
    await assembleRemake({ workDir: dir, segments, width: probe.width, height: probe.height, frameRate: probe.frameRate, audio, outPath });
    const material = await fileToLibrary(outPath, `${title}.mp4`);

    let parts: LibrarySegment[] | null = null;
    if (segments.length > 1) {
      // positions in the finished video: segments are laid end to end from 0
      let offset = 0;
      parts = [];
      for (const [index, seg] of segments.entries()) {
        const span = { start: offset, end: offset + (seg.end - seg.start) };
        offset = span.end;
        const partPath = join(dir, `final-${stamp}-part-${index}.mp4`);
        partPaths.push(partPath);
        await cutSegment(outPath, span, partPath);
        const part = await fileToLibrary(partPath, `${title}-${index + 1}.mp4`);
        parts.push({
          index,
          start: Math.round(span.start * 1000) / 1000,
          end: Math.round(span.end * 1000) / 1000,
          url: `/api/files/_library/${encodeURIComponent(part.name)}`,
          edited: seg.edited,
        });
      }
    }
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
        segments: parts,
      })
      .returning();
    return NextResponse.json({ id: row.id, url: row.filePath, durationSec: row.durationSec, segments: parts });
  } catch (error) {
    console.error("remake finalize failed:", error);
    return apiError(req, error instanceof Error ? error.message : "合成失败", "Failed to assemble the remake", 500);
  } finally {
    await Promise.all([outPath, ...partPaths].map((file) => rm(file, { force: true })));
  }
}

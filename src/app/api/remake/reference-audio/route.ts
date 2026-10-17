import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import { join } from "path";
import { apiError } from "@/lib/api-error";
import { probeMedia } from "@/lib/media-probe";
import { isJobId, jobDir } from "@/lib/remake/jobs";
import { sliceAudio } from "@/lib/remake/render";
import { validRemakeSegments } from "@/lib/remake/plan";
import { registerReferenceFile, requireReferenceStorage } from "@/lib/reference-resource-server";
import type { ReferenceResource } from "@/lib/reference-resource";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Import a replacement audio track and cut it at exactly the video's absolute boundaries. */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const config: unknown = JSON.parse(String(form.get("objectStorage")));
    requireReferenceStorage(config);
    const jobId = form.get("jobId");
    const file = form.get("file");
    const duration = Number(form.get("duration"));
    const segments: unknown = JSON.parse(String(form.get("segments")));
    if (!isJobId(jobId) || !Number.isFinite(duration) || !validRemakeSegments(segments, duration)) return apiError(req, "分段数据无效", "Invalid segments", 400);
    if (!(file instanceof File) || !/\.(wav|mp3)$/i.test(file.name) || !file.size || file.size > 200 * 1024 * 1024) return apiError(req, "请上传 WAV/MP3 音频（≤200MB）", "Upload WAV/MP3 audio (up to 200MB)", 400);
    const dir = await jobDir(jobId);
    const stamp = `${Date.now()}-${crypto.randomUUID()}`;
    const name = `reference-${stamp}.${file.name.toLowerCase().endsWith(".wav") ? "wav" : "mp3"}`;
    const path = join(dir, name);
    await writeFile(path, Buffer.from(await file.arrayBuffer()));
    const probe = await probeMedia(path);
    if (!probe.hasAudio || probe.duration < duration - 0.05) return apiError(req, "音频需覆盖整条视频时长，以便按相同时间段切割", "Audio must cover the full video timeline for aligned slicing", 400);
    const segmentAudio: Record<number, string> = {};
    const resource = await registerReferenceFile(config, path, file.name);
    const audioResources: Record<number, ReferenceResource> = {};
    for (const segment of segments) {
      const slice = `reference-${stamp}-seg-${segment.index}.mp3`;
      await sliceAudio(path, segment, join(dir, slice));
      const audioResource = await registerReferenceFile(config, join(dir, slice), `${file.name} · ${segment.start}–${segment.end}s`);
      segmentAudio[segment.index] = audioResource.path;
      audioResources[segment.index] = audioResource;
    }
    return NextResponse.json({ path: resource.path, resource, segmentAudio, audioResources });
  } catch (error) {
    return apiError(req, error instanceof Error ? error.message : "音频导入失败", "Audio import failed", 500);
  }
}

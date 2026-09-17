import { NextRequest, NextResponse } from "next/server";
import { mkdir, readdir, rm } from "fs/promises";
import { join } from "path";
import { getUploadsDir } from "@/lib/paths";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { mapWithConcurrency } from "@/lib/concurrency";
import { extractFrameAtTime } from "@/lib/video-composer/frame-extract";
import { generateContactSheet } from "@/lib/video-composer/contact-sheet";
import { apiError, errText } from "@/lib/api-error";
import {
  blockingStage,
  keyFrameTimes,
  shotContains,
  type FrameSlot,
  type FramesResult,
  type ShotFrame,
  type ShotFrames,
} from "@/lib/reference-analysis";
import {
  analysisUploadsSubdir,
  currentStaleFrom,
  loadAnalysis,
  viewOf,
  writeStage,
  type ReferenceAnalysisRow,
} from "@/lib/reference-analysis-store";

/** Longest side of an extracted key frame — enough to read a shot, and for a vision model later. */
const FRAME_MAX_SIDE = 720;
/** ffmpeg seeks in flight at once for one run. */
const EXTRACT_CONCURRENCY = 4;

// one frames run per breakdown at a time; survives route-module reloads in dev
const globalRuns = globalThis as unknown as { __clipforgeFrameRuns?: Set<string> };
const activeRuns = (globalRuns.__clipforgeFrameRuns ??= new Set<string>());

const publicUrl = (id: string, runId: string, file: string) =>
  `/api/files/${[...analysisUploadsSubdir(id), runId, file].join("/")}`;
const diskDir = (id: string, runId?: string) =>
  join(getUploadsDir(), ...analysisUploadsSubdir(id), ...(runId ? [runId] : []));

/**
 * POST /api/replicate/analyze/frames — S2 of the breakdown: what each shot looks like.
 *
 *  - `{ analysisId }` takes the first / middle / last frame of every shot plus a contact sheet
 *    of the whole clip with the current cuts marked. A re-run replaces the previous run's files.
 *  - `{ analysisId, shotIndex, representative }` picks which frame stands for a shot.
 *  - `{ analysisId, shotIndex, time }` grabs an extra frame at `time` (inside that shot) and makes
 *    it the representative — for when none of the three sampled frames is the telling one.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const row = await loadAnalysis(body.analysisId);
  if (!row?.ingest) return apiError(req, "拆解记录不存在", "Breakdown not found", 404);

  if (body.shotIndex !== undefined) return editShotFrame(req, row, body);

  const blocked = blockingStage("frames", row, currentStaleFrom(row));
  if (blocked || !row.cuts) {
    return apiError(req, "镜头切分还没有完成", "Shot cuts must be ready before taking frames", 409);
  }
  if (activeRuns.has(row.id)) {
    return apiError(req, "正在取帧，请稍候", "Frames are already being taken for this breakdown", 409);
  }
  const videoPath = resolveUploadFilePath(row.ingest.path);
  if (!videoPath) return apiError(req, "参考视频路径无效", "Invalid reference video path", 400);

  activeRuns.add(row.id);
  const started = Date.now();
  // bound to consts so the null checks above still hold inside the callbacks below
  const cuts = row.cuts;
  const ingest = row.ingest;
  const runId = `frames-${started}`;
  const dir = diskDir(row.id, runId);
  try {
    await mkdir(dir, { recursive: true });
    const jobs = cuts.shots.flatMap((shot) =>
      Object.entries(keyFrameTimes(shot, ingest.duration)).map(([slot, time]) => ({ shot, slot: slot as FrameSlot, time }))
    );
    const grabbed = await mapWithConcurrency(jobs, EXTRACT_CONCURRENCY, async (job) => {
      const file = `shot-${job.shot.index}-${job.slot}.jpg`;
      const ok = await extractFrameAtTime(videoPath, job.time, join(dir, file), { maxSide: FRAME_MAX_SIDE });
      return ok ? { ...job, url: publicUrl(row.id, runId, file) } : null;
    });
    if (grabbed.every((g) => g === null)) {
      throw new Error(errText(req, "一帧都没有取出来，视频可能无法解码", "No frame could be extracted — the video may not decode"));
    }

    const shots: ShotFrames[] = cuts.shots.map((shot) => {
      const frames: ShotFrame[] = grabbed
        .filter((g): g is NonNullable<typeof g> => g?.shot.index === shot.index)
        .map((g) => ({ slot: g.slot, time: g.time, url: g.url }));
      const mid = frames.findIndex((f) => f.slot === "mid");
      return { index: shot.index, start: shot.start, duration: shot.duration, frames, representative: Math.max(0, mid) };
    });

    // best-effort: a missing sheet (e.g. an ffmpeg without drawtext) must not sink the frames
    let contactSheet: string | undefined;
    try {
      await generateContactSheet({
        videoPath,
        outPath: join(dir, "sheet.png"),
        frames: cuts.shots.length,
        knownCuts: cuts.cuts,
        detectScenes: false,
      });
      contactSheet = publicUrl(row.id, runId, "sheet.png");
    } catch (error) {
      console.warn("Reference contact sheet failed:", error);
    }

    const frames: FramesResult = { runId, shots, contactSheet, cutsRevision: cuts.revision, durationMs: Date.now() - started };
    // the cuts may have been edited while ffmpeg ran: store the frames, but as already stale
    const fresh = (await loadAnalysis(row.id)) ?? row;
    const raced = fresh.cuts?.revision !== cuts.revision;
    const updated = await writeStage(fresh, "run", { frames }, raced ? { staleFrom: "frames" } : {});
    await removeOtherRuns(row.id, runId);
    return NextResponse.json(viewOf(updated));
  } catch (error) {
    console.error("Reference frame extraction failed:", error);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "关键帧提取失败", "Key frame extraction failed") },
      { status: 500 }
    );
  } finally {
    activeRuns.delete(row.id);
  }
}

/** Pick a shot's representative frame, or grab a new one at a chosen time. */
async function editShotFrame(req: NextRequest, row: ReferenceAnalysisRow, body: Record<string, unknown>) {
  const { frames } = row;
  if (!frames || !row.ingest) return apiError(req, "还没有关键帧", "No frames have been taken yet", 409);
  const shot = frames.shots.find((s) => s.index === body.shotIndex);
  if (!shot) return apiError(req, "镜头不存在", "No such shot", 400);

  let nextShot: ShotFrames;
  if (typeof body.representative === "number") {
    if (!Number.isInteger(body.representative) || !shot.frames[body.representative]) {
      return apiError(req, "代表帧不存在", "No such frame", 400);
    }
    nextShot = { ...shot, representative: body.representative };
  } else if (typeof body.time === "number" && Number.isFinite(body.time)) {
    if (!shotContains(shot, body.time)) {
      return apiError(req, "所选时间不在这个镜头内", "That time is outside this shot", 400);
    }
    const videoPath = resolveUploadFilePath(row.ingest.path);
    if (!videoPath) return apiError(req, "参考视频路径无效", "Invalid reference video path", 400);
    const dir = diskDir(row.id, frames.runId);
    await mkdir(dir, { recursive: true });
    const time = Math.round(body.time * 100) / 100;
    const file = `shot-${shot.index}-custom-${Date.now()}.jpg`;
    const ok = await extractFrameAtTime(videoPath, time, join(dir, file), { maxSide: FRAME_MAX_SIDE });
    if (!ok) return apiError(req, "这一帧没有取出来", "Could not extract that frame", 500);
    // one custom frame per shot: a new pick replaces the last one
    const kept = shot.frames.filter((f) => f.slot !== "custom");
    const custom: ShotFrame = { slot: "custom", time, url: publicUrl(row.id, frames.runId, file) };
    nextShot = { ...shot, frames: [...kept, custom], representative: kept.length };
  } else {
    return apiError(req, "请提供 representative 或 time", "Provide either representative or time", 400);
  }

  const updated = await writeStage(row, "edit", {
    frames: { ...frames, shots: frames.shots.map((s) => (s.index === shot.index ? nextShot : s)) },
  });
  return NextResponse.json(viewOf(updated));
}

/** Delete earlier runs' frame directories — the row no longer points at them. */
async function removeOtherRuns(id: string, keepRunId: string) {
  const entries = await readdir(diskDir(id)).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => name.startsWith("frames-") && name !== keepRunId)
      .map((name) => rm(diskDir(id, name), { recursive: true, force: true }).catch(() => {}))
  );
}

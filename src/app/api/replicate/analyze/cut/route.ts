import { NextRequest, NextResponse } from "next/server";
import { probeMedia } from "@/lib/media-probe";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { detectSceneTimes } from "@/lib/video-composer/contact-sheet";
import { shotPlanFromCuts } from "@/lib/replicate-plan";
import { apiError, errText } from "@/lib/api-error";
import {
  clampThreshold,
  cutsFromShots,
  normalizeCuts,
  sameCuts,
  shotsFromCuts,
} from "@/lib/reference-analysis";
import { currentStaleFrom, loadAnalysis, viewOf, writeStage } from "@/lib/reference-analysis-store";

/**
 * POST /api/replicate/analyze/cut — S1 of the breakdown: re-detect or hand-edit the shot cuts.
 *
 *  - `{ analysisId, threshold }` re-runs scene detection at a new threshold (0.1–0.6).
 *  - `{ analysisId, cuts: number[] }` stores a hand-edited cut list (shot start times, 0 excluded).
 *    It is normalised — out-of-range and too-close cuts are dropped — and never re-merged: a
 *    human placed these, so no minimum-shot or shot-count rule overrides them.
 *
 * Either way frames (and anything later) that already exist become stale but are kept.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const row = await loadAnalysis(body.analysisId);
  if (!row?.ingest || !row.cuts) return apiError(req, "拆解记录不存在", "Breakdown not found", 404);
  const { ingest, cuts: previous } = row;
  const started = Date.now();

  try {
    if (Array.isArray(body.cuts)) {
      const cuts = normalizeCuts(body.cuts, ingest.duration);
      // an edit that lands back where it started changes nothing, including staleness
      if (sameCuts(cuts, previous.cuts)) return NextResponse.json(viewOf(row));
      const updated = await writeStage(row, "edit", {
        cuts: {
          ...previous,
          cuts,
          shots: shotsFromCuts(cuts, ingest.duration),
          edited: true,
          revision: previous.revision + 1,
          // durationMs stays the detector's: timing a DB write would say nothing
        },
      });
      return NextResponse.json(viewOf(updated));
    }

    if (body.threshold === undefined) {
      return apiError(req, "请提供 cuts 或 threshold", "Provide either cuts or threshold", 400);
    }
    const filePath = resolveUploadFilePath(ingest.path);
    if (!filePath) return apiError(req, "参考视频路径无效", "Invalid reference video path", 400);
    const threshold = clampThreshold(body.threshold);
    // a missing file makes the probe throw — surfaced below rather than silently finding no cuts
    const probe = await probeMedia(filePath);
    const detected = await detectSceneTimes(filePath, threshold);
    const shots = shotPlanFromCuts(detected, probe.duration || ingest.duration);
    const cuts = cutsFromShots(shots);
    // same cuts as before: same revision, and whatever was fresh downstream stays fresh
    const unchanged = sameCuts(cuts, previous.cuts);
    const updated = await writeStage(
      row,
      "run",
      {
        cuts: {
          threshold,
          detected,
          cuts,
          shots,
          edited: false,
          revision: unchanged ? previous.revision : previous.revision + 1,
          durationMs: Date.now() - started,
        },
      },
      unchanged ? { staleFrom: currentStaleFrom(row) } : {},
    );
    return NextResponse.json(viewOf(updated));
  } catch (error) {
    console.error("Reference cut detection failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "镜头切分失败", "Shot cut detection failed") },
      { status: 500 }
    );
  }
}

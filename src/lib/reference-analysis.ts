/**
 * Viral-video breakdown pipeline (爆款拆解) — the pure half: stage order, staleness, shot-cut
 * editing and key-frame timing. See docs/reference-analysis-workflow.md for the whole design.
 *
 *   S0 ingest → S1 cuts → S2 frames → S3 vision → S4 audio → S5 structure → S6 reference
 *
 * Each stage's output is one JSON column on `reference_analyses`. Every stage can be re-run or
 * hand-edited on its own; writing a stage marks the first downstream stage that already holds a
 * result as `staleFrom`, and everything from there on is out of date. Stale results are kept, not
 * deleted, so they stay visible until they are re-run.
 *
 * No I/O here — the routes under /api/replicate/analyze do the ffmpeg work and the DB writes.
 */

import { replicateReferenceStructure, REPLICATE_MAX_REF_SEC, type ReplicateShot } from "@/lib/replicate-plan";

export const ANALYSIS_STAGES = ["ingest", "cuts", "frames", "vision", "audio", "structure", "reference"] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

/** S0: what the reference clip is. */
export interface IngestResult {
  /** `/api/files/...` path of the clip — an upload, or a library clip analysed in place */
  path: string;
  source: "upload" | "library";
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
  orientation: "portrait" | "landscape" | "square";
}

/** S1: where the shots break. `cuts` (shot start times, 0 excluded) is the editable truth. */
export interface CutsResult {
  /** scene-score threshold the detector last ran with */
  threshold: number;
  /** raw detector output, kept so a hand edit can always be compared against it */
  detected: number[];
  cuts: number[];
  shots: ReplicateShot[];
  /** true once a human has moved, added or removed a cut since the last detection */
  edited: boolean;
  /** bumped on every write — a frames run that started on an older revision knows it is stale */
  revision: number;
  durationMs: number;
}

export type FrameSlot = "first" | "mid" | "last" | "custom";

export interface ShotFrame {
  slot: FrameSlot;
  time: number;
  url: string;
}

export interface ShotFrames {
  index: number;
  start: number;
  duration: number;
  frames: ShotFrame[];
  /** index into `frames` of the frame that stands for this shot */
  representative: number;
}

/** S2: what each shot looks like. */
export interface FramesResult {
  /** directory name of this run under the breakdown's upload dir; a re-run replaces it */
  runId: string;
  shots: ShotFrames[];
  /** whole-clip contact sheet with the cuts marked; absent when rendering it failed */
  contactSheet?: string;
  /** the cuts revision these frames were taken from */
  cutsRevision: number;
  durationMs: number;
}

/** A stage's result as stored, or null when it has never run. */
export type AnalysisStageData = Partial<Record<AnalysisStage, unknown>>;

/** Scene-score threshold bounds — the same clamp detectSceneTimes applies. */
export const CUT_THRESHOLD_MIN = 0.1;
export const CUT_THRESHOLD_MAX = 0.6;
export const CUT_THRESHOLD_DEFAULT = 0.22;
/** A hand-placed cut closer than this to a neighbour (or the clip edges) is dropped. */
export const MIN_SHOT_GAP_SEC = 0.3;
/** Hand edits may go past the detector's 12-shot skeleton cap, but not without bound. */
export const MAX_EDITED_SHOTS = 40;

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

export function stageIndex(stage: AnalysisStage): number {
  return ANALYSIS_STAGES.indexOf(stage);
}

export function isAnalysisStage(value: unknown): value is AnalysisStage {
  return typeof value === "string" && (ANALYSIS_STAGES as readonly string[]).includes(value);
}

/** Whether `stage`'s stored result is out of date. */
export function isStageStale(stage: AnalysisStage, staleFrom: AnalysisStage | null | undefined): boolean {
  return !!staleFrom && stageIndex(stage) >= stageIndex(staleFrom);
}

/**
 * The `staleFrom` to store after `stage` was written: the first downstream stage that holds a
 * result, or null when nothing downstream has run.
 *
 * An earlier staleFrom survives — writing a stage does not freshen its inputs. And only a `run`
 * freshens the stage itself: hand-editing a stale result (picking a frame out of frames taken
 * from outdated cuts) leaves it stale.
 */
export function staleFromAfterWrite(
  stage: AnalysisStage,
  data: AnalysisStageData,
  current: AnalysisStage | null | undefined,
  kind: "run" | "edit",
): AnalysisStage | null {
  if (current && stageIndex(current) < stageIndex(stage)) return current;
  if (current === stage && kind === "edit") return current;
  return ANALYSIS_STAGES.slice(stageIndex(stage) + 1).find((s) => data[s] != null) ?? null;
}

/** The upstream stage that keeps `stage` from running — missing or stale — or null when it may run. */
export function blockingStage(
  stage: AnalysisStage,
  data: AnalysisStageData,
  staleFrom: AnalysisStage | null | undefined,
): AnalysisStage | null {
  for (const upstream of ANALYSIS_STAGES.slice(0, stageIndex(stage))) {
    if (data[upstream] == null || isStageStale(upstream, staleFrom)) return upstream;
  }
  return null;
}

export function orientationOf(width: number, height: number): IngestResult["orientation"] {
  if (!(width > 0) || !(height > 0) || width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

export function clampThreshold(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return CUT_THRESHOLD_DEFAULT;
  return Math.round(Math.min(CUT_THRESHOLD_MAX, Math.max(CUT_THRESHOLD_MIN, n)) * 100) / 100;
}

/**
 * Clean a hand-edited cut list: finite, rounded to 0.1s, inside the clip, ascending, at least
 * MIN_SHOT_GAP_SEC from the edges and from the previous kept cut, and no more than
 * MAX_EDITED_SHOTS shots. Anything that fails is dropped rather than rejected — a drag that
 * overshoots should snap, not error.
 */
export function normalizeCuts(cuts: readonly unknown[], duration: number): number[] {
  if (!(duration > 0)) return [];
  const sorted = cuts
    .map((c) => (typeof c === "number" ? round1(c) : NaN))
    .filter((c) => Number.isFinite(c) && c >= MIN_SHOT_GAP_SEC && c <= duration - MIN_SHOT_GAP_SEC)
    .sort((a, b) => a - b);
  const kept: number[] = [];
  for (const c of sorted) {
    if (kept.length && c - kept[kept.length - 1] < MIN_SHOT_GAP_SEC) continue;
    kept.push(c);
    if (kept.length >= MAX_EDITED_SHOTS - 1) break;
  }
  return kept;
}

/** Segment the clip exactly at `cuts` — no merging, unlike shotPlanFromCuts: a human placed these. */
export function shotsFromCuts(cuts: readonly number[], duration: number): ReplicateShot[] {
  if (!(duration > 0)) return [];
  const bounds = [0, ...normalizeCuts(cuts, duration), duration];
  const shots: ReplicateShot[] = [];
  for (let i = 1; i < bounds.length; i++) {
    shots.push({ index: i, start: round1(bounds[i - 1]), duration: round1(bounds[i] - bounds[i - 1]) });
  }
  return shots;
}

/** The cut list a shot skeleton implies (each shot's start except the first). */
export function cutsFromShots(shots: readonly ReplicateShot[]): number[] {
  return shots.slice(1).map((s) => s.start);
}

/** Remove the cut between shot `shotIndex` (1-based) and the next one. */
export function mergeWithNext(cuts: readonly number[], shotIndex: number): number[] {
  if (shotIndex < 1 || shotIndex > cuts.length) return [...cuts];
  return cuts.filter((_, i) => i !== shotIndex - 1);
}

/** Add a cut at `time`; a time too close to an existing cut or an edge is ignored. */
export function splitAt(cuts: readonly number[], time: number, duration: number): number[] {
  return normalizeCuts([...cuts, time], duration).length > cuts.length
    ? normalizeCuts([...cuts, time], duration)
    : [...cuts];
}

/**
 * Move cut `cutIndex` (0-based) to `time`, clamped between its neighbours so a drag can never
 * reorder shots or swallow one.
 */
export function moveCut(cuts: readonly number[], cutIndex: number, time: number, duration: number): number[] {
  if (cutIndex < 0 || cutIndex >= cuts.length || !Number.isFinite(time)) return [...cuts];
  const lo = (cutIndex === 0 ? 0 : cuts[cutIndex - 1]) + MIN_SHOT_GAP_SEC;
  const hi = (cutIndex === cuts.length - 1 ? duration : cuts[cutIndex + 1]) - MIN_SHOT_GAP_SEC;
  if (lo > hi) return [...cuts];
  const next = [...cuts];
  next[cutIndex] = round1(Math.min(hi, Math.max(lo, time)));
  return next;
}

export function sameCuts(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.05);
}

/**
 * First / middle / last frame times of a shot. The edges are pulled inward a little so a grab
 * never lands on the neighbouring shot's frame across the cut, nor past the end of the clip.
 */
export function keyFrameTimes(shot: Pick<ReplicateShot, "start" | "duration">, clipDuration: number): Record<Exclude<FrameSlot, "custom">, number> {
  const inset = Math.min(0.15, shot.duration * 0.15);
  const end = Math.min(shot.start + shot.duration, clipDuration);
  const last = Math.max(shot.start, Math.min(end - inset, clipDuration - 0.05));
  return {
    first: round2(Math.min(shot.start + inset, last)),
    mid: round2(Math.min(shot.start + shot.duration / 2, last)),
    last: round2(last),
  };
}

/** Whether `time` falls within a shot (end-exclusive, but the clip's last instant counts). */
export function shotContains(shot: Pick<ReplicateShot, "start" | "duration">, time: number): boolean {
  return time >= shot.start && time <= shot.start + shot.duration;
}

/** Stored row → the shape every analyze route answers with. Also carries the legacy one-shot fields. */
export interface ReferenceAnalysisView {
  analysisId: string;
  path: string;
  duration: number;
  width: number;
  height: number;
  shots: ReplicateShot[];
  referenceStructure: string;
  modelTierEligible: boolean;
  maxRefSec: number;
  ingest: IngestResult;
  cuts: CutsResult | null;
  frames: FramesResult | null;
  staleFrom: AnalysisStage | null;
}

export function toAnalysisView(row: {
  id: string;
  ingest: IngestResult;
  cuts: CutsResult | null;
  frames: FramesResult | null;
  staleFrom: string | null;
}): ReferenceAnalysisView {
  const { ingest } = row;
  const shots = row.cuts?.shots ?? [];
  return {
    analysisId: row.id,
    path: ingest.path,
    duration: ingest.duration,
    width: ingest.width,
    height: ingest.height,
    shots,
    referenceStructure: replicateReferenceStructure(shots, ingest.duration),
    modelTierEligible: ingest.duration <= REPLICATE_MAX_REF_SEC,
    maxRefSec: REPLICATE_MAX_REF_SEC,
    ingest,
    cuts: row.cuts,
    frames: row.frames,
    staleFrom: isAnalysisStage(row.staleFrom) ? row.staleFrom : null,
  };
}

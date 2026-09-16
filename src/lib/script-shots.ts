/**
 * Shot-list surgery shared by the script page and the scripts route.
 *
 * Kept dependency-free on purpose: the page imports the floor constant, and pulling that from the
 * script engine would drag the OpenAI SDK into the client bundle.
 */
import type { Shot } from "@/lib/db/schema";

/**
 * A variant may never be edited below this. The storyboard grid, the one-call film pass and
 * compose all need at least two shots to cut between and reject anything shorter, so the delete
 * has to stop here rather than let the user walk the script into a state the next step refuses.
 */
export const MIN_SHOTS_AFTER_DELETE = 2;

export type ShotDeletionPlan =
  | { ok: true; shots: Shot[]; totalDuration: number }
  | { ok: false; reason: "empty" | "notFound" | "tooFew" };

/**
 * Work out what a variant looks like after dropping `dropIds`.
 *
 * Survivors keep their ORIGINAL shotId. Renumbering would silently re-point every asset, review
 * and composition keyed by shot id at a different shot; downstream code indexes shots by id, never
 * by "1..n must be contiguous", so a gap costs nothing. totalDuration is re-totalled because it is
 * the planning contract the film pass and the duration readiness check read.
 */
export function planShotDeletion(shots: Shot[], dropIds: number[]): ShotDeletionPlan {
  const drop = new Set(dropIds.filter((n): n is number => typeof n === "number" && Number.isFinite(n)));
  if (drop.size === 0) return { ok: false, reason: "empty" };

  const kept = shots.filter((shot) => !drop.has(shot.shotId));
  if (kept.length === shots.length) return { ok: false, reason: "notFound" };
  if (kept.length < MIN_SHOTS_AFTER_DELETE) return { ok: false, reason: "tooFew" };

  return { ok: true, shots: kept, totalDuration: kept.reduce((sum, shot) => sum + (shot.duration || 0), 0) };
}

/**
 * Editable bounds for a per-shot duration.
 *
 * Hard range = what compose will honour: it clamps every slot to 1.5–20s, so anything stored
 * outside this is dead data. Recommended range = what the image-to-video pass actually generates
 * at — `generateMotion` sends the shot duration as the billed call's `options.duration` and
 * rounds it into MOTION_DURATION_MIN..MAX, so a 2s shot still costs a 4s clip.
 * Both are surfaced in the editor: the input enforces the hard range, the hint states the
 * recommended one.
 */
export const SHOT_DURATION_MIN = 1;
export const SHOT_DURATION_MAX = 20;
export const MOTION_DURATION_MIN = 4;
export const MOTION_DURATION_MAX = 15;

/**
 * Coerce user/API input into a storable duration: whole seconds inside the hard range.
 * Returns null for anything non-numeric, so a bad payload is rejected rather than silently
 * turning a shot into 0s (which compose would read as "use the 3s fallback").
 */
export function sanitizeShotDuration(raw: unknown): number | null {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Number("") and Number(" ") are both 0 — an empty field is "no input", not "zero seconds"
    if (!trimmed) return null;
    value = Number(trimmed);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(SHOT_DURATION_MAX, Math.max(SHOT_DURATION_MIN, Math.round(value)));
}

/** What the i2v call will really generate at, given a stored shot duration. */
export function motionDurationFor(duration: number): number {
  return Math.min(MOTION_DURATION_MAX, Math.max(MOTION_DURATION_MIN, Math.round(duration)));
}

export type ShotDurationPlan =
  | { ok: true; shots: Shot[]; totalDuration: number }
  | { ok: false; reason: "empty" | "notFound" | "invalid" };

/**
 * Work out what a variant looks like after per-shot duration edits.
 *
 * totalDuration is re-totalled for the same reason deletion re-totals it: it is the planning
 * contract the one-call film pass and the duration readiness check read, and a stale total makes
 * those two disagree with the shot list they are built from.
 */
export function planShotDurations(
  shots: Shot[],
  patches: Array<{ shotId?: unknown; duration?: unknown }>,
): ShotDurationPlan {
  const byShot = new Map<number, number>();
  for (const patch of patches) {
    if (!patch || typeof patch.shotId !== "number" || !Number.isFinite(patch.shotId)) continue;
    const duration = sanitizeShotDuration(patch.duration);
    if (duration === null) return { ok: false, reason: "invalid" };
    byShot.set(patch.shotId, duration);
  }
  if (byShot.size === 0) return { ok: false, reason: "empty" };
  if (![...byShot.keys()].every((shotId) => shots.some((shot) => shot.shotId === shotId))) {
    return { ok: false, reason: "notFound" };
  }

  const next = shots.map((shot) => {
    const duration = byShot.get(shot.shotId);
    return duration === undefined ? shot : { ...shot, duration };
  });
  return { ok: true, shots: next, totalDuration: next.reduce((sum, shot) => sum + (shot.duration || 0), 0) };
}

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

/**
 * Viral-video breakdown persistence: load a `reference_analyses` row and write one stage of it.
 * Every write goes through `writeStage`, so `staleFrom` is maintained in exactly one place.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { referenceAnalyses } from "@/lib/db/schema";
import {
  isAnalysisStage,
  staleFromAfterWrite,
  toAnalysisView,
  type AnalysisStage,
  type CutsResult,
  type FramesResult,
  type IngestResult,
  type ReferenceAnalysisView,
} from "@/lib/reference-analysis";

export type ReferenceAnalysisRow = typeof referenceAnalyses.$inferSelect;

/** Directory (under uploads/) that holds one breakdown's extracted frames. */
export function analysisUploadsSubdir(id: string): string[] {
  return ["replicate", "analyses", id];
}

export async function createAnalysis(input: { ingest: IngestResult; cuts: CutsResult }): Promise<ReferenceAnalysisRow> {
  const [row] = await getDb()
    .insert(referenceAnalyses)
    .values({ sourcePath: input.ingest.path, ingest: input.ingest, cuts: input.cuts })
    .returning();
  return row;
}

export async function loadAnalysis(id: unknown): Promise<ReferenceAnalysisRow | null> {
  if (typeof id !== "string" || !id.trim()) return null;
  const [row] = await getDb().select().from(referenceAnalyses).where(eq(referenceAnalyses.id, id)).limit(1);
  return row ?? null;
}

export function currentStaleFrom(row: ReferenceAnalysisRow): AnalysisStage | null {
  return isAnalysisStage(row.staleFrom) ? row.staleFrom : null;
}

/**
 * Store a stage result — a `run` of the stage or a hand `edit` of it — and recompute `staleFrom`.
 * A caller that knows better passes `staleFrom` explicitly: a frames run that raced a cut edit is
 * stale on arrival, and a re-detection that found the very same cuts leaves downstream as it was.
 */
export async function writeStage(
  row: ReferenceAnalysisRow,
  kind: "run" | "edit",
  patch: { cuts: CutsResult } | { frames: FramesResult },
  opts: { staleFrom?: AnalysisStage | null } = {},
): Promise<ReferenceAnalysisRow> {
  const stage: AnalysisStage = "cuts" in patch ? "cuts" : "frames";
  const staleFrom =
    opts.staleFrom !== undefined ? opts.staleFrom : staleFromAfterWrite(stage, row, currentStaleFrom(row), kind);
  const [updated] = await getDb()
    .update(referenceAnalyses)
    .set({ ...patch, staleFrom, updatedAt: new Date() })
    .where(eq(referenceAnalyses.id, row.id))
    .returning();
  return updated;
}

export function viewOf(row: ReferenceAnalysisRow): ReferenceAnalysisView {
  if (!row.ingest) throw new Error(`reference analysis ${row.id} has no ingest result`);
  return toAnalysisView({
    id: row.id,
    ingest: row.ingest,
    cuts: row.cuts ?? null,
    frames: row.frames ?? null,
    staleFrom: row.staleFrom ?? null,
  });
}

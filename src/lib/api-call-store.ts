/**
 * Database-backed recorder for the API call log (server only).
 *
 * Split from api-call-log.ts because that module is reachable from client components; importing
 * the database there would pull better-sqlite3 and `fs` into the browser bundle. Importing THIS
 * module installs it as the active sink, which src/instrumentation.ts does once at server startup,
 * before any request is handled.
 */

import { and, desc, eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiCalls } from "@/lib/db/schema";
import {
  setApiCallSink,
  type ApiCallFilters,
  type RecordApiCallInput,
  type UpdateApiCallPatch,
} from "@/lib/api-call-log";
import { loadPriceOverrides } from "@/lib/model-pricing-file";

/** Rows kept before the oldest are dropped (a busy day is a few hundred calls). */
export const API_CALL_RETENTION = 5000;

let writesSincePrune = 0;

/** Insert one row; returns the row id, or null when the write failed. */
export async function recordApiCallRow(input: RecordApiCallInput): Promise<string | null> {
  try {
    const db = getDb();
    const [row] = await db
      .insert(apiCalls)
      .values({
        modelType: input.modelType,
        scene: input.scene ?? null,
        provider: input.provider.slice(0, 80),
        model: input.model.slice(0, 240),
        baseUrl: input.baseUrl?.slice(0, 240) ?? null,
        endpoint: input.endpoint?.slice(0, 240) ?? null,
        projectId: input.projectId ?? null,
        shotId: Number.isFinite(input.shotId) ? (input.shotId as number) : null,
        status: input.status ?? "success",
        httpStatus: Number.isFinite(input.httpStatus) ? (input.httpStatus as number) : null,
        latencyMs: Number.isFinite(input.latencyMs) ? Math.round(input.latencyMs as number) : null,
        streamed: input.streamed ?? false,
        request: input.request ?? null,
        response: input.response ?? null,
        usage: input.usage ?? null,
        cost: input.cost ?? null,
        error: input.error?.slice(0, 1000) ?? null,
        taskId: input.taskId?.slice(0, 200) ?? null,
      })
      .returning({ id: apiCalls.id });

    if (++writesSincePrune >= 200) {
      writesSincePrune = 0;
      void pruneApiCalls();
    }
    return row?.id ?? null;
  } catch (error) {
    console.warn("API 调用记录写入失败（不影响本次调用）:", error);
    return null;
  }
}

/** Patch a row written before the result was known. */
export async function updateApiCallRow(id: string | null, patch: UpdateApiCallPatch): Promise<void> {
  if (!id) return;
  try {
    const db = getDb();
    await db
      .update(apiCalls)
      .set({
        ...(patch.status && { status: patch.status }),
        ...(patch.response && { response: patch.response }),
        ...(patch.usage && { usage: patch.usage }),
        ...(patch.cost && { cost: patch.cost }),
        ...(patch.error !== undefined && { error: patch.error?.slice(0, 1000) ?? null }),
        ...(Number.isFinite(patch.latencyMs) && { latencyMs: Math.round(patch.latencyMs as number) }),
        ...(patch.taskId && { taskId: patch.taskId.slice(0, 200) }),
      })
      .where(eq(apiCalls.id, id));
  } catch (error) {
    console.warn("API 调用记录更新失败:", error);
  }
}

/** Drop everything older than the newest API_CALL_RETENTION rows. */
export async function pruneApiCalls(keep = API_CALL_RETENTION): Promise<void> {
  try {
    const db = getDb();
    const [cutoff] = await db
      .select({ createdAt: apiCalls.createdAt })
      .from(apiCalls)
      .orderBy(desc(apiCalls.createdAt))
      .limit(1)
      .offset(keep);
    if (!cutoff?.createdAt) return;
    await db.delete(apiCalls).where(lt(apiCalls.createdAt, cutoff.createdAt));
  } catch {
    // pruning is housekeeping — a failure is not worth surfacing
  }
}

/** Translate filters into a drizzle predicate (exported for the read route and tests). */
export function apiCallWhere(filters: ApiCallFilters): SQL | undefined {
  const clauses: SQL[] = [];
  if (filters.modelType) clauses.push(eq(apiCalls.modelType, filters.modelType));
  if (filters.scene) clauses.push(eq(apiCalls.scene, filters.scene));
  if (filters.provider) clauses.push(eq(apiCalls.provider, filters.provider));
  if (filters.model) clauses.push(eq(apiCalls.model, filters.model));
  if (filters.status) clauses.push(eq(apiCalls.status, filters.status));
  if (filters.projectId) clauses.push(eq(apiCalls.projectId, filters.projectId));
  if (Number.isFinite(filters.since)) clauses.push(gte(apiCalls.createdAt, new Date(filters.since as number)));
  if (Number.isFinite(filters.until)) clauses.push(lte(apiCalls.createdAt, new Date(filters.until as number)));
  if (filters.search?.trim()) {
    const like = `%${filters.search.trim().toLowerCase()}%`;
    clauses.push(
      sql`(lower(${apiCalls.model}) like ${like} or lower(coalesce(${apiCalls.request}, '')) like ${like} or lower(coalesce(${apiCalls.response}, '')) like ${like})`,
    );
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

// Importing this module is what turns logging on. The price overrides are refreshed on the way in
// (one mtime check) so an edited price table applies to the very next call, not the next restart.
setApiCallSink({
  record: (input) => {
    loadPriceOverrides();
    return recordApiCallRow(input);
  },
  update: updateApiCallRow,
});

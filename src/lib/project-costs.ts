import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiCalls, settings } from "@/lib/db/schema";
import { estimateMediaCost, type ApiCallCost } from "@/lib/model-pricing";

export interface ProjectCost { totalUsd: number; totalCny: number; calls: number; unpricedCalls: number }
type CostReceipt = Pick<typeof apiCalls.$inferSelect, "provider" | "model" | "modelType" | "scene" | "taskId" | "baseUrl" | "usage" | "request">;
type CostEntry = { status: string; cost: ApiCallCost | null; receipt?: CostReceipt };
/** Retain only pricing inputs, never prompts, media URLs or response bodies. */
function costReceipt(row: typeof apiCalls.$inferSelect): CostReceipt | undefined {
  if (row.modelType !== "video" || !row.taskId || row.scene === "agent_video") return;
  const detail = row.request?.detail as { duration?: number; inputVideoSeconds?: number; references?: string[]; extra?: { resolution?: string } } | undefined;
  return { provider: row.provider, model: row.model, modelType: row.modelType, scene: row.scene, taskId: row.taskId, baseUrl: row.baseUrl, usage: row.usage,
    request: { detail: { duration: detail?.duration, inputVideoSeconds: detail?.inputVideoSeconds, references: detail?.references?.some(r => r.startsWith("video:")) ? ["video:"] : [], extra: { resolution: detail?.extra?.resolution } } } };
}
export function retainedVideoCostCalls(provider: string, taskId: string) {
  return getDb().select().from(settings).all().flatMap(row => {
    if (!row.key.startsWith("project-cost:")) return [];
    const entries = (row.value as { entries?: Record<string, CostEntry> })?.entries ?? {};
    return Object.entries(entries).flatMap(([id, entry]) => entry.receipt?.provider === provider && entry.receipt.taskId === taskId
      ? [{ id, ...entry.receipt, cost: entry.cost, ledgerKey: row.key }] : []);
  });
}
export function updateRetainedVideoCost(key: string, id: string, patch: { status: string; cost: ApiCallCost | null; usage: CostReceipt["usage"] }) {
  const db = getDb(), row = db.select().from(settings).where(eq(settings.key, key)).get();
  const value = row?.value as { entries?: Record<string, CostEntry> } | undefined;
  const entry = value?.entries?.[id];
  if (!entry) return;
  entry.status = patch.status; entry.cost = patch.cost;
  if (entry.receipt) entry.receipt.usage = patch.usage;
  db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key)).run();
}
/** Reconstruct older Wan receipts when sufficient request measurements exist. Never guess duration. */
export function recordedCallCost(row: { provider: string; model: string; modelType: string; status: string; cost: ApiCallCost | null; usage: { videoSeconds?: number; resolution?: string } | null; request: { detail?: unknown } | null; baseUrl?: string | null }): ApiCallCost | null {
  if (row.cost?.totalUsd != null || row.cost?.totalCny != null || row.status === "failed") return row.cost;
  if (row.provider !== "alibaba" || row.modelType !== "video") return row.cost;
  const request = row.request?.detail as { duration?: number; inputVideoSeconds?: number; references?: string[]; extra?: { resolution?: string }; width?: number; height?: number } | undefined;
  const duration = row.usage?.videoSeconds ?? request?.duration;
  const videoInput = request?.references?.some(ref => ref.startsWith("video:"));
  const resolution = request?.extra?.resolution ?? row.usage?.resolution;
  return estimateMediaCost({ provider: row.provider, model: row.model, mediaType: "video", baseUrl: row.baseUrl ?? undefined, videoSeconds: duration, inputVideoSeconds: request?.inputVideoSeconds ?? (videoInput ? duration : 0), resolution });
}

export function backfillWanCallCosts() {
  const db = getDb();
  for (const row of db.select().from(apiCalls).all()) {
    const cost = recordedCallCost(row);
    if (cost?.totalCny != null && row.cost?.totalCny == null) db.update(apiCalls).set({ cost }).where(eq(apiCalls.id, row.id)).run();
  }
}

export function projectCosts(): Map<string, ProjectCost> {
  const db = getDb();
  type Entry = CostEntry;
  const ledgers = new Map<string, Record<string, Entry>>();
  const previous = new Map<string, string>();
  for (const row of db.select().from(settings).all()) {
    if (!row.key.startsWith("project-cost:")) continue;
    const value = row.value as { entries?: Record<string, Entry> };
    if (value?.entries) { ledgers.set(row.key.slice(13), value.entries); previous.set(row.key.slice(13), JSON.stringify(value.entries)); }
  }
  // Stable call IDs make reconciliation idempotent. Keep the minimal ledger after log retention
  // or a user clearing API logs, so a task's cumulative spending does not disappear.
  for (const row of db.select().from(apiCalls).all()) {
    if (!row.projectId) continue;
    const entries = ledgers.get(row.projectId) ?? {};
    entries[row.id] = { status: row.status, cost: recordedCallCost(row), receipt: costReceipt(row) };
    ledgers.set(row.projectId, entries);
  }
  const costs = new Map<string, ProjectCost>();
  for (const [projectId, entries] of ledgers) {
    if (JSON.stringify(entries) !== previous.get(projectId)) {
      const value = { entries }, updatedAt = new Date();
      db.insert(settings).values({ key: `project-cost:${projectId}`, value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
    }
    const cost: ProjectCost = { totalUsd: 0, totalCny: 0, calls: 0, unpricedCalls: 0 };
    for (const row of Object.values(entries)) {
      cost.calls++;
      // Definitively failed generations do not bill. Unknown submissions remain visible as unpriced.
      if (row.status !== "failed") {
        const price = row.cost;
        cost.totalUsd += price?.totalUsd ?? 0;
        cost.totalCny += price?.totalCny ?? 0;
        if (price?.totalUsd == null && price?.totalCny == null) cost.unpricedCalls++;
      }
    }
    costs.set(projectId, cost);
  }
  return costs;
}

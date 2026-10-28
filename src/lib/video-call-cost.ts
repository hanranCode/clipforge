import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiCalls } from "@/lib/db/schema";
import { buildPayload } from "@/lib/api-call-log";
import { estimateMediaCost } from "@/lib/model-pricing";
import type { TaskStatus } from "@/lib/providers/types";
import { bailianVideoUsage } from "@/lib/remake/pricing";
import { retainedVideoCostCalls, updateRetainedVideoCost } from "@/lib/project-costs";

/** A resumed poll patches the original submission, even across requests/restarts. */
export async function reconcileVideoCall(provider: string, taskId: string, status: TaskStatus) {
  if (!["completed", "failed", "cancelled"].includes(status.status)) return;
  try {
    const db = getDb();
    const live = db.select().from(apiCalls).where(and(eq(apiCalls.provider, provider), eq(apiCalls.taskId, taskId))).all();
    const rows = [...live, ...retainedVideoCostCalls(provider, taskId).filter(row => !live.some(call => call.id === row.id))];
    for (const row of rows) {
      // Studio receipts are reconciled by the durable studio catalog.
      if (row.scene === "agent_video") continue;
      const request = row.request?.detail as { duration?: number; inputVideoSeconds?: number; references?: string[]; extra?: { resolution?: string } } | undefined;
      const result = status.result && "videoUrls" in status.result ? status.result : undefined;
      const seconds = result?.duration ?? row.usage?.videoSeconds ?? request?.duration;
      const measured = bailianVideoUsage(result?.extra?.usage);
      const failed = status.status !== "completed";
      const usage = { ...row.usage, ...(seconds != null && { videoSeconds: seconds }), ...Object.fromEntries(Object.entries(measured).filter(([, value]) => value !== undefined)) };
      const cost = failed ? { currency: "USD" as const, totalUsd: 0, source: "free" as const, rateNote: "Provider task failed/cancelled" } : provider === "alibaba" ? estimateMediaCost({ provider, model: row.model, mediaType: "video", baseUrl: row.baseUrl ?? undefined, videoSeconds: measured.videoSeconds ?? seconds, billedVideoSeconds: measured.billedVideoSeconds, inputVideoSeconds: measured.inputVideoSeconds ?? request?.inputVideoSeconds ?? (request?.references?.some(r => r.startsWith("video:")) ? request.duration : 0), resolution: measured.resolution ?? request?.extra?.resolution }) : row.cost;
      const terminal = failed ? "failed" as const : "success" as const;
      if ("ledgerKey" in row) updateRetainedVideoCost(row.ledgerKey, row.id, { status: terminal, usage, cost });
      else db.update(apiCalls).set({ status: terminal, response: buildPayload(result?.videoUrls?.[0] ?? status.error, { status: status.status, videoUrls: result?.videoUrls }), usage, cost, error: status.error ?? null }).where(eq(apiCalls.id, row.id)).run();
    }
  } catch { /* Logging must not make an acknowledged cloud task fail. */ }
}

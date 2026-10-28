import { NextRequest, NextResponse } from "next/server";
import { localRequest } from "@/lib/agent-studio/http";
import { aiNodesConfigured } from "@/lib/agent-studio/ai-nodes-client";
import { getServerObjectStorage } from "@/lib/server-object-storage";
import { LITFORGE_CAPABILITIES } from "@/lib/litforge/catalog";
import { controlLitforgeTask, litforgeTaskStatus } from "@/lib/litforge/server";
import { getDb } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { studioStore } from "@/lib/agent-studio/store";
import { superResolutionTasks } from "@/lib/agent-studio/types";
import { superResolve } from "@/lib/agent-studio/super-resolution";
import { upscaleRemake } from "@/lib/remake/super-resolution";

export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    localRequest(req);
    const current = getDb().select().from(settings).all().filter(r => r.key.startsWith("litforge-task:")).map(r => {
      const v = r.value as { workflowId: string; model: string; status: string; result?: unknown; createdAt: number };
      return { taskId: v.workflowId, model: v.model, status: v.result ? "completed" : v.status, createdAt: v.createdAt, legacy: false };
    });
    const legacy = studioStore().works().flatMap(w => w.versions.flatMap(v => superResolutionTasks(v).map(t => ({ taskId: t.workflowId, model: LITFORGE_CAPABILITIES[0].model, status: t.status, createdAt: t.createdAt, legacy: true, href: `/agent-studio/${w.id}?version=${v.id}` }))));
    const remakes = getDb().select().from(settings).all().filter(r => r.key.startsWith("remake-upscale:")).flatMap(r => {
      const value = r.value as { tasks?: { workflowId: string; status: string; createdAt: number }[] };
      return (value.tasks ?? []).map(t => ({ taskId: t.workflowId, model: LITFORGE_CAPABILITIES[0].model, status: t.status, createdAt: t.createdAt, legacy: true, href: "/project/remake" }));
    });
    return NextResponse.json({ configured: aiNodesConfigured(), storageConfigured: Boolean(getServerObjectStorage()), capabilities: LITFORGE_CAPABILITIES, tasks: [...current, ...legacy, ...remakes].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "LitForge configuration unavailable" }, { status: 400 }); }
}
export async function POST(req: NextRequest) {
  try { localRequest(req, true); } catch { return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }); }
  try {
    const body = await req.json();
    if (!body || typeof body.taskId !== "string" || !["status", "cancel", "refresh"].includes(body.operation)) return NextResponse.json({ error: "Invalid task operation" }, { status: 400 });
    // Existing supers keep their durable source-specific histories and resource ownership.
    for (const work of studioStore().works()) for (const version of work.versions) {
      const task = superResolutionTasks(version).find(t => t.workflowId === body.taskId);
      if (!task) continue;
      await superResolve(work.id, version.id, body.operation, undefined, task.requestId);
      return NextResponse.json({ ok: true });
    }
    for (const row of getDb().select().from(settings).all().filter(r => r.key.startsWith("remake-upscale:"))) {
      const task = (row.value as { tasks?: { workflowId: string; requestId: string }[] }).tasks?.find(t => t.workflowId === body.taskId);
      if (!task) continue;
      await upscaleRemake(row.key.slice("remake-upscale:".length), body.operation, undefined, task.requestId);
      return NextResponse.json({ ok: true });
    }
    if (body.operation === "status") return NextResponse.json(await litforgeTaskStatus(body.taskId));
    await controlLitforgeTask(body.taskId, body.operation);
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ error: "LitForge operation unconfirmed; query the original task / 操作结果待确认，请查询原任务" }, { status: 502 }); }
}

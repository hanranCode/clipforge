import { NextRequest, NextResponse } from "next/server";
import { studioStore } from "@/lib/agent-studio/store";
import { advanceGeneration, editableContext, planningContext, prepareCrop } from "@/lib/agent-studio/engine";
import { body, fail, text } from "@/lib/agent-studio/http";
import { parseAgentPlan } from "@/lib/agent-studio/types";
import { validatePlanReferences } from "@/lib/agent-studio/reference-types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  try {
    const b = await body(req), s = studioStore();
    const r = s.authenticate(text(b.runtimeId, 100), req.headers.get("authorization")?.replace(/^Bearer /, "") || "");
    if (b.action === "heartbeat") {
      s.heartbeat(r.id, { version: text(b.version, 160) || undefined, host: text(b.host, 120) || undefined, jobId: text(b.jobId, 100) || undefined });
      const job = b.jobId ? s.readJob(text(b.jobId)) : null;
      if (job && job.runtimeId !== r.id) throw new Error("UNAUTHORIZED");
      return NextResponse.json({ runtime: r, cancelled: job ? job.status !== "running" : false });
    }
    if (b.action === "claim") return NextResponse.json({ job: s.claim(r.id), runtime: r });
    const j = s.assertJob(text(b.jobId, 100), r.id);
    if (b.action === "context" && j.kind === "editor") return NextResponse.json(editableContext(j));
    if (b.action === "editor-ready" && j.kind === "editor") {
      const url = new URL(text(b.url)); if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || !url.port) throw new Error("工程编辑地址无效");
      s.update(j.workId, w => { const v = w.versions.find(v => v.id === j.versionId); if (v) v.hypitUrl = url.href; }); s.finishJob(j.id); s.event(j.workId, "system", "Hypit 可编辑工程已启动。"); return NextResponse.json({ ok: true });
    }
    if (b.action === "context" && j.kind === "plan") return NextResponse.json(await planningContext(j));
    if (b.action === "event") { s.event(j.workId, "agent", text(b.text, 1200)); return NextResponse.json({ ok: true }); }
    if (b.action === "plan" && j.kind === "plan") {
      const work = s.work(j.workId), plan = parseAgentPlan(b.plan, work.duration);
      validatePlanReferences(plan, work.references || []);
      if (work.references?.some(item => item.role === "product")) plan.productCrop = null;
      await prepareCrop(j.workId, plan); s.assertJob(j.id, r.id); s.completePlan(j.id, plan); return NextResponse.json({ ok: true });
    }
    if (b.action === "advance" && j.kind === "generate") {
      try { return NextResponse.json(await advanceGeneration(j)); } catch(e) { s.failJob(j.id, e instanceof Error ? e.message : String(e)); throw e; }
    }
    if (b.action === "fail") { s.failJob(j.id, text(b.error, 1200)); return NextResponse.json({ ok: true }); }
    throw new Error("不支持的运行时操作");
  } catch(e) { return fail(e); }
}

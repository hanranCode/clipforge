import { NextRequest, NextResponse } from "next/server";
import { parseAgentPlan } from "@/lib/agent-studio/types";
import { studioStore } from "@/lib/agent-studio/store";
import { cropUrl, hasVideoKey, initializeVersion, prepareCrop, reconcileTask, recoverWork, rememberKey } from "@/lib/agent-studio/engine";
import { body, fail, localRequest, text } from "@/lib/agent-studio/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, context: Context) {
  try { localRequest(req); studioStore().expireJobs(); const { id } = await context.params; const work = studioStore().work(id); return NextResponse.json({ work, events: studioStore().events(id), cropUrl: cropUrl(work), videoKeyConfigured: hasVideoKey() }); } catch(e) { return fail(e); }
}
export async function POST(req: NextRequest, context: Context) {
  try {
    localRequest(req, true); const { id } = await context.params, b = await body(req), s = studioStore(), w = s.work(id);
    if (b.action === "approve") {
      if (!hasVideoKey(text(b.apiKey))) throw new Error("请先在设置 → 平台 Key 中配置火山引擎");
      if (b.productConfirmed !== true) throw new Error("请先确认参考区域没有人物面部，或确认使用纯文字方案");
      const v = s.approve(id, Number(b.budget), text(b.plan, 300_000)); rememberKey(v.id, text(b.apiKey));
      try { await initializeVersion(id, v.id); } catch(e) { const job = s.sql.prepare("SELECT id FROM jobs WHERE version_id=? AND status='queued'").get(v.id) as { id: string } | undefined; if (job) s.failJob(job.id, String(e)); throw e; }
    } else if (b.action === "edit-plan") {
      if (w.status !== "review" || !w.plan) throw new Error("方案已锁定");
      const plan = parseAgentPlan(b.plan, w.duration);
      if (JSON.stringify(plan.productCrop) !== JSON.stringify(w.plan.productCrop)) await prepareCrop(id, plan);
      s.update(id, current => { if (current.status !== "review" || JSON.stringify(current.plan) !== JSON.stringify(w.plan)) throw new Error("方案已变化，请重新读取"); current.plan = plan; }); s.event(id, "user", "已手动调整口播与镜头方案。请重新确认预算。");
    } else if (b.action === "cancel") s.cancel(id);
    else if (b.action === "recover") { const v = w.versions.at(-1); if (v) rememberKey(v.id, text(b.apiKey)); await recoverWork(id); }
    else if (b.action === "reconcile") reconcileTask(id, Number(b.index), text(b.taskId, 180));
    else if (b.action === "plan") {
      if (!["draft", "review", "completed", "cancelled", "attention"].includes(w.status)) throw new Error("请等待当前任务结束");
      if (w.status === "attention" && w.versions.at(-1)?.status === "attention") throw new Error("请先恢复当前生成版本；未知付费提交需要核对任务ID");
      const runtimeId = text(b.runtimeId) || w.runtimeId || s.runtimes().find(r => r.connected)?.id || s.runtimes().find(r => r.enabled)?.id;
      if (!runtimeId) throw new Error("请先连接一个本地 Agent 运行时");
      s.sql.transaction(() => { s.update(id, w => { w.brief = text(b.brief) || w.brief; w.plan = null; w.runtimeId = runtimeId; }); s.event(id, "user", text(b.brief) || w.brief); s.enqueue(id, "plan"); })();
    } else if (b.action === "editor") {
      const v = w.versions.find(v => v.id === text(b.versionId)); if (v?.status !== "completed") throw new Error("请选择已完成的版本");
      const runtimeId = text(b.runtimeId) || w.runtimeId || s.runtimes().find(r => r.connected)?.id;
      if (!runtimeId || !s.runtimes().some(r => r.id === runtimeId && r.enabled)) throw new Error("请选择可用的本地运行时");
      s.sql.transaction(() => { s.update(id, w => { w.runtimeId = runtimeId; }); s.enqueue(id, "editor", v.id); })();
    } else if (b.action === "rename") { if (!text(b.title, 120)) throw new Error("名称不能为空"); s.update(id, w => { w.title = text(b.title, 120); }); }
    else throw new Error("不支持的操作");
    return NextResponse.json({ work: s.work(id) });
  } catch(e) { return fail(e); }
}

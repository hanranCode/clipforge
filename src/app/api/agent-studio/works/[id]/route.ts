import { NextRequest, NextResponse } from "next/server";
import { parseAgentPlan } from "@/lib/agent-studio/types";
import { studioStore } from "@/lib/agent-studio/store";
import { cropUrl, hasVideoKey, initializeVersion, prepareCrop, reconcileTask, recoverWork, rememberKey } from "@/lib/agent-studio/engine";
import { body, fail, localRequest, text } from "@/lib/agent-studio/http";
import { syncAgentWork } from "@/lib/agent-studio/catalog";
import { getServerObjectStorage } from "@/lib/server-object-storage";
import { upscaleCapability } from "@/lib/agent-studio/upscale-options";
import { aiNodesConfigured, superResolve } from "@/lib/agent-studio/super-resolution";
import { captureReferences } from "@/lib/agent-studio/reference-assets";
import { validatePlanReferences } from "@/lib/agent-studio/reference-types";
import { parseStudioVideo, studioResolutions, studioSnapshot } from "@/lib/agent-studio/video-models";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, context: Context) {
  try { localRequest(req); studioStore().expireJobs(); const { id } = await context.params; await syncAgentWork(studioStore().work(id)); const work = studioStore().work(id); const video = studioSnapshot(work, work.status === "attention" ? work.versions.at(-1) : undefined); return NextResponse.json({ work, events: studioStore().events(id), cropUrl: cropUrl(work), videoKeyConfigured: hasVideoKey(undefined, video.provider), videoKeyProvider: video.provider, aiNodesConfigured: aiNodesConfigured(), upscaleCapability: upscaleCapability(), objectStorageConfigured: Boolean(getServerObjectStorage()) }); } catch(e) { return fail(e); }
}
export async function POST(req: NextRequest, context: Context) {
  try {
    localRequest(req, true); const { id } = await context.params, b = await body(req), s = studioStore(), w = s.work(id);
    if (b.action === "upscale") {
      if (Object.keys(b).some(k => !["action", "operation", "versionId", "requestId", "parameters"].includes(k))) throw new Error("超分请求不接受存储凭据，请配置本地服务并刷新页面 / Upscale requests do not accept storage credentials");
      const operation = text(b.operation);
      if (!["start", "restart", "status", "refresh", "cancel"].includes(operation)) throw new Error("不支持的超分操作 / Unsupported upscale operation");
      await superResolve(id, text(b.versionId), operation as "start" | "restart" | "status" | "refresh" | "cancel", b.parameters, text(b.requestId) || undefined);
    } else if (b.action === "video-settings") {
      const video = parseStudioVideo(b.video);
      const resolution = text(b.resolution);
      if (!studioResolutions(video).some(value => value === resolution)) throw new Error("此模型不支持所选清晰度");
      s.update(id, current => {
        if (!["draft", "review", "completed", "cancelled", "attention"].includes(current.status)
          || current.status === "attention" && current.versions.at(-1)?.status === "attention"
          || s.sql.prepare("SELECT id FROM jobs WHERE work_id=? AND status IN ('queued','running')").get(id)) throw new Error("请等待当前任务结束；恢复已有版本时不能切换供应商 / Cannot switch provider during an active or recoverable version");
        // Freeze pre-feature historical versions before modifying the work's next-version defaults.
        current.versions.forEach(version => { version.video ??= studioSnapshot(current, version); });
        current.video = video; current.resolution = resolution as typeof current.resolution;
      });
      s.event(id, "user", `后续生成配置已更新：${video.provider} · ${video.model} · ${resolution}。已有版本保持原配置。`);
    } else if (b.action === "approve") {
      const video = b.video !== undefined ? parseStudioVideo(b.video) : w.video;
      if (b.resolution !== undefined && b.resolution !== w.resolution) throw new Error("清晰度已变化，请保存并重新确认 / Resolution changed; save and review again");
      if (video?.provider === "alibaba" && !video.baseUrl) throw new Error("请先在设置中填写百炼业务空间 Endpoint");
      if (!hasVideoKey(text(b.apiKey), video?.provider ?? studioSnapshot(w).provider)) throw new Error("请先在设置 → 平台 Key 中配置所选视频供应商");
      if (b.productConfirmed !== true) throw new Error("请先确认参考区域没有人物面部，或确认使用纯文字方案");
      if (w.references?.length && b.referencesConfirmed !== true) throw new Error("请确认分段素材分配与人像参考策略 / Confirm references before generating");
      // Re-read and verify every captured image before creating a paid version.
      if (w.references?.length) await captureReferences(id, w.references, w.references);
      if (video && w.video && JSON.stringify(video) !== JSON.stringify(w.video)) throw new Error("视频配置已变化，请保存并重新确认 / Video configuration changed; save and review again");
      if (video && !w.video) s.update(id, current => {
        if (current.video || current.status !== "review") throw new Error("视频配置已变化，请刷新后重新确认");
        if (!studioResolutions(video).includes(current.resolution)) throw new Error("此模型不支持所选清晰度");
        current.versions.forEach(version => { version.video ??= studioSnapshot(current, version); });
        current.video = video;
      });
      const expectedVideo = { ...(video ?? studioSnapshot(w)), resolution: w.resolution };
      const v = s.approve(id, Number(b.budget), text(b.plan, 300_000), JSON.stringify(w.references || []), JSON.stringify(expectedVideo)); rememberKey(v.id, text(b.apiKey), b.objectStorage);
      try { await initializeVersion(id, v.id); } catch(e) { const job = s.sql.prepare("SELECT id FROM jobs WHERE version_id=? AND status='queued'").get(v.id) as { id: string } | undefined; if (job) s.failJob(job.id, String(e)); throw e; }
    } else if (b.action === "edit-plan") {
      if (w.status !== "review" || !w.plan) throw new Error("方案已锁定");
      const plan = parseAgentPlan(b.plan, w.duration);
      validatePlanReferences(plan, w.references || []);
      if (w.references?.some(item => item.role === "product")) plan.productCrop = null;
      if (JSON.stringify(plan.productCrop) !== JSON.stringify(w.plan.productCrop)) await prepareCrop(id, plan);
      s.update(id, current => { if (current.status !== "review" || JSON.stringify(current.plan) !== JSON.stringify(w.plan) || JSON.stringify(current.references) !== JSON.stringify(w.references)) throw new Error("方案已变化，请重新读取"); current.plan = plan; }); s.event(id, "user", "已手动调整口播、镜头或分段素材分配。请重新确认预算。");
    } else if (b.action === "cancel") s.cancel(id);
    else if (b.action === "recover") { const v = w.versions.at(-1); if (v) rememberKey(v.id, text(b.apiKey), b.objectStorage); await recoverWork(id); }
    else if (b.action === "reconcile") reconcileTask(id, Number(b.index), text(b.taskId, 180));
    else if (b.action === "plan") {
      if (!["draft", "review", "completed", "cancelled", "attention"].includes(w.status)) throw new Error("请等待当前任务结束");
      if (w.status === "attention" && w.versions.at(-1)?.status === "attention") throw new Error("请先恢复当前生成版本；未知付费提交需要核对任务ID");
      const runtimeId = text(b.runtimeId) || w.runtimeId || s.runtimes().find(r => r.connected)?.id || s.runtimes().find(r => r.enabled)?.id;
      if (!runtimeId) throw new Error("请先连接一个本地 Agent 运行时");
      const references = b.references === undefined ? w.references : await captureReferences(id, b.references, w.references);
      s.sql.transaction(() => {
        s.update(id, current => {
          if (current.updatedAt !== w.updatedAt || current.status !== w.status) throw new Error("作品已变化，请刷新后重新规划 / Work changed; refresh before replanning");
          current.brief = text(b.brief) || current.brief; current.plan = null; current.runtimeId = runtimeId; current.references = references;
        });
        s.event(id, "user", text(b.brief) || w.brief); s.enqueue(id, "plan");
      })();
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

"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LuArrowUpRight, LuChevronDown, LuDownload, LuLoaderCircle, LuSparkles } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { studioApi } from "./shared";
import { superResolutionTasks, type WorkVersion } from "@/lib/agent-studio/types";
import type { upscaleCapability } from "@/lib/agent-studio/upscale-options";

type Capability = ReturnType<typeof upscaleCapability>;
export function SuperResolutionPanel({ workId, version, configured, storageConfigured = false, capability, onChange, onPreview, endpoint, versionLabel }: { workId?: string; version: Pick<WorkVersion, "id" | "number" | "superResolution" | "superResolutions">; configured: boolean; storageConfigured?: boolean; capability?: Capability; onChange: () => Promise<void>; onPreview?: (url: string | null) => void; endpoint?: string; versionLabel?: string }) {
  const t = useT("agentStudio");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [open, setOpen] = useState(false);
  const [seed, setSeed] = useState(""), [preset, setPreset] = useState("base");
  const tasks = superResolutionTasks(version), sr = tasks.find(t => ["submitting", "processing", "waiting_for_output_url", "unknown"].includes(t.status));
  const storageReady = storageConfigured, taskId = sr?.requestId;
  const seedValid = seed === "" || Number.isInteger(Number(seed)) && Number(seed) >= 0 && Number(seed) <= 2147483647;
  const action = useCallback(async (operation: string) => {
    setBusy(true); setError("");
    try {
      const payload = { operation, ...(taskId && { requestId: taskId }), ...(["start", "restart"].includes(operation) && { parameters: { capabilityId: "media.super_resolution.v1", target: "1080p", videoPreset: preset, ...(seed !== "" && { seed: Number(seed) }) } }) };
      if (endpoint) {
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!response.ok) throw new Error((await response.json()).error || "Upscale request failed");
      } else await studioApi(`works/${workId}`, { action: "upscale", versionId: version.id, ...payload });
      if (["start", "restart"].includes(operation)) setOpen(false);
      await onChange();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [workId, version.id, onChange, taskId, seed, preset, endpoint]);
  useEffect(() => {
    if (!sr || busy || sr.status === "waiting_for_output_url" || error) return;
    const timer = setTimeout(() => void action("status"), 10_000);
    return () => clearTimeout(timer);
  }, [taskId, busy, sr?.status, error, action]); // eslint-disable-line react-hooks/exhaustive-deps -- poll identity/status, not refreshed task object
  return <section aria-label={t("upscale")} className="border-t border-slate-100 bg-slate-50/60 px-5 py-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5"><span className="grid size-8 place-items-center rounded-lg bg-indigo-50 text-indigo-600"><LuSparkles className="size-4" /></span><div><h2 className="text-xs font-semibold text-slate-800">{t("upscale")}</h2><p className="mt-1 text-[11px] text-slate-500">{versionLabel ?? `V${version.number}`} {t("upscaleLineage", { n: tasks.length })}</p></div></div>
      {!sr && <Button size="sm" variant="outline" disabled={busy || !configured || !storageReady} onClick={() => setOpen(!open)}><LuSparkles className="size-3.5" />{t(tasks.length ? "upscaleAgain" : "upscaleStart")}<LuChevronDown className={`size-3 transition ${open ? "rotate-180" : ""}`} /></Button>}
      {sr && <div className="flex flex-wrap items-center gap-2"><span role="status" className="flex items-center gap-1.5 text-xs text-indigo-600"><LuLoaderCircle className="size-3 animate-spin" />{t(`upscale_${sr.status}`)}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void action("status")}>{t("upscaleQuery")}</Button>{sr.status === "waiting_for_output_url" && <Button size="sm" disabled={busy || !storageReady} onClick={() => void action("refresh")}>{t("upscaleRefresh")}</Button>}<Button size="sm" variant="ghost" disabled={busy} onClick={() => void action("cancel")}>{t("cancel")}</Button></div>}
    </div>
    {open && !sr && <form className="mt-4 rounded-xl border border-slate-200 bg-white p-4" onSubmit={e => { e.preventDefault(); if (seedValid) void action(tasks.length ? "restart" : "start"); }}>
      <p className="mb-4 text-xs leading-5 text-slate-500">{t("upscaleHint")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-slate-600">{t("upscaleCapability")}<select aria-label={t("upscaleCapability")} className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs" defaultValue="media.super_resolution.v1"><option value="media.super_resolution.v1">{t("upscaleCapability1080")}</option></select></label>
        <label className="text-xs text-slate-600">{t("upscalePreset")}<select aria-label={t("upscalePreset")} className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs" value={preset} onChange={e => setPreset(e.target.value)}>{(capability?.presets || [{ id: "base", available: true }, { id: "turbo", available: false }]).map(p => <option key={p.id} value={p.id} disabled={!p.available}>{t(p.id === "base" ? "upscaleBase" : "upscaleTurbo")}{!p.available ? ` · ${t("upscaleUnavailable")}` : ""}</option>)}</select></label>
        <label className="text-xs text-slate-600">{t("upscaleSeed")}<input aria-label={t("upscaleSeed")} type="number" min="0" max="2147483647" step="1" placeholder="1" value={seed} onChange={e => setSeed(e.target.value)} className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 px-2 text-xs" /></label>
      </div>
      <p className="mt-3 text-[11px] leading-5 text-slate-400">{t("upscaleSeedHint")}</p>
      <div className="mt-4 flex justify-end gap-2"><Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>{t("cancel")}</Button><Button size="sm" type="submit" disabled={busy || !seedValid || !configured || !storageReady}>{busy && <LuLoaderCircle className="animate-spin" />}{t("upscaleSubmit")}</Button></div>
    </form>}
    {tasks.length > 0 && <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200/70 bg-white px-3 py-2 text-xs"><div><span className="font-medium text-slate-700">{versionLabel ?? `V${version.number}`} · {t("upscaleSource")}</span><span className="ml-2 text-slate-400">{t("upscaleSourceKept")}</span></div><button className="text-indigo-600" onClick={() => onPreview?.(null)}>{t("upscaleView")}</button></div>
      {[...tasks].reverse().map((task, index) => <div key={task.requestId} className="rounded-lg border border-slate-200/70 bg-white px-3 py-2.5"><div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-medium text-slate-700">↳ SR{tasks.length - index} · 1080P <span className="ml-2 font-normal text-slate-400">{t(`upscale_${task.status}`)}</span></span><div className="flex items-center gap-3">{task.outputUrl && <><button onClick={() => onPreview?.(task.outputUrl!)} className="flex items-center gap-1 text-indigo-600">{t("upscalePreview")}<LuArrowUpRight /></button><a className="flex items-center gap-1 text-slate-500" href={`${task.outputUrl}?download=1`} download><LuDownload />{t("download")}</a></>}<details className="relative"><summary className="cursor-pointer text-slate-400">{t("upscaleParameters")}</summary><p className="absolute right-0 z-10 mt-2 min-w-52 rounded-lg border bg-white p-3 text-[11px] leading-6 shadow-lg">1080P · {task.parameters?.videoPreset || "base"} · Seed {task.parameters?.seed ?? 1}<br />{task.createdAt ? new Date(task.createdAt).toLocaleString() : ""}</p></details></div></div>{task.error && !sr && <p className="mt-2 text-xs text-red-700">{task.error}</p>}</div>)}
    </div>}
    {!configured && <p className="mt-3 text-xs text-amber-700">{t("upscaleSetup")}</p>}
    {!storageReady && <Link href="/settings?tab=storage" className="mt-3 inline-block text-xs text-indigo-600 underline">{t("upscaleStorage")}</Link>}
    {(error || sr?.error) && <p role="alert" className="mt-3 text-xs text-red-700">{error || sr?.error}</p>}
  </section>;
}

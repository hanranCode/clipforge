"use client";
import { bailianVideoRate } from "@/lib/remake/pricing";
import Link from "next/link";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useT } from "@/lib/i18n";
import { modelForUsage, providerForUsage, usageChoice, type UsageModelSource } from "@/lib/model-usage";
import { providerLabel } from "@/lib/provider-labels";
import { LEGACY_VIDEO, STUDIO_VIDEO_MODELS, studioResolutions, studioVideoModel, type StudioResolution, type StudioVideoChoice } from "@/lib/agent-studio/video-models";
import { fieldClass } from "./shared";

export function defaultStudioVideo(settings: UsageModelSource & { providers: Record<string, { enabled?: boolean; apiKey?: string; baseUrl?: string }> }): StudioVideoChoice {
  const provider = providerForUsage(settings, "videoRemake"), model = modelForUsage(settings, "videoRemake");
  const selected = { provider, model };
  const choice = studioVideoModel(selected) && (usageChoice(settings, "videoRemake") || settings.providers[provider]?.enabled) ? selected : LEGACY_VIDEO;
  const baseUrl = settings.providers[choice.provider]?.baseUrl?.trim().replace(/\/+$/, "");
  return { ...choice, ...(baseUrl && { baseUrl }) };
}
export function StudioVideoSettings({ value, resolution, onChange, disabled = false }: {
  value: StudioVideoChoice; resolution: StudioResolution; disabled?: boolean;
  onChange: (value: StudioVideoChoice, resolution: StudioResolution) => void;
}) {
  const t = useT("agentStudio"), settingsT = useT("settings"), settings = useSettingsStore();
  const configured = settings.providers[value.provider];
  const changeProvider = (provider: string) => {
    const model = STUDIO_VIDEO_MODELS.find(m => m.provider === provider)!.model;
    const baseUrl = settings.providers[provider]?.baseUrl?.trim().replace(/\/+$/, "");
    const next = { provider, model, ...(baseUrl && { baseUrl }) };
    onChange(next, studioResolutions(next).includes(resolution) ? resolution : "720p");
  };
  return <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-medium">{t("videoGeneration")}</h3><button type="button" className="text-xs text-indigo-600 disabled:opacity-50" disabled={disabled} onClick={() => { const next = defaultStudioVideo(settings); onChange(next, studioResolutions(next).includes(resolution) ? resolution : "720p"); }}>{t("useVideoDefault")}</button></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs">{t("videoProvider")}<select aria-label={t("videoProvider")} disabled={disabled} className={`${fieldClass} mt-2 text-xs`} value={value.provider} onChange={e => changeProvider(e.target.value)}>{["volcengine", "alibaba", "atlas-cloud"].map(p => <option key={p} value={p}>{providerLabel(p, settingsT)}</option>)}</select></label>
      <label className="text-xs">{t("videoModel")}<select aria-label={t("videoModel")} disabled={disabled} className={`${fieldClass} mt-2 text-xs`} value={value.model} onChange={e => { const next = { ...value, model: e.target.value }; onChange(next, studioResolutions(next).includes(resolution) ? resolution : "720p"); }}>{STUDIO_VIDEO_MODELS.filter(m => m.provider === value.provider).map(m => <option key={m.model} value={m.model}>{m.name}{value.provider === "alibaba" ? ` · ¥${bailianVideoRate(m.model, resolution, value.baseUrl)}/s` : ""}</option>)}</select></label>
    </div>
    <label className="block text-xs">{t("quality")}<select aria-label={t("quality")} disabled={disabled} className={`${fieldClass} mt-2 text-xs`} value={resolution} onChange={e => onChange(value, e.target.value as StudioResolution)}>{studioResolutions(value).map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}</select></label>
    {value.provider === "alibaba" && <p className="text-xs text-slate-500">{t("bailianPriceHint", { price: bailianVideoRate(value.model, resolution, value.baseUrl) ?? "—", resolution: resolution.toUpperCase() })}</p>}
    <p className="text-[11px] leading-5 text-slate-500">{t("videoSettingsHint")}</p>
    {(!configured?.enabled || !configured.apiKey || value.provider === "alibaba" && !value.baseUrl) && <p className="text-xs leading-5 text-amber-700">{t("videoNeedsConfig")} <Link href="/settings?tab=providers" className="underline">{t("settings")}</Link></p>}
  </div>;
}

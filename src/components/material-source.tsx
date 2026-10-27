"use client";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { MATERIAL_SOURCES, type MaterialSource } from "@/lib/material-source";

const colors: Partial<Record<MaterialSource, string>> = {
  ai_generated: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
  user_upload: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  agent_remake: "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  video_remake: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300",
};
export function SourceBadge({ source }: { source: MaterialSource }) {
  const t = useT("assetLibrary");
  return <Badge variant="outline" className={`max-w-full text-[10px] ${colors[source] || "bg-muted text-muted-foreground"}`}>{t(`source_${source}`)}</Badge>;
}
export function SourceBadges({ sources }: { sources: readonly MaterialSource[] }) {
  return <span className="flex flex-wrap gap-1">{[...new Set(sources)].map(source => <SourceBadge key={source} source={source} />)}</span>;
}
export function SourceFilter({ value, onChange, sources = MATERIAL_SOURCES, disabled = false }: { value: string; onChange: (source: string) => void; sources?: readonly MaterialSource[]; disabled?: boolean }) {
  const t = useT("assetLibrary");
  return <div role="group" aria-label={t("filterSourceType")} className="flex flex-wrap gap-1.5">
    {["", ...new Set(sources)].map(source => <button key={source} type="button" aria-pressed={value === source} disabled={disabled} onClick={() => onChange(source)} className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50 ${value === source ? "border-primary bg-primary/10 font-medium text-primary" : "border-border/60 bg-background text-muted-foreground hover:border-primary/50"}`}>{source ? t(`source_${source}`) : t("allSources")}</button>)}
  </div>;
}

export function SourceEmptyState() { const t = useT("assetLibrary"); return <p role="status" className="py-5 text-sm text-muted-foreground">{t("noSourceMatch")}</p>; }

"use client";
/* eslint-disable @next/next/no-img-element -- previews use local library and immutable snapshot URLs */
import { useState } from "react";
import { LuPlus, LuX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { LibraryEntityPicker } from "@/components/library-entity-picker";
import { SourceBadge } from "@/components/material-source";
import { imageSource } from "@/lib/material-source";
import { LibraryVideoPicker } from "@/components/library-video-picker";
import { useT } from "@/lib/i18n";
import { REFERENCE_ROLES, type ReferenceInput, type ReferenceRole, type SegmentReferences } from "@/lib/agent-studio/reference-types";
import { fieldClass } from "./shared";

export function ReferenceSummary({ items }: { items: readonly ReferenceInput[] }) {
  const t = useT("agentStudio");
  return <div className="space-y-2">{items.map(item => <div key={item.id} className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50/50 p-3">
    <img src={item.imageUrl} alt={item.name} className="size-14 shrink-0 rounded-lg bg-white object-contain" />
    <div className="min-w-0"><p className="text-[10px] text-slate-400">{t(`reference_${item.role}`)}</p><p className="truncate text-xs font-medium text-slate-700">{item.name}</p><SourceBadge source={imageSource(item.imageUrl, item)} /><p className="mt-1 line-clamp-2 break-words text-[11px] leading-5 text-slate-500">{[item.description, item.facts?.price, item.facts?.appearance].filter(Boolean).join(" · ")}</p></div>
  </div>)}</div>;
}

/** Selection stays local until Create/Replan captures it on the server. First item per role is the default. */
export function ReferenceLibraryEditor({ value, onChange, disabled = false }: { value: ReferenceInput[]; onChange: (items: ReferenceInput[]) => void; disabled?: boolean }) {
  const t = useT("agentStudio");
  const [picker, setPicker] = useState<ReferenceRole | null>(null);
  const add = (item: Omit<ReferenceInput, "id">) => {
    if (value.length >= 12 || disabled) return;
    onChange([...value, { ...item, id: crypto.randomUUID() }]); setPicker(null);
  };
  return <div className="space-y-3" aria-label={t("references")}>
    <div><h3 className="text-xs font-semibold text-slate-700">{t("references")}</h3><p className="mt-1 text-[11px] leading-5 text-slate-500">{t("referencesHint")}</p></div>
    {REFERENCE_ROLES.map(role => <div key={role} className="rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{t(`reference_${role}`)}</span><Button type="button" variant="outline" size="sm" disabled={disabled || value.length >= 12} onClick={() => { setPicker(role); }} aria-label={t(`select_${role}`)}><LuPlus className="size-3" />{t(`select_${role}`)}</Button></div>
      {!value.some(item => item.role === role) && <p className="mt-2 text-[11px] text-slate-400">{t(`referenceEmpty_${role}`)}</p>}
      {value.filter(item => item.role === role).map((item, i) => <div key={item.id} className="mt-3 flex items-center gap-2">
        <img src={item.imageUrl} alt={item.name} className="size-11 rounded-md bg-slate-50 object-contain" /><div className="min-w-0 flex-1"><p className="truncate text-xs">{item.name}</p><SourceBadge source={imageSource(item.imageUrl, item)} />{i === 0 && <span className="text-[10px] text-indigo-500">{t("referenceDefault")}</span>}</div>
        <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={`${t("removeReference")} ${item.name}`} onClick={() => onChange(value.filter(entry => entry.id !== item.id))}><LuX /></Button>
      </div>)}
    </div>)}
    {value.some(item => item.role === "presenter") && <p className="rounded-lg bg-amber-50 p-3 text-[11px] leading-5 text-amber-800">{t("presenterReferenceHint")}</p>}
    <LibraryVideoPicker mediaType="image" open={picker === "scene"} onOpenChange={open => { if (!open) setPicker(null); }} onPick={item => add({ role: "scene", sourceId: item.id, name: item.label.slice(0, 120), description: "", imageUrl: item.url, source: item.source })} />
    <LibraryEntityPicker key={picker === "product" ? "product" : "presenter"} role={picker === "product" ? "product" : "presenter"} open={picker === "product" || picker === "presenter"} onOpenChange={open => { if (!open) setPicker(null); }} disabled={disabled} onPick={item => add({ ...item, role: picker === "product" ? "product" : "presenter" })} />
  </div>;
}

export function SegmentReferenceEditor({ items, value = {}, onChange, disabled = false, segmentLabel }: { items: readonly ReferenceInput[]; value?: SegmentReferences; onChange?: (value: SegmentReferences) => void; disabled?: boolean; segmentLabel: string }) {
  const t = useT("agentStudio");
  const sourceT = useT("assetLibrary");
  const itemLabel = (item: ReferenceInput) => `${item.name} · ${sourceT(`source_${imageSource(item.imageUrl, item)}`)}`;
  return <div className="mt-3 space-y-2 border-t border-slate-100 pt-3"><p className="text-[10px] font-medium text-slate-400">{t("segmentReferences")}</p><div className="grid gap-2 sm:grid-cols-3">{REFERENCE_ROLES.map(role => {
    const options = items.filter(item => item.role === role), inherited = options[0] ? itemLabel(options[0]) : t(`referenceEmpty_${role}`);
    return <label key={role} className="block text-[10px] text-slate-500">{t(`reference_${role}`)}<select aria-label={`${segmentLabel} ${t(`reference_${role}`)}`} disabled={disabled || !onChange} className={`${fieldClass} mt-1 text-xs`} value={value[role] === null ? "none" : value[role] ?? "inherit"} onChange={e => {
      const next = { ...value };
      if (e.target.value === "inherit") delete next[role]; else next[role] = e.target.value === "none" ? null : e.target.value;
      onChange?.(next);
    }}><option value="inherit">{t("referenceInherit")} · {inherited}</option><option value="none">{t("referenceNone")}</option>{options.map(item => <option key={item.id} value={item.id}>{itemLabel(item)}</option>)}</select></label>;
  })}</div>{!disabled && <p className="text-[10px] leading-5 text-slate-400">{t("referenceAllocationHint")}</p>}</div>;
}

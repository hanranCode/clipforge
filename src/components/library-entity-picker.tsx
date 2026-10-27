"use client";
/* eslint-disable @next/next/no-img-element -- local library image previews */
import { useState } from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SourceBadge, SourceFilter } from "@/components/material-source";
import { imageSource, imageSources, type MaterialSource } from "@/lib/material-source";
import { useProductLibraryStore } from "@/lib/stores/product-library-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { useT } from "@/lib/i18n";

export interface PickedLibraryEntity {
  sourceId: string; name: string; description: string; imageUrl: string; source: MaterialSource;
  facts: { category?: string; price?: string; targetAudience?: string; appearance?: string };
}
/** Shared by Agent planning and both legacy remake reference selectors. */
export function LibraryEntityPicker({ role, open, onOpenChange, onPick, disabled = false }: { role: "product" | "presenter"; open: boolean; onOpenChange: (open: boolean) => void; onPick: (item: PickedLibraryEntity) => void; disabled?: boolean }) {
  const t = useT("agentStudio"), tp = useT("products"), ta = useT("assetLibrary");
  const products = useProductLibraryStore(s => s.products), presenters = useCharacterStore(s => s.characters);
  const [search, setSearch] = useState(""), [source, setSource] = useState(""), [category, setCategory] = useState("");
  const entries = role === "product" ? products.map(p => ({ ...p, sourceId: p.id, description: p.description || "", images: p.images, facts: { category: p.category, price: p.price, targetAudience: p.targetAudience } })) : presenters.map(p => ({ ...p, sourceId: p.id, description: p.description || "", images: [...new Set([...(p.sourcePhotos || []), ...p.referenceImages])], facts: { appearance: p.appearance } }));
  const options = entries.map(item => ({ ...item, images: item.images.filter(url => !source || imageSource(url, item) === source) })).filter(item =>
    `${item.name} ${item.description}`.toLowerCase().includes(search.trim().toLowerCase()) && (!category || ("category" in item && item.category === category)) && (!source || item.images.length));
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl"><DialogTitle>{t(`select_${role}`)}</DialogTitle>
    <Input aria-label={t("referenceSearch")} placeholder={t("referenceSearch")} value={search} onChange={e => setSearch(e.target.value)} />
    <SourceFilter value={source} onChange={setSource} disabled={disabled} sources={[...new Set(entries.flatMap(item => imageSources(item.images, item)))]} />
    {role === "product" && <div className="flex flex-wrap gap-1.5" role="group" aria-label={ta("filterCategory")}>{["", "beauty", "food", "home", "fashion", "tech", "other"].map(value => <button key={value} type="button" aria-pressed={category === value} className={`rounded-full border px-2.5 py-1 text-[11px] ${category === value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`} onClick={() => setCategory(value)}>{value ? tp(`category${value[0].toUpperCase()}${value.slice(1)}`) : ta("allCategories")}</button>)}</div>}
    <div className="min-h-0 space-y-4 overflow-y-auto">
      {!options.length && <p className="py-6 text-sm text-muted-foreground">{t("referenceLibraryEmpty")} <Link className="underline" href={role === "product" ? "/products" : "/presenters"}>{t("referenceManage")}</Link></p>}
      {options.map(item => <div key={item.sourceId} className="rounded-xl border p-3"><p className="text-sm font-medium">{item.name}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</p>
        <div className="mt-3 flex flex-wrap gap-2">{item.images.map((imageUrl, i) => <button key={imageUrl} type="button" disabled={disabled} aria-label={`${item.name} · ${t("referenceImage", { n: i + 1 })}`} className="w-28 overflow-hidden rounded-lg border bg-muted/20 text-left hover:border-primary" onClick={() => { onPick({ sourceId: item.sourceId, name: item.name, description: item.description, facts: item.facts, imageUrl, source: imageSource(imageUrl, item) }); onOpenChange(false); }}><img src={imageUrl} alt={t("referenceImage", { n: i + 1 })} className="aspect-square w-full object-contain" /><span className="block p-1.5"><SourceBadge source={imageSource(imageUrl, item)} /></span></button>)}{!item.images.length && <p className="text-xs text-muted-foreground">{t("referenceNoImage")}</p>}</div>
      </div>)}
    </div>
  </DialogContent></Dialog>;
}

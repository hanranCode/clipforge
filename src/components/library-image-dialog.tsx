"use client";
/* eslint-disable @next/next/no-img-element -- generated previews are local files served by /api/files */

import { useRef, useState } from "react";
import Link from "next/link";
import { LuLoaderCircle, LuSparkles, LuX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SourceBadge, SourceFilter } from "@/components/material-source";
import { imageSource, type MaterialSource } from "@/lib/material-source";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ModelChoiceSelect, ModelSummary } from "@/components/settings/media-model-settings";
import { ModelCatalogStatus } from "@/components/model-catalog-status";
import { useModelCatalog } from "@/lib/hooks/use-model-catalog";
import { mergeCustomModels } from "@/lib/gen-params";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useT } from "@/lib/i18n";
import { listPriceFor } from "@/lib/model-pricing";
import { providerLabel } from "@/lib/provider-labels";
import type { UsageModelChoice } from "@/lib/model-usage";

export interface GeneratedLibraryImage { id: string; url: string; title: string; prompt: string; provider: string; model: string }

type Destination = "material" | "presenter" | "product";
interface ReferenceImage { url: string; file?: File; source?: MaterialSource }
interface ImageFormProps {
  destination: Destination;
  onGenerated: (image: GeneratedLibraryImage) => void;
  initialTitle?: string;
  initialPrompt?: string;
  referenceImages?: ReferenceImage[];
}

function readImage(file: Blob): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024) {
    return Promise.reject(new Error("JPG / PNG / WebP · ≤ 20MB"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Cannot read image"));
    reader.readAsDataURL(file);
  });
}

export function LibraryImageDialog({ open, onOpenChange, ...props }: ImageFormProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl"><DialogTitle><LuSparkles className="mr-2 inline size-4" /><Title destination={props.destination} /></DialogTitle>{open && <ImageForm setParentBusy={setBusy} {...props} close={() => onOpenChange(false)} />}</DialogContent></Dialog>;
}
function Title({ destination }: { destination: Destination }) { const t = useT("libraryGeneration"); return t(`${destination}Title`); }

function ImageForm({ destination, onGenerated, close, setParentBusy, initialTitle = "", initialPrompt = "", referenceImages = [] }: ImageFormProps & { setParentBusy: (busy: boolean) => void; close: () => void }) {
  const t = useT("libraryGeneration"), ts = useT("settings");
  const settings = useSettingsStore();
  const configured = Object.entries(settings.providers).filter(([, p]) => p.enabled && p.apiKey.trim()).map(([name, p]) => ({ name, apiKey: p.apiKey, baseUrl: p.baseUrl }));
  const catalog = useModelCatalog(configured);
  const [mode, setMode] = useState<"text-to-image" | "image-to-image">("text-to-image");
  const [reference, setReference] = useState<ReferenceImage | null>(null);
  const [referenceSource, setReferenceSource] = useState("");
  const [reading, setReading] = useState(false);
  const models = mergeCustomModels(catalog.models.filter(m => m.mediaType === "image"), settings.customModels, "image", new Set(configured.map(p => p.name))).filter(m => m.modes?.includes(mode));
  const [choice, setChoice] = useState<UsageModelChoice | null>(null);
  const defaultModel = models.find(m => m.id === settings.defaultImageModel && (!settings.defaultImageProvider || m.provider === settings.defaultImageProvider));
  const selected = choice ? models.find(m => m.id === choice.model && m.provider === choice.provider) : defaultModel ?? models.find(m => /seedream/i.test(m.id)) ?? models[0];
  const [title, setTitle] = useState(initialTitle), [prompt, setPrompt] = useState(initialPrompt), [aspect, setAspect] = useState(destination === "presenter" ? "9:16" : "1:1");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState<GeneratedLibraryImage | null>(null);
  const inFlight = useRef(false);
  async function generate() {
    if (!selected || inFlight.current || reading || !title.trim() || !prompt.trim() || (mode === "image-to-image" && !reference)) return;
    const config = settings.providers[selected.provider];
    if (!config?.enabled || !config.apiKey.trim()) return;
    inFlight.current = true; setBusy(true); setParentBusy(true); setError("");
    try {
      let referenceImageUrl: string | undefined;
      if (mode === "image-to-image" && reference) {
        if (reference.file) referenceImageUrl = await readImage(reference.file);
        else if (/^(https?:|data:|\/api\/files\/)/.test(reference.url)) referenceImageUrl = reference.url;
        else {
          const response = await fetch(reference.url);
          if (!response.ok) throw new Error(t("referenceFailed"));
          referenceImageUrl = await readImage(await response.blob());
        }
      }
      const res = await fetch("/api/materials/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destination, mode, ...(referenceImageUrl && { referenceImageUrl }), title: title.trim(), prompt: prompt.trim(), aspectRatio: aspect, provider: selected.provider, model: selected.id, apiKey: config.apiKey, baseUrl: config.baseUrl }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("failed"));
      setResult(data); onGenerated(data);
    } catch (e) { setError(e instanceof Error ? e.message : t("failed")); }
    finally { inFlight.current = false; setBusy(false); setParentBusy(false); }
  }
  return <div className="space-y-4">
    {result ? <><img src={result.url} alt={result.title} className="mx-auto max-h-[50vh] rounded-xl object-contain" /><p role="status" className="text-sm text-emerald-600">{t(`${destination}Saved`)}</p><Button className="w-full" onClick={close}>{t("done")}</Button></> : <>
      <p className="text-xs leading-5 text-muted-foreground">{t("hint")}</p>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("mode")}>
        {(["text-to-image", "image-to-image"] as const).map(value => <Button key={value} variant={mode === value ? "default" : "outline"} aria-pressed={mode === value} disabled={busy || reading} onClick={() => { setMode(value); setChoice(selected?.modes?.includes(value) ? { provider: selected.provider, model: selected.id } : null); setError(""); }}>{t(value === "text-to-image" ? "textMode" : "referenceMode")}</Button>)}
      </div>
      <label className="block space-y-2 text-xs">{t("name")}<Input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} disabled={busy} placeholder={t(`${destination}Name`)} /></label>
      <label className="block space-y-2 text-xs">{t("prompt")}<Textarea value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={6000} rows={4} disabled={busy} placeholder={t(`${destination}Prompt`)} /></label>
      {mode === "image-to-image" && <div className="space-y-3 rounded-lg border p-3">
        <p className="text-xs font-medium">{t("reference")}</p>
        <p className="text-xs text-muted-foreground">{t("referenceHint")}</p>
        {!!referenceImages.length && <><SourceFilter value={referenceSource} onChange={setReferenceSource} disabled={busy || reading} /><div className="flex flex-wrap gap-2">{referenceImages.map((image, i) => (!referenceSource || (image.source || (image.file ? "user_upload" : imageSource(image.url))) === referenceSource) && <button key={image.url} type="button" aria-label={t("useReference", { n: i + 1 })} aria-pressed={reference?.url === image.url} disabled={busy || reading} onClick={() => { setReference(image); setError(""); }} className={`w-24 overflow-hidden rounded-lg border-2 ${reference?.url === image.url ? "border-primary" : "border-transparent"}`}><img src={image.url} alt={t("useReference", { n: i + 1 })} className="aspect-square w-full object-cover" /><span className="block p-1"><SourceBadge source={image.source || (image.file ? "user_upload" : imageSource(image.url))} /></span></button>)}</div></>}
        <label className="block space-y-2 text-xs">{t("uploadReference")}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || reading} className="block w-full text-xs" onChange={async e => {
          const file = e.target.files?.[0]; e.target.value = "";
          if (!file) return;
          setReading(true); setParentBusy(true); setError("");
          try { setReference({ url: await readImage(file), source: "user_upload" }); }
          catch { setReference(null); setError(t("referenceFailed")); }
          finally { setReading(false); setParentBusy(false); }
        }} /></label>
        {reference && <div className="flex items-center gap-3"><img src={reference.url} alt={t("reference")} className="size-20 rounded-lg object-contain" /><Button size="sm" variant="ghost" disabled={busy || reading} onClick={() => setReference(null)} aria-label={t("removeReference")}><LuX />{t("removeReference")}</Button></div>}
      </div>}
      <div className="space-y-2"><p className="text-xs">{t("model")}</p><ModelChoiceSelect options={models} value={selected ? { provider: selected.provider, model: selected.id } : choice} onChange={setChoice} placeholder={catalog.loading ? ts("modelsLoading") : ts("selectImageModel")} disabled={busy || !models.length} />{selected && <><p className="break-all text-xs text-muted-foreground">{t("source")}: {providerLabel(selected.provider, ts)} · {selected.name}<br />{selected.id}</p><ModelSummary option={selected} />{!selected.extra?.price && !listPriceFor(selected) && <p className="text-xs text-muted-foreground">{t("unknownPrice")}</p>}</>}</div>
      <ModelCatalogStatus statuses={catalog.statuses.filter(s => s.mediaType === "image")} pending={catalog.pending} onRetry={catalog.retry} />
      {!models.length && !catalog.loading && <p className="text-xs text-amber-600">{t(mode === "image-to-image" ? "noReferenceModels" : "noModels")} <Link href="/settings?tab=providers" className="underline">{t("settings")}</Link></p>}
      <label className="block space-y-2 text-xs">{t("aspect")}<select className="h-9 w-full rounded-lg border bg-background px-3" value={aspect} onChange={e => setAspect(e.target.value)} disabled={busy}>{["1:1", "9:16", "16:9"].map(a => <option key={a} value={a}>{a}</option>)}</select></label>
      <p className="text-xs leading-5 text-muted-foreground">{t(destination === "product" ? "productBilling" : "billing")}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" disabled={busy || reading || !selected || !title.trim() || !prompt.trim() || (mode === "image-to-image" && !reference)} onClick={() => void generate()}>{busy ? <LuLoaderCircle className="animate-spin" /> : <LuSparkles />}{t(busy ? "generating" : destination === "product" ? "generateProduct" : "generate")}</Button>
      {busy && <p className="text-xs text-muted-foreground">{t("waiting")}</p>}
    </>}
  </div>;
}

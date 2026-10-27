"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LibraryVideoPicker } from "@/components/library-video-picker";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { remakeImageFromResource } from "@/lib/remake/references";
import type { RemakeImage } from "@/lib/remake/plan";
import type { ReferenceResource } from "@/lib/reference-resource";

/* eslint-disable @next/next/no-img-element -- local reference previews */
export function ReferenceImages({ images, onChange, maxImages, onBusy }: {
  images: RemakeImage[];
  onChange: (images: RemakeImage[]) => void;
  maxImages: number;
  onBusy: (busy: boolean) => void;
}) {
  const t = useT("remake");
  const objectStorage = useSettingsStore((s) => s.objectStorage);
  const presenters = useCharacterStore((s) => s.characters);
  const fileInput = useRef<HTMLInputElement>(null);
  const adding = useRef(false);
  const [picker, setPicker] = useState(false);
  const [presenterPicker, setPresenterPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async (body: FormData | { path: string; label: string }) => {
    if (adding.current || images.length >= maxImages) return;
    adding.current = true;
    setBusy(true); onBusy(true); setError("");
    try {
      const form = body instanceof FormData;
      if (form) body.append("objectStorage", JSON.stringify(objectStorage));
      const response = await fetch("/api/remake/resources", { method: "POST", ...(form ? {} : { headers: { "Content-Type": "application/json" } }),
        body: form ? body : JSON.stringify({ objectStorage, references: [body] }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      const next = [...images];
      for (const resource of data.resources as ReferenceResource[]) {
        if (resource.mediaType !== "image") throw new Error(t("imagesOnly"));
        if (!next.some((image) => image.id === resource.id || image.resource?.md5 === resource.md5)) next.push(remakeImageFromResource(resource, form ? resource.label : body.label));
      }
      onChange(next.slice(0, maxImages));
      setPresenterPicker(false);
    } catch (error) { setError((error as Error).message); }
    finally { adding.current = false; setBusy(false); onBusy(false); }
  };
  return <div className="space-y-3 rounded-lg border border-border/60 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-medium">{t("imagesTitle")} · {images.length}/{maxImages}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy || images.length >= maxImages} onClick={() => fileInput.current?.click()}>{busy ? t("resourceUploading") : t("addImageUpload")}</Button>
        <Button variant="outline" size="sm" disabled={busy || images.length >= maxImages} onClick={() => setPicker(true)}>{t("addImageLibrary")}</Button>
        <Button variant="outline" size="sm" disabled={busy || images.length >= maxImages} aria-expanded={presenterPicker} onClick={() => setPresenterPicker((open) => !open)}>{t("addImagePresenter")}</Button>
      </div>
    </div>
    <input ref={fileInput} className="hidden" type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => {
      const files = Array.from(event.target.files ?? []).slice(0, Math.max(0, maxImages - images.length)); event.target.value = "";
      if (files.length) { const form = new FormData(); files.forEach((file) => form.append("files", file)); void add(form); }
    }} />
    <LibraryVideoPicker mediaType="image" open={picker} onOpenChange={setPicker} onPick={(item) => void add({ path: item.url, label: item.label })} />
    {presenterPicker && <div className="space-y-2 rounded-md bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{t("presenterImageHint")}</p>
      {presenters.length ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {presenters.map((presenter) => {
          const photo = presenter.referenceImages?.[0] ?? presenter.sourcePhotos?.[0];
          return <button key={presenter.id} type="button" disabled={busy || !photo} onClick={() => photo && void add({ path: photo, label: presenter.name })}
            className="space-y-1 rounded-md border border-border bg-background p-2 text-left text-xs hover:border-primary disabled:cursor-not-allowed disabled:opacity-50">
            {photo ? <img src={photo} alt="" className="aspect-square w-full rounded object-cover" /> : <div className="flex aspect-square items-center justify-center rounded bg-muted text-muted-foreground">{t("presenterImageMissing")}</div>}
            <p className="truncate">{presenter.name}</p>
          </button>;
        })}
      </div> : <p className="text-xs text-muted-foreground">{t("presenterLibraryEmpty")}</p>}
    </div>}
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => <div className="w-28 rounded-md border border-border/60 p-1.5 text-xs" key={image.id}>
        <img src={image.thumbUrl ?? image.url} alt={image.label} className="aspect-square w-full rounded object-cover" />
        <p className="mt-1 font-mono">@Image{index + 1}</p><p className="truncate">{image.label}</p>
        <p className="truncate text-[10px] text-muted-foreground" title={image.resource?.md5}>{image.resource ? `MD5 ${image.resource.md5}` : t("resourcePending")}</p>
        <button type="button" disabled={busy} className="mt-1 text-muted-foreground hover:text-destructive" onClick={() => onChange(images.filter((ref) => ref.id !== image.id))}>{t("removeImage")}</button>
      </div>)}
    </div>
    <p className="text-xs text-muted-foreground">{t("resourceStorageHint")}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

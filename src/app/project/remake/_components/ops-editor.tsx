"use client";

import { useRef, useState } from "react";
import { LuBox, LuFolderOpen, LuIdCard, LuLoaderCircle, LuPlus, LuTrash2, LuUpload, LuUser, LuX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LibraryVideoPicker } from "@/components/library-video-picker";
import { useT } from "@/lib/i18n";
import { useCharacterStore } from "@/lib/stores/project-store";
import { useProductLibraryStore } from "@/lib/stores/product-library-store";
import { activeAssetsBySource, assetUri } from "@/lib/ark-portrait";
import { REMAKE_MAX_IMAGES, isOpComplete, type RemakeImage, type RemakeOp, type RemakeOpKind, type TimeSpan } from "@/lib/remake/plan";

/* eslint-disable @next/next/no-img-element -- reference thumbnails are local files served by our own API */

const KINDS: RemakeOpKind[] = ["person", "product", "background", "custom"];

/** Ark portrait-library asset: a real or virtual person Seedance accepts by ID (asset://<id>) */
const ARK_ASSET = /^(?:asset:\/\/)?([A-Za-z0-9][\w.-]{2,127})$/;
const isArkAsset = (url: string) => url.startsWith("asset://");

/** Only paths the server can read travel to the model (product entries may hold browser blob URLs) */
const usableUrl = (url: string) => url.startsWith("/api/files/") || /^https?:\/\//.test(url);

export function OpsEditor({
  images,
  onImagesChange,
  ops,
  onOpsChange,
  selection,
}: {
  images: RemakeImage[];
  onImagesChange: (images: RemakeImage[]) => void;
  ops: RemakeOp[];
  onOpsChange: (ops: RemakeOp[]) => void;
  selection: TimeSpan | null;
}) {
  const t = useT("remake");
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menu, setMenu] = useState<"product" | "presenter" | "asset" | null>(null);
  const [assetInput, setAssetInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const products = useProductLibraryStore((s) => s.products);
  const presenters = useCharacterStore((s) => s.characters);
  const full = images.length >= REMAKE_MAX_IMAGES;

  // presenter photos registered in the Ark portrait library: sent as asset:// on Volcengine
  const arkBySource = activeAssetsBySource(presenters);

  const addImage = (url: string, label: string, thumbUrl?: string) => {
    if (full || images.some((img) => img.url === url)) return;
    onImagesChange([...images, { id: crypto.randomUUID(), url, label, ...(thumbUrl && { thumbUrl }) }]);
  };

  const assetMatch = assetInput.trim().match(ARK_ASSET);
  const addAsset = () => {
    if (!assetMatch) return;
    addImage(`asset://${assetMatch[1]}`, assetMatch[1]);
    setAssetInput("");
  };

  const removeImage = (id: string) => {
    onImagesChange(images.filter((img) => img.id !== id));
    onOpsChange(ops.map((op) => (op.imageId === id ? { ...op, imageId: undefined } : op)));
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const form = new FormData();
      Array.from(files).slice(0, REMAKE_MAX_IMAGES - images.length).forEach((f) => form.append("files", f));
      form.append("projectId", "remake-refs");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as { paths?: string[] };
      const added = (data.paths ?? []).map((url, i) => ({ id: crypto.randomUUID(), url, label: files[i]?.name ?? url }));
      onImagesChange([...images, ...added].slice(0, REMAKE_MAX_IMAGES));
    } finally {
      setUploading(false);
    }
  };

  const patchOp = (id: string, patch: Partial<RemakeOp>) => onOpsChange(ops.map((op) => (op.id === id ? { ...op, ...patch } : op)));

  const addOp = (kind: RemakeOpKind) =>
    onOpsChange([
      ...ops,
      {
        id: crypto.randomUUID(),
        kind,
        target: "",
        detail: "",
        imageId: kind === "custom" ? undefined : images[0]?.id,
        ...(selection && { range: { ...selection } }),
      },
    ]);

  return (
    <div className="space-y-5">
      {/* reference images */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t("imagesTitle")}</h3>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" disabled={full} onClick={() => setPickerOpen(true)}>
              <LuFolderOpen />
              {t("addImageLibrary")}
            </Button>
            <Button variant="outline" size="sm" disabled={full || uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? <LuLoaderCircle className="animate-spin" /> : <LuUpload />}
              {t("addImageUpload")}
            </Button>
            <Button variant={menu === "product" ? "secondary" : "outline"} size="sm" disabled={full} onClick={() => setMenu(menu === "product" ? null : "product")}>
              <LuBox />
              {t("addImageProduct")}
            </Button>
            <Button variant={menu === "presenter" ? "secondary" : "outline"} size="sm" disabled={full} onClick={() => setMenu(menu === "presenter" ? null : "presenter")}>
              <LuUser />
              {t("addImagePresenter")}
            </Button>
            <Button variant={menu === "asset" ? "secondary" : "outline"} size="sm" disabled={full} onClick={() => setMenu(menu === "asset" ? null : "asset")}>
              <LuIdCard />
              {t("addImageAsset")}
            </Button>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = "";
          }}
        />
        <LibraryVideoPicker mediaType="image" open={pickerOpen} onOpenChange={setPickerOpen} onPick={(item) => addImage(item.url, item.label)} />

        {menu === "asset" && (
          <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-2">
            <div className="flex gap-2">
              <Input
                value={assetInput}
                onChange={(e) => setAssetInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addAsset()}
                placeholder="asset://asset-2026…"
                aria-label={t("addImageAsset")}
                className="h-8 font-mono text-xs"
              />
              <Button size="sm" disabled={!assetMatch || full} onClick={addAsset}>
                <LuPlus />
                {t("addImageAssetConfirm")}
              </Button>
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">{t("addImageAssetHint")}</p>
          </div>
        )}

        {(menu === "product" || menu === "presenter") && (
          <div className="flex gap-2 overflow-x-auto rounded-lg border border-border/60 bg-muted/20 p-2">
            {(menu === "product"
              ? products.flatMap((p) => p.images.filter(usableUrl).map((url, i) => ({ key: `${p.id}-${i}`, url, label: p.name, thumb: url as string | undefined })))
              : presenters.flatMap((c) => [
                  ...(c.referenceImages?.[0] ? [{ key: c.id, url: c.referenceImages[0], label: c.name, thumb: c.referenceImages[0] }] : []),
                  // registered portraits, including ones authorised from another account (no photo)
                  ...(c.arkPortrait?.assets ?? [])
                    .filter((a) => a.status === "Active" && a.type === "Image" && a.sourceUrl !== c.referenceImages?.[0])
                    .map((a) => ({ key: a.id, url: assetUri(a.id), label: c.name, thumb: a.sourceUrl })),
                ])
            ).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => addImage(item.url, item.label, isArkAsset(item.url) ? item.thumb : undefined)}
                className="relative w-20 shrink-0 overflow-hidden rounded-md border border-border/60 bg-background text-left hover:border-primary/60"
              >
                {item.thumb ? (
                  <img src={item.thumb} alt="" className="aspect-square w-full object-cover" />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center bg-muted/40 text-muted-foreground">
                    <LuIdCard className="size-5" />
                  </div>
                )}
                {(isArkAsset(item.url) || arkBySource.has(item.url)) && (
                  <span className="absolute right-1 top-1 rounded bg-emerald-600 p-0.5 text-white" title={t("arkAssetLinked")}>
                    <LuIdCard className="size-2.5" />
                  </span>
                )}
                <span className="block truncate px-1 py-0.5 text-[10px]">{item.label}</span>
              </button>
            ))}
          </div>
        )}

        {images.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">{t("imagesEmpty")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={img.id} className="group relative w-24 overflow-hidden rounded-lg border border-border/60 bg-background">
                {isArkAsset(img.url) && !img.thumbUrl ? (
                  <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 bg-muted/40 text-muted-foreground">
                    <LuIdCard className="size-6" />
                    <span className="text-[10px]">{t("assetTile")}</span>
                  </div>
                ) : (
                  <img src={img.thumbUrl ?? img.url} alt={img.label} className="aspect-square w-full object-cover" />
                )}
                {(isArkAsset(img.url) || arkBySource.has(img.url)) && (
                  <span className="absolute bottom-6 right-1 rounded bg-emerald-600 px-1 py-0.5 text-[9px] text-white" title={t("arkAssetLinked")}>
                    {t("assetTile")}
                  </span>
                )}
                <span className="absolute left-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">@图片{i + 1}</span>
                <button
                  type="button"
                  aria-label={t("removeImage")}
                  onClick={() => removeImage(img.id)}
                  className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <LuX className="size-3" />
                </button>
                <p className="truncate px-1.5 py-1 text-[10px] text-muted-foreground">{img.label}</p>
              </div>
            ))}
          </div>
        )}
        {full && <p className="text-[11px] text-muted-foreground">{t("imagesMax")}</p>}
      </div>

      {/* changes */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t("opsTitle")}</h3>
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map((kind) => (
              <Button key={kind} variant="outline" size="sm" onClick={() => addOp(kind)}>
                <LuPlus />
                {t(`opKind_${kind}`)}
              </Button>
            ))}
          </div>
        </div>

        {ops.map((op, n) => (
          <div key={op.id} className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-primary/12 px-2 py-0.5 text-xs font-medium text-primary">
                {n + 1}. {t(`opKind_${op.kind}`)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("opRange")}：{op.range ? `${op.range.start.toFixed(1)}–${op.range.end.toFixed(1)}s` : t("opRangeAll")}
              </span>
              {selection && (
                <button type="button" className="text-xs text-primary hover:underline" onClick={() => patchOp(op.id, { range: { ...selection } })}>
                  {t("opRangeUseSelection")}
                </button>
              )}
              {op.range && (
                <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => patchOp(op.id, { range: undefined })}>
                  {t("opRangeClear")}
                </button>
              )}
              <button
                type="button"
                aria-label={t("opRemove")}
                className="ml-auto rounded p-1 text-muted-foreground hover:text-destructive"
                onClick={() => onOpsChange(ops.filter((o) => o.id !== op.id))}
              >
                <LuTrash2 className="size-3.5" />
              </button>
            </div>

            {op.kind === "custom" ? (
              <Textarea
                value={op.detail}
                onChange={(e) => patchOp(op.id, { detail: e.target.value })}
                placeholder={t("opDetailCustom")}
                rows={2}
                className="resize-none text-sm"
              />
            ) : (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
                <Input value={op.target} onChange={(e) => patchOp(op.id, { target: e.target.value })} placeholder={t(`opTarget_${op.kind}`)} className="text-sm" />
                <select
                  value={op.imageId ?? ""}
                  onChange={(e) => patchOp(op.id, { imageId: e.target.value || undefined })}
                  aria-label={t("opImage")}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">{t("opImageNone")}</option>
                  {images.map((img, i) => (
                    <option key={img.id} value={img.id}>
                      @图片{i + 1} · {img.label.slice(0, 16)}
                    </option>
                  ))}
                </select>
                <Input
                  value={op.detail}
                  onChange={(e) => patchOp(op.id, { detail: e.target.value })}
                  placeholder={t("opDetail")}
                  className="text-sm sm:col-span-2"
                />
              </div>
            )}
            {!isOpComplete(op) && <p className="text-[11px] text-amber-600">{t("opIncomplete")}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

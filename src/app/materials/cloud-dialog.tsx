"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LuCheck, LuCloud, LuCloudOff, LuCloudUpload, LuCopy, LuLoaderCircle, LuRefreshCw } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { AssetLibraryItem } from "@/lib/asset-library";
import { useLocale, useT } from "@/lib/i18n";
import { isObjectStorageConfigured, type ObjectStorageConfig } from "@/lib/object-storage";
import { useSettingsStore } from "@/lib/stores/settings-store";

/** Lifetime of the signed link the library hands out (seconds). */
const SHARE_SECONDS = 3600;

type Cloud = NonNullable<AssetLibraryItem["cloud"]>;

/** Mirror one library item into the bucket; resolves to its new cloud record. */
export async function uploadItemToCloud(id: string, objectStorage: ObjectStorageConfig, fallbackError: string): Promise<Cloud> {
  const response = await fetch(`/api/materials/${id}/cloud`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "upload", objectStorage }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || fallbackError);
  return { bucket: payload.objectBucket ?? null, uploadedAt: payload.objectUploadedAt ?? null };
}

/**
 * The cloud marker on a card / row: a filled cloud once a copy sits in object storage, a struck-out
 * one while the material is local only. Either way a click opens the cloud dialog.
 */
export function CloudButton({ item, onOpen, className = "" }: { item: AssetLibraryItem; onOpen: () => void; className?: string }) {
  const t = useT("assetLibrary");
  const uploaded = Boolean(item.cloud);
  const label = uploaded ? t("cloudUploadedAt", { bucket: item.cloud?.bucket ?? "" }) : t("cloudNotUploaded");
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={`flex h-6 w-6 items-center justify-center rounded-full border backdrop-blur transition-colors ${
        uploaded
          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400"
          : "border-border/60 bg-background/80 text-muted-foreground hover:text-foreground"
      } ${className}`}
    >
      {uploaded ? <LuCloud className="h-3.5 w-3.5" /> : <LuCloudOff className="h-3.5 w-3.5" />}
    </button>
  );
}

/**
 * Small dialog behind the cloud marker. A local-only item offers the upload; an uploaded one signs a
 * private GET link straight away (default 3600 s) — the bucket stays private, so a signed link is
 * the only way in.
 */
export function CloudDialog({
  item,
  onClose,
  onUploaded,
}: {
  item: AssetLibraryItem | null;
  onClose: () => void;
  onUploaded: (id: string, cloud: Cloud) => void;
}) {
  const t = useT("assetLibrary");
  const locale = useLocale();
  const objectStorage = useSettingsStore((s) => s.objectStorage);
  const configured = isObjectStorageConfigured(objectStorage);

  const [uploading, setUploading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresSeconds: number; expiresAt: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const uploaded = Boolean(item?.cloud);

  const sign = useCallback(async () => {
    if (!item) return;
    setSigning(true);
    setError("");
    try {
      const response = await fetch(`/api/materials/${item.id}/cloud`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "url", objectStorage, expiresSeconds: SHARE_SECONDS }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || t("cloudUrlFailed"));
      setLink(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("cloudUrlFailed"));
    } finally {
      setSigning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable per locale
  }, [item, objectStorage]);

  // fresh state per item; an uploaded one signs its link on open
  useEffect(() => {
    setLink(null);
    setError("");
    setCopied(false);
    if (item?.cloud && configured) void sign();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the target changes
  }, [item?.id, uploaded]);

  const upload = async () => {
    if (!item) return;
    setUploading(true);
    setError("");
    try {
      onUploaded(item.id, await uploadItemToCloud(item.id, objectStorage, t("cloudUploadFailed")));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("cloudUploadFailed"));
    } finally {
      setUploading(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the link is selectable */
    }
  };

  const busy = uploading || signing;

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && !uploading && onClose()}>
      <DialogContent className="max-w-md p-4 sm:max-w-md">
        <DialogTitle className="flex items-center gap-2 text-sm">
          {uploaded ? <LuCloud className="h-4 w-4 text-emerald-500" /> : <LuCloudUpload className="h-4 w-4" />}
          {t(uploaded ? "cloudUrlTitle" : "cloudUploadTitle")}
        </DialogTitle>

        {item && (
          <div className="space-y-3 text-xs">
            <p className="text-muted-foreground">
              {uploaded ? t("cloudUploadedAt", { bucket: item.cloud?.bucket ?? "" }) : t("cloudNotUploaded")}
            </p>

            {!configured ? (
              <p className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-muted-foreground">
                {t("cloudNotConfigured")}{" "}
                <Link href="/settings?tab=storage" className="font-medium text-primary hover:underline">
                  {t("cloudConfigure")}
                </Link>
              </p>
            ) : uploaded ? (
              <>
                {signing && !link ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    {t("cloudUrlLoading")}
                  </div>
                ) : link ? (
                  <>
                    <textarea
                      readOnly
                      value={link.url}
                      rows={4}
                      onFocus={(event) => event.currentTarget.select()}
                      className="w-full resize-none break-all rounded-lg border border-border/60 bg-muted/20 p-2 font-mono text-[11px] leading-4 text-foreground outline-none"
                    />
                    <p className="text-muted-foreground">
                      {t("cloudUrlHint", {
                        seconds: link.expiresSeconds,
                        time: new Date(link.expiresAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US"),
                      })}
                    </p>
                  </>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">{t("cloudUploadHint")}</p>
            )}

            {error && <p className="leading-5 text-destructive">{error}</p>}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" disabled={uploading} onClick={onClose}>
                {t("close")}
              </Button>
              {configured && uploaded && (
                <>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={sign}>
                    <LuRefreshCw className={`mr-1.5 h-3.5 w-3.5 ${signing ? "animate-spin" : ""}`} />
                    {t(link ? "cloudRefreshUrl" : "cloudGetUrl")}
                  </Button>
                  <Button type="button" size="sm" disabled={!link || busy} onClick={copy}>
                    {copied ? <LuCheck className="mr-1.5 h-3.5 w-3.5" /> : <LuCopy className="mr-1.5 h-3.5 w-3.5" />}
                    {copied ? t("copied") : t("cloudCopyUrl")}
                  </Button>
                </>
              )}
              {configured && !uploaded && (
                <Button type="button" size="sm" disabled={busy || !item.url} onClick={upload}>
                  {uploading ? (
                    <LuLoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LuCloudUpload className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t(uploading ? "cloudUploading" : "cloudUpload")}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

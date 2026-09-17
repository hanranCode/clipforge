"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LuLoaderCircle, LuPlay, LuSearch } from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatBytes, type AssetLibraryItem } from "@/lib/asset-library";
import { useLocale, useT } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relative-time";

const PAGE_SIZE = 24;

/** What a caller gets back: the local path is all any consumer needs, the rest is for labelling. */
export interface PickedLibraryVideo {
  id: string;
  /** Local `/api/files/...` path — servable, and resolvable back to disk server-side. */
  url: string;
  label: string;
  durationSeconds?: number;
}

/** Whatever the library knows to call this clip, in the order a human would recognise it. */
function labelOf(item: AssetLibraryItem): string {
  return item.title || item.prompt || item.description || item.projectName || item.model || "—";
}

/**
 * Pick a video out of the cross-project asset library.
 *
 * Material that is already on this machine should not have to be uploaded again to be used —
 * everything in the library is a local file with a stable `/api/files` path, which is exactly what
 * a reference video needs. Video-only by construction: the feed is requested with `mediaType=video`,
 * so an image can never come back from here.
 */
export function LibraryVideoPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (video: PickedLibraryVideo) => void;
}) {
  const t = useT("assetLibrary");
  const locale = useLocale();

  const [items, setItems] = useState<AssetLibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (offset: number) => {
      const params = new URLSearchParams({ mediaType: "video", offset: String(offset), limit: String(PAGE_SIZE) });
      if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
      const response = await fetch(`/api/materials?${params.toString()}`);
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()) as { items: AssetLibraryItem[]; total: number; hasMore: boolean };
    },
    [debouncedSearch],
  );

  // only fetch while open — a closed picker should not poll the library on every keystroke elsewhere
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    load(0)
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setTotal(data.total);
        setHasMore(data.hasMore);
      })
      .catch(() => !cancelled && setError(t("loadError")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable per locale
  }, [open, load]);

  const loadMore = useCallback(() => {
    if (loadingMore || loading || !hasMore) return;
    setLoadingMore(true);
    load(items.length)
      .then((data) => {
        setItems((previous) => [...previous, ...data.items]);
        setHasMore(data.hasMore);
      })
      .catch(() => setError(t("loadError")))
      .finally(() => setLoadingMore(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable per locale
  }, [hasMore, items.length, load, loading, loadingMore]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: "400px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  const pick = (item: AssetLibraryItem) => {
    if (!item.url) return;
    onPick({
      id: item.id,
      url: item.url,
      label: labelOf(item),
      ...(item.inputs?.durationSeconds != null && { durationSeconds: item.inputs.durationSeconds }),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] max-w-3xl flex-col p-4 sm:max-w-3xl">
        <DialogTitle className="text-sm">{t("pickerTitle")}</DialogTitle>

        <div className="relative mt-2">
          <LuSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-9 pl-9"
          />
        </div>

        <div className="mt-2 text-xs text-muted-foreground">{t("count", { count: total })}</div>

        <div className="-mx-1 mt-1 flex-1 overflow-y-auto px-1">
          {error && <p className="py-10 text-center text-sm text-destructive">{error}</p>}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
              <LuLoaderCircle className="h-4 w-4 animate-spin" />
              {t("loading")}
            </div>
          ) : items.length === 0 ? (
            <p className="py-20 text-center text-sm text-muted-foreground">
              {debouncedSearch.trim() ? t("noMatch") : t("pickerEmpty")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => pick(item)}
                  className="group overflow-hidden rounded-xl border border-border/50 bg-card text-left transition-colors hover:border-primary/50"
                >
                  <div className="relative aspect-video bg-muted/40">
                    {item.url && (
                      <video
                        src={item.url}
                        poster={item.thumbnailUrl ?? undefined}
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        className="h-full w-full object-cover"
                        onMouseEnter={(event) => void event.currentTarget.play().catch(() => {})}
                        onMouseLeave={(event) => {
                          event.currentTarget.pause();
                          event.currentTarget.currentTime = 0;
                        }}
                      />
                    )}
                    <Badge variant="secondary" className="absolute left-2 top-2 gap-1 text-[10px]">
                      <LuPlay className="h-2.5 w-2.5" />
                      {item.inputs?.durationSeconds != null ? `${item.inputs.durationSeconds}s` : t("video")}
                    </Badge>
                  </div>
                  <div className="space-y-1 p-2.5">
                    <p className="line-clamp-2 text-xs leading-5 text-foreground">{labelOf(item)}</p>
                    <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span className="truncate">{formatBytes(item.sizeBytes)}</span>
                      <span className="shrink-0">{formatRelativeTime(item.createdAt, locale)}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {!loading && items.length > 0 && (
            <div ref={sentinelRef} className="flex justify-center py-5">
              {loadingMore ? (
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  {t("loadingMore")}
                </span>
              ) : hasMore ? (
                <Button variant="outline" size="sm" onClick={loadMore}>
                  {t("loadMore")}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">{t("end")}</span>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

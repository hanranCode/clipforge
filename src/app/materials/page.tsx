"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  LuCheck,
  LuCopy,
  LuExternalLink,
  LuGrid2X2,
  LuImage,
  LuList,
  LuLoaderCircle,
  LuPlay,
  LuPlus,
  LuSearch,
} from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatBytes, type AssetLibraryItem } from "@/lib/asset-library";
import { useLocale, useT } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relative-time";
import { ImportDialog } from "./import-dialog";

/* eslint-disable @next/next/no-img-element -- assets are arbitrary local files served by /api/files; next/image would need a loader per project dir and buys nothing here */

const PAGE_SIZE = 24;

interface Facets {
  providers: Array<{ value: string; count: number }>;
  models: Array<{ value: string; count: number }>;
  origins: Array<{ value: string; count: number }>;
  mediaTypes: Array<{ value: string; count: number }>;
  projects: Array<{ id: string; name: string }>;
}

interface LibraryResponse {
  items: AssetLibraryItem[];
  total: number;
  hasMore: boolean;
  facets: Facets;
  truncated: boolean;
}

/** origin key → i18n key (kept here so the enum stays the single source of truth) */
const ORIGIN_LABEL: Record<string, string> = {
  ai_generated: "originAiGenerated",
  stock_footage: "originStockFootage",
  user_upload: "originUserUpload",
  link_import: "originLinkImport",
  product_image: "originProductImage",
};

/** One labelled filter menu; an empty value means "no filter". */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="hidden sm:inline">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-lg border border-border/60 bg-background px-2 text-xs text-foreground outline-none transition-colors hover:border-border focus:border-primary/60"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Small key/value row used by the detail dialog. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] gap-3 py-1.5 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words text-foreground">{children}</div>
    </div>
  );
}

/** What to write under a thumbnail: an import is known by its title, a generated take by its prompt. */
function captionOf(item: AssetLibraryItem): string {
  return item.title || item.prompt || item.description || item.projectName || "—";
}

/**
 * Cross-project asset library.
 *
 * Everything the models produced, in one feed: cards by default (the picture is the point),
 * a list mode for scanning provenance, and an infinite waterfall instead of pagination so
 * browsing never breaks stride. Filtering runs server-side against the whole library, so a
 * filter still finds material that has not been scrolled to yet.
 */
export default function MaterialsPage() {
  const t = useT("assetLibrary");
  const locale = useLocale();

  const [items, setItems] = useState<AssetLibraryItem[]>([]);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [view, setView] = useState<"card" | "list">("card");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [mediaType, setMediaType] = useState("");
  const [origin, setOrigin] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [projectId, setProjectId] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [detail, setDetail] = useState<AssetLibraryItem | null>(null);
  const [copied, setCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // bumped after an import so the feed restarts and the new material appears at the top
  const [reloadToken, setReloadToken] = useState(0);

  // typing must not fire a request per keystroke
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (mediaType) params.set("mediaType", mediaType);
    if (origin) params.set("origin", origin);
    if (provider) params.set("provider", provider);
    if (model) params.set("model", model);
    if (projectId) params.set("projectId", projectId);
    if (selectedOnly) params.set("selectedOnly", "1");
    if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
    return params;
  }, [mediaType, origin, provider, model, projectId, selectedOnly, debouncedSearch]);

  const load = useCallback(
    async (offset: number) => {
      const params = new URLSearchParams(query);
      params.set("offset", String(offset));
      params.set("limit", String(PAGE_SIZE));
      const response = await fetch(`/api/materials?${params.toString()}`);
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()) as LibraryResponse;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadToken is a manual refetch trigger
    [query, reloadToken],
  );

  // filters changed → restart the feed
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    load(0)
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setTotal(data.total);
        setHasMore(data.hasMore);
        setFacets(data.facets);
        setTruncated(data.truncated);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t("loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable per locale
  }, [load]);

  const loadMore = useCallback(() => {
    if (loadingMore || loading || !hasMore) return;
    setLoadingMore(true);
    load(items.length)
      .then((data) => {
        setItems((previous) => [...previous, ...data.items]);
        setHasMore(data.hasMore);
        setTotal(data.total);
      })
      .catch(() => setLoadError(t("loadError")))
      .finally(() => setLoadingMore(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable per locale
  }, [hasMore, items.length, load, loading, loadingMore]);

  // waterfall: fetch the next page as the sentinel comes into view
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  const copyPrompt = async (prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the prompt is selectable in the dialog anyway */
    }
  };

  const originOptions = [
    { value: "", label: t("all") },
    ...(facets?.origins ?? []).map((entry) => ({
      value: entry.value,
      label: `${t(ORIGIN_LABEL[entry.value] ?? entry.value)} (${entry.count})`,
    })),
  ];

  const renderPreview = (item: AssetLibraryItem, className: string) => {
    if (!item.url) {
      return (
        <div className={`flex items-center justify-center bg-muted/40 ${className}`}>
          <LuImage className="h-5 w-5 text-muted-foreground" />
        </div>
      );
    }
    if (item.mediaType === "video") {
      return (
        <video
          src={item.url}
          poster={item.thumbnailUrl ?? undefined}
          muted
          loop
          playsInline
          preload="metadata"
          className={className}
          onMouseEnter={(event) => void event.currentTarget.play().catch(() => {})}
          onMouseLeave={(event) => {
            event.currentTarget.pause();
            event.currentTarget.currentTime = 0;
          }}
        />
      );
    }
    return <img src={item.thumbnailUrl ?? item.url} alt={item.prompt ?? ""} loading="lazy" className={className} />;
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 md:px-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("pageTitle")}</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">{t("pageSubtitle")}</p>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setImportOpen(true)}>
          <LuPlus className="mr-1.5 h-3.5 w-3.5" />
          {t("importButton")}
        </Button>
      </header>

      {/* controls: search + filters + view toggle */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <LuSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-9 pl-9"
          />
        </div>
        <FilterSelect
          label={t("filterMediaType")}
          value={mediaType}
          onChange={setMediaType}
          options={[
            { value: "", label: t("all") },
            { value: "image", label: t("image") },
            { value: "video", label: t("video") },
          ]}
        />
        <FilterSelect label={t("filterOrigin")} value={origin} onChange={setOrigin} options={originOptions} />
        <FilterSelect
          label={t("filterProvider")}
          value={provider}
          onChange={setProvider}
          options={[{ value: "", label: t("all") }, ...(facets?.providers ?? []).map((e) => ({ value: e.value, label: `${e.value} (${e.count})` }))]}
        />
        <FilterSelect
          label={t("filterModel")}
          value={model}
          onChange={setModel}
          options={[{ value: "", label: t("all") }, ...(facets?.models ?? []).map((e) => ({ value: e.value, label: `${e.value} (${e.count})` }))]}
        />
        <FilterSelect
          label={t("filterProject")}
          value={projectId}
          onChange={setProjectId}
          options={[{ value: "", label: t("all") }, ...(facets?.projects ?? []).map((e) => ({ value: e.id, label: e.name }))]}
        />
        <button
          type="button"
          onClick={() => setSelectedOnly((value) => !value)}
          className={`h-8 rounded-lg border px-2.5 text-xs transition-colors ${
            selectedOnly ? "border-primary/60 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("selectedOnly")}
        </button>
        <div className="ml-auto flex rounded-lg border border-border/60 p-0.5">
          {(["card", "list"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              aria-label={t(mode === "card" ? "viewCard" : "viewList")}
              className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors ${
                view === mode ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {mode === "card" ? <LuGrid2X2 className="h-3.5 w-3.5" /> : <LuList className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{t(mode === "card" ? "viewCard" : "viewList")}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
        <span>{t("count", { count: total })}</span>
        {truncated && <span>{t("truncated")}</span>}
      </div>

      {loadError && <p className="py-10 text-center text-sm text-destructive">{loadError}</p>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
          <LuLoaderCircle className="h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      ) : items.length === 0 ? (
        <p className="py-24 text-center text-sm text-muted-foreground">
          {query.toString() ? t("noMatch") : t("empty")}
        </p>
      ) : view === "card" ? (
        // masonry via CSS columns: cards keep their natural aspect ratio, so a 9:16 clip and a
        // square product shot sit side by side without either being cropped
        <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5 [&>*]:mb-3">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setDetail(item)}
              className="group block w-full break-inside-avoid overflow-hidden rounded-xl border border-border/50 bg-card text-left transition-colors hover:border-primary/40"
            >
              <div className="relative">
                {renderPreview(item, "w-full object-cover")}
                <div className="absolute left-2 top-2 flex gap-1">
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    {item.mediaType === "video" ? <LuPlay className="h-2.5 w-2.5" /> : <LuImage className="h-2.5 w-2.5" />}
                    {t(item.mediaType === "video" ? "video" : "image")}
                  </Badge>
                  {item.selected && <Badge className="text-[10px]">{t("selected")}</Badge>}
                </div>
              </div>
              <div className="space-y-1 p-2.5">
                <p className="line-clamp-2 text-xs leading-5 text-foreground">{captionOf(item)}</p>
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span className="truncate">{item.model || t(ORIGIN_LABEL[item.origin] ?? item.origin)}</span>
                  <span className="shrink-0">{formatRelativeTime(item.createdAt, locale)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/50">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t("output")}</th>
                <th className="px-3 py-2 font-medium">{t("prompt")}</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">{t("source")}</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("model")}</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("project")}</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">{t("size")}</th>
                <th className="px-3 py-2 font-medium">{t("createdAt")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => setDetail(item)}
                  className="cursor-pointer border-t border-border/40 transition-colors hover:bg-muted/30"
                >
                  <td className="px-3 py-2">
                    <div className="h-10 w-16 overflow-hidden rounded-md bg-muted/40">
                      {renderPreview(item, "h-10 w-16 object-cover")}
                    </div>
                  </td>
                  <td className="max-w-[420px] px-3 py-2">
                    <p className="line-clamp-2 text-foreground">{captionOf(item)}</p>
                  </td>
                  <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
                    {t(ORIGIN_LABEL[item.origin] ?? item.origin)}
                  </td>
                  <td className="hidden max-w-[180px] truncate px-3 py-2 text-muted-foreground lg:table-cell">{item.model || "—"}</td>
                  <td className="hidden max-w-[160px] truncate px-3 py-2 text-muted-foreground lg:table-cell">{item.projectName || "—"}</td>
                  <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">{formatBytes(item.sizeBytes)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatRelativeTime(item.createdAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* waterfall sentinel + explicit fallback for browsers without IntersectionObserver */}
      {!loading && items.length > 0 && (
        <div ref={sentinelRef} className="flex justify-center py-8">
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

      {/* detail: the full record behind one asset */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto p-4 sm:max-w-3xl">
          <DialogTitle className="text-sm">{t("detailTitle")}</DialogTitle>
          {detail && (
            <div className="grid gap-4 md:grid-cols-[minmax(0,320px)_1fr]">
              <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
                {detail.url && detail.mediaType === "video" ? (
                  <video src={detail.url} controls poster={detail.thumbnailUrl ?? undefined} className="w-full" />
                ) : (
                  renderPreview(detail, "w-full object-contain")
                )}
              </div>
              <div className="min-w-0">
                <DetailRow label={t("source")}>{t(ORIGIN_LABEL[detail.origin] ?? detail.origin)}</DetailRow>
                {detail.title && <DetailRow label={t("name")}>{detail.title}</DetailRow>}
                <DetailRow label={t("project")}>
                  {detail.projectId ? (
                    <>
                      <Link href={`/project/${detail.projectId}/assets`} className="text-primary hover:underline">
                        {detail.projectName || detail.projectId}
                      </Link>
                      <span className="ml-2 text-muted-foreground">{t("shot", { n: detail.shotId ?? 0 })}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t("importedNoProject")}</span>
                  )}
                </DetailRow>
                {detail.provider && <DetailRow label={t("provider")}>{detail.provider}</DetailRow>}
                {detail.model && <DetailRow label={t("model")}>{detail.model}</DetailRow>}
                {detail.projectId && (
                  <DetailRow label={t("status")}>
                    {detail.status}
                    {detail.selected ? ` · ${t("selected")}` : ""}
                  </DetailRow>
                )}
                {detail.tags?.length ? (
                  <DetailRow label={t("tags")}>
                    <div className="flex flex-wrap gap-1">
                      {detail.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-[10px]">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </DetailRow>
                ) : null}
                <DetailRow label={t("size")}>{formatBytes(detail.sizeBytes)}</DetailRow>
                <DetailRow label={t("createdAt")}>
                  {detail.createdAt ? new Date(detail.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") : "—"}
                </DetailRow>
                {detail.author && <DetailRow label={t("author")}>{detail.author}</DetailRow>}
                {detail.license && <DetailRow label={t("license")}>{detail.license}</DetailRow>}
                {detail.sourceUrl && (
                  <DetailRow label={t("sourceLink")}>
                    <a href={detail.sourceUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {detail.sourceUrl}
                    </a>
                  </DetailRow>
                )}
                {detail.inputs && (
                  <DetailRow label={t("inputs")}>
                    <div className="space-y-0.5 text-muted-foreground">
                      {detail.inputs.mode && <div>{t("mode")}: {detail.inputs.mode}</div>}
                      {detail.inputs.durationSeconds != null && <div>{t("duration")}: {detail.inputs.durationSeconds}s</div>}
                      {detail.inputs.audioMode && <div>{t("audioMode")}: {detail.inputs.audioMode}</div>}
                      {detail.inputs.references?.length ? (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {detail.inputs.references.map((url) => (
                            <img key={url} src={url} alt="" className="h-10 w-10 rounded object-cover" />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </DetailRow>
                )}
                <div className="mt-3 rounded-lg border border-border/50 bg-muted/20 p-2.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t(detail.projectId ? "prompt" : "description")}
                    </span>
                    {detail.prompt && (
                      <button
                        type="button"
                        onClick={() => copyPrompt(detail.prompt as string)}
                        className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {copied ? <LuCheck className="h-3 w-3" /> : <LuCopy className="h-3 w-3" />}
                        {copied ? t("copied") : t("copyPrompt")}
                      </button>
                    )}
                  </div>
                  <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-foreground">
                    {detail.prompt || detail.description || t("noPrompt")}
                  </p>
                </div>
                <div className="mt-3 flex gap-2">
                  {detail.projectId && (
                    <Link href={`/project/${detail.projectId}/assets`}>
                      <Button variant="outline" size="sm">{t("openProject")}</Button>
                    </Link>
                  )}
                  {detail.url && (
                    <a href={detail.url} target="_blank" rel="noreferrer">
                      <Button variant="ghost" size="sm">
                        <LuExternalLink className="mr-1.5 h-3.5 w-3.5" />
                        {t("openFile")}
                      </Button>
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => setReloadToken((token) => token + 1)}
      />
    </div>
  );
}

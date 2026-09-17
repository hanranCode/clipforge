"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  LuChevronDown,
  LuChevronRight,
  LuCircleAlert,
  LuLoaderCircle,
  LuSearch,
  LuTrash2,
} from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ApiCallPayload, ApiCallUsage } from "@/lib/api-call-log";
import { useLocale, useT } from "@/lib/i18n";
import { formatUsd, type ApiCallCost, type ModelType } from "@/lib/model-pricing";
import { formatRelativeTime } from "@/lib/relative-time";

const PAGE_SIZE = 50;

interface ApiCallRow {
  id: string;
  modelType: ModelType;
  scene: string | null;
  provider: string;
  model: string;
  baseUrl: string | null;
  endpoint: string | null;
  projectId: string | null;
  projectName: string | null;
  shotId: number | null;
  status: "success" | "failed";
  httpStatus: number | null;
  latencyMs: number | null;
  streamed: boolean;
  request: ApiCallPayload | null;
  response: ApiCallPayload | null;
  usage: ApiCallUsage | null;
  cost: ApiCallCost | null;
  error: string | null;
  taskId: string | null;
  createdAt: string | null;
}

interface Summary {
  calls: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  unpricedCalls: number;
  latencyMs: number;
  byType: Array<{ modelType: ModelType; calls: number; totalUsd: number }>;
}

interface LogResponse {
  items: ApiCallRow[];
  total: number;
  hasMore: boolean;
  summary: Summary;
  facets: { providers: string[]; models: string[]; scenes: string[] };
}

/** The five settings-level model slots, in pipeline order. */
const MODEL_TYPES: Array<{ value: ModelType; key: string }> = [
  { value: "text", key: "typeText" },
  { value: "vision", key: "typeVision" },
  { value: "image", key: "typeImage" },
  { value: "video", key: "typeVideo" },
  { value: "tts", key: "typeTts" },
];

const RANGES: Array<{ value: string; key: string; ms: number }> = [
  { value: "", key: "rangeAll", ms: 0 },
  { value: "24h", key: "range24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", key: "range7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", key: "range30d", ms: 30 * 24 * 60 * 60 * 1000 },
];

function compactNumber(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "—";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 max-w-[180px] rounded-lg border border-border/60 bg-background px-2 text-xs text-foreground outline-none transition-colors hover:border-border focus:border-primary/60"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Pretty-printed JSON block for the expanded row. */
function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-muted/20 p-2.5 text-[11px] leading-5 text-foreground">
        {text}
      </pre>
    </div>
  );
}

/**
 * The model API call log.
 *
 * One row per HTTP request to a model — including the retries behind a single generation, which is
 * exactly what makes an unexpected bill explainable. Rows are grouped by the settings-level model
 * type (text / vision / image / video / speech) and carry what each call consumed: tokens for text,
 * images and seconds for media, characters for speech, plus the estimated money.
 */
export default function ApiLogsPage() {
  const t = useT("apiLog");
  const locale = useLocale();

  const [items, setItems] = useState<ApiCallRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [facets, setFacets] = useState<LogResponse["facets"] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [modelType, setModelType] = useState<string>("");
  const [scene, setScene] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("");
  const [range, setRange] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (modelType) params.set("modelType", modelType);
    if (scene) params.set("scene", scene);
    if (provider) params.set("provider", provider);
    if (model) params.set("model", model);
    if (status) params.set("status", status);
    if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
    const selectedRange = RANGES.find((entry) => entry.value === range);
    if (selectedRange?.ms) params.set("since", String(Date.now() - selectedRange.ms));
    return params;
  }, [modelType, scene, provider, model, status, range, debouncedSearch]);

  const load = useCallback(
    async (offset: number) => {
      const params = new URLSearchParams(query);
      params.set("offset", String(offset));
      params.set("limit", String(PAGE_SIZE));
      const response = await fetch(`/api/api-calls?${params.toString()}`);
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()) as LogResponse;
    },
    [query],
  );

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
        setSummary(data.summary);
        setFacets(data.facets);
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
  }, [load, reloadToken]);

  const loadMore = useCallback(() => {
    if (loadingMore || loading || !hasMore) return;
    setLoadingMore(true);
    load(items.length)
      .then((data) => {
        setItems((previous) => [...previous, ...data.items]);
        setHasMore(data.hasMore);
      })
      .catch(() => setLoadError(t("loadError")))
      .finally(() => setLoadingMore(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable per locale
  }, [hasMore, items.length, load, loading, loadingMore]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "500px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  // destructive: records only, but still behind an explicit confirmation
  const clearLog = async () => {
    if (clearing || !window.confirm(t("clearConfirm"))) return;
    setClearing(true);
    try {
      const response = await fetch("/api/api-calls", { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      setReloadToken((token) => token + 1);
    } catch {
      setLoadError(t("loadError"));
    } finally {
      setClearing(false);
    }
  };

  const typeLabel = (value: ModelType) => t(MODEL_TYPES.find((entry) => entry.value === value)?.key ?? value);

  const usageCell = (row: ApiCallRow) => {
    const usage = row.usage;
    if (!usage) return "—";
    if (usage.promptTokens != null || usage.completionTokens != null) {
      return `${compactNumber(usage.promptTokens)} / ${compactNumber(usage.completionTokens)}`;
    }
    if (usage.videoSeconds != null) return `${usage.videoSeconds}s`;
    if (usage.imageCount != null) return `${usage.imageCount}×`;
    if (usage.charCount != null) return `${compactNumber(usage.charCount)} chars`;
    return "—";
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 md:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("pageTitle")}</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">{t("pageSubtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={clearLog} disabled={clearing || total === 0}>
          <LuTrash2 className="mr-1.5 h-3.5 w-3.5" />
          {clearing ? t("clearing") : t("clear")}
        </Button>
      </header>

      {/* cost + volume summary over the current filter */}
      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-5">
          <StatTile
            label={t("summaryCalls")}
            value={compactNumber(summary.calls)}
            hint={summary.failed > 0 ? `${summary.failed} ${t("summaryFailed")}` : undefined}
          />
          <StatTile
            label={t("summaryTokens")}
            value={`${compactNumber(summary.promptTokens)} / ${compactNumber(summary.completionTokens)}`}
          />
          <StatTile
            label={t("summaryCost")}
            value={formatUsd(summary.totalUsd)}
            hint={summary.unpricedCalls > 0 ? t("unpriced", { n: summary.unpricedCalls }) : undefined}
          />
          <StatTile
            label={t("summaryInputCost")}
            value={formatUsd(summary.inputUsd)}
            hint={`${t("summaryOutputCost")} ${formatUsd(summary.outputUsd)}`}
          />
          <StatTile label={t("summaryLatency")} value={summary.latencyMs ? `${(summary.latencyMs / 1000).toFixed(1)}s` : "—"} />
        </div>
      )}

      {/* model-type tabs: the settings-level slots, each with its own spend */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {[{ value: "", key: "all" }, ...MODEL_TYPES].map((entry) => {
          const stat = summary?.byType.find((item) => item.modelType === entry.value);
          const active = modelType === entry.value;
          return (
            <button
              key={entry.value || "all"}
              type="button"
              onClick={() => setModelType(entry.value)}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                active ? "border-primary/60 bg-primary/10 font-medium text-primary" : "border-border/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(entry.key)}
              {entry.value && stat && <span className="tabular-nums opacity-70">{stat.calls}</span>}
            </button>
          );
        })}
      </div>

      {/* filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <LuSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-8 pl-9 text-xs"
          />
        </div>
        <Select
          value={scene}
          onChange={setScene}
          options={[{ value: "", label: t("filterScene") }, ...(facets?.scenes ?? []).map((value) => ({ value, label: value }))]}
        />
        <Select
          value={provider}
          onChange={setProvider}
          options={[{ value: "", label: t("filterProvider") }, ...(facets?.providers ?? []).map((value) => ({ value, label: value }))]}
        />
        <Select
          value={model}
          onChange={setModel}
          options={[{ value: "", label: t("filterModel") }, ...(facets?.models ?? []).map((value) => ({ value, label: value }))]}
        />
        <Select
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: t("filterStatus") },
            { value: "success", label: t("statusSuccess") },
            { value: "failed", label: t("statusFailed") },
          ]}
        />
        <Select value={range} onChange={setRange} options={RANGES.map((entry) => ({ value: entry.value, label: t(entry.key) }))} />
      </div>

      <p className="mb-3 text-[11px] text-muted-foreground">{t("costHint")} {t("retryNote")}</p>

      {loadError && <p className="py-10 text-center text-sm text-destructive">{loadError}</p>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
          <LuLoaderCircle className="h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      ) : items.length === 0 ? (
        <p className="py-24 text-center text-sm text-muted-foreground">{query.toString() ? t("noMatch") : t("empty")}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/50">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="whitespace-nowrap px-3 py-2 font-medium">{t("colTime")}</th>
                <th className="px-3 py-2 font-medium">{t("colType")}</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">{t("colScene")}</th>
                <th className="px-3 py-2 font-medium">{t("colModel")}</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("colInput")}</th>
                <th className="hidden px-3 py-2 font-medium xl:table-cell">{t("colOutput")}</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">{t("colTokens")}</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">{t("colCost")}</th>
                <th className="hidden whitespace-nowrap px-3 py-2 font-medium sm:table-cell">{t("colLatency")}</th>
                <th className="px-3 py-2 font-medium">{t("colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const open = expanded === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      onClick={() => setExpanded(open ? null : row.id)}
                      className="cursor-pointer border-t border-border/40 align-top transition-colors hover:bg-muted/30"
                    >
                      <td className="px-2 py-2 text-muted-foreground">
                        {open ? <LuChevronDown className="h-3.5 w-3.5" /> : <LuChevronRight className="h-3.5 w-3.5" />}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {formatRelativeTime(row.createdAt, locale)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="secondary" className="text-[10px]">{typeLabel(row.modelType)}</Badge>
                      </td>
                      <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">{row.scene || "—"}</td>
                      <td className="max-w-[180px] px-3 py-2">
                        <div className="truncate text-foreground">{row.model}</div>
                        <div className="truncate text-[10px] text-muted-foreground">{row.provider}</div>
                      </td>
                      <td className="hidden max-w-[260px] px-3 py-2 lg:table-cell">
                        <p className="line-clamp-2 text-muted-foreground">{row.request?.summary || "—"}</p>
                      </td>
                      <td className="hidden max-w-[260px] px-3 py-2 xl:table-cell">
                        <p className="line-clamp-2 text-muted-foreground">{row.response?.summary || "—"}</p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">{usageCell(row)}</td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-foreground">
                        {row.cost?.totalUsd != null ? formatUsd(row.cost.totalUsd) : "—"}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground sm:table-cell">
                        {row.latencyMs != null ? `${(row.latencyMs / 1000).toFixed(1)}s` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {row.status === "failed" ? (
                          <span className="flex items-center gap-1 text-destructive">
                            <LuCircleAlert className="h-3 w-3" />
                            {row.httpStatus ?? t("statusFailed")}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{row.httpStatus ?? 200}</span>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-t border-border/40 bg-muted/10">
                        <td colSpan={11} className="px-4 py-3">
                          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{t("endpoint")}: {row.baseUrl ?? ""}{row.endpoint ?? ""}</span>
                            {row.projectId && (
                              <span>
                                {t("project")}:{" "}
                                <Link href={`/project/${row.projectId}/assets`} className="text-primary hover:underline">
                                  {row.projectName || row.projectId.slice(0, 8)}
                                </Link>
                                {row.shotId != null ? ` · ${t("shot", { n: row.shotId })}` : ""}
                              </span>
                            )}
                            {row.taskId && <span>{t("taskId")}: {row.taskId}</span>}
                            {row.streamed && <span>{t("streamed")}</span>}
                            {row.cost?.rateNote && <span>{t("rate")}: {row.cost.rateNote} ({row.cost.source})</span>}
                          </div>
                          {row.error && (
                            <p className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-[11px] text-destructive">
                              {t("error")}: {row.error}
                            </p>
                          )}
                          <div className="grid gap-3 lg:grid-cols-2">
                            <JsonBlock label={t("request")} value={row.request?.detail} />
                            <JsonBlock label={t("response")} value={row.response?.detail} />
                            <JsonBlock label={t("usage")} value={row.usage} />
                            <JsonBlock label={t("cost")} value={row.cost} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          {loadingMore ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
              {t("loading")}
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
  );
}

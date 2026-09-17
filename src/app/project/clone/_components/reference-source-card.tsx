"use client";

import { useEffect, useRef, useState } from "react";
import {
  LuCheck,
  LuFilm,
  LuFolderOpen,
  LuInfo,
  LuLink,
  LuLoaderCircle,
  LuRefreshCw,
  LuScanLine,
  LuUpload,
  LuX,
} from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LibraryVideoPicker, type PickedLibraryVideo } from "@/components/library-video-picker";
import { useT } from "@/lib/i18n";

/**
 * Where the reference clip comes from. Two sources, one analysis: a file the user picks off disk,
 * or a clip already sitting in the asset library — the latter is not copied, it is analysed where
 * it lies. Modelled as one value rather than two pieces of state so choosing one clears the other.
 */
export type RefSource =
  | { kind: "upload"; file: File }
  | { kind: "library"; path: string; label: string; durationSeconds?: number };

/** video = real breakdown of a clip; link = record-only URL that loads the generic structure */
export type RefInputMode = "video" | "link";

const VIDEO_ACCEPT = "video/mp4,video/webm,video/quicktime";

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDuration(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Step 1 of the clone page: ONE card for loading the reference.
 *
 * The two inputs used to sit as unrelated rows with the "load structure" button glued to the
 * link field, which read as if only the link got analysed. They are now two tabs of the same
 * source, with the analyse action in a shared footer that says what THIS source will yield —
 * a real breakdown for a clip, only the generic structure for a link.
 */
export function ReferenceSourceCard({
  mode,
  onModeChange,
  refSource,
  onRefSourceChange,
  videoUrl,
  onVideoUrlChange,
  isAnalyzing,
  onAnalyze,
}: {
  mode: RefInputMode;
  onModeChange: (mode: RefInputMode) => void;
  refSource: RefSource | null;
  onRefSourceChange: (source: RefSource | null) => void;
  videoUrl: string;
  onVideoUrlChange: (url: string) => void;
  isAnalyzing: boolean;
  onAnalyze: () => void;
}) {
  const t = useT("clone");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState("");
  const [probedDuration, setProbedDuration] = useState<number | null>(null);

  // local preview for an uploaded file; library clips are already servable by path.
  // Created and revoked in the same effect so a StrictMode re-run never leaves a dead URL.
  const uploadFile = refSource?.kind === "upload" ? refSource.file : null;
  const [uploadPreview, setUploadPreview] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!uploadFile) return;
    const url = URL.createObjectURL(uploadFile);
    queueMicrotask(() => setUploadPreview({ file: uploadFile, url }));
    return () => URL.revokeObjectURL(url);
  }, [uploadFile]);
  const previewSrc = refSource
    ? refSource.kind === "upload"
      ? uploadPreview?.file === refSource.file ? uploadPreview.url : null
      : refSource.path
    : null;

  const pickFile = (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      setDropError(t("dropInvalid"));
      return;
    }
    setDropError("");
    setProbedDuration(null);
    onRefSourceChange({ kind: "upload", file });
  };

  const ready = mode === "video" ? Boolean(refSource) : Boolean(videoUrl.trim());
  const footerHint = mode === "video"
    ? (refSource ? t("analyzeVideoHint") : t("analyzeVideoEmpty"))
    : (videoUrl.trim() ? t("analyzeLinkHint") : t("analyzeLinkEmpty"));

  const tabs: { id: RefInputMode; icon: React.ReactNode; label: string; badge?: string }[] = [
    { id: "video", icon: <LuFilm className="size-4" />, label: t("sourceTabVideo"), badge: t("sourceTabVideoBadge") },
    { id: "link", icon: <LuLink className="size-4" />, label: t("sourceTabLink") },
  ];

  const duration = refSource?.kind === "library" ? refSource.durationSeconds ?? probedDuration : probedDuration;

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-border/60 bg-background/30">
        {/* source switch */}
        <div role="tablist" aria-label={t("step1Title")} className="grid grid-cols-2 border-b border-border/60 bg-muted/20 p-1">
          {tabs.map((tab) => {
            const selected = mode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onModeChange(tab.id)}
                className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                  selected ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.icon}
                {tab.label}
                {tab.badge && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${selected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="p-4 sm:p-5">
          <input
            ref={fileInputRef}
            type="file"
            accept={VIDEO_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              pickFile(f);
            }}
          />
          <LibraryVideoPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onPick={(video: PickedLibraryVideo) => {
              setDropError("");
              setProbedDuration(null);
              onRefSourceChange({ kind: "library", path: video.url, label: video.label, durationSeconds: video.durationSeconds });
            }}
          />

          {mode === "video" && !refSource && (
            <div
              className={`flex flex-col items-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
                dragging ? "border-primary bg-primary/5" : "border-border/60"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files?.[0]);
              }}
            >
              <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <LuFilm className="size-6" />
              </div>
              <p className="text-sm font-medium">{t("dropTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("dropFormat")}</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                  <LuUpload />
                  {t("refVideoBtn")}
                </Button>
                <Button variant="outline" onClick={() => setPickerOpen(true)}>
                  <LuFolderOpen />
                  {t("refLibraryBtn")}
                </Button>
              </div>
              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                {[t("capCuts"), t("capRhythm"), t("capFrames")].map((cap) => (
                  <span key={cap} className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                    <LuCheck className="size-3 text-primary" />
                    {cap}
                  </span>
                ))}
              </div>
              {dropError && <p className="mt-3 text-xs text-destructive">{dropError}</p>}
            </div>
          )}

          {mode === "video" && refSource && (
            <div className="flex gap-4 rounded-xl border border-primary/30 bg-primary/5 p-3">
              <div className="relative aspect-[9/16] w-20 shrink-0 overflow-hidden rounded-lg bg-black sm:w-24">
                {previewSrc && (
                  <video
                    key={previewSrc}
                    src={previewSrc}
                    muted
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover"
                    onLoadedMetadata={(e) => {
                      const d = e.currentTarget.duration;
                      if (Number.isFinite(d)) setProbedDuration(d);
                    }}
                    onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
                    onMouseLeave={(e) => e.currentTarget.pause()}
                  />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium" title={refSource.kind === "upload" ? refSource.file.name : refSource.label}>
                      {refSource.kind === "upload" ? refSource.file.name : refSource.label}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1 rounded-full bg-background/70 px-2 py-0.5">
                        {refSource.kind === "upload" ? <LuUpload className="size-3" /> : <LuFolderOpen className="size-3" />}
                        {refSource.kind === "upload" ? t("sourceUpload") : t("sourceLibrary")}
                      </span>
                      {duration != null && <span className="tabular-nums">{formatDuration(duration)}</span>}
                      {refSource.kind === "upload" && <span className="tabular-nums">{formatSize(refSource.file.size)}</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={t("removeSource")}
                    title={t("removeSource")}
                    onClick={() => {
                      setProbedDuration(null);
                      onRefSourceChange(null);
                    }}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <LuX className="size-4" />
                  </button>
                </div>
                <div className="mt-auto flex flex-wrap gap-2 pt-3">
                  <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                    <LuRefreshCw />
                    {t("refVideoReplace")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                    <LuFolderOpen />
                    {t("refLibraryBtn")}
                  </Button>
                </div>
                {dropError && <p className="mt-2 text-xs text-destructive">{dropError}</p>}
              </div>
            </div>
          )}

          {mode === "link" && (
            <div className="space-y-3">
              <div className="relative">
                <LuLink className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="video-url"
                  aria-label={t("sourceTabLink")}
                  placeholder={t("videoUrlPlaceholder")}
                  value={videoUrl}
                  onChange={(e) => onVideoUrlChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && videoUrl.trim() && !isAnalyzing) onAnalyze();
                  }}
                  className="h-11 pl-9"
                />
              </div>
              <div className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                <LuInfo className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <p>
                  {t("linkNote")}{" "}
                  <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => onModeChange("video")}>
                    {t("linkSwitchToVideo")}
                  </button>
                </p>
              </div>
            </div>
          )}
        </div>

        {/* the analyse action belongs to the whole source, and says what this source will yield */}
        <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className={`flex items-center gap-2 text-xs ${ready ? "text-foreground/80" : "text-muted-foreground"}`}>
            <LuScanLine className={`size-4 shrink-0 ${ready ? "text-primary" : ""}`} />
            {footerHint}
          </p>
          <Button className="brand-gradient shrink-0 text-white" disabled={!ready || isAnalyzing} onClick={onAnalyze}>
            {isAnalyzing ? <LuLoaderCircle className="animate-spin" /> : <LuScanLine />}
            {isAnalyzing ? t("analyzing") : t("analyze")}
          </Button>
        </div>
      </div>
      <p className="text-xs text-amber-600/90">{t("copyrightNote")}</p>
    </div>
  );
}

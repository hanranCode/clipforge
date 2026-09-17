"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import {
  CUT_THRESHOLD_MAX,
  CUT_THRESHOLD_MIN,
  MIN_SHOT_GAP_SEC,
  isStageStale,
  mergeWithNext,
  moveCut,
  sameCuts,
  shotContains,
  shotsFromCuts,
  splitAt,
  type FrameSlot,
  type ReferenceAnalysisView,
  type ShotFrames,
} from "@/lib/reference-analysis";

type PanelStage = "ingest" | "cuts" | "frames";

const sec = (v: number) => `${v.toFixed(1)}s`;
const pct = (v: number, total: number) => `${Math.min(100, Math.max(0, (v / total) * 100))}%`;

const SLOT_KEY: Record<FrameSlot, string> = {
  first: "slotFirst",
  mid: "slotMid",
  last: "slotLast",
  custom: "slotCustom",
};

/**
 * The viral-video breakdown, one stage at a time (docs/reference-analysis-workflow.md).
 *
 * Left: the stage rail — status, time taken, cost. Right: the selected stage's data, editable in
 * place. Every edit goes to the stage's own route and the full stored breakdown comes back, so the
 * parent's copy (which feeds script generation) is always what the server holds.
 *
 * Batch 1 covers S0–S2, which are pure ffmpeg: nothing here spends model credits.
 */
export function ReferenceAnalysisPanel({
  analysis,
  onChange,
}: {
  analysis: ReferenceAnalysisView;
  onChange: (next: ReferenceAnalysisView) => void;
}) {
  const t = useT("referenceAnalysis");
  const { analysisId, ingest, cuts, frames, staleFrom, duration } = analysis;

  const [stage, setStage] = useState<PanelStage>("cuts");
  const [cutsBusy, setCutsBusy] = useState(false);
  const [framesBusy, setFramesBusy] = useState(false);
  const [framesFailed, setFramesFailed] = useState(false);
  const [error, setError] = useState("");
  const [playhead, setPlayhead] = useState(0);
  const [selectedShot, setSelectedShot] = useState(1);
  const [threshold, setThreshold] = useState(cuts?.threshold ?? 0.22);
  // cuts while a marker is being dragged; committed on release
  const [dragCuts, setDragCuts] = useState<number[] | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const post = useCallback(
    async (url: string, body: Record<string, unknown>): Promise<boolean> => {
      setError("");
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ analysisId, ...body }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t("requestFailed"));
        onChange(data as ReferenceAnalysisView);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : t("requestFailed"));
        return false;
      }
    },
    [analysisId, onChange, t]
  );

  const runFrames = useCallback(async () => {
    setFramesBusy(true);
    setFramesFailed(false);
    const ok = await post("/api/replicate/analyze/frames", {});
    setFramesFailed(!ok);
    setFramesBusy(false);
  }, [post]);

  // key frames are free and quick: take them as soon as a new breakdown arrives
  const autoRan = useRef<string | null>(null);
  useEffect(() => {
    if (autoRan.current === analysisId) return;
    autoRan.current = analysisId;
    setThreshold(cuts?.threshold ?? 0.22);
    setSelectedShot(1);
    if (!frames) void runFrames();
    // only a new breakdown should trigger this, not every edit of the current one
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId]);

  const saveCuts = useCallback(
    async (next: number[]) => {
      if (!cuts || sameCuts(next, cuts.cuts)) return;
      setCutsBusy(true);
      await post("/api/replicate/analyze/cut", { cuts: next });
      setCutsBusy(false);
    },
    [cuts, post]
  );

  const redetect = useCallback(
    async (value: number) => {
      setCutsBusy(true);
      await post("/api/replicate/analyze/cut", { threshold: value });
      setCutsBusy(false);
    },
    [post]
  );

  const seek = (time: number) => {
    if (videoRef.current) videoRef.current.currentTime = time;
    setPlayhead(time);
  };

  const shownCuts = dragCuts ?? cuts?.cuts ?? [];
  const shownShots = shotsFromCuts(shownCuts, duration);
  const current = shownShots.find((s) => s.index === selectedShot) ?? shownShots[0];
  const framesStale = isStageStale("frames", staleFrom);

  // ---- timeline drag: pointer events on each cut marker, committed on release ----
  const timeAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return ((clientX - rect.left) / rect.width) * duration;
  };
  const dragIndex = useRef<number | null>(null);
  // the latest dragged position, readable on release even if the last move hasn't rendered yet
  const dragLatest = useRef<number[] | null>(null);
  const setDrag = (next: number[] | null) => {
    dragLatest.current = next;
    setDragCuts(next);
  };

  const rail: { key: PanelStage; label: string; status: string; tone: string; detail: string[] }[] = [
    {
      key: "ingest",
      label: t("stageIngest"),
      status: t("statusDone"),
      tone: "text-emerald-600",
      detail: [sec(ingest.duration), `${ingest.width}×${ingest.height}`],
    },
    {
      key: "cuts",
      label: t("stageCuts"),
      status: cutsBusy ? t("statusRunning") : t("statusDone"),
      tone: cutsBusy ? "text-primary" : "text-emerald-600",
      detail: cuts
        ? [t("shotsCount", { n: cuts.shots.length }), ...(cuts.edited ? [t("edited")] : []), t("took", { sec: (cuts.durationMs / 1000).toFixed(1) })]
        : [],
    },
    {
      key: "frames",
      label: t("stageFrames"),
      status: framesBusy
        ? t("statusRunning")
        : framesFailed && !frames
        ? t("statusFailed")
        : !frames
        ? t("statusPending")
        : framesStale
        ? t("statusStale")
        : t("statusDone"),
      tone: framesBusy
        ? "text-primary"
        : framesFailed && !frames
        ? "text-destructive"
        : !frames
        ? "text-muted-foreground"
        : framesStale
        ? "text-amber-600"
        : "text-emerald-600",
      detail: frames ? [t("took", { sec: (frames.durationMs / 1000).toFixed(1) })] : [],
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-[176px_minmax(0,1fr)]">
      {/* stage rail */}
      <nav className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible">
        {rail.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setStage(item.key)}
            className={`min-w-36 shrink-0 rounded-lg border px-3 py-2 text-left transition-colors md:min-w-0 ${
              stage === item.key ? "border-primary/60 bg-primary/5" : "border-border/60 hover:border-primary/40"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{item.label}</span>
              <span className={`text-[11px] ${item.tone}`}>{item.status}</span>
            </div>
            {item.detail.length > 0 && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">{item.detail.join(" · ")}</div>
            )}
            <div className="text-[10px] text-muted-foreground/70">{t("free")}</div>
          </button>
        ))}
      </nav>

      <div className="min-w-0 space-y-3">
        {/* one player for every stage: it is the playhead that splits and grabs work from */}
        <video
          ref={videoRef}
          src={analysis.path}
          controls
          preload="metadata"
          className="mx-auto max-h-72 w-full rounded-lg bg-black object-contain"
          onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
          onSeeked={(e) => setPlayhead(e.currentTarget.currentTime)}
        />

        {error && <p className="text-xs text-destructive">{error}</p>}

        {stage === "ingest" && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            {[
              [t("metaDuration"), sec(ingest.duration)],
              [t("metaResolution"), `${ingest.width}×${ingest.height}`],
              [t("metaFrameRate"), `${Math.round(ingest.frameRate * 100) / 100} fps`],
              [
                t("metaOrientation"),
                t(
                  ingest.orientation === "portrait"
                    ? "orientationPortrait"
                    : ingest.orientation === "landscape"
                    ? "orientationLandscape"
                    : "orientationSquare"
                ),
              ],
              [t("metaAudio"), ingest.hasAudio ? t("audioYes") : t("audioNo")],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        )}

        {stage === "cuts" && cuts && current && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t("timelineHint")}</p>
            <div
              ref={barRef}
              className={`relative h-11 select-none overflow-hidden rounded-md bg-muted touch-none ${cutsBusy ? "opacity-60" : ""}`}
            >
              {shownShots.map((s) => (
                <button
                  key={s.index}
                  type="button"
                  onClick={() => {
                    setSelectedShot(s.index);
                    seek(s.start);
                  }}
                  className={`absolute top-0 h-full border-r border-background/40 text-[11px] font-medium transition-colors ${
                    s.index === current.index
                      ? "bg-primary/30 text-foreground"
                      : s.index % 2
                      ? "bg-primary/10 text-muted-foreground"
                      : "bg-primary/5 text-muted-foreground"
                  }`}
                  style={{ left: pct(s.start, duration), width: pct(s.duration, duration) }}
                >
                  {s.duration >= duration * 0.04 ? s.index : ""}
                </button>
              ))}
              {shownCuts.map((c, i) => (
                <div
                  key={i}
                  role="slider"
                  tabIndex={cutsBusy ? -1 : 0}
                  aria-label={t("cutSliderLabel", { n: i + 1 })}
                  aria-valuemin={0}
                  aria-valuemax={duration}
                  aria-valuenow={c}
                  aria-valuetext={sec(c)}
                  className="group absolute top-0 z-10 flex h-full w-3 -translate-x-1/2 cursor-ew-resize justify-center outline-none"
                  style={{ left: pct(c, duration) }}
                  onPointerDown={(e) => {
                    if (cutsBusy) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    dragIndex.current = i;
                    setDrag([...cuts.cuts]);
                  }}
                  onPointerMove={(e) => {
                    if (dragIndex.current !== i) return;
                    setDrag(moveCut(dragLatest.current ?? cuts.cuts, i, timeAt(e.clientX), duration));
                  }}
                  onPointerUp={() => {
                    if (dragIndex.current !== i) return;
                    dragIndex.current = null;
                    const next = dragLatest.current;
                    setDrag(null);
                    if (next) void saveCuts(next);
                  }}
                  onKeyDown={(e) => {
                    if (cutsBusy || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                    e.preventDefault();
                    void saveCuts(moveCut(cuts.cuts, i, c + (e.key === "ArrowLeft" ? -0.1 : 0.1), duration));
                  }}
                >
                  <div className="h-full w-0.5 bg-primary group-hover:w-1 group-focus-visible:w-1" />
                </div>
              ))}
              <div
                className="pointer-events-none absolute top-0 z-20 h-full w-px bg-amber-500"
                style={{ left: pct(playhead, duration) }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">
                {t("shotRange", {
                  n: current.index,
                  from: sec(current.start),
                  to: sec(current.start + current.duration),
                  dur: sec(current.duration),
                })}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={
                  cutsBusy ||
                  !(playhead > current.start + MIN_SHOT_GAP_SEC && playhead < current.start + current.duration - MIN_SHOT_GAP_SEC)
                }
                title={t("splitHint")}
                onClick={() => void saveCuts(splitAt(cuts.cuts, playhead, duration))}
              >
                {t("splitAtPlayhead")}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={cutsBusy || current.index >= shownShots.length}
                onClick={() => void saveCuts(mergeWithNext(cuts.cuts, current.index))}
              >
                {t("mergeNext")}
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
              <label className="flex min-w-0 flex-1 items-center gap-3 text-xs text-muted-foreground">
                <span className="shrink-0">{t("thresholdLabel", { value: threshold.toFixed(2) })}</span>
                <input
                  type="range"
                  min={CUT_THRESHOLD_MIN}
                  max={CUT_THRESHOLD_MAX}
                  step={0.02}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="min-w-24 flex-1 accent-primary"
                />
              </label>
              <Button size="xs" variant="outline" disabled={cutsBusy} onClick={() => void redetect(threshold)}>
                {t("redetect")}
              </Button>
              {cuts.edited && (
                <Button size="xs" variant="ghost" disabled={cutsBusy} onClick={() => void redetect(cuts.threshold)}>
                  {t("resetDetect")}
                </Button>
              )}
            </div>
          </div>
        )}

        {stage === "frames" && (
          <div className="space-y-3">
            {framesStale && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <span className="flex-1">{t("framesStale")}</span>
                <Button size="xs" variant="outline" disabled={framesBusy} onClick={() => void runFrames()}>
                  {t("rerunFrames")}
                </Button>
              </div>
            )}
            {framesBusy && <p className="text-xs text-primary">{t("framesRunning")}</p>}
            {!frames && !framesBusy && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{t("framesEmpty")}</span>
                <Button size="xs" variant="outline" onClick={() => void runFrames()}>
                  {t("runFrames")}
                </Button>
              </div>
            )}
            {frames && (
              <div className={`space-y-3 ${framesStale ? "opacity-60" : ""}`}>
                {frames.contactSheet && (
                  <details className="rounded-lg border border-border/60 px-3 py-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">{t("contactSheet")}</summary>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={frames.contactSheet} alt={t("contactSheet")} className="mt-2 w-full rounded" />
                  </details>
                )}
                {frames.shots.map((shot) => (
                  <ShotFramesRow
                    key={`${frames.runId}-${shot.index}`}
                    shot={shot}
                    portrait={ingest.orientation === "portrait"}
                    playhead={playhead}
                    onSeek={seek}
                    onPick={(representative) =>
                      post("/api/replicate/analyze/frames", { shotIndex: shot.index, representative })
                    }
                    onGrab={() => post("/api/replicate/analyze/frames", { shotIndex: shot.index, time: playhead })}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ShotFramesRow({
  shot,
  portrait,
  playhead,
  onSeek,
  onPick,
  onGrab,
}: {
  shot: ShotFrames;
  portrait: boolean;
  playhead: number;
  onSeek: (time: number) => void;
  onPick: (representative: number) => Promise<boolean>;
  onGrab: () => Promise<boolean>;
}) {
  const t = useT("referenceAnalysis");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className="font-medium hover:text-primary" onClick={() => onSeek(shot.start)}>
          {t("shotRange", {
            n: shot.index,
            from: sec(shot.start),
            to: sec(shot.start + shot.duration),
            dur: sec(shot.duration),
          })}
        </button>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          disabled={busy || !shotContains(shot, playhead)}
          title={t("grabHint")}
          onClick={() => void run(onGrab)}
        >
          {t("grabAtPlayhead")}
        </Button>
      </div>
      <div className={`flex gap-2 overflow-x-auto p-1 ${busy ? "opacity-60" : ""}`}>
        {shot.frames.map((frame, i) => {
          const chosen = i === shot.representative;
          return (
            <button
              key={frame.url}
              type="button"
              disabled={busy || chosen}
              title={chosen ? t("representative") : t("pickRepresentative")}
              onClick={() => void run(() => onPick(i))}
              className={`relative shrink-0 overflow-hidden rounded-md bg-black ring-offset-2 ring-offset-background ${
                portrait ? "aspect-[9/16] w-20" : "aspect-video w-32"
              } ${chosen ? "ring-2 ring-primary" : "opacity-80 hover:opacity-100"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={frame.url} alt="" className="h-full w-full object-cover" loading="lazy" />
              <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-[10px] text-white">
                {t(SLOT_KEY[frame.slot])} · {sec(frame.time)}
              </span>
              {chosen && (
                <Badge className="absolute left-1 top-1 h-4 px-1 text-[9px]">{t("representative")}</Badge>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

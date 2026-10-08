"use client";

import { useEffect, useRef, useState } from "react";
import type { RemakeSegment, TimeSpan } from "@/lib/remake/plan";

/* eslint-disable @next/next/no-img-element -- filmstrip frames are data URLs drawn in the browser */

const FRAME_COUNT = 14;

/** "1:05.3" for the ruler and readouts */
export function formatClock(seconds: number, precise = false): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${(precise ? rest.toFixed(1) : String(Math.floor(rest))).padStart(precise ? 4 : 2, "0")}`;
}

/**
 * Grab evenly spaced frames from a same-origin clip with an offscreen <video> + canvas. Runs once per
 * source; a failure leaves the strip empty rather than blocking the timeline.
 */
function useFilmstrip(src: string, duration: number): string[] {
  const [frames, setFrames] = useState<{ src: string; list: string[] }>({ src: "", list: [] });
  useEffect(() => {
    if (!src || !(duration > 0)) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = src;
    const canvas = document.createElement("canvas");
    const seek = (t: number) =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          video.removeEventListener("seeked", done);
          resolve();
        };
        video.addEventListener("seeked", done);
        video.addEventListener("error", () => reject(new Error("seek")), { once: true });
        video.currentTime = t;
      });
    (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadeddata", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error("load")), { once: true });
        });
        const h = 72;
        const w = Math.max(1, Math.round((video.videoWidth / Math.max(1, video.videoHeight)) * h));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        const list: string[] = [];
        for (let i = 0; i < FRAME_COUNT; i++) {
          if (cancelled) return;
          await seek(((i + 0.5) / FRAME_COUNT) * duration);
          ctx?.drawImage(video, 0, 0, w, h);
          list.push(canvas.toDataURL("image/jpeg", 0.6));
          if (!cancelled) setFrames({ src, list: [...list] });
        }
      } catch {
        /* strip stays empty */
      } finally {
        video.removeAttribute("src");
        video.load();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, duration]);
  return frames.src === src ? frames.list : [];
}

export interface TimelineMark extends TimeSpan {
  id: string;
  label: string;
}

/**
 * The remake timeline: filmstrip, second ruler, segment bands, edit ranges and the playhead. Click
 * seeks the player; drag selects a range that an edit can then be pinned to.
 */
export function VideoTimeline({
  src,
  duration,
  currentTime,
  segments,
  marks,
  selection,
  onSeek,
  onSelect,
}: {
  src: string;
  duration: number;
  currentTime: number;
  segments: RemakeSegment[];
  marks: TimelineMark[];
  selection: TimeSpan | null;
  onSeek: (time: number) => void;
  onSelect: (span: TimeSpan | null) => void;
}) {
  const frames = useFilmstrip(src, duration);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ from: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState<TimeSpan | null>(null);

  const pct = (t: number) => `${(Math.min(duration, Math.max(0, t)) / duration) * 100}%`;
  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration * 10) / 10;
  };

  const step = duration > 120 ? 30 : duration > 60 ? 10 : duration > 20 ? 5 : 2;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 0.001; t += step) ticks.push(t);
  const shown = draft ?? selection;

  return (
    <div className="select-none space-y-1">
      <div
        ref={trackRef}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={currentTime}
        tabIndex={0}
        className="relative h-[72px] cursor-pointer touch-none overflow-hidden rounded-lg border border-border/60 bg-muted/30"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") onSeek(Math.min(duration, currentTime + 1));
          if (e.key === "ArrowLeft") onSeek(Math.max(0, currentTime - 1));
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { from: timeAt(e.clientX), moved: false };
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          const t = timeAt(e.clientX);
          if (Math.abs(t - drag.from) >= 0.3) drag.moved = true;
          if (drag.moved) setDraft({ start: Math.min(drag.from, t), end: Math.max(drag.from, t) });
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag) return;
          const t = timeAt(e.clientX);
          setDraft(null);
          if (drag.moved) onSelect({ start: Math.min(drag.from, t), end: Math.max(drag.from, t) });
          else onSeek(t);
        }}
      >
        {/* filmstrip */}
        <div className="absolute inset-0 flex">
          {Array.from({ length: FRAME_COUNT }, (_, i) => (
            <div key={i} className="h-full flex-1 overflow-hidden border-r border-background/40 last:border-r-0">
              {frames[i] && <img src={frames[i]} alt="" className="h-full w-full object-cover opacity-80" draggable={false} />}
            </div>
          ))}
        </div>
        {/* segment seams */}
        {segments.slice(1).map((s) => (
          <div key={s.index} className="absolute inset-y-0 w-0.5 bg-amber-400/90" style={{ left: pct(s.start) }} />
        ))}
        {/* selection */}
        {shown && (
          <div
            className="absolute inset-y-0 border-x-2 border-primary bg-primary/25"
            style={{ left: pct(shown.start), width: `calc(${pct(shown.end)} - ${pct(shown.start)})` }}
          />
        )}
        {/* playhead */}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" style={{ left: pct(currentTime) }} />
      </div>

      {/* edit ranges */}
      {marks.length > 0 && (
        <div className="relative h-4">
          {marks.map((m) => (
            <div
              key={m.id}
              title={m.label}
              className="absolute top-0.5 h-3 truncate rounded-sm bg-primary/70 px-1 text-[9px] leading-3 text-primary-foreground"
              style={{ left: pct(m.start), width: `calc(${pct(m.end)} - ${pct(m.start)})` }}
            >
              {m.label}
            </div>
          ))}
        </div>
      )}

      {/* ruler */}
      <div className="relative h-4 text-[10px] tabular-nums text-muted-foreground">
        {ticks.map((t) => (
          <span key={t} className={`absolute ${t === 0 ? "" : "-translate-x-1/2"}`} style={{ left: pct(t) }}>
            {formatClock(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useState, type Ref } from "react";
import type { LibrarySegment } from "@/lib/asset-library";
import { useT } from "@/lib/i18n";

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Player for a video that was produced in segments: plays the full video by default, with a row of
 * tabs to switch to any single segment. Without segments it is a plain <video>.
 */
export function SegmentedVideo({
  url,
  segments,
  poster,
  videoRef,
  className = "w-full",
}: {
  url: string;
  segments?: LibrarySegment[] | null;
  poster?: string;
  videoRef?: Ref<HTMLVideoElement>;
  className?: string;
}) {
  const t = useT("assetLibrary");
  const [active, setActive] = useState<number | null>(null);
  const parts = segments && segments.length > 1 ? segments : null;
  const current = parts && active != null ? parts.find((p) => p.index === active) : undefined;
  const src = current?.url ?? url;

  return (
    <div>
      <video key={src} ref={videoRef} src={src} controls playsInline poster={current ? undefined : poster} className={className} />
      {parts && (
        <div role="tablist" aria-label={t("segmentsLabel")} className="flex flex-wrap gap-1.5 border-t border-border/50 p-2">
          <SegmentTab selected={!current} onClick={() => setActive(null)}>
            {t("segmentFull")}
          </SegmentTab>
          {parts.map((part) => (
            <SegmentTab key={part.index} selected={current?.index === part.index} onClick={() => setActive(part.index)}>
              {t("segmentN", { n: part.index + 1 })}
              <span className="ml-1 font-mono opacity-70">
                {clock(part.start)}–{clock(part.end)}
              </span>
              {!part.edited && <span className="ml-1 opacity-70">· {t("segmentOriginal")}</span>}
            </SegmentTab>
          ))}
        </div>
      )}
    </div>
  );
}

function SegmentTab({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
        selected ? "border-primary bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

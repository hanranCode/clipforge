"use client";

import { useEffect, useState } from "react";
import { LuListTodo, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { useT } from "@/lib/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface QueueTask {
  /** Stable identity across renders — drives the "running for Ns" clock. */
  key: string;
  title: string;
  detail?: string;
  /** 0–100 when the task reports real progress. */
  progress?: number;
  /** waiting = submitted to the cloud but the result was never retrieved (needs the user). */
  tone?: "running" | "waiting";
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Floating task queue on the right edge of the assets page: a live count of what this
 * page has in flight (keyframes, motion shots, uploads, batch/grid/film runs) and a
 * panel with a one-line description of each. The page owns the state; this only renders it.
 */
export function TaskQueue({ tasks }: { tasks: QueueTask[] }) {
  const t = useT("assets");
  const running = tasks.filter((task) => task.tone !== "waiting");
  const waiting = tasks.filter((task) => task.tone === "waiting");

  // first time each task key was seen — tasks are derived from page state, so the queue
  // keeps its own clock instead of threading start times through every setter. Stamped
  // from a timer (never during render) while anything runs; only this small component re-renders.
  const liveKeys = running.map((task) => task.key).join("|");
  const [clock, setClock] = useState<{ now: number; startedAt: Record<string, number> }>({ now: 0, startedAt: {} });
  useEffect(() => {
    if (!liveKeys) return;
    const tick = () =>
      setClock((prev) => {
        const now = Date.now();
        const startedAt: Record<string, number> = {};
        for (const key of liveKeys.split("|")) startedAt[key] = prev.startedAt[key] ?? now;
        return { now, startedAt };
      });
    const kickoff = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }, [liveKeys]);

  const renderRow = (task: QueueTask) => {
    const since = clock.startedAt[task.key];
    const now = clock.now;
    const waitingTone = task.tone === "waiting";
    return (
      <div
        key={task.key}
        className={`rounded-lg px-2.5 py-2 ${waitingTone ? "border border-amber-500/40 bg-amber-500/10" : "bg-muted/30"}`}
      >
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {waitingTone ? (
            <LuTriangleAlert className="h-3 w-3 shrink-0 text-amber-500" />
          ) : (
            <LuLoaderCircle className="h-3 w-3 shrink-0 animate-spin text-primary" />
          )}
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          {!waitingTone && since !== undefined && now >= since && (
            <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{formatElapsed(now - since)}</span>
          )}
        </div>
        {task.detail && <p className="mt-0.5 truncate pl-[18px] text-[11px] text-muted-foreground">{task.detail}</p>}
        {task.progress !== undefined && (
          <div className="ml-[18px] mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${task.progress}%` }} />
          </div>
        )}
      </div>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("queueTitle")}
        title={t("queueTitle")}
        className={`fixed right-4 top-1/3 z-40 flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-[11px] shadow-lg backdrop-blur transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          running.length > 0
            ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
            : "border-border/60 bg-background/80 text-muted-foreground hover:text-foreground"
        }`}
      >
        <span className="relative">
          {running.length > 0 ? <LuLoaderCircle className="h-4 w-4 animate-spin" /> : <LuListTodo className="h-4 w-4" />}
          {waiting.length > 0 && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-500" />}
        </span>
        <span className="text-sm font-semibold tabular-nums leading-none">{running.length}</span>
        <span className="leading-none [writing-mode:vertical-rl]">{t("queueShort")}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="left" align="start" sideOffset={8} className="w-80 p-2">
        <div className="max-h-96 space-y-2 overflow-y-auto">
          <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
            {t("queueRunning", { n: running.length })}
          </p>
          {running.length > 0 ? (
            <div className="space-y-1">{running.map(renderRow)}</div>
          ) : (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t("queueEmpty")}</p>
          )}
          {waiting.length > 0 && (
            <div className="space-y-1">
              <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-amber-500/80">
                {t("queueWaiting", { n: waiting.length })}
              </p>
              {waiting.map(renderRow)}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

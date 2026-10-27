"use client";
import { useCallback, useEffect, useState } from "react";
import { LuFilm, LuCircleCheck, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import type { WorkStatus } from "@/lib/agent-studio/types";
export async function studioApi<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`/api/agent-studio/${path}`, { method: body === undefined ? "GET" : method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || String(response.status)); return data;
}
export function useStudioData<T>(path: string, interval = 3000) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState("");
  const refresh = useCallback(async () => { try { setData(await studioApi<T>(path)); setError(""); } catch(e) { setError(e instanceof Error ? e.message : String(e)); } }, [path]);
  useEffect(() => { const first = setTimeout(() => void refresh(), 0); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, interval); return () => { clearTimeout(first); clearInterval(timer); }; }, [refresh, interval]);
  return { data, error, refresh };
}
export function StatusBadge({ status }: { status: WorkStatus }) {
  const t = useT("agentStudio"); const running = ["queued", "planning", "generating"].includes(status);
  const color = status === "completed" ? "bg-emerald-50 text-emerald-700 border-emerald-100" : status === "attention" ? "bg-red-50 text-red-700 border-red-100" : status === "review" ? "bg-amber-50 text-amber-800 border-amber-100" : running ? "bg-indigo-50 text-indigo-700 border-indigo-100" : "bg-slate-50 text-slate-600 border-slate-200";
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${color}`}>{running ? <LuLoaderCircle className="size-3 animate-spin" /> : status === "completed" ? <LuCircleCheck className="size-3" /> : status === "attention" ? <LuTriangleAlert className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}{t(status)}</span>;
}
export function RuntimeDot({ connected }: { connected: boolean }) { return <span className={`inline-block size-2 shrink-0 rounded-full ${connected ? "bg-emerald-500 shadow-[0_0_0_3px_#ecfdf5]" : "bg-slate-300"}`} />; }
export const fieldClass = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-50";

export function HypitEditorActions({ url, busy, onStart }: { url?: string; busy: boolean; onStart: () => void }) {
  const t = useT("agentStudio");
  return <>{url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600"><LuFilm />{t("hypitEdit")}</a>}<Button variant="outline" disabled={busy} onClick={onStart}><LuFilm />{t(url ? "hypitRestart" : "hypitStart")}</Button></>;
}

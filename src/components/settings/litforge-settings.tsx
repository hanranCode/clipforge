"use client";
import { useState } from "react";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export function LitforgeSettings() {
  const t = useT("settings"), store = useSettingsStore();
  const value = store.providers.litforge ?? { enabled: false, apiKey: "" };
  const [status, setStatus] = useState<{ configured: boolean; storageConfigured: boolean; tasks: { taskId: string; status: string; legacy: boolean; href?: string }[] }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = async () => {
    setBusy(true);
    try { const r = await fetch("/api/litforge"); if (!r.ok) throw new Error(); setStatus(await r.json()); setMessage(""); } catch { setMessage(t("connectFailed")); } finally { setBusy(false); }
  };
  const operation = async (taskId: string, operation: string) => {
    setBusy(true);
    try {
      const response = await fetch("/api/litforge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId, operation }) });
      if (!response.ok) throw new Error();
      await refresh();
    } catch { setMessage(t("connectFailed")); } finally { setBusy(false); }
  };
  return <Card><CardContent className="space-y-3 p-5">
    <div className="flex items-center justify-between gap-4"><h3 className="text-sm font-semibold">LitForge · {t("litforgeCustom")}</h3><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={value.enabled} onChange={e => store.setProvider("litforge", { ...value, enabled: e.target.checked })} />{t("providerEnabled")}</label></div>
    <p className="text-xs leading-6 text-muted-foreground">{t("litforgeDescription")}</p>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>{t("litforgeCheck")}</Button>
    {message && <p role="status" className="text-xs text-amber-700">{message}</p>}
    {status && <div className="space-y-2 text-xs"><p>{t("litforgeCaller")}: {t(status.configured ? "storageLocalReady" : "storageLocalMissing")} · {t("tabStorage")}: {t(status.storageConfigured ? "storageLocalReady" : "storageLocalMissing")}</p>
      <p className="text-muted-foreground">{t("litforgeCheckHint")}</p>
      {status.tasks.map(task => <div key={task.taskId} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2"><span className="min-w-0 break-all font-mono">{task.taskId} · {task.status}</span><div className="flex flex-wrap items-center gap-2">{task.href && <a className="underline" href={task.href}>{t("litforgeOriginalTask")}</a>}<Button size="sm" variant="ghost" disabled={busy} onClick={() => void operation(task.taskId, "status")}>{t("litforgeQuery")}</Button>{!["completed", "failed", "cancelled"].includes(task.status) && <><Button size="sm" variant="ghost" disabled={busy} onClick={() => void operation(task.taskId, "refresh")}>{t("litforgeRefreshOutput")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void operation(task.taskId, "cancel")}>{t("litforgeCancel")}</Button></>}</div></div>)}
    </div>}
  </CardContent></Card>;
}

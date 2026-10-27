"use client";
import { useCallback, useEffect, useState } from "react";
import { SuperResolutionPanel } from "@/components/agent-studio/super-resolution-panel";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import type { SuperResolutionTask } from "@/lib/agent-studio/types";
import type { upscaleCapability } from "@/lib/agent-studio/upscale-options";

interface Snapshot {
  tasks: SuperResolutionTask[];
  configured: boolean;
  storageConfigured: boolean;
  capability: ReturnType<typeof upscaleCapability>;
}
export function RemakeSuperResolution({ assetId, onPreview }: { assetId: string; onPreview: (url: string | null) => void }) {
  const t = useT("agentStudio");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState("");
  const endpoint = `/api/remake/upscale/${encodeURIComponent(assetId)}`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal }), data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upscale status unavailable");
      if (!signal?.aborted) { setSnapshot(data); setError(""); }
    } catch (error) { if (!signal?.aborted) setError((error as Error).message); }
  }, [endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  return <div className="overflow-hidden rounded-lg border border-border/60">
    {snapshot && <SuperResolutionPanel endpoint={endpoint} version={{ id: assetId, number: 1, superResolutions: snapshot.tasks }} versionLabel={t("upscaleSource")}
      configured={snapshot.configured} storageConfigured={snapshot.storageConfigured} capability={snapshot.capability} onChange={refresh} onPreview={onPreview} />}
    {!snapshot && !error && <p role="status" className="p-4 text-sm text-muted-foreground">{t("upscaleQuery")}…</p>}
    {error && <div role="alert" className="flex items-center gap-3 p-4 text-xs text-destructive"><span>{error}</span><Button size="sm" variant="outline" onClick={() => void refresh()}>{t("upscaleQuery")}</Button></div>}
  </div>;
}

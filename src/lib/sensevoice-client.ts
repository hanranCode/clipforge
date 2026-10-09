"use client";

import type { SenseVoiceModelStatus } from "@/lib/sensevoice-model";

export type { SenseVoiceModelStatus };

export async function fetchSenseVoiceStatus(signal?: AbortSignal): Promise<SenseVoiceModelStatus> {
  const res = await fetch("/api/asr/sensevoice", { cache: "no-store", signal });
  if (!res.ok) throw new Error(`SenseVoice status ${res.status}`);
  return res.json();
}

/**
 * Make sure the local SenseVoice model is on disk: start the one-time download if needed and
 * poll until it lands, reporting 0–100 progress. Throws the server's error when the download fails.
 */
export async function ensureSenseVoiceModel(onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<void> {
  let status = await fetchSenseVoiceStatus(signal);
  if (status.state === "ready") return;
  if (status.state !== "downloading") {
    const res = await fetch("/api/asr/sensevoice", { method: "POST", signal });
    status = await res.json();
  }
  while (status.state === "downloading") {
    onProgress?.(Math.min(99, Math.round((status.receivedBytes / Math.max(1, status.totalBytes)) * 100)));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    signal?.throwIfAborted();
    status = await fetchSenseVoiceStatus(signal);
  }
  if (status.state !== "ready") throw new Error(status.error || "SenseVoice model download failed");
  onProgress?.(100);
}

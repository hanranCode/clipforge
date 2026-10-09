"use client";

import { useCallback, useRef, useState } from "react";
import type { AsrWorkerMessage, LocalAsrModel, ServerAsrEngine } from "@/lib/local-asr";
import { ensureSenseVoiceModel } from "@/lib/sensevoice-client";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { ASR_CHUNK_SECONDS, decodeFloat32Pcm } from "@/lib/transcript-checkpoint";
import type { TranscriptDocument, TranscriptSegment } from "@/lib/transcript-editor";

/** Base is noticeably better than Tiny on Chinese speech and still quick on clips this short */
const MODEL: LocalAsrModel = "onnx-community/whisper-base_timestamped";
/** The re-dub script is Chinese: pin Whisper's language instead of auto-detecting it */
const LANGUAGE = "zh";

export type TranscribeState =
  | { phase: "idle" }
  | { phase: "loading" | "transcribing"; progress: number }
  | { phase: "error"; error: string };

/**
 * Speech → timed lines for the re-dub script, using the engine picked in Settings → 语音识别:
 * SenseVoice on the local CPU (default; the model is downloaded on first use), Fish Audio's cloud
 * (needs its key), or the in-browser Whisper worker shared with the transcript editor.
 */
export function useTranscribe() {
  const [state, setState] = useState<TranscribeState>({ phase: "idle" });
  const workerRef = useRef<Worker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const asr = useSettingsStore((s) => s.asr);
  const fishKey = asr.fishApiKey.trim();
  // Fish without a key cannot run — fall back to SenseVoice rather than the weak Whisper
  const engine: ServerAsrEngine | null = asr.provider === "local" ? null : asr.provider === "fish" && fishKey ? "fish" : "sensevoice";

  const cancel = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ phase: "idle" });
  }, []);

  const transcribeOnServer = useCallback(async (path: string, duration: number, serverEngine: ServerAsrEngine, apiKey: string): Promise<TranscriptSegment[] | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const out: TranscriptSegment[] = [];
    try {
      if (serverEngine === "sensevoice") {
        setState({ phase: "loading", progress: 0 });
        await ensureSenseVoiceModel((progress) => setState({ phase: "loading", progress }), controller.signal);
      }
      setState({ phase: "transcribing", progress: 0 });
      const chunks = Math.max(1, Math.ceil(duration / ASR_CHUNK_SECONDS));
      for (let i = 0; i < chunks; i++) {
        const start = i * ASR_CHUNK_SECONDS;
        const length = Math.min(ASR_CHUNK_SECONDS, duration - start);
        const res = await fetch("/api/remake/asr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ engine: serverEngine, path, start, duration: length, language: LANGUAGE, ...(serverEngine === "fish" && { apiKey }) }),
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => ({}))) as TranscriptDocument & { error?: string };
        if (!res.ok) throw new Error(data.error || "asr");
        out.push(...(data.segments ?? []));
        setState({ phase: "transcribing", progress: Math.round(((i + 1) / chunks) * 100) });
      }
      setState({ phase: "idle" });
      return out;
    } catch (error) {
      if (controller.signal.aborted) return null; // cancelled
      setState({ phase: "error", error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const transcribe = useCallback(async (path: string, duration: number): Promise<TranscriptSegment[] | null> => {
    if (engine) return transcribeOnServer(path, duration, engine, fishKey);
    workerRef.current?.terminate();
    const worker = new Worker(new URL("../../../../workers/asr.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setState({ phase: "loading", progress: 0 });
    const out: TranscriptSegment[] = [];
    try {
      const chunks = Math.max(1, Math.ceil(duration / ASR_CHUNK_SECONDS));
      for (let i = 0; i < chunks; i++) {
        const start = i * ASR_CHUNK_SECONDS;
        const length = Math.min(ASR_CHUNK_SECONDS, duration - start);
        const res = await fetch(`/api/remake/audio?path=${encodeURIComponent(path)}&start=${start.toFixed(3)}&duration=${length.toFixed(3)}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || "audio");
        }
        const pcm = decodeFloat32Pcm(await res.arrayBuffer());
        const segments = await new Promise<TranscriptSegment[]>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<AsrWorkerMessage>) => {
            const msg = event.data;
            if (msg.type === "progress") {
              const base = (i / chunks) * 100;
              const share = msg.phase === "loading" ? 0 : (msg.progress / 100) * (100 / chunks);
              setState({ phase: msg.phase, progress: Math.round(msg.phase === "loading" ? msg.progress : base + share) });
            } else if (msg.type === "complete") resolve(msg.transcript.segments);
            else if (msg.type === "error") reject(new Error(msg.error));
          };
          worker.postMessage(
            { type: "transcribe", audio: pcm, model: MODEL, language: LANGUAGE, preferWebGpu: true, offsetSeconds: start, sourceDuration: duration, chunkIndex: i },
            [pcm.buffer],
          );
        });
        out.push(...segments);
      }
      setState({ phase: "idle" });
      return out;
    } catch (error) {
      if (workerRef.current !== worker) return null; // cancelled
      setState({ phase: "error", error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      if (workerRef.current === worker) {
        worker.terminate();
        workerRef.current = null;
      }
    }
  }, [engine, fishKey, transcribeOnServer]);

  return { state, transcribe, cancel };
}

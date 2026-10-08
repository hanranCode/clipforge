"use client";

import { useCallback, useRef, useState } from "react";
import type { AsrWorkerMessage, LocalAsrModel } from "@/lib/local-asr";
import { ASR_CHUNK_SECONDS, decodeFloat32Pcm } from "@/lib/transcript-checkpoint";
import type { TranscriptSegment } from "@/lib/transcript-editor";

/** Base is noticeably better than Tiny on Chinese speech and still quick on clips this short */
const MODEL: LocalAsrModel = "onnx-community/whisper-base_timestamped";
/** The re-dub script is Chinese: pin Whisper's language instead of auto-detecting it */
const LANGUAGE = "zh";

export type TranscribeState =
  | { phase: "idle" }
  | { phase: "loading" | "transcribing"; progress: number }
  | { phase: "error"; error: string };

/**
 * Speech → timed lines for the re-dub script, using the same in-browser Whisper worker as the
 * transcript editor. The server only cuts PCM chunks; nothing leaves the machine.
 */
export function useTranscribe() {
  const [state, setState] = useState<TranscribeState>({ phase: "idle" });
  const workerRef = useRef<Worker | null>(null);

  const cancel = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setState({ phase: "idle" });
  }, []);

  const transcribe = useCallback(async (path: string, duration: number): Promise<TranscriptSegment[] | null> => {
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
  }, []);

  return { state, transcribe, cancel };
}

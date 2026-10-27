"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LuCheck, LuLoaderCircle, LuMic, LuPlay, LuPlus, LuTrash2, LuVolume2, LuVolumeX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { SourceBadges, SourceFilter } from "@/components/material-source";
import { imageSources, matchesSource } from "@/lib/material-source";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { FREE_TTS_VOICES } from "@/lib/tts-voices";
import { getTTSProviderMeta, type ResolvedTTSConfig, type TTSVoiceOption } from "@/lib/tts-presets";
import type { Character } from "@/lib/stores/project-store";
import { canKeepRemakeSubtitles, type DubCue, type RemakeAudioMode } from "@/lib/remake/plan";
import type { TranscribeState } from "./use-transcribe";

/* eslint-disable @next/next/no-img-element -- presenter sheets are local files served by our own API */

export interface VoiceOption {
  value: string;
  label: string;
  provider: string;
  price: string;
}

export function AudioPanel({
  keepSubtitles,
  onKeepSubtitlesChange,
  audioMode,
  onAudioModeChange,
  presenters,
  presenterId,
  onPresenterChange,
  onUsePresenterImage,
  voiceId,
  onVoiceChange,
  paidVoice,
  paidVoiceConfig,
  paidVoiceProvider,
  paidVoicePrice,
  onPreviewVoice,
  previewing,
  cues,
  onCuesChange,
  hasAudio,
  currentTime,
  transcribeState,
  onTranscribe,
  dubbing,
  dubReady,
  dubPath,
  onBuildDub,
}: {
  keepSubtitles: boolean;
  onKeepSubtitlesChange: (v: boolean) => void;
  audioMode: RemakeAudioMode;
  onAudioModeChange: (m: RemakeAudioMode) => void;
  presenters: Character[];
  presenterId: string | null;
  onPresenterChange: (id: string) => void;
  onUsePresenterImage: () => void;
  voiceId: string;
  onVoiceChange: (v: string) => void;
  /** Preserve a configured/custom voice even when the catalog doesn't contain it. */
  paidVoice: string | null;
  paidVoiceConfig?: ResolvedTTSConfig | null;
  paidVoiceProvider: string | null;
  paidVoicePrice: { amount: string; estimated: boolean } | null;
  onPreviewVoice: () => void;
  previewing: boolean;
  cues: DubCue[];
  onCuesChange: (cues: DubCue[]) => void;
  hasAudio: boolean;
  currentTime: number;
  transcribeState: TranscribeState;
  onTranscribe: () => void;
  dubbing: boolean;
  dubReady: boolean;
  dubPath: string | null;
  onBuildDub: () => void;
}) {
  const t = useT("remake");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [presenterSource, setPresenterSource] = useState("");
  const presenter = presenters.find((p) => p.id === presenterId);
  const canKeepSubtitles = canKeepRemakeSubtitles(audioMode);
  const [catalog, setCatalog] = useState<{ key: string; voices: TTSVoiceOption[]; error?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const provider = paidVoiceConfig?.provider;
  const baseUrl = paidVoiceConfig?.baseUrl;
  const apiKey = paidVoiceConfig?.apiKey;
  const groupId = paidVoiceConfig?.groupId;
  // Keep results bound to their credentials so a settings switch never exposes the old catalog.
  const catalogKey = JSON.stringify([provider, baseUrl, apiKey, groupId, retry]);
  useEffect(() => {
    if (audioMode !== "dub" || provider !== "minimax" || !apiKey) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/tts/voices", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, baseUrl, apiKey, groupId }), signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.voices) || !data.voices.length) throw new Error("VOICE_LOOKUP_FAILED");
        if (!controller.signal.aborted) setCatalog({ key: catalogKey, voices: data.voices });
      } catch {
        if (!controller.signal.aborted) setCatalog({ key: catalogKey, voices: [], error: true });
      }
    })();
    return () => controller.abort();
  }, [audioMode, provider, baseUrl, apiKey, groupId, catalogKey]);
  const currentCatalog = catalog?.key === catalogKey ? catalog : null;
  const paidVoices = provider === "minimax" && currentCatalog && !currentCatalog.error
    ? currentCatalog.voices : provider ? getTTSProviderMeta(provider).voices : [];

  const voiceOptions: VoiceOption[] = FREE_TTS_VOICES.map((v) => ({
    value: v.value,
    label: v.label,
    provider: t("voiceProviderEdge"),
    price: t("voicePriceFree"),
  }));
  if (paidVoice) for (const voice of paidVoices) {
    if (!voiceOptions.some((v) => v.value === voice.value)) voiceOptions.push({
      ...voice, provider: paidVoiceProvider ?? t("voiceProviderUnknown"),
      price: paidVoicePrice
        ? t(paidVoicePrice.estimated ? "voicePriceEstimate" : "voicePriceExact", { price: paidVoicePrice.amount })
        : t("voicePriceUnknown"),
    });
  }
  if (paidVoice && !voiceOptions.some((v) => v.value === paidVoice)) voiceOptions.unshift({
    value: paidVoice,
    label: t("voicePaid", { voice: paidVoice }),
    provider: paidVoiceProvider ?? t("voiceProviderUnknown"),
    price: paidVoicePrice
      ? t(paidVoicePrice.estimated ? "voicePriceEstimate" : "voicePriceExact", { price: paidVoicePrice.amount })
      : t("voicePriceUnknown"),
  });
  if (voiceId && !voiceOptions.some((v) => v.value === voiceId)) voiceOptions.unshift({
    value: voiceId,
    label: voiceId,
    provider: paidVoiceProvider ?? t("voiceProviderUnknown"),
    price: paidVoicePrice
      ? t(paidVoicePrice.estimated ? "voicePriceEstimate" : "voicePriceExact", { price: paidVoicePrice.amount })
      : t("voicePriceUnknown"),
  });
  const selectedVoice = voiceOptions.find((v) => v.value === voiceId);

  const patchCue = (id: string, patch: Partial<DubCue>) => onCuesChange(cues.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const addCue = () => {
    const start = Math.round(currentTime * 10) / 10;
    const next = [...cues, { id: crypto.randomUUID(), start, end: start + 2, text: "" }].sort((a, b) => a.start - b.start);
    onCuesChange(next);
  };

  const busy = transcribeState.phase === "loading" || transcribeState.phase === "transcribing";
  const modes: Array<{ id: RemakeAudioMode; icon: React.ReactNode }> = [
    { id: "keep", icon: <LuVolume2 className="size-4" /> },
    { id: "mute", icon: <LuVolumeX className="size-4" /> },
    { id: "dub", icon: <LuMic className="size-4" /> },
    { id: "generated", icon: <LuVolume2 className="size-4" /> },
  ];

  return (
    <div className="space-y-5">
      <label className={`flex items-start gap-3 rounded-lg border border-border/60 p-3 ${canKeepSubtitles ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
        <input type="checkbox" className="mt-0.5" disabled={!canKeepSubtitles} checked={canKeepSubtitles && keepSubtitles} onChange={(e) => onKeepSubtitlesChange(e.target.checked)} />
        <span>
          <span className="block text-sm font-medium">{t("keepSubtitles")}</span>
          <span className="block text-xs text-muted-foreground">{t(canKeepSubtitles ? "keepSubtitlesDesc" : "keepSubtitlesNewAudioDisabled")}</span>
        </span>
      </label>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("audioTitle")}</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onAudioModeChange(m.id)}
              aria-pressed={audioMode === m.id}
              className={`rounded-lg border p-3 text-left transition-colors ${
                audioMode === m.id ? "border-primary bg-primary/8" : "border-border/60 hover:border-border"
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                {m.icon}
                {t(`audio_${m.id}`)}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{t(`audio_${m.id}Desc`)}</span>
            </button>
          ))}
        </div>
      </div>

      {audioMode === "dub" && (
        <div className="space-y-4 rounded-lg border border-border/60 bg-muted/10 p-3">
          {/* presenter */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">{t("presenterTitle")}</h4>
            {presenters.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("presenterNone")} ·{" "}
                <Link href="/presenters" className="text-primary hover:underline">
                  {t("presenterManage")}
                </Link>
              </p>
            ) : (
              <div className="space-y-2"><SourceFilter value={presenterSource} onChange={setPresenterSource} /><div className="flex gap-2 overflow-x-auto pb-1">
                {presenters.filter(p => matchesSource(imageSources([...(p.sourcePhotos || []), ...p.referenceImages], p), presenterSource)).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onPresenterChange(p.id)}
                    aria-pressed={p.id === presenterId}
                    className={`w-24 shrink-0 overflow-hidden rounded-lg border text-left ${p.id === presenterId ? "border-primary ring-1 ring-primary" : "border-border/60"}`}
                  >
                    <div className="aspect-square bg-muted/40">
                      {(p.referenceImages?.[0] || p.sourcePhotos?.[0]) && <img src={p.referenceImages?.[0] || p.sourcePhotos?.[0]} alt="" className="h-full w-full object-cover" />}
                    </div>
                    <div className="px-1.5 py-1">
                      <p className="truncate text-xs font-medium">{p.name}</p><SourceBadges sources={imageSources([...(p.sourcePhotos || []), ...p.referenceImages], p)} />
                      <p className="truncate text-[10px] text-muted-foreground">
                        {p.voiceProfile?.voice ? FREE_TTS_VOICES.find((v) => v.value === p.voiceProfile?.voice)?.label ?? p.voiceProfile.voice : t("presenterNoVoice")}
                      </p>
                    </div>
                  </button>
                ))}
              </div></div>
            )}
            {(presenter?.referenceImages?.[0] || presenter?.sourcePhotos?.[0]) && (
              <Button variant="outline" size="sm" onClick={onUsePresenterImage}>
                <LuPlus />
                {t("presenterUseImage")}
              </Button>
            )}
          </div>

          {/* voice */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">{t("voiceTitle")}</h4>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={voiceId}
                onChange={(e) => onVoiceChange(e.target.value)}
                aria-label={t("voiceTitle")}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm sm:max-w-xs"
              >
                <option value="">—</option>
                {voiceOptions.map((v) => (
                  <option key={v.value} value={v.value}>
                    {`${v.label} · ${v.provider} · ${v.price}`}
                  </option>
                ))}
              </select>
              <Button variant="outline" size="sm" disabled={!voiceId || previewing} onClick={onPreviewVoice}>
                {previewing ? <LuLoaderCircle className="animate-spin" /> : <LuPlay />}
                {t("voicePreview")}
              </Button>
            </div>
            {selectedVoice && <p className="text-[11px] text-muted-foreground">{selectedVoice.provider} · {selectedVoice.price}</p>}
            {provider === "minimax" && !currentCatalog && <p role="status" className="text-xs text-muted-foreground">{t("voicesLoading")}</p>}
            {provider === "minimax" && currentCatalog?.error && <div role="status" className="flex items-center gap-2 text-xs text-amber-600">
              <span>{t("voicesLoadFailed")}</span>
              <Button variant="ghost" size="sm" onClick={() => setRetry((v) => v + 1)}>{t("voicesRetry")}</Button>
            </div>}
          </div>

          {/* dub script */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-xs font-medium text-muted-foreground">{t("cuesTitle")}</h4>
                <p className="text-[11px] text-muted-foreground">{t("cuesDesc")}</p>
              </div>
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" disabled={!hasAudio || busy} onClick={onTranscribe}>
                  {busy ? <LuLoaderCircle className="animate-spin" /> : <LuMic />}
                  {busy
                    ? t(transcribeState.phase === "loading" ? "cuesLoadingModel" : "cuesTranscribing", { progress: "progress" in transcribeState ? transcribeState.progress : 0 })
                    : cues.length
                      ? t("cuesRetranscribe")
                      : t("cuesTranscribe")}
                </Button>
                <Button variant="outline" size="sm" onClick={addCue}>
                  <LuPlus />
                  {t("cuesAdd")}
                </Button>
              </div>
            </div>
            {!hasAudio && <p className="text-[11px] text-amber-600">{t("cuesNoAudio")}</p>}
            {transcribeState.phase === "error" && <p className="text-[11px] text-destructive">{transcribeState.error}</p>}
            {cues.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-center text-xs text-muted-foreground">{t("cuesEmpty")}</p>
            ) : (
              <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {cues.map((cue) => (
                  <div key={cue.id} className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      step={0.1}
                      min={0}
                      value={cue.start}
                      onChange={(e) => patchCue(cue.id, { start: Number(e.target.value) })}
                      className="h-8 w-16 px-1.5 text-xs tabular-nums"
                    />
                    <Input
                      type="number"
                      step={0.1}
                      min={0}
                      value={cue.end}
                      onChange={(e) => patchCue(cue.id, { end: Number(e.target.value) })}
                      className="h-8 w-16 px-1.5 text-xs tabular-nums"
                    />
                    <Input value={cue.text} onChange={(e) => patchCue(cue.id, { text: e.target.value })} className="h-8 min-w-0 flex-1 text-sm" />
                    <button
                      type="button"
                      aria-label={t("cueRemove")}
                      className="rounded p-1 text-muted-foreground hover:text-destructive"
                      onClick={() => onCuesChange(cues.filter((c) => c.id !== cue.id))}
                    >
                      <LuTrash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={dubbing || !cues.length || !voiceId} onClick={onBuildDub}>
              {dubbing ? <LuLoaderCircle className="animate-spin" /> : <LuMic />}
              {dubbing ? t("buildingDub") : t("buildDub")}
            </Button>
            {dubPath && dubReady && (
              <>
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <LuCheck className="size-3.5" />
                  {t("dubReady")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const a = audioRef.current;
                    if (!a) return;
                    if (playing) a.pause();
                    else void a.play();
                  }}
                >
                  <LuPlay />
                  {t("dubPreview")}
                </Button>
                <audio ref={audioRef} src={dubPath} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
              </>
            )}
            {dubPath && !dubReady && <span className="text-xs text-amber-600">{t("dubStale")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

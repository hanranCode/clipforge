"use client";

import { useEffect, useState } from "react";
import { LuAudioLines, LuCheck, LuDownload, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { ensureSenseVoiceModel, fetchSenseVoiceStatus, type SenseVoiceModelStatus } from "@/lib/sensevoice-client";
import { useSettingsStore, type AsrSetting } from "@/lib/stores/settings-store";

/**
 * Speech recognition engine for the transcript editor and the remake re-dub script. SenseVoice-Small
 * on the local CPU is the default — accurate on Chinese, free and offline once its ~240 MB model is
 * downloaded. Fish Audio's cloud ASR and the in-browser Whisper models stay as alternatives.
 */
export function AsrSettings() {
  const t = useT("settings");
  const asr = useSettingsStore((s) => s.asr);
  const setASR = useSettingsStore((s) => s.setASR);
  const update = (patch: Partial<AsrSetting>) => setASR({ ...asr, ...patch });
  const [model, setModel] = useState<SenseVoiceModelStatus | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (asr.provider !== "sensevoice") return;
    const controller = new AbortController();
    fetchSenseVoiceStatus(controller.signal)
      .then((status) => {
        setModel(status);
        // a download started elsewhere (transcript page) keeps reporting here too
        if (status.state === "downloading") void download();
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [asr.provider]);

  const download = async () => {
    setError(null);
    setProgress(0);
    try {
      await ensureSenseVoiceModel(setProgress);
      setModel(await fetchSenseVoiceStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  const option = (value: AsrSetting["provider"], title: string, desc: string) => (
    <button
      type="button"
      onClick={() => update({ provider: value })}
      className={`rounded-lg border p-3 text-left transition-colors ${asr.provider === value ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{desc}</div>
    </button>
  );

  return (
    <Card className="glass-card">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 text-white">
            <LuAudioLines className="size-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("asrTitle")}</h3>
            <p className="text-xs leading-5 text-muted-foreground">{t("asrSubtitle")}</p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          {option("sensevoice", t("asrSenseVoice"), t("asrSenseVoiceDesc"))}
          {option("fish", t("asrFish"), t("asrFishDesc"))}
          {option("local", t("asrLocal"), t("asrLocalDesc"))}
        </div>

        {asr.provider === "sensevoice" && (
          <div className="flex flex-wrap items-center gap-3">
            {model?.state === "ready" ? (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <LuCheck className="size-3.5" />
                {t("asrSenseVoiceReady")}
              </span>
            ) : (
              <Button variant="outline" size="sm" onClick={download} disabled={progress !== null}>
                {progress !== null ? <LuLoaderCircle className="animate-spin" /> : <LuDownload />}
                {progress !== null ? t("asrSenseVoiceDownloading", { n: progress }) : t("asrSenseVoiceDownload")}
              </Button>
            )}
            {error && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <LuTriangleAlert className="size-3.5" />
                {error}
              </span>
            )}
            <p className="w-full text-[11px] leading-4 text-muted-foreground">{t("asrSenseVoiceHint")}</p>
          </div>
        )}

        {asr.provider === "fish" && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("asrFishKey")}</Label>
            <Input
              type="password"
              value={asr.fishApiKey}
              onChange={(e) => update({ fishApiKey: e.target.value.trim() })}
              placeholder={t("asrFishKeyPlaceholder")}
              className="font-mono text-xs"
              autoComplete="off"
            />
            <p className="text-[11px] leading-4 text-muted-foreground">{t("asrFishKeyHint")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

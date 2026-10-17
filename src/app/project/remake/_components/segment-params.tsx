"use client";

import { Button } from "@/components/ui/button";
import { PromptInput, type PromptReference } from "./prompt-input";
import { useT } from "@/lib/i18n";
import { getVideoParamSpec } from "@/lib/providers/atlas-video-params";
import { DEFAULT_REMAKE_MODEL, REMAKE_MODELS, isWanRemakeModel } from "@/lib/remake/model";
import { segmentEditParams, type SegmentSettings } from "@/lib/remake/workflow";
import { remakeOfficialPrice } from "@/lib/remake/pricing";

export function SegmentParams({ value, onChange, prompt, video, images, audio, references = [] }: {
  value: SegmentSettings;
  onChange: (settings: SegmentSettings) => void;
  prompt: string;
  video?: string;
  images: string[];
  audio?: string;
  references?: PromptReference[];
}) {
  const t = useT("remake");
  const is25 = value.model === DEFAULT_REMAKE_MODEL;
  const isWan = isWanRemakeModel(value.model);
  const price = remakeOfficialPrice(value.model);
  const patch = (change: Partial<SegmentSettings>) => onChange({ ...value, ...change });
  const params = segmentEditParams(value.model, { ...value });
  const body = { model: value.model, prompt: value.prompt.trim() || prompt,
    ...(isWan ? { refers: [
      ...(video ? [{ url: video, type: "video" }] : []),
      ...images.map((url) => ({ url, type: "image" })),
      ...(audio ? [{ url: audio, type: "audio" }] : []),
    ] } : { reference_images: images, reference_videos: video ? [video] : [], reference_audios: audio ? [audio] : [] }), ...params };
  const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
  return (
    <div className="space-y-4 rounded-lg border border-border/60 p-4">
      <h3 className="text-sm font-medium">{t("segmentParams")}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">{t("modelLabel")} · model
          <select className={selectClass} value={value.model} onChange={(e) => patch({ model: e.target.value, resolution: "720p",
            output_format: "mp4", draft: false, return_last_frame: false,
            ...(isWanRemakeModel(e.target.value) && { watermark: false }) })}>
            {REMAKE_MODELS.map((model) => <option key={model} value={model}>
              {model} · {t("pricePerSecond", { price: `$${remakeOfficialPrice(model)!.perSecondUsd}` })}
            </option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">{t("resolutionLabel")} · resolution
          <select className={selectClass} value={value.resolution} onChange={(e) => patch({ resolution: e.target.value })}>
            {getVideoParamSpec(value.model)?.resolutionEnum?.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">{t(isWan ? "smartDurationLabel" : "durationLabel")} · duration
          <input readOnly value="-1" className={`${selectClass} text-muted-foreground`} />
        </label>
        <label className="space-y-1 text-xs">{t(isWan ? "adaptiveRatioLabel" : "ratioLabel")} · ratio
          <input readOnly value="adaptive" className={`${selectClass} text-muted-foreground`} />
        </label>
        <label className="space-y-1 text-xs">{t("taskTypeLabel")} · omni_reference_task_type
          <input readOnly value={is25 ? "edit" : t("paramUnsupported")} className={`${selectClass} text-muted-foreground`} />
        </label>
        <label className="space-y-1 text-xs">{t("formatLabel")} · output_format
          <select disabled={!is25} className={selectClass} value={is25 ? value.output_format : "mp4"} onChange={(e) => patch({ output_format: e.target.value as "mp4" | "mov" })}>
            <option value="mp4">mp4</option><option value="mov">mov</option>
          </select>
        </label>
      </div>
      {price && <p className="text-xs text-muted-foreground">
        {t("officialPriceHint")} <a href={price.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{t("officialPriceLink")}</a>
      </p>}
      <p className="text-xs text-muted-foreground">{t(isWan ? "wanEditConstraints" : "editConstraints")}</p>
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        {([ ["generate_audio", t("generateAudioLabel")], ["watermark", t("watermarkLabel")],
          ["return_last_frame", t("lastFrameLabel")], ["draft", t("draftLabel")] ] as const).map(([key, label]) => {
          const unsupported = (isWan && key === "watermark") || (!is25 && (key === "draft" || key === "return_last_frame"));
          return (
          <label key={key} className="flex items-center gap-2">
            <input type="checkbox" disabled={unsupported} checked={!unsupported && value[key]} onChange={(e) => patch({ [key]: e.target.checked })} />
            {label} <span className="text-muted-foreground">{key === "generate_audio" && isWan ? "audio" : key}</span>
          </label>
          );
        })}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={value.useSourceAudio} onChange={(e) => patch({ useSourceAudio: e.target.checked })} />{t("useReferenceAudio")}
        </label>
      </div>
      {value.draft && is25 && <p className="text-xs text-amber-600">{t("draftBilling")}</p>}
      <p className="text-xs text-muted-foreground">{t("resolutionHint")}</p>
      <PromptInput label={`${t("segmentPrompt")} · prompt`} value={value.prompt || prompt} onChange={(prompt) => patch({ prompt })} references={references} />
      {value.prompt && <Button variant="ghost" size="sm" onClick={() => patch({ prompt: "" })}>{t("resetPrompt")}</Button>}
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>reference_videos · {video ? "@Video1" : t("prepareFirst")}</p>
        <p>reference_images · {images.length} · {images.map((_, i) => `@Image${i + 1}`).join(" / ") || "—"}</p>
        <p>reference_audios · {audio ? "@Audio1" : "—"}</p>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer">{t("requestPreview")}</summary>
        <p className="my-2 text-muted-foreground">{t("requestPreviewHint")}</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/20 p-2">{JSON.stringify(body, null, 2)}</pre>
      </details>
    </div>
  );
}

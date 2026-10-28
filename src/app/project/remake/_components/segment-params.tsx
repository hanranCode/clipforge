"use client";

import { Button } from "@/components/ui/button";
import { PromptInput, type PromptReference } from "./prompt-input";
import { useT } from "@/lib/i18n";
import { ARK_REMAKE_MODELS, DEFAULT_REMAKE_MODEL, REMAKE_PROVIDERS, isWanRemakeModel, remakeModelsFor, remakeProviderForModel } from "@/lib/remake/model";
import { defaultSegmentSettings, remakeResolutions, segmentEditParams, type SegmentSettings } from "@/lib/remake/workflow";
import { providerLabel } from "@/lib/provider-labels";
import { bailianVideoRate, remakeOfficialPrice } from "@/lib/remake/pricing";
import { buildWanOmniBody } from "@/lib/providers/alibaba";

export function SegmentParams({ value, onChange, prompt, requestPrompt, video, images, audio, references = [], enabledProviders = [...REMAKE_PROVIDERS] }: {
  value: SegmentSettings;
  onChange: (settings: SegmentSettings) => void;
  prompt: string;
  /** Exact prompt sent after applying the page's subtitle constraints. */
  requestPrompt?: string;
  video?: string;
  images: string[];
  audio?: string;
  references?: PromptReference[];
  enabledProviders?: string[];
}) {
  const t = useT("remake");
  const settingsT = useT("settings");
  const provider = value.provider || remakeProviderForModel(value.model);
  const isArk = provider === "volcengine";
  const isBailian = provider === "alibaba";
  const is25 = value.model === DEFAULT_REMAKE_MODEL;
  const isWan = isWanRemakeModel(value.model);
  const cnyRate = isBailian ? bailianVideoRate(value.model, value.resolution) : undefined;
  const price = remakeOfficialPrice(value.model) || (cnyRate != null ? { url: "https://help.aliyun.com/zh/model-studio/model-pricing" } : undefined);
  const patch = (change: Partial<SegmentSettings>) => onChange({ ...value, ...change });
  const params = segmentEditParams(value.model, { ...value });
  const effectivePrompt = requestPrompt ?? (value.prompt.trim() || prompt);
  const body = isBailian ? buildWanOmniBody({ modelId: value.model, mode: "video-to-video", prompt: effectivePrompt,
    referenceImageUrls: images, referenceVideoUrls: video ? [video] : [], referenceAudioUrls: audio ? [audio] : [],
    audioEnabled: value.generate_audio, extra: params }) : { model: value.model, prompt: effectivePrompt,
    ...(isArk ? { content: [
      { type: "text", text: requestPrompt ?? (value.prompt.trim() || prompt) },
      ...images.map((url) => ({ type: "image_url", image_url: { url }, role: "reference_image" })),
      ...(video ? [{ type: "video_url", video_url: { url: video }, role: "reference_video" }] : []),
      ...(audio ? [{ type: "audio_url", audio_url: { url: audio }, role: "reference_audio" }] : []),
    ] } : isWan ? { refers: [
      ...(video ? [{ url: video, type: "video" }] : []),
      ...images.map((url) => ({ url, type: "image" })),
      ...(audio ? [{ url: audio, type: "audio" }] : []),
    ] } : { reference_images: images, reference_videos: video ? [video] : [], reference_audios: audio ? [audio] : [] }), ...params };
  if (isArk) delete (body as { prompt?: string }).prompt;
  const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
  return (
    <div className="space-y-4 rounded-lg border border-border/60 p-4">
      <h3 className="text-sm font-medium">{t("segmentParams")}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">{t("providerLabel")}
          <select className={selectClass} value={provider} onChange={(e) => {
            const nextProvider = e.target.value;
            const model = remakeModelsFor(nextProvider)[0];
            if (model) onChange({ ...defaultSegmentSettings(model, nextProvider), prompt: value.prompt, useSourceAudio: value.useSourceAudio });
          }}>
            {REMAKE_PROVIDERS.filter((p) => enabledProviders.includes(p) || p === provider).map((p) =>
              <option key={p} value={p} disabled={!enabledProviders.includes(p)}>{providerLabel(p, settingsT)}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">{t("modelLabel")} · model
          <select className={selectClass} value={value.model} onChange={(e) => patch({ model: e.target.value, resolution: "480p",
            output_format: "mp4", draft: false, return_last_frame: false,
            ...(isWanRemakeModel(e.target.value) && { watermark: false }) })}>
            {remakeModelsFor(provider).map((model) => <option key={model} value={model}>
              {model}{isBailian ? ` · ${t("pricePerSecond", { price: `¥${bailianVideoRate(model, value.resolution)}` })}` : remakeOfficialPrice(model) ? ` · ${t("pricePerSecond", { price: `$${remakeOfficialPrice(model)!.perSecondUsd}` })}` : ""}
            </option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">{t("resolutionLabel")} · resolution
          <select className={selectClass} value={value.resolution} onChange={(e) => patch({ resolution: e.target.value })}>
            {remakeResolutions(value.model).map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">{t(isWan ? "smartDurationLabel" : "durationLabel")} · duration
          <input readOnly value="-1" className={`${selectClass} text-muted-foreground`} />
        </label>
        <label className="space-y-1 text-xs">{t(isWan ? "adaptiveRatioLabel" : "ratioLabel")} · ratio
          <input readOnly value="adaptive" className={`${selectClass} text-muted-foreground`} />
        </label>
        <label className="space-y-1 text-xs">{t("taskTypeLabel")} · omni_reference_task_type
          <input readOnly value={is25 || value.model === ARK_REMAKE_MODELS[0] ? "edit" : t("paramUnsupported")} className={`${selectClass} text-muted-foreground`} />
        </label>
        <label className="space-y-1 text-xs">{t("formatLabel")} · output_format
          <select disabled={!is25} className={selectClass} value={is25 ? value.output_format : "mp4"} onChange={(e) => patch({ output_format: e.target.value as "mp4" | "mov" })}>
            <option value="mp4">mp4</option><option value="mov">mov</option>
          </select>
        </label>
      </div>
      {price && <p className="text-xs text-muted-foreground">
        {cnyRate != null ? t("bailianPriceHint", { price: cnyRate, resolution: value.resolution.toUpperCase() }) : t("officialPriceHint")} <a href={price.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{t("officialPriceLink")}</a>
      </p>}
      <p className="text-xs text-muted-foreground">{t(isBailian ? "bailianEditConstraints" : isArk ? "arkEditConstraints" : isWan ? "wanEditConstraints" : "editConstraints")}</p>
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        {([ ["generate_audio", t("generateAudioLabel")], ["watermark", t("watermarkLabel")],
          ["return_last_frame", t("lastFrameLabel")], ["draft", t("draftLabel")] ] as const).map(([key, label]) => {
          const unsupported = (isWan && !isBailian && key === "watermark") || (!is25 && key === "draft") || (!is25 && !isArk && key === "return_last_frame");
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

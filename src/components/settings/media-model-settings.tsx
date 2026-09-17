"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/stores/settings-store";
import type { GenMediaType } from "@/lib/gen-params";
import { MODEL_USAGES, MODEL_USAGE_STAGES, findModelFor, usageChoice, type UsageModelChoice } from "@/lib/model-usage";
import { decodeModelChoice, encodeModelChoice, providerLabel, providerOrder } from "@/lib/provider-labels";
import { formatUsd, listPriceFor, type ModelListPrice } from "@/lib/model-pricing";
import { modelScenarios } from "@/lib/model-scenarios";

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  custom?: boolean;
  mediaType?: string;
  modes?: readonly string[];
  supportsAudio?: boolean;
  extra?: Record<string, unknown>;
}

/** Server-attached price (honours the contract-price override file), else the built-in book */
function priceOf(option: ModelOption): ModelListPrice | undefined {
  const attached = option.extra?.price as ModelListPrice | undefined;
  if (attached && Number.isFinite(attached.amount)) return attached;
  return listPriceFor(option);
}

/** "$0.30/次" when the platform published it, "≈$0.06/秒" when it is a price-book estimate */
function PriceText({ option, className = "" }: { option: ModelOption; className?: string }) {
  const t = useT("settings");
  const price = priceOf(option);
  if (!price) return null;
  const estimate = price.source !== "provider";
  return (
    <span
      className={`shrink-0 tabular-nums ${estimate ? "text-muted-foreground" : "text-emerald-500"} ${className}`}
      title={t(estimate ? "priceEstimateTip" : "priceProviderTip")}
    >
      {estimate ? "≈" : ""}{formatUsd(price.amount)}/{t(`priceUnit_${price.unit}`)}
    </span>
  );
}

function ScenarioTags({ option }: { option: ModelOption }) {
  const t = useT("settings");
  const scenarios = modelScenarios(option);
  if (scenarios.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {scenarios.map((scenario) => (
        <span key={scenario} className="rounded border border-border/60 px-1 py-px text-[10px] leading-4 text-muted-foreground">
          {t(`scenario_${scenario}`)}
        </span>
      ))}
    </span>
  );
}

/** Dropdown row: name + price on top, what the model is for underneath */
function ModelOptionRow({ option, showProvider }: { option: ModelOption; showProvider: boolean }) {
  return (
    <span className="flex w-full min-w-0 flex-col gap-1 py-0.5 whitespace-normal">
      <span className="flex w-full min-w-0 items-center gap-2">
        <ModelLabel option={option} showProvider={showProvider} />
        <PriceText option={option} className="ml-auto text-[11px]" />
      </span>
      <ScenarioTags option={option} />
    </span>
  );
}

/** Scenarios + price of the currently chosen model, shown under a picker */
function ModelSummary({ option }: { option: ModelOption | undefined }) {
  if (!option) return null;
  const hasPrice = Boolean(priceOf(option));
  const hasScenarios = modelScenarios(option).length > 0;
  if (!hasPrice && !hasScenarios) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      <ScenarioTags option={option} />
      <PriceText option={option} />
    </div>
  );
}

// Base UI Select needs non-empty values for the sentinel rows
const FOLLOW_DEFAULT = "__follow_default__";
const ALL_PROVIDERS = "__all__";
// a slot saved before platforms were stored: its model is matched on any enabled platform
const ANY_PROVIDER = "__any__";

/** Providers present in the option list, in platform display order */
function providersOf(options: ModelOption[]): string[] {
  return [...new Set(options.map((m) => m.provider))].sort((a, b) => providerOrder(a) - providerOrder(b) || a.localeCompare(b));
}

/** Short platform tag rendered in front of a model name whenever a list spans platforms */
function ProviderTag({ provider }: { provider: string }) {
  const t = useT("settings");
  return (
    <span className="mr-1.5 inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
      {providerLabel(provider, t)}
    </span>
  );
}

function ModelLabel({ option, showProvider }: { option: ModelOption; showProvider: boolean }) {
  const t = useT("settings");
  return (
    <span className="flex min-w-0 items-center">
      {showProvider && <ProviderTag provider={option.provider} />}
      <span className="truncate">{option.name}{option.custom ? t("customModelSuffix") : ""}</span>
    </span>
  );
}

/**
 * Model dropdown over (provider, model) pairs. When the list spans more than one platform the
 * entries are grouped by platform AND each carries a platform tag — the same model id is often
 * served by several platforms, and a bare name gives no way to tell which one bills.
 */
function ModelChoiceSelect({
  options,
  value,
  onChange,
  placeholder,
  leading,
  disabled,
  muted,
}: {
  options: ModelOption[];
  value: UsageModelChoice | null;
  onChange: (choice: UsageModelChoice | null) => void;
  placeholder: string;
  /** optional sentinel row (e.g. "follow default") that maps to null */
  leading?: { label: React.ReactNode };
  disabled?: boolean;
  muted?: boolean;
}) {
  const providers = providersOf(options);
  const multi = providers.length > 1;
  const selected = value ? findModelFor(options, value.model, value.provider) : undefined;
  const encoded = value
    ? encodeModelChoice(selected?.provider ?? value.provider, value.model)
    : leading ? FOLLOW_DEFAULT : "";

  return (
    <Select
      value={encoded}
      onValueChange={(v) => {
        if (!v || v === FOLLOW_DEFAULT) onChange(null);
        else onChange(decodeModelChoice(v));
      }}
      disabled={disabled}
    >
      <SelectTrigger className={`w-full ${muted ? "text-muted-foreground" : ""}`}>
        <SelectValue>
          {(v: string) => {
            if (v === FOLLOW_DEFAULT && leading) return leading.label;
            if (!v) return placeholder;
            const { provider, model } = decodeModelChoice(v);
            const option = findModelFor(options, model, provider);
            return option ? (
              <span className="flex w-full min-w-0 items-center gap-2">
                <ModelLabel option={option} showProvider={multi} />
                <PriceText option={option} className="ml-auto text-[11px]" />
              </span>
            ) : model;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {leading && <SelectItem value={FOLLOW_DEFAULT}>{leading.label}</SelectItem>}
        {multi
          ? providers.map((provider) => (
              <SelectGroup key={provider}>
                <ProviderGroupLabel provider={provider} />
                {options.filter((m) => m.provider === provider).map((m) => (
                  <SelectItem key={encodeModelChoice(m.provider, m.id)} value={encodeModelChoice(m.provider, m.id)}>
                    <ModelOptionRow option={m} showProvider />
                  </SelectItem>
                ))}
              </SelectGroup>
            ))
          : options.map((m) => (
              <SelectItem key={encodeModelChoice(m.provider, m.id)} value={encodeModelChoice(m.provider, m.id)}>
                <ModelOptionRow option={m} showProvider={false} />
              </SelectItem>
            ))}
      </SelectContent>
    </Select>
  );
}

function ProviderGroupLabel({ provider }: { provider: string }) {
  const t = useT("settings");
  return <SelectLabel className="text-[11px] font-medium text-muted-foreground">{providerLabel(provider, t)}</SelectLabel>;
}

/**
 * Top of the image / video tab, modelled on the script-model card: pick the platform first,
 * then the default model within it. "All platforms" keeps one combined, platform-tagged list.
 */
export function DefaultModelPicker({
  mediaType,
  options,
  loading,
  noProvider,
  onManageKeys,
}: {
  mediaType: GenMediaType;
  options: ModelOption[];
  loading: boolean;
  noProvider: boolean;
  onManageKeys: () => void;
}) {
  const t = useT("settings");
  const isImage = mediaType === "image";
  const model = useSettingsStore((s) => (isImage ? s.defaultImageModel : s.defaultVideoModel));
  const pinned = useSettingsStore((s) => (isImage ? s.defaultImageProvider : s.defaultVideoProvider)) ?? "";
  const setChoice = useSettingsStore((s) => (isImage ? s.setDefaultImageChoice : s.setDefaultVideoChoice));

  const providers = providersOf(options);
  const current = findModelFor(options, model, pinned);
  // the chip row starts on the platform the default already lives on
  const [filter, setFilter] = useState<string | null>(null);
  const activeFilter = filter ?? (current?.provider && providers.length > 1 ? current.provider : ALL_PROVIDERS);
  const visible = activeFilter === ALL_PROVIDERS ? options : options.filter((m) => m.provider === activeFilter);
  const missing = Boolean(model) && !loading && options.length > 0 && !current;

  const switchProvider = (provider: string) => {
    setFilter(provider);
    if (provider === ALL_PROVIDERS) return;
    // switching platform switches the default too: keep the model if this platform serves it
    const inProvider = options.filter((m) => m.provider === provider);
    const keep = findModelFor(inProvider, model);
    const next = keep ?? inProvider[0];
    if (next) setChoice({ provider: next.provider, model: next.id });
  };

  const chip = (key: string, label: React.ReactNode, count: number) => {
    const selected = activeFilter === key;
    return (
      <button
        key={key}
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => switchProvider(key)}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
          selected
            ? "border-primary/50 bg-primary/10 font-medium text-primary"
            : "border-border/50 bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
        }`}
      >
        {label}
        <span className="text-[10px] tabular-nums opacity-70">{count}</span>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/50 bg-muted/50 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t(isImage ? "imageProviderHint" : "videoProviderHint")}</p>
          <button type="button" onClick={onManageKeys} className="shrink-0 text-[11px] text-primary hover:underline">
            {t("manageProviderKeys")}
          </button>
        </div>
        {providers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{loading ? t("modelsLoading") : noProvider ? t("enableProviderFirst") : t("providerNoModels")}</p>
        ) : (
          <div role="radiogroup" aria-label={t(isImage ? "imageProviderHint" : "videoProviderHint")} className="flex flex-wrap gap-2">
            {providers.length > 1 && chip(ALL_PROVIDERS, t("allProviders"), options.length)}
            {providers.map((p) => chip(p, providerLabel(p, t), options.filter((m) => m.provider === p).length))}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{t(isImage ? "defaultImageModel" : "defaultVideoModel")}</Label>
        <ModelChoiceSelect
          options={visible}
          value={model ? { provider: current?.provider ?? pinned, model } : null}
          onChange={(choice) => choice && setChoice(choice)}
          placeholder={loading ? t("modelsLoading") : noProvider ? t("enableProviderFirst") : t(isImage ? "selectImageModel" : "selectVideoModel")}
          disabled={visible.length === 0}
        />
        <ModelSummary option={current} />
        {missing && <p className="text-[11px] leading-4 text-amber-600/90">{t("usageMissing")}</p>}
      </div>
    </div>
  );
}

/**
 * Per-application slots for one media type, grouped by the stage that uses them. Each row picks
 * a platform (or follows the default) and then a model on that platform.
 */
export function UsageModelSelects({ mediaType, options }: { mediaType: GenMediaType; options: ModelOption[] }) {
  const t = useT("settings");
  const isImage = mediaType === "image";
  const usageModels = useSettingsStore((s) => s.usageModels);
  const setUsageModel = useSettingsStore((s) => s.setUsageModel);
  const defaultModel = useSettingsStore((s) => (isImage ? s.defaultImageModel : s.defaultVideoModel));
  const defaultPinned = useSettingsStore((s) => (isImage ? s.defaultImageProvider : s.defaultVideoProvider)) ?? "";

  const providers = providersOf(options);
  const defaultOption = findModelFor(options, defaultModel, defaultPinned);
  const defaultProvider = defaultOption?.provider ?? defaultPinned;
  const followLabel = defaultModel ? (
    <span className="flex min-w-0 items-center">
      <span className="mr-1 shrink-0">{t("usageFollowDefault")} ·</span>
      {/* the platform select beside it already names the platform */}
      {defaultOption ? <ModelLabel option={defaultOption} showProvider={false} /> : <span className="truncate">{defaultModel}</span>}
    </span>
  ) : t("usageFollowDefault");

  const stages = MODEL_USAGE_STAGES
    .map((stage) => ({ stage, usages: MODEL_USAGES.filter((u) => u.stage === stage && u.mediaType === mediaType) }))
    .filter((group) => group.usages.length > 0);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{t("usageCardTitle")}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("usageCardDesc")}</p>
      </div>
      {stages.map(({ stage, usages }) => (
        <div key={stage} className="rounded-xl border border-border/50">
          <div className="border-b border-border/50 bg-muted/20 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t(`usageStage_${stage}`)}
          </div>
          <div className="divide-y divide-border/40">
            {usages.map((usage) => {
              const own = usageChoice({ usageModels }, usage.id);
              const ownOption = own ? findModelFor(options, own.model, own.provider) : undefined;
              const missing = Boolean(own) && options.length > 0 && !ownOption;
              // the row's platform: its own pick, else the default's platform
              const rowProvider = own ? ownOption?.provider ?? own.provider : "";
              const modelOptions = own
                ? options.filter((m) => !rowProvider || m.provider === rowProvider)
                : options.filter((m) => !defaultProvider || m.provider === defaultProvider);
              return (
                <div key={usage.id} className="space-y-2 px-3 py-3">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <Label className="flex items-center gap-2 text-sm">
                      {t(`usage_${usage.id}`)}
                      {own && (
                        <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {t("usageOwnModel")}
                        </span>
                      )}
                    </Label>
                    <p className="text-[11px] leading-4 text-muted-foreground">{t(`usage_${usage.id}Desc`)}</p>
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
                      {/* platform: follow the default, or pin one (auto-picks a model it serves) */}
                      <Select
                        value={own ? rowProvider || ANY_PROVIDER : FOLLOW_DEFAULT}
                        onValueChange={(v) => {
                          if (!v || v === FOLLOW_DEFAULT) return setUsageModel(usage.id, null);
                          if (v === ANY_PROVIDER) return;
                          const inProvider = options.filter((m) => m.provider === v);
                          const keep = findModelFor(inProvider, own?.model ?? defaultModel);
                          const next = keep ?? inProvider[0];
                          if (next) setUsageModel(usage.id, { provider: next.provider, model: next.id });
                        }}
                        disabled={providers.length === 0 && !own}
                      >
                        <SelectTrigger className={`w-full ${own ? "" : "text-muted-foreground"}`} aria-label={t("usageProvider")}>
                          <SelectValue>
                            {(v: string) =>
                              v === FOLLOW_DEFAULT
                                ? defaultProvider
                                  ? `${t("usageFollowDefault")} · ${providerLabel(defaultProvider, t)}`
                                  : t("usageFollowDefault")
                                : v === ANY_PROVIDER
                                  ? t("usageAnyProvider")
                                  : providerLabel(v, t)
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={FOLLOW_DEFAULT}>{t("usageFollowDefault")}</SelectItem>
                          {own && !rowProvider && <SelectItem value={ANY_PROVIDER}>{t("usageAnyProvider")}</SelectItem>}
                          {providers.map((p) => (
                            <SelectItem key={p} value={p}>{providerLabel(p, t)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <ModelChoiceSelect
                        options={modelOptions}
                        value={own}
                        // picking a model while following pins it on the default's platform
                        onChange={(choice) => setUsageModel(usage.id, choice)}
                        placeholder={t(isImage ? "selectImageModel" : "selectVideoModel")}
                        leading={own ? undefined : { label: followLabel }}
                        disabled={modelOptions.length === 0 && !own}
                        muted={!own}
                      />
                    </div>
                    <ModelSummary option={own ? ownOption : defaultOption} />
                    {missing && <p className="text-[11px] leading-4 text-amber-600/90">{t("usageMissing")}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Generation platforms in display order, with their brand names. Chinese-named platforms carry a
 * settings i18n key so English users do not see "火山引擎" in a model list.
 */
export const GEN_PROVIDER_LABELS: readonly { key: string; name: string; nameKey?: string }[] = [
  { key: "atlas-cloud", name: "Atlas Cloud" },
  { key: "fal-ai", name: "fal.ai" },
  { key: "replicate", name: "Replicate" },
  { key: "volcengine", name: "火山引擎", nameKey: "providerVolcengineName" },
  { key: "alibaba", name: "阿里百炼", nameKey: "providerAlibabaName" },
  { key: "siliconflow", name: "硅基流动", nameKey: "providerSiliconflowName" },
  { key: "openai", name: "OpenAI" },
];

/** Display order index; unknown platforms sort last, alphabetically */
export function providerOrder(key: string): number {
  const i = GEN_PROVIDER_LABELS.findIndex((p) => p.key === key);
  return i < 0 ? GEN_PROVIDER_LABELS.length : i;
}

/** Brand name for a platform key, translated through the settings namespace when it has a key */
export function providerLabel(key: string, t: (key: string) => string): string {
  const entry = GEN_PROVIDER_LABELS.find((p) => p.key === key);
  if (!entry) return key;
  return entry.nameKey ? t(entry.nameKey) : entry.name;
}

/** Select value for a (provider, model) pair — a model id alone is ambiguous across platforms */
export function encodeModelChoice(provider: string, model: string): string {
  return `${provider}::${model}`;
}

/** Inverse of encodeModelChoice; provider keys never contain "::" so the first one splits */
export function decodeModelChoice(value: string): { provider: string; model: string } {
  const i = value.indexOf("::");
  return i < 0 ? { provider: "", model: value } : { provider: value.slice(0, i), model: value.slice(i + 2) };
}

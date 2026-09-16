"use client";

import { LuLanguages } from "react-icons/lu";
import { useT, useLocale, useSetLocale } from "@/lib/i18n";
import { LOCALES, LOCALE_LABELS, detectBrowserLocale } from "@/lib/i18n/config";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Interface-language section of the settings page.
 *
 * The sidebar already has a two-state toggle, but it can only flip between the languages: once a
 * user has touched it the choice is pinned (localeSource="user") with no way back to following the
 * system language. This section exposes all three states — 跟随系统 / 中文 / English — so the choice
 * is discoverable where users look for preferences, and reversible. Applies immediately and is
 * persisted with the rest of the settings store (localStorage).
 */
export function LanguageSetting() {
  const t = useT("settings");
  const locale = useLocale();
  const setLocale = useSetLocale();
  const localeSource = useSettingsStore((s) => s.localeSource);
  const followSystemLocale = useSettingsStore((s) => s.followSystemLocale);

  // "auto" is a source, not a locale: it stays selected only while the user has not pinned one
  const options = [
    { id: "auto" as const, label: t("langAuto"), active: localeSource === "auto", onPick: () => followSystemLocale(detectBrowserLocale()) },
    ...LOCALES.map((l) => ({
      id: l,
      label: LOCALE_LABELS[l],
      active: localeSource === "user" && locale === l,
      onPick: () => setLocale(l),
    })),
  ];

  return (
    <Card className="glass-card mb-8">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white">
            <LuLanguages className="w-4 h-4" />
          </div>
          <h3 className="font-semibold text-sm">{t("langTitle")}</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3 ml-10">{t("langDesc")}</p>

        <div className="ml-10 flex max-w-sm rounded-lg border border-border/50 p-0.5">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={o.active}
              onClick={o.onPick}
              className={`flex-1 rounded-md py-1.5 text-xs transition-colors ${
                o.active ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {localeSource === "auto" && (
          <p className="ml-10 mt-2 text-[11px] text-muted-foreground/80">
            {t("langAutoHint", { lang: LOCALE_LABELS[locale] })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

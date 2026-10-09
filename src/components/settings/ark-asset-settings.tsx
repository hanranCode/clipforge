"use client";

import { useState } from "react";
import { LuCheck, LuIdCard, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { isArkAssetConfigured, type ArkAssetCredentials } from "@/lib/ark-portrait";

/**
 * Access Key for the Ark private portrait library. Seedance 2.x only takes a real person's face
 * through that library (asset://<id>); its management API is signed with AK/SK, separately from
 * the inference API key configured with the Volcengine platform.
 */
export function ArkAssetSettings() {
  const t = useT("settings");
  const arkAssets = useSettingsStore((s) => s.arkAssets);
  const setArkAssets = useSettingsStore((s) => s.setArkAssets);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const update = (patch: Partial<ArkAssetCredentials>) => {
    setResult(null);
    setArkAssets({ ...arkAssets, ...patch });
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch("/api/ark-portrait", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "groups", credentials: arkAssets }),
      });
      const data = await res.json().catch(() => ({}));
      setResult(
        res.ok
          ? { ok: true, message: t("arkAssetTestOk", { n: (data.groups as unknown[] | undefined)?.length ?? 0 }) }
          : { ok: false, message: data.error || t("arkAssetTestFailed") },
      );
    } catch {
      setResult({ ok: false, message: t("arkAssetTestFailed") });
    } finally {
      setTesting(false);
    }
  };

  const field = (key: keyof ArkAssetCredentials, label: string, placeholder: string, type = "text") => (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type={type}
        value={String(arkAssets?.[key] ?? "")}
        onChange={(e) => update({ [key]: e.target.value })}
        placeholder={placeholder}
        className="text-sm"
        autoComplete="off"
      />
    </div>
  );

  return (
    <Card className="glass-card">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 text-white">
            <LuIdCard className="size-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("arkAssetTitle")}</h3>
            <p className="text-xs leading-5 text-muted-foreground">{t("arkAssetSubtitle")}</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {field("accessKeyId", t("storageAccessKey"), "AKLT…")}
          {field("secretAccessKey", t("storageSecretKey"), "••••••", "password")}
          {field("projectName", t("arkAssetProject"), "default")}
          {field("region", t("storageRegion"), "cn-beijing")}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={test} disabled={testing || !isArkAssetConfigured(arkAssets)}>
            {testing ? <LuLoaderCircle className="animate-spin" /> : <LuCheck />}
            {t("arkAssetTest")}
          </Button>
          {result && (
            <span className={`flex items-center gap-1 text-xs ${result.ok ? "text-emerald-600" : "text-destructive"}`}>
              {result.ok ? <LuCheck className="size-3.5" /> : <LuTriangleAlert className="size-3.5" />}
              {result.message}
            </span>
          )}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">{t("arkAssetHint")}</p>
      </CardContent>
    </Card>
  );
}

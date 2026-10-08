"use client";

import { useState } from "react";
import { LuCheck, LuCloudUpload, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { isObjectStorageConfigured, type ObjectStorageConfig } from "@/lib/object-storage";

/** Ready-made endpoints; the region is the part users most often get wrong */
const PRESETS: Array<{ label: string; endpoint: string; region: string; pathStyle?: boolean }> = [
  { label: "火山 TOS · 北京", endpoint: "https://tos-s3-cn-beijing.volces.com", region: "cn-beijing" },
  { label: "火山 TOS · 上海", endpoint: "https://tos-s3-cn-shanghai.volces.com", region: "cn-shanghai" },
  { label: "阿里云 OSS · 杭州", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "oss-cn-hangzhou" },
  { label: "AWS S3 · us-east-1", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1" },
];

/**
 * S3-compatible bucket settings. Volcengine Ark only fetches reference videos from a public URL, so
 * a local clip is uploaded here first and handed over as a presigned link (the bucket stays private).
 */
export function ObjectStorageSettings() {
  const t = useT("settings");
  const objectStorage = useSettingsStore((s) => s.objectStorage);
  const setObjectStorage = useSettingsStore((s) => s.setObjectStorage);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const update = (patch: Partial<ObjectStorageConfig>) => {
    setResult(null);
    setObjectStorage({ ...objectStorage, ...patch });
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch("/api/storage/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectStorage }),
      });
      const data = await res.json().catch(() => ({}));
      setResult(res.ok ? { ok: true, message: t("storageTestOk") } : { ok: false, message: data.error || t("storageTestFailed") });
    } catch {
      setResult({ ok: false, message: t("storageTestFailed") });
    } finally {
      setTesting(false);
    }
  };

  const field = (key: keyof ObjectStorageConfig, label: string, placeholder: string, type = "text") => (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type={type}
        value={String(objectStorage[key] ?? "")}
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
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 text-white">
            <LuCloudUpload className="size-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("storageTitle")}</h3>
            <p className="text-xs leading-5 text-muted-foreground">{t("storageSubtitle")}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => update({ endpoint: p.endpoint, region: p.region, pathStyle: Boolean(p.pathStyle) })}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                objectStorage.endpoint === p.endpoint ? "border-primary bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {field("endpoint", t("storageEndpoint"), "https://tos-s3-cn-beijing.volces.com")}
          {field("region", t("storageRegion"), "cn-beijing")}
          {field("bucket", t("storageBucket"), "my-bucket")}
          {field("prefix", t("storagePrefix"), "clipforge/")}
          {field("accessKeyId", t("storageAccessKey"), "AKLT…")}
          {field("secretAccessKey", t("storageSecretKey"), "••••••", "password")}
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={Boolean(objectStorage.pathStyle)} onChange={(e) => update({ pathStyle: e.target.checked })} />
          {t("storagePathStyle")}
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={test} disabled={testing || !isObjectStorageConfigured(objectStorage)}>
            {testing ? <LuLoaderCircle className="animate-spin" /> : <LuCheck />}
            {t("storageTest")}
          </Button>
          {result && (
            <span className={`flex items-center gap-1 text-xs ${result.ok ? "text-emerald-600" : "text-destructive"}`}>
              {result.ok ? <LuCheck className="size-3.5" /> : <LuTriangleAlert className="size-3.5" />}
              {result.message}
            </span>
          )}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">{t("storageHint")}</p>
      </CardContent>
    </Card>
  );
}

"use client";

import { useRef, useState } from "react";
import { LuLink, LuLoaderCircle, LuUpload } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MATERIAL_ACCEPT } from "@/lib/material-library";
import { formatBytes } from "@/lib/asset-library";
import { useT } from "@/lib/i18n";

type ImportMode = "upload" | "link";

/** The description fields, shared by both doors — they are the whole point of importing by hand. */
interface MetaForm {
  title: string;
  description: string;
  tags: string;
  author: string;
  license: string;
  sourceUrl: string;
}

const EMPTY_META: MetaForm = { title: "", description: "", tags: "", author: "", license: "", sourceUrl: "" };

/** One labelled field; `hint` sits under the control where it is read, not in a tooltip. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The library's import door.
 *
 * Material reaches the library two ways and neither involves a project: a file picked from disk, or
 * a link the server downloads. The second is there because the practical way to get a clip off a
 * playback page is a browser download-helper extension, which hands you a direct media URL —
 * pasting that is faster than saving to Downloads and picking it back up, and the copy that lands
 * here is the same file either way.
 *
 * Both paths carry the same description form. A generated asset can always fall back on its prompt;
 * an import has nothing, so whatever is typed here is the only thing that will find it again.
 */
export function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const t = useT("assetLibrary");
  const fileInput = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<ImportMode>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [meta, setMeta] = useState<MetaForm>(EMPTY_META);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (key: keyof MetaForm) => (value: string) => setMeta((current) => ({ ...current, [key]: value }));

  const reset = () => {
    setFile(null);
    setUrl("");
    setMeta(EMPTY_META);
    setError("");
    if (fileInput.current) fileInput.current.value = "";
  };

  const close = (next: boolean) => {
    if (busy) return; // an import in flight owns the dialog until it resolves
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = async () => {
    setError("");
    if (mode === "upload" && !file) return setError(t("importNeedFile"));
    if (mode === "link" && !url.trim()) return setError(t("importNeedUrl"));

    setBusy(true);
    try {
      let response: Response;
      if (mode === "upload") {
        const body = new FormData();
        body.set("file", file as File);
        for (const [key, value] of Object.entries(meta)) if (value.trim()) body.set(key, value.trim());
        response = await fetch("/api/materials/import", { method: "POST", body });
      } else {
        response = await fetch("/api/materials/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim(), ...meta }),
        });
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || t("importFailed"));
      }
      reset();
      onOpenChange(false);
      onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("importFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] max-w-lg overflow-y-auto p-4 sm:max-w-lg">
        <DialogTitle className="text-sm">{t("importTitle")}</DialogTitle>

        {/* which door: a local file, or a link the server fetches */}
        <div className="mt-2 flex rounded-lg border border-border/60 p-0.5">
          {(["upload", "link"] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={busy}
              onClick={() => {
                setMode(value);
                setError("");
              }}
              className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs transition-colors disabled:opacity-60 ${
                mode === value ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {value === "upload" ? <LuUpload className="h-3.5 w-3.5" /> : <LuLink className="h-3.5 w-3.5" />}
              {t(value === "upload" ? "importTabUpload" : "importTabLink")}
            </button>
          ))}
        </div>

        <div className="mt-3 space-y-3">
          {mode === "upload" ? (
            <Field label={t("importFile")} hint={t("importFileHint")}>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
                  {t("importFilePick")}
                </Button>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {file ? `${file.name} · ${formatBytes(file.size)}` : "—"}
                </span>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept={MATERIAL_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  const picked = event.target.files?.[0] ?? null;
                  setFile(picked);
                  setError("");
                  // a file name beats an empty name field, and stays editable
                  if (picked && !meta.title.trim()) set("title")(picked.name.replace(/\.[^.]*$/, ""));
                }}
              />
            </Field>
          ) : (
            <Field label={t("importUrl")} hint={t("importUrlHint")}>
              <Input
                value={url}
                disabled={busy}
                placeholder={t("importUrlPlaceholder")}
                onChange={(event) => setUrl(event.target.value)}
                className="h-9"
              />
            </Field>
          )}

          <Field label={t("importName")}>
            <Input
              value={meta.title}
              disabled={busy}
              maxLength={120}
              placeholder={t("importNamePlaceholder")}
              onChange={(event) => set("title")(event.target.value)}
              className="h-9"
            />
          </Field>

          <Field label={t("importDescription")}>
            <Textarea
              value={meta.description}
              disabled={busy}
              maxLength={2000}
              rows={3}
              placeholder={t("importDescriptionPlaceholder")}
              onChange={(event) => set("description")(event.target.value)}
              className="text-sm"
            />
          </Field>

          <Field label={t("importTags")}>
            <Input
              value={meta.tags}
              disabled={busy}
              placeholder={t("importTagsPlaceholder")}
              onChange={(event) => set("tags")(event.target.value)}
              className="h-9"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("importAuthor")}>
              <Input
                value={meta.author}
                disabled={busy}
                maxLength={120}
                placeholder={t("importAuthorPlaceholder")}
                onChange={(event) => set("author")(event.target.value)}
                className="h-9"
              />
            </Field>
            <Field label={t("importLicense")}>
              <Input
                value={meta.license}
                disabled={busy}
                maxLength={120}
                placeholder={t("importLicensePlaceholder")}
                onChange={(event) => set("license")(event.target.value)}
                className="h-9"
              />
            </Field>
          </div>

          {/* a link import already knows where it came from; only an upload has to be told */}
          {mode === "upload" && (
            <Field label={t("importSourceUrl")}>
              <Input
                value={meta.sourceUrl}
                disabled={busy}
                placeholder={t("importSourceUrlPlaceholder")}
                onChange={(event) => set("sourceUrl")(event.target.value)}
                className="h-9"
              />
            </Field>
          )}
        </div>

        {error && <p className="mt-3 text-xs leading-5 text-destructive">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => close(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={submit}>
            {busy && <LuLoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {busy ? t(mode === "link" ? "importDownloading" : "importSubmitting") : t("importSubmit")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

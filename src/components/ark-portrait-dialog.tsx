"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { LuCheck, LuCopy, LuIdCard, LuLoaderCircle, LuPlus, LuRefreshCw, LuSparkles, LuTrash2, LuUpload, LuX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore, type Character } from "@/lib/stores/project-store";
import { isObjectStorageConfigured } from "@/lib/object-storage";
import { buildImageOptions, resolveDefaultModelTarget } from "@/lib/gen-params";
import { modelForUsage, providerForUsage } from "@/lib/model-usage";
import type { PortraitShot } from "@/lib/character-sheet";
import {
  isArkAssetConfigured,
  isSessionLive,
  mergeAssetStatus,
  parseAssetId,
  parseGroupId,
  portraitKind,
  type ArkPortrait,
  type ArkPortraitAsset,
  type ArkPortraitKind,
} from "@/lib/ark-portrait";

/* eslint-disable @next/next/no-img-element -- thumbnails are local uploads served by our own API */

const POLL_MS = 5000;
/** The two single-person vertical shots Ark recommends registering for a portrait */
const PORTRAIT_SHOTS: PortraitShot[] = ["fullBody", "faceCloseup"];

async function arkCall<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/ark-portrait", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

const STATUS_STYLE: Record<ArkPortraitAsset["status"], string> = {
  Active: "bg-emerald-500/15 text-emerald-600",
  Processing: "bg-amber-500/15 text-amber-600",
  Failed: "bg-destructive/15 text-destructive",
};

/**
 * One presenter's link to the Ark portrait library, as a real person or as an AI virtual portrait:
 *  1. bind an Asset Group — real: run the H5 liveness check (QR / link for the person), or enter /
 *     pick a group created in the Ark console's invitation flow; virtual: create an AIGC group
 *     (no verification), or pick / enter an existing one;
 *  2. register the presenter's images as assets and keep their IDs — real uploads are face-matched
 *     against the verified person, virtual ones are content-reviewed; a virtual presenter can have
 *     the two recommended shots (full body, face close-up) generated from its sheet and registered
 *     in one go. Asset IDs authorised from another account can be added by hand.
 * Remakes then send asset://<id> in place of the matching image.
 */
export function ArkPortraitDialog({ presenterId, onClose }: { presenterId: string | null; onClose: () => void }) {
  const t = useT("settings");
  const presenter = useCharacterStore((s) => s.characters.find((c) => c.id === presenterId) ?? null);
  const updateCharacter = useCharacterStore((s) => s.updateCharacter);
  const credentials = useSettingsStore((s) => s.arkAssets);
  const objectStorage = useSettingsStore((s) => s.objectStorage);
  const settings = useSettingsStore();
  const ready = isArkAssetConfigured(credentials);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [qr, setQr] = useState("");
  const [groupInput, setGroupInput] = useState("");
  const [assetInput, setAssetInput] = useState("");
  const [groups, setGroups] = useState<Array<{ id: string; name?: string }> | null>(null);
  const [copied, setCopied] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const portrait: ArkPortrait = presenter?.arkPortrait ?? { assets: [] };
  const kind = portraitKind(portrait);
  // always patch the latest copy: polls and uploads overlap
  const patch = useCallback(
    (fn: (current: ArkPortrait) => ArkPortrait) => {
      if (!presenterId) return;
      const current = useCharacterStore.getState().characters.find((c) => c.id === presenterId)?.arkPortrait ?? { assets: [] };
      updateCharacter(presenterId, { arkPortrait: fn(current) });
    },
    [presenterId, updateCharacter],
  );

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      window.setTimeout(() => setCopied(""), 1500);
    });
  };

  // ---------- step 1: group ----------

  const session = isSessionLive(portrait.session) ? portrait.session : undefined;

  useEffect(() => {
    if (!session) return setQr("");
    let cancelled = false;
    QRCode.toDataURL(session.h5Link, { width: 220, margin: 1, errorCorrectionLevel: "L" })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQr(""));
    return () => {
      cancelled = true;
    };
  }, [session]);

  // the person verifies on their phone, so the callback page may never reach this machine: poll
  useEffect(() => {
    if (!session || !ready || portrait.groupId) return;
    const timer = window.setInterval(() => {
      arkCall<{ groupId: string | null }>({ op: "result", credentials, bytedToken: session.bytedToken })
        .then(({ groupId }) => {
          if (groupId) patch((p) => ({ ...p, kind: "real", groupId, session: undefined }));
        })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [session, ready, portrait.groupId, credentials, patch]);

  const startSession = () =>
    run("session", async () => {
      const callbackUrl = `${window.location.origin}/presenters/ark-callback/${presenterId}`;
      const r = await arkCall<{ h5Link: string; bytedToken: string }>({ op: "session", credentials, callbackUrl });
      patch((p) => ({ ...p, session: { ...r, createdAt: new Date().toISOString() } }));
    });

  const checkSession = () =>
    run("check", async () => {
      if (!session) return;
      const { groupId } = await arkCall<{ groupId: string | null }>({ op: "result", credentials, bytedToken: session.bytedToken });
      if (groupId) patch((p) => ({ ...p, kind: "real", groupId, session: undefined }));
      else setError(t("arkSessionPending"));
    });

  const setKind = (next: ArkPortraitKind) => {
    patch((p) => ({ ...p, kind: next }));
    setGroups(null);
  };

  const bindGroup = (id: string | null) => {
    if (!id) return;
    patch((p) => ({ ...p, kind, groupId: id, session: undefined }));
    setGroupInput("");
    setGroups(null);
  };

  const loadGroups = () => run("groups", async () => setGroups((await arkCall<{ groups: Array<{ id: string; name?: string }> }>({ op: "groups", credentials, kind })).groups));

  const createVirtualGroup = () =>
    run("createGroup", async () => {
      if (!presenter) return;
      const { groupId } = await arkCall<{ groupId: string }>({
        op: "createGroup",
        credentials,
        name: presenter.name,
        description: presenter.description || presenter.appearance?.slice(0, 200) || undefined,
      });
      patch((p) => ({ ...p, kind: "virtual", groupId, session: undefined }));
    });

  // ---------- step 2: assets ----------

  const processingIds = portrait.assets.filter((a) => a.status === "Processing").map((a) => a.id).join(",");
  useEffect(() => {
    if (!processingIds || !ready) return;
    const timer = window.setInterval(() => {
      arkCall<{ assets: Array<Partial<ArkPortraitAsset> & { id: string; unreadable?: string }> }>({ op: "status", credentials, ids: processingIds.split(",") })
        .then(({ assets }) => {
          const readable = assets.filter((a): a is ArkPortraitAsset => !a.unreadable && Boolean(a.status));
          if (readable.length) patch((p) => ({ ...p, assets: mergeAssetStatus(p.assets, readable) }));
        })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [processingIds, ready, credentials, patch]);

  /** Upload one image into the bound group and remember it as Processing */
  const createImageAsset = async (sourceUrl: string, name: string) => {
    if (!portrait.groupId) throw new Error(t("arkNeedGroup"));
    const { id } = await arkCall<{ id: string }>({
      op: "create",
      credentials,
      groupId: portrait.groupId,
      url: sourceUrl,
      type: "Image",
      name,
      objectStorage: isObjectStorageConfigured(objectStorage) ? objectStorage : undefined,
    });
    patch((p) => ({ ...p, assets: [...p.assets, { id, type: "Image", status: "Processing", sourceUrl, name, createdAt: new Date().toISOString() }] }));
  };

  const register = (sourceUrl: string, name: string) => run(`create:${sourceUrl}`, () => createImageAsset(sourceUrl, name));

  // virtual presenter: render the two recommended shots from its sheet, keep them as reference
  // images, and register both
  const generateShots = () =>
    run("generate", async () => {
      if (!presenter) return;
      if (!portrait.groupId) throw new Error(t("arkNeedGroup"));
      if (!presenter.appearance?.trim()) throw new Error(t("characterSheetNeedsAppearance"));
      const target = await resolveDefaultModelTarget(
        settings.providers,
        modelForUsage(settings, "characterSheet"),
        settings.customModels,
        "image",
        providerForUsage(settings, "characterSheet"),
      );
      if (!target) throw new Error(t("characterSheetNoModel"));
      const sheet = presenter.referenceImages?.[0];
      for (const shot of PORTRAIT_SHOTS) {
        const res = await fetch("/api/characters/sheet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appearance: presenter.appearance,
            name: presenter.name,
            shot,
            ...(sheet && { referenceImageUrl: sheet }),
            provider: target.provider,
            model: target.model,
            apiKey: target.apiKey,
            baseUrl: target.baseUrl,
            options: buildImageOptions({ ...settings.imageParams, aspectRatio: "9:16", count: 1 }),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(data.error || t("characterSheetFailed"));
        const url = data.url;
        const latest = useCharacterStore.getState().characters.find((c) => c.id === presenter.id);
        updateCharacter(presenter.id, { referenceImages: [...(latest?.referenceImages ?? []), url] });
        await createImageAsset(url, `${presenter.name}-${t(`arkShot_${shot}`)}`);
      }
    });

  const uploadAndRegister = (files: FileList | null) =>
    run("upload", async () => {
      const file = files?.[0];
      if (!file || !presenter) return;
      const form = new FormData();
      form.append("files", file);
      form.append("projectId", "presenters");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as { paths?: string[]; error?: string };
      const path = data.paths?.[0];
      if (!res.ok || !path) throw new Error(data.error || t("arkUploadFailed"));
      if (!portrait.groupId) throw new Error(t("arkNeedGroup"));
      const { id } = await arkCall<{ id: string }>({
        op: "create",
        credentials,
        groupId: portrait.groupId,
        url: path,
        type: "Image",
        name: `${presenter.name}-${file.name}`,
        objectStorage: isObjectStorageConfigured(objectStorage) ? objectStorage : undefined,
      });
      patch((p) => ({ ...p, assets: [...p.assets, { id, type: "Image", status: "Processing", sourceUrl: path, name: file.name, createdAt: new Date().toISOString() }] }));
    });

  const sync = () =>
    run("sync", async () => {
      const updates: Array<Partial<ArkPortraitAsset> & { id: string; status: ArkPortraitAsset["status"] }> = [];
      if (portrait.groupId) updates.push(...(await arkCall<{ assets: ArkPortraitAsset[] }>({ op: "list", credentials, groupId: portrait.groupId, kind })).assets);
      const listed = new Set(updates.map((u) => u.id));
      const rest = portrait.assets.map((a) => a.id).filter((id) => !listed.has(id));
      if (rest.length) {
        const { assets } = await arkCall<{ assets: Array<Partial<ArkPortraitAsset> & { id: string; unreadable?: string }> }>({ op: "status", credentials, ids: rest });
        updates.push(...assets.filter((a): a is ArkPortraitAsset => !a.unreadable && Boolean(a.status)));
      }
      patch((p) => ({ ...p, assets: mergeAssetStatus(p.assets, updates) }));
    });

  const addAssetId = () => {
    const id = parseAssetId(assetInput);
    if (!id || portrait.assets.some((a) => a.id === id)) return;
    // authorised from another account: not readable through the management API, assume usable
    patch((p) => ({ ...p, assets: [...p.assets, { id, type: "Image", status: "Active", createdAt: new Date().toISOString() }] }));
    setAssetInput("");
  };

  const removeAsset = (id: string) => patch((p) => ({ ...p, assets: p.assets.filter((a) => a.id !== id) }));
  const setSource = (id: string, sourceUrl: string | undefined) =>
    patch((p) => ({ ...p, assets: p.assets.map((a) => (a.id === id ? { ...a, sourceUrl } : a)) }));

  const registered = new Set(portrait.assets.map((a) => a.sourceUrl).filter(Boolean));
  const photos = (presenter?.referenceImages ?? []).filter((url) => url.startsWith("/api/files/") || /^https?:\/\//.test(url));

  return (
    <Dialog open={presenterId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto p-5 sm:max-w-2xl">
        <DialogTitle className="flex items-center gap-2 text-sm">
          <LuIdCard className="size-4" />
          {t("arkDialogTitle", { name: presenter?.name ?? "" })}
        </DialogTitle>
        <p className="text-xs leading-5 text-muted-foreground">{t("arkDialogIntro")}</p>
        {ready && !portrait.groupId && (
          <div role="radiogroup" aria-label={t("arkKindLabel")} className="grid gap-2 sm:grid-cols-2">
            {(["real", "virtual"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-lg border p-3 text-left transition-colors ${kind === k ? "border-primary bg-primary/5" : "border-border/60 hover:border-primary/40"}`}
              >
                <p className="text-sm font-medium">{t(`arkKind_${k}`)}</p>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{t(`arkKindDesc_${k}`)}</p>
              </button>
            ))}
          </div>
        )}

        {!ready ? (
          <div className="rounded-lg border border-dashed border-border/60 p-4 text-xs text-muted-foreground">
            {t("arkNeedCredentials")}{" "}
            <Link href="/settings?tab=storage" className="text-primary hover:underline">
              {t("arkOpenSettings")}
            </Link>
          </div>
        ) : (
          <div className="space-y-5">
            {error && (
              <div className="flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <span>{error}</span>
                <button type="button" aria-label={t("characterCancel")} onClick={() => setError("")}>
                  <LuX className="size-3.5" />
                </button>
              </div>
            )}

            {/* step 1 — the person's asset group */}
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t(kind === "virtual" ? "arkGroupTitleVirtual" : "arkGroupTitle")}</h3>
              {portrait.groupId ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
                  <LuCheck className="size-3.5 text-emerald-600" />
                  <span>{t("arkGroupBound")}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t(`arkKind_${kind}`)}</span>
                  <code className="font-mono">{portrait.groupId}</code>
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => copy(portrait.groupId!)} aria-label="copy">
                    {copied === portrait.groupId ? <LuCheck className="size-3.5" /> : <LuCopy className="size-3.5" />}
                  </button>
                  <button type="button" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => patch((p) => ({ ...p, groupId: undefined }))}>
                    {t("arkUnbind")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {kind === "virtual" ? (
                      <Button size="sm" onClick={createVirtualGroup} disabled={busy !== null}>
                        {busy === "createGroup" ? <LuLoaderCircle className="animate-spin" /> : <LuPlus />}
                        {t("arkCreateVirtualGroup")}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={startSession} disabled={busy !== null}>
                        {busy === "session" ? <LuLoaderCircle className="animate-spin" /> : <LuIdCard />}
                        {session ? t("arkSessionRestart") : t("arkSessionStart")}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={loadGroups} disabled={busy !== null}>
                      {busy === "groups" ? <LuLoaderCircle className="animate-spin" /> : <LuRefreshCw />}
                      {t("arkPickGroup")}
                    </Button>
                  </div>
                  {kind === "real" && session && (
                    <div className="flex flex-wrap gap-4 rounded-lg border border-border/60 bg-muted/20 p-3">
                      {qr && <img src={qr} alt={t("arkSessionQrAlt")} className="size-36 rounded bg-white p-1" />}
                      <div className="min-w-0 flex-1 space-y-2 text-xs">
                        <p className="leading-5 text-muted-foreground">{t("arkSessionHint")}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => copy(session.h5Link)}>
                            {copied === session.h5Link ? <LuCheck /> : <LuCopy />}
                            {t("arkCopyLink")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={checkSession} disabled={busy !== null}>
                            {busy === "check" ? <LuLoaderCircle className="animate-spin" /> : <LuRefreshCw />}
                            {t("arkSessionCheck")}
                          </Button>
                        </div>
                        <p className="flex items-center gap-1 text-muted-foreground">
                          <LuLoaderCircle className="size-3 animate-spin" />
                          {t("arkSessionWaiting")}
                        </p>
                      </div>
                    </div>
                  )}
                  {groups && (
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
                      {groups.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("arkNoGroups")}</p>
                      ) : (
                        groups.map((g) => (
                          <button
                            key={g.id}
                            type="button"
                            onClick={() => bindGroup(g.id)}
                            className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted"
                          >
                            <span className="truncate">{g.name || "—"}</span>
                            <code className="font-mono text-muted-foreground">{g.id}</code>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={groupInput}
                      onChange={(e) => setGroupInput(e.target.value)}
                      placeholder="group-2026…"
                      aria-label={t("arkGroupInput")}
                      className="h-8 font-mono text-xs"
                    />
                    <Button size="sm" variant="outline" disabled={!parseGroupId(groupInput)} onClick={() => bindGroup(parseGroupId(groupInput))}>
                      {t("arkBind")}
                    </Button>
                  </div>
                  <p className="text-[11px] leading-4 text-muted-foreground">{t(kind === "virtual" ? "arkGroupHintVirtual" : "arkGroupHint")}</p>
                </>
              )}
            </section>

            {/* step 2 — assets */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{t("arkAssetsTitle")}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {kind === "virtual" && (
                    <Button size="sm" disabled={!portrait.groupId || busy !== null} onClick={generateShots} title={t("arkGenerateShotsTip")}>
                      {busy === "generate" ? <LuLoaderCircle className="animate-spin" /> : <LuSparkles />}
                      {busy === "generate" ? t("arkGeneratingShots") : t("arkGenerateShots")}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={!portrait.groupId || busy !== null} onClick={() => fileRef.current?.click()}>
                    {busy === "upload" ? <LuLoaderCircle className="animate-spin" /> : <LuUpload />}
                    {t("arkUploadPhoto")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null || (!portrait.groupId && !portrait.assets.length)} onClick={sync}>
                    {busy === "sync" ? <LuLoaderCircle className="animate-spin" /> : <LuRefreshCw />}
                    {t("arkSync")}
                  </Button>
                </div>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  void uploadAndRegister(e.target.files);
                  e.target.value = "";
                }}
              />

              {portrait.groupId && photos.some((url) => !registered.has(url)) && (
                <div className="flex flex-wrap gap-2 rounded-lg border border-dashed border-border/60 p-2">
                  {photos
                    .filter((url) => !registered.has(url))
                    .map((url, i) => (
                      <div key={url} className="w-24 space-y-1">
                        <img src={url} alt="" className="aspect-square w-full rounded object-cover" />
                        <Button size="sm" variant="outline" className="h-7 w-full text-[11px]" disabled={busy !== null} onClick={() => register(url, `${presenter?.name ?? ""}-${i + 1}`)}>
                          {busy === `create:${url}` ? <LuLoaderCircle className="animate-spin" /> : <LuPlus />}
                          {t("arkRegister")}
                        </Button>
                      </div>
                    ))}
                </div>
              )}

              {portrait.assets.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">{t("arkNoAssets")}</p>
              ) : (
                <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
                  {portrait.assets.map((asset) => (
                    <li key={asset.id} className="flex items-center gap-3 p-2">
                      {asset.sourceUrl ? (
                        <img src={asset.sourceUrl} alt="" className="size-12 shrink-0 rounded object-cover" />
                      ) : (
                        <div className="flex size-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                          <LuIdCard className="size-5" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1 space-y-0.5 text-xs">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <code className="truncate font-mono">{asset.id}</code>
                          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => copy(`asset://${asset.id}`)} aria-label="copy">
                            {copied === `asset://${asset.id}` ? <LuCheck className="size-3" /> : <LuCopy className="size-3" />}
                          </button>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[asset.status]}`}>{t(`arkStatus_${asset.status}`)}</span>
                        </div>
                        {asset.error && <p className="text-destructive">{asset.error}</p>}
                        {!asset.sourceUrl && photos.length > 0 && (
                          <select
                            className="h-6 rounded border border-border/60 bg-background px-1 text-[11px] text-muted-foreground"
                            value=""
                            onChange={(e) => setSource(asset.id, e.target.value || undefined)}
                            aria-label={t("arkLinkPhoto")}
                          >
                            <option value="">{t("arkLinkPhoto")}</option>
                            {photos.map((url, i) => (
                              <option key={url} value={url}>
                                {t("arkPhotoN", { n: i + 1 })}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      <button type="button" aria-label={t("arkRemoveAsset")} className="text-muted-foreground hover:text-destructive" onClick={() => removeAsset(asset.id)}>
                        <LuTrash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex gap-2">
                <Input
                  value={assetInput}
                  onChange={(e) => setAssetInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addAssetId()}
                  placeholder="asset://asset-2026…"
                  aria-label={t("arkAddAssetId")}
                  className="h-8 font-mono text-xs"
                />
                <Button size="sm" variant="outline" disabled={!parseAssetId(assetInput)} onClick={addAssetId}>
                  <LuPlus />
                  {t("arkAddAssetId")}
                </Button>
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">{t(kind === "virtual" ? "arkAssetsHintVirtual" : "arkAssetsHint")}</p>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Small badge for a presenter card: how many usable asset IDs it has */
export function arkActiveCount(presenter: Pick<Character, "arkPortrait">): number {
  return presenter.arkPortrait?.assets.filter((a) => a.status === "Active").length ?? 0;
}

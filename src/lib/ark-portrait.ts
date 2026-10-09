/**
 * 火山方舟私域人像素材库 (Ark portrait asset library) — the client-safe half.
 *
 * Seedance 2.x refuses reference media showing a person's face unless it comes from the account's
 * asset library and is referenced as `asset://<asset id>`. The library is organised as Asset Groups
 * holding Assets (images, videos, audio), each usable once its status is Active. Two kinds of group:
 * a real person's (created by that person passing an H5 liveness check, or accepting an invitation
 * in the Ark console; uploads are face-matched) and an AI-generated virtual portrait's (created
 * through the API; uploads are content-reviewed only).
 *
 * A presenter in the presenter library keeps its group ID and the IDs of the assets made from its
 * own images, so a remake can swap a presenter image for its asset:// reference automatically.
 * Management calls are signed with an Access Key (AK/SK), not the inference API key; signing and
 * the calls themselves live in ark-portrait-server.ts.
 */

export interface ArkAssetCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Ark project the assets live in; the inference endpoint must be in the same project */
  projectName?: string;
  region?: string;
}

export const ARK_ASSET_DEFAULT_REGION = "cn-beijing";
export const ARK_ASSET_DEFAULT_PROJECT = "default";

export type ArkAssetStatus = "Processing" | "Active" | "Failed";
export type ArkAssetType = "Image" | "Video" | "Audio";

/** One asset as a presenter remembers it */
export interface ArkPortraitAsset {
  /** asset-2026… (referenced as asset://<id>) */
  id: string;
  type: ArkAssetType;
  status: ArkAssetStatus;
  /** The local image/clip it was made from, when it was uploaded from here — the substitution key */
  sourceUrl?: string;
  name?: string;
  /** Why Ark failed it (consistency check, multiple faces…) */
  error?: string;
  createdAt: string;
}

/**
 * real = a real person, bound through an H5 liveness check (or a console invitation) and
 * face-matched on every upload; virtual = an AI-generated likeness in a group we create ourselves,
 * content-reviewed only.
 */
export type ArkPortraitKind = "real" | "virtual";

/** The presenter's link to the Ark portrait library */
export interface ArkPortrait {
  /** Which library the group belongs to; absent on links made before virtual portraits = real */
  kind?: ArkPortraitKind;
  /** group-2026…: the Asset Group holding this presenter's likeness */
  groupId?: string;
  /** Liveness check in progress: the H5 link to send the person, and the token that reads the result */
  session?: { h5Link: string; bytedToken: string; createdAt: string };
  assets: ArkPortraitAsset[];
}

export function isArkAssetConfigured(value: unknown): value is ArkAssetCredentials {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return ["accessKeyId", "secretAccessKey"].every((k) => typeof c[k] === "string" && (c[k] as string).trim().length > 0);
}

/** The liveness token is valid for 30 minutes */
export const ARK_SESSION_TTL_MS = 30 * 60 * 1000;

export function isSessionLive(session: ArkPortrait["session"], now = Date.now()): boolean {
  return Boolean(session && now - Date.parse(session.createdAt) < ARK_SESSION_TTL_MS);
}

const ASSET_ID = /^asset-[A-Za-z0-9-]+$/;
const GROUP_ID = /^group-[A-Za-z0-9-]+$/;

/** Accept "asset://asset-…" or a bare "asset-…" */
export function parseAssetId(input: string): string | null {
  const id = input.trim().replace(/^asset:\/\//, "");
  return ASSET_ID.test(id) ? id : null;
}

export function parseGroupId(input: string): string | null {
  const id = input.trim();
  return GROUP_ID.test(id) ? id : null;
}

export const assetUri = (id: string) => `asset://${id}`;

/** Active image assets of every presenter, keyed by the local image each was made from */
export function activeAssetsBySource(presenters: Array<{ arkPortrait?: ArkPortrait }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of presenters) {
    for (const asset of p.arkPortrait?.assets ?? []) {
      if (asset.status === "Active" && asset.type === "Image" && asset.sourceUrl && !map.has(asset.sourceUrl)) {
        map.set(asset.sourceUrl, assetUri(asset.id));
      }
    }
  }
  return map;
}

/**
 * Swap every reference image that a presenter has registered for its asset:// reference. Images
 * without a registered asset pass through unchanged (Ark may still accept them: products, scenes).
 */
export function substituteArkAssets(urls: string[], bySource: Map<string, string>): string[] {
  return urls.map((url) => bySource.get(url) ?? url);
}

/** Merge a fresh status read into the remembered assets, keeping what only we know (sourceUrl) */
export function mergeAssetStatus(
  assets: ArkPortraitAsset[],
  updates: Array<Pick<ArkPortraitAsset, "id" | "status"> & Partial<ArkPortraitAsset>>,
): ArkPortraitAsset[] {
  const byId = new Map(updates.map((u) => [u.id, u]));
  const merged = assets.map((a) => {
    const u = byId.get(a.id);
    return u ? { ...a, status: u.status, ...(u.error !== undefined && { error: u.error }), ...(u.name && !a.name && { name: u.name }) } : a;
  });
  const known = new Set(assets.map((a) => a.id));
  for (const u of updates) {
    if (!known.has(u.id)) merged.push({ type: "Image", createdAt: new Date().toISOString(), ...u });
  }
  return merged;
}

export const portraitKind = (portrait: ArkPortrait | undefined): ArkPortraitKind => portrait?.kind ?? "real";

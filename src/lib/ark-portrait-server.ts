import { createHash, createHmac } from "crypto";
import {
  ARK_ASSET_DEFAULT_PROJECT,
  ARK_ASSET_DEFAULT_REGION,
  type ArkAssetCredentials,
  type ArkAssetStatus,
  type ArkAssetType,
  type ArkPortraitKind,
} from "@/lib/ark-portrait";

/** Ark's group types: LivenessFace = a verified real person, AIGC = an AI-made virtual portrait */
const ARK_GROUP_TYPE: Record<ArkPortraitKind, string> = { real: "LivenessFace", virtual: "AIGC" };

/**
 * Server half of the Ark portrait asset library: Volcengine OpenAPI V4 signing (HMAC-SHA256, the
 * same shape as AWS SigV4 with its own prefixes) and the handful of actions the presenter library
 * uses. Service `ark`, Version 2024-01-01, POST with a JSON body. Hand-rolled for the same reason
 * object-storage-server.ts is: a few signed calls do not justify the SDK.
 *
 * Docs: 私域真人人像素材资产使用指南 https://www.volcengine.com/docs/82379 (guide-preview)
 */

const SERVICE = "ark";
const VERSION = "2024-01-01";

const sha256Hex = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 */
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

/** 20260318T033332Z */
const xDate = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function arkOpenApiHost(region?: string): string {
  return `ark.${(region || ARK_ASSET_DEFAULT_REGION).trim()}.volcengineapi.com`;
}

/** Signed request for one OpenAPI action: the URL and headers to send `body` with */
export function signArkRequest(
  credentials: ArkAssetCredentials,
  action: string,
  body: string,
  now: Date = new Date(),
): { url: string; headers: Record<string, string> } {
  const region = (credentials.region || ARK_ASSET_DEFAULT_REGION).trim();
  const host = arkOpenApiHost(region);
  const query = `Action=${encode(action)}&Version=${encode(VERSION)}`;
  const date = xDate(now);
  const day = date.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const contentType = "application/json";
  // the header set Volcengine's own SDK signs (content-type is never signed there)
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalHeaders = `host:${host}\nx-content-sha256:${payloadHash}\nx-date:${date}\n`;
  const canonicalRequest = ["POST", "/", query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/${SERVICE}/request`;
  const stringToSign = ["HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(credentials.secretAccessKey.trim(), day), region), SERVICE), "request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    url: `https://${host}/?${query}`,
    headers: {
      "Content-Type": contentType,
      "X-Date": date,
      "X-Content-Sha256": payloadHash,
      Authorization: `HMAC-SHA256 Credential=${credentials.accessKeyId.trim()}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export class ArkOpenApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ArkOpenApiError";
  }
}

interface ArkOpenApiResponse<T> {
  ResponseMetadata?: { RequestId?: string; Error?: { Code?: string; Message?: string } };
  Result?: T;
}

/** Call one action; every request carries the project, since assets are isolated per project */
export async function callArkOpenApi<T>(credentials: ArkAssetCredentials, action: string, params: Record<string, unknown>): Promise<T> {
  const body = JSON.stringify({ ProjectName: credentials.projectName?.trim() || ARK_ASSET_DEFAULT_PROJECT, ...params });
  const { url, headers } = signArkRequest(credentials, action, body);
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) });
  const data = (await res.json().catch(() => ({}))) as ArkOpenApiResponse<T>;
  const error = data.ResponseMetadata?.Error;
  if (!res.ok || error) {
    const code = error?.Code ?? `HTTP_${res.status}`;
    throw new ArkOpenApiError(`火山方舟素材库 ${action} 失败：${error?.Message ?? res.statusText}（${code}）`, code, res.status || 502);
  }
  return (data.Result ?? {}) as T;
}

// ==================== actions ====================

/** Start a liveness check: an H5 link for the person, and the token that later yields the group ID */
export async function createValidateSession(credentials: ArkAssetCredentials, callbackUrl: string) {
  const r = await callArkOpenApi<{ H5Link?: string; BytedToken?: string }>(credentials, "CreateVisualValidateSession", { CallbackURL: callbackUrl });
  if (!r.H5Link || !r.BytedToken) throw new ArkOpenApiError("真人认证链接生成失败：未返回 H5Link", "NO_LINK", 502);
  return { h5Link: r.H5Link, bytedToken: r.BytedToken };
}

/** Group ID once the person has passed; null while the check is still pending */
export async function getValidateResult(credentials: ArkAssetCredentials, bytedToken: string): Promise<string | null> {
  try {
    const r = await callArkOpenApi<{ GroupId?: string }>(credentials, "GetVisualValidateResult", { BytedToken: bytedToken });
    return r.GroupId ?? null;
  } catch (error) {
    // not finished yet reads as NotFound (results land asynchronously, seconds after the check)
    if (error instanceof ArkOpenApiError && /NotFound/i.test(error.code)) return null;
    throw error;
  }
}

export interface ArkAssetInfo {
  id: string;
  groupId?: string;
  type: ArkAssetType;
  status: ArkAssetStatus;
  name?: string;
  error?: string;
  createTime?: string;
}

interface RawAsset {
  Id?: string;
  GroupId?: string;
  AssetType?: string;
  Status?: string;
  Name?: string;
  CreateTime?: string;
  FailedReason?: string;
  Error?: { Message?: string } | string;
}

const STATUSES: ArkAssetStatus[] = ["Processing", "Active", "Failed"];
const TYPES: ArkAssetType[] = ["Image", "Video", "Audio"];

function toAssetInfo(raw: RawAsset, fallbackId = ""): ArkAssetInfo {
  const error = typeof raw.Error === "string" ? raw.Error : raw.Error?.Message ?? raw.FailedReason;
  return {
    id: raw.Id ?? fallbackId,
    ...(raw.GroupId && { groupId: raw.GroupId }),
    type: TYPES.includes(raw.AssetType as ArkAssetType) ? (raw.AssetType as ArkAssetType) : "Image",
    status: STATUSES.includes(raw.Status as ArkAssetStatus) ? (raw.Status as ArkAssetStatus) : "Processing",
    ...(raw.Name && { name: raw.Name }),
    ...(error && { error }),
    ...(raw.CreateTime && { createTime: raw.CreateTime }),
  };
}

/** Upload one file (by a URL Ark can fetch) into a group; processing is asynchronous */
export async function createAsset(
  credentials: ArkAssetCredentials,
  input: { groupId: string; url: string; type: ArkAssetType; name?: string },
): Promise<string> {
  const r = await callArkOpenApi<{ Id?: string }>(credentials, "CreateAsset", {
    GroupId: input.groupId,
    URL: input.url,
    AssetType: input.type,
    ...(input.name && { Name: input.name.slice(0, 64) }),
  });
  if (!r.Id) throw new ArkOpenApiError("素材入库失败：未返回素材 ID", "NO_ID", 502);
  return r.Id;
}

export async function getAsset(credentials: ArkAssetCredentials, id: string): Promise<ArkAssetInfo> {
  return toAssetInfo(await callArkOpenApi<RawAsset>(credentials, "GetAsset", { Id: id }), id);
}

/** Every asset in one group (newest first, up to 100) */
export async function listGroupAssets(credentials: ArkAssetCredentials, groupId: string, kind: ArkPortraitKind = "real"): Promise<ArkAssetInfo[]> {
  const r = await callArkOpenApi<{ Items?: RawAsset[] }>(credentials, "ListAssets", {
    Filter: { GroupIds: [groupId], GroupType: ARK_GROUP_TYPE[kind] },
    MaxResults: 100,
    SortBy: "CreateTime",
    SortOrder: "Desc",
  });
  return (r.Items ?? []).filter((item) => item.Id).map((item) => toAssetInfo(item));
}

export interface ArkGroupInfo {
  id: string;
  name?: string;
  createTime?: string;
}

/** Groups of one kind in the project, newest first (also checks the credentials work) */
export async function listPortraitGroups(credentials: ArkAssetCredentials, kind: ArkPortraitKind = "real"): Promise<ArkGroupInfo[]> {
  const r = await callArkOpenApi<{ Items?: Array<{ Id?: string; Name?: string; CreateTime?: string }> }>(credentials, "ListAssetGroups", {
    Filter: { GroupType: ARK_GROUP_TYPE[kind] },
    MaxResults: 100,
    SortBy: "CreateTime",
    SortOrder: "Desc",
  });
  return (r.Items ?? []).filter((g) => g.Id).map((g) => ({ id: g.Id!, ...(g.Name && { name: g.Name }), ...(g.CreateTime && { createTime: g.CreateTime }) }));
}

/**
 * Create a virtual-portrait (AIGC) group. Unlike a real-person group there is no liveness check:
 * Ark only runs a content review on each upload, and the uploader vouches that the likeness is
 * original and resembles no real person.
 */
export async function createVirtualGroup(credentials: ArkAssetCredentials, input: { name: string; description?: string }): Promise<string> {
  const r = await callArkOpenApi<{ Id?: string }>(credentials, "CreateAssetGroup", {
    Name: input.name.slice(0, 64),
    ...(input.description && { Description: input.description.slice(0, 200) }),
    GroupType: ARK_GROUP_TYPE.virtual,
  });
  if (!r.Id) throw new ArkOpenApiError("创建素材组失败：未返回素材组 ID", "NO_ID", 502);
  return r.Id;
}

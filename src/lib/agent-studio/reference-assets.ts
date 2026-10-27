import { isMaterialSource, materialSource } from "@/lib/material-source";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { eq } from "drizzle-orm";
import { assets, libraryAssets } from "@/lib/db/schema";
import { getOutputDir, getUploadsDir } from "@/lib/paths";
import { probeMedia } from "@/lib/media-probe";
import { REFERENCE_ROLES, type AgentReference, type ReferenceInput, type ReferenceSnapshot } from "./reference-types";
import { videoReferenceImage } from "./reference-image";

const MAX_IMAGE = 20 * 1024 * 1024;
const safeId = (id: string) => /^[\w-]{1,100}$/.test(id);
const fingerprint = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function bounded(value: unknown, max: number, required = false): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new Error("素材信息不完整或过长 / Invalid reference metadata");
  return value.trim();
}
export function parseReferenceInputs(value: unknown): ReferenceInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error("最多选择12份参考素材 / Select up to 12 references");
  const seen = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("参考素材无效 / Invalid reference");
    const v = raw as Record<string, unknown>, id = bounded(v.id, 100, true), sourceId = bounded(v.sourceId, 100, true);
    if (!safeId(id) || ["inherit", "none"].includes(id) || seen.has(id) || !REFERENCE_ROLES.includes(v.role as ReferenceInput["role"])) throw new Error("素材角色或编号无效 / Invalid reference role or ID");
    seen.add(id);
    const facts: NonNullable<ReferenceInput["facts"]> = {};
    if (v.facts !== undefined) {
      if (!v.facts || typeof v.facts !== "object" || Array.isArray(v.facts)) throw new Error("素材描述无效 / Invalid reference facts");
      for (const key of ["category", "price", "targetAudience", "appearance"] as const) {
        const text = bounded((v.facts as Record<string, unknown>)[key], key === "appearance" ? 3000 : 300);
        if (text) facts[key] = text;
      }
    }
    return { id, sourceId, ...(isMaterialSource(v.source) && { source: v.source }), role: v.role as ReferenceInput["role"], name: bounded(v.name, 120, true), description: bounded(v.description, 3000), imageUrl: bounded(v.imageUrl, 2048, true), ...(Object.keys(facts).length && { facts }) };
  });
}

/** Only app-owned images; no arbitrary filesystem paths, symlink escapes, URLs or network fetches. */
export async function referenceFile(imageUrl: string): Promise<string> {
  const uploads = imageUrl.startsWith("/api/files/");
  const output = imageUrl.startsWith("/api/output/");
  const example = /^\/examples\/[\w-]+\.(png|jpe?g|webp)$/i.test(imageUrl);
  if ((!uploads && !output && !example) || imageUrl.includes("..") || /[%\\?#\0]/.test(imageUrl)) throw new Error("请先将参考图片导入本地素材库 / Import reference images locally first");
  const base = uploads ? getUploadsDir() : output ? getOutputDir() : join(process.cwd(), "public", "examples");
  const relative = uploads ? imageUrl.slice("/api/files/".length) : output ? imageUrl.slice("/api/output/".length) : imageUrl.slice("/examples/".length);
  const [root, file] = await Promise.all([realpath(base), realpath(join(base, relative))]);
  if (!file.startsWith(root + sep)) throw new Error("参考图片超出素材目录 / Reference image escapes its library");
  const info = await stat(file);
  if (!info.isFile() || !info.size || info.size > MAX_IMAGE) throw new Error("参考图片需为不超过20MB的文件 / Reference image must be at most 20MB");
  return file;
}
function imageFormat(data: Buffer) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: "png", mimeType: "image/png" };
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return { ext: "jpg", mimeType: "image/jpeg" };
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mimeType: "image/webp" };
  throw new Error("参考图片仅支持 JPG / PNG / WebP / Unsupported reference format");
}
async function writeSnapshot(imageUrl: string, prefix: string, expectedHash?: string) {
  const file = await referenceFile(imageUrl), data = await readFile(file);
  if (data.length > MAX_IMAGE) throw new Error("参考图片超过20MB / Reference image exceeds 20MB");
  const format = imageFormat(data), sha256 = fingerprint(data);
  if (expectedHash && sha256 !== expectedHash) throw new Error("素材快照校验失败，请重新选择素材 / Reference snapshot checksum mismatch");
  const info = await probeMedia(file);
  if (!info.width || !info.height) throw new Error("参考图片损坏或无法读取 / Reference image cannot be decoded");
  const path = join(getUploadsDir(), `${prefix}/${sha256}.${format.ext}`);
  await mkdir(dirname(path), { recursive: true });
  // Link a complete temporary file atomically. A crash cannot publish a partial snapshot.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx" });
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (fingerprint(await readFile(path)) !== sha256) throw new Error("已有素材快照损坏 / Existing reference snapshot is corrupt");
    }
  } finally { await rm(temporary, { force: true }); }
  return { imageUrl: `/api/files/${prefix}/${sha256}.${format.ext}`, sha256, mimeType: format.mimeType, bytes: data.length };
}

/** Capture all selected libraries before planning, including browser-owned product/presenter metadata. */
export async function captureReferences(workId: string, value: unknown, previous: AgentReference[] = []): Promise<AgentReference[]> {
  if (!safeId(workId)) throw new Error("Invalid work ID");
  const input = parseReferenceInputs(value), captured: AgentReference[] = [];
  for (let item of input) {
    const old = previous.find(old => old.id === item.id && old.role === item.role && old.sourceId === item.sourceId && old.imageUrl === item.imageUrl);
    if (old) item = old; // Existing selections keep the captured metadata, even if their source library changed.
    else if (item.role === "scene") {
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      const imported = db.select().from(libraryAssets).where(eq(libraryAssets.id, item.sourceId)).get();
      const asset = imported ? null : db.select().from(assets).where(eq(assets.id, item.sourceId)).get();
      if (imported ? imported.mediaType !== "image" : !asset || !/\.(png|jpe?g|webp)$/i.test(asset.filePath || "")) throw new Error("请选择素材库中的场地图片 / Select a scene image from the library");
      item = { ...item, name: (imported?.title || item.name).slice(0, 120), description: (imported?.description || asset?.prompt || "").slice(0, 3000), imageUrl: imported?.filePath || asset!.filePath!, source: materialSource({ origin: imported ? imported.importSource === "generated" ? "ai_generated" : imported.importSource === "link" ? "link_import" : "user_upload" : asset?.type, sourceUrl: asset?.sourceUrl, tags: imported?.tags || [] }) };
    }
    captured.push({ ...item, ...await writeSnapshot(item.imageUrl, `agent-references/${workId}/selected`, old?.sha256) });
  }
  return captured;
}
/** Approvals copy from the version's captured inputs, never the work's latest library selections. */
export async function freezeReferenceSnapshot(workId: string, versionId: string, snapshot: ReferenceSnapshot): Promise<ReferenceSnapshot> {
  if (!safeId(workId) || !safeId(versionId)) throw new Error("Invalid snapshot ID");
  const items: AgentReference[] = [];
  for (const item of snapshot.items) items.push({ ...item, ...await writeSnapshot(item.imageUrl, `agent-references/${workId}/versions/${versionId}`, item.sha256) });
  return { capturedAt: snapshot.capturedAt, items };
}
export async function readReferenceImage(item: AgentReference, forVideo = false) {
  const file = await referenceFile(item.imageUrl), data = await readFile(file);
  if (fingerprint(data) !== item.sha256 || data.length !== item.bytes || imageFormat(data).mimeType !== item.mimeType) throw new Error("素材快照已损坏，已停止生成 / Reference snapshot is corrupt; generation stopped");
  return forVideo ? videoReferenceImage(data, item.mimeType) : `data:${item.mimeType};base64,${data.toString("base64")}`;
}

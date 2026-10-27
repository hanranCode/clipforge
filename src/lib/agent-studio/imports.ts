import { readdir, readFile, realpath, mkdir, copyFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { libraryAssets } from "@/lib/db/schema";
import { getOutputDir } from "@/lib/paths";
import { studioStore } from "./store";
import { parseAgentPlan, type WorkVersion } from "./types";
// Explicit export manifests are the import boundary. Notes and arbitrary directories are never executed.
const productionsRoot = () => join(process.cwd(), "videos", "productions");
interface Manifest { title: string; sourceAssetId: string; duration: number; resolution: "480p" | "720p"; file: string; poster: string; taskId: string; tokens: number; brief: string; plan: unknown }
async function manifest(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("工程标识无效");
  const root = await realpath(productionsRoot()), dir = await realpath(join(root, id));
  if (!dir.startsWith(root + sep)) throw new Error("工程目录无效");
  const m = JSON.parse(await readFile(join(dir, "clipforge-production.json"), "utf8")) as Manifest;
  if (typeof m.title !== "string" || !Number.isInteger(m.duration) || m.duration < 4 || m.duration > 180 || !["480p", "720p"].includes(m.resolution) || !Number.isFinite(m.tokens) || m.tokens < 0 || m.tokens > 50_000_000 || !/^cgt-[\w-]+$/.test(m.taskId)) throw new Error("导出清单缺少有效制作信息");
  return { m, dir };
}
export async function importableProductions() {
  let dirs; try { dirs = await readdir(productionsRoot(), { withFileTypes: true }); } catch { return []; }
  const imported = new Set(studioStore().works().map(w => w.importKey));
  const result = [];
  for (const d of dirs.filter(d => d.isDirectory())) { try { const { m } = await manifest(d.name); if (!imported.has(d.name)) result.push({ id: d.name, title: m.title }); } catch {} }
  return result;
}
export async function importProduction(id: string) {
  const store = studioStore(), existing = store.works().find(w => w.importKey === id); if (existing) return existing;
  const { m, dir } = await manifest(id);
  const source = getDb().select().from(libraryAssets).where(eq(libraryAssets.id, m.sourceAssetId)).get();
  if (!source || source.mediaType !== "video") throw new Error("请先把原参考视频导入素材库");
  const plan = parseAgentPlan(m.plan, m.duration);
  async function artifact(file: string) { const resolved = await realpath(join(dir, file)); if (!resolved.startsWith(dir + sep)) throw new Error("工程素材超出目录"); return resolved; }
  const [file, poster] = await Promise.all([artifact(m.file), artifact(m.poster)]);
  const w = store.create({ title: m.title.slice(0, 120), sourceAssetId: source.id, sourceUrl: source.filePath, sourceName: source.title, duration: m.duration, brief: m.brief, runtimeId: null, resolution: m.resolution, voice: "female" });
  w.importKey = id; w.plan = plan; store.save(w);
  try {
    const versionId = randomUUID(); const output = join(getOutputDir(), "agent-studio", w.id, "versions", versionId); await mkdir(output, { recursive: true });
    await copyFile(file, join(output, "segment-0.mp4")); await copyFile(poster, join(output, "poster.jpg"));
    if (plan.segments.length !== 1) throw new Error("此清单导入当前仅支持一个完整成片分段");
    const v: WorkVersion = { id: versionId, number: 1, status: "generating", prepared: true, plan, budgetCny: m.tokens * 23 / 1e6, estimatedCny: m.tokens * 23 / 1e6, costCny: m.tokens * 23 / 1e6, receipts: [{ state: "completed", taskId: m.taskId, tokens: m.tokens, costCny: m.tokens * 23 / 1e6, file: join(output, "segment-0.mp4") }], outputUrl: null, posterUrl: null, editorUrl: null, sourceId: null, error: null, createdAt: Date.now(), completedAt: null };
    store.update(w.id, w => { w.versions.push(v); w.status = "generating"; });
    const { publishImportedVersion } = await import("./engine"); await publishImportedVersion(store.work(w.id), v);
    store.event(w.id, "system", `已导入已有 Hypit 成片与真实用量 ${m.tokens} Token；本次导入没有发起视频生成。`);
    return store.work(w.id);
  } catch(e) { store.update(w.id, w => { w.importKey = undefined; w.status = "attention"; w.error = (e as Error).message; }); throw e; }
}

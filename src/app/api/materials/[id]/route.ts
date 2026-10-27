import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { rm } from "fs/promises";
import { getDb } from "@/lib/db";
import { assets, libraryAssets, projects, videoClips } from "@/lib/db/schema";
import { takeFilesToDelete } from "@/lib/asset-file-cleanup";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { LAST_FRAME_SUFFIX } from "@/lib/video-composer/frame-extract";

export const runtime = "nodejs";

const SAFE_ID = /^[\w-]{1,64}$/;

function referencesMaterial(value: unknown, identities: Set<string>): boolean {
  if (typeof value === "string") return identities.has(value);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((child) => referencesMaterial(child, identities));
}

const inUseResponse = () => NextResponse.json({ error: "素材仍被视频复刻项目引用，请先移除项目中的引用" }, { status: 409 });

/** Delete one imported item or one generated take from the combined material library. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!SAFE_ID.test(id)) return NextResponse.json({ error: "无效的素材ID" }, { status: 400 });

  try {
    const db = getDb();
    const [imported] = await db.select().from(libraryAssets).where(eq(libraryAssets.id, id)).limit(1);
    if (imported) {
      // A project take may still point at an imported file. Remove the library row now, but keep
      // its bytes until the last project reference is gone.
      const outcome = db.transaction((tx) => {
        const identities = new Set([id, imported.filePath]);
        const inUse = tx.select({ draft: projects.remakeDraft }).from(projects).where(isNotNull(projects.remakeDraft)).all()
          .some(({ draft }) => referencesMaterial(draft, identities));
        if (inUse) return { inUse: true, reference: null };
        tx.delete(libraryAssets).where(eq(libraryAssets.id, id)).run();
        const reference = tx.select({ id: assets.id }).from(assets).where(
          or(eq(assets.filePath, imported.filePath), eq(assets.thumbnailPath, imported.filePath)),
        ).limit(1).get();
        return { inUse: false, reference };
      });
      if (outcome.inUse) return inUseResponse();
      let filesRemoved = 0;
      // Presenter originals live in characters/ and may still be referenced by the browser's
      // presenter store. Only the standalone material pool owns its generated files.
      const ownedPrefix = ["/api/files/_library/", "/api/files/library-generated/"].find(prefix => imported.filePath.startsWith(prefix));
      const libraryName = ownedPrefix ? imported.filePath.slice(ownedPrefix.length) : "";
      if (!outcome.reference && libraryName && !libraryName.includes("/") && !libraryName.includes("..")) {
        const path = resolveUploadFilePath(imported.filePath);
        if (path) {
          try {
            await rm(path, { force: true });
            await rm(`${path}.clipforge.json`, { force: true });
            filesRemoved = 1;
          } catch {
            // The library row is already gone; a stale local file can be cleaned up later.
          }
        }
      }
      return NextResponse.json({ deleted: 1, filesRemoved });
    }

    const [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!asset) return NextResponse.json({ error: "素材不存在" }, { status: 404 });

    const deleted = db.transaction((tx) => {
      const identities = new Set([id, asset.filePath].filter((value): value is string => Boolean(value)));
      if (tx.select({ draft: projects.remakeDraft }).from(projects).where(isNotNull(projects.remakeDraft)).all()
        .some(({ draft }) => referencesMaterial(draft, identities))) return false;
      // video_clips has a nullable reference without ON DELETE CASCADE.
      tx.update(videoClips).set({ assetId: null }).where(eq(videoClips.assetId, id)).run();
      tx.delete(assets).where(eq(assets.id, id)).run();
      if (asset.selected) {
        const [fallback] = tx.select().from(assets)
          .where(and(eq(assets.projectId, asset.projectId), eq(assets.shotId, asset.shotId), eq(assets.status, "done")))
          .orderBy(desc(assets.createdAt)).limit(1).all();
        if (fallback) tx.update(assets).set({ selected: true }).where(eq(assets.id, fallback.id)).run();
      }
      return true;
    });
    if (!deleted) return inUseResponse();

    const surviving = await db.select().from(assets).where(eq(assets.projectId, asset.projectId));
    let filesRemoved = 0;
    for (const filePath of takeFilesToDelete(asset.projectId, [asset], surviving)) {
      const path = resolveUploadFilePath(filePath);
      if (!path) continue;
      await rm(path, { force: true }).catch(() => {});
      if (/\.(mp4|webm|mov|m4v)$/i.test(filePath)) await rm(`${path}${LAST_FRAME_SUFFIX}`, { force: true }).catch(() => {});
      filesRemoved += 1;
    }
    return NextResponse.json({ deleted: 1, filesRemoved });
  } catch (error) {
    console.error("删除素材失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除素材失败" }, { status: 500 });
  }
}

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { compositions, libraryAssets, projects } from "@/lib/db/schema";
import { resolveUploadFilePath } from "@/lib/remote-image";

/** A stable composition per library result preserves every finished take, including retries. */
export function registerRemakeResult(projectId: string, assetId: string) {
  const db = getDb();
  const project = db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.sourceType, "remake"))).get();
  const asset = db.select().from(libraryAssets).where(eq(libraryAssets.id, assetId)).get();
  if (!project || !asset || asset.mediaType !== "video" || !asset.tags.includes("视频复刻")) return;
  const path = resolveUploadFilePath(asset.filePath);
  if (!path) return;
  const id = `remake-${asset.id}`;
  db.insert(compositions).values({ id, projectId, outputPath: path, status: "done", label: asset.title, duration: asset.durationSec == null ? null : Math.round(asset.durationSec * 1000), createdAt: asset.createdAt }).onConflictDoNothing().run();
  return id;
}

/** Reconcile older saved results using local records only. No generation or paid calls. */
export function syncCompletedRemakes() {
  for (const p of getDb().select().from(projects).where(eq(projects.sourceType, "remake")).all()) {
    const final = p.remakeDraft?.final as { id?: unknown } | undefined;
    if (typeof final?.id === "string") registerRemakeResult(p.id, final.id);
  }
}

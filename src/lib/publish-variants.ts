import { and, eq } from "drizzle-orm";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { compositions, libraryAssets } from "@/lib/db/schema";
import { getOutputDir } from "@/lib/paths";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { completedVideoUrl, checkedPublishPath } from "@/lib/publish-source";
import { videoDimensions } from "@/lib/video-dimensions";
import type { PublishVideo, PublishVideoFamily } from "@/lib/publish-video";

function family(original: PublishVideo, upscales: PublishVideo[]): PublishVideoFamily {
  const videos = [...upscales].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  return { videos: [...videos, original], preferredId: videos[0]?.id ?? original.id };
}
/** Resolve only siblings of the selected completed take, never another project's/latest take. */
export async function publishVideoFamily(projectId: string, sourceId: string): Promise<PublishVideoFamily | null> {
  if (sourceId.startsWith("agent-")) {
    const { studioStore } = await import("@/lib/agent-studio/store");
    const { superResolutionTasks } = await import("@/lib/agent-studio/types");
    const work = studioStore().works().find(w => (w.projectId || w.id) === projectId);
    if (work) for (const v of work.versions) {
      const upscales = superResolutionTasks(v).filter(t => t.status === "completed" && t.outputUrl);
      const id = `agent-${v.id}`;
      if (v.status !== "completed" || !v.outputUrl || sourceId !== id && !upscales.some(t => sourceId === `agent-upscale-${t.requestId}`)) continue;
      if (![work.id, v.id].every(id => /^[a-zA-Z0-9-]+$/.test(id))) return null;
      const file = await checkedPublishPath(join(getOutputDir(), "agent-studio", work.id, "versions", v.id, "final.mp4"));
      const original: PublishVideo = { id, url: v.outputUrl, label: `${work.title} · V${v.number}`, kind: "original", createdAt: v.completedAt || v.createdAt, ...await videoDimensions(file) };
      return family(original, upscales.map(t => ({ id: `agent-upscale-${t.requestId}`, url: t.outputUrl!, label: original.label, kind: "upscale", originalId: id, createdAt: t.completedAt || t.createdAt, width: t.result?.width, height: t.result?.height })));
    }
  }
  const db = getDb();
  const rows = db.select().from(compositions).where(and(eq(compositions.projectId, projectId), eq(compositions.status, "done"))).all();
  for (const c of rows) {
    if (!c.outputPath) continue;
    if (c.id.startsWith("remake-")) {
      const assetId = c.id.slice(7);
      const { remakeUpscaleTasks } = await import("@/lib/remake/super-resolution");
      const upscales = remakeUpscaleTasks(assetId).filter(t => t.status === "completed" && t.outputUrl);
      if (sourceId !== c.id && !upscales.some(t => sourceId === `remake-upscale-${t.requestId}`)) continue;
      const original: PublishVideo = { id: c.id, url: completedVideoUrl(c.outputPath, projectId), label: c.label, kind: "original", createdAt: c.createdAt?.toISOString(), ...await videoDimensions(c.outputPath) };
      const variants: PublishVideo[] = [];
      for (const t of upscales) {
        const asset = db.select().from(libraryAssets).where(eq(libraryAssets.id, `remake-upscale-${t.requestId}`)).get();
        if (!asset || asset.filePath !== t.outputUrl || !await checkedPublishPath(resolveUploadFilePath(asset.filePath) || "")) continue;
        variants.push({ id: `remake-upscale-${t.requestId}`, url: asset.filePath, label: c.label, kind: "upscale", originalId: c.id, createdAt: t.completedAt || t.createdAt, width: asset.width ?? t.result?.width, height: asset.height ?? t.result?.height });
      }
      return family(original, variants);
    }
    if (sourceId === c.id) return family({ id: c.id, url: completedVideoUrl(c.outputPath, projectId), label: c.label, kind: "original", createdAt: c.createdAt?.toISOString(), ...await videoDimensions(c.outputPath) }, []);
  }
  return null;
}

export async function remakePublishSource(projectId: string, sourceId: string): Promise<string | null> {
  const group = await publishVideoFamily(projectId, sourceId);
  const video = group?.videos.find(v => v.id === sourceId);
  return video?.url ? checkedPublishPath(resolveUploadFilePath(video.url) || "") : null;
}

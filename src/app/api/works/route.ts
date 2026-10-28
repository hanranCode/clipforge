import { syncCompletedRemakes } from "@/lib/completed-remakes";
import { publishVideoFamily } from "@/lib/publish-variants";
import { videoDimensions } from "@/lib/video-dimensions";
import { completedVideoUrl, agentPublishSource } from "@/lib/publish-source";
import { projectCosts } from "@/lib/project-costs";
import { studioStore } from "@/lib/agent-studio/store";
import { syncAgentCatalog, agentProjectHref } from "@/lib/agent-studio/catalog";
import { superResolutionTasks } from "@/lib/agent-studio/types";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { existsSync } from "fs";
import { getDb } from "@/lib/db";
import { compositions, projects } from "@/lib/db/schema";
import { fileNameOf } from "@/lib/paths";
import { extractFirstFrame } from "@/lib/video-composer/frame-extract";

/** Poster backfill budget per request — keeps the first works-page load snappy on old libraries. */
const BACKFILL_MAX = 6;

/**
 * GET /api/works — the cross-project works feed: every successful composition,
 * newest first, with project context and a poster thumbnail. "Find that clip by
 * its picture" used to mean opening N projects' export pages one by one.
 *
 * Rows rendered before the thumbnail column existed are backfilled lazily here
 * (first-frame extraction, a few per request) so history gains posters over time.
 */
export async function GET() {
  try {
    await syncAgentCatalog();
    syncCompletedRemakes();
    const costs = projectCosts();
    const db = getDb();
    const rows = await db
      .select({
        id: compositions.id,
        projectId: compositions.projectId,
        outputPath: compositions.outputPath,
        thumbnailPath: compositions.thumbnailPath,
        duration: compositions.duration,
        aspectRatio: compositions.aspectRatio,
        label: compositions.label,
        createdAt: compositions.createdAt,
        projectName: projects.name,
        sourceType: projects.sourceType,
        productName: projects.productName,
      })
      .from(compositions)
      .innerJoin(projects, eq(compositions.projectId, projects.id))
      .where(eq(compositions.status, "done"))
      .orderBy(desc(compositions.createdAt))
      .limit(200);

    const agentProjects = new Map(studioStore().works().map(w => [w.projectId || w.id, w.id]));
    let backfilled = 0;
    const works = [] as Array<Record<string, unknown>>;
    for (const c of rows) {
      const fileName = fileNameOf(c.outputPath);
      if (!fileName) continue;
      let thumbnailPath = c.thumbnailPath;
      let thumbName = fileNameOf(thumbnailPath);
      // lazy poster backfill for pre-column history (best-effort, budgeted)
      if (!thumbName && backfilled < BACKFILL_MAX && c.outputPath && existsSync(c.outputPath)) {
        backfilled++;
        const thumb = await extractFirstFrame(c.outputPath);
        if (thumb) {
          try {
            await db.update(compositions).set({ thumbnailPath: thumb }).where(eq(compositions.id, c.id));
          } catch { /* poster persistence is best-effort */ }
          thumbnailPath = thumb;
          thumbName = fileNameOf(thumb);
        }
      }
      works.push({
        id: c.id,
        ...(agentProjects.has(c.projectId) && { detailHref: agentProjectHref(agentProjects.get(c.projectId)!) }),
        ...(c.sourceType === "remake" && { detailHref: `/project/remake?id=${c.projectId}` }),
        kind: "original", ...await videoDimensions(c.outputPath),
        publishId: c.id, cost: costs.get(c.projectId),
        projectId: c.projectId,
        projectName: c.projectName,
        productName: c.productName,
        label: c.label,
        duration: c.duration,
        aspectRatio: c.aspectRatio,
        createdAt: c.createdAt,
        url: completedVideoUrl(c.outputPath!, c.projectId),
        thumbnailUrl: thumbName ? completedVideoUrl(thumbnailPath || "", c.projectId) : null,
      });
      if (c.sourceType === "remake") {
        const family = await publishVideoFamily(c.projectId, c.id);
        for (const variant of family?.videos ?? []) if (variant.kind === "upscale") works.push({
          id: variant.id, publishId: variant.id, projectId: c.projectId, projectName: c.projectName, productName: c.productName,
          label: c.label, kind: variant.kind, width: variant.width, height: variant.height,
          duration: c.duration, createdAt: new Date(variant.createdAt ?? 0).toISOString(), url: variant.url,
          thumbnailUrl: thumbName ? completedVideoUrl(thumbnailPath || "", c.projectId) : null,
          detailHref: `/project/remake?id=${c.projectId}`, cost: costs.get(c.projectId),
        });
      }
    }
    for (const w of studioStore().works()) for (const v of w.versions) {
      if (v.status !== "completed" || !v.outputUrl) continue;
      const entry = { cost: costs.get(w.projectId || w.id), projectId: w.projectId || w.id, projectName: w.title, productName: null, duration: w.duration * 1000, thumbnailUrl: v.posterUrl, detailHref: agentProjectHref(w.id, v.id) };
      works.push({ ...entry, id: `agent-${v.id}`, publishId: `agent-${v.id}`, label: `Agent · V${v.number}`, kind: "original", ...await videoDimensions(await agentPublishSource(w.projectId || w.id, `agent-${v.id}`)), url: v.outputUrl, createdAt: new Date(v.completedAt || v.createdAt).toISOString() });
      for (const sr of superResolutionTasks(v)) if (sr.status === "completed" && sr.outputUrl) works.push({ ...entry, id: `agent-upscale-${sr.requestId}`, publishId: `agent-upscale-${sr.requestId}`, label: `Agent · V${v.number}`, kind: "upscale", width: sr.result?.width, height: sr.result?.height, url: sr.outputUrl, createdAt: new Date(sr.completedAt || sr.createdAt).toISOString() });
    }
    works.sort((a, b) => new Date(String(b.createdAt || "")).getTime() - new Date(String(a.createdAt || "")).getTime());
    return NextResponse.json({ works: works.slice(0, 200) });
  } catch (error) {
    console.error("获取作品流失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取作品流失败" },
      { status: 500 }
    );
  }
}

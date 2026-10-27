import { isMaterialSource, materialSource } from "@/lib/material-source";
import { localVideoMetadata } from "@/lib/local-media-metadata";
import { syncAgentCatalog, agentArtifactIndex } from "@/lib/agent-studio/catalog";
import { NextRequest, NextResponse } from "next/server";
import { statSync } from "fs";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, libraryAssets, projects } from "@/lib/db/schema";
import { resolveUploadFilePath } from "@/lib/remote-image";
import {
  classifyAssetMedia,
  facetCounts,
  filterAssetItems,
  readGenerationInputs,
  type AssetLibraryItem,
  type AssetMediaType,
  type AssetOrigin,
} from "@/lib/asset-library";

/** Page size for the waterfall. Small enough that the first screen paints fast. */
const PAGE_SIZE = 24;
/** Ceiling on rows scanned per request — the library is a browse surface, not an export. */
const MAX_SCAN = 4000;

/** On-disk size of a local asset; missing files (cleaned up, moved) simply have none. */
function sizeOf(filePath: string | null): number | null {
  if (!filePath) return null;
  try {
    const absolute = resolveUploadFilePath(filePath);
    return absolute ? statSync(absolute).size : null;
  } catch {
    return null;
  }
}

/** Newest first, with rows that never recorded a timestamp sorted last rather than first. */
function byNewest(a: AssetLibraryItem, b: AssetLibraryItem): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
}

/**
 * Cross-project asset library: every generated / imported piece of media, newest first.
 *
 * Two sources feed one feed. Generated material comes from `assets`, where every row belongs to a
 * project and a shot. Imported material comes from `library_assets`, which belongs to nobody — an
 * upload or a downloaded link that is waiting to be used. They are merged here, after which they
 * are filtered, faceted and paginated identically.
 *
 * Filtering happens in memory on purpose. Media type is derived from the file extension and the
 * search spans the joined project name, neither of which is a column — and the row budget above
 * keeps that honest. Pagination is offset-based over the filtered result so the waterfall stays
 * consistent while filters change.
 *
 * Query: ?mediaType=image|video &origin=ai_generated|… &provider= &model= &projectId= &q=
 *        &selectedOnly=1 &cloud=uploaded|local &id= &offset=0 &limit=24
 */
export async function GET(req: NextRequest) {
  try {
    await syncAgentCatalog();
    const agentArtifacts = agentArtifactIndex();
    const params = req.nextUrl.searchParams;
    const db = getDb();
    const [rows, imported] = await Promise.all([
      db
        .select({
          asset: assets,
          projectName: projects.name,
          projectType: projects.sourceType,
        })
        .from(assets)
        .leftJoin(projects, eq(assets.projectId, projects.id))
        .orderBy(desc(assets.createdAt))
        .limit(MAX_SCAN),
      db.select().from(libraryAssets).orderBy(desc(libraryAssets.createdAt)).limit(MAX_SCAN),
    ]);

    const generated: AssetLibraryItem[] = rows.map(({ asset, projectName, projectType }) => ({
      id: asset.id,
      ...(agentArtifacts.has(asset.id) && { width: agentArtifacts.get(asset.id)!.width, height: agentArtifacts.get(asset.id)!.height, title: agentArtifacts.get(asset.id)!.title, detailHref: agentArtifacts.get(asset.id)!.detailHref, parentAssetId: agentArtifacts.get(asset.id)!.parentAssetId }),
      projectId: asset.projectId,
      projectName: projectName ?? null,
      shotId: asset.shotId,
      mediaType: classifyAssetMedia(asset.filePath),
      origin: asset.type as AssetOrigin,
      source: materialSource({ origin: asset.type, projectType, sourceUrl: asset.sourceUrl, detailHref: agentArtifacts.get(asset.id)?.detailHref }),
      url: asset.filePath,
      thumbnailUrl: asset.thumbnailPath,
      provider: asset.provider,
      model: asset.model,
      prompt: asset.prompt,
      inputs: readGenerationInputs(asset.generationPlan),
      sourceUrl: asset.sourceUrl,
      author: asset.author,
      license: asset.license,
      selected: Boolean(asset.selected),
      status: asset.status,
      cloud: asset.objectKey ? { bucket: asset.objectBucket, uploadedAt: asset.objectUploadedAt?.toISOString() ?? null } : null,
      sizeBytes: agentArtifacts.get(asset.id)?.bytes ?? null,
      createdAt: asset.createdAt ? asset.createdAt.toISOString() : null,
    }));

    const importedItems: AssetLibraryItem[] = imported.map((row) => ({
      id: row.id,
      // no project, no shot: an import is unattached until someone uses it
      projectId: null,
      projectName: null,
      shotId: null,
      mediaType: row.mediaType,
      width: row.width, height: row.height, durationSec: row.durationSec,
      origin: row.importSource === "generated" ? "ai_generated" : row.importSource === "link" ? "link_import" : "user_upload",
      source: materialSource({ origin: row.importSource === "generated" ? "ai_generated" : row.importSource === "link" ? "link_import" : "user_upload", tags: row.tags || [] }),
      url: row.filePath,
      thumbnailUrl: null,
      provider: row.provider,
      model: row.model,
      // an import has no prompt; its title and description carry the same weight on the page
      prompt: row.prompt,
      inputs: row.durationSec ? { durationSeconds: Math.round(row.durationSec) } : null,
      sourceUrl: row.sourceUrl,
      author: row.author,
      license: row.license,
      title: row.title,
      description: row.description,
      tags: row.tags ?? [],
      ...(row.segments && row.segments.length > 1 && { segments: row.segments }),
      selected: false,
      status: "done",
      cloud: row.objectKey ? { bucket: row.objectBucket, uploadedAt: row.objectUploadedAt?.toISOString() ?? null } : null,
      md5: row.contentMd5,
      objectUrl: row.objectUrl,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    }));

    const items = [...generated, ...importedItems].sort(byNewest);

    const mediaType = params.get("mediaType");
    const origin = params.get("origin");
    // ?id= picks one item (deep link from the page that produced it), still in the same shape
    const id = params.get("id");
    const filtered = filterAssetItems(id ? items.filter((item) => item.id === id) : items, {
      ...(mediaType === "image" || mediaType === "video" || mediaType === "audio" ? { mediaType: mediaType as AssetMediaType } : {}),
      ...(origin ? { origin: origin as AssetOrigin } : {}),
      ...(isMaterialSource(params.get("source")) ? { source: params.get("source") as import("@/lib/material-source").MaterialSource } : {}),
      ...(params.get("provider") ? { provider: params.get("provider") as string } : {}),
      ...(params.get("model") ? { model: params.get("model") as string } : {}),
      ...(params.get("projectId") ? { projectId: params.get("projectId") as string } : {}),
      ...(params.get("q") ? { search: params.get("q") as string } : {}),
      ...(params.get("selectedOnly") === "1" ? { selectedOnly: true } : {}),
      ...(params.get("cloud") === "uploaded" || params.get("cloud") === "local" ? { cloud: params.get("cloud") as "uploaded" | "local" } : {}),
    });

    const offset = Math.max(0, Number(params.get("offset")) || 0);
    const limit = Math.min(60, Math.max(1, Number(params.get("limit")) || PAGE_SIZE));
    // stat only the page being returned — one syscall per visible card, not per row in the library
    const selected = filtered.slice(offset, offset + limit), page: AssetLibraryItem[] = [];
    // Bound ffprobe concurrency and cache by file identity; never inspect every scanned row.
    for (let i = 0; i < selected.length; i += 4) {
      const batch = await Promise.all(selected.slice(i, i + 4).map(async item => ({ ...item, ...(item.mediaType === "video" && item.url && !(item.width && item.height) ? await localVideoMetadata(item.url) : {}), sizeBytes: item.sizeBytes ?? sizeOf(item.url) })));
      page.push(...batch);
    }

    return NextResponse.json({
      items: page,
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + page.length < filtered.length,
      // facets describe the WHOLE library (not the filtered view) so a filter menu never hides
      // the option that would widen the current selection
      facets: {
        providers: facetCounts(items, "provider"),
        models: facetCounts(items, "model"),
        origins: facetCounts(items, "origin"),
        sources: facetCounts(items, "source"),
        mediaTypes: facetCounts(items, "mediaType"),
        projects: [...new Map(generated.map((i) => [i.projectId as string, i.projectName])).entries()]
          .map(([id, name]) => ({ id, name: name ?? id.slice(0, 8) }))
          .slice(0, 100),
      },
      truncated: rows.length >= MAX_SCAN || imported.length >= MAX_SCAN,
    });
  } catch (error) {
    console.error("读取素材库失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取素材库失败" },
      { status: 500 },
    );
  }
}

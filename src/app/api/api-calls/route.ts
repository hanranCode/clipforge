import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiCalls, projects } from "@/lib/db/schema";
import type { ApiCallFilters } from "@/lib/api-call-log";
import { apiCallWhere } from "@/lib/api-call-store";
import type { ModelType } from "@/lib/model-pricing";

const PAGE_SIZE = 50;
const MODEL_TYPES: ModelType[] = ["text", "vision", "image", "video", "tts"];

function parseFilters(params: URLSearchParams): ApiCallFilters {
  const modelType = params.get("modelType");
  const status = params.get("status");
  return {
    ...(MODEL_TYPES.includes(modelType as ModelType) ? { modelType: modelType as ModelType } : {}),
    ...(params.get("scene") ? { scene: params.get("scene") as string } : {}),
    ...(params.get("provider") ? { provider: params.get("provider") as string } : {}),
    ...(params.get("model") ? { model: params.get("model") as string } : {}),
    ...(status === "success" || status === "failed" ? { status } : {}),
    ...(params.get("projectId") ? { projectId: params.get("projectId") as string } : {}),
    ...(params.get("since") ? { since: Number(params.get("since")) } : {}),
    ...(params.get("q") ? { search: params.get("q") as string } : {}),
  };
}

/**
 * The API call log: one row per model request, text and multimodal alike.
 *
 * Returns the page plus a summary over the WHOLE filtered set — a log you have to scroll to add up
 * is not a cost report. The summary sums the amounts the writer estimated at call time (see
 * model-pricing.ts); `unpricedCalls` counts the rows the price book could not place, so a total is
 * never quietly presented as complete when part of the traffic had no rate.
 *
 * Query: ?modelType= &scene= &provider= &model= &status= &projectId= &since= &q= &offset= &limit=
 * `groupBy=project` paginates project summaries; `unassigned=1` reads calls without a project.
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const filters = parseFilters(params);
    const where = and(apiCallWhere(filters), params.get("unassigned") === "1" ? isNull(apiCalls.projectId) : undefined);
    const grouped = params.get("groupBy") === "project";
    const offset = Math.max(0, Number(params.get("offset")) || 0);
    const limit = Math.min(200, Math.max(1, Number(params.get("limit")) || PAGE_SIZE));
    const db = getDb();

    const usd = sql<number>`coalesce(sum(coalesce(json_extract(${apiCalls.cost}, '$.totalUsd'), 0)), 0)`;
    const rowsQuery = db
      .select({ call: apiCalls, projectName: projects.name })
      .from(apiCalls)
      .leftJoin(projects, eq(apiCalls.projectId, projects.id))
      .orderBy(desc(apiCalls.createdAt), desc(apiCalls.id))
      .limit(limit)
      .offset(offset);

    const summaryQuery = db
      .select({
        calls: sql<number>`count(*)`,
        failed: sql<number>`sum(case when ${apiCalls.status} = 'failed' then 1 else 0 end)`,
        promptTokens: sql<number>`coalesce(sum(coalesce(json_extract(${apiCalls.usage}, '$.promptTokens'), 0)), 0)`,
        completionTokens: sql<number>`coalesce(sum(coalesce(json_extract(${apiCalls.usage}, '$.completionTokens'), 0)), 0)`,
        inputUsd: sql<number>`coalesce(sum(coalesce(json_extract(${apiCalls.cost}, '$.inputUsd'), 0)), 0)`,
        outputUsd: sql<number>`coalesce(sum(coalesce(json_extract(${apiCalls.cost}, '$.outputUsd'), 0)), 0)`,
        totalUsd: usd,
        unpricedCalls: sql<number>`sum(case when json_extract(${apiCalls.cost}, '$.totalUsd') is null then 1 else 0 end)`,
        latencyMs: sql<number>`coalesce(avg(coalesce(${apiCalls.latencyMs}, 0)), 0)`,
      })
      .from(apiCalls);

    const byTypeQuery = db
      .select({
        modelType: apiCalls.modelType,
        calls: sql<number>`count(*)`,
        totalUsd: usd,
      })
      .from(apiCalls)
      .groupBy(apiCalls.modelType);

    const facetQuery = db
      .select({ provider: apiCalls.provider, model: apiCalls.model, scene: apiCalls.scene, calls: sql<number>`count(*)` })
      .from(apiCalls)
      .groupBy(apiCalls.provider, apiCalls.model, apiCalls.scene);

    const projectQuery = db
      .select({
        projectId: apiCalls.projectId,
        projectName: projects.name,
        calls: sql<number>`count(*)`,
        failed: sql<number>`sum(case when ${apiCalls.status} = 'failed' then 1 else 0 end)`,
        totalUsd: usd,
        unpricedCalls: sql<number>`sum(case when json_extract(${apiCalls.cost}, '$.totalUsd') is null then 1 else 0 end)`,
        latestCallAt: sql<string | null>`strftime('%Y-%m-%dT%H:%M:%SZ', max(${apiCalls.createdAt}), 'unixepoch')`,
      })
      .from(apiCalls)
      .leftJoin(projects, eq(apiCalls.projectId, projects.id))
      .where(where)
      .groupBy(apiCalls.projectId, projects.name)
      .orderBy(desc(sql`max(${apiCalls.createdAt})`), apiCalls.projectId)
      .limit(limit)
      .offset(offset);

    const countQuery = db
      .select({
        total: sql<number>`count(*)`,
        // COUNT(DISTINCT) excludes NULL; unassigned calls form one additional group.
        totalProjects: sql<number>`count(distinct ${apiCalls.projectId}) + coalesce(max(case when ${apiCalls.projectId} is null then 1 else 0 end), 0)`,
      })
      .from(apiCalls)
      .where(where);

    const [rows, groups, [summary], byType, facetRows, [{ total, totalProjects }]] = await Promise.all([
      grouped ? Promise.resolve([]) : (where ? rowsQuery.where(where) : rowsQuery),
      grouped ? projectQuery : Promise.resolve([]),
      where ? summaryQuery.where(where) : summaryQuery,
      where ? byTypeQuery.where(where) : byTypeQuery,
      facetQuery,
      countQuery,
    ]);

    const distinct = (key: "provider" | "model" | "scene") =>
      [...new Set(facetRows.map((row) => row[key]).filter((v): v is string => Boolean(v)))].sort();

    return NextResponse.json({
      items: rows.map(({ call, projectName }) => ({ ...call, projectName: projectName ?? null })),
      ...(grouped ? { groups, totalProjects: totalProjects ?? 0 } : {}),
      total,
      offset,
      limit,
      hasMore: grouped ? offset + groups.length < (totalProjects ?? 0) : offset + rows.length < total,
      summary: { ...summary, byType },
      facets: { providers: distinct("provider"), models: distinct("model"), scenes: distinct("scene") },
    });
  } catch (error) {
    console.error("读取 API 调用记录失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取 API 调用记录失败" },
      { status: 500 },
    );
  }
}

/**
 * Clear the log. `?before=<epoch ms>` drops only rows older than that instant; without it the whole
 * log goes. Deleting records costs nothing but the history — no generated media is touched.
 */
export async function DELETE(req: NextRequest) {
  try {
    const before = Number(req.nextUrl.searchParams.get("before"));
    const db = getDb();
    if (Number.isFinite(before) && before > 0) {
      // lt() maps through the column's timestamp codec; a raw comparison would bind the wrong unit
      await db.delete(apiCalls).where(lt(apiCalls.createdAt, new Date(before)));
    } else {
      await db.delete(apiCalls);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("清空 API 调用记录失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "清空 API 调用记录失败" },
      { status: 500 },
    );
  }
}

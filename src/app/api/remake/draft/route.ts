import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { join } from "path";
import { and, eq } from "drizzle-orm";
import { apiError } from "@/lib/api-error";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { extractFrameAtTime } from "@/lib/video-composer/frame-extract";
import { isJobId, jobDir, jobFileUrl } from "@/lib/remake/jobs";

export const runtime = "nodejs";

const SAFE_ID = /^[a-zA-Z0-9-]+$/;
/** A draft is page state (edits, script lines, file paths) — never media bytes */
const MAX_DRAFT_BYTES = 512 * 1024;

/**
 * GET /api/remake/draft?id= — load a 视频复刻 draft saved as a project (sourceType=remake).
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!SAFE_ID.test(id)) return apiError(req, "无效的项目ID", "Invalid project ID", 400);
  const [row] = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.sourceType, "remake")));
  if (!row) return apiError(req, "草稿不存在", "Draft not found", 404);
  return NextResponse.json({ id: row.id, name: row.name, status: row.status, draft: row.remakeDraft ?? null, updatedAt: row.updatedAt });
}

/** First frame of the source as the project-list poster (best-effort, made once per job) */
async function posterFor(draft: Record<string, unknown>): Promise<string | null> {
  const source = draft.source as { jobId?: unknown; path?: unknown } | undefined;
  if (!source || !isJobId(source.jobId) || typeof source.path !== "string") return null;
  const sourcePath = resolveUploadFilePath(source.path);
  if (!sourcePath) return null;
  const file = join(await jobDir(source.jobId), "poster.jpg");
  const exists = await stat(file).then((s) => s.size > 0).catch(() => false);
  if (!exists && !(await extractFrameAtTime(sourcePath, 0.5, file, { maxSide: 640 }))) return null;
  return jobFileUrl(source.jobId, "poster.jpg");
}

/**
 * POST /api/remake/draft — save the page as a project so it shows up under 我的项目.
 * body: { id?, name, status?: "draft" | "done", draft }. Without an id a project is created.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const draft = body.draft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return apiError(req, "草稿内容无效", "Invalid draft", 400);
  if (JSON.stringify(draft).length > MAX_DRAFT_BYTES) return apiError(req, "草稿过大", "The draft is too large", 413);
  const name = (typeof body.name === "string" && body.name.trim() ? body.name.trim() : "视频复刻").slice(0, 120);
  const status: "done" | "draft" = body.status === "done" ? "done" : "draft";
  const record = draft as Record<string, unknown>;
  const source = record.source as { path?: unknown } | undefined;

  try {
    const poster = await posterFor(record).catch(() => null);
    const values = {
      name,
      status,
      sourceType: "remake" as const,
      remakeDraft: record,
      ...(typeof source?.path === "string" && { sourceVideoUrl: source.path }),
      ...(poster && { productImages: [poster] }),
      updatedAt: new Date(),
    };
    const db = getDb();
    if (typeof body.id === "string" && body.id) {
      if (!SAFE_ID.test(body.id)) return apiError(req, "无效的项目ID", "Invalid project ID", 400);
      const [row] = await db
        .update(projects)
        .set(values)
        .where(and(eq(projects.id, body.id), eq(projects.sourceType, "remake")))
        .returning();
      if (!row) return apiError(req, "草稿不存在", "Draft not found", 404);
      return NextResponse.json({ id: row.id, updatedAt: row.updatedAt });
    }
    const [row] = await db.insert(projects).values(values).returning();
    return NextResponse.json({ id: row.id, updatedAt: row.updatedAt }, { status: 201 });
  } catch (error) {
    console.error("save remake draft failed:", error);
    return apiError(req, "保存草稿失败", "Failed to save the draft", 500);
  }
}

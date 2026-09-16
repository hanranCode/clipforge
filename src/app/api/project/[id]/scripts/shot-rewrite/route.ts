import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { scripts as scriptsTable, projects } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { reasoningParams, completeWithJsonRetry, JSON_CALL_MAX_TOKENS } from "@/lib/script-engine/generator";
import { buildShotRewritePrompt, parseShotRewrite, cleanInstruction } from "@/lib/script-engine/refine";
import { createLLMClient, jsonModeParams, llmErrorPair } from "@/lib/llm-error";
import { apiError, errText } from "@/lib/api-error";

/**
 * POST /api/project/[id]/scripts/shot-rewrite — rewrite ONE shot's copy in place (点位修改).
 *
 * The finest-grained regeneration on the script page: the whole timeline, every other shot, and
 * this shot's own structure (shotId / type / duration / visualSource / transition) are preserved;
 * only description / voiceover / camera / prompt / searchTerms come back from the model. Keeping
 * shotId fixed is what makes this safe — assets, reviews and compositions are all keyed by it, so
 * footage already generated for the shot stays attached to it.
 *
 * body: { scriptId, shotId, instruction?, llmConfig: { baseUrl, apiKey, model } }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { scriptId, llmConfig } = body as {
      scriptId?: string;
      llmConfig?: { baseUrl?: string; apiKey?: string; model?: string };
    };
    const shotId = typeof body.shotId === "number" ? body.shotId : Number.NaN;
    const instruction = cleanInstruction(body.instruction);

    if (!scriptId || !Number.isFinite(shotId)) {
      return apiError(req, "缺少 scriptId 或 shotId", "Missing scriptId or shotId", 400);
    }
    if (!llmConfig?.baseUrl || !llmConfig?.apiKey || !llmConfig?.model) {
      return apiError(req, "请配置 LLM 参数（baseUrl、apiKey、model）", "Please configure the LLM parameters (baseUrl, apiKey, model)", 400);
    }

    const db = getDb();
    const [script] = await db
      .select()
      .from(scriptsTable)
      .where(and(eq(scriptsTable.id, scriptId), eq(scriptsTable.projectId, id)));
    if (!script) return apiError(req, "脚本不存在", "Script not found", 404);

    const shots = script.shots ?? [];
    const target = shots.find((s) => s.shotId === shotId);
    if (!target) return apiError(req, "分镜不存在", "Shot not found", 404);

    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    const isTopic = project?.contentType === "topic";
    const subject = isTopic
      ? project?.topic || project?.name || ""
      : [project?.productName || project?.name || "", project?.productDescription || ""].filter(Boolean).join(" —— ");

    const prompt = buildShotRewritePrompt({
      shots,
      target,
      scriptTitle: script.title,
      subject,
      isTopic,
      instruction,
    });

    const client = createLLMClient({ baseUrl: llmConfig.baseUrl, apiKey: llmConfig.apiKey, model: llmConfig.model });
    const rewrite = await completeWithJsonRetry(
      client,
      {
        model: llmConfig.model,
        messages: [{ role: "user", content: prompt }],
        // a pinpoint edit should stay on-brief, not wander off into a new creative direction
        temperature: 0.7,
        // The reply is one small object, but a reasoning model writes its trace into the same
        // budget — sizing this for the answer alone returned an empty string after 40s of thinking.
        max_tokens: JSON_CALL_MAX_TOKENS,
        ...reasoningParams(llmConfig.baseUrl),
        ...jsonModeParams(llmConfig.baseUrl),
      },
      llmConfig as { baseUrl: string; apiKey: string; model: string },
      parseShotRewrite,
    );

    // Merge text fields only — structure and visual wiring are never taken from the reply.
    const nextShots = shots.map((s) =>
      s.shotId === shotId
        ? {
            ...s,
            voiceover: rewrite.voiceover,
            ...(rewrite.description && { description: rewrite.description }),
            ...(rewrite.camera && { camera: rewrite.camera }),
            ...(rewrite.prompt && { prompt: rewrite.prompt }),
            ...(rewrite.stockKeywords?.length && { stockKeywords: rewrite.stockKeywords }),
          }
        : s
    );

    const [updated] = await db
      .update(scriptsTable)
      .set({ shots: nextShots })
      .where(eq(scriptsTable.id, scriptId))
      .returning();

    return NextResponse.json({ success: true, shot: nextShots.find((s) => s.shotId === shotId), script: updated });
  } catch (error) {
    console.error("单镜重写失败:", error);
    const { zh, en } = llmErrorPair(error);
    return NextResponse.json(
      { error: errText(req, zh || "分镜重写失败", en || "Shot rewrite failed") },
      { status: 500 }
    );
  }
}

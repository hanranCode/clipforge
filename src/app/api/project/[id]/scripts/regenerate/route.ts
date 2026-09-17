import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { scripts as scriptsTable, projects } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { generateSingleScript, generateTopicScript } from "@/lib/script-engine/generator";
import { normalizeCategory, normalizeStyle, toDbScriptStyle } from "@/lib/script-engine/normalize";
import { buildVariantRefineRequirements, cleanInstruction } from "@/lib/script-engine/refine";
import { apiError, errText } from "@/lib/api-error";
import { llmErrorPair } from "@/lib/llm-error";

/**
 * POST /api/project/[id]/scripts/regenerate — redo ONE script variant in place.
 *
 * The batch route (/api/llm/script) deletes every variant of a project and rebuilds three. That is
 * the wrong move when the user likes two of the three: this route rewrites exactly one row, keeping
 * its **primary key**, so `selected` stays where it was and nothing downstream that references a
 * scriptId (pipeline runs, storyboard grid/film) is invalidated by the edit.
 *
 * The replacement is steered by the variant it replaces (so it comes back genuinely different, not
 * a near-copy), by its siblings (so the three cards stay distinct), and by the user's own free-text
 * instruction — a "regenerate" with no direction is just a re-roll.
 *
 * Rhythm note (爆款复刻): the clone flow's analyzed reference skeleton is not persisted on the
 * project, but the variant being replaced carries that rhythm in its own shot count + durations,
 * and those ride into the prompt — so a regenerated clone variant keeps the reference's pacing.
 *
 * body: { scriptId, instruction?, llmConfig: { baseUrl, apiKey, model } }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { scriptId, llmConfig } = body as {
      scriptId?: string;
      llmConfig?: { baseUrl?: string; apiKey?: string; model?: string; visionModel?: string };
    };
    const instruction = cleanInstruction(body.instruction);

    if (!scriptId) return apiError(req, "缺少 scriptId", "Missing scriptId", 400);
    if (!llmConfig?.baseUrl || !llmConfig?.apiKey || !llmConfig?.model) {
      return apiError(req, "请配置 LLM 参数（baseUrl、apiKey、model）", "Please configure the LLM parameters (baseUrl, apiKey, model)", 400);
    }

    const db = getDb();
    const [target] = await db
      .select()
      .from(scriptsTable)
      .where(and(eq(scriptsTable.id, scriptId), eq(scriptsTable.projectId, id)));
    if (!target) return apiError(req, "脚本不存在", "Script not found", 404);

    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) return apiError(req, "项目不存在", "Project not found", 404);

    const siblings = (await db.select().from(scriptsTable).where(eq(scriptsTable.projectId, id)))
      .filter((s) => s.id !== scriptId)
      .map((s) => ({ title: s.title, shots: s.shots ?? [] }));

    const currentShots = target.shots ?? [];
    // Keep the replaced variant's length: totalDuration is the planning contract the rest of the
    // timeline (and the film pass's max-seconds check) is built around.
    const targetDuration =
      target.totalDuration ||
      currentShots.reduce((sum, s) => sum + (s.duration || 0), 0) ||
      (project.contentType === "topic" ? 25 : 30);

    const customRequirements = buildVariantRefineRequirements({
      current: { title: target.title, shots: currentShots },
      siblings,
      instruction,
      targetDuration,
    });

    const cfg = {
      baseUrl: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
      model: llmConfig.model,
      ...(llmConfig.visionModel && { visionModel: llmConfig.visionModel }),
      // one script re-rolled in place — logged apart from a full generation (api-call-log.ts)
      log: { modelType: "text" as const, scene: "script_regenerate", projectId: id },
    };

    let generated;
    try {
      if (project.contentType === "topic") {
        const [first] = await generateTopicScript({
          topic: project.topic || project.name,
          targetDuration,
          count: 1,
          customRequirements,
          llmConfig: cfg,
        });
        generated = first;
      } else {
        generated = await generateSingleScript({
          productName: project.productName || project.name,
          category: normalizeCategory(project.productCategory),
          productDescription: project.productDescription ?? undefined,
          // reuse the stored vision analysis instead of re-billing a vision call per regeneration
          productAnalysis: project.productAnalysis ?? undefined,
          styleType: normalizeStyle(target.styleType),
          targetDuration,
          videoMode: project.videoMode ?? undefined,
          customRequirements,
          llmConfig: cfg,
        });
      }
    } catch (error) {
      console.error("单方案重新生成失败:", error);
      const { zh, en } = llmErrorPair(error);
      return NextResponse.json(
        { error: errText(req, `重新生成失败: ${zh}`, `Regeneration failed: ${en}`) },
        { status: 500 }
      );
    }

    if (!generated || generated.shots.length === 0) {
      return apiError(req, "模型没有生成有效分镜，请重试", "The model returned no usable shots — please retry", 500);
    }

    // Update in place: the row id (and therefore `selected` and every downstream scriptId
    // reference) survives. styleType is kept for topic projects, which are always "custom".
    const [updated] = await db
      .update(scriptsTable)
      .set({
        title: generated.title,
        totalDuration: generated.totalDuration,
        shots: generated.shots,
        characters: generated.characters ?? null,
        ...(project.contentType !== "topic" && { styleType: toDbScriptStyle(generated.styleType) }),
      })
      .where(eq(scriptsTable.id, scriptId))
      .returning();

    return NextResponse.json({ success: true, script: updated });
  } catch (error) {
    console.error("单方案重新生成失败:", error);
    const { zh, en } = llmErrorPair(error);
    return NextResponse.json(
      { error: errText(req, zh || "重新生成失败", en || "Regeneration failed") },
      { status: 500 }
    );
  }
}

/**
 * Targeted script refinement — the "magic wand" layer on top of batch generation.
 *
 * Batch generation is all-or-nothing: it deletes every variant and rebuilds three from scratch.
 * That is the wrong tool once a user likes two variants out of three, or likes a whole variant
 * except shot 4. This module builds the two narrower prompts that keep the rest of the work:
 *
 * 1. one VARIANT rewritten in place (the other variants ride along as "angles already taken",
 *    so the replacement stays differentiated instead of converging on the same hook), and
 * 2. one SHOT rewritten in place (its neighbours ride along as continuity context, and the
 *    shot's structural fields — id / type / duration / visual source — are stated as fixed so
 *    the reply can only change copy).
 *
 * Both take an optional free-text instruction from the user: that is the whole point of the
 * feature — "重新生成" without a direction just rolls the dice again.
 */
import type { Shot } from "@/lib/db/schema";
import { extractJSON, sanitizeVoiceover } from "./generator";

/** Hard cap on a user-typed optimisation instruction (it rides inside a much larger prompt). */
export const INSTRUCTION_MAX_LEN = 600;

/** Trim + clamp a user instruction; returns undefined when there is nothing usable. */
export function cleanInstruction(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().slice(0, INSTRUCTION_MAX_LEN);
  return text || undefined;
}

/** One-line digest of a shot, dense enough to steer a rewrite without bloating the prompt. */
function shotLine(s: Shot): string {
  const parts = [`${s.shotId}. [${s.type} ${s.duration}s]`];
  if (s.description) parts.push(s.description);
  if (s.voiceover) parts.push(`口播：${s.voiceover}`);
  return parts.join(" ");
}

/** Compact digest of a whole variant (title + shot lines). */
export function variantDigest(script: { title?: string | null; shots: Shot[] }): string {
  const head = `《${script.title || "未命名"}》`;
  return [head, ...script.shots.map(shotLine)].join("\n");
}

/**
 * The `customRequirements` block for regenerating ONE variant in place.
 *
 * The current variant is shown as "the thing being replaced" rather than a template: without it
 * the model happily returns something near-identical, which reads as a broken button. The sibling
 * variants are shown as angles to avoid, because the three cards only earn their space if they
 * stay distinct.
 */
export function buildVariantRefineRequirements(input: {
  current: { title?: string | null; shots: Shot[] };
  siblings: { title?: string | null; shots: Shot[] }[];
  instruction?: string;
  targetDuration?: number;
}): string {
  const parts: string[] = [];
  parts.push(`【本次任务：只重做这一个脚本方案】`);
  parts.push(
    `用户对下面这个方案不满意，请重新创作一个**同一商品/主题、但切入角度与开场钩子明显不同**的新方案来替换它。`
  );
  if (input.targetDuration) {
    parts.push(`总时长保持在 ${input.targetDuration} 秒左右，分镜数量保持同一量级。`);
  }
  parts.push(`\n【被替换的方案（不要照抄它的角度、钩子和文案）】`);
  parts.push(variantDigest(input.current));
  const others = input.siblings.filter((s) => s.shots.length > 0);
  if (others.length > 0) {
    parts.push(`\n【同项目其它方案已经占用的角度（务必避开，保证方案之间有明显差异）】`);
    for (const s of others) {
      const hook = s.shots[0];
      parts.push(`- 《${s.title || "未命名"}》开场：${hook?.voiceover || hook?.description || "（无）"}`);
    }
  }
  if (input.instruction) {
    parts.push(`\n【用户的优化方向指令（最高优先级，必须照做）】`);
    parts.push(input.instruction);
  }
  return parts.join("\n");
}

/**
 * Prompt for rewriting ONE shot's copy in place.
 *
 * Everything structural is declared fixed. A rewrite that changed duration or type would silently
 * invalidate the rest of the timeline (and, for `product_image` shots, the footage already matched
 * to it), so the model is only ever asked for the text fields.
 */
export function buildShotRewritePrompt(input: {
  shots: Shot[];
  target: Shot;
  scriptTitle?: string | null;
  /** Product name + selling points, or the one-line topic for topic projects. */
  subject: string;
  isTopic: boolean;
  instruction?: string;
}): string {
  const { shots, target, scriptTitle, subject, isTopic, instruction } = input;
  const parts: string[] = [];

  parts.push(
    isTopic
      ? `你是一位顶级短视频内容编导。下面是一条竖屏短视频脚本的完整分镜表，请只重写其中指定的一个分镜。`
      : `你是一位顶级电商短视频编导。下面是一条竖屏带货短视频脚本的完整分镜表，请只重写其中指定的一个分镜。`
  );
  if (subject) parts.push(`\n【${isTopic ? "主题" : "商品"}】\n${subject}`);
  if (scriptTitle) parts.push(`\n【脚本标题】\n${scriptTitle}`);

  parts.push(`\n【完整分镜表（供上下文衔接，其它分镜不要改动）】`);
  for (const s of shots) {
    parts.push(s.shotId === target.shotId ? `>>> ${shotLine(s)}   ← 需要重写的就是这一镜` : shotLine(s));
  }

  parts.push(`\n【本次只重写 shotId = ${target.shotId} 这一个分镜】`);
  parts.push(`不可更改（保持原值）：shotId=${target.shotId}、type=${target.type}、duration=${target.duration}秒、visualSource=${target.visualSource}`);
  parts.push(`可以重写：description（画面描述）、voiceover（口播文案）、camera（运镜）、prompt（英文生成提示词）、searchTerms（英文检索词）`);
  parts.push(`硬要求：`);
  parts.push(`1. 口播字数约等于 duration × 3（本镜约 ${Math.max(1, Math.round(target.duration * 3))} 字），过长会被截断`);
  parts.push(`2. 与上一镜、下一镜的内容自然衔接，不要重复它们已经讲过的信息`);
  parts.push(`3. description 只写"这一秒画面里谁在做什么"的可见事实，不写心理活动、不写两个主体同时精确配合的动作`);
  if (!isTopic && target.type === "cta") parts.push(`4. 这是转化镜，要给出明确的行动号召`);
  if (!isTopic && target.type === "hook") parts.push(`4. 这是开场钩子镜，要在 3 秒内用疑问/痛点/数字/反差抓住人`);

  if (instruction) {
    parts.push(`\n【用户的修改指令（最高优先级，必须照做）】`);
    parts.push(instruction);
  }

  parts.push(`\n【输出格式】`);
  parts.push(`只输出下面这一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：`);
  parts.push(
    JSON.stringify(
      {
        description: "画面描述",
        voiceover: "口播文案",
        camera: "运镜描述",
        prompt: "english generation prompt",
        searchTerms: ["english keyword"],
      },
      null,
      2
    )
  );

  // Language follows the subject language, same technique as buildUserPrompt: an English product
  // must not get a Chinese line back on a per-shot rewrite when the rest of the script is English.
  if (subject.trim() && !/[一-鿿]/.test(subject)) {
    parts.push(
      `\n【LANGUAGE — IMPORTANT, overrides any "中文" wording above】Write "description" and "voiceover" in the SAME language as the subject above (not Chinese). Keep "searchTerms" and "prompt" in English.`
    );
  }

  return parts.join("\n");
}

/** The text fields a shot rewrite is allowed to change. */
export interface ShotRewrite {
  description?: string;
  voiceover: string;
  camera?: string;
  prompt?: string;
  stockKeywords?: string[];
}

/** Hard caps mirroring the scripts PATCH channel (camera) and TTS sanity (voiceover). */
const CAMERA_MAX_LEN = 200;
const VOICEOVER_MAX_LEN = 500;

/**
 * Parse a single-shot rewrite reply. Throws on anything without a usable voiceover — an empty
 * line would render as a silent shot with no captions while every stage downstream reports success.
 */
export function parseShotRewrite(content: string): ShotRewrite {
  const jsonStr = extractJSON(content);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`LLM 返回的内容不是合法 JSON: ${jsonStr.slice(0, 200)}`);
  }
  // Tolerate a model that wraps the object in {shots:[...]} or returns a one-element array
  const raw = (Array.isArray(parsed)
    ? parsed[0]
    : Array.isArray((parsed as { shots?: unknown }).shots)
    ? ((parsed as { shots: unknown[] }).shots[0] as Record<string, unknown>)
    : parsed) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") throw new Error("无法解析 LLM 返回的分镜格式");

  const voiceover = sanitizeVoiceover(typeof raw.voiceover === "string" ? raw.voiceover : "").slice(0, VOICEOVER_MAX_LEN);
  if (!voiceover) throw new Error("LLM 没有写出这一镜的口播文案，请重试或换一个更强的模型");

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const rawTerms = raw.searchTerms ?? raw.stockKeywords;
  const stockKeywords = Array.isArray(rawTerms)
    ? rawTerms.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim()).slice(0, 3)
    : undefined;

  return {
    voiceover,
    ...(str(raw.description) && { description: str(raw.description) }),
    ...(str(raw.camera) && { camera: str(raw.camera)!.slice(0, CAMERA_MAX_LEN) }),
    ...(str(raw.prompt) && { prompt: str(raw.prompt) }),
    ...(stockKeywords?.length && { stockKeywords }),
  };
}

import "@/lib/api-call-store";
import type OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import { apiError, errText, pickLocale } from "@/lib/api-error";
import { withLogDefaults } from "@/lib/api-call-log";
import { buildPhotoAppearancePrompt, parsePhotoAppearance } from "@/lib/character-sheet";
import { createLLMClient, llmErrorPair, withLLMErrors } from "@/lib/llm-error";
import { toRemoteUsableImage } from "@/lib/remote-image";
import type { LLMConfig } from "@/lib/script-engine/generator";

export const runtime = "nodejs";

/**
 * POST /api/characters/describe — read a presenter's uploaded reference photos with the
 * configured vision model and draft the appearance line (+ a one-line persona) that every
 * later prompt uses. The user can still edit the text before saving.
 *
 * body: { photos: string[] (/api/files/... paths), llmConfig: LLMConfig }
 */
export async function POST(req: NextRequest) {
  try {
    const { photos, llmConfig } = (await req.json()) as { photos?: unknown; llmConfig?: LLMConfig };
    const refs = (Array.isArray(photos) ? photos : []).filter((u): u is string => typeof u === "string" && u.length > 0).slice(0, 4);
    if (!refs.length) return apiError(req, "请先上传主播参考照片", "Upload a reference photo of the presenter first", 400);
    if (!llmConfig?.baseUrl || !llmConfig.apiKey || !llmConfig.model) {
      return apiError(req, "请先配置可看图的视觉模型", "Configure a vision-capable model first", 400);
    }
    const images = (await Promise.all(refs.map(toRemoteUsableImage))).filter((u): u is string => Boolean(u && (u.startsWith("data:") || /^https?:\/\//.test(u))));
    if (!images.length) return apiError(req, "参考照片读取失败，请重新上传", "Could not read the reference photos; upload them again", 400);

    const model = llmConfig.visionModel || llmConfig.model;
    const client = createLLMClient({
      ...llmConfig,
      model,
      log: withLogDefaults(llmConfig.log, { modelType: "vision", scene: "presenter_photo_describe" }),
    });
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: buildPhotoAppearancePrompt(pickLocale(req)) },
      ...images.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })),
    ];
    const response = await withLLMErrors(
      () => client.chat.completions.create({ model, messages: [{ role: "user", content }], temperature: 0.2, max_tokens: 800 }),
      { ...llmConfig, model },
    );
    return NextResponse.json(parsePhotoAppearance(response.choices[0]?.message?.content || ""));
  } catch (error) {
    console.error("Presenter photo describe failed:", error);
    const pair = llmErrorPair(error);
    return NextResponse.json({ error: errText(req, `识别外观失败：${pair.zh}`, `Could not describe the photo: ${pair.en}`) }, { status: 500 });
  }
}

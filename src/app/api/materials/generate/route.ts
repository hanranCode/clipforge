import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { persistAssetSource } from "@/lib/asset-persistence";
import { getDb } from "@/lib/db";
import { libraryAssets } from "@/lib/db/schema";
import { apiError } from "@/lib/api-error";
import { toRemoteUsableImage } from "@/lib/remote-image";

export const runtime = "nodejs";
export const maxDuration = 300;

/** One image per explicit submission; persist the expiring result before returning it. */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const title = typeof b.title === "string" ? b.title.trim() : "";
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (!title || title.length > 120 || !prompt || prompt.length > 6000 || typeof b.provider !== "string" || !b.provider || typeof b.model !== "string" || !b.model || typeof b.apiKey !== "string" || !b.apiKey.trim()) {
      return apiError(req, "请填写名称、描述并选择已配置的生图模型", "Enter a name, prompt and configured image model", 400);
    }
    const destination = b.destination ?? "material";
    const mode = b.mode ?? "text-to-image";
    if (!["material", "presenter", "product"].includes(destination) || !["text-to-image", "image-to-image"].includes(mode)) {
      return apiError(req, "无效的生成目标或模式", "Invalid destination or generation mode", 400);
    }
    let referenceImageUrl: string | undefined;
    if (mode === "image-to-image") {
      const ref = b.referenceImageUrl;
      // Only image data, public URLs and our local upload paths can reach a provider.
      if (typeof ref !== "string" || ref.length > 28 * 1024 * 1024 || !(/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$)/.test(ref) || /^https?:\/\/[^\s]+$/.test(ref) || /^\/api\/files\/[\w/-]+\.[\w]+$/.test(ref))) {
        return apiError(req, "请选择有效的参考图片（JPG / PNG / WebP，最大 20MB）", "Select a valid reference image (JPG / PNG / WebP, up to 20MB)", 400);
      }
      referenceImageUrl = await toRemoteUsableImage(ref);
      if (!referenceImageUrl || referenceImageUrl.startsWith("/")) {
        return apiError(req, "参考图片不存在或无法读取，请重新选择", "Reference image is missing or unreadable; select it again", 400);
      }
      if (referenceImageUrl.startsWith("data:") && Buffer.byteLength(referenceImageUrl.split(",")[1] ?? "", "base64") > 20 * 1024 * 1024) {
        return apiError(req, "参考图片超过 20MB 限制", "Reference image exceeds the 20MB limit", 400);
      }
    }
    const db = getDb();
    // Verify storage/schema before spending a generation call.
    db.select({ id: libraryAssets.id }).from(libraryAssets).limit(1).all();
    const aspect = b.aspectRatio;
    // Seedream's supported pixel range; use explicit dimensions to preserve the chosen ratio.
    const [width, height] = aspect === "16:9" ? [2560, 1440] : aspect === "9:16" ? [1440, 2560] : [2048, 2048];
    const provider = createProvider({ name: b.provider, apiKey: b.apiKey, baseUrl: b.baseUrl, logContext: { scene: destination === "presenter" ? "presenter_image" : destination === "product" ? "product_image" : "library_image" } });
    const result = await provider.generateImage({ modelId: b.model, prompt, mode, ...(referenceImageUrl && { referenceImageUrl }), width, height, count: 1 });
    const source = result.imageUrls?.[0];
    if (!source) throw new Error("模型未返回图片 / Model returned no image");
    // Browser-managed products/presenters may outlive their material-library entry.
    const url = await persistAssetSource(destination === "presenter" ? "characters" : destination === "product" ? "product-generated" : "library-generated", source, 0, "image");
    const [item] = await db.insert(libraryAssets).values({ mediaType: "image", importSource: "generated", filePath: url, title, description: prompt, provider: b.provider, model: b.model, prompt }).returning();
    return NextResponse.json({ id: item.id, url, title, prompt, provider: b.provider, model: b.model }, { status: 201 });
  } catch (error) {
    return apiError(req, error instanceof Error ? error.message : "生成失败", error instanceof Error ? error.message : "Generation failed", 500);
  }
}

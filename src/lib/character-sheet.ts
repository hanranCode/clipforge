/**
 * Character sheet — multi-view reference generation for the presenter library.
 *
 * Why: a presenter described only in words drifts between generations (new face
 * every batch). One 2x2 turnaround sheet (front / side / back / close-up) rendered
 * in a single generation pins the SAME person from four angles; downstream passes
 * (storyboard grid, one-tap film, per-shot keyframes) attach the sheet as a
 * reference image, so the character stops morphing across shots and across videos.
 *
 * Pure prompt builder only; the route does the I/O.
 */
import { realFaceLine } from "@/lib/presenters";

const CJK_RE = /[一-鿿]/;

/**
 * Build the 2x2 multi-view sheet prompt. Language follows the appearance text
 * (CJK → Chinese). Hard constraints mirror the storyboard grid's: equal cells,
 * no text/borders (the sheet travels as a reference image), one identical person.
 */
export function buildCharacterSheetPrompt(appearance: string, name?: string, options: { fromReference?: boolean } = {}): string {
  // a photo-only presenter has no text yet — the reference carries the look, Chinese by default
  const zh = appearance ? CJK_RE.test(appearance) : true;
  const who = (name ?? "").trim();
  const ref = Boolean(options.fromReference);
  if (zh) {
    return [
      ref ? `以参考图中的人物为准：保持同一张脸、同一发型、同一身穿着和体型；参考图可能是随手拍的生活照，输出仍按下面的定妆图规格重新拍摄，不照搬原图背景与构图。` : "",
      `一张 2x2 等分四视图人物定妆参考图，整图 1:1 正方形，格与格之间只留极细的白色分隔缝。`,
      `四格是同一个人物在同一时刻的四个机位——同一张脸、同一发型、同一身衣服、同一站姿气质，浅灰纯色摄影棚背景。`,
      appearance || who
        ? `人物设定${who ? `（${who}）` : ""}${appearance ? `：${appearance}` : ""}。写实人体比例，头身比约 1:7~7.5，不做漫画式九头身拉长。`
        : `写实人体比例，头身比约 1:7~7.5，不做漫画式九头身拉长。`,
      `四格内容：左上=正面全身；右上=左侧面全身；左下=背面全身；右下=正面肩部以上特写（清晰展示五官）。`,
      realFaceLine(appearance) + "。",
      `硬性要求：严格等分四格；画面里不出现任何文字、编号、水印或边框装饰；四格人物必须完全是同一个人。`,
    ].filter(Boolean).join("\n");
  }
  return [
    ref ? `Match the person in the reference image(s) exactly: same face, hair, outfit and build. The reference may be a casual snapshot — re-shoot them to the sheet spec below, never copying its background or framing.` : "",
    `A 2x2 four-view character reference sheet, square 1:1 overall, cells separated only by hairline white gutters.`,
    `All four cells are the SAME person captured at the same moment from four angles — identical face, hair, outfit and posture, on a plain light-gray studio background.`,
    `Character${who ? ` (${who})` : ""}: ${appearance}. Realistic human proportions, head-to-body ratio about 1:7-7.5, never stylized elongated hero proportions.`,
    `Cells: top-left = front full body; top-right = left-side full body; bottom-left = back full body; bottom-right = front shoulders-up close-up (features clearly visible).`,
    realFaceLine(appearance) + ".",
    `Hard rules: strictly equal cells; no text, numbers, watermarks or decorative borders anywhere; the person must be exactly identical in all four cells.`,
  ].filter(Boolean).join("\n");
}

/**
 * The two shots Ark recommends for a portrait asset group: a vertical full-body front view and a
 * vertical expressionless face close-up (shoulders up, face about 2/3 of the frame). Generated for
 * an AI virtual presenter so its likeness can be registered in the private virtual-portrait
 * library — one person per image, no text, plain background, so the content review passes.
 */
export type PortraitShot = "fullBody" | "faceCloseup";

export function buildPortraitShotPrompt(appearance: string, shot: PortraitShot, options: { name?: string; fromSheet?: boolean } = {}): string {
  const zh = CJK_RE.test(appearance);
  const who = (options.name ?? "").trim();
  if (zh) {
    return [
      options.fromSheet ? `以参考图中的人物为准，保持同一张脸、同一发型、同一身衣服。` : "",
      shot === "fullBody"
        ? `竖版构图，人物正面全身站立照，从头顶到鞋完整入画，双臂自然下垂，平视镜头。`
        : `竖版构图，人物正面无表情特写，肩部以上，面部约占画面的三分之二，五官清晰，平视镜头。`,
      `人物设定${who ? `（${who}）` : ""}：${appearance}。写实人体比例。`,
      `这是 AI 原创的虚拟人物，不与任何真实人物或名人雷同。`,
      realFaceLine(appearance) + "。",
      `浅灰纯色摄影棚背景，柔和均匀的正面布光。画面中只有这一个人；不出现任何文字、水印、边框或其他人物。`,
    ].filter(Boolean).join("\n");
  }
  return [
    options.fromSheet ? `Match the person in the reference image exactly: same face, hair and outfit.` : "",
    shot === "fullBody"
      ? `Vertical portrait framing: a front-facing full-body standing photo, head to shoes fully in frame, arms relaxed, eye-level camera.`
      : `Vertical portrait framing: a front-facing neutral-expression close-up, shoulders up, the face filling about two thirds of the frame, features sharp, eye-level camera.`,
    `Character${who ? ` (${who})` : ""}: ${appearance}. Realistic human proportions.`,
    `An original AI-generated virtual person who resembles no real individual or celebrity.`,
    realFaceLine(appearance) + ".",
    `Plain light-gray studio background, soft even front lighting. Exactly one person in the image; no text, watermarks, borders or other people.`,
  ].filter(Boolean).join("\n");
}

/**
 * Vision prompt that turns presenter reference photos into an appearance line. The line feeds
 * every later prompt (scripts, sheet, keyframes), so it describes only stable, visible traits —
 * apparent age band, build, hair, outfit, one distinctive accessory — and never guesses identity,
 * ethnicity labels or celebrity likeness. Output is strict JSON so the route can parse it.
 */
export function buildPhotoAppearancePrompt(locale: "zh" | "en"): string {
  if (locale === "zh") {
    return [
      `你在为短视频主播库建档。看参考照片里的这个人（多张照片是同一个人），写一段外观描述，用于之后的 AI 生图/生视频保持人物一致。`,
      `只写照片里看得见、跨镜头稳定的特征：大致年龄段、性别、体型、脸型与五官气质、发型发色、日常妆容、穿着（颜色+款式）、1 处有辨识度的小配饰或细节。`,
      `不要猜测身份、名字、职业以外的隐私信息，不要写"像某明星"，不要写背景、光线、表情、动作。`,
      `风格参考："32 岁左右居家女性，清爽耐看有亲和力，松散低马尾带自然碎发，日常淡妆，皮肤自然真实，穿浅色宽松居家服，左手腕上套着一根用旧的发圈"。`,
      `只输出 JSON：{"appearance": "一段中文外观描述，60-120 字", "description": "一句话人设，15 字以内，按穿着气质推断即可"}`,
    ].join("\n");
  }
  return [
    `You are cataloguing a short-video presenter. Look at the person in the reference photo(s) (several photos show the same person) and write an appearance line that later AI image/video prompts will use to keep them consistent.`,
    `Only describe visible traits that stay stable across shots: apparent age band, gender, build, face shape and overall vibe, hairstyle and color, everyday makeup, outfit (color + cut), and one distinctive small accessory or detail.`,
    `Never guess identity, names or private details, never say who they resemble, and leave out background, lighting, expression and pose.`,
    `Output JSON only: {"appearance": "one English appearance line, 30-60 words", "description": "a persona tagline under 8 words inferred from their styling"}`,
  ].join("\n");
}

/** Parse the vision model's reply; tolerant of fences/prose around the JSON. Throws when no appearance came back. */
export function parsePhotoAppearance(raw: string): { appearance: string; description?: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  let appearance = "";
  let description: string | undefined;
  if (match) {
    try {
      const data = JSON.parse(match[0]) as { appearance?: unknown; description?: unknown };
      if (typeof data.appearance === "string") appearance = data.appearance.trim();
      if (typeof data.description === "string" && data.description.trim()) description = data.description.trim();
    } catch {
      // fall through to the plain-text fallback
    }
  }
  if (!appearance && !match) appearance = raw.replace(/```[a-z]*|```/g, "").trim();
  if (!appearance) throw new Error("vision model returned no appearance");
  return { appearance, ...(description && { description }) };
}

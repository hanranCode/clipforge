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
export function buildCharacterSheetPrompt(appearance: string, name?: string): string {
  const zh = CJK_RE.test(appearance);
  const who = (name ?? "").trim();
  if (zh) {
    return [
      `一张 2x2 等分四视图人物定妆参考图，整图 1:1 正方形，格与格之间只留极细的白色分隔缝。`,
      `四格是同一个人物在同一时刻的四个机位——同一张脸、同一发型、同一身衣服、同一站姿气质，浅灰纯色摄影棚背景。`,
      `人物设定${who ? `（${who}）` : ""}：${appearance}。写实人体比例，头身比约 1:7~7.5，不做漫画式九头身拉长。`,
      `四格内容：左上=正面全身；右上=左侧面全身；左下=背面全身；右下=正面肩部以上特写（清晰展示五官）。`,
      realFaceLine(appearance) + "。",
      `硬性要求：严格等分四格；画面里不出现任何文字、编号、水印或边框装饰；四格人物必须完全是同一个人。`,
    ].join("\n");
  }
  return [
    `A 2x2 four-view character reference sheet, square 1:1 overall, cells separated only by hairline white gutters.`,
    `All four cells are the SAME person captured at the same moment from four angles — identical face, hair, outfit and posture, on a plain light-gray studio background.`,
    `Character${who ? ` (${who})` : ""}: ${appearance}. Realistic human proportions, head-to-body ratio about 1:7-7.5, never stylized elongated hero proportions.`,
    `Cells: top-left = front full body; top-right = left-side full body; bottom-left = back full body; bottom-right = front shoulders-up close-up (features clearly visible).`,
    realFaceLine(appearance) + ".",
    `Hard rules: strictly equal cells; no text, numbers, watermarks or decorative borders anywhere; the person must be exactly identical in all four cells.`,
  ].join("\n");
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

/**
 * Frontend/DB value normalizers shared by every script-generation entry point.
 *
 * These used to live privately inside /api/llm/script. Single-variant regeneration and the
 * per-shot rewrite need the exact same mapping (a project's stored `productCategory` /
 * `styleType` must resolve to the same engine enums the original batch generation used),
 * so they moved here rather than being copied — a drifting copy would silently regenerate a
 * variant under a different style than the one it replaces.
 */
import type { ScriptStyleType } from "./prompts";
import type { ProductCategory } from "./templates";

/** Allowed enum values for the styleType column in the scripts table */
export const VALID_SCRIPT_STYLE = new Set([
  "pain_point", "scene", "comparison", "story",
  "drama", "reversal", "interview", "unboxing", "product_pov", "talking_head",
  "custom",
]);

/** The scripts table's styleType column type (mirrors the schema enum). */
export type DbScriptStyle =
  | "pain_point" | "scene" | "comparison" | "story"
  | "drama" | "reversal" | "interview" | "unboxing" | "product_pov" | "talking_head"
  | "custom";

/** Coerce an engine style to a value the scripts table accepts ("custom" catches anything else). */
export function toDbScriptStyle(raw: string): DbScriptStyle {
  return (VALID_SCRIPT_STYLE.has(raw) ? raw : "custom") as DbScriptStyle;
}

/** Normalize a frontend category value to a ProductCategory supported by the engine */
export function normalizeCategory(raw: unknown): ProductCategory {
  const map: Record<string, ProductCategory> = {
    beauty: "beauty",
    food: "food",
    home: "home",
    fashion: "fashion",
    tech: "tech",
    digital: "tech", // frontend uses "digital" for the "Electronics/3C" category
    "3c": "tech",
    other: "beauty", // fallback for uncategorized items
  };
  return map[String(raw ?? "").toLowerCase()] ?? "beauty";
}

/** Normalize a frontend script style value to a ScriptStyleType supported by the engine */
export function normalizeStyle(raw: unknown): ScriptStyleType {
  const map: Record<string, ScriptStyleType> = {
    pain_point: "pain_point",
    "pain-point": "pain_point",
    scene: "scene",
    scenario: "scene", // frontend uses "scenario" for the "scene recommendation" style
    comparison: "comparison",
    story: "story",
    // The four commerce-video forms (剧情形/物品形/口播形 additions)
    drama: "drama", // dialogue-driven mini-drama (multi-character conflict)
    reversal: "reversal", // expectation-subverting skit
    interview: "interview", // street-interview (host + interviewee)
    unboxing: "unboxing", // first-person immersive unboxing review
    product_pov: "product_pov", // personified product speaking first-person
    talking_head: "talking_head", // persona-driven direct-to-camera pitch
    custom: "custom",
    auto: "pain_point", // smart-recommend mode defaults to pain-point style
  };
  return map[String(raw ?? "").toLowerCase()] ?? "pain_point";
}

import type { MaterialSource } from "@/lib/material-source";
import type { AgentPlan, AgentSegment } from "./types";

export const REFERENCE_ROLES = ["product", "presenter", "scene"] as const;
export type ReferenceRole = typeof REFERENCE_ROLES[number];
/** Browser libraries supply metadata; only the server can attach a content fingerprint. */
export interface ReferenceInput {
  id: string;
  role: ReferenceRole;
  sourceId: string;
  source?: MaterialSource;
  name: string;
  description: string;
  imageUrl: string;
  facts?: { category?: string; price?: string; targetAudience?: string; appearance?: string };
}
export interface AgentReference extends ReferenceInput { sha256: string; mimeType: string; bytes: number }
export interface ReferenceSnapshot { capturedAt: number; items: AgentReference[] }
/** Omitted = inherit the first reference of that role; null = explicitly omit that role. */
export type SegmentReferences = Partial<Record<ReferenceRole, string | null>>;

export function parseSegmentReferences(value: unknown): SegmentReferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("分段素材分配无效 / Invalid segment references");
  const input = value as Record<string, unknown>, result: SegmentReferences = {};
  if (Object.keys(input).some(key => !REFERENCE_ROLES.includes(key as ReferenceRole))) throw new Error("未知素材角色 / Unknown reference role");
  for (const role of REFERENCE_ROLES) if (Object.hasOwn(input, role)) {
    const id = input[role];
    if (id === "inherit") continue;
    if (id !== null && (typeof id !== "string" || !/^[\w-]{1,100}$/.test(id))) throw new Error("素材编号无效 / Invalid reference ID");
    result[role] = id as string | null;
  }
  return result;
}
export function resolveSegmentReferences(segment: AgentSegment, items: readonly AgentReference[]): AgentReference[] {
  return REFERENCE_ROLES.flatMap(role => {
    const id = segment.references?.[role];
    if (id === null) return [];
    const item = id === undefined ? items.find(item => item.role === role) : items.find(item => item.role === role && item.id === id);
    if (id !== undefined && !item) throw new Error("分段引用了不存在或角色不符的素材，请重新分配 / Missing or mismatched reference");
    return item ? [item] : [];
  });
}
export function usesProductCrop(plan: AgentPlan, index: number, items: readonly AgentReference[]) {
  return Boolean(plan.productCrop && plan.segments[index].references?.product !== null && !items.some(item => item.role === "product"));
}
export function validatePlanReferences(plan: AgentPlan, items: readonly AgentReference[]) {
  for (const segment of plan.segments) resolveSegmentReferences(segment, items);
}

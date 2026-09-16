/**
 * Per-shot regeneration instruction ("重新生成 + 指令").
 *
 * The assets page lets a creator retake ONE shot with a free-text correction
 * ("把背景换成夜景暖光" / "remove the hand from frame"). The note is not a replacement
 * prompt: it rides on top of the shot's own compiled prompt as the LAST directive, so the
 * model reads it as the override while subject, product constraints and look stay intact.
 * Same single-variable spirit as `applyRetakePatch`, except the variable is user-written.
 *
 * Pure data + pure functions, no React / no I/O (unit-tested like the other prompt builders).
 */

/** True when the text contains CJK characters (language pick mirrors retake-patch.ts). */
function hasCjk(s: string): boolean {
  return /[一-鿿぀-ヿ가-힯]/.test(s);
}

/** Lead-in that marks the note as the highest-priority change for this take. */
const RETAKE_LEAD = {
  zh: "本次重绘的修改要求（优先级最高，其余描述保持不变）：",
  en: "Retake adjustment (highest priority, keep everything else unchanged): ",
};

/** Hard cap so a pasted essay can't drown the compiled prompt. */
export const REGEN_INSTRUCTION_MAX = 300;

/** Normalize raw textarea input: collapse whitespace, trim, cap length. */
export function sanitizeRegenInstruction(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, REGEN_INSTRUCTION_MAX);
}

/**
 * Append the creator's note to a compiled prompt. Returns the prompt untouched when the
 * note is empty (a plain regenerate must stay byte-identical to the previous take), and is
 * idempotent — re-appending an already-present note is a no-op.
 */
export function withRegenInstruction(prompt: string, raw: string | null | undefined): string {
  const note = sanitizeRegenInstruction(raw);
  if (!note) return prompt;
  const lang: "zh" | "en" = prompt && !hasCjk(prompt) && !hasCjk(note) ? "en" : "zh";
  const clause = `${RETAKE_LEAD[lang]}${note}`;
  if (prompt.includes(clause)) return prompt;
  if (!prompt.trim()) return clause;
  const sep = lang === "zh" ? "。" : ". ";
  return `${prompt.trim().replace(/[。.]\s*$/, "")}${sep}${clause}`;
}

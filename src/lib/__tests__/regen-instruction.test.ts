import { describe, it, expect } from "vitest";
import {
  REGEN_INSTRUCTION_MAX,
  sanitizeRegenInstruction,
  withRegenInstruction,
} from "@/lib/regen-instruction";

describe("sanitizeRegenInstruction（用户重生指令归一化）", () => {
  it("折叠换行与多余空白并裁剪首尾", () => {
    expect(sanitizeRegenInstruction("  换成\n\n夜景   暖光 ")).toBe("换成 夜景 暖光");
  });

  it("空值与纯空白归一为空串", () => {
    expect(sanitizeRegenInstruction(undefined)).toBe("");
    expect(sanitizeRegenInstruction(null)).toBe("");
    expect(sanitizeRegenInstruction("   \n ")).toBe("");
  });

  it("超长指令被截断到上限，不会淹没已编译的 prompt", () => {
    expect(sanitizeRegenInstruction("噪".repeat(1000))).toHaveLength(REGEN_INSTRUCTION_MAX);
  });
});

describe("withRegenInstruction（指令作为最后一条最高优先级指示）", () => {
  const zhPrompt = "特写手部演示产品按压泵头，暖光棚拍。";
  const enPrompt = "Close-up of hands pressing the pump, warm studio light.";

  it("无指令时 prompt 原样返回（普通重生与上一次出图完全一致）", () => {
    expect(withRegenInstruction(zhPrompt, "")).toBe(zhPrompt);
    expect(withRegenInstruction(zhPrompt, "   ")).toBe(zhPrompt);
    expect(withRegenInstruction(zhPrompt, undefined)).toBe(zhPrompt);
  });

  it("中文 prompt：追加在末尾，原描述一字不改", () => {
    const out = withRegenInstruction(zhPrompt, "背景换成夜景");
    expect(out.startsWith("特写手部演示产品按压泵头，暖光棚拍")).toBe(true);
    expect(out.endsWith("背景换成夜景")).toBe(true);
    expect(out).toContain("优先级最高");
  });

  it("纯英文 prompt + 英文指令走英文措辞", () => {
    const out = withRegenInstruction(enPrompt, "remove the hand from frame");
    expect(out).toContain("Retake adjustment");
    expect(out).not.toContain("本次重绘");
    expect(out.endsWith("remove the hand from frame")).toBe(true);
  });

  it("英文 prompt 配中文指令时整体走中文措辞（指令语言优先被识别）", () => {
    expect(withRegenInstruction(enPrompt, "背景换成夜景")).toContain("本次重绘的修改要求");
  });

  it("幂等：重复追加同一条指令不会叠加", () => {
    const once = withRegenInstruction(zhPrompt, "背景换成夜景");
    expect(withRegenInstruction(once, "背景换成夜景")).toBe(once);
  });

  it("空 prompt 时只返回指令子句", () => {
    expect(withRegenInstruction("", "背景换成夜景")).toBe(
      "本次重绘的修改要求（优先级最高，其余描述保持不变）：背景换成夜景"
    );
  });
});

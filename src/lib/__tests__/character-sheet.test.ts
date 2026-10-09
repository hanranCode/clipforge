import { describe, it, expect } from "vitest";
import { buildCharacterSheetPrompt, buildPhotoAppearancePrompt, parsePhotoAppearance } from "@/lib/character-sheet";

/**
 * Multi-view sheet prompt contract (v0.8.85): one 2x2 generation = one identical
 * person from four angles. The sheet then anchors identity in the grid/film passes.
 */

describe("多视图定妆 prompt", () => {
  it("中文外观：四视图布局 + 同人硬约束 + 无文字 + 真实人脸约束", () => {
    const p = buildCharacterSheetPrompt("32 岁居家女性，松散低马尾，浅色家居服", "小柔");
    expect(p).toContain("2x2 等分四视图");
    expect(p).toContain("（小柔）");
    expect(p).toContain("左上=正面全身");
    expect(p).toContain("右下=正面肩部以上特写");
    expect(p).toContain("完全是同一个人");
    expect(p).toContain("不出现任何文字");
    expect(p).toContain("清爽耐看的普通人长相"); // REAL_FACE_CONSTRAINT.zh rides along
  });

  it("英文外观整体切英文，且不混入中文", () => {
    const p = buildCharacterSheetPrompt("woman in her 30s, loose low ponytail, light loungewear");
    expect(p).toContain("2x2 four-view character reference sheet");
    expect(p).toContain("front shoulders-up close-up");
    expect(p).toContain("exactly identical in all four cells");
    expect(p).not.toMatch(/[一-鿿]/);
  });
});

describe("参考照片生成主播", () => {
  it("有参考图时 prompt 先锚定参考图人物；外观可为空且默认中文", () => {
    const p = buildCharacterSheetPrompt("", "小柔", { fromReference: true });
    expect(p.split("\n")[0]).toContain("以参考图中的人物为准");
    expect(p).toContain("（小柔）");
    expect(p).not.toContain("：。");
    expect(p).toContain("2x2 等分四视图");
  });

  it("无参考图时不出现参考图约束", () => {
    expect(buildCharacterSheetPrompt("32 岁居家女性")).not.toContain("参考图中的人物");
    expect(buildCharacterSheetPrompt("woman in her 30s", undefined, { fromReference: true })).toContain("Match the person in the reference image(s)");
  });

  it("识别 prompt 要求 JSON 且不猜身份", () => {
    expect(buildPhotoAppearancePrompt("zh")).toContain('"appearance"');
    expect(buildPhotoAppearancePrompt("zh")).toContain("不要猜测身份");
    expect(buildPhotoAppearancePrompt("en")).not.toMatch(/[一-鿿]/);
  });

  it("解析视觉模型回复：容忍代码块；无 JSON 时退回纯文本；空则报错", () => {
    expect(parsePhotoAppearance('```json\n{"appearance":" 30 岁女性，短发 ","description":"理性种草"}\n```')).toEqual({ appearance: "30 岁女性，短发", description: "理性种草" });
    expect(parsePhotoAppearance("30 岁女性，短发")).toEqual({ appearance: "30 岁女性，短发" });
    expect(() => parsePhotoAppearance('{"description":"x"}')).toThrow();
    expect(() => parsePhotoAppearance("")).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import {
  cleanInstruction,
  buildVariantRefineRequirements,
  buildShotRewritePrompt,
  parseShotRewrite,
  variantDigest,
  INSTRUCTION_MAX_LEN,
} from "@/lib/script-engine/refine";
import { normalizeCategory, normalizeStyle, toDbScriptStyle } from "@/lib/script-engine/normalize";
import { planShotDeletion } from "@/lib/script-shots";
import type { Shot } from "@/lib/db/schema";

const shot = (over: Partial<Shot> & { shotId: number }): Shot => ({
  type: "demo",
  duration: 4,
  description: "展示产品",
  camera: "固定镜头",
  visualSource: "ai_generate",
  transition: "direct_concat",
  voiceover: "这是一句口播",
  ...over,
});

const SHOTS: Shot[] = [
  shot({ shotId: 1, type: "hook", duration: 3, voiceover: "你还在用起泡网洗脸吗？", description: "女生对镜头举起洁面乳" }),
  shot({ shotId: 2, type: "demo", duration: 5, voiceover: "一泵就能揉出绵密泡沫", description: "手心揉搓出泡沫特写" }),
  shot({ shotId: 3, type: "cta", duration: 4, voiceover: "点下方小黄车带走它", description: "产品摆在洗手台上" }),
];

describe("cleanInstruction（用户指令清洗）", () => {
  it("去空白、空串视为没填", () => {
    expect(cleanInstruction("  开头再狠一点  ")).toBe("开头再狠一点");
    expect(cleanInstruction("   ")).toBeUndefined();
    expect(cleanInstruction(undefined)).toBeUndefined();
    expect(cleanInstruction(123)).toBeUndefined();
  });

  it("超长指令被截断（它要塞进一个更大的 prompt 里）", () => {
    const long = "改".repeat(INSTRUCTION_MAX_LEN + 200);
    expect(cleanInstruction(long)!.length).toBe(INSTRUCTION_MAX_LEN);
  });
});

describe("buildVariantRefineRequirements（单方案重做）", () => {
  const current = { title: "洗完不紧绷", shots: SHOTS };
  const siblings = [
    { title: "成分党实测", shots: [shot({ shotId: 1, type: "hook", voiceover: "成分表我逐条看过了" })] },
  ];

  it("带上被替换的方案本身，避免模型原地复读", () => {
    const req = buildVariantRefineRequirements({ current, siblings });
    expect(req).toContain("只重做这一个脚本方案");
    expect(req).toContain("洗完不紧绷");
    expect(req).toContain("你还在用起泡网洗脸吗？");
    expect(req).toContain("不要照抄");
  });

  it("列出其它方案已占用的角度，三张卡片才不会趋同", () => {
    const req = buildVariantRefineRequirements({ current, siblings });
    expect(req).toContain("成分党实测");
    expect(req).toContain("成分表我逐条看过了");
  });

  it("用户指令进 prompt 且标为最高优先级", () => {
    const req = buildVariantRefineRequirements({ current, siblings, instruction: "改成对比测评角度" });
    expect(req).toContain("改成对比测评角度");
    expect(req).toContain("最高优先级");
  });

  it("没填指令时不留空标题块", () => {
    expect(buildVariantRefineRequirements({ current, siblings })).not.toContain("用户的优化方向指令");
  });

  it("保留被替换方案的节奏骨架：总时长 + 每镜时长都在上下文里（爆款复刻靠这个续上参考节奏）", () => {
    const req = buildVariantRefineRequirements({ current, siblings, targetDuration: 12 });
    expect(req).toContain("12 秒");
    expect(req).toContain("[hook 3s]");
    expect(req).toContain("[cta 4s]");
  });
});

describe("variantDigest", () => {
  it("标题 + 逐镜摘要", () => {
    const d = variantDigest({ title: "洗完不紧绷", shots: SHOTS });
    expect(d).toContain("《洗完不紧绷》");
    expect(d.split("\n")).toHaveLength(4);
  });

  it("无标题时不产出 undefined 文本", () => {
    expect(variantDigest({ title: null, shots: SHOTS })).toContain("《未命名》");
  });
});

describe("buildShotRewritePrompt（定点改写一镜）", () => {
  const base = { shots: SHOTS, target: SHOTS[1], scriptTitle: "洗完不紧绷", subject: "氨基酸洁面乳", isTopic: false };

  it("把结构字段钉死，只放开文案字段", () => {
    const p = buildShotRewritePrompt(base);
    expect(p).toContain("只重写 shotId = 2");
    expect(p).toContain("不可更改");
    expect(p).toContain("type=demo");
    expect(p).toContain("duration=5秒");
    expect(p).toContain("visualSource=ai_generate");
  });

  it("整张分镜表随行做衔接上下文，目标镜被标出来", () => {
    const p = buildShotRewritePrompt(base);
    expect(p).toContain("你还在用起泡网洗脸吗？"); // 上一镜
    expect(p).toContain("点下方小黄车带走它"); // 下一镜
    expect(p).toContain("← 需要重写的就是这一镜");
  });

  it("按 duration 给出字数目标（约 3 字/秒）", () => {
    expect(buildShotRewritePrompt(base)).toContain("约 15 字");
  });

  it("钩子镜/转化镜各自追加专属硬要求", () => {
    expect(buildShotRewritePrompt({ ...base, target: SHOTS[0] })).toContain("开场钩子镜");
    expect(buildShotRewritePrompt({ ...base, target: SHOTS[2] })).toContain("转化镜");
  });

  it("用户指令最高优先级；不填则无该块", () => {
    expect(buildShotRewritePrompt({ ...base, instruction: "去掉价格" })).toContain("去掉价格");
    expect(buildShotRewritePrompt(base)).not.toContain("用户的修改指令");
  });

  it("英文商品触发语言覆盖指令（英文脚本不该回一句中文）", () => {
    const p = buildShotRewritePrompt({ ...base, subject: "Amino Acid Facial Cleanser" });
    expect(p).toContain("LANGUAGE");
    expect(buildShotRewritePrompt(base)).not.toContain("LANGUAGE");
  });

  it("主题视频用内容编导口径，不提带货", () => {
    const p = buildShotRewritePrompt({ ...base, isTopic: true, subject: "在家如何泡手冲咖啡" });
    expect(p).toContain("内容编导");
    expect(p).toContain("【主题】");
  });
});

describe("parseShotRewrite（单镜改写解析）", () => {
  it("解析裸 JSON 并归一化检索词字段", () => {
    const r = parseShotRewrite('{"description":"泡沫特写","voiceover":"一泵揉出绵密泡沫","camera":"微距推近","searchTerms":["foam closeup","facial cleanser","a","b"]}');
    expect(r.voiceover).toBe("一泵揉出绵密泡沫");
    expect(r.description).toBe("泡沫特写");
    expect(r.camera).toBe("微距推近");
    expect(r.stockKeywords).toEqual(["foam closeup", "facial cleanser", "a"]); // 最多 3 个
  });

  it("容忍 markdown 代码块和 {shots:[...]} 包装", () => {
    expect(parseShotRewrite('```json\n{"voiceover":"甲"}\n```').voiceover).toBe("甲");
    expect(parseShotRewrite('{"shots":[{"voiceover":"乙"}]}').voiceover).toBe("乙");
    expect(parseShotRewrite('[{"voiceover":"丙"}]').voiceover).toBe("丙");
  });

  it("剥掉 markdown 标记，否则 TTS 会把星号念出来", () => {
    expect(parseShotRewrite('{"voiceover":"**超值**入手"}').voiceover).toBe("超值入手");
  });

  it("空口播必须报错——否则成片是一个没声音也没字幕的镜头", () => {
    expect(() => parseShotRewrite('{"voiceover":"   "}')).toThrow();
    expect(() => parseShotRewrite('{"description":"只有画面"}')).toThrow();
  });

  it("非法 JSON 报错而不是静默吞掉", () => {
    expect(() => parseShotRewrite("模型今天不想输出 JSON")).toThrow();
  });

  it("只回了口播时，其余字段缺省不覆盖原分镜", () => {
    const r = parseShotRewrite('{"voiceover":"只改了这句"}');
    expect(r.description).toBeUndefined();
    expect(r.camera).toBeUndefined();
    expect(r.prompt).toBeUndefined();
    expect(r.stockKeywords).toBeUndefined();
  });
});

describe("normalize（共享给批量生成与单方案重做，两边必须映射一致）", () => {
  it("品类别名归一", () => {
    expect(normalizeCategory("digital")).toBe("tech");
    expect(normalizeCategory("3C")).toBe("tech");
    expect(normalizeCategory(undefined)).toBe("beauty");
  });

  it("风格别名归一，auto 落到痛点种草", () => {
    expect(normalizeStyle("scenario")).toBe("scene");
    expect(normalizeStyle("auto")).toBe("pain_point");
    expect(normalizeStyle("drama")).toBe("drama");
  });

  it("落库风格只能是表里的枚举，其余归 custom", () => {
    expect(toDbScriptStyle("unboxing")).toBe("unboxing");
    expect(toDbScriptStyle("野生风格")).toBe("custom");
  });
});

describe("planShotDeletion（删除分镜后流程仍要能走下去）", () => {
  it("删中间一镜：幸存分镜保留原 shotId（素材按 shotId 挂靠，重编号会指错镜头）", () => {
    const plan = planShotDeletion(SHOTS, [2]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.shots.map((s) => s.shotId)).toEqual([1, 3]);
  });

  it("总时长按剩下的分镜重算（一键整片和时长自检都读它）", () => {
    const plan = planShotDeletion(SHOTS, [2]);
    expect(plan.ok && plan.totalDuration).toBe(7); // 3 + 4
  });

  it("一次删多镜也走同一条路径", () => {
    const four = [...SHOTS, shot({ shotId: 4, duration: 6 })];
    const plan = planShotDeletion(four, [2, 3]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.shots.map((s) => s.shotId)).toEqual([1, 4]);
    expect(plan.totalDuration).toBe(9);
  });

  it("挡住会让后续步骤直接报错的删法：少于 2 镜就拒绝", () => {
    const plan = planShotDeletion(SHOTS, [1, 2]);
    expect(plan).toEqual({ ok: false, reason: "tooFew" });
  });

  it("删不存在的分镜 / 没给 id：明确报错而不是静默成功", () => {
    expect(planShotDeletion(SHOTS, [99])).toEqual({ ok: false, reason: "notFound" });
    expect(planShotDeletion(SHOTS, [])).toEqual({ ok: false, reason: "empty" });
    expect(planShotDeletion(SHOTS, [Number.NaN])).toEqual({ ok: false, reason: "empty" });
  });

  it("不改动幸存分镜的任何内容（只是少了一条）", () => {
    const plan = planShotDeletion(SHOTS, [2]);
    expect(plan.ok && plan.shots[0]).toEqual(SHOTS[0]);
  });
});

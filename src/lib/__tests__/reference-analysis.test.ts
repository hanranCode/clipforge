import { describe, it, expect } from "vitest";
import {
  blockingStage,
  clampThreshold,
  cutsFromShots,
  isStageStale,
  keyFrameTimes,
  MAX_EDITED_SHOTS,
  mergeWithNext,
  moveCut,
  normalizeCuts,
  orientationOf,
  sameCuts,
  shotContains,
  shotsFromCuts,
  splitAt,
  staleFromAfterWrite,
  toAnalysisView,
  type CutsResult,
  type IngestResult,
} from "@/lib/reference-analysis";
import { shotPlanFromCuts } from "@/lib/replicate-plan";

describe("staleFrom 过期标记", () => {
  it("重写一步：下游第一个已有结果的步骤过期；下游全空则不过期", () => {
    expect(staleFromAfterWrite("cuts", { ingest: 1, cuts: 1, frames: 1 }, null, "edit")).toBe("frames");
    expect(staleFromAfterWrite("cuts", { ingest: 1, cuts: 1 }, null, "edit")).toBeNull();
    // 跳过没跑过的中间步骤，落在真正有结果的那一步
    expect(staleFromAfterWrite("cuts", { ingest: 1, cuts: 1, structure: 1 }, null, "run")).toBe("structure");
  });

  it("重跑过期的那一步会清掉它自己的过期；手改不会", () => {
    expect(staleFromAfterWrite("frames", { ingest: 1, cuts: 1, frames: 1 }, "frames", "run")).toBeNull();
    expect(staleFromAfterWrite("frames", { ingest: 1, cuts: 1, frames: 1 }, "frames", "edit")).toBe("frames");
  });

  it("写一步不会让它的上游变新", () => {
    expect(staleFromAfterWrite("vision", { ingest: 1, cuts: 1, frames: 1, vision: 1 }, "frames", "run")).toBe("frames");
  });

  it("isStageStale / blockingStage", () => {
    expect(isStageStale("frames", "frames")).toBe(true);
    expect(isStageStale("vision", "frames")).toBe(true);
    expect(isStageStale("cuts", "frames")).toBe(false);
    expect(isStageStale("cuts", null)).toBe(false);

    expect(blockingStage("frames", { ingest: 1, cuts: 1 }, null)).toBeNull();
    expect(blockingStage("frames", { ingest: 1 }, null)).toBe("cuts");
    // 自己过期不挡自己重跑，上游过期才挡
    expect(blockingStage("frames", { ingest: 1, cuts: 1, frames: 1 }, "frames")).toBeNull();
    expect(blockingStage("vision", { ingest: 1, cuts: 1, frames: 1 }, "frames")).toBe("frames");
  });
});

describe("切点编辑", () => {
  it("normalizeCuts：取整到 0.1s、排序、去掉越界和贴太近的", () => {
    expect(normalizeCuts([5.04, 2.01, 9.9, 0.1, 2.2, NaN, "3"], 10)).toEqual([2, 5]);
    expect(normalizeCuts([1, 2], 0)).toEqual([]);
  });

  it("normalizeCuts：镜头数有上限", () => {
    const many = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(normalizeCuts(many, 200)).toHaveLength(MAX_EDITED_SHOTS - 1);
  });

  it("shotsFromCuts 严格按切点切，不合并短镜头", () => {
    expect(shotsFromCuts([0.5, 4], 10)).toEqual([
      { index: 1, start: 0, duration: 0.5 },
      { index: 2, start: 0.5, duration: 3.5 },
      { index: 3, start: 4, duration: 6 },
    ]);
    expect(shotsFromCuts([], 8)).toEqual([{ index: 1, start: 0, duration: 8 }]);
  });

  it("检测骨架与切点表可以互转", () => {
    const shots = shotPlanFromCuts([3.2, 5.3, 9.0], 12);
    expect(shotsFromCuts(cutsFromShots(shots), 12)).toEqual(shots);
  });

  it("合并、切分", () => {
    expect(mergeWithNext([2, 5, 8], 2)).toEqual([2, 8]);
    expect(mergeWithNext([2, 5, 8], 4)).toEqual([2, 5, 8]);
    expect(splitAt([2, 8], 5.03, 10)).toEqual([2, 5, 8]);
    // 离已有切点太近：忽略
    expect(splitAt([2, 8], 2.1, 10)).toEqual([2, 8]);
  });

  it("拖动切点被夹在左右邻居之间，不会交换顺序", () => {
    expect(moveCut([2, 5, 8], 1, 3.46, 10)).toEqual([2, 3.5, 8]);
    expect(moveCut([2, 5, 8], 1, 0, 10)).toEqual([2, 2.3, 8]);
    expect(moveCut([2, 5, 8], 1, 99, 10)).toEqual([2, 7.7, 8]);
    expect(moveCut([2, 5, 8], 2, 99, 10)).toEqual([2, 5, 9.7]);
    expect(moveCut([2, 5, 8], 5, 3, 10)).toEqual([2, 5, 8]);
  });

  it("sameCuts 容忍浮点误差", () => {
    expect(sameCuts([2, 5.0000001], [2, 5])).toBe(true);
    expect(sameCuts([2, 5], [2, 5.2])).toBe(false);
    expect(sameCuts([2], [2, 5])).toBe(false);
  });
});

describe("关键帧取点", () => {
  it("首/中/末帧往镜头内缩，不会取到相邻镜头", () => {
    expect(keyFrameTimes({ start: 2, duration: 4 }, 10)).toEqual({ first: 2.15, mid: 4, last: 5.85 });
  });

  it("极短镜头按比例内缩；末镜不越过片尾", () => {
    const short = keyFrameTimes({ start: 1, duration: 0.4 }, 10);
    expect(short.first).toBeGreaterThan(1);
    expect(short.last).toBeLessThan(1.4);
    expect(short.first).toBeLessThanOrEqual(short.mid);
    expect(short.mid).toBeLessThanOrEqual(short.last);

    // shotPlan 取整后末镜可能比片长多出一点点
    expect(keyFrameTimes({ start: 8, duration: 2.1 }, 10).last).toBeLessThanOrEqual(9.95);
  });

  it("shotContains 包含两端", () => {
    expect(shotContains({ start: 2, duration: 3 }, 2)).toBe(true);
    expect(shotContains({ start: 2, duration: 3 }, 5)).toBe(true);
    expect(shotContains({ start: 2, duration: 3 }, 5.01)).toBe(false);
  });
});

describe("杂项", () => {
  it("orientationOf / clampThreshold", () => {
    expect(orientationOf(1080, 1920)).toBe("portrait");
    expect(orientationOf(1920, 1080)).toBe("landscape");
    expect(orientationOf(0, 0)).toBe("square");
    expect(clampThreshold(0.9)).toBe(0.6);
    expect(clampThreshold("0.314")).toBe(0.31);
    expect(clampThreshold(undefined)).toBe(0.22);
  });

  it("toAnalysisView：参考结构随当前切点生成，脏的 staleFrom 被丢弃", () => {
    const ingest: IngestResult = {
      path: "/api/files/replicate/ref.mp4", source: "upload", duration: 10, width: 1080, height: 1920,
      frameRate: 30, hasAudio: true, orientation: "portrait",
    };
    const cuts: CutsResult = {
      threshold: 0.22, detected: [4], cuts: [4], shots: shotsFromCuts([4], 10), edited: true, revision: 2, durationMs: 1,
    };
    const view = toAnalysisView({ id: "a1", ingest, cuts, frames: null, staleFrom: "bogus" });
    expect(view.analysisId).toBe("a1");
    expect(view.shots).toHaveLength(2);
    expect(view.referenceStructure).toContain("第1镜 4s、第2镜 6s");
    expect(view.modelTierEligible).toBe(true);
    expect(view.staleFrom).toBeNull();
  });
});

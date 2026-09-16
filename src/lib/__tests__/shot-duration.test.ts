import { describe, it, expect } from "vitest";
import type { Shot } from "@/lib/db/schema";
import {
  MOTION_DURATION_MAX,
  MOTION_DURATION_MIN,
  SHOT_DURATION_MAX,
  SHOT_DURATION_MIN,
  motionDurationFor,
  planShotDurations,
  sanitizeShotDuration,
} from "@/lib/script-shots";

function shot(shotId: number, duration: number): Shot {
  return {
    shotId,
    type: "hook",
    duration,
    description: `分镜 ${shotId}`,
    camera: "",
    visualSource: "ai_generate",
    transition: "ffmpeg_fade",
    voiceover: "",
  };
}

describe("sanitizeShotDuration（只收数值，且钳到可落库区间）", () => {
  it("整数与数值字符串都接受", () => {
    expect(sanitizeShotDuration(6)).toBe(6);
    expect(sanitizeShotDuration(" 8 ")).toBe(8);
  });

  it("小数四舍五入到整秒（脚本时长本就是整秒）", () => {
    expect(sanitizeShotDuration(6.4)).toBe(6);
    expect(sanitizeShotDuration(6.5)).toBe(7);
  });

  it("超出硬区间被钳住，0 与负数抬到下限而不是变成 0 秒", () => {
    expect(sanitizeShotDuration(999)).toBe(SHOT_DURATION_MAX);
    expect(sanitizeShotDuration(0)).toBe(SHOT_DURATION_MIN);
    expect(sanitizeShotDuration(-3)).toBe(SHOT_DURATION_MIN);
  });

  it("非数值一律拒绝，不能静默落成 0", () => {
    for (const bad of ["", "abc", null, undefined, {}, NaN, Infinity]) {
      expect(sanitizeShotDuration(bad), String(bad)).toBeNull();
    }
  });
});

describe("motionDurationFor（图生视频实际按几秒计费/出片）", () => {
  it("区间内原样返回", () => {
    expect(motionDurationFor(7)).toBe(7);
  });

  it("短镜抬到下限、长镜压到上限——2 秒的镜头仍然按 4 秒生成", () => {
    expect(motionDurationFor(2)).toBe(MOTION_DURATION_MIN);
    expect(motionDurationFor(20)).toBe(MOTION_DURATION_MAX);
  });
});

describe("planShotDurations（改时长后重算总时长）", () => {
  const shots = [shot(1, 3), shot(2, 5), shot(3, 4)];

  it("只改命中的分镜，其余原样，totalDuration 跟着重算", () => {
    const plan = planShotDurations(shots, [{ shotId: 2, duration: 9 }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.shots.map((s) => s.duration)).toEqual([3, 9, 4]);
    expect(plan.totalDuration).toBe(16);
  });

  it("一次改多镜", () => {
    const plan = planShotDurations(shots, [{ shotId: 1, duration: 6 }, { shotId: 3, duration: 6 }]);
    expect(plan.ok && plan.totalDuration).toBe(17);
  });

  it("空补丁 / 不存在的分镜 / 非数值分别给出可分辨的原因", () => {
    expect(planShotDurations(shots, [])).toEqual({ ok: false, reason: "empty" });
    expect(planShotDurations(shots, [{ shotId: 99, duration: 5 }])).toEqual({ ok: false, reason: "notFound" });
    expect(planShotDurations(shots, [{ shotId: 1, duration: "x" }])).toEqual({ ok: false, reason: "invalid" });
  });

  it("不修改传入的 shots 数组（纯函数）", () => {
    planShotDurations(shots, [{ shotId: 1, duration: 12 }]);
    expect(shots[0].duration).toBe(3);
  });
});

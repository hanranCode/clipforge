import { describe, expect, it } from "vitest";
import { defaultSegmentSettings, firstUnapprovedSegment, segmentEditParams } from "@/lib/remake/workflow";
import { REMAKE_MODELS } from "@/lib/remake/model";
import { planSegments, validRemakeSegments } from "@/lib/remake/plan";

describe("reviewed remake workflow", () => {
  it("gates every later segment on a current approved result, including after settings change", () => {
    const runs = { 0: { status: "done", path: "one.mp4", key: "a", approved: true },
      1: { status: "done", path: "two.mp4", key: "b", approved: false } };
    expect(firstUnapprovedSegment(["a", "b", "c"], runs)).toBe(1);
    expect(firstUnapprovedSegment(["changed", "b", "c"], runs)).toBe(0);
    expect(firstUnapprovedSegment(["a", "b"], { ...runs, 1: { ...runs[1], approved: true } })).toBe(2);
    expect(firstUnapprovedSegment(["a"], { 0: { ...runs[0], status: "running" } })).toBe(0);
  });

  it("covers fractional timelines continuously within 4–10s without dropping a short tail", () => {
    for (const duration of [4, 9.999, 10.001, 12, 19.5, 23.4, 40, 65.987, 300.125]) {
      for (const maxSeconds of [8, 10]) {
        const segments = planSegments(duration, { maxSeconds, sceneTimes: [5, 9.7, 17.5, 34] });
        expect(validRemakeSegments(segments, duration)).toBe(true);
        expect(segments[0].start).toBe(0);
        expect(segments.at(-1)?.end).toBe(duration);
        segments.forEach((segment, i) => {
          expect(segment.end - segment.start).toBeLessThanOrEqual(maxSeconds + 0.001);
          if (i) expect(segment.start).toBe(segments[i - 1].end);
        });
      }
    }
    expect(validRemakeSegments([{ index: 0, start: 0, end: 11 }], 20)).toBe(false);
    expect(validRemakeSegments([{ index: 0, start: 0, end: Infinity }], 20)).toBe(false);
    expect(validRemakeSegments([{ index: 0, start: 0, end: 8 }, { index: 0, start: 8, end: 16 }], 20)).toBe(false);
    expect(validRemakeSegments([{ index: 0, start: 18, end: 24 }], 20)).toBe(false);
  });

  it("passes all supported controls while fixing edit constraints and discarding foreign fields", () => {
    expect(segmentEditParams(REMAKE_MODELS[0], { duration: 8, ratio: "9:16", omni_reference_task_type: "extend",
      resolution: "1080p-esr & 60fps", generate_audio: true, watermark: true, return_last_frame: true,
      output_format: "mov", draft: true, reference_videos: ["wrong.mp4"], seed: 123 })).toEqual({
      duration: -1, ratio: "adaptive", omni_reference_task_type: "edit", resolution: "1080p-esr & 60fps",
      generate_audio: true, watermark: true, return_last_frame: true, output_format: "mov", draft: true,
    });
    expect(segmentEditParams(REMAKE_MODELS[1], { draft: true, output_format: "mov", return_last_frame: true })).toEqual({ duration: -1, ratio: "adaptive" });
    expect(() => segmentEditParams(REMAKE_MODELS[0], { resolution: "4k" })).toThrow("INVALID_RESOLUTION");
    expect(() => segmentEditParams(REMAKE_MODELS[0], { draft: "true" })).toThrow("INVALID_DRAFT");
  });

  it.each(REMAKE_MODELS.slice(2))("maps audio and strips Seedance-only controls for %s, including normalized request extras", (model) => {
    expect(defaultSegmentSettings(model).model).toBe(model);
    const params = segmentEditParams(model, { ...defaultSegmentSettings(model), generate_audio: false,
      watermark: true, draft: true, return_last_frame: true, output_format: "mov", duration: 8 });
    expect(params).toEqual({ duration: -1, ratio: "adaptive", resolution: "720p", audio: false });
    expect(segmentEditParams(model, params)).toEqual(params);
    expect(() => segmentEditParams(model, { audio: "false" })).toThrow("INVALID_AUDIO");
  });
});

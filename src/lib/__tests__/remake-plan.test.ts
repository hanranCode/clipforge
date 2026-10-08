import { describe, it, expect } from "vitest";
import {
  buildSegmentRequest,
  cuesFromTranscript,
  localSpan,
  placeDubCues,
  planSegments,
  type RemakeImage,
  type RemakeOp,
} from "@/lib/remake/plan";

const images: RemakeImage[] = [
  { id: "a", url: "/api/files/a.jpg", label: "A" },
  { id: "b", url: "/api/files/b.jpg", label: "B" },
  { id: "c", url: "/api/files/c.jpg", label: "C" },
];

function op(partial: Partial<RemakeOp>): RemakeOp {
  return { id: partial.id ?? "op", kind: "person", target: "", detail: "", ...partial };
}

describe("planSegments", () => {
  it("keeps a short clip whole and rejects one under the model minimum", () => {
    expect(planSegments(12)).toEqual([{ index: 0, start: 0, end: 12 }]);
    expect(() => planSegments(3.2)).toThrow("TOO_SHORT");
  });

  it("splits a long clip into even segments within bounds", () => {
    const segs = planSegments(40);
    expect(segs).toHaveLength(3);
    expect(segs[0].start).toBe(0);
    expect(segs[2].end).toBe(40);
    for (const s of segs) {
      expect(s.end - s.start).toBeGreaterThanOrEqual(4);
      expect(s.end - s.start).toBeLessThanOrEqual(15);
    }
  });

  it("snaps a cut to a nearby scene change but never past the bounds", () => {
    const segs = planSegments(20, { sceneTimes: [8.6, 19.5] });
    expect(segs.map((s) => s.end)).toEqual([8.6, 20]);
    // 2.5 is a scene change but would leave a 2.5s first segment
    const safe = planSegments(20, { sceneTimes: [2.5] });
    expect(safe[0].end).toBe(10);
  });

  it("never leaves a trailing segment shorter than the minimum", () => {
    const segs = planSegments(15.5);
    expect(segs).toHaveLength(2);
    expect(segs[1].end - segs[1].start).toBeGreaterThanOrEqual(4);
  });
});

describe("localSpan", () => {
  it("clips to the segment in local seconds", () => {
    expect(localSpan({ start: 16, end: 20 }, { start: 15, end: 30 })).toEqual({ start: 1, end: 5 });
    expect(localSpan({ start: 1, end: 2 }, { start: 15, end: 30 })).toBeNull();
  });
});

describe("buildSegmentRequest", () => {
  const base = { images, keepSubtitles: true, audioMode: "keep" as const, cues: [] };

  it("writes the user's example as a Seedance edit prompt", () => {
    const req = buildSegmentRequest({
      ...base,
      segment: { index: 0, start: 0, end: 25 },
      ops: [op({ id: "p", kind: "person", target: "坐着的演员", imageId: "a", range: { start: 16, end: 20 } })],
    });
    expect(req.needsEdit).toBe(true);
    expect(req.prompt).toContain("编辑视频：16-20秒，将 @视频1 中的坐着的演员换成 @图片1 中的人物");
    expect(req.prompt).toContain("视频其他部分的运镜和细节都不改变");
    expect(req.prompt).toContain("保留原视频中的字幕");
    expect(req.imageUrls).toEqual(["/api/files/a.jpg"]);
  });

  it("renumbers images per request and rewrites @图片N in custom text", () => {
    const req = buildSegmentRequest({
      ...base,
      segment: { index: 0, start: 0, end: 10 },
      ops: [
        op({ id: "1", kind: "product", imageId: "c" }),
        op({ id: "2", kind: "custom", detail: "让 @图片2 的猫出现在桌上" }),
      ],
    });
    expect(req.imageUrls).toEqual(["/api/files/c.jpg", "/api/files/b.jpg"]);
    expect(req.prompt).toContain("替换为 @图片1 中的商品");
    expect(req.prompt).toContain("让 @图片2 的猫出现在桌上");
  });

  it("skips a segment no edit touches, and drops incomplete edits", () => {
    const req = buildSegmentRequest({
      ...base,
      segment: { index: 1, start: 15, end: 30 },
      ops: [op({ imageId: "a", range: { start: 2, end: 6 } }), op({ id: "empty", kind: "product" })],
    });
    expect(req.needsEdit).toBe(false);
    expect(req.opIds).toEqual([]);
  });

  it("omits the time prefix when the range covers the whole segment", () => {
    const req = buildSegmentRequest({
      ...base,
      segment: { index: 1, start: 15, end: 30 },
      ops: [op({ imageId: "a", range: { start: 10, end: 40 } })],
    });
    expect(req.prompt).toMatch(/^编辑视频：将 @视频1/);
  });

  it("drives lip sync from the dub when the segment has lines, even with no visual edit", () => {
    const req = buildSegmentRequest({
      ...base,
      audioMode: "dub",
      segment: { index: 0, start: 0, end: 10 },
      ops: [],
      cues: [{ id: "c1", start: 1, end: 3, text: "大家好" }],
    });
    expect(req.needsEdit).toBe(true);
    expect(req.useDubAudio).toBe(true);
    expect(req.prompt).toContain("@音频1");
  });

  it("asks to remove subtitles when they are not kept", () => {
    const req = buildSegmentRequest({ ...base, keepSubtitles: false, segment: { index: 0, start: 0, end: 8 }, ops: [op({ imageId: "a" })] });
    expect(req.prompt).toContain("去掉画面中的字幕");
  });
});

describe("dub cues", () => {
  it("cleans transcript segments into ordered, non-overlapping cues", () => {
    const cues = cuesFromTranscript(
      [
        { start: 2, end: 4, text: " 第二句 " },
        { start: 0, end: 2.5, text: "第一句" },
        { start: 5, end: 6, text: "  " },
      ],
      10,
    );
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [0, 2.5, "第一句"],
      [2.5, 4, "第二句"],
    ]);
  });

  it("speeds a long line up to fit its slot, capped", () => {
    const placed = placeDubCues(
      [
        { id: "a", start: 0, end: 2, text: "x", audioSeconds: 2.4 },
        { id: "b", start: 2, end: 3, text: "y", audioSeconds: 5 },
      ],
      4,
    );
    expect(placed[0]).toMatchObject({ slot: 2, tempo: 1.2 });
    expect(placed[1]).toMatchObject({ slot: 2, tempo: 1.35 });
  });
});

describe("dubFilterGraph", () => {
  it("delays to the first line, fits each line to its slot and trims to the clip", async () => {
    const { dubFilterGraph } = await import("@/lib/remake/render");
    const graph = dubFilterGraph(
      [
        { id: "a", start: 1, end: 3, text: "x", audioSeconds: 2.6 },
        { id: "b", start: 12, end: 14, text: "y", audioSeconds: 1.5 },
      ],
      22,
    );
    expect(graph).toContain("[0:a]aformat=sample_rates=44100:channel_layouts=mono,apad,atrim=0:11.000");
    expect(graph).toContain("[1:a]aformat=sample_rates=44100:channel_layouts=mono,apad,atrim=0:10.000");
    expect(graph).toContain("[s0][s1]concat=n=2:v=0:a=1[cat]");
    expect(graph).toContain("adelay=1000:all=1,apad,atrim=0:22.000[out]");
  });
});

describe("video remake model scenarios", () => {
  it("tags Seedance 2.5's reference endpoint for video edit, not its text-to-video twin", async () => {
    const { modelScenarios } = await import("@/lib/model-scenarios");
    const ref = { id: "bytedance/seedance-2.5/reference-to-video", provider: "atlas-cloud", mediaType: "video", modes: ["image-to-video", "video-to-video"] };
    const t2v = { id: "bytedance/seedance-2.5/text-to-video", provider: "atlas-cloud", mediaType: "video", modes: ["text-to-video"] };
    expect(modelScenarios(ref)).toContain("videoEdit");
    expect(modelScenarios(t2v)).not.toContain("videoEdit");
  });
});

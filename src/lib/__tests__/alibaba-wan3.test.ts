import { describe, expect, it, vi } from "vitest";
import { AlibabaProvider, buildWanOmniBody, isWanOmniModel, toWanReferenceSyntax } from "@/lib/providers/alibaba";
import { modelScenarios } from "@/lib/model-scenarios";

const cfg = { name: "alibaba", apiKey: "test", baseUrl: "https://example.com" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRequest = (p: any, value: unknown) => vi.spyOn(p, "request").mockResolvedValue(value);

describe("Wan 3.0 (alibaba)", () => {
  it("recognises the 3.0 ids only", () => {
    expect(isWanOmniModel("wan3.0-video")).toBe(true);
    expect(isWanOmniModel("wan3.0-video-prime")).toBe(true);
    expect(isWanOmniModel("wan2.6-i2v")).toBe(false);
    expect(isWanOmniModel("wanx2.1-i2v-plus")).toBe(false);
  });

  it("rewrites Seedance-style @ references into Wan's 图N / 视频N / 音频N", () => {
    expect(toWanReferenceSyntax("将 @视频1 的背景替换为 @图片2 中的场景，口型与 @音频1 同步")).toBe(
      "将 视频1 的背景替换为 图2 中的场景，口型与 音频1 同步",
    );
    expect(toWanReferenceSyntax("将 @Video1 的背景替换为 @Image2，使用 @Audio1")).toBe("将 视频1 的背景替换为 图2，使用 音频1");
  });

  it("builds a video-edit body: media array in reference order, adaptive ratio, caller extras win", () => {
    const body = buildWanOmniBody({
      modelId: "wan3.0-video",
      mode: "video-to-video",
      prompt: "将 @视频1 中的人物换成 @图片1 中的人物",
      referenceImageUrls: ["https://x/a.png", "data:image/png;base64,AAAA"],
      referenceVideoUrls: ["https://x/seg.mp4"],
      referenceAudioUrls: ["https://x/dub.mp3"],
      width: 1080,
      height: 1920,
      duration: 12,
      audioEnabled: true,
      extra: { prompt_extend: false },
    });
    expect(body.input).toEqual({
      prompt: "将 视频1 中的人物换成 图1 中的人物",
      media: [
        { type: "reference_image", url: "https://x/a.png" },
        { type: "reference_image", url: "data:image/png;base64,AAAA" },
        { type: "reference_video", url: "https://x/seg.mp4" },
        { type: "reference_audio", url: "https://x/dub.mp3" },
      ],
    });
    expect(body.parameters).toEqual({
      resolution: "1080P",
      ratio: "adaptive",
      duration: 12,
      audio: true,
      watermark: false,
      prompt_extend: false,
    });
  });

  it("keeps first/last frames as frames without references, and folds them in with references", () => {
    const frames = buildWanOmniBody({ modelId: "wan3.0-video", mode: "image-to-video", prompt: "x", firstFrameUrl: "f", lastFrameUrl: "l", width: 1280, height: 720 });
    expect((frames.input as { media: unknown[] }).media).toEqual([
      { type: "first_frame", url: "f" },
      { type: "last_frame", url: "l" },
    ]);
    expect((frames.parameters as { ratio: string; resolution: string })).toMatchObject({ ratio: "16:9", resolution: "720P" });

    const mixed = buildWanOmniBody({ modelId: "wan3.0-video", mode: "image-to-video", prompt: "x", firstFrameUrl: "f", referenceImageUrls: ["r"] });
    expect((mixed.input as { media: Array<{ type: string }> }).media.map((m) => m.type)).toEqual(["reference_image", "reference_image"]);
  });

  it("submits 3.0 to video-synthesis and older Wan to the legacy endpoint", async () => {
    const p = new AlibabaProvider(cfg);
    const spy = mockRequest(p, { request_id: "r", output: { task_id: "t1", task_status: "PENDING" } });
    await expect(p.submitVideoTask({ modelId: "wan3.0-video", mode: "video-to-video", prompt: "x", referenceVideoUrls: ["v"] })).resolves.toEqual({ taskId: "t1", modelId: "wan3.0-video" });
    expect(spy.mock.calls[0][0]).toBe("/services/aigc/video-generation/video-synthesis");
    await p.submitVideoTask({ modelId: "wan2.6-i2v", mode: "image-to-video", prompt: "x", firstFrameUrl: "f" });
    expect(spy.mock.calls[1][0]).toBe("/services/aigc/video-generation/generation");
  });

  it("reports a 3.0 task failure from code/message", async () => {
    const p = new AlibabaProvider(cfg);
    mockRequest(p, { request_id: "r", output: { task_id: "t1", task_status: "FAILED", code: "InvalidParameter", message: "bad media" } });
    await expect(p.getTaskStatus("t1")).resolves.toMatchObject({ status: "failed", error: "bad media", errorCode: "InvalidParameter" });
  });

  it("is offered for video edit", async () => {
    const models = await new AlibabaProvider(cfg).listModels("video");
    const wan3 = models.find((m) => m.id === "wan3.0-video")!;
    expect(modelScenarios(wan3)).toContain("videoEdit");
    expect(modelScenarios(models.find((m) => m.id === "wan2.6-i2v")!)).not.toContain("videoEdit");
  });

  it("refuses a Wan 3.0 submission without the workspace endpoint before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const provider = new AlibabaProvider({ ...cfg, baseUrl: "" });
      await expect(provider.submitVideoTask({ modelId: "wan3.0-video", mode: "video-to-video", prompt: "edit" }))
        .rejects.toMatchObject({ code: "BAILIAN_ENDPOINT_REQUIRED", statusCode: 400 });
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});

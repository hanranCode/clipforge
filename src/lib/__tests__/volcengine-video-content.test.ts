import { afterEach, describe, expect, it, vi } from "vitest";
import { VolcEngineProvider, explainArkInputRejection } from "@/lib/providers/volcengine";
import { ProviderError } from "@/lib/providers/base";

afterEach(() => vi.unstubAllGlobals());

describe("VolcEngine video content", () => {
  it("submits a Seedance 2.0 Mini asset request without mixing frame and reference roles", async () => {
    let submitted: { content: Array<{ role?: string; text?: string; image_url?: { url: string } }> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      submitted = JSON.parse(String(init.body));
      const roles = submitted!.content.map((item) => item.role);
      const hasFrames = roles.some((role) => role === "first_frame" || role === "last_frame");
      const hasReferences = roles.some((role) => role?.startsWith("reference_"));
      if (hasFrames && hasReferences) {
        return new Response(JSON.stringify({ error: { code: "InvalidParameter", message: "first/last frame content cannot be mixed with reference media content" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ id: "task-1" }), { status: 200 });
    }));

    const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: "" });
    await expect(provider.submitVideoTask({
      modelId: "doubao-seedance-2-0-mini-260615",
      mode: "image-to-video",
      prompt: "show the product",
      firstFrameUrl: "https://example.com/first.png",
      lastFrameUrl: "https://example.com/last.png",
      referenceImageUrls: ["https://example.com/product.png"],
    })).resolves.toEqual({ taskId: "task-1", modelId: "doubao-seedance-2-0-mini-260615" });
    expect(submitted?.content.map((item) => item.role).slice(1)).toEqual([
      "reference_image", "reference_image", "reference_image",
    ]);
    expect(submitted?.content[0].text).toContain("图片 1 为首帧，图片 2 为尾帧");
    expect(submitted?.content.slice(1).map((item) => item.image_url?.url)).toEqual([
      "https://example.com/first.png", "https://example.com/last.png", "https://example.com/product.png",
    ]);
  });

  it("preserves native frame roles when no reference media is supplied", async () => {
    let submitted: { content: Array<{ role?: string }> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      submitted = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "task-2" }), { status: 200 });
    }));
    const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: "" });
    await provider.submitVideoTask({
      modelId: "doubao-seedance-2-0-mini-260615", mode: "image-to-video", prompt: "motion",
      firstFrameUrl: "https://example.com/first.png", lastFrameUrl: "https://example.com/last.png",
    });
    expect(submitted?.content.map((item) => item.role).slice(1)).toEqual(["first_frame", "last_frame"]);
  });

  it("names the reference image Ark rejected as a real person and points to asset://", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "InputImageSensitiveContentDetected.PrivacyInformation",
        message: "The request failed because the input image 'content[2]' may contain real person.",
        param: "content[2]",
        type: "BadRequest",
      },
    }), { status: 400 })));
    const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: "" });
    const submit = provider.submitVideoTask({
      modelId: "doubao-seedance-2-0-260128", mode: "video-to-video", prompt: "replace the person",
      referenceImageUrls: ["https://example.com/product.png", "https://example.com/face.png"],
      referenceVideoUrls: ["https://example.com/source.mp4"],
    });
    await expect(submit).rejects.toMatchObject({ code: "REAL_PERSON_REJECTED", statusCode: 400 });
    await expect(submit).rejects.toThrow(/「参考图 2」.*asset:\/\//);
  });

  it("names a rejected reference video and leaves unrelated errors alone", () => {
    const content = [
      { type: "text", text: "x" },
      { type: "image_url", role: "reference_image" },
      { type: "video_url", role: "reference_video" },
    ];
    const rejected = explainArkInputRejection(
      new ProviderError('API 请求失败: 400 - {"error":{"code":"InputVideoSensitiveContentDetected.PrivacyInformation","param":"content[2]"}}', "API_ERROR", "volcengine", 400),
      content,
    );
    expect(rejected?.message).toContain("「参考视频 1」");
    expect(explainArkInputRejection(new ProviderError("API 请求失败: 400 - {}", "API_ERROR", "volcengine", 400), content)).toBeNull();
  });
});

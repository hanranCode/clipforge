// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasCloudProvider } from "@/lib/providers/atlas-cloud";
import { VolcEngineProvider } from "@/lib/providers/volcengine";
import { ARK_REMAKE_MODELS, REMAKE_MODELS } from "@/lib/remake/model";

const state = vi.hoisted(() => ({ create: vi.fn(), record: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/providers", () => ({ createProvider: state.create }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: state.record, updateAiTask: state.update }));
vi.mock("@/lib/remote-image", () => ({
  toRemoteUsableImage: async (url?: string) => url?.startsWith("/api/files/") ? "data:image/png;base64,REFERENCE" : url,
  resolveUploadFilePath: (url: string) => url.startsWith("/api/files/") ? `/tmp/${url.split("/").pop()}` : null,
}));
vi.mock("@/lib/reference-resource-server", () => ({
  requireReferenceStorage: (config: unknown) => { if (!config) throw new Error("TOS_REQUIRED"); },
  resolveReferenceResource: async (_config: unknown, ref: string) => ({
    id: ref, mediaType: /\.png$/.test(ref) ? "image" : /\.(wav|mp3)$/.test(ref) ? "audio" : "video",
    url: ref.startsWith("https://") ? ref : `https://tos.example.com/${ref.split("/").pop()}`,
  }),
}));
import { POST } from "@/app/api/ai/video/route";

const input = {
  provider: "atlas-cloud", model: REMAKE_MODELS[0], apiKey: "test-key",
  mode: "video-to-video", scene: "video_remake", projectId: "remake-project",
  prompt: "编辑视频：将 @视频1 中的人物换成 @图片1，口型与 @音频1 同步",
  referenceVideoUrls: ["/api/files/source.mp4"],
  referenceImageUrls: ["/api/files/portrait.png"],
  referenceAudioUrls: ["/api/files/dub.wav"],
  objectStorage: { endpoint: "https://tos-s3-cn-beijing.volces.com", region: "cn-beijing", bucket: "test", accessKeyId: "test", secretAccessKey: "test" },
  options: { width: 1080, height: 1920, duration: 7.6, audioEnabled: true },
};
async function submit(body: unknown) {
  return POST(new NextRequest("http://localhost/api/ai/video", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  }));
}
beforeEach(() => {
  vi.clearAllMocks();
  state.record.mockResolvedValue("saved-row");
  state.update.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Atlas video remake contract", () => {
  it("reports Ark's real-person rejection without recording or polling a task", async () => {
    const ark = new VolcEngineProvider({ name: "volcengine", apiKey: "ark-test-key", baseUrl: "https://ark.example.com/api/v3" });
    state.create.mockReturnValue(ark);
    const poll = vi.spyOn(ark, "waitForTask");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: {
      code: "InputImageSensitiveContentDetected.PrivacyInformation",
      message: "The input image 'content[1]' may contain real person. Request id: rejection-id",
    } }), { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const result = await submit({ ...input, provider: "volcengine", model: ARK_REMAKE_MODELS[0], wait: false });
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: "InputImageSensitiveContentDetected.PrivacyInformation",
      provider: "volcengine", recoverable: false, error: expect.stringContaining("真人") });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.record).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });

  it("returns the persisted paid task before polling when the remake requests wait=false", async () => {
    const provider = {
      submitVideoTask: vi.fn().mockResolvedValue({ taskId: "paid-task", modelId: REMAKE_MODELS[2] }),
      waitForTask: vi.fn(),
    };
    state.create.mockReturnValue(provider);
    const result = await submit({ ...input, model: REMAKE_MODELS[2], wait: false });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ taskId: "paid-task", status: "submitted", recoverable: true });
    expect(state.record).toHaveBeenCalledWith(expect.objectContaining({ taskId: "paid-task", projectId: "remake-project" }));
    expect(provider.waitForTask).not.toHaveBeenCalled();
    expect(provider.submitVideoTask).toHaveBeenCalledTimes(1);
  });

  it("keeps all 30 Seedance 2.5 images and the selected optional parameters in the paid request", async () => {
    const atlas = new AtlasCloudProvider({ name: "atlas-cloud", apiKey: "test-key", baseUrl: "https://api.atlascloud.ai/api/v1" });
    state.create.mockReturnValue(atlas);
    vi.spyOn(atlas, "uploadLocalMedia").mockResolvedValue("https://example.com/media.mp4");
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ data: { id: "draft-task" } }));
      }
      return new Response(JSON.stringify({ data: { id: "draft-task", status: "completed", draft_id: "draft-123", draft: true,
        last_frame_url: "https://example.com/tail.jpg", outputs: ["https://example.com/draft.mov"] } }));
    }));
    const result = await submit({ ...input, referenceImageUrls: Array.from({ length: 30 }, (_, i) => `https://example.com/image-${i}.png`),
      options: { ...input.options, audioEnabled: false, extra: { resolution: "1080p-esr", generate_audio: true,
        watermark: true, return_last_frame: true, output_format: "mov", draft: true } } });
    expect(result.status).toBe(200);
    expect(body.reference_images).toHaveLength(30);
    expect(body).toMatchObject({ resolution: "1080p-esr", generate_audio: true, watermark: true, return_last_frame: true, output_format: "mov", draft: true, duration: -1, ratio: "adaptive" });
    expect(await result.json()).toMatchObject({ hasAudio: true, lastFrameUrl: "https://example.com/tail.jpg", extra: { draft_id: "draft-123" } });
  });

  it.each(REMAKE_MODELS.slice(0, 2))("uploads references and submits the documented edit body for %s", async (model) => {
    const atlas = new AtlasCloudProvider({ name: "atlas-cloud", apiKey: "test-key", baseUrl: "https://api.atlascloud.ai/api/v1" });
    state.create.mockReturnValue(atlas);
    const upload = vi.spyOn(atlas, "uploadLocalMedia").mockImplementation(async (file) => `https://media.example.com/${file.split("/").pop()}`);
    let submittedBody: Record<string, unknown> = {};
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(url).toBe("https://api.atlascloud.ai/api/v1/model/generateVideo");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-key");
        submittedBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ code: 200, data: { id: "paid-task" } }));
      }
      expect(url).toBe("https://api.atlascloud.ai/api/v1/model/prediction/paid-task");
      expect(state.record).toHaveBeenCalledWith(expect.objectContaining({ taskId: "paid-task", provider: "atlas-cloud", model, projectId: "remake-project" }));
      // 2.0 direct response and 2.5 wrapper responses are both supported by the adapter.
      const prediction = { id: "paid-task", status: "completed", model, outputs: ["https://media.example.com/result.mp4"] };
      return new Response(JSON.stringify(model.includes("2.5") ? { code: 200, data: prediction } : prediction));
    });
    vi.stubGlobal("fetch", fetch);
    const result = await submit({ ...input, model, options: {
      ...input.options,
      // Stale/general settings must not turn an edit into a fixed-duration reference generation.
      modelId: "wrong-model", mode: "text-to-video", referenceVideoUrls: ["wrong-ref"],
      extra: { duration: 8, ratio: "9:16", omni_reference_task_type: "reference" },
    } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ taskId: "paid-task", modelId: model, videoUrls: ["https://media.example.com/result.mp4"] });
    expect(upload).not.toHaveBeenCalled();
    expect(submittedBody).toMatchObject({
      model, prompt: "编辑视频：将 @Video1 中的人物换成 @Image1，口型与 @Audio1 同步",
      reference_videos: ["https://tos.example.com/source.mp4"],
      reference_images: ["https://tos.example.com/portrait.png"],
      reference_audios: ["https://tos.example.com/dub.wav"],
      duration: -1, ratio: "adaptive", resolution: "1080p", generate_audio: true, watermark: false,
    });
    if (model.includes("2.5")) expect(submittedBody.omni_reference_task_type).toBe("edit");
    else expect(submittedBody).not.toHaveProperty("omni_reference_task_type");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.update).toHaveBeenCalledWith("saved-row", expect.objectContaining({ status: "completed" }));
  });

  it.each(REMAKE_MODELS.slice(2).flatMap((model) => [true, false].map((audio) => ({ model, audio }))))(
    "submits typed references and the Wan audio toggle for $model (audio=$audio)", async ({ model, audio }) => {
      const atlas = new AtlasCloudProvider({ name: "atlas-cloud", apiKey: "test-key", baseUrl: "https://api.atlascloud.ai/api/v1" });
      state.create.mockReturnValue(atlas);
      let body: Record<string, unknown> = {};
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          body = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ data: { id: "wan-task" } }));
        }
        return new Response(JSON.stringify({ data: { id: "wan-task", status: "completed", outputs: ["https://example.com/wan.mp4"] } }));
      }));
      const images = Array.from({ length: 10 }, (_, i) => `https://example.com/image-${i}.png`);
      const result = await submit({ ...input, model, referenceImageUrls: images,
        options: { ...input.options, audioEnabled: !audio, extra: { audio, resolution: "1080p-esr",
          watermark: true, draft: true, return_last_frame: true, output_format: "mov", omni_reference_task_type: "edit" } } });
      expect(result.status).toBe(200);
      expect(body).toEqual({ model, prompt: "编辑视频：将 @Video1 中的人物换成 @Image1，口型与 @Audio1 同步",
        refers: [{ url: "https://tos.example.com/source.mp4", type: "video" },
          ...images.map((url) => ({ url, type: "image" })), { url: "https://tos.example.com/dub.wav", type: "audio" }],
        duration: -1, ratio: "adaptive", resolution: "1080p-esr", audio });
      expect(await result.json()).toMatchObject({ taskId: "wan-task", modelId: model, hasAudio: audio });
      expect(state.record).toHaveBeenCalledWith(expect.objectContaining({ taskId: "wan-task", model }));
    },
  );

  it.each(ARK_REMAKE_MODELS)("submits native Ark editing references and persists the task before polling: %s", async (model) => {
    const ark = new VolcEngineProvider({ name: "volcengine", apiKey: "ark-test-key", baseUrl: "https://ark.example.com/api/v3" });
    state.create.mockReturnValue(ark);
    let submittedBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer ark-test-key");
      if (init?.method === "POST") {
        expect(url).toBe("https://ark.example.com/api/v3/contents/generations/tasks");
        submittedBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: "ark-paid-task" }));
      }
      expect(url).toBe("https://ark.example.com/api/v3/contents/generations/tasks/ark-paid-task");
      expect(state.record).toHaveBeenCalledWith(expect.objectContaining({ taskId: "ark-paid-task", provider: "volcengine", model }));
      return new Response(JSON.stringify({ id: "ark-paid-task", model, status: "succeeded", content: { video_url: "https://example.com/ark-result.mp4" } }));
    }));
    const result = await submit({ ...input, provider: "volcengine", model, apiKey: "ark-test-key", baseUrl: "https://ark.example.com/api/v3",
      options: { ...input.options, firstFrameUrl: "https://stale.example.com/frame.png", lastFrameUrl: "https://stale.example.com/tail.png",
        audioPrompt: "stale audio instructions", voiceover: "stale voiceover", extra: {
          duration: 8, ratio: "9:16", resolution: "720p", watermark: true, generate_audio: false, return_last_frame: false,
          draft: true, output_format: "mov", omni_reference_task_type: "extend", model: "wrong", content: [] } },
    });
    expect(result.status).toBe(200);
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ name: "volcengine", apiKey: "ark-test-key", baseUrl: "https://ark.example.com/api/v3" }));
    expect(submittedBody).toEqual({ model,
      content: [{ type: "text", text: "编辑视频：将 @Video1 中的人物换成 @Image1，口型与 @Audio1 同步" },
        { type: "image_url", image_url: { url: "https://tos.example.com/portrait.png" }, role: "reference_image" },
        { type: "video_url", video_url: { url: "https://tos.example.com/source.mp4" }, role: "reference_video" },
        { type: "audio_url", audio_url: { url: "https://tos.example.com/dub.wav" }, role: "reference_audio" }],
      duration: -1, ratio: "adaptive", resolution: "720p", generate_audio: false, watermark: true, return_last_frame: false,
      ...(model === ARK_REMAKE_MODELS[0] && { omni_reference_task_type: "edit" }),
    });
    expect(await result.json()).toMatchObject({ taskId: "ark-paid-task", videoUrls: ["https://example.com/ark-result.mp4"], hasAudio: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { prompt: "Replace @Video2" },
    { prompt: "Replace @Image2" },
    { prompt: "Sync @Audio2" },
    { prompt: "Replace @RemovedImage1" },
    { referenceImageUrls: "image.png" },
    { referenceAudioUrls: [42] },
    { objectStorage: null },
    { provider: "volcengine" },
    { provider: "atlas-cloud", model: ARK_REMAKE_MODELS[0] },
    ...ARK_REMAKE_MODELS.flatMap((model) => [
      { provider: "volcengine", model, referenceImageUrls: Array(10).fill("image.png") },
      { provider: "volcengine", model, referenceAudioUrls: Array(4).fill("audio.wav") },
      { provider: "volcengine", model, options: { extra: { resolution: "1080p-esr" } } },
    ]),
    { provider: "alibaba", model: "wan3.0-omni" },
    { model: "alibaba/wan-2.7/reference-to-video" },
    { model: "bytedance/seedance-2.5/image-to-video" },
    { model: "bytedance/seedance-2.0-mini/reference-to-video" },
    { mode: "text-to-video" },
    { referenceVideoUrls: [] },
    { referenceVideoUrls: ["a.mp4", "b.mp4"] },
    { referenceImageUrls: Array(31).fill("image.png") },
    { model: REMAKE_MODELS[1], referenceImageUrls: Array(10).fill("image.png") },
    ...REMAKE_MODELS.slice(2).flatMap((model) => [
      { model, referenceImageUrls: Array(11).fill("image.png") },
      { model, referenceAudioUrls: Array(6).fill("audio.wav") },
      { model, options: { extra: { audio: "false" } } },
    ]),
    { options: { extra: { resolution: "4k" } } },
  ])("rejects an invalid remake before uploading or creating a paid task: %j", async (patch) => {
    vi.stubGlobal("fetch", vi.fn());
    expect((await submit({ ...input, ...patch })).status).toBe(400);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

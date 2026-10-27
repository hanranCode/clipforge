// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareStudioVideo, submitStudioVideo, studioTaskStatus } from "@/lib/agent-studio/video-provider";
const upload = vi.hoisted(() => vi.fn().mockResolvedValue("https://bucket.example.com/voice.wav"));
vi.mock("@/lib/object-storage-server", () => ({ uploadToObjectStorage: upload }));
vi.mock("@/lib/server-object-storage", () => ({ requireServerObjectStorage: () => ({ bucket: "server-storage" }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const video = { provider: "alibaba", model: "wan3.0-video", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1", resolution: "720p" as const };
describe("Studio provider contract", () => {
  it("rejects an image-free Atlas reference request before uploading or submitting anything", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(prepareStudioVideo({ ...video, provider: "atlas-cloud", model: "bytedance/seedance-2.5/reference-to-video" }, "test", [{ type: "text", text: "no images" }], "/tmp/version", 0, 9)).rejects.toThrow("需要参考图");
    expect(fetcher).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  });
  it("uploads voice references before submitting Wan, retaining image order and ordinal syntax", async () => {
    const options = await prepareStudioVideo(video, "test", [
      { type: "text", text: "参考@图片1与@图片2，口型匹配@音频1" },
      { type: "image_url", image_url: { url: "data:image/png;base64,ONE" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,TWO" } },
      { type: "audio_url", audio_url: { url: "data:audio/wav;base64,PRIVATE" } },
    ], "/tmp/version", 2, 9);
    expect(upload).toHaveBeenCalledWith({ bucket: "server-storage" }, "/tmp/version/voice-2.wav");
    const fetcher = vi.fn().mockResolvedValue(Response.json({ output: { task_id: "wan-paid", task_status: "PENDING" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(submitStudioVideo(video, "test", [], 9, options)).resolves.toBe("wan-paid");
    const payload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload).toMatchObject({ model: "wan3.0-video", input: { prompt: "参考图1与图2，口型匹配音频1", media: [
      { type: "reference_image", url: "data:image/png;base64,ONE" },
      { type: "reference_image", url: "data:image/png;base64,TWO" },
      { type: "reference_audio", url: "https://bucket.example.com/voice.wav" },
    ] }, parameters: { resolution: "720P", ratio: "9:16", duration: 9, audio: true } });
    expect(JSON.stringify(payload)).not.toContain("PRIVATE");
  });
  it("normalizes a completed Wan task without requiring Ark billing tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ output: { task_id: "wan-paid", task_status: "SUCCEEDED", video_url: "https://example.com/output.mp4" } })));
    await expect(studioTaskStatus(video, "test", "wan-paid")).resolves.toMatchObject({ status: "succeeded", content: { video_url: "https://example.com/output.mp4" } });
  });
  it("submits the actual Atlas reference model and image references without remapping platforms", async () => {
    const atlas = { provider: "atlas-cloud", model: "alibaba/wan-3.0/reference-to-video", resolution: "720p" as const, baseUrl: "https://atlas.example.com/api/v1" };
    const options = await prepareStudioVideo(atlas, "test", [ { type: "text", text: "保持图像外观" }, { type: "image_url", image_url: { url: "https://example.com/image.png" } } ], "/tmp/version", 0, 9);
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: "atlas-paid" } })); vi.stubGlobal("fetch", fetcher);
    await expect(submitStudioVideo(atlas, "test", [], 9, options)).resolves.toBe("atlas-paid");
    expect(fetcher.mock.calls[0][0]).toBe("https://atlas.example.com/api/v1/model/generateVideo");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ model: atlas.model, refers: [{ type: "image", url: "https://example.com/image.png" }] });
  });
});

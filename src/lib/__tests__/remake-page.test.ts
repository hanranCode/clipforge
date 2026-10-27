import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RemakePage from "@/app/project/remake/page";

vi.mock("@/app/project/remake/_components/ops-editor", () => ({ OpsEditor: () => null }));
vi.mock("@/components/library-video-picker", () => ({ LibraryVideoPicker: () => null }));
vi.mock("@/app/project/remake/_components/use-transcribe", () => ({ useTranscribe: () => ({ state: { phase: "idle" }, transcribe: vi.fn(), cancel: vi.fn() }) }));
vi.mock("@/lib/model-usage", () => ({ modelForUsage: () => "bytedance/seedance-2.5/reference-to-video", providerForUsage: () => "atlas-cloud" }));
const ttsState = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("@/lib/stores/settings-store", () => {
  const settings = { providers: { "atlas-cloud": { enabled: true, apiKey: "test" }, volcengine: { enabled: true, apiKey: "ark-key", baseUrl: "https://ark.example.com/api/v3" }, alibaba: { enabled: true, apiKey: "bailian-key", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1" } }, get tts() { return ttsState.config; }, objectStorage: { endpoint: "https://tos-s3-cn-beijing.volces.com", region: "cn-beijing", bucket: "test", accessKeyId: "test", secretAccessKey: "test" } };
  return { useSettingsStore: (selector?: (s: typeof settings) => unknown) => selector ? selector(settings) : settings };
});

const segments = [0, 1, 2].map((index) => ({ index, start: index * 8, end: (index + 1) * 8 }));
function fixture() {
  return { id: "test-project", name: "Test", draft: { version: 2, maxSeconds: 10, sceneCuts: false,
    source: { jobId: "test-job", path: "/source.mp4", label: "Reference", duration: 24, width: 720, height: 1280, frameRate: 30, hasAudio: true, sceneTimes: [] },
    images: [{ id: "model", url: "/api/files/portrait.png", label: "Model" }],
    ops: [{ id: "op", kind: "person", target: "", detail: "", imageId: "model" }],
    audioMode: "keep", clips: Object.fromEntries(segments.map((seg) => [seg.index, { index: seg.index, path: `/clip-${seg.index}.mp4`, audioPath: `/clip-${seg.index}.mp3` }])),
    runs: {},
  } };
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let container: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; body: Record<string, unknown> }>;
let draftOverrides: Record<string, unknown>;
beforeEach(() => {
  draftOverrides = {};
  ttsState.config = {};
  localStorage.clear(); window.history.replaceState({}, "", "/project/remake?id=test-project");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.startsWith("/api/remake/draft?")) return response({ ...fixture(), draft: { ...fixture().draft, ...draftOverrides } });
    if (url === "/api/remake/draft") return response({ id: "test-project" });
    if (url === "/api/remake/resources") return response({ resources: (body.references as Array<{ path: string; label: string }>).map((ref, i) => ({
      id: `resource-${i}`, md5: `md5-${i}`, path: ref.path, label: ref.label, url: `https://bucket.tos.example.com${ref.path}`,
      mediaType: /\.png$/.test(ref.path) ? "image" : /\.mp3$/.test(ref.path) ? "audio" : "video",
    })) });
    if (url === "/api/ai/video") return response({ taskId: "paid", videoUrls: ["https://example.com/result.mp4"] });
    if (url === "/api/remake/result") return response({ path: `/result-${body.index}.mp4` });
    if (url.startsWith("/api/remake/upscale/")) return response({ tasks: [], configured: true, storageConfigured: true, capability: { presets: [{ id: "base", available: true }] } });
    if (url === "/api/remake/finalize") return response({ id: "final", url: "/final.mp4" });
    throw new Error(`Unexpected request ${url}`);
  }));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});
async function render() { await act(async () => root.render(createElement(RemakePage))); }
function button(text: string) {
  const node = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(node, text).toBeDefined(); return node!;
}
async function click(text: string) { await act(async () => button(text).click()); }

describe("segment review page", () => {
  it("loads all MiniMax voices and uses the chosen voice for preview and dubbing", async () => {
    ttsState.config = { enabled: true, provider: "minimax", apiKey: "minimax-test", baseUrl: "https://api.minimax.io/v1", model: "speech-2.6-hd", voice: "configured" };
    draftOverrides = { audioMode: "dub", cues: [{ id: "cue", start: 0, end: 2, text: "测试配音" }] };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tts/voices") {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return response({ voices: [{ value: "system-1", label: "系统音色" }, { value: "cloned", label: "克隆音色" }, { value: "generated", label: "生成音色" }] });
      }
      if (url === "/api/remake/voice-preview" || url === "/api/remake/dub") {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return response({ dubPath: "/dub.mp3", segmentAudio: { 0: "/dub-0.mp3" } });
      }
      return originalFetch(url, init);
    }));
    await render();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="音色"]')!;
    expect([...select.options].map(o => o.value)).toEqual(expect.arrayContaining(["configured", "system-1", "cloned", "generated"]));
    await act(async () => { select.value = "cloned"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    await click("试听");
    play.mockRestore();
    expect(calls.find(c => c.url === "/api/remake/voice-preview")?.body).toMatchObject({ voice: { kind: "paid", config: { voice: "cloned" } } });
    await click("仅生成本段");
    expect(calls.find(c => c.url === "/api/remake/dub")?.body).toMatchObject({ voice: { kind: "paid", config: { provider: "minimax", voice: "cloned", apiKey: "minimax-test" } } });
  });

  it("shows a catalog failure and reloads the complete list on retry", async () => {
    ttsState.config = { enabled: true, provider: "minimax", apiKey: "minimax-test", model: "speech-2.6-hd", voice: "configured" };
    draftOverrides = { audioMode: "dub" };
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tts/voices") return ++attempts === 1
        ? response({ error: "unavailable" }, 502) : response({ voices: [{ value: "recovered", label: "已恢复音色" }] });
      return originalFetch(url, init);
    }));
    await render();
    expect(container.textContent).toContain("音色列表加载失败");
    expect(container.querySelector('option[value="female-shaonv"]')).not.toBeNull();
    await click("重新加载");
    expect(attempts).toBe(2);
    expect(container.querySelector('option[value="recovered"]')).not.toBeNull();
    expect(container.textContent).not.toContain("音色列表加载失败");
  });

  it("discards delayed voice catalogs after switching MiniMax accounts", async () => {
    ttsState.config = { enabled: true, provider: "minimax", apiKey: "old-key", model: "speech-2.6-hd", voice: "configured" };
    draftOverrides = { audioMode: "dub" };
    const originalFetch = globalThis.fetch;
    let resolveOld!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tts/voices") {
        if (JSON.parse(String(init?.body)).apiKey === "old-key") return new Promise<Response>(resolve => { resolveOld = resolve; });
        return response({ voices: [{ value: "new-account", label: "New account" }] });
      }
      return originalFetch(url, init);
    }));
    await render();
    ttsState.config = { ...ttsState.config, apiKey: "new-key" };
    await render();
    await act(async () => resolveOld(response({ voices: [{ value: "old-account", label: "Old account" }] })));
    expect(container.querySelector('option[value="new-account"]')).not.toBeNull();
    expect(container.querySelector('option[value="old-account"]')).toBeNull();
  });

  it("keeps the resolution explicitly saved in an existing draft", async () => {
    draftOverrides = { segmentSettings: { 0: { model: "bytedance/seedance-2.5/reference-to-video", resolution: "720p", prompt: "", generate_audio: true, useSourceAudio: true } } };
    await render();
    expect(JSON.parse(container.querySelector("pre")!.textContent!).resolution).toBe("720p");
  });

  it("defaults new segment settings to 480p", async () => {
    await render();
    const preview = JSON.parse(container.querySelector("pre")!.textContent!);
    expect(preview.resolution).toBe("480p");
  });

  it("previews Bailian's native media body and submits the selected workspace config", async () => {
    await render();
    const platform = [...container.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "alibaba"))!;
    await act(async () => { platform.value = "alibaba"; platform.dispatchEvent(new Event("change", { bubbles: true })); });
    const preview = JSON.parse(container.querySelector("pre")!.textContent!);
    expect(preview).toMatchObject({ model: "wan3.0-video", input: { prompt: expect.stringContaining("视频1"), media: expect.arrayContaining([
      { type: "reference_video", url: "/clip-0.mp4" },
    ]) }, parameters: { duration: -1, ratio: "adaptive", resolution: "480P", audio: true, watermark: false, prompt_extend: true } });
    expect(preview.input.prompt).not.toMatch(/@(Image|Video|Audio)/);
    expect(preview).not.toHaveProperty("refers");
    await click("仅生成本段");
    expect(calls.find((call) => call.url === "/api/ai/video")?.body).toMatchObject({ provider: "alibaba", model: "wan3.0-video",
      apiKey: "bailian-key", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
      options: { extra: preview.parameters } });
  });

  it("keeps Wan image numbering, remote URLs and resource IDs aligned until segment approval", async () => {
    draftOverrides = { images: [
      { id: "scene", url: "/api/files/scene.png", label: "Scene" },
      { id: "person", url: "/api/files/person.png", label: "Person" },
    ], ops: [{ id: "op", kind: "person", target: "", detail: "", imageId: "person" }] };
    await render();
    const platform = [...container.querySelectorAll("select")].find(s => [...s.options].some(o => o.value === "alibaba"))!;
    await act(async () => { platform.value = "alibaba"; platform.dispatchEvent(new Event("change", { bubbles: true })); });
    const preview = JSON.parse(container.querySelector("pre")!.textContent!);
    expect(preview.input.prompt).toContain("图2");
    expect(preview.input.media).toEqual([
      { type: "reference_image", url: "/api/files/scene.png" },
      { type: "reference_image", url: "/api/files/person.png" },
      { type: "reference_video", url: "/clip-0.mp4" },
      { type: "reference_audio", url: "/clip-0.mp3" },
    ]);
    await click("仅生成本段");
    const submitted = calls.filter(c => c.url === "/api/ai/video");
    expect(submitted).toHaveLength(1);
    expect(submitted[0].body).toMatchObject({ referenceImageUrls: ["https://bucket.tos.example.com/api/files/scene.png", "https://bucket.tos.example.com/api/files/person.png"],
      referenceVideoUrls: ["https://bucket.tos.example.com/clip-0.mp4"], referenceAudioUrls: ["https://bucket.tos.example.com/clip-0.mp3"],
      referenceResourceIds: { videos: ["resource-0"], images: ["resource-1", "resource-2"], audios: ["resource-3"] }, options: { extra: preview.parameters } });
    expect(button("第 2 段").disabled).toBe(true);
    await click("满意，确认本段并继续");
    expect(calls.filter(c => c.url === "/api/ai/video")).toHaveLength(1);
    await click("仅生成本段");
    expect(calls.filter(c => c.url === "/api/ai/video")[1].body.referenceVideoUrls).toEqual(["https://bucket.tos.example.com/clip-1.mp4"]);
  });

  it("recovers an existing Bailian task using its saved platform instead of the current Atlas setting", async () => {
    draftOverrides = { runs: { 0: { status: "failed", taskId: "wan-paid", taskModel: "wan3.0-video", taskProvider: "alibaba", recoverable: true } } };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/ai/video/task") {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return response({ status: "completed", videoUrls: ["https://example.com/wan-recovered.mp4"] });
      }
      return originalFetch(url, init);
    }));
    await render(); await click("恢复查询 / 保存本段");
    expect(calls.find((call) => call.url === "/api/ai/video/task")?.body).toMatchObject({ provider: "alibaba", model: "wan3.0-video",
      apiKey: "bailian-key", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1", taskId: "wan-paid" });
    expect(calls.filter((call) => call.url === "/api/ai/video")).toHaveLength(0);
  });

  function subtitleCheckbox() {
    return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("保留原视频字幕"))!;
  }

  it.each(["主播重新配音", "使用生成音频"])("unchecks and disables original subtitles when selecting %s", async (mode) => {
    await render();
    expect(subtitleCheckbox().checked).toBe(true);
    await click(mode);
    expect(subtitleCheckbox().checked).toBe(false);
    expect(subtitleCheckbox().disabled).toBe(true);
    expect(container.textContent).toContain("使用新音频时不能保留原视频字幕");
    await click("保留原声");
    expect(subtitleCheckbox().disabled).toBe(false);
    expect(subtitleCheckbox().checked).toBe(false);
    await act(async () => subtitleCheckbox().click());
    expect(subtitleCheckbox().checked).toBe(true);
  });

  it.each(["dub", "generated"])("corrects conflicting subtitles in a restored %s draft", async (audioMode) => {
    draftOverrides = { audioMode, keepSubtitles: true };
    await render();
    expect(subtitleCheckbox().checked).toBe(false);
    expect(subtitleCheckbox().disabled).toBe(true);
    expect(JSON.parse(container.querySelector("pre")!.textContent!).prompt).toContain("去掉画面中的字幕");
  });

  it("applies subtitle rules to a saved custom prompt in both preview and submission", async () => {
    draftOverrides = { audioMode: "generated", keepSubtitles: true, segmentSettings: {
      0: { model: "bytedance/seedance-2.5/reference-to-video", prompt: "编辑视频：换成蓝色外套。", resolution: "720p", generate_audio: true, useSourceAudio: true },
    } };
    await render();
    const preview = JSON.parse(container.querySelector("pre")!.textContent!);
    expect(preview.prompt).toContain("换成蓝色外套");
    expect(preview.prompt).toContain("去掉画面中的字幕");
    expect(preview.prompt).toContain("不要添加黑底");
    await click("仅生成本段");
    expect(calls.find((c) => c.url === "/api/ai/video")?.body.prompt).toBe(preview.prompt);
  });

  it("persists the task ID before polling and resumes it after a page reload without paying again", async () => {
    const originalFetch = globalThis.fetch;
    let persisted: Record<string, unknown> = fixture().draft;
    let submissions = 0;
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/remake/draft?")) return response({ id: "test-project", name: "Test", draft: persisted });
      if (url === "/api/remake/draft") {
        persisted = JSON.parse(String(init?.body)).draft;
        return response({ id: "test-project" });
      }
      if (url === "/api/ai/video") {
        submissions++;
        expect(JSON.parse(String(init?.body)).wait).toBe(false);
        return response({ taskId: "paid-before-poll", status: "submitted" });
      }
      if (url === "/api/ai/video/task") {
        expect(persisted.runs).toMatchObject({ 0: { taskId: "paid-before-poll", recoverable: true } });
        if (++polls === 1) throw new TypeError("network interrupted");
        return response({ status: "completed", videoUrls: ["https://example.com/recovered.mp4"] });
      }
      return originalFetch(url, init);
    }));
    await render(); await click("仅生成本段");
    expect(polls).toBe(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(); await click("恢复查询 / 保存本段");
    expect(polls).toBe(2);
    expect(submissions).toBe(1);
    expect(container.querySelector('video[src="/result-0.mp4"]')).not.toBeNull();
  });

  it.each(["alibaba/wan-3.0/reference-to-video", "alibaba/wan-3.0-prime/reference-to-video"])(
    "switches to %s and submits supported controls with a typed request preview", async (model) => {
      await render();
      const modelSelect = [...container.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === model))!;
      const formatSelect = [...container.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "mov"))!;
      await act(async () => { formatSelect.value = "mov"; formatSelect.dispatchEvent(new Event("change", { bubbles: true })); });
      await act(async () => { modelSelect.value = model; modelSelect.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(formatSelect.disabled).toBe(true);
      expect(formatSelect.value).toBe("mp4");
      expect([...modelSelect.options].map((o) => o.textContent)).toEqual([
        "bytedance/seedance-2.5/reference-to-video · $0.134/秒起",
        "bytedance/seedance-2.0/reference-to-video · $0.09/秒起",
        "alibaba/wan-3.0/reference-to-video · $0.04/秒起",
        "alibaba/wan-3.0-prime/reference-to-video · $0.061/秒起",
      ]);
      expect(container.querySelector(`a[href="https://www.atlascloud.ai/models/${model}"]`)).not.toBeNull();
      const preview = JSON.parse(container.querySelector("pre")!.textContent!);
      expect(preview).toMatchObject({ model, audio: true, refers: [
        { url: "/clip-0.mp4", type: "video" }, { url: "/api/files/portrait.png", type: "image" }, { url: "/clip-0.mp3", type: "audio" },
      ] });
      expect(preview).not.toHaveProperty("generate_audio");
      expect(preview).not.toHaveProperty("watermark");
      const audioCheckbox = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
        .find((input) => input.parentElement?.textContent?.includes("传入本段参考音频"))!;
      await act(async () => audioCheckbox.click());
      expect(JSON.parse(container.querySelector("pre")!.textContent!).refers.map((ref: { type: string }) => ref.type))
        .toEqual(["video", "image"]);
      await click("仅生成本段");
      expect(calls.find((c) => c.url === "/api/ai/video")?.body).toMatchObject({ model,
        options: { extra: { duration: -1, ratio: "adaptive", resolution: "480p", audio: true } },
      });
      expect(calls.find((c) => c.url === "/api/ai/video")?.body).not.toHaveProperty("referenceAudioUrls");
      expect(calls.find((c) => c.url === "/api/remake/result")?.body.outputFormat).toBe("mp4");
    },
  );

  it("switches platforms and submits the selected model with that platform's credentials", async () => {
    await render();
    const platformSelect = [...container.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "volcengine"))!;
    await act(async () => { platformSelect.value = "volcengine"; platformSelect.dispatchEvent(new Event("change", { bubbles: true })); });
    const preview = JSON.parse(container.querySelector("pre")!.textContent!);
    expect(preview).toMatchObject({ model: "doubao-seedance-2-5-260628", duration: -1, ratio: "adaptive", omni_reference_task_type: "edit",
      content: [expect.objectContaining({ type: "text" }),
        { type: "image_url", image_url: { url: "/api/files/portrait.png" }, role: "reference_image" },
        { type: "video_url", video_url: { url: "/clip-0.mp4" }, role: "reference_video" },
        { type: "audio_url", audio_url: { url: "/clip-0.mp3" }, role: "reference_audio" }],
    });
    expect(preview).not.toHaveProperty("reference_images");
    expect(preview).not.toHaveProperty("output_format");
    const resolutionSelect = [...container.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "480p"))!;
    expect([...resolutionSelect.options].map((o) => o.value)).toEqual(["480p", "720p", "1080p"]);
    await click("仅生成本段");
    expect(calls.find((c) => c.url === "/api/ai/video")?.body).toMatchObject({
      provider: "volcengine", model: preview.model, apiKey: "ark-key", baseUrl: "https://ark.example.com/api/v3",
      options: { extra: { duration: -1, ratio: "adaptive", omni_reference_task_type: "edit", resolution: "480p" } },
    });
    const saved = calls.filter((c) => c.url === "/api/remake/draft").at(-1)?.body.draft as { runs: Record<number, unknown> };
    expect(saved.runs[0]).toMatchObject({ taskProvider: "volcengine", taskModel: preview.model, taskId: "paid" });
  });

  it("recovers a paid Ark task on Ark after switching the segment to Atlas, without resubmitting", async () => {
    draftOverrides = { runs: { 0: { status: "failed", taskId: "ark-paid", taskModel: "doubao-seedance-2-0-260128", taskProvider: "volcengine", recoverable: true } } };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/ai/video/task") {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return response({ status: "completed", videoUrls: ["https://example.com/ark-recovered.mp4"] });
      }
      return originalFetch(url, init);
    }));
    await render(); await click("恢复查询 / 保存本段");
    expect(calls.find((c) => c.url === "/api/ai/video/task")?.body).toMatchObject({ provider: "volcengine", model: "doubao-seedance-2-0-260128", apiKey: "ark-key", taskId: "ark-paid" });
    expect(calls.filter((c) => c.url === "/api/ai/video")).toHaveLength(0);
  });

  it("does not poll or switch providers after Ark rejects a submission", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/ai/video" || url === "/api/ai/video/task") {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return response({ error: "火山引擎拒绝了参考图片：检测到真人，未创建任务", provider: "volcengine",
          code: "InputImageSensitiveContentDetected.PrivacyInformation", recoverable: false }, 400);
      }
      return originalFetch(url, init);
    }));
    await render();
    const platform = [...container.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "volcengine"))!;
    await act(async () => { platform.value = "volcengine"; platform.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("仅生成本段");
    expect(container.textContent).toContain("未创建任务");
    expect(calls.filter((call) => call.url === "/api/ai/video/task")).toHaveLength(0);
    expect(calls.filter((call) => call.url === "/api/ai/video")).toHaveLength(1);
    expect(container.textContent).not.toContain("恢复查询 / 保存本段");
    await click("仅生成本段");
    expect(calls.filter((call) => call.url === "/api/ai/video").map((call) => call.body.provider)).toEqual(["volcengine", "volcengine"]);
    const saved = calls.filter((call) => call.url === "/api/remake/draft").at(-1)?.body.draft as { runs: Record<number, unknown> };
    expect(saved.runs[0]).toMatchObject({ status: "failed", taskProvider: "volcengine", recoverable: false });
  });

  it("submits one segment per click, waits for approval, and never auto-assembles", async () => {
    await render();
    expect(container.textContent).not.toContain("编辑指令");
    expect(container.textContent).toContain("Prompt");
    expect(button("第 2 段").disabled).toBe(true);
    expect(button("拼接已确认片段").disabled).toBe(true);
    await click("仅生成本段");
    expect(calls.filter((c) => c.url === "/api/ai/video")).toHaveLength(1);
    expect(calls.find((c) => c.url === "/api/ai/video")?.body).toMatchObject({
      referenceVideoUrls: ["https://bucket.tos.example.com/clip-0.mp4"], referenceAudioUrls: ["https://bucket.tos.example.com/clip-0.mp3"],
      referenceResourceIds: { videos: ["resource-0"], images: ["resource-1"], audios: ["resource-2"] },
      options: { extra: { duration: -1, ratio: "adaptive", resolution: "480p", output_format: "mp4", draft: false } },
    });
    expect(button("第 2 段").disabled).toBe(true);
    await click("满意，确认本段并继续");
    expect(button("第 2 段").disabled).toBe(false);
    expect(calls.filter((c) => c.url === "/api/ai/video")).toHaveLength(1);
    await click("仅生成本段"); await click("满意，确认本段并继续");
    await click("仅生成本段"); await click("满意，确认本段并继续");
    expect(calls.filter((c) => c.url === "/api/ai/video")).toHaveLength(3);
    expect(calls.filter((c) => c.url === "/api/remake/finalize")).toHaveLength(0);
    await click("拼接已确认片段");
    expect(calls.filter((c) => c.url === "/api/remake/finalize")).toHaveLength(1);
  });

  it("refuses approval after parameters change and locks later generation again", async () => {
    await render(); await click("仅生成本段"); await click("满意，确认本段并继续"); await click("第 1 段");
    const select = [...container.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "1080p-esr"))!;
    await act(async () => { select.value = "1080p"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("满意，确认本段并继续").disabled).toBe(true);
    expect(button("第 2 段").disabled).toBe(true);
    await click("重新生成本段");
    expect(calls.filter((c) => c.url === "/api/ai/video")).toHaveLength(2);
    expect(button("满意，确认本段并继续").disabled).toBe(false);
  });

  it("recovers an existing paid task after a polling timeout instead of generating again", async () => {
    const originalFetch = globalThis.fetch;
    let submissions = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/ai/video") {
        submissions++;
        return response({ error: "Polling timed out", recoverable: true, taskId: "already-paid" }, 504);
      }
      if (url === "/api/ai/video/task") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ taskId: "already-paid", wait: true });
        return response({ status: "completed", videoUrls: ["https://example.com/recovered.mp4"] });
      }
      return originalFetch(url, init);
    }));
    await render(); await click("仅生成本段");
    expect(button("第 2 段").disabled).toBe(true);
    await click("恢复查询 / 保存本段");
    expect(submissions).toBe(1);
    expect(container.querySelector('video[src="/result-0.mp4"]')).not.toBeNull();
    await click("满意，确认本段并继续");
    expect(button("第 2 段").disabled).toBe(false);
  });
});

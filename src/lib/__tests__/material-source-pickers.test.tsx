import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryEntityPicker } from "@/components/library-entity-picker";
import { LibraryVideoPicker } from "@/components/library-video-picker";
import { AudioPanel } from "@/app/project/remake/_components/audio-panel";
import { useProductLibraryStore } from "@/lib/stores/product-library-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { useSettingsStore } from "@/lib/stores/settings-store";
const original = useSettingsStore.getState(), picked = vi.fn(), close = vi.fn(), fetcher = vi.fn();
let root: Root, container: HTMLDivElement;
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
async function click(text: string) { await act(async () => buttons().find(b => b.textContent?.trim() === text)!.click()); }
async function loaded(text: string) { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(document.body.textContent).toContain(text); }); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetcher); fetcher.mockReset(); picked.mockReset(); close.mockReset();
  useSettingsStore.setState({ locale: "zh" });
  useProductLibraryStore.setState({ products: [{ id: "product", name: "收纳盒", category: "home", description: "白色", images: ["/api/files/upload.png", "/api/files/product-generated/ai.png"], imageSources: { "/api/files/upload.png": "user_upload", "/api/files/product-generated/ai.png": "ai_generated" }, createdAt: new Date(), videoCount: 0 }] });
  useCharacterStore.setState({ characters: [{ id: "presenter", name: "主播", referenceImages: ["/api/files/characters/sheet-1.png"], sourcePhotos: ["/api/files/photo.png"], source: "user_upload", imageSources: { "/api/files/photo.png": "user_upload", "/api/files/characters/sheet-1.png": "ai_generated" } }] });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(original); useProductLibraryStore.setState({ products: [] }); useCharacterStore.setState({ characters: [] }); vi.unstubAllGlobals(); });

describe("source labels and filters in material selectors", () => {
  // Value: protects=generated presenters remain usable as remake references; fails_when=audio panel requires a character sheet; why_new=picker cases do not render the audio panel; seam=none
  it("shows a generated presenter's source photo and offers its reference-image action", async () => {
    const noop = () => {};
    await act(async () => root.render(<AudioPanel keepSubtitles={false} onKeepSubtitlesChange={noop}
      audioMode="dub" onAudioModeChange={noop} presenters={[{ id: "generated", name: "生成主播", referenceImages: [], sourcePhotos: ["/api/files/generated.png"], source: "ai_generated" }]}
      presenterId="generated" onPresenterChange={noop} onUsePresenterImage={picked} voiceId="" onVoiceChange={noop}
      paidVoice={null} paidVoiceProvider={null} paidVoicePrice={null} onPreviewVoice={noop} previewing={false}
      cues={[]} onCuesChange={noop} hasAudio={false} currentTime={0} transcribeState={{ phase: "idle" }} onTranscribe={noop}
      dubbing={false} dubReady={false} dubPath={null} onBuildDub={noop} />));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/files/generated.png");
    await click("把主播形象加为参考图"); expect(picked).toHaveBeenCalledTimes(1);
  });
  it("filters product images by their own source, composes with category filters, and returns provenance", async () => {
    await act(async () => root.render(<LibraryEntityPicker role="product" open onOpenChange={close} onPick={picked} />));
    expect(document.querySelectorAll('[role="dialog"] img')).toHaveLength(2);
    await click("AI 生成"); expect(document.querySelectorAll('[role="dialog"] img')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toContain("product-generated");
    await click("美妆护肤"); expect(document.querySelectorAll('[role="dialog"] img')).toHaveLength(0);
    await click("全部类目");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="收纳盒 · 图片 1"]')!.click());
    expect(picked).toHaveBeenCalledWith(expect.objectContaining({ source: "ai_generated", sourceId: "product", imageUrl: "/api/files/product-generated/ai.png" }));
    expect(close).toHaveBeenCalledWith(false);
  });
  it("distinguishes an uploaded portrait from its generated character sheet", async () => {
    await act(async () => root.render(<LibraryEntityPicker role="presenter" open onOpenChange={close} onPick={picked} />));
    await click("本地上传"); expect(document.querySelectorAll('[role="dialog"] img')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe("/api/files/photo.png");
    await click("AI 生成"); expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toContain("sheet-1");
  });
  it("requests source filtering on the full library and keeps the caller's media-type restriction", async () => {
    fetcher.mockImplementation(async (url: string) => Response.json({ items: url.includes("source=agent_remake") ? [{ id: "agent", title: "Agent 成片", url: "/api/files/agent.mp4", source: "agent_remake", mediaType: "video" }] : [{ id: "upload", title: "上传视频", url: "/api/files/upload.mp4", source: "user_upload", mediaType: "video" }], total: 1, hasMore: false }));
    await act(async () => root.render(<LibraryVideoPicker open mediaType="video" onOpenChange={close} onPick={picked} />)); await loaded("上传视频");
    await click("Agent 复刻"); await loaded("Agent 成片");
    expect(fetcher.mock.calls.at(-1)![0]).toContain("mediaType=video"); expect(fetcher.mock.calls.at(-1)![0]).toContain("source=agent_remake");
    expect(document.body.textContent).not.toContain("上传视频");
    await act(async () => buttons().find(b => b.textContent?.includes("Agent 成片"))!.click());
    expect(picked).toHaveBeenCalledWith(expect.objectContaining({ id: "agent", source: "agent_remake" }));
  });
  it("ignores an old load-more response after a source switch", async () => {
    let complete!: (response: Response) => void;
    fetcher.mockImplementation((url: string) => {
      if (url.includes("source=ai_generated")) return Promise.resolve(Response.json({ items: [{ id: "ai", title: "AI 图片", url: "/api/files/ai.png", source: "ai_generated" }], total: 1, hasMore: false }));
      if (url.includes("offset=1")) return new Promise(resolve => { complete = resolve; });
      return Promise.resolve(Response.json({ items: [{ id: "upload", title: "旧上传图片", url: "/api/files/upload.png", source: "user_upload" }], total: 2, hasMore: true }));
    });
    await act(async () => root.render(<LibraryVideoPicker open mediaType="image" onOpenChange={close} onPick={picked} />)); await loaded("旧上传图片"); await click("加载更多");
    await click("AI 生成"); await loaded("AI 图片");
    await act(async () => complete(Response.json({ items: [{ id: "late", title: "不应混入的上传图", url: "/api/files/late.png" }], total: 2, hasMore: false })));
    expect(document.body.textContent).not.toContain("不应混入"); expect(document.body.textContent).not.toContain("旧上传图片");
  });
  it("does not offer stale cards when the new source request fails", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ items: [{ id: "old", title: "旧视频", url: "/api/files/old.mp4" }], total: 1, hasMore: false })).mockRejectedValueOnce(new Error("network unavailable"));
    await act(async () => root.render(<LibraryVideoPicker open onOpenChange={close} onPick={picked} />)); await loaded("旧视频"); await click("Agent 复刻"); await loaded("素材库加载失败");
    expect(document.body.textContent).not.toContain("旧视频"); expect(picked).not.toHaveBeenCalled();
  });
});

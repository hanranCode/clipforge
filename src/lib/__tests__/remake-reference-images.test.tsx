import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceImages } from "@/app/project/remake/_components/reference-images";
import { useCharacterStore } from "@/lib/stores/project-store";
import type { RemakeImage } from "@/lib/remake/plan";
import type { ReferenceResource } from "@/lib/reference-resource";

const state = vi.hoisted(() => ({ storage: { bucket: "test-bucket" } }));
vi.mock("@/lib/stores/settings-store", () => ({ useSettingsStore: (selector: (value: unknown) => unknown) => selector({ objectStorage: state.storage }) }));
vi.mock("@/components/library-video-picker", () => ({ LibraryVideoPicker: ({ open, onPick }: { open: boolean; onPick: (item: { url: string; label: string }) => void }) =>
  open ? createElement("button", { onClick: () => onPick({ url: "/api/files/library.png", label: "素材照片" }) }, "选择素材照片") : null }));

const resource: ReferenceResource = { id: "md5-image", md5: "a".repeat(32), mediaType: "image", label: "已存素材",
  path: "/api/files/_library/portrait.png", url: "https://bucket.tos.example.com/portrait.png?X-Amz-Signature=fresh",
  objectUrl: "https://bucket.tos.example.com/portrait.png", objectKey: "portrait.png", bucket: "test-bucket", endpoint: "https://tos.example.com", expiresAt: "2099-01-01T00:00:00Z" };
let root: Root;
let container: HTMLDivElement;
const changed = vi.fn<(images: RemakeImage[]) => void>();
const selected = () => changed.mock.lastCall?.[0] ?? [];
const busy = vi.fn();
function Harness() {
  const [images, setImages] = useState<RemakeImage[]>([]);
  return createElement(ReferenceImages, { images, onChange: (next: RemakeImage[]) => { changed(next); setImages(next); }, maxImages: 9, onBusy: busy });
}
function button(label: string) { return [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useCharacterStore.setState({ characters: [
    { id: "presenter", name: "测试主播", referenceImages: ["/api/files/characters/portrait.png"] },
    { id: "no-image", name: "无图主播", referenceImages: [] },
  ] });
  changed.mockReset(); busy.mockReset();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useCharacterStore.setState({ characters: [] }); vi.unstubAllGlobals(); });

describe("remake reference selection", () => {
  it("uploads a presenter's primary photo before adding it and retains only the cloud URL as input", async () => {
    let complete!: (response: Response) => void;
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => new Promise<Response>((resolve) => { complete = resolve; }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(createElement(Harness)));
    await click("主播库");
    expect(button("暂无人物图无图主播").disabled).toBe(true);
    await click("测试主播");
    expect(selected()).toEqual([]);
    expect(busy).toHaveBeenLastCalledWith(true);
    expect(button("测试主播").disabled).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ objectStorage: state.storage,
      references: [{ path: "/api/files/characters/portrait.png", label: "测试主播" }] });
    await act(async () => complete(new Response(JSON.stringify({ resources: [resource] }))));
    expect(selected()).toMatchObject([{ url: resource.url, thumbUrl: resource.path, label: "测试主播", resource }]);
    expect(container.textContent).toContain("@Image1");
    expect(busy).toHaveBeenLastCalledWith(false);
  });

  it("keeps failed uploads unselected, supports retry and deduplicates the same content", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "对象存储上传失败" }), { status: 400 }))
      .mockImplementation(async () => new Response(JSON.stringify({ resources: [resource] })));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(createElement(Harness)));
    await click("主播库"); await click("测试主播");
    expect(selected()).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("对象存储上传失败");
    await click("测试主播");
    await click("主播库"); await click("测试主播");
    expect(selected()).toHaveLength(1);
    expect(selected()[0].url).toBe(resource.url);
  });

  it("also normalizes asset-library selections and local file uploads to cloud URLs", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ resources: [resource] })));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(createElement(Harness)));
    await click("素材库"); await click("选择素材照片");
    expect(selected()[0].url).toBe(resource.url);
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["image"], "upload.png", { type: "image/png" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(fetch.mock.calls.at(-1)?.[1]?.body).toBeInstanceOf(FormData);
    expect(selected()).toHaveLength(1);
    expect(selected()[0].url).toBe(resource.url);
  });
});

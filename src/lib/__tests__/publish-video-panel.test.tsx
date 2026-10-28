import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublishVideo } from "@/lib/publish-video";
import { PublishVideoButton } from "@/components/publish-video-button";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { usePlatformExportStore } from "@/lib/stores/platform-export-store";
let root: Root, container: HTMLDivElement;
const fetchMock = vi.fn();
const original = { id: "agent-v1", url: "/original.mp4", label: "V1", kind: "original", width: 480, height: 854 } satisfies PublishVideo;
const upscale = { id: "agent-upscale-sr", url: "/upscale.mp4", label: "V1", kind: "upscale", originalId: original.id, width: 1080, height: 1920 } satisfies PublishVideo;
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
  useSettingsStore.setState({ locale: "en" }); usePlatformExportStore.getState().setSelected(["douyin"]);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function click(label: string) { const button = Array.from(document.querySelectorAll("button")).find(b => b.textContent === label); expect(button, label).toBeDefined(); await act(async () => button!.click()); }
async function open() { await act(async () => root.render(createElement(PublishVideoButton, { projectId: "project", video: original }))); await click("Publish"); }
it("opens on upscale, labels both resolutions, and comparison preview preserves the export source", async () => {
  fetchMock.mockImplementation(async (url: string) => url.includes("publish-videos") ? reply({ videos: [upscale, original], preferredId: upscale.id }) : reply({ url: "/export.mp4" }));
  await open();
  const dialog = document.querySelector('[role="dialog"]')!;
  const select = dialog.querySelector("select")!;
  expect(select.value).toBe(upscale.id); expect(select.textContent).toContain("1080 × 1920"); expect(select.textContent).toContain("480 × 854");
  expect(dialog.querySelector("video")?.getAttribute("src")).toBe(upscale.url);
  await click("Preview original");
  expect(dialog.querySelector("video")?.getAttribute("src")).toBe(original.url);
  expect(select.value).toBe(upscale.id); expect(dialog.textContent).toContain("Exporting: Upscaled · 1080 × 1920");
  await click("Export Douyin version");
  expect(JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).endsWith("export-platform"))![1].body).compositionId).toBe(upscale.id);
  await click("Back to export video"); expect(dialog.querySelector("video")?.getAttribute("src")).toBe(upscale.url);
  await act(async () => { select.value = original.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(dialog.querySelector("video")?.getAttribute("src")).toBe(original.url);
  expect(dialog.textContent).toContain("Exporting: Original (before upscale) · 480 × 854");
  expect(dialog.textContent).not.toContain("Download Douyin version");
});
it("uses original when there is no completed upscale", async () => {
  fetchMock.mockResolvedValue(reply({ videos: [original], preferredId: original.id })); await open();
  expect(document.querySelector<HTMLSelectElement>('[role="dialog"] select')?.value).toBe(original.id);
  expect(document.querySelector('[role="dialog"] video')?.getAttribute("src")).toBe(original.url);
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Preview original");
});

it("disables exporting when versions cannot be loaded and allows retry", async () => {
  fetchMock.mockResolvedValueOnce(reply({ error: "Versions unavailable" }, 500)); await open();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Versions unavailable");
  expect(document.querySelector('[role="dialog"] video')).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Export Douyin version");
  fetchMock.mockResolvedValueOnce(reply({ videos: [upscale, original], preferredId: upscale.id }));
  await click("Retry export");
  expect(document.querySelector<HTMLSelectElement>('[role="dialog"] select')?.value).toBe(upscale.id);
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkVersion } from "@/lib/agent-studio/types";
const state = vi.hoisted(() => ({ storage: { endpoint: "https://tos-s3-cn-beijing.volces.com", region: "cn-beijing", bucket: "test-bucket", accessKeyId: "a", secretAccessKey: "s" } }));
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/stores/settings-store", () => ({ useSettingsStore: (select: (s: unknown) => unknown) => select({ objectStorage: state.storage }) }));
vi.mock("@/components/agent-studio/shared", () => ({ studioApi: vi.fn().mockResolvedValue({}) }));
import { SuperResolutionPanel } from "@/components/agent-studio/super-resolution-panel";
import { studioApi } from "@/components/agent-studio/shared";
let el: HTMLDivElement, root: Root;
const version = (status?: string) => ({ id: "version", status: "completed", outputUrl: "/original", ...(status ? { superResolution: { requestId: "r", workflowId: "media-sr-r", status, outputUrl: "/upscaled" } } : {}) }) as WorkVersion;
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); el = document.createElement("div"); document.body.append(el); root = createRoot(el); });
afterEach(async () => { await act(async () => root.unmount()); el.remove(); vi.useRealTimers(); });
it("starts an upscale for the selected completed version with configured storage", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<SuperResolutionPanel workId="work" version={version()} configured storageConfigured onChange={refresh} />));
  await act(async () => (el.querySelector("button") as HTMLButtonElement).click());
  expect(studioApi).not.toHaveBeenCalled();
  await act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(studioApi).toHaveBeenCalledWith("works/work", { parameters: { capabilityId: "media.super_resolution.v1", target: "1080p", videoPreset: "base" }, action: "upscale", operation: "start", versionId: "version" }); expect(refresh).toHaveBeenCalled(); expect(JSON.stringify(vi.mocked(studioApi).mock.calls)).not.toMatch(/objectStorage|accessKeyId|secretAccessKey/);
});
it("polls a persisted unknown task despite parent refreshes and never starts another workflow", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  for (let i = 0; i < 4; i++) {
    await act(async () => root.render(<SuperResolutionPanel workId="work" version={version("unknown")} configured storageConfigured onChange={refresh} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  }
  expect(studioApi).toHaveBeenCalledTimes(1); expect(vi.mocked(studioApi).mock.calls[0][1]).toMatchObject({ operation: "status" });
});
it("offers output URL refresh without automatic retries while waiting for a new URL", async () => {
  await act(async () => root.render(<SuperResolutionPanel workId="work" version={version("waiting_for_output_url")} configured storageConfigured onChange={async () => {}} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(studioApi).not.toHaveBeenCalled();
  const button = [...el.querySelectorAll("button")].find(b => b.textContent === "upscaleRefresh")!;
  await act(async () => button.click()); expect(vi.mocked(studioApi).mock.calls[0][1]).toMatchObject({ operation: "refresh" });
});
// Value: protects=Agent upscale links initiate a file download; fails_when=download attribute is omitted; why_new=existing test checked only the href; seam=none
it("provides separate local preview/download links once completed", async () => {
  const preview = vi.fn();
  await act(async () => root.render(<SuperResolutionPanel workId="work" version={version("completed")} configured storageConfigured onChange={async () => {}} onPreview={preview} />));
  expect([...el.querySelectorAll("a")].map(a => a.getAttribute("href"))).toEqual(["/upscaled?download=1"]);
  expect(el.querySelector("a")!.hasAttribute("download")).toBe(true);
  const button = [...el.querySelectorAll("button")].find(b => b.textContent === "upscalePreview")!;
  await act(async () => button.click()); expect(preview).toHaveBeenCalledWith("/upscaled");
  expect(el.textContent).toContain("upscaleAgain");
});
it("disables start when the node credentials are not configured", async () => {
  await act(async () => root.render(<SuperResolutionPanel workId="work" version={version()} configured={false} onChange={async () => {}} />));
  expect(el.querySelector("button")?.disabled).toBe(true); expect(el.textContent).toContain("upscaleSetup");
});

it("submits an explicit rerun with custom seed and keeps the original/result lineage visible", async () => {
  await act(async () => root.render(<SuperResolutionPanel workId="work" version={version("completed")} configured storageConfigured onChange={async () => {}} />));
  const button = [...el.querySelectorAll("button")].find(b => b.textContent?.includes("upscaleAgain"))!;
  await act(async () => button.click());
  expect(el.textContent).toContain("upscaleSource");
  const input = el.querySelector('input[type="number"]') as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"42"); input.dispatchEvent(new Event("input",{bubbles:true})); });
  await act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); });
  expect(vi.mocked(studioApi).mock.calls[0][1]).toMatchObject({ operation:"restart", parameters:{seed:42,videoPreset:"base"} });
});
it("shows schema-supported turbo as unavailable unless the deployment enables it", async () => {
  await act(async () => root.render(<SuperResolutionPanel workId="work" version={version()} configured storageConfigured onChange={async () => {}} />));
  await act(async () => (el.querySelector("button") as HTMLButtonElement).click());
  expect(el.querySelector<HTMLOptionElement>('option[value="turbo"]')?.disabled).toBe(true);
});

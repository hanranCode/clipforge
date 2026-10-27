import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemakeSuperResolution } from "@/app/project/remake/_components/super-resolution";
import type { SuperResolutionTask } from "@/lib/agent-studio/types";
let el: HTMLDivElement, root: Root, tasks: SuperResolutionTask[], operations: Array<Record<string, unknown>>;
let configured: boolean;
const response = (data: unknown) => new Response(JSON.stringify(data));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers(); tasks = []; operations = []; configured = true;
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe("/api/remake/upscale/final-asset");
    if (init?.method === "POST") {
      const payload = JSON.parse(String(init.body)); operations.push(payload);
      if (payload.operation === "start") tasks.push({ requestId: "request-1", status: "processing" } as SuperResolutionTask);
      if (payload.operation === "status") tasks[0] = { ...tasks[0], status: "completed", outputUrl: "/api/files/_library/upscaled.mp4" };
    }
    return response({ configured, storageConfigured: true, tasks: structuredClone(tasks), capability: { presets: [{ id: "base", available: true }] } });
  }));
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const refresh = () => act(async () => root.render(<RemakeSuperResolution assetId="final-asset" onPreview={vi.fn()} />));
async function click(text: string) {
  const button = [...el.querySelectorAll("button")].find(b => b.textContent?.includes(text)); expect(button).toBeDefined();
  await act(async () => button!.click());
}
// Value: protects=remake download stays on the result page; fails_when=download attribute is omitted; why_new=browser replay showed inline navigation; seam=none
it("starts only after choosing parameters, polls that same task, and keeps separate original and 1080p preview links", async () => {
  const preview = vi.fn();
  await act(async () => root.render(<RemakeSuperResolution assetId="final-asset" onPreview={preview} />));
  await click("超分"); expect(operations).toHaveLength(0);
  await act(async () => el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(operations).toEqual([{ operation: "start", parameters: { capabilityId: "media.super_resolution.v1", target: "1080p", videoPreset: "base" } }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(operations[1]).toEqual({ operation: "status", requestId: "request-1" });
  expect(operations.filter(x => x.operation === "start")).toHaveLength(1);
  await click("预览"); expect(preview).toHaveBeenLastCalledWith("/api/files/_library/upscaled.mp4");
  await click("查看"); expect(preview).toHaveBeenLastCalledWith(null);
  const download = el.querySelector<HTMLAnchorElement>('a[href="/api/files/_library/upscaled.mp4?download=1"]')!;
  expect(download).not.toBeNull();
  expect(download.hasAttribute("download")).toBe(true);
  expect(JSON.stringify(operations)).not.toMatch(/objectStorage|secretAccessKey|accessKeyId/);
});
it("restores a pending task after a page reload without starting it again", async () => {
  tasks = [{ requestId: "existing", status: "unknown" } as SuperResolutionTask];
  await refresh();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(operations).toEqual([{ operation: "status", requestId: "existing" }]);
});
it("shows a disabled start and setup guidance if the service is unconfigured", async () => {
  configured = false; await refresh();
  expect(el.textContent).toContain("超分服务尚未配置");
  expect(el.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  expect(operations).toHaveLength(0);
});

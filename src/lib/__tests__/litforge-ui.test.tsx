import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioVideoSettings, defaultStudioVideo } from "@/components/agent-studio/video-settings";
import { LitforgeSettings } from "@/components/settings/litforge-settings";
import { SegmentParams } from "@/app/project/remake/_components/segment-params";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { LITFORGE_MODELS } from "@/lib/litforge/catalog";
import { defaultSegmentSettings } from "@/lib/remake/workflow";
import { parseAgentPlan } from "@/lib/agent-studio/types";
import type { StudioResolution, StudioVideoChoice } from "@/lib/agent-studio/video-models";
let root: Root, container: HTMLDivElement;
const initial = useSettingsStore.getState();
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); useSettingsStore.setState({ locale: "zh", providers: { litforge: { enabled: false, apiKey: "" } } }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(initial); vi.unstubAllGlobals(); });
it("registers the custom provider without asking the browser to store Caller keys", async () => {
  await act(async () => root.render(createElement(LitforgeSettings)));
  expect(container.textContent).toContain("LitForge"); expect(container.querySelector('input[type="password"]')).toBeNull();
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(useSettingsStore.getState().providers.litforge).toMatchObject({ enabled: true, apiKey: "" });
});
it("switches Agent mode to VACE and a supported tier, keeping the reference model default independent of remake", async () => {
  function Harness() {
    const [video, setVideo] = useState<StudioVideoChoice>({ provider: "volcengine", model: "doubao-seedance-2-0-mini-260615" });
    const [resolution, setResolution] = useState<StudioResolution>("720p");
    return createElement(StudioVideoSettings, { value: video, resolution, onChange: (v, r) => { setVideo(v); setResolution(r); } });
  }
  await act(async () => root.render(createElement(Harness)));
  const selects = container.querySelectorAll("select");
  await act(async () => { selects[0].value = "litforge"; selects[0].dispatchEvent(new Event("change", { bubbles: true })); });
  expect(selects[1].value).toBe(LITFORGE_MODELS.reference); expect(selects[2].value).toBe("480p");
  expect(container.textContent).toContain("口型同步");
  const settings = useSettingsStore.getState();
  expect(defaultStudioVideo({ ...settings, usageModels: { referenceVideo: { provider: "litforge", model: LITFORGE_MODELS.reference } } })).toMatchObject({ provider: "litforge", model: LITFORGE_MODELS.reference });
});
it("exposes the replacement model in remake and refuses a long VACE plan instead of silently changing the model", async () => {
  const value = defaultSegmentSettings(LITFORGE_MODELS.replace, "litforge");
  await act(async () => root.render(createElement(SegmentParams, { value, onChange: vi.fn(), prompt: "Replace person", images: ["https://input.example/portrait.jpg"], enabledProviders: ["litforge"] })));
  expect(container.textContent).toContain(LITFORGE_MODELS.replace); expect(container.textContent).toContain("仅单人源视频");
  const plan = { summary: "Plan", preserve: [], change: [], notes: [], productCrop: null, segments: [{ duration: 9, script: "介绍", prompt: "Scene" }] };
  expect(() => parseAgentPlan(plan, 9, "litforge")).toThrow("1–5");
  const valid = { ...plan, segments: [{ ...plan.segments[0], duration: 4 }, { ...plan.segments[0], duration: 5 }] };
  expect(parseAgentPlan(valid, 9, "litforge").segments.map(s => s.duration)).toEqual([4, 5]);
});

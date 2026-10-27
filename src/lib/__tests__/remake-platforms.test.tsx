import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageModelSelects, type ModelOption } from "@/components/settings/media-model-settings";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { ARK_REMAKE_MODELS, DEFAULT_REMAKE_MODEL, REMAKE_MODELS } from "@/lib/remake/model";

vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));

const options: ModelOption[] = [
  { provider: "atlas-cloud", id: DEFAULT_REMAKE_MODEL, name: "Atlas Seedance 2.5" },
  { provider: "atlas-cloud", id: REMAKE_MODELS[2], name: "Atlas Wan 3.0" },
  { provider: "alibaba", id: "wan3.0-video", name: "Bailian Wan 3.0" },
  { provider: "alibaba", id: "wan3.0-video-prime", name: "Bailian Wan 3.0 Prime" },
  { provider: "volcengine", id: ARK_REMAKE_MODELS[0], name: "Ark Seedance 2.5" },
  { provider: "volcengine", id: ARK_REMAKE_MODELS[1], name: "Ark Seedance 2.0" },
  { provider: "volcengine", id: ARK_REMAKE_MODELS[2], name: "Ark Seedance 2.0 Mini" },
  { provider: "volcengine", id: "doubao-seedance-1-5-pro-251215", name: "Unsupported Ark video" },
  { provider: "replicate", id: DEFAULT_REMAKE_MODEL, name: "Unsupported platform duplicate" },
];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useSettingsStore.setState({
    defaultVideoModel: DEFAULT_REMAKE_MODEL,
    defaultVideoProvider: "atlas-cloud",
    usageModels: {},
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(available = options) {
  await act(async () => root.render(createElement(UsageModelSelects, { mediaType: "video", options: available })));
}

function remakeRow() {
  const label = [...container.querySelectorAll("label")].find((node) => node.textContent === "usage_videoRemake");
  expect(label).toBeDefined();
  return label!.parentElement!;
}

function triggers() {
  return [...remakeRow().querySelectorAll<HTMLButtonElement>('[data-slot="select-trigger"]')];
}

async function open(index: number) {
  await act(async () => triggers()[index].click());
}

function menuOptions() {
  return [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-content"][data-open] [role="option"]')];
}

async function choose(label: string) {
  const option = menuOptions().find((node) => node.textContent?.includes(label));
  expect(option, label).toBeDefined();
  await act(async () => option!.focus());
  await act(async () => option!.click());
}

describe("remake platform settings interaction", () => {
  it("filters the model menu by the chosen platform and persists the exact provider/model pair", async () => {
    await render();
    await open(0);
    expect(menuOptions().map((node) => node.textContent)).toEqual(["Atlas Cloud", "providerVolcengineName", "providerAlibabaName"]);
    await choose("providerVolcengineName");
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual({ provider: "volcengine", model: ARK_REMAKE_MODELS[0] });
    await open(1);
    expect(menuOptions()).toHaveLength(3);
    expect(menuOptions().map((node) => node.textContent).join(" ")).toContain("Ark Seedance 2.0");
    expect(menuOptions().map((node) => node.textContent).join(" ")).toContain("Ark Seedance 2.0 Mini");
    expect(menuOptions().map((node) => node.textContent).join(" ")).not.toMatch(/Atlas|Unsupported/);
    await choose("Ark Seedance 2.0 Mini");
    const chosen = { provider: "volcengine", model: ARK_REMAKE_MODELS[2] };
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual(chosen);
    const persisted = localStorage.getItem("daihuo-jianshou-settings")!;
    const saved = JSON.parse(persisted);
    expect(saved.state.usageModels.videoRemake).toEqual(chosen);
    await act(async () => root.unmount());
    useSettingsStore.setState({ usageModels: {} });
    localStorage.setItem("daihuo-jianshou-settings", persisted);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual(chosen);
    root = createRoot(container);
    await render();
    expect(triggers()[0].textContent).toContain("providerVolcengineName");
    expect(triggers()[1].textContent).toContain("Ark Seedance 2.0 Mini");
    await open(0);
    await choose("Atlas Cloud");
    await open(1);
    expect(menuOptions()).toHaveLength(2);
    expect(menuOptions().map((node) => node.textContent).join(" ")).not.toMatch(/Ark|Unsupported/);
    await choose("Atlas Wan 3.0");
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual({ provider: "atlas-cloud", model: REMAKE_MODELS[2] });
  });

  it("preserves a pinned Ark model when that platform disappears and requires an explicit switch", async () => {
    const chosen = { provider: "volcengine", model: ARK_REMAKE_MODELS[2] };
    useSettingsStore.getState().setUsageModel("videoRemake", chosen);
    await render(options.filter((option) => option.provider !== "volcengine"));
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual(chosen);
    expect(triggers()[0].textContent).toContain("providerVolcengineName");
    expect(triggers()[1].disabled).toBe(true);
    expect(remakeRow().textContent).toContain("remakeEnableProvider");
    await open(0);
    const unavailable = menuOptions().find((node) => node.textContent === "providerVolcengineName");
    expect(unavailable?.getAttribute("aria-disabled")).toBe("true");
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual(chosen);
    await choose("Atlas Cloud");
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual({ provider: "atlas-cloud", model: DEFAULT_REMAKE_MODEL });
    expect(triggers()[1].disabled).toBe(false);
    expect(remakeRow().textContent).not.toContain("remakeEnableProvider");
  });

  it("keeps a legacy model-only Ark choice on Ark instead of billing the Atlas default", async () => {
    useSettingsStore.setState({ usageModels: { videoRemake: ARK_REMAKE_MODELS[1] } });
    await render();
    expect(triggers()[0].textContent).toContain("providerVolcengineName");
    expect(triggers()[1].textContent).toContain("Ark Seedance 2.0");
    await open(1);
    expect(menuOptions().map((node) => node.textContent).join(" ")).not.toContain("Atlas");
  });

  it("selects and restores a Bailian edit model with its own provider", async () => {
    await render();
    await open(0); await choose("providerAlibabaName");
    await open(1);
    expect(menuOptions()).toHaveLength(2);
    await choose("Bailian Wan 3.0 Prime");
    const chosen = { provider: "alibaba", model: "wan3.0-video-prime" };
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual(chosen);
    const persisted = localStorage.getItem("daihuo-jianshou-settings")!;
    useSettingsStore.setState({ usageModels: {} });
    localStorage.setItem("daihuo-jianshou-settings", persisted);
    await act(async () => { await useSettingsStore.persist.rehydrate(); });
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual(chosen);
    await render(options.filter((option) => option.provider !== "alibaba"));
    expect(triggers()[0].textContent).toContain("providerAlibabaName");
    expect(triggers()[1].disabled).toBe(true);
    expect(useSettingsStore.getState().usageModels.videoRemake).toEqual(chosen);
  });
});

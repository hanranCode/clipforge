import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceLibraryEditor, SegmentReferenceEditor } from "@/components/agent-studio/reference-materials";
import type { AgentReference, ReferenceInput, SegmentReferences } from "@/lib/agent-studio/reference-types";
import type { AgentPlan, AgentWork } from "@/lib/agent-studio/types";
import { useProductLibraryStore } from "@/lib/stores/product-library-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { useSettingsStore } from "@/lib/stores/settings-store";
import AgentWorkDetail from "@/app/agent-studio/[id]/work-detail";
import AgentStudioPage from "@/app/agent-studio/page";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/agent-studio/product-crop-editor", () => ({ ProductCropEditor: () => null }));
vi.mock("@/components/agent-studio/super-resolution-panel", () => ({ SuperResolutionPanel: () => null }));
const originalSettings = useSettingsStore.getState();
let root: Root, container: HTMLDivElement;
const fetcher = vi.fn();
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
async function click(text: string) { const button = buttons().find(b => b.textContent?.trim() === text); expect(button).toBeDefined(); await act(async () => button!.click()); }
async function select(label: string, value: string) {
  await act(async () => { const input = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); });
}
const items: AgentReference[] = [
  { id: "p1", role: "product", sourceId: "product", name: "收纳盒", description: "白色", facts: { price: "¥29" }, imageUrl: "/api/files/snapshot/product.png", sha256: "a".repeat(64), mimeType: "image/png", bytes: 10 },
  { id: "p2", role: "product", sourceId: "other", name: "抽纸", description: "三层", imageUrl: "/api/files/snapshot/tissue.png", sha256: "b".repeat(64), mimeType: "image/png", bytes: 10 },
  { id: "host", role: "presenter", sourceId: "presenter", name: "虚拟主播", description: "蓝色衣服", imageUrl: "/api/files/snapshot/presenter.png", sha256: "c".repeat(64), mimeType: "image/png", bytes: 10 },
  { id: "room", role: "scene", sourceId: "scene", name: "浴室", description: "明亮", imageUrl: "/api/files/snapshot/scene.png", sha256: "d".repeat(64), mimeType: "image/png", bytes: 10 },
];
const plan: AgentPlan = { summary: "使用目标素材", preserve: ["节奏"], change: ["商品"], notes: [], productCrop: null, segments: [{ duration: 9, script: "展示收纳盒。", prompt: "Product demonstration" }] };
let work: AgentWork;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetcher); fetcher.mockReset();
  useSettingsStore.setState({ locale: "zh", providers: {} });
  useProductLibraryStore.setState({ products: [{ id: "product", name: "收纳盒", description: "白色收纳盒", price: "¥29", category: "home", images: ["/api/files/product.png", "/api/files/product-back.png"], videoCount: 0, createdAt: new Date() }] });
  useCharacterStore.setState({ characters: [{ id: "presenter", name: "虚拟主播", sourcePhotos: ["/api/files/presenter.png"], referenceImages: [], appearance: "蓝色衣服", isDefault: true }] });
  work = { id: "work", title: "Test", sourceAssetId: "source", sourceUrl: "/api/files/source.mp4", sourceName: "Source", duration: 9, brief: "use references", runtimeId: "runtime", status: "review", resolution: "480p", voice: "female", references: structuredClone(items), plan: structuredClone(plan), versions: [], posterUrl: null, projectId: null, error: null, createdAt: 1, updatedAt: 1 };
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/materials")) return Response.json({ items: url.includes("mediaType=video") ? [{ id: "source", url: "/api/files/source.mp4", mediaType: "video", title: "原片参考", createdAt: 1 }] : [{ id: "scene", url: "/api/files/scene.png", mediaType: "image", title: "浴室", createdAt: 1 }], total: 1, hasMore: false });
    if (url.endsWith("/runtimes")) return Response.json({ runtimes: [{ id: "runtime", enabled: true, connected: true, name: "Test", cli: "codex", model: "" }] });
    if (url.endsWith("/imports")) return Response.json({ productions: [] });
    if (url.endsWith("/works") && init?.method === "GET") return Response.json({ works: [] });
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      if (body.action === "edit-plan") work = { ...work, plan: body.plan, updatedAt: work.updatedAt + 1 };
      if (body.action === "plan") work = { ...work, status: "queued", plan: null, references: body.references, updatedAt: work.updatedAt + 1 };
      if (body.action === "video-settings") work = { ...work, video: body.video, resolution: body.resolution, updatedAt: work.updatedAt + 1 };
    }
    return Response.json({ work, events: [], cropUrl: null, videoKeyConfigured: true });
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(originalSettings); useProductLibraryStore.setState({ products: [] }); useCharacterStore.setState({ characters: [] }); vi.unstubAllGlobals(); });

describe("reference material selection and review", () => {
  it("inherits Bailian from video edit settings and lets the work switch provider, model and resolution", async () => {
    useSettingsStore.setState({ usageModels: { videoRemake: { provider: "alibaba", model: "wan3.0-video" } }, providers: {
      ...useSettingsStore.getState().providers,
      alibaba: { enabled: true, apiKey: "bailian-key", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1" },
      volcengine: { enabled: true, apiKey: "ark-key", baseUrl: "https://ark.example.com/api/v3" },
    } });
    await act(async () => root.render(createElement(AgentWorkDetail, { params: Promise.resolve({ id: "work" }) })));
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(document.body.textContent).toContain("视频生成设置"); });
    expect(document.querySelector('select[aria-label="视频供应商"]')).toHaveProperty("value", "alibaba");
    expect(document.querySelector('header')?.textContent).toContain("Wan 3.0");
    expect(document.querySelector('header')?.textContent).not.toContain("Seedance 2.0 Mini");
    await select("视频供应商", "volcengine");
    await select("视频生成模型", "doubao-seedance-2-0-mini-260615");
    expect([...document.querySelector<HTMLSelectElement>('select[aria-label="生成画质"]')!.options].map(o => o.value)).toEqual(["480p", "720p"]);
    await select("视频供应商", "alibaba"); await select("视频生成模型", "wan3.0-video-prime"); await select("生成画质", "1080p");
    await click("应用视频配置");
    expect(work).toMatchObject({ video: { provider: "alibaba", model: "wan3.0-video-prime", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1" }, resolution: "1080p" });
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click("确认方案并生成");
    const approval = fetcher.mock.calls.map(([, init]) => init?.body && JSON.parse(init.body as string)).find(body => body?.action === "approve");
    expect(approval).toMatchObject({ apiKey: "bailian-key", video: { provider: "alibaba", model: "wan3.0-video-prime" } });
  });
  it("keeps unsaved segment edits when the generation model changes", async () => {
    await act(async () => root.render(createElement(AgentWorkDetail, { params: Promise.resolve({ id: "work" }) })));
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(document.body.textContent).toContain("本段素材分配"); });
    await select("第 1 段 商品", "p2");
    expect(document.querySelector('select[aria-label="第 1 段 商品"]')).toHaveProperty("value", "p2");
    await select("视频供应商", "alibaba");
    expect(document.querySelector('select[aria-label="第 1 段 商品"]')).toHaveProperty("value", "p2");
    expect(buttons().find(b => b.textContent?.includes("确认方案并生成"))!.disabled).toBe(true);
  });
  it("includes selected product metadata in the new-remake request before any analysis runs", async () => {
    await act(async () => root.render(<AgentStudioPage />));
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(document.body.textContent).toContain("从素材库复刻"); });
    await click("从素材库复刻");
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(buttons().some(b => b.textContent?.includes("原片参考"))).toBe(true); });
    await act(async () => buttons().find(b => b.textContent?.includes("原片参考"))!.click());
    await click("从商品库选择"); await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="收纳盒 · 图片 1"]')!.click());
    await click("交给 Agent 拆解");
    const creation = fetcher.mock.calls.find(([url, init]) => url.endsWith("/works") && init?.method === "POST")!;
    expect(JSON.parse(creation[1].body as string)).toMatchObject({ assetId: "source", references: [{ role: "product", sourceId: "product", name: "收纳盒", imageUrl: "/api/files/product.png", facts: { price: "¥29" } }] });
  });
  it("selects a specific product image with facts, a presenter portrait and a material-library scene", async () => {
    let selected: ReferenceInput[] = [];
    function Form() { const [value, setValue] = useState<ReferenceInput[]>([]); return <ReferenceLibraryEditor value={value} onChange={next => { selected = next; setValue(next); }} />; }
    await act(async () => root.render(<Form />));
    await click("从商品库选择");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="收纳盒 · 图片 2"]')!.click());
    expect(selected[0]).toMatchObject({ role: "product", sourceId: "product", imageUrl: "/api/files/product-back.png", facts: { price: "¥29", category: "home" } });
    await click("从主播库选择"); await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="虚拟主播 · 图片 1"]')!.click());
    expect(selected[1]).toMatchObject({ role: "presenter", facts: { appearance: "蓝色衣服" } });
    await click("从素材库选择场地");
    await act(async () => { await vi.waitFor(() => expect(buttons().some(b => b.textContent?.includes("浴室"))).toBe(true)); });
    const scene = buttons().find(b => b.textContent?.includes("浴室"))!; await act(async () => scene.click());
    expect(selected[2]).toMatchObject({ role: "scene", sourceId: "scene", imageUrl: "/api/files/scene.png" });
    expect(new Set(selected.map(item => item.id)).size).toBe(3);
  });
  it("distinguishes inheritance, per-segment overrides and deliberate omission", async () => {
    let binding: SegmentReferences | undefined;
    function Form() { const [value, setValue] = useState<SegmentReferences>({}); return <SegmentReferenceEditor items={items} value={value} onChange={next => { binding = next; setValue(next); }} segmentLabel="第1段" />; }
    await act(async () => root.render(<Form />));
    await select("第1段 商品", "p2"); await select("第1段 虚拟主播", "none");
    expect(binding).toEqual({ product: "p2", presenter: null });
    await select("第1段 商品", "inherit"); expect(binding).toEqual({ presenter: null });
  });
  it("requires saving changed allocations before approval and sends the exact new plan", async () => {
    const params = Promise.resolve({ id: "work" }); await act(async () => root.render(createElement(AgentWorkDetail, { params })));
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(document.body.textContent).toContain("本段素材分配"); });
    await select("第 1 段 商品", "p2"); await select("第 1 段 虚拟主播", "none");
    expect(buttons().find(b => b.textContent?.includes("确认方案并生成"))!.disabled).toBe(true);
    await click("保存");
    const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1].body as string).plan.segments[0].references).toEqual({ product: "p2", presenter: null });
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    const approve = buttons().find(b => b.textContent?.includes("确认方案并生成"))!; expect(approve.disabled).toBe(false);
    await act(async () => approve.click());
    const approval = fetcher.mock.calls.map(([, init]) => init?.body && JSON.parse(init.body as string)).find(body => body?.action === "approve");
    expect(approval.referencesConfirmed).toBe(true); expect(JSON.parse(approval.plan).segments[0].references.product).toBe("p2");
  });
  it("invalidates approval after library selection changes and submits the changed materials for replanning", async () => {
    await act(async () => root.render(createElement(AgentWorkDetail, { params: Promise.resolve({ id: "work" }) })));
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(document.body.textContent).toContain("本段素材分配"); });
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="移除素材 收纳盒"]')!.click());
    expect(document.body.textContent).toContain("素材选择已变更"); expect(buttons().find(b => b.textContent?.includes("确认方案并生成"))!.disabled).toBe(true);
    await click("修改要求，重新规划");
    const replan = fetcher.mock.calls.map(([, init]) => init?.body && JSON.parse(init.body as string)).find(body => body?.action === "plan");
    expect(replan.references.map((item: ReferenceInput) => item.id)).toEqual(["p2", "host", "room"]);
  });
  it("switches historical plan and materials together and never borrows current selections for a legacy version", async () => {
    const old = { ...items[0], name: "旧版商品", imageUrl: "/api/files/version-one/product.png" }, newer = { ...items[0], name: "新版商品" };
    const version = (number: number, item?: AgentReference) => ({ id: `v${number}`, number, status: "cancelled" as const, plan: { ...plan, summary: `第${number}版方案` }, budgetCny: 5, estimatedCny: 2.4, costCny: null, receipts: [], outputUrl: null, posterUrl: null, sourceId: null, editorUrl: null, error: null, createdAt: 1, completedAt: null, ...(item && { referenceSnapshot: { capturedAt: 1, items: [item] } }) });
    work = { ...work, status: "completed", versions: [version(1, old), version(2, newer), version(3)] };
    await act(async () => root.render(createElement(AgentWorkDetail, { params: Promise.resolve({ id: "work" }) })));
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(document.body.textContent).toContain("第3版方案"); });
    expect(document.querySelector('main select[aria-label="第 1 段 商品"]')?.textContent).not.toContain("收纳盒");
    await select("版本记录", "v1");
    expect(document.body.textContent).toContain("第1版方案"); expect(document.querySelector('main img[alt="旧版商品"]')?.getAttribute("src")).toBe(old.imageUrl);
    expect(document.querySelector('main select[aria-label="第 1 段 商品"]')?.textContent).toContain("旧版商品");
    await select("版本记录", "v2");
    expect(document.body.textContent).toContain("第2版方案"); expect(document.querySelector('main img[alt="旧版商品"]')).toBeNull();
    expect(document.querySelector('main select[aria-label="第 1 段 商品"]')?.textContent).toContain("新版商品");
  });
});

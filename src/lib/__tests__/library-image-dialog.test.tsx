import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryImageDialog } from "@/components/library-image-dialog";
import { PresenterManager } from "@/components/presenter-manager";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { useProductLibraryStore } from "@/lib/stores/product-library-store";
import ProductsPage from "@/app/products/page";

const catalog = vi.hoisted(() => ({ models: [
  { id: "seedream", name: "Seedream official", provider: "volcengine", mediaType: "image", modes: ["text-to-image", "image-to-image"], extra: { price: { amount: 0.028, unit: "image", source: "provider" } } },
  { id: "seedream", name: "Seedream Atlas", provider: "atlas-cloud", mediaType: "image", modes: ["text-to-image"], extra: { price: { amount: 0.04, unit: "image", source: "provider" } } },
] }));
vi.mock("@/lib/hooks/use-model-catalog", () => ({ useModelCatalog: (providers: { name: string }[]) => ({ models: catalog.models.filter(m => providers.some(p => p.name === m.provider)), statuses: [], pending: [], loading: false, retry: vi.fn() }) }));
let root: Root, container: HTMLDivElement;
const fetchMock = vi.fn(), saved = vi.fn(), close = vi.fn();
const initialSettings = useSettingsStore.getState();
const image = { id: "image-id", url: "/api/files/characters/generated.png", title: "邻家姐姐", prompt: "窗边的普通女性", provider: "atlas-cloud", model: "seedream" };
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
const button = (text: string) => buttons().find(b => b.textContent?.trim() === text)!;
async function click(text: string) { await act(async () => button(text).click()); }
async function fill() {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>("[role=dialog] input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, image.title);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const textarea = document.querySelector<HTMLTextAreaElement>("[role=dialog] textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, image.prompt);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset(); saved.mockReset(); close.mockReset();
  useSettingsStore.setState({ locale: "zh", providers: { volcengine: { enabled: true, apiKey: "volc-secret" }, "atlas-cloud": { enabled: true, apiKey: "atlas-secret", baseUrl: "https://atlas.example" } }, customModels: [], defaultImageModel: "seedream", defaultImageProvider: "volcengine" });
  useCharacterStore.setState({ characters: [] });
  useProductLibraryStore.setState({ products: [] });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(initialSettings); useCharacterStore.setState({ characters: [] }); useProductLibraryStore.setState({ products: [] }); vi.unstubAllGlobals(); });

describe("library image generation dialog", () => {
  it("shows source, model and price, preserves an explicit cross-provider choice and prevents duplicate submissions", async () => {
    await act(async () => root.render(createElement(LibraryImageDialog, { open: true, onOpenChange: close, destination: "material", onGenerated: saved })));
    expect(document.body.textContent).toContain("Seedream official");
    expect(document.body.textContent).toContain("$0.028");
    expect(document.body.innerHTML).not.toContain("volc-secret");
    await act(async () => (document.querySelector('[role="combobox"]') as HTMLButtonElement).click());
    const atlas = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(o => o.textContent?.includes("Seedream Atlas"))!;
    await act(async () => atlas.focus());
    await act(async () => atlas.click());
    await fill();
    let complete!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const generate = button("生成并保存"); expect(generate.disabled).toBe(false);
    await act(async () => { generate.click(); generate.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request).toMatchObject({ provider: "atlas-cloud", model: "seedream", apiKey: "atlas-secret", baseUrl: "https://atlas.example", title: image.title, prompt: image.prompt });
    await act(async () => { complete(new Response(JSON.stringify(image), { status: 201 })); });
    expect(saved).toHaveBeenCalledExactlyOnceWith(image);
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe(image.url);
    await click("完成"); expect(close).toHaveBeenCalledWith(false);
  });
  it("explains missing configuration and keeps generation disabled", async () => {
    useSettingsStore.setState({ providers: {} });
    await act(async () => root.render(createElement(LibraryImageDialog, { open: true, onOpenChange: close, destination: "material", onGenerated: saved })));
    expect(document.body.textContent).toContain("暂无可用生图模型"); expect(button("生成并保存").disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("adds a generated presenter with a local source photo and no extra paid sheet generation", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(image), { status: 201 }));
    await act(async () => root.render(createElement(PresenterManager)));
    await click("AI 生成"); await fill(); await click("生成并保存");
    expect(useCharacterStore.getState().characters).toHaveLength(1);
    expect(useCharacterStore.getState().characters[0]).toMatchObject({ name: image.title, appearance: image.prompt, sourcePhotos: [image.url], referenceImages: [], isDefault: true, source: "ai_generated", imageSources: { [image.url]: "ai_generated" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("主播已添加");
  });
});

describe("product library image generation", () => {
  it("creates a product from text only after the user saves the reviewed form", async () => {
    const productImage = { ...image, url: "/api/files/product-generated/product.png" };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(productImage), { status: 201 }));
    await act(async () => root.render(createElement(ProductsPage)));
    await click("AI 生成商品图"); await fill(); await click("生成并加入商品");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ destination: "product", mode: "text-to-image" });
    expect(useProductLibraryStore.getState().products).toHaveLength(0);
    await click("完成");
    expect(document.querySelector<HTMLInputElement>("#productName")?.value).toBe(image.title);
    expect(document.querySelector('img[alt="商品图片"]')?.getAttribute("src")).toBe(productImage.url);
    await click("添加商品");
    expect(useProductLibraryStore.getState().products).toHaveLength(1);
    expect(useProductLibraryStore.getState().products[0]).toMatchObject({ name: image.title, images: [productImage.url], source: "ai_generated", imageSources: { [productImage.url]: "ai_generated" } });
    expect(localStorage.getItem("daihuo-jianshou-products")).toContain(productImage.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses an existing product image as reference, preserves the product, enforces the image limit and can choose the new cover", async () => {
    const images = [1, 2, 3, 4].map(i => `/api/files/products/p1/${i}.png`);
    useProductLibraryStore.setState({ products: [{ id: "p1", name: "收纳盒", category: "home", description: "白色磨砂收纳盒", images, price: "¥29", targetAudience: "学生", videoCount: 3, createdAt: new Date() }] });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...image, url: "/api/files/product-generated/new.png" }), { status: 201 }));
    await act(async () => root.render(createElement(ProductsPage)));
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="编辑商品"]')!.click());
    await click("AI 生成商品图");
    expect(document.querySelector<HTMLInputElement>("[role=dialog] input")!.value).toBe("收纳盒");
    await click("参考图片生成");
    expect(button("生成并加入商品").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Seedream Atlas");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="使用商品图 2 作为参考"]')!.click());
    await click("生成并加入商品");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ mode: "image-to-image", referenceImageUrl: images[1], title: "收纳盒", prompt: "白色磨砂收纳盒" });
    expect(useProductLibraryStore.getState().products[0].images).toEqual(images);
    await click("完成");
    expect(button("AI 生成商品图").disabled).toBe(true);
    const covers = buttons().filter(b => b.textContent === "设为封面");
    await act(async () => covers.at(-1)!.click());
    await click("保存修改");
    expect(useProductLibraryStore.getState().products[0]).toMatchObject({ id: "p1", name: "收纳盒", price: "¥29", targetAudience: "学生", videoCount: 3, images: ["/api/files/product-generated/new.png", ...images] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploads a reference as image data", async () => {
    await act(async () => root.render(createElement(LibraryImageDialog, { open: true, onOpenChange: close, destination: "product", onGenerated: saved })));
    await fill(); await click("参考图片生成");
    const upload = document.querySelector<HTMLInputElement>('[role=dialog] input[type=file]')!;
    Object.defineProperty(upload, "files", { configurable: true, value: [new File(["reference"], "reference.png", { type: "image/png" })] });
    await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
    await vi.waitFor(() => expect(button("生成并加入商品").disabled).toBe(false));
    fetchMock.mockResolvedValue(new Response(JSON.stringify(image), { status: 201 }));
    await click("生成并加入商品");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ mode: "image-to-image", referenceImageUrl: "data:image/png;base64,cmVmZXJlbmNl" });
    expect(saved).toHaveBeenCalledOnce();
  });

  it("does not send a hidden reference after switching back to text generation", async () => {
    await act(async () => root.render(createElement(LibraryImageDialog, { open: true, onOpenChange: close, destination: "product", onGenerated: saved, referenceImages: [{ url: "/api/files/products/p1/original.png" }] })));
    await fill(); await click("参考图片生成");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="使用商品图 1 作为参考"]')!.click());
    await click("文本生成");
    fetchMock.mockResolvedValue(new Response(JSON.stringify(image), { status: 201 }));
    await click("生成并加入商品");
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.mode).toBe("text-to-image"); expect(request.referenceImageUrl).toBeUndefined();
  });

  it("keeps input after an upstream error and does not add a product or automatically retry", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "upstream rejected" }), { status: 500 }));
    await act(async () => root.render(createElement(ProductsPage)));
    await click("AI 生成商品图"); await fill(); await click("生成并加入商品");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("upstream rejected");
    expect(document.querySelector<HTMLInputElement>("[role=dialog] input")!.value).toBe(image.title);
    expect(useProductLibraryStore.getState().products).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button("生成并加入商品").disabled).toBe(false);
  });

  it("explains when the configured models cannot use references without submitting", async () => {
    useSettingsStore.setState({ providers: { "atlas-cloud": { enabled: true, apiKey: "key" } } });
    await act(async () => root.render(createElement(LibraryImageDialog, { open: true, onOpenChange: close, destination: "product", onGenerated: saved })));
    await fill(); await click("参考图片生成");
    expect(document.body.textContent).toContain("暂无支持参考图片生成的模型");
    expect(button("生成并加入商品").disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("confirms presenter deletion and allows source-photo zoom preview without generation", async () => {
  useCharacterStore.setState({ characters: [{ id: "presenter", name: "测试主播", referenceImages: [], sourcePhotos: ["/api/files/characters/source.png"], isDefault: true }] });
  await act(async () => root.render(createElement(PresenterManager)));
  const photo = container.querySelector<HTMLImageElement>('img[src="/api/files/characters/source.png"]')!;
  expect(photo.closest("button")).not.toBeNull();
  await act(async () => photo.closest("button")!.click());
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe("/api/files/characters/source.png");
  // Dismiss by Escape, then test both cancel and confirm branches.
  await act(async () => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label="删除主播"]')!;
  await act(async () => remove.click());
  expect(useCharacterStore.getState().characters).toHaveLength(1);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("测试主播"));
  confirm.mockReturnValue(true);
  await act(async () => remove.click());
  expect(useCharacterStore.getState().characters).toHaveLength(0);
  confirm.mockRestore();
  expect(fetchMock).not.toHaveBeenCalled();
});

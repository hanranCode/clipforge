import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptInput, mentionAt, type PromptReference } from "@/app/project/remake/_components/prompt-input";
import { remapImageReferences, validPromptReferences } from "@/lib/remake/references";

const references: PromptReference[] = [ { token: "@Image1", kind: "image", label: "模特参考" },
  { token: "@Video1", kind: "video", label: "当前视频片段" }, { token: "@Audio1", kind: "audio", label: "新配音" } ];
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function Harness() {
  const [value, setValue] = useState("");
  return createElement(PromptInput, { value, onChange: setValue, references, label: "Prompt" });
}
async function type(text: string, caret = text.length) {
  const input = container.querySelector("textarea")!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.setSelectionRange(caret, caret); input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(value: string) { await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }))); }

describe("Prompt @ references", () => {
  it("groups images, videos and audio, navigates with arrows and inserts a token at the caret", async () => {
    await act(async () => root.render(createElement(Harness)));
    await type("把 @ 放进画面", 3);
    expect(container.querySelector('[role="group"][aria-label="图片"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="视频"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="音频"]')).not.toBeNull();
    await key("ArrowDown");
    await act(async () => container.querySelector("textarea")!.dispatchEvent(new Event("select", { bubbles: true })));
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("@Video1");
    await key("Enter");
    expect(container.querySelector("textarea")!.value).toBe("把 @Video1  放进画面");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("filters by label, supports Tab insertion and closes on Escape", async () => {
    await act(async () => root.render(createElement(Harness)));
    await type("参考 @新");
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    await key("Tab"); expect(container.querySelector("textarea")!.value).toBe("参考 @Audio1 ");
    await type("@"); await key("Escape"); expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("keeps tokens bound to their original files and rejects removed or out-of-range references", () => {
    expect(mentionAt("@Image1 test", 7)).toEqual({ start: 0, end: 7, query: "image1" });
    expect(remapImageReferences("@Image2 @Image3", ["a", "b", "c"], ["a", "c"])).toBe("@RemovedImage2 @Image2");
    expect(validPromptReferences("@Image2 @Video1 @Audio1", { image: 2, video: 1, audio: 1 })).toBe(true);
    expect(validPromptReferences("@RemovedImage2", { image: 3, video: 1, audio: 1 })).toBe(false);
    expect(validPromptReferences("@Audio1", { image: 2, video: 1, audio: 0 })).toBe(false);
  });
});

import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import { remake } from "@/lib/i18n/messages/remake";
import { useT } from "@/lib/i18n";

const original = Object.getOwnPropertyDescriptor(remake, "zh")!;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => { Object.defineProperty(remake, "zh", original); vi.unstubAllGlobals(); });

describe("translation dictionary refresh", () => {
  it("reads a replaced namespace dictionary without rebuilding the registry", () => {
    const updated = { ...remake.zh, pageSubtitle: "更新后的视频复刻流程" };
    Object.defineProperty(remake, "zh", { ...original, value: updated });
    expect(messages.zh.remake).toBe(updated);
    expect(messages.zh.remake.pageSubtitle).toBe(updated.pageSubtitle);
  });

  it("hydrates fresh remake copy without recovering an older registered dictionary", async () => {
    const updated = { ...remake.zh, pageSubtitle: "逐段确认的新文案" };
    Object.defineProperty(remake, "zh", { ...original, value: updated });
    function Probe() { return createElement("p", null, useT("remake")("pageSubtitle")); }
    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement("p", null, updated.pageSubtitle));
    document.body.appendChild(container);
    const recovered: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, createElement(Probe), { onRecoverableError: (error) => recovered.push(error) });
      });
      expect(recovered).toEqual([]);
      expect(container.textContent).toBe(updated.pageSubtitle);
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });
});

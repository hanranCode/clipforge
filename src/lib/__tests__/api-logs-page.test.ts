import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApiLogsPage from "@/app/api-logs/page";

const summary = {
  calls: 2, failed: 0, promptTokens: 0, completionTokens: 0,
  inputUsd: 0, outputUsd: 0, totalUsd: 1.5, unpricedCalls: 0, latencyMs: 100, byType: [],
};
const facets = { providers: [], models: [], scenes: [] };
function group(projectId: string | null = "a", projectName: string | null = "项目 A") {
  return { projectId, projectName, calls: 2, failed: 0, totalUsd: 1.5, unpricedCalls: 0, latestCallAt: "2026-10-14T10:00:00Z" };
}
function row(id: string) {
  return {
    id, projectId: "a", projectName: "项目 A", modelType: "text", model: `model-${id}`,
    provider: "test", status: "success", createdAt: "2026-10-14T10:00:00Z",
    request: { summary: "prompt", detail: { prompt: "完整请求" } },
    response: { summary: "result", detail: { text: "完整返回" } },
    cost: { totalUsd: 0.75 }, usage: null,
  };
}
function overview(groups = [group()], hasMore = false) {
  return { groups, items: [], total: 2, totalProjects: groups.length, hasMore, summary, facets };
}
function details(items = [row("one")], hasMore = false) {
  return { items, total: 2, hasMore, summary, facets };
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(createElement(ApiLogsPage)));
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(text));
  expect(button, `button containing ${text}`).toBeDefined();
  await act(async () => button!.click());
}

describe("API log project view", () => {
  it("expands a project, paginates its calls and preserves request/response drill-down", async () => {
    const fetch = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      if (params.has("groupBy")) return response(overview());
      expect(params.get("projectId")).toBe("a");
      return response(params.get("offset") === "0" ? details([row("one")], true) : details([row("two")]));
    });
    vi.stubGlobal("fetch", fetch);
    await render();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("项目 A");
    expect(container.textContent).toContain("花费合计 $1.50");
    expect(container.querySelector("table")).toBeNull();
    await click("项目 A");
    expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(container.textContent).toContain("model-one");
    await click("加载更多调用记录");
    expect(container.textContent).toContain("model-one");
    expect(container.textContent).toContain("model-two");
    await act(async () => container.querySelector("tbody tr")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).toContain("完整请求");
    expect(container.textContent).toContain("完整返回");
    await click("项目 A");
    expect(container.querySelector("table")).toBeNull();
  });

  it("loads only unassigned calls and lets a failed detail request be retried", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      if (params.has("groupBy")) return response(overview([group(null, null)]));
      expect(params.get("unassigned")).toBe("1");
      expect(params.has("projectId")).toBe(false);
      return ++attempts === 1 ? response({}, 500) : response(details());
    }));
    await render();
    await click("未关联项目");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("加载失败");
    await click("重试");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("model-one");
  });

  it("discards old project pagination when filters change and forwards filters to details", async () => {
    let finishOldPage: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      if (params.get("offset") === "1") return new Promise<Response>((resolve) => { finishOldPage = resolve; });
      if (params.has("groupBy")) return response(params.has("modelType") ? overview([group("b", "项目 B")]) : overview([group()], true));
      expect(params.get("modelType")).toBe("vision");
      expect(params.get("projectId")).toBe("b");
      return response(details());
    }));
    await render();
    await click("加载更多");
    await click("视觉");
    await act(async () => finishOldPage(response(overview([group("old", "过期项目")]))));
    expect(container.textContent).toContain("项目 B");
    expect(container.textContent).not.toContain("过期项目");
    expect(container.textContent).not.toContain("项目 A");
    await click("项目 B");
    expect(container.querySelector("table")).not.toBeNull();
  });
});

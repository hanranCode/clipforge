// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ai/test-provider/route";

afterEach(() => vi.unstubAllGlobals());

describe("Bailian connection probe", () => {
  it.each([200, 404, 401, 403])("queries the configured workspace without generating media (HTTP %s)", async (status) => {
    const fetch = vi.fn(async () => new Response("{}", { status }));
    vi.stubGlobal("fetch", fetch);
    const result = await POST(new NextRequest("http://localhost/api/ai/test-provider", { method: "POST",
      body: JSON.stringify({ name: "alibaba", apiKey: "test-key", baseUrl: " https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/ " }) }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/00000000-0000-0000-0000-000000000000",
      expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer test-key" } }));
    expect(await result.json()).toMatchObject({ status: status === 401 || status === 403 ? "invalid" : "unknown" });
  });
});

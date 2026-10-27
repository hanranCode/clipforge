// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tts/voices/route";

const config = { provider: "minimax", apiKey: "test-key", baseUrl: "https://api.minimax.io/v1/", groupId: "group 1" };
const request = (body: unknown) => POST(new NextRequest("http://localhost/api/tts/voices", { method: "POST", body: JSON.stringify(body) }));
afterEach(() => vi.unstubAllGlobals());

describe("MiniMax voice catalog", () => {
  it("queries all voice types with the configured endpoint/key/group and returns every unique voice", async () => {
    const system = Array.from({ length: 300 }, (_, i) => ({ voice_id: `system-${i}`, voice_name: `Voice ${i}` }));
    const fetch = vi.fn(async () => Response.json({ system_voice: system, voice_cloning: [{ voice_id: "clone", description: ["Custom voice"] }, { voice_id: "system-0" }], voice_generation: [{ voice_id: "generated" }, {}], base_resp: { status_code: 0 } }));
    vi.stubGlobal("fetch", fetch);
    const response = await request(config);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.voices).toHaveLength(302);
    expect(body.voices.slice(-2)).toEqual([{ value: "clone", label: "Custom voice" }, { value: "generated", label: "generated" }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://api.minimax.io/v1/get_voice?GroupId=group+1");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", headers: { Authorization: "Bearer test-key" } });
    expect(JSON.parse(String(init.body))).toEqual({ voice_type: "all" });
    expect(JSON.stringify(body)).not.toContain("test-key");
  });

  it.each([
    { system_voice: [], base_resp: { status_code: 1004, status_msg: "bad key" } },
    { system_voice: [] },
    { unexpected: true },
  ])("rejects failed/empty catalogs instead of reporting a complete list", async (data) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(data)));
    expect((await request(config)).status).toBe(502);
  });

  it.each([401, 429, 500])("handles HTTP %s without exposing upstream response bodies", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private provider details", { status })));
    const response = await request(config);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private provider details");
  });

  it("rejects missing credentials or a different provider without making requests", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await request({ provider: "minimax" })).status).toBe(400);
    expect((await request({ ...config, provider: "openai" })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect((await request(config)).status).toBe(502);
  });
});

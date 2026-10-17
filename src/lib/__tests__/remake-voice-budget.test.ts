import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tts-cache", () => ({
  ttsCacheKey: () => "test-key",
  readTtsCache: async () => null,
  writeTtsCache: async () => {},
}));
vi.mock("@/lib/api-call-log", () => ({ buildPayload: vi.fn(), recordApiCall: vi.fn() }));
vi.mock("@/lib/model-pricing", () => ({ estimateMediaCost: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("remake paid voice budget", () => {
  it("does not resubmit a paid synthesis after a network failure", async () => {
    const request = vi.fn().mockRejectedValue(new Error("fetch failed"));
    vi.stubGlobal("fetch", request);
    const { synthesizeLine } = await import("@/lib/remake/voice");
    await expect(synthesizeLine("测试男声", {
      kind: "paid",
      config: { provider: "minimax", baseUrl: "https://example.test/v1", apiKey: "test", model: "speech-2.6-turbo", voice: "male-qn-jingying" },
    }, { scene: "remake_dub" })).rejects.toThrow("fetch failed");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

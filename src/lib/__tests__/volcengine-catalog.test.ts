import { afterEach, describe, expect, it, vi } from "vitest";
import { VolcEngineProvider, VOLCENGINE_MODELS, arkMediaTypeOf } from "@/lib/providers/volcengine";
import { decodeModelChoice, encodeModelChoice } from "@/lib/provider-labels";

afterEach(() => vi.unstubAllGlobals());

describe("volcengine catalog", () => {
  it("lists the full curated Seedream / SeedEdit / Seedance lineup, not just 5 models", async () => {
    const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "", baseUrl: "" });
    const image = await provider.listModels("image");
    const video = await provider.listModels("video");
    expect(image.map((m) => m.id)).toEqual(expect.arrayContaining(["doubao-seedream-4-5-251128", "doubao-seededit-3-0-i2i-250628"]));
    expect(video.map((m) => m.id)).toEqual(expect.arrayContaining(["doubao-seedance-1-0-lite-i2v-250428", "doubao-seedance-2-0-fast-260128"]));
    expect(image.length + video.length).toBe(VOLCENGINE_MODELS.length);
    expect([...image, ...video].every((m) => m.provider === "volcengine")).toBe(true);
    expect(new Set(VOLCENGINE_MODELS.map((m) => m.id)).size).toBe(VOLCENGINE_MODELS.length);
  });

  it("merges generation ids a live /models answer adds, and ignores chat models", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "doubao-seedream-5-0-pro-260901" },
      { id: "doubao-seedance-2-0-260128" },
      { id: "doubao-seed-2-0-pro-260215" },
    ] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "k", baseUrl: "" });
    const models = await provider.listModels();
    expect(models.filter((m) => m.id === "doubao-seedance-2-0-260128")).toHaveLength(1);
    expect(models.find((m) => m.id === "doubao-seedream-5-0-pro-260901")?.mediaType).toBe("image");
    expect(models.some((m) => m.id === "doubao-seed-2-0-pro-260215")).toBe(false);
    expect(provider.catalogMetadata?.source).toBe("live");
  });

  it("falls back to the curated list when Ark answers 404 (no list endpoint for API keys)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "k", baseUrl: "" });
    expect(await provider.listModels()).toHaveLength(VOLCENGINE_MODELS.length);
    expect(provider.catalogMetadata?.source).toBe("static");
  });

  it("classifies ark ids", () => {
    expect(arkMediaTypeOf("doubao-seededit-3-0-i2i-250628")).toBe("image");
    expect(arkMediaTypeOf("doubao-seedance-1-5-pro-251215")).toBe("video");
    expect(arkMediaTypeOf("doubao-embedding")).toBeNull();
  });
});

describe("model choice encoding", () => {
  it("round-trips provider + model, including ids with slashes and colons", () => {
    const v = encodeModelChoice("atlas-cloud", "bytedance/seedance-2.0:fast");
    expect(decodeModelChoice(v)).toEqual({ provider: "atlas-cloud", model: "bytedance/seedance-2.0:fast" });
    expect(decodeModelChoice("bare-id")).toEqual({ provider: "", model: "bare-id" });
  });
});

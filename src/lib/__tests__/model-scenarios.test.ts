import { describe, expect, it } from "vitest";
import { modelScenarios } from "@/lib/model-scenarios";
import { BUILT_IN_PRICES, listPriceFor } from "@/lib/model-pricing";
import { VOLCENGINE_MODELS } from "@/lib/providers/volcengine";

describe("modelScenarios", () => {
  it("takes declared scenarios at their word, in display order", () => {
    expect(modelScenarios({ id: "x", mediaType: "video", extra: { scenarios: ["nativeAudio", "textToVideo", "bogus"] } }))
      .toEqual(["textToVideo", "nativeAudio"]);
  });

  it("every curated Volcengine model declares at least one scenario", () => {
    for (const m of VOLCENGINE_MODELS) expect(modelScenarios({ ...m, provider: "volcengine" }).length).toBeGreaterThan(0);
    const lite = VOLCENGINE_MODELS.find((m) => m.id === "doubao-seedance-1-0-lite-t2v-250428")!;
    expect(modelScenarios(lite)).toEqual(["textToVideo"]);
  });

  it("derives from modes and the endpoint id when nothing is declared", () => {
    expect(modelScenarios({ id: "fal/flux", mediaType: "image", modes: ["text-to-image", "image-to-image"] }))
      .toEqual(["textToImage", "imageToImage"]);
    expect(modelScenarios({ id: "bytedance/seedance-2.0/reference-to-video", mediaType: "video", modes: ["video-to-video"] }))
      .toContain("referenceVideo");
    expect(modelScenarios({ id: "some/video", mediaType: "video", modes: ["text-to-video"], supportsAudio: true }))
      .toEqual(["textToVideo", "nativeAudio"]);
  });

  it("does not borrow reference support from a sibling endpoint", () => {
    expect(modelScenarios({ id: "bytedance/seedance-2.0/text-to-video", mediaType: "video", modes: ["text-to-video"] }))
      .not.toContain("referenceVideo");
  });
});

describe("listPriceFor", () => {
  it("prefers the platform's published per-call price", () => {
    expect(listPriceFor({ id: "bytedance/seedance-2.0/text-to-video", mediaType: "video", extra: { priceBase: "0.3" } }, BUILT_IN_PRICES))
      .toEqual({ amount: 0.3, unit: "call", source: "provider" });
  });

  it("falls back to the price book with the unit that matches the media type", () => {
    expect(listPriceFor({ id: "doubao-seedance-2-0-260128", mediaType: "video" }, BUILT_IN_PRICES))
      .toEqual({ amount: 0.14, unit: "second", source: "pricebook" });
    expect(listPriceFor({ id: "doubao-seedream-4-0-250828", mediaType: "image" }, BUILT_IN_PRICES))
      .toEqual({ amount: 0.028, unit: "image", source: "pricebook" });
  });

  it("returns nothing rather than a guess for an unknown model", () => {
    expect(listPriceFor({ id: "mystery-model", mediaType: "video" }, BUILT_IN_PRICES)).toBeUndefined();
  });

  it("Ark variants with no published price are not priced by the generic seedance row", () => {
    for (const id of ["doubao-seedance-2-0-fast-260128", "doubao-seedance-2-0-mini-260615", "doubao-seedance-1-5-pro-251215", "doubao-seedance-1-0-pro-fast-251015"]) {
      expect(listPriceFor({ id, mediaType: "video" }, BUILT_IN_PRICES)).toBeUndefined();
    }
    expect(listPriceFor({ id: "doubao-seedance-1-0-pro-250528", mediaType: "video" }, BUILT_IN_PRICES)?.amount).toBe(0.046);
    expect(listPriceFor({ id: "doubao-seedance-1-0-lite-i2v-250428", mediaType: "video" }, BUILT_IN_PRICES)?.amount).toBe(0.03);
  });
});

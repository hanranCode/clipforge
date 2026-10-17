import { describe, it, expect } from "vitest";
import {
  MODEL_USAGES,
  MODEL_USAGE_STAGES,
  findModelFor,
  hasUsageOverride,
  modelForUsage,
  providerForUsage,
  usageChoice,
  withUsageModel,
} from "@/lib/model-usage";

const base = { defaultImageModel: "img-default", defaultVideoModel: "vid-default" };

describe("model-usage", () => {
  it("an empty slot follows the media type's default (existing installs unchanged)", () => {
    expect(modelForUsage(base, "textToImage")).toBe("img-default");
    expect(modelForUsage(base, "referenceImage")).toBe("img-default");
    expect(modelForUsage(base, "characterSheet")).toBe("img-default");
    expect(modelForUsage(base, "imageToVideo")).toBe("vid-default");
    expect(modelForUsage(base, "referenceVideo")).toBe("vid-default");
    expect(modelForUsage(base, "cloneReplicate")).toBe("vid-default");
    expect(providerForUsage(base, "textToImage")).toBe("");
  });

  it("an empty slot also follows the default provider", () => {
    const source = { ...base, defaultImageProvider: "fal-ai", defaultVideoProvider: "atlas-cloud" };
    expect(providerForUsage(source, "referenceImage")).toBe("fal-ai");
    expect(providerForUsage(source, "cloneReplicate")).toBe("atlas-cloud");
  });

  it("a slot's own model and provider win only for that slot", () => {
    const source = {
      ...base,
      defaultVideoProvider: "atlas-cloud",
      usageModels: { textToImage: { provider: "replicate", model: "cheap-img" }, referenceVideo: { provider: "fal-ai", model: "flagship-vid" } },
    };
    expect(modelForUsage(source, "textToImage")).toBe("cheap-img");
    expect(providerForUsage(source, "textToImage")).toBe("replicate");
    expect(modelForUsage(source, "referenceImage")).toBe("img-default");
    expect(modelForUsage(source, "referenceVideo")).toBe("flagship-vid");
    expect(providerForUsage(source, "referenceVideo")).toBe("fal-ai");
    expect(providerForUsage(source, "imageToVideo")).toBe("atlas-cloud");
    expect(hasUsageOverride(source, "textToImage")).toBe(true);
    expect(hasUsageOverride(source, "imageToVideo")).toBe(false);
  });

  it("legacy bare-string slots still read, with no pinned provider", () => {
    const source = { ...base, usageModels: { imageToVideo: "old-vid" } };
    expect(usageChoice(source, "imageToVideo")).toEqual({ provider: "", model: "old-vid" });
    expect(modelForUsage(source, "imageToVideo")).toBe("old-vid");
  });

  it("a slot with no model counts as unset", () => {
    expect(modelForUsage({ ...base, usageModels: { imageToVideo: { provider: "fal-ai", model: "  " } } }, "imageToVideo")).toBe("vid-default");
  });

  it("withUsageModel sets and clears without mutating", () => {
    const start = { textToImage: { provider: "a", model: "m1" } };
    const set = withUsageModel(start, "imageToVideo", { provider: "b", model: "m2" });
    expect(set).toEqual({ textToImage: { provider: "a", model: "m1" }, imageToVideo: { provider: "b", model: "m2" } });
    expect(start).toEqual({ textToImage: { provider: "a", model: "m1" } });
    expect(withUsageModel(set, "textToImage", null)).toEqual({ imageToVideo: { provider: "b", model: "m2" } });
    expect(withUsageModel(undefined, "cloneReplicate", { provider: "", model: "" })).toEqual({});
  });

  it("findModelFor respects a pinned provider when one model id lives on two platforms", () => {
    const models = [
      { id: "seedance", provider: "replicate" },
      { id: "seedance", provider: "atlas-cloud" },
    ];
    expect(findModelFor(models, "seedance", "atlas-cloud")?.provider).toBe("atlas-cloud");
    expect(findModelFor(models, "seedance")?.provider).toBe("replicate");
    expect(findModelFor(models, "seedance", "fal-ai")).toBeUndefined();
    expect(findModelFor(models, "")).toBeUndefined();
  });

  it("every usage belongs to a listed stage", () => {
    for (const usage of MODEL_USAGES) expect(MODEL_USAGE_STAGES).toContain(usage.stage);
  });

  it("video remake always pins Atlas and falls back to Seedance 2.5 for old selections", () => {
    for (const source of [
      base,
      { ...base, defaultVideoProvider: "alibaba", defaultVideoModel: "wan3.0-omni" },
      { ...base, usageModels: { videoRemake: { provider: "volcengine", model: "doubao-seedance-2-5" } } },
      { ...base, usageModels: { videoRemake: "alibaba/wan-2.7/reference-to-video" } },
    ]) {
      expect(modelForUsage(source, "videoRemake")).toBe("bytedance/seedance-2.5/reference-to-video");
      expect(providerForUsage(source, "videoRemake")).toBe("atlas-cloud");
    }
  });

  it("preserves an explicit full Seedance 2.0/2.5 reference choice and pins its provider", () => {
    for (const version of ["2.0", "2.5"]) {
      const model = `bytedance/seedance-${version}/reference-to-video`;
      const source = { ...base, usageModels: { videoRemake: { provider: "", model } } };
      expect(modelForUsage(source, "videoRemake")).toBe(model);
      expect(providerForUsage(source, "videoRemake")).toBe("atlas-cloud");
    }
  });

  it.each(["wan-3.0", "wan-3.0-prime"])("preserves the Atlas %s video remake choice", (family) => {
    const model = `alibaba/${family}/reference-to-video`;
    for (const choice of [model, { provider: "atlas-cloud", model }]) {
      const source = { ...base, usageModels: { videoRemake: choice } };
      expect(modelForUsage(source, "videoRemake")).toBe(model);
      expect(providerForUsage(source, "videoRemake")).toBe("atlas-cloud");
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyAssetMedia,
  facetCounts,
  filterAssetItems,
  formatBytes,
  readGenerationInputs,
  type AssetLibraryItem,
} from "@/lib/asset-library";

function item(overrides: Partial<AssetLibraryItem> = {}): AssetLibraryItem {
  return {
    id: "a1",
    projectId: "p1",
    projectName: "夏日防晒霜",
    shotId: 1,
    mediaType: "image",
    origin: "ai_generated",
    url: "/api/files/p1/asset-1.png",
    thumbnailUrl: null,
    provider: "atlas-cloud",
    model: "flux-dev",
    prompt: "白瓷质感的防晒霜特写，晨光",
    inputs: null,
    sourceUrl: null,
    author: null,
    license: null,
    selected: true,
    status: "done",
    sizeBytes: 2048,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("asset media classification", () => {
  it("reads the media type off the stored file path", () => {
    expect(classifyAssetMedia("/api/files/p1/shot-1.mp4")).toBe("video");
    expect(classifyAssetMedia("/api/files/p1/shot-1.MOV")).toBe("video");
    expect(classifyAssetMedia("/api/files/p1/shot-1.webp")).toBe("image");
    // a row whose file was never persisted still has to land somewhere
    expect(classifyAssetMedia(null)).toBe("image");
  });
});

describe("library filtering", () => {
  const items = [
    item({ id: "a1", mediaType: "image", model: "flux-dev" }),
    item({ id: "a2", mediaType: "video", model: "kling-v2", url: "/api/files/p1/shot-2.mp4", selected: false }),
    item({ id: "a3", origin: "stock_footage", provider: "pexels", model: null, prompt: null, author: "Ann", projectName: "冬季礼盒" }),
  ];

  it("filters by media type, origin and provider", () => {
    expect(filterAssetItems(items, { mediaType: "video" }).map((i) => i.id)).toEqual(["a2"]);
    expect(filterAssetItems(items, { origin: "stock_footage" }).map((i) => i.id)).toEqual(["a3"]);
    expect(filterAssetItems(items, { provider: "atlas-cloud" }).map((i) => i.id)).toEqual(["a1", "a2"]);
  });

  it("searches prompt, model, project name and author together", () => {
    expect(filterAssetItems(items, { search: "防晒" }).map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(filterAssetItems(items, { search: "kling" }).map((i) => i.id)).toEqual(["a2"]);
    expect(filterAssetItems(items, { search: "ann" }).map((i) => i.id)).toEqual(["a3"]);
    expect(filterAssetItems(items, { search: "  " })).toHaveLength(3);
  });

  it("narrows to the takes actually feeding composition", () => {
    expect(filterAssetItems(items, { selectedOnly: true }).map((i) => i.id)).toEqual(["a1", "a3"]);
  });

  it("combines filters instead of widening them", () => {
    expect(filterAssetItems(items, { mediaType: "video", selectedOnly: true })).toHaveLength(0);
  });
});

describe("imported material in the same feed", () => {
  // an import belongs to no project and carries a hand-written description instead of a prompt
  const imported = item({
    id: "i1",
    projectId: null,
    projectName: null,
    shotId: null,
    origin: "link_import",
    provider: null,
    model: null,
    prompt: null,
    selected: false,
    title: "厨房实拍 早餐",
    description: "灶台侧机位，暖光",
    tags: ["早餐", "厨房"],
  });
  const feed = [item({ id: "a1" }), imported];

  it("finds an import by what its importer typed", () => {
    expect(filterAssetItems(feed, { search: "厨房实拍" }).map((i) => i.id)).toEqual(["i1"]);
    expect(filterAssetItems(feed, { search: "暖光" }).map((i) => i.id)).toEqual(["i1"]);
    expect(filterAssetItems(feed, { search: "早餐" }).map((i) => i.id)).toEqual(["i1"]);
  });

  it("is reachable through the origin filter alongside generated takes", () => {
    expect(filterAssetItems(feed, { origin: "link_import" }).map((i) => i.id)).toEqual(["i1"]);
  });

  it("never answers a project filter, having no project", () => {
    expect(filterAssetItems(feed, { projectId: "p1" }).map((i) => i.id)).toEqual(["a1"]);
  });

  it("is excluded from the in-use-only filter, which is about composition", () => {
    expect(filterAssetItems(feed, { selectedOnly: true }).map((i) => i.id)).toEqual(["a1"]);
  });
});

describe("facets", () => {
  it("counts distinct values, most used first, ignoring blanks", () => {
    const counts = facetCounts(
      [item({ model: "flux-dev" }), item({ model: "flux-dev" }), item({ model: "kling-v2" }), item({ model: null })],
      "model",
    );
    expect(counts).toEqual([
      { value: "flux-dev", count: 2 },
      { value: "kling-v2", count: 1 },
    ]);
  });
});

describe("generation inputs", () => {
  it("summarizes a stored control plan into displayable inputs", () => {
    const inputs = readGenerationInputs({
      mode: "image-to-video",
      referenceInputs: [
        { url: "/api/files/p1/key-1.png", mediaType: "image" },
        { url: "/api/files/p1/ref.mp4", mediaType: "video" },
      ],
      audioMode: "native",
      generatedDuration: 5,
    });
    expect(inputs).toEqual({
      mode: "image-to-video",
      references: ["/api/files/p1/key-1.png", "/api/files/p1/ref.mp4"],
      referenceCount: 2,
      audioMode: "native",
      durationSeconds: 5,
    });
  });

  it("returns null for rows written before control plans existed", () => {
    expect(readGenerationInputs(null)).toBeNull();
    expect(readGenerationInputs({})).toBeNull();
    expect(readGenerationInputs("nonsense")).toBeNull();
  });
});

describe("size formatting", () => {
  it("scales units and shows nothing for a missing file", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(null)).toBe("—");
  });
});

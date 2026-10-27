// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { imageSource, imageSources, materialSource } from "@/lib/material-source";
import * as schema from "@/lib/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/agent-studio/catalog", () => ({ syncAgentCatalog: vi.fn(), agentArtifactIndex: () => new Map() }));
vi.mock("@/lib/local-media-metadata", () => ({ localVideoMetadata: vi.fn(async () => ({})) }));
import { GET } from "@/app/api/materials/route";
const sqlite = new Database(":memory:"), db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder: "drizzle" }); state.db = db;
beforeEach(() => { db.delete(schema.assets).run(); db.delete(schema.projects).run(); db.delete(schema.libraryAssets).run(); });
afterAll(() => sqlite.close());
const query = async (search = "") => (await GET(new NextRequest(`http://localhost/api/materials?${search}`))).json();

describe("material provenance", () => {
  it("keeps per-image origins on mixed presenters and products without inferring a real or virtual identity", () => {
    const photos = ["/api/files/characters/upload.png", "/api/files/characters/sheet-123.png"];
    expect(imageSources(photos, { imageSources: { [photos[0]]: "user_upload" } })).toEqual(["user_upload", "ai_generated"]);
    expect(imageSource("/api/files/characters/old-photo.png")).toBe("unknown");
    expect(imageSource("/api/files/product-generated/image.png")).toBe("ai_generated");
    expect(imageSource("/examples/tissue.png")).toBe("example");
    expect(imageSources([], { source: "manual" })).toEqual(["manual"]);
  });
  it("preserves an explicit captured source on a derived snapshot URL", () => {
    const url = "/api/files/agent-references/work/versions/version/hash.png";
    expect(imageSource(url, { source: "user_upload" })).toBe("user_upload");
    expect(materialSource({ origin: "ai_generated", source: "agent_remake" })).toBe("agent_remake");
  });
  it("distinguishes workflow provenance from the existing generation/upload origin", async () => {
    db.insert(schema.projects).values([{ id: "agent", name: "Agent work", sourceType: "agent" }, { id: "remake", name: "Legacy remake", sourceType: "remake" }, { id: "ordinary", name: "Ordinary" }]).run();
    db.insert(schema.assets).values([
      { id: "agent-out", projectId: "agent", shotId: 1, type: "ai_generated", filePath: "/api/files/agent/result.mp4", status: "done" },
      { id: "remake-out", projectId: "remake", shotId: 1, type: "ai_generated", filePath: "/api/files/remake/result.mp4", status: "done" },
      { id: "stock", projectId: "ordinary", shotId: 1, type: "stock_footage", filePath: "/api/files/ordinary/stock.png", status: "done" },
    ]).run();
    db.insert(schema.libraryAssets).values([
      { id: "generated", title: "Generated", mediaType: "image", importSource: "generated", filePath: "/api/files/generated.png" },
      { id: "uploaded", title: "Upload", mediaType: "image", importSource: "upload", filePath: "/api/files/uploaded.png" },
      { id: "legacy-final", title: "Legacy final", mediaType: "video", importSource: "upload", filePath: "/api/files/final.mp4", tags: ["视频复刻"] },
    ]).run();
    const response = await query();
    expect(Object.fromEntries(response.items.map((item: { id: string; source: string }) => [item.id, item.source]))).toEqual({ "agent-out": "agent_remake", "remake-out": "video_remake", stock: "stock_footage", generated: "ai_generated", uploaded: "user_upload", "legacy-final": "video_remake" });
    expect((await query("source=agent_remake&mediaType=video")).items.map((item: { id: string }) => item.id)).toEqual(["agent-out"]);
    expect((await query("origin=ai_generated")).items).toHaveLength(3);
    expect((await query("source=video_remake")).items).toHaveLength(2);
  });
  it("filters the entire library before pagination, retaining global source facets", async () => {
    db.insert(schema.libraryAssets).values(Array.from({ length: 30 }, (_, i) => ({ id: `item-${i}`, title: `Image ${i}`, mediaType: "image" as const, filePath: `/api/files/${i}.png`, importSource: i >= 28 ? "generated" as const : "upload" as const, createdAt: new Date(1000 + i * 1000) }))).run();
    const page1 = await query("source=ai_generated&mediaType=image&limit=1"), page2 = await query("source=ai_generated&mediaType=image&limit=1&offset=1");
    expect(page1.total).toBe(2); expect(page1.hasMore).toBe(true); expect(page1.items[0].id).toBe("item-29"); expect(page2.items[0].id).toBe("item-28"); expect(page2.hasMore).toBe(false);
    expect(page1.facets.sources).toEqual(expect.arrayContaining([{ value: "user_upload", count: 28 }, { value: "ai_generated", count: 2 }]));
  });
});

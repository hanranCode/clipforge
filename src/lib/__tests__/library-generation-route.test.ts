// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/agent-studio/catalog", () => ({ syncAgentCatalog: vi.fn(), agentArtifactIndex: () => new Map() }));
import * as schema from "@/lib/db/schema";

const mocks = vi.hoisted(() => ({ db: null as unknown, generate: vi.fn(), create: vi.fn(), persist: vi.fn(), remote: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db }));
vi.mock("@/lib/providers", () => ({ createProvider: mocks.create }));
vi.mock("@/lib/asset-persistence", () => ({ persistAssetSource: mocks.persist }));
vi.mock("@/lib/remote-image", () => ({ toRemoteUsableImage: mocks.remote }));
import { POST } from "@/app/api/materials/generate/route";
import { GET } from "@/app/api/materials/route";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder: "drizzle" });
afterAll(() => sqlite.close());
beforeEach(() => {
  mocks.db = db; db.delete(schema.libraryAssets).run(); vi.clearAllMocks();
  mocks.create.mockReturnValue({ generateImage: mocks.generate });
  mocks.generate.mockResolvedValue({ imageUrls: ["https://cdn.example/expiring.png"] });
  mocks.persist.mockResolvedValue("/api/files/library-generated/image.png");
  mocks.remote.mockImplementation(async ref => ref);
});
const input = { title: "产品图", prompt: "窗边的收纳盒", provider: "volcengine", model: "doubao-seedream-4-0-250828", apiKey: "test-key", aspectRatio: "9:16" };
const request = (overrides = {}) => POST(new NextRequest("http://localhost/api/materials/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, ...overrides }) }));

describe("standalone library generation", () => {
  it("generates once, persists locally and exposes provenance to search and filters without creating a project", async () => {
    const response = await request(); expect(response.status).toBe(201);
    const result = await response.json();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ width: 1440, height: 2560, count: 1, prompt: input.prompt }));
    expect(mocks.persist).toHaveBeenCalledWith("library-generated", "https://cdn.example/expiring.png", 0, "image");
    expect(db.select().from(schema.projects).all()).toHaveLength(0);
    expect(db.select().from(schema.libraryAssets).all()[0]).toMatchObject({ importSource: "generated", provider: input.provider, model: input.model, prompt: input.prompt });
    const library = await (await GET(new NextRequest(`http://localhost/api/materials?origin=ai_generated&provider=volcengine&model=${input.model}&q=收纳`))).json();
    expect(library.items).toHaveLength(1);
    expect(library.items[0]).toMatchObject({ id: result.id, origin: "ai_generated", url: result.url, provider: input.provider, model: input.model, prompt: input.prompt });
    expect(JSON.stringify(result)).not.toContain("test-key");
  });
  it("keeps presenter originals outside the deletable material pool", async () => {
    expect((await request({ destination: "presenter" })).status).toBe(201);
    expect(mocks.persist).toHaveBeenCalledWith("characters", expect.any(String), 0, "image");
  });
  it("persists product images outside the deletable material pool and attributes the model call", async () => {
    expect((await request({ destination: "product" })).status).toBe(201);
    expect(mocks.persist).toHaveBeenCalledWith("product-generated", expect.any(String), 0, "image");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ logContext: { scene: "product_image" } }));
  });
  it("converts an existing local product reference before the single image-to-image call", async () => {
    const referenceImageUrl = "/api/files/products/product-id/original.png";
    const data = "data:image/png;base64,aGVsbG8=";
    mocks.remote.mockResolvedValue(data);
    expect((await request({ destination: "product", mode: "image-to-image", referenceImageUrl })).status).toBe(201);
    expect(mocks.remote).toHaveBeenCalledWith(referenceImageUrl);
    expect(mocks.generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: "image-to-image", referenceImageUrl: data }));
  });
  it("ignores a stale reference in text mode", async () => {
    expect((await request({ mode: "text-to-image", referenceImageUrl: "https://example.com/product.png" })).status).toBe(201);
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.generate.mock.calls[0][0].referenceImageUrl).toBeUndefined();
  });
  it.each([undefined, "", "blob:local", "file:///etc/passwd", "/api/files/../../private.png", "data:text/plain;base64,aA==", 42])("rejects invalid references before billing: %s", async referenceImageUrl => {
    expect((await request({ mode: "image-to-image", referenceImageUrl })).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("rejects missing local references before billing", async () => {
    expect((await request({ mode: "image-to-image", referenceImageUrl: "/api/files/products/missing.png" })).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each([{ destination: "unknown" }, { mode: "unknown" }])("rejects unsupported modes and destinations before billing", async invalid => {
    expect((await request(invalid)).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each([{ title: " " }, { prompt: " " }, { apiKey: "" }, { model: "" }, { prompt: "x".repeat(6001) }])("rejects incomplete input before billing", async bad => {
    expect((await request(bad)).status).toBe(400); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("does not spend when storage is unavailable", async () => {
    mocks.db = { select: () => { throw new Error("storage unavailable"); } };
    expect((await request()).status).toBe(500); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("does not insert a false success or retry a paid request when the provider or persistence fails", async () => {
    mocks.generate.mockRejectedValueOnce(new Error("upstream rejected"));
    expect((await request()).status).toBe(500); expect(mocks.persist).not.toHaveBeenCalled();
    mocks.persist.mockRejectedValueOnce(new Error("disk full"));
    expect((await request()).status).toBe(500);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(db.select().from(schema.libraryAssets).all()).toHaveLength(0);
  });
});

// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown, rm: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("fs/promises", async (original) => ({ ...await original<object>(), rm: state.rm }));
import { DELETE } from "@/app/api/materials/[id]/route";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
const path = "/api/files/_library/shared.mp4";
beforeAll(() => { state.db = db; migrate(db, { migrationsFolder: "drizzle" }); });
beforeEach(() => {
  db.delete(schema.assets).run(); db.delete(schema.projects).run(); db.delete(schema.libraryAssets).run();
  db.insert(schema.libraryAssets).values({ id: "shared", title: "Shared", mediaType: "video", filePath: path }).run();
  state.rm.mockClear();
});
afterAll(() => sqlite.close());
const remove = (id = "shared") => DELETE(new NextRequest(`http://localhost/api/materials/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

describe("material deletion protects remake references", () => {
  it("reclaims standalone generated material files", async () => {
    const filePath = "/api/files/library-generated/image-0-123-a1b2c3d4.png";
    db.update(schema.libraryAssets).set({ importSource: "generated", filePath }).where(eq(schema.libraryAssets.id, "shared")).run();
    expect((await remove()).status).toBe(200);
    expect(state.rm).toHaveBeenCalledTimes(2);
    expect(db.select().from(schema.libraryAssets).all()).toHaveLength(0);
  });

  it.each(["/api/files/characters/portrait.png", "/api/files/product-generated/product.png"])("keeps originals managed by a browser library: %s", async filePath => {
    db.update(schema.libraryAssets).set({ importSource: "generated", filePath }).where(eq(schema.libraryAssets.id, "shared")).run();
    expect((await remove()).status).toBe(200);
    expect(state.rm).not.toHaveBeenCalled();
    expect(db.select().from(schema.libraryAssets).all()).toHaveLength(0);
  });
  it.each([{ source: { path } }, { images: [{ resource: { id: "shared" } }] }])("keeps the library row and bytes while a saved draft references them", async (remakeDraft) => {
    db.insert(schema.projects).values({ id: "remake", name: "Remake", sourceType: "remake", remakeDraft }).run();
    expect((await remove()).status).toBe(409);
    expect(db.select().from(schema.libraryAssets).all()).toHaveLength(1);
    expect(state.rm).not.toHaveBeenCalled();
    db.update(schema.projects).set({ remakeDraft: {} }).where(eq(schema.projects.id, "remake")).run();
    expect((await remove()).status).toBe(200);
    expect(db.select().from(schema.libraryAssets).all()).toHaveLength(0);
  });

  it("does not delete a generated take still used as a remake source", async () => {
    db.insert(schema.projects).values([{ id: "original", name: "Original" }, { id: "remake", name: "Remake", sourceType: "remake", remakeDraft: { source: { path } } }]).run();
    db.insert(schema.assets).values({ id: "take", projectId: "original", shotId: 0, type: "ai_generated", filePath: path, status: "done" }).run();
    expect((await remove("take")).status).toBe(409);
    expect(db.select().from(schema.assets).all()).toHaveLength(1);
    expect(state.rm).not.toHaveBeenCalled();
  });
});

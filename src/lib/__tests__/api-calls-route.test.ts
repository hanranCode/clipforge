// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/agent-studio/catalog", () => ({ syncAgentCatalog: vi.fn(), agentArtifactIndex: () => new Map() }));
import * as schema from "@/lib/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
import { GET } from "@/app/api/api-calls/route";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
const latest = new Date("2026-10-14T10:00:00Z");
beforeAll(() => {
  state.db = db;
  migrate(db, { migrationsFolder: "drizzle" });
});
beforeEach(() => {
  db.delete(schema.apiCalls).run();
  db.delete(schema.projects).run();
  db.insert(schema.projects).values([
    { id: "a", name: "同名项目" }, { id: "b", name: "同名项目" },
  ]).run();
});
afterAll(() => sqlite.close());

function call(id: string, values: Partial<typeof schema.apiCalls.$inferInsert> = {}) {
  db.insert(schema.apiCalls).values({
    id, projectId: "a", modelType: "text", provider: "test", model: "model",
    cost: { currency: "USD", source: "pricebook", totalUsd: 0.5 }, createdAt: latest, ...values,
  }).run();
}

async function read(query = "") {
  const response = await GET(new NextRequest(`http://localhost/api/api-calls?${query}`));
  expect(response.status).toBe(200);
  return await response.json();
}

describe("API call project aggregation", () => {
  it("aggregates the full project across call pages and paginates projects independently", async () => {
    for (let i = 0; i < 55; i++) call(`a-${i}`, { status: i === 0 ? "failed" : "success" });
    call("b-1", { projectId: "b", createdAt: new Date("2026-10-13T10:00:00Z") });
    const first = await read("groupBy=project&limit=1");
    expect(first.items).toEqual([]);
    expect(first).toMatchObject({ total: 56, totalProjects: 2, hasMore: true });
    expect(first.groups).toEqual([expect.objectContaining({
      projectId: "a", projectName: "同名项目", calls: 55, failed: 1, totalUsd: 27.5,
      unpricedCalls: 0, latestCallAt: latest.toISOString().replace(".000", ""),
    })]);
    expect(first.summary).toMatchObject({ calls: 56, totalUsd: 28 });
    const second = await read("groupBy=project&limit=1&offset=1");
    expect(second.groups).toMatchObject([{ projectId: "b", calls: 1, totalUsd: 0.5 }]);
    expect(second.hasMore).toBe(false);
    const detail = await read("projectId=a");
    expect(detail).toMatchObject({ total: 55, hasMore: true, summary: { totalUsd: 27.5 } });
    expect(detail.items).toHaveLength(50);
    const remaining = await read("projectId=a&offset=50");
    expect(remaining.items).toHaveLength(5);
    expect(remaining.hasMore).toBe(false);
    expect(new Set([...detail.items, ...remaining.items].map((row) => row.id)).size).toBe(55);
  });

  it("keeps unassigned and deleted projects visible without merging distinct IDs", async () => {
    call("none-1", { projectId: null });
    call("none-2", { projectId: null, cost: null });
    call("deleted-1", { projectId: "deleted-a" });
    call("deleted-2", { projectId: "deleted-b" });
    const result = await read("groupBy=project");
    expect(result.totalProjects).toBe(3);
    expect(result.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: null, projectName: null, calls: 2, totalUsd: 0.5, unpricedCalls: 1 }),
      expect.objectContaining({ projectId: "deleted-a", projectName: null, calls: 1 }),
      expect.objectContaining({ projectId: "deleted-b", projectName: null, calls: 1 }),
    ]));
    const unassigned = await read("unassigned=1");
    expect(unassigned.total).toBe(2);
    expect(unassigned.items.every((row: { projectId: string | null }) => row.projectId === null)).toBe(true);
    expect((await read("projectId=deleted-a")).items).toMatchObject([{ id: "deleted-1" }]);
  });

  it("applies the same combined filters to project totals and expanded details", async () => {
    call("match", { modelType: "video", status: "failed", scene: "shot_video" });
    call("wrong-status", { modelType: "video", scene: "shot_video" });
    call("wrong-type", { status: "failed", scene: "shot_video" });
    call("too-old", { modelType: "video", status: "failed", scene: "shot_video", createdAt: new Date("2026-09-01") });
    const filters = `modelType=video&status=failed&scene=shot_video&provider=test&model=model&since=${new Date("2026-10-01").getTime()}`;
    const overview = await read(`groupBy=project&${filters}`);
    expect(overview.groups).toMatchObject([{ projectId: "a", calls: 1, failed: 1, totalUsd: 0.5 }]);
    expect(overview.summary.calls).toBe(1);
    const detail = await read(`projectId=a&${filters}`);
    expect(detail.items).toMatchObject([{ id: "match" }]);
    expect(detail.summary.totalUsd).toBe(overview.groups[0].totalUsd);
  });

  it("searches project names as well as model and payload content", async () => {
    call("name-match");
    call("payload-match", { projectId: "deleted", request: { summary: "needle" } });
    call("model-match", { projectId: null, model: "needle-model" });
    const named = await read(`groupBy=project&q=${encodeURIComponent("同名项目")}`);
    expect(named.groups).toMatchObject([{ projectId: "a", calls: 1 }]);
    expect((await read(`projectId=a&q=${encodeURIComponent("同名项目")}`)).items).toMatchObject([{ id: "name-match" }]);
    expect((await read("groupBy=project&q=needle")).total).toBe(2);
  });

  it("includes every model type, priced zero and unpriced calls in project counts", async () => {
    call("text");
    call("vision", { modelType: "vision", cost: null });
    call("image", { modelType: "image", cost: { currency: "USD", source: "pricebook", totalUsd: 0 } });
    call("video", { modelType: "video", cost: { currency: "USD", source: "pricebook", totalUsd: 1.25 } });
    call("tts", { modelType: "tts", cost: { currency: "USD", source: "unknown", inputUsd: 0.1 } });
    const result = await read("groupBy=project");
    expect(result.groups).toMatchObject([{ calls: 5, totalUsd: 1.75, unpricedCalls: 2 }]);
    expect(result.summary.byType).toHaveLength(5);
  });

  it("returns an empty project page without hiding the filtered global totals", async () => {
    const empty = await read("groupBy=project");
    expect(empty).toMatchObject({ groups: [], total: 0, totalProjects: 0, hasMore: false });
    call("one");
    const beyond = await read("groupBy=project&offset=10");
    expect(beyond).toMatchObject({ groups: [], total: 1, totalProjects: 1, hasMore: false, summary: { totalUsd: 0.5 } });
    expect((await read("groupBy=project&status=failed")).totalProjects).toBe(0);
  });
});

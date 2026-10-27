// @vitest-environment node
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStudioStore } from "@/lib/agent-studio/store";
const state = vi.hoisted(() => ({ store: null as unknown as AgentStudioStore }));
vi.mock("@/lib/agent-studio/store", async original => ({ ...await original<object>(), studioStore: () => state.store }));
import { GET, POST } from "@/app/api/agent-studio/runtimes/route";
let sqlite: Database.Database;
beforeEach(() => { sqlite = new Database(":memory:"); state.store = new AgentStudioStore(sqlite); });
afterEach(() => sqlite.close());
const register = (cli: string) => POST(new NextRequest("http://localhost:3000/api/agent-studio/runtimes", { method: "POST", headers: { origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify({ name: "My Agent", cli, model: "vision-model" }) }));
describe("runtime registration", () => {
  it.each(["hermes-agent", "deepseek-harness"])("registers and reconnects %s using the existing lease and token protocol", async cli => {
    const response = await register(cli); expect(response.status).toBe(201);
    const { runtime, token } = await response.json();
    expect(state.store.authenticate(runtime.id, token).cli).toBe(cli);
    state.store.heartbeat(runtime.id, { version: "test", host: "test-host" });
    const list = await (await GET(new NextRequest("http://localhost:3000/api/agent-studio/runtimes"))).json();
    expect(list.runtimes[0]).toMatchObject({ cli, connected: true, model: "vision-model" });
    expect(JSON.stringify(list)).not.toContain(token);
  });
  it("rejects arbitrary executable names", async () => { expect((await register("sh")).status).toBe(400); expect(state.store.runtimes()).toHaveLength(0); });
});

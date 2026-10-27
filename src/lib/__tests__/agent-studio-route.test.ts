// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { AgentStudioStore } from "@/lib/agent-studio/store";
import type { WorkVersion } from "@/lib/agent-studio/types";
const state = vi.hoisted(() => ({ store: null as unknown as AgentStudioStore }));
vi.mock("@/lib/agent-studio/store", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/agent-studio/store")>(), studioStore: () => state.store }));
vi.mock("@/lib/agent-studio/engine", () => ({ cropUrl: () => null, hasVideoKey: () => true, initializeVersion: vi.fn(), prepareCrop: vi.fn(), reconcileTask: vi.fn(), recoverWork: vi.fn(), rememberKey: vi.fn() }));
import { POST } from "@/app/api/agent-studio/works/[id]/route";
let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); state.store = new AgentStudioStore(db); });
afterEach(() => db.close());
function request(id: string, data: object, origin = "http://localhost:3000") { return POST(new NextRequest(`http://localhost:3000/api/agent-studio/works/${id}`, {method:"POST",headers:{"Content-Type":"application/json",origin},body:JSON.stringify(data)}), {params:Promise.resolve({id})}); }
describe("Agent work actions", () => {
  it("starts an editable project for an imported work using an online local runtime", async () => { const s = state.store, r = s.register("Local", "codex"); s.heartbeat(r.runtime.id, {}); const w = s.create({ title:"Imported",sourceAssetId:"a",sourceName:"a",sourceUrl:"/api/files/a.mp4",duration:9,brief:"test",runtimeId:null,resolution:"480p",voice:"female" }); s.update(w.id,w=>{w.status="completed"; w.versions.push({id:"version",status:"completed"} as WorkVersion);}); const response = await request(w.id,{action:"editor",versionId:"version"}); expect(response.status).toBe(200); const job=s.claim(r.runtime.id); expect(job?.kind).toBe("editor"); expect(job?.versionId).toBe("version"); expect(s.work(w.id).status).toBe("completed"); });
  it("rebinds an existing version to the selected replacement after runtime revocation", async () => {
    const s = state.store, old = s.register("Old", "codex"), replacement = s.register("Replacement", "claude"); s.heartbeat(replacement.runtime.id, {});
    const w = s.create({ title:"Existing",sourceAssetId:"a",sourceName:"a",sourceUrl:"/api/files/a.mp4",duration:9,brief:"test",runtimeId:old.runtime.id,resolution:"480p",voice:"female" });
    s.revoke(old.runtime.id); s.update(w.id, w => { w.status = "completed"; w.versions.push({id:"version",status:"completed"} as WorkVersion); });
    const response = await request(w.id, {action:"editor",versionId:"version",runtimeId:replacement.runtime.id}); expect(response.status).toBe(200); expect(s.work(w.id).runtimeId).toBe(replacement.runtime.id); expect(s.claim(replacement.runtime.id)?.versionId).toBe("version"); expect(s.claim(old.runtime.id)).toBeNull();
  });
  it("rejects cross-origin mutation before accessing a work or its credentials", async () => { const r = await request("unknown",{action:"approve",budget:500},"https://untrusted.example"); expect(r.status).toBe(403); });
});

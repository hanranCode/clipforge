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
import { localRequest } from "@/lib/agent-studio/http";
let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); state.store = new AgentStudioStore(db); });
afterEach(() => db.close());
function request(id: string, data: object, origin = "http://localhost:3000") { return POST(new NextRequest(`http://localhost:3000/api/agent-studio/works/${id}`, {method:"POST",headers:{"Content-Type":"application/json",origin},body:JSON.stringify(data)}), {params:Promise.resolve({id})}); }
describe("Agent work actions", () => {
  it("lets a reviewed work select Bailian and freezes the generation choice on approval", async () => {
    const s = state.store, r = s.register("Local", "codex");
    const w = s.create({ title: "Test", sourceAssetId: "a", sourceName: "a", sourceUrl: "/api/files/a.mp4", duration: 9, brief: "test", runtimeId: r.runtime.id, resolution: "480p", voice: "female" });
    const plan = { summary: "A new video", preserve: [], change: [], notes: [], productCrop: null, segments: [{ duration: 9, script: "介绍商品", prompt: "A product demo" }] };
    s.update(w.id, current => { current.status = "review"; current.plan = plan; });
    const video = { provider: "alibaba", model: "wan3.0-video", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1" };
    const changed = await request(w.id, { action: "video-settings", video, resolution: "720p" });
    expect(changed.status).toBe(200);
    expect(s.work(w.id)).toMatchObject({ video, resolution: "720p", status: "review" });
    const approved = await request(w.id, { action: "approve", apiKey: "bailian-test", budget: 10, plan: JSON.stringify(plan), productConfirmed: true });
    expect(approved.status).toBe(200);
    expect(s.work(w.id).versions[0]).toMatchObject({ video: { ...video, resolution: "720p" } });
  });
  it("preserves historical Mini snapshots and rejects switching during an active version", async () => {
    const s = state.store, r = s.register("Local", "codex");
    const w = s.create({ title: "Test", sourceAssetId: "a", sourceName: "a", sourceUrl: "/api/files/a.mp4", duration: 9, brief: "test", runtimeId: r.runtime.id, resolution: "480p", voice: "female" });
    s.update(w.id, current => { current.status = "completed"; current.versions.push({ id: "old", status: "completed" } as WorkVersion); });
    const video = { provider: "alibaba", model: "wan3.0-video-prime" };
    expect((await request(w.id, { action: "video-settings", video, resolution: "1080p" })).status).toBe(200);
    expect(s.work(w.id).versions[0].video).toMatchObject({ provider: "volcengine", model: "doubao-seedance-2-0-mini-260615", resolution: "480p" });
    s.update(w.id, current => { current.status = "generating"; });
    expect((await request(w.id, { action: "video-settings", video, resolution: "720p" })).status).toBe(400);
    expect(s.work(w.id).resolution).toBe("1080p");
    expect((await request(w.id, { action: "video-settings", video: { provider: "alibaba", model: "doubao-seedance-2-0-mini-260615" }, resolution: "480p" })).status).toBe(400);
  });
  it("accepts the browser's exact loopback origin when Next normalizes its internal URL", () => {
    expect(() => localRequest(new NextRequest("http://localhost:3000/api/agent-studio/works/work", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" } }), true)).not.toThrow();
  });
  it.each([
    { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3001" },
    { host: "127.0.0.1:3000", origin: "https://untrusted.example" },
    { host: "evil.example", origin: "http://evil.example" },
    { host: "localhost:3000@evil.example", origin: "http://localhost:3000" },
    { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "cross-site" },
  ])("rejects cross-port, remote or malformed hosts and cross-site requests: %o", headers => {
    const requestHeaders = new Headers();
    for (const [name, value] of Object.entries(headers)) if (value !== undefined) requestHeaders.set(name, value);
    expect(() => localRequest(new NextRequest("http://localhost:3000/api/agent-studio/works/work", { method: "POST", headers: requestHeaders }), true)).toThrow("FORBIDDEN");
  });
  it("starts an editable project for an imported work using an online local runtime", async () => { const s = state.store, r = s.register("Local", "codex"); s.heartbeat(r.runtime.id, {}); const w = s.create({ title:"Imported",sourceAssetId:"a",sourceName:"a",sourceUrl:"/api/files/a.mp4",duration:9,brief:"test",runtimeId:null,resolution:"480p",voice:"female" }); s.update(w.id,w=>{w.status="completed"; w.versions.push({id:"version",status:"completed"} as WorkVersion);}); const response = await request(w.id,{action:"editor",versionId:"version"}); expect(response.status).toBe(200); const job=s.claim(r.runtime.id); expect(job?.kind).toBe("editor"); expect(job?.versionId).toBe("version"); expect(s.work(w.id).status).toBe("completed"); });
  it("rebinds an existing version to the selected replacement after runtime revocation", async () => {
    const s = state.store, old = s.register("Old", "codex"), replacement = s.register("Replacement", "claude"); s.heartbeat(replacement.runtime.id, {});
    const w = s.create({ title:"Existing",sourceAssetId:"a",sourceName:"a",sourceUrl:"/api/files/a.mp4",duration:9,brief:"test",runtimeId:old.runtime.id,resolution:"480p",voice:"female" });
    s.revoke(old.runtime.id); s.update(w.id, w => { w.status = "completed"; w.versions.push({id:"version",status:"completed"} as WorkVersion); });
    const response = await request(w.id, {action:"editor",versionId:"version",runtimeId:replacement.runtime.id}); expect(response.status).toBe(200); expect(s.work(w.id).runtimeId).toBe(replacement.runtime.id); expect(s.claim(replacement.runtime.id)?.versionId).toBe("version"); expect(s.claim(old.runtime.id)).toBeNull();
  });
  it("rejects cross-origin mutation before accessing a work or its credentials", async () => { const r = await request("unknown",{action:"approve",budget:500},"https://untrusted.example"); expect(r.status).toBe(403); });
});

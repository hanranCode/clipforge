import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@/lib/paths";
import { runtimeOnline, type AgentCli, type AgentEvent, type AgentJob, type AgentPlan, type AgentRuntime, type AgentWork, type WorkVersion } from "./types";
import { studioSnapshot, studioVideoCost } from "./video-models";
import { validatePlanReferences } from "./reference-types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const active = new Set(["queued", "running"]);

/** One durable seam for the UI and daemon. Transactions own queue, versions and spend approval. */
export class AgentStudioStore {
  constructor(readonly sql: Database.Database) {
    sql.pragma("busy_timeout = 5000");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS runtimes (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, runtime_id TEXT NOT NULL, kind TEXT NOT NULL, version_id TEXT, status TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(work_id) WHERE status IN ('queued','running');
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_work ON events(work_id,id);
    `);
  }
  runtimes(): AgentRuntime[] {
    return (this.sql.prepare("SELECT document FROM runtimes").all() as { document: string }[]).map(r => { const v = JSON.parse(r.document) as AgentRuntime; return { ...v, connected: runtimeOnline(v) }; });
  }
  register(name: string, cli: AgentCli, model = "") {
    const token = randomBytes(32).toString("base64url");
    const runtime: AgentRuntime = { id: randomUUID(), name, cli, model, enabled: true, lastSeen: null, connected: false, version: null, host: null, createdAt: Date.now() };
    this.sql.prepare("INSERT INTO runtimes VALUES (?,?,?)").run(runtime.id, digest(token), JSON.stringify(runtime));
    return { runtime, token };
  }
  authenticate(id: string, token: string) {
    const row = this.sql.prepare("SELECT token_hash,document FROM runtimes WHERE id=?").get(id) as { token_hash: string; document: string } | undefined;
    if (!row || !token || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(digest(token)))) throw new Error("UNAUTHORIZED");
    const runtime = JSON.parse(row.document) as AgentRuntime;
    if (!runtime.enabled) throw new Error("UNAUTHORIZED");
    return runtime;
  }
  heartbeat(id: string, metadata: { version?: string; host?: string; jobId?: string }) {
    const runtime = this.runtimes().find(r => r.id === id); if (!runtime) throw new Error("运行时不存在 / Runtime not found");
    runtime.lastSeen = Date.now(); runtime.version = metadata.version?.slice(0, 160) ?? runtime.version; runtime.host = metadata.host?.slice(0, 120) ?? runtime.host;
    this.sql.prepare("UPDATE runtimes SET document=? WHERE id=?").run(JSON.stringify(runtime), id);
    if (metadata.jobId) this.sql.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND runtime_id=? AND status='running' AND lease_until>=?").run(Date.now() + 60_000, metadata.jobId, id, Date.now());
  }
  revoke(id: string) {
    const r = this.runtimes().find(r => r.id === id); if (!r) return;
    r.enabled = false; this.sql.prepare("UPDATE runtimes SET document=? WHERE id=?").run(JSON.stringify(r), id);
    for (const j of this.sql.prepare("SELECT * FROM jobs WHERE runtime_id=? AND status IN ('queued','running')").all(id) as Record<string, unknown>[]) this.cancel(String(j.work_id));
  }
  works() { return (this.sql.prepare("SELECT document FROM works ORDER BY updated_at DESC").all() as { document: string }[]).map(r => JSON.parse(r.document) as AgentWork); }
  work(id: string) { const r = this.sql.prepare("SELECT document FROM works WHERE id=?").get(id) as { document: string } | undefined; if (!r) throw new Error("NOT_FOUND"); return JSON.parse(r.document) as AgentWork; }
  save(work: AgentWork) { work.updatedAt = Date.now(); this.sql.prepare("INSERT INTO works VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at").run(work.id, JSON.stringify(work), work.updatedAt); return work; }
  update(id: string, change: (work: AgentWork) => void) { return this.sql.transaction(() => { const w = this.work(id); change(w); return this.save(w); })(); }
  event(workId: string, kind: AgentEvent["kind"], text: string) { this.sql.prepare("INSERT INTO events(work_id,kind,text,created_at) VALUES (?,?,?,?)").run(workId, kind, text.slice(0, 6000), Date.now()); }
  events(id: string, after = 0) { return (this.sql.prepare("SELECT * FROM events WHERE work_id=? AND id>? ORDER BY id LIMIT 300").all(id, after) as { id: number; work_id: string; kind: AgentEvent["kind"]; text: string; created_at: number }[]).map(e => ({ id: e.id, workId: e.work_id, kind: e.kind, text: e.text, createdAt: e.created_at })); }
  create(input: Pick<AgentWork, "title" | "sourceAssetId" | "sourceUrl" | "sourceName" | "duration" | "brief" | "runtimeId" | "resolution" | "voice" | "references" | "video">, id: string = randomUUID()) {
    const now = Date.now(); const w: AgentWork = { ...input, id, status: "draft", plan: null, versions: [], posterUrl: null, projectId: null, error: null, createdAt: now, updatedAt: now };
    this.save(w); this.event(w.id, "user", input.brief); return w;
  }
  enqueue(workId: string, kind: AgentJob["kind"], versionId: string | null = null) {
    return this.sql.transaction(() => {
      const w = this.work(workId); const runtime = this.runtimes().find(r => r.id === w.runtimeId);
      if (!runtime?.enabled) throw new Error("请先选择已注册的运行时 / Select a registered runtime");
      if (this.sql.prepare("SELECT id FROM jobs WHERE work_id=? AND status IN ('queued','running')").get(workId)) throw new Error("作品已有进行中的任务 / A job is already active");
      const j: AgentJob = { id: randomUUID(), workId, runtimeId: runtime.id, kind, versionId, status: "queued", leaseUntil: 0, createdAt: Date.now() };
      this.sql.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)").run(j.id, workId, runtime.id, kind, versionId, j.status, 0, j.createdAt);
      if (kind !== "editor") { w.status = kind === "plan" ? "queued" : "generating"; w.error = null; this.save(w); }
      this.event(workId, "system", kind === "plan" ? "已加入 Agent 队列，等待本地运行时领取。" : kind === "generate" ? "预算已确认，开始制作新版本。" : "正在启动可编辑工程。");
      return j;
    })();
  }
  expireJobs() {
    const expired = this.sql.prepare("SELECT id FROM jobs WHERE status='running' AND lease_until<?").all(Date.now()) as { id: string }[];
    for (const j of expired) this.failJob(j.id, "运行时连接中断，已保留进度；请检查后恢复。");
    const queued = this.sql.prepare("SELECT id,work_id,version_id FROM jobs WHERE status='queued' AND kind='generate' AND created_at<?").all(Date.now() - 60_000) as { id: string; work_id: string; version_id: string }[];
    for (const j of queued) if (!this.work(j.work_id).versions.find(v => v.id === j.version_id)?.prepared) this.failJob(j.id, "版本素材准备中断，尚未提交生成。可以恢复准备。");
  }
  claim(runtimeId: string): AgentJob | null {
    return this.sql.transaction(() => {
      // Queue maintenance must also run without an open browser.
      this.expireJobs();
      const r = this.sql.prepare("SELECT * FROM jobs WHERE runtime_id=? AND status='queued' ORDER BY created_at LIMIT 1").get(runtimeId) as Record<string, unknown> | undefined;
      if (!r) return null;
      if (r.kind === "generate" && !this.work(String(r.work_id)).versions.find(v => v.id === r.version_id)?.prepared) return null;
      this.sql.prepare("UPDATE jobs SET status='running',lease_until=? WHERE id=? AND status='queued'").run(Date.now() + 60_000, r.id);
      const j = this.readJob(String(r.id));
      if (j.kind === "plan") this.update(j.workId, w => { w.status = "planning"; });
      return j;
    })();
  }
  readJob(id: string): AgentJob {
    const r = this.sql.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown> | undefined; if (!r) throw new Error("NOT_FOUND");
    return { id: String(r.id), workId: String(r.work_id), runtimeId: String(r.runtime_id), kind: r.kind as AgentJob["kind"], versionId: r.version_id as string | null, status: r.status as AgentJob["status"], leaseUntil: Number(r.lease_until), createdAt: Number(r.created_at) };
  }
  assertJob(id: string, runtimeId: string) { const j = this.readJob(id); if (j.runtimeId !== runtimeId || j.status !== "running" || j.leaseUntil < Date.now()) throw new Error("任务租约已失效 / Job lease expired"); return j; }
  completePlan(jobId: string, plan: AgentPlan) {
    const j = this.readJob(jobId); if (j.kind !== "plan" || !active.has(j.status)) throw new Error("任务已结束 / Job is no longer active");
    validatePlanReferences(plan, this.work(j.workId).references || []);
    this.sql.transaction(() => { this.sql.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId); this.update(j.workId, w => { w.plan = plan; w.status = "review"; w.error = null; }); this.event(j.workId, "agent", plan.summary); })();
  }
  approve(id: string, budget: number, expectedPlan: string, expectedReferences?: string, expectedVideo?: string) {
    return this.sql.transaction(() => {
      const w = this.work(id); if (!w.plan || w.status !== "review" || JSON.stringify(w.plan) !== expectedPlan) throw new Error("方案已变化，请重新确认 / Plan changed; review again");
      if (expectedReferences !== undefined && JSON.stringify(w.references || []) !== expectedReferences) throw new Error("参考素材已变化，请重新确认 / References changed; review again");
      if (expectedVideo !== undefined && JSON.stringify(studioSnapshot(w)) !== expectedVideo) throw new Error("视频配置已变化，请重新确认 / Video configuration changed; review again");
      validatePlanReferences(w.plan, w.references || []);
      const video = studioSnapshot(w);
      const estimated = Math.round(w.plan.segments.reduce((n, seg) => n + studioVideoCost(seg.duration, video), 0) * 100) / 100;
      if (!Number.isFinite(budget) || budget < estimated || budget > 500) throw new Error("预算不足或超出范围 / Invalid budget");
      const v: WorkVersion = { id: randomUUID(), number: w.versions.length + 1, status: "queued", plan: structuredClone(w.plan), budgetCny: budget, estimatedCny: estimated, costCny: null, receipts: w.plan.segments.map(() => ({ state: "pending" })), outputUrl: null, posterUrl: null, sourceId: null, editorUrl: null, error: null, createdAt: Date.now(), completedAt: null };
      v.referenceSnapshot = { capturedAt: Date.now(), items: structuredClone(w.references || []) };
      v.video = video;
      w.versions.push(v); this.save(w); this.enqueue(id, "generate", v.id); return v;
    })();
  }
  finishJob(id: string) { this.sql.prepare("UPDATE jobs SET status='completed' WHERE id=? AND status='running'").run(id); }
  failJob(id: string, error: string) {
    const j = this.readJob(id); if (!active.has(j.status)) return;
    this.sql.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(id);
    if (j.kind === "editor") { this.event(j.workId, "error", error); return; }
    this.update(j.workId, w => { w.status = "attention"; w.error = error.slice(0, 1200); const v = w.versions.find(v => v.id === j.versionId); if (v && v.status !== "completed") { v.status = "attention"; v.error = w.error; } }); this.event(j.workId, "error", error);
  }
  cancel(id: string) {
    this.sql.prepare("UPDATE jobs SET status='cancelled' WHERE work_id=? AND status IN ('queued','running')").run(id);
    this.update(id, w => { w.status = "cancelled"; for (const v of w.versions) if (["queued", "generating"].includes(v.status)) v.status = "cancelled"; });
    this.event(id, "system", "已停止后续操作；已提交的云端任务可能仍在执行，任务ID已保留。");
  }
}

let singleton: AgentStudioStore | undefined;
export function studioStore() {
  if (!singleton) { mkdirSync(getDataDir(), { recursive: true }); const sql = new Database(join(getDataDir(), "agent-studio.sqlite.db")); sql.pragma("journal_mode = WAL"); singleton = new AgentStudioStore(sql); }
  return singleton;
}

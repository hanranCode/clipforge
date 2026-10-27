import { NextRequest, NextResponse } from "next/server";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { studioStore } from "@/lib/agent-studio/store";
import { body, fail, localRequest, text } from "@/lib/agent-studio/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  try { localRequest(req); return NextResponse.json({ runtimes: studioStore().runtimes() }); } catch(e) { return fail(e); }
}
export async function POST(req: NextRequest) {
  try {
    localRequest(req, true); const b = await body(req), store = studioStore();
    if (b.action === "doctor") {
      const checks = await Promise.all(["codex", "claude"].map(async cli => { try { const r = await promisify(execFile)(cli, ["--version"], { timeout: 10_000 }); return { cli, installed: true, version: r.stdout.trim().slice(0, 160) }; } catch { return { cli, installed: false, version: null }; } }));
      return NextResponse.json({ checks });
    }
    if (b.action === "start" || b.action === "restart") {
      const r = b.action === "start" ? store.authenticate(text(b.id), text(b.token)) : store.runtimes().find(r => r.id === text(b.id) && r.enabled);
      if (!r) throw new Error("运行时不存在");
      if (b.action === "restart" && !existsSync(join(homedir(), ".config", "clipforge", "runtimes", `${r.id}.json`))) throw new Error("未找到本地连接配置，请注销后重新注册，或使用注册时复制的命令启动");
      if (store.runtimes().find(x => x.id === r.id)?.connected) throw new Error("运行时已在线，无需重复启动");
      const child = spawn(process.execPath, [join(process.env.APP_AGENT_BIN_DIR || process.cwd(), "bin/clipforge-agent.mjs"), "--server", req.nextUrl.origin, "--runtime", r.id], { detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...(b.action === "start" ? { CLIPFORGE_RUNTIME_TOKEN: text(b.token) } : {}) } });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
      return NextResponse.json({ started: true });
    }
    const cli = b.cli === "claude" ? "claude" : b.cli === "codex" ? "codex" : null;
    if (!cli || !text(b.name, 80)) throw new Error("请填写名称并选择 Codex 或 Claude Code");
    const result = store.register(text(b.name, 80), cli, text(b.model, 160));
    return NextResponse.json({ ...result, daemonPath: join(process.env.APP_AGENT_BIN_DIR || process.cwd(), "bin/clipforge-agent.mjs"), serverUrl: req.nextUrl.origin }, { status: 201 });
  } catch(e) { return fail(e); }
}
export async function DELETE(req: NextRequest) {
  try { localRequest(req, true); const b = await body(req); studioStore().revoke(text(b.id)); return NextResponse.json({ ok: true }); } catch(e) { return fail(e); }
}

#!/usr/bin/env node
/** Local outbound worker. Never receives a video-provider key or executes model-supplied commands. */
import { mkdir, readFile, writeFile, chmod, open, unlink } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { openEditableProject } from './lib/agent-editor.mjs';
import { runAgentPlan } from './lib/agent-cli.mjs';
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? '' : args[index + 1] || ''; };
if (args.includes('--help')) { console.log('node bin/clipforge-agent.mjs --server http://localhost:3000 --runtime <id>\n首次使用通过 CLIPFORGE_RUNTIME_TOKEN 环境变量传入注册令牌；后续会读取本机600权限的配置。'); process.exit(0); }
const id = option('--runtime');
if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('需要有效的 --runtime 注册ID');
const configDir = join(homedir(), '.config', 'clipforge', 'runtimes'); await mkdir(configDir, { recursive: true, mode: 0o700 });
const configFile = join(configDir, `${id}.json`); let saved = {};
try { saved = JSON.parse(await readFile(configFile, 'utf8')); } catch {}
const server = (option('--server') || saved.server || 'http://localhost:3000').replace(/\/+$/, '');
const target = new URL(server);
if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/') throw new Error('本地运行时只接受 loopback HTTP 地址');
const token = process.env.CLIPFORGE_RUNTIME_TOKEN || saved.token; delete process.env.CLIPFORGE_RUNTIME_TOKEN;
if (!token) throw new Error('缺少注册令牌，请从 ClipForge 设置 → Agent 运行时重新注册');
await writeFile(configFile, JSON.stringify({ server, token }), { mode: 0o600 }); await chmod(configFile, 0o600);
// A live process owns one registration; stale lock files are recovered after process liveness checks.
const lockFile = join(configDir, `${id}.lock`);
try { const handle = await open(lockFile, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); }
catch { let pid = 0; try { pid = Number(await readFile(lockFile, 'utf8')); process.kill(pid, 0); } catch { if (pid > 0) await unlink(lockFile).catch(() => {}); } if (!pid) throw new Error('运行时锁无效，请检查本机配置'); try { process.kill(pid, 0); throw new Error('此运行时已经启动'); } catch(e) { if (e.code !== 'ESRCH') throw e; } const handle = await open(lockFile, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); }
let stopped = false, current = null, controller = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(action, data = {}) {
  const response = await fetch(`${server}/api/agent-studio/worker`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, runtimeId: id, ...data }), signal: AbortSignal.timeout(360_000) });
  const result = await response.json(); if (!response.ok) { if (response.status === 401) { stopped = true; controller?.abort(); } throw new Error(result.error || `HTTP ${response.status}`); } return result;
}
const heartbeat = async () => { const r = await call('heartbeat', { version: 'clipforge-agent/2', host: hostname(), ...(current ? { jobId: current.id } : {}) }); if (r.cancelled) controller?.abort(); };
const timer = setInterval(() => { heartbeat().catch(e => console.error('心跳：', e.message)); }, 10_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; controller?.abort(); });
console.log(`ClipForge Agent ${id} → ${server}`);
try {
  await heartbeat();
  while (!stopped) {
    try {
      const { job, runtime } = await call('claim');
      if (!job) { await pause(2000); continue; }
      current = job; controller = new AbortController();
      console.log(`领取 ${job.kind} · ${job.workId}`);
      try {
        if (job.kind === 'plan') {
          await call('event', { jobId: job.id, text: '正在本机提取关键帧与识别口播。' });
          const context = await call('context', { jobId: job.id });
          await call('event', { jobId: job.id, text: '已准备六张关键帧与口播，正在由 Agent 规划新镜头。' });
          const plan = await runAgentPlan(runtime, context, message => call('event', { jobId: job.id, text: message }), controller.signal);
          if (!controller.signal.aborted) await call('plan', { jobId: job.id, plan });
        } else if (job.kind === 'generate') {
          while (!stopped && !controller.signal.aborted) { const result = await call('advance', { jobId: job.id }); if (result.done) break; await pause(4000); }
        } else if (job.kind === 'editor') {
          const context = await call('context', { jobId: job.id });
          const url = await openEditableProject(context.directory, controller.signal);
          await call('editor-ready', { jobId: job.id, url });
        } else throw new Error('不支持的任务类型');
      } catch(e) { console.error('任务：', e.message); if (!controller.signal.aborted) await call('fail', { jobId: job.id, error: e.message }).catch(() => {}); }
      finally { current = null; controller = null; }
    } catch(e) { console.error('连接：', e.message); if (!stopped) await pause(4000); }
  }
} finally { clearInterval(timer); await unlink(lockFile).catch(() => {}); }

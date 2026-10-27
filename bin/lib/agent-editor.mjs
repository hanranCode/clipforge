import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { open } from 'node:fs/promises';
const editors = new Map();
export async function openEditableProject(directory, signal) {
  const previous = editors.get(directory);
  if (previous && previous.process.exitCode === null) { try { if ((await fetch(previous.url, { signal: AbortSignal.timeout(2000) })).ok) return previous.url; } catch {} }
  const port = await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const log = await open(join(directory, 'studio.log'), 'a', 0o600);
  const child = spawn('hypit', ['studio', '--project', directory, '--run', join(directory, 'finished.svrun'), '--runtime', join(directory, 'hypit.runtime.json'), '--port', String(port)], { cwd: directory, detached: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
  let spawnError; child.once('error', e => { spawnError = e; }); child.unref(); await log.close();
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 45; i++) {
    if (signal.aborted) { child.kill(); throw new Error('启动已取消'); }
    if (spawnError) throw new Error(`Hypit 启动失败：${spawnError.message}。请先安装 Hypit CLI；仍可使用 ClipForge 的进入编辑。`);
    if (child.exitCode !== null) throw new Error('Hypit 未能启动，请检查版本工程内的 studio.log；ClipForge 编辑器仍可使用。');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) { editors.set(directory, { process: child, url }); return url; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  child.kill(); throw new Error('Hypit 启动超时，请检查 studio.log');
}

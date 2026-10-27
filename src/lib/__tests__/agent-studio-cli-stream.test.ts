// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentPlan } from "../../../bin/lib/agent-cli.mjs";
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function context() { const directory = await mkdtemp(join(tmpdir(), "clipforge-cli-")); directories.push(directory); return {directory,frames:[],duration:9,brief:"新人物",transcript:"商品演示",resolution:"480p",voice:"female"}; }
function child() { return Object.assign(new EventEmitter(), {stdout:new PassThrough(),stderr:new PassThrough(),stdin:new Writable({write(_chunk,_encoding,callback){callback();}}),kill:vi.fn()}); }
describe("CLI process protocol", () => {
  it("decodes a multibyte Chinese character split between stdout chunks", async () => {
    const process = child(); const value = {summary:"新的主持人"}; const line=Buffer.from(JSON.stringify({type:"result",is_error:false,structured_output:value})+"\n"); const cut=line.indexOf(Buffer.from("新"))+1;
    const spawn = vi.fn(() => { queueMicrotask(() => { process.stdout.write(line.subarray(0,cut)); process.stdout.write(line.subarray(cut)); process.emit("close",0); }); return process; });
    expect(await runAgentPlan({cli:"claude",model:""}, await context(), async () => {}, new AbortController().signal, spawn as unknown as typeof import("node:child_process").spawn)).toEqual(value);
    expect(spawn.mock.calls).toHaveLength(1);
  });
  it("does not accept a structured result from a process that exits unsuccessfully", async () => {
    const process = child(); const spawn = () => { queueMicrotask(() => { process.stdout.write(JSON.stringify({type:"result",structured_output:{summary:"must not accept"}})); process.emit("close",1); }); return process; };
    await expect(runAgentPlan({cli:"claude",model:""}, await context(), async () => {}, new AbortController().signal, spawn as unknown as typeof import("node:child_process").spawn)).rejects.toThrow("退出 (1)");
  });
});

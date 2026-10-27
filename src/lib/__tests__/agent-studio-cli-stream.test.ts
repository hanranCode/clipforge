// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentPlan } from "../../../bin/lib/agent-cli.mjs";
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function context() { const directory = await mkdtemp(join(tmpdir(), "clipforge-cli-")); directories.push(directory); return {directory,frames:[],duration:9,brief:"新人物",transcript:"商品演示",resolution:"480p",voice:"female"}; }
function child() { return Object.assign(new EventEmitter(), {stdout:new PassThrough(),stderr:new PassThrough(),stdin:new Writable({write(_chunk,_encoding,callback){callback();}}),kill:vi.fn()}); }
describe("CLI process protocol", () => {
  it("attaches selected library images to Codex as well as listing their roles in the prompt", async () => {
    const ctx = { ...await context(), frames: ["/tmp/source.png"], references: [{ id: "presenter-1", role: "presenter", path: "/tmp/presenter.png" }, { id: "scene-1", role: "scene", path: "/tmp/room.png" }] };
    await writeFile(join(ctx.directory, "agent-plan.json"), JSON.stringify({ summary: "plan" }));
    const process = child(); let stdin = ""; process.stdin = new Writable({ write(chunk, _encoding, callback) { stdin += String(chunk); callback(); } });
    const spawn = vi.fn(() => { queueMicrotask(() => process.emit("close", 0)); return process; });
    await runAgentPlan({ cli: "codex", model: "" }, ctx, async () => {}, new AbortController().signal, spawn as unknown as typeof import("node:child_process").spawn);
    // Paths must be separate -i arguments, never an interpolated shell command.
    const args = (spawn.mock.calls[0] as unknown[])[1] as string[];
    expect(args).toEqual(expect.arrayContaining(["/tmp/source.png", "/tmp/presenter.png", "/tmp/room.png"]));
    expect(stdin).toContain("TARGET_REFERENCES"); expect(stdin).toContain("presenter-1");
  });
  it.each(["hermes-agent", "deepseek-harness"])("accepts a completed %s plan and runs the real CLI executable with stdin", async cli => {
    const process = child(), ctx = await context(), plan = { summary: "新的主播" };
    const event = cli === "hermes-agent" ? { type: "result", exit_code: 0, text: JSON.stringify(plan) } : { type: "final", reason: { kind: "completed" }, text: "```json\n" + JSON.stringify(plan) + "\n```" };
    const spawn = vi.fn((...args: unknown[]) => { expect(args.length).toBeGreaterThan(0); queueMicrotask(() => { process.stdout.write(JSON.stringify(event)); process.emit("close", 0); }); return process; });
    expect(await runAgentPlan({ cli, model: "provider/vision-model" }, ctx, async () => {}, new AbortController().signal, spawn as unknown as typeof import("node:child_process").spawn)).toEqual(plan);
    expect(spawn.mock.calls[0][0]).toBe(cli === "hermes-agent" ? "hermes" : "dsh");
    if (cli === "deepseek-harness") {
      const patch = JSON.parse(await readFile(join(ctx.directory, "clipforge-dsh.json"), "utf8"));
      expect(patch).toContainEqual({ id: "agent-default-model", config: { provider: "provider", model: "vision-model" } });
    }
  });
  it.each([
    ["hermes-agent", { type: "result", exit_code: 1, text: '{"summary":"bad"}', error: "not authorized" }],
    ["deepseek-harness", { type: "final", reason: { kind: "aborted" }, text: '{"summary":"bad"}' }],
    ["deepseek-harness", { type: "final", reason: null, text: '{"summary":"bad"}' }],
    ["hermes-agent", { type: "result", exit_code: 0, text: 'prose {"summary":"bad"}' }],
  ])("rejects failed, incomplete or invalid %s output even if the process exits zero", async (cli, event) => {
    const process = child();
    const spawn = () => { queueMicrotask(() => { process.stdout.write(JSON.stringify(event)); process.emit("close", 0); }); return process; };
    await expect(runAgentPlan({ cli, model: "" }, await context(), async () => {}, new AbortController().signal, spawn as unknown as typeof import("node:child_process").spawn)).rejects.toThrow();
  });
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

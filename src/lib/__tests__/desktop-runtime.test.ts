// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface RuntimeFaults {
  missingTool?: "ffmpeg" | "ffprobe";
  brokenTool?: boolean;
  recognizerUnavailable?: boolean;
  httpFailure?: "connection" | "timeout";
  appearance?: Record<string, unknown>;
}

function runtime(status = 200, body = "[]", dark = false, faults: RuntimeFaults = {}) {
  const tools = vi.fn();
  if (faults.brokenTool) tools.mockImplementation(() => { throw new Error("native executable failed"); });
  const testModule = { exports: {} as { verifyDesktopRuntime: (input: unknown) => Promise<unknown> } };
  runInNewContext(readFileSync(resolve("electron/smoke.cjs"), "utf8"), {
    module: testModule,
    require: (name: string) => {
      if (name === "child_process") return { execFileSync: tools };
      if (name === "module") return { createRequire: () => () => faults.recognizerUnavailable ? {} : ({ OfflineRecognizer: class {} }) };
      if (name === "http") return { get: (_url: string, callback: (response: EventEmitter) => void) => {
        const request = Object.assign(new EventEmitter(), {
          destroy: vi.fn((error: Error) => { request.emit("error", error); }),
          setTimeout: vi.fn((_milliseconds: number, onTimeout: () => void) => {
            if (faults.httpFailure === "timeout") queueMicrotask(onTimeout);
          }),
        });
        queueMicrotask(() => {
          if (faults.httpFailure === "connection") { request.emit("error", new Error("connection refused")); return; }
          if (faults.httpFailure === "timeout") return;
          const response = Object.assign(new EventEmitter(), { statusCode: status });
          callback(response); response.emit("data", body); response.emit("end");
        });
        return request;
      } };
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  const window = { loadURL: vi.fn().mockResolvedValue(undefined), webContents: { executeJavaScript: vi.fn().mockResolvedValue({
    dark, prefersDark: dark, background: "rgb(248, 250, 252)", startBackground: "rgb(248, 250, 252)", colorScheme: "light only", hasApp: true, ...faults.appearance,
  }) } };
  return { tools, window, verify: () => testModule.exports.verifyDesktopRuntime({ url: "http://127.0.0.1:1234", serverEntry: "/server.js", ffmpegPath: faults.missingTool === "ffmpeg" ? "" : "/ffmpeg", ffprobePath: faults.missingTool === "ffprobe" ? "" : "/ffprobe", window }) };
}

describe("packaged desktop runtime acceptance", () => {
  it("verifies the database, native media tools, local recognizer and light renderer together", async () => {
    const app = runtime();
    await expect(app.verify()).resolves.toMatchObject({ database: true, mediaTools: true, senseVoice: true, appearance: { prefersDark: false } });
    expect(app.tools.mock.calls.map((call) => call[0])).toEqual(["/ffmpeg", "/ffprobe"]);
    expect(app.window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:1234/start");
  });
  it.each([[500, '{"error":"ABI mismatch"}'], [200, '{}'], [200, 'not-json']])("fails rather than emitting a false success when the DB route returns %i/%s", async (status, body) => {
    const app = runtime(status, body);
    await expect(app.verify()).rejects.toThrow();
    expect(app.tools).not.toHaveBeenCalled();
  });
  it("rejects a renderer that follows the operating system into dark mode", async () => {
    await expect(runtime(200, "[]", true).verify()).rejects.toThrow("Light interface probe failed");
  });
  it("rejects cross-architecture native builds before invoking Next or the packager", () => {
    const target = process.arch === "arm64" ? "--x64" : "--arm64";
    expect(() => execFileSync(process.execPath, ["scripts/build-desktop.mjs", target], { stdio: "pipe" })).toThrow(/runner/);
  });
  // Value: protects=desktop acceptance rejects a missing media binary;
  // fails_when=the smoke probe skips an unresolved ffmpeg or ffprobe path;
  // why_new=the existing success case always supplies both tools; seam=none
  it.each(["ffmpeg", "ffprobe"] as const)("rejects a missing bundled %s before loading the renderer", async (missingTool) => {
    const app = runtime(200, "[]", false, { missingTool });
    await expect(app.verify()).rejects.toThrow("Bundled media tool not found");
    expect(app.window.loadURL).not.toHaveBeenCalled();
  });
  // Value: protects=desktop acceptance runs the media binary instead of trusting its path;
  // fails_when=a native executable failure is swallowed and success is returned;
  // why_new=afterPack tests do not exercise this runtime acceptance boundary; seam=none
  it("rejects a present native tool that cannot execute", async () => {
    const app = runtime(200, "[]", false, { brokenTool: true });
    await expect(app.verify()).rejects.toThrow("native executable failed");
    expect(app.window.loadURL).not.toHaveBeenCalled();
  });
  // Value: protects=desktop success requires the local recognizer constructor;
  // fails_when=a missing recognizer export is treated as a working native runtime;
  // why_new=the existing harness always provides OfflineRecognizer; seam=none
  it("rejects an unavailable local recognizer before accepting the renderer", async () => {
    const app = runtime(200, "[]", false, { recognizerUnavailable: true });
    await expect(app.verify()).rejects.toThrow("Local SenseVoice runtime is unavailable");
    expect(app.window.loadURL).not.toHaveBeenCalled();
  });
  // Value: protects=desktop acceptance independently validates all light appearance conditions;
  // fails_when=an incorrect background, dark preference, color scheme or blank app is accepted;
  // why_new=the existing dark test changes two flags together and masks omitted checks; seam=none
  it.each([
    { dark: true }, { prefersDark: true }, { background: "rgb(0, 0, 0)" },
    { startBackground: "rgb(11, 13, 18)" }, { startBackground: null }, { colorScheme: "dark" }, { hasApp: false },
  ])("rejects an isolated appearance mismatch %j", async (appearance) => {
    await expect(runtime(200, "[]", false, { appearance }).verify()).rejects.toThrow("Light interface probe failed");
  });
  // Value: protects=database acceptance rejects transport failure and timeout without probing native tools;
  // fails_when=request errors are ignored or the timeout no longer rejects;
  // why_new=existing DB cases exercise only completed HTTP responses; seam=none
  it.each(["connection", "timeout"] as const)("fails cleanly when the database probe has a %s failure", async (httpFailure) => {
    const app = runtime(200, "[]", false, { httpFailure });
    await expect(app.verify()).rejects.toThrow(httpFailure === "connection" ? "connection refused" : "Database probe timed out");
    expect(app.tools).not.toHaveBeenCalled();
  });
});

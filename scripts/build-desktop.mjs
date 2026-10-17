import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const target = args.includes("--mac") ? "darwin" : args.includes("--win") ? "win32" : args.includes("--linux") ? "linux" : process.platform;
const arch = args.includes("--x64") ? "x64" : args.includes("--arm64") ? "arm64" : process.arch;
if (target !== process.platform || arch !== process.arch) {
  throw new Error(`Desktop native dependencies require a ${target}/${arch} runner (current ${process.platform}/${process.arch}). Use the desktop CI matrix.`);
}
const env = { ...process.env, CLIPFORGE_DIST_DIR: ".next-desktop" };
const run = (script, argv = []) => execFileSync(process.execPath, [script, ...argv], { env, stdio: "inherit" });
// Next adds temporary type globs; leave the authored project configuration unchanged.
const config = resolve("tsconfig.json");
const before = readFileSync(config);
try {
  run(require.resolve("next/dist/bin/next"), ["build"]);
  run(resolve("scripts/bundle-standalone.mjs"));
  run(require.resolve("electron-builder/cli.js"), [...args, "--publish", "never"]);
} finally { writeFileSync(config, before); }

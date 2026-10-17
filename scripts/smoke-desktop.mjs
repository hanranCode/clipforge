import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// NSIS reuses the production install identity, even with a custom /D directory.
// Never let a local smoke replace an existing user's installation.
if (process.platform === "win32" && process.argv.includes("--installer") && process.env.CLIPFORGE_DISPOSABLE_INSTALL !== "1") {
  throw new Error("Windows installer smoke requires a disposable CI/VM with CLIPFORGE_DISPOSABLE_INSTALL=1. Use desktop:smoke without --installer for local unpacked verification.");
}

const release = resolve("release");
const output = join(release, "smoke");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), "clipforge desktop smoke-"));
const profile = join(directory, "profile");
mkdirSync(profile);
let mounted = false;
let executable;
try {
  if (process.argv.includes("--installer")) {
    const extension = process.platform === "darwin" ? ".dmg" : ".exe";
    const packages = readdirSync(release).filter((file) => file.endsWith(extension));
    if (packages.length !== 1) throw new Error(`Expected exactly one native ${extension} installer, found ${packages.length}`);
    const installer = join(release, packages[0]);
    if (process.platform === "darwin") {
      const mount = join(directory, "mount");
      mkdirSync(mount);
      execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, installer], { stdio: "pipe", timeout: 60_000 });
      mounted = true;
      executable = join(mount, "ClipForge.app", "Contents", "MacOS", "ClipForge");
    } else if (process.platform === "win32") {
      const install = join(directory, "installed");
      // NSIS parses the final /D= value itself; quotes become literal path characters.
      execFileSync(installer, ["/S", `/D=${install}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 120_000 });
      executable = join(install, "ClipForge.exe");
    } else throw new Error("Installer smoke supports macOS and Windows");
  } else {
    executable = process.platform === "darwin"
      ? join(release, process.arch === "arm64" ? "mac-arm64" : "mac", "ClipForge.app", "Contents", "MacOS", "ClipForge")
      : process.platform === "win32" ? join(release, "win-unpacked", "ClipForge.exe") : join(release, "linux-unpacked", "clipforge");
  }
  if (!existsSync(executable)) throw new Error(`Packaged executable missing: ${executable}`);
  const env = { ...process.env, HEADLESS_SMOKE: "1", CLIPFORGE_SMOKE_DATA_DIR: profile,
    CLIPFORGE_SMOKE_SCREENSHOT: join(output, "light-interface.png") };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(executable, ["--disable-gpu"], { env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (data) => { text += data; });
    child.stderr.on("data", (data) => { text += data; });
    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { /* already exited */ }
      } else { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ } }
      reject(new Error(`Desktop smoke timed out\n${text}`));
    }, 120_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(join(output, "runtime.log"), text);
      const marker = text.split(/\r?\n/).find((line) => line.startsWith("SMOKE_OK "));
      if (code !== 0 || !marker) return reject(new Error(`Desktop smoke failed (exit ${code})\n${text}`));
      resolveResult(JSON.parse(marker.slice("SMOKE_OK ".length)));
    });
  });
  writeFileSync(join(output, "result.json"), JSON.stringify({ platform: process.platform, arch: process.arch, installer: process.argv.includes("--installer"), ...result }, null, 2));
  console.log("Desktop smoke passed", JSON.stringify(result));
} finally {
  if (mounted) {
    // The renderer/server helpers can release the mounted app just after Electron
    // exits. Retry normal detach for this owned image; never force-unmount disks.
    for (let attempt = 0; ; attempt++) {
      try {
        execFileSync("hdiutil", ["detach", join(directory, "mount")], { stdio: "pipe", timeout: 5_000 });
        break;
      } catch (error) {
        if (attempt === 9) throw error;
        await delay(1_000);
      }
    }
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

/**
 * FFmpeg build-capability probing (filters compiled into the binary).
 *
 * drawtext (libfreetype/harfbuzz) and subtitles/ass (libass) are OPTIONAL at ffmpeg build time:
 * a perfectly healthy `ffmpeg` on PATH can be built without them — Homebrew's minimal 8.0.1 build
 * and ffmpeg-static's linux-x64 7.x build both are. Every render that burns captions, overlay tags
 * or the AIGC compliance badge then dies with "No such filter: 'drawtext'" — and it dies at graph
 * *parse* time only after the whole command was assembled, so the user waits through a full
 * compose before seeing a cryptic failure.
 *
 * So: probe the candidate binaries once per process, run the job on one that actually has the
 * filters the filtergraph uses (the bundled ffmpeg-static binary is the fallback — it is what the
 * Electron build ships anyway), and if none qualifies, fail early with an actionable message
 * instead of silently dropping the subtitles / the legally-required AIGC mark.
 */
import { existsSync } from "fs";
import { join } from "path";
import { ffmpegBin, setFfmpegBin } from "@/lib/ffmpeg-path";

/** Filters our filtergraphs use that depend on optional ffmpeg build libs (libfreetype / libass). */
export const OPTIONAL_FILTERS = ["drawtext", "subtitles", "ass"] as const;

/**
 * Parse `ffmpeg -hide_banner -filters` output into a set of filter names.
 * Lines look like: " T.C drawtext          V->V       Draw text on top of video frames..."
 * Pure function (testable without a binary).
 */
export function parseFilterNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of String(stdout).split("\n")) {
    const m = /^\s*[TSC.]{3}\s+(\S+)\s+[AVN|]+->[AVN|]+\s/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Which optional filters a filtergraph actually uses. The leading boundary check keeps `ass=` from
 * matching `highpass=` / `lowpass=` and friends. Pure function.
 */
export function optionalFiltersUsed(filtergraph: string): string[] {
  return OPTIONAL_FILTERS.filter((f) => new RegExp(`(^|[,;\\[\\]\\s])${f}=`).test(filtergraph));
}

/** Per-binary filter-set cache; survives Next dev hot-reloads via globalThis (a probe costs ~80ms). */
const capsRegistry = globalThis as typeof globalThis & { clipforgeFfmpegCaps?: Map<string, Promise<Set<string>>> };
const capsCache = (capsRegistry.clipforgeFfmpegCaps ??= new Map<string, Promise<Set<string>>>());

/** Filters compiled into `bin`; an empty set means the binary is missing or unusable (never throws). */
export function probeFfmpegFilters(bin: string): Promise<Set<string>> {
  const cached = capsCache.get(bin);
  if (cached) return cached;
  const probing = (async () => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const run = promisify(execFile);
    try {
      const { stdout } = await run(bin, ["-hide_banner", "-filters"], { maxBuffer: 16 * 1024 * 1024 });
      return parseFilterNames(String(stdout));
    } catch {
      // binary absent / not executable — don't cache the negative, a later install should be picked up
      capsCache.delete(bin);
      return new Set<string>();
    }
  })();
  capsCache.set(bin, probing);
  return probing;
}

/** Absolute path of the bundled ffmpeg-static binary, or undefined when it isn't installed. */
async function bundledFfmpeg(): Promise<string | undefined> {
  try {
    const mod: unknown = await import("ffmpeg-static");
    const p = (mod as { default?: string }).default ?? (mod as string);
    if (typeof p === "string" && p && existsSync(p)) return p;
  } catch {
    /* fall through to the on-disk guess below */
  }
  // the import can come back bundler-mangled (ffmpeg-static resolves its path from __dirname);
  // node_modules is right there, so look for the binary directly before giving up
  const guess = join(process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return existsSync(guess) ? guess : undefined;
}

function missingFilterMessage(missing: string[]): string {
  const libs = missing.includes("drawtext")
    ? missing.length > 1 ? "libfreetype/libass" : "libfreetype"
    : "libass";
  return (
    `当前 ffmpeg 缺少 ${missing.join("、")} 滤镜（编译时未启用 ${libs}），无法烧录字幕和 AIGC 标识——` +
    `请安装完整版 ffmpeg（macOS: brew reinstall ffmpeg；Ubuntu/Debian: sudo apt install ffmpeg），` +
    `或在项目根目录执行 pnpm install 以恢复随包的 ffmpeg-static 二进制`
  );
}

/**
 * Resolve an ffmpeg binary that has every filter in `needed`, preferring the configured one.
 * When the configured binary falls short, the capable fallback is installed process-wide
 * (setFfmpegBin) so the sync ffmpegBin() call sites in the rest of the pipeline follow suit.
 * Throws a user-facing message when nothing on the machine can do it.
 */
export async function resolveFfmpegForFilters(needed: readonly string[]): Promise<string> {
  const current = ffmpegBin();
  if (needed.length === 0) return current;

  const bundled = await bundledFfmpeg();
  const candidates = [current, bundled, "ffmpeg"].filter((b, i, all): b is string => !!b && all.indexOf(b) === i);

  for (const bin of candidates) {
    const have = await probeFfmpegFilters(bin);
    if (have.size === 0) continue; // unusable binary
    if (needed.every((f) => have.has(f))) {
      if (bin !== current) {
        setFfmpegBin(bin);
        console.warn(`[ffmpeg] ${current} 缺少 ${needed.join("、")} 滤镜，已切换到内置二进制：${bin}`);
      }
      return bin;
    }
  }

  const have = await probeFfmpegFilters(current);
  throw new Error(missingFilterMessage(needed.filter((f) => !have.has(f))));
}

/** Same as resolveFfmpegForFilters, driven by the optional filters a filtergraph actually uses. */
export function resolveFfmpegForGraph(filtergraph: string): Promise<string> {
  return resolveFfmpegForFilters(optionalFiltersUsed(filtergraph));
}

/**
 * ffmpeg / ffprobe binary path resolution — allows commands to target the bundled binary,
 * supporting Electron packaging.
 *
 * Development: falls back to `ffmpeg` / `ffprobe` on the system PATH (same behaviour as before).
 * Electron package: the main process injects the absolute paths extracted from ffmpeg-static /
 * @ffprobe-installer into FFMPEG_PATH / FFPROBE_PATH, so users don't need to install ffmpeg themselves.
 *
 * Note: return values are interpolated into shell command strings; paths may contain spaces —
 * callers must wrap them in double quotes.
 */

/**
 * Process-wide override installed by the capability probe (src/lib/ffmpeg-caps.ts) when the
 * configured binary is missing filters we need (e.g. a Homebrew ffmpeg built without libfreetype
 * has no drawtext). Takes precedence over FFMPEG_PATH: it is only ever set after that binary was
 * probed and found wanting. Kept on globalThis so Next dev hot-reloads don't re-probe.
 */
const binRegistry = globalThis as typeof globalThis & { clipforgeFfmpegOverride?: string };

/** Point every ffmpegBin() caller at a specific binary (pass undefined to go back to FFMPEG_PATH / PATH). */
export function setFfmpegBin(path: string | undefined): void {
  binRegistry.clipforgeFfmpegOverride = path;
}

/** Path to the ffmpeg executable (callers must quote it if it contains spaces) */
export function ffmpegBin(): string {
  return binRegistry.clipforgeFfmpegOverride || process.env.FFMPEG_PATH || "ffmpeg";
}

/** Path to the ffprobe executable (callers must quote it if it contains spaces) */
export function ffprobeBin(): string {
  return process.env.FFPROBE_PATH || "ffprobe";
}

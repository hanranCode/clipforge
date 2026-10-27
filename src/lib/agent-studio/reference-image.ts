import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";

const exec = promisify(execFile);
// Seedance rejects reference images if either dimension is below 300px.
// Padding preserves the approved ROI and its proportions without including more of the source frame.
export const VIDEO_REFERENCE_PADDING = "pad=w='max(iw,300)':h='max(ih,300)':x=(ow-iw)/2:y=(oh-ih)/2:color=white";

/** Make a submission copy; never rewrite a captured or approved image. */
export async function videoReferenceImage(data: Buffer, mimeType: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clipforge-video-reference-"));
  try {
    const input = join(dir, "input"); await writeFile(input, data);
    const info = await probeMedia(input);
    if (!info.width || !info.height) throw new Error("参考图片损坏或无法读取 / Reference image cannot be decoded");
    if (info.width >= 300 && info.height >= 300) return `data:${mimeType};base64,${data.toString("base64")}`;
    const output = join(dir, "reference.png");
    await exec(ffmpegBin(), ["-nostdin", "-v", "error", "-y", "-i", input, "-vf", VIDEO_REFERENCE_PADDING, "-frames:v", "1", output], { timeout: 30_000 });
    return `data:image/png;base64,${(await readFile(output)).toString("base64")}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

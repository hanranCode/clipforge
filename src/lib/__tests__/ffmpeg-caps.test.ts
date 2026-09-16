import { describe, it, expect, afterEach } from "vitest";
import {
  parseFilterNames,
  optionalFiltersUsed,
  probeFfmpegFilters,
  resolveFfmpegForFilters,
} from "@/lib/ffmpeg-caps";
import { ffmpegBin, setFfmpegBin } from "@/lib/ffmpeg-path";
import { composeErrorMessage } from "@/lib/video-composer/composer";

afterEach(() => setFfmpegBin(undefined));

// real `ffmpeg -filters` output (trimmed): 3-char flag column, name, signature, description
const FILTERS_OUTPUT = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  ..C = Command support
 TS. acompressor      A->A       Audio compressor.
 ... asplit           A->N       Pass on the audio input to N audio outputs.
 T.C drawtext         V->V       Draw text on top of video frames using libfreetype library.
 ... subtitles        V->V       Render text subtitles onto input video using the libass library.
 ..C overlay          VV->V      Overlay a video source on top of the input.
`;

describe("ffmpeg 滤镜能力探测", () => {
  it("解析 -filters 输出为滤镜名集合（跳过表头/图例行）", () => {
    const names = parseFilterNames(FILTERS_OUTPUT);
    expect(names.has("drawtext")).toBe(true);
    expect(names.has("subtitles")).toBe(true);
    expect(names.has("overlay")).toBe(true);
    expect(names.has("Filters:")).toBe(false);
    expect(names.has("=")).toBe(false);
  });

  it("识别滤镜图里实际用到的可选滤镜", () => {
    expect(optionalFiltersUsed("[v0]drawtext=text='hi':x=0:y=0[out]")).toEqual(["drawtext"]);
    expect(optionalFiltersUsed("[vbase]subtitles=/tmp/a.ass[vout]")).toEqual(["subtitles"]);
    expect(optionalFiltersUsed("[0:v]scale=720:-2,format=yuv420p[v]")).toEqual([]);
  });

  it("不把 highpass/lowpass 误判成 ass 滤镜", () => {
    expect(optionalFiltersUsed("[0:a]highpass=f=100,lowpass=f=8000[a]")).toEqual([]);
    expect(optionalFiltersUsed("[0:v]ass=/tmp/a.ass[v]")).toEqual(["ass"]);
  });

  it("没有可选滤镜时直接沿用当前二进制（不做任何探测）", async () => {
    setFfmpegBin("/definitely/missing/ffmpeg");
    await expect(resolveFfmpegForFilters([])).resolves.toBe("/definitely/missing/ffmpeg");
  });

  it("当前二进制缺 drawtext 时切换到内置 ffmpeg-static（全局生效）", async () => {
    setFfmpegBin("/definitely/missing/ffmpeg");
    const bin = await resolveFfmpegForFilters(["drawtext"]);
    expect(bin).not.toBe("/definitely/missing/ffmpeg");
    expect(await probeFfmpegFilters(bin)).toContain("drawtext");
    // 后续同步调用点自动跟随到可用二进制
    expect(ffmpegBin()).toBe(bin);
  });

  it("探测不可用的二进制返回空集合（不抛错）", async () => {
    await expect(probeFfmpegFilters("/definitely/missing/ffmpeg")).resolves.toEqual(new Set());
  });

  it("composeErrorMessage 把 No such filter 映射成可执行的安装提示", () => {
    const msg = composeErrorMessage({ stderr: "[AVFilterGraph @ 0x1] No such filter: 'drawtext'\nError : Filter not found\n" });
    expect(msg).toContain("drawtext");
    expect(msg).toContain("ffmpeg");
    expect(composeErrorMessage({ stderr: "some other failure" })).toBeNull();
  });
});

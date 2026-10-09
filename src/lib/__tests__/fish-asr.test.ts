import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FishAsrError,
  cleanFishText,
  fishAsrErrorPair,
  pcmF32ToWav,
  transcribeChunkWithFish,
  wordsFromFishResponse,
} from "@/lib/fish-asr";
import { FISH_ASR_MODEL_ID, isAsrModel, isFishAsrModel } from "@/lib/local-asr";
import { sanitizeTranscriptDocument } from "@/lib/transcript-editor";

function pcmBuffer(samples: number[]): Buffer {
  return Buffer.from(new Float32Array(samples).buffer);
}

afterEach(() => vi.unstubAllGlobals());

describe("Fish ASR", () => {
  it("encodes mono float PCM as a 16-bit 16 kHz WAV", () => {
    const wav = pcmF32ToWav(new Float32Array([0, 1, -1, 2]));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect([0, 1, 2, 3].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([0, 32767, -32768, 32767]); // clamps > 1
  });

  it("maps word segments into source time and drops markers / bad timings", () => {
    const words = wordsFromFishResponse({
      segments: [
        { text: "这个", start: 0.2, end: 0.5 },
        { text: "<|speaker:0|>", start: 0.5, end: 0.6 },
        { text: "好用", start: 0.6, end: 0.9 },
        { text: "坏", start: 1, end: 1 },
      ],
    }, 300, 1);
    expect(words).toEqual([
      { id: "c2w1", text: "这个", start: 300.2, end: 300.5 },
      { id: "c2w3", text: "好用", start: 300.6, end: 300.9 },
    ]);
    expect(cleanFishText("<|speaker:1|>你好 [laughter] 世界")).toBe("你好 世界");
  });

  it("sends a multipart WAV with the pro model header and returns a cloud transcript chunk", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.model).toBe("transcribe-1-pro");
      expect(headers.Authorization).toBe("Bearer k");
      const form = init.body as FormData;
      expect(form.get("ignore_timestamps")).toBe("false");
      expect(form.get("language")).toBe("zh");
      expect((form.get("audio") as Blob).type).toBe("audio/wav");
      return new Response(JSON.stringify({ text: "这个好用。", segments: [{ text: "这个", start: 0, end: 0.3 }, { text: "好用。", start: 0.3, end: 0.7 }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const doc = await transcribeChunkWithFish({ pcm: pcmBuffer(new Array(16_000).fill(0.2)), apiKey: "k", language: "zh", offsetSeconds: 10, sourceDuration: 20 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(doc.device).toBe("cloud");
    expect(doc.model).toBe(FISH_ASR_MODEL_ID);
    expect(doc.words.map((w) => [w.text, w.start])).toEqual([["这个", 10], ["好用。", 10.3]]);
    expect(doc.segments[0].text).toBe("这个好用。");
    // survives the same sanitizer the checkpoint route runs, keeping the cloud device
    expect(sanitizeTranscriptDocument(doc, 20)?.device).toBe("cloud");
  });

  it("omits language for auto and surfaces HTTP failures as friendly messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.body as FormData).has("language")).toBe(false);
      return new Response("bad key", { status: 401 });
    }));
    const err = await transcribeChunkWithFish({ pcm: pcmBuffer([0, 0]), apiKey: "k", language: "auto" }).catch((e) => e);
    expect(err).toBeInstanceOf(FishAsrError);
    expect(fishAsrErrorPair(err).zh).toContain("API Key");
  });

  it("is an accepted transcript engine alongside the local models", () => {
    expect(isFishAsrModel("fish:transcribe-1-pro")).toBe(true);
    expect(isAsrModel("fish:transcribe-1-pro")).toBe(true);
    expect(isAsrModel("onnx-community/whisper-tiny_timestamped")).toBe(true);
    expect(isAsrModel("fish:other")).toBe(false);
  });
});

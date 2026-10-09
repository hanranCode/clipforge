import { describe, expect, it } from "vitest";
import { asrFailure, parseServerAsrEngine } from "@/lib/asr-server";
import { SENSEVOICE_MODEL_ID, isAsrModel, serverAsrEngine } from "@/lib/local-asr";
import { SenseVoiceModelMissingError, senseVoiceLanguage, wordsFromSenseVoiceTokens } from "@/lib/sensevoice-asr";
import { migrateSettings, type SettingsState } from "@/lib/stores/settings-store";
import { sanitizeTranscriptDevice, segmentsFromWords } from "@/lib/transcript-editor";

// token / timestamp shapes captured from the real SenseVoiceSmall 2024-07-17 int8 model via sherpa-onnx 1.13.8
describe("SenseVoice tokens → transcript words", () => {
  it("one word per CJK character, punctuation glued on, ITN digits kept, source-time offsets", () => {
    const words = wordsFromSenseVoiceTokens({
      tokens: ["开", "放", "时", "间", "早", "上", "9", "点", "。"],
      timestamps: [0.06, 0.24, 0.54, 0.72, 1.2, 1.38, 1.8, 2.1, 2.3],
      segmentStart: 10,
      segmentEnd: 13,
      idPrefix: "c1s1",
    });
    expect(words.map((w) => w.text)).toEqual(["开", "放", "时", "间", "早", "上", "9", "点。"]);
    expect(words[0]).toEqual({ id: "c1s1w1", text: "开", start: 10.06, end: 10.24 });
    expect(words.at(-1)!.start).toBeCloseTo(12.1);
    // sentence end survives so segmentsFromWords can split on it
    expect(segmentsFromWords(words)[0].text).toBe("开放时间早上9点。");
  });

  it("merges SentencePiece pieces into English words on the leading space", () => {
    const words = wordsFromSenseVoiceTokens({
      tokens: ["The", " tri", "bal", " chief", "tain", " called", "."],
      timestamps: [0.06, 0.24, 0.48, 0.78, 1.14, 1.38, 1.6],
      segmentStart: 0,
      segmentEnd: 2,
      idPrefix: "x",
    });
    expect(words.map((w) => w.text)).toEqual(["The", "tribal", "chieftain", "called."]);
    expect(words[1].start).toBeCloseTo(0.24);
    expect(words[1].end).toBeCloseTo(0.78);
  });

  it("caps a word's length so it never swallows the pause before the next one", () => {
    const words = wordsFromSenseVoiceTokens({ tokens: ["好", "的"], timestamps: [0, 3], segmentStart: 0, segmentEnd: 8, idPrefix: "x" });
    expect(words[0].end).toBeCloseTo(0.6);
    expect(words[1].end).toBeCloseTo(3.6);
  });

  it("drops empty tokens and leading punctuation without a word to attach to", () => {
    expect(wordsFromSenseVoiceTokens({ tokens: ["，", " ", "嗯"], timestamps: [0, 0.1, 0.2], segmentStart: 0, segmentEnd: 1, idPrefix: "x" }).map((w) => w.text)).toEqual(["嗯"]);
  });

  it("language hint: only SenseVoice's languages, otherwise auto", () => {
    expect(senseVoiceLanguage("zh")).toBe("zh");
    expect(senseVoiceLanguage("auto")).toBe("auto");
    expect(senseVoiceLanguage("fr")).toBe("auto");
    expect(senseVoiceLanguage(undefined)).toBe("auto");
  });
});

describe("ASR engine wiring", () => {
  it("SenseVoice is a server engine and the default one", () => {
    expect(isAsrModel(SENSEVOICE_MODEL_ID)).toBe(true);
    expect(serverAsrEngine(SENSEVOICE_MODEL_ID)).toBe("sensevoice");
    expect(serverAsrEngine("onnx-community/whisper-tiny_timestamped")).toBeNull();
    expect(parseServerAsrEngine(undefined)).toBe("sensevoice");
    expect(parseServerAsrEngine("fish")).toBe("fish");
    expect(sanitizeTranscriptDevice("cpu")).toBe("cpu");
  });

  it("a missing model maps to 409 model_missing so the client can download it", () => {
    expect(asrFailure(new SenseVoiceModelMissingError())).toMatchObject({ status: 409, code: "model_missing" });
  });

  it("settings v6 migration switches the engine to SenseVoice and keeps the Fish key", () => {
    const migrated = migrateSettings({ asr: { provider: "fish", fishApiKey: "k" } } as unknown as SettingsState, 5);
    expect(migrated.asr).toEqual({ provider: "sensevoice", fishApiKey: "k" });
    const untouched = migrateSettings({ asr: { provider: "fish", fishApiKey: "k" } } as unknown as SettingsState, 6);
    expect(untouched.asr.provider).toBe("fish");
  });
});

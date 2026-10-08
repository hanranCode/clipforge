import { generateSpeech, type TTSConfig } from "@/lib/tts";
import { generateSpeechFree } from "@/lib/edge-tts";

/**
 * The voice a remake re-dubs in: the presenter's voice id on the free Edge engine, or on the paid
 * TTS platform from Settings (same id field — Settings decides which engine reads it).
 */
export type DubVoice = { kind: "free"; voice: string } | { kind: "paid"; config: TTSConfig };

export function parseDubVoice(value: unknown): DubVoice | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "free" && typeof v.voice === "string" && /^[a-zA-Z]{2,3}-[a-zA-Z0-9-]+Neural$/.test(v.voice)) {
    return { kind: "free", voice: v.voice };
  }
  if (v.kind === "paid" && v.config && typeof v.config === "object") {
    const c = v.config as TTSConfig;
    if (c.baseUrl && c.apiKey && c.model && c.voice) return { kind: "paid", config: c };
  }
  return null;
}

export async function synthesizeLine(text: string, voice: DubVoice, context: { scene: string }): Promise<Buffer> {
  return voice.kind === "free" ? generateSpeechFree(text, { voice: voice.voice }) : generateSpeech(text, voice.config, context);
}

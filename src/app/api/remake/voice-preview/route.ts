import "@/lib/api-call-store";
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { synthesizeLine, parseDubVoice } from "@/lib/remake/voice";

export const runtime = "nodejs";

/** POST /api/remake/voice-preview — one line in the chosen presenter voice. body: { text, voice } */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 200) : "";
  const voice = parseDubVoice(body.voice);
  if (!text) return apiError(req, "缺少试听文本", "Missing preview text", 400);
  if (!voice) return apiError(req, "请先为主播设置配音音色", "Set a dubbing voice for the presenter first", 400);
  try {
    const audio = await synthesizeLine(text, voice, { scene: "remake_voice_preview" });
    return new NextResponse(new Uint8Array(audio), { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(req, error instanceof Error ? error.message : "试听失败", "Preview failed", 500);
  }
}

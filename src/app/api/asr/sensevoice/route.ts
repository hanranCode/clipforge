import { NextResponse } from "next/server";
import { senseVoiceModelStatus, startSenseVoiceDownload } from "@/lib/sensevoice-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/asr/sensevoice — local SenseVoice model status (missing / downloading + bytes / ready / error)
 * POST /api/asr/sensevoice — start (or join) the one-time model download, then poll GET
 */
export async function GET() {
  return NextResponse.json(await senseVoiceModelStatus());
}

export async function POST() {
  startSenseVoiceDownload();
  return NextResponse.json(await senseVoiceModelStatus());
}

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { getTTSProviderMeta, type TTSVoiceOption } from "@/lib/tts-presets";

export const runtime = "nodejs";

/** Read the account's full MiniMax catalog; never synthesize audio or persist credentials. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (body?.provider !== "minimax" || typeof body.apiKey !== "string" || !body.apiKey.trim()) {
    return apiError(req, "请先配置 MiniMax API Key", "Configure a MiniMax API key first", 400);
  }
  try {
    const base = typeof body.baseUrl === "string" && body.baseUrl.trim()
      ? body.baseUrl.trim().replace(/\/+$/, "") : getTTSProviderMeta("minimax").baseUrl;
    const url = new URL(`${base}/get_voice`);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid URL");
    if (typeof body.groupId === "string" && body.groupId) url.searchParams.set("GroupId", body.groupId);
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${body.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ voice_type: "all" }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return apiError(req, `MiniMax 音色查询失败（HTTP ${response.status}）`, `MiniMax voice lookup failed (HTTP ${response.status})`, 502);
    const data = await response.json();
    if (data.base_resp?.status_code != null && data.base_resp.status_code !== 0) {
      return apiError(req, `MiniMax 音色查询失败（code=${data.base_resp.status_code}）`, `MiniMax voice lookup failed (code=${data.base_resp.status_code})`, 502);
    }
    const voices = new Map<string, TTSVoiceOption>();
    for (const kind of ["system_voice", "voice_cloning", "voice_generation"] as const) {
      if (!Array.isArray(data[kind])) continue;
      for (const voice of data[kind]) {
        if (typeof voice?.voice_id !== "string" || !voice.voice_id || voices.has(voice.voice_id)) continue;
        const description = Array.isArray(voice.description) ? voice.description.filter((v: unknown) => typeof v === "string").join(" · ") : "";
        voices.set(voice.voice_id, { value: voice.voice_id, label: voice.voice_name || description || voice.voice_id });
      }
    }
    if (!voices.size) return apiError(req, "MiniMax 未返回可用音色", "MiniMax returned no available voices", 502);
    return NextResponse.json({ voices: [...voices.values()] }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return apiError(req, "MiniMax 音色查询失败，请检查 Key 和服务地址后重试", "MiniMax voice lookup failed; check the key and endpoint and retry", 502);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { studioStore } from "@/lib/agent-studio/store";
import { createWork } from "@/lib/agent-studio/engine";
import { body, fail, localRequest, text } from "@/lib/agent-studio/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  try { localRequest(req); studioStore().expireJobs(); return NextResponse.json({ works: studioStore().works() }); } catch(e) { return fail(e); }
}
export async function POST(req: NextRequest) {
  try {
    localRequest(req, true); const b = await body(req);
    const work = await createWork({ assetId: text(b.assetId, 100), runtimeId: text(b.runtimeId, 100), brief: text(b.brief) || "保留商品和演示结构，人物、场景、声音换新。", resolution: b.resolution === "720p" ? "720p" : "480p", voice: b.voice === "male" ? "male" : b.voice === "original" ? "original" : "female" });
    return NextResponse.json({ work }, { status: 201 });
  } catch(e) { return fail(e); }
}

import { NextRequest, NextResponse } from "next/server";
import { studioStore } from "@/lib/agent-studio/store";
import { createWork } from "@/lib/agent-studio/engine";
import { body, fail, localRequest, text } from "@/lib/agent-studio/http";
import { parseStudioVideo } from "@/lib/agent-studio/video-models";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  try { localRequest(req); studioStore().expireJobs(); return NextResponse.json({ works: studioStore().works() }); } catch(e) { return fail(e); }
}
export async function POST(req: NextRequest) {
  try {
    localRequest(req, true); const b = await body(req);
    const work = await createWork({ assetId: text(b.assetId, 100), runtimeId: text(b.runtimeId, 100), brief: text(b.brief) || "参考原片的演示结构与节奏，按所选素材改编商品、人物与场景。", resolution: b.resolution === "1080p" ? "1080p" : b.resolution === "720p" ? "720p" : "480p", voice: b.voice === "male" ? "male" : b.voice === "original" ? "original" : "female", references: b.references, ...(b.video !== undefined && { video: parseStudioVideo(b.video) }) });
    return NextResponse.json({ work }, { status: 201 });
  } catch(e) { return fail(e); }
}

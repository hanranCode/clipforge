import { NextRequest, NextResponse } from "next/server";
import { body, fail, localRequest } from "@/lib/agent-studio/http";
import { aiNodesConfigured } from "@/lib/agent-studio/ai-nodes-client";
import { upscaleCapability } from "@/lib/agent-studio/upscale-options";
import { getServerObjectStorage } from "@/lib/server-object-storage";
import { remakeUpscaleSource, remakeUpscaleTasks, syncRemakeUpscales, upscaleRemake } from "@/lib/remake/super-resolution";
import type { UpscaleAction } from "@/lib/video-upscale";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Context = { params: Promise<{ id: string }> };
function snapshot(id: string) {
  remakeUpscaleSource(id);
  return NextResponse.json({ tasks: remakeUpscaleTasks(id), configured: aiNodesConfigured(), storageConfigured: Boolean(getServerObjectStorage()), capability: upscaleCapability() }, { headers: { "Cache-Control": "no-store" } });
}
export async function GET(req: NextRequest, context: Context) {
  try { localRequest(req); const { id } = await context.params; await syncRemakeUpscales(id); return snapshot(id); }
  catch (error) { return fail(error); }
}
export async function POST(req: NextRequest, context: Context) {
  try {
    localRequest(req, true); const { id } = await context.params, input = await body(req);
    if (Object.keys(input).some(k => !["operation", "parameters", "requestId"].includes(k)) || !["start", "restart", "status", "refresh", "cancel"].includes(String(input.operation)) || input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId))) throw new Error("超分请求无效 / Invalid upscale request");
    await upscaleRemake(id, input.operation as UpscaleAction, input.parameters, input.requestId as string | undefined);
    return snapshot(id);
  } catch (error) { return fail(error); }
}

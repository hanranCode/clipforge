import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { syncCompletedRemakes } from "@/lib/completed-remakes";
import { publishVideoFamily } from "@/lib/publish-variants";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const source = req.nextUrl.searchParams.get("sourceId") || "";
  if (![id, source].every(v => /^[a-zA-Z0-9-]+$/.test(v))) return apiError(req, "无效的成片版本", "Invalid video version", 400);
  try {
    if (source.startsWith("remake-")) syncCompletedRemakes();
    const result = await publishVideoFamily(id, source);
    return result ? NextResponse.json(result, { headers: { "Cache-Control": "no-store" } }) : apiError(req, "成片不存在或尚未完成", "Video is unavailable or not completed", 404);
  } catch {
    return apiError(req, "读取发布视频失败，请重试", "Unable to load publish videos; retry", 500);
  }
}

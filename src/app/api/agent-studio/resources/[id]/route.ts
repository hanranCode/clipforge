import { NextRequest, NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { localRequest, fail } from "@/lib/agent-studio/http";
import { agentResourceFile } from "@/lib/agent-studio/resources";
import { parseRangeHeader } from "@/lib/http-range";
import { fileResponseStream } from "@/lib/file-response-stream";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    localRequest(req); const { id } = await params;
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("NOT_FOUND");
    const { file, resource } = await agentResourceFile(id), size = (await stat(file)).size;
    const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable", ETag: `"${resource.sha256}"`, ...(req.nextUrl.searchParams.get("download") && { "Content-Disposition": `attachment; filename="upscaled-${id}.mp4"` }) };
    if (req.headers.get("if-none-match") === headers.ETag) return new NextResponse(null, { status: 304, headers });
    const range = parseRangeHeader(req.headers.get("range"), size);
    if (range === "unsatisfiable") return new NextResponse(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    if (range) return new NextResponse(fileResponseStream(file, range), { status: 206, headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(range.end - range.start + 1) } });
    return new NextResponse(fileResponseStream(file), { headers: { ...headers, "Content-Length": String(size) } });
  } catch (e) { return fail(e); }
}

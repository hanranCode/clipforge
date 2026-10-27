import { NextRequest, NextResponse } from "next/server";
import { localRequest, fail } from "@/lib/agent-studio/http";
import { serverStorageStatus } from "@/lib/server-object-storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Metadata only: no endpoint accepts an AK/SK configuration upload. */
export function GET(req: NextRequest) {
  try { localRequest(req); return NextResponse.json(serverStorageStatus(), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return fail(e); }
}

import { NextRequest, NextResponse } from "next/server";
import { body, fail, localRequest, text } from "@/lib/agent-studio/http";
import { importableProductions, importProduction } from "@/lib/agent-studio/imports";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) { try { localRequest(req); return NextResponse.json({ productions: await importableProductions() }); } catch(e) { return fail(e); } }
export async function POST(req: NextRequest) { try { localRequest(req, true); const b = await body(req); return NextResponse.json({ work: await importProduction(text(b.id, 80)) }); } catch(e) { return fail(e); } }

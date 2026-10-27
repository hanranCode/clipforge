import { Suspense } from "react";
import { connection } from "next/server";
import AgentWorkDetail from "./work-detail";

/** Query-dependent version selection belongs to the incoming request. */
export default async function AgentWorkPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  return <Suspense fallback={<div className="grid h-64 place-items-center text-sm text-slate-400">Loading…</div>}><AgentWorkDetail params={params} /></Suspense>;
}

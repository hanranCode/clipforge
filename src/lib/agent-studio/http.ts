import { NextRequest, NextResponse } from "next/server";
/** Browser-origin/host guard only. Network isolation is provided by loopback server binding, not these headers. */
export function localRequest(req: NextRequest, mutation = false) {
  const host = req.nextUrl.hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new Error("FORBIDDEN");
  // Next's dev/standalone server may normalize request.url to localhost even when the
  // browser requested 127.0.0.1. Compare Origin with the actual, strictly local Host.
  let publicOrigin = req.nextUrl.origin;
  const hostHeader = req.headers.get("host");
  if (hostHeader) {
    const requested = new URL(`${req.nextUrl.protocol}//${hostHeader}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(requested.hostname) || requested.username || requested.password || requested.pathname !== "/" || requested.search || requested.hash) throw new Error("FORBIDDEN");
    publicOrigin = requested.origin;
  }
  const origin = req.headers.get("origin");
  if (mutation && origin && origin !== publicOrigin) throw new Error("FORBIDDEN");
  if (mutation && req.headers.get("sec-fetch-site") === "cross-site") throw new Error("FORBIDDEN");
}
export async function body(req: NextRequest) {
  const raw = await req.text(); if (raw.length > 512_000) throw new Error("请求内容过大");
  const value = JSON.parse(raw); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求无效");
  return value as Record<string, unknown>;
}
export function fail(e: unknown) {
  const message = e instanceof Error ? e.message : "操作失败";
  const status = message === "UNAUTHORIZED" ? 401 : message === "FORBIDDEN" ? 403 : message === "NOT_FOUND" ? 404 : 400;
  return NextResponse.json({ error: message }, { status });
}
export const text = (v: unknown, max = 3000) => typeof v === "string" ? v.trim().slice(0, max) : "";

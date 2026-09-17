/**
 * Server startup hook (Next.js runs `register` once, before the first request is handled).
 *
 * Its only job today is to install the database-backed recorder for the API call log. The
 * chokepoints that record calls (LLM client factory, media provider factory, TTS) are reachable
 * from client components, so they can only depend on a sink interface — this is where the real
 * implementation gets plugged in on the server. Without it the sink stays a no-op and nothing is
 * logged, so keep this registration alive if the file grows.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("@/lib/api-call-store");
}

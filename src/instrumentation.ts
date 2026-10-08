/**
 * Server startup hook (Next.js runs `register` once, before the first request is handled).
 *
 * Initializes the database-backed recorder for code running in the instrumentation context.
 * Billable call chokepoints also load the recorder in their own route bundles, which Next isolates
 * from this context.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("@/lib/api-call-store");
}

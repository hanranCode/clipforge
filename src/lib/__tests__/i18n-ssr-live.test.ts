// @vitest-environment node
import { describe, expect, it } from "vitest";
import { remake } from "@/lib/i18n/messages/remake";

/**
 * Opt-in check against a running Next dev server:
 * CLIPFORGE_TEST_BASE_URL=http://localhost:3000 node node_modules/vitest/vitest.mjs run src/lib/__tests__/i18n-ssr-live.test.ts
 *
 * Unit tests share one module graph, so they cannot detect an SSR worker retaining
 * an old translation while the browser bundle already contains the new copy.
 * Inspect the actual HTML before hydration has a chance to replace it.
 */
describe.skipIf(!process.env.CLIPFORGE_TEST_BASE_URL)("live remake translation hydration contract", () => {
  it("serves the current source dictionary in its initial HTML", async () => {
    const response = await fetch(new URL("/project/remake", process.env.CLIPFORGE_TEST_BASE_URL), {
      signal: AbortSignal.timeout(20_000),
    });
    expect(response.ok).toBe(true);
    const html = await response.text();
    // Only visible HTML counts; a newer dictionary embedded in a script must not mask stale SSR.
    const visibleHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    for (const key of ["pageSubtitle", "errorNoModel"] as const) {
      expect(visibleHtml.includes(remake.zh[key]), `SSR must serve the current remake.${key} translation`).toBe(true);
    }
  });
});

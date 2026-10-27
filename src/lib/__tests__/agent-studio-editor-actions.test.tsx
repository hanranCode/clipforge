import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));
import { HypitEditorActions } from "@/components/agent-studio/shared";
describe("local project reconnect affordance", () => {
  it("retains a restart action when a previously saved editor URL may be stale", () => { const html = renderToStaticMarkup(<HypitEditorActions url="http://localhost:55555/" busy={false} onStart={() => {}} />); expect(html).toContain('href="http://localhost:55555/"'); expect(html).toContain("hypitRestart"); expect(html).toContain("<button"); });
  it("offers initial startup before any editor URL has been stored", () => { const html = renderToStaticMarkup(<HypitEditorActions busy={false} onStart={() => {}} />); expect(html).toContain("hypitStart"); expect(html).not.toContain("href="); });
});

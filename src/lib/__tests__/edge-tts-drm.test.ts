import { describe, expect, it } from "vitest";
import { generateEdgeTtsToken } from "@/lib/edge-tts-drm";

describe("Edge TTS v2 token", () => {
  it("matches the known Edge Read Aloud v2 token for a fixed five-minute window", async () => {
    const token = await generateEdgeTtsToken(Date.parse("2026-10-13T10:40:00.000Z"));
    expect(token).toBe("492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876");
  });

  it("produces the v2 CS64-SHA256 format", async () => {
    await expect(generateEdgeTtsToken()).resolves.toMatch(/^[A-F0-9]{16}-[A-F0-9]{64}$/);
  });
});

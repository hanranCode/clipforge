import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useTranscribe } from "@/app/project/remake/_components/use-transcribe";

vi.mock("@/lib/stores/settings-store", () => ({ useSettingsStore: (selector: (s: unknown) => unknown) => selector({ asr: { provider: "fish", fishApiKey: "test" } }) }));

afterEach(() => vi.unstubAllGlobals());
it("recognizes audio on the exact video boundaries and clips timestamps to each segment", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const boundaries = [{ start: 0, end: 7.125 }, { start: 7.125, end: 14.5 }];
  const requests: Array<{ start: number; duration: number }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push(body);
    return new Response(JSON.stringify({ segments: [{ start: body.start - 0.2, end: body.start + body.duration + 0.2, text: "一句话" }] }));
  }));
  let hook: ReturnType<typeof useTranscribe>;
  function Harness() { const value = useTranscribe(); useEffect(() => { hook = value; }, [value]); return null; }
  const container = document.createElement("div"); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Harness)));
    let result;
    await act(async () => { result = await hook!.transcribe("/audio.wav", 14.5, boundaries); });
    expect(requests).toMatchObject([{ start: 0, duration: 7.125 }, { start: 7.125, duration: 7.375 }]);
    expect(result).toMatchObject([{ start: 0, end: 7.125 }, { start: 7.125, end: 14.5 }]);
  } finally { await act(async () => root.unmount()); }
});

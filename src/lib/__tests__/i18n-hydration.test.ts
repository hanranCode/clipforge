import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

/**
 * The locale must survive hydration.
 *
 * Pages here are statically prerendered, so their HTML is always DEFAULT_LOCALE — one language for
 * every visitor. The locale itself lives in a localStorage-persisted zustand store that rehydrates
 * while its module is evaluated, i.e. before React hydrates. Those two facts look like they must
 * collide, and if they did, every translated string on every page would report a hydration mismatch
 * and React would throw the tree away.
 *
 * They do not collide, because `useStore` reads `getInitialState()` as its server snapshot
 * (zustand/esm/react.mjs) — the state from BEFORE rehydration — so the hydration render agrees with
 * the HTML by construction, and the persisted locale lands one render later.
 *
 * That guarantee is load-bearing but invisible: it lives in a dependency, and an innocent-looking
 * change on our side (reading `useSettingsStore.getState().locale` instead of subscribing, say)
 * silently breaks it in a way nothing else here would catch. So these tests hydrate for real —
 * `hydrateRoot` against server-rendered HTML, `onRecoverableError` capturing exactly what React
 * would log in the browser — and pin the behaviour rather than the mechanism.
 */

const PERSIST_KEY = "daihuo-jianshou-settings";

/** Load the i18n module fresh, so the settings store rehydrates from whatever localStorage holds. */
async function loadI18n(persistedLocale?: "zh" | "en") {
  localStorage.clear();
  if (persistedLocale) {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ state: { locale: persistedLocale, localeSource: "user" }, version: 5 }),
    );
  }
  const { messages } = await import("@/lib/i18n/messages");
  const { useT } = await import("@/lib/i18n");
  return { messages, useT };
}

/**
 * Server-render a probe, then hydrate that exact HTML, reporting whatever React recovers from.
 * `text` is read after hydration settles, so it reflects the locale the user actually ends up with.
 */
async function hydrateProbe(useT: (ns: string) => (key: string) => string) {
  const Probe = () => createElement("span", null, useT("clone")("refVideoBtn"));
  const html = renderToString(createElement(Probe));

  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);

  const recovered: string[] = [];
  await act(async () => {
    hydrateRoot(container, createElement(Probe), {
      onRecoverableError: (error) => recovered.push(String(error)),
    });
  });
  return { serverHtml: html, recovered, text: container.textContent ?? "" };
}

describe("locale hydration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    // the settings store rehydrates once, at module evaluation — each case needs its own instance
    vi.resetModules();
  });

  it("renders the default locale on the server even when another one is persisted", async () => {
    // the prerendered HTML is built once for everyone — it cannot know this visitor chose English
    const { messages, useT } = await loadI18n("en");
    const { serverHtml } = await hydrateProbe(useT);
    expect(serverHtml).toContain(messages.zh.clone.refVideoBtn);
    expect(serverHtml).not.toContain(messages.en.clone.refVideoBtn);
  });

  it("hydrates an English user without a single mismatch, then switches to English", async () => {
    const { messages, useT } = await loadI18n("en");
    const { recovered, text } = await hydrateProbe(useT);
    // a single entry here means the guarantee above broke: React had to discard and re-render
    expect(recovered).toEqual([]);
    // and the user is not left reading Chinese — the real locale lands one render later
    expect(text).toBe(messages.en.clone.refVideoBtn);
  });

  it("leaves the default-locale user with nothing to recover from and nothing to switch", async () => {
    const { messages, useT } = await loadI18n("zh");
    const { recovered, text } = await hydrateProbe(useT);
    expect(recovered).toEqual([]);
    expect(text).toBe(messages.zh.clone.refVideoBtn);
  });

  it("behaves the same for a visitor with nothing persisted at all", async () => {
    const { messages, useT } = await loadI18n();
    const { recovered, text } = await hydrateProbe(useT);
    expect(recovered).toEqual([]);
    expect(text).toBe(messages.zh.clone.refVideoBtn);
  });
});

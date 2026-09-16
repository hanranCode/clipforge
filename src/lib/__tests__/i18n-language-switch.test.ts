import { describe, it, expect, beforeAll } from "vitest";
import { messages } from "@/lib/i18n/messages";
import { settings } from "@/lib/i18n/messages/settings";
import { LOCALES, detectBrowserLocale, LOCALE_LABELS } from "@/lib/i18n/config";

/**
 * Settings-page language switch: the sidebar toggle can only flip between languages, so once a user
 * had touched it the "follow system" state was unreachable. The settings section exposes all three
 * states; these tests cover the store transitions behind it plus the new copy in both locales.
 */

// The settings store persists through localStorage; some jsdom builds ship without it, so make the
// store importable here regardless of the runner's DOM feature set.
beforeAll(() => {
  if (typeof globalThis.localStorage === "undefined") {
    const mem = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, String(v)),
        removeItem: (k: string) => void mem.delete(k),
        clear: () => mem.clear(),
        key: (i: number) => [...mem.keys()][i] ?? null,
        get length() { return mem.size; },
      },
    });
  }
});

describe("界面语言词条", () => {
  const keys = ["langTitle", "langDesc", "langAuto", "langAutoHint"];

  it("新增词条在 zh/en 都存在", () => {
    for (const k of keys) {
      expect(settings.zh[k], `zh.${k}`).toBeTruthy();
      expect(settings.en[k], `en.${k}`).toBeTruthy();
    }
  });

  it("zh 是中文、en 不含中文（两边用户都不会看到另一种语言）", () => {
    for (const k of keys) {
      expect(/[一-鿿]/.test(settings.zh[k]), `zh.${k}`).toBe(true);
      expect(/[一-鿿]/.test(settings.en[k]), `en.${k}`).toBe(false);
    }
  });

  it("langAutoHint 两种语言都保留 {lang} 插值位", () => {
    expect(settings.zh.langAutoHint).toContain("{lang}");
    expect(settings.en.langAutoHint).toContain("{lang}");
  });

  it("语言切换器每个可选语言都有展示名", () => {
    for (const l of LOCALES) expect(LOCALE_LABELS[l]).toBeTruthy();
  });
});

describe("全量命名空间 zh/en 词条对齐", () => {
  it("没有任何命名空间只翻译了一半（缺的键会回退成另一种语言或键名）", () => {
    const gaps: string[] = [];
    for (const ns of Object.keys(messages.zh)) {
      const zh = Object.keys(messages.zh[ns]);
      const en = Object.keys(messages.en[ns] ?? {});
      for (const k of zh) if (!en.includes(k)) gaps.push(`${ns}.${k} 缺 en`);
      for (const k of en) if (!zh.includes(k)) gaps.push(`${ns}.${k} 缺 zh`);
    }
    expect(gaps).toEqual([]);
  });
});

describe("语言选择状态机", () => {
  it("手动选语言后记为 user（不再被系统语言覆盖）", async () => {
    const { useSettingsStore } = await import("@/lib/stores/settings-store");
    useSettingsStore.getState().setLocale("en");
    expect(useSettingsStore.getState().locale).toBe("en");
    expect(useSettingsStore.getState().localeSource).toBe("user");
  });

  it("选「跟随系统」交回自动判定：立即应用系统语言且 source 回到 auto", async () => {
    const { useSettingsStore } = await import("@/lib/stores/settings-store");
    useSettingsStore.getState().setLocale("en"); // 先钉住
    useSettingsStore.getState().followSystemLocale("zh");
    expect(useSettingsStore.getState().locale).toBe("zh");
    expect(useSettingsStore.getState().localeSource).toBe("auto");
  });

  it("auto 状态下初始化器可继续应用系统语言、不改变 source", async () => {
    const { useSettingsStore } = await import("@/lib/stores/settings-store");
    useSettingsStore.getState().followSystemLocale("zh");
    useSettingsStore.getState().applyAutoLocale("en");
    expect(useSettingsStore.getState().locale).toBe("en");
    expect(useSettingsStore.getState().localeSource).toBe("auto");
  });
});

describe("系统语言判定", () => {
  const withLanguages = (langs: string[]) => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { languages: langs, language: langs[0] },
    });
  };

  it("中文系统 → zh，其他 → en", () => {
    withLanguages(["zh-CN", "en-US"]);
    expect(detectBrowserLocale()).toBe("zh");
    withLanguages(["ja-JP"]);
    expect(detectBrowserLocale()).toBe("en");
    withLanguages(["zh-TW"]);
    expect(detectBrowserLocale()).toBe("zh");
  });
});

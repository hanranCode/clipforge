/**
 * Test environment fixes applied before any test module is imported.
 *
 * Node 26 defines a `localStorage` global of its own that is unavailable unless the process was
 * started with `--localstorage-file`, and being a real global it shadows the Storage jsdom installs
 * on `window`. Anything persisting through zustand therefore fails on the first `setItem` — which
 * is what takes out the whole settings/character/project store suite — and, worse, code that only
 * READS storage silently degrades to "nothing was ever persisted", so a test can pass while
 * asserting nothing at all.
 *
 * An in-memory Storage is the whole of what these tests need: same semantics, no file, no flag.
 */
function installMemoryStorage(): void {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  };
  for (const target of [globalThis, globalThis.window].filter(Boolean)) {
    Object.defineProperty(target, "localStorage", { value: storage, configurable: true, writable: true });
  }
}

installMemoryStorage();

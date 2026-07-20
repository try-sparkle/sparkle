// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { debouncedLocalStorage, PROJECTS_PERSIST_DEBOUNCE_MS } from "./projectStore";

// projectStore persists the WHOLE projects array (each agent up to PROMPT_HISTORY_LIMIT prompts) on
// every mutation; sparkle-pngb wraps localStorage so those writes are trailing-debounced + coalesced.
// These exercise the wrapper directly (jsdom provides a real localStorage) with fake timers.
describe("debouncedLocalStorage (sparkle-pngb)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces a burst of writes into ONE localStorage.setItem after the debounce window", () => {
    // Count real writes by SUBSTITUTING the global `localStorage` with a plain mock, rather than
    // spying on a Storage prototype method. This test previously ping-ponged between environments:
    // spying the instance (`vi.spyOn(localStorage, "setItem")`) recorded 0 calls on Node 22 CI, so it
    // was switched to spying `Storage.prototype` — which then records 0 on Node 26 + jsdom, because
    // there `Object.getPrototypeOf(localStorage)` is `MemoryStorage`, not the global `Storage`, so
    // `localStorage.setItem !== Storage.prototype.setItem` and the prototype spy never fires. A mock
    // that `debouncedLocalStorage` writes through has no dependency on jsdom/Node Storage internals,
    // so it counts coalesced writes correctly on every Node version.
    const store = new Map<string, string>();
    let setItemCalls = 0;
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        setItemCalls += 1;
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    });

    const { storage } = debouncedLocalStorage(PROJECTS_PERSIST_DEBOUNCE_MS);
    storage.setItem("k", "1");
    storage.setItem("k", "2");
    storage.setItem("k", "3");
    // Nothing written yet — the burst is buffered instead of N synchronous main-thread writes.
    expect(setItemCalls).toBe(0);
    expect(localStorage.getItem("k")).toBeNull();

    vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS);
    // Exactly one real write, carrying the LAST value in the burst.
    expect(setItemCalls).toBe(1);
    expect(localStorage.getItem("k")).toBe("3");
  });

  it("flush() writes the pending value synchronously (used before a cross-window broadcast)", () => {
    const { storage, flush } = debouncedLocalStorage(PROJECTS_PERSIST_DEBOUNCE_MS);
    storage.setItem("k", "pending");
    expect(localStorage.getItem("k")).toBeNull(); // still buffered
    flush();
    expect(localStorage.getItem("k")).toBe("pending"); // flushed immediately
  });

  it("getItem reflects REAL localStorage, never this window's un-flushed pending value", () => {
    // Simulate another window having written the shared blob.
    localStorage.setItem("k", "from-window-B");
    const { storage } = debouncedLocalStorage(PROJECTS_PERSIST_DEBOUNCE_MS);
    // This window queues its own (not-yet-flushed) write.
    storage.setItem("k", "local-pending");
    // A rehydrate must see the shared on-disk truth (window B), not our un-observed local edit —
    // otherwise a window could clobber a cross-window change it hasn't absorbed yet.
    expect(storage.getItem("k")).toBe("from-window-B");
  });

  it("removeItem drops any pending write and deletes the key", () => {
    const { storage } = debouncedLocalStorage(PROJECTS_PERSIST_DEBOUNCE_MS);
    localStorage.setItem("k", "on-disk");
    storage.setItem("k", "pending");
    storage.removeItem("k");
    vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS);
    // The dropped pending write must not resurrect the key after removal.
    expect(localStorage.getItem("k")).toBeNull();
  });
});

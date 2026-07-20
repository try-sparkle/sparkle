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

  it("skips a redundant write when disk already holds a byte-identical value (sparkle-noop-persist)", () => {
    // The projects blob is re-persisted on many mutations that don't change its serialized form, so
    // the same string was written to localStorage repeatedly. Substitute a counting mock and confirm
    // a flush whose value already matches disk performs NO real setItem.
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
    storage.setItem("k", "same");
    vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS);
    expect(setItemCalls).toBe(1); // first write lands

    // A subsequent persist of the identical value must not touch localStorage again.
    storage.setItem("k", "same");
    vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS);
    expect(setItemCalls).toBe(1); // still one — the no-op was elided

    // A genuinely changed value is still written.
    storage.setItem("k", "changed");
    vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS);
    expect(setItemCalls).toBe(2);
    expect(localStorage.getItem("k")).toBe("changed");
  });

  it("does NOT skip when another window changed disk after our last write (cross-window safe)", () => {
    // The skip compares against LIVE localStorage, so a value that merely equals what WE last wrote
    // is still re-written if disk has since diverged — otherwise a window could fail to persist its
    // own state over a cross-window change it hasn't absorbed.
    const { storage } = debouncedLocalStorage(PROJECTS_PERSIST_DEBOUNCE_MS);
    storage.setItem("k", "ours");
    vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS);
    expect(localStorage.getItem("k")).toBe("ours");

    // Another window overwrites the shared blob.
    localStorage.setItem("k", "from-window-B");
    // We persist "ours" again; because disk now holds a different value, the write must happen.
    storage.setItem("k", "ours");
    vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS);
    expect(localStorage.getItem("k")).toBe("ours");
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

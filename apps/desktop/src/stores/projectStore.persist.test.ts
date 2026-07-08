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
  });

  it("coalesces a burst of writes into ONE localStorage.setItem after the debounce window", () => {
    // Spy on Storage.prototype, NOT the localStorage instance. `setItem` is an inherited prototype
    // method, not an own property of the instance; `vi.spyOn(localStorage, "setItem")` only patches
    // the instance and, on some jsdom/Node builds (e.g. Node 22 in CI), the real prototype method is
    // still what runs — so the write succeeds but the instance spy records 0 calls, failing this
    // assertion in CI while passing on other Node versions. Spying the prototype is version-robust.
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    const { storage } = debouncedLocalStorage(PROJECTS_PERSIST_DEBOUNCE_MS);
    storage.setItem("k", "1");
    storage.setItem("k", "2");
    storage.setItem("k", "3");
    // Nothing written yet — the burst is buffered instead of N synchronous main-thread writes.
    expect(setSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem("k")).toBeNull();

    vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS);
    // Exactly one real write, carrying the LAST value in the burst.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("k")).toBe("3");
    setSpy.mockRestore();
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

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useHelperPrefs, HELPER_PREFS_KEY } from "./helperPrefs";

const DEFAULTS = { enabled: true, mode: "island", x: null, y: null, edge: "right" };

function reset() {
  localStorage.clear();
  useHelperPrefs.setState(DEFAULTS as never);
}

describe("helperPrefs", () => {
  beforeEach(reset);

  it("defaults to an enabled island with no remembered position", () => {
    const s = useHelperPrefs.getState();
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe("island");
    expect(s.x).toBeNull();
    expect(s.y).toBeNull();
  });

  it("setEnabled(false) records the hidden preference", () => {
    useHelperPrefs.getState().setEnabled(false);
    expect(useHelperPrefs.getState().enabled).toBe(false);
  });

  it("setMode switches between island and tab", () => {
    useHelperPrefs.getState().setMode("tab");
    expect(useHelperPrefs.getState().mode).toBe("tab");
    useHelperPrefs.getState().setMode("island");
    expect(useHelperPrefs.getState().mode).toBe("island");
  });

  it("setPosition records both coordinates", () => {
    useHelperPrefs.getState().setPosition(120, 340);
    expect(useHelperPrefs.getState()).toMatchObject({ x: 120, y: 340 });
  });

  it("setEdge records the docked edge", () => {
    useHelperPrefs.getState().setEdge("left");
    expect(useHelperPrefs.getState().edge).toBe("left");
  });

  it("writes through to localStorage under the shared key", () => {
    useHelperPrefs.getState().setMode("tab");
    const raw = localStorage.getItem(HELPER_PREFS_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.mode).toBe("tab");
  });

  // The main window's "Show Helper" is the ONLY way back after Hide Helper, and it lives in a
  // DIFFERENT webview from the island. zustand's persist writes localStorage but does not listen
  // to it, so without the storage-event bridge that button would appear to do nothing.
  it("rehydrates when another webview writes the shared key", async () => {
    useHelperPrefs.getState().setEnabled(false);
    expect(useHelperPrefs.getState().enabled).toBe(false);

    // Simulate the OTHER webview writing, then the browser delivering its storage event here.
    localStorage.setItem(
      HELPER_PREFS_KEY,
      JSON.stringify({ state: { ...DEFAULTS, enabled: true }, version: 0 }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: HELPER_PREFS_KEY }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useHelperPrefs.getState().enabled).toBe(true);
  });

  it("ignores storage events for unrelated keys", async () => {
    useHelperPrefs.getState().setEnabled(false);
    localStorage.setItem("sparkle-ui", JSON.stringify({ state: {}, version: 0 }));
    window.dispatchEvent(new StorageEvent("storage", { key: "sparkle-ui" }));
    await Promise.resolve();
    expect(useHelperPrefs.getState().enabled).toBe(false);
  });
});

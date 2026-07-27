// Persisted preferences for the floating helper island.
//
// Deliberately a separate zustand record from `sparkle-ui`: the helper webview hydrates this on
// every launch, and keeping it small means the island's first paint doesn't wait on (or risk
// tripping over) the main app's much larger UI state blob.
//
// Both webviews share an origin, so they share this localStorage record — that is how the main
// window's "Show Helper" button re-enables an island living in a different JS context.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Edge } from "./helperGeometry";

export type HelperMode = "island" | "tab";

export const HELPER_PREFS_KEY = "sparkle-helper";

export interface HelperPrefsState {
  /** False after right-click → Hide Helper. Survives restart (spec §2). */
  enabled: boolean;
  mode: HelperMode;
  /** Null until the user first drags it — the island then opens at its default corner. */
  x: number | null;
  y: number | null;
  /** Which edge the pull tab last docked to. */
  edge: Edge;
  setEnabled: (v: boolean) => void;
  setMode: (m: HelperMode) => void;
  setPosition: (x: number, y: number) => void;
  setEdge: (e: Edge) => void;
}

export const useHelperPrefs = create<HelperPrefsState>()(
  persist(
    (set) => ({
      enabled: true,
      mode: "island",
      x: null,
      y: null,
      edge: "right",
      setEnabled: (enabled) => set({ enabled }),
      setMode: (mode) => set({ mode }),
      setPosition: (x, y) => set({ x, y }),
      setEdge: (edge) => set({ edge }),
    }),
    {
      name: HELPER_PREFS_KEY,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

// Cross-webview sync. zustand's `persist` WRITES to localStorage but does not listen to it, and a
// store instance is per-webview — so without this, the main window's "Show Helper" would flip
// `enabled` in its own copy and the helper webview would never find out. That is not a corner
// case: Show Helper is the ONLY way back after Hide Helper, so it would appear to do nothing.
//
// The `storage` event fires only in OTHER documents of the same origin, which is exactly the
// signal we want — the writer already has the new state.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== HELPER_PREFS_KEY) return;
    void useHelperPrefs.persist.rehydrate();
  });
}

// Persisted preferences for the floating helper island.
//
// Deliberately a separate zustand record from `sparkle-ui`: the helper webview hydrates this on
// every launch, and keeping it small means the island's first paint doesn't wait on (or risk
// tripping over) the main app's much larger UI state blob.
//
// Both webviews share an origin, so they share this localStorage record.
//
// `enabled` IS BACK, and the reason it is safe this time is the only thing worth remembering here.
// It was removed in §6 because the island's right-click "Hide Helper" wrote it and a "Show Helper"
// button in the main window's sidebar was the ONLY way to clear it — a one-way door the moment that
// button moved, was redesigned away, or simply wasn't found. The sidebar button is gone for good.
// The way back now lives in the NATIVE MENU BAR ("View → Hide/Show Helper", src-tauri/app_menu.rs),
// which is always present and cannot itself be hidden, so a persisted hide can no longer strand
// anyone. That is what makes this a preference again rather than a latch.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Edge } from "./helperGeometry";

export type HelperMode = "island" | "tab";

export const HELPER_PREFS_KEY = "sparkle-helper";

/**
 * Bumped from 0 (implicit) when `enabled` was reintroduced.
 *
 * §6 deleted `enabled` from the type and the initial state but left every persisted record alone,
 * so an installation that had used the old Hide Helper still carries `enabled: false` — which
 * `persist` merges back on every hydrate as an unread extra key. Reintroducing the field would have
 * made that stale value LOAD-BEARING again: the island would come back hidden on upgrade, from a
 * click the user made in a different version of the app and has no reason to remember.
 *
 * The policy is deliberately "everyone starts visible": the migration DROPS any pre-existing
 * `enabled`, so the initial `true` wins, and only a hide performed after this change persists.
 * Discarding one user's old preference is strictly better than silently hiding the island for
 * anyone who ever tried the old feature.
 */
export const HELPER_PREFS_VERSION = 1;

export interface HelperPrefsState {
  /** False after right-click → Hide Helper, or the native View menu's toggle. Survives restart. */
  enabled: boolean;
  mode: HelperMode;
  /** Null until the user first drags it — the island then opens at its default corner. */
  x: number | null;
  y: number | null;
  /** Which edge the pull tab last docked to. */
  edge: Edge;
  setEnabled: (v: boolean) => void;
  /** The native menu item's action. A toggle rather than a setter because the menu handler runs in
   *  Rust and cannot read this store — it can only say "flip it", and the store stays authoritative. */
  toggleEnabled: () => void;
  setMode: (m: HelperMode) => void;
  setPosition: (x: number, y: number) => void;
  setEdge: (e: Edge) => void;
}

/** Drop a pre-`HELPER_PREFS_VERSION` `enabled` so every install starts visible on upgrade. Exported
 *  for the test — the collision it prevents only exists in records written by an older build, which
 *  is exactly the state that cannot be reached by driving the current one. */
export function migrateHelperPrefs(persisted: unknown, version: number): unknown {
  if (version >= HELPER_PREFS_VERSION) return persisted;
  if (!persisted || typeof persisted !== "object") return persisted;
  const next = { ...(persisted as Record<string, unknown>) };
  delete next.enabled;
  return next;
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
      toggleEnabled: () => set((s) => ({ enabled: !s.enabled })),
      setMode: (mode) => set({ mode }),
      setPosition: (x, y) => set({ x, y }),
      setEdge: (edge) => set({ edge }),
    }),
    {
      name: HELPER_PREFS_KEY,
      storage: createJSONStorage(() => localStorage),
      version: HELPER_PREFS_VERSION,
      migrate: (persisted, version) =>
        migrateHelperPrefs(persisted, version) as HelperPrefsState,
    },
  ),
);

// Cross-webview sync. zustand's `persist` WRITES to localStorage but does not listen to it, and a
// store instance is per-webview — so a document that writes this record leaves every other one
// holding a stale copy until it reloads. That is not hypothetical for `enabled`: the native View
// menu's toggle is handled in the HELPER webview, and the main window shares this record.
//
// The `storage` event fires only in OTHER documents of the same origin, which is exactly the
// signal we want — the writer already has the new state.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== HELPER_PREFS_KEY) return;
    void useHelperPrefs.persist.rehydrate();
  });
}

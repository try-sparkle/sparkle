// uiStore — small persisted UI preferences (not project/agent data). Currently just the
// composer height, so the size you drag it to sticks across tabs and relaunches.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const COMPOSER_MIN = 64;
// Tall enough that, as a bottom overlay, the composer covers Claude's terminal input box
// at rest — so the user always types here, never into the terminal underneath.
export const COMPOSER_DEFAULT = 128;

// Terminal text-size factor (Cmd +/- and the ⋯ menu "Text size"). Applied as a multiplier
// on the terminal font size only (see Terminal.tsx), so the text scales while the UI chrome
// — sidebar, top bar, buttons — stays fixed. Stepped + clamped to sane bounds.
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.8;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1.0;
// Round to 2dp so repeated +/- steps don't drift into float noise (0.7000000001).
const clampZoom = (z: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

// Theme preference. Lives here (not theme/theme.ts) so theme.ts can import it without a
// circular dependency — theme.ts depends on the store, never the reverse.
export type ThemePref = "auto" | "light" | "dark";

interface UiState {
  composerHeight: number;
  setComposerHeight: (h: number) => void;
  zoom: number;
  setZoom: (z: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  // Which special (non-project) agent is in focus, if any. "sparkle" = the self-improvement
  // agent pinned bottom-left. null = a normal project agent (or nothing) is active. Persisted so
  // the active view survives relaunch. Selecting a normal agent clears this back to null.
  activeSpecial: "sparkle" | null;
  setActiveSpecial: (v: "sparkle" | null) => void;
  // App theme preference. "auto" follows the OS appearance; "light"/"dark" force it.
  // Persisted in the same `sparkle-ui` blob; read synchronously at boot (see theme/theme.ts)
  // to set <html data-theme> before first paint and avoid a flash of the wrong theme.
  themePref: ThemePref;
  setThemePref: (v: ThemePref) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      composerHeight: COMPOSER_DEFAULT,
      setComposerHeight: (h) => set({ composerHeight: Math.max(COMPOSER_MIN, h) }),
      zoom: ZOOM_DEFAULT,
      setZoom: (z) => set({ zoom: clampZoom(z) }),
      zoomIn: () => set((s) => ({ zoom: clampZoom(s.zoom + ZOOM_STEP) })),
      zoomOut: () => set((s) => ({ zoom: clampZoom(s.zoom - ZOOM_STEP) })),
      resetZoom: () => set({ zoom: ZOOM_DEFAULT }),
      activeSpecial: null,
      setActiveSpecial: (v) => set({ activeSpecial: v }),
      themePref: "auto",
      setThemePref: (v) => set({ themePref: v }),
    }),
    { name: "sparkle-ui", storage: createJSONStorage(() => localStorage) },
  ),
);

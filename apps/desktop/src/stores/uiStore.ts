// uiStore — small persisted UI preferences (not project/agent data). Currently just the
// composer height, so the size you drag it to sticks across tabs and relaunches.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { migratePersistedUi } from "./composerPersist";

export const COMPOSER_MIN = 64;
// The rest height: tall enough that, as a bottom overlay, the composer just covers Claude's
// terminal input line — so the user types here by default, never into the terminal beneath.
// Drag-snaps land here (see composerDrag.ts), so it doubles as the restore target.
export const COMPOSER_SNAP = 72;
export const COMPOSER_DEFAULT = COMPOSER_SNAP;
// Slim bar shown when minimized: enough for the grab handle + a "bring it back" hint, while
// the terminal input underneath is fully exposed for answering Claude's menus.
export const COMPOSER_BAR = 22;
// Drag tuning (shared with composerDrag.ts via the Composer): a magnet around the snap
// height, the raw height a downward drag must reach to minimize, and the upward distance
// needed to restore from the minimized bar.
export const COMPOSER_SNAP_THRESHOLD = 24;
export const COMPOSER_MINIMIZE_THRESHOLD = 40;
export const COMPOSER_RESTORE_THRESHOLD = 24;

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

// Sidebar agent ordering. "attention" reorders the top-level agent stack so the agents
// that need you (red — waiting/approval) float to the top and happily-building ones sink
// down (see engine/agentOrdering.ts). "manual" keeps insertion order, like before this
// feature. Default is "attention" — reordering is the out-of-the-box behavior.
export type AgentOrdering = "attention" | "manual";

interface UiState {
  composerHeight: number;
  setComposerHeight: (h: number) => void;
  // Whether the composer is tucked into its slim bar (terminal input exposed). Persisted
  // globally so it stays minimized across every agent tab and across relaunch, until the
  // user brings it back. composerHeight remembers the open size to restore to.
  composerMinimized: boolean;
  setComposerMinimized: (v: boolean) => void;
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
  // Sidebar agent ordering preference (see AgentOrdering). Persisted in `sparkle-ui`.
  agentOrdering: AgentOrdering;
  setAgentOrdering: (v: AgentOrdering) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      composerHeight: COMPOSER_DEFAULT,
      setComposerHeight: (h) => set({ composerHeight: Math.max(COMPOSER_MIN, h) }),
      composerMinimized: false,
      setComposerMinimized: (v) => set({ composerMinimized: v }),
      zoom: ZOOM_DEFAULT,
      setZoom: (z) => set({ zoom: clampZoom(z) }),
      zoomIn: () => set((s) => ({ zoom: clampZoom(s.zoom + ZOOM_STEP) })),
      zoomOut: () => set((s) => ({ zoom: clampZoom(s.zoom - ZOOM_STEP) })),
      resetZoom: () => set({ zoom: ZOOM_DEFAULT }),
      activeSpecial: null,
      setActiveSpecial: (v) => set({ activeSpecial: v }),
      themePref: "auto",
      setThemePref: (v) => set({ themePref: v }),
      agentOrdering: "attention",
      setAgentOrdering: (v) => set({ agentOrdering: v }),
    }),
    {
      name: "sparkle-ui",
      storage: createJSONStorage(() => localStorage),
      // v1: the rest height shrank from 128 to the compact COMPOSER_SNAP. The pure
      // migratePersistedUi resets only users still parked on the OLD default, preserving a
      // height anyone deliberately dragged to. (composerMinimized hydrates from its default
      // via the usual shallow merge — no migration needed for the new field.)
      version: 1,
      migrate: (persisted, version) =>
        migratePersistedUi(persisted as Record<string, unknown>, version, COMPOSER_SNAP) as unknown as UiState,
    },
  ),
);

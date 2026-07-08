// uiStore — small persisted UI preferences (not project/agent data). Currently just the
// composer height, so the size you drag it to sticks across tabs and relaunches.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { migratePersistedUi } from "./composerPersist";

// Settings-dialog category ids. Defined HERE (not SettingsDialog.tsx) so the store never depends
// on a component file — SettingsDialog imports and re-exports it for its own consumers.
export type CategoryId =
  | "ai"
  | "credits"
  | "notifications"
  | "appearance"
  | "shortcuts"
  | "workers"
  | "accounts"
  | "mobile"
  | "voice"
  | "advanced";

export const COMPOSER_MIN = 64;
// Smallest usable textarea height (≈ one line + its vertical padding). Used as the floor's
// reserved input space when screenshot thumbnails push the composer's chrome taller, so an
// attachment can never squeeze the input box to a sliver. See resolveComposerFloor.
export const COMPOSER_MIN_TEXTAREA = 36;
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

// Sidebar workflow mode — which of the Think / Plan / Build chevrons is active. Lifted out of
// AgentSidebar's local state into the store so other components (e.g. ThinkPanel's "Make a Plan"
// button) can switch tabs by calling setWorkMode. Deliberately NOT persisted (see partialize) so
// it defaults to "build" on every launch, exactly as the old local useState default did.
export type WorkMode = "think" | "plan" | "build";

interface UiState {
  composerHeight: number;
  setComposerHeight: (h: number) => void;
  // Whether the user has hand-sized the composer by dragging the handle to a real height
  // (anything other than the snap rest). When true, composerHeight is the composer's ACTUAL
  // height (the textarea scrolls past it) instead of just a floor the draft can grow above —
  // that's what lets the handle drag the box SHORTER than its content, not only taller.
  // Dragging back to the snap rest clears it, re-enabling auto-grow. Persisted so the choice
  // survives relaunch. (Existing users default to false and flip true on their next resize.)
  composerUserSized: boolean;
  setComposerUserSized: (v: boolean) => void;
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
  // Which special (non-project) view is in focus, if any. "sparkle" = the self-improvement
  // agent pinned bottom-left. "board" = the read-only Tasks Kanban for the current project.
  // null = a normal project agent (or nothing) is active. Persisted so the active view survives
  // relaunch. Selecting a normal agent clears this back to null.
  activeSpecial: "sparkle" | "board" | null;
  setActiveSpecial: (v: "sparkle" | "board" | null) => void;
  // App theme preference. "auto" follows the OS appearance; "light"/"dark" force it.
  // Persisted in the same `sparkle-ui` blob; read synchronously at boot (see theme/theme.ts)
  // to set <html data-theme> before first paint and avoid a flash of the wrong theme.
  themePref: ThemePref;
  setThemePref: (v: ThemePref) => void;
  // Sidebar agent ordering preference (see AgentOrdering). Persisted in `sparkle-ui`.
  agentOrdering: AgentOrdering;
  setAgentOrdering: (v: AgentOrdering) => void;
  // Active sidebar workflow mode (Think/Plan/Build chevrons). Shared so non-sidebar components can
  // switch tabs. NOT persisted (see partialize) — resets to "build" each launch like the old local state.
  workMode: WorkMode;
  setWorkMode: (m: WorkMode) => void;
  // One-shot "open this bead's detail when the board shows it" handoff (spec §8: clicking an
  // orchestrator's epic pill jumps to the Plan board with that epic's DetailOverlay open). Set by
  // the pill, consumed-then-cleared by BoardView once the bead is present. Transient — NOT persisted.
  boardFocusBeadId: string | null;
  setBoardFocusBeadId: (id: string | null) => void;
  // Whether ANY "+ New Build Agent" button is currently hovered. Shared so hovering the empty-state
  // start button on the Workspace also lights up the sidebar's button blue (and vice versa),
  // pointing the user at where that affordance normally lives. Transient — NOT persisted.
  buildAgentHover: boolean;
  setBuildAgentHover: (v: boolean) => void;
  // Per build-agent: whether its worker subtree is collapsed in the sidebar. A build agent's
  // workers start COLLAPSED (a missing entry reads as collapsed) so a busy orchestrator shows a
  // compact "N workers" roll-up by default; the user expands to see each worker's own tracker.
  // Keyed by the build agent's id; persisted so the choice survives relaunch.
  collapsedOrchestrators: Record<string, boolean>;
  isOrchestratorCollapsed: (id: string) => boolean;
  toggleOrchestratorCollapsed: (id: string) => void;
  // Deep-open request for the ⋯ settings dialog: a component anywhere (e.g. BalanceBadge) asks
  // for a category; TopBar (which owns the dialog) opens it there and clears the request on
  // close. Transient — NOT persisted (see partialize), a relaunch must never restore a dialog.
  settingsRequest: CategoryId | null;
  openSettings: (cat: CategoryId) => void;
  clearSettingsRequest: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      composerHeight: COMPOSER_DEFAULT,
      setComposerHeight: (h) => set({ composerHeight: Math.max(COMPOSER_MIN, h) }),
      composerUserSized: false,
      setComposerUserSized: (v) => set({ composerUserSized: v }),
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
      workMode: "build",
      setWorkMode: (m) => set({ workMode: m }),
      boardFocusBeadId: null,
      setBoardFocusBeadId: (id) => set({ boardFocusBeadId: id }),
      buildAgentHover: false,
      setBuildAgentHover: (v) => set({ buildAgentHover: v }),
      collapsedOrchestrators: {},
      // Absent → collapsed (workers start hidden behind the roll-up).
      isOrchestratorCollapsed: (id) => get().collapsedOrchestrators[id] ?? true,
      toggleOrchestratorCollapsed: (id) =>
        set((s) => {
          const cur = s.collapsedOrchestrators[id] ?? true;
          return { collapsedOrchestrators: { ...s.collapsedOrchestrators, [id]: !cur } };
        }),
      settingsRequest: null,
      openSettings: (cat) => set({ settingsRequest: cat }),
      clearSettingsRequest: () => set({ settingsRequest: null }),
    }),
    {
      name: "sparkle-ui",
      storage: createJSONStorage(() => localStorage),
      // Persist everything EXCEPT workMode, buildAgentHover, boardFocusBeadId, and
      // settingsRequest, so the active sidebar tab resets to "build" on each launch (matching
      // the prior local-useState default) and the transient hover flag / one-shot board-focus
      // handoff / one-shot settings deep-open never persist, while every other UI preference
      // still sticks. Spreading `rest` keeps all existing persisted keys.
      partialize: ({
        workMode: _workMode,
        buildAgentHover: _buildAgentHover,
        boardFocusBeadId: _boardFocusBeadId,
        settingsRequest: _settingsRequest,
        ...rest
      }) => rest,
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

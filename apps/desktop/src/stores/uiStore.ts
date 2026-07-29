// uiStore — small persisted UI preferences (not project/agent data). Currently just the
// composer height, so the size you drag it to sticks across tabs and relaunches.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { migratePersistedUi } from "./composerPersist";
import type { Runtime } from "../types";
// TYPE-ONLY import, deliberately: engine/buildSections → engine/workflowStage → theme/colors, and
// theme/theme.ts imports THIS store. A value import would close that loop into a runtime cycle; a
// type import is erased at compile time, so it can't. The default below is spelled inline for the
// same reason (rather than calling allBandsVisible()).
import type { StatusBand } from "../engine/buildSections";
import { assignToSide, pruneAssignment, type PairSide } from "../engine/pairs";

// Settings-dialog category ids. Defined HERE (not SettingsDialog.tsx) so the store never depends
// on a component file — SettingsDialog imports and re-exports it for its own consumers.
export type CategoryId =
  | "ai"
  | "tools"
  | "credits"
  | "spend"
  | "notifications"
  | "appearance"
  | "shortcuts"
  | "workers"
  | "accounts"
  | "cloudauth"
  | "onepassword"
  | "mobile"
  | "voice"
  | "approvals"
  | "conciergetools"
  | "conciergevoice"
  | "advanced";

/** Keys that must never round-trip through the persisted blob — in EITHER direction. `partialize`
 *  uses this shape on the write side and `merge` deletes them on the read side; a key present in one
 *  place and missing from the other is how a transient flag comes back to life on the next launch. */
const TRANSIENT_UI_KEYS = [
  "workMode",
  "buildAgentHover",
  "boardFocusBeadId",
  "settingsRequest",
  "composeFocusSeq",
  "revealAgentId",
  "newAgentRuntime",
  "cloudCreateOpen",
  "zeroCreditBannerDismissed",
  "zeroCreditBannerDismissedFor",
] as const satisfies readonly (keyof UiState)[];

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

/**
 * How long a "scroll this agent's row into view" request stays live before it expires.
 *
 * WHY IT NEEDS ONE AT ALL (roborev 53784). The request is cleared by the row that matches it —
 * but that row is NOT guaranteed to mount. The status filter bar can hide the new agent's band,
 * `mode === "plan"` renders no list, the project can be switched or closed, and removing the agent
 * doesn't clear the request either. Without a deadline the id simply sits there for the rest of
 * the session and then fires at an ARBITRARY later moment — the user re-enables a filter band,
 * flips back to Build, or reopens the project, and the column yanks to a row nobody asked to see.
 *
 * A deadline covers every one of those escape hatches with one mechanism, rather than teaching the
 * store about removals, project lifecycle and selection. Five seconds is far longer than the real
 * window: the spawn adds the agent and the sidebar re-renders in the same tick, so a row that is
 * going to mount has mounted. Past that the user has moved on, and moving their column is wrong.
 */
export const REVEAL_REQUEST_TTL_MS = 5000;

/** The live expiry, if any. Module state rather than store state: it is a scheduling detail, and
 *  putting a timer id in the store would persist/serialize something meaningless. */
let revealExpiryTimer: ReturnType<typeof setTimeout> | null = null;
function cancelRevealExpiry(): void {
  if (revealExpiryTimer !== null) {
    clearTimeout(revealExpiryTimer);
    revealExpiryTimer = null;
  }
}

// Theme preference. Lives here (not theme/theme.ts) so theme.ts can import it without a
// circular dependency — theme.ts depends on the store, never the reverse.
export type ThemePref = "auto" | "light" | "dark";

// NOTE: `AgentOrdering` ("attention" | "manual") was REMOVED here. The Build column no longer
// sorts rows by live status at all — rows are grouped into the workflow-stage ladder
// (engine/buildSections.ts) and ordered WITHIN a stage by the user's own drag arrangement. There
// is nothing left for the preference to select between, so the setting and its toggle are gone.
// The persisted `agentOrdering` key is dropped by the v2 migration below.

// NOTE: `AttentionTier` ("p0" | "p1") was REMOVED here along with `attentionTierFocus`. The helper
// island's chiclets used to set their own filter state, which the sidebar then applied on top of
// its own — two independent stores both answering "which rows does the Build column show". The
// chiclets now call `isolateStatusBand`, so their effect lands in the SAME `statusFilter` the chips
// render: clicking one is visibly a filter, and clearing it is the ordinary "Show all".

// Sidebar workflow mode — which of the Plan / Build chevrons is active. Lifted out of
// AgentSidebar's local state into the store so other components can switch tabs by calling
// setWorkMode. Deliberately NOT persisted (see partialize) so it defaults to "build" on every
// launch, exactly as the old local useState default did.
export type WorkMode = "plan" | "build";

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
  // Which status bands the Build column currently SHOWS (the "Need you / Running / Done" filter
  // chips above the stage ladder). All three start on; clicking a chip toggles its rows out of the
  // column. Persisted, so the focus you chose survives a relaunch — this is a deliberate view
  // preference, not a transient one. A section left with no visible rows hides entirely, so
  // filtering never leaves empty headers behind (see engine/buildSections.groupAgentsByStage).
  //
  // Turning ALL THREE off is allowed and shows an empty column with an explanatory hint. We do NOT
  // silently re-arm the last chip: a user who clicked three times meant it, and a filter that
  // refuses to reach its stated state is worse than an empty list that explains itself.
  // The height the user DRAGGED the concierge compose box to, or null when they never have (the
  // box auto-grows with its content instead — see engine/composeBoxHeight).
  //
  // Persisted, and separate from `composerHeight` on purpose: that one belongs to the agent-pane
  // composer, whose drag CLAMPS to its cap. This box's drag may EXCEED its cap — the reason to grab
  // the handle is to see more than ten lines — so one field serving both would need a flag at the
  // exact point the two disagree.
  conciergeComposeH: number | null;
  setConciergeComposeH: (h: number | null) => void;
  statusFilter: Record<StatusBand, boolean>;
  toggleStatusBand: (b: StatusBand) => void;
  showAllStatusBands: () => void;
  /** Show ONLY this band — the helper island's chiclets. Writes the same `statusFilter` the chips
   *  render, so the resulting state is visible and clearable exactly like a hand-toggled one. */
  isolateStatusBand: (b: StatusBand) => void;
  // Active sidebar workflow mode (Plan/Build chevrons). Shared so non-sidebar components can
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
  // Which runtime the NEXT agent you create runs on: "local" (a PTY on this Mac, free) or "cloud"
  // (a Sparkle-provisioned sandbox, billed in credits). Shared so the sidebar's toggle and the
  // Workspace empty-state button agree. Transient — NOT persisted: cloud is a per-account server
  // capability that can go away between launches, and a persisted "cloud" would silently re-arm a
  // billed action for a user who no longer has it. Every launch starts on the free default.
  newAgentRuntime: Runtime;
  setNewAgentRuntime: (r: Runtime) => void;
  // Whether the "new cloud agent" dialog is open. Lives here (not in a component) because the
  // "+ New Build Agent" affordance exists in two places (sidebar + Workspace empty state) while the
  // dialog must be rendered exactly ONCE. Transient — NOT persisted; a relaunch never restores a
  // dialog, least of all one whose action costs credits.
  cloudCreateOpen: boolean;
  setCloudCreateOpen: (v: boolean) => void;
  // Per build-agent: whether its worker subtree is collapsed in the sidebar. A build agent's
  // workers start COLLAPSED (a missing entry reads as collapsed) so a busy orchestrator shows a
  // compact "N workers" roll-up by default; the user expands to see each worker's own tracker.
  // Keyed by the build agent's id; persisted so the choice survives relaunch.
  collapsedOrchestrators: Record<string, boolean>;
  // Which of the currently-expanded orchestrators were expanded BY THE APP rather than by the user's
  // chevron — the mark that makes auto-collapse safe. `collapsedOrchestrators` alone cannot answer
  // "may I close this again?": it records the state, not who chose it, so closing on that record
  // would also close the subtree the user deliberately opened. Set by `expandOrchestrators` (only
  // for ids that were actually closed at the time), cleared by `toggleOrchestratorCollapsed` (either
  // direction — touching the chevron makes the row yours) and by `collapseAutoExpanded`. Persisted
  // alongside `collapsedOrchestrators`, so a relaunch doesn't silently re-classify every
  // app-expanded subtree as a user choice and strand it open forever.
  autoExpandedOrchestrators: Record<string, boolean>;
  isOrchestratorCollapsed: (id: string) => boolean;
  toggleOrchestratorCollapsed: (id: string) => void;
  /** Force these orchestrators expanded. Batch, because a fan-out can add workers to several parents
   *  in one tick and N separate set() calls would be N renders. A no-op when they are all already
   *  expanded, so it can be called from an effect on every tick without churning the store.
   *
   *  `auto` says WHO is asking, and it defaults to FALSE — i.e. "the user wants this open" — because
   *  the callers split two ways and the sticky answer is the safe one. The sidebar's own rules (a
   *  worker going red, revealing the selection — see engine/workerExpansion) pass `{ auto: true }`
   *  and accept that the subtree may fold itself away again once that reason is gone. The
   *  concierge's reveal paths do NOT: a "Show me" and a rowless digest line expand exactly the heads
   *  the user clicked to see, and folding all but the selected one back up on the next status tick
   *  is the 53737 bug returning. */
  expandOrchestrators: (ids: readonly string[], opts?: { auto?: boolean }) => void;
  /** Close these orchestrators again — but ONLY the ones still carrying the auto-expanded mark, so
   *  this can never take away a subtree the user opened themselves. The caller decides WHEN (see
   *  engine/workerExpansion.autoCollapseTargets); the mark is the store's own veto. Identity-stable
   *  when there is nothing to close, for the same every-tick-effect reason as expandOrchestrators. */
  collapseAutoExpanded: (ids: readonly string[]) => void;
  // Deep-open request for the ⋯ settings dialog: a component anywhere (e.g. BalanceBadge) asks
  // for a category; the shell's kebab menu (which owns the dialog) opens it there and clears the
  // request on close. Transient — NOT persisted (see partialize), a relaunch must never restore a dialog.
  settingsRequest: CategoryId | null;
  openSettings: (cat: CategoryId) => void;
  clearSettingsRequest: () => void;
  // Focus request for the concierge compose box: a component anywhere (e.g. the drag-vision pill)
  // asks the ONE compose surface to take the caret. A monotonically increasing token, not a bool,
  // so repeat requests re-focus. Transient — NOT persisted.
  composeFocusSeq: number;
  requestComposeFocus: () => void;
  // Reveal request for the agent list: "scroll THIS agent's row into view". Set when a brand-new
  // build agent is spawned (§13 — selecting it was never enough; the row could be below the fold,
  // so the user had to go hunting for the thing they just created). ONE-SHOT: the row that matches
  // scrolls itself in and clears the id, so a later remount of the list can't yank the column back.
  // Transient — NOT persisted; a scroll intent from a previous launch is meaningless.
  //
  // AND IT EXPIRES — see REVEAL_REQUEST_TTL_MS. The row is not guaranteed to mount, and an
  // unbounded request is a scroll that fires at an arbitrary later moment (roborev 53784).
  revealAgentId: string | null;
  requestRevealAgent: (id: string) => void;
  clearRevealAgent: (id: string) => void;
  // Concierge pin scope (CM-U7): the project tab whose pin is lit. Pinning scopes the concierge to
  // that project ("disregard all other project alerts so you can focus"); null = following all
  // projects. ONE pin at a time — pinning a project replaces any previous pin, pinning the pinned
  // one clears it. Persisted, so the focus you chose survives a relaunch.
  pinnedProjectId: string | null;
  togglePinnedProject: (id: string) => void;
  setPinnedProject: (id: string | null) => void;
  // Which projects currently have a TAB (engine/openProjects). "Exists in the project store" and
  // "is open right now" are different facts: before this, every project the store had ever heard of
  // rendered a tab forever, with no way to put one away. Persisted so a closed project stays closed
  // across a relaunch — and NULLABLE, which is load-bearing: `null` means "nothing has written this
  // yet", i.e. every existing install upgrading into the feature, and resolves to "everything is
  // open" so nobody's tab bar blanks on upgrade. `[]` is the genuinely different state "the user
  // closed the last tab". The rules live in the engine; the store just holds the value.
  openProjectIds: string[] | null;
  setOpenProjectIds: (ids: string[]) => void;
  // WHICH PAIR EACH PROJECT LIVES IN (engine/pairs). The cockpit's full form is
  // `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`; the app shipped the right half, and this is what
  // makes the left half real. SPARSE and left-only: an absent entry means "right", so an existing
  // install with no map renders exactly the single-pair layout it had, and "empty map" and "no left
  // pair" are the same state — there is no way to persist a left pair with nothing in it.
  // Persisted, because which side a project sits on is a deliberate arrangement of the user's
  // workspace, not a transient view state. The rules live in the engine; the store holds the value.
  pairAssignment: Record<string, PairSide>;
  /** Move a project to a side. A no-op assignment must not churn the map — see engine/pairs. */
  assignProjectToPair: (projectId: string, side: PairSide) => void;
  /** Drop entries for projects that no longer exist, so a stale one cannot strand an empty pair. */
  prunePairAssignment: (projects: readonly { id: string }[]) => void;
  // The LEFT pair's selected project. The right pair's selection stays `projectStore.selectedProjectId`
  // — deliberately, because that value means "the current project" to ten other call sites
  // (notifications, capture, satellite ownership, the concierge feed) and re-pointing it at a
  // two-sided concept would change all of them. So: right keeps the existing meaning, left gets its
  // own slot, and `resolveSideSelection` validates each against what its side actually holds.
  leftProjectId: string | null;
  setLeftProject: (id: string | null) => void;
  // Whether the user has ✕'d the "$0 credit balance" banner (see ZeroCreditBanner). Transient —
  // NOT persisted (see partialize), so the warning returns on the next launch: the balance is
  // still zero and the AI extras are still dark, which the user deserves to be reminded of.
  // `authStore.syncZeroCreditBanner` CLEARS this — a direct call, NOT a store subscription — at every
  // `me` write that could change the answer (a fetched `me`, `setMe`), whenever credits arrive or a
  // different user signs in. So the flag tracks "this zero episode is dismissed" rather than latching
  // forever: spend a refill back down to zero and the banner comes back. A NULL `me` deliberately
  // does not re-arm (a network blip must not resurrect a dismissal), which is why the no-token and
  // rehydrate paths skip the call and a real sign-out clears the flag explicitly in `reset()`. The
  // rule itself lives in services/zeroCreditBanner.
  zeroCreditBannerDismissed: boolean;
  // WHOSE dismissal is latched, so a different user signing in gets their own warning while a
  // transient `fetchMe()` failure (which nulls `me` without changing anyone's balance) does not
  // resurrect a banner this user already dismissed. Transient alongside the flag itself.
  zeroCreditBannerDismissedFor: string | null;
  // Settings → Concierge tools → "Copy on selection" (PRD 1 §1): releasing a text selection in the
  // concierge thread puts it on the clipboard. DEFAULT ON — the affordance is the feature, and one
  // nobody switches on is one nobody has.
  //
  // IT LIVES HERE, not in settingsStore + config.toml, and the split is deliberate: behavioral,
  // billable and agent-facing flags round-trip through services/configActions because an agent or a
  // bill depends on them; this one changes nothing but what a gesture in one column does. A pure
  // presentation preference belongs in the `sparkle-ui` blob with the composer height and the theme.
  //
  // It governs the SELECTION path ONLY. The per-answer copy button is an explicit click and copies
  // regardless — turning this off means "stop copying things I merely highlighted", not "take the
  // button away".
  conciergeCopyOnSelection: boolean;
  setConciergeCopyOnSelection: (v: boolean) => void;
  /**
   * The auto-send rail is armed: speech ending starts a countdown that SENDS on its own (PRD §4).
   *
   * DEFAULT OFF, unlike the copy preference above, and the asymmetry is the point. Copying something
   * you highlighted is recoverable — the worst case is a clipboard you did not want. An auto-send is
   * not: it delivers an irreversible instruction to an agent with no undo, no hold and no post-send
   * countdown, which is exactly what §4 specifies ("when it sends, it sends"). A feature that can
   * dispatch work on your behalf has to be switched on deliberately, once, by you.
   *
   * Persisted so arming survives a relaunch — someone who dictates this way wants it every session,
   * and the rail states its own state plainly whenever it is armed.
   */
  conciergeAutoSend: boolean;
  setConciergeAutoSend: (v: boolean) => void;
  /**
   * Grade each auto-send with a background Haiku call, to tune the heuristics (PRD §4e).
   *
   * DEFAULT OFF and opt-in, because it spends the USER'S OWN Claude subscription: the classify runs
   * through their local `claude` binary with the API-key vars stripped, so BYOK cannot pay for it
   * and every call bills a message against their quota. The output is a diagnostic only this
   * codebase's future tuning ever reads. Spending someone else's quota to improve our heuristics is
   * not a default — same posture as `builder_index`, which is documented as default-off and
   * consent-gated for the same reason.
   *
   * With this off, auto-send still works exactly as specified: the heuristics were always the
   * in-loop path, and this only ever recorded a second opinion after the fact.
   */
  conciergeAutoSendTuner: boolean;
  setConciergeAutoSendTuner: (v: boolean) => void;
  // `userId` is REQUIRED, not `string | null`: a dismissal latched with no owner can only ever be
  // cleared by credits arriving — a different user signing in at $0 would inherit the silence, which
  // is precisely what recording the owner exists to prevent. (roborev 51700/51712)
  dismissZeroCreditBanner: (userId: string) => void;
  rearmZeroCreditBanner: () => void;
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
      conciergeComposeH: null,
      setConciergeComposeH: (h) => set({ conciergeComposeH: h }),
      statusFilter: { needs_you: true, running: true, done: true },
      toggleStatusBand: (b) =>
        set((s) => ({ statusFilter: { ...s.statusFilter, [b]: !s.statusFilter[b] } })),
      showAllStatusBands: () =>
        set({ statusFilter: { needs_you: true, running: true, done: true } }),
      isolateStatusBand: (b) =>
        set({ statusFilter: { needs_you: b === "needs_you", running: b === "running", done: b === "done" } }),
      workMode: "build",
      setWorkMode: (m) => set({ workMode: m }),
      boardFocusBeadId: null,
      setBoardFocusBeadId: (id) => set({ boardFocusBeadId: id }),
      buildAgentHover: false,
      setBuildAgentHover: (v) => set({ buildAgentHover: v }),
      newAgentRuntime: "local",
      setNewAgentRuntime: (r) => set({ newAgentRuntime: r }),
      cloudCreateOpen: false,
      setCloudCreateOpen: (v) => set({ cloudCreateOpen: v }),
      collapsedOrchestrators: {},
      autoExpandedOrchestrators: {},
      // Absent → collapsed (workers start hidden behind the roll-up).
      isOrchestratorCollapsed: (id) => get().collapsedOrchestrators[id] ?? true,
      toggleOrchestratorCollapsed: (id) =>
        set((s) => {
          const cur = s.collapsedOrchestrators[id] ?? true;
          // Touching the chevron transfers ownership of this row to the user, in BOTH directions: a
          // hand-expanded subtree must not be auto-collapsed out from under them, and a hand-
          // collapsed one must not keep a stale mark that a later re-expansion would inherit.
          const { [id]: _dropped, ...auto } = s.autoExpandedOrchestrators;
          return {
            collapsedOrchestrators: { ...s.collapsedOrchestrators, [id]: !cur },
            autoExpandedOrchestrators: auto,
          };
        }),
      expandOrchestrators: (ids, opts) =>
        set((s) => {
          // Identity-stable when there is nothing to do: the caller is an effect that runs on every
          // agent-set change, and returning a fresh object each time would re-render every consumer
          // of collapsedOrchestrators for no reason.
          //
          // "Nothing to do" includes the MARK, not just the collapse state. An `auto` call only ever
          // marks what it opens, so opening nothing changes nothing; a user-intent call also has to
          // strip any stale mark, and bailing on the collapse state alone would leave a subtree the
          // app had opened still revocable after the user deliberately revealed it.
          const opensNothing = ids.every((id) => s.collapsedOrchestrators[id] === false);
          const marksNothing =
            opts?.auto || ids.every((id) => s.autoExpandedOrchestrators[id] === undefined);
          if (opensNothing && marksNothing) return s;
          const next = { ...s.collapsedOrchestrators };
          const auto = { ...s.autoExpandedOrchestrators };
          for (const id of ids) {
            // Mark ONLY the ones this call actually opens, and only when the caller says it is the
            // app asking. An id already expanded is expanded for someone else's reason — very likely
            // the user's chevron — and stamping it here would quietly convert their choice into
            // something auto-collapse may revoke. A non-auto expansion likewise CLEARS any stale
            // mark: a user-intent reveal of a subtree the app had opened makes it the user's.
            if (!opts?.auto) delete auto[id];
            else if (next[id] !== false) auto[id] = true;
            next[id] = false;
          }
          return { collapsedOrchestrators: next, autoExpandedOrchestrators: auto };
        }),
      collapseAutoExpanded: (ids) =>
        set((s) => {
          const targets = ids.filter((id) => s.autoExpandedOrchestrators[id] === true);
          if (targets.length === 0) return s;
          const next = { ...s.collapsedOrchestrators };
          const auto = { ...s.autoExpandedOrchestrators };
          for (const id of targets) {
            next[id] = true;
            delete auto[id];
          }
          return { collapsedOrchestrators: next, autoExpandedOrchestrators: auto };
        }),
      settingsRequest: null,
      openSettings: (cat) => set({ settingsRequest: cat }),
      clearSettingsRequest: () => set({ settingsRequest: null }),
      composeFocusSeq: 0,
      // EVERY caller of this is the user asking for the caret — the drop pill's "go to compose"
      // button, a file drop, spawning an agent, the capture-window handoff. ComposeBox's effect
      // relies on that: it names the concierge as the voice surface outright. An APP-driven refocus
      // must NOT use this seam; give it one of its own.
      requestComposeFocus: () => set((s) => ({ composeFocusSeq: s.composeFocusSeq + 1 })),
      revealAgentId: null,
      requestRevealAgent: (id) => {
        // Arm the deadline BEFORE publishing the id, so there is no window in which a pending
        // request exists without an expiry attached to it.
        cancelRevealExpiry();
        revealExpiryTimer = setTimeout(() => {
          revealExpiryTimer = null;
          // Id-guarded like clearRevealAgent: a newer request must not be cancelled by an older
          // timer that somehow outlived its own cancellation.
          set((s) => (s.revealAgentId === id ? { revealAgentId: null } : s));
        }, REVEAL_REQUEST_TTL_MS);
        set({ revealAgentId: id });
      },
      // Id-guarded so a row can only retire ITS OWN request: without the check, a stale effect from
      // a row unmounting mid-spawn would swallow the request that named a different row.
      clearRevealAgent: (id) => {
        if (get().revealAgentId !== id) return;
        cancelRevealExpiry();
        set({ revealAgentId: null });
      },
      pinnedProjectId: null,
      togglePinnedProject: (id) =>
        set((s) => ({ pinnedProjectId: s.pinnedProjectId === id ? null : id })),
      setPinnedProject: (id) => set({ pinnedProjectId: id }),
      openProjectIds: null,
      setOpenProjectIds: (ids) => set({ openProjectIds: ids }),
      pairAssignment: {},
      // Both of these apply an engine reducer and set the RESULT, which returns the same object for
      // a no-op. That identity is load-bearing, not tidiness: `Workspace` partitions its live pane
      // list through this map, so a fresh-but-equal object re-renders the stages and REMOUNTS panes
      // that never moved — and a Terminal unmount kills its PTY.
      assignProjectToPair: (projectId, side) =>
        set((s) => {
          const next = assignToSide(s.pairAssignment, projectId, side);
          return next === s.pairAssignment ? {} : { pairAssignment: next };
        }),
      prunePairAssignment: (projects) =>
        set((s) => {
          const next = pruneAssignment(s.pairAssignment, projects);
          return next === s.pairAssignment ? {} : { pairAssignment: next };
        }),
      leftProjectId: null,
      setLeftProject: (id) => set({ leftProjectId: id }),
      zeroCreditBannerDismissed: false,
      zeroCreditBannerDismissedFor: null,
      conciergeCopyOnSelection: true,
      setConciergeCopyOnSelection: (v) => set({ conciergeCopyOnSelection: v }),
      // OFF by default — see the field's doc for why this one is not symmetric with the above.
      conciergeAutoSend: false,
      setConciergeAutoSend: (v) => set({ conciergeAutoSend: v }),
      // OFF by default — it spends the user's own Claude subscription. See the field's doc.
      conciergeAutoSendTuner: false,
      setConciergeAutoSendTuner: (v) => set({ conciergeAutoSendTuner: v }),
      dismissZeroCreditBanner: (userId) =>
        set({ zeroCreditBannerDismissed: true, zeroCreditBannerDismissedFor: userId }),
      // Idempotent on purpose: authStore calls this on every `me` write, so it must be a no-op
      // (no state write, no re-render storm, and no `persist` disk write) once the flag is already
      // clear — otherwise every entitlement poll would churn localStorage.
      rearmZeroCreditBanner: () =>
        set((s) =>
          s.zeroCreditBannerDismissed || s.zeroCreditBannerDismissedFor !== null
            ? { zeroCreditBannerDismissed: false, zeroCreditBannerDismissedFor: null }
            : s,
        ),
    }),
    {
      name: "sparkle-ui",
      storage: createJSONStorage(() => localStorage),
      // Persist everything EXCEPT the transient keys listed below, so the active sidebar tab resets
      // to "build" on each launch (matching the prior local-useState default) and the transient
      // hover flag / one-shot board-focus handoff / one-shot settings deep-open / the helper
      // island's tier filter / the dismissed $0 warning never persist, while every other UI
      // preference still sticks.
      //
      // This governs the WRITE path only — see `merge` below for why the read path needs the same
      // list, and what goes wrong for the user when it doesn't have it.
      partialize: (state) => {
        // Driven off TRANSIENT_UI_KEYS, not a second hand-written destructure. Two lists is how the
        // rehydrate bug was born: a key added to one and forgotten in the other drifts silently, and
        // `satisfies keyof UiState` catches renames, not a list with one fewer entry. Behaviourally
        // identical to the destructure — the spread carried the action functions too, and
        // JSON.stringify drops them.
        const out = { ...state } as Record<string, unknown>;
        for (const key of TRANSIENT_UI_KEYS) delete out[key];
        return out as Partial<UiState>;
      },
      // v1: the rest height shrank from 128 to the compact COMPOSER_SNAP. The pure
      // migratePersistedUi resets only users still parked on the OLD default, preserving a
      // height anyone deliberately dragged to. (composerMinimized hydrates from its default
      // via the usual shallow merge — no migration needed for the new field.)
      // v2: drops the retired `agentOrdering` preference and repairs `statusFilter` into a
      // complete record, so a partial blob can't hide a band with no visible cause.
      version: 2,
      migrate: (persisted, version) =>
        migratePersistedUi(persisted as Record<string, unknown>, version, COMPOSER_SNAP) as unknown as UiState,
      // Strip the transient keys on the way IN as well. `partialize` only stops us WRITING them;
      // zustand's default merge shallow-merges whatever the blob happens to contain, and
      // migratePersistedUi passes unknown keys through untouched. So a blob written by any build
      // before a key was excluded — or hand-edited — restores it at launch. Observed with
      // zeroCreditBannerDismissed: dismiss the $0 banner once and every later launch starts
      // dismissed, still at zero balance, with AI extras silently dark and nothing to undo it.
      merge: (persisted, current) => {
        const stored = { ...(persisted as Record<string, unknown>) };
        for (const key of TRANSIENT_UI_KEYS) delete stored[key];
        return { ...current, ...(stored as Partial<UiState>) };
      },
    },
  ),
);

// uiStore — small persisted UI preferences (not project/agent data). Currently just the
// composer height, so the size you drag it to sticks across tabs and relaunches.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
// SAFE AS A VALUE IMPORT — `services/boardFilters` has no runtime imports of its own (it takes only
// `type { Bead }`, which is erased), so this reaches neither theme/colors nor a component and
// cannot close the cycle the notes below describe.
import { NO_BOARD_FILTER, type BoardFilter } from "../services/boardFilters";
import {
  migratePersistedUi,
  repairActiveSpecial,
  repairSendMode,
  repairZoomByColumn,
} from "./composerPersist";
// A VALUE import, unlike StatusBand/SendMode below: engine/columnZoom imports only a TYPE from
// engine/columnResize and nothing else, so it reaches neither theme/colors nor a component and
// cannot close the theme → uiStore cycle those two comments describe.
import {
  ZOOM_DEFAULT,
  ZOOM_COLUMNS,
  clampZoom,
  steppedZoom,
  type ZoomColumn,
} from "../engine/columnZoom";
// TYPE-ONLY import, deliberately: engine/buildSections → engine/workflowStage → theme/colors, and
// theme/theme.ts imports THIS store. A value import would close that loop into a runtime cycle; a
// type import is erased at compile time, so it can't. The default below is spelled inline for the
// same reason (rather than calling allBandsVisible()).
//
// SO THE BAND LIST IS SPELLED OUT THREE TIMES BELOW, and that is a knowing exception to "never
// re-list the taxonomy" — the cycle is the reason. What keeps it honest is `Record<StatusBand, …>`:
// every one of the three is exhaustive, so adding a band is a COMPILE ERROR here rather than a
// silent omission. That is how `questions` was caught when it was added on 2026-08-05. If you add a
// fifth band and the compiler sends you here, add the key; do not reach for a value import.
import type { StatusBand } from "../engine/buildSections";
// TYPE-ONLY for the same reason as StatusBand above: voice/sendMode pulls in components/MicButton
// for `MicIntent`, which reaches theme/colors — and theme/theme.ts imports this store.
import type { SendMode } from "../voice/sendMode";
import { assignToSide, pruneAssignment, type PairSide } from "../engine/pairs";
// THE work-mode union, declared once in `engine/workMode` and re-exported below for the callers
// that import it from here. Type-only, so it is erased and cannot participate in a cycle (that
// module imports nothing at all, so there is no cycle to participate in either).
import type { WorkMode } from "../engine/workMode";

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
  // Social Coding's own category (§10) — deliberately NOT part of "accounts", which is already the
  // junk drawer and whose search keywords are all sign-in words. `openSettings("chat")` is the
  // deep-open seam the `[+]` on the Chat section and the avatar button both take.
  | "chat"
  | "cloudauth"
  | "onepassword"
  | "chief"
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
  // AND IT MUST STAY HERE NOW THAT "preview" IS A MODE. A restored Plan mode was merely a surprise;
  // a restored Preview mode is a pane pointing at a dev server that DIED with the last process —
  // the preview registry is swept at startup, so there is nothing behind the frame and the column
  // opens on a blank error with no memory of anyone asking for it. Transient is the only correct
  // answer for a mode whose content is owned by a child process.
  "workModeBySide",
  "buildAgentHover",
  "boardFocusBeadId",
  "boardAgentFilterBySide",
  // Which notice pill the mounted composer should open (bead sparkle-tyter). A statement about the
  // mark the user just clicked, and it is CONSUMED on the next render — restoring one on the next
  // launch would pop a pill open about a condition that may no longer hold, on an agent they have
  // not looked at. The ratchet test caught this key reaching the blob, which is exactly its job.
  "focusedNoticeBySide",
  // A restored filter would show a board that looks EMPTY with no visible cause — the control that
  // narrowed it is off screen and the user never touched it this session. Same reasoning as
  // boardAgentFilterBySide directly above.
  "boardFilterBySide",
  "settingsRequest",
  "composeFocusSeq",
  "revealAgentId",
  // Travels with `revealAgentId` — a viewport coordinate from one click is meaningless on the next
  // launch, and worse than meaningless if it outlived the request that carried it.
  "revealAnchorY",
  "cloudCreateProjectId",
  // A promotion confirm dialog is a live, half-made decision about moving work off this machine.
  // Restoring one on the next launch would put a "Move to cloud" button in front of a user who
  // never opened it, against a preflight read from a worktree that has moved on since.
  "promoteAgentId",
  // Same reasoning in the other direction, and the stakes are higher: restoring a "Bring down to
  // local" dialog on the next launch would put a button in front of a user who never opened it
  // whose first act is to DELETE a running sandbox.
  "demoteAgentId",
  "zeroCreditBannerDismissed",
  "zeroCreditBannerDismissedFor",
  // WHICH BANDS THE BUILD COLUMN SHOWS — transient on the founder's P0 rule (bead sparkle-qogah.4):
  // "We should never hide a row that needs action from me."
  //
  // A band filter hides ROWS, and two of the three bands carry work he owes: `needs_you` is the
  // asks, and `done` is where every "Needs merge" row lives (engine/buildSections bands `unmerged`
  // there). Persisting it made concealment permanent AND invisible — a band turned off yesterday,
  // by a chip or by a digest line nobody read as a filter, is still hiding the merge queue on
  // today's launch, with nothing on screen recording that a filter was ever set and no memory of
  // setting one. That is the false-confidence failure the rule is about: the sidebar reports a count
  // that sounds complete while the rows behind it are filtered away.
  //
  // So narrowing stays a LIVE act: visible in the chips that render it, clearable with "Show all",
  // and gone by the next launch. The alternative considered was exempting actionable rows from band
  // filtering outright — a more faithful reading of the rule, but it belongs in the sidebar's filter
  // (engine/buildSections), not here, and it would leave the "a filter I never set is still on"
  // half of the defect standing for the bands it did not exempt. One of the two, not both halfway.
  "statusFilter",
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
/**
 * Stacking order of the composer overlay, and WHO ELSE DEPENDS ON IT.
 *
 * The composer is an absolutely-positioned strip across the bottom of its pane, and in the Sparkle
 * pane the terminal's drop region is a sibling box spanning the WHOLE pane — so the two overlap
 * completely along that strip and only paint order decides which one a drop lands on
 * (`document.elementFromPoint` returns the topmost element, and the drop hooks resolve ownership by
 * walking up from it). That made "the compose box keeps its own drops" an accident of two literals
 * in two files: raise the terminal box above this and a file dropped on the compose box would paste
 * a shell-quoted path into the PTY instead of becoming a tile, silently (roborev 55575).
 *
 * So the number is shared and the dependency is written down: SparkleAgentPane derives its
 * terminal region's z-index from this and must stay BELOW it. `SparkleAgentPane.drop.test.tsx`
 * asserts that ordering against the rendered DOM.
 */
export const COMPOSER_Z = 5;

// Text-size factor for ONE COLUMN (Cmd +/- and the ⋯ menu "Text size"). It used to be a single
// global number read only by Terminal.tsx, which is why the shortcut worked in a terminal and
// nowhere else; it is now one level per cockpit region. The bounds, the step and the clamp moved to
// engine/columnZoom with the rest of the rule — re-exported here because several call sites already
// import them from this module and a second spelling of a constant is the drift those files keep
// re-finding.
export { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, ZOOM_DEFAULT } from "../engine/columnZoom";
export type { ZoomColumn } from "../engine/columnZoom";

/** Every region at 1.0 — the store's initial state and what "Reset all" restores.
 *  BUILT FROM `ZOOM_COLUMNS` rather than written out, so a region added later cannot be born
 *  `undefined` in the default object while every rehydrate path repairs it. */
function defaultZoomByColumn(): Record<ZoomColumn, number> {
  const out = {} as Record<ZoomColumn, number>;
  for (const key of ZOOM_COLUMNS) out[key] = ZOOM_DEFAULT;
  return out;
}

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

// Sidebar workflow mode — which of the Plan / Build / Preview surfaces is active. Lifted out of
// AgentSidebar's local state into the store so other components can switch tabs by calling
// setWorkMode. Deliberately NOT persisted (see partialize) so it defaults to "build" on every
// launch, exactly as the old local useState default did.
//
// RE-EXPORTED, NOT RE-DECLARED. This used to be a second `export type WorkMode = "plan" | "build"`
// sitting beside `engine/workMode`'s copy, with different files importing different ones — so the
// two could be widened apart and the mismatch would only surface wherever a value crossed between
// them. `engine/workMode` is the source (it has no imports, so it can never close a cycle); this
// line keeps every existing `import type { WorkMode } from "../stores/uiStore"` working.
export type { WorkMode } from "../engine/workMode";

// PER COLUMN, NOT PER WINDOW. This was a single `workMode: WorkMode` for both pairs, and paired
// with a global `activeSpecial === "board"` it made the Plan board a SINGLETON: the left column's
// Plan chevron wrote a global that only the RIGHT pair rendered, so pressing Plan on the left
// opened the board on the right AND clobbered whatever the right column had open. Same shape as
// the mount-cable bug — a per-column feature carrying a decorative per-column appearance while one
// global held the truth.
//
// A column's mode is now the ONLY truth for that column's board: the board is up in a pair iff
// `workModeBySide[side] === "plan"`. That deliberately collapses the old duplicate truth (mode +
// `activeSpecial: "board"`), which had to be written in lockstep at five call sites and silently
// diverged whenever one of them was missed.
export type WorkModeBySide = Record<PairSide, WorkMode>;

export const DEFAULT_WORK_MODE_BY_SIDE: WorkModeBySide = { left: "build", right: "build" };

/** The pair whose stage hosts the one Improve-Sparkle pane. Named so `openPlanBoard`'s scoping
 *  reads as a fact about the layout rather than a bare "right" nobody can check. */
export const SPARKLE_PANE_SIDE: PairSide = "right";

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
  // ── ONE ZOOM LEVEL PER COLUMN ────────────────────────────────────────────────────────────────
  //
  // A COMPLETE record, never a sparse one. Every action below writes through `repairZoomByColumn`'s
  // shape, and the rehydrate path repairs it unconditionally, because a missing key here does not
  // read as "default" — it reads as `undefined`, reaches `BASE_FONT_SIZE * undefined` as `NaN`, and
  // blanks a terminal for good (the value is persisted). See stores/composerPersist.
  //
  // The KEY is `ZoomColumn` — the five cockpit regions plus the satellite window — so "each column
  // remembers its own level" is a property of the type rather than a convention. There is no global
  // zoom any more; a caller that wants to move everything calls `resetAllZoom` or iterates.
  zoomByColumn: Record<ZoomColumn, number>;
  setColumnZoom: (column: ZoomColumn, z: number) => void;
  /** Step ONE column. `direction` is +1/-1 so both keys share a single stepping rule. */
  stepColumnZoom: (column: ZoomColumn, direction: 1 | -1) => void;
  /** Cmd+0 — the focused column only. */
  resetColumnZoom: (column: ZoomColumn) => void;
  /** Step EVERY region at once — what the Settings "Text size" stepper drives.
   *
   *  That control lives in a modal, so there is no focused column for it to address: the honest
   *  reading of a global widget is "all of them". It is also the only surface from which a user who
   *  cannot remember which column they zoomed can walk everything back together. */
  stepAllZoom: (direction: 1 | -1) => void;
  /** "Reset all" — every region back to 1.0 at once. Deliberately a SEPARATE action from
   *  `resetColumnZoom`, which is what Cmd+0 calls: with five independent levels, a user who has
   *  zoomed several columns and wants out needs one gesture that does not require visiting each. */
  resetAllZoom: () => void;
  // Which special (non-project) view is in focus, if any. "sparkle" = the self-improvement agent
  // pinned bottom-left. null = a normal project agent (or nothing) is active. Persisted so the
  // active view survives relaunch. Selecting a normal agent clears this back to null.
  //
  // "board" USED TO LIVE HERE and no longer does. The Tasks Kanban is per-COLUMN state, and a
  // window-global field cannot express it: whichever column wrote "board" last owned the only
  // board on screen. Read `workModeBySide[side] === "plan"` instead. What remains here is
  // genuinely window-global — there is exactly one Improve-Sparkle pane, in the primary pair.
  activeSpecial: "sparkle" | null;
  setActiveSpecial: (v: "sparkle" | null) => void;
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
  /** Set every band at once — for a control that narrows to a SET rather than to one band. */
  setStatusFilter: (f: Record<StatusBand, boolean>) => void;
  // Active sidebar workflow mode (Plan/Build chevrons), KEYED BY PAIR SIDE — see WorkModeBySide.
  // Each build column owns its own chevron and its own Plan board; one column's mode is invisible
  // to the other. Shared so non-sidebar components can switch a column's tab. NOT persisted (see
  // partialize) — resets to "build" each launch like the old local state.
  workModeBySide: WorkModeBySide;
  setWorkMode: (side: PairSide, m: WorkMode) => void;
  /** Put a column into Plan **and** make its board actually visible — see openPlanBoard. Every
   *  entry point that means "show me the board" must use this rather than `setWorkMode(side,
   *  "plan")`, which only moves the chevron. */
  openPlanBoard: (side: PairSide) => void;
  /** The mirror: put a column into Build **and** make its stage actually visible. Same rule —
   *  anything meaning "show me the terminal/rows" uses this, not a bare `setWorkMode`. */
  showBuildStage: (side: PairSide) => void;
  /** The THIRD member of that family: put a column into Preview **and** make its slot actually
   *  visible. Same rule and the same reason — see `openPlanBoard`. Entering a mode is two writes
   *  and exactly one place may know that. */
  openPreview: (side: PairSide) => void;
  // One-shot "open this bead's detail when the board shows it" handoff (spec §8: clicking an
  // orchestrator's epic pill jumps to the Plan board with that epic's DetailOverlay open). Set by
  // the pill, consumed-then-cleared by BoardView once the bead is present. Transient — NOT persisted.
  boardFocusBeadId: string | null;
  setBoardFocusBeadId: (id: string | null) => void;
  // One-shot "open the Plan board filtered to just this agent's feedback" handoff. Set by an agent
  // row's FEEDBACK pill (AgentSidebar), consumed by BoardView which narrows the displayed beads to
  // those labeled `agent:<id>`. The id is the build-agent's a.id.
  // Transient — NOT persisted (see partialize): a relaunch must never restore a filtered board.
  //
  // KEYED BY SIDE, for the same reason the mode is. Both pairs can hold a board open at once now,
  // and both BoardViews read this — so a single global string meant a LEFT row's pill also narrowed
  // the RIGHT column's board. Across two projects that is worse than a stray filter: the other
  // board filters on an agent id belonging to a project it isn't showing, matches nothing, and
  // renders empty under "Showing feedback from agent <id>" with no visible cause in that column.
  boardAgentFilterBySide: Record<PairSide, string | null>;
  setBoardAgentFilter: (side: PairSide, id: string | null) => void;
  // WHICH NOTICE PILL the mounted composer should open, as an `AgentNotice.id`. Bead sparkle-tyter.
  //
  // The founder's worked example: *"If I were to click on the mailbox icon on the row then the
  // mailbox could expand on the mounted concierge and then could show me the actual queued
  // messages."* A row mark's click therefore does three things — select the agent, patch the cable,
  // and name the pill to open — and this is the third. Without it the click could only say
  // "something in this class" and the pill row would have to guess which one he meant.
  //
  // KEYED BY SIDE, like `boardAgentFilterBySide` directly above and for the identical reason: both
  // pairs can be mounted at once, and a global string would have a LEFT row's click expand a pill in
  // the RIGHT column's composer.
  //
  // NOT PERSISTED. A focused notice is a statement about what the user just clicked; restoring it
  // across a relaunch would pop a pill open about a condition that may no longer hold, on an agent
  // they have not looked at. The consumer CLEARS it once consumed, so a later manual collapse sticks
  // rather than being re-opened on the next render.
  focusedNoticeBySide: Record<PairSide, string | null>;
  setFocusedNotice: (side: PairSide, noticeId: string | null) => void;
  // The board's PRIORITY + DATE-RANGE filter (founder: "I want to be able to only look at cards of
  // a certain priority status and also a certain date range").
  //
  // KEYED BY SIDE for exactly the reason boardAgentFilterBySide above is, and the failure mode is
  // the same one: two boards can be open at once, on two different projects, and a single global
  // filter would silently narrow the one the user is not looking at.
  //
  // Transient — NOT persisted (see partialize). A relaunch showing a filtered board with the
  // control scrolled out of view is a board that looks EMPTY for no visible reason, which is the
  // failure `sparkle-qogah` names. The filter must always be something the user just did.
  boardFilterBySide: Record<PairSide, BoardFilter>;
  setBoardFilter: (side: PairSide, filter: BoardFilter) => void;
  // Whether ANY "+ New Build Agent" button is currently hovered. Shared so hovering the empty-state
  // start button on the Workspace also lights up the sidebar's button blue (and vice versa),
  // pointing the user at where that affordance normally lives. Transient — NOT persisted.
  buildAgentHover: boolean;
  setBuildAgentHover: (v: boolean) => void;
  // WHICH PROJECT the open "new cloud agent" dialog is creating in — null when it is closed.
  //
  // An ID, not a boolean, and that is the whole point. The dialog is a singleton rendered by the
  // Workspace, which used to hand it the LIVE front project while the flag said only "something is
  // open". With two columns those are different projects: clicking "+ Cloud Agent" in the LEFT
  // pair opened a dialog that would create in the RIGHT one, and switching the right tab while it
  // was open silently retargeted it. Capturing the id at click time makes the dialog answer to the
  // gesture that opened it. Lives here (not in a component) because the
  // dialog must be rendered exactly ONCE. Transient — NOT persisted; a relaunch never restores a
  // dialog, least of all one whose action costs credits.
  cloudCreateProjectId: string | null;
  setCloudCreateProjectId: (id: string | null) => void;
  // Per build-agent: whether its worker subtree is collapsed in the sidebar. A build agent's
  // workers start COLLAPSED (a missing entry reads as collapsed) so a busy orchestrator shows a
  // compact "N workers" roll-up by default; the user expands to see each worker's own tracker.
  // Keyed by the build agent's id; persisted so the choice survives relaunch.
  collapsedOrchestrators: Record<string, boolean>;
  isOrchestratorCollapsed: (id: string) => boolean;
  /** THE ONE WRITER of `collapsedOrchestrators`. Every other function below is a named wrapper around
   *  this, and nothing outside this store may write the record directly.
   *
   *  That is the whole design, and it is a narrowing rather than a rename. This state used to be
   *  writable from a second direction — the sidebar's own effects, which opened a subtree when a
   *  worker went red and closed it again when the red cleared — and the pair composed into a parent
   *  standing open, showing a green worker, under a project the user never touched. The fix is not a
   *  better rule for when the app may open a row; it is that the app HAS no such rule. Expansion is
   *  user state. With one writer whose every caller is a user gesture, "a row opened by itself" stops
   *  being a bug to detect and becomes a state with nothing to produce it.
   *
   *  Note the consequence, because it is easy to re-add by reflex: there is deliberately NO periodic
   *  "are any rows wrongly open?" sweep, and adding one would be a mistake. A sweep is what you need
   *  when writes can come from anywhere; with a single writer there is no drift for it to correct,
   *  and the sweep itself becomes a second automatic writer — the very thing this removed.
   *
   *  Batched, because expand-all/collapse-all acts on every head in the column and N separate set()
   *  calls would be N renders. Identity-stable when nothing actually changes, so a caller that
   *  re-asserts the current state does not churn every consumer of the record. */
  setOrchestratorsCollapsed: (ids: readonly string[], collapsed: boolean) => void;
  /** The user's own gesture on ONE row — the head-row click. */
  toggleOrchestratorCollapsed: (id: string) => void;
  /** Open these subtrees because the USER asked to see them: the concierge's "Show me", a rowless
   *  digest line, revealing the row that holds the selection. Every caller is downstream of a human
   *  action naming these heads, which is why it is allowed to write at all.
   *
   *  It is sticky, and that is the point (roborev 53737): a reveal the user asked for must not fold
   *  itself back up on the next status tick. There is no longer any counterpart that could — the
   *  app-owned "put it away again" path is gone along with the mark that made it possible. */
  expandOrchestrators: (ids: readonly string[]) => void;
  // Deep-open request for the ⋯ settings dialog: a component anywhere (e.g. BalanceBadge) asks
  // for a category; the shell's kebab menu (which owns the dialog) opens it there and clears the
  // request on close. Transient — NOT persisted (see partialize), a relaunch must never restore a dialog.
  settingsRequest: CategoryId | null;
  openSettings: (cat: CategoryId) => void;
  clearSettingsRequest: () => void;
  // Which agent has its "Move to cloud" confirm dialog open (local→cloud promotion, bead
  // sparkle-8zpvc). Held here rather than in the row that opened it because the row is memoized and
  // can unmount under the dialog — a section fold, a status-band filter, a project switch — and a
  // half-finished promotion must not vanish with it. The COLUMN owns the mount (AgentSidebar), and
  // it only mounts the dialog for an agent in the project it is rendering, so the two sidebars in a
  // pair can never both put one up. Transient — NOT persisted (see partialize); a relaunch must
  // never restore a dialog, least of all one whose button starts moving work.
  promoteAgentId: string | null;
  openPromoteToCloud: (agentId: string) => void;
  closePromoteToCloud: () => void;
  // Which agent has its "Bring down to local" confirm dialog open (cloud→local demotion). The
  // mirror of `promoteAgentId` in every respect — column-owned mount, project-scoped, transient —
  // and a SEPARATE id rather than one shared "runtime switch" field: an agent is either local or
  // cloud, so the two dialogs can never be open for the same agent, but a shared field would let a
  // stale id from one direction mount the dialog for the other.
  demoteAgentId: string | null;
  openDemoteToLocal: (agentId: string) => void;
  closeDemoteToLocal: () => void;
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
  /** Where on screen the reader was looking when they asked — `MouseEvent.clientY`, viewport
   *  coordinates — or null for a reveal with no cursor behind it (a spawn, a tool call).
   *
   *  Null and a number mean genuinely different things to the row that consumes this: null asks for
   *  the old "just get on screen" behaviour, a number asks for the row to come to the cursor. */
  revealAnchorY: number | null;
  requestRevealAgent: (id: string, opts?: { anchorY?: number }) => void;
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
   * Where the concierge's send tray is parked — Send · Push to talk · Speak (voice/sendMode).
   *
   * IT REPLACED a boolean `conciergeAutoSend`, and the replacement is a widening rather than a
   * rename: the old switch could say "a countdown is armed" but had nothing to say about the
   * MICROPHONE, so the mic's state lived in a different control and the two could contradict each
   * other on screen. Here the position IS the mic state (`micIntentForMode`), so there is exactly
   * one place that answers "what happens when I stop talking". Upgrading blobs are carried across
   * by the v3 migration in ./composerPersist.
   *
   * DEFAULT "send", i.e. microphone off and nothing counting — the same default the boolean had,
   * for the same reason. Copying something you highlighted is recoverable; an auto-send is not, as
   * it delivers an irreversible instruction to an agent with no undo, no hold and no post-send
   * countdown. A feature that can dispatch work on your behalf has to be switched on deliberately,
   * once, by you.
   *
   * Persisted so the choice survives a relaunch — someone who dictates this way wants it every
   * session, and the tray states its own position plainly at all times.
   */
  conciergeSendMode: SendMode;
  setConciergeSendMode: (v: SendMode) => void;
  /**
   * Does a Speak countdown, when it expires, actually SEND?
   *
   * The founder's ask, verbatim: *"when speak is active, I want to have a slider. on-off slider
   * button. For auto-send … And it remembers the last position I set it to. So if I set it to on,
   * every time I go to the speak slider, then it stays on. If I set it to off, every time it's
   * off."* THE REMEMBERING IS THE FEATURE, which is why this is a persisted store field and not
   * component state: it has to survive leaving Speak, and it has to survive a relaunch.
   *
   * ── IT IS NOT A SECOND `conciergeSendMode`, AND OFF IS NOT "SEND" ───────────────────────────────
   * The field above answers *what happens when I stop talking* at the level of the microphone. This
   * answers a narrower question that only exists inside Speak: the silence countdown runs either
   * way, still ends the dictated utterance either way, and still honours the type-during-the-
   * countdown pause either way. With this off the words simply STAY IN THE COMPOSER and wait for a
   * press. Wiring it into the countdown's arming instead would delete a behaviour the founder
   * separately asked for and had built — see voice/useAutoSend's `autoSend` doc.
   *
   * ── DEFAULT **ON**, WHICH IS THE OPPOSITE POSTURE FROM THE FIELD ABOVE, DELIBERATELY ────────────
   * `conciergeSendMode` defaults to `send` because arming an irreversible dispatcher is not
   * something to do on a user's behalf. That argument does not transfer here, because it has
   * already been satisfied: reaching this setting at all requires having deliberately moved the
   * tray to Speak, which IS the once-and-deliberately consent that doc is about. Given that consent,
   * Speak has auto-sent since the day it shipped — so defaulting this OFF would silently change what
   * an existing user's chosen mode does, with no notice and nothing on screen to explain why their
   * dictation stopped going out. A new default is not a safer default when it breaks the shipped
   * behaviour of a mode the user already picked.
   *
   * NAMED `conciergeSpeakAutoSend`, NOT `conciergeAutoSend`. That exact key is retired: it was the
   * pre-tray boolean, and ./composerPersist's v3 migration DELETES it while translating it into
   * `conciergeSendMode`. Reusing the name would put a live field in the path of a migration written
   * to destroy it — harmless only for as long as nobody's blob is old enough to be re-migrated.
   */
  conciergeSpeakAutoSend: boolean;
  setConciergeSpeakAutoSend: (v: boolean) => void;
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
      zoomByColumn: defaultZoomByColumn(),
      setColumnZoom: (column, z) =>
        set((s) => ({ zoomByColumn: { ...s.zoomByColumn, [column]: clampZoom(z) } })),
      stepColumnZoom: (column, direction) =>
        set((s) => ({
          zoomByColumn: {
            ...s.zoomByColumn,
            // Stepped from the column's OWN level, read inside the updater rather than passed in.
            // A caller that read the level, added a step and called `setColumnZoom` would lose a
            // press to any interleaving write — and auto-repeat on a held Cmd+= makes that ordinary
            // rather than theoretical.
            [column]: steppedZoom(s.zoomByColumn[column] ?? ZOOM_DEFAULT, direction),
          },
        })),
      resetColumnZoom: (column) =>
        set((s) => ({ zoomByColumn: { ...s.zoomByColumn, [column]: ZOOM_DEFAULT } })),
      stepAllZoom: (direction) =>
        set((s) => {
          const next = {} as Record<ZoomColumn, number>;
          // Each column steps from ITS OWN level, so a row of differently-zoomed columns keeps its
          // relative sizes instead of being flattened onto one value by a global press.
          for (const key of ZOOM_COLUMNS) {
            next[key] = steppedZoom(s.zoomByColumn[key] ?? ZOOM_DEFAULT, direction);
          }
          return { zoomByColumn: next };
        }),
      resetAllZoom: () => set({ zoomByColumn: defaultZoomByColumn() }),
      activeSpecial: null,
      setActiveSpecial: (v) => set({ activeSpecial: v }),
      themePref: "auto",
      setThemePref: (v) => set({ themePref: v }),
      conciergeComposeH: null,
      setConciergeComposeH: (h) => set({ conciergeComposeH: h }),
      statusFilter: { needs_you: true, questions: true, running: true, done: true },
      toggleStatusBand: (b) =>
        set((s) => ({ statusFilter: { ...s.statusFilter, [b]: !s.statusFilter[b] } })),
      showAllStatusBands: () =>
        set({ statusFilter: { needs_you: true, questions: true, running: true, done: true } }),
      setStatusFilter: (f) => set({ statusFilter: { ...f } }),
      isolateStatusBand: (b) =>
        set({
          statusFilter: {
            needs_you: b === "needs_you",
            questions: b === "questions",
            running: b === "running",
            done: b === "done",
          },
        }),
      workModeBySide: { ...DEFAULT_WORK_MODE_BY_SIDE },
      // Writes ONLY the named side. The other side's entry is carried through untouched — that
      // non-clobbering is the whole point of the map, and it is what the per-column board test
      // asserts by keeping two different boards open at once.
      // ENTERING PLAN IS TWO WRITES, AND THIS IS THE ONLY PLACE THAT KNOWS THAT.
      //
      // A column's board is gated on `!sparkleActive` (Workspace) because the board and the
      // Improve-Sparkle pane render into the same stage and are no longer two values of one enum.
      // So a caller that sets the mode alone gets a HALF state: the chevron, the row list and the
      // filter bar all move to Plan while the stage keeps showing the Sparkle terminal — and
      // `reconcileWorkMode` returns null while a special is up, so nothing recovers it.
      //
      // That was found twice, on three different call sites (the chevron, the `navigate` wire op,
      // and the concierge's `set_work_mode`), which is the tell that it should never have been two
      // writes at the call site. It is one action now, and the fix cannot drift out of a path again.
      //
      // Scoped to the pane-owning side: there is exactly ONE Improve-Sparkle pane and it lives in
      // the primary pair's stage, so a left column entering Plan must not close it.
      openPlanBoard: (side) => {
        get().setWorkMode(side, "plan");
        if (side === SPARKLE_PANE_SIDE) set({ activeSpecial: null });
      },
      // THE MIRROR, and it needs to exist for the same reason. The Improve-Sparkle pane covers
      // WHICHEVER surface the column is showing, so "show me the Build stage" is the same two
      // writes as "show me the board" — the first version of this pairing was applied only to the
      // Plan half, which left `set_work_mode("build")` refusing as a no-op while the pane sat on
      // the terminal. That state is the MORE common one: "build" is the default, and selecting
      // Improve Sparkle never touches the mode.
      showBuildStage: (side) => {
        get().setWorkMode(side, "build");
        if (side === SPARKLE_PANE_SIDE) set({ activeSpecial: null });
      },
      // THE SAME PAIRING FOR PREVIEW, for the same reason and with the same scope. The preview slot
      // covers the pair exactly as the board does, and the Improve-Sparkle pane renders into that
      // pair's stage — so a caller that set the mode alone would get the half state this family
      // exists to prevent: the chevron on Preview while the Sparkle terminal keeps the stage, with
      // `reconcileWorkMode` answering null (a special is up) so nothing recovers it.
      //
      // NOTE what this does NOT do: it does not start a server. Opening the pane and opening a
      // preview process are different acts with different owners — `services/preview.openPreview`
      // is the one that talks to Rust — and conflating them here would make a mode flip spawn a
      // node process. The slot renders the CURRENT state of that agent's preview, whatever it is.
      openPreview: (side) => {
        get().setWorkMode(side, "preview");
        if (side === SPARKLE_PANE_SIDE) set({ activeSpecial: null });
      },
      setWorkMode: (side, m) =>
        set((s) =>
          s.workModeBySide[side] === m ? {} : { workModeBySide: { ...s.workModeBySide, [side]: m } },
        ),
      boardFocusBeadId: null,
      setBoardFocusBeadId: (id) => set({ boardFocusBeadId: id }),
      boardAgentFilterBySide: { left: null, right: null },
      setBoardAgentFilter: (side, id) =>
        set((st) =>
          st.boardAgentFilterBySide[side] === id
            ? {}
            : { boardAgentFilterBySide: { ...st.boardAgentFilterBySide, [side]: id } },
        ),
      focusedNoticeBySide: { left: null, right: null },
      setFocusedNotice: (side, noticeId) =>
        set((st) =>
          st.focusedNoticeBySide[side] === noticeId
            ? {}
            : { focusedNoticeBySide: { ...st.focusedNoticeBySide, [side]: noticeId } },
        ),
      boardFilterBySide: { left: NO_BOARD_FILTER, right: NO_BOARD_FILTER },
      // Identity-stable when nothing actually changed, matching setBoardAgentFilter above: the
      // filter bar re-asserts the current value on every render of its controls, and a fresh object
      // each time would re-run BoardView's narrowing memo (and re-render every card) on a no-op.
      setBoardFilter: (side, filter) =>
        set((st) => {
          const cur = st.boardFilterBySide[side];
          if (
            cur.priority === filter.priority &&
            cur.dateField === filter.dateField &&
            cur.dateWindow === filter.dateWindow
          ) {
            return {};
          }
          return { boardFilterBySide: { ...st.boardFilterBySide, [side]: filter } };
        }),
      buildAgentHover: false,
      setBuildAgentHover: (v) => set({ buildAgentHover: v }),
      cloudCreateProjectId: null,
      setCloudCreateProjectId: (id) => set({ cloudCreateProjectId: id }),
      collapsedOrchestrators: {},
      // Absent → collapsed (workers start hidden behind the roll-up).
      isOrchestratorCollapsed: (id) => get().collapsedOrchestrators[id] ?? true,
      // THE ONE WRITER. See the interface note above for why this is the only one.
      setOrchestratorsCollapsed: (ids, collapsed) =>
        set((s) => {
          // Identity-stable when this changes nothing, so a caller may re-assert the current state
          // without re-rendering every consumer of the record. `?? true` is the absent-is-collapsed
          // default, read here so "collapse a row that was never expanded" correctly does nothing.
          if (ids.every((id) => (s.collapsedOrchestrators[id] ?? true) === collapsed)) return s;
          const next = { ...s.collapsedOrchestrators };
          for (const id of ids) next[id] = collapsed;
          return { collapsedOrchestrators: next };
        }),
      toggleOrchestratorCollapsed: (id) =>
        get().setOrchestratorsCollapsed([id], !(get().collapsedOrchestrators[id] ?? true)),
      expandOrchestrators: (ids) => get().setOrchestratorsCollapsed(ids, false),
      settingsRequest: null,
      openSettings: (cat) => set({ settingsRequest: cat }),
      clearSettingsRequest: () => set({ settingsRequest: null }),
      promoteAgentId: null,
      openPromoteToCloud: (agentId) => set({ promoteAgentId: agentId }),
      closePromoteToCloud: () => set({ promoteAgentId: null }),
      demoteAgentId: null,
      openDemoteToLocal: (agentId) => set({ demoteAgentId: agentId }),
      closeDemoteToLocal: () => set({ demoteAgentId: null }),
      composeFocusSeq: 0,
      // EVERY caller of this is the user asking for the caret — the drop pill's "go to compose"
      // button, a file drop, spawning an agent, the capture-window handoff. ComposeBox's effect
      // relies on that: it names the concierge as the voice surface outright. An APP-driven refocus
      // must NOT use this seam; give it one of its own.
      requestComposeFocus: () => set((s) => ({ composeFocusSeq: s.composeFocusSeq + 1 })),
      revealAgentId: null,
      revealAnchorY: null,
      requestRevealAgent: (id, opts) => {
        // Arm the deadline BEFORE publishing the id, so there is no window in which a pending
        // request exists without an expiry attached to it.
        cancelRevealExpiry();
        revealExpiryTimer = setTimeout(() => {
          revealExpiryTimer = null;
          // Id-guarded like clearRevealAgent: a newer request must not be cancelled by an older
          // timer that somehow outlived its own cancellation.
          set((s) => (s.revealAgentId === id ? { revealAgentId: null, revealAnchorY: null } : s));
        }, REVEAL_REQUEST_TTL_MS);
        // SET TOGETHER, ALWAYS. A caller with no anchor must CLEAR the previous one rather than
        // leave it standing: a stale Y from an earlier click would otherwise steer an unrelated
        // reveal (a spawn, a tool call) to wherever the cursor happened to be minutes ago.
        set({ revealAgentId: id, revealAnchorY: opts?.anchorY ?? null });
      },
      // Id-guarded so a row can only retire ITS OWN request: without the check, a stale effect from
      // a row unmounting mid-spawn would swallow the request that named a different row.
      clearRevealAgent: (id) => {
        if (get().revealAgentId !== id) return;
        cancelRevealExpiry();
        set({ revealAgentId: null, revealAnchorY: null });
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
      conciergeSendMode: "send",
      setConciergeSendMode: (v) => set({ conciergeSendMode: v }),
      // ON by default — and NOT symmetric with the line above, which is the point. See the field's
      // doc: picking Speak is the deliberate consent, and Speak has auto-sent since it shipped.
      conciergeSpeakAutoSend: true,
      setConciergeSpeakAutoSend: (v) => set({ conciergeSpeakAutoSend: v }),
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
      // v3: the boolean `conciergeAutoSend` became the three-position `conciergeSendMode`. An
      // armed blob lands on "speak" rather than silently resetting to microphone-off.
      // v4: the global `zoom` became `zoomByColumn`. Every region is seeded from the old number, so
      // an upgrading user's terminals keep the text size they set rather than snapping back to 1.0.
      version: 4,
      migrate: (persisted, version) =>
        migratePersistedUi(persisted as Record<string, unknown>, version, COMPOSER_SNAP) as unknown as UiState,
      // Strip the transient keys on the way IN as well. `partialize` only stops us WRITING them;
      // zustand's default merge shallow-merges whatever the blob happens to contain, and
      // migratePersistedUi passes unknown keys through untouched. So a blob written by any build
      // before a key was excluded — or hand-edited — restores it at launch. Observed with
      // zeroCreditBannerDismissed: dismiss the $0 banner once and every later launch starts
      // dismissed, still at zero balance, with AI extras silently dark and nothing to undo it.
      //
      // THE REPAIRS BELONG HERE, NOT IN `migrate`. zustand calls `migrate` ONLY when the stored
      // version differs from the configured one (middleware.js: `deserializedStorageValue.version
      // !== options.version`). So a repair wired through `migrate` is UNREACHABLE for every blob
      // already at the current version — which is exactly the population that needs it. The
      // `activeSpecial: "board"` repair shipped that way first and was inert: `version` stayed 2,
      // every affected blob was written at 2, migrate was skipped, and `"board"` merged straight
      // back in. `merge` is the hook zustand runs on EVERY rehydrate, so a repair here is
      // unconditional in fact and not just in the comment.
      //
      // Applied only to keys the blob ACTUALLY carries, so one that never had them does not gain
      // them — the store's own defaults already answer, and inventing keys here would defeat the
      // "unknown keys pass through untouched" contract above.
      merge: (persisted, current) => {
        const stored = { ...(persisted as Record<string, unknown>) };
        for (const key of TRANSIENT_UI_KEYS) delete stored[key];
        if ("activeSpecial" in stored) stored.activeSpecial = repairActiveSpecial(stored.activeSpecial);
        // NO `statusFilter` REPAIR HERE ANY MORE, and its absence is the stronger guarantee rather
        // than a gap: the key is in TRANSIENT_UI_KEYS (see the note there), so the loop above has
        // already deleted it and the store's own all-bands-visible default answers. A repair on this
        // line would be unreachable code claiming to protect a band that no longer arrives. The pure
        // `repairStatusFilter` still exists and is still unit-tested in composerPersist — it is the
        // blob that stopped reaching it.
        // The send tray's position, repaired on EVERY rehydrate for the same reason as the two
        // above — `migrate` only runs on a version mismatch, so a corrupt blob already at the
        // current version would otherwise hydrate verbatim and leave the tray with no pill reading
        // selected and dead arrow keys (roborev 56071).
        if ("conciergeSendMode" in stored)
          stored.conciergeSendMode = repairSendMode(stored.conciergeSendMode);
        // The per-column zoom map, repaired on EVERY rehydrate and for the sharpest version of the
        // reason above: this merge is SHALLOW, so a stored map REPLACES the complete default rather
        // than filling in around it. A blob carrying four of the six keys therefore hydrates
        // `undefined` for the rest, and `undefined` is not "unzoomed" — it multiplies into `NaN`,
        // reaches `term.options.fontSize`, and blanks that column's terminal on every launch until
        // localStorage is edited by hand.
        if ("zoomByColumn" in stored) stored.zoomByColumn = repairZoomByColumn(stored.zoomByColumn);
        return { ...current, ...(stored as Partial<UiState>) };
      },
    },
  ),
);

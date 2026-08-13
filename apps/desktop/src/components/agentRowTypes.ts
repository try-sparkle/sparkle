import type { Project, AgentTab, AgentTabStatus } from "../types";
import type { BranchStatus } from "../services/branchStatus";
import type { BuildSectionId } from "../engine/buildSections";
import type { WorkflowStageId } from "../engine/workflowStage";
import type { PairSide } from "../engine/rowGeometry";
import type { WorkerDetail } from "./workerDetail";

/**
 * AgentRow's props and the memo comparator that decides when a row may skip a re-render.
 *
 * Separated from the component because they are the CONTRACT between the column's root and its
 * rows, and the two are edited for different reasons: adding a prop is a change to what the root
 * must supply, while changing the row's markup is not. `agentRowPropsEqual` is load-bearing for the
 * column's render cost, so it is worth being able to read it without scrolling past 2,000 lines of
 * JSX. Moved verbatim out of AgentSidebar.tsx; no logic change.
 */

export type AgentRowProps = {
  project: Project;
  a: AgentTab;
  depth: number;
  isActive: boolean;
  /** True when this row IS the project's selected agent, regardless of whether a floating pane is
   *  covering the column. `isActive` is that AND-ed with `!paneCoversMe`, which is right for PAINT
   *  but wrong for the click-again fold — see the computation site. */
  isSelected: boolean;
  st: AgentTabStatus;
  /**
   * The row's status BEFORE `withStallAttention` escalated it — the one the stall question is asked
   * about.
   *
   * Two statuses, and they must not be conflated. `st` drives the DOT, and once the escalation is
   * composed a stalled row arrives here as `blocked`. `stallReport` answers `active` for the whole
   * red tier, so asking it about `st` would return no causes at all: the row would go red and
   * simultaneously lose the sentence saying WHY, which is the entire point of reddening it. So the
   * colour reads `st` and the cause reads this. Equal to `st` for every row that was not escalated.
   */
  calmSt: AgentTabStatus;
  /** Is this row's worker subtree collapsed? `null` means "no disclosure here" — a row with no
   *  workers, or a worker row itself. Only a head with ≥1 worker gets a chevron. */
  subtreeCollapsed: boolean | null;
  /** Flip this row's subtree. Only called when `subtreeCollapsed` is non-null. */
  onToggleSubtree: () => void;
  statusColor: string;
  /** Paint the leading disc this instead of the row's own status color, and hover it as `dotLabel`.
   *  Set ONLY on an orchestrator head whose workers roll up to a different band than its own status
   *  — including the `mixedInk` orange, which is not a status at all (engine/workerRollup). Both are
   *  undefined on every other row, and the two always travel together. */
  /** This row is the column's single tab stop (roving tabindex): exactly one rendered row has it,
   *  so the whole tree is ONE Tab stop and arrow keys move within it. */
  isTabStop: boolean;
  dotColor?: string;
  dotLabel?: string;
  /** Draw the leading disc as a RING rather than a fill: the color describes a row UNDER this one,
   *  not this one. Set exactly where `dotColor` is — see StatusDot's `variant`. */
  dotRing?: boolean;
  /** The alert toggle to show on this row's expanded card: "dismiss" (truly red, not dismissed),
   *  "reenable" (red-underneath but dismissed), or null (not red). Computed from the TRUE status. */
  alertControl: "dismiss" | "reenable" | null;
  /** Acknowledge this row's red alert (recolor + drop out of the red zone; status untouched). */
  onDismissAlert: () => void;
  /** Clear a dismissal so the row goes red again. */
  onReenableAlert: () => void;
  bs?: BranchStatus;
  trackerStage: WorkflowStageId | null;
  /** This agent has reached On Main at least once → render a sticky ✓ on the progress line. */
  shipped?: boolean;
  // Number of workers under this row (orchestrators only; 0 for workers/leaf agents) — shown in
  // the hover card's "Progress" line.
  workerCount: number;
  // The orchestrator's workers, rendered inline on this row (collapsed lines + expanded detail).
  // `[]` for every non-orchestrator row.
  workers: WorkerDetail[];
  // The agent's current row in the ordered top-level stack (undefined for nested workers).
  // Passed to renameAgent so a manual rename anchors the row there (the unified pin). Also the
  // drop index for drag-reorder. The drag props are only acted on for top-level rows.
  // Which ladder section this row renders in (undefined for a nested worker row, which is not
  // independently draggable). Drag-reorder is only offered WITHIN a section — see dragSection.
  rowSection?: BuildSectionId;
  // The section the in-flight drag STARTED in, or null when nothing is being dragged. A row only
  // presents itself as a drop target when this matches its own section, so a cross-section drag
  // shows no landing spots at all rather than lighting up and then silently refusing the drop.
  dragSection: BuildSectionId | null;
  dragActive: boolean;
  /** Which side of this row its own terminal is on — this sidebar's pair side. The cockpit is
   *  `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`, so it decides which end bleeds and which end takes
   *  the leading radius. See engine/rowGeometry. */
  paneSide: PairSide;
  /** Does this pair hold the live cable? Opens the row's CONCIERGE end too, so a wired row reads as
   *  a length of cable seated in two sockets rather than one. */
  jointOpen: boolean;
  /** The measured width of the build column, or 0 before the first measurement. Threaded rather
   *  than measured per row: forty rows each holding their own ResizeObserver on the same element is
   *  forty callbacks per resize frame for one number. Drives `stageChipShows`; 0 takes the WIDE
   *  form so booting does not flicker the chip in on every row at once. Bead sparkle-tyter. */
  columnWidth: number;
  onDragStartAgent: (id: string, section?: BuildSectionId) => void;
  onDragEndAgent: () => void;
  onDropAgent: (targetId: string, targetSection?: BuildSectionId) => void;
  editing: boolean;
  /** `retroReceiptsVersion()` at render time — a CHANGE TOKEN, never read for its value.
   *
   *  The row's retirement pill reads the receipt cache synchronously through `cachedReceipt`, which
   *  is a module-level Map: nothing about it is a prop, so `agentRowPropsEqual` could not see a
   *  receipt arriving and the memoized row kept painting RETRO PENDING indefinitely (knightwatch
   *  probe 6). Subscribing in the column alone was not enough — it re-renders the PARENT, and the
   *  memo comparator then finds every prop unchanged and skips the row. */
  receiptVersion: number;
  setEditing: (id: string | null) => void;
  /** Called on activation — a CLICK, a keyboard Enter/Space, or a right-click opening the card.
   *  There is no hover caller: selection is click-only (see HOVER_INTENT_MS's headstone).
   *
   *  SELECTION ONLY, AND NO LONGER THE MOUNT. It seats the agent and hands the caret to its
   *  terminal; patching the cable is {@link onMount}'s job. Splitting the two is the founder's
   *  2026-08-12 rule — see `engine/cable`'s `mountsOnRowActivation` for which gesture does which. */
  onSelect: () => void;
  /** Patch the cable onto this row — the DOUBLE click (and the activations that have no double
   *  form: Enter/Space, and an assistive-tech click). Always preceded by an {@link onSelect} for the
   *  same row, so a mount is a superset of a select rather than an alternative to it. */
  onMount: () => void;
  onLand: () => void;
  onClose: () => void;
};

// Do two orchestrator worker view-models render identically? Compared field-by-field (the closures
// are excluded — see agentRowPropsEqual) so a fresh `workers` array built each parent render doesn't
// force the orchestrator row to re-render when none of its workers' DISPLAY data actually changed.
export function workerDetailsEqual(a: WorkerDetail[], b: WorkerDetail[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.autoTitle !== y.autoTitle ||
      x.description !== y.description ||
      x.stage !== y.stage ||
      x.status !== y.status ||
      x.statusColor !== y.statusColor ||
      x.branchStatus !== y.branchStatus || // branchStatus[id] ref is stable unless that agent polled
      x.shipped !== y.shipped ||
      x.worktreePath !== y.worktreePath ||
      x.baseBranch !== y.baseBranch ||
      x.active !== y.active
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Memo comparator for AgentRow (sparkle-alrm.3). A row re-renders ONLY when its OWN display data
 * changes — so one agent's frequent status flip re-paints just that agent's row instead of the whole
 * sidebar subtree. Every data prop is compared here; the callback props (onSelect/onLand/onClose/
 * drag handlers/setEditing) are deliberately EXCLUDED, and the close/reselect paths read live store
 * state via getState(), so a slightly-stale callback closure can never act on stale data. This list
 * MUST stay exhaustive: omitting a DATA prop that changed makes this return `true`, which SKIPS the
 * re-render and leaves the row painting stale data (a visual/correctness bug, not merely an extra
 * render).
 *
 * `project` is compared BY THE FIELDS THE ROW READS — `id`, `rootPath`, and the `agents` array —
 * NOT by object identity (). This is the same shape `arePanePropsEqual` uses for the pane:
 * a bare `prev.project === next.project` defeated the memo for EVERY project-level write, and the
 * hottest such write is a pure SELECTION change — `selectAgent` mints a fresh project object that
 * differs only in `selectedAgentId`, a field this row never reads (the selection highlight arrives as
 * the separately-compared `isActive` prop). Comparing identity therefore re-rendered all 60 rows on
 * every click and every hover step (the "latency moving between build-agent rows" report); comparing
 * the three read fields drops that to the two rows whose `isActive` actually flipped. It is SAFE for
 * the excluded closures precisely because a pure selection change touches none of what they capture
 * (`a`, `a.id`, `project.id`, `trueSt`): the skipped row's stale closure is byte-identical to a fresh
 * one. Any write that changes an agent still mints a new `agents` array (via mapAgent), so the row —
 * and its closures — refresh exactly as before. The row reads no other project field and forwards no
 * whole-`project` to a child, so these three are the complete set (audited against the row body).
 */
export function agentRowPropsEqual(prev: AgentRowProps, next: AgentRowProps): boolean {
  return (
    prev.project.id === next.project.id &&
    prev.project.rootPath === next.project.rootPath &&
    prev.project.agents === next.project.agents &&
    prev.a === next.a &&
    prev.depth === next.depth &&
    prev.isActive === next.isActive &&
    prev.isSelected === next.isSelected &&
    prev.st === next.st &&
    prev.calmSt === next.calmSt &&
    prev.subtreeCollapsed === next.subtreeCollapsed &&
    prev.statusColor === next.statusColor &&
    prev.isTabStop === next.isTabStop &&
    prev.dotColor === next.dotColor &&
    prev.dotLabel === next.dotLabel &&
    prev.dotRing === next.dotRing &&
    prev.alertControl === next.alertControl &&
    prev.bs === next.bs &&
    prev.trackerStage === next.trackerStage &&
    prev.shipped === next.shipped &&
    prev.workerCount === next.workerCount &&
    prev.rowSection === next.rowSection &&
    prev.dragSection === next.dragSection &&
    prev.dragActive === next.dragActive &&
    // Both are GEOMETRY inputs: miss them here and a project moved to the other pair, or a cable
    // patched in, leaves every already-mounted row painting the old side's box.
    prev.paneSide === next.paneSide &&
    prev.jointOpen === next.jointOpen &&
    // A THIRD GEOMETRY INPUT (bead sparkle-tyter). The stage chip is hidden below
    // STAGE_CHIP_MIN_COLUMN_PX, so a row memoized across a resize would keep painting the chip at a
    // width that no longer has room for it — the precise class of bug this comparator's own header
    // warns about, where an omitted prop silently freezes the row on stale data.
    prev.columnWidth === next.columnWidth &&
    prev.editing === next.editing &&
    // The receipt cache is not a prop — this token is how its change crosses the memo boundary.
    prev.receiptVersion === next.receiptVersion &&
    workerDetailsEqual(prev.workers, next.workers)
  );
}

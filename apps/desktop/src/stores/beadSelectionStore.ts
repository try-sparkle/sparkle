// apps/desktop/src/stores/beadSelectionStore.ts
//
// Which beads the board has ticked, per project — the state behind the "Move to epic…" /
// "Unparent" bar (bead `sparkle-xelans.2`).
//
// ══ ITS OWN FILE, AND THAT IS A DELIBERATE CHOICE ABOUT WHO ELSE IS EDITING ════════════════════
// The obvious home is `uiStore.ts`, which already holds the board's per-side view state. It is also
// the single most contended file in this tree — several branches and worktrees are inside it at any
// moment — so a five-line addition there is a guaranteed merge conflict for a piece of state that
// nothing else reads. A leaf store costs one import and conflicts with nobody.
//
// ══ AN ORDERED LIST, NOT A SET ════════════════════════════════════════════════════════════════
// The ids go straight into ONE `bd update <id>… --parent <epic>` (see `services/beadReparent.ts`),
// and the argv is what the tests assert. A `Set` iterates in insertion order in practice but says
// nothing about it in the type, so the array is the honest shape: the user's click order is the
// order bd is handed, and that is reproducible. Duplicates are impossible by construction —
// {@link BeadSelectionState.toggle} is the only way in, and it removes what it finds.
//
// TRANSIENT ON PURPOSE — nothing here is persisted. A tick survives a poll (the board re-renders
// every few seconds and must not lose the selection mid-gesture) but not a relaunch, where a
// restored selection would be a set of checkboxes the user has no memory of ticking, pointed at
// beads that may since have closed.
import { create } from "zustand";

/** Returned for a project with nothing ticked. A module-level constant, not a fresh `[]`: a zustand
 *  selector is compared by identity, so returning a new empty array each read would re-render every
 *  subscriber on every unrelated store write. Same reason `BoardView` keeps `NO_BEADS`. */
const NONE: readonly string[] = [];

export interface BeadSelectionState {
  /**
   * Whether the board is in SELECT MODE for a project — i.e. whether the per-card ticks exist at
   * all. Off everywhere by default.
   *
   * ══ WHY THE TICKS ARE OPT-IN RATHER THAN ALWAYS ON ═══════════════════════════════════════════
   * The collapsed board is a READ/NAVIGATE surface, and that is not a preference — it is pinned by
   * `BoardView.test.tsx`, which asserts there is no `input`, `select` or `textarea` anywhere on it
   * (the one deliberate exception being the comment box on an OPENED card). A checkbox on every
   * card breaks that rule for a gesture almost nobody is mid-way through, and it puts a control in
   * front of the several hundred cards a real column holds. It also collides concretely: the
   * criteria popover's own checkbox is found by `getAllByRole("checkbox")[0]`, which a per-card tick
   * would silently become.
   *
   * So the board offers a `Select` toggle, and only while it is on do the ticks exist.
   */
  selectMode: Record<string, boolean | undefined>;
  /** Turn select mode on or off for a project. Turning it OFF clears the selection — see below. */
  setSelectMode: (projectId: string, on: boolean) => void;
  /** Ticked bead ids per project id, in click order. A missing entry means nothing is ticked. */
  selected: Record<string, readonly string[] | undefined>;
  /** Tick an unticked bead, or untick a ticked one. The only way an id enters the selection. */
  toggle: (projectId: string, beadId: string) => void;
  /** Drop the whole selection for a project — after a completed move, or on the Clear button. */
  clear: (projectId: string) => void;
  /** The ticked ids for a project, in click order. Never undefined; see {@link NONE}. */
  selectionFor: (projectId: string) => readonly string[];
  /** Whether one bead is ticked. */
  isSelected: (projectId: string, beadId: string) => boolean;
  /**
   * Forget ticked ids that are no longer on the board.
   *
   * The snapshot is replaced by a poll every few seconds and beads leave it — an agent closes one,
   * or a filter narrows the board under a selection the user made before applying it. A tick
   * pointing at a bead that is no longer visible is invisible AND live: the next "Move to epic"
   * would silently carry it along, or, if the bead is gone from bd entirely, fail the whole batch
   * with a message naming an id the user cannot see. Writes nothing when every id still stands, so
   * it is safe to call from an effect that runs on every poll.
   */
  retain: (projectId: string, presentIds: ReadonlySet<string>) => void;
}

export const useBeadSelectionStore = create<BeadSelectionState>()((set, get) => ({
  selectMode: {},
  selected: {},

  setSelectMode: (projectId, on) =>
    set((s) => {
      // LEAVING SELECT MODE CLEARS THE SELECTION, and that is the same rule `retain` enforces for a
      // different reason: a tick nobody can see is invisible AND live. Hiding the checkboxes while
      // keeping what they held would leave the bar's next "Move to epic" carrying beads the user
      // last ticked minutes ago and has no way to review.
      const { [projectId]: _dropped, ...rest } = s.selected;
      return { selectMode: { ...s.selectMode, [projectId]: on }, selected: on ? s.selected : rest };
    }),

  toggle: (projectId, beadId) =>
    set((s) => {
      const current = s.selected[projectId] ?? NONE;
      const next = current.includes(beadId)
        ? current.filter((id) => id !== beadId)
        : [...current, beadId];
      // An emptied selection drops its key rather than holding a `[]`, so `selectionFor` hands back
      // the shared NONE again and the project reads as untouched.
      if (next.length === 0) {
        const { [projectId]: _emptied, ...rest } = s.selected;
        return { selected: rest };
      }
      return { selected: { ...s.selected, [projectId]: next } };
    }),

  clear: (projectId) =>
    set((s) => {
      if (s.selected[projectId] === undefined) return s; // nothing to clear; do not churn identity
      const { [projectId]: _cleared, ...rest } = s.selected;
      return { selected: rest };
    }),

  selectionFor: (projectId) => get().selected[projectId] ?? NONE,

  isSelected: (projectId, beadId) => (get().selected[projectId] ?? NONE).includes(beadId),

  retain: (projectId, presentIds) =>
    set((s) => {
      const current = s.selected[projectId];
      if (current === undefined) return s;
      const kept = current.filter((id) => presentIds.has(id));
      // NO WRITE WHEN NOTHING WENT. This runs on every poll tick, and replacing the array with an
      // equal one would re-render every card subscribing to the selection several times a minute.
      if (kept.length === current.length) return s;
      if (kept.length === 0) {
        const { [projectId]: _emptied, ...rest } = s.selected;
        return { selected: rest };
      }
      return { selected: { ...s.selected, [projectId]: kept } };
    }),
}));

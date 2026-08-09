// Is the live browser preview the thing covering THIS pair?
//
// The sibling of `engine/planBoard.planBoardUp`, deliberately shaped the same way: one rule, one
// place, asked with a COLUMN'S OWN mode and its own project so two pairs can answer differently at
// the same moment. Writing the predicate inline at the render site is what made the plan board a
// singleton (see that file's header) — this one starts where that one ended up.
//
// WHY IT HAS NO `beadsEnabled`-SHAPED THIRD TERM, i.e. why previewability is not asked here. The
// board falls back to the terminal when Beads is off because the Plan chevron disappears with it
// and a column parked in Plan would otherwise strand the user in an empty board. Preview is not
// that shape: the slot renders a real state for every outcome — starting, failed, crashed, or "no
// server" — and it always carries its own way back to Build. Gating the SLOT on previewability
// would mean a project whose capability probe has not answered yet (it is an async invoke) flickers
// the user out of a mode they explicitly chose. Previewability gates the AFFORDANCES that offer the
// mode (the toggle segment, the hover-card action), which is where §7 rule 5 puts it: absent, never
// greyed. Once you are in the mode, the pane's job is to tell you the truth about the server.
import type { WorkMode } from "./workMode";

/**
 * True when this column should show the preview slot over its pair.
 *
 *  - `mode` — THIS column's mode (`uiStore.workModeBySide[side]`), never a shared value.
 *  - `hasProject` — a preview belongs to an agent in a project; a column with no project open has
 *    no worktree to point a dev server at, so there is nothing to cover.
 */
export function previewSlotUp(mode: WorkMode, hasProject: boolean): boolean {
  return mode === "preview" && hasProject;
}

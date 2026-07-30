// Is the Plan board the thing filling THIS column's terminal slot?
//
// One rule, one place. It used to be spelled out inline as `activeSpecial === "board" && !!project
// && beadsEnabled` in BOTH Workspace and SatelliteApp — two copies of a predicate whose first term
// was a WINDOW-global. That global is what made the board a singleton: the left column's Plan
// chevron wrote it, and the right pair was the only renderer that read it, so pressing Plan on the
// left opened the board on the right and clobbered whatever was there.
//
// The column's own `workMode` is now the only truth. Each pair asks this question with ITS OWN
// mode and ITS OWN project, so two columns can answer differently at the same time — which is
// exactly the property the singleton could not represent.
import type { WorkMode } from "./workMode";

/**
 * True when this column should show the Plan board in place of its terminal.
 *
 *  - `mode` — THIS column's chevron (`uiStore.workModeBySide[side]`), never a shared value.
 *  - `hasProject` — the board is per-project (it renders that project's beads), so a column with
 *    no project has nothing to draw; the empty-state hint shows instead.
 *  - `beadsEnabled` — with the Beads tool off the board is used nowhere and the Plan chevron is
 *    hidden, so a column left parked in Plan must fall back to its terminal rather than render an
 *    empty board it offers no way out of.
 */
export function planBoardUp(mode: WorkMode, hasProject: boolean, beadsEnabled: boolean): boolean {
  return mode === "plan" && hasProject && beadsEnabled;
}

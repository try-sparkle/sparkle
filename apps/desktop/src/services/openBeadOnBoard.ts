// OPENING A BEAD ON THE PLANNING BOARD — the four writes, in the one order that works.
//
// Extracted from `Concierge/BeadPill.tsx`, verbatim apart from the name and the export. Nothing
// about the sequence changed in the move; the comments below are the originals and they record
// which roborev finding each clause is the fix for.
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { sideOf } from "../engine/pairs";
import { selectProjectOnItsSide } from "./openProjectTab";
import { markProjectOpen } from "./projectTabs";

/**
 * OPEN A BEAD ON THE PLANNING BOARD, on that bead's own side, with the board focused on its
 * card. The one implementation, called from every surface that offers the destination.
 *
 * ══ WHY THIS IS A SERVICE AND NOT A THIRD COPY ══════════════════════════════════════════════════
 * It lived inside `Concierge/BeadPill.tsx` as `viewOnBoard`, whose own comment said it *"belongs
 * in a shared service and this comment is the marker for that extraction"*. The Epics column's
 * card is the second surface to need it (bead sparkle-42onk2), and the note was not decoration:
 * the sequence had ALREADY been copy-derived wrongly — `selectProject` where
 * `selectProjectOnItsSide` was meant — in four places, one of which shipped the bug (roborev
 * 55149 / 55158 / 55192 / 68041). Worse, main's narrow copy came back through a clean merge, and
 * every fixture ran with the default `pairAssignment` (which resolves to "right"), so the wrong
 * form was ACCIDENTALLY CORRECT in the whole suite and nothing went red. One function is the only
 * shape that cannot drift.
 *
 * ══ THE ORDER IS LOAD-BEARING ═══════════════════════════════════════════════════════════════════
 * `openPlanBoard` FIRST, `setBoardFocusBeadId` SECOND. The focus id is a ONE-SHOT that `BoardView`
 * consumes and clears once the bead is present; set against a board the Sparkle pane is still
 * covering, the handoff is spent on a surface that never renders and the overlay simply never opens
 * (roborev 55887, the same trap the sidebar's epic pill documents).
 *
 * `openPlanBoard`, never a bare `setWorkMode(side, "plan")` — the latter only moves the chevron and
 * leaves the board invisible, which is the identical failure by a different route.
 *
 * ══ WHICH SIDE, AND WHY IT IS DERIVED RATHER THAN PICKED ════════════════════════════════════════
 * This is the real design question in the handoff, and it is worth naming: `boardFocusBeadId` is
 * GLOBAL while its sibling `boardAgentFilterBySide` is keyed by side, and the concierge column has
 * no natural `PairSide` at all — it sits BETWEEN the two pairs and belongs to neither.
 *
 * So the side is not chosen; it is READ from where the bead's project already lives.
 * `sideOf(pairAssignment, projectId)` is total and defaults to `"right"` (the historical single-pair
 * home), so every install answers, including one that has never assigned anything. That beats a
 * hard-coded side on the case that actually matters — a two-pair cockpit, where a fixed choice
 * would open the board in the wrong half of the screen for exactly the projects the second pair
 * exists to hold.
 *
 * The bead's project is also SELECTED first. The board is per-side and shows that side's current
 * project, so focusing a bead in a project the side is not displaying would open a board that never
 * contains it — the handoff would sit unconsumed and the click would look like it did nothing.
 */
export function openBeadOnBoard(target: { beadId: string; projectId: string }): boolean {
  const projects = useProjectStore.getState();
  // Nothing to open a board FOR. Reported rather than assumed: the caller turns `false` into a
  // sentence, which is the whole point of the boolean.
  if (!projects.projects.some((p) => p.id === target.projectId)) return false;
  // ══ OPEN THE TAB BEFORE SELECTING IT — `markProjectOpen` IS NOT OPTIONAL ══════════════════
  // `selectProjectOnItsSide` writes only `selectedProjectId` / `leftProjectId`. Neither marks the
  // project OPEN, and `Workspace` resolves a side through `resolveSideProject`, which filters to
  // OPEN projects first and then discards a selection that is not on that side's open list — it
  // falls back to `onSide[0]`. So for a project whose tab the reader has CLOSED, the selection is
  // thrown away, the focus writes land on a side displaying a DIFFERENT project, and the column
  // empties out while the board opens focused on a bead it does not contain. The existence guard
  // above asks "does this project exist", not "is it open", so the function still returns `true`
  // and the card shows no notice.
  //
  // `buildAgentSpawn.ts` states the rule outright: markProjectOpen BEFORE selectProject, never
  // bare — the two are paired at every other seam. `openAgent` below is already immune because it
  // goes through `openProjectTab`, which does both.
  markProjectOpen(target.projectId);
  // ══ `selectProjectOnItsSide`, NEVER `selectProject` ═══════════════════════════════════════
  // `projectStore.selectProject` writes the RIGHT pair's `selectedProjectId` and nothing else, so
  // pairing it with a side DERIVED from `pairAssignment` makes the two writes disagree for any
  // LEFT-assigned project: the left project's id lands in the right pair's slot, `Workspace`'s
  // reconcile effect discards it, and the right half of the cockpit silently re-navigates to its
  // own first project — while the left side narrows to an epic the project it shows does not
  // contain. `selectProjectOnItsSide` is the helper extracted for exactly this (roborev 55149 /
  // 55158 / 55192), and this branch already fixed the identical defect in
  // `EpicInlineCard.openBeadCardOnBoard` (roborev 68041).
  //
  // IT CAME BACK THROUGH A MERGE, WHICH IS THE PART WORTH REMEMBERING: main's copy of the narrow
  // form arrived here without the widened rule, and git resolved it silently because the two sides
  // never touched the same line. Every fixture in `BeadPill.openEpic.test.tsx` runs with the
  // default `pairAssignment`, which resolves to "right" — so `selectProject` is accidentally
  // correct in all of them and the suite stayed green.
  selectProjectOnItsSide(target.projectId);
  const ui = useUiStore.getState();
  ui.openPlanBoard(sideOf(ui.pairAssignment, target.projectId));
  ui.setBoardFocusBeadId(target.beadId);
  return true;
}

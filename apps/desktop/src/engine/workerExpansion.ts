// Which workers under a collapsed orchestrator are asking for the user — the PEEK's content.
//
// WHAT THIS MODULE USED TO BE, AND WHY THE REST OF IT IS GONE. It decided when a subtree should pop
// OPEN on its own (a worker under it entering the `needs_you` band) and when the app should close one
// it had opened again. Both are deleted. A parent's expanded state is USER STATE: it is written by
// the user's own gesture — the head-row click, or the column header's expand-all / collapse-all —
// and by nothing else. Not a status transition, not a worker appearing, not a re-render, not a
// relaunch. The single writer is `uiStore.setOrchestratorsCollapsed`; see its note for why that
// makes "a row opened by itself" unrepresentable rather than merely fixed.
//
// The auto-expander was not wrong about any single step; it was wrong as a composition. Expansion
// was automatic and collapsing deliberately was not ("yanking a subtree shut while the user is
// reading it is worse than leaving it open"), so a worker going red opened its parent and the parent
// then stayed open once the red cleared. The steady state of that pair is a subtree standing open
// under a project the user never touched, showing a GREEN worker — attention nowhere in sight.
//
// THE DISCIPLINES THE DELETED CODE HELD, and how the peek satisfies them rather than abandoning
// them. Each cost a bug to learn, and a future "small" re-addition of auto-expansion brings all of
// them back:
//
//   * TRANSITION, NOT STATE. Auto-expansion had to fire on the rising edge into `needs_you` and never
//     on a steady red, or it would re-open a subtree the user had just collapsed on the very next
//     render. The peek needs no edge detector: it is derived from the CURRENT statuses every render
//     and writes nothing, so there is no state to re-assert and nothing to re-open.
//   * FIRST SIGHTING IS A BASELINE, NEVER A TRIGGER. On boot the previous snapshot was empty, so
//     without a guard every parent looked like it had just changed and they all blew open, making the
//     persisted collapse worthless on every relaunch. With no writer there is no relaunch behaviour
//     to get wrong: the persisted collapse is simply what renders.
//   * A SYNTHETIC RED IS NOT A REAL ONE. `withUnstartedWorkerAttention` paints a worker whose
//     worktree is cut but whose pane never mounted, a condition produced by an internal open/evict
//     race (orchestrationListener.ensureWorkersOpen has observed the same worker re-opened ~10 times
//     in a sub-millisecond burst) rather than by anything the user did. Honouring it would have let
//     invisible machinery re-open a subtree repeatedly; today it would make the peek flicker at that
//     same rate. The `isLive` predicate below is what excludes it, in both eras.
//
// What is NOT carried over is the three-state snapshot's `unknown` ("a reading is still coming for
// some worker under this head"). It existed to stop AUTO-COLLAPSE acting on a fact it did not have —
// at launch the status map is empty, so every head read quiet and every persisted mark slammed shut
// and re-opened a beat later (roborev 53994, 54018, 54031). With nothing closing rows on the user's
// behalf there is no such decision to protect, and the peek asks only the two-valued question below.
//
// Pure and DOM-free so it can be unit-tested directly.
import type { AgentKind, AgentTabStatus } from "../types";
import { bandOfStatus } from "./buildSections";

/** The workers under `headId` that are actually asking for you — the peek's content.
 *
 *  THREE predicates, and all three are load-bearing. A child that is not `kind: "worker"` never
 *  renders as a child row, so peeking for it would name a row the subtree cannot show. A worker with
 *  no live PTY status is excluded because its red would be SYNTHETIC — see the note on the
 *  open/evict race above. And the band comes from the shared `bandOfStatus` rather than a local
 *  "is it red" list, so the peek, the row dots and the filter chips cannot drift apart.
 *
 *  GREEN AND GRAY WORKERS NEVER APPEAR HERE — only the `needs_you` band does, which is what keeps
 *  the peek an attention affordance rather than a second, sneakier expansion. This is also the ONLY
 *  thing deciding whether a peek renders at all: the caller draws a line iff this returns non-empty.
 *  (A second gate in the component was deleted for exactly that reason — while both existed, each
 *  masked the other and neither could be shown by a test to matter.) */
export function attentionWorkersOf<
  T extends { id: string; kind: AgentKind; parentId: string | null },
>(
  agents: readonly T[],
  headId: string,
  statusOf: (id: string) => AgentTabStatus,
  isLive: (id: string) => boolean,
): T[] {
  return agents.filter(
    (a) =>
      a.kind === "worker" &&
      a.parentId === headId &&
      isLive(a.id) &&
      bandOfStatus(statusOf(a.id)) === "needs_you",
  );
}

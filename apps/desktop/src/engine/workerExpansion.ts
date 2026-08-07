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
 *  TWO KINDS OF ASK REACH THE PEEK, and the second one was the headline bug this module carried:
 *
 *    1. The `needs_you` BAND — waiting/approval/errored/blocked. Taken from the shared
 *       `bandOfStatus` rather than a local "is it red" list, so the peek, the row dots and the
 *       filter chips cannot drift apart.
 *    2. `unmerged` — "Needs merge". It bands `done` (buildSections) because it is GRAY, a landing
 *       state rather than an alarm, and for a long time that kept it out of here entirely. But
 *       worker rows default to COLLAPSED, so a worker has no row of its own by default; the peek
 *       was its only surface, and the parent's gray dot said "nothing here". An orchestrator with
 *       three workers each holding an un-landed PR rendered as ONE collapsed gray row — three
 *       things the user owes, zero pixels, and he cannot know what he was not shown. The founder's
 *       product rule (bead sparkle-qogah.3, P0) names "Needs merge" as an action he owes and says
 *       such a row is never hidden. So it peeks. This is an ASK the user can act on, not an alarm:
 *       nothing about the gray COLOUR of the row changes here, only whether it has a surface.
 *
 *  CALM WORKERS STILL NEVER APPEAR — green and the resting grays (idle/done/stopped/new) — which is
 *  what keeps the peek an attention affordance rather than a second, sneakier expansion. This is
 *  also the ONLY thing deciding whether a peek renders at all: the caller draws a line iff this
 *  returns non-empty. (A second gate in the component was deleted for exactly that reason — while
 *  both existed, each masked the other and neither could be shown by a test to matter.)
 *
 *  NO CAP, EVER. Eight workers owing a merge is eight entries. "If uncapping makes a surface tall,
 *  that is CORRECT. Scroll it; do not hide it" — the same rule. (What the CALLER does with the list
 *  is its own business: AgentSidebar's WorkerPeek renders one line and shows a COUNT when there are
 *  several, which states the number rather than concealing it.)
 *
 *  `kind: "worker"` is required because a child that is not a worker never renders as a child row,
 *  so peeking for it would name a row the subtree cannot show. */
export function attentionWorkersOf<
  T extends { id: string; kind: AgentKind; parentId: string | null },
>(
  agents: readonly T[],
  headId: string,
  statusOf: (id: string) => AgentTabStatus,
  /** Does this worker have a live PTY reading? Gates the RED arm only — see {@link isOwedAsk}. */
  isLive: (id: string) => boolean,
): T[] {
  return agents.filter((a) => {
    if (a.kind !== "worker" || a.parentId !== headId) return false;
    const status = statusOf(a.id);
    // THE LIVENESS GUARD APPLIES TO THE RED ARM ONLY, and that asymmetry is the point rather than an
    // oversight. `isLive` exists to reject a SYNTHETIC red: `withUnstartedWorkerAttention` paints a
    // worker whose worktree is cut but whose pane never mounted — a condition produced by the
    // internal open/evict race (orchestrationListener has observed the same worker re-opened ~10
    // times in a sub-millisecond burst), not by anything the user did. Honouring it would make the
    // peek flicker at that rate.
    //
    // `unmerged` cannot be manufactured that way. engine/unmergedAttention derives it from the
    // workflow STAGE — durable git branch/PR evidence — and deliberately escalates agents sitting in
    // `stopped`, i.e. precisely the ones with NO live reading ("a persisted-but-unlanded tab still
    // lights up"). So a worker with an un-landed PR and no live pane is not an untrustworthy signal;
    // it is the most STRANDED thing on the fleet and the case the user most needs to see. Gating it
    // on liveness would have left the headline bug unfixed for exactly the workers it hurts most.
    // The synthetic-red protection is untouched: a never-live `errored` worker is still excluded.
    if (isOwedAsk(status)) return true;
    // THE `questions` BAND PEEKS TOO. It is BLUE rather than red — an ask you can answer, not an
    // alarm — but the peek's question is "does this dot hide something the user must act on", and a
    // question is the most directly answerable thing on the fleet. Omitting it reopened, for the
    // newest band, exactly the hole `unmerged` had: worker rows default to collapsed, so a
    // questioning worker under a folded head had no row, no peek line, and a parent dot that files
    // under someone else's chip. Gated on `isLive` with the reds, because a blue is a live screen
    // reading like they are — only `unmerged` is derived from durable git evidence.
    const band = bandOfStatus(status);
    return isLive(a.id) && (band === "needs_you" || band === "questions");
  });
}

/** A status that is CALM in colour but still owes the user an action.
 *
 *  Named rather than inlined so the reason travels with it, and kept to `unmerged` on purpose: this
 *  is not a second copy of the band taxonomy (the header of workerRollup.ts explains at length why
 *  spelling out status lists here is how the taxonomy drifts). It is the one documented exception —
 *  a status whose gray COLOUR is a deliberate 2026-07-26 decision (27 of 51 agents in that band made
 *  red meaningless) but whose MEANING is "open or merge the PR", an ask that must not be hidden. */
function isOwedAsk(status: AgentTabStatus): boolean {
  return status === "unmerged";
}

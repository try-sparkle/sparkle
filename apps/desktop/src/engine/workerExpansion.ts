// When an orchestrator's worker subtree should pop open on its own.
//
// The default is CLOSED — `uiStore.collapsedOrchestrators` reads a MISSING entry as collapsed — and
// that is deliberate: a fleet of orchestrators each showing its workers is a wall of rows nobody
// asked for. The subtree opens by itself for exactly one reason: a worker under it needs YOU. The
// signal is the `needs_you` status band (waiting / approval / blocked / errored), the same band the
// filter chips and the row dots use.
//
// This used to be "expand a parent the moment it GAINS a worker", which popped every subtree open on
// every spawn — the behavior this replaced. Attention, not growth: a spawn is not an event that
// requires the user, and a collapsed orchestrator whose worker goes red ALREADY shows red on its own
// head row (the head rolls its workers up — see AgentSidebar's headStageOf + the red-worker overlays
// in engine/workerAttention.ts), so nothing is hidden by a subtree that stays shut.
//
// TWO disciplines this module exists to hold, both of which cost a bug to learn:
//
//  1. TRANSITION, NOT STATE. Expand when a parent goes from "no red worker" to "has a red worker",
//     never on every render while a worker merely REMAINS red — that would re-open a subtree the
//     user just deliberately collapsed, on the very next render, and make the chevron feel broken.
//     Which is also why this is a module rather than an inline check: it needs a previous snapshot.
//
//  2. FIRST SIGHTING IS A BASELINE, NEVER A TRIGGER. On boot the previous snapshot is empty, so
//     without this every parent looks like it just changed and they ALL blow open, making the
//     persisted collapse choice worthless on every relaunch. An id absent from the previous snapshot
//     is therefore recorded and skipped. (This is also why a boot-time "expand everything currently
//     red" pass is NOT wanted: it would fight the persisted choice, and the red head row already
//     tells the user where to look.)
//
// And one deliberate ASYMMETRY: there is no auto-COLLAPSE when the red clears. Yanking a subtree
// shut while the user is reading it is worse than leaving it open. Expansion is automatic;
// collapsing stays the user's gesture.
//
// Derived from a COMPARISON rather than from a status callback because workers change state through
// several paths — the live PTY status map, reconcileWorkersFromDisk, a cross-window adopt, and the
// synthetic overlays in engine/workerAttention.ts — and none of them is a single hook to subscribe
// to. Pure and DOM-free so it can be unit-tested directly.
import type { AgentKind, AgentTabStatus } from "../types";
import { bandOfStatus } from "./buildSections";

/** Per-orchestrator: does this parent have a worker in the `needs_you` band right now?
 *
 *  EVERY build agent gets an entry, explicitly `false` when no worker of its needs you. That false
 *  is the load-bearing part, not noise: {@link expandOnWorkerAttention} reads a MISSING id as "never
 *  observed" and skips it, so if calm parents were omitted, an orchestrator's first red worker would
 *  arrive against an absent baseline and be classified as a first sighting rather than a transition.
 *  The subtree would stay collapsed for the one alarm that most needs to be seen, and only a SECOND
 *  red would open it. (That was the shape of the growth rule's first cut — roborev 53672.)
 *
 *  `statusOf` is the sidebar's `effectiveStatus` accessor, so a DISMISSED alarm is already
 *  de-escalated by the time it reaches here and correctly does not re-open anything.
 *
 *  `isLive` is "does this worker have a live PTY status of its own", and a worker without one is
 *  treated as CALM however red `statusOf` paints it. That is not an optimization, it is the second
 *  half of discipline 1. `withUnstartedWorkerAttention` synthesizes a red `approval` for a worker
 *  whose worktree is cut but whose pane never mounted — a condition produced by an internal
 *  open/evict race (orchestrationListener.ensureWorkersOpen has observed the same worker re-opened
 *  ~10 times in a sub-millisecond burst), not by anything the user did. Each evict→re-open cycle is
 *  a falling edge followed by a fresh RISING one, so honoring it would let invisible machinery
 *  re-open a subtree the user just collapsed, over and over — the exact failure "transition, not
 *  state" exists to prevent, reached through the falling edge instead of the steady one. Nothing is
 *  lost: the strand still bubbles its red to the orchestrator's own head row, which is where the
 *  user looks and clicks.
 *
 *  Only `kind: "worker"` children are considered: they are the only agents that render as child
 *  rows, so anything else would expand a parent for a row the subtree never shows. And the band
 *  comes from the shared `bandOfStatus` rather than a local "is it red" list — the app collapses
 *  nine statuses to three bands in ONE place on purpose (packages/ui/tokens.ts). */
export function workerAttention<T extends { id: string; kind: AgentKind; parentId: string | null }>(
  agents: readonly T[],
  statusOf: (id: string) => AgentTabStatus,
  isLive: (id: string) => boolean,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  // Two passes: a build agent can appear after its own worker in the array (disk reconcile adopts in
  // no guaranteed order), and seeding in one pass would let `out[parent] = false` clobber a flag
  // already recorded for it.
  for (const a of agents) {
    if (a.kind === "build") out[a.id] = false;
  }
  for (const a of agents) {
    if (a.kind !== "worker" || !a.parentId) continue;
    if (!isLive(a.id)) continue; // a never-live worker's red is synthetic — see above
    if (bandOfStatus(statusOf(a.id)) !== "needs_you") continue;
    out[a.parentId] = true;
  }
  return out;
}

/** The orchestrator ids that just went from "no red worker" to "has a red worker", and so should be
 *  expanded.
 *
 *  Rising edge only. A steady `true` reports nothing (discipline 1 above), a falling edge reports
 *  nothing (we never auto-collapse), and ids absent from `prev` report nothing (discipline 2). */
export function expandOnWorkerAttention(
  prev: Record<string, boolean>,
  next: Record<string, boolean>,
): string[] {
  const attention: string[] = [];
  for (const [id, red] of Object.entries(next)) {
    const before = prev[id];
    if (before === undefined) continue; // first sighting is a baseline, not a transition
    if (red && !before) attention.push(id);
  }
  return attention;
}


// ---------------------------------------------------------------------------
// THE OTHER HALF: when a subtree the app opened should close itself again.
//
// The module header above states an asymmetry — expansion automatic, collapsing the user's gesture —
// on the grounds that yanking a subtree shut while someone is reading it is worse than leaving it
// open. That reasoning is right about the subtree you are READING and wrong about every other one:
// with no way back, a fleet that has settled leaves a wall of green worker rows the user never asked
// to keep, and the only undo is one chevron click per orchestrator. So the asymmetry narrows to its
// actual justification rather than disappearing:
//
//   * a subtree the APP opened closes again once no worker under it needs you;
//   * EXCEPT the one you are reading — the selected head, or the head of the selected worker. That
//     second case is not politeness: a selected worker with no visible row leaves the terminal
//     showing an agent nothing in the sidebar points at, the original reason workers have rows;
//   * EXCEPT a subtree you opened YOURSELF with the chevron. Only the app's own expansions are the
//     app's to undo — uiStore's `autoExpandedOrchestrators` mark is what records the difference,
//     and `collapseAutoExpanded` refuses anything unmarked.
//
// It reads the SAME `workerAttention` snapshot the expansion does, so "the red dot went out" and
// "the subtree closed" cannot disagree — including a worker whose red is synthetic (never live),
// which that snapshot already counts as calm, and a dismissed alarm, which `statusOf` has already
// de-escalated. One notion of attention, two directions.

/** The AUTO-expanded orchestrator ids that should now close: `attention` says nothing under them
 *  needs you, and the user is not reading that subtree.
 *
 *  A head absent from `attention` is left alone rather than closed — it is a head this pass never
 *  observed (a different project's, mid-reconcile), and "not observed" is not "calm". A head present
 *  with no workers at all IS closed: it reads `false`, renders no chevron, and an auto mark left on
 *  it is stale bookkeeping.
 *
 *  Disjoint from {@link expandOnWorkerAttention} by construction — that one reports only rising
 *  edges to `true`, this one only ids sitting at `false` — so a caller may apply both in either
 *  order without them fighting over an id in the same tick. */
export function autoCollapseTargets<
  T extends { id: string; kind: AgentKind; parentId: string | null },
>(
  agents: readonly T[],
  attention: Record<string, boolean>,
  isAutoExpanded: (headId: string) => boolean,
  selectedAgentId: string | null,
): string[] {
  // The parent of the selected agent, if it is a worker — the one indirect exemption. Resolved once
  // rather than by scanning each head's children, so this stays a single pass over `agents`.
  const selected = selectedAgentId === null ? undefined : agents.find((a) => a.id === selectedAgentId);
  const selectedParentId = selected?.kind === "worker" ? selected.parentId : null;
  const out: string[] = [];
  for (const a of agents) {
    if (a.kind !== "build") continue;
    if (attention[a.id] !== false) continue; // needs you, or never observed this pass
    if (!isAutoExpanded(a.id)) continue; // the user's own expansion is theirs to undo
    if (a.id === selectedAgentId || a.id === selectedParentId) continue; // you are reading it
    out.push(a.id);
  }
  return out;
}

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

/** What one orchestrator's worker subtree is saying about itself right now.
 *
 *  THREE states, not two, and the third is the whole point: `unknown` means "this pass has no PTY
 *  reading for at least one worker under this head". It was a boolean at first, with a not-yet-live
 *  worker folded into `false`. That is correct for the EXPAND direction, which only ever acts on a
 *  rising edge to `needs_you` and so treats a missing reading as "nothing to do" — and wrong for the
 *  COLLAPSE direction added later, which acts on `calm` and so read "I don't know" as "nothing needs
 *  you" and shut the subtree on it (roborev 53994). Two ways that bit:
 *
 *    * AT LAUNCH `runtimeStore.status` is empty and fills in as panes mount, so the first pass saw
 *      every head as calm and closed every subtree carrying a PERSISTED auto mark — which then
 *      re-opened a moment later when the PTY reported red. An open/shut/open flash, with a persisted
 *      write per bounce.
 *    * IN THE OPEN/EVICT RACE a worker's status entry disappears and comes back (see below), so each
 *      round was a close followed by a rising-edge re-open. The never-live-is-calm rule exists to
 *      keep that race from re-opening subtrees; on the collapse side it re-created the same flap
 *      from the other end.
 *
 *  `unknown` drives NEITHER direction, so a missing reading does nothing at all — which is what "we
 *  have no information" should mean.
 *
 *  And it means a reading we are still WAITING FOR, not merely one we don't have. The first cut said
 *  "no live status ⇒ unknown", which is permanent for a worker whose pane is closed: `runtimeStore`
 *  does not persist `status`, so such a worker is statusless for the whole session, its head reads
 *  `unknown` forever, and auto-collapse is dead for that head — the wall of settled worker rows this
 *  feature exists to clear, only now with a persisted mark that never clears either (roborev 54018).
 *  So the caller says whether a reading is EXPECTED (`expectsLiveStatus`): a mounted pane that has
 *  not reported yet, or a spawned-but-unstarted strand. A pane closed alongside its orchestrator
 *  expects nothing and reads calm, so its head collapses like any other. (A strand — pane shut,
 *  orchestrator live — stays `unknown` on purpose: it is painted red and being re-opened, and its
 *  row is the one the user has to click. See the predicate in AgentSidebar.) */
export type WorkerAttention = "needs_you" | "unknown" | "calm";

/** Per-orchestrator: is a worker under this parent asking for you, is one unreadable, or is the
 *  subtree quiet?
 *
 *  EVERY build agent gets an entry, explicitly `calm` when no worker of its needs you. That entry is
 *  the load-bearing part, not noise: {@link expandOnWorkerAttention} reads a MISSING id as "never
 *  observed" and skips it, so if quiet parents were omitted, an orchestrator's first red worker would
 *  arrive against an absent baseline and be classified as a first sighting rather than a transition.
 *  The subtree would stay collapsed for the one alarm that most needs to be seen, and only a SECOND
 *  red would open it. (That was the shape of the growth rule's first cut — roborev 53672.)
 *
 *  `statusOf` is the sidebar's `effectiveStatus` accessor, so a DISMISSED alarm is already
 *  de-escalated by the time it reaches here and correctly does not re-open anything.
 *
 *  `isLive` is "does this worker have a live PTY status of its own", and a worker without one is
 *  never `needs_you` however red `statusOf` paints it — it makes its parent `unknown` when
 *  `expectsLiveStatus` says a reading is still coming, and says nothing at all when it isn't. That is
 *  not an optimization, it is the second half of discipline 1. `withUnstartedWorkerAttention` synthesizes a
 *  red `approval` for a worker whose worktree is cut but whose pane never mounted — a condition
 *  produced by an internal open/evict race (orchestrationListener.ensureWorkersOpen has observed the
 *  same worker re-opened ~10 times in a sub-millisecond burst), not by anything the user did. Each
 *  evict→re-open cycle is a falling edge followed by a fresh RISING one, so honoring it would let
 *  invisible machinery re-open a subtree the user just collapsed, over and over — the exact failure
 *  "transition, not state" exists to prevent, reached through the falling edge instead of the steady
 *  one. Nothing is lost: the strand still bubbles its red to the orchestrator's own head row, which
 *  is where the user looks and clicks.
 *
 *  `needs_you` OUTRANKS `unknown`: a live worker sitting on a question is a fact, and one unreadable
 *  sibling must not demote it to "no information" and swallow the expand.
 *
 *  Only `kind: "worker"` children are considered: they are the only agents that render as child
 *  rows, so anything else would expand a parent for a row the subtree never shows. And the band
 *  comes from the shared `bandOfStatus` rather than a local "is it red" list — the app collapses
 *  nine statuses to three bands in ONE place on purpose (packages/ui/tokens.ts). */
export function workerAttention<T extends { id: string; kind: AgentKind; parentId: string | null }>(
  agents: readonly T[],
  statusOf: (id: string) => AgentTabStatus,
  isLive: (id: string) => boolean,
  expectsLiveStatus: (worker: T) => boolean,
): Record<string, WorkerAttention> {
  const out: Record<string, WorkerAttention> = {};
  // Two passes: a build agent can appear after its own worker in the array (disk reconcile adopts in
  // no guaranteed order), and seeding in one pass would let `out[parent] = "calm"` clobber a state
  // already recorded for it.
  for (const a of agents) {
    if (a.kind === "build") out[a.id] = "calm";
  }
  for (const a of agents) {
    if (a.kind !== "worker" || !a.parentId) continue;
    if (!isLive(a.id)) {
      // No PTY reading for this worker: its red would be synthetic and its calm would be a guess.
      // Only counts as `unknown` while a reading is still expected — a closed pane is not a pending
      // one, and treating it as such would pin its head open for the rest of the session.
      if (expectsLiveStatus(a) && out[a.parentId] !== "needs_you") out[a.parentId] = "unknown";
      continue;
    }
    if (bandOfStatus(statusOf(a.id)) !== "needs_you") continue; // live and quiet: says nothing
    out[a.parentId] = "needs_you";
  }
  return out;
}

/** The orchestrator ids that just went from "no red worker" to "has a red worker", and so should be
 *  expanded.
 *
 *  Rising edge only. A steady `needs_you` reports nothing (discipline 1 above), a falling edge
 *  reports nothing (expansion is automatic, collapsing is the rule below), and ids absent from
 *  `prev` report nothing (discipline 2).
 *
 *  `unknown` → `needs_you` DOES count: that is a worker whose pane finally came live still asking,
 *  and the subtree has to open for it. `unknown` itself is never a target — you cannot expand on a
 *  reading you do not have. */
export function expandOnWorkerAttention(
  prev: Record<string, WorkerAttention>,
  next: Record<string, WorkerAttention>,
): string[] {
  const attention: string[] = [];
  for (const [id, state] of Object.entries(next)) {
    const before = prev[id];
    if (before === undefined) continue; // first sighting is a baseline, not a transition
    if (state === "needs_you" && before !== "needs_you") attention.push(id);
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
 *  ONLY `calm` closes. A head reading `unknown` is left open — some worker under it has no PTY
 *  reading this pass, and closing on that would act on a fact we do not have (roborev 53994: at
 *  launch the status map is empty, so every head would read quiet and every persisted auto mark
 *  would slam shut and re-open a beat later). A head absent from `attention` entirely is likewise
 *  left alone — that one belongs to another project, or arrived mid-reconcile. A head present with
 *  no workers at all IS closed: it reads `calm`, renders no chevron, and an auto mark left on it is
 *  stale bookkeeping.
 *
 *  Disjoint from {@link expandOnWorkerAttention} by construction — that one reports only rising
 *  edges to `needs_you`, this one only ids sitting at `calm` — so a caller may apply both in either
 *  order without them fighting over an id in the same tick. */
export function autoCollapseTargets<
  T extends { id: string; kind: AgentKind; parentId: string | null },
>(
  agents: readonly T[],
  attention: Record<string, WorkerAttention>,
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
    if (attention[a.id] !== "calm") continue; // needs you, unreadable, or not seen this pass
    if (!isAutoExpanded(a.id)) continue; // the user's own expansion is theirs to undo
    if (a.id === selectedAgentId || a.id === selectedParentId) continue; // you are reading it
    out.push(a.id);
  }
  return out;
}

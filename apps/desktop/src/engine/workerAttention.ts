// Detect and surface the "spawned but never started" worker strand.
//
// The orchestrator spawns a worker by cutting its worktree and calling open() once. If a
// reconcile()/remount race then evicts that worker from the cross-window-shared openAgentIds
// before its pane mounts, the worker is stranded behind the "Start this agent" button: it never
// launches, its orchestrator's wait_for_workers polls a result.json that never comes, and — because
// a never-launched worker has NO entry in the live status map — every status surface renders it
// GRAY ("stopped"), so nothing tells you you're the blocker.
//
// This module is the single source of truth for "which workers are stranded", feeding two fixes:
//   1. self-healing auto-open (workersNeedingOpen) — re-assert open() so the strand can't persist;
//   2. a RED overlay (withUnstartedWorkerAttention) — when a strand DOES linger, paint the worker
//      and its orchestrator red so it surfaces at the top instead of hiding in gray.
import type { AgentTab } from "../types";
import { needsAttention, type StatusMap } from "./attention";
import { isInMotion } from "./inMotion";
import { isRedStatus } from "../services/windowStatus";

// TWO predicates, used for two different questions — see the trap note in packages/ui/tokens.ts.
// This module previously used `needsAttention` for BOTH, behind comments that said "RED", which is
// how a `blocked` worker ended up never bubbling to its orchestrator at all (2026-07-26).
//
//   isRedStatus(s)   — "is this row painted red?"          waiting | approval | errored | blocked
//   needsAttention(s) — "is this stopping ME, right now?"   waiting | approval | errored
//
// `blocked` is the status that separates them: the agent went quiet and may need unsticking, but
// nothing is waiting on your answer. That distinction decides two things below — what the in-motion
// suppression may swallow, and which red may overwrite which on the orchestrator's row.
//
// Both are called by their real names at every site, deliberately: the first cut aliased them to
// `isRed`/`isAsk` plus an `alwaysBubbles` wrapper, which made `grep needsAttention` in this module
// return one line and hid the very coupling the comment exists to advertise (roborev on 4b3ede48,
// flagged independently by both reviewers).

/** A worker whose worktree was cut but which has NO live PTY `status` yet — regardless of whether it
 *  is in `openIds` this instant. This is the part of the strand condition that a re-open does NOT
 *  change: `open()` only mounts the pane, and the worker isn't actually live until its PTY reports a
 *  status. {@link isUnstartedWorker} is this plus "and it isn't open, under a live orchestrator".
 *
 *  Split out so the self-heal can tell "this worker finally came up" (→ forget it) apart from "my
 *  last open() briefly landed and was evicted again" (→ still the same unresolved strand). Keying
 *  that distinction on `openIds` instead would reset on every ping-pong round, which is exactly the
 *  case the heal needs to be able to count. */
export function isNotYetLiveWorker(agent: AgentTab, statusMap: StatusMap): boolean {
  return (
    agent.kind === "worker" &&
    agent.parentId !== null &&
    agent.worktreePath !== null &&
    statusMap[agent.id] === undefined
  );
}

/** A worker whose worktree was cut but which never went live — not in `openIds`, no PTY `status` —
 *  WHILE its orchestrator is live (`openIds.has(parentId)`). A running worker has a status entry; a
 *  mid-spawn/queued one has no worktree yet; a spun-down one is gone from `agents`. So this matches
 *  exactly the spawned-but-idle "Start this agent" strand.
 *
 *  The parent-is-open clause is what keeps "a worker should be live iff its orchestrator is live": it
 *  excludes a worker whose orchestrator the user deliberately closed (e.g. project relocation closes
 *  every agent — clearing each one's status — so a relocated worker would otherwise look identical to
 *  a fresh strand and get force-reopened mid-move). In the real strand the orchestrator is running
 *  (it just called spawn_worker), so it's open and the clause holds. */
export function isUnstartedWorker(
  agent: AgentTab,
  statusMap: StatusMap,
  openIds: ReadonlySet<string>,
): boolean {
  return (
    isNotYetLiveWorker(agent, statusMap) &&
    agent.parentId !== null &&
    openIds.has(agent.parentId) &&
    !openIds.has(agent.id)
  );
}

/** The materialized-but-unstarted workers among `agents`, in array order. The self-healing
 *  auto-open re-opens exactly these, so a reconcile/remount race can't strand them for good. */
export function workersNeedingOpen(
  agents: readonly AgentTab[],
  statusMap: StatusMap,
  openIds: ReadonlySet<string>,
): AgentTab[] {
  return agents.filter((a) => isUnstartedWorker(a, statusMap, openIds));
}

/** Overlay the RED `approval` ("Approve?" — i.e. "approve starting this agent") status onto every
 *  unstarted worker, and bubble it to that worker's parent orchestrator so the block shows on the
 *  top-level dot too. The orchestrator is painted red even when it's "working" (its REPL is alive,
 *  blocked polling for the worker) — that IS the signal the user asked for — but an orchestrator
 *  already red for a more specific reason (errored / its own question) is left untouched.
 *
 *  Returns a NEW map; the input is never mutated. When nothing is unstarted the SAME reference is
 *  returned, so consumers re-render no differently than before. One helper feeds the TopBar dot
 *  cluster and the sidebar so both agree a stranded worker — and the orchestrator it blocks — needs
 *  you. */
export function withUnstartedWorkerAttention(
  agents: readonly AgentTab[],
  statusMap: StatusMap,
  openIds: ReadonlySet<string>,
): StatusMap {
  let out: StatusMap | null = null;
  const ensure = (): StatusMap => (out ??= { ...statusMap });
  for (const a of agents) {
    if (!isUnstartedWorker(a, statusMap, openIds)) continue;
    ensure()[a.id] = "approval";
    // a.parentId is non-null here (isUnstartedWorker guarantees it). Same asymmetric rule as
    // withRedWorkerAttention below, and for the same reason: this synthesized `approval` IS a
    // needs-you-now status, so it must not be shadowed by a parent that is merely `blocked`, while a
    // parent already asking on its own behalf keeps its more specific reason. Leaving this one on the
    // plain color-tier guard was inconsistent AND cosmetic-only — the pipeline runs
    // withRedWorkerAttention over this map immediately afterward, where the ask would overwrite the
    // parent's `blocked` anyway — so the two functions now simply agree (roborev on f7b43dc8).
    // `needsAttention` alone, not `!isRedStatus(p) || !needsAttention(p)`: the needs-you-now set is a
    // SUBSET of the red tier, so that longer form reduced to exactly this while implying a status
    // that is needs-you-now but not red — which cannot exist — and inviting the wrong simplification.
    // The local binding is what lets TS see the non-null parentId the predicate above guarantees.
    const parentId = a.parentId;
    if (parentId !== null && !needsAttention(statusMap[parentId])) {
      ensure()[parentId] = "approval";
    }
  }
  return out ?? statusMap;
}

/** Bubble a RED worker's attention up to its orchestrator so the orchestrator floats to the top of
 *  the fleet and shows red — the signal that "a worker under this build needs you". Unlike
 *  withUnstartedWorkerAttention (which invents an `approval` status for a worker with NO status),
 *  this reads each worker's EXISTING status: a worker that started and then went red — ANY red-tier
 *  status, `blocked` included (services/windowStatus.isRedStatus) — already carries its own red, so
 *  we don't touch the worker, we only paint its parent. Note the contrast with the ask-always-bubbles
 *  rule below, which really is the narrow waiting/approval/errored set; the two lists differ on
 *  purpose, and getting them backwards is what kept `blocked` from bubbling at all.
 *
 *  The worker's own red status is what promotes it to a selectable pop-out row in the sidebar (see
 *  AgentSidebar); this function is purely the parent-bubble half so the block is visible from the
 *  collapsed top-level stack too. An orchestrator already red for its own reason is left as-is (we
 *  never downgrade one red to another). Returns a NEW map only when something changed; otherwise the
 *  SAME reference, so a no-op can't churn renders. Compose AFTER withUnstartedWorkerAttention.
 *
 *  IN-MOTION SUPPRESSION (the 2026-07-22 report: "why is this red when it's in motion?"), NARROWED
 *  on 2026-07-26. A parent that is still MOVING — working itself, or with another worker mid-build
 *  (see engine/inMotion.ts) — does not get the bubble for a NON-ASK red. The fleet is progressing and
 *  the orchestrator handles its own workers; painting the top-level row red because one worker went
 *  quiet is noise, and it fires precisely when the user can see the agent is busy, which is what made
 *  the signal read as a bug.
 *
 *  But a REAL ASK (waiting/approval/errored) always bubbles, in motion or not. The first cut
 *  suppressed those too, and that was the other half of the 2026-07-26 report: in a six-worker fleet
 *  a single busy sibling was enough to hide a worker that was sitting on a question, so the fleet
 *  looked healthy while one strand was stopped dead. A moving sibling is not evidence that a
 *  question answered itself. Nothing is lost in either direction — a suppressed `blocked` worker
 *  still carries its own red on its own row, and the moment the fleet SETTLES the bubble returns. */
export function withRedWorkerAttention(
  agents: readonly AgentTab[],
  statusMap: StatusMap,
): StatusMap {
  let out: StatusMap | null = null;
  const ensure = (): StatusMap => (out ??= { ...statusMap });
  // Computed against the INPUT map, once per parent: the bubbles this loop writes are reds, which
  // never make a parent in-motion, so a later worker can't observe a different answer than an
  // earlier one. Memoized because a large fleet asks the same question for every worker.
  const motion = new Map<string, boolean>();
  const parentInMotion = (parentId: string): boolean => {
    let m = motion.get(parentId);
    if (m === undefined) {
      m = isInMotion(parentId, agents, statusMap);
      motion.set(parentId, m);
    }
    return m;
  };
  for (const a of agents) {
    if (a.kind !== "worker" || a.parentId === null) continue;
    // Read from the working copy so a bubble from an earlier worker in this loop isn't clobbered.
    const src = out ?? statusMap;
    const ws = src[a.id];
    if (ws === undefined || !isRedStatus(ws)) continue; // only RED workers bubble — the full tier
    // In-motion suppression applies ONLY to the reds that are not stopping you. A worker that needs
    // you now always reaches the top-level row, however busy its siblings are.
    if (!needsAttention(ws) && parentInMotion(a.parentId)) continue;
    // Which red wins on the parent. Write when the parent isn't red at all, OR when this worker
    // needs you now and the parent's existing red does not.
    //
    // That second clause is the fix for roborev's finding on 4b3ede48 (both reviewers, same bug): a
    // plain `!isRedStatus(parent)` guard let a NON-ask red shadow a real one. With `w1: "blocked"`
    // and `w2: "waiting"` under one parent, w1 bubbled first, latched the row at `blocked`, and w2's
    // question never arrived — so the orchestrator read "Blocked" instead of "Needs you", banded P1
    // instead of P0, and which meaning you got depended on the order of the `agents` array. The same
    // shape hit a parent that was already `blocked` on its own.
    //
    // Ask-over-ask does NOT overwrite: first writer wins, so a parent with two questioning workers
    // shows one stable reason instead of flapping with array order.
    // An EQUIVALENT conjunctive rewrite of "parent isn't red, OR this is an ask and the parent's red
    // isn't" — not a reduction to `!needsAttention(parent)`, which this comment previously claimed and
    // which is FALSE: for parent `blocked` with a `blocked` worker the original is false and
    // `!needsAttention` is true.
    //
    // The `isRedStatus` clause is load-bearing, and dropping it is invisible TODAY only because
    // `blocked` is the single non-ask red, so the write it would wrongly allow is `blocked` over
    // `blocked` — the same value. Add a second non-ask red and it silently re-opens the
    // first-writer-wins bug from 4b3ede48. Keep both conjuncts.
    const parentStatus = src[a.parentId];
    if (!needsAttention(parentStatus) && (!isRedStatus(parentStatus) || needsAttention(ws))) {
      ensure()[a.parentId] = ws;
    }
  }
  return out ?? statusMap;
}

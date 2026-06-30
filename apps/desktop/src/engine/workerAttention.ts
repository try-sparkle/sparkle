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
    agent.kind === "worker" &&
    agent.parentId !== null &&
    openIds.has(agent.parentId) &&
    agent.worktreePath !== null &&
    !openIds.has(agent.id) &&
    statusMap[agent.id] === undefined
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
    // a.parentId is non-null here (isUnstartedWorker guarantees it). Bubble unless the parent is
    // already red for its own, more specific reason.
    if (a.parentId !== null && !needsAttention(statusMap[a.parentId])) {
      ensure()[a.parentId] = "approval";
    }
  }
  return out ?? statusMap;
}

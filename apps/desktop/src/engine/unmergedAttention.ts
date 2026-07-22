// Escalate a FINISHED agent that still has un-landed committed work to the RED `unmerged` status,
// so its dot goes red ("Needs merge") until its work reaches main — the "don't silently lose an
// un-merged branch" signal (the user finished, but the work still needs them to open/merge the PR).
//
// This is a pure status-map overlay in the same family as engine/alertDismissal.withDismissedAlerts
// and engine/workerAttention.*: it takes the live status map and returns a (possibly new) map,
// returning the SAME reference when nothing changes (no render churn) and never mutating the input.
//
// It ONLY touches agents whose current status is a RESTING gray state — idle ("your turn"), done
// ("finished cleanly"), or stopped ("persisted, not running") — i.e. the agent isn't actively
// working (green) and isn't already in a red tier (waiting/approval/errored/blocked). An agent that
// is still working, or already asking for something, is left exactly as it is: the "needs merge"
// nudge is about a FINISHED unit of work, not an in-flight one.
//
// COMPOSE ORDER: run this BEFORE alertDismissal.withDismissedAlerts, not after. `unmerged` is
// deliberately NOT in engine/attention's needsAttention set, so withDismissedAlerts never touches an
// `unmerged` row (you can't dismiss it) — but a *dismissed* red row de-escalates to idle/stopped,
// and if this ran AFTER dismissal it would immediately re-escalate that just-calmed row back to red.
// Running unmerged first (on the true resting statuses) then dismissal keeps the two concerns clean:
// a dismissed waiting/errored row stays calm, and a genuinely-finished-with-unmerged-work row is red.
import type { AgentTabStatus } from "../types";
import { hasUnmergedCommittedWork, type WorkflowStageId } from "./workflowStage";

// The resting, non-alerting statuses eligible for the "unmerged work" escalation. `working` (green,
// still building) and every red status (waiting/approval/errored/blocked) are intentionally absent.
const RESTING: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["idle", "done", "stopped"]);

/**
 * Overlay the `unmerged` red status onto every FINISHED agent that still has committed work not yet
 * landed on main. `stageOf(id)` resolves the agent's current workflow stage (the same
 * `resolveStage(branchStatus[id], workflowStage[id])` the sidebar uses); `hasUnmergedCommittedWork`
 * decides the band. An agent missing from `statusMap` defaults to `stopped` (matching the sidebar's
 * own default), so a persisted-but-unlanded tab still lights up. Returns the SAME reference when no
 * agent is escalated. Pure; never mutates the input.
 */
export function withUnmergedWork<T extends { id: string }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  stageOf: (id: string) => WorkflowStageId | undefined,
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  const ensure = (): Record<string, AgentTabStatus> => (out ??= { ...statusMap });
  for (const a of agents) {
    const st = statusMap[a.id] ?? "stopped";
    if (!RESTING.has(st)) continue;
    const stage = stageOf(a.id);
    if (!stage || !hasUnmergedCommittedWork(stage)) continue;
    ensure()[a.id] = "unmerged";
  }
  return out ?? statusMap;
}

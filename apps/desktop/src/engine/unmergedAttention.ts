// Escalate a FINISHED agent that still has un-landed committed work to the `unmerged` status, so its
// row reads "Needs merge" until that work reaches main — the "don't silently lose an un-merged
// branch" signal (the user finished, but the work still needs them to open/merge the PR).
//
// `unmerged` IS GRAY, not red, and this header used to say red. It stopped being red on 2026-07-26
// because 27 of 51 agents on a real fleet sat in this band and the wall of red carried no
// information (the derivation is at packages/ui/tokens.ts:150-157).
//
// What can take such a row out of the calm tier is engine/stallEscalation, which escalates to
// `blocked` rather than recolouring this status. So this module decides "has this agent got unlanded
// commits" and that one decides "does that make the row an alarm". Keep them separate; collapsing
// them is what produced the undismissable red.
//
// TWO THINGS TO BE PRECISE ABOUT, because a reader will otherwise assume the comfortable version:
//   • It is NOT wired yet. `withStallAttention` has no production caller — the composition sites
//     (AgentSidebar.effectiveStatus, useAttentionNotifications.publishedStatusFor) still end at
//     withDismissedAlerts(withUnmergedWork(...)). Until that lands, nothing takes an `unmerged` row
//     out of the calm tier, and the mitigation agentStall's comment defers to does not run.
//   • Its predicate is not NARROWER than this band, it is coextensive with it: agentStall defaults
//     `hasUnlandedWork` from `status === "unmerged"` and `unlanded-work` is in stallEscalation's
//     OUTSTANDING set, so once composed, EVERY live row this module writes goes red. That is the
//     27-of-51 volume, chosen deliberately under the founder's 2026-07-29 rule; the one-line revert
//     is dropping `unlanded-work` from OUTSTANDING.
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
// deliberately NOT in alertDismissal's DISMISSIBLE set, so withDismissedAlerts never touches an
// `unmerged` row (you can't dismiss it) — but a *dismissed* red row de-escalates to idle/stopped,
// and if this ran AFTER dismissal it would immediately re-escalate that just-calmed row back to red.
// Running unmerged first (on the true resting statuses) then dismissal keeps the two concerns clean:
// a dismissed waiting/errored row stays calm, and a genuinely-finished-with-unmerged-work row is
// labelled `unmerged` (gray, "Needs merge") -- whether that becomes an ALARM is stallEscalation's
// call, made from evidence, and it composes after this and after dismissal.
import type { AgentTabStatus } from "../types";
import { hasUnmergedCommittedWork, type WorkflowStageId } from "./workflowStage";

// The resting, non-alerting statuses eligible for the "unmerged work" escalation. `working` (green,
// still building) and every red status (waiting/approval/errored/blocked) are intentionally absent.
const RESTING: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["idle", "done", "stopped"]);

/**
 * Overlay the `unmerged` status onto every FINISHED agent that still has committed work not yet
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
    const calm = calmStatusOf(statusMap[a.id], stageOf(a.id));
    if (calm === (statusMap[a.id] ?? "stopped")) continue;
    ensure()[a.id] = calm;
  }
  return out ?? statusMap;
}

/**
 * THE SAME OVERLAY FOR ONE AGENT — and the map above is now written in terms of it, so the two
 * cannot drift.
 *
 * ══ WHY THIS EXISTS (roborev 58774, a High) ═══════════════════════════════════════════════════
 * `Concierge/MountedAgentNotices` asked the stall question against the RAW `runtimeStore.status`
 * while the sidebar row asked it against the overlaid map. They disagree on the single most common
 * stalled shape: a finished agent holding committed-but-unlanded work reads `done` raw, which this
 * overlay turns into `unmerged` — and `agentStall.isQuiet` accepts `unmerged` but rejects `done`.
 * So the ROW drew its alert glyph and the composer rendered NO pills: clicking the mark mounted the
 * agent, patched the cable, and landed on an empty composer. Two callers deriving "is this agent
 * resting" separately is what made that possible, so there is now one derivation.
 *
 * An ABSENT status defaults to `stopped`, matching every other reader in the repo
 * (`AgentSidebar`, `useRosterPublisher`, `conciergeFeed`). Defaulting to `idle` instead would let
 * an agent nobody has observed produce stall claims from git evidence alone.
 */
export function calmStatusOf(
  status: AgentTabStatus | undefined,
  stage: WorkflowStageId | undefined,
): AgentTabStatus {
  const st = status ?? "stopped";
  if (!RESTING.has(st)) return st;
  if (!stage || !hasUnmergedCommittedWork(stage)) return st;
  return "unmerged";
}

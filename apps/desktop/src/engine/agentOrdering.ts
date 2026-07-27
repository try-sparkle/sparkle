// Which agents are TOP-LEVEL rows in the sidebar, and which one selection should land on.
//
// HISTORY — read this before adding a sort here. This module used to attention-ORDER the stack:
// agents needing you (red) floated to the top, happily-building ones sank. That was removed on
// 2026-07-26. The reason is that it made a row's POSITION a function of its live PTY status, so
// every `working ⇄ idle ⇄ waiting` flip moved a row across a tier and the column re-shuffled under
// the cursor — including on the silent 15s poll tick. A worker's status bubbled into its
// orchestrator's rank too, so a transient worker blip re-sorted the parent. Users read the column
// by position; having position mean "how loud is this right now" made it unreadable.
//
// Row position is now decided by WORKFLOW STAGE (engine/buildSections.ts) plus the user's own drag
// arrangement within a stage, and status is carried by the row's colored dot instead. If you are
// tempted to re-introduce sorting here, note that it will reintroduce exactly that bug: the
// stability IS the feature. STATUS_RANK, FRESH_BUILD_RANK, sortAgentsByAttention and orderAgents
// were all deleted with it. (The tray keeps its own, separate STATUS_RANK in tray/trayRoster.ts —
// that one is untouched and still sorts, which is fine: the tray is a glanceable digest, not a
// spatial map the user navigates by memory.)
import type { AgentKind } from "../types";

/**
 * The top-level agent stack the sidebar renders, in `project.agents` order.
 *
 * Workers are NEVER top-level rows (`kind !== "worker"`). The user works with orchestrators; a
 * worker is reached only by opening its parent orchestrator's card, which nests its own workers
 * afterward. This unconditionally excludes workers — even one orphaned by a missing parent —
 * because a worker flashing into the sidebar (during spawn/spin-down windows, or after its parent
 * closes) is exactly the distraction we're removing. A worker's red attention still bubbles up to
 * its orchestrator elsewhere; it just never claims a row of its own here.
 *
 * Pure and id-preserving: a filtered view of the input in input order. The caller then groups these
 * into the stage ladder (buildSections.groupAgentsByStage), which is what decides vertical position.
 * `workMode` is accepted for signature stability with its callers; the rows are the same for Plan
 * and Build (Plan renders a board in the main pane, not a different agent list).
 */
export function topLevelAgents<
  T extends { id: string; kind: AgentKind; parentId: string | null },
>(agents: readonly T[], _workMode: "plan" | "build" = "build"): T[] {
  const buildIds = new Set(agents.filter((a) => a.kind === "build").map((a) => a.id));
  return agents
    .filter((a) => a.kind !== "worker")
    .filter((a) => !a.parentId || !buildIds.has(a.parentId));
}

/**
 * The agent to land selection on for a given work mode: the first top-level row, or `null` when
 * that mode has no such row.
 *
 * `"plan"` is treated like `"build"` here ON PURPOSE: the plan-mode sidebar renders no rows (it
 * shows a board in the main pane), but selection still persists for when the user switches back to
 * Build, so we pick the first build-side row rather than clearing it.
 *
 * NOTE this is `project.agents` order, NOT the rendered ladder order — the ladder needs each
 * agent's workflow stage, which this pure helper has no access to. The two can disagree when the
 * first agent in the array sits in a later stage section than some other agent. That is deliberate
 * and harmless: this only picks a fallback selection after a close, and any live agent is a valid
 * answer. The sidebar, which DOES know the stages and the active filter, overrides this with the
 * genuinely-first VISIBLE row (see AgentSidebar's reselectAfterClose) so selection never lands on a
 * row the user has filtered out of sight.
 */
export function firstVisibleAgentId<
  T extends { id: string; kind: AgentKind; parentId: string | null },
>(agents: readonly T[], mode: "plan" | "build"): string | null {
  return topLevelAgents(agents, mode)[0]?.id ?? null;
}

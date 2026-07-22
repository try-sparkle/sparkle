// Pure attention-based ordering for the sidebar agent stack (spec:
// docs/superpowers/specs/2026-06-24-attention-based-agent-reordering-design.md).
// Agents that need YOUR support float to the top; agents happily building sink down.
// This is a pure reordering — same agents in, same agents out — so the caller's
// selection (tracked by agent id, not position) is never disturbed.
import type { AgentKind, AgentTabStatus } from "../types";

// Lower rank = higher in the stack. Grouped into tiers; ties keep insertion order
// (the sort below is stable). Tune the taxonomy → tier mapping here, nothing else
// hardcodes it. A status absent from this map sorts to the bottom (see STATUS_RANK_FALLBACK).
export const STATUS_RANK: Record<AgentTabStatus, number> = {
  // Tier 0 — RED: needs YOU before its work is truly done, so it floats to the top. This is the full
  // red-COLOR tier (packages/ui/tokens.ts): the live asks (waiting/approval), the stuck states
  // (errored crash/stall, `blocked` gone-quiet), and `unmerged` (finished but committed work not yet
  // on main — open/merge the PR). Ranking any of them at the bottom would make a red agent SINK
  // instead of floating up, contradicting the dot color and the cross-window red section
  // (sparkle-pqxh). Note this is the color tier, which is BROADER than engine/attention's badge/
  // notification set (waiting/approval/errored) — blocked/unmerged recolor + reorder but don't ping.
  waiting: 0,
  approval: 0,
  errored: 0,
  blocked: 0,
  unmerged: 0,
  // Tier 1 — finished its turn, nothing left for you (nothing to merge, no question).
  idle: 1,
  done: 1,
  // Tier 2 — green: actively building, leave it be.
  working: 2,
  // Tier 3 — dormant: not asking, not running, nothing pending.
  stopped: 3,
};

// Any status not present in STATUS_RANK (shouldn't happen given the closed union, but
// guards against a future status landing here unmapped) sinks to the bottom.
const STATUS_RANK_FALLBACK = 99;

// The just-opened build agent floats to the TOP of the non-alerting group: below tier 0
// (red / needs-you, rank 0) but above idle/done/working/dormant. A fractional rank between
// tier 0 and tier 1 does exactly that without a fixed row index, so it tracks the bottom of
// however many red rows exist at any moment. Only applied while the agent isn't itself red
// (a red fresh agent already sits in tier 0 and must not be demoted below its red siblings).
export const FRESH_BUILD_RANK = 0.5;

function rankOf(
  id: string,
  statusMap: Record<string, AgentTabStatus>,
  freshId?: string | null,
): number {
  // Missing from the map → "stopped" (matches the sidebar's own default), bottom tier.
  const st = statusMap[id] ?? "stopped";
  const base = STATUS_RANK[st] ?? STATUS_RANK_FALLBACK;
  // Boost the freshly-opened build agent above the non-red tiers, but never above (or into
  // the middle of) the red tier — `base > FRESH_BUILD_RANK` leaves a red agent (base 0) alone.
  if (freshId != null && id === freshId && base > FRESH_BUILD_RANK) return FRESH_BUILD_RANK;
  return base;
}

/**
 * Return a new array of `agents` ordered by how much support each needs, top-first
 * (waiting/approval → idle/done → working → blocked/errored/stopped). Stable within a
 * tier, so rows only move across tier boundaries. Does NOT mutate the input.
 *
 * Agents missing from `statusMap` are treated as "stopped" (matches the sidebar's own
 * `status[a.id] ?? "stopped"` default), so they land in the bottom tier.
 */
export function sortAgentsByAttention<T extends { id: string }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  freshId?: string | null,
): T[] {
  // Decorate-sort-undecorate with the original index as the stable tiebreaker, since
  // Array.prototype.sort is only guaranteed stable in modern engines for adjacent equal
  // keys — being explicit keeps tier ties in insertion order regardless of engine.
  return agents
    .map((agent, index) => ({ agent, index, rank: rankOf(agent.id, statusMap, freshId) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((d) => d.agent);
}

/**
 * Order the top-level agent stack with manual pins (spec: manual-agent-reorder-pin).
 * Agents with a numeric `pinnedIndex` are anchored to that row; the rest attention-sort
 * (via sortAgentsByAttention) and fill the remaining rows around the anchors. Pure and
 * id-preserving — output is a permutation of the input, so selection (by id) is safe.
 *
 * Anchoring wins over the fresh-agent boost: a `freshId` that is ALSO pinned goes through the
 * anchor path (its explicit row), so the FRESH_BUILD_RANK float is ignored for it. That's the
 * intended precedence — a user's manual pin is a stronger signal than "just opened" — and in
 * practice a brand-new agent is never pinned (addAgent sets pinnedIndex: null).
 */
export function orderAgents<T extends { id: string; pinnedIndex: number | null }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  freshId?: string | null,
): T[] {
  const anchored = agents.filter((a) => a.pinnedIndex != null);
  const result: T[] = sortAgentsByAttention(
    agents.filter((a) => a.pinnedIndex == null),
    statusMap,
    freshId,
  );
  // Insert anchors by ascending target index. Splicing into the growing result lands each
  // anchor at its requested row (clamped to the current length); ties resolve by anchored
  // array order. Sorting first means earlier rows are filled before later ones.
  for (const agent of anchored.sort((x, y) => x.pinnedIndex! - y.pinnedIndex!)) {
    const at = Math.max(0, Math.min(agent.pinnedIndex!, result.length));
    result.splice(at, 0, agent);
  }
  return result;
}

/**
 * The single source of truth for the agent stack BOTH the sidebar list and the TopBar dot
 * cluster render: top-level agents (the build orchestrators), then attention-ordered the same way.
 * Keeping both consumers on this one helper is what stops the header dots from drifting out of sync
 * with the rows — the bug this was extracted to prevent. Pure and id-preserving. `workMode` is
 * accepted for signature stability with its callers; the rows are the same for Plan and Build (Plan
 * renders a board in the main pane, not a different agent list).
 *
 * Workers are NEVER top-level rows (`kind !== "worker"`). The user works with orchestrators; a
 * worker is reached only by opening its parent orchestrator's card, which nests its own workers
 * afterward. This unconditionally excludes workers — even one orphaned by a missing parent —
 * because a worker flashing into the sidebar (during spawn/spin-down windows or after its parent
 * closes) is exactly the distraction we're removing. A worker's red attention still bubbles up to
 * its orchestrator elsewhere; it just never claims a row of its own here.
 */
export function orderedTopLevelAgents<
  T extends { id: string; kind: AgentKind; parentId: string | null; pinnedIndex: number | null },
>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  _workMode: "plan" | "build",
  attentionOrder: boolean,
  freshId?: string | null,
): T[] {
  const buildIds = new Set(agents.filter((a) => a.kind === "build").map((a) => a.id));
  const topLevel = agents
    .filter((a) => a.kind !== "worker")
    .filter((a) => !a.parentId || !buildIds.has(a.parentId));
  return attentionOrder ? orderAgents(topLevel, statusMap, freshId) : topLevel;
}

/**
 * The agent to land selection on for a given work mode: the FIRST row of
 * `orderedTopLevelAgents` (the same stack the sidebar + TopBar render), or `null` when that
 * mode has no such row.
 *
 * `"plan"` is treated like `"build"` here ON PURPOSE: the plan-mode sidebar renders no rows
 * (it shows a board in the main pane), but selection still persists for when the user switches
 * back to Build, so we pick the first build-side row rather than clearing it. This is a
 * selection helper, not a 1:1 mirror of which rows the plan sidebar paints.
 *
 * Used to keep selection coherent after a close: picking the first row (or `null` → blank
 * first-load state) keeps the main pane and the sidebar in agreement.
 */
export function firstVisibleAgentId<
  T extends { id: string; kind: AgentKind; parentId: string | null; pinnedIndex: number | null },
>(
  agents: readonly T[],
  mode: "plan" | "build",
  agentOrdering: "attention" | "manual",
  statusMap: Record<string, AgentTabStatus>,
  freshId?: string | null,
): string | null {
  const ordered = orderedTopLevelAgents(
    agents,
    statusMap,
    mode,
    agentOrdering === "attention",
    freshId,
  );
  return ordered[0]?.id ?? null;
}

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
  // Tier 0 — red: needs YOU before it can make progress. Most support needed. `errored` belongs
  // here (not the dormant tier): a crashed / mid-stream-stalled agent is stuck until you step in,
  // and it's already treated as RED everywhere else — the attention set (engine/attention.ts), the
  // dock badge + notifications (isRedStatus), and the cross-window red tier. Ranking it at the
  // bottom made a red agent SINK instead of floating up, contradicting all of those (sparkle-pqxh).
  waiting: 0,
  approval: 0,
  errored: 0,
  // Tier 1 — finished its turn; it's your move (review / next prompt).
  idle: 1,
  done: 1,
  // Tier 2 — green: actively building, leave it be.
  working: 2,
  // Tier 3 — dormant: not asking, not running.
  blocked: 3,
  stopped: 3,
};

// Any status not present in STATUS_RANK (shouldn't happen given the closed union, but
// guards against a future status landing here unmapped) sinks to the bottom.
const STATUS_RANK_FALLBACK = 99;

function rankOf(id: string, statusMap: Record<string, AgentTabStatus>): number {
  // Missing from the map → "stopped" (matches the sidebar's own default), bottom tier.
  const st = statusMap[id] ?? "stopped";
  return STATUS_RANK[st] ?? STATUS_RANK_FALLBACK;
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
): T[] {
  // Decorate-sort-undecorate with the original index as the stable tiebreaker, since
  // Array.prototype.sort is only guaranteed stable in modern engines for adjacent equal
  // keys — being explicit keeps tier ties in insertion order regardless of engine.
  return agents
    .map((agent, index) => ({ agent, index, rank: rankOf(agent.id, statusMap) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((d) => d.agent);
}

/**
 * Order the top-level agent stack with manual pins (spec: manual-agent-reorder-pin).
 * Agents with a numeric `pinnedIndex` are anchored to that row; the rest attention-sort
 * (via sortAgentsByAttention) and fill the remaining rows around the anchors. Pure and
 * id-preserving — output is a permutation of the input, so selection (by id) is safe.
 */
export function orderAgents<T extends { id: string; pinnedIndex: number | null }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
): T[] {
  const anchored = agents.filter((a) => a.pinnedIndex != null);
  const result: T[] = sortAgentsByAttention(
    agents.filter((a) => a.pinnedIndex == null),
    statusMap,
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
 * cluster render: top-level agents (a build agent, or a worker orphaned by a missing parent),
 * filtered by the active work mode (Think → think agents; otherwise everything non-think, i.e.
 * build agents + orphaned workers), then attention-ordered the same way. Keeping both consumers
 * on this one helper is what stops the header dots from drifting out of sync with the rows —
 * the bug this was extracted to prevent. Pure and id-preserving (workers are NOT spliced here;
 * each consumer nests its own per-parent workers afterward).
 */
export function orderedTopLevelAgents<
  T extends { id: string; kind: AgentKind; parentId: string | null; pinnedIndex: number | null },
>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  workMode: "think" | "plan" | "build",
  attentionOrder: boolean,
): T[] {
  const buildIds = new Set(agents.filter((a) => a.kind === "build").map((a) => a.id));
  const topLevel = agents
    .filter((a) => !a.parentId || !buildIds.has(a.parentId))
    .filter((a) => (workMode === "think" ? a.kind === "think" : a.kind !== "think"));
  return attentionOrder ? orderAgents(topLevel, statusMap) : topLevel;
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
 * Used to keep selection coherent after a close: `removeAgent`'s own fallback is raw
 * `agents[0]` (insertion order, any kind), which can strand a Build-mode sidebar on a hidden
 * Think agent's pane. Picking the first VISIBLE row (or `null` → blank first-load state) instead
 * keeps the main pane and the sidebar in agreement.
 */
export function firstVisibleAgentId<
  T extends { id: string; kind: AgentKind; parentId: string | null; pinnedIndex: number | null },
>(
  agents: readonly T[],
  mode: "think" | "plan" | "build",
  agentOrdering: "attention" | "manual",
  statusMap: Record<string, AgentTabStatus>,
): string | null {
  const ordered = orderedTopLevelAgents(agents, statusMap, mode, agentOrdering === "attention");
  return ordered[0]?.id ?? null;
}

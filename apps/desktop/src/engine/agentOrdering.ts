// Pure attention-based ordering for the sidebar agent stack (spec:
// docs/superpowers/specs/2026-06-24-attention-based-agent-reordering-design.md).
// Agents that need YOUR support float to the top; agents happily building sink down.
// This is a pure reordering — same agents in, same agents out — so the caller's
// selection (tracked by agent id, not position) is never disturbed.
import type { AgentTabStatus } from "../types";

// Lower rank = higher in the stack. Grouped into tiers; ties keep insertion order
// (the sort below is stable). Tune the taxonomy → tier mapping here, nothing else
// hardcodes it. A status absent from this map sorts to the bottom (see STATUS_RANK_FALLBACK).
export const STATUS_RANK: Record<AgentTabStatus, number> = {
  // Tier 0 — red: genuinely waiting on your answer/approval. Most support needed.
  waiting: 0,
  approval: 0,
  // Tier 1 — finished its turn; it's your move (review / next prompt).
  idle: 1,
  done: 1,
  // Tier 2 — green: actively building, leave it be.
  working: 2,
  // Tier 3 — dormant: not asking, not running.
  blocked: 3,
  errored: 3,
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

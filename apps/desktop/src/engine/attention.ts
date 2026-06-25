// Pure attention logic shared by the dock badge and the system-notification trigger.
// "Attention" = the red tier in the status taxonomy (engine/agentOrdering.ts): an agent that
// is genuinely waiting on YOUR answer or approval. The badge shows the *level* (how many need
// you right now); the notification fires on the *edge* (the moment an agent crosses INTO
// needing you), so you're pinged once per ask, not on every status tick.
import type { AgentTabStatus } from "../types";

/** Agent id → its current live status. Mirrors runtimeStore.status. */
export type StatusMap = Record<string, AgentTabStatus>;

// The two red statuses. Kept in sync with STATUS_RANK tier 0 in agentOrdering.ts and the RED
// entries in packages/ui tokens (waiting = "Needs you", approval = "Approve?").
const ATTENTION: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["waiting", "approval"]);

/** True when a status means the agent is waiting on the user (red). */
export function needsAttention(status: AgentTabStatus | undefined): boolean {
  return status !== undefined && ATTENTION.has(status);
}

/**
 * How many of `agentIds` currently need attention. Restricted to the given ids (not all of
 * `status`) so a window only counts the agents it actually owns — stale entries for a project
 * this window has since navigated away from don't inflate the badge.
 */
export function countAttention(status: StatusMap, agentIds: readonly string[]): number {
  let n = 0;
  for (const id of agentIds) if (needsAttention(status[id])) n++;
  return n;
}

/**
 * The ids (restricted to `agentIds`) that have just crossed INTO needing attention since
 * `prev` — i.e. they need you now but didn't a moment ago. An id absent from `prev` counts as
 * a transition (a freshly-appeared agent that's already waiting fires once), so the very first
 * observation isn't swallowed. Used to fire exactly one notification per ask.
 */
export function newlyNeedingAttention(
  prev: StatusMap,
  next: StatusMap,
  agentIds: readonly string[],
): string[] {
  const out: string[] = [];
  for (const id of agentIds) {
    if (needsAttention(next[id]) && !needsAttention(prev[id])) out.push(id);
  }
  return out;
}

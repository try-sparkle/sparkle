// Pure attention logic shared by the dock badge and the system-notification trigger.
// "Attention" = an agent genuinely waiting on YOUR answer or approval (waiting / approval).
// This is a SUBSET of the red statuses: `errored` is also red (a crashed agent stands out) but
// does NOT count as attention — it's a passive "this one died" cue, not a live question, so it
// must not ping you. The badge shows the *level* (how many need you right now); the notification
// fires on the *edge* (the moment an agent crosses INTO needing you), so you're pinged once per
// ask, not on every status tick.
import type { AgentTabStatus } from "../types";

/** Agent id → its current live status. Mirrors runtimeStore.status. */
export type StatusMap = Record<string, AgentTabStatus>;

// The attention statuses — the agent is asking YOU something. A strict subset of the red tier
// (errored is red but not here, by design — see header). Kept in sync with STATUS_RANK tier 0 in
// agentOrdering.ts (waiting = "Needs you", approval = "Approve?").
const ATTENTION: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["waiting", "approval"]);

/** True when a status means the agent is waiting on the user's answer/approval. */
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
 * The agents (restricted to `agentIds`) that just transitioned INTO one of the `enabled`
 * statuses since `prev` — i.e. their status changed and the new status is one the user wants a
 * notification for. An id absent from `prev` counts as a transition (a freshly-appeared agent
 * already in an enabled status fires once), so the very first observation isn't swallowed. The
 * gate is `next !== prev` (not "was-it-enabled-before"), so a genuine status change like
 * waiting → approval fires again — the ask itself changed — while staying put (waiting → waiting)
 * does not. Used to fire exactly one notification per transition. Pure.
 */
export function newlyEntered(
  prev: StatusMap,
  next: StatusMap,
  agentIds: readonly string[],
  enabled: ReadonlySet<AgentTabStatus>,
): Array<{ id: string; status: AgentTabStatus }> {
  const out: Array<{ id: string; status: AgentTabStatus }> = [];
  for (const id of agentIds) {
    const ns = next[id];
    if (ns !== undefined && ns !== prev[id] && enabled.has(ns)) out.push({ id, status: ns });
  }
  return out;
}

/**
 * Whether to SUPPRESS the system notification for an agent that just changed status. We suppress
 * exactly one case: the user is actively looking at THAT agent — this window is the OS-focused
 * window (`windowFocused`, from document.hasFocus(), which is true only when this app+window is
 * frontmost) AND the agent is the selected tab here. Every other case still notifies: a different
 * agent in this same focused window (not selected), an agent in a background window/project (this
 * window isn't focused), or another app entirely in front (also not focused). The row's recolor +
 * move-to-top is independent of this and always happens. Pure.
 */
export function suppressNotification(args: {
  windowFocused: boolean;
  selectedAgentId: string | null;
  agentId: string;
}): boolean {
  return args.windowFocused && args.selectedAgentId === args.agentId;
}

/** Notification copy (banner title + body) for an agent that entered `status`. Title is always
 *  the agent name; the body says WHY it's pinging, scoped to the project. Pure + exhaustive over
 *  the status taxonomy so a new status can't silently fall through to a blank banner. */
export function notificationFor(
  status: AgentTabStatus,
  agentName: string,
  projectName: string,
): { title: string; body: string } {
  const reason: Record<AgentTabStatus, string> = {
    waiting: "Needs your answer",
    approval: "Wants your approval",
    errored: "Errored — it crashed",
    idle: "Finished — your turn",
    done: "Done",
    working: "Started working",
    blocked: "Stalled",
    stopped: "Stopped",
  };
  const suffix = projectName ? ` · ${projectName}` : "";
  return { title: agentName, body: `${reason[status]}${suffix}` };
}

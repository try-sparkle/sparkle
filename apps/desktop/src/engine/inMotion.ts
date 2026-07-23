// inMotion — is this agent still MOVING, even though its own turn is closed?
//
// Why this exists. Sparkle equates "the model's turn closed" with "the agent is finished, over to
// you", and for a SELF-RESUMING agent those are different facts. The reported case (screenshot,
// 2026-07-22): an orchestrator backgrounded a `wait_for_workers` MCP call, Claude fired `Stop`, and
// the hook stream correctly reported `idle` — while a worker it had just spawned was still building
// and would resume it unprompted. Every surface downstream inherited the error: the sidebar painted
// the row RED ("a worker needs you") and the composer led with "Close Build Agent" over work that
// was actively in flight.
//
// The hook stream cannot answer this on its own. Claude fires `PostToolUse` for a call that merely
// moved to the BACKGROUND — the log shows Pre→Post→Stop, exactly like a call that finished — so
// "is a tool still outstanding?" is not derivable from hooks. What IS reliably knowable, and is
// already in the store, is the fleet: a worker child that is `working` is positive, app-owned proof
// that the orchestrator's unit of work is still progressing.
//
// SCOPE, stated plainly so the gap stays explicit rather than latent: this covers an agent whose
// motion is carried by its WORKERS. It does NOT yet cover a lone agent with a backgrounded task and
// no children (a background Bash, a backgrounded MCP call with nothing spawned) — that needs a
// second, screen-scraped signal (Claude's "N MCP tasks still running" footer), deliberately left out
// of v1. Note that folding that marker into statusEngine's WORKING_PATTERNS would be the WRONG way
// to add it: statusRouter's watchdog reads "hooks say idle + screen says working" as proof the hook
// stream died, and a legitimate background task produces exactly that contradiction — so it would
// fire the watchdog on healthy sessions. It needs its own channel, not a status.
//
// Pure, like its siblings (attention.ts, workerAttention.ts, unmergedAttention.ts): no store reads,
// no React, so the whole decision unit-tests without a component.
import type { AgentTabStatus } from "../types";

/** Agent id → its current live status. Mirrors runtimeStore.status. */
export type StatusMap = Record<string, AgentTabStatus>;

/** The fields this module reads. Narrower than `AgentTab` on purpose — a full AgentTab satisfies it
 *  structurally, and tests can build one from three fields. */
export interface MotionAgent {
  id: string;
  kind: string;
  parentId: string | null;
}

/**
 * Is `agentId` in motion — either working itself, or carried by a worker that is?
 *
 * True when the agent's own status is `working` (the trivial case, included so callers have ONE
 * predicate to ask rather than two), or when any WORKER whose `parentId` is this agent is
 * `working`. A worker that has settled (idle/done), gone red, or never started does NOT count: a
 * fleet where every worker has stopped is genuinely between batches, and that is precisely when
 * "needs you" and "close me" become the honest things to say.
 *
 * Only `working` counts as motion. That is deliberate and load-bearing: the moment a spun-up fleet
 * settles, the agent stops being in motion and the ordinary red/CTA behavior returns intact.
 */
export function isInMotion(
  agentId: string,
  agents: readonly MotionAgent[],
  status: StatusMap,
): boolean {
  if (status[agentId] === "working") return true;
  return agents.some(
    (a) => a.kind === "worker" && a.parentId === agentId && status[a.id] === "working",
  );
}

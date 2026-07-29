// How much THIS window actually KNOWS about an agent's runtime status.
//
// `runtimeStore.status` is window-local and never persisted, so "no entry for this agent" and "this
// agent is stopped / calm / needs nothing" are indistinguishable if you only look at the map. Every
// surface that answers a question ABOUT an agent from that map therefore has to say which of the two
// it is looking at, or it converts a missing observation into a confident (and often wrong) claim.
//
// This module exists because that mistake was made twice, in two different files, and the second
// time nobody could reuse the first fix. `get_state` learned it first (roborev 53476 added the
// field, 53552 corrected what it is allowed to claim); `get_agent_status` was still reporting
// `needsYou: false` for agents it had never observed, which reads to a caller as "nothing needs
// you" — the single most expensive false negative this API can produce, since the whole point of
// asking is to find the agent that is stuck. The rule and the vocabulary now live in ONE place so a
// third surface inherits them instead of re-deriving them.
import type { AgentTabStatus } from "../types";

/**
 * Whether a reported status is an OBSERVATION or a default.
 *
 *   local        — this window has a runtime status entry; the status is authoritative.
 *   other-window — no local entry, but a pane for this agent is open in SOME window (openAgentIds is
 *                  persisted and merged app-wide). This window CANNOT OBSERVE it: it may be running
 *                  or finished. The status is a default, not a reading.
 *   unknown      — no local entry and no open pane this window can see. Genuinely stopped, OR a
 *                  just-spawned agent whose pane has not mounted yet.
 *
 * NEITHER non-local label is a liveness ASSERTION — they mark the ABSENCE of an observation, and
 * that asymmetry is deliberate. `openAgentIds` is cleared only by runtimeStore.close() and survives
 * relaunch, so an agent whose process has exited keeps its id in the set. Reading "other-window" as
 * "alive" would flip the original bug into a worse one: a caller would never observe an agent die
 * and would wait on it forever. For a real death signal ask something that watches the process.
 */
export type AgentLiveness = "local" | "other-window" | "unknown";

/** Classify one agent's status entry. Pure — the caller supplies both maps, so this is equally
 *  usable from a store selector, a control-op handler and a test. */
export function livenessOf(
  id: string,
  status: Record<string, AgentTabStatus | undefined> | Record<string, unknown>,
  openIds: ReadonlySet<string>,
): AgentLiveness {
  if ((status as Record<string, unknown>)[id] !== undefined) return "local";
  return openIds.has(id) ? "other-window" : "unknown";
}

/** True when `status` was actually read off this window rather than defaulted. The one predicate a
 *  caller needs before treating a derived boolean (`needsYou`, "is it running") as a fact. */
export function isObserved(liveness: AgentLiveness): boolean {
  return liveness === "local";
}

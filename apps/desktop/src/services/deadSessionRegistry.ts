// deadSessionRegistry — WHICH AGENTS IN THIS WINDOW HAVE A DEAD SESSION, AND WHY.
//
// The window-local mirror of the durable agent-life ledger's open/close pair, and it exists for one
// reason: the durable ledger lives in Rust behind a `revival_due` invoke on a 15-second sweep, and
// the row-colour pipeline (`useAttentionNotifications.composeRollup`) is synchronous and runs on
// every roster tick. A surface cannot await a ledger read to decide what colour to paint.
//
// ── IT MIRRORS THE LEDGER'S OWN LIFECYCLE, RATHER THAN INVENTING ONE ──────────────────────────
// `services/deathRecordWriter` already writes both edges, from `components/Terminal`:
//   • `openDeathRecord(agentId, …)` at SPAWN → `agent_life_open`      → {@link forgetAgentDeath}
//   • `recordDeath(agentId, terminator)` at DEATH → `agent_life_close` → {@link noteAgentDeath}
// So this map is written at exactly the two instants the durable record changes state, by the same
// two calls, and cannot drift into a third opinion about whether an agent is alive.
//
// ── WHY IT IS SEEDED ONLY BY THIS WINDOW'S OWN OBSERVATIONS ───────────────────────────────────
// `classifyDeath`'s Gate 0 writes a real verdict only when `liveness === "local"`, which requires a
// mounted pane — so every death this window classifies with evidence is one whose pane is still
// there, which is precisely the population whose row the founder is looking at when he asks why it
// is red. An agent that died in another window (or before this one launched) is absent here, and
// absence means "we did not look", never "it is fine": the overlay that reads this demotes nothing
// for an unknown agent, exactly as `isFinishedOf` does.
//
// ── AND A DURABLE FALLBACK, FOR THE DEATH THIS WINDOW NEVER SAW (bead sparkle-nu7gd9, Defect #1) ──
// `noteAgentDeath` only fires for a death this window MOUNTED (Gate 0). The common transient death —
// an ENOTFOUND/529 wave that kills agents whose panes are not mounted here, or the whole fleet at
// once so no surviving pane records anything — is sealed only in the DURABLE Rust ledger, which
// `revival.rs` is already restarting from and republishes via `revival_due`. `services/
// resurrectionRunner` mirrors that list into `stores/resurrectableDeadStore` every sweep, and
// {@link deathCauseForAgent} falls back to it, so a resurrectable death is de-redded on every surface
// that shares this reader even when this window classified nothing. The observed reading WINS when
// both exist: a pane this window watched has stronger, fresher evidence than a 15s-old ledger scan.
//
// PURE-ISH: a module-level map with no clock and no I/O, in the shape `engine/engineRegistry` uses.
// One window, one map; threading it through every caller of the rollup would mean plumbing it
// through the whole sidebar.
import type { DeathCause } from "../engine/deathTypes";
import {
  durableDeadCauseForAgent,
  useResurrectableDeadStore,
} from "../stores/resurrectableDeadStore";

/** agentId → the cause its session ended of, for as long as it stays ended. */
const deaths = new Map<string, DeathCause>();

/**
 * Record that this agent's session ended, and of what.
 *
 * Called from `recordDeath` AFTER the durable `agent_life_close` lands — never before, and never on
 * the paths that decline to write one. A window with nothing to say (Gate 0's `evidence: "none"`)
 * and a still-running walled agent (`quota-trip`) both return without closing the ledger, and both
 * must leave this map alone for the same reason they leave the record alone: neither is a death.
 */
export function noteAgentDeath(agentId: string, cause: DeathCause): void {
  deaths.set(agentId, cause);
}

/**
 * Forget this agent's death — it is being (re)spawned.
 *
 * Called from `openDeathRecord`, which runs on every pane mount, so a resurrection's `restartPane`
 * clears this by the same act that reopens the durable record. That symmetry is the point: an entry
 * that outlived a respawn would paint a working agent amber, and the one direction this map must
 * never fail in is claiming an agent is dead when it is running.
 *
 * Unconditional, and cheap on a miss — the ordinary first spawn has nothing to forget.
 *
 * Clears the DURABLE fallback too (`stores/resurrectableDeadStore`), so a respawn stops rendering
 * amber immediately rather than waiting up to a full resurrection sweep for the ledger's due list to
 * drop this agent. The store's own `forget` no-ops when the id is absent, so the ordinary first spawn
 * still costs nothing.
 */
export function forgetAgentDeath(agentId: string): void {
  deaths.delete(agentId);
  useResurrectableDeadStore.getState().forget(agentId);
}

/**
 * Why this agent's session ended, or `undefined` for "neither this window nor the durable ledger has
 * a reading".
 *
 * OBSERVED FIRST, THEN THE DURABLE FALLBACK. A death this window mounted (`noteAgentDeath`) is the
 * stronger, fresher evidence and wins; otherwise the durable `revival_due` mirror answers, so the
 * common unmounted transient death is still recognised as resurrectable and de-redded (bead
 * sparkle-nu7gd9). Both agree on resurrectability by construction — the same verdict crosses the wire
 * to the ledger that seeds the fallback — so the precedence only ever picks the more specific cause,
 * never flips a red row to amber or back.
 *
 * `undefined` is NOT "it is alive". Every consumer must treat it as an absence of evidence — see
 * the header, and `engine/deadSessionAttention`, which demotes nothing for it.
 */
export function deathCauseForAgent(agentId: string): DeathCause | undefined {
  return deaths.get(agentId) ?? durableDeadCauseForAgent(agentId);
}

/** Test seam: empty the map, so one suite's deaths cannot leak into the next. */
export function _resetDeadSessionRegistryForTests(): void {
  deaths.clear();
}

// orphanedSubagentRegistry — HOW MANY BACKGROUND TASKS AN AGENT HAD IN FLIGHT AT THE INSTANT IT DIED.
//
// ── THE BUG THIS EXISTS FOR (bead sparkle-y5dk8x) ─────────────────────────────────────────────────
// A build agent's own Claude Code session exited mid-task three times; each time, every background
// research SUBAGENT it had dispatched died with the parent and produced nothing. A parent's own tool
// results survive a `claude --resume`, but a subagent's in-flight work does not — so the fan-out was
// silently destroyed while the resume notice implied the work was merely "not lost". The mid-task-exit
// notice (services/deathRecordWriter's `sparkle-ffm5bn` surface) has to be able to SAY that dispatched
// subagents were orphaned — but only when there actually were some, or it overclaims on every death.
//
// ── WHY A SEPARATE REGISTRY AND NOT A READ OF `backgroundTaskRegistry` (the timing) ───────────────
// `services/backgroundTaskRegistry` holds the LIVE count scraped from Claude Code's footer, and
// `engine/statusEngine.exit()` DELETES it (`forgetBackgroundTasks`) the instant the PTY closes — it
// must, or a promoted GREEN would outlive the process (bead sparkle-262p7). That delete happens
// BEFORE `reportDeath()` fires `recordDeath`, so by the time the death path could read the live count
// it is already gone. This registry is the snapshot taken in `exit()` in the same breath as the
// delete: the count as it was at death, retained for the death notice to read, cleared when the agent
// is (re)spawned. It mirrors `services/deadSessionRegistry` exactly — captured at the death edge,
// forgotten at the spawn edge — so the two can never drift into different opinions of "still dead".
//
// PURE-ISH: a module-level map with no clock and no I/O, in the shape `services/backgroundTaskRegistry`
// and `services/deadSessionRegistry` use. One window, one map.

/** agentId → the count of background tasks that were live when this agent's session ended. */
const orphaned = new Map<string, number>();

/**
 * Record that this agent died with `count` background tasks still in flight.
 *
 * A non-positive or missing count is treated as {@link forgetOrphanedSubagents} — "no orphaned work"
 * is an ABSENCE, never a zero-valued entry, so a reader has one definition of "had orphans" and a
 * stale `0` can never linger as a truthy map key. Called from `statusEngine.exit()` with the count
 * snapshotted the instant before `forgetBackgroundTasks` drops the live footer count.
 */
export function noteOrphanedSubagents(agentId: string, count: number | undefined): void {
  if (count !== undefined && count > 0) orphaned.set(agentId, count);
  else orphaned.delete(agentId);
}

/**
 * Forget this agent's orphaned-subagent snapshot — it is being (re)spawned.
 *
 * Called from `deathRecordWriter.openDeathRecord`, which runs on every pane mount, so a resurrection's
 * restart clears this by the same act that reopens the durable death record — the same symmetry
 * `deadSessionRegistry.forgetAgentDeath` keeps. An entry that outlived a respawn would let the next
 * death notice claim subagents were lost using a stale prior count.
 *
 * Unconditional, and cheap on a miss — the ordinary first spawn has nothing to forget.
 */
export function forgetOrphanedSubagents(agentId: string): void {
  orphaned.delete(agentId);
}

/**
 * How many background tasks this agent had in flight when it died, or `undefined` for "none / no
 * reading". `undefined` is NOT the same as a known zero for callers that care, but for the death
 * notice the two are equivalent: nothing to say about orphaned work either way.
 */
export function orphanedSubagentsForAgent(agentId: string): number | undefined {
  return orphaned.get(agentId);
}

/** Test seam: empty the map, so one suite's snapshots cannot leak into the next. */
export function _resetOrphanedSubagentRegistryForTests(): void {
  orphaned.clear();
}

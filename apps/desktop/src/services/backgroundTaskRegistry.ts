// backgroundTaskRegistry — WHICH AGENTS IN THIS WINDOW HAVE LIVE BACKGROUND TASKS, AND HOW MANY.
//
// The window-local mirror of Claude Code's "N background task(s) live" footer, and it exists for the
// same reason `services/deadSessionRegistry` does: the row-colour pipeline
// (`useAttentionNotifications.composeRollup`) is SYNCHRONOUS and runs on every roster tick, so a
// surface cannot await anything to decide what colour to paint. The status engine reads the footer
// off the rendered screen at settle and parks the count here; the rollup reads it back the same tick.
//
// ── WHY A REGISTRY AND NOT A HOOK/BACKEND SIGNAL (bead sparkle-262p7) ──────────────────────────────
// There is no reliable event-driven source for this. A backgrounded tool call emits
// PreToolUse→PostToolUse→Stop exactly like a finished one (Claude fires PostToolUse when a call moves
// to the BACKGROUND, not when it completes — see engine/inMotion.ts:11-15), so hooks cannot tell a
// live background task from a completed one. Claude Code's own footer is the only authoritative
// signal, and it lives on the rendered screen — which the status engine already scrapes. So the
// signal is screen-sourced (fragile: it tracks a TUI string — see engine/backgroundTaskFooter's
// retune note) and parked here rather than derived from the hook stream.
//
// ── LIFECYCLE, MIRRORING WHAT WRITES IT ───────────────────────────────────────────────────────────
// `engine/statusEngine` is the sole writer, at exactly the two instants that change the truth:
//   • on SETTLE — it reads the viewport it already snapshots and calls {@link noteBackgroundTasks}
//     with the live count (or {@link forgetBackgroundTasks} when the footer is gone);
//   • on exit()/dispose() — the PTY is gone, so no footer can be live: {@link forgetBackgroundTasks}.
// Claude Code auto-resumes a "follow-up turn" when a background task finishes, which drives another
// settle, which re-reads the footer — so the count self-corrects down to zero through the ordinary
// turn cycle rather than needing an aggressive poll.
//
// PURE-ISH: a module-level map with no clock and no I/O, in the shape `engine/engineRegistry` and
// `services/deadSessionRegistry` use. One window, one map.

/** agentId → the count of live background tasks Claude last reported, for as long as it stays > 0. */
const liveTasks = new Map<string, number>();

/**
 * Record that this agent has `count` live background tasks.
 *
 * A non-positive count is treated as {@link forgetBackgroundTasks} — "no live work" is an ABSENCE,
 * never a zero-valued entry, so every reader has one definition of "in motion" and a stale `0` can
 * never linger as a truthy map key.
 */
export function noteBackgroundTasks(agentId: string, count: number): void {
  if (count > 0) liveTasks.set(agentId, count);
  else liveTasks.delete(agentId);
}

/**
 * Forget this agent's background tasks — the footer is gone, or its session ended.
 *
 * Called from the status engine's settle (footer absent) and from exit()/dispose(). Unconditional
 * and cheap on a miss; the one direction this map must never fail in is claiming an agent is still
 * delegating when it has actually finished, because that would paint a done agent GREEN forever.
 */
export function forgetBackgroundTasks(agentId: string): void {
  liveTasks.delete(agentId);
}

/**
 * How many background tasks this agent has live, or `undefined` for "this window has no reading".
 *
 * `undefined` is NOT "zero" for callers that care about the distinction — but for the green-while-
 * delegating decision the two are equivalent (no live work either way), which is what
 * {@link hasLiveBackgroundTasksForAgent} folds them into.
 */
export function backgroundTasksForAgent(agentId: string): number | undefined {
  return liveTasks.get(agentId);
}

/** Does this agent have at least one live background task right now? The predicate the rollup reads. */
export function hasLiveBackgroundTasksForAgent(agentId: string): boolean {
  return (liveTasks.get(agentId) ?? 0) > 0;
}

/** Test seam: empty the map, so one suite's tasks cannot leak into the next. */
export function _resetBackgroundTaskRegistryForTests(): void {
  liveTasks.clear();
}

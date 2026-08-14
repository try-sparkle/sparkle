// "Is this agent's terminal up yet?" — the signal the send path needs and the runtime store
// cannot give (bead sparkle-qd80 / CM-U7).
//
// `runtimeStore.openAgentIds` answers "does a pane exist", NOT "is the PTY coming up". Those differ
// in the case that matters: an agent whose process EXITED (`/exit`, a crash) is still open — its
// pane is mounted, its terminal shows the exit — so treating openness as "still starting" would
// make the concierge hold a prompt and promise to deliver it, for an agent nothing will ever start.
//
// So the pane publishes its own state here, the same tiny-registry shape as terminalScrollback /
// terminalMarkers: registered while mounted, unregistered on unmount.
//
//   unmounted → no pane. A failed send is a truthful `pty-gone`.
//   starting  → mounted, PTY not ready yet (spawning, resuming, restarting). A failed send QUEUES.
//   ready     → the PTY came up. A failed send now means the process died: `pty-gone`, not a queue.
//   failed    → the pane GAVE UP (spawn error / Claude not installed). A send must fail truthfully,
//               never queue — the abandon effect covers what was already held, but a prompt sent
//               AFTER the pane settled here would otherwise re-queue and dangle forever
//               (roborev 46924). A successful Retry republishes via setPaneReady.
//
// Deliberately NOT flipped back to `starting` on exit: an exited pane must fail sends truthfully
// rather than accumulate a queue nobody will drain.

export type PaneState = "unmounted" | "starting" | "ready" | "failed";

const panes = new Map<string, Exclude<PaneState, "unmounted">>();

// ── PUBLICATION COUNTER ─────────────────────────────────────────────────────────────────────────
//
// "Is it ready?" and "did it become ready SINCE I asked it to restart?" are different questions,
// and only the second one can judge a restart. A running agent is ALREADY `ready`, so a reader that
// takes the state at face value right after triggering a re-spawn sees the PREVIOUS launch's
// verdict and calls the restart done before anything happened — the same false success
// `restartPaneAwaited` exists to close (roborev 64084).
//
// So every publication bumps a per-agent counter. A caller snapshots it before triggering the
// restart and ignores any reading that has not moved: what it observes is then necessarily a
// verdict from the launch it caused, not a leftover.
const generations = new Map<string, number>();

function bump(agentId: string): void {
  generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
}

/** Publish this pane's readiness. Called by AgentPane while it is mounted. */
export function setPaneReady(agentId: string, ready: boolean): void {
  panes.set(agentId, ready ? "ready" : "starting");
  bump(agentId);
}

/** Publish that this pane gave up (spawn error / Claude missing). Nothing here enforces
 *  stickiness — setPaneReady overwrites freely; the PANE owns the rule (AgentPane republishes
 *  through its phase guard, and only a Retry that re-enters the prepare flow flips phase back). */
export function setPaneFailed(agentId: string): void {
  panes.set(agentId, "failed");
  bump(agentId);
}

/** How many times this pane has published its state. Monotonic per mount; only ever compared
 *  against an earlier snapshot of itself, never read as a quantity. */
export function paneGeneration(agentId: string): number {
  return generations.get(agentId) ?? 0;
}

// ── RELAUNCH SIGNAL ─────────────────────────────────────────────────────────────────────────────
//
// "Is a re-spawn in flight?" cannot be inferred from the publication counter, and trying to was a
// real defect (roborev 64104). A publication happens when one of the publish effect's DEPS changes
// — `ptyReady`, `phase`, `gaveUp`, `spawnMatchesTargetRuntime`. Two cases break the inference in
// opposite directions:
//
//   • A local agent restarted while it is ALREADY mid-launch (phase "preparing", ptyReady false)
//     re-enters prepare() and every one of those writes is a no-op, so nothing publishes — yet a
//     real re-spawn IS in flight.
//   • A shell or cloud re-prepare takes an early return, never remounts Terminal, and never
//     re-spawns the PTY at all — nothing publishes, and nothing is coming, because nothing is
//     happening.
//
// So the pane says so explicitly. `notePaneRelaunch` is called by the paths that actually re-spawn,
// synchronously, before their first await.
const relaunches = new Map<string, number>();

/** Announce that this pane is re-spawning its PTY. Called by prepare() on the paths that do. */
export function notePaneRelaunch(agentId: string): void {
  relaunches.set(agentId, (relaunches.get(agentId) ?? 0) + 1);
}

/** How many re-spawns this pane has announced. Compared only against an earlier snapshot. */
export function paneRelaunchCount(agentId: string): number {
  return relaunches.get(agentId) ?? 0;
}

/** Drop this pane's entry (unmount). */
export function unregisterPane(agentId: string): void {
  panes.delete(agentId);
  // The counter deliberately SURVIVES an unmount, so a remount cannot hand out a generation an
  // in-flight waiter has already seen.
  bump(agentId);
}

/** What the send path needs to decide queue-vs-fail. */
export function paneState(agentId: string): PaneState {
  return panes.get(agentId) ?? "unmounted";
}

/** Test seam: forget every pane. */
export function resetPaneReadiness(): void {
  panes.clear();
  generations.clear();
  relaunches.clear();
}

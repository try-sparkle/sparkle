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

/** Publish this pane's readiness. Called by AgentPane while it is mounted. */
export function setPaneReady(agentId: string, ready: boolean): void {
  panes.set(agentId, ready ? "ready" : "starting");
}

/** Publish that this pane gave up (spawn error / Claude missing). Nothing here enforces
 *  stickiness — setPaneReady overwrites freely; the PANE owns the rule (AgentPane republishes
 *  through its phase guard, and only a Retry that re-enters the prepare flow flips phase back). */
export function setPaneFailed(agentId: string): void {
  panes.set(agentId, "failed");
}

/** Drop this pane's entry (unmount). */
export function unregisterPane(agentId: string): void {
  panes.delete(agentId);
}

/** What the send path needs to decide queue-vs-fail. */
export function paneState(agentId: string): PaneState {
  return panes.get(agentId) ?? "unmounted";
}

/** Test seam: forget every pane. */
export function resetPaneReadiness(): void {
  panes.clear();
}

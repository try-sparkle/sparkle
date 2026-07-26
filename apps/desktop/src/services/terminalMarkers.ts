// Per-agent "mark this prompt in the terminal" providers (bead sparkle-qd80 / CM-U7).
//
// Dropping a marker at the current terminal row is what makes "jump to this prompt" work later
// (the pinned-prompt dropdown and history search both scroll to it). That used to be the composer's
// job — it held the TerminalApi ref and called markPrompt right after recording the prompt. The
// concierge box is the only composer now, and it dispatches through a SERVICE with no React ref in
// hand, so the capability is published here instead: the mounted pane registers a marker provider
// for its agent, and services/conciergeDispatch calls it after a successful free-text send.
//
// Same tiny-registry shape (and lifetime) as services/terminalScrollback: registered while the
// agent's pane is mounted, unregistered on unmount, no-op when nothing is registered.

const markers = new Map<string, (promptId: string) => void>();

/** Register an agent's prompt-marker while its pane is mounted. Returns an unregister fn that only
 *  removes THIS provider (so a transient double-mount can't delete the live one). */
export function registerPromptMarker(
  agentId: string,
  mark: (promptId: string) => void,
): () => void {
  markers.set(agentId, mark);
  return () => {
    if (markers.get(agentId) === mark) markers.delete(agentId);
  };
}

/** Mark `promptId` at the agent's current terminal row. Returns false when nothing is registered
 *  (no mounted pane / no terminal) — the prompt is simply not jump-to-able, which is the same
 *  outcome the composer path had for an alternate-buffer TUI. */
export function markAgentPrompt(agentId: string, promptId: string): boolean {
  const mark = markers.get(agentId);
  if (!mark) return false;
  mark(promptId);
  return true;
}

/** Test seam: drop every registration. */
export function resetPromptMarkers(): void {
  markers.clear();
}

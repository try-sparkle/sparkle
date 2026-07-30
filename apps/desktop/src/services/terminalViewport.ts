// WHAT THE USER IS LOOKING AT RIGHT NOW in an agent's terminal — the rendered screen, plus whether
// the alternate screen buffer is active.
//
// ══ WHY THIS IS NOT `getAgentScrollback` ════════════════════════════════════════════════════════
// `services/terminalScrollback.ts` is the sibling registry, and it answers a DIFFERENT question: the
// last 300 lines of HISTORY, for shipping to a watching phone. Feeding that to a safety guard is a
// documented deadlock, fixed once already on another path (roborev 55170): `screenAwaitsInput` would
// match the FIRST `(y/n)` the session ever printed and keep matching it forever, so a guard reading
// history refuses permanently after the agent's first approval prompt. Anything deciding "is it safe
// to write here" must read the VIEWPORT, which redraws — a dismissed picker's footer is gone from it.
//
// Kept beside the scrollback registry rather than inside it because the two are read by different
// layers for opposite reasons (relay transport vs. write-safety), and a caller reaching for the wrong
// one is exactly the bug above. Separate names make that mistake visible at the call site.

/** The one atomic read of a terminal's current screen. Both fields come from a SINGLE provider call
 *  so they always describe the same instant — asking for the text and the buffer type separately
 *  could straddle a `vim` launch and report a normal-buffer prompt that is already gone. */
export interface TerminalViewport {
  /** The rendered screen, as text. Not the scrollback — see the header. */
  text: string;
  /** True when xterm's alternate screen buffer is active: `vim`, `less`, `htop`, `lazygit`.
   *  A full-screen app reads pasted text as COMMANDS, not as input. */
  alternateBuffer: boolean;
}

const providers = new Map<string, () => TerminalViewport>();

/** Register an agent's viewport provider while its terminal is mounted. Returns an unregister fn
 *  that only removes THIS provider, so a transient double-mount can't delete the live one — the
 *  same ownership rule `registerScrollback` uses, for the same remount reason. */
export function registerViewport(
  agentId: string,
  provider: () => TerminalViewport,
): () => void {
  providers.set(agentId, provider);
  return () => {
    if (providers.get(agentId) === provider) providers.delete(agentId);
  };
}

/**
 * The agent's current screen, or null when its terminal isn't mounted.
 *
 * NULL IS NOT "SAFE". Callers gating a write must treat null as a REFUSAL, not as an empty screen:
 * "I cannot see what is on this terminal" and "this terminal is at a clean prompt" are different
 * facts, and only the second permits a write. A provider that throws is also null for this reason —
 * a broken read must never be reported as a clear screen.
 */
export function getAgentViewport(agentId: string): TerminalViewport | null {
  const provider = providers.get(agentId);
  if (!provider) return null;
  try {
    return provider();
  } catch {
    return null;
  }
}

/** Test seam — drop every registration. Production never needs this; each terminal unregisters
 *  itself on unmount. */
export function resetViewportRegistry(): void {
  providers.clear();
}

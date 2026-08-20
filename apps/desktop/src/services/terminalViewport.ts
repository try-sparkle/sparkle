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
  /** The terminal's current geometry, read in the SAME provider call as the text above.
   *
   *  HERE rather than in a second registry because `services/forceRedraw` needs the size that
   *  belongs to the screen it just read: a redraw computes its nudge from `cols` and restores to
   *  it, and a size sampled a moment later can belong to a pane the user has since dragged — which
   *  would leave the terminal at a width it never had. The header's rule about `text` and
   *  `alternateBuffer` describing ONE INSTANT is the same rule, extended to the one other fact a
   *  caller needs.
   *
   *  ══ OPTIONAL, AND ABSENCE IS A REFUSAL — NEVER A DEFAULT ═══════════════════════════════════
   *  The live provider (`components/Terminal`) always supplies both. They are optional only so the
   *  ~20 existing fixtures that build a viewport to exercise a WRITE GUARD — which has never cared
   *  about geometry — do not all have to declare a size they never read. Requiring them was tried
   *  and reverted: it spread churn across a dozen unrelated suites and, worse, several of those
   *  helpers infer their own literal types, so the "fix" was to annotate test scaffolding that has
   *  nothing to do with this feature.
   *
   *  WHAT MAKES THAT SAFE is that no consumer may substitute a value. `forceAgentRedraw` REFUSES
   *  with `no-geometry` when either is absent rather than assuming 80x24 — guessing would resize a
   *  live terminal to a size nobody chose, which is worse than not redrawing at all. That refusal
   *  is pinned by its own test, so this is an explicit dead end rather than the silent
   *  defaulted-seam hole (bead sparkle-lgbwf) that a fallback value would create. */
  cols?: number;
  rows?: number;
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

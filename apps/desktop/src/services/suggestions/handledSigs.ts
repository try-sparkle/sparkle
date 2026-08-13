// The per-AGENT set of picker signatures already auto-answered — the de-dupe guard standing between
// a prompt that is still on screen and a SECOND keystroke into a live PTY.
//
// ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────────────────────────
// It started as a ref inside `useSuggestions`; it became module state there because a REMOUNT
// re-answered an already-answered prompt (roborev 53074), and per-agent rather than per-instance
// because a `useRef(handledSigsFor(agentId))` captured the first agent forever (roborev 53159).
//
// It moved OUT of the hook when it acquired a second reader. `services/suggestions/autoApproveWatch`
// answers prompts for agents whose pane nobody is looking at, and the mounted hook answers for the
// agent that is selected. THOSE TWO MUST SHARE ONE REGISTRY. The entire point of the watch is that
// it answers a prompt when it APPEARS rather than when the pane is clicked — so by the time the
// founder clicks, the hook mounts onto a screen that has already been answered, and a hook holding
// its own set would type the keystroke a second time. That is roborev 53074 again, reached by a
// different road.
//
// Keeping it here rather than in `useSuggestions` has a second, smaller payoff: the watch is started
// from `App.tsx` at boot, and importing it must not drag the suggestions ENGINE (the metered Haiku
// path, and the AI client behind it) into the initial chunk.

/** agentId -> signatures of picker instances already answered for that agent. Never pruned during a
 *  session: an entry is a small Set and an agent id is not reused. */
const HANDLED_SIGS = new Map<string, Set<string>>();

/** The de-dupe set for `agentId`, created on first ask. Call it at USE time, never cache it against
 *  an id read earlier — that is the bug in roborev 53159. */
export function handledSigsFor(agentId: string): Set<string> {
  let s = HANDLED_SIGS.get(agentId);
  if (!s) HANDLED_SIGS.set(agentId, (s = new Set()));
  return s;
}

/**
 * Clear an agent's answered-picker signatures. The invalidation CANNOT live in a mounted effect
 * (roborev 53159).
 *
 * The signature is the option set alone, so every Claude Code bash permission prompt shares one —
 * the set is only meant to stop ONE settled screen re-sending a keystroke while it re-hashes during
 * a single your-turn. A later, genuinely distinct prompt with the same options must be answered
 * again. `useSuggestions.onRuntimeStatusChange` is what calls this, at module level, watching EVERY
 * agent's status rather than the mounted one's — the agent that most needs clearing is the one
 * nobody is looking at.
 */
export function clearHandledSignatures(agentId: string): void {
  HANDLED_SIGS.get(agentId)?.clear();
}

/** Drop an agent's registry entry entirely (or every entry when called with no id). Tests only —
 *  module state outlives a render, and a leaked signature would suppress the next case's answer. */
export function resetHandledSignatures(agentId?: string): void {
  if (agentId === undefined) {
    HANDLED_SIGS.clear();
    return;
  }
  HANDLED_SIGS.delete(agentId);
}

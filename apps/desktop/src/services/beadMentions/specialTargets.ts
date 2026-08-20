// The two APP-GLOBAL mention targets: which handles reach them, and how they map to the wire.
//
// Split out of `beadMentionWatch` so it is testable on its own: the watcher is store glue (project
// store, beads store, Tauri invoke) and cannot be driven in a unit test, while these two rules are
// pure and are exactly the kind of thing that goes quietly wrong.

import { SPARKLE_AGENT_ID, SPARKLE_AGENT_DISPLAY_NAME } from "../sparkleAgent";
import { CONCIERGE_CALLER_AGENT_ID } from "../controlListener";
import type { MentionCandidate } from "../agentMentionResolve";

/**
 * `@improve` and `@sparkle` — neither of which is a roster row, so the project search can never find
 * them.
 *
 * INCLUDING THEM IS THE POINT, not a nicety. `@improve` is the handle from the incident that
 * commissioned this feature. Without these entries the router would answer a comment reading
 * "@improve stand down" with "improve matches no agent that can be addressed right now" — a refusal
 * that is FALSE, and posted onto a founder-visible bead.
 *
 * Each id is listed under more than one spelling because both are how people really write them: the
 * short handle and the full display name. The router de-duplicates per (comment, agent id), so a
 * comment naming one target under two spellings still wakes it exactly once.
 */
export const SPECIAL_CANDIDATES: readonly MentionCandidate[] = [
  { id: SPARKLE_AGENT_ID, name: "improve" },
  { id: SPARKLE_AGENT_ID, name: SPARKLE_AGENT_DISPLAY_NAME },
  { id: CONCIERGE_CALLER_AGENT_ID, name: "sparkle" },
  { id: CONCIERGE_CALLER_AGENT_ID, name: "concierge" },
];

/**
 * The CANONICAL wire handle for each reserved id — the only spellings `mention.rs::resolve_handle`
 * accepts (`improve` / `sparkle` / `concierge`).
 *
 * THE TOKEN THE AUTHOR TYPED IS NOT A WIRE HANDLE, and forwarding it raw was a real break: this
 * table deliberately registers four spellings so a multi-word one like "Improve Sparkle" is captured
 * whole by the parser, but sending that to the channel is rejected as an unknown handle — so the
 * invoke rejects, the caller records an inbox failure that never happened, NO doorbell is queued at
 * all, and the bead gets a comment blaming the target's inbox. Resolve id → handle here instead, so
 * any future alias added above is automatically carried rather than silently breaking.
 */
export function wireHandleFor(agentId: string): string | null {
  if (agentId === SPARKLE_AGENT_ID) return "improve";
  if (agentId === CONCIERGE_CALLER_AGENT_ID) return "sparkle";
  return null;
}

/** The spellings the PARSER needs to know about, so a multi-word one ("Improve Sparkle") is captured
 *  whole rather than truncated at the first word. Resolution is `resolveSpecialHandle`'s job. */
export const SPECIAL_HANDLE_NAMES: readonly string[] = SPECIAL_CANDIDATES.map((c) => c.name);

/**
 * Resolve a reserved handle — CASE-INSENSITIVELY, and BEFORE the roster is consulted.
 *
 * TWO FAILURES THIS FIXES, both of which produced a false "matches no agent" refusal on a
 * founder-visible bead for the app's own reserved address.
 *
 * 1. CASE. The parser and `resolveAgentMention` are exact and case-SENSITIVE by design, but the
 *    capitalized spellings are the ones the app itself teaches: `SPARKLE_AGENT_NAME = "Sparkle"` is
 *    documented as "what a human types after `@` to address this agent", the concierge composer
 *    reserves the bare `@Sparkle` as a deliberate escape hatch (bead `sparkle-k5kit`), and it is
 *    what speech dictation produces. The Rust authority for these same four handles,
 *    `mention.rs::resolve_handle`, lowercases before matching. Matching them case-sensitively made
 *    `@Sparkle` — the most likely spelling in the fleet — resolve to nobody.
 *
 * 2. SHADOWING. Concatenating these onto the roster and resolving in one pass means ANY user agent
 *    named "Improve Sparkle" collides, and `resolveAgentMention` answers `ambiguous` on any name
 *    collision — so the reserved handle becomes unaddressable exactly when a similarly-named agent
 *    is running. The concierge composer already paid for this and settled it the other way: the way
 *    OUT cannot itself be shadowed by the thing being mounted to. Reserved wins; the roster row is
 *    still reachable by its agent id.
 */
export function resolveSpecialHandle(token: string): MentionCandidate | null {
  const t = token.trim().toLowerCase();
  return (
    SPECIAL_CANDIDATES.find((c) => c.name.toLowerCase() === t) ?? null
  );
}

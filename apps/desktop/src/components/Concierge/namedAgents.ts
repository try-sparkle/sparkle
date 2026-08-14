// WHICH AGENTS DID THE FOUNDER NAME IN THIS MESSAGE — the permission half of the relay gate.
//
// The gate in services/conciergeTools/relayGate refuses to forward his words to an agent he never
// named. That question has to be answered somewhere that holds the ROSTER, which the service layer
// does not, so it is answered here and published with the turn.
//
// ══ TWO WAYS OF NAMING, AND BOTH COUNT ══════════════════════════════════════════════════════════
// The `@`-mention is the app's formal notion, and it is the reliable one: the composer resolved it
// against the live fleet, so the id is certain. But he does not always reach for the picker — "tell
// Kraken Auth to stop" names an agent just as plainly as "@Kraken Auth" does, and refusing that
// relay would enforce the picker rather than his intent.
//
// SO PROSE NAMES COUNT TOO, and this direction is the SAFE one to be generous in: every id added
// here can only make the gate ALLOW a send it would otherwise refuse. Being wrong costs a relay he
// did not quite ask for; being stingy costs him a working sentence and teaches him to distrust the
// feature. (The BADGE has no such latitude — it is gated on the words themselves, in
// ../../services/relayDerivation, and nothing here can make one appear.)
import type { ConciergeMention, MentionAgent } from "./mentions";

/** Characters that CONTINUE a name, for the boundary test on both sides of a prose match.
 *
 *  Mirrors the class ./mentions uses for the same job and for the same reason: without it an agent
 *  called "Eyes" is found inside "Eyeshadow", and a bystander agent silently acquires permission to
 *  receive his words. Includes `/`, `-`, `.` and `_` because real agent names contain them
 *  ("Blueprint UI/UX", "Drodio.com Publishing MCP"). */
const NAME_CONTINUATION = /[A-Za-z0-9/\-._]/;

/** The shortest agent name matched in PROSE.
 *
 *  Short names are ordinary English. An agent called "Eyes", "Main" or "Chat" would otherwise be
 *  "named" by any sentence that happens to use the word, which quietly grants permission he never
 *  gave. An `@`-mention of the same agent is unaffected — the composer resolved it, so there is
 *  nothing to guess and no floor to apply. */
const MIN_PROSE_NAME = 5;

/** Does `name` appear in `haystack` as a whole name rather than inside a longer word? */
function namedInProse(haystack: string, name: string): boolean {
  if (name.length < MIN_PROSE_NAME) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(name, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1]!;
    const after = haystack[at + name.length] ?? "";
    if (!NAME_CONTINUATION.test(before) && !NAME_CONTINUATION.test(after)) return true;
    from = at + 1;
  }
}

/**
 * The ids of every agent the founder named in `text` — by `@`-mention or by prose name.
 *
 * Pure, and deduplicated. Order is not meaningful to any caller (the gate does a membership test),
 * so it is simply mention-order followed by roster-order.
 */
export function namedAgentIds(
  text: string,
  /** The `@`-mentions the composer already resolved for this message. */
  mentions: readonly ConciergeMention[] | undefined,
  /** The live fleet, for the prose pass. */
  roster: readonly MentionAgent[],
): string[] {
  const ids = new Set<string>();
  for (const m of mentions ?? []) if (m.agentId) ids.add(m.agentId);
  const haystack = text.toLowerCase();
  for (const a of roster) {
    if (ids.has(a.id)) continue;
    const name = a.name?.trim().toLowerCase();
    if (!name) continue;
    if (namedInProse(haystack, name)) ids.add(a.id);
  }
  return [...ids];
}

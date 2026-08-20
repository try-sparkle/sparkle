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
//
// ══ A BEAD IS NOT A NAMING, ON EITHER PATH (bead sparkle-1cpomd) ═══════════════════════════════
// Beads joined the mention roster so tasks and epics can be @mentioned like agents, and that puts
// ~2,000 rows into the list this walks — every one of them a SENTENCE rather than a name. Two things
// follow, and the second is why this is a correctness fix and not a tidy-up.
//
//   • THE PROSE PASS MUST SKIP THEM. `namedInProse` is deliberately generous because being wrong
//     costs a relay he did not quite ask for. That trade is priced for ~60 short agent names; run
//     over a backlog of sentences it inverts, because a bead title is made of the same words the
//     message is. It is also ~2,000 substring sweeps per turn for an answer that can only ever be
//     "no agent".
//   • THE @-MENTION PASS MUST SKIP THEM TOO, and that one is easy to miss: the loop below adds every
//     resolved mention id unconditionally, so clicking Chat on a bead card would drop `bead:<id>`
//     straight into the relay-permission set. Nothing could match it — the gate keys on agent ids —
//     so it is harmless TODAY, by exactly the accident-of-lookup this feature refused to rely on in
//     `composerRoute.addressingSpan`. A permission set is the last place to leave an entry whose
//     safety is incidental rather than stated.
//
// The rule is one sentence in both halves: a bead names WORK, never a recipient, so it can never
// grant permission to relay.
import { isBeadMentionId } from "./mentions";
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
  for (const m of mentions ?? []) {
    if (!m.agentId || isBeadMentionId(m.agentId)) continue;
    ids.add(m.agentId);
  }
  const haystack = text.toLowerCase();
  for (const a of roster) {
    if (isBeadMentionId(a.id)) continue;
    if (ids.has(a.id)) continue;
    const name = a.name?.trim().toLowerCase();
    if (!name) continue;
    if (namedInProse(haystack, name)) ids.add(a.id);
  }
  return [...ids];
}

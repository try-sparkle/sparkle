// THE RELAY GATE — the founder's own words go where HE aimed them, or they do not go at all.
//
// ══ THE RULING ══════════════════════════════════════════════════════════════════════════════════
// Founder, 2026-08-13, on seeing his message to the concierge rendered as forwarded to a build agent
// he had never named (bead `sparkle-p9s5q`):
//
//   "if I'm just talking to the concierge, it should not be showing my messages being sent to a
//    build agent."
//   "(Be clear, nor should it send it to a build agent unless I have mentioned that build agent.)"
//
// The second sentence is why this module exists rather than a rendering fix alone. He is not asking
// for a better label on the relay — he is withdrawing the concierge's permission to relay at all
// unless he named the destination. So the SEND is refused here, before anything reaches a PTY.
//
// ══ WHAT IS AND IS NOT REFUSED ══════════════════════════════════════════════════════════════════
// Exactly one shape is refused: a send whose text CARRIES HIS OWN WORDS (../relayDerivation) to an
// agent he did not name. Everything else is untouched, and the exclusions are the point:
//
// EVERY OP THAT CARRIES A MESSAGE TO AN AGENT IS GATED — the terminal write AND both inbox ops. The
// first version gated only `send_to_agent_terminal`, which left the ruling walkable one op over:
// `fleet.inbox_send` takes the same `text`, classifies to the same `kind: "sent"`, and the badge
// admits `channel: "inbox"` — so the concierge could forward his verbatim words to an agent he never
// named, unrefused, and his bubble would still get the card. Same symptom, same ruling, different
// tool. `inbox_broadcast` is gated per-recipient for the same reason.
//
//   • A CONCIERGE-COMPOSED BRIEF IS NOT A RELAY and is fully allowed. "STOP — you are 42 commits
//     ahead of origin/main" is the concierge's own judgement, sent under its own name, and he said
//     so plainly when choosing how it should render: "He needs to keep seeing what I send to his
//     fleet." Blocking those would fix the misattribution by deleting his visibility, which is a
//     worse trade than the bug.
//   • A SEND OUTSIDE ANY USER TURN is not a relay — there is no founder text for it to carry — so
//     the concierge's autonomous work (overnight sweeps, nudges, follow-ups) is never gated.
//   • THE FOUNDER'S OWN `@Agent …` COMPOSER PATH DOES NOT COME THROUGH HERE AT ALL. It dispatches
//     directly (ConciergeHost's `dispatchToTerminal`), so nothing in this file can stand between him
//     and an agent he addressed himself.
//
// ══ WHY THE REFUSAL IS FAIL-OPEN AND THE BADGE IS FAIL-CLOSED ═══════════════════════════════════
// They read the SAME predicate and disagree about which way "unknown" should fall, deliberately:
//
//   • This gate REFUSES AN ACTION. An unprovable case must not block legitimate work, so "we cannot
//     show this carries his words" → allow.
//   • The badge MAKES A CLAIM about his private words. An unprovable case must not assert a
//     delivery, so "we cannot show this carries his words" → no badge.
//
// Both fall the safe way for what they each do, and `carriesFounderWords` returning false is what
// each of them treats as safe. That is not an inconsistency to tidy up — collapsing them onto one
// direction would either block the concierge's own briefs or restore the false claim.
import { currentConciergeTurnContent } from "../conciergeReceipts";
import { carriesFounderWords } from "../relayDerivation";

/**
 * The refusal sentence for a send that would relay the founder's words to an agent he never named,
 * or `null` when the send may proceed.
 *
 * A SENTENCE RATHER THAN A BOOLEAN, because the concierge reads it and has to know what to do next.
 * A bare "denied" produces a retry loop — the model tries the same call, gets the same word, and the
 * founder's instruction never reaches the agent by any route. The wording therefore names both legal
 * ways forward: compose your own brief, or ask him to name the agent.
 *
 * Pure apart from ONE module read (`currentConciergeTurnContent`), which is the turn state the host
 * publishes at dispatch. Tests drive it through `setConciergeTurnOrigin`.
 */
export function refuseUnaddressedRelay(
  /** Every agent this send would reach. A single send passes one; a broadcast passes all of them. */
  agentIds: readonly string[],
  text: string,
): string | null {
  const { text: founderText, mentionedAgentIds } = currentConciergeTurnContent();
  // NOT A RELAY — the concierge composed this, or there is no turn to compare against. Allowed.
  if (!carriesFounderWords(founderText, text)) return null;
  // HE NAMED THEM, so his words are going where he aimed them. Allowed, and this is the only path
  // on which the `Sent to:` badge may appear on his bubble.
  //
  // EVERY recipient must be named, not merely one. A broadcast is refused if it reaches ANYONE he
  // did not name: naming one agent is not consent for his words to go to the rest of the fleet
  // alongside it, and there is no partial send to fall back to.
  const unnamed = agentIds.filter((id) => !mentionedAgentIds.includes(id));
  if (unnamed.length === 0) return null;
  const who = agentIds.length > 1 ? "every agent it would reach" : "this agent";
  return (
    `Not sent: that text carries the founder's own words, and he did not name ${who}. His ` +
    "message went to you, not to the fleet — forwarding it makes his private words look like an " +
    "instruction he addressed to an agent, which is exactly what he asked to stop. Either write " +
    "your OWN brief in your own words (that is always allowed, and he sees it attributed to you), " +
    "or ask him to name the agent he means."
  );
}

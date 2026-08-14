// DID THIS SEND CARRY THE FOUNDER'S OWN WORDS? — the one predicate two very different guards share.
//
// ══ THE COMPLAINT ═══════════════════════════════════════════════════════════════════════════════
// "why are you sending what i ask you to agents, like this?" (founder, 2026-08-13, bead
// `sparkle-p9s5q`). He asked the concierge "You should have better memory now. can you tell me if
// that's true?" and his own bubble came back stamped `Sent to: @Drodio.com Publishing MCP`. It had
// not been sent anywhere. In that same turn the concierge had written two briefs OF ITS OWN — "STOP
// — you are 42 commits ahead of origin/main" and "commit your untracked files" — to two agents, and
// the badge was stapled onto whichever bubble happened to be awaiting when the turn began.
//
// A second sighting the same day, same shape: "I just updated to v0.107.0. make sure all agents are
// productive" → `Sent to: @Builder Index Peer Visibility`, an agent he had never named.
//
// THE ASSOCIATION WAS BY TURN, NOT BY CONTENT. `originBubbleId` answers "which message was in flight
// when this call started", which is a real and useful question — it is what stops a receipt landing
// on some LATER bubble (services/conciergeReceipts). But it was being read as the answer to a
// different question: "did this send carry what he wrote?" Those coincide only when the concierge is
// relaying; when it composes its own brief they are unrelated, and the badge then reports a forward
// that never happened.
//
// WHY THAT IS WORSE THAN A COSMETIC BUG. The badge is a DELIVERY CLAIM about the founder's private
// words. Once it can be wrong he cannot tell a genuine relay from the concierge acting on its own,
// so he has to assume everything he types is reaching his fleet — which is the end of the relay
// surface being trustworthy at all.
//
// ══ WHAT THIS MODULE DECIDES, AND WHAT IT DELIBERATELY DOES NOT ═════════════════════════════════
// It answers exactly one question: does `sentText` demonstrably CARRY `founderText`? It knows
// nothing about receipts, bubbles, agents or rendering, so both callers below can be tested without
// a DOM, a store, or a socket:
//
//   1. `conciergeTools/registry` — the SEND gate. A relay of his words to an agent he never named is
//      REFUSED outright (founder, same session: "nor should it send it to a build agent unless I
//      have mentioned that build agent"). Not a labelling fix — the send does not happen.
//   2. `ConciergeHost` — the BADGE gate. Only a send this predicate accepts may stamp `Sent to:` on
//      his bubble (Concierge/SentToAgentRow).
//
// ONE predicate for both, deliberately. If the gate and the badge could disagree, the disagreement
// would be exactly the false claim this exists to remove: a send the gate treated as the concierge's
// own composition, rendered as a forward of his words.
//
// ══ STRICT, AND FAIL-CLOSED — THE FOUNDER'S OWN CALL ════════════════════════════════════════════
// Asked to choose between verbatim-carry and a looser word-similarity test, he chose verbatim
// ("STRICT — badge only on verbatim carry"). The two errors are NOT symmetric, which is why:
//
//   • A FALSE NEGATIVE (a real relay that goes unbadged) costs him almost nothing. The concierge's
//     own receipt row below the bubble still reports the send, so the fact is on screen either way;
//     only the stronger visual claim is withheld.
//   • A FALSE POSITIVE is the entire bug. It tells him his private words left the room when they
//     did not.
//
// So an unprovable case answers NO. Every `return false` here is that rule, not an oversight.
//
// ══ WHY A SUBSTRING AND NOT A SIMILARITY SCORE ══════════════════════════════════════════════════
// A relay is a QUOTE — the concierge pastes what he wrote, usually inside its own framing ("The
// founder says: …. Please handle it."). Containment is exactly that relationship, and it is the only
// test with no threshold to tune and no way to drift into accepting a paraphrase. A similarity score
// would accept "the retry work is blocked, stop" as a relay of "ship the retry fix" on shared
// vocabulary alone, which is the false positive above wearing a number.

/** How long the founder's normalized words must be before mere CONTAINMENT counts as a relay.
 *
 *  WITHOUT THIS FLOOR THE PREDICATE IS TRIVIALLY TRUE for short messages, and short messages are
 *  common: "ok", "go", "do it", "yes please". Every one of those appears inside some ordinary brief
 *  the concierge might compose ("go ahead and rebase"), so containment alone would badge his bubble
 *  on a coincidence of two letters — the original bug, reintroduced through the fix.
 *
 *  IT APPLIES TO AN EXACT MATCH TOO. An earlier version exempted equality, reasoning that it "cannot
 *  happen by accident" — see the note at the comparison itself for the measured counter-example
 *  (`continue`, typed by him and sent independently by the concierge in the same turn).
 *
 *  16 characters is roughly three ordinary words — long enough that appearing verbatim inside an
 *  independently-composed brief is not a coincidence, short enough to admit real relays ("ship the
 *  retry fix" is 18). */
export const MIN_RELAY_NEEDLE = 16;

/** Characters trimmed from the ENDS of the founder's words before the containment test.
 *
 *  A relay is re-typed prose, so its punctuation drifts at the seams: he ends with "?" and the
 *  concierge's framing ends the quote with "." or drops the mark entirely. Trimming both ends of the
 *  NEEDLE tolerates that without loosening the interior of the match at all.
 *
 *  ONE-SIDED ON PURPOSE — the haystack is never trimmed. Its punctuation is the concierge's framing
 *  and has no bearing on whether his sentence is inside it. */
const EDGE_PUNCTUATION = /^[\s"'`.,;:!?\-–—()[\]{}]+|[\s"'`.,;:!?\-–—()[\]{}]+$/g;

/**
 * Fold one string to the form the comparison runs on.
 *
 * Three normalisations, and the list is short BY DESIGN — every extra one widens what counts as "his
 * words" and so widens the false-positive surface this module exists to close:
 *
 *   • CASE, because a concierge quoting him inside a sentence re-capitalises the first letter.
 *   • WHITESPACE, because a quote gets re-wrapped: newlines become spaces, runs collapse. Written as
 *     a single collapse rather than a strip, so word boundaries survive and "ship it" can never
 *     match inside "shipit".
 *   • SMART PUNCTUATION, because the composer and the model produce different bytes for the same
 *     character. "that's" typed with U+2019 and re-emitted as U+0027 is the SAME WORD, and a relay
 *     that fails on an invisible codepoint difference is a false negative nobody can debug from the
 *     screen. Only quotes and dashes are folded — the marks with a well-known ASCII twin.
 *
 * Deliberately NOT done: stripping interior punctuation, stemming, dropping stop-words. Each would
 * let a paraphrase pass as a quote.
 *
 * Exported for the tests, which pin the folding separately from the verdict — a normaliser that
 * quietly stopped folding smart quotes would otherwise only show up as a missing badge.
 */
export function normalizeRelayText(raw: string): string {
  return raw
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does `sentText` carry `founderText` — i.e. is this send a RELAY of his words rather than something
 * the concierge composed itself?
 *
 * TOTAL and PURE: every input is optional because both call sites can genuinely lack one (a call
 * that started outside any user turn has no founder text; a refused send may carry no text), and
 * "we do not know" resolves to NO per the fail-closed rule in this module's header.
 */
export function carriesFounderWords(
  /** Exactly what the founder typed in the turn this send belongs to. */
  founderText: string | undefined | null,
  /** The text the concierge asked to write into the agent. */
  sentText: string | undefined | null,
): boolean {
  if (typeof founderText !== "string" || typeof sentText !== "string") return false;
  const haystack = normalizeRelayText(sentText);
  // TRIMMED ONLY ON THE NEEDLE — see EDGE_PUNCTUATION. Normalise first so the trim runs against
  // folded dashes rather than against whichever dash he happened to type.
  const needle = normalizeRelayText(founderText).replace(EDGE_PUNCTUATION, "");
  if (!needle || !haystack) return false;
  // ONE FLOOR, BOTH DOORS — and the exception this replaces was a real defect (roborev 64197).
  //
  // There used to be an EXACT door open at any length, on the reasoning that "equality cannot happen
  // by accident". That is false for exactly the strings the floor below names. One-word imperatives
  // are the HIGHEST-coincidence case, not an exempt one: the founder types `continue` in the
  // concierge thread, the concierge independently nudges a stuck agent with `continue` — a repeat
  // `conciergeTools/policyBinding` documents as legitimate — and the two are byte-identical while
  // having nothing to do with each other. The consequences ran in both directions at once: the send
  // was REFUSED with a lecture about forwarding his private words, and the bubble got a card
  // claiming a message he never sent had left the room. Same for `go`, `ok`, `yes`, `ship it`.
  //
  // So a short message takes no door at all. That costs a badge on a genuinely relayed one-word
  // instruction — which he can still read on the receipt line below the bubble — and buys back the
  // whole class of coincidental matches on the words people actually type most often.
  if (needle.length < MIN_RELAY_NEEDLE) return false;
  return haystack.includes(needle);
}

// WHAT THE THREAD SAYS ABOUT A MESSAGE IT HANDED ON — the two quote budgets and the two lines built
// from them.
//
// Extracted verbatim from ConciergeHost, which re-exports `relayFollowUp` (mention.test.tsx imports
// it from there). Pure string work with no component state: the bounds are the interesting part, and
// they are two DIFFERENT numbers for two different reasons, spelled out below.
import { oneLine } from "../promptHistory";

/** How much of a relayed message is quoted back to the brain when it acknowledges the hand-off.
 *  Bounded for the reason the router bounds its context line: a pasted essay would otherwise bill
 *  unbounded metered input tokens on every mention. */
export const RELAY_QUOTE_CHARS = 240;

/** How much of a held message a deferred-send OUTCOME quotes back into the thread before eliding.
 *
 *  Its own number rather than {@link RELAY_QUOTE_CHARS}, because the two are bounded for different
 *  reasons: that one protects a metered token bill, this one protects a narrow column's geometry — the
 *  quote is there so the user can tell WHICH held message an outcome refers to (roborev 53123), and a
 *  recognisable head does that in a line or two. The payload itself is not lost: past
 *  `shouldPasteAsPill` it rides on the message as a collapsed block. Matches the countdown banner's
 *  `MAX_QUOTED_CHARS`, which quotes for the same reason on an equally narrow surface. */
export const OUTCOME_QUOTE_CHARS = 120;

/** Bound a one-lined quote for the transcript. See {@link OUTCOME_QUOTE_CHARS}. */
export function elideQuote(text: string): string {
  return text.length <= OUTCOME_QUOTE_CHARS ? text : `${text.slice(0, OUTCOME_QUOTE_CHARS - 1)}…`;
}

/**
 * What Sparkle is asked after it has relayed a message — the founder's headline requirement:
 * *"the concierge sends it over to that builder agent, but ALSO still participates in the
 * conversation… I want the concierge to be a thought partner."*
 *
 * A real brain turn, not a canned line. `postSparkle("Sent to X.")` would satisfy "says something"
 * and miss the ask entirely: the point is that addressing an agent starts a conversation ABOUT that
 * agent rather than ending one. The receipt under the bubble already states the bare fact of
 * delivery, so this prompt asks for the half a receipt cannot give.
 *
 * Phrased in the user's voice because `buildSnapshot` wraps it in "The user says:" — writing it as
 * an instruction to the assistant there would read as the user issuing stage directions.
 */
export function relayFollowUp(agentName: string, sent: string): string {
  const quoted = oneLine(sent).slice(0, RELAY_QUOTE_CHARS);
  return `(I just used the concierge to send "${quoted}" over to my build agent "${agentName}". Confirm briefly that it went, then stay with me on it — what else should I be thinking about, or want to take up with ${agentName}?)`;
}

// Who a queued message is FROM, for every surface that renders one.
//
// This exists because the answer was being re-derived per renderer, and there turned out to be five
// of them — two agent-facing (`fleetWatch.draftDelivery`, `fleetWatch.draftIdleDelivery`) and three
// human-facing (`MountedAgentThread`'s queued bubble, `AgentInboxBadge`'s popover,
// `MountedAgentNotices`' expanded mailbox). Each round of review found one more that had been
// missed, and every miss had the same shape: a peer's message rendered as though the concierge had
// queued it.
//
// WHY THAT IS A CORRECTNESS BUG AND NOT COPY. The concierge speaks on the founder's behalf, so a
// message in its register carries human authority. A peer carries none. If the two are
// indistinguishable, an agent refused something by its own permissions can ask a sibling to do it
// instead, and the request arrives wearing authority nobody granted it — cross-session permission
// laundering, which is the one use this channel must never have.
//
// `CONCIERGE_SENDER` is a TRUST-BOUNDARY value, not a label: it is produced by `inbox.rs`'s
// `resolve_from` and decides, on every one of those five surfaces, whether a message is shown as
// authoritative. `peerAttribution.test.ts` pins it against what the producers actually emit, because
// a drifting copy would silently move every genuine concierge message into the peer register — a
// user-facing untruth on the trusted path — while a test whose fixture hardcodes the same literal it
// asserts against stays green throughout.

/** The one sender that is not a peer. Mirrors `inbox.rs::resolve_from`'s default and the delivery
 *  hook's own constant; pinned to both by `peerAttribution.test.ts`. */
export const CONCIERGE_SENDER = "concierge";

/** What an unreadable sender renders as. */
export const UNKNOWN_SENDER = "unknown sender";

/**
 * Who this message is from.
 *
 * An unreadable `from` degrades to {@link UNKNOWN_SENDER}, NEVER to the concierge. That direction is
 * the whole point: attributing an unverifiable message to the concierge grants it authority on no
 * evidence, while "unknown" merely shows the attribution. Failing towards less authority is safe;
 * failing towards more is the bug.
 */
export function senderOf(from: unknown): string {
  return typeof from === "string" && from.trim() ? from.trim() : UNKNOWN_SENDER;
}

/** Is this message from something other than the concierge — i.e. does it need attribution? */
export function isPeerSender(from: unknown): boolean {
  return senderOf(from) !== CONCIERGE_SENDER;
}

/** Does any message in this set come from a peer? Drives the header on surfaces that describe a
 *  whole queue rather than one message. */
export function anyPeer(entries: readonly { from?: unknown }[]): boolean {
  return entries.some((e) => isPeerSender(e.from));
}

/** The line shown beside a peer's message on a human-facing surface. Says both halves: who sent it,
 *  and that being sent by them grants it nothing. */
export function peerAttributionLine(from: unknown): string {
  return `from peer agent ${senderOf(from)} · not the concierge, and carries no human authority`;
}

/** The header for a queue that contains at least one peer message. Replaces copy that used to state
 *  "Queued by the concierge" unconditionally — which was not merely silent about a peer's message
 *  but affirmatively wrong about it, on the surface a human opens to check provenance. */
export const MIXED_QUEUE_HEADER =
  "Queued for this agent · at least one message below is from a PEER AGENT, not the concierge";

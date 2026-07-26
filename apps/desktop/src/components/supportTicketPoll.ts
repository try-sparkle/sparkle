import type { TicketStatus } from "../services/supportApi";

/** Helpers for the sidebar's support-ticket banner poll (see SupportTicketRow in AgentSidebar).
 *  Split out as pure functions so the two conditions worth getting right — "is this tick worth
 *  doing" and "did the answer actually change" — are unit-testable without mounting the sidebar. */

/** Whether a scheduled poll tick should actually fetch. A hidden window is one nobody is looking
 *  at, so the tick is skipped and the banner re-syncs on the way back (SupportTicketRow listens for
 *  `visibilitychange` and `focus`). Mirrors the gate beadsStore.startPolling uses for the same
 *  reason. `doc` is optional because a non-DOM host has no visibility to consult — there we poll,
 *  since the alternative is a banner that never updates at all. */
export function shouldPollTickets(doc: Document | undefined = globalThis.document): boolean {
  return doc?.visibilityState !== "hidden";
}

/** A change signature for a fetched ticket list. The banner row is `memo`'d and its state is an
 *  array, so calling setState with a fresh array identity re-renders it every single poll even when
 *  the backend returned exactly the same tickets — once a minute, forever. Comparing signatures
 *  first keeps the identity stable across an unchanged poll.
 *
 *  Only `token` and `status` are included: those are the two fields bannerFromTickets reads, so
 *  they are precisely what can change the rendered output. Order is significant because
 *  bannerFromTickets preserves input order in `openTickets`, which drives the expanded list.
 *
 *  Fields are JSON-encoded rather than concatenated raw so a token containing the separator can't
 *  forge a different list's signature. */
export function ticketsSignature(tickets: readonly TicketStatus[]): string {
  return JSON.stringify(tickets.map((t) => [t.token, t.status]));
}

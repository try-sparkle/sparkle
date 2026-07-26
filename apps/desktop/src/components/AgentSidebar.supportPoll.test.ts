import { describe, it, expect } from "vitest";
import { shouldPollTickets, ticketsSignature } from "./supportTicketPoll";
import type { TicketStatus } from "../services/supportApi";

/** The sidebar's support-ticket banner polls on a 60s interval for the life of the sidebar — i.e.
 *  for the whole session. These cover the two things that keep that poll from doing work nobody
 *  asked for: skipping a tick while the window is hidden, and not re-rendering a memo'd row when
 *  the fetched list is unchanged. */
describe("shouldPollTickets", () => {
  const withVisibility = (state: DocumentVisibilityState | undefined) =>
    state === undefined ? undefined : ({ visibilityState: state } as Document);

  it("polls when the window is visible", () => {
    expect(shouldPollTickets(withVisibility("visible"))).toBe(true);
  });

  it("skips the tick when the window is hidden", () => {
    expect(shouldPollTickets(withVisibility("hidden"))).toBe(false);
  });

  it("polls when there is no document at all (non-DOM host)", () => {
    // Guard against a headless/test host turning the banner into a permanently stale row.
    expect(shouldPollTickets(withVisibility(undefined))).toBe(true);
  });
});

describe("ticketsSignature", () => {
  const ticket = (token: string, status: TicketStatus["status"]): TicketStatus =>
    ({ token, status }) as TicketStatus;

  it("is stable across two structurally equal lists", () => {
    const a = [ticket("t1", "awaiting_support"), ticket("t2", "awaiting_user")];
    const b = [ticket("t1", "awaiting_support"), ticket("t2", "awaiting_user")];
    expect(ticketsSignature(a)).toBe(ticketsSignature(b));
  });

  it("changes when a ticket's status changes", () => {
    const before = [ticket("t1", "awaiting_support")];
    const after = [ticket("t1", "awaiting_user")];
    expect(ticketsSignature(before)).not.toBe(ticketsSignature(after));
  });

  it("changes when a ticket is added or removed", () => {
    const one = [ticket("t1", "awaiting_support")];
    const two = [ticket("t1", "awaiting_support"), ticket("t2", "awaiting_support")];
    expect(ticketsSignature(one)).not.toBe(ticketsSignature(two));
    expect(ticketsSignature([])).not.toBe(ticketsSignature(one));
  });

  it("distinguishes two tickets that differ only by order", () => {
    // bannerFromTickets preserves input order, so order is user-visible in the expanded list.
    const ab = [ticket("t1", "awaiting_support"), ticket("t2", "awaiting_user")];
    const ba = [ticket("t2", "awaiting_user"), ticket("t1", "awaiting_support")];
    expect(ticketsSignature(ab)).not.toBe(ticketsSignature(ba));
  });

  it("does not collide when a token contains the field separator", () => {
    const a = [ticket("t1|awaiting_user", "awaiting_support")];
    const b = [ticket("t1", "awaiting_user"), ticket("awaiting_support", "awaiting_support")];
    expect(ticketsSignature(a)).not.toBe(ticketsSignature(b));
  });
});

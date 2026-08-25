// @vitest-environment jsdom
//
// ── AN APP-AUTHORED PROMISE NUDGE MUST NOT READ AS THE CONCIERGE TALKING TO THE FOUNDER ───────────
//
// THE DEFECT (bead sparkle-hxypas). `ConciergeHost.postSparkle` posts the promise-ledger nudge —
// "You said you'd land the retry PR — and that hasn't happened." — as an ordinary `kind: "sparkle"`
// message. It is addressed to the FOUNDER (not the concierge), so `./noticeRecipient` correctly
// leaves it full-weight with no grey header; but it carries no mark of any kind, so it renders
// identically to a brain reply. The founder reported exactly that: these lines "look like messages
// from the concierge to me when they're not."
//
// THE FIX is an AUTHORSHIP axis orthogonal to the recipient/ink one: a `appNotice` flag on the
// message draws a muted "Sparkle reminder" mark above the sentence — the line stays full-weight (he
// must act on it) while being visibly authored by the app, not the concierge. `./noticeRecipient`
// is untouched.
//
// ══ WHY THESE TESTS MOUNT THE NUDGE, A PLAIN REPLY, AND A CONCIERGE-ADDRESSED RECEIPT AT ONCE ═════
// The rule picks one of THREE renderings (authorship mark / nothing / grey routing header), so a
// test that renders one row and asserts a mark's absence proves nothing — it is absent because
// there is no element to draw and stays absent if the rule is keyed to the wrong side. That is the
// "N targets, only one mounted" vacuous shape AGENTS.md enumerates. So each case mounts the
// contrast rows in one tree and asserts the mark lands on exactly the nudge.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import { ConciergeMessageRow } from "./ConciergeMessageRow";
import {
  NOTICE_ATTRIBUTION_TESTID,
  NOTICE_AUTHORSHIP_TESTID,
} from "./NoticeAttribution";
import type { ConciergeMessage, ConciergeReceiptMark } from "./types";

const noop = () => {};

/** The exact line from the founder's screenshot, tagged app-authored the way ConciergeHost tags it. */
const PROMISE_NUDGE: ConciergeMessage = {
  id: "nudge-1",
  kind: "sparkle",
  text: "You said you'd land the retry PR — and that hasn't happened.",
  appNotice: true,
} as ConciergeMessage;

/** An ordinary concierge answer — the thing the nudge was being mistaken for. No mark. */
const REPLY: ConciergeMessage = {
  id: "reply-1",
  kind: "sparkle",
  text: "I've started three agents on the retry work.",
  settled: true,
} as ConciergeMessage;

/** A concierge-ADDRESSED receipt — the OTHER axis. It gets the grey routing header, never the
 *  authorship mark, so mounting it proves the two axes do not collide. */
const REFUSAL_MARK: ConciergeReceiptMark = {
  kind: "sent",
  ok: false,
  reason: "that text carries the founder's own words, and he did not name this agent.",
};
const RECEIPT: ConciergeMessage = {
  id: "receipt-1",
  kind: "sparkle",
  text: "Refused the concierge's message to @Alpha — that text carries the founder's own words.",
  actionReceipt: REFUSAL_MARK,
} as ConciergeMessage;

function renderRows(messages: ConciergeMessage[]) {
  const { container } = render(
    <>
      {messages.map((m) => (
        <ConciergeMessageRow
          key={m.id}
          message={m}
          wired={false}
          shownBlockIds=""
          onOpenPayload={noop}
          onNudgeClick={noop}
          onNudgeAction={noop}
          onAnswerCopied={noop}
          onMessageCopied={noop}
        />
      ))}
    </>,
  );
  const row = (id: string) => {
    const el = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!el) throw new Error(`no row rendered for message ${id}`);
    return el;
  };
  return { container, row };
}

afterEach(cleanup);

describe("an app-authored promise nudge carries an authorship mark", () => {
  it("draws a Sparkle authorship mark that an ordinary reply beside it does not", () => {
    const { row } = renderRows([PROMISE_NUDGE, REPLY]);

    // PRESENT on the nudge…
    const mark = within(row("nudge-1")).getByTestId(NOTICE_AUTHORSHIP_TESTID);
    expect(mark.textContent).toContain("Sparkle");
    // …and ABSENT on the plain reply in the same tree. Both mounted, so this is a statement about
    // the rule, not about what happened to be rendered.
    expect(within(row("reply-1")).queryByTestId(NOTICE_AUTHORSHIP_TESTID)).toBeNull();
  });

  it("keeps the nudge FULL-WEIGHT and founder-addressed — it is authorship, not the grey axis", () => {
    // The whole reason for a separate axis: the founder must act on this line, so it must NOT be
    // greyed. The mark makes the author legible without touching the ink.
    const { row } = renderRows([PROMISE_NUDGE]);
    const el = row("nudge-1");
    expect(el.getAttribute("data-recipient")).toBe("founder");
    // No re-inking declaration of any kind — the grey treatment (NOTICE_INK_VARS) is absent.
    expect(el.style.getPropertyValue("--c-cream")).toBe("");
    expect(el.style.color).toBe("");
    // And it carries the grey routing header of NEITHER axis.
    expect(within(el).queryByTestId(NOTICE_ATTRIBUTION_TESTID)).toBeNull();
    // The words are still there — nothing is hidden.
    expect(el.textContent).toContain("You said you'd land the retry PR");
  });

  it("does NOT draw the authorship mark on a plain reply, a concierge receipt, or an untagged app line", () => {
    // The mark keys on `appNotice`, not on "is app-authored" or "is founder-addressed". A concierge
    // receipt is app-authored too but gets the OTHER axis; a reply is neither. Mounting all three
    // pins that the mark lands on exactly the tagged nudge.
    const UNTAGGED_APP_LINE: ConciergeMessage = {
      id: "app-1",
      kind: "sparkle",
      text: "Sent to Alpha.",
    } as ConciergeMessage;
    const { row } = renderRows([PROMISE_NUDGE, REPLY, RECEIPT, UNTAGGED_APP_LINE]);

    expect(within(row("nudge-1")).queryByTestId(NOTICE_AUTHORSHIP_TESTID)).not.toBeNull();
    expect(within(row("reply-1")).queryByTestId(NOTICE_AUTHORSHIP_TESTID)).toBeNull();
    expect(within(row("receipt-1")).queryByTestId(NOTICE_AUTHORSHIP_TESTID)).toBeNull();
    expect(within(row("app-1")).queryByTestId(NOTICE_AUTHORSHIP_TESTID)).toBeNull();
    // …and the receipt still gets its own routing header, so the two axes coexist.
    expect(within(row("receipt-1")).getByTestId(NOTICE_ATTRIBUTION_TESTID)).toBeTruthy();
  });
});

describe("the no-authorship-captions decision still holds with the mark mounted", () => {
  // The founder's 2026-07-27 ruling (ConciergeThread.roleLabels.test) bans the all-caps form and any
  // LEAF node whose ENTIRE text is a speaker name. A bare "Sparkle" span would have violated it; the
  // label is "Sparkle reminder" precisely so it does not. Re-asserted HERE, with an appNotice row
  // actually mounted, because the owning suite never mounts one — so without this the regression is
  // invisible to it.
  it("adds no all-caps caption and no name-only leaf node", () => {
    const { container } = renderRows([PROMISE_NUDGE, REPLY, RECEIPT]);

    expect(/\bSPARKLE\b/.test(container.textContent ?? "")).toBe(false);
    expect(/\bYOU\b/.test(container.textContent ?? "")).toBe(false);

    const leaves = [...container.querySelectorAll("*")].filter((el) => el.children.length === 0);
    const captionish = leaves.filter((el) =>
      /^(sparkle|you)[\s:·—-]*$/i.test((el.textContent ?? "").trim()),
    );
    expect(captionish.map((el) => el.textContent)).toEqual([]);
    // Not vacuous — the authorship mark's own span IS a leaf, so there was a real candidate to catch.
    expect(leaves.length).toBeGreaterThan(5);
  });
});

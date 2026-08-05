// @vitest-environment jsdom
//
// REPLY ANCHORING, RENDERED — the iMessage affordance the founder asked for: "you know how, like,
// with iMessage, it'll show you when you're replying to a previous — you should do that too."
//
// The rule that DECIDES what a reply answers is pinned in ./replyAnchors.test.ts. What is checked
// here is everything that rule cannot see: that a reply draws its quoted originals, that the quote is
// clickable and takes the reader there, that the message he is actually staring at — his own — says
// it was answered and jumps forward, and that a reply covering a burst draws one stub per message in
// the order he sent them.
//
// scrollIntoView is STUBBED, not asserted around: jsdom does not implement it, and the production
// path calls it optionally so a missing implementation cannot throw. Asserting on the stub is what
// makes "the click actually navigates" a real claim rather than "the click did not crash".
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import { ANCHOR_HIGHLIGHT_MS, ANSWERED_MARKER_TESTID, REPLY_ANCHOR_TESTID } from "./ReplyAnchorViews";
import type { ConciergeMessage } from "./types";

const noop = () => {};

/** Mount the thread with the standard required callbacks; only the messages differ per case. */
function mount(messages: ConciergeMessage[]) {
  return render(<ConciergeThread messages={messages} onNudgeClick={noop} onNudgeAction={noop} />);
}

/** The founder's case: three messages fired while a turn was in flight, one reply covering them. */
const burst: ConciergeMessage[] = [
  { id: "you-1", kind: "you", text: "can you check the retry logic", receipt: { target: "sparkle" } },
  { id: "you-2", kind: "you", text: "also the timeout", receipt: { target: "sparkle" } },
  { id: "you-3", kind: "you", text: "and is CI green", receipt: { target: "sparkle" } },
  {
    id: "brain-7",
    kind: "sparkle",
    text: "Retry is fine, the timeout was 3s, CI is green.",
    // SETTLED: only a finished turn marks a message answered (see ./replyAnchors.answeredByIndex).
    settled: true,
    answers: [
      { id: "you-1", quote: "can you check the retry logic" },
      { id: "you-2", quote: "also the timeout" },
      { id: "you-3", quote: "and is CI green" },
    ],
  },
];

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  // Not on the prototype in jsdom at all — assigning it is what lets the assertions below observe
  // the navigation the production code performs.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a reply says what it is answering", () => {
  it("quotes every message of the burst, in the order he sent them", () => {
    mount(burst);
    const stubs = screen.getAllByTestId(REPLY_ANCHOR_TESTID);
    expect(stubs.map((s) => s.textContent)).toEqual([
      "can you check the retry logic",
      "also the timeout",
      "and is CI green",
    ]);
  });

  it("draws the quote ABOVE the reply's own words, the way iMessage does", () => {
    mount(burst);
    const reply = document.querySelector('[data-message-id="brain-7"]')!;
    const html = reply.innerHTML;
    expect(html.indexOf("also the timeout")).toBeLessThan(html.indexOf("the timeout was 3s"));
  });

  it("leaves an unanchored reply completely alone", () => {
    // No stub, and no empty container costing a gap in the thread's flex column.
    mount([{ id: "brain-1", kind: "sparkle", text: "Morning." }]);
    expect(screen.queryByTestId(REPLY_ANCHOR_TESTID)).toBeNull();
  });

  it("takes the reader to the quoted message and lights it up", () => {
    vi.useFakeTimers();
    mount(burst);
    const you2 = document.querySelector('[data-message-id="you-2"]')!;
    expect(you2.getAttribute("data-highlighted")).toBe("no");

    fireEvent.click(screen.getAllByTestId(REPLY_ANCHOR_TESTID)[1]!);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // THE message it scrolled to, not merely "something scrolled" — the whole affordance is which
    // one, and a call count alone would pass with the wrong target.
    expect(scrollIntoView.mock.instances[0]).toBe(you2);
    expect(document.querySelector('[data-message-id="you-2"]')!.getAttribute("data-highlighted")).toBe(
      "yes",
    );
    // …and the flash is temporary. A highlight that never clears is a second kind of persistent
    // state in the thread, on top of an affordance that is meant to be a glance.
    // Inside `act`: the expiry is a setState from a timer, and outside act React has not committed it
    // when the assertion reads the DOM.
    act(() => void vi.advanceTimersByTime(ANCHOR_HIGHLIGHT_MS + 10));
    expect(document.querySelector('[data-message-id="you-2"]')!.getAttribute("data-highlighted")).toBe(
      "no",
    );
  });

  it("degrades to plain text — never a dead button — when the quoted message is gone", () => {
    // A restored thread trimmed from the front leaves anchors with no target (see
    // replyAnchors.remapAnchors). The quote is still a true record; the jump is not offered.
    mount([
      { id: "brain-7", kind: "sparkle", text: "Yes.", answers: [{ id: "", quote: "the old question" }] },
    ]);
    const stub = screen.getByTestId(REPLY_ANCHOR_TESTID);
    expect(stub.textContent).toBe("the old question");
    expect(stub.tagName).not.toBe("BUTTON");
  });
});

describe("his own message says it was answered", () => {
  it("marks every message the reply covered, and none it did not", () => {
    // THE HALF THAT ANSWERS THE COMPLAINT — he is looking at his own bubbles, not at the reply.
    mount([...burst, { id: "you-4", kind: "you", text: "one more", receipt: { target: "sparkle" } }]);
    const marked = screen
      .getAllByTestId(ANSWERED_MARKER_TESTID)
      .map((el) => el.closest("[data-message-id]")!.getAttribute("data-message-id"));
    expect(marked).toEqual(["you-1", "you-2", "you-3"]);
  });

  it("jumps FORWARD to the reply, which is the direction he is missing", () => {
    mount(burst);
    fireEvent.click(screen.getAllByTestId(ANSWERED_MARKER_TESTID)[0]!);
    expect(scrollIntoView.mock.instances[0]).toBe(document.querySelector('[data-message-id="brain-7"]'));
    expect(
      document.querySelector('[data-message-id="brain-7"]')!.getAttribute("data-highlighted"),
    ).toBe("yes");
  });

  it("stops the receipt calling an ANSWERED message unanswered", () => {
    // `askSparkle` stamps `unanswered` on a bubble the next send displaced — true at that instant,
    // not the last word. Once a reply names the message, "never answered" is contradicted by the
    // app's own record and would sit directly above an "Answered below" marker pointing at the
    // answer: one bubble, two opposite claims.
    //
    // THE SIBLING BRANCH LANDED, and this assertion had to change with it.
    //
    // This used to read `not.toContain(receiptText({ target: "sparkle", unanswered: true }))` —
    // differencing against the flag's own wording, chosen deliberately so a hardcoded quote of a
    // string that was "being deleted on a sibling branch" could not fail for the wrong reason. That
    // was the right instinct and it does not survive the deletion, because the technique's premise is
    // that the flag CHANGES the wording. Now that the `unanswered` line is gone (2026-07-31, the
    // founder's call: a displaced turn is frequently answered a couple of messages later, so "never
    // answered" asserted something the app cannot know), `receiptText({unanswered: true})` returns the
    // ordinary "→ Answered here" — so the two assertions below became `toContain(X)` and
    // `not.toContain(X)` over the same X, which cannot both hold. It failed in CI as a self-
    // contradiction, not as a product regression.
    //
    // Pinned against the WORDING it must never carry instead. That is the durable statement of the
    // same intent — this bubble may not accuse the app of never answering while an "Answered below"
    // marker sits under it pointing at the answer — and unlike the difference it stays meaningful
    // whether or not the flag has a rendering of its own.
    mount([
      {
        id: "you-1",
        kind: "you",
        text: "can you check the retry logic",
        receipt: { target: "sparkle", unanswered: true },
      },
      {
        id: "brain-7",
        kind: "sparkle",
        text: "Retry is fine.",
        settled: true,
        answers: [{ id: "you-1", quote: "can you check the retry logic" }],
      },
    ]);
    // THE ORDINARY RECEIPT IS INTACT — asserted as the ROW's presence, not as its wording. The
    // wording is now empty: "Answered here" was removed at the founder's request (RoutingReceipt),
    // so `receiptText({target:"sparkle"})` returns null and `toContain(null)` is a type error rather
    // than a check. The row itself survives because it hosts the redirect, and its presence is what
    // this line was ever really saying. The negative below is the half that carries the intent.
    // `queryBy` + `?? ""`: a concierge-answered message renders NO receipt element now, and the
    // claim this asserts absent is absent a fortiori when the box itself is gone. `getBy` would
    // throw on the missing element instead of testing the string.
    expect(screen.queryByTestId("routing-receipt")?.textContent ?? "").not.toMatch(
      /never answered|replaced by your next message/i,
    );
    // …and the marker is what replaces it: where the answer IS, not a claim there wasn't one.
    expect(screen.getByTestId(ANSWERED_MARKER_TESTID)).toBeTruthy();
  });

  it("keeps the true receipt when the only claimant is a turn that died", () => {
    // THE CHAIN OF KILLED TURNS, which is what 2026-07-29 actually looked like. `you-1` is displaced
    // before a byte arrives, so `askSparkle` correctly stamps `unanswered`. Turn 2 streams nine
    // characters claiming it, then `you-3` kills turn 2 and turn 3 fails outright — no successor ever
    // names `you-1`.
    //
    // Trusting that fragment would put an "Answered below" on `you-1` pointing at nine characters of a
    // dead turn AND delete the one true sentence the bubble had: strictly worse than saying nothing.
    // Both halves key off the same settled evidence, so both must hold.
    mount([
      {
        id: "you-1",
        kind: "you",
        text: "how's CI",
        receipt: { target: "sparkle", unanswered: true },
      },
      {
        id: "brain-2",
        kind: "sparkle",
        text: "Let me ch",
        answers: [{ id: "you-1", quote: "how's CI" }],
      },
      { id: "you-3", kind: "you", text: "hello?", receipt: { target: "sparkle" } },
      { id: "err-1", kind: "failure", headline: "That turn failed.", evidence: "boom" },
    ]);
    expect(screen.queryByTestId(ANSWERED_MARKER_TESTID)).toBeNull();
    // "Answered here" is gone, so the old `toContain(receiptText(...))` compared against null. What
    // this block exists to pin is the WORDING the receipt must never carry, so that is what is
    // asserted — a bare presence check cannot fail (getByTestId throws when absent) and would pass
    // against a build that restored "never answered", which is the exact regression guarded here.
    expect(screen.queryAllByTestId("routing-receipt")[0]?.textContent ?? "").not.toMatch(
      /never answered|replaced by your next message/i,
    );
  });

  it("puts no answered-below marker on a message no reply ever named", () => {
    // ══ RENAMED, BECAUSE THE OLD NAME PROMISED A GUARANTEE NOTHING HELD (roborev 57896) ══════════
    // This was "leaves the unanswered stamp alone on a message no reply ever named", over a comment
    // claiming the stamp is withdrawn only by EVIDENCE. Both went stale on 2026-07-31, when the
    // founder had the "never answered" line deleted outright: `receiptText` does not read
    // `unanswered` at all any more, so there is no stamp to leave alone in any case, evidence or
    // not. A name and a comment promising evidence-gating over an assertion that holds identically
    // for every sibling row is the same false-comment class this file's neighbours were just fixed
    // for — and worse, it would fail on exactly the input where, by its own name, the line SHOULD
    // reappear if that call were ever reversed.
    //
    // What genuinely distinguishes this row from its siblings is the MARKER, so that is what it now
    // pins: `you-1` was displaced and no reply ever named it, so nothing may point at an answer that
    // does not exist. The negative on the receipt wording is kept as the tripwire it always was.
    mount([
      {
        id: "you-1",
        kind: "you",
        text: "still waiting",
        receipt: { target: "sparkle", unanswered: true },
      },
    ]);
    // THE DISCRIMINATOR: no reply named `you-1`, so there is no "Answered below" marker. This is the
    // assertion the row's name is actually about, and the one that does not hold for the answered
    // case at the top of this block.
    expect(screen.queryByTestId(ANSWERED_MARKER_TESTID)).toBeNull();
    // And the receipt still may not carry the deleted claim — kept as a tripwire, not as this row's
    // point, since it holds for every sibling too.
    // `queryBy` + `?? ""`: a concierge-answered message renders NO receipt element now, and the
    // claim this asserts absent is absent a fortiori when the box itself is gone. `getBy` would
    // throw on the missing element instead of testing the string.
    expect(screen.queryByTestId("routing-receipt")?.textContent ?? "").not.toMatch(
      /never answered|replaced by your next message/i,
    );
  });

  it("says nothing under a message nothing has replied to yet", () => {
    mount([{ id: "you-1", kind: "you", text: "hello?", receipt: { target: "sparkle" } }]);
    expect(screen.queryByTestId(ANSWERED_MARKER_TESTID)).toBeNull();
  });

  it("does not mark a message that only a LATER, unrelated reply followed", () => {
    // Adjacency is not an answer. Only the recorded anchor decides, so a reply that named nothing
    // leaves the message above it looking exactly as unanswered as it is.
    mount([
      { id: "you-1", kind: "you", text: "hello?", receipt: { target: "sparkle" } },
      { id: "brain-1", kind: "sparkle", text: "Heads up, CI is red." },
    ]);
    expect(screen.queryByTestId(ANSWERED_MARKER_TESTID)).toBeNull();
  });
});

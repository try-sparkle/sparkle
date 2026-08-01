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

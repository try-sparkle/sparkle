// @vitest-environment jsdom
//
// `onPasted` — the compose box's half of the countdown RESET (bead sparkle-3kqg2v).
//
// THE FOUNDER'S REPORT, given right after confirming the `@`-mention pause already works: *"So maybe
// we just need to reset the countdown if I paste something in or if I drop in an image or upload a
// file. Just reset the countdown back and then start the countdown again."*
//
// Three producers, two channels. The drop and the file picker both funnel through
// `useConciergeAttachments` (see ../../hooks/useConciergeAttachments.stagedSeq.test.tsx); the PASTE
// is the textarea's own event and nothing outside this component can see it. That is the fact this
// file owns.
//
// It is a separate file from ComposeBox.collapsedPaste.test.tsx on purpose. That one is about where
// the pasted BYTES end up — textarea or pill — and this one is about the fact that a paste HAPPENED
// at all, which is true on both of its branches. Sitting them together invites the next reader to
// hang the signal off the pill branch, which is the bug below.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";

afterEach(() => cleanup());

/** Over PILL_MIN_LINES, so this one is intercepted and collapsed into a pill. */
const LONG = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
/** Under it, so the textarea's own native insert handles this one. */
const SHORT = "https://github.com/drodio/sparkle/pull/1934";

function setup() {
  const onPasted = vi.fn();
  render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} onPasted={onPasted} />);
  return { onPasted };
}

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const pills = () => screen.queryAllByTestId("composer-text-pill");

/** Paste `text` the way the browser does. Lifted from ComposeBox.collapsedPaste.test.tsx: jsdom does
 *  not run the default action, so the native insert is performed here only when the handler declined
 *  to prevent it — which keeps this helper honest about BOTH branches. */
function paste(text: string): { prevented: boolean } {
  const ta = box();
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData: { getData: (t: string) => string };
  };
  e.clipboardData = { getData: (t: string) => (t === "text/plain" ? text : "") };
  act(() => {
    ta.dispatchEvent(e);
  });
  if (!e.defaultPrevented) {
    fireEvent.change(ta, { target: { value: ta.value + text } });
  }
  return { prevented: e.defaultPrevented };
}

describe("a paste is reported, on BOTH of the handler's branches", () => {
  it("a SHORT paste reports it — the branch that never calls preventDefault", () => {
    const { onPasted } = setup();
    expect(onPasted).not.toHaveBeenCalled(); // mounting is not a gesture
    const { prevented } = paste(SHORT);
    expect(prevented, "precondition: this is the native-insert branch").toBe(false);
    expect(onPasted).toHaveBeenCalledTimes(1);
  });

  it("a LONG paste reports it too — the branch that returns EARLY into a pill", () => {
    // THE ROW THAT PINS THE PLACEMENT. `onPasted` has to fire ahead of the `shouldPasteAsPill`
    // branch, and a signal hung off the collapsed-paste path (or off `text` changing, which this
    // branch does not do) would miss exactly the pastes big enough to be worth reading before they
    // go out — the wrong half to lose.
    const { onPasted } = setup();
    const { prevented } = paste(LONG);
    expect(prevented, "precondition: this is the pill branch").toBe(true);
    expect(pills()).toHaveLength(1);
    expect(box().value, "the bytes went to the pill, not the textarea").toBe("");
    expect(onPasted).toHaveBeenCalledTimes(1);
  });

  it("ONE CALL PER GESTURE — two pastes are two signals", () => {
    // The countdown owes each gesture its own full threshold (voice/autoSendTimer.restartCountdown
    // is deliberately not idempotent), so a handler that reported only the first would be the
    // founder's complaint arriving one paste later.
    const { onPasted } = setup();
    paste(SHORT);
    paste(SHORT);
    paste(LONG);
    expect(onPasted).toHaveBeenCalledTimes(3);
  });

  it("TYPING is not a paste — the countdown must still run while the box sits idle", () => {
    // The scope the founder narrowed to. Ordinary keystrokes already move the threshold through
    // `onComposedText`; routing them here as well would mean a countdown that restarts on every
    // character and therefore never ends.
    const { onPasted } = setup();
    fireEvent.change(box(), { target: { value: "ship it" } });
    fireEvent.keyDown(box(), { key: "a" });
    expect(onPasted).not.toHaveBeenCalled();
  });

  it("a paste carrying no text/plain still reports — delaying a send is the safe direction", () => {
    // An image or a file promise on the pasteboard reads as "" here. Something still arrived in the
    // box, and the cost of the two readings is asymmetric: a countdown held one threshold too long
    // is invisible, a send that goes out mid-gesture is the bug.
    const { onPasted } = setup();
    paste("");
    expect(onPasted).toHaveBeenCalledTimes(1);
  });
});

describe("the seam is optional, like every other one on this box", () => {
  it("a box mounted WITHOUT the rail pastes normally rather than throwing", () => {
    render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />);
    expect(() => paste(SHORT)).not.toThrow();
    expect(box().value).toBe(SHORT);
  });
});

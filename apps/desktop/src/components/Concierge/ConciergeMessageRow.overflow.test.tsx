// @vitest-environment jsdom
//
// ── THE USER BUBBLE MUST NOT PUSH THE TRANSCRIPT SIDEWAYS (bead sparkle-nheu8) ─────────────────
//
// WHAT THIS IS GUARDING, and why it is a style assertion rather than a layout one. The founder
// reported a HORIZONTAL scrollbar in the concierge column the moment the vertical one appeared. It
// was not caused by the vertical bar: `overflow-y: auto` with `overflow-x: visible` COMPUTES to
// `overflow-x: auto`, so the overflow had always been there and had always been scrollable — the
// macOS overlay bar simply never painted to say so.
//
// Measured in headless Chrome over an adversarial transcript (a run URL, an absolute worktree path,
// a fenced code block, a markdown table), with and without the scrollbar rules, the numbers were
// identical and unambiguous:
//
//   before:  clientWidth 359, scrollWidth 611   → 252px of horizontal overflow
//   after:   clientWidth 349, scrollWidth 349   → 0
//
// and the single offender that accounted for exactly that margin was THIS element — `you-bubble`,
// laid out 569px wide inside a 359px scroller (`over: 252.17`).
//
// THE MECHANISM. `display: inline-block` is shrink-to-fit, so the bubble sizes itself to its own
// MIN-CONTENT; the parent's `maxWidth: 92%` clamps the PARENT, not this. With `overflow-wrap:
// normal` the min-content of one unbroken token is the whole token, so a pasted URL sets the
// bubble's width. `anywhere` is the fix precisely because it is the only value that participates in
// min-content sizing — `break-word` re-wraps the glyphs and leaves the box just as wide, which is
// the near-miss this test exists to catch. `maxWidth: 100%` is the backstop for content that cannot
// break at all (a wide image, a table): it clips an escaped child rather than letting it scroll the
// whole column.
//
// WHY NOT ASSERT THE LAYOUT. jsdom does not lay out and never paints a scrollbar
// (docs/jsdom-test-caveats.md), so `scrollWidth` here is a constant 0 and an overflow assertion
// would pass against ANY styling — the textbook vacuous test. The honest unit-level guard is that
// the two properties the engine reacted to are still declared on the element that had the defect;
// the layout half is settled by the probe above and by the screenshots on the PR.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConciergeMessageRow } from "./ConciergeMessageRow";
import type { ConciergeMessage } from "./types";

const noop = () => {};

/** The shape that produced the 252px overflow: one long unbroken token in a user message. */
const LONG_URL =
  "https://github.com/example/sparkle/actions/runs/1234567890123/jobs/98765432109876?check_suite_focus=true";

function renderYouBubble() {
  render(
    <ConciergeMessageRow
      message={{ id: "you-1", kind: "you", text: `here is the run: ${LONG_URL}` } as ConciergeMessage}
      wired={false}
      shownBlockIds=""
      onOpenPayload={noop}
      onNudgeClick={noop}
      onNudgeAction={noop}
      onAnswerCopied={noop}
      onMessageCopied={noop}
    />,
  );
  return screen.getByTestId("you-bubble");
}

afterEach(cleanup);

describe("the user bubble keeps an unbreakable token inside the column", () => {
  it("breaks anywhere — the only value that shrinks the bubble's MIN-CONTENT", () => {
    expect(
      renderYouBubble().style.overflowWrap,
      "you-bubble is `display: inline-block`, so it sizes to its own min-content. Without " +
        "`overflow-wrap: anywhere` a pasted URL sets that width and the whole transcript grows a " +
        "horizontal scrollbar (bead sparkle-nheu8, measured at 252px). `break-word` is NOT a " +
        "substitute: it re-wraps the glyphs and leaves the box exactly as wide.",
    ).toBe("anywhere");
  });

  it("is capped at its parent's width, for content that cannot break at all", () => {
    expect(
      renderYouBubble().style.maxWidth,
      "The parent's `maxWidth: 92%` clamps the PARENT. Without a cap here, a child that cannot " +
        "wrap (a wide image, a table) escapes the bubble and scrolls the column.",
    ).toBe("100%");
  });
});

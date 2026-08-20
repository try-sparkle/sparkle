// @vitest-environment jsdom
//
// ── A SHORT CONCIERGE LINE MUST NOT LOSE ITS LAST WORD TO A SECOND ROW ────────────────────────────
//
// THE DEFECT (the founder's 2026-08-18 screenshot). A receipt reading "Retired that agent." rendered
// as "Retired that" / "agent." — the break landing at x≈235 in a column running to x≈1400:
//
//     *"It says retired that, and then it says agent on the next line. You often do this. I don't
//      know why you put something on the next line when there's plenty of space."*
//
// He was right that it was not one string. It hit EVERY short left-aligned line in the column, and
// the giveaway is that the overflow is always exactly one word long.
//
// THE MECHANISM, which is not a too-narrow container. Three facts combine, and no two of them are
// enough: these rows are flex items in a column, so `alignSelf: flex-start` sizes them
// SHRINK-TO-FIT; each carries its copy affordance as a `float: left`; and the words are a BLOCK,
// because `<Markdown>` emits a `<p>`. In intrinsic sizing a BLOCK child does not sit beside a float,
// so the row shrink-wraps to the paragraph's max-content ALONE — the float adds nothing to it. The
// float is then laid in, overlapping the block, and shortens its FIRST line box. The paragraph is
// given exactly the width its text needs and then has some of it taken away, so what falls off is
// always the same size: the last word.
//
// Measured in real Chrome by `scripts/visual/prose-row-wrap-probe.mjs`, at a 1400px column:
//
//     "Retired that agent."   row 156px (the paragraph's max-content; the float added nothing)
//                             line 1 usable 118px → "Retired that"
//                             line 2 usable 156px → "agent."
//
// THE INLINE VERSION DOES NOT REPRODUCE. Reduce this with the text in a `<span>` and the float and
// the text DO sum (measured: 176px, one line) — the bug vanishes and the fix looks pointless. The
// probe keeps that as an explicit control so the reduction cannot be got wrong again; it was, once,
// while this fix was being written.
//
// It is invisible on LONG lines because their max-content exceeds the 92% cap, so the cap sizes the
// row and the float's width comes out of slack that existed anyway. That is why, in the founder's
// own screenshot, the informative receipt wrapped correctly and the bare one directly beneath it did
// not — same component, same float, different intrinsic width.
//
// `width: 100%` takes the box off intrinsic sizing so `maxWidth` alone sets the measure; every line
// is then laid out against the width the text was measured for. `maxWidth: 92%` still caps it, so
// the column's proportions are unchanged.
//
// ══ WHY THIS IS A DECLARATION ASSERTION AND NOT A MEASUREMENT ═══════════════════════════════════
// jsdom has no layout engine: it never resolves a percentage, never lays out a float, and returns 0
// from every box-metric API (docs/jsdom-test-caveats.md). So a test that asserted "this text is on
// one line" would pass against ANY styling, including the broken one — the textbook vacuous test
// this repo's AGENTS.md opens with, and the same reason `ConciergeMessageRow.overflow.test.tsx`
// beside this file asserts declarations rather than `scrollWidth`.
//
// What this CAN prove honestly, and does: every arm that renders floated prose declares the width.
// It fails if the declaration is dropped from either arm, and — the case that actually recurs — if a
// THIRD prose arm is added later without it, because the arms are enumerated here by rendering each
// one rather than by trusting a shared constant to have been used. The layout half is settled by the
// founder's screenshot and by the screenshots on the PR.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ConciergeMessageRow } from "./ConciergeMessageRow";
import type { ConciergeMessage } from "./types";

const noop = () => {};

/** The exact line from the founder's screenshot: short enough that its max-content is well under the
 *  92% cap, which is the only condition under which the float can evict a word. */
const SHORT_RECEIPT = "Retired that agent.";

/** The row element itself. Selected by `data-message-id` rather than by a testid, because the reply
 *  arm — the one the founder's screenshot is of — carries no testid, and adding one just to be
 *  queried here would be a production attribute existing only for this test. */
function renderRow(message: Partial<ConciergeMessage> & { id: string; kind: string }) {
  cleanup();
  const { container } = render(
    <ConciergeMessageRow
      message={message as ConciergeMessage}
      wired={false}
      shownBlockIds=""
      onOpenPayload={noop}
      onNudgeClick={noop}
      onNudgeAction={noop}
      onAnswerCopied={noop}
      onMessageCopied={noop}
    />,
  );
  const row = container.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
  // NOT a silent `null` deref into a confusing "cannot read style of null". If the arm stopped
  // rendering — or stopped being reachable for this message shape — that is itself the regression,
  // and it should say so.
  if (!row) throw new Error(`no prose row rendered for message ${message.id}`);
  return row;
}

afterEach(cleanup);

// EVERY FLOATED-PROSE ARM, MOUNTED — not one representative. The rule this guards is "the arms agree
// with each other", and a test that rendered only the reply arm would stay green while the push arm
// regressed, which is the shape AGENTS.md calls out: absence asserted against a component that was
// never in the tree proves nothing about the rule.
describe.each([
  ["a reply / receipt line", { id: "s-1", kind: "sparkle", text: SHORT_RECEIPT }],
  [
    "an unprompted push",
    { id: "s-2", kind: "sparkle", text: SHORT_RECEIPT, proactive: true },
  ],
])("%s", (_label, message) => {
  it("declares a full-width measure, so the floated copy glyph cannot evict its last word", () => {
    expect(
      renderRow(message as Partial<ConciergeMessage> & { id: string; kind: string }).style.width,
      "This row carries a `float: left` copy button and is a flex item sized shrink-to-fit by " +
        "`alignSelf: flex-start`. A float does not participate in intrinsic sizing, so without an " +
        "explicit width the box measures the text's max-content and the float then takes ~38px out " +
        "of the first line — spilling the last word onto a second row. That is the founder's " +
        "'Retired that' / 'agent.' at x≈235 in a 1400px column.",
    ).toBe("100%");
  });

  // THE CAP MUST SURVIVE THE FIX. `width: 100%` without it would let these rows run the full column,
  // losing the inset that distinguishes the concierge's prose from the column's edge.
  it("is still capped at 92%, so the column's proportions are unchanged", () => {
    expect(
      renderRow(message as Partial<ConciergeMessage> & { id: string; kind: string }).style.maxWidth,
    ).toBe("92%");
  });
});

// @vitest-environment jsdom
//
// ── THE RECAP CARD AT A NARROW CONCIERGE WIDTH (bead sparkle-kk9dg.1) ───────────────────────────
// The card shipped broken and the suite stayed green, which is the whole reason this file exists
// separately from `RecapCard.test.tsx`: every assertion over there renders the card at rest and
// reads its CONTENT, and the defect is a layout one that content assertions cannot see.
//
// WHAT WAS WRONG. `rowStyle` was `display:flex; align-items:baseline; gap:6` with NO wrap. Its
// children are a `flex:none` project chip, an `AgentPill` (`white-space:nowrap`, so its min-content
// size is its FULL width — and a flex item's default `min-width:auto` made that an unshrinkable
// floor), and a muted status label. The pill could not give, so it overhung the card's right edge
// and was clipped mid-word; the status was then the only child that COULD give, so it collapsed to
// its min-content width and stacked "Done — your turn" one word per line, ~150px tall.
//
// WHY THESE ARE STYLE-SHAPE ASSERTIONS RATHER THAN MEASUREMENTS. **jsdom has no layout engine.**
// `getBoundingClientRect` returns zeros, `scrollWidth`/`clientWidth` are 0, and `text-overflow`
// never evaluates — so a jsdom test that claimed to OBSERVE the overflow would be measuring
// nothing, which is exactly the vacuous shape this repo's #1 fleet-wide finding is about (see
// docs/jsdom-test-caveats.md). What jsdom CAN answer honestly is "does the declaration that makes
// the reflow possible exist", and each of the four asserted here was ABSENT before this change, so
// none of them was already true. The real-layout half — that nothing actually overflows and no row
// grows past two lines — is measured in a real browser by
// `scripts/visual/recap-narrow-probe.mjs`, which is the only place it can be measured at all.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RecapCard } from "./RecapCard";
import { AgentPillProvider } from "./AgentPill";
import type { MentionAgent } from "./mentions";
import type { ConciergeRecapMessage } from "../../services/conciergeRecap";
import type { RevealOutcome } from "../../services/agentReveal";

afterEach(() => cleanup());

/**
 * The width every row in this file is rendered at.
 *
 * `CONCIERGE_DEFAULT_WIDTH` is 360 and `CONCIERGE_MIN_WIDTH` is 50, so 280 is a plausible reading
 * width the founder would actually drag to rather than a degenerate one. It is also comfortably
 * past the ~390px the offending row NEEDS — "@Concierge Says What It Is Doing" is ~190px at 12px,
 * plus a ~55px project chip, ~105px of status, 26px of card padding and 12px of gaps — so the
 * reflow is genuinely exercised rather than merely available.
 *
 * A LITERAL, NOT AN IMPORT of the column constants. The point of the number is that it is a width a
 * PERSON chose; deriving it from `CONCIERGE_DEFAULT_WIDTH` would let a change to the default
 * silently move this test off the case it was written for.
 */
const NARROW = 280;

/**
 * "This length is declared, and it is zero."
 *
 * NOT an exact `"0px"` comparison, which fails on a perfectly correct declaration: React does not
 * append a unit to a numeric zero, so `minWidth: 0` reaches the DOM as the string `"0"`. Testing
 * the MEANING rather than the spelling also keeps the assertion honest if the source is later
 * written as `"0px"` — but it still fails on `""`, i.e. on the property not being there at all,
 * which is the state that caused the bug.
 */
const isZeroLength = (v: string) => v !== "" && Number.parseFloat(v) === 0;

/**
 * `flex: none` as jsdom's cssstyle stores it. The shorthand's `none` keyword is expanded to its
 * longhands on the way in, so the string a test reads back is never the one the source wrote.
 * Semantically identical to what the status cell declares directly: may not grow, may not shrink.
 */
const FLEX_NONE = "0 0 auto";

/** The very-narrow width, where the pill alone no longer fits and truncation is what is left. */
const VERY_NARROW = 200;

/** A name long enough to be the case that broke: it alone is wider than the whole column. */
const LONG_NAME = "Concierge Says What It Is Doing";

const ROSTER = [
  { id: "a", name: LONG_NAME, projectId: "p1", projectName: "sparkle", band: "needs_you" },
] as unknown as readonly MentionAgent[];

const recap = (over: Partial<ConciergeRecapMessage> = {}): ConciergeRecapMessage => ({
  id: "recap-1",
  kind: "recap",
  awayMs: 12 * 60_000,
  needsYou: [
    {
      agentId: "a",
      agentName: LONG_NAME,
      projectName: "sparkle",
      status: "waiting",
      // The exact label that stacked one word per line.
      statusLabel: "Done — your turn",
    },
  ],
  finished: [],
  decisions: [],
  ...over,
});

/** A recap whose only row is a "What I did" decision — the second row shape on this card, and the
 *  one that carries the leading verb. Shared rather than rebuilt per describe block, so the
 *  containment assertions and the reflow assertions cannot drift onto different fixtures. */
const withDecisionRow = (): ConciergeRecapMessage =>
  recap({
    needsYou: [],
    finished: [],
    decisions: [
      {
        id: "d1",
        kind: "queued",
        agentName: LONG_NAME,
        agentId: "a",
        summary: "Delete the staging database",
        at: 1,
      },
    ],
  });

/** Render the card into a container pinned to a concierge width, the way the column mounts it —
 *  and OPEN IT, because every assertion in this file is about how a ROW lays out.
 *
 *  The card is a disclosure since bead `sparkle-o37mn`, and a recap with nothing actionable in it
 *  starts collapsed, rendering no rows at all. That is a real behaviour with its own coverage in
 *  `RecapCard.expand.test.tsx`; here it would merely mean these tests assert against an empty card.
 *  Expanding unconditionally keeps each assertion pointed at exactly what it was written to check —
 *  it does not weaken any of them, because a collapsed card fails them by ABSENCE (the query throws)
 *  rather than by passing vacuously. */
function renderNarrow(width: number, message: ConciergeRecapMessage = recap()) {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.appendChild(container);
  render(
    <AgentPillProvider value={{ agents: ROSTER, onOpenAgent: (): RevealOutcome => "revealed" }}>
      <RecapCard recap={message} onRevealAgent={() => {}} />
    </AgentPillProvider>,
    { container },
  );
  const disclosure = within(container).getByTestId("recap-disclosure");
  if (disclosure.getAttribute("aria-expanded") === "false") fireEvent.click(disclosure);
  return container;
}

describe("RecapCard rows reflow instead of overflowing a narrow column", () => {
  it("lets the row break onto a second line at all", () => {
    // The declaration the whole hybrid rests on. Without it the row is a single unbreakable line,
    // so the only way it can react to a narrow column is by shrinking a child — which is the bug.
    renderNarrow(NARROW);
    const row = screen.getByTestId("recap-change");
    expect(row.style.display).toBe("flex");
    expect(row.style.flexWrap).toBe("wrap");
  });

  it("keeps wrapped lines tight — a row/column gap pair, not one inherited 6px", () => {
    // `gap: 6` would apply 6px BETWEEN the wrapped lines too, opening a gap wider than the leading
    // of the 12px text it separates. (jsdom's cssstyle stores the `gap` shorthand without expanding
    // it into rowGap/columnGap, so the assertion is on the shorthand it actually holds.)
    renderNarrow(NARROW);
    expect(screen.getByTestId("recap-change").style.gap).toBe("2px 6px");
  });

  it("keeps the chip and the pill in ONE flex item, so the break can only fall before the status", () => {
    // Not cosmetic nesting. Flexbox picks line breaks from each item's FLEX BASE SIZE, before any
    // shrinking — so with chip, pill and status as three flat siblings, a ~202px pill does not fit
    // beside a ~55px chip in a 254px content box and the PILL took a line of its own, pushing the
    // status to a third. Measured at 3.36 line-heights in a real browser at 280px before the group
    // existed, 2.29 after (scripts/visual/recap-narrow-probe.mjs).
    //
    // The group's basis must stay at max-content (`0 1 auto`, not `1 1 0%`): a zero basis always
    // fits, which would keep the status on line one and squeeze the pill instead — the
    // always-one-line-truncate layout the founder rejected in favour of this hybrid.
    renderNarrow(NARROW);
    const lead = screen.getByTestId("recap-change-lead");
    expect(lead.style.display).toBe("flex");
    expect(lead.style.flex).toBe("0 1 auto");
    expect(isZeroLength(lead.style.minWidth)).toBe(true);
    // …and it really does hold BOTH, so the group cannot be quietly reduced to a pill wrapper.
    expect(lead.contains(screen.getByText("sparkle"))).toBe(true);
    expect(lead.contains(screen.getByTestId("recap-change-pill-cell"))).toBe(true);
    // The status is the sibling the break falls before — it must NOT be inside the group.
    expect(lead.contains(screen.getByTestId("recap-change-status"))).toBe(false);
  });

  it("lets the PILL shrink — `min-width: 0` against the nowrap floor", () => {
    // A flex item defaults to `min-width: auto`, whose min-content size for a `white-space: nowrap`
    // pill is its full width. That default is why the pill overhung the card instead of giving.
    renderNarrow(NARROW);
    const cell = screen.getByTestId("recap-change-pill-cell");
    expect(isZeroLength(cell.style.minWidth)).toBe(true);
    expect(cell.style.flex).toBe("1 1 0%");
  });

  it("moves the STATUS as a whole unit — it may not shrink, so it wraps entire", () => {
    // The observed failure: "Done — your turn" one word per line, four lines tall. `nowrap` forbids
    // the word-per-word break and `flex: 0 0 auto` forbids the shrink that provoked it, so the only
    // thing left for the status to do when it stops fitting is to take the next line whole.
    renderNarrow(NARROW);
    const status = screen.getByTestId("recap-change-status");
    expect(status.style.whiteSpace).toBe("nowrap");
    expect(status.style.flex).toBe("0 0 auto");
    expect(status.textContent).toBe("Done — your turn");
  });

  it("keeps the pill AHEAD of the status in the shrink order, which is what makes it a hybrid", () => {
    // The founder chose: status drops to its own line first, pill ellipsizes only if it alone still
    // overflows. Flexbox line-breaks BEFORE it shrinks, so that ordering is a consequence of the
    // status being unshrinkable while the pill is shrinkable — assert the pair together, because
    // either one alone would permit the wrong order.
    renderNarrow(NARROW);
    expect(screen.getByTestId("recap-change-status").style.flex).toBe("0 0 auto");
    // A ZERO BASIS, and what is being asserted is that the pill can give at all — grow and shrink
    // both non-zero — while the status cannot. `0 1 auto` carried the same meaning until the lead
    // group was allowed to wrap internally; see `pillCell` for why the basis had to go to 0 (a
    // max-content basis broke the group at 280px, a whole line too early).
    const pillFlex = screen.getByTestId("recap-change-pill-cell").style.flex;
    expect(pillFlex).toBe("1 1 0%");
    expect(pillFlex.startsWith("0 ")).toBe(false);
  });

  // ── THE 50-135px BAND: CONTAINMENT WHERE THE HYBRID CANNOT REACH (roborev 58700) ───────────────
  //
  // `CONCIERGE_MIN_WIDTH` is 50, and every test above renders at 280 or 200 — so did the probe. That
  // left a band the column can genuinely be dragged to and nothing measured, and it was a
  // REGRESSION rather than merely uncovered: below roughly 135px the row cannot stay inside the card
  // by construction (`statusCell` is `flex: 0 0 auto` + nowrap at ~105px, `projectChip` is
  // `flex: none` at ~55px, and the content box has shrunk to ~24-109px), and where the OLD code kept
  // the status inside by word-stacking it, the reflowed row pushed it clean past the right edge of a
  // card that has `maxWidth: 100%` and no clipping of its own.
  //
  // DECLARATION ASSERTIONS, for the same reason as every other test in this file: jsdom has no
  // layout engine. The containment itself is measured in a real browser by
  // `scripts/visual/recap-narrow-probe.mjs`, which now sweeps 135, 100 and 50 too. What jsdom holds
  // is that the declarations exist — each was absent before this change.
  describe("cells that may not shrink are still BOUNDED, so they clip instead of escaping", () => {
    const CELLS = [
      { what: "the status label", find: () => screen.getByTestId("recap-change-status") },
      { what: "the project chip", find: () => screen.getByText("sparkle") },
    ];

    it.each(CELLS)("$what is capped at the line it is on", ({ find }) => {
      renderNarrow(VERY_NARROW);
      const el = find();
      expect(el.style.maxWidth).toBe("100%");
      // WITHOUT THIS THE CAP ABOVE IS DEAD. A flex item's `min-width: auto` floor is its min-content
      // size — for nowrap text, the whole string — and min-width beats max-width, so the cap would
      // simply be ignored.
      expect(isZeroLength(el.style.minWidth)).toBe(true);
      expect(el.style.textOverflow).toBe("ellipsis");
      expect(el.style.whiteSpace).toBe("nowrap");
      // The clip comes from the CLASS, never inline. `overflow: clip` is what avoids making the box
      // a scroll container, but it is WebKit 16+ and is DROPPED on the Big Sur webview
      // `tauri.conf.json` still declares support for — taking `text-overflow` with it, since that
      // needs a non-visible overflow. `index.css`'s utility is `hidden` upgraded to `clip` under
      // `@supports`, which has no inline form; an inline `overflow` here would win over the class
      // and silently undo the upgrade.
      expect(el.className).toContain("clip-no-scroll");
      expect(el.style.overflow).toBe("");
    });

    it("caps the decision's verb the same way — 'Held for you' is two words that can stack", () => {
      renderNarrow(VERY_NARROW, withDecisionRow());
      const verb = screen.getByTestId("recap-decision").firstElementChild as HTMLElement;
      expect(verb.textContent).toBe("Held for you");
      expect(verb.style.maxWidth).toBe("100%");
      expect(verb.style.whiteSpace).toBe("nowrap");
      expect(isZeroLength(verb.style.minWidth)).toBe(true);
      expect(verb.className).toContain("clip-no-scroll");
    });

    it("lets the chip and the pill break apart, but only once the line is gone", () => {
      // `flex-wrap` on the LEAD GROUP is the last resort: below ~135px the chip alone fills the
      // line, so without it the pill is laid out starting past the chip and paints outside the card
      // (measured at +16 to +22px). It cannot fire while both fit — flexbox only breaks a line that
      // has run out — which is why `pillCell`'s basis had to go to 0 in the same change.
      renderNarrow(NARROW);
      expect(screen.getByTestId("recap-change-lead").style.flexWrap).toBe("wrap");
    });

    it("lets a WORD break rather than paint outside the card", () => {
      // The one containment rule that is not about a box. Below ~135px the card's content box is
      // narrower than single words in its own summary sentence, and a word that does not fit its
      // line overflows by default — invisibly to any box measurement, since no element's rect grows.
      // That is how it was found: at 135px the card scrolled horizontally with not one element past
      // its content edge.
      //
      // On the CARD, so the summary, the headings and the decision prose inherit it in one
      // declaration. `anywhere` rather than `break-word`: `break-word` is ignored when computing
      // min-content, so an item sized from its content keeps the unbroken word's width as a floor.
      renderNarrow(NARROW);
      expect(screen.getByTestId("concierge-recap").style.overflowWrap).toBe("anywhere");
    });
  });

  it("keeps the per-row project chip at every width — it is what a cross-project recap is FOR", () => {
    // Settled by interview, and recorded here so a later narrow-width pass does not "simplify" the
    // row by dropping it: the chip answers "which project is this agent in".
    renderNarrow(VERY_NARROW);
    const chip = screen.getByText("sparkle");
    expect(chip.style.flex).toBe(FLEX_NONE);
  });

  it("changes nothing a reader can read — the row still says the same words", () => {
    // The reflow is a layout change only. A pill wrapped in a new span, or a status moved into a
    // named cell, must not alter the row's text.
    renderNarrow(NARROW);
    expect(screen.getByTestId("recap-change").textContent).toBe(
      `sparkle@${LONG_NAME}Done — your turn`,
    );
  });
});

describe("the 'What I did' rows get the same treatment", () => {
  // The module-level helper, so the containment block above and this one cannot describe two
  // different decision rows while claiming to describe the same shape.
  const withDecision = withDecisionRow;

  it("wraps, and lets the prose half shrink around the pill inside it", () => {
    // Identical shape one section down — a `flex:none` verb, then a muted span carrying prose AND a
    // nowrap pill — so it breaks the same way, and the founder sees it in the SAME card. The prose
    // needs `min-width: 0` for the same reason the pill cell does: the embedded pill's min-content
    // size would otherwise be an unshrinkable floor for the whole span.
    renderNarrow(NARROW, withDecision());
    const row = screen.getByTestId("recap-decision");
    expect(row.style.flexWrap).toBe("wrap");
    expect(row.style.gap).toBe("2px 6px");
    const prose = screen.getByTestId("recap-decision-prose");
    expect(isZeroLength(prose.style.minWidth)).toBe(true);
    // A ZERO BASIS, unlike every other cell here, and the difference is a whole wasted line. The
    // prose's max-content width is the entire sentence, which as a flex base size never fits a
    // narrow column — so `0 1 auto` would push the prose onto its own line and orphan "Held for
    // you" above it. A basis of 0 always fits, so the sentence starts beside its verb and wraps
    // inside itself, which is what prose is for. Verified as real geometry by the probe's
    // "the decision verb shares its line" check.
    expect(prose.style.flex).toBe("1 1 0%");
  });

  it("keeps the verb leading and unshrunk — 'Sent' and 'Held for you' are opposite facts", () => {
    renderNarrow(NARROW, withDecision());
    const row = screen.getByTestId("recap-decision");
    expect(row.textContent!.startsWith("Held for you")).toBe(true);
    expect((row.firstElementChild as HTMLElement).style.flex).toBe(FLEX_NONE);
  });

  it("still reads as one sentence — the em-dash join survives the reflow", () => {
    renderNarrow(NARROW, withDecision());
    expect(screen.getByTestId("recap-decision").textContent).toBe(
      `Held for youDelete the staging database — @${LONG_NAME}`,
    );
  });
});

// @vitest-environment jsdom
//
// The geometry behind "shade the tab by where it sits", tested directly (roborev 63620).
//
// `ProjectTabs.columnFill.test.tsx` covers this through the rendered component, which is the test
// that matters for the founder's report — but it can only reach the resolver through a React tree,
// so the branches it does not happen to render are invisible there. These are the rule's own edges:
// unmeasured inputs, ties, and the half-open seam. Pure function, no DOM, no layout.

import { describe, expect, it } from "vitest";
import { columnUnder, PAIR_COLUMN_ATTR } from "./pairColumns";

/** build inboard, terminal outboard — the right pair's order. Indices: 0 = build, 1 = terminal. */
const COLS = [
  { left: 0, right: 300 },
  { left: 300, right: 900 },
];

describe("columnUnder", () => {
  it("resolves by the tab's MIDPOINT, not by either edge", () => {
    // Straddles the seam, but its middle is over the build column. Deciding from `left` or `right`
    // alone would answer differently here, which is the whole reason the rule is the midpoint.
    expect(columnUnder({ left: 200, right: 380 }, COLS)).toBe(0);
    expect(columnUnder({ left: 220, right: 400 }, COLS)).toBe(1);
  });

  it("puts a midpoint landing exactly on the seam on the RIGHT-hand column", () => {
    // Half-open (`>= left`, `< right`), so a tab whose midpoint is exactly 300 matches one column
    // rather than both — otherwise the answer is decided by array order, silently.
    expect(columnUnder({ left: 200, right: 400 }, COLS)).toBe(1);
  });

  it("falls back to the widest overlap when the midpoint is in a GAP between columns", () => {
    const gapped = [
      { left: 0, right: 300 },
      { left: 360, right: 900 },
    ];
    // mid = 310, over neither. Overlaps build by 50 and the terminal by 10.
    expect(columnUnder({ left: 250, right: 370 }, gapped)).toBe(0);
    // …and the same shape the other way round: overlaps the terminal by 40, build by 10.
    expect(columnUnder({ left: 290, right: 400 }, gapped)).toBe(1);
  });

  it("refuses rather than guessing when the TAB is unmeasured", () => {
    // A zero-width rect is an unlaid-out element, never a very narrow tab. Answering here would
    // paint the active tab a colour derived from a rect nobody has laid out.
    expect(columnUnder({ left: 0, right: 0 }, COLS)).toBe(-1);
    expect(columnUnder({ left: 120, right: 120 }, COLS)).toBe(-1);
  });

  it("skips unmeasured COLUMNS and still answers from the measured ones", () => {
    const half = [
      { left: 0, right: 0 },
      { left: 300, right: 900 },
    ];
    expect(columnUnder({ left: 400, right: 500 }, half)).toBe(1);
  });

  it("refuses when there are no columns at all, or none of them is measured", () => {
    expect(columnUnder({ left: 0, right: 150 }, [])).toBe(-1);
    expect(
      columnUnder({ left: 0, right: 150 }, [
        { left: 0, right: 0 },
        { left: 5, right: 5 },
      ]),
    ).toBe(-1);
  });

  it("refuses a tab that overlaps nothing — off the end of every column", () => {
    // No midpoint hit and zero overlap everywhere: there is no right answer, so there is no answer.
    expect(columnUnder({ left: 1000, right: 1100 }, COLS)).toBe(-1);
  });

  it("handles a single column, which is what a pair mid-teardown looks like", () => {
    expect(columnUnder({ left: 10, right: 60 }, [{ left: 0, right: 300 }])).toBe(0);
  });
});

describe("PAIR_COLUMN_ATTR", () => {
  it("is a valid attribute selector, since that is how it is used", () => {
    // `querySelectorAll('[' + PAIR_COLUMN_ATTR + ']')` is the only consumer; a name needing escaping
    // would throw there at runtime rather than here.
    const el = document.createElement("div");
    el.setAttribute(PAIR_COLUMN_ATTR, "build");
    expect(() => document.querySelectorAll(`[${PAIR_COLUMN_ATTR}]`)).not.toThrow();
    expect(el.matches(`[${PAIR_COLUMN_ATTR}]`)).toBe(true);
  });
});

// @vitest-environment jsdom
//
// THE ONE PLACE LAYOUT IS STUBBED, AND WHY IT IS NOT WHAT THE SIBLING FILE FORBIDS.
//
// `BeadLineageRows.test.tsx` says not to mock layout to test the OVERFLOW RULE — that rule is a
// pure function, tested against exact numbers in `engine/beadLineage.test.ts`. This file tests
// something no pure function can express: that a measurement, once taken, SURVIVES its pill being
// hidden.
//
// The defect it guards is not subtle in effect. Only the SHOWN pills are in the DOM, so a naive
// re-measure reads every hidden pill as 0 wide, concludes they all fit, renders all nine, measures,
// packs back down to one, and repeats — a permanent flicker that starts on the FIRST
// ResizeObserver callback. Measured against the naive implementation: mount renders 1 pill and
// "+8 more", and the very next resize callback renders 9.
//
// jsdom lays nothing out, so giving it widths is the only way to reach that path at all.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BeadLineageRows } from "./BeadLineageRows";

const PILL_W = 50;
const LABEL_W = 40;
const MORE_W = 60;
const ROW_W = 200;
/** Matches `GAP` in the component — the gap the packer charges between items. */
const GAP = 6;

let fireResize: (() => void) | null = null;

/** Install the stubs INSIDE the test rather than in a `beforeEach`. Deliberate: an earlier draft
 *  installed them per-hook and the whole file went green against the oscillating implementation
 *  it was written to catch — a guard for a flicker that could not see the flicker. */
function stubLayout() {
  class FakeRO {
    constructor(private cb: () => void) {}
    observe() {
      fireResize = () => this.cb();
    }
    disconnect() {}
  }
  globalThis.ResizeObserver = FakeRO as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      const id = this.getAttribute("data-testid") ?? "";
      if (id.endsWith("-pill")) {
        // ══ SHRINK MODE REPORTS THE ROW'S LEFTOVER SPACE, NOT THE LABEL ═══════════════════════
        // A sole overflowing pill is `flex: 1 1 auto`, so in a real browser it measures whatever is
        // left after the label and the "+N more" — NOT its own text. A stub that always returned a
        // label-derived width made a squeezed pill indistinguishable from a natural one, so the
        // shrink guard was invisible in BOTH directions: deleting it, or relaxing it, left this
        // suite green. Every test here settles at shown=1, so this is the mode they actually run in.
        const row = this.parentElement;
        const sole = row !== null && row.querySelectorAll("[data-testid$='-pill']").length === 1;
        const hasMore = row !== null && row.querySelector("[data-testid$='-more']") !== null;
        if (sole && hasMore) return ROW_W - LABEL_W - MORE_W - 2 * GAP;
        // A PILL'S NATURAL WIDTH TRACKS ITS LABEL. A constant here cannot model the thing the cache
        // is keyed on, and it silently made the relabel test vacuous.
        return Math.max(PILL_W, (this.textContent ?? "").length * 8);
      }
      if (this.getAttribute("aria-hidden") !== null) return MORE_W; // the measuring twin
      if (id === "") return LABEL_W; // the row's label span
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return (this.getAttribute("data-testid") ?? "").endsWith("-tasks") ? ROW_W : 0;
    },
  });
}

afterEach(cleanup);

const many = Array.from({ length: 9 }, (_, i) => ({ id: `b-${i}`, label: `Task ${i}` }));

describe("BeadLineageRows packing, with real widths", () => {
  it("re-packs UPWARD when the sole shrunk pill is relabelled shorter", () => {
    // THE PAIRED CASE FOR THE SHRINK GUARD, and the numbers are chosen so the two implementations
    // DISAGREE. A pill in shrink mode measures the row's LEFTOVER space (88 here), not its label.
    // Cache that as if it were natural and the row stays pinned at one pill; skip the write and the
    // relabelled pill is measured honestly at 50, so both pills fit.
    //
    //   available = ROW_W(200) - LABEL_W(40) - GAP(6) = 154
    //   honest  [50, 80] -> 50 + 6 + 80 = 136 <= 154  -> both shown, no overflow
    //   pinned  [88, 80] -> 174 > 154, and k=1 costs 88 + 6 + 66 = 160 > 154 -> one shown
    stubLayout();
    const long = [
      { id: "b-0", label: "An extremely long task title that leaves room for nothing else at all" },
      { id: "b-1", label: "TenCharsXX" },
    ];
    const { rerender } = render(<BeadLineageRows testId="card" tasks={long} buildAgents={[]} />);
    // Precondition: the row IS in shrink mode, or this asserts nothing about the guard.
    expect(screen.getAllByTestId("card-tasks-pill")).toHaveLength(1);
    expect(screen.getByTestId("card-tasks-more")).toBeTruthy();

    rerender(
      <BeadLineageRows
        testId="card"
        tasks={[{ id: "b-0", label: "Tiny" }, long[1]!]}
        buildAgents={[]}
      />,
    );
    expect(screen.getAllByTestId("card-tasks-pill")).toHaveLength(2);
    expect(screen.queryByTestId("card-tasks-more")).toBeNull();
  });

  it("re-packs when a SAME-LENGTH list arrives with different content", () => {
    // A child closed and another opened between polls is the common case, and the row's border box
    // does not change — so the ResizeObserver cannot see it. Keyed on `count` alone this was
    // completely unobserved and the row kept a "+N more" computed for a list that no longer existed.
    stubLayout();
    const { rerender } = render(<BeadLineageRows testId="card" tasks={many} buildAgents={[]} />);
    const first = screen.getAllByTestId("card-tasks-pill").length;
    const swapped = many.map((p, i) => ({ id: `x-${i}`, label: `Other ${i}` }));
    rerender(<BeadLineageRows testId="card" tasks={swapped} buildAgents={[]} />);
    // Same length, all-new ids: every pill is unmeasured, so the row must not silently keep the old
    // pack. It re-measures and lands somewhere valid, with the overflow count matching what it drew.
    const shown = screen.getAllByTestId("card-tasks-pill").length;
    expect(shown).toBe(first);
    expect(screen.getByTestId("card-tasks-more").textContent).toBe(`+${many.length - shown} more`);
    expect(screen.getAllByTestId("card-tasks-pill")[0]!.textContent).toBe("Other 0");
  });

  it("measures a pill that becomes visible for the FIRST time, instead of packing against a 0", () => {
    // Growing `shown` schedules no measurement of its own. A pill inserted at the first hidden slot
    // therefore had no cache entry, `packPills` read its 0 as fitting, and the row grew past what
    // fits — staying over-packed and clipped until an unrelated resize.
    stubLayout();
    const { rerender } = render(<BeadLineageRows testId="card" tasks={many} buildAgents={[]} />);
    const first = screen.getAllByTestId("card-tasks-pill").length;
    const spliced = [...many];
    spliced.splice(first, 0, { id: "new-pill", label: "Newly arrived task" });
    rerender(<BeadLineageRows testId="card" tasks={spliced} buildAgents={[]} />);
    // Every pill is the same stubbed width, so one MORE pill can never make MORE of them fit.
    expect(screen.getAllByTestId("card-tasks-pill").length).toBeLessThanOrEqual(first);
    expect(screen.getByTestId("card-tasks-more")).toBeTruthy();
  });

  it("re-measures a RELABELLED pill rather than reusing its old width", () => {
    // Ids are stable across polls precisely while titles are not. Keyed on id alone, a retitled bead
    // kept its old short width for ever — and the next resize packed the long title using it.
    stubLayout();
    const two = [
      { id: "b-0", label: "Tiny" },
      { id: "b-1", label: "Tiny" },
    ];
    const { rerender } = render(<BeadLineageRows testId="card" tasks={two} buildAgents={[]} />);
    // Both short pills fit at the stubbed widths.
    expect(screen.getAllByTestId("card-tasks-pill")).toHaveLength(2);
    expect(screen.queryByTestId("card-tasks-more")).toBeNull();

    rerender(
      <BeadLineageRows
        testId="card"
        tasks={[{ id: "b-0", label: "A very much longer task title indeed" }, two[1]!]}
        buildAgents={[]}
      />,
    );
    // SAME IDS, ONE MUCH LONGER LABEL. Keyed on id alone the cache hands back the old SHORT width,
    // both pills still "fit", and the row renders two — clipping the long one at the card edge with
    // no overflow affordance. Keyed on id+label the pill counts as unmeasured, gets re-measured,
    // and the row packs down honestly.
    expect(screen.getAllByTestId("card-tasks-pill")).toHaveLength(1);
    expect(screen.getByTestId("card-tasks-more").textContent).toBe("+1 more");
  });

  it("packs down on measure, and STAYS packed when it re-measures", () => {
    stubLayout();
    render(<BeadLineageRows testId="card" tasks={many} buildAgents={[]} />);

    // Proves measurement happened at all — without it the stability assertion below could pass on
    // a row that simply never packed.
    const first = screen.getAllByTestId("card-tasks-pill").length;
    expect(first).toBeLessThan(9);
    expect(screen.getByTestId("card-tasks-more").textContent).toBe(`+${9 - first} more`);

    // The exact event that used to break it: a resize callback fires while most pills are absent
    // from the DOM. act() is load-bearing — the remeasure calls setState, and without it React
    // never flushes, so the DOM read below would be the PREVIOUS render.
    expect(fireResize).not.toBeNull();
    act(() => {
      fireResize?.();
    });

    // Without the id-keyed width cache this reads 9: every hidden pill measured 0, so "everything
    // fits" — and the next callback packs it back to 1, for ever.
    expect(screen.getAllByTestId("card-tasks-pill").length).toBe(first);
    expect(screen.getByTestId("card-tasks-more").textContent).toBe(`+${9 - first} more`);
  });
});

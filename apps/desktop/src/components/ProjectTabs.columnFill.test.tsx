// @vitest-environment jsdom
//
// THE ACTIVE TAB IS SHADED BY THE COLUMN IT SITS ABOVE.
//
// *"So you need to be aware of where the tab sits and shade it the correct color based on where it
// sits."* — the founder, with a light-mode and a dark-mode screenshot of the same defect. The
// active tab's face was `C.forest`, the TERMINAL plane, unconditionally: correct over the terminal
// by luck, and a visible seam over the build column in BOTH themes. Measured off his two shots:
//
//   light  tab #d9e3f3 (term)  against a build column of #f2f6fd (bridge)
//   dark   tab #030913 (term)  against a build column of #091426 (bridge)
//
// ── WHAT THESE ASSERTIONS ARE, AND WHY THEY ARE NOT PINNED TO A HEX ───────────────────────────
//
// Every assertion compares the tab's COMPUTED background against the COLUMN'S OWN COMPUTED
// background, read off the live element. None of them names a colour. That is deliberate and it is
// the whole point of the test: a test pinned to `rgb(242, 246, 253)` would keep passing while the
// columns were restyled underneath it, which is precisely the class of bug that let this ship. The
// palettes below come from `THEME_HEX` for realism — but they are only the values handed to the
// FIXTURE columns; what is asserted is that the tab tracks whatever the column carries.
//
// ── WHY THIS CAN BE ASSERTED IN JSDOM AT ALL ──────────────────────────────────────────────────
//
// jsdom never lays out and never loads the stylesheet, so a computed background is readable only
// when it was set INLINE — which is exactly how both real columns set theirs (`AgentSidebar`'s
// `background: C.deepForest`, `Workspace`'s `background: C.forest`). The fixture gives its columns
// concrete hex rather than the `var(--c-*)` those tokens resolve to, because jsdom does not resolve
// custom properties; a `var()` would compute to `""` and every comparison here would be two empty
// strings, i.e. vacuous. The `expect(...).not.toBe("")` guard in `expectFillMatches` is what stops
// that failure mode from ever being silent.
//
// Rects are stubbed for the same reason — jsdom reports 0 for every one, and the component REFUSES
// to resolve a column from an unmeasured rect (engine/pairColumns `columnUnder`), so without a stub
// every case here would pass by never running.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectTabs, paintedColor } from "./ProjectTabs";
import { PAIR_COLUMN_ATTR } from "../engine/pairColumns";
import { THEME_HEX } from "../theme/colors";

const PROJECTS = [
  { id: "p1", name: "alpha" },
  { id: "p2", name: "beta" },
  { id: "p3", name: "gamma" },
];

/** The two planes a tab can sit above, per theme — the REAL tokens the two columns paint in. */
const PALETTE = {
  light: { build: THEME_HEX.light.deepForest, terminal: THEME_HEX.light.forest },
  dark: { build: THEME_HEX.dark.deepForest, terminal: THEME_HEX.dark.forest },
} as const;
type Mode = keyof typeof PALETTE;

interface Span {
  left: number;
  right: number;
}

/**
 * A pair's geometry in client space.
 *
 * `right` models the primary cockpit half — `BUILD │ TERM`, build inboard against the concierge —
 * and `left` models its mirror, where the terminal is outboard and therefore LEFTMOST. The DOM
 * order of the two columns is identical in both (`Pair` passes `[build, terminal]` on both sides
 * and mirrors by reversing the flex FLOW, not the DOM), so the `left` case is what proves the tab
 * decides from measured position rather than from child index.
 */
const LAYOUT = {
  right: {
    columns: { build: { left: 0, right: 300 }, terminal: { left: 300, right: 900 } },
    // p1/p2 sit over the build column; p3 runs on past the seam and sits over the terminal.
    tabs: {
      "tab-p1": { left: 0, right: 150 },
      "tab-p2": { left: 150, right: 300 },
      "tab-p3": { left: 300, right: 450 },
    },
  },
  left: {
    columns: { terminal: { left: 0, right: 600 }, build: { left: 600, right: 900 } },
    // Mirrored strip: the tabs read inward from the outer edge, so p1 is over the TERMINAL and p3
    // over the build column — the opposite assignment to the right pair at the same DOM order.
    tabs: {
      "tab-p1": { left: 100, right: 250 },
      "tab-p2": { left: 450, right: 600 },
      "tab-p3": { left: 650, right: 800 },
    },
  },
  // A GAP BETWEEN THE COLUMNS — a resize rail, a border, a sub-pixel seam. The active tab's
  // MIDPOINT (310) lands in the gap (300–360) and so is over neither column, which is the one case
  // the midpoint rule alone cannot answer. It overlaps build by 50px and the terminal by 10, so
  // "widest overlap" has a right answer and a wrong one here rather than a tie.
  gap: {
    columns: { build: { left: 0, right: 300 }, terminal: { left: 360, right: 900 } },
    tabs: {
      "tab-p1": { left: 250, right: 370 },
      "tab-p2": { left: 400, right: 550 },
      "tab-p3": { left: 600, right: 750 },
    },
  },
} as const;

type Side = keyof typeof LAYOUT;

let side: Side = "right";

/** How far the STRIP has been scrolled. Shifts the tabs and leaves the columns where they are —
 *  which is exactly what scrolling a crowded strip does, and the case no size observer can see. */
let scrollX = 0;

/** Resolve a stubbed rect from the element's own attributes, so it works for nodes that do not
 *  exist until React has rendered them. Anything unmatched measures ZERO — which the component
 *  reads as "not laid out" rather than as a very narrow column. */
function spanFor(el: Element): Span | null {
  const layout = LAYOUT[side];
  const testid = el.getAttribute("data-testid");
  if (testid && testid in layout.tabs) {
    const s = layout.tabs[testid as keyof typeof layout.tabs];
    return { left: s.left - scrollX, right: s.right - scrollX };
  }
  const col = el.getAttribute(PAIR_COLUMN_ATTR);
  if (col === "build") return layout.columns.build;
  if (col === "terminal") return layout.columns.terminal;
  return null;
}

beforeEach(() => {
  side = "right";
  scrollX = 0;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const s = spanFor(this) ?? { left: 0, right: 0 };
    const width = s.right - s.left;
    return {
      x: s.left,
      y: 0,
      left: s.left,
      right: s.right,
      top: 0,
      bottom: width > 0 ? 34 : 0,
      width,
      height: width > 0 ? 34 : 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

/** The pair as the shell builds it: the strip above, `[build, terminal]` below, inside `[data-pair]`
 *  so the tab's lookup is scoped to THIS pair the way it is in the two-pair cockpit. */
function renderPair(o: { mode: Mode; selected: string; side?: Side }) {
  side = o.side ?? "right";
  const p = PALETTE[o.mode];
  return render(
    <div data-pair data-testid="pair">
      <div>
        <ProjectTabs
          projects={PROJECTS}
          selectedProjectId={o.selected}
          pinnedProjectId={null}
          countsByProject={{}}
          onSelect={vi.fn()}
          onTogglePin={vi.fn()}
          onClose={vi.fn()}
          reversed={side === "left"}
        />
      </div>
      <div>
        <div
          data-testid="build-col"
          {...{ [PAIR_COLUMN_ATTR]: "build" }}
          style={{ background: p.build }}
        />
        <div
          data-testid="term-col"
          {...{ [PAIR_COLUMN_ATTR]: "terminal" }}
          style={{ background: p.terminal }}
        />
      </div>
    </div>,
  );
}

const bg = (el: Element) => getComputedStyle(el).backgroundColor;

/**
 * The active tab's face is the same plane as `column`, and NOT the same as the other column.
 *
 * The second half is what makes this non-vacuous in the exact way that matters: the defect was a
 * face that always equalled the TERMINAL's plane, so an assertion that only checked "equals the
 * column beneath" would still have passed for every tab that happened to sit over the terminal.
 */
function expectFillMatches(selected: string, column: "build-col" | "term-col") {
  const other = column === "build-col" ? "term-col" : "build-col";
  const face = screen.getByTestId(`tab-body-${selected}`);
  const want = bg(screen.getByTestId(column));
  const notWant = bg(screen.getByTestId(other));
  // A palette that computed to nothing would make every comparison below two empty strings.
  expect(want).not.toBe("");
  expect(want).not.toBe(notWant);
  expect(bg(face)).toBe(want);
  expect(bg(face)).not.toBe(notWant);
}

describe("the active tab takes the plane of the column beneath it", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`${mode}: a tab over the BUILD column is painted in the build column's plane`, () => {
      renderPair({ mode, selected: "p1" });
      expectFillMatches("p1", "build-col");
    });

    it(`${mode}: a tab over the TERMINAL is painted in the terminal's plane`, () => {
      renderPair({ mode, selected: "p3" });
      expectFillMatches("p3", "term-col");
    });
  }

  it("decides from measured position, not DOM order — the mirrored left pair", () => {
    // Same `[build, terminal]` DOM order as the right pair, but the terminal is the LEFTMOST
    // column. A tab at x≈700 is therefore over BUILD here and would be over the terminal on the
    // right. Reading child index instead of geometry gets this backwards.
    renderPair({ mode: "light", selected: "p3", side: "left" });
    expectFillMatches("p3", "build-col");
  });

  it("…and the outboard tab of that same mirrored pair takes the terminal", () => {
    renderPair({ mode: "light", selected: "p1", side: "left" });
    expectFillMatches("p1", "term-col");
  });

  it("a tab straddling a GAP between the columns takes the one it covers most", () => {
    // Without the widest-overlap fallback the midpoint resolves to neither column, the tab drops
    // to its `C.forest` fallback, and it paints the TERMINAL plane while sitting mostly over the
    // build column — the original bug, reappearing in the one-frame case.
    renderPair({ mode: "light", selected: "p1", side: "gap" });
    expectFillMatches("p1", "build-col");
  });

  it("two tabs over the SAME column agree, so the rule is positional and not per-tab", () => {
    renderPair({ mode: "dark", selected: "p2" });
    expectFillMatches("p2", "build-col");
  });
});

describe("the fill follows the tab when the strip SCROLLS", () => {
  // roborev 63620. Once the label floor stops the tabs shrinking, a crowded strip is
  // `overflow-x: auto` — so a tab crosses the seam between the two columns with its OWN size
  // unchanged and the window's unchanged. Neither the ResizeObserver nor the resize listener can
  // see that, and the effect's deps have not changed either, so without a scroll listener the tab
  // keeps painting the plane of the column it has just left.
  it("re-reads the column after the active tab is scrolled over the other one", async () => {
    renderPair({ mode: "light", selected: "p1" });
    expectFillMatches("p1", "build-col");

    // p1 was [0,150] (mid 75, over build). Scrolled left by 400 it is [-400,-250]… so instead move
    // the strip the other way: a NEGATIVE scroll puts p1 at [400,550], mid 475, over the terminal.
    await act(async () => {
      scrollX = -400;
      fireEvent.scroll(screen.getByTestId("tab-p1"));
      await Promise.resolve();
    });

    expectFillMatches("p1", "term-col");
  });
});

describe("the fill survives a theme flip", () => {
  // The app re-themes from `<html data-theme>` in pure CSS, with NO React render (index.css). A
  // resolved colour cached at mount would therefore stay on the old palette until something
  // unrelated re-measured — so the component watches that attribute. Deleting the MutationObserver
  // reds this test and nothing else.
  it("re-reads the column when <html data-theme> changes", async () => {
    const { rerender } = renderPair({ mode: "light", selected: "p1" });
    expectFillMatches("p1", "build-col");
    const lightFill = bg(screen.getByTestId(`tab-body-p1`));

    // The palette moves under the columns and the attribute flips — the two halves of a real theme
    // change. Only the attribute is observable to the component; the columns' own inline values are
    // this fixture standing in for the CSS vars jsdom will not resolve.
    await act(async () => {
      rerender(
        <div data-pair data-testid="pair">
          <div>
            <ProjectTabs
              projects={PROJECTS}
              selectedProjectId="p1"
              pinnedProjectId={null}
              countsByProject={{}}
              onSelect={vi.fn()}
              onTogglePin={vi.fn()}
              onClose={vi.fn()}
            />
          </div>
          <div>
            <div
              data-testid="build-col"
              {...{ [PAIR_COLUMN_ATTR]: "build" }}
              style={{ background: PALETTE.dark.build }}
            />
            <div
              data-testid="term-col"
              {...{ [PAIR_COLUMN_ATTR]: "terminal" }}
              style={{ background: PALETTE.dark.terminal }}
            />
          </div>
        </div>,
      );
    });
    // The flip is its own act: the MutationObserver callback is a microtask, and the re-render it
    // schedules has to be flushed after that microtask has actually run.
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      await Promise.resolve();
    });

    expectFillMatches("p1", "build-col");
    expect(bg(screen.getByTestId(`tab-body-p1`))).not.toBe(lightFill);
  });
});

describe("the other tab states are untouched", () => {
  // The founder's shot carries an INACTIVE tab in an error tint next to the active one; whatever
  // the active tab's face does must leave the rest of the strip alone.
  // "Nothing is painted here" asked with the component's OWN predicate rather than a literal:
  // jsdom normalises `transparent` to `rgba(0, 0, 0, 0)`, and which spelling comes back is not the
  // fact under test.
  const unfilled = (testid: string) => paintedColor(bg(screen.getByTestId(testid)));

  it("an inactive tab stays transparent over the bar", () => {
    renderPair({ mode: "light", selected: "p1" });
    expect(unfilled("tab-body-p2")).toBeNull();
  });

  it("only the ACTIVE tab is filled, whichever column it sits above", () => {
    renderPair({ mode: "dark", selected: "p3" });
    // p3 is over the terminal and filled; p1 sits over the build column and must NOT be.
    expect(bg(screen.getByTestId("tab-body-p3"))).toBe(bg(screen.getByTestId("term-col")));
    expect(unfilled("tab-body-p1")).toBeNull();
  });
});

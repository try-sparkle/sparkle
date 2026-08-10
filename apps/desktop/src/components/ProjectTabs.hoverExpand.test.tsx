// @vitest-environment jsdom
//
// HOVER-EXPAND + THE WIDTH FLOOR (bead sparkle-z24dl).
//
// The founder could not read his own project tabs. With several projects open the strip squeezed
// each tab until the NAME was gone while every badge survived: one tab rendered as "fo...", another
// as "t..", and the SELECTED tab showed no name at all — just a red ⚠155 and a close ×. The cause is
// pure flex arithmetic: the pin, the ⚠ badge, the ● badge and the × are all `flex: none`, so the
// label is the only shrinkable thing in the tab and the layout takes every pixel from it.
//
// Two fixes, tested here:
//   1. A FLOOR, carried as the TAB's `min-width` (chrome + a readable name), so no name collapses
//      past a few characters — with the SELECTED tab floored higher, since it is the one you must
//      be able to identify and the one that went to zero. Past the floor the strip SCROLLS rather
//      than squeezing further.
//   2. HOVER EXPANSION — the hovered tab grows to its natural width and floats over its neighbours.
//
// The floor's ARITHMETIC is what this file pins. Whether it produces a readable strip in a real
// layout engine is `scripts/visual/tab-crowded-probe.mjs`, and that division is not tidiness: two
// separate defects in this change were invisible here and obvious there.
//
// ── WHAT "WITHOUT MOVING ANY OTHER TAB" MEANS IN JSDOM ────────────────────────────────────────
//
// jsdom has no layout engine, so "nothing moved" cannot be measured with rects — every rect is
// zero (docs/jsdom-test-caveats.md). It is asserted here as the MECHANISM that makes it true, which
// is two facts that have to hold together:
//
//   * the hovered tab's IN-FLOW footprint is FROZEN to the width it had before expanding
//     (`flex: 0 0 <measured>px`), so the flex line's arithmetic is unchanged; and
//   * the expanded chrome is OUT OF FLOW (`position: absolute`), so its extra width contributes
//     nothing to that line.
//
// Either one alone permits a reflow — an out-of-flow body over an unfrozen (auto-basis) tab lets
// the tab collapse to zero, and a frozen tab whose body is still in flow pushes its siblings. Both
// are asserted, plus the siblings' own inline styles are captured before and after and compared, so
// a change that starts restyling the neighbours reds this file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StatusBand } from "../engine/buildSections";
import {
  ProjectTabs,
  TAB_EXPAND_DELAY_MS,
  TAB_LABEL_MAX_WIDTH,
  TAB_LABEL_MIN_WIDTH,
  TAB_LABEL_MIN_WIDTH_ACTIVE,
  TAB_BODY_GAP,
  TAB_BODY_PAD_X,
  labelMinWidth,
  tabMinWidth,
} from "./ProjectTabs";

/** Counts with only the named bands set — a tab takes the full per-band Record. */
function counts(over: Partial<Record<StatusBand, number>> = {}): Record<StatusBand, number> {
  return { needs_you: 0, questions: 0, running: 0, done: 0, ...over };
}

/** The founder's own bar: six projects, real-length folder names — the state in the screenshot. */
const SIX = [
  { id: "sparkle", name: "sparkle-desktop" },
  { id: "foundry", name: "foundry-web" },
  { id: "tryst", name: "trystero-relay" },
  { id: "atlas", name: "atlas-infra" },
  { id: "beacon", name: "beacon-mobile" },
  { id: "cinder", name: "cinder-docs" },
];

/** The in-flow width the squeezed tab has BEFORE it expands — what the freeze must capture. jsdom
 *  reports 0 for every rect, so the one tab under test is stubbed to a believable squeezed width. */
const SQUEEZED_W = 90;

function stubTabWidth(id: string, width: number): void {
  const el = screen.getByTestId(`tab-${id}`);
  el.getBoundingClientRect = () =>
    ({
      x: 0, y: 0, width, height: 34, top: 0, left: 0, right: width, bottom: 34,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * Give the component a layout to measure: a natural text width for every label, and a width for
 * each of the unshrinkable parts the chrome is summed from.
 *
 * jsdom reports 0 for both, which is the component's "not measured yet" case and yields no floor at
 * all — so without this the floor assertions would read 0 and pass against anything. It has to be
 * in place BEFORE the first render: the measurement is a layout effect, so it runs at mount and
 * then only when a name or a badge changes.
 */
function stubLayout({ natural, nonLabel }: { natural: number; nonLabel: number }): void {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return natural;
    },
  });
  // `measureChrome` sums the tab's non-label children, so that is the only offsetWidth that feeds
  // the floor. The label's own is never read — deliberately, since a squeezed label reports a
  // width that has nothing to do with the chrome around it.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return nonLabel;
    },
  });
}

function restoreLayout(): void {
  delete (HTMLElement.prototype as { scrollWidth?: unknown }).scrollWidth;
  delete (HTMLElement.prototype as { offsetWidth?: unknown }).offsetWidth;
}

function renderTabs(overrides: Partial<Parameters<typeof ProjectTabs>[0]> = {}) {
  const onSelect = vi.fn();
  const onTogglePin = vi.fn();
  const onClose = vi.fn();
  render(
    <ProjectTabs
      projects={SIX}
      selectedProjectId="sparkle"
      pinnedProjectId={null}
      countsByProject={{}}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onSelect, onTogglePin, onClose };
}

/** Hover a tab and let the settle delay elapse. */
function hover(id: string): void {
  fireEvent.mouseEnter(screen.getByTestId(`tab-${id}`));
  settle();
}

/**
 * Take the pointer off a tab and let the settle elapse.
 *
 * THE COLLAPSE IS DELAYED TOO, by the same settle, and that is deliberate rather than an accident
 * of sharing a timer. Hovering the ⚠ badge makes the browser fire `mouseleave` on the tab and then
 * `mouseenter` again, repeatedly, with the pointer stationary — an immediate collapse turns that
 * into a strobing tab. Deciding on the pointer's FINAL position absorbs it. See `scheduleSettle`.
 */
function unhover(id: string): void {
  fireEvent.mouseLeave(screen.getByTestId(`tab-${id}`));
  settle();
}

function settle(): void {
  act(() => {
    vi.advanceTimersByTime(TAB_EXPAND_DELAY_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.getElementById("concierge-tabs-styles")?.remove();
});

describe("hovering a crowded tab reveals its full name", () => {
  it("expands the hovered tab WITHOUT moving any other tab", () => {
    renderTabs();
    stubTabWidth("foundry", SQUEEZED_W);

    // Every other tab's inline style, captured before the hover. Nothing here may change.
    const others = SIX.filter((p) => p.id !== "foundry");
    const before = new Map(
      others.map((p) => [p.id, screen.getByTestId(`tab-${p.id}`).getAttribute("style") ?? ""]),
    );

    hover("foundry");

    const tab = screen.getByTestId("tab-foundry");
    const body = screen.getByTestId("tab-body-foundry");
    expect(tab.dataset.expanded).toBe("true");
    // FACT 1 — the in-flow footprint is frozen at the width it already had, so the flex line's
    // arithmetic is untouched. `0 0 <w>px`: no grow, no shrink, an explicit basis.
    expect(tab.style.flex).toBe(`0 0 ${SQUEEZED_W}px`);
    // FACT 2 — the expanded chrome is out of flow, so its extra width contributes nothing to that
    // line. Without this the frozen basis would simply clip the name instead of revealing it.
    expect(body.style.position).toBe("absolute");
    // …and it is sized by its CONTENT, which is what "the full name is revealed" means here: no
    // clamp, no ellipsis, nothing hidden.
    expect(body.style.width).toBe("max-content");
    const label = screen.getByTestId("tab-label-foundry");
    expect(label.style.maxWidth).toBe("none");
    expect(label.style.overflow).toBe("visible");
    expect(label.textContent).toBe("foundry-web");

    for (const p of others) {
      expect(screen.getByTestId(`tab-${p.id}`).getAttribute("style") ?? "").toBe(before.get(p.id));
    }
  });

  it("expands the SELECTED tab too — the one that shows no name at all today", () => {
    // The selected tab in the screenshot rendered as ⚠155 and an ×, with the project name gone
    // entirely. Its badges are the widest of any tab, so it is the FIRST to lose its label, not the
    // last — an expansion that skipped the active tab would miss the reported bug.
    renderTabs({
      selectedProjectId: "sparkle",
      countsByProject: { sparkle: counts({ needs_you: 155 }) },
    });
    stubTabWidth("sparkle", SQUEEZED_W);

    hover("sparkle");

    expect(screen.getByTestId("tab-sparkle").dataset.expanded).toBe("true");
    expect(screen.getByTestId("tab-body-sparkle").style.position).toBe("absolute");
    expect(screen.getByTestId("tab-label-sparkle").style.maxWidth).toBe("none");
    expect(screen.getByTestId("tab-label-sparkle").textContent).toBe("sparkle-desktop");
  });

  it("waits out the hover delay, so sweeping across the strip expands nothing", () => {
    renderTabs();
    stubTabWidth("foundry", SQUEEZED_W);

    fireEvent.mouseEnter(screen.getByTestId("tab-foundry"));
    act(() => {
      vi.advanceTimersByTime(TAB_EXPAND_DELAY_MS - 1);
    });
    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBeUndefined();

    // …and a pointer that leaves before the delay elapses never expands it at all.
    fireEvent.mouseLeave(screen.getByTestId("tab-foundry"));
    act(() => {
      vi.advanceTimersByTime(TAB_EXPAND_DELAY_MS * 4);
    });
    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBeUndefined();
  });

  it("collapses when the pointer leaves, restoring the clamp", () => {
    renderTabs();
    stubTabWidth("foundry", SQUEEZED_W);
    hover("foundry");
    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBe("true");

    unhover("foundry");

    const tab = screen.getByTestId("tab-foundry");
    expect(tab.dataset.expanded).toBeUndefined();
    expect(tab.style.flex).not.toContain(`${SQUEEZED_W}px`);
    expect(screen.getByTestId("tab-body-foundry").style.position).not.toBe("absolute");
    expect(screen.getByTestId("tab-label-foundry").style.maxWidth).toBe(`${TAB_LABEL_MAX_WIDTH}px`);
  });

  it("expands on keyboard FOCUS as well, and without the pointer's delay", () => {
    // Tabbing to a tab has to reveal the same thing hovering it does — a sighted keyboard user gets
    // no hover. No delay: focus is already a deliberate act, so there is no sweep to debounce.
    renderTabs();
    stubTabWidth("tryst", SQUEEZED_W);

    fireEvent.focus(screen.getByTestId("tab-tryst"));

    expect(screen.getByTestId("tab-tryst").dataset.expanded).toBe("true");
    fireEvent.blur(screen.getByTestId("tab-tryst"));
    settle();
    expect(screen.getByTestId("tab-tryst").dataset.expanded).toBeUndefined();
  });

  it("only ever expands ONE tab, so moving along the strip does not leave a trail", () => {
    renderTabs();
    stubTabWidth("foundry", SQUEEZED_W);
    stubTabWidth("atlas", SQUEEZED_W);

    hover("foundry");
    fireEvent.mouseLeave(screen.getByTestId("tab-foundry"));
    hover("atlas");

    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBeUndefined();
    expect(screen.getByTestId("tab-atlas").dataset.expanded).toBe("true");
  });

  it("survives an enter/leave STORM that ends on the tab, and still collapses when it ends off it", () => {
    // The real-browser probe caught this and jsdom could not have: resting the pointer on a tab's
    // ⚠ badge mounts that badge's portaled card, and the browser then fires `mouseleave` on the tab
    // followed by `mouseenter` again, over and over, WITHOUT the pointer moving. Against the first
    // implementation — expand on enter, collapse on leave — every one of those pairs cancelled the
    // pending expansion, so a tab whose badge you were pointing at never expanded at all.
    //
    // Both directions are asserted, because the fix must not become "never collapse": the same
    // storm ending OFF the tab has to settle collapsed.
    // THE CLOCK IS THE ASSERTION, so this has to spend real time rather than firing the pairs
    // back-to-back. The expansion must land ONE delay after the pointer FIRST arrives; a timer that
    // each spurious `mouseleave` cancels and each `mouseenter` restarts is pushed further out by
    // every pair and never fires while the churn lasts. Firing the storm instantaneously and then
    // waiting would pass either way and prove nothing.
    renderTabs();
    stubTabWidth("foundry", SQUEEZED_W);
    const tab = screen.getByTestId("tab-foundry");

    fireEvent.mouseEnter(tab);
    for (let i = 0; i < 5; i++) {
      act(() => {
        vi.advanceTimersByTime(10);
      });
      fireEvent.mouseLeave(tab);
      fireEvent.mouseEnter(tab); // the pointer never actually moved
    }
    // 50ms burned above, so this lands exactly on the delay measured from the first arrival.
    act(() => {
      vi.advanceTimersByTime(TAB_EXPAND_DELAY_MS - 50);
    });
    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBe("true");

    // …and the same storm ending OFF the tab settles collapsed, so the fix is not "never collapse".
    for (let i = 0; i < 5; i++) {
      fireEvent.mouseLeave(tab);
      fireEvent.mouseEnter(tab);
    }
    fireEvent.mouseLeave(tab);
    settle();
    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBeUndefined();
  });

  it("collapses once a drag starts, so the tab being dragged is its own size", () => {
    const onReorder = vi.fn();
    renderTabs({ onReorder });
    stubTabWidth("foundry", SQUEEZED_W);
    hover("foundry");
    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBe("true");

    const tab = screen.getByTestId("tab-foundry");
    fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 200, clientY: 10 });

    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBeUndefined();
  });
});

describe("the full name reaches keyboard and screen-reader users too", () => {
  it("carries the whole project name in the tab's ACCESSIBLE NAME, not only on hover", () => {
    // `title` cannot do this job and never could: `disableNativeTooltips()` installs a capture-phase
    // `mouseover` listener that strips `title` app-wide, rehoming it to `aria-label` ONLY when the
    // element has no accessible name yet. A tab has visible text, so the attribute was removed with
    // no replacement — every hover, forever. The name has to be an explicit `aria-label`.
    renderTabs();
    const tab = screen.getByTestId("tab-foundry");
    expect(tab.getAttribute("aria-label")).toContain("foundry-web");
  });

  it("names the tab even when the label is squeezed to nothing", () => {
    // The accessible name must not be derived from the rendered (clipped) text — that is exactly
    // what fails on the selected tab in the screenshot.
    renderTabs({
      selectedProjectId: "sparkle",
      countsByProject: { sparkle: counts({ needs_you: 155 }) },
    });
    expect(screen.getByTestId("tab-sparkle").getAttribute("aria-label")).toContain(
      "sparkle-desktop",
    );
  });
});

describe("the width floor — no name collapses to \"t..\"", () => {
  afterEach(restoreLayout);

  /** What `measureChrome` will compute for a tab rendered with only a pin beside its label. */
  const PIN_W = 30;
  const CHROME = TAB_BODY_PAD_X * 2 + TAB_BODY_GAP + PIN_W;

  it("floors the TAB at its chrome plus a readable name, and the SELECTED tab higher", () => {
    // ON THE TAB, NOT ON THE LABEL. `min-width` on the label was the obvious home and it does not
    // work: it floors the label's box but does not cap its MIN-CONTENT CONTRIBUTION, which for
    // nowrap text is the whole string — so the tab's automatic minimum became "chrome + the entire
    // name" and no tab shrank at all (measured in Chrome: six tabs, 1091px of content in a 470px
    // strip, zero shrink). jsdom cannot see that, which is why the real check is the probe in
    // scripts/visual/tab-crowded-probe.mjs; this pins the arithmetic that feeds it.
    //
    // The selected tab is floored higher for two reasons: its name is the one you most need, and it
    // is the tab that loses its name FIRST, because it carries the widest chrome.
    expect(TAB_LABEL_MIN_WIDTH_ACTIVE).toBeGreaterThan(TAB_LABEL_MIN_WIDTH);
    // Names want 300px, far more than either floor. `onClose: undefined` keeps the tab to a pin and
    // a label, so the chrome the component measures is a number this test can state exactly.
    stubLayout({ natural: 300, nonLabel: PIN_W });
    renderTabs({ selectedProjectId: "sparkle", onClose: undefined });

    expect(screen.getByTestId("tab-foundry").style.minWidth).toBe(
      `${CHROME + TAB_LABEL_MIN_WIDTH}px`,
    );
    expect(screen.getByTestId("tab-sparkle").style.minWidth).toBe(
      `${CHROME + TAB_LABEL_MIN_WIDTH_ACTIVE}px`,
    );
    // The label itself must stay free to shrink — a floor there is what did not work.
    expect(screen.getByTestId("tab-label-foundry").style.minWidth).toBe("0");
  });

  it("floors a SHORT name at its own width, never padding it out to the floor", () => {
    // The end-to-end half of `labelMinWidth`'s cap: a name that needs 20px contributes 20px to the
    // floor, not 104px, which would otherwise sit in the active tab as dead space whenever the bar
    // is roomy.
    stubLayout({ natural: 20, nonLabel: PIN_W });
    renderTabs({ selectedProjectId: "sparkle", onClose: undefined });

    // The ACTIVE tab too: its 104px floor is capped at the 20px the name needs, so a short-named
    // selected project gets no dead space.
    expect(screen.getByTestId("tab-sparkle").style.minWidth).toBe(`${CHROME + 20}px`);
    expect(screen.getByTestId("tab-foundry").style.minWidth).toBe(`${CHROME + 20}px`);
  });

  it("imposes NO floor at all until the layout has been measured", () => {
    // jsdom's own zeros, unstubbed — the first-paint case. A guessed floor here would pin every tab
    // to a width nobody measured.
    renderTabs({ selectedProjectId: "sparkle" });
    expect(screen.getByTestId("tab-sparkle").style.minWidth).toBe("0");
  });

  describe("tabMinWidth", () => {
    it("is the tab's unshrinkable chrome plus whatever floor the name earns", () => {
      expect(tabMinWidth(140, 300, false)).toBe(140 + TAB_LABEL_MIN_WIDTH);
      expect(tabMinWidth(140, 300, true)).toBe(140 + TAB_LABEL_MIN_WIDTH_ACTIVE);
      expect(tabMinWidth(140, 20, true)).toBe(160);
    });

    it("fails OPEN when either input is unmeasured", () => {
      // Two different unmeasured states, and neither may invent a floor: no name width yet, and no
      // tab width yet (a tab whose element has not been laid out).
      expect(tabMinWidth(140, 0, true)).toBe(0);
      expect(tabMinWidth(0, 300, true)).toBe(0);
    });
  });

  describe("labelMinWidth", () => {
    it("never floors a name ABOVE the space it actually needs", () => {
      // A `min-width` is a floor at every size, not only under pressure — so a flat 104px on the
      // active tab would pad a short name out with dead space whenever the bar is roomy. The floor
      // is therefore capped by the name's own measured width: a short name is never padded, and a
      // long one still refuses to vanish.
      expect(labelMinWidth(28, true)).toBe(28);
      expect(labelMinWidth(28, false)).toBe(28);
      expect(labelMinWidth(300, true)).toBe(TAB_LABEL_MIN_WIDTH_ACTIVE);
      expect(labelMinWidth(300, false)).toBe(TAB_LABEL_MIN_WIDTH);
    });

    it("imposes NO floor until the name has been measured", () => {
      // 0 is "not measured yet" (first paint, and every jsdom rect). Fail OPEN to the pre-floor
      // behaviour rather than pinning every label to the floor width sight-unseen.
      expect(labelMinWidth(0, true)).toBe(0);
      expect(labelMinWidth(0, false)).toBe(0);
    });
  });

  it("scrolls the strip rather than squeezing tabs past the floor", () => {
    // The floor makes the tabs unshrinkable past a point, so a crowded strip HAS to overflow
    // somewhere. It overflows into a scroll, not off the edge of the window.
    renderTabs();
    const strip = screen.getByRole("tablist");
    expect(strip.style.overflowX).toBe("auto");
  });
});

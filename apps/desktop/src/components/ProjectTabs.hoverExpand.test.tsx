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

// THE TAB ROLE LIVES ON THE LABEL (`tab-label-<id>`), NOT ON THE SLOT (`tab-<id>`) — bead
// sparkle-2mwl2m.1. A `role="tab"` flattens its whole subtree, which was silencing the close
// button, the pin and the stale badge inside it, so the role moved inward to the name and
// those controls became its siblings. `aria-selected` and the accessible name moved with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
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

/** The height a tab has in a real browser — 8px padding either side of a 14px icon row plus the
 *  border. Overridable per test so an assertion can name a height that appears NOWHERE in the
 *  component, which is what makes "the frozen height was MEASURED" provable rather than assumed. */
const TAB_H = 34;

function stubTabWidth(id: string, width: number, height: number = TAB_H, left = 0): void {
  const el = screen.getByTestId(`tab-${id}`);
  el.getBoundingClientRect = () =>
    ({
      x: left, y: 0, width, height, top: 0, left, right: left + width, bottom: height,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** The strip's own box. The expansion's ANCHOR is decided by comparing the tab's midpoint with
 *  this one's, so a test about which edge a tab grows from has to pin it. */
function stubBar(width: number): void {
  const bar = document.querySelector('[role="tablist"]') as HTMLElement;
  bar.getBoundingClientRect = () =>
    ({
      x: 0, y: 0, width, height: TAB_H, top: 0, left: 0, right: width, bottom: TAB_H,
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

/**
 * Render the strip inside a `Profiler` so a test can count the COMMITS an interaction costs.
 *
 * The counter is the instrument for the blinking half of bead sparkle-73imb: a settle that changes
 * nothing must cost nothing. It is trustworthy here because nothing else in the hover path sets
 * state — `wantId` is a ref — so a commit during a stationary-pointer storm has exactly one
 * possible source, the hover-expand state itself.
 */
function renderCounted(overrides: Partial<Parameters<typeof ProjectTabs>[0]> = {}) {
  const commits = { n: 0 };
  render(
    <Profiler
      id="strip"
      onRender={() => {
        commits.n += 1;
      }}
    >
      <ProjectTabs
        projects={SIX}
        selectedProjectId="sparkle"
        pinnedProjectId={null}
        countsByProject={{}}
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
        onClose={vi.fn()}
        {...overrides}
      />
    </Profiler>,
  );
  return commits;
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

  it("freezes the slot's HEIGHT too, so an out-of-flow body cannot collapse it to zero", () => {
    // THE BUG THE FOUNDER REPORTED (bead sparkle-73imb): *"when I click on a project tab, it just
    // blinks a lot of times and oftentimes does not become the active tab."*
    //
    // The strip aligns its tabs `flex-end`, NOT `stretch`, so a slot is sized purely by its in-flow
    // content — and the body asserted out of flow two tests up is the slot's ONLY in-flow child.
    // Freezing the width alone therefore left the slot at ZERO HEIGHT the instant it expanded
    // (measured in a real browser: h:32 → h:0). A zero-height tab is not under the pointer, so the
    // browser fires `mouseout`, the strip collapses, the height returns and `mouseover` fires again
    // — the oscillation is the blinking — and a press landing in a zero-height frame hit-tests to
    // the strip BEHIND the tab, which is the dropped click.
    //
    // 41 is deliberate: it appears nowhere in the component, so the only way the slot can carry it
    // is by having MEASURED this rect. A hard-coded height would fail this test.
    renderTabs();
    stubTabWidth("foundry", SQUEEZED_W, 41);

    hover("foundry");

    const tab = screen.getByTestId("tab-foundry");
    // Asserted TOGETHER on purpose: the height matters precisely in the state where nothing in flow
    // supplies one. Either half alone says nothing about the collapse.
    expect(screen.getByTestId("tab-body-foundry").style.position).toBe("absolute");
    expect(tab.style.height).toBe("41px");
  });

  it("refuses to expand a tab it could not MEASURE, rather than freezing a zero", () => {
    // The freeze is self-confirming — a slot pinned at `height: 0px` measures that zero back
    // forever — so an expansion captured before the strip has been laid out would be permanent.
    // jsdom's all-zero rects are exactly that unmeasured case, so this needs no stub: it IS the
    // condition. Failing open (no expansion) is the same doctrine `tabMinWidth` uses for a
    // measured 0.
    renderTabs();

    hover("cinder");

    const tab = screen.getByTestId("tab-cinder");
    expect(tab.dataset.expanded).toBeUndefined();
    expect(tab.style.height).toBe("");
    expect(tab.style.flex).not.toContain("0px");
  });

  it("costs NO commit to re-settle on the tab that is already expanded", () => {
    // The other half of the blinking, and the reason the state update is a functional, idempotent
    // one. The ⚠ badge's portaled card makes the browser fire `mouseleave`/`mouseenter` on a tab
    // with the pointer stationary — five pairs a second, measured. Each of those settles used to
    // mint a fresh state object, and a fresh object re-renders the strip even though nothing about
    // the expansion changed.
    const commits = renderCounted();
    stubTabWidth("foundry", SQUEEZED_W);
    hover("foundry");
    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBe("true");

    const before = commits.n;
    const deltas: number[] = [];
    // FIVE pairs — the rate the real-browser probe measured coming off the ⚠ badge in one second.
    // The pointer never moves, so every one of these settles on the tab that is already expanded.
    for (let i = 0; i < 5; i++) {
      const round = commits.n;
      fireEvent.mouseLeave(screen.getByTestId("tab-foundry"));
      fireEvent.mouseEnter(screen.getByTestId("tab-foundry"));
      settle();
      deltas.push(commits.n - round);
    }

    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBe("true");
    // A STORM OF ANY LENGTH COSTS AT MOST ONE COMMIT. Before the functional update each pair minted
    // a fresh state object and cost one commit apiece — five pairs, five commits, which is the
    // flicker. The one commit still permitted is React's, not the strip's: the eager-state bailout
    // needs the fiber to have no work left from the render that just expanded the tab, so the very
    // first settle after an expansion re-renders once and discovers the state is identical. Every
    // settle after that is free, which is what the per-round assertion below pins — a regression
    // that reinstated per-settle churn would show as five ones, not one.
    expect(commits.n - before).toBeLessThanOrEqual(1);
    expect(deltas.slice(1)).toEqual([0, 0, 0, 0]);
  });

  it("refuses a tab with WIDTH but no HEIGHT — the half of the guard an all-zero rect cannot reach", () => {
    // jsdom's rects are zero on both axes, so the test above is satisfied by the `r.width <= 0`
    // term alone and says nothing about the `r.height <= 0` one — which is the term that matters,
    // since a collapsed slot is exactly a box that still has its width (roborev 62807).
    renderTabs();
    stubTabWidth("foundry", SQUEEZED_W, 0);

    hover("foundry");

    const tab = screen.getByTestId("tab-foundry");
    expect(tab.dataset.expanded).toBeUndefined();
    expect(tab.style.height).toBe("");
  });

  it("RE-FREEZES when the tab's own width changes under it, rather than keeping a stale box", () => {
    // The idempotency guard must not become "never update". The slot carries a `min-width` floor,
    // so the width it ends up USING can exceed the basis that was frozen — and the only way the
    // expansion converges on the real box is for the `width` term to notice and re-freeze
    // (roborev 62807).
    renderTabs();
    stubTabWidth("foundry", SQUEEZED_W);
    hover("foundry");
    expect(screen.getByTestId("tab-foundry").style.flex).toBe(`0 0 ${SQUEEZED_W}px`);

    // Same pointer, same tab; the box under it got wider.
    stubTabWidth("foundry", SQUEEZED_W + 40);
    fireEvent.mouseLeave(screen.getByTestId("tab-foundry"));
    fireEvent.mouseEnter(screen.getByTestId("tab-foundry"));
    settle();

    expect(screen.getByTestId("tab-foundry").style.flex).toBe(`0 0 ${SQUEEZED_W + 40}px`);
  });

  it("RE-ANCHORS when the tab crosses the middle of the strip", () => {
    // The other term of the same guard. A tab in the right half grows leftward and one in the left
    // half grows rightward, so that the expansion stays inside the scroll container — and a strip
    // that scrolled under a stationary pointer must be able to flip that decision.
    renderTabs();
    stubBar(400);
    stubTabWidth("foundry", SQUEEZED_W, TAB_H, 10); // midpoint 55 — left half
    hover("foundry");
    expect(screen.getByTestId("tab-body-foundry").style.left).toBe("0px");

    stubTabWidth("foundry", SQUEEZED_W, TAB_H, 300); // midpoint 345 — right half
    fireEvent.mouseLeave(screen.getByTestId("tab-foundry"));
    fireEvent.mouseEnter(screen.getByTestId("tab-foundry"));
    settle();

    const body = screen.getByTestId("tab-body-foundry");
    expect(body.style.right).toBe("0px");
    expect(body.style.left).toBe("");
  });

  it("costs NO commit to FOCUS the tab the pointer already expanded — the press half of a click", () => {
    // Every ordinary mouse click takes this path: pressing a tab focuses it, focus takes the
    // immediate (no-delay) expand path, and the pointer has necessarily been hovering that same tab
    // already. Measured in Chrome, that no-op settle was one of the four commits a click cost.
    const commits = renderCounted();
    stubTabWidth("foundry", SQUEEZED_W);
    hover("foundry");
    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBe("true");

    const before = commits.n;
    fireEvent.focus(screen.getByTestId("tab-foundry"));

    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBe("true");
    expect(commits.n).toBe(before);
  });

  it("costs NO commit to press and release a tab without dragging it", () => {
    // A RATCHET, and honest about it: this passes against today's code both with and without an
    // idempotent `setDrag`, because React's eager-state bailout already drops the null-over-null
    // write. It is here to keep it that way — a future press-time state write (a pressed style, a
    // gesture object promoted from a ref) would repaint the whole strip under the user's finger on
    // the one interaction the founder reported as blinking, and this is what would catch it.
    // Measured from the SECOND press onward, for the same reason the storm test is: React's
    // eager-state bailout needs an idle fiber, so the first write after any other work still costs
    // one render however identical it is. What must not happen is a cost that repeats forever.
    const commits = renderCounted({ onReorder: vi.fn(), onTearOff: vi.fn() });
    const tab = screen.getByTestId("tab-foundry");
    const press = () => {
      fireEvent.pointerDown(tab, { pointerId: 1, button: 0, clientX: 10, clientY: 5 });
      fireEvent.pointerUp(tab, { pointerId: 1, button: 0, clientX: 10, clientY: 5 });
    };

    press();
    const before = commits.n;
    press();
    press();
    press();

    expect(commits.n).toBe(before);
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
    // The height freeze is released with the width. Honest about what this proves: it is already
    // true of the code that had no height freeze at all, so it is the negative half — a guard
    // against the fix degenerating into "always pin a height" — not a falsifiable assertion.
    expect(tab.style.height).toBe("");
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
    // …and it lives on the TAB, which since bead sparkle-2mwl2m.1 is the label rather than the
    // slot — see the note at the top of this file.
    const tab = screen.getByTestId("tab-label-foundry");
    expect(tab.getAttribute("role")).toBe("tab");
    expect(tab.getAttribute("aria-label")).toContain("foundry-web");
  });

  it("names the tab even when the label is squeezed to nothing", () => {
    // The accessible name must not be derived from the rendered (clipped) text — that is exactly
    // what fails on the selected tab in the screenshot.
    renderTabs({
      selectedProjectId: "sparkle",
      countsByProject: { sparkle: counts({ needs_you: 155 }) },
    });
    expect(screen.getByTestId("tab-label-sparkle").getAttribute("aria-label")).toContain(
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

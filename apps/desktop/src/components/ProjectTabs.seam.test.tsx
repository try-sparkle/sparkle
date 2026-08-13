// @vitest-environment jsdom
//
// THE FOLDER-TAB SEAM (bead sparkle-civ4i).
//
// *"Active project tab draws a bottom border so the tab strip rule runs under it — the active tab
// must open into the content area like a folder tab."*
//
// ── WHAT THIS FILE CAN AND CANNOT PROVE ────────────────────────────────────────────────────────
//
// It CANNOT prove the line is gone. jsdom never lays out and never loads the stylesheet, so no
// assertion here can see a pixel; and the line in question was never painted by the tab whose style
// a test would read — it came from the BAR's own bottom edge, one box away. That is the whole reason
// the defect survived a green suite. `scripts/visual/tab-seam-probe.mjs` is what settles it, in
// Chrome, at device scales 0.7 / 0.8 / 0.9 / 1.0 (the founder reads the app zoomed out, and a 1px
// rule and a 1px overlap of it round INDEPENDENTLY once a CSS pixel no longer owns a device pixel).
// Measured there: the rule painted through the active tab at ALL FOUR scales before this change,
// and at none of them after.
//
// What it CAN pin is the MECHANISM that makes the pixels come out right, so a later edit that
// quietly reinstates the old arrangement reds in the fast suite instead of only in a probe someone
// has to remember to run. Three facts, and each one is a thing that was actually wrong:
//
//   1. the rule is an INSET SHADOW on the bar, not a `border-bottom`. A border is painted OUTSIDE
//      the bar's padding box, and the tabs live inside a strip that is `overflow-x: auto` — so the
//      overhang that was supposed to cover the border was clipped away by the scroll container
//      every time. An inset shadow is painted after the bar's background and BEFORE its
//      descendants, so a tab covers it by being a descendant.
//   2. no slot is nudged down. `top: 1` WAS the old overlap; with the rule inside the padding box
//      the nudge only pushes tabs into the clip.
//   3. a hover-EXPANDED tab opens through the rule only when it is the ACTIVE one. Any tab face
//      reaching the bar's bottom edge now covers the rule, which is right for the active tab and
//      wrong for a hovered one — a hover would otherwise borrow the active state's own signal.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectTabs, TAB_EXPAND_DELAY_MS, TAB_RULE_PX } from "./ProjectTabs";
import { C } from "../theme/colors";

const PROJECTS = [
  { id: "sparkle", name: "sparkle-desktop" },
  { id: "foundry", name: "foundry-web" },
  { id: "tryst", name: "trystero-relay" },
];

const ACTIVE = "sparkle";

/** A believable squeezed width/height for the one tab a test expands. jsdom reports 0 for every
 *  rect, and the component REFUSES to freeze an unmeasured box — so without this the expansion
 *  simply does not happen and every assertion about it would pass by never running. */
const SQUEEZED_W = 90;
const TAB_H = 34;

function renderTabs() {
  render(
    <ProjectTabs
      projects={PROJECTS}
      selectedProjectId={ACTIVE}
      pinnedProjectId={null}
      countsByProject={{}}
      onSelect={vi.fn()}
      onTogglePin={vi.fn()}
      onClose={vi.fn()}
      onAddProject={vi.fn()}
    />,
  );
}

function stubTabWidth(id: string, width = SQUEEZED_W, height = TAB_H, left = 0): void {
  const el = screen.getByTestId(`tab-${id}`);
  el.getBoundingClientRect = () =>
    ({
      x: left, y: 0, width, height, top: 0, left, right: left + width, bottom: height,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** The strip's own box — `settleNow` compares the tab's midpoint against it to pick the anchor, so
 *  an unstubbed (all-zero) strip would make every expansion anchor the same way. */
function stubStrip(width = 400): void {
  const strip = document.querySelector('[role="tablist"]') as HTMLElement;
  strip.getBoundingClientRect = () =>
    ({
      x: 0, y: 0, width, height: TAB_H, top: 0, left: 0, right: width, bottom: TAB_H,
      toJSON: () => ({}),
    }) as DOMRect;
}

function hover(id: string): void {
  fireEvent.mouseEnter(screen.getByTestId(`tab-${id}`));
  act(() => {
    vi.advanceTimersByTime(TAB_EXPAND_DELAY_MS);
  });
}

const bar = () => document.querySelector(".concierge-tabbar") as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.getElementById("concierge-tabs-styles")?.remove();
});

describe("the active tab opens into the content area", () => {
  it("paints the strip's rule INSIDE the bar, where a tab can cover it — never as a border", () => {
    renderTabs();

    // THE DEFECT, stated as an assertion. A `border-bottom` sits outside the bar's padding box; the
    // tabs are inside a scroll container whose clip ends AT that box, so no tab can ever reach it.
    // Any bottom border here is that arrangement coming back.
    expect(bar().style.borderBottom).toBe("");
    expect(bar().style.borderBottomWidth).toBe("");

    // …and the rule is still THERE. Dropping it entirely would satisfy the line above perfectly and
    // is a different design from the one asked for: the strip keeps its rule, the ACTIVE tab opens
    // through it.
    //
    // THE WHOLE DECLARATION, NOT THREE SUBSTRINGS (roborev 63275). This read `toContain("inset")`
    // + `toContain("1px")` + `toContain(C.muted)`, and every one of those survives a shadow that
    // would put the rule back where it cannot be covered: `inset 0 1px 0 …` paints along the bar's
    // TOP edge, and `0 -1px 0 …` next to an unrelated inset term is not inset at all. The OFFSET'S
    // SIGN is the entire mechanism — a shadow one pixel UP from the padding box's bottom is the
    // thing a tab covers — and a substring match cannot see a sign.
    expect(bar().style.boxShadow).toBe(`inset 0 -${TAB_RULE_PX}px 0 ${C.muted}`);
  });

  it("does not nudge the slots down — the old overlap that the strip's clip ate", () => {
    renderTabs();
    for (const p of PROJECTS) {
      // `top` on the slot was the pre-fix mechanism: shift every tab a pixel down so the active
      // one's face reached the bar's border. It never arrived (the strip clipped it) and it now has
      // nothing to reach, so a non-empty value here is the old scheme reinstated.
      expect(screen.getByTestId(`tab-${p.id}`).style.top).toBe("");
    }
  });

  it("lets an expanded ACTIVE tab reach the rule, and stops an expanded inactive tab short of it", () => {
    renderTabs();
    stubStrip();
    stubTabWidth(ACTIVE);
    hover(ACTIVE);

    // The active tab is the one the seam is FOR: expanded or not, its face runs to the bar's bottom
    // edge and covers the rule.
    expect(screen.getByTestId(`tab-${ACTIVE}`).dataset.expanded).toBe("true");
    expect(screen.getByTestId(`tab-body-${ACTIVE}`).style.bottom).toBe("0px");
  });

  it("keeps the rule running under a tab that is merely HOVERED", () => {
    renderTabs();
    stubStrip();
    stubTabWidth("foundry");
    hover("foundry");

    // Hovering is not selecting. An expanded inactive tab is `barSurface` with a lifted top and
    // sides; if its face also reached the bar's bottom edge it would cover the rule and read as the
    // active tab for as long as the pointer rested on it.
    expect(screen.getByTestId("tab-foundry").dataset.expanded).toBe("true");
    expect(screen.getByTestId("tab-body-foundry").style.bottom).toBe(`${TAB_RULE_PX}px`);
  });
});

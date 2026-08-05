// @vitest-environment jsdom
//
// THE COMPOSER AT A NARROW COLUMN WIDTH.
//
// The founder's screenshot of a narrow concierge showed three failures at once: the toolbar row
// (paperclip, Screenshot, Upload, Here/Away) running past the right edge and clipped mid-control;
// the send tray's three positions ellipsised to "S… P… S…"; and the compose box overflowing its
// container rather than fitting inside it.
//
// This matters MORE than it did, because every per-column width ceiling was just removed and a 50px
// floor put in its place (engine/columnResize) — a narrow concierge stops being an edge case and
// becomes something the user reaches on purpose.
//
// AND IT MATTERS AGAIN NOW, because the attach row went from ONE resting control to TWO (bead
// sparkle-f8bjx). Two permanent buttons where one stood is exactly the change that could make the
// reported clipping worse, so this file carries the arithmetic that says it does not — see the
// "two buttons cost less than the disclosure did" block below.
//
// WHAT IS ASSERTED HERE, AND WHAT IS NOT. jsdom has no layout engine, so "does it overflow" is
// literally unaskable of the rendered DOM — every `getBoundingClientRect` is 0 and `flex-wrap`
// never runs. So this file pins the three things that ARE decidable without layout: the pure
// density rules, the STRUCTURAL properties that make wrapping possible at all (a row that may wrap,
// and children that are allowed to shrink below their content), and the CONTENT BOUND — how many
// controls the row holds and whether any of them can grow a word. The rendered result is verified
// separately in real WebKit — see the probe in the PR description.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  AttachControl,
  TOOLBAR_ICON_ONLY_MAX_COLUMN_PX,
  COMPOSER_INSETS_PX,
  toolbarShowsLabels,
} from "./ComposeBox";
import { PresenceSlider } from "./PresenceSlider";
import { CONCIERGE_DEFAULT_WIDTH, COLUMN_MIN_WIDTH } from "../../engine/columnResize";

describe("toolbarShowsLabels — the toolbar collapses to icons before it clips", () => {
  it("is expressed in COLUMN width, not toolbar width", () => {
    // The unit is the whole point of the constant's name. The toolbar gets the column minus the
    // composer's fixed insets, so a threshold stated in toolbar terms fires 46px too late when
    // handed a column width.
    expect(TOOLBAR_ICON_ONLY_MAX_COLUMN_PX).toBe(300 + COMPOSER_INSETS_PX);
  });

  it("keeps the words while the row can afford them", () => {
    expect(toolbarShowsLabels(TOOLBAR_ICON_ONLY_MAX_COLUMN_PX)).toBe(true);
    expect(toolbarShowsLabels(900)).toBe(true);
    // The DEFAULT concierge still shows words: 360 - 46 = 314px of toolbar, above the ~300 it needs.
    // (Unlike the send tray, which is already in its short-label tier at this width.)
    expect(toolbarShowsLabels(CONCIERGE_DEFAULT_WIDTH)).toBe(true);
  });

  it("drops to ICONS below the threshold rather than letting a label truncate", () => {
    // An icon at 12px reads; "Here — Sparkle checks…" truncated does not. Same argument as the send
    // tray's icon tier.
    expect(toolbarShowsLabels(TOOLBAR_ICON_ONLY_MAX_COLUMN_PX - 1)).toBe(false);
    expect(toolbarShowsLabels(200)).toBe(false);
    // THE BAND THE OLD UNIT GOT WRONG (roborev 57270). At a 320px column the toolbar row is handed
    // 320 - 46 = 274px for content that needs ~300 — so the labels must ALREADY be gone. While the
    // threshold still held its toolbar-derived 300 and was compared against the column, this
    // returned true and the row degraded exactly as the tier exists to prevent.
    expect(toolbarShowsLabels(320)).toBe(false);
    // …including at the column's new hard floor, which is the width this whole change makes
    // reachable in one drag.
    expect(toolbarShowsLabels(COLUMN_MIN_WIDTH)).toBe(false);
  });

  it("takes the LABELLED form when nothing has been measured yet", () => {
    // Matches `trayDensityFor`: booting collapsed and widening a frame later is a visible flicker.
    expect(toolbarShowsLabels(0)).toBe(true);
    expect(toolbarShowsLabels(-1)).toBe(true);
  });
});

// ── TWO BUTTONS COST LESS THAN THE DISCLOSURE DID ──────────────────────────────────────────────
//
// The obvious worry about replacing one paperclip with two permanent buttons is that the narrow
// column gets worse. It does not, and this is the argument, pinned so it cannot quietly stop being
// true:
//
//   old, at rest      1 control  (paperclip)
//   old, EXPANDED     3 controls (paperclip + Screenshot + Upload) — reachable at ANY width, by
//                     hover alone, which is the state the founder's clipping report was of
//   new, always       2 controls (Screenshot + Upload)
//
// The worst case shrank by one control. The other half of the argument is that the new row's width
// cannot GROW with anything: neither button ever renders a word at any column width, so the attach
// group's content is a constant ~66px instead of a value that was ~165px whenever it was open.
describe("the attach row is width-bounded by construction", () => {
  const group = () => screen.getByTestId("concierge-attach");

  it("holds exactly two controls, and no trigger to expand into a third", () => {
    render(<AttachControl onAttach={() => {}} />);
    const buttons = group().querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    // The paperclip. Its absence is what makes 2 the WORST case and not the resting one.
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
  });

  it("draws no word in either button — there is no label tier left to get wrong", () => {
    // AttachControl takes no width and no `showLabels` any more. That is the assertion: the row
    // cannot be put into a labelled state by any caller, so no column width can widen it. Against
    // the old component this same render produced "Screenshot" and "Upload" as visible text.
    render(<AttachControl onAttach={() => {}} />);
    for (const b of Array.from(group().querySelectorAll("button"))) {
      expect(b.textContent).toBe("");
      // …but each is still NAMED, or the wordless button would be unaddressable rather than tidy.
      expect(b.getAttribute("aria-label")).toMatch(/^(Screenshot|Upload)$/);
      // …and still draws something, or "no word" would be satisfied by an empty box.
      expect(b.querySelector("svg")).toBeTruthy();
    }
  });

  it("may SHRINK AND WRAP — the founder's actual clipping", () => {
    // ── roborev 57278 ───────────────────────────────────────────────────────────────────────────
    // The fix for the reported clipping was itself unasserted: deleting `minWidth: 0` / `flexWrap`
    // left the suite green.
    //
    // Assertable in jsdom despite the no-layout-engine limit, because these are inline styles — the
    // declarations ARE the behaviour here. The group is a flex item of the toolbar, so its own
    // default `min-width: auto` refuses to go below its min-content and the toolbar's `flex-wrap`
    // cannot break INSIDE it; that is how the row ran past the column edge.
    //
    // The INNER actions container that used to carry the identical pair is gone with the
    // disclosure — there is only one box to pin now.
    render(<AttachControl onAttach={() => {}} />);
    expect(group().style.minWidth).toBe("0");
    expect(group().style.flexWrap).toBe("wrap");
    expect(document.getElementById("concierge-attach-actions")).toBeNull();
  });
});

// ── THE COLLAPSED FORM THAT REMAINS ────────────────────────────────────────────────────────────
//
// The block at the top pins WHEN to collapse. It cannot pin WHAT the collapsed control is — and
// that is where the load-bearing claim lives: "accessible names never move". A collapsed icon
// button whose word is gone has NO accessible name unless something supplies one, which is a
// strictly worse outcome than the truncation it replaces.
//
// `showLabels` defaults to `true`, so every other render in the suite exercises only the labelled
// branch — deleting the `aria-label`, or reverting `{showLabels ? label : null}`, left the whole
// suite green (roborev 57049). This is the case that goes red.
//
// Only PresenceSlider is left here: the attach buttons no longer have a labelled form to collapse
// FROM, which the block above asserts directly.
describe("the collapsed controls keep their names", () => {
  it("PresenceSlider: icons with no visible word, names unchanged", () => {
    const { rerender } = render(<PresenceSlider />);
    const here = () => screen.getByRole("button", { name: /^Here/ });
    const away = () => screen.getByRole("button", { name: /^Away/ });
    expect(here().textContent).toBe("Here");
    expect(away().textContent).toBe("Away");

    rerender(<PresenceSlider showLabels={false} />);
    // The names are full sentences ("Here — Sparkle checks with you before acting") and do not move…
    expect(here()).toBeTruthy();
    expect(away()).toBeTruthy();
    // …while the visible words are replaced by glyphs, so neither can be clipped mid-word.
    expect(here().textContent).toBe("");
    expect(away().textContent).toBe("");
    // An actual glyph replaced the word, rather than the button simply rendering empty.
    expect(here().querySelector("svg")).toBeTruthy();
  });
});

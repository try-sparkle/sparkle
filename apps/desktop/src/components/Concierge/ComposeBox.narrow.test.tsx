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
// WHAT IS ASSERTED HERE, AND WHAT IS NOT. jsdom has no layout engine, so "does it overflow" is
// literally unaskable of the rendered DOM — every `getBoundingClientRect` is 0 and `flex-wrap`
// never runs. So this file pins the two things that ARE decidable without layout: the pure density
// rules, and the STRUCTURAL properties that make wrapping possible at all (a row that may wrap, and
// children that are allowed to shrink below their content). The rendered result is verified
// separately in real WebKit — see the probe in the PR description.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  AttachControl,
  ATTACH_ICON_ONLY_MAX_COLUMN_PX,
  COMPOSER_INSETS_PX,
  attachShowsLabels,
} from "./ComposeBox";
import { PresenceSlider } from "./PresenceSlider";
import { CONCIERGE_DEFAULT_WIDTH, COLUMN_MIN_WIDTH } from "../../engine/columnResize";

describe("attachShowsLabels — the attach actions collapse to icons before they clip", () => {
  it("is expressed in COLUMN width, not toolbar width", () => {
    // The unit is the whole point of the constant's name. The toolbar gets the column minus the
    // composer's fixed insets, so a threshold stated in toolbar terms fires 46px too late when
    // handed a column width.
    expect(ATTACH_ICON_ONLY_MAX_COLUMN_PX).toBe(300 + COMPOSER_INSETS_PX);
  });

  it("keeps the words while the row can afford them", () => {
    expect(attachShowsLabels(ATTACH_ICON_ONLY_MAX_COLUMN_PX)).toBe(true);
    expect(attachShowsLabels(900)).toBe(true);
    // The DEFAULT concierge still shows words: 360 - 46 = 314px of toolbar, above the ~300 it needs.
    // (Unlike the send tray, which is already in its short-label tier at this width.)
    expect(attachShowsLabels(CONCIERGE_DEFAULT_WIDTH)).toBe(true);
  });

  it("drops to ICONS below the threshold rather than letting 'Screenshot' truncate", () => {
    // An icon at 12px reads; "Screensh…" does not. Same argument as the send tray's icon tier.
    expect(attachShowsLabels(ATTACH_ICON_ONLY_MAX_COLUMN_PX - 1)).toBe(false);
    expect(attachShowsLabels(200)).toBe(false);
    // THE BAND THE OLD UNIT GOT WRONG (roborev 57270). At a 320px column the toolbar row is handed
    // 320 - 46 = 274px for content that needs ~300 — so the labels must ALREADY be gone. While the
    // threshold still held its toolbar-derived 300 and was compared against the column, this
    // returned true and the row degraded exactly as the tier exists to prevent.
    expect(attachShowsLabels(320)).toBe(false);
    // …including at the column's new hard floor, which is the width this whole change makes
    // reachable in one drag.
    expect(attachShowsLabels(COLUMN_MIN_WIDTH)).toBe(false);
  });

  it("takes the LABELLED form when nothing has been measured yet", () => {
    // Matches `trayDensityFor`: booting collapsed and widening a frame later is a visible flicker.
    expect(attachShowsLabels(0)).toBe(true);
    expect(attachShowsLabels(-1)).toBe(true);
  });
});

// ── THE COLLAPSED FORM ITSELF, RENDERED ────────────────────────────────────────────────────────
//
// The block above pins WHEN to collapse. It cannot pin WHAT the collapsed control is — and that is
// where the load-bearing claim of this change lives: "accessible names never move". A collapsed
// icon button whose word is gone has NO accessible name unless something supplies one, which is a
// strictly worse outcome than the truncation it replaces.
//
// Both `showLabels` props default to `true`, so every other render in the suite exercises only the
// labelled branch — deleting the new `aria-label`, or reverting `{showLabels ? label : null}`, left
// the whole suite green (roborev 57049). These are the cases that go red.
describe("the collapsed controls keep their names", () => {
  it("AttachControl: icons with no visible word, but still addressable by name", () => {
    const { rerender } = render(<AttachControl onAttach={() => {}} showLabels />);
    // Open the group — the two actions only exist while it is expanded.
    screen.getByRole("button", { name: "Attach" }).click();
    rerender(<AttachControl onAttach={() => {}} showLabels />);
    expect(screen.getByRole("button", { name: "Screenshot" }).textContent).toContain("Screenshot");

    rerender(<AttachControl onAttach={() => {}} showLabels={false} />);
    // THE NAME SURVIVES — the assertion that fails without the new `aria-label`.
    const upload = screen.getByRole("button", { name: "Upload" });
    // …and the WORD is gone, so there is nothing left to ellipsise into "Uploa…".
    expect(upload.textContent).toBe("");
    expect(screen.getByRole("button", { name: "Screenshot" }).textContent).toBe("");
  });

  it("the attach group may SHRINK AND WRAP — the founder's actual clipping", () => {
    // ── roborev 57278 ───────────────────────────────────────────────────────────────────────────
    // The fix for the reported clipping was itself unasserted: deleting `minWidth: 0` / `flexWrap`
    // left the suite green, and the regression it re-opens is invisible to any probe that does not
    // hover the paperclip first.
    //
    // Assertable in jsdom despite the no-layout-engine limit, because these are inline styles — the
    // declarations ARE the behaviour here. The group is a flex item of the toolbar, so its own
    // default `min-width: auto` refuses to go below its min-content and the toolbar's `flex-wrap`
    // cannot break INSIDE it; expanded, that runs past the column edge below ~97px.
    render(<AttachControl onAttach={() => {}} showLabels={false} />);
    screen.getByRole("button", { name: "Attach" }).click();

    const group = screen.getByTestId("concierge-attach");
    expect(group.style.minWidth).toBe("0");
    expect(group.style.flexWrap).toBe("wrap");
    // The inner actions box carries the identical load-bearing pair and was equally unpinned.
    const actions = document.getElementById("concierge-attach-actions") as HTMLElement;
    expect(actions.style.minWidth).toBe("0");
    expect(actions.style.flexWrap).toBe("wrap");
  });

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

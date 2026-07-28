// @vitest-environment jsdom
//
// The bar in isolation. `AgentSidebar.stageLadder.test.tsx` already covers what the chips DO to the
// ladder; what is pinned here is the presentation contract the chips carry on their own — the count
// on the surface, the sentence in the accessible name, and the fact that the ● N comes from the
// shared `BandBadge` rather than a fourth local copy of "dot plus number".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StatusFilterBar } from "./StatusFilterBar";
import { allBandsVisible, type StatusBand } from "../engine/buildSections";
import { bandColor } from "../engine/statusBandLabels";
import { C, statusInk } from "../theme/colors";
import { asRgb } from "./statusDotTestUtils";

afterEach(cleanup);

const counts: Record<StatusBand, number> = { needs_you: 3, running: 2, done: 5 };

function renderBar(over: Partial<Parameters<typeof StatusFilterBar>[0]> = {}) {
  const props = { counts, visible: allBandsVisible(), onToggle: vi.fn(), onReset: vi.fn(), ...over };
  render(<StatusFilterBar {...props} />);
  return props;
}

describe("StatusFilterBar — what the chip shows", () => {
  it("shows the COUNT on the chip and the whole phrase in the accessible name", () => {
    // The phrase must never be rebuilt from parts for styling — assembling it from a count span and
    // a label span is what once shipped "3 Needs you". `bandCountLabel` hands it over whole.
    renderBar();
    const chip = screen.getByTestId("status-chip-needs_you");
    expect(chip.textContent).toBe("3");
    expect(chip.getAttribute("aria-label")).toContain("3 Need you");
    expect(chip.getAttribute("title")).toContain("3 Need you");
  });

  it("inflects at n = 1 — the boundary the shared helper owns", () => {
    renderBar({ counts: { ...counts, needs_you: 1 } });
    const label = screen.getByTestId("status-chip-needs_you").getAttribute("aria-label");
    expect(label).toContain("1 Needs you");
    expect(label).not.toContain("1 Need you —");
  });

  it("renders the SHARED BandBadge, not a local dot-and-number", () => {
    // The point of the extraction: if this chip ever grows its own dot again, the colour rule can
    // drift from the badge the concierge and the tabs are meant to converge on.
    renderBar();
    for (const band of ["needs_you", "running", "done"] as const) {
      const chip = screen.getByTestId(`status-chip-${band}`);
      expect(chip.contains(screen.getByTestId(`band-badge-${band}`))).toBe(true);
    }
  });

  it("announces the count ONCE — the badge inside the chip is silent", () => {
    // The button already carries "3 Need you — showing, click to hide". A badge contributing its own
    // accessible name would make a screen reader say the count twice per chip.
    renderBar();
    expect(screen.queryAllByRole("img", { name: /Need you|Running|Done/ })).toHaveLength(0);
  });

  it("keeps an OFF chip's count visible — nothing is silently lost behind a filter", () => {
    renderBar({ visible: { needs_you: false, running: true, done: true } });
    const chip = screen.getByTestId("status-chip-needs_you");
    expect(chip.getAttribute("data-on")).toBe("false");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.textContent).toBe("3");
  });

  it("inks the count per state: the band's own ink when ON, muted when OFF", () => {
    // The chip's `color` moved off the button and onto the badge's `ink` prop, and neither end had
    // a test on the RESULT (roborev 54026): BandBadge only proved the prop is honoured, and the
    // assertions above read data-on/textContent. Deleting the prop, or passing it unconditionally,
    // would leave the suite green while every chip painted as equally live.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={allBandsVisible()}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTestId("band-badge-needs_you").style.color).toBe(
      asRgb(statusInk(bandColor("needs_you"))),
    );
    rerender(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: false, running: true, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTestId("band-badge-needs_you").style.color).toBe(C.muted);
  });

  it("dims an OFF chip with INK, never with opacity — opacity composites the count", () => {
    // The same defect the Plan/Build strip's 0.9 had (roborev 54038): an opacity on the button
    // multiplies against whatever ink the badge resolved, so the OFF count was landing at 2.24:1 on
    // light's sidebar rather than the token's own 3.86:1. The empty string, not "1": that is the
    // only value that proves the property was never set rather than set back to a safe-looking one.
    renderBar({ visible: { needs_you: false, running: true, done: true } });
    expect(screen.getByTestId("status-chip-needs_you").style.opacity).toBe("");
    expect(screen.getByTestId("status-chip-running").style.opacity).toBe("");
  });
});

describe("StatusFilterBar — Reset", () => {
  it("stays hidden while every band is showing", () => {
    renderBar();
    expect(screen.queryByTestId("status-filter-reset")).toBeNull();
  });

  it("appears as soon as ANY band is hidden, and calls the shared clear action", () => {
    // Not a second filter state: the integration passes uiStore.showAllStatusBands, the same action
    // the concierge scope line and the helper island's chiclets write.
    const props = renderBar({ visible: { needs_you: true, running: false, done: true } });
    fireEvent.click(screen.getByTestId("status-filter-reset"));
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it("stays reachable at minimum sidebar width — the row wraps rather than overflowing", () => {
    // jsdom does no layout, so this pins the style contract instead of a measured width. The chips
    // are content-sized and Reset is `nowrap`, so nothing in the row can shrink; at MIN_WIDTH 160
    // the list's `overflowY: auto` makes overflow-x `auto` too and `marginLeft: auto` collapses,
    // which would push Reset — the one way back out of the filter — off the visible edge.
    renderBar({ visible: { needs_you: true, running: false, done: true } });
    expect(screen.getByTestId("status-filter-bar").style.flexWrap).toBe("wrap");
    expect(screen.getByTestId("status-chip-running").style.flex).toBe("0 0 auto");
  });
});

describe("StatusFilterBar — toggling", () => {
  it("multi-select: each chip toggles only its own band", () => {
    const props = renderBar({ visible: { needs_you: true, running: false, done: true } });
    fireEvent.click(screen.getByTestId("status-chip-done"));
    expect(props.onToggle).toHaveBeenCalledWith("done");
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });
});

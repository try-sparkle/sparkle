// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BandBadge } from "./BandBadge";
import { bandColor } from "../engine/statusBandLabels";
import { statusInk } from "../theme/colors";
import { asRgb } from "./statusDotTestUtils";

afterEach(cleanup);

// The badge exists so the surfaces showing "band → colour + count" stop re-deriving it (see the
// header of BandBadge.tsx). What is pinned here is the part that made the extraction worth doing:
// the visual strips to a number, and the SENTENCE survives in the accessible name with its verb
// agreeing.

describe("BandBadge — ● N", () => {
  it("renders the count alone, not the label", () => {
    render(<BandBadge band="needs_you" count={3} />);
    expect(screen.getByTestId("band-badge-needs_you").textContent).toBe("3");
  });

  it("keeps the WHOLE phrase in the accessible name and the tooltip, agreeing in number", () => {
    // "1 Needs you" but "3 Need you" — the agreement bandCountLabel owns. Splitting the count out
    // for styling is what once shipped "3 Needs you" on screen; the badge shows the number alone
    // and hands the untouched sentence to the label, so the two can never disagree.
    const { rerender } = render(<BandBadge band="needs_you" count={1} />);
    expect(screen.getByRole("img", { name: "1 Needs you" }).getAttribute("title")).toBe("1 Needs you");
    rerender(<BandBadge band="needs_you" count={3} />);
    expect(screen.getByRole("img", { name: "3 Need you" })).toBeTruthy();
  });

  it("takes its dot colour from the BAND, so it is a legend for the rows it counts", () => {
    render(<BandBadge band="running" count={2} />);
    const dot = screen.getByTestId("band-badge-running").firstElementChild as HTMLElement;
    expect(dot.style.background).toBe(asRgb(bandColor("running")));
  });

  it("hollows the dot when the band is filtered off — state without relying on colour", () => {
    render(<BandBadge band="needs_you" count={4} filled={false} />);
    const dot = screen.getByTestId("band-badge-needs_you").firstElementChild as HTMLElement;
    expect(dot.style.background).toBe("transparent");
    expect(dot.style.boxShadow).toContain("inset");
  });

  it("paints the count with the shared rule by default, and takes an override for the OFF chip", () => {
    // The default IS the point of the component — `statusInk(bandColor())`, one rule, no literals.
    // The override exists for the single state that rule cannot express: a filter chip switched off,
    // which drops to `muted` so the row reads as "not currently applied". Anything else passing an
    // ink is re-opening the drift this file closed.
    // `needs_you` is the band `statusInk` passes through unchanged (green and gray are the two it
    // remaps to themed var() tokens), so the default is comparable as a colour here rather than as
    // a variable reference.
    const { rerender } = render(<BandBadge band="needs_you" count={2} />);
    expect(screen.getByTestId("band-badge-needs_you").style.color).toBe(
      asRgb(statusInk(bandColor("needs_you"))),
    );
    rerender(<BandBadge band="needs_you" count={2} ink="rgb(1, 2, 3)" />);
    expect(screen.getByTestId("band-badge-needs_you").style.color).toBe("rgb(1, 2, 3)");
  });

  it("contributes NO accessible name when silent — the wrapping button already says it", () => {
    // StatusFilterBar's chip carries "3 Need you — showing, click to hide" on the button itself.
    // Without this the count is announced twice.
    render(<BandBadge band="done" count={5} silent />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("band-badge-done").getAttribute("aria-hidden")).toBe("true");
  });
});

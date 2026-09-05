// @vitest-environment jsdom
//
// THE DEFERRAL HAS TO BE VISIBLE (bead `sparkle-ftapmp`). The founder's constraint on the mount gate
// was explicit: "a pane that silently never mounts is worse than the bug". This bar is the whole of
// the visibility half, so these assert the two things that make it worth having — it appears exactly
// when something is held back, and it says why and that it clears itself.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { PaneResidencyBanner, PANE_RESIDENCY_BANNER_TESTID } from "./PaneResidencyBanner";

afterEach(cleanup);

describe("PaneResidencyBanner", () => {
  it("renders NOTHING while nothing is deferred", () => {
    // Every healthy machine. A bar that shows when nothing is wrong gets ignored, and then it is not
    // read on the day it matters.
    const { container } = render(<PaneResidencyBanner deferredCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("appears as soon as a pane is held back", () => {
    render(<PaneResidencyBanner deferredCount={2} />);
    expect(screen.getByTestId(PANE_RESIDENCY_BANNER_TESTID)).toBeTruthy();
  });

  it("says HOW MANY, WHY, and that it clears itself", () => {
    render(<PaneResidencyBanner deferredCount={3} />);
    const text = screen.getByTestId(PANE_RESIDENCY_BANNER_TESTID).textContent ?? "";
    expect(text).toContain("3 agents are waiting to start");
    // WHY: memory, not a hang. Without this the bar is indistinguishable from a stall notice.
    expect(text).toContain("memory can hold");
    // RECOVERABLE, and said so — the reader must not go looking for a button that does not exist.
    expect(text).toContain("start on their own");
  });

  it("agrees with itself in the singular", () => {
    render(<PaneResidencyBanner deferredCount={1} />);
    const text = screen.getByTestId(PANE_RESIDENCY_BANNER_TESTID).textContent ?? "";
    expect(text).toContain("1 agent is waiting to start");
    expect(text).not.toContain("agents are");
  });

  it("quotes the reading's OWN basis when one is given, and invents none when it isn't", () => {
    // Naming the wrong dimension is the bug `CapacityReading.basis` exists to close — it already
    // sent one human chasing memory that was 94% free. A missing basis means the bar says less, not
    // that it guesses.
    const basis = "refused: only 2.1 GiB of memory is available right now ÷ 3379 MiB per agent";
    render(<PaneResidencyBanner deferredCount={2} basis={basis} />);
    expect(screen.getByTestId(PANE_RESIDENCY_BANNER_TESTID).textContent).toContain(basis);
    cleanup();

    render(<PaneResidencyBanner deferredCount={2} />);
    const text = screen.getByTestId(PANE_RESIDENCY_BANNER_TESTID).textContent ?? "";
    expect(text).not.toContain("refused:");
    expect(text).not.toContain("()");
  });

  it("stays IN FLOW — never a fixed overlay over the banner stack", () => {
    // `Workspace.bannerStack.test.tsx` records what happens otherwise: a `position: fixed` bar with
    // an opaque background paints over whichever shell banner is showing, so the user reads the
    // bottom half of a sentence about being offline.
    render(<PaneResidencyBanner deferredCount={2} />);
    const el = screen.getByTestId(PANE_RESIDENCY_BANNER_TESTID) as HTMLElement;
    const style = window.getComputedStyle(el);
    expect(style.position).not.toBe("fixed");
    expect(style.position).not.toBe("absolute");
    expect(el.style.zIndex).toBe("");
  });
});

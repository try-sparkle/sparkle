// WHICH ROW ACTIVATION PATCHES THE CABLE — the founder's single-vs-double click rule, as a table.
//
// The component half (does the row actually wire this predicate to the right handlers, and does a
// real two-click sequence mount exactly once) is asserted through the rendered sidebar in
// `components/AgentSidebar.rowMountGesture.test.tsx`. This file pins the RULE; that one pins that a
// user can reach it. Both are needed — a predicate nothing calls is the shape of defect the cable's
// own history is full of (roborev 55221: every consumer of `wired` was correct and NOTHING patched).
import { describe, expect, it } from "vitest";
import { mountsOnRowActivation } from "./cable";

describe("mountsOnRowActivation", () => {
  it("does NOT mount on a plain single click — the founder's whole ask", () => {
    // detail 1 is what a real mouse press delivers. This is the case that regressed him into panes
    // he never meant to open, and it is the one line of this table that must never flip back.
    expect(mountsOnRowActivation({ type: "click", detail: 1 })).toBe(false);
  });

  it("does NOT mount on the SECOND click of a double press either", () => {
    // The second press arrives as a click with detail 2 BEFORE the browser raises `dblclick`. If it
    // mounted here as well, the mount would fire twice for one gesture — and, worse, it would land
    // on the same press as the row's fold-the-subtree rule, which is why the mouse half keys off
    // `dblclick` rather than the click count.
    expect(mountsOnRowActivation({ type: "click", detail: 2 })).toBe(false);
    expect(mountsOnRowActivation({ type: "click", detail: 3 })).toBe(false);
  });

  it("mounts on the browser's dblclick", () => {
    expect(mountsOnRowActivation({ type: "dblclick" })).toBe(true);
  });

  it("mounts on Enter/Space — the keyboard has no double form", () => {
    expect(mountsOnRowActivation({ type: "key" })).toBe(true);
  });

  it("mounts on a detail-0 click — assistive tech and the synthetic keyboard jump", () => {
    // AXPress and HintOverlay's jump both dispatch a click with no pointer sequence behind it.
    // Neither can produce a `dblclick`, so declining here would leave those users with no mount at
    // all — and the jump mounted before this change.
    expect(mountsOnRowActivation({ type: "click", detail: 0 })).toBe(true);
  });
});

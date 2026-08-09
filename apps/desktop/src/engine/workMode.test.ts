import { describe, it, expect } from "vitest";
import { reconcileWorkMode } from "./workMode";

describe("reconcileWorkMode", () => {
  it("switches to Build when a real agent is selected while the chevron says Plan", () => {
    expect(reconcileWorkMode(true, "plan", false)).toBeNull(); // Plan is never auto-changed
  });

  it("switches to Build when a selection exists and the mode isn't already Build", () => {
    // A cross-mode select (notification/history jump) while on a non-Build, non-Plan mode would
    // only arise transiently; a real selection always resolves to Build.
    expect(reconcileWorkMode(true, "build", false)).toBeNull(); // already Build → no-op
  });

  it("returns null when already on Build with a selection (no needless setState)", () => {
    expect(reconcileWorkMode(true, "build", false)).toBeNull();
  });

  it("leaves the mode alone when a special view (Sparkle / board) owns the pane", () => {
    expect(reconcileWorkMode(true, "build", true)).toBeNull();
    expect(reconcileWorkMode(false, "build", true)).toBeNull();
  });

  it("never auto-changes Plan mode (board overlay, no agent)", () => {
    expect(reconcileWorkMode(true, "plan", false)).toBeNull();
    expect(reconcileWorkMode(false, "plan", false)).toBeNull();
  });

  it("keeps the user's chosen mode when the pane is empty (no selection)", () => {
    expect(reconcileWorkMode(false, "build", false)).toBeNull();
  });

  // ── THE THIRD MODE, AND THE ONE ASSERTION THAT PAYS FOR THE GUARD ──────────────────────────────
  // This is the case the old `mode === "plan"` guard got wrong, and getting it wrong made Preview
  // unreachable rather than merely quirky: with a row selected — which is the normal state of a
  // build column, and the only way anyone opens a preview — the helper answered "build", and
  // AgentSidebar's effect wrote it, so the column left Preview on the frame it entered.
  //
  // MUTATION TARGET, and it is exact: restore `mode === "plan"` in workMode.ts and this line goes
  // red with "build". Nothing else in the suite notices, which is why it is spelled out here.
  it("never auto-changes Preview mode, even with an agent selected", () => {
    expect(reconcileWorkMode(true, "preview", false)).toBeNull();
    expect(reconcileWorkMode(false, "preview", false)).toBeNull();
    expect(reconcileWorkMode(true, "preview", true)).toBeNull();
  });
});

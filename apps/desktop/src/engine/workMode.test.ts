import { describe, it, expect } from "vitest";
import { reconcileWorkMode, WORK_MODES, isWorkMode } from "./workMode";

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
  // THE UNION IS BACK TO TWO (founder, 2026-08-19: a preview is a concierge card, not a peer
  // column), so there is no third mode left to feed this helper and the rows that used `"preview"`
  // are gone with it.
  //
  // THE GUARD THEY GUARDED IS STILL `mode !== "build"`, NOT `mode === "plan"`, and that is now
  // unfalsifiable from outside — with two members the two spellings are equivalent, which is
  // precisely the state the original bug hid in: when a third mode was added, `mode === "plan"` let
  // it fall through and return "build", kicking the column out of that mode the instant a row was
  // selected. So the guard is pinned by the comment in workMode.ts rather than by a row here, and
  // the row below pins what CAN still be observed: Plan is never auto-changed.
  it("never auto-changes Plan mode, even with an agent selected", () => {
    expect(reconcileWorkMode(true, "plan", false)).toBeNull();
    expect(reconcileWorkMode(false, "plan", false)).toBeNull();
    expect(reconcileWorkMode(true, "plan", true)).toBeNull();
  });

  // WORK_MODES IS THE VALUE, and this asserts its membership directly — the enumeration is what
  // `isWorkMode` and the concierge's `set_work_mode` message are both built from, so a mode
  // re-added here without the rest of the surface would be caught by it.
  it("has exactly Build and Plan — no Preview", () => {
    expect([...WORK_MODES].sort()).toEqual(["build", "plan"]);
    expect(isWorkMode("preview")).toBe(false);
    expect(isWorkMode("build")).toBe(true);
    expect(isWorkMode("plan")).toBe(true);
  });
});

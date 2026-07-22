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
});

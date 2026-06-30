import { describe, it, expect } from "vitest";
import { reconcileWorkMode } from "./workMode";

describe("reconcileWorkMode", () => {
  it("syncs the chevron to the selected agent's kind", () => {
    // Build agent selected while the chevron says Think → drop to Build.
    expect(reconcileWorkMode("build", "think", false, true)).toBe("build");
    // Think agent selected while the chevron says Build → switch to Think.
    expect(reconcileWorkMode("think", "build", false, true)).toBe("think");
    // worker/shell are non-think → Build.
    expect(reconcileWorkMode("worker", "think", false, true)).toBe("build");
    expect(reconcileWorkMode("shell", "think", false, true)).toBe("build");
  });

  it("returns null when the mode already matches (no needless setState)", () => {
    expect(reconcileWorkMode("build", "build", false, true)).toBeNull();
    expect(reconcileWorkMode("think", "think", false, true)).toBeNull();
  });

  it("leaves the mode alone when a special view (Sparkle / board) owns the pane", () => {
    expect(reconcileWorkMode("think", "build", true, true)).toBeNull();
    expect(reconcileWorkMode("build", "think", true, true)).toBeNull();
  });

  it("never auto-changes Plan mode (board overlay, no agent)", () => {
    expect(reconcileWorkMode("build", "plan", false, true)).toBeNull();
    expect(reconcileWorkMode("think", "plan", false, true)).toBeNull();
    expect(reconcileWorkMode(undefined, "plan", false, true)).toBeNull();
  });

  it("keeps the user's chosen mode when the pane is empty (no selection)", () => {
    // e.g. switched into Think with no think agents — show the empty Think state, don't bounce.
    expect(reconcileWorkMode(undefined, "think", false, true)).toBeNull();
    expect(reconcileWorkMode(undefined, "build", false, true)).toBeNull();
  });

  describe("Think AI gate (subsumes the old brainstorm-gate effect)", () => {
    it("falls back to Build when sitting on Think with the feature off", () => {
      expect(reconcileWorkMode(undefined, "think", false, false)).toBe("build");
      expect(reconcileWorkMode("think", "think", false, false)).toBe("build");
      expect(reconcileWorkMode("build", "think", false, false)).toBe("build");
    });

    it("does NOT switch to Think for a selected think agent when the gate is off", () => {
      expect(reconcileWorkMode("think", "build", false, false)).toBeNull();
    });

    it("still drops to Build for a non-think selection regardless of the gate", () => {
      expect(reconcileWorkMode("build", "build", false, false)).toBeNull();
      expect(reconcileWorkMode("worker", "build", false, false)).toBeNull();
    });
  });
});

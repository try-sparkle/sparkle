import { describe, it, expect } from "vitest";
import { shouldShowHelper } from "./helperVisibility";

describe("shouldShowHelper", () => {
  it("shows when enabled and Sparkle is not frontmost", () => {
    expect(shouldShowHelper({ enabled: true, sparkleFrontmost: false })).toBe(true);
  });

  it("hides when Sparkle is frontmost", () => {
    expect(shouldShowHelper({ enabled: true, sparkleFrontmost: true })).toBe(false);
  });

  // The dismiss the island got back. `enabled` is a persisted preference again, and it is safe this
  // time because the route back is the native menu bar (View → Hide/Show Helper) — always present,
  // impossible to hide — rather than a sidebar button that could be redesigned away. §6 removed
  // this input when the button went; restoring it is the point of the change.
  it("hides when disabled, even though Sparkle is not frontmost", () => {
    expect(shouldShowHelper({ enabled: false, sparkleFrontmost: false })).toBe(false);
  });

  it("hides when disabled and Sparkle is frontmost", () => {
    expect(shouldShowHelper({ enabled: false, sparkleFrontmost: true })).toBe(false);
  });
});

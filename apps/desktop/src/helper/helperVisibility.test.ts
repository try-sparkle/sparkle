import { describe, it, expect } from "vitest";
import { shouldShowHelper } from "./helperVisibility";

describe("shouldShowHelper", () => {
  it("shows when enabled and Sparkle is not frontmost", () => {
    expect(shouldShowHelper({ enabled: true, sparkleFrontmost: false })).toBe(true);
  });

  it("hides when Sparkle is frontmost", () => {
    expect(shouldShowHelper({ enabled: true, sparkleFrontmost: true })).toBe(false);
  });

  it("hides when disabled, even though Sparkle is not frontmost", () => {
    expect(shouldShowHelper({ enabled: false, sparkleFrontmost: false })).toBe(false);
  });

  it("hides when disabled and Sparkle is frontmost", () => {
    expect(shouldShowHelper({ enabled: false, sparkleFrontmost: true })).toBe(false);
  });
});

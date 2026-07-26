// The overlay ships dark: absent/false env → disabled. Only an explicit opt-in mounts it.
import { describe, expect, it } from "vitest";
import { SPARKLE_OVERLAY_FLAG, sparkleOverlayEnabled } from "./flag";

describe("sparkleOverlayEnabled", () => {
  it("is OFF by default (no env, empty env, explicit false)", () => {
    expect(sparkleOverlayEnabled({})).toBe(false);
    expect(sparkleOverlayEnabled({ [SPARKLE_OVERLAY_FLAG]: undefined })).toBe(false);
    expect(sparkleOverlayEnabled({ [SPARKLE_OVERLAY_FLAG]: "" })).toBe(false);
    expect(sparkleOverlayEnabled({ [SPARKLE_OVERLAY_FLAG]: "false" })).toBe(false);
    expect(sparkleOverlayEnabled({ [SPARKLE_OVERLAY_FLAG]: "0" })).toBe(false);
  });

  it("turns on only for an explicit opt-in", () => {
    expect(sparkleOverlayEnabled({ [SPARKLE_OVERLAY_FLAG]: "1" })).toBe(true);
    expect(sparkleOverlayEnabled({ [SPARKLE_OVERLAY_FLAG]: "true" })).toBe(true);
    expect(sparkleOverlayEnabled({ [SPARKLE_OVERLAY_FLAG]: true })).toBe(true);
  });

  it("reads the real import.meta.env by default (unset in tests → disabled)", () => {
    expect(sparkleOverlayEnabled()).toBe(false);
  });
});

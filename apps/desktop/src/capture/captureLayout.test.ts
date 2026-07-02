// chooseLayout — the capture modal's adaptive layout chooser (spec §3): composer sits BELOW
// landscape shots and RIGHT of portrait shots; the image is downscaled only when it exceeds
// 80% of the screen box, and never upscaled.
import { describe, it, expect } from "vitest";
import { chooseLayout } from "./captureLayout";

describe("chooseLayout", () => {
  it("places the composer below a landscape image", () => {
    const r = chooseLayout(1600, 900, 2560, 1440);
    expect(r.placement).toBe("below");
  });

  it("places the composer to the right of a portrait image", () => {
    const r = chooseLayout(900, 1600, 2560, 1440);
    expect(r.placement).toBe("right");
  });

  it("treats a square image as landscape (below)", () => {
    // Tie-break: only strictly-taller-than-wide counts as portrait.
    const r = chooseLayout(1000, 1000, 2560, 1440);
    expect(r.placement).toBe("below");
  });

  it("downscales an image larger than 80% of the screen box", () => {
    // 80% box of 1920×1080 = 1536×864. 4000×2000 must shrink to fit BOTH axes:
    // min(1536/4000, 864/2000) = 0.384.
    const r = chooseLayout(4000, 2000, 1920, 1080);
    expect(r.imgScale).toBeCloseTo(0.384, 5);
  });

  it("downscales when only one axis overflows the 80% box", () => {
    // Tall portrait: 500×2000 on 1920×1080 → height cap 864/2000 = 0.432 governs.
    const r = chooseLayout(500, 2000, 1920, 1080);
    expect(r.placement).toBe("right");
    expect(r.imgScale).toBeCloseTo(0.432, 5);
  });

  it("never upscales a small image (scale stays 1)", () => {
    const r = chooseLayout(400, 300, 2560, 1440);
    expect(r.imgScale).toBe(1);
  });

  it("leaves an image exactly at the 80% box untouched", () => {
    const r = chooseLayout(1536, 864, 1920, 1080);
    expect(r.imgScale).toBe(1);
  });
});

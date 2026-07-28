import { describe, expect, it } from "vitest";
import {
  describeSpanTarget,
  modesAgree,
  rectsEqual,
  targetRect,
  type DisplayLayout,
  type Rect,
} from "./displaySpan";

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function layout(partial: Partial<DisplayLayout> & { count: number }): DisplayLayout {
  const { count, ...rest } = partial;
  return {
    displays: Array.from({ length: count }, (_, i) => ({
      name: `display-${i}`,
      bounds: rect(0, 0, 1920, 1080),
      work_area: rect(0, 0, 1920, 1055),
      scale_factor: 1,
    })),
    full: null,
    safe: null,
    spanning_enabled: true,
    ...rest,
  };
}

// The three-display setup, in LOGICAL POINTS — the units the backend emits. Same numbers as
// WindowSpanControls.test.tsx: two 1× 1080p externals flanking a 2× Retina built-in whose work area
// is 1512×957 at y 25, so the band all three cover is 5352×957 and the union reaches 5352×1080.
// Pairing a logical width with a pixel height (5352 × 1964) describes hardware that cannot exist.
const SAFE = rect(0, 25, 5352, 957);
const FULL = rect(0, 0, 5352, 1080);

describe("targetRect", () => {
  it("routes each mode to its own rectangle", () => {
    const l = layout({ count: 3, safe: SAFE, full: FULL });
    expect(targetRect(l, "safe")).toEqual(SAFE);
    expect(targetRect(l, "full")).toEqual(FULL);
  });
});

describe("rectsEqual", () => {
  it("requires every field to match", () => {
    expect(rectsEqual(rect(0, 0, 100, 50), rect(0, 0, 100, 50))).toBe(true);
    expect(rectsEqual(rect(0, 0, 100, 50), rect(1, 0, 100, 50))).toBe(false);
    expect(rectsEqual(rect(0, 0, 100, 50), rect(0, 0, 100, 49))).toBe(false);
  });

  it("treats a missing rect as unequal, never as a match", () => {
    // This decides whether the window counts as spanned; a null must never read as "it worked".
    expect(rectsEqual(null, rect(0, 0, 100, 50))).toBe(false);
    expect(rectsEqual(rect(0, 0, 100, 50), null)).toBe(false);
    expect(rectsEqual(null, null)).toBe(false);
  });
});

describe("describeSpanTarget", () => {
  it("reports the count and the dimensions of the selected mode", () => {
    const l = layout({ count: 3, safe: SAFE, full: FULL });
    expect(describeSpanTarget(l, "safe")).toBe("3 displays · 5352 × 957");
    // Switching mode must change the readout, or the control gives no feedback at all.
    expect(describeSpanTarget(l, "full")).toBe("3 displays · 5352 × 1080");
  });

  it("uses the singular for one display", () => {
    const l = layout({ count: 1, safe: rect(0, 0, 1920, 1055), full: rect(0, 0, 1920, 1055) });
    expect(describeSpanTarget(l, "safe")).toBe("1 display · 1920 × 1055");
  });

  it("omits dimensions rather than inventing them when no rect was computed", () => {
    // Rust returns null for both rects when it reports no displays; printing "0 × 0" here would be
    // a claim about geometry we don't have.
    expect(describeSpanTarget(layout({ count: 0 }), "safe")).toBe("0 displays");
  });
});

describe("modesAgree", () => {
  it("is true when the displays tile into a clean rectangle", () => {
    const tidy = layout({ count: 2, safe: rect(0, 0, 3840, 1080), full: rect(0, 0, 3840, 1080) });
    expect(modesAgree(tidy)).toBe(true);
  });

  it("is false when the arrangement is ragged", () => {
    const ragged = layout({ count: 3, safe: SAFE, full: FULL });
    expect(modesAgree(ragged)).toBe(false);
  });

  it("treats a position-only difference as disagreement", () => {
    // Same size, different origin still moves the window, so the modes are not interchangeable.
    const shifted = layout({
      count: 2,
      safe: rect(0, 200, 3840, 1080),
      full: rect(0, 0, 3840, 1080),
    });
    expect(modesAgree(shifted)).toBe(false);
  });

  it("reports agreement when there is nothing to compare", () => {
    expect(modesAgree(layout({ count: 0 }))).toBe(true);
  });
});

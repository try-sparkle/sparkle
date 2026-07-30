import { describe, expect, it } from "vitest";
import { ANCHOR_TOLERANCE_PX, anchoredScrollTop } from "./anchoredScroll";

// A roomy container by default; individual cases override what they are about.
// A container whose visible band is viewport y 0–1000, so the cases above it are about the scroll
// maths rather than the band; the band clamp gets its own describe with a realistic offset band.
const base = {
  rowTop: 0,
  rowHeight: 40,
  anchorY: 300,
  scrollTop: 500,
  maxScroll: 2000,
  containerTop: 0,
  containerHeight: 1000,
};

describe("anchoredScrollTop — the row lands at the cursor", () => {
  it("scrolls DOWN when the row sits below the cursor", () => {
    // Row centre at 800, cursor at 300 → the content must move up by 500.
    expect(anchoredScrollTop({ ...base, rowTop: 780, anchorY: 300 })).toBe(1000);
  });

  it("scrolls UP when the row sits above the cursor", () => {
    // Row centre at 100, cursor at 400 → the content must move down by 300.
    expect(anchoredScrollTop({ ...base, rowTop: 80, anchorY: 400 })).toBe(200);
  });

  it("centres the row on the cursor rather than hanging its top there", () => {
    // rowTop 380, height 40 → centre 400. A cursor at 400 is already exact: no scroll.
    // If this centred on the row's TOP instead, it would want to move by half the row height.
    expect(anchoredScrollTop({ ...base, rowTop: 380, rowHeight: 40, anchorY: 400 })).toBeNull();
  });

  it("uses the click's own Y, so two clicks at different heights land differently", () => {
    const high = anchoredScrollTop({ ...base, rowTop: 780, anchorY: 100 });
    const low = anchoredScrollTop({ ...base, rowTop: 780, anchorY: 700 });
    expect(high).toBe(1200);
    expect(low).toBe(600);
    expect(high).not.toBe(low);
  });
});

describe("anchoredScrollTop — when NOT to move the column", () => {
  it("does not scroll when the row is already at roughly the cursor's height", () => {
    // Off by less than the tolerance: moving every other row to fix this is a bad trade.
    const nearly = ANCHOR_TOLERANCE_PX - 1;
    expect(anchoredScrollTop({ ...base, rowTop: 400 - 20 + nearly, anchorY: 400 })).toBeNull();
  });

  it("DOES scroll once the row is further off than the tolerance", () => {
    const past = ANCHOR_TOLERANCE_PX + 1;
    expect(anchoredScrollTop({ ...base, rowTop: 400 - 20 + past, anchorY: 400 })).toBe(
      base.scrollTop + past,
    );
  });

  it("does not scroll a container that cannot scroll", () => {
    expect(anchoredScrollTop({ ...base, rowTop: 900, maxScroll: 0 })).toBeNull();
  });
});

describe("anchoredScrollTop — clamping at the ends of the list", () => {
  it("clamps to the top rather than overscrolling into negative offset", () => {
    // Wants to move up by far more than the container has above it.
    const t = anchoredScrollTop({ ...base, rowTop: 0, rowHeight: 40, anchorY: 700, scrollTop: 100 });
    expect(t).toBe(0);
  });

  it("clamps to maxScroll rather than overscrolling past the end", () => {
    const t = anchoredScrollTop({
      ...base,
      rowTop: 2000,
      anchorY: 100,
      scrollTop: 1900,
      maxScroll: 2000,
    });
    expect(t).toBe(2000);
  });

  it("returns null at an end that is ALREADY as close as the range allows", () => {
    // A row near the top, a cursor near the bottom, and the container already at offset 0: the
    // desired move is up, the achievable move is nothing. "Get as close as possible" is satisfied.
    expect(
      anchoredScrollTop({ ...base, rowTop: 40, anchorY: 900, scrollTop: 0, maxScroll: 2000 }),
    ).toBeNull();
  });

  it("still moves as far as it can when the range allows PART of the request", () => {
    // Wants to scroll up by 500 but only 120 is available — it takes the 120.
    const t = anchoredScrollTop({ ...base, rowTop: 80, anchorY: 600, scrollTop: 120 });
    expect(t).toBe(0);
  });
});

// ── THE CONTAINER'S VISIBLE BAND ────────────────────────────────────────────────────────────────
// The cursor and the row share a viewport but not a box. `anchorY` is a click in the CONCIERGE
// COLUMN, which starts just under the title bar; the row lives in the builder column's scroll
// container, whose visible band starts lower and ends higher than the window's. Clamping only
// against `[0, maxScroll]` bounds the CONTENT range, not the VISIBLE one — so an anchor outside the
// band would park the row in the container's clipped region: on screen by the arithmetic, invisible
// to the reader, and worse than the `scrollIntoView` it replaced (roborev 56060).
describe("anchoredScrollTop — the anchor is clamped into the container's band", () => {
  // Band 140–740, as the real sidebar list sits under the title bar and above the status strip.
  const band = { containerTop: 140, containerHeight: 600 };

  it("does not scroll a row ABOVE the container's top edge", () => {
    // The reported failure verbatim: a receipt pill clicked at y=70, well above the list's first
    // visible pixel. Honoured literally this returns 1350 and clips the row out of sight.
    const t = anchoredScrollTop({
      ...base,
      ...band,
      rowTop: 400,
      rowHeight: 40,
      anchorY: 70,
      scrollTop: 1000,
      maxScroll: 3000,
    });
    // Clamped to the band's top margin (140 + 20), so the row lands just inside the container.
    expect(t).toBe(1000 + (420 - 160));
    // And the row's resulting viewport centre is inside the band, which is the property that matters.
    const restingCentre = 420 - (t! - 1000);
    expect(restingCentre).toBeGreaterThanOrEqual(band.containerTop);
    expect(restingCentre).toBeLessThanOrEqual(band.containerTop + band.containerHeight);
  });

  it("does not scroll a row BELOW the container's bottom edge", () => {
    const t = anchoredScrollTop({
      ...base,
      ...band,
      rowTop: 400,
      rowHeight: 40,
      anchorY: 2000, // far below the list's last visible pixel
      scrollTop: 1000,
      maxScroll: 3000,
    });
    const restingCentre = 420 - (t! - 1000);
    expect(restingCentre).toBeLessThanOrEqual(band.containerTop + band.containerHeight);
    expect(restingCentre).toBeGreaterThanOrEqual(band.containerTop);
  });

  it("leaves an anchor INSIDE the band exactly where the reader put it", () => {
    // The common case must be untouched by the clamp: 400 is comfortably inside 140–740.
    const t = anchoredScrollTop({ ...base, ...band, rowTop: 900, anchorY: 400, scrollTop: 500 });
    expect(t).toBe(500 + (920 - 400));
  });

  it("falls back to the container's centre when it is shorter than one row", () => {
    // Both margins cannot be satisfied at once; the container's own middle is what a reader would
    // call "in view", and it must not produce a NaN or an inverted clamp.
    const t = anchoredScrollTop({
      ...base,
      containerTop: 100,
      containerHeight: 20,
      rowHeight: 40,
      rowTop: 900,
      anchorY: 5,
      scrollTop: 500,
    });
    expect(t).toBe(500 + (920 - 110));
  });
});

// Presize sizing contract: the bubble locks to its FINAL size before typing starts
// (so nothing reflows under your eyes) and never exceeds the max width. Measurement is
// exercised through a fake element so no layout engine is needed.
import { describe, expect, it } from "vitest";
import {
  lockedSize,
  orbTextMaxWidth,
  orbTextPosition,
  presize,
  type PresizeEl,
} from "./presize";

/** A fake element whose "layout" is text-length-proportional, clamped like CSS max-width. */
function fakeEl(pxPerChar: number, cssMaxWidth: number): PresizeEl & {
  writes: string[];
} {
  const el = {
    style: { display: "none", visibility: "", minWidth: "", minHeight: "" },
    textContent: "" as string | null,
    writes: [] as string[],
    get offsetWidth() {
      const raw = (el.textContent ?? "").length * pxPerChar;
      return Math.min(raw, cssMaxWidth);
    },
    get offsetHeight() {
      // One 20px line per max-width's worth of text — a crude wrap model.
      const raw = (el.textContent ?? "").length * pxPerChar;
      return 20 * Math.max(1, Math.ceil(raw / cssMaxWidth));
    },
  };
  return el;
}

describe("orbTextMaxWidth", () => {
  it("caps at 480px on wide windows and 72vw on narrow ones", () => {
    expect(orbTextMaxWidth(1400)).toBe(480);
    expect(orbTextMaxWidth(500)).toBeCloseTo(360, 9);
  });
});

describe("lockedSize", () => {
  it("clamps the measured width to the max, leaving height alone", () => {
    expect(lockedSize({ width: 900, height: 40 }, 480)).toEqual({
      width: 480,
      height: 40,
    });
    expect(lockedSize({ width: 200, height: 40 }, 480)).toEqual({
      width: 200,
      height: 40,
    });
  });
});

describe("presize", () => {
  it("locks min-width/min-height to the FINAL text size, then empties for typing", () => {
    const el = fakeEl(8, 480);
    const text = "Hey DROdio — I'm listening.";
    const size = presize(el, text, 480);
    // The lock happened…
    expect(el.style.minWidth).toBe(`${size.width}px`);
    expect(el.style.minHeight).toBe(`${size.height}px`);
    expect(size.width).toBe(text.length * 8);
    // …BEFORE any typing: the element is visible-but-empty, ready for characters.
    expect(el.textContent).toBe("");
    expect(el.style.display).toBe("block");
    expect(el.style.visibility).toBe("");
  });

  it("never locks wider than the max width, even for a very long reply", () => {
    const el = fakeEl(8, 480);
    const long = "x".repeat(500); // 4000px unwrapped
    const size = presize(el, long, 480);
    expect(size.width).toBeLessThanOrEqual(480);
    expect(el.style.minWidth).toBe("480px");
    // The wrap model grew height instead — the bubble resizes to the amount of text.
    expect(size.height).toBeGreaterThan(20);
  });

  it("re-clamps defensively when the measurer ignores CSS max-width", () => {
    const el = fakeEl(8, Number.POSITIVE_INFINITY); // no CSS clamp at all
    const size = presize(el, "y".repeat(500), 480);
    expect(size.width).toBe(480);
    expect(el.style.minWidth).toBe("480px");
  });
});

describe("orbTextPosition", () => {
  const viewport = { width: 1000, height: 700 };
  const geomBase = {
    viewport,
    homeBottom: 31,
    orbHeight: 100,
    cardBox: null,
    rowBox: null,
  };

  it("perch: hangs just below the top-bar home", () => {
    expect(orbTextPosition("perch", geomBase)).toEqual({ x: 500, y: 75 });
  });

  it("center: front-and-center, nudged above the midline", () => {
    expect(orbTextPosition("center", geomBase)).toEqual({ x: 500, y: 290 });
  });

  it("card: sits above the card when there's headroom, below when there isn't", () => {
    const low = orbTextPosition("card", {
      ...geomBase,
      cardBox: { left: 400, top: 500, width: 200, height: 90 },
    });
    expect(low).toEqual({ x: 500, y: 500 - 50 - 40 });

    const high = orbTextPosition("card", {
      ...geomBase,
      cardBox: { left: 400, top: 60, width: 200, height: 90 },
    });
    // above = 60 - 50 - 40 = -30 ≤ 90 → flips below the card.
    expect(high).toEqual({ x: 500, y: 60 + 90 + 50 + 40 });
  });

  it("card: clamps x so the bubble stays on-screen", () => {
    const left = orbTextPosition("card", {
      ...geomBase,
      cardBox: { left: 0, top: 400, width: 100, height: 80 },
    });
    expect(left.x).toBe(260);
    const right = orbTextPosition("card", {
      ...geomBase,
      cardBox: { left: 950, top: 400, width: 100, height: 80 },
    });
    expect(right.x).toBe(1000 - 260);
  });

  it("row: centers on the row (the handoff spark target), center-fallback without one", () => {
    expect(
      orbTextPosition("row", {
        ...geomBase,
        rowBox: { left: 10, top: 200, width: 200, height: 36 },
      }),
    ).toEqual({ x: 110, y: 218 });
    expect(orbTextPosition("row", geomBase)).toEqual({ x: 500, y: 290 });
  });
});

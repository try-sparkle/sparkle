import { describe, it, expect } from "vitest";
import {
  clampToScreen, nearerEdge, snapTabToEdge, screenFor, windowSize, hitTestPoint, pillSize,
  usableContentSize, sameSize,
  ISLAND_W, ISLAND_H, TAB_W, TAB_H, MENU_W, MENU_H, ERROR_W, ERROR_H,
} from "./helperGeometry";

// A 1440x900 primary display at the origin, and a second display to its right.
const PRIMARY = { x: 0, y: 0, width: 1440, height: 900 };
const SECOND = { x: 1440, y: 0, width: 1920, height: 1080 };

describe("clampToScreen", () => {
  it("leaves an in-bounds position untouched", () => {
    expect(clampToScreen({ x: 200, y: 300 }, { width: ISLAND_W, height: ISLAND_H }, PRIMARY))
      .toEqual({ x: 200, y: 300 });
  });

  it("pulls a window back when it hangs off the right edge", () => {
    // x=1400 would put the 268-wide island at 1668, well past 1440.
    expect(clampToScreen({ x: 1400, y: 300 }, { width: ISLAND_W, height: ISLAND_H }, PRIMARY))
      .toEqual({ x: 1440 - ISLAND_W, y: 300 });
  });

  it("pulls a window back when it hangs off the bottom edge", () => {
    expect(clampToScreen({ x: 200, y: 890 }, { width: ISLAND_W, height: ISLAND_H }, PRIMARY))
      .toEqual({ x: 200, y: 900 - ISLAND_H });
  });

  it("clamps negative coordinates to the screen origin", () => {
    expect(clampToScreen({ x: -50, y: -20 }, { width: ISLAND_W, height: ISLAND_H }, PRIMARY))
      .toEqual({ x: 0, y: 0 });
  });

  it("respects a non-origin screen (second monitor)", () => {
    expect(clampToScreen({ x: 0, y: 0 }, { width: ISLAND_W, height: ISLAND_H }, SECOND))
      .toEqual({ x: 1440, y: 0 });
  });

  it("never returns a negative coordinate when the window is larger than the screen", () => {
    const tiny = { x: 0, y: 0, width: 100, height: 30 };
    expect(clampToScreen({ x: 50, y: 50 }, { width: ISLAND_W, height: ISLAND_H }, tiny))
      .toEqual({ x: 0, y: 0 });
  });
});

describe("nearerEdge", () => {
  it("picks left when the window centre is in the left half", () => {
    expect(nearerEdge({ x: 100, y: 400 }, { width: TAB_W, height: TAB_H }, PRIMARY)).toBe("left");
  });

  it("picks right when the window centre is in the right half", () => {
    expect(nearerEdge({ x: 1300, y: 400 }, { width: TAB_W, height: TAB_H }, PRIMARY)).toBe("right");
  });

  it("picks right exactly at the midpoint (deterministic tie-break)", () => {
    const x = PRIMARY.width / 2 - TAB_W / 2; // centre lands exactly on 720
    expect(nearerEdge({ x, y: 400 }, { width: TAB_W, height: TAB_H }, PRIMARY)).toBe("right");
  });
});

describe("snapTabToEdge", () => {
  it("snaps a left-half tab flush to the left edge, preserving y", () => {
    expect(snapTabToEdge({ x: 300, y: 412 }, PRIMARY)).toEqual({ x: 0, y: 412, edge: "left" });
  });

  it("snaps a right-half tab flush to the right edge, preserving y", () => {
    expect(snapTabToEdge({ x: 1200, y: 412 }, PRIMARY))
      .toEqual({ x: 1440 - TAB_W, y: 412, edge: "right" });
  });

  it("clamps y so the tab is never partly off the bottom", () => {
    expect(snapTabToEdge({ x: 100, y: 880 }, PRIMARY))
      .toEqual({ x: 0, y: 900 - TAB_H, edge: "left" });
  });

  it("snaps to the correct edge of a non-origin screen", () => {
    expect(snapTabToEdge({ x: 3000, y: 100 }, SECOND))
      .toEqual({ x: 1440 + 1920 - TAB_W, y: 100, edge: "right" });
  });
});

describe("screenFor", () => {
  it("finds the display containing the point", () => {
    expect(screenFor({ x: 2000, y: 500 }, [PRIMARY, SECOND])).toEqual(SECOND);
  });

  it("falls back to the first display when the point is on none (monitor unplugged)", () => {
    expect(screenFor({ x: 9999, y: 9999 }, [PRIMARY, SECOND])).toEqual(PRIMARY);
  });

  it("falls back to a zero rect when there are no displays at all", () => {
    expect(screenFor({ x: 0, y: 0 }, [])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

// A webview composites nothing outside its native window, so an overlay that does not grow the
// window is invisible — that is exactly how "Quit Sparkle" became unclickable inside a 44px-tall
// island, and how the capture-failure notice could never be read.
describe("windowSize", () => {
  const none = { menuOpen: false, hasError: false };

  it("is the bare island when nothing is overlaid", () => {
    expect(windowSize("island", none)).toEqual({ width: ISLAND_W, height: ISLAND_H });
  });

  it("is the bare tab when nothing is overlaid", () => {
    expect(windowSize("tab", none)).toEqual({ width: TAB_W, height: TAB_H });
  });

  it("grows tall enough for the context menu", () => {
    const s = windowSize("island", { menuOpen: true, hasError: false });
    expect(s.height).toBe(ISLAND_H + MENU_H);
    expect(s.height).toBeGreaterThan(ISLAND_H);
  });

  it("widens a 16px tab enough to show the menu at all", () => {
    const s = windowSize("tab", { menuOpen: true, hasError: false });
    expect(s.width).toBe(MENU_W);
    expect(s.height).toBe(TAB_H + MENU_H);
  });

  it("grows for the capture-failure notice, widening even in tab mode", () => {
    // ERROR_W, not the island's own width: the island now HUGS its content, so its width is
    // whatever the chiclets happen to need — which is no longer enough room for a line of prose.
    const s = windowSize("tab", { menuOpen: false, hasError: true });
    expect(s.width).toBe(ERROR_W);
    expect(s.height).toBe(TAB_H + ERROR_H);
  });

  it("stacks both overlays", () => {
    const s = windowSize("island", { menuOpen: true, hasError: true });
    expect(s.height).toBe(ISLAND_H + MENU_H + ERROR_H);
  });
});

// snapTabToEdge must clamp BOTH axes: a degenerate screen (the zero rect screenFor returns for an
// empty display list) would otherwise place the tab at x = -TAB_W, i.e. off-screen.
describe("snapTabToEdge on a degenerate screen", () => {
  it("never returns a negative x", () => {
    const zero = { x: 0, y: 0, width: 0, height: 0 };
    const r = snapTabToEdge({ x: 100, y: 100 }, zero);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });
});

// A display placed left of / above the primary has a NEGATIVE origin; clamping must respect it
// rather than pulling everything to 0.
describe("negative-origin displays", () => {
  const LEFT = { x: -1920, y: -180, width: 1920, height: 1080 };

  it("clamps to the negative origin, not to zero", () => {
    expect(clampToScreen({ x: -5000, y: -5000 }, { width: ISLAND_W, height: ISLAND_H }, LEFT))
      .toEqual({ x: -1920, y: -180 });
  });

  it("snaps a tab to the negative-origin left edge", () => {
    expect(snapTabToEdge({ x: -1900, y: 0 }, LEFT)).toMatchObject({ x: -1920, edge: "left" });
  });

  it("finds a point on the negative-origin display", () => {
    expect(screenFor({ x: -1000, y: 0 }, [LEFT])).toEqual(LEFT);
  });
});

// An overlay inflates the WINDOW but not the tab. Placing the inflated window at
// screenRight - TAB_W pushed most of it (menu included) off-screen — which is how "Quit Sparkle"
// stayed unreachable for a right-docked tab even after the window started growing.
describe("snapTabToEdge with an overlay-inflated window", () => {
  it("keeps a right-docked tab's menu fully on screen", () => {
    const size = windowSize("tab", { menuOpen: true, hasError: false });
    const r = snapTabToEdge({ x: 1400, y: 300 }, PRIMARY, size);
    expect(r.edge).toBe("right");
    expect(r.x + size.width).toBeLessThanOrEqual(PRIMARY.x + PRIMARY.width);
    expect(r.x).toBeGreaterThanOrEqual(PRIMARY.x);
  });

  it("keeps a right-docked tab's error notice fully on screen", () => {
    const size = windowSize("tab", { menuOpen: false, hasError: true });
    const r = snapTabToEdge({ x: 1400, y: 300 }, PRIMARY, size);
    expect(r.x + size.width).toBeLessThanOrEqual(PRIMARY.x + PRIMARY.width);
  });

  it("still snaps a left-docked tab flush to the left edge", () => {
    const size = windowSize("tab", { menuOpen: true, hasError: false });
    const r = snapTabToEdge({ x: 100, y: 300 }, PRIMARY, size);
    expect(r).toMatchObject({ x: PRIMARY.x, edge: "left" });
  });

  it("chooses the edge from the TAB's footprint, so opening a menu cannot flip sides", () => {
    // A tab just right of centre stays on the right even though the inflated window's own centre
    // would fall left of the midpoint.
    const size = windowSize("tab", { menuOpen: true, hasError: false });
    expect(snapTabToEdge({ x: 730, y: 0 }, PRIMARY, size).edge).toBe("right");
  });
});

// The display hit-test has been the source of three separate "the window teleported to the other
// monitor" bugs, always the same way: a persisted coordinate measured with a footprint it was not
// written under. Testing the persisted top-left directly is what makes it footprint-independent.
describe("hitTestPoint", () => {
  const tabOnSecondary = { x: SECOND.x + SECOND.width - TAB_W, y: 400 };

  it("resolves a right-docked tab on the secondary display to that display — as a tab", () => {
    const pt = hitTestPoint(tabOnSecondary, false, pillSize("tab"));
    expect(screenFor(pt, [PRIMARY, SECOND])).toEqual(SECOND);
  });

  it("still resolves it to the secondary display when rendered as an ISLAND", () => {
    // The tab→island expand, and the capture-failure expand: mode changed, the coordinate did not.
    // Measuring from an island-width centre used to push this off every display.
    const pt = hitTestPoint(tabOnSecondary, false, pillSize("island"));
    expect(screenFor(pt, [PRIMARY, SECOND])).toEqual(SECOND);
  });

  it("is footprint-independent for any persisted position", () => {
    expect(hitTestPoint(tabOnSecondary, false, pillSize("island")))
      .toEqual(hitTestPoint(tabOnSecondary, false, pillSize("tab")));
  });

  it("measures a FRESH position from its centre", () => {
    const pt = hitTestPoint({ x: 100, y: 200 }, true, pillSize("island"));
    expect(pt).toEqual({ x: 100 + ISLAND_W / 2, y: 200 + ISLAND_H / 2 });
  });

  it("does not alias the caller's position object", () => {
    const want = { x: 5, y: 6 };
    const pt = hitTestPoint(want, false, pillSize("tab"));
    expect(pt).not.toBe(want);
    expect(pt).toEqual(want);
  });
});

describe("pillSize", () => {
  it("returns the island and tab footprints", () => {
    expect(pillSize("island")).toEqual({ width: ISLAND_W, height: ISLAND_H });
    expect(pillSize("tab")).toEqual({ width: TAB_W, height: TAB_H });
  });

  it("prefers a usable measurement over the fallback constant", () => {
    expect(pillSize("island", { width: 150, height: 30 })).toEqual({ width: 150, height: 30 });
    expect(pillSize("tab", { width: 44, height: 44 })).toEqual({ width: 44, height: 44 });
  });

  it("falls back to the constant when the measurement is unusable", () => {
    expect(pillSize("island", { width: 0, height: 0 })).toEqual({ width: ISLAND_W, height: ISLAND_H });
    expect(pillSize("tab", null)).toEqual({ width: TAB_W, height: TAB_H });
  });
});

// ---- the island must HUG its content (item 1: "that big block of blue space in the middle") ----
//
// The island reserved a fixed 268px and pushed its right-hand controls out with a `flex: 1`
// spacer, so its middle was ~88px of bare C.deepForest (#0f2350 — the navy the founder reads as
// blue). Shrinking the DOM alone would not have fixed it: the island is a real OS window, so the
// same empty space would simply have moved into the window's own background. The measured content
// box is therefore what drives `windowSize`, and these pin that wiring.
describe("usableContentSize", () => {
  it("accepts a real measurement, rounding UP so the last glyph is never clipped", () => {
    expect(usableContentSize({ width: 195.2, height: 37.4 })).toEqual({ width: 196, height: 38 });
  });

  it("rejects a 0x0 box — jsdom and any pre-layout frame report one, and a zero-size window is "
    + "an invisible island", () => {
    expect(usableContentSize({ width: 0, height: 0 })).toBeNull();
    expect(usableContentSize({ width: 120, height: 0 })).toBeNull();
  });

  it("rejects a negative or non-finite box rather than passing it to set_size", () => {
    expect(usableContentSize({ width: -10, height: 20 })).toBeNull();
    expect(usableContentSize({ width: Number.NaN, height: 20 })).toBeNull();
    expect(usableContentSize({ width: Number.POSITIVE_INFINITY, height: 20 })).toBeNull();
  });

  it("rejects nothing at all", () => {
    expect(usableContentSize(null)).toBeNull();
    expect(usableContentSize(undefined)).toBeNull();
  });
});

// The resize is an IPC round-trip on the main thread, so it must fire when the content GENUINELY
// changes (a menu opening, a capture-failure notice) and not on every render or every sub-pixel
// re-layout. Whole-pixel equality is the gate.
describe("sameSize", () => {
  it("is true for an identical box", () => {
    expect(sameSize({ width: 196, height: 38 }, { width: 196, height: 38 })).toBe(true);
  });

  it("is false as soon as either axis moves a whole pixel", () => {
    expect(sameSize({ width: 196, height: 38 }, { width: 197, height: 38 })).toBe(false);
    expect(sameSize({ width: 196, height: 38 }, { width: 196, height: 39 })).toBe(false);
  });
});

describe("windowSize with a measured content box", () => {
  const none = { menuOpen: false, hasError: false };

  it("sizes the window to the measured content, not to the fallback constant", () => {
    expect(windowSize("island", none, { width: 150, height: 30 }))
      .toEqual({ width: 150, height: 30 });
  });

  it("rounds a sub-pixel measurement up", () => {
    expect(windowSize("island", none, { width: 195.2, height: 37.4 }))
      .toEqual({ width: 196, height: 38 });
  });

  it("falls back to the constants for an unusable measurement", () => {
    expect(windowSize("island", none, { width: 0, height: 0 }))
      .toEqual({ width: ISLAND_W, height: ISLAND_H });
    expect(windowSize("tab", none, null)).toEqual({ width: TAB_W, height: TAB_H });
  });

  it("measures the MINIMIZED window too, so a small icon cannot sit in a wide window", () => {
    expect(windowSize("tab", none, { width: 36, height: 36 }))
      .toEqual({ width: 36, height: 36 });
  });

  it("still stacks the overlays on top of a measured island", () => {
    const s = windowSize("island", { menuOpen: true, hasError: true }, { width: 150, height: 30 });
    expect(s.height).toBe(30 + MENU_H + ERROR_H);
    expect(s.width).toBe(Math.max(MENU_W, ERROR_W));
  });

  it("keeps the failure notice readable when the hugged island is narrower than the prose", () => {
    const s = windowSize("island", { menuOpen: false, hasError: true }, { width: 150, height: 30 });
    expect(s.width).toBe(ERROR_W);
    expect(s.width).toBeGreaterThan(150);
  });

  it("never shrinks below the measurement when an overlay's floor is narrower", () => {
    // A wide island (two three-digit counts) with the menu open must not be squeezed to MENU_W.
    const s = windowSize("island", { menuOpen: true, hasError: false }, { width: 240, height: 38 });
    expect(s.width).toBe(240);
  });
});

// ---- the minimized state is the sparkle MARK, not a sliver (item 3: "a flat pancake") ----
describe("the minimized tab is icon-shaped", () => {
  it("is square, so the mark inside it keeps its aspect ratio", () => {
    expect(TAB_W).toBe(TAB_H);
  });

  it("is a real click target rather than a 16px sliver", () => {
    // The old tab was 16x64. Anything that thin has no proportion an icon can live in — the mark
    // had to be squashed to fit, which is exactly what the founder saw.
    expect(TAB_W).toBeGreaterThanOrEqual(28);
  });
});

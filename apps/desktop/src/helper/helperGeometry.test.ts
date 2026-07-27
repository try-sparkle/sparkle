import { describe, it, expect } from "vitest";
import {
  clampToScreen, nearerEdge, snapTabToEdge, screenFor, windowSize, hitTestPoint, pillSize,
  ISLAND_W, ISLAND_H, TAB_W, TAB_H, MENU_W, MENU_H, ERROR_H,
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
    const s = windowSize("tab", { menuOpen: false, hasError: true });
    expect(s.width).toBe(ISLAND_W);
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
});

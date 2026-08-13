// @vitest-environment jsdom
//
// THE MENU STAYS ON SCREEN — the one piece of `RowContextMenu` a rendered test cannot reach.
//
// jsdom has no layout engine: every element measures 0×0 and `getBoundingClientRect` answers all
// zeroes (docs/jsdom-test-caveats.md). A menu whose clamp only ever runs against measured zeroes has
// exactly one branch, forever — so the case that matters, a right click near the right or bottom
// edge, is unreachable from `AgentSidebar.rowContextMenu.test.tsx`. That is why the arithmetic is a
// pure exported function rather than inline at the call site, and why it is tested here.
import { describe, expect, it } from "vitest";
import { clampToViewport } from "./RowContextMenu";

const VIEWPORT = { w: 1000, h: 800 };
const SIZE = { w: 200, h: 120 };

describe("clampToViewport", () => {
  it("leaves a cursor with room to spare exactly where it is", () => {
    // The ordinary case, and the one every jsdom render exercises. If the clamp moved a menu that
    // fits, it would drift away from the pointer on every open.
    expect(clampToViewport({ x: 120, y: 80 }, SIZE, VIEWPORT)).toEqual({ x: 120, y: 80 });
  });

  it("pulls a menu back from the RIGHT edge instead of letting it run off", () => {
    // A right click 20px from the edge: unclamped this draws 180px of the menu — including whichever
    // item you were reaching for — outside the window.
    expect(clampToViewport({ x: 980, y: 80 }, SIZE, VIEWPORT).x).toBe(1000 - 200 - 8);
  });

  it("…and from the BOTTOM edge, which is where a row near the end of a long column is", () => {
    expect(clampToViewport({ x: 120, y: 790 }, SIZE, VIEWPORT).y).toBe(800 - 120 - 8);
  });

  it("keeps a pad at the top-left too — a menu flush against the frame reads as clipped", () => {
    expect(clampToViewport({ x: 0, y: 0 }, SIZE, VIEWPORT)).toEqual({ x: 8, y: 8 });
  });

  it("pins to the top-left rather than off-screen when the viewport cannot hold the menu", () => {
    // THE ORDER OF THE TWO CLAMPS, which is the part that is easy to get backwards. With `min`
    // applied last, a window shorter than the menu yields a NEGATIVE offset — the menu's top edge
    // above the frame — and the items nearest the top become unreachable. `max` last means the worst
    // case is a menu whose BOTTOM is cut off, which still leaves its first items usable.
    const tiny = { w: 100, h: 60 };
    expect(clampToViewport({ x: 50, y: 40 }, SIZE, tiny)).toEqual({ x: 8, y: 8 });
  });
});

import { describe, it, expect } from "vitest";
import { popupPosition } from "./selectionPopupPosition";

const VP = { w: 1000, h: 800 };
const SIZE = { w: 300, h: 360 };

describe("popupPosition", () => {
  it("places the popup just below-right of the cursor when there's room", () => {
    expect(popupPosition({ x: 100, y: 100 }, SIZE, VP)).toEqual({ left: 108, top: 108 });
  });

  it("flips left when the popup would overflow the right edge", () => {
    const { left } = popupPosition({ x: 950, y: 100 }, SIZE, VP);
    // Placed just to the LEFT of the cursor: cursor.x - w - gap = 950 - 300 - 8.
    expect(left).toBe(642);
  });

  it("flips above the cursor when it would overflow the bottom edge", () => {
    const { top } = popupPosition({ x: 100, y: 780 }, SIZE, VP);
    expect(top).toBe(780 - 360 - 8); // placed above the cursor
  });

  it("never positions outside the top-left margin", () => {
    const { left, top } = popupPosition({ x: 0, y: 0 }, SIZE, VP);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
  });
});

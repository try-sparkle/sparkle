// Pure decisions for the project-tab drag: reorder within the strip vs tear the tab out into its
// own satellite window. No DOM, no Tauri — the whole point of extracting this is that the branch
// that decides "this drag left the strip" is testable, since this repo has no E2E harness and a
// real cross-monitor cursor drag cannot be automated here.

import { describe, expect, it } from "vitest";
import { resolveTabDrag, tearOffTopLeft, type TabDragOpts, type TabRect } from "./tabDrag";

// A strip 600 wide starting at x=100 on a screen whose origin is NOT (0,0) — secondary displays
// have non-zero origins in Tauri's global space, and nothing here may assume otherwise.
const STRIP = { x: 100, y: 50, width: 600, height: 36 };

// Three 200-wide tabs filling the strip. Midpoints: a=200, b=400, c=600.
const TABS: TabRect[] = [
  { id: "a", x: 100, width: 200 },
  { id: "b", x: 300, width: 200 },
  { id: "c", x: 500, width: 200 },
];

const OPTS: TabDragOpts = { slop: 3, tearMargin: 40 };

// Centre of tab "a", the press origin for most cases.
const ORIGIN = { x: 200, y: 68 };

const drag = (pointer: { x: number; y: number }, draggedId = "a") =>
  resolveTabDrag({ pointer, origin: ORIGIN, strip: STRIP, tabs: TABS, draggedId }, OPTS);

describe("resolveTabDrag — slop", () => {
  it("is idle until the press moves further than the slop", () => {
    expect(drag({ x: 202, y: 69 }).kind).toBe("idle");
  });

  it("becomes a drag once either axis exceeds the slop", () => {
    expect(drag({ x: 204, y: 68 }).kind).toBe("reorder");
    // Vertical alone counts too — a straight-down tear must not need horizontal movement first.
    expect(drag({ x: 200, y: 200 }).kind).toBe("tearoff");
  });
});

describe("resolveTabDrag — reorder within the strip", () => {
  it("inserts before the tab whose midpoint the pointer has passed", () => {
    // Just past b's left edge but short of b's midpoint (400) — still lands before b.
    expect(drag({ x: 350, y: 68 })).toEqual({ kind: "reorder", beforeId: "b" });
  });

  it("inserts before the next tab once the pointer passes a midpoint", () => {
    expect(drag({ x: 450, y: 68 })).toEqual({ kind: "reorder", beforeId: "c" });
  });

  it("appends when the pointer is past the last midpoint", () => {
    // null means "no tab to insert before" — i.e. the end of the strip.
    expect(drag({ x: 650, y: 68 })).toEqual({ kind: "reorder", beforeId: null });
  });

  it("reports the dragged tab's own slot rather than inventing a move", () => {
    // Dropping a back onto itself. The resolver states what it sees; the store's reorderProject
    // is what treats before === dragged as a no-op, exactly as reorderAgent's caller does.
    expect(drag({ x: 150, y: 68 })).toEqual({ kind: "reorder", beforeId: "a" });
  });

  it("appends when there are no tabs at all", () => {
    const r = resolveTabDrag(
      { pointer: { x: 400, y: 68 }, origin: ORIGIN, strip: STRIP, tabs: [], draggedId: "a" },
      OPTS,
    );
    expect(r).toEqual({ kind: "reorder", beforeId: null });
  });
});

describe("resolveTabDrag — tearing out", () => {
  it("stays a reorder while the pointer is only just outside the strip", () => {
    // Forgiving band: a shaky horizontal drag along the strip must not spawn a window.
    expect(drag({ x: 400, y: 100 }).kind).toBe("reorder"); // 14px below, inside the 40px margin
    expect(drag({ x: 400, y: 20 }).kind).toBe("reorder"); // 30px above
  });

  it("tears out once the pointer clears the strip vertically", () => {
    expect(drag({ x: 400, y: 200 })).toEqual({ kind: "tearoff" });
  });

  it("tears out past either horizontal end of the strip", () => {
    expect(drag({ x: 20, y: 68 })).toEqual({ kind: "tearoff" });
    expect(drag({ x: 900, y: 68 })).toEqual({ kind: "tearoff" });
  });

  it("treats the margin as exclusive at the boundary", () => {
    // Exactly on the inflated edge is still inside — one consistent choice so a drag held at the
    // threshold doesn't flicker between spawning and not spawning a window.
    expect(drag({ x: 400, y: 50 + 36 + 40 }).kind).toBe("reorder");
    expect(drag({ x: 400, y: 50 + 36 + 41 }).kind).toBe("tearoff");
  });
});

describe("tearOffTopLeft", () => {
  it("centres the new window under the cursor", () => {
    expect(tearOffTopLeft({ x: 500, y: 400 }, { width: 900, height: 600 })).toEqual({
      x: 50,
      y: 100,
    });
  });

  it("works in a negative coordinate space (a display left of the primary)", () => {
    // Tauri's global space puts a left-hand secondary monitor at negative x. Centring must not
    // assume the origin is (0,0) — this is the same class of bug helperGeometry documents.
    expect(tearOffTopLeft({ x: -800, y: 300 }, { width: 400, height: 200 })).toEqual({
      x: -1000,
      y: 200,
    });
  });
});

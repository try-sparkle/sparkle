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

const drag = (pointer: { x: number; y: number }, draggedId = "a", dragging = false) =>
  resolveTabDrag({ pointer, origin: ORIGIN, strip: STRIP, tabs: TABS, draggedId, dragging }, OPTS);

describe("resolveTabDrag — slop", () => {
  it("is idle until the press moves further than the slop", () => {
    expect(drag({ x: 202, y: 69 }).kind).toBe("idle");
  });

  it("becomes a drag once either axis exceeds the slop", () => {
    expect(drag({ x: 204, y: 68 }).kind).toBe("reorder");
    // Vertical alone counts too — a straight-down tear must not need horizontal movement first.
    expect(drag({ x: 200, y: 200 }).kind).toBe("tearoff");
  });

  it("stays a drag after it latches, even back at the press point", () => {
    // The gate is spent once `dragging` is set. Re-evaluating it every frame let a drag that
    // wandered back over its own origin collapse to idle mid-gesture: the ghost disappears and the
    // release reads as a plain click on the tab.
    expect(drag({ x: 201, y: 69 }, "a", true).kind).toBe("reorder");
    // And exactly ON the origin, which is the worst case for a re-evaluated gate.
    expect(drag(ORIGIN, "a", true).kind).toBe("reorder");
    // The unlatched gesture at the same points is still idle — the latch is the only difference.
    expect(drag({ x: 201, y: 69 }).kind).toBe("idle");
    expect(drag(ORIGIN).kind).toBe("idle");
  });

  it("still tears off when a latched drag is outside the strip", () => {
    // Latching must not pin the gesture to `reorder` — it only skips the slop gate.
    expect(drag({ x: 400, y: 200 }, "a", true)).toEqual({ kind: "tearoff" });
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
      {
        pointer: { x: 400, y: 68 },
        origin: ORIGIN,
        strip: STRIP,
        tabs: [],
        draggedId: "a",
        dragging: false,
      },
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

// ── THE LEFT PAIR'S STRIP IS PAINTED RIGHT-TO-LEFT ────────────────────────────────────────────
//
// `.ptabstrip[data-side="left"]` sets `flex-direction: row-reverse` so the active tab hugs the
// centre on both sides of the concierge. That makes ARRAY order and SCREEN order disagree, and the
// midpoint scan compares screen x — so without `reversed` a dragged tab lands in the mirror image
// of the slot the user aimed at. The `beforeId` these return is always an ARRAY position, because
// that is what `reorderProject` consumes.
describe("resolveTabDrag — a reversed (left-pair) strip", () => {
  // Same three tabs, same array order [a, b, c], but PAINTED c, b, a from left to right. The rects
  // are what the DOM would actually report under row-reverse.
  const REV_TABS: TabRect[] = [
    { id: "a", x: 500, width: 200 },
    { id: "b", x: 300, width: 200 },
    { id: "c", x: 100, width: 200 },
  ];
  const revDrag = (x: number) =>
    resolveTabDrag(
      {
        pointer: { x, y: 68 },
        origin: { x: 600, y: 68 },
        strip: STRIP,
        tabs: REV_TABS,
        draggedId: "a",
        dragging: true,
        reversed: true,
      },
      OPTS,
    );

  it("appends when dropped at the far LEFT, because visually-first is array-last", () => {
    // The end that is easiest to get backwards: the leftmost pixel of a reversed strip is the END
    // of the array, so this must be an append (null), not "before a".
    expect(revDrag(120)).toEqual({ kind: "reorder", beforeId: null });
  });

  it("inserts before the array-FIRST tab when dropped at the far RIGHT", () => {
    expect(revDrag(690)).toEqual({ kind: "reorder", beforeId: "a" });
  });

  it("maps an interior slot to the array position left of the tab it was dropped before", () => {
    // Between painted c and b (visual slots 1|2) → array-wise that is before c.
    expect(revDrag(250)).toEqual({ kind: "reorder", beforeId: "c" });
    // Between painted b and a → before b.
    expect(revDrag(450)).toEqual({ kind: "reorder", beforeId: "b" });
  });

  it("is the plain left-to-right rule when `reversed` is absent", () => {
    // The default must not disturb the right pair, which is every existing caller.
    expect(drag({ x: 690, y: 68 }, "a", true)).toEqual({ kind: "reorder", beforeId: null });
    expect(drag({ x: 120, y: 68 }, "a", true)).toEqual({ kind: "reorder", beforeId: "a" });
  });
});

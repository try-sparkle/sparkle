// The clamp, and the five-column width budget it has to answer to.
//
// What these pin is the thing the v0.63.0 resize report could not be diagnosed without: a drag that
// lands somewhere other than where it was aimed must say WHICH bound moved it. "It didn't move" is
// two different bugs — clamped, or not applied at all — and they have different fixes.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertPinnedNeedle } from "../testing/pinnedNeedle";
import {
  BUILD_COLUMN_PAINTED_WIDTH,
  BUILD_COLUMN_DEFAULT_WIDTH,
  buildWidthVar,
  BUILD_COLUMN_ROW_RESERVE,
  BUILD_COLUMN_MIN_WIDTH,
  COLUMN_MIN_WIDTH,
  EPICS_COLUMN_DEFAULT_WIDTH,
  EPICS_COLUMN_MIN_WIDTH,
  EPICS_COLUMN_PAINTED_WIDTH,
  EPICS_COLUMN_ROW_RESERVE,
  epicsColumnMax,
  epicsWidthKey,
  epicsWidthVar,
  paintedEpicsWidth,
  readStoredEpicsWidth,
  buildColumnMax,
  buildOverlayKey,
  buildWidthKey,
  LEGACY_BUILD_OVERLAY_KEY,
  readStoredOverlay,
  readStoredConciergeOverlay,
  nextConciergeOverlay,
  CONCIERGE_OVERLAY_KEY,
  RAIL_WIDTH,
  TERMINAL_MIN_WIDTH,
  centreOf,
  clampWidth,
  cockpitGeometry,
  conciergePairedMax,
  conciergePairedReserve,
  paintedBuildWidth,
  overlaidColumnWidth,
  OVERLAY_WIDTH_BOOST,
  OVERLAY_EDGE_RESERVE,
  OVERLAY_MIN_WIDTH,
  readStoredBuildWidth,
  windowAwareMax,
  type CockpitInput,
} from "./columnResize";

describe("clampWidth — the applied width, and why", () => {
  it("honours a request inside the range and reports no clamp", () => {
    expect(clampWidth(400, 280, 560)).toEqual({ requested: 400, applied: 400, clampedBy: null });
  });

  it("names the bound when it stops short of the request", () => {
    // The line the log was missing: requested 600, applied 560, clamped by max.
    expect(clampWidth(600, 280, 560)).toEqual({ requested: 600, applied: 560, clampedBy: "max" });
    expect(clampWidth(100, 280, 560)).toEqual({ requested: 100, applied: 280, clampedBy: "min" });
  });

  it("rounds the request before comparing, so a sub-pixel drag is not a clamp", () => {
    expect(clampWidth(279.6, 280, 560)).toEqual({ requested: 280, applied: 280, clampedBy: null });
  });

  it("reports the exact boundary values as UNCLAMPED", () => {
    // Off-by-one guard: sitting exactly on a bound is a width the user asked for and got.
    expect(clampWidth(280, 280, 560).clampedBy).toBeNull();
    expect(clampWidth(560, 280, 560).clampedBy).toBeNull();
  });

  it("surfaces an impossible range instead of silently inverting it", () => {
    const r = clampWidth(400, 500, 300);
    expect(r.applied).toBe(500);
    expect(r.clampedBy).toBe("min");
  });
});

// ── THE WINDOW IS A BOUND TOO (roborev 55847) ──────────────────────────────────────────────────
//
// A ceiling fixed at author time lets a column be dragged, or RESTORED from storage, wider than the
// window it shares — which puts its own resize handle past the viewport edge with `overflow: hidden`
// and no way back except editing localStorage. These pin the arithmetic that prevents it.
describe("windowAwareMax — a ceiling that knows how big the window is", () => {
  it("returns the hard ceiling when the window can afford it", () => {
    // 2000 - 600 = 1400 available, which is more than the column is ever allowed anyway.
    expect(windowAwareMax(1200, 2000, 600, 160)).toBe(1200);
  });

  it("LOWERS the ceiling when the window cannot, which is the whole point", () => {
    // The case that shipped broken: a 1000px window must not permit 1200.
    expect(windowAwareMax(1200, 1000, 600, 160)).toBe(400);
  });

  it("never returns less than the column's own minimum, so the range cannot invert", () => {
    // A window too narrow to satisfy even the reserve. Answering below `min` would make `clampWidth`
    // see min > max — a degenerate range, which is how a clamp starts returning nonsense.
    expect(windowAwareMax(1200, 500, 600, 160)).toBe(160);
    const degenerate = windowAwareMax(1200, 100, 600, 160);
    expect(degenerate).toBeGreaterThanOrEqual(160);
    expect(clampWidth(800, 160, degenerate).applied).toBe(160);
  });
});

// ── THE CONCIERGE IS THE ANCHOR ────────────────────────────────────────────────────────────────
//
// These assert GEOMETRY — where the five columns actually land — and never a width state variable.
// "The concierge width changed" is a precondition; the thing the founder asked for is that the
// column stays dead centre while it changes, which is a statement about positions.
//
// jsdom cannot answer this from the DOM: it has no layout engine, so `min()`/`calc()` never resolve
// and every `getBoundingClientRect` is zero. `cockpitGeometry` is the layout stated as arithmetic;
// `Workspace.resize.test.tsx` separately pins that the rendered CSS is the wiring this model assumes
// (halves `flex: 1 1 0`, concierge at its var, build at its var). Neither half is sufficient alone.

/** The row at rest on a desktop-width window. Overridden per case.
 *
 *  2560 rather than a laptop 1600 ON PURPOSE: at 1600 each half is only 614px, so the build column's
 *  own clamp (`half - 320` for the terminal) caps it at 294 and a case about moving a builder to
 *  500px would be measuring the CLAMP instead of the gesture. The narrow-window behaviour is
 *  asserted deliberately, in `paintedBuildWidth` below, rather than smuggled into every case. */
function row(over: Partial<CockpitInput> = {}): CockpitInput {
  return {
    windowWidth: 2560,
    pairCount: 2,
    conciergeWidth: 360,
    buildLeftWidth: 220,
    buildRightWidth: 220,
    epicsLeftWidth: EPICS_COLUMN_DEFAULT_WIDTH,
    epicsRightWidth: EPICS_COLUMN_DEFAULT_WIDTH,
    ...over,
  };
}

const widthOf = (g: ReturnType<typeof cockpitGeometry>, key: Parameters<typeof centreOf>[1]) =>
  g.find((c) => c.key === key)!.width;

/** The bound the seam is actually clamped to, at the shared 50px floor — the same call `Workspace`
 *  makes, so a case can never assert a width the app would refuse.
 *
 *  The build widths are no longer arguments: the reserve is the FLOORS, not the live widths, so a
 *  neighbour's width can no longer lower this ceiling. Callers still pass them for readability of the
 *  scenario; they are deliberately ignored here, which is itself the change under test. */
const conciergeCeiling = (windowWidth: number, _buildL?: number, _buildR?: number) =>
  conciergePairedMax(windowWidth, COLUMN_MIN_WIDTH);

describe("cockpitGeometry — the concierge is pinned dead centre", () => {
  it("puts the concierge's centre exactly on the row's centre at rest", () => {
    const g = cockpitGeometry(row());
    expect(centreOf(g, "concierge")).toBe(2560 / 2);
  });

  it("KEEPS it centred across every window width, concierge width and build pair", () => {
    // The property, not a sample: if any of these could drift the layout off-centre, the model is
    // wrong. This is the assertion the old asymmetric row would have failed outright — its right
    // pair was the only `flex: 1`, so the concierge sat wherever the left pair's width put it.
    //
    // SCOPED TO ROWS THE CEILING ACTUALLY PERMITS, and that exclusion is load-bearing rather than a
    // convenience. Centring is a consequence of two halves sharing the free space; once the
    // concierge is wider than the row can seat, there is no free space to share, the halves clamp at
    // zero and the column cannot be centred by anyone. `conciergeCeiling` is precisely the bound
    // that makes that state unreachable — see the case below, which asserts it directly.
    let checked = 0;
    for (const windowWidth of [900, 1280, 1600, 2560, 3840, 5760, 7681]) {
      for (const conciergeWidth of [280, 360, 560, 1100, 1920]) {
        for (const [buildLeftWidth, buildRightWidth] of [
          [220, 220],
          [400, 220],
          [160, 900],
        ]) {
          if (conciergeWidth > conciergeCeiling(windowWidth, buildLeftWidth!, buildRightWidth!)) {
            continue;
          }
          const g = cockpitGeometry(
            row({ windowWidth, conciergeWidth, buildLeftWidth, buildRightWidth }),
          );
          expect(centreOf(g, "concierge")).toBeCloseTo(windowWidth / 2, 9);
          checked += 1;
        }
      }
    }
    // Guard against the skip swallowing the whole grid and leaving a green test that asserted
    // nothing — the vacuous shape this repo keeps re-finding.
    expect(checked).toBeGreaterThan(40);
  });

  it("is centred at EVERY width the ceiling permits, right up to the ceiling itself", () => {
    // The exclusion above is only honest if the boundary case is covered: the widest concierge the
    // row will ever allow must still land dead centre, on a laptop window and on a 3-display span.
    for (const windowWidth of [900, 1280, 5760]) {
      const at = conciergeCeiling(windowWidth, 220, 220);
      const g = cockpitGeometry(row({ windowWidth, conciergeWidth: at }));
      expect(centreOf(g, "concierge")).toBeCloseTo(windowWidth / 2, 9);
      // …and both terminals are still real columns rather than clamped-to-zero slivers, which is
      // what "the row can seat this" means.
      expect(widthOf(g, "terminal-left")).toBeGreaterThan(0);
      expect(widthOf(g, "terminal-right")).toBeGreaterThan(0);
    }
  });

  it("TILES the row exactly at every width the ceiling permits", () => {
    // Nine rects that tile `[0, windowWidth)` is what makes the centring arithmetic meaningful: a
    // model whose columns overlapped could still report a centred concierge.
    //
    // WHAT THIS CAN AND CANNOT CATCH, stated because the distinction was got wrong once. The `x`
    // check restates the model's own running-sum construction, so it is close to free; the load
    // bearing half is `Σwidth === windowWidth`, and the ONLY way that can miss is `half` falling
    // below the build column's floor, where `buildL` pins at 160 while `termL` clamps at 0 and the
    // row over-subscribes. Every row HERE sits at the ceiling, where `half` is at least
    // `max(bl, br) + 320` — so this case cannot reach that regime, and asserting "no overflow" of it
    // would have been a claim it never tests (roborev 56088). The regime has its own case below.
    for (const windowWidth of [900, 1024, 1280, 1600, 2560, 5760]) {
      for (const [bl, br] of [
        [220, 220],
        [400, 220],
        [160, 900],
      ]) {
        const conciergeWidth = conciergeCeiling(windowWidth, bl!, br!);
        const g = cockpitGeometry(row({ windowWidth, conciergeWidth, buildLeftWidth: bl, buildRightWidth: br }));
        let x = 0;
        for (const c of g) {
          expect(c.x).toBeCloseTo(x, 9);
          expect(c.width).toBeGreaterThanOrEqual(0);
          x += c.width;
        }
        expect(x).toBeCloseTo(windowWidth, 9);
      }
    }
  });

  it("lays the seven columns out left to right in the reading order of the cockpit", () => {
    // AN EXACT-SET ASSERTION, and the shape most prone to being WIDENED rather than tightened when
    // a column is added. It is written as one `toEqual` on the whole array precisely so a new member
    // cannot be slipped in without someone reading this line and deciding where it belongs.
    const g = cockpitGeometry(row());
    expect(g.map((c) => c.key)).toEqual([
      "terminal-left",
      "build-left",
      "epics-left",
      "rail-left",
      "concierge",
      "rail-right",
      "epics-right",
      "build-right",
      "terminal-right",
    ]);
  });

  it("puts EPICS INBOARD OF BUILD on BOTH sides, which is the mirror the founder asked for", () => {
    // BOTH PAIRS MOUNTED AT ONCE, deliberately. Asserting one side alone is half the evidence: a
    // rule keyed to the wrong side passes a single-sided check and fails the moment the other pair
    // exists (bead sparkle-foqoe). The claim is a RELATION between four columns, so all four have to
    // be in the row being measured.
    const g = cockpitGeometry(row());
    const x = (k: Parameters<typeof centreOf>[1]) => g.find((c) => c.key === k)!.x;

    // Left pair: outboard→inboard is terminal, build, epics — so epics is the RIGHTMOST of the three.
    expect(x("terminal-left")).toBeLessThan(x("build-left"));
    expect(x("build-left")).toBeLessThan(x("epics-left"));
    expect(x("epics-left")).toBeLessThan(x("concierge"));

    // Right pair mirrors it exactly: epics is the LEFTMOST of the three, nearest the concierge.
    expect(x("concierge")).toBeLessThan(x("epics-right"));
    expect(x("epics-right")).toBeLessThan(x("build-right"));
    expect(x("build-right")).toBeLessThan(x("terminal-right"));

    // …and each epics column is adjacent to its rail, i.e. nothing was inserted between it and the
    // concierge. This is what "between the concierge and the build column" means as a measurement.
    expect(x("epics-left") + widthOf(g, "epics-left")).toBeCloseTo(x("rail-left"), 9);
    expect(x("rail-right") + widthOf(g, "rail-right")).toBeCloseTo(x("epics-right"), 9);
  });
});

describe("cockpitGeometry — what each gesture does", () => {
  // ── EITHER CONCIERGE EDGE, OUT BY dx → CONCIERGE +2·dx, STILL CENTRED, BOTH TERMINALS -dx ──
  //
  // "Make it so that the concierge both sides grow when you pull one side." The drag itself lives in
  // `ColumnPullTab` (`widthPerPx: 2`); what is asserted here is the CONSEQUENCE, which is that the
  // resulting row is symmetric and neither build column moved.
  it("grows the concierge by 2·dx and takes dx from EACH terminal, whichever edge was pulled", () => {
    const dx = 120;
    const before = cockpitGeometry(row());
    const after = cockpitGeometry(row({ conciergeWidth: 360 + 2 * dx }));

    expect(widthOf(after, "concierge")).toBe(360 + 2 * dx);
    expect(centreOf(after, "concierge")).toBe(2560 / 2);
    expect(widthOf(after, "terminal-left")).toBe(widthOf(before, "terminal-left") - dx);
    expect(widthOf(after, "terminal-right")).toBe(widthOf(before, "terminal-right") - dx);
    // The build columns are untouched by a concierge drag — only the terminals give.
    expect(widthOf(after, "build-left")).toBe(widthOf(before, "build-left"));
    expect(widthOf(after, "build-right")).toBe(widthOf(before, "build-right"));
  });

  // ── ONE BUILD COLUMN'S OUTER EDGE → THAT COLUMN AND ITS OWN TERMINAL, AND NOTHING ELSE ──
  //
  // "For the builder agents it should be possible to make them different widths... One doesn't
  // change when the other changes."
  it("widens ONE build column without moving the concierge or touching the other half", () => {
    const before = cockpitGeometry(row());
    const after = cockpitGeometry(row({ buildLeftWidth: 220 + 180 }));

    expect(widthOf(after, "build-left")).toBe(400);
    expect(widthOf(after, "terminal-left")).toBe(widthOf(before, "terminal-left") - 180);
    // The concierge did not move — position AND width.
    expect(centreOf(after, "concierge")).toBe(centreOf(before, "concierge"));
    expect(widthOf(after, "concierge")).toBe(widthOf(before, "concierge"));
    // The far half is byte-identical.
    expect(widthOf(after, "build-right")).toBe(widthOf(before, "build-right"));
    expect(widthOf(after, "terminal-right")).toBe(widthOf(before, "terminal-right"));
  });

  it("keeps the two build columns independent — they need not be equal", () => {
    const g = cockpitGeometry(row({ buildLeftWidth: 500, buildRightWidth: 180 }));
    expect(widthOf(g, "build-left")).toBe(500);
    expect(widthOf(g, "build-right")).toBe(180);
    expect(centreOf(g, "concierge")).toBe(1280);
  });

  // ── THE WINDOW EDGE / SPANNING DISPLAYS → ENTIRELY ON THE TERMINALS ──
  //
  // "When I say span all displays, it would naturally put the concierge in the middle because it
  // would become symmetrical." Not a special case — it falls out of the same two equal halves.
  it("lands window growth on the terminals only, and re-centres the concierge for free", () => {
    const before = cockpitGeometry(row({ windowWidth: 1920 }));
    const after = cockpitGeometry(row({ windowWidth: 5760 }));
    const grew = (5760 - 1920) / 2;

    expect(widthOf(after, "terminal-left")).toBe(widthOf(before, "terminal-left") + grew);
    expect(widthOf(after, "terminal-right")).toBe(widthOf(before, "terminal-right") + grew);
    expect(widthOf(after, "concierge")).toBe(widthOf(before, "concierge"));
    expect(widthOf(after, "build-left")).toBe(widthOf(before, "build-left"));
    expect(widthOf(after, "build-right")).toBe(widthOf(before, "build-right"));
    expect(centreOf(after, "concierge")).toBe(5760 / 2);
  });

  it("does NOT reproduce the bug it replaces — no column absorbs 2.5 displays of a 3-display span", () => {
    // The shipped row was `left pair 640 + concierge 360`, right pair `flex: 1` — so at 5760 the
    // right pair held 5760-640-360-12 = 4748px, "spanning like one and a half displays". Here the
    // two halves are equal by construction, so no single column can run away with the span.
    const g = cockpitGeometry(row({ windowWidth: 5760 }));
    const left = widthOf(g, "terminal-left") + widthOf(g, "build-left");
    const right = widthOf(g, "build-right") + widthOf(g, "terminal-right");
    expect(left).toBe(right);
    expect(Math.max(...g.map((c) => c.width))).toBeLessThan(5760 / 2);
  });
});

// ── THE FOUNDER'S TWO TARGET LAYOUTS, AT A 3×1920 SPAN ─────────────────────────────────────────
//
// (A) concierge + BOTH build columns on the centre monitor;
// (B) concierge filling the whole centre monitor, build columns on the outer ones.
// The old `CONCIERGE_MAX_WIDTH = 560` blocked both by 2–3.5×, which is why the cap had to become
// window-aware. These pin that the geometry actually delivers the layouts, not merely that a bigger
// number is permitted.
describe("the 5760px targets", () => {
  const SPAN = 5760;
  const CENTRE_MONITOR = { from: 1920, to: 3840 };

  it("(A) seats the concierge AND both epics AND both build columns on the centre monitor", () => {
    // THE BUDGET GOT TIGHTER AND THE TARGET DID NOT MOVE. The centre monitor is 1920px and now has
    // to seat FIVE columns rather than three, so the widths below are smaller than they were —
    // 1100 + 2·(180 + 220) = 1900, against 1100 + 2·400 = 1900 before. That is the honest
    // consequence of adding a column and it is stated here rather than absorbed by relaxing the
    // assertion: what the founder asked for is that everything except the terminals fits on the
    // centre display, and that claim now covers four more columns than it used to.
    const g = cockpitGeometry(
      row({
        windowWidth: SPAN,
        conciergeWidth: 1100,
        epicsLeftWidth: 180,
        epicsRightWidth: 180,
        buildLeftWidth: 220,
        buildRightWidth: 220,
      }),
    );
    const leftmost = g.find((c) => c.key === "build-left")!;
    const rightmost = g.find((c) => c.key === "build-right")!;
    expect(leftmost.x).toBeGreaterThanOrEqual(CENTRE_MONITOR.from);
    expect(rightmost.x + rightmost.width).toBeLessThanOrEqual(CENTRE_MONITOR.to);
    expect(centreOf(g, "concierge")).toBe(SPAN / 2);
    // The epics columns are INSIDE the builders, so they are on the centre monitor whenever those
    // are — asserted anyway, because "inside" is the property under test and inferring it from the
    // builders would make this pass for a row that had put epics somewhere else entirely.
    const el = g.find((c) => c.key === "epics-left")!;
    const er = g.find((c) => c.key === "epics-right")!;
    expect(el.x).toBeGreaterThanOrEqual(CENTRE_MONITOR.from);
    expect(er.x + er.width).toBeLessThanOrEqual(CENTRE_MONITOR.to);
    // And the outer monitors are entirely terminal, which is the point of the layout.
    expect(widthOf(g, "terminal-left")).toBeGreaterThanOrEqual(CENTRE_MONITOR.from - 400);
  });

  it("(B) fills the centre monitor with the concierge and puts the builders on the outer ones", () => {
    const g = cockpitGeometry(row({ windowWidth: SPAN, conciergeWidth: 1920 }));
    const c = g.find((col) => col.key === "concierge")!;
    expect(c.x).toBe(CENTRE_MONITOR.from);
    expect(c.x + c.width).toBe(CENTRE_MONITOR.to);
    // Both build columns are off the centre monitor, one per outer display.
    const bl = g.find((col) => col.key === "build-left")!;
    const br = g.find((col) => col.key === "build-right")!;
    expect(bl.x + bl.width).toBeLessThanOrEqual(CENTRE_MONITOR.from);
    expect(br.x).toBeGreaterThanOrEqual(CENTRE_MONITOR.to);
  });

  it("leaves BOTH targets reachable under the window-aware ceiling", () => {
    // The bound the drag is actually clamped to. Every other column at the shared 50px floor plus
    // both rails: 2·50 (build) + 2·50 (epics) + 2·50 (terminal) + 2·6 (rails) = 312, so the span
    // permits 5448 — past both targets, where the old bare 560 permitted neither. The epics pair
    // added 100 to this; the targets clear it by thousands, so they are unaffected.
    const reserve = conciergePairedReserve();
    expect(reserve).toBe(312);
    const ceiling = conciergeCeiling(SPAN);
    expect(ceiling).toBeGreaterThanOrEqual(1100);
    expect(ceiling).toBeGreaterThanOrEqual(1920);
    expect(clampWidth(1920, COLUMN_MIN_WIDTH, ceiling).clampedBy).toBeNull();
    expect(clampWidth(1100, COLUMN_MIN_WIDTH, ceiling).clampedBy).toBeNull();
  });

  it("STAYS draggable on the narrow window that used to freeze it solid", () => {
    // THE REGRESSION THIS EXISTS FOR, taken from a real session: at ~890px the old reserve (600)
    // put the concierge's ceiling AT its 280 floor, so `min === max`, and the log recorded three
    // consecutive drags that moved nothing. The floors alone must leave real travel.
    const ceiling = conciergeCeiling(890);
    expect(ceiling).toBe(890 - 312);
    expect(ceiling).toBeGreaterThan(COLUMN_MIN_WIDTH); // a range, not a point
    // …and a drag inside it is honoured rather than clamped — the thing that was broken.
    //
    // THE PROBE IS DERIVED FROM THE RANGE, not a literal, and that is a correction rather than a
    // tidy-up. It was 600, which sat inside the old 50–678 range and outside the new 50–578 one, so
    // adding the two epics floors turned this case red for a reason that has nothing to do with the
    // regression it guards: the seam still has 528px of travel, which is emphatically not frozen. A
    // literal probe re-tests the arithmetic on the line above it and goes stale every time the row
    // gains a column; a midpoint cannot.
    const inside = Math.round((COLUMN_MIN_WIDTH + ceiling) / 2);
    expect(clampWidth(inside, COLUMN_MIN_WIDTH, ceiling).clampedBy).toBeNull();
    // The travel is REAL, not a pixel — the failure was `min === max`, which a midpoint alone would
    // still satisfy on a one-pixel range.
    expect(ceiling - COLUMN_MIN_WIDTH).toBeGreaterThan(200);
  });

  it("still collapses to the shared floor on a window too narrow to seat anyone", () => {
    // The small-window behaviour must be exactly what it was: an inverted range is how a clamp
    // starts returning nonsense, so the floor wins rather than a negative ceiling.
    const ceiling = conciergeCeiling(180);
    expect(ceiling).toBe(COLUMN_MIN_WIDTH);
    expect(clampWidth(600, COLUMN_MIN_WIDTH, ceiling).applied).toBe(COLUMN_MIN_WIDTH);
  });
});

describe("paintedBuildWidth — the terminal is the only column that gives", () => {
  it("honours the stored width when the half can afford it", () => {
    expect(paintedBuildWidth(400, 1200)).toBe(400);
  });

  it("yields to keep the terminal at its floor before pinning at its own", () => {
    // A half that cannot seat the stored width: the build column gives back exactly enough to leave
    // the terminal its floor. Stated against the constant, not a number chosen for a past value of it.
    expect(paintedBuildWidth(1000, 600)).toBe(600 - TERMINAL_MIN_WIDTH);
  });

  it("never paints below its own floor, even when that costs the terminal everything", () => {
    // Collapse order: terminal to a strip FIRST, then build. A floorless expression went negative
    // here and painted the build column away entirely (roborev 55883). The half has to be tighter
    // than floor+floor for the build column to be the one that pins, so it is derived rather than
    // hardcoded — the previous literals were sized for a 320px terminal floor and stopped biting.
    const tightHalf = BUILD_COLUMN_MIN_WIDTH + TERMINAL_MIN_WIDTH - 20;
    expect(paintedBuildWidth(220, tightHalf)).toBe(BUILD_COLUMN_MIN_WIDTH);

    // The same collapse through the whole row. THE HALF IS DERIVED FROM THREE FLOORS NOW, not two —
    // a half sized against `BUILD + TERMINAL` alone is narrower than the epics floor plus those two,
    // so every column pins and the terminal clamps to a vacuous 0 instead of taking the remainder.
    // That would have made the last assertion below pass for the wrong reason forever.
    const rowTightHalf =
      EPICS_COLUMN_MIN_WIDTH + BUILD_COLUMN_MIN_WIDTH + TERMINAL_MIN_WIDTH - 20;
    const conciergeWidth = 280;
    const windowWidth = 2 * rowTightHalf + conciergeWidth + 2 * RAIL_WIDTH;
    const g = cockpitGeometry(row({ windowWidth, conciergeWidth }));
    expect(widthOf(g, "build-left")).toBe(BUILD_COLUMN_MIN_WIDTH);
    // The epics column pins at ITS floor in the same breath — it is resolved first, so if it did not
    // pin here it would have eaten the shortfall and the build column would never reach its own.
    expect(widthOf(g, "epics-left")).toBe(EPICS_COLUMN_MIN_WIDTH);
    // THIS USED TO ASSERT `terminal-left >= 0`, WHICH WAS VACUOUS: the value is literally
    // `Math.max(0, …)`, so it was true before the function existed and would survive any change to
    // it (roborev 56070). The real invariant is that the terminal takes exactly what the two columns
    // inboard of it left, which is what "the terminal absorbs the shortfall" actually means.
    expect(widthOf(g, "terminal-left")).toBe(
      rowTightHalf - EPICS_COLUMN_MIN_WIDTH - BUILD_COLUMN_MIN_WIDTH,
    );
  });
});

// ── THE PRECONDITION, MADE VISIBLE ───────────────────────────────────────────────────────────
//
// `cockpitGeometry` documents that the caller passes a width already lowered to the live ceiling,
// and it is not clamped internally ON PURPOSE: the sole caller (`Workspace`) passes
// `renderedConciergeWidth`, and a silent internal clamp would hide a caller bug in the one module
// whose whole job is to make layout failures visible rather than smooth them over.
//
// That decision is only defensible if the out-of-range behaviour is KNOWN rather than merely
// untested — otherwise the declined finding is covered by nothing (roborev 56088). So this pins what
// the model actually does when the precondition is violated, and the tell a caller can look for.
describe("a concierge wider than the row can seat — the caller's bug, made loud", () => {
  it("over-subscribes the row rather than silently re-centring, and the total says so", () => {
    // A concierge so wide the halves cannot even seat the build column's floor, so the terminal is
    // squeezed to nothing. Derived from the floor rather than a literal sized for the old constants.
    const conciergeWidth = 280;
    const windowWidth = conciergeWidth + 2 * RAIL_WIDTH + 2 * (BUILD_COLUMN_MIN_WIDTH - 4);
    const g = cockpitGeometry(row({ windowWidth, conciergeWidth }));
    expect(widthOf(g, "build-left")).toBe(BUILD_COLUMN_MIN_WIDTH);
    expect(widthOf(g, "terminal-left")).toBe(0);
    // THE TELL: the columns no longer tile the row. A caller that failed to clamp can detect it with
    // exactly this sum, which is why the model is left honest instead of quietly absorbing it.
    const total = g.reduce((n, c) => n + c.width, 0);
    expect(total).toBeGreaterThan(windowWidth);
    // …and the concierge is NOT centred in that state, which is the point: centring is a consequence
    // of the halves having free space to share, not a property the model can assert unconditionally.
    expect(centreOf(g, "concierge")).not.toBeCloseTo(windowWidth / 2, 9);
  });

  it("is unreachable through the ceiling, which is what makes the above a caller bug and not a mode", () => {
    // The bound the app actually clamps to never permits it: at the ceiling the halves always seat
    // both builders and both terminal floors.
    for (const windowWidth of [600, 900, 1280, 2560, 5760]) {
      const at = conciergeCeiling(windowWidth, 220, 220);
      const g = cockpitGeometry(row({ windowWidth, conciergeWidth: at }));
      const total = g.reduce((n, c) => n + c.width, 0);
      // At 600 the ceiling floors at the concierge's own 280 minimum and the row is genuinely too
      // small — the one window where clamping cannot save it, and `tauri.conf.json` forbids it
      // (minWidth 900). Above that, the ceiling always tiles.
      if (windowWidth >= 900) expect(total).toBeCloseTo(windowWidth, 9);
    }
  });
});

describe("single-pair rows are left exactly as they were", () => {
  it("keeps the concierge at the row's LEFT with one rail, not centred", () => {
    const g = cockpitGeometry(row({ pairCount: 1 }));
    expect(g.map((c) => c.key)).toEqual([
      "concierge",
      "rail-right",
      "epics-right",
      "build-right",
      "terminal-right",
    ]);
    expect(g[0]!.x).toBe(0);
    expect(centreOf(g, "concierge")).toBe(180);
    expect(centreOf(g, "concierge")).not.toBe(2560 / 2);
  });

  it("gives the sole pair everything the concierge and its one rail do not take", () => {
    // THREE COLUMNS IN THE PAIR NOW, and summing all three is what keeps this a TILING assertion
    // rather than a width check. Dropping the epics term would leave a row that still adds up on
    // screen while this test reported a 280px hole in it.
    const g = cockpitGeometry(row({ pairCount: 1 }));
    expect(
      widthOf(g, "epics-right") + widthOf(g, "build-right") + widthOf(g, "terminal-right"),
    ).toBe(2560 - 360 - RAIL_WIDTH);
  });
});


// ── A NEIGHBOUR'S WIDTH NO LONGER NARROWS THIS COLUMN ─────────────────────────────────────────
//
// The reserve used to be `2 × max(buildLeft, buildRight)` so that both builders could always paint
// at their stored widths (roborev 56070). That guarantee is now delivered a different way — by paint
// clamping plus stored-width preservation — because the old one made widening ONE column silently
// un-widen another, which is the founder's "nothing should block the other columns".
describe("conciergePairedReserve — the floors, not the neighbours", () => {
  it("is the same number no matter how wide the builders are", () => {
    // THE ASSERTION THAT WOULD HAVE FAILED BEFORE: the reserve is constant, so a builder the user
    // widened cannot lower the concierge's ceiling by even one pixel.
    expect(conciergePairedReserve()).toBe(
      2 * BUILD_COLUMN_MIN_WIDTH +
        2 * EPICS_COLUMN_MIN_WIDTH +
        2 * TERMINAL_MIN_WIDTH +
        2 * RAIL_WIDTH,
    );
    // THE LITERAL IS THE POINT, alongside the formula above: re-spelling the formula alone would
    // pass for a reserve that had silently dropped a column pair, since the test would drop the
    // same term. 312 = 6 floors of 50 plus 2 rails of 6.
    expect(conciergePairedReserve()).toBe(312);
    for (const w of [1600, 2560, 3840]) {
      expect(conciergeCeiling(w)).toBe(w - 312);
    }
  });

  it("SQUEEZES a wide builder's paint instead of refusing the drag — and the preference survives", () => {
    // The replacement guarantee, and the reason the old one is safe to drop. At the ceiling the
    // halves are only 50px wider than the floors, so a 900px builder cannot paint at 900 — it paints
    // at its floor. What matters is that nothing REWROTE 900: `cockpitGeometry` is a pure function of
    // the STORED width, so narrowing the concierge again restores it.
    // 3840 RATHER THAN 2560, and the reason is the epics column rather than a taste for round
    // numbers: a half now seats THREE columns, so at 2560 a 900px builder can no longer paint in
    // full even with the concierge back at its default — which would make the spring-back half of
    // this case assert a width the row cannot seat, and it would fail for a reason that has nothing
    // to do with anything being written back. The squeeze half still bites at 3840, because the
    // ceiling leaves each half only 150px.
    const windowWidth = 3840;
    const stored = 900;
    const at = conciergeCeiling(windowWidth);
    const squeezed = cockpitGeometry(
      row({ windowWidth, conciergeWidth: at, buildLeftWidth: stored, buildRightWidth: stored }),
    );
    expect(widthOf(squeezed, "build-left")).toBe(BUILD_COLUMN_MIN_WIDTH);

    // …and the SAME stored width paints in full once the concierge yields the room back. This is the
    // spring-back, asserted rather than assumed — if the squeeze had been written back, this fails.
    const restored = cockpitGeometry(
      row({ windowWidth, conciergeWidth: 360, buildLeftWidth: stored, buildRightWidth: stored }),
    );
    expect(widthOf(restored, "build-left")).toBe(stored);
  });

  it("keeps every column at or above the shared 50px floor at the ceiling", () => {
    // The budget's other half: the floors are what the reserve is made of, so they must actually hold.
    const windowWidth = 3840;
    const g = cockpitGeometry(
      row({
        windowWidth,
        conciergeWidth: conciergeCeiling(windowWidth),
        buildLeftWidth: 900,
        buildRightWidth: 160,
      }),
    );
    for (const key of [
      "terminal-left",
      "build-left",
      "epics-left",
      "epics-right",
      "build-right",
      "terminal-right",
    ] as const) {
      expect(widthOf(g, key)).toBeGreaterThanOrEqual(COLUMN_MIN_WIDTH);
    }
  });
});

// ── THE STORED BUILD WIDTH ────────────────────────────────────────────────────────────────────
//
// `AgentSidebar`'s width state is seeded from this, and it is the only caller. It used to feed the
// concierge's reserve as well — a wrong answer moved that ceiling — but the reserve is the shared
// floors now, so what these pin is the seed itself. It had no direct coverage when it was introduced.
describe("readStoredBuildWidth", () => {
  beforeEach(() => localStorage.clear());

  it("reads the PER-SIDE key, so the two builders are independent", () => {
    localStorage.setItem(buildWidthKey("left"), "500");
    localStorage.setItem(buildWidthKey("right"), "300");
    expect(readStoredBuildWidth("left", 2560)).toBe(500);
    expect(readStoredBuildWidth("right", 2560)).toBe(300);
  });

  it("SEEDS both sides from the pre-split key, so an existing width survives", () => {
    localStorage.setItem("sparkle-sidebar-width", "480");
    expect(readStoredBuildWidth("left", 2560)).toBe(480);
    expect(readStoredBuildWidth("right", 2560)).toBe(480);
  });

  it("prefers the per-side key over the legacy one once it exists", () => {
    localStorage.setItem("sparkle-sidebar-width", "480");
    localStorage.setItem(buildWidthKey("left"), "260");
    expect(readStoredBuildWidth("left", 2560)).toBe(260);
  });

  it("DISCARDS a width the window cannot show rather than clamping it into state", () => {
    // Clamping would put the reduced number where the next drag persists it, destroying a preference
    // set on a bigger display. Reading never writes, so the stored 1100 is still there afterwards.
    localStorage.setItem(buildWidthKey("left"), "1100");
    // A window that genuinely cannot show 1100 — derived, since the reserve shrank with the floors.
    const tooNarrow = 1100 + BUILD_COLUMN_ROW_RESERVE - 100;
    expect(buildColumnMax(tooNarrow)).toBeLessThan(1100);
    expect(readStoredBuildWidth("left", tooNarrow)).toBe(BUILD_COLUMN_DEFAULT_WIDTH);
    expect(localStorage.getItem(buildWidthKey("left"))).toBe("1100");
  });

  it("clamps the DEFAULT to the live ceiling on a window too narrow for it", () => {
    // On a window whose ceiling is the build column's own floor, the value returned here is the
    // floor rather than the raw default. Scoped to the SEED: the state is deliberately not
    // reconciled afterwards, so this says nothing about `data-width` later in the column's life.
    // Derived from the reserve so it keeps biting as the floors move.
    const pinned = BUILD_COLUMN_ROW_RESERVE + BUILD_COLUMN_MIN_WIDTH - 10;
    expect(buildColumnMax(pinned)).toBe(BUILD_COLUMN_MIN_WIDTH);
    expect(readStoredBuildWidth("left", pinned)).toBe(BUILD_COLUMN_MIN_WIDTH);
  });

  it("falls back to the default when nothing is stored, and when the value is junk", () => {
    expect(readStoredBuildWidth("left", 2560)).toBe(BUILD_COLUMN_DEFAULT_WIDTH);
    localStorage.setItem(buildWidthKey("left"), "not-a-number");
    expect(readStoredBuildWidth("left", 2560)).toBe(BUILD_COLUMN_DEFAULT_WIDTH);
    localStorage.setItem(buildWidthKey("left"), "12");
    expect(readStoredBuildWidth("left", 2560)).toBe(BUILD_COLUMN_DEFAULT_WIDTH);
  });

  it("survives storage being unavailable outright rather than throwing a render", () => {
    // `globalThis`, not `window`: this suite is the pure-engine one and runs in the node
    // environment, where there is no `window` at all.
    const orig = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });
    try {
      expect(readStoredBuildWidth("left", 2560)).toBe(BUILD_COLUMN_DEFAULT_WIDTH);
    } finally {
      if (orig) Object.defineProperty(globalThis, "localStorage", orig);
    }
  });
});

describe("overlaidColumnWidth — an overlay that is not wider than the dock is a no-op", () => {
  // THE REGRESSION THIS PINS. The overlay was `max(280px, min(480px, 100%))` — an absolute cap — so
  // a column already docked at 480 or wider popped out at the SAME width, in the same place, while
  // its spacer held the full docked slot so nothing beside it moved. Nothing observable changed, and
  // it was reported as the control doing nothing. Six tests covered overlay mode at the time and not
  // one of them could fail, because they pinned the clamp STRING — green whether the column was
  // 220px or 900px before the click. This is the assertion that was missing.
  const ROOMY = 4000;

  it("is STRICTLY wider than the docked width at every width, which is the whole point", () => {
    for (const docked of [50, 120, 220, 279, 280, 400, 479, 480, 481, 700, 1200, 2000]) {
      expect(overlaidColumnWidth(docked, ROOMY)).toBeGreaterThan(docked);
    }
  });

  it("NEVER returns less than the dock, including where the edge reserve binds", () => {
    // THE HOLE IN THE LAW ABOVE (roborev 65324): every width it checks is against ROOMY, where the
    // reserve can never bind, so it could not see the band where the rule went the other way. The
    // dock is clamped to `container - TERMINAL_MIN_WIDTH` (50) while the overlay ceiling is
    // `container - OVERLAY_EDGE_RESERVE` (120), so a column dragged into the last 120px popped out
    // NARROWER than it was docked — up to 70px of visible shrink, with the spacer still holding the
    // full slot. Sweeping the whole reachable range is what makes this fail before the fix.
    for (const container of [400, 700, 1000, 1600]) {
      for (let docked = COLUMN_MIN_WIDTH; docked <= container - TERMINAL_MIN_WIDTH; docked += 10) {
        expect(overlaidColumnWidth(docked, container)).toBeGreaterThanOrEqual(docked);
      }
    }
  });

  it("grows while there is room, and merely stops growing once there is not", () => {
    // The two sides of the band, named. At 700/1000 the reserve binds but still leaves growth;
    // at 900/1000 it has nothing left to give, so the honest answer is the dock itself — a no-op,
    // which is the correct behaviour when the terminal beside it is already down to 50px, and is
    // strictly better than the shrink it replaces.
    expect(overlaidColumnWidth(700, 1000)).toBe(1000 - OVERLAY_EDGE_RESERVE);
    expect(overlaidColumnWidth(700, 1000)).toBeGreaterThan(700);
    expect(overlaidColumnWidth(900, 1000)).toBe(900);
  });

  it("would have FAILED against the old fixed 480px cap", () => {
    // The exact shape of the bug, stated as a test: at and above the old cap the old rule returned
    // the cap itself, so the column got no wider — and past it, narrower.
    const oldRule = (_docked: number, container: number) => Math.max(280, Math.min(480, container));
    expect(oldRule(480, ROOMY)).toBe(480); // same width  → invisible
    expect(oldRule(700, ROOMY)).toBe(480); // NARROWER     → worse than invisible
    expect(overlaidColumnWidth(480, ROOMY)).toBe(480 + OVERLAY_WIDTH_BOOST);
    expect(overlaidColumnWidth(700, ROOMY)).toBe(700 + OVERLAY_WIDTH_BOOST);
  });

  it("adds exactly the boost while there is room for it", () => {
    expect(overlaidColumnWidth(220, ROOMY)).toBe(220 + OVERLAY_WIDTH_BOOST);
    expect(overlaidColumnWidth(1200, ROOMY)).toBe(1200 + OVERLAY_WIDTH_BOOST);
  });

  it("leaves the pane underneath peeking out rather than reaching the far edge", () => {
    const container = 1000;
    // A column docked wide enough that the boost would overrun the container — but NOT so wide that
    // the reserve would drag the result under the dock. This case used to be written at 900, which
    // pinned `880 < 900`: the defect itself, encoded as the expectation, with a perfect grip on it.
    expect(overlaidColumnWidth(700, container)).toBe(container - OVERLAY_EDGE_RESERVE);
    expect(overlaidColumnWidth(700, container)).toBeLessThan(container);
  });

  it("floors at a usable panel on a container too narrow to honour the reserve", () => {
    // The floor is outermost, exactly as it was in the expression this replaces: on a container
    // this small a sliver would be worse than an overhang.
    expect(overlaidColumnWidth(50, 200)).toBe(OVERLAY_MIN_WIDTH);
    expect(overlaidColumnWidth(50, OVERLAY_MIN_WIDTH + OVERLAY_EDGE_RESERVE)).toBe(OVERLAY_MIN_WIDTH);
  });
});

// ── ONE CLAMP, TWO CONSUMERS ───────────────────────────────────────────────────────────────────
// `BUILD_COLUMN_PAINTED_WIDTH` exists so the Plan board overlay does not hand-build a SECOND copy
// of the expression AgentSidebar already uses to size the build column. Its own doc comment claims
// this file pins the two together — this is that pin, so the claim is not merely a comment.
//
// The overlay is `inset: 0` over `.paircols` and must inset its header to the Build column's edge,
// which on a `row-reverse` (left) pair is a whole column-width in from the right. If AgentSidebar
// re-tunes its clamp and this expression does not follow, the toggle silently stops landing on the
// Build header's x — a drift no render test can see, because jsdom never lays out.
describe("BUILD_COLUMN_PAINTED_WIDTH is the same clamp AgentSidebar paints with", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../components/AgentSidebar.tsx", import.meta.url)),
    "utf8",
  );

  // ── WHAT THIS PIN DOES AND DOES NOT CLAIM (roborev 65327) ──────────────────────────────────
  // It pins the clamp's SHAPE, not a full equality, and the difference matters. The comparison
  // substitutes two of AgentSidebar's terms — `${MIN_WIDTH}` and `${width}` — with the constants
  // this helper uses, which are exactly the two terms that could diverge. So the substitution is
  // assumption, not evidence, and it is separated out below rather than left implied by a title
  // that said "matches ... side for side".
  //
  // The fallback term is the live one to watch. AgentSidebar uses its `width` STATE as the var
  // fallback while this helper uses the 220 default, so on the very first paint — before the
  // effect publishes `--build-<side>-w` — a sidebar restored to a stored 400 paints at 400 while
  // an overlay reading the fallback insets by 220. That is a real, if brief, misalignment on the
  // mirrored pair; it is recorded here rather than hidden by the substitution, and tracked as its
  // own bead rather than fixed inside a test.
  /** AgentSidebar's raw `SPACER_WIDTH` template, or a hard failure naming what to re-point.
   *  ONE extraction: the second copy of this regex dropped the guard, so a renamed constant failed
   *  with `toContain` on `undefined` instead of a message anyone could act on. */
  const spacerTemplate = (): string => {
    const m = /const SPACER_WIDTH = `([^`]+)`/.exec(src)?.[1];
    expect(m, "AgentSidebar no longer declares SPACER_WIDTH — re-point this pin").toBeTruthy();
    return m!;
  };

  it("matches AgentSidebar's SPACER_WIDTH clamp SHAPE, side for side", () => {
    // AgentSidebar builds it from template literals against `pairSide`, so reconstruct what that
    // produces for each side and require this helper to be character-identical to it.
    const spacer = spacerTemplate();
    for (const side of ["left", "right"] as const) {
      const expanded = spacer!
        .replace("${MIN_WIDTH}", String(BUILD_COLUMN_MIN_WIDTH))
        .replace("${buildWidthVar(pairSide)}", buildWidthVar(side))
        .replace("${width}", String(BUILD_COLUMN_DEFAULT_WIDTH))
        .replace("${TERMINAL_MIN_WIDTH}", String(TERMINAL_MIN_WIDTH));
      expect(BUILD_COLUMN_PAINTED_WIDTH(side)).toBe(expanded);
    }
  });

  // The two substituted terms, asserted directly instead of assumed. Without these the pin above
  // would pass over a genuine divergence: re-point AgentSidebar's `MIN_WIDTH` alias at some other
  // constant and the shape compare still succeeds, because the test supplied the answer.
  it("AgentSidebar's MIN_WIDTH alias really is BUILD_COLUMN_MIN_WIDTH", () => {
    assertPinnedNeedle(src, "const MIN_WIDTH = BUILD_COLUMN_MIN_WIDTH;", "AgentSidebar.tsx");
  });

  it("AgentSidebar's var fallback is its live width state, which this helper approximates", () => {
    // `${width}px` — the live state, NOT a constant. Pinned so that if AgentSidebar ever switches
    // its fallback to the shared default, this test goes red and the note above can be deleted
    // along with the divergence it describes.
    expect(spacerTemplate()).toContain("${width}px");
    // THE FALLBACK SLOT, not the substring (roborev 65414). `toContain` on the bare constant is
    // satisfied wherever it appears — move the default into the `max()` floor and out of the
    // `var()` fallback and the helper has diverged from what this test's own title claims, while
    // the assertion still passes. Matching `var(<name>, <default>)` is what pins the ROLE.
    expect(BUILD_COLUMN_PAINTED_WIDTH("left")).toContain(
      `var(${buildWidthVar("left")}, ${BUILD_COLUMN_DEFAULT_WIDTH}px)`,
    );
  });

  // Cheap guards on the parts the string compare above would still accept if BOTH sides changed
  // together — the var must be the one for the side asked for, never the other pair's.
  it("pairs each side's var with its own side", () => {
    expect(BUILD_COLUMN_PAINTED_WIDTH("left")).toContain(buildWidthVar("left"));
    expect(BUILD_COLUMN_PAINTED_WIDTH("left")).not.toContain(buildWidthVar("right"));
    expect(BUILD_COLUMN_PAINTED_WIDTH("right")).toContain(buildWidthVar("right"));
    expect(BUILD_COLUMN_PAINTED_WIDTH("right")).not.toContain(buildWidthVar("left"));
  });
});

// ── THE EPICS COLUMN ───────────────────────────────────────────────────────────────────────────
//
// The founder asked for epics as "a full column, just like the Build column is a full column …
// its own draggable seam and yes, mirrored left and right exactly". These pin the arithmetic half
// of that claim; `Workspace.epicsColumn.test.tsx` pins the render half. Neither is sufficient
// alone — jsdom has no layout engine, so the DOM cannot answer where a column lands, and this
// module cannot answer whether anything mounts.

describe("epicsWidthKey / epicsWidthVar — per-side storage, never shared", () => {
  it("gives each side its OWN key and var", () => {
    // The two epics columns are independent: widening one must not move the other. Sharing a key
    // is how "mirrored exactly" gets misread as "the same number", which is the opposite of what
    // the build column beside it does.
    expect(epicsWidthKey("left")).not.toBe(epicsWidthKey("right"));
    expect(epicsWidthVar("left")).not.toBe(epicsWidthVar("right"));
  });

  it("does not collide with the build column's keys or vars", () => {
    for (const side of ["left", "right"] as const) {
      expect(epicsWidthKey(side)).not.toBe(buildWidthKey(side));
      expect(epicsWidthVar(side)).not.toBe(buildWidthVar(side));
    }
  });
});

describe("readStoredEpicsWidth — a brand-new key with no migration behind it", () => {
  beforeEach(() => localStorage.clear());

  it("falls to the default on the FIRST LAUNCH after upgrade, never to zero", () => {
    // THE WHOLE SAFETY ARGUMENT FOR ADDING A BARE KEY, asserted rather than reasoned about in a
    // comment. Widths here have no store, no version and no migration: an upgrading install simply
    // has no such key. `getItem` returns `null` and `Number(null)` is `0` — NOT `NaN` — so the
    // danger is not a crash, it is a column that paints at zero width and reads as "the feature
    // did not ship". The `>=` comparison is what refuses it.
    expect(localStorage.getItem(epicsWidthKey("left"))).toBeNull();
    expect(readStoredEpicsWidth("left", 2560)).toBe(EPICS_COLUMN_DEFAULT_WIDTH);
    expect(readStoredEpicsWidth("right", 2560)).toBe(EPICS_COLUMN_DEFAULT_WIDTH);
  });

  it("honours a width inside the range", () => {
    localStorage.setItem(epicsWidthKey("right"), "440");
    expect(readStoredEpicsWidth("right", 2560)).toBe(440);
  });

  it("reads each side from its OWN key", () => {
    localStorage.setItem(epicsWidthKey("left"), "500");
    localStorage.setItem(epicsWidthKey("right"), "320");
    expect(readStoredEpicsWidth("left", 2560)).toBe(500);
    expect(readStoredEpicsWidth("right", 2560)).toBe(320);
  });

  it("DISCARDS a width saved on a bigger display rather than clamping it", () => {
    // Reading never writes. Clamping would put the reduced number into state, and the first drag
    // after that would persist it — destroying a preference set on a bigger display. Same rule,
    // and the same reason, as readStoredBuildWidth.
    localStorage.setItem(epicsWidthKey("right"), "5000");
    const narrow = 1000;
    expect(readStoredEpicsWidth("right", narrow)).not.toBe(5000);
    expect(readStoredEpicsWidth("right", narrow)).toBe(
      Math.min(EPICS_COLUMN_DEFAULT_WIDTH, epicsColumnMax(narrow)),
    );
    // …and the stored value is untouched, which is the half that makes it a preference.
    expect(localStorage.getItem(epicsWidthKey("right"))).toBe("5000");
  });

  it("refuses a non-numeric or below-floor value", () => {
    for (const bad of ["", "wide", "0", "-40", String(EPICS_COLUMN_MIN_WIDTH - 1)]) {
      localStorage.setItem(epicsWidthKey("left"), bad);
      expect(readStoredEpicsWidth("left", 2560)).toBe(EPICS_COLUMN_DEFAULT_WIDTH);
    }
  });
});

describe("paintedEpicsWidth — the collapse order, and who yields first", () => {
  it("paints the stored width while the half can seat all three columns", () => {
    expect(paintedEpicsWidth(280, 1200)).toBe(280);
    expect(paintedEpicsWidth(600, 1200)).toBe(600);
  });

  it("leaves BOTH neighbours their floor rather than swallowing one whole", () => {
    // The bug this rules out: an epics column dragged so wide that the build column beside it has
    // no room at all. `paintedBuildWidth`'s reserve is one terminal; this one's is a terminal AND
    // a build column, because epics has a neighbour on each side.
    const half = 400;
    const painted = paintedEpicsWidth(9999, half);
    expect(painted).toBe(half - BUILD_COLUMN_MIN_WIDTH - TERMINAL_MIN_WIDTH);
    expect(half - painted).toBeGreaterThanOrEqual(BUILD_COLUMN_MIN_WIDTH + TERMINAL_MIN_WIDTH);
  });

  it("never goes below the shared 50px floor", () => {
    expect(paintedEpicsWidth(10, 1200)).toBe(EPICS_COLUMN_MIN_WIDTH);
    expect(paintedEpicsWidth(280, 60)).toBe(EPICS_COLUMN_MIN_WIDTH);
  });

  it("makes EPICS the LAST of the three to give anything up", () => {
    // The founder asked for a full column, and the observable meaning of that is which column
    // disappears first as the window narrows. Terminal yields to a strip, then build pins at its
    // floor, and only then does epics start losing pixels. Asserted as a sequence over one shrinking
    // row rather than at a single width, because the CLAIM is about the order.
    const stored = { epics: 300, build: 300 };
    const wide = cockpitGeometry(
      row({ windowWidth: 2560, epicsRightWidth: stored.epics, buildRightWidth: stored.build }),
    );
    expect(widthOf(wide, "epics-right")).toBe(stored.epics);
    expect(widthOf(wide, "build-right")).toBe(stored.build);
    expect(widthOf(wide, "terminal-right")).toBeGreaterThan(TERMINAL_MIN_WIDTH);

    // Narrow it until the half can no longer seat all three at their stored widths. The terminal is
    // the one that has shrunk; epics still has every pixel it was given.
    const squeezed = cockpitGeometry(
      row({ windowWidth: 1400, epicsRightWidth: stored.epics, buildRightWidth: stored.build }),
    );
    expect(widthOf(squeezed, "epics-right")).toBe(stored.epics);
    expect(widthOf(squeezed, "terminal-right")).toBeLessThan(widthOf(wide, "terminal-right"));
  });

  it("SPRINGS BACK — the squeeze is paint, never a write to the stored width", () => {
    const stored = 700;
    const squeezed = cockpitGeometry(row({ windowWidth: 1400, epicsRightWidth: stored }));
    expect(widthOf(squeezed, "epics-right")).toBeLessThan(stored);
    const restored = cockpitGeometry(row({ windowWidth: 3840, epicsRightWidth: stored }));
    expect(widthOf(restored, "epics-right")).toBe(stored);
  });
});

describe("conciergePairedReserve counts the epics floors", () => {
  it("reserves room for BOTH epics columns", () => {
    // WITHOUT THIS the concierge is draggable straight over both epics columns until they vanish —
    // the exact failure the reserve exists to prevent, and one no render test can see. Asserted as
    // the arithmetic rather than a magic number so the sum names its own terms.
    expect(conciergePairedReserve()).toBe(
      2 * BUILD_COLUMN_MIN_WIDTH +
        2 * EPICS_COLUMN_MIN_WIDTH +
        2 * TERMINAL_MIN_WIDTH +
        2 * RAIL_WIDTH,
    );
  });

  it("leaves both epics columns at or above their floor at the concierge's CEILING", () => {
    // The side effect, not the precondition: drag the concierge as wide as the row will allow and
    // the epics columns must still be real columns. This is what the reserve BUYS, and it fails if
    // the reserve is written without the epics terms even though the sum above would still pass a
    // test that re-spelled the old formula.
    for (const windowWidth of [900, 1280, 2560, 5760]) {
      const g = cockpitGeometry(
        row({ windowWidth, conciergeWidth: conciergePairedMax(windowWidth, COLUMN_MIN_WIDTH) }),
      );
      expect(widthOf(g, "epics-left")).toBeGreaterThanOrEqual(EPICS_COLUMN_MIN_WIDTH);
      expect(widthOf(g, "epics-right")).toBeGreaterThanOrEqual(EPICS_COLUMN_MIN_WIDTH);
    }
  });
});

describe("epicsColumnMax — the window is what stops the drag", () => {
  it("reserves the concierge, the build column, one terminal and both rails", () => {
    expect(EPICS_COLUMN_ROW_RESERVE).toBe(
      COLUMN_MIN_WIDTH + BUILD_COLUMN_MIN_WIDTH + TERMINAL_MIN_WIDTH + 2 * RAIL_WIDTH,
    );
    // ONE MORE TERM THAN THE BUILD COLUMN'S, and that term is the build column itself — epics has a
    // neighbour outboard of it and build does not.
    expect(EPICS_COLUMN_ROW_RESERVE).toBeGreaterThan(BUILD_COLUMN_ROW_RESERVE);
  });

  it("keeps the seam inside the window at every width", () => {
    for (const windowWidth of [900, 1280, 2560, 5760]) {
      expect(epicsColumnMax(windowWidth)).toBeLessThanOrEqual(
        windowWidth - EPICS_COLUMN_ROW_RESERVE,
      );
      expect(epicsColumnMax(windowWidth)).toBeGreaterThanOrEqual(EPICS_COLUMN_MIN_WIDTH);
    }
  });

  it("never returns below the floor even on a window too small to honour the reserve", () => {
    expect(epicsColumnMax(100)).toBe(EPICS_COLUMN_MIN_WIDTH);
  });
});

describe("EPICS_COLUMN_PAINTED_WIDTH — one clamp, shared with the component", () => {
  it("pairs each side's var with its own side", () => {
    expect(EPICS_COLUMN_PAINTED_WIDTH("left")).toContain(epicsWidthVar("left"));
    expect(EPICS_COLUMN_PAINTED_WIDTH("left")).not.toContain(epicsWidthVar("right"));
    expect(EPICS_COLUMN_PAINTED_WIDTH("right")).toContain(epicsWidthVar("right"));
    expect(EPICS_COLUMN_PAINTED_WIDTH("right")).not.toContain(epicsWidthVar("left"));
  });

  it("reserves the same two floors the arithmetic form does", () => {
    // The CSS and the model must agree or the column paints at a width the row did not budget for.
    expect(EPICS_COLUMN_PAINTED_WIDTH("right")).toContain(
      `calc(100% - ${BUILD_COLUMN_MIN_WIDTH + TERMINAL_MIN_WIDTH}px)`,
    );
    expect(EPICS_COLUMN_PAINTED_WIDTH("right")).toContain(`max(${EPICS_COLUMN_MIN_WIDTH}px`);
  });
});

describe("buildOverlayKey — per side AND per window", () => {
  beforeEach(() => localStorage.clear());

  it("gives the two build columns different keys", () => {
    // The half that shipped: one bare key made overlaying either column float the other on the
    // next launch.
    expect(buildOverlayKey("left")).not.toBe(buildOverlayKey("right"));
  });

  it("gives the SATELLITE its own key, even though it forces side 'right'", () => {
    // THE HALF THE SIDE-ONLY SPLIT MISSED. `SATELLITE_PAIR_SIDE` is "right", so a key built from the
    // side alone hands the satellite the cockpit's right-builder string — same origin, same
    // localStorage, same latent-until-relaunch coupling the split was made to end. A window that is
    // one column needs no side of its own, so the scope replaces it rather than extending it.
    expect(buildOverlayKey("right", true)).not.toBe(buildOverlayKey("right"));
    expect(buildOverlayKey("right", true)).toBe(buildOverlayKey("left", true));
  });

  it("seeds each scope from the pre-split key, and never writes it back", () => {
    localStorage.setItem(LEGACY_BUILD_OVERLAY_KEY, "1");
    expect(readStoredOverlay("left")).toBe(true);
    expect(readStoredOverlay("right")).toBe(true);
    expect(readStoredOverlay("right", true)).toBe(true);
    // Reading never writes: the scopes still have no opinion of their own, so the first toggle of
    // any one of them diverges from this common ancestor instead of dragging the others with it.
    expect(localStorage.getItem(buildOverlayKey("left"))).toBeNull();
    expect(localStorage.getItem(buildOverlayKey("right"))).toBeNull();
    expect(localStorage.getItem(buildOverlayKey("right", true))).toBeNull();
  });

  it("prefers a scope's OWN value over the shared ancestor, in both directions", () => {
    localStorage.setItem(LEGACY_BUILD_OVERLAY_KEY, "1");
    localStorage.setItem(buildOverlayKey("right"), "0");
    localStorage.setItem(buildOverlayKey("right", true), "0");
    // The main window's right column and the satellite each override the ancestor independently...
    expect(readStoredOverlay("right")).toBe(false);
    expect(readStoredOverlay("right", true)).toBe(false);
    // ...while the side that never spoke still inherits it. Divergence is the whole point of the
    // split; asserting only the override direction would pass on a key that ignored the ancestor.
    expect(readStoredOverlay("left")).toBe(true);

    localStorage.removeItem(LEGACY_BUILD_OVERLAY_KEY);
    localStorage.setItem(buildOverlayKey("left"), "1");
    expect(readStoredOverlay("left")).toBe(true);
    expect(readStoredOverlay("right")).toBe(false);
  });
});

describe("the concierge overlay is a DIRECTION — the OUTBOARD rule for a middle column", () => {
  beforeEach(() => localStorage.clear());

  it("reads back the side that was stored", () => {
    localStorage.setItem(CONCIERGE_OVERLAY_KEY, "left");
    expect(readStoredConciergeOverlay()).toBe("left");
    localStorage.setItem(CONCIERGE_OVERLAY_KEY, "right");
    expect(readStoredConciergeOverlay()).toBe("right");
  });

  it("reads anything unrecognised as DOCKED, not as overlaid", () => {
    // The value is a free string in a store the user can edit and an older build can have written.
    // A truthiness test would read "1" — what the BUILD column writes — as a direction, so a shared
    // origin would dock-flip this column on the first launch after an upgrade. Absent, empty,
    // legacy and garbage must all mean the same thing: docked.
    for (const bad of ["1", "0", "", "true", "up", "LEFT"]) {
      localStorage.setItem(CONCIERGE_OVERLAY_KEY, bad);
      expect(readStoredConciergeOverlay()).toBeNull();
    }
    localStorage.removeItem(CONCIERGE_OVERLAY_KEY);
    expect(readStoredConciergeOverlay()).toBeNull();
  });

  it("toggles OFF when you click the seam it is already overlaid toward", () => {
    expect(nextConciergeOverlay("left", "left")).toBeNull();
    expect(nextConciergeOverlay("right", "right")).toBeNull();
  });

  it("MOVES to the other side in one click, rather than docking first", () => {
    // "I want it over there" is one intention. Docking first would make the far seam a two-click
    // control while the near one stays single-click — the inconsistency this bead exists to remove.
    expect(nextConciergeOverlay("left", "right")).toBe("right");
    expect(nextConciergeOverlay("right", "left")).toBe("left");
  });

  it("overlays outward from the docked state on either seam", () => {
    expect(nextConciergeOverlay(null, "left")).toBe("left");
    expect(nextConciergeOverlay(null, "right")).toBe("right");
  });

  it("can never be overlaid BOTH ways at once", () => {
    // The reason the state is one nullable direction and not two booleans: "left and right at the
    // same time" is not a wider column, it is two conflicting positions for one element. The type
    // makes it unrepresentable; this pins that no input produces it.
    const reachable = new Set(
      (["left", "right", null] as const).flatMap((cur) =>
        (["left", "right"] as const).map((seam) => String(nextConciergeOverlay(cur, seam))),
      ),
    );
    expect([...reachable].sort()).toEqual(["left", "null", "right"]);
  });
});

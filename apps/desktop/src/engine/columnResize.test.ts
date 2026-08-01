// The clamp, and the five-column width budget it has to answer to.
//
// What these pin is the thing the v0.63.0 resize report could not be diagnosed without: a drag that
// lands somewhere other than where it was aimed must say WHICH bound moved it. "It didn't move" is
// two different bugs — clamped, or not applied at all — and they have different fixes.
import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILD_COLUMN_DEFAULT_WIDTH,
  BUILD_COLUMN_ROW_RESERVE,
  BUILD_COLUMN_MIN_WIDTH,
  COLUMN_MIN_WIDTH,
  buildColumnMax,
  buildWidthKey,
  RAIL_WIDTH,
  TERMINAL_MIN_WIDTH,
  centreOf,
  clampWidth,
  cockpitGeometry,
  conciergePairedMax,
  conciergePairedReserve,
  paintedBuildWidth,
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
    // Seven rects that tile `[0, windowWidth)` is what makes the centring arithmetic meaningful: a
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

  it("lays the five columns out left to right in the reading order of the cockpit", () => {
    const g = cockpitGeometry(row());
    expect(g.map((c) => c.key)).toEqual([
      "terminal-left",
      "build-left",
      "rail-left",
      "concierge",
      "rail-right",
      "build-right",
      "terminal-right",
    ]);
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

  it("(A) seats the concierge AND both build columns on the centre monitor", () => {
    const g = cockpitGeometry(row({ windowWidth: SPAN, conciergeWidth: 1100, buildLeftWidth: 400, buildRightWidth: 400 }));
    const leftmost = g.find((c) => c.key === "build-left")!;
    const rightmost = g.find((c) => c.key === "build-right")!;
    expect(leftmost.x).toBeGreaterThanOrEqual(CENTRE_MONITOR.from);
    expect(rightmost.x + rightmost.width).toBeLessThanOrEqual(CENTRE_MONITOR.to);
    expect(centreOf(g, "concierge")).toBe(SPAN / 2);
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
    // both rails: 2·50 + 2·50 + 2·6 = 212, so the span permits 5548 — past both targets, where the
    // old bare 560 permitted neither.
    const reserve = conciergePairedReserve();
    expect(reserve).toBe(212);
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
    expect(ceiling).toBe(890 - 212);
    expect(ceiling).toBeGreaterThan(COLUMN_MIN_WIDTH); // a range, not a point
    // …and a drag inside it is honoured rather than clamped — the thing that was broken.
    expect(clampWidth(600, COLUMN_MIN_WIDTH, ceiling).clampedBy).toBeNull();
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

    // The same collapse through the whole row. Window chosen so each half lands under that bound.
    const conciergeWidth = 280;
    const windowWidth = 2 * tightHalf + conciergeWidth + 2 * RAIL_WIDTH;
    const g = cockpitGeometry(row({ windowWidth, conciergeWidth }));
    expect(widthOf(g, "build-left")).toBe(BUILD_COLUMN_MIN_WIDTH);
    // THIS USED TO ASSERT `terminal-left >= 0`, WHICH WAS VACUOUS: the value is literally
    // `Math.max(0, …)`, so it was true before the function existed and would survive any change to
    // it (roborev 56070). The real invariant is that the terminal takes exactly what the build
    // column left, which is what "the terminal absorbs the shortfall" actually means.
    expect(widthOf(g, "terminal-left")).toBe(tightHalf - BUILD_COLUMN_MIN_WIDTH);
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
      "build-right",
      "terminal-right",
    ]);
    expect(g[0]!.x).toBe(0);
    expect(centreOf(g, "concierge")).toBe(180);
    expect(centreOf(g, "concierge")).not.toBe(2560 / 2);
  });

  it("gives the sole pair everything the concierge and its one rail do not take", () => {
    const g = cockpitGeometry(row({ pairCount: 1 }));
    expect(widthOf(g, "build-right") + widthOf(g, "terminal-right")).toBe(2560 - 360 - RAIL_WIDTH);
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
      2 * BUILD_COLUMN_MIN_WIDTH + 2 * TERMINAL_MIN_WIDTH + 2 * RAIL_WIDTH,
    );
    expect(conciergePairedReserve()).toBe(212);
    for (const w of [1600, 2560, 3840]) {
      expect(conciergeCeiling(w)).toBe(w - 212);
    }
  });

  it("SQUEEZES a wide builder's paint instead of refusing the drag — and the preference survives", () => {
    // The replacement guarantee, and the reason the old one is safe to drop. At the ceiling the
    // halves are only 50px wider than the floors, so a 900px builder cannot paint at 900 — it paints
    // at its floor. What matters is that nothing REWROTE 900: `cockpitGeometry` is a pure function of
    // the STORED width, so narrowing the concierge again restores it.
    const windowWidth = 2560;
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
    for (const key of ["terminal-left", "build-left", "build-right", "terminal-right"] as const) {
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

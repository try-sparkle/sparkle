// @vitest-environment jsdom
//
// JSDOM, UNUSUALLY FOR AN `engine/` TEST — the rest of this folder runs under node on purpose, and
// `columnResize`'s header explains why that matters (a pure decision must not drag a React tree in
// behind it). The exception is narrow and real: `classifyZoomColumn` takes an `Element` and walks
// it, so the thing under test IS the DOM traversal. Only `closest`/`getAttribute` are exercised —
// no layout, no measurement — so this is not the class of assertion `jsdom-cannot-verify-CSS`
// warns about. Everything else in this file is pure and would pass under node unchanged.
//
// The classifier's contract, asserted on its OUTPUT rather than on the DOM it was handed.
//
// The assertions that matter here are the REFUSALS. A zoom that lands in the wrong column is worse
// than one that does not fire (the founder's requirement 4), so "unresolvable → null" is the
// property under test, not an edge case appended to it.

import { describe, expect, it } from "vitest";
import {
  ZOOM_COLUMNS,
  ZOOM_COLUMN_ATTR,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  classifyZoomColumn,
  clampZoom,
  isZoomColumn,
  steppedZoom,
  zoomColumnFor,
} from "./columnZoom";

/** Build a column root with `depth` nested children and return the innermost, so the test presses
 *  something realistically deep rather than the marked element itself. */
function nest(column: string, depth: number): Element {
  const root = document.createElement("div");
  root.setAttribute(ZOOM_COLUMN_ATTR, column);
  let el: HTMLElement = root;
  for (let i = 0; i < depth; i++) {
    const child = document.createElement("button");
    el.appendChild(child);
    el = child;
  }
  document.body.appendChild(root);
  return el;
}

describe("classifyZoomColumn", () => {
  it("resolves each of the seven cockpit columns from a deeply nested descendant", () => {
    // The whole point of the feature: seven regions, told apart from one another. Asserted for every
    // key rather than one representative, because the failure this guards is a LEFT press resolving
    // to the RIGHT column, which only shows up when both are checked.
    for (const key of [
      "terminal-left",
      "build-left",
      "epics-left",
      "concierge",
      "epics-right",
      "build-right",
      "terminal-right",
    ]) {
      expect(classifyZoomColumn(nest(key, 6))).toBe(key);
    }
  });

  it("resolves the marked element itself, not only its descendants", () => {
    expect(classifyZoomColumn(nest("concierge", 0))).toBe("concierge");
  });

  it("picks the NEAREST column when one is nested inside another", () => {
    // Not a hypothetical: the concierge box sits inside the shell row, and any future wrapper that
    // carried a marker would make the outer one win under a naive `querySelector` implementation.
    const outer = document.createElement("div");
    outer.setAttribute(ZOOM_COLUMN_ATTR, "concierge");
    const inner = document.createElement("div");
    inner.setAttribute(ZOOM_COLUMN_ATTR, "build-left");
    const leaf = document.createElement("span");
    inner.appendChild(leaf);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    expect(classifyZoomColumn(leaf)).toBe("build-left");
  });

  // ── THE REFUSALS ────────────────────────────────────────────────────────────────────────────
  it("refuses an element in no column", () => {
    const orphan = document.createElement("div");
    document.body.appendChild(orphan);
    expect(classifyZoomColumn(orphan)).toBeNull();
  });

  it("refuses null and undefined — the hands-free / just-launched case", () => {
    expect(classifyZoomColumn(null)).toBeNull();
    expect(classifyZoomColumn(undefined)).toBeNull();
  });

  it("refuses an UNRECOGNISED marker rather than trusting the DOM", () => {
    // A stale or typo'd attribute must not resolve to a neighbouring column. This is the assertion
    // that makes `isZoomColumn` load-bearing instead of decorative.
    expect(classifyZoomColumn(nest("build-middle", 2))).toBeNull();
    expect(classifyZoomColumn(nest("", 2))).toBeNull();
    expect(classifyZoomColumn(nest("rail-left", 2))).toBeNull();
  });

  it("refuses an object with no usable closest() instead of throwing", () => {
    // `document.activeElement` can hand back exotic nodes; this runs inside a keydown handler where
    // a throw is a broken app.
    expect(classifyZoomColumn({} as unknown as Element)).toBeNull();
    const thrower = { closest: () => { throw new Error("boom"); } } as unknown as Element;
    expect(classifyZoomColumn(thrower)).toBeNull();
  });
});

describe("zoomColumnFor", () => {
  it("maps a pane's own two facts onto the column keys the classifier returns", () => {
    // Asserts the two spellings AGREE — the render sites use this, the classifier returns those.
    expect(zoomColumnFor("terminal", "left")).toBe("terminal-left");
    expect(zoomColumnFor("terminal", "right")).toBe("terminal-right");
    expect(zoomColumnFor("build", "left")).toBe("build-left");
    expect(zoomColumnFor("build", "right")).toBe("build-right");
    for (const kind of ["terminal", "build", "epics"] as const) {
      for (const side of ["left", "right"] as const) {
        expect(ZOOM_COLUMNS).toContain(zoomColumnFor(kind, side));
      }
    }
  });
});

describe("isZoomColumn", () => {
  it("accepts every declared column and rejects everything else", () => {
    for (const key of ZOOM_COLUMNS) expect(isZoomColumn(key)).toBe(true);
    // NAMED POSITIVES, not just `ZOOM_COLUMNS` above — that loop is satisfied by whatever the union
    // happens to contain, so it cannot notice a member going missing. These two are spelled out
    // because the `satisfies readonly ColumnKey[]` bridge in the source breaks on a RENAME and NOT
    // on a deletion-plus-addition, so dropping an epics column would compile and leave `Cmd +/-`
    // silently inert inside it.
    expect(isZoomColumn("epics-left")).toBe(true);
    expect(isZoomColumn("epics-right")).toBe(true);
    for (const bad of ["rail-left", "rail-right", "", "TERMINAL-LEFT", null, undefined, 3, {}]) {
      expect(isZoomColumn(bad)).toBe(false);
    }
  });
});

describe("clampZoom", () => {
  it("holds the range at both ends", () => {
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(-99)).toBe(ZOOM_MIN);
    expect(clampZoom(1.2)).toBe(1.2);
  });

  it("returns the DEFAULT for a non-finite value rather than propagating it", () => {
    // NaN fails both clamp comparisons silently, so without this it reaches xterm's fontSize and
    // blanks a terminal — persisted, so on every later launch too.
    expect(clampZoom(NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(Infinity)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(-Infinity)).toBe(ZOOM_DEFAULT);
  });

  it("rounds to 2dp so repeated steps do not drift into float noise", () => {
    expect(clampZoom(0.7000000000000001)).toBe(0.7);
    expect(clampZoom(1.2000000000000002)).toBe(1.2);
  });
});

describe("steppedZoom", () => {
  it("steps by exactly ZOOM_STEP in each direction", () => {
    expect(steppedZoom(1.0, 1)).toBe(clampZoom(1.0 + ZOOM_STEP));
    expect(steppedZoom(1.0, -1)).toBe(clampZoom(1.0 - ZOOM_STEP));
  });

  it("reaches the ceiling EXACTLY after repeated adds — the float-drift regression", () => {
    // The reason clampZoom rounds. Walk the whole range one step at a time and assert the endpoint
    // is the constant, not 1.7999999999999998: an inexact ceiling makes every `=== ZOOM_MAX` check
    // in the app quietly false and persists a noisy number forever.
    let z = ZOOM_DEFAULT;
    for (let i = 0; i < 50; i++) z = steppedZoom(z, 1);
    expect(z).toBe(ZOOM_MAX);
    for (let i = 0; i < 50; i++) z = steppedZoom(z, -1);
    expect(z).toBe(ZOOM_MIN);
  });

  it("repairs a corrupt current value before stepping from it", () => {
    expect(steppedZoom(NaN, 1)).toBe(clampZoom(ZOOM_DEFAULT + ZOOM_STEP));
  });
});

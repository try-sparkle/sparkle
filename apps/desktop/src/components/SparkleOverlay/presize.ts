// Orb-text sizing + placement — pure and testable. The design rule (PRD §2.4): text
// lives INSIDE the sparkle, the bubble resizes to the text, and the box locks to its
// FINAL size before typing starts so nothing reflows under your eyes while characters
// land. presize() is that lock; orbTextPosition() is where the bubble sits per anchor.

import type { Anchor } from "./state";
import type { Point, Rect } from "./engine";

export interface Size {
  width: number;
  height: number;
}

/** The bubble never grows past this: min(480px, 72% of the viewport width). */
export function orbTextMaxWidth(viewportWidth: number): number {
  return Math.min(480, viewportWidth * 0.72);
}

/**
 * Clamp a measured text box to the max width. In the live DOM the CSS max-width does
 * this clamp during measurement; this pure twin exists so the invariant — locked width
 * never exceeds the max — is enforced and testable without a layout engine.
 */
export function lockedSize(measured: Size, maxWidth: number): Size {
  return {
    width: Math.min(measured.width, maxWidth),
    height: measured.height,
  };
}

/** The minimal element surface presize needs — a real HTMLElement satisfies it structurally. */
export interface PresizeEl {
  style: {
    display: string;
    visibility: string;
    minWidth: string;
    minHeight: string;
  };
  textContent: string | null;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
}

/**
 * Lock the element at its FINAL size before typing starts: render the full text
 * invisibly, measure, pin min-width/min-height to that measurement, then empty it.
 * The box grows exactly once; every subsequent character lands in place. Returns the
 * locked size (already clamped by the element's own max-width during measurement;
 * `maxWidth` re-clamps defensively for measurers that ignore CSS).
 */
export function presize(el: PresizeEl, text: string, maxWidth: number): Size {
  el.style.display = "block";
  el.style.visibility = "hidden";
  el.textContent = text;
  const size = lockedSize(
    { width: el.offsetWidth, height: el.offsetHeight },
    maxWidth,
  );
  el.style.minWidth = `${size.width}px`;
  el.style.minHeight = `${size.height}px`;
  el.textContent = "";
  el.style.visibility = "";
  return size;
}

export interface OrbPlacementGeom {
  viewport: Size;
  /** Bottom edge of the galaxy home slot (perch placement hangs just below it). */
  homeBottom: number;
  /** The bubble's own height — needed to pick above vs. below a card. */
  orbHeight: number;
  cardBox: Rect | null;
  rowBox: Rect | null;
}

/**
 * Where the bubble's CENTER sits for each anchor (the element is translated -50%,-50%):
 *  • perch — under the top bar, so what you say prints just below the galaxy;
 *  • center — front-and-center, nudged above the midline;
 *  • card — above the card when there's headroom, else below, x clamped on-screen;
 *  • row — the row's center (the collapse-into-a-spark handoff target).
 */
export function orbTextPosition(anchor: Anchor, geom: OrbPlacementGeom): Point {
  const W = geom.viewport.width;
  const H = geom.viewport.height;
  if (anchor === "perch") return { x: W / 2, y: geom.homeBottom + 44 };
  if (anchor === "center") return { x: W / 2, y: H / 2 - 60 };
  if (anchor === "row") {
    const r = geom.rowBox;
    if (r) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    return { x: W / 2, y: H / 2 - 60 };
  }
  const c = geom.cardBox;
  if (!c) return { x: W / 2, y: H / 2 - 60 };
  const h = geom.orbHeight || 80;
  const above = c.top - h / 2 - 40;
  return {
    x: Math.min(Math.max(c.left + c.width / 2, 260), W - 260),
    y: above > 90 ? above : c.top + c.height + h / 2 + 40,
  };
}

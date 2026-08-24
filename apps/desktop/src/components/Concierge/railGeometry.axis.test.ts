// The map between the rail's TWO axes, proved numerically.
//
// `contentToTime` / `timeToContent` exist because the founder has two requirements that a single
// axis cannot satisfy: the handle must replace the scrollbar (content), and the marks must
// redistribute when the scope changes (time). The anchors are the loaded prompts — the only instants
// where the two axes are known to agree — and between them the map interpolates.
//
// THIS FILE IS AXIS-NEUTRAL. It pins the arithmetic of the map itself, which is correct and useful
// whichever axis the rail ends up drawing on, so it does not depend on the open design decision
// recorded in `useThreadScrubber.scopeRescale.test.tsx`.
import { describe, expect, it } from "vitest";
import { contentToTime, timeToContent, type AxisAnchor } from "./railGeometry";

/**
 * A transcript where the two axes DISAGREE, which is the only interesting case.
 *
 * Content is evenly spaced (0, 0.5, 1) but time is not (0, 0.25, 1): the first two prompts are
 * minutes apart and the third is hours later. A map that merely passed its input through would be
 * indistinguishable from a correct one against evenly-spaced anchors, so the fixture is skewed on
 * purpose.
 */
const ANCHORS: AxisAnchor[] = [
  { contentFraction: 0, timeFraction: 0 },
  { contentFraction: 0.5, timeFraction: 0.25 },
  { contentFraction: 1, timeFraction: 1 },
];

describe("mapping between the content axis and the time axis", () => {
  it("returns each anchor's own opposite reading exactly", () => {
    // EXACT AT THE ANCHORS is the property that makes a drag land ON the mark it was dragged to.
    // Interpolation error anywhere else is tolerable; error here puts the handle beside every mark.
    for (const a of ANCHORS) {
      expect(contentToTime(a.contentFraction, ANCHORS)).toBeCloseTo(a.timeFraction, 10);
      expect(timeToContent(a.timeFraction, ANCHORS)).toBeCloseTo(a.contentFraction, 10);
    }
  });

  it("interpolates linearly BETWEEN anchors, following the skew", () => {
    // Halfway through the first segment by content (0.25) is halfway through it by time (0.125) —
    // NOT 0.25, which is what a pass-through would return. This is the assertion that fails if the
    // map ever degenerates into the identity.
    expect(contentToTime(0.25, ANCHORS)).toBeCloseTo(0.125, 10);
    // And the same point from the other side.
    expect(timeToContent(0.125, ANCHORS)).toBeCloseTo(0.25, 10);
  });

  it("round-trips: content → time → content", () => {
    for (const cf of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(timeToContent(contentToTime(cf, ANCHORS), ANCHORS)).toBeCloseTo(cf, 10);
    }
  });

  it("CLAMPS beyond the anchors rather than extrapolating", () => {
    // Outside the loaded prompts there is no evidence about the relationship at all. Extrapolating
    // a slope measured between two prompts across an empty week produces confidently wrong
    // positions; clamping says the honest thing.
    expect(contentToTime(-5, ANCHORS)).toBeCloseTo(0, 10);
    expect(contentToTime(5, ANCHORS)).toBeCloseTo(1, 10);
    expect(timeToContent(-5, ANCHORS)).toBeCloseTo(0, 10);
    expect(timeToContent(5, ANCHORS)).toBeCloseTo(1, 10);
  });

  it("parks at the top when there is nothing to interpolate from", () => {
    // Zero anchors is a window holding no prompt; one anchor fixes a point but no slope. Neither
    // can define a mapping, and a fabricated midpoint would be a lie — a scrollbar with nowhere to
    // go sits at the top, so this does too.
    expect(contentToTime(0.7, [])).toBe(0);
    expect(timeToContent(0.7, [])).toBe(0);
  });

  it("uses a single anchor's own reading rather than guessing a slope", () => {
    const one: AxisAnchor[] = [{ contentFraction: 0.4, timeFraction: 0.9 }];
    expect(contentToTime(0.1, one)).toBeCloseTo(0.9, 10);
    expect(contentToTime(0.99, one)).toBeCloseTo(0.9, 10);
    expect(timeToContent(0.1, one)).toBeCloseTo(0.4, 10);
  });

  it("does not divide by zero on a degenerate segment", () => {
    // Two prompts in the same millisecond share a time fraction; two in an un-scrollable thread
    // share a content fraction. Either way the segment has no interior.
    const sameTime: AxisAnchor[] = [
      { contentFraction: 0, timeFraction: 0.5 },
      { contentFraction: 1, timeFraction: 0.5 },
    ];
    const t = timeToContent(0.5, sameTime);
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(1);
  });

  it("is MONOTONIC — the handle never runs backwards as the reader scrolls forwards", () => {
    // The property a reader actually feels. An inverted anchor pair (which a mid-measurement
    // backlog insert can briefly produce) must be dropped, not interpolated across.
    const inverted: AxisAnchor[] = [
      { contentFraction: 0, timeFraction: 0 },
      { contentFraction: 0.5, timeFraction: 0.8 },
      { contentFraction: 0.6, timeFraction: 0.3 }, // out of order in time — must not un-sort the map
      { contentFraction: 1, timeFraction: 1 },
    ];
    let previous = -Infinity;
    for (let cf = 0; cf <= 1.0001; cf += 0.05) {
      const t = contentToTime(cf, inverted);
      expect(t).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = t;
    }
  });

  it("keeps every reading inside [0,1]", () => {
    const wild: AxisAnchor[] = [
      { contentFraction: -3, timeFraction: -2 },
      { contentFraction: 9, timeFraction: 7 },
    ];
    for (const v of [-1, 0, 0.5, 1, 2]) {
      for (const got of [contentToTime(v, wild), timeToContent(v, wild)]) {
        expect(got).toBeGreaterThanOrEqual(0);
        expect(got).toBeLessThanOrEqual(1);
      }
    }
  });
});

// The rail's CONTENT-AXIS numbers, proved numerically.
//
// jsdom lays nothing out, so a test that tried to prove "the handle sits 40% down" by rendering and
// measuring would pass vacuously against a rail that painted nothing (docs/jsdom-test-caveats.md).
// The honest coverage for a rail is arithmetic, and this is where it lives. The DOM half —
// `ThreadScrubber.test.tsx` — asserts which elements exist and which callback fires with what; it
// never asserts a position.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MIN_GAP_PX,
  fractionForScrollTop,
  mergeMarks,
  nearestBand,
  pickFromBand,
  scrollTopForFraction,
  type RailMark,
} from "./railGeometry";

const mk = (index: number, fraction: number, id = `m${index}`): RailMark => ({
  id,
  fraction,
  textPrefix: `prompt ${index}`,
  index,
});

describe("the scroll axis", () => {
  it("maps a scroll offset onto 0..1 over the SCROLLABLE RANGE, not the content height", () => {
    // 1000 tall, 400 visible → 600 of travel. Halfway along that travel is 300, not 500.
    expect(fractionForScrollTop(300, 1000, 400)).toBeCloseTo(0.5, 10);
    expect(fractionForScrollTop(0, 1000, 400)).toBe(0);
    expect(fractionForScrollTop(600, 1000, 400)).toBe(1);
  });

  it("round-trips: a fraction becomes the offset that reports that same fraction back", () => {
    for (const f of [0, 0.17, 0.5, 0.83, 1]) {
      const top = scrollTopForFraction(f, 1000, 400);
      expect(fractionForScrollTop(top, 1000, 400)).toBeCloseTo(f, 10);
    }
  });

  // THE SIDE EFFECT of the guard, not its existence: a scroller with nothing to scroll must report
  // the TOP. Reporting 1 would park the handle at the bottom of a full-height thread, and dividing
  // by the zero range would report NaN — which places the handle at `NaN%` and paints nothing.
  it("reports 0 — never NaN, never 1 — for a scroller with nothing to scroll", () => {
    expect(fractionForScrollTop(0, 400, 400)).toBe(0);
    expect(fractionForScrollTop(0, 300, 400)).toBe(0);
    expect(scrollTopForFraction(0.5, 400, 400)).toBe(0);
  });

  it("clamps a drag that ran off either end of the rail", () => {
    expect(scrollTopForFraction(-3, 1000, 400)).toBe(0);
    expect(scrollTopForFraction(4, 1000, 400)).toBe(600);
    expect(fractionForScrollTop(-50, 1000, 400)).toBe(0);
    expect(fractionForScrollTop(9999, 1000, 400)).toBe(1);
  });
});

describe("merging marks", () => {
  it("keeps marks further apart than the gap as separate lines", () => {
    // On a 200px rail the gap is 6px = 0.03 of the axis. These are 0.25 apart.
    const bands = mergeMarks([mk(1, 0.1), mk(2, 0.35), mk(3, 0.6)], 200);
    expect(bands.map((b) => b.marks.length)).toEqual([1, 1, 1]);
    expect(bands.map((b) => b.key)).toEqual(["m1", "m2", "m3"]);
  });

  it("merges marks closer than the gap into ONE band, positioned at their mean", () => {
    const bands = mergeMarks([mk(1, 0.5), mk(2, 0.51), mk(3, 0.52)], 200);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.marks.length).toBe(3);
    expect(bands[0]!.fraction).toBeCloseTo(0.51, 10);
  });

  // THE ANCHORED-VS-CHAINED DISTINCTION, which is only visible on an evenly spaced ramp. Chaining
  // ("merge with the PREVIOUS mark if it is within the gap") would swallow this entire ramp into one
  // band spanning the rail, whose single line would then be drawn in the middle of a run that
  // actually covers everything. Anchoring bounds each band to strictly under the gap.
  it("does not CHAIN an evenly spaced ramp into one rail-spanning band", () => {
    // 5px apart on a 100px rail — under the 6px gap, so a chaining implementation merges all 20.
    const ramp = Array.from({ length: 20 }, (_, i) => mk(i + 1, (i * 5) / 100));
    const bands = mergeMarks(ramp, 100);
    expect(bands.length).toBeGreaterThan(1);
    for (const b of bands) {
      const px = b.marks.map((m) => m.fraction * 100);
      expect(Math.max(...px) - Math.min(...px)).toBeLessThan(DEFAULT_MIN_GAP_PX);
    }
  });

  // THE DEFECT THIS WHOLE REVISION IS ABOUT — the founder's *"it's definitely not giving me all of
  // them"*. Merging is the ONLY compression in this module and it must be lossless: every input
  // mark is a member of exactly one output band. A sampled or capped implementation goes red here.
  it("NEVER DROPS A MARK — every input is a member of exactly one band", () => {
    const many = Array.from({ length: 500 }, (_, i) => mk(i + 1, i / 500));
    const bands = mergeMarks(many, 300);
    const members = bands.flatMap((b) => b.marks);
    expect(members).toHaveLength(500);
    expect(new Set(members.map((m) => m.id)).size).toBe(500);
    // …and the band's own count is what the rail reads to vary the mark, so it must agree.
    expect(bands.reduce((n, b) => n + b.marks.length, 0)).toBe(500);
  });

  // FAILING TOWARD MORE MARKS. A 0px measurement is "not laid out yet", and merging against it would
  // collapse the entire history into one line — silently throwing it away, which is worse than a
  // busy rail. Asserts the OUTCOME (three separate bands), not that a branch was taken.
  it("merges NOTHING when the rail has no measured height", () => {
    const bands = mergeMarks([mk(1, 0.5), mk(2, 0.5001), mk(3, 0.5002)], 0);
    expect(bands).toHaveLength(3);
  });

  it("returns bands ascending by fraction, and members ascending inside each band", () => {
    const bands = mergeMarks([mk(3, 0.9), mk(1, 0.1), mk(2, 0.11)], 200);
    expect(bands.map((b) => b.fraction)).toEqual([...bands.map((b) => b.fraction)].sort((a, b) => a - b));
    expect(bands[0]!.marks.map((m) => m.index)).toEqual([1, 2]);
  });

  it("has nothing to draw for no marks", () => {
    expect(mergeMarks([], 200)).toEqual([]);
  });
});

describe("resolving a position to a band", () => {
  const bands = mergeMarks([mk(1, 0.1), mk(2, 0.5), mk(3, 0.9)], 200);

  it("answers with the nearest band", () => {
    expect(nearestBand(0.12, bands)!.key).toBe("m1");
    expect(nearestBand(0.48, bands)!.key).toBe("m2");
    expect(nearestBand(0.88, bands)!.key).toBe("m3");
  });

  // DETERMINISM IS THE POINT, not which side wins: a drag sitting exactly between two lines must not
  // flicker between them as the pointer jitters by a sub-pixel.
  it("breaks an exact tie toward the OLDER band, whatever order the bands arrive in", () => {
    expect(nearestBand(0.3, bands)!.key).toBe("m1");
    expect(nearestBand(0.3, [...bands].reverse())!.key).toBe("m1");
  });

  it("answers with the end band for a position off either end", () => {
    expect(nearestBand(-2, bands)!.key).toBe("m1");
    expect(nearestBand(5, bands)!.key).toBe("m3");
  });

  it("answers null when there is nothing to resolve to", () => {
    expect(nearestBand(0.5, [])).toBeNull();
  });
});

describe("what a merged band commits", () => {
  // The card prints the NEWEST member's text, so a pick must land on that same prompt — otherwise
  // the reader is taken somewhere other than the words they just read, which is the single most
  // confusing thing a navigation control can do.
  it("picks the NEWEST member — the one the card named", () => {
    const band = mergeMarks([mk(1, 0.5), mk(2, 0.505), mk(3, 0.51)], 200)[0]!;
    expect(band.marks.length).toBe(3);
    expect(pickFromBand(band).index).toBe(3);
  });
});

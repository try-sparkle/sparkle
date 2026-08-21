// The scrubber's numeric contract. NO jsdom here on purpose (see scrubberGeometry.ts's header):
// jsdom lays nothing out, so a rendered assertion about where a dot "is" measures zeros. These are
// the honest tests, and most of the rail's coverage lives in this file rather than in the
// component's.
//
// Every assertion below is written to fail if the geometry changes, not merely if it disappears —
// the fixtures use times chosen so the expected fractions are exact, so a clamp that stops
// clamping, an axis that flips end for end, or a cluster boundary that moves by one pixel all show
// up as a wrong NUMBER rather than as a shape that still looks plausible.
import { describe, expect, it } from "vitest";

import {
  ageLabel,
  clusterMarkers,
  DEFAULT_MIN_GAP_PX,
  fractionFor,
  nearestMarker,
  SCOPE_LABEL,
  SCOPE_MS,
  SCOPE_PHRASE,
  SCRUBBER_SCOPES,
  scopeWindow,
  timeAt,
  type ScrubberMarker,
  nearestCluster,
  type DotCluster,} from "./scrubberGeometry";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

/** A marker at `createdAt`, with a readable id so a failed membership assertion names the prompt. */
const mk = (index: number, createdAt: number, textPrefix = `prompt ${index}`): ScrubberMarker => ({
  id: `m${index}`,
  createdAt,
  textPrefix,
  index,
});

describe("the scope table", () => {
  it("lists the founder's scopes in his order, with a label and a phrase for each", () => {
    expect([...SCRUBBER_SCOPES]).toEqual([
      "1h",
      "3h",
      "6h",
      "12h",
      "1d",
      "3d",
      "7d",
      "1w",
      "2w",
      "1m",
      "3m",
      "6m",
      "1y",
    ]);
    for (const s of SCRUBBER_SCOPES) {
      expect(SCOPE_LABEL[s]).toBe(s);
      expect(SCOPE_PHRASE[s]).toMatch(/^\d+ (hour|day|week|month|year)s?$/);
    }
  });

  it("spans the durations the names claim, with the nominal month and year", () => {
    expect(SCOPE_MS["1h"]).toBe(3_600_000);
    expect(SCOPE_MS["12h"]).toBe(12 * HOUR);
    expect(SCOPE_MS["1d"]).toBe(DAY);
    expect(SCOPE_MS["2w"]).toBe(14 * DAY);
    expect(SCOPE_MS["1m"]).toBe(30 * DAY);
    expect(SCOPE_MS["3m"]).toBe(90 * DAY);
    expect(SCOPE_MS["6m"]).toBe(180 * DAY);
    expect(SCOPE_MS["1y"]).toBe(365 * DAY);
    // He wrote both `7d` and `1w`; they are the same window and that is deliberate.
    expect(SCOPE_MS["1w"]).toBe(SCOPE_MS["7d"]);
    // Strictly increasing across the list is what makes the dropdown a zoom control rather than a
    // menu of unrelated options.
    const spans = SCRUBBER_SCOPES.map((s) => SCOPE_MS[s]);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!).toBeGreaterThanOrEqual(spans[i - 1]!);
  });
});

describe("scopeWindow", () => {
  it("puts NOW at the bottom and now-minus-scope at the top", () => {
    expect(scopeWindow(NOW, "1d")).toEqual({ fromMs: NOW - DAY, toMs: NOW });
    expect(scopeWindow(NOW, "1h")).toEqual({ fromMs: NOW - HOUR, toMs: NOW });
  });

  it("re-scales rather than filtering: the SAME prompt sits at different fractions per scope", () => {
    // This is the founder's "it is a ZOOM, not a filter" stated as a number. A prompt 12 hours old
    // is halfway down a 1d rail and just off the top of a 1d-and-a-bit rail — the dot moves when
    // the scope changes, which is the whole behaviour.
    const twelveHoursAgo = NOW - 12 * HOUR;
    expect(fractionFor(twelveHoursAgo, scopeWindow(NOW, "1d"))).toBeCloseTo(0.5, 10);
    expect(fractionFor(twelveHoursAgo, scopeWindow(NOW, "3d"))).toBeCloseTo(1 - 0.5 / 3, 10);
    expect(fractionFor(twelveHoursAgo, scopeWindow(NOW, "1h"))).toBe(0); // clamped off the top
  });
});

describe("fractionFor / timeAt", () => {
  const w = scopeWindow(NOW, "1d");

  it("maps the ends and the middle exactly", () => {
    expect(fractionFor(w.fromMs, w)).toBe(0);
    expect(fractionFor(w.toMs, w)).toBe(1);
    expect(fractionFor(NOW - 6 * HOUR, w)).toBeCloseTo(0.75, 10);
  });

  it("CLAMPS both directions instead of running off the rail", () => {
    expect(fractionFor(NOW - 5 * DAY, w)).toBe(0);
    expect(fractionFor(NOW + DAY, w)).toBe(1);
  });

  it("round-trips: timeAt(fractionFor(t)) === t for anything inside the window", () => {
    for (const t of [w.fromMs, NOW - 17 * HOUR, NOW - 90_000, w.toMs]) {
      expect(timeAt(fractionFor(t, w), w)).toBeCloseTo(t, 6);
    }
  });

  it("timeAt clamps its input the same way fractionFor clamps its output", () => {
    expect(timeAt(-2, w)).toBe(w.fromMs);
    expect(timeAt(4, w)).toBe(w.toMs);
    expect(timeAt(0.25, w)).toBe(NOW - 18 * HOUR);
  });

  it("collapses a degenerate window to the bottom instead of dividing by zero", () => {
    const flat = { fromMs: NOW, toMs: NOW };
    expect(fractionFor(NOW - DAY, flat)).toBe(1);
    expect(Number.isNaN(fractionFor(NOW, flat))).toBe(false);
    expect(timeAt(0.5, flat)).toBe(NOW);
  });
});

describe("clusterMarkers", () => {
  const w = scopeWindow(NOW, "1d");
  const RAIL = 240; // 240px over 24h => one pixel per 6 minutes.

  it("leaves well-separated prompts as one dot each, ascending down the rail", () => {
    // 6 minutes is exactly 1px at this rail height, so these three are 60px, 120px apart: nowhere
    // near merging.
    const ms = [mk(1, NOW - 18 * HOUR), mk(2, NOW - 12 * HOUR), mk(3, NOW - 2 * HOUR)];
    const out = clusterMarkers(ms, w, RAIL);
    expect(out.map((c) => c.markers.map((m) => m.id))).toEqual([["m1"], ["m2"], ["m3"]]);
    expect(out.map((c) => c.fraction)).toEqual([0.25, 0.5, 1 - 2 / 24]);
    expect(out.map((c) => c.key)).toEqual(["m1", "m2", "m3"]);
  });

  it("merges by MEMBERSHIP at the documented boundary — under the gap in, at the gap out", () => {
    // At RAIL=240 over 24h, 1px = 6 minutes, so the default 6px gap = 36 minutes.
    // m1 anchors. m2 is 35 minutes later (5.83px < 6) -> merges. m3 is 36 minutes after the ANCHOR
    // (exactly 6px) -> starts a new cluster. m4 is 1 minute after m3 -> merges with m3.
    const anchor = NOW - 12 * HOUR;
    const ms = [
      mk(1, anchor),
      mk(2, anchor + 35 * 60_000),
      mk(3, anchor + 36 * 60_000),
      mk(4, anchor + 37 * 60_000),
    ];
    const out = clusterMarkers(ms, w, RAIL, DEFAULT_MIN_GAP_PX);
    expect(out.map((c) => c.markers.map((m) => m.id))).toEqual([
      ["m1", "m2"],
      ["m3", "m4"],
    ]);
    // The fat dot sits at the MEAN of its members, which keeps it inside the band it stands for.
    expect(out[0]!.fraction).toBeCloseTo(
      (fractionFor(ms[0]!.createdAt, w) + fractionFor(ms[1]!.createdAt, w)) / 2,
      12,
    );
    expect(out[0]!.fraction).toBeGreaterThan(fractionFor(ms[0]!.createdAt, w));
    expect(out[0]!.fraction).toBeLessThan(fractionFor(ms[2]!.createdAt, w));
  });

  it("is ANCHORED, not chained: a steady ramp does not collapse into one rail-wide dot", () => {
    // Twelve prompts each 5px after the last. Chained merging would swallow all twelve into a
    // single cluster spanning 55px and draw its dot in the middle of the run; anchored merging
    // caps every cluster below 6px, so the ramp stays readable as several dots.
    const step = 5 * 6 * 60_000; // 5px worth of time
    const base = NOW - 20 * HOUR;
    const ms = Array.from({ length: 12 }, (_, i) => mk(i + 1, base + i * step));
    const out = clusterMarkers(ms, w, RAIL);
    expect(out.map((c) => c.markers.map((m) => m.id))).toEqual([
      ["m1", "m2"],
      ["m3", "m4"],
      ["m5", "m6"],
      ["m7", "m8"],
      ["m9", "m10"],
      ["m11", "m12"],
    ]);
    // Every cluster's span stays under the gap — the property anchoring exists to guarantee.
    for (const c of out) {
      const spanPx =
        (fractionFor(c.markers[c.markers.length - 1]!.createdAt, w) -
          fractionFor(c.markers[0]!.createdAt, w)) *
        RAIL;
      expect(spanPx).toBeLessThan(DEFAULT_MIN_GAP_PX);
    }
  });

  it("survives the founder's measured worst hour: 161 prompts do not become 161 dots", () => {
    // From the spec's measurement. Evenly spread over the hour at 1h scope on a 320px rail this
    // would be a dot every ~2px, i.e. a solid bar with nothing hoverable in it.
    const hourWin = scopeWindow(NOW, "1h");
    const ms = Array.from({ length: 161 }, (_, i) =>
      mk(i + 1, hourWin.fromMs + Math.round((i * HOUR) / 160)),
    );
    const out = clusterMarkers(ms, hourWin, 320);
    expect(out.length).toBeLessThan(60);
    // Nothing is lost — every prompt is still inside exactly one dot, in time order.
    expect(out.flatMap((c) => c.markers.map((m) => m.id))).toEqual(ms.map((m) => m.id));
  });

  it("DROPS markers outside the window rather than pinning them to an end", () => {
    const ms = [mk(1, NOW - 3 * DAY), mk(2, NOW - 6 * HOUR), mk(3, NOW + HOUR)];
    const out = clusterMarkers(ms, w, RAIL);
    expect(out.map((c) => c.markers.map((m) => m.id))).toEqual([["m2"]]);
    // The window's own edges are INCLUSIVE — a prompt sent exactly `scope` ago is the top dot.
    expect(clusterMarkers([mk(9, w.fromMs)], w, RAIL).map((c) => c.fraction)).toEqual([0]);
    expect(clusterMarkers([mk(9, w.toMs)], w, RAIL).map((c) => c.fraction)).toEqual([1]);
  });

  it("sorts by time (then ordinal) whatever order the caller hands them over in", () => {
    const a = mk(3, NOW - 2 * HOUR);
    const b = mk(1, NOW - 20 * HOUR);
    const c = mk(2, NOW - 20 * HOUR); // same millisecond as b — ordinal decides
    const out = clusterMarkers([a, c, b], w, RAIL);
    expect(out.map((x) => x.markers.map((m) => m.id))).toEqual([["m1", "m2"], ["m3"]]);
  });

  it("refuses to merge when there is no measured height to merge against", () => {
    // The safe direction on a 0px rail is MORE dots: merging everything into one on an unmeasured
    // rail would silently throw the history away, and jsdom hands us exactly that measurement.
    const ms = [mk(1, NOW - HOUR), mk(2, NOW - HOUR + 1000), mk(3, NOW - HOUR + 2000)];
    expect(clusterMarkers(ms, w, 0).map((c) => c.markers.length)).toEqual([1, 1, 1]);
    expect(clusterMarkers(ms, w, RAIL, 0).map((c) => c.markers.length)).toEqual([1, 1, 1]);
    // …and with a real height and the real gap those same three DO merge, so the row above is
    // testing the guard rather than a fixture that could never cluster anyway.
    expect(clusterMarkers(ms, w, RAIL).map((c) => c.markers.length)).toEqual([3]);
  });

  it("returns nothing for an empty window — the rail's empty state", () => {
    expect(clusterMarkers([], w, RAIL)).toEqual([]);
    expect(clusterMarkers([mk(1, NOW - 9 * DAY)], w, RAIL)).toEqual([]);
  });
});

describe("nearestMarker", () => {
  const w = scopeWindow(NOW, "1d");
  const ms = [mk(1, NOW - 18 * HOUR), mk(2, NOW - 12 * HOUR), mk(3, NOW - 2 * HOUR)];

  it("picks the closest dot to a rail fraction", () => {
    expect(nearestMarker(0.24, ms, w)?.id).toBe("m1");
    expect(nearestMarker(0.52, ms, w)?.id).toBe("m2");
    expect(nearestMarker(0.99, ms, w)?.id).toBe("m3");
  });

  it("breaks an exact tie toward the OLDER prompt, whatever order the array is in", () => {
    // 0.375 is exactly halfway between m1 (0.25) and m2 (0.5). An unspecified tie-break makes a
    // drag sitting on that midpoint flicker as the mouse jitters.
    expect(nearestMarker(0.375, ms, w)?.id).toBe("m1");
    expect(nearestMarker(0.375, [...ms].reverse(), w)?.id).toBe("m1");
  });

  // TWO PROMPTS IN THE SAME MILLISECOND (roborev 66376). Not hypothetical: the founder pastes
  // bursts and `conciergeHistoryCapture` stamps `Date.now()`, so identical timestamps are ordinary.
  // Time alone is therefore not a total order, and with only `createdAt` in the comparator the
  // winner was whichever the caller happened to list first — the exact array-order dependence the
  // tie-break exists to remove, and a disagreement with `clusterMarkers`, which already breaks this
  // tie by `index`.
  //
  // The fixture above cannot catch it: every marker in `ms` has a distinct timestamp, so the
  // same-millisecond path is untested by construction there.
  it("breaks a SAME-MILLISECOND tie by prompt ordinal, whatever order the array is in", () => {
    const at = NOW - 12 * HOUR;
    const a = { id: "burst-a", createdAt: at, textPrefix: "first of the burst", index: 7 };
    const b = { id: "burst-b", createdAt: at, textPrefix: "second of the burst", index: 8 };
    // Both sit at the same fraction, so the distance is identical for any target. The winner is the
    // NEWEST of the pair — the member `pickFromCluster` and the hover card already use.
    expect(nearestMarker(0.5, [a, b], w)?.id).toBe("burst-b");
    expect(nearestMarker(0.5, [b, a], w)?.id).toBe("burst-b");
    // …and off-centre too, so this is not an artefact of landing exactly on the dot.
    expect(nearestMarker(0.9, [b, a], w)?.id).toBe("burst-b");
  });

  // The two exported functions must not order identical input differently — that disagreement is
  // what makes a dot's hover card name one prompt while a drag onto it commits another.
  // AGAINST THE MEMBER THE USER-FACING PATHS ACTUALLY USE (roborev 66397). The earlier version of
  // this row compared against `cluster.markers[0]`, which nothing renders or commits — so it passed
  // while a CLICK on a fat dot went to one prompt and a DRAG onto the same dot went to another.
  // `pickFromCluster` takes the LAST member and the hover card prints that member's text, so the
  // last member is what a drag must agree with.
  it("commits the same prompt a CLICK on that cluster would, for a same-millisecond pair", () => {
    const at = NOW - 12 * HOUR;
    const a = { id: "burst-a", createdAt: at, textPrefix: "first", index: 7 };
    const b = { id: "burst-b", createdAt: at, textPrefix: "second", index: 8 };
    const cluster = clusterMarkers([b, a], w, 400)[0]!;
    const clicked = cluster.markers[cluster.markers.length - 1]!;
    expect(nearestMarker(0.5, [b, a], w)?.id).toBe(clicked.id);
    // Stated absolutely too, so a change that moved BOTH in step could not pass this silently.
    expect(clicked.id).toBe("burst-b");
  });

  // The OTHER tie is unchanged and breaks the opposite way: two DIFFERENT instants equidistant from
  // the handle still resolve to the older, because the reader is scrubbing backwards.
  it("still prefers the OLDER of two equidistant prompts at different instants", () => {
    expect(nearestMarker(0.375, ms, w)?.id).toBe("m1");
  });

  it("clamps an out-of-range fraction rather than answering with nothing", () => {
    expect(nearestMarker(-3, ms, w)?.id).toBe("m1");
    expect(nearestMarker(7, ms, w)?.id).toBe("m3");
  });

  it("ignores out-of-window prompts and returns null when none are left", () => {
    const stale = [mk(1, NOW - 40 * DAY), mk(2, NOW + DAY)];
    expect(nearestMarker(0.5, stale, w)).toBeNull();
    expect(nearestMarker(0.5, [], w)).toBeNull();
    // The in-window one wins even though the stale one is numerically nearer to nothing.
    expect(nearestMarker(0.0, [...stale, mk(3, NOW - HOUR)], w)?.id).toBe("m3");
  });
});

describe("ageLabel", () => {
  it("uses the founder's own phrasing from the mockup", () => {
    expect(ageLabel(NOW - 13 * DAY, NOW)).toBe("13 days ago");
    expect(ageLabel(NOW - 4 * HOUR, NOW)).toBe("4 hours ago");
    expect(ageLabel(NOW - 20_000, NOW)).toBe("just now");
  });

  it("singularises, and FLOORS rather than rounding up past a boundary", () => {
    expect(ageLabel(NOW - 61_000, NOW)).toBe("1 minute ago");
    expect(ageLabel(NOW - 59 * 60_000, NOW)).toBe("59 minutes ago");
    expect(ageLabel(NOW - HOUR, NOW)).toBe("1 hour ago");
    // 23h59m is still "23 hours ago". Rounding up would make the label disagree with the dot.
    expect(ageLabel(NOW - (DAY - 60_000), NOW)).toBe("23 hours ago");
    expect(ageLabel(NOW - DAY, NOW)).toBe("1 day ago");
    expect(ageLabel(NOW - 29 * DAY, NOW)).toBe("29 days ago");
    expect(ageLabel(NOW - 30 * DAY, NOW)).toBe("1 month ago");
    expect(ageLabel(NOW - 75 * DAY, NOW)).toBe("2 months ago");
    expect(ageLabel(NOW - 365 * DAY, NOW)).toBe("1 year ago");
    expect(ageLabel(NOW - 800 * DAY, NOW)).toBe("2 years ago");
  });

  it("reads a future timestamp as 'just now' instead of a negative age", () => {
    expect(ageLabel(NOW + 5 * HOUR, NOW)).toBe("just now");
  });
});

// ── nearestCluster (roborev 66498) ──────────────────────────────────────────────────────────────
// The drag path resolves to a DOT, not to a raw marker, so this is the function that decides which
// prompt a release commits. It shipped with no row here at all.
describe("nearestCluster", () => {
  // No window here on purpose: nearestCluster works in RAIL FRACTIONS, which is exactly why the
  // drag can resolve through it without re-deriving any times.
  const at = (f: number, key: string): DotCluster => ({
    key,
    fraction: f,
    markers: [{ id: key, createdAt: NOW, textPrefix: key, index: 1 }],
  });

  it("returns the dot nearest a rail fraction", () => {
    const cs = [at(0.1, "a"), at(0.5, "b"), at(0.9, "c")];
    expect(nearestCluster(0.12, cs)?.key).toBe("a");
    expect(nearestCluster(0.49, cs)?.key).toBe("b");
    expect(nearestCluster(0.95, cs)?.key).toBe("c");
  });

  // NAMED FOR WHAT IT GUARANTEES, not for an implementation detail. It used to say "clamps", which
  // was a claim no mutation could falsify: clamping cannot change an argmin, so deleting the clamp
  // left this green (roborev 66516). The clamp is gone; the GUARANTEE — a fraction outside the rail
  // still resolves to an end dot rather than to nothing — is real, and is what a drag that
  // overshoots the rail depends on.
  it("resolves a fraction beyond either end of the rail to the end dot", () => {
    const cs = [at(0.1, "a"), at(0.9, "c")];
    expect(nearestCluster(-4, cs)?.key).toBe("a");
    expect(nearestCluster(9, cs)?.key).toBe("c");
  });

  it("returns null when there are no dots", () => {
    expect(nearestCluster(0.5, [])).toBeNull();
  });

  // THE TIE CLAUSE, DRIVEN THROUGH THE ONLY INPUT THAT CAN EXECUTE IT. clusterMarkers guarantees
  // ascending fractions, so with that ordering the earlier-seen cluster is always the lower one and
  // the clause never fires — it would be a branch no input could reach, and its stated rule would be
  // provided by iteration order rather than by the code written for it. Feeding the clusters in
  // DESCENDING order makes it live: the answer must still be the OLDER (upper) dot.
  it("breaks an exact tie toward the OLDER dot, whatever order the clusters arrive in", () => {
    const ascending = [at(0.4, "older"), at(0.6, "newer")];
    const descending = [at(0.6, "newer"), at(0.4, "older")];
    expect(nearestCluster(0.5, ascending)?.key).toBe("older");
    expect(nearestCluster(0.5, descending)?.key).toBe("older");
  });
});

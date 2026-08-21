// ONE scope table, shared by the half that FETCHES and the half that DRAWS (bead sparkle-7m719).
//
// While the rail was built as two parallel halves, `useThreadScrubber` carried a structural COPY of
// `SCOPE_MS` so both could be written against a frozen contract at once. That copy is gone, and
// this is the guard that stops it coming back — because the failure it would cause is silent and
// total, not partial:
//
//   * `useThreadScrubber` uses SCOPE_MS to choose the QUERY WINDOW, `[now - SCOPE_MS[scope], now]`.
//   * `ThreadScrubber`/`scrubberGeometry` use it to PLACE EVERY DOT across the rail.
//
// Two tables that drift by a single entry therefore fetch one span and draw another: every dot
// lands in the wrong place, at one scope, and BOTH module suites stay green — neither can see the
// other's table. There is no assertion inside either module that could catch it.
import { describe, expect, it } from "vitest";
import * as geometry from "./scrubberGeometry";
import * as hook from "./useThreadScrubber";

describe("the rail has exactly one scope table", () => {
  // IDENTITY, not deep equality. Two tables with equal values today are still two tables, and the
  // next edit to one of them is the bug. `toBe` can only pass for a re-export.
  it("useThreadScrubber re-exports the geometry module's SCOPE_MS rather than declaring its own", () => {
    expect(hook.SCOPE_MS).toBe(geometry.SCOPE_MS);
  });

  it("covers every scope the dropdown offers, so no option resolves to undefined ms", () => {
    for (const s of geometry.SCRUBBER_SCOPES) {
      expect(geometry.SCOPE_MS[s], `scope ${s} has no span`).toBeGreaterThan(0);
    }
    expect(Object.keys(geometry.SCOPE_MS).sort()).toEqual([...geometry.SCRUBBER_SCOPES].sort());
  });

  // The founder's own list, in his own order. A scope silently dropped from the dropdown is a
  // feature he asked for going missing, which is the whole history of this bead.
  it("offers all thirteen of the scopes he asked for, in order", () => {
    expect(geometry.SCRUBBER_SCOPES).toEqual([
      "1h", "3h", "6h", "12h", "1d", "3d", "7d", "1w", "2w", "1m", "3m", "6m", "1y",
    ]);
  });

  // STRICTLY INCREASING, WITH EXACTLY ONE NAMED EXCEPTION (roborev 66437). The first version of
  // this row said "strictly" and asserted `toBeGreaterThanOrEqual` for EVERY adjacent pair, which
  // permits any number of equal-span neighbours — so setting "3m" to 30 days (equal to "1m") left
  // it green while the dropdown silently offered two entries reaching back the same distance. The
  // assertion was weaker than the intent it documented, in the direction that made it vacuous for
  // the exact failure it names.
  it("orders the scopes strictly by span, apart from the 7d/1w pair he named twice", () => {
    const scopes = geometry.SCRUBBER_SCOPES;
    /** The ONE deliberate duplicate: he listed both "7d" and "1w", and they are the same week. */
    const ALLOWED_EQUAL_PAIR = ["7d", "1w"];
    for (let i = 1; i < scopes.length; i++) {
      const prev = scopes[i - 1]!;
      const cur = scopes[i]!;
      const a = geometry.SCOPE_MS[prev]!;
      const b = geometry.SCOPE_MS[cur]!;
      if (prev === ALLOWED_EQUAL_PAIR[0] && cur === ALLOWED_EQUAL_PAIR[1]) {
        expect(b, `${prev} and ${cur} are the same week by design`).toBe(a);
        continue;
      }
      expect(b, `${cur} must reach back STRICTLY further than ${prev}`).toBeGreaterThan(a);
    }
  });

  // …and the exception is exactly one pair, so a second duplicate cannot be smuggled in by moving
  // the names around.
  it("has exactly one pair of scopes sharing a span", () => {
    const spans = geometry.SCRUBBER_SCOPES.map((s) => geometry.SCOPE_MS[s]);
    expect(spans.length - new Set(spans).size).toBe(1);
  });
});

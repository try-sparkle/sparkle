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

  // The founder's own list, in his own order, plus the one he asked for on 2026-08-22: *"I'm
  // realizing that I want more than one day of history. I wanna know how far back you have
  // history... I basically wanna go as far back as we can."* A scope silently dropped from the
  // dropdown is a feature he asked for going missing, which is the whole history of this bead.
  it("offers all fourteen of the scopes he asked for, in order, ending at All", () => {
    expect(geometry.SCRUBBER_SCOPES).toEqual([
      "1h", "3h", "6h", "12h", "1d", "3d", "7d", "1w", "2w", "1m", "3m", "6m", "1y", "all",
    ]);
  });

  // ── "all" IS A SENTINEL, AND ITS REAL EDGE COMES FROM THE STORE ────────────────────────────────
  // `SCOPE_MS.all` exists only to keep the Record total and to keep arithmetic on it finite; the
  // window a caller actually uses is `scopeFromMs`, which takes MIN(created_at). Asserting the
  // SUBSTITUTION — the returned instant, not that a branch ran — is the only version of this that
  // could go red if `scopeFromMs` started ignoring the measured value.
  it("takes All's top edge from the measured oldest row, not from the sentinel", () => {
    const NOW = 1_700_000_000_000;
    const OLDEST = NOW - 10 * 86_400_000;
    expect(geometry.scopeFromMs(NOW, "all", OLDEST)).toBe(OLDEST);
    // A bounded scope ignores the measurement entirely — its edge IS the scope.
    expect(geometry.scopeFromMs(NOW, "1d", OLDEST)).toBe(NOW - geometry.SCOPE_MS["1d"]);
  });

  it("falls back to the sentinel window — never to the epoch — when the store has not answered", () => {
    const NOW = 1_700_000_000_000;
    // 0 would put every real prompt in the last 0.0001 of the axis, which is precisely the
    // "the rail shows a couple of dots" failure this work exists to fix.
    expect(geometry.scopeFromMs(NOW, "all", null)).toBe(NOW - geometry.SCOPE_MS.all);
    expect(geometry.scopeFromMs(NOW, "all", NaN)).toBe(NOW - geometry.SCOPE_MS.all);
    // …and a store whose oldest row is somehow in the FUTURE cannot define a window either.
    expect(geometry.scopeFromMs(NOW, "all", NOW + 1)).toBe(NOW - geometry.SCOPE_MS.all);
  });

  // The menu answers "how far back do you have history" IN PLACE, which is the thing he had to ask
  // a person to measure. Only "all" carries it: on a bounded scope the axis's top edge is the scope,
  // not the data, so printing the data's edge there would describe a different window.
  it("prints the true extent behind All, and only behind All", () => {
    const at = Date.UTC(2026, 7, 12, 14, 21, 39);
    expect(geometry.scopeMenuLabel("all", at)).toMatch(/^All — since Aug 1[23]$/);
    expect(geometry.scopeMenuLabel("1d", at)).toBe("1d");
    expect(geometry.scopeMenuLabel("all", null)).toBe("All");
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

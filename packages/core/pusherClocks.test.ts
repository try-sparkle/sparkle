// THE PROPERTY: "continuously true since" — not "true as of the last sweep", and not zero when we
// have never looked.
//
// Both failure directions are silent, which is why they are tested rather than reasoned about. A
// clock that re-stamps every cycle makes every duration read ~0, so the two duration triggers never
// fire and the Pusher is quietly useless. A clock that never drops makes a cleared-and-returned
// condition report the age of the FIRST episode, so a partner that pushed its commits and wrote new
// ones is told they have sat for three hours — a false measurement, delivered past a citation gate
// that cannot catch it because the number really was measured.
import { describe, it, expect } from "vitest";
import { trackSince, elapsedSince } from "./pusherClocks";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe("trackSince", () => {
  it("stamps a newly true condition", () => {
    expect(trackSince(undefined, ["a"], T0)).toEqual(new Map([["a", T0]]));
  });

  // The whole point: the stamp is the ONSET, not the last sighting.
  it("keeps the ORIGINAL stamp while the condition stays true", () => {
    const first = trackSince(undefined, ["a"], T0);
    const later = trackSince(first, ["a"], T0 + 30 * MIN);
    expect(later.get("a")).toBe(T0);
  });

  it("drops a condition that is no longer true", () => {
    expect(trackSince(new Map([["a", T0]]), [], T0 + MIN)).toEqual(new Map());
  });

  // Dropping is what makes a second episode time from ITS onset. Without it the partner that
  // complied is told the age of the episode it already resolved.
  it("restarts the clock when a condition clears and returns", () => {
    let c = trackSince(undefined, ["a"], T0);
    c = trackSince(c, [], T0 + 40 * MIN); // pushed — condition clears
    c = trackSince(c, ["a"], T0 + 60 * MIN); // new commits
    expect(elapsedSince(c, "a", T0 + 62 * MIN)).toBe(2 * MIN);
  });

  it("tracks keys independently", () => {
    const c = trackSince(new Map([["a", T0]]), ["a", "b"], T0 + 10 * MIN);
    expect(c).toEqual(new Map([["a", T0], ["b", T0 + 10 * MIN]]));
  });

  it("garbage-collects a key the caller stopped observing", () => {
    const c = trackSince(new Map([["a", T0], ["gone", T0]]), ["a"], T0 + MIN);
    expect([...c.keys()]).toEqual(["a"]);
  });
});

describe("elapsedSince", () => {
  it("measures from the onset", () => {
    expect(elapsedSince(new Map([["a", T0]]), "a", T0 + 38 * MIN)).toBe(38 * MIN);
  });

  // "never observed" and "just started" are different facts and only the second is evidence.
  // Every trigger is fail-closed on undefined, matching agentStall's absent-input rule.
  it("returns undefined for a key it has never seen — NOT zero", () => {
    expect(elapsedSince(new Map([["a", T0]]), "b", T0)).toBeUndefined();
    expect(elapsedSince(undefined, "a", T0)).toBeUndefined();
  });

  it("reports zero at the instant of onset", () => {
    expect(elapsedSince(new Map([["a", T0]]), "a", T0)).toBe(0);
  });

  // A negative duration would render as "-3 minutes ago" and the citation gate would PASS it, since
  // the number really was measured. Clamping is the only place that can catch it.
  it("never reports a negative duration", () => {
    expect(elapsedSince(new Map([["a", T0 + 5 * MIN]]), "a", T0)).toBe(0);
  });
});

describe("prototype-named keys are ordinary keys (roborev 56322)", () => {
  // A plain Record resolves Object.prototype members, so `before["constructor"]` reads back an
  // inherited FUNCTION rather than undefined, elapsedSince computes `now - fn`, and the answer is
  // NaN typed as number. NaN is not undefined, so every fail-closed consumer reads it as a real
  // measurement. `goalContinuationRunner`'s idle clock is a Map for exactly this reason.
  it.each([["constructor"], ["__proto__"], ["toString"], ["hasOwnProperty"]])(
    "%s round-trips as data, and never yields NaN",
    (key) => {
      const c = trackSince(undefined, [key], T0);
      expect(c.get(key)).toBe(T0);
      const elapsed = elapsedSince(c, key, T0 + 5 * MIN);
      expect(elapsed).toBe(5 * MIN);
      expect(Number.isNaN(elapsed)).toBe(false);
    },
  );

  it("reports undefined for an unseen prototype-named key rather than a function", () => {
    expect(elapsedSince(trackSince(undefined, ["a"], T0), "constructor", T0)).toBeUndefined();
  });
});

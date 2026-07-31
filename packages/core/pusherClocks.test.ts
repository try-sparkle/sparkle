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
    expect(trackSince(undefined, ["a"], T0)).toEqual({ a: T0 });
  });

  // The whole point: the stamp is the ONSET, not the last sighting.
  it("keeps the ORIGINAL stamp while the condition stays true", () => {
    const first = trackSince(undefined, ["a"], T0);
    const later = trackSince(first, ["a"], T0 + 30 * MIN);
    expect(later.a).toBe(T0);
  });

  it("drops a condition that is no longer true", () => {
    expect(trackSince({ a: T0 }, [], T0 + MIN)).toEqual({});
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
    const c = trackSince({ a: T0 }, ["a", "b"], T0 + 10 * MIN);
    expect(c).toEqual({ a: T0, b: T0 + 10 * MIN });
  });

  it("garbage-collects a key the caller stopped observing", () => {
    const c = trackSince({ a: T0, gone: T0 }, ["a"], T0 + MIN);
    expect(Object.keys(c)).toEqual(["a"]);
  });
});

describe("elapsedSince", () => {
  it("measures from the onset", () => {
    expect(elapsedSince({ a: T0 }, "a", T0 + 38 * MIN)).toBe(38 * MIN);
  });

  // "never observed" and "just started" are different facts and only the second is evidence.
  // Every trigger is fail-closed on undefined, matching agentStall's absent-input rule.
  it("returns undefined for a key it has never seen — NOT zero", () => {
    expect(elapsedSince({ a: T0 }, "b", T0)).toBeUndefined();
    expect(elapsedSince(undefined, "a", T0)).toBeUndefined();
  });

  it("reports zero at the instant of onset", () => {
    expect(elapsedSince({ a: T0 }, "a", T0)).toBe(0);
  });

  // A negative duration would render as "-3 minutes ago" and the citation gate would PASS it, since
  // the number really was measured. Clamping is the only place that can catch it.
  it("never reports a negative duration", () => {
    expect(elapsedSince({ a: T0 + 5 * MIN }, "a", T0)).toBe(0);
  });
});

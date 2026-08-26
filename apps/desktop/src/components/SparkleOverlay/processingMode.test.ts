// The `processing` mode, pinned from the outside (bead sparkle-uz87.7).
//
// WHAT THIS FILE IS GUARDING AGAINST, precisely: not "does processing exist" — a variant added to
// a union always exists — but "does processing DO anything, and did adding it change what the
// other three do". A widened union fails in exactly two ways, and a test that only asks the first
// question misses the second:
//
//   1. the new variant falls through to some other arm and is visually inert;
//   2. adding it silently reassigns an EXISTING variant's behaviour.
//
// So every assertion below is comparative. `expect(swirl).not.toBe(rest)` is the real assertion;
// `expect(rest).toBe(0.45)` is what stops the fix for (1) from being "make everything swirl".
import { describe, expect, it } from "vitest";
import { deriveFlags, modeMotion, type Mode } from "./state";
import { perchWave, shellPulse, twinkleRate } from "./engine";

const MODES: Mode[] = ["still", "listening", "processing", "speaking"];

describe("modeMotion", () => {
  it("gives every mode its own motion — no two modes share one", () => {
    const motions = MODES.map(modeMotion);
    expect(motions).toEqual(["rest", "ripple", "swirl", "pulse"]);
    expect(new Set(motions).size).toBe(MODES.length);
  });

  it("routes processing to swirl and NOT to the resting arm", () => {
    // The chained ternary this replaced would have returned the `still` values for processing.
    expect(modeMotion("processing")).toBe("swirl");
    expect(modeMotion("processing")).not.toBe(modeMotion("still"));
  });
});

describe("twinkleRate", () => {
  it("moves faster while processing than at rest", () => {
    expect(twinkleRate("swirl")).toBeGreaterThan(twinkleRate("rest"));
  });

  it("leaves the three original rates exactly where they were", () => {
    // These are the literals from the pre-widening ternary. If adding a variant moved one of
    // them, the widening changed behaviour it had no business changing.
    expect(twinkleRate("ripple")).toBe(2.2);
    expect(twinkleRate("pulse")).toBe(1.6);
    expect(twinkleRate("rest")).toBe(0.45);
  });
});

describe("shellPulse", () => {
  it("breathes during processing even with NO mic and NO voice level", () => {
    // The whole point of clock-driving the swirl: once the utterance closes there is no level to
    // sample, so a level-driven pulse would sit at exactly 1 and the overlay would look frozen at
    // the one moment the user is waiting on it.
    const a = shellPulse("swirl", 0, 0, 0);
    const b = shellPulse("swirl", 0, 0, 0.37);
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThan(1);
    expect(b).toBeGreaterThan(1);
  });

  it("still rests flat at 1, and still tracks the levels it always did", () => {
    expect(shellPulse("rest", 1, 1, 9)).toBe(1);
    expect(shellPulse("ripple", 1, 0, 0)).toBeCloseTo(1.22, 5);
    expect(shellPulse("pulse", 0, 1, 0)).toBeCloseTo(1.16, 5);
  });

  it("ignores the mic level while processing — the mic is no longer hearing you", () => {
    expect(shellPulse("swirl", 0, 0, 1)).toBe(shellPulse("swirl", 1, 1, 1));
  });
});

describe("perchWave", () => {
  it("churns the galaxy line while processing, with no mic level at all", () => {
    // micLevel 0 is the real processing case. The listening ripple multiplies BY micLevel, so if
    // processing fell through to the ripple arm this would be a flat zero.
    const w = perchWave("swirl", 40, 0.25, 0, 0.5);
    expect(Math.abs(w)).toBeGreaterThan(0);
    // `Math.abs` is not padding: the ripple arm multiplies by micLevel, so at micLevel 0 it
    // produces NEGATIVE zero whenever the sine is negative, and Object.is(-0, 0) is false.
    expect(Math.abs(perchWave("ripple", 40, 0.25, 0, 0.5))).toBe(0);
  });

  it("travels along the galaxy over time and across x", () => {
    expect(perchWave("swirl", 40, 0, 0, 0.5)).not.toBe(perchWave("swirl", 40, 0.5, 0, 0.5));
    expect(perchWave("swirl", 0, 0.3, 0, 0.5)).not.toBe(perchWave("swirl", 60, 0.3, 0, 0.5));
  });

  it("leaves rest and pulse flat, exactly as before", () => {
    expect(Math.abs(perchWave("rest", 40, 0.25, 1, 0.5))).toBe(0);
    expect(Math.abs(perchWave("pulse", 40, 0.25, 1, 0.5))).toBe(0);
  });
});

describe("deriveFlags with the widened union", () => {
  it("raises the processing flag, and only for processing", () => {
    for (const mode of MODES) {
      expect(deriveFlags("perch", mode).processing).toBe(mode === "processing");
    }
  });

  it("does not reassign listening or speaking", () => {
    for (const mode of MODES) {
      expect(deriveFlags("perch", mode).listening).toBe(mode === "listening");
      expect(deriveFlags("perch", mode).speaking).toBe(mode === "speaking");
    }
  });

  it("keeps YOUR OWN WORDS on screen through the think beat at the perch", () => {
    // Blanking the bubble on end-of-speech would erase what you said at exactly the moment you
    // are waiting to see it acted on. Paired with `still` below so this is not just "always true".
    expect(deriveFlags("perch", "processing").orbTextVisible).toBe(true);
    expect(deriveFlags("perch", "listening").orbTextVisible).toBe(true);
    expect(deriveFlags("perch", "still").orbTextVisible).toBe(false);
    expect(deriveFlags("perch", "speaking").orbTextVisible).toBe(false);
  });

  it("leaves the anchor-derived flags untouched by the new mode", () => {
    // The two axes are independent; widening one must not perturb the other.
    for (const mode of MODES) {
      expect(deriveFlags("center", mode).dimmed).toBe(true);
      expect(deriveFlags("card", mode).cardInfused).toBe(true);
      expect(deriveFlags("row", mode).rowInfused).toBe(true);
      expect(deriveFlags("perch", mode).homeAway).toBe(false);
    }
  });
});

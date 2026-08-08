import { describe, it, expect, beforeEach } from "vitest";
import {
  markHoldOrigin,
  takeHoldOriginAge,
  holdOriginPending,
  clearHoldOrigin,
  HOLD_ORIGIN_MAX_AGE_MS,
} from "./holdOrigin";

// The slot is module state, so a stamp left by one case would be consumed by the next and the
// failure would land in the wrong test.
beforeEach(() => clearHoldOrigin());

describe("holdOrigin", () => {
  it("reports the elapsed time between the keydown and the arm", () => {
    // THE MEASUREMENT ITSELF, which is the whole reason this module exists: the span from the
    // gesture to the moment `start_dictation` is invoked had never been recorded anywhere.
    markHoldOrigin(1_000);
    expect(takeHoldOriginAge(1_042)).toBe(42);
  });

  it("has nothing to report when no hold stamped an origin", () => {
    // An arm from the mic button or the voice menu. Reporting 0 here would be a lie the Rust side
    // could not tell from a genuinely instant hold; `null` says "no gesture", which is the truth.
    expect(takeHoldOriginAge(1_000)).toBeNull();
  });

  it("is one-shot: a second arm cannot re-use the first arm's keydown", () => {
    markHoldOrigin(1_000);
    expect(takeHoldOriginAge(1_010)).toBe(10);
    expect(takeHoldOriginAge(1_020)).toBeNull();
    expect(holdOriginPending()).toBe(false);
  });

  it("clears the slot even when it rejects the value", () => {
    // The rejection paths must consume too. A rejected origin left in place would go on to
    // mislabel the NEXT arm, which is strictly worse than the reading it just refused to publish.
    markHoldOrigin(1_000);
    expect(takeHoldOriginAge(1_000 + HOLD_ORIGIN_MAX_AGE_MS + 1)).toBeNull();
    expect(holdOriginPending()).toBe(false);

    markHoldOrigin(5_000);
    expect(takeHoldOriginAge(4_000)).toBeNull();
    expect(holdOriginPending()).toBe(false);
  });

  it("refuses an origin older than the cap, and accepts one exactly at it", () => {
    // The boundary is asserted from BOTH sides so the comparison cannot silently drift into `>=`
    // (which would reject a legitimate slow arm) or into an unbounded accept.
    markHoldOrigin(0);
    expect(takeHoldOriginAge(HOLD_ORIGIN_MAX_AGE_MS)).toBe(HOLD_ORIGIN_MAX_AGE_MS);

    markHoldOrigin(0);
    expect(takeHoldOriginAge(HOLD_ORIGIN_MAX_AGE_MS + 1)).toBeNull();
  });

  it("refuses a negative age rather than publishing it", () => {
    // `performance.now()` is monotonic so this should be unreachable, which is exactly why it is
    // pinned: an unreachable branch is the one that rots. Rust reconstructs the keydown as
    // `t_cmd - age`, and a negative age there would place the gesture in the FUTURE.
    markHoldOrigin(2_000);
    expect(takeHoldOriginAge(1_999)).toBeNull();
  });

  it("refuses a non-finite reading", () => {
    markHoldOrigin(Number.NaN);
    expect(takeHoldOriginAge(1_000)).toBeNull();
  });

  it("rounds to whole milliseconds, because the wire carries an integer", () => {
    // Rust takes `Option<u64>`; a fractional value would be rejected by serde and the whole arm's
    // origin would be dropped for a rounding difference.
    markHoldOrigin(0);
    const age = takeHoldOriginAge(12.7);
    expect(age).toBe(13);
    expect(Number.isInteger(age)).toBe(true);
  });

  it("lets a newer gesture replace an origin nobody claimed", () => {
    // A hold abandoned before its arm landed leaves a stamp behind. The next hold's keydown is the
    // one whose arm is about to run, so it wins — otherwise the second hold would be billed against
    // the first hold's key press.
    markHoldOrigin(1_000);
    markHoldOrigin(1_500);
    expect(takeHoldOriginAge(1_520)).toBe(20);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  markHoldOrigin,
  takeHoldOriginAge,
  peekHoldOriginAge,
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

  it("lets the cloud path read the origin WITHOUT stealing it from the arm", () => {
    // ONE KEYDOWN, TWO RACING COMMANDS. Push to talk fans out into `start_dictation` (keydown →
    // first captured sample) and `start_cloud_stream` (keydown → relay socket live), and the two
    // race. If the cloud path used the one-shot `take`, whichever invoke happened to run first would
    // consume the slot and the OTHER would report null — silently losing one of the two headline
    // latency numbers, on a coin flip, with nothing to say which.
    markHoldOrigin(1_000);
    expect(peekHoldOriginAge(1_040)).toBe(40);
    expect(holdOriginPending()).toBe(true);
    // Peeking twice is still non-destructive, and the arm still gets its origin afterwards.
    expect(peekHoldOriginAge(1_050)).toBe(50);
    expect(takeHoldOriginAge(1_060)).toBe(60);
    expect(holdOriginPending()).toBe(false);
  });

  it("refuses the same untrustworthy origins the arm path refuses", () => {
    // A peek that outlived its gesture must not publish an absurd number just because it is only a
    // diagnostic — the two readers have to agree about what is reportable, or an aggregate over the
    // cloud line would include spans the arm line rejected.
    expect(peekHoldOriginAge(0)).toBeNull(); // nothing pending
    markHoldOrigin(0);
    expect(peekHoldOriginAge(HOLD_ORIGIN_MAX_AGE_MS + 1)).toBeNull();
    expect(peekHoldOriginAge(-5)).toBeNull(); // non-monotonic clock
    // ...and rejecting a value must NOT clear the slot, unlike `takeHoldOriginAge`.
    expect(holdOriginPending()).toBe(true);
    expect(peekHoldOriginAge(25)).toBe(25);
  });

  it("peek and take agree on the reportable age for the SAME origin — at every bound, not just the sampled ones", () => {
    // The two readers score the SAME keydown for two racing commands (arm vs cloud), so an aggregate
    // over the cloud line must never admit a span the arm line rejected. The cases above pin that at
    // hand-picked points; this pins it as an INVARIANT across the whole boundary, which is what a
    // one-character drift in one function's bound (`>` → `>=`, a dropped `Number.isFinite`) would
    // break — the failure that has no test between the two copies when the rule is duplicated.
    //
    // `peek` must not consume, so it is measured first each time and the slot re-stamped for `take`.
    const origin = 1_000;
    const ages = [
      0,
      1,
      12.4,
      12.6,
      HOLD_ORIGIN_MAX_AGE_MS - 1,
      HOLD_ORIGIN_MAX_AGE_MS, // accepted exactly at the cap
      HOLD_ORIGIN_MAX_AGE_MS + 1, // rejected one past it
      -1, // non-monotonic clock
    ];
    for (const age of ages) {
      markHoldOrigin(origin);
      const peeked = peekHoldOriginAge(origin + age);
      const taken = takeHoldOriginAge(origin + age);
      expect(peeked).toBe(taken);
    }
  });
});

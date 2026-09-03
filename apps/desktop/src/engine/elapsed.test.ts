// formatElapsed lives here (engine/elapsed) as the app's ONE elapsed-duration vocabulary. The
// happy-path bands are also exercised through the sidebar in
// components/AgentSidebar.elapsedTimer.test.ts; this file pins the FAIL-SAFE contract that a
// component test cannot reach, because every caller pre-wraps the argument in `Math.max(0, …)`.
//
// The bug this guards: `Math.max(0, NaN)` is `NaN`, not `0`, so an undefined/absent timestamp
// (`now - undefined`) survives that wrapper and the last band would print "NaNd" into the UI.

import { describe, expect, it } from "vitest";
import { formatElapsed } from "./elapsed";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatElapsed — fail-safe on non-finite / negative input", () => {
  // Assert the SIDE EFFECT (what the UI would render), not just "it didn't throw".
  it("renders '0s' for NaN instead of the literal 'NaNd'", () => {
    expect(formatElapsed(NaN)).toBe("0s");
  });

  it("renders '0s' for a negative duration (clock skew) instead of '-5s'", () => {
    expect(formatElapsed(-5 * SEC)).toBe("0s");
    expect(formatElapsed(-1)).toBe("0s");
  });

  it("renders '0s' for Infinity instead of 'Infinityd'", () => {
    expect(formatElapsed(Infinity)).toBe("0s");
    expect(formatElapsed(-Infinity)).toBe("0s");
  });
});

describe("formatElapsed — valid input is unchanged by the guard (the other direction)", () => {
  // If the guard ever over-reached (e.g. `ms <= 0` swallowing 0, or a bad isFinite test), these
  // would red — pinning that the fail-safe branch only fires for garbage.
  it("still formats the seconds band", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(1 * SEC)).toBe("1s");
    expect(formatElapsed(99.9 * SEC)).toBe("99s");
  });

  it("still formats minutes / hours / days to one stripped decimal", () => {
    expect(formatElapsed(102 * SEC)).toBe("1.7m");
    expect(formatElapsed(120 * SEC)).toBe("2m");
    expect(formatElapsed(2 * HOUR)).toBe("2h");
    expect(formatElapsed(2.5 * DAY)).toBe("2.5d");
  });
});

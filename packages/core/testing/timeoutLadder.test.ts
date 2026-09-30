// THE ONE TEST THAT CAN SEE THE WHOLE CONCIERGE TIMEOUT LADDER (bead `sparkle-fcdmh0`).
//
// The per-package suites each pinned one side of the transport bound — mcp-control its floor,
// desktop its ceiling — and at today's values those are the same number, so a one-second move on
// any rung passed in one package and red in the other. This file reads every rung from its own
// declaration and asserts the JOINT constraint, then pins the solver in BOTH directions against
// fixtures: a ladder that genuinely fits must be allowed, and each way of breaking it must be named.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LADDER_SOURCES,
  describeTimeoutLadder,
  readLadderValue,
  readTimeoutLadder,
  solveTimeoutLadder,
  type TimeoutLadder,
} from "./timeoutLadder";

/** Today's measured values, copied ONLY as a fixture baseline for the what-if cases below. The
 *  real-sources test does not use this: it reads the declarations. */
const TODAY: TimeoutLadder = {
  bdTimeout: 30_000,
  readerDrainGrace: 5_000,
  briefDeliveryTimeout: 45_000,
  conciergeToolTimeout: 50_000,
  bridgeDefaultTimeout: 30_000,
  stalledAfter: 60_000,
};

describe("the concierge timeout ladder, read from every package at once", () => {
  it("fits as a whole on the live sources", () => {
    const ladder = readTimeoutLadder();
    const solved = solveTimeoutLadder(ladder);
    expect(solved.violations, describeTimeoutLadder(ladder)).toEqual([]);
    // Not vacuous: the solver really derived a range and the transport sits inside it.
    expect(solved.transportFloorMs).toBeGreaterThan(0);
    expect(ladder.conciergeToolTimeout).toBeGreaterThanOrEqual(solved.transportFloorMs);
    expect(ladder.conciergeToolTimeout).toBeLessThanOrEqual(solved.transportCeilingMs);
  });

  it("the fixture baseline still mirrors the live sources, so the what-ifs describe THIS system", () => {
    expect(readTimeoutLadder()).toEqual(TODAY);
  });
});

describe("solveTimeoutLadder — allows what fits", () => {
  // The NARROWING direction: a solver that refused more would red these.
  it("accepts today's ladder, whose floor and ceiling coincide exactly", () => {
    const s = solveTimeoutLadder(TODAY);
    expect(s.transportFloorMs).toBe(50_000);
    expect(s.transportCeilingMs).toBe(50_000);
    expect(s.violations).toEqual([]);
  });

  it("accepts a roomier ladder", () => {
    const s = solveTimeoutLadder({ ...TODAY, stalledAfter: 75_000, conciergeToolTimeout: 55_000 });
    expect(s.violations).toEqual([]);
  });
});

describe("solveTimeoutLadder — names every way the ladder breaks", () => {
  // The WIDENING direction: a solver that refused less would red these. Each is the cross-package
  // move a single-package suite used to report as a clean pass.
  it("raising BD_TIMEOUT by one second makes the ladder INFEASIBLE, not just the transport short", () => {
    const s = solveTimeoutLadder({ ...TODAY, bdTimeout: 31_000 });
    expect(s.violations.some((v) => v.startsWith("INFEASIBLE"))).toBe(true);
    expect(s.violations.some((v) => v.includes("under its floor"))).toBe(true);
  });

  it("lowering STALLED_AFTER_MS by one second makes the ladder INFEASIBLE", () => {
    const s = solveTimeoutLadder({ ...TODAY, stalledAfter: 59_000 });
    expect(s.violations.some((v) => v.startsWith("INFEASIBLE"))).toBe(true);
    expect(s.violations.some((v) => v.includes("over its ceiling"))).toBe(true);
  });

  it("raising the brief wait past the transport's floor is reported", () => {
    const s = solveTimeoutLadder({ ...TODAY, briefDeliveryTimeout: 46_000 });
    expect(s.violations.some((v) => v.startsWith("INFEASIBLE"))).toBe(true);
  });

  it("a transport bound outside a FEASIBLE range is reported on the side it left", () => {
    const roomy = { ...TODAY, stalledAfter: 75_000 };
    expect(solveTimeoutLadder({ ...roomy, conciergeToolTimeout: 49_999 }).violations).toEqual([
      expect.stringContaining("under its floor"),
    ]);
    expect(solveTimeoutLadder({ ...roomy, conciergeToolTimeout: 65_001 }).violations).toEqual([
      expect.stringContaining("over its ceiling"),
    ]);
  });

  it("a brief wait that no longer covers the slowest measured spawn is reported", () => {
    const s = solveTimeoutLadder({ ...TODAY, briefDeliveryTimeout: 39_800 });
    expect(s.violations).toEqual([expect.stringContaining("slowest measured spawn")]);
  });

  it("the override must stay above the bridge default", () => {
    const s = solveTimeoutLadder({ ...TODAY, bridgeDefaultTimeout: 50_000 });
    expect(s.violations.some((v) => v.includes("under its floor"))).toBe(true);
  });
});

describe("readLadderValue — reads declarations, and refuses to guess", () => {
  const fakeRoot = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "timeout-ladder-"));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return root;
  };

  it("converts Rust seconds and TS underscored milliseconds", () => {
    const root = fakeRoot({
      [LADDER_SOURCES.bdTimeout.file]: "pub(crate) const BD_TIMEOUT: Duration = Duration::from_secs(42);\n",
      [LADDER_SOURCES.stalledAfter.file]: "export const STALLED_AFTER_MS = 61_500;\n",
    });
    expect(readLadderValue("bdTimeout", root)).toBe(42_000);
    expect(readLadderValue("stalledAfter", root)).toBe(61_500);
  });

  it("a comment quoting the number is not a declaration", () => {
    const root = fakeRoot({
      [LADDER_SOURCES.stalledAfter.file]: "// STALLED_AFTER_MS = 60_000 used to live here\n",
    });
    expect(() => readLadderValue("stalledAfter", root)).toThrow(/no longer declares stalledAfter/);
  });

  it("an unreadable source throws rather than reporting agreement", () => {
    expect(() => readLadderValue("conciergeToolTimeout", fakeRoot({}))).toThrow(/cannot read/);
  });
});

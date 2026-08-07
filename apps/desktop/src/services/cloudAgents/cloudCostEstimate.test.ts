import { describe, expect, it } from "vitest";
import { cloudCostLine, humanizeMinutes } from "./cloudCostEstimate";

// The live server numbers, used as REALISM anchors rather than as a source of truth — every value
// is passed in explicitly, so nothing here can become the client's second copy of a price.
const RATE = 0.9; // ¢/min → $0.54/hour
const FLOOR = 100; // ¢ — the server's start floor

describe("cloudCostLine — the rate", () => {
  it.each([
    [RATE, "$0.54/hour"],
    // The guard that matters if the markup ever changes: the output must FOLLOW the input. A module
    // that had quietly kept its own 0.9 would pass the first row and fail these.
    [4.5, "$2.70/hour"],
    [0.45, "$0.27/hour"],
  ])("quotes %p¢/min as %s", (rate, expected) => {
    expect(cloudCostLine(rate, 10_000)).toContain(expected);
  });

  // THE OLDER-SERVER CASE, and why this returns null instead of a default: `/me` carries no
  // `cloudAgentPricing` before this shipped, so the rate is genuinely unknown — and a fallback rate
  // would be exactly the duplicated pricing rule that produced the 50¢ bug.
  it.each([[undefined], [0], [-1], [Number.NaN]])(
    "returns null for rate %p — showing nothing beats inventing a price",
    (rate) => {
      expect(cloudCostLine(rate as number | undefined, 10_000)).toBeNull();
    },
  );
});

describe("cloudCostLine — the runway", () => {
  it("says what the balance FUNDS, never what the run WILL COST", () => {
    // The wording is the contract. A run's length is unknown, so a total would be invented — and
    // this is the sentence someone reads before spending money.
    const line = cloudCostLine(RATE, 1240, FLOOR)!;
    expect(line).toBe("About $0.54/hour of running time — your balance funds 23 hours.");
    expect(line).not.toMatch(/will cost|total/i);
  });

  it("drops the runway clause on an empty wallet rather than saying 'funds 0 min'", () => {
    expect(cloudCostLine(RATE, 0)).toBe("About $0.54/hour of running time.");
  });

  it("never renders a negative runway — a ledger may settle below zero", () => {
    expect(cloudCostLine(RATE, -500)).toBe("About $0.54/hour of running time.");
  });
});

// THE CONTRACT-DRIFT CASE. `canStartCloudAgent` refuses below the server's floor, so a balance under
// it funds NO run — quoting a runway there states a runtime the user cannot buy. At 0.9¢/min a 50¢
// balance divides to a confident "funds 56 min" for a start that is rejected outright.
describe("cloudCostLine — the server's start floor", () => {
  it.each([
    [50, "You need $1.00 to start."],
    [99, "You need $1.00 to start."],
    [0, "You need $1.00 to start."],
  ])("at %p¢, below the floor, says what it takes to start", (balance, expected) => {
    const line = cloudCostLine(RATE, balance, FLOOR)!;
    expect(line).toContain(expected);
    expect(line).not.toMatch(/funds/);
    // The rate is still stated — the user should know the price even when they cannot start yet.
    expect(line).toContain("$0.54/hour");
  });

  it.each([
    [100, "1.9 hours"],
    [1240, "23 hours"],
  ])("at %p¢, at or above the floor, quotes the runway again", (balance, expected) => {
    expect(cloudCostLine(RATE, balance, FLOOR)).toContain(`funds ${expected}`);
  });

  it("follows the SERVER's floor rather than a number of its own", () => {
    // A caller handed a different floor must get that floor back, or the client is deciding
    // affordability — the precise mistake the 50¢ constant made.
    expect(cloudCostLine(RATE, 300, 500)).toContain("You need $5.00 to start.");
    expect(cloudCostLine(RATE, 300, 200)).toContain("funds");
  });

  it("leaves the runway unconditional when no floor is supplied", () => {
    expect(cloudCostLine(RATE, 50)).toContain("funds 55 min");
  });
});

describe("humanizeMinutes", () => {
  it.each([
    [45, "45 min"],
    [1, "1 min"], // an abbreviation takes no plural
    [2, "2 min"],
    [90, "1.5 hours"],
    [120, "2 hours"],
    [60 * 22, "22 hours"], // drops a trailing .0 rather than "22.0 hours"
    [60 * 48, "2 days"],
    [60 * 100, "4 days"],
  ])("renders %p minutes as %s", (minutes, expected) => {
    expect(humanizeMinutes(minutes)).toBe(expected);
  });

  // The plural must key off the RENDERED number. `trim` rounds to one decimal AND drops a trailing
  // ".0", so every duration from 60 up to (not including) 63 minutes renders "1" — a plural keyed
  // on the raw value would still say "1 hours" at 61 while looking correct in a spot check at
  // exactly 60. 63 min is 1.05 h, which rounds to "1.1", so that is where the band ends.
  it.each([[60], [61], [62], [62.9]])(
    "says '1 hour' at %p minutes, never '1 hours'",
    (minutes) => {
      expect(humanizeMinutes(minutes)).toBe("1 hour");
    },
  );

  // Both edges of that band, so a change to the rounding cannot widen or narrow it unnoticed.
  it("resumes the plural the moment the rendered number stops being 1", () => {
    expect(humanizeMinutes(63)).toBe("1.1 hours");
    expect(humanizeMinutes(66)).toBe("1.1 hours");
  });

  it.each([[0], [0.4], [Number.NaN]])(
    "is null at %p — a duration too small to state honestly",
    (minutes) => {
      expect(humanizeMinutes(minutes)).toBeNull();
    },
  );
});

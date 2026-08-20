import { describe, it, expect } from "vitest";
import {
  ACTIVITY_STALE_MS,
  activityAgeMs,
  formatActivityAge,
  isActivityStale,
} from "./activityFreshness";

const NOW = 1_800_000_000_000;

describe("activityAgeMs", () => {
  it("returns the elapsed ms for a past stamp", () => {
    expect(activityAgeMs(NOW - 5_000, NOW)).toBe(5_000);
  });

  it("is null for a MISSING stamp — unknown age, not zero", () => {
    // The distinction is load-bearing: 0 would read as 'just written', which is the exact
    // over-trust this module exists to remove. Unknown must stay unknown.
    expect(activityAgeMs(undefined, NOW)).toBeNull();
  });

  it("is null for a FUTURE stamp rather than a negative age", () => {
    expect(activityAgeMs(NOW + 10_000, NOW)).toBeNull();
  });

  it("is 0 exactly at the stamp instant", () => {
    expect(activityAgeMs(NOW, NOW)).toBe(0);
  });
});

describe("isActivityStale — a self-report too old (or too unknown) to read as current", () => {
  it("a fresh stamp within the window is NOT stale", () => {
    expect(isActivityStale(NOW - (ACTIVITY_STALE_MS - 1), NOW)).toBe(false);
  });

  it("a stamp past the window IS stale", () => {
    expect(isActivityStale(NOW - (ACTIVITY_STALE_MS + 1), NOW)).toBe(true);
  });

  it("exactly at the window boundary is NOT yet stale (strictly greater)", () => {
    expect(isActivityStale(NOW - ACTIVITY_STALE_MS, NOW)).toBe(false);
  });

  it("a MISSING stamp is STALE — the fail direction is distrust", () => {
    // This is the death the module is named for: an hours-old 'blocked on the outage' line with no
    // durable stamp (e.g. restored from persistence) must NOT be treated as a live self-report.
    expect(isActivityStale(undefined, NOW)).toBe(true);
  });

  it("a future stamp is treated as stale (unknown age), never as fresh", () => {
    expect(isActivityStale(NOW + 60_000, NOW)).toBe(true);
  });

  it("honours a custom staleMs", () => {
    expect(isActivityStale(NOW - 5_000, NOW, 10_000)).toBe(false);
    expect(isActivityStale(NOW - 15_000, NOW, 10_000)).toBe(true);
  });
});

describe("formatActivityAge — the coarse quote suffix", () => {
  it("reads 'just now' under ten seconds", () => {
    expect(formatActivityAge(NOW - 3_000, NOW)).toBe("just now");
  });

  it("counts seconds, then minutes, then hours, then days", () => {
    expect(formatActivityAge(NOW - 42_000, NOW)).toBe("42s ago");
    expect(formatActivityAge(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatActivityAge(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatActivityAge(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  it("is null for an unknown (missing/future) stamp so the caller shows no false age", () => {
    expect(formatActivityAge(undefined, NOW)).toBeNull();
    expect(formatActivityAge(NOW + 1_000, NOW)).toBeNull();
  });
});

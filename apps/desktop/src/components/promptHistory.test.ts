import { describe, it, expect } from "vitest";
import { formatAgo, oneLine } from "./promptHistory";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatAgo", () => {
  const now = 1_000_000_000_000;

  it("shows 'just now' for very recent (and clamps future skew)", () => {
    expect(formatAgo(now, now)).toBe("just now");
    expect(formatAgo(now, now - 10 * SEC)).toBe("just now");
    expect(formatAgo(now, now + 5 * SEC)).toBe("just now");
  });

  it("rolls up into minutes, hours, and days", () => {
    expect(formatAgo(now, now - 3 * MIN)).toBe("3m");
    expect(formatAgo(now, now - 2 * HOUR)).toBe("2h");
    expect(formatAgo(now, now - 5 * DAY)).toBe("5d");
  });

  it("crosses unit boundaries sensibly", () => {
    expect(formatAgo(now, now - 59 * MIN)).toBe("59m");
    expect(formatAgo(now, now - 90 * MIN)).toBe("2h");
    expect(formatAgo(now, now - 23 * HOUR)).toBe("23h");
  });
});

describe("oneLine", () => {
  it("collapses whitespace and newlines and trims", () => {
    expect(oneLine("  fix   the\n\n login   bug \n")).toBe("fix the login bug");
  });
});

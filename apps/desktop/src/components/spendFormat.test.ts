import { describe, expect, it } from "vitest";
import {
  axisLabelIndexes,
  barPercent,
  costCell,
  formatTokens,
  formatUsd,
  maxDaily,
  shortDate,
} from "./spendFormat";

describe("formatTokens", () => {
  it("stays exact below a thousand and compacts above it", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(1_234)).toBe("1.2K");
    expect(formatTokens(45_600_000)).toBe("45.6M");
    expect(formatTokens(12_800_000_000)).toBe("12.8B");
  });

  it("drops a trailing .0 rather than printing 45.0K", () => {
    expect(formatTokens(45_000)).toBe("45K");
    expect(formatTokens(3_000_000)).toBe("3M");
  });

  it("treats junk as zero instead of rendering NaN", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("formatUsd", () => {
  it("formats whole dollars and cents with separators", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.3)).toBe("$12.30");
    expect(formatUsd(1234.567)).toBe("$1,234.57");
  });

  it("shows a tiny nonzero cost as <$0.01, never as free", () => {
    // Rounding a real cost down to "$0.00" would tell the user a run was free when it wasn't.
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.0000001)).toBe("<$0.01");
  });
});

describe("costCell", () => {
  it("renders a priced row's cost", () => {
    expect(costCell(4.2, 0)).toBe("$4.20");
    expect(costCell(0, 0)).toBe("$0.00");
  });

  it("returns null for a wholly unpriced row so the UI can say 'unknown', not '$0.00'", () => {
    expect(costCell(0, 5_000)).toBeNull();
  });

  it("still shows the priced portion when a row mixes known and unknown models", () => {
    expect(costCell(1.5, 5_000)).toBe("$1.50");
  });
});

describe("shortDate", () => {
  it("humanizes an ISO date", () => {
    expect(shortDate("2026-07-24")).toBe("Jul 24");
    expect(shortDate("2026-01-05")).toBe("Jan 5");
    expect(shortDate("2026-12-31")).toBe("Dec 31");
  });

  it("passes through anything that isn't a plain ISO date", () => {
    expect(shortDate("not-a-date")).toBe("not-a-date");
    expect(shortDate("2026-13-01")).toBe("2026-13-01");
  });
});

describe("barPercent", () => {
  it("scales against the tallest day", () => {
    expect(barPercent(100, 100)).toBe(100);
    expect(barPercent(50, 100)).toBe(50);
  });

  it("floors a small NONZERO day so it stays visible", () => {
    expect(barPercent(1, 1_000_000)).toBe(2);
  });

  it("keeps a zero day at exactly zero — the floor must not invent usage", () => {
    expect(barPercent(0, 1_000_000)).toBe(0);
  });

  it("handles an all-zero window without dividing by zero", () => {
    expect(barPercent(0, 0)).toBe(0);
    expect(barPercent(5, 0)).toBe(0);
  });
});

describe("maxDaily", () => {
  it("finds the tallest day, and is 0 for an empty or idle window", () => {
    expect(maxDaily([])).toBe(0);
    expect(maxDaily([{ tokens: { total: 0 } }, { tokens: { total: 0 } }])).toBe(0);
    expect(
      maxDaily([{ tokens: { total: 5 } }, { tokens: { total: 90 } }, { tokens: { total: 12 } }]),
    ).toBe(90);
  });
});

describe("axisLabelIndexes", () => {
  it("labels every column when there are few of them", () => {
    expect([...axisLabelIndexes(3)]).toEqual([0, 1, 2]);
  });

  it("spreads labels and always includes the most recent column", () => {
    const idx = axisLabelIndexes(28);
    expect(idx.has(0)).toBe(true);
    expect(idx.has(27)).toBe(true);
    expect(idx.size).toBeLessThanOrEqual(6);
  });

  it("is empty for an empty chart", () => {
    expect(axisLabelIndexes(0).size).toBe(0);
  });
});

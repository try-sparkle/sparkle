import { describe, it, expect } from "vitest";
import { stalenessTier, growNudge, STALE_WARN, GROW_COMMITS, GROW_LINES } from "./nudges";

describe("nudges", () => {
  it("staleness tiers: none at 0, info below warn, warn inclusive at threshold", () => {
    expect(stalenessTier(0)).toBe("none");
    expect(stalenessTier(1)).toBe("info");
    expect(stalenessTier(STALE_WARN - 1)).toBe("info");
    expect(stalenessTier(STALE_WARN)).toBe("warn"); // inclusive
  });

  it("grow nudge fires inclusively at either threshold", () => {
    const base = { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 };
    expect(growNudge({ ...base, ahead: GROW_COMMITS - 1 })).toBe(false);
    expect(growNudge({ ...base, ahead: GROW_COMMITS })).toBe(true);
    expect(growNudge({ ...base, insertions: GROW_LINES - 1 })).toBe(false);
    expect(growNudge({ ...base, insertions: GROW_LINES })).toBe(true);
    expect(growNudge({ ...base, insertions: 600, deletions: 400 })).toBe(true); // sum >= 1000
  });
});

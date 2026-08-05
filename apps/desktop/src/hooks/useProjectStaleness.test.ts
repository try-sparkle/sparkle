// The fail-closed rule between `repo_root_staleness` and the tab badge (bead sparkle-cuv2h).
//
// This is the seam where a WRONG answer is worse than no answer. The backend deliberately reports
// `unknown` when it cannot measure a checkout (no remote, unborn HEAD, unresolvable base) rather
// than a confident "0 behind" — and that distinction is only preserved if this mapping refuses to
// turn anything but a measured, stale reading into a badge. Get it backwards and the UI paints
// reassurance over exactly the trees nobody has verified, which is the failure the badge exists to
// prevent (a six-day-old checkout read as current).
//
// `toBadge` is a pure function precisely so this can be asserted without mocking a poll.
import { describe, expect, it } from "vitest";
import { toBadge, type RootStaleness } from "./useProjectStaleness";

function reading(over: Partial<RootStaleness> = {}): RootStaleness {
  return {
    behind: 0,
    stale: false,
    threshold: 25,
    headBranch: "main",
    base: "origin/main",
    unknown: false,
    ...over,
  };
}

describe("toBadge", () => {
  it("badges a measured, stale checkout with its count and base", () => {
    expect(toBadge(reading({ behind: 1696, stale: true }))).toEqual({
      behind: 1696,
      base: "origin/main",
    });
  });

  it("does NOT badge an unknown reading, even one that claims to be stale", () => {
    // The belt-and-braces case: `unknown` wins over `stale` no matter what else the struct says,
    // because an unmeasurable tree has no trustworthy count to show.
    expect(toBadge(reading({ unknown: true, stale: true, behind: 99 }))).toBeNull();
  });

  it("does not badge a fresh checkout", () => {
    expect(toBadge(reading({ behind: 0, stale: false }))).toBeNull();
  });

  it("does not badge a checkout behind but under its threshold", () => {
    // `stale` is the backend's verdict; the count alone must not promote it to a badge.
    expect(toBadge(reading({ behind: 3, stale: false }))).toBeNull();
  });

  it("does not badge a stale reading with no base to name", () => {
    // A number with nothing to compare it against is not actionable.
    expect(toBadge(reading({ behind: 40, stale: true, base: "" }))).toBeNull();
  });

  it("treats a missing/failed reading as unknown", () => {
    expect(toBadge(null)).toBeNull();
    expect(toBadge(undefined)).toBeNull();
  });
});

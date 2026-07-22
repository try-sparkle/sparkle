import { describe, it, expect } from "vitest";
import {
  formatPrBadge,
  OPEN_PR_POLL_MS,
  OPEN_PR_QUERY_LIMIT,
  prMergeEligibility,
} from "./openPrs";

describe("formatPrBadge", () => {
  it("renders a count when PRs are waiting", () => {
    expect(formatPrBadge(1)).toBe("1 PR waiting");
    expect(formatPrBadge(2)).toBe("2 PRs waiting");
    expect(formatPrBadge(47)).toBe("47 PRs waiting");
  });

  it("singularizes at exactly one", () => {
    expect(formatPrBadge(1)).toContain("1 PR ");
    expect(formatPrBadge(2)).toContain("PRs");
  });

  it("renders NOTHING for a known zero — an always-present '0' is chrome noise", () => {
    expect(formatPrBadge(0)).toBeNull();
  });

  it("renders NOTHING for unknown, and that is a DIFFERENT fact from zero", () => {
    // The whole point of the badge is that unmerged work stops being invisible. A confident "0 PRs"
    // on a machine that merely failed to look (no gh, unauthed, offline, no remote) would be the
    // exact false reassurance it exists to prevent — so null must never render as a count.
    expect(formatPrBadge(null)).toBeNull();
    // They agree on what they RENDER, but they are not the same input, and the distinction is
    // preserved all the way down: Rust returns Option<u32>, the service maps failure to null, and
    // only this function collapses them — deliberately, and at the last possible moment.
    expect(formatPrBadge(null)).toBe(formatPrBadge(0));
  });

  it("treats a negative count as nothing rather than rendering '-1 PRs waiting'", () => {
    expect(formatPrBadge(-1)).toBeNull();
  });

  it("polls far slower than the sidebar, because it shells out over the network", () => {
    // The sidebar status poll runs every 30s. This one spawns `gh` and touches the network, and an
    // unmerged PR is a slow-moving fact — a chatty probe spends rate limit for no added signal.
    expect(OPEN_PR_POLL_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("formatPrBadge — query saturation (roborev 43840)", () => {
  it("renders '100+' at the query limit rather than a bare, understated count", () => {
    // The probe asks gh for at most OPEN_PR_QUERY_LIMIT rows. A count AT the limit means "at least
    // this many" — showing a plain "100" would silently understate, the same false-reassurance
    // failure the null-vs-zero rule guards against, one step further out.
    expect(formatPrBadge(OPEN_PR_QUERY_LIMIT)).toBe("100+ PRs waiting");
    expect(formatPrBadge(OPEN_PR_QUERY_LIMIT + 25)).toBe("100+ PRs waiting");
  });

  it("still renders an exact count just below the limit", () => {
    expect(formatPrBadge(OPEN_PR_QUERY_LIMIT - 1)).toBe("99 PRs waiting");
  });
});

describe("prMergeEligibility", () => {
  it("allows a green, mergeable PR", () => {
    expect(prMergeEligibility({ checks: "passing", mergeable: "mergeable" })).toEqual({
      canMerge: true,
      reason: null,
    });
  });

  it("allows a PR with NO checks — 'none' is not a failure", () => {
    expect(prMergeEligibility({ checks: "none", mergeable: "mergeable" }).canMerge).toBe(true);
  });

  it("allows merging when mergeability is still UNKNOWN — gh is the backstop", () => {
    // GitHub computes mergeability asynchronously, so a freshly opened PR reads 'unknown'. Blocking
    // on that would strand a perfectly mergeable PR; gh refuses at merge time if it's actually not.
    expect(prMergeEligibility({ checks: "passing", mergeable: "unknown" }).canMerge).toBe(true);
  });

  it("blocks a conflicting PR regardless of checks", () => {
    const e = prMergeEligibility({ checks: "passing", mergeable: "conflicting" });
    expect(e.canMerge).toBe(false);
    expect(e.reason).toMatch(/conflict/i);
  });

  it("blocks a PR whose checks are failing", () => {
    const e = prMergeEligibility({ checks: "failing", mergeable: "mergeable" });
    expect(e.canMerge).toBe(false);
    expect(e.reason).toMatch(/failing/i);
  });

  it("blocks while checks are still running — wait for checks, then merge", () => {
    const e = prMergeEligibility({ checks: "pending", mergeable: "mergeable" });
    expect(e.canMerge).toBe(false);
    expect(e.reason).toMatch(/running/i);
  });

  it("lets a conflict take precedence over a failing-checks reason", () => {
    // Both are blocking; the conflict message is the more actionable one to lead with.
    expect(prMergeEligibility({ checks: "failing", mergeable: "conflicting" }).reason).toMatch(
      /conflict/i,
    );
  });
});

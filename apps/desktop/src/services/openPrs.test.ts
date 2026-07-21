import { describe, it, expect } from "vitest";
import { formatPrBadge, OPEN_PR_POLL_MS, OPEN_PR_QUERY_LIMIT } from "./openPrs";

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

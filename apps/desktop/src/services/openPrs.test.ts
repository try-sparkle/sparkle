import { describe, it, expect } from "vitest";
import {
  formatPrBadge,
  OPEN_PR_POLL_MS,
  OPEN_PR_QUERY_LIMIT,
  prMergeEligibility,
  prStatusDot,
  type PrRow,
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

const ALL_CHECKS: PrRow["checks"][] = ["passing", "pending", "failing", "none"];
const ALL_MERGEABLE: PrRow["mergeable"][] = ["mergeable", "conflicting", "unknown"];

describe("prStatusDot", () => {
  it("NEVER renders green for a PR that cannot be merged (the #779 regression)", () => {
    // THE headline property, and the one the old checks-only dot violated. PR #779 had 17 passing
    // checks and conflicted with main: it rendered the same confident green as a landable PR, which
    // is what sent the user to click a Merge button that could not work.
    const conflicting = prStatusDot({ checks: "passing", mergeable: "conflicting" });
    expect(conflicting.tone).toBe("blocked");
    expect(conflicting.title).toMatch(/conflict/i);
  });

  it("holds tone==='ready' ⟹ canMerge across EVERY checks × mergeable pair", () => {
    // Exhaustive rather than case-by-case: green means "you can merge this right now", so the dot
    // may never promise something the merge gate would refuse. This is what stops the two from
    // drifting apart again — they drifted once and shipped #779's false green.
    for (const checks of ALL_CHECKS) {
      for (const mergeable of ALL_MERGEABLE) {
        const pr = { checks, mergeable };
        if (prStatusDot(pr).tone === "ready")
          expect(prMergeEligibility(pr).canMerge, `green over a blocker: ${checks}/${mergeable}`)
            .toBe(true);
      }
    }
  });

  it("is green ONLY for passing checks on a confirmed-mergeable PR", () => {
    // Pins the one green case, so the implication above cannot be satisfied trivially by a function
    // that never returns "ready" at all.
    const green = ALL_CHECKS.flatMap((checks) =>
      ALL_MERGEABLE.map((mergeable) => ({ checks, mergeable })),
    ).filter((pr) => prStatusDot(pr).tone === "ready");
    expect(green).toEqual([{ checks: "passing", mergeable: "mergeable" }]);
  });

  it("treats UNKNOWN mergeability as waiting, not ready — we do not know yet", () => {
    // The button stays enabled here on purpose (gh is the backstop), but the DOT must not promise.
    // GitHub invalidates mergeability on every push to the base branch, so this window is routine.
    const d = prStatusDot({ checks: "passing", mergeable: "unknown" });
    expect(d.tone).toBe("waiting");
    expect(prMergeEligibility({ checks: "passing", mergeable: "unknown" }).canMerge).toBe(true);
  });

  it("reports the blocker, not the CI rollup, when both could apply", () => {
    expect(prStatusDot({ checks: "failing", mergeable: "conflicting" }).title).toMatch(/conflict/i);
    expect(prStatusDot({ checks: "failing", mergeable: "mergeable" }).tone).toBe("blocked");
    expect(prStatusDot({ checks: "pending", mergeable: "mergeable" }).tone).toBe("waiting");
    expect(prStatusDot({ checks: "none", mergeable: "mergeable" }).tone).toBe("none");
  });

  it("always gives a non-empty reason, so a dot is never an unexplained colour", () => {
    for (const checks of ALL_CHECKS)
      for (const mergeable of ALL_MERGEABLE)
        expect(prStatusDot({ checks, mergeable }).title.length).toBeGreaterThan(0);
  });
});

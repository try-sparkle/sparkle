// The REVIVAL RULE — when a dismissal has run out and the pull request comes back.
//
// This is the part of "Dismiss" with a judgement in it, and the part that decides whether the
// feature means "not now" (the ask) or "never" (the failure mode the founder has been bitten by).
// Pure, so every trigger and every non-trigger is asserted without Tauri, a network, or `gh`.
import { describe, it, expect } from "vitest";
import {
  dismissedNumbers,
  fingerprintOf,
  isRevived,
  partitionDismissals,
  type PrDismissal,
} from "./prDismissals";
import type { PrRow } from "./openPrs";

/** A green, mergeable PR in a repo the user CANNOT merge into — the founder's tkmx-client case. */
const pr = (over: Partial<PrRow> = {}): PrRow => ({
  number: 39,
  title: "feat: a thing",
  headRefName: "feature",
  url: "https://github.com/o/r/pull/39",
  checks: "passing",
  mergeable: "mergeable",
  mergeStateStatus: "clean",
  headRefOid: "sha-old",
  viewerCanMerge: false,
  ...over,
});

/** The dismissal `pr()` produces — recorded at the moment it was waved away.
 *
 *  `tone: "blocked"` because that is what the gate ACTUALLY says about a no-rights PR, whatever its
 *  checks look like. A fixture that recorded "ready" here would be a fingerprint no real dismissal
 *  can produce, and every assertion built on it would be testing a state that cannot occur. */
const dismissal = (over: Partial<PrDismissal> = {}): PrDismissal => ({
  number: 39,
  headRefOid: "sha-old",
  tone: "blocked",
  viewerCanMerge: false,
  dismissedAt: 1_700_000_000,
  ...over,
});

describe("fingerprintOf", () => {
  it("records the head commit, the readiness tone, and the merge rights", () => {
    // `tone` is "blocked" and not "ready" because merge rights are the FIRST thing the gate reads:
    // this PR's checks are green and GitHub calls it clean, and it still cannot be merged.
    expect(fingerprintOf(pr())).toEqual({
      headRefOid: "sha-old",
      tone: "blocked",
      viewerCanMerge: false,
    });
  });

  it("stores an UNKNOWN merge right as false, so gaining rights stays observable", () => {
    // If an unknown were stored as `true`, a PR dismissed during a `gh` outage could never revive
    // on the "you were granted write access" trigger — the transition would already look complete.
    expect(fingerprintOf(pr({ viewerCanMerge: null })).viewerCanMerge).toBe(false);
    expect(fingerprintOf(pr({ viewerCanMerge: undefined })).viewerCanMerge).toBe(false);
  });

  it("records the tone the gate ACTUALLY computes, not a guess about it", () => {
    // A no-rights PR is blocked whatever its checks say — so its fingerprint must say "blocked",
    // or the "it became mergeable" trigger would fire the instant rights arrived AND again on the
    // tone change, and a fingerprint that disagrees with the gate is a fingerprint that lies.
    expect(fingerprintOf(pr({ viewerCanMerge: false })).tone).toBe("blocked");
    expect(fingerprintOf(pr({ viewerCanMerge: true })).tone).toBe("ready");
    expect(fingerprintOf(pr({ viewerCanMerge: true, checks: "failing" })).tone).toBe("blocked");
  });
});

describe("isRevived — the three triggers", () => {
  it("revives when the user GAINS merge rights", () => {
    // The founder's case running backwards: he is added to the repo, so the PR he could do nothing
    // about becomes one he can land. This is the trigger the bead names first.
    expect(isRevived(dismissal({ viewerCanMerge: false }), pr({ viewerCanMerge: true }))).toBe(true);
  });

  it("revives when the PR is PUSHED TO", () => {
    expect(isRevived(dismissal({ headRefOid: "sha-old" }), pr({ headRefOid: "sha-new" }))).toBe(
      true,
    );
  });

  it("revives when a non-green PR BECOMES mergeable", () => {
    const wasRed = dismissal({ tone: "blocked", viewerCanMerge: true });
    const nowGreen = pr({ viewerCanMerge: true, checks: "passing", mergeStateStatus: "clean" });
    expect(isRevived(wasRed, nowGreen)).toBe(true);
  });
});

describe("isRevived — what must NOT revive", () => {
  it("leaves an unchanged PR dismissed — this is the whole point", () => {
    // Green, still no rights, same commit: nothing has changed, so re-offering it would resume the
    // exact nagging the dismissal exists to stop. Every poll asks this question again.
    expect(isRevived(dismissal(), pr())).toBe(false);
  });

  it("does not treat UNKNOWN merge rights as a grant", () => {
    // A failed `gh repo view` — offline, rate-limited, unauthed — must not un-dismiss the fleet.
    expect(isRevived(dismissal({ viewerCanMerge: false }), pr({ viewerCanMerge: null }))).toBe(
      false,
    );
    expect(isRevived(dismissal({ viewerCanMerge: false }), pr({ viewerCanMerge: undefined }))).toBe(
      false,
    );
  });

  it("does not treat a MISSING head commit as a change, in either direction", () => {
    // An older Rust build supplies no `headRefOid`. Comparing against an empty string would revive
    // every dismissal on the very next poll — a dismissal that cannot survive a restart is not one.
    expect(isRevived(dismissal({ headRefOid: "sha-old" }), pr({ headRefOid: undefined }))).toBe(
      false,
    );
    expect(isRevived(dismissal({ headRefOid: "sha-old" }), pr({ headRefOid: "" }))).toBe(false);
    expect(isRevived(dismissal({ headRefOid: "" }), pr({ headRefOid: "sha-new" }))).toBe(false);
  });

  it("does not revive a PR that was ALREADY green when it was dismissed", () => {
    // A user WITH merge rights dismissing a green PR (stale, superseded, abandoned — the set the
    // pre-check cannot catch). "It is green" cannot be the trigger, or it would bounce straight
    // back on the very next poll and Dismiss would do nothing at all for these.
    const d = dismissal({ tone: "ready", viewerCanMerge: true });
    expect(isRevived(d, pr({ viewerCanMerge: true }))).toBe(false);
  });

  it("does not revive on a change that makes the PR WORSE", () => {
    // Checks going red is not "the reason went away". Only the three improvements count.
    const d = dismissal({ tone: "ready", viewerCanMerge: true });
    const worse = pr({ viewerCanMerge: true, checks: "failing" });
    expect(isRevived(d, worse)).toBe(false);
  });

  it("does not revive a no-rights PR merely because its checks went green", () => {
    // The gate reports "blocked" for a no-rights PR whatever its checks say, so passing checks
    // cannot promote it to "ready" — and it must not, since the merge still cannot succeed.
    const d = dismissal({ tone: "blocked", viewerCanMerge: false });
    const stillNoRights = pr({ viewerCanMerge: false, checks: "pending" });
    expect(isRevived(d, stillNoRights)).toBe(false);
    expect(isRevived(d, pr({ viewerCanMerge: false, checks: "passing" }))).toBe(false);
  });
});

describe("partitionDismissals", () => {
  it("splits the set into what still holds and what has run out", () => {
    const held = dismissal({ number: 39 });
    const expired = dismissal({ number: 40, headRefOid: "sha-old" });
    const { active, revived } = partitionDismissals(
      [held, expired],
      [pr({ number: 39 }), pr({ number: 40, headRefOid: "sha-new" })],
    );
    expect(active.map((d) => d.number)).toEqual([39]);
    expect(revived.map((d) => d.number)).toEqual([40]);
  });

  it("keeps a dismissal whose PR is ABSENT from the rows", () => {
    // Absent means "closed upstream" (Rust prunes it, from a probe it knows is complete) or "we
    // could not read this repo". Reviving on the second would let a failed `gh` call quietly undo
    // the user's dismissals, which is the same confident-read-of-a-failure the null-vs-zero
    // discipline exists to prevent.
    const { active, revived } = partitionDismissals([dismissal({ number: 39 })], []);
    expect(active.map((d) => d.number)).toEqual([39]);
    expect(revived).toEqual([]);
  });

  it("returns two empty buckets for an empty set", () => {
    expect(partitionDismissals([], [pr()])).toEqual({ active: [], revived: [] });
  });
});

describe("dismissedNumbers", () => {
  it("is the set the grouping layer filters on", () => {
    const s = dismissedNumbers([dismissal({ number: 7 }), dismissal({ number: 39 })]);
    expect(s.has(7)).toBe(true);
    expect(s.has(39)).toBe(true);
    expect(s.has(40)).toBe(false);
    expect(s.size).toBe(2);
  });
});

import { describe, it, expect } from "vitest";
import {
  formatPrBadge,
  OPEN_PR_POLL_MS,
  OPEN_PR_QUERY_LIMIT,
  prMergeEligibility,
  prMergeReadiness,
  prReadyCount,
  prStatusDot,
  type PrJudgeable,
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

// The three PRs that were open when this was reported, as `gh` actually described them. They are
// fixtures rather than illustrations: #934/#925 are the UNSTABLE trap (GitHub says MERGEABLE while
// a non-required check is red), which is the state that made the dot colours look arbitrary.
const PR_944_CONFLICTING: PrJudgeable = {
  checks: "pending",
  mergeable: "conflicting",
  mergeStateStatus: "dirty",
  failingChecks: [],
  pendingChecks: ["Vercel Agent Review"],
};
const PR_934_UNSTABLE: PrJudgeable = {
  checks: "failing",
  mergeable: "mergeable",
  mergeStateStatus: "unstable",
  failingChecks: ["Node — coverage (shard 3/4)", "Node — typecheck · test · build"],
  pendingChecks: [],
};
const PR_925_UNSTABLE: PrJudgeable = {
  checks: "failing",
  mergeable: "mergeable",
  mergeStateStatus: "unstable",
  failingChecks: ["Desktop Rust — cargo check · test"],
  pendingChecks: [],
};
const GREEN: PrJudgeable = {
  checks: "passing",
  mergeable: "mergeable",
  mergeStateStatus: "clean",
  failingChecks: [],
  pendingChecks: [],
};

describe("prMergeReadiness — the dot answers ONE question: safe to merge right now?", () => {
  it("is GREEN and one-click ONLY when mergeable, every check concluded, none failing", () => {
    const r = prMergeReadiness(GREEN);
    expect(r.tone).toBe("ready");
    expect(r.canMerge).toBe(true);
    expect(r.override).toBeNull();
    // Green needs no word — the enabled button is the label.
    expect(r.label).toBeNull();
  });

  it("REGRESSION: unknown mergeability is amber AND un-mergeable, never an enabled yellow button", () => {
    // THE reported bug. This used to return tone "waiting" with canMerge TRUE — an enabled Merge
    // button under a yellow dot — on the reasoning that gh was the backstop. The founder's words:
    // "ready to merge means that it would be green, and it's a little bit scary as a user to be
    // clicking on a button that has a yellow dot instead of a green dot."
    // This assertion FAILS against the old implementation, which is the point of it.
    const r = prMergeReadiness({ checks: "passing", mergeable: "unknown" });
    expect(r.tone).toBe("waiting");
    expect(r.canMerge).toBe(false);
    expect(r.label).toMatch(/checking mergeability/i);
    // Not an override case either: we have no answer from GitHub, so there is nothing to override.
    expect(r.override).toBeNull();
  });

  it("blocks a conflict with no override — nothing the app can do makes this merge (#944)", () => {
    const r = prMergeReadiness(PR_944_CONFLICTING);
    expect(r.tone).toBe("blocked");
    expect(r.canMerge).toBe(false);
    expect(r.label).toBe("Conflicts");
    expect(r.override).toBeNull();
  });

  it("NAMES the failing checks and offers a deliberate override for UNSTABLE (#934)", () => {
    const r = prMergeReadiness(PR_934_UNSTABLE);
    expect(r.tone).toBe("blocked");
    expect(r.canMerge).toBe(false);
    expect(r.label).toBe("2 checks failing");
    // Named, not just counted — "1 check failing" with no name is not actionable.
    expect(r.title).toContain("Node — coverage (shard 3/4)");
    expect(r.title).toContain("Node — typecheck · test · build");
    // GitHub genuinely would accept this merge, so an override exists — but as its own affordance,
    // never as the same one-click Merge.
    expect(r.override).not.toBeNull();
    expect(r.override?.label).toMatch(/anyway/i);
  });

  it("says '1 check failing' in the singular and names it (#925)", () => {
    const r = prMergeReadiness(PR_925_UNSTABLE);
    expect(r.label).toBe("1 check failing");
    expect(r.title).toContain("Desktop Rust — cargo check · test");
    expect(r.canMerge).toBe(false);
  });

  it("treats still-running checks as NOT-YET: amber, disabled, counted by name", () => {
    const r = prMergeReadiness({
      checks: "pending",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      failingChecks: [],
      pendingChecks: ["CI", "Secret scan", "Vercel"],
    });
    expect(r.tone).toBe("waiting");
    expect(r.canMerge).toBe(false);
    expect(r.label).toBe("Checks running (3)");
    expect(r.title).toMatch(/blind/i);
  });

  it("offers NO override on a clean-but-pending PR — GitHub has not said it would accept", () => {
    // The override is only honest where GitHub's own answer is ambiguous (unstable/behind). A
    // required check that is merely slow is not ambiguous; it is not finished.
    const r = prMergeReadiness({
      checks: "pending",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      pendingChecks: ["CI"],
    });
    expect(r.override).toBeNull();
  });

  it("blocks branch protection and drafts outright — gh would refuse anyway", () => {
    for (const state of ["blocked", "draft"] as const) {
      const r = prMergeReadiness({ checks: "passing", mergeable: "mergeable", mergeStateStatus: state });
      expect(r.tone, state).toBe("blocked");
      expect(r.canMerge, state).toBe(false);
      expect(r.override, state).toBeNull();
    }
  });

  it("never lets an EMPTY name array override the rollup word", () => {
    // An older Rust build serves `checks: "failing"` with no names. "No names" must not read as
    // "nothing wrong" — that would re-open the exact false-green this module exists to prevent.
    const r = prMergeReadiness({ checks: "failing", mergeable: "mergeable" });
    expect(r.tone).toBe("blocked");
    expect(r.canMerge).toBe(false);
    expect(r.label).toBe("Checks failing");
  });

  it("distinguishes an ABSENT merge state from GitHub's own 'unknown'", () => {
    // undefined = the caller did not supply it (a partial fixture); "unknown" = GitHub is still
    // computing. Only the second is a reason to withhold green.
    expect(prMergeReadiness({ checks: "passing", mergeable: "mergeable" }).canMerge).toBe(true);
    expect(
      prMergeReadiness({ checks: "passing", mergeable: "mergeable", mergeStateStatus: "unknown" })
        .canMerge,
    ).toBe(false);
  });
});

const ALL_CHECKS: PrRow["checks"][] = ["passing", "pending", "failing", "none"];
const ALL_MERGEABLE: PrRow["mergeable"][] = ["mergeable", "conflicting", "unknown"];
const ALL_STATES: (PrRow["mergeStateStatus"] | undefined)[] = [
  undefined,
  "clean",
  "dirty",
  "unstable",
  "blocked",
  "behind",
  "draft",
  "has_hooks",
  "unknown",
];
const EVERY_COMBINATION: PrJudgeable[] = ALL_CHECKS.flatMap((checks) =>
  ALL_MERGEABLE.flatMap((mergeable) =>
    ALL_STATES.map((mergeStateStatus) => ({ checks, mergeable, mergeStateStatus })),
  ),
);

describe("the invariant that keeps the dot and the button honest", () => {
  it("holds tone==='ready' ⟺ canMerge across EVERY combination", () => {
    // BI-DIRECTIONAL, and that is the change. It used to be one-directional — green implied
    // mergeable, but a mergeable PR was allowed to render amber and STILL offer the button. That
    // gap is precisely where the enabled-button-under-a-yellow-dot lived. Now the two are the same
    // fact, so they cannot drift apart again.
    for (const pr of EVERY_COMBINATION) {
      const r = prMergeReadiness(pr);
      const shape = `${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}`;
      expect(r.canMerge, `canMerge but not green: ${shape}`).toBe(r.tone === "ready");
    }
  });

  it("gives EVERY non-green PR a word, so state never depends on colour alone", () => {
    // The founder's screenshot was five dots and no words. Colour is not an accessible channel and
    // it is not a precise one either — "yellow" does not say whether to wait or to act.
    for (const pr of EVERY_COMBINATION) {
      const r = prMergeReadiness(pr);
      const shape = `${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}`;
      if (r.tone === "ready") expect(r.label, shape).toBeNull();
      else expect(r.label?.length ?? 0, `no word for ${shape}`).toBeGreaterThan(0);
      expect(r.title.length, `no tooltip for ${shape}`).toBeGreaterThan(0);
    }
  });

  it("only ever offers an override where GitHub itself would accept the merge", () => {
    // An override on a genuinely-unmergeable PR would be a button that cannot work — the same
    // false affordance in a new costume.
    for (const pr of EVERY_COMBINATION) {
      const r = prMergeReadiness(pr);
      if (!r.override) continue;
      const shape = `${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}`;
      expect(pr.mergeable, `override on a non-mergeable PR: ${shape}`).toBe("mergeable");
      expect(["unstable", "behind"], shape).toContain(pr.mergeStateStatus);
    }
  });

  it("still reaches green — the implication is not satisfied by never being ready", () => {
    const green = EVERY_COMBINATION.filter((pr) => prMergeReadiness(pr).tone === "ready");
    expect(green.length).toBeGreaterThan(0);
    // ...and every green one really is mergeable with nothing outstanding.
    for (const pr of green) {
      expect(pr.mergeable).toBe("mergeable");
      expect(["passing", "none"]).toContain(pr.checks);
      expect([undefined, "clean", "has_hooks"]).toContain(pr.mergeStateStatus);
    }
  });
});

describe("prReadyCount / prMergeEligibility — the header count and the concierge gate", () => {
  it("counts ONLY green, so 'Merge all ready (N)' matches the enabled buttons", () => {
    // The reported header said "Merge all ready (1)" over five rows that all offered Merge. The app
    // already knew the right number; it just did not act on it everywhere.
    const rows = [GREEN, PR_944_CONFLICTING, PR_934_UNSTABLE, PR_925_UNSTABLE, GREEN];
    expect(prReadyCount(rows)).toBe(2);
  });

  it("returns 0 rather than throwing on an empty list", () => {
    expect(prReadyCount([])).toBe(0);
  });

  it("keeps prMergeEligibility in lockstep with the readiness rule", () => {
    // The concierge's own merge tool gates on this, so it must refuse exactly what the menu refuses.
    for (const pr of EVERY_COMBINATION) {
      const e = prMergeEligibility(pr);
      const r = prMergeReadiness(pr);
      expect(e.canMerge).toBe(r.canMerge);
      if (!e.canMerge) expect(e.reason?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("blocks all three real open PRs, and says something specific about each", () => {
    for (const pr of [PR_944_CONFLICTING, PR_934_UNSTABLE, PR_925_UNSTABLE]) {
      const e = prMergeEligibility(pr);
      expect(e.canMerge).toBe(false);
      expect(e.reason).toBeTruthy();
    }
    expect(prMergeEligibility(PR_944_CONFLICTING).reason).toMatch(/conflict/i);
    expect(prMergeEligibility(PR_934_UNSTABLE).reason).toMatch(/failing/i);
  });
});

describe("prStatusDot stays a thin view over the same decision", () => {
  it("mirrors tone, title and label from prMergeReadiness exactly", () => {
    for (const pr of EVERY_COMBINATION) {
      const d = prStatusDot(pr);
      const r = prMergeReadiness(pr);
      expect(d).toEqual({ tone: r.tone, title: r.title, label: r.label });
    }
  });
});

// ── A REMEDY STRING IS AN INSTRUCTION, SO IT HAS TO BE TRUE ───────────────────────────────────
// Every override here justifies itself with "GitHub would accept this merge" — which is checkable
// for UNSTABLE, because GitHub literally reports `mergeable: MERGEABLE` alongside it. BEHIND is the
// one state where the same sentence can be a lie: a repo with "require branches to be up to date
// before merging" refuses exactly this case, and reports it as BEHIND rather than BLOCKED. The
// refusal-copy rule in AGENTS.md is that the suggested alternative must be safe under the SAME
// conditions that triggered the refusal.
describe("BEHIND offers no merge affordance at all", () => {
  const behind = prMergeReadiness({
    checks: "passing",
    mergeable: "mergeable",
    mergeStateStatus: "behind",
    failingChecks: [],
    pendingChecks: [],
  });

  it("withholds the one-click Merge AND the override", () => {
    expect(behind.canMerge).toBe(false);
    expect(behind.tone).toBe("waiting");
    // A row with an override renders it as its ONLY merge affordance, so an override here IS the
    // button — and this is the state where pressing it ends in "head branch is out of date".
    expect(behind.override).toBeNull();
  });

  it("still says what is wrong, in a word and in the tooltip", () => {
    expect(behind.label).toBe("Behind base");
    expect(behind.title).toMatch(/update it/i);
  });

  // THE SAME FALSE CLAIM, REACHED SIDEWAYS. `githubWouldAccept` gates the failing/pending branches
  // too, so while it admitted BEHIND, a PR that is behind AND red got a "GitHub would accept this
  // merge" override out of a branch that never mentions being behind.
  it("grants no override to a PR that is behind AND failing", () => {
    const r = prMergeReadiness({
      checks: "failing",
      mergeable: "mergeable",
      mergeStateStatus: "behind",
      failingChecks: ["CI / test"],
      pendingChecks: [],
    });
    expect(r.tone).toBe("blocked");
    expect(r.canMerge).toBe(false);
    expect(r.override).toBeNull();
  });

  // …while the UNSTABLE overrides, where the claim IS checkable, keep making it.
  it("leaves the checkable claim in place for UNSTABLE", () => {
    for (const [name, pr] of [
      ["#934 (a check failing)", PR_934_UNSTABLE],
      ["#925 (checks running)", PR_925_UNSTABLE],
    ] as const) {
      const r = prMergeReadiness(pr);
      expect(r.override, `${name} should offer an override`).not.toBeNull();
      expect(r.override!.reason, name).toMatch(/would accept/i);
    }
  });
});

// ── MERGE RIGHTS: A BUTTON THAT CANNOT WORK MUST NOT BE DRAWN (bead sparkle-j881r) ──────────────
//
// The fleet-wide chiclet surfaced pull requests in repos the user can open PRs into but not merge.
// Every Merge there ends in `GraphQL: <user> does not have the correct permissions to execute
// MergePullRequest`, and every refresh re-offered it. The permission is knowable before the click.
describe("prMergeReadiness — merge rights", () => {
  /** Green by every other measure: passing checks, mergeable, clean. Only rights are in question. */
  const green = (viewerCanMerge?: boolean | null): PrJudgeable => ({
    checks: "passing",
    mergeable: "mergeable",
    mergeStateStatus: "clean",
    viewerCanMerge,
  });

  it("blocks a PR the user cannot merge, even when everything else is green", () => {
    // The whole bug in one assertion. Before the pre-check this row was `tone: "ready"` with a live
    // one-click Merge — the button the founder pressed to get a 403.
    const r = prMergeReadiness(green(false));
    expect(r.canMerge).toBe(false);
    expect(r.tone).toBe("blocked");
    expect(r.label).toBe("No merge rights");
  });

  it("offers NO override — two deliberate clicks would end in the same 403", () => {
    // Every override on this surface justifies itself with "GitHub would accept this merge", which
    // is exactly the claim that is false here. Checked across the branches that DO offer one when
    // rights are unknown, so the no-rights answer cannot inherit an override from any of them.
    expect(prMergeReadiness(green(false)).override).toBeNull();
    expect(
      prMergeReadiness({
        checks: "failing",
        mergeable: "mergeable",
        mergeStateStatus: "unstable",
        viewerCanMerge: false,
      }).override,
    ).toBeNull();
    expect(
      prMergeReadiness({
        checks: "pending",
        mergeable: "mergeable",
        mergeStateStatus: "unstable",
        viewerCanMerge: false,
      }).override,
    ).toBeNull();
  });

  it("says WHY, and points at the way out", () => {
    // The title is the row's tooltip and the disabled button's — the only place the reader is told
    // that waiting will not help and that Dismiss is what stops it being offered.
    const t = prMergeReadiness(green(false)).title;
    expect(t).toContain("permission");
    expect(t).toContain("dismiss");
  });

  it("does NOT block when the permission is UNKNOWN — an unknown may not manufacture a NO", () => {
    // `gh repo view` failing (absent, unauthed, offline, timed out) must behave exactly as this
    // gate did before the field existed. Blocking on unknown would let one slow probe disable
    // every Merge button in the app.
    expect(prMergeReadiness(green(undefined)).canMerge).toBe(true);
    expect(prMergeReadiness(green(null)).canMerge).toBe(true);
    expect(prMergeReadiness(green()).canMerge).toBe(true);
  });

  it("allows the merge when the user explicitly CAN merge", () => {
    expect(prMergeReadiness(green(true)).canMerge).toBe(true);
    expect(prMergeReadiness(green(true)).tone).toBe("ready");
  });

  it("outranks every other blocker, because nothing below it can ever rescue the merge", () => {
    // Checks finish, conflicts get resolved, mergeability settles. No write access does not — so
    // reporting "checks running" here would send the reader to wait for a button that will still
    // not work when the wait ends.
    for (const pr of EVERY_COMBINATION) {
      const r = prMergeReadiness({ ...pr, viewerCanMerge: false });
      const shape = `${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}`;
      expect(r.label, `no-rights must dominate: ${shape}`).toBe("No merge rights");
      expect(r.canMerge, `no-rights must never merge: ${shape}`).toBe(false);
    }
  });

  it("keeps the tone⟺canMerge invariant across every combination, with rights on and off", () => {
    // The invariant that stops the dot and the button drifting apart, re-asserted over the NEW
    // axis rather than assumed to survive it.
    for (const pr of EVERY_COMBINATION) {
      for (const viewerCanMerge of [true, false, null, undefined] as const) {
        const r = prMergeReadiness({ ...pr, viewerCanMerge });
        const shape = `${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}/rights=${viewerCanMerge}`;
        expect(r.canMerge, `canMerge but not green: ${shape}`).toBe(r.tone === "ready");
      }
    }
  });

  it("drops a no-rights PR out of prReadyCount, so the chiclet cannot over-promise", () => {
    expect(prReadyCount([green(true), green(false), green(true)])).toBe(2);
  });
});

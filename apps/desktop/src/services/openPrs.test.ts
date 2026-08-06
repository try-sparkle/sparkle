import { describe, it, expect, vi, beforeEach } from "vitest";

// The knightwatch-override block below asserts the PAYLOAD that reaches Rust, so it needs a real
// `invoke` spy. Hoisted so the mock is installed before `./openPrs` is imported.
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => h.invoke(...a),
}));
import {
  formatPrBadge,
  mergePr,
  OPEN_PR_POLL_MS,
  OPEN_PR_QUERY_LIMIT,
  prMergeEligibility,
  prMergeReadiness,
  prProbeBlockedCount,
  prReadyCount,
  prStatusDot,
  type PrJudgeable,
  type PrProbeState,
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
  failingChecks: [
    "Node — coverage (shard 3/4)",
    "Node — typecheck · test · build",
  ],
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
      const r = prMergeReadiness({
        checks: "passing",
        mergeable: "mergeable",
        mergeStateStatus: state,
      });
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
    expect(
      prMergeReadiness({ checks: "passing", mergeable: "mergeable" }).canMerge,
    ).toBe(true);
    expect(
      prMergeReadiness({
        checks: "passing",
        mergeable: "mergeable",
        mergeStateStatus: "unknown",
      }).canMerge,
    ).toBe(false);
  });
});

const ALL_CHECKS: PrRow["checks"][] = ["passing", "pending", "failing", "none"];
const ALL_MERGEABLE: PrRow["mergeable"][] = [
  "mergeable",
  "conflicting",
  "unknown",
];
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
/**
 * The probe axis. Every value a real read can produce, INCLUDING the two that must not block:
 * `undefined` (no read has landed) and a `null` count (the read did not answer). Adding this axis
 * to the sweep is what stops the probe branch quietly breaking the tone⟺canMerge equivalence, or
 * an existing guard below going vacuous because the new branch intercepts its case.
 */
const ALL_PROBES: (PrProbeState | undefined)[] = [
  undefined,
  { unansweredBlocking: null, overridden: false, applicable: true },
  { unansweredBlocking: 0, overridden: false, applicable: true },
  { unansweredBlocking: 1, overridden: false, applicable: true },
  { unansweredBlocking: 4, overridden: false, applicable: true },
  { unansweredBlocking: 2, overridden: true, applicable: true },
  { unansweredBlocking: 0, overridden: false, applicable: false },
];
const EVERY_COMBINATION: PrJudgeable[] = ALL_CHECKS.flatMap((checks) =>
  ALL_MERGEABLE.flatMap((mergeable) =>
    ALL_STATES.flatMap((mergeStateStatus) =>
      ALL_PROBES.map((probes) => ({
        checks,
        mergeable,
        mergeStateStatus,
        probes,
      })),
    ),
  ),
);

/** Does this PR carry a probe block the rule must act on? Spelled out here rather than reusing the
 *  implementation's own predicate, so a bug in that predicate cannot make these guards agree with
 *  it by construction. */
const isProbeBlocked = (pr: PrJudgeable): boolean =>
  !!pr.probes &&
  pr.probes.unansweredBlocking !== null &&
  pr.probes.unansweredBlocking > 0 &&
  !pr.probes.overridden;

describe("the invariant that keeps the dot and the button honest", () => {
  it("holds tone==='ready' ⟺ canMerge across EVERY combination", () => {
    // BI-DIRECTIONAL, and that is the change. It used to be one-directional — green implied
    // mergeable, but a mergeable PR was allowed to render amber and STILL offer the button. That
    // gap is precisely where the enabled-button-under-a-yellow-dot lived. Now the two are the same
    // fact, so they cannot drift apart again.
    for (const pr of EVERY_COMBINATION) {
      const r = prMergeReadiness(pr);
      const shape = `${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}`;
      expect(r.canMerge, `canMerge but not green: ${shape}`).toBe(
        r.tone === "ready",
      );
    }
  });

  it("gives EVERY non-green PR a word, so state never depends on colour alone", () => {
    // The founder's screenshot was five dots and no words. Colour is not an accessible channel and
    // it is not a precise one either — "yellow" does not say whether to wait or to act.
    for (const pr of EVERY_COMBINATION) {
      const r = prMergeReadiness(pr);
      const shape = `${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}`;
      if (r.tone === "ready") expect(r.label, shape).toBeNull();
      else
        expect(r.label?.length ?? 0, `no word for ${shape}`).toBeGreaterThan(0);
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
      expect(pr.mergeable, `override on a non-mergeable PR: ${shape}`).toBe(
        "mergeable",
      );
      expect(["unstable", "behind"], shape).toContain(pr.mergeStateStatus);
    }
  });

  it("still reaches green — the implication is not satisfied by never being ready", () => {
    const green = EVERY_COMBINATION.filter(
      (pr) => prMergeReadiness(pr).tone === "ready",
    );
    expect(green.length).toBeGreaterThan(0);
    // ...and every green one really is mergeable with nothing outstanding.
    for (const pr of green) {
      expect(pr.mergeable).toBe("mergeable");
      expect(["passing", "none"]).toContain(pr.checks);
      expect([undefined, "clean", "has_hooks"]).toContain(pr.mergeStateStatus);
      // NEW AXIS: no green PR may carry an unanswered blocking probe. This is the assertion that
      // would have caught the founder's report — before the fix, green was reachable with any
      // probe state at all.
      expect(isProbeBlocked(pr), "green PR with an unanswered blocking probe").toBe(false);
    }
  });

  it("blocks EVERY probe-blocked combination that is not already conflicting or unmergeable", () => {
    // The reordering claim, swept rather than spot-checked: wherever a probe block is the most
    // durable outstanding fact, it is the one the row names. Conflicts and merge rights still
    // outrank it, and those are the ONLY two that may.
    const outranking = new Set(["Conflicts", "No merge rights"]);
    let named = 0;
    for (const pr of EVERY_COMBINATION) {
      if (!isProbeBlocked(pr)) continue;
      const r = prMergeReadiness(pr);
      const shape = `${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}`;
      // Whatever it names, a probe-blocked PR is NEVER mergeable and NEVER amber.
      expect(r.canMerge, `probe-blocked but mergeable: ${shape}`).toBe(false);
      expect(r.tone, `probe-blocked but not red: ${shape}`).toBe("blocked");
      if (r.label?.startsWith("Blocked: ")) named += 1;
      else expect(outranking, `probe block lost to '${r.label}': ${shape}`).toContain(r.label);
    }
    // And it is not satisfied by never naming the probe.
    expect(named).toBeGreaterThan(0);
  });

  it("never blocks on a probe read that did not answer", () => {
    // The counter-guard to the one above, and the reason the axis includes `undefined` and a `null`
    // count: an unknown read must leave the verdict EXACTLY as it was without the field. If this
    // ever fails, one slow `gh` disables every Merge button in the app.
    for (const pr of EVERY_COMBINATION) {
      if (pr.probes && pr.probes.unansweredBlocking !== null) continue;
      const { probes: _dropped, ...withoutField } = pr;
      expect(
        prMergeReadiness(pr),
        `an unknown probe read changed the verdict: ${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}`,
      ).toEqual(prMergeReadiness(withoutField));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// KNIGHTWATCH PROBES — the founder's screenshot (2026-08-05)
//
// A section headed "11" with a "Merge all ready" button, whose rows read "Checking mergeability",
// while EIGHT of the eleven were hard-blocked on unanswered [blocking] probes. The rule below could
// not see probes at all, so a probe-blocked PR with clean CI rendered GREEN with a live one-click
// Merge, counted toward the ready count, and sat inside the merge-all scope. The app only learned
// the truth by ATTEMPTING the merge and catching Rust's refusal.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Shorthand: a probe read that answered, with `n` unanswered blocking probes. */
const probed = (n: number, overridden = false): PrProbeState => ({
  unansweredBlocking: n,
  overridden,
  applicable: true,
});
/** A probe read that did NOT answer — gh missing, offline, timed out, or a saturated comment page. */
const PROBE_UNKNOWN: PrProbeState = {
  unansweredBlocking: null,
  overridden: false,
  applicable: true,
};

describe("prMergeReadiness — unanswered knightwatch probes block the row", () => {
  it("names the probe instead of 'Checking mergeability' — the screenshot's exact row", () => {
    // #1325/#1323/#1322 as the founder saw them: amber, "Checking mergeability", visually identical
    // to a PR merely waiting on CI, while in fact carrying an unanswered blocking probe.
    const r = prMergeReadiness({
      checks: "passing",
      mergeable: "unknown",
      mergeStateStatus: "unknown",
      probes: probed(1),
    });
    expect(r.tone).toBe("blocked");
    expect(r.label).toBe("Blocked: 1 probe");
    expect(r.label).not.toBe("Checking mergeability");
    expect(r.canMerge).toBe(false);
  });

  it("stops a CLEAN-CI probe-blocked PR rendering green with a live Merge", () => {
    // The worse half of the bug, and the one the screenshot could not show: nothing about this PR
    // is amber. Before the fix this was tone "ready", canMerge true, one click from landing over an
    // unanswered reviewer question.
    const r = prMergeReadiness({
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      probes: probed(2),
    });
    expect(r.tone).toBe("blocked");
    expect(r.label).toBe("Blocked: 2 probes");
    expect(r.canMerge).toBe(false);
  });

  it("outranks every check state, because finishing the checks cannot rescue it", () => {
    // The founder chose this ordering explicitly. A probe block is DURABLE: when the checks finish
    // this PR still cannot merge, so amber would be a promise the row cannot keep.
    const running = prMergeReadiness({
      checks: "pending",
      mergeable: "mergeable",
      pendingChecks: ["ci/build", "ci/test", "ci/lint"],
      probes: probed(1),
    });
    expect(running.tone).toBe("blocked");
    expect(running.label).toBe("Blocked: 1 probe");
    // ...but nothing is HIDDEN: the other blocker is still named in the tooltip.
    expect(running.title).toMatch(/check/i);
  });

  it("still yields to the blockers that no probe answer could fix", () => {
    // Conflicts and missing merge rights are more fundamental: answering the probe would leave the
    // reader with a row that still cannot merge and no longer says why.
    expect(
      prMergeReadiness({
        checks: "passing",
        mergeable: "conflicting",
        probes: probed(1),
      }).label,
    ).toBe("Conflicts");
    expect(
      prMergeReadiness({
        checks: "passing",
        mergeable: "mergeable",
        viewerCanMerge: false,
        probes: probed(1),
      }).label,
    ).toBe("No merge rights");
  });

  it("offers no 'Merge anyway' — the probe override is its own written two-step", () => {
    // The generic override's justification is "GitHub would accept this merge", which is true here
    // and beside the point: Rust refuses it, and the only way past is a recorded written reason.
    const r = prMergeReadiness({
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "unstable",
      probes: probed(1),
    });
    expect(r.override).toBeNull();
  });

  it("a recorded override clears the block rather than repeating it", () => {
    const r = prMergeReadiness({
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      probes: probed(3, true),
    });
    expect(r.tone).toBe("ready");
    expect(r.canMerge).toBe(true);
  });

  it("says 'probe' for one and 'probes' for many", () => {
    expect(prMergeReadiness({ checks: "passing", mergeable: "mergeable", probes: probed(1) }).label)
      .toBe("Blocked: 1 probe");
    expect(prMergeReadiness({ checks: "passing", mergeable: "mergeable", probes: probed(5) }).label)
      .toBe("Blocked: 5 probes");
  });

  it("an UNKNOWN read never manufactures a confident NO", () => {
    // The rule this whole module is written around: not knowing may withhold a YES, but it may not
    // invent a NO. A slow or unauthed `gh` must not turn all 27 rows red and disable every Merge —
    // and it costs nothing, because Rust's merge_pr gate is the real backstop and cannot be routed
    // around. Same shape as `viewerCanMerge: undefined` two branches up.
    const r = prMergeReadiness({
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      probes: PROBE_UNKNOWN,
    });
    expect(r.tone).toBe("ready");
    expect(r.canMerge).toBe(true);
  });

  it("zero unanswered probes is a real answer, not a block", () => {
    const r = prMergeReadiness({
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      probes: probed(0),
    });
    expect(r.tone).toBe("ready");
  });

  it("a PR with no probe read at all behaves exactly as it did before the field existed", () => {
    const withField = prMergeReadiness({
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      probes: undefined,
    });
    const without = prMergeReadiness({
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
    });
    expect(withField).toEqual(without);
    expect(withField.tone).toBe("ready");
  });
});

describe("prReadyCount excludes probe-blocked PRs — the '11' in the screenshot", () => {
  it("does not count a probe-blocked PR as ready", () => {
    // THE GOAL'S REQUIRED ASSERTION. The header said 11 and the founder read it as "eleven ready".
    const mergeable = { checks: "passing", mergeable: "mergeable", mergeStateStatus: "clean" } as const;
    const rows: PrJudgeable[] = [
      { ...mergeable, probes: probed(0) },
      { ...mergeable, probes: probed(1) },
      { ...mergeable, probes: probed(2) },
    ];
    expect(prReadyCount(rows)).toBe(1);
  });

  it("renders a probe-blocked PR visibly DISTINCT from a mergeable one", () => {
    // Distinct on all three channels the row paints: dot tone, the word beside it, and whether a
    // Merge button exists at all. Colour alone is not an accessible channel.
    const base = { checks: "passing", mergeable: "mergeable", mergeStateStatus: "clean" } as const;
    const ready = prStatusDot({ ...base, probes: probed(0) });
    const blocked = prStatusDot({ ...base, probes: probed(1) });
    expect(blocked.tone).not.toBe(ready.tone);
    expect(blocked.label).not.toBe(ready.label);
    expect(blocked.tone).toBe("blocked");
    expect(blocked.label).toBe("Blocked: 1 probe");
    expect(prMergeEligibility({ ...base, probes: probed(1) }).canMerge).toBe(false);
  });

  it("keeps the concierge's own merge gate in lockstep", () => {
    const e = prMergeEligibility({
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      probes: probed(1),
    });
    expect(e.canMerge).toBe(false);
    expect(e.reason).toMatch(/probe/i);
  });
});

describe("prReadyCount / prMergeEligibility — the header count and the concierge gate", () => {
  it("counts ONLY green, so 'Merge all ready (N)' matches the enabled buttons", () => {
    // The reported header said "Merge all ready (1)" over five rows that all offered Merge. The app
    // already knew the right number; it just did not act on it everywhere.
    const rows = [
      GREEN,
      PR_944_CONFLICTING,
      PR_934_UNSTABLE,
      PR_925_UNSTABLE,
      GREEN,
    ];
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
      expect(r.label, `no-rights must dominate: ${shape}`).toBe(
        "No merge rights",
      );
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
        expect(r.canMerge, `canMerge but not green: ${shape}`).toBe(
          r.tone === "ready",
        );
      }
    }
  });

  it("drops a no-rights PR out of prReadyCount, so the chiclet cannot over-promise", () => {
    expect(prReadyCount([green(true), green(false), green(true)])).toBe(2);
  });
});

// ── THE KNIGHTWATCH OVERRIDE REACHES RUST, OR IT IS NOT AN OVERRIDE ───────────────────────────
//
// `mergePr` is the ONLY `invoke("merge_pr")` in the codebase, so this is the single place the
// written waiver can be lost. Losing it is silent and looks like the gate working: the user types a
// sentence, clicks Merge, and Rust — never handed the reason — refuses again for unanswered probes.
// So these assert the PAYLOAD, not that the call happened.
describe("mergePr — the knightwatch override is passed THROUGH", () => {
  beforeEach(() => {
    h.invoke.mockReset();
    h.invoke.mockResolvedValue(null);
  });

  it("carries the reason to the Rust command as `knightwatchOverride`", async () => {
    await mergePr(
      "/repo",
      1176,
      "the probe asks about a file this PR does not touch",
    );
    const [cmd, payload] = h.invoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cmd).toBe("merge_pr");
    expect(payload).toEqual({
      root: "/repo",
      number: 1176,
      knightwatchOverride: "the probe asks about a file this PR does not touch",
    });
  });

  it("OMITS the key entirely on an ordinary merge", async () => {
    await mergePr("/repo", 1176);
    const payload = h.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    // `in`, not `=== undefined`: the existing callers assert the exact payload `{ root, number }`,
    // and a key that is present-but-undefined is a different object on the wire.
    expect("knightwatchOverride" in payload).toBe(false);
    expect(payload).toEqual({ root: "/repo", number: 1176 });
  });

  // ── AND SO DOES THE HEAD THE DECISION WAS MADE AGAINST ─────────────────────────────────────
  //
  // Same reasoning, opposite failure: dropping `expectedHeadOid` does not refuse a merge, it merges
  // a head this app never judged — and a commit pushed in that window is absent from main with the
  // PR reading MERGED. There is no visible symptom, so the payload is the only place to assert it.
  it("carries the polled head to the Rust command as `expectedHeadOid`", async () => {
    const oid = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    await mergePr("/repo", 1176, undefined, oid);
    const payload = h.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual({ root: "/repo", number: 1176, expectedHeadOid: oid });
  });

  it("sends BOTH when a red PR is waived at a known head", async () => {
    await mergePr("/repo", 1176, "answered in the thread", "deadbeefcafe");
    const payload = h.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual({
      root: "/repo",
      number: 1176,
      knightwatchOverride: "answered in the thread",
      expectedHeadOid: "deadbeefcafe",
    });
  });

  it("OMITS an unknown head — empty means 'cannot compare', never a merge that gh rejects", async () => {
    for (const oid of [undefined, ""]) {
      h.invoke.mockClear();
      await mergePr("/repo", 1176, undefined, oid);
      const payload = h.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
      expect("expectedHeadOid" in payload, `oid=${JSON.stringify(oid)}`).toBe(
        false,
      );
      expect(payload).toEqual({ root: "/repo", number: 1176 });
    }
  });

  it("does not swallow a refusal — the caller must see why the merge did not happen", async () => {
    h.invoke.mockRejectedValueOnce(
      new Error("knightwatch: 1 unanswered [blocking] probe"),
    );
    await expect(mergePr("/repo", 1176)).rejects.toThrow(
      /unanswered \[blocking\] probe/,
    );
  });
});

describe("prProbeBlockedCount — the header's blocked number asks the RULE", () => {
  const probed = (n: number, overridden = false): PrProbeState => ({
    unansweredBlocking: n,
    overridden,
    applicable: true,
  });

  it("does NOT count a PR whose row reports a different blocker", () => {
    // THE DRIFT THIS EXISTS TO PREVENT. Conflicts outrank probes, so this row reads "Conflicts" —
    // counting it under "N blocked on unanswered knightwatch probes" would send the reader to
    // answer a probe on a PR whose visible blocker is something else, and answering it would not
    // make the PR mergeable either.
    const conflicting: PrJudgeable = {
      checks: "passing",
      mergeable: "conflicting",
      mergeStateStatus: "dirty",
      probes: probed(2),
    };
    expect(prMergeReadiness(conflicting).label).toBe("Conflicts");
    expect(prProbeBlockedCount([conflicting])).toBe(0);
  });

  it("does not count a PR the viewer cannot merge at all", () => {
    const noRights: PrJudgeable = {
      checks: "passing",
      mergeable: "mergeable",
      viewerCanMerge: false,
      probes: probed(1),
    };
    expect(prMergeReadiness(noRights).label).toBe("No merge rights");
    expect(prProbeBlockedCount([noRights])).toBe(0);
  });

  it("counts the ones whose row really does say 'Blocked: N probes'", () => {
    const rows: PrJudgeable[] = [
      { checks: "passing", mergeable: "mergeable", mergeStateStatus: "clean", probes: probed(1) },
      { checks: "pending", mergeable: "mergeable", probes: probed(3) },
      { checks: "passing", mergeable: "unknown", mergeStateStatus: "unknown", probes: probed(2) },
    ];
    expect(prProbeBlockedCount(rows)).toBe(3);
    for (const r of rows) expect(prMergeReadiness(r).label).toMatch(/^Blocked: \d+ probes?$/);
  });

  it("does not count an OVERRIDDEN PR — a human wrote a reason for merging past it", () => {
    const waived: PrJudgeable = {
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      probes: probed(3, true),
    };
    expect(prMergeReadiness(waived).tone).toBe("ready");
    expect(prProbeBlockedCount([waived])).toBe(0);
  });

  it("does not count an unknown read", () => {
    const unknown: PrJudgeable = {
      checks: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      probes: { unansweredBlocking: null, overridden: false, applicable: true },
    };
    expect(prProbeBlockedCount([unknown])).toBe(0);
  });

  it("gives every blocked PR a blocker, and green PRs none", () => {
    // The discriminator has to be total, or a caller asking "which fact is this row reporting"
    // gets null for a row that is visibly reporting something.
    for (const pr of EVERY_COMBINATION) {
      const r = prMergeReadiness(pr);
      const shape = `${pr.checks}/${pr.mergeable}/${pr.mergeStateStatus}`;
      if (r.tone === "ready") expect(r.blocker, shape).toBeNull();
      else expect(r.blocker, `no blocker for ${shape}`).not.toBeNull();
    }
  });
});

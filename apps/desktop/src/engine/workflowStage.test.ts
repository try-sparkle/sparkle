import { describe, it, expect } from "vitest";
import {
  WORKFLOW_STAGES,
  type WorkflowStageId,
  stageIndex,
  stageMeta,
  gitDerivedStage,
  resolveStage,
  deriveLiveStage,
  rollupStages,
  dominantStage,
  stageFraction,
  lineColorAt,
  stageLineColor,
  LINE_FROM,
  LINE_TO,
  rollupHoldsWork,
  uncommittedWorkEvidence,
  unlandedWorkEvidence,
  hasUnmergedCommittedWork,
} from "./workflowStage";
import { sectionOfRow } from "./buildSections";
import type { BranchStatus, WorkflowState } from "../services/branchStatus";

const bs = (ahead: number, dirty = false): BranchStatus => ({
  ahead,
  behind: 0,
  dirty,
  filesChanged: dirty ? 1 : 0,
  insertions: 0,
  deletions: 0,
});
const ws = (o: Partial<WorkflowState> = {}): WorkflowState =>
  ({
    inLocalMain: false,
    inOriginMain: false,
    inParent: false,
    aheadOfBase: 0,
    prState: null,
    ...(o as object),
  }) as WorkflowState;

const ORDER: WorkflowStageId[] = [
  "thought",
  "specd",
  "planned",
  "building_unsaved",
  "building_saved",
  "pushed",
  "pull_request",
  "merged_local",
  "merged",
  "shipped",
];

describe("the 10-stage model", () => {
  it("has the ten stages in the canonical order", () => {
    expect(WORKFLOW_STAGES.map((s) => s.id)).toEqual(ORDER);
  });
  it("every stage has friendly label + detail + color", () => {
    for (const s of WORKFLOW_STAGES) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
      expect(s.color).toMatch(/^#|^var\(/);
    }
  });
  it("stageIndex + stageMeta round-trip", () => {
    ORDER.forEach((id, i) => {
      expect(stageIndex(id)).toBe(i);
      expect(stageMeta(id).id).toBe(id);
    });
  });
});

describe("gitDerivedStage / resolveStage", () => {
  it("no branch or no commits → building_unsaved; commits → building_saved", () => {
    expect(gitDerivedStage(null)).toBe("building_unsaved");
    expect(gitDerivedStage(bs(0, true))).toBe("building_unsaved");
    expect(gitDerivedStage(bs(2))).toBe("building_saved");
  });
  it("resolveStage takes the furthest of git and an override, never regressing", () => {
    expect(resolveStage(bs(2), null)).toBe("building_saved");
    expect(resolveStage(bs(0), "pull_request")).toBe("pull_request");
    expect(resolveStage(bs(2), "thought")).toBe("building_saved"); // override never drags down
  });
});

describe("deriveLiveStage — planning floors (Think/Plan)", () => {
  it("a planned-but-unstarted bead floors at Planned (no git work)", () => {
    expect(deriveLiveStage({ kind: "build", hasBead: true })).toBe("planned");
  });
  it("spec'd floors at Spec'd, thought at Thought", () => {
    expect(deriveLiveStage({ kind: "think", hasSpec: true })).toBe("specd");
    expect(deriveLiveStage({ kind: "think", hasThinkDoc: true })).toBe("thought");
  });
  it("a planning floor never drags real git progress backwards", () => {
    expect(deriveLiveStage({ kind: "build", hasBead: true, bs: bs(2) })).toBe("building_saved");
  });
});

describe("deriveLiveStage — build signals", () => {
  it("uncommitted → committed via git ahead", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(0, true) })).toBe("building_unsaved");
    expect(deriveLiveStage({ kind: "build", bs: bs(1) })).toBe("building_saved");
  });
  it("pushed via explicit signal", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(1), pushed: true })).toBe("pushed");
  });
  it("PR open → pull_request; PR merged → merged", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(1), ws: ws({ prState: "open" }) })).toBe(
      "pull_request",
    );
    expect(deriveLiveStage({ kind: "build", bs: bs(1), ws: ws({ prState: "merged" }) })).toBe(
      "merged",
    );
  });
  it("reachability into main → landed, but only once real work is seen", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(0), ws: ws({ inLocalMain: true }) })).toBe(
      "building_unsaved",
    );
    // Re-aimed for the merged_local split: LOCAL main alone is merged_local, not merged. The
    // committedSeen gate this test guards is unchanged — only the stage it lands on is stricter.
    expect(deriveLiveStage({ kind: "build", bs: bs(1), ws: ws({ inLocalMain: true }) })).toBe(
      "merged_local",
    );
  });
  it("shipped is the top, gated on real work", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(1), shipped: true })).toBe("shipped");
    expect(deriveLiveStage({ kind: "build", bs: bs(0), shipped: true })).toBe("building_unsaved");
  });
  it("squash-merge: tip not an ancestor (landed) but work present → merged_local", () => {
    // The branch's commits still exist on its ref post-squash, so aheadOfBase stays >0 (committedSeen)
    // while inLocalMain/inOriginMain are false. `landed` (tree-identical to main) is the squash signal.
    // A LOCAL-scoped squash proof (`landed` WITHOUT `landedOnOrigin`) settles at merged_local — the
    // CTA then offers Push rather than a premature Close. This stays merged_local after the
    // origin/local split (bead `sparkle-e3lxt7`): the split promotes only the ORIGIN-scoped arms, so
    // this case is the control proving the promotion is not unconditional.
    expect(
      deriveLiveStage({ kind: "build", bs: bs(0), ws: ws({ landed: true, aheadOfBase: 2 }) }),
    ).toBe("merged_local");
    // committedSeen can also come from this tick's own commits.
    expect(deriveLiveStage({ kind: "build", bs: bs(1), ws: ws({ landed: true }) })).toBe(
      "merged_local",
    );
  });
  it("a no-op branch is trivially tree-identical (landed) but stays unsaved (committedSeen gate)", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(0), ws: ws({ landed: true }) })).toBe(
      "building_unsaved",
    );
  });
  it("normal merge after relaunch: persisted watermark keeps committedSeen → landed, not unsaved", () => {
    // Post-merge ahead→0 and aheadOfBase→0; without a persisted `prev` this collapsed to unsaved.
    // The persisted watermark (building_saved) restores committedSeen so inLocalMain → merged_local.
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: ws({ inLocalMain: true }),
        prev: "building_saved",
      }),
    ).toBe("merged_local");
  });
});

describe("deriveLiveStage — monotonic watermark + new cycle", () => {
  it("never regresses below prev", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(0, true), prev: "merged" })).toBe("merged");
  });
  it("a new cycle (landed before + fresh un-landed commits) resets to building_saved", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(2), prev: "merged", ws: ws({}) })).toBe(
      "building_saved",
    );
  });
});

// Trust-live-signal (sparkle bug-2): after a relaunch the runtime stage store is empty (prev
// undefined) and a squash-landed branch has ahead→0 AND aheadOfBase→0, so the git/watermark
// committedSeen sources are all false and the reachability→merged bump was gated out — the row
// falsely collapsed to "Building Locally (Unsaved) — closing loses this work". An EXPLICIT action
// signal (pushed to remote, or any PR) proves real committed work existed, so it now establishes
// committedSeen too — WITHOUT re-opening the no-op-branch hole, since a no-op branch is never
// pushed and never has a PR (unlike inLocalMain/landed, which are trivially true for it).
describe("deriveLiveStage — live signals establish committedSeen after relaunch", () => {
  it("pushed + reachable-in-main, no watermark, ahead→0 → merged (not unsaved)", () => {
    expect(
      deriveLiveStage({ kind: "build", bs: bs(0), ws: ws({ inOriginMain: true }), pushed: true }),
    ).toBe("merged");
  });
  it("an open PR proves committed work → reachability lands it post-relaunch", () => {
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: ws({ inLocalMain: true, prState: "open" }),
      }),
    ).toBe("merged_local"); // re-aimed: local main only, so merged_local
  });
  it("worker: pushed establishes committedSeen so an integrated worker reads landed post-relaunch", () => {
    expect(
      deriveLiveStage({
        kind: "worker",
        bs: bs(0),
        ws: ws({ inParent: true }),
        pushed: true,
        parentReachedMain: true,
      }),
    ).toBe("merged_local"); // re-aimed: a worker's parent-integration is a LOCAL merge
  });
  it("still gated: a no-op branch (landed/inLocalMain, but never pushed, no PR) stays unsaved", () => {
    expect(
      deriveLiveStage({ kind: "build", bs: bs(0), ws: ws({ inLocalMain: true, landed: true }) }),
    ).toBe("building_unsaved");
  });
});

// A brand-new build agent was landing in the "Remote: Merged to Main" / "Remote: Shipped to
// Production" sections of the Build column. Its branch tip is main's HEAD, so Rust's TIP-KEYED
// probes answered about main: the commit→PR lookup returned the last merged PR (prState "merged")
// and `git tag --contains` found the last release (shipped). prState is also a `committedSeen`
// source, so the bogus signal unlocked the reachability bumps as well.
//
// Rust now suppresses both for a branch that has authored nothing (worktree.rs
// `branch_carries_no_own_work`). These pin the two shapes that meet at that boundary — the SECOND
// one is the contract test: if a future signal source lets prState/shipped through for a no-op
// branch again, `merged_from_an_inherited_tip` is what fails.
describe("deriveLiveStage — a freshly cut branch must not inherit main's remote facts", () => {
  // What Rust reports for an agent opened seconds ago: cut from origin/main, so its tip is trivially
  // inside local AND origin main and merging it back adds nothing — but it authored nothing, was
  // never pushed, and (post-fix) carries no PR or release attribution.
  const freshlyCut = ws({
    inLocalMain: true,
    inOriginMain: true,
    landed: true,
    aheadOfBase: 0,
    pushed: false,
    shipped: false,
    prState: null,
  });

  it("sits at the build start line, not on main", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(0), ws: freshlyCut })).toBe("building_unsaved");
  });

  it("its first commit advances it one rung — still nowhere near merged", () => {
    // The commit moves the tip OFF main, so every inherited reachability fact drops with it.
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(1),
        ws: ws({ inLocalMain: false, inOriginMain: false, landed: false, aheadOfBase: 1 }),
      }),
    ).toBe("building_saved");
  });

  it("merged_from_an_inherited_tip: an unsuppressed commit-probe PR would jump it to merged", () => {
    // The pre-fix reading, kept as an executable description of the bug: with prState leaking
    // through, committedSeen flips true and the row goes straight to the top of the ladder. Nothing
    // in this module can tell that PR apart from a real one — which is why the gate lives in Rust.
    expect(
      deriveLiveStage({ kind: "build", bs: bs(0), ws: { ...freshlyCut, prState: "merged" } }),
    ).toBe("merged");
    // …and the same leak via the release tag.
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: { ...freshlyCut, prState: "merged" },
        shipped: true,
      }),
    ).toBe("shipped");
  });
});

describe("rollup + dominant", () => {
  it("rollup headline = least-advanced; counts cover all 10 ids", () => {
    const r = rollupStages(["merged", "building_saved", "pushed"]);
    expect(r?.stage).toBe("building_saved"); // slowest unit
    expect(r?.total).toBe(3);
    expect(Object.keys(r!.counts).sort()).toEqual([...ORDER].sort());
  });
  it("dominant breaks ties to the earliest stage", () => {
    const counts = rollupStages(["building_saved", "building_saved", "merged", "merged"])!.counts;
    expect(dominantStage(counts)).toBe("building_saved");
  });
  it("empty rollup is null", () => {
    expect(rollupStages([])).toBeNull();
  });
});

describe("progress-line fill + color", () => {
  it("fraction climbs 1/10 … 10/10 across the stages", () => {
    expect(stageFraction("thought")).toBeCloseTo(1 / 10);
    expect(stageFraction("building_saved")).toBeCloseTo(5 / 10);
    expect(stageFraction("shipped")).toBeCloseTo(1);
  });
  it("line color interpolates the logo gradient teal→blue", () => {
    expect(lineColorAt(0)).toBe(LINE_FROM);
    expect(lineColorAt(1)).toBe(LINE_TO);
    expect(stageLineColor("thought")).not.toBe(stageLineColor("shipped"));
  });
});

describe("deriveLiveStage — worker path", () => {
  it("reaches Merged once its OWN work is in the parent AND the orchestrator's work reached main", () => {
    // Re-aimed for the split: integrating into the parent branch is a LOCAL merge, so the worker
    // rolls up to merged_local rather than claiming its work is on origin main.
    expect(
      deriveLiveStage({
        kind: "worker",
        bs: bs(1),
        ws: ws({ inParent: true }),
        parentReachedMain: true,
      }),
    ).toBe("merged_local");
  });
  // Regression (the "Close this worker? Your code has been pushed to main" false pop-up): a freshly
  // spawned worker that has only made its first commit — never integrated into the parent — must NOT
  // read as Merged just because the parent has EVER reached main. Requires this worker's own branch
  // to actually be in the parent (inParent/landed), not merely parentReachedMain.
  it("does NOT reach Merged when its own work is NOT yet in the parent, even if the parent reached main", () => {
    expect(deriveLiveStage({ kind: "worker", bs: bs(1), parentReachedMain: true })).toBe(
      "building_saved",
    );
  });
  it("does NOT reach Merged with no committed work, even if the parent reached main (committedSeen gate)", () => {
    expect(deriveLiveStage({ kind: "worker", bs: bs(0), parentReachedMain: true })).toBe(
      "building_unsaved",
    );
  });
  it("merged into the orchestrator branch alone (inParent, parent not on main) is NOT Merged with Main", () => {
    expect(deriveLiveStage({ kind: "worker", bs: bs(1), ws: ws({ inParent: true }) })).toBe(
      "building_saved",
    );
  });
  it("ignores local-main reachability (that's a build-agent signal, not a worker's)", () => {
    expect(deriveLiveStage({ kind: "worker", bs: bs(1), ws: ws({ inLocalMain: true }) })).toBe(
      "building_saved",
    );
  });
  it("a squash-landed worker (its work in the parent via `landed`) reaches Merged once the parent is on main", () => {
    expect(
      deriveLiveStage({
        kind: "worker",
        bs: bs(1),
        ws: ws({ landed: true }),
        parentReachedMain: true,
      }),
    ).toBe("merged_local");
  });
  it("the squash `landed` signal alone (parent not on main) is NOT Merged with Main", () => {
    expect(deriveLiveStage({ kind: "worker", bs: bs(1), ws: ws({ landed: true }) })).toBe(
      "building_saved",
    );
  });
  it("off-base authored work (aheadOfBase) that is in the parent still lands when the parent reaches main", () => {
    expect(
      deriveLiveStage({
        kind: "worker",
        bs: bs(0),
        ws: ws({ aheadOfBase: 1, inParent: true }),
        parentReachedMain: true,
      }),
    ).toBe("merged_local");
  });
});

// The split that makes the CTA honest (founder screenshot 2, 2026-07-15): `merged` used to bump on
// inLocalMain || inOriginMain || landed, so "landed but unpushed" and "landed and pushed" were the
// same stage — which is how a Close pill appeared over work that still needed pushing.
describe("merged_local vs merged", () => {
  it("landed on LOCAL main only is merged_local, not merged", () => {
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: ws({ inLocalMain: true, aheadOfBase: 3 }),
        prev: "building_saved",
      }),
    ).toBe("merged_local");
  });

  it("landed on ORIGIN main is merged", () => {
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: ws({ inLocalMain: true, inOriginMain: true, aheadOfBase: 3 }),
        prev: "building_saved",
      }),
    ).toBe("merged");
  });

  // ── THE FOUNDER'S ROW (bead `sparkle-e3lxt7`) ──────────────────────────────────────────────────
  // An agent showed under "LOCAL: MERGED TO MAIN" with both of its PRs merged and on origin/main.
  // Its work had re-landed under a DIFFERENT sha — the normal case here, because the repo squashes
  // and rebases — so neither reachability signal was true and the only thing carrying the row was
  // Rust's ORIGIN-scoped `cherry_empty` arm. That arm was collapsed into a bare `landed` boolean, so
  // this boundary could not see it was origin-scoped and settled at the cautious merged_local.
  it("a SQUASH-RELANDED sha proven on ORIGIN main is merged, not merged_local", () => {
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        // The squash/re-land shape precisely: BOTH reachability signals false — the tip is an
        // ancestor of nothing — and the proof is patch-equivalence against origin/main.
        ws: ws({
          inLocalMain: false,
          inOriginMain: false,
          landed: true,
          landedOnOrigin: true,
          aheadOfBase: 2,
        }),
        prev: "building_saved",
      }),
    ).toBe("merged");
  });

  it("landedOnOrigin does not let a NO-OP branch skip the committedSeen gate", () => {
    // The promotion must INHERIT `landed`'s no-op guard, not bypass it: a branch that authored
    // nothing is trivially tree-identical to main and would otherwise claim it shipped.
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: ws({ landed: true, landedOnOrigin: true, aheadOfBase: 0 }),
      }),
    ).toBe("building_unsaved");
  });

  it("the founder's row files under a REMOTE build section, not a Local one", () => {
    // The label was wrong even by its own definition: buildSections documents merged_local as "seen
    // on LOCAL main, not yet seen on ORIGIN main", and here inLocalMain was false too. Assert the
    // CAPABILITY the fix protects — which side of the Local/Remote boundary the row files under —
    // rather than the stage string alone.
    const relanded = deriveLiveStage({
      kind: "build",
      bs: bs(0),
      ws: ws({ landed: true, landedOnOrigin: true, aheadOfBase: 2 }),
      prev: "building_saved",
    });
    const localOnly = deriveLiveStage({
      kind: "build",
      bs: bs(0),
      ws: ws({ inLocalMain: true, aheadOfBase: 3 }),
      prev: "building_saved",
    });
    expect(relanded).toBe("merged");
    expect(localOnly).toBe("merged_local");
    // `true` = holds work, which is the case for both rows here (aheadOfBase > 0).
    expect(sectionOfRow(relanded, true)).not.toBe(sectionOfRow(localOnly, true));
    // And name the sides explicitly, so a future re-shuffle of the section list can't make this
    // pass by moving BOTH rows to the same new place.
    expect(sectionOfRow(localOnly, true)).toBe("local_merged");
    expect(sectionOfRow(relanded, true)).toBe("remote_merged");
  });

  it("a GitHub-merged PR is merged (origin has it by definition)", () => {
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: ws({ prState: "merged", aheadOfBase: 3 }),
        prev: "building_saved",
      }),
    ).toBe("merged");
  });

  it("merged_local sits between pull_request and merged", () => {
    expect(stageIndex("pull_request")).toBeLessThan(stageIndex("merged_local"));
    expect(stageIndex("merged_local")).toBeLessThan(stageIndex("merged"));
  });

  it("the ladder is ten stages and shipped still fills the bar", () => {
    expect(WORKFLOW_STAGES).toHaveLength(10);
    expect(stageIndex("shipped")).toBe(9);
    expect(stageFraction("shipped")).toBe(1);
  });

  // New-cycle detection must trigger for work that landed only LOCALLY too, or an agent that landed
  // locally and then started fresh work would stay pinned at merged_local.
  it("a new cycle after a LOCAL-only land resets to building_saved", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(2), prev: "merged_local", ws: ws({}) })).toBe(
      "building_saved",
    );
  });

  it("a new cycle after an ORIGIN land still resets to building_saved", () => {
    // The pre-split behavior, re-pinned: lowering `landedBefore` to merged_local must not stop
    // new-cycle detection from firing for work that had reached origin.
    expect(deriveLiveStage({ kind: "build", bs: bs(2), prev: "merged", ws: ws({}) })).toBe(
      "building_saved",
    );
  });
});

// A worker's tip lives in its PARENT's branch, never in the default branch, so it can never observe
// origin main itself — it inherits the fact from the parent's stage. Without that inheritance a
// worker caps at merged_local forever, so its bead never closes (beadLifecycle closes at >= merged)
// and the sidebar ✓ never lights. Found by roborev review #37964 on the merged_local split.
describe("worker rollup: local parent vs origin parent", () => {
  const integratedWorker = (parentOnOriginMain: boolean) =>
    deriveLiveStage({
      kind: "worker",
      bs: bs(1),
      ws: ws({ inParent: true }),
      parentReachedMain: true,
      parentOnOriginMain,
    });

  it("caps at merged_local while the parent is only on LOCAL main", () => {
    expect(integratedWorker(false)).toBe("merged_local");
  });

  it("reaches the full merged once the parent's work is on ORIGIN main", () => {
    expect(integratedWorker(true)).toBe("merged");
  });

  it("parentOnOriginMain alone can't promote a worker whose work isn't in the parent yet", () => {
    expect(
      deriveLiveStage({
        kind: "worker",
        bs: bs(1),
        parentReachedMain: true,
        parentOnOriginMain: true,
      }),
    ).toBe("building_saved");
  });

  it("parentOnOriginMain still respects the committedSeen gate", () => {
    expect(
      deriveLiveStage({
        kind: "worker",
        bs: bs(0),
        ws: ws({ inParent: true }),
        parentReachedMain: true,
        parentOnOriginMain: true,
      }),
    ).toBe("building_unsaved");
  });
});

describe("rollupHoldsWork — a head answers for its whole subtree (sparkle-biezi)", () => {
  it("reports TRUE when anything in the subtree is dirty", () => {
    // The case that makes the roll-up necessary at all: the ladder buckets a head by its
    // LEAST-advanced worker, so a head whose worker is mid-edit already sits at `building_unsaved`.
    // Answering from the head's own clean tree would file it under "Nothing Yet — nothing here is
    // at risk" while the bar on that same row showed a worker holding uncommitted files.
    expect(rollupHoldsWork([false, true, false])).toBe(true);
    expect(rollupHoldsWork([true])).toBe(true);
  });

  it("TRUE outranks UNKNOWN — a known risk is not softened by an unread sibling", () => {
    expect(rollupHoldsWork([undefined, true])).toBe(true);
  });

  it("UNKNOWN outranks FALSE — a partly-unread subtree cannot be called empty", () => {
    // The conservative arm, and the one worth pinning: if this returned `false` the row would earn
    // the calm heading on the strength of a lookup nobody performed.
    expect(rollupHoldsWork([false, undefined, false])).toBe(undefined);
  });

  it("reports FALSE only when EVERY member was positively read and empty", () => {
    expect(rollupHoldsWork([false, false, false])).toBe(false);
    expect(rollupHoldsWork([false])).toBe(false);
  });

  it("an empty subtree is FALSE — a childless head speaks only for itself", () => {
    // Reached via [ownEvidence, ...noKids], so the array is never truly empty in production; pinned
    // so the identity element cannot drift to `undefined` and strand every childless row.
    expect(rollupHoldsWork([])).toBe(false);
  });
});

describe("uncommittedWorkEvidence — attribution, not safety", () => {
  const BS = { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 };

  it("is undefined when nothing was polled", () => {
    expect(uncommittedWorkEvidence(undefined)).toBe(undefined);
  });

  it("reports a dirty on-branch tree as this agent's work", () => {
    expect(uncommittedWorkEvidence({ ...BS, dirty: true })).toBe(true);
    expect(uncommittedWorkEvidence({ ...BS, dirty: true, worktreeOnBranch: true })).toBe(true);
  });

  it("declines a PARKED tree's DIRT — neither dirty nor proof of clean", () => {
    // A parked tree holds whatever branch was checked out into it, so its dirt is not attributable
    // here. `undefined` (not `false`) is what keeps `sectionOfRow` from calling such a row empty.
    expect(uncommittedWorkEvidence({ ...BS, dirty: true, worktreeOnBranch: false })).toBe(undefined);
  });

  it("reports a clean on-branch tree as positively empty", () => {
    expect(uncommittedWorkEvidence(BS)).toBe(false);
  });

  // ── The founder's false "LOCAL: UNCOMMITTED" heading (2026-08-06) ──────────────────────────────
  // This assertion USED TO READ `undefined`, and that was the bug, encoded as a passing test.
  it("reports a CLEAN parked tree as positively empty — attribution needs dirt to be about", () => {
    // Two rows were filed under "Local: Uncommitted" — "edits exist only in the working tree —
    // closing this agent loses them" — with `git status --porcelain` EMPTY, fully pushed, every PR
    // merged. `worktree_on_branch: false` is reported whenever the minted `sparkle/agent-<id>` ref
    // survives while the tree sits elsewhere, which is exactly what `git checkout -b <topic>`
    // leaves behind, and AGENTS.md encourages descriptive branch names.
    //
    // The parked gate answers "whose dirt is this?" — a question that only exists when there IS
    // dirt. A porcelain read of the DIRECTORY returning empty means no uncommitted files are in it,
    // whichever branch is checked out. So this is `false`, not `undefined`: we looked, and it was
    // empty. The arm above keeps the dirty case unknown, which is the case that gate was written for.
    expect(uncommittedWorkEvidence({ ...BS, dirty: false, worktreeOnBranch: false })).toBe(false);
  });

  it("keeps a clean parked row OUT of the alarming section, end to end", () => {
    // The consequence the heading is actually derived from — one rung up, so a future refactor that
    // re-splits these two functions cannot quietly restore the false copy.
    const holds = uncommittedWorkEvidence({ ...BS, dirty: false, worktreeOnBranch: false });
    expect(sectionOfRow("building_unsaved", holds)).toBe("local_none");
    // …while a DIRTY parked row still gets the cautious heading, because we genuinely do not know.
    const dirtyHolds = uncommittedWorkEvidence({ ...BS, dirty: true, worktreeOnBranch: false });
    expect(sectionOfRow("building_unsaved", dirtyHolds)).toBe("local_uncommitted");
  });

  it("does not let one clean parked worker drag its orchestrator into UNCOMMITTED", () => {
    // `rollupHoldsWork` is `true > undefined > false`, so a single `undefined` worker used to pull a
    // head with a spotless tree of its own under the heading too. That is how the second of the
    // founder's two rows got there: its own worktree was clean and on its own branch.
    const head = uncommittedWorkEvidence(BS);
    const renamedWorker = uncommittedWorkEvidence({ ...BS, dirty: false, worktreeOnBranch: false });
    expect(rollupHoldsWork([head, renamedWorker])).toBe(false);
    expect(sectionOfRow("building_unsaved", rollupHoldsWork([head, renamedWorker]))).toBe(
      "local_none",
    );
  });
});

describe("nested-worktree adoption reaches the stage ladder (sparkle-d5muhf)", () => {
  // The measured row: an agent whose own branch is ahead=0 (its PR merged, nothing of its own left
  // on it) while a worktree it cut INSIDE its own checkout holds four unlanded commits. Rust adopts
  // that nested branch, so `aheadOfBase` reports the subtree's outstanding work; `bs.ahead` still
  // reports the one branch the row names, and is still 0.
  const adoptedFour = ws({ aheadOfBase: 4, inOriginMain: false, inLocalMain: false });

  it("an adopted nested branch's commits lift the row off Unsaved", () => {
    // ⚠️ THE ASSERTION IS ON THE SECTION, not only the stage: `building_unsaved` is what
    // `sectionOfStage` maps to `local_uncommitted`, whose copy tells the founder that closing this
    // agent loses the work. That heading and its "Unsaved" chip are the user-visible defect.
    const stage = deriveLiveStage({ kind: "build", bs: bs(0), ws: adoptedFour });
    expect(stageIndex(stage)).toBeGreaterThanOrEqual(stageIndex("building_saved"));
    expect(sectionOfRow(stage, false)).not.toBe("local_uncommitted");
    expect(sectionOfRow(stage, true)).not.toBe("local_uncommitted");
  });

  it("PAIRED NEGATIVE: with nothing adopted the reading is exactly what it always was", () => {
    // An agent with NO nested worktree sends `aheadOfBase: 0`, and must be untouched — including
    // the dirty-tree case, whose "Unsaved" heading is TRUE and must survive.
    expect(deriveLiveStage({ kind: "build", bs: bs(0), ws: ws() })).toBe("building_unsaved");
    expect(deriveLiveStage({ kind: "build", bs: bs(0, true), ws: ws() })).toBe("building_unsaved");
    expect(sectionOfRow("building_unsaved", true)).toBe("local_uncommitted");
  });

  it("LEAST-ADVANCED WINS: a subtree still holding work never reads as merged", () => {
    // Rust AND-folds `inOriginMain` across the subtree, so the agent that motivated this — whose own
    // branch IS an ancestor of origin/main — reads as holding unlanded work rather than as merged.
    // That is the honest answer, and it is what this row must render.
    expect(deriveLiveStage({ kind: "build", bs: bs(0), ws: adoptedFour })).toBe("building_saved");
  });

  // ── THE COST OF LEAST-ADVANCED-WINS, PINNED SO IT IS A DECISION AND NOT A SURPRISE ──────────
  //
  // roborev 65903 named this and it is real: an agent whose own work MERGED, but which left a
  // `.claude/worktrees/<name>` scratch checkout holding committed-but-unlanded commits, is pulled
  // back off `merged`. The monotonic watermark does not absorb it — `newCycle` fires precisely
  // because prior work landed, the live signals fell back, and there IS fresh unlanded work — and
  // that is the branch of `deriveLiveStage` doing exactly what it was written to do.
  //
  // The consequences are not cosmetic and are recorded here rather than discovered later:
  // `hasUnmergedCommittedWork` goes true, so the finished agent sits in the `unmerged` attention
  // tier; `beadLifecycle` closes at >= merged, so its bead stays open; the sidebar ✓ does not light.
  // AGENTS.md actively tells agents to cut these scratch worktrees and `scripts/stale-worktrees.sh`
  // exists because nobody tears them down, so this is a steady state, not a corner.
  //
  // It is nevertheless the RIGHT answer, and the reason is the same one the adoption exists for:
  // those commits are real, unlanded, and reachable from nothing a row previously showed. Reporting
  // "merged" over them is the false negative that loses work — measured at 39 unlanded commits
  // across 8 nested branches on this machine. A row that says "still holds work" is actionable; a
  // green row over lost commits is not. What is genuinely missing is that the row cannot yet name
  // WHICH branch holds it back — that is a follow-up, not a reason to soften the reading.
  it("DELIBERATE: a leftover nested checkout holding work demotes a merged row", () => {
    const stage = deriveLiveStage({
      kind: "build",
      bs: bs(0),
      ws: ws({ aheadOfBase: 2, inOriginMain: false, inLocalMain: false, landed: false }),
      prev: "merged",
    });
    expect(stage).toBe("building_saved");
    // The downstream consequence, asserted rather than left implicit.
    expect(hasUnmergedCommittedWork(stage)).toBe(true);
    expect(stageIndex(stage)).toBeLessThan(stageIndex("merged"));
  });

  it("PAIRED: a merged row with NOTHING nested keeps its watermark", () => {
    // Without this the test above is satisfied by a `deriveLiveStage` that simply stopped honouring
    // `prev` at all, which would demote every finished agent in the fleet.
    expect(
      deriveLiveStage({ kind: "build", bs: bs(0), ws: ws({ inOriginMain: true }), prev: "merged" }),
    ).toBe("merged");
  });

  it("DOWNSTREAM: an adopted branch that HAS landed still crosses into `merged`", () => {
    // The claim a later unit depends on. Once the adopted branch is an ancestor of origin/main,
    // `aheadOfBase` is back to 0 — so the committedSeen gate is carried by `pushed`, which adoption
    // is likewise what supplies (the agent's own no-op branch was never pushed). See the Rust test
    // `adopting_a_landed_nested_branch_supplies_the_signals_that_reach_merged`.
    const landed = ws({ aheadOfBase: 0, inOriginMain: true, pushed: true });
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: landed,
        pushed: true,
        prev: "building_unsaved",
      }),
    ).toBe("merged");
    // …and WITHOUT the adopted signals the very same agent cannot get there at all, which is why
    // the crossing depends on adoption rather than merely coexisting with it.
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: ws({ inOriginMain: true }),
        prev: "building_unsaved",
      }),
    ).toBe("building_unsaved");
  });
});

describe("unlandedWorkEvidence — a LIVE reading beats a STALE watermark", () => {
  // The guard these pin (bead `sparkle-qh6j7g`) short-circuits the new-work-cycle veto roborev 55334
  // installed, so its dangerous direction has to be pinned HERE, at the function, not at a caller
  // that refuses earlier for an unrelated reason. Replacing the whole `nothingOutstanding` expression
  // with `true` must red at least one of these.

  it("a stale sub-merged watermark cannot outvote reachability plus two live zeroes", () => {
    // THE MEASURED CASE. The watermark is monotonic and only moves when a poll OBSERVES a crossing,
    // so a PR that merged unwatched leaves it at `pull_request` — which `hasUnmergedCommittedWork`
    // calls outstanding work, over a tip that is IN origin main with nothing ahead of the base.
    expect(
      unlandedWorkEvidence({
        bs: bs(0),
        ws: ws({ inOriginMain: true, aheadOfBase: 0 }),
        stageOverride: "pull_request",
      }),
    ).toBe(false);
  });

  it("…but the same stale watermark still wins when the branch IS ahead", () => {
    // The direction that must not be lost: prior work landed, then three fresh commits. Both live
    // counters are non-zero, so the guard must not fire and the veto must report outstanding work.
    // This is the assertion an unconditionally-true `nothingOutstanding` reds.
    expect(
      unlandedWorkEvidence({
        bs: bs(3),
        ws: ws({ inOriginMain: true, aheadOfBase: 3 }),
        stageOverride: "pushed",
      }),
    ).toBe(true);
  });

  it("a SQUASH land is answered by landedOnOrigin, which is the only thing that can answer it", () => {
    // A squash land leaves the tip an ancestor of nothing, so `ahead` never returns to zero — and
    // `aheadOfBase` is a plain `rev-list --count base..branch` on the Rust side, so it does not
    // either. The zeroes above are structurally unable to speak for this shape.
    expect(
      unlandedWorkEvidence({
        bs: bs(3),
        ws: ws({ landed: true, landedOnOrigin: true, aheadOfBase: 3 }),
        stageOverride: "pushed",
      }),
    ).toBe(false);
  });

  it("…and NEW commits after that squash land put it back to outstanding", () => {
    // `landedOnOrigin` is the proof that merging would add NOTHING, so it falls back to false the
    // moment a new commit means merging WOULD add something. Without this pair, "landed by squash"
    // and "landed by squash, then kept working" are one reading.
    expect(
      unlandedWorkEvidence({
        bs: bs(5),
        ws: ws({ landed: true, landedOnOrigin: false, aheadOfBase: 5 }),
        stageOverride: "pushed",
      }),
    ).toBe(true);
  });

  it("LOCAL main is not origin main — merged_local is still outstanding work", () => {
    // `alreadyInBase` carries the local proofs too, and reusing it here would answer `false` for a
    // branch merged into LOCAL main with both counters at zero — which `deriveLiveStage` puts at
    // `merged_local`, a rung `hasUnmergedCommittedWork` calls outstanding ON PURPOSE, because
    // local-only work still needs someone to get it the rest of the way. Retiring it here would
    // silently take down the unmerged chip, the `unlanded-work` stall cause and the `mayRetire`
    // input for every repo that lands locally without pushing.
    expect(
      unlandedWorkEvidence({
        bs: bs(0),
        ws: ws({ inLocalMain: true, aheadOfBase: 0 }),
        stageOverride: "pull_request",
      }),
    ).toBe(true);
  });

  it("a SECOND lap merged only into local main is still outstanding, stale merged watermark or not", () => {
    // The sibling veto's half of the same origin-scoping. Lap 1 crossed origin and latched the
    // watermark at `merged`; lap 2 merged three commits into LOCAL main without pushing. With
    // `inLocalMain` allowed to veto the `ahead > 0` positive, the fall-through would consult that
    // stale `merged` watermark and answer `false` over three unpushed commits.
    expect(
      unlandedWorkEvidence({
        bs: bs(3),
        ws: ws({ inLocalMain: true, aheadOfBase: 3 }),
        stageOverride: "merged",
      }),
    ).toBe(true);
  });

  it("a branch in NO base is unaffected by the guard", () => {
    expect(
      unlandedWorkEvidence({ bs: bs(2), ws: ws({ aheadOfBase: 2 }), stageOverride: "pushed" }),
    ).toBe(true);
  });
});

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
} from "./workflowStage";
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
    // Re-aimed for the split: `landed` cannot distinguish local main from origin main, so it settles
    // at the cautious merged_local — the CTA then offers Push rather than a premature Close.
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

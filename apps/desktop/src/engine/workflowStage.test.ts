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
  "merged",
  "shipped",
];

describe("the 9-stage model", () => {
  it("has the nine stages in the canonical order", () => {
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
  it("reachability into main → merged, but only once real work is seen", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(0), ws: ws({ inLocalMain: true }) })).toBe(
      "building_unsaved",
    );
    expect(deriveLiveStage({ kind: "build", bs: bs(1), ws: ws({ inLocalMain: true }) })).toBe(
      "merged",
    );
  });
  it("shipped is the top, gated on real work", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(1), shipped: true })).toBe("shipped");
    expect(deriveLiveStage({ kind: "build", bs: bs(0), shipped: true })).toBe("building_unsaved");
  });
  it("squash-merge: tip not an ancestor (landed) but work present → merged", () => {
    // The branch's commits still exist on its ref post-squash, so aheadOfBase stays >0 (committedSeen)
    // while inLocalMain/inOriginMain are false. `landed` (tree-identical to main) is the squash signal.
    expect(
      deriveLiveStage({ kind: "build", bs: bs(0), ws: ws({ landed: true, aheadOfBase: 2 }) }),
    ).toBe("merged");
    // committedSeen can also come from this tick's own commits.
    expect(deriveLiveStage({ kind: "build", bs: bs(1), ws: ws({ landed: true }) })).toBe("merged");
  });
  it("a no-op branch is trivially tree-identical (landed) but stays unsaved (committedSeen gate)", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs(0), ws: ws({ landed: true }) })).toBe(
      "building_unsaved",
    );
  });
  it("normal merge after relaunch: persisted watermark keeps committedSeen → merged, not unsaved", () => {
    // Post-merge ahead→0 and aheadOfBase→0; without a persisted `prev` this collapsed to unsaved.
    // The persisted watermark (building_saved) restores committedSeen so inLocalMain → merged.
    expect(
      deriveLiveStage({
        kind: "build",
        bs: bs(0),
        ws: ws({ inLocalMain: true }),
        prev: "building_saved",
      }),
    ).toBe("merged");
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

describe("rollup + dominant", () => {
  it("rollup headline = least-advanced; counts cover all 9 ids", () => {
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
  it("fraction climbs 1/9 … 9/9 across the stages", () => {
    expect(stageFraction("thought")).toBeCloseTo(1 / 9);
    expect(stageFraction("building_saved")).toBeCloseTo(5 / 9);
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
    expect(
      deriveLiveStage({
        kind: "worker",
        bs: bs(1),
        ws: ws({ inParent: true }),
        parentReachedMain: true,
      }),
    ).toBe("merged");
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
    ).toBe("merged");
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
    ).toBe("merged");
  });
});

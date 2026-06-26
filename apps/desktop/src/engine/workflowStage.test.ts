import { describe, it, expect } from "vitest";
import {
  WORKFLOW_STAGES,
  stageIndex,
  stageMeta,
  gitDerivedStage,
  resolveStage,
  rollupStages,
  dominantStage,
  deriveLiveStage,
  type WorkflowStageId,
} from "./workflowStage";
import type { BranchStatus, WorkflowState } from "../services/branchStatus";

const bs = (p: Partial<BranchStatus>): BranchStatus => ({
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  ...p,
});

const ws = (p: Partial<WorkflowState>): WorkflowState => ({
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: null,
  prNumber: null,
  prUrl: null,
  ...p,
});

describe("WORKFLOW_STAGES ordering", () => {
  it("is the canonical earliest→final order", () => {
    expect(WORKFLOW_STAGES.map((s) => s.id)).toEqual([
      "uncommitted",
      "committed",
      "pull_request",
      "main",
      "merged",
    ]);
  });

  it("stageIndex / stageMeta agree with the array", () => {
    expect(stageIndex("uncommitted")).toBe(0);
    expect(stageIndex("merged")).toBe(4);
    expect(stageMeta("pull_request").label).toBe("Pull Request");
  });

  it("ends on green and every stage has a distinct color", () => {
    const merged = stageMeta("merged");
    expect(merged.color).toBe("#34c759"); // brand success green — the path's end
    const colors = WORKFLOW_STAGES.map((s) => s.color);
    expect(new Set(colors).size).toBe(WORKFLOW_STAGES.length);
  });
});

describe("gitDerivedStage", () => {
  it("no status yet → uncommitted (start line)", () => {
    expect(gitDerivedStage(undefined)).toBe("uncommitted");
    expect(gitDerivedStage(null)).toBe("uncommitted");
  });

  it("clean tree, no commits → uncommitted", () => {
    expect(gitDerivedStage(bs({}))).toBe("uncommitted");
  });

  it("dirty / changed files but no commits → uncommitted", () => {
    expect(gitDerivedStage(bs({ dirty: true, filesChanged: 2 }))).toBe("uncommitted");
    expect(gitDerivedStage(bs({ filesChanged: 1 }))).toBe("uncommitted");
  });

  it("commits ahead → committed", () => {
    expect(gitDerivedStage(bs({ ahead: 1 }))).toBe("committed");
  });

  it("committed work wins even with a fresh dirty edit on top (no backwards regress)", () => {
    expect(gitDerivedStage(bs({ ahead: 3, dirty: true, filesChanged: 1 }))).toBe("committed");
  });
});

describe("resolveStage (git + override)", () => {
  it("uses git when there is no override", () => {
    expect(resolveStage(bs({ ahead: 1 }), null)).toBe("committed");
  });

  it("an override pulls the stage forward to PR/main/merged", () => {
    expect(resolveStage(bs({ ahead: 1 }), "pull_request")).toBe("pull_request");
    expect(resolveStage(bs({ ahead: 1 }), "merged")).toBe("merged");
  });

  it("never regresses below what git proves", () => {
    // git says committed; a stale "uncommitted" override must not drag it back
    expect(resolveStage(bs({ ahead: 2 }), "uncommitted")).toBe("committed");
  });
});

describe("rollupStages", () => {
  it("returns null for no workers", () => {
    expect(rollupStages([])).toBeNull();
  });

  it("headline stage is the least-advanced worker", () => {
    const r = rollupStages(["merged", "committed", "main"])!;
    expect(r.stage).toBe("committed");
    expect(r.total).toBe(3);
  });

  it("counts every stage", () => {
    const r = rollupStages(["committed", "committed", "merged"])!;
    expect(r.counts.committed).toBe(2);
    expect(r.counts.merged).toBe(1);
    expect(r.counts.uncommitted).toBe(0);
  });
});

describe("deriveLiveStage", () => {
  it("falls back to local git when there are no workflow signals", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs({ dirty: true }) })).toBe("uncommitted");
    expect(deriveLiveStage({ kind: "build", bs: bs({ ahead: 2 }) })).toBe("committed");
  });

  it("an open PR advances to Pull Request", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs({ ahead: 1 }), ws: ws({ prState: "open" }) })).toBe(
      "pull_request",
    );
  });

  it("a merged PR is Merged (authoritative)", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs({ ahead: 1 }), ws: ws({ prState: "merged" }) })).toBe(
      "merged",
    );
  });

  it("build agent: reachable into local main → On Main, into origin → Merged (gated on real work)", () => {
    // ahead>0 this poll proves work exists, so reachability is believed.
    expect(deriveLiveStage({ kind: "build", bs: bs({ ahead: 1 }), ws: ws({ inLocalMain: true }) })).toBe(
      "main",
    );
    expect(
      deriveLiveStage({ kind: "build", bs: bs({ ahead: 1 }), ws: ws({ inLocalMain: true, inOriginMain: true }) }),
    ).toBe("merged");
  });

  it("does NOT believe reachability for a no-work branch (fresh tip is trivially in main)", () => {
    // No commits ever (bs ahead 0, no prev watermark): a fresh branch's tip sits in main, but that
    // must NOT read as On Main.
    expect(deriveLiveStage({ kind: "build", bs: bs({}), ws: ws({ inLocalMain: true }) })).toBe(
      "uncommitted",
    );
  });

  it("remembers work via the watermark after a merge drops ahead to 0", () => {
    // The merge landed the work (ahead now 0, tip in main). prev=Committed proves work existed.
    expect(
      deriveLiveStage({ kind: "build", bs: bs({ ahead: 0 }), ws: ws({ inLocalMain: true }), prev: "committed" }),
    ).toBe("main");
  });

  it("worker: inParent → On Main; parentReachedMain → Merged", () => {
    expect(deriveLiveStage({ kind: "worker", bs: bs({ ahead: 1 }), ws: ws({ inParent: true }) })).toBe(
      "main",
    );
    expect(
      deriveLiveStage({ kind: "worker", bs: bs({ ahead: 1 }), ws: ws({ inParent: true }), parentReachedMain: true }),
    ).toBe("merged");
  });

  it("worker does not use local-main reachability (only its orchestrator branch)", () => {
    // A worker's tip being in main shouldn't matter — its integration target is the orchestrator.
    expect(deriveLiveStage({ kind: "worker", bs: bs({ ahead: 1 }), ws: ws({ inLocalMain: true }) })).toBe(
      "committed",
    );
  });

  it("never regresses below the previous stage", () => {
    expect(deriveLiveStage({ kind: "build", bs: bs({ dirty: true }), prev: "merged" })).toBe("merged");
  });

  it("aheadOfBase satisfies the committed gate when bs.ahead is measured against a non-default base", () => {
    // bs.ahead == 0 (synced to its baseBranch) but the branch IS ahead of project main → work
    // exists, so reachability into the parent should be believed even without a prev watermark.
    expect(
      deriveLiveStage({ kind: "worker", bs: bs({ ahead: 0 }), ws: ws({ aheadOfBase: 1, inParent: true }) }),
    ).toBe("main");
    // Without that signal (and no commits anywhere), the same reachability is NOT believed.
    expect(
      deriveLiveStage({ kind: "worker", bs: bs({ ahead: 0 }), ws: ws({ aheadOfBase: 0, inParent: true }) }),
    ).toBe("uncommitted");
  });
});

describe("dominantStage", () => {
  const count = (stages: WorkflowStageId[]) => rollupStages(stages)!.counts;

  it("picks the most common stage", () => {
    expect(dominantStage(count(["committed", "committed", "merged"]))).toBe("committed");
  });

  it("breaks ties toward the earliest (more cautious) stage", () => {
    expect(dominantStage(count(["committed", "merged"]))).toBe("committed");
  });
});

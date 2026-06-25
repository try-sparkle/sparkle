import { describe, it, expect } from "vitest";
import {
  WORKFLOW_STAGES,
  stageIndex,
  stageMeta,
  gitDerivedStage,
  resolveStage,
  rollupStages,
  dominantStage,
  type WorkflowStageId,
} from "./workflowStage";
import type { BranchStatus } from "../services/branchStatus";

const bs = (p: Partial<BranchStatus>): BranchStatus => ({
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
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

describe("dominantStage", () => {
  const count = (stages: WorkflowStageId[]) => rollupStages(stages)!.counts;

  it("picks the most common stage", () => {
    expect(dominantStage(count(["committed", "committed", "merged"]))).toBe("committed");
  });

  it("breaks ties toward the earliest (more cautious) stage", () => {
    expect(dominantStage(count(["committed", "merged"]))).toBe("committed");
  });
});

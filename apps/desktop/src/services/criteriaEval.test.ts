import { describe, it, expect, beforeEach } from "vitest";
import { evaluateStage, type EvalContext } from "./criteriaEval";
import { useCriteriaStore } from "./criteriaStore";
import type { Bead } from "./beads";
import type { StageDefinition } from "./stageDefs";

const bead = (over: Partial<Bead> = {}): Bead => ({
  id: "sparkle-1",
  title: "t",
  description: "",
  status: "open",
  labels: [],
  parent: null,
  ...over,
});

// A "done" definition with one AUTO (merged_to_main) + one MANUAL criterion.
const doneDef: StageDefinition = {
  description: "Merged into origin/main.",
  criteria: [
    { text: "Merged into origin/main", kind: "auto", signal: "merged_to_main" },
    { text: "Reviewed by a teammate", kind: "manual" },
  ],
};

const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({ key: "done", ...over });

describe("evaluateStage", () => {
  beforeEach(() => useCriteriaStore.setState({ ticks: {} }));

  it("auto met (closed bead) + manual UNticked → auto met, manual unmet, NOT allMet", () => {
    const ev = evaluateStage(bead({ status: "closed" }), doneDef, ctx());
    expect(ev.key).toBe("done");
    expect(ev.criteria[0]).toMatchObject({ state: "met", manual: false });
    expect(ev.criteria[1]).toMatchObject({ state: "unmet", manual: true });
    expect(ev.allMet).toBe(false);
  });

  it("auto met + manual TICKED → both met, allMet", () => {
    useCriteriaStore.getState().setChecked("sparkle-1", "done", 1, true);
    const ev = evaluateStage(bead({ status: "closed" }), doneDef, ctx());
    expect(ev.criteria[0]?.state).toBe("met");
    expect(ev.criteria[1]?.state).toBe("met");
    expect(ev.allMet).toBe(true);
  });

  it("auto UNMET (open, no stage) + manual ticked → not allMet", () => {
    useCriteriaStore.getState().setChecked("sparkle-1", "done", 1, true);
    const ev = evaluateStage(bead({ status: "open" }), doneDef, ctx());
    expect(ev.criteria[0]?.state).toBe("unmet");
    expect(ev.criteria[1]?.state).toBe("met");
    expect(ev.allMet).toBe(false);
  });

  it("merged_to_main also met when the 9-stage stage has reached merged/shipped", () => {
    const ev = evaluateStage(bead({ status: "in_progress" }), doneDef, ctx({ stage: "merged" }));
    expect(ev.criteria[0]?.state).toBe("met");
  });

  it("pushed is met once the stage reaches pushed, unmet before, unknown with no stage", () => {
    const def: StageDefinition = {
      criteria: [{ text: "Pushed", kind: "auto", signal: "pushed" }],
    };
    expect(evaluateStage(bead(), def, ctx({ stage: "pushed" })).criteria[0]?.state).toBe("met");
    expect(evaluateStage(bead(), def, ctx({ stage: "building_saved" })).criteria[0]?.state).toBe("unmet");
    expect(evaluateStage(bead(), def, ctx()).criteria[0]?.state).toBe("unknown");
  });

  it("pr_merged reads from the live workflow state, unknown when absent", () => {
    const def: StageDefinition = {
      criteria: [{ text: "PR merged", kind: "auto", signal: "pr_merged" }],
    };
    const merged = { prState: "merged" } as never;
    const open = { prState: "open" } as never;
    expect(evaluateStage(bead(), def, ctx({ workflowState: merged })).criteria[0]?.state).toBe("met");
    expect(evaluateStage(bead(), def, ctx({ workflowState: open })).criteria[0]?.state).toBe("unmet");
    expect(evaluateStage(bead(), def, ctx()).criteria[0]?.state).toBe("unknown");
  });

  it("in_release prefers the monitor verdict, falls back to the delivered label", () => {
    const def: StageDefinition = {
      criteria: [{ text: "In a cut release", kind: "auto", signal: "in_release" }],
    };
    const dctx = (over: Partial<EvalContext> = {}): EvalContext => ({ key: "delivered", ...over });
    // Explicit monitor verdict wins.
    expect(evaluateStage(bead(), def, dctx({ inRelease: true })).criteria[0]?.state).toBe("met");
    expect(evaluateStage(bead(), def, dctx({ inRelease: false })).criteria[0]?.state).toBe("unmet");
    // No monitor verdict → legacy `delivered` label is the fallback signal.
    expect(evaluateStage(bead({ labels: ["delivered"] }), def, dctx()).criteria[0]?.state).toBe("met");
    expect(evaluateStage(bead(), def, dctx()).criteria[0]?.state).toBe("unmet");
  });

  it("an empty definition is never allMet", () => {
    expect(evaluateStage(bead(), { criteria: [] }, ctx()).allMet).toBe(false);
  });
});

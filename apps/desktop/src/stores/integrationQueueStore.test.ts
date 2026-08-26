// The merge queue's own rules: what a re-plan keeps, what it throws away, and what a late response
// is allowed to do to a queue that has moved on.
import { beforeEach, describe, expect, it } from "vitest";
import { useIntegrationQueueStore, warningsFor } from "./integrationQueueStore";
import type { GateReport, MergePlan, PlannedMerge } from "../services/integrationAssistant";

function planned(branch: string, position: number, changedFiles = 2): PlannedMerge {
  return {
    branch,
    pr: position,
    position,
    changedFiles,
    overlapsWith: [],
    externalOverlap: null,
    prDraft: null,
  };
}

function plan(order: PlannedMerge[]): MergePlan {
  return { base: "origin/main", order, warnings: [], unplannable: [] };
}

function ready(branch: string): GateReport {
  return {
    branch,
    pr: 1,
    verdict: "ready",
    reason: null,
    checks: "pass",
    roborevBlocking: 0,
    localGate: "not-run",
  };
}

beforeEach(() => useIntegrationQueueStore.getState().reset());

describe("setPlan", () => {
  it("throws away a verdict whose branch's diff MOVED, and keeps one whose diff did not", () => {
    // THE SIDE EFFECT: a green chip earned before a force-push must not survive to authorize a
    // merge of what came after. The pair is what makes it a rule rather than an unconditional
    // clear — clearing everything would cost a `gh` round-trip per branch on every re-plan.
    const store = useIntegrationQueueStore.getState();
    store.setPlan(plan([planned("moved", 1, 2), planned("still", 2, 5)]));
    useIntegrationQueueStore.getState().setGate(ready("moved"));
    useIntegrationQueueStore.getState().setGate(ready("still"));
    expect(useIntegrationQueueStore.getState().entries.every((e) => e.gate !== null)).toBe(true);

    useIntegrationQueueStore.getState().setPlan(plan([planned("moved", 1, 7), planned("still", 2, 5)]));
    const after = useIntegrationQueueStore.getState().entries;
    expect(after.find((e) => e.branch === "moved")?.gate).toBeNull();
    expect(after.find((e) => e.branch === "still")?.gate).not.toBeNull();
  });

  it("keeps a proven merge outcome across a re-plan — a re-plan cannot unmake a merge", () => {
    const store = useIntegrationQueueStore.getState();
    store.setPlan(plan([planned("a", 1)]));
    useIntegrationQueueStore.getState().setOutcome({
      branch: "a",
      pr: 1,
      landed: true,
      refusal: null,
      headSha: "abc",
      cleanup: "deleted the remote branch a",
    });
    // A re-plan reporting a different diff size clears the GATE (above) but must not clear this.
    useIntegrationQueueStore.getState().setPlan(plan([planned("a", 1, 99)]));
    expect(useIntegrationQueueStore.getState().entries[0]?.outcome?.landed).toBe(true);
  });

  it("replaces the order rather than merging into it, so a dropped branch is really gone", () => {
    const store = useIntegrationQueueStore.getState();
    store.setPlan(plan([planned("a", 1), planned("b", 2)]));
    useIntegrationQueueStore.getState().setPlan(plan([planned("b", 1)]));
    expect(useIntegrationQueueStore.getState().entries.map((e) => e.branch)).toEqual(["b"]);
    expect(useIntegrationQueueStore.getState().base).toBe("origin/main");
  });
});

describe("setGate / setOutcome", () => {
  it("DISCARDS a late response for a branch the queue no longer holds", () => {
    // A response that arrives after a re-plan removed its branch must not append it back into the
    // order, where nothing planned it and nothing checked what it collides with.
    const store = useIntegrationQueueStore.getState();
    store.setPlan(plan([planned("a", 1)]));
    useIntegrationQueueStore.getState().setGate(ready("ghost"));
    useIntegrationQueueStore.getState().setOutcome({
      branch: "ghost",
      pr: 9,
      landed: true,
      refusal: null,
      headSha: null,
      cleanup: "",
    });
    const entries = useIntegrationQueueStore.getState().entries;
    expect(entries.map((e) => e.branch)).toEqual(["a"]);
    expect(entries[0]?.gate).toBeNull();
    expect(entries[0]?.outcome).toBeNull();
  });

  it("clears the busy flag when a verdict or an outcome arrives", () => {
    const store = useIntegrationQueueStore.getState();
    store.setPlan(plan([planned("a", 1)]));
    useIntegrationQueueStore.getState().setBusy("a", true);
    expect(useIntegrationQueueStore.getState().entries[0]?.busy).toBe(true);
    useIntegrationQueueStore.getState().setGate(ready("a"));
    // A row left spinning forever after its answer arrived is a UI that looks hung.
    expect(useIntegrationQueueStore.getState().entries[0]?.busy).toBe(false);
  });
});

describe("warningsFor", () => {
  it("matches a branch on EITHER side of the pair", () => {
    const w = { a: "x", b: "y", paths: ["p"], sentence: "x and y both change 1 file: p." };
    const other = { a: "q", b: "r", paths: ["z"], sentence: "q and r both change 1 file: z." };
    expect(warningsFor("y", [w, other])).toEqual([w]);
    expect(warningsFor("x", [w, other])).toEqual([w]);
    expect(warningsFor("nobody", [w, other])).toEqual([]);
  });
});

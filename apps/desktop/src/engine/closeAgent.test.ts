import { describe, it, expect } from "vitest";
import { shouldPromptOnClose, selectionAfterClose, type CloseSelectionAgent } from "./closeAgent";
import type { BranchStatus } from "../services/branchStatus";
import type { AgentKind } from "../types";

const bs = (ahead: number, dirty = false): BranchStatus => ({
  ahead,
  behind: 0,
  dirty,
  filesChanged: dirty ? 1 : 0,
  insertions: 0,
  deletions: 0,
});

describe("shouldPromptOnClose", () => {
  it("prompts for a build agent with committed-but-unmerged work", () => {
    expect(shouldPromptOnClose("build", "building_saved", bs(2))).toBe(true);
  });
  it("prompts for a build agent with only uncommitted (dirty) changes", () => {
    expect(shouldPromptOnClose("build", "building_unsaved", bs(0, true))).toBe(true);
  });
  it("does NOT prompt once the work has merged (safe to close silently)", () => {
    expect(shouldPromptOnClose("build", "merged", bs(2))).toBe(false);
    expect(shouldPromptOnClose("build", "shipped", bs(2))).toBe(false);
  });
  it("does NOT prompt for a build agent with a KNOWN-clean tree (polled, no work)", () => {
    expect(shouldPromptOnClose("build", "building_unsaved", bs(0, false))).toBe(false);
  });
  it("prompts when branch status is unknown (unpolled) — err toward the choice, never silent loss", () => {
    expect(shouldPromptOnClose("build", "building_unsaved", undefined)).toBe(true);
    // …but a merged build agent with unknown status is still safe to close silently.
    expect(shouldPromptOnClose("build", "merged", undefined)).toBe(false);
    // …and a non-build agent never prompts regardless.
    expect(shouldPromptOnClose("worker", "building_unsaved", undefined)).toBe(false);
  });
  it("does NOT prompt for workers (own merged nudge) or think/shell (no worktree)", () => {
    expect(shouldPromptOnClose("worker", "building_saved", bs(2))).toBe(false);
    expect(shouldPromptOnClose("think", "building_saved", bs(2))).toBe(false);
    expect(shouldPromptOnClose("shell", "building_saved", bs(2))).toBe(false);
  });
});

describe("selectionAfterClose", () => {
  const ag = (
    id: string,
    kind: AgentKind,
    parentId: string | null = null,
    pinnedIndex: number | null = null,
  ): CloseSelectionAgent => ({ id, kind, parentId, pinnedIndex });
  // The original bug fixture: a think agent sits first in insertion order, so removeAgent's raw
  // agents[0] fallback would strand the Build sidebar on the think pane.
  const before = [ag("t1", "think"), ag("b1", "build"), ag("b2", "build")];

  it("closing the OPEN build agent re-selects the first VISIBLE build row (not the think agent)", () => {
    const after = [ag("t1", "think"), ag("b2", "build")]; // b1 removed
    const d = selectionAfterClose("b1", "b1", before, after, "build", "manual", {});
    expect(d).toEqual({ reselect: true, next: "b2" });
  });

  it("closing the LAST build agent clears selection → blank first-load state", () => {
    const after = [ag("t1", "think")]; // both build agents gone
    const d = selectionAfterClose("b1", "b1", [ag("t1", "think"), ag("b1", "build")], after, "build", "manual", {});
    expect(d).toEqual({ reselect: true, next: null });
  });

  it("closing a NON-open row leaves selection put", () => {
    const after = [ag("t1", "think"), ag("b1", "build")]; // closed b2, but b1 is open
    const d = selectionAfterClose("b2", "b1", before, after, "build", "manual", {});
    expect(d).toEqual({ reselect: false, next: "b1" });
  });

  it("treats closing the open agent's WORKER-parent as closing the open agent", () => {
    // The open selection is a worker whose parent build agent is being torn down (workers go with
    // it), so selection is invalidated and must move to the first visible row.
    const withWorker = [ag("b1", "build"), ag("w1", "worker", "b1"), ag("b2", "build")];
    const after = [ag("b2", "build")]; // b1 + its worker w1 removed
    const d = selectionAfterClose("b1", "w1", withWorker, after, "build", "manual", {});
    expect(d).toEqual({ reselect: true, next: "b2" });
  });

  it("does nothing when nothing is selected", () => {
    const after = [ag("t1", "think"), ag("b2", "build")];
    const d = selectionAfterClose("b1", null, before, after, "build", "manual", {});
    expect(d).toEqual({ reselect: false, next: null });
  });

  it("respects the active mode — closing the open think agent re-selects a think row", () => {
    const beforeThink = [ag("t1", "think"), ag("t2", "think"), ag("b1", "build")];
    const after = [ag("t2", "think"), ag("b1", "build")]; // t1 removed
    const d = selectionAfterClose("t1", "t1", beforeThink, after, "think", "manual", {});
    expect(d).toEqual({ reselect: true, next: "t2" });
  });
});

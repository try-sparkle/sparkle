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
  it("prompts when the worktree is PARKED off its branch — the files are still there (sparkle-xk3x)", () => {
    // Parking (the old land.sh checking `main` into an agent worktree) CARRIES uncommitted files
    // along. They are still on disk and still the user's, so deleting the worktree destroys them.
    // This is the same fail-safe posture as the unpolled case below: a tree we cannot attribute is
    // work we cannot rule out. The sibling gate in runtimeStore goes the OTHER way on purpose —
    // it must not credit this dirt as the agent's work — and conflating the two loses data here.
    expect(
      shouldPromptOnClose("build", "building_unsaved", { ...bs(0, true), worktreeOnBranch: false }),
    ).toBe(true);
    // Even with a clean-looking tree: false means "not this branch's tree", never "no work".
    expect(
      shouldPromptOnClose("build", "building_unsaved", { ...bs(0, false), worktreeOnBranch: false }),
    ).toBe(true);
    // On its own branch, a known-clean tree still closes silently — the gate must not over-prompt.
    expect(
      shouldPromptOnClose("build", "building_unsaved", { ...bs(0, false), worktreeOnBranch: true }),
    ).toBe(false);
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
  const before = [ag("b1", "build"), ag("b2", "build")];

  it("closing the OPEN build agent re-selects the first visible row", () => {
    const after = [ag("b2", "build")]; // b1 removed
    const d = selectionAfterClose("b1", "b1", before, after, "build", "manual", {});
    expect(d).toEqual({ reselect: true, next: "b2" });
  });

  it("closing the LAST build agent clears selection → blank first-load state", () => {
    const d = selectionAfterClose("b1", "b1", [ag("b1", "build")], [], "build", "manual", {});
    expect(d).toEqual({ reselect: true, next: null });
  });

  it("closing a NON-open row leaves selection put", () => {
    const after = [ag("b1", "build")]; // closed b2, but b1 is open
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
    const after = [ag("b2", "build")];
    const d = selectionAfterClose("b1", null, before, after, "build", "manual", {});
    expect(d).toEqual({ reselect: false, next: null });
  });
});

import { describe, it, expect } from "vitest";
import { shouldPromptOnClose } from "./closeAgent";
import type { BranchStatus } from "../services/branchStatus";

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

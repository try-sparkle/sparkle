import { describe, it, expect } from "vitest";
import { withUnmergedWork } from "./unmergedAttention";
import { hasUnmergedCommittedWork, type WorkflowStageId } from "./workflowStage";
import type { AgentTabStatus } from "../types";

// The "unmerged committed work" band: committed (building_saved) up to — but not including — merged
// with origin main. This is the signal that turns a FINISHED agent's dot red ("Needs merge").
describe("hasUnmergedCommittedWork", () => {
  it("is TRUE for the committed-but-not-on-origin-main band (saved → local main)", () => {
    const band: WorkflowStageId[] = ["building_saved", "pushed", "pull_request", "merged_local"];
    for (const s of band) expect(hasUnmergedCommittedWork(s)).toBe(true);
  });

  it("is FALSE below it (no commits yet) and at/above merged (landed / shipped)", () => {
    const notBand: WorkflowStageId[] = [
      "thought",
      "specd",
      "planned",
      "building_unsaved", // uncommitted — nothing committed to merge yet
      "merged", // on origin main — nothing left to merge
      "shipped", // in a release — done
    ];
    for (const s of notBand) expect(hasUnmergedCommittedWork(s)).toBe(false);
  });
});

// A tiny agent shape and a stage lookup the overlay reads.
const agents = (...ids: string[]) => ids.map((id) => ({ id }));
const stageMap =
  (m: Record<string, WorkflowStageId>) =>
  (id: string): WorkflowStageId | undefined =>
    m[id];

describe("withUnmergedWork", () => {
  it("escalates a FINISHED agent (idle/done/stopped) with un-landed work to red `unmerged`", () => {
    const status: Record<string, AgentTabStatus> = { i: "idle", d: "done", s: "stopped" };
    const out = withUnmergedWork(
      agents("i", "d", "s"),
      status,
      stageMap({ i: "pull_request", d: "building_saved", s: "merged_local" }),
    );
    expect(out).toEqual({ i: "unmerged", d: "unmerged", s: "unmerged" });
  });

  it("leaves a WORKING (green) agent alone even with un-landed work — it's still building", () => {
    const status: Record<string, AgentTabStatus> = { w: "working" };
    const out = withUnmergedWork(agents("w"), status, stageMap({ w: "building_saved" }));
    expect(out).toBe(status); // same reference — nothing changed
    expect(out.w).toBe("working");
  });

  it("leaves an already-red agent (waiting/approval/errored/blocked) untouched", () => {
    const status: Record<string, AgentTabStatus> = {
      wa: "waiting",
      ap: "approval",
      er: "errored",
      bl: "blocked",
    };
    const out = withUnmergedWork(
      agents("wa", "ap", "er", "bl"),
      status,
      stageMap({ wa: "pushed", ap: "pushed", er: "pushed", bl: "pushed" }),
    );
    expect(out).toBe(status);
  });

  it("does NOT escalate a finished agent whose work is already merged/shipped or not yet committed", () => {
    const status: Record<string, AgentTabStatus> = {
      merged: "done",
      shipped: "done",
      unsaved: "idle",
    };
    const out = withUnmergedWork(
      agents("merged", "shipped", "unsaved"),
      status,
      stageMap({ merged: "merged", shipped: "shipped", unsaved: "building_unsaved" }),
    );
    expect(out).toBe(status);
  });

  it("treats an agent missing from the status map as stopped, so a persisted unlanded tab lights up", () => {
    const status: Record<string, AgentTabStatus> = {};
    const out = withUnmergedWork(agents("ghost"), status, stageMap({ ghost: "pull_request" }));
    expect(out.ghost).toBe("unmerged");
  });

  it("returns the SAME reference and does not mutate when nothing is escalated", () => {
    const status: Record<string, AgentTabStatus> = { a: "working", b: "done" };
    const out = withUnmergedWork(
      agents("a", "b"),
      status,
      stageMap({ a: "building_saved", b: "merged" }),
    );
    expect(out).toBe(status);
    expect(status).toEqual({ a: "working", b: "done" });
  });

  it("skips agents with no known stage (branch/workflow not yet polled)", () => {
    const status: Record<string, AgentTabStatus> = { a: "done" };
    const out = withUnmergedWork(agents("a"), status, () => undefined);
    expect(out).toBe(status);
  });
});

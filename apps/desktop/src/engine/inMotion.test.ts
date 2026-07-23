// An agent whose turn has closed can still be MOVING — a worker it spawned is mid-build and will
// resume it. These tests pin the predicate that keeps the red overlays and the "Close Build Agent"
// CTA from asserting "over to you" over work that is actively in flight.
import { describe, expect, it } from "vitest";
import type { AgentTabStatus } from "../types";
import { isInMotion, type MotionAgent, type StatusMap } from "./inMotion";

function worker(id: string, parentId = "build1"): MotionAgent {
  return { id, kind: "worker", parentId };
}
const build: MotionAgent = { id: "build1", kind: "build", parentId: null };

describe("isInMotion", () => {
  it("is true when the agent is working itself", () => {
    expect(isInMotion("build1", [build], { build1: "working" })).toBe(true);
  });

  // The reported bug: Stop fired (idle) while a just-spawned worker was still building.
  it("is true when the turn is closed but a worker child is still working", () => {
    const agents = [build, worker("w1")];
    const status: StatusMap = { build1: "idle", w1: "working" };
    expect(isInMotion("build1", agents, status)).toBe(true);
  });

  it("is false when the agent is idle and every worker has settled", () => {
    const agents = [build, worker("w1"), worker("w2")];
    const status: StatusMap = { build1: "idle", w1: "idle", w2: "done" };
    expect(isInMotion("build1", agents, status)).toBe(false);
  });

  // The fleet settling is what RESTORES the ordinary red/CTA behavior — motion must not latch.
  it("stops being true once the last working worker settles", () => {
    const agents = [build, worker("w1")];
    expect(isInMotion("build1", agents, { build1: "idle", w1: "working" })).toBe(true);
    expect(isInMotion("build1", agents, { build1: "idle", w1: "idle" })).toBe(false);
  });

  it("does not count a RED worker as motion — a stuck worker is not progress", () => {
    const agents = [build, worker("w1")];
    for (const s of ["waiting", "approval", "errored", "blocked"] as AgentTabStatus[]) {
      expect(isInMotion("build1", agents, { build1: "idle", w1: s })).toBe(false);
    }
  });

  it("does not count a worker that never started (no status entry)", () => {
    expect(isInMotion("build1", [build, worker("w1")], { build1: "idle" })).toBe(false);
  });

  it("only counts THIS agent's workers, not another orchestrator's", () => {
    const agents = [build, worker("w1", "build2")];
    expect(isInMotion("build1", agents, { build1: "idle", w1: "working" })).toBe(false);
  });

  // A build agent nested under another (not a worker) is not this agent's motion to claim.
  it("only counts children of kind 'worker'", () => {
    const agents = [build, { id: "b2", kind: "build", parentId: "build1" }];
    expect(isInMotion("build1", agents, { build1: "idle", b2: "working" })).toBe(false);
  });

  it("is false for an unknown agent with no children", () => {
    expect(isInMotion("nobody", [build], { build1: "working" })).toBe(false);
  });
});

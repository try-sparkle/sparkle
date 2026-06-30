// The TopBar dot cluster must TRACK the sidebar rows, not the raw project.agents array:
// one full dot per top-level agent (in the sidebar's order), with each build agent's
// workers spliced in right after it as half-discs ("D" shapes). These tests pin that
// contract — previously the cluster mapped project.agents flatly, so worker dots floated
// out of order and the count never matched the visible rows.
import { describe, expect, it } from "vitest";
import { agentDots } from "./TopBar";
import { withUnstartedWorkerAttention } from "../engine/workerAttention";
import type { AgentTab, AgentTabStatus, Project } from "../types";

// Minimal agent factory — agentDots only reads id/kind/parentId/pinnedIndex.
function agent(over: Partial<AgentTab> & { id: string }): AgentTab {
  return {
    kind: "build",
    parentId: null,
    pinnedIndex: null,
    name: over.id,
    ...over,
  } as AgentTab;
}

function project(agents: AgentTab[]): Project {
  return { id: "p", name: "p", rootPath: "/p", createdAt: "2026-01-01T00:00:00Z", agents } as Project;
}

describe("agentDots", () => {
  it("emits one dot per top-level build agent, in insertion order when ordering is manual", () => {
    const p = project([agent({ id: "a" }), agent({ id: "b" }), agent({ id: "c" })]);
    const status: Record<string, AgentTabStatus> = { a: "waiting", b: "stopped", c: "working" };
    const dots = agentDots(p, status, "build", false);
    expect(dots).toEqual([
      { id: "a", status: "waiting", shape: "dot" },
      { id: "b", status: "stopped", shape: "dot" },
      { id: "c", status: "working", shape: "dot" },
    ]);
  });

  it("splices each build agent's workers in right after it, as half-discs", () => {
    const p = project([
      agent({ id: "build1" }),
      agent({ id: "w1", kind: "worker", parentId: "build1" }),
      agent({ id: "w2", kind: "worker", parentId: "build1" }),
      agent({ id: "build2" }),
    ]);
    const status: Record<string, AgentTabStatus> = {
      build1: "working",
      w1: "working",
      w2: "waiting",
      build2: "working",
    };
    const dots = agentDots(p, status, "build", false);
    expect(dots).toEqual([
      { id: "build1", status: "working", shape: "dot" },
      { id: "w1", status: "working", shape: "half" },
      { id: "w2", status: "waiting", shape: "half" },
      { id: "build2", status: "working", shape: "dot" },
    ]);
  });

  it("defaults a missing status to 'stopped'", () => {
    const p = project([agent({ id: "a" })]);
    expect(agentDots(p, {}, "build", false)).toEqual([{ id: "a", status: "stopped", shape: "dot" }]);
  });

  it("attention-ordering floats a red (waiting) top-level agent ahead of stopped ones", () => {
    // Insertion order is grey, grey, red; attention ordering must surface red first — matching
    // the sidebar — while keeping each agent's workers grouped under it.
    const p = project([
      agent({ id: "grey1" }),
      agent({ id: "grey2" }),
      agent({ id: "red", parentId: null }),
      agent({ id: "redWorker", kind: "worker", parentId: "red" }),
    ]);
    const status: Record<string, AgentTabStatus> = {
      grey1: "stopped",
      grey2: "stopped",
      red: "waiting",
      redWorker: "working",
    };
    const dots = agentDots(p, status, "build", true);
    expect(dots.map((d) => d.id)).toEqual(["red", "redWorker", "grey1", "grey2"]);
    expect(dots[1]).toEqual({ id: "redWorker", status: "working", shape: "half" });
  });

  it("a stranded (spawned-but-not-started) worker paints itself AND its orchestrator red", () => {
    // This is how TopBar feeds the cluster: overlay unstarted-worker attention, THEN build the dots.
    // The worker (materialized worktree, not open, no live status) and the orchestrator it blocks
    // must both read 'approval' (red) instead of the gray they'd otherwise default to.
    const p = project([
      agent({ id: "build1" }),
      agent({ id: "stranded", kind: "worker", parentId: "build1", worktreePath: "/wt/s" }),
    ]);
    // The orchestrator is live (open); its worker stranded out of the open set.
    const eff = withUnstartedWorkerAttention(p.agents, {}, new Set(["build1"]));
    const dots = agentDots(p, eff, "build", false);
    expect(dots).toEqual([
      { id: "build1", status: "approval", shape: "dot" },
      { id: "stranded", status: "approval", shape: "half" },
    ]);
  });

  it("only orphaned workers (no live parent) surface at top level; think agents are excluded in build mode", () => {
    const p = project([
      agent({ id: "build1" }),
      agent({ id: "orphan", kind: "worker", parentId: "gone" }), // parent build agent absent
      agent({ id: "think1", kind: "think" }),
    ]);
    const status: Record<string, AgentTabStatus> = {};
    const dots = agentDots(p, status, "build", false);
    // build1 + orphan surface (orphan as a full dot — it has no parent row to nest under);
    // the think agent is filtered out in build mode.
    expect(dots.map((d) => d.id)).toEqual(["build1", "orphan"]);
    expect(dots.find((d) => d.id === "orphan")?.shape).toBe("dot");
  });

  it("think mode shows only think agents", () => {
    const p = project([agent({ id: "build1" }), agent({ id: "think1", kind: "think" })]);
    const dots = agentDots(p, {}, "think", false);
    expect(dots.map((d) => d.id)).toEqual(["think1"]);
  });

  it("plan mode falls back to the Build set (sidebar shows no rows, header stays glanceable)", () => {
    // The sidebar renders nothing in Plan, but the header keeps showing the build agents +
    // their workers so its status stays glanceable. This pins that intentional divergence so a
    // future refactor to `[]` for plan can't silently blank the header dots.
    const p = project([
      agent({ id: "build1" }),
      agent({ id: "w1", kind: "worker", parentId: "build1" }),
      agent({ id: "think1", kind: "think" }),
    ]);
    const dots = agentDots(p, {}, "plan", false);
    expect(dots).toEqual([
      { id: "build1", status: "stopped", shape: "dot" },
      { id: "w1", status: "stopped", shape: "half" },
    ]);
  });
});

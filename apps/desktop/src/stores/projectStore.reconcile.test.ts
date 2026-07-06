// sparkle-3tqv — the rehydration MERGE must NEVER drop a worker whose worktree is live on disk.
// A cross-window rehydrate replaces in-memory `projects` with the persisted snapshot; if that
// snapshot predates a just-spawned worker (another window persisted last), the default whole-array
// replace would EVICT the live worker. mergePreservingLiveWorkers re-attaches it. These tests drive
// the pure merge directly (the same fn wired as zustand persist's `merge`).
import { describe, it, expect } from "vitest";
import { mergePreservingLiveWorkers } from "./projectStore";
import type { AgentTab, Project } from "../types";

function agent(over: Partial<AgentTab> & { id: string; kind: AgentTab["kind"] }): AgentTab {
  return {
    name: over.id,
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    pinnedIndex: null,
    ...over,
  } as AgentTab;
}

function project(id: string, agents: AgentTab[]): Project {
  return {
    id,
    name: id,
    rootPath: `/repo/${id}`,
    defaultBranch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    agents,
    selectedAgentId: agents[0]?.id ?? null,
  };
}

// A minimal current state — only `projects` matters for the merge; a stub action proves functions
// survive the merge (the persisted JSON never carries them).
function currentState(projects: Project[]): any {
  return { projects, selectedProjectId: projects[0]?.id ?? null, addProject: () => "x" };
}

describe("mergePreservingLiveWorkers (sparkle-3tqv)", () => {
  it("re-attaches a live worker that the persisted snapshot dropped", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const worker = agent({
      id: "w1",
      kind: "worker",
      parentId: "b1",
      worktreePath: "/wt/w1",
      branch: "sparkle/agent-w1",
    });
    const current = currentState([project("p1", [build, worker])]);
    // Persisted snapshot from another window that never saw w1 (last-writer-wins eviction).
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current);
    const ids = merged.projects[0]!.agents.map((a) => a.id).sort();
    expect(ids).toEqual(["b1", "w1"]);
    // The action function survives the merge.
    expect(typeof (merged as any).addProject).toBe("function");
  });

  it("does NOT resurrect a worker whose parent build agent is gone from the snapshot", () => {
    const worker = agent({
      id: "w1",
      kind: "worker",
      parentId: "b1",
      worktreePath: "/wt/w1",
    });
    // In memory the worker exists but its build agent b1 does not (orchestrator closed).
    const current = currentState([project("p1", [worker])]);
    const persisted = { projects: [project("p1", [])], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.agents).toHaveLength(0);
  });

  it("does NOT preserve a worker that has no cut worktree yet (not materialized)", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const worker = agent({ id: "w1", kind: "worker", parentId: "b1", worktreePath: null });
    const current = currentState([project("p1", [build, worker])]);
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["b1"]);
  });

  it("never duplicates a worker already present in the snapshot", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const worker = agent({ id: "w1", kind: "worker", parentId: "b1", worktreePath: "/wt/w1" });
    const current = currentState([project("p1", [build, worker])]);
    const persisted = { projects: [project("p1", [build, worker])], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["b1", "w1"]);
  });

  it("takes the persisted value for everything else (initial hydration, empty current)", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const current = currentState([]); // fresh store, nothing in memory
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects).toHaveLength(1);
    expect(merged.selectedProjectId).toBe("p1");
  });
});

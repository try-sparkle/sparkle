import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore, mergePreservingLiveWorkers, type ProjectState } from "./projectStore";
import type { AgentTab, Project } from "../types";

// Store-level lifecycle of Project.freshBuildAgentId — the "just-opened build agent floats to the
// top of the non-alerting rows" slot (ordering itself is covered in engine/agentOrdering.test.ts).

function mkAgent(over: Partial<AgentTab> & { id: string }): AgentTab {
  return {
    name: over.id.toUpperCase(), kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
    ...over,
  };
}

function mkProject(over: Partial<Project> & { id: string }): Project {
  return {
    name: "P", rootPath: "/tmp/p", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    freshBuildAgentId: null, agents: [], ...over,
  };
}

function seed() {
  useProjectStore.setState({ projects: [mkProject({ id: "p1" })] } as never);
}

const proj = () => useProjectStore.getState().projects[0]!;

describe("projectStore — freshBuildAgentId lifecycle", () => {
  beforeEach(seed);

  it("opening a BUILD agent claims the fresh slot", () => {
    const id = useProjectStore.getState().addAgent("p1", { kind: "build" });
    expect(proj().freshBuildAgentId).toBe(id);
  });

  it("is single-occupancy — a newer build agent takes the slot from the older one", () => {
    const first = useProjectStore.getState().addAgent("p1", { kind: "build" });
    const second = useProjectStore.getState().addAgent("p1", { kind: "build" });
    expect(first).not.toBe(second);
    expect(proj().freshBuildAgentId).toBe(second);
  });

  it("opening a THINK agent does NOT steal the build slot", () => {
    const build = useProjectStore.getState().addAgent("p1", { kind: "build" });
    useProjectStore.getState().addAgent("p1", { kind: "think" });
    expect(proj().freshBuildAgentId).toBe(build);
  });

  it("opening a WORKER does NOT steal the build slot", () => {
    const build = useProjectStore.getState().addAgent("p1", { kind: "build" });
    useProjectStore.getState().addAgent("p1", { kind: "worker", parentId: build });
    expect(proj().freshBuildAgentId).toBe(build);
  });

  it("closing the fresh agent clears the slot", () => {
    const build = useProjectStore.getState().addAgent("p1", { kind: "build" });
    useProjectStore.getState().removeAgent("p1", build);
    expect(proj().freshBuildAgentId).toBeNull();
  });

  it("closing a fresh build agent (and its workers) clears the slot", () => {
    const build = useProjectStore.getState().addAgent("p1", { kind: "build" });
    useProjectStore.getState().addAgent("p1", { kind: "worker", parentId: build });
    // build is still fresh (worker didn't steal it); closing it removes build + its worker.
    useProjectStore.getState().removeAgent("p1", build);
    expect(proj().freshBuildAgentId).toBeNull();
  });

  it("closing a DIFFERENT agent leaves the fresh slot intact", () => {
    const older = useProjectStore.getState().addAgent("p1", { kind: "build" });
    const fresh = useProjectStore.getState().addAgent("p1", { kind: "build" });
    useProjectStore.getState().removeAgent("p1", older);
    expect(proj().freshBuildAgentId).toBe(fresh);
  });
});

describe("mergePreservingLiveWorkers — freshBuildAgentId across rehydrate", () => {
  const state = (project: Project): ProjectState =>
    ({ projects: [project] }) as unknown as ProjectState;

  it("keeps the LIVE fresh id when it still resolves (a stale snapshot can't revert it)", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })], freshBuildAgentId: "a1" }));
    // Stale snapshot predates the just-opened agent and still points at an old fresh id.
    const persisted = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })], freshBuildAgentId: "old" }));
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.freshBuildAgentId).toBe("a1");
  });

  it("falls back to the snapshot's fresh id when the live one is dangling", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })], freshBuildAgentId: "ghost" }));
    const persisted = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })], freshBuildAgentId: "a1" }));
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.freshBuildAgentId).toBe("a1");
  });

  it("a live null (intentional 'no fresh agent') is authoritative over a snapshot's value", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })], freshBuildAgentId: null }));
    const persisted = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })], freshBuildAgentId: "a1" }));
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.freshBuildAgentId).toBeNull();
  });
});

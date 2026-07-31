import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore, mergePreservingLiveWorkers, type ProjectState } from "./projectStore";
import type { AgentTab, Project } from "../types";

// Store-level lifecycle of Project.freshBuildAgentId, plus the thing that actually decides where a
// just-opened agent lands.
//
// THOSE ARE NO LONGER THE SAME MECHANISM. `freshBuildAgentId` used to name the row `FRESH_BUILD_RANK`
// floated to the top of the attention sort; that sort was deleted on 2026-07-26, so the field is
// still written and reconciled across windows but nothing reads it to place a row. "Newest at the
// top" is a property of the ARRAY now — `addAgent` prepends, and `engine/buildSections` buckets in
// input order — which is why the ordering assertion below lives here beside the field it replaced
// rather than in engine/agentOrdering.test.ts, where this note used to send readers.

function mkAgent(over: Partial<AgentTab> & { id: string }): AgentTab {
  return {
    name: over.id.toUpperCase(), kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,    ...over,
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
    const id = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    expect(proj().freshBuildAgentId).toBe(id);
  });

  it("is single-occupancy — a newer build agent takes the slot from the older one", () => {
    const first = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    const second = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    expect(first).not.toBe(second);
    expect(proj().freshBuildAgentId).toBe(second);
  });

  it("opening a SHELL agent does NOT steal the build slot", () => {
    const build = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    useProjectStore.getState().addAgent("p1", { kind: "shell" });
    expect(proj().freshBuildAgentId).toBe(build);
  });

  it("opening a WORKER does NOT steal the build slot", () => {
    const build = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    useProjectStore.getState().addAgent("p1", { kind: "worker", parentId: build });
    expect(proj().freshBuildAgentId).toBe(build);
  });

  it("closing the fresh agent clears the slot", () => {
    const build = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    useProjectStore.getState().removeAgent("p1", build);
    expect(proj().freshBuildAgentId).toBeNull();
  });

  it("closing a fresh build agent (and its workers) clears the slot", () => {
    const build = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    useProjectStore.getState().addAgent("p1", { kind: "worker", parentId: build });
    // build is still fresh (worker didn't steal it); closing it removes build + its worker.
    useProjectStore.getState().removeAgent("p1", build);
    expect(proj().freshBuildAgentId).toBeNull();
  });

  it("closing a DIFFERENT agent leaves the fresh slot intact", () => {
    const older = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    const fresh = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    useProjectStore.getState().removeAgent("p1", older);
    expect(proj().freshBuildAgentId).toBe(fresh);
  });
});

describe("projectStore — a new agent lands at the TOP of the list", () => {
  beforeEach(seed);

  it("prepends, so the newest agent is not buried under every older one", () => {
    // The ladder reads top→bottom as least-done→most-done, and the sections already say that
    // (uncommitted → committed → PR → merged → shipped). This is the same rule one level down,
    // WITHIN a section: a brand-new agent is the least-done thing there is. Appending put it at the
    // bottom of "Local: Uncommitted", underneath every older agent sharing that rung.
    const older = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    const newer = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    expect(proj().agents.map((a) => a.id)).toEqual([newer, older]);
  });

  it("does it by INSERTING, so a human's drag arrangement is still the last word", () => {
    // Position-as-state, not a comparator. `project.agents` order IS the rendered order, so
    // `reorderAgent` rewrites this array and nothing re-sorts it afterwards to undo the drag — a
    // comparator would have needed a per-row "has been manually moved" flag to avoid fighting it.
    const older = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    const newer = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    useProjectStore.getState().reorderAgent("p1", newer, null);
    expect(proj().agents.map((a) => a.id)).toEqual([older, newer]);
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

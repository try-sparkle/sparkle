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

  it("does it by INSERTING, so a human's drag arrangement survives the NEXT agent", () => {
    // Position-as-state, not a comparator. `project.agents` order IS the rendered order, so
    // `reorderAgent` rewrites this array and nothing re-sorts it afterwards to undo the drag — a
    // comparator would have needed a per-row "has been manually moved" flag to avoid fighting it.
    //
    // THE ASSERTION HAS TO OUTLIVE A SUBSEQUENT `addAgent`, and the first draft of it did not: it
    // dragged the newer row to the end and expected `[older, newer]`, which is what APPENDING
    // produced without any drag at all — green against the code this change replaced, proving
    // nothing (roborev 56125). Adding a third agent after the drag is what makes the two orders
    // differ: append gives `[a, b, c]` here, insert gives `[c, a, b]`.
    const a = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    const b = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    // The human drags `b` — which opened on top — down below `a`.
    useProjectStore.getState().reorderAgent("p1", b, null);
    expect(proj().agents.map((x) => x.id)).toEqual([a, b]);

    const c = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    expect(proj().agents.map((x) => x.id)).toEqual([c, a, b]);
  });

  it("re-adopts a worker onto the SAME side, so the self-heal doesn't sink it", () => {
    // `adoptWorker` is the second row-creation path — the disk-manifest self-heal after a restart.
    // While it appended, "newest first" was true of spawned rows and false of re-adopted ones: a
    // self-healed worker sat below every sibling spawned since, an order that is neither
    // newest-first nor seed order (roborev 56125). "Invisible to the user" is a promise about
    // `selectedAgentId`, which is untouched either way — asserted here so the two can't be conflated.
    const parent = useProjectStore.getState().addAgent("p1", { kind: "build" })!;
    useProjectStore.getState().selectAgent("p1", parent);
    useProjectStore.getState().adoptWorker("p1", {
      id: "w-readopted",
      parentId: parent,
      branch: "sparkle/w",
      worktreePath: "/tmp/wt",
    });

    expect(proj().agents.map((a) => a.id)).toEqual(["w-readopted", parent]);
    expect(proj().selectedAgentId).toBe(parent);
  });

  it("keeps a just-created agent on top when a stale snapshot from another window merges in", () => {
    // The union in `mergeProject` decides where a LIVE-ONLY row lands, and a just-created agent is
    // exactly that: the projects blob is written on a trailing debounce, so every other window's
    // snapshot predates it, and `crossWindowSync` rehydrates on each event they emit. With the union
    // appending, the new row appeared at the top of its rung and dropped to the bottom moments later
    // (roborev 56125) — a symptom that could not exist while `addAgent` appended too.
    const fresh = mkAgent({ id: "fresh" });
    const known = mkAgent({ id: "known" });
    const current = {
      projects: [mkProject({ id: "p1", agents: [fresh, known] })],
    } as unknown as ProjectState;
    // The snapshot predates `fresh` entirely — it carries only the older row.
    const persisted = {
      projects: [mkProject({ id: "p1", agents: [known] })],
    } as unknown as ProjectState;

    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["fresh", "known"]);
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

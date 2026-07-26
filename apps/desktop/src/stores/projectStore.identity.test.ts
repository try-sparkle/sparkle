import { describe, expect, it } from "vitest";
import { mergePreservingLiveWorkers, sameValue, type ProjectState } from "./projectStore";
import { arePanePropsEqual } from "../components/AgentPane";
import type { AgentTab, Project } from "../types";

// Agent object-identity preservation across the persist rehydrate (supersedes stale #473).
//
// Every rehydrate — startup and, far more often, cross-window sync — replaces every agent object
// with a freshly JSON.parse'd one. AgentPane's memo comparator requires `a.agent === b.agent`, so
// mass identity churn re-renders every open pane (hidden ones included) on any rehydrate. The merge
// now canonicalizes its OUTPUT toward the LIVE objects, gated on deep VALUE equality, so a rehydrate
// that carries no real change is a true no-op for `useProjectStore(s => s.projects)`.
//
// The canonicalization must NEVER win over a real change (stale render) and must compose with the
// tombstone union that suppresses closed agents — the two highest-risk failure directions.

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

const state = (project: Project): ProjectState =>
  ({ projects: [project], selectedProjectId: project.id }) as unknown as ProjectState;

/** Simulate what a rehydrate actually hands the merge: a structurally-identical snapshot whose every
 *  object is a FRESH reference (JSON.parse mints new objects; own keys holding `undefined` and any
 *  functions are dropped, exactly as the persisted blob would be). */
const rehydrated = (s: ProjectState): ProjectState =>
  JSON.parse(JSON.stringify({ projects: s.projects, removedIds: s.removedIds }));

describe("mergePreservingLiveWorkers — identity preservation on a no-op rehydrate", () => {
  it("returns the SAME projects array reference when nothing changed", () => {
    const cur = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" }), mkAgent({ id: "a2" })] }));
    const merged = mergePreservingLiveWorkers(rehydrated(cur), cur);
    expect(merged.projects).toBe(cur.projects);
  });

  it("returns the SAME project object reference when nothing changed", () => {
    const cur = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }));
    const merged = mergePreservingLiveWorkers(rehydrated(cur), cur);
    expect(merged.projects[0]).toBe(cur.projects[0]);
  });

  it("returns the SAME agent object references when nothing changed", () => {
    const a1 = mkAgent({ id: "a1" });
    const a2 = mkAgent({ id: "a2" });
    const cur = state(mkProject({ id: "p1", agents: [a1, a2] }));
    const merged = mergePreservingLiveWorkers(rehydrated(cur), cur);
    expect(merged.projects[0]!.agents[0]).toBe(a1);
    expect(merged.projects[0]!.agents[1]).toBe(a2);
  });

  it("recognizes an agent unchanged even when its nested arrays are fresh references (deep, not shallow)", () => {
    // promptHistory survives JSON as a brand-new array every rehydrate, so a shallow compare would
    // never reuse the live agent. The deep value compare is load-bearing.
    const a1 = mkAgent({
      id: "a1",
      lastPrompt: "hello",
      promptHistory: [{ text: "hello", at: 1, source: "composer" } as never],
    });
    const cur = state(mkProject({ id: "p1", agents: [a1] }));
    const merged = mergePreservingLiveWorkers(rehydrated(cur), cur);
    expect(merged.projects[0]!.agents[0]).toBe(a1);
  });

  it("reuses the live agent when it carries an own key holding `undefined` the blob drops", () => {
    // addAgent/setAgentModel store `model: undefined` for the default model; JSON.stringify drops the
    // key entirely. An absent key must compare EQUAL to an explicit-undefined one, or the most
    // ordinary agent there is would read as 'changed' forever and defeat the whole optimization.
    const a1 = mkAgent({ id: "a1", model: undefined });
    expect(Object.prototype.hasOwnProperty.call(a1, "model")).toBe(true);
    const cur = state(mkProject({ id: "p1", agents: [a1] }));
    const merged = mergePreservingLiveWorkers(rehydrated(cur), cur);
    expect(merged.projects[0]!.agents[0]).toBe(a1);
  });
});

describe("mergePreservingLiveWorkers — a real change still wins (never a stale canonicalization)", () => {
  it("takes the incoming agent value when a field genuinely changed", () => {
    const a1 = mkAgent({ id: "a1", lastPrompt: "old" });
    const cur = state(mkProject({ id: "p1", agents: [a1] }));
    const snap = rehydrated(cur);
    snap.projects[0]!.agents[0]!.lastPrompt = "new";
    const merged = mergePreservingLiveWorkers(snap, cur);
    expect(merged.projects[0]!.agents[0]!.lastPrompt).toBe("new");
    expect(merged.projects[0]!.agents[0]).not.toBe(a1);
  });

  it("does not reuse the live projects array when any project changed", () => {
    const cur = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1", lastPrompt: "old" })] }));
    const snap = rehydrated(cur);
    snap.projects[0]!.agents[0]!.lastPrompt = "new";
    const merged = mergePreservingLiveWorkers(snap, cur);
    expect(merged.projects).not.toBe(cur.projects);
  });
});

describe("mergePreservingLiveWorkers — multi-project and metadata-only changes (regression guards)", () => {
  const multi = (...projects: Project[]): ProjectState =>
    ({ projects, selectedProjectId: projects[0]?.id ?? null }) as unknown as ProjectState;

  it("keeps an unchanged sibling's identity while refreshing only the changed project", () => {
    const p1 = mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }); // stays byte-identical
    const p2 = mkProject({ id: "p2", agents: [mkAgent({ id: "a2", lastPrompt: "old" })] }); // changes
    const cur = multi(p1, p2);
    const snap = rehydrated(cur);
    snap.projects[1]!.agents[0]!.lastPrompt = "new";
    const merged = mergePreservingLiveWorkers(snap, cur);
    expect(merged.projects[0]).toBe(p1); // unchanged sibling keeps its live reference
    expect(merged.projects[1]).not.toBe(p2); // the changed one is fresh
    expect(merged.projects[1]!.agents[0]!.lastPrompt).toBe("new");
    expect(merged.projects).not.toBe(cur.projects); // and the array is NOT reused
  });

  it("on a metadata-only change returns a fresh project but keeps each agent's live identity", () => {
    const a1 = mkAgent({ id: "a1" });
    const cur = state(mkProject({ id: "p1", name: "Old", agents: [a1] }));
    const snap = rehydrated(cur);
    snap.projects[0]!.name = "New";
    const merged = mergePreservingLiveWorkers(snap, cur);
    expect(merged.projects[0]).not.toBe(cur.projects[0]); // project object changed (name)
    expect(merged.projects[0]!.name).toBe("New");
    expect(merged.projects[0]!.agents[0]).toBe(a1); // …but the agent identity is preserved
  });

  it("treats freshBuildAgentId null-vs-absent as no change (the normalization sameProjectMeta excludes)", () => {
    const a1 = mkAgent({ id: "a1" });
    const liveP = mkProject({ id: "p1", agents: [a1] });
    delete (liveP as Partial<Project>).freshBuildAgentId; // live omits the key entirely
    const cur = state(liveP);
    const snap = {
      projects: [{ ...JSON.parse(JSON.stringify(liveP)), freshBuildAgentId: null }],
    } as unknown as ProjectState;
    const merged = mergePreservingLiveWorkers(snap, cur);
    expect(merged.projects[0]).toBe(liveP); // null vs absent is not a real change
  });
});

describe("mergePreservingLiveWorkers — canonicalization composes with the tombstone union", () => {
  it("still removes an otherwise-canonicalizable agent that has been tombstoned", () => {
    // a1 is byte-identical across live and snapshot (so it WOULD canonicalize), but it has been
    // closed. Tombstone suppression must run regardless of identity reuse.
    const cur = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" }), mkAgent({ id: "a2" })] }));
    const merged = mergePreservingLiveWorkers(rehydrated(cur), cur, new Set(["a1"]));
    const ids = merged.projects[0]!.agents.map((a) => a.id);
    expect(ids).not.toContain("a1");
    expect(ids).toContain("a2");
  });
});

describe("arePanePropsEqual after a no-op rehydrate (the render-thrash this fixes)", () => {
  it("lets both hidden and visible panes skip re-render", () => {
    const a1 = mkAgent({ id: "a1" });
    const cur = state(mkProject({ id: "p1", agents: [a1] }));
    const merged = mergePreservingLiveWorkers(rehydrated(cur), cur);
    const liveP = cur.projects[0]!;
    const mergedP = merged.projects[0]!;
    const before = (visible: boolean) => ({ project: liveP, agent: a1, visible });
    const after = (visible: boolean) => ({ project: mergedP, agent: mergedP.agents[0]!, visible });
    expect(arePanePropsEqual(before(false), after(false))).toBe(true);
    expect(arePanePropsEqual(before(true), after(true))).toBe(true);
  });

  it("still re-renders when the agent genuinely changed (inverse guard — not vacuous)", () => {
    const a1 = mkAgent({ id: "a1", lastPrompt: "old" });
    const cur = state(mkProject({ id: "p1", agents: [a1] }));
    const snap = rehydrated(cur);
    snap.projects[0]!.agents[0]!.lastPrompt = "new";
    const merged = mergePreservingLiveWorkers(snap, cur);
    const mergedP = merged.projects[0]!;
    expect(
      arePanePropsEqual(
        { project: cur.projects[0]!, agent: a1, visible: true },
        { project: mergedP, agent: mergedP.agents[0]!, visible: true },
      ),
    ).toBe(false);
  });
});

describe("sameValue — deep value equality with the blob's quirks", () => {
  it("treats an absent key and an explicit-undefined key as the same value", () => {
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it("compares nested arrays and records by value, not reference", () => {
    expect(sameValue({ xs: [1, { y: 2 }] }, { xs: [1, { y: 2 }] })).toBe(true);
    expect(sameValue({ xs: [1, { y: 2 }] }, { xs: [1, { y: 3 }] })).toBe(false);
  });

  it("fails CLOSED on non-plain objects — two Dates never compare equal", () => {
    // An own-key walk sees Date as key-less and would call them equal, which would canonicalize
    // across a real change and render stale. Erring toward 'no reuse' is the safe direction.
    expect(sameValue(new Date(1), new Date(1))).toBe(false);
    expect(sameValue({ d: new Date(1) }, { d: new Date(1) })).toBe(false);
  });
});

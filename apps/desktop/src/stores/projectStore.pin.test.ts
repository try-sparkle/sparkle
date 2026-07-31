import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "./projectStore";
import { useUiStore } from "./uiStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id = "a1", name = "A1"): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

function seed(agents: AgentTab[] = [mkAgent()]) {
  const project: Project = {
    id: "p1", name: "P", rootPath: "/tmp/p", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
}

const order = () => useProjectStore.getState().projects[0]!.agents.map((a) => a.id);

const agent = () => useProjectStore.getState().projects[0]!.agents[0]!;

// Row ORDER is now `project.agents` order (the ladder groups by stage, then renders in array
// order), so the drag handler reorders the array itself. `pinnedIndex` and pinAgentAt are gone —
// there is no attention sort left to anchor a row against.
describe("projectStore reorderAgent", () => {
  beforeEach(() => seed([mkAgent("a"), mkAgent("b"), mkAgent("c")]));

  it("moves a row UP, landing it immediately before the target", () => {
    useProjectStore.getState().reorderAgent("p1", "c", "a");
    expect(order()).toEqual(["c", "a", "b"]);
  });

  it("moves a row DOWN, landing it AT the target's slot", () => {
    // Dropping onto a row means "take that row's slot". Inserting before the target unconditionally
    // is what made a downward drag land one slot short (roborev 53371).
    useProjectStore.getState().reorderAgent("p1", "a", "c");
    expect(order()).toEqual(["b", "c", "a"]);
  });

  it("a downward drag onto the ADJACENT row actually moves it", () => {
    // The regression that shipped: [a, b] + drag a onto b removed `a` and re-inserted it at index 0
    // — exactly where it started. The user drags, nothing moves, the control reads as broken. The
    // old test asserted the buggy order and so could never catch this.
    seed([mkAgent("a"), mkAgent("b")]);
    useProjectStore.getState().reorderAgent("p1", "a", "b");
    expect(order()).toEqual(["b", "a"]);
  });

  it("an upward drag onto the adjacent row moves it too (the mirror case)", () => {
    seed([mkAgent("a"), mkAgent("b")]);
    useProjectStore.getState().reorderAgent("p1", "b", "a");
    expect(order()).toEqual(["b", "a"]);
  });

  it("every single-step drag in a 3-row section changes the order", () => {
    // Exhaustive over adjacent pairs in both directions — the shape of bug that hides in exactly
    // one direction is the one a hand-picked example misses.
    for (const [drag, target, want] of [
      ["a", "b", ["b", "a", "c"]],
      ["b", "c", ["a", "c", "b"]],
      ["b", "a", ["b", "a", "c"]],
      ["c", "b", ["a", "c", "b"]],
    ] as const) {
      seed([mkAgent("a"), mkAgent("b"), mkAgent("c")]);
      useProjectStore.getState().reorderAgent("p1", drag, target);
      expect(order(), `drag ${drag} onto ${target}`).toEqual([...want]);
    }
  });

  it("appends when the target is null", () => {
    useProjectStore.getState().reorderAgent("p1", "a", null);
    expect(order()).toEqual(["b", "c", "a"]);
  });

  it("appends rather than dropping the move when the target vanished mid-drag", () => {
    useProjectStore.getState().reorderAgent("p1", "a", "ghost");
    expect(order()).toEqual(["b", "c", "a"]);
  });

  it("is a no-op for a self-drop, and does NOT hand out a new project reference", () => {
    const before = useProjectStore.getState().projects[0]!;
    useProjectStore.getState().reorderAgent("p1", "b", "b");
    // Identity, not just equality: a fresh object would re-render every projects consumer for a
    // drag that visually did nothing.
    expect(useProjectStore.getState().projects[0]!).toBe(before);
  });

  it("is a no-op for an unknown agent", () => {
    const before = useProjectStore.getState().projects[0]!;
    useProjectStore.getState().reorderAgent("p1", "nope", "a");
    expect(useProjectStore.getState().projects[0]!).toBe(before);
  });

  it("does NOT freeze the name — a pure reorder must leave auto-naming alone", () => {
    // The old drag-pin set namePinned as a side effect, silently disabling auto-naming for any row
    // the user ever dragged.
    useProjectStore.getState().reorderAgent("p1", "a", "c");
    const moved = useProjectStore.getState().projects[0]!.agents.find((x) => x.id === "a")!;
    expect(moved.namePinned).toBe(false);
  });

  it("preserves autoNameVariants (a drag must not change the visible label)", () => {
    const variants = { title: "Long Name", description: "does a thing" };
    seed([{ ...mkAgent("a"), autoNameVariants: variants }, mkAgent("b")]);
    useProjectStore.getState().reorderAgent("p1", "a", null);
    const moved = useProjectStore.getState().projects[0]!.agents.find((x) => x.id === "a")!;
    expect(moved.autoNameVariants).toEqual(variants);
  });

  it("keeps every agent — a reorder is a permutation, never a drop", () => {
    useProjectStore.getState().reorderAgent("p1", "b", "a");
    expect([...order()].sort()).toEqual(["a", "b", "c"]);
  });
});

// AGENT PINNING IS REMOVED. `unpinAgent` was the last surviving piece of it — by the end it only
// released the name freeze, which is the undo for the pin chip that no longer renders.
//
// Asserted as an ABSENCE from the store's public surface, not merely "we deleted some code": the
// store is one object, so a re-added action shows up here immediately. Project-tab pinning
// (components/ProjectTabs) is a separate, live feature and is deliberately not in scope.
describe("projectStore — agent pinning is gone", () => {
  beforeEach(() => seed());

  it("exposes no unpinAgent action", () => {
    expect(useProjectStore.getState()).not.toHaveProperty("unpinAgent");
  });

  it("still freezes a human rename — the flag outlived the affordance", () => {
    useProjectStore.getState().renameAgent("p1", "a1", "Human Choice");
    expect(agent().namePinned).toBe(true);
  });
});

describe("projectStore renameAgent", () => {
  beforeEach(() => seed());

  it("freezes the name against the auto-namer", () => {
    useProjectStore.getState().renameAgent("p1", "a1", "New");
    expect(agent().name).toBe("New");
    expect(agent().namePinned).toBe(true);
  });
});

// selfNameAgent — the sparkle-control rename_agent path. It makes the name authoritative WITHOUT
// pinning the row (regression sparkle-pel7: agents self-naming looked pinned and couldn't be unpinned).
describe("projectStore selfNameAgent", () => {
  beforeEach(() => seed());

  it("sets the name + selfNamed but NEVER namePinned", () => {
    useProjectStore.getState().selfNameAgent("p1", "a1", "Parser Builder");
    expect(agent().name).toBe("Parser Builder");
    expect(agent().selfNamed).toBe(true);
    expect(agent().namePinned).toBe(false); // no name-freeze chip
  });

  it("clears autoNameVariants so the chosen label shows verbatim", () => {
    useProjectStore.setState({
      projects: [
        {
          ...useProjectStore.getState().projects[0]!,
          agents: [{ ...mkAgent(), autoNameVariants: { title: "Stale Auto Name", description: "stale" } }],
        },
      ],
    } as never);
    useProjectStore.getState().selfNameAgent("p1", "a1", "Chosen Name");
    expect(agent().autoNameVariants).toBeNull();
  });

  it("freezes the name against the background auto-namer", () => {
    useProjectStore.getState().selfNameAgent("p1", "a1", "Chosen Name");
    useProjectStore.getState().autoRenameAgent("p1", "a1", "Auto Guess", "some prompt");
    expect(agent().name).toBe("Chosen Name"); // auto-namer must not clobber a self-name
  });

  it("is a no-op over a human pin (namePinned wins)", () => {
    useProjectStore.getState().renameAgent("p1", "a1", "Human Choice");
    useProjectStore.getState().selfNameAgent("p1", "a1", "Agent Choice");
    expect(agent().name).toBe("Human Choice");
    expect(agent().namePinned).toBe(true);
  });

  it("ignores a blank name", () => {
    useProjectStore.getState().selfNameAgent("p1", "a1", "   ");
    expect(agent().name).toBe("A1");
    expect(agent().selfNamed).toBeFalsy();
  });
});

// The CONCIERGE pin (uiStore.pinnedProjectId) is a different pin from the agent ones above, but it
// is projectStore.removeProject that has to keep it honest: the pin scopes the concierge's vitals,
// and no tab renders for a project that's gone (roborev 46248-M4 / 46291-L).
describe("removeProject and the concierge project pin", () => {
  beforeEach(() => {
    seed();
    useUiStore.getState().setPinnedProject(null);
  });

  it("clears a pin naming the removed project", () => {
    useUiStore.getState().setPinnedProject("p1");
    useProjectStore.getState().removeProject("p1");
    expect(useUiStore.getState().pinnedProjectId).toBeNull();
  });

  it("leaves an unrelated pin alone", () => {
    useUiStore.getState().setPinnedProject("p2");
    useProjectStore.getState().removeProject("p1");
    expect(useUiStore.getState().pinnedProjectId).toBe("p2");
  });
});

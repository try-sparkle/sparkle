// @vitest-environment jsdom
//
// CurrentProjectProvider's `?agent=` deep-link mount effect: a window opened by a history-search
// "jump to agent" into a fresh window must land directly on that agent (open + select), and must
// silently ignore a closed/unknown agent id (the search row reports "closed" instead). We assert
// on the resulting store state rather than spying, so the test pins behavior, not call shape.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CurrentProjectProvider, useCurrentProjectId } from "./windowContext";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import type { AgentTab, Project } from "./types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
  };
}
function seedProject(agents: AgentTab[]): void {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
  useProjectStore.setState({ projects: [project], selectedProjectId: "p1" } as never);
}

/** Point this "window" at a project + (optional) deep-link agent before mounting the provider. */
function setSearch(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
}

const selectedAgentId = () =>
  useProjectStore.getState().projects.find((p) => p.id === "p1")?.selectedAgentId ?? null;

/** Renders the window's current project id so tests can assert what the window actually shows. */
function ProjectIdProbe() {
  const id = useCurrentProjectId();
  return <span data-testid="pid">{id ?? "none"}</span>;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({ openAgentIds: [] } as never);
});
afterEach(() => {
  cleanup();
  setSearch("");
});

describe("CurrentProjectProvider — ?agent= deep-link", () => {
  it("selects + opens an existing agent named by ?agent= on mount", () => {
    seedProject([mkAgent("a1"), mkAgent("a2")]);
    setSearch("?project=p1&label=win-1&agent=a2");
    render(<CurrentProjectProvider>ok</CurrentProjectProvider>);
    expect(selectedAgentId()).toBe("a2");
    expect(useRuntimeStore.getState().isOpen("a2")).toBe(true);
  });

  it("silently ignores a closed/unknown agent id (no select, no open)", () => {
    seedProject([mkAgent("a1")]);
    setSearch("?project=p1&label=win-1&agent=gone");
    render(<CurrentProjectProvider>ok</CurrentProjectProvider>);
    expect(selectedAgentId()).toBeNull();
    expect(useRuntimeStore.getState().isOpen("gone")).toBe(false);
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
  });

  it("does nothing when no ?agent= param is present", () => {
    seedProject([mkAgent("a1")]);
    setSearch("?project=p1&label=win-1");
    render(<CurrentProjectProvider>ok</CurrentProjectProvider>);
    expect(selectedAgentId()).toBeNull();
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
  });
});

// Regression: a brand-new secondary window is created with `?project=<id>` and its OS title is
// stamped from the OPENER's store, but zustand's persist applies the hydrated localStorage snapshot
// in a microtask — so the window can run the one-shot `initial` memo BEFORE its own store hydrates,
// find the id absent, and strand at null forever ("amforge" title + "No project open"). The window
// must adopt its deep-linked project the moment it actually appears, while still ignoring an id that
// is genuinely gone.
describe("CurrentProjectProvider — late-hydration project recovery", () => {
  it("adopts its ?project= id once the store hydrates it after mount", () => {
    // Store is empty at mount (persist snapshot not applied yet); p1 arrives afterward.
    setSearch("?project=p1&label=win-1");
    const { getByTestId } = render(
      <CurrentProjectProvider>
        <ProjectIdProbe />
      </CurrentProjectProvider>,
    );
    // One-shot `initial` resolves to null because p1 isn't in the unhydrated store.
    expect(getByTestId("pid").textContent).toBe("none");
    // Hydration lands (or cross-window sync delivers the just-created project).
    act(() => {
      seedProject([]);
    });
    expect(getByTestId("pid").textContent).toBe("p1");
  });

  it("stays projectless when its ?project= id never appears (stale/deleted)", () => {
    setSearch("?project=ghost&label=win-1");
    const { getByTestId } = render(
      <CurrentProjectProvider>
        <ProjectIdProbe />
      </CurrentProjectProvider>,
    );
    expect(getByTestId("pid").textContent).toBe("none");
    // A DIFFERENT project (p1) hydrates — the phantom `ghost` id must not resolve to it.
    act(() => {
      seedProject([]);
    });
    expect(getByTestId("pid").textContent).toBe("none");
  });

  it("still lands the ?agent= deep-link after the project hydrates late", () => {
    // A "jump to agent" opened into a fresh window carries ?project=+?agent=; both must survive a
    // late store hydration — the recovery path adopts the project AND lands the agent, not just one.
    setSearch("?project=p1&label=win-1&agent=a2");
    const { getByTestId } = render(
      <CurrentProjectProvider>
        <ProjectIdProbe />
      </CurrentProjectProvider>,
    );
    expect(getByTestId("pid").textContent).toBe("none");
    expect(useRuntimeStore.getState().isOpen("a2")).toBe(false);
    act(() => {
      seedProject([mkAgent("a1"), mkAgent("a2")]);
    });
    expect(getByTestId("pid").textContent).toBe("p1");
    expect(selectedAgentId()).toBe("a2");
    expect(useRuntimeStore.getState().isOpen("a2")).toBe(true);
  });
});

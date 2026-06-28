// @vitest-environment jsdom
//
// CurrentProjectProvider's `?agent=` deep-link mount effect: a window opened by a history-search
// "jump to agent" into a fresh window must land directly on that agent (open + select), and must
// silently ignore a closed/unknown agent id (the search row reports "closed" instead). We assert
// on the resulting store state rather than spying, so the test pins behavior, not call shape.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CurrentProjectProvider } from "./windowContext";
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

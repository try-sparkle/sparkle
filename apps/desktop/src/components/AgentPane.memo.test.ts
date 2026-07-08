// The live pane is memoized so N open panes don't all re-render on every SIBLING-agent store write
// (the render-thrash source when many agents are open). arePanePropsEqual is React.memo's comparator:
// it must return true (skip render) exactly when this pane's output can't have changed. These tests
// pin that contract at the value level, without React/Tauri machinery.
import { describe, it, expect } from "vitest";
import { arePanePropsEqual } from "./AgentPane";
import type { AgentTab, Project } from "../types";

function agent(over: Partial<AgentTab> & { id: string }): AgentTab {
  return {
    name: over.id,
    kind: "build",
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

function project(agents: AgentTab[], over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Repo",
    rootPath: "/repo",
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    agents,
    selectedAgentId: agents[0]?.id ?? null,
    ...over,
  };
}

describe("arePanePropsEqual (AgentPane memo)", () => {
  const me = agent({ id: "a1" });
  const sibling = agent({ id: "a2" });

  it("skips the re-render a sibling's store write would otherwise force", () => {
    // A sibling update mints a NEW project object + agents array (mapProject/mapAgent) but preserves
    // THIS pane's agent object and the project scalars — the exact case that must NOT re-render.
    const before = { project: project([me, sibling]), agent: me, visible: true };
    const after = {
      project: project([me, agent({ id: "a2", activity: "working…" })]), // sibling changed → new project ref
      agent: me, // preserved by mapAgent
      visible: true,
    };
    expect(before.project).not.toBe(after.project); // new project reference…
    expect(arePanePropsEqual(before, after)).toBe(true); // …but this pane can safely skip
  });

  it("re-renders when THIS pane's own agent object changes", () => {
    const before = { project: project([me]), agent: me, visible: true };
    const after = { project: project([me]), agent: agent({ id: "a1", lastPrompt: "hi" }), visible: true };
    expect(arePanePropsEqual(before, after)).toBe(false);
  });

  it("re-renders when visibility flips (switching agents)", () => {
    const before = { project: project([me]), agent: me, visible: false };
    const after = { project: project([me]), agent: me, visible: true };
    expect(arePanePropsEqual(before, after)).toBe(false);
  });

  it("re-renders when a project scalar the render reads changes", () => {
    const before = { project: project([me]), agent: me, visible: true };
    for (const changed of [
      project([me], { name: "Renamed" }),
      project([me], { rootPath: "/other" }),
      project([me], { defaultBranch: "develop" }),
      project([me], { id: "p2" }),
    ]) {
      expect(arePanePropsEqual(before, { project: changed, agent: me, visible: true })).toBe(false);
    }
  });
});

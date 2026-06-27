// @vitest-environment jsdom
//
// Sidebar ordering + unpin: a pinned (anchored) agent holds its row via orderAgents, and the
// pin icon clears both the name-freeze and the row anchor. Heavy leaf components + the Tauri
// opener are mocked so the sidebar renders.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null, ...over,
  };
}

function seed(agents: AgentTab[]): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
  return project;
}

// Reset the shared runtime store between tests so a per-test `status` map (used to force an
// attention-sort order) can't leak into the next test and make the suite order-dependent.
beforeEach(() => useRuntimeStore.setState({ status: {} }));
afterEach(() => cleanup());

describe("AgentSidebar — manual pin ordering", () => {
  it("an anchored agent holds its row (orderAgents), ahead of an unpinned one", () => {
    // Alpha is first by insertion; Beta is anchored to row 0 → Beta must render before Alpha.
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta", { namePinned: true, pinnedIndex: 0 })]);
    render(<AgentSidebar project={project} />);
    const beta = screen.getByText("Beta");
    const alpha = screen.getByText("Alpha");
    // DOCUMENT_POSITION_FOLLOWING (4) set ⇒ alpha comes after beta in the DOM.
    expect(beta.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renaming a top-level agent anchors it at its DISPLAYED row, not its insertion index", () => {
    // Insertion order is [Alpha, Beta]. Attention sort floats Beta (waiting) above Alpha
    // (working), so Alpha is DISPLAYED at row 1 even though it's array index 0.
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    useRuntimeStore.setState({ status: { a1: "working", a2: "waiting" } });
    render(<AgentSidebar project={project} />);
    // Enter rename on Alpha (double-click the name), change it, blur to commit.
    fireEvent.doubleClick(screen.getByText("Alpha"));
    const input = screen.getByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "Alpha2" } });
    fireEvent.blur(input);
    const a1 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(a1.name).toBe("Alpha2");
    expect(a1.namePinned).toBe(true);
    expect(a1.pinnedIndex).toBe(1); // displayed row, NOT the insertion index 0
  });

  it("clicking the pin icon unpins (clears namePinned + pinnedIndex)", () => {
    const project = seed([mkAgent("a1", "Alpha", { namePinned: true, pinnedIndex: 0 })]);
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByTitle(/^Pinned/));
    const a1 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(a1.namePinned).toBe(false);
    expect(a1.pinnedIndex).toBeNull();
  });
});

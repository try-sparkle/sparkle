// @vitest-environment jsdom
//
// The NAME-freeze chip. `namePinned` used to mean two things — "don't auto-rename" AND "hold this
// row's position". Row anchoring is gone (rows group by workflow stage; order within a stage is the
// human's drag arrangement), so the flag now means exactly one thing and the chip says so. The
// ordering assertions that used to live here are gone with pinnedIndex; the property that replaced
// them — that status never moves a row — is asserted in engine/buildSections.test.ts.
// Heavy leaf components + the Tauri opener are mocked so the sidebar renders.
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
    autoNameVariants: null, shellCommand: null, ...over,
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

beforeEach(() => useRuntimeStore.setState({ status: {} }));
afterEach(() => cleanup());

describe("AgentSidebar — the name-freeze chip", () => {
  it("renaming a top-level agent freezes its name but does NOT anchor its row", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    render(<AgentSidebar project={project} />);
    fireEvent.doubleClick(screen.getByText("Alpha"));
    const input = screen.getByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "Alpha2" } });
    fireEvent.blur(input);
    const a1 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(a1.name).toBe("Alpha2");
    expect(a1.namePinned).toBe(true);
    // The row did not move: array order is untouched by a rename.
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("clicking the chip releases the name freeze so the agent auto-names again", () => {
    const project = seed([mkAgent("a1", "Alpha", { namePinned: true })]);
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByTitle(/^Renamed by you/));
    const a1 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(a1.namePinned).toBe(false);
  });

  it("the chip's tooltip no longer claims to control ordering", () => {
    const project = seed([mkAgent("a1", "Alpha", { namePinned: true })]);
    render(<AgentSidebar project={project} />);
    const chip = screen.getByTitle(/^Renamed by you/);
    expect(chip.getAttribute("title")).not.toMatch(/reorder/i);
  });
});

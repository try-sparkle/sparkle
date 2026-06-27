// @vitest-environment jsdom
//
// Drag-to-pin: dragging a top-level agent CARD (the whole row is the drag handle) and dropping it
// onto a row pins it at that row's index. Heavy leaf components + the Tauri opener are mocked so
// the sidebar renders.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The whole card is the drag handle now (no separate grip element) — reorderable top-level rows
// carry draggable=true; workers do not. Selecting by the attribute keeps the test honest about
// which rows a user can actually grab. NOTE: dragProps is spread onto BOTH the in-flow row and the
// hover overlay, so a hovered row exposes TWO draggable elements; these counts assume the at-rest
// state (no row hovered), which holds for every test here.
const draggableCards = () => Array.from(document.querySelectorAll<HTMLElement>('[draggable="true"]'));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
  };
}

function seed(agents?: AgentTab[]): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: agents ?? [mkAgent("a1", "Alpha"), mkAgent("a2", "Beta"), mkAgent("a3", "Gamma")],
  };
  useProjectStore.setState({ projects: [project] } as never);
  return project;
}

// Reset shared UI state so one test's orchestrator-expand can't leak into the next.
beforeEach(() => useUiStore.setState({ collapsedOrchestrators: {} }));
afterEach(() => cleanup());

describe("AgentSidebar — drag to pin", () => {
  it("dropping an agent onto a row pins it at that index", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const cards = draggableCards();
    expect(cards).toHaveLength(3);
    // Drag Gamma (a3, last) onto the first row (index 0).
    fireEvent.dragStart(cards[2]!);
    const targets = screen.getAllByTestId("agent-drop-target");
    fireEvent.dragOver(targets[0]!);
    fireEvent.drop(targets[0]!);
    const a3 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a3")!;
    expect(a3.namePinned).toBe(true);
    expect(a3.pinnedIndex).toBe(0);
  });

  it("dropping an agent on its OWN row is a no-op (does not pin/freeze the name)", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const cards = draggableCards();
    fireEvent.dragStart(cards[2]!); // Gamma (a3) at row 2
    const targets = screen.getAllByTestId("agent-drop-target");
    fireEvent.drop(targets[2]!); // released on its own row
    const a3 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a3")!;
    expect(a3.namePinned).toBe(false);
    expect(a3.pinnedIndex).toBeNull();
  });

  it("drag-end without a drop clears the drag state (no lingering drop targets)", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const cards = draggableCards();
    fireEvent.dragStart(cards[0]!);
    expect(screen.getAllByTestId("agent-drop-target")).toHaveLength(3);
    fireEvent.dragEnd(cards[0]!);
    expect(screen.queryAllByTestId("agent-drop-target")).toHaveLength(0);
  });

  it("a rendered nested worker is not draggable (top-level only)", () => {
    const worker = { ...mkAgent("w1", "Worker"), kind: "worker" as const, parentId: "a1" };
    seed([mkAgent("a1", "Alpha"), worker]);
    // Expand the orchestrator so the worker row actually renders — otherwise "not draggable" would
    // pass vacuously because a collapsed worker isn't in the DOM at all (roborev 13178).
    useUiStore.setState({ collapsedOrchestrators: { a1: false } });
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
    expect(screen.getByText("Worker")).toBeTruthy(); // the worker row IS rendered…
    expect(draggableCards()).toHaveLength(1); // …yet only the top-level agent's card is draggable
  });
});

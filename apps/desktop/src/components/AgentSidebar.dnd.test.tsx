// @vitest-environment jsdom
//
// Drag-to-reorder: dragging a top-level agent CARD (the whole row is the drag handle) and dropping
// it onto another row moves it to that row's slot in project.agents — which IS the order rows render
// in within a stage section. Every agent here has no branch status, so they all resolve to the same
// "Local: Uncommitted" section and are therefore all valid drop targets for each other.
// Heavy leaf components + the Tauri opener are mocked so the sidebar renders.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The whole card is the drag handle now (no separate grip element) — reorderable top-level rows
// carry draggable=true; workers do not. Selecting by the attribute keeps the test honest about
// which rows a user can actually grab. NOTE: dragProps is spread onto the in-flow row AND both
// halves of the unified hover card (strip + detail), so a hovered row exposes MULTIPLE draggable
// elements; these counts assume the at-rest state (no row hovered), which holds for every test here.
const draggableCards = () => Array.from(document.querySelectorAll<HTMLElement>('[draggable="true"]'));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
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
    autoNameVariants: null, shellCommand: null,  };
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

const agentOrder = () => useProjectStore.getState().projects[0]!.agents.map((a) => a.id);

describe("AgentSidebar — drag to reorder", () => {
  it("dropping an agent onto a row moves it to that row's slot", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const cards = draggableCards();
    expect(cards).toHaveLength(3);
    // Drag Gamma (a3, last) onto the first row.
    fireEvent.dragStart(cards[2]!);
    const targets = screen.getAllByTestId("agent-drop-target");
    fireEvent.dragOver(targets[0]!);
    fireEvent.drop(targets[0]!);
    expect(agentOrder()).toEqual(["a3", "a1", "a2"]);
  });

  it("a reorder does NOT freeze the name — that side effect of the old drag-pin is gone", () => {
    // The old pinAgentAt set namePinned on every drag, silently disabling auto-naming for any row
    // the user had ever dragged.
    const project = seed();
    render(<AgentSidebar project={project} />);
    const cards = draggableCards();
    fireEvent.dragStart(cards[2]!);
    fireEvent.drop(screen.getAllByTestId("agent-drop-target")[0]!);
    const a3 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a3")!;
    expect(a3.namePinned).toBe(false);
  });

  it("dropping an agent on its OWN row is a no-op", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const cards = draggableCards();
    fireEvent.dragStart(cards[2]!); // Gamma (a3) at row 2
    const targets = screen.getAllByTestId("agent-drop-target");
    fireEvent.drop(targets[2]!); // released on its own row
    expect(agentOrder()).toEqual(["a1", "a2", "a3"]);
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

  it("keeps a grabbable drag handle when the card is open — the card's strip carries dragProps", () => {
    // Regression guard: the in-flow row goes visibility:hidden when its card opens (the L-card stands
    // in over it). If only the row were draggable, an open card — a state you might start a drag from —
    // would leave nothing grabbable and silently kill drag-to-reorder. So dragProps is on the card
    // strip too. Here: open a row's card, then start a drag from the NEW draggable (the portal strip)
    // and confirm it initiates a reorder (drop targets appear).
    const project = seed();
    render(<AgentSidebar project={project} />);
    const before = draggableCards();
    expect(before).toHaveLength(3);

    fireEvent.contextMenu(before[0]!); // open the unified card over the first row
    const after = draggableCards();
    expect(after.length).toBeGreaterThan(before.length); // the card strip adds a grab when open
    const strip = after.find((el) => !before.includes(el))!;
    expect(strip).toBeTruthy();

    fireEvent.dragStart(strip); // grab the card on hover → must start a reorder
    expect(screen.getAllByTestId("agent-drop-target")).toHaveLength(3);
  });

  it("anchors the hover card upward for a bottom-of-viewport row (stays on-screen, stays grabbable)", () => {
    // A row sitting low in a short viewport must not let the non-shrinking strip overflow the card's
    // maxH cap and collapse the detail. The card shifts UP so ≥ MIN_CARD_H (180px) of room remains.
    // And because that shift can move the strip off the row, the WHOLE card is draggable — so a drag
    // can still start from where the cursor actually is (over the detail).
    const project = seed();
    const origH = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 400, configurable: true });
    // Every element reports a low position: row top 380 in a 400px viewport.
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 10, top: 380, width: 200, height: 40, right: 210, bottom: 420, x: 10, y: 380, toJSON: () => ({}),
    } as DOMRect);
    try {
      render(<AgentSidebar project={project} />);
      const row = draggableCards()[0]!;
      fireEvent.contextMenu(row);
      const card = document.querySelector<HTMLElement>('[data-testid="agent-hover-card"]')!;
      expect(card).toBeTruthy();
      // Shifted up: top ≤ innerHeight - 16 - MIN_CARD_H = 400 - 16 - 180 = 204 (well above the row's 380).
      expect(parseFloat(card.style.top)).toBeLessThanOrEqual(204);
      // And ≥ MIN_CARD_H of vertical room is reserved.
      expect(parseFloat(card.style.maxHeight)).toBeGreaterThanOrEqual(180);
      // The detail half is draggable too, so the whole card is a grab handle even when shifted.
      const drags = draggableCards();
      expect(drags.length).toBeGreaterThanOrEqual(3); // in-flow row + strip + detail
      fireEvent.dragStart(drags[drags.length - 1]!);
      expect(screen.getAllByTestId("agent-drop-target")).toHaveLength(3);
    } finally {
      spy.mockRestore();
      Object.defineProperty(window, "innerHeight", { value: origH, configurable: true });
    }
  });

  it("a worker is not its own draggable card (it renders inline on the orchestrator)", () => {
    const worker = { ...mkAgent("w1", "Worker"), kind: "worker" as const, parentId: "a1" };
    seed([mkAgent("a1", "Alpha"), worker]);
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
    // Workers are not standalone rows: each renders as a named inline line under its orchestrator,
    // so the worker's name IS in the collapsed DOM…
    expect(screen.getByText("Worker")).toBeTruthy();
    expect(draggableCards()).toHaveLength(1); // …but only the orchestrator's card is draggable
  });
});

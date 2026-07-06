// @vitest-environment jsdom
//
// Sub-agent surfacing: a worker surfaces as its own indented SubAgentRow when it needs attention
// (auto) OR when the human pins it from the orchestrator's hover card (manual, with a ✕). Plus the
// hover-card reachability wiring: the card's own scroll doesn't dismiss it, and hovering a surfaced
// sub-row opens the orchestrator's card (no flicker).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, AgentTabStatus, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
    ...over,
  };
}

// Orchestrator a1 + one worker w1 in a given status, with an optional pin.
function seed(opts: { workerStatus: AgentTabStatus; pinned?: boolean }): {
  project: Project;
  open: ReturnType<typeof vi.fn>;
} {
  const orchestrator = mkAgent("a1", "Alpha");
  const worker = mkAgent("w1", "Fix The Parser", {
    kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w1",
  });
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [orchestrator, worker],
  };
  useProjectStore.setState({ projects: [project] } as never);
  const open = vi.fn();
  // Real pinWorker/unpinWorker (state merges), overridden `open` so we can assert selection.
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {},
    status: { w1: opts.workerStatus } as Record<string, AgentTabStatus>,
    openAgentIds: ["a1", "w1"],
    pinnedWorkerIds: opts.pinned ? ["w1"] : [],
    open,
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return { project, open };
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
  useRuntimeStore.setState({ pinnedWorkerIds: [] } as never);
});
afterEach(cleanup);

describe("AgentSidebar — sub-agent surfacing (pin + attention)", () => {
  it("surfaces a PINNED (non-red) worker as a row WITH a ✕, and unpinning removes it", () => {
    const { project } = seed({ workerStatus: "working", pinned: true });
    render(<AgentSidebar project={project} />);
    // Pinned → its name is a row even though it's healthy (would otherwise be a hover-only bar).
    expect(screen.getByRole("button", { name: /Fix The Parser — /i })).toBeTruthy();
    const x = screen.getByRole("button", { name: /Unpin Fix The Parser/i });
    fireEvent.click(x);
    // ✕ un-pins → store drops it → row (and ✕) disappear.
    expect(useRuntimeStore.getState().pinnedWorkerIds).toEqual([]);
    expect(screen.queryByRole("button", { name: /Unpin Fix The Parser/i })).toBeNull();
  });

  it("a PINNED + RED worker renders once and still shows its ✕", () => {
    const { project } = seed({ workerStatus: "errored", pinned: true });
    render(<AgentSidebar project={project} />);
    // Exactly one row for the worker (not one for attention + one for pin).
    expect(screen.getAllByRole("button", { name: /Fix The Parser — Errored/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Unpin Fix The Parser/i })).toBeTruthy();
  });

  it("clicking a worker's name in the hover card PINS + opens it", () => {
    const { project, open } = seed({ workerStatus: "working", pinned: false });
    render(<AgentSidebar project={project} />);
    // Not surfaced yet (healthy, unpinned) — no standalone row.
    expect(screen.queryByRole("button", { name: /Unpin Fix The Parser/i })).toBeNull();
    // Hover the orchestrator to reveal its card, which lists the worker name as a clickable control.
    const headRow = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
    fireEvent.mouseEnter(headRow);
    const card = screen.getByTestId("agent-hover-card");
    fireEvent.click(within(card).getByRole("button", { name: /Open and pin Fix The Parser/i }));
    // Pin recorded + worker opened/selected.
    expect(useRuntimeStore.getState().pinnedWorkerIds).toContain("w1");
    expect(open).toHaveBeenCalledWith("w1");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("w1");
  });
});

describe("AgentSidebar — hover-card reachability", () => {
  it("scrolling INSIDE the card does not dismiss it; a window scroll does", () => {
    const { project } = seed({ workerStatus: "working", pinned: false });
    render(<AgentSidebar project={project} />);
    const headRow = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
    fireEvent.mouseEnter(headRow);
    const detail = document.querySelector("[data-hovercard-detail]") as HTMLElement;
    expect(detail).toBeTruthy();
    // A scroll originating inside the card's detail = reading the list, not scrolling it away.
    fireEvent.scroll(detail);
    expect(screen.queryByTestId("agent-hover-card")).toBeTruthy();
    // A genuine window/list scroll still closes it.
    fireEvent.scroll(window);
    expect(screen.queryByTestId("agent-hover-card")).toBeNull();
  });

  it("wheel over a SCROLLABLE card detail is kept by the card (2b); a short one forwards to the list", () => {
    const { project } = seed({ workerStatus: "working", pinned: false });
    render(<AgentSidebar project={project} />);
    const headRow = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
    fireEvent.mouseEnter(headRow);
    const detail = document.querySelector("[data-hovercard-detail]") as HTMLElement;
    expect(detail).toBeTruthy();
    const list = screen.getByTestId("agent-list-scroll") as HTMLElement;
    // jsdom has no layout: give the list a box that contains the wheel point, and a 0 baseline.
    list.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} }) as DOMRect;
    list.scrollTop = 0;
    const setDetailBox = (scrollHeight: number, clientHeight: number) => {
      Object.defineProperty(detail, "scrollHeight", { configurable: true, value: scrollHeight });
      Object.defineProperty(detail, "clientHeight", { configurable: true, value: clientHeight });
    };
    const wheelOverDetail = () =>
      detail.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 40, deltaMode: 0, clientX: 100, clientY: 100, bubbles: true, cancelable: true }),
      );

    // TALL detail (scrollHeight > clientHeight) → the card scrolls its own content; the list stays put.
    setDetailBox(1000, 100);
    wheelOverDetail();
    expect(list.scrollTop).toBe(0);

    // SHORT detail (not scrollable) → forward the delta so the list stays reachable under the card.
    setDetailBox(100, 100);
    wheelOverDetail();
    expect(list.scrollTop).toBe(40);
  });

  it("hovering a surfaced sub-agent row opens the orchestrator's hover card", () => {
    const { project } = seed({ workerStatus: "errored", pinned: false });
    render(<AgentSidebar project={project} />);
    // No card yet.
    expect(screen.queryByTestId("agent-hover-card")).toBeNull();
    // The red worker is surfaced as its own row; hovering it must open the parent's card.
    const subRow = screen
      .getByRole("button", { name: /Fix The Parser — Errored/i })
      .closest("div")!.parentElement as HTMLElement;
    fireEvent.mouseEnter(subRow);
    expect(screen.getByTestId("agent-hover-card")).toBeTruthy();
  });
});

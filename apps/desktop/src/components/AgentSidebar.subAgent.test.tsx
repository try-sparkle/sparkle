// @vitest-environment jsdom
//
// The collapsed sidebar row shows ONLY the orchestrator's head: its title (auto-promoted from its
// representative worker when it has no work-derived title of its own) and its single rollup progress
// bar. Its workers are revealed by CLICKING the row, which opens the detail card; each worker there is
// a clickable line that opens that worker. Hovering a row just activates its terminal — it does NOT
// open the card. These tests pin that contract, plus the card's scroll/wheel reachability wiring.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

// Orchestrator a1 + one worker w1 in a given status. The orchestrator's name is PINNED so it keeps
// its own label ("Alpha") — otherwise the head auto-promotes its representative worker's title and
// there'd be no "Alpha" to target. (Auto-promotion itself is covered by its own test below.)
function seed(opts: { workerStatus: AgentTabStatus }): {
  project: Project;
  open: ReturnType<typeof vi.fn>;
} {
  const orchestrator = mkAgent("a1", "Alpha", { namePinned: true });
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
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {},
    status: { w1: opts.workerStatus } as Record<string, AgentTabStatus>,
    openAgentIds: ["a1", "w1"],
    open,
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return { project, open };
}

// Click the orchestrator's head row to open its detail card (the "modal").
function openHeadCard() {
  const head = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
  fireEvent.click(head);
  return head;
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("AgentSidebar — workers live in the click-opened detail card", () => {
  it("does NOT render workers in the collapsed row — only after the row is clicked", () => {
    const { project } = seed({ workerStatus: "working" });
    render(<AgentSidebar project={project} />);
    // Collapsed: the head shows, but the worker's name/button is not in the column.
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open Fix The Parser/i })).toBeNull();
    // Click the head → the card mounts and the worker appears as a clickable line.
    openHeadCard();
    expect(screen.getByTestId("agent-hover-card")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open Fix The Parser/i })).toBeTruthy();
    // No pin/unpin affordance on the worker line.
    expect(screen.queryByRole("button", { name: /Unpin/i })).toBeNull();
  });

  it("clicking a worker line in the card selects + opens THAT worker", () => {
    const { project, open } = seed({ workerStatus: "working" });
    render(<AgentSidebar project={project} />);
    openHeadCard();
    fireEvent.click(screen.getByRole("button", { name: /Open Fix The Parser/i }));
    expect(open).toHaveBeenCalledWith("w1");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("w1");
  });

  it("a worker that needs attention is still reachable in the card and stays clickable", () => {
    const { project, open } = seed({ workerStatus: "errored" });
    render(<AgentSidebar project={project} />);
    openHeadCard();
    const line = screen.getByRole("button", { name: /Open Fix The Parser/i });
    expect(line).toBeTruthy();
    fireEvent.click(line);
    expect(open).toHaveBeenCalledWith("w1");
  });

  it("auto-promotes a generic-named orchestrator's title to its representative worker's title", () => {
    // Unpinned orchestrator still on its "Build 7" default → the collapsed head borrows the worker's
    // title, so the ONE row describes the real work rather than a slot number.
    const orchestrator = mkAgent("a1", "Build 7");
    const worker = mkAgent("w1", "Fix The Parser", {
      kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w1",
    });
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [orchestrator, worker],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {},
      status: { w1: "working" }, openAgentIds: ["a1", "w1"],
      open: vi.fn(), pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    render(<AgentSidebar project={project} />);
    // The generic name is gone from the head; the worker's title stands in.
    expect(screen.getByText("Fix The Parser")).toBeTruthy();
    expect(screen.queryByText("Build 7")).toBeNull();
  });

  // Build a generic-named orchestrator with two workers at the given stages. `stage*` are
  // WorkflowStageId overrides (≥ building_unsaved, the undefined-branch floor, so they're honored).
  function seedTwoWorkers(stage1: string, stage2: string): Project {
    const orchestrator = mkAgent("a1", "Build 7"); // generic, unpinned → eligible for promotion
    const w1 = mkAgent("w1", "First worker", {
      kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w1",
    });
    const w2 = mkAgent("w2", "Second worker", {
      kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w2",
    });
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [orchestrator, w1, w2],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {},
      workflowStage: { w1: stage1, w2: stage2 },
      status: { w1: "working", w2: "working" }, openAgentIds: ["a1", "w1", "w2"],
      open: vi.fn(), pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    return project;
  }

  it("promotes the LEAST-ADVANCED worker's title when several workers differ", () => {
    // w2 (building_saved) trails w1 (pushed) → the head borrows w2, matching the rollup bar's stage.
    const project = seedTwoWorkers("pushed", "building_saved");
    render(<AgentSidebar project={project} />);
    expect(screen.getByText("Second worker")).toBeTruthy();
    expect(screen.queryByText("First worker")).toBeNull(); // the further-along worker isn't promoted
    expect(screen.queryByText("Build 7")).toBeNull();
  });

  it("breaks a stage tie by insertion order (first worker wins)", () => {
    const project = seedTwoWorkers("pushed", "pushed"); // equal stages → first in insertion order
    render(<AgentSidebar project={project} />);
    expect(screen.getByText("First worker")).toBeTruthy();
    expect(screen.queryByText("Second worker")).toBeNull();
  });
});

describe("AgentSidebar — hover vs. click", () => {
  // The hover-intent gate defers activation behind a short dwell so a cursor transiting the column
  // doesn't activate every row it crosses. These tests drive that timer with fake timers.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hovering a row activates its terminal only AFTER the dwell, and never opens the card", () => {
    const { project, open } = seed({ workerStatus: "working" });
    render(<AgentSidebar project={project} />);
    const head = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
    fireEvent.mouseEnter(head);
    // Immediately on enter the dwell gate is armed but hasn't fired — nothing selected yet.
    expect(open).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBeNull();
    // After the dwell elapses it commits: selects + opens the terminal…
    act(() => vi.advanceTimersByTime(100));
    expect(open).toHaveBeenCalledWith("a1");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("a1");
    // …but STILL does NOT pop the detail card (only a click does).
    expect(screen.queryByTestId("agent-hover-card")).toBeNull();
  });

  it("a cursor that leaves before the dwell (a transit) never activates the row", () => {
    const { project, open } = seed({ workerStatus: "working" });
    render(<AgentSidebar project={project} />);
    const head = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
    fireEvent.mouseEnter(head);
    act(() => vi.advanceTimersByTime(40)); // still mid-dwell…
    fireEvent.mouseLeave(head); // …cursor moves on before committing
    act(() => vi.advanceTimersByTime(200)); // let any stale timer fire
    expect(open).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBeNull();
  });

  it("clicking a row opens the detail card immediately, bypassing the dwell", () => {
    const { project, open } = seed({ workerStatus: "working" });
    render(<AgentSidebar project={project} />);
    expect(screen.queryByTestId("agent-hover-card")).toBeNull();
    openHeadCard();
    // Click selects NOW (no dwell wait) and opens the card.
    expect(open).toHaveBeenCalledWith("a1");
    expect(screen.getByTestId("agent-hover-card")).toBeTruthy();
  });
});

describe("AgentSidebar — detail-card reachability", () => {
  it("scrolling INSIDE the card does not dismiss it; a window scroll does", () => {
    const { project } = seed({ workerStatus: "working" });
    render(<AgentSidebar project={project} />);
    openHeadCard();
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
    const { project } = seed({ workerStatus: "working" });
    render(<AgentSidebar project={project} />);
    openHeadCard();
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
});

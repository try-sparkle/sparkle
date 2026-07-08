// @vitest-environment jsdom
//
// Inline sub-agent lines: EVERY worker renders as a named, clickable line under its orchestrator
// (no pop-out row, no pinning) — its name shows collapsed (no hover needed) and clicking it opens
// that worker. Plus the hover-card reachability wiring: the card's own scroll doesn't dismiss it,
// and hovering an inline worker line keeps the orchestrator's card open (no flicker).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

// Orchestrator a1 + one worker w1 in a given status.
function seed(opts: { workerStatus: AgentTabStatus }): {
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
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {},
    status: { w1: opts.workerStatus } as Record<string, AgentTabStatus>,
    openAgentIds: ["a1", "w1"],
    open,
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return { project, open };
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("AgentSidebar — inline sub-agent lines", () => {
  it("shows EVERY worker's name inline (no hover), even a healthy one, and never a pop-out ✕", () => {
    const { project } = seed({ workerStatus: "working" });
    render(<AgentSidebar project={project} />);
    // A healthy worker's name is visible collapsed — the whole point (was hover-only before).
    expect(screen.getByRole("button", { name: /Fix The Parser — /i })).toBeTruthy();
    expect(screen.getByText("Fix The Parser")).toBeTruthy();
    // No pin/unpin affordance survives.
    expect(screen.queryByRole("button", { name: /Unpin/i })).toBeNull();
  });

  it("clicking an inline worker line selects + opens THAT worker", () => {
    const { project, open } = seed({ workerStatus: "working" });
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByRole("button", { name: /Fix The Parser — /i }));
    expect(open).toHaveBeenCalledWith("w1");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("w1");
  });

  it("a worker that needs attention keeps its inline line (status in the label), still no pop-out", () => {
    const { project } = seed({ workerStatus: "errored" });
    render(<AgentSidebar project={project} />);
    // One inline line for the worker, carrying its status (the name also inks red via statusInk).
    expect(screen.getAllByRole("button", { name: /Fix The Parser — Errored/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Unpin/i })).toBeNull();
  });
});

describe("AgentSidebar — hover-card reachability", () => {
  it("scrolling INSIDE the card does not dismiss it; a window scroll does", () => {
    const { project } = seed({ workerStatus: "working" });
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
    const { project } = seed({ workerStatus: "working" });
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

  it("keeps the collapsed sub-agent lines visible while the head's card is open (no flicker)", () => {
    const { project } = seed({ workerStatus: "working" });
    // A worker with a stage renders a named collapsed line under the head. This is the line the user
    // hovers; hovering it must NOT flicker the card.
    useRuntimeStore.setState({ workflowStage: { w1: "building_saved" } } as never);
    render(<AgentSidebar project={project} />);

    // The collapsed sub-agent line exists before any hover.
    expect(screen.getByTestId("collapsed-worker-lines")).toBeTruthy();

    // Open the orchestrator's hover card.
    const headRow = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
    fireEvent.mouseEnter(headRow);
    expect(screen.getByTestId("agent-hover-card")).toBeTruthy();

    // The fix: the sub-agent lines stay rendered AND are not inside a visibility:hidden subtree, so
    // the cursor never loses its hover target. (Pre-fix they lived inside the row that goes
    // visibility:hidden, so this ancestor walk would find a hidden ancestor and the card flickered.)
    const lines = screen.getByTestId("collapsed-worker-lines");
    for (let el: HTMLElement | null = lines; el; el = el.parentElement) {
      expect(el.style.visibility).not.toBe("hidden");
    }

    // Hovering the sub-agent lines keeps the head's card open rather than dismissing it.
    fireEvent.mouseEnter(lines);
    expect(screen.getByTestId("agent-hover-card")).toBeTruthy();
  });

  it("hovering the inline worker lines opens the orchestrator's hover card", () => {
    const { project } = seed({ workerStatus: "errored" });
    render(<AgentSidebar project={project} />);
    // No card yet.
    expect(screen.queryByTestId("agent-hover-card")).toBeNull();
    // The worker lives inline under the head; hovering that lines container opens the parent's card.
    fireEvent.mouseEnter(screen.getByTestId("collapsed-worker-lines"));
    expect(screen.getByTestId("agent-hover-card")).toBeTruthy();
  });
});

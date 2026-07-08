// @vitest-environment jsdom
//
// Inline workers: a Build orchestrator renders its workers ON ITS OWN card — bare progress lines
// collapsed, stacked detail blocks (with actionable Status pills) when the card is hovered. These
// tests pin the load-bearing wiring: each worker's pill must act on THAT WORKER's id + base branch,
// not the orchestrator's. `refreshAgentBranch`/`landAgentBranch` were parameterized by id+base for
// exactly this — a wrong id threaded through would be a silent regression, so assert the scope.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
// The branch ops are what the Status pills call — mock them so a click is observable (and so no real
// Tauri command fires). Both resolve ok:true so the success path (pollBranchStatus) is exercised too.
// vi.hoisted: the vi.mock factory is hoisted above the file, so the fns must be hoisted with it.
const { refreshAgentBranch, landAgentBranch } = vi.hoisted(() => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock("../services/branchStatus", () => ({ refreshAgentBranch, landAgentBranch }));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";
import type { BranchStatus } from "../services/branchStatus";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
    ...over,
  };
}

// An orchestrator (a1) with one worker (w1) targeting "main". `bs` seeds the worker's branch status
// so its Status pill (ahead → green Land / behind → red Rebase) renders when the card is expanded.
function seedOrchestratorWithWorker(bs: BranchStatus): Project {
  const orchestrator = mkAgent("a1", "Alpha");
  const worker = mkAgent("w1", "Worker", { kind: "worker", parentId: "a1", baseBranch: "main" });
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [orchestrator, worker],
  };
  useProjectStore.setState({ projects: [project] } as never);
  // Only the worker has a branch status → only the worker's pill renders (the orchestrator reads
  // "Up to date"), so the pill we click is unambiguously the worker's.
  useRuntimeStore.setState({
    branchStatus: { w1: bs },
    status: {},
    workflowStage: {},
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

// Expanding = hovering the orchestrator's in-flow row, which mounts the slide-out overlay (a portal)
// carrying each worker's detail block + Status pill.
function hoverOrchestrator() {
  const card = document.querySelector<HTMLElement>('[draggable="true"]');
  if (!card) throw new Error("orchestrator card not found");
  fireEvent.mouseEnter(card);
}

beforeEach(() => useUiStore.setState({ collapsedOrchestrators: {} }));
afterEach(() => {
  cleanup();
  refreshAgentBranch.mockClear();
  landAgentBranch.mockClear();
});

describe("AgentSidebar — inline worker pills are scoped to the worker", () => {
  it("the worker's green 'ahead' pill lands THAT worker into its orchestrator's branch", () => {
    const project = seedOrchestratorWithWorker({ ahead: 2, behind: 0 } as BranchStatus);
    render(<AgentSidebar project={project} />);
    hoverOrchestrator();

    // The worker-specific copy ("…this worker's orchestrator") only renders for an inline worker.
    const pill = screen.getByRole("button", { name: /merge into this worker's orchestrator/i });
    fireEvent.click(pill);

    // landAgentBranch(rootPath, id, target, targetBusy): a worker lands into sparkle/agent-<parentId>,
    // NOT the orchestrator's own id/base. This is the regression guard.
    expect(landAgentBranch).toHaveBeenCalledTimes(1);
    expect(landAgentBranch).toHaveBeenCalledWith("/tmp/demo", "w1", "sparkle/agent-a1", false);
  });

  it("the worker's 'behind' pill rebases THAT worker on its own id + base branch", () => {
    const project = seedOrchestratorWithWorker({ ahead: 0, behind: 3 } as BranchStatus);
    render(<AgentSidebar project={project} />);
    hoverOrchestrator();

    // The behind pill is the calm, informational "Update available …" control (no longer alarm-red).
    const pill = screen.getByRole("button", { name: /update available · 3 behind main — click to catch up/i });
    fireEvent.click(pill);

    // refreshAgentBranch(rootPath, projectId, id, base, busy) — id "w1" + base "main", the worker's,
    // not the orchestrator's.
    expect(refreshAgentBranch).toHaveBeenCalledTimes(1);
    expect(refreshAgentBranch).toHaveBeenCalledWith("/tmp/demo", "p1", "w1", "main", false);
  });

  it("hides the in-flow strip content on hover so the unified card stands in for it (no duplicate)", () => {
    const project = seedOrchestratorWithWorker({ ahead: 0, behind: 0 } as BranchStatus);
    render(<AgentSidebar project={project} />);
    const row = document.querySelector<HTMLElement>('[draggable="true"]');
    if (!row) throw new Error("orchestrator row not found");
    // The strip content (name + own progress bar) is the row's first child; that — not the whole
    // row — is what the card stands in for and what gets hidden on hover. The row itself stays
    // visible so the collapsed worker lines below can remain a stable hover surface (flicker fix).
    const strip = row.firstElementChild as HTMLElement;
    expect(strip.style.visibility).not.toBe("hidden");

    // On hover the strip is HIDDEN (visibility:hidden — keeps its layout slot so rows below don't
    // jump) while the single unified card, anchored at the same spot and widening into the terminal
    // area, stands in for it. This is what keeps the name + progress bar from duplicating.
    fireEvent.mouseEnter(row);
    expect(strip.style.visibility).toBe("hidden");
    // And the detail renders in the card — the Status line is present (the orchestrator's own + the
    // worker's both read "Up to date with main").
    expect(screen.getAllByText(/up to date with main/i).length).toBeGreaterThan(0);
  });

  it("renders one named line per worker collapsed, and one detail block per worker on hover", () => {
    const orchestrator = mkAgent("a1", "Alpha");
    const w1 = mkAgent("w1", "WorkerOne", { kind: "worker", parentId: "a1", baseBranch: "main" });
    const w2 = mkAgent("w2", "WorkerTwo", { kind: "worker", parentId: "a1", baseBranch: "main" });
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [orchestrator, w1, w2],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, status: {}, workflowStage: {},
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    render(<AgentSidebar project={project} />);

    // Collapsed: each WorkflowLine is role="img" / "Workflow stage: …". One for the orchestrator's
    // own head line + one per worker = 3. Each worker's NAME now shows on its inline line too.
    const linesCollapsed = screen.getAllByRole("img", { name: /Workflow stage:/i });
    expect(linesCollapsed).toHaveLength(3);
    expect(screen.getByText("WorkerOne")).toBeTruthy();
    expect(screen.getByText("WorkerTwo")).toBeTruthy();

    // Hovered: the overlay stacks one detail block per worker — each worker's title appears there too
    // (once inline + once in the card), so there are now two matches per name.
    hoverOrchestrator();
    expect(screen.getAllByText("WorkerOne").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("WorkerTwo").length).toBeGreaterThanOrEqual(1);
  });

  it("shows each worker's progress bar (with stage label) in its detail block on hover", () => {
    const project = seedOrchestratorWithWorker({ ahead: 0, behind: 0 } as BranchStatus);
    render(<AgentSidebar project={project} />);
    // Collapsed bars render the line only — NO worded status label (that's hover-only). So the
    // "Building locally (Unsaved)…" stage detail is absent until hover, for orchestrator + worker.
    expect(screen.queryAllByText(/unsaved/i)).toHaveLength(0);

    hoverOrchestrator();
    // On hover the worker's bar moves DOWN into its detail block (below the worker name) and is
    // EXPANDED — so it now carries the stage status label, the same hover readout the orchestrator's
    // own strip bar gets. The "…Unsaved…" detail therefore appears twice: orchestrator + worker.
    expect(screen.getAllByText(/unsaved/i).length).toBeGreaterThanOrEqual(2);
  });
});

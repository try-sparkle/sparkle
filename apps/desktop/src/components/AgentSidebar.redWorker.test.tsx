// @vitest-environment jsdom
//
// A RED worker (waiting / approval / errored) is promoted OUT of its orchestrator's inline roll-up
// into its own selectable row, so the human can reach it and unblock it. These tests pin that:
//   1. a red worker's name is visible in the collapsed sidebar (NO hover needed) — the whole point,
//      since a non-red inline worker's name only appears on the orchestrator's hover card;
//   2. clicking it selects + opens THAT worker (mounts its pane/REPL);
//   3. a non-red worker is NOT promoted (stays in the roll-up);
//   4. the red worker also bubbles red to its orchestrator (so the orchestrator surfaces the block).
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

// Orchestrator a1 with one worker w1 in a given status.
function seed(workerStatus: AgentTabStatus): { project: Project; open: ReturnType<typeof vi.fn> } {
  const orchestrator = mkAgent("a1", "Alpha");
  const worker = mkAgent("w1", "Fix The Parser", { kind: "worker", parentId: "a1", baseBranch: "main" });
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [orchestrator, worker],
  };
  useProjectStore.setState({ projects: [project] } as never);
  const open = vi.fn();
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {},
    status: { w1: workerStatus } as Record<string, AgentTabStatus>,
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

describe("AgentSidebar — red worker promotion", () => {
  it("shows a red worker as its own row WITHOUT hovering the orchestrator", () => {
    const { project } = seed("errored");
    render(<AgentSidebar project={project} />);
    // Collapsed (no hover): a non-red inline worker's name would be absent here — a red one is a row.
    expect(screen.getByRole("button", { name: /Fix The Parser — Errored/i })).toBeTruthy();
    expect(screen.getByText("Fix The Parser")).toBeTruthy();
  });

  it("clicking the promoted row selects + opens THAT worker", () => {
    const { project, open } = seed("waiting");
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByRole("button", { name: /Fix The Parser — Needs you/i }));
    // onSelect → runtimeStore.open(workerId) + projectStore.selectAgent(projectId, workerId).
    expect(open).toHaveBeenCalledWith("w1");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("w1");
  });

  it("does NOT promote a non-red (working) worker — it stays in the roll-up", () => {
    const { project } = seed("working");
    render(<AgentSidebar project={project} />);
    // No standalone worker row while it's healthy; its name is hover-only inline detail.
    expect(screen.queryByRole("button", { name: /Fix The Parser/i })).toBeNull();
    expect(screen.queryByText("Fix The Parser")).toBeNull();
  });

  it("does NOT promote an UNSTARTED/stranded worker (it needs Start, and auto-open heals it)", () => {
    // Strand: worktree cut, parent open, but the worker never mounted → NO live status entry. The
    // composed status map paints it a synthetic "approval", but promotion keys off the worker's own
    // LIVE status, so it must stay in the roll-up (not pop out as an open+answer RedWorkerRow).
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
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {},
      status: {}, // no live status for w1 → it's a strand
      openAgentIds: ["a1"], // parent open, worker NOT open
      open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    render(<AgentSidebar project={project} />);
    expect(screen.queryByRole("button", { name: /Fix The Parser/i })).toBeNull();
  });
});

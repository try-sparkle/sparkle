// @vitest-environment jsdom
//
// EVERY worker renders as a named, clickable inline line under its orchestrator (no pop-out row).
// A worker that needs attention (waiting / approval / errored) keeps that same inline line, with its
// name inked red and its status carried in the line's label; it also bubbles red to its orchestrator
// so the head row + TopBar dot go red. These tests pin that:
//   1. a worker's name is visible in the collapsed sidebar (NO hover needed) — healthy OR red;
//   2. clicking it selects + opens THAT worker (mounts its pane/REPL);
//   3. an unstarted/stranded worker still renders inline (its name is reachable to start it).
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

describe("AgentSidebar — inline worker lines", () => {
  it("shows a red worker's inline line WITHOUT hovering the orchestrator", () => {
    const { project } = seed("errored");
    render(<AgentSidebar project={project} />);
    // Collapsed (no hover): the worker's name is an inline line, carrying its Errored status.
    expect(screen.getByRole("button", { name: /Fix The Parser — Errored/i })).toBeTruthy();
    expect(screen.getByText("Fix The Parser")).toBeTruthy();
  });

  it("clicking an inline worker line selects + opens THAT worker", () => {
    const { project, open } = seed("waiting");
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByRole("button", { name: /Fix The Parser — Needs you/i }));
    // onSelect → runtimeStore.open(workerId) + projectStore.selectAgent(projectId, workerId).
    expect(open).toHaveBeenCalledWith("w1");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("w1");
  });

  it("shows a healthy (working) worker's name inline too — no hover needed", () => {
    const { project } = seed("working");
    render(<AgentSidebar project={project} />);
    // Every worker is a named inline line now, healthy ones included.
    expect(screen.getByRole("button", { name: /Fix The Parser — /i })).toBeTruthy();
    expect(screen.getByText("Fix The Parser")).toBeTruthy();
  });

  it("renders an UNSTARTED/stranded worker inline so it stays reachable (click to start)", () => {
    // Strand: worktree cut, parent open, but the worker never mounted → NO live status entry. It
    // still renders as an inline named line (the composed status paints it a synthetic attention),
    // so the human can click to open + start it.
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
      status: {}, // no live status for w1 → it's a strand
      openAgentIds: ["a1"], // parent open, worker NOT open
      open,
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    render(<AgentSidebar project={project} />);
    const line = screen.getByRole("button", { name: /Fix The Parser — /i });
    expect(line).toBeTruthy();
    fireEvent.click(line);
    expect(open).toHaveBeenCalledWith("w1");
  });
});

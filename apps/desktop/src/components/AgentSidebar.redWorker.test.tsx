// @vitest-environment jsdom
//
// A worker that needs attention (waiting / approval / errored) — or an unstarted/stranded one — must
// never be lost now that workers no longer render as inline column lines. It bubbles its attention up
// to the orchestrator's head row (which floats up + goes red, noticed via the TopBar dot), and it
// stays reachable + clickable inside the orchestrator's detail card (opened by clicking the head).
// These tests pin that reachability for each attention status.
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

// Orchestrator a1 (name pinned so the head keeps "Alpha" to target) with one worker w1. When
// `hasStatus` is false the worker has NO live status entry — a strand (worktree cut, never mounted).
function seed(
  workerStatus: AgentTabStatus | null,
): { project: Project; open: ReturnType<typeof vi.fn> } {
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
    status: (workerStatus ? { w1: workerStatus } : {}) as Record<string, AgentTabStatus>,
    // A strand has the parent open but the worker NOT open.
    openAgentIds: workerStatus ? ["a1", "w1"] : ["a1"],
    open,
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return { project, open };
}

function openHeadCard() {
  const head = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
  fireEvent.click(head);
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("AgentSidebar — attention workers stay reachable via the card", () => {
  it("a RED (errored) worker is reachable + clickable in the orchestrator's card", () => {
    const { project, open } = seed("errored");
    render(<AgentSidebar project={project} />);
    // Not in the collapsed column…
    expect(screen.queryByRole("button", { name: /Open Fix The Parser/i })).toBeNull();
    // …but present in the card, and clicking it opens that worker.
    openHeadCard();
    fireEvent.click(screen.getByRole("button", { name: /Open Fix The Parser/i }));
    expect(open).toHaveBeenCalledWith("w1");
  });

  it("a worker awaiting you (waiting) is reachable + clickable in the card", () => {
    const { project, open } = seed("waiting");
    render(<AgentSidebar project={project} />);
    openHeadCard();
    fireEvent.click(screen.getByRole("button", { name: /Open Fix The Parser/i }));
    expect(open).toHaveBeenCalledWith("w1");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("w1");
  });

  it("a healthy (working) worker is reachable in the card too", () => {
    const { project } = seed("working");
    render(<AgentSidebar project={project} />);
    openHeadCard();
    expect(screen.getByRole("button", { name: /Open Fix The Parser/i })).toBeTruthy();
  });

  it("an UNSTARTED/stranded worker (no live status) still shows in the card so it can be started", () => {
    const { project, open } = seed(null); // strand: worktree cut, parent open, worker never mounted
    render(<AgentSidebar project={project} />);
    openHeadCard();
    const line = screen.getByRole("button", { name: /Open Fix The Parser/i });
    expect(line).toBeTruthy();
    fireEvent.click(line);
    expect(open).toHaveBeenCalledWith("w1");
  });
});

// @vitest-environment jsdom
// Regression coverage for the close-agent Ship/Save/Discard flow — specifically that "Ship it"
// keeps the agent when the land is BLOCKED (onLand → false) and tears it down on success. This is
// the central reason onLand was changed to return a boolean.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/worktree", () => ({ removeAgentWorkspace: vi.fn(() => Promise.resolve()) }));
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

function buildAgentProject(): Project {
  const agent: AgentTab = {
    id: "a1", name: "Build 1", kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: "main", lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null, autoNameVariants: null,
    shellCommand: null, pinnedIndex: null,
  };
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [agent],
  };
  useProjectStore.setState({ projects: [project] } as never);
  // ahead:1 → resolveStage → building_saved → needsClosePrompt() is true → close PROMPTS.
  useRuntimeStore.setState({
    branchStatus: { a1: { ahead: 1, behind: 0, dirty: false, filesChanged: 1, insertions: 1, deletions: 0 } },
    status: {},
    workflowStage: {},
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

function openClosePrompt() {
  render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
  // The × close control mounts when the row is hovered/expanded.
  const card = document.querySelector<HTMLElement>('[draggable="true"]');
  if (!card) throw new Error("agent card not found");
  fireEvent.mouseEnter(card);
  fireEvent.click(screen.getByLabelText("Close agent"));
}

const agentsNow = () => useProjectStore.getState().projects[0]!.agents.map((a) => a.id);

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {} } as never);
  landAgentBranch.mockReset();
});
afterEach(cleanup);

describe("AgentSidebar — close → Ship/Save/Discard", () => {
  it("prompts (does not silently close) when the agent has unmerged work", () => {
    buildAgentProject();
    openClosePrompt();
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(agentsNow()).toContain("a1"); // not torn down yet
  });

  it("Ship: a BLOCKED land keeps the agent (prompt stays, nothing torn down)", async () => {
    buildAgentProject();
    landAgentBranch.mockResolvedValue({ ok: false });
    openClosePrompt();
    fireEvent.click(screen.getByText("Ship it"));
    await waitFor(() => expect(landAgentBranch).toHaveBeenCalled());
    expect(agentsNow()).toContain("a1"); // agent survives a blocked land
    expect(screen.getByText("Ship it")).toBeTruthy(); // prompt stays open
  });

  it("Ship: a SUCCESSFUL land tears the agent down", async () => {
    buildAgentProject();
    landAgentBranch.mockResolvedValue({ ok: true });
    openClosePrompt();
    fireEvent.click(screen.getByText("Ship it"));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
  });

  it("Keep it for later closes the agent (keeps the branch — teardown only)", () => {
    buildAgentProject();
    openClosePrompt();
    fireEvent.click(screen.getByText("Keep it for later"));
    expect(agentsNow()).not.toContain("a1");
    expect(landAgentBranch).not.toHaveBeenCalled(); // no merge on Save
  });
});

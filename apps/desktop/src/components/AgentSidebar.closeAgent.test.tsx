// @vitest-environment jsdom
// Integration coverage for the close-agent Ship / Save / Discard wiring (× → requestClose → modal →
// handler). Ship = push + open a PR (review, not straight-to-main); Save = keep the branch; Discard =
// delete worktree + branch + bead behind an explicit confirm.
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
import { removeAgentWorkspace } from "../services/worktree";

const { refreshAgentBranch, landAgentBranch, pushAgentBranch, openAgentPr, deleteAgentBranch } =
  vi.hoisted(() => ({
    refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
    landAgentBranch: vi.fn(() => Promise.resolve({ ok: true, target: "main" })),
    pushAgentBranch: vi.fn(() => Promise.resolve("pushed")),
    openAgentPr: vi.fn(() => Promise.resolve("https://pr/1")),
    deleteAgentBranch: vi.fn(() => Promise.resolve()),
  }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch,
  landAgentBranch,
  pushAgentBranch,
  openAgentPr,
  deleteAgentBranch,
}));
// Spy the bead writes Ship/Discard use, keeping every other beads export real (planView/runtimeStore
// import from here too, so a full mock would break them).
const { closeBead, deleteBead, markBeadDelivered } = vi.hoisted(() => ({
  closeBead: vi.fn(() => Promise.resolve()),
  deleteBead: vi.fn(() => Promise.resolve()),
  markBeadDelivered: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/beads", async (orig) => ({
  ...(await orig<typeof import("../services/beads")>()),
  closeBead,
  deleteBead,
  markBeadDelivered,
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

function buildAgentProject(beadId?: string): Project {
  const agent: AgentTab = {
    id: "a1", name: "Build 1", kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: "main", lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null, autoNameVariants: null,
    shellCommand: null, pinnedIndex: null, beadId,
  };
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [agent],
  };
  useProjectStore.setState({ projects: [project] } as never);
  // ahead:1 → resolveStage → building_saved → shouldPromptOnClose() is true → close PROMPTS.
  useRuntimeStore.setState({
    branchStatus: { a1: { ahead: 1, behind: 0, dirty: false, filesChanged: 1, insertions: 1, deletions: 0 } },
    status: {},
    workflowStage: {},
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

function openClosePrompt() {
  // The × shows persistently on the ACTIVE row (and clicking it stopPropagations, so no card opens);
  // select the agent so the affordance is present, then click it. (Hovering no longer expands a row.)
  const p = useProjectStore.getState().projects[0]!;
  useProjectStore.setState({ projects: [{ ...p, selectedAgentId: "a1" }] } as never);
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
  render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
  fireEvent.click(screen.getByLabelText("Close agent"));
}

const agentsNow = () => useProjectStore.getState().projects[0]!.agents.map((a) => a.id);

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {} } as never);
  landAgentBranch.mockReset().mockResolvedValue({ ok: true, target: "main" });
  refreshAgentBranch.mockReset().mockResolvedValue({ ok: true });
  pushAgentBranch.mockReset().mockResolvedValue("pushed");
  openAgentPr.mockReset().mockResolvedValue("https://pr/1");
  deleteAgentBranch.mockReset().mockResolvedValue(undefined);
  vi.mocked(removeAgentWorkspace).mockReset().mockResolvedValue(undefined);
  closeBead.mockClear();
  deleteBead.mockClear();
});
afterEach(cleanup);

describe("AgentSidebar — persistent close on the active row", () => {
  it("shows the Close button on the ACTIVE (selected) row WITHOUT hovering", () => {
    const project = buildAgentProject();
    // The row the user is looking at — its output fills the main pane — is the selected/active one.
    useProjectStore.setState({ projects: [{ ...project, selectedAgentId: "a1" }] } as never);
    useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
    // No mouseEnter: the active row must expose a persistent close affordance, not a hover-only one.
    expect(screen.getByLabelText("Close agent")).toBeTruthy();
  });

  it("does NOT show the Close button on an inactive, un-interacted row", () => {
    const project = buildAgentProject();
    useProjectStore.setState({ projects: [{ ...project, selectedAgentId: null }] } as never);
    useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
    // The × is reserved for the active row (or the open detail card) — a resting inactive row has none.
    expect(screen.queryByLabelText("Close agent")).toBeNull();
  });
});

describe("AgentSidebar — close → Ship/Save/Discard", () => {
  it("prompts (does not silently close) when the agent has unmerged work", () => {
    buildAgentProject();
    openClosePrompt();
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(agentsNow()).toContain("a1"); // not torn down yet
  });

  it("Ship: pushes the branch + opens a PR (not a straight-to-main land), then tears down", async () => {
    buildAgentProject();
    openClosePrompt();
    fireEvent.click(screen.getByText("Ship it"));
    await waitFor(() => expect(openAgentPr).toHaveBeenCalled());
    expect(pushAgentBranch).toHaveBeenCalledWith("/tmp/demo", "a1");
    expect(landAgentBranch).not.toHaveBeenCalled(); // remote present → PR, never a local merge
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
  });

  it("Save for later closes the agent, keeps the branch (best-effort push, no land/PR)", async () => {
    buildAgentProject();
    openClosePrompt();
    fireEvent.click(screen.getByText("Save for later"));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(pushAgentBranch).toHaveBeenCalledWith("/tmp/demo", "a1"); // remote backup
    expect(landAgentBranch).not.toHaveBeenCalled();
    expect(openAgentPr).not.toHaveBeenCalled();
  });

  it("Discard requires a confirm, then deletes worktree + branch + bead and never lands", async () => {
    buildAgentProject("bd-1");
    openClosePrompt();
    fireEvent.click(screen.getByText("Discard")); // opens the confirm step — nothing destroyed yet
    expect(agentsNow()).toContain("a1");
    fireEvent.click(screen.getByText("Delete permanently"));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(removeAgentWorkspace).toHaveBeenCalled();
    expect(deleteAgentBranch).toHaveBeenCalledWith("/tmp/demo", "a1");
    await waitFor(() => expect(deleteBead).toHaveBeenCalledWith("/tmp/demo", "bd-1"));
    expect(landAgentBranch).not.toHaveBeenCalled();
    expect(openAgentPr).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
// The sidebar × is the real "I'm done" gesture, and for a CLOUD agent it's the only one that can
// stop the sandbox: the pane's unmount deliberately only detaches, so a close that doesn't DELETE
// leaves a metered sandbox running and lets the startup re-attach re-materialize the tab on the
// next project open (roborev 46881). Pinned here for × and for Discard.
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
vi.mock("../pty", () => ({ killPty: vi.fn(() => Promise.resolve()) }));

const { terminateIfCloud } = vi.hoisted(() => ({
  terminateIfCloud: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/cloudAgents/terminate", () => ({ terminateIfCloud }));

const { discardAgentGit, refreshAgentBranch } = vi.hoisted(() => ({
  discardAgentGit: vi.fn(() => Promise.resolve()),
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock("../services/closeAgentActions", async (orig) => ({
  ...(await orig<typeof import("../services/closeAgentActions")>()),
  discardAgentGit,
}));
vi.mock("../services/branchStatus", async (orig) => ({
  ...(await orig<typeof import("../services/branchStatus")>()),
  refreshAgentBranch,
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

/** A project holding one agent of the given runtime, with no work at risk (× closes silently).
 *  `withCloudChild` adds a cloud WORKER row parented to it — the subtree-termination cases. */
function seed(
  runtime: "local" | "cloud",
  opts: { atRisk?: boolean; withCloudChild?: boolean } = {},
): Project {
  const agent: AgentTab = {
    id: "a1", name: "Agent 1", kind: "build", parentId: null, runtime,
    worktreePath: null, branch: null, baseBranch: "main", lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null, autoNameVariants: null,
    shellCommand: null,  };
  const agents: AgentTab[] = [agent];
  if (opts.withCloudChild) {
    agents.push({
      ...agent,
      id: "w1", name: "Worker 1", kind: "worker", parentId: "a1", runtime: "cloud",
    });
  }
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: "a1", agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    // ahead:1 → work at risk → × PROMPTS (Ship/Save/Discard); ahead:0 → × closes silently.
    branchStatus: {
      a1: { ahead: opts.atRisk ? 1 : 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 },
    },
    status: {},
    workflowStage: {},
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  useUiStore.setState({ collapsedOrchestrators: {}, autoExpandedOrchestrators: {}, activeSpecial: null } as never);
  return project;
}

const clickClose = () => {
  render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
  fireEvent.click(screen.getByLabelText("Close agent"));
};

beforeEach(() => {
  terminateIfCloud.mockClear().mockResolvedValue(undefined);
  discardAgentGit.mockClear().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("AgentSidebar — closing a cloud agent stops the sandbox", () => {
  it("× on a cloud agent terminates the server session", async () => {
    seed("cloud");
    clickClose();
    await waitFor(() =>
      expect(terminateIfCloud).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", runtime: "cloud" })),
    );
    // …and the row still goes immediately; the DELETE is best-effort background work.
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).not.toContain("a1");
  });

  it("× on a LOCAL agent passes a local row (the helper no-ops — no cloud call)", async () => {
    seed("local");
    clickClose();
    await waitFor(() => expect(terminateIfCloud).toHaveBeenCalled());
    expect(terminateIfCloud).toHaveBeenCalledWith(expect.objectContaining({ runtime: "local" }));
  });

  it("Discard on a cloud agent terminates the server session too", async () => {
    seed("cloud", { atRisk: true });
    clickClose(); // work at risk → the Ship/Save/Discard prompt
    fireEvent.click(screen.getByText("Discard"));
    fireEvent.click(screen.getByText("Delete permanently"));
    await waitFor(() =>
      expect(terminateIfCloud).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", runtime: "cloud" })),
    );
  });

  // The headline of roborev 46918/47220: the WHOLE dropped subtree terminates — including a cloud
  // WORKER row, which takes the spinDownWorker early-return path after the terminate loop.
  it("× terminates a cloud WORKER under the closed agent, not just the root", async () => {
    seed("local", { withCloudChild: true });
    clickClose();
    await waitFor(() =>
      expect(terminateIfCloud).toHaveBeenCalledWith(expect.objectContaining({ id: "w1", runtime: "cloud" })),
    );
  });

  it("Discard terminates every cloud row in the subtree", async () => {
    seed("cloud", { atRisk: true, withCloudChild: true });
    clickClose();
    fireEvent.click(screen.getByText("Discard"));
    fireEvent.click(screen.getByText("Delete permanently"));
    await waitFor(() => {
      expect(terminateIfCloud).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", runtime: "cloud" }));
      expect(terminateIfCloud).toHaveBeenCalledWith(expect.objectContaining({ id: "w1", runtime: "cloud" }));
    });
  });
});

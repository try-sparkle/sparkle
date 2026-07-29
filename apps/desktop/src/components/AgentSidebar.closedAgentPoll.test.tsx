// @vitest-environment jsdom
//
// A CLOSED agent's branch must still be looked at.
//
// THE BUG, with a name: agent 532be93b ("Build 4") held ELEVEN unpushed commits and the app
// displayed it as idle with no activity — it was very nearly closed as an empty agent. Its pane was
// closed, and the sidebar's status tick only ever targeted agents whose pane was OPEN (plus the
// orchestrator parent of an open worker). So for every closed row, `branchStatus` stayed undefined
// forever; `resolveStage(undefined, …)` fell to `building_unsaved`; `hasUnmergedCommittedWork` said
// false; and `withUnmergedWork` — the overlay whose entire job is to say "this branch still needs
// you" — never fired. The app was not wrong about git. It had never asked.
//
// The naming tick one screen up already knew this failure mode: it deliberately polls CLOSED
// name-from-work candidates because "a build/worker that did real work while its pane was CLOSED can
// be stuck on its 'Build N' default forever". That is the same agent, and it is why the concrete
// case is literally named "Build 4" — a default name that outlived eleven commits.
//
// engine/statusPollTargets unit-tests the pure split; this file proves the sidebar is WIRED to it.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

const projectAgentsStatus = vi.fn(() => Promise.resolve([]));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  projectAgentsStatus: (...args: unknown[]) =>
    (projectAgentsStatus as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));
// The tick also fans out to the auto-namer; stub it so this file asserts on the git poll alone.
vi.mock("../services/agentNaming", () => ({
  refreshAgentTitle: vi.fn(() => Promise.resolve()),
  maybeNameFromWork: vi.fn(() => Promise.resolve()),
  isNameFromWorkCandidate: () => false,
  WORK_BACKSTOP_WINDOW_TICKS: 4,
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: "main", lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

/** "Build 4" is the closed one — the agent from the report. "Build 1" is open. */
function seed(): Project {
  const project: Project = {
    id: "p1", name: "drodio-website", rootPath: "/tmp/site", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: "open-1",
    agents: [mkAgent("open-1", "Build 1"), mkAgent("closed-4", "Build 4")],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, workflowShipped: {},
    status: { "open-1": "working" },
    openAgentIds: ["open-1"], // "closed-4" has no pane open — that is the whole point
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** Every agent id handed to any batch of the status poll, across all calls this tick. */
function polledIds(): string[] {
  return projectAgentsStatus.mock.calls.flatMap((call) => {
    const batch = (call as unknown[])[2] as { agentId: string }[] | undefined;
    return (batch ?? []).map((a) => a.agentId);
  });
}

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {}, autoExpandedOrchestrators: {}, activeSpecial: null,
  } as never);
  projectAgentsStatus.mockClear();
});
afterEach(cleanup);

describe("AgentSidebar status tick — closed agents are not invisible to git", () => {
  it("asks git about a CLOSED agent, so 11 unpushed commits cannot read as an empty agent", async () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    await waitFor(() => expect(projectAgentsStatus).toHaveBeenCalled());
    // Before the fix this array was ["open-1"] — "closed-4" was polled by nothing, ever.
    await waitFor(() => expect(polledIds()).toContain("closed-4"));
  });

  it("spends no network on the closed batch — local git answers 'does this branch hold work'", async () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    await waitFor(() => expect(polledIds()).toContain("closed-4"));

    // `probePrState` is the 4th arg. The closed batch must pass FALSE: a `gh` PR probe is ~0.5s of
    // subprocess per agent and re-runs every 90s even when git has not moved (PR_REPROBE_TTL), which
    // on a 46-agent fleet is a network storm bought for nothing. ahead/dirty is a local ref read and
    // is all `hasUnmergedCommittedWork` needs. PR state can wait until the pane is opened.
    const closedCall = projectAgentsStatus.mock.calls.find((call) =>
      ((call as unknown[])[2] as { agentId: string }[]).some((a) => a.agentId === "closed-4"),
    );
    expect(closedCall).toBeDefined();
    expect((closedCall as unknown[])[3]).toBe(false);

    const openCall = projectAgentsStatus.mock.calls.find((call) =>
      ((call as unknown[])[2] as { agentId: string }[]).some((a) => a.agentId === "open-1"),
    );
    expect((openCall as unknown[])[3]).toBe(true); // the open agent keeps its PR probe
  });
});

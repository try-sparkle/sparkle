// @vitest-environment jsdom
//
// The ENTRY POINT for local→cloud promotion (bead sparkle-8zpvc): one item in the agent row's
// detail card.
//
// Its ABSENCE is as much of the contract as its presence — but the list of things that hide it is
// now SHORT. It used to be hidden from anyone whose server had not advertised `CLOUD_AGENTS_ENABLED`,
// i.e. from essentially everyone; that gate is gone, because a control that vanishes teaches the
// user the feature was deleted. What remains: signed out, and the two kinds of row it means nothing
// for — an agent already in the cloud, and a shell agent with no branch and no conversation to move.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
// A MARKER, not a null stub: one test below asserts the column actually MOUNTS the dialog when the
// item is used, and a null stub renders nothing either way — the assertion would pass against a
// sidebar that never mounted it at all.
vi.mock("./PromoteToCloudDialog", () => ({
  PromoteToCloudDialog: ({ agent }: { agent: { id: string } }) => (
    <div data-testid="promote-dialog-mounted">{agent.id}</div>
  ),
  // The sidebar builds the deps and hands them to the dialog, so the mock has to offer this too —
  // a mock missing it fails at the import, not at an assertion, which tells you nothing about the
  // behaviour under test.
  promoteDialogDeps: () => ({
    loadPlan: () => Promise.resolve({ ok: false, refusal: "no_remote", message: "stub" }),
    promote: () => Promise.resolve({ ok: false, step: "preflight", message: "stub" }),
  }),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useAuthStore } from "../stores/authStore";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import type { AgentTab, Project } from "../types";
import { openAgentCard } from "../testing/rowGestures";

function mkAgent(over: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1",
    name: "Parser Agent",
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: "/tmp/demo-wt",
    branch: "sparkle/agent-fixture",
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    ...over,
  };
}

function mkProject(agents: AgentTab[]): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
}

/** Cloud offered: SIGNED IN — `cloudOptionVisible`, the same predicate the creation flow's Cloud
 *  option is gated on. `cloudAgentsEnabled` is still settable here only so the test below can prove
 *  it no longer hides anything. */
function cloudAdvertised(over: { cloudAgentsEnabled?: boolean; signedIn?: boolean } = {}) {
  useAuthStore.setState({
    me: {
      clerkUserId: "u",
      entitled: true,
      balanceCents: 5000,
      tokenVersion: 1,
      cloudAgentsEnabled: over.cloudAgentsEnabled ?? true,
    },
    tokenPresent: over.signedIn ?? true,
    loading: false,
  } as never);
}

/** Open the row's detail card — the card is where a row's actions live (Land, rebase, the model
 *  picker, the path reveal), and right-click is how it opens. */
function openCard(name: string) {
  const row = screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
  openAgentCard(row);
}

const item = () => screen.queryByTestId("promote-to-cloud");

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {}, workflowStage: {} } as never);
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" },
    collapsedOrchestrators: {},
    promoteAgentId: null,
    settingsRequest: null,
  } as never);
  useCloudAuthStore.setState({ method: "byok", loaded: true, busy: false, error: null } as never);
  cloudAdvertised();
});
afterEach(cleanup);

describe("AgentSidebar — Move to cloud", () => {
  it("offers it on a LOCAL build agent when cloud is advertised", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).not.toBeNull();
  });

  // ── THE ABSENCES ─────────────────────────────────────────────────────────────────────────────
  // Every one of these renders the SAME row that shows the item above, changing exactly one fact.

  // Moved out of THE ABSENCES: the advertised capability no longer hides anything. It is a global
  // server switch, not a per-account entitlement, so hiding on it removed the control from everyone
  // — and a control that vanishes teaches the user the feature was deleted (sparkle-lcx8y). The
  // promote dialog's own gate states the fixable reason instead.
  it("is PRESENT for a signed-in user whose /me carries no cloud capability", () => {
    cloudAdvertised({ cloudAgentsEnabled: false });
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).not.toBeNull();
  });

  it("is absent when signed out", () => {
    cloudAdvertised({ signedIn: false });
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).toBeNull();
  });

  it("is absent on an agent that is ALREADY in the cloud", () => {
    render(<AgentSidebar project={mkProject([mkAgent({ runtime: "cloud" })])} />);
    openCard("Parser Agent");
    expect(item()).toBeNull();
  });

  it("is absent on a shell agent — no branch and no conversation to move", () => {
    render(
      <AgentSidebar
        project={mkProject([mkAgent({ kind: "shell", shellCommand: "zsh" })])}
      />,
    );
    openCard("Parser Agent");
    expect(item()).toBeNull();
  });

  it("is absent from the collapsed row — it lives on the card, not in the column", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    // No card opened: the dense column stays dense.
    expect(item()).toBeNull();
  });

  // ── WHAT USING IT DOES ───────────────────────────────────────────────────────────────────────

  it("opens the confirm dialog for THAT agent", () => {
    render(<AgentSidebar project={mkProject([mkAgent({ id: "a7" })])} />);
    openCard("Parser Agent");
    expect(screen.queryByTestId("promote-dialog-mounted")).toBeNull();

    fireEvent.click(item()!);
    // Both halves of the side effect: the request is recorded against this agent, and the column
    // actually puts the dialog up for it.
    expect(useUiStore.getState().promoteAgentId).toBe("a7");
    expect(screen.getByTestId("promote-dialog-mounted").textContent).toBe("a7");
  });

  it("mounts the dialog only for an agent in THIS column's project", () => {
    // The open request is one app-wide id, and both columns of a pair render an AgentSidebar. A
    // column that does not hold the agent must not put up a second copy of the dialog.
    useUiStore.setState({ promoteAgentId: "somebody-elses-agent" } as never);
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    expect(screen.queryByTestId("promote-dialog-mounted")).toBeNull();
  });
});

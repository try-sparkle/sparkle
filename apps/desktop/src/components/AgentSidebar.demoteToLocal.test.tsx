// @vitest-environment jsdom
//
// The ENTRY POINT for cloud→local demotion (plan §W4): one item in the agent row's detail card.
//
// Its ABSENCE is as much of the contract as its presence — but the absences here are NOT the ones
// its sibling "Move to cloud" has, and that difference is the point of this file. Demotion is
// offered on exactly two conditions (cloud + build) and is deliberately gated on NOTHING else:
//
//   • no `cloudOfferable` check — a cloud tab IS a running sandbox, and a running sandbox is
//     billing whatever the account looks like. Hiding the exit because the entrance is shut would
//     strand exactly the agent that costs money;
//   • no `evaluateCloudGate` check — a user whose credits ran out is exactly the user who needs to
//     bring work down, and a gate that hides the exit is a trap.
//
// Both are pinned below by rendering a row that WOULD fail the promotion gate and asserting the
// item is still there — so each case must pick a fact that genuinely fails that gate TODAY.
// `cloudOfferable` is now just "signed in"; a stale `cloudAgentsEnabled: false` case would render
// byte-for-byte like the baseline test and pin nothing.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
// A MARKER, not a null stub: one test below asserts the column actually MOUNTS the dialog, and a
// null stub renders nothing either way — the assertion would pass against a sidebar that never
// mounted it at all.
vi.mock("./DemoteToLocalDialog", () => ({
  DemoteToLocalDialog: ({ agent }: { agent: { id: string } }) => (
    <div data-testid="demote-dialog-mounted">{agent.id}</div>
  ),
  // The sidebar builds the deps and hands them to the dialog, so the mock has to offer this too —
  // a mock missing it fails at the import, not at an assertion.
  demoteDialogDeps: () => ({
    loadPlan: () => Promise.resolve({ ok: false, refusal: "no_branch", message: "stub" }),
    demote: () => Promise.resolve({ ok: false, step: "preflight", message: "stub" }),
  }),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useAuthStore } from "../stores/authStore";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import type { AgentTab, Project } from "../types";

function mkAgent(over: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1",
    name: "Parser Agent",
    kind: "build",
    parentId: null,
    runtime: "cloud",
    worktreePath: null,
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

/** The signed-in, entitled, in-credit, cloud-advertised world — the state in which the PROMOTION
 *  item is offered. Every "still offered" test below breaks exactly one of these. */
function cloudAdvertised(
  over: { cloudAgentsEnabled?: boolean; signedIn?: boolean; balanceCents?: number } = {},
) {
  useAuthStore.setState({
    me: {
      clerkUserId: "u",
      entitled: true,
      balanceCents: over.balanceCents ?? 5000,
      tokenVersion: 1,
      cloudAgentsEnabled: over.cloudAgentsEnabled ?? true,
    },
    tokenPresent: over.signedIn ?? true,
    loading: false,
  } as never);
}

/** Open the row's detail card — the card is where a row's actions live, and right-click opens it. */
function openCard(name: string) {
  const row = screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
  fireEvent.contextMenu(row);
}

const item = () => screen.queryByTestId("demote-to-local");

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {}, workflowStage: {} } as never);
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" },
    collapsedOrchestrators: {},
    promoteAgentId: null,
    demoteAgentId: null,
    settingsRequest: null,
  } as never);
  useCloudAuthStore.setState({ method: "byok", loaded: true, busy: false, error: null } as never);
  cloudAdvertised();
});
afterEach(cleanup);

describe("AgentSidebar — Bring down to local", () => {
  it("offers it on a CLOUD build agent", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).not.toBeNull();
  });

  // ── THE ABSENCES ─────────────────────────────────────────────────────────────────────────────

  it("is absent on an agent that is already LOCAL — there is nothing to bring down", () => {
    render(
      <AgentSidebar
        project={mkProject([mkAgent({ runtime: "local", worktreePath: "/tmp/demo-wt" })])}
      />,
    );
    openCard("Parser Agent");
    expect(item()).toBeNull();
  });

  it("is absent on a shell agent — no branch and no conversation to bring down", () => {
    render(
      <AgentSidebar project={mkProject([mkAgent({ kind: "shell", shellCommand: "zsh" })])} />,
    );
    openCard("Parser Agent");
    expect(item()).toBeNull();
  });

  it("is absent from the collapsed row — it lives on the card, not in the column", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    // No card opened: the dense column stays dense.
    expect(item()).toBeNull();
  });

  // ── THE NON-GATES: nothing about the account closes the exit ──────────────────────────────────
  // Each of these renders the SAME cloud row as the first test, changing exactly one fact about the
  // account. The item must survive all of them: a running sandbox is billing either way.

  // SIGNED OUT is the state that actually fails `cloudOfferable` today, so it is the one that can
  // still pin "demote is not gated on it". The previous version of this case used
  // `cloudAgentsEnabled: false` — which stopped failing that gate when the capability was deleted,
  // leaving a render byte-for-byte identical to the baseline test above and an assertion that could
  // not fail. A signed-out user with a live sandbox is also the real scenario: the token lapsed, the
  // sandbox is still billing, and the exit had better be there.
  it("is STILL offered when SIGNED OUT — the sandbox is billing regardless", () => {
    cloudAdvertised({ signedIn: false });
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).not.toBeNull();
  });

  // A re-introduction guard, and labelled as one: this pins that the DELETED capability cannot come
  // back as a hide condition for the exit. It is deliberately not the `cloudOfferable` pin above —
  // it cannot be, since nothing reads this field any more.
  it("is STILL offered when /me carries no cloud capability (re-introduction guard)", () => {
    cloudAdvertised({ cloudAgentsEnabled: false });
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).not.toBeNull();
  });

  it("is STILL offered when the credit balance is zero — that user needs it MOST", () => {
    cloudAdvertised({ balanceCents: 0 });
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).not.toBeNull();
  });

  // ── WHAT USING IT DOES ───────────────────────────────────────────────────────────────────────

  it("opens the confirm dialog for THAT agent", () => {
    render(<AgentSidebar project={mkProject([mkAgent({ id: "a7" })])} />);
    openCard("Parser Agent");
    expect(screen.queryByTestId("demote-dialog-mounted")).toBeNull();

    fireEvent.click(item()!);
    // Both halves of the side effect: the request is recorded against this agent, and the column
    // actually puts the dialog up for it.
    expect(useUiStore.getState().demoteAgentId).toBe("a7");
    expect(screen.getByTestId("demote-dialog-mounted").textContent).toBe("a7");
  });

  it("mounts the dialog only for an agent in THIS column's project", () => {
    // The open request is one app-wide id, and both columns of a pair render an AgentSidebar. A
    // column that does not hold the agent must not put up a second copy of the dialog.
    useUiStore.setState({ demoteAgentId: "somebody-elses-agent" } as never);
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    expect(screen.queryByTestId("demote-dialog-mounted")).toBeNull();
  });
});

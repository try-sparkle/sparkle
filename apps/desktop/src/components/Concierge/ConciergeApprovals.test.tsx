// @vitest-environment jsdom
//
// The END-TO-END claim, and the reason this file exists at all: a human clicking Approve in the
// column is what makes an ask-tier tool call succeed. Every layer is covered on its own; this is
// the one test that walks the whole path — policy says `ask`, the prompt appears, a click resolves
// it, and the retry's policy decision comes back approved.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAuthStore } from "../../stores/authStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configuredToolPolicy } from "../../services/conciergeTools/policyBinding";
import { clearConciergeApprovals, findApproval } from "../../stores/conciergeApprovals";
import { useSettingsStore } from "../../stores/settingsStore";
import { ConciergeApprovals } from "./ConciergeApprovals";


// The concierge's AI-enhancements gate (bead sparkle-4562) is a real precondition for a turn and
// for every tool call, so these suites — which test the mechanics, not the entitlement — open it
// explicitly. `aiGate.concierge.test.ts` is where the gate's own behaviour is asserted.
function openConciergeAiGate() {
  useSettingsStore.setState({ aiConcierge: true });
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
    creditFloorCents: 0,
  } as never);
}

const setPolicyMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../services/configActions", () => ({
  setConciergeToolPolicy: (...a: unknown[]) => setPolicyMock(...(a as [])),
}));

const query = (toolCallId: string, args: unknown = { projectId: "p1" }) => ({
  domain: "workspace" as const,
  op: "remove_project",
  write: true,
  toolCallId,
  args,
});

beforeEach(() => {
    openConciergeAiGate();
  clearConciergeApprovals();
  useSettingsStore.setState({ conciergeToolPolicy: {} });
  setPolicyMock.mockClear();
});
afterEach(() => cleanup());

describe("ConciergeApprovals — the round-trip through a human", () => {
  it("shows nothing while nothing is pending", () => {
    const { container } = render(<ConciergeApprovals />);
    expect(container.innerHTML).toBe("");
  });

  it("surfaces a call the policy stopped, and APPROVING it is what lets the retry run", () => {
    // 1. The concierge tries something the human marked (or the risk map defaults to) "ask first".
    expect(configuredToolPolicy(query("call-1"))).toEqual({ tier: "ask", approvedByUser: false });

    // 2. The question is on the human's screen, naming the tool and what it would act on.
    render(<ConciergeApprovals />);
    expect(screen.getByTestId("approval-card").getAttribute("data-op")).toBe("remove_project");
    expect(screen.getByText("workspace.remove_project")).toBeTruthy();

    // 3. The human says yes. THIS is the gesture — nothing in the tool path can stand in for it.
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));
    expect(findApproval("call-1")?.outcome).toBe("approved");

    // 4. The next turn retries under a fresh MCP-minted id and is finally allowed through.
    expect(configuredToolPolicy(query("call-2-fresh"))).toEqual({
      tier: "ask",
      approvedByUser: true,
      // Pinned to the call that spends it, so the authority cannot be replayed for another.
      approvedForToolCallId: "call-2-fresh",
    });

    // 5. And the grant is spent: a third attempt has to ask again.
    expect(configuredToolPolicy(query("call-3"))).toEqual({ tier: "ask", approvedByUser: false });
  });

  it("declining leaves the tool refused, and takes the card away", () => {
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Decline workspace.remove_project"));
    expect(findApproval("call-1")?.outcome).toBe("denied");
    expect(screen.queryByTestId("approval-card")).toBeNull();
    expect(configuredToolPolicy(query("call-2"))).toEqual({ tier: "ask", approvedByUser: false });
  });

  it("'always allow' writes the SETTINGS override, not an invisible session grant", () => {
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Always allow remove_project without asking"));
    // Visible and revocable in Settings → Concierge tools, which is the whole constraint: a
    // standing permission the human cannot find is a standing permission they cannot take back.
    expect(setPolicyMock).toHaveBeenCalledWith("remove_project", "allow");
    // …and it also answers the call in hand, so the one button that means "yes, and stop asking"
    // does not leave the thing you were asked about still blocked.
    expect(findApproval("call-1")?.outcome).toBe("approved");
  });

  it("stacks a second request rather than replacing the first", () => {
    configuredToolPolicy(query("call-1", { projectId: "p1" }));
    configuredToolPolicy(query("call-2", { projectId: "p2" }));
    render(<ConciergeApprovals />);
    expect(screen.getAllByTestId("approval-card")).toHaveLength(2);
  });

  it("never renders a resolved request", () => {
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));
    expect(screen.queryByTestId("approval-card")).toBeNull();
  });
});

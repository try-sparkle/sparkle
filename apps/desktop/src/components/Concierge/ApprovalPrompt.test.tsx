// @vitest-environment jsdom
//
// The approval prompt's contract: it states plainly WHAT will happen (the tool's own summary), HOW
// risky the domain says it is, and WHICH arguments it would run with; Approve and Decline each fire
// for the one call they belong to; and "always allow" is a separate, quieter gesture that goes to
// Settings rather than being an invisible session grant.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalPrompt } from "./ApprovalPrompt";
import type { ConciergeApproval } from "../../stores/conciergeApprovals";

afterEach(() => cleanup());

function approval(over: Partial<ConciergeApproval> = {}): ConciergeApproval {
  return {
    id: "call-1",
    domain: "lifecycle",
    op: "discard_agent",
    summary: "Throw the agent's work away.",
    riskClass: "irreversible",
    riskNote: "Permanently destroys something that cannot be recovered.",
    args: [{ key: "agentId", value: "kraken-auth" }],
    configPath: "concierge.tools.discard_agent",
    fingerprint: "lifecycle.discard_agent#{}",
    requestedAt: 0,
    expiresAt: 1,
    outcome: "pending",
    resolvedAt: null,
    spent: false,
    ...over,
  };
}

describe("ApprovalPrompt", () => {
  it("renders nothing when nothing is pending", () => {
    const { container } = render(
      <ApprovalPrompt approvals={[]} onApprove={vi.fn()} onDecline={vi.fn()} onAlwaysAllow={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("states what will happen, how risky it is, and what it would run with", () => {
    render(
      <ApprovalPrompt
        approvals={[approval()]}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
        onAlwaysAllow={vi.fn()}
      />,
    );
    expect(screen.getByText("Throw the agent's work away.")).toBeTruthy();
    expect(
      screen.getByText("Permanently destroys something that cannot be recovered."),
    ).toBeTruthy();
    expect(screen.getByText("irreversible")).toBeTruthy();
    expect(screen.getByText("lifecycle.discard_agent")).toBeTruthy();
    // The OBJECT of the verb. Approving a bare "discard" with no agent named is not consent.
    const args = screen.getByTestId("approval-args");
    expect(within(args).getByText("agentId")).toBeTruthy();
    expect(within(args).getByText("kraken-auth")).toBeTruthy();
  });

  it("shows EVERY pending request, not just the newest", () => {
    render(
      <ApprovalPrompt
        approvals={[approval(), approval({ id: "call-2", op: "merge_pr" })]}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
        onAlwaysAllow={vi.fn()}
      />,
    );
    // A request the human can't see is a tool call that will never resolve.
    expect(screen.getAllByTestId("approval-card")).toHaveLength(2);
  });

  it("approves and declines the specific call the button belongs to", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(
      <ApprovalPrompt
        approvals={[approval(), approval({ id: "call-2", op: "merge_pr", domain: "workflow" })]}
        onApprove={onApprove}
        onDecline={onDecline}
        onAlwaysAllow={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Approve workflow.merge_pr"));
    expect(onApprove).toHaveBeenCalledWith("call-2");
    fireEvent.click(screen.getByLabelText("Decline lifecycle.discard_agent"));
    expect(onDecline).toHaveBeenCalledWith("call-1");
  });

  it("keeps 'always allow' a SEPARATE gesture, and names the setting it would write", () => {
    const onApprove = vi.fn();
    const onAlwaysAllow = vi.fn();
    const a = approval();
    render(
      <ApprovalPrompt
        approvals={[a]}
        onApprove={onApprove}
        onDecline={vi.fn()}
        onAlwaysAllow={onAlwaysAllow}
      />,
    );
    const always = screen.getByLabelText("Always allow discard_agent without asking");
    // Discoverable and revocable: the tooltip names the exact config key it writes.
    expect(always.getAttribute("title")).toContain("concierge.tools.discard_agent");
    fireEvent.click(always);
    expect(onAlwaysAllow).toHaveBeenCalledWith(a);
    // It is NOT the approve button wearing a different hat — the two are distinct handlers so a
    // standing permission can never be granted by someone aiming for a one-off yes.
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("carries no live region of its own — the column owns the only announcer", () => {
    const { container } = render(
      <ApprovalPrompt
        approvals={[approval()]}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
        onAlwaysAllow={vi.fn()}
      />,
    );
    // A second aria-live node in this column makes a screen reader read every request twice
    // (learned once already — roborev 52648/53010).
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  it("uses Feather icons, never emoji", () => {
    // Repo rule: no emoji as icons anywhere in the app.
    const { container } = render(
      <ApprovalPrompt
        approvals={[approval()]}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
        onAlwaysAllow={vi.fn()}
      />,
    );
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(4);
    expect(/\p{Extended_Pictographic}/u.test(container.textContent ?? "")).toBe(false);
  });

  it("survives a tool with no classification and no arguments", () => {
    render(
      <ApprovalPrompt
        approvals={[approval({ riskClass: null, riskNote: "", args: [] })]}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
        onAlwaysAllow={vi.fn()}
      />,
    );
    expect(screen.getByTestId("approval-card")).toBeTruthy();
    expect(screen.queryByTestId("approval-args")).toBeNull();
  });
});

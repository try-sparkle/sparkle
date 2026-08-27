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
    requestedBy: "sparkle:concierge",
    domain: "lifecycle",
    op: "discard_agent",
    summary: "Throw the agent's work away.",
    riskClass: "irreversible",
    riskNote: "Permanently destroys something that cannot be recovered.",
    args: [{ key: "agentId", value: "kraken-auth" }],
    rawArgs: { agentId: "kraken-auth" },
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
  // TWO IDENTICAL CARDS ARE NOW REPRESENTABLE (bead `sparkle-tavx1`). The ledger collapses a repeat
  // per REQUESTER, so two agents asking the same thing put two cards here with the same domain, op,
  // summary and arguments. If the card cannot say who asked, the human is answering a coin flip.
  describe("names the caller that raised it", () => {
    it("tells two byte-identical cards apart by their asker", () => {
      render(
        <ApprovalPrompt
          approvals={[
            approval({ id: "call-a", requestedBy: "agent-a" }),
            approval({ id: "call-b", requestedBy: "agent-b" }),
          ]}
          // Keyed by APPROVAL id — see the prop's doc for why a requester-keyed map cannot
          // disambiguate two unattributed cards at all.
          requesterLabels={{ "call-a": "Kraken Auth", "call-b": "Stripe Checkout" }}
          onApprove={vi.fn()}
          onDecline={vi.fn()}
          onAlwaysAllow={vi.fn()}
        />,
      );
      // Both cards are up — an assertion that only found one name would pass just as well if the
      // second card had never rendered.
      const cards = screen.getAllByTestId("approval-card");
      expect(cards).toHaveLength(2);
      // …and each names ITS OWN asker, which is stronger than "a name appears somewhere".
      expect(within(cards[0]!).getByTestId("approval-requester").textContent).toContain(
        "Kraken Auth",
      );
      expect(within(cards[1]!).getByTestId("approval-requester").textContent).toContain(
        "Stripe Checkout",
      );
    });

    it("falls back to the raw id for an agent it cannot name, rather than to nothing", () => {
      // An agent can be torn down while its question is still on screen. The id is ugly and still
      // discriminates one card from another, which is the whole job of this line.
      render(
        <ApprovalPrompt
          approvals={[approval({ requestedBy: "agent-gone" })]}
          requesterLabels={{}}
          onApprove={vi.fn()}
          onDecline={vi.fn()}
          onAlwaysAllow={vi.fn()}
        />,
      );
      expect(screen.getByTestId("approval-requester").textContent).toContain("agent-gone");
    });

    it("says an unattributed card is unattributed instead of blaming the app", () => {
      render(
        <ApprovalPrompt
          approvals={[approval({ requestedBy: "" })]}
          onApprove={vi.fn()}
          onDecline={vi.fn()}
          onAlwaysAllow={vi.fn()}
        />,
      );
      // The ledger treats a blank requester as belonging to nobody — no agent may read it, only the
      // human may answer it. The card must state that, not invent an owner.
      expect(screen.getByTestId("approval-requester").textContent).toContain(
        "an unidentified caller",
      );
    });
  });

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
    // The WHOLE entry, not just its id: approving runs the call, and the runner replays it from the
    // entry's own stored arguments (services/conciergeApprovalResume).
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect((onApprove.mock.calls[0]?.[0] as { id: string } | undefined)?.id).toBe("call-2");
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

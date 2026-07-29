// @vitest-environment jsdom
//
// The receipt is the mitigation that makes auto-routing defensible (see RoutingReceipt.tsx's
// header), so its wording is treated as a correctness concern, not copy. The retraction tripwire
// below is the important one: a redirect RE-SENDS, and text already in a PTY cannot be pulled
// back, so any wording implying otherwise is a lie to the user about what the app did.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutingReceipt, receiptText, redirectLabel } from "./RoutingReceipt";
import type { ConciergeReceipt } from "./types";

afterEach(() => cleanup());

describe("receiptText", () => {
  it("names the agent a message was sent to", () => {
    expect(receiptText({ target: "agent", agentName: "Kraken Auth" })).toBe("→ Sent to Kraken Auth");
  });

  it("says a chat answer landed here, not 'sent to Sparkle'", () => {
    expect(receiptText({ target: "sparkle" })).toBe("→ Answered here");
  });

  it("falls back to a generic noun when the agent has no name", () => {
    expect(receiptText({ target: "agent" })).toBe("→ Sent to the agent");
  });

  it("states BOTH destinations in order once redirected", () => {
    expect(receiptText({ target: "agent", agentName: "Kraken Auth", alsoSentTo: "sparkle" })).toBe(
      "→ Sent to Kraken Auth, then to here",
    );
    expect(receiptText({ target: "sparkle", agentName: "Kraken Auth", alsoSentTo: "agent" })).toBe(
      "→ Answered here, then to Kraken Auth",
    );
  });

  // The tripwire. A redirect is additive; the first delivery stands.
  it("never implies the original delivery was undone", () => {
    const redirected: ConciergeReceipt[] = [
      { target: "agent", agentName: "Kraken Auth", alsoSentTo: "sparkle" },
      { target: "sparkle", agentName: "Kraken Auth", alsoSentTo: "agent" },
    ];
    for (const r of redirected) {
      expect(receiptText(r)).not.toMatch(/instead|moved|undone|unsent|cancell?ed|rather than/i);
    }
  });
});

describe("redirectLabel", () => {
  it("offers Sparkle when the message went to an agent", () => {
    expect(redirectLabel({ target: "agent", agentName: "Kraken Auth" })).toBe("Also ask Sparkle");
  });

  it("offers the agent by name when the message stayed in chat", () => {
    expect(redirectLabel({ target: "sparkle", agentName: "Kraken Auth" })).toBe(
      "Also ask Kraken Auth",
    );
  });

  // The button is the one place the user reads the promise BEFORE acting, so the no-retraction rule
  // applies to it at least as strongly as to the receipt line. It used to say "instead" — the exact
  // word receiptText is tripwired against (roborev 53043).
  it("never implies the original delivery will be undone", () => {
    const labels = [
      redirectLabel({ target: "agent", agentName: "Kraken Auth" }),
      redirectLabel({ target: "sparkle", agentName: "Kraken Auth" }),
    ];
    for (const l of labels) {
      expect(l).not.toMatch(/instead|moved|undone|unsent|cancell?ed|rather than/i);
    }
  });

  // Offering a redirect with nowhere to redirect TO would be a dead button.
  it("offers nothing when a chat answer has no agent to redirect to", () => {
    expect(redirectLabel({ target: "sparkle" })).toBeNull();
  });

  it("offers nothing once the message has gone both ways", () => {
    expect(
      redirectLabel({ target: "agent", agentName: "Kraken Auth", alsoSentTo: "sparkle" }),
    ).toBeNull();
  });
});

describe("RoutingReceipt — rendering", () => {
  it("renders the button and reports the click when redirectable", () => {
    const onRedirect = vi.fn();
    render(
      <RoutingReceipt
        receipt={{ target: "agent", agentName: "Kraken Auth", redirectable: true }}
        onRedirect={onRedirect}
      />,
    );
    fireEvent.click(screen.getByTestId("routing-redirect"));
    expect(onRedirect).toHaveBeenCalledTimes(1);
  });

  // Only the LATEST receipt is redirectable — redirecting a message from ten turns ago is never
  // what the user means, and a thread full of live buttons invites exactly that misfire.
  it("renders the line but no button on a stale receipt", () => {
    render(
      <RoutingReceipt
        receipt={{ target: "agent", agentName: "Kraken Auth" }}
        onRedirect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("routing-receipt").textContent).toContain("Kraken Auth");
    expect(screen.queryByTestId("routing-redirect")).toBeNull();
  });

  it("renders no button when the host supplies no redirect handler", () => {
    render(<RoutingReceipt receipt={{ target: "agent", agentName: "Kraken Auth", redirectable: true }} />);
    expect(screen.queryByTestId("routing-redirect")).toBeNull();
  });
});

// A message the brain never got round to answering, because the user's next one displaced its turn.
// 149 of 378 turns died this way on 2026-07-29 and every one of them kept a receipt reading
// "Answered here".
describe("receiptText — a message that was never answered", () => {
  it("does not claim the message was answered", () => {
    const line = receiptText({ target: "sparkle", unanswered: true });
    expect(line).not.toContain("Answered here");
    expect(line).toBe("→ Replaced by your next message — never answered");
  });

  // REPLACES the phrase rather than qualifying it. "Answered here — never answered" is a
  // contradiction the reader has to resolve, and half of them will resolve it wrong.
  it("says the same thing whichever way the message was routed", () => {
    expect(receiptText({ target: "agent", agentName: "Kraken Auth", unanswered: true })).toBe(
      receiptText({ target: "sparkle", unanswered: true }),
    );
  });

  // The same no-retraction rule the rest of this file is tripwired against: the message WAS
  // delivered — the brain read it and was working on it — so nothing here may imply it was unsent.
  it("never implies the message itself was retracted", () => {
    expect(receiptText({ target: "sparkle", unanswered: true })).not.toMatch(
      /instead|moved|undone|unsent|cancell?ed|not sent/i,
    );
  });
});

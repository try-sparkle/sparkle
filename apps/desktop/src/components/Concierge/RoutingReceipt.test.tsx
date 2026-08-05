// @vitest-environment jsdom
//
// The receipt is the mitigation that makes auto-routing defensible (see RoutingReceipt.tsx's
// header), so its wording is treated as a correctness concern, not copy. The retraction tripwire
// below is the important one: a redirect RE-SENDS, and text already in a PTY cannot be pulled
// back, so any wording implying otherwise is a lie to the user about what the app did.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutingReceipt, receiptText } from "./RoutingReceipt";
import type { ConciergeReceipt } from "./types";

afterEach(() => cleanup());

describe("receiptText", () => {
  it("names the agent a message was sent to", () => {
    expect(receiptText({ target: "agent", agentName: "Kraken Auth" })).toBe("→ Sent to Kraken Auth");
  });

  // ══ AN ORDINARY CONCIERGE ANSWER GETS NO RECEIPT AT ALL (founder, 2026-08-04) ═════════════════
  // This asserted `"→ Answered here"`. He asked for that line gone: the concierge answering IN PLACE
  // is self-evident from the reply appearing directly beneath, so the receipt restated it on every
  // turn of the app's most-used path. NULL rather than "", so the caller drops the row instead of
  // laying out a blank one that still spends its margin.
  it("says nothing at all when the concierge answered in place", () => {
    expect(receiptText({ target: "sparkle" })).toBeNull();
  });

  it("falls back to a generic noun when the agent has no name", () => {
    expect(receiptText({ target: "agent" })).toBe("→ Sent to the agent");
  });

  // SPLIT INTO TWO ROWS (roborev 58076), because the two arms now pin OPPOSITE contracts and one
  // title cannot be true of both: an agent-first redirect states both destinations in order, a
  // sparkle-first one states exactly one and no order. A single row titled "states BOTH destinations"
  // answered "is the both-destinations rule still pinned?" with a yes that was only half true.
  it("states BOTH destinations in order when an agent-bound message is redirected into chat", () => {
    expect(receiptText({ target: "agent", agentName: "Kraken Auth", alsoSentTo: "sparkle" })).toBe(
      "→ Sent to Kraken Auth, then to here",
    );
  });

  it("states ONLY the agent delivery when a chat answer is redirected into an agent", () => {
    // The sparkle half goes too (founder, unqualified). Only the delivery the reader cannot see is
    // stated — the concierge's own reply is already on screen — and with no first term there is no
    // "then" to write: a bare "then to X" would read as a correction of a delivery this line no
    // longer mentions, which is the retraction the module header forbids.
    expect(receiptText({ target: "sparkle", agentName: "Kraken Auth", alsoSentTo: "agent" })).toBe(
      "→ Sent to Kraken Auth",
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


describe("RoutingReceipt — rendering", () => {
  // THE "Also ask" BUTTON IS GONE (founder: *"you can just take that out completely"*). Asserted as
  // an ABSENCE on the receipt that would previously have shown it, rather than by deleting these
  // cases: a suite with no case here could not tell "removed on purpose" from "quietly regressed",
  // and this affordance has been asked about twice.
  it("renders no button even on a redirectable receipt — the affordance was removed", () => {
    const onRedirect = vi.fn();
    render(
      <RoutingReceipt
        receipt={{ target: "agent", agentName: "Kraken Auth", redirectable: true }}
        onRedirect={onRedirect}
      />,
    );
    expect(screen.getByTestId("routing-receipt").textContent).toContain("Kraken Auth");
    expect(screen.queryByTestId("routing-redirect")).toBeNull();
    expect(onRedirect).not.toHaveBeenCalled();
  });

  // The LINE still earns its place: it names a delivery the reader cannot see.
  it("still states an agent delivery", () => {
    render(
      <RoutingReceipt receipt={{ target: "agent", agentName: "Kraken Auth" }} onRedirect={vi.fn()} />,
    );
    expect(screen.getByTestId("routing-receipt").textContent).toContain("Kraken Auth");
  });

  // …and a sparkle-answered message has NO receipt element at all now — not an empty strip. That
  // space belongs to the per-message status (./MessageStatus).
  it("renders nothing at all for a message Sparkle answered itself", () => {
    render(<RoutingReceipt receipt={{ target: "sparkle", redirectable: true }} onRedirect={vi.fn()} />);
    expect(screen.queryByTestId("routing-receipt")).toBeNull();
  });
});

// THE DELETED "NEVER ANSWERED" LINE — pinned absent so it cannot come back.
//
// `unanswered` marks a turn the user's NEXT message displaced mid-flight, and it exists because
// displacement happened at scale: 149 of 378 turns on 2026-07-29. That is the history behind the
// FLAG. It is not a justification for the LINE the flag used to render. A displaced turn is
// frequently answered anyway a couple of messages later — the follow-up carries enough of the
// earlier question that the brain addresses both — so "never answered" was an assertion the app has
// no way to know, printed flatly on turns that had in fact been served. It was deleted on
// 2026-07-31 for that reason (the founder's call), NOT reworded: there is no honest short phrasing
// of a fact nobody has.
//
// Each absence assertion below is PAIRED with the exact ordinary line the receipt now shows. An
// absence alone would pass against a receiptText that returned "" or threw, which would prove
// nothing (AGENTS.md, "Tests must assert the SIDE EFFECT").
describe("receiptText — a displaced turn renders the ordinary receipt, never 'never answered'", () => {
  it("does not print the deleted claim, and prints the ordinary sparkle line instead", () => {
    // Same removal as above: the ordinary sparkle line is now NO line. The point of this row is
    // unchanged — a displaced turn must not print the deleted "never answered" claim — and it is
    // strictly better served by there being no text at all than by text that merely omits it.
    expect(receiptText({ target: "sparkle", unanswered: true })).toBeNull();
  });

  it("renders the agent's ordinary line when a displaced message went to an agent", () => {
    const line = receiptText({ target: "agent", agentName: "Kraken Auth", unanswered: true });
    expect(line).not.toMatch(/never answered/i);
    expect(line).not.toMatch(/replaced by your next message/i);
    expect(line).toBe("→ Sent to Kraken Auth");
  });

  // The flag is now inert as far as the wording goes: setting it changes nothing the user reads.
  it("reads identically with and without the flag", () => {
    expect(receiptText({ target: "sparkle", unanswered: true })).toBe(
      receiptText({ target: "sparkle" }),
    );
    expect(receiptText({ target: "agent", agentName: "Kraken Auth", unanswered: true })).toBe(
      receiptText({ target: "agent", agentName: "Kraken Auth" }),
    );
  });

  // Rendering-level guard: the deleted string must not reach the DOM by any other route either.
  // The element is not rendered AT ALL now: no text to say and, with no `onRedirect`, no button to
  // offer. `queryByTestId` rather than `getByTestId`, and its absence is the stronger form of the
  // original assertion — "never answered" cannot appear in a row that does not exist.
  // The row still MOUNTS — it hosts the redirect button — but it now carries no sentence, so the
  // deleted claim cannot appear in it. Asserting the text is EMPTY is the stronger form of the
  // original "does not contain 'never answered'".
  // STRONGER THAN IT WAS: this asserted an EMPTY receipt element, because the row stayed mounted to
  // host the redirect button. With that button deleted there is nothing left to host, so the element
  // is absent entirely — no empty strip above the per-message status.
  it("renders no receipt at all for a displaced concierge turn", () => {
    render(<RoutingReceipt receipt={{ target: "sparkle", unanswered: true }} />);
    expect(screen.queryByTestId("routing-receipt")).toBeNull();
  });

  // The no-retraction rule the rest of this file is tripwired against still applies: the message
  // WAS delivered — the brain read it and was working on it — so nothing here may imply it wasn't.
  it("never implies the message itself was retracted", () => {
    // `?? ""` because the ordinary concierge line is now null — and null trivially satisfies the
    // no-retraction rule, which is what this row is guarding.
    expect(receiptText({ target: "sparkle", unanswered: true }) ?? "").not.toMatch(
      /instead|moved|undone|unsent|cancell?ed|not sent/i,
    );
  });
});

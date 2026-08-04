// ONE set of words for the Level 2 inbox, shared by every surface that renders it.
//
// The agent ROW's badge and the MOUNTED THREAD's queued bubbles describe the same three facts, and
// they are read within seconds of each other by someone checking whether a message really went. Two
// copies of this vocabulary drift — that is what AGENTS.md means by "user-facing copy is code, audit
// it when behavior changes" — and a row that says "delivered" beside a thread that says "sent" is a
// second, smaller version of the trust problem this whole change exists to fix.
//
// THE WORDS ARE CHOSEN TO BE HONEST ABOUT WHAT IS OBSERVED, which is the through-line of the defect
// class this belongs to (sparkle-b3coh, sparkle-bhhu1, sparkle-bbghz: reporting success that was not
// observed). Each string below names evidence the app actually holds:
//   • pending      — the record is in the queue and no claim file exists. Nothing has been shown to
//                    anyone. It says "delivers at the next turn" because that is the design, and it
//                    is the sentence that resolves "you said you sent it and I see nothing".
//   • delivered    — a claim file exists, so a delivery path took the text. It does NOT say the agent
//                    read it, acted on it, or even noticed: "waiting for the agent to confirm" is the
//                    open question, stated as open.
//   • acknowledged — the agent appended an ack line. That is written confirmation and nothing more;
//                    whether it ACTED is not observable and no string here pretends otherwise (see
//                    inbox.rs's header on why there is no fourth state).
import type { DeliveryState } from "../services/conciergeTools/fleet";

/** The line shown under a queued message, in the thread and in the row's popover. */
export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  pending: "queued — delivers at the next turn",
  delivered: "delivered — waiting for the agent to confirm",
  acknowledged: "acknowledged by the agent",
};

/** The accessible name for a message at each stage. Spelled out rather than reusing the label above:
 *  a screen reader gets no dimming and no position in the thread, so it needs the sentence to carry
 *  what the visual register carries. */
export const DELIVERY_A11Y: Record<DeliveryState, string> = {
  pending: "Queued message, not yet delivered",
  delivered: "Delivered message, not yet acknowledged",
  acknowledged: "Message acknowledged by the agent",
};

/**
 * The row badge's tooltip.
 *
 * Says WHY a queued message has not arrived, because the alternative reading — the one the founder
 * reasonably reached — is that the concierge never sent it. An inbox message is deliberately
 * non-interrupting: it waits for a turn boundary rather than ending the work the agent is inside.
 */
export function pendingBadgeTitle(count: number): string {
  const n = `${count} message${count === 1 ? "" : "s"}`;
  return (
    `${n} queued for this agent by the concierge. Queued messages are delivered at the agent's ` +
    `next turn boundary rather than interrupting its current work — click to read them.`
  );
}

/** The badge's accessible name. Short, because a screen reader reads it inline with the row's name. */
export function pendingBadgeLabel(count: number): string {
  return `${count} queued message${count === 1 ? "" : "s"}`;
}

/** The heading over the queued block in the thread. Names the fact the thread cannot otherwise show:
 *  these are real, they are addressed to this agent, and they are not in the conversation yet. */
export const QUEUED_BLOCK_HEADING = "Queued for this agent — not in the conversation yet";

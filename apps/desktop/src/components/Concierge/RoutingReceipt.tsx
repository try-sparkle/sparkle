// The routing receipt: the one-line "→ where your message went" under a user bubble, plus the
// one-tap redirect (PRD/sparkle/concierge-auto-routing.md §3).
//
// WHY THIS EXISTS. The compose box used to make the user pick a target before sending. That was
// removed in favour of inference, and inference is only defensible because this line is here: a
// misroute the user can SEE and fix in one click is recoverable, a silent one is not. If this
// component is ever deleted, the target toggle has to come back with it.
//
// A REDIRECT RE-SENDS; IT NEVER RETRACTS. Text already written into a PTY cannot be pulled back,
// so nothing here may say "moved", "instead of", "undone", or anything else implying the first
// delivery didn't happen. Once redirected, the line states BOTH destinations in the order they
// happened. `receiptText` is pure and exported so that wording is pinned by tests rather than by
// good intentions.
import { C } from "../../theme/colors";
import type { ConciergeReceipt } from "./types";

/** How a destination reads in the receipt line. Sparkle's chat reply lands "here" — in the thread
 *  the user is already looking at — so naming it "Sparkle" would be oddly third-person. */
function place(target: ConciergeReceipt["target"], agentName?: string): string {
  if (target === "sparkle") return "here";
  return agentName ?? "the agent";
}

/** The receipt's sentence. Pure: the redirect wording is a correctness concern (see the header),
 *  so it is unit-tested directly rather than asserted through a rendered tree. */
export function receiptText(r: ConciergeReceipt): string {
  const first = r.target === "sparkle" ? "Answered here" : `Sent to ${place(r.target, r.agentName)}`;
  if (!r.alsoSentTo) return `→ ${first}`;
  // "then" — strictly sequential, so it cannot be read as a correction of the first delivery.
  return `→ ${first}, then to ${place(r.alsoSentTo, r.agentName)}`;
}

/** The redirect button's label: the destination it has NOT gone to yet. Null when there is
 *  nowhere else to send it (no build agent in view), so the button is omitted rather than
 *  offering a target that doesn't exist. */
export function redirectLabel(r: ConciergeReceipt): string | null {
  if (r.alsoSentTo) return null; // already sent both ways — nothing left to offer
  // "Also" — the button is the one place the user reads the promise BEFORE acting, so it must not
  // say "instead" when the first delivery stands. The same no-retraction rule receiptText is
  // tripwired against applies here, and this label used to break it.
  if (r.target === "sparkle") return r.agentName ? `Also ask ${r.agentName}` : null;
  return "Also ask Sparkle";
}

export function RoutingReceipt({
  receipt,
  onRedirect,
}: {
  receipt: ConciergeReceipt;
  onRedirect?: () => void;
}) {
  const label = redirectLabel(receipt);
  const showButton = !!onRedirect && !!label && receipt.redirectable;
  return (
    <div
      data-testid="routing-receipt"
      // NOT a live region. A region inserted into the DOM together with its text is generally not
      // announced — screen readers announce MUTATIONS to a region already in the accessibility
      // tree — so an aria-live here looked correct and announced nothing. The announcement comes
      // from one long-lived region mounted with the column (see ConciergeColumn's live region);
      // this line is plain visual text.
      style={{
        marginTop: 4,
        fontSize: 12,
        color: C.conciergeMuted,
        display: "flex",
        gap: 8,
        alignItems: "center",
        justifyContent: "flex-end",
        flexWrap: "wrap",
      }}
    >
      <span>{receiptText(receipt)}</span>
      {showButton && (
        <button
          type="button"
          data-testid="routing-redirect"
          onClick={onRedirect}
          style={{
            fontSize: 12,
            color: C.cream,
            background: "transparent",
            border: `1px solid color-mix(in srgb, ${C.muted} 35%, transparent)`,
            borderRadius: 6,
            padding: "2px 7px",
            cursor: "pointer",
          }}
        >
          {label}
        </button>
      )}
    </div>
  );
}

// The routing receipt: the one-line "→ where your message went" under a user bubble
// (PRD/sparkle/concierge-auto-routing.md §3).
//
// WHY THIS EXISTS. The compose box used to make the user pick a target before sending. That was
// removed in favour of inference, and this line is what keeps inference honest: a misroute the user
// can SEE is at least recoverable by hand, a silent one is not. If this component is ever deleted,
// the target toggle has to come back with it.
//
// THE ONE-TAP REDIRECT IS GONE (founder, 2026-08-04), and the header used to promise it: "a
// misroute the user can see and fix in ONE CLICK". It no longer can — the "Also ask" pill was
// removed and nothing replaced its function, so seeing the misroute and re-sending by hand is the
// whole of the recovery story now. Stated plainly here because the sentence it replaces was the
// stated justification for removing the target toggle, and a future agent reading it would conclude
// a safety net exists that does not.
//
// A REDIRECT RE-SENDS; IT NEVER RETRACTS. `alsoSentTo` receipts still exist on rehydrated threads
// and on anything a future re-surfacing produces, so the rule stands: nothing here may say "moved",
// "instead of", "undone", or anything else implying the first delivery didn't happen. The line
// states every delivery the reader CANNOT otherwise see — both, in order, for an agent-first
// redirect; only the agent for a sparkle-first one, where the first delivery is the reply already
// on screen. `receiptText` is pure and exported so that wording is pinned by tests rather than by
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
export function receiptText(r: ConciergeReceipt): string | null {
  // `r.unanswered` IS DELIBERATELY NOT READ HERE. A displaced turn used to render "→ Replaced by
  // your next message — never answered", and that line was deleted on 2026-07-31 because it
  // asserted something the app cannot know: the concierge frequently answers a displaced question
  // a couple of messages later, so the receipt was calling a turn dead that had in fact been
  // served. An unknowable claim stated flatly is worse than no claim, so the flag stays RECORDED
  // (types.ts ConciergeReceipt.unanswered) and unrendered — see that field's doc comment.
  //
  // `refused` IS READ, and the contrast is the point rather than an inconsistency: whether a
  // message was ACCEPTED is something the app observed at the moment it tried to hand it over.
  // Whether a turn was ever answered is not — the answer may arrive two messages later, which is
  // exactly why the line above went.
  //
  // A REFUSED MESSAGE WENT NOWHERE, so it must not borrow either destination's wording. Checked
  // BEFORE the target line below, because the target field still names who it was FOR, and
  // rendering that name through "Answered here" / "Sent to X" would report a delivery that did not
  // happen (roborev 57360). Names the agent when there is one, because "not sent" without a subject
  // leaves the reader guessing which of their agents declined.
  if (r.refused) {
    return r.agentName ? `→ Not sent — ${r.agentName} couldn't take it` : "→ Not sent";
  }
  // ══ "Answered here" IS GONE (founder, 2026-08-04) ═══════════════════════════════════════════════
  // *"Get rid of the 'Answered here' text below each concierge sent message."* The concierge
  // answering IN PLACE is self-evident from the reply appearing directly underneath — the line
  // restated it on every single turn, which is noise on the app's most-used path.
  //
  // A receipt earns its place by saying something the surrounding UI does NOT: that the message went
  // somewhere ELSE (`Sent to X`), that it went nowhere (`Not sent`, above), or that it went to a
  // second destination after the first. The default concierge turn is none of those.
  //
  // NULL, not an empty string, so the caller can TELL THE TWO APART. It does not currently use that
  // to drop the row — the row stays mounted as the redirect's host, see the component below — and
  // this comment previously claimed it did, which was simply false about the code beneath it.
  // The distinction still earns its place: `null` is "there is nothing to say", which the component
  // renders as no `<span>` at all rather than an empty one, and which a caller (the screen-reader
  // announcement in ConciergeHost) tests directly to decide whether to announce anything.
  if (r.target === "sparkle" && !r.alsoSentTo) return null;
  // THE TWO-DELIVERY SPARKLE CASE LOSES IT TOO (founder, 2026-08-04). The previous cut kept
  // "Answered here" on this arm, reasoning that with two destinations the ORDER is the whole
  // content of the sentence. His instruction was unqualified — the phrase goes — and the reasoning
  // does not survive contact with it anyway: the "first delivery" here is the concierge answering
  // in the thread, which is exactly the self-evident fact the removal was about. Stating only the
  // delivery the reader CANNOT see is the entire sentence.
  //
  // No "then", deliberately: with no first term it would read as a correction of a delivery this
  // line no longer mentions — the retraction this module's header forbids.
  if (r.target === "sparkle") return `→ Sent to ${place(r.alsoSentTo!, r.agentName)}`;
  const first = `Sent to ${place(r.target, r.agentName)}`;
  if (!r.alsoSentTo) return `→ ${first}`;
  // "then" — strictly sequential, so it cannot be read as a correction of the first delivery.
  //
  // Only the AGENT-first arm reaches here now, and it keeps its sequence: both halves are
  // deliveries the reader cannot otherwise see, so the order is real content.
  return `→ ${first}, then to ${place(r.alsoSentTo, r.agentName)}`;
}

// THE "Also ask" AFFORDANCE IS DELETED (founder, 2026-08-04): *"the pill that says 'Also ask' — you
// can just take that out completely. What we're talking about would REPLACE that."* The strip
// beneath a message carries the per-message status now (./MessageStatus), which is the replacement.
//
// `redirectLabel` went with it. `onRedirect` remains on the props so callers need not change in
// lockstep, but NOTHING IN THE UI CALLS IT any more — the host-side redirect path is unreachable as
// of this change and should be removed rather than left as a dead branch (tracked as a bead).

export function RoutingReceipt({
  receipt,
}: {
  receipt: ConciergeReceipt;
  /** RETAINED ON THE TYPE, NOT DESTRUCTURED. Every caller still passes it (ConciergeMessageRow →
   *  ConciergeThread → ConciergeColumn), so removing it from the props would be a four-file change
   *  for a prop that is about to be deleted outright with the host-side redirect (sparkle-s15al).
   *  Binding it here would be an unused-var lint error, which is what it was after the button went. */
  onRedirect?: () => void;
}) {
  const text = receiptText(receipt);
  // NOTHING TO SAY, NOTHING DRAWN. The row used to stay mounted with no text because it hosted the
  // redirect button; with that gone there is nothing left to host, so an empty receipt would be an
  // empty strip — and that strip belongs to the per-message status.
  if (!text) return null;
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
      <span>{text}</span>
    </div>
  );
}

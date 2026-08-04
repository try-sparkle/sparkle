// ONE PLACE THAT KNOWS WHAT BELONGS TO A HUMAN RATHER THAN TO THE PROCESS.
//
// This exists because the same bug shipped twice, and the second instance was strictly worse than
// the first (roborev 55406, then 55559). Both concierge stores had written themselves a contract —
// `clearConciergeAudit` says "the identity reset (a different human should not inherit this one's
// record)", `clearConciergeApprovals` says "Tests, and the identity reset" — and both had ZERO
// production callers. `handleSignOut` reset `useAuthStore` and `useCloudAuthStore` and stopped.
//
// The shape of the mistake is what matters, because it will recur otherwise: a store is written with
// an identity-reset function, nothing is wired to call it, and it stays harmless only until something
// gains a reader or a replay path. The audit log gained a reader (the audit pane) and became a
// history leak. The approvals ledger already had BOTH:
//
//   • it retains up to MAX_RETAINED_APPROVALS resolved entries holding `rawArgs` — the model's
//     arguments VERBATIM, not the display-safe redaction the audit log keeps — so its residue is
//     more sensitive than the one that prompted the first fix, and
//   • its live entries are actionable, not merely readable. A PENDING card from the previous human
//     stays in the approval column for the next one to answer, and an approved-but-unspent grant
//     survives the identity change, so a dispatch can spend permission a different person gave.
//
// AND THERE WAS A THIRD, which the first version of this module missed while claiming to be "one
// place that knows what belongs to a human" (roborev 55593). The event log holds
// `approval_requested`/`approval_resolved` rows carrying `domain`, `op` and `outcome` — an index of
// what the previous human was asked and how they answered — and the concierge drains it over
// `sparkle_events`, so it had the reader too. It is cleared here now, epoch included: without a fresh
// epoch a cursor from the previous session would silently re-base against the new empty log instead of
// being refused as `log-restarted`.
//
// AND THEN A FOURTH, WHICH WAS THE BIGGEST ONE (roborev 55625). Each round of this has ended with a
// header claiming the set was now complete, so the useful thing to record is not the count but the
// SEARCH that finds them: grep for a store-level `clear…`/`reset…` export and check whether anything
// in `apps/desktop/src` outside its own module calls it. Every instance so far had zero callers and
// was found that way, never by reasoning about which stores "feel" per-human.
//
// The fourth was `conciergeThreadStore` — the VISIBLE conversation. It is worse than the three above
// on the axis that matters: they are process-lifetime memory, and it is `persist`ed to `localStorage`
// under a fixed, not-user-keyed name, so its residue survived quit and relaunch and was replayed into
// the column by the store's own `merge` hook. It also holds the rawest text in the feature — the
// human's own words, not a redaction of them.
//
// Its session is cleared with it, and that pairing is the point rather than two changes that happen
// to land together: the thread is what the next human SEES and `currentSessionId` is what the model
// REMEMBERS, and this codebase already argues the two must move as one ("a remembering brain with an
// empty column reads as amnesia"). Dropping only the column would leave the next human's first turn
// resuming the previous human's conversation with a blank screen in front of it — the same leak, now
// invisible.
//
// AND BOTH HALVES HAD TO LEARN THE SAME LESSON: clearing module state is not forgetting. The thread's
// durable copy is its `localStorage` payload; the session's is the on-disk Claude transcript that the
// boot probe re-reads at every launch. Each is dropped at its own layer — `persist.clearStorage()`
// there, a retired-session deny-list here — because a reset that only clears memory is undone by the
// next launch, which is the worst case rather than a lesser one: the column comes back EMPTY while
// the brain resumes (roborev 55774).
//
// So sign-out calls THIS, not a growing list of clears. A per-human concierge store added later is one
// line here, covered by `conciergeIdentityReset.test.ts` — which exists, because an earlier version of
// this comment promised a test that did not, and a false claim at the highest-authority location is
// the defect this line of work has spent itself correcting.
import { clearConciergeAudit } from "./conciergeAudit";
import { resetConciergeSession } from "./concierge";
import { clearConciergeApprovals } from "../stores/conciergeApprovals";
import { clearConciergeEventLog } from "../stores/conciergeEventLog";
import { clearConciergeThread } from "../stores/conciergeThreadStore";
import { clearConciergeReceiptBacklog, clearPostedReceiptIds } from "./conciergeReceipts";

/**
 * Drop every piece of concierge state that belongs to the human who is signing out.
 *
 * Called from `handleSignOut`. Deliberately NOT called on app quit (the process is going away) or on
 * a token refresh (same human): this is about an identity CHANGE on a live process, which is the only
 * moment one person's residue can reach another.
 */
export function resetConciergeIdentityState(): void {
  clearConciergeAudit();
  clearConciergeApprovals();
  clearConciergeEventLog();
  clearConciergeThread();
  // AND THE FIFTH (roborev 57888). The receipt REPLAY BUFFER holds agent names, PR numbers, bead ids
  // and the tool's verbatim refusal text — an index of what the previous human's concierge did — and
  // its whole purpose is a replay path into the next subscriber's thread. A receipt never posted
  // (the unmounted-host case the replay exists for, and sign-out is a moment the host is likely
  // unmounted) would otherwise be delivered into the NEXT human's conversation on their first mount.
  // Found by exactly the grep this header describes, one commit after the buffer was added.
  clearConciergeReceiptBacklog();
  // Its companion: the ids of receipts already drawn. Not sensitive, and NOT a collision risk —
  // `nextReceiptId` counts on a process-lifetime counter no reset touches, so a post-sign-out id can
  // never equal a pre-sign-out one. They simply name receipts that no longer exist once the backlog
  // above is dropped, and keeping them is pointless residue.
  clearPostedReceiptIds();
  resetConciergeSession();
}

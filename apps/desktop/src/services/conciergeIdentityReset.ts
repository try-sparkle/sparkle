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
// So sign-out calls THIS, not a growing list of clears. A per-human concierge store added later is one
// line here, covered by `conciergeIdentityReset.test.ts` — which exists, because the first version of
// this comment promised a test that did not, and a false claim at the highest-authority location is
// the defect this branch has spent the day correcting.
import { clearConciergeAudit } from "./conciergeAudit";
import { clearConciergeApprovals } from "../stores/conciergeApprovals";
import { clearConciergeEventLog } from "../stores/conciergeEventLog";

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
}

// THE RECEIPT SETTLER — minting the durable record of one concierge action.
//
// ══ WHY IT IS ITS OWN MODULE ════════════════════════════════════════════════════════════════════
// It lived in `controlListener` beside the two settlers it mirrors, which read well until a SECOND
// call site appeared: `conciergeApprovalResume` runs an approved call outside `handleConciergeTool`
// and has to settle the same records (roborev 57852). Importing it from `controlListener` made that
// heavy module a transitive dependency of `ConciergeApprovals.tsx`, and every existing test that
// mocks `../services/controlListener` then failed to load with "No `settleConciergeReceipt` export
// is defined on the mock" — two suites, on a coupling that had nothing to do with either of them.
//
// Extracting it is the fix rather than widening those mocks: this is RECEIPT logic, not
// control-listener logic, and a shared helper that two callers need should not drag one caller's
// module into the other's tests.
import {
  classifyConciergeActionReceipt,
} from "./conciergeReceiptClassifier";
import { nextReceiptId, recordConciergeActionReceipt } from "./conciergeReceipts";

/**
 * THE RECEIPT SETTLER — the third thing that happens when a concierge call comes back.
 *
 * Shaped like `settleActivity` and `settleAudit` beside it, and for the same reason: this is the one
 * place a call is known to have happened AND known to be the concierge's. What it adds is DURABILITY
 * — the indicator's line is erased when the turn ends and the audit log lives in a panel nobody has
 * open, so neither survives to answer "you said you sent it; did you?" a minute later.
 *
 * FIRE-AND-FORGET, WITH ITS OWN GUARD. `recordConciergeActionReceipt` already swallows a listener's
 * failure, but that is the wrong half: the risk here is the CLASSIFIER — new code, reading untrusted
 * reply shapes, on the return path of a call that already succeeded. A receipt is a record of
 * something that ALREADY HAPPENED, so nothing about minting it may be able to un-happen it or reach
 * back into the reply the concierge is waiting on. Hence the try/catch around the whole thing rather
 * than trust in the classifier's own totality.
 */
export function settleConciergeReceipt(
  domain: string,
  op: string,
  args: unknown,
  ok: boolean,
  data: unknown,
  reason: string | undefined,
  code?: string,
  /** The user bubble this call belongs to, CAPTURED WHEN THE CALL STARTED — never read here.
   *
   *  Last and optional so the two existing positional call sites are unaffected, and so a caller
   *  that genuinely does not know the origin (an approval resumed from a click handler, long after
   *  the requesting turn ended) says so by omission. Omitted means the renderer marks no bubble;
   *  see `setConciergeTurnOrigin` in ./conciergeReceipts for why inferring it at settle time is
   *  wrong rather than merely imprecise. */
  originBubbleId?: string,
  /** Did this call carry the FOUNDER'S OWN WORDS into an agent — i.e. is it a relay rather than a
   *  brief the concierge composed? Judged by the caller at call ENTRY, for the same reason
   *  `originBubbleId` is captured there: at settle time the turn it would be compared against may
   *  already be the next one.
   *
   *  Like the origin, it is attached AFTER classification rather than threaded into the classifier —
   *  it is provenance, and the classifier reads reply shapes. Omitted means "no relay claim", which
   *  is the fail-closed answer per ConciergeActionReceipt.relayedFounderWords. */
  relayedFounderWords?: boolean,
): void {
  // ══ A DEFERRAL IS NOT A REFUSAL — DO NOT RECORD ONE ═══════════════════════════════════════════
  // roborev 57852 (High). `needs-approval` means the call is WAITING on the human, not that it was
  // declined. `merge_pr` is `mutates-main`, whose default decision is `ask`, so the feature's
  // flagship path hit this every time: the first dispatch minted a permanent
  // `{kind:"merged", ok:false, reason:"merge_pr needs your go-ahead."}`, the human then approved it,
  // the approval RAN the call through `resumeApprovedCall` → `dispatchConciergeTool` (bypassing this
  // seam entirely), and no success receipt was ever minted. Net: the PR merged and the durable
  // record said it was refused — a false negative on precisely the question this module exists to
  // answer. The registry's own needs-approval copy says so out loud: "approving it there runs it".
  //
  // So the pending state records NOTHING here, and `resumeApprovedCall` settles the real outcome.
  // Silence for a few seconds is honest; a recorded refusal of something about to happen is not.
  if (!ok && code === "needs-approval") return;
  try {
    const receipt = classifyConciergeActionReceipt({
      domain,
      op,
      args,
      ok,
      data,
      reason,
      id: nextReceiptId(),
      at: Date.now(),
    });
    // Attached AFTER classification, deliberately: provenance is not something the classifier reads
    // out of a reply shape, and threading it through that signature would invite exactly that.
    if (receipt) {
      recordConciergeActionReceipt({
        ...receipt,
        ...(originBubbleId ? { originBubbleId } : {}),
        // ONLY ON A `sent` RECEIPT. "This carried his words" is a statement about a message; on a
        // spawn or a merge it would be a field with no meaning that a later reader could still test.
        ...(relayedFounderWords && receipt.kind === "sent"
          ? { relayedFounderWords: true as const }
          : {}),
      });
    }
  } catch (err) {
    console.warn("[control] concierge receipt classification failed", domain, op, err);
  }
}

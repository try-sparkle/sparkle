// THE MISSING HALF OF THE APPROVAL ROUND-TRIP: approving a call RUNS it.
//
// ---------------------------------------------------------------------------------------------
// THE BUG THIS CLOSES.
//
// `stores/conciergeApprovals` gave the human a way to say yes, and `conciergeTools/policyBinding`
// gave the next turn a way to spend that yes. Nothing connected the two. Pressing Approve wrote an
// entry to a ledger and stopped, so from the human's side the card vanished (it is no longer
// `pending`) and NOTHING HAPPENED — which reads exactly like the click was swallowed.
//
// Actually running the approved call needed all three of these to line up, unprompted:
//
//   1. the human had to separately type "go ahead" into the concierge, because approving raised no
//      signal the brain could see — it is a headless `claude -p` child that only runs when spoken
//      to, so an approval landing while no turn is in flight is observed by nobody;
//   2. within {@link APPROVAL_GRANT_TTL_MS} (5 minutes), after which the grant lapses SILENTLY —
//      and the clock starts at the click, i.e. while the human is still waiting to see a result;
//   3. and the model had to reproduce every argument byte-identically, because a fresh call spends
//      an approval only by matching {@link approvalFingerprint}. Fine for `{projectId: "p1"}`.
//      Effectively impossible for a multi-paragraph `text:` brief — and the raw arguments were not
//      even retained, so there was nothing to replay them from.
//
// Miss any one and the approval expires unspent, with no error anywhere: the concierge goes on
// reporting that it is waiting for a go-ahead it has already been given.
//
// ---------------------------------------------------------------------------------------------
// WHAT REPLACES IT: the click dispatches the call itself, from the LEDGER's stored arguments.
//
// This is strictly NARROWER than what it replaces, which is worth being precise about because it
// moves execution nearer the human. Before, approving authorised a re-issue the MODEL composed;
// now it runs the exact call the human read, from `rawArgs`, once. The model gets no second
// opportunity to choose arguments.
//
// It also adds NO new authority path. The replay goes back through `configuredToolPolicy` under the
// SAME `toolCallId`, so `claimApproval`'s claim-by-id branch is what authorises it — the identical
// check a retry would have gone through. Every existing guarantee is untouched: single-use
// (`spent`), time-boxed, fail-closed on a denied/expired/unknown entry, and `approveApproval` is
// still only ever called by the button. Nothing here can approve anything; it can only spend an
// approval a human has already given.
//
// ---------------------------------------------------------------------------------------------
// WHY `app`-DOMAIN OPS ARE NOT REPLAYED.
//
// The legacy `sparkle-control` ops (policy's `app` domain — `set_config`, `quit_app`, …) are not
// registry dispatches: they have their own handlers in `controlListener`, keyed to a Rust-minted
// `reqId` belonging to a bridge round trip that has already returned by the time anyone clicks.
// There is no live call left to resume, so replaying one would mean inventing a second invocation
// path for ops that already have one. Those keep the previous behaviour — the grant is recorded and
// the next turn spends it — and {@link resumeApprovedCall} says so rather than failing quietly.
import {
  CONCIERGE_TOOL_DOMAINS,
  dispatchConciergeTool,
  type ConciergeToolCall,
  type ConciergeToolReply,
  type DispatchOptions,
} from "./conciergeTools/registry";
import { configuredToolPolicy } from "./conciergeTools/policyBinding";
import { settleConciergeReceipt } from "./conciergeReceiptSettle";
import { noteConciergeAuditCall } from "./conciergeAudit";
import type { ConciergeApproval } from "../stores/conciergeApprovals";

/**
 * What became of an approved call.
 *
 * `ran` carries the registry's own reply — including a refusal. A tool that was approved and then
 * declined by its OWN guards (an agent that vanished, a prompt on screen the message doesn't
 * answer) is a real outcome the human must see, not an error to swallow: they authorised something
 * and are owed the truth about whether it happened.
 */
export type ApprovalResumeOutcome =
  | { kind: "ran"; reply: ConciergeToolReply }
  /** The ledger would not authorise the replay — expired, already spent, or never approved. Not
   *  reachable from the button in normal use (it approves immediately before calling), so this
   *  means the grant lapsed between the two, and the human is told to ask again. */
  | { kind: "unauthorized" }
  /** An `app`-domain op — recorded, but resumed the old way. See the header. */
  | { kind: "not-replayable" };

/** The seam. Real implementations by default; tests pass fakes so this module can be exercised
 *  without standing up the whole tool registry. */
export interface ApprovalResumeDeps {
  dispatch: (call: ConciergeToolCall, opts: DispatchOptions) => Promise<ConciergeToolReply>;
  policy: DispatchOptions["policy"];
  /** Mint the action receipt for a call that ran here. INJECTED rather than imported at the call
   *  site so a test can assert the receipt WITHOUT standing up the classifier and the registry —
   *  and so "the approved call left no record" is an assertable fact rather than a hope. */
  settleReceipt: (
    domain: string,
    op: string,
    args: unknown,
    ok: boolean,
    data: unknown,
    reason: string | undefined,
    code?: string,
  ) => void;
  /** Open an AUDIT entry for the call, returning its settler. The audit pane is the surface whose
   *  own header says it exists to answer "why didn't it do the thing I asked for" — so repairing
   *  only the receipt would relocate the false negative here rather than remove it (roborev 57895). */
  noteAudit: (
    toolCallId: string,
    domain: string,
    op: string,
    args: unknown,
  ) => (reply: { ok: boolean; code?: string; message?: string }) => void;
}

const REAL_DEPS: ApprovalResumeDeps = {
  dispatch: dispatchConciergeTool,
  policy: configuredToolPolicy,
  settleReceipt: settleConciergeReceipt,
  noteAudit: noteConciergeAuditCall,
};

/** Can this entry's op actually be dispatched? Only the four registry domains can; see the header
 *  for why `app` cannot. */
export function isReplayable(entry: Pick<ConciergeApproval, "domain">): boolean {
  return (CONCIERGE_TOOL_DOMAINS as readonly string[]).includes(entry.domain);
}

/** Open the audit entry, tolerating a settler that throws. Returns a no-op settler on failure so
 *  the caller never has to branch — a broken audit sink must not be able to change what happened. */
function safeNoteAudit(
  deps: ApprovalResumeDeps,
  entry: ConciergeApproval,
): (reply: { ok: boolean; code?: string; message?: string }) => void {
  try {
    const settle = deps.noteAudit(entry.id, entry.domain, entry.op, entry.rawArgs);
    return (reply) => {
      try {
        settle(reply);
      } catch (err) {
        console.warn("conciergeApprovalResume: audit settle failed", err);
      }
    };
  } catch (err) {
    console.warn("conciergeApprovalResume: opening the audit entry failed", err);
    return () => {};
  }
}

/**
 * Run a call the human has just approved.
 *
 * PRECONDITION: `approveApproval(entry.id)` has already returned true. This function does NOT
 * approve anything — it dispatches, and the policy layer decides whether the ledger backs it. If
 * the grant is not spendable the dispatch comes back `needs-approval` and is reported as
 * `unauthorized` rather than being retried or escalated.
 *
 * TOTAL: never throws. It runs from a click handler, and an exception there would leave the human
 * having approved something with no idea whether it ran.
 */
export async function resumeApprovedCall(
  entry: ConciergeApproval,
  deps: ApprovalResumeDeps = REAL_DEPS,
): Promise<ApprovalResumeOutcome> {
  if (!isReplayable(entry)) return { kind: "not-replayable" };
  /** The reply, once the dispatch has committed. Held so the settlers can run OUTSIDE the try. */
  let ran: ConciergeToolReply;
  // Opened BEFORE the dispatch, exactly as `handleConciergeTool` does, so the entry records the
  // ATTEMPT and its `startedAt` is the moment the call actually began.
  const settleAudit = safeNoteAudit(deps, entry);
  try {
    const reply = await deps.dispatch(
      {
        domain: entry.domain,
        op: entry.op,
        // From the LEDGER, never from the model. This is the call the human read.
        args: entry.rawArgs,
        // The SAME id, so `claimApproval` authorises this by its claim-by-id branch — the approval
        // is spent on precisely the call it was given for.
        toolCallId: entry.id,
      },
      { policy: deps.policy },
    );
    // `needs-approval` coming back here means the grant lapsed between the click and the dispatch.
    // Report it as such: "it needs approval" would be nonsense to someone who just approved it.
    if (!reply.ok && reply.code === "needs-approval") return { kind: "unauthorized" };
    ran = reply;
  } catch {
    // dispatchConciergeTool is documented total, so this is belt-and-braces. Treat an impossible
    // throw as "we cannot say it ran", which is the safe direction to be wrong in.
    settleAudit({ ok: false, code: "internal-error", message: "the dispatch threw" });
    return { kind: "unauthorized" };
  }

  // ══ THE DURABLE RECORDS FOR A CALL THE HUMAN APPROVED ═══════════════════════════════════════
  // This dispatch BYPASSES `handleConciergeTool`, which is where every other concierge action
  // settles its records — so without this an approved call left no trace at all, while its earlier
  // ask-tier reply used to leave a permanent `ok: false`. For `merge_pr` (`mutates-main`, therefore
  // `ask` by default) that meant the flagship case ended with the PR merged and the record saying
  // it was refused (roborev 57852).
  //
  // BOTH records, not just the receipt (roborev 57895): `handleConciergeTool` settles the audit
  // entry too, and repairing one while leaving the other merely RELOCATES the false negative to
  // `ConciergeAuditPane` — the surface whose own header says it exists to answer "why didn't it do
  // the thing I asked for".
  //
  // OUTSIDE THE `try`, AND GUARDED SEPARATELY. Inside it, a throw from either settler would be
  // caught above and reported as `unauthorized`, which the column renders as "so nothing happened"
  // — a flat denial of a merge that DID happen, which is the exact false-negative class this work
  // exists to remove. It also violates the settler's own stated invariant: nothing about minting a
  // record may reach back into the outcome of the call it records.
  try {
    deps.settleReceipt(
      entry.domain,
      entry.op,
      entry.rawArgs,
      ran.ok,
      ran.ok ? ran.data : undefined,
      ran.ok ? undefined : ran.message,
      ran.ok ? undefined : ran.code,
    );
    settleAudit(
      ran.ok ? { ok: true } : { ok: false, code: ran.code, message: ran.message },
    );
  } catch (err) {
    console.warn("conciergeApprovalResume: settling the approved call's records failed", err);
  }
  return { kind: "ran", reply: ran };
}

/**
 * One sentence for the concierge column saying what the click actually did.
 *
 * Exists because the previous silence is what made the bug so hard to see: the card disappeared and
 * the thread said nothing, so "approved and ran" and "approved and quietly expired" looked
 * identical. Every branch below says which one happened.
 */
export function describeResumeOutcome(
  entry: Pick<ConciergeApproval, "domain" | "op">,
  outcome: ApprovalResumeOutcome,
): string {
  const call = `${entry.domain}.${entry.op}`;
  if (outcome.kind === "not-replayable") {
    return `Approved ${call}. Tell me to go ahead and I'll run it.`;
  }
  if (outcome.kind === "unauthorized") {
    return `Approved ${call}, but the approval had already lapsed by the time I went to run it, so nothing happened. Ask me again and I'll re-raise it.`;
  }
  if (outcome.reply.ok) return `Approved and ran ${call}.`;
  return `Approved ${call}, but it didn't run: ${outcome.reply.message}`;
}

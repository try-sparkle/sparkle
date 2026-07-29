// The APPROVALS domain — the concierge's read access to its OWN pending approval requests.
//
// THE PROBLEM THIS SOLVES. An `ask`-tier tool call mints an approval request into the human's
// Sparkle column and returns `needs-approval`. Until now the concierge could CREATE that request and
// then had no way to observe it: it could not see what was pending, could not tell whether the human
// had answered, and had to wait for the human to say "I approved it" in words. The human was acting
// as a message bus for a state the app already had. These ops end that.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS DOMAIN IS READ-ONLY, AND THAT IS A SAFETY PROPERTY, NOT AN OMISSION.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// There is deliberately NO `approve` op, and there must never be one. The whole point of the `ask`
// tier is that a human authorises a specific call; a tool that let the concierge approve its own
// request would make every `ask` tool self-serviceable and collapse the tier into `allow` — while
// still LOOKING gated, which is worse than not having the tier at all. `approveApproval` /
// `denyApproval` are exported by the store for the CONFIRMATION UI, which is driven by a human
// hand. They are not imported here, and `approvals.test.ts` asserts this module never imports them.
//
// `deny` is not offered either, for a smaller reason: it has no use the concierge can't get by
// simply not retrying, and offering only the negative half of a decision invites a model to "tidy
// up" requests the human hasn't looked at yet.
import {
  pendingApprovals,
  findApproval,
  type ConciergeApproval,
  type ApprovalOutcome,
  type ApprovalArgLine,
} from "../../stores/conciergeApprovals";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const APPROVALS_OPS = ["list_pending_approvals", "get_approval"] as const;

export type ApprovalsOp = (typeof APPROVALS_OPS)[number];

/** Every op here is `read-only` — see the header for why there is nothing else to classify. */
export type ApprovalsRisk = "read-only";

export const APPROVALS_RISK: Record<ApprovalsOp, ApprovalsRisk> = {
  list_pending_approvals: "read-only",
  get_approval: "read-only",
};

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export interface ApprovalsOk<T> {
  ok: true;
  op: ApprovalsOp;
  risk: ApprovalsRisk;
  data: T;
}

export interface ApprovalsRefusal {
  ok: false;
  op: ApprovalsOp;
  risk: ApprovalsRisk;
  reason: string;
  message: string;
}

export type ApprovalsResult<T> = ApprovalsOk<T> | ApprovalsRefusal;

function ok<T>(op: ApprovalsOp, data: T): ApprovalsOk<T> {
  return { ok: true, op, risk: APPROVALS_RISK[op], data };
}

function refuse(op: ApprovalsOp, reason: string, message: string): ApprovalsRefusal {
  return { ok: false, op, risk: APPROVALS_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

/**
 * One approval as the concierge sees it.
 *
 * `args` is the store's already-REDACTED, already-truncated `ApprovalArgLine[]` (see
 * `describeApprovalArgs`), never the raw argument object. That is the same rendering the human is
 * shown, which is the point: the concierge and the human are looking at the same description of the
 * same call, so "the thing you approved" cannot mean two things.
 */
export interface ApprovalView {
  id: string;
  domain: string;
  op: string;
  outcome: ApprovalOutcome;
  args: readonly ApprovalArgLine[];
  /** The catalog's one-line description of the tool, and the risk map's note — carried so the
   *  concierge can explain to the human WHAT it asked for without re-deriving the prose. */
  summary: string;
  riskNote: string;
  /** `concierge.tools.<op>` — the config key that would stop this tool asking in future. */
  configPath: string;
  requestedAt: number;
  /** When the human answered; null while pending. */
  resolvedAt: number | null;
  /** When this entry stops counting — the request window while pending, the grant window once
   *  approved. Lets the concierge say "this expires in 3 minutes" instead of discovering it did. */
  expiresAt: number;
  /** True once a dispatch has SPENT this approval. A spent grant is single-use, permanently — so
   *  `approved && spent` means "yes, and it has already been used", NOT "you may run it again". */
  spent: boolean;
  /** Convenience: still awaiting a human, and the window is open. Mirrors `pendingApprovals`. */
  awaitingHuman: boolean;
}

function viewOf(a: ConciergeApproval, now: number): ApprovalView {
  return {
    id: a.id,
    domain: a.domain,
    op: a.op,
    outcome: a.outcome,
    args: a.args,
    summary: a.summary,
    riskNote: a.riskNote,
    configPath: a.configPath,
    requestedAt: a.requestedAt,
    resolvedAt: a.resolvedAt,
    expiresAt: a.expiresAt,
    spent: a.spent,
    awaitingHuman: a.outcome === "pending" && !a.spent && a.expiresAt > now,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/**
 * Everything waiting on the human right now.
 *
 * The clock is explicit because the store expires requests by TTL rather than on a timer — so a
 * request whose window closed between the mint and this read is reported as gone, not as pending.
 * `pendingApprovals` takes the LEDGER first and the clock second; it is left to default to the live
 * store so this stays a read of what the human is actually looking at.
 */
export function listPendingApprovals(now: number = Date.now()): ApprovalsResult<ApprovalView[]> {
  return ok(
    "list_pending_approvals",
    pendingApprovals(undefined, now).map((a) => viewOf(a, now)),
  );
}

/**
 * One approval by id, INCLUDING resolved ones — this is the op that answers "did they say yes?".
 *
 * Retained requests are capped (`MAX_RETAINED_APPROVALS`), so an id can legitimately fall out of the
 * store. That is reported as its own refusal rather than an empty success, because "I can't find it"
 * and "it wasn't approved" must not read the same to a model deciding whether to retry.
 */
export function getApproval(id: string, now: number = Date.now()): ApprovalsResult<ApprovalView> {
  const found = findApproval(id);
  if (!found) {
    return refuse(
      "get_approval",
      "unknown-approval",
      `I don't have an approval with id ${id} — it may have been answered long enough ago to age ` +
        `out of the retained set.`,
    );
  }
  return ok("get_approval", viewOf(found, now));
}

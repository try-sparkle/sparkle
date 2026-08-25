// The DISPATCH MEMORY domain — "what have we already sent an agent to do about X?"
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS: the concierge answered a question about work it had itself started.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// On 2026-08-22 the founder asked the concierge about making preview cards inline in chat. It
// answered as if it had never heard of the work and dispatched fresh research — EIGHT MINUTES after
// it had itself spawned an agent ("Sparkle Preview Card Inline") to do exactly that. Nothing
// durable recorded the ACT of delegating, so the only trace was the concierge's own context window,
// and when that rolled the delegation vanished while the agent it created kept running.
//
// services/dispatchLedger.ts fixed the WRITE half (a durable row per delegation, written at the
// spawn sites so the model cannot forget to call it) and services/dispatchRecall.ts fixed the READ
// half. This module is the third piece and the only one the model can see: without a TOOL, the
// ledger is a database nobody queries and the incident repeats with a fuller history.db.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A DOMAIN OF ITS OWN RATHER THAN AN OP ON `memory`.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `memory` is four ops (`remember`/`recall`/`forget`/`list_memories`) over a KEY-VALUE store the
// concierge writes by choosing to. This is one op, read-only, over a different substrate (the FTS5
// dispatch rows in history.db), returning a different shape (a list of delegations joined to LIVE
// agent state), which NOTHING can write through and which accumulates whether the model
// participates or not. dispatchLedger.ts's header records the measured reasons the two stores are
// not one store — `shapeMemories` slices alphabetically at 25 and clips each value to 300 chars, so
// a growing list of delegations would spend most of its life invisible.
//
// Folding it into `memory` would also make the settings pane lie: a human reading "Durable memory"
// would be granting or refusing two unrelated capabilities under one heading. The pane groups by
// domain, so the domain IS the unit of consent.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SEAM, AND WHY IT IS THE LOW-LEVEL ONE.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `recallDispatchesOp` takes `RecallDeps` — dispatchRecall's OWN seam — rather than a
// `{ recall }` façade of its own. A façade would let a test fake the whole read and still pass
// while the real path was broken, which is exactly AGENTS.md's "defaulted seam" trap: the one line
// that matters (the tool's arguments reaching the real matcher, the real `includeClosed` default,
// the real live join) would be covered by nothing. With the low-level seam a test seeds ledger ROW
// TEXT and gets back what the founder would get back.
import {
  recallDispatches,
  LIVE_RECALL_DEPS,
  type RecallDeps,
  type RecallDispatchesArgs,
  type RecallDispatchesResult,
} from "../dispatchRecall";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

// NOTE ON THE OP NAME: every concierge op name must be GLOBALLY unique across domains — the policy
// layer keys `RISK_BY_TOOL`/`DOMAIN_BY_TOOL` by the bare op name, so a second domain reusing a name
// silently overwrites the first's classification. That is why `memory` ships `list_memories` rather
// than a bare `list` (`research` already owns `list`). `recall_dispatches` is checked against the
// whole catalog for the same reason — and it reads as a sentence to the model, which matters more
// here than anywhere: this op is only useful if the model reaches for it UNPROMPTED.
export const DISPATCH_MEMORY_OPS = ["recall_dispatches"] as const;

export type DispatchMemoryOp = (typeof DISPATCH_MEMORY_OPS)[number];

/** One word, from the SAME vocabulary `workspace` publishes, so policy.ts reuses that translation
 *  rather than declaring a table identical to it. Searching the ledger changes nothing and starts
 *  nothing, so it is `read-only` — which derives to `allow`, and that is the point rather than an
 *  accident: an op the model has to get PERMISSION to call is an op it will skip, and skipping it
 *  reproduces the incident. */
export type DispatchMemoryRisk = "read-only";

export const DISPATCH_MEMORY_RISK: Record<DispatchMemoryOp, DispatchMemoryRisk> = {
  recall_dispatches: "read-only",
};

// ---------------------------------------------------------------------------------------------
// Results — the board/memory convention
// ---------------------------------------------------------------------------------------------

export interface DispatchMemoryOk<T> {
  ok: true;
  op: DispatchMemoryOp;
  risk: DispatchMemoryRisk;
  data: T;
}

export interface DispatchMemoryRefusal {
  ok: false;
  op: DispatchMemoryOp;
  risk: DispatchMemoryRisk;
  reason: string;
  message: string;
}

export type DispatchMemoryResult<T> = DispatchMemoryOk<T> | DispatchMemoryRefusal;

function ok<T>(op: DispatchMemoryOp, data: T): DispatchMemoryOk<T> {
  return { ok: true, op, risk: DISPATCH_MEMORY_RISK[op], data };
}

function refuse(op: DispatchMemoryOp, reason: string, message: string): DispatchMemoryRefusal {
  return { ok: false, op, risk: DISPATCH_MEMORY_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------------------------

/**
 * Recall delegations by SUBJECT.
 *
 * ── EVERY ARGUMENT IS FORWARDED VERBATIM, AND `includeClosed` ESPECIALLY ─────────────────────────
 * There is no `args.includeClosed ?? true` here, deliberately. `recallDispatches` already defaults
 * it to true and its header explains why ("did we ever do that work?" is the founder's most common
 * question, and a finished delegation is what answers it). Re-spelling the default at this layer
 * would be a second copy of a rule that has to hold, and the copy is the one that drifts — the class
 * of bug AGENTS.md names for re-implemented predicates. One default, in the file that documents it.
 *
 * ── THE REFUSAL ARM IS DEFENSIVE, NOT REACHABLE TODAY ────────────────────────────────────────────
 * `recallDispatches` is documented as never throwing: an unreadable ledger degrades to "I have no
 * record", which is at least true. This still catches, because a domain that can reject the turn is
 * worse than one that says it found nothing — and because "never throws" is a property of today's
 * implementation, not of the type.
 */
export async function recallDispatchesOp(
  args: RecallDispatchesArgs = {},
  deps: RecallDeps = LIVE_RECALL_DEPS,
): Promise<DispatchMemoryResult<RecallDispatchesResult>> {
  try {
    return ok("recall_dispatches", await recallDispatches(args, deps));
  } catch (e) {
    return refuse(
      "recall_dispatches",
      "recall-failed",
      `I couldn't read the record of what I've dispatched: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

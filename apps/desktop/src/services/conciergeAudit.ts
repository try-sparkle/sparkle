// THE CONCIERGE AUDIT LOG — "what did it just do?", answerable without reading a file on disk.
//
// The concierge can now spawn agents, file and delete work items, promote plans, push branches and
// merge PRs. The PRD's safety half is two things: a per-tool policy (services/conciergeTools/policy,
// which decides what may run) and THIS (which records what did). The policy answers "may it?"; this
// answers "did it, and what happened?" — and the second question is the one a human asks after the
// fact, when the answer has to come from a record rather than from watching.
//
// WHY IT IS NOT services/conciergeActivity. That module keeps exactly ONE entry, deliberately: it
// backs a single-line indicator in a 360px column, so a history there would be rendered one row at
// a time anyway. An audit log is the opposite shape — bounded history, oldest evictable, every call
// including the ones that never ran. Both are written from the same seam in controlListener, which
// is the one place every `concierge_tool` call passes through.
//
// THREE PROPERTIES, in the order they matter:
//
// 1. ATTEMPTS ARE RECORDED, NOT JUST SUCCESSES. A log that only shows what ran cannot answer "why
//    didn't it do the thing I asked?" — the interesting entries are precisely the refused ones: a
//    `denied` tool, an `ask`-tier call still waiting on the human, `bad-args`, `unknown-op`. Every
//    call is written when it STARTS, so a call that never settles (a crash, a reload mid-flight) is
//    still visible as `running` rather than vanishing.
//
// 2. ARGUMENTS ARE REDACTED BY THE SAME CODE THE APPROVAL CARD USES. `describeApprovalArgs` already
//    truncates and redacts into display-safe `key: value` lines, and it is what the human is shown
//    when they approve something. Reusing it means the log and the approval prompt describe a call
//    the SAME way — a second redactor would drift, and the drift would be silent because both look
//    plausible. It also means this module never holds raw model arguments.
//
// 3. BOUNDED, AND OLDEST-OUT. Kept in memory for the app run, capped like the approvals ledger. This
//    is a "what just happened" record, not a compliance archive; an unbounded list backing a UI list
//    is a leak, and persisting it would put redacted-but-still-sensitive prompts on disk without
//    anyone asking for that.
import { create } from "zustand";

import { describeApprovalArgs, type ApprovalArgLine } from "../stores/conciergeApprovals";

/** How many calls we keep. Sized to cover "what did it just do" across a few turns — the same order
 *  as the approvals ledger, and for the same reason: a bounded list is renderable, an unbounded one
 *  is a leak. */
export const MAX_AUDIT_ENTRIES = 200;

/** What became of a call. `running` is a real, persistent state, not a transient: a call that never
 *  settles (the app reloaded mid-flight, the handler threw past the recorder) STAYS running, and
 *  showing that honestly is better than implying it finished. */
export type AuditOutcome = "running" | "ok" | "refused";

export interface ConciergeAuditEntry {
  /** THE JOIN KEY, minted here — never the wire id.
   *
   *  The wire `toolCallId` looks like it should serve, but controlListener normalises a
   *  missing/non-string one to the EMPTY STRING and deliberately does not reject it (the registry's
   *  authority constructor is what refuses on a blank id, with the refusal that explains why). So
   *  every blank-id call would share the key `""`, and a settler would stamp the OLDEST such row —
   *  possibly one that already finished. Two blank-id calls could then swap outcomes: B's reply
   *  stamps A's row, A's reply re-stamps it, and B's row stays `running` forever. That is exactly
   *  the lie this record exists not to tell, and it is unfalsifiable afterwards. A local counter has
   *  no such failure mode (roborev 55160). */
  key: number;
  /** The wire `toolCallId`, for display and correlation with other logs. May be EMPTY — see `key`. */
  toolCallId: string;
  domain: string;
  op: string;
  /** Display-safe `key: value` lines. NOT the raw arguments — see property 2. */
  args: readonly ApprovalArgLine[];
  outcome: AuditOutcome;
  /** The refusal's machine-readable code, when it was refused (`denied`, `needs-approval`,
   *  `bad-args`, `unknown-op`, a domain's own reason…). Null while running or on success. */
  code: string | null;
  /** The sentence the concierge got back, when refused — so the log says WHY, not just that it
   *  failed. Null while running or on success. */
  message: string | null;
  startedAt: number;
  /** When the reply came back. Null while still running. */
  settledAt: number | null;
}

interface ConciergeAuditState {
  /** Newest LAST (append order), so a renderer reverses for newest-first. Kept in insertion order
   *  because "what did it just do" is read as a sequence, and eviction is from the front. */
  entries: readonly ConciergeAuditEntry[];
}

export const useConciergeAudit = create<ConciergeAuditState>(() => ({ entries: [] }));

function commit(entries: readonly ConciergeAuditEntry[]): void {
  useConciergeAudit.setState({ entries });
}

/**
 * Record that a call STARTED, and return the settler for its reply.
 *
 * Mirrors `noteConciergeToolCall`'s shape so both can be driven from the one dispatch seam without
 * the caller tracking two lifetimes. The settler is a no-op for an id that has since been evicted —
 * a very long-running call on a very busy session is not a reason to resurrect a dropped row.
 *
 * `startedAt` is injectable so the ordering and the durations are testable without a clock.
 */
let nextKey = 1;

export function noteConciergeAuditCall(
  toolCallId: string,
  domain: string,
  op: string,
  args: unknown,
  startedAt: number = Date.now(),
): (reply: { ok: boolean; code?: string; message?: string }, settledAt?: number) => void {
  const key = nextKey++;
  const entry: ConciergeAuditEntry = {
    key,
    toolCallId,
    domain,
    op,
    args: describeApprovalArgs(args),
    outcome: "running",
    code: null,
    message: null,
    startedAt,
    settledAt: null,
  };
  // Append, then evict from the FRONT — oldest-out, so the newest call is never the one dropped.
  const next = [...useConciergeAudit.getState().entries, entry];
  commit(next.length > MAX_AUDIT_ENTRIES ? next.slice(next.length - MAX_AUDIT_ENTRIES) : next);

  return (reply, settledAt = Date.now()) => {
    const entries = useConciergeAudit.getState().entries;
    const i = entries.findIndex((e) => e.key === key);
    if (i < 0) return; // evicted while in flight — nothing to settle
    // Settle ONCE. A second settle for the same call would overwrite a recorded outcome with a later
    // one, and the only thing that can produce it is a bug — so ignoring it keeps the first (true)
    // reading rather than the last. Mirrors conciergeActivity's `outcome !== "running"` guard.
    if (entries[i]!.outcome !== "running") return;
    const updated: ConciergeAuditEntry = {
      ...entries[i]!,
      outcome: reply.ok ? "ok" : "refused",
      // Only a refusal carries these. A successful call has no code and no message to show, and
      // writing "" would render as an empty reason rather than as no reason.
      code: reply.ok ? null : (reply.code ?? null),
      message: reply.ok ? null : (reply.message ?? null),
      settledAt,
    };
    commit([...entries.slice(0, i), updated, ...entries.slice(i + 1)]);
  };
}

/**
 * Newest first, capped — the order a "what did it just do" surface reads in, as ONE implementation.
 *
 * PURE, over the array it is handed, because the pane is a React component (roborev 55406, 55545).
 * The pane used to re-derive `[...entries].reverse().slice(0, N)` itself, which meant a change to
 * this module's ordering contract — keeping entries newest-first so eviction can pop the tail — would
 * leave this helper's tests green while the pane silently rendered oldest-first. Calling
 * `recentConciergeAudit()` from the pane fixed the duplication but read the store imperatively, so
 * `entries` was an invisible `useMemo` dependency that `react-hooks/exhaustive-deps` correctly called
 * unnecessary. Taking the array as an argument makes the dependency real, and both callers still
 * share the one rule.
 */
export function newestFirstCapped(
  entries: readonly ConciergeAuditEntry[],
  limit: number,
): readonly ConciergeAuditEntry[] {
  return entries.slice(Math.max(0, entries.length - limit)).reverse();
}

/** The same rule against the live store, for a non-React caller. */
export function recentConciergeAudit(limit = 50): readonly ConciergeAuditEntry[] {
  return newestFirstCapped(useConciergeAudit.getState().entries, limit);
}

/** Test-only: reset the key counter too, so cases cannot see each other's keys. */
export function _resetConciergeAuditForTests(): void {
  nextKey = 1;
  commit([]);
}

/** Drop the log. Tests, and the identity reset (a different human should not inherit this one's
 *  record of what the concierge did for them). */
export function clearConciergeAudit(): void {
  commit([]);
}

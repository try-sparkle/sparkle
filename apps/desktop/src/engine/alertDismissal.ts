// Dismiss / re-enable the RED alarm on an agent row (spec:
// docs/superpowers/specs/2026-07-09-dismiss-alert-design.md).
//
// A row is RED purely because its status is waiting | approval | errored (isRedStatus). "Dismiss
// Alert" acknowledges that red WITHOUT resolving it: the row recolors to its non-alerting tone and
// drops out of the red zone, while its true status is untouched. Two requirements shape the design:
//   - Re-alert on new events: a *new/different* red episode must re-raise red even after a dismiss.
//   - Persist across restart: a dismissal survives relaunch (a still-red agent stays dismissed).
// A plain boolean can't tell "the alert I dismissed" from "a fresh problem", so each agent carries a
// small alert-EPISODE record: a monotonic `seq` of red episodes seen, the last red `lastRed`
// signature, and the `dismissedSeq` the user acknowledged. Dismiss iff (red now AND
// dismissedSeq === seq); any new episode bumps seq past dismissedSeq → re-alert.
//
// Everything here is PURE (no store, no React) so it unit-tests in isolation and composes with the
// other status-map transforms (withUnstartedWorkerAttention / withRedWorkerAttention) in the sidebar.
// The red predicate is `needsAttention` (engine/attention.ts) — the same waiting|approval|errored
// tier used by the badge/notifications — reused here instead of services/windowStatus.isRedStatus so
// this module stays free of that file's top-level Tauri import (keeps it pure + unit-testable).
import type { AgentTabStatus, AgentAlertRecord } from "../types";
import { needsAttention } from "./attention";

// The persisted record shape lives in ../types (next to AgentTab); re-exported here so callers can
// import the type alongside these helpers from the one engine module that operates on it.
export type { AgentAlertRecord };

/** The RED "needs-you" statuses. Mirrors agentOrdering.ts / attention.ts's red tier. */
export type RedStatus = "waiting" | "approval" | "errored";

/** Type-guard form of `needsAttention`, narrowing to the red union for signature/color math. */
function isRedStatus(status: AgentTabStatus | undefined): status is RedStatus {
  return needsAttention(status);
}

/** A never-seen agent's implicit record: no episodes, not dismissed. */
export const EMPTY_ALERT: AgentAlertRecord = { seq: 0, lastRed: null, dismissedSeq: null };

/** The red signature of a status: the red status itself, or null when non-red. */
function redSignature(status: AgentTabStatus | undefined): RedStatus | null {
  return isRedStatus(status) ? status : null;
}

/**
 * Advance one agent's record given its CURRENT (pre-dismissal) status. A change in the red signature
 * is an episode boundary: entering a new/different red (null→waiting, waiting→approval,
 * working→errored, or leave-then-re-enter red) bumps `seq`; leaving red only clears `lastRed`. A red
 * status merely persisting is a NO-OP and returns the SAME reference (so callers can skip the write).
 *
 * On startup `record.lastRed` is seeded from the persisted value, so a still-`waiting` agent does not
 * look like a fresh null→waiting transition and does not falsely re-alert (persist-across-restart).
 */
export function advanceAlertRecord(
  record: AgentAlertRecord | undefined,
  status: AgentTabStatus | undefined,
): AgentAlertRecord {
  const rec = record ?? EMPTY_ALERT;
  const sig = redSignature(status);
  if (sig === rec.lastRed) return rec; // no red-signature change → no-op (same ref)
  // Entered a NEW/different red episode → bump seq; leaving red just clears lastRed.
  const seq = sig !== null ? rec.seq + 1 : rec.seq;
  return { seq, lastRed: sig, dismissedSeq: rec.dismissedSeq };
}

/**
 * Is this agent's alarm currently DISMISSED (its red should be suppressed)? Only ever true when the
 * agent is actually red — a non-red agent has no alarm to suppress. Requires the dismissal to match
 * the current episode, so a newer episode (seq advanced past dismissedSeq) re-alerts.
 */
export function isAlertSuppressed(
  record: AgentAlertRecord | undefined,
  status: AgentTabStatus | undefined,
): boolean {
  if (!isRedStatus(status)) return false;
  return record != null && record.dismissedSeq != null && record.dismissedSeq === record.seq;
}

/** Dismiss: acknowledge the current episode. Pure — returns a new record. */
export function dismissedRecord(record: AgentAlertRecord | undefined): AgentAlertRecord {
  const rec = record ?? EMPTY_ALERT;
  return { ...rec, dismissedSeq: rec.seq };
}

/** Re-enable: clear the dismissal so the row goes red again immediately. Pure. */
export function reenabledRecord(record: AgentAlertRecord | undefined): AgentAlertRecord {
  const rec = record ?? EMPTY_ALERT;
  return { ...rec, dismissedSeq: null };
}

/**
 * The non-red status a suppressed red agent is treated as, for BOTH color and sort tier: waiting /
 * approval de-escalate to `idle` (Tier 1 "your move", muted gray); errored de-escalates to `stopped`
 * (Tier 3 dormant). This is "same tier as its real status, minus the alarm".
 */
export function deEscalatedStatus(status: RedStatus): AgentTabStatus {
  return status === "errored" ? "stopped" : "idle";
}

/** The alert-toggle button a row should show, from its TRUE (pre-dismissal) status + record:
 *  "dismiss" when red & not dismissed, "reenable" when red & dismissed, null when not red. */
export function alertControlKind(
  record: AgentAlertRecord | undefined,
  status: AgentTabStatus | undefined,
): "dismiss" | "reenable" | null {
  if (!isRedStatus(status)) return null;
  return isAlertSuppressed(record, status) ? "reenable" : "dismiss";
}

/**
 * Overlay dismissals onto a status map: every agent whose alarm is suppressed (`isAlertSuppressed`)
 * has its red status replaced with the de-escalated equivalent, so the single status map that drives
 * BOTH row color and sort order shows the row calm and out of the red zone. Compose LAST, after the
 * worker-attention transforms. Returns the SAME reference when nothing is suppressed (no render
 * churn), matching the other transforms' no-op contract; never mutates the input.
 */
export function withDismissedAlerts<T extends { id: string; alert?: AgentAlertRecord }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  const ensure = (): Record<string, AgentTabStatus> => (out ??= { ...statusMap });
  for (const a of agents) {
    const st = statusMap[a.id];
    if (!isRedStatus(st)) continue;
    if (!isAlertSuppressed(a.alert, st)) continue;
    ensure()[a.id] = deEscalatedStatus(st);
  }
  return out ?? statusMap;
}

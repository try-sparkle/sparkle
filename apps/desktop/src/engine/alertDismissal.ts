// Dismiss / re-enable the RED alarm on an agent row (spec:
// docs/superpowers/specs/2026-07-09-dismiss-alert-design.md).
//
// A row is RED when services/windowStatus.isRedStatus says so (the color tier in
// packages/ui/tokens.ts); every red status is currently dismissible — see DISMISSIBLE below. "Dismiss
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
// The red predicate is the module-local `DISMISSIBLE` set below, NOT engine/attention.needsAttention.
// It used to delegate to that, which is what silently made `blocked` undismissable while the type said
// otherwise. It still doesn't reach for services/windowStatus.isRedStatus — not because that answers a
// different question (today it answers the same one) but to keep this module free of that file's
// top-level Tauri import, so it stays pure and unit-testable.
import type { AgentTabStatus, AgentAlertRecord } from "../types";

// The persisted record shape lives in ../types (next to AgentTab); re-exported here so callers can
// import the type alongside these helpers from the one engine module that operates on it.
export type { AgentAlertRecord };

/** The DISMISSIBLE red statuses.
 *
 *  This set currently COINCIDES with the red-COLOR tier (services/windowStatus.isRedStatus) and is
 *  deliberately NOT the narrower needs-you-now set (engine/attention.needsAttention). An earlier
 *  version of this docstring asserted the exact opposite, which is the belief that made the whole
 *  feature inert for `blocked`; if you are here to check whether `blocked` is dismissible, it is.
 *  Coinciding is not the same as being the same question, though — this one is "can the user
 *  acknowledge this red?", and it is answered from the union below, not by importing a predicate.
 *
 *  `blocked` IS here as of 2026-07-26. It was left out on the argument that it is "close to
 *  unreachable — statusEngine only sets it from the screen-scraper fallback, which statusRouter
 *  suppresses once hooks are live". That was wrong, and roborev caught it: services/improvementPass
 *  sets `blocked` PROGRAMMATICALLY on every failed or network-errored hourly pass, nowhere near the
 *  PTY/hook path, and it persists on the pinned Sparkle row until the next pass an hour later. A
 *  permanent red you cannot acknowledge is precisely the `unmerged` complaint that drove this whole
 *  taxonomy fix, so it gets the same remedy rather than an excuse. */
export type RedStatus = "waiting" | "approval" | "errored" | "blocked";

/** The dismissible set, spelled out over {@link RedStatus} rather than delegated to
 *  `attention.needsAttention`.
 *
 *  It used to be `return needsAttention(status)`, and when `blocked` was added to the union above
 *  that delegation silently made the whole feature inert for it: `needsAttention` is the narrower
 *  badge set, so every gate here — the Dismiss control, the episode recorder, the suppression check,
 *  the de-escalation overlay — went on rejecting `blocked` while the type claimed otherwise. Nothing
 *  failed; the feature just didn't exist (roborev on 15664dbeb). Deriving the predicate FROM the
 *  union is what stops the two drifting apart again.
 *
 *  Still Tauri-free (the reason this module doesn't import services/windowStatus.isRedStatus), and
 *  still deliberately NOT the same question as either of the other two red predicates — see the trap
 *  note in packages/ui/tokens.ts. This one is "can the user acknowledge this red?". */
//  KNOWN LIMIT, newly relevant for `blocked`: episodes key on the red KIND, not on which agent
//  caused it (see the note on advanceAlerts in AgentSidebar). A worker's red bubbles to its
//  orchestrator, so dismissing a bubbled `blocked` suppresses every LATER `blocked` bubble from any
//  other worker under that orchestrator until the parent's red kind changes — in a six-worker fleet,
//  one acknowledgement can hide five unrelated stalls from the top-level row. That limit predates
//  this and is accepted for waiting/errored; it is recorded here because `blocked` is the status most
//  likely to recur across different workers, so it is the one where it will actually bite.
const DISMISSIBLE: ReadonlySet<AgentTabStatus> = new Set<RedStatus>([
  "waiting",
  "approval",
  "errored",
  "blocked",
]);
function isRedStatus(status: AgentTabStatus | undefined): status is RedStatus {
  return status !== undefined && DISMISSIBLE.has(status);
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
 * approval / blocked de-escalate to `idle` (Tier 1 "your move", muted gray); errored de-escalates to
 * `stopped` (Tier 3 dormant). This is "same tier as its real status, minus the alarm".
 *
 * `blocked` → `idle` rather than `stopped`: a stalled agent still has a live process and is still
 * your move, it just stopped shouting about it. `stopped` would claim it isn't running.
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

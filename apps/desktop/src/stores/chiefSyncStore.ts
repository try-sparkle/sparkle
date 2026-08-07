// chiefSyncStore — the OBSERVABLE state of the Chief markdown sync, one record per Sparkle project.
//
// WHY THIS EXISTS. `runChiefSync` had six `return`s that all looked identical from outside the
// renderer: no PAT, no project, no agent with a worktree, already syncing, cooling down after a
// failure, and a null result. None of them logged, none of them set any state, and after
// SYNC_GIVE_UP_FAILS the retry loop dropped to a deliberately SILENT hourly re-probe (,
// which was right — the old per-run logging was the single largest log source at ~1.2k lines/day).
// The cost of that silence was that "is writing the markdown broken, or is sending it to Chief
// broken?" could not be answered from inside the app at all — the only way to find out was to query
// the Chief API by hand. This store is the answer to that question, kept as UI STATE rather than as
// logging so it costs nothing per run and cannot reintroduce the flood.
//
// It is deliberately NOT persisted. Every field is a statement about the CURRENT process — "a sync
// is running right now", "the last attempt failed for this reason" — and a stale one restored from
// disk at launch would assert things about a run that is not happening. `lastSuccessAt` is the one
// field a reader might want across launches, and it is precisely the one that would lie: the sync
// resets its backoff on relaunch (see chief-sync-backoff), so a restored timestamp would be read as
// "still healthy" when nothing had run yet. Absent beats wrong.

import { create } from "zustand";

/**
 * WHY the sync is not currently writing to Chief.
 *
 * One arm per distinguishable cause, because collapsing any two of them puts the reader back where
 * they started. In particular `no_pat` (nothing configured — expected on a fresh install) and
 * `project_gone` (configured, working, and then the linked library was deleted) both present as
 * "nothing is reaching Chief", and they need opposite responses from the user.
 */
export type ChiefSyncReason =
  /** No Chief API key in the keychain, settings, or the environment. Nothing has ever synced. */
  | "no_pat"
  /** No agent in this project has a worktree to read the markdown FROM (e.g. only shell agents). */
  | "no_worktree"
  /** The linked Chief project no longer exists. Needs a human: re-link or unlink. */
  | "project_gone"
  /** The library resolved to one ANOTHER Sparkle project already syncs into. Refused, not failed:
   *  sharing one is mutually destructive, so nothing was written. Needs a human to re-point. */
  | "library_claimed"
  /** The endpoint could not be reached, or refused the request. Transient; the backoff retries. */
  | "unreachable";

/**
 * The coarse state of one project's sync.
 *
 * `unknown` is the honest zero-state: the app has not attempted a sync for this project yet, which
 * is NOT the same as "healthy" and NOT the same as "broken". It exists so a freshly-launched app
 * does not claim either.
 */
export type ChiefSyncPhase = "unknown" | "syncing" | "ok" | "blocked";

export interface ChiefSyncRecord {
  phase: ChiefSyncPhase;
  /**
   * Why it is not syncing.
   *
   * Cleared by a SUCCESS, not by a start. A `syncing` record deliberately keeps the last known
   * reason until the run resolves: the poll re-enters this state constantly, and clearing it here
   * would flash a clean slate on every tick of a persistently broken sync. So `ok` implies null;
   * `syncing` does NOT. `describeChiefSync` never reads it in the `syncing` arm, which is what
   * keeps the retained value invisible rather than briefly contradictory.
   *
   * Do not "normalize" this to null on `syncing` — `reduceStart` preserving it is pinned behaviour
   * (chiefSyncStore.test.ts), and this comment previously claimed the opposite, which is exactly
   * the kind of second source of truth that invites the change and the breakage.
   */
  reason: ChiefSyncReason | null;
  /** Epoch ms of the last COMPLETED sync, or null if none has completed this session. */
  lastSuccessAt: number | null;
  /** Epoch ms of the last attempt, successful or not. */
  lastAttemptAt: number | null;
  /** Consecutive failures — the same count the backoff escalates on. */
  consecutiveFailures: number;
  /** WHICH Chief project this Sparkle project writes to. Surfacing this is how a split library
   *  (two Sparkle projects auto-creating two Chief projects by name) becomes visible at all. */
  chiefProjectId: string | null;
  /** Docs written / removed on the last completed sync. Both zero means "ran, nothing changed" —
   *  the state that is otherwise indistinguishable from "never ran". */
  lastUploaded: number;
  lastDeleted: number;
  /** The raw error text from the last failure, for a hover/detail line. Empty when healthy. */
  detail: string;
}

/** The zero-state. Exported so tests and the store share one definition of "nothing known yet". */
export const UNKNOWN_SYNC: ChiefSyncRecord = {
  phase: "unknown",
  reason: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  consecutiveFailures: 0,
  chiefProjectId: null,
  lastUploaded: 0,
  lastDeleted: 0,
  detail: "",
};

// --- Pure reducers -----------------------------------------------------------------------------
// `now` is injected so every rule is testable without faking timers, and each returns the SAME
// REFERENCE when nothing changed so a subscribed component does not re-render on a no-op poll.

/** A sync run has started. */
export function reduceStart(rec: ChiefSyncRecord, now: number): ChiefSyncRecord {
  return { ...rec, phase: "syncing", lastAttemptAt: now };
}

/**
 * A run finished successfully.
 *
 * Clears `reason` and the failure count: a completed round-trip is positive evidence that the PAT,
 * the endpoint, and the project link are all good, so no earlier reason can still be true.
 */
export function reduceSuccess(
  rec: ChiefSyncRecord,
  outcome: { chiefProjectId: string | null; uploaded: number; deleted: number },
  now: number,
): ChiefSyncRecord {
  return {
    ...rec,
    phase: "ok",
    reason: null,
    detail: "",
    consecutiveFailures: 0,
    lastSuccessAt: now,
    lastAttemptAt: now,
    chiefProjectId: outcome.chiefProjectId,
    lastUploaded: outcome.uploaded,
    lastDeleted: outcome.deleted,
  };
}

/**
 * A run could not proceed, or failed.
 *
 * `lastSuccessAt` deliberately SURVIVES — "blocked since 14:02, last succeeded 14:01" is the whole
 * reading, and a blocked state that also forgot when it last worked answers strictly less than the
 * silence it replaces.
 *
 * `consecutiveFailures` counts only genuine FAILURES. A precondition that was never met — no PAT,
 * no worktree — is not a failure of anything and must not escalate a backoff or read as an outage;
 * those arms hold the count where it is.
 */
export function reduceBlocked(
  rec: ChiefSyncRecord,
  reason: ChiefSyncReason,
  detail: string,
  now: number,
): ChiefSyncRecord {
  const counts = reason === "unreachable";
  const next: ChiefSyncRecord = {
    ...rec,
    phase: "blocked",
    reason,
    detail,
    lastAttemptAt: now,
    consecutiveFailures: counts ? rec.consecutiveFailures + 1 : rec.consecutiveFailures,
  };
  // No-op guard: an unchanged precondition (e.g. still no PAT) re-evaluated on every poll must not
  // churn the store. Compare everything the reducer could have moved except the attempt clock.
  if (
    rec.phase === next.phase &&
    rec.reason === next.reason &&
    rec.detail === next.detail &&
    rec.consecutiveFailures === next.consecutiveFailures
  ) {
    return rec;
  }
  return next;
}

// --- Reason copy -------------------------------------------------------------------------------

/**
 * One plain sentence per reason, written for someone who does not work on this app.
 *
 * Each one names the REMEDY, because a status that only says what is wrong sends the reader back to
 * asking. Note `project_gone` does not suggest "wait" — nothing about it is transient.
 */
export const CHIEF_SYNC_REASON_COPY: Record<ChiefSyncReason, string> = {
  no_pat: "No Chief API key, so nothing is being sent. Add one in Settings → Tools.",
  no_worktree: "No agent in this project has a worktree to read the docs from. Start a build agent.",
  project_gone:
    "The linked Chief project no longer exists. Re-link this project to an existing Chief " +
    "project, or unlink it to start a new library.",
  library_claimed:
    "Another project already syncs into this Chief library, and two projects sharing one would " +
    "delete each other's documents — so nothing was sent. Pick a different Chief library below.",
  unreachable: "Chief could not be reached, so docs are queued. Retrying automatically.",
};

/** The one-line status sentence for a project, or null when there is nothing worth saying. */
export function describeChiefSync(rec: ChiefSyncRecord): string | null {
  if (rec.phase === "unknown") return null;
  if (rec.phase === "syncing") return "Sending docs to Chief…";
  if (rec.phase === "blocked") return rec.reason ? CHIEF_SYNC_REASON_COPY[rec.reason] : null;
  // phase === "ok": distinguish "wrote something" from "ran, nothing to do" — the two states that
  // were previously identical (both silent) and that between them answer the founder's question.
  const changed = rec.lastUploaded + rec.lastDeleted;
  return changed === 0
    ? "Chief is up to date — nothing changed on the last check."
    : `Chief is up to date — last sync wrote ${rec.lastUploaded} and removed ${rec.lastDeleted}.`;
}

// --- Store -------------------------------------------------------------------------------------

interface ChiefSyncState {
  byProject: Record<string, ChiefSyncRecord>;
  noteStart: (projectId: string, now?: number) => void;
  noteSuccess: (
    projectId: string,
    outcome: { chiefProjectId: string | null; uploaded: number; deleted: number },
    now?: number,
  ) => void;
  noteBlocked: (
    projectId: string,
    reason: ChiefSyncReason,
    detail?: string,
    now?: number,
  ) => void;
}

/** Read one project's record, falling back to the shared zero-state. */
export function chiefSyncFor(state: { byProject: Record<string, ChiefSyncRecord> }, projectId: string): ChiefSyncRecord {
  return state.byProject[projectId] ?? UNKNOWN_SYNC;
}

function apply(
  set: (fn: (s: ChiefSyncState) => Partial<ChiefSyncState>) => void,
  projectId: string,
  fn: (rec: ChiefSyncRecord) => ChiefSyncRecord,
): void {
  set((s) => {
    const prev = s.byProject[projectId] ?? UNKNOWN_SYNC;
    const next = fn(prev);
    if (next === prev) return {}; // reducer said nothing changed — don't churn subscribers
    return { byProject: { ...s.byProject, [projectId]: next } };
  });
}

export const useChiefSyncStore = create<ChiefSyncState>()((set) => ({
  byProject: {},
  noteStart: (projectId, now = Date.now()) => apply(set, projectId, (r) => reduceStart(r, now)),
  noteSuccess: (projectId, outcome, now = Date.now()) =>
    apply(set, projectId, (r) => reduceSuccess(r, outcome, now)),
  noteBlocked: (projectId, reason, detail = "", now = Date.now()) =>
    apply(set, projectId, (r) => reduceBlocked(r, reason, detail, now)),
}));

/**
 * Forget what we know about a project's sync, returning it to the honest zero-state.
 *
 * Called when the user RE-LINKS or UNLINKS. Every field is a claim about a link that no longer
 * exists, and `project_gone` is the one that matters: the record is only ever rewritten by an
 * actual sync attempt, and a `project_gone` failure parks the backoff at the hourly re-probe — so
 * without this, the status line keeps asserting "The linked Chief project no longer exists" for up
 * to an hour AFTER the user performed the very fix this pane exists to offer. That reads as "the
 * re-link did nothing" and invites repeated clicking, which the no-op guard silently swallows.
 */
export function forgetChiefSync(projectId: string): void {
  useChiefSyncStore.setState((s) => {
    if (!(projectId in s.byProject)) return {};
    const { [projectId]: _dropped, ...rest } = s.byProject;
    return { byProject: rest };
  });
}

/** Test-only: drop every record. */
export function __resetChiefSyncStore(): void {
  useChiefSyncStore.setState({ byProject: {} });
}

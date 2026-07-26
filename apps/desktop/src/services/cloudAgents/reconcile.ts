// Pure re-attach reconciliation for cloud agents (Service B, W5). On desktop startup the app calls
// GET /sessions?project_id= and reconciles the server's live cloud sessions against the tabs it
// already has persisted. A cloud session keeps running while the laptop is closed (that's the whole
// point of Service B), so on reopen we must recreate a tab for any LIVE session that no longer has
// one — using runtime "cloud" so W4's CloudTransport re-attaches its stream (spec §"Re-attach").
//
// This is the pure decision half: given the existing tab ids and the server's session list, decide
// which sessions need a fresh tab. The IO half (fetch + addAgent) lives in the store/UI wiring; it
// is kept out of here so the dedup + liveness rules are exhaustively unit-testable.

/** The subset of an `agent_sessions` row the desktop needs to recreate a tab. The server list may
 *  carry more; we read only these. */
export interface CloudSessionSummary {
  /** = AgentTab.id for a cloud agent (server session id is the tab id — spec §Identity). */
  id: string;
  /** Server-side lifecycle status. Live: active | paused | waiting. Terminal: complete | error. */
  status: string;
  /** Optional display name the server stored at start (falls back to a default when absent). */
  name?: string | null;
  /** The session's goal (initial prompt), if the server returns it — used only for a nicer tab. */
  goal?: string | null;
}

/** Statuses that mean the sandbox/session is still alive and worth re-attaching to. `waiting`
 *  (e.g. out-of-credits / needs-you) is LIVE — it is paused-for-attention, not finished. */
// `pending` is included: POST /sessions/start inserts the row as pending and the runner flips it
// to active only after the sandbox spawn/clone — a restart inside that window (or a session the
// user should see erroring) must still get a tab back (roborev 46266).
export const LIVE_CLOUD_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "active",
  "paused",
  "waiting",
]);

/** True when a session status means the session is still alive (re-attachable). */
export function isLiveCloudStatus(status: string): boolean {
  return LIVE_CLOUD_STATUSES.has(status);
}

export interface ReconcileInput {
  /** Ids of ALL tabs already present in this project (any runtime) — the dedup set. A cloud
   *  session whose id already has a tab must never be recreated (it would double the row). */
  existingTabIds: Iterable<string>;
  /** The caller's sessions for this project, as returned by GET /sessions?project_id=. */
  sessions: readonly CloudSessionSummary[];
}

export interface ReconcileResult {
  /** Live sessions that have no tab yet — the desktop should addAgent one (runtime "cloud") for
   *  each, keyed by the session id. */
  toCreate: CloudSessionSummary[];
}

/**
 * Decide which live cloud sessions need a fresh tab. Dedups against `existingTabIds` and drops
 * terminal (complete/error) sessions. Deterministic and order-preserving (server order is kept),
 * and it de-duplicates the server list itself so a repeated session id is only created once.
 */
export function reconcileCloudSessions(input: ReconcileInput): ReconcileResult {
  const have = new Set(input.existingTabIds);
  const seen = new Set<string>();
  const toCreate: CloudSessionSummary[] = [];
  for (const s of input.sessions) {
    if (!s || typeof s.id !== "string" || s.id.length === 0) continue; // ignore malformed rows
    if (!isLiveCloudStatus(s.status)) continue; // terminal → don't resurrect a finished tab
    if (have.has(s.id) || seen.has(s.id)) continue; // already have a tab, or a dup in the list
    seen.add(s.id);
    toCreate.push(s);
  }
  return { toCreate };
}

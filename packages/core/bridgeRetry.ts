// ── Shared connect-phase retry policy for the Unix-socket bridge clients (sparkle-i95d) ──────────
//
// apps/mcp-control and apps/mcp-orchestrator each open the SAME JSON-lines Unix-socket bridge with a
// near-identical client. The connect-phase retry mechanism — the backoff schedule below and the set
// of transient "listener isn't there yet" error codes — is copy-pasted logic that ALREADY DRIFTED
// once: the sparkle-i95d fix landed on the orchestrator twin and was missing from the control twin
// for two weeks, leaving control's calls dropping across every app restart. Both twins now import
// the ONE definition here, so this logic cannot silently diverge again (bead sparkle-sngtc).
//
// What deliberately does NOT belong here, because the twins are SUPPOSED to differ on it: each
// client's DEFAULT_TIMEOUT_MS (control's cheap synchronous Rust reads want a tight 30 s; the
// orchestrator's long frontend round-trips like spawn_worker want ~660 s) and control's own
// response-timeout retry machinery (REQUEST_TIMEOUT_CODE / TIMEOUT_RETRYABLE_OPS). Those stay LOCAL
// to each client — do not hoist them here, or the guard this module exists to be becomes a source of
// false convergence.

/** Connect-retry backoff, in ms — ~2.25 s total across four attempts. Rides out the window in which
 *  the Rust listener is torn down and rebound across an app restart: a fresh connection either finds
 *  an ORPHANED socket file with no listener behind it (the app died without cleanup → ECONNREFUSED)
 *  or finds nothing at all (the file was removed and not yet rebound → ENOENT). ONLY connect-time
 *  errors are retried by the clients; nothing after a successful connect re-loops, since that could
 *  double-execute a non-idempotent op like spawn_worker. */
export const CONNECT_RETRY_DELAYS_MS: readonly number[] = [150, 300, 600, 1200];

/** Node error codes meaning "the listener isn't there YET" — a transient rebind window, safe to
 *  retry because no request byte has been written. ECONNREFUSED is the orphaned-socket-file case,
 *  ENOENT the removed-and-not-yet-rebound case. */
export const RETRYABLE_CONNECT_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOENT"]);

/** True when `e` is a connect-phase error whose code is in RETRYABLE_CONNECT_CODES — i.e. safe to
 *  retry. Pure (no I/O, no timers), so it lives here alongside the code set it reads rather than
 *  being re-derived identically in each client. */
export function isRetryableConnectError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    RETRYABLE_CONNECT_CODES.has((e as { code?: string }).code ?? "")
  );
}

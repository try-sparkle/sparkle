// Cloud (Deepgram) dictation orchestration. Metering is now SERVER-side: the desktop streams mic
// audio to the orchestration `/ai/deepgram` relay (see apps/orchestration/src/socket/deepgramRelay.ts),
// which holds Sparkle's Deepgram key, meters per elapsed minute at the server-authoritative rate, and
// streams transcripts + post-debit balance back down. So the old client-side per-minute debit is
// gone — this module only:
//   (a) orchestrates opening the relay stream for one active-dictation window (open first, then keep
//       it only if we're still active), and
//   (b) resolves the balance the relay reports (via the `dictation://cloud-balance` event) for the
//       credits pill.
// The relay itself enforces entitlement + first-minute affordability at handshake time (a refusal
// surfaces as start_cloud_stream → false, i.e. "stay on-device"), and signals out-of-credits
// mid-stream via the `dictation://cloud-ended` event (exhausted=true) so the caller falls back to
// on-device dictation.

/**
 * Resolve the balance to display after a relay debit: prefer the server's authoritative
 * `balanceAfterCents`, but fall back to an optimistic local decrement (current − debited) when the
 * relay omits it, so the on-screen balance still moves. Pure so the wiring can be unit-tested.
 */
export function nextBalanceCents(
  current: number,
  balanceAfterCents: number | null,
  debitedCents: number,
): number {
  return balanceAfterCents != null ? balanceAfterCents : current - debitedCents;
}

/** IO hooks for openCloudDictationWindow, injected so the billing-critical open sequence is testable. */
export interface CloudWindowDeps {
  /** invoke("start_cloud_stream"): resolves true iff the backend actually opened the relay socket
   *  (signed in, entitled, and could afford the first minute — the relay gates all three). */
  startCloudStream: () => Promise<boolean>;
  /** invoke("stop_cloud_stream"): close the relay socket (idempotent on the backend). */
  stopCloudStream: () => void;
  /** Re-check, after the async open, that we still want cloud (phase active + voice + composer on). */
  isStillActive: () => boolean;
  /** Clear the live interim preview. */
  clearInterim: () => void;
}

/**
 * Orchestrate one active-dictation cloud window: open the relay socket, then keep it only if we're
 * still active. Extracted from the hook so the sequence can be unit-tested:
 *   - open returned false (signed out / offline / not entitled / can't afford the first minute / a
 *     race discard) ⇒ stay on-device, nothing to close. NOTE: these refusals are intentionally
 *     indistinguishable here, so a can't-afford refusal does NOT eagerly refresh the credits pill.
 *     That's accepted: a genuinely out-of-credits user was already refreshed to ~0 by the prior
 *     session's mid-stream `exhausted` teardown, and any residual staleness self-heals on the next
 *     `/me` poll — not worth threading a richer refusal signal through Rust→JS for that edge.
 *   - a stop/mute/toggle raced the async open ⇒ close the socket and clear our own preview.
 *   - otherwise the relay stream is live; balance updates + exhaustion arrive via `dictation://` events
 *     (there is no client-side meter to start — the server meters).
 */
export async function openCloudDictationWindow(deps: CloudWindowDeps): Promise<void> {
  const opened = await deps.startCloudStream();
  if (!opened) return; // stayed on-device → no socket
  if (!deps.isStillActive()) {
    // A stop word / mute / toggle landed during the open → close, and clear our own preview so this
    // helper is self-contained (not reliant on the separate passive/toggle effects).
    deps.stopCloudStream();
    deps.clearInterim();
  }
}

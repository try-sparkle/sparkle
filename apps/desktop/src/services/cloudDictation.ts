// Cloud (Deepgram) dictation orchestration. Metering is now SERVER-side: the desktop streams mic
// audio to the orchestration `/ai/deepgram` relay (see apps/orchestration/src/socket/deepgramRelay.ts),
// which holds Sparkle's Deepgram key, meters per elapsed minute at the server-authoritative rate, and
// streams transcripts + post-debit balance back down. So the old client-side per-minute debit is
// gone — this module only:
//   (a) orchestrates opening the relay stream for one active-dictation window (open first, then keep
//       it only if we're still active), and
//   (b) resolves the balance the relay reports (via the `dictation://cloud-balance` event) for the
//       credits pill.
// The relay itself enforces entitlement + first-minute affordability at handshake time. A refusal
// surfaces as a NAMED `CloudStreamOutcome` from start_cloud_stream — `unauthorized` (401),
// `not_entitled` (403), `insufficient_credits` (402), `relay_unconfigured` (503), or `unreachable`
// when no answer arrived at all — and every one of them means "stay on-device". (It used to be a
// bare `false`, which could not tell any of those apart from a healthy already-routing socket.)
// Out-of-credits mid-stream still arrives separately via the `dictation://cloud-ended` event
// (exhausted=true), for a stream that DIED rather than one that was refused.

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
import {
  outcomeInstalledStream,
  type CloudStreamOutcome,
} from "../stores/dictationEngineStore";

export interface CloudWindowDeps {
  /** invoke("start_cloud_stream"): resolves the OUTCOME of the attempt — see `CloudStreamOutcome`.
   *  Was a bare `boolean`, whose `false` meant seven different things (including a perfectly healthy
   *  already-routing socket), which is what made the fallback banner flap. */
  startCloudStream: () => Promise<CloudStreamOutcome>;
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
 *   - nothing was installed by THIS call (signed out / offline / not entitled / can't afford the
 *     first minute / a race discard / a socket already routing) ⇒ stay on-device, nothing to close.
 *     THESE ARE NO LONGER INDISTINGUISHABLE — the outcome names the cause and the engine store
 *     reports it by name. The credits pill is still not eagerly refreshed on a can't-afford refusal,
 *     which remains fine for the original reason: a genuinely out-of-credits user was already
 *     refreshed to ~0 by the prior session's mid-stream `exhausted` teardown, and any residual
 *     staleness self-heals on the next `/me` poll.
 *   - a stop/mute/toggle raced the async open ⇒ close the socket and clear our own preview.
 *   - otherwise the relay stream is live; balance updates + exhaustion arrive via `dictation://` events
 *     (there is no client-side meter to start — the server meters).
 */
export async function openCloudDictationWindow(deps: CloudWindowDeps): Promise<void> {
  const outcome = await deps.startCloudStream();
  // `outcomeInstalledStream`, NOT "is the cloud live" — the two differ on exactly one outcome and
  // the distinction is load-bearing. `already_routing` IS live, but the socket belongs to an earlier
  // call, so this call has nothing to tear down if a stop raced it; falling through would let this
  // call close a stream a still-active window is using.
  if (!outcomeInstalledStream(outcome)) return; // nothing installed by THIS call
  if (!deps.isStillActive()) {
    // A tray move / mute / toggle landed during the open → close, and clear our own preview so this
    // helper is self-contained (not reliant on the separate passive/toggle effects).
    deps.stopCloudStream();
    deps.clearInterim();
  }
}

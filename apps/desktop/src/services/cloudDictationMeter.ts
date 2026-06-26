// Per-minute credit metering for cloud (Deepgram) dictation. Cloud dictation is a continuous
// billable stream, so — unlike the one-shot `withCredits` gate — we OPEN the socket first, then
// (only if it actually opened) debit one minute immediately and one minute every 60s while it stays
// open, tearing the stream down the moment a debit fails (out of credits) so the user falls back to
// free on-device dictation. Opening before the first debit means a known-broke user with a key
// incurs a brief (~one debit round-trip) bit of vendor cost before close — an accepted tradeoff that
// keeps us from ever billing for a stream that never opened (no key / handshake failure). The rate
// comes from the pricing table (creditPricing.ts, 10x the Deepgram vendor cost).
//
// IO is injected so this is fully unit-testable without timers, network, or the store.
import type { ConsumeResult } from "./credits";
import { CLOUD_DICTATION_CENTS_PER_MIN } from "./creditPricing";

const MINUTE_MS = 60_000;

export interface CloudMeterDeps {
  /** Debit the ledger; resolves {ok:false} when the user is out of credits. */
  consume: (
    cents: number,
    reason: string,
    meta?: Record<string, unknown>,
    idempotencyKey?: string,
  ) => Promise<ConsumeResult>;
  /** The "Use AI features" master — false short-circuits any debit (no AI ⇒ no charge). */
  isAiEnabled: () => boolean;
  // Browser/webview timer handles are numbers (window.setInterval). Injected for testability.
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (h: number) => void;
  /** Called when a per-minute debit fails mid-stream; the caller closes the cloud stream and
   *  resumes on-device dictation. */
  onExhausted: () => void;
  /** Stable id for this active-dictation window, used to build idempotent per-minute debit keys. */
  sessionId: string;
}

export interface CloudDictationMeter {
  /** Reserve the first minute. Resolves true if charged (caller may open the stream), or false if AI
   *  is off or the user can't afford a minute (caller stays on-device, never opening a paid socket). */
  start: () => Promise<boolean>;
  /** Stop metering (the stream closed). Idempotent. */
  stop: () => void;
}

export function createCloudDictationMeter(deps: CloudMeterDeps): CloudDictationMeter {
  let timer: number | null = null;
  let minute = 0;
  // Set by stop(); checked in start() AFTER its first (awaited) debit. Without it, a stop() that
  // lands during that await would be a no-op (timer still null), then start() would resume and
  // install an orphaned interval that nothing can cancel — billing forever. Single-use: a stopped
  // meter never starts ticking (we create a fresh meter per active-dictation window).
  let stopped = false;

  const debitOneMinute = async (): Promise<boolean> => {
    if (!deps.isAiEnabled()) return false;
    const key = `${deps.sessionId}:${minute}`; // idempotent per (session, minute)
    minute += 1;
    try {
      const res = await deps.consume(CLOUD_DICTATION_CENTS_PER_MIN, "cloud_dictation_minute", { minute: minute - 1 }, key);
      return res.ok;
    } catch {
      // A thrown debit (network/Rust error) is treated as "not charged" → caller stops + falls back.
      // Returning (never throwing) keeps the interval's .then path live, so no unhandled rejection.
      return false;
    }
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) {
      deps.clearInterval(timer);
      timer = null;
    }
  };

  return {
    async start() {
      minute = 0;
      if (!(await debitOneMinute())) return false; // AI off or out of credits → don't open the socket
      if (stopped) return false; // stop() landed during the first debit → never install the interval
      let inFlight = false;
      timer = deps.setInterval(() => {
        // Don't overlap debits: if the previous minute's debit is still resolving (e.g. a slow
        // server-backed consume took >60s), skip this tick rather than fire a concurrent debit.
        if (inFlight) return;
        inFlight = true;
        void debitOneMinute().then((charged) => {
          inFlight = false;
          if (!charged) {
            stop();
            deps.onExhausted();
          }
        });
      }, MINUTE_MS);
      return true;
    },
    stop,
  };
}

// There's exactly one mic / one ambient dictation session, so the active cloud meter is a singleton.
// This lets the wake-transition path, the toggle-off effect, and the cloud-ended listener (which all
// live in different places) stop billing without threading a ref between them.
let activeMeter: CloudDictationMeter | null = null;

/** Install the current meter, stopping any previous one. */
export function setActiveCloudMeter(meter: CloudDictationMeter | null): void {
  if (activeMeter && activeMeter !== meter) activeMeter.stop();
  activeMeter = meter;
}

/** Stop and clear the active meter (cloud stream closed / stopped / died). Idempotent. */
export function stopActiveCloudMeter(): void {
  activeMeter?.stop();
  activeMeter = null;
}

/** IO + state hooks for openMeteredCloudWindow, injected so the billing-critical sequence is testable. */
export interface CloudWindowDeps {
  /** invoke("start_cloud_stream"): resolves true iff the backend actually opened a cloud socket. */
  startCloudStream: () => Promise<boolean>;
  /** invoke("stop_cloud_stream"): close the cloud socket (idempotent on the backend). */
  stopCloudStream: () => void;
  /** Re-check, after the async open, that we still want cloud (phase active + voice + composer on). */
  isStillActive: () => boolean;
  /** Create the per-minute meter for this window AND install it as the active singleton; returns it. */
  createMeter: () => CloudDictationMeter;
  /** Clear the live interim preview. */
  clearInterim: () => void;
  /** stopActiveCloudMeter(): clear the singleton so no stale meter reference lingers. */
  clearActiveMeter: () => void;
}

/**
 * Orchestrate one active-dictation cloud window: open the socket FIRST, then meter only if it
 * actually opened and we're still active. Billing-critical sequence, extracted from the hook so it
 * can be unit-tested:
 *   - open returned false (no key / handshake fail / race discard) ⇒ never meter (no charge).
 *   - a stop/mute/toggle raced the async open ⇒ close the socket, never meter.
 *   - first debit fails (out of credits / AI off) ⇒ close the socket, clear preview + meter singleton.
 */
export async function openMeteredCloudWindow(deps: CloudWindowDeps): Promise<void> {
  const opened = await deps.startCloudStream();
  if (!opened) return; // stayed on-device → no socket, no billing
  if (!deps.isStillActive()) {
    // A stop word / mute / toggle landed during the open → close, don't bill, and clear our own
    // preview so this helper is self-contained (not reliant on the separate passive/toggle effects).
    deps.stopCloudStream();
    deps.clearInterim();
    return;
  }
  const meter = deps.createMeter();
  let charged = false;
  try {
    charged = await meter.start();
  } catch {
    charged = false; // defensive: a thrown debit must not leave an open, unbilled socket
  }
  if (!charged) {
    deps.stopCloudStream();
    deps.clearInterim();
    deps.clearActiveMeter();
  }
}

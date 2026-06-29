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

/**
 * How many CONSECUTIVE transient debit failures (a thrown `consume` — network/TLS blip, server
 * 5xx) we ride out before tearing the cloud stream down. A genuine "out of credits" decline
 * (`{ok:false}`) is NOT transient and still stops on the first occurrence — this tolerance applies
 * only to thrown errors. A single hiccup (the observed `tls connection init failed: unexpected end
 * of file`) no longer drops the premium stream the user explicitly enabled; a real outage still
 * falls back after this many minutes. Each tolerated minute went un-billed (the debit never
 * landed), so the exposure is bounded to ~this many free minutes per outage. A successful debit
 * resets the counter.
 */
export const MAX_CONSECUTIVE_TRANSIENT_DEBIT_FAILS = 2;

/** Outcome of a single per-minute debit attempt.
 *  - `charged`:  the minute was billed (or was a 0-cent tick) — keep streaming.
 *  - `declined`: a definitive refusal (out of credits, or AI turned off) — stop now, no retry.
 *  - `error`:    a transient throw (network/TLS/server) — the caller tolerates a bounded run. */
type DebitOutcome = "charged" | "declined" | "error";

/**
 * Integer cents to debit for `minuteIndex` (0-based) at a possibly-fractional per-minute `rate`,
 * via a cumulative-rounding accumulator: `round(rate*(n+1)) - round(rate*n)`. This is the fix for
 * the silent-cloud-dictation bug: the credit ledger's `/credits/consume` requires whole, positive
 * cents (`cents: z.number().int().positive()`), so sending the raw 5.8¢/min rate was rejected with a
 * 400 that tore the Deepgram socket down ~200ms after it opened, every time. Cumulative rounding
 * keeps the running total within ½¢ of `rate * minutes` forever (no linear drift — long-run average
 * is exactly `rate`) while making every debit an integer. A fractional rate can still yield a 0-cent
 * tick on some minutes (e.g. a sub-1¢ rate); the caller skips the network debit for those and the
 * accrued fraction is billed on a later non-zero tick.
 *
 * For 5.8¢/min the first minutes are [6,6,5,6,6, …] (each 5-min block sums to 29 = round(5*5.8)).
 */
export function minuteDebitCents(rate: number, minuteIndex: number): number {
  return Math.round(rate * (minuteIndex + 1)) - Math.round(rate * minuteIndex);
}

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
  /** Called after every SUCCESSFUL per-minute debit (including the immediate first minute) so the
   *  caller can tick the displayed balance down in real time. `balanceAfterCents` is the server's
   *  post-debit balance, or null when the server omits it — in which case the caller falls back to
   *  an optimistic decrement of `debitedCents` (see `nextBalanceCents`). NOT called on the
   *  failure/exhausted paths (those refresh the balance from the server instead). */
  onDebited?: (balanceAfterCents: number | null, debitedCents: number) => void;
  /** Stable id for this active-dictation window, used to build idempotent per-minute debit keys. */
  sessionId: string;
}

/**
 * Resolve the balance to display after a successful debit: prefer the server's authoritative
 * `balanceAfterCents`, but fall back to an optimistic local decrement (current − debited) when the
 * server omits it, so the on-screen balance still moves. Pure so the wiring can be unit-tested.
 */
export function nextBalanceCents(
  current: number,
  balanceAfterCents: number | null,
  debitedCents: number,
): number {
  return balanceAfterCents != null ? balanceAfterCents : current - debitedCents;
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

  const debitOneMinute = async (): Promise<DebitOutcome> => {
    if (!deps.isAiEnabled()) return "declined"; // AI off ⇒ no charge, no stream
    const idx = minute;
    const cents = minuteDebitCents(CLOUD_DICTATION_CENTS_PER_MIN, idx);
    const key = `${deps.sessionId}:${idx}`; // idempotent per (session, minute)
    minute += 1;
    // A fractional rate can round to a 0-cent tick; the ledger rejects `cents: 0`, so skip the
    // network debit and carry the fraction — the cumulative accumulator bills it on a later minute.
    if (cents <= 0) return "charged";
    try {
      const res = await deps.consume(cents, "cloud_dictation_minute", { minute: idx }, key);
      if (!res.ok) {
        // Out of credits — a DEFINITIVE refusal (not a blip): log it and stop now, no tolerance.
        // eslint-disable-next-line no-console
        console.warn(
          `[cloud-dictation] minute ${idx} debit of ${cents}¢ declined — out of credits (balance ${res.balanceCents}¢); stopping cloud stream`,
        );
        return "declined";
      }
      // Successful debit → tick the displayed balance down in real time. Prefer the server's
      // post-debit balance; pass null when absent so the caller can optimistically decrement.
      deps.onDebited?.(res.balanceAfterCents ?? null, cents);
      return "charged";
    } catch (e) {
      // A THROWN debit (network/TLS/server error) is transient: a single blip shouldn't drop a
      // premium stream the user explicitly enabled. Log it (never silent) but return "error" so the
      // caller can ride out a bounded run before falling back. Returning (never throwing) keeps the
      // interval's .then path live, so no unhandled rejection.
      // eslint-disable-next-line no-console
      console.warn(`[cloud-dictation] minute ${idx} debit of ${cents}¢ failed (transient): ${String(e)}`);
      return "error";
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
      // Minute 0 gates whether we open a billable socket at all: anything but a clean charge (AI off,
      // out of credits, OR a transient error reaching the ledger) means stay on-device — we never
      // open a stream we couldn't bill for its very first minute.
      if ((await debitOneMinute()) !== "charged") return false;
      if (stopped) return false; // stop() landed during the first debit → never install the interval
      let inFlight = false;
      // Consecutive transient (thrown) failures since the last successful debit. Tolerated up to
      // MAX_CONSECUTIVE_TRANSIENT_DEBIT_FAILS so a momentary network blip doesn't drop the stream;
      // reset to 0 on any successful debit.
      let consecutiveTransientFails = 0;
      timer = deps.setInterval(() => {
        // Don't overlap debits: if the previous minute's debit is still resolving (e.g. a slow
        // server-backed consume took >60s), skip this tick rather than fire a concurrent debit.
        if (inFlight) return;
        inFlight = true;
        void debitOneMinute().then((outcome) => {
          inFlight = false;
          if (outcome === "charged") {
            consecutiveTransientFails = 0; // healthy round-trip → forget any prior blips
            return;
          }
          if (outcome === "declined") {
            // Definitive (out of credits / AI off): stop immediately, no tolerance.
            stop();
            deps.onExhausted();
            return;
          }
          // Transient throw: ride out a bounded run, then give up and fall back to on-device.
          consecutiveTransientFails += 1;
          if (consecutiveTransientFails > MAX_CONSECUTIVE_TRANSIENT_DEBIT_FAILS) {
            // eslint-disable-next-line no-console
            console.warn(
              `[cloud-dictation] ${consecutiveTransientFails} consecutive transient debit failures; stopping cloud stream, falling back to on-device`,
            );
            stop();
            deps.onExhausted();
          }
          // else: keep streaming across the blip (this minute went un-billed — bounded grace).
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
  /** Optional: the socket opened but the first debit failed (out of credits, or a server/network
   *  error) so cloud dictation can't run this window. The caller surfaces it — e.g. refresh the
   *  credits pill so a zero balance becomes visible. NOT called on the stay-on-device path
   *  (opened=false): that never opened a billable socket, so there's nothing to explain. */
  onUnavailable?: () => void;
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
    // Opened-but-not-charged: tell the caller so it can surface why (refresh the credits pill).
    deps.onUnavailable?.();
  }
}

/**
 * A shared circuit breaker for AI-vendor outages, for the suggestions compute.
 *
 * WHY THIS EXISTS, and why the existing retry budget does not cover it.
 *
 * `useSuggestions` already caps attempts per FAILING STATE (MAX_COMPUTE_ATTEMPTS against a
 * scrollback hash). That is the right shape for what it was built for — one state that keeps
 * rejecting — but its scope is (agent, settled-state hash), so it can only ever dampen RETRIES of
 * a state it has already seen fail. A vendor-side outage is not that shape: it rejects the FIRST
 * attempt of every state, on every agent, and each new settled state arrives with a full, untouched
 * budget. Nothing carries the knowledge "the vendor is currently down" from one state to the next,
 * so the per-state cap never engages on the volume that actually matters.
 *
 * Measured over one sustained upstream 5xx episode: ~87% of the rejected computes were FIRST
 * attempts (a fresh state, full budget), and only ~13% were retries 2 and 3. Tightening the retry
 * budget would therefore have addressed the small share; the doomed first calls are the cost, and
 * only something shared across states can decline them.
 *
 * The compute path's own comments name this gap precisely — an unavailable backend has to spend its
 * whole budget at once "because nothing records that the backend is down, so the gate stays open and
 * every re-render would buy another doomed call". This module is that recorder.
 *
 * WHAT IT DOES. After `OUTAGE_THRESHOLD` consecutive vendor-outage rejections (5xx) across ANY
 * state or agent, the breaker opens for `OUTAGE_COOLDOWN_MS`. While it is open the compute effect
 * returns BEFORE issuing a call — so an outage costs one probe per cooldown instead of one paid
 * call per settled state. Any success closes it immediately; so does the cooldown elapsing, which
 * makes the next compute a half-open probe that either closes the breaker or re-opens it.
 *
 * WHY 5xx AND NOT "any repeated failure". 5xx is the one class that is both (a) server-side, so it
 * is the same for every agent and every state — which is what makes a SHARED breaker correct rather
 * than an over-generalization — and (b) not already handled: 4xx is terminal per request
 * (`isTerminalComputeError`), offline and out-of-credits defer via `computeDeferralReason`, and an
 * unavailable backend burns its budget on the spot. 5xx is deliberately left retryable by that
 * policy, and should stay retryable — a single gateway blip SHOULD get its backoff. The breaker
 * only changes what happens once blips stop looking like blips.
 *
 * WHY IT CANNOT STRAND A STATE. Deferring a compute is only safe when something re-runs the effect
 * on the flip (see `computeDeferralReason` — offline has `isOnline`, credits has `learnedOn`). This
 * breaker's flip is the passage of time, which has no such dep, so the caller pairs the open gate
 * with a wake timer that fires at expiry. The gate also commits NOTHING — not `lastHash`, not the
 * retry budget — so the skipped state is still `shouldRecompute`-eligible when the breaker closes.
 */

/** Consecutive vendor-outage rejections before the breaker opens. Above 1 on purpose: a lone 502 is
 *  the transient blip the existing backoff is FOR, and opening on it would trade a working retry for
 *  a cooldown. Three in a row across independent states is no longer a blip. */
export const OUTAGE_THRESHOLD = 3;

/** How long the breaker stays open. Long enough that a real episode costs ~1 probe per minute
 *  instead of ~40 calls, short enough that recovery is not perceptibly delayed — suggestions are a
 *  live affordance, and the state recomputes as soon as the probe succeeds. */
export const OUTAGE_COOLDOWN_MS = 60_000;

/**
 * How long a claimed half-open probe holds off the other callers before it is presumed abandoned.
 *
 * The claim is normally released by the probe's own settlement (success, failure, or deferral), so
 * this bound only covers the case where NO settlement ever arrives — the probing pane unmounts
 * mid-flight, or the request hangs past any server-side timeout. Comfortably longer than a healthy
 * compute round-trip (so a slow-but-live probe is never double-issued) and well under the cooldown
 * (so an abandoned claim can't cost more than the cooldown it sits inside).
 */
export const OUTAGE_PROBE_TIMEOUT_MS = 30_000;

/** Shared breaker state. `openedAt` is null while closed; `consecutive` counts vendor-outage
 *  rejections since the last success; `probeStartedAt` is when the live half-open probe claimed the
 *  right to be the only in-flight call (null when none). Kept as one record so they can't drift. */
export interface OutageState {
  consecutive: number;
  openedAt: number | null;
  probeStartedAt: number | null;
}

export const NO_OUTAGE: OutageState = { consecutive: 0, openedAt: null, probeStartedAt: null };

/**
 * Whether a rejection looks like the VENDOR being down rather than this request being wrong.
 * The proxy surfaces upstream status as `... (HTTP <code>)`; 5xx is the server-side class. 502/503/
 * 504 are the gateway's own, and 529 is an upstream "overloaded" — all the same disposition here.
 *
 * Note 408/429 are 4xx and so are NOT counted: they are per-request "try again later" signals that
 * `isTerminalComputeError` already keeps on the normal backoff, and they say nothing about whether
 * the vendor is reachable for OTHER agents. Pure, for testing.
 */
export function isVendorOutageError(message: string): boolean {
  const m = /\(HTTP (\d{3})\)/.exec(message);
  if (!m) return false;
  const code = Number(m[1]);
  return code >= 500 && code < 600;
}

/** Whether the breaker is open (and so computes should be skipped) at `now`. A cooldown that has
 *  elapsed reads as CLOSED without needing anyone to have reset it — the next compute is then the
 *  half-open probe. Pure, for testing. */
export function isOutageOpen(state: OutageState, now: number): boolean {
  if (state.openedAt === null) return false;
  return now - state.openedAt < OUTAGE_COOLDOWN_MS;
}

/** Milliseconds until an open breaker closes; 0 when it is already closed. The caller schedules its
 *  wake timer on this, which is what keeps a deferred state from stranding. Pure, for testing. */
export function outageCooldownRemainingMs(state: OutageState, now: number): number {
  if (state.openedAt === null) return 0;
  return Math.max(0, state.openedAt + OUTAGE_COOLDOWN_MS - now);
}

/**
 * Fold a rejection into the breaker and return the next state.
 *
 * A NON-outage rejection resets the consecutive run: the run is meant to measure "the vendor is
 * down for everything", and a 4xx or a local error in the middle of it is evidence the transport is
 * in fact working. It deliberately does NOT close an already-open breaker — a single unrelated
 * failure is not proof of recovery, and only a SUCCESS (or the cooldown) is. Pure, for testing.
 */
export function noteFailure(state: OutageState, message: string, now: number): OutageState {
  // Any settlement ends the probe this caller may have been holding, so every branch below clears
  // `probeStartedAt`: the claim exists to keep two calls from being in flight at once, and once one
  // has landed the next half-open window is free to issue its own.
  if (!isVendorOutageError(message)) return { ...state, consecutive: 0, probeStartedAt: null };
  const consecutive = state.consecutive + 1;
  // Already open: hold the ORIGINAL openedAt so a probe that fails can't extend the cooldown
  // indefinitely by re-stamping it. The probe re-opens a CLOSED breaker instead (below).
  if (isOutageOpen(state, now)) return { ...state, consecutive, probeStartedAt: null };
  if (consecutive < OUTAGE_THRESHOLD) return { consecutive, openedAt: null, probeStartedAt: null };
  return { consecutive, openedAt: now, probeStartedAt: null };
}

/** A successful compute proves the vendor is reachable — close the breaker and clear the run.
 *  Pure, for testing. */
export function noteSuccess(): OutageState {
  return NO_OUTAGE;
}

/**
 * Release a claimed half-open probe WITHOUT recording a verdict about the vendor.
 *
 * The one caller is the deferral path: an offline or out-of-credits rejection returns before
 * `noteFailure`, on purpose — a shut local gate is not evidence about the vendor's health, so it
 * must not feed the consecutive run. But the claim it took still has to come back, or the next
 * cooldown's probe is blocked behind a call that already settled and every pane waits out
 * `OUTAGE_PROBE_TIMEOUT_MS` for nothing. Pure, for testing.
 */
export function releaseProbe(state: OutageState): OutageState {
  if (state.probeStartedAt === null) return state;
  return { ...state, probeStartedAt: null };
}

/**
 * Claim the right to issue a call while the breaker is HALF-OPEN, so a cooldown expiry admits ONE
 * probe rather than one call per mounted agent.
 *
 * WHY THIS IS NEEDED, given the gate above already exists. `isOutageOpen` is a time check with no
 * notion of who is asking, so the instant a cooldown elapses it reads CLOSED for every hook instance
 * at once. Each pane's compute then passes it, and — because nothing is in flight yet from that
 * pane's point of view — issues its own paid call. The module's stated bargain ("one probe per
 * cooldown") therefore held only for a single agent; with N panes mounted an outage cost N calls per
 * cooldown, in a burst, forever. Measured over one sustained 502 episode: bursts of up to ~50
 * rejections inside a single minute, separated by quiet cooldowns — the sawtooth of a breaker that
 * opens correctly and then lets the whole herd through on every expiry.
 *
 * WHY IT IS SCOPED TO THE HALF-OPEN WINDOW ONLY. A breaker that never tripped (`openedAt === null`)
 * grants unconditionally: computes for different agents are genuinely independent work, and
 * serialising them in the healthy case would make suggestions arrive one pane at a time for no
 * benefit. The herd is only wasteful once we already have evidence the vendor is refusing everyone.
 *
 * WHY IT CANNOT STRAND. A denied caller commits nothing and schedules a wake on
 * `probeWaitMs`, exactly as the open-breaker branch does; the probe itself either closes the
 * breaker (success) or re-opens it (failure), and an abandoned claim ages out via
 * `OUTAGE_PROBE_TIMEOUT_MS`. Pure, for testing.
 */
export function claimProbe(
  state: OutageState,
  now: number,
): { state: OutageState; granted: boolean } {
  if (state.openedAt === null) return { state, granted: true };
  const live =
    state.probeStartedAt !== null && now - state.probeStartedAt < OUTAGE_PROBE_TIMEOUT_MS;
  if (live) return { state, granted: false };
  return { state: { ...state, probeStartedAt: now }, granted: true };
}

/** How long a caller denied by `claimProbe` should wait before re-checking: the remainder of the
 *  live probe's timeout. A backstop, not the usual recovery path — the probe's own settlement
 *  re-triggers the effect sooner. Pure, for testing. */
export function probeWaitMs(state: OutageState, now: number): number {
  if (state.probeStartedAt === null) return 0;
  return Math.max(0, state.probeStartedAt + OUTAGE_PROBE_TIMEOUT_MS - now);
}

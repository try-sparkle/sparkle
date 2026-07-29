// What the auto-send rail did, and whether it was right (PRD 1 §4f).
//
// # Why this exists at all
//
// `confidence.ts` decides how long to wait from four hand-written heuristics. Hand-written
// thresholds are guesses until something measures them, and the thing worth measuring is not
// "did it fire" — it is **did it fire too early**. Nobody files a bug for that. They just
// re-dictate the sentence, which looks like ordinary usage unless you are watching for it.
//
// So the signal this module exists to capture is the CORRECTION: a second send, close behind an
// auto-send, is the user saying the first one left too soon. Everything else here is context for
// reading that one number.
//
// # The privacy line, and why it falls where it does
//
// `packages/core/analytics.ts` is a closed union whose contract is that every prop is a
// non-identifying enum or count. That binds harder here than anywhere else in the app, because the
// subject matter is literally the user's speech.
//
//   → PostHog gets: the tier (an enum), the threshold and elapsed silence (BUCKETED, not raw ms),
//     and four booleans. Nothing reconstructible.
//   → The LOCAL log gets the two verdicts side by side at `info` — enums, safe in a support bundle.
//   → The TRANSCRIPT goes to `debug` only, on its own line. It is the entire point of the
//     out-of-band tuner (see src-tauri/auto_send_tuner.rs) and cannot be anonymised without
//     destroying it, so it is written where it will not be collected by default: `support.rs`
//     bundles the persistent log and redacts secret-SHAPED strings, which speech is not, and debug
//     is suppressed in production builds unless forwarding is switched on. "It never leaves the
//     machine" was the earlier claim here and it was not true — a shared support bundle would have
//     carried every dictated utterance, uncapped.
//
// Bucketing the durations is not decoration. Raw millisecond silences across a session are close to
// a fingerprint of someone's speech rhythm; the tiers are what the tuning actually reads.
import { invoke } from "@tauri-apps/api/core";

import { ANALYTICS_EVENTS } from "@sparkle/core";
import { capture } from "../analytics";
import { log } from "../logger";
import { useUiStore } from "../stores/uiStore";
import type { Confidence } from "./confidence";

/**
 * How long after an auto-send a further send still counts as a CORRECTION rather than a new
 * thought.
 *
 * 15s is from PRD §4f. It is deliberately generous: the user has to notice the send went early,
 * decide it was wrong, and re-say the sentence, and rushing that window would undercount exactly
 * the failure this metric exists to find. Over-counting is the safer error — a false correction
 * says "look here", a missed one says nothing at all.
 */
export const CORRECTION_WINDOW_MS = 15_000;

/** What the rail knew at the moment it fired. */
export interface AutoSendSample {
  /** The tier the heuristic assigned the transcript. */
  tier: Confidence;
  /** The threshold that tier bought, in ms. */
  thresholdMs: number;
  /** Silence actually accumulated before firing, in ms. */
  elapsedSilenceMs: number;
  /**
   * The user kept speaking after at least one re-evaluation moved the threshold.
   *
   * This is what separates "the rail waited correctly" from "the rail happened not to be tested":
   * a countdown nobody spoke through never exercised the moving threshold at all.
   */
  keptTalkingAfterReeval: boolean;
  /** The {@link THRESHOLD_DROP_GRACE_MS} window was applied — a late chunk put the deadline behind us. */
  graceApplied: boolean;
  /** The text that was sent. LOCAL LOG ONLY — never a PostHog prop. */
  transcript: string;
}

/**
 * Coarse duration buckets.
 *
 * Raw millisecond timings would be both noisier and more identifying than anything the tuning needs
 * — the question is only ever "which band", because the thresholds themselves are 1s/3s/5s/10s.
 */
export function bucketMs(ms: number): string {
  if (ms < 1_500) return "under_1_5s";
  if (ms < 3_500) return "1_5s_to_3_5s";
  if (ms < 6_000) return "3_5s_to_6s";
  if (ms < 11_000) return "6s_to_11s";
  return "over_11s";
}

/** A fired auto-send awaiting its verdict. */
interface Pending {
  sample: AutoSendSample;
  firedAt: number;
  /** Set if the user sent again inside the window. */
  corrected: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The one auto-send currently inside its correction window, if any.
 *
 * Deliberately a SINGLE slot rather than a queue. Two auto-sends inside 15s of each other is
 * already the pathological case this metric hunts, and the second one's arrival is itself the
 * correction signal for the first — so the slot is resolved and replaced, never stacked.
 */
let pending: Pending | null = null;

/** Emit and clear. Split out so both the timer and an early resolve share one exit. */
function flush(p: Pending): void {
  if (p.timer !== null) clearTimeout(p.timer);
  // ENUMS AND BOOLEANS ONLY — see this module's header. No transcript, no raw durations.
  capture(ANALYTICS_EVENTS.AUTO_SEND_FIRED, {
    tier: p.sample.tier,
    threshold_bucket: bucketMs(p.sample.thresholdMs),
    elapsed_bucket: bucketMs(p.sample.elapsedSilenceMs),
    kept_talking_after_reeval: p.sample.keptTalkingAfterReeval,
    grace_applied: p.sample.graceApplied,
    // THE PREMATURE-SEND SIGNAL. Everything else on this event is here to make this one readable.
    correction_within_window: p.corrected,
  });
}

/**
 * Record that the rail fired on its own, and open the correction window.
 *
 * Also kicks off the out-of-band Haiku classify. That call takes 15–27 seconds (see
 * `auto_send_tuner.rs`), which is why it can only ever be a tuning instrument — it resolves long
 * after the send it is grading, and its answer is written to the local log rather than returned to
 * anyone.
 */
export function recordAutoSend(sample: AutoSendSample, now: number = Date.now()): void {
  // A send already in its window is resolved by this one arriving — that IS the correction, but
  // only if the window is genuinely still open. Same wall-clock rule as noteUserSend: the timer is
  // a trigger, never the authority.
  if (pending) {
    pending.corrected = now - pending.firedAt < CORRECTION_WINDOW_MS;
    flush(pending);
    pending = null;
  }

  const p: Pending = { sample, firedAt: now, corrected: false, timer: null };
  p.timer = setTimeout(() => {
    // Window closed with no further send: the rail got it right, as far as we can tell.
    if (pending === p) {
      pending = null;
      flush(p);
    }
  }, CORRECTION_WINDOW_MS);
  pending = p;

  void gradeInBackground(sample);
}

/**
 * The user sent something themselves. If an auto-send is still inside its window, that is a
 * correction — the strongest evidence we get that the rail left too early.
 */
export function noteUserSend(now: number = Date.now()): void {
  if (!pending) return;
  // THE CLOCK DECIDES, not the timer. `setTimeout` is the emit TRIGGER, never the authority on
  // whether the window is still open: WKWebView throttles and suspends timers in a backgrounded or
  // occluded window, and a busy main thread delays them, so a 15s timer can fire minutes late.
  // Without this check a user who dictates, switches away, comes back two minutes later and sends
  // a genuinely new message is recorded as having CORRECTED the earlier auto-send — corrupting the
  // one metric this module exists to produce. (Unobservable under fake timers, which are punctual
  // by construction; the test drives `now` explicitly instead.)
  pending.corrected = now - pending.firedAt < CORRECTION_WINDOW_MS;
  flush(pending);
  pending = null;
}

/**
 * The user pressed Send while a countdown was running, rather than letting it finish.
 *
 * A weaker signal than a correction but the same direction: the threshold was longer than the user
 * wanted. Logged locally only — on its own it is as often impatience as it is a bad threshold, and
 * a PostHog prop that ambiguous would get read as if it were not.
 */
export function noteManualSendDuringCountdown(tier: Confidence, elapsedSilenceMs: number): void {
  log.info("autosend", "manual send during countdown", {
    tier,
    elapsed_bucket: bucketMs(elapsedSilenceMs),
  });
}

/**
 * At most one classify in flight, ever.
 *
 * Each one is a full Node CLI boot measured at 15-27s holding hundreds of MB, and auto-sends can
 * arrive every few seconds while someone dictates steadily. Without this, six sends inside half a
 * minute leave six concurrent Claude Code processes resident and six messages billed — for output
 * that only a local log ever reads. A dropped sample costs nothing: this is a corpus for tuning
 * heuristics between releases, not a ledger that has to balance.
 */
let classifyInFlight = false;

/**
 * Ask Haiku what it would have graded the utterance, and write the two verdicts side by side.
 *
 * OPT-IN, DEFAULT OFF. It spends the USER'S OWN Claude subscription — the env posture deliberately
 * strips `ANTHROPIC_API_KEY` so BYOK cannot pay for it — and it is a diagnostic nobody asked for.
 * Spending someone's quota to improve our heuristics is not something to do by default, so it is
 * gated the way `builder_index` is: off until switched on.
 *
 * LOCAL ONLY, and never awaited by anything on the send path. Fails silently in every direction:
 * not enabled, already in flight, no `claude` binary, no Tauri host (tests, the browser dev shell),
 * a timeout — all just mean this sample has no second opinion, which is the ordinary case rather
 * than an error.
 */
async function gradeInBackground(sample: AutoSendSample): Promise<void> {
  if (!useUiStore.getState().conciergeAutoSendTuner) return;
  if (classifyInFlight) return;
  classifyInFlight = true;
  try {
    const haikuTier = await invoke<string | null>("auto_send_tuner_classify", {
      transcript: sample.transcript,
    });
    if (!haikuTier) return;
    // The VERDICTS at info — enums only, safe to sit in a support bundle.
    log.info("autosend", "heuristic vs haiku", {
      heuristic: sample.tier,
      haiku: haikuTier,
      // The DISAGREEMENTS are the whole corpus — a future tuning pass reads these and nothing else.
      agree: haikuTier === sample.tier,
    });
    // THE SPOKEN TEXT AT DEBUG, deliberately, and on its own line.
    //
    // `logger.ts` says the persistent log exists to be handed to a developer, and `support.rs`
    // bundles it — redacting secret-shaped strings, which speech is not. At info this wrote every
    // dictated utterance to every user's disk with no cap and no retention bound, and the module
    // header's claim that the transcript "never leaves the machine" would have held only until
    // someone shared a support bundle. debug is suppressed in production builds unless forwarding
    // is switched on, so it stays a developer-opt-in rather than a default collection.
    log.debug("autosend", "transcript", { transcript: sample.transcript });
  } catch {
    // See the doc comment: a missing second opinion is not a fault worth surfacing.
  } finally {
    classifyInFlight = false;
  }
}

/** Test seam — drop any open window without emitting. */
export function resetAutoSendTelemetry(): void {
  if (pending?.timer != null) clearTimeout(pending.timer);
  pending = null;
  classifyInFlight = false;
}

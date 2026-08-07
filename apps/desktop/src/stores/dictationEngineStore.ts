// WHICH TRANSCRIPTION ENGINE IS ACTUALLY PRODUCING THE USER'S WORDS — and, the part the user cares
// about, what falling back COSTS them.
//
// Dictation has two engines (see `dictation.rs`): the on-device Parakeet/Silero pair, and the
// Deepgram relay opened on demand while the user is actively dictating. When the relay refuses or
// dies, capture keeps working — the words still land — so nothing looks broken. But the on-device
// path is an OFFLINE transducer: it decodes a closed VAD segment and has no interim results at all
// (`dictationStore.interim` is documented as `""` there). So the live, word-by-word italic preview
// STRUCTURALLY CANNOT EXIST on the fallback path.
//
// WHY THAT NEEDS TO BE SAID OUT LOUD RATHER THAN LEFT TO INFERENCE. The founder chased this twice as
// a bug — once as "the Deepgram text is still showing above the actual text", once hunting missing
// italics — because a silent engine swap is indistinguishable from a broken feature. Losing a
// feature quietly is a TRUST failure, not an accuracy one: the transcript is fine, and the user is
// left believing the app is broken when it has merely changed engines. Naming it costs one banner.
//
// WHY A SEPARATE STORE FROM `aiServiceHealthStore`. That store's detector counts a SUSTAINED run of
// failures from the user's own `claude` CLI, and its copy rules say in as many words to attribute
// the fault to Claude Code on the user's machine rather than to a Sparkle service. Neither fits: the
// relay IS a Sparkle-hosted service, and the attribution that store prescribes would be false here.
// Folding this into that reason union would import its SUSTAINED-run detector wholesale, which is
// not the shape either of these two signals wants.
//
// ══ TWO SIGNALS, NOT ONE, AND THEY ARE NOT EQUALLY TRUSTWORTHY ═════════════════════════════════
// This header used to say "the signal is definitive, so there is no threshold and nothing to
// de-flap". That is true of ONE of the two and false of the other, and the difference is the whole
// design:
//
//   • `dictation://cloud-ended` — UNAMBIGUOUS. The relay is telling us the stream died, and it says
//     whether the cause was exhaustion. An answer, not a symptom: reported immediately, no
//     threshold, nothing to corroborate.
//   • `start_cloud_stream` returning `false` — AMBIGUOUS, and this is the correction. It is a bare
//     bool meaning "I did not open a socket", and `cloud_reuse` returns it for `AlreadyRouting` —
//     a socket that is ALIVE, matches the project and is actively routing. So the same `false`
//     covers "the relay refused" and "one is already running, nothing to do". Treating it as
//     definitive raised the banner on every repeated hold and every focus-regain onto a warm
//     socket: the founder's "popping up and going away… it seems to be very sensitive", measured
//     while the relay answered a real WS handshake with 401 in ~0.2-0.7s throughout. This one is
//     corroborated (see `OPEN_REFUSALS_BEFORE_WARNING`) and cleared by any evidence of a live
//     cloud — including an interim result, which only the relay can produce.
//
// AND AN OBSERVATION IS PERISHABLE, WHICHEVER SIGNAL IT CAME FROM. The only thing that ever
// cleared `fallbackReason` was a LATER `start_cloud_stream` returning true — and that call happens
// only when the user dictates again with the cloud prefs on. So one transient refusal (a DNS blip,
// a relay restart, the ENOTFOUND waves of 2026-08-07) left a present-tense notice — "Sparkle can't
// reach the cloud transcription service" — standing over a relay that had been healthy for hours,
// with no way down but a restart. The founder reported exactly that: still seeing the banner, no
// idea why.
//
// An observation is evidence about the MOMENT it was made. Stamping it and letting it go stale is
// what lets the notice come down on its own, and it costs nothing when the outage is real: every
// further attempt re-reports and renews the stamp, so a genuine outage keeps the bar up for as long
// as the user keeps meeting it. The staleness only ever fires when NOBODY is seeing the problem
// any more — which is precisely when the claim has stopped being true.
import { create } from "zustand";

/** How long a fallback observation still speaks for the present.
 *
 *  Sized against what the notice CLAIMS, not against the outage: it says the live preview is off
 *  *now*, and the only thing that can renew that claim is the user dictating again. Five minutes is
 *  long enough that someone who saw the fallback, read the bar and looked away still finds it there,
 *  and short enough that it cannot outlive the session it describes. Renewed on every re-report, so
 *  this is a floor on how long a notice lives, never a cap on a real outage. */
export const FALLBACK_NOTICE_TTL_MS = 5 * 60_000;

/** Why the cloud engine is not available. Coarse by construction — no raw error, no PII — matching
 *  the copy rules the sibling banners settled on. */
export type DictationFallbackReason =
  /** The relay declined to open, or the stream died mid-utterance (network, upstream, refusal). */
  | "unavailable"
  /** The relay signalled out-of-credits — the one reason the user can actually act on. */
  | "exhausted";

export interface DictationEngineState {
  /** Set once a cloud attempt has been REFUSED or a live stream has ended, meaning dictation is now
   *  running on-device. `null` means "no problem known" — the resting state, and deliberately NOT
   *  "cloud is live": at rest no stream is open at all, and a banner that fired on that would be lit
   *  permanently while nothing was wrong. */
  fallbackReason: DictationFallbackReason | null;
  /** When `fallbackReason` was last OBSERVED (epoch ms), which is what makes it perishable. `null`
   *  means "no stamp" and is read as fresh, never as stale — see `shouldWarnLocalEngine`. */
  observedAt: number | null;
  /** Hidden for THIS episode. Cleared by a cloud stream coming back, so a later, distinct outage
   *  re-arms the banner rather than being permanently silenced by one dismissal. */
  dismissed: boolean;
  /** A cloud stream opened — the engine is back, so retire the banner and re-arm it for next time. */
  noteCloudLive: () => void;
  /** A cloud stream was refused or ended; dictation continues on-device without interim results. */
  noteCloudUnavailable: (reason: DictationFallbackReason) => void;
  /** Drop an observation that has gone stale, so the store SETTLES rather than merely going
   *  unpainted. A no-op on a fresh notice and on an empty one. */
  retireStaleNotice: (now?: number) => void;
  /** `start_cloud_stream` returned false — which is NOT the same claim as `noteCloudUnavailable`.
   *  Needs corroboration before it speaks; see `OPEN_REFUSALS_BEFORE_WARNING`. */
  noteCloudOpenRefused: () => void;
  /** Consecutive unexplained `start_cloud_stream` refusals, reset by any evidence of a live cloud. */
  openRefusals: number;
  dismiss: () => void;
}

/** How many CONSECUTIVE open-path refusals before the banner speaks.
 *
 *  THE OPEN SEAM CANNOT TELL SUCCESS FROM FAILURE, WHICH IS WHY THIS EXISTS. `start_cloud_stream`
 *  returns a bare bool documented as "true iff the backend opened the socket", and `cloud_reuse`
 *  answers `AlreadyRouting -> Ok(false)` for a socket that is ALIVE, matches the project and is
 *  actively routing — the idempotent no-op on a repeated passive→active edge. The same `false` also
 *  covers a genuine refusal. So a single `false` is NOT evidence of an outage, and treating it as
 *  one raised the banner on every repeated hold and every focus-regain onto a warm socket: the
 *  founder's "it's popping up and going away… it seems to be very sensitive".
 *
 *  That is a measured correction to this store's original claim that "a single refusal is already
 *  definitive… there is nothing to de-flap". It would be true of an unambiguous signal. It is not
 *  true of this one, and the relay was verified healthy (a real WS handshake to `/ai/deepgram`
 *  answers 401 in ~0.2-0.7s; only an unclaimed path 404s) while the banner was flapping.
 *
 *  Two, not more: the mid-stream `cloud-ended` path IS unambiguous and still reports immediately, so
 *  this only ever delays the ambiguous one.
 *
 *  THE COUNT ALONE IS NOT THE GUARD, AND AN EARLIER VERSION OF THIS NOTE CLAIMED IT WAS. It said the
 *  no-op case "by construction is followed by a working stream rather than another refusal" — false
 *  at this seam (roborev 59964/59966): `cloud_reuse` answers `AlreadyRouting` on EVERY passive→active
 *  edge onto a warm socket, so consecutive no-ops are the NORMAL case and a bare threshold would just
 *  make the flap rarer. What makes it correct is that the count is per-episode and is zeroed by any
 *  EVIDENCE of a live cloud — a successful open, and an interim result, which only the relay can
 *  produce. A healthy session therefore never accumulates two. */
export const OPEN_REFUSALS_BEFORE_WARNING = 2;

export const useDictationEngineStore = create<DictationEngineState>()(
  (set) => ({
    fallbackReason: null,
    observedAt: null,
    dismissed: false,
    openRefusals: 0,
    // Any evidence of a live cloud also clears the corroboration counter — consecutive means
    // consecutive, so a refusal an hour and a hundred good streams ago must not be half of a verdict.
    noteCloudLive: () =>
      set({
        fallbackReason: null,
        observedAt: null,
        dismissed: false,
        openRefusals: 0,
      }),
    // A NEW reason re-arms a dismissal, the SAME one does not. Going from a plain outage to
    // out-of-credits is a different thing to tell the user (the second is actionable), so it must be
    // able to speak even if they waved the first one away; re-reporting the same reason on every
    // subsequent refusal must not.
    //
    // The stamp is renewed UNCONDITIONALLY, including on a re-report of a reason the user dismissed.
    // Freshness and visibility are different questions: a dismissed notice stays hidden either way,
    // and letting its stamp rot would retire the episode out from under the dismissal — so the next
    // identical refusal would read as a new one and speak. Renewing keeps `dismissed` meaning what it
    // says: silent for this episode, for as long as the episode is still happening.
    noteCloudUnavailable: (reason) =>
      set((s) => ({
        fallbackReason: reason,
        observedAt: Date.now(),
        dismissed: s.fallbackReason === reason ? s.dismissed : false,
      })),
    // Clears `dismissed` alongside the reason: the episode is over, so the next outage is a new one
    // and must not inherit a wave-away from an outage that has already expired.
    retireStaleNotice: (now = Date.now()) =>
      set((s) =>
        isStale(s, now)
          ? {
              fallbackReason: null,
              observedAt: null,
              dismissed: false,
              // The episode is over, so its corroboration goes with it (roborev 59941) — otherwise
              // a retired notice leaves the counter armed and the next lone refusal speaks alone.
              openRefusals: 0,
            }
          : {},
      ),
    // The AMBIGUOUS seam. Counts first and speaks only once corroborated, so the idempotent
    // already-routing no-op — which is followed by a working stream, not another refusal — never
    // reaches the banner. A real outage refuses every time and so still speaks, one attempt later.
    noteCloudOpenRefused: () =>
      set((s) => {
        const openRefusals = s.openRefusals + 1;
        if (openRefusals < OPEN_REFUSALS_BEFORE_WARNING)
          return { openRefusals };
        // AN AMBIGUOUS REFUSAL MUST NOT DOWNGRADE A SPECIFIC ONE (roborev 59930). This seam always
        // reports "unavailable" because it cannot know better — but `exhausted` came from the relay
        // SAYING SO on a mid-stream teardown, and it is strictly more informative. Overwriting it
        // told a user at zero credits that Sparkle "can't reach the cloud transcription service"
        // and to "try dictating again in a moment": false twice over, and it sends them to debug
        // their network while the one remedy that works — refill — goes unmentioned. Keeping the
        // specific reason costs nothing, because only a genuinely live stream (`noteCloudLive`)
        // clears it, so a user who refills is never stuck behind a stale `exhausted`.
        const preserved = s.fallbackReason === "exhausted";
        const reason: DictationFallbackReason = preserved
          ? "exhausted"
          : "unavailable";
        return {
          // THE COUNT KEEPS CLIMBING ONCE THE WARNING IS UP, AND THAT IS DELIBERATE (roborev 59971).
          // It briefly zeroed here too, which broke the invariant one paragraph up: the
          // sub-threshold branch returns `{ openRefusals }` with NO stamp, so resetting on every
          // fire meant only every OTHER refusal renewed `observedAt` — and a sustained outage whose
          // attempts are more than TTL/2 apart would let its own notice expire underneath it. The
          // per-episode guarantee 59941 asked for does not need this reset: `retireStaleNotice` and
          // `noteCloudLive` both zero the counter, and between them they own every way an episode
          // can end. Staying armed while the episode is live is what keeps each further attempt a
          // re-report that renews the stamp.
          fallbackReason: reason,
          // PRESERVING A REASON IS NOT OBSERVING IT (roborev 59968). This seam saw an ambiguous
          // `false` and nothing more — it has no evidence of out-of-credits — so renewing the stamp
          // would let every pair of refusals push a preserved `exhausted` deadline out again and
          // make it unbounded in time, defeating the very expiry this store exists to provide. That
          // is the mirror image of the false-remedy bug: a user who refills and THEN hits a real
          // outage gets refusals rather than `noteCloudLive`, so they would be told "you're out of
          // Sparkle credits… Refill" forever. Keeping the old stamp lets a stale `exhausted` expire
          // on its own TTL, after which this seam reports `unavailable` honestly.
          observedAt: preserved ? s.observedAt : Date.now(),
          dismissed: s.fallbackReason === reason ? s.dismissed : false,
        };
      }),
    dismiss: () => set({ dismissed: true }),
  }),
);

/** Has this observation stopped speaking for the present? An unstamped notice is NOT stale — we
 *  cannot prove it is, and the guard may only ever take down a banner it can prove has expired. */
function isStale(state: DictationEngineState, now: number): boolean {
  return (
    state.fallbackReason !== null &&
    state.observedAt !== null &&
    now - state.observedAt > FALLBACK_NOTICE_TTL_MS
  );
}

/** Should the banner be showing? Split out from the component so the rule is testable without a
 *  DOM — and so there is exactly ONE place that decides it.
 *
 *  `now` is a parameter rather than a `Date.now()` read so the rule stays pure and the expiry is
 *  testable without leaning on fake timers at every call site. */
export function shouldWarnLocalEngine(
  state: DictationEngineState,
  now: number = Date.now(),
): boolean {
  return (
    state.fallbackReason !== null && !state.dismissed && !isStale(state, now)
  );
}

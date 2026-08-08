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
//   • `start_cloud_stream` — MOSTLY UNAMBIGUOUS NOW, and this bullet is a correction of a
//     correction. It used to return a bare bool meaning "I did not open a socket", which
//     `cloud_reuse` also answered for `AlreadyRouting` — a socket that is ALIVE, matches the project
//     and is actively routing. So one `false` covered both "the relay refused" and "one is already
//     running, nothing to do", and treating it as definitive raised the banner on every repeated
//     hold and focus-regain onto a warm socket: the founder's "popping up and going away… it seems
//     to be very sensitive", measured while the relay answered a real WS handshake with 401 in
//     ~0.2-0.7s throughout.
//
//     It returns a classified `CloudStreamOutcome` now, so most of that ambiguity is GONE at the
//     source rather than de-flapped downstream: `already_routing` is positive evidence of a live
//     cloud, `raced` moves nothing, and 401/402/403/503 are named answers reported at once. Exactly
//     ONE outcome is still genuinely ambiguous — `unreachable`, where no HTTP answer arrived — and
//     it is the only thing `OPEN_REFUSALS_BEFORE_WARNING` still guards.
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
  | "exhausted"
  /** No usable Sparkle session on this machine (no bearer, or the relay rejected it with 401).
   *  Actionable: sign in again. */
  | "signed_out"
  /** Signed in, but this account isn't entitled to cloud dictation. Actionable: upgrade. */
  | "not_entitled";

/** What `start_cloud_stream` reports — the wire form of Rust's `CloudStreamOutcome`.
 *
 *  PINNED BY `outcome_wire_tokens_are_pinned` (dictation.rs), which serializes every variant through
 *  serde and asserts these exact ten strings. It deliberately does NOT lean on
 *  `refusal_tokens_are_pinned`: that test covers `RelayRefusal::as_str()`, whose only consumer is a
 *  tracing field — it never crosses IPC, so it could not have caught a rename here. The two string
 *  sets overlap by intent, not by construction. */
export type CloudStreamOutcome =
  | "opened"
  | "resumed"
  | "already_routing"
  | "raced"
  | "signed_out"
  | "unauthorized"
  | "not_entitled"
  | "insufficient_credits"
  | "relay_unconfigured"
  | "unreachable";

/** What the store should DO with an outcome. Split out as a pure value so the policy is testable
 *  without a store, and so there is one place that decides it.
 *
 *  The `definitive` / `ambiguous` distinction is the whole reason the outcome type exists. The relay
 *  answers a refusal with a specific status, so those causes are KNOWN and can be reported at once —
 *  the same standing the mid-stream `cloud-ended` teardown has always had. Only `unreachable` is a
 *  genuine "we could not tell", and only it still needs corroboration before it speaks. */
export type CloudOutcomeVerdict =
  /** Positive evidence the cloud is working — retire any notice and zero the counter. */
  | { kind: "live" }
  /** Says nothing about the relay (a stop/start race). Must not move any state. */
  | { kind: "ignore" }
  /** The relay told us exactly why. Report immediately, no corroboration needed. */
  | { kind: "definitive"; reason: DictationFallbackReason }
  /** No answer reached us. Could be a blip; corroborate before speaking. */
  | { kind: "ambiguous" };

/** Map an outcome onto what the store should do. PURE — see `CloudOutcomeVerdict`.
 *
 *  `already_routing` being LIVE is the fix for the flap. It is the idempotent no-op on a repeated
 *  passive→active edge onto a healthy socket — the single most common outcome during normal use —
 *  and treating it as a refusal is what raised the banner on every repeated hold and focus-regain
 *  while the relay was verified healthy throughout. */
export function classifyCloudOutcome(
  outcome: CloudStreamOutcome,
): CloudOutcomeVerdict {
  switch (outcome) {
    case "opened":
    case "resumed":
    case "already_routing":
      return { kind: "live" };
    case "raced":
      return { kind: "ignore" };
    // Same remedy (sign in), so one reason serves both: no bearer at all, and a bearer the relay
    // rejected.
    case "signed_out":
    case "unauthorized":
      return { kind: "definitive", reason: "signed_out" };
    case "not_entitled":
      return { kind: "definitive", reason: "not_entitled" };
    // The relay's 402 and its mid-stream `exhausted` teardown mean the same thing to the user and
    // have the same remedy, so they deliberately share a reason and its copy.
    case "insufficient_credits":
      return { kind: "definitive", reason: "exhausted" };
    // A real service fault, and one the user can do nothing about — but we KNOW it, so say so now
    // rather than making them dictate twice to find out.
    case "relay_unconfigured":
      return { kind: "definitive", reason: "unavailable" };
    case "unreachable":
      return { kind: "ambiguous" };
    // TOTAL BY CONSTRUCTION, AND THAT IS NOT PEDANTRY. Without this arm the function returns
    // `undefined` for any string outside the union, `noteCloudOutcome` then reads `.kind` off it and
    // THROWS — inside `startCloudStream`, i.e. before `openCloudDictationWindow` reaches its
    // teardown. A socket the backend really did install would never be closed on a raced stop and
    // would keep billing, and the rejection would vanish into the `void` at the call site. The bool
    // this replaced was total for every value the backend could send; this has to be too.
    //
    // `ambiguous` is the fail-SAFE answer: an answer we cannot read is exactly "we could not tell",
    // so it corroborates instead of accusing the relay of something specific.
    default: {
      // A KNOWN new variant still fails TYPECHECK here — this arm catches unrecognised strings at
      // runtime, it does not excuse an unhandled case at compile time.
      const unhandled: never = outcome;
      console.warn("[dictation] unrecognised cloud outcome", unhandled);
      return { kind: "ambiguous" };
    }
  }
}

/** Is this outcome one where THIS call put a stream in place? Distinct from `live`: `already_routing`
 *  is live but owned by an earlier call, so this call has nothing to tear down if it raced.
 *
 *  FAIL-SAFE IN THE SAME DIRECTION AS `classifyCloudOutcome`, and it was not (roborev 60358). This
 *  was a strict `===` pair, which answers `false` for any token it does not recognise — so the exact
 *  billing leak the `default` arm above was added to close stayed open one seam later: under a wire
 *  drift (a Rust rename, a lost `#[serde(rename_all)]`) a stream that really WAS installed reads as
 *  "nothing to tear down", `openCloudDictationWindow` returns early, and a raced stop never calls
 *  `stopCloudStream` — the socket keeps metering. Surviving the drift quietly is not the same as
 *  handling it.
 *
 *  THE FALSE POSITIVE IS NOT FREE, AND AN EARLIER VERSION OF THIS NOTE SAID IT WAS ("a spurious stop
 *  costs one no-op call"). That is wrong, and the correction matters (roborev 60366):
 *  `stop_cloud_stream` is NOT scoped to this caller — `dictation.rs` flips the app-wide `cloud_active`
 *  to false, bumps `cloud_epoch`, and pauses the single cloud session. And a wire drift makes EVERY
 *  token unrecognised, `already_routing` included — the most common outcome in ordinary use — so on
 *  a raced stop this arm can park a socket an earlier, still-live window installed, dropping it to
 *  on-device mid-utterance. That is the "hang-up" the sibling case in cloudDictation.test.ts exists
 *  to prevent, and it would be reached only under a drift, but it would be reached.
 *
 *  `true` is still the right answer, chosen on WHICH failure is worse rather than on one being free.
 *  A missed stop is a silent orphaned socket that keeps metering with nothing to notice it; a
 *  spurious stop is a visible engine swap that the next open re-establishes. Silent and billable
 *  loses to visible and self-correcting. The real guard is upstream: `outcome_wire_tokens_are_pinned`
 *  makes a rename fail in CI, and the `never` check makes a known new variant fail typecheck — this
 *  arm is the last resort for a drift that got past both, not the mechanism keeping the two in step. */
export function outcomeInstalledStream(outcome: CloudStreamOutcome): boolean {
  switch (outcome) {
    case "opened":
    case "resumed":
      return true;
    case "already_routing":
    case "raced":
    case "signed_out":
    case "unauthorized":
    case "not_entitled":
    case "insufficient_credits":
    case "relay_unconfigured":
    case "unreachable":
      return false;
    default: {
      // A KNOWN new variant still fails TYPECHECK here, exactly as in `classifyCloudOutcome`.
      const unhandled: never = outcome;
      console.warn(
        "[dictation] unrecognised cloud outcome; assuming a stream may be installed",
        unhandled,
      );
      return true;
    }
  }
}


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
  /** `start_cloud_stream` answered `unreachable` — no HTTP answer arrived, which is NOT the same
   *  claim as `noteCloudUnavailable`. The only remaining ambiguous outcome, so the only one that
   *  needs corroboration before it speaks; see `OPEN_REFUSALS_BEFORE_WARNING`. */
  noteCloudOpenRefused: () => void;
  /** THE ONE ENTRY POINT for a `start_cloud_stream` result. Routes the outcome through
   *  `classifyCloudOutcome` so the open seam no longer has to guess what a bare `false` meant. */
  noteCloudOutcome: (outcome: CloudStreamOutcome) => void;
  /** Consecutive `unreachable` outcomes — the one refusal shape nothing explains.
   *
   *  THREE THINGS ZERO IT, and they are the three ways an episode can end: `noteCloudLive` (the
   *  cloud came back), `noteCloudUnavailable` (the relay named a cause, via either definitive
   *  channel), and `retireStaleNotice` (the observation expired). Stated in full here and in
   *  `noteCloudOpenRefused`'s warning branch — an earlier version of each listed only two, in
   *  different pairs, so no single place in the file was correct. */
  openRefusals: number;
  dismiss: () => void;
}

/** How many CONSECUTIVE `unreachable` outcomes before the banner speaks.
 *
 *  WHAT THIS GUARDS NOW IS ONE OUTCOME, NOT THE WHOLE SEAM — and an earlier version of this note
 *  said the opposite ("THE OPEN SEAM CANNOT TELL SUCCESS FROM FAILURE, WHICH IS WHY THIS EXISTS").
 *  That was true of the bool: `start_cloud_stream` returned "true iff the backend opened the
 *  socket", `cloud_reuse` answered `AlreadyRouting -> Ok(false)` for a socket that was ALIVE and
 *  actively routing, and the same `false` also covered a genuine refusal — so a single `false` was
 *  not evidence of an outage, and treating it as one raised the banner on every repeated hold and
 *  focus-regain onto a warm socket (the founder's "it's popping up and going away… it seems to be
 *  very sensitive").
 *
 *  `CloudStreamOutcome` retired that ambiguity at the source. `already_routing` now classifies as
 *  `live` and never reaches this counter; `raced` moves nothing; every named refusal is reported
 *  immediately. The ONLY outcome that still arrives here is `unreachable` — no HTTP answer reached
 *  us at all, which could equally be a DNS blip or a real outage — so this threshold's remaining job
 *  is to make the desktop see that twice before blaming the relay. Do not read it as the flap guard;
 *  the flap was fixed by classifying the outcome, not by counting.
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
  (set, get) => ({
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
    // A DEFINITIVE ANSWER ENDS THE AMBIGUOUS EPISODE, AND THE RESET BELONGS HERE — at the SINK every
    // definitive report passes through, not at one caller (roborev 60366). It was first written in
    // `noteCloudOutcome`'s `definitive` branch, which left the OTHER definitive channel uncovered:
    // the mid-stream `cloud-ended` teardown calls this directly, and the store header classes that
    // signal as the unambiguous one. So a lone `unreachable` blip left the count at 1, a stream
    // death reported `exhausted`, and ONE later blip crossed the threshold — the exact failure the
    // reset was added to prevent, one channel over. One rule, one place.
    noteCloudUnavailable: (reason) =>
      set((s) => ({
        fallbackReason: reason,
        observedAt: Date.now(),
        dismissed: s.fallbackReason === reason ? s.dismissed : false,
        openRefusals: 0,
      })),
    // ONE SEAM, FOUR BEHAVIOURS, decided by `classifyCloudOutcome` rather than here — so the policy
    // is a pure function a test can enumerate, and this stays a dispatch.
    //
    // A DEFINITIVE refusal goes straight to `noteCloudUnavailable`, deliberately skipping the
    // corroboration counter. That counter exists because a bare `false` could not tell a healthy
    // no-op from a refusal; a named 401/402/403/503 has no such ambiguity, so making the user
    // dictate a second time before telling them their session expired would be withholding an
    // answer we already have. The newest definitive answer wins outright: it is the relay's current
    // verdict, and a stale `exhausted` must not outrank a live "you're signed out".
    noteCloudOutcome: (outcome) => {
      const verdict = classifyCloudOutcome(outcome);
      switch (verdict.kind) {
        case "live":
          get().noteCloudLive();
          return;
        // A race says nothing about the relay, so it moves NOTHING — not the reason, not the
        // counter. Counting it would re-create the flap in a narrower form.
        case "ignore":
          return;
        // The counter reset that used to sit here moved INTO `noteCloudUnavailable` (roborev 60366),
        // so both definitive channels get it and there is one store write rather than two.
        case "definitive":
          get().noteCloudUnavailable(verdict.reason);
          return;
        case "ambiguous":
          get().noteCloudOpenRefused();
          return;
      }
    },
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
        //
        // WIDENED TO EVERY RELAY-STATED REASON, and that is a correction (roborev 60356). It tested
        // only `exhausted` because, when it was written, that was the ONLY reason the relay could
        // state — everything else arrived as the same ambiguous bool. It is not any more: a 401
        // arrives as `signed_out` and a 403 as `not_entitled`, both stated definitively, and both
        // were being overwritten with the generic "can't reach the cloud transcription service" as
        // soon as this seam corroborated. That is the identical misdirection 59930 fixed, aimed at
        // two new reasons: an unentitled user was told to retry forever while "Unlock Sparkle" —
        // the one remedy that works — disappeared from the banner.
        //
        // The test is "did anything state this?", so `unavailable` is the only reason NOT preserved:
        // it is what this ambiguous seam itself reports, so it can never outrank a named answer.
        //
        // Bound to a local first so the narrowing survives: TypeScript's aliased-condition analysis
        // follows a `const` initialised from a condition on ANOTHER const, but not one written
        // against a property of the callback's argument — `preserved ? s.fallbackReason : …` types
        // as `DictationFallbackReason | null` and fails the build.
        const stated = s.fallbackReason;
        const preserved = stated !== null && stated !== "unavailable";
        const reason: DictationFallbackReason = preserved ? stated : "unavailable";
        return {
          // THE COUNT KEEPS CLIMBING ONCE THE WARNING IS UP, AND THAT IS DELIBERATE (roborev 59971).
          // It briefly zeroed here too, which broke the invariant one paragraph up: the
          // sub-threshold branch returns `{ openRefusals }` with NO stamp, so resetting on every
          // fire meant only every OTHER refusal renewed `observedAt` — and a sustained outage whose
          // attempts are more than TTL/2 apart would let its own notice expire underneath it. The
          // per-episode guarantee 59941 asked for does not need this reset: `retireStaleNotice`,
          // `noteCloudLive` and `noteCloudUnavailable` each zero the counter, and between them they
          // own every way an episode can end — it expires, the cloud comes back, or the relay names
          // a cause. Staying armed while the episode is live is what keeps each further attempt a
          // re-report that renews the stamp.
          //
          // THAT LIST WAS TWO NAMES LONG UNTIL `noteCloudUnavailable` JOINED IT (roborev 60371), and
          // the stale version was load-bearing in the wrong direction: it told an auditor that the
          // episode-end invariant was already fully owned elsewhere, which is exactly the argument
          // for deleting the sink's `openRefusals: 0` and reopening the `cloud-ended` →
          // one-blip-crosses-threshold path. Three resetters; keep this list and the `openRefusals`
          // field doc in step.
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

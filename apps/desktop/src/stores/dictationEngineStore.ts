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
  /**
   * The relay CONNECTED, but not until after the utterance was already over, so the stream was
   * discarded and the words were decoded on-device.
   *
   * ── WHY THIS IS NOT `unavailable` ───────────────────────────────────────────────────────────
   * It was being reported as `unavailable`, and that copy says Sparkle "can't reach the cloud
   * transcription service" — a claim the log disproves. Measured on 2026-08-06: the relay opened
   * 171 times and closed 170, 136 of them discarded as "opened during a stop/again race"; the
   * founder's network was healthy at the moment the banner fired (ping 1.1.1.1 0% loss / 20 ms,
   * api.deepgram.com connect 260 ms). The handshake simply lands after a short utterance ends —
   * measured 0.96 s after `stop_dictation` in one cycle and ~6 s in another.
   *
   * A banner that blames the network for a timing bug is worse than no banner: it sent both the
   * founder AND an investigating agent hunting a connectivity fault that did not exist. The
   * founder's own words: *"if that is truly what's happening, then it should be doing something
   * other than what it's doing so that I'm not confused as a user."*
   */
  | "too-slow"
  /** No usable Sparkle session on this machine (no bearer, or the relay rejected it with 401).
   *  Actionable: sign in again. */
  | "signed_out"
  /** Signed in, but this account isn't entitled to cloud dictation. Actionable: upgrade. */
  | "not_entitled"
  /** The relay refused with 429: this account already holds its limit of concurrent streams.
   *  Actionable (close another dictating window) AND self-correcting (the previous socket's
   *  warm-standby window lapses), and — the part that matters — NOT an outage. */
  | "too_many_streams"
  /**
   * THE MICROPHONE NEVER STARTED — this hold captured NO AUDIO AT ALL.
   *
   * ── WHY THIS CANNOT BE ANY OF THE REASONS ABOVE ─────────────────────────────────────────────
   * Every other reason here is about the RELAY, and every one of their banners ends with some form
   * of *"Your words are still captured; they appear when you finish speaking instead of word by
   * word."* That sentence is TRUE for a relay failure — the on-device engine caught the audio — and
   * FALSE here, because there was no audio to catch. The capture finished building after the user
   * had already let go and was discarded empty.
   *
   * The founder hit exactly this and reported it as *"it doesn't seem to be recognizing the mic
   * right now"* — while the UI showed him the relay's `too-slow` banner, which was speaking for a
   * condition it does not cover and promising him words that were never recorded.
   *
   * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────────────────────
   * Not a missing device, not a permission problem, and not another app holding the microphone: on
   * the machine where this was diagnosed the device bound successfully 41/41 times with zero
   * failures while this fired. It is capture-start latency losing a race against a short hold —
   * `capture_ms` measured 232 ms on an idle machine and 2083 ms at load average 291, against
   * push-to-talk holds of ~345 ms.
   */
  | "mic_missed_hold"
  /**
   * THE VOICE MODEL WAS STILL LOADING — this hold recorded nothing, and the mic was never even
   * attempted.
   *
   * ── WHY THIS IS NOT `mic_missed_hold`, THOUGH BOTH LOSE THE UTTERANCE (roborev 61729) ────────
   * Both mean "nothing was recorded", and for a while both were reported as `mic_missed_hold`.
   * That was the unsafe-remedy shape AGENTS.md warns about, committed with the discriminator
   * already in hand: `mic_missed_hold` says *"try holding the key a moment longer"*, and its
   * justification is that a capture build takes a few hundred ms to a couple of seconds, so a
   * longer hold clears it. A MODEL load is 2418 ms, 3536 ms, and **46 258 ms** measured at load
   * average 291. No achievable hold clears that, so the advice fails repeatedly while blaming the
   * user's hold speed for an ONNX initialisation.
   *
   * It also has a remedy of its own that is actually true: the model is loaded at most once per
   * process, so the *next* attempt is warm (measured 5 ms). "Try again in a moment" works here and
   * would be false for a capture race, which is why these are two reasons rather than one string
   * stretched over both.
   *
   * Rare since `preload_model_in_background` moved the load to boot — reachable when a hold beats
   * the preload, or after `retire_cached_decoder` has dropped the cache.
   */
  | "model_still_loading";

/** What `start_cloud_stream` reports — the wire form of Rust's `CloudStreamOutcome`.
 *
 *  PINNED BY `outcome_wire_tokens_are_pinned` (dictation.rs), which serializes every variant through
 *  serde and asserts these exact eleven strings. It deliberately does NOT lean on
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
  | "too_many_streams"
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
    // DEFINITIVE, and emphatically not `ambiguous`. A 429 proves the relay is reachable AND healthy —
    // it counted this account's streams and answered. Left in the generic `Http(_)` bucket it would
    // have arrived here as `unreachable`, i.e. the corroborate-then-report-an-outage path, telling a
    // user whose only sin is a second Sparkle window that the service is down. That is exactly the
    // false-outage failure `RelayRefusal` was introduced to end, and adding a server gate without
    // this arm would have reintroduced it.
    case "too_many_streams":
      return { kind: "definitive", reason: "too_many_streams" };
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
    case "too_many_streams":
    case "unreachable":
      // `too_many_streams` is refused during the UPGRADE, before the handshake completes, so no
      // socket exists and there is nothing to tear down — the same standing as every other
      // pre-handshake refusal already in this group. (The note lives in the shared body rather than
      // between the labels because `no-fallthrough` counts a comment-only case as non-empty.)
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
  /** Which CAPTURE SESSION is running now — a monotonic counter bumped by `noteSessionStart`, i.e.
   *  every time the microphone is armed. Not a clock and not comparable across windows; its only
   *  job is to be different from the one before it. */
  captureSession: number;
  /** The capture session `fallbackReason` was observed IN. `null` means "no observation", and — as
   *  with `observedAt` — is read as belonging to the present, never as belonging to the past: this
   *  guard may only take a banner down when it can PROVE the evidence is someone else's. */
  observedSession: number | null;
  /** The microphone was armed — a new capture session begins, so nothing observed before now speaks
   *  for it. See the implementation for why this is a counter rather than a clear. */
  noteSessionStart: () => void;
  /** Hidden for THIS episode. Cleared by a cloud stream coming back, so a later, distinct outage
   *  re-arms the banner rather than being permanently silenced by one dismissal. */
  dismissed: boolean;
  /** A cloud stream opened — the engine is back, so retire the banner and re-arm it for next time. */
  noteCloudLive: () => void;
  /** A cloud stream was refused or ended; dictation continues on-device without interim results. */
  noteCloudUnavailable: (reason: DictationFallbackReason) => void;
  /** The microphone never started for a hold, so it recorded nothing. Its OWN seam, not the relay
   *  one: see the implementation for why routing this through `noteCloudUnavailable` was the same
   *  conflation this reason exists to delete. */
  noteMicMissedHold: (stage: "capture" | "model") => void;
  /** Drop an observation that has gone stale, so the store SETTLES rather than merely going
   *  unpainted. A no-op on a fresh notice and on an empty one. */
  retireStaleNotice: (now?: number) => void;
  /** `start_cloud_stream` answered `unreachable` — no HTTP answer arrived, which is NOT the same
   *  claim as `noteCloudUnavailable`. The only remaining ambiguous outcome, so the only one that
   *  needs corroboration before it speaks; see `OPEN_REFUSALS_BEFORE_WARNING`. */
  noteCloudOpenRefused: () => void;
  /** The relay CONNECTED and was then discarded for landing after the utterance ended — Rust's
   *  `dictation://cloud-late`. Owns the two invariants both call sites kept getting wrong; see the
   *  implementation. `speaks` splits the user-facing CLAIM from the relay EVIDENCE: pass
   *  `isCapturable()` from a broadcast listener, `true` from the window that made the attempt. */
  noteCloudConnectedLate: (speaks: boolean) => void;
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
    captureSession: 0,
    observedSession: null,
    dismissed: false,
    openRefusals: 0,
    // ── A NOTICE BELONGS TO THE SESSION THAT PRODUCED IT (the founder's mic-on banner) ───────────
    // Reported as: "As soon as I turn the mic on, I get this error banner… then as soon as I start
    // speaking, it goes away." Both halves are the same defect, and the second half is the tell.
    // The notice was perishable by WALL CLOCK alone, so arming the mic within
    // `FALLBACK_NOTICE_TTL_MS` of a previous fallback painted a banner about an utterance that had
    // already ended — before the new session had produced any evidence at all. It then vanished on
    // the first `dictation://interim`, because the relay's first streamed word reaches
    // `noteCloudLive`; that clear is the MITIGATION, and the gap it leaves is exactly mic-on until
    // first speech. A banner cannot be evidence for a session it predates.
    //
    // A COUNTER, NOT A CLEAR, and that is the whole design. Clearing `fallbackReason` here would
    // throw away a real observation to fix a PRESENTATION bug — the same split
    // `fallbackReasonWarrantsBanner` makes, and for the same reason: the console diagnostic, the
    // corroboration counter and the `exhausted`-preservation rules all read that reason, and a
    // standing account condition is still true across a mic toggle. So the evidence stays, the
    // stamp stays, and only the CLAIM on the present is withdrawn. If the condition really is
    // standing, this session's own `start_cloud_stream` re-reports it within a round trip and it
    // speaks again with a stamp it has earned.
    //
    // IT DOES NOT TOUCH `openRefusals`. That counter is evidence about the RELAY, not about this
    // microphone; zeroing it on every arm would discard a genuine first `unreachable` and make a
    // real outage take one extra hold to report — the same conflation `noteMicMissedHold` states
    // one seam over.
    //
    // SCOPED TO THE ARM, NOT TO EACH HOLD, and on the reported path those are the same thing: push
    // to talk RESTS at `setEnabled(false)` (`useMicActions.setOff`), so one hold is one capture
    // session is one utterance. In Speak mode the mic stays armed across many utterances, and
    // re-scoping per phase edge there would blink a standing outage off and on at the start of
    // every hold — worse than the bug. The TTL still governs within a session.
    noteSessionStart: () => set((s) => ({ captureSession: s.captureSession + 1 })),
    // Any evidence of a live cloud also clears the corroboration counter — consecutive means
    // consecutive, so a refusal an hour and a hundred good streams ago must not be half of a verdict.
    noteCloudLive: () =>
      set({
        fallbackReason: null,
        observedAt: null,
        observedSession: null,
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
        // Observing stamps BOTH perishability axes together — see `noteSessionStart`. Wherever the
        // clock is renewed the session marker is too, and wherever a reason is merely PRESERVED
        // (below) neither moves.
        observedSession: s.captureSession,
        dismissed: s.fallbackReason === reason ? s.dismissed : false,
        openRefusals: 0,
      })),
    // ── A MIC FAILURE IS NOT A RELAY VERDICT, SO IT DOES NOT USE THE RELAY SEAM ──────────────────
    // This went through `noteCloudUnavailable` first, which was the same conflation this whole
    // change exists to delete — just pointing the other way (roborev 61695). That seam does two
    // things beyond setting the reason, and BOTH are wrong here:
    //
    //   * `openRefusals: 0` resets the RELAY corroboration counter. A microphone that never started
    //     is no evidence at all about the relay, so zeroing it discards genuine relay evidence and
    //     makes the next real outage take an extra refusal to report.
    //   * it is the channel for a verdict the relay HANDED US. Routing a local capture failure
    //     through it means a mic condition and a relay condition are indistinguishable to every
    //     reader downstream — the exact defect the `mic_missed_hold` reason was added to fix.
    //
    // It still WINS the banner, deliberately: losing the whole utterance is strictly worse than
    // losing the live preview of an utterance that was captured, so it outranks a standing relay
    // reason. It just does not pretend to be one.
    noteMicMissedHold: (stage) =>
      set((s) => {
        // THE DISCRIMINATOR IS CARRIED THROUGH, not logged and dropped (roborev 61729). The two
        // stages lose the utterance for different reasons and have different true remedies, and
        // collapsing them meant telling a user to hold longer against a 46-second model load.
        const reason: DictationFallbackReason =
          stage === "model" ? "model_still_loading" : "mic_missed_hold";
        return {
        fallbackReason: reason,
        observedAt: Date.now(),
        observedSession: s.captureSession,
        dismissed: s.fallbackReason === reason ? s.dismissed : false,
        // openRefusals deliberately UNTOUCHED — see above.
        };
      }),
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
              observedSession: null,
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
        // ── …AND A DEAD CLAIM MUST NOT OUTRANK FRESH EVIDENCE (roborev 63558) ───────────────────
        // The precedence above is a WITHIN-SESSION rule: it is about which of two accounts of the
        // same moment is more informative. Applied across a capture session it inverts, because a
        // per-hold reason is not an account of this moment at all — `mic_missed_hold` says "THAT
        // hold captured no audio", and the mic has been re-armed since. Preserving it then costs
        // twice over: the banner it would paint is false (fixed one lap earlier by muting it), and
        // the muting is itself a second bug — a genuine outage happening RIGHT NOW is reported as
        // nothing at all, for the remainder of the dead reason's TTL, and once that expires two
        // FURTHER refusals are needed because this seam zeroes its counter.
        //
        // So the session test belongs on the REASON, not on the marker (which is where it was first
        // written). An account fact still outranks — nothing about a mic re-arm refills a balance or
        // signs anyone in — but every other stale reason yields to what this seam can see now.
        //
        // `too-slow` IS EXCLUDED OUTRIGHT, and it is the same argument made WITHIN one session
        // (roborev 63588). It produces the identical silence: a late-landing handshake records
        // `too-slow`, two consecutive `unreachable`s follow in the same capture session, and because
        // `too-slow` was preserved the corroborated outage was reported as nothing at all — that
        // reason is recorded but never painted. Then the counter is zeroed at expiry, so two FURTHER
        // refusals are needed. The reason a session boundary was not required to reach it: `too-slow`
        // is a claim about ONE UTTERANCE, so it is dead the moment the next one starts, and in Speak
        // mode the mic stays armed across many utterances inside one session. Not hypothetical
        // traffic either — this file records 136 of 171 opens discarded as late. Push-to-talk was
        // covered by the session guard above only because each hold is its own session.
        //
        // The late-connect seam has excluded it since it was introduced; this is the refusal seam
        // catching up. It costs nothing: `too-slow` never paints, so nothing is downgraded — the
        // banner goes from silent to reporting the outage that is actually happening.
        const staleClaim = isFromEarlierSession(s) && !isAccountFact(stated);
        const preserved =
          stated !== null && stated !== "unavailable" && stated !== "too-slow" && !staleClaim;
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
          //
          // AND IT ONLY CLIMBS IF THIS BRANCH WRITES IT. The paragraph above described the intent;
          // the returned patch simply omitted the key, so the count froze at
          // `OPEN_REFUSALS_BEFORE_WARNING - 1` for the whole episode — the one number in this store
          // whose documented behaviour and actual behaviour disagreed. Nothing user-visible depended
          // on it (the banner is decided by `fallbackReason`), which is why it survived; but it makes
          // "is the count still high enough to support this banner?" unanswerable, and any guard
          // written against the threshold silently dead — and one such guard (the orphan
          // withdrawal) was written against it before it was noticed.
          openRefusals,
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
          // ── THE SESSION MARKER IS STAMPED UNCONDITIONALLY, AND `observedAt` IS NOT ──────────────
          // These two look like one rule and are two (roborev 63346). `observedAt`'s preservation
          // guards against unbounded DEADLINE EXTENSION: this seam saw an ambiguous `false` and has
          // no evidence of out-of-credits, so renewing the clock would let every pair of refusals
          // push a preserved `exhausted` out again forever. That is a wall-clock concern and the
          // session axis has no equivalent — stamping it extends nothing, because the preserved
          // `observedAt` still governs when the notice expires.
          //
          // Carrying the OLD marker through was an outright regression, and worse than the bug this
          // axis was added to fix. `preserved` is about the reason STRING; the refusal being counted
          // here genuinely happened in the CURRENT session. Session 1 records `exhausted` → the user
          // mutes and re-arms → session 2 refuses twice and crosses the threshold → the preserved
          // marker made `isFromEarlierSession` true and the user saw NOTHING for up to the full TTL,
          // where before the session axis existed the banner painted. The definitive seams re-stamp
          // and self-heal, so the hole was specific to the two `preserved` branches.
          //
          // The rule, stated once: A SEAM THAT OBSERVED SOMETHING STAMPS THE SESSION IT OBSERVED IT
          // IN — for as long as the reason it ends up displaying is one the thing it observed still
          // speaks for. THAT QUALIFIER IS NOT DECORATION (roborev 63538): stated unconditionally it
          // was too wide, because `preserved` here means only "something named this", and that set
          // includes `mic_missed_hold` and `model_still_loading` — claims about ONE HOLD's audio,
          // not about the account. Stamping this session onto those re-paints a previous session's
          // "that hold captured no audio" over a session that captured fine, which is precisely the
          // founder-reported "as soon as I turn the mic on, I get this error banner" shape the
          // session axis exists to kill.
          //
          // IT IS UNCONDITIONAL AGAIN, AND THAT IS NOT A REVERT — the qualifier moved UP, into
          // `preserved` itself (roborev 63558). Gating the marker was the wrong seam for it: it
          // silenced the false banner by keeping a dead reason with a dead marker, so a REAL outage
          // in this session went unreported too. Now a stale non-account reason simply is not
          // preserved, which means everything reaching this line either was observed in this session
          // (where the stamp is a no-op) or is an account fact that outlives its session. Both take
          // the current marker, so there is nothing left to condition on.
          observedSession: s.captureSession,
          dismissed: s.fallbackReason === reason ? s.dismissed : false,
        };
      }),
    // ── THE UNAMBIGUOUS LATE CONNECT ────────────────────────────────────────────────────────────
    // Rust proved the relay was reachable (the handshake COMPLETED) and then threw the socket away
    // for landing after the utterance. Unlike `noteCloudOpenRefused` this needs no corroboration —
    // it is evidence, not a bare `false`. But writing `noteCloudUnavailable("too-slow")` from the
    // two call sites, which is what they used to do, escaped BOTH of this store's invariants
    // (roborev 60355). Hence one action that owns them:
    //
    //   1. IT MUST NOT DOWNGRADE A RELAY-STATED REASON. Exhaustion is signalled mid-stream, so a
    //      zero-balance user's next attempt still completes its handshake — and if that one lands
    //      late, the naive write replaced "You're out of Sparkle credits… Refill" with "connected
    //      too late… Longer utterances usually get the live preview", which names no remedy they can
    //      act on, and re-nagged (the reason CHANGED, so `dismissed` cleared). Reachability says
    //      nothing about credits. Same precedence `noteCloudOpenRefused` keeps, in the same WIDENED
    //      form it settled on (roborev 60356): `exhausted` was once the only reason the relay could
    //      state, and it is not any more — a 401 arrives as `signed_out` and a 403 as `not_entitled`,
    //      both definitive and both carrying the only remedy that works ("Sign in", "Unlock
    //      Sparkle"). A test written as `=== "exhausted"` silently overwrites those two the moment
    //      a handshake lands late, which is the identical misdirection aimed at two new reasons.
    //      THREE are NOT preserved — the ones this seam outranks, owns, or can disprove, each on its
    //      own ground:
    //        * `unavailable` — a completed handshake disproves it outright (the relay was reached).
    //        * `too_many_streams` — a completed handshake disproves it just as outright, and for a
    //          sharper reason: the relay checks the cap DURING the upgrade, so a handshake that
    //          completed proves the account was UNDER the cap at that moment. Keeping it would go on
    //          telling the user to close another Sparkle window to fix a condition already cleared.
    //        * `too-slow` itself — this seam owns it, and its re-report should renew its own stamp.
    //      Everything else is a relay-STATED account fact that a handshake does not contradict.
    //   2. IT MUST ZERO `openRefusals`. The counter's documented rule is that any EVIDENCE of a live
    //      cloud clears it, and a completed handshake is exactly that — it is this action's whole
    //      premise. Leaving it armed let refuse → late → refuse reach the threshold and then claim
    //      Sparkle "can't reach the cloud transcription service" over a relay that provably
    //      connected one utterance earlier, silently downgrading the honest reason. That is the flap
    //      the corroboration counter exists to remove, straddling a proven-live connection.
    //
    // PRESERVING A REASON IS NOT OBSERVING IT: when `exhausted` is kept the stamp is NOT renewed, so
    // a stale out-of-credits still expires on its own TTL rather than being pushed out forever by a
    // seam that never saw a balance (the same rule, and the same wording, as the refusal path).
    //
    // AND `speaks` SPLITS THE CLAIM FROM THE EVIDENCE (roborev 60368). `dictation://cloud-late` is an
    // `app.emit`, i.e. broadcast to EVERY window, and each project window mounts its own banner. What
    // the handshake PROVES about the relay is app-wide and is applied unconditionally; the sentence
    // "connected too late for that utterance" is about a specific window's utterance, and painting it
    // in three windows describes an utterance two of them had no part in — which they then cannot
    // take down, since every clearing path needs `isCapturable()`. That is the same over-report the
    // `cloud-ended` listener already gates for, and the interim handler already splits this exact way.
    noteCloudConnectedLate: (speaks) =>
      set((s) => {
        // Unconditional: a completed handshake is evidence about the RELAY, not about this window.
        //
        // AND THE EVIDENCE RETRACTS THE ONE CLAIM IT DISPROVES (roborev 60376). Zeroing the counter
        // without touching the banner that counter raised left a false "Sparkle can't reach the
        // cloud transcription service" standing in a window that has just been shown the relay IS
        // reachable — and standing for the full TTL, because every clearing path (`noteCloudLive`,
        // the interim-driven clear) needs that window to be the capturable one, which by definition
        // it is not. That is the invariant this seam exists for ("a relay that CONNECTED is never
        // reported as unreachable"), and the evidence-only branch was the one path still breaking
        // it. Retract `unavailable` once the count can no longer support it (0 is the strongest
        // form of that), and leave `exhausted` and `too-slow` standing, since those came from the relay SAYING something that a
        // reachability proof does not contradict.
        //
        // `too_many_streams` JOINS `unavailable` HERE, and for a stronger reason than reachability.
        // The relay checks the cap DURING the upgrade, so a handshake that completed proves the
        // account was under the cap at that moment — the condition is not merely unproven, it is
        // disproven. Leaving it standing keeps telling the user to close another Sparkle window to
        // fix something that has already cleared, which is the remedy-that-cannot-help shape.
        if (!speaks)
          return s.fallbackReason === "unavailable" || s.fallbackReason === "too_many_streams"
            ? {
                openRefusals: 0,
                fallbackReason: null,
                observedAt: null,
                observedSession: null,
                dismissed: false,
              }
            : { openRefusals: 0 };
        // Bound to a local first so the narrowing survives, for the same TypeScript reason
        // `noteCloudOpenRefused` states: an aliased condition written against a property of the
        // callback's argument does not narrow.
        const stated = s.fallbackReason;
        // `too_many_streams` is excluded for the reason given in the `!speaks` branch above: the cap
        // is enforced during the upgrade, so a completed handshake disproves it. The correct account
        // of an utterance that refused at the cap and then connected after the user stopped talking
        // is "connected too late" — not "too many windows are dictating", which is no longer true
        // and whose remedy would do nothing.
        // The cross-session test the refusal seam documents at length applies here identically: a
        // handshake completing is no evidence about whether a PREVIOUS hold captured audio, so a
        // stale `mic_missed_hold` must not survive it (roborev 63558). What this seam yields to is
        // its own `too-slow`, which is recorded but never painted — so the outcome is the same
        // silence the marker-gating produced, reached honestly: the stored reason now describes
        // what actually happened in this session rather than preserving a claim about a dead one.
        const staleClaim = isFromEarlierSession(s) && !isAccountFact(stated);
        const preserved =
          stated !== null &&
          stated !== "unavailable" &&
          stated !== "too-slow" &&
          stated !== "too_many_streams" &&
          !staleClaim;
        const reason: DictationFallbackReason = preserved ? stated : "too-slow";
        return {
          fallbackReason: reason,
          observedAt: preserved ? s.observedAt : Date.now(),
          // Same rule as the refusal seam above (roborev 63346, and unconditional again for the
          // reason 63558 gives there): this seam OBSERVED something in the current session — a
          // handshake that completed — so it stamps this session. Preserving the marker would mute
          // a standing `exhausted` in the very session that proved the relay reachable, and the
          // per-hold reasons that made an unconditional stamp look unsafe no longer reach this line
          // at all: `preserved` above drops a stale one before the marker is ever chosen.
          observedSession: s.captureSession,
          dismissed: s.fallbackReason === reason ? s.dismissed : false,
          openRefusals: 0,
        };
      }),
    dismiss: () => set({ dismissed: true }),
  }),
);

/**
 * Does this reason describe the ACCOUNT rather than one hold, one utterance, or one moment?
 *
 * This is the line that decides whether a standing reason may be PRESERVED across a capture session
 * at all (roborev 63538, moved here from the marker by 63558). An account fact — no credits, signed
 * out, not entitled — is unchanged by muting and re-arming the mic: nothing but a refill, a sign-in
 * or a purchase clears it, so a seam that observes anything at all in the new session is observing a
 * world where that fact still holds. It keeps its precedence, and it takes the new session's marker
 * so the banner speaks. Everything else is a claim about a SPECIFIC EVENT, and does not survive the
 * session it was made in:
 *
 *   - `mic_missed_hold` / `model_still_loading` — "THIS hold captured no audio", "the model was
 *     still loading when you held the key". A later refusal or handshake is no evidence whatsoever
 *     about the current hold's audio, and re-raising them paints a mic failure over a session that
 *     captured fine.
 *   - `too-slow` — "the handshake landed after THAT utterance ended". About one utterance.
 *   - `too_many_streams` — another window held the cap at that instant. It self-clears the moment
 *     that window stops, so it too is a claim about a moment rather than about the account.
 *   - `unavailable` — never preserved at either seam; it is what the ambiguous seam itself reports.
 *
 * Those YIELD across a session boundary: the seam reports what it can see now, freshly stamped, and
 * the dead claim is gone rather than merely muted. That distinction is the whole of 63558 — muting
 * it left a real, current-session outage reported as nothing at all until the dead reason's TTL ran
 * out. Nothing observed in the CURRENT session is affected either way, since `isFromEarlierSession`
 * is false for it and the precedence is unchanged.
 *
 * ── NOT THE SAME LIST AS `fallbackReasonWarrantsBanner`'S, AND IT MUST NOT BE ────────────────────
 * That predicate answers "is this worth a banner AT ALL", and by that test `unavailable` and
 * `too_many_streams` are standing conditions with real remedies, so they pass it. This one answers
 * the narrower "did the passage of a capture session destroy the evidence", where both fail: a
 * remedy the user can act on is not the same claim as a fact that is still true a session later.
 * Keep them separate; collapsing them re-opens the hole at whichever seam borrowed the wrong list.
 */
function isAccountFact(reason: DictationFallbackReason | null): boolean {
  return reason === "exhausted" || reason === "signed_out" || reason === "not_entitled";
}

/** Has this observation stopped speaking for the present? An unstamped notice is NOT stale — we
 *  cannot prove it is, and the guard may only ever take down a banner it can prove has expired. */
function isStale(state: DictationEngineState, now: number): boolean {
  return (
    state.fallbackReason !== null &&
    state.observedAt !== null &&
    now - state.observedAt > FALLBACK_NOTICE_TTL_MS
  );
}

/** Does this observation belong to a capture session that has already ENDED?
 *
 *  The twin of `isStale`, on the other perishability axis, and it carries the same burden of proof:
 *  an observation with no session marker is treated as the present one, because we cannot prove it
 *  is not. Only a marker that DISAGREES with the running session takes a banner down.
 *
 *  `!==` rather than `<`: the counter only ever increments (`noteSessionStart` is its sole writer),
 *  so any disagreement means "not this session" — and an ordering comparison would quietly start
 *  painting again if the counter were ever reset to 0 by a store rehydration. */
function isFromEarlierSession(state: DictationEngineState): boolean {
  return state.observedSession !== null && state.observedSession !== state.captureSession;
}

/** Is this reason one the app-shell bar should ever SPEAK for?
 *
 * ── WHY `too-slow` IS RECORDED BUT NEVER PAINTED (sparkle-v3990) ────────────────────────────────
 * The bar exists so that a SILENT engine swap does not read as a broken feature — see this file's
 * header and the component's. That rationale holds for every reason that names a STANDING
 * condition with something the user can do about it: `unavailable`, `exhausted`, `signed_out`,
 * `not_entitled`, `too_many_streams` (and `mic_missed_hold`, whose whole point is that words were
 * LOST and a longer hold recovers them). `too-slow` is the opposite on every axis:
 *
 *   • PER-UTTERANCE. It is raised from `dictation://cloud-late`, which Rust emits from
 *     `start_cloud_stream`'s parked/discard arms — i.e. once the handshake completes LATE, which by
 *     construction is at or after the push-to-talk RELEASE. So it can only ever appear while no key
 *     is held and nothing on screen connects it to anything the user just did.
 *   • SELF-CORRECTING. The next utterance opens on the warm relay; nothing is standing.
 *   • NO REMEDY, and the `WARNING` copy says so outright: "the handshake being slower than a short
 *     utterance is ours to fix, not theirs". Even "try again" would be unsafe under its own trigger,
 *     because the retry hits the same race.
 *
 * Rendered anyway, it became a persistent amber alert: raised with no key held, held for the full
 * `FALLBACK_NOTICE_TTL_MS`, and re-stamped by every subsequent short hold — so under repeated short
 * holds, the ordinary push-to-talk pattern, it was up essentially permanently. Pure alarm with no
 * action, and it cost two false "the microphone is broken" reports from the founder.
 *
 * THE SUPPRESSION IS PRESENTATION ONLY, deliberately. The reason is still recorded, the stamp still
 * taken, `noteCloudConnectedLate` still runs in full and the `[dictation] cloud open attempt`
 * console diagnostic is untouched — knowing the handshake lost the race is exactly the signal the
 * latency fix is verified against, so none of it may be thrown away. The one thing that changes is
 * that it no longer shouts.
 *
 * AND IT LIVES HERE, NOT IN THE COMPONENT. `shouldWarnLocalEngine` is the single place the "should
 * the bar be up?" rule lives — the component says so in as many words — so deriving this there
 * would be a second copy to drift. */
export function fallbackReasonWarrantsBanner(
  reason: DictationFallbackReason,
): boolean {
  return reason !== "too-slow";
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
    state.fallbackReason !== null &&
    fallbackReasonWarrantsBanner(state.fallbackReason) &&
    !state.dismissed &&
    !isStale(state, now) &&
    !isFromEarlierSession(state)
  );
}

// `CloudEndedFacts` / `fallbackReasonForEnded` lived here and are GONE (roborev 60355). The
// classifier had exactly two production callers and both passed the same literal
// `{ exhausted: false, streamOpened: true }` — a constant `"too-slow"` dressed as a decision, whose
// other two branches only ever ran in its own tests. Worse, going through it is what let those call
// sites write the store directly and escape the `exhausted`-preservation and corroboration-counter
// invariants above. `noteCloudConnectedLate` replaces it: the decision now lives where the state it
// depends on lives, so it cannot be taken with a hardcoded fact again.

// ── WHAT DID THIS ATTEMPT'S HANDSHAKE ACTUALLY DO? ──────────────────────────────────────────────
// `start_cloud_stream` answers with a bool, and `false` covers THREE different things:
//
//   1. it never connected                        → an ambiguous refusal; corroborate (openRefusals)
//   2. it connected, too late to install         → `dictation://cloud-late`  → too-slow, immediately
//   3. it connected for a generation that has
//      since rotated (an ORPHAN of a stopped
//      session, landing 1-6 s late)              → `dictation://cloud-orphan` → NO EVIDENCE AT ALL
//
// The Rust side knows which; these latches carry that fact the few milliseconds from the event
// listener to the invoke's continuation, which is where the store gets written.
//
// (3) IS NOT THE SAME AS SILENCE, and treating it as such is what roborev 60365 caught: the orphan's
// `Ok(false)` fell through to the corroboration counter, which is GLOBAL, so it was charged to the
// SUCCESSOR episode. Two rapid re-holds — the ordinary push-to-talk pattern, and precisely the one
// that rotates generations — reached the threshold and claimed Sparkle "can't reach the cloud
// transcription service" over a relay that had just completed two handshakes.
//
// SCOPED TO ONE ATTEMPT, which is the part that matters. A latch left set from a previous utterance
// would report a genuine outage as a timing fault — the same false banner, aimed the other way — so
// `noteCloudLateAttemptStart` clears both before every invoke and is the only thing that does.
let cloudLateThisAttempt = false;

/** Called before each `start_cloud_stream`, so the latches can only describe the attempt in flight. */
export function noteCloudLateAttemptStart(): void {
  cloudLateThisAttempt = false;
}

/** The relay connected but was not installed (raced the stop), for THIS generation. */
export function noteCloudLate(): void {
  cloudLateThisAttempt = true;
}

export function sawCloudLateThisAttempt(): boolean {
  return cloudLateThisAttempt;
}

// ── WHY THERE IS NO ORPHAN MACHINERY HERE AT ALL ────────────────────────────────────────────────
// There used to be two mechanisms: an orphan LATCH (`noteCloudOrphan` / `takeCloudOrphanThisAttempt`)
// for the ordering where the event arrived before the invoke resolved, and a charged-refusal latch
// plus a `withdrawOrphanedRefusal` action for the ordering where it arrived after. Both were
// necessary while `start_cloud_stream` answered a bare bool, whose `Ok(false)` covered an orphan and
// a genuine refusal alike.
//
// BOTH ARE DEAD IN THE OUTCOME WORLD, AND WORSE THAN DEAD (roborev 60408/60429). Both arms that
// emit an orphan return `CloudStreamOutcome::Raced` (`dictation.rs`, the `None if parked` and
// `Some(s)` arms), which classifies as `ignore` — a no-op. So for the attempt that PRODUCED the
// orphan, neither mechanism changes anything: it charges nothing to withdraw, and it records
// nothing to suppress. The only thing either could still reach was a DIFFERENT attempt's — a
// withdrawal taking down a second window's genuinely earned banner, or a latch swallowing the one
// outcome that is real evidence (`unreachable`), in the same window's next attempt or in another
// window entirely, since the event is an `app.emit`. A mechanism that can only ever fire wrongly is
// deleted, not gated: focus (`isCapturable()`) was tried as a stand-in for attempt ownership and is
// not one.
//
// THE INVARIANT THIS RESTS ON, stated so a future change cannot quietly break it: an orphan's own
// attempt resolves `Raced`. If a raced arm is ever made to answer something else, the frontend has
// to learn about attempt identity — a payload on the event — rather than re-introducing a latch.

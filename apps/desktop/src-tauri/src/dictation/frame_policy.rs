//! Per-frame and per-focus-change POLICY for the capture callback and the focus reconciler.
//!
//! Seven of the eight items are pure total predicates over plain booleans/counters. That is
//! deliberate: the callers all need a live `Capture`, an `AppHandle`, or the CoreAudio realtime
//! thread, so a decision left inline with them is a decision that cannot be tested — which is how
//! the `cloud_active || vad_detected` bug in `frame_speaking` survived for a whole release.
//!
//! **`dispatch_closed_segments` IS THE EXCEPTION — it is not a predicate.** It takes the decode
//! `SyncSender` and `&mut crate::audio::PreRoll`, `try_send`s, clears the pre-roll, and logs. It
//! lives here because it owns the accept-THEN-clear ORDERING (see its own doc), which is a
//! regression that was reverted twice. Do not generalise the purity of its neighbours onto it: it
//! is not side-effect-free, so it is not freely hoistable, skippable, or safe to call twice — a
//! second call re-`try_send`s and re-clears the ring.
//!
//! NOTE: `frontmost.rs` has its own separate `should_emit_blur` and its own
//! `FOCUS_BLUR_COALESCE_MS = 120`. These are two independent definitions holding DELIBERATELY THE
//! SAME value — `frontmost.rs`'s own doc says "Matches
//! `dictation::frame_policy::FOCUS_BLUR_COALESCE_MS`" — because both encode the same macOS
//! `resignKey`→`becomeKey` gap. Treat it as a drift hazard to consolidate, not a coincidence:
//! editing one does NOT edit the other, and re-measuring that OS window means changing BOTH, or the
//! two deferred blurs commit at different times. (That pointer used to say "dictation.rs"; moving
//! the constant here made it stale, so it was corrected in the same commit — the two must agree.)

use std::sync::mpsc::{SyncSender, TrySendError};

/// The waveform's "is the user speaking right now?" signal for one captured frame — the source of
/// the edge-triggered `dictation://speaking` events.
///
/// It is the Silero VAD's real-time detection on BOTH paths, and the cloud path is the fix: this
/// used to return `cloud_active || vad_detected`, so for the entire life of a cloud stream the
/// waveform animated unconditionally, whether or not anyone was speaking.
///
/// That is not merely distracting, it is DISHONEST, and it is a direct cause of the 2026-07-29
/// incident. A waveform moving on ambient noise (or on nothing at all) looks exactly like one
/// capturing your voice — so the user talked for nine minutes at a microphone that was delivering
/// digital silence, reassured by a meter that was animating for reasons unrelated to their speech.
///
/// A STILL waveform is now a feature: motion means the engine is actually hearing speech, so
/// stillness while you talk is a glance-level symptom that something is wrong, and the
/// "no audio from <device>" notice names the cause. Deliberately the VAD and NOT raw input level —
/// gating on level alone would let a noisy room animate it again, which is the bug in a new hat.
///
/// The capture callback therefore feeds the VAD on the cloud path too (discarding the segments,
/// since Deepgram is doing the transcribing) — the cheap windowing it already ran on-device.
pub(crate) fn frame_speaking(_cloud_active: bool, vad_detected: bool) -> bool {
    vad_detected
}

/// Advance the "has this VAD segment touched the cloud path?" latch by one captured frame.
///
/// Returns `(latch_for_the_next_frame, this_segment_is_the_relay's)`. When the second is true the
/// closed segment must be DROPPED, never handed to the on-device decoder.
///
/// A segment spans many frames but is only handed over when it CLOSES, so asking "is the cloud
/// active?" at close time answers the wrong question. A segment that opened while Deepgram was
/// streaming and closed just after `cloud_active` flipped false — a mid-stream disconnect or a
/// credits-exhausted teardown, both supported fallbacks — would be decoded on-device and emitted as
/// a `dictation://partial`, which the frontend commits as text. The relay already transcribed and
/// typed that audio, so the user gets the tail of their own sentence a second time, up to
/// `max_speech_duration` (8 s) of it. Latching across the whole span is what makes "the relay owns
/// this audio" true for the segment rather than for one frame (roborev 55300).
///
/// Pure so the straddle is testable: the real thing needs a CoreAudio callback and a loaded VAD.
pub(in crate::dictation) fn segment_cloud_latch(touched: bool, cloud_now: bool, segment_closed: bool) -> (bool, bool) {
    let touched = touched || cloud_now;
    if segment_closed {
        // The next segment starts from wherever we are NOW, not from this segment's history.
        (cloud_now, touched)
    } else {
        (touched, false)
    }
}

/// Hand every closed segment to the decode worker, then let the pre-roll forget what the decoder
/// ACCEPTED — in that order, which is the whole point of the function existing.
///
/// Returns how many segments the channel took, so a caller (and a test) can see the claim rather
/// than infer it.
///
/// ── WHY THIS IS A FUNCTION AND NOT FOUR LINES IN THE AUDIO CALLBACK ────────────────────────────
/// Because the bug was the ORDER, and an order is not something a pure predicate can pin. The first
/// attempt at this extracted only `accepted > 0`; the call site still re-implemented the sequence by
/// hand, so reverting it to the broken form (clear above the loop) left every test green — the
/// helper was covered and the behaviour was not (roborev, Medium, twice).
///
/// ── THE INVARIANT ──────────────────────────────────────────────────────────────────────────────
/// The ring only ever holds audio NO ENGINE HAS CLAIMED, and the subtlety is what counts as a claim.
/// OFFERING a segment to the decoder is not one: `try_send` is deliberately lossy — a full queue
/// drops it (`DECODE_QUEUE_CAP`, the documented "burst, or a slow machine") and a disconnected one
/// swallows it. Clearing on the offer meant that on exactly those paths the audio was gone from BOTH
/// engines: never decoded on-device, and no longer in the ring for the relay to recover. A slow
/// machine is precisely when the queue fills AND precisely when the ring is what saves the words.
///
/// A claim is a segment the channel ACCEPTED — it will be decoded and typed into the composer as a
/// `dictation://partial`, so re-sending its audio to Deepgram on the next false→true edge would
/// transcribe it a second time. Any acceptance clears the whole ring: the ring is not per-segment,
/// so there is nothing finer to express.
pub(crate) fn dispatch_closed_segments(
    decode_tx: &SyncSender<Vec<f32>>,
    segs: Vec<Vec<f32>>,
    preroll: &mut crate::audio::PreRoll,
) -> usize {
    let mut accepted = 0usize;
    for samples in segs {
        // Non-blocking, drop-on-full: the audio thread must never block. A full queue (worker fell
        // behind) drops the newest segment; a disconnected channel (worker gone during teardown) is
        // a silent no-op.
        match decode_tx.try_send(samples) {
            Ok(()) => accepted += 1,
            Err(TrySendError::Full(_)) => tracing::warn!(
                target: "dictation",
                "decode queue full; dropping a segment (decoder fell behind); \
                 the pre-roll KEEPS this audio so the relay can still recover it"
            ),
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
    // AFTER the loop, and only for what was taken. Moving this above the loop is the regression the
    // tests beside `a_segment_the_decoder_refused_leaves_the_pre_roll_holding_the_audio` exist to
    // catch.
    if accepted > 0 {
        preroll.clear();
    }
    accepted
}

/// THE ON-DEVICE "the user is talking RIGHT NOW" signal — the auto-send countdown's cancel.
///
/// `dictation://speech-end` ARMS the clock; something has to be able to un-arm it, or "keep talking
/// and it waits" is a promise only one engine keeps. On the CLOUD path that job belongs to
/// `dictation://interim`, whose arrival means the user is speaking again. The on-device path has no
/// interim results at all — it decodes whole closed segments — so when the on-device speech-end was
/// added, arming gained a path that cancelling did not. A mid-thought pause long enough for Silero
/// to close a segment on a sentence that merely SOUNDS finished would start a clock that resumed
/// speech could not stop, because the next VAD segment does not close until the user pauses AGAIN.
///
/// This is that missing signal, and it is deliberately NOT `frame_speaking` above — but note WHY,
/// because the reason changed. `frame_speaking` used to be `cloud_active || vad_detected`, pinned
/// true for a whole cloud stream, and the original rationale here was that reading it as "still
/// talking" would suspend every cloud countdown forever. The 2026-07-29 dead-mic fix made it honest
/// (it is now the raw VAD flag on both paths), so that argument no longer holds and this doc used to
/// go on asserting it (roborev 55503).
///
/// The REAL reason the two must stay separate: on the cloud path the cancel belongs to
/// `dictation://interim`, which tracks Deepgram's own view of the utterance. A local VAD flag routed
/// into the same suspend-the-countdown role would fight it, and the VAD is not even trustworthy
/// there — the relay is consuming the audio, so what Silero sees is incidental. Hence this signal is
/// the VAD's real-time flag AND ONLY WHILE THE ON-DEVICE ENGINE OWNS THE AUDIO: meaningful on
/// exactly the path that needs it, inert on the one that has a better answer. Emitting it as its own
/// edge-triggered event keeps that distinction in the one place that knows which engine is running.
///
/// Consequence worth stating plainly, since collapsing the two is the tempting simplification: the
/// two functions now agree everywhere EXCEPT (cloud_active, vad_detected) = (true, true). That is
/// not a sign one is redundant — it is the whole point. There, the meter must move while the cancel
/// stays silent and lets `interim` do the job.
pub(crate) fn frame_on_device_speech(cloud_active: bool, vad_detected: bool) -> bool {
    !cloud_active && vad_detected
}

/// Whether the cpal mic capture should currently be live. Two conditions, both required:
///   - `armed`: the frontend wants the mic on (the user hasn't muted it).
///   - `focused`: at least one Sparkle window is the focused/active OS window.
///
/// When the user tabs to another app every Sparkle window blurs, `focused` goes false, and we
/// release the OS mic — so Sparkle never captures audio while you're looking at something else.
/// Pure so the arm×focus matrix is unit-testable without an audio device or real windows.
pub(crate) fn capture_should_be_live(armed: bool, focused: bool) -> bool {
    armed && focused
}

/// The capture transition to make given the desired vs. actual state — factored out of the reconcile
/// so the decision can be taken UNDER the session lock while the action it names (build or tear down)
/// is performed OUTSIDE it. That split is the fix for the sparkle-sfxu launch deadlock: `Capture::start`
/// (CoreAudio init) and `is_focused()` both block on the main thread, so from a worker they must never
/// run while the session Mutex — which the main thread's focus handler also takes — is held.
///   - `Build`: the mic should be live (`capture_should_be_live`) and no capture is installed yet.
///   - `Teardown`: the mic should NOT be live but a capture is still installed.
///   - `Idle`: already in the desired state — nothing to do.
///
/// Pure so the desired×actual matrix is unit-testable without an audio device or a window.
#[derive(Debug, PartialEq)]
pub(crate) enum CapturePlan {
    Idle,
    Build,
    Teardown,
}

pub(crate) fn plan_capture(should_be_live: bool, has_capture: bool) -> CapturePlan {
    match (should_be_live, has_capture) {
        (true, false) => CapturePlan::Build,
        (false, true) => CapturePlan::Teardown,
        _ => CapturePlan::Idle,
    }
}

/// `plan_capture`, but counting a build that is ALREADY IN FLIGHT as a capture that exists.
///
/// ── THE BUG THIS DELETES ────────────────────────────────────────────────────────────────────────
/// `sess.capture` is not written until `install_capture`, which runs AFTER the off-lock
/// `build_capture` (CoreAudio init, ~78 ms measured). Two reconciles landing inside that window both
/// read `has_capture == false`, both plan `Build`, and ONE `start_dictation` produces TWO captures
/// on the same device. Check-then-act, and it was the normal path, not an edge case:
/// sparkle.log.2026-08-06 has the pair 0.17 ms apart on every steady-state cycle, 202
/// `build_capture` against 180 `start_dictation` across the day.
///
/// The loser was then discarded by `install_capture`'s `still_current` re-check and logged as
/// "discarding a capture built during a stop/blur race" — 153 times, overwhelmingly with no stop and
/// no blur anywhere near it. Two separate investigations chased that phantom focus race.
///
/// ── WHY IT IS A SEPARATE FUNCTION AND NOT AN EXTRA `||` AT THE CALL SITE ────────────────────────
/// The Build arm of `take_reconcile_step` cannot be driven to completion in a test — `Capture::start`
/// needs a real audio device and `ParakeetTdt::new` a 482 MB model, neither present in CI — and with
/// no transcriber resident the arm falls through to `Idle` REGARDLESS of the plan. A test written
/// against `take_reconcile_step` would therefore pass identically with and without this fix: the
/// textbook vacuous test. Keeping the decision pure is the same reason `plan_capture` exists, and it
/// is the only shape in which this fix can actually be pinned.
pub(crate) fn plan_capture_for(
    should_be_live: bool,
    has_capture: bool,
    build_in_flight: bool,
) -> CapturePlan {
    // NOTE the asymmetry, which is deliberate: an in-flight build suppresses a second BUILD, and it
    // must not also suppress a TEARDOWN. `plan_capture(false, true)` is how a blur or a stop releases
    // the mic, and folding the marker in here is what lets that keep working — the capture about to
    // be installed is torn down by `install_capture`'s own `still_current` check, which is the one
    // path that can see it at all.
    plan_capture(should_be_live, has_capture || build_in_flight)
}

/// Whether a *deferred* blur should actually commit (release the mic + notify the frontend). We
/// defer acting on "no Sparkle window focused" by a tick because, on a window-to-window switch,
/// macOS delivers the old window's resignKey (`Focused(false)`) BEFORE the new window's becomeKey
/// (`Focused(true)`). Acting on the bare resignKey would spuriously pause active dictation, only to
/// resume a few ms later — cutting an utterance in half. The deferred re-check commits only when:
///   - `my_gen == latest_gen`: no newer focus event superseded this one (a becomeKey would have
///     bumped the generation), AND
///   - `!any_focused_now`: a re-poll still finds no Sparkle window focused (a real tab-away).
///
/// Pure so the coalescing decision is unit-testable without threads, timers, or real windows.
pub(crate) fn should_emit_blur(my_gen: u64, latest_gen: u64, any_focused_now: bool) -> bool {
    my_gen == latest_gen && !any_focused_now
}

/// Empirical coalescing window for a window-to-window focus switch. macOS delivers the old window's
/// resignKey (`Focused(false)`) and the new window's becomeKey (`Focused(true)`) within the same
/// runloop turn, microseconds apart; we wait this long before committing a blur so the becomeKey
/// supersedes it. Tradeoff: longer = safer coalescing if the OS is slow to deliver becomeKey under
/// load, but more latency before the OS mic is released on a genuine tab-away. 120ms sits comfortably
/// above the observed gap while staying imperceptible.
pub(in crate::dictation) const FOCUS_BLUR_COALESCE_MS: u64 = 120;

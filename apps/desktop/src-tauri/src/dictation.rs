//! Tauri commands wiring mic capture → transcriber → events.
//!
//! Two transcription engines sit behind this module:
//!   - **on-device** (Parakeet/Silero, `transcribe.rs`): the free, private, ALWAYS-AVAILABLE local
//!     path. Silero closes a VAD segment on a silence gap and the Parakeet transducer decodes it
//!     offline, off the realtime audio thread (`DecodeWorker`). It runs whenever the mic is hot and
//!     the cloud stream is not routing — i.e. it is both the fallback when the cloud is unavailable
//!     (signed out, out of credits, socket death) and the engine of record the rest of the time.
//!   - **cloud** (Deepgram Nova-3, `cloud.rs`): opened only once the user is actively dictating
//!     (the frontend's dictation phase reaches ACTIVE and calls `start_cloud_stream`), and closed
//!     on stop. While it's open the capture callback routes frames to Deepgram instead of the
//!     on-device model.
//!
//!     **WHAT THE CLOUD RECEIVES IS THE UTTERANCE PLUS A BOUNDED PRE-ROLL** (sparkle-oyapv). This
//!     used to read "the cloud only ever sees speech the user intended to dictate", and that is no
//!     longer the whole truth: on the frame the stream goes live, up to
//!     [`crate::audio::PREROLL_SAMPLES`] (2 s) of audio captured BEFORE the phase reached ACTIVE is
//!     flushed to Deepgram. That is the point — it is what stops the first words of a push-to-talk
//!     hold being lost to the ~375 ms-to-1.2 s the mic and socket take to come up — but it means
//!     audio from just before the key went down can leave the machine, so the boundary is stated
//!     here rather than left to be discovered in `audio.rs`.
//!
//!     Two things bound it. The ring is capped at `PREROLL_SAMPLES` and holds nothing else; and it
//!     is CLEARED whenever the on-device engine takes a closed segment as the engine of record, so
//!     audio already transcribed locally is never re-sent (see `PreRoll::clear`).
//!
//! WHAT MOVES THE PHASE, since this module's job is to react to it: the three-position send tray
//! (`voice/sendMode`, `voice/dictationPhase`). **Speak** holds ACTIVE for as long as the tray sits
//! there; **Push to talk** is PASSIVE at rest and ACTIVE for the duration of a hold; **Send**
//! releases the mic. There is no wake word and no stop word — both were retired (PR #1160); every
//! transition here is driven by that tray, by window focus, or by the relay itself.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use crate::audio::{assess_capture_health, rms_level, AudioHealth, Capture, ZeroSource};
use crate::audio_devices::DeviceChoice;
use crate::cloud::{CloudAudioSender, DeepgramSession};
use crate::model;
use crate::transcribe::{Decoder, ParakeetTdt};


/// The 8 `#[tauri::command]` entry points — see `commands.rs`. Their `lib.rs` handler paths name
/// `dictation::commands::<name>` and must keep naming whichever module defines the fn:
/// `generate_handler!` rewrites the last path segment into a `__cmd__<name>` MACRO invocation, and
/// that macro only exists next to the definition. Mis-POINTING a path is compiler-caught (E0433);
/// DROPPING one from `generate_handler!` is not — it compiles green and fails at runtime with
/// "command not found". Both measured on tauri 2.11.3; `commands.rs`'s header has the detail.
pub(crate) mod commands;


/// The `dictation://…` emitters for transcript text, the auto-send rail's speech signals, and the
/// cloud stream's end/balance frames, plus their log sampling — see `events.rs`. `pub(crate)`
/// because `cloud.rs` emits through them directly; nothing else in the crate should.
/// NOT the whole event surface: the capture/health/focus events are still emitted inline from this
/// file, and `model-progress`/`final` from `commands.rs`. Audit `dictation://` across the tree
/// rather than assuming any one file enumerates it.
pub(crate) mod events;
use events::{emit_on_device_speech, emit_partial, emit_speech_end};


/// Which transcription engine to use. The on-device model is always the fallback; the cloud path
/// is chosen only when the user enabled it, a key is present, AND the credits seam allows it.
#[derive(Debug, PartialEq, Clone, Copy)]
pub(crate) enum Engine {
    Cloud,
    Local,
}

/// Whether a freshly-opened cloud session should be installed after the (blocking) Deepgram
/// handshake, or discarded because a stop/restart raced it. Pure so the concurrency matrix is
/// unit-testable without sockets or threads:
///   - `same_generation`: the session's Arcs are still the ones we captured (no stop_dictation +
///     start_dictation swapped in a fresh session generation while we connected).
///   - `still_current`: the cloud epoch is unchanged (no stop_cloud_stream / stop_dictation / racing
///     start bumped it since we claimed our attempt).
///   - `capture_present`: the mic capture is still live (not torn down by a stop).
///   - `already_active`: a cloud stream is already installed (a racing start won).
///
/// Install only when the intent that opened this stream is still exactly current.
///
/// CALLER CONTRACT: all four inputs MUST be sampled while holding `DictationState`'s lock (the same
/// critical section that then stores the session), so the decision and the install are atomic. This
/// helper is pure for testability only — evaluating any input outside the lock reopens the TOCTOU
/// the epoch guard closes.
pub(crate) fn should_install_cloud(
    same_generation: bool,
    still_current: bool,
    capture_present: bool,
    already_active: bool,
) -> bool {
    same_generation && still_current && capture_present && !already_active
}

/// After a build is INVALIDATED — discarded on install, or failed outright — does the session still
/// want a capture that nobody is going to build?
///
/// WHY THIS IS A FUNCTION AND NOT AN INLINE `if`. `plan_capture_for` treats an in-flight build as an
/// existing capture, which DROPS a reconcile rather than deferring it, and nothing re-runs it if the
/// build it deferred to never lands. So whoever invalidates a build owns re-issuing the request it
/// was suppressing — and there are TWO such places (`install_capture`'s discard, and the `Err` arm
/// of `reconcile_capture`), which is exactly the shape that drifts. Both call it; neither is
/// driveable in CI (a real `Capture`, `DecodeWorker` and `AppHandle`), which is why the decision is
/// extracted rather than written twice at the call sites (roborev 60351).
pub(crate) fn discard_needs_reissue(should_be_live: bool, has_capture: bool) -> bool {
    should_be_live && !has_capture
}

/// Everything a FRESH ARM resets, as one named transition rather than six lines inline in
/// `start_dictation` (roborev 60387).
///
/// The cloud Arcs are a new GENERATION, so `start_cloud_stream`'s `ptr_eq`/epoch guards correctly
/// invalidate any stream that raced a prior stop+start — including `cloud_tx`, which mirrors `cloud`
/// and must never survive into a new arm. `build_failure_reissued` is refunded for the same reason
/// in a different currency: a user who mutes and unmutes is making a NEW attempt, and inheriting a
/// budget the previous one spent would leave this arm's stale-attempt failure recoverable only by
/// the watchdog, ~3 s later. Written inline that refund was invisible to the suite and silently
/// deletable; as a function it is one assertion.
pub(crate) fn note_fresh_arm(sess: &mut DictationSession) {
    // CARRY A WARM SOCKET ACROSS THE ROTATION — without this the whole warm-standby design is
    // unreachable for push to talk, which is how it is armed.
    //
    // Push-to-talk RELEASE goes all the way to `setEnabled(false)` (`useMicActions::setOff` — the
    // hold's resting state), so every hold ends in `stop_dictation` and every next hold starts in
    // `start_dictation`, i.e. HERE. Replacing the slot with an empty Arc drops whatever was parked
    // in it, so a socket banked by the previous hold was destroyed by the next hold's arm before
    // `start_cloud_stream` could ever reach `cloud_reuse`'s `Resume` path. Warm standby only ever
    // worked for the Speak-tray path, where `enabled` stays true and no rotation happens.
    //
    // The generation guards are UNCHANGED and still do their job: all four Arcs are new, so
    // `start_cloud_stream`'s `ptr_eq`/epoch checks still invalidate any stream that raced a prior
    // stop. What moves is the parked SESSION, not the Arc identity — into the new slot, where the
    // next `cloud_reuse` finds it and resumes with no handshake.
    //
    // THE GATE IS `is_alive()` ALONE — NOT `is_parked() && is_alive()`, and that distinction is the
    // whole correctness of the reuse hold (roborev 61450, High).
    //
    // On the REUSE hold the two commands run in the opposite order to the intuition: nothing has to
    // handshake, so `start_cloud_stream` reaches `cloud_reuse`'s `Resume` arm IMMEDIATELY — it calls
    // `resume()` (clearing `parked`), flips `cloud_active` true and returns `Resumed` — and only
    // ~40 ms later does `start_dictation` arrive here. A `is_parked()` gate therefore sees a session
    // that was un-parked microseconds ago, declines to carry it, and `sess.cloud = Arc::new(None)`
    // drops the LAST handle to a socket that is live and already being metered. `Drop` only signals
    // Close (it does not `silence_now()`), so the just-resumed socket is torn down mid-hold, audio
    // silently falls back on-device, and a `cloud-ended` fires into the generation that just armed —
    // the exact speak-into-the-successor hazard every other path guards. The frontend, meanwhile,
    // was told `Resumed` and started billing. Strictly worse than the bug this change fixes.
    //
    // So the carry is ordering-independent: any ALIVE session crosses, parked or routing, and its
    // routing flag crosses WITH it. A dead worker is a corpse `cloud_reuse` would reject anyway and
    // is left in the old Arc to drop exactly as before.
    //
    // Carrying a ROUTING session is not a hazard, because carrying is the opposite of the
    // speak-into-the-successor shape: that hazard is a session torn down ALONGSIDE a live
    // replacement, whereas here the session simply continues — it IS the successor. Project
    // attribution is unaffected: the next `start_cloud_stream` re-checks `is_for_project` and
    // reopens on a mismatch.
    //
    // `cloud_tx` is rebuilt from the carried session rather than reused, so the slot and the sender
    // stay faithful mirrors (the invariant `park_raced_stream` and `install_live_stream` both keep).
    let was_active = sess.cloud_active.load(Ordering::Relaxed);
    let carried = carry_alive_across_arm(&sess.cloud);
    let carried_tx = carried.as_ref().map(DeepgramSession::audio_sender);
    // Only a carried session may bring a `true` routing flag with it: an empty slot with
    // `cloud_active` true would tell the callback to route at a sender that isn't there.
    let still_routing = carried.is_some() && was_active;
    sess.cloud = Arc::new(Mutex::new(carried));
    sess.cloud_active = Arc::new(AtomicBool::new(still_routing));
    sess.cloud_epoch = Arc::new(AtomicU64::new(0));
    sess.cloud_tx = Arc::new(Mutex::new(carried_tx));
    sess.armed = true;
    sess.build_failure_reissued = false;
}

/// What `stop_dictation` does with the cloud socket: PARK it in warm standby for the next hold, or
/// hand it back for teardown.
///
/// Extracted from the command for the reason AGENTS.md names as the recurring vacuity trap: a
/// decision written inline in a `#[tauri::command]` needs an `AppHandle` and a `State`, so it is not
/// driveable by any test — delete it and the suite stays green while the bug comes straight back.
/// The predicate itself (`should_keep_warm_on_stop`) already had a table test; what had NO test was
/// the call site, which is the half that actually decides whether a socket survives a hold.
///
/// Returns `Some(session)` when the caller must tear it down (already taken out of the slot), and
/// `None` when it has been parked and deliberately LEFT in the slot alongside its sender — the pair
/// `note_fresh_arm` then carries into the next hold's generation.
///
/// `was_active` is the pre-stop value of `cloud_active`, sampled by the caller before it clears it.
pub(crate) fn park_or_take_on_stop(
    sess: &DictationSession,
    was_active: bool,
) -> Option<DeepgramSession> {
    let mut cloud = sess.cloud.lock().unwrap_or_else(|p| p.into_inner());
    let keep_warm = cloud
        .as_ref()
        .map(|s| should_keep_warm_on_stop(was_active, s.is_alive(), s.is_parked()))
        .unwrap_or(false);
    if keep_warm {
        // pause() Finalizes, so the released utterance's trailing text still commits exactly as
        // finish()'s flush did — the only difference is that the connection survives.
        cloud.as_ref().unwrap().pause();
        None
    } else {
        // Nothing worth keeping (never routed, already dead, or no socket at all): tear it down
        // exactly as before, and drop the callback's sender handle with it so `cloud_tx` stays a
        // faithful mirror of `cloud`.
        *sess.cloud_tx.lock().unwrap_or_else(|p| p.into_inner()) = None;
        cloud.take()
    }
}

/// What happens to a capture that has just finished building.
///
/// ── WHY THIS IS A CLASSIFIER AND NOT A BOOL (the founder's "it doesn't recognize the mic") ───────
/// `install_capture` decided this with one `still_current` bool and logged EVERY rejection as
/// "discarding a capture built during a stop/blur race". That single line covers three unrelated
/// situations, only ONE of which costs the user their words — and the file's own comment records
/// that the misattribution "sent two investigations hunting a focus race".
///
/// Measured on 2026-08-09, load average 291: the device bound successfully 41/41 times and never
/// once failed, yet 27 captures were discarded and **at least 12 holds had their first audio sample
/// arrive AFTER the user had already let go**. `capture_ms` climbed from 232 ms early in the day to
/// 2083 ms under load, against push-to-talk holds of ~345 ms. So the microphone is neither missing
/// nor held by another app — it simply cannot come up inside a short hold on a loaded machine, and
/// the audio is then thrown away. From the user's seat that is indistinguishable from "the mic is
/// not being recognised", which is exactly how it was reported.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum CaptureFate {
    /// Intent is still current — install it and start routing.
    Install,
    /// THE HOLD PRODUCED NOTHING. The user released (or the window blurred) before this capture
    /// finished building, and no other capture is live to have caught the words. This is the one
    /// case that owes the user an explanation, and the one the relay banner must never speak for.
    MissedTheHold,
    /// Another capture is already installed and routing, so this one merely lost a build race. The
    /// user's audio was captured by its sibling — nothing is owed and nothing is lost.
    LostToASibling,
    /// The session generation rotated (a stop+start swapped in fresh Arcs), so this capture is stale
    /// against state nobody holds.
    Stale,
}

/// Decide a freshly-built capture's fate. Pure, so the distinction that decides whether the user is
/// TOLD they lost their words is unit-testable without CoreAudio, an `AppHandle` or a real device.
///
/// Argument order mirrors the `still_current` expression it replaces, so the three terms stay
/// readable against the original: does the session still want a capture, is the slot free, and is
/// this capture's transcriber still the live generation.
pub(crate) fn classify_capture_fate(
    wants_capture: bool,
    slot_empty: bool,
    same_generation: bool,
) -> CaptureFate {
    if wants_capture && slot_empty && same_generation {
        return CaptureFate::Install;
    }
    // ORDER MATTERS, and it is about who is owed an explanation rather than about precedence in the
    // boolean sense. A rotated generation is stale whatever else is true — its words belong to a
    // session the user already left. An occupied slot means a sibling capture caught the audio. Only
    // once both of those are excluded does a capture that nobody wants mean the user lost anything.
    if !same_generation {
        return CaptureFate::Stale;
    }
    if !slot_empty {
        return CaptureFate::LostToASibling;
    }
    CaptureFate::MissedTheHold
}

/// WHICH STAGE LOST THE HOLD — the one definition of the `dictation://capture-missed` wire values.
///
/// ── WHY AN ENUM AND A CONSTRUCTOR, NOT TWO `json!` LITERALS (roborev 61729) ──────────────────────
/// The payload was built inline in TWO files, with `"stage"`, `"ms"`, `"capture"` and `"model"` as
/// bare string literals on each side and a hand-written TS union reading them. Nothing tied the
/// three together, and the consequence is no longer cosmetic: the frontend picks which REMEDY to
/// show off `stage`, so a renamed key or a mistyped value silently falls back to the capture branch
/// and tells a user to "hold the key a moment longer" against a 46-second model load — reinstating
/// the exact defect the stage split was added to fix, with no type error and no failing test.
///
/// This is the Rust→TS seam AGENTS.md warns about, where both halves stay green and the merge is
/// clean. `capture_missed_payload` is now the only way to build it, and
/// `the_capture_missed_payload_is_the_shape_typescript_parses` pins the serialized bytes against the
/// same literal the vitest side parses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MissedStage {
    /// The model was ready; the CoreAudio capture was still building when the key came up.
    /// Clears with a longer hold.
    Capture,
    /// The on-device model was still loading, so no capture was ever attempted. A longer hold
    /// cannot clear this — only waiting for the load (or the boot preload) can.
    Model,
}

impl MissedStage {
    /// The wire token. Kept beside the enum so the two cannot drift.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            MissedStage::Capture => "capture",
            MissedStage::Model => "model",
        }
    }
}

/// Build the `dictation://capture-missed` payload. The ONLY constructor — both emitters call it, so
/// the key names exist once rather than once per call site.
pub(crate) fn capture_missed_payload(stage: MissedStage, ms: u64) -> serde_json::Value {
    serde_json::json!({ "stage": stage.as_str(), "ms": ms })
}

/// Which generation's `cloud_active` flag guards the park decision.
///
/// `raced_stream_disposition`'s `already_active` term means "never shadow a session that is actively
/// routing" — so it must describe the generation the socket would be parked INTO. `ParkWarm` parks
/// into the captured generation and `ParkCurrent` into the current one, so the source has to follow.
///
/// TAKES THE FLAGS THEMSELVES, NOT TWO BOOLS — so the choice cannot be made (or reverted) at the
/// call site at all (roborev 61465, Medium).
///
/// The first version of this helper took `(same_generation, captured: bool, current: bool)`, which
/// moved the NAME of the decision into a tested unit while leaving the decision itself — which
/// `AtomicBool` gets read — back at the undriveable call site. Reverting that line to
/// `already_active`, or simply swapping the two adjacent `bool` arguments, compiled cleanly and kept
/// every test green. That is the exact hazard this module's own `Installed` struct is documented
/// against ("NAMED fields, not a bool pair: a caller that swapped `is_alive()` for
/// `is_for_project()` in a tuple would compile and mis-bill silently").
///
/// With both sources passed in, the call site has exactly one way to spell it and the sourcing rule
/// lives where a test can drive it against a real `DictationSession`.
///
/// `raced_stream_disposition`'s `already_active` term means "never shadow a session that is actively
/// routing", so it must describe the generation the socket would be parked INTO: `ParkWarm` parks
/// into the captured generation, `ParkCurrent` into the current one. Reading the captured flag on
/// both paths left the guard inert precisely in the rotated case `ParkCurrent` enables (roborev
/// 61450, Medium).
pub(crate) fn park_target_active(
    same_generation: bool,
    captured: &AtomicBool,
    sess: &DictationSession,
) -> bool {
    if same_generation {
        captured.load(Ordering::Relaxed)
    } else {
        sess.cloud_active.load(Ordering::Relaxed)
    }
}

/// Take an ALIVE session out of the outgoing generation's slot so a fresh arm can inherit it.
///
/// Extracted so the predicate is testable on a real session slot without an `AppHandle` or a relay,
/// and so "which sessions may cross a generation boundary" is one statement rather than a condition
/// buried in `note_fresh_arm`'s Arc swaps.
///
/// DELIBERATELY NOT gated on `is_parked()` — see `note_fresh_arm` for why that gate dropped a live,
/// already-metered socket on exactly the reuse hold this whole change exists to make fast.
///
/// Returns `None` — leaving the slot untouched — for a dead worker or an empty slot, so the caller's
/// old Arc drops it exactly as it always did.
fn carry_alive_across_arm(cloud: &Mutex<Option<DeepgramSession>>) -> Option<DeepgramSession> {
    let mut slot = cloud.lock().unwrap_or_else(|p| p.into_inner());
    let carryable = slot.as_ref().map(|s| s.is_alive()).unwrap_or(false);
    if carryable {
        slot.take()
    } else {
        None
    }
}

/// The whole lock-scoped decision `reconcile_capture` takes when a build returns `Err`: clear the
/// in-flight marker, then answer whether to re-issue the reconcile that build was suppressing.
///
/// WHY THIS IS BOUNDED AND THE DISCARD PATH IS NOT (roborev 60384). `install_capture`'s discard
/// terminates on its own: it re-issues only on a transcriber-generation mismatch, and the re-issued
/// build installs against the current generation. A FAILED build has no such stopping condition —
/// the failure is a property of the DEVICE, and the re-issued reconcile plans a fresh `Build`
/// because the marker that would have suppressed it is cleared on the line above. Left ungated,
/// a mic that cannot open at all (no input device, revoked TCC grant, device held elsewhere)
/// recurses `reconcile_capture` → `build_capture` → `Err` → `reconcile_capture` … on the calling
/// thread, blocking in CoreAudio init and emitting a `dictation://error` per lap until the stack
/// runs out. So the retry is a ONE-SHOT budget (`build_failure_reissued`), exactly like the
/// watchdog's `audio_reacquired`: the stale-attempt case gets its retry, and a persistently failing
/// device falls through to the watchdog's escalation instead of spinning here.
///
/// Takes `&mut DictationSession` rather than two bools so the marker clear, the want-a-capture test
/// and the budget are pinned TOGETHER by a test on a real session — the ordering (clear before
/// decide) is what makes the recursion reachable, and a truth-table test over bare bools cannot see
/// it.
pub(crate) fn note_build_failed(sess: &mut DictationSession) -> bool {
    // Clear the in-flight marker so the watchdog stops treating this as a build still running and
    // can escalate/retry.
    sess.build_started_at = None;
    let wants_capture = discard_needs_reissue(
        capture_should_be_live(sess.armed, sess.focused, sess.capture_warm_now()),
        sess.capture.is_some(),
    );
    if !wants_capture || sess.build_failure_reissued {
        return false;
    }
    sess.build_failure_reissued = true;
    true
}

/// What to do with a relay socket whose blocking handshake was raced by a stop/restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RacedStream {
    /// Intent is still current — install it and start routing audio.
    InstallLive,
    /// A stop landed while we were connecting, but this session generation is still the live one
    /// and its slot is empty. PARK it in warm standby instead of throwing it away.
    ParkWarm,
    /// The generation ROTATED while we were connecting, but the mic is armed right now and the
    /// CURRENT generation's slot is empty — so this pristine socket is exactly what the live session
    /// needs. Park it into the CURRENT Arcs (not the captured, now-stale ones).
    ///
    /// ── THE MEASURED DEFECT THIS EXISTS FOR (74.3% of all sockets) ──────────────────────────────
    /// Push-to-talk fires `start_cloud_stream` and `start_dictation` from ONE gesture
    /// (`setEnabled(true); setPhase("active")`), and they race. The handshake begins ~40 ms BEFORE
    /// `start_dictation` reaches `note_fresh_arm`, so it captures generation G and lands into G+1 —
    /// rotated by its own arm. Under the old rule that read as an unsalvageable orphan and was
    /// silenced and closed. Every time: 735 of 989 sockets over Aug 1-9 (87% on one day, 94% on
    /// another), each costing a full TLS+WS handshake and an up-front `firstMinuteCents` debit for a
    /// connection that carried no audio at all. It is why a short hold never gets the live preview —
    /// there was never a warm socket to reuse, because every one of them was destroyed on arrival.
    ///
    /// WHY THIS IS SAFE, and it is the same property the Discard arm already relies on: a socket
    /// reaching this decision has NEVER ROUTED AUDIO. It was just handshaked and was never installed,
    /// so Deepgram has received nothing from it and has nothing to transcribe. The
    /// speak-into-the-successor hazard that `Discard` and `silence_now()` exist for — a torn-down
    /// session draining ITS trailing transcripts into a live successor — is vacuous here, because
    /// there are no trailing transcripts to drain. `start_cloud_stream`'s own discard arm says so in
    /// as many words: "This orphan never routed audio, so muting loses nothing."
    ///
    /// The guards that remain are the ones that are NOT vacuous: `armed` (never bank a socket
    /// against a mic the user turned off), `slot_empty` (never clobber an occupant), and
    /// `!already_active` (never shadow a routing session).
    ParkCurrent,
    /// The session generation moved on and nothing wants this socket (the mic is muted, or the
    /// current slot is already claimed), so it is an orphan against state nobody holds. It must be
    /// silenced and closed.
    Discard,
}

/// Decide the fate of a socket that finished handshaking into a stop/again race.
///
/// Every one of these used to be thrown away — the `discarding cloud stream opened during a
/// stop/again race` line appears repeatedly in the 2026-07-29 log, and each occurrence cost a full
/// TLS+WS handshake AND an up-front `firstMinuteCents` debit for a connection that carried no audio
/// at all. The user was paying real money for the churn.
///
/// Most of those races are survivable. The common trigger is a window blur (capture paused) or a
/// stop landing mid-handshake (the tray leaving Speak, a push-to-talk hold released, the idle-relay
/// park) — neither of which invalidates the SESSION, only the routing. If
/// the generation is unchanged and nothing else has claimed the slot, parking the socket makes the
/// next utterance reuse it via `cloud_reuse`'s `Resume` path: no second handshake, and the minute
/// already paid for gets used instead of discarded.
///
/// `Discard` remains for the cases that genuinely cannot be salvaged — a different session
/// generation, whose Arcs this socket is no longer attached to, and a MUTED mic (see `armed`).
pub(crate) fn raced_stream_disposition(
    install: bool,
    same_generation: bool,
    armed: bool,
    slot_empty: bool,
    already_active: bool,
) -> RacedStream {
    if install {
        return RacedStream::InstallLive;
    }
    // Four conditions, and `armed` is the subtle one.
    //
    // `same_generation` alone does NOT mean the session is still live: `stop_dictation` (the mute)
    // disarms and empties the slot but does NOT rotate the cloud Arcs — only a fresh `start_dictation`
    // arm does that. So a handshake landing just after a mute sees an unchanged generation and an
    // empty slot, and without this guard would park a live socket against a MUTED microphone.
    //
    // That is not merely wasteful. If the user un-mutes inside the 8s warm window, the arm installs
    // fresh Arcs and the old `Arc<Mutex<Option<DeepgramSession>>>` drops with the parked session
    // still inside it — and `Drop for DeepgramSession` only signals Close: it does NOT `silence_now()`,
    // so the worker drains and forwards its trailing transcripts and then emits `cloud-ended` into
    // the generation that just armed. That is exactly the speak-into-the-successor hazard the discard
    // path silences against (roborev 50498/52646/53024): a stray final lands in the new composer, and
    // the stray `cloud-ended` drives the frontend to stop the successor's stream.
    //
    // A blur — the race this whole path exists for — keeps `armed` true (it drops the capture, not
    // the session), so parking still happens where it pays.
    if armed && slot_empty && !already_active {
        // Same three guards either way; only WHICH Arcs receive the socket differs. Splitting the
        // two dispositions rather than widening `ParkWarm` is what stops the caller parking a
        // rotated socket into the captured (stale) `cloud_tx` — a slot and a sender that no longer
        // mirror each other, which is the bug a single variant would have invited.
        return if same_generation { RacedStream::ParkWarm } else { RacedStream::ParkCurrent };
    }
    RacedStream::Discard
}

/// What the frontend should be told about a raced stream — THREE outcomes, not two.
///
/// `Ok(false)` alone cannot carry this: it means only "do not meter", and the frontend's fallback
/// story needs to tell three different things apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LateReport {
    /// WE CONNECTED, for the session the user is in right now, and then did not install it. Drives
    /// the `too-slow` banner: reachability is PROVEN, so any copy about the network would be false.
    Late,
    /// An orphan of a generation that has already rotated — a handshake for a session the user
    /// stopped, landing 1-6 s late (measured) while a successor may already be live and painting
    /// interims. NO EVIDENCE EITHER WAY, and that is the whole point: it must not light the banner
    /// (it would describe "that utterance" over a working stream), and it must not reach the
    /// corroboration counter either. Suppressing only the banner was not enough — the counter is
    /// global, so the orphan's `Ok(false)` was still attributed to the SUCCESSOR episode, and a
    /// rapid re-hold pattern (the ordinary push-to-talk one) accumulated two of them and claimed
    /// unreachability over a relay that had completed two handshakes. A stronger false claim on the
    /// same trigger (roborev 60365).
    Orphan,
    /// Nothing to report: the socket was installed and is routing.
    Silent,
}

/// Classify a raced stream for the frontend. Pure so the three-way distinction is pinned without a
/// relay, an `AppHandle` or a clock.
pub(crate) fn late_report_for(disposition: RacedStream, same_generation: bool) -> LateReport {
    match disposition {
        RacedStream::ParkWarm | RacedStream::Discard => {
            if same_generation { LateReport::Late } else { LateReport::Orphan }
        }
        // ROTATED, BUT NOT AN ORPHAN — and this is the one place the two must be told apart.
        // `Orphan` means "no evidence either way": a handshake for a session the user already left,
        // possibly landing while a SUCCESSOR is live and painting interims, so reporting it would
        // describe a timing fault over a working stream. `ParkCurrent` is reached only with the mic
        // ARMED and the current slot EMPTY — i.e. there is provably no successor stream to lie
        // about, and this socket has just been banked for the session the user is in right now.
        //
        // So `Late` is the honest report: we connected, for the live session, too late to install
        // for the utterance that just ended. That is exactly what the banner says, and (unlike the
        // orphan case) it is now also actionable — the next hold reuses this socket with no
        // handshake, which is the whole point of banking it.
        RacedStream::ParkCurrent => LateReport::Late,
        RacedStream::InstallLive => LateReport::Silent,
    }
}

/// Send the frontend whatever `late_report_for` decided. One place, so the park and discard arms
/// cannot drift, and so "an orphan says NOTHING" stays a single fact rather than two omissions.
///
/// A distinct event rather than silence: silence is indistinguishable from a handshake that never
/// completed, which is exactly what the corroboration counter counts. The orphan must be silent on
/// BOTH axes — no banner AND no refusal tally — and only a signal it can recognise lets the
/// frontend do that.
fn emit_late_report(app: &AppHandle, report: LateReport) {
    match report {
        LateReport::Late => {
            let _ = app.emit("dictation://cloud-late", ());
        }
        LateReport::Orphan => {
            // THE POINT OF THIS ARM IS THE `cloud-late` IT DOES NOT EMIT. The frontend has no
            // listener for `cloud-orphan` and must not grow one (roborev 60408/60429): an orphan's
            // own attempt answers `CloudStreamOutcome::Raced`, which the frontend classifies as
            // `ignore` — already "record nothing" — so any latch keyed on this event could only ever
            // suppress a DIFFERENT attempt's outcome, and the event is an `app.emit`, i.e. broadcast
            // to every window. Two mechanisms were built on it and both were deleted for exactly
            // that. It stays emitted as a diagnostic companion to this log line; if a consumer is
            // ever genuinely needed, it must carry the generation id, not a bare fact.
            tracing::info!(
                target: "dictation",
                "the raced stream belongs to a rotated generation; reporting it as an orphan so it \
                 neither lights the banner nor counts as a refusal"
            );
            let _ = app.emit("dictation://cloud-orphan", ());
        }
        LateReport::Silent => {}
    }
}

/// What `cloud_reuse` was told about the socket sitting in the slot. NAMED fields, not a bool pair:
/// a caller that swapped `is_alive()` for `is_for_project()` in a tuple would compile and mis-bill
/// silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Installed {
    pub alive: bool,
    pub project_matches: bool,
}

/// WHAT ACTUALLY HAPPENED on a `start_cloud_stream` attempt — the command's return value.
///
/// THIS REPLACES A `bool`, AND THE BOOL WAS THE BUG. `Ok(false)` had SEVEN distinct meanings at this
/// command's return sites, of which only ONE was a relay refusal: a healthy already-routing socket, a
/// warm-parked race, a discarded race, a signed-out user, a panicked handshake task, an
/// unreachable-by-construction guard — and the actual refusal. The frontend therefore could not tell
/// "everything is fine, a stream is already running" from "the relay said no", which is why the
/// fallback banner FLAPPED on every repeated hold and focus-regain while the relay was verified
/// healthy throughout (the founder's "it's popping up and going away… very sensitive"), and why
/// `OPEN_REFUSALS_BEFORE_WARNING` had to exist to paper over it.
///
/// Splitting the outcomes is what lets the frontend do two things it could not do before: treat the
/// benign no-ops as evidence the cloud is LIVE rather than as refusals, and name the specific,
/// actionable conditions (signed out / not entitled / out of credits) instead of one flat
/// "unavailable".
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudStreamOutcome {
    /// A fresh socket was installed and is routing. Caller may start metering.
    Opened,
    /// A warm standby socket was resumed — no handshake. Also live; caller may start metering.
    Resumed,
    /// A live socket for this project was ALREADY routing: the idempotent no-op on a repeated
    /// passive→active edge. NOT A REFUSAL — this is positive evidence the cloud is working.
    AlreadyRouting,
    /// A stop/mute/toggle raced the open, so nothing is routing now. Benign and self-correcting;
    /// says nothing about the relay's health, so it must never raise a fallback notice.
    Raced,
    /// No Sparkle bearer on this machine — we never contacted the relay.
    SignedOut,
    /// Relay answered 401: the bearer was rejected. Actionable — sign in again.
    Unauthorized,
    /// Relay answered 403: this account is not entitled to cloud dictation.
    NotEntitled,
    /// Relay answered 402: entitled but can't afford the first minute. Actionable — refill.
    InsufficientCredits,
    /// Relay answered 503: ITS Deepgram key is unset. A real service fault, nothing user-fixable.
    RelayUnconfigured,
    /// Relay answered 429: this account already holds its limit of concurrent relay streams.
    /// Actionable AND self-correcting — close another dictating window, or retry once the previous
    /// socket's warm-standby window lapses. NOT a service fault, which is why it does not fold into
    /// `Unreachable`.
    TooManyStreams,
    /// No answer from the relay (DNS/TCP/TLS/timeout), an unexpected status, or a local failure.
    Unreachable,
}

impl From<crate::cloud::RelayRefusal> for CloudStreamOutcome {
    fn from(r: crate::cloud::RelayRefusal) -> Self {
        use crate::cloud::RelayRefusal as R;
        match r {
            R::Unauthorized => CloudStreamOutcome::Unauthorized,
            R::NotEntitled => CloudStreamOutcome::NotEntitled,
            R::InsufficientCredits => CloudStreamOutcome::InsufficientCredits,
            R::Unconfigured => CloudStreamOutcome::RelayUnconfigured,
            R::TooManyStreams => CloudStreamOutcome::TooManyStreams,
            // An unexpected status proves the relay ANSWERED, but we have no copy for it and must
            // not invent one — report it as unavailable and let the log carry the number.
            R::Http(_) | R::Unreachable | R::Local => CloudStreamOutcome::Unreachable,
        }
    }
}

/// The decision `cloud_reuse` returns: what `start_cloud_stream` should do with whatever socket is
/// currently installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudReuse {
    /// A live socket for THIS project is already routing — do nothing (idempotent: a repeated
    /// passive→active transition must not open a second socket).
    AlreadyRouting,
    /// A warm (parked) socket for this project — resume it, no handshake.
    Resume,
    /// A socket for a DIFFERENT project — take it down and open a fresh one, so the per-minute debits
    /// carry the right attribution. Reached with `active` true as well, because the focus-regain
    /// unpark resumes a parked socket without knowing which project we're now dictating into; if this
    /// only looked at the parked case, that path would keep billing the old project (roborev 50498).
    Reopen,
    /// Nothing usable installed — open a fresh socket.
    Open,
}

/// Decide the fate of the installed socket. Pure so the BILLING-critical branch is unit-testable
/// without a relay, a handshake, or an AppHandle. `installed` is `None` when the slot is empty; both
/// of its fields must be sampled under the same lock that then acts on the decision.
pub(crate) fn cloud_reuse(active: bool, installed: Option<Installed>) -> CloudReuse {
    match installed {
        Some(Installed { alive: true, project_matches: false }) => CloudReuse::Reopen,
        Some(Installed { alive: true, project_matches: true }) if active => CloudReuse::AlreadyRouting,
        Some(Installed { alive: true, project_matches: true }) => CloudReuse::Resume,
        // Dead socket (or empty slot) while the flag still says active: leave it to the existing
        // mid-stream-death recovery (the worker's cloud-ended → stop_cloud_stream) rather than
        // opening a second stream underneath it.
        _ if active => CloudReuse::AlreadyRouting,
        _ => CloudReuse::Open,
    }
}

// ── THE PUSH-TO-TALK PRE-CONNECT (sparkle-v3990, the latency half) ──────────────────────────────
//
// EVERYTHING ABOVE OPENS THE SOCKET ON THE KEYDOWN, AND THAT IS THE BUG. `cloudStreamCommandFor`
// returns `start_cloud_stream` on the passive→active phase edge; push to talk sits `passive` at rest
// and goes `active` only for the duration of a hold, so the ~490 ms TLS+WS handshake begins at the
// instant the key goes down. The founder's measured holds on 2026-08-09 were **76-567 ms**. The
// socket therefore lands after the key comes up, is parked or discarded, the command answers
// `Raced`, and the utterance falls back to the on-device engine — which decodes only CLOSED VAD
// segments and has NO interim results at all. That is the structural reason a short press never gets
// the live word-by-word preview, and why "longer utterances usually get it" is the signature of a
// connect race rather than of a capture failure. Measured 2026-08-06: 171 sockets opened, 136
// discarded for landing after the utterance had ended, on a network healthy throughout.
//
// `WARM_STANDBY` already fixes the SECOND hold and every one after it — `cloud_reuse`'s `Resume`
// path costs no handshake. What it cannot fix is the FIRST hold in a cold window, and with an
// intermittent speaker that is the hold the user keeps hitting.
//
// SO: connect BEFORE the key goes down. Nothing here is a new socket lifecycle — the pre-connect
// lands in exactly the state `RacedStream::ParkWarm` produces (`park_raced_stream`: pause(), sender
// installed, `cloud_active` untouched) and is picked up by exactly the same `cloud_reuse` `Resume`
// arm. What is new is only WHEN we decide to open one, and a mark saying the socket is still a guess.

/// Minimum spacing between two pre-connect HANDSHAKES on one session — the cost floor.
///
/// A pre-connect is speculative spending: the relay debits a minute UP FRONT on open
/// (`firstMinuteCents`, 6¢) whether or not a word is ever spoken into the socket. That is a fine
/// trade once — it buys the founder the live preview on a hold he would otherwise lose — but it must
/// not be repeatable at the rate a window can gain and lose focus.
///
/// It is `PAID_MINUTE`, deliberately, because that is the unit being spent: at one handshake per
/// paid minute the worst case a user can provoke by alt-tabbing is exactly the bound this repo
/// already accepts elsewhere for an idle relay (`IDLE_RELAY_PARK_MS`, whose own doc reasons "bounds
/// an idle Speak session at one minute of charge instead of an unbounded number"). Anything shorter
/// buys minutes the user is already paying for; anything longer just loses holds.
///
/// WHAT IT COSTS, stated plainly: a user who tabs away and comes straight back inside the window
/// gets no pre-connect, so that hold pays a handshake. That is the behaviour before this change, not
/// a regression — the floor can only ever remove a speculative purchase, never a real one, because
/// the hold's own `start_cloud_stream` is untouched by it.
const PRECONNECT_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(60);

/// What the pre-connect should do right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreconnectPlan {
    /// Open a socket now and PARK it, so the next hold resumes instead of handshaking.
    Connect,
    /// The pre-arm state no longer holds (the tray moved, the window blurred, the entitlement went
    /// away) and the socket in the slot is one WE opened on spec and nobody ever used. Close it.
    Release,
    /// Nothing to do — either a usable socket is already banked, or there is nothing speculative to
    /// give back.
    Idle,
}

/// Decide the pre-connect action. Pure, and it is where the whole fix is pinned: the assertion that
/// matters is that at the moment of a hold `cloud_reuse` answers `Resume` rather than `Open`, and
/// that is a statement about this decision plus the park it drives — not about anything that needs a
/// relay, a microphone, or a 482 MB model to observe.
///
/// * `want` — the FRONTEND's gate, and deliberately not re-derived here. It carries "push to talk is
///   the armed tray position, at rest, and this window has the caret", plus the two live AI-feature
///   prefs `openCloud` itself checks (`voice/cloudPreconnect`). The bearer-token gate stays where it
///   already is, in the command's own `choose_engine` call — a pre-connect must never contact the
///   relay for a signed-out, unentitled or out-of-credits user, both because it is wasted work and
///   because it would occupy a relay stream slot and can trip the server-side cap that produces the
///   `too_many_streams` refusal in another window.
/// * `focused` — the app-global OS focus flag, and THE OUTER TERM, exactly as
///   `capture_should_be_live` makes it for the microphone. Tab away and this releases. A relay socket
///   held open while the user is in another app is the same class of promise as an open microphone,
///   so it gets the same answer; `want` alone must not be able to keep one alive.
/// * `reuse` — what `cloud_reuse` would say about the socket already in the slot. `Open` is the only
///   answer that means a hold would pay a handshake, so it is the only one worth pre-connecting for.
///   `Resume` means a warm socket is already banked (the pre-connect's own work, or the last
///   utterance's) and re-opening would burn a second `firstMinuteCents` debit for nothing.
///   `AlreadyRouting` means the user is mid-utterance. `Reopen` is a project mismatch, which is a
///   BILLING decision the hold's own `start_cloud_stream` already owns and must not be pre-empted
///   here — tearing down another project's live socket on spec is not this function's call.
/// * `speculative` — whether the socket in the slot is an unused pre-connect (`is_speculative`).
///   Only such a socket may be released: a socket that carried real dictation keeps the existing
///   warm-standby posture, including the focus-regain resume `park_cloud_for_blur` exists for.
/// * `since_last_connect` — how long ago this session last SPENT a pre-connect handshake, or `None`
///   if it never has. See `PRECONNECT_COOLDOWN`; a `Duration` rather than an `Instant` so the rule
///   is testable without a clock.
pub(crate) fn preconnect_plan(
    want: bool,
    focused: bool,
    reuse: CloudReuse,
    speculative: bool,
    since_last_connect: Option<std::time::Duration>,
) -> PreconnectPlan {
    if want && focused {
        // THE COST BOUND, AND IT IS THE RELEASE ABOVE THAT MAKES IT NECESSARY. Releasing on blur is
        // right for privacy and it is exactly what turns a focus cycle into a fresh 6¢ debit: the
        // blur empties the slot, so the refocus finds `Open` and buys another first minute. Without
        // a floor, alt-tabbing between Sparkle and a browser costs one relay minute per round trip,
        // for a microphone the user never touched.
        if matches!(since_last_connect, Some(d) if d < PRECONNECT_COOLDOWN) {
            return PreconnectPlan::Idle;
        }
        return match reuse {
            CloudReuse::Open => PreconnectPlan::Connect,
            _ => PreconnectPlan::Idle,
        };
    }
    // The pre-arm state is gone. Give back what we took on spec — and ONLY that.
    if speculative {
        PreconnectPlan::Release
    } else {
        PreconnectPlan::Idle
    }
}

/// What to do with a PRE-CONNECTED socket once its handshake lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreconnectLanding {
    /// Bank it in the CURRENT generation's slot, parked, for the next hold.
    Park,
    /// Nothing wants it any more — silence and close it.
    Discard,
}

/// Decide a landed pre-connect's fate. Deliberately its OWN function rather than a call into
/// `raced_stream_disposition`, and the difference is one term: that function guards on `armed`, and
/// push to talk RESTS DISARMED (`useMicActions::setOff`, the hold's resting state), so every
/// pre-connect would land on its `Discard` arm and the feature would be inert. Widening `armed`
/// there would weaken a guard that is load-bearing for a genuinely different situation — a handshake
/// landing just after a MUTE — so the two decisions stay separate.
///
/// The terms that DO carry over are carried over unchanged, and they are the ones that are not
/// vacuous here: `slot_empty` (never clobber an occupant) and `!already_active` (never shadow a
/// session that is routing). Both are read from the CURRENT session, because — exactly like
/// `RacedStream::ParkCurrent` — a pre-connect banks into `sess.*`: the generation may well have
/// rotated under us (the user started a hold while we were connecting), and the current Arcs are the
/// only ones anybody still holds. `focused` is re-checked for the same reason it gates the plan: the
/// user may have tabbed away during the handshake, and a socket nobody is present for is not one to
/// keep.
///
/// No epoch term, matching the existing park arms: parking has never depended on the epoch, only
/// INSTALLING has. A `stop_cloud_stream` landing mid-handshake either empties the slot (we park,
/// which is correct — that is precisely the warm socket the next hold wants) or parks its own
/// session in it (we discard, because `slot_empty` is false).
pub(crate) fn preconnect_landing(
    focused: bool,
    slot_empty: bool,
    already_active: bool,
) -> PreconnectLanding {
    if focused && slot_empty && !already_active {
        PreconnectLanding::Park
    } else {
        PreconnectLanding::Discard
    }
}

/// What `start_dictation` should do when its (slow, lock-free) model load finishes and it re-takes
/// the session lock. Three outcomes, decided purely so the resurrect-race matrix is unit-testable
/// without an AppHandle, a 482MB model download, or threads:
///   - `AbortMutedDuringLoad`: the stop epoch advanced — a `stop_dictation` landed while we loaded
///     (the user muted mid-download). Abort: leave the mic muted, drop the freshly loaded
///     transcriber. `armed` alone can't detect this (the stop already set it false), which is
///     exactly why the epoch exists.
///   - `AlreadyArmed`: a racing `start_dictation` armed the session while we loaded. Discard our
///     transcriber and just reconcile — never overwrite the live one without finalize().
///   - `Arm`: a clean fresh arm — install the transcriber and bring capture up.
///
/// Epoch is checked FIRST: if a stop AND a racing re-arm both happened during the load, the other
/// start owns a fresh live session, so aborting (touch nothing, drop our transcriber) is the safe
/// outcome either way.
///
/// CALLER CONTRACT: both `current_epoch` and `armed` MUST be read from the SAME locked critical
/// section that then acts on the result, so the decision and the install are atomic.
#[derive(Debug, PartialEq)]
pub(crate) enum StartAfterLoad {
    AbortMutedDuringLoad,
    AlreadyArmed,
    Arm,
}

/// What `start_dictation` should do in its FIRST critical section, before committing to the slow
/// model load. Added after a live incident (2026-07-26) in which one mic toggle produced ~18
/// concurrent `start_dictation` calls — one per open Sparkle window — each of which queued its own
/// model load on the blocking pool. A burst of `stop_dictation`s then advanced the epoch, so all 18
/// were dead on arrival, yet each still occupied a load slot before discovering it. They drained one
/// at a time over 3.5 minutes (the pool was saturated by ~10 running agents), and for that whole
/// window the mic could not arm: every start aborted, and the user saw a mic ring that claimed to be
/// listening with no waveform behind it.
///
///   - `FastPathArmed`: already armed — refresh focus and reconcile (the pre-existing fast path).
///   - `CoalesceWithInFlight`: another start sampled THIS SAME epoch and is still loading. It
///     represents the identical user intent, and the session it arms is app-global, so a second load
///     would buy nothing. Return without loading and let the in-flight one arm for everyone.
///   - `Load(epoch)`: no equivalent start is in flight — sample the epoch and load.
///
/// Coalescing is keyed on the epoch, NOT merely "is something in flight", and that is the whole
/// subtlety: a start that sampled a NEWER epoch than the in-flight one represents a LATER intent
/// (the user muted, then unmuted again), so it must run its own load or the final unmute is lost and
/// the mic stays dead. Same epoch = duplicate fan-out, collapse it; newer epoch = real re-arm, honour it.
#[derive(Debug, PartialEq)]
pub(crate) enum BeginStart {
    FastPathArmed,
    CoalesceWithInFlight,
    Load(u64),
}

/// CALLER CONTRACT: all three inputs MUST be read from the same locked critical section that then
/// acts on the result, so the decision and the `start_in_flight` claim are atomic.
pub(crate) fn begin_start_decision(
    armed: bool,
    stop_epoch: u64,
    start_in_flight: Option<u64>,
) -> BeginStart {
    if armed {
        return BeginStart::FastPathArmed;
    }
    if start_in_flight == Some(stop_epoch) {
        return BeginStart::CoalesceWithInFlight;
    }
    BeginStart::Load(stop_epoch)
}

/// Whether a `stop_dictation` has anything to do. Every open window runs its own copy of the
/// `enabled` effect, so ONE mute broadcasts N stops — during the 2026-07-26 incident they arrived in
/// clusters of 3-6 within 0-8ms of each other. Each one unconditionally advanced the single
/// app-global stop epoch, so a single mute could invalidate in-flight starts many times over and
/// spam teardown work that had already happened.
///
/// A stop is a no-op exactly when there is no live session AND no start that could still arm.
///
/// `start_could_still_arm` is load-bearing and must not be dropped as redundant: during a start's
/// model load `armed` is still false and no capture/transcriber is installed yet, so without it a
/// genuine mute landing mid-load would look like "nothing to stop", skip the epoch bump, and let the
/// load resurrect a mic the user just muted — the exact resurrect race the epoch exists to close.
///
/// But it must be "a start that can STILL ARM", not merely "a start exists" — the distinction is the
/// whole fix. Nothing clears the in-flight claim until the load returns, so a bare `is_some()` stays
/// true for the entire load, and the N-1 stops that follow the first would each keep advancing the
/// epoch. That reproduces the very amplification this function exists to stop, in precisely the case
/// the commit is about (a mute during a load). Once the first stop has moved the epoch, the in-flight
/// claim is already stale — that start is doomed and has nothing left to cancel — so every later stop
/// in the same broadcast is genuinely a no-op. The caller passes `start_in_flight == Some(stop_epoch)`.
pub(crate) fn stop_is_noop(
    armed: bool,
    has_capture: bool,
    has_transcriber: bool,
    start_could_still_arm: bool,
) -> bool {
    !armed && !has_capture && !has_transcriber && !start_could_still_arm
}

pub(crate) fn start_after_load(sampled_epoch: u64, current_epoch: u64, armed: bool) -> StartAfterLoad {
    if current_epoch != sampled_epoch {
        StartAfterLoad::AbortMutedDuringLoad
    } else if armed {
        StartAfterLoad::AlreadyArmed
    } else {
        StartAfterLoad::Arm
    }
}

/// Decide the engine for an active-dictation stream. Cloud requires the setting on AND a signed-in
/// user (a Sparkle bearer to authenticate to the relay). `credits_ok` is now enforced
/// SERVER-side — the relay refuses the WS upgrade when the user isn't entitled or can't afford the
/// first minute — so the caller passes it true and lets a failed handshake fall back to Local.
/// Offline is handled the same implicit way: if Cloud is chosen but the relay handshake fails, the
/// caller falls back to Local, so we don't probe connectivity or credits here.
pub(crate) fn choose_engine(setting_enabled: bool, signed_in: bool, credits_ok: bool) -> Engine {
    if setting_enabled && signed_in && credits_ok {
        Engine::Cloud
    } else {
        Engine::Local
    }
}


/// Per-frame and per-focus-change pure policy — see `frame_policy.rs`.
mod frame_policy;
use frame_policy::{
    capture_should_be_live, dispatch_closed_segments, frame_on_device_speech, frame_speaking,
    plan_capture_for, segment_cloud_latch, should_emit_blur, CapturePlan, FOCUS_BLUR_COALESCE_MS,
};


/// Bounded capacity of the decode queue between the realtime capture callback and the decode
/// worker. Each item is one closed VAD segment (≤ the VAD's 8 s max_speech_duration of 16 kHz
/// audio). The worker decodes far faster than segments close in ordinary speech, so this rarely
/// fills; if it does (a burst, or a slow machine), the callback DROPS the newest segment
/// (`try_send` → `Full`) rather than block the CoreAudio IOThread — bounded, lossy backpressure is
/// the safe tradeoff on the realtime thread. 32 segments is minutes of speech of headroom.
const DECODE_QUEUE_CAP: usize = 32;

/// How long the decode worker may block in one `recv` before re-checking its abort flag.
///
/// The worker used to sit in a plain blocking `recv` (`for samples in rx`), which meant `abort()`
/// was UNOBSERVABLE while it waited: the flag was only read at the top of the next iteration, and
/// the next iteration only came when a segment arrived or the channel CLOSED. That is precisely
/// the deadlock this constant exists to break — see `DECODE_JOIN_TIMEOUT` for the incident.
///
/// This is an in-process atomic load on a timer, not a syscall poll: the cost of a tick is a
/// wakeup and a relaxed load, and the worker only exists while a capture is live. 100 ms bounds
/// the abort→exit latency well under the join timeout while staying invisible in CPU terms.
const DECODE_ABORT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// How long a teardown may wait for the decode worker to exit before DETACHING it instead.
///
/// ── THE INCIDENT THIS BOUNDS (spindump, sparkle 0.65.0 pid 27419) ─────────────────────────────
/// Every teardown path here joins the worker, and every one of them justified that join as
/// "bounded" / "near-instant" on the same premise: `Capture` holds the sole channel `Sender` (it
/// is moved into the cpal callback closure in `build_capture`), so dropping the `Capture` first
/// closes the channel, ends the worker's `for samples in rx`, and the join returns. A live sample
/// disproved that premise. The main thread was at 6705 of 6705 samples blocked on this module's
/// session `Mutex`; the thread HOLDING that mutex was in `set_focused` → `drop_glue<DecodeWorker>`
/// → `pthread_join`; and the `parakeet-decode` thread it was joining was parked in `recv` →
/// `semaphore_wait_trap`. `recv` blocking means the channel was still CONNECTED — the `Capture`
/// drop had already returned and the Sender had NOT been freed. `Capture::drop` only stores
/// `active=false` and calls `stream.pause()`; whether the callback closure (and the Sender inside
/// it) is actually deallocated is up to cpal's `Stream` drop and CoreAudio's Dispose. The whole
/// app hung on that assumption, and the user had to force-quit.
///
/// So the join must not depend on the channel closing AT ALL. `DECODE_ABORT_POLL` gives the worker
/// its own exit signal, and this constant is the backstop for everything that signal cannot reach:
/// a worker wedged inside a decode, an FFI call that never returns, a future edit that reintroduces
/// a blocking wait.
///
/// THIS IS THE TOTAL, SPENT IN TWO PHASES — do not read it as a single wait-then-detach. It is
/// split into `DECODE_DRAIN_BUDGET` (wait for an orderly exit; on the un-aborted `stop_dictation`
/// path this is the drain) and then `DECODE_ABORT_GRACE` (having stored `abort`, wait for the
/// worker to act on it). Only a worker that ignores even the abort is DETACHED — and it is detached
/// with the abort already stored, so it exits if it ever unwedges rather than running forever. A
/// leaked decode thread costs one thread and its `Arc`s; a join that never returns costs the entire
/// application, because on every teardown path the caller is (or blocks) the main thread. That trade
/// is not close.
///
/// Two seconds is generous against the work the worker can legitimately still be doing (one
/// in-flight `Decoder::transcribe` of a ≤8 s segment) while staying far under the point at which a
/// user reads the UI as hung. It is a CEILING and the split preserves it: in the leaked-Sender case
/// this mechanism exists for, the deadline is hit on EVERY teardown rather than rarely, so growing
/// the total would have been a routine main-thread stall (roborev 55788).
const DECODE_JOIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// How long to wait for the worker to act on the abort we store when the drain budget expires,
/// before giving up and detaching. Several `DECODE_ABORT_POLL` ticks, so a worker that is merely
/// idling in `recv_timeout` is joined normally and only a genuinely wedged one is ever detached.
///
/// CARVED OUT OF `DECODE_JOIN_TIMEOUT`, not added to it — see `DECODE_DRAIN_BUDGET`. It is tempting
/// to append it, and that is wrong: the caller is the main thread, and the leaked-Sender case this
/// whole mechanism exists for hits the deadline on EVERY teardown rather than rarely, so any growth
/// here is a routine main-thread stall, not a rare one.
const DECODE_ABORT_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// How long the worker is given to drain its queue BEFORE we abort it — the first phase of
/// `DECODE_JOIN_TIMEOUT`, with `DECODE_ABORT_GRACE` as the second. The two must sum to
/// `DECODE_JOIN_TIMEOUT` (pinned by `the_teardown_budget_is_carved_up_not_added_to`) so the total
/// time a teardown can block its caller is unchanged by the abort-then-grace sequence.
const DECODE_DRAIN_BUDGET: std::time::Duration = std::time::Duration::from_millis(1_500);

/// How a closed VAD segment's decode finished — the input to the on-device emit rule.
#[derive(Debug, PartialEq, Eq, Clone)]
pub(crate) enum DecodeOutcome {
    /// `Decoder::transcribe` returned this text (already trimmed by the worker).
    Decoded(String),
    /// The decode panicked inside the FFI and the segment was dropped.
    Panicked,
}

/// What the worker should emit for one finished decode.
///
/// Mirrors the `plan_capture`/`CapturePlan` and cloud.rs `speech_end_action` convention: the
/// decision is a pure function so it can be proven without an `AppHandle`, rather than living as
/// untestable branches inside the worker thread. Each variant maps 1:1 onto exactly one arm of
/// `apply_decode_plan`, which is itself under test through `DecodeEmitSink` — so pinning the plan
/// pins the DECISION and pinning the sink pins the EMITS. Note the second half: this doc used to
/// claim the plan alone pinned the emits, which was a convention rather than a fact (roborev 55496).
#[derive(Debug, PartialEq, Eq, Clone)]
pub(crate) enum DecodeEmitPlan {
    /// Emit `dictation://partial` (source `"accept"`) with this text, THEN `dictation://speech-end`.
    ///
    /// The two are ONE variant on purpose. They are the same claim about the same closed segment —
    /// "here is what was said, and the speaker has stopped saying it" — and the bug this fixes was
    /// exactly their decoupling: the partial shipped and the speech-end did not, on every capture
    /// that wasn't the cloud relay. It was decoupled a second time, for a different reason, and that
    /// broke the hands-free path instead (see `plan_decode_emit`). There is deliberately NO variant
    /// that emits one without the other: separating them again means editing this type, which is the
    /// point — twice now, doing so has cost a send that should have happened.
    PartialThenSpeechEnd(String),
    /// Emit nothing at all.
    Nothing,
    /// Log the recovered panic; emit nothing.
    WarnPanicked,
}

/// Decide what one finished on-device decode emits.
///
/// A segment with words in it emits BOTH the transcript and the speech-end, in that order — the
/// same ordering the cloud path takes, for the same reason (the rail recomputes its confidence
/// threshold from the text, so a speech-end evaluated first would score the PREVIOUS sentence).
///
/// ══ WHY THIS DOES NOT SUPPRESS THE BOUNDARY ONCE THE CLOUD OWNS THE STREAM ══════════════════════
/// It briefly did (roborev 55311). `decode_tx` is a 32-deep buffer the worker keeps draining after
/// `cloud_active` flips, so a segment closed just before the flip decodes hundreds of ms later, and
/// dropping its boundary looked like the safe direction: `useAutoSend` holds a speech-end briefly
/// across a mic-ownership claim, so a stale one could be replayed as the concierge takes the mic and
/// count down over a draft the user typed and never spoke.
///
/// That guard had NO SUCCESSOR ARM, and it broke the flagship flow (roborev 55417). "Hey Sparkle,
/// deploy the staging branch" said in one breath closes as TWO segments. The first decodes with the
/// flag still false, drives the phase flip and opens the relay; the second was captured pre-flip and
/// drains after it — the common case, not an exotic one, since the on-device model is what runs
/// right up to the instant the relay opens.
/// Its transcript lands in the composer and its boundary was thrown away. The user has stopped
/// talking, so the relay carries only silence and never sends an `Ended`/`UtteranceEnd` frame, and
/// `cloud_active` means the on-device engine produces no further segment either. Nothing ever arms:
/// the dictated command sits in the box and the hands-free path ends at a keyboard.
///
/// The two costs are not symmetric. The suppression's failure is silent and unrecoverable BY
/// CONSTRUCTION — no later event can supply the arm it discarded. The stale arm it prevented is
/// bounded (`DEFERRED_SPEECH_END_MAX_LAG_MS`, 500ms), visible (a countdown the user can cancel), and
/// aimed at the CONCIERGE rather than a terminal (`conciergeRouter` can no longer route at an agent).
///
/// THAT IS THE WHOLE MITIGATION — the bound and the cancellable countdown. Do not add
/// `onDeviceSpeech` to that list: it is `!cloud_active && vad_detected`, so it is pinned FALSE for
/// the entire cloud stream, and the reopened case is BY DEFINITION a segment draining after
/// `cloud_active` flipped. `startClock`'s guard is therefore inert in exactly this window, and the
/// cloud path's other cancel (a non-empty `interim`) is empty too, because the hazard IS "the user
/// typed a draft and stopped talking". An earlier version of this comment claimed that gate, which
/// would have let a future reader shorten the 500ms bound believing something sat behind it
/// (roborev 55455). The risk is accepted at its true size, not at a flattering one.
///
/// So the boundary stays coupled to the transcript it describes, and WHETHER to arm is decided where
/// the facts live — the frontend knows mic ownership, the tray position and where the caret is;
/// this thread knows none of them.
///
/// The two silent cases below are unchanged, and unlike the withdrawn one they ARE recoverable by
/// the very next segment: the user keeps talking, the VAD closes a segment with words in it, and
/// that one arms. Both stay quiet for the same reason: **the speech-end arms a countdown over text
/// the composer holds, so a segment that put no text there did not end an utterance the composer
/// knows about.**
///   - EMPTY decode (the VAD closed a segment on a cough, a door, a keyboard, or clipped breath):
///     no transcript, so arming would count down over whatever was already sitting in the composer
///     — including text the user typed and never spoke. Non-speech noise must not press send.
///   - PANICKED decode: the segment is dropped and no partial is emitted, so the composer is
///     likewise unchanged. Worse, words the user DID say are lost, so arming here would count down
///     over a knowingly incomplete sentence.
pub(crate) fn plan_decode_emit(outcome: DecodeOutcome) -> DecodeEmitPlan {
    match outcome {
        // Trimmed defensively: the caller trims, but "whitespace only" is the same non-event as
        // empty and must not depend on a caller keeping that up.
        DecodeOutcome::Decoded(text) if !text.trim().is_empty() => {
            DecodeEmitPlan::PartialThenSpeechEnd(text)
        }
        DecodeOutcome::Decoded(_) => DecodeEmitPlan::Nothing,
        DecodeOutcome::Panicked => DecodeEmitPlan::WarnPanicked,
    }
}

/// The three side effects a decode plan can produce, behind a trait so the DISPATCH is exercisable
/// without an `AppHandle`.
///
/// WHY (roborev 55496, Medium). `DecodeEmitPlan`'s own doc claimed each variant "maps 1:1 onto
/// exactly one arm of the worker's `match`, so pinning the plan pins the emits". That was a
/// convention, not a fact: the `match` lived inside a spawned thread holding an `AppHandle`, so no
/// test could reach it, and deleting `emit_speech_end` from the `PartialThenSpeechEnd` arm would
/// restore the original bug — auto-send never arming off the cloud path — with every test still
/// green. The plan was pinned; the wiring that consumed it was not, and the wiring is where the bug
/// was. Routing both through a sink moves that arm under test.
///
/// WHAT THIS DOES **NOT** BUY, stated plainly because the first version of this comment overclaimed
/// it and got caught (roborev 55556). `RecordingSink` pins `plan → sink method`. NOTHING pins
/// `sink method → bus event`: `AppEmitSink`'s three bodies need a live `AppHandle`, so they are
/// unpinned, and they do carry policy — the `"accept"` source label and which emit each maps to.
/// Emptying `AppEmitSink::speech_end` still restores the original bug with the whole suite green
/// (verified). So the gap is narrowed by one level, not closed. Closing it needs the `app.emit` calls
/// themselves parameterized, which is a real refactor of `emit_partial`'s logging/seq path and is not
/// attempted here. Treat this as the same kind of bounded, acknowledged residual as the accepted-risk
/// note in `plan_decode_emit` — and do not read the tests below as covering more than they do.
pub(crate) trait DecodeEmitSink {
    /// `dictation://partial`, source `"accept"`.
    fn partial(&mut self, text: String);
    /// `dictation://speech-end` — the on-device half of the auto-send rail's arm.
    fn speech_end(&mut self);
    /// A recovered decode panic: log it, emit nothing.
    fn warn_panicked(&mut self);
}

/// Apply a plan to a sink. Ordering is the contract, not an accident: the transcript lands BEFORE
/// the speech-end so the rail recomputes its confidence threshold from THIS sentence rather than the
/// previous one. Both calls, in this order, or neither.
pub(crate) fn apply_decode_plan<S: DecodeEmitSink>(plan: DecodeEmitPlan, sink: &mut S) {
    match plan {
        DecodeEmitPlan::PartialThenSpeechEnd(text) => {
            sink.partial(text);
            sink.speech_end();
        }
        DecodeEmitPlan::Nothing => {}
        DecodeEmitPlan::WarnPanicked => sink.warn_panicked(),
    }
}

/// The real sink — the only part of the path that needs a live `AppHandle`.
struct AppEmitSink<'a>(&'a AppHandle);

impl DecodeEmitSink for AppEmitSink<'_> {
    fn partial(&mut self, text: String) {
        emit_partial(self.0, "accept", text);
    }
    fn speech_end(&mut self) {
        emit_speech_end(self.0);
    }
    fn warn_panicked(&mut self) {
        tracing::warn!(
            target: "dictation",
            "decode worker recovered from a panic; segment dropped"
        );
    }
}

/// Owns the on-device decode worker thread and the bounded channel it drains. The realtime capture
/// callback pushes closed-segment samples through the channel (non-blocking, drop-on-full); the
/// worker runs `Decoder::transcribe` on its OWN thread and emits the SAME `dictation://partial`
/// events (source `"accept"`) the old inline path emitted — moving the hundreds-of-ms decode OFF
/// `com.apple.audio.IOThread` so it can't overrun the capture ring buffer. It now also emits the
/// on-device half of `dictation://speech-end` for each segment that carried words (see
/// `plan_decode_emit`), which is what lets auto-send arm off the cloud path at all.
///
/// Lifetime is tied to the `Capture`: both are built together in `build_capture` and stored side by
/// side in the session. The channel's Sender lives only inside the capture callback, so once the
/// `Capture` is dropped (which disposes the cpal stream and frees the closure) the channel closes,
/// the worker drains any queued segments and exits, and dropping this joins it. Callers MUST drop
/// the `Capture` BEFORE dropping the `DecodeWorker` so the join is bounded.
struct DecodeWorker {
    handle: Option<std::thread::JoinHandle<()>>,
    /// Set true to make the worker EXIT — promptly, and independently of whether the channel ever
    /// closes. It used to mean only "skip decoding still-queued segments and drain to the channel
    /// close", which made it useless in the one case that mattered: a worker blocked in `recv` on a
    /// channel that never closed never reached the check at all. See `DECODE_JOIN_TIMEOUT`.
    abort: Arc<AtomicBool>,
    /// Closed by the worker thread when its body returns, so a teardown can wait for the exit with a
    /// DEADLINE instead of an unbounded `join()`. The worker holds the paired `Sender` and never
    /// sends on it; the disconnect IS the signal, so this costs nothing while the worker runs and
    /// needs no polling to observe. See `DECODE_JOIN_TIMEOUT` for why the deadline is load-bearing.
    /// Read between the decode and the emit, and set at EXACTLY TWO points:
    ///   - `abort()` — a caller is discarding the backlog outright (blur, mute, exit, reacquire).
    ///     Those partials are moot; emitting one arms auto-send over speech the user abandoned.
    ///   - `Drop`'s DETACH branch — teardown has returned, so `dictation://final` may already be out.
    ///
    /// And deliberately NOT set by the second (and last) writer of `abort`, `Drop`'s drain
    /// escalation, which stores `abort` alone. A decode finishing during that grace is still IN
    /// ORDER and must emit, ahead of the final.
    ///
    /// Note the two flags do NOT have the same store sites, so do not expect them to line up:
    /// `abort` is written at exactly two points (`abort()` and the drain escalation), while this
    /// flag is written at the two above. The detach branch is nested INSIDE the escalation, so by
    /// the time it runs `abort` is already set and it writes only this flag.
    ///
    /// That asymmetry is the whole point of having two flags — gating the emit on `abort` conflated
    /// "teardown began" with "the final is already out" and silently ate the user's last sentence
    /// (roborev 55803, 56014, 56035). Pinned by two tests:
    /// `a_drain_escalation_still_lets_the_in_flight_decode_emit` (must emit) and
    /// `a_real_teardown_that_detaches_silences_the_worker_it_left_running` (must not).
    emits_are_unsafe: Arc<AtomicBool>,
    exited: Receiver<()>,
}

/// The decode worker's control flow, lifted out of the spawned closure so it can be TESTED.
///
/// It is separated for the same reason `should_expire` lives in Rust rather than Objective-C over in
/// `attention.rs`: the defect this shape exists to prevent is invisible from the outside and fatal.
/// The previous version was a plain `for samples in rx { if abort { continue } … }`, which has
/// exactly one exit — the channel closing — and therefore ignores `abort` entirely while it waits.
/// A live spindump caught this thread parked in `recv` while a teardown held the app's session mutex
/// waiting to join it; the app hung and had to be force-quit. That bug is one keyword's difference
/// from correct code and no integration test would have found it, so the loop is unit-tested here.
///
/// Returns when EITHER `abort` is set (within one `DECODE_ABORT_POLL` tick, whatever the channel is
/// doing) OR the channel disconnects (an ordinary drain-to-close). `on_segment` runs the decode.
/// `decode` and `emit` are SEPARATE on purpose, with the abort re-checked between them. The decode
/// is the long, uninterruptible part (an FFI transducer call on a ≤8 s segment); the emit is what
/// the user sees. Fusing them would leave the in-flight segment unbounded in the way that matters:
/// `abort` would bound the LOOP while a decode that began before teardown still emitted its
/// `dictation://partial` afterwards — landing a stale fragment after the `dictation://final` that
/// ended the transcript, and re-arming auto-send over speech the user had finished (roborev 55788).
/// Splitting them also keeps the guard in code a unit test can reach: the real emit needs an
/// `AppHandle`, so a guard living inside the spawned closure could only ever be tested by copying
/// it, which tests the copy.
fn run_decode_loop<P>(
    rx: &Receiver<Vec<f32>>,
    abort: &AtomicBool,
    emits_are_unsafe: &AtomicBool,
    mut decode: impl FnMut(Vec<f32>) -> P,
    mut emit: impl FnMut(P),
) {
    loop {
        // Checked BEFORE the wait as well as after, so an abort that landed while the previous
        // segment was decoding exits without a further tick of latency.
        if abort.load(Ordering::Acquire) {
            return;
        }
        let samples = match rx.recv_timeout(DECODE_ABORT_POLL) {
            Ok(samples) => samples,
            // No segment this tick — loop back and re-read `abort`. This is the line that makes
            // `abort` observable at all; a blocking `recv` here reintroduces the deadlock.
            Err(RecvTimeoutError::Timeout) => continue,
            // Channel closed: drain complete, nothing can ever arrive again.
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if abort.load(Ordering::Acquire) {
            return; // fast teardown: abandon this segment and the rest of the backlog
        }
        let plan = decode(samples);
        // Suppress the emit only once it is genuinely UNSAFE — which is not the same as "teardown
        // began", and conflating the two silently ate the user's last sentence (roborev 55803).
        //
        // `stop_dictation` stores `abort`, waits, and only afterwards emits `dictation://final`. So
        // a decode that finishes during that wait is still IN ORDER and must emit: this is the
        // ordinary case of a ≤8 s segment whose transcribe outran the drain budget, and gating it on
        // `abort` threw away speech the pre-teardown code emitted fine.
        //
        // Unsafe is the other two points at which teardown may leave us: a caller discarding the
        // backlog via `abort()` (its partials are moot — that one does write `abort` too), and a
        // worker we have DETACHED (teardown returned, the final may be out — that one does NOT write
        // `abort`; the escalation already set it on the way in). Both set THIS flag; the drain
        // escalation deliberately does not. See the field doc for the two flags' store sites.
        if emits_are_unsafe.load(Ordering::Acquire) {
            return;
        }
        emit(plan);
    }
}

impl DecodeWorker {
    /// Spawn the worker and return the (bounded) sender the capture callback pushes segments into.
    ///
    /// It deliberately does NOT take `cloud_active`. It briefly did, to suppress the speech-end of a
    /// segment that drained after the cloud took over — see `plan_decode_emit` for why that guard was
    /// withdrawn (it had no successor arm and silently broke the hands-free path).
    fn spawn(decoder: Arc<Decoder>, app: AppHandle) -> (SyncSender<Vec<f32>>, DecodeWorker) {
        let (tx, rx) = sync_channel::<Vec<f32>>(DECODE_QUEUE_CAP);
        let abort = Arc::new(AtomicBool::new(false));
        let abort_worker = abort.clone();
        // Moved into the worker and never sent on: its DROP (when the thread body returns) is what
        // `Drop for DecodeWorker` waits on, so the wait is event-driven and has a deadline.
        let emits_are_unsafe = Arc::new(AtomicBool::new(false));
        let emits_are_unsafe_worker = emits_are_unsafe.clone();
        let (exited_tx, exited) = channel::<()>();
        let handle = std::thread::Builder::new()
            .name("parakeet-decode".into())
            .spawn(move || {
                let _exited_tx = exited_tx;
                run_decode_loop(
                    &rx,
                    &abort_worker,
                    &emits_are_unsafe_worker,
                    |samples| {
                    // Panic firewall parity with the audio-thread handler: a panic inside the FFI
                    // decode (a poisoned recognizer mutex, a malformed segment) must not kill the
                    // worker — that would silently stop on-device transcription for the rest of the
                    // session. catch_unwind keeps the worker alive across one bad segment; the panic
                    // hook still logs it, but suppress_crash_records keeps it from being uploaded as
                    // a "crash" since we recover here.
                    let _suppress = crate::crash::suppress_crash_records();
                    let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        decoder.transcribe(&samples).trim().to_string()
                    }));
                    // A closed VAD segment IS this engine's "the speaker stopped", so a segment
                    // with words in it emits the transcript AND the on-device half of
                    // `dictation://speech-end` (see emit_speech_end). Without that second emit the
                    // auto-send clock — which ONLY `speechEndSeq` starts — never armed on this
                    // path at all: speech went into the composer forever and nothing ever sent.
                    //
                    // Speech-end comes AFTER the transcript, never before; the plan couples and
                    // orders them so that stays true (see plan_decode_emit). Same thread, so the
                    // frontend sees them in the order the segments closed.
                    //
                    // Decided by `plan_decode_emit` and dispatched by `apply_decode_plan`, never
                    // re-derived here. This call and `AppEmitSink`'s three bodies are the part of the
                    // path tests cannot reach (they need a live `AppHandle`) — see DecodeEmitSink for
                    // exactly how far the coverage goes, which is less far than it first appears.
                    plan_decode_emit(match decoded {
                        Ok(text) => DecodeOutcome::Decoded(text),
                        Err(_) => DecodeOutcome::Panicked,
                    })
                },
                    // The emit half. `run_decode_loop` checks `emits_are_unsafe` between the decode
                    // above and this — NOT `abort`. A decode that merely outran the drain budget
                    // still emits (it lands before `dictation://final`). Suppressed only when the
                    // backlog was discarded via `abort()` or the worker was DETACHED.
                    |plan| apply_decode_plan(plan, &mut AppEmitSink(&app)),
                );
            })
            .expect("spawn parakeet-decode worker");
        (tx, DecodeWorker { handle: Some(handle), abort, emits_are_unsafe, exited })
    }

    /// Signal the worker to abandon any queued decodes and EXIT — observed within one
    /// `DECODE_ABORT_POLL` tick whether or not the decode channel ever closes.
    ///
    /// Every caller means "these partials are MOOT" — app-exit quiesce, window blur, mute pause,
    /// capture reacquire — never "a `dictation://final` is coming".
    ///
    /// So this suppresses emits too, and that is why the suppression cannot live on the `abort` flag
    /// alone: `Drop` also stores `abort` as its drain escalation, and on THAT path an emit is still
    /// in order (it lands ahead of the final). `stop_dictation` is the one teardown that never calls
    /// this — it wants the drain — which is what keeps the last-sentence fix intact.
    ///
    /// Without the second store, an in-flight decode returning inside the drain budget emits
    /// `dictation://partial` + `dictation://speech-end` on all five of those paths, arming the
    /// auto-send countdown over a mic the user just muted or a window they just left (roborev 56014).
    fn abort(&self) {
        self.emits_are_unsafe.store(true, Ordering::Release);
        self.abort.store(true, Ordering::Release);
    }
}

impl Drop for DecodeWorker {
    fn drop(&mut self) {
        // Join so no decode/emit outlives teardown — but NEVER unconditionally. This used to be a
        // bare `h.join()`, justified by "the channel is already closed by the time we get here (the
        // Capture — sole Sender holder — was dropped first)". A live spindump caught that premise
        // false and the app deadlocked behind it; `DECODE_JOIN_TIMEOUT` documents the sample.
        //
        // So: wait for the worker's own exit signal with a deadline, and join only once we KNOW the
        // body has returned (at which point `join` is a formality that cannot block). Past the
        // deadline, detach instead — dropping the `JoinHandle` leaves the thread running and
        // reparented, which costs one parked thread. Blocking here costs the whole app, because on
        // most teardown paths the caller is (or blocks) the main thread.
        let Some(handle) = self.handle.take() else {
            return;
        };
        match self.exited.recv_timeout(DECODE_DRAIN_BUDGET) {
            // Disconnected = the worker dropped its sender, i.e. its body returned. Join is free.
            // This is the ordinary path for every teardown, aborted or not.
            Err(RecvTimeoutError::Disconnected) => {
                let _ = handle.join();
            }
            // Nothing is ever SENT on this channel, so `Ok` is unreachable; treat it as "not yet
            // exited" rather than joining on an assumption that has already failed us once.
            //
            // THE DEADLINE IS THE DRAIN BUDGET, AND ITS EXPIRY IS AN ABORT. `stop_dictation` is the
            // one teardown that deliberately does NOT abort — it wants the worker to drain its
            // queued partials so they land before the closing `dictation://final`. That is fine
            // when the channel closes. When it does not (the leaked-Sender case this whole change
            // exists for), the worker sees neither `Disconnected` nor `abort` and loops forever, so
            // without the store below we would detach a thread that is still LIVE: waking at 10 Hz
            // for the rest of the process, holding the transcriber and the `AppHandle`, and still
            // able to `emit_partial` a stale fragment AFTER the final that ended the transcript.
            // Aborting here bounds all of that — the drain got its budget, and now the worker exits.
            Ok(()) | Err(RecvTimeoutError::Timeout) => {
                // `abort` ALONE — deliberately not `emits_are_unsafe`. This is the one writer of
                // `abort` that must not suppress: teardown has not returned, so a decode finishing
                // during the grace below still lands ahead of `dictation://final` and must emit.
                // Adding the suppression here reinstates the eaten-last-sentence bug, which is why
                // `a_drain_escalation_still_lets_the_in_flight_decode_emit` exists to fail on it.
                // Its counterpart on the detach branch below is named there in full; together they
                // pin both sides of the asymmetry.
                self.abort.store(true, Ordering::Release);
                // One more short wait, so the overwhelmingly likely outcome is still an orderly
                // join rather than a detach: the worker observes the abort within a poll tick.
                match self.exited.recv_timeout(DECODE_ABORT_GRACE) {
                    Err(RecvTimeoutError::Disconnected) => {
                        tracing::warn!(
                            target: "dictation",
                            drain_budget_secs = DECODE_DRAIN_BUDGET.as_secs_f64(),
                            "decode worker outlasted the drain deadline; aborted it and it exited \
                             (its queued segments were abandoned)"
                        );
                        let _ = handle.join();
                    }
                    // It ignored even the abort — wedged inside a decode or an FFI call. Detach:
                    // blocking here costs the whole app, because on most teardown paths the caller
                    // is (or blocks) the main thread. The abort above is already stored, so the
                    // thread will exit if it ever returns from whatever it is stuck in.
                    Ok(()) | Err(RecvTimeoutError::Timeout) => {
                        // Teardown is about to RETURN with this worker still running, so from here
                        // an emit could land after `dictation://final`. This is ONE OF THE TWO
                        // points where the suppression is correct — the other is `abort()`, whose
                        // callers are discarding the backlog outright. Do not "simplify" either one
                        // away on the strength of the other; both are load-bearing.
                        //
                        // This branch is nested inside the escalation, so `abort` is already set and
                        // it writes only `emits_are_unsafe`. See `run_decode_loop` and the field doc.
                        // Pinned by `a_real_teardown_that_detaches_silences_the_worker_it_left_running`.
                        self.emits_are_unsafe.store(true, Ordering::Release);
                        tracing::warn!(
                            target: "dictation",
                            ceiling_secs = DECODE_JOIN_TIMEOUT.as_secs_f64(),
                            grace_secs = DECODE_ABORT_GRACE.as_secs_f64(),
                            "decode worker did not exit even after being aborted; detaching it \
                             rather than blocking teardown (the app must stay responsive)"
                        );
                        drop(handle); // detach; it will exit if it ever unwedges
                        // A worker wedged past the abort is plausibly wedged INSIDE
                        // `Decoder::transcribe`, which holds the recognizer mutex for the whole FFI
                        // decode — and `DECODER_CACHE` would hand that same decoder to every later
                        // arm. See `retire_cached_decoder` for why that trade is the wrong way round.
                        retire_cached_decoder();
                    }
                }
            }
        }
    }
}

#[derive(Default)]
pub struct DictationSession {
    capture: Option<Capture>,
    /// The on-device decode worker paired with `capture` (both built in `build_capture`). Dropped
    /// AFTER `capture` on every teardown so the channel is closed before the join (see DecodeWorker).
    decode_worker: Option<DecodeWorker>,
    transcriber: Option<Arc<Mutex<ParakeetTdt>>>,
    /// The live Deepgram stream, present only while actively dictating with cloud enabled.
    /// Shared with the capture callback so frames can be routed to it without rebuilding the
    /// callback when the cloud stream opens/closes.
    cloud: Arc<Mutex<Option<DeepgramSession>>>,
    /// When true, the capture callback streams frames to `cloud` instead of the on-device model.
    /// Read on every audio frame; toggled by start/stop_cloud_stream.
    cloud_active: Arc<AtomicBool>,
    /// A detached sender for the CURRENT cloud session's audio channel, so the realtime callback can
    /// route frames to the relay WITHOUT locking `cloud` (the teardown mutex) on the audio thread.
    /// Swapped in lockstep with `cloud`: `Some` exactly while a session is installed (set on install,
    /// kept across warm-standby pause/resume, cleared when the session is taken). The callback reads
    /// it with `try_lock` so it NEVER blocks; the tiny critical section (a clone/`Option` swap) makes
    /// a lost `try_lock` astronomically rare (and merely drops one frame, like any start/stop race).
    cloud_tx: Arc<Mutex<Option<CloudAudioSender>>>,
    /// Monotonic token bumped on every start_cloud_stream attempt and on every stop. start_cloud_stream
    /// captures it before the (blocking) Deepgram handshake and re-checks it after: if it changed, a
    /// stop/again raced the handshake and the freshly-opened session must be discarded rather than
    /// installed. Guards the check-then-act that Arc::ptr_eq alone can't (a stop on the SAME session).
    cloud_epoch: Arc<AtomicU64>,
    /// Frontend intent: the mic is "armed" (the user hasn't muted it). Set by start_dictation /
    /// cleared by stop_dictation, and retained across focus-driven pauses — so a window losing focus
    /// pauses capture WITHOUT reloading the on-device model when focus returns.
    armed: bool,
    /// Whether at least one Sparkle window is currently the focused/active OS window. Updated from
    /// the window-focus event (lib.rs) and polled at arm time. The cpal capture is live only while
    /// focused — so we never capture audio while the user is looking at another app.
    focused: bool,
    /// KEEP THE MICROPHONE WARM UNTIL THIS INSTANT, so the next push-to-talk hold does not pay
    /// `Capture::start` (160-990 ms) inside a hold that may only last 76 ms.
    ///
    /// ⚠ **NOT YET WRITTEN — NOTHING STAMPS THIS TODAY.** This field is declared and READ (by
    /// `capture_warm_now`, feeding `capture_should_be_live`'s `hold_recent` term) and assigned
    /// nowhere in the tree, so it is permanently `None`: `hold_recent` is always false and the
    /// capture behaviour is exactly the old two-term `focused && armed`. An earlier version of this
    /// doc said it *is* "stamped by `stop_dictation` on the disarm", which describes the intended
    /// writer as though it had landed — a future reader greps the doc, believes the warm path is
    /// live, and debugs the wrong layer (roborev 62000).
    ///
    /// THE WRITER IS DELIBERATELY NOT LANDED, and it is not a mechanical follow-up. `stop_dictation`
    /// is the single disarm path for BOTH a push-to-talk release and a deliberate mute, so a naive
    /// stamp there would hold the OS mic open (indicator lit) right after the user explicitly asked
    /// it to stop — the axis the founder reversed himself on (`sparkle-u81cz`, "IT SHOULD NOT BE
    /// CAPTURING ANY WAVEFORM"). Whoever lands it must thread the disarm REASON through, or stamp at
    /// the push-to-talk keyup call site instead, and must also give the expiry an EVENT: every
    /// caller of `capture_should_be_live` is event-driven, and `watchdog_tick` consults it only in
    /// the `capture.is_none()` arm — so a warm window that merely ELAPSES is never re-read and the
    /// mic would stay open until the next focus change or arm toggle.
    ///
    /// `None` (or elapsed) = the old two-term behaviour, mic released on release.
    ///
    /// This is the CAPTURE half of what `af0c91a11` did for the relay socket — see
    /// `frame_policy::capture_should_be_live` for the measurement and the privacy reasoning. `focused`
    /// still gates it, so tabbing away releases the OS mic regardless of this stamp.
    warm_capture_until: Option<std::time::Instant>,
    /// Monotonic counter bumped by every `stop_dictation`. `start_dictation` samples it BEFORE the
    /// slow, lock-free model load (~482MB on a fresh install) and re-checks it after acquiring the
    /// lock: if a stop landed during the load (the user muted mid-download), the sampled value is
    /// stale and the start aborts instead of re-arming the mic the user just muted. Closes the
    /// "resurrect" race that `if sess.armed` alone can't (a stop leaves `armed` false, which the
    /// arm path would otherwise flip back to true). Guarded by the session Mutex; a plain counter
    /// is enough since it's only ever read/written while holding that lock.
    stop_epoch: u64,
    /// The stop epoch sampled by the `start_dictation` currently doing a model load, if any — the
    /// claim that lets duplicate fan-out starts collapse onto it instead of queuing their own load
    /// (see `begin_start_decision`). `None` = no load in flight.
    ///
    /// Every open window runs its own `enabled` effect, so one mic toggle calls `start_dictation`
    /// once per window; on 2026-07-26 that put ~18 loads on a blocking pool saturated by running
    /// agents, and they drained one at a time over 3.5 minutes with the mic dead throughout. Holding
    /// the sampled epoch rather than a bare bool is what keeps a LATER intent (mute, then unmute
    /// again) from being coalesced away into an earlier one. Guarded by the session Mutex.
    start_in_flight: Option<u64>,
    /// Watchdog latch: we have already spent this capture's one free automatic re-acquire.
    /// Reset whenever a capture is installed, so every rebuild gets exactly one silent recovery
    /// attempt and a permanently dead device escalates to the user instead of looping forever.
    audio_reacquired: bool,
    /// Silence evidence for the bound device, accumulated ACROSS captures.
    ///
    /// Deliberately NOT cleared by `clear_audio_fault` — that clears the per-capture latches on
    /// every install, which is exactly the reset this field exists to survive (see [`SilenceWatch`]).
    /// It is retired instead by the two things that genuinely make the evidence stale: audio
    /// arriving again (the `Recovered` arm) and the device changing (the UID key, in
    /// `fold_silence_evidence`).
    silence_watch: Option<SilenceWatch>,
    /// WHEN the currently-running `build_capture` started (set by `take_reconcile_step`, cleared by
    /// `install_capture` or its error path). Builds happen OFF the session lock and CoreAudio init
    /// blocks on the main thread, so without this the watchdog cannot tell a slow build from a
    /// failed one and would emit a false "couldn't open a microphone" (roborev 55286).
    ///
    /// An `Instant` rather than a bool, because a bool was itself a way to go silent forever: a
    /// build that HANGS (a wedged main thread — the thing this file documents happening for
    /// seconds) never reaches either clear site, so the flag stayed set, every tick returned "no
    /// fault", and the liveness watch was off for the rest of the session. That is the nine-minute
    /// silence re-entered through the fix for the false positive (roborev 55300). Past
    /// `BUILD_STALL_GRACE` we stop believing it.
    build_started_at: Option<std::time::Instant>,
    /// One-shot budget: this session has already spent its automatic re-issue after a FAILED build.
    ///
    /// The re-issue in `reconcile_capture`'s `Err` arm exists for a build that failed because it
    /// belonged to a SUPERSEDED attempt (the device was held during a stop), where retrying against
    /// the current session succeeds. But the re-issued reconcile plans a fresh `Build` — the marker
    /// it would otherwise be gated behind was just cleared by the failure — so a device that fails
    /// for its OWN reasons (no input device, a revoked TCC grant, another process holding it) would
    /// fail, re-issue, fail, re-issue, recursing on the calling thread and emitting a
    /// `dictation://error` per lap until the stack ran out. This latch bounds it at exactly one, in
    /// the same shape (and for the same reason) as `audio_reacquired` bounds the watchdog's one free
    /// re-acquire: one silent retry, then escalate. Cleared by every capture that actually installs
    /// and by every fresh arm, so the budget is per-attempt rather than per-process.
    build_failure_reissued: bool,
    /// A `preconnect_cloud_stream` handshake is in flight right now.
    ///
    /// Claimed and released under the session Mutex, so it is a real mutual exclusion rather than a
    /// hint. Without it the pre-connect has the shape every other command here has had to be
    /// defended against: the frontend fires it on a state EDGE, and a remount, a rapid
    /// blur→focus→blur, or two windows agreeing they are focused would each start their own ~490 ms
    /// TLS+WS handshake against an empty slot. Only the first can park (the rest fail
    /// `preconnect_landing`'s `slot_empty`) — but every one of them has already cost the user a
    /// `firstMinuteCents` debit by the time it discovers that, and a burst of them can trip the
    /// relay's per-account concurrent-stream cap and produce a `too_many_streams` refusal in a window
    /// that is genuinely trying to dictate.
    ///
    /// DELIBERATELY NOT the epoch: the epoch is the INSTALL protocol's token and is bumped by stops
    /// and by every `start_cloud_stream` attempt, so it answers "is my attempt still current",
    /// not "is someone else already connecting". A pre-connect must stand down for a peer that is
    /// mid-handshake, which is a question nothing here could previously ask.
    preconnect_in_flight: bool,
    /// When this session last SPENT a pre-connect handshake — i.e. last paid a `firstMinuteCents`
    /// debit on spec. Read as an elapsed `Duration` by `preconnect_plan`'s cost floor; see
    /// `PRECONNECT_COOLDOWN`. `None` = never, which is always allowed.
    ///
    /// Stamped on the attempt rather than on its success, because a refused or unreachable relay is
    /// exactly when a retry loop would be cheapest to enter and least useful to run.
    last_preconnect_at: Option<std::time::Instant>,
    /// Consecutive watchdog ticks where the mic SHOULD be capturing but no capture exists.
    /// Debounces the ordinary in-flight-rebuild window so only a genuinely stuck state escalates.
    audio_missing_ticks: u8,
    /// Watchdog latch: we have already told the user this capture is not hearing anything.
    /// Prevents an error per poll, and gates the "audio is back" retraction so we never retract a
    /// notice we never showed.
    audio_reported: bool,
}

/// `.0` is the session; `.1` is a monotonic focus generation used to coalesce window-to-window
/// focus switches (see `note_focus_event`): every focus event bumps it so a deferred blur from an
/// older event can detect it's been superseded and bow out.
pub struct DictationState(pub Arc<Mutex<DictationSession>>, pub Arc<AtomicU64>);
// arc_with_non_send_sync: DictationSession holds a !Send cpal Stream, so this Arc<Mutex<…>> is
// not Send/Sync by itself — it crosses threads only via DictationState's `unsafe impl Send/Sync`
// (see the SAFETY note beside them). Shared ownership across the tauri State and worker threads
// is still required, so the lint's Rc/redesign suggestions don't apply.
#[allow(clippy::arc_with_non_send_sync)]
impl Default for DictationState { fn default() -> Self { Self(Arc::new(Mutex::new(DictationSession::default())), Arc::new(AtomicU64::new(0))) } }

/// The transition `take_reconcile_step` extracts under the lock for `reconcile_capture` to act on
/// OUTSIDE it. Carries the owned data each action needs so the lock is released before any
/// main-thread-dependent audio call (the sparkle-sfxu deadlock fix):
///   - `Build`: the Arcs `build_capture` needs (the capture is built, then installed via a
///     re-validated `install_capture`).
///   - `Teardown`: the live capture + worker, taken OUT of the session so the caller drops them
///     (pausing the cpal stream, joining the worker) with no lock held.
enum ReconcileStep {
    Idle,
    Build {
        transcriber: Arc<Mutex<ParakeetTdt>>,
        cloud_active: Arc<AtomicBool>,
        cloud_tx: Arc<Mutex<Option<CloudAudioSender>>>,
    },
    Teardown {
        capture: Option<Capture>,
        worker: Option<DecodeWorker>,
    },
}

/// Whether a focus-driven capture TEARDOWN should park the installed cloud session in warm
/// standby. Deliberately the same predicate as `stop_cloud_stream`'s `keep_warm`: parking on blur
/// and parking on a deliberate stop (the tray leaving Speak, a hold released) are one rule, not
/// two, so they can't drift.
fn should_standby_on_blur(cloud_active: bool, alive: bool) -> bool {
    should_keep_warm_on_stop(cloud_active, alive, false)
}

/// Whether `stop_cloud_stream` should LEAVE a session in warm standby instead of closing it.
///
/// `was_active` alone is not enough, because the blur path parks the socket BEFORE the frontend's
/// blur handler invokes `stop_cloud_stream`: `park_cloud_for_blur` clears `cloud_active`, so the
/// stop that follows a moment later reads `was_active == false` and used to fall through to the
/// close branch — tearing down the very standby the park had just established. Every window blur
/// therefore paid a full close plus a full TLS+WS handshake on refocus, which is exactly the
/// cold-start cost warm standby exists to avoid.
///
/// `parked` closes that hole while keeping the close branch for the cases that need it: an
/// installed-but-not-yet-routing session (alive, never active, never parked) is still taken down,
/// so a stop during the post-handshake race window can't strand a socket that has no warm timer
/// running behind it. A worker that already exited (warm expiry, socket death) fails `alive` and is
/// finished by the caller as before.
fn should_keep_warm_on_stop(was_active: bool, alive: bool, parked: bool) -> bool {
    alive && (was_active || parked)
}

/// Whether a focus-driven capture BUILD should resume a parked cloud session. `alive` is the
/// load-bearing half: once warm standby expires the worker closes the socket and exits, and
/// resuming that corpse would flip `cloud_active` back on with nothing behind it — routing the
/// capture callback at a dead session instead of on-device. An expired session is left for the
/// frontend's `cloud-ended` cleanup, exactly as today.
fn should_resume_on_focus(cloud_active: bool, alive: bool) -> bool {
    !cloud_active && alive
}

/// Park a live cloud session in warm standby on window blur, mirroring a deliberate stop.
///
/// Without this the blur path drops the capture but leaves the socket UNPAUSED: it then idles with
/// no audio, no `CloseStream` and no warm timer until the relay's upstream idle-close severs it, so
/// a refocus moments later pays a full TLS+WS handshake — which, even though `start_cloud_stream`
/// now runs it off the main thread (via `spawn_blocking`), still adds latency before dictation is
/// live. Parking instead means a quick refocus resumes on the same connection, and a long one closes
/// cleanly on OUR timer.
///
/// `pause()` is a non-blocking channel send, so this is safe to call under the session lock — the
/// sparkle-sfxu rule bans blocking work there, not sends. The OS mic is already released by the
/// capture drop that accompanies this; a paused worker forwards no audio, so the parked socket is
/// held no longer than today and is explicitly muted for the window it is held.
fn park_cloud_for_blur(cloud: &Mutex<Option<DeepgramSession>>, cloud_active: &AtomicBool) {
    let guard = cloud.lock().unwrap_or_else(|p| p.into_inner());
    let Some(session) = guard.as_ref() else { return }; // on-device dictation — nothing to park
    if !should_standby_on_blur(cloud_active.load(Ordering::Relaxed), session.is_alive()) {
        return;
    }
    // Order matters: clear the flag BEFORE the pause so the capture callback can never observe
    // "cloud active" against a socket that is on its way into standby.
    cloud_active.store(false, Ordering::Relaxed);
    session.pause();
}

/// Bank a socket that finished handshaking into a survivable stop/again race (see
/// [`raced_stream_disposition`]) in the session's warm-standby slot.
///
/// Extracted from `start_cloud_stream` so the SIDE EFFECTS are testable without an `AppHandle`, a
/// relay, or a `State` — a table test over the disposition booleans cannot see which session states
/// they are reachable from, which is exactly how the missing `armed` guard hid (roborev 55291).
///
/// Three writes, and all three matter:
///   * `pause()` — stops the worker forwarding anything and starts OUR warm timer, so the socket
///     closes on our schedule rather than idling until the relay's upstream timeout.
///   * `cloud_tx` — installed alongside, exactly as warm standby leaves it, so the slot and the
///     sender stay faithful mirrors of each other.
///   * the slot itself — where `cloud_reuse`'s `Resume` path finds it on the next utterance.
///
/// `cloud_active` is deliberately NOT touched: parked is not routing, and the caller must not meter.
fn park_raced_stream(
    cloud: &Mutex<Option<DeepgramSession>>,
    cloud_tx: &Mutex<Option<CloudAudioSender>>,
    session: DeepgramSession,
) {
    session.pause();
    *cloud_tx.lock().unwrap_or_else(|p| p.into_inner()) = Some(session.audio_sender());
    *cloud.lock().unwrap_or_else(|p| p.into_inner()) = Some(session);
}

/// Bank a PRE-CONNECTED socket — one opened before the user pressed anything — in the warm-standby
/// slot, marked as still a guess.
///
/// THE PARK ITSELF IS `park_raced_stream`, UNCHANGED AND ON PURPOSE. The pre-connect's whole design
/// constraint is that it must land in the state warm standby already produces, so that the next hold
/// reaches `cloud_reuse`'s `Resume` arm by the ordinary route with no second socket lifecycle to
/// reason about. A parallel path here would be a second source of truth for a resource that is
/// already hard to reason about — so this adds exactly one thing to it, and that thing is a mark,
/// not a behaviour.
///
/// `cloud_active` IS NOT PASSED, LET ALONE SET, and that is the metering seam stated as a signature.
/// `park_raced_stream`'s own doc records why parking leaves the flag alone ("parked is not routing,
/// and the caller must not meter"), and a pre-connected socket must be identical in that respect:
/// billing the user for sockets they never spoke into would be a worse bug than the latency this
/// fixes. There is no argument here through which a caller could route audio or start a meter.
///
/// The mark goes on BEFORE the park, so the socket is never observable in the slot without it — a
/// blur landing between the two would otherwise see an ordinary warm session and decline to release
/// it.
fn park_preconnected_stream(
    cloud: &Mutex<Option<DeepgramSession>>,
    cloud_tx: &Mutex<Option<CloudAudioSender>>,
    session: DeepgramSession,
) {
    session.mark_speculative();
    park_raced_stream(cloud, cloud_tx, session);
}

/// Take a still-unused pre-connected socket back out of the slot, SILENCED, for the caller to close.
///
/// Returns `None` — leaving the slot untouched — for anything else, and re-reads the mark itself
/// rather than trusting the plan that sent it here. A socket becomes non-speculative the instant
/// `resume()` hands it an utterance, and "never close a socket that is carrying speech" is a
/// property worth having in the function that does the closing rather than only in the one that
/// decided to.
///
/// `cloud_tx` is cleared alongside, exactly as `take_for_teardown` does in `start_cloud_stream`:
/// warm standby deliberately leaves the sender installed next to the parked session, so taking the
/// session without clearing the sender would leave `cloud_tx` pointing at a socket that is gone.
///
/// `silence_now()` rather than a bare take, for the reason every other teardown here gives: `Drop`
/// only signals Close, so an un-silenced session drains whatever it has into whichever session
/// raced ahead and emits a `cloud-ended` that would stop it. A pre-connect has no transcripts to
/// drain — it never routed audio — but the `cloud-ended` is real, and the cost of being consistent
/// here is one atomic store.
fn take_speculative_stream(
    cloud: &Mutex<Option<DeepgramSession>>,
    cloud_tx: &Mutex<Option<CloudAudioSender>>,
) -> Option<crate::cloud::SilencedSession> {
    let mut slot = cloud.lock().unwrap_or_else(|p| p.into_inner());
    if !slot.as_ref().is_some_and(DeepgramSession::is_speculative) {
        return None;
    }
    *cloud_tx.lock().unwrap_or_else(|p| p.into_inner()) = None;
    slot.take().map(DeepgramSession::silence_now)
}

/// Install a freshly handshaked socket as the LIVE cloud stream and start routing audio at it.
///
/// Returns any session it displaced, already SILENCED — the caller must close it (off-thread; the
/// close is bounded but blocking). Extracted alongside [`park_raced_stream`] so this pair of
/// mutations is testable without an `AppHandle` or a relay.
///
/// The displacement is not hypothetical. Parking made "the slot is empty at install time" false:
/// two starts can overlap one handshake window — start A races a stop and PARKS into the slot,
/// while start B, holding the current epoch, is still connecting. Assigning over A would drop it
/// through `Drop for DeepgramSession`, which only signals Close: A's worker would then drain its
/// transcripts into B's composer and emit a `cloud-ended` that drives the frontend to stop B. That
/// is the speak-into-the-successor hazard `silence_now()` exists for (roborev 50498/52646/53024).
fn install_live_stream(
    cloud: &Mutex<Option<DeepgramSession>>,
    cloud_tx: &Mutex<Option<CloudAudioSender>>,
    cloud_active: &AtomicBool,
    session: DeepgramSession,
) -> Option<crate::cloud::SilencedSession> {
    let mut slot = cloud.lock().unwrap_or_else(|p| p.into_inner());
    let displaced = slot.take().map(DeepgramSession::silence_now);
    // Publish the detached audio sender BEFORE flipping cloud_active true, so the first frame the
    // callback routes on the cloud path finds a live sender in the slot (mirrors `cloud`; cleared
    // when the session is taken on stop). Set it while the session is still owned here
    // (audio_sender() only clones the tx).
    *cloud_tx.lock().unwrap_or_else(|p| p.into_inner()) = Some(session.audio_sender());
    *slot = Some(session);
    cloud_active.store(true, Ordering::Relaxed); // callback now routes to Deepgram
    displaced
}

/// Resume a cloud session parked by `park_cloud_for_blur` when focus returns inside the warm
/// window — no handshake, the whole point of the standby. A session that expired while we were
/// away fails the `is_alive` gate and is left alone (see `should_resume_on_focus`).
fn unpark_cloud_for_focus(cloud: &Mutex<Option<DeepgramSession>>, cloud_active: &AtomicBool) {
    let guard = cloud.lock().unwrap_or_else(|p| p.into_inner());
    let Some(session) = guard.as_ref() else { return };
    if !should_resume_on_focus(cloud_active.load(Ordering::Relaxed), session.is_alive()) {
        return;
    }
    session.resume();
    // Set the flag only AFTER the resume lands, so the callback never routes at a still-paused
    // worker (the mirror of the park ordering above).
    //
    // `is_alive` above and this store are not atomic together: a worker that exits in between
    // leaves `cloud_active` true over a dead session, and frames are then dropped (NOT transcribed
    // on-device) until the worker's `cloud-ended` emit drives the frontend's stop_cloud_stream and
    // flips the flag back. That is precisely the mid-stream-failure window the capture callback
    // already documents and accepts — one event round-trip, on a rare disconnect — not a new
    // hazard. Re-checking `is_alive` here would narrow it without closing it, so we lean on the
    // existing recovery rather than pretend a second check makes it atomic.
    cloud_active.store(true, Ordering::Relaxed);
}

/// A capture and its decode worker, removed from the session but NOT yet dropped.
///
/// Exists so a teardown decided under the session lock is *performed* outside it. Both drops are
/// things that must never run while the lock is held: `Capture`'s drop pauses and disposes a cpal
/// stream (CoreAudio, which the main thread also serves — sparkle-sfxu), and `DecodeWorker`'s drop
/// waits on the decode thread. Doing the latter under the lock is what deadlocked the app; see
/// `DECODE_JOIN_TIMEOUT` for the spindump.
///
/// DROP ORDER IS LOAD-BEARING, so it is written out explicitly below rather than left to field
/// order. `capture` must go first — freeing the cpal callback closure and with it the decode
/// channel's `Sender` — so the worker's wait then follows an already-closed channel, which is the
/// fast path. (The worker's `abort` flag is what makes the teardown *correct* when that Sender is
/// not freed; this ordering is what makes it *quick* when it is.) Relying on declaration order
/// would have been silently wrong: `repr(Rust)` lets the compiler lay fields out in any order, and
/// while drop order does follow the source, that is a subtlety one reordering edit away from a
/// teardown that waits out a poll interval on every window blur for no visible reason.
#[derive(Default)]
struct CaptureLeftovers {
    capture: Option<Capture>,
    worker: Option<DecodeWorker>,
}

impl Drop for CaptureLeftovers {
    fn drop(&mut self) {
        drop(self.capture.take()); // closes the decode channel …
        drop(self.worker.take()); // … so this wait is the fast path
    }
}

impl DictationState {
    /// Stop any in-flight capture by dropping the cpal stream, so CoreAudio stops invoking the
    /// audio callback. Called on app exit () to quiesce the audio IOThread BEFORE
    /// static destructors run — closing the shutdown-race window that produced the SIGABRT in
    /// . Unlike stop_dictation this skips finalize(): at exit the trailing segment is
    /// moot and we want the fastest possible teardown. Idempotent and poison-tolerant.
    pub fn stop_capture(&self) {
        let leftovers = {
            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            // Fast teardown: tell the decode worker to abandon any queued segments, then TAKE both
            // out of the session. They are dropped below, after the guard — never under the lock.
            if let Some(w) = sess.decode_worker.as_ref() {
                w.abort();
            }
            CaptureLeftovers { capture: sess.capture.take(), worker: sess.decode_worker.take() }
        }; // release the session lock BEFORE the drops (see CaptureLeftovers)
        drop(leftovers);
    }

    /// Build or release the cpal capture to match `armed && focused` (the only states that decide
    /// it). Caller MUST hold the session lock. Resuming reuses the already-resident transcriber and
    /// the same cloud Arcs (no model reload, same cloud generation), so a focus pause/resume cycle
    /// is cheap and doesn't disturb an in-flight cloud epoch. Pausing drops `Capture`, which stops
    /// CoreAudio invoking the callback and releases the OS mic (the macOS recording indicator goes
    /// off) — true "not capturing", not merely discarded frames.
    #[must_use = "the returned capture/worker MUST be dropped after the session lock is released"]
    fn reconcile_locked(sess: &mut DictationSession, app: &AppHandle) -> CaptureLeftovers {
        // Same decision as the worker-side reconcile — both derive it from `plan_capture` so the two
        // paths can't drift on when to build vs. tear down (sparkle-sfxu review).
        //
        // This comment used to assert that tearing down INLINE here was safe "because
        // reconcile_locked runs only on the main thread (via set_focused), where is_focused() is
        // serviced inline and Capture::start doesn't self-block". BOTH halves of that were wrong,
        // and a live spindump showed the app deadlocked on exactly this line. `note_focus_event`'s
        // deferred-blur path spawns a thread that calls `set_focused(false)`, so this runs off-main
        // routinely; and the inline teardown dropped a `DecodeWorker`, whose `Drop` did an
        // unbounded `pthread_join`, WHILE HOLDING the session mutex the main thread's focus handler
        // was waiting on. Main thread: 6705 of 6705 samples blocked on that mutex.
        //
        // So the teardown is no longer performed here. This function DECIDES; the caller drops what
        // it hands back, after the guard is released. That is the same shape `reconcile_capture`
        // (`ReconcileStep::Teardown`) and `stop_dictation` already use — this path was the last one
        // that still tore down under the lock.
        // Same reasoning as `take_reconcile_step`'s: log the DECISION and both of its inputs on
        // every path, so a mic that silently never comes up is visible in the log.
        // Counts an in-flight build as an existing capture, for the same reason and via the same
        // helper as `take_reconcile_step` — see `plan_capture_for`. This path MUST make the identical
        // call: the comment above pins that the two cannot drift on when to build, and a focus edge
        // landing inside the ~78 ms build window is one of the two ways the double-build was reached.
        let build_in_flight = build_suppresses_watch(sess.build_started_at.map(|t| t.elapsed()));
        let plan = plan_capture_for(
            capture_should_be_live(sess.armed, sess.focused, sess.capture_warm_now()),
            sess.capture.is_some(),
            build_in_flight,
        );
        tracing::info!(
            target: "dictation",
            armed = sess.armed,
            focused = sess.focused,
            has_capture = sess.capture.is_some(),
            build_in_flight = build_in_flight,
            has_transcriber = sess.transcriber.is_some(),
            plan = ?plan,
            "reconcile decision (focus edge)",
        );
        match plan {
            CapturePlan::Idle => CaptureLeftovers::default(),
            CapturePlan::Build => {
            // transcriber is always Some while armed; the guard is belt-and-suspenders.
            if let Some(transcriber) = sess.transcriber.clone() {
                match build_capture(
                    app.clone(),
                    transcriber,
                    sess.cloud_active.clone(),
                    sess.cloud_tx.clone(),
                ) {
                    Ok((cap, worker)) => {
                        sess.capture = Some(cap);
                        sess.decode_worker = Some(worker);
                        // Fresh capture → fresh liveness verdict (see install_capture).
                        sess.build_started_at = None;
                        sess.clear_audio_fault();
                        // Refocus inside the warm window resumes the parked socket rather than
                        // re-handshaking. Only once the capture is actually installed: resuming a
                        // session we then failed to feed would leave it live but silent.
                        unpark_cloud_for_focus(&sess.cloud, &sess.cloud_active);
                        tracing::info!(target: "dictation", "capture resumed (window focused)");
                    }
                    Err(e) => {
                        let _ = app.emit("dictation://error", e);
                    }
                }
            }
            CaptureLeftovers::default()
            }
            CapturePlan::Teardown => {
            // Tell the worker to abandon its queued backlog before handing it back, so the caller's
            // off-lock drop doesn't wait out the decode duration of up to DECODE_QUEUE_CAP queued
            // segments. A paused capture's trailing partials are moot — same rationale as
            // stop_capture (which also aborts first).
            if let Some(w) = sess.decode_worker.as_ref() {
                w.abort();
            }
            // Park the cloud socket too, so a quick refocus reuses it instead of re-handshaking.
            // Safe under the lock: pause() is a non-blocking channel send, not main-thread-dependent
            // work — the same reasoning `reconcile_capture`'s Teardown arm states for doing it here.
            park_cloud_for_blur(&sess.cloud, &sess.cloud_active);
            tracing::info!(target: "dictation", "capture paused (window unfocused or muted)");
            // TAKEN, not dropped: the cpal stream teardown touches CoreAudio and the worker drop
            // waits on a thread, and neither may happen while this lock is held.
            CaptureLeftovers { capture: sess.capture.take(), worker: sess.decode_worker.take() }
            }
        }
    }

    /// Reconcile the cpal capture to `armed && focused` from ANY thread WITHOUT ever holding the
    /// session lock across the main-thread-dependent work. This is the worker-safe counterpart to
    /// `reconcile_locked` (which runs only on the main thread via `set_focused`, where `is_focused()`
    /// is serviced inline and `Capture::start` doesn't self-block). Holding the lock across those
    /// calls from an async-runtime worker was the sparkle-sfxu launch deadlock: the worker parked on
    /// the main thread while the main thread parked on this very lock in the `Focused` handler.
    ///
    /// Three phases, and the lock is held for NONE of the blocking ones:
    ///   1. Query focus with NO lock (`is_focused()` posts to + blocks on the main thread off-main).
    ///   2. Decide + extract under the lock, then RELEASE (`take_reconcile_step`).
    ///   3. Build / tear down with NO lock (`Capture::start` and the cpal-stream drop touch CoreAudio),
    ///      then install under the lock with a re-validation (`install_capture`).
    pub fn reconcile_capture(&self, app: &AppHandle) {
        // Snapshot the focus GENERATION before the off-lock sample. `set_focused` (driven by the
        // main-thread window-focus events) is the SOLE authority for `sess.focused`; our off-lock
        // the panel-filtered focus poll merely SEEDS it at arm time (so the mic comes up without waiting for
        // the first focus event) — and only when no focus event has spoken since we sampled. If the
        // generation moved, a Focused event landed while that poll was blocked on the
        // main thread, so our sample is stale and MUST NOT clobber the authoritative value. Without
        // this the worker could write a stale `focused=true` over a fresh blur and leave the mic live
        // while the window is unfocused (defeating the sparkle-9oz6 gate) — the TOCTOU roborev caught.
        let focus_gen = self.1.load(Ordering::SeqCst);
        // The TYPING policy, not the frontmost one: the capture takeover is a key-accepting panel
        // that mounts useAmbientVoice, so it must count as "focused" or the mic is never built for
        // it (the takeover's whole reason to exist). The helper is still excluded — see
        // frontmost::is_typing_window.
        let sampled_focus = crate::frontmost::any_typing_window_focused(app);
        match self.take_reconcile_step(sampled_focus, focus_gen) {
            ReconcileStep::Idle => {}
            // Drop OUTSIDE the lock: `Capture::drop` pauses the cpal stream and the worker join drains
            // queued decodes — neither may run under the session lock. Order mirrors every teardown:
            // the Capture (sole decode-channel Sender) drops first, then the worker joins.
            ReconcileStep::Teardown { capture, worker } => {
                // SAY WHICH TEARDOWN THIS IS (roborev 59586). Folding the in-flight marker into the
                // has-capture term made `Teardown { capture: None }` reachable — a stop/blur landing
                // inside the ~78 ms build window, where the decision is preserved but nothing is
                // installed to release. Logging "capture paused" there is a new false statement in
                // exactly the window whose misleading logging this work exists to delete: nothing
                // was paused, and the mic is released later by `install_capture`'s discard.
                let had_capture = capture.is_some();
                drop(capture);
                drop(worker);
                if had_capture {
                    tracing::info!(target: "dictation", "capture paused (window unfocused or muted)");
                } else {
                    tracing::info!(
                        target: "dictation",
                        "stop/blur landed during a build; the in-flight capture will be discarded on install"
                    );
                }
            }
            // Build OUTSIDE the lock (Capture::start's CoreAudio init blocks on the main thread), then
            // install under the lock only if the arm intent is still current.
            ReconcileStep::Build { transcriber, cloud_active, cloud_tx } => {
                match build_capture(app.clone(), transcriber.clone(), cloud_active, cloud_tx) {
                    Ok((capture, worker)) => self.install_capture(app, &transcriber, capture, worker),
                    Err(e) => {
                        // The build FAILED — clear the in-flight marker so the watchdog stops
                        // treating this as a build still running and can escalate/retry.
                        //
                        // …AND RE-ISSUE, exactly as the discard path does (roborev 60351). This is
                        // the OTHER way a build gets invalidated, and it was dropping the same
                        // suppressed reconcile: marker set for T1 → stop → start installs T2 and
                        // reconciles to Idle because the marker stands → T1's build returns Err (the
                        // device was held during the stop) → marker cleared, error emitted, nothing
                        // pending. Same armed && focused && no-capture dead end, recoverable only by
                        // the watchdog ~3 s later. The retry frequently SUCCEEDS here, because the
                        // failure belonged to the stale T1 attempt and not to T2's session.
                        //
                        // NO RETRY STORM — and the bound is a LATCH, not the in-flight marker. An
                        // earlier version of this comment claimed the re-issued build would find
                        // `build_started_at` set by its own plan and stop there; it does not, because
                        // the line clearing that marker runs first, so the re-issued reconcile plans
                        // a fresh Build every time. A device failing for its OWN reasons therefore
                        // recursed until the stack ran out (roborev 60384). `note_build_failed`
                        // spends a one-shot budget instead: the stale-attempt case gets its retry,
                        // and a persistently failing device falls through to the watchdog.
                        let reissue = {
                            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
                            note_build_failed(&mut sess)
                        };
                        let _ = app.emit("dictation://error", e);
                        if reissue {
                            tracing::info!(
                                target: "dictation",
                                "re-reconciling after a FAILED build; the session still wants a capture",
                            );
                            self.reconcile_capture(app);
                        }
                    }
                }
            }
        }
    }

    /// Phase 2 of `reconcile_capture`: under the lock, record focus, decide the transition via
    /// `plan_capture`, and EXTRACT whatever the caller then acts on outside the lock — returning
    /// (and thus releasing the lock) before any audio-device or window call. Never touches CoreAudio
    /// or a window itself, so it cannot participate in the main-thread round-trip that deadlocked.
    fn take_reconcile_step(&self, sampled_focus: bool, focus_gen: u64) -> ReconcileStep {
        let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
        // Seed focus from the off-lock sample ONLY if no focus event superseded it while we sampled
        // (the generation is unchanged). If it moved, set_focused already wrote — or is about to write
        // under this same lock — the authoritative value, so leave `sess.focused` alone rather than
        // clobbering a fresh blur/gain with our stale sample. This makes set_focused the single writer
        // that matters and closes the TOCTOU (sparkle-sfxu review round 2).
        if self.1.load(Ordering::SeqCst) == focus_gen {
            sess.focused = sampled_focus;
        }
        // ── LOG THE DECISION, ALWAYS — INCLUDING `Idle` ──────────────────────────────────────────
        // The 2026-08-05 "captures no audio" hunt was blind here for hours. Dictation logged only
        // the chatty paths (`build_capture`, "capture paused"), so a session that armed and then
        // reconciled to `Idle` — the mic silently never coming up — produced NO line at all, and
        // looked identical in the log to a mic nobody had asked for. Worse, the two inputs that
        // decide it (`armed`, `focused`) were never recorded, so "which term is false" could not be
        // answered from a log at all; it had to be inferred, and was inferred wrongly.
        //
        // Cheap: this runs on arm and on focus edges, not per audio frame.
        // ── A BUILD IN FLIGHT IS A CAPTURE THAT ALREADY EXISTS, FOR THIS DECISION ────────────────
        // `sess.capture` is not written until `install_capture`, which runs AFTER the off-lock
        // `build_capture` (CoreAudio init, ~78 ms measured). So two reconciles that land inside that
        // window BOTH read `capture.is_some() == false`, both decide `Build`, and one
        // `start_dictation` produces TWO captures on the same device. Classic check-then-act.
        //
        // MEASURED, not hypothetical: sparkle.log.2026-08-06 shows the pair 0.17 ms apart on every
        // steady-state cycle —
        //     34.184683  reconcile decision … has_capture=false … plan=Build
        //     34.184853  reconcile decision … has_capture=false … plan=Build
        //     34.262372  capture bound to input device
        //     34.262651  capture bound to input device
        // — 202 `build_capture` against 180 `start_dictation` across the day, and the loser is then
        // thrown away by `install_capture`'s `still_current` check, which reports it as
        // "discarding a capture built during a stop/blur race" (153×) when NO stop or blur was
        // involved. That misattribution is what sent two investigations hunting a focus race.
        //
        // WHY `build_suppresses_watch` AND NOT `build_started_at.is_some()`: the marker is cleared
        // on every path a build can normally leave by (install, discard, and the error arm in
        // `reconcile_capture`), so only a HUNG build can leave it standing. Treating it as
        // permanently true would then refuse to ever rebuild — which is precisely the trap roborev
        // 55300 documents one bound away from here. Reusing that same bound keeps ONE answer to
        // "is this build still believable" rather than letting a second one drift away from it.
        let build_in_flight = build_suppresses_watch(sess.build_started_at.map(|t| t.elapsed()));
        let plan = plan_capture_for(
            capture_should_be_live(sess.armed, sess.focused, sess.capture_warm_now()),
            sess.capture.is_some(),
            build_in_flight,
        );
        tracing::info!(
            target: "dictation",
            armed = sess.armed,
            focused = sess.focused,
            has_capture = sess.capture.is_some(),
            // Logged SEPARATELY from `has_capture` rather than folded into it: the whole reason this
            // bug survived is that the log could not distinguish "no capture" from "no capture YET".
            build_in_flight = build_in_flight,
            has_transcriber = sess.transcriber.is_some(),
            plan = ?plan,
            "reconcile decision",
        );
        match plan {
            // `transcriber` is always Some while armed; the guard mirrors reconcile_locked's
            // belt-and-suspenders — a Build with nothing to build from is simply Idle.
            CapturePlan::Build => match sess.transcriber.clone() {
                Some(transcriber) => {
                    // Mark the build as genuinely in flight so the watchdog does not mistake the
                    // (off-lock, main-thread-blocking) build window for a failure.
                    sess.build_started_at = Some(std::time::Instant::now());
                    ReconcileStep::Build {
                        transcriber,
                        cloud_active: sess.cloud_active.clone(),
                        cloud_tx: sess.cloud_tx.clone(),
                    }
                }
                None => ReconcileStep::Idle,
            },
            CapturePlan::Teardown => {
                // Abort the decode worker's backlog BEFORE handing it back for the drop, so the join
                // the caller does outside the lock is near-instant (same rationale as stop_capture).
                if let Some(w) = sess.decode_worker.as_ref() {
                    w.abort();
                }
                // Park the cloud socket in warm standby on the way out. Safe under the lock: pause()
                // is a non-blocking channel send, not the main-thread-dependent work sparkle-sfxu
                // bans here. Doing it now (rather than in the caller's off-lock drop) keeps the park
                // atomic with the decision that produced it.
                park_cloud_for_blur(&sess.cloud, &sess.cloud_active);
                ReconcileStep::Teardown {
                    capture: sess.capture.take(),
                    worker: sess.decode_worker.take(),
                }
            }
            CapturePlan::Idle => ReconcileStep::Idle,
        }
    }

    /// Phase 3 of `reconcile_capture`: install a capture that was built OUTSIDE the lock, but only if
    /// the arm intent is still EXACTLY current — re-validated under the lock because a `stop_dictation`,
    /// a blur, or a racing start could have landed while we built (the same post-build re-check
    /// `start_cloud_stream` does after its blocking handshake). `built_for` is the transcriber the
    /// capture was built against; an `Arc::ptr_eq` mismatch means a stop+start swapped in a fresh
    /// session generation, so this capture is stale and is dropped (outside the lock) rather than
    /// installed against the new one.
    fn install_capture(
        &self,
        app: &AppHandle,
        built_for: &Arc<Mutex<ParakeetTdt>>,
        capture: Capture,
        worker: DecodeWorker,
    ) {
        // Whether a user-visible audio fault was standing when this capture landed. Installing
        // clears the latches, so without capturing it first the `Recovered` retraction could never
        // fire for the missing-capture path — leaving the (sticky) frontend error latched on a
        // microphone that is working again (roborev 55286).
        let mut retract = false;
        // How long this capture took to build, read BEFORE the marker is cleared. It is the number
        // that explains a missed hold — 232 ms idle vs 2083 ms under load — and without it the
        // report says only "you got nothing" with no account of why.
        let mut fate = CaptureFate::Install;
        let mut build_ms: u64 = 0;
        let discard = {
            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            build_ms = sess
                .build_started_at
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);
            sess.build_started_at = None;
            fate = classify_capture_fate(
                capture_should_be_live(sess.armed, sess.focused, sess.capture_warm_now()),
                sess.capture.is_none(),
                sess.transcriber.as_ref().map(|t| Arc::ptr_eq(t, built_for)).unwrap_or(false),
            );
            if fate == CaptureFate::Install {
                sess.capture = Some(capture);
                sess.decode_worker = Some(worker);
                // Fresh capture → fresh liveness verdict. Carrying the latches over would let a
                // rebuild inherit "already reported", silently suppressing the notice for a mic
                // that is still dead.
                //
                // BUT A REBUILD IS NOT EVIDENCE OF AUDIO, and under churn that distinction became
                // load-bearing: a device with a standing silent run would have its notice retracted
                // here on every install and re-reported by the next tick, flapping the warning once
                // every couple of seconds (knightwatch probe 2). The retraction is claimed only when
                // nothing durably contradicts it; real recovery still fires it from the watchdog's
                // `Recovered` arm, which has actually seen a voiced sample.
                //
                // AND WITHHOLDING THE RETRACTION MUST NOT ALSO DISARM THE REAL ONE. `Recovered`
                // fires only when `reported` is still set, so clearing the latch unconditionally
                // here left the notice with NO route down at all: if the rebuild is what fixed the
                // mic — the remedy this branch's own copy tells the user to try — the next tick
                // folds a voiced delta, `durably_silent` goes false, and both the `Warming` and
                // `Live` arms return `Idle` with `reported` already false. The sticky frontend
                // error then stands over a working microphone, which is the exact bug class this
                // branch exists to delete (knightwatch probe 3).
                retract = install_retracts(sess.audio_reported, sess.silence_watch.as_ref());
                let keep_reported = reported_after_install(sess.audio_reported, retract);
                sess.clear_audio_fault();
                sess.audio_reported = keep_reported;
                // Resume a socket parked by the blur that preceded this rebuild — only on the
                // still_current path, so a capture discarded by a stop/blur race never revives the
                // cloud session it raced.
                unpark_cloud_for_focus(&sess.cloud, &sess.cloud_active);
                tracing::info!(target: "dictation", "capture resumed (window focused)");
                None
            } else {
                // Abort before returning so the drop's join (done outside the lock) is near-instant.
                worker.abort();
                Some((capture, worker))
            }
        }; // release the lock before dropping the raced-out capture (its cpal-stream drop touches CoreAudio)
        let mut reissue = false;
        if let Some((capture, worker)) = discard {
            // NAME THE ACTUAL CAUSE. This line used to say "discarding a capture built during a
            // stop/blur race" for all three fates, including the ones where no stop and no blur were
            // involved — the misattribution this file already records as having sent two
            // investigations after a focus race that never happened.
            match fate {
                CaptureFate::MissedTheHold => {
                    // THE ONE THAT COSTS THE USER THEIR WORDS, at WARN because it is a user-visible
                    // failure and these reports arrive hours later from a release build where a
                    // DEBUG line would not have been recorded.
                    tracing::warn!(
                        target: "dictation",
                        build_ms,
                        "the microphone finished starting AFTER the hold ended, so this utterance \
                         captured no audio at all — the capture is being discarded with nothing in it"
                    );
                    // Tell the frontend, so it can say THIS rather than let the relay's
                    // "connected too late" banner speak for a condition it does not cover. That
                    // banner promises "your words are still captured", which is false here.
                    let _ = app.emit("dictation://capture-missed", capture_missed_payload(MissedStage::Capture, build_ms));
                }
                CaptureFate::LostToASibling => tracing::info!(
                    target: "dictation",
                    build_ms,
                    "a second capture finished after one was already installed; discarding the \
                     loser — the audio was captured by its sibling, nothing is lost"
                ),
                CaptureFate::Stale => tracing::info!(
                    target: "dictation",
                    build_ms,
                    "discarding a capture whose session generation has already rotated"
                ),
                // Unreachable: `Install` never produces a discard. Stated rather than omitted so a
                // future relaxation cannot silently fall into the missed-hold report.
                CaptureFate::Install => tracing::info!(
                    target: "dictation",
                    "discarding a capture that was classified as installable"
                ),
            }
            drop(capture);
            drop(worker);
            // ── RE-ISSUE THE RECONCILE THIS BUILD WAS SUPPRESSING (roborev 59586) ───────────────
            // `plan_capture_for` treats an in-flight build as an existing capture, which DROPS the
            // suppressed reconcile rather than deferring it — and nothing re-runs it if the build it
            // deferred to is then thrown away. Reachable entirely inside the ~78 ms window: a Build
            // for transcriber T1 is planned and marks in-flight; `stop_dictation` takes the
            // transcriber; `start_dictation` installs a fresh Arc T2 and reconciles to Idle *because
            // the marker still stands*; then the T1 build lands, fails `ptr_eq`, and is discarded
            // here. The session is left armed && focused with no capture and nothing pending.
            //
            // Before the dedup that sequence was self-correcting — step 3 simply built a capture and
            // step 4 threw away the stale one, wasteful but live. Without this re-issue the only
            // recovery is the watchdog's missing_tick escalation, i.e. the dedup would trade one
            // redundant capture for up to ~3 s of DEAD MICROPHONE. That is a strictly worse bug than
            // the one it fixes, so the suppressed request is re-issued by whoever invalidates the
            // build it was suppressed behind.
            let sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            reissue = discard_needs_reissue(
                capture_should_be_live(sess.armed, sess.focused, sess.capture_warm_now()),
                sess.capture.is_some(),
            );
        }
        if reissue {
            tracing::info!(
                target: "dictation",
                "re-reconciling after a discarded build; the session still wants a capture",
            );
            self.reconcile_capture(app);
        }
        if retract {
            // The mic is back. Retract the notice we showed, or the frontend's sticky error state
            // keeps the cloud relay from resuming on a capture that is now healthy.
            tracing::info!(target: "dictation", "capture rebuilt after an audio fault; retracting the notice");
            let _ = app.emit("dictation://audio-recovered", ());
        }
    }

    /// Record whether any Sparkle window is the focused OS window and reconcile the mic to match.
    /// Called from the window-focus event (lib.rs). When the app-level focus actually flips we emit
    /// `dictation://focus` so the frontend can pause/resume the billable cloud stream + per-minute
    /// meter, reset the dictation phase, and update the listening UI. Moving focus between two Sparkle
    /// windows keeps `focused` true, so no event fires and the mic stays live.
    pub fn set_focused(&self, app: &AppHandle, focused: bool) {
        let (changed, leftovers) = {
            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if sess.focused == focused {
                (false, CaptureLeftovers::default())
            } else {
                sess.focused = focused;
                (true, Self::reconcile_locked(&mut sess, app))
            }
        }; // release the lock before emitting AND before the teardown drops below
        // THE DEADLOCK FIX. This drop waits on the decode thread and disposes a cpal stream; doing
        // it inside the block above (which `reconcile_locked` used to) held the session mutex across
        // an unbounded `pthread_join` and hung the whole app — main thread blocked here at 6705 of
        // 6705 samples. `set_focused` is called from BOTH the main-thread focus handler and
        // `note_focus_event`'s deferred-blur thread, so either one holding this lock for an
        // unbounded time stalls the other. See `DECODE_JOIN_TIMEOUT`.
        drop(leftovers);
        if changed {
            let _ = app.emit("dictation://focus", focused);
        }
    }

    /// Entry point for a window `Focused` event, with cross-window-switch coalescing. Focus *gain*
    /// is applied immediately (resume the mic now, and cancel any pending blur). Focus *loss* is
    /// deferred ~120ms and re-checked via `should_emit_blur`, so flipping between two Sparkle windows
    /// — where macOS emits the old window's resignKey before the new window's becomeKey — never looks
    /// momentarily unfocused and so never tears down active dictation. A real tab-away (no window
    /// regains focus within the window) still commits the blur and releases the OS mic.
    pub fn note_focus_event(&self, app: &AppHandle, focused: bool) {
        // Trust the event payload for a GAIN: `Focused(true)` means this window just became key —
        // authoritative even if `is_focused()` momentarily lags the notification. Resume immediately
        // and bump the generation so any in-flight deferred blur supersedes itself.
        if focused {
            self.1.fetch_add(1, Ordering::SeqCst);
            self.set_focused(app, true);
            return;
        }
        // LOSS: this window resigned key. Another Sparkle window may be taking over (a window switch),
        // so don't pause yet — defer ~one runloop turn and re-poll, letting a paired becomeKey land
        // first. `should_emit_blur` commits the blur only if no newer focus event superseded us AND a
        // re-poll still finds nothing focused (a real tab-away).
        let my_gen = self.1.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        let focus_gen = self.1.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(FOCUS_BLUR_COALESCE_MS));
            if should_emit_blur(
                my_gen,
                focus_gen.load(Ordering::SeqCst),
                // MUST stay HELPER-filtered (sparkle-9oz6): that non-activating panel can hold key
                // focus while the user is in another app, and counting it here would suppress this
                // blur and leave the microphone open indefinitely. `any_typing_window_focused`
                // excludes it for exactly that reason — it widens the policy to the CAPTURE
                // takeover only, which is where the user is actively narrating. Called directly,
                // with no local wrapper that could drift back to an unfiltered fold.
                crate::frontmost::any_typing_window_focused(&app),
            ) {
                // The app may be tearing down by the time this deferred body runs — `state::<T>()`
                // PANICS if the DictationState was already removed during shutdown (
                // teardown window). `try_state` returns None instead, so we simply bail: a blur that
                // never lands during exit is harmless (the mic is being released anyway).
                if let Some(state) = app.try_state::<DictationState>() {
                    state.set_focused(&app, false);
                }
            }
        });
    }
}

/// Build the cpal capture stream and wire its callback to the transcription pipeline, plus the
/// dedicated decode worker that runs the heavy on-device transducer OFF the realtime thread. Shared
/// by start_dictation (fresh arm) and the focus reconciler (resume), so the routing logic — cloud
/// frames while actively dictating, else the on-device model — lives in exactly one place.
///
/// Returns `(Capture, DecodeWorker)`: the caller stores BOTH in the session and, on teardown, drops
/// the Capture first (closing the decode channel) then the DecodeWorker (a bounded join). The audio
/// callback now does ONLY cheap, bounded work — level meter, VAD windowing, and non-blocking channel
/// pushes — so it never overruns the CoreAudio capture ring buffer with a synchronous decode.
// ── HANDING THE GESTURE ORIGIN TO THE CAPTURE IT BELONGS TO (sparkle-oyapv) ──────────────────────
//
// `start_dictation` knows when the key went down and what every stage before the capture cost;
// `build_capture` is where a `Capture` is actually opened. Between them sit `reconcile_capture`,
// `reconcile_locked` and the reconcile-step machinery — none of which have any business carrying a
// diagnostic.
//
// A ONE-SLOT HANDOFF, NOT A WIDENED SIGNATURE, and that is a deliberate trade. Threading an
// `Option<ArmOrigin>` through would have changed three production signatures and forced `None` at
// every one of `reconcile_capture`'s other call sites (focus events, the watchdog, the device-change
// path) so that a log line could be complete. The slot is set immediately before the synchronous
// `reconcile_capture` call and taken by the capture that call builds, so in the ordinary case the
// handoff is unambiguous.
//
// WHAT IT CAN GET WRONG, stated rather than defended against: a reconcile racing in from the focus
// event between the set and the take would consume the origin and label ITS capture with this arm's
// keydown. That mislabels one diagnostic line and changes no behaviour. `ARM_ORIGIN_MAX_AGE` bounds
// the other direction — an origin nobody claimed (the arm aborted, or no window was focused so no
// capture was built) must not be picked up minutes later by an unrelated rebuild.
const ARM_ORIGIN_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(10);

static ARM_ORIGIN: Mutex<Option<crate::audio::ArmOrigin>> = Mutex::new(None);

/// Record the gesture origin for the capture the NEXT `build_capture` opens.
fn set_arm_origin(origin: crate::audio::ArmOrigin) {
    *ARM_ORIGIN.lock().unwrap_or_else(|p| p.into_inner()) = Some(origin);
}

/// Claim the pending gesture origin, if one is pending and still fresh.
///
/// Takes unconditionally — a stale origin is DISCARDED rather than left in place, so it cannot go on
/// to mislabel a later capture after failing to label this one.
fn take_arm_origin() -> Option<crate::audio::ArmOrigin> {
    let taken = ARM_ORIGIN.lock().unwrap_or_else(|p| p.into_inner()).take()?;
    (taken.keydown.elapsed() < ARM_ORIGIN_MAX_AGE).then_some(taken)
}

fn build_capture(
    app: AppHandle,
    transcriber: Arc<Mutex<ParakeetTdt>>,
    cloud_active: Arc<AtomicBool>,
    cloud_tx: Arc<Mutex<Option<CloudAudioSender>>>,
) -> Result<(Capture, DecodeWorker), String> {
    let app_cb = app.clone();
    // Spawn the decode worker BEFORE the stream so the callback's very first closed segment has a
    // live channel to push into. The worker holds an independent `Arc<Decoder>` clone, so its
    // decode locks only the recognizer — never the `transcriber` mutex the audio callback holds for
    // the VAD — and thus can't stall a capture frame.
    let decoder = transcriber.lock().unwrap_or_else(|p| p.into_inner()).decoder();
    let (decode_tx, worker) = DecodeWorker::spawn(decoder, app.clone());
    // Last emitted speech-detection state, so we emit `dictation://speaking` only on the
    // rising/falling EDGE rather than ~60×/sec. Fresh per capture (starts false), so a newly
    // (re)built capture begins "silent" and the waveform stays flat until real speech lands.
    let mut last_speaking = false;
    // Has the CURRENTLY OPEN VAD segment overlapped the cloud path at any point? Lives OUT here,
    // across frames, because that is the whole point: a segment spans many frames but is only
    // handed over when it CLOSES, so sampling `cloud_active` at close time asks the wrong question.
    // A segment that opened while Deepgram was streaming and closed just after `cloud_active`
    // flipped false — a mid-stream disconnect or a credits-exhausted teardown, both documented
    // fallbacks below — would be decoded on-device and emitted as a partial, re-typing up to
    // `max_speech_duration` (8 s) of speech the relay ALREADY typed. Latching across the segment is
    // what makes "Deepgram owns this audio" hold for the whole span, not for one frame
    // (roborev 55300). Fresh per capture, like `last_speaking`.
    let mut segment_touched_cloud = false;
    // Same edge bookkeeping for the on-device speech level. Fresh per capture (starts false), so a
    // newly (re)built capture never begins by claiming the user is mid-sentence.
    let mut last_on_device_speech = false;
    // Retains audio while the relay is not routing, so the words spoken before it comes up are not
    // lost (sparkle-oyapv). FRESH PER CAPTURE, like the two flags above, and for the same reason
    // sharpened by what this one holds: a rebuilt capture must never begin by flushing audio from
    // the PREVIOUS capture into the new socket. That would be both a wrong transcript and a
    // retention the user did not consent to when they released the key.
    let mut preroll = crate::audio::PreRoll::new(crate::audio::PREROLL_SAMPLES);
    // NOTE: the transcriber is locked on every CoreAudio callback frame, but ONLY for the cheap VAD
    // windowing / segment extraction (`accept_segments`) — the hundreds-of-ms transducer decode runs
    // on the decode worker, never here. finalize() is always called *after* Capture (and the worker)
    // are gone (stop_dictation), so the slow finalize path never contends with a live callback frame.
    tracing::info!(target: "dictation", "build_capture: capture starting");
    // Throttle the level meter to ~25 Hz. CoreAudio fires this callback far faster (one frame per
    // buffer, tens of Hz), but the meter only feeds the waveform animation — emitting every frame
    // is needless IPC + store churn. Start in the past so the very first frame emits.
    const LEVEL_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(40);
    // Start "in the past" so the first frame emits, via checked_sub (Instant - Duration panics on
    // underflow; this can't underflow on macOS uptime clocks, but the idiom is the robust one).
    let now0 = std::time::Instant::now();
    let mut last_level_emit = now0.checked_sub(LEVEL_EMIT_INTERVAL).unwrap_or(now0);
    // Claim the gesture origin this capture is being built FOR, if there is one (see
    // `take_arm_origin`). One-shot: a capture rebuilt later by a focus event or the watchdog finds
    // the slot empty and reports no keydown span, which is correct — it had no keydown behind it.
    let origin = take_arm_origin();
    let capture = Capture::start(&current_device_choice(), origin, move |frame: Vec<f32>| {
        let now = std::time::Instant::now();
        if now.duration_since(last_level_emit) >= LEVEL_EMIT_INTERVAL {
            last_level_emit = now;
            let _ = app_cb.emit("dictation://level", rms_level(&frame));
        }
        // While the cloud stream is open (user actively dictating), route frames to Deepgram and
        // skip the on-device model entirely. Otherwise the on-device model handles the frame —
        // this is the local transcription path, which is what runs whenever the relay is not
        // routing (armed but passive, signed out, out of credits, socket death). The callback only
        // enqueues; the transducer decodes on the DecodeWorker, off this realtime thread.
        // Locks are poison-tolerant ():
        // a prior panicked frame must not wedge dictation; the audio.rs panic firewall already
        // prevents such a panic from aborting the process.
        // NOTE: on a mid-stream cloud failure there's a brief (~one event round-trip) window where
        // cloud_active is still true but send_audio's channel is dead, so those frames are dropped
        // rather than transcribed on-device — until the cloud-ended event drives stop_cloud_stream
        // and flips cloud_active back. Accepted: the window is tens of ms on a rare disconnect.
        //
        // `speaking` drives the waveform animation (frontend `dictation://speaking` listener); see
        // frame_speaking. The VAD runs on EVERY frame, cloud or not — that is what makes the
        // waveform honest on the cloud path, where it previously had nothing real to report and
        // animated the meter for the whole stream.
        let cloud = cloud_active.load(Ordering::Relaxed);
        let vad_detected = {
            let mut guard = transcriber.lock().unwrap_or_else(|p| p.into_inner());
            // On the cloud path drop closed segments WITHOUT copying their samples out: that copy
            // is ~512 KB of alloc + memcpy + free on the CoreAudio IO thread, per utterance, for a
            // Vec dropped one line later. `discard_segments` still feeds the VAD, which is what
            // produces the `speaking()` flag the waveform needs.
            let (segs, closed) = if cloud {
                let n = guard.discard_segments(&frame);
                (Vec::new(), n > 0)
            } else {
                let segs = guard.accept_segments(&frame);
                let closed = !segs.is_empty();
                (segs, closed)
            };
            let spk = guard.speaking();
            drop(guard);
            let (latch, relays_audio) = segment_cloud_latch(segment_touched_cloud, cloud, closed);
            segment_touched_cloud = latch;
            if relays_audio {
                tracing::debug!(
                    target: "dictation",
                    "dropping a segment that straddled the cloud→on-device switch; the relay already transcribed it"
                );
            } else {
                // ── THE ON-DEVICE ENGINE IS TAKING THIS AUDIO, SO THE RING MUST LET IT GO ────────
                // (roborev, High.) A closed segment dispatched here is decoded on the DecodeWorker
                // and typed into the composer as a `dictation://partial`. The pre-roll is holding
                // those very frames, so without this the next time the relay comes up it would
                // flush words the user can ALREADY SEE to Deepgram and have them transcribed a
                // second time — duplicated text in the composer.
                //
                // `segment_cloud_latch` above does not cover this: it suppresses a segment that
                // STRADDLES the switch, whereas this is a segment that opened and closed entirely
                // before it. Reachable on every on-device↔cloud round trip inside one capture —
                // socket death and reopen, out-of-credits then restored, and hold-to-hold when the
                // capture survives the release.
                //
                // Clearing on `closed` (not per frame) is deliberate: mid-segment audio has NOT
                // been claimed by anything yet, and that is precisely the audio the pre-roll exists
                // to save.
                //
                // ── AND THE CLEAR HAPPENS *AFTER* THE HAND-OFF, NOT BEFORE (roborev, Medium) ─────
                // "The on-device engine takes the segment" is not the same event as "we tried to
                // give it one". `try_send` is deliberately lossy — a full queue drops the segment
                // (`DECODE_QUEUE_CAP`, the documented "burst, or a slow machine") and a
                // disconnected one swallows it silently. Clearing first meant that on exactly those
                // paths the audio was gone from BOTH engines: never decoded on-device, and no
                // longer in the ring for the relay to pick up. A slow machine is precisely when the
                // queue fills AND precisely when the ring is supposed to save the words, so the two
                // failures coincided.
                //
                // THE ORDERING IS THE FIX, so it lives inside `dispatch_closed_segments` where a
                // test can drive it against a real channel — a predicate the call site re-implements
                // by hand pins nothing (roborev, Medium: the first attempt at this extracted only
                // `accepted > 0`, and reverting the call site to the broken order left the suite
                // green).
                dispatch_closed_segments(&decode_tx, segs, &mut preroll);
            }
            spk
        };
        // ── THE PRE-ROLL (sparkle-oyapv) ─────────────────────────────────────────────────────────
        // `preroll.note` is offered EVERY frame, `cloud` or not, and that is the whole mechanism:
        // while the relay is not routing it retains the audio (bounded, RAM only) instead of
        // letting it fall on the floor, and on the frame the relay comes up it hands back the
        // retained history followed by this frame — so the socket receives one continuous utterance
        // with its leading words in front of it.
        //
        // Measured, on the founder's machine: `Capture::start` plus CoreAudio's first buffer is
        // ~1.17 s cold / ~375-440 ms warm, and the handshake is "~hundreds of ms" on top. That is
        // the audio this recovers; without it the user's first words are simply never captured.
        // (The ~456/~212 this used to cite was measured against a VIRTUAL device — ~2.5× optimistic.
        // `crate::audio::PREROLL_SAMPLES` carries the corrected figures and what they cost the
        // ring's headroom.)
        let to_send = preroll.note(&frame, cloud);
        if !to_send.is_empty() {
            // Route to the relay WITHOUT locking the `cloud` teardown mutex. `try_lock` on the
            // dedicated sender slot NEVER blocks the audio thread: if a start/stop is mid-swap we
            // simply drop this frame (the same tens-of-ms transition window that already drops
            // frames), rather than contend with start/stop_cloud_stream/stop_dictation.
            if let Ok(guard) = cloud_tx.try_lock() {
                if let Some(s) = guard.as_ref() {
                    for f in &to_send {
                        s.send_audio(f);
                    }
                }
            }
            // NOTE the deliberate asymmetry with the old code: a failed `try_lock` drops the
            // retained pre-roll along with the current frame. `note` has already cleared the ring,
            // so it cannot be re-offered. That is the correct trade rather than an oversight —
            // holding it back would mean replaying stale audio into a socket that has since been
            // swapped, and this is the same tens-of-ms window the comment above already accepts.
        }
        // The on-device cancel signal, on its OWN edge — see frame_on_device_speech for why it is
        // not `speaking` below. Reported before the waveform edge so a resume can never be observed
        // by the frontend after the arm it is meant to prevent.
        let on_device_speech = frame_on_device_speech(cloud, vad_detected);
        if on_device_speech != last_on_device_speech {
            last_on_device_speech = on_device_speech;
            emit_on_device_speech(&app_cb, on_device_speech);
        }
        let speaking = frame_speaking(cloud, vad_detected);
        if speaking != last_speaking {
            last_speaking = speaking;
            let _ = app_cb.emit("dictation://speaking", speaking);
        }
    })
    .inspect_err(|e| {
        let _ = app.emit("dictation://error", e.clone());
    })?;
    // Tell the UI WHAT we are listening to. Before this, nothing in the app — log or screen — ever
    // named the input device, which is why a capture bound to a device delivering nothing looked
    // identical to a quiet room for nine minutes, and why a device carrying system audio went
    // unnoticed for a day. The device name is the fact that makes both self-evident.
    let _ = app.emit("dictation://device", capture.device().clone());
    Ok((capture, worker))
}

/// The input device the user has chosen (or automatic), read fresh from config on every build so
/// changing it in the picker takes effect on the next capture without an app restart.
fn current_device_choice() -> DeviceChoice {
    let voice = crate::config::current_effective().config.voice;
    DeviceChoice::from_config(voice.input_device_uid.as_deref(), voice.allow_virtual_input)
}


/// The audio-liveness watchdog's pure decision layer — see `watchdog.rs`. The polling loop that
/// drives it stays here in `impl DictationState`, because it touches session state every tick.
mod watchdog;
use watchdog::{
    build_suppresses_watch, fault_action, fold_silence_evidence, install_retracts, missing_tick,
    reported_after_install, watchdog_emission, FaultAction, SilenceWatch, WatchdogEmission,
    MISSING_CAPTURE_TICKS, WATCHDOG_GRACE, WATCHDOG_POLL,
};


impl DictationSession {
    /// Is the post-release warm window still open? The `hold_recent` term of
    /// `capture_should_be_live` — see that function for why the capture is kept warm at all.
    ///
    /// A STRICT `until > now`, never a duration read that can saturate (memory:
    /// `saturating_duration_since` returns 0 on a backwards clock, so a future-stamped entry HITS
    /// and gets its life extended). `Instant` is monotonic so the backwards case should be
    /// impossible, but this is a microphone staying open — the failure direction to avoid is "warm
    /// forever", so read it the strict way. An earlier version of this note named
    /// `checked_duration_since`, which this function does not call; the property it was arguing for
    /// is the one the comparison above actually has.
    ///
    /// Pinned in `tests::capture_warm_now_*`. Untested by construction until roborev 62000 — the
    /// neighbouring tests exercise the pure `capture_should_be_live` with hand-passed booleans, so
    /// the boolean the production path actually computes was reachable by no test at all, and
    /// mutating this to `is_some()`, or deleting the comparison outright, left the whole suite green.
    ///
    /// THE STRICTNESS ITSELF STAYED UNPINNED FOR ONE MORE ROUND, and this note claimed otherwise
    /// (roborev 63699). Relaxing `>` to `>=` is the one mutation the elapsed-stamp and future-stamp
    /// cases cannot see: only `until == now` at the instant of the read separates the two operators,
    /// and that instant is unreachable while the comparison samples the clock internally. So the
    /// property this doc argues hardest for — "warm forever" is the failure direction to avoid, read
    /// it the strict way — was the single behaviour the tests did not have. Hence `capture_warm_now_at`
    /// below: the clock is a parameter, the boundary case is constructible, and `>=` now goes red.
    fn capture_warm_now(&self) -> bool {
        self.capture_warm_now_at(std::time::Instant::now())
    }

    /// `capture_warm_now` against a caller-supplied clock — the seam that makes `until == now`
    /// constructible. Only the boundary test injects; the two behaviour tests keep calling
    /// `capture_warm_now()`, so the delegation above is a real entry point rather than the
    /// defaulted-seam shape `sparkle-lgbwf` records (a line every test injects past, silently
    /// deletable while the suite stays green).
    fn capture_warm_now_at(&self, now: std::time::Instant) -> bool {
        self.warm_capture_until.is_some_and(|until| until > now)
    }

    /// Clear every per-capture audio-fault latch.
    ///
    /// BOTH latches, not just the report one (roborev 55277). Leaving `audio_reacquired` set would
    /// make the NEXT fault on this capture skip straight to complaining — inverting "recover before
    /// you complain" exactly in the flapping-device case (USB unplug/replug, plug-in load/unload)
    /// where a rebind is the thing that fixes it.
    /// AND THE FAILED-BUILD RETRY BUDGET, for the reason it is in this function rather than at the
    /// call sites (roborev 60387). `build_failure_reissued` is only per-ATTEMPT because something
    /// refunds it; written inline at each install site, every one of those lines was silently
    /// deletable — the suite stayed green while the budget quietly became per-PROCESS, so the first
    /// failed build in the app's lifetime would cost every later arm its re-issue and leave ~3 s of
    /// dead mic on every hold, forever, with no log line saying why. Every caller of this function
    /// is a live capture or a demonstrably voiced device, which is exactly when nothing can be
    /// spinning — so the refund belongs to the same event, and the existing unit test sees it.
    fn clear_audio_fault(&mut self) {
        self.audio_reported = false;
        self.audio_reacquired = false;
        self.audio_missing_ticks = 0;
        self.build_failure_reissued = false;
    }
}

/// The raw-vs-converted sample evidence for one watchdog tick.
///
/// A `health=Silent` verdict says the frames the pipeline saw were all zero; it has never said WHO
/// zeroed them. Carrying these four counters (and the [`ZeroSource`] they classify to) into the
/// fault log is what turns "no audio from the bound input device" — a sentence compatible with a
/// dead mic, a revoked TCC grant, and a bug in our own downmix — into a single line that names
/// which one it was. `raw_nonzero > 0` with `out_nonzero == 0` is OUR bug; both zero with
/// `raw_samples > 0` is the OS handing us digital silence.
#[derive(Debug, Clone, Copy, Default)]
struct SampleCounts {
    raw_samples: u64,
    raw_nonzero: u64,
    out_samples: u64,
    out_nonzero: u64,
    zero_source: ZeroSource,
}

impl DictationState {
    /// Tear the capture down and rebuild it, re-enumerating devices on the way.
    ///
    /// Reuses `reconcile_capture` for the rebuild rather than open-coding one: that path already
    /// re-validates the arm intent under the lock before installing, so a stop or blur landing in
    /// the gap is handled exactly as it is everywhere else. All we do here is remove the capture so
    /// `plan_capture` sees `Build`.
    pub fn reacquire_capture(&self, app: &AppHandle) {
        let taken = {
            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if !sess.armed {
                return; // muted — nothing to re-acquire, and reconciling would fight the mute
            }
            // NO `capture.is_none()` early-return. That guard made this a NO-OP on the path it
            // matters most: an armed session whose rebuild already failed has no capture, which is
            // exactly when we must try to BUILD one (roborev 55286). With nothing to tear down we
            // simply fall through to the reconcile below, which sees `CapturePlan::Build`.
            if let Some(w) = sess.decode_worker.as_ref() {
                // Abort the decode backlog first so the join (outside the lock) is near-instant.
                w.abort();
            }
            (sess.capture.take(), sess.decode_worker.take())
        }; // release the lock BEFORE dropping: the cpal teardown touches CoreAudio (sparkle-sfxu).
        // Tuple fields drop in declaration order, so the Capture (sole decode-channel Sender) goes
        // first and the worker's join follows a closed channel.
        drop(taken);
        self.reconcile_capture(app);
    }

    /// One watchdog tick. Returns the action taken, so the polling loop stays trivial and this is
    /// the only thing with logic in it.
    #[allow(clippy::type_complexity)]
    fn watchdog_tick(&self, app: &AppHandle) -> FaultAction {
        // Set when this tick should attempt another BUILD, independently of whether it also has
        // something to say to the user. The two must be separate: `fault_action` short-circuits on
        // `reported`, so routing the retry through it meant that after the single report the
        // session stopped trying — a microphone plugged back in recovered only if the device LIST
        // happened to change, and a build that failed for any other reason (transient CoreAudio
        // error, a wedged main thread) left the session silent forever. Report once, keep retrying
        // (roborev 55300).
        let mut retry_build = false;
        // The RAW-vs-converted evidence, sampled alongside the verdict so the fault log can say
        // WHO zeroed the audio. Defaults are the "no capture to measure" reading.
        let mut counts = SampleCounts::default();
        // Whether this DEVICE has produced enough zeros across enough captures to be judged, even
        // if the capture in front of us right now is too young to judge on its own. See
        // `SilenceWatch` for the churn this defeats.
        let mut durably_silent = false;
        // Sample under the lock, then RELEASE before doing anything that emits or touches audio.
        let sampled = {
            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            let should_be_live = capture_should_be_live(sess.armed, sess.focused, sess.capture_warm_now());
            match sess.capture.as_ref() {
                Some(c) => {
                    let health = assess_capture_health(
                        c.uptime(),
                        c.health().frames(),
                        c.health().voiced_frames(),
                        WATCHDOG_GRACE,
                    );
                    let device = c.device().clone();
                    counts = SampleCounts {
                        raw_samples: c.health().raw_samples(),
                        raw_nonzero: c.health().raw_nonzero(),
                        out_samples: c.health().out_samples(),
                        out_nonzero: c.health().out_nonzero(),
                        zero_source: c.health().zero_source(),
                    };
                    // Ends the borrow of `sess.capture` before the counter reset below.
                    sess.audio_missing_ticks = 0;
                    // Fold this reading into the evidence that OUTLIVES this capture. Keyed by UID,
                    // so a device with no UID (rare, but the type allows it) simply gets no durable
                    // watch rather than sharing one with every other unnamed device.
                    if let Some(uid) = device.uid.as_deref() {
                        let folded = fold_silence_evidence(
                            sess.silence_watch.take(),
                            uid,
                            counts.raw_samples,
                            counts.raw_nonzero,
                        );
                        durably_silent = folded.is_durably_silent();
                        sess.silence_watch = Some(folded);
                    }
                    Some((health, Some(device), sess.audio_reacquired, sess.audio_reported))
                }
                // The mic SHOULD be capturing but there is no capture. That is what a FAILED
                // re-acquire looks like — `build_capture` returning Err is the likely outcome when
                // the device really is gone, i.e. exactly the fault case — and it must not be
                // invisible, or the nine-minute silent failure is reachable through the recovery
                // path itself (roborev 55277). Debounced against a genuine in-flight build.
                None => {
                    let building =
                        build_suppresses_watch(sess.build_started_at.map(|t| t.elapsed()));
                    let (ticks, fault) =
                        missing_tick(false, should_be_live, building, sess.audio_missing_ticks);
                    sess.audio_missing_ticks = ticks;
                    // Keep RETRYING rather than latching silent: on this cadence we attempt another
                    // build, so a microphone plugged back in — or a build that failed transiently —
                    // recovers on its own instead of waiting for a user toggle. Driven from HERE,
                    // not from `fault_action`, because that returns Idle once `reported` is set
                    // (roborev 55286/55300). `install_capture` clears the latches and emits the
                    // retraction when one of these finally succeeds.
                    retry_build = fault && !building && ticks % MISSING_CAPTURE_TICKS == 0;
                    fault.then_some((
                        AudioHealth::NoFrames,
                        None,
                        sess.audio_reacquired,
                        sess.audio_reported,
                    ))
                }
            }
        };
        // Off the lock (reacquire_capture builds, which touches CoreAudio) and BEFORE the early
        // return, so the retry still runs on the ticks that have nothing new to tell the user.
        if retry_build {
            tracing::info!(
                target: "dictation",
                "armed with no capture; retrying the build (the device may have come back)"
            );
            self.reacquire_capture(app);
        }
        let Some((health, device, reacquired, reported)) = sampled else {
            return FaultAction::Idle;
        };

        // Ask the device whether it is muted before accusing it of anything. `None` means the
        // device does not implement the property (common — many hardware mute switches are
        // invisible to the host), which is "don't know", not "not muted"; we treat it as
        // not-muted here because the ordinary remedies still apply, and the copy stays honest by
        // never claiming the device IS unmuted.
        let muted = device
            .as_ref()
            .and_then(|d| d.uid.as_deref())
            .and_then(crate::audio_devices::is_muted)
            .unwrap_or(false);

        let action = fault_action(health, muted, reacquired, reported, durably_silent);
        // The TCC status, read only on the path that needs it (the Report arm below sets it). It
        // feeds BOTH the fault log and — new as of the 2026-08-05 fix — the sentence the user reads,
        // so the contradiction the log has always recorded is now the thing that picks the remedy.
        let mut tcc = crate::mic_permission::MicAuth::Authorized;
        match action {
            FaultAction::Idle => {}
            FaultAction::Reacquire => {
                tracing::warn!(
                    target: "dictation",
                    device = device.as_ref().map(|d| d.name.as_str()).unwrap_or("<none>"), ?health,
                    raw_samples = counts.raw_samples, raw_nonzero = counts.raw_nonzero,
                    out_samples = counts.out_samples, out_nonzero = counts.out_nonzero,
                    zero_source = ?counts.zero_source,
                    "dictation is armed but no audio is arriving; re-acquiring the input device"
                );
                self.0.lock().unwrap_or_else(|p| p.into_inner()).audio_reacquired = true;
                self.reacquire_capture(app);
                // reacquire_capture installs a FRESH capture, which resets the per-capture latches
                // (see install_capture). Re-set the flag afterwards so the new capture is not
                // granted a second free recovery attempt — otherwise a permanently dead device
                // would re-acquire forever and never surface.
                self.0.lock().unwrap_or_else(|p| p.into_inner()).audio_reacquired = true;
            }
            FaultAction::Report => {
                // Ask TCC again, right now. `ensure_access_blocking` ran once on the arm path, and
                // its answer is a process-local CACHED read — so a grant that lapsed MID-PROCESS
                // (a policy push, a TCC reset, the bundle being replaced under a running app) is
                // invisible to it while CoreAudio has already started delivering zeros forever,
                // which is precisely this module's documented signature for a denied mic. Re-read
                // it here, at the one moment it is diagnostic, and record BOTH the answer and the
                // contradiction: `Authorized` alongside `zero_source=Os` is the stale-grant
                // reading, and it is the difference between "your microphone is broken" (it is
                // not) and "this process's mic grant is dead; restart Sparkle" (it is).
                tcc = crate::mic_permission::status();
                tracing::error!(
                    target: "dictation",
                    device = device.as_ref().map(|d| d.name.as_str()).unwrap_or("<none>"),
                    uid = device.as_ref().and_then(|d| d.uid.as_deref()).unwrap_or("<none>"),
                    is_virtual = device.as_ref().map(|d| d.is_virtual).unwrap_or(false),
                    muted, ?health, ?tcc,
                    raw_samples = counts.raw_samples, raw_nonzero = counts.raw_nonzero,
                    out_samples = counts.out_samples, out_nonzero = counts.out_nonzero,
                    zero_source = ?counts.zero_source,
                    "no audio from the bound input device; telling the user"
                );
                self.0.lock().unwrap_or_else(|p| p.into_inner()).audio_reported = true;
            }
            FaultAction::Recovered => {
                tracing::info!(
                    target: "dictation",
                    device = device.as_ref().map(|d| d.name.as_str()).unwrap_or("<none>"),
                    "audio is arriving again"
                );
                let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
                sess.clear_audio_fault();
                // Retire the cross-capture evidence too. This is the one place it is right to: the
                // device is demonstrably voiced now, so the zeros we banked describe a state that is
                // over. Leaving it would let a device that recovered stay permanently one tick away
                // from being re-reported.
                sess.silence_watch = None;
            }
        }
        // EVERY user-visible output of this tick, decided in one tested place and dispatched here.
        // This site holds no copy and makes no choice about who gets told what — see
        // `WatchdogEmission` for why that separation is the point rather than tidiness.
        match watchdog_emission(action, device.as_ref(), muted, counts.zero_source, tcc) {
            WatchdogEmission::Silent => {}
            WatchdogEmission::Error(message) => {
                let _ = app.emit("dictation://error", message);
            }
            WatchdogEmission::Recovered => {
                let _ = app.emit("dictation://audio-recovered", ());
            }
        }
        action
    }
}

/// Start the background loop that watches for a capture that has stopped hearing, and for input
/// devices appearing or disappearing.
///
/// One thread serves both: the CoreAudio property listener runs on CoreAudio's own dispatch queue,
/// where doing real work is forbidden, so it only sets a flag that this loop picks up on its next
/// tick. That also collapses the burst of notifications a plug-in load produces into a single
/// re-acquire.
pub fn start_audio_watchdog(app: AppHandle) {
    let devices_changed = Arc::new(AtomicBool::new(false));
    let flag = devices_changed.clone();
    // Held for the life of the process; dropping it would unregister the listeners.
    let watcher = crate::audio_devices::DeviceChangeWatcher::start(move || {
        flag.store(true, Ordering::Release);
    });

    std::thread::Builder::new()
        .name("audio-watchdog".into())
        .spawn(move || {
            let _watcher = watcher; // keep the listeners registered for the loop's lifetime
            loop {
                std::thread::sleep(WATCHDOG_POLL);
                // `try_state` (not `state`): during shutdown the DictationState is removed and
                // `state()` PANICS — the same teardown window note_focus_event documents.
                let Some(state) = app.try_state::<DictationState>() else { return };

                if devices_changed.swap(false, Ordering::Acquire) {
                    // FIRST, and unconditionally. The cached device format (`audio::
                    // INPUT_CONFIG_TTL`) is only sound because this fires: a device list or default
                    // input that moved is exactly when a remembered format stops describing the
                    // microphone we are about to open. It must run BEFORE `on_device_list_changed`,
                    // which deliberately returns early when the change does not move the binding —
                    // and "the same device, renegotiated" is a change that leaves the binding alone
                    // while invalidating the format. Dropping a still-valid entry costs one ~100 ms
                    // read on the next hold; keeping an invalid one costs correct audio.
                    crate::audio::invalidate_input_config_cache();
                    state.on_device_list_changed(&app);
                }
                state.watchdog_tick(&app);
            }
        })
        .expect("spawn audio-watchdog thread");
}

impl DictationState {
    /// The set of audio devices changed (a plug-in loaded, a headset was plugged in).
    ///
    /// Re-acquire only if the change actually moves us: recompute the selection against the NEW
    /// device list and compare it to what we are bound to now. An unconditional rebuild would drop
    /// audio mid-sentence every time any unrelated device appeared, and on a machine with eight HAL
    /// plug-ins that is not rare.
    fn on_device_list_changed(&self, app: &AppHandle) {
        let bound = {
            let sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            match sess.capture.as_ref() {
                Some(c) => c.device().name.clone(),
                // No capture. If the mic SHOULD be live, a device appearing is exactly the event
                // that can fix it — plugging the microphone back in after a failed build must
                // recover on its own rather than waiting for a user toggle (roborev 55286).
                None => {
                    let should_be_live = capture_should_be_live(sess.armed, sess.focused, sess.capture_warm_now());
                    drop(sess);
                    if should_be_live {
                        self.reacquire_capture(app);
                    }
                    return;
                }
            }
        };
        let devices = crate::audio_devices::list_input_devices();
        // Only an `Open` names a device we can compare against. A `Refuse` (no safe input) or a
        // `SystemDefault` (nothing enumerated) has no name to diff, so leave those to the liveness
        // watchdog rather than guessing at a rebuild.
        let crate::audio_devices::Resolution::Open { name: want, .. } =
            crate::audio_devices::select_device(&current_device_choice(), &devices)
        else {
            return;
        };
        if want == bound {
            return;
        }
        tracing::info!(
            target: "dictation", from = %bound, to = %want,
            "the audio device list changed and a different input should now be used; re-acquiring"
        );
        self.reacquire_capture(app);
    }
}

// SAFETY: cpal::Stream on CoreAudio is !Send, guarded behind a Mutex.
// ParakeetTdt is genuinely Send (its recognizer/VAD fields are Send+Sync),
// so sharing it via Arc<Mutex<ParakeetTdt>> across threads is sound.
unsafe impl Send for DictationState {}
unsafe impl Sync for DictationState {}

/// Serializes the on-device model load process-wide. At most one download+verify+load runs at a
/// time; a second start awaits it and then finds the model already present.
///
/// Two `start_dictation`s can now genuinely run their slow paths at once — two windows mounting, or
/// two rapid mic clicks — because both see `armed == false` (the first hasn't armed yet, it's still
/// loading) and neither takes the fast path. That is NEWLY reachable: while this command ran inline
/// on the main thread the two were serialized by the event loop.
///
/// It is not merely wasteful (two 631MB downloads), it is UNSAFE without this lock. `model::ensure`
/// stages into a per-call scratch dir, but every call promotes into the SAME final path, and
/// `promote_asr` does `remove_dir_all(dest)` then `rename`. So load B can delete the tree that load
/// A has just verified and is at that moment handing to sherpa-onnx. Landing in that remove→rename
/// gap means ORT opens a missing or partial `.onnx`, which it answers with a C++ exception across
/// the FFI boundary → std::terminate → an UNCATCHABLE SIGABRT (see model.rs's module docs). That is
/// precisely the crash `verify_for_load` exists to prevent, and a concurrent promote defeats it: the
/// hole is between that check and the open, so no amount of checking first can close it.
///
/// Hence the lock must span ensure + verify_for_load + the recognizer open (`ParakeetTdt::armed`,
/// whether it loads or is served from the decoder cache) — the whole verify-then-open sequence —
/// not just the download. Narrowing it to `ensure` reopens the crash.
///
/// Taken only inside `spawn_blocking` (never across an await) and never together with the session
/// lock, so it cannot deadlock against either. Poison-tolerant, like every other lock here: a
/// panicked load must not brick the mic for the rest of the process's life.
static MODEL_LOAD: Mutex<()> = Mutex::new(());

/// Forget the cached decoder, because a worker teardown had to DETACH may still be inside
/// `Decoder::transcribe` — which holds the recognizer mutex for the whole FFI decode, for as long
/// as it stays wedged. Reuse it and every later arm's decode worker blocks on that lock, its queue
/// fills, and the callback drops segments: dictation silently deaf for the life of the process.
/// That is strictly worse than the ONE reload this cache exists to avoid, so the next arm pays it.
/// Before the cache the detached thread held only its own per-arm recognizer, so the wedge cost
/// nothing but a parked thread; sharing the decoder is what turned it into a process-wide outage.
///
/// Contention on this lock is only possible against a COLD load — `cached_or_build` holds the slot
/// across `load_decoder` (the ONNX init, not the download); a warm hit holds it for one clone. The
/// detach path already spent `DECODE_JOIN_TIMEOUT` waiting, so that rare extra wait is in budget.
///
/// The slot itself lives in `transcribe`, beside the constructors, so `load_decoder` and
/// `with_decoder` can stay private and `ParakeetTdt::armed` can be the only reachable session
/// constructor — see its doc. This is the one thing outside that module allowed to clear it.
fn retire_cached_decoder() {
    crate::transcribe::retire_cached_decoder();
    #[cfg(test)]
    DECODERS_RETIRED.fetch_add(1, Ordering::Release);
}

/// Load the on-device model at STARTUP, in the background, so the first push-to-talk hold does not
/// have to pay for it.
///
/// ── THE MEASURED FAILURE THIS DELETES (the founder's "sometimes it doesn't send anything") ───────
/// The ONNX recognizer is loaded at most once per process, but it was loaded LAZILY — on the first
/// arm. So the first hold after every launch raced a model load, and on this machine that load is
/// not small: measured 2418 ms and 3536 ms on ordinary launches, and **46 258 ms at peak load**
/// (2026-08-09, load average 291). A push-to-talk hold is a few hundred ms. The hold therefore ends
/// long before the model exists, `start_after_load` correctly aborts the arm — logged as
/// `outcome="aborted-post-load"` — and the user gets NOTHING: no capture is ever built, so not one
/// sample of that utterance is recorded anywhere. It happened **20 times on 2026-08-09 alone**.
///
/// It is also why the relay banner was the only thing he saw: the socket opened in ~475 ms, found no
/// session to install against, and reported "connected too late… your words are still captured" —
/// while the words had in fact never been captured at all.
///
/// Starting the load at boot converts that into a load the user is never waiting on. It cannot make
/// dictation worse: `MODEL_LOAD` already serializes loads, so a hold that arrives mid-preload blocks
/// on the same mutex it would have taken anyway and then finds the model ready, and `model::ensure`
/// short-circuits on files already present. Failures are swallowed on purpose — this is a warm-up,
/// not a gate, and a first-run machine with no model yet must still reach the download path through
/// `start_dictation` where the progress events are wired to the UI.
///
/// Deliberately NOT gated on the mic being enabled: the cost is one background thread on a file that
/// is about to be needed, and gating it on `enabled` would leave exactly the cold-start case — the
/// one that fails — unwarmed.
pub fn preload_model_in_background(app: AppHandle) {
    std::thread::Builder::new()
        .name("dictation-model-preload".into())
        .spawn(move || {
            let Ok(root) = crate::dev_identity::app_data_dir(&app).map(|d| d.join("models")) else {
                return;
            };
            // Nothing to warm if the model has never been downloaded: `model::ensure` would fetch
            // 631 MB here, off the path that reports progress to the UI, so a first-run user would
            // see an idle app quietly saturating their network. That download belongs to the first
            // deliberate arm.
            if !root.exists() {
                tracing::info!(
                    target: "dictation",
                    "skipping model preload: no model on disk yet, so the first arm owns the download"
                );
                return;
            }
            let t = std::time::Instant::now();
            match load_model(&root, |_, _| {}) {
                Ok(_) => tracing::info!(
                    target: "dictation",
                    preload_ms = t.elapsed().as_millis() as u64,
                    "on-device model preloaded at startup; the first hold will not pay for it"
                ),
                // Best-effort by design — see the doc comment. `start_dictation` still owns the
                // real error path, with its progress + `dictation://error` wiring intact.
                Err(e) => tracing::info!(
                    target: "dictation",
                    error = %e,
                    preload_ms = t.elapsed().as_millis() as u64,
                    "model preload did not complete; the first arm will load it as before"
                ),
            }
        })
        .ok();
}

/// Serializes every test that can DETACH a decode worker.
///
/// `retire_cached_decoder` bumps the process-global `DECODERS_RETIRED`, and
/// `only_a_detaching_teardown_retires_the_cached_decoder` asserts a DELTA of exactly one across a
/// single teardown. cargo runs tests in parallel, so without this the other detaching teardowns land
/// inside that window and the delta reads 4 where the test expects 1 — observed exactly that, and it
/// would have been a red CI check rather than a local curiosity, since the failure needs parallelism.
///
/// Poison-tolerant like every other lock here: one failing test must not cascade into the rest.
#[cfg(test)]
static DETACH_TESTS: Mutex<()> = Mutex::new(());

/// Test-only observable. The slot holds an `Arc<Decoder>`, which cannot exist without the ~661 MB
/// model, so a test can never seed it and watch it clear — counting the retires is the only way to
/// drive the real `Drop` end to end and assert which branch of it fired.
#[cfg(test)]
static DECODERS_RETIRED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// The slow half of `start_dictation`, factored out so the serialization above is impossible to
/// apply to only part of it. Blocking and lock-holding — callers MUST run it off the main thread.
fn load_model(root: &std::path::Path, progress: impl Fn(u64, Option<u64>)) -> Result<ParakeetTdt, String> {
    let _serialized = MODEL_LOAD.lock().unwrap_or_else(|p| p.into_inner());
    // The loser of the race lands here once the winner has installed the model, so `ensure`
    // short-circuits on the now-present files instead of re-downloading 631MB.
    let paths = model::ensure(root, progress)?;
    // Prove the files are intact before sherpa-onnx opens them. A corrupt .onnx doesn't fail — it
    // aborts the process from C++, which no Rust error path can intercept. This turns that into an
    // `Err` we propagate to `dictation://error`, and purges the bad model so the next click
    // re-downloads it. Sound only because MODEL_LOAD means no other promote can run between this
    // check and the open below.
    model::verify_for_load(root, &paths)?;
    // The ONNX recognizer is loaded at most once per process; only the per-arm VAD/window are
    // rebuilt here. `armed` is the ONLY session constructor this module can reach — the uncached
    // ones are private to `transcribe` — so the per-arm reload that broke dictation is not something
    // this call site can drift back into. See `ParakeetTdt::armed`.
    ParakeetTdt::armed(&paths)
}


#[cfg(test)]
#[path = "dictation/tests.rs"]
mod tests;

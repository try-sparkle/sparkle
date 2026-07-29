//! Tauri commands wiring mic capture → transcriber → events.
//!
//! Two transcription engines sit behind this module:
//!   - **on-device** (Parakeet/Silero, `transcribe.rs`): always runs while the mic is hot. It
//!     powers the always-listening wake-word detection — the free, private "gate".
//!   - **cloud** (Deepgram Nova-3, `cloud.rs`): opened only once the user is actively dictating
//!     (the frontend wake-word machine hits ACTIVE and calls `start_cloud_stream`), and closed
//!     on stop. While it's open the capture callback routes frames to Deepgram instead of the
//!     on-device model, so the cloud only ever sees speech the user intended to dictate.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::audio::{assess_capture_health, rms_level, AudioHealth, Capture};
use crate::audio_devices::DeviceChoice;
use crate::cloud::{CloudAudioSender, DeepgramSession};
use crate::model;
use crate::transcribe::{Decoder, ParakeetTdt, Transcriber};

/// Monotonic id stamped on every emitted partial so the log can prove whether a
/// duplicate in the prompt bar came from the backend emitting the same text twice
/// (two ids, same fingerprint) vs the frontend appending one emission twice (one id).
static PARTIAL_SEQ: AtomicU64 = AtomicU64::new(0);

/// Fixed-width content fingerprint of a transcript segment. Identical text yields an
/// identical fingerprint, which is all the duplicate diagnosis needs — without ever
/// persisting the words themselves. (DefaultHasher is deterministic within a process,
/// so fingerprints are comparable across a single log.) This is best-effort
/// obfuscation, not cryptographic irreversibility: a 32-bit digest of a short phrase
/// is brute-forceable in principle, so we deliberately log neither the text nor its
/// length — only the fingerprint — to avoid handing a reversal oracle to anyone who
/// reads the on-disk log.
fn segment_fingerprint(seg: &str) -> u32 {
    let mut h = DefaultHasher::new();
    seg.hash(&mut h);
    h.finish() as u32
}

/// Emit one transcript segment and log it (source = "accept" during capture, or
/// "finalize" on stop) with its sequence id and a content fingerprint, so dictation
/// duplicates are diagnosable from the unified log. Privacy: the raw transcript text
/// (and its length, which would aid reversal) is NEVER written to the log — only the
/// fixed-width fingerprint — so a user's spoken words are not persisted to disk.
pub(crate) fn emit_partial(app: &AppHandle, source: &str, seg: String) {
    let seq = PARTIAL_SEQ.fetch_add(1, Ordering::Relaxed);
    // info (not debug): the shipped build's log threshold drops debug, and this is
    // low-frequency (once per spoken phrase), so info is safe and always visible.
    tracing::info!(
        target: "dictation",
        seq,
        source,
        fp = format_args!("{:08x}", segment_fingerprint(&seg)),
        "emit partial"
    );
    let _ = app.emit("dictation://partial", seg);
}

/// Emit a live, *volatile* interim transcript (the cloud path's word-by-word preview). Unlike a
/// committed partial this is replaced in place on the frontend and is NOT routed through the
/// wake-word machine. Privacy: interim text changes many times per second and is never logged —
/// we emit it to the webview and keep nothing.
pub(crate) fn emit_interim(app: &AppHandle, seg: String) {
    let _ = app.emit("dictation://interim", seg);
}

/// THE SPEAKER STOPPED — the auto-send rail's silence signal (PRD §4).
///
/// Deliberately NOT `dictation://speaking`. That event is the Silero VAD's edge on the ON-DEVICE
/// path, and on the cloud path it is hard-coded `true` for the whole stream (see the capture
/// callback below), so it can never fall — a rail keyed off it would arm and never count.
///
/// Nor is it inferable from `dictation://partial` going quiet: that measures how long the
/// TRANSCRIPT has been idle, which under network or model load starts ticking while the user is
/// still mid-sentence. This event carries Deepgram's own endpoint decision (`speech_final`, or the
/// standalone `UtteranceEnd` frame), taken from word timings in the audio.
///
/// Payload-free: the only thing it asserts is "as of now, speech has ended". The frontend already
/// holds the transcript, and it holds a fresher one than any payload here could carry.
///
/// Privacy: nothing is logged. This fires once per utterance and carries no text, but a per-
/// utterance timestamp trail is still a record of when someone was talking, and the transcript
/// emitters above deliberately keep only a fingerprint.
pub(crate) fn emit_speech_end(app: &AppHandle) {
    let _ = app.emit("dictation://speech-end", ());
}

/// Signal that the cloud (relay) worker has exited — whether a clean close, a mid-stream failure, or
/// the relay signalling out-of-credits. The frontend handles this by clearing the interim preview and
/// calling stop_cloud_stream, which flips `cloud_active` back to false so the capture callback resumes
/// routing frames to the on-device model. Without this, a mid-stream socket death would strand
/// dictation: frames keep going to the dead session, the on-device wake/stop-word path never resumes,
/// and the last interim stays painted as a stale ghost. `exhausted` is true when the relay tore the
/// stream down for out-of-credits, so the frontend can refresh the (now-depleted) balance pill.
pub(crate) fn emit_cloud_ended(app: &AppHandle, exhausted: bool) {
    let _ = app.emit("dictation://cloud-ended", exhausted);
}

/// The server-authoritative post-debit balance the relay reports after each metered minute.
/// `balance_cents` is None when the relay omits it (the frontend then optimistically decrements by
/// `debited_cents`); mirrors deepgramRelay.ts's `balance` control frame.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudBalance {
    balance_cents: Option<i64>,
    debited_cents: i64,
}

/// Forward a relay `balance` control frame to the frontend so the credits pill ticks down in real
/// time from the SERVER's authoritative post-debit balance (client-side metering is gone).
pub(crate) fn emit_cloud_balance(app: &AppHandle, balance_cents: Option<i64>, debited_cents: i64) {
    let _ = app.emit(
        "dictation://cloud-balance",
        CloudBalance { balance_cents, debited_cents },
    );
}

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

/// What to do with a relay socket whose blocking handshake was raced by a stop/restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RacedStream {
    /// Intent is still current — install it and start routing audio.
    InstallLive,
    /// A stop landed while we were connecting, but this session generation is still the live one
    /// and its slot is empty. PARK it in warm standby instead of throwing it away.
    ParkWarm,
    /// The session generation moved on (a stop_dictation + start_dictation swapped fresh Arcs), so
    /// this socket is an orphan against state nobody holds. It must be silenced and closed.
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
/// stop word landing mid-handshake — neither of which invalidates the SESSION, only the routing. If
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
    if same_generation && armed && slot_empty && !already_active {
        return RacedStream::ParkWarm;
    }
    RacedStream::Discard
}

/// What `cloud_reuse` was told about the socket sitting in the slot. NAMED fields, not a bool pair:
/// a caller that swapped `is_alive()` for `is_for_project()` in a tuple would compile and mis-bill
/// silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Installed {
    pub alive: bool,
    pub project_matches: bool,
}

/// The decision `cloud_reuse` returns: what `start_cloud_stream` should do with whatever socket is
/// currently installed.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CloudReuse {
    /// A live socket for THIS project is already routing — do nothing (idempotent: a repeated wake
    /// transition must not open a second socket).
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
fn segment_cloud_latch(touched: bool, cloud_now: bool, segment_closed: bool) -> (bool, bool) {
    let touched = touched || cloud_now;
    if segment_closed {
        // The next segment starts from wherever we are NOW, not from this segment's history.
        (cloud_now, touched)
    } else {
        (touched, false)
    }
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
const FOCUS_BLUR_COALESCE_MS: u64 = 120;

/// Bounded capacity of the decode queue between the realtime capture callback and the decode
/// worker. Each item is one closed VAD segment (≤ the VAD's 8 s max_speech_duration of 16 kHz
/// audio). The worker decodes far faster than segments close in ordinary speech, so this rarely
/// fills; if it does (a burst, or a slow machine), the callback DROPS the newest segment
/// (`try_send` → `Full`) rather than block the CoreAudio IOThread — bounded, lossy backpressure is
/// the safe tradeoff on the realtime thread. 32 segments is minutes of speech of headroom.
const DECODE_QUEUE_CAP: usize = 32;

/// Owns the on-device decode worker thread and the bounded channel it drains. The realtime capture
/// callback pushes closed-segment samples through the channel (non-blocking, drop-on-full); the
/// worker runs `Decoder::transcribe` on its OWN thread and emits the SAME `dictation://partial`
/// events (source `"accept"`) the old inline path emitted — moving the hundreds-of-ms decode OFF
/// `com.apple.audio.IOThread` so it can't overrun the capture ring buffer.
///
/// Lifetime is tied to the `Capture`: both are built together in `build_capture` and stored side by
/// side in the session. The channel's Sender lives only inside the capture callback, so once the
/// `Capture` is dropped (which disposes the cpal stream and frees the closure) the channel closes,
/// the worker drains any queued segments and exits, and dropping this joins it. Callers MUST drop
/// the `Capture` BEFORE dropping the `DecodeWorker` so the join is bounded.
struct DecodeWorker {
    handle: Option<std::thread::JoinHandle<()>>,
    /// Set true before a fast/abandon teardown (app exit): the worker then skips decoding any
    /// still-queued segments and just drains to the channel close, so the join is near-instant.
    abort: Arc<AtomicBool>,
}

impl DecodeWorker {
    /// Spawn the worker and return the (bounded) sender the capture callback pushes segments into.
    fn spawn(decoder: Arc<Decoder>, app: AppHandle) -> (SyncSender<Vec<f32>>, DecodeWorker) {
        let (tx, rx) = sync_channel::<Vec<f32>>(DECODE_QUEUE_CAP);
        let abort = Arc::new(AtomicBool::new(false));
        let abort_worker = abort.clone();
        let handle = std::thread::Builder::new()
            .name("parakeet-decode".into())
            .spawn(move || {
                // Blocks in `recv` until the capture callback's Sender is dropped (channel close),
                // at which point the `for` loop ends and the thread exits. Each segment is decoded
                // off the realtime thread and emitted exactly as the inline `accept` path did.
                for samples in rx {
                    if abort_worker.load(Ordering::Acquire) {
                        continue; // fast teardown: skip decode, just drain to the close
                    }
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
                    match decoded {
                        Ok(text) if !text.is_empty() => emit_partial(&app, "accept", text),
                        Ok(_) => {}
                        Err(_) => tracing::warn!(
                            target: "dictation",
                            "decode worker recovered from a panic; segment dropped"
                        ),
                    }
                }
            })
            .expect("spawn parakeet-decode worker");
        (tx, DecodeWorker { handle: Some(handle), abort })
    }

    /// Signal the worker to abandon any queued decodes and exit ASAP (app-exit fast teardown).
    fn abort(&self) {
        self.abort.store(true, Ordering::Release);
    }
}

impl Drop for DecodeWorker {
    fn drop(&mut self) {
        // Join so no decode/emit outlives teardown. Bounded: the channel is already closed by the
        // time we get here (the Capture — sole Sender holder — was dropped first), so the worker
        // only has to finish its current segment (or, if aborting, nothing) before `recv` ends.
        if let Some(h) = self.handle.take() {
            let _ = h.join();
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
    /// `armed && focused` — so we never capture audio while the user is looking at another app.
    focused: bool,
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
/// and parking on a stop-word stop are one rule, not two, so they can't drift.
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

/// Park a live cloud session in warm standby on window blur, mirroring a stop-word stop.
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

impl DictationState {
    /// Stop any in-flight capture by dropping the cpal stream, so CoreAudio stops invoking the
    /// audio callback. Called on app exit () to quiesce the audio IOThread BEFORE
    /// static destructors run — closing the shutdown-race window that produced the SIGABRT in
    /// . Unlike stop_dictation this skips finalize(): at exit the trailing segment is
    /// moot and we want the fastest possible teardown. Idempotent and poison-tolerant.
    pub fn stop_capture(&self) {
        let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
        // Fast teardown: tell the decode worker to abandon any queued segments, then drop the
        // Capture (closes the decode channel) and drop the worker (joins near-instantly since it's
        // aborting). Order matters — Capture holds the sole channel Sender, so it must drop first.
        if let Some(w) = sess.decode_worker.as_ref() {
            w.abort();
        }
        sess.capture = None;
        sess.decode_worker = None;
    }

    /// Build or release the cpal capture to match `armed && focused` (the only states that decide
    /// it). Caller MUST hold the session lock. Resuming reuses the already-resident transcriber and
    /// the same cloud Arcs (no model reload, same cloud generation), so a focus pause/resume cycle
    /// is cheap and doesn't disturb an in-flight cloud epoch. Pausing drops `Capture`, which stops
    /// CoreAudio invoking the callback and releases the OS mic (the macOS recording indicator goes
    /// off) — true "not capturing", not merely discarded frames.
    fn reconcile_locked(sess: &mut DictationSession, app: &AppHandle) {
        // Same decision as the worker-side reconcile — both derive it from `plan_capture` so the two
        // paths can't drift on when to build vs. tear down (sparkle-sfxu review). Safe to build/tear
        // down INLINE here because reconcile_locked runs only on the main thread (via set_focused),
        // where is_focused() is serviced inline and Capture::start doesn't self-block.
        match plan_capture(capture_should_be_live(sess.armed, sess.focused), sess.capture.is_some()) {
            CapturePlan::Idle => {}
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
            }
            CapturePlan::Teardown => {
            // Tell the worker to abandon its queued backlog BEFORE dropping it: this drop joins the
            // worker thread while the caller still holds the session lock, so without the abort the
            // join would block for the decode duration of up to DECODE_QUEUE_CAP queued segments,
            // stalling other session ops on window blur. A paused capture's trailing partials are
            // moot — same rationale as stop_capture (which also aborts first).
            if let Some(w) = sess.decode_worker.as_ref() {
                w.abort();
            }
            sess.capture = None; // drop -> stops the cpal stream, releases the OS mic, closes the decode channel
            sess.decode_worker = None; // worker joins near-instantly (aborting) instead of draining the backlog
            // Park the cloud socket too, so a quick refocus reuses it instead of re-handshaking.
            park_cloud_for_blur(&sess.cloud, &sess.cloud_active);
            tracing::info!(target: "dictation", "capture paused (window unfocused or muted)");
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
                drop(capture);
                drop(worker);
                tracing::info!(target: "dictation", "capture paused (window unfocused or muted)");
            }
            // Build OUTSIDE the lock (Capture::start's CoreAudio init blocks on the main thread), then
            // install under the lock only if the arm intent is still current.
            ReconcileStep::Build { transcriber, cloud_active, cloud_tx } => {
                match build_capture(app.clone(), transcriber.clone(), cloud_active, cloud_tx) {
                    Ok((capture, worker)) => self.install_capture(app, &transcriber, capture, worker),
                    Err(e) => {
                        // The build FAILED — clear the in-flight marker so the watchdog stops
                        // treating this as a build still running and can escalate/retry.
                        self.0.lock().unwrap_or_else(|p| p.into_inner()).build_started_at = None;
                        let _ = app.emit("dictation://error", e);
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
        match plan_capture(capture_should_be_live(sess.armed, sess.focused), sess.capture.is_some()) {
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
        let discard = {
            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            sess.build_started_at = None;
            let still_current = capture_should_be_live(sess.armed, sess.focused)
                && sess.capture.is_none()
                && sess.transcriber.as_ref().map(|t| Arc::ptr_eq(t, built_for)).unwrap_or(false);
            if still_current {
                sess.capture = Some(capture);
                sess.decode_worker = Some(worker);
                // Fresh capture → fresh liveness verdict. Carrying the latches over would let a
                // rebuild inherit "already reported", silently suppressing the notice for a mic
                // that is still dead.
                retract = sess.audio_reported;
                sess.clear_audio_fault();
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
        if let Some((capture, worker)) = discard {
            tracing::info!(target: "dictation", "discarding a capture built during a stop/blur race");
            drop(capture);
            drop(worker);
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
    /// meter, reset the wake-phase, and update the listening UI. Moving focus between two Sparkle
    /// windows keeps `focused` true, so no event fires and the mic stays live.
    pub fn set_focused(&self, app: &AppHandle, focused: bool) {
        let changed = {
            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if sess.focused == focused {
                false
            } else {
                sess.focused = focused;
                Self::reconcile_locked(&mut sess, app);
                true
            }
        }; // release the lock before emitting
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
/// frames while actively dictating, else the on-device wake-word model — lives in exactly one place.
///
/// Returns `(Capture, DecodeWorker)`: the caller stores BOTH in the session and, on teardown, drops
/// the Capture first (closing the decode channel) then the DecodeWorker (a bounded join). The audio
/// callback now does ONLY cheap, bounded work — level meter, VAD windowing, and non-blocking channel
/// pushes — so it never overruns the CoreAudio capture ring buffer with a synchronous decode.
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
    let capture = Capture::start(&current_device_choice(), move |frame: Vec<f32>| {
        let now = std::time::Instant::now();
        if now.duration_since(last_level_emit) >= LEVEL_EMIT_INTERVAL {
            last_level_emit = now;
            let _ = app_cb.emit("dictation://level", rms_level(&frame));
        }
        // While the cloud stream is open (user actively dictating), route frames to Deepgram and
        // skip the on-device model entirely. Otherwise the on-device model handles the frame —
        // this is the always-listening wake-word gate. Locks are poison-tolerant ():
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
                for samples in segs {
                    // Non-blocking, drop-on-full: the audio thread must never block. A full queue
                    // (worker fell behind) drops the newest segment; a disconnected channel (worker
                    // gone during teardown) is a silent no-op.
                    match decode_tx.try_send(samples) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) => tracing::warn!(
                            target: "dictation",
                            "decode queue full; dropping a segment (decoder fell behind)"
                        ),
                        Err(TrySendError::Disconnected(_)) => {}
                    }
                }
            }
            spk
        };
        if cloud {
            // Route to the relay WITHOUT locking the `cloud` teardown mutex. `try_lock` on the
            // dedicated sender slot NEVER blocks the audio thread: if a start/stop is mid-swap we
            // simply drop this frame (the same tens-of-ms transition window that already drops
            // frames), rather than contend with start/stop_cloud_stream/stop_dictation.
            if let Ok(guard) = cloud_tx.try_lock() {
                if let Some(s) = guard.as_ref() {
                    s.send_audio(&frame);
                }
            }
        };
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

// ── Audio liveness watchdog ────────────────────────────────────────────────────────────────────
//
// The 2026-07-29 incident in one line: capture ran for NINE MINUTES receiving nothing while the UI
// showed an idle waveform, and the user sat there talking to it. Nothing in the app was watching
// whether audio actually arrived — only whether the stream had been *created*. This is that watch.

/// How often to check that audio is still arriving. Cheap (two atomic loads under a short lock),
/// so the interval is set by how long a user should ever spend talking to a dead mic, not by cost.
const WATCHDOG_POLL: std::time::Duration = std::time::Duration::from_millis(1000);

/// How long a freshly built capture gets before its silence counts as a fault. Long enough to
/// cover CoreAudio's first-buffer latency and a device reconfiguration, short enough that the user
/// finds out inside one sentence rather than nine minutes.
const WATCHDOG_GRACE: std::time::Duration = std::time::Duration::from_secs(4);

/// How many consecutive ticks the mic may be armed-but-uncaptured before that counts as a fault.
/// `reconcile_capture` builds outside the session lock, so a tick can legitimately land in that
/// window; three seconds is far longer than a rebuild and far shorter than a user's patience.
const MISSING_CAPTURE_TICKS: u8 = 3;

/// Advance the missing-capture debounce for one tick.
///
/// Returns `(new_tick_count, is_a_fault)`. Pure, so the whole increment/reset matrix is covered by
/// a test — the sampling around it needs a live `AppHandle` and a real audio device, and an earlier
/// version tested only the threshold constant while leaving the logic that actually changed
/// uncovered (roborev 55286).
///
/// `building` is the load-bearing input. `MISSING_CAPTURE_TICKS` alone is a wall-clock guess, and
/// `Capture::start`'s CoreAudio init blocks on the main thread — a thread this file documents as
/// being blocked for seconds elsewhere. Without it, a build that merely takes longer than the
/// threshold is indistinguishable from one that failed, and the user gets a false "couldn't open a
/// microphone". Note it is a BOUNDED belief, computed by [`build_suppresses_watch`] — see there for
/// why an unbounded one silences the watchdog for the rest of the session.
fn missing_tick(has_capture: bool, should_be_live: bool, building: bool, ticks: u8) -> (u8, bool) {
    if has_capture || !should_be_live || building {
        return (0, false);
    }
    let ticks = ticks.saturating_add(1);
    (ticks, ticks >= MISSING_CAPTURE_TICKS)
}

/// How long a running `build_capture` may suppress the missing-capture watch. Far above a normal
/// build (CoreAudio init is milliseconds, and even a badly contended main thread is ~seconds) and
/// far below the user's patience.
const BUILD_STALL_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

/// Whether a build that started `since` ago should still be believed to be making progress.
///
/// The bound is the point. `build_started_at` is cleared by `install_capture` and by the build's
/// error arm — neither of which a HUNG build ever reaches. Treating "a build is running" as
/// permanently true therefore turned the watchdog off for the rest of the session on an armed
/// session with no capture: exactly the nine-minute silent failure this watchdog exists to end,
/// re-entered through the fix for its false positive (roborev 55300). Past the grace we stop
/// believing the marker and let the tick escalation through.
fn build_suppresses_watch(since: Option<std::time::Duration>) -> bool {
    matches!(since, Some(elapsed) if elapsed < BUILD_STALL_GRACE)
}

/// What the watchdog should do about the current reading.
///
/// Pure (see [`fault_action`]) so the escalation order is unit-tested: we always try to RECOVER
/// before we complain, and we complain exactly once per capture rather than every poll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FaultAction {
    /// Nothing to do.
    Idle,
    /// Rebuild the capture — re-enumerates devices and re-binds. Fixes the ordinary case
    /// (a device changed under us) without the user ever seeing an error.
    Reacquire,
    /// Re-acquiring did not help. Tell the user, naming the device.
    Report,
    /// Audio came back after we had reported a fault — retract the notice.
    Recovered,
}

/// Escalation policy for a liveness reading.
///
/// `reacquired` / `reported` are per-capture latches: they reset when a new capture is installed,
/// so each rebuild gets one silent recovery attempt and at most one user-visible message. Without
/// the latches a dead mic would either re-acquire in a tight loop or emit an error every second.
///
/// `muted` is the device's own `kAudioDevicePropertyMute` reading, and it short-circuits the
/// recovery attempt: rebuilding a stream cannot unmute hardware, so re-acquiring a muted device is
/// pure churn that delays telling the user the one thing they need to hear.
fn fault_action(
    health: AudioHealth,
    muted: bool,
    reacquired: bool,
    reported: bool,
) -> FaultAction {
    match health {
        // Too early to judge — a just-built stream has not necessarily delivered a buffer yet.
        AudioHealth::Warming => FaultAction::Idle,
        // Audio is flowing. Retract a previous complaint, but only if we actually made one.
        AudioHealth::Live => {
            if reported {
                FaultAction::Recovered
            } else {
                FaultAction::Idle
            }
        }
        // No frames at all, or frames that are all digital silence. Both mean "not hearing you";
        // both are worth one automatic recovery attempt before bothering the user — UNLESS the
        // device says it is muted, in which case there is nothing to recover and the honest thing
        // is to say so straight away.
        AudioHealth::NoFrames | AudioHealth::Silent => {
            if reported {
                FaultAction::Idle
            } else if muted || reacquired {
                FaultAction::Report
            } else {
                FaultAction::Reacquire
            }
        }
    }
}

/// What we tell the user when the re-acquire could not rebuild a capture AT ALL, so there is no
/// device to name. A constant rather than an inline literal so the test that audits the remedy is
/// asserting the exact bytes the Report arm emits (roborev 55360).
///
/// Same remedy rule as [`no_audio_message`]: it must name a control that exists AND works. This arm
/// was missed on the first audit pass and still said "check System Settings → Sound → Input", which
/// cannot rebind Sparkle — capture no longer follows the system default. It is also the one message
/// here that matches no bucket in `dictationCopy`, so it reaches the user verbatim.
const NO_CAPTURE_MESSAGE: &str =
    "Sparkle couldn't open a microphone. Connect one, then pick it in Sparkle's mic menu \
     (hover the mic).";

/// The user-facing message for a capture that is not hearing anything.
///
/// Naming the device is the whole point: "no audio" sends someone hunting through System Settings,
/// while "no audio from ZoomAudioDevice" tells them instantly that capture landed on a virtual
/// device and roughly which app put it there. The remedy differs for the two cases, so the copy
/// does too — a virtual device is a WRONG-DEVICE problem, a physical one is a taken-over-mic
/// problem, and telling someone to pick a different input when they are already on their built-in
/// mic would be useless advice.
fn no_audio_message(device: &crate::audio::BoundDevice, muted: bool) -> String {
    // AGENTS.md: "a remedy message is an instruction the user will follow", so it must name an
    // action that EXISTS — and one that WORKS. An earlier draft said "pick your microphone in the
    // mic menu" while that menu was still a three-option mode pill with no device list (roborev
    // 55277), so it was swung to System Settings → Sound → Input, true on every macOS install.
    //
    // The mic menu now carries a real device picker (`AudioInputPicker`), which changes the answer
    // BACK for the wrong-device case — and not merely as a convenience. This branch deliberately
    // stopped following `kAudioHardwarePropertyDefaultInputDevice`: automatic selection prefers a
    // physical input over the default, and a pinned UID ignores the default outright. So "change
    // your input in System Settings" is now advice that can leave capture on exactly the device the
    // user was just told about — a remedy that does nothing is worse than none. Sparkle's own
    // picker is the control that actually rebinds (`set_audio_input` re-acquires immediately).
    //
    // System Settings stays for MUTE, where it is still the truth: no in-app picker can unmute
    // hardware.
    if muted {
        // The device told us it is muted. Accusing it of being broken — or telling the user to go
        // pick a different microphone — would send them chasing a fault that does not exist.
        return format!(
            "\"{}\" is muted. Unmute it (check the hardware mute switch, or System Settings → \
             Sound → Input) to start dictating.",
            device.name
        );
    }
    if device.is_virtual {
        format!(
            "No audio from \"{}\". That is a virtual audio device, not a microphone — pick your \
             microphone in Sparkle's mic menu (hover the mic) to rebind capture.",
            device.name
        )
    } else {
        format!(
            "No audio from \"{}\". Another app (a screen recorder or virtual audio device) may be \
             holding the microphone. Turn the mic off and on, or pick a different input in \
             Sparkle's mic menu (hover the mic).",
            device.name
        )
    }
}

impl DictationSession {
    /// Clear every per-capture audio-fault latch.
    ///
    /// BOTH latches, not just the report one (roborev 55277). Leaving `audio_reacquired` set would
    /// make the NEXT fault on this capture skip straight to complaining — inverting "recover before
    /// you complain" exactly in the flapping-device case (USB unplug/replug, plug-in load/unload)
    /// where a rebind is the thing that fixes it.
    fn clear_audio_fault(&mut self) {
        self.audio_reported = false;
        self.audio_reacquired = false;
        self.audio_missing_ticks = 0;
    }
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
    fn watchdog_tick(&self, app: &AppHandle) -> FaultAction {
        // Set when this tick should attempt another BUILD, independently of whether it also has
        // something to say to the user. The two must be separate: `fault_action` short-circuits on
        // `reported`, so routing the retry through it meant that after the single report the
        // session stopped trying — a microphone plugged back in recovered only if the device LIST
        // happened to change, and a build that failed for any other reason (transient CoreAudio
        // error, a wedged main thread) left the session silent forever. Report once, keep retrying
        // (roborev 55300).
        let mut retry_build = false;
        // Sample under the lock, then RELEASE before doing anything that emits or touches audio.
        let sampled = {
            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            let should_be_live = capture_should_be_live(sess.armed, sess.focused);
            match sess.capture.as_ref() {
                Some(c) => {
                    let health = assess_capture_health(
                        c.uptime(),
                        c.health().frames(),
                        c.health().voiced_frames(),
                        WATCHDOG_GRACE,
                    );
                    let device = c.device().clone();
                    // Ends the borrow of `sess.capture` before the counter reset below.
                    sess.audio_missing_ticks = 0;
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

        let action = fault_action(health, muted, reacquired, reported);
        match action {
            FaultAction::Idle => {}
            FaultAction::Reacquire => {
                tracing::warn!(
                    target: "dictation",
                    device = device.as_ref().map(|d| d.name.as_str()).unwrap_or("<none>"), ?health,
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
                tracing::error!(
                    target: "dictation",
                    device = device.as_ref().map(|d| d.name.as_str()).unwrap_or("<none>"),
                    uid = device.as_ref().and_then(|d| d.uid.as_deref()).unwrap_or("<none>"),
                    is_virtual = device.as_ref().map(|d| d.is_virtual).unwrap_or(false),
                    muted, ?health,
                    "no audio from the bound input device; telling the user"
                );
                self.0.lock().unwrap_or_else(|p| p.into_inner()).audio_reported = true;
                let message = match &device {
                    Some(d) => no_audio_message(d, muted),
                    // The re-acquire could not rebuild a capture at all, so there is no device to
                    // name. Say exactly that rather than inventing one.
                    //
                    // Same remedy rule as `no_audio_message`, and this arm was missed on the first
                    // pass (roborev 55360): it said "check System Settings → Sound → Input", which
                    // provably cannot rebind Sparkle — this branch stopped following the system
                    // default. Worse, the string matches no frontend bucket in `dictationCopy`, so
                    // it falls to `unknown` and is rendered to the user VERBATIM.
                    None => NO_CAPTURE_MESSAGE.to_string(),
                };
                let _ = app.emit("dictation://error", message);
            }
            FaultAction::Recovered => {
                tracing::info!(
                    target: "dictation",
                    device = device.as_ref().map(|d| d.name.as_str()).unwrap_or("<none>"),
                    "audio is arriving again"
                );
                self.0.lock().unwrap_or_else(|p| p.into_inner()).clear_audio_fault();
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
                    let should_be_live = capture_should_be_live(sess.armed, sess.focused);
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
/// Hence the lock must span ensure + verify_for_load + `ParakeetTdt::new` — the whole
/// verify-then-open sequence — not just the download. Narrowing it to `ensure` reopens the crash.
///
/// Taken only inside `spawn_blocking` (never across an await) and never together with the session
/// lock, so it cannot deadlock against either. Poison-tolerant, like every other lock here: a
/// panicked load must not brick the mic for the rest of the process's life.
static MODEL_LOAD: Mutex<()> = Mutex::new(());

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
    ParakeetTdt::new(&paths)
}

/// Arm the mic, downloading + loading the on-device model first if this is a fresh install.
///
/// MUST stay `async fn`. A plain `#[tauri::command]` on a sync fn is `ExecutionContext::Blocking`
/// in tauri-macros, which runs the body INLINE on the IPC thread — the main/event-loop thread. This
/// body can take MINUTES on first run (631MB download + bzip2 + untar + a sherpa-onnx model load),
/// and while it ran there, the menu bar, tray icon, window drag/resize, and every `invoke()` from
/// every window stalled for the whole download: the first mic click beachballed the app, which
/// users read as a crash and force-quit — never seeing that it was downloading. `async fn` forces
/// `ExecutionContext::Async` (the body is spawned on the async runtime), and `spawn_blocking` then
/// keeps the blocking work off the runtime's small worker pool too, so it can't starve other
/// commands either. Same shape as `preflight::claude_preflight` — for work that is millions of
/// times shorter than this.
#[tauri::command]
pub async fn start_dictation(app: AppHandle, state: State<'_, DictationState>) -> Result<(), String> {
    // "Arm" the mic. The cpal capture itself is gated on focus by reconcile_locked: it comes up now
    // only if a Sparkle window is the active OS window, and is (re)built later by the focus event.
    //
    // Fast path: already armed (e.g. a second window mounting, or a re-arm after this window was the
    // first). Don't reload the model or swap the cloud Arcs — just refresh focus and reconcile so a
    // capture paused while unfocused resumes. This also preserves the old double-start guarantee:
    // we never drop a live transcriber without finalize(). Lock-only and await-free, so it stays as
    // cheap as it was when this command ran inline.
    //
    // While here (and still holding the lock), sample the stop epoch so we can detect a
    // stop_dictation that lands during the slow model load below (the "resurrect" race).
    //
    // The guard is scoped to this block so the lock is released before the `.await`: the session
    // Mutex is a std::sync::Mutex, and holding one across an await would both make this future
    // !Send (it wouldn't compile as a command) and risk deadlocking the runtime.
    let stop_epoch_at_start = {
        let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        match begin_start_decision(sess.armed, sess.stop_epoch, sess.start_in_flight) {
            BeginStart::FastPathArmed => {
                // Fast path (a second window mounting, or a re-arm): resume capture to match focus.
                // Reconcile OFF the lock — is_focused()/Capture::start block on the main thread, and
                // holding the session lock across them from this worker is the sparkle-sfxu deadlock.
                drop(sess);
                state.reconcile_capture(&app);
                return Ok(());
            }
            BeginStart::CoalesceWithInFlight => {
                // Another window already has a load running for this exact intent. Its arm is
                // app-global, so it covers us too — returning here is what stops one toggle from
                // queuing a model load per open window (the 2026-07-26 lockout).
                tracing::info!(
                    target: "dictation",
                    "start_dictation coalesced onto the in-flight load (same intent, another window)"
                );
                return Ok(());
            }
            BeginStart::Load(epoch) => {
                // Claim the load so the duplicates that follow us coalesce rather than queue.
                sess.start_in_flight = Some(epoch);
                epoch
            }
        }
    };

    // Release the in-flight claim on EVERY exit path below (abort, error, or arm) — a claim left
    // behind would make every later start coalesce onto a load that is no longer running, leaving the
    // mic permanently unarmable. Only clear it if it is still ours: a newer intent may have replaced
    // it while we loaded, and stealing that claim would let duplicates queue loads again.
    struct InFlightClaim<'a>(&'a DictationState, u64);
    impl Drop for InFlightClaim<'_> {
        fn drop(&mut self) {
            let mut sess = self.0 .0.lock().unwrap_or_else(|p| p.into_inner());
            if sess.start_in_flight == Some(self.1) {
                sess.start_in_flight = None;
            }
        }
    }
    let _claim = InFlightClaim(&state, stop_epoch_at_start);

    // Ask macOS for the mic BEFORE the model download, not after.
    //
    // Two reasons, and the ordering is the whole point:
    //
    //  1. It is the only thing that catches a DENIED user at all. cpal/CoreAudio do not fail for
    //     them — `Capture::start` returns Ok and then delivers buffers of zeros forever, so the mic
    //     ring goes amber, the composer says "Say Hey Sparkle", and the app waits for a wake word it
    //     can never hear, with no error anywhere. See mic_permission.rs's module docs.
    //
    //  2. The OS prompt is triggered by the FIRST mic access, which — before this — was
    //     `stream.play()` at the very end of `reconcile_locked`, i.e. AFTER the multi-minute
    //     first-run model download. So a new user clicked the mic, watched "Setting up voice" for
    //     several minutes, and only then got a permission dialog, quite possibly behind another
    //     window, about a click they'd long since moved on from. Prompting here asks while the
    //     click is still the thing they just did — and it also means we don't spend minutes (and
    //     482MB of someone's bandwidth) fetching a model for a user who is about to say No.
    //
    // `spawn_blocking` for the same reason the model load below uses it, and it is load-bearing
    // here specifically: this call blocks for as long as the user takes to read the dialog, and the
    // dialog is drawn by the main run loop. Blocking the main thread would deadlock against the
    // very prompt we're waiting on. Its own spawn_blocking rather than folding into the load below,
    // because that one holds MODEL_LOAD — we must not hold a process-wide lock across a dialog
    // that is waiting on a human.
    //
    // The Authorized path (every existing user, the founder included) is one cached, process-local
    // status read and then straight through: no prompt, no state change, no measurable latency.
    tauri::async_runtime::spawn_blocking(crate::mic_permission::ensure_access_blocking)
        .await
        .map_err(|e| format!("microphone permission check failed: {e}"))??;

    // Early-out: re-check the epoch BEFORE committing to the load. The permission check above is
    // itself an await, and on a busy machine `spawn_blocking` can sit queued behind other work for a
    // long time, so a mute can easily land before we have loaded anything. The post-load check would
    // catch it too — but only after this start has occupied a model-load slot it was always going to
    // throw away. On 2026-07-26 that wasted slot was the difference between a 3.5-minute mic outage
    // and none: a backlog of already-doomed starts drained one at a time while the user's genuine
    // re-arm waited behind them.
    {
        let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if sess.stop_epoch != stop_epoch_at_start {
            tracing::info!(
                target: "dictation",
                "start_dictation aborted before the model load (a stop landed first; mic stays muted)"
            );
            // TWO THINGS BEFORE YOU ADD ANYTHING HERE:
            //  1. `sess` is still held to end of scope. Anything that emits to the webview must
            //     `drop(sess)` FIRST — `app.emit` fans out to every window and this file has a
            //     documented main-thread deadlock history (sparkle-sfxu).
            //  2. This path leaves the UI asserting something false: the `[enabled]` effect sets
            //     `status = "listening"` optimistically before invoking, and nothing here retracts
            //     it, so the ring keeps claiming to listen until that effect's else-branch settles it
            //     on the next mute. A `dictation://not-armed` event was tried and removed — a
            //     broadcast can't be matched to per-window intent without an identity. Doing it
            //     properly needs a monotonic start id passed to this command and echoed back; see
            //     PRD/sparkle/mic-multi-window-start-stop-race.md.
            return Ok(());
        }
    }

    // Not yet armed: load the on-device model (slow, no lock held) before claiming the session.
    //
    // NOTE: this await is what makes the "resurrect" race REAL rather than theoretical. While this
    // command ran on the main thread, a stop_dictation could not land mid-load — it was queued
    // behind us on that same thread — so the epoch guard below was unreachable defence. Now that the
    // load is off-thread the event loop is live throughout, so stop_dictation (and a second
    // start_dictation) genuinely can interleave here. `start_after_load` is the guard that makes
    // that safe, and it is now load-bearing.
    let root = crate::dev_identity::app_data_dir(&app)?.join("models");
    let app_for_progress = app.clone();
    let transcriber = tauri::async_runtime::spawn_blocking(move || {
        load_model(&root, move |done, total| {
            let _ = app_for_progress.emit("dictation://model-progress", (done, total));
        })
    })
    .await
    // JoinError: the blocking task panicked. The panic hook already logged it; surface it as an
    // ordinary Err so the mic click reports a failure instead of silently doing nothing.
    .map_err(|e| format!("voice model load task failed: {e}"))??;
    let transcriber = Arc::new(Mutex::new(transcriber));

    let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
    // Re-check under the lock now the (slow) load is done. Both inputs are read from THIS critical
    // section so the decision and the arm-or-abort are atomic (see `start_after_load`).
    match start_after_load(stop_epoch_at_start, sess.stop_epoch, sess.armed) {
        StartAfterLoad::AbortMutedDuringLoad => {
            // The user muted mid-download: a stop advanced the epoch after we sampled it. Do NOT
            // re-arm (that's the resurrect race) — our freshly loaded transcriber drops here.
            tracing::info!(target: "dictation", "start_dictation aborted: a stop landed during model load (mic stays muted)");
            // Same two caveats as the pre-load abort above: `sess` is still held (drop it before any
            // webview emit — sparkle-sfxu), and this leaves the ring optimistically claiming to
            // listen until the `[enabled]` effect settles it.
            return Ok(());
        }
        StartAfterLoad::AlreadyArmed => {
            // A racing start_dictation armed while we loaded. Discard our transcriber and just
            // reconcile rather than overwriting the live one without finalize(). Reconcile OFF the
            // lock (drop the guard first) — the sparkle-sfxu deadlock rule.
            drop(sess);
            state.reconcile_capture(&app);
            return Ok(());
        }
        StartAfterLoad::Arm => {}
    }
    sess.transcriber = Some(transcriber);
    // Fresh cloud generation for this arm — new Arcs so start_cloud_stream's ptr_eq/epoch guards
    // correctly invalidate any stream that raced a prior stop+start.
    sess.cloud = Arc::new(Mutex::new(None));
    sess.cloud_active = Arc::new(AtomicBool::new(false));
    sess.cloud_epoch = Arc::new(AtomicU64::new(0));
    // Fresh sender slot too — it mirrors `cloud`, so it must be reset with the generation (a stale
    // sender from a prior arm must never survive into a new one).
    sess.cloud_tx = Arc::new(Mutex::new(None));
    sess.armed = true;
    // Release the session lock BEFORE reconcile_capture: it samples focus (is_focused) and builds
    // the capture (Capture::start), both of which block on the main thread. Holding the lock across
    // them from this async-runtime worker — while the main thread waits on the SAME lock in the
    // Focused handler — was the sparkle-sfxu launch deadlock. reconcile_capture also re-validates the
    // arm intent under the lock before installing, so a stop/blur landing in this gap is handled.
    drop(sess);
    // Builds the capture now iff a window is focused; otherwise the focus event brings it up later.
    state.reconcile_capture(&app);
    Ok(())
}

/// Open the cloud (relay) stream for the active-dictation window. The frontend calls this only when
/// the wake-word machine transitions to ACTIVE *and* it has already gated on the live "voice
/// dictation" + composer settings — so this command's job is just "open if signed in". (The
/// voice-setting gate lives entirely in the frontend, the single source of truth; no `cloud` arg.)
///
/// Returns TRUE only when a live relay socket was actually installed. Returns FALSE on every
/// stay-on-device path (signed out, handshake failure — which includes the relay refusing an
/// unentitled / can't-afford-a-minute user — or a stop/restart race discard) so the frontend knows to
/// stay on the on-device model. Metering is server-side now, so a FALSE simply means "no cloud".
/// MUST stay `async fn` (see the `spawn_blocking` on the handshake below). A plain sync
/// `#[tauri::command]` is `ExecutionContext::Blocking`, which runs the body INLINE on the
/// IPC/event-loop (macOS main) thread — where the ~hundreds-of-ms-to-8s TLS+WS handshake froze the
/// webview and showed up as multi-second "jank stall"s on a slow/black-holed network. `async fn`
/// forces `ExecutionContext::Async` (body on the async runtime), and `spawn_blocking` keeps the
/// blocking handshake off the runtime's small worker pool too. Same shape as `start_dictation`.
#[tauri::command]
pub async fn start_cloud_stream(
    app: AppHandle,
    state: State<'_, DictationState>,
    // Display name of the project the user is dictating into, so the per-minute deepgram debits are
    // attributable in the Credits history. Metering-only; None when the caller doesn't know.
    project: Option<String>,
) -> Result<bool, ()> {
    // Capture, under one lock, the state we need to (a) decide whether to open a stream and
    // (b) safely install it after the blocking handshake. The Arcs are captured by IDENTITY so we
    // can later confirm (via ptr_eq) the session generation didn't change.
    let (cloud_slot, cloud_active, cloud_epoch, cloud_tx, stale_socket) = {
        let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        // Warm reuse: a socket paused into standby by a recent stop-word stop is still open. If its
        // worker is alive AND it belongs to the project we're dictating into, resume on it — no
        // TLS+WS handshake, so dictation starts instantly. Done entirely under the lock (resume() is
        // just a non-blocking channel send). A lost liveness race is safe: resuming a just-dead
        // worker drops frames and its cloud-ended emit drives the frontend back to on-device — the
        // same recovery as any mid-stream death.
        //
        // The project check is a BILLING correctness guard, not an optimization: the relay captures
        // the project once at handshake and stamps it on every per-minute debit for the life of the
        // connection. Reusing a socket opened for project A while dictating into project B billed
        // B's minutes to A — attribution the user can't trust, and worse than no attribution because
        // the history row looks authoritative. On a mismatch we drop the warm socket and reopen,
        // paying one handshake to keep the ledger honest. (roborev 48164)
        //
        // The reopen is not free: every relay connection debits a first minute up front
        // (firstMinuteCents), so switching project between two utterances inside the warm window
        // costs ~6¢ extra — as does dictating from a view with NO project selected right after an
        // attributed session, since the match is strict about None in both directions. That trade is
        // deliberate: this feature's rule is that a wrong attribution is worse than none, and here a
        // wrong attribution is also a wrong CHARGE. Loosening it (letting an unattributed request
        // ride an attributed socket) would bill the old project for minutes spent elsewhere.
        let stale = {
            let mut cloud = sess.cloud.lock().unwrap_or_else(|p| p.into_inner());
            // Take the installed socket OUT of the slot for teardown: stop routing at it, drop the
            // audio sender pointing at it, and silence it while STILL under the lock. The silencing
            // can't wait for the spawned teardown task — silencing there only lands once it runs,
            // and a worker exiting in the gap emits cloud-ended, which drives the frontend to
            // stop_cloud_stream against the session we are about to install. (roborev 50498/52646)
            let take_for_teardown = |cloud: &mut Option<DeepgramSession>| {
                sess.cloud_active.store(false, Ordering::Relaxed);
                *sess.cloud_tx.lock().unwrap_or_else(|p| p.into_inner()) = None;
                // silence_now() consumes the session and hands back a SilencedSession, whose only
                // operation is the blocking close. That keeps the silencing VISIBLE here rather than
                // hidden inside a teardown method — but it does not forbid getting the order wrong,
                // so the ordering rule stated in the block above this closure stays comment-enforced,
                // not type-enforced.
                cloud.take().map(DeepgramSession::silence_now)
            };
            let installed = cloud.as_ref().map(|s| Installed {
                alive: s.is_alive(),
                project_matches: s.is_for_project(project.as_deref()),
            });
            match cloud_reuse(sess.cloud_active.load(Ordering::Relaxed), installed) {
                CloudReuse::AlreadyRouting => return Ok(false),
                CloudReuse::Resume => match cloud.as_ref() {
                    Some(s) => {
                        s.resume();
                        sess.cloud_active.store(true, Ordering::Relaxed);
                        tracing::info!(target: "dictation", "reusing warm deepgram socket");
                        return Ok(true); // caller starts metering, exactly as for a fresh open
                    }
                    // Unreachable by construction (Resume implies an installed session), but stated
                    // rather than assumed: flipping cloud_active with an EMPTY slot would tell the
                    // frontend cloud is live while the callback finds no sender — audio dropped
                    // instead of transcribed, with no cloud-ended to recover it. (roborev 52647)
                    None => return Ok(false),
                },
                CloudReuse::Reopen => {
                    tracing::info!(
                        target: "dictation",
                        "deepgram socket belongs to another project; reopening so the minutes bill correctly"
                    );
                    // `cloud_active` may be TRUE here: the focus-regain unpark resumes a parked socket
                    // without knowing the project, so this is also where that resume gets corrected
                    // (roborev 48157/50498).
                    take_for_teardown(&mut cloud)
                }
                // A DEAD socket still in the slot gets the same treatment. run_session clears `alive`
                // BEFORE it emits cloud-ended, so one sampled dead here can still fire that event a
                // moment later — the same tear-down-the-successor hazard, just a narrower window.
                // Leaving it to be overwritten by the install would also drop it without a join.
                // (Only reachable with cloud_active already false — a dead socket under an `active`
                // flag returns AlreadyRouting — so the closure's cloud_active clear is a no-op here.
                // Its cloud_tx clear is NOT: warm standby deliberately leaves the sender installed
                // alongside the parked session, so a parked-then-died socket arrives here with
                // cloud_tx still pointing at it, and clearing keeps cloud_tx a faithful mirror of
                // cloud.) (roborev 53047)
                CloudReuse::Open if cloud.is_some() => take_for_teardown(&mut cloud),
                CloudReuse::Open => None,
            }
        };
        (
            sess.cloud.clone(),
            sess.cloud_active.clone(),
            sess.cloud_epoch.clone(),
            sess.cloud_tx.clone(),
            stale,
        )
    };
    // Close the project-mismatched socket off-thread: teardown is bounded (~2 s) but still blocking.
    // Already SILENCED (silence_now(), under the lock above) — that is what makes this safe, not
    // finish() itself: this teardown runs CONCURRENTLY with the successor session's handshake, and
    // finish() suppresses only the cloud-ended emit — the post-CloseStream drain would keep
    // forwarding transcripts, so a trailing final from the old project's socket could land in
    // the new session's composer (or end it, if it carried the stop word). Fire-and-forget — nothing
    // below depends on it.
    if let Some(stale) = stale_socket {
        tauri::async_runtime::spawn_blocking(move || stale.finish());
    }
    // Cloud dictation now runs through the orchestration relay on the user's Sparkle bearer (the
    // relay holds Sparkle's Deepgram key and meters server-side). setting_enabled is true here (the
    // frontend already gated on the live voice setting); a signed-out user has no bearer → stay
    // on-device. credits_ok is enforced by the relay (it refuses the upgrade when not entitled / can't
    // afford the first minute — a handshake failure we treat as fall-back-to-on-device), so we pass it
    // true here.
    //
    // This command is now `async fn` + `spawn_blocking` (see the handshake below and the fn doc), so
    // the body runs on the async runtime, not the IPC/event-loop (main) thread. The keychain read and
    // the two lock blocks are await-free and quick; only the blocking TLS+WS handshake is offloaded.
    // Making it async means the event loop stays live throughout — a stop/restart can now genuinely
    // interleave with the in-flight handshake, which is exactly what the ptr_eq/epoch re-validation
    // below already guards (it re-reads both under the lock after the handshake returns).
    let token = crate::auth::bearer_token();
    if choose_engine(true, token.is_some(), true) != Engine::Cloud {
        return Ok(false); // signed out → stay on the on-device model; don't consume an epoch on this path
    }
    let token = token.expect("choose_engine returned Cloud only when a bearer is present");
    let base_url = crate::auth::base_url();
    // Claim this attempt only now that we're committing to open. The epoch is an atomic token, so
    // bumping it outside the lock is sound — the post-handshake re-validation re-reads it under the
    // lock, and any racing stop/start that bumps it meanwhile correctly invalidates this attempt.
    let my_epoch = cloud_epoch.fetch_add(1, Ordering::Relaxed) + 1;
    // Offload the blocking TLS+WS handshake (TCP connect + upgrade, bounded at CONNECT_TIMEOUT per
    // resolved address) onto a blocking worker so a slow or black-holed network can't stall the UI —
    // the whole reason this command is async. `app` is consumed by the handshake and unused after it,
    // so it moves into the closure.
    let started = match tauri::async_runtime::spawn_blocking(move || {
        DeepgramSession::start(app, base_url, token, project)
    })
    .await
    {
        Ok(res) => res,
        Err(join_err) => {
            // The blocking task panicked (its panic was already logged by the hook). Treat it like a
            // handshake failure and stay on-device rather than surfacing an error to the mic UI.
            tracing::info!(target: "dictation", error = %join_err, "cloud handshake task failed; using on-device");
            return Ok(false);
        }
    };
    match started {
        Ok(session) => {
            // The handshake above is blocking (~hundreds of ms). Re-validate under the lock before
            // installing, so a stop/restart that raced the handshake can't leave an orphaned stream:
            //   - ptr_eq(cloud_active): the session generation is unchanged (no stop_dictation +
            //     start_dictation installed fresh Arcs while we were connecting — storing into our
            //     captured-but-now-stale Arc would orphan the worker against the new capture).
            //   - epoch unchanged: no stop_cloud_stream / stop_dictation / racing start happened on
            //     THIS session since we claimed our attempt (those all bump the epoch).
            //   - capture present & not already active: belt-and-suspenders for the same intent.
            let mut parked = false;
            let mut displaced: Option<crate::cloud::SilencedSession> = None;
            let reject = {
                let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
                let same_generation = Arc::ptr_eq(&cloud_active, &sess.cloud_active);
                let already_active = cloud_active.load(Ordering::Relaxed);
                let install = should_install_cloud(
                    same_generation,
                    cloud_epoch.load(Ordering::Relaxed) == my_epoch,
                    sess.capture.is_some(),
                    already_active,
                );
                let slot_empty =
                    sess.cloud.lock().unwrap_or_else(|p| p.into_inner()).is_none();
                match raced_stream_disposition(
                    install,
                    same_generation,
                    sess.armed, // a mute leaves the generation intact — see raced_stream_disposition
                    slot_empty,
                    already_active,
                ) {
                    RacedStream::ParkWarm => {
                        // A stop/blur raced the handshake, but this generation is still live and
                        // its slot is empty. Park rather than burn the connection: the next
                        // start_cloud_stream reuses it through cloud_reuse's Resume path — no
                        // second handshake, and the first minute already debited gets used.
                        park_raced_stream(&sess.cloud, &cloud_tx, session);
                        // cloud_active deliberately left FALSE: parked, not routing.
                        parked = true;
                        None
                    }
                    RacedStream::Discard => Some(session),
                    RacedStream::InstallLive => {
                        // Any occupant it displaces comes back SILENCED and must still be closed —
                        // see install_live_stream for why a bare assignment is unsafe now that a
                        // raced socket can be parked into this slot.
                        displaced =
                            install_live_stream(&cloud_slot, &cloud_tx, &cloud_active, session);
                        None
                    }
                }
            };
            if let Some(d) = displaced {
                // Bounded (~2 s) but blocking, and already silenced above — hand it off exactly as
                // the Discard arm does rather than stalling an async-runtime worker on it.
                tracing::info!(target: "dictation", "a parked stream was displaced by a live install; closing it");
                tauri::async_runtime::spawn_blocking(move || d.finish());
            }
            match reject {
                // Parked, not routing: the caller must NOT start metering (nothing is streaming),
                // but the socket is banked for the next utterance rather than thrown away.
                None if parked => {
                    tracing::info!(
                        target: "dictation",
                        "a stop raced the handshake; parking the stream in warm standby instead \
                         of discarding it"
                    );
                    Ok(false)
                }
                None => Ok(true), // installed a live cloud socket → caller may start metering
                Some(s) => {
                    tracing::info!(target: "dictation", "discarding cloud stream opened during a stop/again race");
                    // Silence HERE on this thread, then hand ONLY the blocking close+join off-thread
                    // (bounded ~2 s; nothing below depends on it). Two separate reasons, both about a
                    // teardown that overlaps a successor: (1) finish() alone is not enough — it sets
                    // suppress_ended, which gates only the cloud-ended emit, while the drain keeps
                    // forwarding transcripts; (2) the silencing must happen HERE rather than inside
                    // the spawned task, which would leave the orphan live between spawn_blocking
                    // returning and the worker being scheduled. Either way it speaks into whichever
                    // session raced ahead. This orphan never routed audio, so muting loses nothing.
                    // (roborev 51712/52980/53024)
                    let s = s.silence_now();
                    tauri::async_runtime::spawn_blocking(move || s.finish());
                    Ok(false) // not installed → caller must not bill
                }
            }
        }
        Err(e) => {
            // Offline / bad key / handshake failure → transparently keep using the on-device model.
            tracing::info!(target: "dictation", error = %e, "cloud stream unavailable; using on-device");
            Ok(false)
        }
    }
}

/// Close the Deepgram cloud stream (the frontend calls this on the stop word, or it's called
/// during stop_dictation). Flushes Deepgram for the trailing final result, then routes frames
/// back to the on-device model for continued wake-word listening.
#[tauri::command]
pub fn stop_cloud_stream(state: State<DictationState>) {
    let to_finish = {
        let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let was_active = sess.cloud_active.swap(false, Ordering::Relaxed); // callback routes on-device again
        sess.cloud_epoch.fetch_add(1, Ordering::Relaxed); // invalidate any in-flight start_cloud_stream
        let mut cloud = sess.cloud.lock().unwrap_or_else(|p| p.into_inner());
        // Warm standby: a genuine stop-word stop of a LIVE stream pauses the socket and KEEPS it for
        // ~WARM_STANDBY so the next utterance reuses it (no handshake). The session stays in the slot;
        // start_cloud_stream resumes it. Any other case (already inactive — e.g. a cloud-ended cleanup
        // after warm expiry — or a worker that already died) takes + finishes the leftover instead.
        // Shares the predicate with the blur path rather than restating it: parking on a stop-word
        // stop and parking on a window blur are ONE rule, and an inline copy here is exactly how the
        // two would drift. `is_parked` is what makes the blur ordering work — see
        // `should_keep_warm_on_stop`.
        let keep_warm = cloud
            .as_ref()
            .map(|s| should_keep_warm_on_stop(was_active, s.is_alive(), s.is_parked()))
            .unwrap_or(false);
        if keep_warm {
            // Warm standby: the session (and thus its sender in cloud_tx) is kept for reuse — leave
            // the slot as-is. cloud_active is already false, so the callback routes on-device and
            // won't touch the slot until a resume flips it back. Re-pausing an already-parked
            // session is a no-op in the worker (its Pause arm is guarded on `!paused`), so this
            // never extends the warm timer past the original park.
            cloud.as_ref().unwrap().pause();
            None
        } else {
            // Taking the session down: drop the callback's sender handle too, keeping cloud_tx a
            // faithful mirror of `cloud` (Some iff a session is installed).
            *sess.cloud_tx.lock().unwrap_or_else(|p| p.into_inner()) = None;
            cloud.take()
        }
    }; // release locks before the (slower) finish()/join
    if let Some(s) = to_finish {
        s.finish();
    }
}

// ── Input device picker commands ───────────────────────────────────────────────────────────────

/// The persisted input-device settings, for the picker UI.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputSettings {
    /// `None` = automatic (prefer real hardware — see `audio_devices::select_device`).
    pub chosen_uid: Option<String>,
    /// The advanced opt-in that lets automatic selection accept a virtual (system-audio) input.
    pub allow_virtual: bool,
}

/// Every input device CoreAudio can see, so the user can choose one explicitly rather than living
/// with whatever the OS calls the default.
#[tauri::command]
pub fn list_audio_inputs() -> Vec<crate::audio_devices::InputDevice> {
    crate::audio_devices::list_input_devices()
}

#[tauri::command]
pub fn get_audio_input_settings() -> AudioInputSettings {
    let voice = crate::config::current_effective().config.voice;
    AudioInputSettings {
        chosen_uid: voice.input_device_uid,
        allow_virtual: voice.allow_virtual_input,
    }
}

/// Choose the microphone to capture from, by stable UID. `None` returns to automatic.
///
/// Applies immediately: the capture is re-acquired rather than waiting for the next mute/unmute,
/// because a user who has just been transcribing the wrong audio source wants it to stop NOW.
#[tauri::command]
pub fn set_audio_input(
    app: AppHandle,
    state: State<DictationState>,
    uid: Option<String>,
) -> Result<(), String> {
    // An empty string from the UI means "automatic" — normalize here so the stored config never
    // holds a UID that can't match a device (mirrors DeviceChoice::from_config).
    let uid = uid.filter(|u| !u.trim().is_empty());
    crate::config::set_config_value(
        app.clone(),
        "voice.input_device_uid".into(),
        match &uid {
            Some(u) => serde_json::Value::String(u.clone()),
            None => serde_json::Value::String(String::new()),
        },
    )?;
    state.reacquire_capture(&app);
    Ok(())
}

/// Toggle the advanced "allow a non-microphone input" opt-in.
///
/// Off by default and deliberately not bundled into the picker: a virtual input can carry anything
/// playing on the machine — a call, a video, a stream, someone else's voice — into the transcript.
/// See the privacy note on `config::VoiceConfig::allow_virtual_input`.
#[tauri::command]
pub fn set_allow_virtual_input(
    app: AppHandle,
    state: State<DictationState>,
    allow: bool,
) -> Result<(), String> {
    crate::config::set_config_value(
        app.clone(),
        "voice.allow_virtual_input".into(),
        serde_json::Value::Bool(allow),
    )?;
    state.reacquire_capture(&app);
    Ok(())
}

#[tauri::command]
pub fn stop_dictation(app: AppHandle, state: State<DictationState>) {
    let (transcriber, cloud_session, worker) = {
        let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        // Idempotence: one mute is broadcast to every open window, so this command arrives N times
        // for a single user action (observed in clusters of 3-6 within 0-8ms). Only the first has
        // anything to do; the rest must NOT advance the epoch again, or one mute invalidates
        // in-flight starts N times over — the amplifier behind the 2026-07-26 lockout.
        let start_could_still_arm = sess.start_in_flight == Some(sess.stop_epoch);
        if stop_is_noop(
            sess.armed,
            sess.capture.is_some(),
            sess.transcriber.is_some(),
            start_could_still_arm,
        ) {
            return;
        }
        sess.armed = false;             // disarm so a later focus event can't resurrect the mic
        // Advance the stop epoch so an in-flight start_dictation still loading the model observes
        // that a stop landed during its load and aborts instead of re-arming a muted mic.
        sess.stop_epoch = sess.stop_epoch.wrapping_add(1);
        sess.capture = None;            // drop Capture -> stops the cpal stream (no more frames) AND closes the decode channel
        let worker = sess.decode_worker.take(); // join below, AFTER releasing the lock (drains queued decodes)
        sess.cloud_active.store(false, Ordering::Relaxed);
        sess.cloud_epoch.fetch_add(1, Ordering::Relaxed); // invalidate any in-flight start_cloud_stream
        *sess.cloud_tx.lock().unwrap_or_else(|p| p.into_inner()) = None; // drop the callback's cloud sender handle
        let cloud_session = sess.cloud.lock().unwrap_or_else(|p| p.into_inner()).take(); // tear down any live cloud stream
        (sess.transcriber.take(), cloud_session, worker)
    };                                  // release the session lock before the (slower) join/finalize
    tracing::info!(target: "dictation", "stop_dictation: capture dropped, finalizing");
    // Join the decode worker BEFORE finalize. The capture (sole channel Sender) was dropped above,
    // so the channel is closed: the worker drains any queued accept-path segments — emitting their
    // `dictation://partial`s — then exits. Joining here guarantees those land BEFORE finalize's
    // trailing segment and the closing `dictation://final`, preserving the old in-order emit.
    drop(worker);
    // Flush the cloud stream first (if dictation was stopped mid-cloud) for its trailing final.
    if let Some(s) = cloud_session {
        s.finish();
    }
    if let Some(t) = transcriber {
        for seg in t.lock().unwrap_or_else(|p| p.into_inner()).finalize() { emit_partial(&app, "finalize", seg); }
    }
    let _ = app.emit("dictation://final", String::new());
}

#[cfg(test)]
mod tests {
    use super::{AppHandle, State, AudioHealth, FaultAction, fault_action, no_audio_message,
        missing_tick, build_suppresses_watch, BUILD_STALL_GRACE, DictationSession, MISSING_CAPTURE_TICKS, NO_CAPTURE_MESSAGE,
        begin_start_decision, capture_should_be_live, choose_engine, cloud_reuse, frame_speaking, segment_cloud_latch, park_cloud_for_blur, plan_capture,
        segment_fingerprint, should_emit_blur, should_install_cloud, should_keep_warm_on_stop,
        should_resume_on_focus, should_standby_on_blur, start_after_load, stop_is_noop, unpark_cloud_for_focus, BeginStart, CapturePlan,
        CloudReuse, DeepgramSession, DictationState, Engine, Installed, ReconcileStep, StartAfterLoad,
        raced_stream_disposition, RacedStream, park_raced_stream, install_live_stream, CloudAudioSender,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    // ---- audio liveness watchdog ----------------------------------------------------------
    // Guards the 2026-07-29 incident: capture ran for nine minutes receiving nothing while the UI
    // showed an idle waveform and the user talked to a dead mic.

    #[test]
    fn a_capture_that_hears_nothing_is_re_acquired_before_the_user_is_bothered() {
        // Escalation order matters. Most device changes are recoverable by rebinding, and a user
        // who never sees an error is better served than one who sees an error they must act on.
        // So: silent recovery FIRST, complain only if that failed.
        for health in [AudioHealth::NoFrames, AudioHealth::Silent] {
            assert_eq!(
                fault_action(health, false, false, false),
                FaultAction::Reacquire,
                "{health:?} must first try to recover silently"
            );
            assert_eq!(
                fault_action(health, false, true, false),
                FaultAction::Report,
                "{health:?} that survived a re-acquire must reach the user"
            );
        }
    }

    #[test]
    fn the_user_is_told_once_per_capture_not_once_per_poll() {
        // The watchdog ticks every second. Without the `reported` latch a dead mic would emit an
        // error 540 times over the nine minutes this bug actually lasted.
        assert_eq!(fault_action(AudioHealth::Silent, false, true, true), FaultAction::Idle);
        assert_eq!(fault_action(AudioHealth::NoFrames, false, true, true), FaultAction::Idle);
    }

    #[test]
    fn a_permanently_dead_device_does_not_re_acquire_forever() {
        // The failure mode of a naive retry loop: rebuild, still dead, rebuild… never surfacing.
        // Once we have spent the one free attempt, the next verdict must escalate, not retry.
        assert_ne!(fault_action(AudioHealth::Silent, false, true, false), FaultAction::Reacquire);
    }

    #[test]
    fn recovery_is_announced_only_if_something_was_announced_first() {
        // Retracting a notice nobody saw would clear an UNRELATED error the user does need — the
        // frontend keys its "audio is back" handling off this event.
        assert_eq!(fault_action(AudioHealth::Live, false, true, true), FaultAction::Recovered);
        assert_eq!(
            fault_action(AudioHealth::Live, false, true, false),
            FaultAction::Idle,
            "healthy audio with no complaint outstanding must not emit a retraction"
        );
    }

    #[test]
    fn a_warming_capture_is_never_condemned_or_recovered() {
        // Before the grace window expires we have no evidence either way; acting on it would emit
        // a spurious fault on every single rebuild.
        for (reacquired, reported) in [(false, false), (true, false), (true, true)] {
            assert_eq!(fault_action(AudioHealth::Warming, false, reacquired, reported), FaultAction::Idle);
        }
    }

    #[test]
    fn the_no_audio_message_names_the_device_and_matches_the_remedy_to_it() {
        // Naming the device is what makes the notice actionable — "no audio" sends someone hunting
        // through System Settings. And the remedy must FIT: telling a user on their built-in mic to
        // "pick your microphone" is useless advice, while telling a user stuck on a loopback that
        // another app took the mic misdiagnoses it. See AGENTS.md on remedy strings being code.
        let virt = crate::audio::BoundDevice {
            name: "ZoomAudioDevice".into(),
            uid: Some("zoom.us.zoomaudiodevice.001".into()),
            is_virtual: true,
            was_default: true,
        };
        let msg = no_audio_message(&virt, false);
        assert!(msg.contains("ZoomAudioDevice"), "must name the device: {msg}");
        assert!(
            msg.contains("not a microphone"),
            "a virtual device is a WRONG-DEVICE problem, and the copy must say so: {msg}"
        );

        let physical = crate::audio::BoundDevice {
            name: "MacBook Pro Microphone".into(),
            uid: Some("BuiltInMicrophoneDevice".into()),
            is_virtual: false,
            was_default: true,
        };
        let msg = no_audio_message(&physical, false);
        assert!(msg.contains("MacBook Pro Microphone"), "must name the device: {msg}");
        assert!(
            !msg.contains("not a microphone"),
            "a real mic must NOT be described as the wrong kind of device: {msg}"
        );
    }

    #[test]
    fn an_in_flight_build_is_never_mistaken_for_a_failed_one() {
        // roborev 55286. MISSING_CAPTURE_TICKS alone is a wall-clock guess, and Capture::start's
        // CoreAudio init blocks on the MAIN thread — which this file documents as being blocked for
        // seconds elsewhere. A build that is merely slow must not produce "Sparkle couldn't open a
        // microphone". The marker is what distinguishes them, so no number of ticks may escalate
        // while a build is genuinely running.
        let mut ticks = 0;
        for _ in 0..(MISSING_CAPTURE_TICKS as u16 * 4) {
            let (next, fault) = missing_tick(false, true, true, ticks);
            assert!(!fault, "a build in flight must never escalate while it is still plausible");
            ticks = next;
        }
        assert_eq!(ticks, 0, "ticks must not accumulate behind an in-flight build");
    }

    #[test]
    fn a_segment_that_straddles_the_cloud_switch_is_never_typed_twice() {
        // roborev 55300. Deepgram transcribes and TYPES as it goes, so any audio that reached the
        // relay must never also be decoded on-device — the user would see the tail of their own
        // sentence a second time. The segment, not the frame, is the unit that matters.

        // The straddle: opens on the cloud path, the relay drops mid-utterance (cloud_active goes
        // false), the segment closes on-device a few frames later.
        let (l, drop_now) = segment_cloud_latch(false, true, false); // opening frame, cloud live
        assert!(l && !drop_now, "still open — nothing to decide yet");
        let (l, drop_now) = segment_cloud_latch(l, false, false); // the relay just died
        assert!(l && !drop_now, "the latch must SURVIVE the flip; the audio still went to the relay");
        let (next, drop_now) = segment_cloud_latch(l, false, true); // segment closes on-device
        assert!(drop_now, "the relay already typed this — decoding it on-device types it twice");
        assert!(!next, "and the NEXT segment starts clean: it is genuinely ours to transcribe");

        // The ordinary on-device utterance is untouched — this must not eat normal dictation.
        let (l, drop_now) = segment_cloud_latch(false, false, false);
        assert!(!l && !drop_now);
        assert_eq!(segment_cloud_latch(l, false, true), (false, false), "decode it, as always");

        // And a segment wholly inside a cloud stream is the relay's too (it is discarded without
        // ever being copied, but the latch must agree, or the first on-device segment after the
        // stream ends would be judged by a stale `false`).
        let (l, _) = segment_cloud_latch(false, true, false);
        assert_eq!(segment_cloud_latch(l, true, true), (true, true));
    }

    #[test]
    fn a_build_that_hangs_stops_being_believed_instead_of_silencing_the_watch_forever() {
        // roborev 55300. `build_started_at` is cleared by install_capture and by the build's error
        // arm — neither of which a HUNG build ever reaches. An unbounded "a build is running"
        // therefore turns the liveness watch OFF for the rest of the session on an armed session
        // with no capture: the nine-minute silence, re-entered through the fix for the false
        // positive. So the belief has to expire.
        use std::time::Duration;
        assert!(!build_suppresses_watch(None), "no build running → nothing to suppress");
        assert!(
            build_suppresses_watch(Some(Duration::ZERO)),
            "a build that just started is plausible"
        );
        assert!(
            build_suppresses_watch(Some(BUILD_STALL_GRACE - Duration::from_millis(1))),
            "still inside the grace → still believed"
        );
        assert!(
            !build_suppresses_watch(Some(BUILD_STALL_GRACE)),
            "AT the grace we stop believing it — a hung build must not silence the watch"
        );
        assert!(
            !build_suppresses_watch(Some(BUILD_STALL_GRACE * 60)),
            "and a marker left set for minutes certainly must not"
        );
        // And once disbelieved, the ordinary escalation runs: the user hears about it.
        let (_, fault) = missing_tick(false, true, false, MISSING_CAPTURE_TICKS - 1);
        assert!(fault, "a stale in-flight marker must fall through to the escalation");
    }

    #[test]
    fn an_armed_mic_with_no_capture_escalates_once_the_build_is_no_longer_running() {
        // The failure this path exists for: a re-acquire whose build ERRORED leaves no capture and
        // no build in flight. That must reach the user rather than returning Idle forever.
        let mut ticks = 0;
        for _ in 1..MISSING_CAPTURE_TICKS {
            let (next, fault) = missing_tick(false, true, false, ticks);
            assert!(!fault, "must debounce briefly before accusing anything");
            ticks = next;
        }
        let (ticks, fault) = missing_tick(false, true, false, ticks);
        assert_eq!(ticks, MISSING_CAPTURE_TICKS);
        assert!(fault, "an armed mic with no capture and no build running must reach the user");
    }

    #[test]
    fn the_missing_capture_counter_resets_whenever_there_is_nothing_wrong() {
        // Both non-fault cases, so a stale count can't carry into a later, unrelated window.
        assert_eq!(missing_tick(true, true, false, 7), (0, false), "capture present → reset");
        assert_eq!(missing_tick(false, false, false, 7), (0, false), "muted/unfocused → reset");
    }

    #[test]
    fn clearing_an_audio_fault_clears_every_latch_not_just_the_reported_one() {
        // roborev 55286 called the previous version of this test VACUOUS and was right: it asserted
        // `fault_action` outcomes that the commit never changed, so it passed against the old code.
        // This asserts the actual SIDE EFFECT — the session state the Recovered arm mutates.
        //
        // It matters because leaving `audio_reacquired` set makes the NEXT fault skip the silent
        // recovery attempt and go straight to complaining, inverting "recover before you complain"
        // exactly in the flapping-device case where a rebind is the fix.
        let mut sess = DictationSession {
            audio_reported: true,
            audio_reacquired: true,
            audio_missing_ticks: 9,
            ..Default::default()
        };
        sess.clear_audio_fault();
        assert!(!sess.audio_reported, "the user-visible notice must be retractable again");
        assert!(!sess.audio_reacquired, "the next fault must get its own recovery attempt");
        assert_eq!(sess.audio_missing_ticks, 0, "a stale count must not survive a recovery");
    }

    #[test]
    fn the_remedy_copy_names_an_action_that_actually_exists() {
        // AGENTS.md: a remedy message is an instruction the user will follow, so it must name a
        // control that EXISTS and that WORKS. Both halves have bitten this string. It once sent
        // users to "the mic menu" when that menu was a three-option mode pill with no device list
        // (roborev 55277), so it was swung to System Settings.
        //
        // The picker now lives in that menu — and System Settings became the WRONG answer for the
        // wrong-device case in the same stroke, because this branch stopped following the system
        // default: automatic selection prefers a physical input over it, and a pinned UID ignores
        // it. Telling someone to change the OS default can therefore leave capture on the exact
        // device the message just complained about. A remedy that does nothing is worse than none.
        let virt = crate::audio::BoundDevice {
            name: "ZoomAudioDevice".into(),
            uid: None,
            is_virtual: true,
            was_default: true,
        };
        let physical = crate::audio::BoundDevice {
            name: "MacBook Pro Microphone".into(),
            uid: None,
            is_virtual: false,
            was_default: true,
        };
        for msg in [no_audio_message(&virt, false), no_audio_message(&physical, false)] {
            assert!(
                msg.contains("mic menu"),
                "the wrong-device remedy must point at the picker that actually rebinds: {msg}"
            );
            assert!(
                !msg.contains("System Settings"),
                "changing the OS default no longer changes what Sparkle binds to: {msg}"
            );
        }
        // MUTE is the exception, and stays: no in-app picker can unmute hardware.
        let muted = no_audio_message(&physical, true);
        assert!(muted.contains("System Settings"), "unmuting is genuinely an OS control: {muted}");
    }

    #[test]
    fn the_no_device_bound_report_names_the_picker_too() {
        // roborev 55360: the audit stopped one arm short. When the re-acquire cannot rebuild a
        // capture at all there is no device to name, and THAT message still said "check System
        // Settings → Sound → Input" — advice that provably cannot rebind Sparkle, on the very path
        // where nothing could be opened. It is also the one string that matches no bucket in
        // dictationCopy (`no-audio` needs "no audio from", `no-device` needs a literal "no
        // microphone"), so it falls through to `unknown` and is shown to the user VERBATIM.
        //
        // Asserted against the constant the Report arm actually emits, so the two cannot drift.
        let msg = NO_CAPTURE_MESSAGE;
        assert!(
            msg.contains("mic menu"),
            "the no-device report must point at the picker that can actually rebind: {msg}"
        );
        assert!(
            !msg.contains("System Settings"),
            "changing the OS default cannot rebind Sparkle: {msg}"
        );
    }

    #[test]
    fn a_muted_microphone_is_named_as_muted_not_accused_of_being_broken() {
        // roborev 55275. A hardware mute switch (Jabra/Poly), kAudioDevicePropertyMute, and several
        // Bluetooth/USB drivers all deliver EXACT 0.0 — same signature as the dead virtual device.
        // Without this split the watchdog tells a user their microphone is dead every time they
        // mute it themselves, and points them at a remedy for a fault that does not exist.
        let device = crate::audio::BoundDevice {
            name: "Jabra Evolve2".into(),
            uid: Some("Jabra_UID".into()),
            is_virtual: false,
            was_default: true,
        };
        let msg = no_audio_message(&device, true);
        assert!(msg.contains("Jabra Evolve2"), "must name the device: {msg}");
        assert!(msg.contains("muted"), "must say it is MUTED: {msg}");
        assert!(
            !msg.contains("holding the microphone"),
            "a muted mic must not be blamed on another app stealing it: {msg}"
        );
    }

    #[test]
    fn a_muted_device_is_reported_immediately_instead_of_being_re_acquired() {
        // Rebuilding a stream cannot unmute hardware, so the recovery attempt is pure churn that
        // only delays the one message the user needs. Same inputs as the un-muted case below, so
        // the ONLY difference is the mute flag — which is what proves the flag does the work.
        assert_eq!(
            fault_action(AudioHealth::Silent, true, false, false),
            FaultAction::Report,
            "a muted device must skip the pointless re-acquire"
        );
        assert_eq!(
            fault_action(AudioHealth::Silent, false, false, false),
            FaultAction::Reacquire,
            "an un-muted device still gets its silent recovery attempt first"
        );
        // Still exactly once, muted or not.
        assert_eq!(fault_action(AudioHealth::Silent, true, false, true), FaultAction::Idle);
    }

    #[test]
    fn the_waveform_moves_only_on_real_speech_on_both_paths() {
        // On-device path: the waveform's speaking signal is exactly the VAD flag, so the meter
        // freezes the instant the VAD stops hearing speech.
        assert!(!frame_speaking(false, false), "on-device + VAD silent → not speaking");
        assert!(frame_speaking(false, true), "on-device + VAD speech → speaking");
        // Cloud path — THE FIX. This used to return `cloud_active || vad_detected`, so the meter
        // animated for the entire life of a cloud stream whether or not anyone was speaking. That
        // is not merely distracting, it is DISHONEST: on 2026-07-29 a user talked for nine minutes
        // at a microphone delivering digital silence, reassured by a waveform that was moving for
        // reasons unrelated to their voice. A still waveform is now a glance-level symptom.
        assert!(
            !frame_speaking(true, false),
            "cloud + VAD silent → STILL; a moving meter must mean the engine hears speech"
        );
        assert!(frame_speaking(true, true), "cloud + VAD speech → speaking");
        // The capture callback is what makes that assertion meaningful: it now feeds the VAD on the
        // cloud path too (discarding the segments, since Deepgram does the transcribing), so
        // `vad_detected` carries real information there instead of being a moot `false`.
    }

    #[test]
    fn capture_is_live_only_when_armed_and_focused() {
        // The mic captures only when the user hasn't muted (armed) AND a Sparkle window is the
        // active OS window (focused). Tabbing to another app drops `focused` and releases the mic.
        assert!(capture_should_be_live(true, true), "armed + focused → live");
        assert!(!capture_should_be_live(true, false), "armed but unfocused → released");
        assert!(!capture_should_be_live(false, true), "muted, even if focused → off");
        assert!(!capture_should_be_live(false, false), "muted + unfocused → off");
    }

    #[test]
    fn plan_capture_builds_when_live_and_absent_and_tears_down_when_dead_and_present() {
        // The capture transition reconcile must make, factored out so it can be DECIDED under the
        // session lock and then ACTED ON outside it — the structural fix for the sparkle-sfxu launch
        // deadlock, where Capture::start ran while the lock was held. Build only when the mic should
        // be live and isn't yet; tear down only when it shouldn't be but still is; nothing otherwise.
        assert_eq!(plan_capture(true, false), CapturePlan::Build, "should be live, none yet → build");
        assert_eq!(plan_capture(false, true), CapturePlan::Teardown, "shouldn't be live, still is → tear down");
        assert_eq!(plan_capture(true, true), CapturePlan::Idle, "already live → nothing");
        assert_eq!(plan_capture(false, false), CapturePlan::Idle, "already off → nothing");
    }

    #[test]
    fn take_reconcile_step_releases_the_session_lock_before_the_caller_acts() {
        // The heart of the sparkle-sfxu fix. The v0.28.0 launch deadlock was start_dictation (on an
        // async-runtime worker) holding the session Mutex across is_focused() / Capture::start, both
        // of which block on the MAIN thread — which was itself blocked on this SAME Mutex in the
        // WindowEvent::Focused handler. reconcile_capture now decides the transition under the lock
        // (take_reconcile_step) and RELEASES it before the main-thread-dependent build/teardown.
        // Assert on the real DictationState that the lock is free the instant the step returns — the
        // exact property whose absence froze the app on launch (100% of stack samples on the mutex).
        //
        // COVERAGE NOTE: the terminal Build (Some transcriber) and Teardown branches extract owned
        // `Capture`/`ParakeetTdt`, which have no portable constructor — `Capture::start` needs a real
        // audio device and `ParakeetTdt::new` a 482MB model, absent in CI. That is exactly why the
        // capture DECISION lives in the pure `plan_capture` (matrix-tested above), and the lock
        // release is guaranteed by the guard's scope for EVERY branch. We still drive both reachable
        // arms — the default (Idle) and the armed path that enters the `CapturePlan::Build` match arm
        // — and assert the lock is free after each, so a future edit that holds the guard past the
        // decision fails here regardless of which branch it takes.
        let idle = DictationState::default();
        let g = idle.1.load(std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(idle.take_reconcile_step(true, g), ReconcileStep::Idle), "unarmed → nothing to do");
        assert!(idle.0.try_lock().is_ok(), "Idle branch must release the session lock");

        // Armed + focused enters the `CapturePlan::Build` arm; with no transcriber resident it falls
        // to the belt-and-suspenders `None => Idle`, but it has exercised the Build arm's lock-scoped
        // extraction and must likewise return with the lock free.
        let armed = DictationState::default();
        armed.0.lock().unwrap().armed = true;
        let g = armed.1.load(std::sync::atomic::Ordering::SeqCst);
        let _ = armed.take_reconcile_step(true, g);
        assert!(
            armed.0.try_lock().is_ok(),
            "take_reconcile_step must not hold the session lock when it returns — the build/teardown \
             that follows blocks on the main thread and would deadlock against the focus handler"
        );
    }

    #[test]
    fn take_reconcile_step_does_not_clobber_a_focus_event_that_raced_the_off_lock_sample() {
        use std::sync::atomic::Ordering;
        // sparkle-sfxu review round 2. The worker samples focus OFF the lock (is_focused blocks on
        // the main thread), so a real Focused event can land — authoritatively writing sess.focused
        // via set_focused AND bumping the focus generation — after the sample but before
        // take_reconcile_step re-takes the lock. The worker's now-stale sample must NOT overwrite that
        // fresher value; if it did, the mic could go live while the window is actually unfocused,
        // defeating the sparkle-9oz6 gate (mic never captures while you're in another app).
        let state = DictationState::default();
        state.0.lock().unwrap().armed = true;
        // The worker read the generation here, then sampled focus = true (a window was focused then).
        let sampled_gen = state.1.load(Ordering::SeqCst);
        // ...but before the worker re-takes the lock, a blur lands: set_focused writes the
        // authoritative focused = false and note_focus_event bumps the generation.
        state.1.fetch_add(1, Ordering::SeqCst);
        state.0.lock().unwrap().focused = false;
        // The worker now finishes reconcile with its STALE sample (focus = true, gen = sampled_gen).
        let step = state.take_reconcile_step(true, sampled_gen);
        assert!(
            !state.0.lock().unwrap().focused,
            "a focus event that raced the off-lock sample must win — the stale sample must not clobber it"
        );
        assert!(
            matches!(step, ReconcileStep::Idle),
            "with focus authoritatively false, the reconcile must plan no capture build"
        );
    }

    #[test]
    fn take_reconcile_step_seeds_focus_from_the_sample_when_no_event_raced_it() {
        use std::sync::atomic::Ordering;
        // The other half of the guard: when NO focus event has spoken (generation unchanged), the
        // off-lock sample is still the right seed — the arm-time path where the window is already
        // focused and no Focused event will fire, so the mic must come up from the sample alone.
        let state = DictationState::default();
        state.0.lock().unwrap().armed = true;
        let gen = state.1.load(Ordering::SeqCst);
        let _ = state.take_reconcile_step(true, gen);
        assert!(state.0.lock().unwrap().focused, "unraced sample seeds focus so the mic can arm on mount");
    }

    #[test]
    fn blur_parks_a_live_cloud_session_and_leaves_everything_else_alone() {
        // The blur path used to drop the capture and say nothing to the cloud session, so the socket
        // idled — unpaused, no CloseStream, no warm timer — until the relay's upstream idle-close
        // severed it. A refocus moments later then paid a full TLS+WS handshake (run inline on the
        // IPC/event-loop thread) that the 8s warm standby already existed to avoid: 114 sub-8s
        // reconnects in a single observed session. Park iff there is something live to park.
        assert!(should_standby_on_blur(true, true), "live + active → park in warm standby");
        // Not active: the session is already parked (a stop-word stop got there first) or was never
        // routed to cloud. Re-pausing would restart the warm timer and hold the socket longer.
        assert!(!should_standby_on_blur(false, true), "already inactive → nothing to park");
        // Dead worker: the socket is gone; pause() would be a send into a closed channel.
        assert!(!should_standby_on_blur(true, false), "dead session → nothing to park");
        assert!(!should_standby_on_blur(false, false), "inactive and dead → nothing to park");
    }

    #[test]
    fn a_stop_that_follows_the_blur_park_leaves_the_socket_warm() {
        // The regression this closes. On blur, TWO things run in order: the Rust reconcile teardown
        // parks the socket (clearing cloud_active), and THEN the frontend's blur handler invokes
        // stop_cloud_stream. Judging solely by `was_active` meant that second step read a flag the
        // first step had just cleared, took the keep-warm branch away, and closed the socket ~100ms
        // after parking it — so warm standby never survived a blur and every refocus paid a fresh
        // handshake, which is what the standby was added to prevent.
        assert!(
            should_keep_warm_on_stop(false, true, true),
            "already parked by the blur path → keep the warm socket, don't close it"
        );
        // Unchanged: a stop-word stop of a live, actively-routing stream still parks.
        assert!(should_keep_warm_on_stop(true, true, false), "live + active → park");
        // Still closed — an installed session that never routed and was never parked has NO warm
        // timer running behind it, so keeping it would leave a socket idling until the relay's
        // upstream idle-close. That is the post-handshake race window, and it must still tear down.
        assert!(
            !should_keep_warm_on_stop(false, true, false),
            "alive but neither active nor parked → close it; nothing is holding a warm timer"
        );
        // Dead worker (warm expiry / socket death): nothing to keep, the caller finishes the corpse.
        assert!(!should_keep_warm_on_stop(false, false, true), "dead → close, even if it was parked");
        assert!(!should_keep_warm_on_stop(true, false, false), "dead → close");
    }

    #[test]
    fn refocus_resumes_only_a_session_that_is_still_warm() {
        // The other half: a refocus inside the warm window resumes on the SAME connection.
        assert!(should_resume_on_focus(false, true), "parked + still alive → resume, no handshake");
        // Expired while we were away. This is the load-bearing case: warm standby closed the socket
        // and the worker exited, so resuming would flip cloud_active back on with nothing behind it
        // and route the capture callback at a dead session instead of on-device. Leave it for the
        // frontend's cloud-ended cleanup, which then opens a fresh stream as it does today.
        assert!(!should_resume_on_focus(false, false), "expired session → do NOT revive");
        // Already active — a focus gain with no preceding park (e.g. window-to-window). Resuming a
        // non-paused worker is a no-op, but asserting it keeps park/unpark strictly symmetric.
        assert!(!should_resume_on_focus(true, true), "never parked → nothing to resume");
        assert!(!should_resume_on_focus(true, false), "active but dead → not ours to revive");
    }

    #[test]
    fn park_and_unpark_are_inverses_on_a_live_session() {
        // Park then unpark must return the routing flag to where it started, or a blur/refocus pair
        // would silently strand dictation on-device (or worse, mark cloud active with no socket).
        for alive in [true, false] {
            let active_after_park = !should_standby_on_blur(true, alive);
            assert_eq!(
                should_resume_on_focus(active_after_park, alive),
                alive,
                "a live session must round-trip active→parked→active; a dead one must stay parked"
            );
        }
    }

    #[test]
    fn park_and_unpark_are_noops_for_an_on_device_session() {
        // The empty-slot branch: pure on-device dictation has no cloud session, and a blur/refocus
        // must not touch the routing flag on its way past. Reachable without a mock because the slot
        // is just an Option — the live-session ordering is covered by the predicates above, since
        // faking a DeepgramSession would mean a trait abstraction this one call site doesn't earn.
        let cloud: Mutex<Option<DeepgramSession>> = Mutex::new(None);

        for initial in [false, true] {
            let flag = AtomicBool::new(initial);
            park_cloud_for_blur(&cloud, &flag);
            assert_eq!(flag.load(Ordering::Relaxed), initial, "blur must not touch an empty slot");
            unpark_cloud_for_focus(&cloud, &flag);
            assert_eq!(flag.load(Ordering::Relaxed), initial, "refocus must not touch an empty slot");
        }
    }

    #[test]
    fn park_and_unpark_recover_from_a_poisoned_cloud_lock() {
        // Poison tolerance is load-bearing here (): a panicked frame must never wedge
        // dictation, so these run on the focus path and must not propagate a poisoned lock.
        let cloud: Arc<Mutex<Option<DeepgramSession>>> = Arc::new(Mutex::new(None));
        let poisoner = Arc::clone(&cloud);
        let _ = std::thread::spawn(move || {
            let _g = poisoner.lock().unwrap();
            panic!("poison the cloud slot");
        })
        .join();
        assert!(cloud.is_poisoned(), "precondition: the slot is poisoned");

        let flag = AtomicBool::new(false);
        park_cloud_for_blur(&cloud, &flag);
        unpark_cloud_for_focus(&cloud, &flag);
    }

    #[test]
    fn deferred_blur_commits_only_when_current_and_still_unfocused() {
        // Real tab-away: this blur is still the latest event and a re-poll finds nothing focused.
        assert!(should_emit_blur(5, 5, false), "current + unfocused → release the mic");
        // Window-to-window switch: the new window's becomeKey bumped the generation past ours, so
        // our older deferred blur must bow out (don't tear down the now-focused window's dictation).
        assert!(!should_emit_blur(5, 6, false), "superseded by a newer focus event → skip");
        // A window is focused again by the time we re-poll → skip even if not superseded.
        assert!(!should_emit_blur(5, 5, true), "something regained focus → skip");
        assert!(!should_emit_blur(5, 7, true), "superseded AND refocused → skip");
    }

    #[test]
    fn a_focus_gain_supersedes_a_pending_deferred_blur() {
        use std::sync::atomic::{AtomicU64, Ordering};
        // Mirror note_focus_event's generation protocol without threads/timers, to lock in the
        // invariant that a window-to-window switch never releases the mic: a LOSS captures
        // my_gen = ++gen; a subsequent GAIN bumps gen again. The deferred blur then sees itself
        // superseded (my_gen != latest) and bows out — even though its own re-poll found nothing
        // focused. (Guards against a future refactor that drops the `+ 1` or forgets to bump on gain.)
        let gen = AtomicU64::new(0);
        let loss_gen = gen.fetch_add(1, Ordering::SeqCst) + 1; // window A resigns key
        gen.fetch_add(1, Ordering::SeqCst); // window B becomes key before the deferral elapses
        assert!(
            !should_emit_blur(loss_gen, gen.load(Ordering::SeqCst), false),
            "a gain after the loss must supersede the deferred blur"
        );

        // Control: an uncontested loss (real tab-away, no intervening gain) still commits.
        let solo = AtomicU64::new(0);
        let only_loss = solo.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(
            should_emit_blur(only_loss, solo.load(Ordering::SeqCst), false),
            "an uncontested loss releases the mic"
        );
    }

    #[test]
    fn stop_capture_is_a_safe_idempotent_noop_without_an_active_capture() {
        // The app-exit path () calls stop_capture unconditionally, including when no
        // dictation was ever started. It must not panic and must leave the session clean, even
        // when called repeatedly.
        let state = DictationState::default();
        state.stop_capture();
        state.stop_capture();
        assert!(state.0.lock().unwrap().capture.is_none());
    }

    /// Every combination is asserted below, so name them once here rather than inline.
    const LIVE_OURS: Installed = Installed { alive: true, project_matches: true };
    const LIVE_OTHER: Installed = Installed { alive: true, project_matches: false };
    const DEAD_OURS: Installed = Installed { alive: false, project_matches: true };
    const DEAD_OTHER: Installed = Installed { alive: false, project_matches: false };

    #[test]
    fn cloud_reuse_reopens_for_another_project_even_when_already_routing() {
        // The billing rule. `active` true + wrong project is the focus-regain case: unpark resumes a
        // parked socket without knowing which project we're now dictating into, so if this returned
        // AlreadyRouting the new project's minutes would keep billing the old one (roborev 50498).
        assert_eq!(cloud_reuse(true, Some(LIVE_OTHER)), CloudReuse::Reopen);
        assert_eq!(cloud_reuse(false, Some(LIVE_OTHER)), CloudReuse::Reopen);
    }

    #[test]
    fn cloud_reuse_is_idempotent_for_the_same_project_and_resumes_a_warm_one() {
        assert_eq!(cloud_reuse(true, Some(LIVE_OURS)), CloudReuse::AlreadyRouting);
        assert_eq!(cloud_reuse(false, Some(LIVE_OURS)), CloudReuse::Resume);
    }

    #[test]
    fn cloud_reuse_opens_fresh_when_nothing_usable_is_installed() {
        // All four `installed` shapes are pinned at both `active` values: liveness gates reuse, so a
        // future arm reordering (say Some(alive:_, project_matches:false) => Reopen) can't silently
        // change the dead cases. (roborev 52647)
        assert_eq!(cloud_reuse(false, None), CloudReuse::Open);
        assert_eq!(cloud_reuse(false, Some(DEAD_OURS)), CloudReuse::Open, "dead → reopen fresh");
        assert_eq!(cloud_reuse(false, Some(DEAD_OTHER)), CloudReuse::Open);
        // A dead socket under an `active` flag is the mid-stream-death window the capture callback
        // already documents: let cloud-ended → stop_cloud_stream recover it rather than opening a
        // second stream underneath.
        assert_eq!(cloud_reuse(true, None), CloudReuse::AlreadyRouting);
        assert_eq!(cloud_reuse(true, Some(DEAD_OURS)), CloudReuse::AlreadyRouting);
        assert_eq!(cloud_reuse(true, Some(DEAD_OTHER)), CloudReuse::AlreadyRouting);
    }

    /// `raced_stream_disposition` takes five bools; at the call sites below that would read as
    /// `(false, true, true, true, false)` and be unreviewable. This names them once.
    #[derive(Clone, Copy)]
    struct Race {
        install: bool,
        same_generation: bool,
        armed: bool,
        slot_empty: bool,
        already_active: bool,
    }
    /// The salvageable race: a stop/blur landed mid-handshake on a live, armed, un-claimed session.
    const SALVAGEABLE: Race = Race {
        install: false,
        same_generation: true,
        armed: true,
        slot_empty: true,
        already_active: false,
    };
    fn disposition(r: Race) -> RacedStream {
        raced_stream_disposition(r.install, r.same_generation, r.armed, r.slot_empty, r.already_active)
    }

    #[test]
    fn a_stream_raced_by_a_stop_is_parked_for_reuse_not_thrown_away() {
        // "discarding cloud stream opened during a stop/again race" appears repeatedly in the
        // 2026-07-29 log, and every occurrence cost a full TLS+WS handshake AND an up-front
        // firstMinuteCents debit for a connection that carried no audio. The common triggers — a
        // window blur pausing capture, a stop word landing mid-handshake — do not invalidate the
        // SESSION, only the routing, so the socket is still worth keeping.
        assert_eq!(
            disposition(SALVAGEABLE),
            RacedStream::ParkWarm,
            "same generation, still armed, empty slot: park it so the next utterance reuses it"
        );
        // cloud_reuse's Resume path is what then picks it up, with no second handshake.
        assert_eq!(cloud_reuse(false, Some(LIVE_OURS)), CloudReuse::Resume);
    }

    #[test]
    fn a_stream_raced_by_a_MUTE_is_discarded_not_parked_against_a_dead_mic() {
        // The guard that `same_generation` alone does NOT give you. `stop_dictation` (the mute)
        // disarms and empties the slot but does NOT rotate the cloud Arcs — only a fresh
        // `start_dictation` arm does — so a handshake landing just after a mute still reads as the
        // same generation. Parking there holds a live relay socket against a microphone the user
        // just turned off.
        //
        // And it is worse than waste: un-muting inside the 8s warm window installs fresh Arcs, which
        // DROPS the parked session, and `Drop for DeepgramSession` only signals Close — it does not
        // `silence_now()`. The worker then forwards its trailing transcripts and emits `cloud-ended`
        // into the generation that just armed: a stray final in the new composer, and a stray
        // cloud-ended that stops the successor's stream (roborev 50498/52646/53024).
        assert_eq!(
            disposition(Race { armed: false, ..SALVAGEABLE }),
            RacedStream::Discard,
            "muted: silence and close it — never park a socket against a mic the user turned off"
        );
    }

    #[test]
    fn a_stream_orphaned_by_a_new_session_generation_is_still_discarded() {
        // The case that genuinely cannot be salvaged: stop_dictation + start_dictation installed
        // FRESH Arcs, so this socket is attached to state nobody holds. Parking it would strand a
        // live connection against a dead generation — worse than discarding it.
        assert_eq!(disposition(Race { same_generation: false, ..SALVAGEABLE }), RacedStream::Discard);
        // Nor may we park on top of a socket someone else already owns, or while audio is routing.
        assert_eq!(
            disposition(Race { slot_empty: false, ..SALVAGEABLE }),
            RacedStream::Discard,
            "an occupied slot must never be clobbered"
        );
        assert_eq!(
            disposition(Race { already_active: true, ..SALVAGEABLE }),
            RacedStream::Discard,
            "never shadow a session that is actively routing"
        );
    }

    #[test]
    fn parking_banks_the_socket_in_the_slot_with_its_sender_and_without_routing() {
        // The SIDE EFFECTS, which the boolean table above cannot see. roborev 55291 made the point
        // by example: the missing `armed` guard was invisible to a table test because a table test
        // cannot say which session states its booleans are reachable from.
        let (session, rx) = crate::cloud::parkable_session();
        let cloud: Mutex<Option<DeepgramSession>> = Mutex::new(None);
        let cloud_tx: Mutex<Option<CloudAudioSender>> = Mutex::new(None);
        let cloud_active = AtomicBool::new(false);

        park_raced_stream(&cloud, &cloud_tx, session);

        let guard = cloud.lock().unwrap();
        let parked = guard.as_ref().expect("the socket must be banked in the slot, not dropped");
        // BOTH halves of pause(), because the flag is the lesser one: the atomic only tells
        // stop_cloud_stream to keep the socket, while the MESSAGE is what stops the worker
        // forwarding audio and starts the warm timer (roborev 55315).
        assert!(parked.is_parked(), "the parked flag must be set, or a stop will close the socket");
        assert!(rx.took_pause(), "a Pause must REACH the worker, or the socket keeps relaying audio");
        assert!(
            cloud_tx.lock().unwrap().is_some(),
            "cloud_tx must mirror the slot, exactly as warm standby leaves it"
        );
        assert!(
            !cloud_active.load(Ordering::Relaxed),
            "parked is NOT routing — flipping this would meter a stream carrying no audio"
        );
        // And `cloud_reuse` is what picks it up: alive + parked + our project → Resume, no handshake.
        assert_eq!(
            cloud_reuse(
                false,
                Some(Installed { alive: parked.is_alive(), project_matches: true })
            ),
            CloudReuse::Resume
        );
    }

    #[test]
    fn a_live_install_never_drops_a_parked_socket_in_place() {
        // roborev 55291. Parking broke the invariant that the slot is empty at install time: start A
        // races a stop and parks, start B (holding the current epoch) then installs. A bare
        // assignment would drop A through `Drop for DeepgramSession`, which only signals Close — so
        // A's worker drains its transcripts into B's composer and emits a cloud-ended that stops B.
        let (parked, _rx_a) = crate::cloud::parkable_session();
        let (fresh, _rx_b) = crate::cloud::parkable_session();
        let cloud: Mutex<Option<DeepgramSession>> = Mutex::new(None);
        let cloud_tx: Mutex<Option<CloudAudioSender>> = Mutex::new(None);
        let cloud_active = AtomicBool::new(false);
        park_raced_stream(&cloud, &cloud_tx, parked);

        let displaced = install_live_stream(&cloud, &cloud_tx, &cloud_active, fresh);

        let displaced = displaced.expect("the occupant must be handed back, not dropped in place");
        assert!(
            displaced.is_silenced(),
            "a displaced socket must be muted AND suppressed before its close is handed off"
        );
        assert!(cloud.lock().unwrap().is_some(), "the fresh session takes the slot");
        assert!(cloud_tx.lock().unwrap().is_some(), "cloud_tx mirrors the slot");
        assert!(
            cloud_active.load(Ordering::Relaxed),
            "an installed live stream routes — this is the flag the capture callback reads"
        );
        displaced.finish();
    }

    #[test]
    fn an_unraced_stream_still_installs_live() {
        assert_eq!(disposition(Race { install: true, ..SALVAGEABLE }), RacedStream::InstallLive);
        // `install` wins outright: should_install_cloud already proved the intent is current, so no
        // combination of the park guards may downgrade a live install to a park.
        assert_eq!(
            disposition(Race { install: true, armed: false, slot_empty: false, ..SALVAGEABLE }),
            RacedStream::InstallLive
        );
    }

    #[test]
    fn should_install_cloud_only_when_intent_is_still_current() {
        // Happy path: same session generation, epoch unchanged, capture live, not already active.
        assert!(should_install_cloud(true, true, true, false));
        // Each race that can happen during the blocking handshake must reject (and the caller then
        // finish()es the orphan rather than installing it):
        assert!(!should_install_cloud(false, true, true, false), "generation swapped (stop+restart)");
        assert!(!should_install_cloud(true, false, true, false), "epoch bumped (stop_cloud_stream/stop)");
        assert!(!should_install_cloud(true, true, false, false), "capture torn down (stop_dictation)");
        assert!(!should_install_cloud(true, true, true, true), "a racing start already opened one");
        // All-false (e.g. stopped + restarted + already active) also rejects — makes the AND total.
        assert!(!should_install_cloud(false, false, false, true));
    }

    #[test]
    fn start_after_load_aborts_when_a_stop_landed_during_the_model_load() {
        // The resurrect race (two fresh-install users crashed on it): fresh install → mic OFF, so
        // the user's first click is ON → start_dictation blocks on a 482MB model download. The user
        // then unclicks the mic mid-download → stop_dictation disarms AND bumps the epoch. When the
        // load finishes, start must see the epoch moved and ABORT — not re-arm a muted mic. `armed`
        // is already false here (the stop cleared it), which is precisely why the epoch is needed.
        assert_eq!(
            start_after_load(0, 1, false),
            StartAfterLoad::AbortMutedDuringLoad,
            "a stop during the load (epoch advanced) must abort even though armed is false"
        );
        // Even if a racing start re-armed after that stop, the epoch still advanced → abort and
        // leave the other start's fresh session untouched.
        assert_eq!(
            start_after_load(0, 1, true),
            StartAfterLoad::AbortMutedDuringLoad,
            "epoch is checked first: a stop+re-arm during the load still aborts this start"
        );
    }

    #[test]
    fn start_after_load_reconciles_on_a_racing_start_and_arms_on_a_clean_load() {
        // Epoch unchanged + a racing start_dictation already armed → don't overwrite the live
        // transcriber without finalize(); just reconcile.
        assert_eq!(start_after_load(3, 3, true), StartAfterLoad::AlreadyArmed);
        // Epoch unchanged + not armed → the clean fresh-arm path installs the transcriber.
        assert_eq!(start_after_load(3, 3, false), StartAfterLoad::Arm);
    }

    /// The freeze guard itself, enforced by the compiler rather than at runtime — the two properties
    /// that keep the 631MB first-run load off the main thread, both of which are quietly lost by an
    /// innocent-looking edit:
    ///
    ///   - `start_dictation` RETURNS A FUTURE. Drop the `async` and tauri-macros silently reclassifies
    ///     it as `ExecutionContext::Blocking`, running the whole download inline on the IPC/event-loop
    ///     thread — the beachball this fix exists to remove. There's no warning; the app just freezes
    ///     again on a machine that doesn't have the model yet (i.e. never on a developer's).
    ///   - That future is `Send`. `respond_async_serialized` requires it, and the only realistic way
    ///     to lose it is holding the session's `std::sync::Mutex` guard across the `.await` — which is
    ///     precisely the mistake the epoch protocol cannot survive. This turns "don't hold the lock
    ///     across an await" from a comment into a compile error.
    #[test]
    fn start_dictation_is_async_and_its_future_is_send() {
        fn off_the_main_thread<'r, F: std::future::Future + Send>(
            _: fn(AppHandle, State<'r, DictationState>) -> F,
        ) {
        }
        off_the_main_thread(super::start_dictation);
    }

    /// The model load must be mutually exclusive process-wide. Two concurrent loads promote into the
    /// SAME `root/ASR_DIR` via `remove_dir_all` + `rename`, so an unserialized second load can delete
    /// the tree the first has just verified and is handing to sherpa-onnx — an uncatchable C++ abort,
    /// not a recoverable error (see MODEL_LOAD). Newly reachable now that the loads run off-thread.
    ///
    /// Exclusion is the whole property, so that is what this asserts: while one load holds the guard,
    /// a second cannot acquire it and must wait.
    ///
    /// Deliberately ONE test rather than two: `MODEL_LOAD` is a global, and cargo runs tests on
    /// parallel threads, so a sibling test touching it would race this one's `try_lock` assertions
    /// (and the poison check below would leak into it — `try_lock` on a poisoned mutex reports
    /// `Poisoned`, not `WouldBlock`). Kept sequential here, so the ordering is deterministic.
    #[test]
    fn the_model_load_is_serialized_and_survives_a_panicked_load() {
        use std::sync::TryLockError;
        {
            let _held = super::MODEL_LOAD.lock().unwrap_or_else(|p| p.into_inner());
            assert!(
                matches!(super::MODEL_LOAD.try_lock(), Err(TryLockError::WouldBlock)),
                "a second load must WAIT for the first, never race its promote into the shared dest"
            );
        }
        assert!(super::MODEL_LOAD.try_lock().is_ok(), "and the guard is released when a load finishes");

        // A panicking load must not brick the mic for the rest of the process's lifetime. Every lock
        // in this module is poison-tolerant for that reason (), and the guard gating EVERY
        // first-run mic click is the last one that should wedge permanently.
        let _ = std::panic::catch_unwind(|| {
            let _g = super::MODEL_LOAD.lock().unwrap_or_else(|p| p.into_inner());
            panic!("model load blew up");
        });
        // `load_model` acquires exactly this way, so a later click still gets through.
        drop(super::MODEL_LOAD.lock().unwrap_or_else(|p| p.into_inner()));
    }

    /// A stand-in for the only two `DictationSession` fields the arm decision reads, so a whole
    /// start/stop interleaving can be driven deterministically — no AppHandle, no 631MB download, no
    /// threads. Every method mirrors exactly what the real command does to those fields inside its
    /// locked critical sections; the point is to pin the SEQUENCES, which `start_after_load`'s own
    /// unit tests (single decisions, hand-picked inputs) can't express.
    ///
    /// This matters more than it used to. `start_dictation` is now an `async fn` whose model load
    /// runs on a blocking thread, so the event loop stays live throughout: a stop_dictation, or a
    /// second start_dictation, can genuinely land mid-load. Before, both were sync commands running
    /// inline on the main thread, so they serialized and these interleavings were unreachable.
    #[derive(Default)]
    struct Guards {
        stop_epoch: u64,
        armed: bool,
        /// Mirrors `DictationSession::start_in_flight`: the epoch sampled by the start currently
        /// loading, so duplicate fan-out starts can be collapsed onto it.
        start_in_flight: Option<u64>,
        /// Model loads actually launched. The fan-out bug was invisible to the old harness because
        /// it never counted the WORK a decision commits to — only which decision came out.
        loads_started: u32,
    }

    impl Guards {
        /// `start_dictation`'s first critical section. `None` = no load runs (either the armed fast
        /// path or a coalesced duplicate); `Some(epoch)` = the sampled stop epoch, carried across
        /// the slow load.
        fn begin_start(&mut self) -> Option<u64> {
            match begin_start_decision(self.armed, self.stop_epoch, self.start_in_flight) {
                BeginStart::FastPathArmed | BeginStart::CoalesceWithInFlight => None,
                BeginStart::Load(epoch) => {
                    self.start_in_flight = Some(epoch);
                    self.loads_started += 1;
                    Some(epoch)
                }
            }
        }

        /// `stop_dictation`: disarm AND advance the epoch — but only when there is something to
        /// stop, so a broadcast mute doesn't advance the epoch once per open window.
        fn stop(&mut self) {
            // Mirrors the real command: "a start that could still arm", NOT "a start exists".
            let start_could_still_arm = self.start_in_flight == Some(self.stop_epoch);
            if stop_is_noop(self.armed, false, self.armed, start_could_still_arm) {
                return;
            }
            self.armed = false;
            self.stop_epoch = self.stop_epoch.wrapping_add(1);
        }

        /// `start_dictation`'s second critical section, once its load returns.
        fn finish_start(&mut self, sampled: u64) -> StartAfterLoad {
            // Release the in-flight claim only if it's still OURS: a newer start may have replaced
            // it while we loaded, and clearing that would let yet another duplicate start a load.
            if self.start_in_flight == Some(sampled) {
                self.start_in_flight = None;
            }
            let decision = start_after_load(sampled, self.stop_epoch, self.armed);
            if decision == StartAfterLoad::Arm {
                self.armed = true;
            }
            decision
        }
    }

    /// Two rapid mic clicks. B's first critical section runs while A is still loading and A hasn't
    /// armed yet, so B does not take the fast path — but B sampled the SAME epoch as A, so it is the
    /// same user intent arriving twice and it now COALESCES onto A's load instead of queuing a second
    /// one. A alone arms, for both.
    ///
    /// This test used to assert the opposite (that B loaded too). That was the behaviour behind the
    /// 2026-07-26 lockout: with ~10 windows open, one toggle queued ~18 model loads on a blocking
    /// pool already saturated by running agents, and they drained one at a time over 3.5 minutes.
    #[test]
    fn two_concurrent_starts_load_once_and_arm_exactly_once() {
        let mut g = Guards::default();
        let a = g.begin_start().expect("nothing armed yet, so A loads");
        assert_eq!(
            g.begin_start(),
            None,
            "B sampled A's epoch — same intent, so it must coalesce rather than load again"
        );
        assert_eq!(g.loads_started, 1, "exactly one model load for one intent");

        assert_eq!(g.finish_start(a), StartAfterLoad::Arm, "A arms on behalf of both");
        assert!(g.armed, "and the session ends armed exactly once");

        // The AlreadyArmed guard is now defence-in-depth rather than a routine outcome (coalescing
        // stops two same-epoch loads existing at all), so pin it directly: if a second load ever does
        // land on an armed session, it must discard its transcriber, never overwrite a live one.
        assert_eq!(
            start_after_load(a, g.stop_epoch, true),
            StartAfterLoad::AlreadyArmed,
            "a late duplicate must not overwrite the live transcriber without finalize()"
        );
    }

    /// The amplifier behind the incident: every open window runs its own `enabled` effect, so ONE
    /// mute broadcasts N `stop_dictation` calls (observed in clusters of 3-6 within 0-8ms). Each used
    /// to advance the single app-global epoch, so one mute could invalidate in-flight starts N times.
    /// One mute must move the epoch exactly once.
    #[test]
    fn a_mute_broadcast_to_every_window_advances_the_epoch_once() {
        let mut g = Guards::default();
        let a = g.begin_start().expect("armed by the user's unmute");
        assert_eq!(g.finish_start(a), StartAfterLoad::Arm);
        let before = g.stop_epoch;

        for _ in 0..8 {
            g.stop(); // eight windows, one broadcast mute
        }

        assert_eq!(
            g.stop_epoch,
            before + 1,
            "one mute = one epoch advance, however many windows relayed it"
        );
        assert!(!g.armed, "and the mic is genuinely muted");
    }

    /// The same broadcast, but landing DURING a model load — the case the fix is actually about, and
    /// the one the armed-session test above cannot reach.
    ///
    /// Nothing clears the in-flight claim until the load returns, so a bare "a start exists" test
    /// stays true for the whole load and every one of the N stops would keep advancing the epoch.
    /// See `stop_is_noop` for the invariant that makes the stops after the first genuine no-ops.
    #[test]
    fn a_mute_broadcast_during_a_load_also_advances_the_epoch_once() {
        let mut g = Guards::default();
        let a = g.begin_start().expect("a load is in flight");
        let before = g.stop_epoch;

        for _ in 0..8 {
            g.stop(); // eight windows relay one mute, mid-download
        }

        assert_eq!(
            g.stop_epoch,
            before + 1,
            "one mute during a load must still advance the epoch exactly once"
        );
        // The doomed start must still be doomed — de-amplifying must not reopen the resurrect race.
        assert_eq!(g.finish_start(a), StartAfterLoad::AbortMutedDuringLoad);
        assert!(!g.armed, "the mic the user muted must stay muted");
    }

    /// Interleaved fan-out: windows relay the mute and the re-arm interleaved (stop, start, stop,
    /// start, …) rather than as two clean bursts.
    ///
    /// KNOWN LIMITATION, asserted rather than described: this still costs one load per window,
    /// because each stop/start pair genuinely moves the epoch and the next window's start therefore
    /// reads a newer intent. Deduplicating it needs the frontend to stop relaying one user action
    /// from N windows (single-owner mic intent) — a larger change, tracked as the follow-up. The
    /// count is pinned so neither a regression toward the original incident shape nor a future fix
    /// that improves it can pass silently.
    ///
    /// What the incident was actually about DOES hold here: the mic is never left dead.
    #[test]
    fn interleaved_stop_start_fan_out_still_ends_armed() {
        const WINDOWS: usize = 8;
        let mut g = Guards::default();
        let a = g.begin_start().expect("a load is already in flight when the mute arrives");

        let mut sampled = vec![a];
        for _ in 0..WINDOWS {
            g.stop();
            if let Some(e) = g.begin_start() {
                sampled.push(e);
            }
        }

        assert_eq!(
            g.loads_started as usize,
            WINDOWS + 1,
            "known limitation: interleaved fan-out still costs one load per window"
        );

        // Every stale claim aborts; the last one standing is the live intent and must arm. Landing
        // them oldest-first is the order a saturated blocking pool actually produces.
        let live = *sampled.last().expect("at least one load ran");
        for epoch in sampled.iter().copied().filter(|e| *e != live) {
            assert_eq!(
                g.finish_start(epoch),
                StartAfterLoad::AbortMutedDuringLoad,
                "a stale claim must never arm"
            );
        }
        assert_eq!(g.finish_start(live), StartAfterLoad::Arm);
        assert!(g.armed, "no lockout: the user's re-arm wins even interleaved");
    }

    /// The 2026-07-26 lockout, end to end: eight windows, unmute → mute → unmute. The user's final
    /// intent is ON, so the mic MUST end armed — and the whole sequence must cost two model loads
    /// (one per real intent), not sixteen.
    ///
    /// Before the fix this sequence queued a load per window per toggle, and the mid-sequence mute
    /// advanced the epoch eight times, leaving every queued load dead on arrival: 18 consecutive
    /// `start_dictation aborted` lines over 3.5 minutes with the mic ring still claiming to listen.
    #[test]
    fn the_multi_window_mic_lockout_does_not_recur() {
        const WINDOWS: usize = 8;
        let mut g = Guards::default();

        let first: Vec<u64> = (0..WINDOWS).filter_map(|_| g.begin_start()).collect();
        for _ in 0..WINDOWS {
            g.stop();
        }
        let second: Vec<u64> = (0..WINDOWS).filter_map(|_| g.begin_start()).collect();

        assert_eq!(first.len(), 1, "the first unmute loads once, not once per window");
        assert_eq!(second.len(), 1, "and so does the second");
        assert_eq!(g.loads_started, 2, "two real intents = two loads, not {WINDOWS} * 2");
        // Asserted alongside the load count because they can diverge: the epoch is the state that
        // DECIDES the work, so counting loads alone can look correct while it still over-advances.
        assert_eq!(g.stop_epoch, 1, "the single mute advanced the epoch exactly once");

        // Both loads land, stale one first — the order the saturated pool actually produced.
        assert_eq!(
            g.finish_start(first[0]),
            StartAfterLoad::AbortMutedDuringLoad,
            "the pre-mute load is stale and must not resurrect the mic"
        );
        assert_eq!(g.finish_start(second[0]), StartAfterLoad::Arm);
        assert!(g.armed, "the user's final intent was ON — the mic must be live");
    }

    /// The load-bearing half of `stop_is_noop`: a mute landing DURING a model load must still bump
    /// the epoch. At that moment `armed` is false and nothing is installed yet, so dropping the
    /// `start_in_flight` term would make the stop look like a no-op, skip the bump, and let the load
    /// resurrect a mic the user just muted.
    #[test]
    fn a_mute_during_a_load_is_never_treated_as_a_no_op() {
        assert!(
            !stop_is_noop(false, false, false, true),
            "a start is in flight — this stop has something to cancel"
        );
        assert!(
            stop_is_noop(false, false, false, false),
            "nothing live and nothing loading: genuinely nothing to stop"
        );

        // And end to end: the mic must stay muted.
        let mut g = Guards::default();
        let a = g.begin_start().expect("not armed, so we load");
        g.stop();
        assert_eq!(g.finish_start(a), StartAfterLoad::AbortMutedDuringLoad);
        assert!(!g.armed, "the resurrect race must stay closed");
    }

    /// The freeze bug's own scenario, now that it can actually happen: fresh install → first click
    /// starts a minutes-long download → the user, seeing "nothing happening", clicks the mic off.
    /// The load must not resurrect the mic they just muted.
    #[test]
    fn a_stop_during_the_load_leaves_the_mic_muted() {
        let mut g = Guards::default();
        let a = g.begin_start().expect("fresh install: not armed, so we load");
        g.stop(); // user unclicks the mic mid-download
        assert_eq!(g.finish_start(a), StartAfterLoad::AbortMutedDuringLoad);
        assert!(!g.armed, "the mic must stay muted — this is the resurrect race");
    }

    /// start → stop → start, with the two loads finishing in EITHER order (nothing orders them:
    /// they're independent blocking tasks). Exactly one arm must win, it must be the live one, and
    /// the session must end armed either way.
    #[test]
    fn start_stop_start_arms_once_whichever_load_finishes_first() {
        for b_finishes_first in [false, true] {
            let mut g = Guards::default();
            let a = g.begin_start().expect("first click loads");
            g.stop(); // user mutes...
            let b = g.begin_start().expect("...then clicks again; still not armed, so B loads");
            assert_ne!(a, b, "B sampled AFTER the stop, so it carries a newer epoch");

            let (first, second) = if b_finishes_first { (b, a) } else { (a, b) };
            let decisions = [g.finish_start(first), g.finish_start(second)];

            // A is always stale (it sampled before the stop) and must abort no matter when it lands;
            // B is current and takes the clean arm.
            let expected = if b_finishes_first {
                [StartAfterLoad::Arm, StartAfterLoad::AbortMutedDuringLoad]
            } else {
                [StartAfterLoad::AbortMutedDuringLoad, StartAfterLoad::Arm]
            };
            assert_eq!(decisions, expected, "b_finishes_first={b_finishes_first}");
            assert_eq!(
                decisions.iter().filter(|d| **d == StartAfterLoad::Arm).count(),
                1,
                "exactly one arm, whatever the order"
            );
            assert!(g.armed, "the user's second click wins: the mic ends armed");
        }
    }

    /// Once armed, a start takes the fast path: no epoch sampled, no load, no cloud-Arc swap — just
    /// refresh focus + reconcile. Pins that a second window mounting can never re-download the model
    /// or drop a live transcriber.
    #[test]
    fn an_armed_session_takes_the_fast_path_and_never_reloads() {
        let mut g = Guards::default();
        let a = g.begin_start().unwrap();
        g.finish_start(a);
        assert!(g.armed);

        assert_eq!(g.begin_start(), None, "already armed → fast path, no model load");
        // ...and a stop re-opens the slow path for the next click.
        g.stop();
        assert!(g.begin_start().is_some(), "after a stop, the next start loads again");
    }

    #[test]
    fn choose_engine_requires_setting_signed_in_and_credits() {
        // Cloud only when ALL three hold.
        assert_eq!(choose_engine(true, true, true), Engine::Cloud);
        // Any one missing → fall back to the on-device model.
        assert_eq!(choose_engine(false, true, true), Engine::Local, "setting off");
        assert_eq!(choose_engine(true, false, true), Engine::Local, "signed out (no bearer)");
        assert_eq!(choose_engine(true, true, false), Engine::Local, "no credits");
        assert_eq!(choose_engine(false, false, false), Engine::Local);
    }

    #[test]
    fn identical_text_yields_identical_fingerprint() {
        // The duplicate diagnosis relies on this: the same emitted segment must
        // produce the same fingerprint so "backend emitted twice" is visible in the log.
        assert_eq!(segment_fingerprint("hello world"), segment_fingerprint("hello world"));
    }

    #[test]
    fn different_text_yields_different_fingerprint() {
        // Distinct phrases should (overwhelmingly) differ, so non-duplicates aren't
        // misread as duplicates.
        assert_ne!(segment_fingerprint("turn left"), segment_fingerprint("turn right"));
    }

    #[test]
    fn fingerprint_is_fixed_width_regardless_of_input_size() {
        // Privacy guard: the logged fingerprint must be a fixed-size digest that cannot
        // grow to embed the transcript. A one-word phrase and a long paragraph must both
        // render to exactly 8 lowercase-hex chars — proving the output carries no more
        // information as the input grows. (This is a property that fails if someone later
        // logs the text or a length-proportional value instead.)
        let short = format!("{:08x}", segment_fingerprint("hi"));
        let long = format!("{:08x}", segment_fingerprint(&"word ".repeat(200)));
        for fp in [&short, &long] {
            assert_eq!(fp.len(), 8, "fingerprint must be fixed 8-hex width");
            assert!(fp.chars().all(|c| c.is_ascii_hexdigit()), "fingerprint must be hex-only");
        }
    }
}

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
use crate::audio::{rms_level, Capture};
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

/// The waveform's "is the user speaking right now?" signal for one captured frame — the source
/// of the edge-triggered `dictation://speaking` events. On the on-device path it's the Silero
/// VAD's real-time detection (`vad_detected`). While the cloud stream owns the audio the on-device
/// VAD isn't fed, so we report speaking unconditionally: the user is actively dictating to the
/// cloud by definition, so the meter should stay live. Pure so the cloud/local branch — and the
/// rising/falling edges it produces, including the cloud→on-device transition — are unit-testable
/// without a CoreAudio callback or a loaded VAD model.
pub(crate) fn frame_speaking(cloud_active: bool, vad_detected: bool) -> bool {
    cloud_active || vad_detected
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
    cloud_active && alive
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
/// a refocus moments later pays a full TLS+WS handshake — which `start_cloud_stream` runs inline on
/// the IPC/event-loop thread. Parking instead means a quick refocus resumes on the same connection,
/// and a long one closes cleanly on OUR timer.
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
        // `any_window_focused()` merely SEEDS it at arm time (so the mic comes up without waiting for
        // the first focus event) — and only when no focus event has spoken since we sampled. If the
        // generation moved, a Focused event landed while `any_window_focused()` was blocked on the
        // main thread, so our sample is stale and MUST NOT clobber the authoritative value. Without
        // this the worker could write a stale `focused=true` over a fresh blur and leave the mic live
        // while the window is unfocused (defeating the sparkle-9oz6 gate) — the TOCTOU roborev caught.
        let focus_gen = self.1.load(Ordering::SeqCst);
        let sampled_focus = any_window_focused(app);
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
                    Ok((capture, worker)) => self.install_capture(&transcriber, capture, worker),
                    Err(e) => {
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
                Some(transcriber) => ReconcileStep::Build {
                    transcriber,
                    cloud_active: sess.cloud_active.clone(),
                    cloud_tx: sess.cloud_tx.clone(),
                },
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
    fn install_capture(&self, built_for: &Arc<Mutex<ParakeetTdt>>, capture: Capture, worker: DecodeWorker) {
        let discard = {
            let mut sess = self.0.lock().unwrap_or_else(|p| p.into_inner());
            let still_current = capture_should_be_live(sess.armed, sess.focused)
                && sess.capture.is_none()
                && sess.transcriber.as_ref().map(|t| Arc::ptr_eq(t, built_for)).unwrap_or(false);
            if still_current {
                sess.capture = Some(capture);
                sess.decode_worker = Some(worker);
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
            if should_emit_blur(my_gen, focus_gen.load(Ordering::SeqCst), any_window_focused(&app)) {
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

/// True if at least one Sparkle window is currently the focused/active OS window. Used to seed the
/// focus state at arm time (the frontend calls start_dictation on mount, normally while focused),
/// so the mic comes up without waiting for the first focus event.
fn any_window_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false))
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
    let capture = Capture::start(move |frame: Vec<f32>| {
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
        // frame_speaking for how the cloud/on-device branch maps to it. On the on-device path we
        // read the Silero VAD's real-time flag; on the cloud path the VAD isn't fed (frame_speaking
        // ignores `vad_detected` there), so what we pass is moot.
        let cloud = cloud_active.load(Ordering::Relaxed);
        let vad_detected = if cloud {
            // #2: route to the relay WITHOUT locking the `cloud` teardown mutex. `try_lock` on the
            // dedicated sender slot NEVER blocks the audio thread: if a start/stop is mid-swap we
            // simply drop this frame (the same tens-of-ms transition window that already drops
            // frames), rather than contend with start/stop_cloud_stream/stop_dictation.
            if let Ok(guard) = cloud_tx.try_lock() {
                if let Some(s) = guard.as_ref() {
                    s.send_audio(&frame);
                }
            }
            false // unused when cloud == true
        } else {
            // #1: on the audio thread do ONLY the cheap VAD windowing / segment detection. Closed
            // segments are shipped to the decode worker over a bounded channel; the transducer
            // decode + `dictation://partial` emit happen there, off `com.apple.audio.IOThread`.
            let mut guard = transcriber.lock().unwrap_or_else(|p| p.into_inner());
            let segs = guard.accept_segments(&frame);
            // Read the VAD flag while we still hold the transcriber lock (cheap, no I/O), then
            // release before touching the channel.
            let spk = guard.speaking();
            drop(guard);
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
            spk
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
    Ok((capture, worker))
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
        let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if sess.armed {
            // Fast path (a second window mounting, or a re-arm): resume capture to match focus.
            // Reconcile OFF the lock — is_focused()/Capture::start block on the main thread, and
            // holding the session lock across them from this worker is the sparkle-sfxu deadlock.
            drop(sess);
            state.reconcile_capture(&app);
            return Ok(());
        }
        sess.stop_epoch
    };

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
#[tauri::command]
pub fn start_cloud_stream(app: AppHandle, state: State<DictationState>) -> bool {
    // Capture, under one lock, the state we need to (a) decide whether to open a stream and
    // (b) safely install it after the blocking handshake. The Arcs are captured by IDENTITY so we
    // can later confirm (via ptr_eq) the session generation didn't change.
    let (cloud_slot, cloud_active, cloud_epoch, cloud_tx) = {
        let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if sess.cloud_active.load(Ordering::Relaxed) {
            return false; // idempotent — a repeated wake transition shouldn't open a second socket
        }
        // Warm reuse: a socket paused into standby by a recent stop-word stop is still open. If its
        // worker is alive, resume on it — no TLS+WS handshake, so dictation starts instantly. Done
        // entirely under the lock (resume() is just a non-blocking channel send). A lost liveness
        // race is safe: resuming a just-dead worker drops frames and its cloud-ended emit drives the
        // frontend back to on-device — the same recovery as any mid-stream death.
        {
            let cloud = sess.cloud.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(s) = cloud.as_ref() {
                if s.is_alive() {
                    s.resume();
                    sess.cloud_active.store(true, Ordering::Relaxed);
                    tracing::info!(target: "dictation", "reusing warm deepgram socket");
                    return true; // caller starts metering, exactly as for a fresh open
                }
            }
        }
        (
            sess.cloud.clone(),
            sess.cloud_active.clone(),
            sess.cloud_epoch.clone(),
            sess.cloud_tx.clone(),
        )
    };
    // Cloud dictation now runs through the orchestration relay on the user's Sparkle bearer (the
    // relay holds Sparkle's Deepgram key and meters server-side). setting_enabled is true here (the
    // frontend already gated on the live voice setting); a signed-out user has no bearer → stay
    // on-device. credits_ok is enforced by the relay (it refuses the upgrade when not entitled / can't
    // afford the first minute — a handshake failure we treat as fall-back-to-on-device), so we pass it
    // true here.
    //
    // CORRECTION (was: "this is a sync Tauri command (its own thread), so the keychain read is fine
    // inline"): it is NOT on its own thread. A sync `#[tauri::command]` is `ExecutionContext::Blocking`
    // in tauri-macros, which runs the body INLINE on the IPC/event-loop thread — the same mistake that
    // made `start_dictation` beachball the app for its whole first-run download. The keychain read is
    // sub-ms so it's harmless in practice, but the blocking `DeepgramSession::start` handshake below
    // (~hundreds of ms of TLS+WS) does stall the event loop on every wake transition. Left as-is
    // deliberately: fixing it means making this `async fn` + `spawn_blocking` like start_dictation,
    // which changes this command's own race semantics (the ptr_eq/epoch guards below) and belongs in
    // its own reviewable change, not smuggled into the start_dictation fix.
    let token = crate::auth::bearer_token();
    if choose_engine(true, token.is_some(), true) != Engine::Cloud {
        return false; // signed out → stay on the on-device model; don't consume an epoch on this path
    }
    let token = token.expect("choose_engine returned Cloud only when a bearer is present");
    let base_url = crate::auth::base_url();
    // Claim this attempt only now that we're committing to open. The epoch is an atomic token, so
    // bumping it outside the lock is sound — the post-handshake re-validation re-reads it under the
    // lock, and any racing stop/start that bumps it meanwhile correctly invalidates this attempt.
    let my_epoch = cloud_epoch.fetch_add(1, Ordering::Relaxed) + 1;
    match DeepgramSession::start(app, base_url, token) {
        Ok(session) => {
            // The handshake above is blocking (~hundreds of ms). Re-validate under the lock before
            // installing, so a stop/restart that raced the handshake can't leave an orphaned stream:
            //   - ptr_eq(cloud_active): the session generation is unchanged (no stop_dictation +
            //     start_dictation installed fresh Arcs while we were connecting — storing into our
            //     captured-but-now-stale Arc would orphan the worker against the new capture).
            //   - epoch unchanged: no stop_cloud_stream / stop_dictation / racing start happened on
            //     THIS session since we claimed our attempt (those all bump the epoch).
            //   - capture present & not already active: belt-and-suspenders for the same intent.
            let reject = {
                let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
                let install = should_install_cloud(
                    Arc::ptr_eq(&cloud_active, &sess.cloud_active),
                    cloud_epoch.load(Ordering::Relaxed) == my_epoch,
                    sess.capture.is_some(),
                    cloud_active.load(Ordering::Relaxed),
                );
                if install {
                    // Publish the detached audio sender BEFORE flipping cloud_active true, so the
                    // first frame the callback routes on the cloud path finds a live sender in the
                    // slot (mirrors `cloud`; cleared when the session is taken on stop). Set it
                    // while the session is still owned here (audio_sender() only clones the tx).
                    *cloud_tx.lock().unwrap_or_else(|p| p.into_inner()) = Some(session.audio_sender());
                    *cloud_slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(session);
                    cloud_active.store(true, Ordering::Relaxed); // callback now routes to Deepgram
                    None
                } else {
                    Some(session) // stopped/restarted during the handshake — don't install it
                }
            };
            match reject {
                None => true, // installed a live cloud socket → caller may start metering
                Some(s) => {
                    tracing::info!(target: "dictation", "discarding cloud stream opened during a stop/again race");
                    // finish() suppresses the worker's cloud-ended emit, so tearing down this orphan
                    // can't cross-talk into — and stop — the current healthy session.
                    s.finish(); // clean close + join (bounded); never leak the worker
                    false // not installed → caller must not bill
                }
            }
        }
        Err(e) => {
            // Offline / bad key / handshake failure → transparently keep using the on-device model.
            tracing::info!(target: "dictation", error = %e, "cloud stream unavailable; using on-device");
            false
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
        // two would drift.
        let keep_warm =
            should_standby_on_blur(was_active, cloud.as_ref().map(|s| s.is_alive()).unwrap_or(false));
        if keep_warm {
            // Warm standby: the session (and thus its sender in cloud_tx) is kept for reuse — leave
            // the slot as-is. cloud_active is already false, so the callback routes on-device and
            // won't touch the slot until a resume flips it back.
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

#[tauri::command]
pub fn stop_dictation(app: AppHandle, state: State<DictationState>) {
    let (transcriber, cloud_session, worker) = {
        let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
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
    use super::{AppHandle, State,
        capture_should_be_live, choose_engine, frame_speaking, park_cloud_for_blur, plan_capture,
        segment_fingerprint, should_emit_blur, should_install_cloud, should_resume_on_focus,
        should_standby_on_blur, start_after_load, unpark_cloud_for_focus, CapturePlan,
        DeepgramSession, DictationState, Engine, ReconcileStep, StartAfterLoad,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    #[test]
    fn frame_speaking_mirrors_vad_on_device_and_forces_true_on_cloud() {
        // On-device path (cloud off): the waveform's speaking signal is exactly the VAD flag, so
        // the meter freezes the instant the VAD stops hearing speech.
        assert!(!frame_speaking(false, false), "on-device + VAD silent → not speaking");
        assert!(frame_speaking(false, true), "on-device + VAD speech → speaking");
        // Cloud path: the on-device VAD isn't fed, so we report speaking regardless (the user is
        // actively dictating to the cloud). This also pins the edges around mode transitions: e.g.
        // a cloud→on-device switch while silent yields true→false (a falling edge that freezes the
        // meter), and on-device→cloud yields false→true (rising edge), via the != last_speaking diff.
        assert!(frame_speaking(true, false), "cloud → speaking even when the (unfed) VAD reads false");
        assert!(frame_speaking(true, true), "cloud → speaking");
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
    }

    impl Guards {
        /// `start_dictation`'s first critical section. `None` = the armed fast path (return at once,
        /// no load); `Some(epoch)` = the sampled stop epoch, carried across the slow load.
        fn begin_start(&self) -> Option<u64> {
            if self.armed {
                return None;
            }
            Some(self.stop_epoch)
        }

        /// `stop_dictation`: disarm AND advance the epoch.
        fn stop(&mut self) {
            self.armed = false;
            self.stop_epoch = self.stop_epoch.wrapping_add(1);
        }

        /// `start_dictation`'s second critical section, once its load returns.
        fn finish_start(&mut self, sampled: u64) -> StartAfterLoad {
            let decision = start_after_load(sampled, self.stop_epoch, self.armed);
            if decision == StartAfterLoad::Arm {
                self.armed = true;
            }
            decision
        }
    }

    /// Two rapid mic clicks. Newly reachable: with the load off-thread, B's first critical section
    /// runs while A is still downloading — and since A hasn't armed yet, B does NOT take the fast
    /// path and starts its own load (model.rs's temp-dir sweep spares concurrent downloads for
    /// exactly this reason). Whichever finishes second must find the session already armed and
    /// DISCARD its transcriber rather than overwrite a live one without finalize().
    #[test]
    fn two_concurrent_starts_arm_exactly_once() {
        let mut g = Guards::default();
        let a = g.begin_start().expect("nothing armed yet, so A loads");
        let b = g.begin_start().expect("A is still loading and hasn't armed, so B loads too");
        assert_eq!(a, b, "both sampled the same epoch; no stop has happened");

        assert_eq!(g.finish_start(a), StartAfterLoad::Arm, "the first to finish arms");
        assert_eq!(
            g.finish_start(b),
            StartAfterLoad::AlreadyArmed,
            "the second must NOT overwrite the live transcriber — no double-arm"
        );
        assert!(g.armed, "and the session ends armed exactly once");
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

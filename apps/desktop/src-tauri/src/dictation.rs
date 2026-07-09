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
        let desired = capture_should_be_live(sess.armed, sess.focused);
        if desired && sess.capture.is_none() {
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
                        tracing::info!(target: "dictation", "capture resumed (window focused)");
                    }
                    Err(e) => {
                        let _ = app.emit("dictation://error", e);
                    }
                }
            }
        } else if !desired && sess.capture.is_some() {
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
            tracing::info!(target: "dictation", "capture paused (window unfocused or muted)");
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

#[tauri::command]
pub fn start_dictation(app: AppHandle, state: State<DictationState>) -> Result<(), String> {
    // "Arm" the mic. The cpal capture itself is gated on focus by reconcile_locked: it comes up now
    // only if a Sparkle window is the active OS window, and is (re)built later by the focus event.
    //
    // Fast path: already armed (e.g. a second window mounting, or a re-arm after this window was the
    // first). Don't reload the model or swap the cloud Arcs — just refresh focus and reconcile so a
    // capture paused while unfocused resumes. This also preserves the old double-start guarantee:
    // we never drop a live transcriber without finalize().
    //
    // While here (and still holding the lock), sample the stop epoch so we can detect a
    // stop_dictation that lands during the slow model load below (the "resurrect" race).
    let stop_epoch_at_start = {
        let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if sess.armed {
            sess.focused = any_window_focused(&app);
            DictationState::reconcile_locked(&mut sess, &app);
            return Ok(());
        }
        sess.stop_epoch
    };

    // Not yet armed: load the on-device model (slow, no lock held) before claiming the session.
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    let app_for_progress = app.clone();
    let paths = model::ensure(&root, move |done, total| { let _ = app_for_progress.emit("dictation://model-progress", (done, total)); })?;
    let transcriber = Arc::new(Mutex::new(ParakeetTdt::new(&paths)?));

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
            // reconcile rather than overwriting the live one without finalize().
            sess.focused = any_window_focused(&app);
            DictationState::reconcile_locked(&mut sess, &app);
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
    sess.focused = any_window_focused(&app);
    // Builds the capture now iff a window is focused; otherwise the focus event brings it up later.
    DictationState::reconcile_locked(&mut sess, &app);
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
    // true here. This is a sync Tauri command (its own thread), so the keychain read is fine inline.
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
        let keep_warm = was_active && cloud.as_ref().map(|s| s.is_alive()).unwrap_or(false);
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
    use super::{
        capture_should_be_live, choose_engine, frame_speaking, segment_fingerprint,
        should_emit_blur, should_install_cloud, start_after_load, DictationState, Engine,
        StartAfterLoad,
    };

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

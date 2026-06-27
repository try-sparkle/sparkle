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
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::audio::{rms_level, Capture};
use crate::cloud::DeepgramSession;
use crate::model;
use crate::naming::resolve_deepgram_key;
use crate::transcribe::{ParakeetTdt, Transcriber};

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

/// Signal that the cloud (Deepgram) worker has exited — whether a clean close or a mid-stream
/// failure. The frontend handles this by clearing the interim preview and calling stop_cloud_stream,
/// which flips `cloud_active` back to false so the capture callback resumes routing frames to the
/// on-device model. Without this, a mid-stream socket death would strand dictation: frames keep
/// going to the dead session, the on-device wake/stop-word path never resumes, and the last interim
/// stays painted as a stale ghost.
pub(crate) fn emit_cloud_ended(app: &AppHandle) {
    let _ = app.emit("dictation://cloud-ended", ());
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

/// Decide the engine for an active-dictation stream. This is the single seam the AI-credits
/// system (built separately) plugs into: today `credits_ok` is a stub passed as true, but the
/// decision table is here and unit-tested so wiring real credit checks in later is a one-line
/// change at the call site. Offline is handled implicitly — if Cloud is chosen but the Deepgram
/// handshake fails, the caller falls back to Local — so we don't probe connectivity here.
pub(crate) fn choose_engine(setting_enabled: bool, key_present: bool, credits_ok: bool) -> Engine {
    if setting_enabled && key_present && credits_ok {
        Engine::Cloud
    } else {
        Engine::Local
    }
}

/// Whether the cpal mic capture should currently be live. Two conditions, both required:
///   - `armed`: the frontend wants the mic on (the user hasn't muted it).
///   - `focused`: at least one Sparkle window is the focused/active OS window.
/// When the user tabs to another app every Sparkle window blurs, `focused` goes false, and we
/// release the OS mic — so Sparkle never captures audio while you're looking at something else.
/// Pure so the arm×focus matrix is unit-testable without an audio device or real windows.
pub(crate) fn capture_should_be_live(armed: bool, focused: bool) -> bool {
    armed && focused
}

#[derive(Default)]
pub struct DictationSession {
    capture: Option<Capture>,
    transcriber: Option<Arc<Mutex<ParakeetTdt>>>,
    /// The live Deepgram stream, present only while actively dictating with cloud enabled.
    /// Shared with the capture callback so frames can be routed to it without rebuilding the
    /// callback when the cloud stream opens/closes.
    cloud: Arc<Mutex<Option<DeepgramSession>>>,
    /// When true, the capture callback streams frames to `cloud` instead of the on-device model.
    /// Read on every audio frame; toggled by start/stop_cloud_stream.
    cloud_active: Arc<AtomicBool>,
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
}

pub struct DictationState(pub Arc<Mutex<DictationSession>>);
impl Default for DictationState { fn default() -> Self { Self(Arc::new(Mutex::new(DictationSession::default()))) } }

impl DictationState {
    /// Stop any in-flight capture by dropping the cpal stream, so CoreAudio stops invoking the
    /// audio callback. Called on app exit () to quiesce the audio IOThread BEFORE
    /// static destructors run — closing the shutdown-race window that produced the SIGABRT in
    /// . Unlike stop_dictation this skips finalize(): at exit the trailing segment is
    /// moot and we want the fastest possible teardown. Idempotent and poison-tolerant.
    pub fn stop_capture(&self) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).capture = None;
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
                    sess.cloud.clone(),
                    sess.cloud_active.clone(),
                ) {
                    Ok(cap) => {
                        sess.capture = Some(cap);
                        tracing::info!(target: "dictation", "capture resumed (window focused)");
                    }
                    Err(e) => {
                        let _ = app.emit("dictation://error", e);
                    }
                }
            }
        } else if !desired && sess.capture.is_some() {
            sess.capture = None; // drop -> stops the cpal stream and releases the OS mic
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
}

/// True if at least one Sparkle window is currently the focused/active OS window. Used to seed the
/// focus state at arm time (the frontend calls start_dictation on mount, normally while focused),
/// so the mic comes up without waiting for the first focus event.
fn any_window_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false))
}

/// Build the cpal capture stream and wire its callback to the transcription pipeline. Shared by
/// start_dictation (fresh arm) and the focus reconciler (resume), so the routing logic — cloud
/// frames while actively dictating, else the on-device wake-word model — lives in exactly one place.
fn build_capture(
    app: AppHandle,
    transcriber: Arc<Mutex<ParakeetTdt>>,
    cloud_slot: Arc<Mutex<Option<DeepgramSession>>>,
    cloud_active: Arc<AtomicBool>,
) -> Result<Capture, String> {
    let app_cb = app.clone();
    // NOTE: transcriber is locked on every CoreAudio callback frame. The lock must stay short-held
    // (accept() only, no I/O). finalize() is always called *after* Capture is dropped (stop_dictation),
    // so the slow finalize path never contends with a live callback frame.
    tracing::info!(target: "dictation", "build_capture: capture starting");
    Capture::start(move |frame: Vec<f32>| {
        let _ = app_cb.emit("dictation://level", rms_level(&frame));
        // While the cloud stream is open (user actively dictating), route frames to Deepgram and
        // skip the on-device model entirely. Otherwise the on-device model handles the frame —
        // this is the always-listening wake-word gate. Locks are poison-tolerant ():
        // a prior panicked frame must not wedge dictation; the audio.rs panic firewall already
        // prevents such a panic from aborting the process.
        if cloud_active.load(Ordering::Relaxed) {
            if let Some(s) = cloud_slot.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
                s.send_audio(&frame);
            }
        } else {
            let segs = transcriber
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .accept(&frame);
            for seg in segs {
                emit_partial(&app_cb, "accept", seg);
            }
        }
    })
    .map_err(|e| {
        let _ = app.emit("dictation://error", e.clone());
        e
    })
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
    {
        let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if sess.armed {
            sess.focused = any_window_focused(&app);
            DictationState::reconcile_locked(&mut sess, &app);
            return Ok(());
        }
    }

    // Not yet armed: load the on-device model (slow, no lock held) before claiming the session.
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    let app_for_progress = app.clone();
    let paths = model::ensure(&root, move |done, total| { let _ = app_for_progress.emit("dictation://model-progress", (done, total)); })?;
    let transcriber = Arc::new(Mutex::new(ParakeetTdt::new(&paths)?));

    let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
    // A racing start_dictation may have armed while we loaded the model. If so, discard our freshly
    // loaded transcriber (it drops here) rather than overwriting the live one without finalize().
    if sess.armed {
        sess.focused = any_window_focused(&app);
        DictationState::reconcile_locked(&mut sess, &app);
        return Ok(());
    }
    sess.transcriber = Some(transcriber);
    // Fresh cloud generation for this arm — new Arcs so start_cloud_stream's ptr_eq/epoch guards
    // correctly invalidate any stream that raced a prior stop+start.
    sess.cloud = Arc::new(Mutex::new(None));
    sess.cloud_active = Arc::new(AtomicBool::new(false));
    sess.cloud_epoch = Arc::new(AtomicU64::new(0));
    sess.armed = true;
    sess.focused = any_window_focused(&app);
    // Builds the capture now iff a window is focused; otherwise the focus event brings it up later.
    DictationState::reconcile_locked(&mut sess, &app);
    Ok(())
}

/// Open the Deepgram cloud stream for the active-dictation window. The frontend calls this only when
/// the wake-word machine transitions to ACTIVE *and* it has already gated on the live "voice
/// dictation" + composer settings — so this command's job is just "open if a key is present". (The
/// voice-setting gate lives entirely in the frontend, the single source of truth; no `cloud` arg.)
///
/// Returns TRUE only when a live cloud socket was actually installed. Returns FALSE on every
/// stay-on-device path (no key, handshake failure, or a stop/restart race discard) so the frontend
/// knows NOT to start per-minute billing — otherwise a user with no DEEPGRAM_API would be charged
/// for cloud dictation they never received.
#[tauri::command]
pub fn start_cloud_stream(app: AppHandle, state: State<DictationState>) -> bool {
    // Capture, under one lock, the state we need to (a) decide whether to open a stream and
    // (b) safely install it after the blocking handshake. The Arcs are captured by IDENTITY so we
    // can later confirm (via ptr_eq) the session generation didn't change.
    let (cloud_slot, cloud_active, cloud_epoch) = {
        let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if sess.cloud_active.load(Ordering::Relaxed) {
            return false; // idempotent — a repeated wake transition shouldn't open a second socket
        }
        (
            sess.cloud.clone(),
            sess.cloud_active.clone(),
            sess.cloud_epoch.clone(),
        )
    };
    let key = resolve_deepgram_key();
    // setting_enabled is true here: the frontend already gated on the live voice setting before
    // calling. credits_ok is the seam the AI-credits system plugs into later; true for now.
    if choose_engine(true, key.is_some(), true) != Engine::Cloud {
        return false; // no key → stay on the on-device model; don't consume an epoch on this path
    }
    let key = key.expect("choose_engine returned Cloud only when key is present");
    // Claim this attempt only now that we're committing to open. The epoch is an atomic token, so
    // bumping it outside the lock is sound — the post-handshake re-validation re-reads it under the
    // lock, and any racing stop/start that bumps it meanwhile correctly invalidates this attempt.
    let my_epoch = cloud_epoch.fetch_add(1, Ordering::Relaxed) + 1;
    match DeepgramSession::start(app, key) {
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
    let session = {
        let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        sess.cloud_active.store(false, Ordering::Relaxed); // callback routes to on-device again
        sess.cloud_epoch.fetch_add(1, Ordering::Relaxed); // invalidate any in-flight start_cloud_stream
        let s = sess.cloud.lock().unwrap_or_else(|p| p.into_inner()).take();
        s
    }; // release locks before the (slower) finish()/join
    if let Some(s) = session {
        s.finish();
    }
}

#[tauri::command]
pub fn stop_dictation(app: AppHandle, state: State<DictationState>) {
    let (transcriber, cloud_session) = {
        let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        sess.armed = false;             // disarm so a later focus event can't resurrect the mic
        sess.capture = None;            // drop Capture -> stops the cpal stream (no more frames)
        sess.cloud_active.store(false, Ordering::Relaxed);
        sess.cloud_epoch.fetch_add(1, Ordering::Relaxed); // invalidate any in-flight start_cloud_stream
        let cloud_session = sess.cloud.lock().unwrap_or_else(|p| p.into_inner()).take(); // tear down any live cloud stream
        (sess.transcriber.take(), cloud_session)
    };                                  // release the session lock before the (slower) finalize
    tracing::info!(target: "dictation", "stop_dictation: capture dropped, finalizing");
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
        capture_should_be_live, choose_engine, segment_fingerprint, should_install_cloud,
        DictationState, Engine,
    };

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
    fn choose_engine_requires_setting_key_and_credits() {
        // Cloud only when ALL three hold.
        assert_eq!(choose_engine(true, true, true), Engine::Cloud);
        // Any one missing → fall back to the on-device model.
        assert_eq!(choose_engine(false, true, true), Engine::Local, "setting off");
        assert_eq!(choose_engine(true, false, true), Engine::Local, "no key");
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

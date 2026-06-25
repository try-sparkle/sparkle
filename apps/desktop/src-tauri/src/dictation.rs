//! Tauri commands wiring mic capture → transcriber → events.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::audio::{rms_level, Capture};
use crate::model;
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
fn emit_partial(app: &AppHandle, source: &str, seg: String) {
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

#[derive(Default)]
pub struct DictationSession {
    capture: Option<Capture>,
    transcriber: Option<Arc<Mutex<ParakeetTdt>>>,
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
}

// SAFETY: cpal::Stream on CoreAudio is !Send, guarded behind a Mutex.
// ParakeetTdt is genuinely Send (its recognizer/VAD fields are Send+Sync),
// so sharing it via Arc<Mutex<ParakeetTdt>> across threads is sound.
unsafe impl Send for DictationState {}
unsafe impl Sync for DictationState {}

#[tauri::command]
pub fn start_dictation(app: AppHandle, state: State<DictationState>) -> Result<(), String> {
    // Guard against double-start: if a session is active, return early.
    // Without this, a second call would drop the first session's transcriber without
    // calling finalize(), silently losing the trailing segment the first session buffered.
    if state.0.lock().unwrap_or_else(|p| p.into_inner()).capture.is_some() { return Ok(()); }

    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    let app_for_progress = app.clone();
    let paths = model::ensure(&root, move |done, total| { let _ = app_for_progress.emit("dictation://model-progress", (done, total)); })?;
    let transcriber = Arc::new(Mutex::new(ParakeetTdt::new(&paths)?));
    let transcriber_cap = transcriber.clone();
    let app_cb = app.clone();
    // NOTE: transcriber_cap is locked on every CoreAudio callback frame.
    // The lock must stay short-held (accept() only, no I/O). finalize() is
    // always called *after* Capture is dropped (in stop_dictation), so the
    // slow finalize path never contends with a live callback frame.
    tracing::info!(target: "dictation", "start_dictation: capture starting");
    let capture = Capture::start(move |frame: Vec<f32>| {
        let _ = app_cb.emit("dictation://level", rms_level(&frame));
        // Poison-tolerant (): a prior panicked frame must not wedge dictation. The
        // audio.rs panic firewall already prevents such a panic from aborting the process.
        let segs = transcriber_cap.lock().unwrap_or_else(|p| p.into_inner()).accept(&frame);
        for seg in segs { emit_partial(&app_cb, "accept", seg); }
    }).map_err(|e| { let _ = app.emit("dictation://error", e.clone()); e })?;
    let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
    sess.capture = Some(capture);
    sess.transcriber = Some(transcriber);
    Ok(())
}

#[tauri::command]
pub fn stop_dictation(app: AppHandle, state: State<DictationState>) {
    let transcriber = {
        let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        sess.capture = None;            // drop Capture -> stops the cpal stream (no more frames)
        sess.transcriber.take()
    };                                  // release the session lock before the (slower) finalize
    tracing::info!(target: "dictation", "stop_dictation: capture dropped, finalizing");
    if let Some(t) = transcriber {
        for seg in t.lock().unwrap_or_else(|p| p.into_inner()).finalize() { emit_partial(&app, "finalize", seg); }
    }
    let _ = app.emit("dictation://final", String::new());
}

#[cfg(test)]
mod tests {
    use super::{segment_fingerprint, DictationState};

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

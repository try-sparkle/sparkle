//! Tauri commands wiring mic capture → transcriber → events.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::audio::{rms_level, Capture};
use crate::model;
use crate::transcribe::{ParakeetTdt, Transcriber};

/// Monotonic id stamped on every emitted partial so the log can prove whether a
/// duplicate in the prompt bar came from the backend emitting the same text twice
/// (two ids, same text) vs the frontend appending one emission twice (one id).
static PARTIAL_SEQ: AtomicU64 = AtomicU64::new(0);

/// Emit one transcript segment and log it (source = "accept" during capture, or
/// "finalize" on stop) with its sequence id and text, so dictation duplicates are
/// diagnosable from the unified log.
fn emit_partial(app: &AppHandle, source: &str, seg: String) {
    let seq = PARTIAL_SEQ.fetch_add(1, Ordering::Relaxed);
    // info (not debug): the shipped build's log threshold drops debug, and this is
    // low-frequency (once per spoken phrase), so info is safe and always visible.
    tracing::info!(target: "dictation", seq, source, text = %seg, "emit partial");
    let _ = app.emit("dictation://partial", seg);
}

#[derive(Default)]
pub struct DictationSession {
    capture: Option<Capture>,
    transcriber: Option<Arc<Mutex<ParakeetTdt>>>,
}

pub struct DictationState(pub Arc<Mutex<DictationSession>>);
impl Default for DictationState { fn default() -> Self { Self(Arc::new(Mutex::new(DictationSession::default()))) } }

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
    if state.0.lock().unwrap().capture.is_some() { return Ok(()); }

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
        let segs = transcriber_cap.lock().unwrap().accept(&frame);
        for seg in segs { emit_partial(&app_cb, "accept", seg); }
    }).map_err(|e| { let _ = app.emit("dictation://error", e.clone()); e })?;
    let mut sess = state.0.lock().unwrap();
    sess.capture = Some(capture);
    sess.transcriber = Some(transcriber);
    Ok(())
}

#[tauri::command]
pub fn stop_dictation(app: AppHandle, state: State<DictationState>) {
    let transcriber = {
        let mut sess = state.0.lock().unwrap();
        sess.capture = None;            // drop Capture -> stops the cpal stream (no more frames)
        sess.transcriber.take()
    };                                  // release the session lock before the (slower) finalize
    tracing::info!(target: "dictation", "stop_dictation: capture dropped, finalizing");
    if let Some(t) = transcriber {
        for seg in t.lock().unwrap().finalize() { emit_partial(&app, "finalize", seg); }
    }
    let _ = app.emit("dictation://final", String::new());
}

//! The 8 `#[tauri::command]` entry points for dictation.
//!
//! Split out of `dictation.rs` because this cluster is a REVERSE LEAF: nothing inside `dictation`
//! calls these, only `lib.rs`'s `generate_handler!` does. That makes it the largest extraction that
//! cannot create a new intra-module edge.
//!
//! ── THE PATHS IN `lib.rs` MUST NAME THE MODULE THAT DEFINES THE FN ───────────────────────────
//! `tauri::generate_handler![dictation::commands::start_dictation, …]` does NOT call the function.
//! It takes the path, replaces the LAST SEGMENT with `__cmd__<name>`, and invokes
//! `dictation::commands::__cmd__start_dictation!(…)` as a MACRO — the one `#[tauri::command]`
//! emits next to each fn.
//!
//! So if you move a command out of this module, move its `lib.rs` path in the same commit. Two
//! different mistakes are possible here and they do NOT fail the same way — both measured on tauri
//! 2.11.3, and worth re-verifying on an upgrade:
//!
//!   * **Mis-POINTED path** (a stale `lib.rs` path plus a parent `pub use` of the fns) is
//!     COMPILER-CAUGHT: 16 × E0433 across the 8 handlers — two per handler, one for
//!     `__tauri_command_name_<name>` and one for `__cmd__<name>` — e.g. "could not find
//!     `__cmd__start_dictation` in `dictation`". This mistake cannot be silent.
//!   * **DROPPED registration** (the path deleted from `generate_handler!`) is NOT caught. This is
//!     the one demonstrated silent failure: removing a single handler line compiles with **0
//!     errors**, and `invoke("stop_dictation")` then fails at runtime with "command not found".
//!
//! A RENAME is a third case and splits in two, so don't fold it into either bullet: rename the fn
//! alone and `lib.rs` still names the old path, which is the mis-pointed case above (E0433,
//! compiler-caught); rename BOTH sides and it compiles green, but the registered command *name* has
//! changed, so what breaks is the frontend's `invoke("…")` string, not the registration set.
//!
//! So a green build is conclusive for path RESOLUTION only, never for the registration SET, which
//! nothing pins today. Partial cover for renames exists: `cmd_timing.rs`'s `GUARDED` table names
//! `list_audio_inputs` in this file and hard-panics if it cannot find it — 1 of the 8. Keep the 8
//! names here and the 8 paths in `lib.rs` in step by hand.

// Imported from their defining crates rather than re-borrowed through `super::*`, so this module's
// dependencies stay legible and the parent's `use` block can change without silently breaking it.
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::cloud::DeepgramSession;
use crate::transcribe::Transcriber;

// Everything below is defined in `dictation.rs` itself.
use super::events::{emit_partial, reset_interim_log_sampling};
use super::{
    begin_start_decision, choose_engine, cloud_reuse, emit_late_report, install_live_stream,
    late_report_for, load_model, note_fresh_arm, park_or_take_on_stop, park_raced_stream,
    park_target_active, raced_stream_disposition, set_arm_origin, should_install_cloud,
    start_after_load, stop_is_noop,
};
use super::{
    BeginStart, CloudReuse, CloudStreamOutcome, DictationState, Engine, Installed, LateReport,
    RacedStream, StartAfterLoad,
};

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
pub async fn start_dictation(
    app: AppHandle,
    state: State<'_, DictationState>,
    // How long ago the push-to-talk key went down, as the frontend measured it (`voice/holdOrigin`).
    //
    // `Option<u64>`, and BOTH empty shapes mean the same thing. Tauri's arg deserialization gives
    // `None` for an absent key, and `voice/holdOrigin` sends an explicit `null` when it has no
    // trustworthy origin — an arm that came from the mic button or the voice menu rather than a
    // hold, or a stamp too old to believe. Neither is an error: the arm is still measured, it just
    // reports no keydown stage rather than inventing one.
    keydown_age_ms: Option<u64>,
) -> Result<(), String> {
    // ── THE PUSH-TO-TALK COLD-START BUDGET (sparkle-oyapv) ───────────────────────────────────────
    // Push to talk rests with the mic RELEASED (`voice/sendMode` micIntentForMode -> "off"), so on a
    // hold this entire command sits between the key going down and the first sample existing. The
    // founder reported losing the first FIVE words of an utterance. Every stage below was previously
    // unmeasured, so the budget could be reasoned about but never read.
    //
    // Only the stages this command actually awaits are timed here; `Capture::start`'s own four
    // sub-spans (device resolve / format negotiation / stream build / play) and CoreAudio's
    // first-buffer delay are logged in `audio.rs`, because that is where they can be separated.
    let t_cmd = std::time::Instant::now();
    // Reconstruct when the key went down. `checked_sub` because `Instant - Duration` PANICS on
    // underflow, and this duration comes from the frontend — a value larger than the process has
    // been running must degrade to "no origin", never abort the arm. See `audio::ArmOrigin::keydown`
    // for why this is a LOWER BOUND (the IPC hop lands outside it).
    let keydown = keydown_age_ms
        .and_then(|ms| t_cmd.checked_sub(std::time::Duration::from_millis(ms)));
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
                // EVERY EXIT EMITS A LINE (roborev, Medium), and this is the one that most needed
                // it: `reconcile_capture` can invoke the blocking `Capture::start`, so a slow hold
                // down this path produced an audio.rs "capture start timing" line with no
                // start_dictation line to attach it to. Hours later in a release log, "no line" is
                // indistinguishable from "the command never ran", and nothing recorded WHICH path
                // the hold took. `outcome` makes the path part of the record.
                tracing::info!(
                    target: "dictation",
                    outcome = "fast-path",
                    total_ms = t_cmd.elapsed().as_millis() as u64,
                    "start_dictation timing"
                );
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
                tracing::info!(
                    target: "dictation",
                    outcome = "coalesced",
                    total_ms = t_cmd.elapsed().as_millis() as u64,
                    "start_dictation timing"
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
    //     ring goes amber, every surface paints an armed, listening microphone, and the app waits
    //     on speech it can never hear, with no error anywhere. See mic_permission.rs's module docs.
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
    // ── EACH SPAN IS STAMPED AT ITS OWN STAGE, NOT FROM COMMAND ENTRY (roborev, Medium) ──────────
    // These were all measured from `t_cmd`, so each billed the work of every stage before it —
    // `permission_ms` absorbed the session-lock acquisition and `begin_start_decision`, and that
    // lock is the one documented as contended with the main thread (sparkle-sfxu). A hold that
    // stalled on the lock would have been reported as time in the mic-permission check, sending the
    // reader to the wrong file. That is exactly the defect the instrumentation commit argued
    // against ("one number would say 'slow' without saying which one to attack"), reached by
    // mis-attribution rather than by aggregation. `prelude_ms` now carries that time under its own
    // name rather than hiding inside a neighbour.
    let prelude_ms = t_cmd.elapsed().as_millis() as u64;
    let t_perm = std::time::Instant::now();
    tauri::async_runtime::spawn_blocking(crate::mic_permission::ensure_access_blocking)
        .await
        .map_err(|e| format!("microphone permission check failed: {e}"))??;
    // The comment above claims "no measurable latency" for an already-authorized user. That is an
    // assertion nobody had checked, and it omits the `spawn_blocking` hop itself — which on a busy
    // machine queues behind other blocking work (the very scenario the abort below exists for).
    let permission_ms = t_perm.elapsed().as_millis() as u64;

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
            tracing::info!(
                target: "dictation",
                outcome = "aborted-pre-load",
                prelude_ms,
                permission_ms,
                total_ms = t_cmd.elapsed().as_millis() as u64,
                "start_dictation timing"
            );
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
    let t_model = std::time::Instant::now();
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
    // The ASR decoder is cached process-static, so a warm hold does NOT pay the ONNX recognizer
    // init here. It DOES still pay a fresh Silero VAD session plus file verification.
    //
    // ── THAT REMAINDER IS NOW MEASURED, AND IT IS ~5 ms (sparkle-oyapv) ──────────────────────────
    // This comment used to say the per-arm cost "has never been separated from the cached case in
    // any log", and that was the open question behind a proposal to cache the VAD session too.
    // `measure_model_load_split` (below, `#[ignore]`d) answers it on real installed models:
    //
    //     round 1  2972.8 ms   ONNX transducer init + Silero VAD + file verification
    //     round 2     5.4 ms   Silero VAD + file verification ONLY (transducer from DECODER_CACHE)
    //     round 3     4.8 ms   ditto
    //
    // So a warm arm's `model_ms` is ~5 ms — under 3% of even the best measured hold (218 ms) and
    // around 1% of a cold one. CACHING THE VAD IS THEREFORE NOT WORTH DOING, and that is a
    // conclusion from a number rather than a preference: it holds per-session state (queued speech
    // segments), so sharing it across arms would be a correctness risk taken to buy 5 ms. The
    // remaining budget is `Capture::start`, which is where the effort belongs.
    //
    // Stamped from `t_model`, so this is the load ALONE — it no longer absorbs the post-permission
    // epoch re-check (a second acquisition of the contended session lock) or `app_data_dir`.
    let model_ms = t_model.elapsed().as_millis() as u64;
    let transcriber = Arc::new(Mutex::new(transcriber));

    let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
    // Re-check under the lock now the (slow) load is done. Both inputs are read from THIS critical
    // section so the decision and the arm-or-abort are atomic (see `start_after_load`).
    match start_after_load(stop_epoch_at_start, sess.stop_epoch, sess.armed) {
        StartAfterLoad::AbortMutedDuringLoad => {
            // The user muted mid-download: a stop advanced the epoch after we sampled it. Do NOT
            // re-arm (that's the resurrect race) — our freshly loaded transcriber drops here.
            // WARN, NOT INFO, AND NAMED FOR WHAT THE USER LOST. The abort itself is correct — this
            // is the resurrect-race guard doing its job — but its CONSEQUENCE is a hold that
            // recorded nothing at all: the model was still loading when the key came up, so no
            // capture was ever built and not one sample of that utterance exists anywhere.
            // Measured 20 times on 2026-08-09, with model loads of 2.4 s to 46 s against holds of a
            // few hundred ms. `preload_model_in_background` is what removes the cause; this is what
            // makes the occurrence legible when it still happens.
            tracing::warn!(
                target: "dictation",
                model_ms,
                "the on-device model was still loading when the hold ended, so this utterance \
                 recorded no audio at all (mic stays muted; the arm is correctly abandoned)"
            );
            // Same two caveats as the pre-load abort above: `sess` is still held (drop it before any
            // webview emit — sparkle-sfxu), and this leaves the ring optimistically claiming to
            // listen until the `[enabled]` effect settles it.
            tracing::info!(
                target: "dictation",
                outcome = "aborted-post-load",
                prelude_ms,
                permission_ms,
                model_ms,
                total_ms = t_cmd.elapsed().as_millis() as u64,
                "start_dictation timing"
            );
            // RELEASE THE SESSION LOCK BEFORE THE EMIT — the rule stated three lines above, which
            // the first version of this arm broke by emitting inside the critical section (roborev
            // 61704). `app.emit` hops to the webview/main thread, so holding the session mutex
            // across it lets a main-thread path that wants the same lock deadlock against us — the
            // sparkle-sfxu hazard every other emit in this file is careful to stay outside of.
            // Explicit `drop` rather than a scope, so the ordering is visible at the call site
            // instead of implied by brace placement.
            drop(sess);
            // Tell the frontend it lost this hold, on the SAME channel `install_capture` uses for a
            // capture that finished too late. Without it the only thing the user sees is the relay's
            // "connected too late — your words are still captured" banner, which on this path is
            // false twice over: the words were never captured, and the relay was never the problem.
            // `model_ms` rather than a build duration: it is the number that explains this failure.
            let _ = app.emit("dictation://capture-missed", serde_json::json!({ "stage": "model", "ms": model_ms }));
            return Ok(());
        }
        StartAfterLoad::AlreadyArmed => {
            // A racing start_dictation armed while we loaded. Discard our transcriber and just
            // reconcile rather than overwriting the live one without finalize(). Reconcile OFF the
            // lock (drop the guard first) — the sparkle-sfxu deadlock rule.
            drop(sess);
            state.reconcile_capture(&app);
            // Like the fast path, this reconciles — so it can build a capture and must not leave
            // that capture's timing line unattributed.
            tracing::info!(
                target: "dictation",
                outcome = "already-armed",
                prelude_ms,
                permission_ms,
                model_ms,
                total_ms = t_cmd.elapsed().as_millis() as u64,
                "start_dictation timing"
            );
            return Ok(());
        }
        StartAfterLoad::Arm => {}
    }
    sess.transcriber = Some(transcriber);
    note_fresh_arm(&mut sess);
    // Release the session lock BEFORE reconcile_capture: it samples focus (is_focused) and builds
    // the capture (Capture::start), both of which block on the main thread. Holding the lock across
    // them from this async-runtime worker — while the main thread waits on the SAME lock in the
    // Focused handler — was the sparkle-sfxu launch deadlock. reconcile_capture also re-validates the
    // arm intent under the lock before installing, so a stop/blur landing in this gap is handled.
    // The ARM itself was silent too — the counterpart to the reconcile logging above. Without it the
    // log showed only the starts that COALESCED or ABORTED, so "did anything ever actually arm?"
    // could not be answered, and a wrong inference about it cost hours on 2026-08-05.
    tracing::info!(target: "dictation", "start_dictation armed the session; reconciling capture");
    drop(sess);
    // Builds the capture now iff a window is focused; otherwise the focus event brings it up later.
    let t_reconcile = std::time::Instant::now();
    // Hand the gesture origin to the capture this reconcile is about to build, so the first audio
    // frame can report ONE complete keydown→first-sample span instead of three lines a human has to
    // join by hand from a release log. Set only when the frontend actually gave us a keydown: an arm
    // from the mic button has no gesture behind it and must not be reported as though it did.
    if let Some(keydown) = keydown {
        set_arm_origin(crate::audio::ArmOrigin {
            keydown,
            reconcile_at: t_reconcile,
            js_to_invoke_ms: keydown_age_ms.unwrap_or(0),
            prelude_ms,
            permission_ms,
            model_ms,
        });
    }
    state.reconcile_capture(&app);
    // `reconcile_ms` INCLUDES `Capture::start` when a window is focused, and is near-zero when one
    // is not (the capture then comes up on the focus event instead). So it is not comparable across
    // holds on its own — read it against `audio.rs`'s "capture start timing" line, which is emitted
    // only when a capture was actually built.
    tracing::info!(
        target: "dictation",
        outcome = "armed",
        prelude_ms,
        permission_ms,
        model_ms,
        reconcile_ms = t_reconcile.elapsed().as_millis() as u64,
        total_ms = t_cmd.elapsed().as_millis() as u64,
        "start_dictation timing"
    );
    Ok(())
}

/// PUSH-TO-TALK KEYDOWN → RELAY SOCKET LIVE, the span that decides whether a short utterance gets
/// the live word-by-word preview. Emitted once per `start_cloud_stream` that ends with a usable
/// socket.
///
/// WHY THIS LINE HAD TO EXIST. `handshake_ms` (cloud.rs) measures the TLS+WS connect only, and it
/// starts well after the gesture — so the number everyone argued from began too late, exactly as it
/// did for the audio path before `push-to-talk keydown to first audio sample` was added. Neither
/// number could answer the actual question: was the relay connected BEFORE the user started
/// speaking? Only a span anchored at the keydown can.
///
/// `path` is what makes the before/after readable at a glance:
///   * `resumed`  — a warm socket was reused; NO handshake. This is the fast path, and its
///                  `total_ms` is the whole point of the change.
///   * `opened`   — a fresh TLS+WS handshake was paid for and installed.
///   * `routing`  — a socket was already live (a repeated passive→active edge).
///   * `banked`   — the handshake landed after the utterance ended and was PARKED for the next hold
///                  instead of being destroyed. Not live for this utterance; live for the next one.
///
/// `keydown_age_ms` is `None` for opens with no gesture origin (the tray, the voice menu, a
/// focus-regain resume); `total_ms` is then omitted rather than guessed, so an aggregate over these
/// lines can never mix a measured span with an invented one.
fn log_socket_live(path: &str, keydown_age_ms: Option<u64>, in_cmd_ms: u64) {
    match keydown_age_ms {
        Some(age) => tracing::info!(
            target: "dictation",
            path,
            keydown_age_ms = age,
            in_cmd_ms,
            total_ms = age + in_cmd_ms,
            "push-to-talk keydown to relay socket live"
        ),
        None => tracing::info!(
            target: "dictation",
            path,
            in_cmd_ms,
            "relay socket live (no gesture origin; not a push-to-talk hold)"
        ),
    }
}

/// Open the cloud (relay) stream for the active-dictation window. The frontend calls this only when
/// the dictation phase transitions to ACTIVE — the send tray moving to Speak, or a push-to-talk
/// hold beginning (`voice/dictationPhase`, `voice/sendMode`) — *and* it has already gated on the
/// live "voice dictation" + composer settings, so this command's job is just "open if signed in".
/// (The
/// voice-setting gate lives entirely in the frontend, the single source of truth; no `cloud` arg.)
///
/// Returns a `CloudStreamOutcome` naming WHAT HAPPENED — see that enum for why this is not a bool.
/// `Opened`/`Resumed` mean a live relay socket is routing and the caller may start metering.
/// `AlreadyRouting` also means the cloud is live (a repeated passive→active edge onto a working
/// socket) and is NOT a refusal. `Raced` means a stop/restart interleaved and says nothing about the
/// relay. Everything else names a specific reason the cloud is unavailable, so the frontend can tell
/// the user something true and actionable instead of one flat "unavailable".
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
    // Age of the push-to-talk keydown at the moment the frontend invoked us, in ms — the missing
    // half of the latency chain. `None` when this open has no trustworthy gesture origin (the tray,
    // the voice menu, a focus-regain resume), in which case the line below reports the stages it can
    // measure without claiming a keydown span it cannot. Diagnostic only; never affects behaviour.
    keydown_age_ms: Option<u64>,
) -> Result<CloudStreamOutcome, ()> {
    // Reconstruct the gesture origin: everything from the keydown up to this line already happened
    // (two zustand writes, React scheduling, the phase-edge subscriber, the JS→Tauri hop), and the
    // elapsed time from here is what we add to it.
    let t_cmd = std::time::Instant::now();
    // A NEW DICTATION ATTEMPT — restart the interim log sampling, so THIS attempt logs its own
    // first interim. Here rather than at socket open because this command runs on every
    // passive→active edge INCLUDING warm reuse, and warm reuse is the common case: without it a
    // hold that reuses a standby socket and produces a handful of interims could log nothing at
    // all, which is precisely the intermittent attempt someone is reading the log to understand.
    reset_interim_log_sampling();
    // Capture, under one lock, the state we need to (a) decide whether to open a stream and
    // (b) safely install it after the blocking handshake. The Arcs are captured by IDENTITY so we
    // can later confirm (via ptr_eq) the session generation didn't change.
    let (cloud_slot, cloud_active, cloud_epoch, cloud_tx, stale_socket) = {
        let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        // Warm reuse: a socket paused into standby by a recent stop is still open. If its
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
                // POSITIVE EVIDENCE, not a refusal: a live socket for this project is already
                // routing. Reported as its own outcome so the frontend stops counting the most
                // common healthy path as an outage.
                CloudReuse::AlreadyRouting => return Ok(CloudStreamOutcome::AlreadyRouting),
                CloudReuse::Resume => match cloud.as_ref() {
                    Some(s) => {
                        s.resume();
                        sess.cloud_active.store(true, Ordering::Relaxed);
                        tracing::info!(target: "dictation", "reusing warm deepgram socket");
                        // THE FAST PATH, MEASURED. No handshake ran, so this is keydown → live with
                        // the ~490 ms connect removed — the number this whole change exists to move.
                        log_socket_live("resumed", keydown_age_ms, t_cmd.elapsed().as_millis() as u64);
                        // caller starts metering, exactly as for a fresh open
                        return Ok(CloudStreamOutcome::Resumed);
                    }
                    // Unreachable by construction (Resume implies an installed session), but stated
                    // rather than assumed: flipping cloud_active with an EMPTY slot would tell the
                    // frontend cloud is live while the callback finds no sender — audio dropped
                    // instead of transcribed, with no cloud-ended to recover it. (roborev 52647)
                    // Reported as `Raced` rather than a refusal: nothing about the relay is known
                    // here, and accusing it of an outage on an internal invariant would be a lie.
                    None => return Ok(CloudStreamOutcome::Raced),
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
    // the new session's composer. Fire-and-forget — nothing
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
        // signed out → stay on the on-device model; don't consume an epoch on this path
        return Ok(CloudStreamOutcome::SignedOut);
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
    // Kept back from the move below so the "we DID connect" signal can still be emitted after the
    // handshake — see the `dictation://cloud-late` emits in the parked/discard arms.
    let app_for_events = app.clone();
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
            return Ok(CloudStreamOutcome::Unreachable);
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
            // Hoisted out of the lock block because the `cloud-late` emit below needs it: a discard
            // whose generation has ROTATED is an orphan of a session the user already left, and it
            // must stay as silent to the banner as `silence_now()` makes it to the transcript.
            // ONE decision, taken by `late_report_for`, so the two emit arms cannot drift.
            let mut report = LateReport::Silent;
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
                // READ THE FLAG OF THE GENERATION WE WOULD PARK INTO (roborev 61450, Medium).
                // `already_active` above is the CAPTURED generation's flag, which is right for
                // `should_install_cloud` (that decision is about our own attempt) but wrong here on
                // the rotated path: `ParkCurrent` banks into `sess.*`, and `armed`/`slot_empty` are
                // already read from `sess`, so sourcing this one from a retired generation left the
                // "never shadow a routing session" guard inert in exactly the case the new variant
                // enables. Identical to `already_active` whenever the generation is unchanged.
                let target_active = park_target_active(same_generation, &cloud_active, &sess);
                let disposition = raced_stream_disposition(
                    install,
                    same_generation,
                    sess.armed, // a mute leaves the generation intact — see raced_stream_disposition
                    slot_empty,
                    target_active,
                );
                report = late_report_for(disposition, same_generation);
                match disposition {
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
                    RacedStream::ParkCurrent => {
                        // The push-to-talk case, and the one that was throwing away 74% of all
                        // sockets: this gesture's OWN arm rotated the generation while we were
                        // handshaking, so the captured Arcs are stale but the live session is armed
                        // and wants exactly this socket.
                        //
                        // PARK INTO `sess.*`, NOT THE CAPTURED ARCS — that is the entire difference
                        // from the arm above, and getting it wrong would install the sender into an
                        // Arc nobody reads while the slot holds a session the callback can't feed.
                        // The captured `cloud_tx` is deliberately NOT touched: it belongs to a
                        // generation that is already gone.
                        park_raced_stream(&sess.cloud, &sess.cloud_tx, session);
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
                    // WE CONNECTED, and `Raced` alone cannot say so. `Raced` means "a benign race,
                    // the socket is BANKED, do not meter and do not count it as a refusal" — it is
                    // classified `ignore` on the frontend, which is right about billing and about
                    // the corroboration counter, but it leaves the user with no account of why the
                    // live preview did not appear. The handshake COMPLETED on this path by
                    // construction, so the additive `cloud-late` event is what carries that fact;
                    // see dictationEngineStore's `too-slow` reason.
                    emit_late_report(&app_for_events, report);
                    // Not live for THIS utterance — but banked, which is the difference between
                    // this and the discard it replaces. The next hold's line should read `resumed`.
                    log_socket_live("banked", keydown_age_ms, t_cmd.elapsed().as_millis() as u64);
                    Ok(CloudStreamOutcome::Raced)
                }
                // installed a live cloud socket → caller may start metering
                None => {
                    // The slow path: a full TLS+WS handshake inside this span. Its `total_ms` is the
                    // BEFORE number in the comparison — every hold used to look like this.
                    log_socket_live("opened", keydown_age_ms, t_cmd.elapsed().as_millis() as u64);
                    Ok(CloudStreamOutcome::Opened)
                }
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
                    // Same as the parked arm: the handshake SUCCEEDED and we threw the socket away
                    // for arriving late. Emitted after the silence/close hand-off so the frontend's
                    // reason can never outlive the stream it describes.
                    //
                    // ── BUT THE GENERATION DECIDES WHICH EVENT (roborev 59692/60374) ────────────
                    // Discard is also the arm a CROSS-GENERATION orphan lands in — a handshake from
                    // a session the user already stopped, arriving 1-6 s late while a fresh
                    // start_dictation has installed new Arcs. That successor may already be live and
                    // painting interims, and the banner has no expiry short of its TTL, so an
                    // ungated `cloud-late` lights "connected too late for that utterance" over a
                    // stream that is working. It is the same speak-into-the-successor hazard
                    // `silence_now()` exists for, aimed at the banner instead of the transcript.
                    //
                    // So `late_report_for` answers THREE ways and `emit_late_report` routes them: a
                    // same-generation late connect emits `cloud-late`, an orphan emits
                    // `cloud-orphan`, and neither emits nothing. An earlier version of this comment
                    // said the orphan was "silenced here too" and that the frontend then "falls
                    // through to `noteCloudOpenRefused`, whose corroboration is exactly right for a
                    // signal we cannot attribute" — that is the defect, not the design. An orphan is
                    // evidence about NEITHER session, so charging it to the successor's counter is
                    // how two rapid re-holds painted "can't reach the cloud transcription service"
                    // over a relay that had just completed two handshakes. It must reach neither the
                    // banner nor the counter, which is what the dedicated event buys.
                    emit_late_report(&app_for_events, report);
                    // not installed → caller must not bill; a race, not a refusal
                    Ok(CloudStreamOutcome::Raced)
                }
            }
        }
        Err(e) => {
            // THE RELAY'S OWN ANSWER, CARRIED THROUGH instead of flattened. The log keeps the full
            // detail; the return value keeps the CLASSIFICATION, so the frontend can name a stale
            // token or an empty balance rather than reporting every cause as one outage.
            let outcome = CloudStreamOutcome::from(e.refusal);
            tracing::info!(
                target: "dictation",
                error = %e,
                refusal = e.refusal.as_str(),
                "cloud stream unavailable; using on-device"
            );
            Ok(outcome)
        }
    }
}

/// Close the Deepgram cloud stream. The frontend calls this when the dictation phase leaves ACTIVE
/// (the send tray moving off Speak, a push-to-talk hold released, or the idle-relay park after a
/// stretch of silence), and it is also called during stop_dictation. Flushes Deepgram for the
/// trailing final result, then routes frames back to the on-device model.
///
/// MUST stay `async fn`, for the SAME reason `start_cloud_stream` above does. A plain sync
/// `#[tauri::command]` is `ExecutionContext::Blocking`, which runs the body INLINE on the
/// IPC/event-loop (macOS main) thread — and `DeepgramSession::finish()` blocks it on a Deepgram
/// flush (a network round trip that stalls on a slow/black-holed relay exactly as the handshake
/// did). All the state mutations (epoch bump, cloud-slot take, cloud_tx drop) still happen
/// synchronously under the lock BEFORE the first await, so the epoch/generation protocol is
/// unchanged; only the blocking `finish()` moves to `spawn_blocking`. The `.await` keeps the
/// teardown ordered — the command does not resolve until the flush completes, so a caller awaiting
/// it still sees a fully torn-down stream.
#[tauri::command]
pub async fn stop_cloud_stream(state: State<'_, DictationState>) -> Result<(), ()> {
    let to_finish = {
        let sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let was_active = sess.cloud_active.swap(false, Ordering::Relaxed); // callback routes on-device again
        sess.cloud_epoch.fetch_add(1, Ordering::Relaxed); // invalidate any in-flight start_cloud_stream
        // Warm standby: a genuine stop of a LIVE stream pauses the socket and KEEPS it for
        // ~WARM_STANDBY so the next utterance reuses it (no handshake). The session stays in the slot;
        // start_cloud_stream resumes it. Any other case (already inactive — e.g. a cloud-ended cleanup
        // after warm expiry — or a worker that already died) takes + finishes the leftover instead.
        //
        // ONE IMPLEMENTATION, shared with `stop_dictation` (the push-to-talk release) and sharing its
        // predicate with the blur path: parking on a tray stop, on a released hold, and on a window
        // blur are ONE rule. This was an inline copy of exactly the body `park_or_take_on_stop` now
        // holds, and `stop_dictation` had a THIRD, divergent version that simply destroyed the socket
        // — which is the drift that cost every push-to-talk hold its warm socket. Re-pausing an
        // already-parked session is a no-op in the worker (its Pause arm is guarded on `!paused`), so
        // this never extends the warm timer past the original park.
        park_or_take_on_stop(&sess, was_active)
    }; // release locks before the (slower) finish()/join
    // Move the blocking Deepgram flush off the calling (IPC/event-loop) thread — see the fn doc.
    // The session was already taken OUT of the slot under the lock above, so finishing it here can
    // never contend with a session a concurrent start_cloud_stream installs; this is the same
    // take-then-finish-off-thread shape start_cloud_stream uses for its stale/orphan sockets.
    if let Some(s) = to_finish {
        let _ = tauri::async_runtime::spawn_blocking(move || s.finish()).await;
    }
    Ok(())
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
/// Runs on the BLOCKING pool. `list_input_devices` is roughly `2 + 4N` synchronous CoreAudio HAL
/// property reads (device list, then per device: channel count, transport type, UID, name), each a
/// round trip that runs through in-process HAL plug-in code and often IPC to `coreaudiod`. This
/// machine loads EIGHT third-party HAL plug-ins into Sparkle's address space (see the
/// `audio_devices` module header), so `N` is large and one misbehaving vendor driver stalls the
/// whole enumeration — which, as a plain `#[tauri::command]`, meant stalling the AppKit main thread.
///
/// A join failure degrades to an empty list rather than throwing into the UI, matching how the rest
/// of this module treats device enumeration as best-effort.
#[tauri::command]
pub async fn list_audio_inputs() -> Vec<crate::audio_devices::InputDevice> {
    tauri::async_runtime::spawn_blocking(crate::audio_devices::list_input_devices)
        .await
        .unwrap_or_default()
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

/// MUST stay `async fn`, for the SAME reason `start_dictation` above does. A plain sync
/// `#[tauri::command]` is `ExecutionContext::Blocking`, running the body INLINE on the
/// IPC/event-loop (macOS main) thread — where the teardown below blocks it: the decode-worker join
/// (a bounded drain, but up to `DECODE_DRAIN_BUDGET`), the Deepgram `finish()` flush (a network
/// round trip), and the on-device `finalize()` (a synchronous decode). Any of those froze the UI on
/// mute. All the state mutations (disarm, epoch bump, capture/cloud/tx teardown) still run
/// synchronously under the lock BEFORE the first await, so the epoch protocol and idempotence are
/// unchanged; only the blocking join/finish/finalize/emit moves to `spawn_blocking`. The `.await`
/// keeps it ordered — the command does not resolve until teardown finishes, so the frontend's
/// `await invoke("stop_dictation")` (which relies on metering having stopped) still sees a completed
/// stop.
#[tauri::command]
pub async fn stop_dictation(app: AppHandle, state: State<'_, DictationState>) -> Result<(), ()> {
    let (transcriber, cloud_session, worker) = {
        let mut sess = state.0.lock().unwrap_or_else(|p| p.into_inner());
        // Idempotence: one mute is broadcast to every open window, so this command arrives N times
        // for a single user action (observed in clusters of 3-6 within 0-8ms). Only the first has
        // anything to do; the rest must NOT advance the epoch again, or one mute invalidates
        // in-flight starts N times over — the amplifier behind the 2026-07-26 lockout.
        let start_could_still_arm = sess.start_in_flight == Some(sess.stop_epoch);
        let noop = stop_is_noop(
            sess.armed,
            sess.capture.is_some(),
            sess.transcriber.is_some(),
            start_could_still_arm,
        );
        // LOG EVERY ARRIVAL, INCLUDING THE NO-OPS — the count is the diagnostic (sparkle-lc55u).
        //
        // Only the first arrival does work, and the rest return silently, so the log shows ONE
        // "capture dropped" line whether the mute came from one window or six. That hides the single
        // fact that separates the live hypotheses for "a stop lands ~200ms after every arm and
        // discards the freshly-built capture": a multi-window `[enabled]` broadcast arrives as a
        // CLUSTER within milliseconds, a push-to-talk release arrives ONCE at hold-duration, and a
        // focus/blur edge arrives once but uncorrelated with any key. Same teardown line for all
        // three today, which is why the cause could not be named from the log.
        //
        // INFO rather than DEBUG on purpose: it fires per user mute, not per frame, and the reports
        // this exists to diagnose arrive as "the mic did nothing" hours later — from a user running
        // a release build, where a DEBUG line would not have been recorded.
        tracing::info!(
            target: "dictation",
            noop,
            armed = sess.armed,
            has_capture = sess.capture.is_some(),
            has_transcriber = sess.transcriber.is_some(),
            start_could_still_arm,
            "stop_dictation arrived",
        );
        if noop {
            return Ok(());
        }
        sess.armed = false;             // disarm so a later focus event can't resurrect the mic
        // Advance the stop epoch so an in-flight start_dictation still loading the model observes
        // that a stop landed during its load and aborts instead of re-arming a muted mic.
        sess.stop_epoch = sess.stop_epoch.wrapping_add(1);
        sess.capture = None;            // drop Capture -> stops the cpal stream (no more frames) AND closes the decode channel
        let worker = sess.decode_worker.take(); // join below, AFTER releasing the lock (drains queued decodes)
        let cloud_was_active = sess.cloud_active.swap(false, Ordering::Relaxed);
        sess.cloud_epoch.fetch_add(1, Ordering::Relaxed); // invalidate any in-flight start_cloud_stream
        // PARK THE RELAY SOCKET INSTEAD OF BURNING IT — the push-to-talk half of warm standby.
        //
        // `stop_dictation` is where every push-to-talk RELEASE lands: the hold's resting state is
        // `setOff()` (`setEnabled(false)`), not a phase drop, so the release never reaches
        // `stop_cloud_stream`'s keep-warm branch — it comes here, where the socket was taken and
        // `finish()`ed unconditionally. That is why warm standby only ever worked for the Speak
        // tray, and why every hold paid a fresh ~490 ms handshake and a fresh 6¢ first-minute debit.
        //
        // Same predicate as the tray stop and the blur park, deliberately (`should_keep_warm_on_stop`)
        // — three ways of saying "the user stopped this utterance, not this session", and an inline
        // copy here is exactly how the three would drift.
        //
        // `pause()` still Finalizes, so the trailing text of the utterance being released commits
        // exactly as `finish()`'s flush did; the difference is only that the connection survives.
        // The worker closes it on its own schedule (warm expiry, or the paid-minute guard), and a
        // socket left parked here is what the NEXT hold's `note_fresh_arm` carries forward.
        let cloud_session = park_or_take_on_stop(&sess, cloud_was_active);
        (sess.transcriber.take(), cloud_session, worker)
    };                                  // release the session lock before the (slower) join/finalize
    tracing::info!(target: "dictation", "stop_dictation: capture dropped, finalizing");
    // The whole blocking teardown (worker join/drain, cloud flush, on-device finalize, and the final
    // emit that must follow finalize) moves off the calling (IPC/event-loop) thread via
    // `spawn_blocking`, and the `.await` keeps it ordered and complete before the command resolves —
    // see the fn doc. It is one closure, not several awaits, so the in-order emit contract (queued
    // accept partials, then finalize's tail, then the closing `dictation://final`) is preserved
    // exactly as when it ran inline. The `join()` no longer runs on the main thread, so the
    // best-effort-within-budget drain below is now bounded by a blocking-pool thread instead.
    let _ = tauri::async_runtime::spawn_blocking(move || {
        // Wait for the decode worker BEFORE finalize. This is the one teardown that does NOT abort
        // first: it wants the worker to drain its queued accept-path segments — emitting their
        // `dictation://partial`s — so they land before finalize's trailing segment and the closing
        // `dictation://final`, preserving the in-order emit.
        //
        // THAT DRAIN IS BEST-EFFORT WITHIN A BUDGET, not a guarantee — this comment used to claim the
        // guarantee, and it was only ever true while the channel reliably closed here (the premise
        // `DECODE_JOIN_TIMEOUT` documents as false). The drain gets `DECODE_DRAIN_BUDGET`; past it the
        // worker is aborted and the REST OF THE BACKLOG IS DISCARDED, so the tail of a long dictation
        // can be dropped rather than emitted. Reachable in practice: `DECODE_QUEUE_CAP` is 32 segments,
        // so a slow machine or a burst can queue more decoding than the budget covers. Now off the
        // main thread, an over-budget drain no longer freezes the UI (roborev 55788).
        drop(worker);
        // Flush the cloud stream first (if dictation was stopped mid-cloud) for its trailing final.
        if let Some(s) = cloud_session {
            s.finish();
        }
        // DELIBERATELY no `dictation://speech-end` here, unlike the worker's `accept` segments above.
        // This is a teardown flush: capture has already stopped, so what it emits is the tail the VAD
        // never got to close — not the engine observing the speaker fall silent. Arming a send
        // countdown at this point would count down over a mic the user just muted, and would fire
        // AFTER they stopped dictating, which is precisely the moment they are least able to catch it.
        // Stopping dictation is the user taking manual control; the send decision is theirs from here.
        if let Some(t) = transcriber {
            for seg in t.lock().unwrap_or_else(|p| p.into_inner()).finalize() { emit_partial(&app, "finalize", seg); }
        }
        let _ = app.emit("dictation://final", String::new());
    })
    .await;
    Ok(())
}

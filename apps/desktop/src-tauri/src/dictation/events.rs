//! Three families of `dictation://…` emitter, plus the log-sampling that keeps a hot interim stream
//! from drowning the log:
//!
//!   * **transcript text** — `partial`, `interim`. This IS the one place transcript text crosses
//!     into the frontend, which is what the privacy notes below are about.
//!   * **the auto-send rail's speech signals** — `speech-end` (arms the countdown) and
//!     `on-device-speech` (cancels it). See `emit_speech_end`'s doc for why they are a pair.
//!   * **cloud stream** — `cloud-ended`, `cloud-balance`.
//!
//! ── THIS IS NOT THE WHOLE EVENT SURFACE ──────────────────────────────────────────────────────
//! The capture/health/focus events (`error`, `audio-recovered`, `level`, `speaking`, `focus`,
//! `device`, `cloud-late`, `cloud-orphan`) are still emitted inline from `dictation.rs`, and
//! `model-progress`/`final` from `commands.rs`. **Auditing what dictation sends the webview means
//! grepping the tree for `dictation://`, not reading this file.** No count is given on purpose —
//! two earlier versions of this header stated one and both were wrong, because a count goes stale
//! the moment anyone adds an emit while the prose stays put.
//!
//! A leaf: nothing here reads a `DictationSession` or decides anything about capture. That is why
//! `cloud.rs` can depend on this module alone (`crate::dictation::events`) instead of on the whole
//! `dictation` hub — the emitters are all it ever wanted from it.
//!
//! The two sequence counters are the diagnostic contract: every partial carries a monotonic id and
//! a content fingerprint, so a duplicate in the prompt bar can be attributed to the backend emitting
//! the same text twice (two ids, one fingerprint) rather than the frontend appending once too often
//! (one id). Don't drop them to tidy the log.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

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
pub(in crate::dictation) fn segment_fingerprint(seg: &str) -> u32 {
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

/// How many interims pass between log lines. Interims arrive several times a second, so logging
/// every one would swamp the file; every 25th is roughly one line per spoken phrase, which is the
/// same order as `emit partial` and cheap enough to leave on in shipped builds.
pub(in crate::dictation) const INTERIM_LOG_EVERY: u64 = 25;

/// Interims emitted since the CURRENT dictation attempt began — not since process start, and the
/// difference is the whole value of the line.
///
/// `should_log_interim` always logs the 0th, so that "always" is only worth anything if the counter
/// goes back to 0 when a new attempt starts. A process-lifetime counter would give the very first
/// interim of the app's life a line and then sample every 25th forever, so a later push-to-talk
/// hold producing a handful of interims could log NOTHING — exactly the intermittent attempt
/// someone is reading the log to understand. `start_cloud_stream` resets it on every
/// passive→active edge (including warm socket reuse) via [`reset_interim_log_sampling`].
static INTERIM_SEQ: AtomicU64 = AtomicU64::new(0);

/// Restart interim log sampling for a new dictation attempt — see [`INTERIM_SEQ`].
pub(crate) fn reset_interim_log_sampling() {
    INTERIM_SEQ.store(0, Ordering::Relaxed);
}

/// Emit a live, *volatile* interim transcript (the cloud path's word-by-word preview). Unlike a
/// committed partial this is replaced in place on the frontend and is NOT routed to a destination:
/// it only paints the italic preview, so nothing is inserted into a composer or a PTY from it and
/// it never arms the auto-send countdown.
///
/// ── WHY THIS LOGS AT ALL, WHEN IT DELIBERATELY DID NOT ────────────────────────────────────────
/// The old contract here was "we emit it to the webview and keep nothing", and for the TEXT that
/// still holds — see the privacy note below. But keeping nothing at all made a whole class of bug
/// undiagnosable: when the founder reported that the italic provisional preview never appeared
/// (bead sparkle-phdw2), his log carried 635 `emit partial source="deepgram"` lines and *no*
/// evidence either way about interims, because this function was silent. "Deepgram is live" and
/// "interims are reaching the webview" are different facts, and only the first was observable — so
/// the investigation could not tell a backend that never emitted from a frontend that never
/// painted, and had to reach for a live Deepgram probe to make any progress at all.
///
/// A COUNT is the whole fix. It distinguishes those two cases from one line in a user's log, and
/// it is the one thing that was missing.
///
/// PRIVACY IS UNCHANGED, and stricter than `emit_partial`'s: no transcript text, no fingerprint,
/// and no length. A fingerprint is defensible for committed segments (one per phrase, and it is
/// what makes duplicates diagnosable), but interims are the SAME phrase re-sent word by word as it
/// grows, so a stream of fingerprints over a lengthening prefix is a far better reversal oracle
/// than the isolated digests `emit_partial` writes. Only the running count is recorded.
/// Claim this interim's 0-based index within the current dictation attempt, advancing the counter.
/// Split out so the reset contract is testable without an `AppHandle` (which no unit test can
/// build) — the thing worth proving is that a new attempt starts back at 0, and that is invisible
/// from `should_log_interim` alone.
pub(in crate::dictation) fn next_interim_index() -> u64 {
    INTERIM_SEQ.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn emit_interim(app: &AppHandle, seg: String) {
    let n = next_interim_index();
    if should_log_interim(n) {
        tracing::info!(target: "dictation", count = n + 1, "emit interim");
    }
    let _ = app.emit("dictation://interim", seg);
}

/// Does the `n`-th interim (0-based) get a log line? The FIRST one always does, then every
/// [`INTERIM_LOG_EVERY`]-th after it.
///
/// Logging the first is the load-bearing half, and the reason this is a named function rather than
/// an inline `%`: a plain every-25th sample would stay SILENT through a session that emitted 24
/// interims and then stopped — which is precisely the failing session someone would be reading the
/// log to understand. The bug this whole line exists to make diagnosable would still be invisible.
pub(in crate::dictation) fn should_log_interim(n: u64) -> bool {
    n % INTERIM_LOG_EVERY == 0
}

/// THE SPEAKER STOPPED — the auto-send rail's silence signal (PRD §4).
///
/// TWO HONEST SOURCES, one per capture mode, because the signal has to mean the same thing in
/// both — and for a long time it did not. It was emitted ONLY by the cloud relay, so whenever the
/// engine fell back to on-device (relay closed, cloud off, no credits) speech was transcribed into
/// the composer forever and the auto-send clock never started even once. Observed in the wild:
/// after a `cloud relay stream closed`, six minutes of `emit partial source="accept"` with not a
/// single auto-send evaluation. Transcription and arming MUST NOT disagree about whether an
/// utterance ended, so both engines report it now:
///   - **cloud**: Deepgram's own endpoint decision (`speech_final`, or the standalone
///     `UtteranceEnd` frame), taken from word timings in the audio (see cloud.rs).
///   - **on-device**: a CLOSED Silero-VAD segment (see `DecodeWorker::spawn`). The VAD closing a
///     segment IS the engine asserting the speaker stopped — that is the same claim Deepgram's
///     endpointing makes, arrived at from the same evidence (a silence gap in the audio), just
///     locally. It is what produced the transcript we emit alongside it.
///
/// EXACTLY ONE ENGINE IS FED AT A TIME, BUT THAT DOES NOT MAKE THE EMITS EXCLUSIVE. The capture
/// callback routes each frame to the relay OR the on-device VAD/decode queue on `cloud_active`,
/// never both — so ROUTING is exclusive. EMISSION is not: `decode_tx` is a 32-deep buffer the decode
/// worker keeps draining after the flag flips, so a segment closed just before it decodes hundreds
/// of ms later, while Deepgram is already authoring. That is the COMMON case rather than an exotic
/// one, because the on-device model is what runs right up to the instant the relay opens: every
/// passive→active transition hands over mid-stream, with the decode queue still holding segments
/// captured before the flip.
///
/// That overlap is NOT suppressed here, and `plan_decode_emit` documents at length why an attempt to
/// suppress it was withdrawn: the boundary it discarded had no successor, so the flagship hands-free
/// utterance ended with its command in the composer and nothing ever arming. A late boundary is
/// bounded and cancellable frontend-side; a missing one is unrecoverable by construction.
///
/// Deliberately NOT `dictation://speaking`. That event is the Silero VAD's *real-time* edge, and a
/// rail keyed off its falling edge would be keyed off the wrong thing on BOTH paths: on the cloud
/// path the VAD is incidental (Deepgram has the audio and does its own endpointing), and on the
/// on-device path the boundary that matters is the VAD's *segment close* — the one that has a
/// transcript attached, which is what the ordering guarantee below depends on. A raw level edge has
/// neither property.
///
/// (This doc previously said `speaking` is hard-coded `true` for the whole cloud stream, so it "can
/// never fall". That was true when it returned `cloud_active || vad_detected`; the 2026-07-29
/// dead-mic fix made it the raw VAD on both paths. The conclusion is unchanged, the reason isn't —
/// see roborev 55503.)
///
/// Nor is it inferable from `dictation://partial` going quiet: that measures how long the
/// TRANSCRIPT has been idle, which under network or model load starts ticking while the user is
/// still mid-sentence.
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

/// The ON-DEVICE speaker went active / idle — the countdown's cancel signal (see
/// `frame_on_device_speech`). Edge-triggered, like `dictation://speaking`, so it costs one event per
/// transition rather than one per frame.
///
/// A LEVEL, not a pulse, and that matters: the frontend needs to answer "is the user talking right
/// now?" at the instant a speech-end lands, not merely "did they resume since". The on-device decode
/// runs hundreds of ms behind the audio, so a user who resumes during that gap produces
/// resume-then-arm in that order — a pulse would be consumed before the arm it needs to prevent,
/// and the clock would start while they were mid-sentence.
///
/// Privacy: a boolean about voice ACTIVITY, never content, and nothing is logged.
pub(crate) fn emit_on_device_speech(app: &AppHandle, active: bool) {
    let _ = app.emit("dictation://on-device-speech", active);
}

/// Signal that the cloud (relay) worker has exited — whether a clean close, a mid-stream failure, or
/// the relay signalling out-of-credits. The frontend handles this by clearing the interim preview and
/// calling stop_cloud_stream, which flips `cloud_active` back to false so the capture callback resumes
/// routing frames to the on-device model. Without this, a mid-stream socket death would strand
/// dictation: frames keep going to the dead session, the on-device fallback path never resumes,
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

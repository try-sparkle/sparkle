//! Deepgram Nova-3 cloud dictation — streamed through the SERVER-SIDE orchestration relay.
//!
//! Audio is captured natively (see `audio.rs`) as 16 kHz mono f32. When the user is actively
//! dictating (the dictation phase is ACTIVE — the send tray sitting on Speak, or a push-to-talk
//! hold; see `voice/dictationPhase` on the frontend) we open a WebSocket to the
//! orchestration relay's `/ai/deepgram` endpoint (see apps/orchestration/src/socket/deepgramRelay.ts)
//! and stream PCM16 frames up. The relay authenticates the user's Sparkle bearer, opens Deepgram
//! Nova-3 on SPARKLE's key (not a local one), meters per-minute server-authoritatively, and streams
//! transcripts + post-debit balance back down. This replaces the old direct-to-Deepgram path that
//! used a local `DEEPGRAM_API_KEY` and a bypassable client-side meter.
//!
//! Wire protocol (relay → client, JSON text frames):
//!   - Deepgram `Results` frames are forwarded VERBATIM, so `parse_deepgram_message` parses them
//!     exactly as it did on the direct connection (interim + final transcripts).
//!   - The relay's own control frames carry a lowercase `type`: `ready` (metering is live — start
//!     streaming), `balance` (post-debit balance, ticks the credits pill), `exhausted` (out of
//!     credits — tear down and fall back on-device), `error` (upstream failure — same teardown).
//!
//! Client → relay: binary PCM16 audio frames, plus Deepgram's own `{"type":"CloseStream"}` /
//! `{"type":"Finalize"}` control text (forwarded verbatim by the relay).
//!
//! Threading: cpal's audio callback must never block, so it only pushes frames onto an mpsc
//! channel. A dedicated worker thread owns the WebSocket and does a single-threaded select loop
//! — drain pending audio and send it, then read one message under a short socket read-timeout —
//! which gives full-duplex behavior over one blocking socket without splitting it.
//!
//! Everything degrades gracefully: if the handshake fails (offline, signed out, not entitled, or the
//! relay refuses because the user can't afford the first minute — a non-101 status) `start` returns
//! Err and the caller falls back to the on-device transcriber; a mid-stream error (or an `exhausted`
//! control frame) ends the worker and the session is torn down back to on-device.
use std::collections::VecDeque;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::dictation::events::{
    emit_cloud_balance, emit_cloud_ended, emit_interim, emit_partial, emit_speech_end,
};

/// The capture pipeline always hands us 16 kHz mono (downmix_resample target), so that's the
/// rate we declare (via the `?sample_rate=` query the relay reads). Kept as a constant rather than
/// threaded through so the wire format can't drift from what `audio.rs` actually produces.
pub const SAMPLE_RATE: u32 = 16_000;

/// The relay WebSocket path (mirrors `DEEPGRAM_WS_PATH` in deepgramRelay.ts).
const RELAY_WS_PATH: &str = "/ai/deepgram";

/// How long the worker blocks on a single socket read before looping back to send more audio.
/// Short enough that outbound audio latency stays well under Deepgram's own ~100–300 ms result
/// cadence; long enough to avoid a busy-spin when nothing is flowing.
const READ_TIMEOUT: Duration = Duration::from_millis(40);

/// Write deadline — deliberately MUCH larger than READ_TIMEOUT. The read timeout doubles as the
/// loop's poll interval, so it must be tiny; but reusing it as a write deadline would trip on a
/// momentarily full TLS/TCP send buffer (normal WiFi jitter) and tear down a healthy session. This
/// only exists to keep `finish()`'s join bounded if the uplink is truly wedged; a transient stall
/// is retried (see the send loop), so a few seconds is the right magnitude.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// After we tell the relay the stream is closing, keep reading this many extra timeouts (~2 s) to
/// collect the trailing final result(s) before giving up — so the last spoken words aren't lost.
const DRAIN_TICKS_AFTER_CLOSE: u32 = 50;

/// Deepgram control message: "no more audio is coming; finalize and send remaining results."
/// The relay forwards this text frame verbatim to Deepgram.
const CLOSE_STREAM_MSG: &str = "{\"type\":\"CloseStream\"}";

/// Deepgram control message: flush + finalize the audio sent so far and emit the trailing final,
/// but KEEP the socket open (unlike CloseStream). Used when pausing into warm standby so the last
/// utterance still commits while the connection stays reusable for the next one.
const FINALIZE_MSG: &str = "{\"type\":\"Finalize\"}";

/// How long an idle (paused) relay socket is kept open for instant reuse by the next utterance,
/// instead of being torn down. The per-utterance TLS+WS handshake (plus the relay opening its own
/// Deepgram upstream) is the dominant cold-start latency the user feels; reusing a warm socket
/// eliminates it for back-to-back dictation.
///
/// ── WHY 55s AND NOT 8s, AND WHY THAT IS *FREE* (sparkle dictation latency measurement) ───────────
/// This was 8s, chosen to sit under Deepgram's ~10 s server-side idle close so the worker never had
/// to send KeepAlive frames. Measured against the founder's actual push-to-talk rhythm (281 holds
/// over 8 days), that window covered only **33.5%** of re-holds — his median gap between holds is
/// **18 s**, so two thirds of them fell outside it and paid a fresh ~490 ms handshake.
///
/// The window is now bounded by BILLING rather than by Deepgram's idle timer, because that is the
/// constraint that actually costs the user money. The relay debits one minute UP FRONT on upstream
/// open (`firstMinuteCents`, 6¢) and one more every 60 s the socket stays open. So every distinct
/// handshake costs a whole minute no matter how briefly you speak — and holding ONE socket open for
/// the remainder of a minute already paid for costs exactly nothing extra. Reuse inside the paid
/// minute is therefore strictly CHEAPER than reconnecting: it replaces a second 6¢ debit with zero.
/// See `warm_deadline_passed` for the paid-minute half of the rule, which is what keeps this
/// cost-neutral instead of merely cheap.
///
/// At 55 s this covers **74.1%** of the founder's re-holds (vs 33.5% at 8 s) for the same money.
const WARM_STANDBY: Duration = Duration::from_secs(55);

/// The relay's billing quantum: it debits one minute on upstream open and one per 60 s thereafter
/// (`deepgramMeter.ts` `MINUTE_MS`). A warm socket closed before this elapses costs the user exactly
/// the one minute that opening it already charged.
const PAID_MINUTE: Duration = Duration::from_secs(60);

/// How far before the next per-minute debit a warm socket must be closed. Covers the close+drain
/// (~2 s, see `finish`) plus clock/scheduling slop, so warm standby can never be the thing that
/// tips a session into a SECOND billed minute. Without it "hold until 60 s" would race the debit it
/// is trying to avoid.
const PAID_MINUTE_SAFETY: Duration = Duration::from_secs(6);

/// Deepgram control message: "I have nothing to send right now, keep the connection open." Required
/// now that `WARM_STANDBY` (55 s) exceeds Deepgram's ~10 s server-side idle close — the reason the
/// old 8 s window existed. The relay forwards client text frames to Deepgram verbatim
/// (`deepgramRelay.ts` client→upstream `on("message")`), so this needs NO server-side change.
///
/// Unlike `FINALIZE_MSG` this produces no transcript and does not close the current utterance; it is
/// purely an idle heartbeat. If it were ever rejected the socket simply dies, the worker exits,
/// `alive` goes false, and `cloud_reuse` opens a fresh one — i.e. it degrades to the pre-warm
/// behaviour rather than breaking dictation.
const KEEPALIVE_MSG: &str = "{\"type\":\"KeepAlive\"}";

/// How often to send `KEEPALIVE_MSG` while parked. Comfortably under Deepgram's ~10 s idle close so
/// a single dropped/delayed heartbeat cannot expire the socket.
const KEEPALIVE_EVERY: Duration = Duration::from_secs(4);

/// Cap on how many audio frames we buffer locally while waiting for the relay's `ready` signal (see
/// the send loop). The relay DROPS any client audio it receives before its first-minute debit clears
/// (`meteringLive`), so buffering here avoids clipping the first words of an utterance during the
/// relay→Deepgram open. Bounded so a relay that never sends `ready` can't grow this unboundedly;
/// oldest frames are dropped past the cap (a few seconds of 16 kHz PCM16).
const MAX_PREREADY_FRAMES: usize = 400;

/// What the worker thread receives from the audio callback.
enum AudioMsg {
    /// One frame of PCM16 little-endian bytes. The f32→PCM16 conversion runs in `send_audio` on the
    /// cpal callback thread — it's a cheap, lock-free, non-blocking per-sample loop + one alloc, so
    /// it's safe on the audio hot path; the worker just forwards the bytes.
    Frame(Vec<u8>),
    /// The user stopped dictating — flush the relay and wind the worker down.
    Close,
    /// The user stopped this utterance but may dictate again shortly: Finalize the current segment
    /// and drop into warm standby (keep the socket, stop expecting audio). After `WARM_STANDBY` with
    /// no `Resume` the worker closes the socket itself.
    Pause,
    /// A new utterance started while the socket was warm: leave standby and resume forwarding audio
    /// on the SAME connection — no new handshake.
    Resume,
}

/// A live relay streaming session. Holds the channel the audio callback feeds and the worker
/// thread handle. Drop signals close and detaches; call `finish()` to also join (used on stop).
pub struct DeepgramSession {
    audio_tx: Sender<AudioMsg>,
    worker: Option<JoinHandle<()>>,
    /// When set, the worker skips its `dictation://cloud-ended` emit on exit. Set by `finish()` (the
    /// frontend-initiated stop already tore the UI down, so the event would only trigger a redundant
    /// round-trip) and by `silence_now()`, where it matters more: a session torn down
    /// alongside a live successor must not fire an event that would stop the *current* (healthy)
    /// session — the event carries no generation identity.
    suppress_ended: Arc<AtomicBool>,
    /// True while the worker thread is running. Cleared the instant the worker exits (clean close,
    /// warm-standby expiry, or socket death). Lets the reuse path (`start_cloud_stream`) check, under
    /// the state lock, whether a warm session is still usable before resuming it. A lost race here is
    /// SAFE: resuming a just-dead session simply drops frames, and the worker's `cloud-ended` emit on
    /// exit drives the frontend back to on-device — the same recovery as any mid-stream death.
    alive: Arc<AtomicBool>,
    /// True while this session is parked in warm standby (`pause()` sent, no `resume()` since).
    /// Distinguishes a socket that is DELIBERATELY idling on our warm timer from one that is merely
    /// installed-but-not-yet-routing, which matters because `stop_cloud_stream` must keep the former
    /// and close the latter. Owned by the pause/resume callers rather than the worker: on warm
    /// expiry the worker exits, so `alive` already reports the truth and this flag is moot.
    parked: Arc<AtomicBool>,
    /// When set, the worker emits NO transcript (`partial`/`interim`) for the rest of its life. Set
    /// by `silence_now()` — the teardown of a session whose successor is coming up concurrently.
    /// The reopen paths call it under the session lock; the post-handshake orphan calls it on a
    /// session that never entered the slot. Either way the silencing happens on the CALLING thread
    /// and only the blocking close goes to a worker.
    ///
    /// `suppress_ended` is NOT enough there: it gates only the `cloud-ended` emit, while the ~2 s
    /// post-CloseStream drain keeps forwarding transcripts. `dictation://partial` feeds straight
    /// into the frontend's `onSegment`, so a trailing final from the OLD socket can inject stale text
    /// into the new session — and, since a committed segment arms the auto-send countdown, dispatch
    /// it. Balance
    /// emits are deliberately NOT muted: that minute was really debited and the pill must show it.
    muted: Arc<AtomicBool>,
    /// The project name this socket was OPENED with, normalized the same way the wire value is
    /// (trimmed, clipped; blank → None). The relay captures the project once at handshake and stamps it on
    /// every per-minute debit for the life of the connection, so a warm socket reused after the user
    /// switched projects would bill the new project's minutes to the old one. `start_cloud_stream`
    /// compares against this before reusing and reopens on a mismatch (roborev 48164).
    project: Option<String>,
    /// True while this socket was opened SPECULATIVELY — by the push-to-talk pre-connect, before the
    /// user pressed anything — and has never once routed audio.
    ///
    /// It exists for exactly one decision, and it is a privacy decision rather than a billing one:
    /// on a window BLUR a speculative socket is closed outright, while a socket that carried real
    /// dictation keeps the existing warm-standby posture (held for the reuse window, resumed on
    /// focus-regain). Without the distinction the blur path could only choose between releasing
    /// nothing — leaving a relay connection open to Sparkle's servers while the user is in another
    /// app, purely on a guess that they might come back and speak — or releasing everything, which
    /// would delete the focus-regain resume that `park_cloud_for_blur` exists for.
    ///
    /// Set by `mark_speculative()` at pre-connect time and cleared by `resume()`: the moment the
    /// socket starts carrying an utterance it stops being a guess and becomes an ordinary warm
    /// session. Cleared in `resume()` rather than at the call site because `resume()` is the single
    /// funnel every routing path goes through (`cloud_reuse`'s `Resume`, the focus-regain unpark), so
    /// a new caller cannot forget to retire the flag.
    ///
    /// Lives on the SESSION, not on `DictationSession`, so it travels with the socket across
    /// `note_fresh_arm`'s generation rotation — which is precisely the hop a pre-connected socket
    /// makes on its way to the hold that uses it.
    speculative: Arc<AtomicBool>,
}

impl DeepgramSession {
    /// Open the relay WebSocket (synchronous handshake) and spawn the worker. `base_url` is the
    /// orchestration host (from `auth::base_url()`); `token` is the user's Sparkle bearer (from the
    /// keychain). Returns Err if the handshake fails — offline, signed out, not entitled, or the
    /// relay refused because the user can't afford the first minute (a non-101 status) — so the
    /// caller can fall back to the on-device path before any audio is captured; no partial/dead
    /// session is ever returned.
    pub fn start(
        app: AppHandle,
        base_url: String,
        token: String,
        // Project this dictation belongs to, for credit-history attribution. None when unknown.
        project: Option<String>,
    ) -> Result<DeepgramSession, RelayError> {
        // ── THE HANDSHAKE, MEASURED (sparkle-oyapv) ──────────────────────────────────────────────
        // DNS + TCP + TLS + the WS upgrade, and the dominant cost of the second window in which
        // push-to-talk loses speech: while this is in flight `cloud_active` is still false, and when
        // it completes MID-SEGMENT the cloud branch discards the leading audio the on-device VAD had
        // accumulated — which the relay never received either. The repo describes this as "~hundreds
        // of ms" in two places and bounds it at CONNECT_TIMEOUT (8s); neither is a measurement.
        //
        // It is also the cost `WARM_STANDBY` exists to avoid — and a push-to-talk RELEASE currently
        // tears the session down (`stop_dictation` take()s and finish()es it), so every hold pays
        // this again. This line is what will show that reuse actually started working.
        let t_handshake = std::time::Instant::now();
        let socket = connect(&base_url, &token, SAMPLE_RATE, project.as_deref())?;
        let handshake_ms = t_handshake.elapsed().as_millis() as u64;
        let (tx, rx) = std::sync::mpsc::channel::<AudioMsg>();
        let suppress_ended = Arc::new(AtomicBool::new(false));
        let suppress_cb = suppress_ended.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let alive_cb = alive.clone();
        let muted = Arc::new(AtomicBool::new(false));
        let muted_cb = muted.clone();
        let worker = std::thread::Builder::new()
            .name("deepgram-relay".into())
            .spawn(move || run_session(app, socket, rx, suppress_cb, alive_cb, muted_cb))
            .map_err(|e| RelayError::local(format!("spawn relay worker: {e}")))?;
        tracing::info!(target: "dictation", handshake_ms, "cloud relay stream opened");
        Ok(DeepgramSession {
            audio_tx: tx,
            worker: Some(worker),
            suppress_ended,
            alive,
            parked: Arc::new(AtomicBool::new(false)),
            muted,
            project: normalize_project(project.as_deref()),
            // FALSE by default: `start` is the ordinary open, driven by a gesture the user made.
            // Only the pre-connect path marks it, so a socket that reaches here any other way keeps
            // the pre-existing blur posture unchanged.
            speculative: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Whether this socket was opened for `requested` — i.e. whether reusing it would attribute the
    /// next minutes to the right project. Strict: a session opened WITH a project must not be reused
    /// for an unattributed request either, since that would silently bill the old project.
    pub fn is_for_project(&self, requested: Option<&str>) -> bool {
        self.project.as_deref() == normalize_project(requested).as_deref()
    }

    /// A cheap, cloneable handle to just this session's audio channel. The realtime capture
    /// callback holds one of these so it can push frames WITHOUT locking the `DeepgramSession`
    /// slot mutex (`cloud`) that start/stop_cloud_stream/stop_dictation contend on — see
    /// `CloudAudioSender`. The handle keeps the send channel alive; the worker (and its socket)
    /// are unaffected by the handle's lifetime, so dropping it never closes a live stream.
    pub fn audio_sender(&self) -> CloudAudioSender {
        CloudAudioSender { audio_tx: self.audio_tx.clone() }
    }

    /// Drop into warm standby: Finalize the current utterance (so its trailing text still commits)
    /// and keep the socket open for `WARM_STANDBY` so the next utterance can reuse it. No-ops if the
    /// worker already exited. Called instead of `finish()` on a normal stop (the send tray leaving
    /// Speak, a push-to-talk hold released, a window blur, or the idle-relay park).
    pub fn pause(&self) {
        self.parked.store(true, Ordering::Relaxed);
        let _ = self.audio_tx.send(AudioMsg::Pause);
    }

    /// Leave warm standby and resume forwarding audio on the same connection (no handshake).
    pub fn resume(&self) {
        self.parked.store(false, Ordering::Relaxed);
        // A socket that is about to carry speech is no longer a guess — see `speculative`. Retired
        // HERE rather than at the call sites because this is the one funnel every routing path goes
        // through, so the flag cannot outlive the speculation by being forgotten somewhere.
        self.speculative.store(false, Ordering::Relaxed);
        let _ = self.audio_tx.send(AudioMsg::Resume);
    }

    /// Mark this socket as opened by the push-to-talk PRE-CONNECT: connected on spec, never used.
    /// See the `speculative` field for what the mark decides (blur release) and what it deliberately
    /// does not (metering — a speculative socket is parked, and parked is not routing).
    pub fn mark_speculative(&self) {
        self.speculative.store(true, Ordering::Relaxed);
    }

    /// Whether this socket is still an unused pre-connect. False once `resume()` has handed it an
    /// utterance, and false for every socket opened by an ordinary `start_cloud_stream`.
    pub fn is_speculative(&self) -> bool {
        self.speculative.load(Ordering::Relaxed)
    }

    /// Whether this session is currently parked in warm standby. Checked (alongside `is_alive`) by
    /// `stop_cloud_stream` so a stop that arrives AFTER the blur path already parked the socket
    /// leaves it warm instead of closing it.
    pub fn is_parked(&self) -> bool {
        self.parked.load(Ordering::Relaxed)
    }

    /// Whether the worker thread is still running (socket usable). Checked before reusing a warm
    /// session; see the `alive` field for why a lost race is safe.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Mark the worker as exited, the way warm expiry or a socket error does. Test-only seam: the
    /// `alive` flag is worker-owned and there is no real worker behind `parkable_session`, so the
    /// dead-socket branches (which several callers gate on) are otherwise undriveable.
    #[cfg(test)]
    pub(crate) fn kill_for_test(&self) {
        self.alive.store(false, Ordering::Relaxed);
    }

    /// End the stream: tell the relay to finalize, then join the worker. The shutdown path itself is
    /// bounded to ~2 s: on entering `closing` the worker shrinks the write timeout to the read
    /// interval, so the CloseStream flush + trailing-final read-drain are both capped by the read-tick
    /// budget regardless of link state. The one unbounded tail is frames already queued in the
    /// channel *ahead of* Close when `finish()` fires: on a sustained (multi-second) uplink wedge the
    /// worker must drain those at up to WRITE_TIMEOUT each before it reaches Close. That's the
    /// acknowledged sustained-wedge case (a wedge during active dictation is outside the WiFi-jitter
    /// operating point we target); normal and brief-jitter teardown is ~2 s, never a hang.
    pub fn finish(mut self) {
        // Suppress the worker's cloud-ended emit: finish() is only called from the frontend-initiated
        // stop paths (stop_cloud_stream / stop_dictation), which have already torn down the UI.
        // Emitting would just trigger a redundant stop_cloud_stream round-trip. cloud-ended is
        // reserved for UNSOLICITED worker death (socket error / exhaustion), where the frontend must
        // be told.
        self.suppress_ended.store(true, Ordering::Relaxed);
        let _ = self.audio_tx.send(AudioMsg::Close);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }

    /// Go quiet IMMEDIATELY — no transcripts, no `cloud-ended` — and hand back a session that can
    /// only be closed, never resumed. THE way to tear a session down while a REPLACEMENT is coming
    /// up concurrently (the reopen paths in `start_cloud_stream`, and the post-handshake orphan).
    ///
    /// Consuming, and returning a distinct type, ON PURPOSE. The whole hazard here is ORDERING: the
    /// silencing must happen on the calling thread, before the bounded-but-blocking close is handed
    /// to a worker. The predecessor was a single `discard()` that silenced as its first statement —
    /// which READ as if it silenced synchronously while actually doing it inside the spawned task,
    /// leaving a window where the outgoing worker could still emit `cloud-ended` (and drain
    /// transcripts) into whichever session raced ahead. That regressed twice from comments alone
    /// (roborev 50498/53024).
    ///
    /// This does NOT make the hazard unstateable — `spawn_blocking(move || s.silence_now().finish())`
    /// still compiles. What it removes is the MISLEADING form: the silencing can no longer hide
    /// inside a teardown method, so a reviewer sees `silence_now()` at the call site or not at all.
    /// The call-site comments still carry the ordering; keep them.
    ///
    /// Not for the ordinary stop path — there the trailing final is the whole point of the
    /// Finalize/drain, which is why `finish()` does not mute.
    pub fn silence_now(self) -> SilencedSession {
        self.muted.store(true, Ordering::Relaxed);
        self.suppress_ended.store(true, Ordering::Relaxed);
        SilencedSession(self)
    }
}

/// A `DeepgramSession` that has already gone quiet (see `silence_now`). Its only operation is the
/// blocking close: it cannot be resumed, re-silenced, or handed back to the slot.
///
/// It does NOT constrain WHERE that close runs. `finish()` is bounded (~2 s) but blocking, and
/// `start_cloud_stream` is an `async fn` command, so calling it inline there would stall an async
/// runtime worker for the whole teardown — the call site must still hand it to `spawn_blocking`.
///
/// `#[must_use]`: `Drop for DeepgramSession` signals close but deliberately does NOT join, so letting
/// one of these go silently degrades a bounded close+join into fire-and-forget — a state the old
/// consuming `discard(self)` couldn't reach. Note what the lint actually covers, though: a value
/// produced and thrown away as an expression STATEMENT. It cannot see a binding that later falls out
/// of scope on an early return, so the `finish()` hand-off still has to be read at the call site.
#[must_use = "a silenced session must still be closed — hand it to spawn_blocking(|| s.finish())"]
pub struct SilencedSession(DeepgramSession);

impl SilencedSession {
    /// Close + join, exactly like `DeepgramSession::finish()`. Bounded (~2 s); meant to run on a
    /// blocking worker, never on the async runtime.
    pub fn finish(self) {
        self.0.finish();
    }
}

#[cfg(test)]
impl SilencedSession {
    /// Both gates the WORKER reads, together — that pair is what "silenced" means, and asserting
    /// either alone would pass against a session that still leaks the other (`muted` alone still
    /// emits `cloud-ended`; `suppress_ended` alone still drains transcripts into the successor).
    pub(crate) fn is_silenced(&self) -> bool {
        self.0.muted.load(Ordering::Relaxed) && self.0.suppress_ended.load(Ordering::Relaxed)
    }
}

impl Drop for DeepgramSession {
    fn drop(&mut self) {
        // Safety net for the path that drops without finish() (e.g. an error teardown): signal
        // close so the worker exits, but DON'T join here — a Drop must not block the caller.
        let _ = self.audio_tx.send(AudioMsg::Close);
    }
}

/// A detached, cloneable sender for a cloud session's audio channel. Exists so the realtime
/// capture callback can route frames to the relay WITHOUT ever locking the `DeepgramSession` slot
/// mutex (the "teardown mutex") — holding that on the CoreAudio IOThread contends with
/// start/stop_cloud_stream/stop_dictation. Sending is non-blocking (the underlying mpsc channel is
/// unbounded, so `send` never blocks the caller) and silently no-ops once the worker has exited.
/// Owning one does NOT keep the worker/socket alive — only the send half — so dropping it (e.g.
/// when the callback tears down) can't strand or prolong a stream.
#[derive(Clone)]
pub struct CloudAudioSender {
    audio_tx: Sender<AudioMsg>,
}

impl CloudAudioSender {
    /// Push one 16 kHz mono frame to the relay. Converts to PCM16 here (cheap, lock-free) — same as
    /// `DeepgramSession::send_audio`, but callable off the session slot so the audio thread stays
    /// lock-light. No-ops if the worker already exited.
    pub fn send_audio(&self, frame: &[f32]) {
        let _ = self.audio_tx.send(AudioMsg::Frame(f32_to_pcm16le(frame)));
    }
}

/// Build the relay WebSocket URL, TCP connect target, and TLS flag from the orchestration base URL.
/// Pure so the http→ws / https→wss mapping and the default-port logic are unit-testable. Returns
/// `(ws_url, host:port, tls)`. Accepts `http(s)://` (the base_url form) and `ws(s)://` defensively.
fn relay_target(
    base_url: &str,
    sample_rate: u32,
) -> Result<(String, String, bool), String> {
    let trimmed = base_url.trim();
    let (tls, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = trimmed.strip_prefix("wss://") {
        (true, r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        (false, r)
    } else if let Some(r) = trimmed.strip_prefix("ws://") {
        (false, r)
    } else {
        return Err(format!("unsupported orchestration URL scheme: {base_url}"));
    };
    // Authority is everything up to the first '/', '?', or '#', dropping any path/query/fragment the
    // base URL might carry (auth::base_url() returns a bare scheme+host today; this is defensive so a
    // stray query can't fold into the host:port or a subpath silently vanish).
    let authority = rest.split(&['/', '?', '#'][..]).next().unwrap_or("").trim();
    if authority.is_empty() {
        return Err(format!("orchestration URL has no host: {base_url}"));
    }
    // The TCP target needs an explicit port; the WS URL keeps the authority verbatim so tungstenite
    // fills the Host header (and TLS SNI) from the real domain.
    let host_port = if authority.contains(':') {
        authority.to_string()
    } else {
        format!("{}:{}", authority, if tls { 443 } else { 80 })
    };
    let scheme = if tls { "wss" } else { "ws" };
    let ws_url = format!("{scheme}://{authority}{RELAY_WS_PATH}?sample_rate={sample_rate}");
    Ok((ws_url, host_port, tls))
}

/// Trim, CLIP, and treat blank as absent — the single normalization used both for the wire value and
/// for the warm-reuse comparison, so " sparkle " and "sparkle" can never be read as two different
/// projects (which would pointlessly drop a reusable warm socket, and each reopen costs the user a
/// fresh first-minute debit). Clipping here too, not only in `project_header_value`: the stored name
/// must be the name the relay is actually BILLING, or two names differing only past the cap would
/// force a reopen the ledger can't tell apart.
fn normalize_project(project: Option<&str>) -> Option<String> {
    project
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(MAX_PROJECT_CHARS).collect())
}

/// Max chars of the project name we put on the wire. Mirrors `ai::MAX_PROJECT_CHARS` and the relay's
/// own `MAX_PROJECT_CHARS`, and clips by CHARS (Unicode scalars) so all three metering paths agree.
/// Without a cap here, a pathological name percent-encodes to ~3x its bytes inside a handshake
/// header — and an oversized header gets the upgrade REFUSED, i.e. a decorative annotation would
/// break the feature it annotates (roborev 48157).
const MAX_PROJECT_CHARS: usize = 120;

/// Build the `X-Sparkle-Project` handshake header value for a dictation session: trimmed, clipped,
/// percent-encoded; None when there is no usable name.
///
/// A HEADER, not a `?project=` query param. This endpoint deliberately dropped its `?token=`
/// fallback (sparkle-5lne) because "a live bearer in the URL is captured by proxies, access logs,
/// and referrers" — and a user-chosen project name (`creditProject.ts` uses `acme-lawsuit` as the
/// motivating example) deserves the same hygiene. The client already sets `Authorization`, so a
/// header costs nothing. Percent-encoded because header values must be visible ASCII, and a
/// human-typed name is neither. (roborev 48157/48164)
fn project_header_value(project: Option<&str>) -> Option<String> {
    normalize_project(project).map(|name| percent_encode_query(&name))
}

/// Percent-encode a VALUE, keeping only the unreserved set (RFC 3986 §2.3) literal and hex-escaping
/// every other byte of its UTF-8. Deliberately strict — this is a human-typed project name landing
/// in a handshake header, so anything outside visible ASCII (or that could confuse a parser) must be
/// escaped rather than trusted.
fn percent_encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Convert 16 kHz mono f32 samples to PCM16 little-endian bytes (Deepgram `encoding=linear16`).
/// Clamp before scaling so an over-unity sample can't wrap to the opposite rail.
pub(crate) fn f32_to_pcm16le(frame: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame.len() * 2);
    for &s in frame {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// One transcript update parsed from a Deepgram `Results` message (forwarded verbatim by the relay).
#[derive(Debug, PartialEq)]
pub(crate) struct DeepgramResult {
    pub transcript: String,
    /// True once Deepgram has finalized this segment (commit it); false for a live interim.
    pub is_final: bool,
    /// Deepgram believes the SPEAKER has stopped, not merely that this segment closed.
    ///
    /// Distinct from `is_final` and the distinction is the whole point (PRD §4's auto-send rail):
    /// `is_final` closes a segment on every between-clause pause, so a silence timer keyed off it
    /// restarts mid-sentence. `speech_final` is Deepgram's endpoint decision — it rides along on a
    /// `Results` frame we are already parsing, so reading it costs nothing, and it arrives BEFORE
    /// the separate `UtteranceEnd` frame (which needs `utterance_end_ms` on the URL and lands
    /// `utterance_end_ms` after the last word). Either one is a legitimate speech-end signal; this
    /// is the cheap one.
    pub speech_final: bool,
}

/// Parse a Deepgram WebSocket text frame into a transcript update. Returns None for non-`Results`
/// messages (Metadata, UtteranceEnd, SpeechStarted — `UtteranceEnd` is handled separately by
/// [`parse_deepgram_utterance_end`]) and for empty transcripts (silence between words still
/// produces empty interim frames we don't want to surface).
pub(crate) fn parse_deepgram_message(json: &str) -> Option<DeepgramResult> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("Results") {
        return None;
    }
    let transcript = v
        .pointer("/channel/alternatives/0/transcript")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if transcript.is_empty() {
        return None;
    }
    let is_final = v.get("is_final").and_then(|b| b.as_bool()).unwrap_or(false);
    let speech_final = v.get("speech_final").and_then(|b| b.as_bool()).unwrap_or(false);
    Some(DeepgramResult { transcript, is_final, speech_final })
}

/// True when this frame is Deepgram's standalone `UtteranceEnd` — "the speaker has been silent for
/// `utterance_end_ms`".
///
/// A frame of its own rather than a flag on a transcript, because by construction there IS no
/// transcript: it is emitted from word timings after the audio went quiet, which is exactly why the
/// rail keys off it. A silence clock started when transcript updates stop is really measuring
/// transcription LAG, and under load that lag begins while the user is still speaking.
///
/// `SpeechStarted` (the other frame `vad_events=true` turns on) is deliberately NOT surfaced: the
/// rail cancels its countdown on the next transcript chunk anyway, which arrives on the same
/// speech, so a second cancel signal would buy nothing and could cancel on a cough.
pub(crate) fn parse_deepgram_utterance_end(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t == "UtteranceEnd"))
        .unwrap_or(false)
}

/// A relay control frame — the relay's own billing/lifecycle signals, distinct from the Deepgram
/// transcript frames it forwards verbatim. Tagged by a lowercase `type` (see deepgramRelay.ts's
/// `ClientControl`).
#[derive(Debug, PartialEq)]
pub(crate) enum RelayControl {
    /// Metering is live and the relay's Deepgram upstream is open — the client may stream audio.
    Ready,
    /// A per-minute debit landed: `balance_cents` is the server's post-debit balance (None when the
    /// server omits it → the client optimistically decrements by `debited_cents`).
    Balance { balance_cents: Option<i64>, debited_cents: i64 },
    /// Out of credits (or a first-minute decline) — the client tears down and falls back on-device.
    Exhausted,
    /// The relay's upstream failed — same teardown as `Exhausted` but without the balance refresh.
    Error,
}

/// Parse a relay control frame. Returns None for anything that isn't one of the relay's own control
/// types (e.g. a Deepgram `Results`/`Metadata` frame), so the caller can fall through to
/// `parse_deepgram_message`.
pub(crate) fn parse_relay_control(json: &str) -> Option<RelayControl> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    match v.get("type").and_then(|t| t.as_str())? {
        "ready" => Some(RelayControl::Ready),
        "balance" => Some(RelayControl::Balance {
            // Absent OR JSON null → None (the client then optimistically decrements).
            balance_cents: v.get("balanceCents").and_then(serde_json::Value::as_i64),
            debited_cents: v
                .get("debitedCents")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0),
        }),
        "exhausted" => Some(RelayControl::Exhausted),
        "error" => Some(RelayControl::Error),
        _ => None,
    }
}

/// What one incoming relay text frame means to the worker. Pure classification (control vs
/// transcript vs ignorable) so the dispatch is unit-testable without a socket.
#[derive(Debug, PartialEq)]
pub(crate) enum RelayFrame {
    /// A committed (final) transcript segment — emit as a partial. The flag says whether Deepgram
    /// ALSO called the end of speech on this frame (`speech_final`), which the auto-send rail keys
    /// its silence clock off. Carried on the variant rather than emitted as a separate frame so the
    /// worker cannot emit the transcript and its speech-end out of order.
    Partial(String, SpeechEnd),
    /// A live interim transcript — emit as the volatile preview. An interim never ends speech.
    Interim(String),
    /// Deepgram's standalone `UtteranceEnd`: the speaker went quiet, with no transcript attached.
    UtteranceEnd,
    /// A relay control frame.
    Control(RelayControl),
    /// Nothing actionable (Deepgram Metadata/SpeechStarted, an empty transcript, or unparseable
    /// text).
    Ignore,
}

/// Whether a committed transcript also ended the utterance. A named type rather than a bare `bool`
/// on the tuple variant: `RelayFrame::Partial(t, true)` at a call site says nothing about what is
/// true, and this frame's two booleans (`is_final`, `speech_final`) are exactly the pair that is
/// easy to confuse.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum SpeechEnd {
    /// Deepgram set `speech_final` — the speaker stopped.
    Ended,
    /// A segment boundary only (a pause between clauses); more speech is expected.
    Continuing,
}

/// Classify a relay text frame: a relay control frame wins; then Deepgram's standalone `UtteranceEnd`;
/// otherwise a `Results` frame becomes an interim/final transcript; anything else is ignored.
pub(crate) fn classify_relay_frame(json: &str) -> RelayFrame {
    if let Some(ctrl) = parse_relay_control(json) {
        return RelayFrame::Control(ctrl);
    }
    // BEFORE the transcript parse: `UtteranceEnd` carries no transcript, so `parse_deepgram_message`
    // returns None for it and it would fall through to Ignore — which is exactly the old behaviour
    // this arm replaces.
    if parse_deepgram_utterance_end(json) {
        return RelayFrame::UtteranceEnd;
    }
    match parse_deepgram_message(json) {
        Some(r) if r.is_final => RelayFrame::Partial(
            r.transcript,
            if r.speech_final { SpeechEnd::Ended } else { SpeechEnd::Continuing },
        ),
        Some(r) => RelayFrame::Interim(r.transcript),
        None => RelayFrame::Ignore,
    }
}

/// Bound the whole handshake (TCP connect + TLS + WS upgrade). Without this an offline/black-holed
/// network stalls the handshake for the OS SYN timeout (tens of seconds). `start_cloud_stream` now
/// runs this off the main thread (via `spawn_blocking`), so a stall no longer freezes the UI — but
/// the bound still matters so the fall-back-to-on-device stays fast rather than hanging for tens of
/// seconds.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Overall wall-clock ceiling on the WHOLE address-connect loop, independent of how many addresses
/// DNS returns for the relay host.
///
/// `CONNECT_TIMEOUT` bounds ONE attempt; the loop below tries EVERY resolved address in turn, so
/// without a total bound the worst case was `CONNECT_TIMEOUT × N`. A dual-stack / CDN relay hostname
/// resolving to a dozen-plus records, each black-holed under a contended network, turned the
/// 8s-per-attempt budget into MINUTES before the fall-back-to-on-device could fire — measured as a
/// 2-3 minute dead microphone after an app restart, under load average 48 with DNS itself timing out
/// (sparkle-nimbph). The per-address timeout was doing its job; nothing bounded the SUM.
///
/// This caps that sum. Two full-timeout attempts is enough to clear the case the multi-address loop
/// exists for (an IPv6 record on an IPv4-only path times out, a later IPv4 record connects — see the
/// loop's own comment). Addresses that FAIL FAST (a connection refused, resolved-but-dead) barely
/// dent the budget, so "try every address" still holds whenever the failures are cheap; only the
/// black-holed addresses — the ones that actually stalled the founder — are capped.
const CONNECT_TOTAL_BUDGET: Duration = Duration::from_secs(16);

/// Try each resolved address in order until one connects, bounding EACH attempt by
/// `min(CONNECT_TIMEOUT, time left in `total_budget`)` and STOPPING as soon as the total budget is
/// spent — even with addresses left untried. Returns the first `Ok`, else the last dial error.
///
/// Pure over an injected clock (`now`) and dialer (`dial`) so a test can prove the SUM is bounded —
/// that under many black-holed addresses it stops after the budget instead of dialing all N — with
/// no real socket, and can also prove the cap does NOT break the live-address-after-a-dead-one case
/// the loop is here for. The production dialer is `TcpStream::connect_timeout`; the production clock
/// is `Instant::now`.
fn connect_within_budget<S>(
    addrs: &[SocketAddr],
    total_budget: Duration,
    now: impl Fn() -> Instant,
    mut dial: impl FnMut(&SocketAddr, Duration) -> Result<S, String>,
) -> Result<S, String> {
    let start = now();
    let mut last_err = String::from("no address to connect to");
    for addr in addrs {
        // `checked_sub` is None once we're past the deadline; `is_zero` catches landing exactly on
        // it. Either way there is no time left to give an attempt, so stop rather than start a dial
        // that would run for its own full `CONNECT_TIMEOUT` past the budget.
        let remaining = match total_budget.checked_sub(now().saturating_duration_since(start)) {
            Some(r) if !r.is_zero() => r,
            _ => break,
        };
        match dial(addr, remaining.min(CONNECT_TIMEOUT)) {
            Ok(s) => return Ok(s),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// WHY a handshake failed, kept as a TYPE rather than flattened into a message string.
///
/// The relay answers every refusal with a DISTINCT status (see `deepgramRelay.ts`: 503 when its own
/// Deepgram key is unset, then 401 → 403 → 402 as it walks auth → entitlement → affordability), and
/// this end used to `format!` all of them into one `String` that only ever reached a log line. So the
/// desktop could not tell a stale token from a lapsed subscription from an empty balance from the
/// relay actually being down — and neither could anyone debugging it. That discard is why a
/// non-existent production outage was reported four times over two days: the server had computed the
/// exact answer on every attempt and the client threw it away at this boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RelayRefusal {
    /// 401 — no/expired Sparkle bearer. The user can fix this by signing in again.
    Unauthorized,
    /// 402 — entitled, but can't afford the first minute. Actionable: refill.
    InsufficientCredits,
    /// 403 — signed in, but this account isn't entitled to cloud dictation.
    NotEntitled,
    /// 503 — the RELAY is misconfigured (its own Deepgram key is unset). Nothing the user can do.
    Unconfigured,
    /// 429 — this ACCOUNT already holds the relay's per-user limit of concurrent streams. Proves the
    /// relay is healthy and serving; the cause is several Sparkle windows dictating at once, or a
    /// warm-standby socket from the last utterance not yet released (WARM_STANDBY). Self-correcting,
    /// so it must never be reported as an outage — see `as_str`, where the generic `Http` bucket
    /// would have done exactly that.
    TooManyStreams,
    /// Any other non-101 status. Carried numerically rather than collapsed, so an unexpected gate
    /// added server-side shows up in the log as itself instead of as a generic failure.
    Http(u16),
    /// We never got an HTTP answer at all — DNS, TCP, TLS, or the CONNECT_TIMEOUT. Distinct from
    /// every variant above because those PROVE the relay is reachable and serving.
    Unreachable,
    /// Our own side failed (thread spawn, a panicked blocking task). Not the relay's fault, and
    /// separated so a local defect can never be reported to the user as a service outage.
    Local,
}

impl RelayRefusal {
    /// The stable snake_case token handed to the frontend. Kept beside the enum so a new variant
    /// cannot be added without deciding what the UI is told about it.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            RelayRefusal::Unauthorized => "unauthorized",
            RelayRefusal::InsufficientCredits => "insufficient_credits",
            RelayRefusal::NotEntitled => "not_entitled",
            RelayRefusal::Unconfigured => "relay_unconfigured",
            RelayRefusal::TooManyStreams => "too_many_streams",
            RelayRefusal::Http(_) => "unreachable",
            RelayRefusal::Unreachable => "unreachable",
            RelayRefusal::Local => "unreachable",
        }
    }
}

/// A handshake failure: the classified reason PLUS the original message, so the log keeps every
/// detail it had before while the caller gets something it can branch on.
#[derive(Debug, Clone)]
pub(crate) struct RelayError {
    pub refusal: RelayRefusal,
    pub detail: String,
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.detail)
    }
}

impl RelayError {
    fn unreachable(detail: String) -> Self {
        RelayError { refusal: RelayRefusal::Unreachable, detail }
    }
    fn local(detail: String) -> Self {
        RelayError { refusal: RelayRefusal::Local, detail }
    }
}

/// Map a tungstenite handshake error onto a refusal. PURE, so the status→meaning table is unit
/// testable without a relay, a socket, or a network.
///
/// Only `Error::Http` carries a response, and its presence is exactly what proves we reached the
/// relay and it answered. Everything else (Io, Tls, Protocol, …) means no answer arrived, which is
/// a materially different claim and must not be reported as a refusal.
pub(crate) fn classify_handshake_error(err: &tungstenite::Error) -> RelayRefusal {
    match err {
        tungstenite::Error::Http(resp) => match resp.status().as_u16() {
            401 => RelayRefusal::Unauthorized,
            402 => RelayRefusal::InsufficientCredits,
            403 => RelayRefusal::NotEntitled,
            429 => RelayRefusal::TooManyStreams,
            503 => RelayRefusal::Unconfigured,
            other => RelayRefusal::Http(other),
        },
        _ => RelayRefusal::Unreachable,
    }
}

/// Adapter from what `tungstenite::client{,_tls}` actually returns. Thin on purpose: the status→
/// meaning table stays in `classify_handshake_error`, which takes a plain `Error` and so can be
/// tested without constructing a handshake role.
///
/// `Interrupted` means the handshake is mid-flight on a would-block socket — no response yet, so it
/// is Unreachable rather than a refusal. Our sockets are blocking with a read timeout, so this arm
/// is effectively a timeout.
fn classify_handshake<R: tungstenite::handshake::HandshakeRole>(
    err: &tungstenite::HandshakeError<R>,
) -> RelayRefusal {
    match err {
        tungstenite::HandshakeError::Failure(e) => classify_handshake_error(e),
        tungstenite::HandshakeError::Interrupted(_) => RelayRefusal::Unreachable,
    }
}

/// Open the WebSocket to the orchestration relay with the Sparkle bearer as the `Authorization`
/// header. Blocking but bounded by CONNECT_TIMEOUT — callers run it on a blocking worker (never the
/// main/event-loop thread) and treat Err as "fall back to on-device". A non-101 handshake response
/// (the relay's 401/402/403/503 gates) surfaces as Err too, CLASSIFIED — see `RelayRefusal`.
/// run_session resets the socket timeouts to its own values after this returns.
fn connect(
    base_url: &str,
    token: &str,
    sample_rate: u32,
    project: Option<&str>,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, RelayError> {
    let (ws_url, host_port, tls) =
        relay_target(base_url, sample_rate).map_err(RelayError::local)?;
    // into_client_request() fills in the required handshake headers (Host, Upgrade, Sec-*); we
    // only add Authorization (and the metering-only project) on top.
    let mut req = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| RelayError::local(format!("bad relay request: {e}")))?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| RelayError::local("invalid Sparkle auth header".to_string()))?,
    );
    // Metering-only, and NON-FATAL by construction: an unparseable header value is skipped (losing
    // the attribution) rather than failing the connection — the annotation must never be able to
    // break the dictation it annotates.
    if let Some(value) = project_header_value(project) {
        match value.parse() {
            Ok(v) => {
                req.headers_mut().insert("X-Sparkle-Project", v);
            }
            Err(_) => {
                tracing::warn!(target: "dictation", "dropping unencodable project header; minute will be unattributed")
            }
        }
    }
    // Resolve + TCP-connect with a timeout (fail fast when offline), bound the TLS+WS upgrade reads/
    // writes too, then run the handshake over the prepared stream. Try every resolved address (not
    // just the first) so an unreachable record — e.g. an IPv6 addr on an IPv4-only path — doesn't
    // force a fallback when a later address would connect.
    let addrs: Vec<_> = host_port
        .to_socket_addrs()
        .map_err(|e| RelayError::unreachable(format!("relay dns: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err(RelayError::unreachable("relay dns: no address".to_string()));
    }
    // Bounded by CONNECT_TOTAL_BUDGET across ALL addresses, not just CONNECT_TIMEOUT per address:
    // a relay host resolving to many black-holed records must not sum into minutes before we fall
    // back to on-device (sparkle-nimbph). `connect_within_budget` still tries later addresses (the
    // IPv6-dead/IPv4-alive case) while the budget holds.
    let tcp = connect_within_budget(&addrs, CONNECT_TOTAL_BUDGET, Instant::now, |addr, per| {
        TcpStream::connect_timeout(addr, per).map_err(|e| e.to_string())
    })
    .map_err(|last_err| RelayError::unreachable(format!("relay connect failed: {last_err}")))?;
    let _ = tcp.set_read_timeout(Some(CONNECT_TIMEOUT));
    let _ = tcp.set_write_timeout(Some(CONNECT_TIMEOUT));
    if tls {
        // THE STATUS IS READ HERE, NOT DISCARDED. `classify_handshake_error` keeps the relay's own
        // answer (401/402/403/503) as a value the caller can branch on; the message still goes into
        // `detail` for the log, so nothing that was available before is lost.
        let (socket, _resp) = tungstenite::client_tls(req, tcp).map_err(|e| RelayError {
            refusal: classify_handshake(&e),
            detail: format!("relay handshake failed: {e}"),
        })?;
        Ok(socket)
    } else {
        // Plaintext (local dev, e.g. ws://localhost:3001): wrap the TcpStream as MaybeTlsStream::Plain
        // so the returned socket has the same type as the TLS path (set_socket_timeouts handles both).
        let (socket, _resp) =
            tungstenite::client(req, MaybeTlsStream::Plain(tcp)).map_err(|e| RelayError {
                refusal: classify_handshake(&e),
                detail: format!("relay handshake failed: {e}"),
            })?;
        Ok(socket)
    }
}

/// Set the read AND write timeouts on the underlying TCP socket (works for both plaintext and
/// rustls TLS). The read timeout lets the worker's `read()` return promptly with a
/// WouldBlock/TimedOut error instead of blocking forever, so one thread can interleave sending
/// audio and reading results. The write timeout matters for the teardown guarantee: without it a
/// `socket.write` on a stalled uplink (full TLS send buffer) could block the worker indefinitely
/// — and since `finish()` joins the worker, that would make the stop path hang on the kernel TCP
/// timeout. Bounding both keeps `finish()` actually bounded.
fn set_socket_timeouts(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    read: Duration,
    write: Duration,
) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(Some(read));
            let _ = s.set_write_timeout(Some(write));
        }
        MaybeTlsStream::Rustls(s) => {
            // StreamOwned exposes its underlying TcpStream as the public `sock` field.
            let _ = s.sock.set_read_timeout(Some(read));
            let _ = s.sock.set_write_timeout(Some(write));
        }
        // MaybeTlsStream is #[non_exhaustive]. Both the wss:// (Rustls) and local ws:// (Plain, set
        // explicitly in `connect`) paths are handled above. Fail LOUD if a future TLS backend change
        // lands another variant here — silently no-op'ing would leave read()/write() unbounded and
        // quietly defeat finish()'s bounded-join guarantee.
        _ => {
            tracing::warn!(
                target: "dictation",
                "relay socket: unhandled stream variant; read/write timeouts NOT set — finish() may not be bounded"
            );
            debug_assert!(false, "set_socket_timeouts: unhandled MaybeTlsStream variant");
        }
    }
}

/// True for the I/O errors that mean "the read timed out, nothing to read yet" (vs a real error).
fn is_timeout(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

/// Whether a warm-standby socket has idled past its reuse window and should be closed. Pure so the
/// boundary is unit-testable without a real clock.
fn warm_expired(elapsed: Duration, window: Duration) -> bool {
    elapsed >= window
}

/// Whether a warm socket is close enough to its next per-minute debit that it must be closed NOW,
/// regardless of how much of `WARM_STANDBY` is left.
///
/// THIS IS THE HALF THAT MAKES THE LONG WARM WINDOW FREE. `WARM_STANDBY` is measured from the PAUSE;
/// billing is measured from the socket OPEN. Without this, a socket opened at t=0 and paused at
/// t=30 would be held until t=85 and cross the 60 s boundary — silently charging a SECOND minute to
/// save one handshake, which is the opposite of the trade this window exists to make. With it the
/// socket is closed at `PAID_MINUTE - PAID_MINUTE_SAFETY` from open, so warm standby can never add
/// a debit: it only ever spends minutes the user has already been charged for.
///
/// Pure, and takes both durations, so the interaction of the two deadlines is unit-testable without
/// a clock or a relay — a test on the idle window alone cannot see this one at all.
/// MEASURED WITHIN THE CURRENT BILLING QUANTUM, NOT FROM OPEN (roborev 61450, Medium). The relay
/// debits a minute on open AND one every 60 s after, so a 70-second-old socket is already paid
/// through t=120 and is just as free to hold as a 10-second-old one. Comparing absolute age against
/// 60 s made this permanently true past t=54, which silently switched warm standby OFF for every
/// session that dictated for more than ~54 s — the exact opposite of the rationale above, since
/// those holds then paid a fresh handshake AND a fresh debit while the minute they had already been
/// charged for went unused.
fn paid_minute_nearly_spent(since_open: Duration, paid: Duration, safety: Duration) -> bool {
    if paid.is_zero() {
        return true; // no billing quantum to reason about — never hold speculatively
    }
    let into_minute = Duration::from_secs(since_open.as_secs() % paid.as_secs());
    into_minute.saturating_add(safety) >= paid
}

/// The whole warm-standby close decision: idle window OR paid-minute guard, whichever comes first.
/// One function so the two deadlines cannot drift apart at the call site.
fn warm_deadline_passed(idle: Duration, since_open: Duration) -> bool {
    warm_expired(idle, WARM_STANDBY)
        || paid_minute_nearly_spent(since_open, PAID_MINUTE, PAID_MINUTE_SAFETY)
}

/// What a worker tick should do with a socket that is parked in warm standby.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum WarmTick {
    /// A deadline passed — CloseStream and wind the session down.
    Close,
    /// Still warm and the heartbeat is due — write `KEEPALIVE_MSG`.
    Heartbeat,
    /// Still warm, heartbeat not due yet — do nothing this tick.
    Wait,
}

/// The whole paused-tick decision, extracted so the heartbeat is guarded by something other than
/// relationships between constants (roborev 61450, Medium).
///
/// The previous test asserted only that `KEEPALIVE_EVERY < DEEPGRAM_IDLE_CLOSE` and what
/// `KEEPALIVE_MSG` contains — both true before the heartbeat existed. Deleting the entire send block
/// from `run_session` left it green while every "warm" socket silently died at ~10 s and reuse past
/// that reverted to a full handshake: the defect this change exists to fix, reintroduced invisibly.
/// That is the vacuous-test shape AGENTS.md calls out, so the DECISION now lives here where a test
/// can drive it. (The `socket.write` itself remains inside the loop, which is not hermetically
/// testable without a transport trait — the same acknowledged gap `run_session` already documents
/// for every other write it makes.)
///
/// `since_keepalive` is `None` when no heartbeat has been sent since the park, which is due
/// immediately — the caller seeds it at the pause so the first one falls a full interval later.
pub(crate) fn warm_tick(
    idle: Duration,
    since_open: Duration,
    since_keepalive: Option<Duration>,
) -> WarmTick {
    if warm_deadline_passed(idle, since_open) {
        return WarmTick::Close;
    }
    match since_keepalive {
        Some(elapsed) if elapsed < KEEPALIVE_EVERY => WarmTick::Wait,
        _ => WarmTick::Heartbeat,
    }
}

/// PERFORM the tick — i.e. write the frame it calls for — through an injectable text sink.
///
/// THE DECISION WAS TESTED; THE ACTION WAS NOT, and the action is the half whose absence silently
/// reverts the feature (roborev 61465, Medium). With the write inline in `run_session`, deleting the
/// single `socket.write(Message::text(KEEPALIVE_MSG))` line left `warm_tick`'s test, the constants
/// test and the whole suite green — while every parked socket died at Deepgram's ~10 s idle close
/// and the 55 s window became a lie, with nothing logged. That is the "assert the SIDE EFFECT, not
/// the precondition" rule in AGENTS.md, and the heartbeat is exactly the case it is written for.
///
/// A `&mut dyn FnMut(&str)` rather than a full transport trait: this keeps the seam to the frames
/// this tick emits, without abstracting the loop's reads — the indirection `run_session` weighed and
/// declined for the whole socket. Errors are deliberately swallowed by the caller's sink, matching
/// the surrounding policy (a write timeout is transient; a genuinely dead socket is caught by the
/// read path, which owns the exit).
pub(crate) fn apply_warm_tick(tick: WarmTick, send_text: &mut dyn FnMut(&str)) -> WarmOutcome {
    match tick {
        // Ends the session — the caller then shrinks its timeouts and enters the drain.
        WarmTick::Close => {
            send_text(CLOSE_STREAM_MSG);
            WarmOutcome::Closing
        }
        // Keeps Deepgram's idle close from taking the socket out from under a parked session.
        WarmTick::Heartbeat => {
            send_text(KEEPALIVE_MSG);
            WarmOutcome::Parked { beat: true }
        }
        // Still warm, nothing due: the socket must stay silent, NOT be poked every poll interval.
        WarmTick::Wait => WarmOutcome::Parked { beat: false },
    }
}

/// What `run_session`'s loop must do to its own state after a warm tick.
///
/// RETURNED rather than re-derived, so the write and the state transition cannot disagree about
/// which tick happened. The previous shape matched on `tick` TWICE — once to write the frame, once
/// to move `closing`/`warm_since`/`last_keepalive` — which is a drift hazard of its own: an edit to
/// one match compiles perfectly well against a stale other.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum WarmOutcome {
    /// Still parked. `beat` is true when a heartbeat was just written, so the caller restamps its
    /// keepalive clock — the one piece of state only the caller can hold (it owns the `Instant`).
    Parked { beat: bool },
    /// CloseStream was written: the caller shrinks its timeouts and enters the drain.
    Closing,
}

/// ONE warm-standby tick, end to end: decide, WRITE the frame, and say what the loop must do next.
///
/// THE POINT IS THAT THE WRITE IS NOT OPTIONAL HERE (roborev 61471, Medium). Extracting only the
/// frame mapping relocated the regression rather than removing it: deleting the call to it left the
/// state transitions still flipping while nothing reached the wire — no KeepAlive (so every parked
/// socket dies at Deepgram's ~10 s idle close and the 55 s window is a lie) and no CloseStream (so
/// the warm deadline stops flushing the trailing final and the drain reads nothing). Folding the
/// decision, the write and the state instruction into one call makes the tick a single testable
/// unit, driveable over a simulated park with a recording sink.
///
/// Durations rather than `Instant`s so the whole thing is clock-free and a test can simulate a park
/// of any length; the caller converts. The residual — that this one call could itself be deleted —
/// is irreducible without threading a sink through `run_session`'s reads too, i.e. the transport
/// trait this module weighed and declined for a single call site. It is now one call whose removal
/// deletes the ENTIRE paused branch rather than silently keeping its bookkeeping.
pub(crate) fn run_warm_standby_tick(
    idle: Duration,
    since_open: Duration,
    since_keepalive: Option<Duration>,
    send_text: &mut dyn FnMut(&str),
) -> WarmOutcome {
    apply_warm_tick(warm_tick(idle, since_open, since_keepalive), send_text)
}

/// The worker loop: interleave sending queued audio with reading relay messages, emitting
/// interim/final transcript events + balance updates, until the stream is closed or the socket
/// errors / the relay signals exhaustion.
///
/// Test coverage: the pure helpers (`relay_target`, `f32_to_pcm16le`, `parse_deepgram_message`,
/// `parse_relay_control`, `classify_relay_frame`, `warm_expired`) are unit-tested. This loop's
/// timeout/`closing`-drain/pre-ready-buffer state machine is NOT exercised hermetically — doing so
/// would require abstracting the socket behind a transport trait, which we judged not worth the
/// indirection for this single call site.
/// What a frame means for the once-per-utterance speech-end signal.
///
/// Split out of `run_session` so the rule is testable without a socket: the loop it lives in needs a
/// live Deepgram connection, and this is the part with an actual invariant to prove.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum SpeechEndAction {
    /// Emit `dictation://speech-end` and remember that this utterance has now reported.
    Emit,
    /// Say nothing — either speech is in progress, or this utterance already reported.
    Hold,
}

/// Decide whether a frame should emit a speech-end, given whether this utterance already did.
///
/// `sent` is updated in place, and clearing it is as load-bearing as suppressing the duplicate:
/// without the clear, the FIRST utterance would signal and every one after it would be silent.
pub(crate) fn speech_end_action(frame: &RelayFrame, sent: &mut bool) -> SpeechEndAction {
    match frame {
        // A finished transcript: the ~200ms `endpointing` half of Deepgram's pair.
        RelayFrame::Partial(_, SpeechEnd::Ended) | RelayFrame::UtteranceEnd => {
            if *sent {
                SpeechEndAction::Hold
            } else {
                *sent = true;
                SpeechEndAction::Emit
            }
        }
        // Speech is in progress again — the next ending belongs to a new utterance.
        RelayFrame::Partial(_, _) | RelayFrame::Interim(_) => {
            *sent = false;
            SpeechEndAction::Hold
        }
        _ => SpeechEndAction::Hold,
    }
}

fn run_session(
    app: AppHandle,
    mut socket: WebSocket<MaybeTlsStream<TcpStream>>,
    audio_rx: Receiver<AudioMsg>,
    suppress_ended: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    // Set by `silence_now()`: drop transcripts on the floor for the rest of this session, so a
    // teardown that overlaps a successor session can't inject text into it. See the `muted` field.
    muted: Arc<AtomicBool>,
) {
    set_socket_timeouts(&mut socket, READ_TIMEOUT, WRITE_TIMEOUT);
    let mut closing = false;
    let mut drain_ticks = 0u32;
    // Warm standby: set on Pause, cleared on Resume. While paused the worker sends no audio and just
    // keeps the socket open until the user resumes (instant reuse) or `WARM_STANDBY` elapses.
    let mut paused = false;
    let mut warm_since: Option<Instant> = None;
    // When this socket opened, i.e. when the relay debited its first minute. The warm-standby close
    // is bounded by BOTH the idle window and this, so holding a socket warm can never tip the
    // session into a second billed minute — see `paid_minute_nearly_spent`.
    let opened_at = Instant::now();
    // Last idle heartbeat. `None` while routing; set on the first keepalive of a park so the first
    // one is sent a full interval after the pause rather than immediately.
    let mut last_keepalive: Option<Instant> = None;
    // The relay drops any client audio it receives before it sends `ready` (the first-minute debit
    // clearing + its Deepgram upstream opening). Buffer frames until then so we don't clip the first
    // words. `ready` persists across pause/resume — the relay's metering is per-connection.
    let mut ready = false;
    let mut prebuffer: VecDeque<Vec<u8>> = VecDeque::new();
    // Set when the relay tells us the user ran out of credits, so the cloud-ended emit on exit can
    // tell the frontend to refresh the (now-depleted) balance rather than treat it as a clean close.
    let mut exhausted = false;

    // ONE speech-end per utterance, which is what `dictation://speech-end` promises and what
    // `dictationStore.speechEndSeq` is documented to count.
    //
    // With `endpointing=200` AND `utterance_end_ms=1000` both enabled, Deepgram reports the SAME
    // silence twice: `speech_final=true` rides a Results frame ~200ms after the last word, and the
    // standalone `UtteranceEnd` frame follows ~800ms later for the same gap. Deepgram's own guidance
    // is to remember that a `speech_final` was seen and drop the trailing `UtteranceEnd`; without
    // that, every ordinary utterance emits two.
    //
    // Today the auto-send rail absorbs the double by accident — `noteSpeechEnd` early-returns while
    // a clock is already running — but the contract is what future consumers will code against, and
    // anything that COUNTS utterances, announces, or re-anchors on the signal would get two.
    // Deduped here, at the source, so there is one true statement rather than one guard per reader.
    //
    // Cleared by any frame that shows speech in progress again (an interim, or a non-final
    // transcript), which is what makes the next utterance's end a fresh signal.
    let mut speech_end_sent = false;

    'session: loop {
        // 0) Warm-standby expiry: paused with no resume for the whole window → close cleanly (well
        // before Deepgram's own idle timeout). Falls into the normal `closing` drain/exit below.
        if paused {
            if let Some(since) = warm_since {
                // The decision AND the write both live in `run_warm_standby_tick`, so they are
                // covered by a test rather than by this loop, which is not hermetically driveable.
                // Scoped so the mutable borrow of `socket` ends before the transitions below
                // re-borrow it.
                //
                // A write timeout inside the sink is transient (a full send buffer) and is NOT
                // fatal: the frame stays buffered and the next tick retries. A genuinely dead socket
                // is caught by the read path below, which owns the exit — killing the session here
                // would tear down a warm socket on ordinary WiFi jitter.
                let outcome = {
                    let mut send_text = |s: &str| {
                        let _ = socket.write(Message::text(s));
                    };
                    run_warm_standby_tick(
                        since.elapsed(),
                        opened_at.elapsed(),
                        last_keepalive.map(|t| t.elapsed()),
                        &mut send_text,
                    )
                };
                match outcome {
                    WarmOutcome::Closing => {
                        set_socket_timeouts(&mut socket, READ_TIMEOUT, READ_TIMEOUT);
                        closing = true;
                        paused = false;
                        warm_since = None;
                        last_keepalive = None;
                    }
                    // Only the caller can hold the `Instant`. Restamped only when a heartbeat was
                    // actually written — the returned flag, not a second guess at the tick.
                    // Cleared on Resume, since a routing session's audio frames are its own
                    // keepalive.
                    WarmOutcome::Parked { beat: true } => last_keepalive = Some(Instant::now()),
                    WarmOutcome::Parked { beat: false } => {}
                }
            }
        }

        // 1) Drain and send all currently-queued audio (non-blocking).
        loop {
            match audio_rx.try_recv() {
                // Drop frames once closing (post-CloseStream) OR while paused (warm standby sends no
                // audio). In practice none arrive while paused — the capture callback routes frames
                // on-device when cloud_active is false — but guard defensively.
                Ok(AudioMsg::Frame(_)) if closing || paused => {}
                // Not yet `ready`: buffer (bounded) rather than send, so the relay doesn't drop these
                // pre-metering frames and clip the utterance's opening words.
                Ok(AudioMsg::Frame(bytes)) if !ready => {
                    if prebuffer.len() >= MAX_PREREADY_FRAMES {
                        prebuffer.pop_front(); // drop oldest; bound memory if `ready` never comes
                    }
                    prebuffer.push_back(bytes);
                }
                Ok(AudioMsg::Frame(bytes)) => {
                    match socket.write(Message::binary(bytes)) {
                        Ok(()) => {}
                        // A write timeout is a transient stall (full send buffer), NOT a dead
                        // socket: tungstenite keeps the frame buffered, so stop draining this pass
                        // and let the next flush()/iteration retry it. Killing the session here
                        // would drop a healthy stream (and queued audio) on brief WiFi jitter.
                        Err(tungstenite::Error::Io(ref e)) if is_timeout(e) => break,
                        // Any other error means the socket is genuinely dead — break the SESSION
                        // loop (not just this drain) so we fall through to emit_cloud_ended, exactly
                        // like the read-error path. Returning here instead would skip that event and
                        // strand dictation (cloud_active stuck true, no on-device resume).
                        Err(_) => break 'session,
                    }
                }
                // Pause: Finalize the current utterance (trailing text still commits) and enter warm
                // standby — keep the socket for instant reuse. Ignored once closing (teardown wins).
                Ok(AudioMsg::Pause) if !closing => {
                    if !paused {
                        let _ = socket.write(Message::text(FINALIZE_MSG));
                        paused = true;
                        warm_since = Some(Instant::now());
                        // First heartbeat falls a full KEEPALIVE_EVERY after the pause, not now:
                        // Finalize has just been written, so the link is demonstrably alive.
                        last_keepalive = Some(Instant::now());
                    }
                    break; // go read the trailing final(s) Finalize will produce
                }
                Ok(AudioMsg::Pause) => {} // already closing — nothing to warm
                // Resume: a new utterance reuses this warm socket — leave standby, keep draining.
                Ok(AudioMsg::Resume) => {
                    paused = false;
                    warm_since = None;
                    last_keepalive = None; // audio frames are their own keepalive while routing
                }
                Ok(AudioMsg::Close) | Err(TryRecvError::Disconnected) => {
                    // Begin shutdown — but exactly once. A dropped sender (Drop-without-finish())
                    // leaves the channel permanently Disconnected, so without the !closing guard we
                    // would re-send CloseStream and re-shrink the timeouts on every drain iteration.
                    // First entry: buffer the CloseStream (don't treat a write timeout as fatal —
                    // mirroring the frame path: the bytes stay buffered and the drain below flushes
                    // them if the link is up) and shrink the write timeout to the read interval so the
                    // post-close flush()/read drain is bounded by the read-tick budget (~2 s) instead
                    // of WRITE_TIMEOUT — a wedged link can't stretch teardown, yet a recovered link
                    // still gets the CloseStream out and yields the trailing final.
                    if !closing {
                        let _ = socket.write(Message::text(CLOSE_STREAM_MSG));
                        set_socket_timeouts(&mut socket, READ_TIMEOUT, READ_TIMEOUT);
                        closing = true;
                    }
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        // Best-effort flush. Cheap once closing (the write timeout was shrunk to the read interval),
        // so this both pushes the buffered CloseStream on a recovered link and stays bounded on a
        // wedged one.
        let _ = socket.flush();

        // 2) Read one message (bounded by the read timeout), acting on the transcript/control it
        // carries.
        match socket.read() {
            Ok(Message::Text(txt)) => {
              let frame = classify_relay_frame(txt.as_str());
              // Decided BEFORE the match, from one rule, so the two frame types that can report the
              // same silence cannot drift apart (see speech_end_action).
              let speech_end = speech_end_action(&frame, &mut speech_end_sent);
              match frame {
                // Muted (a discarded session draining alongside its successor) → drop the transcript
                // rather than emit it into whatever session is live now.
                RelayFrame::Partial(t, _) => {
                    if !muted.load(Ordering::Relaxed) {
                        emit_partial(&app, "deepgram", t);
                        // AFTER the transcript, never before: the rail recomputes its confidence
                        // threshold from the text and then measures accumulated silence against it,
                        // so a speech-end that arrived first would be evaluated against the
                        // PREVIOUS sentence. Same thread, same order the frames were parsed in.
                        if speech_end == SpeechEndAction::Emit {
                            emit_speech_end(&app);
                        }
                    }
                }
                RelayFrame::Interim(t) => {
                    if !muted.load(Ordering::Relaxed) {
                        emit_interim(&app, t)
                    }
                }
                // The speaker went quiet with no transcript attached (`utterance_end_ms` elapsed).
                // Muted sessions stay silent for the same reason they drop transcripts: a discarded
                // session draining alongside its successor must not arm anything in the live one.
                RelayFrame::UtteranceEnd => {
                    // Only when `speech_final` did NOT already report this same silence. This is the
                    // trailing half of Deepgram's pair, ~800ms behind (see speech_end_action).
                    if !muted.load(Ordering::Relaxed) && speech_end == SpeechEndAction::Emit {
                        emit_speech_end(&app);
                    }
                }
                RelayFrame::Control(RelayControl::Ready) => {
                    // Metering is live — flush the frames we buffered during the relay→Deepgram open
                    // (oldest first), then stream directly from here on. A write timeout does NOT lose
                    // the frame — tungstenite retains it in its outgoing buffer — so we keep queueing
                    // the rest (bounded by MAX_PREREADY_FRAMES) and let them flush in FIFO order when
                    // the link drains, rather than `break`ing and discarding the tail (which would
                    // re-introduce the opening-word clipping this buffer exists to prevent). Only a
                    // hard socket error tears the session down.
                    if !ready {
                        ready = true;
                        while let Some(bytes) = prebuffer.pop_front() {
                            match socket.write(Message::binary(bytes)) {
                                Ok(()) => {}
                                Err(tungstenite::Error::Io(ref e)) if is_timeout(e) => {}
                                Err(_) => break 'session,
                            }
                        }
                        let _ = socket.flush();
                    }
                }
                RelayFrame::Control(RelayControl::Balance { balance_cents, debited_cents }) => {
                    // Server-authoritative post-debit balance → tick the credits pill.
                    emit_cloud_balance(&app, balance_cents, debited_cents);
                }
                RelayFrame::Control(RelayControl::Exhausted) => {
                    // Out of credits — tear down and fall back on-device (flag the refresh).
                    tracing::info!(target: "dictation", "relay signalled out-of-credits; falling back on-device");
                    exhausted = true;
                    break;
                }
                RelayFrame::Control(RelayControl::Error) => {
                    tracing::debug!(target: "dictation", "relay signalled upstream error");
                    break;
                }
                RelayFrame::Ignore => {}
              }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {} // Ping/Pong/Binary — ignore (pongs are auto-queued and flushed above)
            Err(tungstenite::Error::Io(ref e)) if is_timeout(e) => {
                // No message within the timeout. If we're winding down, count toward the drain
                // budget so we don't wait forever for a server close that may not come.
                if closing {
                    drain_ticks += 1;
                    if drain_ticks >= DRAIN_TICKS_AFTER_CLOSE {
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::debug!(target: "dictation", error = %e, "relay stream ended");
                break;
            }
        }
    }
    // Mark dead BEFORE the cloud-ended emit so any concurrent reuse check (is_alive) sees the truth.
    alive.store(false, Ordering::Relaxed);
    tracing::info!(target: "dictation", "cloud relay stream closed");
    // Tell the frontend the cloud stream is gone (clean close OR mid-stream failure / exhaustion) so
    // it clears the interim preview and calls stop_cloud_stream — resuming on-device routing/fallback.
    // `exhausted` asks the frontend to refresh the (now-depleted) balance. Skipped for a discarded
    // orphan (see silence_now()), whose event would otherwise stop the current session.
    if !suppress_ended.load(Ordering::Relaxed) {
        emit_cloud_ended(&app, exhausted);
    }
}

#[cfg(test)]
mod speech_end_dedupe {
    use super::*;

    fn partial(final_: bool) -> RelayFrame {
        RelayFrame::Partial(
            "ship it".to_string(),
            if final_ { SpeechEnd::Ended } else { SpeechEnd::Continuing },
        )
    }

    /// THE BUG. With `endpointing=200` AND `utterance_end_ms=1000` both on, Deepgram reports the
    /// SAME silence twice — `speech_final` on a Results frame ~200ms after the last word, then a
    /// standalone `UtteranceEnd` ~800ms later. Emitting both makes `speechEndSeq` count two
    /// utterances where the user spoke one, contradicting what both doc comments promise.
    #[test]
    fn the_trailing_utterance_end_does_not_re_report_the_same_silence() {
        let mut sent = false;
        assert_eq!(speech_end_action(&partial(true), &mut sent), SpeechEndAction::Emit);
        assert_eq!(
            speech_end_action(&RelayFrame::UtteranceEnd, &mut sent),
            SpeechEndAction::Hold,
            "the ~800ms-later UtteranceEnd describes the silence speech_final already reported"
        );
    }

    /// The mirror failure, and the reason the flag must be CLEARED rather than merely set: suppress
    /// without clearing and only the first utterance of a session ever signals.
    #[test]
    fn the_next_utterance_signals_again() {
        let mut sent = false;
        assert_eq!(speech_end_action(&partial(true), &mut sent), SpeechEndAction::Emit);
        // The user starts talking again.
        assert_eq!(
            speech_end_action(&RelayFrame::Interim("and also".into()), &mut sent),
            SpeechEndAction::Hold
        );
        assert_eq!(speech_end_action(&partial(true), &mut sent), SpeechEndAction::Emit);
    }

    #[test]
    fn a_non_final_transcript_also_reopens_the_utterance() {
        let mut sent = false;
        assert_eq!(speech_end_action(&RelayFrame::UtteranceEnd, &mut sent), SpeechEndAction::Emit);
        assert_eq!(speech_end_action(&partial(false), &mut sent), SpeechEndAction::Hold);
        assert_eq!(speech_end_action(&partial(true), &mut sent), SpeechEndAction::Emit);
    }

    /// UtteranceEnd alone is the whole signal when no transcript carried one — the case
    /// `utterance_end_ms` exists for (the speaker trailed off with nothing transcribable).
    #[test]
    fn an_utterance_end_with_no_preceding_speech_final_still_reports() {
        let mut sent = false;
        assert_eq!(speech_end_action(&RelayFrame::UtteranceEnd, &mut sent), SpeechEndAction::Emit);
    }
}

/// Keeps a test session's audio channel OPEN. Holding it is what makes `pause()`/`resume()` land
/// in a real channel instead of silently no-opping on a disconnected one — so a test that drops it
/// early is asserting against a dead session without noticing. Opaque on purpose: `AudioMsg` is
/// private to this module and should stay that way.
#[cfg(test)]
pub(crate) struct ParkedChannel(std::sync::mpsc::Receiver<AudioMsg>);

#[cfg(test)]
impl ParkedChannel {
    /// Did a `Pause` actually reach the worker? Non-blocking, and it CONSUMES the message.
    ///
    /// This exists because the `parked` atomic is the lesser half of `pause()`. The atomic is just a
    /// flag `should_keep_warm_on_stop` reads; the MESSAGE is what stops the worker forwarding audio
    /// and starts the warm timer — the two behaviours the park path actually depends on. A test that
    /// asserts only `is_parked()` stays green with the `send` deleted, while a parked socket would
    /// keep relaying audio until the relay's upstream idle close (roborev 55315). Opaque because
    /// `AudioMsg` is private to this module and should stay that way.
    pub(crate) fn took_pause(&self) -> bool {
        matches!(self.0.try_recv(), Ok(AudioMsg::Pause))
    }
}

/// A session with no socket and no worker, for tests ANYWHERE in this crate (`dictation.rs` uses it
/// to exercise the warm-standby slot). `pause`/`resume`/`is_parked`/`audio_sender` only touch the
/// audio channel and the flags, so this exercises them without a live relay.
#[cfg(test)]
pub(crate) fn parkable_session() -> (DeepgramSession, ParkedChannel) {
    let (tx, rx) = std::sync::mpsc::channel::<AudioMsg>();
    let session = DeepgramSession {
        audio_tx: tx,
        worker: None,
        // FALSE, matching `DeepgramSession::start` — and load-bearing for anything asserting
        // `silence_now()`. A fixture that starts pre-suppressed makes `is_silenced()` prove only its
        // `muted` half, so deleting the suppress_ended store from `silence_now` would leave the
        // displaced-socket test green while a torn-down worker emits `cloud-ended` into its
        // successor: the exact hazard that test guards (roborev 55315).
        suppress_ended: Arc::new(AtomicBool::new(false)),
        alive: Arc::new(AtomicBool::new(true)),
        parked: Arc::new(AtomicBool::new(false)),
        muted: Arc::new(AtomicBool::new(false)),
        project: None,
        // FALSE, matching `DeepgramSession::start`, and for the same reason as `suppress_ended`
        // above: a fixture that started pre-marked would make every "the pre-connect marked it"
        // assertion vacuous, and would let the blur-release test pass against a socket the user
        // actually dictated into.
        speculative: Arc::new(AtomicBool::new(false)),
    };
    (session, ParkedChannel(rx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// THE FIX (sparkle-nimbph): the address-connect loop must stop at CONNECT_TOTAL_BUDGET, not
    /// dial every DNS record. Before this, a relay host resolving to many black-holed addresses
    /// spent CONNECT_TIMEOUT (8s) on EACH — 20 records × 8s ≈ 2.7 minutes of a dead microphone
    /// before the fall-back-to-on-device could fire.
    ///
    /// The SIDE EFFECT asserted is the wall-clock bound itself: with an injected clock that advances
    /// by each attempt's full timeout (a black hole consumes its whole budget), the loop makes only
    /// as many attempts as fit in the budget and the total elapsed never exceeds it — regardless of
    /// how many addresses DNS returned. A test that only counted addresses could not see the sum.
    #[test]
    fn the_connect_loop_stops_at_the_total_budget_not_after_every_resolved_address() {
        let start = Instant::now();
        let elapsed = Cell::new(Duration::ZERO);
        let now = || start + elapsed.get();
        // Twenty resolved records, all black-holed: the pathological shape the founder hit.
        let addrs: Vec<SocketAddr> = (0..20)
            .map(|i| SocketAddr::from(([10, 0, 0, i as u8], 443)))
            .collect();
        let dials = Cell::new(0u32);
        let budget = Duration::from_secs(16);

        let result: Result<(), String> =
            connect_within_budget(&addrs, budget, now, |_addr, per| {
                dials.set(dials.get() + 1);
                // A black-holed address burns its ENTIRE per-attempt allowance, then fails.
                elapsed.set(elapsed.get() + per);
                Err("timed out".to_string())
            });

        assert!(
            result.is_err(),
            "every address black-holed → Err, so the caller falls back to on-device"
        );
        // 16s budget ÷ 8s per full-timeout attempt = exactly two attempts, then the budget is spent
        // and the loop stops with 18 records still untried. The bug dialed all 20 (≈2.7 min).
        assert_eq!(
            dials.get(),
            2,
            "must stop when the total budget is spent, not dial every resolved address"
        );
        assert!(
            elapsed.get() <= budget,
            "total connect wall-clock {:?} must not exceed the budget {:?}",
            elapsed.get(),
            budget
        );
    }

    /// The CAPABILITY the cap must not break: the loop still moves past a dead address to a live one
    /// (the documented IPv6-record-on-an-IPv4-only-path case). This is the paired test — the bound
    /// above proves the loop STOPS; this proves it does not stop too soon and strand a reachable
    /// relay. A budget mistakenly tightened below one full timeout would make attempt #2 unreachable
    /// and red this test while the bound test stayed green.
    #[test]
    fn a_live_address_after_a_black_holed_one_still_connects_within_budget() {
        let start = Instant::now();
        let elapsed = Cell::new(Duration::ZERO);
        let now = || start + elapsed.get();
        let live = SocketAddr::from(([203, 0, 113, 2], 443));
        let addrs: Vec<SocketAddr> = vec![SocketAddr::from(([203, 0, 113, 1], 443)), live];
        let dials = Cell::new(0u32);

        let result = connect_within_budget(&addrs, Duration::from_secs(16), now, |addr, per| {
            dials.set(dials.get() + 1);
            if *addr == live {
                Ok("connected")
            } else {
                // The first record is black-holed: it consumes its whole per-attempt allowance.
                elapsed.set(elapsed.get() + per);
                Err("timed out".to_string())
            }
        });

        assert_eq!(
            result,
            Ok("connected"),
            "the loop must skip past the dead record and connect on the live one"
        );
        assert_eq!(dials.get(), 2, "both records were tried within the budget");
    }

    /// Build the shape tungstenite hands us when the relay ANSWERED with a non-101 status.
    fn http_err(status: u16) -> tungstenite::Error {
        let resp = tungstenite::http::Response::builder()
            .status(status)
            .body(None)
            .expect("valid test response");
        tungstenite::Error::Http(resp)
    }

    /// THE POINT OF THE WHOLE CHANGE: each of the relay's gates must come back as its OWN value.
    /// Asserted as a set of DISTINCT results rather than one-by-one, because the defect being fixed
    /// was precisely that they all collapsed together — a test that checked them individually
    /// against a single expected value would still pass if two of them merged.
    #[test]
    fn each_relay_gate_classifies_to_its_own_refusal() {
        assert_eq!(classify_handshake_error(&http_err(401)), RelayRefusal::Unauthorized);
        assert_eq!(classify_handshake_error(&http_err(402)), RelayRefusal::InsufficientCredits);
        assert_eq!(classify_handshake_error(&http_err(403)), RelayRefusal::NotEntitled);
        assert_eq!(classify_handshake_error(&http_err(429)), RelayRefusal::TooManyStreams);
        assert_eq!(classify_handshake_error(&http_err(503)), RelayRefusal::Unconfigured);

        // …and they are mutually distinct. This is the assertion the old `String` could never
        // satisfy: five causes, five different answers.
        let all = [
            classify_handshake_error(&http_err(401)),
            classify_handshake_error(&http_err(402)),
            classify_handshake_error(&http_err(403)),
            classify_handshake_error(&http_err(429)),
            classify_handshake_error(&http_err(503)),
        ];
        for (i, a) in all.iter().enumerate() {
            for (j, b) in all.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "gates {i} and {j} must not collapse onto one refusal");
                }
            }
        }
    }

    /// An unexpected status still proves the relay ANSWERED, so it keeps its number rather than
    /// being flattened into the no-answer case.
    #[test]
    fn an_unmapped_status_keeps_its_number() {
        assert_eq!(classify_handshake_error(&http_err(500)), RelayRefusal::Http(500));
        // 418 stands in for "a status this client has no arm for". 429 used to sit here; it is a
        // MAPPED gate now (the relay's per-user concurrency cap), and leaving it in this test would
        // have re-pinned the very collapse the cap's client arm exists to undo.
        assert_eq!(classify_handshake_error(&http_err(418)), RelayRefusal::Http(418));
    }

    /// A transport failure is NOT a refusal — nothing was answered. Conflating the two is what let a
    /// healthy relay be reported as refusing (and a genuinely down one as merely unauthorized).
    #[test]
    fn a_transport_failure_is_unreachable_not_a_refusal() {
        let io = tungstenite::Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "refused",
        ));
        assert_eq!(classify_handshake_error(&io), RelayRefusal::Unreachable);

        let proto =
            tungstenite::Error::Protocol(tungstenite::error::ProtocolError::WrongHttpMethod);
        assert_eq!(classify_handshake_error(&proto), RelayRefusal::Unreachable);
    }

    /// The wire tokens are a CONTRACT with the frontend's `CloudStreamOutcome` union — pin them, so
    /// a rename here fails here instead of silently falling through to the banner's default copy.
    #[test]
    fn refusal_tokens_are_pinned() {
        assert_eq!(RelayRefusal::Unauthorized.as_str(), "unauthorized");
        assert_eq!(RelayRefusal::InsufficientCredits.as_str(), "insufficient_credits");
        assert_eq!(RelayRefusal::NotEntitled.as_str(), "not_entitled");
        assert_eq!(RelayRefusal::Unconfigured.as_str(), "relay_unconfigured");
        assert_eq!(RelayRefusal::TooManyStreams.as_str(), "too_many_streams");
        assert_eq!(RelayRefusal::Unreachable.as_str(), "unreachable");
        // The cap's whole point on this side: it must NOT share a token with the no-answer case, or
        // a healthy relay gets reported as an outage again.
        assert_ne!(RelayRefusal::TooManyStreams.as_str(), RelayRefusal::Unreachable.as_str());
    }

    #[test]
    fn warm_expires_only_at_or_past_the_window() {
        let window = Duration::from_secs(8);
        assert!(!warm_expired(Duration::from_secs(0), window), "fresh pause is not expired");
        assert!(!warm_expired(Duration::from_millis(7_999), window), "just under the window stays warm");
        assert!(warm_expired(Duration::from_secs(8), window), "exactly at the window expires");
        assert!(warm_expired(Duration::from_secs(20), window), "well past the window expires");
    }

    #[test]
    fn silence_now_goes_quiet_on_the_calling_thread_not_in_the_teardown() {
        // The reopen paths tear a session down WHILE its replacement is opening, so both gates must
        // close before the blocking close is handed to a worker: `suppress_ended` alone leaves the
        // ~2 s drain still emitting partials (the frontend feeds those to onSegment — stale text in
        // the new session, and an auto-send countdown armed over it), and a cloud-ended emitted from the
        // scheduling gap stops the successor outright. Asserted on the flags the WORKER reads, before
        // finish() is ever called. (roborev 50498/53024)
        let (session, _rx) = parkable_session();
        let muted = session.muted.clone();
        let suppressed = session.suppress_ended.clone();
        let silenced = session.silence_now();
        assert!(muted.load(Ordering::Relaxed), "no transcripts may escape a discarded session");
        assert!(suppressed.load(Ordering::Relaxed), "nor a cloud-ended that would stop its successor");
        silenced.finish(); // only now does the blocking close run
    }

    #[test]
    fn finish_does_not_mute_because_the_trailing_final_is_the_point() {
        // The ordinary stop path Finalizes precisely so the last words still commit. Muting there
        // would silently eat the tail of every utterance.
        let (session, _rx) = parkable_session();
        let muted = session.muted.clone();
        session.finish();
        assert!(!muted.load(Ordering::Relaxed));
    }

    #[test]
    fn pause_and_resume_track_whether_the_session_is_parked() {
        // stop_cloud_stream reads this to tell a socket deliberately idling on our warm timer from
        // one that is merely installed and not yet routing — see should_keep_warm_on_stop. Without
        // it, the stop that follows a blur park closed the socket the park had just kept.
        let (session, _rx) = parkable_session();
        assert!(!session.is_parked(), "a fresh session is routing, not parked");
        session.pause();
        assert!(session.is_parked(), "pause() puts the session into warm standby");
        session.resume();
        assert!(!session.is_parked(), "resume() takes it back out");
    }

    #[test]
    fn the_warm_window_can_never_add_a_billed_minute() {
        // THE GUARD THAT MAKES A 55s WINDOW FREE. Billing runs from OPEN, the idle window from
        // PAUSE, and holding a socket across that difference is the one way warm standby could cost
        // the user money instead of saving it. A socket opened at t=0 and paused at t=30 must NOT be
        // held for a further 55s — it must close before the 60s debit.
        assert!(
            !paid_minute_nearly_spent(Duration::from_secs(0), PAID_MINUTE, PAID_MINUTE_SAFETY),
            "a socket that just opened has its whole paid minute ahead of it"
        );
        assert!(
            !paid_minute_nearly_spent(Duration::from_secs(53), PAID_MINUTE, PAID_MINUTE_SAFETY),
            "still comfortably inside the minute already charged"
        );
        assert!(
            paid_minute_nearly_spent(Duration::from_secs(54), PAID_MINUTE, PAID_MINUTE_SAFETY),
            "within the safety margin of the next debit → close now, don't buy a second minute"
        );
        // NOT 90s — that is 30s into the SECOND paid minute and is holdable. This assertion used to
        // read `90 → true` under the absolute-age comparison, which is precisely the bug: it made
        // the guard permanently true past t=54 and switched warm standby off for long sessions.
        // `a_long_session_is_still_allowed_to_hold_a_warm_socket` covers that side.
        assert!(
            paid_minute_nearly_spent(Duration::from_secs(59), PAID_MINUTE, PAID_MINUTE_SAFETY),
            "one second before the debit"
        );
        // And the combined decision really consults BOTH deadlines — a test on the idle window alone
        // is blind to the one that costs money. Idle for 1s, but 58s since open: must close.
        assert!(
            warm_deadline_passed(Duration::from_secs(1), Duration::from_secs(58)),
            "barely idle, but the paid minute is nearly spent → close"
        );
        assert!(
            warm_deadline_passed(Duration::from_secs(55), Duration::from_secs(55)),
            "idle window reached → close"
        );
        assert!(
            !warm_deadline_passed(Duration::from_secs(30), Duration::from_secs(31)),
            "inside both deadlines → stay warm, this is the reuse the window exists for"
        );
        // The safety margin must cover the ~2s close+drain, or the close races the debit it avoids.
        assert!(
            PAID_MINUTE_SAFETY >= Duration::from_secs(3),
            "the margin must outlast the close+drain it protects"
        );
        assert!(PAID_MINUTE_SAFETY < PAID_MINUTE, "a margin larger than the minute closes instantly");
    }

    #[test]
    fn a_long_session_is_still_allowed_to_hold_a_warm_socket() {
        // THE GUARD MUST NOT SWITCH THE FEATURE OFF (roborev 61450, Medium). Comparing ABSOLUTE age
        // against 60s made `since_open + 6 >= 60` permanently true past t=54, so warm standby was
        // silently disabled for every session that had dictated for more than ~54s — those holds
        // paid a fresh handshake AND a fresh 6¢ debit while the minute they had already been charged
        // for went unused. The relay debits one minute on open and one every 60s after, so a
        // 70-second-old socket is paid through t=120 and is exactly as free to hold as a new one.
        assert!(
            !paid_minute_nearly_spent(Duration::from_secs(70), PAID_MINUTE, PAID_MINUTE_SAFETY),
            "10s into the SECOND paid minute — still free to hold"
        );
        assert!(
            !paid_minute_nearly_spent(Duration::from_secs(300), PAID_MINUTE, PAID_MINUTE_SAFETY),
            "a five-minute session is no different: it is 0s into its sixth paid minute"
        );
        assert!(
            paid_minute_nearly_spent(Duration::from_secs(114), PAID_MINUTE, PAID_MINUTE_SAFETY),
            "but the guard still fires near the END of a later minute"
        );
        // The property, rather than three sampled points: every minute behaves like the first.
        for minute in 0..6u64 {
            let base = minute * PAID_MINUTE.as_secs();
            assert!(
                !paid_minute_nearly_spent(Duration::from_secs(base + 30), PAID_MINUTE, PAID_MINUTE_SAFETY),
                "mid-minute {minute} must be holdable"
            );
            assert!(
                paid_minute_nearly_spent(Duration::from_secs(base + 56), PAID_MINUTE, PAID_MINUTE_SAFETY),
                "the end of minute {minute} must close"
            );
        }
        // A long session that is mid-minute really does get to stay warm end-to-end.
        assert!(
            !warm_deadline_passed(Duration::from_secs(2), Duration::from_secs(305)),
            "a five-minute dictation must still get warm reuse on its next hold"
        );
    }

    #[test]
    fn a_simulated_park_really_heartbeats_then_closes_on_the_wire() {
        // THE WHOLE PARK, DRIVEN (roborev 61471, Medium). The per-tick mapping test below was never
        // the at-risk half — the at-risk half is that anything CALLS it on the paused tick, and the
        // earlier shape let that call be deleted with the suite green and nothing reaching the wire.
        //
        // This runs a real park on a simulated clock and asserts the FRAME SEQUENCE, so a heartbeat
        // that never fires, fires at the wrong cadence, or a deadline that never sends CloseStream,
        // all fail here.
        const TICK: Duration = Duration::from_millis(100); // the loop's read-timeout poll interval
        let mut sent: Vec<String> = Vec::new();
        let mut last_keepalive: Option<Duration> = Some(Duration::ZERO); // seeded at the pause
        let mut elapsed = Duration::ZERO;
        let opened_before_park = Duration::from_secs(2); // a short utterance, then release
        let mut closed_at: Option<Duration> = None;
        let mut beat_times: Vec<Duration> = Vec::new();

        while closed_at.is_none() && elapsed < Duration::from_secs(120) {
            elapsed += TICK;
            let outcome = {
                let mut sink = |s: &str| sent.push(s.to_string());
                run_warm_standby_tick(
                    elapsed,
                    opened_before_park + elapsed,
                    last_keepalive.map(|k| elapsed - k),
                    &mut sink,
                )
            };
            match outcome {
                WarmOutcome::Closing => closed_at = Some(elapsed),
                WarmOutcome::Parked { beat: true } => {
                    last_keepalive = Some(elapsed);
                    beat_times.push(elapsed);
                }
                WarmOutcome::Parked { beat: false } => {}
            }
        }

        let closed_at = closed_at.expect("a parked socket must eventually close, never idle forever");
        let beats = sent.iter().filter(|s| *s == KEEPALIVE_MSG).count();
        let closes = sent.iter().filter(|s| *s == CLOSE_STREAM_MSG).count();

        assert!(
            beats > 0,
            "a parked socket sent NOTHING — it would die at Deepgram's ~10s idle close and the \
             {WARM_STANDBY:?} window would be a lie"
        );
        assert_eq!(closes, 1, "exactly one CloseStream, or the trailing final never drains");
        assert_eq!(sent.last().map(String::as_str), Some(CLOSE_STREAM_MSG), "and it comes last");
        // Cadence: enough beats to cover the whole park at ≤ KEEPALIVE_EVERY, with none wasted.
        // ±1 because the tick that closes the socket spends a slot that would otherwise have beaten.
        let expected = (closed_at.as_secs_f64() / KEEPALIVE_EVERY.as_secs_f64()).floor() as usize;
        assert!(
            beats + 1 >= expected && beats <= expected + 1,
            "expected ~{expected} heartbeats over a {closed_at:?} park, got {beats} — a cadence \
             that drifts either lets the socket die or spams the relay"
        );
        // THE PAID-MINUTE GUARD IS WHAT ENDED THIS PARK, not the idle window, and that is the
        // interaction worth pinning: the socket opened 2s before the park, so it must close at
        // PAID_MINUTE - PAID_MINUTE_SAFETY since OPEN (54s) rather than running the full 55s window.
        assert_eq!(
            opened_before_park + closed_at,
            PAID_MINUTE - PAID_MINUTE_SAFETY,
            "a park must end on whichever deadline comes first, measured from the right origin"
        );
        // THE GAP THAT MATTERS: no two CONSECUTIVE beats may straddle Deepgram's idle close.
        //
        // Asserted on the MAXIMUM gap, not the average (roborev 61498). An average is not the
        // property this comment claims and cannot detect the failure it names: a regression that
        // beats normally for half the park and then stops — say `warm_tick` returning `Wait` past
        // t=30 — leaves a 24s silent gap before the close while the average stays around 7s, so the
        // socket is dead at the idle close and the assertion is green. The whole-park beat COUNT
        // above is blind to distribution for the same reason.
        //
        // The sequence is bookended by the park start and the close, so the two intervals an
        // average most easily hides — park→first beat and last beat→close — are covered too.
        const DEEPGRAM_IDLE_CLOSE: Duration = Duration::from_secs(10);
        let mut marks = vec![Duration::ZERO];
        marks.extend(beat_times.iter().copied());
        marks.push(closed_at);
        let worst = marks
            .windows(2)
            .map(|w| w[1] - w[0])
            .max()
            .expect("the sequence is bookended, so it always has at least one interval");
        assert!(
            worst < DEEPGRAM_IDLE_CLOSE,
            "the longest silence during the park was {worst:?}, which straddles Deepgram's ~10s \
             idle close — the socket would be gone and the {WARM_STANDBY:?} window a lie \
             (beats at {beat_times:?}, closed at {closed_at:?})"
        );
        // The park really did last (roughly) the window, rather than closing early.
        assert!(
            closed_at >= WARM_STANDBY.min(Duration::from_secs(50)),
            "the park ended at {closed_at:?}, far short of the window it promises"
        );
    }

    #[test]
    fn a_warm_tick_actually_writes_the_frame_it_decided_on() {
        // THE ACTION, NOT THE DECISION (roborev 61465, Medium). `warm_tick`'s own test proves which
        // tick is chosen; nothing proved a frame was ever WRITTEN. With the write inline in
        // `run_session`, deleting one `socket.write(KEEPALIVE_MSG)` line kept every test green while
        // every parked socket died at Deepgram's ~10s idle close and the 55s window became a lie.
        let record = |tick| {
            let mut sent: Vec<String> = Vec::new();
            {
                let mut sink = |s: &str| sent.push(s.to_string());
                apply_warm_tick(tick, &mut sink);
            }
            sent
        };
        assert_eq!(
            record(WarmTick::Heartbeat),
            vec![KEEPALIVE_MSG.to_string()],
            "a due heartbeat must put a KeepAlive on the wire — this is the whole 55s window"
        );
        assert_eq!(
            record(WarmTick::Close),
            vec![CLOSE_STREAM_MSG.to_string()],
            "a deadline must send CloseStream so the trailing final still drains"
        );
        assert!(
            record(WarmTick::Wait).is_empty(),
            "a socket that is merely warm must stay SILENT, not be poked every poll interval"
        );
        // The frames must not be interchangeable: Finalize would flush a transcript and CloseStream
        // would end the session, so sending either as the heartbeat breaks warm standby differently.
        assert_ne!(record(WarmTick::Heartbeat), record(WarmTick::Close));
        assert_ne!(KEEPALIVE_MSG, FINALIZE_MSG);
    }

    #[test]
    fn a_parked_socket_heartbeats_until_a_deadline_closes_it() {
        // THE HEARTBEAT'S ONLY REAL GUARD (roborev 61450, Medium). The constants test below asserts
        // relationships that were all true BEFORE the heartbeat existed — delete the send block from
        // `run_session` and it stays green while every warm socket dies at Deepgram's ~10s idle
        // close, reverting reuse to a full handshake. This drives the DECISION instead.
        //
        // Nothing sent since the park → due immediately.
        assert_eq!(
            warm_tick(Duration::from_secs(1), Duration::from_secs(1), None),
            WarmTick::Heartbeat
        );
        // Sent recently → wait.
        assert_eq!(
            warm_tick(Duration::from_secs(5), Duration::from_secs(5), Some(Duration::from_secs(1))),
            WarmTick::Wait
        );
        // A full interval later → due again. This is the cadence that defeats the idle close, and a
        // socket parked for the whole window must keep beating the entire time.
        assert_eq!(
            warm_tick(Duration::from_secs(5), Duration::from_secs(5), Some(KEEPALIVE_EVERY)),
            WarmTick::Heartbeat
        );
        assert_eq!(
            warm_tick(Duration::from_secs(50), Duration::from_secs(50), Some(KEEPALIVE_EVERY)),
            WarmTick::Heartbeat,
            "still beating deep into the window — otherwise the socket dies before the window ends"
        );
        // A DEADLINE OUTRANKS THE HEARTBEAT: never keep a socket alive past the point it must close,
        // or the guards above become advisory.
        assert_eq!(
            warm_tick(WARM_STANDBY, Duration::from_secs(1), None),
            WarmTick::Close,
            "idle window reached → close, do not heartbeat"
        );
        assert_eq!(
            warm_tick(Duration::from_secs(1), Duration::from_secs(58), None),
            WarmTick::Close,
            "paid minute nearly spent → close, do not heartbeat"
        );
    }

    #[test]
    fn a_warm_window_past_deepgrams_idle_close_must_heartbeat() {
        // The 8s window used to sit under Deepgram's ~10s idle close SO THAT no KeepAlive was
        // needed. Raising it to 55s (to cover the founder's 18s median re-hold gap) makes the
        // heartbeat load-bearing rather than optional: without it Deepgram closes the socket at ~10s
        // and every "warm" reuse past that silently pays a fresh handshake again — the exact defect
        // the longer window exists to fix, reintroduced invisibly.
        const DEEPGRAM_IDLE_CLOSE: Duration = Duration::from_secs(10);
        assert!(
            WARM_STANDBY > DEEPGRAM_IDLE_CLOSE,
            "this test only means anything while the window outlasts the idle close"
        );
        assert!(
            KEEPALIVE_EVERY < DEEPGRAM_IDLE_CLOSE,
            "the heartbeat must be more frequent than the idle close it defeats"
        );
        // With margin for one dropped/delayed heartbeat, not merely under it by a hair.
        assert!(
            KEEPALIVE_EVERY.saturating_mul(2) < DEEPGRAM_IDLE_CLOSE,
            "one missed heartbeat must not expire the socket"
        );
        // The frame Deepgram actually documents for this. A Finalize would flush a transcript and a
        // CloseStream would end the session, so neither is a substitute.
        assert_eq!(KEEPALIVE_MSG, "{\"type\":\"KeepAlive\"}");
        assert_ne!(KEEPALIVE_MSG, FINALIZE_MSG);
        assert_ne!(KEEPALIVE_MSG, CLOSE_STREAM_MSG);
    }

    #[test]
    fn relay_target_maps_https_to_wss_on_443() {
        let (ws_url, host_port, tls) =
            relay_target("http://localhost:3001", 16_000).expect("valid https URL");
        assert_eq!(
            ws_url,
            "ws://localhost:3001/ai/deepgram?sample_rate=16000"
        );
        assert_eq!(host_port, "localhost:3001:443");
        assert!(tls);
    }

    #[test]
    fn relay_target_maps_http_localhost_to_ws_keeping_the_explicit_port() {
        let (ws_url, host_port, tls) =
            relay_target("http://localhost:3001", 16_000).expect("valid http URL");
        assert_eq!(ws_url, "ws://localhost:3001/ai/deepgram?sample_rate=16000");
        assert_eq!(host_port, "localhost:3001");
        assert!(!tls);
    }

    #[test]
    fn relay_target_defaults_port_80_for_plain_http_without_a_port() {
        let (_ws_url, host_port, tls) = relay_target("http://example.test", 16_000).expect("valid");
        assert_eq!(host_port, "example.test:80");
        assert!(!tls);
    }

    #[test]
    fn relay_target_drops_a_trailing_path_and_slash() {
        // A base URL that carries a path/trailing slash must not leak into the authority or a doubled
        // WS path.
        let (ws_url, host_port, _tls) =
            relay_target("https://host.test/", 16_000).expect("valid");
        assert_eq!(ws_url, "wss://host.test/ai/deepgram?sample_rate=16000");
        assert_eq!(host_port, "host.test:443");
    }

    #[test]
    fn relay_target_isolates_the_authority_from_a_query_or_fragment() {
        // A stray query/fragment must NOT fold into the host:port (which would break DNS/SNI).
        let (ws_url, host_port, _tls) =
            relay_target("https://host.test?x=y", 16_000).expect("valid");
        assert_eq!(host_port, "host.test:443", "query must not leak into the authority");
        assert_eq!(ws_url, "wss://host.test/ai/deepgram?sample_rate=16000");
        let (_ws_url2, host_port2, _) = relay_target("http://h.test:9/p#frag", 16_000).expect("valid");
        assert_eq!(host_port2, "h.test:9");
    }

    #[test]
    fn relay_target_rejects_an_unsupported_scheme() {
        assert!(relay_target("ftp://nope.test", 16_000).is_err());
        assert!(relay_target("localhost:3001", 16_000).is_err(), "bare host has no scheme");
    }

    #[test]
    fn relay_target_carries_the_requested_sample_rate() {
        let (ws_url, _, _) = relay_target("https://host.test", 48_000).expect("valid");
        assert!(ws_url.ends_with("/ai/deepgram?sample_rate=48000"), "url: {ws_url}");
    }

    #[test]
    fn the_project_never_appears_in_the_relay_url() {
        // It travels as the X-Sparkle-Project HEADER. A query param would land the user's project
        // name in proxy/access logs — the same reason `?token=` was removed from this endpoint.
        let (ws_url, _, _) = relay_target("https://host.test", 16_000).expect("valid");
        assert!(!ws_url.contains("project"), "url: {ws_url}");
        assert!(ws_url.ends_with("?sample_rate=16000"), "url: {ws_url}");
    }

    #[test]
    fn project_header_carries_the_name_for_credit_attribution() {
        assert_eq!(project_header_value(Some("sparkle")).as_deref(), Some("sparkle"));
    }

    #[test]
    fn project_header_is_absent_for_a_missing_or_blank_project() {
        // Absent and whitespace-only both mean "no project recorded" — the relay must not receive an
        // empty value that would land as an empty string in the ledger meta.
        assert_eq!(project_header_value(None), None);
        assert_eq!(project_header_value(Some("   ")), None);
    }

    #[test]
    fn project_header_percent_encodes_so_the_value_stays_visible_ascii() {
        // A human-typed name may contain spaces, '&', '=', '#', or non-ASCII. Header values must be
        // visible ASCII, and an un-encoded control char or newline would be rejected (or worse).
        assert_eq!(
            project_header_value(Some("my app &x=1 #2 café")).as_deref(),
            Some("my%20app%20%26x%3D1%20%232%20caf%C3%A9"),
        );
    }

    #[test]
    fn project_header_clips_a_pathological_name_by_chars() {
        // Uncapped, a long name percent-encodes to ~3x its bytes inside the handshake request — an
        // oversized header gets the upgrade REFUSED, breaking dictation over a decorative annotation.
        // Clipping by CHARS (not bytes) matches the Rust proxy path and the relay's own cap.
        let long = "é".repeat(MAX_PROJECT_CHARS + 50);
        let encoded = project_header_value(Some(&long)).expect("a long name still yields a value");
        // Each 'é' is 2 UTF-8 bytes → "%C3%A9" (6 chars) once encoded.
        assert_eq!(encoded.len(), MAX_PROJECT_CHARS * 6, "encoded: {}", encoded.len());
    }

    #[test]
    fn a_session_is_reusable_only_for_the_project_it_was_opened_with() {
        // The relay stamps the project captured at HANDSHAKE onto every per-minute debit for the life
        // of the connection, so reusing a warm socket across a project switch bills the wrong project.
        let (mut session, _rx) = parkable_session();
        session.project = normalize_project(Some("alpha"));
        assert!(session.is_for_project(Some("alpha")));
        assert!(session.is_for_project(Some("  alpha  ")), "normalization must not force a reopen");
        assert!(!session.is_for_project(Some("beta")), "a different project must reopen");
        assert!(!session.is_for_project(None), "an unattributed request must not bill alpha");

        // The stored name is the name the relay is BILLING — i.e. clipped exactly like the header —
        // so two names that differ only past the cap don't force a reopen the ledger can't tell apart.
        let long = "é".repeat(MAX_PROJECT_CHARS + 50);
        let longer = "é".repeat(MAX_PROJECT_CHARS + 90);
        let (mut clipped, _rx3) = parkable_session();
        clipped.project = normalize_project(Some(&long));
        assert_eq!(clipped.project.as_deref().map(|p| p.chars().count()), Some(MAX_PROJECT_CHARS));
        assert!(clipped.is_for_project(Some(&longer)), "same billed name must reuse the socket");

        let (mut unattributed, _rx2) = parkable_session();
        unattributed.project = None;
        assert!(unattributed.is_for_project(None));
        assert!(!unattributed.is_for_project(Some("alpha")));
    }

    #[test]
    fn pcm16_encodes_full_scale_and_silence() {
        // Silence → all-zero bytes.
        assert_eq!(f32_to_pcm16le(&[0.0, 0.0]), vec![0, 0, 0, 0]);
        // +1.0 → i16::MAX (0x7FFF) little-endian.
        assert_eq!(f32_to_pcm16le(&[1.0]), vec![0xFF, 0x7F]);
        // Over-unity is clamped, not wrapped, so it can't flip to the negative rail.
        assert_eq!(f32_to_pcm16le(&[2.0]), f32_to_pcm16le(&[1.0]));
        // Each sample is exactly two bytes.
        assert_eq!(f32_to_pcm16le(&[0.1, 0.2, 0.3]).len(), 6);
    }

    #[test]
    fn pcm16_negative_sample_is_signed_little_endian() {
        // -1.0 → -32767 (0x8001) LE — exercises the negative path.
        assert_eq!(f32_to_pcm16le(&[-1.0]), vec![0x01, 0x80]);
    }

    #[test]
    fn parses_a_final_result() {
        let msg = r#"{"type":"Results","is_final":true,"speech_final":true,
            "channel":{"alternatives":[{"transcript":"hello world","confidence":0.99}]}}"#;
        assert_eq!(
            parse_deepgram_message(msg),
            Some(DeepgramResult {
                transcript: "hello world".into(),
                is_final: true,
                speech_final: true
            })
        );
    }

    /// `is_final` and `speech_final` are INDEPENDENT, and the auto-send rail lives on the gap
    /// between them: a pause between clauses closes a segment (`is_final`) without ending the
    /// utterance (`speech_final`). A rail that read `is_final` as speech-end would restart its
    /// silence clock mid-sentence and fire while the user is still talking.
    #[test]
    fn a_final_segment_is_not_by_itself_the_end_of_speech() {
        let msg = r#"{"type":"Results","is_final":true,"speech_final":false,
            "channel":{"alternatives":[{"transcript":"first clause"}]}}"#;
        let r = parse_deepgram_message(msg).expect("final segment should parse");
        assert!(r.is_final);
        assert!(!r.speech_final, "a mid-utterance segment boundary must not read as speech end");

        // Absent (older frames, or a relay that strips it) is the SAFE reading: not speech end. The
        // rail then waits for the standalone UtteranceEnd rather than sending on a clause break.
        let no_flag = r#"{"type":"Results","is_final":true,
            "channel":{"alternatives":[{"transcript":"x"}]}}"#;
        assert!(!parse_deepgram_message(no_flag).expect("parses").speech_final);
    }

    #[test]
    fn parses_an_interim_result() {
        let msg = r#"{"type":"Results","is_final":false,
            "channel":{"alternatives":[{"transcript":"hello"}]}}"#;
        let r = parse_deepgram_message(msg).expect("interim should parse");
        assert_eq!(r.transcript, "hello");
        assert!(!r.is_final);
    }

    /// The standalone `UtteranceEnd` frame (`utterance_end_ms` on the relay URL). It carries NO
    /// transcript, so `parse_deepgram_message` still declines it — the speech-end reading lives in
    /// its own predicate and, above it, in `classify_relay_frame`.
    #[test]
    fn recognises_the_standalone_utterance_end_frame() {
        assert!(parse_deepgram_utterance_end(
            r#"{"type":"UtteranceEnd","channel":[0,1],"last_word_end":3.62}"#
        ));
        // Everything else on the wire is not an utterance end — including the VAD's other frame.
        assert!(!parse_deepgram_utterance_end(r#"{"type":"SpeechStarted","timestamp":1.0}"#));
        assert!(!parse_deepgram_utterance_end(r#"{"type":"Metadata"}"#));
        assert!(!parse_deepgram_utterance_end(
            r#"{"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":"x"}]}}"#
        ));
        // Garbage must be a quiet `false`, never a panic or a spurious send.
        assert!(!parse_deepgram_utterance_end("not json"));
        assert!(!parse_deepgram_utterance_end("{}"));
    }

    #[test]
    fn ignores_non_results_and_empty_transcripts() {
        // Non-Results control messages carry no transcript to surface.
        assert_eq!(parse_deepgram_message(r#"{"type":"Metadata","duration":1.0}"#), None);
        // UtteranceEnd still yields no TRANSCRIPT — it is a speech-end signal, not a segment, and
        // is routed by `classify_relay_frame` (see `classifies_the_utterance_end_frame`). This
        // assertion used to stand for "UtteranceEnd is ignored entirely"; that is no longer true,
        // and the classifier test is where the current behaviour is pinned.
        assert_eq!(parse_deepgram_message(r#"{"type":"UtteranceEnd","last_word_end":1.0}"#), None);
        // A Results frame with an empty/whitespace transcript (silence) is dropped, not emitted
        // as a blank segment.
        assert_eq!(
            parse_deepgram_message(
                r#"{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"   "}]}}"#
            ),
            None
        );
        // Garbage is ignored rather than panicking the worker.
        assert_eq!(parse_deepgram_message("not json"), None);
        assert_eq!(parse_deepgram_message("{}"), None);
    }

    #[test]
    fn parses_the_relay_ready_control() {
        assert_eq!(parse_relay_control(r#"{"type":"ready","sampleRate":16000}"#), Some(RelayControl::Ready));
    }

    #[test]
    fn parses_the_relay_balance_control_with_a_server_balance() {
        assert_eq!(
            parse_relay_control(r#"{"type":"balance","balanceCents":19994,"debitedCents":6,"minute":0}"#),
            Some(RelayControl::Balance { balance_cents: Some(19994), debited_cents: 6 })
        );
    }

    #[test]
    fn parses_the_relay_balance_control_with_a_null_balance() {
        // A null (or absent) server balance → None, so the client optimistically decrements.
        assert_eq!(
            parse_relay_control(r#"{"type":"balance","balanceCents":null,"debitedCents":5}"#),
            Some(RelayControl::Balance { balance_cents: None, debited_cents: 5 })
        );
        assert_eq!(
            parse_relay_control(r#"{"type":"balance","debitedCents":5}"#),
            Some(RelayControl::Balance { balance_cents: None, debited_cents: 5 })
        );
    }

    #[test]
    fn parses_the_relay_exhausted_and_error_controls() {
        assert_eq!(parse_relay_control(r#"{"type":"exhausted","reason":"declined"}"#), Some(RelayControl::Exhausted));
        assert_eq!(parse_relay_control(r#"{"type":"error","error":"upstream_error"}"#), Some(RelayControl::Error));
    }

    #[test]
    fn relay_control_ignores_deepgram_and_unknown_frames() {
        // A Deepgram Results/Metadata frame is NOT a relay control frame — it must fall through so
        // classify_relay_frame routes it to the transcript path.
        assert_eq!(parse_relay_control(r#"{"type":"Results","channel":{}}"#), None);
        assert_eq!(parse_relay_control(r#"{"type":"Metadata"}"#), None);
        assert_eq!(parse_relay_control(r#"{"type":"nonsense"}"#), None);
        assert_eq!(parse_relay_control("not json"), None);
    }

    #[test]
    fn classify_routes_control_transcript_and_ignore() {
        // Control frames win.
        assert_eq!(classify_relay_frame(r#"{"type":"ready"}"#), RelayFrame::Control(RelayControl::Ready));
        assert_eq!(
            classify_relay_frame(r#"{"type":"balance","balanceCents":10,"debitedCents":6}"#),
            RelayFrame::Control(RelayControl::Balance { balance_cents: Some(10), debited_cents: 6 })
        );
        assert_eq!(classify_relay_frame(r#"{"type":"exhausted"}"#), RelayFrame::Control(RelayControl::Exhausted));
        // Deepgram transcripts map to Partial (final) / Interim (not final). A final segment with
        // no `speech_final` is Continuing — the clause ended, the sentence did not.
        assert_eq!(
            classify_relay_frame(r#"{"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":"done"}]}}"#),
            RelayFrame::Partial("done".into(), SpeechEnd::Continuing)
        );
        assert_eq!(
            classify_relay_frame(r#"{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"typing"}]}}"#),
            RelayFrame::Interim("typing".into())
        );
        // Metadata / empty / garbage → Ignore.
        assert_eq!(classify_relay_frame(r#"{"type":"Metadata"}"#), RelayFrame::Ignore);
        assert_eq!(classify_relay_frame("not json"), RelayFrame::Ignore);
    }

    /// The auto-send rail's two speech-end paths through the classifier. This test REPLACES the
    /// half of `ignores_non_results_and_empty_transcripts` that asserted `UtteranceEnd → None` as
    /// the last word on the frame: that pinned the old behaviour, in which the desktop had no
    /// speech-end signal at all and the relay never even asked Deepgram for one.
    #[test]
    fn classifies_the_speech_end_frames() {
        // Path 1 — the standalone frame, which carries no transcript at all.
        assert_eq!(
            classify_relay_frame(r#"{"type":"UtteranceEnd","channel":[0,1],"last_word_end":3.62}"#),
            RelayFrame::UtteranceEnd
        );
        // Path 2 — the cheap one: `speech_final` riding along on a committed transcript. The
        // transcript still comes out, with the speech-end attached, so the worker cannot emit the
        // two out of order.
        assert_eq!(
            classify_relay_frame(
                r#"{"type":"Results","is_final":true,"speech_final":true,"channel":{"alternatives":[{"transcript":"ship it"}]}}"#
            ),
            RelayFrame::Partial("ship it".into(), SpeechEnd::Ended)
        );
        // An INTERIM never ends speech, whatever flags ride on it — it is by definition the middle
        // of something.
        assert_eq!(
            classify_relay_frame(
                r#"{"type":"Results","is_final":false,"speech_final":true,"channel":{"alternatives":[{"transcript":"ship"}]}}"#
            ),
            RelayFrame::Interim("ship".into())
        );
        // `vad_events=true` also turns on SpeechStarted, which is deliberately NOT surfaced: the
        // rail already cancels on the next transcript chunk, and a cough would otherwise cancel a
        // countdown the user meant to let run.
        assert_eq!(
            classify_relay_frame(r#"{"type":"SpeechStarted","timestamp":1.0}"#),
            RelayFrame::Ignore
        );
    }
}

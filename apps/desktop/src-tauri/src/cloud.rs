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
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::dictation::{
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
/// eliminates it for back-to-back dictation. Deliberately kept UNDER Deepgram's ~10 s server-side
/// idle-close window so the relay never has to send KeepAlive frames. NOTE: unlike the old
/// client-metered path, the relay meters by socket LIFETIME, so a warm socket held across a pause is
/// billed for that elapsed time (bounded to well under one minute per idle window) — an accepted
/// tradeoff for instant reuse and an honest reflection of a held-open server resource.
const WARM_STANDBY: Duration = Duration::from_secs(8);

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
    ) -> Result<DeepgramSession, String> {
        let socket = connect(&base_url, &token, SAMPLE_RATE, project.as_deref())?;
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
            .map_err(|e| format!("spawn relay worker: {e}"))?;
        tracing::info!(target: "dictation", "cloud relay stream opened");
        Ok(DeepgramSession {
            audio_tx: tx,
            worker: Some(worker),
            suppress_ended,
            alive,
            parked: Arc::new(AtomicBool::new(false)),
            muted,
            project: normalize_project(project.as_deref()),
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
        let _ = self.audio_tx.send(AudioMsg::Resume);
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

/// Open the WebSocket to the orchestration relay with the Sparkle bearer as the `Authorization`
/// header. Blocking but bounded by CONNECT_TIMEOUT — callers run it on a blocking worker (never the
/// main/event-loop thread) and treat Err as "fall back to on-device". A non-101 handshake response
/// (the relay's 401/402/403/503
/// gates) surfaces as Err too. run_session resets the socket timeouts to its own values after this
/// returns.
fn connect(
    base_url: &str,
    token: &str,
    sample_rate: u32,
    project: Option<&str>,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let (ws_url, host_port, tls) = relay_target(base_url, sample_rate)?;
    // into_client_request() fills in the required handshake headers (Host, Upgrade, Sec-*); we
    // only add Authorization (and the metering-only project) on top.
    let mut req = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("bad relay request: {e}"))?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| "invalid Sparkle auth header".to_string())?,
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
        .map_err(|e| format!("relay dns: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err("relay dns: no address".to_string());
    }
    let mut tcp = None;
    let mut last_err = String::new();
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, CONNECT_TIMEOUT) {
            Ok(s) => {
                tcp = Some(s);
                break;
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    let tcp = tcp.ok_or_else(|| format!("relay connect failed: {last_err}"))?;
    let _ = tcp.set_read_timeout(Some(CONNECT_TIMEOUT));
    let _ = tcp.set_write_timeout(Some(CONNECT_TIMEOUT));
    if tls {
        let (socket, _resp) = tungstenite::client_tls(req, tcp)
            .map_err(|e| format!("relay handshake failed: {e}"))?;
        Ok(socket)
    } else {
        // Plaintext (local dev, e.g. ws://localhost:3001): wrap the TcpStream as MaybeTlsStream::Plain
        // so the returned socket has the same type as the TLS path (set_socket_timeouts handles both).
        let (socket, _resp) = tungstenite::client(req, MaybeTlsStream::Plain(tcp))
            .map_err(|e| format!("relay handshake failed: {e}"))?;
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
                if warm_expired(since.elapsed(), WARM_STANDBY) {
                    let _ = socket.write(Message::text(CLOSE_STREAM_MSG));
                    set_socket_timeouts(&mut socket, READ_TIMEOUT, READ_TIMEOUT);
                    closing = true;
                    paused = false;
                    warm_since = None;
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
                    }
                    break; // go read the trailing final(s) Finalize will produce
                }
                Ok(AudioMsg::Pause) => {} // already closing — nothing to warm
                // Resume: a new utterance reuses this warm socket — leave standby, keep draining.
                Ok(AudioMsg::Resume) => {
                    paused = false;
                    warm_since = None;
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
    };
    (session, ParkedChannel(rx))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn warm_standby_is_under_deepgrams_idle_close_so_no_keepalive_is_needed() {
        // The whole no-KeepAlive design hinges on closing the warm socket ourselves BEFORE Deepgram's
        // ~10 s server-side idle timeout would. Guard that margin so a future bump can't silently
        // cross it (which would let Deepgram drop the socket mid-standby).
        assert!(WARM_STANDBY < Duration::from_secs(10), "warm window must stay under Deepgram's idle close");
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

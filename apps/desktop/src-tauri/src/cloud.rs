//! Deepgram Nova-3 cloud dictation — streamed through the SERVER-SIDE orchestration relay.
//!
//! Audio is captured natively (see `audio.rs`) as 16 kHz mono f32. When the user is actively
//! dictating (the wake-word phase machine is ACTIVE — see the frontend) we open a WebSocket to the
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

use crate::dictation::{emit_cloud_balance, emit_cloud_ended, emit_interim, emit_partial};

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
    /// When set, the worker skips its `dictation://cloud-ended` emit on exit. Used by `discard()`
    /// so a session rejected by the post-handshake race guard doesn't fire an event that would tear
    /// down the *current* (healthy) session — the event carries no generation identity.
    suppress_ended: Arc<AtomicBool>,
    /// True while the worker thread is running. Cleared the instant the worker exits (clean close,
    /// warm-standby expiry, or socket death). Lets the reuse path (`start_cloud_stream`) check, under
    /// the state lock, whether a warm session is still usable before resuming it. A lost race here is
    /// SAFE: resuming a just-dead session simply drops frames, and the worker's `cloud-ended` emit on
    /// exit drives the frontend back to on-device — the same recovery as any mid-stream death.
    alive: Arc<AtomicBool>,
}

impl DeepgramSession {
    /// Open the relay WebSocket (synchronous handshake) and spawn the worker. `base_url` is the
    /// orchestration host (from `auth::base_url()`); `token` is the user's Sparkle bearer (from the
    /// keychain). Returns Err if the handshake fails — offline, signed out, not entitled, or the
    /// relay refused because the user can't afford the first minute (a non-101 status) — so the
    /// caller can fall back to the on-device path before any audio is captured; no partial/dead
    /// session is ever returned.
    pub fn start(app: AppHandle, base_url: String, token: String) -> Result<DeepgramSession, String> {
        let socket = connect(&base_url, &token, SAMPLE_RATE)?;
        let (tx, rx) = std::sync::mpsc::channel::<AudioMsg>();
        let suppress_ended = Arc::new(AtomicBool::new(false));
        let suppress_cb = suppress_ended.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let alive_cb = alive.clone();
        let worker = std::thread::Builder::new()
            .name("deepgram-relay".into())
            .spawn(move || run_session(app, socket, rx, suppress_cb, alive_cb))
            .map_err(|e| format!("spawn relay worker: {e}"))?;
        tracing::info!(target: "dictation", "cloud relay stream opened");
        Ok(DeepgramSession { audio_tx: tx, worker: Some(worker), suppress_ended, alive })
    }

    /// Push one 16 kHz mono frame to the relay. Converts to PCM16 here (cheap) so the caller's
    /// audio callback stays minimal. Silently no-ops if the worker has already exited.
    pub fn send_audio(&self, frame: &[f32]) {
        let _ = self.audio_tx.send(AudioMsg::Frame(f32_to_pcm16le(frame)));
    }

    /// Drop into warm standby: Finalize the current utterance (so its trailing text still commits)
    /// and keep the socket open for `WARM_STANDBY` so the next utterance can reuse it. No-ops if the
    /// worker already exited. Called instead of `finish()` on a normal stop-word stop.
    pub fn pause(&self) {
        let _ = self.audio_tx.send(AudioMsg::Pause);
    }

    /// Leave warm standby and resume forwarding audio on the same connection (no handshake).
    pub fn resume(&self) {
        let _ = self.audio_tx.send(AudioMsg::Resume);
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
}

impl Drop for DeepgramSession {
    fn drop(&mut self) {
        // Safety net for the path that drops without finish() (e.g. an error teardown): signal
        // close so the worker exits, but DON'T join here — a Drop must not block the caller.
        let _ = self.audio_tx.send(AudioMsg::Close);
    }
}

/// Build the relay WebSocket URL, TCP connect target, and TLS flag from the orchestration base URL.
/// Pure so the http→ws / https→wss mapping and the default-port logic are unit-testable. Returns
/// `(ws_url, host:port, tls)`. Accepts `http(s)://` (the base_url form) and `ws(s)://` defensively.
fn relay_target(base_url: &str, sample_rate: u32) -> Result<(String, String, bool), String> {
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
}

/// Parse a Deepgram WebSocket text frame into a transcript update. Returns None for non-`Results`
/// messages (Metadata, UtteranceEnd, SpeechStarted) and for empty transcripts (silence between
/// words still produces empty interim frames we don't want to surface).
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
    Some(DeepgramResult { transcript, is_final })
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
    /// A committed (final) transcript segment — emit as a partial.
    Partial(String),
    /// A live interim transcript — emit as the volatile preview.
    Interim(String),
    /// A relay control frame.
    Control(RelayControl),
    /// Nothing actionable (Deepgram Metadata/UtteranceEnd, an empty transcript, or unparseable text).
    Ignore,
}

/// Classify a relay text frame: a relay control frame wins; otherwise a Deepgram `Results` frame
/// becomes an interim/final transcript; anything else is ignored.
pub(crate) fn classify_relay_frame(json: &str) -> RelayFrame {
    if let Some(ctrl) = parse_relay_control(json) {
        return RelayFrame::Control(ctrl);
    }
    match parse_deepgram_message(json) {
        Some(r) if r.is_final => RelayFrame::Partial(r.transcript),
        Some(r) => RelayFrame::Interim(r.transcript),
        None => RelayFrame::Ignore,
    }
}

/// Bound the whole handshake (TCP connect + TLS + WS upgrade). Without this an offline/black-holed
/// network stalls the start_cloud_stream command thread for the OS SYN timeout (tens of seconds),
/// undercutting the fast fall-back-to-on-device design.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Open the WebSocket to the orchestration relay with the Sparkle bearer as the `Authorization`
/// header. Blocking but bounded by CONNECT_TIMEOUT — callers run it on the Tauri command thread and
/// treat Err as "fall back to on-device". A non-101 handshake response (the relay's 401/402/403/503
/// gates) surfaces as Err too. run_session resets the socket timeouts to its own values after this
/// returns.
fn connect(
    base_url: &str,
    token: &str,
    sample_rate: u32,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let (ws_url, host_port, tls) = relay_target(base_url, sample_rate)?;
    // into_client_request() fills in the required handshake headers (Host, Upgrade, Sec-*); we
    // only add Authorization on top.
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
fn run_session(
    app: AppHandle,
    mut socket: WebSocket<MaybeTlsStream<TcpStream>>,
    audio_rx: Receiver<AudioMsg>,
    suppress_ended: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
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
            Ok(Message::Text(txt)) => match classify_relay_frame(txt.as_str()) {
                RelayFrame::Partial(t) => emit_partial(&app, "deepgram", t),
                RelayFrame::Interim(t) => emit_interim(&app, t),
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
            },
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
    // orphan (see discard()), whose event would otherwise stop the current session.
    if !suppress_ended.load(Ordering::Relaxed) {
        emit_cloud_ended(&app, exhausted);
    }
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
            Some(DeepgramResult { transcript: "hello world".into(), is_final: true })
        );
    }

    #[test]
    fn parses_an_interim_result() {
        let msg = r#"{"type":"Results","is_final":false,
            "channel":{"alternatives":[{"transcript":"hello"}]}}"#;
        let r = parse_deepgram_message(msg).expect("interim should parse");
        assert_eq!(r.transcript, "hello");
        assert!(!r.is_final);
    }

    #[test]
    fn ignores_non_results_and_empty_transcripts() {
        // Non-Results control messages carry no transcript to surface.
        assert_eq!(parse_deepgram_message(r#"{"type":"Metadata","duration":1.0}"#), None);
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
        // Deepgram transcripts map to Partial (final) / Interim (not final).
        assert_eq!(
            classify_relay_frame(r#"{"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":"done"}]}}"#),
            RelayFrame::Partial("done".into())
        );
        assert_eq!(
            classify_relay_frame(r#"{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"typing"}]}}"#),
            RelayFrame::Interim("typing".into())
        );
        // Metadata / empty / garbage → Ignore.
        assert_eq!(classify_relay_frame(r#"{"type":"Metadata"}"#), RelayFrame::Ignore);
        assert_eq!(classify_relay_frame("not json"), RelayFrame::Ignore);
    }
}

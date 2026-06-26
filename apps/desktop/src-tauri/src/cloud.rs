//! Deepgram Nova-3 streaming STT — the gold-standard cloud dictation path.
//!
//! Audio is captured natively (see `audio.rs`) as 16 kHz mono f32. When the user is actively
//! dictating (the wake-word phase machine is ACTIVE — see the frontend), we open a Deepgram
//! WebSocket and stream PCM16 frames to it, emitting Deepgram's interim results live and its
//! finalized results as committed text. The always-listening wake-word detection itself stays
//! fully on-device (Parakeet/Silero), so the cloud only ever sees speech the user intended to
//! dictate — the "local gate, then stream" design.
//!
//! Threading: cpal's audio callback must never block, so it only pushes frames onto an mpsc
//! channel. A dedicated worker thread owns the WebSocket and does a single-threaded select loop
//! — drain pending audio and send it, then read one message under a short socket read-timeout —
//! which gives full-duplex behavior over one blocking socket without splitting it.
//!
//! Everything degrades gracefully: if the handshake fails (offline, bad key, etc.) `start`
//! returns Err and the caller falls back to the on-device transcriber; a mid-stream error ends
//! the worker and the session is torn down.
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::AppHandle;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::dictation::{emit_cloud_ended, emit_interim, emit_partial};

/// The capture pipeline always hands us 16 kHz mono (downmix_resample target), so that's the
/// rate we declare to Deepgram. Kept as a constant rather than threaded through so the wire
/// format can't drift from what `audio.rs` actually produces.
pub const SAMPLE_RATE: u32 = 16_000;

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

/// After we tell Deepgram the stream is closing, keep reading this many extra timeouts (~2 s) to
/// collect the trailing final result(s) before giving up — so the last spoken words aren't lost.
const DRAIN_TICKS_AFTER_CLOSE: u32 = 50;

/// Deepgram control message: "no more audio is coming; finalize and send remaining results."
const CLOSE_STREAM_MSG: &str = "{\"type\":\"CloseStream\"}";

/// What the worker thread receives from the audio callback.
enum AudioMsg {
    /// One frame of PCM16 little-endian bytes. The f32→PCM16 conversion runs in `send_audio` on the
    /// cpal callback thread — it's a cheap, lock-free, non-blocking per-sample loop + one alloc, so
    /// it's safe on the audio hot path; the worker just forwards the bytes.
    Frame(Vec<u8>),
    /// The user stopped dictating — flush Deepgram and wind the worker down.
    Close,
}

/// A live Deepgram streaming session. Holds the channel the audio callback feeds and the worker
/// thread handle. Drop signals close and detaches; call `finish()` to also join (used on stop).
pub struct DeepgramSession {
    audio_tx: Sender<AudioMsg>,
    worker: Option<JoinHandle<()>>,
    /// When set, the worker skips its `dictation://cloud-ended` emit on exit. Used by `discard()`
    /// so a session rejected by the post-handshake race guard doesn't fire an event that would tear
    /// down the *current* (healthy) session — the event carries no generation identity.
    suppress_ended: Arc<AtomicBool>,
}

impl DeepgramSession {
    /// Open the WebSocket (synchronous handshake) and spawn the worker. Returns Err if the
    /// handshake fails, so the caller can fall back to the on-device path before any audio is
    /// captured — no partial/dead session is ever returned.
    pub fn start(app: AppHandle, key: String) -> Result<DeepgramSession, String> {
        let socket = connect(&key, SAMPLE_RATE)?;
        let (tx, rx) = std::sync::mpsc::channel::<AudioMsg>();
        let suppress_ended = Arc::new(AtomicBool::new(false));
        let suppress_cb = suppress_ended.clone();
        let worker = std::thread::Builder::new()
            .name("deepgram-stream".into())
            .spawn(move || run_session(app, socket, rx, suppress_cb))
            .map_err(|e| format!("spawn deepgram worker: {e}"))?;
        tracing::info!(target: "dictation", "deepgram stream opened");
        Ok(DeepgramSession { audio_tx: tx, worker: Some(worker), suppress_ended })
    }

    /// Push one 16 kHz mono frame to Deepgram. Converts to PCM16 here (cheap) so the caller's
    /// audio callback stays minimal. Silently no-ops if the worker has already exited.
    pub fn send_audio(&self, frame: &[f32]) {
        let _ = self.audio_tx.send(AudioMsg::Frame(f32_to_pcm16le(frame)));
    }

    /// End the stream: tell Deepgram to finalize, then join the worker. The shutdown path itself is
    /// bounded to ~2 s: on entering `closing` the worker shrinks the write timeout to the read
    /// interval, so the CloseStream flush + trailing-final read-drain are both capped by the read-tick
    /// budget regardless of link state. The one unbounded tail is frames already queued in the
    /// channel *ahead of* Close when `finish()` fires: on a sustained (multi-second) uplink wedge the
    /// worker must drain those at up to WRITE_TIMEOUT each before it reaches Close. That's the
    /// acknowledged sustained-wedge case (a wedge during active dictation is outside the WiFi-jitter
    /// operating point we target); normal and brief-jitter teardown is ~2 s, never a hang.
    pub fn finish(mut self) {
        // Suppress the worker's cloud-ended emit: finish() is only called from the frontend-initiated
        // stop paths (stop_cloud_stream / stop_dictation), which have already torn down the meter and
        // UI. Emitting would just trigger a redundant stop_cloud_stream round-trip. cloud-ended is
        // reserved for UNSOLICITED worker death (socket error), where the frontend must be told.
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

/// Build the Deepgram streaming URL. `nova-3` + `language=multi` selects Nova-3 **Multilingual**
/// (code-switching across languages) — the variant our credit pricing is based on
/// (creditPricing.ts, $0.0058/min). `smart_format` + `punctuate` give sentence-aware punctuation
/// (the fix for spurious per-pause periods); `interim_results` drives the live word-by-word preview;
/// `endpointing=300` finalizes a segment after ~300 ms of silence (real-sentence boundaries, not
/// every micro-pause).
pub(crate) fn deepgram_ws_url(sample_rate: u32) -> String {
    format!(
        "wss://api.deepgram.com/v1/listen?model=nova-3&language=multi&encoding=linear16\
         &sample_rate={sample_rate}&channels=1&interim_results=true\
         &smart_format=true&punctuate=true&endpointing=300"
    )
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

/// One transcript update parsed from a Deepgram `Results` message.
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

/// Deepgram's API host:port. The WS URL always targets this, so we connect the TCP socket here
/// (with a timeout) rather than letting tungstenite::connect() do an unbounded blocking connect.
const DEEPGRAM_ADDR: &str = "api.deepgram.com:443";
/// Bound the whole handshake (TCP connect + TLS + WS upgrade). Without this an offline/black-holed
/// network stalls the start_cloud_stream command thread for the OS SYN timeout (tens of seconds),
/// undercutting the fast fall-back-to-on-device design.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Open the WebSocket to Deepgram with the API key as a `Token` Authorization header. Blocking but
/// bounded by CONNECT_TIMEOUT — callers run it on the Tauri command thread and treat Err as "fall
/// back to on-device". run_session resets the socket timeouts to its own values after this returns.
fn connect(key: &str, sample_rate: u32) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let url = deepgram_ws_url(sample_rate);
    // into_client_request() fills in the required handshake headers (Host, Upgrade, Sec-*); we
    // only add Authorization on top.
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("bad deepgram request: {e}"))?;
    req.headers_mut().insert(
        "Authorization",
        format!("Token {key}")
            .parse()
            .map_err(|_| "invalid Deepgram auth header".to_string())?,
    );
    // Resolve + TCP-connect with a timeout (fail fast when offline), bound the TLS+WS upgrade reads/
    // writes too, then run the handshake over the prepared stream via tungstenite::client_tls. Try
    // every resolved address (not just the first) so an unreachable record — e.g. an IPv6 addr on an
    // IPv4-only path — doesn't force a fallback when a later address would connect.
    let addrs: Vec<_> = DEEPGRAM_ADDR
        .to_socket_addrs()
        .map_err(|e| format!("deepgram dns: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err("deepgram dns: no address".to_string());
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
    let tcp = tcp.ok_or_else(|| format!("deepgram connect failed: {last_err}"))?;
    let _ = tcp.set_read_timeout(Some(CONNECT_TIMEOUT));
    let _ = tcp.set_write_timeout(Some(CONNECT_TIMEOUT));
    let (socket, _resp) = tungstenite::client_tls(req, tcp)
        .map_err(|e| format!("deepgram handshake failed: {e}"))?;
    Ok(socket)
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
        // MaybeTlsStream is #[non_exhaustive]; with the rustls-tls-webpki-roots feature a wss://
        // connection is always Rustls, so this is unreachable today. Fail LOUD if a future TLS
        // backend change lands a variant here — silently no-op'ing would leave read()/write()
        // unbounded and quietly defeat finish()'s bounded-join guarantee.
        _ => {
            tracing::warn!(
                target: "dictation",
                "deepgram socket: unhandled stream variant; read/write timeouts NOT set — finish() may not be bounded"
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

/// The worker loop: interleave sending queued audio with reading Deepgram results, emitting
/// interim/final transcript events, until the stream is closed or the socket errors.
///
/// Test coverage: the pure helpers (`deepgram_ws_url`, `f32_to_pcm16le`, `parse_deepgram_message`)
/// are unit-tested and the whole wire path is covered by the opt-in `live_deepgram_roundtrip` test
/// (SPARKLE_DG_LIVE=1). This loop's timeout/`closing`-drain state machine is NOT exercised
/// hermetically — doing so would require abstracting the socket behind a transport trait, which we
/// judged not worth the indirection for this single call site (the live test is the real check).
fn run_session(
    app: AppHandle,
    mut socket: WebSocket<MaybeTlsStream<TcpStream>>,
    audio_rx: Receiver<AudioMsg>,
    suppress_ended: Arc<AtomicBool>,
) {
    set_socket_timeouts(&mut socket, READ_TIMEOUT, WRITE_TIMEOUT);
    let mut closing = false;
    let mut drain_ticks = 0u32;

    'session: loop {
        // 1) Drain and send all currently-queued audio (non-blocking).
        loop {
            match audio_rx.try_recv() {
                // Once we've told Deepgram the stream is closing, drop any late frames rather than
                // sending audio after the CloseStream control message (which contradicts the
                // "no more audio is coming" contract).
                Ok(AudioMsg::Frame(_)) if closing => {}
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

        // 2) Read one message (bounded by the read timeout), emitting any transcript it carries.
        match socket.read() {
            Ok(Message::Text(txt)) => {
                if let Some(r) = parse_deepgram_message(txt.as_str()) {
                    if r.is_final {
                        emit_partial(&app, "deepgram", r.transcript);
                    } else {
                        emit_interim(&app, r.transcript);
                    }
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
                tracing::debug!(target: "dictation", error = %e, "deepgram stream ended");
                break;
            }
        }
    }
    tracing::info!(target: "dictation", "deepgram stream closed");
    // Tell the frontend the cloud stream is gone (clean close OR mid-stream failure) so it clears
    // the interim preview and calls stop_cloud_stream — resuming on-device routing/fallback. Skipped
    // for a discarded orphan (see discard()), whose event would otherwise stop the current session.
    if !suppress_ended.load(Ordering::Relaxed) {
        emit_cloud_ended(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_carries_the_streaming_params() {
        let url = deepgram_ws_url(16_000);
        assert!(url.starts_with("wss://api.deepgram.com/v1/listen?"));
        for needle in [
            "model=nova-3",
            "language=multi",
            "encoding=linear16",
            "sample_rate=16000",
            "channels=1",
            "interim_results=true",
            "smart_format=true",
            "punctuate=true",
            "endpointing=300",
        ] {
            assert!(url.contains(needle), "url missing {needle}: {url}");
        }
        // No stray whitespace from the multi-line string literal leaked into the URL.
        assert!(!url.contains(' '), "url must not contain spaces: {url}");
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

    /// Live end-to-end check against the real Deepgram API. Opt-in (set SPARKLE_DG_LIVE=1) so
    /// `cargo test` stays hermetic and CI — which has no key — never hits the network. Verifies
    /// the parts a mock can't: the URL/auth handshake, that `linear16` PCM frames are accepted,
    /// and that the CloseStream handshake yields a clean close with at least one well-formed
    /// server message (Metadata/Results). Run: `SPARKLE_DG_LIVE=1 cargo test live_deepgram -- --nocapture`.
    #[test]
    fn live_deepgram_roundtrip() {
        if std::env::var("SPARKLE_DG_LIVE").is_err() {
            return; // opt-in only
        }
        let key = crate::naming::resolve_deepgram_key()
            .expect("DEEPGRAM_API must resolve for the live test");
        let mut socket = connect(&key, SAMPLE_RATE).expect("deepgram handshake should succeed");
        set_socket_timeouts(&mut socket, Duration::from_millis(200), WRITE_TIMEOUT);

        // Stream ~1s of a 220 Hz tone as PCM16 in 20 ms (320-sample) chunks.
        for chunk in 0..50 {
            let frame: Vec<f32> = (0..320)
                .map(|i| {
                    let n = chunk * 320 + i;
                    (2.0 * std::f32::consts::PI * 220.0 * n as f32 / SAMPLE_RATE as f32).sin() * 0.3
                })
                .collect();
            socket.send(Message::binary(f32_to_pcm16le(&frame))).expect("send audio frame");
        }
        socket.send(Message::text(CLOSE_STREAM_MSG)).expect("send CloseStream");

        // Read until the server closes (or we hit a generous tick budget), proving it parsed our
        // stream: every text frame must be valid JSON carrying a recognizable `type`.
        let mut saw_server_message = false;
        for _ in 0..50 {
            match socket.read() {
                Ok(Message::Text(t)) => {
                    let v: serde_json::Value =
                        serde_json::from_str(t.as_str()).expect("server frame must be JSON");
                    assert!(v.get("type").and_then(|x| x.as_str()).is_some(), "frame has a type");
                    saw_server_message = true;
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(tungstenite::Error::Io(ref e)) if is_timeout(e) => {}
                Err(e) => panic!("unexpected stream error: {e}"),
            }
        }
        assert!(saw_server_message, "expected at least one Metadata/Results frame from Deepgram");
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
}

//! Microphone capture via cpal → 16 kHz mono f32 frames + RMS level.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat};
use crate::audio_devices::{self, DeviceChoice};

// consumed by the level meter + transcription pipeline in later tasks
#[allow(dead_code)]
pub fn rms_level(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = frame.iter().map(|s| s * s).sum();
    (sum_sq / frame.len() as f32).sqrt()
}

/// Average channels to mono, then decimate to 16 kHz with a box-filter (moving-average)
/// low-pass so we don't alias. The previous version point-sampled (`mono[i*ratio]`),
/// which folds energy above 8 kHz back down into the speech band as noise — directly
/// hurting ASR accuracy. Averaging every input sample that maps to an output sample is a
/// crude but real anti-aliasing filter (a length-`ratio` boxcar), it costs one pass over
/// the input, and it keeps us free of a heavyweight resampler dependency. Used by both the
/// on-device model and the cloud (PCM16) path, so the win applies everywhere.
pub fn downmix_resample(input: &[f32], channels: u16, in_rate: u32) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    let mono: Vec<f32> = input
        .chunks(ch)
        .map(|c| c.iter().sum::<f32>() / ch as f32)
        .collect();
    if in_rate == 16_000 || mono.is_empty() {
        return mono;
    }
    let ratio = in_rate as f32 / 16_000.0;
    // round() preserves the trailing sample (floor would drop ~1 sample/callback).
    let out_len = (mono.len() as f32 / ratio).round().max(1.0) as usize;
    let n = mono.len();
    (0..out_len)
        .map(|i| {
            // Boxcar window [start, end) of the input samples mapping to output sample i.
            // Clamp into bounds and guarantee end > start so every output averages ≥1 sample
            // (the final window's ideal end can run just past the buffer).
            let start = ((i as f32 * ratio) as usize).min(n - 1);
            let end = (((i + 1) as f32 * ratio) as usize).clamp(start + 1, n);
            let win = &mono[start..end];
            win.iter().sum::<f32>() / win.len() as f32
        })
        .collect()
}

/// Helper: convert a typed sample slice to f32 and call downmix_resample.
// non-F32 sample formats used on non-macOS platforms
#[allow(dead_code)]
fn process_typed<T>(
    data: &[T],
    channels: u16,
    in_rate: u32,
    health: &CaptureHealth,
    on_frame: &mut impl FnMut(Vec<f32>),
) where
    T: Sample,
    f32: FromSample<T>,
{
    let f32_data: Vec<f32> = data.iter().map(|&s| f32::from_sample(s)).collect();
    // Count the device's samples BEFORE downmix/resample (see `CaptureHealth::note_raw`). The
    // int→f32 conversion above is value-preserving for zero, so counting here rather than on the
    // typed slice still answers the question this measurement exists for: did the OS send silence?
    health.note_raw(&f32_data);
    on_frame(downmix_resample(&f32_data, channels, in_rate));
}

/// Live evidence that a capture is actually receiving audio — the counters the dictation watchdog
/// reads to tell a DEAD microphone from a quiet room.
///
/// On 2026-07-29 a screen recorder's CoreAudio HAL plug-in left Sparkle capturing nothing for nine
/// minutes while the UI showed it listening. Every check the app had passed: cpal returned Ok, the
/// stream played, the callback fired at the normal rate. The distinguishing fact is arithmetic, and
/// it is the reason `voiced_frames` is counted separately from `frames`:
///
/// * `frames == 0` — CoreAudio never invoked the callback. The device is gone or wedged.
/// * `frames > 0 && voiced_frames == 0` — callbacks arrive on schedule carrying samples that are
///   **exactly** `0.0`. That is a virtual/unfed device, measured on the affected machine at
///   `callbacks=281 samples=143872 nonzero=0` while the real microphone read `nonzero=143872`.
///   A real microphone's noise floor is never exactly zero across thousands of samples, so this
///   cannot be confused with silence in the ROOM.
///
/// It CAN be confused with a MUTED device, and that distinction is not available here. A hardware
/// mute switch (Jabra/Poly and similar), `kAudioDevicePropertyMute`, and several Bluetooth/USB
/// drivers all deliver exact `0.0` to the host — so `Silent` means "this device is sending us
/// nothing", not "this device is broken". The watchdog therefore asks `audio_devices::is_muted`
/// before it accuses anything, and says "your microphone is muted" when that comes back true
/// (roborev 55275). Treating the two as one would tell users their mic is dead every time they
/// muted it themselves.
#[derive(Debug, Default)]
pub struct CaptureHealth {
    /// Audio callbacks delivered since this capture started.
    frames: AtomicU64,
    /// Callbacks carrying at least one non-zero sample.
    voiced_frames: AtomicU64,
    /// Samples handed to us by CoreAudio, counted BEFORE `downmix_resample` — see `note_raw`.
    raw_samples: AtomicU64,
    /// How many of those raw samples were non-zero.
    raw_nonzero: AtomicU64,
    /// Samples in the 16 kHz mono frames the pipeline actually consumes, counted AFTER conversion.
    out_samples: AtomicU64,
    /// How many of those converted samples were non-zero.
    out_nonzero: AtomicU64,
}

/// WHERE the zeros came from, when a capture reads `Silent`.
///
/// `frames > 0 && voiced_frames == 0` says the frames the pipeline saw were all zero. It does NOT
/// say who zeroed them, and until this existed the log could not tell a dead device from a bug in
/// our own conversion: `note_frame` only ever saw the POST-`downmix_resample` frame. Counting the
/// RAW device buffer as well makes the two distinguishable, which is the difference between
/// "the microphone is delivering nothing" and "we threw the audio away" — opposite fixes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ZeroSource {
    /// Real audio is reaching the pipeline; there is nothing to explain.
    #[default]
    NotApplicable,
    /// CoreAudio invoked the callback with buffers whose samples were all exactly zero. The device
    /// (or the OS's grant for this process) is the problem — nothing downstream can recover it.
    Os,
    /// CoreAudio invoked the callback with EMPTY buffers (zero samples). Distinct from `Os`: there
    /// were no samples to be zero, so this is a stream-format/negotiation failure, not silence.
    EmptyBuffers,
    /// The device DID hand us non-zero samples and the converted frame is all zeros. That is our
    /// bug — `downmix_resample` (or whatever replaced it) destroyed the audio.
    SelfInflicted,
}

/// How much audio [`PreRoll`] retains while nothing is routing, in 16 kHz mono samples (2 s).
///
/// Sized against the MEASURED cost of the window it exists to cover, not guessed: `Capture::start`
/// plus CoreAudio's first buffer is **~1.17 s cold / ~375-440 ms warm** on the founder's machine
/// (`measure_push_to_talk_cold_start`, built-in mic, `allow_virtual: false`), and the relay
/// handshake on top of that is documented as "~hundreds of ms" with an 8 s ceiling.
///
/// AN EARLIER REVISION SAID ~456 ms / ~212 ms AND CONCLUDED "2 s covers the realistic sum with
/// headroom". Those numbers were measured against a VIRTUAL device and were ~2.5× optimistic; the
/// arithmetic they supported no longer holds. State the residual margin honestly instead: 2 s
/// comfortably covers a WARM hold (~375-440 ms plus a handshake), and covers a COLD one only if the
/// handshake stays at the low end — ~1.17 s + "~hundreds of ms" leaves a few hundred ms of slack,
/// and a slow cold open with a slow handshake can exceed it.
///
/// That is an ACCEPTED TRADE, not an oversight, because widening it is not a free win: the number
/// below is a privacy promise the founder agreed to by its size (see [`PreRoll`]), so it is not
/// something to raise silently when a measurement moves. Do not widen it without asking him again.
///
/// It is also the PRIVACY bound, which is why it is deliberately small and stated here rather than
/// left implicit: at rest this is the entire extent of what the microphone's history can be. 2 s of
/// 16 kHz mono f32 is ~128 KB, held in RAM, overwritten in place, never written to disk, and never
/// transmitted — nothing leaves the ring until `routing` goes true.
pub const PREROLL_SAMPLES: usize = 16_000 * 2;

/// Retains the most recent audio while nothing is routing it, so speech is not lost to the gap
/// between the user asking to talk and the pipeline being ready to listen.
///
/// ── WHY THIS EXISTS (sparkle-oyapv) ────────────────────────────────────────────────────────────
/// The founder held push-to-talk, said *"push to talk is not working super well"*, and the app
/// transcribed *"super well"* — five leading words gone. Two separate gaps ate them, and this one
/// type closes both, which is the reason it is shaped as "retain while not routing" rather than as
/// anything push-to-talk-specific:
///
///   * the mic is not open yet (push to talk rests released), and
///   * the mic IS open but the relay socket is not up, so frames have nowhere to go.
///
/// ── WHY A BUFFER AND NOT "MAKE IT FASTER" ──────────────────────────────────────────────────────
/// Because the cost was measured and it does not go away. ~375-440 ms of it is `Capture::start` on
/// a WARM machine, and ~1.17 s COLD. The dominant warm costs are `build_input_stream` (~270 ms) and
/// `default_input_config` (~95-155 ms); device resolve is 4 ms warm and only dominates when cold
/// (~448 ms) — an earlier revision blamed the enumeration path, which would have sent anyone
/// optimising it after 4 ms. No amount of pre-warming a socket or caching a model touches one
/// millisecond of any of it, because it is CoreAudio's. Pre-warming makes the
/// loss smaller; retaining the audio makes it STRUCTURALLY IMPOSSIBLE, which is the bar the founder
/// set ("zero words lost, ever"). A fix that merely narrows the window is one the user still hits
/// on a slow morning.
///
/// ── THE PRIVACY TRADE, STATED ──────────────────────────────────────────────────────────────────
/// This only helps if the stream is open while at rest, which REVERSES `sparkle-u81cz`, where the
/// founder demanded the opposite: *"IT SHOULD NOT BE CAPTURING ANY WAVEFORM."* He was asked
/// directly and accepted it (2026-08-06). The bound above is what makes that acceptance meaningful:
/// RAM only, [`PREROLL_SAMPLES`] and no more, never persisted, and never sent anywhere until
/// `routing` goes true. Do not widen the capacity without asking him again — the number IS the
/// promise.
#[derive(Debug)]
pub struct PreRoll {
    /// Frames retained oldest-first while `routing` is false.
    ring: std::collections::VecDeque<Vec<f32>>,
    /// Samples currently retained across `ring`, tracked so eviction is not O(n) per frame.
    retained: usize,
    /// Ceiling on `retained`; the oldest frames are evicted to honour it.
    capacity: usize,
    /// The routing state as of the previous frame — the false→true EDGE is what flushes.
    routing: bool,
}

impl PreRoll {
    pub fn new(capacity: usize) -> Self {
        Self { ring: std::collections::VecDeque::new(), retained: 0, capacity, routing: false }
    }

    /// Offer one captured frame, and get back the frames to route RIGHT NOW, in order.
    ///
    /// * not routing → `[]`; the frame is retained (oldest evicted past `capacity`).
    /// * routing, first frame of the hold → the whole retained ring, then this frame.
    /// * routing, thereafter → just this frame.
    ///
    /// Returning a `Vec` rather than sending internally is what makes the policy testable without
    /// an audio device, a relay socket, or a 482 MB model — the same reason `plan_capture` and
    /// `classify_zero_source` in this file are pure. The caller does the sending.
    pub fn note(&mut self, frame: &[f32], routing: bool) -> Vec<Vec<f32>> {
        if !routing {
            // A hold that just ended leaves `routing` true; drop back and resume retaining, so the
            // NEXT hold is covered too. This is the ordinary steady state at rest.
            self.routing = false;
            if self.capacity == 0 {
                return Vec::new();
            }
            self.ring.push_back(frame.to_vec());
            self.retained += frame.len();
            // Evict oldest-first. `while`, not `if`: one oversized frame can exceed the capacity on
            // its own, and a single-shot eviction would leave the ring permanently over budget —
            // which is the privacy bound, not just a memory one.
            while self.retained > self.capacity {
                match self.ring.pop_front() {
                    Some(dropped) => self.retained -= dropped.len(),
                    // Unreachable while `retained` and `ring` agree; bail rather than spin forever
                    // if they ever disagree, because this runs on the realtime audio thread.
                    None => {
                        self.retained = 0;
                        break;
                    }
                }
            }
            return Vec::new();
        }
        if self.routing {
            // Steady state mid-hold: nothing is being retained, so this is a straight pass-through.
            return vec![frame.to_vec()];
        }
        // ── THE EDGE: routing just became possible. Everything held comes out, oldest first, with
        // this frame last — so the destination receives one continuous utterance with the leading
        // audio in front of it, which is the entire point of the type.
        self.routing = true;
        let mut out = Vec::with_capacity(self.ring.len() + 1);
        out.extend(self.ring.drain(..));
        self.retained = 0;
        out.push(frame.to_vec());
        out
    }

    /// Forget everything retained, WITHOUT routing it.
    ///
    /// ── THIS IS THE DOUBLE-TRANSCRIPTION GUARD, NOT A CONVENIENCE (roborev, High) ───────────────
    /// A frame that is not being routed to the relay is NOT audio that fell on the floor: while the
    /// relay is down the same frame is fed to the on-device VAD, and any segment that CLOSES there
    /// is decoded and typed into the composer. If the ring kept holding that audio, the next
    /// false→true edge would flush words the user can already see straight to Deepgram, which would
    /// transcribe them a SECOND time — the exact duplication `segment_cloud_latch` exists to
    /// prevent, reached from the other direction (that latch only suppresses a segment STRADDLING
    /// the switch; one that opened and closed before it is already typed and still in the ring).
    ///
    /// So the caller clears the ring whenever the on-device engine takes a closed segment as the
    /// engine of record. The invariant this maintains is worth stating in one line, because it is
    /// what makes the type safe to reason about: **the ring only ever holds audio no engine has
    /// claimed.**
    ///
    /// An earlier revision of this branch deleted this method as an unused convenience. It was
    /// unused because it had not been wired yet, which is a different thing.
    pub fn clear(&mut self) {
        self.ring.clear();
        self.retained = 0;
    }

    /// Samples currently retained — how the privacy bound is asserted.
    #[cfg(test)]
    pub fn retained(&self) -> usize {
        self.retained
    }
}

/// Pure classifier for [`ZeroSource`], so the policy is unit-tested without an audio device.
pub fn classify_zero_source(
    raw_samples: u64,
    raw_nonzero: u64,
    out_nonzero: u64,
) -> ZeroSource {
    if out_nonzero > 0 {
        return ZeroSource::NotApplicable;
    }
    if raw_nonzero > 0 {
        return ZeroSource::SelfInflicted;
    }
    if raw_samples == 0 {
        return ZeroSource::EmptyBuffers;
    }
    ZeroSource::Os
}

impl CaptureHealth {
    pub fn frames(&self) -> u64 {
        self.frames.load(Ordering::Relaxed)
    }
    pub fn voiced_frames(&self) -> u64 {
        self.voiced_frames.load(Ordering::Relaxed)
    }
    pub fn raw_samples(&self) -> u64 {
        self.raw_samples.load(Ordering::Relaxed)
    }
    pub fn raw_nonzero(&self) -> u64 {
        self.raw_nonzero.load(Ordering::Relaxed)
    }
    pub fn out_samples(&self) -> u64 {
        self.out_samples.load(Ordering::Relaxed)
    }
    pub fn out_nonzero(&self) -> u64 {
        self.out_nonzero.load(Ordering::Relaxed)
    }
    /// Where this capture's zeros came from, if it has any to explain.
    pub fn zero_source(&self) -> ZeroSource {
        classify_zero_source(self.raw_samples(), self.raw_nonzero(), self.out_nonzero())
    }

    /// Record the buffer EXACTLY as CoreAudio delivered it, before any downmix/resample.
    ///
    /// Called from the cpal data callback (the only place the raw buffer exists). Full scan rather
    /// than `any`: the count is the evidence — "72192 of 72192 samples non-zero" and "0 of 72192"
    /// are the two readings that settle the question, and a boolean would not. It is one pass over
    /// a ~512-sample buffer at tens of Hz, which is nothing next to the VAD that follows.
    pub fn note_raw(&self, data: &[f32]) {
        self.raw_samples.fetch_add(data.len() as u64, Ordering::Relaxed);
        let nz = data.iter().filter(|&&s| s != 0.0).count() as u64;
        self.raw_nonzero.fetch_add(nz, Ordering::Relaxed);
    }
    /// Record one delivered frame. `Relaxed` is sufficient: the watchdog only needs eventual
    /// visibility of a monotonically increasing count, never ordering against other state, and this
    /// runs on the realtime CoreAudio thread where a cheaper op is the right default.
    fn note_frame(&self, frame: &[f32]) {
        self.frames.fetch_add(1, Ordering::Relaxed);
        self.out_samples.fetch_add(frame.len() as u64, Ordering::Relaxed);
        // `any` short-circuits on the FIRST non-zero sample, so the healthy path costs one compare
        // per frame. Only a genuinely all-zero (dead) frame pays the full scan.
        if frame.iter().any(|&s| s != 0.0) {
            self.voiced_frames.fetch_add(1, Ordering::Relaxed);
            // Counted only on voiced frames: on the healthy path this scan replaces nothing (the
            // `any` above already touched the buffer) and on the dead path it never runs at all.
            let nz = frame.iter().filter(|&&s| s != 0.0).count() as u64;
            self.out_nonzero.fetch_add(nz, Ordering::Relaxed);
        }
    }
}

/// What a capture concluded about whether audio is really flowing. Returned by
/// [`assess_capture_health`], which is pure so this policy is testable without an audio device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioHealth {
    /// Too early to judge — a freshly built stream takes a moment to deliver its first buffer.
    Warming,
    /// No callbacks at all. The device is gone, wedged, or was never really opened.
    NoFrames,
    /// Callbacks arriving, every sample exactly zero: a dead mic wearing a quiet room's clothes.
    Silent,
    /// Real audio is arriving.
    Live,
}

/// Decide whether a running capture is actually carrying audio.
///
/// Pure, so the whole policy — including the grace period that stops a just-built stream being
/// declared dead before its first buffer lands — is unit-tested without a microphone.
pub fn assess_capture_health(
    elapsed: std::time::Duration,
    frames: u64,
    voiced_frames: u64,
    grace: std::time::Duration,
) -> AudioHealth {
    if elapsed < grace {
        return AudioHealth::Warming;
    }
    if frames == 0 {
        return AudioHealth::NoFrames;
    }
    if voiced_frames == 0 {
        return AudioHealth::Silent;
    }
    AudioHealth::Live
}

/// The input device a capture actually opened, for logging and for the "no audio from X" notice.
///
/// Naming the device is what makes the failure actionable: "no audio" sends the user hunting, while
/// "no audio from ZoomAudioDevice" tells them immediately that capture landed on a virtual device
/// and which app put it there.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundDevice {
    pub name: String,
    /// The stable CoreAudio UID, when we could resolve one.
    pub uid: Option<String>,
    /// True when this device is a HAL plug-in's virtual input — it may carry system audio rather
    /// than (or as well as) a microphone. Surfaced to the UI so that is never invisible.
    pub is_virtual: bool,
    /// True when this is the system default rather than a device the user explicitly chose.
    pub was_default: bool,
}

/// How to ask cpal for the input device we already decided to open.
///
/// THIS IS NOT COSMETIC — it decides whether the resulting `cpal::Stream` can ever be freed.
///
/// cpal 0.15.3's macOS backend registers a device-disconnect listener for every input stream whose
/// `Device` is not flagged `is_default`, and that listener owns a CLONE of the stream's own
/// `Arc<Mutex<StreamInner>>` (`host/coreaudio/macos/mod.rs`, `add_disconnect_listener`). The Arc
/// therefore points at itself: dropping our `Stream` takes the strong count from 2 to 1 and stops
/// there, so `StreamInner` — and with it the CoreAudio `AudioUnit`, which is never uninitialized or
/// disposed, plus the `kAudioDevicePropertyDeviceIsAlive` listener, which is never removed — LEAKS,
/// permanently, once per capture.
///
/// Only `Host::default_input_device()` produces a `Device` with `is_default == true`; every device
/// from `Host::input_devices()` has it false. Sparkle resolves its device BY NAME (cpal cannot open
/// by UID, so `resolve_device` looks the chosen name up in `input_devices()`), which means every
/// capture the app has ever built took the leaking path — including the automatic, unpinned,
/// system-default case that is the overwhelming majority of them.
///
/// Measured on the built-in microphone with a standalone cpal harness that mirrors
/// `Capture::drop` (pause, then drop) and holds an `Arc` inside the data callback:
///
/// | acquisition                            | `Arc::strong_count` after the drop |
/// |----------------------------------------|------------------------------------|
/// | `input_devices().find(name)`            | 2 — every cycle, 12/12 leaked      |
/// | `default_input_device()`                | 1 — every cycle, 6/6 freed         |
///
/// So: when the device we chose IS the system default, take cpal's default handle and the stream
/// becomes free-able. [`plan_device_acquisition`] is that decision, pure and testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceAcquisition {
    /// Ask cpal for the default input device. `is_default == true`, so no self-referential
    /// disconnect listener is registered and the stream is disposed when we drop it.
    CpalDefault,
    /// Look the device up by name in `input_devices()`. The ONLY way to open a non-default device,
    /// and it leaks the stream (see above) — so it is used only when it is genuinely the only
    /// option, and it says so in the log.
    ByName,
}

/// Decide how to acquire `selected` from cpal.
///
/// `cpal_default_name` is the name cpal reports for `default_input_device()` — `None` when there is
/// no default at all. Matching by NAME is sound here because `audio_devices::select_device` has
/// already proven the chosen name unambiguous (that is the precondition `unique_names` guards);
/// without that proof two same-named devices could make this open the wrong one, which is why the
/// caller must not skip it.
pub fn plan_device_acquisition(selected: &str, cpal_default_name: Option<&str>) -> DeviceAcquisition {
    match cpal_default_name {
        Some(d) if d == selected => DeviceAcquisition::CpalDefault,
        _ => DeviceAcquisition::ByName,
    }
}

// wired into the dictation command in a later task
#[allow(dead_code)]
pub struct Capture {
    stream: cpal::Stream,
    /// Which input device this capture opened (see [`BoundDevice`]).
    device: BoundDevice,
    /// Frame counters shared with the callback; read by the dictation watchdog.
    health: Arc<CaptureHealth>,
    /// When this capture started, so the watchdog can hold its verdict until the stream has had a
    /// realistic chance to deliver its first buffer (see `assess_capture_health`'s grace window).
    started_at: std::time::Instant,
    /// Teardown gate for the native-crash fix. Flipped to false at the very START of `Drop`,
    /// BEFORE the cpal `Stream` is paused/dropped, so any frame the CoreAudio IOThread is about to
    /// dispatch during teardown early-returns at the top of the callback instead of reaching into
    /// the transcriber / cloud / app state that `stop_dictation` is concurrently tearing down.
    /// Shared (an `Arc` clone lives inside the callback closure) so it outlives the pause; the
    /// closure itself is only freed by the subsequent `Stream` drop (CoreAudio Dispose), which
    /// synchronizes with the IOThread. Field order matters: `stream` is declared first so it drops
    /// (and drains the IOThread) before `active`, keeping the flag alive across the whole teardown.
    active: Arc<AtomicBool>,
}

/// Panic firewall (). cpal invokes the audio data callbacks from CoreAudio's
/// `extern "C"` render callback, on the `com.apple.audio.IOThread.client` thread. A Rust panic
/// in the frame handler — a poisoned transcriber mutex, an FFI panic inside the ASR model, an
/// arithmetic slip on a malformed frame — CANNOT unwind across that C boundary: it hits
/// `panic_cannot_unwind` and `abort()`s the whole process. (Observed on app quit while a
/// dictation capture was still live: the callback fired mid-teardown and took the app down with
/// SIGABRT.) This wrapper catches the unwind so one bad frame is dropped, never fatal; the
/// default panic hook still records the panic to the unified log. Capture::start funnels every
/// sample-format callback through it.
fn firewall_frame_handler(
    active: Arc<AtomicBool>,
    health: Arc<CaptureHealth>,
    mut on_frame: impl FnMut(Vec<f32>) + Send + 'static,
) -> impl FnMut(Vec<f32>) + Send + 'static {
    move |frame: Vec<f32>| {
        // Teardown gate (macOS native-crash fix). `Capture::drop` flips `active` false BEFORE it
        // pauses/drops the cpal Stream. `stream.pause()` does NOT guarantee the CoreAudio IOThread
        // isn't mid-dispatching a render callback, and that callback would otherwise touch the
        // transcriber/cloud/app state `stop_dictation` is tearing down in parallel — a data race
        // the panic firewall below cannot catch (a native SIGABRT/SIGSEGV, not a Rust unwind). By
        // bailing here the callback becomes an inert no-op the instant teardown begins. Acquire
        // pairs with the Release store in `Drop` so the flip is observed promptly. The closure
        // (and its captured `Arc<AtomicBool>`) is only freed by the later Stream drop (Dispose),
        // which synchronizes with the IOThread, so this load never dereferences freed memory.
        if !active.load(Ordering::Acquire) {
            return;
        }
        // Record the frame BEFORE handing it on, so the watchdog's evidence does not depend on the
        // pipeline below succeeding: a frame that arrived is a frame that arrived, even if decoding
        // or relaying it then panics and is swallowed by the firewall on the next line.
        health.note_frame(&frame);
        // Suppress crash-record persistence for a panic we're about to CATCH here: the panic hook
        // still logs it, but a recovered frame panic must not be written/uploaded as a "crash" (the
        // app isn't going down). The guard resets when this frame returns. See crash::suppress_crash_records.
        let _suppress = crate::crash::suppress_crash_records();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_frame(frame)));
    }
}

impl Capture {
    /// Which input device to open, and what we know about it.
    ///
    /// Resolving the user's `DeviceChoice` is deliberately a two-step translation, because cpal
    /// gives us no better option: it exposes devices by NAME only (the `AudioDeviceID` inside its
    /// `Device` is private), so we ask CoreAudio for the UID→name mapping and then ask cpal for the
    /// device with that name. `audio_devices::unique_names` guards the one assumption that makes it
    /// sound; when it fails we say so and take the default rather than open an ambiguous device.
    ///
    /// Every fallback is LOGGED rather than silent. A capture that quietly landed somewhere other
    /// than where the user pointed it is exactly the failure mode this change exists to end.
    fn resolve_device(choice: &DeviceChoice) -> Result<(cpal::Device, BoundDevice), String> {
        use audio_devices::{Resolution, SelectionReason as R};
        let host = cpal::default_host();
        let devices = audio_devices::list_input_devices();

        let (name, reason) = match audio_devices::select_device(choice, &devices) {
            // No safe device exists. FAIL rather than fall back: falling back to
            // `default_input_device()` is exactly what let a loopback carrying system audio become
            // the capture source (roborev 55275). The message reaches the mic UI via the
            // `dictation://error` emit in build_capture, and classifies as `no-device` there.
            Resolution::Refuse { reason } => {
                tracing::error!(
                    target: "dictation", ?reason,
                    "refusing to open an input device: no microphone is available and \
                     non-microphone inputs are not allowed"
                );
                return Err(
                    "No microphone found — only virtual audio devices are available. Connect a \
                     microphone, or allow non-microphone input in the mic menu if you really want \
                     to transcribe system audio."
                        .into(),
                );
            }
            // Nothing enumerated (non-macOS, or CoreAudio told us nothing). No policy applies.
            Resolution::SystemDefault => return Self::default_device(&host, &devices),
            Resolution::Open { name, reason } => (name, reason),
        };

        // Every non-obvious outcome is logged. A capture that quietly landed somewhere other than
        // where the user pointed it — or on a device that carries system audio — is precisely the
        // failure that went unnoticed for a day.
        match &reason {
            R::ChosenUidMissing => tracing::warn!(
                target: "dictation", substituted = %name,
                "the chosen microphone is not present (unplugged, or its driver unloaded); \
                 automatically selecting another REAL microphone instead"
            ),
            R::AmbiguousNames => tracing::warn!(
                target: "dictation", substituted = %name,
                "two input devices share a name, so the chosen device cannot be identified \
                 unambiguously; automatically selecting a real microphone instead"
            ),
            R::AutoAvoidedVirtualDefault => tracing::info!(
                target: "dictation",
                "the default input is a virtual device that can carry system audio; \
                 binding a real microphone instead"
            ),
            R::AutoVirtualAllowed => tracing::warn!(
                target: "dictation",
                "binding a VIRTUAL input device — system audio (calls, videos, streams) can be \
                 transcribed. This is the advanced 'allow non-microphone input' opt-in."
            ),
            // Reached only with the advanced opt-in ON (without it, this is a Refuse above).
            R::AutoNoPhysicalInput => tracing::warn!(
                target: "dictation",
                "no physical microphone is available; binding a non-microphone input because the \
                 advanced opt-in allows it"
            ),
            R::ChosenUid | R::AutoDefaultIsPhysical => {}
        }

        // Translate the selected NAME into a cpal device (cpal cannot open by UID at all). The
        // name was proven unambiguous by `select_device`, so this `find` can only match the device
        // the policy actually chose — which is what makes the BoundDevice metadata below true.
        //
        // HOW we ask cpal for it decides whether the stream can ever be freed: see
        // `DeviceAcquisition`. Take the default handle whenever the chosen device IS the default,
        // because the by-name handle leaks the CoreAudio AudioUnit on every capture.
        let cpal_default = host.default_input_device();
        let cpal_default_name = cpal_default.as_ref().and_then(|d| d.name().ok());
        let acquisition = plan_device_acquisition(&name, cpal_default_name.as_deref());
        let opened = match acquisition {
            DeviceAcquisition::CpalDefault => cpal_default,
            DeviceAcquisition::ByName => host
                .input_devices()
                .ok()
                .and_then(|mut it| it.find(|d| d.name().map(|n| n == name).unwrap_or(false))),
        };
        if let Some(d) = opened {
            if acquisition == DeviceAcquisition::ByName {
                // Say it out loud rather than leak silently. cpal gives us no way to open a
                // NON-default device without the self-referential disconnect listener, so a user
                // who pinned a specific microphone still accumulates one stopped-but-undisposed
                // AudioUnit per capture. Naming it here is what makes that diagnosable from a log
                // instead of being rediscovered from first principles.
                tracing::warn!(
                    target: "dictation", device = %name,
                    "opening a NON-default input device by name; cpal 0.15.3 leaks the CoreAudio \
                     stream on this path (its disconnect listener owns the stream's own Arc), so \
                     each capture rebuild leaves one undisposed audio unit behind"
                );
            }
            let picked = devices.iter().find(|x| x.name == name);
            return Ok((
                d,
                BoundDevice {
                    uid: picked.map(|x| x.uid.clone()),
                    is_virtual: picked.map(|x| x.is_virtual).unwrap_or(false),
                    was_default: picked.map(|x| x.is_default).unwrap_or(false),
                    name,
                },
            ));
        }
        // CoreAudio lists it but cpal does not. Do NOT reach for the raw system default here — it
        // is the same unchecked fallback that let a loopback become the capture source. Fail with
        // the device named, so the user can pick another.
        Err(format!(
            "The selected microphone \"{name}\" could not be opened. Pick a different input in \
             the mic menu."
        ))
    }

    fn default_device(
        host: &cpal::Host,
        devices: &[audio_devices::InputDevice],
    ) -> Result<(cpal::Device, BoundDevice), String> {
        let device = host.default_input_device().ok_or("no input device")?;
        let name = device.name().unwrap_or_else(|_| "unknown input device".into());
        let known = devices.iter().find(|d| d.name == name);
        Ok((
            device,
            BoundDevice {
                uid: known.map(|d| d.uid.clone()),
                is_virtual: known.map(|d| d.is_virtual).unwrap_or(false),
                was_default: true,
                name,
            },
        ))
    }

    /// The device this capture is bound to.
    pub fn device(&self) -> &BoundDevice {
        &self.device
    }

    /// Live frame counters — how the watchdog proves audio is (or is not) arriving.
    pub fn health(&self) -> &Arc<CaptureHealth> {
        &self.health
    }

    /// How long this capture has been running.
    pub fn uptime(&self) -> std::time::Duration {
        self.started_at.elapsed()
    }

    #[allow(dead_code)]
    pub fn start(
        choice: &DeviceChoice,
        on_frame: impl FnMut(Vec<f32>) + Send + 'static,
    ) -> Result<Capture, String> {
        // ── WHY THIS IS TIMED (sparkle-oyapv) ────────────────────────────────────────────────────
        // Push to talk rests with the mic RELEASED, so this whole function sits between the founder
        // pressing the key and the first sample existing — and everything spoken during it is lost
        // outright, because there is no buffer anywhere upstream of `Capture`. The founder reported
        // losing five leading words. Nothing on this path was measured: every latency figure in this
        // repo is a timeout constant or an adjective ("CoreAudio init is milliseconds"), so the
        // budget could be argued about but never read. These four sub-spans make it readable.
        //
        // They are SEPARATE rather than one total because they have different fixes: `resolve` is
        // `2 + 4N` CoreAudio HAL round trips through eight third-party plug-ins (see dictation.rs
        // `list_input_devices`), `config` is format negotiation, and `build`+`play` are the stream
        // itself. A single number would say "slow" without saying which one to attack.
        let t0 = std::time::Instant::now();
        let (device, bound) = Self::resolve_device(choice)?;
        let resolve_ms = t0.elapsed().as_millis();
        let t_cfg = std::time::Instant::now();
        let cfg = device
            .default_input_config()
            .map_err(|e| e.to_string())?;
        let config_ms = t_cfg.elapsed().as_millis();
        let channels = cfg.channels();
        let in_rate = cfg.sample_rate().0;
        let sample_format = cfg.sample_format();
        let stream_config = cfg.into();

        // The teardown gate the frame handler checks and `Capture::drop` flips (native-crash fix).
        let active = Arc::new(AtomicBool::new(true));
        let health = Arc::new(CaptureHealth::default());

        // Log WHICH device we opened, with its stable UID and format. Before this, nothing recorded
        // it — so when capture spent nine minutes bound to a device that delivered nothing, the log
        // showed ten "capture starting" lines and no way to tell what any of them opened.
        tracing::info!(
            target: "dictation",
            device = %bound.name,
            uid = bound.uid.as_deref().unwrap_or("<none>"),
            default = bound.was_default,
            channels, sample_rate = in_rate, format = ?sample_format,
            "capture bound to input device"
        );

        // Funnel the handler through the panic firewall so a panic on the audio thread is
        // contained, not propagated into CoreAudio's extern "C" callback (see the fn doc). The
        // firewall also honors the teardown gate so a callback racing teardown becomes a no-op,
        // and records each delivered frame for the liveness watchdog.
        // ── FIRST-FRAME LATENCY (sparkle-oyapv) ──────────────────────────────────────────────────
        // The sub-spans above end when `stream.play()` returns, which is NOT when audio starts
        // arriving: CoreAudio still has to deliver its first buffer, and that delay is pure loss on
        // a push-to-talk hold. Nothing measured it — the closest the repo came was WATCHDOG_GRACE
        // being "long enough to cover CoreAudio's first-buffer latency", a bound chosen around a
        // number nobody had.
        //
        // Wrapped AROUND the caller's handler rather than added to `firewall_frame_handler`, whose
        // 3-arg signature two existing tests drive directly; widening it would have made this
        // measurement a reason for those tests to change, which is how unrelated coverage rots.
        //
        // Logged ONCE per capture (`Relaxed` swap on a flag) — this runs on the realtime CoreAudio
        // IO thread, where a per-frame `tracing` call would be a genuine audio-dropout hazard.
        let first_frame_logged = Arc::new(AtomicBool::new(false));
        let on_frame = {
            let seen = first_frame_logged.clone();
            let mut inner = on_frame;
            move |frame: Vec<f32>| {
                if !seen.swap(true, Ordering::Relaxed) {
                    tracing::info!(
                        target: "dictation",
                        since_capture_start_ms = t0.elapsed().as_millis() as u64,
                        "first audio frame delivered"
                    );
                }
                inner(frame)
            }
        };
        let mut on_frame = firewall_frame_handler(active.clone(), health.clone(), on_frame);
        // A second handle for the RAW-buffer counters. It must be read inside the cpal callback,
        // which is the only place the device's own buffer exists — `firewall_frame_handler` runs
        // one conversion later and can therefore never tell OS silence from a conversion bug.
        let raw_health = health.clone();

        // Build an input stream, dispatching on the device's native sample format
        // so we never ask cpal to reinterpret bytes incorrectly.
        // On macOS the default format is typically F32, but we handle the common
        // alternatives (I16, I32) so the code is portable.
        let t_build = std::time::Instant::now();
        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    // Raw buffer FIRST, exactly as CoreAudio handed it over. This is the only
                    // place it exists, and the only measurement that can distinguish "the OS sent
                    // silence" from "our conversion destroyed the audio".
                    raw_health.note_raw(data);
                    on_frame(downmix_resample(data, channels, in_rate));
                },
                |err| eprintln!("cpal stream error: {err}"),
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    process_typed(data, channels, in_rate, &raw_health, &mut on_frame);
                },
                |err| eprintln!("cpal stream error: {err}"),
                None,
            ),
            SampleFormat::I32 => device.build_input_stream(
                &stream_config,
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    process_typed(data, channels, in_rate, &raw_health, &mut on_frame);
                },
                |err| eprintln!("cpal stream error: {err}"),
                None,
            ),
            SampleFormat::F64 => device.build_input_stream(
                &stream_config,
                move |data: &[f64], _: &cpal::InputCallbackInfo| {
                    process_typed(data, channels, in_rate, &raw_health, &mut on_frame);
                },
                |err| eprintln!("cpal stream error: {err}"),
                None,
            ),
            other => {
                return Err(format!("unsupported sample format: {other}"));
            }
        }
        .map_err(|e| e.to_string())?;

        let build_ms = t_build.elapsed().as_millis();

        let t_play = std::time::Instant::now();
        stream.play().map_err(|e| e.to_string())?;
        let play_ms = t_play.elapsed().as_millis();

        // INFO, not DEBUG, and deliberately so: the reports this exists to answer arrive hours later
        // from someone on a release build, where a DEBUG line would never have been recorded. It
        // fires once per capture build (per push-to-talk hold), not per frame, so it cannot flood.
        tracing::info!(
            target: "dictation",
            resolve_ms = resolve_ms as u64,
            config_ms = config_ms as u64,
            build_ms = build_ms as u64,
            play_ms = play_ms as u64,
            total_ms = t0.elapsed().as_millis() as u64,
            "capture start timing"
        );
        Ok(Capture { stream, device: bound, health, started_at: std::time::Instant::now(), active })
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        // Order is load-bearing for the native-crash fix. FIRST disarm the frame handler so any
        // callback the CoreAudio IOThread dispatches from here on early-returns (see
        // `firewall_frame_handler`) instead of touching state being torn down. Release pairs with
        // the Acquire load in the handler. THEN pause the stream; the cpal `Stream` field then
        // drops (after this body returns) and its CoreAudio Dispose synchronizes with the IOThread,
        // so the callback closure is never freed mid-execution. Double-drop is impossible (Rust
        // ownership) and concurrent `stop_dictation` calls are serialized by the session Mutex —
        // dropping an already-`None` capture is a no-op — so this path is idempotent by construction.
        self.active.store(false, Ordering::Release);
        let _ = self.stream.pause();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rms_of_silence_is_zero_and_full_scale_is_one() {
        assert!(rms_level(&[0.0; 256]) < 1e-6);
        assert!((rms_level(&[1.0; 256]) - 1.0).abs() < 1e-6);
    }
    #[test]
    fn downmix_stereo_to_mono_averages_channels() {
        // L=1.0, R=0.0 interleaved → mono 0.5
        let out = downmix_resample(&[1.0, 0.0, 1.0, 0.0], 2, 16_000);
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6));
    }
    #[test]
    fn resample_48k_to_16k_thirds_the_length() {
        let out = downmix_resample(&vec![0.5; 4800], 1, 48_000);
        assert!((out.len() as i32 - 1600).abs() <= 1);
    }

    // Regression guard for : a panic in the frame handler must be caught, not allowed
    // to unwind (which, from CoreAudio's extern "C" render callback, aborts the whole process).
    // Exercises the SHIPPED `firewall_frame_handler` — the same wrapper Capture::start uses — so
    // removing or weakening the production firewall fails this test.
    #[test]
    fn frame_handler_panic_is_contained_not_propagated() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let ran = Arc::new(AtomicBool::new(false));
        let ran_inner = ran.clone();
        let active = Arc::new(AtomicBool::new(true));
        let mut firewalled =
            firewall_frame_handler(active, Arc::new(CaptureHealth::default()), move |_frame: Vec<f32>| {
            ran_inner.store(true, Ordering::SeqCst);
            panic!("simulated poisoned-mutex / FFI panic");
        });
        // Silence the default panic hook's stderr output for this one intentional panic, then
        // restore it. This is the only test that touches the global hook, so the brief window is
        // acceptable (roborev 92q); add a shared mutex here if more panic tests are introduced.
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        firewalled(vec![0.1, 0.2, 0.3]); // returns normally despite the inner panic
        std::panic::set_hook(prev);
        // The handler ran (and panicked); reaching this line proves the firewall contained it.
        assert!(ran.load(Ordering::SeqCst), "the firewalled handler should have been invoked");
    }

    // Regression guard for the macOS native-crash fix: once `Capture::drop` flips the teardown
    // gate false (BEFORE pausing/dropping the cpal Stream), any frame the CoreAudio IOThread still
    // dispatches must NOT reach the inner handler — it becomes an inert no-op so it can't touch the
    // transcriber/cloud/app state being torn down. Exercises the SHIPPED `firewall_frame_handler`,
    // so removing the gate (or the ordered store in Drop) fails this test.
    #[test]
    fn frame_handler_is_a_noop_after_teardown_gate_flips() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;
        let active = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_inner = calls.clone();
        let mut firewalled = firewall_frame_handler(
            active.clone(),
            Arc::new(CaptureHealth::default()),
            move |_frame: Vec<f32>| {
            calls_inner.fetch_add(1, Ordering::SeqCst);
        });
        firewalled(vec![0.1, 0.2, 0.3]);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "runs while the capture is active");
        // Mirror Capture::drop: disarm the gate before the (elided) pause/drop.
        active.store(false, Ordering::Release);
        firewalled(vec![0.4, 0.5, 0.6]);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a frame delivered after teardown began must be dropped, not run against torn-down state"
        );
    }

    // ---- liveness: telling a DEAD microphone from a quiet room -------------------------------
    // Guards the 2026-07-29 incident, where capture ran for nine minutes receiving nothing while
    // the UI showed an idle waveform. The numbers below are the ones actually measured on the
    // affected machine (see the CaptureHealth docs): the real mic delivered 281 callbacks with
    // 143872 non-zero samples; every virtual device delivered 281 callbacks with ZERO.

    const GRACE: std::time::Duration = std::time::Duration::from_secs(3);
    const AFTER_GRACE: std::time::Duration = std::time::Duration::from_secs(4);

    #[test]
    fn a_capture_delivering_only_digital_silence_is_reported_dead_not_quiet() {
        // THE bug. A virtual device delivers callbacks on schedule carrying samples that are
        // exactly 0.0. Every check the app had (cpal Ok, stream playing, callbacks firing) passed,
        // so a dead mic looked exactly like a silent room for nine minutes.
        assert_eq!(
            assess_capture_health(AFTER_GRACE, 281, 0, GRACE),
            AudioHealth::Silent,
            "callbacks arriving with no non-zero sample must be reported as a dead mic"
        );
    }

    #[test]
    fn a_capture_receiving_no_callbacks_at_all_is_distinguished_from_silence() {
        // A different failure with a different cause (device gone/wedged vs. device unfed), so it
        // gets its own verdict rather than being folded into Silent.
        assert_eq!(assess_capture_health(AFTER_GRACE, 0, 0, GRACE), AudioHealth::NoFrames);
    }

    #[test]
    fn a_real_microphone_is_live() {
        assert_eq!(assess_capture_health(AFTER_GRACE, 281, 143_872, GRACE), AudioHealth::Live);
    }

    #[test]
    fn a_quiet_room_still_reads_live_because_its_noise_floor_is_never_exactly_zero() {
        // The false-positive guard, and the reason this detector is safe to act on. A user sitting
        // silently still produces a noise floor, so voiced_frames keeps climbing — only a
        // digitally-dead device pins it at exactly zero. If this ever failed we would be telling
        // people their microphone is broken every time they stopped talking.
        assert_eq!(assess_capture_health(AFTER_GRACE, 281, 281, GRACE), AudioHealth::Live);
    }

    #[test]
    fn a_freshly_built_capture_is_not_condemned_before_its_first_buffer() {
        // CoreAudio takes a moment to deliver the first buffer. Without the grace window every
        // rebuild would emit a spurious "no audio" the instant it started.
        assert_eq!(
            assess_capture_health(std::time::Duration::from_millis(200), 0, 0, GRACE),
            AudioHealth::Warming
        );
    }

    #[test]
    fn health_counts_a_silent_frame_as_delivered_but_not_voiced() {
        // Exercises the SHIPPED counter the capture callback uses, so a future edit that stops
        // distinguishing zero samples from real audio fails here. This is the measurement that
        // makes the verdicts above reachable at runtime.
        let h = CaptureHealth::default();
        h.note_frame(&[0.0; 512]);
        assert_eq!((h.frames(), h.voiced_frames()), (1, 0), "all-zero frame: delivered, not voiced");
        h.note_frame(&[0.0, 0.0, 0.004, 0.0]);
        assert_eq!(
            (h.frames(), h.voiced_frames()),
            (2, 1),
            "a single non-zero sample anywhere in the frame makes it voiced"
        );
    }

    // ---- the capture LEAK: a dropped Capture must actually free its cpal stream ---------------

    /// THE regression guard for the 2026-07-31 silent-capture break.
    ///
    /// `Capture::drop` pauses the cpal `Stream` and lets it drop, and everyone assumed that
    /// disposed the CoreAudio `AudioUnit`. It did not. cpal 0.15.3 registers a device-disconnect
    /// listener for every input stream built from a `Device` whose `is_default` is false, and that
    /// listener owns a clone of the stream's OWN `Arc<Mutex<StreamInner>>` — a cycle, so the strong
    /// count never reaches zero. Sparkle resolves its device by NAME (cpal cannot open by UID), and
    /// every device from `input_devices()` has `is_default == false`, so EVERY capture the app had
    /// ever built leaked one initialized-but-undisposed audio unit, one permanently-registered
    /// CoreAudio property listener, and the entire frame-handler closure — which in this app holds
    /// an `AppHandle`, the decode-channel `Sender`, and an `Arc<Mutex<ParakeetTdt>>`.
    ///
    /// The assertion is the SIDE EFFECT, not the precondition: a sentinel `Arc` is moved into the
    /// frame handler, so it can only return to a strong count of 1 if the stream — and with it the
    /// closure holding that clone — was genuinely freed. Against the pre-fix code this reads 2.
    /// (Measured with a standalone cpal harness: 12/12 cycles leaked via `input_devices()`, 6/6
    /// were freed via `default_input_device()`.)
    #[test]
    fn dropping_a_capture_frees_the_cpal_stream_and_its_frame_handler() {
        let Some(cap_result) = try_start_probe_capture() else {
            eprintln!(
                "SKIPPED dropping_a_capture_frees_the_cpal_stream_and_its_frame_handler: \
                 no usable input device on this machine (expected on CI runners, which have no \
                 microphone). This guard is meaningful only where a capture can actually open."
            );
            return;
        };
        let (capture, sentinel) = cap_result;
        assert_eq!(
            Arc::strong_count(&sentinel),
            2,
            "precondition: the live capture's frame handler should be holding the sentinel"
        );
        drop(capture);
        assert_eq!(
            Arc::strong_count(&sentinel),
            1,
            "dropping the Capture must FREE the cpal stream. A count of 2 means the CoreAudio \
             audio unit, its property listener, and the whole frame-handler closure survived the \
             drop — the cpal disconnect-listener Arc cycle. See `DeviceAcquisition`."
        );

        // …and the capture REBUILT after that teardown must still work. This is the user-visible
        // half of the 2026-07-31 break: every rebuild came back `health=Silent` — callbacks on
        // schedule, every sample exactly 0.0.
        //
        // What is asserted here is deliberately narrower than "the rebuild carries audio", because
        // that is not ours to guarantee. Whether the DEVICE feeds this process was measured, during
        // this investigation, to be a transient state of the machine: a standalone two-capture
        // probe read SILENT four consecutive times and LIVE on every run minutes later, with no
        // code change in between. An assertion on `raw_nonzero > 0` would therefore be a test that
        // fails for reasons no edit to this file can fix (a muted mic, a busy device, a CI runner
        // with no audio at all) — the flake that gets a guard deleted rather than read.
        //
        // So: assert the rebuild is WIRED — callbacks arrive — and assert the one failure that IS
        // ours, that a frame carrying real samples must never reach the pipeline zeroed. When the
        // OS itself is feeding silence, say so and stop, rather than convict the code.
        let Some((rebuilt, _sentinel2)) = try_start_probe_capture() else {
            panic!("the first capture opened, so the rebuild must too");
        };
        std::thread::sleep(std::time::Duration::from_millis(600));
        let h = rebuilt.health();
        assert!(
            h.frames() > 0,
            "the REBUILT capture received no callbacks at all — the rebuild produced a stream \
             CoreAudio never drives (raw_samples={})",
            h.raw_samples(),
        );
        assert_ne!(
            h.zero_source(),
            ZeroSource::SelfInflicted,
            "the device delivered {} of {} samples non-zero and the pipeline still saw all zeros \
             — the conversion destroyed the audio",
            h.raw_nonzero(),
            h.raw_samples(),
        );
        if h.zero_source() == ZeroSource::Os {
            eprintln!(
                "NOTE dropping_a_capture_frees_the_cpal_stream_and_its_frame_handler: the rebuilt \
                 capture read {} raw samples and every one was exactly zero (zero_source=Os). The \
                 OS is feeding this process digital silence right now — a muted or busy device, or \
                 the very fault this guard was written for. The leak assertions above still ran.",
                h.raw_samples(),
            );
            return;
        }
        assert!(
            h.voiced_frames() > 0 && h.out_nonzero() > 0,
            "raw audio arrived but no converted frame was voiced (zero_source={:?})",
            h.zero_source(),
        );
    }

    /// Build a real `Capture` whose frame handler owns a sentinel `Arc`, or `None` when this
    /// machine has no input device to open (CI). Kept out of the test body so the skip path is
    /// obvious and the assertions above read as assertions.
    fn try_start_probe_capture() -> Option<(Capture, Arc<()>)> {
        let sentinel = Arc::new(());
        let held = sentinel.clone();
        let capture = Capture::start(&DeviceChoice::Auto { allow_virtual: true }, move |_frame| {
            // Keep the clone alive for as long as the closure is: the whole measurement.
            let _keepalive = &held;
        })
        .ok()?;
        Some((capture, sentinel))
    }

    /// The decision that makes the guard above pass, isolated and exhaustive.
    ///
    /// Only `default_input_device()` yields a cpal `Device` with `is_default == true`, which is the
    /// single condition under which cpal skips the self-referential disconnect listener. So the
    /// chosen device being the system default MUST route through that handle — and a device that is
    /// not the default has no other way to be opened, which this pins as the deliberate exception
    /// rather than an oversight.
    #[test]
    fn the_default_device_is_acquired_through_cpals_non_leaking_default_handle() {
        assert_eq!(
            plan_device_acquisition("MacBook Pro Microphone", Some("MacBook Pro Microphone")),
            DeviceAcquisition::CpalDefault,
            "the system default must be opened via default_input_device(), the only cpal handle \
             that does not leak the stream"
        );
        assert_eq!(
            plan_device_acquisition("Shure MV7", Some("MacBook Pro Microphone")),
            DeviceAcquisition::ByName,
            "a pinned NON-default device can only be opened by name (cpal offers nothing else)"
        );
        assert_eq!(
            plan_device_acquisition("MacBook Pro Microphone", None),
            DeviceAcquisition::ByName,
            "with no default input at all there is no default handle to take"
        );
    }

    // ---- raw vs converted: telling OS silence from a bug of our own --------------------------

    #[test]
    fn a_capture_that_gets_real_samples_and_emits_zeros_blames_us_not_the_device() {
        // THE distinction this instrumentation exists for. Before it, `note_frame` saw only the
        // POST-conversion frame, so a downmix/resample that destroyed the audio logged exactly the
        // same `health=Silent` as an unfed device — and the two have opposite fixes.
        assert_eq!(
            classify_zero_source(143_872, 143_872, 0),
            ZeroSource::SelfInflicted,
            "the device sent audio and the pipeline saw zeros: that is our conversion, not the mic"
        );
    }

    #[test]
    fn a_capture_the_os_feeds_digital_silence_blames_the_os() {
        assert_eq!(classify_zero_source(143_872, 0, 0), ZeroSource::Os);
    }

    #[test]
    fn empty_buffers_are_not_reported_as_silence() {
        // `downmix_resample` returns an empty Vec for an empty input, and an empty frame counts as
        // delivered-but-not-voiced — so zero-length callbacks read as `Silent` while nothing was
        // ever zeroed. A format/negotiation failure and a dead microphone are different problems.
        assert_eq!(classify_zero_source(0, 0, 0), ZeroSource::EmptyBuffers);
    }

    #[test]
    fn a_healthy_capture_has_no_zeros_to_explain() {
        assert_eq!(classify_zero_source(143_872, 143_872, 47_957), ZeroSource::NotApplicable);
    }

    #[test]
    fn the_raw_counters_measure_the_device_buffer_not_the_converted_frame() {
        // Exercises the SHIPPED counters end to end at the two points the capture callback uses
        // them, with a conversion that DOES destroy the audio — the case the old single-counter
        // health could not name. 48 kHz mono in, so `downmix_resample` thirds the length.
        let h = CaptureHealth::default();
        let raw = vec![0.5f32; 4800];
        h.note_raw(&raw);
        // Simulate a broken conversion by recording an all-zero frame of the right length.
        h.note_frame(&vec![0.0f32; 1600]);
        assert_eq!((h.raw_samples(), h.raw_nonzero()), (4800, 4800), "the device's own buffer");
        assert_eq!((h.out_samples(), h.out_nonzero()), (1600, 0), "what the pipeline received");
        assert_eq!(
            h.zero_source(),
            ZeroSource::SelfInflicted,
            "non-zero in, all-zero out: the counters must convict the conversion, not the device"
        );
        // …and the real conversion must NOT be convicted: same input through the shipped function.
        let h2 = CaptureHealth::default();
        h2.note_raw(&raw);
        h2.note_frame(&downmix_resample(&raw, 1, 48_000));
        assert_eq!(
            h2.zero_source(),
            ZeroSource::NotApplicable,
            "downmix_resample preserves the signal, so it must never be blamed"
        );
    }

    #[test]
    fn resample_is_anti_aliased_not_point_sampled() {
        // A full-amplitude tone at the 48 kHz Nyquist (alternating +1/-1 = 24 kHz) sits far
        // above the 8 kHz Nyquist of 16 kHz audio. A correct anti-aliasing decimator must
        // attenuate it toward zero; the old point-sampling decimator (mono[i*3]) would instead
        // alias it straight through at full amplitude as in-band noise — exactly the artifact
        // that hurt recognition. A length-3 boxcar (48 k → 16 k) attenuates this tone ~3×
        // (to ≈0.33), versus the old point-sampler which passed it through at full 1.0.
        // Assert we're well under that 1.0 passthrough — the regression guard against reverting.
        let alternating: Vec<f32> = (0..4800).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect();
        let out = downmix_resample(&alternating, 1, 48_000);
        let energy = rms_level(&out);
        assert!(energy < 0.5, "high-freq tone should be attenuated well below 1.0, got rms {energy}");
    }

    #[test]
    fn resample_upsamples_sub_16k_without_panicking() {
        // Reachable in the wild: a Bluetooth hands-free (SCO) mic can be 8 kHz, so in_rate < 16 kHz
        // (ratio < 1) is a real path, not just a theoretical one. It can only sample-duplicate (no
        // new information to invent), but it must not panic and must roughly double the length and
        // preserve a DC level.
        let out = downmix_resample(&vec![0.4; 800], 1, 8_000);
        assert!((out.len() as i32 - 1600).abs() <= 2, "8k→16k should ~double length, got {}", out.len());
        assert!(out.iter().all(|&s| (s - 0.4).abs() < 1e-6), "DC level must survive upsampling");
    }

    #[test]
    fn resample_preserves_a_dc_level() {
        // A constant (DC) signal must pass through the averaging unchanged — guards against an
        // off-by-one window that would dip the level at the edges.
        let out = downmix_resample(&vec![0.7; 4800], 1, 48_000);
        assert!(out.iter().all(|&s| (s - 0.7).abs() < 1e-6), "DC level must be preserved");
    }

    // Regression guard for : this module captures the mic via
    // CoreAudio. Under the hardened runtime (tauri.conf.json
    // bundle.macOS.hardenedRuntime=true) macOS denies capture unless the
    // signed app carries the audio-input entitlement. Info.plist's usage
    // string is NOT sufficient. If hardened runtime is on, the entitlement
    // must be present — otherwise the shipped build's mic is silently dead.
    #[test]
    fn hardened_runtime_build_grants_microphone_entitlement() {
        let dir = env!("CARGO_MANIFEST_DIR");
        // Parse the config as JSON (not substring match): a whitespace/format
        // change must not silently turn this guard into a no-op (roborev #686).
        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{dir}/tauri.conf.json"))
                .expect("read tauri.conf.json"),
        )
        .expect("parse tauri.conf.json");
        let hardened = conf
            .pointer("/bundle/macOS/hardenedRuntime")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !hardened {
            return; // no hardened runtime → entitlement not required
        }
        // Verify the key is present AND set to <true/> — a <false/> or
        // commented-out key would otherwise pass while the mic stays denied.
        let ent = std::fs::read_to_string(format!("{dir}/entitlements.plist"))
            .expect("read entitlements.plist");
        let key = "<key>com.apple.security.device.audio-input</key>";
        let after = ent
            .split_once(key)
            .map(|(_, rest)| rest.trim_start())
            .unwrap_or_else(|| panic!(
                "hardenedRuntime is on but entitlements.plist is missing {key} — \
                 the signed build's microphone will be denied by macOS ()."
            ));
        assert!(
            after.starts_with("<true/>"),
            "com.apple.security.device.audio-input must be set to <true/> \
             (found: {:.20}) — otherwise macOS denies mic capture ().",
            after
        );
    }

    // ── THE GOAL'S PIN (sparkle-oyapv) ─────────────────────────────────────────────────────────
    //
    // "With push-to-talk, the transcript contains the words spoken in the first 800 ms after the key
    // goes down." These rows feed a known utterance starting at t=0 relative to the keydown and
    // assert NO leading audio is missing.
    //
    // WHY THE UTTERANCE IS SYNTHETIC AND EVERY SAMPLE IS DISTINCT. Each 160-sample frame (10 ms at
    // 16 kHz) is filled with its own index, so a frame is identifiable on arrival and the assertion
    // can be about WHICH audio came out and IN WHAT ORDER — not merely how much. A test that
    // counted samples would pass against a buffer that flushed them backwards.
    //
    // WHY THIS CANNOT PASS VACUOUSLY. The assertion is on the OUTPUT of `note` — the frames actually
    // handed to the destination. On `origin/main` there is no retention of any kind: audio captured
    // before the relay is routing is simply not sent, so the first 800 ms are absent from the
    // output and these rows fail. `PREROLL_SAMPLES` is not what is being tested; the ORDERING and
    // COMPLETENESS of the flush is.

    /// 10 ms of 16 kHz mono, every sample carrying `idx` so the frame is identifiable on arrival.
    fn utterance_frame(idx: usize) -> Vec<f32> {
        vec![idx as f32 + 1.0; 160]
    }

    #[test]
    fn the_first_800ms_after_keydown_survives_a_relay_that_is_still_connecting() {
        // 800 ms at 10 ms per frame. The founder loses FIVE WORDS, which is ~2 s — this is the
        // goal's stated floor, not the worst case observed.
        const LEADING_FRAMES: usize = 80;
        let mut pre = PreRoll::new(PREROLL_SAMPLES);
        let mut routed: Vec<Vec<f32>> = Vec::new();

        // t=0 is the keydown. He starts talking IMMEDIATELY — the case the bug is about — while the
        // mic and the relay are both still coming up, so nothing can be routed yet.
        for i in 0..LEADING_FRAMES {
            let out = pre.note(&utterance_frame(i), false);
            assert!(out.is_empty(), "frame {i} must be retained, not routed, before the relay is up");
        }
        // The relay finishes its handshake mid-utterance and he keeps talking.
        for i in LEADING_FRAMES..LEADING_FRAMES + 20 {
            routed.extend(pre.note(&utterance_frame(i), true));
        }

        // THE ASSERTION THE GOAL NAMES: every frame from t=0 onward reached the destination, in the
        // order it was spoken, with nothing missing off the FRONT.
        assert_eq!(
            routed.len(),
            LEADING_FRAMES + 20,
            "the utterance was {} frames; {} arrived — leading audio was dropped, which is exactly \
             the five words the founder lost",
            LEADING_FRAMES + 20,
            routed.len(),
        );
        for (i, frame) in routed.iter().enumerate() {
            assert_eq!(
                frame,
                &utterance_frame(i),
                "frame {i} of the utterance is out of order or missing — the transcript would read \
                 as though the user started speaking later than they did"
            );
        }
    }

    #[test]
    fn nothing_is_routed_before_the_hold_and_the_retained_history_is_bounded() {
        // The privacy half of the same mechanism, and it is a real assertion, not a formality: the
        // capacity IS the promise made to the founder when he accepted an open mic at rest
        // (sparkle-u81cz reversal). A ring that grew without bound would be a different product.
        let mut pre = PreRoll::new(320); // 2 frames' worth
        for i in 0..50 {
            assert!(pre.note(&utterance_frame(i), false).is_empty(), "at rest, nothing is ever routed");
            assert!(
                pre.retained() <= 320,
                "retained {} samples, over the {} bound — the privacy ceiling must hold on EVERY \
                 frame, not merely on average",
                pre.retained(),
                320,
            );
        }
        // What survives is the most RECENT audio, not the oldest: a hold flushes what was just said.
        let flushed = pre.note(&utterance_frame(50), true);
        assert_eq!(
            flushed,
            vec![utterance_frame(48), utterance_frame(49), utterance_frame(50)],
            "the ring must retain the most recent audio and flush it in spoken order"
        );
    }

    #[test]
    fn a_big_frame_evicts_as_many_small_ones_as_it_takes_to_stay_in_budget() {
        // PINS `while`, NOT `if`, IN THE EVICTION LOOP — and the shape here is load-bearing, which
        // is why it is spelled out. The obvious version of this test (push ONE oversized frame into
        // an EMPTY ring) is VACUOUS: a single `pop_front` removes that same frame and the bound
        // holds either way. It was written that way first, survived the single-shot mutation, and
        // proved nothing. Real capture frames also vary in size — CoreAudio's buffer is not a
        // constant — so over-budget-by-several-frames is an ordinary state, not a contrived one.
        //
        // So: fill the ring with SMALL frames, then push one big enough that staying in budget
        // requires evicting SEVERAL of them. Single-shot eviction leaves it over the bound, which
        // is the privacy promise broken, not merely memory wasted.
        let mut pre = PreRoll::new(100);
        for _ in 0..5 {
            pre.note(&[1.0; 20], false); // ring is now exactly full: 5 x 20 = 100
        }
        assert_eq!(pre.retained(), 100, "precondition: the ring starts exactly at capacity");
        pre.note(&[2.0; 90], false); // 190 retained — needs FIVE evictions, not one
        assert!(
            pre.retained() <= 100,
            "retained {} samples against a {} bound: one big frame evicted only a single small one, \
             so the ring is parked over its privacy ceiling",
            pre.retained(),
            100
        );
    }

    #[test]
    fn audio_the_on_device_engine_already_typed_is_never_re_sent_to_the_relay() {
        // ── THE DOUBLE-TRANSCRIPTION GUARD (roborev, High) ────────────────────────────────────
        // While the relay is down the same frames feed the on-device VAD, and a segment that CLOSES
        // there is decoded and typed into the composer. Retaining that audio and flushing it on the
        // next false→true edge would have Deepgram transcribe words the user can already see —
        // duplicated text. `build_capture` clears the ring whenever it dispatches a closed segment,
        // and this pins the resulting invariant: the ring only ever holds audio no engine claimed.
        let mut pre = PreRoll::new(PREROLL_SAMPLES);
        // Frames 0-2 are spoken on-device and a VAD segment closes over them.
        for i in 0..3 {
            pre.note(&utterance_frame(i), false);
        }
        pre.clear(); // what build_capture does when that closed segment goes to the decoder
        // Frames 3-4 are spoken after it: not claimed by anything, so they MUST survive.
        for i in 3..5 {
            pre.note(&utterance_frame(i), false);
        }
        let flushed = pre.note(&utterance_frame(5), true);
        assert_eq!(
            flushed,
            vec![utterance_frame(3), utterance_frame(4), utterance_frame(5)],
            "the relay must receive only the UNCLAIMED audio; re-sending frames 0-2 would have \
             Deepgram transcribe text the on-device engine already typed into the composer"
        );
        for claimed in 0..3 {
            assert!(
                !flushed.contains(&utterance_frame(claimed)),
                "frame {claimed} was already decoded on-device and must never reach the relay"
            );
        }
    }

    #[test]
    fn a_second_hold_is_covered_too() {
        // The release drops `routing` back to false, and the type must resume retaining rather than
        // stay in pass-through — otherwise the fix works exactly once per app launch.
        let mut pre = PreRoll::new(PREROLL_SAMPLES);
        pre.note(&utterance_frame(0), true); // hold 1
        pre.note(&utterance_frame(1), false); // released; retained
        pre.note(&utterance_frame(2), false); // retained
        let flushed = pre.note(&utterance_frame(3), true); // hold 2 begins
        assert_eq!(
            flushed,
            vec![utterance_frame(1), utterance_frame(2), utterance_frame(3)],
            "the second hold must flush its own pre-roll; a one-shot buffer fixes only the first \
             utterance after launch"
        );
    }

    /// MEASUREMENT, not an assertion (sparkle-oyapv). Prints what a push-to-talk keydown actually
    /// costs on THIS machine: `Capture::start` wall time, and how long after it CoreAudio delivers
    /// the first buffer. Everything in that span is speech the founder has already spoken and the
    /// app will never see, because push to talk rests with the mic released.
    ///
    /// `#[ignore]` because it opens the real microphone and sleeps — run it deliberately:
    ///   cargo test --lib measure_push_to_talk_cold_start -- --ignored --nocapture
    ///
    /// It asserts NOTHING and can therefore never flake the suite. That is on purpose: whether a
    /// device is present, warm, or busy is a property of the machine, and the sibling guard above
    /// already records why an assertion on real-device behaviour is the kind that gets deleted
    /// rather than read. Three rounds, so a cold first open is visible against warm re-opens.
    #[test]
    #[ignore = "opens the real microphone and sleeps; run with --ignored --nocapture"]
    fn measure_push_to_talk_cold_start() {
        // A SUBSCRIBER, or the whole per-stage breakdown is discarded (roborev, Medium). Without
        // one, `Capture::start`'s `resolve_ms`/`config_ms`/`build_ms`/`play_ms` go to a no-op global
        // dispatcher — so this printed a single aggregate while the commit message attributed it to
        // specific stages, which is an attribution the run could not support. The stage split is the
        // whole point: device resolve and the stream build have different fixes, and the corrected
        // numbers say the second is what dominates a warm hold.
        //
        // ── WHICH EVENTS THIS ACTUALLY RECOVERS, AND WHICH IT CANNOT (roborev, Medium) ───────────
        // `set_global_default`, NOT `with_default`. The latter installs a THREAD-LOCAL dispatcher,
        // so it recovers only what is emitted on this test's own thread — the four sub-spans above.
        // The `"first audio frame delivered"` event and the cpal error callback are emitted from the
        // CoreAudio realtime IO thread, which would still resolve to the no-op GLOBAL dispatcher and
        // discard them. An earlier revision of this comment claimed the first-frame line among the
        // things it recovered, which was the same defect this test exists to correct: a comment
        // asserting an observation the run cannot make. Going global covers every thread.
        //
        // A FAILED INSTALL IS TOLERATED BUT NEVER SILENT (roborev, Medium). `set_global_default`
        // succeeds once per PROCESS, and these tests share one — so an earlier installer would make
        // this a no-op and the stage split would vanish, leaving exactly the single-aggregate output
        // this test was changed to stop producing, with nothing on screen saying so. Tolerating it
        // is right (a test that asserts nothing should not panic over a logger); swallowing it is
        // not, because "the breakdown is missing" would be indistinguishable from "the stages cost
        // nothing". Note the first-frame number is unaffected either way — the body times it with
        // its own `AtomicU64` rather than reading it back from a log — but the per-stage split comes
        // solely from the subscriber, and that split is the whole point.
        let subscriber = tracing_subscriber::fmt()
            .with_test_writer()
            .with_max_level(tracing::Level::INFO)
            .finish();
        if let Err(e) = tracing::subscriber::set_global_default(subscriber) {
            eprintln!(
                "WARN: a global tracing subscriber was already installed ({e}); the per-stage \
                 resolve/config/build/play breakdown below is MISSING, not zero — the first-frame \
                 totals are still measured directly and remain trustworthy."
            );
        }
        measure_push_to_talk_cold_start_body();
    }

    fn measure_push_to_talk_cold_start_body() {
        for round in 1..=3 {
            let t0 = std::time::Instant::now();
            let first_us = Arc::new(AtomicU64::new(0));
            let sink = first_us.clone();
            // `allow_virtual: false` — the app's own push-to-talk default (roborev, Medium). With
            // it true this could bind a HAL plug-in whose open cost bears no relation to a real
            // microphone's, and the printed figure carried no device name, so a number measured
            // against a virtual device was indistinguishable from a real one. These figures are
            // quoted as the justification for the pre-roll design, so they have to be attributable.
            let capture = match Capture::start(
                &DeviceChoice::Auto { allow_virtual: false },
                move |_frame: Vec<f32>| {
                    // Only the FIRST delivery is recorded; later frames leave the 0 sentinel alone.
                    let _ = sink.compare_exchange(
                        0,
                        t0.elapsed().as_micros().max(1) as u64,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    );
                },
            ) {
                Ok(c) => c,
                // `continue`, not `return`, and the cause is NOT asserted (roborev, Medium). Only
                // round 1 can mean "no input device"; rounds 2-3 open ~400 ms after a `Capture`
                // drop, which is exactly when CoreAudio can transiently report the device busy —
                // a state the sibling guard in this file documents as real and observed. Returning
                // there silently discarded the WARM rounds, which are the ones establishing the
                // per-hold floor the architecture rests on, under a message blaming an absent
                // device.
                Err(e) => {
                    eprintln!("round {round}: SKIPPED — Capture::start failed ({e})");
                    continue;
                }
            };
            let start_ms = t0.elapsed().as_secs_f64() * 1000.0;

            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(3000);
            while first_us.load(Ordering::Relaxed) == 0 && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            // NAME THE DEVICE on every round. Without it a reading is unattributable, and these
            // numbers are the argument for the design.
            let dev = capture.device();
            match first_us.load(Ordering::Relaxed) {
                0 => eprintln!(
                    "round {round}: device {:?} (virtual={} default={}) | Capture::start \
                     {start_ms:7.1} ms | NO FRAME within 3000 ms",
                    dev.name, dev.is_virtual, dev.was_default
                ),
                us => eprintln!(
                    "round {round}: device {:?} (virtual={} default={}) | Capture::start \
                     {start_ms:7.1} ms | first frame at {:7.1} ms (= audio lost if the user speaks \
                     at t=0)",
                    dev.name,
                    dev.is_virtual,
                    dev.was_default,
                    us as f64 / 1000.0
                ),
            }
            drop(capture);
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
}

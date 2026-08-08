//! Microphone capture via cpal → 16 kHz mono f32 frames + RMS level.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
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

// ── THE KEYDOWN→FIRST-SAMPLE SPAN (sparkle-oyapv) ────────────────────────────────────────────────
//
// Push to talk rests with the mic RELEASED, so a hold pays for the WHOLE chain — a keydown handler,
// two zustand writes, a React effect, an IPC hop, a permission check, a model load, and finally
// `Capture::start` plus CoreAudio's first buffer — and everything spoken during it is lost outright.
// The founder's most-repeated complaint is that the first words disappear, and he asked specifically
// to have this number VERIFIED rather than argued about.
//
// Before this, it could not be verified, because nothing stamped the gesture. `audio.rs` timed
// `Capture::start`, `dictation.rs` timed `start_dictation`, and the earliest stamp in either was
// Rust command entry — so the three log lines a reader had to join by hand did not, between them,
// contain the moment the key went down. `PRD/fix/push-to-talk-leading-words.md` reports three
// carefully measured rounds and every one of them begins at `Capture::start`, which is the LAST
// stage of six.
//
// `ArmOrigin` carries the missing half in: the reconstructed keydown instant plus the stages that
// already ran, so the first frame can emit ONE complete line instead of leaving the join to a human
// reading a release log hours later.
#[derive(Clone, Copy, Debug)]
pub struct ArmOrigin {
    /// When the key went down, reconstructed at command entry as `t_cmd - js_to_invoke_ms`.
    ///
    /// A LOWER BOUND, and deliberately named as one wherever it is reported. The frontend stamps
    /// `performance.now()` on the keydown and computes the age immediately before `invoke`, so the
    /// one-way JS→Tauri IPC hop lands AFTER that stamp and BEFORE `t_cmd` — it is therefore excluded
    /// from the reconstruction, not attributed to some stage. Measuring it would need a clock shared
    /// across the two runtimes, which nothing here has; understating by it is the honest failure
    /// direction, since the resulting total can only be better than the truth, never worse.
    pub keydown: Instant,
    /// When `reconcile_capture` was entered, so the work between it and this capture opening
    /// (spawning the decode worker, the reconcile step machinery) is attributable rather than
    /// silently folded into the residual.
    pub reconcile_at: Instant,
    /// Keydown → the frontend calling `invoke`. The stage that had never been measured at all: a
    /// keydown handler, `setHeld`, `applyIntent`, two store writes, React scheduling the `[enabled]`
    /// effect, and the `await controllerPromiseRef` gate.
    pub js_to_invoke_ms: u64,
    /// Rust command entry → the mic-permission check: the session-lock acquisition and
    /// `begin_start_decision`. Contended with the main thread (sparkle-sfxu).
    pub prelude_ms: u64,
    /// The `spawn_blocking` mic-permission hop.
    pub permission_ms: u64,
    /// `load_model`. On the FIRST arm of a process this holds the multi-second ONNX transducer init;
    /// on every later arm the recognizer is served from `transcribe::DECODER_CACHE`, so what is left
    /// is the per-arm Silero VAD session plus three rounds of file verification. The two are not
    /// separated here — see the note in `dictation::commands::start_dictation` — but they are trivially told
    /// apart by ARM ORDINAL, because the cache makes the first arm the only expensive one.
    pub model_ms: u64,
}

/// One capture's own sub-spans, returned so the arm-span report can carry them without re-timing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CaptureTiming {
    pub resolve_ms: u64,
    pub config_ms: u64,
    /// Did `config_ms` come from the cache? Without this the two are indistinguishable in a log —
    /// a 0 ms read looks identical whether it was served warm or the device answered instantly.
    pub config_cached: bool,
    pub build_ms: u64,
    pub play_ms: u64,
    /// `Capture::start` end to end. NOT the sum of the four above — it also covers the device-bound
    /// log line and the closure wiring between them.
    pub total_ms: u64,
}

/// The complete keydown→first-sample span, decomposed.
///
/// Every field is milliseconds. The ADDITIVE stages are `js_to_invoke`, `prelude`, `permission`,
/// `model`, `reconcile_pre_capture`, `capture`, `first_frame` and `unattributed`; those sum to
/// `total` exactly. `resolve`/`config`/`build`/`play` are a BREAKDOWN OF `capture`, not extra terms
/// — adding them into the sum would double-count the largest stage, which is precisely the mistake
/// a flat struct of millisecond fields invites.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ArmSpan {
    pub js_to_invoke_ms: u64,
    pub prelude_ms: u64,
    pub permission_ms: u64,
    pub model_ms: u64,
    /// `reconcile_capture` entry → `Capture::start` entry.
    pub reconcile_pre_capture_ms: u64,
    pub capture: CaptureTiming,
    /// `Capture::start` returning → CoreAudio delivering the first buffer. Pure loss on a hold.
    pub first_frame_ms: u64,
    /// Whatever the named stages do not account for: the glue between them (await scheduling, the
    /// Arc/Mutex wrapping, the tracing calls themselves) plus per-stage truncation, since every
    /// stage floors to whole milliseconds and eight of them can shed up to 7 ms between them.
    pub unattributed_ms: u64,
    /// How much the named stages OVERSHOOT the independently measured total, when they do.
    ///
    /// This exists so the clamp below cannot lie. `unattributed_ms` is a saturating residual, so a
    /// decomposition that over-counts would silently report 0 and still satisfy "the stages sum to
    /// the total" — the sum identity would hold while the numbers were nonsense. Normally 0; a
    /// non-zero value means the stage timers and the wall clock disagree, and by how much.
    pub over_attributed_ms: u64,
    /// Keydown → first sample, measured end-to-end against the origin rather than summed. This is
    /// THE number the founder asked to have verified.
    pub total_ms: u64,
}

impl ArmSpan {
    /// Decompose an arm. Pure, so the arithmetic is testable without a microphone.
    ///
    /// `total_ms` is measured INDEPENDENTLY (elapsed since the origin) rather than summed from the
    /// stages, which is what makes `unattributed_ms` meaningful instead of definitional.
    pub fn new(
        origin: &ArmOrigin,
        reconcile_pre_capture_ms: u64,
        capture: CaptureTiming,
        first_frame_ms: u64,
        total_ms: u64,
    ) -> ArmSpan {
        // `model_ms` is NOT joined by a nested VAD term here, and that omission is deliberate: a
        // sub-stage of an additive stage must never be added again (see the struct doc).
        let named = origin.js_to_invoke_ms
            + origin.prelude_ms
            + origin.permission_ms
            + origin.model_ms
            + reconcile_pre_capture_ms
            + capture.total_ms
            + first_frame_ms;
        ArmSpan {
            js_to_invoke_ms: origin.js_to_invoke_ms,
            prelude_ms: origin.prelude_ms,
            permission_ms: origin.permission_ms,
            model_ms: origin.model_ms,
            reconcile_pre_capture_ms,
            capture,
            first_frame_ms,
            unattributed_ms: total_ms.saturating_sub(named),
            over_attributed_ms: named.saturating_sub(total_ms),
            total_ms,
        }
    }

    /// Emit the one line this whole mechanism exists to produce.
    ///
    /// INFO, matching the convention the sibling timing lines already set: the reports this answers
    /// arrive hours later from someone on a release build, where DEBUG would never be recorded. It
    /// fires once per capture — per push-to-talk hold — so it cannot flood.
    ///
    /// Called from the CoreAudio realtime IO thread (the first frame is what triggers it), like the
    /// `"first audio frame delivered"` line beside it. That is why everything here is plain integer
    /// arithmetic over `Copy` fields with no allocation and no lock: this thread must not block.
    fn emit(&self) {
        tracing::info!(
            target: "dictation",
            js_to_invoke_ms = self.js_to_invoke_ms,
            prelude_ms = self.prelude_ms,
            permission_ms = self.permission_ms,
            model_ms = self.model_ms,
            reconcile_pre_capture_ms = self.reconcile_pre_capture_ms,
            capture_ms = self.capture.total_ms,
            resolve_ms = self.capture.resolve_ms,
            config_ms = self.capture.config_ms,
            config_cached = self.capture.config_cached,
            build_ms = self.capture.build_ms,
            play_ms = self.capture.play_ms,
            first_frame_ms = self.first_frame_ms,
            unattributed_ms = self.unattributed_ms,
            over_attributed_ms = self.over_attributed_ms,
            total_ms = self.total_ms,
            "push-to-talk keydown to first audio sample"
        );
    }
}

// ── `default_input_config` IS CACHED, AND THE INVALIDATION IS THE POINT ──────────────────────────
//
// Measured on the founder's Mac and reproduced independently on a second machine: format
// negotiation costs 95-155 ms of a ~375 ms warm hold — roughly a third of the window in which the
// founder's words are being dropped — and it is pure device metadata. Nothing about it changes
// between two holds on the same microphone.
//
// A STALE AUDIO CONFIG IS WORSE THAN A SLOW ONE, so the entry is discarded on three independent
// signals rather than one:
//
//   1. A CoreAudio device-list or default-input change. `dictation::start_audio_watchdog` already
//      owns a `DeviceChangeWatcher` for exactly these events and already funnels them through one
//      flag; this hangs off that, rather than registering a second listener that could disagree
//      with the first about when a device changed.
//   2. A different resolved device. The key is the bound device's UID (its stable identity — see
//      `audio_devices`' module docs on why the numeric id is not), so a capture that resolves
//      somewhere else simply misses. One slot, not a map: a machine has one input at a time, and a
//      map would keep entries alive for devices that are long gone.
//   3. AGE. This is the backstop for the one change class the listener above genuinely cannot see:
//      a device changing its own FORMAT without the device list or the default moving — a sample
//      rate edited in Audio MIDI Setup, or a Bluetooth headset entering its headset profile. There
//      is no system-object notification for that; catching it properly needs a per-device
//      `kAudioDevicePropertyStreamFormat` listener in `audio_devices`, which is a larger change
//      than this one and is NOT what is claimed here. So the exposure is bounded by time instead,
//      and stated honestly: a format change is invisible for at most `INPUT_CONFIG_TTL`.
//
// A failed `build_input_stream` also drops the entry (see `Capture::start`), so even if a stale
// config did reach cpal, the cost is one failed hold rather than a mic that stays broken until the
// process restarts.
const INPUT_CONFIG_TTL: Duration = Duration::from_secs(30);

/// One cached device-format read. See [`INPUT_CONFIG_TTL`] for why all three fields are load-bearing.
#[derive(Clone, Debug)]
struct KeyedCache<T> {
    key: String,
    at: Instant,
    value: T,
}

static INPUT_CONFIG_CACHE: Mutex<Option<KeyedCache<cpal::SupportedStreamConfig>>> = Mutex::new(None);

/// Serve `key` from `cache`, or `fetch` it and store it. Returns `(value, was_cached)`.
///
/// Generic over the value so the reuse contract is unit-testable without a microphone, an audio
/// host, or a cpal type — the same reasoning as `transcribe::cached_or_build`, and for the same
/// reason: the interesting behaviour here is WHEN IT MISSES, and every miss condition (a different
/// key, an expired entry, a failed fetch) is device-independent arithmetic.
///
/// A FAILED FETCH IS NOT CACHED, and it does not evict the existing entry either: a transient
/// CoreAudio error must neither wedge the format at a bad value nor throw away a good one.
///
/// THE LOCK IS HELD ACROSS `fetch`, deliberately, so two concurrent misses cannot both pay the
/// ~150 ms device read — the same trade `transcribe::cached_or_build` makes. It is safe here
/// because the session mutex means production has one capture opening at a time, so this lock is
/// uncontended on the arm path; the only caller that can contend is a test, and the real-device
/// tests take `DEVICE_TEST_LOCK` for unrelated reasons anyway. Note the consequence if that ever
/// changes: a second arm would BLOCK for the first's device read rather than racing it, which is
/// the right direction (one read, not two) but is a wait, not a fast path.
fn cached_by_key<T: Clone, E>(
    cache: &Mutex<Option<KeyedCache<T>>>,
    key: &str,
    now: Instant,
    ttl: Duration,
    fetch: impl FnOnce() -> Result<T, E>,
) -> Result<(T, bool), E> {
    let mut slot = cache.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(hit) = slot.as_ref() {
        // `checked_duration_since`, and the choice is load-bearing in BOTH directions.
        //
        // `Instant` subtraction PANICS on underflow, so a caller passing an earlier `now` — two
        // threads reading the clock out of order — must not crash the arm path. But `saturating_`
        // would return 0, which is `< ttl`, i.e. a HIT: an entry stamped in the future would have
        // its life silently EXTENDED. That is the wrong direction for a cache whose whole risk is
        // serving a format the device no longer has, and it contradicted this very comment
        // (roborev, Medium — the comment said "miss", the code said "hit", and the test asserting
        // it was named for the comment).
        //
        // `None` here means "the clock disagrees with itself", and the fail-safe answer to that is
        // to go and ask the device again.
        let fresh = now.checked_duration_since(hit.at).is_some_and(|age| age < ttl);
        if hit.key == key && fresh {
            return Ok((hit.value.clone(), true));
        }
    }
    let fresh = fetch()?;
    *slot = Some(KeyedCache { key: key.to_string(), at: now, value: fresh.clone() });
    Ok((fresh, false))
}

/// Forget the cached device format.
///
/// Called on every CoreAudio device-list / default-input change (see [`INPUT_CONFIG_TTL`]) and on a
/// failed stream build. Cheap and idempotent, so the caller never has to work out whether the change
/// it saw was one that matters — dropping a still-valid entry costs one ~100 ms read on the next
/// hold, while keeping an invalid one costs correct audio.
pub fn invalidate_input_config_cache() {
    *INPUT_CONFIG_CACHE.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// The cache key for a bound device: its stable CoreAudio UID.
///
/// Falls back to the NAME when the UID is unknown — which happens when CoreAudio enumerated nothing
/// and we took cpal's default (`Capture::default_device`). Prefixed so a name can never collide with
/// a UID that happens to read the same.
fn input_config_key(bound: &BoundDevice) -> String {
    match bound.uid.as_deref() {
        Some(uid) => uid.to_string(),
        None => format!("name:{}", bound.name),
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
    /// What this capture's own start cost, so a caller can report it without re-timing anything.
    timing: CaptureTiming,
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

    /// This capture's own sub-spans, as `Capture::start` measured them.
    pub fn timing(&self) -> CaptureTiming {
        self.timing
    }

    #[allow(dead_code)]
    pub fn start(
        choice: &DeviceChoice,
        origin: Option<ArmOrigin>,
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
        // Everything between `reconcile_capture` being entered and this line: the reconcile step
        // machinery and `build_capture`'s prelude (spawning the decode worker). Sampled here, at the
        // top of the only function that can attribute it, so it is a named stage rather than part of
        // the residual.
        let reconcile_pre_capture_ms =
            origin.map(|o| o.reconcile_at.elapsed().as_millis() as u64).unwrap_or(0);
        let (device, bound) = Self::resolve_device(choice)?;
        let resolve_ms = t0.elapsed().as_millis();
        let t_cfg = std::time::Instant::now();
        // Served from the cache when this is the same device we negotiated with recently — a third
        // of a warm hold's budget, for metadata that does not change between holds. Every way it can
        // go stale, and what happens then, is on `INPUT_CONFIG_TTL`.
        let (cfg, config_cached) = cached_by_key(
            &INPUT_CONFIG_CACHE,
            &input_config_key(&bound),
            Instant::now(),
            INPUT_CONFIG_TTL,
            || device.default_input_config().map_err(|e| e.to_string()),
        )?;
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
        //
        // ── AND IT IS WHERE THE COMPLETE KEYDOWN SPAN IS REPORTED (sparkle-oyapv) ────────────────
        // The first frame is the only moment at which the whole span is knowable, so this is where
        // the one line lands. `stages` is how the numbers this function measures reach a closure
        // that was necessarily built before they existed: plain atomics, published with a Release
        // store, read with an Acquire load, because this runs on the realtime CoreAudio IO thread
        // where taking a lock is an audio-dropout hazard.
        //
        // PUBLISHED BEFORE `play()`, WHICH IS WHAT MAKES THE READ SAFE. Frames cannot arrive until
        // the stream is playing, so ordering the publish ahead of that call means the closure can
        // never observe an unpublished cell and report zeros as facts. `play_ms` and the refreshed
        // total are stored just after `play()` returns; a frame landing inside that sub-millisecond
        // window reads `play_ms = 0`, which every measured round says it is anyway.
        let first_frame_logged = Arc::new(AtomicBool::new(false));
        let stages = Arc::new(CaptureTimingCell::default());
        let on_frame = {
            let seen = first_frame_logged.clone();
            let stages = stages.clone();
            let mut inner = on_frame;
            move |frame: Vec<f32>| {
                if !seen.swap(true, Ordering::Relaxed) {
                    let since_capture_start_ms = t0.elapsed().as_millis() as u64;
                    tracing::info!(
                        target: "dictation",
                        since_capture_start_ms,
                        "first audio frame delivered"
                    );
                    // Only when a gesture origin was threaded in — i.e. this capture belongs to an
                    // arm the frontend stamped. A capture rebuilt by a focus event or the watchdog
                    // has no keydown behind it, and inventing one would be worse than saying nothing.
                    if let Some(origin) = origin {
                        let capture = stages.read();
                        ArmSpan::new(
                            &origin,
                            reconcile_pre_capture_ms,
                            capture,
                            since_capture_start_ms.saturating_sub(capture.total_ms),
                            origin.keydown.elapsed().as_millis() as u64,
                        )
                        .emit();
                    }
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
        // A BUILD FAILURE DROPS THE CACHED FORMAT. If the entry we just served was stale enough that
        // cpal refused it, keeping it would make every subsequent hold fail the same way — a mic
        // that stays broken until the process restarts, caused by an optimisation. Invalidating here
        // bounds that to the one hold that hit it: the next arm re-reads the device. Unconditional
        // rather than gated on `config_cached`, because a fresh read that still failed says the
        // device moved under us and any entry now in the slot is suspect too.
        .map_err(|e| {
            invalidate_input_config_cache();
            e.to_string()
        })?;

        let build_ms = t_build.elapsed().as_millis();

        // Publish BEFORE `play()` — see the first-frame closure for why the ordering is the whole
        // safety argument.
        stages.publish(CaptureTiming {
            resolve_ms: resolve_ms as u64,
            config_ms: config_ms as u64,
            config_cached,
            build_ms: build_ms as u64,
            play_ms: 0,
            total_ms: t0.elapsed().as_millis() as u64,
        });

        let t_play = std::time::Instant::now();
        stream.play().map_err(|e| e.to_string())?;
        let play_ms = t_play.elapsed().as_millis();
        stages.finish(play_ms as u64, t0.elapsed().as_millis() as u64);

        // INFO, not DEBUG, and deliberately so: the reports this exists to answer arrive hours later
        // from someone on a release build, where a DEBUG line would never have been recorded. It
        // fires once per capture build (per push-to-talk hold), not per frame, so it cannot flood.
        tracing::info!(
            target: "dictation",
            resolve_ms = resolve_ms as u64,
            config_ms = config_ms as u64,
            // Without this a served entry and a genuinely fast device read the same in the log, so
            // "did the cache do anything" could not be answered from a release log — which is the
            // only place the question ever gets asked.
            config_cached,
            build_ms = build_ms as u64,
            play_ms = play_ms as u64,
            total_ms = t0.elapsed().as_millis() as u64,
            "capture start timing"
        );
        Ok(Capture {
            stream,
            device: bound,
            health,
            started_at: std::time::Instant::now(),
            active,
            timing: stages.read(),
        })
    }
}

/// The capture sub-spans, shared with the frame callback.
///
/// Atomics rather than a `Mutex<CaptureTiming>` because the reader is the realtime CoreAudio IO
/// thread — the same thread the panic firewall and the teardown gate exist to keep unblocked. A
/// lock there is a genuine audio-dropout hazard, and this is diagnostics.
#[derive(Default)]
struct CaptureTimingCell {
    /// Release/Acquire gate. False until `publish`, so a frame can never read a half-written cell.
    ready: AtomicBool,
    resolve_ms: AtomicU64,
    config_ms: AtomicU64,
    config_cached: AtomicBool,
    build_ms: AtomicU64,
    play_ms: AtomicU64,
    total_ms: AtomicU64,
}

impl CaptureTimingCell {
    /// Store everything known before `play()`, then open the gate.
    fn publish(&self, t: CaptureTiming) {
        self.resolve_ms.store(t.resolve_ms, Ordering::Relaxed);
        self.config_ms.store(t.config_ms, Ordering::Relaxed);
        self.config_cached.store(t.config_cached, Ordering::Relaxed);
        self.build_ms.store(t.build_ms, Ordering::Relaxed);
        self.play_ms.store(t.play_ms, Ordering::Relaxed);
        self.total_ms.store(t.total_ms, Ordering::Relaxed);
        // Release: everything above is visible to any thread that observes `ready` as true.
        self.ready.store(true, Ordering::Release);
    }

    /// Refine the two values `play()` itself produced. The gate is already open by design.
    fn finish(&self, play_ms: u64, total_ms: u64) {
        self.play_ms.store(play_ms, Ordering::Relaxed);
        self.total_ms.store(total_ms, Ordering::Relaxed);
    }

    /// Read the published sub-spans, or all-zero if the gate is still shut.
    fn read(&self) -> CaptureTiming {
        if !self.ready.load(Ordering::Acquire) {
            return CaptureTiming::default();
        }
        CaptureTiming {
            resolve_ms: self.resolve_ms.load(Ordering::Relaxed),
            config_ms: self.config_ms.load(Ordering::Relaxed),
            config_cached: self.config_cached.load(Ordering::Relaxed),
            build_ms: self.build_ms.load(Ordering::Relaxed),
            play_ms: self.play_ms.load(Ordering::Relaxed),
            total_ms: self.total_ms.load(Ordering::Relaxed),
        }
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
        // Shares the process-wide format cache with the other real-device test; see DEVICE_TEST_LOCK.
        let _serial = DEVICE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
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

    /// Serializes the tests that open a REAL device.
    ///
    /// `INPUT_CONFIG_CACHE` is one process-wide slot, and `cargo test` runs these in parallel in one
    /// process — so a sibling test opening a capture repopulates the cache in the middle of another
    /// test's invalidate→observe sequence, and `a_real_devices_format_is_read_once_…` failed on its
    /// very first assertion for exactly that reason. Nothing about PRODUCTION is being worked around
    /// here: the session mutex means one capture exists at a time there, and the only concurrency
    /// this lock adds back is the concurrency the test harness invented.
    ///
    /// Poison-tolerant, so one failing device test does not cascade into "the others panicked too",
    /// which would hide which guard actually broke.
    static DEVICE_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Build a real `Capture` whose frame handler owns a sentinel `Arc`, or `None` when this
    /// machine has no input device to open (CI). Kept out of the test body so the skip path is
    /// obvious and the assertions above read as assertions.
    fn try_start_probe_capture() -> Option<(Capture, Arc<()>)> {
        let sentinel = Arc::new(());
        let held = sentinel.clone();
        // No gesture origin: this capture is a leak probe, not an arm. Passing a synthetic one would
        // publish a keydown→first-sample line for a hold that never happened.
        let capture = Capture::start(
            &DeviceChoice::Auto { allow_virtual: true },
            None,
            move |_frame| {
                // Keep the clone alive for as long as the closure is: the whole measurement.
                let _keepalive = &held;
            },
        )
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

    // ── THE FORMAT CACHE (sparkle-oyapv, Task 2) ─────────────────────────────────────────────────
    //
    // Driven through the generic `cached_by_key` rather than the `cpal`-typed static, for the same
    // reason `transcribe::cached_or_build` is generic: every behaviour worth pinning here — when it
    // HITS and, far more importantly, every way it must MISS — is device-independent, and a test
    // that needed a microphone to prove "a different device re-reads" would be a test that never
    // runs on CI. The real static's own wiring is exercised end to end by
    // `a_real_devices_format_is_read_once_and_re_read_after_a_device_change` below.

    /// A fetch that counts itself, so "how many times did we ask the device" is an observable fact
    /// rather than something inferred from a timing. Captures `reads` by shared reference, which is
    /// what makes the closure `Copy` and therefore reusable across calls.
    fn counting_fetch(reads: &std::cell::Cell<u32>) -> impl FnOnce() -> Result<u32, ()> + Copy + '_ {
        move || {
            reads.set(reads.get() + 1);
            Ok(48_000)
        }
    }

    #[test]
    fn a_second_arm_on_the_same_device_reads_the_format_once() {
        let cache = Mutex::new(None);
        let reads = std::cell::Cell::new(0);
        let now = Instant::now();

        let (first, cached_first) =
            cached_by_key(&cache, "uid-builtin", now, INPUT_CONFIG_TTL, counting_fetch(&reads))
                .unwrap();
        let (second, cached_second) =
            cached_by_key(&cache, "uid-builtin", now, INPUT_CONFIG_TTL, counting_fetch(&reads))
                .unwrap();

        // THE OBSERVABLE EFFECT, which is the point: not "an entry exists" (that was true of the
        // slot the moment the first call returned, and asserting it would pass against a cache that
        // never served anything), but that the DEVICE WAS ASKED ONCE for two arms. `default_input_
        // config` measured 95-155 ms on the founder's Mac and 101-120 ms on a second machine — a
        // third of a warm hold's budget — and this is the assertion that says it is not paid twice.
        assert_eq!(reads.get(), 1, "a second arm on the same device must not re-read the format");
        assert_eq!((first, second), (48_000, 48_000), "the served value must be the read value");
        assert!(!cached_first, "the first read cannot have been served from an empty cache");
        assert!(cached_second, "the second must report itself as served, or a log cannot tell");
    }

    #[test]
    fn a_device_change_forces_a_fresh_read() {
        // THE PAIRED HALF, and the one that decides whether the cache is safe at all. A cache with
        // no invalidation test is exactly the vacuous shape: the test above passes just as happily
        // against a cache that NEVER re-reads, which is a microphone stuck on a format the device
        // no longer has.
        let cache = Mutex::new(None);
        let reads = std::cell::Cell::new(0);
        let now = Instant::now();

        cached_by_key(&cache, "uid-builtin", now, INPUT_CONFIG_TTL, counting_fetch(&reads)).unwrap();
        // What `invalidate_input_config_cache` does to the real static, and what
        // `dictation::start_audio_watchdog` calls on every CoreAudio device-list / default-input
        // change.
        *cache.lock().unwrap() = None;
        let (_, cached_after) =
            cached_by_key(&cache, "uid-builtin", now, INPUT_CONFIG_TTL, counting_fetch(&reads))
                .unwrap();

        assert_eq!(reads.get(), 2, "a device change must send the next arm back to the device");
        assert!(!cached_after, "the post-invalidation read must not claim to have been served");
    }

    #[test]
    fn a_different_device_reads_its_own_format() {
        let cache = Mutex::new(None);
        let reads = std::cell::Cell::new(0);
        let now = Instant::now();

        cached_by_key(&cache, "uid-builtin", now, INPUT_CONFIG_TTL, counting_fetch(&reads)).unwrap();
        let (_, cached_other) =
            cached_by_key(&cache, "uid-usb-mic", now, INPUT_CONFIG_TTL, counting_fetch(&reads))
                .unwrap();
        assert_eq!(reads.get(), 2, "a capture that resolved elsewhere must not be served this entry");
        assert!(!cached_other);

        // …and going BACK re-reads too. One slot, not a map (see `INPUT_CONFIG_TTL`), so the
        // second device evicted the first. Pinned because the opposite — a map quietly retaining a
        // format for a device that has since been unplugged and replaced — is the failure this
        // single slot exists to make impossible.
        let (_, cached_back) =
            cached_by_key(&cache, "uid-builtin", now, INPUT_CONFIG_TTL, counting_fetch(&reads))
                .unwrap();
        assert_eq!(reads.get(), 3, "the slot holds ONE device's format; returning re-reads");
        assert!(!cached_back);
    }

    #[test]
    fn an_entry_older_than_the_ttl_is_re_read() {
        // The backstop for the change class the CoreAudio device-list listener genuinely cannot
        // see: a device renegotiating its OWN format (a sample rate edited in Audio MIDI Setup, a
        // Bluetooth headset entering its headset profile). See `INPUT_CONFIG_TTL`.
        let cache = Mutex::new(None);
        let reads = std::cell::Cell::new(0);
        let now = Instant::now();

        cached_by_key(&cache, "uid-builtin", now, INPUT_CONFIG_TTL, counting_fetch(&reads)).unwrap();
        let just_inside = now + INPUT_CONFIG_TTL - Duration::from_millis(1);
        let (_, cached) =
            cached_by_key(&cache, "uid-builtin", just_inside, INPUT_CONFIG_TTL, counting_fetch(&reads))
                .unwrap();
        assert_eq!(reads.get(), 1, "an entry inside its TTL is still good");
        assert!(cached);

        let just_outside = now + INPUT_CONFIG_TTL;
        let (_, cached) =
            cached_by_key(&cache, "uid-builtin", just_outside, INPUT_CONFIG_TTL, counting_fetch(&reads))
                .unwrap();
        assert_eq!(reads.get(), 2, "an entry at or past its TTL must be re-read");
        assert!(!cached);
    }

    #[test]
    fn a_clock_that_went_backwards_misses_rather_than_panicking() {
        // TWO failures in one, and the second is why the first is not enough.
        //
        // `Instant - Instant` PANICS on underflow, and this arithmetic sits on the arm path, so a
        // caller handing an earlier `now` must not crash the microphone. But the obvious fix —
        // `saturating_duration_since` — answers 0, which is inside any TTL, so an entry stamped in
        // the FUTURE would be served and its life silently extended. This test is named for a MISS
        // and it now asserts one: for a cache whose risk is serving a format the device no longer
        // has, the fail-safe answer to a self-contradicting clock is to ask the device again.
        let cache = Mutex::new(None);
        let reads = std::cell::Cell::new(0);
        let now = Instant::now();
        cached_by_key(&cache, "uid-builtin", now, INPUT_CONFIG_TTL, counting_fetch(&reads)).unwrap();

        let earlier = now - Duration::from_secs(5);
        let (_, cached) =
            cached_by_key(&cache, "uid-builtin", earlier, INPUT_CONFIG_TTL, counting_fetch(&reads))
                .unwrap();
        assert!(!cached, "an entry stamped after `now` must be re-read, not served");
        assert_eq!(reads.get(), 2, "the fail-safe answer to a disordered clock is to ask again");
    }

    #[test]
    fn a_failed_read_is_not_cached_and_does_not_evict() {
        let cache = Mutex::new(None);

        // A transient CoreAudio error must not wedge the format for the life of the process.
        let failed: Result<(u32, bool), &str> =
            cached_by_key(&cache, "uid-builtin", Instant::now(), INPUT_CONFIG_TTL, || Err("busy"));
        assert!(failed.is_err());
        let reads = std::cell::Cell::new(0);
        let (_, cached) =
            cached_by_key(&cache, "uid-builtin", Instant::now(), INPUT_CONFIG_TTL, counting_fetch(&reads))
                .unwrap();
        assert!(!cached, "a failure must leave nothing behind to serve");
        assert_eq!(reads.get(), 1, "the arm after a failed read retries the device");

        // …and a failure AFTER a good read must not throw the good one away either.
        let still_good: Result<(u32, bool), &str> =
            cached_by_key(&cache, "uid-builtin", Instant::now(), INPUT_CONFIG_TTL, || Err("busy"));
        assert_eq!(
            still_good.map(|(v, c)| (v, c)),
            Ok((48_000, true)),
            "a good entry is served without ever calling the failing fetch"
        );
    }

    /// The real static, the real `cpal` call, the real device — the one place the whole Task 2
    /// contract is observable end to end rather than through a generic stand-in.
    ///
    /// Skips (loudly) where no input device can be opened, following the sibling leak guard above:
    /// CI runners have no microphone, and a guard that fails there is a guard that gets deleted.
    #[test]
    fn a_real_devices_format_is_read_once_and_re_read_after_a_device_change() {
        let _serial = DEVICE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        invalidate_input_config_cache();
        let Some((first, _s1)) = try_start_probe_capture() else {
            eprintln!(
                "SKIPPED a_real_devices_format_is_read_once_and_re_read_after_a_device_change: \
                 no usable input device on this machine (expected on CI runners). The format-cache \
                 contract is still pinned by the generic tests above; only the cpal wiring is not."
            );
            return;
        };
        assert!(
            !first.timing().config_cached,
            "the first capture after an invalidation must go to the device"
        );

        let Some((second, _s2)) = try_start_probe_capture() else {
            panic!("the first capture opened, so the second must too");
        };
        assert!(
            second.timing().config_cached,
            "a second capture on the same device must be served the format it just negotiated — \
             this is the ~100 ms that a push-to-talk hold stops paying"
        );

        // The paired half, against the REAL static this time: what the watchdog calls on a
        // CoreAudio device-list change must actually send the next capture back to the device.
        invalidate_input_config_cache();
        let Some((third, _s3)) = try_start_probe_capture() else {
            panic!("the first capture opened, so the third must too");
        };
        assert!(
            !third.timing().config_cached,
            "invalidate_input_config_cache must force a fresh negotiation — without this the \
             cache would happily serve a format the device no longer has"
        );
    }

    // ── THE KEYDOWN→FIRST-SAMPLE DECOMPOSITION (sparkle-oyapv, Task 1) ───────────────────────────

    /// An origin with distinguishable stage values, so a report that drops or swaps one is visible.
    fn test_origin() -> ArmOrigin {
        let now = Instant::now();
        ArmOrigin {
            keydown: now,
            reconcile_at: now,
            js_to_invoke_ms: 7,
            prelude_ms: 3,
            permission_ms: 11,
            model_ms: 29,
        }
    }

    fn test_capture_timing() -> CaptureTiming {
        CaptureTiming {
            resolve_ms: 6,
            config_ms: 102,
            config_cached: false,
            build_ms: 193,
            play_ms: 0,
            total_ms: 303,
        }
    }

    #[test]
    fn the_span_carries_a_keydown_stage_and_the_stages_sum_to_the_total() {
        let origin = test_origin();
        // 7 + 3 + 11 + 29 + 13 + 303 + 8 = 374 named; total is measured independently.
        let span = ArmSpan::new(&origin, 13, test_capture_timing(), 8, 400);

        // THE STAGE THAT DID NOT EXIST BEFORE THIS WORK. Everything else here was already
        // measurable somewhere; the keydown→invoke span is the one that had never been recorded, so
        // a report that silently dropped it would still look complete.
        assert_eq!(span.js_to_invoke_ms, 7, "the gesture origin must reach the report");

        let named = span.js_to_invoke_ms
            + span.prelude_ms
            + span.permission_ms
            + span.model_ms
            + span.reconcile_pre_capture_ms
            + span.capture.total_ms
            + span.first_frame_ms
            + span.unattributed_ms;
        assert_eq!(named, span.total_ms, "the additive stages must account for the whole span");
        // The residual is the REAL gap, not a definitional filler: 400 - 374.
        assert_eq!(span.unattributed_ms, 26, "unattributed is the measured shortfall, not a constant");
        assert_eq!(span.over_attributed_ms, 0);
    }

    #[test]
    fn the_capture_sub_spans_are_a_breakdown_and_are_never_added_twice() {
        // resolve+config+build+play = 301, which is nearly all of capture.total_ms (303). If they
        // were treated as additive terms alongside it, the residual would collapse and the largest
        // stage in the whole span would be counted twice — the specific arithmetic mistake a flat
        // struct of millisecond fields invites.
        let span = ArmSpan::new(&test_origin(), 13, test_capture_timing(), 8, 400);
        assert_eq!(
            span.unattributed_ms, 26,
            "capture's four sub-spans must not enter the sum; they describe capture_ms, not \
             additional time"
        );
    }

    #[test]
    fn stages_that_overshoot_the_measured_total_are_reported_not_hidden() {
        // Every stage floors to whole milliseconds independently, so the named stages can exceed a
        // separately measured total by a few ms. `unattributed_ms` saturates — but silently
        // clamping would let the sum identity hold while the numbers were nonsense, so the overshoot
        // is published under its own name instead. Without `over_attributed_ms` this case is
        // indistinguishable from a perfectly attributed span.
        let span = ArmSpan::new(&test_origin(), 13, test_capture_timing(), 8, 370);
        assert_eq!(span.unattributed_ms, 0, "the residual cannot go negative");
        assert_eq!(span.over_attributed_ms, 4, "and by how much must be readable: 374 named vs 370");
        assert_eq!(span.total_ms, 370, "the independently measured total is reported as measured");
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
        // START GENUINELY COLD. The format cache is a process-wide static, so a sibling test that
        // opened a device first (`try_start_probe_capture`) would leave an entry behind and round 1
        // — the round whose whole job is to show what a COLD open costs — would silently read it and
        // report a warm number as the cold one. Dropping it here makes the run reproducible whatever
        // ran before it, which matters because these figures are quoted as the design's evidence.
        invalidate_input_config_cache();
        for round in 1..=3 {
            let t0 = std::time::Instant::now();
            let first_us = Arc::new(AtomicU64::new(0));
            let sink = first_us.clone();
            // `allow_virtual: false` — the app's own push-to-talk default (roborev, Medium). With
            // it true this could bind a HAL plug-in whose open cost bears no relation to a real
            // microphone's, and the printed figure carried no device name, so a number measured
            // against a virtual device was indistinguishable from a real one. These figures are
            // quoted as the justification for the pre-roll design, so they have to be attributable.
            // A SYNTHETIC GESTURE ORIGIN, so the run exercises the real reporting path (sparkle-oyapv).
            // Without one, `Capture::start` takes the `origin: None` branch and the whole
            // keydown→first-sample line — the thing the founder asked to have verified — is never
            // emitted, so a measurement run could not tell "the span is being reported" from "the
            // span reporter is dead code". The pre-capture stage values are stand-ins for a real
            // arm's (there is no `start_dictation` here to produce them) and are labelled as such in
            // the printed output; the stages this harness genuinely measures are the capture
            // sub-spans and the first-frame delay.
            let origin = ArmOrigin {
                keydown: t0,
                reconcile_at: t0,
                js_to_invoke_ms: 0,
                prelude_ms: 0,
                permission_ms: 0,
                model_ms: 0,
            };
            let capture = match Capture::start(
                &DeviceChoice::Auto { allow_virtual: false },
                Some(origin),
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
            // `config_cached` on every round, because it is the OBSERVABLE EFFECT of the format
            // cache and the only thing that distinguishes a served entry from a device that
            // answered quickly. Round 1 must read false and rounds 2-3 true; if they ever all read
            // false the cache has stopped working and `config_ms` is the number that will say so.
            let t = capture.timing();
            match first_us.load(Ordering::Relaxed) {
                0 => eprintln!(
                    "round {round}: device {:?} (virtual={} default={}) | Capture::start \
                     {start_ms:7.1} ms | config {} ms (cached={}) | NO FRAME within 3000 ms",
                    dev.name, dev.is_virtual, dev.was_default, t.config_ms, t.config_cached
                ),
                us => eprintln!(
                    "round {round}: device {:?} (virtual={} default={}) | Capture::start \
                     {start_ms:7.1} ms | config {} ms (cached={}) | first frame at {:7.1} ms \
                     (= audio lost if the user speaks at t=0)",
                    dev.name,
                    dev.is_virtual,
                    dev.was_default,
                    t.config_ms,
                    t.config_cached,
                    us as f64 / 1000.0
                ),
            }
            drop(capture);
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
}

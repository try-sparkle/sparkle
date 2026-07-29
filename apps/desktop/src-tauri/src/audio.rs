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
    on_frame: &mut impl FnMut(Vec<f32>),
) where
    T: Sample,
    f32: FromSample<T>,
{
    let f32_data: Vec<f32> = data.iter().map(|&s| f32::from_sample(s)).collect();
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
}

impl CaptureHealth {
    pub fn frames(&self) -> u64 {
        self.frames.load(Ordering::Relaxed)
    }
    pub fn voiced_frames(&self) -> u64 {
        self.voiced_frames.load(Ordering::Relaxed)
    }
    /// Record one delivered frame. `Relaxed` is sufficient: the watchdog only needs eventual
    /// visibility of a monotonically increasing count, never ordering against other state, and this
    /// runs on the realtime CoreAudio thread where a cheaper op is the right default.
    fn note_frame(&self, frame: &[f32]) {
        self.frames.fetch_add(1, Ordering::Relaxed);
        // `any` short-circuits on the FIRST non-zero sample, so the healthy path costs one compare
        // per frame. Only a genuinely all-zero (dead) frame pays the full scan.
        if frame.iter().any(|&s| s != 0.0) {
            self.voiced_frames.fetch_add(1, Ordering::Relaxed);
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
        if let Ok(mut it) = host.input_devices() {
            if let Some(d) = it.find(|d| d.name().map(|n| n == name).unwrap_or(false)) {
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
        let (device, bound) = Self::resolve_device(choice)?;
        let cfg = device
            .default_input_config()
            .map_err(|e| e.to_string())?;
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
        let mut on_frame = firewall_frame_handler(active.clone(), health.clone(), on_frame);

        // Build an input stream, dispatching on the device's native sample format
        // so we never ask cpal to reinterpret bytes incorrectly.
        // On macOS the default format is typically F32, but we handle the common
        // alternatives (I16, I32) so the code is portable.
        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    on_frame(downmix_resample(data, channels, in_rate));
                },
                |err| eprintln!("cpal stream error: {err}"),
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    process_typed(data, channels, in_rate, &mut on_frame);
                },
                |err| eprintln!("cpal stream error: {err}"),
                None,
            ),
            SampleFormat::I32 => device.build_input_stream(
                &stream_config,
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    process_typed(data, channels, in_rate, &mut on_frame);
                },
                |err| eprintln!("cpal stream error: {err}"),
                None,
            ),
            SampleFormat::F64 => device.build_input_stream(
                &stream_config,
                move |data: &[f64], _: &cpal::InputCallbackInfo| {
                    process_typed(data, channels, in_rate, &mut on_frame);
                },
                |err| eprintln!("cpal stream error: {err}"),
                None,
            ),
            other => {
                return Err(format!("unsupported sample format: {other}"));
            }
        }
        .map_err(|e| e.to_string())?;

        stream.play().map_err(|e| e.to_string())?;
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
}

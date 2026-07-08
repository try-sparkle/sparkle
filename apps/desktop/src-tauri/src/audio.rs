//! Microphone capture via cpal → 16 kHz mono f32 frames + RMS level.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat};

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

// wired into the dictation command in a later task
#[allow(dead_code)]
pub struct Capture {
    stream: cpal::Stream,
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
        // Suppress crash-record persistence for a panic we're about to CATCH here: the panic hook
        // still logs it, but a recovered frame panic must not be written/uploaded as a "crash" (the
        // app isn't going down). The guard resets when this frame returns. See crash::suppress_crash_records.
        let _suppress = crate::crash::suppress_crash_records();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_frame(frame)));
    }
}

impl Capture {
    #[allow(dead_code)]
    pub fn start(
        on_frame: impl FnMut(Vec<f32>) + Send + 'static,
    ) -> Result<Capture, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("no input device")?;
        let cfg = device
            .default_input_config()
            .map_err(|e| e.to_string())?;
        let channels = cfg.channels();
        let in_rate = cfg.sample_rate().0;
        let sample_format = cfg.sample_format();
        let stream_config = cfg.into();

        // The teardown gate the frame handler checks and `Capture::drop` flips (native-crash fix).
        let active = Arc::new(AtomicBool::new(true));

        // Funnel the handler through the panic firewall so a panic on the audio thread is
        // contained, not propagated into CoreAudio's extern "C" callback (see the fn doc). The
        // firewall also honors the teardown gate so a callback racing teardown becomes a no-op.
        let mut on_frame = firewall_frame_handler(active.clone(), on_frame);

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
        Ok(Capture { stream, active })
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
        let mut firewalled = firewall_frame_handler(active, move |_frame: Vec<f32>| {
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
        let mut firewalled = firewall_frame_handler(active.clone(), move |_frame: Vec<f32>| {
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

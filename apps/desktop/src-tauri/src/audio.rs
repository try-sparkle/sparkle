//! Microphone capture via cpal → 16 kHz mono f32 frames + RMS level.
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

/// Average channels to mono, then linear-decimate to 16 kHz. Good enough for ASR
/// (the model is robust to simple resampling); avoids a heavyweight resampler dep.
pub fn downmix_resample(input: &[f32], channels: u16, in_rate: u32) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    let mono: Vec<f32> = input
        .chunks(ch)
        .map(|c| c.iter().sum::<f32>() / ch as f32)
        .collect();
    if in_rate == 16_000 {
        return mono;
    }
    let ratio = in_rate as f32 / 16_000.0;
    // round() preserves the trailing sample (floor would drop ~1 sample/callback);
    // the .min(len-1) clamp keeps the index in bounds for any non-integer ratio.
    let out_len = (mono.len() as f32 / ratio).round() as usize;
    (0..out_len)
        .map(|i| mono[((i as f32 * ratio) as usize).min(mono.len() - 1)])
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
}

impl Capture {
    #[allow(dead_code)]
    pub fn start(
        mut on_frame: impl FnMut(Vec<f32>) + Send + 'static,
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
        Ok(Capture { stream })
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
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

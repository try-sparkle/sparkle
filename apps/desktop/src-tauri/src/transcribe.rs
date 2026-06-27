//! On-device STT: Silero VAD segments → Parakeet-TDT offline transducer.
use std::sync::Mutex;
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};
use crate::model::ModelPaths;

pub trait Transcriber: Send {
    /// Feed a frame of 16 kHz mono f32. Returns text for any VAD segments that closed
    /// during this call (usually 0 or 1) — the near-streaming partials.
    fn accept(&mut self, frame: &[f32]) -> Vec<String>;
    /// End of dictation: flush the VAD and return text for any trailing segment(s).
    fn finalize(&mut self) -> Vec<String>;
}

/// Buffers an arbitrary stream of samples into exactly-512-sample windows (Silero's
/// required window size), retaining the sub-window remainder.
#[derive(Default)]
pub struct WindowBuffer {
    buf: Vec<f32>,
}
impl WindowBuffer {
    pub fn push(&mut self, frame: &[f32]) -> Vec<[f32; 512]> {
        self.buf.extend_from_slice(frame);
        let n_windows = self.buf.len() / 512;
        let mut out = Vec::with_capacity(n_windows);
        for i in 0..n_windows {
            let mut w = [0f32; 512];
            w.copy_from_slice(&self.buf[i * 512..(i + 1) * 512]);
            out.push(w);
        }
        // Drain all consumed samples in one O(n) shift instead of one per window.
        if n_windows > 0 {
            self.buf.drain(..n_windows * 512);
        }
        out
    }
    /// Take the leftover (<512) samples, if any.
    pub fn drain(&mut self) -> Option<Vec<f32>> {
        if self.buf.is_empty() { None } else { Some(std::mem::take(&mut self.buf)) }
    }
}

pub struct ParakeetTdt {
    recognizer: Mutex<OfflineRecognizer>,
    vad: Mutex<VoiceActivityDetector>,
    window: WindowBuffer,
}

impl ParakeetTdt {
    pub fn new(m: &ModelPaths) -> Result<Self, String> {
        let mut rc = OfflineRecognizerConfig::default();
        rc.model_config.transducer = OfflineTransducerModelConfig {
            encoder: Some(m.encoder.to_string_lossy().into_owned()),
            decoder: Some(m.decoder.to_string_lossy().into_owned()),
            joiner: Some(m.joiner.to_string_lossy().into_owned()),
        };
        rc.model_config.tokens = Some(m.tokens.to_string_lossy().into_owned());
        rc.model_config.provider = Some("cpu".into());
        rc.model_config.num_threads = 2;
        // API deviation: create() returns Option<Self>, not Result
        let recognizer = OfflineRecognizer::create(&rc)
            .ok_or_else(|| "failed to create OfflineRecognizer (check model paths/format)".to_string())?;

        let mut sv = SileroVadModelConfig::default();
        sv.model = Some(m.vad.to_string_lossy().into_owned());
        sv.threshold = 0.5;
        sv.min_silence_duration = 0.25;
        sv.min_speech_duration = 0.25;
        sv.max_speech_duration = 8.0;
        let vad_cfg = VadModelConfig {
            silero_vad: sv,
            sample_rate: 16_000,
            num_threads: 1,
            provider: Some("cpu".into()),
            ..Default::default()
        };
        // API deviation: create() returns Option<Self>, not Result
        let vad = VoiceActivityDetector::create(&vad_cfg, 30.0)
            .ok_or_else(|| "failed to create VoiceActivityDetector (check VAD model path)".to_string())?;

        Ok(Self { recognizer: Mutex::new(recognizer), vad: Mutex::new(vad), window: WindowBuffer::default() })
    }

    /// Real-time "is the user speaking *right now*?" flag straight from the Silero VAD,
    /// refreshed by the 512-sample windows fed in `accept()`. This is distinct from the
    /// queued speech *segments* (`front`/`pop`), which only close after a ~250ms pause: the
    /// detector flips this true within a window of speech onset and false shortly after it
    /// stops. The waveform UI gates its animation on this so the meter only moves while you
    /// actually talk — accurate where a raw-loudness threshold can't tell speech from noise.
    /// Poison-tolerant lock (same rationale as `transcribe`).
    pub fn speaking(&self) -> bool {
        self.vad.lock().unwrap_or_else(|p| p.into_inner()).detected()
    }

    fn transcribe(&self, samples: &[f32]) -> String {
        // Poison-tolerant lock (): a panic elsewhere on the audio thread must not
        // wedge dictation for the app's lifetime — recover the guard and carry on.
        let rec = self.recognizer.lock().unwrap_or_else(|p| p.into_inner());
        let stream = rec.create_stream();
        stream.accept_waveform(16_000, samples);
        rec.decode(&stream);
        stream.get_result().map(|r| r.text).unwrap_or_default()
    }

    fn drain_segments(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut vad = self.vad.lock().unwrap_or_else(|p| p.into_inner());
        // SAFETY: front() returns an owned SpeechSegment whose Drop calls
        // SherpaOnnxDestroySpeechSegment on the raw pointer returned by
        // SherpaOnnxVoiceActivityDetectorFront. That pointer may alias the VAD-internal
        // queue entry that pop() (SherpaOnnxVoiceActivityDetectorPop) frees. Dropping
        // seg before pop() ensures the two C destructors never race on the same memory.
        while let Some(seg) = vad.front() {
            let samples = seg.samples().to_vec();
            drop(seg);     // end the SpeechSegment's lifetime before pop()
            vad.pop();
            drop(vad); // release before the (slower) transcribe call
            let text = self.transcribe(&samples).trim().to_string();
            if !text.is_empty() { out.push(text); }
            vad = self.vad.lock().unwrap_or_else(|p| p.into_inner());
        }
        out
    }
}

impl Transcriber for ParakeetTdt {
    fn accept(&mut self, frame: &[f32]) -> Vec<String> {
        for w in self.window.push(frame) {
            // API deviation: accept_waveform takes &[f32], not Vec<f32>
            self.vad.lock().unwrap_or_else(|p| p.into_inner()).accept_waveform(&w);
        }
        self.drain_segments()
    }
    fn finalize(&mut self) -> Vec<String> {
        if let Some(tail) = self.window.drain() {
            // Zero-pad the partial (<512) tail to a full 512-sample window before
            // handing it to the VAD, which requires exactly 512-sample chunks.
            let mut padded = [0f32; 512];
            padded[..tail.len()].copy_from_slice(&tail);
            self.vad.lock().unwrap_or_else(|p| p.into_inner()).accept_waveform(&padded);
        }
        self.vad.lock().unwrap_or_else(|p| p.into_inner()).flush();
        self.drain_segments()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_buffer_emits_full_512_windows_and_retains_remainder() {
        let mut wb = WindowBuffer::default();
        assert_eq!(wb.push(&vec![0.0; 500]).len(), 0); // not enough yet
        let out = wb.push(&vec![0.0; 600]);            // 1100 total → two 512 windows
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|w: &[f32; 512]| w.len() == 512));
        // 1100 - 1024 = 76 remainder retained; finalize zero-pads it to 512 for VAD
        let tail = wb.drain().unwrap();
        assert_eq!(tail.len(), 76);
        assert!(wb.drain().is_none());
    }

    #[test]
    #[ignore = "needs the 482MB model; run with SPARKLE_MODEL_DIR set"]
    fn transcribes_fixture_wav() {
        let root = std::path::PathBuf::from(std::env::var("SPARKLE_MODEL_DIR").unwrap());
        let m = crate::model::ensure(&root, |_, _| {}).unwrap();
        let mut t = ParakeetTdt::new(&m).unwrap();
        // The Parakeet tarball ships test_wavs/0.wav; read it with hound.
        let mut reader = hound::WavReader::open(root.join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/test_wavs/0.wav")).unwrap();
        let samples: Vec<f32> = reader.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect();
        // Segments close on speech pauses DURING accept(); the trailing segment closes
        // on finalize(). A correct consumer must collect BOTH — accept()'s per-call
        // segments and finalize()'s flushed tail.
        let mut got: Vec<String> = Vec::new();
        for chunk in samples.chunks(1600) {
            got.extend(t.accept(chunk));
        }
        got.extend(t.finalize());
        let text = got.join(" ");
        assert!(!text.is_empty(), "expected a non-empty transcript, got {:?}", got);
        // 0.wav is a known fixture; assert the model produced its actual content.
        assert!(text.contains("Phebe"), "unexpected transcript: {text:?}");
    }
}

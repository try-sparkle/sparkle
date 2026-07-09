//! On-device STT: Silero VAD segments → Parakeet-TDT offline transducer.
use std::sync::{Arc, Mutex};
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};
use crate::model::ModelPaths;

pub trait Transcriber: Send {
    /// Feed a frame of 16 kHz mono f32. Returns text for any VAD segments that closed
    /// during this call (usually 0 or 1) — the near-streaming partials. This is the SYNCHRONOUS
    /// convenience path (VAD windowing + inline decode); the live capture path deliberately does
    /// NOT use it — it calls `accept_segments` and decodes off the realtime thread (see
    /// dictation.rs). Kept for the offline fixture test and as the trait's streaming contract.
    #[allow(dead_code)] // only the (cfg(test)) fixture path decodes inline; production is off-thread
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

/// The heavy Parakeet transducer, split out from `ParakeetTdt` so the realtime capture callback
/// can run the (cheap) VAD windowing while a dedicated worker thread runs the (hundreds-of-ms)
/// decode — the two share nothing but an `Arc<Decoder>`, so decode never blocks the audio thread on
/// the VAD lock. Its own poison-tolerant Mutex guards the recognizer; the worker and the `finalize`
/// path lock only THIS, never the `ParakeetTdt` the audio callback holds.
pub struct Decoder {
    recognizer: Mutex<OfflineRecognizer>,
}

impl Decoder {
    /// Decode one closed VAD segment to text. Runs on the decode worker thread (during capture) or
    /// on the stop thread (at finalize) — NEVER on the CoreAudio callback. Poison-tolerant lock
    /// (): a panic elsewhere must not wedge dictation for the app's lifetime.
    pub fn transcribe(&self, samples: &[f32]) -> String {
        let rec = self.recognizer.lock().unwrap_or_else(|p| p.into_inner());
        let stream = rec.create_stream();
        stream.accept_waveform(16_000, samples);
        rec.decode(&stream);
        stream.get_result().map(|r| r.text).unwrap_or_default()
    }
}

pub struct ParakeetTdt {
    /// Shared, independently-lockable decoder so the worker can decode off the audio thread.
    decoder: Arc<Decoder>,
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

        let sv = SileroVadModelConfig {
            model: Some(m.vad.to_string_lossy().into_owned()),
            threshold: 0.5,
            min_silence_duration: 0.25,
            min_speech_duration: 0.25,
            max_speech_duration: 8.0,
            ..Default::default()
        };
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

        Ok(Self {
            decoder: Arc::new(Decoder { recognizer: Mutex::new(recognizer) }),
            vad: Mutex::new(vad),
            window: WindowBuffer::default(),
        })
    }

    /// A cheap, cloneable handle to the heavy decoder for the decode worker thread. The worker
    /// decodes closed segments off the realtime thread (see `dictation::DecodeWorker`), so the
    /// audio callback only ever runs the VAD half of the pipeline.
    pub fn decoder(&self) -> Arc<Decoder> {
        self.decoder.clone()
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

    /// Feed a frame and return the OWNED samples of any VAD segments that closed this call —
    /// WITHOUT decoding them. This is the realtime-safe half of `accept`: it runs only the cheap
    /// VAD windowing + segment extraction (no transducer decode), so it's safe to call while
    /// holding the transcriber lock on the CoreAudio callback. The caller ships these buffers to
    /// the decode worker, which runs `Decoder::transcribe` off the audio thread.
    pub fn accept_segments(&mut self, frame: &[f32]) -> Vec<Vec<f32>> {
        for w in self.window.push(frame) {
            // API deviation: accept_waveform takes &[f32], not Vec<f32>
            self.vad.lock().unwrap_or_else(|p| p.into_inner()).accept_waveform(&w);
        }
        self.drain_segment_samples()
    }

    /// Pull the samples of any VAD segments that have closed, WITHOUT decoding them (the heavy
    /// decode runs on the worker / at finalize). Kept off the transcribe path so the realtime
    /// callback never pays the transducer cost.
    fn drain_segment_samples(&self) -> Vec<Vec<f32>> {
        let mut out = Vec::new();
        // No decode happens here, so — unlike the old `drain_segments` — we hold the VAD lock across
        // the whole (cheap) drain instead of releasing it per segment; nothing to release it for.
        let vad = self.vad.lock().unwrap_or_else(|p| p.into_inner());
        // SAFETY: front() returns an owned SpeechSegment whose Drop calls
        // SherpaOnnxDestroySpeechSegment on the raw pointer returned by
        // SherpaOnnxVoiceActivityDetectorFront. That pointer may alias the VAD-internal
        // queue entry that pop() (SherpaOnnxVoiceActivityDetectorPop) frees. Dropping
        // seg before pop() ensures the two C destructors never race on the same memory.
        while let Some(seg) = vad.front() {
            let samples = seg.samples().to_vec();
            drop(seg);     // end the SpeechSegment's lifetime before pop()
            vad.pop();
            out.push(samples);
        }
        out
    }
}

impl Transcriber for ParakeetTdt {
    fn accept(&mut self, frame: &[f32]) -> Vec<String> {
        // Convenience/synchronous path (fixture test): VAD windowing then inline decode. The live
        // capture path does NOT use this — it calls `accept_segments` and decodes off-thread — so
        // the heavy decode never runs on the CoreAudio callback.
        self.accept_segments(frame)
            .into_iter()
            .filter_map(|s| {
                let text = self.decoder.transcribe(&s).trim().to_string();
                (!text.is_empty()).then_some(text)
            })
            .collect()
    }
    fn finalize(&mut self) -> Vec<String> {
        if let Some(tail) = self.window.drain() {
            // Zero-pad the partial (<512) tail to a full 512-sample window before
            // handing it to the VAD, which requires exactly 512-sample chunks.
            // WindowBuffer::drain only ever returns a sub-512 remainder today, but clamp
            // defensively so a future windowing change can never turn the mute path (this is
            // reached from stop_dictation → finalize) into a hard slice-length panic: copy at
            // most 512 samples and truncate the source to match.
            let mut padded = [0f32; 512];
            let n = tail.len().min(512);
            padded[..n].copy_from_slice(&tail[..n]);
            self.vad.lock().unwrap_or_else(|p| p.into_inner()).accept_waveform(&padded);
        }
        self.vad.lock().unwrap_or_else(|p| p.into_inner()).flush();
        // finalize() runs on the stop thread AFTER Capture (and the decode worker) are gone, so
        // decoding the trailing segment(s) inline here can't contend with the audio callback.
        self.drain_segment_samples()
            .into_iter()
            .filter_map(|s| {
                let text = self.decoder.transcribe(&s).trim().to_string();
                (!text.is_empty()).then_some(text)
            })
            .collect()
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

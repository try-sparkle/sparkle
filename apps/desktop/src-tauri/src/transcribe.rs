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

/// The loaded ONNX transducer, kept for the life of the process and reused by every arm.
///
/// THE REGRESSION THIS PREVENTS (2026-08-05, founder-blocking): "dictation captures no audio".
/// `stop_dictation` takes `sess.transcriber`, so every arm re-ran the full
/// `SherpaOnnxCreateOfflineRecognizer` (1977 of 2578 samples in that morning's hang stacks). Under
/// machine saturation that load takes 30+ seconds — longer than a push-to-talk hold — so the release
/// always landed mid-load, the arm aborted, and `sess.capture` was never built. The mic lit up, the
/// waveform turned blue, and not one sample was captured.
///
/// Lives HERE, not in `dictation`, so `load_decoder`/`with_decoder` can be private and `armed()` can
/// be the only reachable constructor — see its doc for why that placement is the actual guard.
///
/// ── IT NEVER EVICTS, AND THAT IS A DELIBERATE TRADE (roborev 59063) ─────────────────────────────
/// The model files total ~661 MB (`ENCODER_SIZE` 652 MB plus decoder and joiner, see `model.rs`),
/// and an initialized `InferenceSession` holds those weights resident. Before this cache,
/// `stop_dictation` dropped the recognizer on every release so idle RSS fell back to baseline; now
/// the first dictation of a session raises resident set by roughly the model size for the life of
/// the process. Recorded with the figure so a future "the app grew ~700 MB" report lands here.
///
/// Eviction was considered and REFUSED: an idle-window eviction returns the memory but re-arms the
/// exact failure above, because the next hold pays the multi-second init again and on a saturated
/// machine that is once more longer than the hold. If the memory ever does hurt, pre-load at launch
/// rather than evict — but read `ParakeetTdt::armed`'s caller contract first: such a pre-load must
/// hold `dictation::MODEL_LOAD` across the whole ensure→verify→armed sequence, or it races a
/// first-run promote into an uncatchable SIGABRT (roborev 59149).
static DECODER_CACHE: Mutex<Option<Arc<Decoder>>> = Mutex::new(None);

/// Return the cached value, or build and cache it.
///
/// Generic and side-effect-free apart from the cache write, so the reuse contract is unit-testable
/// without a model on disk or an audio device. A FAILED build is deliberately NOT cached: a
/// transient failure (a partially-downloaded model that `verify_for_load` rejects) must not wedge
/// the mic for the rest of the process's life — the next arm retries.
pub(crate) fn cached_or_build<T, E>(
    cache: &Mutex<Option<Arc<T>>>,
    build: impl FnOnce() -> Result<Arc<T>, E>,
) -> Result<Arc<T>, E> {
    // Held across `build` on purpose: two concurrent arms must not each pay for an ONNX init. The
    // caller already serializes on `dictation::MODEL_LOAD`, so this adds no new lock ordering.
    let mut slot = cache.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(hit) = slot.as_ref() {
        return Ok(hit.clone());
    }
    let built = build()?;
    *slot = Some(built.clone());
    Ok(built)
}

/// Forget the cached decoder. Called only by `dictation`'s detach path — see
/// `dictation::retire_cached_decoder` for WHY a detached (wedged) decode worker makes the shared
/// recognizer poison rather than an asset.
///
/// Lives here because the slot does: everything that reads or writes `DECODER_CACHE` is in this
/// module, which is what lets the constructors stay private.
pub(crate) fn retire_cached_decoder() {
    *DECODER_CACHE.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

pub struct ParakeetTdt {
    /// Shared, independently-lockable decoder so the worker can decode off the audio thread.
    decoder: Arc<Decoder>,
    vad: Mutex<VoiceActivityDetector>,
    window: WindowBuffer,
}

impl ParakeetTdt {
    /// Build the EXPENSIVE half on its own: the ONNX transducer recognizer.
    ///
    /// Split out from `new` so it can be loaded ONCE per process and reused across arms — see
    /// `dictation::load_model`. This is the call that dominates arming: a watchdog hang stack taken
    /// during the 2026-08-05 "dictation captures no audio" regression showed 1977 of 2578 samples
    /// inside `SherpaOnnxCreateOfflineRecognizer` -> `onnxruntime::InferenceSession::Initialize`
    /// (graph transforms), with ZERO samples in the VAD construction or the file verification below.
    ///
    /// That cost is why it must not be repeated. Push-to-talk releases the mic at rest, so
    /// `stop_dictation` drops the transcriber on every release; without this cache the next hold
    /// re-ran the whole ONNX init, which takes longer than a hold, so the release always landed
    /// mid-load and `start_after_load` aborted the arm — a mic that lit up and captured nothing.
    ///
    /// Safe to share across arms because the recognizer holds NO per-session state: `Decoder::
    /// transcribe` creates a fresh stream per segment. The state that IS per-session — the VAD and
    /// the window buffer — is rebuilt every arm by `with_decoder`.
    fn load_decoder(m: &ModelPaths) -> Result<Arc<Decoder>, String> {
        // The chokepoint: every path to ONNX Runtime goes through here, so this is where we can
        // guarantee it never sees an incomplete file. Not defensive programming for its own sake
        // — ORT reacts to a malformed .onnx by throwing a C++ exception across the FFI boundary,
        // which is an unrecoverable process abort, not an error we could handle below.
        crate::model::verify(m)?;

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

        Ok(Arc::new(Decoder { recognizer: Mutex::new(recognizer) }))
    }

    /// Build a fresh session around an ALREADY-LOADED decoder.
    ///
    /// Everything constructed here is per-arm state that must NOT be carried across a stop: the
    /// Silero VAD (which holds queued speech segments) and the window buffer. Only the ONNX
    /// recognizer in `decoder` is shared, and it is stateless between segments.
    fn with_decoder(m: &ModelPaths, decoder: Arc<Decoder>) -> Result<Self, String> {
        // VERIFIES TOO, and it is not redundant with `load_decoder`'s call (roborev 59063). The
        // justification is NOT this fn's visibility — it is private now, and the comment used to say
        // "This is `pub`", which stopped being true when `armed` became the only public constructor
        // (roborev 59149). What matters is the CACHED path: a warm hit skips `load_decoder`
        // entirely, and this still hands `m.vad` straight to ORT via `VoiceActivityDetector::create`
        // — so on the common arm, this call is the ONLY thing between a malformed
        // `silero_vad.onnx` and ORT. A malformed model reaching
        // ORT is an uncatchable process abort, not an error, so the guard has to sit on THIS path as
        // well rather than relying on `dictation::load_model` happening to call `verify_for_load`
        // first — that is a different module, and a future caller here would get exactly the crash
        // the chokepoint exists to make impossible. Five `stat()`s, free next to VAD construction.
        crate::model::verify(m)?;

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
            decoder,
            vad: Mutex::new(vad),
            window: WindowBuffer::default(),
        })
    }

    /// Build a dictation session, reusing the process-wide ONNX recognizer.
    ///
    /// ── THE ONLY WAY TO GET A SESSION OUTSIDE THIS MODULE, AND THAT IS THE GUARD ─────────────────
    /// An earlier version of this fix put `#[cfg(test)]` on an uncached `new()` and claimed the
    /// no-uncached-load guarantee was therefore closed at compile time. **That claim was false**
    /// (roborev 59101): `load_decoder` and `with_decoder` were both `pub`, so
    /// `with_decoder(m, load_decoder(m)?)` — byte-for-byte the per-arm reload that caused the
    /// "dictation captures no audio" regression — still compiled in a production build. Only the
    /// literal `new()` spelling was blocked, and the likelier regression (dropping the cache line in
    /// `dictation::load_model`, or a new caller in another module) sailed straight through while the
    /// unit tests, by their own admission, stayed green.
    ///
    /// So the guarantee is made REAL rather than reworded: both constructors above are now private
    /// to this module and the cache lives beside them, so this is the only session constructor any
    /// other module can reach. There is no longer an uncached path to drop back to — not a rule the
    /// next maintainer has to know, an API that does not offer the mistake.
    ///
    /// ── CALLER CONTRACT: YOU MUST ALREADY HOLD `dictation::MODEL_LOAD` ───────────────────────────
    /// **This function does not take that lock and cannot.** Being the safe-by-construction entry
    /// point for the CACHE does not make it safe on its own, and the distinction has teeth
    /// (roborev 59149).
    ///
    /// The invariant is not "don't load twice" — it is that one lock must span
    /// `model::ensure` → `model::verify` → the ORT open. `ensure`'s promote is `remove_dir_all` +
    /// `rename`, so it can land in the gap between a verify and the open that follows it, handing
    /// ORT a file that vanished mid-read: an uncatchable SIGABRT, not an `Err` (see `model.rs`).
    /// `ensure` runs in `dictation::load_model`, BEFORE this call — so pulling the acquisition down
    /// into `armed` would leave the download/promote outside the lock and reopen exactly that
    /// crash, and `MODEL_LOAD` is a non-reentrant `std::sync::Mutex`, so it cannot be taken in both
    /// places. Hence a documented contract rather than a mechanism.
    ///
    /// A CACHE HIT PERFORMS NO ORT OPEN, which is what makes this easy to get wrong: the hot path
    /// looks lock-free, and the miss — the one that opens the model — is the rare one you will not
    /// be looking at. A LAUNCH-TIME PRE-LOAD IS THE LIKELIEST CALLER TO GET THIS WRONG, and this
    /// file recommends one (see `DECODER_CACHE`'s note on preferring pre-load over eviction): it
    /// would run concurrently with a first-run `ensure` promote. If you add one, it must hold
    /// `MODEL_LOAD` across the whole ensure→verify→armed sequence, exactly as `load_model` does.
    pub fn armed(m: &ModelPaths) -> Result<Self, String> {
        let decoder = cached_or_build(&DECODER_CACHE, || Self::load_decoder(m))?;
        Self::with_decoder(m, decoder)
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

    /// Feed the VAD exactly as [`accept_segments`] does, but THROW AWAY any closed segment instead
    /// of copying its samples out. Returns how many were discarded (for logging/tests).
    ///
    /// For the cloud path, where Deepgram owns the transcription and the samples would be allocated
    /// only to be dropped. That copy is not free on the caller's thread — it is the CoreAudio IO
    /// thread, and a segment runs to `max_speech_duration` (8 s × 16 kHz × 4 B ≈ 512 KB), so
    /// `accept_segments` there adds an unbounded allocator round-trip per utterance to a callback
    /// that otherwise goes out of its way to stay realtime-safe (roborev 55300).
    ///
    /// NOT the same as simply not feeding the VAD: the windowing is what produces the `speaking()`
    /// flag the waveform reads on the cloud path, and skipping the drain instead would let the
    /// VAD's internal queue grow for the whole stream and then flush at the transition.
    pub fn discard_segments(&mut self, frame: &[f32]) -> usize {
        for w in self.window.push(frame) {
            self.vad.lock().unwrap_or_else(|p| p.into_inner()).accept_waveform(&w);
        }
        let vad = self.vad.lock().unwrap_or_else(|p| p.into_inner());
        let mut n = 0;
        // Same C-destructor ordering rule as `drain_segment_samples` — drop the SpeechSegment
        // before pop() — minus the `samples().to_vec()` that is the whole point of avoiding.
        while let Some(seg) = vad.front() {
            drop(seg);
            vad.pop();
            n += 1;
        }
        n
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

    /// Lay down a model dir where every file is the size `model::verify` expects, except the ones
    /// named — so a test breaks exactly one file and the resulting error is unambiguously about it.
    ///
    /// The sizes must match `model.rs`'s expectations exactly. An earlier version used a rounded
    /// encoder size, which made the "good" dir itself invalid: every test built on it failed at the
    /// encoder before reaching what it meant to assert, and one of them reported ok while asserting
    /// nothing.
    fn model_dir_with(bad: &[(&str, u64)]) -> (tempfile::TempDir, crate::model::ModelPaths) {
        let dir = tempfile::tempdir().unwrap();
        let m = crate::model::model_paths(dir.path());
        for (f, size) in [
            (&m.encoder, 652_184_296u64),
            (&m.decoder, 7_257_753),
            (&m.joiner, 1_739_080),
            (&m.tokens, 9_384),
            (&m.vad, 643_854),
        ] {
            // The caller's size wins for the file it names — that is the one being broken.
            let size = bad.iter().find(|(n, _)| f.ends_with(n)).map_or(size, |(_, s)| *s);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::File::create(f).unwrap().set_len(size).unwrap();
        }
        (dir, m)
    }

    /// The crash regression, end to end — asserted on the PRODUCTION chokepoint (roborev 59100).
    ///
    /// This used to drive a `ParakeetTdt::new` wrapper, so its coverage of the path that actually
    /// ships was only transitive — a later cleanup deleting the now-unused `new` would have
    /// silently deleted the only test standing between a truncated `.onnx` and a `SIGABRT`. It now
    /// calls `load_decoder`, the real chokepoint `armed()` uses, and `new` is gone entirely.
    ///
    /// Before that guard, this exact setup reached ONNX Runtime, which threw a C++ exception across
    /// the FFI boundary and took the whole process out with SIGABRT. `catch_unwind` could not have
    /// saved it, so if this test ever regresses it does not fail, it ABORTS the test runner. That is
    /// the tell: a green run here means a corrupt model is a recoverable `Err`.
    #[test]
    fn load_decoder_rejects_a_corrupt_model_instead_of_aborting_the_process() {
        let (_dir, m) = model_dir_with(&[("encoder.int8.onnx", 4096)]);
        // `Decoder` isn't Debug, so unwrap the Result by hand.
        let Err(err) = ParakeetTdt::load_decoder(&m) else {
            panic!("a truncated encoder must not reach sherpa-onnx");
        };
        assert!(err.contains("encoder.int8.onnx"), "error should name the bad file: {err}");
    }

    /// The OTHER path to ORT (roborev 59100): `with_decoder` hands `silero_vad.onnx` to
    /// `VoiceActivityDetector::create`, and on the CACHED arm — the common one — `load_decoder` does
    /// not run, so its verify cannot cover this.
    ///
    /// ── IGNORED, AND THE REASON IS THE POINT ─────────────────────────────────────────────────────
    /// A non-ignored version of this was written first and WAS VACUOUS. It built a fake model dir
    /// and early-returned when `load_decoder` failed — which is what always happened, because
    /// `model::verify` checks every file's SIZE, so the fabricated encoder was rejected before the
    /// VAD guard was ever reached. It reported "ok" while asserting nothing. Replacing the early
    /// return with a panic is what surfaced it.
    ///
    /// It cannot be made real with fabricated files: getting a `Decoder` at all requires a genuine
    /// 652 MB transducer that ORT can open, and giving ORT a correctly-SIZED but garbage file is the
    /// uncatchable-SIGABRT case this whole guard exists to prevent. So this runs only against a real
    /// model, exactly like `transcribes_fixture_wav`.
    #[test]
    #[ignore = "needs the real 652MB transducer to obtain a Decoder; run with SPARKLE_MODEL_DIR set"]
    fn with_decoder_rejects_a_corrupt_vad_before_it_reaches_ort() {
        let root = std::path::PathBuf::from(std::env::var("SPARKLE_MODEL_DIR").unwrap());
        let good = crate::model::ensure(&root, |_, _| {}).unwrap();
        let decoder = ParakeetTdt::load_decoder(&good).expect("the real model loads");
        // Same paths, but with the VAD truncated underneath us — the shape a half-finished download
        // leaves behind, and the one the cached arm would otherwise hand straight to ORT.
        let (_dir, broken) = model_dir_with(&[("silero_vad.onnx", 128)]);
        let Err(err) = ParakeetTdt::with_decoder(&broken, decoder) else {
            panic!("a truncated VAD model must not reach sherpa-onnx");
        };
        assert!(err.contains("silero_vad.onnx"), "error should name the bad file: {err}");
    }

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
        let mut t = ParakeetTdt::armed(&m).unwrap();
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

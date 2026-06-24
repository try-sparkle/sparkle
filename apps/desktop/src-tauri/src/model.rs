//! Download + cache the on-device STT models (Parakeet-TDT v2 int8 + Silero VAD).
use std::io::Read;
use std::path::{Path, PathBuf};

// wired up in Task 3
#[allow(dead_code)]
const ASR_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2";
// wired up in Task 3
#[allow(dead_code)]
const VAD_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
const ASR_DIR: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";

/// `Read` adapter that reports bytes flowing through it via a progress callback,
/// so the download can stream straight into the bzip2/tar pipeline without
/// buffering the whole tarball in memory.
struct ProgressReader<R, F: Fn(u64, Option<u64>)> {
    inner: R,
    progress: F,
    done: u64,
    total: Option<u64>,
}

impl<R: Read, F: Fn(u64, Option<u64>)> Read for ProgressReader<R, F> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.done += n as u64;
            (self.progress)(self.done, self.total);
        }
        Ok(n)
    }
}

pub struct ModelPaths {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
    pub vad: PathBuf,
}

pub fn model_paths(root: &Path) -> ModelPaths {
    let d = root.join(ASR_DIR);
    ModelPaths {
        encoder: d.join("encoder.int8.onnx"),
        decoder: d.join("decoder.int8.onnx"),
        joiner: d.join("joiner.int8.onnx"),
        tokens: d.join("tokens.txt"),
        vad: root.join("silero_vad.onnx"),
    }
}

pub fn is_present(p: &ModelPaths) -> bool {
    [&p.encoder, &p.decoder, &p.joiner, &p.tokens, &p.vad]
        .iter()
        .all(|f| f.exists())
}

/// Download + extract the models into `root` if not already present. `progress` is
/// called with (bytes_done, total_bytes) during the large ASR download.
// wired up in Task 3
#[allow(dead_code)]
pub fn ensure(root: &Path, progress: impl Fn(u64, Option<u64>)) -> Result<ModelPaths, String> {
    let paths = model_paths(root);
    if is_present(&paths) {
        return Ok(paths);
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;

    // Silero VAD (small, single file).
    if !paths.vad.exists() {
        let mut buf = Vec::new();
        ureq::get(VAD_URL).call().map_err(|e| e.to_string())?
            .into_reader().read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&paths.vad, &buf).map_err(|e| e.to_string())?;
    }

    // Parakeet tarball (large): stream straight through bzip2+untar into `root`,
    // reporting progress as the compressed bytes flow through ProgressReader.
    let asr_present = paths.encoder.exists()
        && paths.decoder.exists()
        && paths.joiner.exists()
        && paths.tokens.exists();
    if !asr_present {
        let resp = ureq::get(ASR_URL).call().map_err(|e| e.to_string())?;
        let total: Option<u64> = resp.header("Content-Length").and_then(|s| s.parse().ok());
        let counting = ProgressReader {
            inner: resp.into_reader(),
            progress,
            done: 0,
            total,
        };
        let tar = bzip2::read::BzDecoder::new(counting);
        let mut archive = tar::Archive::new(tar);
        // The tarball's top dir is the ASR_DIR name; unpack directly under `root`.
        archive.unpack(root).map_err(|e| e.to_string())?;
    }

    if is_present(&paths) {
        Ok(paths)
    } else {
        Err("model download completed but expected files are missing".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn paths_are_under_root() {
        let p = model_paths(Path::new("/tmp/x"));
        assert_eq!(p.tokens, Path::new("/tmp/x/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/tokens.txt"));
        assert_eq!(p.vad, Path::new("/tmp/x/silero_vad.onnx"));
    }

    #[test]
    fn is_present_false_when_missing_then_true_when_all_exist() {
        let dir = tempfile::tempdir().unwrap();
        let p = model_paths(dir.path());
        assert!(!is_present(&p));
        for f in [&p.encoder, &p.decoder, &p.joiner, &p.tokens, &p.vad] {
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, b"x").unwrap();
        }
        assert!(is_present(&p));
    }
}

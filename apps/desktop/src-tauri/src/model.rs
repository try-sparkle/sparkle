//! Download + cache the on-device STT models (Parakeet-TDT v2 int8 + Silero VAD).
//!
//! Integrity here is not a nicety, it's a crash guard. `ParakeetTdt::new` hands these files to
//! sherpa-onnx, which hands them to ONNX Runtime (C++). A malformed .onnx makes ORT throw a C++
//! exception that crosses the FFI boundary uncaught → std::terminate → SIGABRT. That is a NATIVE
//! abort: `catch_unwind` cannot catch it, and the graceful `Option`-to-`Err` path in transcribe.rs
//! never runs because the process is already gone. So the only available defense is to never hand
//! an unverified file to sherpa-onnx. Everything below exists for that.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// wired up in Task 3
#[allow(dead_code)]
const ASR_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2";
// wired up in Task 3
#[allow(dead_code)]
const VAD_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
const ASR_DIR: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";

// Exact byte size of every file we install, verified against the upstream `content-length` and a
// known-good install. Both URLs point at an immutable GitHub release asset, so these are stable,
// which makes a size check a sound (and instant, and offline) integrity test: any mismatch means
// truncated, tampered with, or a different artifact — all of them fatal.
//
// !! Bumping ASR_URL or VAD_URL REQUIRES re-deriving these sizes. !!
// `expected_sizes_are_pinned_to_the_pinned_urls` fails if you change a URL without doing so.
const VAD_SIZE: u64 = 643_854;
const ENCODER_SIZE: u64 = 652_184_296;
const DECODER_SIZE: u64 = 7_257_753;
const JOINER_SIZE: u64 = 1_739_080;
const TOKENS_SIZE: u64 = 9_384;
/// Compressed tarball size — used only to budget free space for the preflight.
const ASR_TARBALL_SIZE: u64 = 482_468_385;

/// Each ASR file's name inside the tarball's top-level dir, with its expected size. Used to
/// verify a *staged* tree, where there is no `ModelPaths` yet.
const ASR_FILES: [(&str, u64); 4] = [
    ("encoder.int8.onnx", ENCODER_SIZE),
    ("decoder.int8.onnx", DECODER_SIZE),
    ("joiner.int8.onnx", JOINER_SIZE),
    ("tokens.txt", TOKENS_SIZE),
];

const VAD_FILE: &str = "silero_vad.onnx";

/// Scratch dirs live under `root` and carry this prefix so a crashed run's leavings are
/// recognizable (and reapable) on the next entry.
const TEMP_PREFIX: &str = ".incomplete-";

/// A 482MB transfer shouldn't lose everything to one transient blip.
const DOWNLOAD_ATTEMPTS: u32 = 3;

/// How long to wait for the TCP+TLS connection itself. A host that won't complete a handshake in
/// this long isn't slow, it's unreachable — say so rather than sit there.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// The gap we tolerate between BYTES ARRIVING — emphatically NOT a budget for the whole transfer.
/// This distinction is the entire point: an overall timeout would false-fail the 482MB download on
/// any slow connection (it's ~13 minutes at 600 KB/s, and legitimately hours on hotel wifi), so we
/// deliberately never set `timeout()`. A per-read deadline instead bounds only silence: as long as
/// *some* data lands every 60s the download runs as long as it needs, but a socket that opens and
/// then says nothing — a captive portal, a dropped-off wifi, a black-holed route — errors out
/// instead of hanging forever. Without this, ureq 2's `timeout_read` is UNSET (infinite) and
/// `ensure` never returns and never errors: the retry below can't help, because the first attempt
/// never finishes to be retried.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Same reasoning as READ_TIMEOUT, for the (tiny) request we send. Only ever the GET header.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// The HTTP client for both model downloads. Built once per `ensure` and shared, so the timeouts
/// can't be forgotten on one path (a bare `ureq::get` inherits NO read timeout — see READ_TIMEOUT).
fn http_agent() -> ureq::Agent {
    agent_with(CONNECT_TIMEOUT, READ_TIMEOUT, WRITE_TIMEOUT)
}

/// Split out so the timeout behaviour is testable against a local stalling socket in milliseconds
/// instead of the 60s the shipped values would take.
fn agent_with(connect: Duration, read: Duration, write: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(connect)
        .timeout_read(read)
        .timeout_write(write)
        // NOTE: no `.timeout(..)` — that's an overall deadline, which would cap how long a legit
        // slow download may take. See READ_TIMEOUT.
        .build()
}

/// A socket read timeout surfaces as `TimedOut` or `WouldBlock` depending on the platform's flavour
/// of SO_RCVTIMEO/EAGAIN, so treat both as "the bytes stopped coming".
fn is_stall(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
}

/// Failure to open the request, in words. The frontend classifies network/offline errors off this
/// text and shows it, so it has to name the condition — ureq's own Display is a bare
/// `https://…: Network Error`, which tells a user nothing about what to do next.
fn net_err(what: &str, e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("{what} failed: the model server returned HTTP {code}"),
        // Everything else is transport — DNS, refused, TLS, or the read timeout firing while we
        // waited on response headers (the captive portal that accepts your connection then says
        // nothing). To a user these are one condition: the network isn't working.
        ureq::Error::Transport(t) => {
            format!("{what} failed: couldn't reach the model server — check your internet connection ({t})")
        }
    }
}

/// Failure *mid-body*, in words. This is where a stall lands once the response has started: the
/// read timeout fires inside the download/decompress pipeline as a plain io error, whose Display is
/// an `Os { code: 60, .. }` blob. That is not an error message; this is.
///
/// The quoted duration is READ_TIMEOUT, the shipped value, rather than the timeout of whichever
/// agent actually errored — the two are only decoupled in this module's own tests, which build
/// millisecond-scale agents via `agent_with` so they don't take a minute to run. `http_agent` is the
/// sole constructor on every production path (`ensure` builds one and both downloads share it), so
/// what a user is told is always what actually elapsed. If a second real agent ever appears, thread
/// its read timeout through instead of letting this number drift.
fn stream_err(what: &str, e: &std::io::Error) -> String {
    if is_stall(e) {
        return format!(
            "{what} stalled: no data received for {}s — check your internet connection and try again",
            READ_TIMEOUT.as_secs()
        );
    }
    format!("{what} failed: {e}")
}

/// Sampling interval for `dictation://model-progress`. `ProgressReader` fires per `read()`, and
/// BzDecoder pulls the compressed stream through an 8KB BufReader, so the 482MB tarball produces
/// ~79,000 callbacks — each one a full `app.emit` (JSON serialize + eval into EVERY window) driving
/// a zustand `set` → React re-render, ~1,000/sec sustained for the entire download. This codebase
/// already made exactly this call one module over for the level meter (see LEVEL_EMIT_INTERVAL in
/// dictation.rs, throttled at a mere 25/sec): a progress bar only has to look alive, so we sample it
/// rather than stream it. 10/sec is smooth to the eye and ~4 orders of magnitude less IPC.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// Whether a progress tick should reach the UI. Pure (the caller measures the clock) so the whole
/// decision matrix is unit-testable without sleeping.
///   - `since_last` is None for the very FIRST tick of an attempt — always emitted, so the bar
///     appears the moment bytes start moving rather than after a blind tenth of a second.
///   - `is_final` forces the last tick through regardless of timing, so the throttle can't swallow
///     the read that completes the stream and strand the UI at 97% forever.
fn should_emit_progress(since_last: Option<Duration>, is_final: bool) -> bool {
    is_final || since_last.is_none_or(|d| d >= PROGRESS_EMIT_INTERVAL)
}

/// Samples a progress callback per `PROGRESS_EMIT_INTERVAL`. Sits between `ProgressReader` (which
/// reports every read, and whose contract is left alone) and the caller's emit closure.
///
/// Interior mutability because `ProgressReader`'s callback is `Fn`, not `FnMut`. Uncontended in
/// practice — only the download thread ticks it — so the Mutex costs nothing and is never held
/// across the emit itself.
struct ProgressThrottle<'a, F: Fn(u64, Option<u64>)> {
    inner: &'a F,
    state: Mutex<ThrottleState>,
}

#[derive(Default)]
struct ThrottleState {
    /// When we last let a tick through, or None before the first.
    last_emit: Option<Instant>,
    /// The most recent byte count seen — tracked on EVERY tick, including throttled ones, so
    /// `finish` can report the true final number. `ProgressReader`'s count is monotonic, so this is
    /// also the highest seen, but it is the LAST that's stored; nothing here takes a max.
    seen: u64,
    /// The last `(done, total)` actually handed to `inner`, so `finish` can tell whether completion
    /// has already been announced instead of announcing it twice.
    emitted: Option<(u64, Option<u64>)>,
}

impl<'a, F: Fn(u64, Option<u64>)> ProgressThrottle<'a, F> {
    /// Fresh per download attempt, so a retry's first tick emits immediately rather than inheriting
    /// the previous attempt's clock.
    fn new(inner: &'a F) -> Self {
        Self { inner, state: Mutex::new(ThrottleState::default()) }
    }

    fn tick(&self, done: u64, total: Option<u64>) {
        self.tick_at(Instant::now(), done, total)
    }

    /// The clock is a parameter so the throttle's behaviour over TIME is testable by passing
    /// synthetic instants — no sleeps, and no test that silently depends on 500 iterations finishing
    /// inside a real 100ms window (which a loaded CI box would not).
    fn tick_at(&self, now: Instant, done: u64, total: Option<u64>) {
        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        st.seen = done;
        let since_last = st.last_emit.map(|t| now.duration_since(t));
        if !should_emit_progress(since_last, total == Some(done)) {
            return;
        }
        st.last_emit = Some(now);
        st.emitted = Some((done, total));
        drop(st); // never emit under the lock
        (self.inner)(done, total);
    }

    /// The last word, once the transfer is known complete. `total` is None when the server omits
    /// Content-Length, and in that case NO tick can know it was the last one — so completion has to
    /// be announced from out here, or the bar sticks wherever the final sample happened to land.
    /// When Content-Length was present the final tick already announced it, so this is a no-op
    /// rather than a duplicate 100%: exactly one completion emit either way.
    fn finish(&self, total: Option<u64>) {
        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let done = st.seen;
        if st.emitted == Some((done, total)) {
            return; // the final tick already said so
        }
        st.emitted = Some((done, total));
        drop(st);
        (self.inner)(done, total);
    }
}

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

impl ModelPaths {
    /// Every installed file paired with the size it must have.
    fn expected(&self) -> [(&PathBuf, u64); 5] {
        [
            (&self.encoder, ENCODER_SIZE),
            (&self.decoder, DECODER_SIZE),
            (&self.joiner, JOINER_SIZE),
            (&self.tokens, TOKENS_SIZE),
            (&self.vad, VAD_SIZE),
        ]
    }
}

pub fn model_paths(root: &Path) -> ModelPaths {
    let d = root.join(ASR_DIR);
    ModelPaths {
        encoder: d.join("encoder.int8.onnx"),
        decoder: d.join("decoder.int8.onnx"),
        joiner: d.join("joiner.int8.onnx"),
        tokens: d.join("tokens.txt"),
        vad: root.join(VAD_FILE),
    }
}

/// A file is only real if it's there AND complete. Size carries the whole integrity story: the
/// artifacts are immutable, so "right size" is as good as a hash here, and costs one stat().
fn check_size(f: &Path, want: u64) -> Result<(), String> {
    match std::fs::metadata(f) {
        Ok(md) if md.len() == want => Ok(()),
        Ok(md) => Err(format!(
            "{} is {} bytes, expected {want} (truncated or corrupt download)",
            f.display(),
            md.len()
        )),
        Err(e) => Err(format!("{}: {e}", f.display())),
    }
}

/// Verify the installed model. `Err` carries the first thing found wrong, for the log/UI.
pub fn verify(p: &ModelPaths) -> Result<(), String> {
    for (f, want) in p.expected() {
        check_size(f, want)?;
    }
    Ok(())
}

/// "Present" means complete, not merely existing. A truncated file MUST read as absent so that
/// `ensure` re-downloads and the install self-heals — that is what un-bricks users already stuck
/// with a half-downloaded model from before this check existed.
pub fn is_present(p: &ModelPaths) -> bool {
    verify(p).is_ok()
}

/// The short-circuit decision, split out so it's testable without a network or a 631MB fixture.
fn needs_download(p: &ModelPaths) -> bool {
    !is_present(p)
}

/// The four ASR files verified inside an arbitrary dir — used on a staged tree, before it is
/// allowed anywhere near the real paths.
fn verify_asr_dir(d: &Path) -> Result<(), String> {
    for (name, want) in ASR_FILES {
        check_size(&d.join(name), want)?;
    }
    Ok(())
}

/// A scratch dir under `root`, removed on drop. Downloads land here and are renamed into place
/// only once verified, so an interrupted transfer can never occupy a path `model_paths` points
/// at. It must stay under `root` so that final rename is same-filesystem, i.e. atomic.
struct Incomplete {
    path: PathBuf,
}

impl Incomplete {
    fn new(root: &Path, tag: &str) -> Result<Self, String> {
        // pid alone would collide between two `ensure` calls in one process; the counter makes
        // the name unique within it too.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!("{TEMP_PREFIX}{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        Ok(Self { path })
    }

    /// Empty the dir between retry attempts so a partial extract can't confuse the next one.
    fn reset(&self) -> Result<(), String> {
        let _ = std::fs::remove_dir_all(&self.path);
        std::fs::create_dir_all(&self.path).map_err(|e| e.to_string())
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Incomplete {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Reap scratch dirs orphaned by a previous run that was killed mid-download. Without this,
/// `root` silently accumulates hundreds of MB per crashed attempt.
///
/// Scratch owned by THIS process is spared: `start_dictation` calls `ensure` before it takes the
/// session lock, so two rapid mic clicks can be downloading concurrently, and sweeping a live
/// sibling's dir out from under it would fail that download for no reason. Anything tagged with
/// another pid is either finished or dead, so it's fair game.
fn clean_stale_temps(root: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let ours = format!("-{}-", std::process::id());
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(TEMP_PREFIX) && !name.contains(&ours) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Move a staged ASR tree onto its final path, but ONLY if it verifies. This refusal is what
/// makes a partial download structurally unable to become the installed model.
fn promote_asr(staged: &Path, root: &Path) -> Result<(), String> {
    verify_asr_dir(staged)?;
    let dest = root.join(ASR_DIR);
    // rename(2) won't replace a non-empty dir, so a corrupt install has to go first. A crash in
    // that window leaves the model absent, which is the self-healing state: the next ensure()
    // re-downloads. It never leaves a half-tree where a whole one is expected.
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    std::fs::rename(staged, &dest).map_err(|e| format!("failed to install model: {e}"))
}

/// Retry with linear backoff. Deliberately small and dumb — enough to ride out a blip, not a
/// substitute for the user having a network.
fn with_retry<T>(what: &str, mut attempt: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let mut last = String::new();
    for i in 1..=DOWNLOAD_ATTEMPTS {
        match attempt() {
            Ok(v) => return Ok(v),
            Err(e) => {
                tracing::warn!(target: "model", "{what} attempt {i}/{DOWNLOAD_ATTEMPTS} failed: {e}");
                last = e;
                if i < DOWNLOAD_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_secs(2 * i as u64));
                }
            }
        }
    }
    Err(format!("{what} failed after {DOWNLOAD_ATTEMPTS} attempts: {last}"))
}

/// Bytes that must be free before we start. The tarball streams through memory rather than
/// spooling to disk, but we budget for it anyway: erring toward slack costs a user nothing,
/// while erring tight means failing mid-extract, which is the exact mess this module is fixing.
fn space_needed(need_vad: bool, need_asr: bool) -> u64 {
    let mut n = 0;
    if need_vad {
        n += VAD_SIZE;
    }
    if need_asr {
        // Extracted tree ≈ the four files plus the tarball's test_wavs/ fixtures, and then the
        // compressed tarball's size again as margin.
        n += ENCODER_SIZE + DECODER_SIZE + JOINER_SIZE + TOKENS_SIZE + ASR_TARBALL_SIZE;
    }
    n
}

fn human(bytes: u64) -> String {
    const GB: f64 = 1_073_741_824.0;
    const MB: f64 = 1_048_576.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else {
        format!("{:.0} MB", b / MB)
    }
}

/// Fail the download *before* it starts rather than halfway through, with a number the user can
/// act on.
fn check_space(available: u64, needed: u64) -> Result<(), String> {
    if available >= needed {
        return Ok(());
    }
    Err(format!(
        "Need ~{} free to download the voice model; only {} available. Free up some space and try again.",
        human(needed),
        human(available)
    ))
}

/// Free space on `dir`'s volume, or `None` if we can't tell — in which case we don't block, since
/// a preflight that can't measure shouldn't stop a download that might well succeed.
#[cfg(unix)]
fn available_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: `c` is a valid NUL-terminated path that outlives the call; statvfs only reads it
    // and writes into our zeroed `st`.
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st) != 0 {
            return None;
        }
        // f_bavail is blocks free to an unprivileged process (not f_bfree, which counts the
        // root-reserved pool we can't touch); f_frsize is the unit those blocks are measured in.
        // `checked_mul` because that product is a disk size on a 32-bit block count: a big
        // enough volume overflows, and reporting "unknown" beats wrapping to a tiny number and
        // refusing the download.
        u64::from(st.f_bavail).checked_mul(st.f_frsize)
    }
}

#[cfg(not(unix))]
fn available_space(_dir: &Path) -> Option<u64> {
    None
}

/// Download + extract the models into `root` if not already present. `progress` is
/// called with (bytes_done, total_bytes) during the large ASR download.
// wired up in Task 3
#[allow(dead_code)]
pub fn ensure(root: &Path, progress: impl Fn(u64, Option<u64>)) -> Result<ModelPaths, String> {
    let paths = model_paths(root);
    // A complete install is left strictly alone — no re-download, nothing touched.
    if !needs_download(&paths) {
        return Ok(paths);
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    clean_stale_temps(root);

    // Checked per-artifact so a bad VAD doesn't cost a 631MB ASR re-download, or vice versa.
    let need_vad = check_size(&paths.vad, VAD_SIZE).is_err();
    let need_asr = verify_asr_dir(&root.join(ASR_DIR)).is_err();

    if let Some(avail) = available_space(root) {
        check_space(avail, space_needed(need_vad, need_asr))?;
    }

    // One agent for both downloads: its timeouts are the only thing standing between a stalled
    // connection and an `ensure` that never returns (see READ_TIMEOUT).
    let http = http_agent();
    if need_vad {
        with_retry("silero_vad.onnx download", || download_vad(&http, root))?;
    }
    if need_asr {
        download_asr(&http, root, &progress)?;
    }

    // Belt and braces: never return paths we haven't just proven good.
    verify(&paths)?;
    Ok(paths)
}

/// Fetch the VAD into scratch, then rename over the real path — rename is atomic, so the file at
/// `paths.vad` is either the old one or a complete new one, never a partial write.
fn download_vad(http: &ureq::Agent, root: &Path) -> Result<(), String> {
    let tmp = Incomplete::new(root, "vad")?;
    let staged = tmp.path().join(VAD_FILE);
    let mut buf = Vec::new();
    http.get(VAD_URL)
        .call()
        .map_err(|e| net_err("silero_vad.onnx download", &e))?
        .into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| stream_err("silero_vad.onnx download", &e))?;
    std::fs::write(&staged, &buf).map_err(|e| e.to_string())?;
    check_size(&staged, VAD_SIZE)?;
    std::fs::rename(&staged, root.join(VAD_FILE)).map_err(|e| e.to_string())
}

/// Stream the tarball through bzip2+untar into scratch, verify the extracted tree, and only then
/// move it into place. Progress is reported off the compressed bytes as they flow.
fn download_asr(http: &ureq::Agent, root: &Path, progress: &impl Fn(u64, Option<u64>)) -> Result<(), String> {
    let tmp = Incomplete::new(root, "asr")?;
    with_retry("voice model download", || {
        tmp.reset()?;
        let resp = http.get(ASR_URL).call().map_err(|e| net_err("voice model download", &e))?;
        let total: Option<u64> = resp.header("Content-Length").and_then(|s| s.parse().ok());
        // Sampled, not streamed: ~79,000 reads become ~10 emits/sec (see PROGRESS_EMIT_INTERVAL).
        // Built per attempt, inside the retry, so a retry's first byte repaints the bar at once.
        let throttle = ProgressThrottle::new(progress);
        let counting = ProgressReader {
            inner: resp.into_reader(),
            progress: |done, total| throttle.tick(done, total),
            done: 0,
            total,
        };
        let tar = bzip2::read::BzDecoder::new(counting);
        let mut archive = tar::Archive::new(tar);
        // The tarball's top dir is ASR_DIR, so unpacking into scratch yields <tmp>/ASR_DIR. A
        // mid-transfer stall (the read timeout firing) lands HERE, as an io error surfacing up
        // through the bzip2/tar pipeline — so it gets the same plain-language treatment.
        archive.unpack(tmp.path()).map_err(|e| stream_err("voice model download", &e))?;
        promote_asr(&tmp.path().join(ASR_DIR), root)?;
        // The transfer is complete; say so unthrottled, so the bar can't be left parked at 97%
        // because the throttle happened to swallow the final read.
        throttle.finish(total);
        Ok(())
    })
}

/// Last gate before sherpa-onnx. Not redundant with `ensure`: a file can rot, be tampered with,
/// or get truncated by a full disk in between. Since a bad .onnx aborts the PROCESS (uncatchable
/// — see the module docs), we turn that into an ordinary `Err` here and drop the bad install so
/// the next attempt re-downloads cleanly.
pub fn verify_for_load(root: &Path, paths: &ModelPaths) -> Result<(), String> {
    let Err(e) = verify(paths) else { return Ok(()) };
    tracing::error!(target: "model", "voice model failed verification before load, purging: {e}");
    let _ = std::fs::remove_dir_all(root.join(ASR_DIR));
    let _ = std::fs::remove_file(root.join(VAD_FILE));
    Err(format!(
        "The voice model was incomplete and has been removed; it will re-download next time you use the mic. ({e})"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Lay down a file of exactly `size` bytes. `set_len` leaves it sparse, so the 652MB encoder
    /// costs no real disk and these tests stay instant.
    fn write_sized(p: &Path, size: u64) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::File::create(p).unwrap().set_len(size).unwrap();
    }

    /// A dir that looks exactly like a known-good install.
    fn install_good(root: &Path) -> ModelPaths {
        let p = model_paths(root);
        for (f, want) in p.expected() {
            write_sized(f, want);
        }
        p
    }

    fn stage_good_asr(at: &Path) {
        for (name, want) in ASR_FILES {
            write_sized(&at.join(name), want);
        }
    }

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
        install_good(dir.path());
        assert!(is_present(&p));
    }

    /// The exact regression that bricked the app: all five files exist, but one is truncated. The
    /// old `exists()`-only check called that "present", `ensure` short-circuited, and the
    /// truncated encoder reached ONNX Runtime → uncatchable SIGABRT on every mic click.
    #[test]
    fn is_present_false_for_truncated_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = install_good(dir.path());
        assert!(is_present(&p), "sanity: a good install is present");

        write_sized(&p.encoder, ENCODER_SIZE - 1); // e.g. wifi dropped mid-download
        assert!(!is_present(&p), "a truncated encoder must read as ABSENT so ensure() re-downloads");
        assert!(needs_download(&p), "and ensure() must not short-circuit on it");
    }

    /// Every file is checked, not just the first — and "wrong size" includes too big, which isn't
    /// the pinned artifact either.
    #[test]
    fn is_present_true_only_when_every_size_matches() {
        let dir = tempfile::tempdir().unwrap();
        let p = install_good(dir.path());
        for (f, want) in p.expected() {
            write_sized(f, want + 1);
            assert!(!is_present(&p), "{} at the wrong size must read as absent", f.display());
            write_sized(f, want);
            assert!(is_present(&p), "{} restored, so present again", f.display());
        }
    }

    /// Guards against a 631MB re-download for every existing user: a dir at exactly the pinned
    /// sizes verifies, and `ensure` short-circuits instead of re-fetching.
    #[test]
    fn known_good_install_is_never_redownloaded() {
        let dir = tempfile::tempdir().unwrap();
        let p = install_good(dir.path());
        assert_eq!(verify(&p), Ok(()), "a known-good install must verify");
        assert!(!needs_download(&p), "a known-good install must not trigger a re-download");
    }

    /// A staged tree that doesn't verify must never reach the real path — the property that makes
    /// a partial download harmless.
    #[test]
    fn unverified_staged_tree_is_never_promoted() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staging").join(ASR_DIR);
        stage_good_asr(&staged);
        write_sized(&staged.join("encoder.int8.onnx"), 10); // interrupted extract

        assert!(promote_asr(&staged, dir.path()).is_err());
        assert!(!dir.path().join(ASR_DIR).exists(), "a bad tree must not land at the final path");
    }

    #[test]
    fn verified_staged_tree_is_promoted() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staging").join(ASR_DIR);
        stage_good_asr(&staged);

        assert_eq!(promote_asr(&staged, dir.path()), Ok(()));
        assert!(verify_asr_dir(&dir.path().join(ASR_DIR)).is_ok());
        assert!(!staged.exists(), "staged tree was moved, not copied");
    }

    /// A corrupt install is replaced wholesale rather than merged into.
    #[test]
    fn promote_replaces_a_corrupt_install() {
        let dir = tempfile::tempdir().unwrap();
        write_sized(&dir.path().join(ASR_DIR).join("encoder.int8.onnx"), 7); // truncated
        let staged = dir.path().join("staging").join(ASR_DIR);
        stage_good_asr(&staged);

        assert_eq!(promote_asr(&staged, dir.path()), Ok(()));
        assert!(verify_asr_dir(&dir.path().join(ASR_DIR)).is_ok());
    }

    #[test]
    fn stale_temp_dirs_are_cleaned_but_real_files_are_not() {
        let dir = tempfile::tempdir().unwrap();
        // +1 so it's some other process's leavings no matter what pid we happen to be.
        let stale = dir.path().join(format!("{TEMP_PREFIX}asr-{}-0", std::process::id() + 1));
        write_sized(&stale.join("encoder.int8.onnx"), 4096); // orphaned garbage
        let keep = install_good(dir.path());

        clean_stale_temps(dir.path());
        assert!(!stale.exists(), "orphaned scratch dir must be reaped");
        assert!(is_present(&keep), "a real install must survive the sweep");
    }

    /// Two rapid mic clicks both reach `ensure` before either takes the session lock, so one
    /// thread's sweep must not delete the other's live download.
    #[test]
    fn sweep_spares_scratch_owned_by_a_concurrent_ensure() {
        let dir = tempfile::tempdir().unwrap();
        let live = Incomplete::new(dir.path(), "asr").unwrap();
        write_sized(&live.path().join("encoder.int8.onnx"), 4096); // mid-extract right now

        clean_stale_temps(dir.path());
        assert!(live.path().exists(), "a live in-process download must survive the sweep");
    }

    #[test]
    fn incomplete_dir_is_removed_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = {
            let tmp = Incomplete::new(dir.path(), "asr").unwrap();
            write_sized(&tmp.path().join("partial.onnx"), 128);
            assert!(tmp.path().starts_with(dir.path()), "scratch must share root's filesystem");
            tmp.path().to_path_buf()
        };
        assert!(!path.exists(), "scratch must not outlive a failed attempt");
    }

    /// The size table is only valid for the artifacts these URLs point at. If a URL changes, this
    /// fails — which is the point: it forces you back here to re-derive the sizes.
    #[test]
    fn expected_sizes_are_pinned_to_the_pinned_urls() {
        assert_eq!(
            ASR_URL,
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"
        );
        assert_eq!(
            VAD_URL,
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
        );
        assert!(ASR_URL.contains(ASR_DIR), "the tarball's top dir must match ASR_DIR");
        // Verified against upstream content-length + a known-good install.
        assert_eq!(
            [VAD_SIZE, ENCODER_SIZE, DECODER_SIZE, JOINER_SIZE, TOKENS_SIZE, ASR_TARBALL_SIZE],
            [643_854, 652_184_296, 7_257_753, 1_739_080, 9_384, 482_468_385]
        );
    }

    #[test]
    fn space_check_blocks_only_when_short() {
        let need = space_needed(true, true);
        assert!(need > ENCODER_SIZE, "must budget more than the encoder alone");
        assert_eq!(check_space(need, need), Ok(()), "exactly enough is enough");
        assert_eq!(check_space(need + 1, need), Ok(()));

        let err = check_space(100 * 1024 * 1024, need).unwrap_err();
        assert!(err.contains("1.1 GB"), "must state what's needed: {err}");
        assert!(err.contains("100 MB"), "and what's available: {err}");
    }

    /// Only what's actually missing gets budgeted — a bad VAD must not demand 1.1GB free.
    #[test]
    fn space_needed_is_per_artifact() {
        assert_eq!(space_needed(true, false), VAD_SIZE);
        assert_eq!(space_needed(false, false), 0);
        assert!(space_needed(false, true) > space_needed(true, false));
    }

    #[test]
    fn verify_for_load_purges_a_corrupt_install_so_the_next_click_heals() {
        let dir = tempfile::tempdir().unwrap();
        let p = install_good(dir.path());
        assert_eq!(verify_for_load(dir.path(), &p), Ok(()), "a good install loads untouched");
        assert!(is_present(&p), "and is left in place");

        write_sized(&p.joiner, 3); // bit-rot after ensure() ran
        let err = verify_for_load(dir.path(), &p).unwrap_err();
        assert!(err.contains("re-download"), "error must say what happens next: {err}");
        assert!(!p.joiner.exists(), "the corrupt install must be purged");
        assert!(!p.vad.exists(), "including the VAD, so ensure() rebuilds cleanly");
        assert!(needs_download(&model_paths(dir.path())), "so the next click re-downloads");
    }

    /// The size table above is only worth anything if it matches a real install. This checks it
    /// against one on disk — read-only, so it can't disturb the model it's inspecting. The rest
    /// of the suite fakes these sizes with sparse files; this is the test that proves the numbers
    /// being faked are the true ones, and that a real user's model won't be re-downloaded.
    #[test]
    #[ignore = "needs a real install; run with SPARKLE_MODEL_DIR set"]
    fn real_install_verifies_and_is_not_redownloaded() {
        let root = PathBuf::from(std::env::var("SPARKLE_MODEL_DIR").unwrap());
        let p = model_paths(&root);
        assert_eq!(verify(&p), Ok(()), "a real known-good install must verify");
        assert!(!needs_download(&p), "and must NOT trigger a 631MB re-download");
    }

    /// The throttle decision, exhaustively — pure, with the elapsed time injected, so there are no
    /// timers or sleeps to make this flaky.
    #[test]
    fn progress_throttle_lets_the_first_and_final_ticks_through_and_samples_the_rest() {
        // FIRST tick of an attempt (nothing emitted yet): always through, so the bar appears the
        // instant bytes move instead of after a blind PROGRESS_EMIT_INTERVAL of apparent freeze.
        assert!(should_emit_progress(None, false), "the first tick must emit immediately");
        // The ~79,000-emit flood this exists to stop: reads land microseconds apart and are dropped
        // until the interval elapses.
        assert!(!should_emit_progress(Some(Duration::ZERO), false));
        assert!(
            !should_emit_progress(Some(PROGRESS_EMIT_INTERVAL - Duration::from_millis(1)), false),
            "just inside the interval is still too chatty"
        );
        // Interval elapsed → sample.
        assert!(should_emit_progress(Some(PROGRESS_EMIT_INTERVAL), false), "exactly the interval emits");
        assert!(should_emit_progress(Some(PROGRESS_EMIT_INTERVAL * 3), false));
        // The FINAL tick overrides the throttle no matter how recently we emitted — otherwise the
        // read that completes the stream gets swallowed and the UI sits at 97% forever.
        assert!(should_emit_progress(Some(Duration::ZERO), true), "completion must never be throttled");
        assert!(should_emit_progress(None, true));
    }

    /// The throttle end to end, on a SYNTHETIC clock: a flood of reads collapses to one emit, the
    /// sampling resumes once the interval elapses, and completion always lands exactly once. Driving
    /// `tick_at` rather than `tick` is what keeps this deterministic — on the real clock the test
    /// would be asserting that 500 iterations finish within 100ms, which a loaded CI box can break.
    #[test]
    fn progress_throttle_collapses_a_flood_but_still_reports_completion() {
        let seen: Mutex<Vec<(u64, Option<u64>)>> = Mutex::new(Vec::new());
        let record = |done, total| seen.lock().unwrap().push((done, total));
        let total = Some(1_000u64);
        let throttle = ProgressThrottle::new(&record);
        let t0 = Instant::now();

        // 500 back-to-back reads, as BzDecoder's 8KB pulls would produce — microseconds apart, all
        // inside one PROGRESS_EMIT_INTERVAL, so only the first is allowed through.
        for done in 1..=500u64 {
            // First read lands exactly at t0, so the interval below is measured from a known point.
            throttle.tick_at(t0 + Duration::from_micros(done - 1), done, total);
        }
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &[(1, total)],
            "a burst inside one interval must collapse to the single first emit"
        );

        // Once the interval has elapsed, sampling resumes — the bar keeps moving during the download.
        throttle.tick_at(t0 + PROGRESS_EMIT_INTERVAL, 600, total);
        assert_eq!(seen.lock().unwrap().as_slice(), &[(1, total), (600, total)]);

        // The read that completes the stream (done == total) is final, so it bypasses the throttle
        // even though we emitted microseconds ago.
        throttle.tick_at(t0 + PROGRESS_EMIT_INTERVAL + Duration::from_micros(1), 1_000, total);
        assert_eq!(seen.lock().unwrap().last(), Some(&(1_000, total)), "100% must always land");

        // ...and `finish` must not re-announce what that final tick already said: exactly one
        // completion emit, not a duplicate 100%.
        throttle.finish(total);
        assert_eq!(
            seen.lock().unwrap().iter().filter(|e| **e == (1_000, total)).count(),
            1,
            "completion must be emitted exactly once"
        );
    }

    /// Without Content-Length no tick can recognise itself as final, so `finish` is the only thing
    /// that can complete the bar. It must report the real byte total, including bytes from ticks
    /// the throttle dropped.
    #[test]
    fn progress_throttle_finish_reports_the_true_total_when_length_is_unknown() {
        let seen: Mutex<Vec<(u64, Option<u64>)>> = Mutex::new(Vec::new());
        let record = |done, total| seen.lock().unwrap().push((done, total));
        let throttle = ProgressThrottle::new(&record);
        let t0 = Instant::now();

        throttle.tick_at(t0, 10, None); // first — emits
        throttle.tick_at(t0 + Duration::from_micros(1), 4_096, None); // throttled; count still tracked
        assert_eq!(seen.lock().unwrap().len(), 1, "no tick can be 'final' without a total");

        throttle.finish(None);
        assert_eq!(
            seen.lock().unwrap().last(),
            Some(&(4_096, None)),
            "finish must report the last bytes SEEN, not the last bytes emitted"
        );
    }

    /// A socket that accepts and then says nothing — a captive portal, or wifi that dropped off
    /// mid-request. Serves the response bytes given, then stalls. Returns its URL; the listener is
    /// held by the spawned thread for the life of the test.
    fn stalling_server(preamble: &'static [u8]) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                use std::io::Write;
                let _ = sock.write_all(preamble);
                let _ = sock.flush();
                // Hold the connection open and send nothing more. Comfortably longer than the
                // millisecond-scale read timeouts these tests use.
                std::thread::sleep(Duration::from_secs(10));
            }
        });
        url
    }

    /// Bug 2, at the point it actually bites: the connection OPENS (so `timeout_connect` never
    /// fires) and then stalls. With ureq 2's default `timeout_read` — UNSET, i.e. infinite — this
    /// call never returns and never errors, freezing the app with no error and no cancel. The retry
    /// can't save it either: the first attempt never completes, so there is nothing to retry.
    /// Real timeouts, just millisecond-scale so the test isn't 60s long.
    #[test]
    fn a_stalled_connection_times_out_instead_of_hanging_forever() {
        let url = stalling_server(b""); // accepts, never sends a single header byte
        let http = agent_with(Duration::from_secs(5), Duration::from_millis(150), Duration::from_secs(5));

        let started = Instant::now();
        let err = http.get(&url).call().expect_err("a stalled socket must error, not hang");
        assert!(started.elapsed() < Duration::from_secs(5), "the read timeout must fire promptly");

        // ...and the user must be told something they can act on, not `Network Error`.
        let msg = net_err("voice model download", &err);
        assert!(msg.contains("check your internet connection"), "unhelpful error text: {msg}");
        assert!(msg.contains("voice model download"), "must say what failed: {msg}");
    }

    /// The same stall one step later: headers arrived, so the failure surfaces mid-BODY as a plain
    /// io error inside the download → bzip2 → tar pipeline (i.e. out of `archive.unpack`). That's a
    /// different code path from the one above and needs the same plain-language treatment.
    #[test]
    fn a_stall_mid_body_surfaces_as_a_readable_network_error() {
        let url = stalling_server(b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n"); // then silence
        let http = agent_with(Duration::from_secs(5), Duration::from_millis(150), Duration::from_secs(5));

        let resp = http.get(&url).call().expect("headers arrive; only the body stalls");
        let mut buf = Vec::new();
        let err = resp.into_reader().read_to_end(&mut buf).expect_err("a stalled body must error");

        assert!(is_stall(&err), "a read timeout must classify as a stall, got {:?}", err.kind());
        let msg = stream_err("voice model download", &err);
        assert!(msg.contains("stalled"), "must name the condition: {msg}");
        assert!(msg.contains("60s"), "must state the tolerated silence: {msg}");
        assert!(msg.contains("check your internet connection"), "must say what to do: {msg}");
    }

    /// A stall is a stall under either platform spelling; a genuinely different io failure must not
    /// be mislabelled as a network problem.
    #[test]
    fn only_a_timeout_reads_as_a_stall() {
        use std::io::{Error, ErrorKind};
        for kind in [ErrorKind::TimedOut, ErrorKind::WouldBlock] {
            assert!(is_stall(&Error::new(kind, "x")), "{kind:?} is the read timeout firing");
        }
        let disk = Error::new(ErrorKind::PermissionDenied, "denied");
        assert!(!is_stall(&disk));
        let msg = stream_err("voice model download", &disk);
        assert!(!msg.contains("internet"), "a disk error must not blame the network: {msg}");
        assert!(msg.contains("denied"), "and must still carry the real cause: {msg}");
    }

    /// An HTTP error (asset moved/removed upstream) is not a connectivity problem and must not be
    /// reported as one — the code is what a bug report needs.
    #[test]
    fn an_http_status_error_names_the_status() {
        let resp = ureq::Response::new(404, "Not Found", "nope").unwrap();
        let msg = net_err("voice model download", &ureq::Error::Status(404, resp));
        assert!(msg.contains("404"), "must surface the status: {msg}");
        assert!(!msg.contains("internet connection"), "a 404 is not an offline user: {msg}");
    }

    /// The timeouts are the whole fix for Bug 2, so pin the reasoning: a read timeout bounds the gap
    /// between BYTES, never the transfer, and there must be no overall deadline that could
    /// false-fail a legitimately slow 482MB download.
    #[test]
    fn download_timeouts_are_set_and_bound_silence_rather_than_duration() {
        assert!(READ_TIMEOUT >= Duration::from_secs(30), "too tight: a slow link's TCP pauses would false-fail");
        assert!(READ_TIMEOUT <= Duration::from_secs(120), "too loose: a dead connection must surface promptly");
        assert!(CONNECT_TIMEOUT < READ_TIMEOUT, "an unreachable host should fail faster than a stalled one");
        // A 482MB tarball takes ~13 min at 600 KB/s and hours on bad hotel wifi. Every one of those
        // reads returns bytes well inside READ_TIMEOUT, so the download runs as long as it needs.
        let slow_link_read_gap = Duration::from_millis(8 * 1024 * 1000 / (50 * 1024)); // 8KB read @ 50 KB/s = 160ms
        assert!(slow_link_read_gap < READ_TIMEOUT, "a 50 KB/s link must not trip the read timeout");
        // Smoke: the agent builds (and both downloads go through this one, so neither can regress
        // back to a bare `ureq::get` with no read timeout at all).
        let _ = http_agent();
    }

    #[test]
    fn available_space_reports_a_real_volume() {
        let dir = tempfile::tempdir().unwrap();
        // Can't assert an exact figure, but a mounted volume must report *something*.
        assert!(available_space(dir.path()).unwrap_or(0) > 0);
        assert!(available_space(Path::new("/definitely/not/a/path")).is_none());
    }
}

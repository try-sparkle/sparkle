// Crash / panic capture for the Sparkle desktop app.
//
// TWO layers, BOTH always-on for every user (they only write to the user's own disk — nothing
// leaves the machine here; upload is gated separately in `flush_crash_reports`):
//
//   1. A Rust panic hook (`std::panic::set_hook`) that CHAINS to the previous hook (so the existing
//      audio.rs `catch_unwind` firewall + normal thread unwinding are unchanged — we do NOT switch
//      to panic=abort). It (a) writes the panic to the tracing log so the hourly Improvement Agent,
//      which reads the log dir, sees it, and (b) writes a structured crash record JSON to
//      ~/Library/Logs/ai.sparkle.desktop/crashes/crash-<uuid>.json.
//
//   2. A native fatal-signal handler (SIGSEGV/SIGABRT/SIGBUS/SIGILL) — this is what catches a native
//      crash a panic hook cannot (e.g. the CoreAudio mic abort). It writes a MINIMAL breadcrumb file
//      using ONLY async-signal-safe operations (see the strict rules on `handle_fatal_signal`), then
//      restores the default handler and re-raises so the process still crashes normally.
//
// `flush_crash_reports` (a Tauri command, called fire-and-forget at launch) scans the crashes dir,
// redacts message + backtrace, and — for any CONSENTING Sparkle-Improvement mode ("always" or the
// default "case_by_case"; see `upload_allowed`) — POSTs each to the orchestration `/telemetry/crash`
// ingest, deleting a report once the server 2xx-acknowledges it. The two consenting modes differ in
// what rides along: only "always" attaches the REDACTED recent-log window (see `logs_allowed`).

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Runtime};

use crate::support::redact_secrets;

/// Bound the crash-upload HTTP call so an unreachable host can't wedge the flush command. Mirrors
/// support.rs / auth.rs — ureq has no default request timeout.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Never upload more than this many reports per flush (most-recent first); the rest are left on
/// disk for the next launch. Keeps a large backlog from stalling startup or hammering the server.
const MAX_UPLOADS_PER_FLUSH: usize = 20;

/// Hard retention cap on the crashes dir: keep only the newest N crash files, delete the rest. Bounds
/// disk use so nothing can grow it without limit — a persistently-unreachable upload host (uploads
/// keep failing, files never deleted) or, in the unlikely event a genuinely-fatal panic recurs across
/// runs, a slow accumulation. (Recovered/caught panics no longer write a record at all — see
/// `suppress_crash_records` — so this cap is a backstop, not the primary defense.) Enforced in
/// panic-context only (`write_crash_record` + `flush_pending`); NEVER from the signal handler.
const MAX_RETAINED_CRASH_FILES: usize = 50;

/// Minimum age before an orphaned `crash-<id>.json.tmp` is swept. Age-gating avoids racing a
/// concurrent panic-hook `write_crash_record` (which is `fs::write(tmp)` → `rename`) on another
/// thread while the background flush runs prune: an in-flight tmp is milliseconds old and thus spared,
/// while a genuine orphan from a prior run is minutes/launches old and gets cleaned up.
const TMP_ORPHAN_MIN_AGE: Duration = Duration::from_secs(60);

const DEFAULT_ORCHESTRATION_URL: &str = "http://localhost:3001";

/// Orchestration ingest base URL (no trailing slash). Mirrors usageTelemetry.ts / relayClient.ts:
/// `VITE_ORCHESTRATION_URL` override, else the fly.dev default.
fn orchestration_base_url() -> String {
    std::env::var("VITE_ORCHESTRATION_URL")
        .ok()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_ORCHESTRATION_URL.to_string())
}

// ── Build provenance ────────────────────────────────────────────────────────────────────────────
//
// Every crash report carries WHICH BUILD produced it, so a crash from the founder's own `cargo
// tauri dev` / locally-built DMG is distinguishable from a crash in a shipped build. Both values
// come from `option_env!`, which is resolved at COMPILE time and needs no build script and no extra
// crate dependency — that is exactly why they're env vars rather than, say, a `vergen`-style build
// dependency.
//
// CI (the official release pipeline) is expected to set BOTH at build time:
//   SPARKLE_OFFICIAL_BUILD=1                 → this is an official build   → channel "release"
//   SPARKLE_GIT_SHA=<the commit being built> → provenance for that build
// Neither is required: an unset/empty value DEGRADES (to channel "local" and an absent sha) rather
// than failing the build, so a plain `cargo build` keeps working untouched.

/// Longest git sha we'll send (a full sha-1 is 40 hex chars). Anything longer is truncated.
const MAX_GIT_SHA_LEN: usize = 40;

/// Which kind of build produced this crash: `"dev"` | `"local"` | `"release"`.
///
/// - `"dev"`     — a debug build (`cargo tauri dev`, `cargo test`, any `debug_assertions` build).
/// - `"release"` — a release build produced by official CI (`SPARKLE_OFFICIAL_BUILD` set non-empty).
/// - `"local"`   — a release build someone made on their own machine (the env var wasn't set).
fn build_channel() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else if option_env!("SPARKLE_OFFICIAL_BUILD").is_some_and(|v| !v.trim().is_empty()) {
        "release"
    } else {
        "local"
    }
}

/// The commit this binary was built from, or None when CI didn't stamp one in.
/// Whether a candidate sha is plausibly a git object id. `build.rs` falls back to the literal
/// `"unknown"` when git is unavailable (a tarball build), and `bridge.rs` legitimately displays that
/// — but it is NOT a sha, and the server rejects a non-hex value. Filtering here keeps a
/// non-sha sentinel off the wire entirely rather than relying on the server to cope with it.
fn is_hex_sha(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn git_sha() -> Option<&'static str> {
    normalize_git_sha(option_env!("SPARKLE_GIT_SHA")?).filter(|s| is_hex_sha(s))
}

/// Normalize a raw `SPARKLE_GIT_SHA` value: trim it, treat empty/whitespace-only as absent, and bound
/// it to `MAX_GIT_SHA_LEN` bytes. Split out from `git_sha` (whose env read is compile-time only) so
/// the rule is unit-testable against arbitrary inputs.
///
/// A real sha is 40 ASCII hex chars, so truncation is a guard against a mis-set env var rather than
/// an expected path. It cuts at the largest char boundary at or below the cap: that both keeps the
/// ≤`MAX_GIT_SHA_LEN` guarantee real for a non-ASCII value and makes the slice panic-free.
fn normalize_git_sha(raw: &str) -> Option<&str> {
    let sha = raw.trim();
    if sha.is_empty() {
        return None;
    }
    if sha.len() <= MAX_GIT_SHA_LEN {
        return Some(sha);
    }
    let end = (0..=MAX_GIT_SHA_LEN)
        .rev()
        .find(|&i| sha.is_char_boundary(i))
        .unwrap_or(0);
    Some(&sha[..end])
}

// ── Crash record schema ─────────────────────────────────────────────────────────────────────────

/// The structured crash record persisted to `crashes/crash-<crash_id>.json`. Field names are the
/// wire names (snake_case) so the same shape round-trips: the panic hook serializes it, the signal
/// handler hand-writes the identical shape, and `flush_crash_reports` deserializes it back.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CrashRecord {
    pub crash_id: String,
    /// "panic" | "signal".
    pub kind: String,
    /// Signal name (e.g. "SIGABRT") when `kind == "signal"`, else null.
    pub signal: Option<String>,
    pub message: String,
    pub backtrace: Option<String>,
    pub app_version: String,
    pub os: String,
    pub arch: String,
    /// Epoch milliseconds.
    pub occurred_at: u64,
}

// ── Install: called once from lib.rs setup, BEFORE other init ─────────────────────────────────────

/// Install the panic hook + native signal handler. Best-effort: any failure logs and returns —
/// crash capture never blocks the app from booting.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let crashes_dir = match crate::dev_identity::app_log_dir(app) {
        Ok(dir) => dir.join("crashes"),
        Err(e) => {
            tracing::error!(target: "crash", "app_log_dir failed, crash capture disabled: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&crashes_dir) {
        tracing::error!(target: "crash", "could not create crashes dir, crash capture disabled: {e}");
        return;
    }

    let app_version = app.package_info().version.to_string();
    let os = os_string();
    let arch = std::env::consts::ARCH.to_string();

    install_panic_hook(crashes_dir.clone(), app_version.clone(), os.clone(), arch.clone());

    #[cfg(unix)]
    install_signal_handler(&crashes_dir, &app_version, &os, &arch);

    tracing::info!(
        target: "crash",
        dir = %crashes_dir.display(),
        "crash capture installed (panic hook + fatal-signal handler)"
    );
}

/// Host OS label, e.g. "macOS 15.5". On macOS we shell out to `sw_vers -productVersion` ONCE at
/// startup (never in the signal handler) for a human-readable version; elsewhere fall back to the
/// bare target OS constant.
#[cfg(target_os = "macos")]
fn os_string() -> String {
    let ver = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match ver {
        Some(v) => format!("macOS {v}"),
        None => "macOS".to_string(),
    }
}

#[cfg(not(target_os = "macos"))]
fn os_string() -> String {
    std::env::consts::OS.to_string()
}

// ── Recovered-panic suppression ─────────────────────────────────────────────────────────────────
//
// The panic hook runs on the panicking thread BEFORE the unwind reaches any `catch_unwind`. So a
// panic the audio.rs frame firewall is about to catch-and-recover would still make the hook write a
// crash-<uuid>.json record — a false "crash" that, on any consenting mode, gets uploaded even though
// the app never went down. To avoid that, a `catch_unwind` firewall wraps its recoverable region in
// `suppress_crash_records()`: while the returned guard is alive on this thread, the hook still LOGS
// the panic (so the Improvement Agent sees it) but does NOT persist a crash record.

thread_local! {
    static SUPPRESS_CRASH_RECORD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// RAII guard restoring the previous suppression state on drop (so nesting is safe).
pub struct SuppressGuard(bool);

impl Drop for SuppressGuard {
    fn drop(&mut self) {
        SUPPRESS_CRASH_RECORD.with(|c| c.set(self.0));
    }
}

/// While the returned guard is alive on THIS thread, a panic is still logged by the panic hook but
/// does NOT produce a crash-record file. Wrap a `catch_unwind` region that will RECOVER from the
/// panic (e.g. the audio frame firewall) so a recovered panic isn't misreported/uploaded as a crash.
#[must_use]
pub fn suppress_crash_records() -> SuppressGuard {
    let prev = SUPPRESS_CRASH_RECORD.with(|c| c.replace(true));
    SuppressGuard(prev)
}

fn crash_records_suppressed() -> bool {
    SUPPRESS_CRASH_RECORD.with(|c| c.get())
}

// ── Panic hook ────────────────────────────────────────────────────────────────────────────────

/// Install the chained panic hook. Runs in normal (non-signal) context, so heap allocation, tracing,
/// and file I/O are all fine.
fn install_panic_hook(dir: std::path::PathBuf, app_version: String, os: String, arch: String) {
    // Chain to whatever hook is currently installed (Tauri's / the default). Preserves existing
    // behavior — threads still unwind exactly as before; we just observe the panic on the way through.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = panic_payload_string(info);
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        let message = match &location {
            Some(loc) => format!("{payload} (at {loc})"),
            None => payload,
        };
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let crash_id = new_uuid();
        let occurred_at = now_ms_wall();

        // (i) Into the tracing log so the hourly Improvement Agent (which reads the log dir) sees it.
        tracing::error!(
            target: "crash",
            crash_id = %crash_id,
            "PANIC: {message}\n{backtrace}"
        );

        // If a `catch_unwind` firewall on this thread will recover from this panic (e.g. the audio
        // frame handler), LOG it but do NOT persist a crash record — the app isn't going down, so a
        // record here would be a false crash (and, on a consenting mode, a false upload). Still chain
        // to the prior hook to preserve its behavior.
        if crash_records_suppressed() {
            prev(info);
            return;
        }

        // (ii) A structured crash record for flush_crash_reports to (maybe) upload.
        let rec = CrashRecord {
            crash_id,
            kind: "panic".to_string(),
            signal: None,
            message,
            backtrace: Some(backtrace),
            app_version: app_version.clone(),
            os: os.clone(),
            arch: arch.clone(),
            occurred_at,
        };
        if let Err(e) = write_crash_record(&dir, &rec) {
            tracing::error!(target: "crash", "failed to write panic crash record: {e}");
        }

        // Chain: preserve prior hook behavior (Tauri devtools output, default abort-message, etc).
        prev(info);
    }));
}

/// Extract a human-readable message from a panic payload (`&str` or `String`, else a placeholder).
fn panic_payload_string(info: &std::panic::PanicHookInfo<'_>) -> String {
    let p = info.payload();
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "Box<dyn Any> panic payload".to_string()
    }
}

/// Wall-clock epoch milliseconds (panic-context; not signal-safe).
fn now_ms_wall() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Best-effort UUID v4 from `/dev/urandom` (mirrors trial.rs' urandom read). Falls back to a
/// timestamp-derived hex so a crash id is always produced, even if urandom is unavailable.
fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| {
            use std::io::Read;
            f.read_exact(&mut bytes)
        })
        .is_ok();
    if !ok {
        // Deterministic-but-unique fallback: spread the ms clock across the buffer.
        let t = now_ms_wall();
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = ((t >> (i % 8 * 8)) as u8) ^ (i as u8).wrapping_mul(31);
        }
    }
    // RFC 4122 version (4) + variant (10xx) bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Write a crash record atomically (temp-in-same-dir then rename), so a reader never sees a partial
/// file. Named `crash-<crash_id>.json`.
fn write_crash_record(dir: &Path, rec: &CrashRecord) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir crashes: {e}"))?;
    let path = dir.join(format!("crash-{}.json", rec.crash_id));
    let json = serde_json::to_vec_pretty(rec).map_err(|e| format!("serialize crash: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("write crash tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename crash into place: {e}")
    })?;
    // Bound the dir at write time so nothing can accumulate without limit. Panic-context only.
    prune_crashes_dir(dir, MAX_RETAINED_CRASH_FILES);
    Ok(())
}

/// Keep only the newest `keep` crash files (by mtime); delete the older ones. The retention backstop
/// for `MAX_RETAINED_CRASH_FILES`. Panic-context only (does blocking fs I/O) — NEVER call from the
/// signal handler. Best-effort: a failed delete just leaves that file for the next prune.
fn prune_crashes_dir(dir: &Path, keep: usize) {
    // Sweep orphaned temp files: write_crash_record renames `crash-<id>.json.tmp` into place on
    // success, so a leftover `.json.tmp` is only ever the residue of a crash BETWEEN write and rename.
    // AGE-GATED (TMP_ORPHAN_MIN_AGE): the background flush thread can run this concurrently with a
    // panic-hook `write_crash_record` on another thread, so we must NOT delete a tmp that a live write
    // is mid-flight on. A live tmp is milliseconds old and spared; a genuine orphan is minutes old.
    let now = std::time::SystemTime::now();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name();
            let Some(name) = name.to_str() else { continue };
            if !(name.starts_with("crash-") && name.ends_with(".json.tmp")) {
                continue;
            }
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|mt| now.duration_since(mt).ok())
                .is_some_and(|age| age >= TMP_ORPHAN_MIN_AGE);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    for path in list_pending_crashes(dir).into_iter().skip(keep) {
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(target: "crash", "could not prune old crash file {}: {e}", path.display());
        }
    }
}

// ── Native fatal-signal handler (async-signal-safe) ──────────────────────────────────────────────
//
// STRICT rules for `handle_fatal_signal` and everything it calls: NO heap allocation, NO locking, NO
// non-reentrant libc, NO Rust formatting/panic. Only the POSIX async-signal-safe primitives
// (open/write/close/raise/signal/clock_gettime) and pure arithmetic over pre-built buffers.
//
// The trick: at INSTALL time (normal context) we pre-build the whole crash JSON EXCEPT the two parts
// that must be filled in at crash time — the signal NAME (a &'static byte literal, chosen by a match)
// and the occurred_at MILLISECONDS (formatted into a stack buffer with no allocation). The crash file
// path is pre-encoded as a CString. All of that lives behind a OnceLock the handler only *reads*.

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

/// Pre-built, signal-safe pieces of the crash record. Built once at install; the handler only reads.
#[cfg(unix)]
struct SignalTemplate {
    /// NUL-terminated crash file path for `open(2)`.
    path: std::ffi::CString,
    /// JSON up to and including the opening quote of the `"signal":"` value.
    prefix: Vec<u8>,
    /// JSON from the closing quote after the signal name up to (not including) the occurred_at digits.
    mid: Vec<u8>,
}

#[cfg(unix)]
static SIGNAL_TEMPLATE: std::sync::OnceLock<SignalTemplate> = std::sync::OnceLock::new();

/// Single-shot latch so only the FIRST thread to take a fatal signal writes the (single, per-launch)
/// breadcrumb. Two threads crashing near-simultaneously would otherwise both `open(O_TRUNC)` the same
/// path and interleave into a corrupt, unparseable file. Atomic CAS is async-signal-safe.
///
/// INVARIANT: never reset — this is correct ONLY because every signal we register for
/// (SIGSEGV/SIGABRT/SIGBUS/SIGILL) is fatal and the handler always restores `SIG_DFL` and re-raises,
/// so control never returns to normal execution after the latch is set. Do NOT register this handler
/// for a signal the app can recover from without also resetting the latch before re-raise.
#[cfg(unix)]
static SIGNAL_HANDLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Strip anything that would break a raw-embedded JSON string (quotes, backslashes, control chars).
/// The embedded values (app version, OS label, uuid) are already tame; this is belt-and-suspenders so
/// the hand-built signal JSON is always valid without a signal-unsafe escaper.
#[cfg(unix)]
fn json_safe(s: &str) -> String {
    s.chars()
        .filter(|c| *c != '"' && *c != '\\' && !c.is_control())
        .collect()
}

#[cfg(unix)]
fn install_signal_handler(dir: &Path, app_version: &str, os: &str, arch: &str) {
    // A crash id / file path unique to THIS launch. A native crash kills the process, so at most one
    // such file is ever written per run; O_TRUNC in the handler makes a re-entry idempotent.
    let crash_id = new_uuid();
    let path = dir.join(format!("crash-{crash_id}.json"));
    let cpath = match std::ffi::CString::new(path.as_os_str().as_bytes()) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(target: "crash", "crash path had interior NUL, signal capture disabled: {e}");
            return;
        }
    };

    let prefix = format!(
        r#"{{"crash_id":"{}","kind":"signal","signal":""#,
        json_safe(&crash_id)
    )
    .into_bytes();
    let mid = format!(
        r#"","message":"native fatal signal (captured by signal handler; enrich on next launch)","backtrace":null,"app_version":"{}","os":"{}","arch":"{}","occurred_at":"#,
        json_safe(app_version),
        json_safe(os),
        json_safe(arch)
    )
    .into_bytes();

    if SIGNAL_TEMPLATE
        .set(SignalTemplate { path: cpath, prefix, mid })
        .is_err()
    {
        // Already installed (double-call) — leave the first template in place.
        return;
    }

    // Register the handler for the fatal signals a panic hook can't see.
    unsafe {
        // Install an alternate signal stack (SA_ONSTACK) so the handler can still run — and write its
        // breadcrumb — when the crash is a STACK OVERFLOW (a SIGSEGV delivered on an already-exhausted
        // stack, which would otherwise re-fault the moment the handler pushed a frame: exactly the
        // native-crash case this layer exists to catch). The buffer is leaked on purpose: it must live
        // for the whole process. sigaltstack is per-thread; installing it here covers the main thread
        // (the common overflow site). Best-effort — if the alloc/syscall fails we fall back to the
        // normal stack (unchanged from before).
        install_sigaltstack();

        let handler = handle_fatal_signal as extern "C" fn(libc::c_int);
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = handler as libc::sighandler_t;
        libc::sigemptyset(&mut sa.sa_mask);
        sa.sa_flags = libc::SA_ONSTACK;
        for sig in [libc::SIGSEGV, libc::SIGABRT, libc::SIGBUS, libc::SIGILL] {
            libc::sigaction(sig, &sa, std::ptr::null_mut());
        }
    }
}

/// Allocate and register a process-lifetime alternate signal stack for the current thread. Leaked
/// intentionally. No-op (leaves the default stack in place) if allocation or the syscall fails.
#[cfg(unix)]
unsafe fn install_sigaltstack() {
    // Generous fixed size, comfortably above MINSIGSTKSZ; the handler's own frame usage is tiny.
    const ALT_STACK_SIZE: usize = 128 * 1024;
    let mem = libc::malloc(ALT_STACK_SIZE);
    if mem.is_null() {
        return;
    }
    let ss = libc::stack_t {
        ss_sp: mem,
        ss_flags: 0,
        ss_size: ALT_STACK_SIZE,
    };
    libc::sigaltstack(&ss, std::ptr::null_mut());
}

/// Map a signal number to its name as a static byte literal (no allocation).
#[cfg(unix)]
fn sig_name(sig: libc::c_int) -> &'static [u8] {
    match sig {
        libc::SIGSEGV => b"SIGSEGV",
        libc::SIGABRT => b"SIGABRT",
        libc::SIGBUS => b"SIGBUS",
        libc::SIGILL => b"SIGILL",
        _ => b"UNKNOWN",
    }
}

/// Async-signal-safe write of the whole buffer (loops over partial writes). Bails on any error — a
/// truncated file just fails to parse on next launch and is skipped, which is acceptable.
#[cfg(unix)]
unsafe fn sig_write(fd: libc::c_int, mut buf: &[u8]) {
    while !buf.is_empty() {
        let n = libc::write(fd, buf.as_ptr() as *const libc::c_void, buf.len());
        if n <= 0 {
            break;
        }
        buf = &buf[n as usize..];
    }
}

/// Async-signal-safe epoch milliseconds via `clock_gettime` (which is on the POSIX safe list).
#[cfg(unix)]
unsafe fn now_ms_signal_safe() -> u64 {
    let mut ts: libc::timespec = std::mem::zeroed();
    if libc::clock_gettime(libc::CLOCK_REALTIME, &mut ts) == 0 {
        (ts.tv_sec as u64) * 1000 + (ts.tv_nsec as u64) / 1_000_000
    } else {
        0
    }
}

/// Format a u64 as decimal into `buf`, returning the used tail slice. Pure arithmetic — no alloc, so
/// it is signal-safe. `buf` is 20 bytes, enough for any u64.
#[cfg(unix)]
fn fmt_u64(mut v: u64, buf: &mut [u8; 20]) -> &[u8] {
    let mut i = buf.len();
    if v == 0 {
        i -= 1;
        buf[i] = b'0';
        return &buf[i..];
    }
    while v > 0 {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    &buf[i..]
}

/// The fatal-signal handler. See the module-level async-signal-safety rules — everything here is
/// either a POSIX async-signal-safe primitive or pure arithmetic over the pre-built template.
#[cfg(unix)]
extern "C" fn handle_fatal_signal(sig: libc::c_int) {
    unsafe {
        // Only the FIRST thread into the handler writes the breadcrumb; a concurrent second fatal
        // signal skips the write (its data would interleave into the same O_TRUNC file) but still
        // restores the default disposition and re-raises below, so it crashes normally.
        let first = SIGNAL_HANDLED
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok();
        if first {
            if let Some(t) = SIGNAL_TEMPLATE.get() {
                let fd = libc::open(
                    t.path.as_ptr(),
                    libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
                    0o600,
                );
                if fd >= 0 {
                    sig_write(fd, &t.prefix);
                    sig_write(fd, sig_name(sig));
                    sig_write(fd, &t.mid);
                    let mut buf = [0u8; 20];
                    let ms = now_ms_signal_safe();
                    sig_write(fd, fmt_u64(ms, &mut buf));
                    sig_write(fd, b"}");
                    libc::close(fd);
                }
            }
        }
        // Restore the default disposition and re-raise so the process still crashes normally
        // (and any OS crash reporter still fires). We do NOT swallow the signal.
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

// ── Flush: scan crashes dir, redact, upload (on any consenting mode) ─────────────────────────────
//
// TWO TIERS, and the difference between them is real — keep it that way:
//
//   "never"        → nothing is uploaded. Reports stay on the user's disk. No keychain read, no
//                    Authorization header — a "never" user emits nothing at all.
//   "case_by_case" → the crash REPORT ONLY: redacted message + backtrace, install_id, app_version,
//                    os, arch, timestamps, plus the BUILD PROVENANCE (`build_channel` =
//                    dev/local/release and `git_sha`, both compile-time constants of the binary —
//                    they describe the build, not the user). And, WHEN THE USER IS SIGNED IN, the
//                    request carries an `Authorization: Bearer <desktop token>` header, so the
//                    report is attributable to that Sparkle account; signed-out/trial users send no
//                    header and stay anonymous (install_id only). NO recent-logs tail.
//   "always"       → all of the above PLUS the redacted ~200KB recent-logs tail.
//
// Why "case_by_case" uploads at all: it is the DEFAULT (settingsStore.ts `DEFAULT_SPARKLE_CONSENT`),
// and an always-only upload gate meant the crash pipeline received nothing from anyone who never
// changed the default — i.e. essentially everyone. Capture worked; we were simply blind.
//
// The user-facing promise for each tier is the copy in SparkleConsentBanner.tsx `consentCopy()`.
// These two predicates and that copy are one contract: if you change a gate here, change that copy
// (and its test) in the same commit. The copy drifting out of sync with this gate is exactly the bug
// that made this pipeline dark.

/// Whether this consent value permits uploading a crash report at all.
///
/// FAILS CLOSED, and deliberately: only the two exactly-spelled consenting modes match. An unknown,
/// empty, or miscased value (a future/renamed mode, a corrupt persisted blob, a frontend typo) is
/// NOT consent and must never be treated as such — silence is the safe failure here, an unintended
/// upload is not. The comparison is case-SENSITIVE for the same reason: "Always" is not a value this
/// app writes, so seeing one means something is wrong, not that the user opted in.
fn upload_allowed(consent: &str) -> bool {
    matches!(consent, "always" | "case_by_case")
}

/// Whether this consent value additionally permits attaching the recent-logs tail. "always" ONLY —
/// this is the privacy line between the two consenting tiers, and the promise the banner copy makes.
fn logs_allowed(consent: &str) -> bool {
    consent == "always"
}

/// Resolve the desktop bearer token for a flush — but ONLY when the consent value permits uploading
/// at all. A non-consenting value never even calls `read`, so a "never" user performs no keychain
/// read (and therefore never triggers a macOS keychain prompt) for a flush that would upload nothing.
///
/// `read` is injected so the invariant is unit-testable without a keychain: production passes
/// `crate::auth::token`, which reads the item in-process via the `keyring` crate.
fn resolve_upload_token<F: FnOnce() -> Option<String>>(consent: &str, read: F) -> Option<String> {
    if upload_allowed(consent) {
        read()
    } else {
        None
    }
}

/// Build the `/telemetry/crash` upload body for a record. Applies `redact_secrets` to the (possibly
/// secret-bearing) message + backtrace; `recent_logs` is already redacted by the caller. `install_id`
/// is the anonymous 32-hex key from trial.rs. `build_channel` / `git_sha` describe the BINARY (see
/// the build-provenance section): they let a crash from a dev/local build be told apart from one in
/// an officially shipped release. `git_sha` is null when CI didn't stamp one in.
fn build_upload_body(rec: &CrashRecord, install_id: &str, recent_logs: &str) -> String {
    json!({
        "install_id": install_id,
        "build_channel": build_channel(),
        "git_sha": git_sha(),
        "crash_id": rec.crash_id,
        "kind": rec.kind,
        "signal": rec.signal,
        "message": redact_secrets(&rec.message),
        "backtrace": rec.backtrace.as_deref().map(redact_secrets),
        "app_version": rec.app_version,
        "os": rec.os,
        "arch": rec.arch,
        "occurred_at": rec.occurred_at,
        "recent_logs": recent_logs,
    })
    .to_string()
}

/// List pending `crash-*.json` files, newest first (by mtime).
fn list_pending_crashes(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if !(name.starts_with("crash-") && name.ends_with(".json")) {
            continue;
        }
        let mtime = e
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        files.push((e.path(), mtime));
    }
    // Newest first.
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.into_iter().map(|(p, _)| p).collect()
}

/// Core flush logic, factored out of the Tauri command so it unit-tests without a Tauri runtime.
///
/// `post` is called with `(body, bearer_token)` and returns true on a 2xx. When the consent value is
/// not a consenting mode (`upload_allowed`
/// is false — "never", or any unrecognized value, which fails closed) NOTHING is uploaded and
/// NOTHING is deleted (`post` is never called) — the reports are left on disk. On a 2xx the local
/// file is deleted so it isn't re-uploaded. Returns the number of reports successfully uploaded.
///
/// `recent_logs` arrives already redacted from the caller, which also declines to even READ the log
/// tail unless `logs_allowed` (so a non-"always" flush touches no logs at all). We nonetheless
/// re-apply `logs_allowed` here rather than trusting the argument: this is the function the tests
/// pin the privacy line against, so the "case_by_case sends no logs" invariant is enforced at the
/// same place the body is built, and a future caller can't quietly leak a tail past it.
///
/// `token` is the signed-in user's desktop bearer token (None when signed out / on a trial), already
/// resolved once by the caller inside its own consent gate (`resolve_upload_token`). It is threaded
/// to `post` only past the gate below, so a non-consenting flush can never attach one.
fn flush_pending<P: Fn(&str, Option<&str>) -> bool>(
    crashes_dir: &Path,
    install_id: &str,
    recent_logs: &str,
    consent: &str,
    token: Option<&str>,
    post: P,
    max_uploads: usize,
) -> usize {
    // Bound the dir on every flush, BEFORE the consent gate — so a host that never becomes reachable
    // (the user consents but uploads keep failing) or a user who never consents (uploads never
    // happen at all) still can't let the crashes dir grow without limit across launches. Retention is
    // a local-disk concern and is deliberately independent of consent: do NOT move this below the
    // gate, or a "never" user's crashes dir grows forever.
    prune_crashes_dir(crashes_dir, MAX_RETAINED_CRASH_FILES);

    let pending = list_pending_crashes(crashes_dir);
    if pending.is_empty() {
        return 0;
    }

    // Consent gate: capture is always-on, but upload requires a consenting mode ("always" or the
    // default "case_by_case"). Anything else — "never", or an unrecognized value, which fails closed
    // — leaves everything on disk.
    if !upload_allowed(consent) {
        tracing::info!(
            target: "crash",
            count = pending.len(),
            consent = %consent,
            "crash reports pending but consent does not permit upload; leaving them local"
        );
        return 0;
    }

    // The privacy line between the two consenting tiers: the recent-logs tail is "always"-only.
    let recent_logs = if logs_allowed(consent) { recent_logs } else { "" };

    // Same belt-and-suspenders for the signed-in identity: the bearer token rides along ONLY on a
    // consenting flush. We already returned above for a non-consenting value, so this is a backstop
    // that keeps the invariant stated right where the request is built.
    let token = if upload_allowed(consent) { token } else { None };

    let total = pending.len();
    let mut uploaded = 0usize;
    for path in pending.into_iter().take(max_uploads) {
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(target: "crash", "could not read crash file {}: {e}", path.display());
                continue;
            }
        };
        let rec: CrashRecord = match serde_json::from_slice(&bytes) {
            Ok(r) => r,
            Err(e) => {
                // A truncated/partial signal breadcrumb — leave it; a future launch may still parse
                // a complete one. (These are tiny; a stray unparseable file is harmless.)
                tracing::warn!(target: "crash", "skipping unparseable crash file {}: {e}", path.display());
                continue;
            }
        };
        let body = build_upload_body(&rec, install_id, recent_logs);
        if post(&body, token) {
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    uploaded += 1;
                    tracing::info!(target: "crash", crash_id = %rec.crash_id, "uploaded + removed crash report");
                }
                Err(e) => {
                    // Uploaded but couldn't delete: count it (the server dedupes on crash_id).
                    uploaded += 1;
                    tracing::warn!(target: "crash", "uploaded crash {} but could not delete file: {e}", rec.crash_id);
                }
            }
        } else {
            tracing::warn!(target: "crash", crash_id = %rec.crash_id, "crash upload failed; leaving file for next launch");
        }
    }

    if total > max_uploads {
        tracing::info!(
            target: "crash",
            skipped = total - max_uploads,
            "capped crash upload; older reports left for a future flush"
        );
    }
    uploaded
}

/// The `Authorization` header value for a bearer token, or None when there is nothing usable to send
/// (signed out, or an empty/whitespace-only token). Pure, so the exact header the POST would carry is
/// assertable in a unit test without standing up an HTTP server.
fn authorization_header(bearer: Option<&str>) -> Option<String> {
    bearer
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| format!("Bearer {t}"))
}

/// POST one crash body to the orchestration ingest. Returns true on a 2xx. ureq maps 4xx/5xx to
/// `Err(Error::Status(..))`, so `Ok(_)` already means a 2xx. Matches support.rs: ureq without the
/// `json` feature → serde_json + send_string.
///
/// `bearer` attaches `Authorization: Bearer <desktop token>` so the server can attribute the crash
/// to a Sparkle account. It is OPTIONAL and absent is the normal case (signed-out / trial): with no
/// token we send exactly the request we always did, and the report stays anonymous (install_id only).
fn post_crash(url: &str, body: &str, bearer: Option<&str>) -> bool {
    let mut req = ureq::post(url)
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json");
    if let Some(v) = authorization_header(bearer) {
        req = req.set("Authorization", &v);
    }
    match req.send_string(body) {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!(target: "crash", "POST {url} failed: {e}");
            false
        }
    }
}

/// Tauri command: flush pending crash reports. Called fire-and-forget at launch with the CURRENT
/// consent value; the consent gate is ENFORCED in Rust (`run_flush` → `flush_pending`).
///
/// The work — an fs scan plus up to `MAX_UPLOADS_PER_FLUSH` blocking `ureq` POSTs at 30s each (worst
/// case ~600s against an unreachable host) — runs on a DETACHED BACKGROUND THREAD. A sync Tauri
/// command body executes on the main thread, so doing the blocking I/O inline would jank or freeze
/// the UI at startup even though the frontend calls this "fire-and-forget". The command therefore
/// spawns the thread and returns immediately; the result is logged, not returned.
#[tauri::command]
pub fn flush_crash_reports<R: Runtime>(app: AppHandle<R>, consent: String) {
    std::thread::spawn(move || match run_flush(&app, &consent) {
        Ok(0) => {}
        Ok(n) => tracing::info!(target: "crash", uploaded = n, "flushed crash reports"),
        Err(e) => tracing::warn!(target: "crash", "crash flush failed: {e}"),
    });
}

/// The blocking flush body, factored out of the command so it runs off the main thread. Scans the
/// crashes dir, resolves the anonymous install id (plus, on a consenting flush only, the signed-in
/// desktop token), attaches a redacted recent-log window (only when uploading), and delegates the
/// consent gate + POST loop to `flush_pending`. Returns how many reports were uploaded.
fn run_flush<R: Runtime>(app: &AppHandle<R>, consent: &str) -> Result<usize, String> {
    let log_dir = crate::dev_identity::app_log_dir(app)?;
    let crashes_dir = log_dir.join("crashes");
    if !crashes_dir.exists() {
        return Ok(0);
    }

    // Anonymous key (same 32-hex install id usageTelemetry sends).
    let data_dir = crate::dev_identity::app_data_dir(app)?;
    let install_id = crate::trial::ensure_install_id_at(&data_dir.join("trial.json"))?.install_id;

    // The recent-log window rides along on "always" ONLY (`logs_allowed`) — on "case_by_case" we
    // upload the crash report without it, so don't even read it. read_recent_logs returns the ~200KB
    // tail ALREADY REDACTED. flush_pending re-applies the same gate as a backstop.
    let recent_logs = if logs_allowed(consent) {
        // `read_recent_logs` is now an async Tauri command; run_flush is sync on its own thread, so
        // call the shared blocking core directly instead of awaiting the command.
        crate::support::read_recent_logs_sync(app).unwrap_or_default()
    } else {
        String::new()
    };

    // Signed-in identity, resolved ONCE per flush (not per report) and STRICTLY inside the consent
    // gate: `resolve_upload_token` doesn't call `auth::token` at all unless `upload_allowed`, so a
    // "never" user performs no keychain read and sends no Authorization header. `auth::token` reads
    // the keychain in-process via the `keyring` crate — never shell out to the `security` CLI.
    let token = resolve_upload_token(consent, crate::auth::token);

    let url = format!("{}/telemetry/crash", orchestration_base_url());
    Ok(flush_pending(
        &crashes_dir,
        &install_id,
        &recent_logs,
        consent,
        token.as_deref(),
        |body, bearer| post_crash(&url, body, bearer),
        MAX_UPLOADS_PER_FLUSH,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!("sparkle-crash-test-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample_record(crash_id: &str, message: &str, backtrace: Option<&str>) -> CrashRecord {
        CrashRecord {
            crash_id: crash_id.to_string(),
            kind: "panic".to_string(),
            signal: None,
            message: message.to_string(),
            backtrace: backtrace.map(|s| s.to_string()),
            app_version: "0.18.0".to_string(),
            os: "macOS 15.5".to_string(),
            arch: "aarch64".to_string(),
            occurred_at: 1_700_000_000_000,
        }
    }

    /// A recording fake for `flush_pending`'s `post`: captures the body AND the bearer token of every
    /// attempted upload, so tests can assert on the Authorization header, not just the payload.
    #[derive(Default)]
    struct Posted {
        calls: std::cell::RefCell<Vec<(String, Option<String>)>>,
    }

    impl Posted {
        fn recorder(&self, ack: bool) -> impl Fn(&str, Option<&str>) -> bool + '_ {
            move |body, bearer| {
                self.calls
                    .borrow_mut()
                    .push((body.to_string(), bearer.map(|t| t.to_string())));
                ack
            }
        }
        fn len(&self) -> usize {
            self.calls.borrow().len()
        }
        fn body(&self, i: usize) -> String {
            self.calls.borrow()[i].0.clone()
        }
        fn json(&self, i: usize) -> serde_json::Value {
            serde_json::from_str(&self.body(i)).unwrap()
        }
        /// The `Authorization` value `post_crash` would actually send for call `i` (None = no header),
        /// derived through the SAME production helper the real POST uses.
        fn auth_header(&self, i: usize) -> Option<String> {
            authorization_header(self.calls.borrow()[i].1.as_deref())
        }
    }

    #[test]
    fn upload_body_redacts_message_and_backtrace() {
        // Secret-SHAPED values assembled at runtime so no literal secret appears in source (keeps the
        // public-mirror leak gate strict), mirroring support.rs' fixture style.
        let secret = format!("{}super-secret-value-1234567890", "sk-");
        let msg = format!("panicked while calling api with {secret}");
        let bt = format!("at auth.rs\nAuthorization: Bearer eyJabc.def.ghi tok\n{secret}");
        let rec = sample_record("id-1", &msg, Some(&bt));

        let body = build_upload_body(&rec, "install123", "recent log line");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();

        // The sk- secret must not survive in either field.
        let out_msg = v["message"].as_str().unwrap();
        let out_bt = v["backtrace"].as_str().unwrap();
        assert!(!out_msg.contains(&secret), "message not redacted: {out_msg}");
        assert!(!out_bt.contains(&secret), "backtrace not redacted: {out_bt}");
        assert!(!out_bt.contains("eyJabc"), "bearer token survived: {out_bt}");
        // The wire fields the server contract requires are all present.
        assert_eq!(v["install_id"], "install123");
        assert_eq!(v["crash_id"], "id-1");
        assert_eq!(v["kind"], "panic");
        assert!(v["signal"].is_null());
        assert_eq!(v["app_version"], "0.18.0");
        assert_eq!(v["os"], "macOS 15.5");
        assert_eq!(v["arch"], "aarch64");
        assert_eq!(v["occurred_at"], 1_700_000_000_000u64);
        assert_eq!(v["recent_logs"], "recent log line");
    }

    // ── Build provenance ────────────────────────────────────────────────────────────────────────

    #[test]
    fn upload_body_carries_a_legal_build_channel() {
        let rec = sample_record("bc", "boom", None);
        let v: serde_json::Value =
            serde_json::from_str(&build_upload_body(&rec, "iid", "")).unwrap();

        let channel = v["build_channel"]
            .as_str()
            .expect("build_channel must be a string on every crash upload");
        assert!(
            matches!(channel, "dev" | "local" | "release"),
            "build_channel must be one of dev/local/release, got {channel:?}"
        );
        assert_eq!(channel, build_channel(), "body must carry the derived channel verbatim");
    }

    /// `cargo test` is a debug build, so this pins the `debug_assertions` branch: the founder's own
    /// `cargo tauri dev` crashes report as "dev", never as a shipped release. The release/local split
    /// is pinned by `build_channel_release_local_split_follows_official_build_env` below.
    #[test]
    #[cfg(debug_assertions)]
    fn build_channel_is_dev_in_a_debug_build() {
        assert_eq!(build_channel(), "dev");
    }

    #[test]
    fn build_channel_release_local_split_follows_official_build_env() {
        // The release/local split is a COMPILE-time decision (option_env!), so we can't flip it at
        // runtime — but we can pin the rule it implements against the value this binary was built
        // with, which is exactly what CI would be setting.
        let official = option_env!("SPARKLE_OFFICIAL_BUILD").is_some_and(|v| !v.trim().is_empty());
        let expected = if cfg!(debug_assertions) {
            "dev"
        } else if official {
            "release"
        } else {
            "local"
        };
        assert_eq!(build_channel(), expected);
    }

    #[test]
    fn git_sha_field_is_always_present_and_null_when_unstamped() {
        let rec = sample_record("sha", "boom", None);
        let body = build_upload_body(&rec, "iid", "");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();

        // The key is ALWAYS emitted (the server reads it as optional); its value is null when CI
        // didn't stamp a sha in — which is the case for an ordinary `cargo test` build.
        assert!(
            v.as_object().unwrap().contains_key("git_sha"),
            "git_sha must be part of the wire contract: {body}"
        );
        match git_sha() {
            None => assert!(v["git_sha"].is_null(), "unstamped build must send git_sha: null"),
            Some(sha) => {
                assert_eq!(v["git_sha"], sha);
                assert!(sha.len() <= MAX_GIT_SHA_LEN, "git_sha must be truncated to 40 chars");
            }
        }
        // SPARKLE_GIT_SHA is not set for a plain test build, so we expect the unstamped shape here.
        assert!(
            option_env!("SPARKLE_GIT_SHA").is_some() || v["git_sha"].is_null(),
            "git_sha must be null when SPARKLE_GIT_SHA is unset"
        );
    }

    #[test]
    fn a_non_hex_sha_never_reaches_the_wire() {
        // build.rs emits the literal "unknown" when git is unavailable (a tarball build), and
        // bridge.rs legitimately shows that string — but it is not a sha, and the server rejects a
        // non-hex value. If it ever reached the wire it would cost us the WHOLE crash report.
        assert!(!is_hex_sha("unknown"));
        assert!(!is_hex_sha(""));
        assert!(!is_hex_sha("not-a-sha"));
        assert!(!is_hex_sha("deadbeefZ"));
        // Real shas, short and full, in either case.
        assert!(is_hex_sha("d4bd221d"));
        assert!(is_hex_sha("0123456789abcdef0123456789abcdef01234567"));
        assert!(is_hex_sha("ABCDEF0123"));
    }

    #[test]
    fn normalize_git_sha_trims_drops_empty_and_bounds_length() {
        let full = "0123456789abcdef0123456789abcdef01234567"; // exactly 40 hex chars
        assert_eq!(full.len(), MAX_GIT_SHA_LEN);
        assert_eq!(normalize_git_sha(full), Some(full));
        assert_eq!(normalize_git_sha("  abc123  "), Some("abc123"));

        // Nothing usable → absent, so the wire field is null rather than an empty string.
        assert_eq!(normalize_git_sha(""), None);
        assert_eq!(normalize_git_sha("   \n\t "), None);

        // Over-long values are bounded (a mis-set env var, not an expected path).
        let long = format!("{full}deadbeef");
        assert_eq!(normalize_git_sha(&long), Some(full));

        // A non-ASCII value must still be bounded to <= MAX_GIT_SHA_LEN *bytes* and must not panic on
        // a char boundary: 3-byte chars mean the cut lands at byte 39, not 40.
        let multibyte = "é".repeat(40); // 2 bytes each = 80 bytes
        let out = normalize_git_sha(&multibyte).unwrap();
        assert!(out.len() <= MAX_GIT_SHA_LEN, "non-ASCII sha not bounded: {} bytes", out.len());
        let wide = "☃".repeat(20); // 3 bytes each = 60 bytes; 40 is NOT a char boundary
        let out = normalize_git_sha(&wide).unwrap();
        assert_eq!(out.len(), 39, "must cut at the largest char boundary at or below the cap");
    }

    // ── Authorization header ────────────────────────────────────────────────────────────────────

    #[test]
    fn authorization_header_is_bearer_or_absent() {
        assert_eq!(authorization_header(Some("tok-123")), Some("Bearer tok-123".to_string()));
        assert_eq!(authorization_header(Some("  tok-123  ")), Some("Bearer tok-123".to_string()));
        // Nothing usable → NO header at all (rather than a malformed empty bearer).
        assert_eq!(authorization_header(None), None);
        assert_eq!(authorization_header(Some("")), None);
        assert_eq!(authorization_header(Some("   ")), None);
    }

    #[test]
    fn flush_sends_no_authorization_header_when_signed_out() {
        // The NORMAL case (signed out / trial): upload exactly as before, anonymous via install_id.
        let dir = tmp_dir();
        write_crash_record(&dir, &sample_record("anon", "boom", None)).unwrap();

        let posted = Posted::default();
        let uploaded = flush_pending(
            &dir,
            "iid",
            "logs",
            "always",
            None,
            posted.recorder(true),
            MAX_UPLOADS_PER_FLUSH,
        );

        assert_eq!(uploaded, 1);
        assert_eq!(posted.len(), 1);
        assert_eq!(posted.auth_header(0), None, "signed-out flush must send no Authorization header");
        assert_eq!(posted.json(0)["install_id"], "iid");
    }

    #[test]
    fn flush_sends_bearer_authorization_header_when_signed_in() {
        let dir = tmp_dir();
        write_crash_record(&dir, &sample_record("s1", "boom", None)).unwrap();
        write_crash_record(&dir, &sample_record("s2", "boom", None)).unwrap();

        let posted = Posted::default();
        let uploaded = flush_pending(
            &dir,
            "iid",
            "logs",
            "case_by_case",
            Some("desktop-token-abc"),
            posted.recorder(true),
            MAX_UPLOADS_PER_FLUSH,
        );

        assert_eq!(uploaded, 2);
        assert_eq!(posted.len(), 2);
        // The same token rides on EVERY report of the flush (resolved once, not per report).
        for i in 0..2 {
            assert_eq!(
                posted.auth_header(i),
                Some("Bearer desktop-token-abc".to_string()),
                "signed-in flush must attach the bearer header on report {i}"
            );
        }
        // The token is a HEADER only — it must never end up in the JSON body.
        assert!(
            !posted.body(0).contains("desktop-token-abc"),
            "the desktop token must not be written into the upload body: {}",
            posted.body(0)
        );
    }

    #[test]
    fn never_consent_reads_no_token_and_posts_nothing() {
        // The strongest form of the privacy line: a non-consenting user must not even trigger a
        // keychain read, let alone an upload. `resolve_upload_token` is the gate that guarantees it.
        for consent in ["never", "", "Always", "sometimes"] {
            let read = std::cell::Cell::new(0);
            let token = resolve_upload_token(consent, || {
                read.set(read.get() + 1);
                Some("should-never-be-read".to_string())
            });
            assert_eq!(read.get(), 0, "keychain was read despite consent={consent:?}");
            assert!(token.is_none(), "token resolved despite consent={consent:?}");
        }
        // …and a consenting mode DOES read it, exactly once.
        for consent in ["always", "case_by_case"] {
            let read = std::cell::Cell::new(0);
            let token = resolve_upload_token(consent, || {
                read.set(read.get() + 1);
                Some("tok".to_string())
            });
            assert_eq!(read.get(), 1, "consenting flush must read the token once");
            assert_eq!(token.as_deref(), Some("tok"));
        }

        // End to end through flush_pending: a "never" flush attempts no POST even if a token were
        // somehow handed to it.
        let dir = tmp_dir();
        write_crash_record(&dir, &sample_record("nv", "boom", None)).unwrap();
        let posted = Posted::default();
        let uploaded = flush_pending(
            &dir,
            "iid",
            "logs",
            "never",
            Some("leaked-token"),
            posted.recorder(true),
            MAX_UPLOADS_PER_FLUSH,
        );
        assert_eq!(uploaded, 0);
        assert_eq!(posted.len(), 0, "a never-consent flush must perform no upload at all");
        assert!(dir.join("crash-nv.json").exists(), "the report stays on disk");
    }

    #[test]
    fn null_backtrace_serializes_as_null() {
        let rec = sample_record("id-2", "boom", None);
        let body = build_upload_body(&rec, "iid", "");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(v["backtrace"].is_null());
    }

    #[test]
    fn flush_does_not_upload_without_a_consenting_mode() {
        let dir = tmp_dir();
        write_crash_record(&dir, &sample_record("keep-me", "boom", None)).unwrap();

        // "never" is the explicit opt-out. The rest pin FAIL-CLOSED behavior: an empty value, a
        // miscased one ("Always" / "Case_By_Case" are not values this app writes — a match here would
        // be a bug, not consent), an unknown/future mode, and a whitespace-padded value must all
        // upload NOTHING. An unrecognized value is never consent.
        for consent in [
            "never",
            "",
            "Always",
            "ALWAYS",
            "Case_By_Case",
            "case-by-case",
            "sometimes",
            " always ",
        ] {
            let posted = std::cell::Cell::new(false);
            let uploaded = flush_pending(
                &dir,
                "iid",
                "logs",
                consent,
                Some("desktop-token"),
                |_body, _bearer| {
                    posted.set(true); // must NEVER fire for a non-consenting value
                    true
                },
                MAX_UPLOADS_PER_FLUSH,
            );
            assert_eq!(uploaded, 0, "uploaded despite consent={consent:?}");
            assert!(!posted.get(), "POST attempted despite consent={consent:?}");
        }
        // The report is still on disk (nothing deleted).
        assert!(dir.join("crash-keep-me.json").exists(), "file was deleted without consent");
    }

    #[test]
    fn consent_predicates_recognize_only_exact_modes() {
        // The gate in one place: what may upload, and what may attach logs.
        assert!(upload_allowed("always"));
        assert!(upload_allowed("case_by_case")); // the DEFAULT mode uploads — this is the fix.
        assert!(!upload_allowed("never"));
        assert!(logs_allowed("always"));
        assert!(!logs_allowed("case_by_case")); // the privacy line between the consenting tiers.
        assert!(!logs_allowed("never"));
        // Fail closed on anything not exactly spelled.
        for bogus in ["", "Always", "CASE_BY_CASE", "case by case", "sometimes", " always"] {
            assert!(!upload_allowed(bogus), "upload_allowed({bogus:?}) must fail closed");
            assert!(!logs_allowed(bogus), "logs_allowed({bogus:?}) must fail closed");
        }
    }

    #[test]
    fn flush_uploads_report_without_logs_on_case_by_case() {
        // The DEFAULT mode. It MUST upload (an always-only gate is what kept this pipeline dark), but
        // it must NOT carry the recent-logs tail — that is the "always"-only tier, and the banner copy
        // promises exactly this split.
        let dir = tmp_dir();
        write_crash_record(&dir, &sample_record("cbc", "boom-cbc", Some("bt-cbc"))).unwrap();

        let posted = Posted::default();
        let uploaded = flush_pending(
            &dir,
            "iid",
            "SECRET-LOG-TAIL-should-not-be-sent",
            "case_by_case",
            None,
            posted.recorder(true),
            MAX_UPLOADS_PER_FLUSH,
        );

        assert_eq!(uploaded, 1, "case_by_case must upload the crash report");
        assert_eq!(posted.len(), 1);
        let v = posted.json(0);
        // No log tail — the field is present (the server contract wants it) but empty, and the tail
        // text appears nowhere in the body.
        assert_eq!(v["recent_logs"], "", "case_by_case must not send the recent-logs tail");
        assert!(
            !posted.body(0).contains("SECRET-LOG-TAIL"),
            "log tail leaked into a case_by_case upload: {}",
            posted.body(0)
        );
        // The report itself IS sent: the crash fields the server needs are all there.
        assert_eq!(v["crash_id"], "cbc");
        assert_eq!(v["install_id"], "iid");
        assert_eq!(v["message"], "boom-cbc");
        assert_eq!(v["backtrace"], "bt-cbc");
        assert_eq!(v["app_version"], "0.18.0");
        assert_eq!(v["os"], "macOS 15.5");
        assert_eq!(v["arch"], "aarch64");
        assert_eq!(v["occurred_at"], 1_700_000_000_000u64);
        // Acknowledged reports are deleted so they aren't re-sent next launch.
        assert!(!dir.join("crash-cbc.json").exists());
    }

    #[test]
    fn flush_uploads_report_with_logs_on_always() {
        let dir = tmp_dir();
        write_crash_record(&dir, &sample_record("alw", "boom-alw", None)).unwrap();

        let posted = Posted::default();
        let uploaded = flush_pending(
            &dir,
            "iid",
            "recent log tail here",
            "always",
            None,
            posted.recorder(true),
            MAX_UPLOADS_PER_FLUSH,
        );

        assert_eq!(uploaded, 1);
        let v = posted.json(0);
        assert_eq!(v["crash_id"], "alw");
        assert_eq!(
            v["recent_logs"], "recent log tail here",
            "always must send the recent-logs tail"
        );
    }

    #[test]
    fn flush_prunes_crashes_dir_regardless_of_consent() {
        // Retention is a LOCAL-DISK concern and runs BEFORE the consent gate on purpose: a "never"
        // user (who never uploads, so files are never deleted by a 2xx) must still have a bounded
        // crashes dir. This pins that ordering.
        for consent in ["never", "", "case_by_case", "always"] {
            let dir = tmp_dir();
            for i in 0..(MAX_RETAINED_CRASH_FILES + 8) {
                write_crash_record(&dir, &sample_record(&format!("x{i}"), "boom", None)).unwrap();
            }
            // Never acknowledge, so nothing is deleted by an upload — only prune can bound the dir.
            flush_pending(&dir, "iid", "logs", consent, None, |_b, _t| false, MAX_UPLOADS_PER_FLUSH);
            assert!(
                list_pending_crashes(&dir).len() <= MAX_RETAINED_CRASH_FILES,
                "crashes dir unbounded at consent={consent:?}"
            );
        }
    }

    #[test]
    fn flush_uploads_and_deletes_on_success_when_always() {
        let dir = tmp_dir();
        write_crash_record(&dir, &sample_record("a", "boom-a", None)).unwrap();
        write_crash_record(&dir, &sample_record("b", "boom-b", None)).unwrap();

        let count = std::cell::Cell::new(0);
        let uploaded = flush_pending(
            &dir,
            "iid",
            "logs",
            "always",
            None,
            |_body, _bearer| {
                count.set(count.get() + 1);
                true
            },
            MAX_UPLOADS_PER_FLUSH,
        );
        assert_eq!(uploaded, 2);
        assert_eq!(count.get(), 2, "post should be called once per report");
        // Both files removed after a successful upload.
        assert!(!dir.join("crash-a.json").exists());
        assert!(!dir.join("crash-b.json").exists());
    }

    #[test]
    fn flush_leaves_file_when_upload_fails() {
        let dir = tmp_dir();
        write_crash_record(&dir, &sample_record("fail", "boom", None)).unwrap();
        let uploaded =
            flush_pending(&dir, "iid", "logs", "always", None, |_b, _t| false, MAX_UPLOADS_PER_FLUSH);
        assert_eq!(uploaded, 0);
        // A failed POST must leave the file for the next launch.
        assert!(dir.join("crash-fail.json").exists());
    }

    #[test]
    fn flush_caps_number_uploaded_per_flush() {
        let dir = tmp_dir();
        for i in 0..5 {
            write_crash_record(&dir, &sample_record(&format!("c{i}"), "boom", None)).unwrap();
        }
        let uploaded = flush_pending(&dir, "iid", "logs", "always", None, |_b, _t| true, 2);
        // Capped at 2 even though 5 are pending.
        assert_eq!(uploaded, 2);
        // 3 remain on disk for a future flush.
        let remaining = list_pending_crashes(&dir).len();
        assert_eq!(remaining, 3);
    }

    #[test]
    fn record_round_trips_through_disk() {
        let dir = tmp_dir();
        let rec = sample_record("rt", "message here", Some("bt here"));
        write_crash_record(&dir, &rec).unwrap();
        let bytes = std::fs::read(dir.join("crash-rt.json")).unwrap();
        let back: CrashRecord = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.crash_id, "rt");
        assert_eq!(back.kind, "panic");
        assert_eq!(back.message, "message here");
        assert_eq!(back.backtrace.as_deref(), Some("bt here"));
    }

    #[test]
    fn write_crash_record_prunes_to_retention_cap() {
        let dir = tmp_dir();
        // Write well past the cap; each write prunes, so the dir is bounded at all times.
        for i in 0..(MAX_RETAINED_CRASH_FILES + 12) {
            write_crash_record(&dir, &sample_record(&format!("r{i}"), "boom", None)).unwrap();
        }
        assert_eq!(
            list_pending_crashes(&dir).len(),
            MAX_RETAINED_CRASH_FILES,
            "crashes dir must be bounded to the retention cap"
        );
    }

    #[test]
    fn prune_crashes_dir_keeps_newest_n() {
        let dir = tmp_dir();
        // Stamp EXPLICIT, distinct, increasing mtimes: a tight write loop can collide at FS mtime
        // granularity, and with equal keys `sort_by` preserves read_dir order — so a count-only
        // assertion would pass even if prune dropped the newest files. Setting mtimes makes "newest"
        // unambiguous and lets us assert the exact survivors.
        let base = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        for i in 0..10u64 {
            let id = format!("p{i}");
            write_crash_record(&dir, &sample_record(&id, "boom", None)).unwrap();
            let f = std::fs::OpenOptions::new()
                .write(true)
                .open(dir.join(format!("crash-{id}.json")))
                .unwrap();
            f.set_modified(base + std::time::Duration::from_secs(i)).unwrap();
        }
        // Keep the newest 4 → p6..=p9 survive, p0..=p5 are pruned.
        prune_crashes_dir(&dir, 4);
        let survivors: std::collections::HashSet<String> = list_pending_crashes(&dir)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(survivors.len(), 4, "should keep exactly 4");
        for i in 6..10 {
            assert!(survivors.contains(&format!("crash-p{i}.json")), "newest crash-p{i}.json must survive");
        }
        for i in 0..6 {
            assert!(!survivors.contains(&format!("crash-p{i}.json")), "older crash-p{i}.json must be pruned");
        }
        // A keep count >= the file count is a no-op.
        prune_crashes_dir(&dir, 100);
        assert_eq!(list_pending_crashes(&dir).len(), 4);
    }

    #[test]
    fn prune_age_gates_orphaned_tmp_files() {
        let dir = tmp_dir();
        write_crash_record(&dir, &sample_record("real", "boom", None)).unwrap();

        // A FRESH tmp (a live write mid-flight between fs::write and rename) must be SPARED.
        std::fs::write(dir.join("crash-fresh.json.tmp"), b"{partial").unwrap();

        // A STALE tmp (orphan from a prior run) must be swept: stamp its mtime older than the gate.
        let stale = dir.join("crash-stale.json.tmp");
        std::fs::write(&stale, b"{partial").unwrap();
        let old = std::time::SystemTime::now() - (TMP_ORPHAN_MIN_AGE + std::time::Duration::from_secs(5));
        std::fs::OpenOptions::new()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();

        prune_crashes_dir(&dir, MAX_RETAINED_CRASH_FILES);

        assert!(!stale.exists(), "a stale orphan .tmp must be swept");
        assert!(
            dir.join("crash-fresh.json.tmp").exists(),
            "a fresh (in-flight) .tmp must be spared so we don't race a live write"
        );
        assert!(dir.join("crash-real.json").exists(), "a real record must survive");
    }

    #[test]
    fn suppress_guard_toggles_and_restores_thread_local() {
        assert!(!crash_records_suppressed());
        {
            let _g = suppress_crash_records();
            assert!(crash_records_suppressed());
            {
                // Nesting restores the previous (already-true) state on inner drop.
                let _inner = suppress_crash_records();
                assert!(crash_records_suppressed());
            }
            assert!(crash_records_suppressed());
        }
        assert!(!crash_records_suppressed(), "guard must restore on drop");
    }

    #[test]
    fn signal_shaped_json_is_valid_and_matches_schema() {
        // Simulate the exact bytes the signal handler hand-writes and prove they parse into a
        // CrashRecord with kind="signal" and a real signal name — i.e. the hand-built shape matches
        // what flush_pending deserializes.
        let prefix = r#"{"crash_id":"sig-1","kind":"signal","signal":""#;
        let mid = r#"","message":"native fatal signal","backtrace":null,"app_version":"0.18.0","os":"macOS 15.5","arch":"aarch64","occurred_at":"#;
        let doc = format!("{prefix}SIGABRT{mid}1700000000123}}");
        let rec: CrashRecord = serde_json::from_str(&doc).unwrap();
        assert_eq!(rec.kind, "signal");
        assert_eq!(rec.signal.as_deref(), Some("SIGABRT"));
        assert_eq!(rec.occurred_at, 1_700_000_000_123);
        assert!(rec.backtrace.is_none());
    }
}

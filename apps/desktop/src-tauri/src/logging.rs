// Unified verbose logging for Sparkle.
//
// Everything the app does — Rust commands AND the frontend UI — funnels into ONE
// human-readable log file so we can hand it to a developer (or Claude) to debug.
//
// - Rust code logs through `tracing` macros (info!/debug!/warn!/error!).
// - The frontend forwards its console output + user actions through the
//   `frontend_log` command (target: "ui"), so UI and backend interleave in the same file,
//   ordered by the timestamp `tracing` stamps on each event. That is NOT strict dispatch
//   order for two frontend lines any more — see the note on `frontend_log`.
// - Output goes to a daily-rolling file in the OS app-log dir
//   (macOS: ~/Library/Logs/ai.sparkle.desktop/sparkle.log) and also to stderr in dev.
//
// `reveal_logs` opens that folder in Finder; `app_version` / `log_dir` back the
// bottom-left status bar.

use std::path::PathBuf;

use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::retention;

/// Basename the daily appender writes (`sparkle.log.YYYY-MM-DD`). Shared with the retention pass so
/// the prune filter and the writer can never drift apart and start pruning the wrong files.
pub(crate) const LOG_FILE_PREFIX: &str = "sparkle.log";

/// How often the retention sweep re-runs for the life of the process.
///
/// Pruning only at launch bounds the log dir only for someone who RESTARTS. Sparkle sessions run
/// for days, and `rolling::daily` opens a brand-new file at every UTC midnight, so within one
/// session the directory grows with nothing to reap it — the cap is enforced against the state the
/// process booted into, not the state it is in now. Measured in the field: a log dir sitting just
/// over the 256 MB cap, with single days past 100 MB, and no restart due.
///
/// Six hours is deliberately coarse. The sweep only has work after a day rolls over, and it stats
/// every file in the directory, so running it often would cost far more than it reclaims.
const LOG_PRUNE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// Resolve the OS log directory for this app (creating it if needed).
/// `pub(crate)` so the support module can tail the same unified log (support.rs).
pub(crate) fn resolve_log_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = crate::dev_identity::app_log_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Install the global tracing subscriber. Call once, early in `setup()`.
///
/// The default verbosity is intentionally chatty (our own crate + UI at DEBUG) because
/// the whole point of this log is to reconstruct "what happened" after the fact. Set the
/// `RUST_LOG` env var to override (e.g. `RUST_LOG=warn`).
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = resolve_log_dir(app)?;

    // First pass runs BEFORE the appender exists, so the file this run is about to open cannot even
    // be a candidate. `rolling::daily` rotates but never deletes, which had let this directory reach
    // 523 MB (single days at 116 MB). Reported to stderr rather than `tracing` because the
    // subscriber is not installed yet.
    match prune_pass(&dir) {
        Ok(s) if s.deleted > 0 => eprintln!(
            "log retention: pruned {} old log file(s), freed {} MB",
            s.deleted,
            s.bytes_freed / (1024 * 1024)
        ),
        Ok(_) => {}
        Err(e) => eprintln!("log retention: prune failed (continuing): {e}"),
    }

    // Daily-rolling file. `sparkle.log` becomes `sparkle.log.YYYY-MM-DD` as it rotates,
    // so old sessions are retained without unbounded growth in a single file.
    let file_appender = tracing_appender::rolling::daily(&dir, LOG_FILE_PREFIX);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sparkle_lib=debug,ui=debug"));

    // SINK-LEVEL REDACTION (bead ): wrap BOTH sink writers so every formatted event is
    // scrubbed of secrets/tokens/bearers before it hits disk or stderr — regardless of which call
    // site emitted it. This is defense-in-depth on top of the per-call-site redaction in
    // crash.rs/support.rs/github.rs, which stays in place. See `redacting_writer` for why redacting
    // per-write is safe for line structure (fmt emits one `write_all` per event).
    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(crate::redacting_writer::RedactingMakeWriter::new(file_appender));

    // Mirror to stderr so `pnpm tauri dev` shows logs live in the terminal — redacted at the sink too.
    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_writer(crate::redacting_writer::RedactingMakeWriter::new(std::io::stderr));

    // `try_init` rather than `init` so a double-call (e.g. test harness) is a no-op, not a panic.
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init();

    // ...and keep pruning for the life of the process, so a session that spans several midnights
    // stays inside the cap without needing a restart. Spawned only after the subscriber is live so
    // the sweep's own log lines have somewhere to go.
    spawn_periodic_prune(dir.clone());

    Ok(dir)
}

/// One retention sweep of the log directory. Split out so the launch pass and the periodic pass
/// share exactly one policy — a drift between them would silently mean the cap applies only to
/// people who restart.
fn prune_pass(dir: &std::path::Path) -> Result<retention::ReapStats, String> {
    retention::prune_logs(
        dir,
        LOG_FILE_PREFIX,
        retention::LogPolicy::default(),
        std::time::SystemTime::now(),
    )
}

/// Re-run the retention sweep every `LOG_PRUNE_INTERVAL` until the process exits.
///
/// SAFETY OF PRUNING A LIVE DIRECTORY: unlike the launch pass, this one runs while
/// `tracing_appender` holds the current file open. It stays safe because `LogPolicy::keep_newest`
/// protects the newest files unconditionally and the file being appended to is, by construction,
/// the most recently modified one — see `keep_newest_protects_the_active_file_even_when_everything_is_ancient`
/// in `retention.rs`, which is the test that pins this.
///
/// A detached `std::thread` rather than an async task: it sleeps for hours at a time and must not
/// occupy a runtime worker, and it needs no shutdown path — the OS reclaims it at exit, and a sweep
/// interrupted by exit simply doesn't happen (the next launch prunes anyway).
///
/// Guarded by a `Once` to match the tolerance `try_init` above already builds in: `init` is designed
/// to be a no-op on a second call, and an unguarded spawn would instead leak another immortal thread
/// sweeping the same directory forever.
fn spawn_periodic_prune(dir: PathBuf) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(move || spawn_prune_thread(dir));
}

fn spawn_prune_thread(dir: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(LOG_PRUNE_INTERVAL);
        match prune_pass(&dir) {
            Ok(s) if s.deleted > 0 => tracing::info!(
                deleted = s.deleted,
                mb_freed = s.bytes_freed / (1024 * 1024),
                "log retention sweep complete"
            ),
            Ok(_) => tracing::debug!("log retention sweep: nothing to prune"),
            Err(e) => tracing::warn!("log retention sweep failed: {e}"),
        }
    });
}

/// The app version (from tauri.conf.json / Cargo.toml) for the status-bar label.
#[tauri::command]
pub fn app_version<R: Runtime>(app: AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

/// Absolute path to the log directory (shown on hover in the status bar).
#[tauri::command]
pub fn log_dir<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    Ok(resolve_log_dir(&app)?.to_string_lossy().to_string())
}

/// Open the log directory in Finder ("Show logs"). Creates it first so the window is
/// never empty/missing on a fresh install.
#[tauri::command]
pub fn reveal_logs<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = resolve_log_dir(&app)?;
    tracing::info!(target: "ui", dir = %dir.display(), "reveal_logs: opening log folder in Finder");
    std::process::Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// One log record forwarded from the frontend.
#[derive(Deserialize)]
pub struct FrontendLog {
    pub level: String,
    /// UI subsystem the line came from (e.g. "composer", "agent", "console").
    pub scope: Option<String>,
    pub message: String,
}

/// Sink for frontend logs so UI activity lands in the same file as the Rust backend. Levels map
/// onto the matching `tracing` macro; everything is tagged `target: "ui"` and carries its `scope`
/// so the file is greppable per-subsystem.
///
/// ── WHY THIS IS `async` (bead sparkle-rfhu5) ──────────────────────────────────────────────────
/// This is the highest-frequency `#[tauri::command]` in the app: `logger.ts` fires
/// `void invoke("frontend_log", …)` for every frontend log line — roughly 90K-145K invokes a day
/// (see the note in `perfTrace.ts`). As a plain `fn`, tauri-macros compiles it to `body_blocking`,
/// so every one of those dispatched a full `tracing` event through BOTH sink layers
/// (`redacting_writer` scrub + fmt + `write_all`) INLINE on the AppKit main thread. A
/// `/usr/bin/sample` of the shipped 0.96.1 build during a real 10.2-second UI freeze caught the
/// main thread in `tauri::ipc::protocol::get` for 24 samples, 18 of which were inside
/// `tracing_core::event::Event::dispatch` — the app was freezing itself logging about itself.
///
/// ── ORDERING: WHAT CHANGED, AND WHY THAT IS ACCEPTED RATHER THAN FIXED ────────────────────────
/// The header comment on this file used to claim UI and backend lines land "in time order"; it now
/// says "ordered by the timestamp `tracing` stamps on each event", because that claim is no longer
/// strictly true of two FRONTEND lines relative to each other. The emit now happens on a blocking
/// pool worker, so two invokes dispatched in order can be stamped out of order — a window on the
/// order of the scheduling hop (microseconds).
///
/// Capturing the timestamp "at command entry" would NOT fix this, which is why it is not done:
/// tauri compiles an `async fn` command to `body_async`, which builds the future and hands it to
/// `async_runtime::spawn`. Nothing in this body runs on the dispatching thread — the first
/// statement already executes on a runtime worker, subject to exactly the same scheduler as the
/// blocking task. The only construction that would restore a total order is a single-consumer FIFO
/// (one dedicated writer thread behind a channel), which is a larger change than this defect calls
/// for and buys ordering the log's consumers do not depend on: every line still carries its own
/// `tracing` timestamp, and the interleave window is far below the resolution anyone reads the log
/// at. UI-vs-backend interleaving — the property the header comment exists for — is unaffected.
///
/// ── LOSS ──────────────────────────────────────────────────────────────────────────────────────
/// Dropping a `spawn_blocking` handle does not cancel the task, and this one is awaited anyway, so
/// the line is emitted for any normal shutdown or backpressure. A `JoinError` means the dispatch
/// genuinely never ran — that is logged rather than swallowed, so a lost UI line is never silent.
/// The command still returns `()`: `logger.ts` ignores the promise, and this must not become an
/// error the frontend has to handle.
#[tauri::command]
pub async fn frontend_log(entry: FrontendLog) {
    if let Err(e) = tauri::async_runtime::spawn_blocking(move || emit_frontend_log(entry)).await {
        tracing::warn!(target: "ui", "frontend_log dispatch failed; one UI log line was lost: {e}");
    }
}

/// Blocking core of [`frontend_log`]: the `tracing` dispatch itself. Split out so the conversion is
/// a pure relocation of the work — the body is byte-for-byte the behaviour the sync command had.
fn emit_frontend_log(entry: FrontendLog) {
    let scope = entry.scope.unwrap_or_else(|| "ui".to_string());
    let msg = entry.message;
    match entry.level.as_str() {
        "error" => tracing::error!(target: "ui", scope, "{msg}"),
        "warn" => tracing::warn!(target: "ui", scope, "{msg}"),
        "debug" => tracing::debug!(target: "ui", scope, "{msg}"),
        _ => tracing::info!(target: "ui", scope, "{msg}"),
    }
}

// Unified verbose logging for Sparkle.
//
// Everything the app does — Rust commands AND the frontend UI — funnels into ONE
// human-readable log file so we can hand it to a developer (or Claude) to debug.
//
// - Rust code logs through `tracing` macros (info!/debug!/warn!/error!).
// - The frontend forwards its console output + user actions through the
//   `frontend_log` command (target: "ui"), so UI and backend interleave in time order.
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

    // Prune BEFORE installing the appender, so the file this run is about to open is never a
    // deletion candidate. `rolling::daily` rotates but never deletes, which had let this directory
    // reach 523 MB (single days at 116 MB). The policy keeps the newest files unconditionally, so
    // recent debugging context always survives. Best-effort: a prune failure must not stop logging.
    match retention::prune_logs(
        &dir,
        LOG_FILE_PREFIX,
        retention::LogPolicy::default(),
        std::time::SystemTime::now(),
    ) {
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

    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(file_appender);

    // Mirror to stderr so `pnpm tauri dev` shows logs live in the terminal.
    let stderr_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);

    // `try_init` rather than `init` so a double-call (e.g. test harness) is a no-op, not a panic.
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init();

    Ok(dir)
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

/// Sink for frontend logs so UI activity lands in the same file, in time order, as the
/// Rust backend. Levels map onto the matching `tracing` macro; everything is tagged
/// `target: "ui"` and carries its `scope` so the file is greppable per-subsystem.
#[tauri::command]
pub fn frontend_log(entry: FrontendLog) {
    let scope = entry.scope.unwrap_or_else(|| "ui".to_string());
    let msg = entry.message;
    match entry.level.as_str() {
        "error" => tracing::error!(target: "ui", scope, "{msg}"),
        "warn" => tracing::warn!(target: "ui", scope, "{msg}"),
        "debug" => tracing::debug!(target: "ui", scope, "{msg}"),
        _ => tracing::info!(target: "ui", scope, "{msg}"),
    }
}

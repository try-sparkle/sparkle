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

/// Collapse embedded newlines so one forwarded record stays one physical line.
///
/// The frontend renders an Error as `name: message\n<stack>`, and `JSON.stringify` of a value
/// holding a newline keeps it, so a forwarded message can arrive with line breaks in it. `tracing`
/// writes the message verbatim, which splits ONE record across several physical lines: the head
/// line carries the timestamp/level/target and the continuation lines carry nothing, while the
/// record's own trailing fields (`scope="…"`) end up stranded on the LAST line, far from the head
/// they belong to. Every consumer of this file reads it a line at a time — the retention/support
/// tail, `grep`, and the humans and agents we hand it to — so those orphans are unattributable to a
/// time or a level, and aggregating by level silently mis-attributes them to whatever came before.
/// Observed in the field: a console stack trace landing as three lines, the last one alone holding
/// `scope="console"`.
///
/// Escaping to a literal `\n` (and `\r`) keeps the stack readable and greppable on one line rather
/// than dropping frames. Only the FILE is flattened — the frontend already printed the pretty
/// multi-line version to devtools before forwarding, so nothing readable is lost there.
///
/// Backslashes are deliberately NOT doubled. That would make the escaping round-trippable, but this
/// file is read by humans and agents, not parsed back, and the frontend renders structured payloads
/// with `JSON.stringify` — whose output is already full of `\"` and `\n` escapes. Doubling would
/// mangle every one of those on the most common path to buy unambiguity nobody consumes.
fn to_single_line(msg: &str) -> String {
    msg.replace('\r', "\\r").replace('\n', "\\n")
}

/// Sink for frontend logs so UI activity lands in the same file, in time order, as the
/// Rust backend. Levels map onto the matching `tracing` macro; everything is tagged
/// `target: "ui"` and carries its `scope` so the file is greppable per-subsystem.
#[tauri::command]
pub fn frontend_log(entry: FrontendLog) {
    let scope = entry.scope.unwrap_or_else(|| "ui".to_string());
    let msg = to_single_line(&entry.message);
    match entry.level.as_str() {
        "error" => tracing::error!(target: "ui", scope, "{msg}"),
        "warn" => tracing::warn!(target: "ui", scope, "{msg}"),
        "debug" => tracing::debug!(target: "ui", scope, "{msg}"),
        _ => tracing::info!(target: "ui", scope, "{msg}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole contract: whatever the frontend hands us, the file gets ONE line for it.
    fn line_count(msg: &str) -> usize {
        to_single_line(msg).lines().count()
    }

    #[test]
    fn plain_message_is_unchanged() {
        assert_eq!(to_single_line("policy resolved"), "policy resolved");
    }

    #[test]
    fn rendered_error_with_stack_collapses_to_one_line() {
        // Shape the frontend's render() produces for an Error: `name: message\n<stack>`.
        let rendered = "TypeError: Load failed\njson@[native code]\n@user-script:3:94:35";
        assert_eq!(line_count(rendered), 1);
        assert_eq!(
            to_single_line(rendered),
            "TypeError: Load failed\\njson@[native code]\\n@user-script:3:94:35"
        );
    }

    #[test]
    fn carriage_returns_are_escaped_too() {
        // A bare \r would let a terminal overwrite the head of the line it is printed on.
        assert_eq!(line_count("first\r\nsecond"), 1);
        assert_eq!(to_single_line("first\r\nsecond"), "first\\r\\nsecond");
    }

    #[test]
    fn trailing_newline_leaves_no_empty_continuation() {
        assert_eq!(to_single_line("done\n"), "done\\n");
    }

    #[test]
    fn json_payload_escapes_are_left_intact() {
        // JSON.stringify output already carries literal `\"` / `\n`; doubling backslashes here
        // would mangle every structured payload we forward.
        let payload = r#"sent prompt {"text":"a\nb","q":"\""}"#;
        assert_eq!(to_single_line(payload), payload);
    }
}

//! Launch-time consumer for the BACKLOG DRAINER's LaunchAgent supervisor (`[drainer]`).
//!
//! The deterministic engine — floor, worker cap, worst-first claim, the reconcile/journal safety
//! rails — lives in `scripts/backlog-drainer.sh`, which ships SEPARATELY (PR #2417) and is not in
//! this branch. This module is the thin app-side consumer that makes a shipped DMG actually run it:
//! on launch (`lib.rs` `setup`) and on a Settings toggle, it reads the machine-wide `[drainer]
//! enabled` kill-switch and idempotently INSTALLS the LaunchAgent (`--install`) when ON or
//! UNINSTALLS it (`--uninstall`) when OFF.
//!
//! MODELLED ON THE `[roborev]` DAEMON-ENSURE AT LAUNCH, not on an in-process loop: the supervisor is
//! a launchd job the shell script writes and bootstraps, so the app never holds the drain loop in its
//! own process. The app's only job is to keep the launchd job's existence in step with the switch.
//!
//! SCOPE OF WHAT THIS FILE VERIFIES. The install/uninstall idempotence, the worker cap + rest floor,
//! and the "refuse to claim without a dispatch consumer" rule are properties of the SHELL ENGINE and
//! are asserted by its own test suite (`scripts/tests/backlog-drainer.test.sh` in #2417) — NOT here.
//! What this module and its tests establish is narrower and is all the app side owns: that the kill
//! switch is forwarded to the correct subcommand, that an OFF switch tears the LaunchAgent down even
//! when the script is absent (the one path that must never fail open), and that an absent clone on
//! the ENABLE path is a safe no-op rather than a clone or an error.
//!
//! SAFETY (this is a sensitive autonomous-spawn feature; the rails are deliberate):
//!   * `enabled = false` tears the LaunchAgent down, so nothing is scheduled and no worker is ever
//!     spawned. Honoured at two layers — this consumer AND the watchdog re-reading `[drainer] enabled`
//!     / `SPARKLE_DRAINER_ENABLED=0` each pass — and the OFF path works even if the script has
//!     vanished (see `ensure_backlog_drainer_at`), so a disable can never silently leave the job live.
//!   * This consumer wires NO dispatch bridge (`SPARKLE_DRAINER_DISPATCH_CMD` /
//!     `SPARKLE_DRAINER_QUEUE_CONSUMER=1`), so even a default-ON install stands the supervisor up but
//!     the watchdog reconciles and NEVER claims/spawns until that bridge is deliberately wired.
//!   * Never CLONES: a launch-time ensure must not trigger a multi-second network op. The ENABLE path
//!     no-ops when the app-owned clone isn't present yet; a later launch installs once it exists.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::AppHandle;

/// The launchd job label the shell engine installs under. MUST match `INSTALL_LABEL` in
/// `scripts/backlog-drainer.sh`, so the Rust-side direct uninstall targets the same job.
const INSTALL_LABEL: &str = "ai.sparkle.backlog-drainer";

/// The subcommand handed to `scripts/backlog-drainer.sh`, decided PURELY from the kill-switch.
/// ON → install the LaunchAgent; OFF → uninstall it (nothing scheduled, no worker). Split out so the
/// mapping is unit-testable and so a test can assert the ACTUAL subcommand rather than the bool.
pub fn drainer_mode(enabled: bool) -> &'static str {
    if enabled {
        "--install"
    } else {
        "--uninstall"
    }
}

/// The drainer script inside the app-owned sparkle-self clone, or `None` when it isn't present yet
/// (a fresh install before the first improvement pass has cloned the repo, or a checkout on a branch
/// that lacks it). `None` means "no script to drive" — never a reason to clone.
pub fn drainer_script_path(repo_root: &Path) -> Option<PathBuf> {
    let p = repo_root.join("scripts").join("backlog-drainer.sh");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// The app-owned sparkle-self clone root. Mirrors `sparkle_agent::ensure_sparkle_repo_at`'s layout
/// (`<app_data>/sparkle-self/repo`) but NEVER clones — see the module header. Reuses the SAME
/// `SPARKLE_PROJECT_ID` const `sparkle_agent.rs` owns, so a layout change there can't leave this
/// resolving a phantom path.
pub fn sparkle_repo_root(app_data: &Path) -> PathBuf {
    app_data.join(crate::sparkle_agent::SPARKLE_PROJECT_ID).join("repo")
}

/// The LaunchAgents plist path under a base dir — `<launch_agents_dir>/<label>.plist`, matching
/// `scripts/backlog-drainer.sh`'s `$HOME/Library/LaunchAgents/<INSTALL_LABEL>.plist`.
fn drainer_plist_path(launch_agents_dir: &Path) -> PathBuf {
    launch_agents_dir.join(format!("{INSTALL_LABEL}.plist"))
}

/// The user's `~/Library/LaunchAgents`, resolved from `$HOME`. `None` when `$HOME` is unset/empty.
fn launch_agents_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    if home.is_empty() {
        return None;
    }
    Some(Path::new(&home).join("Library").join("LaunchAgents"))
}

/// Tear the LaunchAgent down DIRECTLY, independent of the shell script — the OFF-path fallback for
/// when the script is absent, so a kill-switch OFF can never fail open by leaving the job scheduled.
/// Boots the job out of launchd (best-effort, like the script's own `… 2>/dev/null || true`) and
/// removes the plist. Idempotent: a missing plist / already-booted-out job is success. Returns the
/// plist path it targeted.
fn uninstall_launchagent_at(launch_agents_dir: &Path) -> Result<PathBuf, String> {
    let plist = drainer_plist_path(launch_agents_dir);
    // Best-effort bootout: the job may not be loaded, and launchctl may be unavailable (non-macOS,
    // tests). Removing the plist is the durable effect that stops it re-loading; the bootout stops a
    // currently-loaded job now. Skipped under test to keep the suite hermetic (no real launchd).
    #[cfg(not(test))]
    {
        if let Ok(uid) = std::process::Command::new("id").arg("-u").output() {
            if uid.status.success() {
                let uid = String::from_utf8_lossy(&uid.stdout).trim().to_string();
                if !uid.is_empty() {
                    let _ = std::process::Command::new("launchctl")
                        .arg("bootout")
                        .arg(format!("gui/{uid}/{INSTALL_LABEL}"))
                        .output();
                }
            }
        }
    }
    match std::fs::remove_file(&plist) {
        Ok(()) => Ok(plist),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(plist), // already absent → success
        Err(e) => Err(format!("failed to remove {}: {e}", plist.display())),
    }
}

/// Core (AppHandle-free, testable): idempotently install/uninstall the LaunchAgent supervisor from
/// the kill-switch. `launch_agents_dir` is the OFF-path fallback target when the script is absent.
///
/// Returns `Ok(Some(mode))` naming what happened, or `Ok(None)` only on the ENABLE path when the
/// clone/script isn't present yet (nothing to install, safe no-op). The DISABLE path NEVER returns
/// `Ok(None)`: with the script present it runs `--uninstall`; with the script absent it tears the
/// LaunchAgent down directly — the one path that must not fail open. `Err` on a genuine failure.
pub fn ensure_backlog_drainer_core(
    repo_root: &Path,
    launch_agents_dir: Option<&Path>,
    enabled: bool,
) -> Result<Option<String>, String> {
    if let Some(script) = drainer_script_path(repo_root) {
        let mode = drainer_mode(enabled);
        let mut cmd = Command::new("/bin/bash");
        cmd.arg(&script).arg(mode).current_dir(repo_root);
        if enabled {
            // WIRE THE DISPATCH BRIDGE. Now that the app CONSUMES the drainer queue (the
            // `read_drainer_queue` command + the frontend `drainerBridge`), declare a dispatch
            // consumer so the scheduled `--watchdog` actually CLAIMS the worst-first bead and spools a
            // queue file for it — the shell engine refuses to claim at all with no consumer, because a
            // claim no spawner honours wedges the fleet to "full" forever. The shell bakes this env var
            // into the installed plist's `EnvironmentVariables`, so the launchd-run watchdog inherits it
            // (launchd hands a job none of the installing shell's environment otherwise).
            cmd.env("SPARKLE_DRAINER_QUEUE_CONSUMER", "1");
        } else {
            // An uninstall tears the job down and declares NO consumer — drop the var explicitly so an
            // ambient one in the app's environment can never make a teardown look like a wiring.
            cmd.env_remove("SPARKLE_DRAINER_QUEUE_CONSUMER");
        }
        let run = cmd.output();
        // Success is the only clean path. A spawn error OR a non-zero exit (the shell engine exits 4
        // on an unknown arg, 126/127 on a broken/missing script, non-zero on an early set -e abort)
        // is a FAILURE that, on the DISABLE path, must still tear the LaunchAgent down — otherwise the
        // kill switch fails open exactly when the script is present but uncooperative.
        let err_desc = match &run {
            Ok(out) if out.status.success() => return Ok(Some(mode.to_string())),
            Ok(out) => format!(
                "backlog-drainer.sh {mode} exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => format!("failed to run backlog-drainer.sh {mode}: {e}"),
        };
        if enabled {
            // ON: there is nothing safe to fall back to (don't start something the script refused).
            return Err(err_desc);
        }
        // OFF: fall back to the direct teardown; only surface an error if THAT also fails.
        let Some(la_dir) = launch_agents_dir else {
            return Err(format!(
                "{err_desc}; cannot fall back to a direct uninstall: $HOME unavailable"
            ));
        };
        let plist = uninstall_launchagent_at(la_dir)
            .map_err(|e| format!("{err_desc}; direct teardown also failed: {e}"))?;
        return Ok(Some(format!(
            "--uninstall (direct after script failure: {})",
            plist.display()
        )));
    }

    // No script on disk. The ENABLE path has nothing to install → safe no-op. The DISABLE path must
    // still uninstall (a script that has vanished must not strand an already-installed LaunchAgent).
    if enabled {
        Ok(None)
    } else {
        let Some(la_dir) = launch_agents_dir else {
            return Err("cannot uninstall the drainer LaunchAgent: $HOME is unavailable".into());
        };
        let plist = uninstall_launchagent_at(la_dir)?;
        Ok(Some(format!("--uninstall (direct: {})", plist.display())))
    }
}

/// Convenience wrapper resolving the real `~/Library/LaunchAgents` for the OFF-path fallback.
pub fn ensure_backlog_drainer_at(repo_root: &Path, enabled: bool) -> Result<Option<String>, String> {
    let la = launch_agents_dir();
    ensure_backlog_drainer_core(repo_root, la.as_deref(), enabled)
}

/// Frontend-facing command: apply the drainer kill-switch NOW (so a Settings toggle takes effect
/// without an app restart, the same way `setRoborevEnabled` installs/deactivates immediately).
/// `spawn_blocking` because it shells out to bash + launchctl. Never clones.
#[tauri::command]
pub async fn ensure_backlog_drainer(app: AppHandle, enabled: bool) -> Result<Option<String>, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = sparkle_repo_root(&app_data);
        ensure_backlog_drainer_at(&repo, enabled)
    })
    .await
    .map_err(|e| format!("backlog-drainer ensure task failed: {e}"))?
}


// ══════════════════════════════════════════════════════════════════════════════════════════════
// DISPATCH BRIDGE — the app-side consumer that turns a claimed+queued bead into a worker spawn.
//
// The shell engine (`scripts/backlog-drainer.sh --watchdog`, run on a schedule by the LaunchAgent
// this module installs) is the deterministic BRAIN: it counts the agent-feedback backlog, respects
// the rest floor and worker cap, selects the worst-first UNCLAIMED ready bead, CLAIMS it (the
// `draining` label + a claim file — dedupe-safe, claim-BEFORE-spawn), and spools a request file
// `<git-common-dir>/sparkle-drainer/queue/<beadId>.json` describing the drain task. There is no
// shell/CLI path to launch a Claude worker, so the app is the only place the spawn can live.
//
// This half is the CONSUMER: `read_drainer_queue` hands the frontend `drainerBridge` the pending
// queue entries (worst-first) plus the kill-switch state and the cap; the bridge spawns one
// background worker per entry via the sanctioned `spawnBuildAgentInProject` path and then calls
// `ack_drainer_queue_file` to remove the request so it is never handed out twice. Because the shell
// claimed the bead before writing the file, and the app deletes the file on spawn, a bead is
// dispatched at most once even across app restarts (a still-`draining` bead is not re-spooled).
//
// KILL-SWITCH, FAIL-CLOSED: when the drainer is disabled (`[drainer] enabled=false` /
// `SPARKLE_DRAINER_ENABLED=0`) `read_drainer_queue` hands out NO entries and touches nothing, so the
// bridge can never spawn — the same switch that (via `ensure_backlog_drainer`) uninstalls the
// LaunchAgent so nothing is even spooled. The gate is enforced here AND in the frontend bridge.

/// The drainer STATE dir the shell engine writes under — `<git-common-dir>/sparkle-drainer`,
/// honouring `DRAINER_STATE_DIR` (the shell's own override/test seam) so the app and the shell
/// always resolve the SAME dir. Mirrors `resolve_state_dir` in `scripts/backlog-drainer.sh`.
fn drainer_state_dir(repo_root: &Path) -> PathBuf {
    if let Some(dir) = std::env::var_os("DRAINER_STATE_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    // git-common-dir (shared by every worktree, never tracked) — resolved absolutely, exactly as the
    // shell does; fall back to `<repo_root>/.git` for a plain clone if git can't be run.
    let common = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("rev-parse")
        .arg("--path-format=absolute")
        .arg("--git-common-dir")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(PathBuf::from(s))
            }
        })
        .unwrap_or_else(|| repo_root.join(".git"));
    common.join("sparkle-drainer")
}

/// The drainer QUEUE dir — `<state-dir>/queue`, matching `QUEUE_DIR` in `scripts/backlog-drainer.sh`.
fn drainer_queue_dir(repo_root: &Path) -> PathBuf {
    drainer_state_dir(repo_root).join("queue")
}

/// A bead id is joined into a filesystem path, so accept ONLY the shape bd actually mints
/// (`sparkle-abc123`, plus `.`/`_`), and reject anything that could traverse out of the queue dir.
/// Fail-closed: an id that isn't provably safe is refused rather than sanitised into something else.
fn is_safe_bead_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && !id.contains("..")
        && !id.contains('/')
        && !id.contains('\\')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// Read + parse the spooled queue requests, WORST-FIRST (lowest priority number = P0 = first). A
/// file that is missing a `beadId`, is not valid JSON, or is not `*.json` is skipped rather than
/// failing the whole read — one malformed request must never stall the drain. Each returned object
/// carries an added `_queueFile` (its absolute path) so the caller can `ack` (delete) exactly it.
pub fn read_queue_entries(queue_dir: &Path) -> Vec<serde_json::Value> {
    let Ok(rd) = std::fs::read_dir(queue_dir) else {
        return Vec::new();
    };
    let mut out: Vec<(i64, String, serde_json::Value)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let bead_id = match val.get("beadId").and_then(|v| v.as_str()) {
            // Reject an unsafe id here, not only at ack: it is interpolated into the worker's mission
            // prompt (`bd show <id>`) and is the request's key, so a dispatchable-but-un-ackable id
            // would re-spawn a worker on every restart. Skip it (a later reconcile releases the claim).
            Some(s) if is_safe_bead_id(s) => s.to_string(),
            _ => continue,
        };
        // priority is emitted as a STRING by the shell's json_str ("0".."4"); tolerate a number too.
        let prio = val
            .get("priority")
            .and_then(|v| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()).or_else(|| v.as_i64()))
            .unwrap_or(99);
        if let Some(obj) = val.as_object_mut() {
            obj.insert(
                "_queueFile".to_string(),
                serde_json::Value::String(path.to_string_lossy().into_owned()),
            );
        }
        out.push((prio, bead_id, val));
    }
    // Worst-first, tie-broken by bead id for a deterministic order across polls.
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    out.into_iter().map(|(_, _, v)| v).collect()
}

/// What the frontend bridge needs for one dispatch pass: the kill-switch state, the worker cap, and
/// the worst-first pending requests. When `enabled` is false the entries are ALWAYS empty (the
/// kill-switch, fail-closed) so a disabled drainer can never spawn.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainerQueueSnapshot {
    pub enabled: bool,
    pub max_workers: u32,
    pub entries: Vec<serde_json::Value>,
}

/// Pure core (testable): assemble the snapshot. The kill-switch is enforced HERE — a disabled
/// drainer reads no entries and does not even touch the queue dir.
pub fn queue_snapshot_core(enabled: bool, max_workers: u32, queue_dir: &Path) -> DrainerQueueSnapshot {
    let entries = if enabled {
        read_queue_entries(queue_dir)
    } else {
        Vec::new()
    };
    DrainerQueueSnapshot { enabled, max_workers, entries }
}

/// The drainer kill-switch as the CONSUMER must read it: `SPARKLE_DRAINER_ENABLED` (the shell's env
/// override) wins, else the effective `[drainer] enabled` config. Off tokens match the shell's
/// (`0/false/off/no`). This is the same switch `ensure_backlog_drainer` uses to install/uninstall
/// the LaunchAgent, read a second time here so a disabled drainer hands out nothing even if a stale
/// queue file survived a disable.
fn drainer_enabled_effective() -> bool {
    if let Some(v) = std::env::var_os("SPARKLE_DRAINER_ENABLED") {
        let v = v.to_string_lossy().trim().to_ascii_lowercase();
        return !matches!(v.as_str(), "0" | "false" | "off" | "no");
    }
    crate::config::current_effective().config.drainer.enabled
}

/// The worker cap the bridge must not exceed: `SPARKLE_DRAINER_MAX_WORKERS` env wins, else
/// `[drainer] max_workers` from the global config file, else the shell engine's conservative default
/// of 3. Mirrors `worker_cap`/`cfg_int` in `scripts/backlog-drainer.sh` so the app and the shell
/// agree on the bound. Floored at 1.
fn drainer_max_workers(app_data: &Path) -> u32 {
    if let Some(v) = std::env::var_os("SPARKLE_DRAINER_MAX_WORKERS") {
        if let Ok(n) = v.to_string_lossy().trim().parse::<u32>() {
            if n >= 1 {
                return n;
            }
        }
    }
    let path = crate::config::global_path(app_data);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(val) = text.parse::<toml::Value>() {
            if let Some(n) = val
                .get("drainer")
                .and_then(|d| d.get("max_workers"))
                .and_then(|m| m.as_integer())
            {
                if n >= 1 {
                    return n as u32;
                }
            }
        }
    }
    3
}

/// Frontend-facing: the pending drainer queue for one dispatch pass. Fail-closed — when the
/// kill-switch is off, `enabled` is false and `entries` is empty (no spawn possible).
#[tauri::command]
pub async fn read_drainer_queue(app: AppHandle) -> Result<DrainerQueueSnapshot, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let enabled = drainer_enabled_effective();
        let max_workers = drainer_max_workers(&app_data);
        let repo = sparkle_repo_root(&app_data);
        queue_snapshot_core(enabled, max_workers, &drainer_queue_dir(&repo))
    })
    .await
    .map_err(|e| format!("read_drainer_queue task failed: {e}"))
}

/// Frontend-facing: remove ONE spooled request AFTER its worker actually ran, so the same bead is
/// never dispatched twice. Takes the exact `_queueFile` path the reader returned (NOT a bead id
/// re-derived into a path — a file whose name did not match its content beadId would then survive and
/// re-spawn forever). Returns `true` if a file was removed, `false` if it was already gone.
#[tauri::command]
pub async fn ack_drainer_queue_file(app: AppHandle, queue_file: String) -> Result<bool, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = sparkle_repo_root(&app_data);
        ack_queue_file_core(&drainer_queue_dir(&repo), Path::new(&queue_file))
    })
    .await
    .map_err(|e| format!("ack_drainer_queue_file task failed: {e}"))?
}

/// Pure core (testable): remove one queue request file, idempotently. `true` = removed, `false` =
/// already gone. Refuses anything that is not a `*.json` DIRECTLY inside the queue dir, so a path
/// from the frontend can never escape it (traversal-safe without trusting the caller).
pub fn ack_queue_file_core(queue_dir: &Path, queue_file: &Path) -> Result<bool, String> {
    if queue_file.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err(format!("refusing to ack a non-json path: {}", queue_file.display()));
    }
    let parent = queue_file
        .parent()
        .ok_or_else(|| format!("queue file has no parent: {}", queue_file.display()))?;
    // The queue dir exists (we read from it); the file's parent exists even if the file is gone.
    // Comparing the CANONICAL dirs rejects `../` traversal without trusting the string.
    let canon_dir = std::fs::canonicalize(queue_dir)
        .map_err(|e| format!("queue dir unreadable ({}): {e}", queue_dir.display()))?;
    let canon_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("queue file parent unreadable ({}): {e}", parent.display()))?;
    if canon_parent != canon_dir {
        return Err(format!(
            "refusing to ack outside the queue dir: {}",
            queue_file.display()
        ));
    }
    match std::fs::remove_file(queue_file) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("failed to remove {}: {e}", queue_file.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Write a fake `scripts/backlog-drainer.sh` under `repo_root` that RECORDS its argv to
    /// `record.log` and, on `--install`, creates an `installed` marker (removed on `--uninstall`).
    /// This lets the tests assert the ACTUAL subcommand that ran and the ACTUAL side effect —
    /// "the LaunchAgent would exist" — rather than trusting the bool. (What the REAL script's
    /// idempotence / refuse-to-claim behaviour does is the shell suite's job, see the module header.)
    fn write_fake_script(repo_root: &Path) -> (PathBuf, PathBuf) {
        let scripts = repo_root.join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        let record = repo_root.join("record.log");
        let installed = repo_root.join("installed");
        let body = format!(
            "#!/bin/bash\n\
             printf '%s\\n' \"$1\" >> '{record}'\n\
             case \"$1\" in\n\
             --install) : > '{installed}' ;;\n\
             --uninstall) rm -f '{installed}' ;;\n\
             esac\n",
            record = record.display(),
            installed = installed.display(),
        );
        let script = scripts.join("backlog-drainer.sh");
        fs::write(&script, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        }
        (record, installed)
    }

    fn call(repo_root: &Path, la_dir: &Path, enabled: bool) -> Result<Option<String>, String> {
        ensure_backlog_drainer_core(repo_root, Some(la_dir), enabled)
    }

    #[test]
    fn mode_maps_the_kill_switch_to_a_subcommand() {
        // The whole mapping the consumer rides on: ON installs, OFF uninstalls. Asserted as string
        // literals so flipping either arm reddens this immediately.
        assert_eq!(drainer_mode(true), "--install");
        assert_eq!(drainer_mode(false), "--uninstall");
    }

    #[test]
    fn enabled_actually_invokes_install_and_the_launchagent_would_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let la = tempfile::tempdir().unwrap();
        let (record, installed) = write_fake_script(tmp.path());

        let ran = call(tmp.path(), la.path(), true).unwrap();
        assert_eq!(ran.as_deref(), Some("--install"), "enabled must run --install");
        // Assert the ACTUAL call reached the script, not just the return value.
        assert_eq!(fs::read_to_string(&record).unwrap().trim(), "--install");
        // Assert the SIDE EFFECT: the supervisor is now installed (its marker exists).
        assert!(installed.exists(), "enabled must leave the LaunchAgent installed");
    }

    #[test]
    fn disabled_uninstalls_and_leaves_nothing_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let la = tempfile::tempdir().unwrap();
        let (record, installed) = write_fake_script(tmp.path());

        // Pre-seed an installed marker so we prove uninstall REMOVES it (the reversible kill-switch).
        fs::write(&installed, "").unwrap();

        let ran = call(tmp.path(), la.path(), false).unwrap();
        assert_eq!(ran.as_deref(), Some("--uninstall"), "disabled must run --uninstall");
        assert_eq!(fs::read_to_string(&record).unwrap().trim(), "--uninstall");
        // The paired safety assertion: disabled leaves NOTHING scheduled — the marker is gone, so no
        // watchdog is registered and no worker can be spawned.
        assert!(!installed.exists(), "disabled must uninstall the LaunchAgent");
    }

    #[test]
    fn disabled_never_installs_the_supervisor() {
        // The load-bearing kill-switch guarantee, stated as its own test on the WRITE: enabled=false
        // must NEVER take the install path. A fresh tree (no pre-seeded marker) stays with nothing
        // installed, and the recorded argv never contains --install.
        let tmp = tempfile::tempdir().unwrap();
        let la = tempfile::tempdir().unwrap();
        let (record, installed) = write_fake_script(tmp.path());

        call(tmp.path(), la.path(), false).unwrap();

        let log = fs::read_to_string(&record).unwrap();
        assert!(
            !log.contains("--install"),
            "disabled must never invoke --install (got: {log:?})"
        );
        assert!(!installed.exists(), "disabled must never install the supervisor");
    }

    #[test]
    fn absent_clone_on_enable_is_a_no_op_not_an_error_and_never_clones() {
        // A fresh install before the improvement pass has cloned the repo: no script on disk. The
        // ENABLE path must quietly no-op (Ok(None)) rather than erroring or attempting anything — a
        // later launch, once the clone exists, does the install.
        let tmp = tempfile::tempdir().unwrap();
        let la = tempfile::tempdir().unwrap();
        let ran = call(tmp.path(), la.path(), true).unwrap();
        assert_eq!(ran, None, "an absent script on the ENABLE path must be a no-op");
        // And the resolver reports absence rather than a phantom path.
        assert!(drainer_script_path(tmp.path()).is_none());
    }

    #[test]
    fn disable_with_absent_script_still_tears_the_launchagent_down() {
        // The dangerous half the earlier no-op-Ok(None) missed: the script has vanished (clone reset,
        // branch without it) AFTER an install, and the user switches the drainer OFF. This must NOT
        // fail open — the already-installed plist must be removed even with no script to drive.
        let tmp = tempfile::tempdir().unwrap(); // repo root: deliberately NO scripts/ dir
        let la = tempfile::tempdir().unwrap();
        let plist = la.path().join(format!("{INSTALL_LABEL}.plist"));
        fs::write(&plist, "<plist/>").unwrap(); // a previously-installed LaunchAgent

        let ran = call(tmp.path(), la.path(), false).unwrap();
        assert!(
            ran.as_deref().unwrap_or_default().contains("--uninstall"),
            "a disable with no script must still report an uninstall, not a silent no-op: {ran:?}"
        );
        // The load-bearing assertion: the plist is GONE, so nothing is scheduled at next login.
        assert!(!plist.exists(), "the OFF path must remove the plist even without the script");
    }

    /// Write a fake script that EXITS NON-ZERO on any arg (mimics the engine's exit-4 on an unknown
    /// arg, a chmod-broken script, or an early set -e abort).
    fn write_failing_script(repo_root: &Path) {
        let scripts = repo_root.join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        let script = scripts.join("backlog-drainer.sh");
        fs::write(&script, "#!/bin/bash\nexit 4\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn disable_falls_back_to_direct_teardown_when_the_script_run_fails() {
        // The OFF path must not fail open when the script is PRESENT but its run fails. Pre-seed the
        // plist, make the script exit non-zero, and assert the plist is removed anyway.
        let tmp = tempfile::tempdir().unwrap();
        let la = tempfile::tempdir().unwrap();
        write_failing_script(tmp.path());
        let plist = la.path().join(format!("{INSTALL_LABEL}.plist"));
        fs::write(&plist, "<plist/>").unwrap();

        let ran = call(tmp.path(), la.path(), false).unwrap();
        assert!(
            ran.as_deref().unwrap_or_default().contains("direct after script failure"),
            "a failed --uninstall run must fall back to the direct teardown: {ran:?}"
        );
        assert!(!plist.exists(), "the OFF path must remove the plist even when the script run fails");
    }

    #[test]
    fn enable_surfaces_a_failed_script_run_rather_than_pretending_success() {
        // The ON path has nothing safe to fall back to, so a failed --install must be an Err, not a
        // silent success — otherwise the toggle would claim installed when it is not.
        let tmp = tempfile::tempdir().unwrap();
        let la = tempfile::tempdir().unwrap();
        write_failing_script(tmp.path());
        assert!(call(tmp.path(), la.path(), true).is_err(), "a failed --install must surface as Err");
    }

    #[test]
    fn direct_uninstall_with_no_plist_is_idempotent_success() {
        // Disabling when nothing was ever installed (and no script) is a clean no-op success, not an
        // error — turning an already-off switch off again must never surface a failure.
        let tmp = tempfile::tempdir().unwrap();
        let la = tempfile::tempdir().unwrap(); // empty: no plist present
        let ran = call(tmp.path(), la.path(), false).unwrap();
        assert!(ran.as_deref().unwrap_or_default().contains("--uninstall"), "{ran:?}");
    }

    #[test]
    fn repo_root_matches_the_app_owned_clone_layout() {
        // Pin the CONCRETE on-disk layout (a literal suffix), not the shared const against itself, so
        // this reddens if sparkle_agent::ensure_sparkle_repo_at's `<app_data>/sparkle-self/repo`
        // layout ever changes rather than silently tracking it.
        let got = sparkle_repo_root(Path::new("/tmp/app-data"));
        assert!(
            got.ends_with("sparkle-self/repo"),
            "expected <app_data>/sparkle-self/repo, got {}",
            got.display()
        );
        assert_eq!(got, Path::new("/tmp/app-data/sparkle-self/repo"));
    }

    // ── DISPATCH BRIDGE (queue consumer) tests ──────────────────────────────────────────────────

    fn write_queue_file(queue_dir: &Path, bead: &str, prio: &str, body_extra: &str) {
        fs::create_dir_all(queue_dir).unwrap();
        let json = format!(
            "{{\"beadId\":\"{bead}\",\"title\":\"fix {bead}\",\"priority\":\"{prio}\",\
             \"task\":\"do the thing\",\"goal\":\"landed\"{body_extra}}}"
        );
        fs::write(queue_dir.join(format!("{bead}.json")), json).unwrap();
    }

    #[test]
    fn read_queue_entries_parses_valid_skips_garbage_and_sorts_worst_first() {
        let tmp = tempfile::tempdir().unwrap();
        let q = tmp.path().join("queue");
        // Two valid requests, out of priority order on disk.
        write_queue_file(&q, "sparkle-p2", "2", "");
        write_queue_file(&q, "sparkle-p0", "0", "");
        // Garbage / non-request files that must be SKIPPED, not fail the read.
        fs::create_dir_all(&q).unwrap();
        fs::write(q.join("broken.json"), "{ not json").unwrap();
        fs::write(q.join("nobead.json"), "{\"title\":\"x\"}").unwrap();
        fs::write(q.join("notqueue.txt"), "{\"beadId\":\"sparkle-x\"}").unwrap();

        let got = read_queue_entries(&q);
        // Exactly the two valid requests, worst-first (P0 before P2) — the SIDE EFFECT of parsing.
        let ids: Vec<&str> = got.iter().map(|v| v["beadId"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["sparkle-p0", "sparkle-p2"], "worst-first, garbage skipped");
        // Each entry carries the _queueFile path so the caller can ack exactly it.
        assert!(got[0]["_queueFile"].as_str().unwrap().ends_with("sparkle-p0.json"));
    }

    #[test]
    fn read_queue_entries_on_absent_dir_is_empty_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        // Before the first watchdog pass the queue dir does not exist yet.
        assert!(read_queue_entries(&tmp.path().join("queue")).is_empty());
    }

    #[test]
    fn queue_snapshot_enabled_returns_the_queued_requests() {
        let tmp = tempfile::tempdir().unwrap();
        let q = tmp.path().join("queue");
        write_queue_file(&q, "sparkle-a", "1", "");
        let snap = queue_snapshot_core(true, 3, &q);
        assert!(snap.enabled);
        assert_eq!(snap.entries.len(), 1, "enabled hands out the queued request");
        assert_eq!(snap.entries[0]["beadId"].as_str().unwrap(), "sparkle-a");
    }

    #[test]
    fn queue_snapshot_disabled_hands_out_no_entries_even_with_files() {
        // THE KILL-SWITCH, FAIL-CLOSED, ON THE RUST SIDE: a disabled drainer with a full queue on
        // disk must still hand the bridge NOTHING, so no worker can ever be spawned. Paired with the
        // enabled test above so flipping the gate reddens one of them.
        let tmp = tempfile::tempdir().unwrap();
        let q = tmp.path().join("queue");
        write_queue_file(&q, "sparkle-a", "1", "");
        write_queue_file(&q, "sparkle-b", "0", "");
        let snap = queue_snapshot_core(false, 3, &q);
        assert!(!snap.enabled);
        assert!(snap.entries.is_empty(), "disabled must expose no dispatchable requests");
    }

    #[test]
    fn ack_removes_the_request_file_by_path_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let q = tmp.path().join("queue");
        write_queue_file(&q, "sparkle-a", "1", "");
        let qf = q.join("sparkle-a.json");
        assert!(qf.exists());
        // Ack by the exact path (the reader's _queueFile): removes it (the SIDE EFFECT that stops a
        // re-spawn); a second ack of the same path is a no-op success.
        assert_eq!(ack_queue_file_core(&q, &qf).unwrap(), true);
        assert!(!qf.exists(), "ack must remove the request file");
        assert_eq!(ack_queue_file_core(&q, &qf).unwrap(), false, "idempotent");
    }

    #[test]
    fn ack_removes_a_file_whose_name_differs_from_its_bead_id() {
        // The bug ack-by-path fixes: a file named foo.json carrying beadId sparkle-a. Ack-by-beadId
        // would remove sparkle-a.json (absent) and leave foo.json to re-spawn forever; ack-by-path
        // removes the real file.
        let tmp = tempfile::tempdir().unwrap();
        let q = tmp.path().join("queue");
        fs::create_dir_all(&q).unwrap();
        let odd = q.join("foo.json");
        fs::write(&odd, "{\"beadId\":\"sparkle-a\",\"priority\":\"1\"}").unwrap();
        assert_eq!(ack_queue_file_core(&q, &odd).unwrap(), true);
        assert!(!odd.exists(), "ack must remove the actual file the reader returned");
    }

    #[test]
    fn ack_refuses_a_path_outside_the_queue_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let q = tmp.path().join("queue");
        fs::create_dir_all(&q).unwrap();
        // A sibling file OUTSIDE the queue dir must be refused, not removed, even via `..`.
        let outside = tmp.path().join("secret.json");
        fs::write(&outside, "x").unwrap();
        assert!(ack_queue_file_core(&q, &outside).is_err());
        assert!(ack_queue_file_core(&q, &q.join("../secret.json")).is_err());
        assert!(outside.exists(), "a path outside the queue dir must never be removed");
        // A non-json path is refused too.
        assert!(ack_queue_file_core(&q, &q.join("sparkle-a.txt")).is_err());
    }

    #[test]
    fn read_queue_entries_skips_an_unsafe_bead_id() {
        // An unsafe beadId is interpolated into the mission prompt and is the ack key, so the reader
        // must drop it entirely rather than hand back a dispatchable-but-un-ackable request.
        let tmp = tempfile::tempdir().unwrap();
        let q = tmp.path().join("queue");
        fs::create_dir_all(&q).unwrap();
        fs::write(q.join("bad.json"), "{\"beadId\":\"../../etc/passwd\",\"priority\":\"0\"}").unwrap();
        write_queue_file(&q, "sparkle-ok", "1", "");
        let got = read_queue_entries(&q);
        let ids: Vec<&str> = got.iter().map(|v| v["beadId"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["sparkle-ok"], "unsafe bead id must be skipped");
    }

    /// A fake `backlog-drainer.sh` that records whether `SPARKLE_DRAINER_QUEUE_CONSUMER` was set in
    /// its environment (the wire that makes the watchdog actually claim + spool).
    fn write_env_recording_script(repo_root: &Path) -> PathBuf {
        let scripts = repo_root.join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        let rec = repo_root.join("consumer.log");
        let body = format!(
            "#!/bin/bash\nprintf '%s=%s\\n' \"$1\" \"${{SPARKLE_DRAINER_QUEUE_CONSUMER:-<unset>}}\" >> '{rec}'\n",
            rec = rec.display(),
        );
        let script = scripts.join("backlog-drainer.sh");
        fs::write(&script, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        }
        rec
    }

    #[test]
    fn enable_wires_the_queue_consumer_and_disable_does_not() {
        // The load-bearing bridge wiring: an ENABLE (install) must declare the dispatch consumer so
        // the scheduled watchdog claims + spools; a DISABLE (uninstall) must NOT. Asserted on the env
        // the script actually received.
        let tmp = tempfile::tempdir().unwrap();
        let la = tempfile::tempdir().unwrap();
        let rec = write_env_recording_script(tmp.path());

        call(tmp.path(), la.path(), true).unwrap();
        call(tmp.path(), la.path(), false).unwrap();

        let log = fs::read_to_string(&rec).unwrap();
        assert!(
            log.contains("--install=1"),
            "install must pass SPARKLE_DRAINER_QUEUE_CONSUMER=1 (got: {log:?})"
        );
        assert!(
            log.contains("--uninstall=<unset>"),
            "uninstall must NOT declare a consumer (got: {log:?})"
        );
    }

}

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
        let run = Command::new("/bin/bash")
            .arg(&script)
            .arg(mode)
            .current_dir(repo_root)
            .output();
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
}

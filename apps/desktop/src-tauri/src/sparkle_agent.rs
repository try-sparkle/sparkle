//! The Sparkle self-improvement agent's app-owned meta-workspace.
//!
//! Unlike normal agents — which work inside the *user's* project — this special agent
//! works on Sparkle ITSELF: it reviews the user's session logs, drafts specs, and opens
//! PRs to the open-source Sparkle client. Its work is orthogonal to whatever the user is
//! building, so it must never touch a user project folder.
//!
//! Design: a single clone of the open-source repo, app-owned, under Sparkle's app-data dir
//! (`<app_data>/sparkle-self/repo`). It is the SAME for every project on this machine —
//! one clone, reused forever (idempotent). The agent then gets its own isolated git
//! worktree off that clone via the normal worktree machinery (see worktree.rs), so it can
//! never collide with the user's work. The log dir is passed to the agent via `--add-dir`
//! (the agent only needs to *read* the logs; --add-dir itself grants read+write).
//!
//! Dependency-free: we shell out to the system `git` via std::process::Command.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// The open-source Sparkle client the self-improvement agent files PRs against.
const SPARKLE_REPO_URL: &str = "https://github.com/drodio/sparkle.git";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparkleWorkspace {
    /// Absolute path to the app-owned clone of the open-source Sparkle repo. The agent's
    /// isolated worktree is cut from this (via create_agent_worktree with this as `root`).
    repo_path: String,
    /// Absolute path to the app log directory the agent reviews (exposed via --add-dir).
    log_dir: String,
    /// The clone's default branch (resolved from origin/HEAD), so the worktree is cut from the
    /// remote's real default rather than a hard-assumed "main".
    default_branch: String,
}

/// Mirror worktree.rs's non-interactive git env so a clone/fetch can never hang the UI on a
/// credential/host-key prompt. A public clone needs no auth; this just fails fast if it ever does.
fn apply_noninteractive(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "true");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
}

fn is_git_repo(path: &Path) -> bool {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(["rev-parse", "--git-dir"]);
    apply_noninteractive(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// Core (AppHandle-free, testable): ensure the app-owned clone exists under `app_data`, cloning
/// the open-source repo once if absent. Idempotent — an existing valid clone is returned as-is.
pub fn ensure_sparkle_repo_at(app_data: &Path) -> Result<String, String> {
    let repo = app_data.join("sparkle-self").join("repo");

    // Already cloned and healthy → reuse it (clone once, forever).
    if is_git_repo(&repo) {
        return Ok(repo.to_string_lossy().to_string());
    }

    // A leftover non-repo dir (interrupted clone) would make `git clone` fail with "exists and
    // is not empty". Clear it so the clone is reproducible.
    if repo.exists() {
        std::fs::remove_dir_all(&repo)
            .map_err(|e| format!("failed to clear stale sparkle-self dir: {e}"))?;
    }
    if let Some(parent) = repo.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create sparkle-self dir: {e}"))?;
    }

    let mut cmd = Command::new("git");
    cmd.args(["clone", SPARKLE_REPO_URL])
        .arg(&repo);
    apply_noninteractive(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run git clone: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "couldn't clone the open-source Sparkle repo ({SPARKLE_REPO_URL}): {stderr}"
        ));
    }

    Ok(repo.to_string_lossy().to_string())
}

/// Ensure the Sparkle self-improvement agent's app-owned workspace exists, returning the clone
/// path (for worktree creation), the log dir (passed to the agent via --add-dir), and the clone's
/// resolved default branch. Idempotent.
///
/// `async` + `spawn_blocking`: the first-run `git clone` is a multi-second network operation. A
/// sync `#[tauri::command]` runs on the main thread and would freeze the whole UI for the clone's
/// duration; offloading it keeps the window responsive (the frontend shows its "Preparing…" phase).
#[tauri::command]
pub async fn ensure_sparkle_repo(app: AppHandle) -> Result<SparkleWorkspace, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("no app log dir: {e}"))?;
    // Create the log dir so --add-dir never points at a missing path on a fresh install.
    let _ = std::fs::create_dir_all(&log_dir);

    // Run the (possibly slow, blocking) clone + branch resolution off the main thread.
    let (repo_path, default_branch) = tauri::async_runtime::spawn_blocking(move || {
        let repo_path = ensure_sparkle_repo_at(&app_data)?;
        let default_branch = crate::worktree::resolve_default_branch(&repo_path);
        Ok::<_, String>((repo_path, default_branch))
    })
    .await
    .map_err(|e| format!("clone task failed to run: {e}"))?
    .inspect_err(|e| tracing::error!(error = %e, "ensure_sparkle_repo failed"))?;
    tracing::info!(%repo_path, %default_branch, "ensure_sparkle_repo ready");

    Ok(SparkleWorkspace {
        repo_path,
        log_dir: log_dir.to_string_lossy().to_string(),
        default_branch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sparkle-self-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reuses_an_existing_clone_without_recloning() {
        // Stand up a fake "clone" (a real local repo) at the expected path, then assert
        // ensure_*_at returns it as-is (no network) rather than trying to clone over it.
        let app_data = unique_dir("reuse");
        let repo = app_data.join("sparkle-self").join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            assert!(Command::new("git").arg("-C").arg(&repo).args(args).status().unwrap().success());
        };
        run(&["init"]);
        run(&["config", "user.email", "t@t.local"]);
        run(&["config", "user.name", "t"]);
        run(&["commit", "--allow-empty", "-m", "seed"]);

        let got = ensure_sparkle_repo_at(&app_data).expect("reuse existing clone");
        assert_eq!(got, repo.to_string_lossy());
        let _ = std::fs::remove_dir_all(&app_data);
    }
}

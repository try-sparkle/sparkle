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
use tauri::AppHandle;

/// The open-source Sparkle client the self-improvement agent files PRs against.
/// This is the PUBLIC mirror (try-sparkle/sparkle). The private source-of-truth repo is
/// not clonable by end users, so its URL must never appear here — this constant ships in
/// the public mirror, and a private URL would point customers at a repo they cannot access.
const SPARKLE_REPO_URL: &str = "https://github.com/try-sparkle/sparkle.git";

/// Synthetic project id namespacing the Sparkle agent's worktrees under app-data. MUST match
/// `SPARKLE_PROJECT_ID` in `src/services/sparkleAgent.ts`.
const SPARKLE_PROJECT_ID: &str = "sparkle-self";

/// The CANONICAL Sparkle agent id — the main window's interactive pane and the hourly headless
/// pass share it (one worktree). MUST match `SPARKLE_AGENT_ID` in `src/services/sparkleAgent.ts`.
/// Improve Sparkle is per-window; every OTHER (secondary) window uses `__sparkle_self__-<label>`.
const SPARKLE_CANONICAL_AGENT_ID: &str = "__sparkle_self__";

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
    let mut cmd = Command::new(crate::preflight::git_program());
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

    let mut cmd = Command::new(crate::preflight::git_program());
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
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let log_dir = crate::dev_identity::app_log_dir(&app)?;
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

/// Core (AppHandle-free, testable): remove every PER-WINDOW Sparkle worktree under
/// `<app_data>/worktrees/sparkle-self` whose agent id is NOT the canonical one, returning how many
/// were removed. Improve Sparkle is per-window — each secondary window (`win-<uuid>`) cuts its own
/// worktree — but secondary windows are never restored across an app restart (multi-window session
/// restore is deferred), so their worktrees would accumulate forever. The canonical worktree (shared
/// by the main window's pane and the hourly pass) is always preserved. Idempotent: a missing
/// worktrees dir is a no-op (`Ok(0)`), and per-entry failures are skipped so one bad dir can't
/// strand the rest. For each reaped worktree we also drop its `sparkle/agent-<id>` branch (which
/// `remove_worktree_at` intentionally leaves behind) so refs don't pile up in the shared clone, and
/// we force-remove any leftover directory whose git metadata is already gone (a crash orphan that
/// `git worktree remove` reports as "not a working tree" without deleting). `removed` counts only
/// directories actually gone from disk afterward, so the returned count never over-reports.
pub fn reap_secondary_sparkle_worktrees_at(app_data: &Path) -> Result<u32, String> {
    // The clone whose worktrees these are — `remove_worktree_at` runs `git worktree remove` against it.
    let repo = app_data.join(SPARKLE_PROJECT_ID).join("repo");
    let repo_str = repo.to_string_lossy().to_string();

    let wt_dir = app_data.join("worktrees").join(SPARKLE_PROJECT_ID);
    let entries = match std::fs::read_dir(&wt_dir) {
        Ok(e) => e,
        Err(_) => return Ok(0), // dir absent (no Sparkle worktrees yet) → nothing to reap
    };

    let mut removed = 0u32;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == SPARKLE_CANONICAL_AGENT_ID {
            continue; // keep the canonical (main-window + hourly-pass) worktree
        }
        let dir = wt_dir.join(&name);
        // Reuse the exact removal path agents use (validates the id, force-removes the worktree,
        // idempotent). Best-effort — a validation/removal failure just falls through to the disk
        // fallback below rather than aborting the whole sweep.
        let _ = crate::worktree::remove_worktree_at(&repo_str, SPARKLE_PROJECT_ID, &name, app_data);
        // Crash-orphan fallback: `git worktree remove` returns Ok for a dir it doesn't recognize as
        // a worktree WITHOUT deleting it. If the dir is still on disk, force-remove it so a
        // metadata-less orphan (the exact case that produces accumulation) is actually cleaned.
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        // Drop the per-window branch too (`remove_worktree_at` keeps it, which is right for a real
        // agent that may resume — but a reaped secondary window never restores, bead , so
        // its branch would only accumulate as a dead ref in the clone). INVARIANT: a secondary
        // window's meaningful output is a PUSHED PR; this force-delete discards only local-only
        // commits in an app-internal, never-restored clone that nothing else can reach. We log the
        // branch as it goes so the (rare) loss isn't fully silent. Best-effort.
        let branch = format!("sparkle/agent-{name}");
        tracing::info!(%branch, "reaping orphaned per-window Sparkle branch");
        let mut cmd = Command::new(crate::preflight::git_program());
        cmd.arg("-C").arg(&repo_str).args(["branch", "-D", &branch]);
        apply_noninteractive(&mut cmd);
        let _ = cmd.output();
        // Count only if the directory is genuinely gone now, so the tally never over-reports.
        if !dir.exists() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Reap orphaned per-window Sparkle worktrees (see [`reap_secondary_sparkle_worktrees_at`]). Called
/// once on main-window boot, which at cold start is the only live window — so no in-use secondary
/// worktree can be clobbered. Returns the number removed.
///
/// `async` + `spawn_blocking`: `git worktree remove --force` deletes whole dirs from disk (seconds
/// each); offloading keeps the window responsive.
#[tauri::command]
pub async fn reap_secondary_sparkle_worktrees(app: AppHandle) -> Result<u32, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || reap_secondary_sparkle_worktrees_at(&app_data))
        .await
        .map_err(|e| format!("reap task failed to run: {e}"))?
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

    #[test]
    fn reaps_secondary_worktrees_and_keeps_canonical() {
        // Stand up a real clone + two Sparkle worktrees off it (canonical + one per-window
        // secondary), then assert the reap removes ONLY the secondary and leaves the canonical.
        let app_data = unique_dir("reap");
        let repo = app_data.join("sparkle-self").join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |cwd: &Path, args: &[&str]| {
            assert!(
                Command::new("git").arg("-C").arg(cwd).args(args).status().unwrap().success(),
                "git {args:?} failed"
            );
        };
        run(&repo, &["init"]);
        run(&repo, &["config", "user.email", "t@t.local"]);
        run(&repo, &["config", "user.name", "t"]);
        run(&repo, &["commit", "--allow-empty", "-m", "seed"]);

        // Worktrees live under <app_data>/worktrees/sparkle-self/<agent_id> (worktree_path layout).
        // Branch names follow the real convention `sparkle/agent-<dir name>` so the reaper's
        // branch-cleanup path is exercised (it derives the branch from the dir name).
        let wt_dir = app_data.join("worktrees").join(SPARKLE_PROJECT_ID);
        std::fs::create_dir_all(&wt_dir).unwrap();
        let canonical = wt_dir.join(SPARKLE_CANONICAL_AGENT_ID);
        let sec_name = format!("{SPARKLE_CANONICAL_AGENT_ID}-win-abc123");
        let secondary = wt_dir.join(&sec_name);
        let canon_branch = format!("sparkle/agent-{SPARKLE_CANONICAL_AGENT_ID}");
        let sec_branch = format!("sparkle/agent-{sec_name}");
        run(&repo, &["worktree", "add", "-b", &canon_branch, canonical.to_str().unwrap()]);
        run(&repo, &["worktree", "add", "-b", &sec_branch, secondary.to_str().unwrap()]);
        // A crash orphan: a leftover dir with NO git worktree metadata (git won't delete it).
        let orphan = wt_dir.join(format!("{SPARKLE_CANONICAL_AGENT_ID}-win-orphan"));
        std::fs::create_dir_all(&orphan).unwrap();
        assert!(canonical.exists() && secondary.exists() && orphan.exists());

        let branch_exists = |b: &str| {
            Command::new("git")
                .arg("-C").arg(&repo)
                .args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")])
                .status().unwrap().success()
        };

        let removed = reap_secondary_sparkle_worktrees_at(&app_data).expect("reap");
        assert_eq!(removed, 2, "both the secondary worktree and the crash orphan are reaped");
        assert!(canonical.exists(), "canonical worktree is preserved");
        assert!(!secondary.exists(), "secondary worktree is removed from disk");
        assert!(!orphan.exists(), "crash-orphan dir (no git metadata) is force-removed");
        assert!(branch_exists(&canon_branch), "canonical branch is preserved");
        assert!(!branch_exists(&sec_branch), "secondary branch is deleted so refs don't accumulate");

        // Idempotent: a second sweep finds nothing left to reap.
        assert_eq!(reap_secondary_sparkle_worktrees_at(&app_data).expect("reap again"), 0);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn reap_is_noop_when_worktrees_dir_absent() {
        let app_data = unique_dir("reap-empty");
        assert_eq!(reap_secondary_sparkle_worktrees_at(&app_data).expect("noop"), 0);
        let _ = std::fs::remove_dir_all(&app_data);
    }
}

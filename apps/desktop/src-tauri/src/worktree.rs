//! Per-agent git worktree isolation (§5 agent lifecycle). Each agent runs in its
//! OWN git worktree on its OWN branch so agents can't clobber each other's files.
//! All git mechanics are hidden from the user — Sparkle frames this as "each agent
//! works in its own safe space" (§2). The hidden worktrees live OUTSIDE the project
//! tree, under `<app_data>/worktrees/<projectId>/<agentId>` (see `worktree_path`), on
//! branch `sparkle/agent-<agentId>`.
//!
//! Dependency-free: we shell out to the system `git` via std::process::Command.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Absolute path to an agent's worktree, OUTSIDE the project tree, under Sparkle's app-data
/// dir. Keyed by project_id (a UUID) so same-named project folders never collide.
pub fn worktree_path(app_data: &Path, project_id: &str, agent_id: &str) -> PathBuf {
    app_data.join("worktrees").join(project_id).join(agent_id)
}

/// Resolve Sparkle's per-user app-data dir (e.g. ~/Library/Application Support/ai.sparkle.desktop).
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("no app data dir: {e}"))
}

#[derive(Serialize)]
pub struct WorktreeInfo {
    /// Absolute path to the agent's isolated worktree directory.
    path: String,
    /// Branch the worktree is checked out on (e.g. `sparkle/agent-<id>`).
    branch: String,
}

/// Run `git -C <cwd> <args...>`, returning trimmed stdout on success or an Err
/// Force every git invocation to fail fast instead of blocking on an interactive
/// credential/host-key/passphrase prompt — a hung subprocess would otherwise freeze the
/// command the UI awaits and defeat the documented "fall back to local branch" path.
fn apply_noninteractive(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "true");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
}

/// carrying stderr (falling back to stdout) on failure.
fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    apply_noninteractive(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        };
        Err(format!("git {} failed: {msg}", args.join(" ")))
    }
}

/// Resolve the project's logical integration branch name. Order: origin/HEAD symref →
/// local `main` → local `master` → the branch currently checked out at `root`.
pub fn resolve_default_branch(root: &str) -> String {
    if let Ok(symref) = git(root, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        // e.g. "refs/remotes/origin/main" -> "main"; preserve slashes in names like
        // "release/2026" by stripping the fixed prefix rather than splitting on the last '/'.
        if let Some(name) = symref.strip_prefix("refs/remotes/origin/") {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    for candidate in ["main", "master"] {
        if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{candidate}")]).is_ok() {
            return candidate.to_string();
        }
    }
    git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "main".to_string())
}

/// The ref creation/status/refresh compare or cut against. With a remote: `origin/<branch>`,
/// fetched first when `fetch` is true. Any fetch failure (offline/auth/unreachable) or a
/// missing remote-tracking ref falls back to the local `<branch>` — a command must never
/// break just because the network is down. `branch` is always a logical name (never `origin/…`).
fn effective_base(root: &str, branch: &str, fetch: bool) -> String {
    // Defensive: a legacy agent whose baseBranch was never persisted can send "" from the
    // frontend. An empty ref would feed `git rebase ""` / `rev-list "...<branch>"` and break the
    // command; resolve the project's default branch instead of trusting the caller.
    let resolved;
    let branch = if branch.trim().is_empty() {
        resolved = resolve_default_branch(root);
        resolved.as_str()
    } else {
        // Trim a whitespace-padded ref too so " main " can't reach git as an invalid ref.
        branch.trim()
    };
    let has_origin = git(root, &["remote", "get-url", "origin"]).is_ok();
    if has_origin {
        if fetch {
            // Best-effort; ignore failure and fall through to the existence check below.
            let _ = git(root, &["fetch", "origin", branch]);
        }
        let remote_ref = format!("origin/{branch}");
        if git(root, &["rev-parse", "--verify", "--quiet", &remote_ref]).is_ok() {
            return remote_ref;
        }
    }
    branch.to_string()
}

/// Auto-detect the project's logical integration branch name (e.g. `main`).
#[tauri::command]
pub fn project_default_branch(root: String) -> Result<String, String> {
    Ok(resolve_default_branch(&root))
}

/// Ensure `<path>` is a git repo with a committable identity, at least one commit,
/// and `.sparkle/` ignored. Idempotent.
#[tauri::command]
pub fn ensure_project_repo(path: String) -> Result<(), String> {
    // 1. Make it a repo if it isn't one yet.
    if git(&path, &["rev-parse", "--git-dir"]).is_err() {
        git(&path, &["init"])?;
    }

    // 2. Ensure a committable identity exists for THIS repo (the user may have no
    //    global git config — worktree commits would otherwise fail).
    if git(&path, &["config", "user.email"]).map(|s| s.is_empty()).unwrap_or(true) {
        git(&path, &["config", "user.email", "agent@sparkle.local"])?;
        git(&path, &["config", "user.name", "Sparkle"])?;
    }

    // 3. Worktrees require a born HEAD — make an empty initial commit if needed.
    if git(&path, &["rev-parse", "HEAD"]).is_err() {
        git(&path, &["commit", "--allow-empty", "-m", "Sparkle: initialize project"])?;
    }

    // 4. Make sure the hidden worktrees dir is never tracked.
    ensure_gitignore(&path)?;

    Ok(())
}

/// Append `.sparkle/` to `<root>/.gitignore` if not already ignored. Idempotent.
fn ensure_gitignore(root: &str) -> Result<(), String> {
    let gitignore: PathBuf = Path::new(root).join(".gitignore");
    let existing = std::fs::read_to_string(&gitignore).unwrap_or_default();

    let already = existing
        .lines()
        .map(|l| l.trim())
        .any(|l| l == ".sparkle/" || l == ".sparkle");
    if already {
        return Ok(());
    }

    let mut contents = existing;
    if !contents.is_empty() && !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(".sparkle/\n");
    std::fs::write(&gitignore, contents)
        .map_err(|e| format!("failed to write .gitignore: {e}"))
}

/// Core (AppHandle-free, testable): create or reuse an agent's worktree under `app_data`,
/// OUTSIDE the project tree. Idempotent: re-running for an existing worktree returns its info.
pub fn create_worktree_at(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Result<WorktreeInfo, String> {
    let branch = format!("sparkle/agent-{agent_id}");

    // Migrate a legacy in-tree worktree (<root>/.sparkle/worktrees/<id>) out to app_data.
    let legacy = Path::new(root).join(".sparkle").join("worktrees").join(agent_id);
    if legacy.exists() {
        let legacy_str = legacy.to_string_lossy().to_string();
        let dirty = git(&legacy_str, &["status", "--porcelain"]).map(|s| !s.is_empty()).unwrap_or(false);
        if dirty {
            return Err(format!(
                "This agent has uncommitted work in its old location ({legacy_str}). \
                 Commit it before reopening so Sparkle can relocate the workspace safely."
            ));
        }
        // Clean: drop the legacy worktree; its branch persists and is re-checked-out below.
        let _ = git(root, &["worktree", "remove", "--force", &legacy_str]);
    }

    let wt = worktree_path(app_data, project_id, agent_id);
    let wt_str = wt.to_string_lossy().to_string();

    // Idempotent: if the path already exists and is a valid worktree, return it.
    if wt.exists() && git(&wt_str, &["rev-parse", "--is-inside-work-tree"]).is_ok() {
        return Ok(WorktreeInfo { path: wt_str, branch });
    }

    // Ensure parent dirs exist (git creates the leaf, but not intermediate dirs).
    if let Some(parent) = wt.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create worktree dir: {e}"))?;
    }

    // Create the branch off HEAD and add the worktree. If the branch already exists
    // from a prior run, fall back to adding a worktree on the existing branch.
    let branch_exists = git(
        root,
        &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")],
    )
    .is_ok();

    if branch_exists {
        git(root, &["worktree", "add", &wt_str, &branch])?;
    } else {
        // Cut from the FRESH integration branch (effective base), never arbitrary HEAD.
        let base = effective_base(root, base_branch, true);
        git(root, &["worktree", "add", "-b", &branch, &wt_str, &base])?;
    }

    Ok(WorktreeInfo { path: wt_str, branch })
}

/// Create (or return, if it already exists) the isolated worktree for `agent_id`.
/// Idempotent: re-running for an existing worktree returns its info without error.
/// `base_branch` is the logical integration branch (e.g. `main`) the new branch is cut from.
#[tauri::command]
pub fn create_agent_worktree(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
) -> Result<WorktreeInfo, String> {
    tracing::info!(%root, %project_id, %agent_id, %base_branch, "create_agent_worktree");
    let app_data = app_data_dir(&app)?;
    create_worktree_at(&root, &project_id, &agent_id, &base_branch, &app_data)
        .inspect_err(|e| tracing::error!(%agent_id, error = %e, "create_agent_worktree failed"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    ahead: u32,
    behind: u32,
    dirty: bool,
    files_changed: u32,
    insertions: u32,
    deletions: u32,
}

/// Core (AppHandle-free, testable): live ahead/behind + dirty + size of an agent branch vs its
/// (no-fetch) effective base. The worktree lives OUTSIDE the project, under `app_data`.
pub fn agent_branch_status_at(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Result<BranchStatus, String> {
    let branch = format!("sparkle/agent-{agent_id}");
    let base = effective_base(root, base_branch, false); // status never hits the network
    let wt = worktree_path(app_data, project_id, agent_id);
    let wt_str = wt.to_string_lossy().to_string();

    // `--left-right --count A...B` emits "<left>\t<right>": left = base-only = behind,
    // right = branch-only = ahead.
    let counts = git(root, &["rev-list", "--left-right", "--count", &format!("{base}...{branch}")])?;
    let mut it = counts.split_whitespace();
    let behind: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);

    // Propagate a failed dirtiness read (e.g. missing worktree) rather than swallowing it to a
    // misleading "clean" false-negative on the common UI-status path.
    let dirty = !git(&wt_str, &["status", "--porcelain"])?.is_empty();

    // numstat: sum insertions/deletions, count file lines.
    let numstat = git(root, &["diff", "--numstat", &format!("{base}...{branch}")]).unwrap_or_default();
    let (mut files_changed, mut insertions, mut deletions) = (0u32, 0u32, 0u32);
    for line in numstat.lines().filter(|l| !l.trim().is_empty()) {
        files_changed += 1;
        let mut cols = line.split_whitespace();
        insertions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0); // "-" for binary -> 0
        deletions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    }

    Ok(BranchStatus { ahead, behind, dirty, files_changed, insertions, deletions })
}

/// Live ahead/behind + dirty + size of an agent branch vs its (no-fetch) effective base.
#[tauri::command]
pub fn agent_branch_status(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
) -> Result<BranchStatus, String> {
    let app_data = app_data_dir(&app)?;
    agent_branch_status_at(&root, &project_id, &agent_id, &base_branch, &app_data)
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum RefreshOutcome {
    Ok { ok: bool, ahead: u32, behind: u32 },
    Err { ok: bool, reason: String, files: Vec<String> },
}

/// Core (AppHandle-free, testable): rebase an agent branch onto its fresh effective base.
/// Preconditions enforced defensively: clean working tree AND no in-progress git operation.
/// Conflicts abort cleanly so the branch is byte-identical to before.
pub fn refresh_agent_branch_at(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Result<RefreshOutcome, String> {
    let wt = worktree_path(app_data, project_id, agent_id);
    let wt = wt.to_string_lossy().to_string();

    // Precondition: clean AND settled (no rebase/merge mid-flight — porcelain can be empty
    // mid-rebase). Propagate a failed status read (e.g. missing/invalid worktree) instead of
    // letting `unwrap_or_default()` report it as "clean" and then rebasing against a bad cwd.
    let dirty = !git(&wt, &["status", "--porcelain"])?.is_empty();
    let git_dir = git(&wt, &["rev-parse", "--git-path", "."]).unwrap_or_default();
    let in_progress = ["rebase-merge", "rebase-apply"].iter().any(|d| {
        Path::new(&wt).join(".git").join(d).exists() || Path::new(&git_dir).join(d).exists()
    }) || git(&wt, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).is_ok();
    if dirty || in_progress {
        return Ok(RefreshOutcome::Err { ok: false, reason: "dirty".into(), files: vec![] });
    }

    let base = effective_base(root, base_branch, true); // fetch fresh tip
    let mut rebase = Command::new("git");
    rebase.arg("-C").arg(&wt).args(["rebase", &base]);
    apply_noninteractive(&mut rebase);
    match rebase.output() {
        Ok(o) if o.status.success() => {
            let st = agent_branch_status_at(root, project_id, agent_id, base_branch, app_data)?;
            Ok(RefreshOutcome::Ok { ok: true, ahead: st.ahead, behind: st.behind })
        }
        _ => {
            // Capture conflicted files, then abort so the branch is byte-identical to before.
            let files = git(&wt, &["diff", "--name-only", "--diff-filter=U"])
                .unwrap_or_default()
                .lines()
                .map(|s| s.to_string())
                .collect();
            let _ = git(&wt, &["rebase", "--abort"]);
            Ok(RefreshOutcome::Err { ok: false, reason: "conflict".into(), files })
        }
    }
}

/// Rebase an agent branch onto its fresh effective base. Refuses a dirty/mid-operation tree;
/// aborts cleanly on conflict. `busy` (a live PTY) is gated on the frontend.
#[tauri::command]
pub fn refresh_agent_branch(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
) -> Result<RefreshOutcome, String> {
    let app_data = app_data_dir(&app)?;
    refresh_agent_branch_at(&root, &project_id, &agent_id, &base_branch, &app_data)
}

/// Core (AppHandle-free, testable): remove an agent's external worktree (force, to discard
/// any uncommitted changes). The branch is intentionally left in place so reopening the agent
/// can resume it. Idempotent: a missing worktree is not an error.
pub fn remove_worktree_at(
    root: &str,
    project_id: &str,
    agent_id: &str,
    app_data: &Path,
) -> Result<(), String> {
    let wt = worktree_path(app_data, project_id, agent_id);
    let wt_str = wt.to_string_lossy().to_string();
    match git(root, &["worktree", "remove", "--force", &wt_str]) {
        Ok(_) => Ok(()),
        Err(e) => {
            // Ignore "not a working tree" / "is not a working tree" so removal is
            // idempotent; surface anything else.
            let lower = e.to_lowercase();
            if lower.contains("not a working tree")
                || lower.contains("is not a working tree")
                || lower.contains("no such file or directory")
            {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

/// Remove an agent's worktree (force, to discard any uncommitted changes). The
/// branch is intentionally left in place so reopening the agent can resume it.
/// Idempotent: a missing worktree is not an error.
///
/// `async` + `spawn_blocking` so the slow part (`git worktree remove --force`,
/// which deletes the whole worktree dir from disk) runs on the blocking thread
/// pool instead of the main thread. A synchronous command would block the event
/// loop and freeze the window for the 2–10s the deletion can take.
#[tauri::command]
pub async fn remove_agent_worktree(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
) -> Result<(), String> {
    tracing::info!(%root, %project_id, %agent_id, "remove_agent_worktree");
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        remove_worktree_at(&root, &project_id, &agent_id, &app_data)
    })
    .await
    .map_err(|e| format!("worktree removal task failed: {e}"))?
}

/// Move/rename a project folder on disk (rename = move within the same parent), then
/// repair the git worktree links so the per-agent worktrees keep working at the new
/// location. Caller must stop the project's agents first (their PTYs hold the old cwd).
#[tauri::command]
pub fn move_project(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);
    if old_path == new_path {
        return Ok(());
    }
    if !old.exists() {
        return Err(format!("the project folder no longer exists at {old_path}"));
    }
    if new.exists() {
        return Err(format!("a folder already exists at {}", new.display()));
    }
    if let Some(parent) = new.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("couldn't create destination: {e}"))?;
    }
    // std::fs::rename works within a volume; across volumes it returns EXDEV.
    std::fs::rename(old, new).map_err(|e| {
        format!("couldn't move the folder (moving across disks isn't supported yet): {e}")
    })?;
    // The repo moved; its per-agent worktrees live OUTSIDE the repo (in app-data) so a bare
    // `worktree repair` from the repo can't discover them. Collect their paths from the repo's
    // admin records and repair them explicitly (repairs both directions of the link).
    if git(&new_path, &["rev-parse", "--git-dir"]).is_ok() {
        let list = git(&new_path, &["worktree", "list", "--porcelain"]).unwrap_or_default();
        let wt_paths: Vec<String> = list
            .lines()
            .filter_map(|l| l.strip_prefix("worktree ").map(|s| s.to_string()))
            .collect();
        let mut args: Vec<&str> = vec!["worktree", "repair"];
        for p in &wt_paths {
            args.push(p);
        }
        let _ = git(&new_path, &args);
    }
    Ok(())
}

/// Tripwire: confirm a worktree path's git toplevel IS that worktree — i.e. it can't resolve
/// up into a parent checkout. Called before spawning an agent's PTY.
#[tauri::command]
pub fn assert_workspace_integrity(worktree: String) -> Result<(), String> {
    let canon_wt = std::fs::canonicalize(&worktree)
        .map_err(|e| format!("worktree path does not exist: {e}"))?;
    let toplevel = git(&worktree, &["rev-parse", "--show-toplevel"])
        .map_err(|e| format!("not a git worktree: {e}"))?;
    let canon_top = std::fs::canonicalize(&toplevel)
        .map_err(|e| format!("cannot resolve toplevel: {e}"))?;
    if canon_top == canon_wt {
        Ok(())
    } else {
        Err(format!(
            "workspace isolation broken: git toplevel is {} but the worktree is {}",
            canon_top.display(), canon_wt.display()
        ))
    }
}

/// Merge the PreToolUse guard hook into existing settings JSON (or a fresh object), preserving
/// any keys the user already has.
pub fn merge_guard_settings(existing: Option<&str>, guard_cmd: &str) -> String {
    let mut root: Value = existing
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let hook_entry = json!({
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": guard_cmd } ]
    });
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let pre = hooks
        .as_object_mut()
        .unwrap()
        .entry("PreToolUse")
        .or_insert_with(|| json!([]));
    if !pre.is_array() {
        *pre = json!([]);
    }
    // Replace any prior Sparkle guard, then push the current one (idempotent).
    let arr = pre.as_array_mut().unwrap();
    arr.retain(|e| {
        !e.get("hooks")
            .and_then(|h| h.get(0))
            .and_then(|h| h.get("command"))
            .and_then(|c| c.as_str())
            .map(|c| c.contains("worktree-guard.mjs"))
            .unwrap_or(false)
    });
    arr.push(hook_entry);
    serde_json::to_string_pretty(&root).unwrap()
}

/// Write/merge the guard into `<worktree>/.claude/settings.local.json` (the gitignored variant).
#[tauri::command]
pub fn install_worktree_guard(app: AppHandle, worktree: String) -> Result<(), String> {
    let guard = app
        .path()
        .resolve("resources/worktree-guard.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("guard script missing: {e}"))?;
    let guard_cmd = format!(
        "node {} {}",
        shell_quote(&guard.to_string_lossy()),
        shell_quote(&worktree)
    );

    let dir = Path::new(&worktree).join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir .claude: {e}"))?;
    let file = dir.join("settings.local.json");
    let existing = std::fs::read_to_string(&file).ok();
    let merged = merge_guard_settings(existing.as_deref(), &guard_cmd);
    std::fs::write(&file, merged).map_err(|e| format!("write settings.local.json: {e}"))
}

/// Minimal POSIX single-quote escaping for embedding a path in a hook command string.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    //! Engine harness (spec §10): proves the "multiple tabs, never overwriting each
    //! other" guarantee headlessly — N isolated worktrees, each driving its own
    //! concurrent PTY in its own directory. Run with `cargo test`.
    use super::*;
    use std::io::Read;
    use std::sync::mpsc;

    fn unique_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sparkle-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Spawn `sh -c <script>` in a PTY with the given cwd, read stdout to EOF, return it.
    /// Mirrors how the app spawns each agent (portable-pty), so it exercises the real
    /// mechanism behind every tab.
    fn pty_run(cwd: &str, script: &str) -> String {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", script]);
        cmd.cwd(cwd);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave); // so the master sees EOF when the child exits
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let _ = reader.read_to_string(&mut out);
        let status = child.wait().expect("pty child wait");
        assert!(status.success(), "pty child exited non-zero: {status:?}");
        out
    }

    #[test]
    fn three_agents_are_isolated_and_each_drives_its_own_pty() {
        let root = unique_root("iso");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("iso-appdata");

        ensure_project_repo(root_str.clone()).expect("ensure repo");

        // .sparkle/ must be ignored so agent worktrees never pollute the user's repo.
        let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|l| l.trim() == ".sparkle/"));

        // Three agents -> three distinct worktrees on three distinct branches.
        let base = resolve_default_branch(&root_str);
        let ids = ["alpha", "beta", "gamma"];
        let mut infos = Vec::new();
        for id in ids {
            let info = create_worktree_at(&root_str, "isoproj", id, &base, &app_data)
                .unwrap_or_else(|e| panic!("worktree for {id}: {e}"));
            assert!(Path::new(&info.path).is_dir(), "{id} worktree dir exists");
            assert_eq!(info.branch, format!("sparkle/agent-{id}"));
            infos.push((id, info));
        }
        let paths: Vec<_> = infos.iter().map(|(_, i)| i.path.clone()).collect();
        assert_eq!(
            paths.iter().collect::<std::collections::HashSet<_>>().len(),
            3,
            "worktree paths are distinct"
        );

        // Idempotent: re-requesting an existing agent's worktree returns the same path.
        let again = create_worktree_at(&root_str, "isoproj", "alpha", &base, &app_data).unwrap();
        assert_eq!(again.path, infos[0].1.path);

        // Drive all three PTYs concurrently; each writes a file IN ITS OWN worktree.
        let (tx, rx) = mpsc::channel();
        let mut handles = Vec::new();
        for (id, info) in &infos {
            let id = id.to_string();
            let path = info.path.clone();
            let tx = tx.clone();
            handles.push(std::thread::spawn(move || {
                let out = pty_run(&path, &format!("echo SPARKLE_{id}; echo {id} > agent.txt"));
                tx.send((id, out)).unwrap();
            }));
        }
        drop(tx);
        for h in handles {
            h.join().unwrap();
        }
        let mut seen = 0;
        for (id, out) in rx.iter() {
            assert!(out.contains(&format!("SPARKLE_{id}")), "pty output for {id}: {out:?}");
            seen += 1;
        }
        assert_eq!(seen, 3, "all three PTYs produced output");

        // Isolation: each worktree has ONLY its own agent.txt with its own content.
        for (id, info) in &infos {
            let mine = std::fs::read_to_string(Path::new(&info.path).join("agent.txt")).unwrap();
            assert_eq!(mine.trim(), *id, "{id} wrote its own file");
            for (other_id, other) in &infos {
                if other_id == id {
                    continue;
                }
                let leaked = std::fs::read_to_string(Path::new(&other.path).join("agent.txt"))
                    .unwrap();
                assert_ne!(leaked.trim(), *id, "{id}'s write must not appear in {other_id}");
            }
        }

        // Removal is clean + idempotent.
        for (id, _) in &infos {
            let wt = worktree_path(&app_data, "isoproj", id);
            let _ = git(&root_str, &["worktree", "remove", "--force", &wt.to_string_lossy()]);
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worktree_path_is_outside_the_project_root() {
        use std::path::Path;
        let app_data = Path::new("/tmp/sparkle-appdata");
        let root = "/Users/dev/Projects/myrepo";
        let p = worktree_path(app_data, "proj-123", "agent-abc");
        assert_eq!(p, Path::new("/tmp/sparkle-appdata/worktrees/proj-123/agent-abc"));
        // The crucial property: the worktree is NOT under the project root.
        assert!(!p.starts_with(root), "worktree must live outside the project tree");
    }

    #[test]
    fn worktree_lives_outside_root_and_toplevel_cannot_escape() {
        let root = unique_root("ext-iso");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("ext-appdata");
        ensure_project_repo(root_str.clone()).unwrap();

        let info = create_worktree_at(&root_str, "proj1", "a1", "HEAD", &app_data).unwrap();

        // 1. The worktree path is OUTSIDE the project root.
        assert!(!Path::new(&info.path).starts_with(&root), "worktree under project root!");
        assert!(Path::new(&info.path).starts_with(&app_data), "worktree not under app_data");

        // 2. THE regression test: rev-parse --show-toplevel from the worktree is the worktree
        //    itself, never the parent checkout.
        let toplevel = git(&info.path, &["rev-parse", "--show-toplevel"]).unwrap();
        let canon_wt = std::fs::canonicalize(&info.path).unwrap();
        assert_eq!(std::fs::canonicalize(&toplevel).unwrap(), canon_wt);
        assert!(!canon_wt.starts_with(std::fs::canonicalize(&root).unwrap()));

        // 3. It is still a real worktree OF the project repo.
        let common = git(&info.path, &["rev-parse", "--git-common-dir"]).unwrap();
        assert!(std::fs::canonicalize(&common).unwrap()
            .starts_with(std::fs::canonicalize(&root).unwrap()));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn remove_worktree_cleans_external_dir_and_is_idempotent() {
        let root = unique_root("rm-ext");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("rm-appdata");
        ensure_project_repo(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();
        assert!(Path::new(&info.path).exists());

        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap();
        assert!(!Path::new(&info.path).exists(), "external worktree dir removed");
        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap(); // twice = no-op

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn moving_project_keeps_external_worktree_usable() {
        let root = unique_root("mv-from");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("mv-appdata");
        ensure_project_repo(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();

        let dest = root.parent().unwrap().join(format!("mv-to-{}", std::process::id()));
        let dest_str = dest.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&dest);
        move_project(root_str.clone(), dest_str.clone()).unwrap();

        // The worktree (in app_data) still works and now points at the repo's NEW location.
        let common = git(&info.path, &["rev-parse", "--git-common-dir"]).unwrap();
        assert!(std::fs::canonicalize(&common).unwrap()
            .starts_with(std::fs::canonicalize(&dest).unwrap()));

        let _ = std::fs::remove_dir_all(&dest);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn integrity_ok_for_real_external_worktree_err_for_nested_dir() {
        let root = unique_root("intg");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("intg-appdata");
        ensure_project_repo(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();

        // A correct external worktree passes.
        assert!(assert_workspace_integrity(info.path.clone()).is_ok());

        // A nested dir inside the project checkout fails (its toplevel is the parent repo).
        let nested = root.join("subdir");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(assert_workspace_integrity(nested.to_string_lossy().to_string()).is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn merge_guard_preserves_existing_settings() {
        // Existing local settings with an unrelated key must survive the merge.
        let existing = r#"{ "model": "opus", "hooks": { "PreToolUse": [] } }"#;
        let merged = merge_guard_settings(Some(existing), "node /abs/worktree-guard.mjs /wt/a");
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["model"], "opus", "unrelated key preserved");
        let hooks = &v["hooks"]["PreToolUse"];
        assert!(hooks.is_array() && !hooks.as_array().unwrap().is_empty(), "guard hook added");
        let cmd = hooks[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("worktree-guard.mjs"));
        assert!(hooks[0]["matcher"].as_str().unwrap().contains("Edit"));
    }

    #[test]
    fn clean_legacy_worktree_is_migrated_dirty_is_refused() {
        let root = unique_root("migrate");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("migrate-appdata");
        ensure_project_repo(root_str.clone()).unwrap();

        // Simulate a legacy nested worktree for agent "a".
        let legacy = root.join(".sparkle").join("worktrees").join("a");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        git(&root_str, &["worktree", "add", "-b", "sparkle/agent-a",
                         &legacy.to_string_lossy(), "HEAD"]).unwrap();

        // Clean legacy → migrates: external worktree created, legacy gone.
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();
        assert!(Path::new(&info.path).starts_with(&app_data));
        assert!(!legacy.exists(), "clean legacy worktree removed");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn refresh_fast_forwards_clean_branch_and_zeroes_behind() {
        let root = unique_root("refresh-ok");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("refresh-ok-appdata");
        ensure_project_repo(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "r1", "main", &app_data).unwrap();
        // Advance main by one commit; agent is now behind 1.
        std::fs::write(root.join("m.txt"), "m").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "main moves"]).unwrap();

        let out = refresh_agent_branch_at(&root_str, "p", "r1", "main", &app_data).unwrap();
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["behind"], serde_json::json!(0), "refresh zeroes behind");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn refresh_refuses_dirty_tree_and_changes_nothing() {
        let root = unique_root("refresh-dirty");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("refresh-dirty-appdata");
        ensure_project_repo(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "r2", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("wip.txt"), "wip").unwrap();
        let before = git(&info.path, &["rev-parse", "HEAD"]).unwrap();

        let out = refresh_agent_branch_at(&root_str, "p", "r2", "main", &app_data).unwrap();
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["ok"], serde_json::json!(false));
        assert_eq!(v["reason"], serde_json::json!("dirty"));
        assert_eq!(git(&info.path, &["rev-parse", "HEAD"]).unwrap(), before, "untouched");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn refresh_aborts_on_conflict_leaving_branch_byte_identical() {
        let root = unique_root("refresh-conflict");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("refresh-conflict-appdata");
        ensure_project_repo(root_str.clone()).unwrap();
        // Seed a shared file on main.
        std::fs::write(root.join("f.txt"), "base\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "seed f"]).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "r3", "main", &app_data).unwrap();
        // Conflicting edits on each side.
        std::fs::write(Path::new(&info.path).join("f.txt"), "agent\n").unwrap();
        git(&info.path, &["commit", "-am", "agent edits f"]).unwrap();
        std::fs::write(root.join("f.txt"), "main\n").unwrap();
        git(&root_str, &["commit", "-am", "main edits f"]).unwrap();
        let before = git(&info.path, &["rev-parse", "HEAD"]).unwrap();

        let out = refresh_agent_branch_at(&root_str, "p", "r3", "main", &app_data).unwrap();
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["ok"], serde_json::json!(false));
        assert_eq!(v["reason"], serde_json::json!("conflict"));
        assert!(v["files"].as_array().unwrap().iter().any(|f| f == "f.txt"));
        assert_eq!(git(&info.path, &["rev-parse", "HEAD"]).unwrap(), before, "abort restored HEAD");
        // No rebase left in progress.
        assert!(git(&info.path, &["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn agent_branch_status_counts_ahead_behind_and_dirty() {
        let root = unique_root("status");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("status-appdata");
        ensure_project_repo(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "s1", "main", &app_data).unwrap();

        // Asymmetric counts (ahead 2 vs behind 1) so a transposed left/right parse would fail.
        std::fs::write(Path::new(&info.path).join("a.txt"), "a1\na2\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work 1"]).unwrap();
        std::fs::write(Path::new(&info.path).join("b.txt"), "b\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work 2"]).unwrap();
        std::fs::write(root.join("m.txt"), "m").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "main work"]).unwrap();

        let st = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert_eq!(st.ahead, 2, "two agent commits");
        assert_eq!(st.behind, 1, "one main commit (left/right mapping correct, not transposed)");
        assert!(!st.dirty, "clean tree");
        // numstat parse: two new files added on the agent side, 3 inserted lines, 0 deletions.
        assert_eq!(st.files_changed, 2, "a.txt + b.txt");
        assert_eq!(st.insertions, 3, "2 + 1 inserted lines");
        assert_eq!(st.deletions, 0);

        // Make it dirty.
        std::fs::write(Path::new(&info.path).join("uncommitted.txt"), "u").unwrap();
        let st2 = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert!(st2.dirty, "uncommitted file flips dirty");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worktree_is_cut_from_base_branch_not_arbitrary_head() {
        let root = unique_root("cut-base");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("cut-base-appdata");
        ensure_project_repo(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        // Move HEAD onto an unrelated branch with a divergent commit.
        git(&root_str, &["checkout", "-b", "scratch"]).unwrap();
        std::fs::write(root.join("scratch.txt"), "x").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "scratch commit"]).unwrap();
        // A new agent based on `main` must NOT contain scratch.txt (cut from main, not HEAD).
        let info = create_worktree_at(&root_str, "p", "agg", "main", &app_data).unwrap();
        assert!(!Path::new(&info.path).join("scratch.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn resolve_default_branch_uses_current_branch_with_no_remote() {
        let root = unique_root("rdb-noremote");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo(root_str.clone()).unwrap();
        // ensure_project_repo's first commit lands on whatever `git init` defaults to.
        let current = git(&root_str, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(resolve_default_branch(&root_str), current);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_default_branch_prefers_local_main() {
        let root = unique_root("rdb-main");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo(root_str.clone()).unwrap();
        // Create a `main` branch even if the repo initialized on `master`.
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        assert_eq!(resolve_default_branch(&root_str), "main");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn effective_base_falls_back_to_local_when_remote_unreachable() {
        let root = unique_root("eb-offline");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        // A remote that cannot be fetched.
        git(&root_str, &["remote", "add", "origin", "file:///nonexistent/repo.git"]).unwrap();
        // fetch:true must NOT panic/return an origin ref it can't reach — falls back to local.
        assert_eq!(effective_base(&root_str, "main", true), "main");
        // fetch:false with no remote-tracking ref also falls back to local.
        assert_eq!(effective_base(&root_str, "main", false), "main");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_project_repo_is_idempotent_on_empty_and_existing() {
        let root = unique_root("idem");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo(root_str.clone()).unwrap();
        // HEAD exists (born) so worktrees are possible.
        assert!(git(&root_str, &["rev-parse", "HEAD"]).is_ok());
        // Running again is a no-op (no second commit, no error).
        let head1 = git(&root_str, &["rev-parse", "HEAD"]).unwrap();
        ensure_project_repo(root_str.clone()).unwrap();
        let head2 = git(&root_str, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(head1, head2, "no extra commit on re-run");
        let _ = std::fs::remove_dir_all(&root);
    }
}

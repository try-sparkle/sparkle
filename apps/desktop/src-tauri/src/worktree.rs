//! Per-agent git worktree isolation (§5 agent lifecycle). Each agent runs in its
//! OWN git worktree on its OWN branch so agents can't clobber each other's files.
//! All git mechanics are hidden from the user — Sparkle frames this as "each agent
//! works in its own safe space" (§2). The hidden worktrees live OUTSIDE the project
//! tree, under `<app_data>/worktrees/<projectId>/<agentId>` (see `worktree_path`), on
//! branch `sparkle/agent-<agentId>`.
//!
//! Dependency-free: we shell out to the system `git` via std::process::Command.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// A frontend-supplied id component (project_id / agent_id / worker_id) that gets joined into a
/// filesystem path AND embedded into a git branch name. These are UUIDs in practice, so we hold
/// them to a strict allowlist: anything with `/`, `..`, a leading `-`, or other path/option
/// metacharacters is rejected before it can escape `<app_data>/worktrees` or weaponize a git arg.
fn validate_id(label: &str, id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err(format!("invalid {label}: must be 1-128 chars"));
    }
    if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(format!("invalid {label}: only [A-Za-z0-9_-] allowed"));
    }
    Ok(())
}

/// Validate a frontend/agent-supplied git ref before it reaches `git` as an argument. Branch
/// names legitimately contain `/` (e.g. `release/2026`), so we don't allowlist; we reject the
/// shapes that turn a ref into a weaponized argument: a leading `-` (parsed as an option such as
/// `--upload-pack=` on fetch or `--exec=` on rebase → command execution) and whitespace/control
/// characters (which git forbids in ref names anyway).
fn validate_ref(branch: &str) -> Result<(), String> {
    let b = branch.trim();
    if b.is_empty() {
        return Err("empty git ref".into());
    }
    if b.starts_with('-') {
        return Err(format!("refusing git ref starting with '-': {b:?}"));
    }
    if b.bytes().any(|c| c.is_ascii_control() || c == b' ') {
        return Err(format!("git ref has whitespace/control chars: {b:?}"));
    }
    Ok(())
}

/// Absolute path to an agent's worktree, OUTSIDE the project tree, under Sparkle's app-data
/// dir. Keyed by project_id (a UUID) so same-named project folders never collide. Validates both
/// id components (Err on path-traversal / metacharacters) so a malicious id can't escape the dir.
pub fn worktree_path(app_data: &Path, project_id: &str, agent_id: &str) -> Result<PathBuf, String> {
    validate_id("project_id", project_id)?;
    validate_id("agent_id", agent_id)?;
    Ok(app_data.join("worktrees").join(project_id).join(agent_id))
}

/// Resolve Sparkle's per-user app-data dir (e.g. ~/Library/Application Support/ai.sparkle.desktop).
/// Routes through `dev_identity` so DEBUG builds get the isolated `-dev` sibling and never mutate
/// production workspace state.
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::dev_identity::app_data_dir(app)
}

/// Public wrapper around `app_data_dir` for use by other modules (e.g. bridge.rs).
pub fn app_data_dir_pub(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_dir(app)
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
    let mut cmd = Command::new(crate::preflight::git_program());
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

/// Wall-clock ceiling for the NETWORK-touching subprocesses (`git fetch`, `gh`). On a network
/// partition such a child otherwise hangs for the OS default (~75s+ TCP timeout), and since
/// `project_agents_status` runs these per changed agent on a ~30s poll, stuck children pile up on
/// Tauri's blocking pool. Only the network touches go through this deadline — local ref reads
/// (rev-parse, status of local worktrees, merge-base) are unaffected and stay on the plain `git()`.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(15);

/// Run `cmd` to completion but ABORT it after `timeout`, killing the child and returning an Err.
/// std-only (no tokio, per the backend constraint): the child stays owned here so we can kill it,
/// two reader threads drain stdout/stderr concurrently (so a chatty child can't deadlock on a full
/// pipe while we wait), and we poll `try_wait` until the deadline (std has no wait-with-timeout).
pub(crate) fn output_with_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    use std::io::Read;
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn: {e}"))?;

    // Move each pipe into its own reader thread. read_to_end blocks until the write end closes
    // (child exit or kill), so a large output is fully drained rather than deadlocking the child.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout_pipe {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr_pipe {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    // Deadline hit: kill and reap the child, then join the readers (which EOF once
                    // the child's pipes close) so no threads leak, and report the timeout.
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_reader.join();
                    let _ = err_reader.join();
                    return Err(format!("timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(format!("wait failed: {e}"));
            }
        }
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(std::process::Output { status, stdout, stderr })
}

/// Like [`git`], but for the NETWORK-touching invocations (a `fetch`): bounds the wall-clock via
/// [`output_with_timeout`] so a partition can't hang the child for the OS default. Same
/// non-interactive env and stdout/stderr-on-failure semantics as `git`; a timeout reads as an Err
/// (which every caller already treats as "offline/degrade — fall back to the local ref").
fn git_networked(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.arg("-C").arg(cwd).args(args);
    apply_noninteractive(&mut cmd);
    let output = output_with_timeout(cmd, NETWORK_TIMEOUT)
        .map_err(|e| format!("git {} failed: {e}", args.join(" ")))?;
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

/// Resolve the project's logical integration branch name. An explicit `[workflow].default_branch`
/// from the editable config (per-project file beats global) wins; otherwise auto-detect in order:
/// origin/HEAD symref → local `main` → local `master` → the branch currently checked out at `root`.
pub fn resolve_default_branch(root: &str) -> String {
    // Config override: a non-empty default_branch pins the base; empty means "auto-detect" below.
    let configured = crate::config::for_project(root).config.workflow.default_branch;
    let configured = configured.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
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
///
/// Guarantees a ref that actually RESOLVES, never a phantom name: `origin/<branch>` →
/// local `<branch>` → detected default (local or `origin/<default>`) → `HEAD` → the original
/// name (only when nothing resolves, e.g. an unborn HEAD). The last two fallbacks fire ONLY
/// when the recorded base has drifted to something git can't resolve — a state in which the
/// prior "return the name verbatim" behavior already hard-failed every caller. So for the
/// status/rebase `rev-list` callers, a `HEAD` return is a graceful degradation (compare/cut
/// against the current checkout) of a case that used to error outright, not a regression of a
/// path that previously worked.
fn effective_base(root: &str, branch: &str, fetch: bool) -> String {
    // Defensive: a legacy agent whose baseBranch was never persisted can send "" from the
    // frontend. An empty ref would feed `git rebase ""` / `rev-list "...<branch>"` and break the
    // command; resolve the project's default branch instead of trusting the caller.
    let resolved;
    let trimmed = branch.trim();
    let branch = if trimmed.is_empty() || validate_ref(trimmed).is_err() {
        // Empty (a legacy agent whose baseBranch was never persisted) OR a ref crafted to be
        // parsed as a git option (leading '-' → --upload-pack=/--exec=) or carrying control
        // chars: never hand it to git. Resolve the project's default branch instead. git forbids
        // '-'-leading branch names, so no legitimate ref is lost by this fallback.
        if !trimmed.is_empty() {
            tracing::warn!(rejected = %trimmed, "effective_base: unsafe base ref, using default branch");
        }
        resolved = resolve_default_branch(root);
        resolved.as_str()
    } else {
        trimmed
    };
    let has_origin = git(root, &["remote", "get-url", "origin"]).is_ok();
    if has_origin {
        if fetch {
            // Best-effort; ignore failure and fall through to the existence check below.
            // Network touch → bounded wall-clock so a partition can't hang this for the OS default.
            let _ = git_networked(root, &["fetch", "origin", branch]);
        }
        let remote_ref = format!("origin/{branch}");
        if git(root, &["rev-parse", "--verify", "--quiet", &remote_ref]).is_ok() {
            return remote_ref;
        }
    }
    // The logical base may not exist as a LOCAL branch either — a recorded default that has since
    // drifted from reality: the repo was renamed (`main` → `master`), the base branch was deleted,
    // or the project was re-cloned with a different default. Handing a name that resolves to nothing
    // straight to `git worktree add … <base>` fails with a cryptic `fatal: invalid reference: <name>`
    // that a user installing Sparkle has no way to act on. Guarantee a resolvable commit-ish instead:
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok() {
        return branch.to_string();
    }
    // Requested base is a phantom. Fall back to the repo's ACTUAL default branch (origin/HEAD →
    // local main → local master → checked-out branch), honoring it as either a local branch or a
    // remote-tracking ref — a fresh clone's default frequently exists only as `origin/main` with no
    // local counterpart yet, so a local-only check would wrongly skip it.
    let detected = resolve_default_branch(root);
    if detected != branch {
        if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{detected}")]).is_ok() {
            tracing::warn!(
                requested = %branch, using = %detected,
                "effective_base: recorded base branch not found; falling back to detected default"
            );
            return detected;
        }
        if has_origin {
            let detected_remote = format!("origin/{detected}");
            if git(root, &["rev-parse", "--verify", "--quiet", &detected_remote]).is_ok() {
                tracing::warn!(
                    requested = %branch, using = %detected_remote,
                    "effective_base: recorded base branch not found; falling back to detected default (remote)"
                );
                return detected_remote;
            }
        }
    }
    // Neither the requested base nor a named default resolves (e.g. origin/HEAD points at a branch
    // with no local counterpart, or an unusual layout). HEAD always resolves in a repo with a born
    // commit — and the create path ensures one — so cutting the new branch from it beats erroring.
    if git(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
        tracing::warn!(
            requested = %branch,
            "effective_base: no named base branch resolves; using HEAD as the cut point"
        );
        return "HEAD".to_string();
    }
    // Truly nothing resolves (unborn HEAD / empty repo). Return the original name and let the
    // caller's born-HEAD handling or git's own error surface a clear, actionable failure.
    branch.to_string()
}

/// Auto-detect the project's logical integration branch name (e.g. `main`).
#[tauri::command]
pub async fn project_default_branch(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(resolve_default_branch(&root)))
        .await
        .map_err(|e| format!("project_default_branch task failed: {e}"))?
}

/// Reconcile a project's PERSISTED integration branch against reality (AppHandle-free, testable).
/// A non-empty `recorded` that still resolves — local `refs/heads/<recorded>` OR a remote-tracking
/// `refs/remotes/origin/<recorded>` — is honored verbatim, so a deliberate non-default choice (a
/// feature integration branch set in Project settings) is never silently overwritten. Otherwise —
/// empty, or a name that has drifted to something git can't resolve (repo renamed `main` → `master`,
/// base branch deleted, re-cloned with a different default) — the repo's actual default is returned
/// so the caller can re-persist a valid value. This is the STORE-healing companion to
/// `effective_base`: `effective_base` fixes the cut point at spawn time, this stops the UI from
/// lingering on a phantom base and keeps new agents from inheriting one. Always non-empty:
/// `resolve_default_branch`'s terminal fallback is the literal `"main"`.
pub fn reconcile_default_branch_at(root: &str, recorded: &str) -> String {
    let trimmed = recorded.trim();
    if !trimmed.is_empty() && validate_ref(trimmed).is_ok() {
        let resolves = git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{trimmed}")]).is_ok()
            || git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{trimmed}")]).is_ok();
        if resolves {
            return trimmed.to_string();
        }
    }
    resolve_default_branch(root)
}

/// Tauri wrapper around [`reconcile_default_branch_at`]. Runs off the main thread (git subprocesses).
#[tauri::command]
pub async fn reconcile_default_branch(root: String, recorded: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(reconcile_default_branch_at(&root, &recorded)))
        .await
        .map_err(|e| format!("reconcile_default_branch task failed: {e}"))?
}

/// Roots whose repo has already been ensured this session. `ensure_project_repo` is idempotent but
/// runs 3-4 git subprocesses; caching "ready" means only the FIRST agent per project pays that cost
/// (subsequent concurrent opens hit the fast path instead of re-running init/config/commit checks).
fn ready_repos() -> &'static Mutex<HashSet<String>> {
    static READY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    READY.get_or_init(|| Mutex::new(HashSet::new()))
}

/// If `<path>/.git` is a gitfile (an orphaned worktree/submodule pointer) whose target gitdir no
/// longer exists, rename it aside so a fresh `git init` can succeed. A real `.git` *directory*, or a
/// gitfile whose target still exists (a live worktree/submodule), is left completely untouched — the
/// caller only reaches here after `git rev-parse --git-dir` already failed, so a healthy repo never
/// gets this far. Best-effort: any I/O error leaves `.git` as-is and lets `git init` report the fault.
fn clear_dangling_gitfile(path: &str) {
    let dot_git = Path::new(path).join(".git");
    // Only a regular file is a gitfile; a real `.git` directory (or symlink) is never touched.
    match std::fs::symlink_metadata(&dot_git) {
        Ok(meta) if meta.is_file() => {}
        _ => return,
    }
    let Ok(contents) = std::fs::read_to_string(&dot_git) else { return };
    // gitfile format is a first line `gitdir: <path>`. Read only that line so a valid but
    // multi-line file can't smuggle an embedded newline into the target and get mis-resolved.
    let Some(target) = contents.lines().next().and_then(|l| l.strip_prefix("gitdir:")).map(str::trim) else { return };
    if target.is_empty() {
        return;
    }
    // Relative targets resolve against the directory that holds `.git`.
    let target_path = Path::new(target);
    let resolved = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        Path::new(path).join(target_path)
    };
    if resolved.exists() {
        return; // live worktree/submodule — do not disturb it.
    }
    // Dangling pointer: move it aside rather than hard-deleting, so nothing is silently destroyed.
    let aside = Path::new(path).join(".git.orphaned");
    // Clear any prior salvage (file OR directory) so the rename can't fail on a name collision.
    let _ = std::fs::remove_file(&aside).or_else(|_| std::fs::remove_dir_all(&aside));
    let _ = std::fs::rename(&dot_git, &aside);
}

/// Ensure `<path>` is a git repo with a committable identity, at least one commit,
/// and `.sparkle/` ignored. Idempotent. Cached per root for the session (see [`ready_repos`]).
/// Sync core of [`ensure_project_repo`] (the git-subprocess work). Kept as a plain fn so the
/// async command can offload it via `spawn_blocking` and the test suite can drive it directly.
fn ensure_project_repo_inner(path: String) -> Result<(), String> {
    // Fast path: already ensured this session. The underlying work is idempotent, so this only
    // skips redundant git subprocesses — the first successful call is what seeds the set.
    if ready_repos().lock().map(|s| s.contains(&path)).unwrap_or(false) {
        return Ok(());
    }

    // 1. Make it a repo if it isn't one yet.
    if git(&path, &["rev-parse", "--git-dir"]).is_err() {
        // An orphaned worktree — a `.git` *file* (gitfile) pointing at a worktree/submodule
        // admin dir that no longer exists — leaves the files intact but unreachable by git.
        // A plain `git init` then follows the dangling pointer and dies with
        // "fatal: not a git repository: <gitdir>", surfacing as "Couldn't start this agent".
        // Move the dead pointer aside first so we can initialize a fresh standalone repo from
        // the surviving files. Live worktrees pass the rev-parse check above and never reach here.
        clear_dangling_gitfile(&path);
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

    // Mark ready so subsequent agents on this root skip the checks above.
    if let Ok(mut set) = ready_repos().lock() {
        set.insert(path);
    }
    Ok(())
}

/// Ensure `<path>` is a git repo with a committable identity, at least one commit, and `.sparkle/`
/// ignored. Idempotent. `async` + `spawn_blocking` so the 3-4 git subprocesses the first agent per
/// project pays never stall the UI thread.
///
/// After the repo is ensured, best-effort installs the roborev per-commit review hooks into the
/// repo's `.git/hooks` when `[tools].roborev` is on — so every commit (including those in the
/// `.sparkle/` agent worktrees, which share the common-dir hooks) gets reviewed. Hook installation
/// NEVER fails the command: a missing bundled resource / copy error is logged and swallowed. The
/// `app` arg is injected by Tauri; the JS `invoke("ensure_project_repo", { path })` is unchanged.
#[tauri::command]
pub async fn ensure_project_repo(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_project_repo_inner(path.clone())?;
        // Best-effort roborev hook wiring, gated on BOTH the machine-wide [tools].roborev toggle AND
        // the one-time consent having been resolved — so we never review (or touch .git/hooks in) a
        // user's repo before they've answered the consent prompt, matching the daemon-ensure gate in
        // lib.rs. On Enable the frontend sweeps install_repo_hooks over existing projects. Kept OUT
        // of ensure_project_repo_inner so its direct-call unit tests stay hook-free.
        let cfg = crate::config::for_project(&path).config;
        if cfg.tools.roborev && cfg.roborev.consent_prompted {
            if let Err(e) = install_repo_hooks(&app, &path) {
                tracing::warn!(%path, error = %e, "roborev hook install failed (non-fatal)");
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("ensure_project_repo task failed: {e}"))?
}

/// The two git hooks roborev drives, and the marker substring the vendored copy of each carries.
/// `remove_repo_hooks` uses the marker to ensure it only ever deletes a hook that is OURS, never a
/// user's own same-named hook. The markers are stable comment lines in the bundled scripts.
// The marker is a DISTINCTIVE line the vendored script carries (not the bare phrase "roborev
// post-commit", which a user's own hook could mention in a comment) so ownership detection can't
// misfire on a foreign hook.
const ROBOREV_HOOKS: &[(&str, &str)] = &[
    ("post-commit", "seed-owned wrapper"),
    ("post-rewrite", "vendored copy owned by the Sparkle app"),
];

/// Decide whether it is safe to write our vendored hook over what is at `dest`. NEVER clobber a
/// user's own same-named hook: write only when nothing is there, or when a readable existing file is
/// already OURS (carries the vendored marker). CRITICAL: `exists` and `contents` are separate — a
/// git hook can be a compiled binary or a non-UTF-8 / unreadable script, where reading-as-text fails
/// (`contents == None`) even though the file IS present. Collapsing that into "absent" would silently
/// overwrite the foreign hook — the exact data loss this guards against — so a present-but-unreadable
/// hook is treated as foreign and preserved. Pure, so the rule is unit-tested without the resolver.
fn may_write_hook(exists: bool, contents: Option<&str>, marker: &str) -> bool {
    if !exists {
        return true; // nothing there — safe to install
    }
    match contents {
        Some(c) => c.contains(marker), // readable → ours (refresh) iff the vendored marker is present
        None => false,                 // present but unreadable (binary / permission) → foreign, preserve
    }
}

/// Resolve the directory git actually reads hooks from for the repo at `repo_root`.
///
/// `<repo_root>/.git` is a DIRECTORY only in a normal clone. In a linked worktree it is a gitlink
/// *file* pointing at the real gitdir, so joining `.git/hooks` yields a path under a regular file —
/// `create_dir_all` there fails with ENOTDIR and hook install never happens. `--git-common-dir`
/// returns the shared gitdir in both layouts, so a worktree correctly resolves to its parent repo's
/// hooks.
///
/// KNOWN LIMITATION: this is where git runs hooks from *unless* `core.hooksPath` is set, which
/// redirects them elsewhere; hooks we install here are then never executed. We deliberately do NOT
/// resolve via `--git-path hooks` (which would honour `core.hooksPath`), because that config is
/// frequently set GLOBALLY to a directory shared by every repo on the machine — installing into it
/// would silently affect repos the user never opened in this app. Confining our writes to this
/// repo's own gitdir is the safer failure: ineffective, not invasive.
///
/// Git may answer with a path relative to `repo_root` (typically a bare `.git`), so a relative
/// answer is re-anchored. If git can't be run at all we fall back to the literal `.git/hooks` —
/// correct for the normal-clone majority and no worse than the previous behaviour.
fn hooks_dir_for(repo_root: &str) -> PathBuf {
    let common = git(repo_root, &["rev-parse", "--git-common-dir"])
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    match common {
        Some(dir) if dir.is_absolute() => dir.join("hooks"),
        Some(dir) => Path::new(repo_root).join(dir).join("hooks"),
        None => Path::new(repo_root).join(".git").join("hooks"),
    }
}

/// Copy the vendored roborev git hooks into the repo's hooks dir, mode 0755. Idempotent, and
/// NON-DESTRUCTIVE: a pre-existing hook that is not ours (no vendored marker) is left untouched
/// (see `may_write_hook`) — since `[tools].roborev` defaults on and this runs for every project,
/// silently overwriting a user's own `post-commit`/`post-rewrite` would be data loss. Each script is
/// resolved from the app bundle's `resources/roborev/<name>` and `.exists()`-guarded, so a dev build
/// with un-bundled resources degrades to a clear Err rather than a panic. Git worktrees share the
/// common-dir hooks (see `hooks_dir_for`), so installing once transparently covers every
/// `.sparkle/` agent worktree cut from the repo — and works when `repo_root` IS such a worktree.
pub fn install_repo_hooks(app: &AppHandle, repo_root: &str) -> Result<(), String> {
    let hooks_dir = hooks_dir_for(repo_root);
    std::fs::create_dir_all(&hooks_dir)
        .map_err(|e| format!("cannot create {hooks_dir:?}: {e}"))?;

    for (name, marker) in ROBOREV_HOOKS {
        let src = app
            .path()
            .resolve(
                format!("resources/roborev/{name}"),
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("bundled roborev {name} hook missing: {e}"))?;
        if !src.exists() {
            return Err(format!(
                "bundled roborev {name} hook not found at {} (run apps/desktop build to bundle it)",
                src.display()
            ));
        }
        let dest = hooks_dir.join(name);
        // Never clobber a user's own hook: skip if a foreign hook already sits here. Pass existence
        // separately from readable contents so a present-but-unreadable (binary/perm) hook is NOT
        // mistaken for "absent" and overwritten.
        if !may_write_hook(dest.exists(), std::fs::read_to_string(&dest).ok().as_deref(), marker) {
            tracing::info!(
                hook = %name, repo = %repo_root,
                "preserving a pre-existing non-roborev {name} hook (not overwriting)"
            );
            continue;
        }
        std::fs::copy(&src, &dest)
            .map_err(|e| format!("copying roborev {name} hook to {dest:?} failed: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod roborev {name} hook failed: {e}"))?;
        }
    }
    Ok(())
}

/// Remove the roborev git hooks from the repo's hooks dir, but ONLY when a hook's contents mark
/// it as ours (the vendored marker substring) — a user's own same-named hook is left untouched. A
/// missing hook is a no-op. Idempotent. Best-effort per file: an unreadable/undeletable hook is
/// skipped rather than aborting the sweep.
pub fn remove_repo_hooks(repo_root: &str) -> Result<(), String> {
    let hooks_dir = hooks_dir_for(repo_root);
    for (name, marker) in ROBOREV_HOOKS {
        let hook = hooks_dir.join(name);
        // Only touch a hook that EXISTS and whose contents identify it as ours.
        let Ok(contents) = std::fs::read_to_string(&hook) else {
            continue; // missing or unreadable — nothing of ours to remove
        };
        if contents.contains(marker) {
            let _ = std::fs::remove_file(&hook); // best-effort; a failure just leaves it in place
        }
    }
    Ok(())
}

/// Thin Tauri wrapper: install the roborev hooks into `path`'s repo (frontend toggle-on sweep).
#[tauri::command]
pub async fn install_repo_hooks_cmd(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_repo_hooks(&app, &path))
        .await
        .map_err(|e| format!("install_repo_hooks task failed: {e}"))?
}

/// Thin Tauri wrapper: remove the roborev hooks from `path`'s repo (frontend toggle-off sweep).
#[tauri::command]
pub async fn remove_repo_hooks_cmd(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_repo_hooks(&path))
        .await
        .map_err(|e| format!("remove_repo_hooks task failed: {e}"))?
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

    let wt = worktree_path(app_data, project_id, agent_id)?;
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
        // RESUME: the branch already exists (a reopened agent whose worktree dir was removed). Re-
        // attach it directly — NOT via the pool, whose slots are fresh detached checkouts that would
        // discard the branch's existing commits. Under the per-repo lock so a background warm can't
        // collide on index.lock.
        let gl = repo_git_lock(root);
        let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());
        git(root, &["worktree", "add", &wt_str, &branch])?;
    } else {
        // FAST PATH: claim a pre-warmed parked worktree if one is available and still cut from the
        // current base. The claim moves it to `wt` and cuts `branch` there — an identical result to
        // the slow path below, minus the multi-second tree materialization.
        if let Some(info) = try_claim_pooled_worktree(root, project_id, agent_id, base_branch, app_data) {
            // Preserve the slow path's cadence: kick the throttled `origin/<base>` refresh (so a
            // fully-warmed workflow, where every spawn claims, still nudges the fetch), then refill
            // the slot we just consumed. Both off the critical path.
            spawn_background_origin_refresh(root, base_branch);
            spawn_pool_topup(root, project_id, base_branch, app_data);
            return Ok(info);
        }
        // SLOW PATH (pool disabled / empty / stale): cut IMMEDIATELY from the last-known integration
        // base (no blocking network fetch on the spawn critical path — an unreachable remote must
        // never stall opening an agent). A background, throttled fetch then refreshes `origin/<base>`
        // so the NEXT agent's cut and this branch's later refresh see a fresh tip. Held under the
        // per-repo lock so a background warm can't collide on index.lock.
        let base = effective_base(root, base_branch, false);
        // `effective_base` guarantees a RESOLVABLE ref in every normal repo, but documents one
        // terminal case where it hands back the logical name verbatim: an unborn HEAD / empty repo
        // where nothing — not origin/<base>, a local branch, the detected default, nor even HEAD —
        // resolves to a commit. Feeding that name straight to `git worktree add -b … <base>` dead-ends
        // with a cryptic `fatal: invalid reference: main` (seen in the wild) that reads like a Sparkle
        // bug and gives the user nothing to act on. Pre-check the cut point and, when it has no commit,
        // return the actionable message `effective_base`'s own contract defers to the caller for.
        if git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).is_err() {
            return Err(format!(
                "Can't open an agent here: the base branch '{base}' has no commits yet, so there's \
                 nothing to branch a workspace from. Make an initial commit in this repository, then \
                 try again."
            ));
        }
        {
            let gl = repo_git_lock(root);
            let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());
            git(root, &["worktree", "add", "-b", &branch, &wt_str, &base])?;
        }
        spawn_background_origin_refresh(root, base_branch);
        // Seed/refill the pool so the NEXT spawn in this fan-out can claim instead of cutting inline.
        spawn_pool_topup(root, project_id, base_branch, app_data);
    }

    Ok(WorktreeInfo { path: wt_str, branch })
}

/// Cut a worker's worktree from a parent agent's LOCAL branch, with NO network fetch.
/// Workers branch off another agent's local branch (e.g. `sparkle/agent-<build>`), which never
/// exists on a remote — so unlike `create_worktree_at` we never touch `origin`. Idempotent.
pub fn create_worktree_from_local(
    root: &str,
    project_id: &str,
    worker_id: &str,
    local_base_branch: &str,
    app_data: &Path,
) -> Result<WorktreeInfo, String> {
    let base = local_base_branch.trim();
    if base.is_empty() {
        return Err("parent_branch is required".into());
    }
    // Reject a ref shaped like a git option / with control chars before it reaches any git arg.
    validate_ref(base)?;
    // The base must exist locally — workers descend from a sibling agent's local branch.
    git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{base}")])
        .map_err(|_| format!("parent branch '{base}' does not exist locally"))?;

    let branch = format!("sparkle/agent-{worker_id}");
    let wt = worktree_path(app_data, project_id, worker_id)?;
    let wt_str = wt.to_string_lossy().to_string();

    // Idempotent: existing valid worktree → return it. This path is keyed by `worker_id`, which
    // is a fresh UUID per worker agent and never reused across cuts, so an existing worktree here
    // is always THIS worker's own (already on `sparkle/agent-<worker_id>`) — not a stale cut from
    // a different base. We therefore don't re-verify its branch/ancestry.
    if wt.exists() && git(&wt_str, &["rev-parse", "--is-inside-work-tree"]).is_ok() {
        return Ok(WorktreeInfo { path: wt_str, branch });
    }
    if let Some(parent) = wt.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create worktree dir: {e}"))?;
    }

    let branch_exists =
        git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if branch_exists {
        // Recovery path: the worker's own branch already exists but its worktree dir is gone
        // (e.g. externally deleted). Under the UUID `worker_id` invariant this branch is always
        // THIS worker's — already cut from `base` on the first call — so re-attaching it (rather
        // than re-cutting from `base`) is correct and preserves the lineage established then. We
        // intentionally do NOT pass `base` here: a re-cut would discard the worker's own commits.
        git(root, &["worktree", "add", &wt_str, &branch])?;
    } else {
        git(root, &["worktree", "add", "-b", &branch, &wt_str, base])?;
    }
    Ok(WorktreeInfo { path: wt_str, branch })
}

/// Create (or return) a worker's worktree, cut from `parent_branch` (a local branch).
#[tauri::command]
pub async fn create_worker_worktree(
    app: AppHandle,
    root: String,
    project_id: String,
    worker_id: String,
    parent_branch: String,
) -> Result<WorktreeInfo, String> {
    tracing::info!(%root, %project_id, %worker_id, %parent_branch, "create_worker_worktree");
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree_from_local(&root, &project_id, &worker_id, &parent_branch, &app_data)
            .inspect_err(|e| tracing::error!(%worker_id, error = %e, "create_worker_worktree failed"))
    })
    .await
    .map_err(|e| format!("create_worker_worktree task failed: {e}"))?
}

/// Create (or return, if it already exists) the isolated worktree for `agent_id`.
/// Idempotent: re-running for an existing worktree returns its info without error.
/// `base_branch` is the logical integration branch (e.g. `main`) the new branch is cut from.
#[tauri::command]
pub async fn create_agent_worktree(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
) -> Result<WorktreeInfo, String> {
    tracing::info!(%root, %project_id, %agent_id, %base_branch, "create_agent_worktree");
    let app_data = app_data_dir(&app)?;
    // Run the git worktree mechanics off the main thread so the subprocess work (and any residual
    // git I/O) can't freeze the UI. The network fetch is now backgrounded inside `create_worktree_at`,
    // so this task is bounded by local git only.
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree_at(&root, &project_id, &agent_id, &base_branch, &app_data)
            .inspect_err(|e| tracing::error!(%agent_id, error = %e, "create_agent_worktree failed"))
    })
    .await
    .map_err(|e| format!("create_agent_worktree task failed: {e}"))?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    ahead: u32,
    behind: u32,
    /// Uncommitted changes in the agent's worktree. ONLY meaningful when `worktree_on_branch`
    /// is true — see that field. Every OTHER field on this struct is derived from the branch
    /// REF and is therefore immune to whatever the worktree happens to be checked out to.
    dirty: bool,
    files_changed: u32,
    insertions: u32,
    deletions: u32,
    /// Does the worktree actually have `sparkle/agent-<id>` checked out? Normally yes. It goes
    /// false when something moved the worktree off its own branch — the old `land.sh` checked
    /// `main` out into agent worktrees (sparkle-rhgm), and a manual checkout does it too.
    ///
    /// When false, `dirty` is reported as false, and that false means "NOT KNOWN", not "clean":
    /// the tree sitting there belongs to some other branch, so its dirt is not this branch's
    /// dirt and must not be asserted as such. Consumers must not apply the unsaved-edits stage
    /// floor on a false reading. Same unknown-vs-false shape as `hasRemote` in WorkflowState.
    worktree_on_branch: bool,
}

/// Status for an agent branch whose base ref can't be resolved: there's no base to diverge from,
/// so count the branch's OWN commits as `ahead` (behind 0) and skip the base diff. `dirty` is passed
/// through from the caller's worktree read. Shared by both the single-agent and batched status paths
/// so their unresolvable-base guards can't drift apart.
fn ahead_only_status(root: &str, branch: &str, dirty: bool, worktree_on_branch: bool) -> BranchStatus {
    let ahead = git(root, &["rev-list", "--count", branch])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    BranchStatus { ahead, behind: 0, dirty, files_changed: 0, insertions: 0, deletions: 0, worktree_on_branch }
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
    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt_str = wt.to_string_lossy().to_string();

    // Is the worktree actually on the branch we're reporting about? Something may have moved it
    // (the old land.sh checked `main` out into agent worktrees — sparkle-rhgm; a manual checkout
    // does it too). If it has, the tree there belongs to a DIFFERENT branch, so its dirt is not
    // this branch's dirt. A missing tree is not a mismatch — that case is handled below and has
    // its own long-standing meaning.
    let worktree_on_branch = if wt.exists() {
        git(&wt_str, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|h| h.trim() == branch)
            .unwrap_or(false)
    } else {
        false
    };

    // Dirtiness needs the actual worktree. When it's GONE (a landed/cleaned-up agent whose tab
    // stays open and keeps getting polled), a removed tree has no uncommitted changes — report
    // dirty=false instead of erroring, so the 30s poll doesn't re-fail every tick forever and
    // bury real errors in the log. When the tree EXISTS, still propagate a failed read rather than
    // masking it as a misleading "clean" false-negative on the common UI-status path.
    //
    // `dirty` stays the RAW worktree reading even when the worktree is parked — deliberately.
    // Two consumers need opposite things from it and only the caller knows which:
    //   - stage/bead attribution must NOT count another branch's dirt as this branch's work
    //   - close-safety must NOT tear down a tree that may still hold uncommitted files; parking
    //     CARRIES uncommitted changes along, so they are still there and still the user's
    // Zeroing it here would silently serve the first at the cost of the second, and the second
    // loses data (see shouldPromptOnClose, which already errs toward prompting on unknown).
    // So: report what is there, publish `worktree_on_branch`, and let each consumer decide.
    let dirty = if wt.exists() {
        !git(&wt_str, &["status", "--porcelain"])?.is_empty()
    } else {
        false
    };

    // A brand-new or non-git agent (chat/think/shell, or one polled before its first commit) has no
    // `sparkle/agent-<id>` ref yet. `rev-list <base>...<missing>` then hard-fails with
    // "fatal: ambiguous argument ... unknown revision" — an error the removed-worktree latch
    // (isWorktreeGoneError in runtimeStore.ts) does NOT match, so the 30s poll would re-fail every
    // tick for the app's lifetime, spam the log, and never resolve. There's no divergence to count
    // against a ref that doesn't exist: return a zeroed status (mirrors the born-fresh model), still
    // reflecting the worktree's dirty state.
    if git(
        root,
        &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")],
    )
    .is_err()
    {
        return Ok(BranchStatus { ahead: 0, behind: 0, dirty, files_changed: 0, insertions: 0, deletions: 0, worktree_on_branch });
    }

    // The agent branch exists, but its RESOLVED base may not: `effective_base` documents an
    // unborn/HEAD-less fallback that can hand back a name git cannot resolve. `rev-list
    // <unresolvable-base>...<branch>` then hard-fails with "fatal: ambiguous argument", failing the
    // whole status read on EVERY 30s poll for the app's lifetime — spamming the log and never
    // resolving. There's no divergence to measure against a base that doesn't exist, so report the
    // branch's own commits as `ahead` (behind 0 — the born-off-nothing model), still reflecting the
    // worktree's dirty state, instead of erroring.
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).is_err() {
        return Ok(ahead_only_status(root, &branch, dirty, worktree_on_branch));
    }

    // `--left-right --count A...B` emits "<left>\t<right>": left = base-only = behind,
    // right = branch-only = ahead.
    let counts = git(root, &["rev-list", "--left-right", "--count", &format!("{base}...{branch}")])?;
    let mut it = counts.split_whitespace();
    let behind: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);

    // numstat: sum insertions/deletions, count file lines.
    let numstat = git(root, &["diff", "--numstat", &format!("{base}...{branch}")]).unwrap_or_default();
    let (mut files_changed, mut insertions, mut deletions) = (0u32, 0u32, 0u32);
    for line in numstat.lines().filter(|l| !l.trim().is_empty()) {
        files_changed += 1;
        let mut cols = line.split_whitespace();
        insertions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0); // "-" for binary -> 0
        deletions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    }

    Ok(BranchStatus { ahead, behind, dirty, files_changed, insertions, deletions, worktree_on_branch })
}

/// Live ahead/behind + dirty + size of an agent branch vs its (no-fetch) effective base.
/// `async` + `spawn_blocking` (mirroring `create_agent_worktree`) so the several synchronous `git`
/// subprocesses this runs per sidebar/status poll never stall the UI thread.
#[tauri::command]
pub async fn agent_branch_status(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
) -> Result<BranchStatus, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        agent_branch_status_at(&root, &project_id, &agent_id, &base_branch, &app_data)
    })
    .await
    .map_err(|e| format!("agent_branch_status task failed: {e}"))?
}

/// Where an agent's work sits in the land-to-green workflow, beyond what ahead/behind can show.
/// All reachability is "does ref X already contain the agent branch tip" — i.e. the work has
/// landed there. Computed entirely from LOCAL refs (no fetch), so it's fast and offline-safe;
/// `in_origin_main` reflects the last-fetched `origin/<default>`. The optional GitHub PR probe is
/// the only network touch and is strictly best-effort (absent `gh`/remote/PR ⇒ all-None).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    /// Agent branch tip is contained in the LOCAL default branch (e.g. work merged into `main`).
    in_local_main: bool,
    /// …in `origin/<default>` as of the last fetch (landed on the remote integration branch).
    in_origin_main: bool,
    /// …in the parent/orchestrator branch (workers only; false when `parent_branch` is empty or
    /// missing). This is a worker's "On Main": its work merged into its orchestrator's branch.
    in_parent: bool,
    /// Commits the agent authored that aren't yet in the ref it was cut from — `origin/<default>`
    /// when that remote-tracking ref exists, else local `<default>` (>0 ⇒ real unlanded work).
    /// Lets the caller distinguish "did work, now merged" from "never committed anything". Measured
    /// against the cut ref (not strictly local main) so a fresh branch off an ahead-of-local
    /// `origin/<default>` reads 0 rather than counting inherited, un-pulled commits as its own.
    ahead_of_base: u32,
    /// The branch's WORK is already in the integration branch via a SQUASH or REBASE merge — its tip
    /// COMMIT isn't an ancestor (squash makes a new commit, so `in_local_main`/`in_origin_main` are
    /// both false), but merging it into `<default>` would add nothing (see `merge_adds_nothing`,
    /// which survives an advancing `<default>`). Kept a strict superset of reachability (true whenever
    /// those are). The frontend gates this on `committedSeen` so a no-op branch — which also trivially
    /// adds nothing — can't claim it landed.
    landed: bool,
    /// The agent branch has been PUSHED to `origin` — its remote-tracking ref
    /// (`refs/remotes/origin/sparkle/agent-<id>`) exists. git creates/updates that ref on push, so
    /// this is a pure LOCAL lookup: offline-safe, no fetch, reflects a push made from THIS repo (the
    /// common case — an agent pushing its own branch). Drives the "Pushed" stage LIVE even when no PR
    /// exists yet (a PR previously the only path to Pushed). Distinct from `in_origin_main`, which is
    /// about the tip landing on the DEFAULT branch, not the agent branch existing on the remote.
    pushed: bool,
    /// The agent's work is SHIPPED — its branch tip is contained in a published release tag (a
    /// semver-ish tag like `v1.2.3`; `nightly`/`latest` don't count). `git tag --contains <tip>`,
    /// filtered by `delivery::is_semver_tag`. Local + offline. Drives the top "Shipped to Production"
    /// stage LIVE (previously unreachable — nothing ever set it). Gated by `committedSeen` downstream.
    /// EDGE: a squash-landed branch's tip isn't an ancestor of the tagged release, so this reads false
    /// for squashed work (the merge/`landed` signal still lights "Merged"); tip-relative on purpose.
    shipped: bool,
    /// The repo has an `origin` remote. Gated on `probe_pr_state` (same as the PR probe), so a
    /// fast/local poll reports false — the frontend stores this stickily and treats a false from a
    /// non-probing tick as "unknown", never as "no remote". Without this, a remoteless repo can
    /// never reach `in_origin_main` and would strand at "Push to Origin Main" with Close unreachable.
    has_remote: bool,
    /// Best-effort GitHub PR state for this branch via `gh`, if one is found: "open" | "merged" |
    /// "closed". None when gh is absent/unauthed, there's no remote, or no PR matches the branch.
    pr_state: Option<String>,
    pr_number: Option<u64>,
    pr_url: Option<String>,
}

/// True iff `target` exists and already contains `commit` (i.e. `commit` is an ancestor of, or
/// equal to, `target`). A missing/invalid target ref or any git error reads as "not contained".
fn ref_contains(root: &str, target: &str, commit: &str) -> bool {
    if target.trim().is_empty() {
        return false;
    }
    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.arg("-C").arg(root).args(["merge-base", "--is-ancestor", commit, target]);
    // A missing target ref makes git print "fatal: Not a valid object name" to stderr; null the
    // child stdio so that expected, frequent case (e.g. no origin/main) doesn't spam app logs.
    cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    apply_noninteractive(&mut cmd);
    matches!(cmd.status(), Ok(s) if s.success())
}

/// True iff merging `branch` into `target` would change NOTHING — i.e. `target` already contains all
/// of `branch`'s work. Catches a SQUASH/REBASE merge (the tip isn't an ancestor, so `ref_contains`
/// misses it) AND survives an ADVANCING `target` (other commits landing after the squash), because
/// it asks the three-way question "does this branch still contribute anything?" rather than comparing
/// whole tip trees — important here, where many agents land onto one shared `main`. Uses
/// `git merge-tree --write-tree` (git ≥2.38): on a clean merge it prints the merged tree's OID, which
/// we compare to `target`'s own tree. A conflict (non-zero exit) or any git error reads as "not
/// landed" — a branch that conflicts with `target` plainly hasn't landed.
/// KNOWN EDGE: a branch that authored commits and then net-reverted them merges as a no-op too, so it
/// reads as landed; tolerated (a degenerate case) and gated upstream only by committedSeen.
fn merge_adds_nothing(root: &str, target: &str, branch: &str) -> bool {
    if target.trim().is_empty() || branch.trim().is_empty() {
        return false;
    }
    let Ok(merged) = git(root, &["merge-tree", "--write-tree", target, branch]) else {
        return false; // merge conflict (non-zero exit) or git error ⇒ not cleanly landed
    };
    if merged.is_empty() {
        return false;
    }
    match git(root, &["rev-parse", &format!("{target}^{{tree}}")]) {
        Ok(tree) => !tree.is_empty() && tree == merged,
        Err(_) => false,
    }
}

/// Is `branch` effectively landed on the integration branch? The single source of the "landed"
/// rule, used by BOTH the workflow-state signal and the close-agent safe branch delete so they can
/// never disagree. Checks fast-forward ancestry into LOCAL or ORIGIN `<target>`, OR a merge-tree
/// no-op against either (which catches squash/rebase merges — where the work lands on the remote as
/// a NEW commit and the branch tip is not an ancestor — and survives an advancing target). `tip` is
/// the branch's resolved SHA ("" = no tip). Callers wanting the freshest remote state refresh origin
/// first; `||` short-circuits so the merge-tree probes only run for not-already-reachable branches.
fn branch_landed(root: &str, target: &str, branch: &str, tip: &str) -> bool {
    let origin_ref = format!("origin/{target}");
    (!tip.is_empty() && (ref_contains(root, target, tip) || ref_contains(root, &origin_ref, tip)))
        || merge_adds_nothing(root, target, branch)
        || merge_adds_nothing(root, &origin_ref, branch)
}

/// True iff the agent branch has been pushed to `origin` — its remote-tracking ref exists locally.
/// git creates/updates `refs/remotes/origin/<branch>` on a successful push, so a pure `rev-parse` of
/// that ref answers "was this branch pushed" offline, with no fetch. Any missing ref / git error
/// reads as not-pushed. This reflects a push done from THIS repo (the normal agent-pushes-its-own-
/// branch flow); a push made elsewhere would only show after a fetch that includes the ref.
fn branch_pushed(root: &str, branch: &str) -> bool {
    if branch.trim().is_empty() {
        return false;
    }
    let remote_ref = format!("refs/remotes/origin/{branch}");
    git(root, &["rev-parse", "--verify", "--quiet", &remote_ref])
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// True iff `tip` is contained in a published RELEASE tag — a semver-ish tag (`v1.2.3` / `1.2`), per
/// `delivery::is_semver_tag`. `git tag --contains <tip>` lists every tag whose history includes the
/// commit; we keep only release-looking ones so a `nightly`/`latest` tag can't read as shipped.
/// Local + offline; an empty tip, no matching tag, or any git error reads as not-shipped. Because it
/// is TIP-relative, a squash-landed branch (whose tip isn't an ancestor of the tagged release) reads
/// false here on purpose — the `landed` signal still carries it to "Merged".
fn tip_in_release(root: &str, tip: &str) -> bool {
    if tip.trim().is_empty() {
        return false;
    }
    match git(root, &["tag", "--contains", tip]) {
        Ok(out) => out.lines().any(crate::delivery::is_semver_tag),
        Err(_) => false,
    }
}

/// Best-effort GitHub PR lookup for `branch` via the `gh` CLI. Returns (state, number, url) where
/// state is lowercased ("open"/"merged"/"closed"). Any failure — gh not installed, not authed, no
/// network, no remote, no matching PR, unparsable output — yields all-None and never errors. Fast
/// path: callers should only invoke this when an `origin` remote exists.
fn probe_pr(root: &str, branch: &str) -> (Option<String>, Option<u64>, Option<String>) {
    let none = (None, None, None);
    if branch.trim().is_empty() {
        return none;
    }
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.arg("pr")
        .args(["list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,url"])
        .current_dir(root)
        // Keep gh non-interactive and quiet; never let it block the poll on a prompt or updater.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    // Network touch → bounded wall-clock; a timeout reads as failure (all-None), like gh being absent.
    let Ok(output) = output_with_timeout(cmd, NETWORK_TIMEOUT) else {
        return none; // gh not installed / failed to spawn / timed out
    };
    if !output.status.success() {
        return none;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(rows) = serde_json::from_str::<Vec<Value>>(&stdout) else {
        return none;
    };
    let Some(pr) = rows.first() else {
        return none; // no PR for this branch
    };
    let state = pr.get("state").and_then(Value::as_str).map(str::to_ascii_lowercase);
    let number = pr.get("number").and_then(Value::as_u64);
    let url = pr.get("url").and_then(Value::as_str).map(str::to_string);
    (state, number, url)
}

/// Pure decoder for a GitHub `commits/<sha>/pulls` response array → (state, number, url). That
/// endpoint reports `state` as only "open"/"closed" plus a separate `merged_at`; we fold
/// `merged_at != null` into the "merged" state the rest of the pipeline expects, and it carries the
/// PR link as `html_url` (not `url`). Takes the first row; empty array ⇒ all-None. Kept pure so the
/// state-folding is unit-testable without spawning `gh`.
fn decode_commit_pulls(rows: &[Value]) -> (Option<String>, Option<u64>, Option<String>) {
    let none = (None, None, None);
    // The endpoint can return SEVERAL PRs whose head contains the tip (a reused branch, cherry-picks,
    // or an old + a new PR), and its ordering is not guaranteed "most relevant first". Prefer a merged
    // PR (the tip shipped), then an open one (in review), else the first — so a stale closed PR can't
    // shadow the one that actually reflects this tip's stage.
    let merged_idx =
        rows.iter().position(|pr| pr.get("merged_at").map(|v| !v.is_null()).unwrap_or(false));
    let open_idx = rows.iter().position(|pr| pr.get("state").and_then(Value::as_str) == Some("open"));
    let pick = merged_idx
        .or(open_idx)
        .map(|i| &rows[i])
        .or_else(|| rows.first());
    let Some(pr) = pick else {
        return none;
    };
    let merged = pr.get("merged_at").map(|v| !v.is_null()).unwrap_or(false);
    let state = if merged {
        Some("merged".to_string())
    } else {
        pr.get("state").and_then(Value::as_str).map(str::to_ascii_lowercase)
    };
    let number = pr.get("number").and_then(Value::as_u64);
    let url = pr.get("html_url").and_then(Value::as_str).map(str::to_string);
    (state, number, url)
}

/// The tip-relative lookup is authoritative iff it actually identified a PR — i.e. it carries a PR
/// NUMBER (a PR isn't actionable without one). Pure + tested so the "fall back to the branch-name
/// probe" decision can't silently regress; kept as a predicate (not an eager 2-arg chooser) so the
/// caller still short-circuits the second `gh` round-trip on the common success path.
fn commit_pr_is_usable(by_commit: &(Option<String>, Option<u64>, Option<String>)) -> bool {
    by_commit.1.is_some()
}

/// TIP-RELATIVE PR lookup: find the PR whose head contains commit `tip`, via the GitHub API, so a PR
/// opened from a RENAMED branch (head ≠ `sparkle/agent-<id>`) is still detected — the branch-name
/// probe (`probe_pr`) misses those. Being keyed on the current tip also means it stops reporting
/// "merged" once new commits are stacked past a merge (the new tip isn't in that PR), which is what
/// lets the tracker reset for a fresh work cycle. Best-effort: any failure yields all-None.
fn probe_pr_by_commit(root: &str, tip: &str) -> (Option<String>, Option<u64>, Option<String>) {
    let none = (None, None, None);
    if tip.trim().is_empty() {
        return none;
    }
    let mut cmd = Command::new(crate::preflight::gh_program());
    // gh substitutes {owner}/{repo} from the repo at `current_dir`. The endpoint returns the PRs
    // whose head branch contains `tip`, regardless of that branch's name.
    cmd.arg("api")
        .arg(format!("repos/{{owner}}/{{repo}}/commits/{tip}/pulls"))
        .arg("-H")
        .arg("Accept: application/vnd.github+json")
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    // Network touch → bounded wall-clock; a timeout reads as failure (all-None), like gh being absent.
    let Ok(output) = output_with_timeout(cmd, NETWORK_TIMEOUT) else {
        return none; // gh not installed / failed to spawn / timed out
    };
    if !output.status.success() {
        return none; // un-pushed tip (404), not authed, no network, …
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(rows) = serde_json::from_str::<Vec<Value>>(&stdout) else {
        return none;
    };
    decode_commit_pulls(&rows)
}

/// Pure decoder for a `gh pr list --json number` response → the number of open PRs. Kept separate
/// from the spawn so the "what does this output mean" half is unit-testable without a network or a
/// `gh` binary. Unparsable output reads as UNKNOWN (`None`), never as zero: the badge must be able
/// to distinguish "no PRs waiting" from "couldn't find out", because rendering a confident `0` on a
/// failed probe is exactly the false reassurance this feature exists to prevent.
fn decode_open_pr_count(stdout: &str) -> Option<u32> {
    let rows = serde_json::from_str::<Vec<Value>>(stdout).ok()?;
    u32::try_from(rows.len()).ok()
}

/// Best-effort count of OPEN pull requests in `root`'s repo authored by the current `gh` identity.
///
/// Repo-scoped on purpose, and deliberately NOT keyed on any agent: an agent leaves the sidebar
/// when its session ends, and a PR-awaiting-merge signal that dies with the agent is precisely the
/// gap this closes (see PRD/sparkle-pr-awaiting-merge-badge.md). Scoped to `--author @me` so that
/// on a repo with other contributors this counts only work this identity owns and can merge, rather
/// than a teammate's review queue.
///
/// Best-effort by the same convention as `probe_pr`: gh absent, unauthed, offline, no remote, or a
/// timeout all yield `None` (unknown) and never an error.
fn probe_open_pr_count(root: &str) -> Option<u32> {
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.arg("pr")
        .args(["list", "--state", "open", "--author", "@me", "--limit", "100", "--json", "number"])
        .current_dir(root)
        // Keep gh non-interactive and quiet; never let it block on a prompt or updater.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    // Network touch → bounded wall-clock, so a hung remote can't stall the poll behind it.
    let output = output_with_timeout(cmd, NETWORK_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    decode_open_pr_count(&String::from_utf8_lossy(&output.stdout))
}

/// How many open PRs authored by this identity are waiting in `root`'s repo. `Ok(None)` means
/// "couldn't find out" (see `probe_open_pr_count`); the badge renders nothing for it.
#[tauri::command]
pub async fn project_open_pr_count(root: String) -> Result<Option<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || probe_open_pr_count(&root))
        .await
        .map_err(|e| format!("project_open_pr_count task failed: {e}"))
}

/// Pure decoder: `gh repo view --json url` → the repo's PR-list URL. Split from the spawn so the
/// URL-shaping is testable without `gh`. Anything that isn't a plausible https URL yields None
/// rather than a half-built link — the badge would rather do nothing than open a wrong page.
fn decode_pr_list_url(stdout: &str) -> Option<String> {
    let v = serde_json::from_str::<Value>(stdout).ok()?;
    let url = v.get("url").and_then(Value::as_str)?.trim_end_matches('/');
    if !url.starts_with("https://") {
        return None;
    }
    Some(format!("{url}/pulls"))
}

/// The repo's pull-request list URL, for the badge's click-through. Asks `gh` rather than parsing
/// `git remote get-url`, so SSH remotes, enterprise hosts, and renamed repos all resolve the same
/// way the rest of the PR machinery already resolves them. Best-effort: `None` on any failure, and
/// the caller simply doesn't navigate.
/// Best-effort PR-list URL for `root`'s repo. Mirrors `probe_open_pr_count`'s shape deliberately:
/// the gh-invocation boilerplate (non-interactive env, bounded wall-clock, failure reads as None)
/// is identical, and having one path inline it while the other used a helper made the pair harder
/// to compare than it needed to be.
fn probe_pr_list_url(root: &str) -> Option<String> {
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.args(["repo", "view", "--json", "url"])
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    let output = output_with_timeout(cmd, NETWORK_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    decode_pr_list_url(&String::from_utf8_lossy(&output.stdout))
}

#[tauri::command]
pub async fn project_pr_list_url(root: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || probe_pr_list_url(&root))
        .await
        .map_err(|e| format!("project_pr_list_url task failed: {e}"))
}

/// One open pull request, richer than the bare `probe_open_pr_count` count: enough for the TopBar
/// PR menu to LIST each PR, join it to a live agent by `head_ref_name` (the `sparkle/agent-<id>`
/// convention), and gate its Merge action on `checks`/`mergeable`. Serialized camelCase for the JS
/// side.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrRow {
    pub number: u64,
    pub title: String,
    pub head_ref_name: String,
    pub url: String,
    /// Aggregate CI rollup: "passing" | "pending" | "failing" | "none". "none" is a PR with no
    /// checks at all — distinct from "couldn't tell", which drops the whole probe to `None`.
    pub checks: String,
    /// "mergeable" | "conflicting" | "unknown". GitHub computes mergeability asynchronously, so a
    /// freshly opened PR often reads "unknown"; the UI treats that as "let gh decide", not a block.
    pub mergeable: String,
}

/// Aggregate a `gh` `statusCheckRollup` array into one word. A failing check dominates (red beats
/// everything); else any still-running check makes the whole rollup "pending"; else if there are any
/// checks they have all succeeded → "passing"; an empty rollup is "none". Pure so the CI-shaping is
/// unit-tested without a network or a `gh` binary — the same split the badge's decoders use.
fn classify_checks(rollup: &[Value]) -> &'static str {
    let mut saw_any = false;
    let mut saw_pending = false;
    for c in rollup {
        saw_any = true;
        // A check run reports status+conclusion; a legacy commit-status context reports one `state`.
        if let Some(state) = c.get("state").and_then(Value::as_str) {
            match state {
                "SUCCESS" => {}
                "PENDING" | "EXPECTED" => saw_pending = true,
                _ => return "failing", // FAILURE | ERROR
            }
        } else {
            // Not COMPLETED yet → still running (QUEUED | IN_PROGRESS | WAITING | REQUESTED | ...).
            if c.get("status").and_then(Value::as_str) != Some("COMPLETED") {
                saw_pending = true;
                continue;
            }
            match c.get("conclusion").and_then(Value::as_str).unwrap_or("") {
                // A neutral/skipped/successful check does not block a merge.
                "SUCCESS" | "NEUTRAL" | "SKIPPED" => {}
                _ => return "failing", // FAILURE | CANCELLED | TIMED_OUT | ACTION_REQUIRED | STALE
            }
        }
    }
    if saw_pending {
        "pending"
    } else if saw_any {
        "passing"
    } else {
        "none"
    }
}

/// GitHub's `mergeable` enum → the lowercase word the UI reads. Anything other than the two known
/// terminal values (including the very common asynchronously-not-yet-computed `UNKNOWN`) reads as
/// "unknown", which the UI treats as "attempt the merge and let gh decide" rather than a hard block.
fn normalize_mergeable(v: Option<&str>) -> &'static str {
    match v {
        Some("MERGEABLE") => "mergeable",
        Some("CONFLICTING") => "conflicting",
        _ => "unknown",
    }
}

/// Pure decoder: `gh pr list --json number,title,headRefName,url,mergeable,statusCheckRollup` → rows.
/// Unparsable output yields `None` (unknown), never an empty list — the same null-vs-zero discipline
/// as `decode_open_pr_count`: an empty JSON *array* is a known "no PRs waiting", but garbage means
/// "couldn't tell", and the menu must not render a confident empty state on a failed probe.
fn decode_open_prs(stdout: &str) -> Option<Vec<PrRow>> {
    let rows = serde_json::from_str::<Vec<Value>>(stdout).ok()?;
    Some(
        rows.iter()
            .filter_map(|r| {
                // A PR without a number is unusable (nothing to merge or link), so drop just that row
                // rather than failing the whole probe.
                let number = r.get("number").and_then(Value::as_u64)?;
                let str_field = |k: &str| {
                    r.get(k).and_then(Value::as_str).unwrap_or("").to_string()
                };
                let checks = r
                    .get("statusCheckRollup")
                    .and_then(Value::as_array)
                    .map(|a| classify_checks(a))
                    .unwrap_or("none")
                    .to_string();
                let mergeable =
                    normalize_mergeable(r.get("mergeable").and_then(Value::as_str)).to_string();
                Some(PrRow {
                    number,
                    title: str_field("title"),
                    head_ref_name: str_field("headRefName"),
                    url: str_field("url"),
                    checks,
                    mergeable,
                })
            })
            .collect(),
    )
}

/// The open PRs authored by this identity in `root`'s repo. Mirrors `probe_open_pr_count`'s
/// gh-invocation shape (non-interactive env, bounded wall-clock, failure reads as `None`) but asks
/// for the richer field set the menu needs. Best-effort: gh absent, unauthed, offline, no remote, or
/// a timeout all yield `None`.
fn probe_open_prs(root: &str) -> Option<Vec<PrRow>> {
    let mut cmd = Command::new("gh");
    cmd.arg("pr")
        .args([
            "list",
            "--state",
            "open",
            "--author",
            "@me",
            "--limit",
            "100",
            "--json",
            "number,title,headRefName,url,mergeable,statusCheckRollup",
        ])
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    let output = output_with_timeout(cmd, NETWORK_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    decode_open_prs(&String::from_utf8_lossy(&output.stdout))
}

/// The open PRs waiting in `root`'s repo, for the TopBar PR menu. `Ok(None)` means "couldn't find
/// out" (see `probe_open_prs`); the menu renders nothing for it, exactly as the count badge does.
#[tauri::command]
pub async fn project_open_prs(root: String) -> Result<Option<Vec<PrRow>>, String> {
    tauri::async_runtime::spawn_blocking(move || probe_open_prs(&root))
        .await
        .map_err(|e| format!("project_open_prs task failed: {e}"))
}

/// Wall-clock ceiling for a user-initiated `gh pr merge`. Longer than `NETWORK_TIMEOUT`: a merge does
/// more server-side work than a read, and this path is one deliberate click (not a background poll),
/// so a slightly longer wait is acceptable where a stalled poll would not be.
const MERGE_TIMEOUT: Duration = Duration::from_secs(60);

/// Merge an open PR by number with a MERGE COMMIT. This is the human gate the workflow is built
/// around, invoked from the TopBar PR menu — for a PR whose opening agent has already left the
/// sidebar, it is the only way to merge from the app at all.
///
/// Deliberately `--merge`, NOT `--squash`: a squash rewrites the commits so the branch tip stops
/// being an ancestor of `main`, which breaks Sparkle's landed-by-ancestry proof (see AGENTS.md).
/// Deliberately NOT `--auto`: on a repo without auto-merge enabled `gh` silently degrades `--auto`
/// to an immediate merge, so it is not the guard it looks like. The UI only enables this once the
/// PR's checks are green and it is mergeable; `gh` is the backstop that refuses a merge whose
/// required checks are still red. The `gh` error text is returned verbatim on failure so the menu
/// can show exactly why a merge was declined.
#[tauri::command]
pub async fn merge_pr(root: String, number: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("gh");
        cmd.args(["pr", "merge", &number.to_string(), "--merge"])
            .current_dir(&root)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1");
        apply_noninteractive(&mut cmd);
        let output = output_with_timeout(cmd, MERGE_TIMEOUT)?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        };
        Err(if msg.is_empty() {
            format!("gh pr merge #{number} failed")
        } else {
            msg
        })
    })
    .await
    .map_err(|e| format!("merge_pr task failed: {e}"))?
}

/// Per-repo cooldown between opportunistic `git fetch`es. Reachability into `origin/<default>` is
/// only as fresh as the last fetch; when a PR is merged in ANOTHER worktree/session this repo's
/// remote-tracking ref goes stale and the tracker understates "On Main"/"Merged" until something
/// fetches. We refresh it ourselves on the slow (network-allowed) poll — but at most once per repo
/// per cooldown, so N open agents don't trigger N fetches and we don't hammer the remote. The poll
/// runs ~every 30s, so 20s makes it fire about once per poll cycle. (The gh PR probe is already
/// authoritative for merged PRs; this self-heals the *reachability* path for merges with no PR, or
/// when gh is unavailable.)
const FETCH_COOLDOWN: Duration = Duration::from_secs(20);

fn last_fetch() -> &'static Mutex<HashMap<String, Instant>> {
    static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pure throttle decision (testable without a clock): fetch if we never have, or the cooldown has
/// elapsed since the last one.
fn fetch_due(last: Option<Instant>, now: Instant) -> bool {
    match last {
        Some(t) => now.duration_since(t) >= FETCH_COOLDOWN,
        None => true,
    }
}

/// Best-effort, throttled refresh of `origin/<default>` so a cross-worktree/session merge shows up
/// without the user pulling. Any failure (offline, no auth, no remote) is ignored — `git` already
/// runs non-interactive, so a missing credential fails fast rather than prompting.
fn maybe_refresh_origin(root: &str, default_branch: &str) {
    let now = Instant::now();
    {
        let Ok(mut map) = last_fetch().lock() else {
            return; // a poisoned lock must never break the poll
        };
        if !fetch_due(map.get(root).copied(), now) {
            return;
        }
        map.insert(root.to_string(), now);
    }
    // Network touch → bounded wall-clock (see git_networked); an offline/partition fetch fails fast.
    let _ = git_networked(root, &["fetch", "--quiet", "--no-tags", "origin", default_branch]);
}

/// Kick a background, throttled refresh of `origin/<base>` off the worktree-create critical path.
/// Resolves the logical base (falling back to the project default for an empty/unsafe ref) on the
/// spawned thread, then reuses [`maybe_refresh_origin`] so N agents opening at once don't each fetch,
/// and an unreachable remote never stalls the spawn — the fetch just fails quietly in the background.
fn spawn_background_origin_refresh(root: &str, base_branch: &str) {
    let root = root.to_string();
    let base = base_branch.trim().to_string();
    std::thread::spawn(move || {
        let logical = if base.is_empty() || validate_ref(&base).is_err() {
            resolve_default_branch(&root)
        } else {
            base
        };
        maybe_refresh_origin(&root, &logical);
    });
}

// ── Pre-warmed worktree pool (sparkle worktree-pool) ─────────────────────────────────────────────
//
// `git worktree add -b <branch> <path> <base>` is slow because it MATERIALIZES the whole working
// tree (measured at 86-98% of every build-agent spawn, 2s uncontended and up to 16s queued behind
// other worktree ops). But creating a branch in an ALREADY-materialized worktree whose files equal
// the base tree is O(1). So at idle we park a few detached-HEAD worktrees checked out at the base
// commit under a SEPARATE app-data subtree; a spawn then CLAIMS one — `git worktree move` it to the
// agent path + `git checkout -b sparkle/agent-<id>` — both near-instant ref ops. The claim returns
// the IDENTICAL `WorktreeInfo` the slow path would, so nothing downstream can tell the difference.
//
// The pool is a PURE optimization: disabled by config, empty, cut from a since-moved base, or any
// git failure ⇒ transparently fall back to the original `git worktree add` in `create_worktree_at`.

/// A parked pool worktree's on-disk root: `<app_data>/worktree-pool/<project_id>/<slot-id>`. This is
/// a SEPARATE subtree from agent worktrees (`worktrees/<project_id>/<agent_id>`) on purpose — every
/// scanner that enumerates agent worktrees (heal_agent_hooks, scan_worker_manifests, the Sparkle
/// self-improve reaper) walks `worktrees/<project_id>/…` and would otherwise have to special-case a
/// pool entry; keeping pool slots out of that tree entirely means none of them ever see a slot.
fn pool_dir(app_data: &Path, project_id: &str) -> Result<PathBuf, String> {
    validate_id("project_id", project_id)?;
    Ok(app_data.join("worktree-pool").join(project_id))
}

/// One parked, detached-HEAD worktree checked out at `base_commit`, ready to be claimed.
#[derive(Clone)]
struct PoolSlot {
    path: PathBuf,
    /// The commit the slot was warmed at. Re-checked against the CURRENT effective base at claim
    /// time so a slot cut from a since-advanced base is discarded rather than handed out.
    base_commit: String,
}

/// In-memory pool state, keyed by project_id. Guarded by this mutex ONLY for the brief push/pop;
/// the slow `git worktree add` runs outside it (under the per-repo git lock) so warming never blocks
/// a claim that just needs to pop a slot.
fn pools() -> &'static Mutex<HashMap<String, Vec<PoolSlot>>> {
    static POOLS: OnceLock<Mutex<HashMap<String, Vec<PoolSlot>>>> = OnceLock::new();
    POOLS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-repo-root serialization for index/ref-mutating git worktree ops (add/move/remove/prune/
/// checkout -b). The frontend `withRepoLock` already serializes FRONTEND-initiated ops among
/// themselves; this additionally serializes the BACKGROUND warm/top-up thread against them, so a
/// warm's `git worktree add` can never collide with a concurrent claim/create/worker-cut on
/// `index.lock`. A plain per-root mutex — held only around the git call, never nested — so there is
/// no deadlock risk with the frontend chain.
fn repo_git_lock(root: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.entry(root.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// Projects whose leftover pool dirs have been swept this session (startup cleanup, once per project).
fn pool_cleaned() -> &'static Mutex<HashSet<String>> {
    static CLEANED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CLEANED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Projects with a top-up currently in flight, so a mount storm / burst of claims doesn't stack
/// redundant warmers (each would race to the same `size` target and over-warm).
fn topup_in_flight() -> &'static Mutex<HashSet<String>> {
    static INFLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    INFLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Remove parked worktrees left behind by a CRASHED prior session and prune stale git admin entries.
/// Runs at most ONCE per project per session, and (because the in-memory pool boots empty) always
/// BEFORE the first warm — so it can only ever delete leftovers, never a slot this session created.
/// Idempotent + best-effort: any I/O or git error is ignored.
fn cleanup_pool_once(root: &str, project_id: &str, app_data: &Path) {
    {
        let mut set = pool_cleaned().lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(project_id.to_string()) {
            return; // already swept this session
        }
    }
    let gl = repo_git_lock(root);
    let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(dir) = pool_dir(app_data, project_id) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let ps = p.to_string_lossy().to_string();
                    // Deregister it as a worktree (no-op if git doesn't know it), then delete the dir.
                    let _ = git(root, &["worktree", "remove", "--force", &ps]);
                    let _ = std::fs::remove_dir_all(&p);
                }
            }
        }
    }
    // Clear git's admin records for any now-missing worktrees (pool leftovers or reaped agents).
    let _ = git(root, &["worktree", "prune"]);
}

/// A filesystem-safe random slot id (32 hex chars). Uses `rand` (already a dependency) so we need no
/// time/uuid crate and two concurrent warms can't collide on a name.
fn new_slot_id() -> String {
    let a: u64 = rand::random();
    let b: u64 = rand::random();
    format!("{a:016x}{b:016x}")
}

/// Warm ONE parked worktree: `git worktree add --detach <pool>/<slot> <base_commit>`, then record it
/// in the in-memory pool. Takes the per-repo git lock only around the add. The base is resolved
/// no-network (same commit `create_worktree_at` would cut from today), so warming never blocks on a
/// fetch. Err on any resolve/add failure (the caller stops topping up rather than spinning).
fn warm_one_slot(
    root: &str,
    project_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Result<(), String> {
    let base = effective_base(root, base_branch, false);
    let base_commit =
        git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")])?;
    if base_commit.is_empty() {
        return Err("pool warm: base commit did not resolve".into());
    }
    let dir = pool_dir(app_data, project_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create pool dir: {e}"))?;
    let slot_path = dir.join(new_slot_id());
    let slot_str = slot_path.to_string_lossy().to_string();
    {
        let gl = repo_git_lock(root);
        let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());
        git(root, &["worktree", "add", "--detach", &slot_str, &base_commit])?;
    }
    pools()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(project_id.to_string())
        .or_default()
        .push(PoolSlot { path: slot_path, base_commit });
    Ok(())
}

/// Bring the pool up to the configured size, warming ONE worktree at a time. No-op when the feature
/// is disabled, `size == 0`, or the pool is already full. Sweeps crashed-session leftovers first.
/// Blocking core of [`warm_worktree_pool`] and the post-claim/post-cut refill — always run off the
/// critical path (a background thread or `spawn_blocking`), never inline on a spawn.
fn topup_pool_blocking(root: &str, project_id: &str, base_branch: &str, app_data: &Path) {
    let cfg = crate::config::for_project(root).config.worktree_pool;
    if !cfg.enabled || cfg.size == 0 {
        return;
    }
    cleanup_pool_once(root, project_id, app_data);
    // At most one top-up per project at a time.
    {
        let mut set = topup_in_flight().lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(project_id.to_string()) {
            return;
        }
    }
    // RAII: clear the in-flight flag on EVERY exit — normal return AND an unwind out of a git helper
    // — so a mid-warm panic can't leave the project permanently marked "in flight", which would
    // silently disable pool warming for the rest of the session (the slow-path cut would still work,
    // masking it). Guarantees the manual `.remove()` this replaced can never be skipped.
    struct InFlightGuard(String);
    impl Drop for InFlightGuard {
        fn drop(&mut self) {
            topup_in_flight().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
        }
    }
    let _in_flight = InFlightGuard(project_id.to_string());
    let target = cfg.size as usize;
    loop {
        let have = pools()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(project_id)
            .map(|v| v.len())
            .unwrap_or(0);
        if have >= target {
            break;
        }
        if let Err(e) = warm_one_slot(root, project_id, base_branch, app_data) {
            tracing::debug!(%project_id, error = %e, "pool warm failed; leaving pool short");
            break; // don't spin on a persistent failure
        }
    }
}

/// Kick a pool top-up on a background thread so it never blocks the spawn that triggered it. Fired
/// on project open (via [`warm_worktree_pool`]) and after each successful claim / inline cut, so a
/// consumed or seeded slot is refilled while the user's fan-out continues.
fn spawn_pool_topup(root: &str, project_id: &str, base_branch: &str, app_data: &Path) {
    let root = root.to_string();
    let project_id = project_id.to_string();
    let base_branch = base_branch.to_string();
    let app_data = app_data.to_path_buf();
    std::thread::spawn(move || {
        topup_pool_blocking(&root, &project_id, &base_branch, &app_data);
    });
}

/// Try to satisfy an agent-worktree request from the parked pool. Pops a slot, verifies it is still
/// cut from the CURRENT effective base and clean, then `git worktree move`s it to the agent path and
/// `git checkout -b`s the agent branch on it — both near-instant ref ops. Returns the SAME
/// `WorktreeInfo` the slow path would (files == base tree, branch `sparkle/agent-<id>`). Any miss
/// (disabled, empty, stale base, dirty, an existing branch, or any git failure) returns None so the
/// caller transparently falls back to `git worktree add`. A rejected slot is pruned in passing.
fn try_claim_pooled_worktree(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Option<WorktreeInfo> {
    if !crate::config::for_project(root).config.worktree_pool.enabled {
        return None;
    }
    let branch = format!("sparkle/agent-{agent_id}");
    // Resolve the agent path FIRST — before consuming a slot — so an invalid id returns None without
    // popping (and then leaking) a parked worktree. (In practice create_worktree_at already resolved
    // this same path at its top, so the Err arm is unreachable here; resolving up front keeps the
    // slot-consuming code strictly after the only fallible-without-a-slot step.)
    let target = worktree_path(app_data, project_id, agent_id).ok()?;
    let target_str = target.to_string_lossy().to_string();

    // Pop the most-recently-warmed slot (LIFO — most likely to still match the current base).
    let slot = {
        let mut map = pools().lock().unwrap_or_else(|e| e.into_inner());
        map.get_mut(project_id).and_then(|v| v.pop())
    }?;
    let slot_str = slot.path.to_string_lossy().to_string();

    // Hold the per-repo git lock across the WHOLE verify → move → branch sequence, and resolve the
    // current effective base INSIDE it, so a background fetch can't advance the base between the
    // staleness check and the move — the "never hand out the wrong base" guarantee holds against the
    // lock, not a read taken before it.
    let gl = repo_git_lock(root);
    let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());

    // What would the slow path cut from RIGHT NOW? If the base advanced since we warmed (e.g. a
    // background fetch moved origin/<base>), the slot is stale — discard it, never hand it out.
    let base = effective_base(root, base_branch, false);
    let current_base_commit = git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")])
        .unwrap_or_default();

    // Validity + staleness guard: a real worktree, still detached at the commit we recorded, that
    // commit still the current effective base, and a clean tree. Anything else ⇒ discard + fall back.
    let head = git(&slot_str, &["rev-parse", "HEAD"]).unwrap_or_default();
    let clean = git(&slot_str, &["status", "--porcelain"]).map(|s| s.is_empty()).unwrap_or(false);
    let valid_worktree = git(&slot_str, &["rev-parse", "--is-inside-work-tree"]).is_ok();
    let usable = !current_base_commit.is_empty()
        && head == slot.base_commit
        && slot.base_commit == current_base_commit
        && clean
        && valid_worktree;
    if !usable {
        let _ = git(root, &["worktree", "remove", "--force", &slot_str]);
        let _ = std::fs::remove_dir_all(&slot.path);
        let _ = git(root, &["worktree", "prune"]);
        return None;
    }

    // Never claim onto a branch that already exists — that's a RESUME, which must go through the
    // branch-reattach path in create_worktree_at (a fresh `checkout -b` would fail or discard work).
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok() {
        let _ = git(root, &["worktree", "remove", "--force", &slot_str]);
        let _ = std::fs::remove_dir_all(&slot.path);
        return None;
    }

    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Move the parked tree to the agent path (git rewrites its admin gitdir), then create + check out
    // the agent branch on it. HEAD is detached at the base commit, so `checkout -b` cuts the branch
    // there — files already equal the base tree, so nothing is materialized.
    if git(root, &["worktree", "move", &slot_str, &target_str]).is_err() {
        let _ = git(root, &["worktree", "remove", "--force", &slot_str]);
        let _ = std::fs::remove_dir_all(&slot.path);
        let _ = git(root, &["worktree", "prune"]);
        return None;
    }
    if git(&target_str, &["checkout", "-b", &branch]).is_err() {
        // Moved but the branch didn't attach — tear the half-built worktree down so the caller's
        // `git worktree add` fallback starts from a clean slate at the agent path.
        let _ = git(root, &["worktree", "remove", "--force", &target_str]);
        let _ = git(root, &["worktree", "prune"]);
        return None;
    }
    Some(WorktreeInfo { path: target_str, branch })
}

/// Warm this project's parked worktree pool up to the configured size, off the main thread. Call on
/// project open/activation so a later agent spawn can claim a ready worktree instead of paying
/// `git worktree add` on the critical path. No-op when `[worktree_pool].enabled = false`. Never
/// errors on a warm miss — the pool is a pure optimization.
#[tauri::command]
pub async fn warm_worktree_pool(
    app: AppHandle,
    root: String,
    project_id: String,
    base_branch: String,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        topup_pool_blocking(&root, &project_id, &base_branch, &app_data);
    })
    .await
    .map_err(|e| format!("warm_worktree_pool task failed: {e}"))
}

/// Prewarm what the first agent spawn needs so it's already hot: the claude + node path caches, and
/// a throttled background `origin/<default>` fetch. Runs off the main thread; every step is
/// best-effort (a warm miss just means the spawn resolves it itself). Safe to call on project open
/// or before the first spawn — the fetch is throttled so repeated calls don't hammer the remote.
#[tauri::command]
pub async fn prewarm_spawn(root: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::preflight::cached_claude_path();
        let _ = crate::preflight::resolve_node_path_cached();
        // Fetch the project's default branch so the first real worktree cut sees a fresh origin tip
        // without paying the fetch synchronously. Throttled + offline-safe via maybe_refresh_origin.
        let default = resolve_default_branch(&root);
        maybe_refresh_origin(&root, &default);
    })
    .await
    .ok();
}

/// Core (AppHandle-free, testable): the agent's land-to-green workflow state. `parent_branch` is
/// the orchestrator's branch for workers (empty/None for others). `probe_pr_state` gates the gh
/// network probe so a pure-local project (or a fast poll) can skip it entirely.
pub fn agent_workflow_state_at(
    root: &str,
    agent_id: &str,
    parent_branch: &str,
    probe_pr_state: bool,
) -> Result<WorkflowState, String> {
    let branch = format!("sparkle/agent-{agent_id}");
    // The branch tip lives in the shared repo (worktree add -b created the ref), so we can resolve
    // and compare it from `root` without touching the worktree dir.
    let tip = match git(root, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")]) {
        Ok(sha) if !sha.is_empty() => sha,
        // No branch yet (worktree never created) ⇒ nothing has landed anywhere.
        _ => return Ok(WorkflowState::default()),
    };

    let default_branch = resolve_default_branch(root);
    // On the network-allowed poll, opportunistically refresh origin/<default> FIRST so the
    // reachability checks below see a merge that landed in another worktree/session (throttled per
    // repo). Gated on `probe_pr_state` so the fast/local poll skips the `git remote` spawn entirely;
    // computed once and reused for the PR-probe gate below (both uses are network-poll-only).
    let has_origin = probe_pr_state && git(root, &["remote", "get-url", "origin"]).is_ok();
    if has_origin {
        maybe_refresh_origin(root, &default_branch);
    }
    let in_local_main = ref_contains(root, &default_branch, &tip);
    let origin_ref = format!("origin/{default_branch}");
    let in_origin_main = ref_contains(root, &origin_ref, &tip);
    let in_parent = ref_contains(root, parent_branch, &tip);

    // Squash/rebase merges create a NEW commit on the integration branch, so the agent tip is not an
    // ancestor and the reachability checks above miss it. `branch_landed` folds local/origin ancestry
    // with a merge-tree no-op probe (shared with the close-agent safe delete so both agree).
    let landed = branch_landed(root, &default_branch, &branch, &tip);

    // Pushed / shipped: two LOCAL, offline-safe signals that drive the "Pushed" and "Shipped" stages
    // live (formerly only reachable via a PR probe / never, respectively). `branch_pushed` is a
    // remote-tracking-ref lookup; `tip_in_release` is a release-tag containment check. Both frontend-
    // gated by committedSeen, so a no-op branch can't skip stages.
    let pushed = branch_pushed(root, &branch);
    let shipped = tip_in_release(root, &tip);

    // Commits the agent AUTHORED that aren't yet landed (0 once merged into the integration ref).
    // Measured against the ref the branch was actually CUT FROM — `origin/<default>` when a
    // remote-tracking ref exists (see `effective_base`, which cuts new branches from origin),
    // else local `<default>`. Comparing against LOCAL `<default>` here is wrong when it lags the
    // remote: a brand-new branch cut from `origin/<default>` would count the inherited, un-pulled
    // commits as the agent's own work — tripping the frontend's `committedSeen` gate which, together
    // with `in_origin_main` (trivially true for such a tip), falsely reads a no-op agent as "Merged".
    let base_for_ahead = if git(root, &["rev-parse", "--verify", "--quiet", &origin_ref]).is_ok() {
        origin_ref.clone()
    } else {
        default_branch.clone()
    };
    let ahead_of_base = git(root, &["rev-list", "--count", &format!("{base_for_ahead}..{branch}")])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    // Only spend a network round-trip on the PR probe when asked AND a remote exists. Try the
    // TIP-RELATIVE lookup first (finds the PR by commit, so a renamed head still resolves and a
    // tip stacked past a merge stops reading as "merged"); fall back to the branch-name probe when
    // the tip isn't associated with any PR (e.g. un-pushed, or a head gh can't map by commit).
    let (pr_state, pr_number, pr_url) = if has_origin {
        let by_commit = probe_pr_by_commit(root, &tip);
        if commit_pr_is_usable(&by_commit) {
            by_commit
        } else {
            probe_pr(root, &branch)
        }
    } else {
        (None, None, None)
    };

    Ok(WorkflowState {
        in_local_main,
        in_origin_main,
        in_parent,
        ahead_of_base,
        landed,
        pushed,
        shipped,
        has_remote: has_origin,
        pr_state,
        pr_number,
        pr_url,
    })
}

/// Live workflow stage signals for an agent: local-ref reachability + a best-effort GitHub PR
/// probe. See `WorkflowState`. The PR probe is gated by `probe_pr_state` (skip it on fast polls or
/// remoteless projects).
/// `async` + `spawn_blocking` (mirroring `create_agent_worktree`) so the several `git` subprocesses
/// plus the (network) `gh` PR probe this runs per poll never stall the UI thread.
#[tauri::command]
pub async fn agent_workflow_state(
    root: String,
    agent_id: String,
    parent_branch: String,
    probe_pr_state: bool,
) -> Result<WorkflowState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        agent_workflow_state_at(&root, &agent_id, &parent_branch, probe_pr_state)
    })
    .await
    .map_err(|e| format!("agent_workflow_state task failed: {e}"))?
}

// ── Batched per-project status (sparkle-zlic) ────────────────────────────────────────────────────
// The 30s sidebar poll used to fan out ~3-4 git/bd subprocesses PER open agent (branch status +
// workflow reachability + an opportunistic origin fetch + a `gh` PR probe), i.e. N agents ⇒ a burst
// of ~3-4N processes every tick. `project_agents_status` collapses that into ONE call per project:
// shared repo discovery (default branch, origin presence, one throttled origin fetch, the
// git-common-dir) is done ONCE, `effective_base` resolution is memoized per distinct base, and an
// idle agent whose FINGERPRINT — its branch tip + its base tip + the integration-branch tip + its
// worktree's index mtime — is unchanged since the last tick is SKIPPED entirely (its prior result is
// reused). Runs on the blocking pool via `spawn_blocking` so it never stalls the UI thread.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusInput {
    agent_id: String,
    /// The logical branch this agent's branch is compared against for ahead/behind (its own base).
    base_branch: String,
    /// The orchestrator branch for a worker (empty otherwise) — drives `in_parent`.
    parent_branch: String,
    /// "build" | "worker" | "think" | "shell". think/shell have no git workflow and are skipped.
    kind: String,
    /// The frontend sets this when the agent is actively working (PTY live): never skip it, so its
    /// dirty/ahead counts stay fresh while Claude edits/commits. Idle agents can be skipped.
    force: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusResult {
    agent_id: String,
    /// false ⇒ nothing changed since the last tick; the frontend keeps its prior store values.
    changed: bool,
    branch: Option<BranchStatus>,
    workflow: Option<WorkflowState>,
}

/// The cheap change-detection key for one agent. When every component is unchanged since the last
/// tick the agent's git state can't have moved (own tip, its base, the integration branch, and its
/// worktree's index are all identical), so the cached result is reused instead of recomputing.
#[derive(Clone, PartialEq)]
struct StatusFingerprint {
    tip: String,
    base_tip: String,
    default_tip: String,
    index_mtime_ms: u128,
}

/// Per-worktree-path cache of the last-seen fingerprint (sparkle-zlic). Keyed by worktree path
/// (stable per agent). We store only the fingerprint (not the result): on a skip the frontend keeps
/// its prior store values, so there's nothing to hand back. Session-scoped: boots empty so the first
/// tick always computes.
fn status_cache() -> &'static Mutex<HashMap<String, StatusFingerprint>> {
    static CACHE: OnceLock<Mutex<HashMap<String, StatusFingerprint>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// mtime (ms since epoch) of a linked worktree's private git index, or 0 when it can't be read. The
/// index lives under the shared repo at `<git-common-dir>/worktrees/<name>/index`; our worktree leaf
/// name IS the agent id (a UUID, never deduped by git), so we stat it without spawning a subprocess.
fn worktree_index_mtime_ms(git_common_dir: &Path, agent_id: &str) -> u128 {
    let index = git_common_dir.join("worktrees").join(agent_id).join("index");
    std::fs::metadata(&index)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Resolve a git ref to its commit sha (empty when it doesn't resolve). For the fingerprint tips.
fn rev_parse_tip(root: &str, refname: &str) -> String {
    if refname.trim().is_empty() {
        return String::new();
    }
    git(root, &["rev-parse", "--verify", "--quiet", &format!("{refname}^{{commit}}")])
        .unwrap_or_default()
}

/// Live ahead/behind + dirty + size for an agent branch vs an ALREADY-RESOLVED base ref. Mirrors
/// `agent_branch_status_at` but takes the base ref precomputed, so a batch resolves `effective_base`
/// once per distinct base instead of once per agent.
fn branch_status_with_base(
    root: &str,
    agent_id: &str,
    base_ref: &str,
    wt: &Path,
) -> Result<BranchStatus, String> {
    let branch = format!("sparkle/agent-{agent_id}");
    let wt_str = wt.to_string_lossy().to_string();
    // `--no-optional-locks`: a plain `git status` refreshes and REWRITES the worktree index (to
    // update its stat cache), which would bump the index mtime our fingerprint keys on and defeat the
    // skip on the very next tick. This top-level flag tells git not to take the index lock / write it,
    // so the mtime stays stable and an idle, unchanged agent is actually skipped (sparkle-zlic).
    // Same worktree-identity check as `agent_branch_status_at` (sparkle-xk3x). This is the path
    // the sidebar/status BATCH poll uses, so it is the one that actually drives what the user
    // sees — fixing only the single-agent path would leave the misreport live in the UI.
    // `rev-parse` doesn't touch the index, so it can't defeat the fingerprint skip above.
    let worktree_on_branch = if wt.exists() {
        git(&wt_str, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|h| h.trim() == branch)
            .unwrap_or(false)
    } else {
        false
    };
    let dirty = if wt.exists() {
        !git(&wt_str, &["--no-optional-locks", "status", "--porcelain"])?.is_empty()
    } else {
        false
    };
    // A brand-new/non-git agent polled before its first commit has no `sparkle/agent-<id>` ref yet;
    // `rev-list <base>...<missing>` then hard-fails with "ambiguous argument ... unknown revision",
    // which fails the WHOLE batch read for that agent and re-logs "batch branch status failed" every
    // 30s poll for the app's lifetime. Mirror `agent_branch_status_at`'s guard (the #291 fix, lost in
    // the batch refactor): return a zeroed status — still reflecting the worktree's dirty state — when
    // the branch ref doesn't exist, so there's nothing to count against a ref that isn't there.
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_err() {
        return Ok(BranchStatus { ahead: 0, behind: 0, dirty, files_changed: 0, insertions: 0, deletions: 0, worktree_on_branch });
    }
    // The branch exists, but the RESOLVED base may not (`effective_base`'s documented unborn/HEAD-less
    // fallback can return a name git can't resolve). `rev-list <unresolvable-base>...<branch>` then
    // hard-fails with "fatal: ambiguous argument", failing the whole batch read for that agent and
    // re-logging "batch branch status failed" every 30s tick for the app's lifetime. There's nothing to
    // diverge from when the base doesn't exist, so report the branch's own commits as `ahead` (behind 0)
    // instead of erroring — mirrors `agent_branch_status_at`'s base guard.
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{base_ref}^{{commit}}")]).is_err() {
        return Ok(ahead_only_status(root, &branch, dirty, worktree_on_branch));
    }
    let counts = git(root, &["rev-list", "--left-right", "--count", &format!("{base_ref}...{branch}")])?;
    let mut it = counts.split_whitespace();
    let behind: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let numstat = git(root, &["diff", "--numstat", &format!("{base_ref}...{branch}")]).unwrap_or_default();
    let (mut files_changed, mut insertions, mut deletions) = (0u32, 0u32, 0u32);
    for line in numstat.lines().filter(|l| !l.trim().is_empty()) {
        files_changed += 1;
        let mut cols = line.split_whitespace();
        insertions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        deletions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    }
    Ok(BranchStatus { ahead, behind, dirty, files_changed, insertions, deletions, worktree_on_branch })
}

/// The agent's workflow state given ALREADY-RESOLVED shared inputs (default branch, origin presence)
/// and its precomputed branch `tip`. Mirrors `agent_workflow_state_at` minus the per-call
/// resolve_default_branch + origin refresh, which the batch does ONCE up front. `has_origin` already
/// folds in the caller's PR-probe gate (as in `agent_workflow_state_at`): a remote exists AND the
/// caller asked to probe — so the `gh` lookup runs iff `has_origin`.
fn workflow_state_shared(
    root: &str,
    agent_id: &str,
    parent_branch: &str,
    default_branch: &str,
    has_origin: bool,
    tip: &str,
) -> WorkflowState {
    if tip.trim().is_empty() {
        return WorkflowState::default();
    }
    let branch = format!("sparkle/agent-{agent_id}");
    let in_local_main = ref_contains(root, default_branch, tip);
    let origin_ref = format!("origin/{default_branch}");
    let in_origin_main = ref_contains(root, &origin_ref, tip);
    let in_parent = ref_contains(root, parent_branch, tip);
    let landed = branch_landed(root, default_branch, &branch, tip);
    // Live Pushed/Shipped signals (sparkle-v7d0) — both pure local, offline-safe lookups (see
    // agent_workflow_state_at). Kept in the batched path too so the 30s project poll lights these.
    let pushed = branch_pushed(root, &branch);
    let shipped = tip_in_release(root, tip);
    let base_for_ahead = if git(root, &["rev-parse", "--verify", "--quiet", &origin_ref]).is_ok() {
        origin_ref.clone()
    } else {
        default_branch.to_string()
    };
    let ahead_of_base = git(root, &["rev-list", "--count", &format!("{base_for_ahead}..{branch}")])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let (pr_state, pr_number, pr_url) = if has_origin {
        let by_commit = probe_pr_by_commit(root, tip);
        if commit_pr_is_usable(&by_commit) {
            by_commit
        } else {
            probe_pr(root, &branch)
        }
    } else {
        (None, None, None)
    };
    WorkflowState {
        in_local_main,
        in_origin_main,
        in_parent,
        ahead_of_base,
        landed,
        pushed,
        shipped,
        // `has_origin` already folds in the caller's probe gate (see this fn's doc comment), so this
        // carries the same "false means no-remote OR not-probed" ambiguity as the per-agent path.
        has_remote: has_origin,
        pr_state,
        pr_number,
        pr_url,
    }
}

/// Core (AppHandle-free, testable): compute branch + workflow status for EVERY agent of a project in
/// one pass, sharing repo discovery and skipping fingerprint-unchanged idle agents (sparkle-zlic).
pub fn project_agents_status_at(
    root: &str,
    project_id: &str,
    agents: &[AgentStatusInput],
    probe_pr_state: bool,
    app_data: &Path,
) -> Vec<AgentStatusResult> {
    // ── Shared repo discovery, done ONCE for the whole batch ──
    let default_branch = resolve_default_branch(root);
    // `has_origin` folds in the PR-probe gate exactly as agent_workflow_state_at does: the network
    // touches (origin fetch + gh probe) only happen on a probe-enabled poll against a repo with a
    // remote. Reachability into origin/<default> still runs regardless (it's a local ref read).
    let has_origin = probe_pr_state && git(root, &["remote", "get-url", "origin"]).is_ok();
    if has_origin {
        maybe_refresh_origin(root, &default_branch);
    }
    // git-common-dir for locating each worktree's private index (fingerprint input). Best-effort.
    let git_common_dir: Option<PathBuf> = git(root, &["rev-parse", "--git-common-dir"]).ok().map(|d| {
        let p = PathBuf::from(&d);
        if p.is_absolute() { p } else { Path::new(root).join(p) }
    });
    // The integration-branch tips — BOTH local <default> and origin/<default> — folded into EVERY
    // agent's fingerprint so ANY advance of main re-evaluates everyone. This matters for reachability
    // ("On Main"/"Merged") that moves without the agent's OWN tip changing: a LOCAL merge advances
    // local main only (origin unchanged), a fetched remote merge advances origin only — capturing
    // both means the background tick still picks up an orchestrator reaching main (and, in turn, its
    // workers' "Merged", which tracks the parent) instead of waiting for the agent to commit again.
    let origin_default_ref = format!("origin/{default_branch}");
    let default_tip = format!(
        "{}:{}",
        rev_parse_tip(root, &default_branch),
        rev_parse_tip(root, &origin_default_ref),
    );

    // Memoize effective base ref + its tip per distinct logical base (avoid re-resolving per agent).
    let mut base_ref_memo: HashMap<String, String> = HashMap::new();
    let mut base_tip_memo: HashMap<String, String> = HashMap::new();

    let mut out = Vec::with_capacity(agents.len());
    let skipped = |id: &str| AgentStatusResult {
        agent_id: id.to_string(),
        changed: false,
        branch: None,
        workflow: None,
    };
    for a in agents {
        // think/shell have no git workflow — report unchanged so the frontend leaves them alone.
        if a.kind == "think" || a.kind == "shell" {
            out.push(skipped(&a.agent_id));
            continue;
        }
        let wt = match worktree_path(app_data, project_id, &a.agent_id) {
            Ok(p) => p,
            Err(_) => {
                out.push(skipped(&a.agent_id));
                continue;
            }
        };
        let branch = format!("sparkle/agent-{}", a.agent_id);
        let tip = rev_parse_tip(root, &branch);
        let base_ref = base_ref_memo
            .entry(a.base_branch.clone())
            .or_insert_with(|| effective_base(root, &a.base_branch, false))
            .clone();
        let base_tip = base_tip_memo
            .entry(base_ref.clone())
            .or_insert_with(|| rev_parse_tip(root, &base_ref))
            .clone();
        let index_mtime_ms = git_common_dir
            .as_deref()
            .map(|d| worktree_index_mtime_ms(d, &a.agent_id))
            .unwrap_or(0);
        let fp = StatusFingerprint {
            tip: tip.clone(),
            base_tip,
            default_tip: default_tip.clone(),
            index_mtime_ms,
        };
        let wt_key = wt.to_string_lossy().to_string();

        // Skip an idle agent whose fingerprint matches the cache — reuse the prior result.
        if !a.force {
            if let Ok(cache) = status_cache().lock() {
                if cache.get(&wt_key).map(|prev| *prev == fp).unwrap_or(false) {
                    out.push(skipped(&a.agent_id));
                    continue;
                }
            }
        }

        // Compute fresh. A per-agent branch-status error (e.g. a missing branch) is non-fatal: report
        // unchanged so one bad agent can't fail the whole batch (mirrors pollBranchStatus swallowing).
        let branch_status = match branch_status_with_base(root, &a.agent_id, &base_ref, &wt) {
            Ok(bs) => bs,
            Err(e) => {
                tracing::debug!(agent = %a.agent_id, error = %e, "batch branch status failed");
                out.push(skipped(&a.agent_id));
                continue;
            }
        };
        let workflow =
            workflow_state_shared(root, &a.agent_id, &a.parent_branch, &default_branch, has_origin, &tip);

        if let Ok(mut cache) = status_cache().lock() {
            cache.insert(wt_key, fp);
        }
        out.push(AgentStatusResult {
            agent_id: a.agent_id.clone(),
            changed: true,
            branch: Some(branch_status),
            workflow: Some(workflow),
        });
    }
    out
}

/// Branch + workflow status for ALL of a project's agents in ONE call (sparkle-zlic). Async +
/// `spawn_blocking` so the (possibly many) git/gh subprocesses never block the UI thread.
#[tauri::command]
pub async fn project_agents_status(
    app: AppHandle,
    root: String,
    project_id: String,
    agents: Vec<AgentStatusInput>,
    probe_pr_state: bool,
) -> Result<Vec<AgentStatusResult>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        project_agents_status_at(&root, &project_id, &agents, probe_pr_state, &app_data)
    })
    .await
    .map_err(|e| format!("project_agents_status task failed: {e}"))
}

#[derive(Serialize)]
pub struct MarkdownChange {
    /// Repo-root-relative path of the markdown file.
    path: String,
    /// Current content of the file in the worktree.
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSync {
    /// The worktree's current HEAD — the caller stores this as the next sync marker.
    head_sha: String,
    files: Vec<MarkdownChange>,
}

/// Core (AppHandle-free, testable): markdown files an agent committed that the Chief library
/// hasn't seen yet. `since_sha` is the last-synced commit; empty/unknown reseeds from every
/// tracked markdown file. The reseed intentionally includes docs inherited from the base branch
/// (not just ones this agent authored) — the goal is to give Chief the full catch-up of existing
/// project docs, and assets are named by path + commit, not attributed to an agent. `dirs` are
/// directory pathspecs to scope to (e.g. `PRD`, `docs/superpowers/specs`); only `.md` files under
/// them are returned, with current content.
pub fn markdown_changed_since_at(
    project_id: &str,
    agent_id: &str,
    since_sha: &str,
    dirs: &[String],
    app_data: &Path,
) -> Result<MarkdownSync, String> {
    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt_str = wt.to_string_lossy().to_string();
    let head = git(&wt_str, &["rev-parse", "HEAD"])?;

    // A non-empty marker is only usable if it still resolves to a commit in this worktree.
    // Anything else (empty, rewritten history, typo) reseeds rather than erroring.
    let since_valid = !since_sha.is_empty()
        && git(
            &wt_str,
            &["rev-parse", "--verify", "--quiet", &format!("{since_sha}^{{commit}}")],
        )
        .is_ok();

    // `-c core.quotePath=false` keeps non-ASCII paths (e.g. `PRD/café.md`) raw instead of
    // C-quoted (`"PRD/caf\303\251.md"`), which would fail the `.md` suffix test below and be
    // silently dropped.
    let range = format!("{since_sha}..HEAD");
    let mut args: Vec<&str> = if since_valid {
        vec![
            "-c",
            "core.quotePath=false",
            "diff",
            "--name-only",
            "--diff-filter=ACMR",
            &range,
            "--",
        ]
    } else {
        vec!["-c", "core.quotePath=false", "ls-files", "--"]
    };
    for d in dirs {
        args.push(d.as_str());
    }
    // Propagate (don't swallow) a listing failure: a transient git error must leave the marker
    // un-advanced so the next tick retries the range, rather than reporting an empty result that
    // advances HEAD past commits whose markdown was never examined.
    let listing = git(&wt_str, &args)?;

    let mut files = Vec::new();
    for rel in listing.lines().map(str::trim).filter(|l| !l.is_empty()) {
        // Scope to markdown; a directory pathspec also matches sibling non-md files.
        if !rel.ends_with(".md") {
            continue;
        }
        // Read the file's CURRENT content from the worktree (not the historical blob). A file
        // that was changed then deleted, or is unreadable, is skipped rather than fatal.
        if let Ok(content) = std::fs::read_to_string(wt.join(rel)) {
            files.push(MarkdownChange { path: rel.to_string(), content });
        }
    }
    Ok(MarkdownSync { head_sha: head, files })
}

/// Markdown an agent committed since `since_sha`, scoped to `dirs`, for upload into Chief.
#[tauri::command]
pub async fn markdown_changed_since(
    app: AppHandle,
    project_id: String,
    agent_id: String,
    since_sha: String,
    dirs: Vec<String>,
) -> Result<MarkdownSync, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        markdown_changed_since_at(&project_id, &agent_id, &since_sha, &dirs, &app_data)
    })
    .await
    .map_err(|e| format!("markdown_changed_since task failed: {e}"))?
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
    let wt = worktree_path(app_data, project_id, agent_id)?;
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
    let mut rebase = Command::new(crate::preflight::git_program());
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
pub async fn refresh_agent_branch(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
) -> Result<RefreshOutcome, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        refresh_agent_branch_at(&root, &project_id, &agent_id, &base_branch, &app_data)
    })
    .await
    .map_err(|e| format!("refresh_agent_branch task failed: {e}"))?
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum LandOutcome {
    // `merge_sha` is the merge commit this land created on the target — captured so the caller can
    // record it on the bead and the delivery monitor can later test that exact commit for release
    // containment (Task B). Empty only if `rev-parse` failed. NOTE: `LandOutcome` is `untagged` with
    // no container `rename_all`, so this multi-word field MUST carry an explicit `rename` — the TS
    // `LandResult` reads `mergeSha`, and without this it would deserialize as undefined (silent
    // no-op). The pre-existing fields are single words, which is why none needed a rename.
    Ok {
        ok: bool,
        target: String,
        #[serde(rename = "mergeSha")]
        merge_sha: String,
    },
    Err { ok: bool, reason: String, files: Vec<String> },
}

/// Path of the worktree that currently has `branch` checked out (`refs/heads/<branch>`), via
/// `git worktree list --porcelain`. None when no worktree has it checked out.
fn worktree_on_branch(root: &str, branch: &str) -> Option<String> {
    let listing = git(root, &["worktree", "list", "--porcelain"]).ok()?;
    let want = format!("refs/heads/{branch}");
    let mut cur_path: Option<String> = None;
    for line in listing.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if b.trim() == want {
                return cur_path;
            }
        }
    }
    None
}

/// Core (AppHandle-free, testable): merge an agent's branch into `target_branch` LOCALLY. The merge
/// runs INSIDE whichever worktree currently has `target_branch` checked out, sidestepping git's
/// "cannot update a checked-out branch" refusal. Guarded — refuses unless that worktree is clean —
/// and aborts cleanly on conflict so the target is byte-identical to before. `target_branch` is the
/// orchestrator's branch for a worker, or the project's default branch for a build agent. A live
/// PTY on the target is gated on the frontend (like refresh).
pub fn land_agent_branch_at(
    root: &str,
    agent_id: &str,
    target_branch: &str,
) -> Result<LandOutcome, String> {
    let err = |reason: &str, files: Vec<String>| {
        Ok(LandOutcome::Err { ok: false, reason: reason.into(), files })
    };
    let target = target_branch.trim();
    if target.is_empty() {
        return err("no-target", vec![]);
    }
    let branch = format!("sparkle/agent-{agent_id}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")]).is_err() {
        return err("no-branch", vec![]);
    }
    // The target must resolve to a real commit. Otherwise the rev-list below errors and would
    // collapse to ahead==0, masquerading a missing/typo'd target as a misleading "nothing-to-land".
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{target}^{{commit}}")]).is_err() {
        return err("no-target", vec![]);
    }
    // Nothing to land if the target already contains every commit on the branch.
    let ahead: u32 = git(root, &["rev-list", "--count", &format!("{target}..{branch}")])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if ahead == 0 {
        return err("nothing-to-land", vec![]);
    }
    // The target must be checked out somewhere so we can merge there without fighting git.
    let Some(wt) = worktree_on_branch(root, target) else {
        return err("target-not-checked-out", vec![]);
    };
    // Never disturb a dirty target checkout (the user's main, or a busy orchestrator's tree).
    if !git(&wt, &["status", "--porcelain"])?.is_empty() {
        return err("dirty", vec![]);
    }
    let msg = format!("Land {branch} into {target}");
    let mut merge = Command::new(crate::preflight::git_program());
    merge.arg("-C").arg(&wt).args(["merge", "--no-ff", &branch, "-m", &msg]);
    apply_noninteractive(&mut merge);
    match merge.output() {
        Ok(o) if o.status.success() => {
            // The merge (--no-ff) left a merge commit at the target worktree's HEAD — record it so
            // the bead can carry its exact landed SHA for release-containment checks. Best-effort:
            // an empty string just means the monitor treats this bead as not-yet-testable (honest).
            let merge_sha = git(&wt, &["rev-parse", "HEAD"]).unwrap_or_default().trim().to_string();
            Ok(LandOutcome::Ok { ok: true, target: target.to_string(), merge_sha })
        }
        _ => {
            // Conflicted paths distinguish a real merge conflict from a non-conflict failure (git
            // errored, or the process failed to spawn): only the former populates --diff-filter=U.
            let files: Vec<String> = git(&wt, &["diff", "--name-only", "--diff-filter=U"])
                .unwrap_or_default()
                .lines()
                .map(|s| s.to_string())
                .collect();
            // Abort to leave the target byte-identical (a no-op if no merge was actually in flight).
            let _ = git(&wt, &["merge", "--abort"]);
            if files.is_empty() {
                err("merge-failed", vec![])
            } else {
                err("conflict", files)
            }
        }
    }
}

/// Merge an agent's branch into its integration target (orchestrator branch for a worker, project
/// default for a build agent) locally. Refuses a dirty target; aborts cleanly on conflict. A live
/// PTY on the target worktree is gated on the frontend.
#[tauri::command]
pub async fn land_agent_branch(
    root: String,
    agent_id: String,
    target_branch: String,
) -> Result<LandOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        land_agent_branch_at(&root, &agent_id, &target_branch)
    })
    .await
    .map_err(|e| format!("land_agent_branch task failed: {e}"))?
}

/// Core (testable): push an agent's branch to `origin`. Returns "pushed" on success, or "no-remote"
/// when the project has no `origin` (the caller then falls back to a local land or keeps the branch
/// locally). A git failure (auth/network) surfaces as Err so the UI can report it.
pub fn push_agent_branch_at(root: &str, agent_id: &str) -> Result<String, String> {
    if git(root, &["remote", "get-url", "origin"]).is_err() {
        return Ok("no-remote".to_string());
    }
    let branch = format!("sparkle/agent-{agent_id}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")]).is_err() {
        return Err("no-branch".to_string());
    }
    git(root, &["push", "-u", "origin", &branch]).map(|_| "pushed".to_string())
}

/// Push an agent's branch to `origin` for the close-agent Ship/Save paths. "pushed" | "no-remote".
#[tauri::command]
pub async fn push_agent_branch(root: String, agent_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || push_agent_branch_at(&root, &agent_id))
        .await
        .map_err(|e| format!("push_agent_branch task failed: {e}"))?
}

/// Core (testable): delete an agent's local branch — the Discard path. Force (`-D`) because the
/// branch is intentionally unmerged here; that's what Discard means. Idempotent: an already-gone
/// branch is Ok. The caller MUST remove the worktree first (git refuses to delete a checked-out
/// branch) and gate this behind an explicit confirmation.
pub fn delete_agent_branch_at(root: &str, agent_id: &str) -> Result<(), String> {
    let branch = format!("sparkle/agent-{agent_id}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_err() {
        return Ok(()); // already gone — Discard is idempotent
    }
    git(root, &["branch", "-D", &branch]).map(|_| ())
}

/// Delete an agent's local branch (Discard). See `delete_agent_branch_at`.
#[tauri::command]
pub async fn delete_agent_branch(root: String, agent_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_agent_branch_at(&root, &agent_id))
        .await
        .map_err(|e| format!("delete_agent_branch task failed: {e}"))?
}

/// Core (testable): delete an agent's local branch on close, ONLY when it's effectively landed on
/// the integration branch; otherwise KEEP it. Uses the SAME robust detection as the workflow
/// "landed" signal — `ref_contains` (fast-forward ancestry) OR `merge_adds_nothing` (merge-tree,
/// which catches squash/rebase merges where the branch tip isn't an ancestor of the target). A plain
/// `git branch -d` would refuse the squash/rebase case and silently no-op the user's "delete"
/// setting on the common GitHub path.
///
/// PRECONDITION: invoked only for a SHIPPED agent (the caller — closeBuildAgent / the Close button —
/// gates on `workflowShipped`). Note `merge_adds_nothing` means "adds nothing to the target", which
/// is true of a genuinely merged branch but ALSO of a zero-diff branch (never committed, or
/// net-reverted) — so this is "effectively landed", not a strict merge proof. That's safe under the
/// shipped gate (a zero-work branch never ships); a future caller without that gate must not reuse
/// this assuming it strictly means "merged". Idempotent (already-gone is Ok); the caller MUST remove
/// the worktree first (git refuses to delete a checked-out branch).
pub fn delete_agent_branch_if_merged_at(root: &str, agent_id: &str) -> Result<(), String> {
    let branch = format!("sparkle/agent-{agent_id}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_err() {
        return Ok(()); // already gone — idempotent
    }
    let target = resolve_default_branch(root);
    // Refresh origin first when there's a remote: a squash/rebase PR merge lands on origin/<target>,
    // and local <target> is typically NOT fast-forwarded in the desktop flow, so without this the
    // delete would miss the common GitHub path. Throttled per repo (maybe_refresh_origin).
    if git(root, &["remote", "get-url", "origin"]).is_ok() {
        maybe_refresh_origin(root, &target);
    }
    let tip = git(root, &["rev-parse", &branch]).unwrap_or_default();
    if branch_landed(root, &target, &branch, tip.trim()) {
        // Confirmed landed on local OR origin <target> → safe to remove (force, since a squash/rebase
        // merge means `-d`'s ancestry check would refuse a branch that IS effectively landed).
        let _ = git(root, &["branch", "-D", &branch]);
    }
    Ok(()) // not landed → keep the branch (no-op, no error)
}

/// SAFELY delete an agent's merged branch (close a shipped agent). See
/// `delete_agent_branch_if_merged_at`.
#[tauri::command]
pub async fn delete_agent_branch_if_merged(root: String, agent_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_agent_branch_if_merged_at(&root, &agent_id))
        .await
        .map_err(|e| format!("delete_agent_branch_if_merged task failed: {e}"))?
}

/// Build the `gh pr create` argv for an agent branch. Pure + tested so the guard/defaulting logic is
/// exercised without invoking `gh`: rejects a blank `target` (else `--base ""` yields an opaque gh
/// error) and falls back to the branch name when `title` is blank.
fn pr_create_args(branch: &str, target: &str, title: &str) -> Result<Vec<String>, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("no target branch".to_string());
    }
    let title = if title.trim().is_empty() { branch } else { title.trim() };
    Ok(vec![
        "pr".into(),
        "create".into(),
        "--head".into(),
        branch.to_string(),
        "--base".into(),
        target.to_string(),
        "--title".into(),
        title.to_string(),
        "--body".into(),
        "Opened by Sparkle (close-agent → Ship).".into(),
    ])
}

/// Open a GitHub PR for an agent's branch via `gh pr create` (best-effort: needs `gh`, auth, and an
/// `origin`). Returns the PR URL on success. The caller pushes FIRST. This is the close-agent Ship
/// path's default so work goes through review (roborev) rather than merging straight to main.
/// Pre-checks the branch exists and the target is non-empty so a missing branch / blank base surface
/// as clear errors instead of opaque `gh` stderr; other failures (no gh / PR already exists / no
/// remote) surface as Err for the caller to handle.
#[tauri::command]
pub async fn open_agent_pr(
    root: String,
    agent_id: String,
    target_branch: String,
    title: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = format!("sparkle/agent-{agent_id}");
        if git(&root, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")]).is_err() {
            return Err("no-branch".to_string());
        }
        let args = pr_create_args(&branch, &target_branch, &title)?;
        let mut cmd = Command::new(crate::preflight::gh_program());
        cmd.args(&args)
            .current_dir(&root)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1");
        apply_noninteractive(&mut cmd);
        let out = cmd.output().map_err(|e| format!("failed to run gh: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("open_agent_pr task failed: {e}"))?
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
    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt_str = wt.to_string_lossy().to_string();
    // Evict this worktree's batch-poll status fingerprint (keyed by worktree path). Otherwise the
    // entry lingers for the app's lifetime for a removed agent — and if a future agent ever reused
    // the same path, a stale fingerprint could wrongly skip its first real recompute.
    if let Ok(mut cache) = status_cache().lock() {
        cache.remove(&wt_str);
    }
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
/// Sync core of [`move_project`]; a plain fn so the async command can offload it via
/// `spawn_blocking` and the test suite can drive it directly.
fn move_project_inner(old_path: String, new_path: String) -> Result<(), String> {
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

/// Move/rename a project folder on disk, then repair its worktree links. `async` + `spawn_blocking`
/// so the `std::fs::rename` (cross-dir) and `git worktree repair` subprocesses can't stall the UI.
#[tauri::command]
pub async fn move_project(old_path: String, new_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || move_project_inner(old_path, new_path))
        .await
        .map_err(|e| format!("move_project task failed: {e}"))?
}

/// Tripwire: confirm a worktree path's git toplevel IS that worktree — i.e. it can't resolve
/// up into a parent checkout. Called before spawning an agent's PTY.
/// Sync core of [`assert_workspace_integrity`]; a plain fn so the async command can offload it via
/// `spawn_blocking` and the test suite can drive it directly.
fn assert_workspace_integrity_inner(worktree: String) -> Result<(), String> {
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

/// Confirm a worktree path's git toplevel IS that worktree (isolation tripwire, run before spawning
/// an agent's PTY). `async` + `spawn_blocking` so the `canonicalize` + `git rev-parse` never stall
/// the UI thread.
#[tauri::command]
pub async fn assert_workspace_integrity(worktree: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || assert_workspace_integrity_inner(worktree))
        .await
        .map_err(|e| format!("assert_workspace_integrity task failed: {e}"))?
}

/// Tools that Sparkle pre-approves in every worktree's `.claude/settings.local.json` so
/// interactive agents (Think/Build/generic) stop prompting for them. Two buckets:
///   1. Sparkle's OWN control-plane MCP servers — the app driving itself should never ask the
///      human for permission (that's the friction shown in the set_agent_activity prompt). A bare
///      `mcp__<server>` rule allows every tool the server exposes.
///   2. Read-only operations agents perform constantly — reading files, searching, fetching the
///      web, and *reading* browser state. Nothing here mutates the world.
/// Deliberately EXCLUDED (still prompt on interactive agents): Bash, Edit, Write, MultiEdit,
/// NotebookEdit, and any browser tool that acts (navigate/computer/form_input). Workers already
/// run with `--dangerously-skip-permissions`, so for them this list is a harmless no-op.
const SPARKLE_ALLOWED_TOOLS: &[&str] = &[
    // Sparkle's own control plane.
    "mcp__sparkle-control",
    "mcp__sparkle-orchestrator",
    // Read-only built-ins.
    "Read",
    "Grep",
    "Glob",
    "WebFetch",
    "WebSearch",
    // Read-only browser inspection (claude-in-chrome), for non-strict agents that load it.
    "mcp__claude-in-chrome__read_page",
    "mcp__claude-in-chrome__get_page_text",
    "mcp__claude-in-chrome__read_console_messages",
    "mcp__claude-in-chrome__read_network_requests",
    "mcp__claude-in-chrome__tabs_context_mcp",
];

/// Merge Sparkle's pre-approved allowlist into `permissions.allow`, preserving any rules the user
/// already added and de-duplicating by rule string (idempotent across re-runs).
fn merge_allowed_tools(root: &mut Value) {
    let obj = root.as_object_mut().unwrap();
    let permissions = obj.entry("permissions").or_insert_with(|| json!({}));
    if !permissions.is_object() {
        *permissions = json!({});
    }
    let allow = permissions
        .as_object_mut()
        .unwrap()
        .entry("allow")
        .or_insert_with(|| json!([]));
    if !allow.is_array() {
        *allow = json!([]);
    }
    let arr = allow.as_array_mut().unwrap();
    for tool in SPARKLE_ALLOWED_TOOLS {
        let already = arr.iter().any(|e| e.as_str() == Some(*tool));
        if !already {
            arr.push(json!(tool));
        }
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
    // Bash is included so the guard also sees shell commands: it blocks a `security`-CLI invocation
    // against the ai.sparkle.desktop keychain (sparkle-0ezz) in addition to its Edit/Write file-path
    // containment. The guard script exits 0 for any Bash command that isn't the keychain pattern.
    let hook_entry = json!({
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
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
    // Pre-approve Sparkle's own MCP tools + read-only ops so interactive agents stop prompting.
    merge_allowed_tools(&mut root);
    serde_json::to_string_pretty(&root).unwrap()
}

/// Write/merge the guard into `<worktree>/.claude/settings.local.json` (the gitignored variant).
#[tauri::command]
pub async fn install_worktree_guard(app: AppHandle, worktree: String) -> Result<(), String> {
    // `async` + `spawn_blocking`: the resource staging (fs copy into app-data) and the
    // settings.local.json read/merge/write are IO that must not stall the UI thread. AppHandle is
    // Send + Clone, so it moves cleanly onto the blocking task.
    tauri::async_runtime::spawn_blocking(move || {
        // Stage the guard to a stable app-data path (not the app bundle) so the command baked into
        // settings.local.json survives the bundle being renamed/replaced/removed. See
        // hooks::stage_resource_script; hooks::heal_agent_hooks re-points stale copies at launch.
        let guard = crate::hooks::stage_resource_script(&app, "worktree-guard.mjs")?;
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
    })
    .await
    .map_err(|e| format!("install_worktree_guard task failed: {e}"))?
}

/// Minimal POSIX single-quote escaping for embedding a path in a hook command string.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Read a worker's `.sparkle/result.json` from its worktree. `Ok(None)` if not yet written.
pub fn read_worker_result_at(worktree: &Path) -> Result<Option<String>, String> {
    let path = worktree.join(".sparkle").join("result.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read worker result: {e}")),
    }
}

#[tauri::command]
pub async fn read_worker_result(worktree: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_worker_result_at(Path::new(&worktree)))
        .await
        .map_err(|e| format!("read_worker_result task failed: {e}"))?
}

// ── Durable per-worktree worker manifest (sparkle-hwfv / a670 / 3xus) ──────────────────────────
//
// A worker's identity + ownership used to live ONLY in the frontend projectStore, which is
// persisted-per-mutation, cross-window synced (last-writer-wins), and rebuilt by reconcile /
// relocation passes that can EVICT a just-added worker AFTER its worktree is cut. When that
// happens the worker is lost from list_workers, spin_down reports "not owned", and the worker
// stalls with no task — needing an app restart. The fix writes an authoritative copy of the
// worker's identity to disk INSIDE its worktree (`.sparkle/worker.json`, sibling of the
// `result.json` read above), so an evicted in-memory record can be re-derived from disk without
// a restart. Mirrors `read_worker_result_at` — same `.sparkle/` dir (gitignored by
// `ensure_project_repo`), same not-found-is-Ok semantics.

/// Path to a worker's durable manifest inside its worktree.
pub fn worker_manifest_path(worktree: &Path) -> PathBuf {
    worktree.join(".sparkle").join("worker.json")
}

/// Write a worker's manifest (`.sparkle/worker.json`) into its worktree, creating `.sparkle/` if
/// needed. Pretty-printed for human inspection. `manifest` is the full identity object the
/// frontend assembled at spawn (`{workerId,buildAgentId,projectId,branch,worktree,task,beadId,
/// createdAt}`). Written BEFORE spawn replies, so the reply can never precede the durable record.
pub fn write_worker_manifest_at(worktree: &Path, manifest: &Value) -> Result<(), String> {
    let sparkle = worktree.join(".sparkle");
    std::fs::create_dir_all(&sparkle).map_err(|e| format!("mkdir .sparkle: {e}"))?;
    let body = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("serialize worker manifest: {e}"))?;
    std::fs::write(worker_manifest_path(worktree), body)
        .map_err(|e| format!("write worker manifest: {e}"))
}

/// Read a worker's manifest from its worktree. `Ok(None)` if absent (a legacy worker cut before
/// manifests existed, or a worktree that was never a worker). Malformed JSON is surfaced as Err.
pub fn read_worker_manifest_at(worktree: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(worker_manifest_path(worktree)) {
        Ok(s) => {
            let v: Value =
                serde_json::from_str(&s).map_err(|e| format!("parse worker manifest: {e}"))?;
            Ok(Some(v))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read worker manifest: {e}")),
    }
}

/// Scan every worktree under `<app_data>/worktrees/<project_id>/` and return the parsed manifest
/// of each one that has a readable `.sparkle/worker.json`. Each returned manifest has its
/// `worktree` field set to the ACTUAL directory found on disk (authoritative, even if the value
/// written at spawn is stale), so the reconcile pass can re-adopt the worker at its real path.
/// Worktrees without a manifest (legacy workers, agent worktrees) or with unparseable JSON are
/// skipped — the scan is a best-effort self-heal, never fatal. A missing worktrees dir -> empty.
pub fn scan_worker_manifests_at(app_data: &Path, project_id: &str) -> Result<Vec<Value>, String> {
    validate_id("project_id", project_id)?;
    let dir = app_data.join("worktrees").join(project_id);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read worktrees dir: {e}")),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let wt = entry.path();
        if !wt.is_dir() {
            continue;
        }
        // Skip unreadable/malformed manifests rather than failing the whole scan.
        let mut v = match read_worker_manifest_at(&wt) {
            Ok(Some(v)) => v,
            _ => continue,
        };
        let Some(obj) = v.as_object_mut() else { continue };
        // Overwrite `worktree` with the real on-disk path — the source of truth for adoption.
        obj.insert(
            "worktree".to_string(),
            Value::String(wt.to_string_lossy().to_string()),
        );
        out.push(v);
    }
    Ok(out)
}

/// Write a worker's durable manifest into its worktree (Tauri command). Called by spawnWorker
/// after the worktree is cut and BEFORE the orchestration reply is assembled (sparkle-hwfv).
#[tauri::command]
pub async fn write_worker_manifest(worktree: String, manifest: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_worker_manifest_at(Path::new(&worktree), &manifest)
    })
    .await
    .map_err(|e| format!("write_worker_manifest task failed: {e}"))?
}

/// Read a single worker's manifest (Tauri command). `Ok(None)` if absent.
#[tauri::command]
pub async fn read_worker_manifest(worktree: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || read_worker_manifest_at(Path::new(&worktree)))
        .await
        .map_err(|e| format!("read_worker_manifest task failed: {e}"))?
}

/// Scan a project's worktrees for worker manifests (Tauri command). Powers the on-disk reconcile
/// pass (sparkle-3xus): the frontend re-adopts any worker whose worktree+manifest survive on disk
/// but whose in-memory store record was evicted.
#[tauri::command]
pub async fn scan_worker_manifests(app: AppHandle, project_id: String) -> Result<Vec<Value>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || scan_worker_manifests_at(&app_data, &project_id))
        .await
        .map_err(|e| format!("scan_worker_manifests task failed: {e}"))?
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

    /// `remove_repo_hooks` deletes ONLY hooks whose contents carry our vendored marker, and never
    /// clobbers a user's own same-named hook. (The `install_repo_hooks` copy path needs an AppHandle
    /// resource resolver, so it's exercised via the app; the safety-critical marker guard is pure.)
    #[test]
    fn remove_repo_hooks_only_deletes_our_marked_hooks() {
        let root = unique_root("roborev-hooks");
        let root_str = root.to_string_lossy().to_string();
        let hooks = root.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();

        // Ours: carries the vendored marker → must be removed.
        let ours = hooks.join("post-commit");
        std::fs::write(&ours, "#!/bin/sh\n# roborev post-commit — seed-owned wrapper\n").unwrap();
        // The user's OWN post-rewrite hook (no marker) → must be preserved.
        let theirs = hooks.join("post-rewrite");
        std::fs::write(&theirs, "#!/bin/sh\necho my own hook\n").unwrap();

        remove_repo_hooks(&root_str).unwrap();

        assert!(!ours.exists(), "our marked post-commit hook should be removed");
        assert!(theirs.exists(), "a user's unmarked post-rewrite hook must be left untouched");

        // Idempotent: a second sweep (nothing of ours left) is a clean no-op.
        remove_repo_hooks(&root_str).unwrap();
        assert!(theirs.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A linked worktree's `.git` is a gitlink FILE, so the old `<root>/.git/hooks` join produced a
    /// path under a regular file and every install failed with ENOTDIR — roborev review silently
    /// never installed for worktree-rooted projects. `hooks_dir_for` must resolve a worktree to its
    /// parent repo's shared hooks dir, which is where git actually runs hooks from.
    #[test]
    fn hooks_dir_for_resolves_a_worktree_to_the_shared_hooks_dir() {
        let root = unique_root("hooks-dir-worktree");
        let main = root.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let main_str = main.to_string_lossy().to_string();

        // A real repo with one commit, so a worktree can be cut from it.
        for args in [
            vec!["init", "-q"],
            // Identity is required to commit; git does not validate the shape, so keep these
            // free of anything resembling a real address.
            vec!["config", "user.email", "sparkle-test"],
            vec!["config", "user.name", "sparkle-test"],
            vec!["commit", "-q", "--allow-empty", "-m", "seed"],
        ] {
            git(&main_str, &args).unwrap();
        }

        // Normal clone: hooks live in the repo's own .git/hooks.
        assert_eq!(hooks_dir_for(&main_str), main.join(".git").join("hooks"));

        let wt = root.join("wt");
        let wt_str = wt.to_string_lossy().to_string();
        git(&main_str, &["worktree", "add", "-q", &wt_str, "-b", "side"]).unwrap();

        // Precondition: this is the layout that used to break — .git is a file, not a directory.
        assert!(wt.join(".git").is_file(), "a linked worktree's .git must be a gitlink file");

        // The worktree resolves to the SHARED hooks dir, and creating it succeeds (the ENOTDIR fix).
        let resolved = hooks_dir_for(&wt_str);
        assert_eq!(
            std::fs::canonicalize(resolved.parent().unwrap()).unwrap(),
            std::fs::canonicalize(main.join(".git")).unwrap(),
            "worktree hooks must resolve under the parent repo's gitdir"
        );
        std::fs::create_dir_all(&resolved).expect("hooks dir must be creatable (was ENOTDIR)");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The INSTALL-side safety rule (the fix for the clobber regression): we may write our hook only
    /// when there's nothing there, or when the existing file is already ours — never over a user's
    /// own same-named hook. Pure, so it's pinned without the bundle resource resolver.
    #[test]
    fn may_write_hook_never_clobbers_a_foreign_hook() {
        let marker = "seed-owned wrapper"; // the distinctive marker line in the vendored post-commit
        // Absent → safe to install.
        assert!(may_write_hook(false, None, marker), "no existing hook → safe to install");
        // Present + readable + ours → safe to refresh.
        assert!(
            may_write_hook(true, Some("#!/bin/sh\n# roborev post-commit — seed-owned wrapper\n"), marker),
            "our own hook → safe to refresh"
        );
        // Present + readable + foreign → preserve.
        assert!(
            !may_write_hook(true, Some("#!/bin/sh\necho my own precommit\n"), marker),
            "a user's foreign hook → must NOT be overwritten"
        );
        // Present + readable + merely MENTIONS roborev in a comment (but not our marker) → foreign.
        assert!(
            !may_write_hook(true, Some("#!/bin/sh\n# I run roborev post-commit myself\ntrue\n"), marker),
            "a foreign hook that only mentions roborev → must NOT be misclassified as ours"
        );
        // Present but UNREADABLE (binary hook / permission error → contents None) → foreign, preserve.
        // This is the key regression: `exists=true, contents=None` must NOT be treated as absent.
        assert!(
            !may_write_hook(true, None, marker),
            "a present-but-unreadable (binary/perm) hook → must NOT be overwritten"
        );
        // Empty-but-present foreign file is still foreign.
        assert!(!may_write_hook(true, Some(""), marker));
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

    /// Minimal git repo on `main` with one commit, for branch-delete tests.
    fn init_repo(tag: &str) -> String {
        let root = unique_root(tag);
        let r = root.to_str().unwrap().to_string();
        git(&r, &["init", "-q"]).unwrap();
        git(&r, &["config", "user.email", "t@t"]).unwrap();
        git(&r, &["config", "user.name", "t"]).unwrap();
        git(&r, &["commit", "--allow-empty", "-m", "init"]).unwrap();
        git(&r, &["branch", "-M", "main"]).unwrap();
        r
    }

    fn branch_exists(root: &str, branch: &str) -> bool {
        git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
    }

    // Regression: opening a project directory that is an ORPHANED git worktree — a `.git`
    // gitfile pointing at a `.git/worktrees/<name>` admin dir that has since been pruned — used to
    // dead-end with "git init failed: fatal: not a git repository: <gitdir>" because `git init`
    // follows the dangling pointer. ensure_project_repo_inner must recover it into a fresh repo.
    #[test]
    fn ensure_project_repo_recovers_orphaned_worktree() {
        let root = unique_root("orphan-worktree");
        let r = root.to_str().unwrap().to_string();
        // Simulate the survivor: real files plus a `.git` gitfile whose target no longer exists.
        std::fs::write(format!("{r}/keep.txt"), "user data").unwrap();
        let dead_gitdir = format!("{r}/nonexistent/.git/worktrees/gone");
        std::fs::write(format!("{r}/.git"), format!("gitdir: {dead_gitdir}\n")).unwrap();

        // Precondition: this is exactly the state that made `git init` fail.
        assert!(git(&r, &["rev-parse", "--git-dir"]).is_err(), "orphaned worktree must not resolve");
        assert!(git(&r, &["init"]).is_err(), "plain init follows the dead pointer and fails");

        // The fix recovers it into a real standalone repo with a born HEAD.
        ensure_project_repo_inner(r.clone()).expect("orphaned worktree should be recovered");
        assert!(git(&r, &["rev-parse", "HEAD"]).is_ok(), "recovered repo has a born HEAD");
        assert!(Path::new(&r).join(".git").is_dir(), ".git is now a real repo directory");
        assert!(Path::new(&r).join(".git.orphaned").exists(), "dead pointer preserved, not destroyed");
        assert!(Path::new(&r).join("keep.txt").exists(), "user files are untouched");
    }

    // A LIVE worktree (its admin dir still exists) must be left completely alone — the helper only
    // fires after rev-parse fails, but guard against ever disturbing a healthy `.git` gitfile.
    #[test]
    fn clear_dangling_gitfile_leaves_live_worktree_alone() {
        let root = unique_root("live-worktree");
        let r = root.to_str().unwrap().to_string();
        let live_gitdir = format!("{r}/real-admin-dir");
        std::fs::create_dir_all(&live_gitdir).unwrap();
        std::fs::write(format!("{r}/.git"), format!("gitdir: {live_gitdir}\n")).unwrap();

        clear_dangling_gitfile(&r);
        assert!(Path::new(&r).join(".git").is_file(), "live gitfile must remain in place");
        assert!(!Path::new(&r).join(".git.orphaned").exists(), "nothing should be moved aside");
    }

    // sparkle-zlic: the batched status command computes every agent in one pass and, crucially,
    // SKIPS an idle agent whose fingerprint (tip + base + default + index mtime) is unchanged since
    // the last tick — while `force` always recomputes and a new commit re-evaluates.
    #[test]
    fn batch_status_skips_unchanged_and_recomputes_on_change() {
        let r = init_repo("batch-skip");
        let app_data = unique_root("batch-skip-appdata");
        let info = create_worktree_at(&r, "p1", "a1", "main", &app_data).unwrap();
        let wt = info.path;
        // One commit in the worktree → the branch is 1 ahead of main.
        std::fs::write(format!("{wt}/w.txt"), "work").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work"]).unwrap();

        let input = |force: bool| AgentStatusInput {
            agent_id: "a1".into(),
            base_branch: "main".into(),
            parent_branch: String::new(),
            kind: "build".into(),
            force,
        };
        // probe_pr_state=false ⇒ no origin fetch / gh probe, purely local + offline-safe.
        let first = project_agents_status_at(&r, "p1", &[input(false)], false, &app_data);
        assert_eq!(first.len(), 1);
        assert!(first[0].changed, "first tick computes");
        assert_eq!(first[0].branch.as_ref().unwrap().ahead, 1);

        // Nothing changed → skipped (no payload; the frontend keeps its prior values).
        let second = project_agents_status_at(&r, "p1", &[input(false)], false, &app_data);
        assert!(!second[0].changed, "unchanged idle agent is skipped");
        assert!(second[0].branch.is_none());

        // force=true recomputes even when the fingerprint is unchanged.
        let forced = project_agents_status_at(&r, "p1", &[input(true)], false, &app_data);
        assert!(forced[0].changed, "force always recomputes");
        assert_eq!(forced[0].branch.as_ref().unwrap().ahead, 1);

        // A new commit moves the tip → fingerprint changes → recompute picks up ahead=2.
        std::fs::write(format!("{wt}/w2.txt"), "more").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "more"]).unwrap();
        let after = project_agents_status_at(&r, "p1", &[input(false)], false, &app_data);
        assert!(after[0].changed, "a new commit re-evaluates");
        assert_eq!(after[0].branch.as_ref().unwrap().ahead, 2);
    }

    // Resilience: a recorded base branch that no longer exists (the repo was renamed
    // `main` → `master`, or the base was deleted) must NOT be handed to git as a phantom ref.
    // `effective_base` falls back to the repo's actual default; a base that DOES exist is
    // returned unchanged.
    #[test]
    fn effective_base_recovers_from_a_drifted_recorded_base() {
        let r = init_repo("eb-drift"); // one commit, on `main`
        // Drift: the integration branch was renamed out from under the recorded default.
        git(&r, &["branch", "-m", "main", "master"]).unwrap();
        assert!(!branch_exists(&r, "main"), "precondition: main is gone");
        assert!(branch_exists(&r, "master"), "precondition: master is the real default");

        // The now-missing "main" resolves to the detected default instead of a bogus name.
        assert_eq!(effective_base(&r, "main", false), "master");
        // A base that still exists is returned verbatim.
        assert_eq!(effective_base(&r, "master", false), "master");
        // An empty/legacy base still auto-detects (unchanged behavior).
        assert_eq!(effective_base(&r, "", false), "master");
    }

    // Store-healing: reconcile_default_branch_at keeps a still-valid recorded value (including a
    // deliberate non-default), but heals a drifted/empty one to the repo's actual default.
    #[test]
    fn reconcile_default_branch_heals_drift_but_preserves_valid_choices() {
        let r = init_repo("reconcile-drift"); // one commit, on `main`
        // A recorded value that still exists is kept verbatim.
        assert_eq!(reconcile_default_branch_at(&r, "main"), "main");
        // A deliberate non-default branch that exists is preserved, NOT overwritten with the default.
        git(&r, &["branch", "develop"]).unwrap();
        assert_eq!(reconcile_default_branch_at(&r, "develop"), "develop");
        // Drift: rename main → master so the recorded "main" no longer resolves → heal to master.
        git(&r, &["branch", "-m", "main", "master"]).unwrap();
        assert_eq!(reconcile_default_branch_at(&r, "main"), "master");
        // An empty recorded value auto-detects the default.
        assert_eq!(reconcile_default_branch_at(&r, ""), "master");
        // A syntactically unsafe recorded value is never trusted; it heals to the default.
        assert_eq!(reconcile_default_branch_at(&r, "--upload-pack=evil"), "master");
    }

    // A recorded value that resolves ONLY as a remote-tracking ref (origin/<name>, no local branch —
    // the common fresh-clone shape) is still preserved verbatim, not overwritten with the default.
    #[test]
    fn reconcile_default_branch_preserves_a_remote_only_recorded_value() {
        let upstream = init_repo("reconcile-remote-up"); // has `main`
        git(&upstream, &["branch", "release"]).unwrap(); // a non-default integration branch upstream
        let local_root = unique_root("reconcile-remote-local");
        let l = local_root.to_str().unwrap().to_string();
        git(&l, &["init", "-q"]).unwrap();
        git(&l, &["config", "user.email", "t@t"]).unwrap();
        git(&l, &["config", "user.name", "t"]).unwrap();
        git(&l, &["remote", "add", "origin", &upstream]).unwrap();
        git(&l, &["fetch", "-q", "origin"]).unwrap();
        assert!(!branch_exists(&l, "release"), "no local branch, remote-tracking only");
        assert!(git(&l, &["rev-parse", "--verify", "--quiet", "refs/remotes/origin/release"]).is_ok());

        // "release" exists only as origin/release → preserved, NOT healed to a different default.
        assert_eq!(reconcile_default_branch_at(&l, "release"), "release");
    }

    // Remote-only detected default: a fresh clone whose default exists solely as `origin/<default>`
    // (no local branch yet). When the recorded base is a phantom, effective_base must cut from that
    // remote-tracking ref rather than dropping to HEAD.
    #[test]
    fn effective_base_uses_remote_detected_default_when_local_missing() {
        let upstream = init_repo("eb-remote-up"); // has `main`, one commit
        let local_root = unique_root("eb-remote-local");
        let l = local_root.to_str().unwrap().to_string();
        git(&l, &["init", "-q"]).unwrap();
        git(&l, &["config", "user.email", "t@t"]).unwrap();
        git(&l, &["config", "user.name", "t"]).unwrap();
        git(&l, &["remote", "add", "origin", &upstream]).unwrap();
        git(&l, &["fetch", "-q", "origin"]).unwrap();
        // origin/HEAD → origin/main, but fetch created NO local `main` branch.
        git(&l, &["remote", "set-head", "origin", "main"]).unwrap();
        assert!(!branch_exists(&l, "main"), "no local default branch exists");
        assert!(git(&l, &["rev-parse", "--verify", "--quiet", "origin/main"]).is_ok());

        // Recorded base "develop" resolves to nothing (no local, no origin/develop); the detected
        // default "main" exists only as origin/main → cut from origin/main, never HEAD.
        assert_eq!(effective_base(&l, "develop", false), "origin/main");
    }

    // Last-resort cascade: when neither the requested base NOR any named default branch resolves
    // (detached HEAD, every branch deleted, no remote), `effective_base` cuts from `HEAD` rather
    // than handing git a phantom name.
    #[test]
    fn effective_base_uses_head_when_no_named_base_resolves() {
        let r = init_repo("eb-head"); // one commit, on `main`
        let sha = git(&r, &["rev-parse", "HEAD"]).unwrap();
        // Detach, then delete every named branch so nothing but HEAD resolves.
        git(&r, &["checkout", "-q", "--detach", &sha]).unwrap();
        git(&r, &["branch", "-D", "main"]).unwrap();
        assert!(!branch_exists(&r, "main"));
        assert!(!branch_exists(&r, "master"));
        assert_eq!(effective_base(&r, "main", false), "HEAD");
    }

    // Degenerate case: an unborn HEAD (freshly `git init`'d, no commits). Nothing resolves, so the
    // original logical name is returned for the caller's born-HEAD handling / git error to surface.
    #[test]
    fn effective_base_returns_original_name_in_an_unborn_repo() {
        let root = unique_root("eb-unborn");
        let r = root.to_str().unwrap().to_string();
        git(&r, &["init", "-q"]).unwrap();
        // A logical name that can't coincide with the auto-detected default, so the assertion holds
        // regardless of this machine's `init.defaultBranch`.
        assert_eq!(effective_base(&r, "feature-x", false), "feature-x");
    }

    // End-to-end: opening an agent whose persisted baseBranch drifted to a now-missing branch
    // used to dead-end with `fatal: invalid reference: main`. It must instead cut the worktree
    // from the repo's real default branch.
    #[test]
    fn create_worktree_survives_a_missing_recorded_base_branch() {
        let r = init_repo("wt-drift"); // on `main`
        let main_sha = git(&r, &["rev-parse", "main"]).unwrap();
        git(&r, &["branch", "-m", "main", "master"]).unwrap();
        let app_data = unique_root("wt-drift-appdata");

        // Recorded baseBranch is the stale "main" — creation must survive it, not hard-fail.
        let info = create_worktree_at(&r, "p1", "a1", "main", &app_data)
            .expect("worktree creation must survive a drifted base branch");
        assert!(
            git(&info.path, &["rev-parse", "--is-inside-work-tree"]).is_ok(),
            "a real worktree was created"
        );
        // The agent branch was cut from the surviving default (same tip main used to point at).
        assert_eq!(
            git(&info.path, &["rev-parse", "HEAD"]).unwrap(),
            main_sha,
            "new branch descends from the detected default branch's tip"
        );
    }

    // Degenerate but real: opening an agent in a freshly `git init`'d repo with NO commits (unborn
    // HEAD). `effective_base` finds nothing resolvable and hands back the logical name verbatim, so
    // the raw `git worktree add` used to dead-end with a cryptic `fatal: invalid reference: <name>`.
    // Creation must instead fail with a clear, actionable message (and never leave a half-made tree).
    #[test]
    fn create_worktree_errors_clearly_in_an_unborn_repo() {
        let root = unique_root("wt-unborn");
        let r = root.to_str().unwrap().to_string();
        git(&r, &["init", "-q"]).unwrap();
        let app_data = unique_root("wt-unborn-appdata");

        let err = match create_worktree_at(&r, "p1", "a1", "main", &app_data) {
            Ok(_) => panic!("creation must fail when the repo has no commit to branch from"),
            Err(e) => e,
        };
        assert!(
            err.contains("no commits yet"),
            "error must explain the unborn-repo cause, got: {err}"
        );
        assert!(
            !err.contains("invalid reference"),
            "the cryptic raw-git error must not leak to the user, got: {err}"
        );
    }

    #[test]
    fn safe_delete_removes_a_merged_branch() {
        let r = init_repo("safedel-merged");
        // A merged agent branch: branch off main, commit, merge back into main.
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-m1"]).unwrap();
        git(&r, &["commit", "--allow-empty", "-m", "work"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();
        git(&r, &["merge", "--no-ff", "-m", "merge", "sparkle/agent-m1"]).unwrap();
        assert!(branch_exists(&r, "sparkle/agent-m1"));

        delete_agent_branch_if_merged_at(&r, "m1").unwrap();
        assert!(!branch_exists(&r, "sparkle/agent-m1"), "merged branch should be deleted");
    }

    #[test]
    fn safe_delete_keeps_an_unmerged_branch() {
        let r = init_repo("safedel-unmerged");
        // An UNMERGED agent branch with a REAL change (a file main doesn't have), so merging it into
        // main would genuinely add something — neither an ancestor nor a net-noop. (An empty commit
        // would net-add-nothing and correctly read as landed, so it must carry actual content here.)
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-u1"]).unwrap();
        std::fs::write(format!("{r}/u.txt"), "unmerged work").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-m", "work"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();
        assert!(branch_exists(&r, "sparkle/agent-u1"));

        delete_agent_branch_if_merged_at(&r, "u1").unwrap();
        assert!(branch_exists(&r, "sparkle/agent-u1"), "unmerged branch must be kept");
    }

    #[test]
    fn safe_delete_removes_a_squash_merged_branch() {
        let r = init_repo("safedel-squash");
        // A squash-merged agent branch: its changes land on main as a NEW commit, so the branch tip
        // is NOT an ancestor of main (plain `git branch -d` would wrongly refuse). The merge-tree
        // check (merge_adds_nothing) still recognizes it as landed.
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-s1"]).unwrap();
        std::fs::write(format!("{r}/f.txt"), "hello").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-m", "work"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();
        git(&r, &["merge", "--squash", "sparkle/agent-s1"]).unwrap();
        git(&r, &["commit", "-m", "squash work"]).unwrap();
        assert!(branch_exists(&r, "sparkle/agent-s1"));

        delete_agent_branch_if_merged_at(&r, "s1").unwrap();
        assert!(!branch_exists(&r, "sparkle/agent-s1"), "squash-merged branch should be deleted");
    }

    #[test]
    fn safe_delete_removes_a_branch_merged_only_on_origin() {
        // The REAL GitHub path: the squash commit lands on origin/main, NOT local main. The delete
        // must still recognize it (the prior local-only check would wrongly keep the branch).
        let r = init_repo("safedel-origin");
        let origin = unique_root("safedel-origin-remote");
        let o = origin.to_str().unwrap();
        git(o, &["init", "--bare", "-q"]).unwrap();
        git(&r, &["remote", "add", "origin", o]).unwrap();
        git(&r, &["push", "-q", "origin", "main"]).unwrap();

        git(&r, &["checkout", "-q", "-b", "sparkle/agent-o1"]).unwrap();
        std::fs::write(format!("{r}/f.txt"), "hi").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-m", "work"]).unwrap();

        // Squash-merge onto main, push to origin, then REWIND local main so the merge exists ONLY on
        // origin/main (mirroring the desktop flow where local main isn't fast-forwarded after a PR).
        git(&r, &["checkout", "-q", "main"]).unwrap();
        git(&r, &["merge", "--squash", "sparkle/agent-o1"]).unwrap();
        git(&r, &["commit", "-m", "squash"]).unwrap();
        git(&r, &["push", "-q", "origin", "main"]).unwrap();
        git(&r, &["reset", "-q", "--hard", "HEAD~1"]).unwrap();
        git(&r, &["fetch", "-q", "origin"]).unwrap();
        assert!(branch_exists(&r, "sparkle/agent-o1"));

        delete_agent_branch_if_merged_at(&r, "o1").unwrap();
        assert!(
            !branch_exists(&r, "sparkle/agent-o1"),
            "branch merged only on origin/main should be deleted"
        );
    }

    #[test]
    fn safe_delete_is_idempotent_for_a_missing_branch() {
        let r = init_repo("safedel-missing");
        delete_agent_branch_if_merged_at(&r, "nope").unwrap(); // no such branch → Ok
    }

    #[test]
    fn decode_commit_pulls_folds_state() {
        // Open PR: state "open", no merge timestamp, link comes from `html_url`.
        let open = json!([{ "number": 7, "state": "open", "merged_at": Value::Null, "html_url": "https://gh/7" }]);
        let (s, n, u) = decode_commit_pulls(open.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("open"));
        assert_eq!(n, Some(7));
        assert_eq!(u.as_deref(), Some("https://gh/7"));

        // Merged: the endpoint still says state "closed" — `merged_at` is what proves it merged.
        let merged = json!([{ "number": 8, "state": "closed", "merged_at": "2026-01-01T00:00:00Z", "html_url": "https://gh/8" }]);
        let (s, n, _) = decode_commit_pulls(merged.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("merged"));
        assert_eq!(n, Some(8));

        // Closed but not merged stays "closed".
        let closed = json!([{ "number": 9, "state": "closed", "merged_at": Value::Null }]);
        let (s, _, _) = decode_commit_pulls(closed.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("closed"));

        // No PR associated with the commit ⇒ all-None.
        let (s, n, u) = decode_commit_pulls(&[]);
        assert!(s.is_none() && n.is_none() && u.is_none());
    }

    #[test]
    fn decode_pr_list_url_builds_the_pulls_link() {
        assert_eq!(
            decode_pr_list_url(r#"{"url":"https://github.com/owner/repo"}"#).as_deref(),
            Some("https://github.com/owner/repo/pulls")
        );
        // A trailing slash must not produce a double slash in the path.
        assert_eq!(
            decode_pr_list_url(r#"{"url":"https://github.com/owner/repo/"}"#).as_deref(),
            Some("https://github.com/owner/repo/pulls")
        );
        // Enterprise / self-hosted hosts work the same way — nothing here assumes github.com.
        assert_eq!(
            decode_pr_list_url(r#"{"url":"https://git.example.com/team/app"}"#).as_deref(),
            Some("https://git.example.com/team/app/pulls")
        );
    }

    #[test]
    fn decode_pr_list_url_refuses_anything_that_is_not_a_plausible_https_url() {
        // Rather than open a half-built or attacker-influenced link, decline to navigate at all.
        assert_eq!(decode_pr_list_url(""), None);
        assert_eq!(decode_pr_list_url("not json"), None);
        assert_eq!(decode_pr_list_url("{}"), None);
        assert_eq!(decode_pr_list_url(r#"{"url":""}"#), None);
        assert_eq!(decode_pr_list_url(r#"{"url":"http://insecure/repo"}"#), None);
        assert_eq!(decode_pr_list_url(r#"{"url":"javascript:alert(1)"}"#), None);
        assert_eq!(decode_pr_list_url(r#"{"url":"file:///etc/passwd"}"#), None);
    }

    #[test]
    fn decode_open_pr_count_counts_rows() {
        assert_eq!(decode_open_pr_count("[]"), Some(0));
        assert_eq!(decode_open_pr_count(r#"[{"number":1}]"#), Some(1));
        assert_eq!(decode_open_pr_count(r#"[{"number":1},{"number":2},{"number":3}]"#), Some(3));
    }

    #[test]
    fn decode_open_pr_count_reads_garbage_as_unknown_not_zero() {
        // The whole point of the badge is that it must never claim "nothing is waiting" when it
        // simply failed to look. An empty array is a KNOWN zero; everything else that isn't a
        // JSON array is UNKNOWN, and the UI renders nothing rather than a reassuring "0".
        assert_eq!(decode_open_pr_count(""), None);
        assert_eq!(decode_open_pr_count("not json"), None);
        assert_eq!(decode_open_pr_count("gh: command not found"), None);
        // A JSON object (e.g. an error payload) is not a row list either.
        assert_eq!(decode_open_pr_count(r#"{"message":"Bad credentials"}"#), None);
        // Known-zero and unknown are genuinely different values, not just different renderings.
        assert_ne!(decode_open_pr_count("[]"), decode_open_pr_count("Bad credentials"));
    }

    #[test]
    fn classify_checks_lets_failure_dominate_then_pending_then_success() {
        // Empty rollup → "none" (a PR with no CI at all, not an unknown).
        assert_eq!(classify_checks(&[]), "none");
        // All green check runs → passing; a neutral/skipped conclusion doesn't block.
        assert_eq!(
            classify_checks(&[
                json!({ "status": "COMPLETED", "conclusion": "SUCCESS" }),
                json!({ "status": "COMPLETED", "conclusion": "SKIPPED" }),
                json!({ "status": "COMPLETED", "conclusion": "NEUTRAL" }),
            ]),
            "passing"
        );
        // A still-running check makes the whole rollup pending, even beside green ones.
        assert_eq!(
            classify_checks(&[
                json!({ "status": "COMPLETED", "conclusion": "SUCCESS" }),
                json!({ "status": "IN_PROGRESS", "conclusion": Value::Null }),
            ]),
            "pending"
        );
        // A single failure dominates both pending and success.
        assert_eq!(
            classify_checks(&[
                json!({ "status": "COMPLETED", "conclusion": "SUCCESS" }),
                json!({ "status": "IN_PROGRESS", "conclusion": Value::Null }),
                json!({ "status": "COMPLETED", "conclusion": "FAILURE" }),
            ]),
            "failing"
        );
        // Legacy commit-status contexts (a single `state`) classify the same way.
        assert_eq!(classify_checks(&[json!({ "state": "SUCCESS" })]), "passing");
        assert_eq!(classify_checks(&[json!({ "state": "PENDING" })]), "pending");
        assert_eq!(classify_checks(&[json!({ "state": "FAILURE" })]), "failing");
        assert_eq!(classify_checks(&[json!({ "state": "ERROR" })]), "failing");
    }

    #[test]
    fn normalize_mergeable_maps_only_the_two_terminal_values() {
        assert_eq!(normalize_mergeable(Some("MERGEABLE")), "mergeable");
        assert_eq!(normalize_mergeable(Some("CONFLICTING")), "conflicting");
        // UNKNOWN (async-not-yet-computed), an unexpected value, and a missing field all read as
        // "unknown" — the UI treats that as "let gh decide", never as a block.
        assert_eq!(normalize_mergeable(Some("UNKNOWN")), "unknown");
        assert_eq!(normalize_mergeable(Some("SOMETHING_NEW")), "unknown");
        assert_eq!(normalize_mergeable(None), "unknown");
    }

    #[test]
    fn decode_open_prs_shapes_rows_and_defaults_missing_fields() {
        let rows = decode_open_prs(
            r#"[
                {
                    "number": 42,
                    "title": "fix: a thing",
                    "headRefName": "sparkle/agent-abc",
                    "url": "https://github.com/o/r/pull/42",
                    "mergeable": "MERGEABLE",
                    "statusCheckRollup": [{ "status": "COMPLETED", "conclusion": "SUCCESS" }]
                },
                { "number": 7 }
            ]"#,
        )
        .expect("valid array decodes");
        assert_eq!(
            rows[0],
            PrRow {
                number: 42,
                title: "fix: a thing".into(),
                head_ref_name: "sparkle/agent-abc".into(),
                url: "https://github.com/o/r/pull/42".into(),
                checks: "passing".into(),
                mergeable: "mergeable".into(),
            }
        );
        // A sparse row keeps its number and defaults the rest — a missing rollup is "none", a missing
        // mergeable is "unknown".
        assert_eq!(
            rows[1],
            PrRow {
                number: 7,
                title: String::new(),
                head_ref_name: String::new(),
                url: String::new(),
                checks: "none".into(),
                mergeable: "unknown".into(),
            }
        );
    }

    #[test]
    fn decode_open_prs_reads_garbage_as_unknown_and_drops_only_numberless_rows() {
        // Garbage (not a JSON array) is UNKNOWN — the whole probe drops to None, never an empty list,
        // matching decode_open_pr_count's null-vs-zero discipline.
        assert_eq!(decode_open_prs(""), None);
        assert_eq!(decode_open_prs("not json"), None);
        assert_eq!(decode_open_prs(r#"{"message":"Bad credentials"}"#), None);
        // A known-empty array is Some(empty), not None.
        assert_eq!(decode_open_prs("[]"), Some(vec![]));
        // A row without a number is unusable (nothing to merge/link) and is dropped, but a valid
        // sibling still comes through — one bad row must not blank the menu.
        let rows = decode_open_prs(r#"[{"title":"no number"},{"number":9}]"#).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].number, 9);
    }

    #[test]
    fn decode_commit_pulls_disambiguates_multiple_prs() {
        // Several PRs contain the tip and the order isn't relevance-sorted: a merged PR wins over
        // anything else, so a trailing closed/open row can't shadow the ship.
        let many = json!([
            { "number": 1, "state": "closed", "merged_at": Value::Null },
            { "number": 2, "state": "open", "merged_at": Value::Null },
            { "number": 3, "state": "closed", "merged_at": "2026-01-01T00:00:00Z" },
        ]);
        let (s, n, _) = decode_commit_pulls(many.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("merged"));
        assert_eq!(n, Some(3));

        // No merged PR ⇒ an OPEN one is preferred over a leading closed row.
        let no_merge = json!([
            { "number": 4, "state": "closed", "merged_at": Value::Null },
            { "number": 5, "state": "open", "merged_at": Value::Null },
        ]);
        let (s, n, _) = decode_commit_pulls(no_merge.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("open"));
        assert_eq!(n, Some(5));
    }

    #[test]
    fn fetch_due_respects_cooldown() {
        let now = Instant::now();
        assert!(fetch_due(None, now), "never fetched ⇒ due");
        assert!(!fetch_due(Some(now), now), "just fetched ⇒ not due");
        let long_ago = now.checked_sub(FETCH_COOLDOWN + Duration::from_secs(1)).unwrap();
        assert!(fetch_due(Some(long_ago), now), "past the cooldown ⇒ due");
        let recent = now.checked_sub(FETCH_COOLDOWN / 2).unwrap();
        assert!(!fetch_due(Some(recent), now), "within the cooldown ⇒ not due");
    }

    #[test]
    fn commit_pr_usability_gates_on_number() {
        // A PR is only authoritative (skip the branch-name fallback) when it carries a number.
        assert!(commit_pr_is_usable(&(Some("open".into()), Some(7), None)));
        assert!(!commit_pr_is_usable(&(Some("open".into()), None, None))); // state but no number ⇒ fall back
        assert!(!commit_pr_is_usable(&(None, None, None)));
    }

    #[test]
    fn three_agents_are_isolated_and_each_drives_its_own_pty() {
        let root = unique_root("iso");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("iso-appdata");

        ensure_project_repo_inner(root_str.clone()).expect("ensure repo");

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
            let wt = worktree_path(&app_data, "isoproj", id).unwrap();
            let _ = git(&root_str, &["worktree", "remove", "--force", &wt.to_string_lossy()]);
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // ── Pre-warmed worktree pool (worktree-pool) ────────────────────────────────────────────────

    /// The detached HEAD sha of a worktree (for asserting a parked slot sits at the base commit).
    fn head_sha(wt: &str) -> String {
        git(wt, &["rev-parse", "HEAD"]).unwrap()
    }

    // Warming parks a DETACHED-HEAD worktree at the effective base, under the SEPARATE
    // `worktree-pool/<project>` subtree (never `worktrees/<project>`), and records it in the pool.
    #[test]
    fn warm_parks_a_detached_worktree_at_base() {
        let r = init_repo("pool-warm");
        let app_data = unique_root("pool-warm-appdata");
        let base_commit = git(&r, &["rev-parse", "main"]).unwrap();

        warm_one_slot(&r, "pw", "main", &app_data).expect("warm one slot");

        // Recorded in the in-memory pool at the base commit.
        let slot = {
            let map = pools().lock().unwrap();
            map.get("pw").and_then(|v| v.last()).cloned()
        }
        .expect("a slot was parked");
        assert_eq!(slot.base_commit, base_commit);
        // It's a real worktree, detached at the base, and lives under worktree-pool/ (NOT worktrees/).
        assert!(Path::new(&slot.path).is_dir());
        assert_eq!(head_sha(&slot.path.to_string_lossy()), base_commit);
        assert!(slot.path.starts_with(app_data.join("worktree-pool").join("pw")));
        assert!(!slot.path.starts_with(app_data.join("worktrees")));
        // Detached HEAD: no branch is checked out.
        assert!(git(&slot.path.to_string_lossy(), &["symbolic-ref", "-q", "HEAD"]).is_err());

        let _ = git(&r, &["worktree", "remove", "--force", &slot.path.to_string_lossy()]);
    }

    // Claiming a parked slot moves it to the agent path on `sparkle/agent-<id>`, with files == base
    // tree — an identical result to the slow `git worktree add -b` path.
    #[test]
    fn claim_moves_pooled_worktree_to_agent_path_on_branch() {
        let r = init_repo("pool-claim");
        let app_data = unique_root("pool-claim-appdata");
        // A tracked file in the base so we can assert the claimed tree materializes it.
        std::fs::write(format!("{r}/base.txt"), "base content").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-q", "-m", "base file"]).unwrap();
        let base_commit = git(&r, &["rev-parse", "main"]).unwrap();

        warm_one_slot(&r, "pc", "main", &app_data).unwrap();
        let info = try_claim_pooled_worktree(&r, "pc", "a1", "main", &app_data)
            .expect("claim should succeed from a fresh pool");

        // Exactly what create_worktree_at would return: the canonical agent path + branch.
        let expected = worktree_path(&app_data, "pc", "a1").unwrap();
        assert_eq!(info.path, expected.to_string_lossy());
        assert_eq!(info.branch, "sparkle/agent-a1");
        // On the right branch, at the base commit, with the base tree materialized.
        assert_eq!(git(&info.path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(), "sparkle/agent-a1");
        assert_eq!(head_sha(&info.path), base_commit);
        assert_eq!(std::fs::read_to_string(format!("{}/base.txt", info.path)).unwrap(), "base content");
        // The pool is now empty (the slot was consumed), and the old pool path is gone.
        assert_eq!(pools().lock().unwrap().get("pc").map(|v| v.len()).unwrap_or(0), 0);

        let _ = git(&r, &["worktree", "remove", "--force", &info.path]);
    }

    // A slot cut from a base that has since MOVED is rejected (not handed out) and pruned — the
    // caller then falls back to a correct fresh cut.
    #[test]
    fn claim_rejects_stale_base_and_prunes() {
        let r = init_repo("pool-stale");
        let app_data = unique_root("pool-stale-appdata");
        warm_one_slot(&r, "ps", "main", &app_data).unwrap();
        let parked = pools().lock().unwrap().get("ps").unwrap().last().unwrap().path.clone();

        // Advance main AFTER warming, so the parked slot is now cut from a stale base.
        std::fs::write(format!("{r}/new.txt"), "moved on").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-q", "-m", "advance main"]).unwrap();

        // The claim must refuse the stale slot (⇒ caller falls back).
        assert!(try_claim_pooled_worktree(&r, "ps", "a2", "main", &app_data).is_none());
        // The stale slot is discarded from memory AND disk.
        assert_eq!(pools().lock().unwrap().get("ps").map(|v| v.len()).unwrap_or(0), 0);
        assert!(!parked.exists(), "stale parked worktree dir should be pruned");
        // No agent worktree was created from the wrong base.
        assert!(!worktree_path(&app_data, "ps", "a2").unwrap().exists());
    }

    // The disabled flag makes claim a no-op (always falls back), and create_worktree_at still works
    // end-to-end via the slow path.
    #[test]
    fn disabled_flag_falls_back_to_slow_path() {
        let r = init_repo("pool-disabled");
        let app_data = unique_root("pool-disabled-appdata");
        // Disable the pool for THIS repo via a per-project .sparkle/config.toml.
        std::fs::create_dir_all(format!("{r}/.sparkle")).unwrap();
        std::fs::write(format!("{r}/.sparkle/config.toml"), "[worktree_pool]\nenabled = false\n").unwrap();

        // Even with a parked slot present, a disabled pool never claims it.
        warm_one_slot(&r, "pd", "main", &app_data).unwrap();
        assert!(try_claim_pooled_worktree(&r, "pd", "a3", "main", &app_data).is_none());
        assert_eq!(pools().lock().unwrap().get("pd").map(|v| v.len()).unwrap_or(0), 1, "slot left intact");

        // create_worktree_at still produces a correct worktree via the slow path.
        let info = create_worktree_at(&r, "pd", "a3", "main", &app_data).unwrap();
        assert_eq!(info.branch, "sparkle/agent-a3");
        assert_eq!(info.path, worktree_path(&app_data, "pd", "a3").unwrap().to_string_lossy());
        assert_eq!(git(&info.path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(), "sparkle/agent-a3");

        let leftover = pools().lock().unwrap().get("pd").unwrap().last().unwrap().path.clone();
        let _ = git(&r, &["worktree", "remove", "--force", &info.path]);
        let _ = git(&r, &["worktree", "remove", "--force", &leftover.to_string_lossy()]);
    }

    // create_worktree_at claims from a warm pool transparently: same result as the slow path, and it
    // does NOT go through `git worktree add -b` (the pooled slot is reused instead).
    #[test]
    fn create_worktree_at_claims_from_warm_pool() {
        let r = init_repo("pool-e2e");
        let app_data = unique_root("pool-e2e-appdata");
        // Pin size=0 so the post-claim background refill is a deterministic no-op — the pool stays
        // empty after the single parked slot is consumed, so the len==0 assertion below can't race a
        // refill thread. (enabled stays true by default, so the claim itself still fires.)
        std::fs::create_dir_all(format!("{r}/.sparkle")).unwrap();
        std::fs::write(format!("{r}/.sparkle/config.toml"), "[worktree_pool]\nsize = 0\n").unwrap();
        let base_commit = git(&r, &["rev-parse", "main"]).unwrap();
        warm_one_slot(&r, "pe", "main", &app_data).unwrap();
        assert_eq!(pools().lock().unwrap().get("pe").unwrap().len(), 1);

        let info = create_worktree_at(&r, "pe", "a4", "main", &app_data).unwrap();
        assert_eq!(info.branch, "sparkle/agent-a4");
        assert_eq!(info.path, worktree_path(&app_data, "pe", "a4").unwrap().to_string_lossy());
        assert_eq!(head_sha(&info.path), base_commit);
        // The slot was consumed by the claim.
        assert_eq!(pools().lock().unwrap().get("pe").map(|v| v.len()).unwrap_or(0), 0);

        let _ = git(&r, &["worktree", "remove", "--force", &info.path]);
    }

    // Startup cleanup removes a leftover parked worktree from a "crashed" prior session and is a
    // no-op on the second call (idempotent, once-per-project).
    #[test]
    fn cleanup_sweeps_crashed_pool_leftovers_once() {
        let r = init_repo("pool-clean");
        let app_data = unique_root("pool-clean-appdata");
        // Simulate a crash survivor: a real parked worktree on disk with NO in-memory record.
        let base_commit = git(&r, &["rev-parse", "main"]).unwrap();
        let dir = pool_dir(&app_data, "pcl").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let orphan = dir.join(new_slot_id());
        git(&r, &["worktree", "add", "--detach", &orphan.to_string_lossy(), &base_commit]).unwrap();
        assert!(orphan.exists());

        cleanup_pool_once(&r, "pcl", &app_data);
        assert!(!orphan.exists(), "leftover parked worktree should be swept");
        // Second call is a guarded no-op (does not error, nothing to do).
        cleanup_pool_once(&r, "pcl", &app_data);
    }

    // topup_pool_blocking fills the pool up to the configured size and never over-warms.
    #[test]
    fn topup_fills_to_configured_size() {
        let r = init_repo("pool-topup");
        let app_data = unique_root("pool-topup-appdata");
        std::fs::create_dir_all(format!("{r}/.sparkle")).unwrap();
        std::fs::write(format!("{r}/.sparkle/config.toml"), "[worktree_pool]\nsize = 3\n").unwrap();

        topup_pool_blocking(&r, "pt", "main", &app_data);
        assert_eq!(pools().lock().unwrap().get("pt").map(|v| v.len()).unwrap_or(0), 3);

        // Re-running is a no-op once full (still exactly 3, not 6).
        topup_pool_blocking(&r, "pt", "main", &app_data);
        assert_eq!(pools().lock().unwrap().get("pt").unwrap().len(), 3);

        for slot in pools().lock().unwrap().get("pt").unwrap().clone() {
            let _ = git(&r, &["worktree", "remove", "--force", &slot.path.to_string_lossy()]);
        }
    }

    #[test]
    fn worktree_path_is_outside_the_project_root() {
        use std::path::Path;
        let app_data = Path::new("/tmp/sparkle-appdata");
        let root = "/Users/dev/Projects/myrepo";
        let p = worktree_path(app_data, "proj-123", "agent-abc").unwrap();
        assert_eq!(p, Path::new("/tmp/sparkle-appdata/worktrees/proj-123/agent-abc"));
        // The crucial property: the worktree is NOT under the project root.
        assert!(!p.starts_with(root), "worktree must live outside the project tree");
    }

    #[test]
    fn worktree_path_rejects_traversal_and_metacharacters() {
        let app_data = Path::new("/tmp/sparkle-appdata");
        // A UUID-shaped id (the real-world case) is accepted.
        assert!(worktree_path(app_data, "proj-123_X", "08f7a420-ca27-4452-a1f8-4d27b6fc5a05").is_ok());
        // Path traversal / separators / emptiness in either component are rejected, so a crafted
        // id can never escape <app_data>/worktrees.
        assert!(worktree_path(app_data, "../../etc", "agent").is_err());
        assert!(worktree_path(app_data, "proj", "../../../tmp/evil").is_err());
        assert!(worktree_path(app_data, "proj/sub", "agent").is_err());
        assert!(worktree_path(app_data, "proj", "a b").is_err());
        assert!(worktree_path(app_data, "", "agent").is_err());
        assert!(worktree_path(app_data, "proj", "").is_err());
    }

    #[test]
    fn validate_ref_blocks_option_injection_but_allows_slash_branches() {
        // Legit branch names, including slashed ones, pass (after trimming).
        assert!(validate_ref("main").is_ok());
        assert!(validate_ref("release/2026").is_ok());
        assert!(validate_ref("  develop  ").is_ok());
        // A ref crafted to be parsed as a git option (the RCE vector via fetch/rebase) is rejected.
        assert!(validate_ref("--upload-pack=touch /tmp/pwned").is_err());
        assert!(validate_ref("-x").is_err());
        // Empty / control / whitespace refs are rejected.
        assert!(validate_ref("").is_err());
        assert!(validate_ref("   ").is_err());
        assert!(validate_ref("a b").is_err());
        assert!(validate_ref("a\nb").is_err());
    }

    #[test]
    fn worktree_lives_outside_root_and_toplevel_cannot_escape() {
        let root = unique_root("ext-iso");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("ext-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

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
        ensure_project_repo_inner(root_str.clone()).unwrap();
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
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();

        let dest = root.parent().unwrap().join(format!("mv-to-{}", std::process::id()));
        let dest_str = dest.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&dest);
        move_project_inner(root_str.clone(), dest_str.clone()).unwrap();

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
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();

        // A correct external worktree passes.
        assert!(assert_workspace_integrity_inner(info.path.clone()).is_ok());

        // A nested dir inside the project checkout fails (its toplevel is the parent repo).
        let nested = root.join("subdir");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(assert_workspace_integrity_inner(nested.to_string_lossy().to_string()).is_err());

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
        let matcher = hooks[0]["matcher"].as_str().unwrap();
        assert!(matcher.contains("Edit"));
        // Bash is matched too so the keychain guard (sparkle-0ezz) sees shell commands.
        assert!(matcher.contains("Bash"));
    }

    #[test]
    fn merge_guard_seeds_sparkle_allowlist() {
        // A fresh worktree (no prior settings) gets the pre-approved allow rules so interactive
        // agents stop prompting for Sparkle's own MCP tools and read-only ops.
        let merged = merge_guard_settings(None, "node /abs/worktree-guard.mjs /wt/a");
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        let allow = v["permissions"]["allow"].as_array().expect("allow array");
        let rules: Vec<&str> = allow.iter().filter_map(|e| e.as_str()).collect();
        // Sparkle's control plane is allowed (this is the friction in the screenshot).
        assert!(rules.contains(&"mcp__sparkle-control"));
        assert!(rules.contains(&"mcp__sparkle-orchestrator"));
        // Read-only ops are allowed.
        assert!(rules.contains(&"Read"));
        assert!(rules.contains(&"WebFetch"));
        // Mutating tools are NOT pre-approved — they must still prompt on interactive agents.
        assert!(!rules.contains(&"Bash"));
        assert!(!rules.contains(&"Edit"));
        assert!(!rules.contains(&"Write"));
    }

    #[test]
    fn merge_guard_allowlist_is_idempotent_and_preserves_user_rules() {
        // A user-added rule plus a pre-existing Sparkle rule: re-merging must keep the user's rule
        // and must not duplicate any Sparkle rule.
        let existing = r#"{
            "permissions": { "allow": ["Bash(git status:*)", "mcp__sparkle-control"] }
        }"#;
        let once = merge_guard_settings(Some(existing), "node /abs/worktree-guard.mjs /wt/a");
        let twice = merge_guard_settings(Some(&once), "node /abs/worktree-guard.mjs /wt/a");
        let v: serde_json::Value = serde_json::from_str(&twice).unwrap();
        let rules: Vec<&str> = v["permissions"]["allow"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e.as_str())
            .collect();
        // User's custom rule survives.
        assert!(rules.contains(&"Bash(git status:*)"), "user rule preserved");
        // Sparkle rules present exactly once each despite two merges + a pre-existing copy.
        assert_eq!(
            rules.iter().filter(|r| **r == "mcp__sparkle-control").count(),
            1,
            "no duplicate sparkle-control rule"
        );
        assert_eq!(
            rules.iter().filter(|r| **r == "mcp__sparkle-orchestrator").count(),
            1,
            "no duplicate sparkle-orchestrator rule"
        );
    }

    #[test]
    fn clean_legacy_worktree_is_migrated_dirty_is_refused() {
        let root = unique_root("migrate");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("migrate-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

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
        ensure_project_repo_inner(root_str.clone()).unwrap();
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
        ensure_project_repo_inner(root_str.clone()).unwrap();
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
        ensure_project_repo_inner(root_str.clone()).unwrap();
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
        ensure_project_repo_inner(root_str.clone()).unwrap();
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
    fn agent_branch_status_does_not_attribute_a_parked_worktrees_dirt_to_the_branch() {
        // sparkle-xk3x. `dirty` is the ONE field read from the worktree rather than from the
        // branch ref — every other field here comes from `rev-list <base>...refs/heads/<branch>`
        // and is immune to this. So when a worktree gets moved OFF its own branch (the old
        // land.sh checked `main` out into it — sparkle-rhgm), `dirty` silently stops describing
        // the agent's branch and starts describing whatever tree is sitting there now.
        //
        // Downstream that is not cosmetic: a dirty reading applies the "unsaved edits" floor in
        // gitDerivedStage, which is exactly the founder screenshot — stage pinned below
        // merged_local with ahead == 0, so the CTA offered "Land to Main" for landed work.
        //
        // The probe deliberately keeps reporting RAW `dirty` and publishes the identity flag
        // separately, rather than zeroing `dirty` when parked. Zeroing looks tidier and is
        // wrong: parking CARRIES uncommitted files along, and shouldPromptOnClose reads `dirty`
        // to decide whether tearing the worktree down would discard the user's work. Suppressing
        // it there would trade a cosmetic stage misreport for silent data loss. Attribution is
        // the CONSUMER's decision — see the two callers in runtimeStore.ts and closeAgent.ts.
        let root = unique_root("status-parked");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("status-parked-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "s1", "main", &app_data).unwrap();

        // Real agent work, so ahead is non-zero and provably survives the parking.
        std::fs::write(Path::new(&info.path).join("a.txt"), "a\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();

        // Baseline: on its own branch, a dirty tree IS the branch's dirt and must be reported.
        std::fs::write(Path::new(&info.path).join("uncommitted.txt"), "u").unwrap();
        let before = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert!(before.dirty, "on its own branch, dirt belongs to the branch");
        assert!(before.worktree_on_branch, "worktree is on the agent branch");
        assert_eq!(before.ahead, 1);

        // Park it, exactly as the old land.sh did: free `main` at the root, then check `main`
        // out INTO the agent's worktree. The uncommitted file rides along, so the tree is still
        // dirty — but that dirt now belongs to `main`, not to sparkle/agent-s1.
        git(&root_str, &["checkout", "--detach"]).unwrap();
        git(&info.path, &["checkout", "main"]).unwrap();
        assert_eq!(
            git(&info.path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(),
            "main",
            "worktree is parked on main (precondition)"
        );
        assert!(
            !git(&info.path, &["status", "--porcelain"]).unwrap().is_empty(),
            "parked tree really is dirty — so a naive read WOULD report dirty=true"
        );

        let parked = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert!(
            !parked.worktree_on_branch,
            "probe must notice the worktree is not on sparkle/agent-s1"
        );
        assert!(
            parked.dirty,
            "dirty stays RAW so close-safety can still see files at risk — attribution is the \
             consumer's job, not the probe's"
        );
        // The ref-derived fields are unaffected by parking — that is the whole point of only
        // distrusting `dirty`. If this regresses, the fix over-corrected.
        assert_eq!(parked.ahead, 1, "ahead comes from the branch ref, not the worktree");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn agent_branch_status_tolerates_a_removed_worktree() {
        // Repro of the FATAL-log spam: a landed/cleaned-up agent's worktree is gone, but its tab
        // stays open and the 30s poll keeps calling this. The in-worktree `git status` would fail
        // with "cannot change to <path>: No such file or directory". We must still return Ok with
        // dirty=false (a removed tree has no uncommitted changes) and keep ahead/behind correct.
        let root = unique_root("status-gone");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("status-gone-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "s1", "main", &app_data).unwrap();

        // One agent commit so ahead=1, then physically remove the worktree directory.
        std::fs::write(Path::new(&info.path).join("a.txt"), "a\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        std::fs::remove_dir_all(&info.path).unwrap();
        assert!(!Path::new(&info.path).exists(), "worktree dir removed");

        let st = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert_eq!(st.ahead, 1, "ahead/behind still computed from refs in root");
        assert_eq!(st.behind, 0);
        assert!(!st.dirty, "a removed worktree reports clean, not an error");
        assert_eq!(st.files_changed, 1, "numstat runs against root refs, unaffected");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn agent_branch_status_zeroes_when_branch_ref_is_absent() {
        // Repro of the indefinite-poll log spam: an agent with no `sparkle/agent-<id>` ref yet
        // (chat/think/shell, or polled before its first commit). The old code ran
        // `rev-list <base>...sparkle/agent-<id>` against a non-existent ref, which fails with
        // "ambiguous argument ... unknown revision" — not matched by the removed-worktree latch, so
        // the 30s poll re-failed forever. We must return Ok with a zeroed, clean status instead.
        let root = unique_root("status-noref");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("status-noref-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // No create_worktree_at for "s1" → refs/heads/sparkle/agent-s1 never exists.
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-s1"]).is_err(),
            "precondition: agent branch ref absent",
        );

        let st = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert_eq!(st.ahead, 0, "no ref ⇒ nothing ahead");
        assert_eq!(st.behind, 0, "no ref ⇒ nothing behind");
        assert!(!st.dirty, "no worktree ⇒ clean");
        assert_eq!(st.files_changed, 0);
        assert_eq!(st.insertions, 0);
        assert_eq!(st.deletions, 0);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn batch_branch_status_zeroes_when_branch_ref_is_absent() {
        // The batched 30s poll (branch_status_with_base) must carry the SAME absent-ref guard the
        // single-agent path got in the #291 fix — it was lost when the poll was batched, so a
        // brand-new agent (no `sparkle/agent-<id>` ref yet) made `rev-list <base>...<missing>` fail
        // with "unknown revision", failing that agent's read and re-logging "batch branch status
        // failed" every tick forever. It must return Ok with a zeroed, clean status instead.
        let root = unique_root("batch-status-noref");
        let root_str = root.to_string_lossy().to_string();
        // Use the sync core (mirrors the idempotent test below); `ensure_project_repo` is the async
        // Tauri command and can't be `.unwrap()`-ed directly in a sync `#[test]`.
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // No worktree/branch for "s1" → refs/heads/sparkle/agent-s1 never exists.
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-s1"]).is_err(),
            "precondition: agent branch ref absent",
        );

        // A non-existent worktree path (the agent hasn't been created) — dirty must read clean, not error.
        let wt = root.join("nonexistent-wt");
        let st = branch_status_with_base(&root_str, "s1", "main", &wt).unwrap();
        assert_eq!(st.ahead, 0, "no ref ⇒ nothing ahead");
        assert_eq!(st.behind, 0, "no ref ⇒ nothing behind");
        assert!(!st.dirty, "no worktree ⇒ clean");
        assert_eq!(st.files_changed, 0);
        assert_eq!(st.insertions, 0);
        assert_eq!(st.deletions, 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn batch_branch_status_survives_an_unresolvable_base_ref() {
        // The agent branch EXISTS but its resolved base does not — `effective_base`'s documented
        // unborn/HEAD-less fallback can hand back a name git can't resolve. Previously
        // `rev-list <unresolvable-base>...<branch>` hard-failed with "fatal: ambiguous argument",
        // failing that agent's read and re-logging "batch branch status failed" every 30s tick for
        // the app's lifetime. It must return Ok, reporting the branch's own commits as `ahead`.
        let root = unique_root("batch-status-ghostbase");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // A real agent branch with commits of its own.
        git(&root_str, &["checkout", "-q", "-b", "sparkle/agent-s1"]).unwrap();
        std::fs::write(format!("{root_str}/w1.txt"), "a").unwrap();
        git(&root_str, &["add", "."]).unwrap();
        git(&root_str, &["commit", "-q", "-m", "w1"]).unwrap();
        std::fs::write(format!("{root_str}/w2.txt"), "b").unwrap();
        git(&root_str, &["add", "."]).unwrap();
        git(&root_str, &["commit", "-q", "-m", "w2"]).unwrap();
        git(&root_str, &["checkout", "-q", "main"]).unwrap();

        let total: u32 = git(&root_str, &["rev-list", "--count", "sparkle/agent-s1"])
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(total > 0, "precondition: the agent branch has commits");

        // A base ref that does not resolve — the failure mode observed in the logs.
        let ghost = "sparkle/ghost-base-does-not-exist";
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", &format!("{ghost}^{{commit}}")]).is_err(),
            "precondition: ghost base does not resolve",
        );

        let wt = root.join("nonexistent-wt");
        let st = branch_status_with_base(&root_str, "s1", ghost, &wt).unwrap();
        assert_eq!(st.ahead, total, "unresolvable base ⇒ ahead = the branch's own commits");
        assert_eq!(st.behind, 0, "unresolvable base ⇒ nothing to be behind");
        assert!(!st.dirty, "no worktree ⇒ clean");
        assert_eq!(st.files_changed, 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn agent_branch_status_tolerates_a_drifted_base_name() {
        // Contract for the single-agent entry point: a recorded base NAME that doesn't exist must not
        // error. Note this does NOT exercise the `ahead_only_status` guard directly — `effective_base`
        // recovers a resolvable base (here the detected default `main`) whenever HEAD resolves, so the
        // call flows through the normal `--left-right` path. The guard's own contract (base_ref that
        // resolves to nothing ⇒ ahead = branch's own commits) is asserted exactly by the lower-level
        // `batch_branch_status_survives_an_unresolvable_base_ref`; this test only pins the entry point's
        // no-error tolerance of a drifted base name.
        let root = unique_root("agent-status-drift-base");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("agent-status-drift-base-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // A real agent branch exactly one commit ahead of `main`.
        git(&root_str, &["checkout", "-q", "-b", "sparkle/agent-s1"]).unwrap();
        std::fs::write(format!("{root_str}/w1.txt"), "a").unwrap();
        git(&root_str, &["add", "."]).unwrap();
        git(&root_str, &["commit", "-q", "-m", "w1"]).unwrap();
        git(&root_str, &["checkout", "-q", "main"]).unwrap();

        // The recorded base "sparkle/ghost-base" resolves to nothing; effective_base recovers the
        // detected default `main`, so the call succeeds and measures against it (ahead == 1).
        let st = agent_branch_status_at(&root_str, "p", "s1", "sparkle/ghost-base", &app_data).unwrap();
        assert_eq!(st.ahead, 1, "drifted base name recovers to `main`; agent-s1 is 1 ahead");
        assert_eq!(st.behind, 0, "nothing to be behind");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn workflow_state_tracks_reachability_through_a_local_merge() {
        let root = unique_root("wf-state");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-state-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "w1", "main", &app_data).unwrap();

        // No commits yet. The tip IS main's HEAD, so reachability is trivially true — the
        // distinguishing signal that no real work exists is ahead_of_base == 0, which the
        // frontend folds into its committedSeen gate to avoid a false "On Main" for a no-op agent.
        let s0 = agent_workflow_state_at(&root_str, "w1", "", false).unwrap();
        assert_eq!(s0.ahead_of_base, 0, "no work ⇒ no commits unique to the branch (the gate)");

        // Agent commits real work → ahead of main, not yet contained in it.
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        let s1 = agent_workflow_state_at(&root_str, "w1", "", false).unwrap();
        assert_eq!(s1.ahead_of_base, 1, "one unlanded commit");
        assert!(!s1.in_local_main, "committed but not merged into main yet");

        // Land it into local main (the merge the user/orchestrator would do).
        git(&root_str, &["merge", "--no-ff", "sparkle/agent-w1", "-m", "land w1"]).unwrap();
        let s2 = agent_workflow_state_at(&root_str, "w1", "", false).unwrap();
        assert!(s2.in_local_main, "after merge, main contains the agent tip → On Main");
        assert_eq!(s2.ahead_of_base, 0, "no commits remain unique to the branch");
        assert!(!s2.in_origin_main, "no origin remote in this fixture → not Merged");
        assert!(s2.pr_state.is_none(), "no PR probe requested / no remote");
        assert!(s2.landed, "a normal --no-ff merge is reachable, so landed is trivially true too");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// A repo with no `origin` must report has_remote=false so the UI never strands the user at
    /// "Push to Origin Main" with Close unreachable. Uses the real fixture shape (unique_root +
    /// ensure_project_repo_inner + create_worktree_at) so the branch exists and we exercise the
    /// full computation rather than the tip-missing `WorkflowState::default()` early return.
    #[test]
    fn workflow_state_reports_has_remote_false_without_origin() {
        let root = unique_root("hr-noremote");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("hr-noremote-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "hr1", "main", &app_data).unwrap();

        // probe_pr_state=true, so the `git remote get-url origin` lookup DOES run — and finds nothing.
        let st = agent_workflow_state_at(&root_str, "hr1", "", true).unwrap();
        assert!(!st.has_remote, "no origin remote ⇒ has_remote must be false");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// has_origin is gated on probe_pr_state to avoid a `git remote` spawn on fast polls, so a
    /// non-probing call reports false EVEN WITH a real origin. The FRONTEND must treat this as
    /// "unknown", not "no remote" — see the sticky store note in runtimeStore.
    #[test]
    fn workflow_state_has_remote_is_false_when_probe_is_off() {
        let root = unique_root("hr-probeoff");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("hr-probeoff-appdata");
        let origin = unique_root("hr-probeoff-remote");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let o = origin.to_str().unwrap();
        git(o, &["init", "--bare", "-q"]).unwrap();
        git(&root_str, &["remote", "add", "origin", o]).unwrap();
        git(&root_str, &["push", "-q", "origin", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "hr2", "main", &app_data).unwrap();

        // A real origin EXISTS, but the fast/local poll doesn't probe → reported false.
        let off = agent_workflow_state_at(&root_str, "hr2", "", false).unwrap();
        assert!(!off.has_remote, "probe off ⇒ has_remote false even though origin exists");

        // …and the probing poll sees it. This is the pair that proves `false` is genuinely
        // ambiguous (no-remote vs not-probed) and why the frontend latches an observed true.
        let on = agent_workflow_state_at(&root_str, "hr2", "", true).unwrap();
        assert!(on.has_remote, "probing poll against a repo with origin ⇒ has_remote true");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&origin);
    }

    /// The full expected `WorkflowState` shape at one step of the e2e walk. Mirrors the TS fixture
    /// (`agentCta.e2e.test.ts`'s `wsOf`) field for field.
    struct Shape {
        in_local_main: bool,
        in_origin_main: bool,
        in_parent: bool,
        ahead_of_base: u32,
        landed: bool,
        pushed: bool,
        shipped: bool,
        has_remote: bool,
        pr_state: Option<&'static str>,
        pr_number: Option<u64>,
        pr_url: Option<&'static str>,
    }

    impl Shape {
        /// The baseline for this fixture: a build agent (no parent), against a repo with an origin,
        /// probing, with no release tag and no PR anywhere in the walk.
        fn nothing_landed() -> Self {
            Shape {
                in_local_main: false,
                in_origin_main: false,
                in_parent: false,
                ahead_of_base: 0,
                landed: false,
                pushed: false,
                shipped: false,
                has_remote: true,
                pr_state: None,
                pr_number: None,
                pr_url: None,
            }
        }
    }

    /// Assert a `WorkflowState` matches `want` field for field — `Shape` models the whole struct,
    /// so a caller can express any state (a future step that opens a PR included).
    ///
    /// The destructuring is the point: with no `..` rest pattern, ADDING a field to WorkflowState
    /// fails to compile HERE, so it can't land without someone deciding what this walk should pin.
    /// Precisely: E0027 forces the new field to be MENTIONED, not asserted — a pattern can still
    /// bind `_new_field: _` — and it binds only the Rust side; the TS fixture is held by its own
    /// `Required<WorkflowState>` defaults literal. Both force a decision, neither reads minds.
    ///
    /// Worth the machinery because hand-adding one assertion per field is exactly what let `shipped`
    /// — the strongest signal in the ladder (deriveLiveStage bumps straight to "shipped" on it) —
    /// go unpinned through two review rounds.
    fn assert_workflow_shape(got: &WorkflowState, want: Shape, step: &str) {
        let WorkflowState {
            in_local_main,
            in_origin_main,
            in_parent,
            ahead_of_base,
            landed,
            pushed,
            shipped,
            has_remote,
            pr_state,
            pr_number,
            pr_url,
        } = got;
        assert_eq!(*in_local_main, want.in_local_main, "{step}: in_local_main");
        assert_eq!(*in_origin_main, want.in_origin_main, "{step}: in_origin_main");
        assert_eq!(*in_parent, want.in_parent, "{step}: in_parent");
        assert_eq!(*ahead_of_base, want.ahead_of_base, "{step}: ahead_of_base");
        assert_eq!(*landed, want.landed, "{step}: landed");
        assert_eq!(*pushed, want.pushed, "{step}: pushed");
        // No release tag exists in this fixture. Pinned because deriveLiveStage treats `shipped` as
        // the TOP of the ladder — a tip_in_release/is_semver_tag regression reading true here would
        // silently outrank Land/Push/Close and neither half of the pair would notice.
        assert_eq!(*shipped, want.shipped, "{step}: shipped");
        assert_eq!(*has_remote, want.has_remote, "{step}: has_remote");
        // pr_state is read by deriveLiveStage, so drift here would change the button.
        assert_eq!(pr_state.as_deref(), want.pr_state, "{step}: pr_state");
        assert_eq!(*pr_number, want.pr_number, "{step}: pr_number");
        assert_eq!(pr_url.as_deref(), want.pr_url, "{step}: pr_url");
    }

    /// END-TO-END, against real git: walk a build agent through commit → land on LOCAL main →
    /// push main to origin, pinning the WHOLE `WorkflowState` shape at each step (see
    /// `assert_workflow_shape` — no enumeration here, because a hand-maintained list of fields is
    /// what went stale twice already). The TS half, `agentCta.e2e.test.ts`, transcribes these same
    /// values and asserts what the UI does with them. That transcription IS the seam, so a field
    /// drifting from its default has to fail HERE rather than leave the TS fixture silently wrong.
    /// (The TS fixture is held by its own `Required<WorkflowState>` literal — this walk can't force
    /// it; the two halves are compiler-forced independently.)
    ///
    /// The middle step is the founder's screenshot-2 state ("Landed on main… Nothing is pushed
    /// yet") — the one that used to read as plain `merged` and get a Close pill.
    #[test]
    fn workflow_state_walks_committed_then_local_land_then_origin_push() {
        let root = unique_root("e2e-stages");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("e2e-stages-appdata");
        let origin = unique_root("e2e-stages-remote");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let o = origin.to_str().unwrap();
        git(o, &["init", "--bare", "-q"]).unwrap();
        git(&root_str, &["remote", "add", "origin", o]).unwrap();
        git(&root_str, &["push", "-q", "origin", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "e1", "main", &app_data).unwrap();

        // 1. Committed on its own branch, nothing landed → the frontend reads building_saved → Land.
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        // Every field the TS fixture (agentCta.e2e.test.ts `wsOf`) models is pinned here, so a shape
        // change in Rust fails THIS test rather than leaving the hand-transcribed TS fixture
        // silently stale — the transcription is the seam, so it's the thing worth pinning.
        let s1 = agent_workflow_state_at(&root_str, "e1", "", true).unwrap();
        assert_workflow_shape(
            &s1,
            Shape { ahead_of_base: 1, ..Shape::nothing_landed() },
            "committed on its branch, nothing landed",
        );

        // 2. Landed on LOCAL main only — the founder's screenshot 2. The distinguishing signal is
        //    in_local_main=true while in_origin_main=false; before the split these collapsed into
        //    one `merged` stage and the composer offered Close over unpushed work.
        //
        //    Two values here are counter-intuitive: `landed` is true (a --no-ff merge is reachable,
        //    so the squash signal is trivially true too), and ahead_of_base is 1 rather than 0 —
        //    it's measured against the ref the branch was cut from, which is `origin/main` when that
        //    ref exists, and origin doesn't have the work yet.
        git(&root_str, &["merge", "--no-ff", "sparkle/agent-e1", "-m", "land e1"]).unwrap();
        let s2 = agent_workflow_state_at(&root_str, "e1", "", true).unwrap();
        assert_workflow_shape(
            &s2,
            Shape { in_local_main: true, landed: true, ahead_of_base: 1, ..Shape::nothing_landed() },
            "landed on local main, nothing pushed (founder screenshot 2)",
        );

        // 3. Pushed to origin → in_origin_main flips true → the work is genuinely done → Close.
        git(&root_str, &["push", "-q", "origin", "main"]).unwrap();
        let s3 = agent_workflow_state_at(&root_str, "e1", "", true).unwrap();
        assert_workflow_shape(
            &s3,
            Shape {
                in_local_main: true,
                in_origin_main: true,
                landed: true,
                ahead_of_base: 0,
                ..Shape::nothing_landed()
            },
            "pushed to origin main",
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&origin);
    }

    #[test]
    fn pr_create_args_guards_blank_target_and_defaults_title() {
        // Blank base would become `gh pr create --base ""` (opaque error) — reject early.
        assert!(pr_create_args("sparkle/agent-x", "  ", "t").is_err());
        // Title falls back to the branch name when blank.
        let a = pr_create_args("sparkle/agent-x", "main", "  ").unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--base main"));
        assert!(joined.contains("--head sparkle/agent-x"));
        assert!(joined.contains("--title sparkle/agent-x"), "blank title → branch name");
        // A real title is preserved (trimmed).
        let b = pr_create_args("sparkle/agent-x", "main", " Ship it ").unwrap();
        assert!(b.join(" ").contains("--title Ship it"));
    }

    #[test]
    fn delete_agent_branch_removes_the_ref_and_is_idempotent() {
        let root = unique_root("del-branch");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("del-branch-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "d1", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "unmerged work"]).unwrap();
        assert!(git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-d1"]).is_ok());

        // The branch is checked out in the worktree → must remove the worktree before deleting.
        git(&root_str, &["worktree", "remove", "--force", &info.path]).unwrap();
        delete_agent_branch_at(&root_str, "d1").unwrap();
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-d1"]).is_err(),
            "branch ref is gone after Discard"
        );
        // Idempotent: deleting an already-gone branch is Ok, not an error.
        delete_agent_branch_at(&root_str, "d1").unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn push_agent_branch_reports_no_remote_when_origin_is_absent() {
        let root = unique_root("push-noremote");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("push-noremote-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "pp", "main", &app_data).unwrap();
        // No `origin` in this fixture → Ship/Save must learn to fall back, not error.
        assert_eq!(push_agent_branch_at(&root_str, "pp").unwrap(), "no-remote");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // A SQUASH merge creates a NEW commit on main, so the agent tip is NOT an ancestor — ancestor
    // reachability (`in_local_main`) misses it. The `landed` tree-identity signal catches it, while
    // the branch still carries its original commit so `ahead_of_base > 0` keeps committedSeen true.
    #[test]
    fn workflow_state_detects_a_squash_merge_even_as_main_advances() {
        let root = unique_root("wf-squash");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-squash-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "sq", "main", &app_data).unwrap();

        // Agent authors real work on its branch.
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();

        // Squash-land it: stage the branch's net change as a fresh commit on main (no merge parent).
        git(&root_str, &["merge", "--squash", "sparkle/agent-sq"]).unwrap();
        git(&root_str, &["commit", "-m", "squash land sq"]).unwrap();

        let s = agent_workflow_state_at(&root_str, "sq", "", false).unwrap();
        assert!(!s.in_local_main, "squash made a new commit → tip is not an ancestor of main");
        assert!(s.landed, "merging the branch into main now adds nothing → landed (the squash signal)");
        assert!(s.ahead_of_base > 0, "branch still carries its original commit → committedSeen holds");

        // Main ADVANCES with unrelated work after the squash (the shared-main reality). Whole-tree
        // equality would now read false; the merge-tree "adds nothing" check must still see it landed.
        std::fs::write(root.join("unrelated.txt"), "other agent's work\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "unrelated work on main"]).unwrap();
        let s2 = agent_workflow_state_at(&root_str, "sq", "", false).unwrap();
        assert!(!s2.in_local_main, "still not an ancestor");
        assert!(s2.landed, "merging adds nothing even though main moved on → landed survives advancing main");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // A no-op branch (no authored commits) is trivially tree-identical to an unchanged default, so
    // `landed` is true — but `ahead_of_base == 0`, so the frontend committedSeen gate keeps it from
    // ever reading as Merged. This pins that `landed` alone never implies "merged".
    #[test]
    fn workflow_state_landed_is_gated_by_authored_work_for_a_noop_branch() {
        let root = unique_root("wf-noop");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-noop-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "noop", "main", &app_data).unwrap();

        let s = agent_workflow_state_at(&root_str, "noop", "", false).unwrap();
        assert!(s.landed, "no changes ⇒ tip tree == main tree ⇒ trivially landed");
        assert_eq!(s.ahead_of_base, 0, "no authored work ⇒ committedSeen gate stays closed");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // `pushed` reflects whether the agent branch's remote-tracking ref exists — the LIVE signal that
    // lights the "Pushed" stage without needing a PR. Before pushing there is no `origin/<branch>`
    // ref; simulating a push (creating the remote-tracking ref, exactly what `git push` does locally)
    // flips it true. Kept a pure local ref lookup so it's offline-safe.
    #[test]
    fn workflow_state_pushed_tracks_the_remote_tracking_ref() {
        let root = unique_root("wf-pushed");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-pushed-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "push", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();

        let before = agent_workflow_state_at(&root_str, "push", "", false).unwrap();
        assert!(!before.pushed, "no remote-tracking ref yet ⇒ not pushed");

        // Simulate a push: git creates refs/remotes/origin/<branch> on a successful push.
        let tip = git(&root_str, &["rev-parse", "sparkle/agent-push"]).unwrap();
        git(&root_str, &["update-ref", "refs/remotes/origin/sparkle/agent-push", &tip]).unwrap();
        let after = agent_workflow_state_at(&root_str, "push", "", false).unwrap();
        assert!(after.pushed, "remote-tracking ref now exists ⇒ pushed (drives the Pushed stage live)");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // `shipped` is true only when the branch tip is contained in a RELEASE tag (semver-ish). A
    // non-release tag (`nightly`) must NOT read as shipped; a `v*` tag must. This drives the top
    // "Shipped to Production" stage live — previously unreachable.
    #[test]
    fn workflow_state_shipped_requires_a_release_tag_on_the_tip() {
        let root = unique_root("wf-shipped");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-shipped-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "ship", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        let tip = git(&root_str, &["rev-parse", "sparkle/agent-ship"]).unwrap();

        // A non-release tag on the tip must not count as shipped.
        git(&root_str, &["tag", "nightly", &tip]).unwrap();
        let s0 = agent_workflow_state_at(&root_str, "ship", "", false).unwrap();
        assert!(!s0.shipped, "a non-release tag (nightly) is not a ship signal");

        // A semver release tag containing the tip ⇒ shipped.
        git(&root_str, &["tag", "v1.2.3", &tip]).unwrap();
        let s1 = agent_workflow_state_at(&root_str, "ship", "", false).unwrap();
        assert!(s1.shipped, "a v* release tag containing the tip ⇒ shipped (drives the Shipped stage live)");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // Regression: a brand-new agent whose branch is cut from `origin/<default>` while the LOCAL
    // default lags the remote must NOT read as having done work. Before the fix, `ahead_of_base`
    // was counted against local `main`, so the inherited (un-pulled) commits looked like the agent's
    // own — tripping the frontend `committedSeen` gate which, with `in_origin_main` trivially true,
    // rendered a fresh no-op agent as "Merged".
    #[test]
    fn fresh_branch_cut_from_origin_default_reads_as_no_work_when_local_lags() {
        let root = unique_root("wf-lag");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-lag-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // Advance the remote integration branch ahead of local main on a temp branch (local main
        // itself never moves, so it lags origin) — exactly the state of a user who hasn't pulled.
        git(&root_str, &["checkout", "-b", "remote-advance"]).unwrap();
        std::fs::write(root.join("r1.txt"), "remote work\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "remote ahead"]).unwrap();
        let remote_tip = git(&root_str, &["rev-parse", "HEAD"]).unwrap();
        git(&root_str, &["update-ref", "refs/remotes/origin/main", &remote_tip]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        git(&root_str, &["branch", "-D", "remote-advance"]).unwrap();

        // A brand-new agent: branch cut from origin/main (as effective_base would), zero authored work.
        let wt = worktree_path(&app_data, "p", "fresh").unwrap();
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(&root_str, &["worktree", "add", "-b", "sparkle/agent-fresh", &wt.to_string_lossy(), "origin/main"]).unwrap();

        let ws = agent_workflow_state_at(&root_str, "fresh", "", false).unwrap();
        assert!(ws.in_origin_main, "tip IS origin/main");
        assert!(!ws.in_local_main, "lagging local main does not contain the tip");
        assert_eq!(
            ws.ahead_of_base, 0,
            "no AUTHORED work ⇒ gate stays closed even though local main lags origin (regression)"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn land_merges_agent_branch_into_main_and_guards_dirty_and_empty() {
        let root = unique_root("land");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("land-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap(); // main is checked out at root
        // ensure_project_repo leaves .gitignore UNTRACKED; commit it so the root (our land target)
        // starts clean — a real well-kept project root would have it committed.
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "chore: gitignore"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "L1", "main", &app_data).unwrap();

        // Nothing committed yet → nothing to land.
        match land_agent_branch_at(&root_str, "L1", "main").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "nothing-to-land"),
            LandOutcome::Ok { .. } => panic!("should refuse an empty branch"),
        }

        // Commit real work on the agent branch.
        std::fs::write(Path::new(&info.path).join("f.txt"), "feature\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent feature"]).unwrap();

        // A dirty target (root) is refused without touching anything.
        std::fs::write(root.join("scratch.txt"), "wip").unwrap();
        match land_agent_branch_at(&root_str, "L1", "main").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "dirty"),
            LandOutcome::Ok { .. } => panic!("should refuse a dirty target"),
        }
        std::fs::remove_file(root.join("scratch.txt")).unwrap();

        // Clean target → the merge lands and main now contains the agent tip.
        match land_agent_branch_at(&root_str, "L1", "main").unwrap() {
            LandOutcome::Ok { target, ok, merge_sha } => {
                assert!(ok);
                assert_eq!(target, "main");
                // The land captured the merge commit it created — a full 40-char SHA equal to
                // main's new HEAD (Task B: the bead records this for release-containment checks).
                let head = git(&root_str, &["rev-parse", "main"]).unwrap().trim().to_string();
                assert_eq!(merge_sha, head, "captured merge_sha should be main's new HEAD");
                assert_eq!(merge_sha.len(), 40, "expected a full commit SHA");
            }
            LandOutcome::Err { reason, .. } => panic!("expected land to succeed, got {reason}"),
        }
        let ws = agent_workflow_state_at(&root_str, "L1", "", false).unwrap();
        assert!(ws.in_local_main, "after land, main contains the agent tip");
        assert_eq!(ws.ahead_of_base, 0, "no commits remain unique to the branch");

        // Re-landing is now a no-op (idempotent guard).
        match land_agent_branch_at(&root_str, "L1", "main").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "nothing-to-land"),
            LandOutcome::Ok { .. } => panic!("re-land should be a no-op"),
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn land_outcome_serializes_merge_sha_as_camelcase_for_the_ts_client() {
        // Guards the serde field-name boundary the in-process land test can't see: `LandOutcome` is
        // untagged with no container rename_all, so the multi-word field must serialize as `mergeSha`
        // (what TS `LandResult` reads). Without the explicit rename this is `merge_sha` and the whole
        // capture feature no-ops silently in production.
        let ok = LandOutcome::Ok { ok: true, target: "main".into(), merge_sha: "deadbeef".into() };
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v.get("mergeSha").and_then(|s| s.as_str()), Some("deadbeef"));
        assert!(v.get("merge_sha").is_none(), "must not leak the snake_case field name");
    }

    #[test]
    fn land_conflict_aborts_cleanly_and_target_not_checked_out_is_reported() {
        let root = unique_root("land-conflict");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("land-conflict-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        // A base file both sides will edit differently → a guaranteed merge conflict.
        std::fs::write(root.join("c.txt"), "base\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "base"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "L2", "main", &app_data).unwrap();

        // Agent edits c.txt one way…
        std::fs::write(Path::new(&info.path).join("c.txt"), "agent side\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent edit"]).unwrap();
        // …main edits the same lines another way.
        std::fs::write(root.join("c.txt"), "main side\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "main edit"]).unwrap();
        let main_before = git(&root_str, &["rev-parse", "main"]).unwrap();

        // A target that doesn't resolve → no-target (and it returns BEFORE the rev-list, so a
        // missing target never masquerades as "nothing-to-land" — the regression this guards).
        match land_agent_branch_at(&root_str, "L2", "does-not-exist").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "no-target"),
            LandOutcome::Ok { .. } => panic!("a missing target can't be landed into"),
        }

        // A branch that exists but is checked out nowhere → target-not-checked-out (not "conflict").
        git(&root_str, &["branch", "shelf", "main"]).unwrap();
        match land_agent_branch_at(&root_str, "L2", "shelf").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "target-not-checked-out"),
            LandOutcome::Ok { .. } => panic!("a non-checked-out target can't be landed into"),
        }

        // Landing into main conflicts; it must abort cleanly and leave main byte-identical.
        match land_agent_branch_at(&root_str, "L2", "main").unwrap() {
            LandOutcome::Err { reason, files, .. } => {
                assert_eq!(reason, "conflict");
                assert!(files.iter().any(|f| f == "c.txt"), "conflicted file reported: {files:?}");
            }
            LandOutcome::Ok { .. } => panic!("expected a conflict"),
        }
        assert_eq!(git(&root_str, &["rev-parse", "main"]).unwrap(), main_before, "main HEAD unchanged");
        assert!(git(&root_str, &["status", "--porcelain"]).unwrap().is_empty(), "abort left a clean tree");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn workflow_state_in_parent_tracks_merge_into_orchestrator_branch() {
        let root = unique_root("wf-parent");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-parent-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // Orchestrator agent + a worker cut from the orchestrator's branch.
        let orch = create_worktree_at(&root_str, "p", "orch", "main", &app_data).unwrap();
        std::fs::write(Path::new(&orch.path).join("o.txt"), "orch\n").unwrap();
        git(&orch.path, &["add", "-A"]).unwrap();
        git(&orch.path, &["commit", "-m", "orch base"]).unwrap();
        let worker = create_worktree_from_local(&root_str, "p", "wk", "sparkle/agent-orch", &app_data).unwrap();
        std::fs::write(Path::new(&worker.path).join("wk.txt"), "wk\n").unwrap();
        git(&worker.path, &["add", "-A"]).unwrap();
        git(&worker.path, &["commit", "-m", "worker work"]).unwrap();

        // Before merge: worker not yet in orchestrator branch.
        let s0 = agent_workflow_state_at(&root_str, "wk", "sparkle/agent-orch", false).unwrap();
        assert!(!s0.in_parent, "worker work not yet merged into the orchestrator branch");

        // Merge worker → orchestrator branch (worker's "On Main").
        git(&orch.path, &["merge", "--no-ff", "sparkle/agent-wk", "-m", "land worker"]).unwrap();
        let s1 = agent_workflow_state_at(&root_str, "wk", "sparkle/agent-orch", false).unwrap();
        assert!(s1.in_parent, "orchestrator branch now contains the worker tip → worker On Main");
        assert!(!s1.in_local_main, "orchestrator hasn't landed on main, so worker isn't Merged");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn markdown_changed_since_seeds_then_increments_scoped_to_dirs() {
        let root = unique_root("md-sync");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("md-sync-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "md1", "main", &app_data).unwrap();
        let wt = Path::new(&info.path);
        let dirs = vec!["PRD".to_string(), "docs/superpowers/specs".to_string()];

        // Commit a progress doc, a spec, an out-of-scope README, and an in-scope non-md file.
        std::fs::create_dir_all(wt.join("PRD")).unwrap();
        std::fs::create_dir_all(wt.join("docs/superpowers/specs")).unwrap();
        std::fs::write(wt.join("PRD/main.md"), "# progress v1").unwrap();
        std::fs::write(wt.join("docs/superpowers/specs/x.md"), "# spec").unwrap();
        std::fs::write(wt.join("PRD/notes.txt"), "not markdown").unwrap();
        std::fs::write(wt.join("README.md"), "# readme outside scope").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "docs"]).unwrap();
        let after_first = git(&info.path, &["rev-parse", "HEAD"]).unwrap();

        // Seed (empty since): both in-scope markdown files, with their content; nothing else.
        let seed = markdown_changed_since_at("p", "md1", "", &dirs, &app_data).unwrap();
        let mut paths: Vec<&str> = seed.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["PRD/main.md", "docs/superpowers/specs/x.md"]);
        let prd = seed.files.iter().find(|f| f.path == "PRD/main.md").unwrap();
        assert_eq!(prd.content, "# progress v1");
        assert_eq!(seed.head_sha, after_first);

        // Increment: change only the progress doc; since=after_first → only that file.
        std::fs::write(wt.join("PRD/main.md"), "# progress v2").unwrap();
        git(&info.path, &["commit", "-am", "update progress"]).unwrap();
        let inc = markdown_changed_since_at("p", "md1", &after_first, &dirs, &app_data).unwrap();
        let inc_paths: Vec<&str> = inc.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(inc_paths, vec!["PRD/main.md"]);
        assert_eq!(inc.files[0].content, "# progress v2", "current content, not the old blob");

        // A bogus/unknown since falls back to a full seed rather than erroring.
        let fallback = markdown_changed_since_at("p", "md1", "deadbeef", &dirs, &app_data).unwrap();
        assert_eq!(fallback.files.len(), 2, "unknown sha → reseed");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worktree_is_cut_from_base_branch_not_arbitrary_head() {
        let root = unique_root("cut-base");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("cut-base-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
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
        ensure_project_repo_inner(root_str.clone()).unwrap();
        // ensure_project_repo's first commit lands on whatever `git init` defaults to.
        let current = git(&root_str, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(resolve_default_branch(&root_str), current);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_default_branch_prefers_local_main() {
        let root = unique_root("rdb-main");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        // Create a `main` branch even if the repo initialized on `master`.
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        assert_eq!(resolve_default_branch(&root_str), "main");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_default_branch_honors_config_override() {
        // A non-empty [workflow].default_branch from the per-project config must win over git
        // auto-detection; a whitespace-only value falls through to auto-detect.
        let root = unique_root("rdb-config");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        assert_eq!(resolve_default_branch(&root_str), "main");

        let sparkle = root.join(".sparkle");
        std::fs::create_dir_all(&sparkle).unwrap();
        let cfg = sparkle.join("config.toml");

        std::fs::write(&cfg, "[workflow]\ndefault_branch = \"release/x\"\n").unwrap();
        assert_eq!(resolve_default_branch(&root_str), "release/x");

        std::fs::write(&cfg, "[workflow]\ndefault_branch = \"   \"\n").unwrap();
        assert_eq!(resolve_default_branch(&root_str), "main");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn effective_base_falls_back_to_local_when_remote_unreachable() {
        let root = unique_root("eb-offline");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
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
        ensure_project_repo_inner(root_str.clone()).unwrap();
        // HEAD exists (born) so worktrees are possible.
        assert!(git(&root_str, &["rev-parse", "HEAD"]).is_ok());
        // Running again is a no-op (no second commit, no error).
        let head1 = git(&root_str, &["rev-parse", "HEAD"]).unwrap();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let head2 = git(&root_str, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(head1, head2, "no extra commit on re-run");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn worker_worktree_is_cut_from_parent_local_branch() {
        let root = unique_root("worker-cut");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("worker-cut-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        // Parent agent "build1" gets a worktree off HEAD, then makes a unique commit on its branch.
        let parent = create_worktree_at(&root_str, "p", "build1", "HEAD", &app_data).unwrap();
        std::fs::write(Path::new(&parent.path).join("PARENT_MARK.txt"), "x").unwrap();
        git(&parent.path, &["add", "-A"]).unwrap();
        git(&parent.path, &["commit", "-m", "parent unique commit"]).unwrap();

        // Worker "w1" is cut from the parent's LOCAL branch — must contain the parent's commit.
        let worker =
            create_worktree_from_local(&root_str, "p", "w1", &parent.branch, &app_data).unwrap();
        assert_eq!(worker.branch, "sparkle/agent-w1");
        assert!(Path::new(&worker.path).join("PARENT_MARK.txt").exists(),
            "worker branch should descend from the parent branch");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worker_prepare_idempotent_does_not_reclobber_lineage() {
        // CRITICAL lineage guard: when the worker tab opens, AgentPane.prepare() calls
        // create_worktree_at with the worker's baseBranch (= project default, e.g. "main"). That must
        // NOT re-cut the worker off main — the idempotency short-circuit (worktree.rs:202, which runs
        // BEFORE any base resolution) returns the existing parent-branch worktree unchanged. This test
        // pins that behavior so a future change to the guard can't silently clobber worker lineage.
        let root = unique_root("worker-prep");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("worker-prep-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        let parent = create_worktree_at(&root_str, "p", "build1", "HEAD", &app_data).unwrap();
        std::fs::write(Path::new(&parent.path).join("PARENT_MARK.txt"), "x").unwrap();
        git(&parent.path, &["add", "-A"]).unwrap();
        git(&parent.path, &["commit", "-m", "parent unique commit"]).unwrap();

        let worker = create_worktree_from_local(&root_str, "p", "w1", &parent.branch, &app_data).unwrap();
        // Simulate the subsequent prepare() call with the project default base.
        let again = create_worktree_at(&root_str, "p", "w1", "main", &app_data).unwrap();
        assert_eq!(again.path, worker.path);
        assert!(Path::new(&again.path).join("PARENT_MARK.txt").exists(),
            "parent-branch lineage must be preserved, not re-cut from main");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worker_worktree_rejects_empty_parent_branch() {
        let root = unique_root("worker-empty");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("worker-empty-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        for bad in ["", "   "] {
            let err = create_worktree_from_local(&root_str, "p", "w1", bad, &app_data)
                .err()
                .expect("expected Err for empty parent_branch");
            assert!(err.contains("parent_branch is required"), "got: {err}");
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worker_worktree_rejects_nonexistent_local_base() {
        let root = unique_root("worker-nobase");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("worker-nobase-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        let err = create_worktree_from_local(&root_str, "p", "w1", "sparkle/agent-missing", &app_data)
            .err()
            .expect("expected Err for nonexistent local base");
        assert!(err.contains("does not exist locally"), "got: {err}");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn read_worker_result_returns_none_then_some() {
        let dir = unique_root("worker-result");
        // Absent → None.
        assert!(read_worker_result_at(&dir).unwrap().is_none());
        // Present → Some(contents).
        let sparkle = dir.join(".sparkle");
        std::fs::create_dir_all(&sparkle).unwrap();
        std::fs::write(sparkle.join("result.json"), r#"{"ok":true}"#).unwrap();
        assert_eq!(read_worker_result_at(&dir).unwrap().as_deref(), Some(r#"{"ok":true}"#));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn worker_manifest_write_then_read_roundtrips() {
        // sparkle-hwfv: writing a manifest into a worktree makes it readable back verbatim,
        // creating `.sparkle/` as needed.
        let dir = unique_root("worker-manifest-rt");
        assert!(read_worker_manifest_at(&dir).unwrap().is_none()); // absent → None
        let manifest = json!({
            "workerId": "w1", "buildAgentId": "b1", "projectId": "p1",
            "branch": "sparkle/agent-w1", "worktree": dir.to_string_lossy(),
            "task": "do it", "beadId": "bead-9", "createdAt": "2026-07-06T00:00:00Z",
        });
        write_worker_manifest_at(&dir, &manifest).unwrap();
        let got = read_worker_manifest_at(&dir).unwrap().expect("manifest present after write");
        assert_eq!(got["workerId"], "w1");
        assert_eq!(got["buildAgentId"], "b1");
        assert_eq!(got["task"], "do it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_worker_manifests_collects_and_injects_worktree_path() {
        // sparkle-3xus: the scan returns each worktree's manifest, overwriting `worktree` with the
        // ACTUAL on-disk directory (authoritative) and skipping dirs without a manifest.
        let app_data = unique_root("scan-app-data");
        let project_id = "proj-scan";
        let wt_root = app_data.join("worktrees").join(project_id);
        std::fs::create_dir_all(&wt_root).unwrap();

        // Worker A: has a manifest (with a deliberately STALE worktree value to prove it's fixed).
        let wa = wt_root.join("worker-a");
        std::fs::create_dir_all(&wa).unwrap();
        write_worker_manifest_at(
            &wa,
            &json!({ "workerId": "worker-a", "buildAgentId": "b1", "projectId": project_id,
                     "branch": "sparkle/agent-a", "worktree": "/stale/path", "task": "t",
                     "createdAt": "x" }),
        )
        .unwrap();

        // Worker B: a bare worktree dir with NO manifest (legacy worker) → skipped.
        std::fs::create_dir_all(wt_root.join("worker-b")).unwrap();

        let found = scan_worker_manifests_at(&app_data, project_id).unwrap();
        assert_eq!(found.len(), 1, "only the dir with a manifest is returned");
        let m = &found[0];
        assert_eq!(m["workerId"], "worker-a");
        // `worktree` is the REAL directory found, not the stale value written into the file.
        assert_eq!(m["worktree"], wa.to_string_lossy().to_string());

        // A project with no worktrees dir yet → empty (not an error).
        assert!(scan_worker_manifests_at(&app_data, "no-such-project").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&app_data);
    }
}

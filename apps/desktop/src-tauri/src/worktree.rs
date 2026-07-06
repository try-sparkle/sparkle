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
use std::process::Command;
use std::sync::{Mutex, OnceLock};
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
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("no app data dir: {e}"))
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
pub async fn project_default_branch(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(resolve_default_branch(&root)))
        .await
        .map_err(|e| format!("project_default_branch task failed: {e}"))?
}

/// Roots whose repo has already been ensured this session. `ensure_project_repo` is idempotent but
/// runs 3-4 git subprocesses; caching "ready" means only the FIRST agent per project pays that cost
/// (subsequent concurrent opens hit the fast path instead of re-running init/config/commit checks).
fn ready_repos() -> &'static Mutex<HashSet<String>> {
    static READY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    READY.get_or_init(|| Mutex::new(HashSet::new()))
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
#[tauri::command]
pub async fn ensure_project_repo(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ensure_project_repo_inner(path))
        .await
        .map_err(|e| format!("ensure_project_repo task failed: {e}"))?
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
        git(root, &["worktree", "add", &wt_str, &branch])?;
    } else {
        // Cut IMMEDIATELY from the last-known integration base (no blocking network fetch on the
        // spawn critical path — an unreachable remote must never stall opening an agent). A
        // background, throttled fetch then refreshes `origin/<base>` so the NEXT agent's cut and
        // this branch's later refresh see a fresh tip.
        let base = effective_base(root, base_branch, false);
        git(root, &["worktree", "add", "-b", &branch, &wt_str, &base])?;
        spawn_background_origin_refresh(root, base_branch);
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
    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt_str = wt.to_string_lossy().to_string();

    // Dirtiness needs the actual worktree. When it's GONE (a landed/cleaned-up agent whose tab
    // stays open and keeps getting polled), a removed tree has no uncommitted changes — report
    // dirty=false instead of erroring, so the 30s poll doesn't re-fail every tick forever and
    // bury real errors in the log. When the tree EXISTS, still propagate a failed read rather than
    // masking it as a misleading "clean" false-negative on the common UI-status path.
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
        return Ok(BranchStatus { ahead: 0, behind: 0, dirty, files_changed: 0, insertions: 0, deletions: 0 });
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

    Ok(BranchStatus { ahead, behind, dirty, files_changed, insertions, deletions })
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
    let mut cmd = Command::new("git");
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
    let mut cmd = Command::new("gh");
    cmd.arg("pr")
        .args(["list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,url"])
        .current_dir(root)
        // Keep gh non-interactive and quiet; never let it block the poll on a prompt or updater.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    let Ok(output) = cmd.output() else {
        return none; // gh not installed / failed to spawn
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
    let mut cmd = Command::new("gh");
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
    let Ok(output) = cmd.output() else {
        return none; // gh not installed / failed to spawn
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
    let _ = git(root, &["fetch", "--quiet", "--no-tags", "origin", default_branch]);
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
    let counts = git(root, &["rev-list", "--left-right", "--count", &format!("{base_ref}...{branch}")])?;
    let mut it = counts.split_whitespace();
    let behind: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    // `--no-optional-locks`: a plain `git status` refreshes and REWRITES the worktree index (to
    // update its stat cache), which would bump the index mtime our fingerprint keys on and defeat the
    // skip on the very next tick. This top-level flag tells git not to take the index lock / write it,
    // so the mtime stays stable and an idle, unchanged agent is actually skipped (sparkle-zlic).
    let dirty = if wt.exists() {
        !git(&wt_str, &["--no-optional-locks", "status", "--porcelain"])?.is_empty()
    } else {
        false
    };
    let numstat = git(root, &["diff", "--numstat", &format!("{base_ref}...{branch}")]).unwrap_or_default();
    let (mut files_changed, mut insertions, mut deletions) = (0u32, 0u32, 0u32);
    for line in numstat.lines().filter(|l| !l.trim().is_empty()) {
        files_changed += 1;
        let mut cols = line.split_whitespace();
        insertions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        deletions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    }
    Ok(BranchStatus { ahead, behind, dirty, files_changed, insertions, deletions })
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
    Ok { ok: bool, target: String },
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
    let mut merge = Command::new("git");
    merge.arg("-C").arg(&wt).args(["merge", "--no-ff", &branch, "-m", &msg]);
    apply_noninteractive(&mut merge);
    match merge.output() {
        Ok(o) if o.status.success() => Ok(LandOutcome::Ok { ok: true, target: target.to_string() }),
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
        let mut cmd = Command::new("gh");
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
        assert!(hooks[0]["matcher"].as_str().unwrap().contains("Edit"));
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
            LandOutcome::Ok { target, ok } => {
                assert!(ok);
                assert_eq!(target, "main");
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
}

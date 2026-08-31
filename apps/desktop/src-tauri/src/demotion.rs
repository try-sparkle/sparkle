//! Cloud → local agent DEMOTION — the Rust side.
//!
//! Design: `docs/superpowers/specs/2026-08-01-cloud-runtime-switching-design.md` (Decisions 3, 4).
//! Pinned contract: `docs/superpowers/plans/2026-08-01-cloud-runtime-switching.md` §W2.
//!
//! Demotion is the mirror image of `promotion.rs`, and it inherits that module's shape on purpose:
//! a pure `*_at` function that the tests drive against real temp repos, plus a thin
//! `#[tauri::command]` wrapper that only resolves app state and hands off to `spawn_blocking`.
//!
//! | command                      | mutates                                   | failure leaves                     |
//! |------------------------------|-------------------------------------------|------------------------------------|
//! | `demotion_land_branch`       | `origin/<branch>`, one local worktree      | the local tree exactly as it was   |
//! | `demotion_write_transcript`  | one file under `~/.claude/projects/<slug>` | no file (the write is atomic)      |
//!
//! **The refusals are the feature.** `dirty` and `diverged` REFUSE rather than merge, reset or
//! stash: both mean the LOCAL copy holds content the cloud does not, and destroying it is exactly
//! the failure this feature exists to prevent. Every refusal carries a stable prefix so the desktop
//! can classify it without parsing git prose (see [`land_branch_at`]).
//!
//! Two rules this module REUSES rather than re-derives, because a second copy of either is a bug
//! that has already shipped once:
//!   * the `~/.claude/projects/<slug>/` layout → `crate::claude::{claude_projects_root,
//!     encode_project_slug}` (a re-derived slug is how the space-in-"Application Support" bug came
//!     back);
//!   * the agent-worktree layout → `crate::worktree::worktree_path`, the same helper
//!     `create_worker_worktree` uses. There is one worktree layout in this app, not two.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::worktree::git;

/// How many paths a `dirty:` refusal names. The dialog lists them, so the cap bounds the dialog.
const DIRTY_FILES_CAP: usize = 50;

/// What a successful landing did.
///
/// Serialized `camelCase` (`headSha`), matching `PromotionPreflight` and every other struct the
/// desktop reads. `agentPromotion/rust.ts` normalizes either casing, but the app has one convention
/// and a second one here would be a trap for the next reader.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DemotionLanding {
    /// Absolute path of the worktree the branch is now landed in.
    pub worktree: String,
    /// The worktree's HEAD after landing. Equals the caller's `expected_sha` (a difference is an
    /// `Err`, not a field), so the caller can record it as the local baseline.
    pub head_sha: String,
    /// true  = the worktree was cut fresh (a born-in-the-cloud agent had none)
    /// false = an existing worktree was fast-forwarded (a previously promoted agent)
    pub created: bool,
}

/// Reject a branch name before it reaches a git argument.
///
/// Mirrors `worktree::validate_ref`'s policy (which is private to that module) for the same reason
/// it exists there: a leading `-` is parsed as an OPTION (`--upload-pack=` on fetch → command
/// execution), and a `:` or leading `+` turns `git fetch origin <arg>` into a REFSPEC that can
/// force-overwrite a local ref. We also build a refspec out of this name below, so the `:` ban is
/// load-bearing twice over.
///
/// Deliberately classified as `worktree-failed:` rather than a new prefix — it is refused before
/// anything is touched, and the desktop's classifier only knows the pinned vocabulary.
fn validate_branch(branch: &str) -> Result<(), String> {
    let b = branch.trim();
    if b.is_empty() {
        return Err("worktree-failed:branch is required".into());
    }
    if b.starts_with('-') || b.starts_with('+') {
        return Err(format!("worktree-failed:branch name is not a branch: {b:?}"));
    }
    if b.bytes().any(|c| c.is_ascii_control() || c == b' ') {
        return Err(format!("worktree-failed:branch name has whitespace/control chars: {b:?}"));
    }
    let forbidden = |c: u8| matches!(c, b':' | b'~' | b'^' | b'?' | b'*' | b'[' | b'\\');
    if b.bytes().any(forbidden) || b.contains("..") {
        return Err(format!("worktree-failed:branch name has characters git forbids: {b:?}"));
    }
    Ok(())
}

/// Split a `-z` git listing. NUL-delimited so a path with a space, a quote or a non-ASCII byte
/// arrives whole — `--name-only` without `-z` would hand back a `core.quotePath` escape sequence,
/// and the refusal names files the user has to go find on disk.
fn split_nul(out: &str) -> Vec<String> {
    out.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect()
}

/// Everything uncommitted in `worktree`: (sorted paths capped at [`DIRTY_FILES_CAP`], TRUE total).
///
/// Two commands rather than `status --porcelain` parsing: `diff HEAD` covers tracked changes
/// (staged, unstaged and deletions) and `ls-files --others` covers untracked ones, and neither
/// needs the status column stripped off the front of a path. An unborn HEAD makes the first fail;
/// that is not a dirty tree, so it degrades to the untracked half alone.
fn dirty_files_at(worktree: &str) -> (Vec<String>, u32) {
    let mut paths: Vec<String> = Vec::new();
    if let Ok(tracked) = git(worktree, &["diff", "--name-only", "-z", "HEAD"]) {
        paths.extend(split_nul(&tracked));
    }
    if let Ok(untracked) = git(worktree, &["ls-files", "--others", "--exclude-standard", "-z"]) {
        paths.extend(split_nul(&untracked));
    }
    paths.sort();
    paths.dedup();
    let count = paths.len() as u32;
    paths.truncate(DIRTY_FILES_CAP);
    (paths, count)
}

/// `git merge-base --is-ancestor a b` — true when `a` is reachable from `b`, i.e. a fast-forward
/// from `a` to `b` is possible. Exit status IS the answer, so a non-zero exit is `false`, not an
/// error to propagate.
fn is_ancestor(cwd: &str, a: &str, b: &str) -> bool {
    git(cwd, &["merge-base", "--is-ancestor", a, b]).is_ok()
}

/// Core (testable) of [`demotion_land_branch`].
///
/// Bring `branch` down to a local worktree and land it at `expected_sha`.
///
/// `existing_worktree = Some(p)`: fetch and `merge --ff-only origin/<branch>` in `p`.
/// `existing_worktree = None`:    fetch, then cut a worktree for `branch` at
/// `crate::worktree::worktree_path(app_data, project_id, agent_id)` — the SAME helper
/// `create_worker_worktree` uses. That helper is keyed by `project_id`, which the pinned signature
/// does not carry, so it arrives as an `Option` the desktop supplies; see [`demotion_land_branch`].
///
/// Refusals are `Err` with a stable prefix so the desktop can classify without parsing git prose:
///   * `"dirty:<file>,<file>,…"` — the local worktree has uncommitted changes (capped at 50 names)
///   * `"diverged"`              — local has commits `origin/<branch>` does not; ff is impossible
///   * `"no-remote"`             — no `origin`
///   * `"sha-mismatch:<actual>"` — landed, but HEAD != `expected_sha` (the sandbox moved under us)
///   * `"fetch-failed:<git err>"` / `"worktree-failed:<git err>"`
///
/// `dirty` and `diverged` REFUSE rather than merge, reset, or stash: both mean the local copy holds
/// content the cloud does not, and destroying it is the failure this feature exists to prevent.
/// Both are checked BEFORE anything is written, so a refusal leaves the tree byte-identical.
///
/// `sha-mismatch` is the one refusal that fires AFTER a mutation: the landing succeeded and the
/// worktree really is at `head_sha`; what failed is the caller's expectation that the sandbox had
/// stopped moving. It is an `Err` because the caller must NOT proceed to cut the sandbox on it.
pub fn land_branch_at(
    root: &str,
    agent_id: &str,
    project_id: Option<&str>,
    existing_worktree: Option<&str>,
    branch: &str,
    expected_sha: &str,
    app_data: &Path,
) -> Result<DemotionLanding, String> {
    validate_branch(branch)?;
    let branch = branch.trim();
    let expected = expected_sha.trim();
    // Fail CLOSED, before touching anything: without a baseline there is no cutover guard at all,
    // and a landing that cannot be checked is worse than one that refuses.
    if expected.is_empty() {
        return Err("worktree-failed:expected_sha is required (it is the landing's baseline)".into());
    }

    // `no-remote` first: with no origin there is nothing to bring down, and every later step would
    // fail with a git error the user cannot act on.
    if git(root, &["remote", "get-url", "origin"]).is_err() {
        return Err("no-remote".into());
    }

    // An EXPLICIT refspec, not a bare `git fetch origin <branch>`: the bare form's update of
    // `refs/remotes/origin/<branch>` is opportunistic and depends on the remote's configured fetch
    // refspec, and every comparison below reads that ref by name.
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let refspec = format!("+refs/heads/{branch}:{remote_ref}");
    // Bounded + process-group-killed on expiry (`sparkle-cw6yo6`, `sparkle-q2xtel`): a wedged fetch
    // transport must not accumulate machine-wide. NOT the unbounded `git`, which blocks forever.
    crate::worktree::git_networked_within(
        root,
        &["fetch", "origin", refspec.as_str()],
        crate::worktree::NETWORK_TIMEOUT,
    )
    .map_err(|e| format!("fetch-failed:{e}"))?;
    git(root, &["rev-parse", remote_ref.as_str()]).map_err(|e| format!("fetch-failed:{e}"))?;

    // ── resolve (or cut) the worktree ───────────────────────────────────────────────────────────
    let existing = existing_worktree.map(str::trim).filter(|p| !p.is_empty());
    let (worktree, created) = match existing {
        Some(p) => (p.to_string(), false),
        None => {
            let project_id = project_id
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("worktree-failed:project_id is required to cut a worktree for this agent")?;
            let wt = crate::worktree::worktree_path(app_data, project_id, agent_id)
                .map_err(|e| format!("worktree-failed:{e}"))?;
            let wt_str = wt.to_string_lossy().to_string();

            // Idempotent, like `create_worktree_at`: a retried demotion finds its own worktree and
            // falls through to the fast-forward path rather than failing on `worktree add`.
            if wt.exists() && git(&wt_str, &["rev-parse", "--is-inside-work-tree"]).is_ok() {
                (wt_str, false)
            } else {
                // Check divergence BEFORE creating anything. A local `<branch>` that origin has not
                // seen is a refusal, and refusing after cutting a worktree would leave a directory
                // and a git admin entry behind for a demotion that never happened.
                let local_ref = format!("refs/heads/{branch}");
                let local_exists =
                    git(root, &["rev-parse", "--verify", "--quiet", local_ref.as_str()]).is_ok();
                if local_exists && !is_ancestor(root, &local_ref, &remote_ref) {
                    return Err("diverged".into());
                }
                if let Some(parent) = wt.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("worktree-failed:create worktree dir: {e}"))?;
                }
                if local_exists {
                    // Re-attach the branch (it is behind, or equal — the ff below settles it).
                    // Never re-cut from the remote: that would discard local commits origin has.
                    git(root, &["worktree", "add", &wt_str, branch])
                        .map_err(|e| format!("worktree-failed:{e}"))?;
                } else {
                    // Born in the cloud: no local ref at all, so cut one at the remote tip.
                    git(root, &["worktree", "add", "-b", branch, &wt_str, remote_ref.as_str()])
                        .map_err(|e| format!("worktree-failed:{e}"))?;
                }
                (wt_str, true)
            }
        }
    };

    // ── land it ─────────────────────────────────────────────────────────────────────────────────
    // Dirty first: it is the most actionable refusal, and it must be answered before any ref moves.
    let (files, dirty_count) = dirty_files_at(&worktree);
    if dirty_count > 0 {
        return Err(format!("dirty:{}", files.join(",")));
    }

    // The worktree must be ON `branch`. A parked or detached worktree would otherwise receive a
    // fast-forward onto whatever it happens to be sitting on — landing cloud work on the wrong
    // branch, silently. (`worktree::park_worktree_on_base_at` really does park agent worktrees on a
    // detached base, so this is a state that occurs, not a hypothetical.)
    let head_branch = git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map_err(|e| format!("worktree-failed:{e}"))?;
    let head_branch = head_branch.trim();
    if head_branch != branch {
        return Err(format!(
            "worktree-failed:worktree is on '{head_branch}', not '{branch}' — switch it back first"
        ));
    }

    if !is_ancestor(&worktree, "HEAD", &remote_ref) {
        return Err("diverged".into());
    }
    git(&worktree, &["merge", "--ff-only", remote_ref.as_str()])
        .map_err(|e| format!("worktree-failed:{e}"))?;

    let head_sha = git(&worktree, &["rev-parse", "HEAD"])
        .map_err(|e| format!("worktree-failed:{e}"))?
        .trim()
        .to_string();
    if head_sha != expected {
        return Err(format!("sha-mismatch:{head_sha}"));
    }

    Ok(DemotionLanding { worktree, head_sha, created })
}

/// Bring `branch` down to a local worktree and land it at `expected_sha`.
///
/// **Deviation from the pinned signature, and it is additive:** `project_id` is an extra
/// `Option<String>` argument. The pinned list carries `root` and `agent_id` but no project id,
/// while the ONE worktree-layout helper in this app (`worktree::worktree_path`, used by
/// `create_worker_worktree`) is keyed by `<app_data>/worktrees/<project_id>/<agent_id>`. Inventing
/// a second layout was explicitly ruled out, so the id arrives here instead. It is optional so a
/// caller passing only the pinned arguments still deserializes — a promoted agent (which has an
/// `existing_worktree`) never needs it, and a born-in-the-cloud agent without it gets a
/// `worktree-failed:` refusal at the top of the landing rather than a garbled path.
#[tauri::command]
pub async fn demotion_land_branch(
    app: AppHandle,
    root: String,
    agent_id: String,
    project_id: Option<String>,
    existing_worktree: Option<String>,
    branch: String,
    expected_sha: String,
) -> Result<DemotionLanding, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        land_branch_at(
            &root,
            &agent_id,
            project_id.as_deref(),
            existing_worktree.as_deref(),
            &branch,
            &expected_sha,
            &app_data,
        )
    })
    .await
    .map_err(|e| format!("demotion_land_branch task failed: {e}"))?
}

/// Two paths naming the same directory, ignoring a trailing separator.
///
/// The same tolerance `promotion::same_dir` applies, and it has to be: these two rewrites are
/// inverses, so a `cwd` the upward rewrite matched must be one the downward rewrite matches too.
fn same_dir(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

/// Rewrite ONE record's top-level `cwd` from `sandbox_cwd` back to `worktree`.
///
/// The EXACT INVERSE of `promotion::rewrite_cwd`, and inverse for the same reasons it is written
/// the way it is: parsed as JSON rather than string-replaced, so the sandbox path appearing inside
/// message TEXT ("see /home/user/repo/x.ts") is left alone. That text is a historical statement the
/// conversation really made; only the `cwd` FIELD keys Claude Code's project slug, so only the
/// field moves. A line that does not parse as JSON passes through unchanged rather than being
/// dropped — a dropped line is a lost turn, and a transcript may legitimately be mid-write.
fn rewrite_cwd_back(line: &str, sandbox_cwd: &str, worktree: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(line) else {
        return line.to_string();
    };
    let Some(obj) = value.as_object_mut() else {
        return line.to_string();
    };
    let matches_sandbox =
        obj.get("cwd").and_then(Value::as_str).is_some_and(|c| same_dir(c, sandbox_cwd));
    if !matches_sandbox {
        return line.to_string();
    }
    obj.insert("cwd".to_string(), Value::String(worktree.to_string()));
    serde_json::to_string(&value).unwrap_or_else(|_| line.to_string())
}

/// A session id is about to become a FILENAME, so it may only be a plain uuid-ish token.
///
/// Rejects `/`, `..`, a leading `-`, and anything else that is not `[A-Za-z0-9_-]`. The id comes
/// off a filename inside a sandbox we do not control, and the write below joins it straight onto
/// the user's own `~/.claude/projects/` tree.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('-')
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Core (testable) of [`demotion_write_transcript`].
///
/// Writes to `<claude_projects_root(config_dir)>/<encode_project_slug(worktree)>/<session_id>.jsonl`
/// — resolved through the SAME helpers session detection uses, never a hand-built
/// `~/.claude/projects/<slug>`. Returns the number of records written.
///
/// The write is ATOMIC (temp file + rename). A half-written transcript is not a partial
/// conversation, it is one `claude --resume` refuses to open, and the local agent would come up
/// blank with the cloud sandbox already gone.
///
/// An EMPTY transcript is an `Err` and writes nothing: a zero-record `.jsonl` is worse than no file
/// at all, because `--resume` would find a session id backed by no conversation. The caller treats
/// any transcript failure as non-fatal (spec Decision 4) and falls back to a handoff briefing.
pub fn write_transcript_at(
    worktree: &str,
    config_dir: Option<&str>,
    session_id: &str,
    jsonl: &str,
    sandbox_cwd: &str,
) -> Result<u32, String> {
    if !valid_session_id(session_id) {
        return Err(format!("invalid session id: {session_id:?}"));
    }

    let records: Vec<String> = jsonl
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| rewrite_cwd_back(l, sandbox_cwd, worktree))
        .collect();
    if records.is_empty() {
        return Err("transcript has no records".into());
    }

    // Same resolution order as `claude_latest_session_path_sync`: an explicit config dir wins, then
    // the environment's `CLAUDE_CONFIG_DIR`, then `$HOME/.claude`. Reading it any other way would
    // let the transcript land where the spawned `claude` will not look.
    let env = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|s| !s.is_empty()).map(PathBuf::from);
    let config_dir = crate::claude::resolve_session_config_dir(config_dir, env);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let projects = crate::claude::claude_projects_root(config_dir.as_deref(), home.as_deref())
        .ok_or("cannot resolve the Claude projects directory")?;

    let dir = projects.join(crate::claude::encode_project_slug(worktree));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create transcript dir: {e}"))?;

    let mut body = records.join("\n");
    body.push('\n');
    let final_path = dir.join(format!("{session_id}.jsonl"));
    let tmp_path = dir.join(format!("{session_id}.jsonl."));
    std::fs::write(&tmp_path, body.as_bytes()).map_err(|e| format!("write transcript: {e}"))?;
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("install transcript: {e}")
    })?;

    Ok(records.len() as u32)
}

/// Write a transferred sandbox transcript into the LOCAL Claude Code projects tree, rewriting every
/// record's `cwd` from `sandbox_cwd` to `worktree`. Returns the number of records written.
#[tauri::command]
pub async fn demotion_write_transcript(
    worktree: String,
    config_dir: Option<String>,
    session_id: String,
    jsonl: String,
    sandbox_cwd: String,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_transcript_at(&worktree, config_dir.as_deref(), &session_id, &jsonl, &sandbox_cwd)
    })
    .await
    .map_err(|e| format!("demotion_write_transcript task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const SANDBOX: &str = "/home/user/repo";

    fn unique_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sparkle-demote-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A repo on `main` with one real commit and a real bare `origin`. Returns (root, bare).
    fn init_repo_with_origin(tag: &str) -> (String, String) {
        let root = unique_root(tag);
        let r = root.to_str().unwrap().to_string();
        git(&r, &["init", "-q"]).unwrap();
        git(&r, &["config", "user.email", "t@t"]).unwrap();
        git(&r, &["config", "user.name", "t"]).unwrap();
        std::fs::write(root.join("README.md"), "seed\n").unwrap();
        git(&r, &["add", "-A"]).unwrap();
        git(&r, &["commit", "-q", "-m", "init"]).unwrap();
        git(&r, &["branch", "-M", "main"]).unwrap();

        let bare = unique_root(&format!("{tag}-origin"));
        let bare_str = bare.to_string_lossy().to_string();
        git(&bare_str, &["init", "-q", "--bare"]).unwrap();
        git(&r, &["remote", "add", "origin", &bare_str]).unwrap();
        git(&r, &["push", "-q", "origin", "main"]).unwrap();
        (r, bare_str)
    }

    /// A repo with NO origin at all.
    fn init_repo_no_origin(tag: &str) -> String {
        let root = unique_root(tag);
        let r = root.to_str().unwrap().to_string();
        git(&r, &["init", "-q"]).unwrap();
        git(&r, &["config", "user.email", "t@t"]).unwrap();
        git(&r, &["config", "user.name", "t"]).unwrap();
        std::fs::write(root.join("README.md"), "seed\n").unwrap();
        git(&r, &["add", "-A"]).unwrap();
        git(&r, &["commit", "-q", "-m", "init"]).unwrap();
        git(&r, &["branch", "-M", "main"]).unwrap();
        r
    }

    /// A linked worktree on a NEW branch cut from `main`, pushed to origin so the cloud can clone it.
    fn promoted_worktree(root: &str, tag: &str, branch: &str) -> String {
        let wt = unique_root(&format!("{tag}-wt"));
        let wt_str = wt.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&wt); // `worktree add` insists on a non-existent path
        git(root, &["worktree", "add", "-q", "-b", branch, &wt_str, "main"]).unwrap();
        git(root, &["push", "-q", "origin", branch]).unwrap();
        wt_str
    }

    /// Stand in for the sandbox: clone `bare`, commit `file` on `branch`, push. Returns the sha now
    /// on `origin/<branch>` — exactly what `prepareHandoff` reports as `pushedSha`.
    fn cloud_commits(bare: &str, tag: &str, branch: &str, file: &str, new_branch: bool) -> String {
        let parent = unique_root(&format!("{tag}-cloud"));
        let parent_str = parent.to_string_lossy().to_string();
        git(&parent_str, &["clone", "-q", bare, "repo"]).unwrap();
        let dir = parent.join("repo");
        let d = dir.to_string_lossy().to_string();
        git(&d, &["config", "user.email", "agent@sparkle.ai"]).unwrap();
        git(&d, &["config", "user.name", "Sparkle Cloud Agent"]).unwrap();
        if new_branch {
            git(&d, &["checkout", "-q", "-b", branch]).unwrap();
        } else {
            git(&d, &["checkout", "-q", branch]).unwrap();
        }
        std::fs::write(dir.join(file), "from the cloud\n").unwrap();
        git(&d, &["add", "-A"]).unwrap();
        git(&d, &["commit", "-q", "-m", "cloud work"]).unwrap();
        git(&d, &["push", "-q", "origin", branch]).unwrap();
        git(&d, &["rev-parse", "HEAD"]).unwrap().trim().to_string()
    }

    fn head_sha(cwd: &str) -> String {
        git(cwd, &["rev-parse", "HEAD"]).unwrap().trim().to_string()
    }

    // ── landing ─────────────────────────────────────────────────────────────────────────────────

    /// THE happy path, asserted on the SIDE EFFECT: the cloud's file is on local disk afterwards.
    /// Asserting only the returned sha would pass against a function that fetched and returned the
    /// remote sha without ever touching the working tree.
    #[test]
    fn land_fast_forwards_an_existing_worktree_onto_the_cloud_commit() {
        let (root, bare) = init_repo_with_origin("ff");
        let wt = promoted_worktree(&root, "ff", "sparkle/agent-a1");
        let before = head_sha(&wt);
        let cloud = cloud_commits(&bare, "ff", "sparkle/agent-a1", "cloud.txt", false);
        assert!(!Path::new(&wt).join("cloud.txt").exists(), "precondition: the file is not here yet");

        let app_data = unique_root("ff-appdata");
        let landed =
            land_branch_at(&root, "a1", None, Some(&wt), "sparkle/agent-a1", &cloud, &app_data)
                .unwrap();

        assert_eq!(landed.worktree, wt);
        assert!(!landed.created, "an existing worktree was fast-forwarded, not cut");
        assert_eq!(landed.head_sha, cloud);
        // The work is REALLY here — on disk, in the working tree, not merely referenced by a ref.
        assert_eq!(
            std::fs::read_to_string(Path::new(&wt).join("cloud.txt")).unwrap(),
            "from the cloud\n"
        );
        assert_eq!(head_sha(&wt), cloud, "the worktree's HEAD moved");
        assert_ne!(head_sha(&wt), before);
        // …and the branch is still the branch, not a detached checkout of the remote ref.
        assert_eq!(
            git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(),
            "sparkle/agent-a1"
        );
    }

    /// The refusal that matters most. It must NAME the files, and — the side effect that proves it
    /// refused rather than merged — leave the tree exactly as it found it.
    #[test]
    fn land_refuses_a_dirty_worktree_and_names_the_files() {
        let (root, bare) = init_repo_with_origin("dirty");
        let wt = promoted_worktree(&root, "dirty", "sparkle/agent-a1");
        let cloud = cloud_commits(&bare, "dirty", "sparkle/agent-a1", "cloud.txt", false);
        let before = head_sha(&wt);
        std::fs::write(Path::new(&wt).join("README.md"), "local edit\n").unwrap();
        std::fs::write(Path::new(&wt).join("notes.txt"), "local only\n").unwrap();

        let app_data = unique_root("dirty-appdata");
        let err =
            land_branch_at(&root, "a1", None, Some(&wt), "sparkle/agent-a1", &cloud, &app_data)
                .unwrap_err();

        assert_eq!(err, "dirty:README.md,notes.txt", "the refusal names what is at risk");
        // NOTHING was merged, reset or stashed: HEAD is where it was, the cloud file never arrived,
        // and the user's uncommitted bytes are still on disk.
        assert_eq!(head_sha(&wt), before, "no ref moved");
        assert!(!Path::new(&wt).join("cloud.txt").exists(), "the cloud commit was NOT merged in");
        assert_eq!(
            std::fs::read_to_string(Path::new(&wt).join("README.md")).unwrap(),
            "local edit\n",
            "the local edit survives — destroying it is the failure this feature prevents"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&wt).join("notes.txt")).unwrap(),
            "local only\n"
        );
        assert!(git(&wt, &["stash", "list"]).unwrap().trim().is_empty(), "nothing was stashed");
    }

    #[test]
    fn land_caps_the_dirty_file_list_at_fifty_names() {
        let (root, bare) = init_repo_with_origin("cap");
        let wt = promoted_worktree(&root, "cap", "sparkle/agent-a1");
        let cloud = cloud_commits(&bare, "cap", "sparkle/agent-a1", "cloud.txt", false);
        for i in 0..60 {
            std::fs::write(Path::new(&wt).join(format!("f{i:02}.txt")), "x\n").unwrap();
        }

        let app_data = unique_root("cap-appdata");
        let err =
            land_branch_at(&root, "a1", None, Some(&wt), "sparkle/agent-a1", &cloud, &app_data)
                .unwrap_err();
        let names: Vec<&str> = err.strip_prefix("dirty:").unwrap().split(',').collect();
        assert_eq!(names.len(), DIRTY_FILES_CAP, "the dialog's list is bounded");
    }

    /// Local commits origin has never seen. A fast-forward is impossible, and a plain `merge` or a
    /// `reset --hard` would be the data loss this whole feature exists to prevent.
    #[test]
    fn land_refuses_a_diverged_worktree_without_touching_the_local_commit() {
        let (root, bare) = init_repo_with_origin("div");
        let wt = promoted_worktree(&root, "div", "sparkle/agent-a1");
        let cloud = cloud_commits(&bare, "div", "sparkle/agent-a1", "cloud.txt", false);
        // The local agent committed too, on the same branch, after the push.
        std::fs::write(Path::new(&wt).join("local.txt"), "local work\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["commit", "-q", "-m", "local work"]).unwrap();
        let local_head = head_sha(&wt);

        let app_data = unique_root("div-appdata");
        let err =
            land_branch_at(&root, "a1", None, Some(&wt), "sparkle/agent-a1", &cloud, &app_data)
                .unwrap_err();

        assert_eq!(err, "diverged");
        assert_eq!(head_sha(&wt), local_head, "the local commit is still the tip");
        assert_eq!(
            std::fs::read_to_string(Path::new(&wt).join("local.txt")).unwrap(),
            "local work\n"
        );
        assert!(!Path::new(&wt).join("cloud.txt").exists(), "no merge happened");
        assert!(
            git(&wt, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).is_err(),
            "no merge was even started"
        );
    }

    #[test]
    fn land_refuses_when_there_is_no_origin_to_bring_anything_down_from() {
        let root = init_repo_no_origin("noremote");
        let wt = unique_root("noremote-wt");
        let wt_str = wt.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&wt);
        git(&root, &["worktree", "add", "-q", "-b", "sparkle/agent-a1", &wt_str, "main"]).unwrap();
        let before = head_sha(&wt_str);

        let app_data = unique_root("noremote-appdata");
        let err = land_branch_at(
            &root,
            "a1",
            None,
            Some(&wt_str),
            "sparkle/agent-a1",
            "0000000000000000000000000000000000000000",
            &app_data,
        )
        .unwrap_err();

        assert_eq!(err, "no-remote");
        assert_eq!(head_sha(&wt_str), before, "a refusal changes nothing");
    }

    /// A born-in-the-cloud agent: the branch exists ONLY on origin, and there is no local worktree.
    /// The side effect is a real directory on disk, cut at the layout `worktree_path` defines.
    #[test]
    fn land_cuts_a_fresh_worktree_for_an_agent_that_never_had_one() {
        let (root, bare) = init_repo_with_origin("fresh");
        let branch = "sparkle/agent-cloudborn";
        let cloud = cloud_commits(&bare, "fresh", branch, "cloud.txt", true);
        assert!(
            git(&root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
                .is_err(),
            "precondition: nothing local knows this branch"
        );

        let app_data = unique_root("fresh-appdata");
        let landed =
            land_branch_at(&root, "cloudborn", Some("proj-1"), None, branch, &cloud, &app_data)
                .unwrap();

        assert!(landed.created, "this one was CUT, and the caller is told so");
        // The path is the shared layout's, not a second one invented here.
        let expected = crate::worktree::worktree_path(&app_data, "proj-1", "cloudborn").unwrap();
        assert_eq!(landed.worktree, expected.to_string_lossy());
        assert!(expected.is_dir(), "the worktree really exists on disk");
        assert_eq!(
            std::fs::read_to_string(expected.join("cloud.txt")).unwrap(),
            "from the cloud\n",
            "the cloud's work is checked out locally"
        );
        assert_eq!(head_sha(&landed.worktree), cloud);
        assert_eq!(
            git(&landed.worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(),
            branch,
            "on the branch, not a detached checkout of the remote ref"
        );
    }

    #[test]
    fn land_refuses_to_cut_a_worktree_without_a_project_id() {
        let (root, bare) = init_repo_with_origin("noproj");
        let branch = "sparkle/agent-cloudborn";
        let cloud = cloud_commits(&bare, "noproj", branch, "cloud.txt", true);

        let app_data = unique_root("noproj-appdata");
        let err = land_branch_at(&root, "cloudborn", None, None, branch, &cloud, &app_data)
            .unwrap_err();
        assert!(err.starts_with("worktree-failed:"), "classifiable, not a raw git error: {err}");
        assert!(
            !app_data.join("worktrees").exists(),
            "a refusal leaves no half-built layout behind"
        );
    }

    /// The sandbox moved after the handoff pushed. The landing DID happen — that is honest, the
    /// bytes are here — but the caller must not cut the sandbox on it, so it is an `Err` carrying
    /// the sha we actually have.
    #[test]
    fn land_reports_sha_mismatch_when_head_is_not_what_the_caller_expected() {
        let (root, bare) = init_repo_with_origin("mismatch");
        let wt = promoted_worktree(&root, "mismatch", "sparkle/agent-a1");
        let cloud = cloud_commits(&bare, "mismatch", "sparkle/agent-a1", "cloud.txt", false);
        let stale = "1111111111111111111111111111111111111111";

        let app_data = unique_root("mismatch-appdata");
        let err =
            land_branch_at(&root, "a1", None, Some(&wt), "sparkle/agent-a1", stale, &app_data)
                .unwrap_err();

        assert_eq!(err, format!("sha-mismatch:{cloud}"), "the ACTUAL sha travels with the refusal");
        assert_eq!(head_sha(&wt), cloud, "the landing itself really happened");
    }

    #[test]
    fn land_refuses_a_worktree_parked_on_another_branch() {
        let (root, bare) = init_repo_with_origin("parked");
        let wt = promoted_worktree(&root, "parked", "sparkle/agent-a1");
        let cloud = cloud_commits(&bare, "parked", "sparkle/agent-a1", "cloud.txt", false);
        git(&wt, &["checkout", "-q", "--detach", "HEAD"]).unwrap();
        let before = head_sha(&wt);

        let app_data = unique_root("parked-appdata");
        let err =
            land_branch_at(&root, "a1", None, Some(&wt), "sparkle/agent-a1", &cloud, &app_data)
                .unwrap_err();

        assert!(err.starts_with("worktree-failed:"), "{err}");
        assert_eq!(head_sha(&wt), before, "cloud work must not land on a tree parked elsewhere");
        assert!(!Path::new(&wt).join("cloud.txt").exists());
    }

    /// A refspec smuggled in as a branch name would make `git fetch` overwrite a LOCAL ref. The
    /// side effect asserted is the absence of that overwrite.
    #[test]
    fn land_refuses_a_branch_name_shaped_like_a_refspec() {
        let (root, _bare) = init_repo_with_origin("refspec");
        let main_before = git(&root, &["rev-parse", "refs/heads/main"]).unwrap();
        let app_data = unique_root("refspec-appdata");

        for evil in ["+refs/heads/main:refs/heads/main", "--upload-pack=touch", "a:b"] {
            let err = land_branch_at(
                &root,
                "a1",
                Some("p"),
                None,
                evil,
                "1111111111111111111111111111111111111111",
                &app_data,
            )
            .unwrap_err();
            assert!(err.starts_with("worktree-failed:"), "{evil} -> {err}");
        }
        assert_eq!(
            git(&root, &["rev-parse", "refs/heads/main"]).unwrap(),
            main_before,
            "no local ref was clobbered"
        );
    }

    #[test]
    fn land_refuses_without_a_baseline_sha_before_touching_anything() {
        let (root, bare) = init_repo_with_origin("nobase");
        let wt = promoted_worktree(&root, "nobase", "sparkle/agent-a1");
        cloud_commits(&bare, "nobase", "sparkle/agent-a1", "cloud.txt", false);
        let before = head_sha(&wt);

        let app_data = unique_root("nobase-appdata");
        let err = land_branch_at(&root, "a1", None, Some(&wt), "sparkle/agent-a1", "  ", &app_data)
            .unwrap_err();
        assert!(err.starts_with("worktree-failed:"), "{err}");
        assert_eq!(head_sha(&wt), before, "an unguarded landing must not happen at all");
        assert!(!Path::new(&wt).join("cloud.txt").exists());
    }

    // ── transcript ──────────────────────────────────────────────────────────────────────────────

    fn projects_file(cfg: &Path, worktree: &str, session: &str) -> PathBuf {
        cfg.join("projects")
            .join(crate::claude::encode_project_slug(worktree))
            .join(format!("{session}.jsonl"))
    }

    /// THE inverse test. Promotion's rewrite carries `cwd` UP to the sandbox; this one carries it
    /// back DOWN. Composed, they must be the identity — including for a worktree path with a SPACE
    /// in it, which is the shape that broke the slug rule once already.
    #[test]
    fn the_two_cwd_rewrites_are_exact_inverses() {
        let wt = "/wt/Application Support/demote round trip";
        let originals = [
            format!(
                r#"{{"type":"user","cwd":"{wt}","message":{{"role":"user","content":"see {wt}/src/x.ts"}}}}"#
            ),
            format!(r#"{{"type":"assistant","cwd":"{wt}","i":2}}"#),
            r#"{"type":"summary","cwd":"/somewhere/else","i":3}"#.to_string(),
        ];

        // Up: seed a real transcript where Claude Code would put one, and read it as promotion does.
        let cfg_up = unique_root("rt-up");
        let dir_up = cfg_up.join("projects").join(crate::claude::encode_project_slug(wt));
        std::fs::create_dir_all(&dir_up).unwrap();
        let body: String = originals.iter().map(|r| format!("{r}\n")).collect();
        std::fs::write(dir_up.join("9f1c8a2b-sess.jsonl"), &body).unwrap();

        let up = crate::promotion::read_transcript_at(
            wt,
            Some(cfg_up.to_str().unwrap()),
            SANDBOX,
            1 << 20,
        )
        .unwrap();
        // Guard against a VACUOUS round trip: if neither direction rewrote anything, composing them
        // would be the identity for free and prove nothing.
        let mid: Value = serde_json::from_str(up.jsonl.lines().next().unwrap()).unwrap();
        assert_eq!(mid["cwd"], SANDBOX, "the upward rewrite really moved the field");

        // Down: write it back onto a *different* machine's config dir.
        let cfg_down = unique_root("rt-down");
        let n = write_transcript_at(
            wt,
            Some(cfg_down.to_str().unwrap()),
            &up.session_id,
            &up.jsonl,
            SANDBOX,
        )
        .unwrap();
        assert_eq!(n, 3);

        let back = std::fs::read_to_string(projects_file(&cfg_down, wt, &up.session_id)).unwrap();
        let got: Vec<Value> =
            back.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let want: Vec<Value> =
            originals.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(got, want, "promotion's rewrite and this one must be exact inverses");
    }

    /// The anti-blind-replace assertion for THIS direction: the sandbox path inside message text is
    /// a historical statement and must survive verbatim, even though the `cwd` field moves.
    #[test]
    fn write_rewrites_the_cwd_field_but_not_the_same_path_in_a_message() {
        let wt = "/wt/demote-msg";
        let line = format!(
            r#"{{"type":"user","cwd":"{SANDBOX}","message":{{"role":"user","content":"see {SANDBOX}/src/x.ts"}}}}"#
        );
        let cfg = unique_root("msg");

        assert_eq!(
            write_transcript_at(wt, Some(cfg.to_str().unwrap()), "sess-1", &format!("{line}\n"), SANDBOX)
                .unwrap(),
            1
        );
        let back = std::fs::read_to_string(projects_file(&cfg, wt, "sess-1")).unwrap();
        let v: Value = serde_json::from_str(back.trim()).unwrap();
        assert_eq!(v["cwd"], wt, "the FIELD came home");
        assert_eq!(
            v["message"]["content"], "see /home/user/repo/src/x.ts",
            "the message text is history and must be left alone"
        );
    }

    #[test]
    fn write_leaves_a_record_whose_cwd_is_not_the_sandbox_alone() {
        let wt = "/wt/demote-other";
        let line = r#"{"type":"user","cwd":"/some/other/box","i":1}"#;
        let cfg = unique_root("other");
        write_transcript_at(wt, Some(cfg.to_str().unwrap()), "sess-1", &format!("{line}\n"), SANDBOX)
            .unwrap();
        let back = std::fs::read_to_string(projects_file(&cfg, wt, "sess-1")).unwrap();
        assert_eq!(back.trim(), line, "another box's cwd is not ours to rewrite");
    }

    #[test]
    fn write_passes_a_non_json_line_through_instead_of_dropping_a_turn() {
        let wt = "/wt/demote-badline";
        let cfg = unique_root("badline");
        let body = format!("not json at all\n{{\"cwd\":\"{SANDBOX}\",\"i\":1}}\n");
        assert_eq!(
            write_transcript_at(wt, Some(cfg.to_str().unwrap()), "sess-1", &body, SANDBOX).unwrap(),
            2
        );
        let back = std::fs::read_to_string(projects_file(&cfg, wt, "sess-1")).unwrap();
        assert!(back.starts_with("not json at all\n"), "kept verbatim: {back}");
    }

    /// The session id becomes a filename, and it comes off a machine we do not control.
    #[test]
    fn write_refuses_a_session_id_that_is_not_a_plain_token_and_writes_nothing() {
        let wt = "/wt/demote-evil";
        let cfg = unique_root("evil");
        let body = format!("{{\"cwd\":\"{SANDBOX}\",\"i\":1}}\n");
        for evil in ["../../../etc/passwd", "a/b", "..", "sess.jsonl", "", "-rf"] {
            let err = write_transcript_at(wt, Some(cfg.to_str().unwrap()), evil, &body, SANDBOX)
                .unwrap_err();
            assert!(err.starts_with("invalid session id"), "{evil} -> {err}");
        }
        assert!(!cfg.join("projects").exists(), "nothing was created anywhere");
    }

    #[test]
    fn write_refuses_an_empty_transcript_rather_than_leaving_an_unresumable_file() {
        let wt = "/wt/demote-empty";
        let cfg = unique_root("empty");
        assert!(write_transcript_at(wt, Some(cfg.to_str().unwrap()), "sess-1", "\n \n", SANDBOX)
            .is_err());
        assert!(!projects_file(&cfg, wt, "sess-1").exists(), "no zero-record transcript on disk");
    }

    /// A re-run of a demotion whose transcript step already ran must land the NEW bytes, and must
    /// never leave the temp file behind for Claude Code's directory scan to trip over.
    #[test]
    fn write_replaces_an_existing_transcript_and_leaves_no_temp_file() {
        let wt = "/wt/demote-again";
        let cfg = unique_root("again");
        let first = format!("{{\"cwd\":\"{SANDBOX}\",\"i\":1}}\n");
        let second = format!("{{\"cwd\":\"{SANDBOX}\",\"i\":1}}\n{{\"cwd\":\"{SANDBOX}\",\"i\":2}}\n");
        write_transcript_at(wt, Some(cfg.to_str().unwrap()), "sess-1", &first, SANDBOX).unwrap();
        assert_eq!(
            write_transcript_at(wt, Some(cfg.to_str().unwrap()), "sess-1", &second, SANDBOX).unwrap(),
            2
        );

        let path = projects_file(&cfg, wt, "sess-1");
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 2);
        let dir = path.parent().unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(""))
            .collect();
        assert!(leftovers.is_empty(), "the atomic write cleaned up after itself: {leftovers:?}");
    }
}

//! Local → cloud agent PROMOTION — the Rust side (bead `sparkle-8zpvc`).
//!
//! Design: `docs/superpowers/specs/2026-07-31-agent-promotion-design.md`.
//! Pinned contract: `docs/superpowers/plans/2026-07-31-agent-promotion.md` §C.
//!
//! Promotion is a COPY, THEN A CUT: everything here runs while the local agent is still alive, and
//! nothing in this module can kill it. That shapes each command's failure contract —
//!
//! | command                     | mutates                    | failure leaves                       |
//! |-----------------------------|----------------------------|--------------------------------------|
//! | `promotion_preflight`       | nothing (READ-ONLY)        | the local agent exactly as it was    |
//! | `promotion_commit_dirty`    | one WIP commit, or nothing | a tree that never got a commit       |
//! | `promotion_push_branch`     | `origin/<branch>`          | the WIP commit, still local          |
//! | `promotion_read_transcript` | nothing                    | `None` — promotion continues without |
//!
//! `promotion_read_transcript` returns `Option`, not `Result`, on purpose: "this agent has no
//! transcript yet" is a normal, expected state (a freshly spawned agent), and spec Decision 2 says
//! promotion proceeds without the conversation rather than refusing.
//!
//! Two rules this module REUSES rather than re-deriving, because a second copy of either is a bug
//! that has already shipped once:
//!   * the `~/.claude/projects/<slug>/` layout → `crate::claude::claude_latest_session_path_sync`
//!     (a re-derived slug is how the space-in-"Application Support" bug came back);
//!   * the agent-branch resolution ladder → `crate::worktree::resolve_agent_branch` (a minted
//!     `sparkle/agent-<id>` is only the FIRST rung; a renamed branch resolves on the third).

use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};

use crate::worktree::git;

/// How many porcelain paths preflight hands to the UI. The confirm dialog lists them, so the cap
/// bounds the dialog, not the truth: `dirty_count` stays the real total so the UI can say
/// "…and 37 more" instead of quietly under-reporting what the WIP commit is about to sweep up.
/// How many porcelain paths the PREFLIGHT previews. Far larger than
/// [`crate::worktree::STATUS_DIRTY_FILES_CAP`] on purpose: this is a one-shot read of a single agent
/// the user is actively promoting, not a per-agent field on the 30s batch poll.
pub(crate) const DIRTY_FILES_CAP: usize = 50;

/// Everything the promote dialog needs to decide, gathered WITHOUT changing a thing.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromotionPreflight {
    /// Resolved through the same ladder the status poll uses — NOT `format!("sparkle/agent-{id}")`.
    pub branch: String,
    pub branch_exists: bool,
    pub has_remote: bool,
    /// `git remote get-url origin`, verbatim, or None when there is no origin.
    ///
    /// The plan compares this (normalised) against the URL the SANDBOX will clone, and refuses
    /// `remote_mismatch` when they differ. They can differ: we push to the LOCAL origin while the
    /// sandbox clones the URL the request carries, so a fork whose origin is your copy, or an SSH
    /// remote for a different repo, means `git clone --branch <branch>` finds no such branch. And
    /// because `runner.startSession` is fire-and-forget, that would surface only as an await-live
    /// timeout — long after the WIP commit and the push already happened.
    pub origin_url: Option<String>,
    /// The worktree's HEAD sha at preflight. Reported for completeness; it is explicitly NOT the
    /// cutover guard's baseline (the WIP commit moves HEAD right after this, so a guard against
    /// this value would refuse every promotion that committed anything). The baseline is the sha
    /// [`push_branch_at`] returns. See [`head_sha_at`].
    pub head_sha: String,
    pub detached: bool,
    /// Porcelain paths, capped at [`DIRTY_FILES_CAP`].
    pub dirty_files: Vec<String>,
    /// TRUE total — may exceed `dirty_files.len()`.
    pub dirty_count: u32,
    /// Commits on the branch that are on NO origin ref (so a never-pushed branch reports all).
    pub unpushed: u32,
}

/// A transferable tail of the agent's Claude Code conversation.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromotionTranscript {
    /// The transcript file's stem — what `claude --resume <id>` wants.
    pub session_id: String,
    /// WHOLE JSONL records, newline-terminated, `cwd` already rewritten to the sandbox path.
    pub jsonl: String,
    /// True when any record was dropped from the HEAD of the file (oldest turns lost).
    pub truncated: bool,
    /// Byte length of `jsonl` as returned.
    pub bytes: u64,
    /// Number of records in `jsonl`.
    pub records: u32,
}

/// Parse `git status --porcelain` into (capped paths, TRUE total).
///
/// DELEGATES to [`crate::worktree::parse_porcelain_capped`] — this used to be a second copy of that
/// parser, which is precisely the shape this codebase keeps getting bitten by: both copies have to
/// know that [`git`] trims the whole capture (so the first line loses its leading status space) and
/// that a rename reads `R old -> new`. One of them would eventually not.
fn parse_porcelain(out: &str) -> (Vec<String>, u32) {
    crate::worktree::parse_porcelain_capped(out, DIRTY_FILES_CAP)
}

/// The worktree's HEAD branch, plus whether it is DETACHED. Read once and used for both, since
/// detachment is exactly the case where there is no branch name to report.
fn head_branch_and_detached(worktree: &str) -> (String, bool) {
    match git(worktree, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        // git names a detached HEAD with the literal string "HEAD", which is no branch at all.
        Ok(h) if h.trim() == "HEAD" => (String::new(), true),
        Ok(h) => (h.trim().to_string(), false),
        // Missing worktree / unborn HEAD: no branch, and not detached either.
        Err(_) => (String::new(), false),
    }
}

/// Core (testable) of [`promotion_preflight`]. Reads only — no ref, index or file is written.
pub fn preflight_at(
    root: &str,
    agent_id: &str,
    worktree: &str,
    base_branch: &str,
) -> Result<PromotionPreflight, String> {
    let (head, detached) = head_branch_and_detached(worktree);
    let (branch, _on_branch) = crate::worktree::resolve_agent_branch(root, &head, agent_id, base_branch);

    let branch_exists = !branch.trim().is_empty()
        && git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    // One call, both answers: the URL IS the has-remote evidence, so reading them separately would
    // let them disagree (a remote that exists but whose URL we failed to read).
    let origin_url = git(root, &["remote", "get-url", "origin"])
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let has_remote = origin_url.is_some();
    let head_sha = head_sha_at(worktree).unwrap_or_default();

    let (dirty_files, dirty_count) = match git(worktree, &["status", "--porcelain"]) {
        Ok(out) => parse_porcelain(&out),
        // An unreadable worktree is not a dirty one; the caller's `no_worktree` refusal covers it.
        Err(_) => (Vec::new(), 0),
    };

    // `--not --remotes=origin` (not `origin/<branch>`): a NEVER-pushed branch has no upstream ref to
    // subtract, and asking for one would error out to 0 — the exact case that most needs a push.
    let unpushed = if branch_exists {
        git(root, &["rev-list", "--count", &branch, "--not", "--remotes=origin"])
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0)
    } else {
        0
    };

    Ok(PromotionPreflight {
        branch,
        branch_exists,
        has_remote,
        origin_url,
        head_sha,
        detached,
        dirty_files,
        dirty_count,
        unpushed,
    })
}

/// Core (testable) of [`promotion_head_sha`]: the worktree's current HEAD sha.
///
/// Called a SECOND time immediately before the cut, and compared against the sha
/// [`push_branch_at`] reported. The local Claude keeps running through the entire copy window, so
/// it can commit after the push — and that work would exist only locally while the sandbox resumed
/// from a ref without it. That is the "silently dropped work" failure the whole feature is designed
/// against, relocated to a later step; comparing here turns an assumed-short window into a detected
/// condition (spec §"the LOCAL agent is running").
pub fn head_sha_at(worktree: &str) -> Result<String, String> {
    git(worktree, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string())
}

/// The worktree's current HEAD sha — the cutover guard's second reading.
#[tauri::command]
pub async fn promotion_head_sha(worktree: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || head_sha_at(&worktree))
        .await
        .map_err(|e| format!("promotion_head_sha task failed: {e}"))?
}

/// Everything the promote dialog needs, read without mutating anything.
#[tauri::command]
pub async fn promotion_preflight(
    root: String,
    agent_id: String,
    worktree: String,
    base_branch: String,
) -> Result<PromotionPreflight, String> {
    tauri::async_runtime::spawn_blocking(move || {
        preflight_at(&root, &agent_id, &worktree, &base_branch)
    })
    .await
    .map_err(|e| format!("promotion_preflight task failed: {e}"))?
}

/// Core (testable) of [`promotion_commit_dirty`]: `git add -A && git commit -m <message>` IN THE
/// WORKTREE. Returns the number of files committed.
///
/// A clean tree returns `Ok(0)` and makes NO commit, so the caller may call this unconditionally
/// (that is the point — the dirty-policy branch lives in the UI, not in a second call site). Never
/// `--allow-empty`: an empty commit on the branch we are about to push would be a fabricated
/// history entry, and the "0 files" answer already tells the caller nothing happened.
pub fn commit_dirty_at(worktree: &str, message: &str) -> Result<u32, String> {
    let status = git(worktree, &["status", "--porcelain"])?;
    if status.trim().is_empty() {
        return Ok(0);
    }

    git(worktree, &["add", "-A"])?;

    // Count what is ACTUALLY staged against HEAD rather than reusing the porcelain count: `add -A`
    // can stage fewer entries than status listed (a modification reverted between the two reads),
    // and a count that outruns the commit would be reported to the user as work that traveled.
    let staged = git(worktree, &["diff", "--cached", "--name-only"])?;
    let files = staged.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    if files == 0 {
        return Ok(0); // raced clean between the two reads — still no empty commit
    }

    git(worktree, &["commit", "-m", message])?;
    Ok(files)
}

/// `git add -A && git commit -m <message>` in the worktree. `Ok(0)` — and no commit — if clean.
#[tauri::command]
pub async fn promotion_commit_dirty(worktree: String, message: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || commit_dirty_at(&worktree, &message))
        .await
        .map_err(|e| format!("promotion_commit_dirty task failed: {e}"))?
}

/// Core (testable) of [`promotion_push_branch`]: `git push -u origin <branch>` from `root`.
///
/// Mirrors `worktree::push_agent_branch_at`'s outcomes but takes the RESOLVED branch instead of an
/// agent id, because promotion has already run the resolution ladder in preflight and a renamed
/// branch must not be re-minted here.
///
/// Returns **`"pushed:<sha>"`** — the sha now on `refs/remotes/origin/<branch>`, i.e. exactly what
/// the sandbox will clone — or `"no-remote"`, or `Err("no-branch")`.
///
/// The sha is an OUTPUT, deliberately, and not something the caller re-reads locally afterwards.
/// The local Claude runs through that window too, so a commit landing between the push completing
/// and a local HEAD read would be baked into the baseline; the cutover comparison would then find
/// its two readings equal and cut anyway, with the sandbox resuming from a ref that lacks the
/// commit. HEAD-vs-HEAD detects only MOVEMENT; this value is what detects DIVERGENCE from the
/// remote (roborev 57383).
///
/// A `"no-remote"` answer is a FAILURE for the caller, not a pass: it means the push did not
/// happen, and advancing to `start` on it would clone an absent or stale ref.
pub fn push_branch_at(root: &str, branch: &str) -> Result<String, String> {
    if git(root, &["remote", "get-url", "origin"]).is_err() {
        return Ok("no-remote".to_string());
    }
    if branch.trim().is_empty()
        || git(root, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")]).is_err()
    {
        return Err("no-branch".to_string());
    }
    git(root, &["push", "-u", "origin", branch])?;
    // Read the REMOTE-TRACKING ref, which `push` has just updated — not the local branch. They are
    // the same commit on a successful push, but only one of them is a statement about the remote,
    // and this value's whole job is to be that statement.
    let sha = git(root, &["rev-parse", &format!("refs/remotes/origin/{branch}")])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if sha.is_empty() {
        return Err(format!("push succeeded but origin/{branch} could not be resolved"));
    }
    Ok(format!("pushed:{sha}"))
}

/// Push the agent's branch so the sandbox has something to clone.
/// `"pushed:<sha>"` | `"no-remote"`.
#[tauri::command]
pub async fn promotion_push_branch(root: String, branch: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || push_branch_at(&root, &branch))
        .await
        .map_err(|e| format!("promotion_push_branch task failed: {e}"))?
}

/// Two paths naming the same directory, ignoring a trailing separator.
fn same_dir(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

/// Rewrite ONE record's top-level `cwd` from `worktree` to `sandbox_cwd`.
///
/// Parsed as JSON rather than string-replaced across the file on purpose. A blind replace would
/// also rewrite the worktree path where it appears inside message TEXT — "see /Users/…/x.ts" — and
/// that is a different fact: the message really did say that path, and spec Decision 2 lists stale
/// in-message paths as a known, accepted loss. Only the `cwd` FIELD keys Claude Code's project
/// slug, so only the field moves.
///
/// A line that does not parse as JSON is returned unchanged rather than dropped: a transcript may
/// be mid-write, and passing an odd line through costs nothing while dropping it silently loses a
/// turn. Serialization is skipped entirely when nothing changed, so untouched records keep their
/// exact original bytes.
fn rewrite_cwd(line: &str, worktree: &str, sandbox_cwd: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(line) else {
        return line.to_string();
    };
    let Some(obj) = value.as_object_mut() else {
        return line.to_string();
    };
    let matches_worktree = obj.get("cwd").and_then(Value::as_str).is_some_and(|c| same_dir(c, worktree));
    if !matches_worktree {
        return line.to_string();
    }
    obj.insert("cwd".to_string(), Value::String(sandbox_cwd.to_string()));
    serde_json::to_string(&value).unwrap_or_else(|_| line.to_string())
}

/// Keep the LAST records whose total serialized size fits `max_bytes`, never splitting one.
///
/// Returns (kept, dropped_any). Each record costs `len + 1` — its own newline — which is exactly
/// what the joined output will weigh, so `bytes` can never disagree with the string we hand back.
/// When even the last record alone exceeds the cap we return that one record rather than nothing:
/// an over-cap tail is a truncated conversation, but an empty one is a LOST conversation, and the
/// caller can only tell the user about the loss it is told about.
fn tail_records(records: &[String], max_bytes: u64) -> (Vec<String>, bool) {
    let mut kept: Vec<String> = Vec::new();
    let mut total: u64 = 0;
    for rec in records.iter().rev() {
        let cost = rec.len() as u64 + 1;
        if total + cost > max_bytes {
            if kept.is_empty() {
                kept.push(rec.clone()); // the single-oversize-record floor
            }
            break;
        }
        kept.push(rec.clone());
        total += cost;
    }
    kept.reverse();
    let dropped = kept.len() < records.len();
    (kept, dropped)
}

/// Core (testable) of [`promotion_read_transcript`].
pub fn read_transcript_at(
    worktree: &str,
    config_dir: Option<&str>,
    sandbox_cwd: &str,
    max_bytes: u64,
) -> Option<PromotionTranscript> {
    let path = crate::claude::claude_latest_session_path_sync(worktree, config_dir)?;
    let path = std::path::PathBuf::from(path);
    let session_id = path.file_stem()?.to_string_lossy().into_owned();

    // Bound what we read from a pathological multi-hundred-MB transcript. The window is deliberately
    // wider than the cap: the cwd rewrite usually SHRINKS records (a long `/Users/…/worktrees/<uuid>`
    // becomes `/home/user/repo`), so more source bytes than `max_bytes` can legitimately fit in the
    // answer. Anything before the window is older than the tail could ever reach.
    let len = std::fs::metadata(&path).ok()?.len();
    let window = max_bytes.saturating_mul(2).saturating_add(64 * 1024);
    let (start, seeked) = if len > window { (len - window, true) } else { (0, false) };

    let mut file = std::fs::File::open(&path).ok()?;
    if seeked {
        file.seek(SeekFrom::Start(start)).ok()?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);

    let mut lines: Vec<&str> = text.lines().collect();
    if seeked && !lines.is_empty() {
        lines.remove(0); // we landed mid-record; that fragment is not a whole JSONL record
    }

    let records: Vec<String> = lines
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| rewrite_cwd(l, worktree, sandbox_cwd))
        .collect();
    if records.is_empty() {
        return None;
    }

    let (kept, dropped) = tail_records(&records, max_bytes);
    let mut jsonl = kept.join("\n");
    jsonl.push('\n');
    Some(PromotionTranscript {
        session_id,
        bytes: jsonl.len() as u64,
        records: kept.len() as u32,
        truncated: dropped || seeked,
        jsonl,
    })
}

/// The newest Claude transcript for `worktree`, tail-capped on WHOLE records and rewritten for the
/// sandbox. `None` when there is none or it cannot be read — an expected state, not an error.
#[tauri::command]
pub async fn promotion_read_transcript(
    worktree: String,
    config_dir: Option<String>,
    sandbox_cwd: String,
    max_bytes: u64,
) -> Option<PromotionTranscript> {
    tauri::async_runtime::spawn_blocking(move || {
        read_transcript_at(&worktree, config_dir.as_deref(), &sandbox_cwd, max_bytes)
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn unique_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sparkle-promo-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A repo on `main` with one real commit (not `--allow-empty`, so a worktree can be cut and
    /// files can be modified).
    fn init_repo(tag: &str) -> String {
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

    /// Give `root` a real bare `origin` with `main` already pushed. Returns the bare repo's path.
    fn add_origin(root: &str, tag: &str) -> String {
        let bare = unique_root(&format!("{tag}-origin"));
        let bare_str = bare.to_string_lossy().to_string();
        git(&bare_str, &["init", "-q", "--bare"]).unwrap();
        git(root, &["remote", "add", "origin", &bare_str]).unwrap();
        git(root, &["push", "-q", "origin", "main"]).unwrap();
        bare_str
    }

    /// A linked worktree on a NEW branch cut from `main`.
    fn worktree_on_new_branch(root: &str, tag: &str, branch: &str) -> String {
        let wt = unique_root(&format!("{tag}-wt"));
        let wt_str = wt.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&wt); // `worktree add` insists on a non-existent path
        git(root, &["worktree", "add", "-q", "-b", branch, &wt_str, "main"]).unwrap();
        wt_str
    }

    fn commit_count(cwd: &str) -> u32 {
        git(cwd, &["rev-list", "--count", "HEAD"]).unwrap().trim().parse().unwrap()
    }

    fn head_files(cwd: &str) -> String {
        git(cwd, &["show", "--pretty=format:", "--name-only", "HEAD"]).unwrap()
    }

    // ── preflight ───────────────────────────────────────────────────────────────────────────────

    #[test]
    fn preflight_reports_a_clean_tree_and_the_unpushed_count() {
        let root = init_repo("clean");
        add_origin(&root, "clean");
        let wt = worktree_on_new_branch(&root, "clean", "sparkle/agent-a1");
        std::fs::write(Path::new(&wt).join("work.txt"), "done\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work"]).unwrap();

        let p = preflight_at(&root, "a1", &wt, "main").unwrap();
        assert_eq!(p.branch, "sparkle/agent-a1");
        assert!(p.branch_exists);
        assert!(p.has_remote);
        assert!(!p.detached);
        assert_eq!(p.dirty_count, 0, "committed tree is clean");
        assert!(p.dirty_files.is_empty());
        // Never pushed, so BOTH the seed commit's descendant and the work commit are unpushed —
        // `--not --remotes=origin` subtracts what origin already has (main), leaving exactly one.
        assert_eq!(p.unpushed, 1, "the branch's own commit is not on any origin ref");
    }

    #[test]
    fn preflight_lists_dirty_files_without_changing_anything() {
        let root = init_repo("dirty");
        let wt = worktree_on_new_branch(&root, "dirty", "sparkle/agent-a1");
        std::fs::write(Path::new(&wt).join("README.md"), "edited\n").unwrap();
        std::fs::write(Path::new(&wt).join("new.txt"), "fresh\n").unwrap();
        let before = commit_count(&wt);

        let p = preflight_at(&root, "a1", &wt, "main").unwrap();
        assert_eq!(p.dirty_count, 2);
        let mut files = p.dirty_files.clone();
        files.sort();
        assert_eq!(files, vec!["README.md".to_string(), "new.txt".to_string()]);
        // READ-ONLY: nothing committed, nothing staged, the files are still dirty afterwards.
        assert_eq!(commit_count(&wt), before, "preflight must not commit");
        assert!(git(&wt, &["diff", "--cached", "--name-only"]).unwrap().trim().is_empty(), "nothing staged");
        assert_eq!(git(&wt, &["status", "--porcelain"]).unwrap().lines().count(), 2, "still dirty");
    }

    #[test]
    fn preflight_caps_the_file_list_but_not_the_count() {
        let root = init_repo("cap");
        let wt = worktree_on_new_branch(&root, "cap", "sparkle/agent-a1");
        for i in 0..60 {
            std::fs::write(Path::new(&wt).join(format!("f{i:02}.txt")), "x\n").unwrap();
        }
        let p = preflight_at(&root, "a1", &wt, "main").unwrap();
        assert_eq!(p.dirty_files.len(), DIRTY_FILES_CAP, "the preview is bounded");
        assert_eq!(p.dirty_count, 60, "the count is the TRUTH, so the UI can say 'and 10 more'");
    }

    #[test]
    fn preflight_reports_no_remote_when_origin_is_absent() {
        let root = init_repo("no-remote");
        let wt = worktree_on_new_branch(&root, "no-remote", "sparkle/agent-a1");
        let p = preflight_at(&root, "a1", &wt, "main").unwrap();
        assert!(!p.has_remote, "a repo with no origin has nothing for a sandbox to clone");
        // With no origin refs at all, `--not --remotes=origin` subtracts nothing: the branch's whole
        // history is unpushed, which is the truth. Reporting 0 here would read as "already safe".
        assert_eq!(p.unpushed, 1, "every commit is unpushed when there is nowhere to push");
    }

    /// THE LADDER'S WHOLE POINT. The minted `sparkle/agent-<id>` ref does not exist; the work lives
    /// on a descriptively named branch. A preflight that minted the name would report a branch that
    /// cannot be pushed and cannot be cloned — i.e. it would promote the agent onto nothing.
    #[test]
    fn preflight_resolves_a_renamed_branch_instead_of_minting_one() {
        let root = init_repo("renamed");
        let wt = worktree_on_new_branch(&root, "renamed", "feature/whatever");
        assert!(
            git(&root, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-a1"]).is_err(),
            "precondition: the minted ref must NOT exist"
        );

        let p = preflight_at(&root, "a1", &wt, "main").unwrap();
        assert_eq!(p.branch, "feature/whatever");
        assert_ne!(p.branch, "sparkle/agent-a1", "minting the name here is the bug this guards");
        assert!(p.branch_exists, "the resolved branch is a real ref");
    }

    /// Rung 2 of the ladder: the minted ref EXISTS but the tree is parked elsewhere. Promotion still
    /// reports the agent's own branch — parking is not a rename.
    #[test]
    fn preflight_keeps_the_minted_branch_when_the_tree_is_parked() {
        let root = init_repo("parked");
        let wt = worktree_on_new_branch(&root, "parked", "sparkle/agent-a1");
        git(&wt, &["checkout", "-q", "-b", "some/other"]).unwrap();

        let p = preflight_at(&root, "a1", &wt, "main").unwrap();
        assert_eq!(p.branch, "sparkle/agent-a1", "the agent's own ref still exists");
    }

    #[test]
    fn preflight_flags_a_detached_head() {
        let root = init_repo("detached");
        let wt = unique_root("detached-wt");
        let wt_str = wt.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&wt);
        git(&root, &["worktree", "add", "-q", "--detach", &wt_str, "main"]).unwrap();

        let p = preflight_at(&root, "a1", &wt_str, "main").unwrap();
        assert!(p.detached, "a detached HEAD names no branch to push");
    }

    // ── commit_dirty ────────────────────────────────────────────────────────────────────────────

    /// Safe to call unconditionally: the assertion is on the COMMIT COUNT, not the return value —
    /// a `0` from a call that quietly made an empty commit would still be a lie.
    #[test]
    fn commit_dirty_on_a_clean_tree_makes_no_commit() {
        let root = init_repo("commit-clean");
        let wt = worktree_on_new_branch(&root, "commit-clean", "sparkle/agent-a1");
        let before = commit_count(&wt);
        let before_sha = git(&wt, &["rev-parse", "HEAD"]).unwrap();

        assert_eq!(commit_dirty_at(&wt, "Sparkle: WIP before cloud promotion").unwrap(), 0);
        assert_eq!(commit_count(&wt), before, "no commit may be created on a clean tree");
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]).unwrap(), before_sha, "HEAD did not move");
    }

    #[test]
    fn commit_dirty_puts_modified_and_untracked_files_into_head() {
        let root = init_repo("commit-dirty");
        let wt = worktree_on_new_branch(&root, "commit-dirty", "sparkle/agent-a1");
        std::fs::write(Path::new(&wt).join("README.md"), "edited\n").unwrap();
        std::fs::write(Path::new(&wt).join("untracked.txt"), "new\n").unwrap();
        let before = commit_count(&wt);

        let n = commit_dirty_at(&wt, "Sparkle: WIP before cloud promotion").unwrap();
        assert_eq!(n, 2);
        assert_eq!(commit_count(&wt), before + 1, "exactly one WIP commit");
        let files = head_files(&wt);
        assert!(files.contains("README.md"), "modified file is IN HEAD: {files}");
        assert!(files.contains("untracked.txt"), "untracked file is IN HEAD (add -A): {files}");
        assert!(git(&wt, &["status", "--porcelain"]).unwrap().trim().is_empty(), "tree is clean after");
        assert_eq!(
            git(&wt, &["log", "-1", "--pretty=%s"]).unwrap().trim(),
            "Sparkle: WIP before cloud promotion",
            "the message the dialog showed verbatim is the message that got used"
        );
    }

    // ── push_branch ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn push_branch_puts_the_branch_on_origin() {
        let root = init_repo("push");
        let bare = add_origin(&root, "push");
        let wt = worktree_on_new_branch(&root, "push", "feature/renamed");
        std::fs::write(Path::new(&wt).join("work.txt"), "done\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work"]).unwrap();
        assert!(
            git(&bare, &["rev-parse", "--verify", "--quiet", "refs/heads/feature/renamed"]).is_err(),
            "precondition: origin has no such ref yet"
        );

        let outcome = push_branch_at(&root, "feature/renamed").unwrap();
        // The SIDE EFFECT: the ref now exists in the remote, at the branch's tip.
        let remote_sha = git(&bare, &["rev-parse", "refs/heads/feature/renamed"]).unwrap();
        let local_sha = git(&root, &["rev-parse", "refs/heads/feature/renamed"]).unwrap();
        assert_eq!(remote_sha, local_sha, "the sandbox can clone exactly what the agent has");
        // And the outcome CARRIES that sha, because the cutover guard compares against it. A bare
        // "pushed" would force the caller to re-read HEAD locally, which cannot tell a branch that
        // moved after the push from one that didn't (roborev 57383).
        assert_eq!(outcome, format!("pushed:{}", remote_sha.trim()));
        // …and preflight now agrees there is nothing left to push.
        assert_eq!(preflight_at(&root, "a1", &wt, "main").unwrap().unpushed, 0);
    }

    // ── the cutover guard's two readings ────────────────────────────────────────────────────────

    #[test]
    fn pushed_sha_diverges_from_local_head_when_the_agent_commits_after_the_push() {
        // The whole reason the pushed sha is an OUTPUT. The local agent keeps working through the
        // copy window; a commit landing after the push must be DETECTABLE at the cut, or the
        // sandbox resumes from a ref that lacks it and the work is silently dropped.
        let root = init_repo("guard");
        add_origin(&root, "guard");
        let wt = worktree_on_new_branch(&root, "guard", "sparkle/agent-a1");
        std::fs::write(Path::new(&wt).join("a.txt"), "one\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["commit", "-q", "-m", "first"]).unwrap();

        let pushed = push_branch_at(&root, "sparkle/agent-a1").unwrap();
        let baseline = pushed.strip_prefix("pushed:").unwrap().to_string();
        assert_eq!(head_sha_at(&wt).unwrap(), baseline, "nothing has moved yet — the cut may proceed");

        // The local Claude commits during the copy window.
        std::fs::write(Path::new(&wt).join("b.txt"), "two\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["commit", "-q", "-m", "second"]).unwrap();

        assert_ne!(
            head_sha_at(&wt).unwrap(),
            baseline,
            "the guard must see the divergence and refuse to cut"
        );
    }

    #[test]
    fn head_sha_is_read_from_the_worktree_not_the_repo_root() {
        // The agent's commits land in ITS worktree, on its own branch, while the root stays on
        // main. A guard reading the root would compare the wrong tree and never fire.
        let root = init_repo("headsha");
        let wt = worktree_on_new_branch(&root, "headsha", "sparkle/agent-a1");
        std::fs::write(Path::new(&wt).join("w.txt"), "work\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["commit", "-q", "-m", "agent work"]).unwrap();

        assert_eq!(head_sha_at(&wt).unwrap(), git(&wt, &["rev-parse", "HEAD"]).unwrap().trim());
        assert_ne!(head_sha_at(&wt).unwrap(), head_sha_at(&root).unwrap());
    }

    // ── origin_url (the remote_mismatch input) ──────────────────────────────────────────────────

    #[test]
    fn preflight_reports_the_origin_url_so_a_mismatch_can_be_refused() {
        // We push to the LOCAL origin while the sandbox clones the URL the request carries. Without
        // this field the plan cannot compare them, and a fork or a mis-bound row fails only as an
        // await-live timeout — long after the WIP commit and the push.
        let root = init_repo("originurl");
        let bare = add_origin(&root, "originurl");
        let wt = worktree_on_new_branch(&root, "originurl", "sparkle/agent-a1");

        let pf = preflight_at(&root, "a1", &wt, "main").unwrap();
        assert_eq!(pf.origin_url.as_deref(), Some(bare.as_str()));
        assert!(pf.has_remote);
    }

    #[test]
    fn preflight_reports_no_origin_url_when_there_is_no_remote() {
        let root = init_repo("no-originurl");
        let wt = worktree_on_new_branch(&root, "no-originurl", "sparkle/agent-a1");

        let pf = preflight_at(&root, "a1", &wt, "main").unwrap();
        // None, not "" — the plan treats UNKNOWN as a refusal, and an empty string would compare
        // equal to another empty string and read as a match.
        assert_eq!(pf.origin_url, None);
        assert!(!pf.has_remote);
    }

    #[test]
    fn push_branch_reports_no_remote_rather_than_failing() {
        let root = init_repo("push-no-remote");
        worktree_on_new_branch(&root, "push-no-remote", "sparkle/agent-a1");
        assert_eq!(push_branch_at(&root, "sparkle/agent-a1").unwrap(), "no-remote");
    }

    #[test]
    fn push_branch_refuses_a_branch_that_does_not_exist() {
        let root = init_repo("push-missing");
        add_origin(&root, "push-missing");
        assert_eq!(push_branch_at(&root, "sparkle/agent-ghost").unwrap_err(), "no-branch");
    }

    // ── transcript ──────────────────────────────────────────────────────────────────────────────

    /// Seed a transcript where Claude Code would really put one, resolved through the SAME slug
    /// encoder the app uses — never a hand-built `~/.claude/projects/<slug>` at the call site.
    fn seed_transcript(tag: &str, worktree: &str, session: &str, body: &str) -> String {
        let cfg = unique_root(tag);
        let dir = cfg.join("projects").join(crate::claude::encode_project_slug(worktree));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{session}.jsonl")), body).unwrap();
        cfg.to_string_lossy().to_string()
    }

    fn record(i: usize, cwd: &str) -> String {
        format!(r#"{{"type":"user","cwd":"{cwd}","i":{i},"pad":"{}"}}"#, "a".repeat(60))
    }

    #[test]
    fn transcript_is_none_when_the_agent_has_never_run_claude() {
        let cfg = unique_root("no-transcript");
        assert!(read_transcript_at(
            "/wt/promo-none",
            Some(cfg.to_str().unwrap()),
            "/home/user/repo",
            4096
        )
        .is_none());
    }

    #[test]
    fn transcript_session_id_is_the_file_stem() {
        let wt = "/wt/promo-stem";
        let cfg = seed_transcript("stem", wt, "9f1c-abc", &format!("{}\n", record(0, wt)));
        let t = read_transcript_at(wt, Some(&cfg), "/home/user/repo", 4096).unwrap();
        assert_eq!(t.session_id, "9f1c-abc", "what `claude --resume <id>` will be given");
    }

    /// The cap lands in the MIDDLE of a record. Every returned line must still be a whole record —
    /// a half-record makes the sandbox's `--resume` read a corrupt transcript.
    #[test]
    fn transcript_tail_never_splits_a_record() {
        let wt = "/wt/promo-tail";
        let body: String =
            (0..10).map(|i| format!("{}\n", record(i, wt))).collect::<Vec<_>>().join("");
        let one = record(0, wt).len() as u64 + 1;
        // Deliberately NOT a multiple of the record size: the boundary falls mid-record.
        let cap = one * 3 + one / 2;
        let cfg = seed_transcript("tail", wt, "s1", &body);

        let t = read_transcript_at(wt, Some(&cfg), "/home/user/repo", cap).unwrap();
        assert!(t.truncated, "records were dropped from the head and we say so");
        assert!(t.bytes <= cap, "returned {} bytes for a {cap}-byte cap", t.bytes);
        let lines: Vec<&str> = t.jsonl.lines().collect();
        assert_eq!(lines.len(), t.records as usize, "records counts what is actually there");
        for line in &lines {
            serde_json::from_str::<Value>(line)
                .unwrap_or_else(|e| panic!("returned a partial record {line:?}: {e}"));
        }
        // It is the TAIL: the newest record survives and the oldest does not.
        assert!(t.jsonl.contains(r#""i":9"#), "newest record must be kept");
        assert!(!t.jsonl.contains(r#""i":0"#), "oldest record must be the one dropped");
    }

    /// A single record bigger than the whole cap: returning nothing would silently lose the entire
    /// conversation, so we return that one record and report the truncation honestly.
    #[test]
    fn transcript_returns_the_last_record_even_when_it_alone_exceeds_the_cap() {
        let wt = "/wt/promo-huge";
        let huge = format!(r#"{{"type":"user","cwd":"{wt}","pad":"{}"}}"#, "z".repeat(5000));
        let cfg = seed_transcript("huge", wt, "s1", &format!("{huge}\n"));

        let t = read_transcript_at(wt, Some(&cfg), "/home/user/repo", 100).unwrap();
        assert_eq!(t.records, 1, "the conversation is not dropped on the floor");
        assert!(t.bytes > 100, "we exceed the cap rather than hand back a truncated record");
        // Honest, not defensive: NOTHING was lost, so `truncated` stays false. The caller compares
        // `bytes` against the cap it passed if it wants to know the payload overran.
        assert!(!t.truncated, "no record was dropped, so none is claimed to be");
        serde_json::from_str::<Value>(t.jsonl.trim()).expect("still a whole record");
    }

    #[test]
    fn transcript_under_the_cap_is_not_marked_truncated() {
        let wt = "/wt/promo-small";
        let body = format!("{}\n{}\n", record(0, wt), record(1, wt));
        let cfg = seed_transcript("small", wt, "s1", &body);
        let t = read_transcript_at(wt, Some(&cfg), "/home/user/repo", 1024 * 1024).unwrap();
        assert_eq!(t.records, 2);
        assert!(!t.truncated, "nothing was dropped, so nothing is claimed to be");
    }

    /// THE rewrite test. `cwd` is what keys Claude Code's project slug, so it must move; the SAME
    /// path inside a message body is a historical statement and must NOT. A blind string replace
    /// over the file — the obvious implementation — passes every other assertion and fails this one.
    #[test]
    fn transcript_rewrites_the_cwd_field_but_not_the_same_path_in_a_message() {
        let wt = "/wt/promo-cwd";
        let line = format!(
            r#"{{"type":"user","cwd":"{wt}","message":{{"role":"user","content":"see {wt}/src/x.ts"}}}}"#
        );
        let cfg = seed_transcript("cwd", wt, "s1", &format!("{line}\n"));

        let t = read_transcript_at(wt, Some(&cfg), "/home/user/repo", 1024 * 1024).unwrap();
        let v: Value = serde_json::from_str(t.jsonl.trim()).unwrap();
        assert_eq!(v["cwd"], "/home/user/repo", "the FIELD moved to the sandbox");
        assert_eq!(
            v["message"]["content"], "see /wt/promo-cwd/src/x.ts",
            "the message text is history and must be left alone"
        );
    }

    #[test]
    fn transcript_leaves_records_without_a_matching_cwd_alone() {
        let wt = "/wt/promo-other";
        let line = r#"{"type":"user","cwd":"/somewhere/else","i":1}"#;
        let cfg = seed_transcript("other-cwd", wt, "s1", &format!("{line}\n"));
        let t = read_transcript_at(wt, Some(&cfg), "/home/user/repo", 1024 * 1024).unwrap();
        assert_eq!(t.jsonl.trim(), line, "another directory's cwd is not ours to rewrite");
    }

    #[test]
    fn transcript_passes_a_non_json_line_through_unchanged() {
        let wt = "/wt/promo-badline";
        let body = format!("not json at all\n{}\n", record(7, wt));
        let cfg = seed_transcript("badline", wt, "s1", &body);

        let t = read_transcript_at(wt, Some(&cfg), "/home/user/repo", 1024 * 1024).unwrap();
        assert_eq!(t.records, 2, "the odd line is kept, not dropped");
        assert!(t.jsonl.starts_with("not json at all\n"), "…and kept verbatim: {}", t.jsonl);
    }

    #[test]
    fn transcript_picks_the_newest_session_file() {
        let wt = "/wt/promo-newest";
        let cfg = unique_root("newest");
        let dir = cfg.join("projects").join(crate::claude::encode_project_slug(wt));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, secs, tag) in [("old", 1_000_000u64, "0"), ("new", 2_000_000u64, "1")] {
            let p = dir.join(format!("{name}.jsonl"));
            std::fs::write(&p, format!("{{\"cwd\":\"{wt}\",\"which\":\"{tag}\"}}\n")).unwrap();
            let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_times(std::fs::FileTimes::new().set_modified(when)).unwrap();
        }
        let t = read_transcript_at(wt, Some(cfg.to_str().unwrap()), "/home/user/repo", 1 << 20).unwrap();
        assert_eq!(t.session_id, "new", "a long-running agent must not be read one session behind");
    }

    // ── porcelain parsing ───────────────────────────────────────────────────────────────────────

    /// `git()` trims its whole capture, so the FIRST porcelain line arrives without the leading
    /// space of a ` M path` status column. A fixed 3-char slice would return "ath" for it.
    #[test]
    fn parse_porcelain_survives_the_trimmed_first_line() {
        let (paths, count) = parse_porcelain("M  src/a.rs\n M src/b.rs\n?? src/c.rs\n");
        assert_eq!(count, 3);
        assert_eq!(paths, vec!["src/a.rs", "src/b.rs", "src/c.rs"]);
    }

    #[test]
    fn parse_porcelain_reports_the_new_name_of_a_rename() {
        let (paths, _) = parse_porcelain("R  old/name.rs -> new/name.rs\n");
        assert_eq!(paths, vec!["new/name.rs"], "the file that exists on disk is the new one");
    }

    #[test]
    fn parse_porcelain_keeps_paths_containing_spaces_whole() {
        let (paths, _) = parse_porcelain("?? a file with spaces.txt\n");
        assert_eq!(paths, vec!["a file with spaces.txt"]);
    }
}

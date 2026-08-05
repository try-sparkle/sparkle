//! Freshness of the PROJECT ROOT's own working tree — and a read path that cannot be stale.
//!
//! WHY THIS EXISTS (bead sparkle-cuv2h). The `[freshness]` guardrails and the ahead/behind badge
//! cover AGENT branches. Nothing covered the project root itself, and that is the one checkout a
//! human (or a tool guessing an absolute path) is most likely to read: it sits at a canonical-
//! looking path like `~/Projects/<name>`, so it *looks* authoritative. On the founder's machine
//! that clone sat on `main` at a six-day-old commit — 1,694 behind — and the concierge answered
//! several questions out of it, reporting six-day-old code as current and giving one wrong root
//! cause as a result.
//!
//! THE MEASUREMENT THAT MATTERS. The instinctive fix — "fetch it periodically" — is a no-op here,
//! and knowing why is the whole point of this module. Every worktree of a repo SHARES one object
//! store and one set of remote-tracking refs, and the agent fleet fetches constantly (measured:
//! ~12 fetches/hour). So `origin/main` in that clone was never stale. What was stale was the
//! *checked-out* `main` — a local branch nobody had pulled since July 30. Fetching updates
//! `origin/main`, which was already current; it never advances the working tree. Hence: measure
//! `HEAD..origin/<default>`, i.e. how far the tree you would READ lags the branch you MEANT.
//!
//! FAIL-CLOSED. Absence of a comparison base is reported as `unknown`, never as a confident
//! "0 behind". A repo with no remote, an unborn HEAD, or a missing `origin/<default>` yields
//! `unknown: true` so the UI shows nothing rather than a green "fresh" that is really "no idea".
//!
//! No network, ever. This feeds a poll, and a status read that can block on a partitioned network
//! is a UI stall (the same rule `agent_branch_status_at` follows with its no-fetch base).

use serde::Serialize;

use crate::worktree::git;

/// How far the project root's working tree lags the branch it is supposed to track.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootStaleness {
    /// Commits `HEAD` is BEHIND `base`. 0 when `unknown`.
    pub behind: u32,
    /// `behind >= threshold` (and `threshold > 0`) — the point at which reading this tree misleads.
    pub stale: bool,
    /// The `staleness_warn_commits` this verdict used, so the UI can explain the number.
    pub threshold: u32,
    /// Branch checked out at the root; empty when detached or unborn.
    pub head_branch: String,
    /// Ref the count is measured against, e.g. `origin/main`. Empty when `unknown`.
    pub base: String,
    /// No usable comparison base. `behind`/`stale` carry NO meaning — do not render them.
    pub unknown: bool,
}

impl RootStaleness {
    /// The fail-closed reading: we could not tell, so claim nothing.
    fn unknown(head_branch: String, threshold: u32) -> Self {
        Self { behind: 0, stale: false, threshold, head_branch, base: String::new(), unknown: true }
    }
}

/// Branch checked out at `root`, or empty for a detached/unborn HEAD.
fn head_branch_at(root: &str) -> String {
    match git(root, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        // `--abbrev-ref` prints the literal "HEAD" when detached — that is not a branch name.
        Ok(b) if b != "HEAD" => b,
        _ => String::new(),
    }
}

/// How far `root`'s working tree lags `origin/<default_branch>`. Never fails: this feeds a poll,
/// and every unresolvable case is a fail-closed `unknown` rather than an error the caller must
/// handle on every tick (the failure mode `agent_branch_status_at` documents at length).
pub fn root_staleness_at(root: &str, default_branch: &str, threshold: u32) -> RootStaleness {
    let head_branch = head_branch_at(root);

    // A base that does not resolve means we cannot measure — say so rather than reporting 0.
    // Covers: no `origin` remote, never-fetched clone, and a default branch that does not exist
    // on the remote. Also covers an unborn HEAD, since `HEAD..base` would then be unresolvable.
    let base = format!("origin/{default_branch}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).is_err() {
        return RootStaleness::unknown(head_branch, threshold);
    }
    if git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).is_err() {
        return RootStaleness::unknown(head_branch, threshold);
    }

    let behind = match git(root, &["rev-list", "--count", &format!("HEAD..{base}")]) {
        Ok(s) => match s.trim().parse::<u32>() {
            Ok(n) => n,
            // A count we cannot parse is a count we do not have.
            Err(_) => return RootStaleness::unknown(head_branch, threshold),
        },
        Err(_) => return RootStaleness::unknown(head_branch, threshold),
    };

    RootStaleness {
        behind,
        stale: threshold > 0 && behind >= threshold,
        threshold,
        head_branch,
        base,
        unknown: false,
    }
}

/// Reject anything that is not a plain repo-relative path, so a "fresh read" can never be talked
/// into leaving the repo. `git show <rev>:<path>` resolves `..` against the TREE, so `../../x` is
/// a real traversal primitive and not merely cosmetic.
fn validate_repo_relative(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("fresh read: empty path".into());
    }
    if path.starts_with('/') {
        return Err(format!("fresh read: path must be repo-relative, got absolute {path:?}"));
    }
    // Windows-style roots and drive letters are equally not repo-relative.
    if path.starts_with('\\') || path.chars().nth(1) == Some(':') {
        return Err(format!("fresh read: path must be repo-relative, got {path:?}"));
    }
    if path.split(['/', '\\']).any(|c| c == "..") {
        return Err(format!("fresh read: path must not traverse upward, got {path:?}"));
    }
    Ok(())
}

/// Read a file as it exists on `origin/<default_branch>` — NEVER from any working tree.
///
/// This is the guaranteed-fresh read path: it is what makes a stale checkout unable to masquerade
/// as current. A tool that reads through here gets the tracked branch's bytes whatever the tree on
/// disk happens to hold, so the failure this module documents (answering from a six-day-old tree)
/// is not reachable. Content is returned VERBATIM — no trimming, since trailing whitespace and the
/// final newline are part of a file.
pub fn fresh_read_at(root: &str, default_branch: &str, path: &str) -> Result<String, String> {
    validate_repo_relative(path)?;
    let base = format!("origin/{default_branch}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).is_err() {
        return Err(format!("fresh read: {base} does not resolve (never fetched?)"));
    }

    // Deliberately NOT `crate::worktree::git`: that trims the output, which would silently corrupt
    // file content (a trailing newline is data). Run it raw.
    let out = std::process::Command::new(crate::preflight::git_program())
        .arg("-C")
        .arg(root)
        .args(["show", &format!("{base}:{path}")])
        .output()
        .map_err(|e| format!("fresh read: failed to run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("fresh read: {base}:{path} unavailable: {err}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Staleness of a project root's own checkout, for the project tab badge.
#[tauri::command]
pub async fn repo_root_staleness(root: String) -> Result<RootStaleness, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let threshold = crate::config::for_project(&root).config.freshness.staleness_warn_commits;
        let default_branch = crate::worktree::resolve_default_branch(&root);
        root_staleness_at(&root, &default_branch, threshold)
    })
    .await
    .map_err(|e| format!("repo_root_staleness: {e}"))
}

/// Read a repo file from `origin/<default>` rather than from any working tree.
#[tauri::command]
pub async fn repo_fresh_read(root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let default_branch = crate::worktree::resolve_default_branch(&root);
        fresh_read_at(&root, &default_branch, &path)
    })
    .await
    .map_err(|e| format!("repo_fresh_read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_root(tag: &str) -> tempfile::TempDir {
        tempfile::Builder::new().prefix(&format!("freshness-{tag}-")).tempdir().unwrap()
    }

    /// A repo with an `origin` that really is a separate repository, so `origin/main` can advance
    /// independently of the local checkout — which is the exact shape this module measures.
    fn repo_with_origin(tag: &str) -> (tempfile::TempDir, tempfile::TempDir, String) {
        let up = unique_root(&format!("{tag}-origin"));
        let u = up.path().to_str().unwrap().to_string();
        git(&u, &["init", "-q", "--bare", "--initial-branch=main"]).unwrap();

        let dn = unique_root(tag);
        let d = dn.path().to_str().unwrap().to_string();
        git(&d, &["init", "-q"]).unwrap();
        git(&d, &["config", "user.email", "t@t"]).unwrap();
        git(&d, &["config", "user.name", "t"]).unwrap();
        std::fs::write(format!("{d}/f.txt"), "one\n").unwrap();
        git(&d, &["add", "-A"]).unwrap();
        git(&d, &["commit", "-q", "-m", "init"]).unwrap();
        git(&d, &["branch", "-M", "main"]).unwrap();
        git(&d, &["remote", "add", "origin", &u]).unwrap();
        git(&d, &["push", "-q", "origin", "main"]).unwrap();
        git(&d, &["fetch", "-q", "origin"]).unwrap();
        (dn, up, d)
    }

    /// Advance `origin/main` by `n` commits WITHOUT moving the local checkout — the exact drift
    /// the founder's clone was in. Done via a throwaway clone so the tree under test never moves.
    fn advance_origin(origin_path: &str, n: usize) -> tempfile::TempDir {
        let wc = unique_root("pusher");
        let w = wc.path().to_str().unwrap().to_string();
        git(&w, &["clone", "-q", origin_path, "."]).unwrap();
        git(&w, &["config", "user.email", "t@t"]).unwrap();
        git(&w, &["config", "user.name", "t"]).unwrap();
        for i in 0..n {
            std::fs::write(format!("{w}/f.txt"), format!("advance {i}\n")).unwrap();
            git(&w, &["add", "-A"]).unwrap();
            git(&w, &["commit", "-q", "-m", &format!("c{i}")]).unwrap();
        }
        git(&w, &["push", "-q", "origin", "main"]).unwrap();
        wc
    }

    // The headline case: a tree that has NOT moved while origin/main ran ahead. This is the
    // founder's clone in miniature, and the assertion is on the SIDE EFFECT (a nonzero behind
    // count and a `stale` verdict), not on the precondition that a base exists.
    #[test]
    fn counts_a_working_tree_left_behind_by_origin() {
        let (_d, up, root) = repo_with_origin("behind");
        let _p = advance_origin(up.path().to_str().unwrap(), 3);
        // Fetch only — never merge. Fetching is what a "keep it fresh" job would do.
        git(&root, &["fetch", "-q", "origin"]).unwrap();

        let s = root_staleness_at(&root, "main", 2);
        assert!(!s.unknown, "base resolves, so this must be a real reading");
        assert_eq!(s.behind, 3, "tree is 3 commits behind origin/main");
        assert!(s.stale, "3 >= threshold 2");
        assert_eq!(s.head_branch, "main");
        assert_eq!(s.base, "origin/main");
    }

    // The load-bearing claim in this module's docs: FETCHING DOES NOT MOVE THE TREE. If this ever
    // fails, the "periodic fetch" fix would actually have worked and the design rationale is wrong.
    #[test]
    fn fetching_does_not_reduce_the_behind_count() {
        let (_d, up, root) = repo_with_origin("fetch-noop");
        let _p = advance_origin(up.path().to_str().unwrap(), 4);

        git(&root, &["fetch", "-q", "origin"]).unwrap();
        let before = root_staleness_at(&root, "main", 25).behind;
        // Fetch again, as a periodic refresher would.
        git(&root, &["fetch", "-q", "origin"]).unwrap();
        let after = root_staleness_at(&root, "main", 25).behind;

        assert_eq!(before, 4);
        assert_eq!(after, 4, "a second fetch must not advance the working tree");
    }

    // Merging IS what closes the gap — the counterpart proving the metric responds to the real fix.
    #[test]
    fn merging_origin_clears_the_staleness() {
        let (_d, up, root) = repo_with_origin("merged");
        let _p = advance_origin(up.path().to_str().unwrap(), 2);
        git(&root, &["fetch", "-q", "origin"]).unwrap();
        assert_eq!(root_staleness_at(&root, "main", 1).behind, 2);

        git(&root, &["merge", "-q", "--ff-only", "origin/main"]).unwrap();
        let s = root_staleness_at(&root, "main", 1);
        assert_eq!(s.behind, 0);
        assert!(!s.stale, "an up-to-date tree is not stale");
    }

    #[test]
    fn threshold_decides_the_verdict_not_the_count() {
        let (_d, up, root) = repo_with_origin("threshold");
        let _p = advance_origin(up.path().to_str().unwrap(), 5);
        git(&root, &["fetch", "-q", "origin"]).unwrap();

        assert!(root_staleness_at(&root, "main", 5).stale, "behind == threshold is stale");
        assert!(!root_staleness_at(&root, "main", 6).stale, "under threshold is not stale");
        assert!(!root_staleness_at(&root, "main", 0).stale, "threshold 0 disables the verdict");
        // The count itself is unaffected by the threshold.
        assert_eq!(root_staleness_at(&root, "main", 0).behind, 5);
    }

    // Fail-closed: no remote must NOT read as "0 behind, fresh".
    #[test]
    fn a_repo_with_no_origin_is_unknown_not_fresh() {
        let d = unique_root("no-origin");
        let root = d.path().to_str().unwrap().to_string();
        git(&root, &["init", "-q"]).unwrap();
        git(&root, &["config", "user.email", "t@t"]).unwrap();
        git(&root, &["config", "user.name", "t"]).unwrap();
        git(&root, &["commit", "-q", "--allow-empty", "-m", "init"]).unwrap();
        git(&root, &["branch", "-M", "main"]).unwrap();

        let s = root_staleness_at(&root, "main", 25);
        assert!(s.unknown, "no origin/main to compare against");
        assert!(!s.stale, "unknown must never render as a stale verdict either");
        assert_eq!(s.base, "", "no base was used");
    }

    #[test]
    fn an_unborn_head_is_unknown() {
        let d = unique_root("unborn");
        let root = d.path().to_str().unwrap().to_string();
        git(&root, &["init", "-q"]).unwrap();
        assert!(root_staleness_at(&root, "main", 25).unknown);
    }

    #[test]
    fn a_detached_head_reports_no_branch_but_still_counts() {
        let (_d, up, root) = repo_with_origin("detached");
        let _p = advance_origin(up.path().to_str().unwrap(), 2);
        git(&root, &["fetch", "-q", "origin"]).unwrap();
        let head = git(&root, &["rev-parse", "HEAD"]).unwrap();
        git(&root, &["checkout", "-q", "--detach", &head]).unwrap();

        let s = root_staleness_at(&root, "main", 1);
        assert_eq!(s.head_branch, "", "detached HEAD is not a branch name");
        assert_eq!(s.behind, 2, "but it is still measurably behind");
    }

    // ── fresh_read_at ─────────────────────────────────────────────────────────────────────────

    // The whole point: the tree on disk says one thing, origin/main says another, and the fresh
    // read returns origin/main's bytes. Asserting the CONTENT, not merely that the call succeeded.
    #[test]
    fn fresh_read_ignores_a_stale_working_tree() {
        let (_d, up, root) = repo_with_origin("fresh-read");
        let _p = advance_origin(up.path().to_str().unwrap(), 1);
        git(&root, &["fetch", "-q", "origin"]).unwrap();

        // The tree still holds the ORIGINAL content...
        assert_eq!(std::fs::read_to_string(format!("{root}/f.txt")).unwrap(), "one\n");
        // ...but the fresh read sees what origin/main actually has.
        assert_eq!(fresh_read_at(&root, "main", "f.txt").unwrap(), "advance 0\n");
    }

    // A dirty tree must not leak into a "fresh" read either.
    #[test]
    fn fresh_read_ignores_uncommitted_edits() {
        let (_d, _up, root) = repo_with_origin("dirty");
        std::fs::write(format!("{root}/f.txt"), "LOCAL SCRATCH\n").unwrap();
        assert_eq!(fresh_read_at(&root, "main", "f.txt").unwrap(), "one\n");
    }

    #[test]
    fn fresh_read_preserves_content_verbatim() {
        let (_d, up, root) = repo_with_origin("verbatim");
        let u = up.path().to_str().unwrap().to_string();
        let wc = unique_root("verbatim-push");
        let w = wc.path().to_str().unwrap().to_string();
        git(&w, &["clone", "-q", &u, "."]).unwrap();
        git(&w, &["config", "user.email", "t@t"]).unwrap();
        git(&w, &["config", "user.name", "t"]).unwrap();
        // Trailing blank lines and spaces are DATA — `crate::worktree::git` would trim them away.
        std::fs::write(format!("{w}/f.txt"), "a  \n\n\n").unwrap();
        git(&w, &["add", "-A"]).unwrap();
        git(&w, &["commit", "-q", "-m", "ws"]).unwrap();
        git(&w, &["push", "-q", "origin", "main"]).unwrap();
        git(&root, &["fetch", "-q", "origin"]).unwrap();

        assert_eq!(fresh_read_at(&root, "main", "f.txt").unwrap(), "a  \n\n\n");
    }

    #[test]
    fn fresh_read_refuses_to_leave_the_repo() {
        let (_d, _up, root) = repo_with_origin("traversal");
        for bad in ["../etc/passwd", "a/../../b", "/etc/passwd", "", "..\\win"] {
            assert!(
                fresh_read_at(&root, "main", bad).is_err(),
                "must refuse {bad:?}"
            );
        }
        // The guard must not be so broad it rejects legitimate nested paths.
        assert!(validate_repo_relative("apps/desktop/src/main.tsx").is_ok());
        // ...or a file whose NAME merely contains dots.
        assert!(validate_repo_relative("a/..hidden/f.rs").is_ok());
    }

    #[test]
    fn fresh_read_reports_a_missing_path_rather_than_returning_empty() {
        let (_d, _up, root) = repo_with_origin("missing");
        let e = fresh_read_at(&root, "main", "no/such/file.txt").unwrap_err();
        assert!(e.contains("unavailable"), "got: {e}");
    }
}

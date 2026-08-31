//! Is a directory a working tree that `git` can still ANSWER from — or a husk that merely looks
//! like one?
//!
//! ── WHY `.git.exists()` IS NOT THAT CHECK (beads sparkle-iw02bk, sparkle-tm4blm) ───────────────
//! `git worktree prune` removes the ADMIN directory at `<repo>/.git/worktrees/<id>`. It does NOT
//! touch the worktree's own `.git`, which is a one-line `gitdir:` POINTER FILE living in the
//! worktree directory itself. So a pruned worktree keeps its `.git` and passes an `.exists()` test
//! — the test that was written precisely to exclude "a leftover husk `git worktree prune` has
//! already disowned", and excluded none of them.
//!
//! That vacuous test was written independently in four modules, each failing differently and
//! locally plausibly, which is why the corrected form lives HERE rather than being fixed in place
//! four times: a drive-by on each is how the versions drift apart again. `scripts/lib/
//! worktree-liveness-guard.sh` fails the shell suite on a bare pointer-file existence test written
//! anywhere else under `apps/desktop/src-tauri/src/`.
//!
//! Deliberately filesystem-only: NO subprocess. Callers run this once per worktree per discovery
//! walk over a fleet-sized directory tree (~125 worktrees was the measured shape), and one of them
//! runs on the app's quit path under a hard budget. Spawning `git` here would put ~90 processes on
//! paths built to cost syscalls.
//!
//! ── LIVENESS IS NOT CLASSIFICATION ─────────────────────────────────────────────────────────────
//! [`is_live_worktree`] answers "can git still answer here". [`is_linked_worktree`] answers "is
//! this a linked worktree or a main checkout". They are different questions and a call site must
//! pick deliberately: a husk is DEAD but it is still LINKED-shaped, so routing a classification
//! site through the liveness helper would silently reclassify it as a main checkout.

use std::path::{Path, PathBuf};

/// Is `dir` a worktree `git` (and anything shelling out to it) can still ANSWER from?
///
/// What the vacuous version cost, at the one call site that was characterised: every `git`/`gh`
/// call in a husk answers `fatal: not a git repository: <the pruned gitdir>`, so the PR reader's
/// repo-slug lookup returned `None`, `gh pr list` fell back to resolving the repo from its cwd and
/// failed, and `gh api` could not expand `{owner}/{repo}` and failed too. Two failures, one cause,
/// neither of them an API fault — reported as "both APIs failed", which reads as a GitHub outage.
/// Because the candidate list is sorted and the fallback budget is fixed, it recurred identically
/// on every sweep: not a transient, a PERMANENT blind spot ending only when a human deleted the
/// directory. Measured on the founder's machine as a ~6-hour outage during which `gh` was healthy.
///
/// Both shapes of `.git` are accepted, because both are real:
///   * a FILE — a linked worktree. Live only if the `gitdir:` it names still exists.
///   * a DIRECTORY — an ordinary main checkout, which owns its git dir outright.
pub fn is_live_worktree(dir: &Path) -> bool {
    let dot_git = dir.join(".git"); // guard-ok: THE definition this guard exists to centralise.
    let Ok(meta) = std::fs::metadata(&dot_git) else {
        return false;
    };
    if meta.is_dir() {
        return true;
    }
    let Ok(contents) = std::fs::read_to_string(&dot_git) else {
        // A `.git` we cannot read is not a directory we can answer from either, but it is also not
        // the husk this function is named for — say so, since silence here is what hid the original.
        tracing::warn!(
            target: "worktree_liveness",
            dir = %dir.display(),
            "a worktree's `.git` file is unreadable; treating the worktree as gone"
        );
        return false;
    };
    let Some(gitdir) = gitdir_pointer(&contents) else {
        return false;
    };
    // A RELATIVE pointer resolves against the worktree directory, which is how git writes one for a
    // worktree created with a relative path.
    let target = if gitdir.is_absolute() { gitdir } else { dir.join(gitdir) };
    if target.exists() {
        return true;
    }
    tracing::debug!(
        target: "worktree_liveness",
        dir = %dir.display(),
        gitdir = %target.display(),
        "skipping a PRUNED worktree: its `.git` file survives but the gitdir it names is gone, so \
         every `git`/`gh` call here fails with `not a git repository`"
    );
    false
}

/// Is `dir` a LINKED worktree (its `.git` is a `gitdir:` pointer FILE) rather than a main checkout
/// (a `.git` DIRECTORY)?
///
/// A CLASSIFICATION, NOT A LIVENESS TEST, and the distinction is the whole point of this module
/// carrying two functions instead of one. A husk answers `true` here and `false` to
/// [`is_live_worktree`], and that is correct in both directions: a pruned linked worktree is dead,
/// but it was never a main checkout, and calling it one would be a second wrong answer rather than
/// a fix. Callers that want "can git answer here" want [`is_live_worktree`]; callers that want
/// "which of the two shapes is this" want this.
///
/// Stricter than a bare `.is_file()` by exactly one thing: the file must parse as a `gitdir:`
/// pointer. A `.git` FILE that is not a gitlink is not a worktree of either shape.
pub fn is_linked_worktree(dir: &Path) -> bool {
    let dot_git = dir.join(".git"); // guard-ok: THE definition this guard exists to centralise.
    match std::fs::metadata(&dot_git) {
        Ok(meta) if meta.is_file() => std::fs::read_to_string(&dot_git)
            .ok()
            .and_then(|c| gitdir_pointer(&c))
            .is_some(),
        _ => false,
    }
}

/// The path out of a linked worktree's `.git` pointer file (`gitdir: <path>`), PURE so the parse is
/// asserted without a filesystem. `None` for anything that is not that one line — a `.git` we
/// cannot parse is not a worktree we can vouch for.
pub fn gitdir_pointer(contents: &str) -> Option<PathBuf> {
    contents
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A LIVE linked worktree: a `.git` POINTER FILE whose gitdir really exists.
    ///
    /// The pointer has to RESOLVE. Fixtures across this repo used to write a literal pointer naming
    /// a path that had never existed — so each of them built the exact husk this module drops while
    /// asserting it was a live worktree. That is what made the old `.exists()` filter look tested:
    /// the fixtures agreed with the bug.
    fn make_live(dir: &Path) {
        let admin = dir.join(".git-admin");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::write(dir.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
    }

    /// THE HUSK THAT ACTUALLY OCCURS KEEPS ITS `.git` FILE. Revert this helper to a bare
    /// `.exists()` and this goes red.
    #[test]
    fn a_pruned_worktree_that_kept_its_git_file_is_dead() {
        let d = tempfile::tempdir().unwrap();
        let husk = d.path().join("husk");
        std::fs::create_dir_all(&husk).unwrap();
        std::fs::write(husk.join(".git"), "gitdir: /nowhere/that/exists/.git/worktrees/x\n")
            .unwrap();
        assert!(husk.join(".git").exists(), "precondition: the husk passes the OLD filter");
        assert!(!is_live_worktree(&husk));
    }

    /// THE PAIRED CASE — the half that stops the fix from being "call everything dead", which would
    /// satisfy the test above and be strictly worse than the bug.
    #[test]
    fn a_live_worktree_and_a_main_checkout_are_both_live() {
        let d = tempfile::tempdir().unwrap();

        let linked = d.path().join("linked");
        std::fs::create_dir_all(&linked).unwrap();
        make_live(&linked);
        assert!(is_live_worktree(&linked), "a linked worktree with a real gitdir is live");

        let main = d.path().join("main");
        std::fs::create_dir_all(main.join(".git")).unwrap();
        assert!(
            is_live_worktree(&main),
            "a main checkout keeps its whole `.git` DIRECTORY and must never read as a husk"
        );

        let nothing = d.path().join("no-git");
        std::fs::create_dir_all(&nothing).unwrap();
        assert!(!is_live_worktree(&nothing), "a directory with no `.git` at all is not a worktree");
    }

    /// A RELATIVE pointer resolves against the WORKTREE DIR, not the process cwd — which is how git
    /// writes one for a worktree created with a relative path. Resolving it against the cwd would
    /// call every such worktree a husk.
    #[test]
    fn a_relative_gitdir_pointer_resolves_against_the_worktree_dir() {
        let d = tempfile::tempdir().unwrap();
        let wt = d.path().join("parent").join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(d.path().join("parent").join(".git").join("worktrees").join("wt"))
            .unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ../.git/worktrees/wt\n").unwrap();
        assert!(is_live_worktree(&wt), "a relative pointer that resolves is live");

        std::fs::write(wt.join(".git"), "gitdir: ../.git/worktrees/GONE\n").unwrap();
        assert!(!is_live_worktree(&wt), "…and one that does not resolve is a husk");
    }

    /// A `.git` file that is not a gitlink at all vouches for nothing.
    #[test]
    fn an_unparseable_git_file_is_not_live() {
        let d = tempfile::tempdir().unwrap();
        let junk = d.path().join("junk");
        std::fs::create_dir_all(&junk).unwrap();
        std::fs::write(junk.join(".git"), "not a gitlink\n").unwrap();
        assert!(!is_live_worktree(&junk));
        assert!(!is_linked_worktree(&junk), "and it is not a linked worktree either");
    }

    /// CLASSIFICATION IS NOT LIVENESS — the pair that pins the two functions apart. A husk is DEAD
    /// and still LINKED; a main checkout is LIVE and NOT linked. Collapse either into the other and
    /// exactly one of these four assertions goes red.
    #[test]
    fn classification_and_liveness_are_different_questions() {
        let d = tempfile::tempdir().unwrap();

        let husk = d.path().join("husk");
        std::fs::create_dir_all(&husk).unwrap();
        std::fs::write(husk.join(".git"), "gitdir: /nowhere/that/exists\n").unwrap();
        assert!(!is_live_worktree(&husk), "a pruned husk is dead");
        assert!(is_linked_worktree(&husk), "…and is still a LINKED worktree, not a main checkout");

        let main = d.path().join("main");
        std::fs::create_dir_all(main.join(".git")).unwrap();
        assert!(is_live_worktree(&main), "a main checkout is live");
        assert!(!is_linked_worktree(&main), "…and is not linked — its `.git` is a DIRECTORY");
    }

    #[test]
    fn gitdir_pointer_reads_only_a_real_pointer_line() {
        assert_eq!(gitdir_pointer("gitdir: /a/b\n"), Some(PathBuf::from("/a/b")));
        assert_eq!(gitdir_pointer("  gitdir:   /a/b  \n"), Some(PathBuf::from("/a/b")));
        assert_eq!(gitdir_pointer("noise\ngitdir: /a/b\n"), Some(PathBuf::from("/a/b")));
        assert_eq!(gitdir_pointer("gitdir:\n"), None, "an empty target names nothing");
        assert_eq!(gitdir_pointer("gitdir:    \n"), None);
        assert_eq!(gitdir_pointer("not a gitlink\n"), None);
        assert_eq!(gitdir_pointer(""), None);
    }
}

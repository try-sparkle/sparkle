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

// ── Diagnosis + remedy ────────────────────────────────────────────────────────────────────────
//
// `root_staleness_at` says HOW FAR behind. It cannot say WHY, and "why" is the whole difference
// between a badge you can act on and a badge you learn to ignore. The founder's clone was behind
// for a reason no number can express — and the reasons need different remedies, one of which is
// "there is no remedy, so stop offering a button". Hence: name the cause, then offer only the
// action that is actually safe for that cause.
//
// SAFETY POSTURE. Nothing here fetches (the module invariant above), and nothing here is
// destructive: no `reset --hard`, no `checkout -f`, no `clean`, no `stash`. There is exactly ONE
// write in this module — `merge --ff-only` — which git itself refuses when it would clobber local
// work. Where git's refusal is more accurate than a pre-check we could write, we let git refuse and
// hand its own words back (see `remedy_at`).
//
// There was briefly a second write, `checkout <default>`, and its deletion is the posture: it moved
// a commit that `can_fast_forward` had never checked, so it could half-land (see `BlockedDetached`).

/// What can be DONE about a stale checkout. `None` and the two `Blocked*` variants are verdicts,
/// not buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StaleRemedy {
    /// Already current. Nothing to offer.
    None,
    /// Clean, on a branch, a strict ancestor: `merge --ff-only` brings it up with zero risk.
    FastForward,
    /// Same, but with uncommitted work present. Still attemptable — git refuses if it would clobber.
    FastForwardDirty,
    /// Detached HEAD, with the default branch free. NO ACTION IS OFFERED, and that is deliberate —
    /// do not re-add one. `can_fast_forward` is measured against the DETACHED head, so "check out
    /// the branch, then fast-forward" moves a commit the precondition never covered: with a
    /// diverged local branch the checkout SUCCEEDS (claiming the branch away from every sibling
    /// worktree) and only then does the fast-forward fail, leaving a half-landed branch claim.
    /// The `cause` names the manual step instead. See arm 6b in `diagnose_at`.
    BlockedDetached,
    /// Detached HEAD in a checkout that CANNOT hold the default branch, because another worktree
    /// has it. No button helps: it would have to be pressed again forever.
    BlockedHeldElsewhere,
    /// The checkout has commits the base does not. A fast-forward would lose them, so we refuse.
    BlockedDiverged,
    /// No usable comparison base. Fail-closed, exactly as `RootStaleness::unknown` is.
    Unknown,
}

/// WHY a checkout is behind, and what (if anything) may safely be done about it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleDiagnosis {
    /// Commits `HEAD` is behind `base`. 0 when `unknown`.
    pub behind: u32,
    /// Ref measured against, e.g. `origin/main`. Empty when `unknown`.
    pub base: String,
    /// Branch checked out here; empty when detached or unborn.
    pub head_branch: String,
    /// The project's default branch, e.g. `main`.
    pub default_branch: String,
    /// HEAD is not on a branch.
    pub detached: bool,
    /// This root's `.git` is a FILE, i.e. it is a linked worktree rather than the main checkout.
    /// Reported independently of `held_by`: a linked worktree can still be on its own branch.
    pub linked_worktree: bool,
    /// Absolute path of the OTHER worktree holding `default_branch`; empty when none does — or when
    /// this root is itself the holder, which is not a conflict.
    pub held_by: String,
    /// Lines of `status --porcelain --untracked-files=all`.
    pub dirty_count: u32,
    /// Up to 5 of those paths, path only — enough for the panel to show what is at stake.
    pub dirty_sample: Vec<String>,
    /// HEAD is a STRICT ancestor of `base`, so a fast-forward cannot lose anything.
    pub can_fast_forward: bool,
    /// The only action worth offering for this shape.
    pub remedy: StaleRemedy,
    /// ONE sentence naming why, rendered verbatim in the panel. Written for a human, not a log.
    pub cause: String,
    /// May be fast-forwarded with NO user click. True only for the provably-safe shape.
    pub auto_safe: bool,
    /// Nothing here carries meaning — do not render `behind`.
    pub unknown: bool,
}

/// What a remedy attempt actually did — including the case where it refused to do anything.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemedyOutcome {
    pub ok: bool,
    /// Empty when `ok`; the refusal or failure sentence otherwise.
    pub reason: String,
    /// The git argv actually run, e.g. `merge --ff-only origin/main`. Empty when we refused.
    pub action: String,
    /// Behind count from the FRESH pre-action diagnosis.
    pub before_behind: u32,
    /// Behind count re-measured after; equal to `before_behind` on a refusal.
    pub after_behind: u32,
}

/// Uncommitted work in `root`: the line count, and up to 5 paths.
///
/// Parsed defensively rather than by fixed offset: `git()` trims the whole output, so the leading
/// space of an unstaged `" M path"` is gone from the FIRST line only. A 3-char strip would eat a
/// character of that one path and leave every other line correct — exactly the kind of bug a
/// "sample is non-empty" assertion hides.
/// `None` means THE PROBE FAILED — never "clean". This returned `(0, vec![])` on error once, which
/// is byte-identical to a clean tree, and that value feeds `auto_safe`: a failed `git status`
/// (`index.lock` contention is the realistic trigger here, where a fleet and a 60s poll run git
/// constantly) would have produced `FastForward` + `auto_safe`, and a tree whose cleanliness was
/// never established would be advanced with no click. Every other probe in this module fails closed
/// to `unknown`; this one now does too (roborev 59436).
fn dirty_at(root: &str) -> Option<(u32, Vec<String>)> {
    let Ok(out) = git(root, &["status", "--porcelain", "--untracked-files=all"]) else {
        return None;
    };
    let mut count = 0u32;
    let mut sample = Vec::new();
    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        count = count.saturating_add(1);
        if sample.len() < 5 {
            // "XY <path>" — drop the status field, then the rename arrow if there is one.
            let rest = line.trim_start();
            let path = rest.split_once(' ').map(|(_, p)| p.trim_start()).unwrap_or(rest);
            let path = path.rsplit(" -> ").next().unwrap_or(path);
            sample.push(path.to_string());
        }
    }
    Some((count, sample))
}

/// The OTHER worktree holding `branch`, or empty when none does — or when it is this root itself.
///
/// Paths are canonicalised before comparison: on macOS a tempdir under `/var` resolves to
/// `/private/var`, so a raw string compare would report this very checkout as "held elsewhere".
fn held_by_at(root: &str, branch: &str) -> String {
    let Some(holder) = crate::worktree::worktree_on_branch(root, branch) else {
        return String::new();
    };
    let canon = |p: &str| std::fs::canonicalize(p).ok();
    match (canon(&holder), canon(root)) {
        (Some(h), Some(r)) if h == r => String::new(),
        // Canonicalisation failing is not a reason to claim a conflict that may not exist, so fall
        // back to the raw compare rather than to "held".
        (None, _) | (_, None) if holder == root => String::new(),
        _ => holder,
    }
}

/// Core (AppHandle-free, testable): why `root` is behind `origin/<default_branch>`, and what may
/// safely be done about it. The classification ORDER is load-bearing — see the arms below.
pub fn diagnose_at(root: &str, default_branch: &str, threshold: u32) -> StaleDiagnosis {
    let base_ref = format!("origin/{default_branch}");
    // Reuse the measured, already-tested path for behind/base/head_branch/unknown rather than
    // running the same three git calls a second way.
    let s = root_staleness_at(root, default_branch, threshold);

    // 1. No usable base (or an unborn HEAD) — claim nothing, exactly as the badge does.
    if s.unknown {
        let base_missing =
            git(root, &["rev-parse", "--verify", "--quiet", &format!("{base_ref}^{{commit}}")])
                .is_err();
        let cause = if base_missing {
            format!("could not measure: {base_ref} does not resolve (never fetched?)")
        } else {
            "could not measure: HEAD does not resolve (an unborn branch with no commits yet)".into()
        };
        return StaleDiagnosis {
            behind: 0,
            base: String::new(),
            head_branch: String::new(),
            default_branch: default_branch.to_string(),
            detached: false,
            linked_worktree: false,
            held_by: String::new(),
            dirty_count: 0,
            dirty_sample: Vec::new(),
            can_fast_forward: false,
            remedy: StaleRemedy::Unknown,
            cause,
            auto_safe: false,
            unknown: true,
        };
    }

    let head_branch = s.head_branch.clone();
    let detached = head_branch.is_empty();
    // `None` = the probe failed, which is NOT "clean". Carried separately so the count stays 0 (the
    // UI has no honest number to show) while `dirty_known` keeps it out of the auto-advance path.
    let dirty = dirty_at(root);
    let dirty_known = dirty.is_some();
    let (dirty_count, dirty_sample) = dirty.unwrap_or((0, Vec::new()));
    let mut d = StaleDiagnosis {
        behind: s.behind,
        base: s.base.clone(),
        head_branch,
        default_branch: default_branch.to_string(),
        detached,
        // A linked worktree's `.git` is a FILE pointing at the main checkout's admin dir.
        linked_worktree: std::path::Path::new(root).join(".git").is_file(),
        held_by: held_by_at(root, default_branch),
        dirty_count,
        dirty_sample,
        can_fast_forward: false,
        remedy: StaleRemedy::None,
        cause: String::new(),
        auto_safe: false,
        unknown: false,
    };

    // 3. Nothing to explain.
    if d.behind == 0 {
        d.cause = format!("up to date with {}", d.base);
        // `can_fast_forward` means STRICT ancestor, and nothing level with (or ahead of) its base
        // is one. Leaving it false keeps the field honest: there is no fast-forward to perform.
        return d;
    }

    // 4. Would a fast-forward lose anything? `behind > 0` here, so "ancestor" implies STRICT.
    d.can_fast_forward = git(root, &["merge-base", "--is-ancestor", "HEAD", &d.base]).is_ok();

    if !d.can_fast_forward {
        // 5. Diverged — the one case where the safe move is to do nothing at all.
        d.remedy = StaleRemedy::BlockedDiverged;
        d.cause = format!(
            "this checkout has commits {} does not, so a fast-forward would lose them; merge or \
             rebase it by hand",
            d.base
        );
    } else if d.detached {
        if !d.held_by.is_empty() {
            // 6a. Detached AND the branch lives elsewhere. Checking it out is impossible, and
            // re-detaching onto the new base is a button you would press forever — so: no button.
            d.remedy = StaleRemedy::BlockedHeldElsewhere;
            let kind = if d.linked_worktree {
                "this checkout is a linked worktree with a DETACHED HEAD"
            } else {
                "this checkout has a DETACHED HEAD"
            };
            d.cause = format!(
                "{kind}; `{}` is held by {}, so it can never track a branch and will fall behind \
                 again immediately",
                d.default_branch, d.held_by
            );
        } else {
            // 6b. Detached with the branch free. NAMED, NOT OFFERED — and the deletion of the
            // button that used to be here is the fix, not an omission (roborev 59436).
            //
            // `can_fast_forward` was measured against the DETACHED head. A "check out `main` then
            // fast-forward it" button moves a DIFFERENT commit, so the precondition never covered
            // the action: when a local `main` exists and has diverged, the checkout SUCCEEDS —
            // taking the branch, and in this repo denying it to every other worktree — and only
            // then does the fast-forward fail. That is a half-succeeded state change, the exact
            // thing this module refuses to do. Hardening it would mean a second ancestry probe on a
            // commit we have not looked at, to guard a state a project root is rarely in.
            //
            // So the verdict names the cure and lets the user run it deliberately, where they can
            // see what `git checkout` says. Same principle as `blocked-held-elsewhere`: a refusal
            // that explains beats an action that can half-land.
            d.remedy = StaleRemedy::BlockedDetached;
            d.cause = format!(
                "HEAD is detached, so this checkout tracks nothing and cannot be fast-forwarded \
                 safely from here — `git checkout {}` in this directory, then reopen this panel",
                d.default_branch
            );
        }
    } else if !dirty_known {
        // 7a′. `git status` did not answer, so this tree is NOT provably clean. Treated exactly
        // like a dirty one: offered, but never auto-advanced (roborev 59436).
        d.remedy = StaleRemedy::FastForwardDirty;
        d.cause = format!(
            "{} commit(s) behind {}, but `git status` could not be read here — so this tree is not \
             treated as clean. A fast-forward will be attempted and git will refuse it if there is \
             local work in the way",
            d.behind, d.base
        );
    } else if d.dirty_count > 0 {
        // 7a. On a branch and fast-forwardable, but there is local work in the way.
        d.remedy = StaleRemedy::FastForwardDirty;
        d.cause = format!(
            "{} commit(s) behind {}, with {} uncommitted change(s) here; a fast-forward will be \
             attempted and git will refuse it if it would clobber one",
            d.behind, d.base, d.dirty_count
        );
    } else {
        // 7b. The clean case.
        d.remedy = StaleRemedy::FastForward;
        d.cause = format!(
            "{} commit(s) behind {}; a fast-forward brings it up to date without touching any \
             local work",
            d.behind, d.base
        );
    }

    // Auto-advance ONLY the provably-safe shape. A feature branch is never auto-advanced: the user
    // chose to be on it, and moving it under them is a surprise even when it is technically safe.
    // `dirty_known` is load-bearing, not belt-and-braces: without it a FAILED `git status` reads as
    // a clean tree and this predicate advances a checkout nobody verified (roborev 59436).
    d.auto_safe = d.remedy == StaleRemedy::FastForward
        && d.head_branch == d.default_branch
        && dirty_known
        && d.dirty_count == 0
        && d.can_fast_forward
        && !d.unknown;
    d
}

/// `git()` wraps a failure as `git <args> failed: <stderr>`. Peel that back so the panel shows
/// git's OWN words — for the dirty fast-forward the whole point is that git's refusal names the
/// file at stake more accurately than any pre-check we could write.
fn git_words(e: &str) -> String {
    match e.split_once(" failed: ") {
        Some((_, msg)) if !msg.trim().is_empty() => msg.trim().to_string(),
        _ => e.trim().to_string(),
    }
}

/// Behind count after an action, falling back to `fallback` when the base stops resolving — so a
/// suddenly-unknown reading can never render as "now up to date".
fn behind_after(root: &str, default_branch: &str, threshold: u32, fallback: u32) -> u32 {
    let s = root_staleness_at(root, default_branch, threshold);
    if s.unknown { fallback } else { s.behind }
}

/// Core (AppHandle-free, testable): DO the safe thing for `root`, or refuse and say why.
///
/// Re-diagnoses first and acts on THAT reading, never on one handed in. The panel may have sat open
/// for minutes while the fleet committed, merged and fetched underneath it, and acting on a stale
/// diagnosis is exactly how a "safe" fast-forward becomes a surprise.
pub fn remedy_at(root: &str, default_branch: &str, threshold: u32) -> RemedyOutcome {
    let d = diagnose_at(root, default_branch, threshold);
    let before = d.behind;
    let refuse = |reason: String| RemedyOutcome {
        ok: false,
        reason,
        action: String::new(),
        before_behind: before,
        after_behind: before,
    };
    let ff = format!("merge --ff-only {}", d.base);

    match d.remedy {
        // Verdicts, not buttons. `cause` already says why in one sentence, so say exactly that
        // rather than inventing a second wording that can drift from the panel's.
        StaleRemedy::None
        | StaleRemedy::Unknown
        | StaleRemedy::BlockedDiverged
        | StaleRemedy::BlockedHeldElsewhere
        | StaleRemedy::BlockedDetached => refuse(d.cause.clone()),

        // NOT `pull` — that fetches, and this module never touches the network. The dirty variant
        // runs the SAME command deliberately: git refuses a fast-forward that would clobber a local
        // change, and its refusal is more accurate than any pre-check of ours.
        StaleRemedy::FastForward | StaleRemedy::FastForwardDirty => {
            let (ok, reason) = match git(root, &["merge", "--ff-only", &d.base]) {
                Ok(_) => (true, String::new()),
                Err(e) => (false, git_words(&e)),
            };
            RemedyOutcome {
                ok,
                reason,
                action: ff,
                before_behind: before,
                after_behind: behind_after(root, default_branch, threshold, before),
            }
        }

    }
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

/// Why a project root is behind, and what may safely be done about it.
#[tauri::command]
pub async fn repo_stale_diagnose(root: String) -> Result<StaleDiagnosis, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let threshold = crate::config::for_project(&root).config.freshness.staleness_warn_commits;
        let default_branch = crate::worktree::resolve_default_branch(&root);
        diagnose_at(&root, &default_branch, threshold)
    })
    .await
    .map_err(|e| format!("repo_stale_diagnose: {e}"))
}

/// Apply the safe remedy for a stale project root — or refuse, and say why.
#[tauri::command]
pub async fn repo_stale_remedy(root: String) -> Result<RemedyOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let threshold = crate::config::for_project(&root).config.freshness.staleness_warn_commits;
        let default_branch = crate::worktree::resolve_default_branch(&root);
        remedy_at(&root, &default_branch, threshold)
    })
    .await
    .map_err(|e| format!("repo_stale_remedy: {e}"))
}

/// `[freshness].auto_fast_forward` for this project — may a provably-safe checkout be advanced with
/// no click? `get_config` already carries the whole section; this is one round trip for the single
/// bit the panel branches on, resolved for THIS root's project overlay.
#[tauri::command]
pub async fn repo_auto_fast_forward(root: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::config::for_project(&root).config.freshness.auto_fast_forward
    })
    .await
    .map_err(|e| format!("repo_auto_fast_forward: {e}"))
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

    // ── diagnose_at / remedy_at ───────────────────────────────────────────────────────────────

    /// A repo whose tree sits `n` commits behind a real `origin/main`. Every diagnosis test starts
    /// here, because a checkout that is NOT behind classifies as `None` no matter what else is
    /// wrong with it — the drift has to be real for the cause to mean anything.
    fn behind_by(
        tag: &str,
        n: usize,
    ) -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir, String) {
        let (d, up, root) = repo_with_origin(tag);
        let pusher = advance_origin(up.path().to_str().unwrap(), n);
        git(&root, &["fetch", "-q", "origin"]).unwrap();
        (d, up, pusher, root)
    }

    fn canon(p: &str) -> String {
        std::fs::canonicalize(p).unwrap().to_string_lossy().to_string()
    }

    // 1. The ordinary case — and the ONLY shape allowed to move without a click.
    #[test]
    fn a_clean_default_branch_behind_its_base_is_an_auto_safe_fast_forward() {
        let (_d, _up, _p, root) = behind_by("diag-ff", 3);

        let d = diagnose_at(&root, "main", 25);
        assert_eq!(d.remedy, StaleRemedy::FastForward);
        assert!(d.auto_safe, "clean + on the default branch + strict ancestor is the safe shape");
        assert!(d.can_fast_forward);
        assert_eq!(d.behind, 3);
        assert_eq!(d.dirty_count, 0);
        assert_eq!(d.head_branch, "main");
        assert_eq!(d.base, "origin/main");
        assert!(!d.detached);
        assert!(!d.linked_worktree, "the main checkout's .git is a directory");
        assert!(!d.unknown);
    }

    // 2. Local work in the way. Still attemptable, never automatic.
    #[test]
    fn uncommitted_work_downgrades_the_fast_forward_and_is_named_in_the_sample() {
        let (_d, _up, _p, root) = behind_by("diag-dirty", 2);
        std::fs::write(format!("{root}/f.txt"), "LOCAL EDIT\n").unwrap();
        std::fs::write(format!("{root}/scratch.txt"), "untracked\n").unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert_eq!(d.remedy, StaleRemedy::FastForwardDirty);
        assert!(!d.auto_safe, "a dirty tree is never advanced without a click");
        assert_eq!(d.dirty_count, 2, "one modified tracked file and one untracked file");
        // The PATHS, not merely a non-empty vec: a fixed-offset parse would mangle the FIRST line's
        // filename (git()'s trim eats its leading space) and a length check would not notice.
        assert!(d.dirty_sample.contains(&"f.txt".to_string()), "got {:?}", d.dirty_sample);
        assert!(d.dirty_sample.contains(&"scratch.txt".to_string()), "got {:?}", d.dirty_sample);
        assert!(d.cause.contains('2'), "the cause names the count: {}", d.cause);
    }

    // 3. THE CASE THIS FEATURE EXISTS FOR — a REAL linked worktree with a detached HEAD while the
    // parent holds `main`. It can never track the branch, so no button can fix it and the panel
    // must say so, naming the holder. Built with `git worktree add --detach` rather than a faked
    // `.git` file: a hand-built fixture would only prove the parser works, not that this is caught.
    #[test]
    fn a_detached_linked_worktree_whose_parent_holds_the_branch_is_blocked_not_actionable() {
        let (_d, _up, _p, parent) = behind_by("diag-held", 4);
        let holder = unique_root("diag-held-linked");
        let linked = holder.path().join("wt");
        git(&parent, &["worktree", "add", "--detach", linked.to_str().unwrap()]).unwrap();
        let linked = linked.to_str().unwrap().to_string();

        let d = diagnose_at(&linked, "main", 25);
        assert_eq!(d.remedy, StaleRemedy::BlockedHeldElsewhere);
        assert!(d.detached, "`--detach` leaves it on no branch");
        assert!(d.linked_worktree, "a linked worktree's .git is a FILE, not a directory");
        assert_eq!(canon(&d.held_by), canon(&parent), "the PARENT is what holds `main`");
        assert!(!d.auto_safe);
        assert!(d.behind > 0, "it really is behind — otherwise nothing would be classified");
        // The panel renders `cause` verbatim, so the holding path has to be IN it: "blocked" with
        // no named holder leaves the user with nowhere to go.
        assert!(d.cause.contains(&d.held_by), "cause must name the holder: {}", d.cause);
    }

    // 4. Detached with the branch free. NAMED, NOT OFFERED — the button was deliberately removed
    //    (roborev 59436): `can_fast_forward` is measured against the detached head, so a
    //    "checkout `main` then fast-forward" action moves a commit the precondition never checked,
    //    and a diverged local `main` would let the checkout succeed (claiming the branch) before
    //    the fast-forward failed. The cause has to name the manual step instead.
    #[test]
    fn a_detached_head_with_the_branch_free_is_named_but_offered_no_button() {
        let (_d, _up, _p, root) = behind_by("diag-detached", 2);
        let head = git(&root, &["rev-parse", "HEAD"]).unwrap();
        git(&root, &["checkout", "-q", "--detach", &head]).unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert_eq!(d.remedy, StaleRemedy::BlockedDetached);
        assert!(d.detached);
        assert_eq!(d.held_by, "", "detaching the only worktree leaves `main` held by nobody");
        assert!(!d.auto_safe);
        // The panel renders `cause` verbatim and shows no control for a blocked verdict, so the
        // sentence is the ONLY place the user learns what to do.
        assert!(d.cause.contains("git checkout main"), "cause must name the step: {}", d.cause);

        // And the remedy REFUSES rather than half-landing a branch claim.
        let before = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let out = remedy_at(&root, "main", 25);
        assert!(!out.ok, "a detached checkout is never advanced from here");
        assert_eq!(out.action, "", "nothing was run");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), before, "HEAD must not move");
    }

    // 4b. THE PROBE THAT MUST FAIL CLOSED. `git status` failing used to read as a clean tree, which
    //     fed `auto_safe` and would have advanced a checkout nobody verified. An `index.lock` is the
    //     realistic trigger on this machine — a fleet plus a 60s poll run git constantly.
    #[test]
    fn a_working_tree_we_could_not_read_is_never_treated_as_clean() {
        let (_d, _up, _p, root) = behind_by("diag-statusfail", 3);

        // Sanity: clean and auto-safe BEFORE the probe is broken, so the assertion below is a real
        // change and not a state this repo was already in.
        let ok = diagnose_at(&root, "main", 25);
        assert_eq!(ok.remedy, StaleRemedy::FastForward);
        assert!(ok.auto_safe, "a clean checkout on main is the auto-safe shape");

        // Replacing `.git/index` with a DIRECTORY makes `git status` die with
        // "unable to map index file" while `rev-parse`/`rev-list`/`merge-base` — which never read
        // the index — keep working. So ONLY the cleanliness probe fails, which is the whole point:
        // the tree on disk is still genuinely clean, and the verdict must still refuse to say so.
        // (An `index.lock` does NOT do this; `status` succeeds anyway. Verified, not assumed.)
        std::fs::remove_file(format!("{root}/.git/index")).unwrap();
        std::fs::create_dir(format!("{root}/.git/index")).unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert!(!d.auto_safe, "an unreadable tree must never be auto-advanced");
        assert_eq!(d.remedy, StaleRemedy::FastForwardDirty, "not provably clean => treated as dirty");
        assert!(
            d.cause.contains("could not be read"),
            "the user has to be told the tree was not readable: {}",
            d.cause
        );
    }

    // 5. Diverged: a fast-forward would DESTROY the local commit, so it classifies as blocked and
    // the remedy refuses. The HEAD sha is asserted byte-identical across that refusal.
    #[test]
    fn a_diverged_checkout_is_blocked_and_the_remedy_leaves_head_untouched() {
        let (_d, _up, _p, root) = behind_by("diag-diverged", 2);
        std::fs::write(format!("{root}/local.txt"), "work only I have\n").unwrap();
        git(&root, &["add", "-A"]).unwrap();
        git(&root, &["commit", "-q", "-m", "local only"]).unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert_eq!(d.remedy, StaleRemedy::BlockedDiverged);
        assert!(!d.can_fast_forward, "HEAD is not an ancestor of origin/main any more");
        assert!(!d.auto_safe);

        let before = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let out = remedy_at(&root, "main", 25);
        assert!(!out.ok, "must refuse rather than lose the local commit");
        assert_eq!(out.action, "", "a refusal runs NOTHING");
        assert_eq!(out.after_behind, out.before_behind);
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), before, "HEAD must not move");
    }

    // 6. Fail-closed, the same posture as the badge: no base means no claim.
    #[test]
    fn an_unresolvable_base_is_unknown_not_a_remedy() {
        let d = unique_root("diag-unknown");
        let root = d.path().to_str().unwrap().to_string();
        git(&root, &["init", "-q"]).unwrap();
        git(&root, &["config", "user.email", "t@t"]).unwrap();
        git(&root, &["config", "user.name", "t"]).unwrap();
        git(&root, &["commit", "-q", "--allow-empty", "-m", "init"]).unwrap();
        git(&root, &["branch", "-M", "main"]).unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert!(d.unknown);
        assert_eq!(d.remedy, StaleRemedy::Unknown);
        assert_eq!(d.behind, 0);
        assert_eq!(d.base, "", "no base was used");
        assert!(!d.auto_safe);
        assert!(d.cause.contains("origin/main"), "cause names what did not resolve: {}", d.cause);

        let out = remedy_at(&root, "main", 25);
        assert!(!out.ok);
        assert_eq!(out.action, "");
    }

    // 7. A feature branch may be safely fast-forwarded, but is NEVER advanced without a click: the
    // user chose to be there, and moving it under them is a surprise even when it is safe.
    #[test]
    fn a_feature_branch_is_fast_forwardable_but_never_auto_safe() {
        let (_d, _up, _p, root) = behind_by("diag-feature", 3);
        git(&root, &["checkout", "-q", "-b", "feature/x"]).unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert_eq!(d.remedy, StaleRemedy::FastForward);
        assert!(d.can_fast_forward, "it is still a strict ancestor of origin/main");
        assert_eq!(d.dirty_count, 0);
        assert_eq!(d.head_branch, "feature/x");
        assert!(!d.auto_safe, "head_branch != default_branch, so no automatic advance");
    }

    // 8. The remedy actually WORKS — asserting the side effect, not merely an ok:true.
    #[test]
    fn the_remedy_advances_a_clean_checkout_to_its_base() {
        let (_d, _up, _p, root) = behind_by("remedy-ff", 3);
        let base_sha = git(&root, &["rev-parse", "origin/main"]).unwrap();

        let out = remedy_at(&root, "main", 25);
        assert!(out.ok, "reason was: {}", out.reason);
        assert_eq!(out.action, "merge --ff-only origin/main", "NOT `pull` — that would fetch");
        assert_eq!(out.before_behind, 3);
        assert_eq!(out.after_behind, 0, "the count must actually close");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), base_sha, "HEAD is now the base");
    }

    // 9. The blocked case refuses at the REMEDY layer too, not only in the classification.
    #[test]
    fn the_remedy_refuses_a_worktree_whose_branch_is_held_elsewhere() {
        let (_d, _up, _p, parent) = behind_by("remedy-held", 2);
        let holder = unique_root("remedy-held-linked");
        let linked = holder.path().join("wt");
        git(&parent, &["worktree", "add", "--detach", linked.to_str().unwrap()]).unwrap();
        let linked = linked.to_str().unwrap().to_string();

        let before = git(&linked, &["rev-parse", "HEAD"]).unwrap();
        let out = remedy_at(&linked, "main", 25);
        assert!(!out.ok);
        assert_eq!(out.action, "", "never attempts `checkout --detach` — that button never ends");
        assert_eq!(out.after_behind, out.before_behind);
        assert!(out.before_behind > 0);
        assert!(out.reason.contains("held by"), "the refusal explains itself: {}", out.reason);
        assert_eq!(git(&linked, &["rev-parse", "HEAD"]).unwrap(), before);
    }

    // 10. The deliberate choice: when a fast-forward would clobber local work we let GIT refuse and
    // hand its own words back, rather than pre-guessing which file is in the way.
    #[test]
    fn a_clobbering_fast_forward_fails_with_gits_own_refusal() {
        let (_d, _up, _p, root) = behind_by("remedy-clobber", 1);
        // origin advanced f.txt; editing that same file locally is what git will refuse over.
        std::fs::write(format!("{root}/f.txt"), "LOCAL EDIT\n").unwrap();
        assert_eq!(diagnose_at(&root, "main", 25).remedy, StaleRemedy::FastForwardDirty);

        let out = remedy_at(&root, "main", 25);
        assert!(!out.ok, "git must refuse this one");
        assert_eq!(out.action, "merge --ff-only origin/main", "attempted, not pre-refused");
        assert!(
            out.reason.to_lowercase().contains("local changes"),
            "reason is git's own stderr, not our guess: {}",
            out.reason
        );
        // ...and the local edit survived.
        assert_eq!(std::fs::read_to_string(format!("{root}/f.txt")).unwrap(), "LOCAL EDIT\n");
    }
}

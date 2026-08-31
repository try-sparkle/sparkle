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
    /// Entries in `status --porcelain -z --untracked-files=all` — one per changed path, and one
    /// (not two) for a rename, which nonetheless contributes BOTH of its paths to the dirt list
    /// that `blocking_paths` is computed from.
    pub dirty_count: u32,
    /// Up to 5 of those paths, path only — enough for the panel to show what is at stake.
    pub dirty_sample: Vec<String>,
    /// THE PATHS THAT WOULD ACTUALLY STOP THE FAST-FORWARD, and nothing else.
    ///
    /// `dirty_count > 0` is NOT a reason to refuse: git only declines a fast-forward over dirt it
    /// would itself touch. This is the intersection that decides it — the dirty paths that are also
    /// changed between `HEAD` and `base`. Empty (with `blockers_known`) means `merge --ff-only`
    /// provably cannot refuse and provably cannot lose anything, whatever `dirty_count` says.
    ///
    /// Measured on the founder's shared checkout (bead sparkle-v38y1n): of five dirty entries
    /// exactly ONE was a true blocker, and the whole-tree `dirty_count == 0` rule had therefore
    /// been declining a provably-safe fast-forward every 60 seconds for ten days — 1,175 commits
    /// of drift, silently. Named rather than counted because "dirty tree" is the useless string the
    /// escalation must never show: the person needs the path.
    pub blocking_paths: Vec<String>,
    /// Whether `blocking_paths` could be computed AT ALL. False means WE DO NOT KNOW — never
    /// "there are none". Fail-closed, exactly like `dirty_count`'s unreadable-tree case.
    pub blockers_known: bool,
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

/// Uncommitted work in `root`: the number of status ENTRIES, and EVERY path each one touches.
///
/// Every path, not a sample: `blocking_paths_at` intersects this with what the fast-forward
/// changes, and an intersection computed against the first five entries would call the sixth
/// blocker "no blocker" — the unsafe direction. The panel's 5-item `dirty_sample` is taken from
/// the head of this list instead.
///
/// NUL-DELIMITED, AND THAT IS THE WHOLE POINT (roborev 66791). `git status --porcelain` C-QUOTES
/// any path git considers special — `"src/a\"b.rs"`, `"caf\303\251.rs"`, and under the default
/// `core.quotePath` a plain space too — while the `git diff --name-only` on the other side of
/// `blocking_paths_at`'s intersection quotes by its own rules. Two spellings of ONE path do not
/// intersect: the collision goes unreported and `auto_safe` reads TRUE for a tree that genuinely
/// collides. `-z` disables C-quoting outright, on both sides, which removes the whole class rather
/// than unquoting after the fact — an unquoter is one more parser that can be wrong in the
/// fail-OPEN direction.
///
/// BOTH HALVES OF A RENAME ARE DIRTY. In `-z` a rename is `XY <to>\0<from>\0`: two NUL-terminated
/// fields, the `->` omitted and the order REVERSED from the human format's `R  old -> new`
/// (verified against real git rather than assumed). The old parser kept only the destination, so a
/// rename whose SOURCE the base also changes read as no blocker at all — even though the merge
/// would have to remove that source out from under the rename.
///
/// `None` means THE PROBE FAILED OR WE COULD NOT READ IT — never "clean". This returned
/// `(0, vec![])` on error once, which is byte-identical to a clean tree, and that value feeds
/// `auto_safe`: a failed `git status` (`index.lock` contention is the realistic trigger here, where
/// a fleet and a 60s poll run git constantly) would have produced `FastForward` + `auto_safe`, and
/// a tree whose cleanliness was never established would be advanced with no click. Every other
/// probe in this module fails closed to `unknown`; this one does too (roborev 59436). A record we
/// cannot parse takes the same exit, for the same reason.
fn dirty_at(root: &str) -> Option<(u32, Vec<String>)> {
    let Ok(out) = git(root, &["status", "--porcelain", "-z", "--untracked-files=all"]) else {
        return None;
    };
    if !decodable(&out) {
        return None;
    }
    let mut count = 0u32;
    let mut paths = Vec::new();
    // The trailing NUL leaves one empty piece; a genuine field is never empty.
    let mut fields = out.split('\0').filter(|f| !f.is_empty());
    while let Some(rec) = fields.next() {
        let (xy, path) = split_status_record(rec)?;
        count = count.saturating_add(1);
        paths.push(path.to_string());
        if xy.contains('R') || xy.contains('C') {
            // The origin half: its own NUL field, carrying no status prefix. Missing means a shape
            // we do not understand, and dropping it silently is exactly the fail-open this fixes.
            paths.push(fields.next()?.to_string());
        }
    }
    Some((count, paths))
}

/// Whether `git()`'s lossy UTF-8 decode gave us the bytes git actually printed.
///
/// A path with non-UTF-8 bytes in it arrives as U+FFFD, and a mangled path cannot be compared with
/// the other side of the intersection — so it would silently MISS, which is a blocker reported as
/// no blocker. U+FFFD in a real filename is vanishingly rare and refusing to auto-advance over one
/// costs a click; the other direction costs the work in the tree.
fn decodable(out: &str) -> bool {
    !out.contains('\u{FFFD}')
}

/// `XY <path>` out of ONE `-z` status field: the two status columns, then the path.
///
/// NOT a fixed 3-byte strip. `git()` trims the WHOLE output, so an unstaged `" M path"` loses its
/// leading space on the FIRST record only, and a blind 3-byte strip would eat a character of that
/// one path while leaving every other record correct — the kind of bug a "the sample is non-empty"
/// assertion hides. `None` = a shape we cannot read, which every caller turns into
/// `blockers_known: false`.
fn split_status_record(rec: &str) -> Option<(&str, &str)> {
    let b = rec.as_bytes();
    // Bytes 0..=2 of a status record are ASCII, so these slices are always char boundaries.
    if b.len() > 3 && b[2] == b' ' {
        Some((&rec[..2], &rec[3..]))
    } else if b.len() > 2 && b[1] == b' ' {
        // The first record, with its leading space already trimmed off by `git()`.
        Some((&rec[..1], &rec[2..]))
    } else {
        None
    }
}

/// The spelling both sides of the intersection are compared in.
///
/// `git()` trims the whole output, so a path that begins with a space loses it on whichever side
/// prints that path first — `status` hides it behind the `XY ` columns, `diff --name-only` does
/// not. Normalising the leading space away on BOTH sides makes such a path over-match rather than
/// under-match, and over-reporting a blocker is the only direction this predicate is allowed to be
/// wrong in.
fn cmp_key(p: &str) -> &str {
    p.trim_start_matches(' ')
}

/// The dirty paths this fast-forward would ACTUALLY collide with, or `None` if we could not tell.
///
/// WHY AN INTERSECTION IS THE RIGHT PREDICATE, and a count is not. `git merge --ff-only` is
/// `read-tree -m -u HEAD <base>` underneath, and read-tree walks only the paths that DIFFER between
/// the two trees. Dirt anywhere else is invisible to it. Verified against real git on eight shapes
/// (bead sparkle-v38y1n) — a modified tracked file the base also changes, a staged one, an
/// untracked file at a path the base creates: all refused. A stray untracked file, an untracked
/// subdirectory, a modified or staged tracked file the base leaves alone: all fast-forwarded
/// cleanly. This set matched git's verdict on every one of them.
///
/// ONE set covers both tracked and untracked dirt, because a path the base CREATES is by definition
/// a path that differs between `HEAD` and `base`. `--no-renames` is load-bearing: with rename
/// detection on, `--name-only` prints only the destination of a rename, so the vanished source path
/// would not be listed and dirt sitting on it would read as safe.
///
/// `-z` HERE FOR THE SAME REASON IT IS ON THE OTHER SIDE (roborev 66791). An intersection is only
/// as good as the two spellings it compares, so both probes have to be in the SAME representation —
/// and NUL-delimited is the only one neither side can quote. Reading this side unquoted while
/// `dirty_at` read the other side C-quoted is precisely how a real collision went unmatched and
/// `auto_safe` went true over it.
///
/// `None` is NOT "no blockers" — it is "we could not look", and the caller must treat it as
/// blocking. Same posture as `dirty_at`.
fn blocking_paths_at(root: &str, base: &str, dirty_paths: &[String]) -> Option<Vec<String>> {
    // No dirt at all: nothing to intersect, and no reason to pay for a whole-repo diff on the
    // clean path this runs on most often.
    if dirty_paths.is_empty() {
        return Some(Vec::new());
    }
    let changed = git(root, &["diff", "--name-only", "-z", "--no-renames", "HEAD", base]).ok()?;
    if !decodable(&changed) {
        return None;
    }
    let changed: std::collections::HashSet<&str> =
        changed.split('\0').map(cmp_key).filter(|p| !p.is_empty()).collect();
    let mut hit: Vec<String> =
        dirty_paths.iter().filter(|p| changed.contains(cmp_key(p))).cloned().collect();
    hit.sort();
    hit.dedup();
    Some(hit)
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
            blocking_paths: Vec::new(),
            // We never got as far as looking, so this is "unknown", not "none".
            blockers_known: false,
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
    let (dirty_count, dirty_paths) = dirty.unwrap_or((0, Vec::new()));
    let dirty_sample: Vec<String> = dirty_paths.iter().take(5).cloned().collect();
    // Which of that dirt the fast-forward would actually collide with. `None` = could not tell,
    // which is treated as blocking — a checkout whose collisions we never established is not one
    // an unattended timer may advance.
    let blockers = blocking_paths_at(root, &s.base, &dirty_paths);
    let blockers_known = dirty_known && blockers.is_some();
    let blocking_paths = blockers.unwrap_or_default();
    let mut d = StaleDiagnosis {
        behind: s.behind,
        base: s.base.clone(),
        head_branch,
        default_branch: default_branch.to_string(),
        detached,
        // CLASSIFICATION, NOT LIVENESS — deliberately the other helper (bead sparkle-tm4blm).
        //
        // This field means "linked worktree rather than main checkout", and a pruned HUSK is still
        // linked-shaped even though `git` can no longer answer in it. Routing this through
        // `is_live_worktree` would answer a question nobody asked here and misreport a dead linked
        // worktree as a MAIN CHECKOUT, which is a second wrong answer rather than a fix.
        //
        // A husk cannot reach this line at all: `root_staleness_at` above runs `git` in `root`,
        // which fails in a husk, so arm 1 has already returned `unknown` with `linked_worktree:
        // false`. That ordering is what makes the distinction safe, and it is asserted by
        // `a_pruned_husk_is_unknown_and_never_reaches_the_linked_worktree_classification`.
        linked_worktree: crate::worktree_liveness::is_linked_worktree(std::path::Path::new(root)),
        held_by: held_by_at(root, default_branch),
        dirty_count,
        dirty_sample,
        blocking_paths,
        blockers_known,
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
        // 7a. On a branch and fast-forwardable, WITH local work present — which is not by itself a
        // reason to refuse. `blocking_paths` is what decides, and the sentence has to carry the
        // paths: "dirty tree" is exactly the string that let ten days of drift go unexplained.
        d.remedy = StaleRemedy::FastForwardDirty;
        d.cause = if !d.blockers_known {
            format!(
                "{} commit(s) behind {}, with {} uncommitted change(s) here — and we could not work \
                 out which of them this fast-forward would touch, so it is not treated as safe. A \
                 fast-forward will be attempted and git will refuse it if it would clobber one",
                d.behind, d.base, d.dirty_count
            )
        } else if d.blocking_paths.is_empty() {
            format!(
                "{} commit(s) behind {}, with {} uncommitted change(s) here — none of which this \
                 fast-forward touches, so it cannot clobber any of them",
                d.behind, d.base, d.dirty_count
            )
        } else {
            format!(
                "{} commit(s) behind {}; the fast-forward is blocked by {} of the {} uncommitted \
                 change(s) here, because {} also changes {}: {}",
                d.behind,
                d.base,
                d.blocking_paths.len(),
                d.dirty_count,
                d.base,
                if d.blocking_paths.len() == 1 { "it" } else { "them" },
                d.blocking_paths.join(", "),
            )
        };
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
    //
    // "PROVABLY SAFE" IS ABOUT COLLISIONS, NOT ABOUT CLEANLINESS (bead sparkle-v38y1n). This used to
    // read `d.dirty_count == 0`, which treats any dirt anywhere as blocking — and git does not: it
    // refuses a fast-forward only over paths it would itself touch. On the founder's shared checkout
    // that cost 1,175 commits of drift over ten days, because a stray `NOTES.md` and an untracked
    // `images/` subdirectory that block precisely nothing kept the 60-second timer declining a merge
    // git would have taken every single time. `blocking_paths` is the same question asked precisely,
    // and it agreed with real git on all eight shapes it was measured against.
    //
    // THE FAIL-CLOSED CLAUSES. `blockers_known`: an intersection we could not compute is not one
    // that found nothing — and it is false whenever `git status` did not answer, so a FAILED status
    // still cannot read as a clean tree (roborev 59436). `dirty_known` is therefore REDUNDANT with
    // it today, measured: removing this line alone leaves the suite green. It stays anyway, and the
    // redundancy is the point — it is the rule stated where the rule is decided, so a later change
    // to how `blockers_known` is derived cannot quietly take the status probe out of the predicate.
    // `head_branch == default_branch`: a feature branch is never auto-advanced.
    d.auto_safe = matches!(d.remedy, StaleRemedy::FastForward | StaleRemedy::FastForwardDirty)
        && d.head_branch == d.default_branch
        && dirty_known
        && d.blockers_known
        && d.blocking_paths.is_empty()
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
///
/// `unattended` is the CALLER'S POLICY, and it exists because the re-diagnosis above is the very
/// thing that makes it necessary. See the guard below.
pub fn remedy_at(
    root: &str,
    default_branch: &str,
    threshold: u32,
    unattended: bool,
) -> RemedyOutcome {
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

    // AN UNATTENDED CALL GETS ONLY THE PROVABLY-SAFE SHAPE, judged on THIS reading.
    //
    // The timer checks `auto_safe` before it calls, but that answer is older than this one by a
    // diagnosis and a config round trip — and this function deliberately ignores what it was handed
    // and re-classifies. So the fresh verdict can be `FastForwardDirty`, which the automation rule
    // states is offerable on a click and NEVER automatic, and the merge would run anyway because
    // nothing down here knew no human was watching. That is a timer writing to a tree the user had
    // just started editing (knightwatch 5207191879#1, 5209038072#1).
    //
    // Checked against `auto_safe` rather than the remedy kind so this cannot drift from the rule:
    // `auto_safe` is the one definition of "cannot possibly lose anything", and it already means
    // NO BLOCKING PATH + on the default branch + a strict ancestor. Note what it no longer means:
    // "clean". Dirt the fast-forward would not touch stops nothing, so a `FastForwardDirty` verdict
    // with an empty (and KNOWN) blocking set is automatic — see the predicate above.
    if unattended && !d.auto_safe {
        return refuse(d.cause.clone());
    }

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
pub async fn repo_stale_remedy(
    root: String,
    // Absent or false = a click. True = the background poll, which may only ever advance a checkout
    // that is STILL `auto_safe` on the re-diagnosis inside `remedy_at`. `Option` so an older
    // frontend (or any caller that omits it) gets the CLICK policy — the safe default is the one
    // that refuses nothing the user asked for; the unattended path has to opt IN to the restriction.
    unattended: Option<bool>,
) -> Result<RemedyOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let threshold = crate::config::for_project(&root).config.freshness.staleness_warn_commits;
        let default_branch = crate::worktree::resolve_default_branch(&root);
        remedy_at(&root, &default_branch, threshold, unattended.unwrap_or(false))
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

    /// Advance `origin/main` by one commit that CREATES `name`, without moving the local checkout.
    ///
    /// `advance_origin` only ever rewrites `f.txt`, so it cannot express the one shape a naive
    /// "just ignore untracked files" implementation gets wrong: an UNTRACKED file sitting exactly
    /// where the base is about to put a tracked one. Same throwaway-clone mechanism, one different
    /// path.
    fn advance_origin_creating(origin_path: &str, name: &str) -> tempfile::TempDir {
        let wc = unique_root("pusher-create");
        let w = wc.path().to_str().unwrap().to_string();
        git(&w, &["clone", "-q", origin_path, "."]).unwrap();
        git(&w, &["config", "user.email", "t@t"]).unwrap();
        git(&w, &["config", "user.name", "t"]).unwrap();
        std::fs::write(format!("{w}/{name}"), "from the base\n").unwrap();
        git(&w, &["add", "-A"]).unwrap();
        git(&w, &["commit", "-q", "-m", &format!("create {name}")]).unwrap();
        git(&w, &["push", "-q", "origin", "main"]).unwrap();
        wc
    }

    /// Advance `origin/main` by one commit creating EVERY named path, parent dirs and all.
    ///
    /// The singular version above cannot express the C-quoting fixture: that needs several paths
    /// whose names git would escape, all created by the SAME base commit, so the assertion is about
    /// the whole intersection rather than about one lucky match.
    fn advance_origin_creating_many(origin_path: &str, names: &[&str]) -> tempfile::TempDir {
        let wc = unique_root("pusher-create-many");
        let w = wc.path().to_str().unwrap().to_string();
        git(&w, &["clone", "-q", origin_path, "."]).unwrap();
        git(&w, &["config", "user.email", "t@t"]).unwrap();
        git(&w, &["config", "user.name", "t"]).unwrap();
        for name in names {
            let path = std::path::Path::new(&w).join(name);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).unwrap();
            }
            std::fs::write(&path, "from the base\n").unwrap();
        }
        git(&w, &["add", "-A"]).unwrap();
        git(&w, &["commit", "-q", "-m", "create many"]).unwrap();
        git(&w, &["push", "-q", "origin", "main"]).unwrap();
        wc
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

    // 2b. THE HUSK, AND WHY THIS SITE IS CLASSIFICATION RATHER THAN LIVENESS (bead sparkle-tm4blm).
    //
    // `linked_worktree` is set from `is_linked_worktree`, not `is_live_worktree`, and this pins the
    // ordering that makes that safe: a pruned husk never reaches the classification at all, because
    // every `git` probe in it fails and arm 1 returns `unknown` first. The SIDE EFFECT asserted is
    // the panel's: a husk is reported as UNMEASURABLE, so no remedy button is offered for a
    // directory in which no remedy could run — rather than being classified and given one.
    //
    // Move the classification above the `unknown` gate, or swap the helper for `is_live_worktree`,
    // and one of these assertions goes red.
    #[test]
    fn a_pruned_husk_is_unknown_and_never_reaches_the_linked_worktree_classification() {
        let holder = unique_root("diag-husk");
        let husk = holder.path().join("husk");
        std::fs::create_dir_all(&husk).unwrap();
        // `git worktree prune` leaves the pointer FILE and removes the gitdir it names.
        std::fs::write(husk.join(".git"), "gitdir: /nowhere/that/exists/.git/worktrees/x\n")
            .unwrap();
        assert!(husk.join(".git").exists(), "precondition: the husk passes the OLD `.exists()`");

        let d = diagnose_at(husk.to_str().unwrap(), "main", 25);
        assert!(d.unknown, "no git probe can answer in a husk, so nothing may be claimed about it");
        assert_eq!(d.remedy, StaleRemedy::Unknown, "and no button is offered");
        assert!(
            !d.linked_worktree,
            "the unknown arm reports false — the classification below it is never reached"
        );

        // The classifier itself, on the same husk, still says LINKED — which is the correct answer
        // to the question it asks, and is why this site must not use the liveness helper.
        assert!(
            crate::worktree_liveness::is_linked_worktree(&husk),
            "a husk is a DEAD worktree, but it was never a main checkout"
        );
        assert!(
            !crate::worktree_liveness::is_live_worktree(&husk),
            "…and it is not live, which is the other question"
        );
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
        let out = remedy_at(&root, "main", 25, false);
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
        let out = remedy_at(&root, "main", 25, false);
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

        let out = remedy_at(&root, "main", 25, false);
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

        let out = remedy_at(&root, "main", 25, false);
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
        let out = remedy_at(&linked, "main", 25, false);
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

        let out = remedy_at(&root, "main", 25, false);
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

    // 11. THE UNATTENDED POLICY, asserted as the side effect it prevents.
    //
    // A tree that goes BLOCKING-dirty after the caller's `auto_safe` check re-classifies here as
    // not-auto-safe, and the merge must not run. Before the policy flag, `remedy_at` could not tell
    // the two callers apart and ran the merge either way, so a 60-second timer could write to a tree
    // the user had just started editing (knightwatch 5207191879#1, 5209038072#1).
    //
    // WHY THE EDIT IS IN `f.txt` AND NOT A SCRATCH FILE. It used to be an untracked `scratch.txt`,
    // and that shape is now legitimately automatic (see the blocking-set tests above) — the timer is
    // SUPPOSED to take it. The policy this test guards is about dirt that would actually be
    // clobbered, so the fixture has to carry some. The refusal asserted here is OURS, not git's:
    // `action` is empty, meaning the merge was never attempted.
    #[test]
    fn an_unattended_remedy_refuses_a_tree_that_went_dirty_after_the_callers_check() {
        let (_d, _up, _p, root) = behind_by("remedy-unattended-dirty", 2);
        // `advance_origin` rewrites f.txt, so this edit is a genuine collision.
        std::fs::write(format!("{root}/f.txt"), "started typing\n").unwrap();
        let d = diagnose_at(&root, "main", 25);
        assert_eq!(d.remedy, StaleRemedy::FastForwardDirty);
        assert_eq!(d.blocking_paths, vec!["f.txt".to_string()]);
        assert!(!d.auto_safe, "a tree with a real collision is never the automatic shape");
        let before_head = git(&root, &["rev-parse", "HEAD"]).unwrap();

        let out = remedy_at(&root, "main", 25, true);
        assert!(!out.ok, "unattended must refuse this");
        assert_eq!(out.action, "", "and must not even attempt the merge");
        assert_eq!(out.reason, d.cause, "it refuses in the diagnosis's own words");
        assert_eq!(
            git(&root, &["rev-parse", "HEAD"]).unwrap(),
            before_head,
            "THE POINT: no timer-driven commit moved this checkout",
        );

        // Now clear the collision and leave the tree dirty in a way that blocks nothing. The SAME
        // unattended call now advances it — without this half the test would stay green against a
        // `remedy_at` that had simply stopped working, or against a predicate that had gone back to
        // refusing every dirty tree.
        std::fs::write(format!("{root}/f.txt"), "one\n").unwrap();
        std::fs::write(format!("{root}/scratch.txt"), "still typing\n").unwrap();
        let out = remedy_at(&root, "main", 25, true);
        assert!(out.ok, "non-blocking dirt is automatic: {}", out.reason);
        assert_ne!(git(&root, &["rev-parse", "HEAD"]).unwrap(), before_head);
        assert_eq!(
            std::fs::read_to_string(format!("{root}/scratch.txt")).unwrap(),
            "still typing\n",
            "and the local work is still there",
        );
    }

    // ── THE PRECISE BLOCKING SET (bead sparkle-v38y1n) ────────────────────────────────────────
    //
    // These four are the arms of one predicate. `dirty_count == 0` collapsed all of them into
    // "refuse", which is why the founder's shared checkout sat 1,175 commits behind for ten days
    // while a 60-second timer declined, every minute, a merge git would have taken every time.

    // (a) THE HEADLINE BEHAVIOUR CHANGE. A stray untracked file the base does not create blocks
    //     NOTHING — git fast-forwards straight over it — so the unattended path must now take it.
    //     Under the old `dirty_count == 0` rule this diagnosed as `!auto_safe` and the merge never
    //     ran. Asserted as the SIDE EFFECT (HEAD actually moved) rather than as a flag.
    #[test]
    fn a_stray_untracked_file_the_base_does_not_create_blocks_nothing() {
        let (_d, _up, _p, root) = behind_by("blockers-stray", 3);
        // origin advanced `f.txt`; this file exists nowhere in either tree.
        std::fs::write(format!("{root}/NOTES.md"), "scratch notes\n").unwrap();
        std::fs::create_dir(format!("{root}/images")).unwrap();
        std::fs::write(format!("{root}/images/a.png"), "binary-ish\n").unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert_eq!(d.dirty_count, 2, "the tree really is dirty: {:?}", d.dirty_sample);
        assert!(d.blockers_known, "the HEAD..base diff ran");
        assert_eq!(d.blocking_paths, Vec::<String>::new(), "none of that dirt is in the way");
        assert!(d.auto_safe, "a fast-forward here cannot refuse and cannot lose anything");
        assert!(
            d.cause.contains("none of which"),
            "the sentence has to say the dirt is irrelevant: {}",
            d.cause
        );

        // THE POINT: the unattended timer now advances it, and the stray files are untouched.
        let base_sha = git(&root, &["rev-parse", "origin/main"]).unwrap();
        let out = remedy_at(&root, "main", 25, true);
        assert!(out.ok, "unattended must take this one now: {}", out.reason);
        assert_eq!(out.action, "merge --ff-only origin/main");
        assert_eq!(out.after_behind, 0, "the drift actually closed");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), base_sha);
        assert_eq!(
            std::fs::read_to_string(format!("{root}/NOTES.md")).unwrap(),
            "scratch notes\n",
            "and the local scratch file survived",
        );
    }

    // (b) A tracked modification to a file the base ALSO changes is a real blocker, it still
    //     refuses, and the refusal NAMES THAT EXACT PATH. "dirty tree" is the useless string this
    //     whole change exists to replace.
    #[test]
    fn a_modification_to_a_file_the_base_also_changes_is_named_as_the_blocker() {
        let (_d, _up, _p, root) = behind_by("blockers-collide", 2);
        // `advance_origin` rewrites f.txt, so editing it locally collides.
        std::fs::write(format!("{root}/f.txt"), "LOCAL EDIT\n").unwrap();
        // ...alongside dirt that does NOT collide, so the assertion is about the INTERSECTION and
        // not merely about "something is dirty".
        std::fs::write(format!("{root}/NOTES.md"), "scratch\n").unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert_eq!(d.dirty_count, 2);
        assert!(d.blockers_known);
        assert_eq!(d.blocking_paths, vec!["f.txt".to_string()], "ONLY the colliding path");
        assert!(!d.auto_safe, "a real collision is never advanced unattended");
        assert!(d.cause.contains("f.txt"), "the cause names the blocker: {}", d.cause);
        assert!(
            !d.cause.contains("NOTES.md"),
            "and does not blame a file that blocks nothing: {}",
            d.cause
        );

        let before = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let out = remedy_at(&root, "main", 25, true);
        assert!(!out.ok, "unattended must still refuse this");
        assert_eq!(out.action, "", "and must not even attempt the merge");
        assert!(out.reason.contains("f.txt"), "the refusal names the path: {}", out.reason);
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), before, "HEAD must not move");
        assert_eq!(std::fs::read_to_string(format!("{root}/f.txt")).unwrap(), "LOCAL EDIT\n");
    }

    // (c) THE ARM A NAIVE "IGNORE UNTRACKED FILES" IMPLEMENTATION GETS WRONG. An untracked file at
    //     a path the base CREATES is overwritten by the merge, so it is a blocker even though it is
    //     untracked and even though nothing tracked is dirty. Verified against real git: it refuses
    //     with "The following untracked working tree files would be overwritten by merge".
    #[test]
    fn an_untracked_file_where_the_base_creates_one_is_a_blocker() {
        let (_d, up, root) = repo_with_origin("blockers-untracked-collide");
        let _p = advance_origin_creating(up.path().to_str().unwrap(), "brand-new.txt");
        git(&root, &["fetch", "-q", "origin"]).unwrap();
        std::fs::write(format!("{root}/brand-new.txt"), "MINE, written first\n").unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert!(d.behind > 0, "the drift is real, so the classification means something");
        assert_eq!(d.dirty_count, 1);
        assert!(d.blockers_known);
        assert_eq!(
            d.blocking_paths,
            vec!["brand-new.txt".to_string()],
            "an untracked file the base would overwrite IS in the way",
        );
        assert!(!d.auto_safe, "untracked does not mean harmless");
        assert!(d.cause.contains("brand-new.txt"), "cause names it: {}", d.cause);

        let before = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let out = remedy_at(&root, "main", 25, true);
        assert!(!out.ok);
        assert_eq!(out.action, "", "refused before git was asked");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), before);
        // The file the user wrote is still theirs.
        assert_eq!(
            std::fs::read_to_string(format!("{root}/brand-new.txt")).unwrap(),
            "MINE, written first\n",
        );
    }

    // (d) FAIL-CLOSED, at the predicate AND at the remedy. A `git status` that does not answer
    //     leaves us with no dirt list, so the intersection is meaningless — and an EMPTY
    //     `blocking_paths` there must never be read as "no blockers". Deliberately paired with a
    //     BEFORE assertion so this cannot pass vacuously against a tree that was refusing anyway.
    #[test]
    fn an_unreadable_status_makes_the_blocking_set_unknown_not_empty() {
        let (_d, _up, _p, root) = behind_by("blockers-statusfail", 3);
        // A stray untracked file — i.e. the shape that IS auto-safe once the probe works, so the
        // assertion below is a real change and not a state this fixture was already in.
        std::fs::write(format!("{root}/NOTES.md"), "scratch\n").unwrap();
        let ok = diagnose_at(&root, "main", 25);
        assert!(ok.auto_safe, "sanity: with a working status this tree IS auto-safe");
        assert!(ok.blockers_known);

        // Replacing `.git/index` with a DIRECTORY breaks `git status` only — `rev-parse`,
        // `rev-list` and `merge-base` never read the index. (An `index.lock` does NOT do this.)
        std::fs::remove_file(format!("{root}/.git/index")).unwrap();
        std::fs::create_dir(format!("{root}/.git/index")).unwrap();

        let d = diagnose_at(&root, "main", 25);
        assert!(!d.blockers_known, "no dirt list means no trustworthy intersection");
        assert!(d.blocking_paths.is_empty(), "and the empty vec must NOT be read as 'none'");
        assert!(!d.auto_safe, "an unverifiable tree is never advanced by a timer");

        let before = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let out = remedy_at(&root, "main", 25, true);
        assert!(!out.ok, "the remedy fails closed too");
        assert_eq!(out.action, "", "nothing was run");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), before, "HEAD must not move");
    }

    // (e) THE QUOTING MISMATCH — the headline fail-OPEN this predicate had (roborev 66791).
    //
    //     `git status --porcelain` C-quotes a path with a quote, a backslash or a non-ASCII byte in
    //     it (`"src/a\"b.rs"`, `"caf\303\251.rs"`); `git diff --name-only` on the other side of the
    //     intersection did not print the same spelling back. So the two sides compared DIFFERENT
    //     strings for one path, the match missed, and a tree that genuinely collides read as
    //     `auto_safe` — a timer merging over work it had just told itself was not there.
    //
    //     Asserted through `diagnose_at`, i.e. the real production entry point, and paired with a
    //     plain-ASCII sibling in the SAME fixture: without the pair a `blocking_paths` that had
    //     stopped working entirely would look identical to one that only mishandled quoting.
    #[cfg(unix)]
    #[test]
    fn a_dirty_path_whose_name_git_would_c_quote_is_still_a_blocker() {
        let (_d, up, root) = repo_with_origin("blockers-quoted");
        // A quote, a backslash, a non-ASCII name — and one ordinary path as the control.
        let names = ["src/a\"b.rs", "back\\slash.rs", "café.rs", "plain.rs"];
        let _p = advance_origin_creating_many(up.path().to_str().unwrap(), &names);
        git(&root, &["fetch", "-q", "origin"]).unwrap();
        for name in names {
            let path = std::path::Path::new(&root).join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "MINE, written first\n").unwrap();
        }

        // THE FIXTURE HAS TO ACTUALLY EXERCISE THE BUG. Without this the test could pass on a git
        // that quotes nothing, proving the normalisation guards a case it never sees.
        let human = git(&root, &["status", "--porcelain", "--untracked-files=all"]).unwrap();
        assert!(
            human.contains("\\303\\251") && human.contains('"'),
            "the fixture must produce C-quoted output, or it is not testing this: {human}",
        );

        let d = diagnose_at(&root, "main", 25);
        assert!(d.behind > 0, "the drift is real, so the classification means something");
        assert!(d.blockers_known, "the HEAD..base diff ran");
        let mut want: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        want.sort();
        assert_eq!(
            d.blocking_paths, want,
            "EVERY path the base creates is in the way, quoted or not",
        );
        assert!(!d.auto_safe, "THE POINT: unnormalised, these silently read as a safe tree");

        let before = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let out = remedy_at(&root, "main", 25, true);
        assert!(!out.ok, "unattended must refuse this");
        assert_eq!(out.action, "", "and must not even attempt the merge");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), before, "HEAD must not move");
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&root).join("café.rs")).unwrap(),
            "MINE, written first\n",
            "and the work at the awkward path is still theirs",
        );
    }

    // (f) A RENAME'S SOURCE IS DIRT TOO. `status` reports a rename as one entry naming two paths,
    //     and keeping only the destination lost the fact that the merge would have to REMOVE the
    //     source. Here the base rewrites `f.txt` and the tree has renamed `f.txt` away, so the
    //     source is the collision and the destination is not.
    #[test]
    fn a_rename_whose_source_the_base_also_changes_is_a_blocker() {
        let (_d, _up, _p, root) = behind_by("blockers-rename", 2);
        // `advance_origin` rewrites `f.txt`, so renaming it locally collides on the SOURCE side.
        git(&root, &["mv", "f.txt", "moved.txt"]).unwrap();

        // The fixture must really be a rename, or this tests the ordinary modified-file path.
        let human = git(&root, &["status", "--porcelain", "--untracked-files=all"]).unwrap();
        assert!(human.starts_with('R'), "fixture must produce a rename entry: {human}");

        let d = diagnose_at(&root, "main", 25);
        assert_eq!(d.dirty_count, 1, "one status ENTRY, even though it names two paths");
        assert!(d.blockers_known);
        assert_eq!(
            d.blocking_paths,
            vec!["f.txt".to_string()],
            "the rename SOURCE is what the merge would have to remove",
        );
        assert!(!d.auto_safe, "so this is never the automatic shape");
        assert!(d.cause.contains("f.txt"), "and the cause names it: {}", d.cause);

        let before = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let out = remedy_at(&root, "main", 25, true);
        assert!(!out.ok, "unattended must refuse a rename off a path the base rewrites");
        assert_eq!(out.action, "", "and must not even attempt the merge");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), before, "HEAD must not move");

        // THE PAIR, and without it this test passes for a `blocking_paths` that simply refuses
        // every rename. Here the base creates an unrelated file and leaves `f.txt` alone, so the
        // SAME local rename collides with nothing and the tree stays automatic.
        let (_d2, up2, root2) = repo_with_origin("blockers-rename-free");
        let _p2 = advance_origin_creating_many(up2.path().to_str().unwrap(), &["elsewhere.txt"]);
        git(&root2, &["fetch", "-q", "origin"]).unwrap();
        git(&root2, &["mv", "f.txt", "moved.txt"]).unwrap();
        let free = diagnose_at(&root2, "main", 25);
        assert!(free.behind > 0, "the pair has to be behind too, or it classifies as None");
        assert!(free.blockers_known);
        assert_eq!(
            free.blocking_paths,
            Vec::<String>::new(),
            "a rename off a path the base never touches is in nobody's way: {free:?}",
        );
        assert!(free.auto_safe, "and is therefore still automatic");
    }

    // (g) THE PARSER FAILS CLOSED ON A SHAPE IT CANNOT READ.
    //
    //     `split_status_record` is the one place a malformed record can be silently dropped, and a
    //     dropped record is a dirty path that never reaches the intersection — a blocker reported
    //     as no blocker. `None` is what turns into `blockers_known: false` and then `auto_safe:
    //     false`; the end-to-end half of that is `an_unreadable_status_...` below.
    #[test]
    fn an_unparseable_status_record_is_none_rather_than_a_guess() {
        // The ordinary shape: two status columns, a space, the path.
        assert_eq!(split_status_record("?? café.rs"), Some(("??", "café.rs")));
        assert_eq!(split_status_record(" M plain.rs"), Some((" M", "plain.rs")));
        assert_eq!(split_status_record("R  moved.txt"), Some(("R ", "moved.txt")));
        // THE FIRST RECORD, whose leading space `git()` has already trimmed away. A fixed 3-byte
        // strip would return "lain.rs" here and every other record correctly.
        assert_eq!(split_status_record("M plain.rs"), Some(("M", "plain.rs")));
        // ...and anything else is unreadable, not a best guess.
        for bad in ["", "?", "??", "??x", "xy", "  "] {
            assert_eq!(split_status_record(bad), None, "must not guess at {bad:?}");
        }
        // A path we could not decode is unusable for the same reason: it cannot be compared.
        assert!(!decodable("?? bad-\u{FFFD}-name.txt"));
        assert!(decodable("?? café.rs"));
    }

}

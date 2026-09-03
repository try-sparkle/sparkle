//! THE INTEGRATION ASSISTANT — the END of the agent pipeline, productized: a scoped PR body, a
//! safe merge ORDER across several ready branches, a gate that consumes the repo's OWN tooling,
//! a merge that REFUSES rather than guesses, and a cleanup that runs only on proof.
//!
//! WHY THIS EXISTS (bead `.2`, epic ``). Two engineers hand-built the
//! fan-out worktree workflow this app productizes, and both stopped at `gh pr create`. Everything
//! after that — reading the checks correctly, reading roborev, deciding which of five ready
//! branches merges first, catching up onto a moved `origin/main`, and knowing the merge actually
//! landed — was left to a human with a terminal. This module is that tail.
//!
//! ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────
//!
//! IT RUNS NO CHECKS OF ITS OWN. There is exactly one local CI-parity runner in this repo, and it
//! is NOT here — bead `.1` owns `verify_gate.rs`. A second runner would be a second
//! answer to "did the tests pass", and two answers to that question is the failure this repo
//! tracks as its most expensive. So this gate consumes only what already exists:
//!
//!   * `scripts/pr-checks.sh <n>` — the ONE correct reader of a heterogeneous check rollup.
//!   * [`crate::roborev_probe`]   — the ONE reader of roborev's verdict for a branch.
//!
//! THE SEAM FOR `.1` IS [`LocalGate`], and it is a trait with exactly one method. Today
//! production passes [`NoLocalGate`], which answers [`LocalGateOutcome::NotRun`] — a THIRD state,
//! never `Pass`. That distinction is the whole point: "the local gate did not run" must not read as
//! "the local gate passed", or wiring it in later would be a silent downgrade of every verdict
//! recorded before it. When `verify_gate.rs` lands, its evidence-capturing runner implements
//! `LocalGate` and is passed in at the call site in [`integration_gate`]; nothing else moves.
//!
//! IT DOES NOT REIMPLEMENT THE MERGE. [`crate::worktree::merge_pr`] is the single sink for every
//! in-app merge — it carries the merge-protected policy gate, the knightwatch review gate and the
//! base-branch gate — so [`integration_merge`] CALLS it rather than shelling out to `gh` a second
//! time. The refusals here run BEFORE it and are additive.
//!
//! ── `--merge`, NOT `--squash`: A DELIBERATE OVERRIDE OF THE BEAD TEXT ───────────────────────
//!
//! `.2`'s description says "squash-merge". The repo contract in AGENTS.md forbids it,
//! and the contract wins: a squash REWRITES the commits, so the branch tip stops being an ancestor
//! of `main` and Sparkle can no longer prove by ancestry that an agent's work landed. That proof
//! is the same one [`confirm_landed_by_ancestry`] below depends on, so honouring the bead literally
//! would make step 6 of the bead unimplementable. `[integration_assistant].merge_strategy` is
//! therefore VALIDATED rather than free text — see [`validate_merge_strategy`], which is the
//! function `config.rs` itself calls, so there is one rule and not two.
//!
//! ── FAIL CLOSED, EVERYWHERE ─────────────────────────────────────────────────────────────────
//!
//! Three verdicts, never two: `ready`, `blocked(reason)`, `unknown(reason)`. "Could not tell" is
//! never `ready`. `scripts/pr-checks.sh` splits the same way and every one of its six exit codes is
//! honoured distinctly in [`classify_pr_checks_exit`] — collapsing 4 (rebase required, never
//! tested) into 2 (pending) is how a PR sat three days waiting for a run that would never start.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// Wall-clock ceiling for one `scripts/*.sh` invocation. These shell out to `gh`, so the case being
/// bounded is a network stall, not slow local work. A gate that hangs is worse than one that says
/// "unknown" — unknown at least blocks with a reason a human can act on.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(180);

/// Cap on how many branches one plan may consider. The planner is O(n²) in pairwise intersections
/// and each branch costs one `git diff`; beyond this a "plan" is a report nobody reads.
const MAX_PLAN_BRANCHES: usize = 40;

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE SCOPED PR — title convention and template-shaped body
// ════════════════════════════════════════════════════════════════════════════════════════════

/// The commit-prefix vocabulary this repo actually uses, read off its own history. An unrecognized
/// type is NOT rejected — it is normalized to `chore`, because a PR whose title is slightly wrong
/// is a smaller failure than a PR that cannot be opened at all.
pub const COMMIT_TYPES: [&str; 10] =
    ["feat", "fix", "docs", "test", "chore", "refactor", "perf", "build", "ci", "style"];

/// Lowercase a caller's commit type and fall back to `chore` when it is not one this repo uses.
pub fn normalize_commit_type(raw: &str) -> String {
    let lowered = raw.trim().to_ascii_lowercase();
    if COMMIT_TYPES.contains(&lowered.as_str()) {
        lowered
    } else {
        "chore".to_string()
    }
}

/// Strip a conventional-commit prefix (`type:` / `type(scope):`) off a subject line, returning the
/// remainder. Used so a caller that passes an already-prefixed subject does not get `fix(x): fix(x):
/// …` — which is what the naive `format!` produced, and which reads as a bug in the tool.
///
/// Only a RECOGNIZED type is stripped. `Refs: sparkle-x` and `TODO: ship it` are ordinary prose that
/// happens to contain a colon, and eating their first word would silently corrupt the title.
pub fn strip_conventional_prefix(subject: &str) -> &str {
    let s = subject.trim_start();
    let Some(colon) = s.find(':') else { return s };
    let head = &s[..colon];
    let base = head.split('(').next().unwrap_or(head).trim().to_ascii_lowercase();
    if !COMMIT_TYPES.contains(&base.as_str()) {
        return s;
    }
    // A `(` with no closing `)` before the colon is a malformed prefix, not a scope — leave it.
    if head.contains('(') && !head.contains(')') {
        return s;
    }
    s[colon + 1..].trim_start()
}

/// The PR title, in this repo's commit-prefix convention: `type(scope): subject`.
///
/// `fallback` is used when `subject` is blank after trimming — a PR must carry SOME title, and an
/// empty one is rejected by `gh` at the far end of a long operation.
pub fn scoped_pr_title(commit_type: &str, scope: Option<&str>, subject: &str, fallback: &str) -> String {
    let ty = normalize_commit_type(commit_type);
    let mut body = strip_conventional_prefix(subject).trim().to_string();
    if body.is_empty() {
        body = strip_conventional_prefix(fallback).trim().to_string();
    }
    // A trailing period on a title is noise in every git log this repo has.
    while body.ends_with('.') {
        body.pop();
    }
    let scope = scope.map(str::trim).filter(|s| !s.is_empty());
    match scope {
        Some(s) => format!("{ty}({}): {body}", s.to_ascii_lowercase()),
        None => format!("{ty}: {body}"),
    }
}

/// Everything the body builder needs. Borrowed rather than owned so the caller keeps its own data.
#[derive(Debug, Default)]
pub struct PrBodyContext<'a> {
    /// One paragraph: what changed and why. Required in practice; an empty one yields a body that
    /// still parses but says so.
    pub summary: &'a str,
    /// The files this change touches, so a reviewer sees the blast radius without opening the diff.
    pub scope_paths: &'a [String],
    /// Commands that were RUN and their real results. Never a plan.
    pub verification: &'a [String],
    /// Bead ids this PR closes, emitted as a `Refs:` trailer so `retro-inbox-triage.sh` can age
    /// them out. AGENTS.md: name EVERY bead the change fixes, not just the one you started from.
    pub beads: &'a [String],
    /// `crate::pr_owner::pr_body_marker(agent, project)`. NOT rebuilt here — there is one marker
    /// format and `pr_owner.rs` owns it.
    pub owner_marker: &'a str,
}

/// Section headings this builder writes, and the keyword that matches an EXISTING heading in a
/// repo's own `.github/pull_request_template.md`. Order is the order they are emitted in.
const SECTIONS: [(&str, &str); 4] =
    [("Summary", "summary"), ("Scope", "scope"), ("Verification", "verif"), ("Beads", "bead")];

/// Build the PR body, filling the repo's template when it has one.
///
/// TEMPLATE HANDLING, and why it is insertion rather than replacement: a template is a HUMAN'S
/// document. It carries headings, checklists and instructions that a repo's reviewers rely on, and
/// a builder that discards the parts it does not recognise silently deletes the review contract.
/// So the template's own text is kept verbatim; our content is inserted directly UNDER a heading
/// whose text matches one of [`SECTIONS`], and any section the template has no heading for is
/// appended at the end.
///
/// HTML comments in the template ARE dropped — that is the guidance-to-the-author (`<!-- describe
/// your change -->`), which is meaningless once the change is described. The owner marker is added
/// AFTER that strip, so it can never be eaten by it.
///
/// The marker is ALWAYS last and ALWAYS present: it is the only copy of the PR→agent mapping that
/// lives on GitHub, and it is what rescues ownership on a machine that has never seen this store.
pub fn scoped_pr_body(template: Option<&str>, ctx: &PrBodyContext) -> String {
    let rendered: BTreeMap<&str, String> = SECTIONS
        .iter()
        .filter_map(|(heading, _)| render_section(heading, ctx).map(|body| (*heading, body)))
        .collect();

    let mut out = String::new();
    let mut placed: BTreeSet<&str> = BTreeSet::new();

    if let Some(tpl) = template.map(str::trim).filter(|t| !t.is_empty()) {
        for line in strip_html_comments(tpl).lines() {
            out.push_str(line);
            out.push('\n');
            let Some(heading) = heading_text(line) else { continue };
            let lowered = heading.to_ascii_lowercase();
            for (name, keyword) in SECTIONS {
                if placed.contains(name) || !lowered.contains(keyword) {
                    continue;
                }
                if let Some(body) = rendered.get(name) {
                    out.push('\n');
                    out.push_str(body);
                    out.push('\n');
                }
                // Marked placed even when we had nothing to write, so a later heading containing
                // the same keyword does not receive a second copy of the same section.
                placed.insert(name);
            }
        }
    }

    for (name, _) in SECTIONS {
        if placed.contains(name) {
            continue;
        }
        if let Some(body) = rendered.get(name) {
            if !out.trim().is_empty() {
                out.push('\n');
            }
            out.push_str("## ");
            out.push_str(name);
            out.push_str("\n\n");
            out.push_str(body);
            out.push('\n');
        }
    }

    let body = out.trim_end().to_string();
    let marker = ctx.owner_marker.trim();
    if marker.is_empty() {
        return body;
    }
    if body.is_empty() {
        marker.to_string()
    } else {
        format!("{body}\n\n{marker}")
    }
}

/// One section's content, or `None` when there is nothing to say — an empty `## Verification` is
/// worse than no heading, because it reads as "verified: nothing".
fn render_section(heading: &str, ctx: &PrBodyContext) -> Option<String> {
    match heading {
        "Summary" => {
            let s = ctx.summary.trim();
            (!s.is_empty()).then(|| s.to_string())
        }
        "Scope" => bullets(ctx.scope_paths),
        "Verification" => bullets(ctx.verification),
        // A `Refs:` TRAILER, not a bullet list: that is the exact spelling
        // `scripts/retro-inbox-triage.sh` reads to age a bead out once its fix has merged.
        "Beads" => {
            let ids: Vec<&str> =
                ctx.beads.iter().map(|b| b.trim()).filter(|b| !b.is_empty()).collect();
            (!ids.is_empty()).then(|| format!("Refs: {}", ids.join(", ")))
        }
        _ => None,
    }
}

fn bullets(items: &[String]) -> Option<String> {
    let lines: Vec<String> = items
        .iter()
        .map(|i| i.trim())
        .filter(|i| !i.is_empty())
        .map(|i| format!("- {i}"))
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// The text of a markdown ATX heading (`## Summary` → `Summary`), or `None` for any other line.
fn heading_text(line: &str) -> Option<&str> {
    let t = line.trim_start();
    if !t.starts_with('#') {
        return None;
    }
    let rest = t.trim_start_matches('#');
    // `#Summary` is not a heading in CommonMark; a space is required.
    if !rest.starts_with(' ') && !rest.is_empty() {
        return None;
    }
    Some(rest.trim())
}

/// Remove `<!-- … -->` spans, including multi-line ones. An UNCLOSED comment is left alone rather
/// than swallowing the rest of the document — the same rule `parse_pr_body_marker` applies, and for
/// the same reason.
fn strip_html_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("<!--") {
        let Some(close) = rest[at..].find("-->") else { break };
        out.push_str(&rest[..at]);
        rest = &rest[at + close + 3..];
    }
    out.push_str(rest);
    // Drop lines that became blank purely because a comment was removed, so the template does not
    // grow a run of empty lines where its guidance used to be.
    let mut cleaned = String::with_capacity(out.len());
    let mut blank_run = 0usize;
    for line in out.lines() {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        cleaned.push_str(line.trim_end());
        cleaned.push('\n');
    }
    cleaned
}

/// Read `.github/pull_request_template.md` if this repo has one. `None` covers both "no template"
/// and "unreadable", which are the same fact to the builder: fall back to our own sections.
pub fn read_pr_template(root: &str) -> Option<String> {
    for rel in [
        ".github/pull_request_template.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "docs/pull_request_template.md",
        "pull_request_template.md",
    ] {
        if let Ok(text) = std::fs::read_to_string(Path::new(root).join(rel)) {
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE MERGE-ORDER PLANNER — pure, over an injected diff lister
// ════════════════════════════════════════════════════════════════════════════════════════════

/// One branch offered to the planner.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCandidate {
    pub branch: String,
    /// The open PR for this branch, when one exists. `Option` crosses the wire as `null`, never as
    /// an absent key — the TS mirror must be `pr?: number | null`.
    #[serde(default)]
    pub pr: Option<u64>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

/// Two branches whose diffs touch at least one of the same files, and every path they share.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlapWarning {
    pub a: String,
    pub b: String,
    /// Sorted, so the warning text is stable across runs and diffable in a log.
    pub paths: Vec<String>,
    /// The one canonical sentence for this collision, built by [`overlap_sentence`]. Carried on the
    /// row rather than re-derived by each consumer: a log line, a tooltip and a PR comment that
    /// each build their own wording drift apart, and only one of them is ever read.
    pub sentence: String,
}

/// One branch's place in the merge order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedMerge {
    pub branch: String,
    #[serde(default)]
    pub pr: Option<u64>,
    /// 1-based, so it reads as "merge this first" rather than "index 0".
    pub position: usize,
    pub changed_files: usize,
    /// The other branches in this plan whose diffs it collides with, sorted.
    pub overlaps_with: Vec<String>,
    /// An advisory note from `scripts/pr-file-overlap.sh` about competitors OUTSIDE this queue.
    /// `None` means the probe was not run or could not answer — never "no competitor".
    #[serde(default)]
    pub external_overlap: Option<String>,
    /// The PR this branch would open, when it does not have one yet. `None` for a branch that
    /// already has a PR — the draft is for OPENING one, never for rewriting somebody's review
    /// surface out from under them.
    #[serde(default)]
    pub pr_draft: Option<PrDraft>,
}

/// A branch that could NOT be placed, and why. Kept separate from `order` on purpose: silently
/// dropping a branch would report a plan that covers less than the caller asked for, and a caller
/// reading only `order` would never find out.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unplannable {
    pub branch: String,
    pub reason: String,
}

/// The whole answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePlan {
    pub base: String,
    pub order: Vec<PlannedMerge>,
    pub warnings: Vec<OverlapWarning>,
    pub unplannable: Vec<Unplannable>,
}

/// Where the planner's file lists come from. INJECTED so the ordering and overlap rules — the part
/// that can actually be wrong — are testable without a git repository.
pub trait DiffLister {
    /// Repo-relative paths changed by `branch` relative to `base`, as
    /// `git diff --name-only <base>...<branch>` prints them.
    fn changed_files(&self, base: &str, branch: &str) -> Result<Vec<String>, String>;
}

/// Compute a safe sequential merge order and name every pairwise collision.
///
/// THE ORDER, and why it is this one: LEAST-ENTANGLED FIRST, breaking ties on diff size and then on
/// name. Each merge moves `origin/main` under everything still queued, so whichever branch merges
/// LAST is the one that has to absorb every conflict the earlier ones created. Putting the most
/// entangled branch there concentrates that work in a single catch-up instead of spreading partial
/// conflicts across the whole queue; putting it FIRST would force every one of its collision
/// partners to re-resolve the same hunks one at a time. The tie-breaks make the plan deterministic,
/// which matters because a plan that reshuffles between two identical runs cannot be reviewed.
///
/// A branch with an EMPTY diff is `unplannable`, not first-in-line: there is nothing to merge, and
/// a no-op PR in the queue reads as work that landed when none did (AGENTS.md's staleness verdict 5
/// is the same fact seen from the other side).
pub fn plan_merge_order(
    base: &str,
    candidates: &[BranchCandidate],
    lister: &dyn DiffLister,
) -> MergePlan {
    let mut files: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut unplannable: Vec<Unplannable> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    for cand in candidates.iter().take(MAX_PLAN_BRANCHES) {
        let branch = cand.branch.trim().to_string();
        if branch.is_empty() {
            continue;
        }
        if !seen.insert(branch.clone()) {
            continue; // the same branch offered twice is one branch
        }
        match lister.changed_files(base, &branch) {
            Err(e) => unplannable.push(Unplannable {
                branch,
                reason: format!("could not read its diff against {base}, so its collisions are unknown: {e}"),
            }),
            Ok(list) => {
                let set: BTreeSet<String> =
                    list.into_iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect();
                if set.is_empty() {
                    unplannable.push(Unplannable {
                        branch,
                        reason: format!(
                            "changes no files against {base} — there is nothing here to merge"
                        ),
                    });
                } else {
                    files.insert(branch, set);
                }
            }
        }
    }
    if candidates.len() > MAX_PLAN_BRANCHES {
        unplannable.push(Unplannable {
            branch: String::new(),
            reason: format!(
                "{} branches were offered and only the first {MAX_PLAN_BRANCHES} were planned; \
                 the rest were not considered",
                candidates.len()
            ),
        });
    }

    let names: Vec<String> = files.keys().cloned().collect();
    let mut warnings: Vec<OverlapWarning> = Vec::new();
    let mut degree: BTreeMap<String, usize> = names.iter().map(|n| (n.clone(), 0)).collect();
    let mut partners: BTreeMap<String, BTreeSet<String>> =
        names.iter().map(|n| (n.clone(), BTreeSet::new())).collect();

    for i in 0..names.len() {
        for j in (i + 1)..names.len() {
            let (a, b) = (&names[i], &names[j]);
            let shared: Vec<String> = files[a].intersection(&files[b]).cloned().collect();
            if shared.is_empty() {
                continue;
            }
            let mut warning =
                OverlapWarning { a: a.clone(), b: b.clone(), paths: shared, sentence: String::new() };
            warning.sentence = overlap_sentence(&warning);
            warnings.push(warning);
            *degree.get_mut(a).expect("degree seeded for every name") += 1;
            *degree.get_mut(b).expect("degree seeded for every name") += 1;
            partners.get_mut(a).expect("partners seeded").insert(b.clone());
            partners.get_mut(b).expect("partners seeded").insert(a.clone());
        }
    }

    let mut ordered = names;
    ordered.sort_by(|a, b| {
        degree[a]
            .cmp(&degree[b])
            .then_with(|| files[a].len().cmp(&files[b].len()))
            .then_with(|| a.cmp(b))
    });

    let pr_of: BTreeMap<&str, Option<u64>> =
        candidates.iter().map(|c| (c.branch.trim(), c.pr)).collect();

    let order = ordered
        .into_iter()
        .enumerate()
        .map(|(idx, branch)| PlannedMerge {
            changed_files: files[&branch].len(),
            overlaps_with: partners[&branch].iter().cloned().collect(),
            pr: pr_of.get(branch.as_str()).copied().flatten(),
            position: idx + 1,
            branch,
            external_overlap: None,
            pr_draft: None,
        })
        .collect();

    MergePlan { base: base.to_string(), order, warnings, unplannable }
}

/// A one-line, human-readable statement of one collision. Separated from the data so the same
/// sentence appears in a log, a tooltip and a PR comment without three spellings of it.
pub fn overlap_sentence(w: &OverlapWarning) -> String {
    format!(
        "{} and {} both change {}: {}. Merge them one at a time and re-run the gate in between.",
        w.a,
        w.b,
        if w.paths.len() == 1 { "1 file".to_string() } else { format!("{} files", w.paths.len()) },
        w.paths.join(", ")
    )
}

/// A ready-to-open pull request for one branch: the title in this repo's commit-prefix convention,
/// and the body shaped by its `.github/pull_request_template.md` when it has one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDraft {
    pub title: String,
    pub body: String,
}

/// The commit type and scope this branch's own commits already use.
///
/// READ OFF THE BRANCH rather than asked for, because the convention IS the history: a branch whose
/// eight commits all say `fix(preview):` should not open a PR titled `chore: …` merely because
/// nobody passed a type. The most frequent type wins; ties break toward the FIRST one seen in the
/// list, which is the newest commit, so a branch that changed direction is titled by where it ended
/// up. A branch with no conventional prefixes at all yields `("chore", None)` — the honest fallback,
/// not a guess dressed up as a reading.
pub fn infer_type_and_scope(subjects: &[String]) -> (String, Option<String>) {
    let mut types: Vec<(String, Option<String>)> = Vec::new();
    for subj in subjects {
        let s = subj.trim();
        let Some(colon) = s.find(':') else { continue };
        let head = &s[..colon];
        let base = head.split('(').next().unwrap_or(head).trim().to_ascii_lowercase();
        if !COMMIT_TYPES.contains(&base.as_str()) {
            continue;
        }
        let scope = head
            .split_once('(')
            .and_then(|(_, r)| r.split_once(')'))
            .map(|(sc, _)| sc.trim().to_ascii_lowercase())
            .filter(|sc| !sc.is_empty());
        types.push((base, scope));
    }
    if types.is_empty() {
        return ("chore".to_string(), None);
    }
    let mut counts: BTreeMap<&(String, Option<String>), usize> = BTreeMap::new();
    for t in &types {
        *counts.entry(t).or_insert(0) += 1;
    }
    // Highest count wins; ties go to whichever appeared FIRST in `types` (the newest commit).
    let best = types
        .iter()
        .max_by_key(|t| (counts[t], std::cmp::Reverse(types.iter().position(|x| x == *t))))
        .expect("types is non-empty");
    best.clone()
}

/// Every `sparkle-…` bead id named in a `Refs:` trailer across a branch's commit messages.
///
/// AGENTS.md: name EVERY bead a change fixes, not just the one you started from — a bead whose fix
/// shipped unnamed stays at the top of the inbox forever, accruing recurrences from agents
/// rediscovering finished work. Sweeping the whole branch is what makes that cheap enough to do.
pub fn beads_from_messages(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("Refs:").or_else(|| t.strip_prefix("refs:")) else {
            continue;
        };
        for id in rest.split(|c: char| c == ',' || c.is_whitespace()) {
            let id = id.trim().trim_end_matches(['.', ';']);
            if id.starts_with("sparkle-") && !out.contains(&id.to_string()) {
                out.push(id.to_string());
            }
        }
    }
    out
}

/// Build the scoped PR for one branch out of what the branch itself says.
///
/// `verification` is deliberately EMPTY here. This module cannot know what was run — bead
/// `.1` owns the local check runner and its evidence capture — and a `## Verification`
/// section filled with commands nobody executed is worse than no section at all, because it reads
/// as evidence. When the [`LocalGate`] seam is filled, its captured evidence is what goes here.
pub fn draft_scoped_pr(
    root: &str,
    base: &str,
    branch: &str,
    changed: &[String],
    owner_marker: &str,
) -> PrDraft {
    let range = format!("{base}..{branch}");
    let subjects: Vec<String> =
        crate::worktree::git(root, &["log", "--no-merges", "--format=%s", &range])
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .filter(|l| !l.trim().is_empty())
            .collect();
    let messages =
        crate::worktree::git(root, &["log", "--no-merges", "--format=%B", &range]).unwrap_or_default();
    let (ty, scope) = infer_type_and_scope(&subjects);
    let headline = subjects.first().map(String::as_str).unwrap_or("");
    let leaf = branch.rsplit('/').next().unwrap_or(branch);
    let title = scoped_pr_title(&ty, scope.as_deref(), headline, leaf);
    let summary = if subjects.len() > 1 {
        format!("{} commit(s) on `{branch}`, ending at: {}", subjects.len(), strip_conventional_prefix(headline))
    } else {
        strip_conventional_prefix(headline).to_string()
    };
    let beads = beads_from_messages(&messages);
    let body = scoped_pr_body(
        read_pr_template(root).as_deref(),
        &PrBodyContext {
            summary: &summary,
            scope_paths: changed,
            verification: &[],
            beads: &beads,
            owner_marker,
        },
    );
    PrDraft { title, body }
}

/// The production [`DiffLister`]: two-dot-from-the-merge-base (`base...branch`), which is what a PR
/// diff shows and therefore what a collision actually means.
pub struct GitDiffLister {
    pub root: String,
}

impl DiffLister for GitDiffLister {
    fn changed_files(&self, base: &str, branch: &str) -> Result<Vec<String>, String> {
        let range = format!("{base}...{branch}");
        let out = crate::worktree::git(&self.root, &["diff", "--name-only", &range])?;
        Ok(out.lines().map(|l| l.to_string()).collect())
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE GATE
// ════════════════════════════════════════════════════════════════════════════════════════════

/// What one `scripts/pr-checks.sh` exit code MEANS. Every code is distinct on purpose; see the
/// module header for what collapsing 4 into 2 costs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckState {
    /// 0 — nothing failed, nothing pending, and at least one check exists.
    Pass,
    /// 1 — at least one check FAILED, and it gates. This IS a statement about the diff.
    Failed,
    /// 2 — no verdict yet. Transient: ask again later.
    Pending,
    /// 3 — could not read (gh missing, unauthenticated, offline, bad PR). NOT a pass.
    Unreadable,
    /// 4 — CONFLICTING and never tested. The opposite of transient: no run will ever start.
    RebaseRequired,
    /// 5 — the jobs failed without executing a single step. Says nothing about the diff.
    NeverRan,
    /// A code the script does not document. Fails closed rather than being guessed at.
    Unexpected(i32),
}

impl CheckState {
    /// The single word this state travels as on the wire and appears as in a UI chip.
    pub fn word(&self) -> String {
        match self {
            CheckState::Pass => "pass".to_string(),
            CheckState::Failed => "failed".to_string(),
            CheckState::Pending => "pending".to_string(),
            CheckState::Unreadable => "unreadable".to_string(),
            CheckState::RebaseRequired => "rebase-required".to_string(),
            CheckState::NeverRan => "never-ran".to_string(),
            CheckState::Unexpected(c) => format!("unexpected-{c}"),
        }
    }
}

/// `scripts/pr-checks.sh`'s exit code → a verdict. The whole contract, in one place.
pub fn classify_pr_checks_exit(code: i32) -> CheckState {
    match code {
        0 => CheckState::Pass,
        1 => CheckState::Failed,
        2 => CheckState::Pending,
        3 => CheckState::Unreadable,
        4 => CheckState::RebaseRequired,
        5 => CheckState::NeverRan,
        other => CheckState::Unexpected(other),
    }
}

/// roborev's contribution to the gate. THREE states, mirroring [`crate::roborev_probe::RoborevProbe`]:
/// not in play, an authoritative reading, and "could not tell".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoborevGate {
    /// roborev is not installed / not enabled here. The gate does not apply — NOT "clean".
    NotApplicable,
    /// An authoritative reading of the branch's OPEN reviews.
    Read { blocking: usize, in_flight: usize },
    /// roborev IS the gate and we could not read it.
    Unknown(String),
}

/// The seam bead `.1` fills. See the module header.
pub trait LocalGate {
    /// Did this branch's working tree pass the local CI-parity checks?
    fn evaluate(&self, root: &str, branch: &str) -> LocalGateOutcome;
}

/// Three outcomes, and `NotRun` is not `Pass`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalGateOutcome {
    /// No local gate is wired in yet. Reported, and does not block — but it must never be
    /// indistinguishable from a gate that ran and passed.
    NotRun,
    Pass,
    Fail(String),
}

impl LocalGateOutcome {
    pub fn word(&self) -> String {
        match self {
            LocalGateOutcome::NotRun => "not-run".to_string(),
            LocalGateOutcome::Pass => "pass".to_string(),
            LocalGateOutcome::Fail(_) => "fail".to_string(),
        }
    }
}

/// The production stand-in until `verify_gate.rs` (bead `.1`) exists.
pub struct NoLocalGate;

impl LocalGate for NoLocalGate {
    fn evaluate(&self, _root: &str, _branch: &str) -> LocalGateOutcome {
        LocalGateOutcome::NotRun
    }
}

/// Everything the pure verdict function judges. Assembled by [`integration_gate`] from real probes;
/// constructed directly by tests, which is what keeps the DECISION reachable without a network.
#[derive(Debug, Clone)]
pub struct GateFacts {
    pub checks: CheckState,
    pub roborev: RoborevGate,
    /// `gh`'s `mergeable`: `MERGEABLE` / `CONFLICTING` / `UNKNOWN`. `None` when it was not read.
    pub mergeable: Option<String>,
    /// `[integration_assistant].require_roborev_clean`.
    pub require_roborev_clean: bool,
    pub local: LocalGateOutcome,
}

/// What the gate answers for one branch.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateReport {
    pub branch: String,
    #[serde(default)]
    pub pr: Option<u64>,
    /// `ready` | `blocked` | `unknown`. Only `ready` may merge.
    pub verdict: String,
    /// Every reason, joined. `None` only when `verdict == "ready"`.
    #[serde(default)]
    pub reason: Option<String>,
    pub checks: String,
    /// Open reviews carrying a FAIL verdict. `None` means roborev could not be read — never zero.
    #[serde(default)]
    pub roborev_blocking: Option<usize>,
    /// The [`LocalGate`] seam's word: `not-run` today.
    pub local_gate: String,
}

pub const VERDICT_READY: &str = "ready";
pub const VERDICT_BLOCKED: &str = "blocked";
pub const VERDICT_UNKNOWN: &str = "unknown";

/// The verdict, and every reason behind it.
///
/// BLOCKING AND UNKNOWN REASONS ARE COLLECTED SEPARATELY, then blocking wins. That is not
/// stylistic: a gate that returns at the first bad fact reports one problem per round-trip, so a
/// branch with red checks AND undrained findings takes two full cycles to reveal both — and a test
/// for the second rule passes vacuously because the first rule already decided the outcome. The
/// shape this repo tracks as its most common vacuous test is exactly "an earlier guard
/// short-circuits the path"; collecting everything makes each rule independently observable.
pub fn gate_verdict(facts: &GateFacts) -> (String, Option<String>) {
    let mut blocking: Vec<String> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();

    match &facts.checks {
        CheckState::Pass => {}
        CheckState::Failed => blocking.push("CI checks failed".to_string()),
        CheckState::RebaseRequired => blocking
            .push("the PR is CONFLICTING and no CI run was ever created for it".to_string()),
        CheckState::NeverRan => blocking.push(
            "the checks failed without executing a single step, so nothing was ever judged"
                .to_string(),
        ),
        CheckState::Pending => unknown.push("CI checks have no verdict yet".to_string()),
        CheckState::Unreadable => {
            unknown.push("the PR's checks could not be read at all".to_string())
        }
        CheckState::Unexpected(c) => {
            unknown.push(format!("scripts/pr-checks.sh exited {c}, which it does not document"))
        }
    }

    // A CONFLICTING PR is blocked even when the checks read some other way — the two facts come
    // from different queries and a stale rollup can be green on a head that no longer merges.
    if facts.mergeable.as_deref().map(str::trim) == Some("CONFLICTING") {
        let msg = "the PR is CONFLICTING with its base".to_string();
        if !blocking.contains(&msg) {
            blocking.push(msg);
        }
    }

    if let LocalGateOutcome::Fail(why) = &facts.local {
        blocking.push(format!("the local check gate failed: {why}"));
    }

    match &facts.roborev {
        RoborevGate::NotApplicable => {}
        RoborevGate::Read { blocking: b, in_flight } if facts.require_roborev_clean => {
            if *b > 0 {
                blocking.push(format!(
                    "{b} open roborev review(s) carry a FAIL verdict and have not been drained"
                ));
            }
            if *in_flight > 0 {
                unknown.push(format!("{in_flight} roborev review round(s) are still in flight"));
            }
        }
        RoborevGate::Read { .. } => {}
        RoborevGate::Unknown(e) if facts.require_roborev_clean => {
            unknown.push(format!("roborev is the gate here and could not be read: {e}"))
        }
        RoborevGate::Unknown(_) => {}
    }

    if !blocking.is_empty() {
        return (VERDICT_BLOCKED.to_string(), Some(join_reasons(&blocking, &unknown)));
    }
    if !unknown.is_empty() {
        return (VERDICT_UNKNOWN.to_string(), Some(unknown.join("; ")));
    }
    (VERDICT_READY.to_string(), None)
}

/// Blocking reasons first, then anything still unknown — a reader must not lose the second fact
/// because the first one already decided the verdict.
fn join_reasons(blocking: &[String], unknown: &[String]) -> String {
    let mut all: Vec<String> = blocking.to_vec();
    all.extend(unknown.iter().cloned());
    all.join("; ")
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 4. CATCHING UP ONTO A MOVED BASE — rebase OR merge, and the choice is not stylistic
// ════════════════════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatchUp {
    Rebase,
    Merge,
}

impl CatchUp {
    pub fn word(self) -> &'static str {
        match self {
            CatchUp::Rebase => "rebase",
            CatchUp::Merge => "merge",
        }
    }
}

/// Which verb catches this branch up onto a moved base.
///
/// A BRANCH CARRYING MERGE COMMITS MUST BE MERGED, NOT REBASED. `git rebase` DROPS merge commits
/// and replays every underlying commit against a base they were never written for, re-litigating
/// every conflict the branch already resolved once. Measured in this repo (AGENTS.md,
/// `sparkle-pxhaq`): the rebase conflicted on the first of eight replays, while the merge produced
/// three trivial additive conflicts. An orchestrator branch — which is every branch that has
/// already absorbed a worker — is exactly this shape, so the wrong verb here is the common case,
/// not the edge case.
pub fn catchup_verb(merge_commit_count: usize) -> CatchUp {
    if merge_commit_count > 0 {
        CatchUp::Merge
    } else {
        CatchUp::Rebase
    }
}

/// The git argv for a catch-up. PURE so the flags are assertable: `--no-edit` on the merge is
/// load-bearing (without it git opens `$EDITOR` and the call hangs until something kills it), and
/// nothing else in a test could observe its absence.
pub fn catchup_argv(verb: CatchUp, base_ref: &str) -> Vec<String> {
    match verb {
        CatchUp::Rebase => vec!["rebase".to_string(), base_ref.to_string()],
        CatchUp::Merge => vec!["merge".to_string(), "--no-edit".to_string(), base_ref.to_string()],
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 5. REFUSALS
// ════════════════════════════════════════════════════════════════════════════════════════════

/// A refusal, and the thing to do instead.
///
/// THE REMEDY IS AN INSTRUCTION SOMEBODY WILL FOLLOW, so it must be safe under the SAME conditions
/// that produced the refusal — otherwise the refusal accomplished nothing except making the unsafe
/// act manual (AGENTS.md, `sparkle-8bvh`). Concretely: the remedy for a merge-protected repo is
/// never "run `gh pr merge` yourself", and the remedy for red checks is never "merge with
/// `--admin`". Each one below names an action that leaves the merge UNDONE.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRefusal {
    pub reason: String,
    pub remedy: String,
}

/// Every reason this assistant will not merge, in the order they are checked.
///
/// The policy floor is FIRST and is deliberately the cheapest, most definitive one: a repo Sparkle
/// will never merge in does not need its checks read to be refused.
pub fn merge_refusal(
    slug: &str,
    slug_is_merge_protected: bool,
    strategy: &str,
    gate: &GateReport,
) -> Option<MergeRefusal> {
    if slug_is_merge_protected {
        return Some(MergeRefusal {
            reason: format!(
                "{slug} is pinned merge-protected in apps/desktop/shared/merge-protected-repos.json, \
                 so Sparkle never merges there"
            ),
            remedy: "Hand the PR to a human who owns that repo and let them merge it in GitHub. \
                     No local command changes this — the pin is compiled into the build and no \
                     config loosens it."
                .to_string(),
        });
    }
    if let Err(e) = validate_merge_strategy(strategy) {
        return Some(MergeRefusal {
            reason: e,
            remedy: "Set `[integration_assistant].merge_strategy = \"merge\"` (or delete the key — \
                     \"merge\" is the default) and run the gate again."
                .to_string(),
        });
    }
    if gate.verdict == VERDICT_READY {
        return None;
    }
    let reason = gate.reason.clone().unwrap_or_else(|| {
        format!("the gate answered {} without naming a reason", gate.verdict)
    });
    let remedy = if gate.verdict == VERDICT_BLOCKED {
        // Every branch of this leaves the PR unmerged, which is the point.
        if gate.checks == CheckState::RebaseRequired.word()
            || reason.contains("CONFLICTING")
        {
            "Catch the branch up onto fresh origin/main — merge origin/main into it if it carries \
             merge commits, rebase otherwise — push, and run the gate again. GitHub creates no CI \
             run for a conflicting PR, so waiting will not help."
                .to_string()
        } else if reason.contains("roborev") {
            // TWO TRAPS AVOIDED HERE, both documented and both previously present in this string.
            // (1) `roborev list --open --branch` exits 0 while printing a connection banner, so an
            //     empty answer is indistinguishable from "reviewed, nothing found" — a reader who
            //     acts on it drains nothing and merges over live findings. The `--json` form plus
            //     the stated caution is what makes the emptiness readable.
            // (2) `roborev show <id>` resolves its argument as a GIT REF first, so a bare numeric
            //     id fails "commit not found" whenever it also reads as an abbreviated sha. It
            //     needs `--job`.
            // Deliberately no repo-specific helper script is named: this assistant runs against
            // whatever project the user has open, so a path from one repo would be wrong in every
            // other one.
            "Drain the findings first: `roborev list --open --json --branch <branch>` — an empty \
             or non-array answer means COULD NOT ASK, not \"no findings\" — then `roborev show \
             --job <id>` (the `--job` is required; a bare id is read as a git ref) and either fix \
             it or `roborev close <id>` with a stated reason. Then run the gate again."
                .to_string()
        } else {
            "Read the failing check and fix it on the branch, then run the gate again. Do not \
             merge over it — a red check is a statement about this diff."
                .to_string()
        }
    } else {
        "Nothing is decided yet. Leave the PR open and run the gate again once the checks conclude; \
         if the reason says something could not be READ, fix that first (`gh auth status`, or start \
         the roborev daemon) — an unreadable gate is not a passing one."
            .to_string()
    };
    Some(MergeRefusal { reason, remedy })
}

/// The ONE rule for `[integration_assistant].merge_strategy`, called from `config.rs` as well as
/// from the merge path — so there is one implementation and neither copy can drift.
///
/// `squash` is named explicitly rather than falling into the generic arm, because it is the value a
/// reader is most likely to try (bead `.2`'s own description asks for it) and the generic
/// message would not say why it is refused.
pub fn validate_merge_strategy(raw: &str) -> Result<String, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "merge" => Ok("merge".to_string()),
        "squash" => Err(
            "[integration_assistant].merge_strategy = \"squash\" is refused: a squash rewrites the \
             branch's commits, so its tip stops being an ancestor of main and Sparkle can no longer \
             prove by ancestry that the work landed. Only \"merge\" is accepted."
                .to_string(),
        ),
        other => Err(format!(
            "[integration_assistant].merge_strategy = \"{other}\" is not a strategy this assistant \
             accepts. Only \"merge\" is accepted."
        )),
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 6. PROOF, THEN CLEANUP
// ════════════════════════════════════════════════════════════════════════════════════════════

/// Did `sha` actually land on `base_ref`?
///
/// ANCESTRY, NEVER THE MERGE COMMAND'S OWN CLAIM. `gh pr merge` can exit 0 on a merge that a branch
/// protection rule then unwinds, and it can also fail AFTER the merge landed (its pipes outlive it).
/// Deleting a remote branch or releasing a worktree on the strength of that claim destroys work in
/// exactly the case where the claim was wrong. `git merge-base --is-ancestor` is the only proof, and
/// its EXIT STATUS is the answer: 0 contains, 1 does not, anything else is a failure to ask.
pub fn confirm_landed_by_ancestry(root: &str, sha: &str, base_ref: &str) -> Result<bool, String> {
    let sha = sha.trim();
    if sha.is_empty() {
        return Err("no head sha to prove: refusing to treat an unknown commit as landed".into());
    }
    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.arg("-C").arg(root).args(["merge-base", "--is-ancestor", sha, base_ref]);
    apply_noninteractive(&mut cmd);
    match crate::worktree::output_with_timeout(cmd, SCRIPT_TIMEOUT) {
        Ok(o) if o.status.success() => Ok(true),
        Ok(o) if o.status.code() == Some(1) => Ok(false),
        Ok(o) => Err(format!(
            "git merge-base --is-ancestor exited {:?}, which is a failure to ask rather than a no",
            o.status.code()
        )),
        Err(e) => Err(e),
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// SUBPROCESS PLUMBING
// ════════════════════════════════════════════════════════════════════════════════════════════

/// Fail fast rather than blocking on an interactive prompt — a hung child freezes the command the
/// UI awaits. Mirrors `worktree::apply_noninteractive`, which is private to that module.
fn apply_noninteractive(cmd: &mut Command) {
    // One shared definition — see `claude_oneshot::apply_noninteractive` for why eight per-module
    // copies of this env setup were consolidated into it.
    crate::claude_oneshot::apply_noninteractive(cmd);
}

/// Run one of the repo's own guard scripts and hand back its EXIT CODE.
///
/// The code IS the answer for every script this module calls, so a missing script, a spawn failure
/// or a signal death must NOT be reported as some code the script defines. They return `Err`, which
/// every caller maps to its own fail-closed state.
fn run_repo_script(root: &str, rel: &str, args: &[String]) -> Result<(i32, String), String> {
    let script = Path::new(root).join(rel);
    if !script.exists() {
        return Err(format!("{rel} is not present in this repo, so it could not be consulted"));
    }
    let mut cmd = Command::new("bash");
    cmd.arg(&script).args(args).current_dir(root);
    apply_noninteractive(&mut cmd);
    let out = crate::worktree::output_with_timeout(cmd, SCRIPT_TIMEOUT)
        .map_err(|e| format!("{rel} could not be run: {e}"))?;
    let code = out
        .status
        .code()
        .ok_or_else(|| format!("{rel} was killed by a signal, so it produced no verdict"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok((code, text.trim().to_string()))
}

/// `scripts/pr-checks.sh <n> --quiet` → a [`CheckState`]. An unrunnable script is `Unreadable`,
/// which is fail-closed and never a pass.
fn read_pr_checks(root: &str, pr: u64) -> (CheckState, Option<String>) {
    match run_repo_script(root, "scripts/pr-checks.sh", &[pr.to_string(), "--quiet".to_string()]) {
        Ok((code, _)) => (classify_pr_checks_exit(code), None),
        Err(e) => (CheckState::Unreadable, Some(e)),
    }
}

/// `scripts/pr-file-overlap.sh` for competitors OUTSIDE this queue. ADVISORY: its verdict never
/// changes a gate answer, so a missing script or an unauthenticated `gh` costs a note, not a merge.
fn probe_external_overlap(root: &str, changed: &[String]) -> Option<String> {
    let mut args: Vec<String> = Vec::new();
    for path in changed.iter().take(50) {
        args.push("--planned".to_string());
        args.push(path.clone());
    }
    if args.is_empty() {
        return None;
    }
    let (code, text) = run_repo_script(root, "scripts/pr-file-overlap.sh", &args).ok()?;
    match code {
        0 => None,
        10 => Some(format!("an OPEN pull request outside this queue touches these files. {text}")),
        12 => Some(format!("a commit already on the base touches these files. {text}")),
        13 => Some(format!("another live worktree has unpushed work in these files. {text}")),
        11 => Some(format!("an open PR is in the same area (no shared file). {text}")),
        _ => None,
    }
}

/// Turn a [`crate::roborev_probe::RoborevProbe`] into the gate's three-state view.
///
/// A CLOSED ROW IS IN NO BUCKET — `roborev close` IS somebody's judgement, so a closed FAIL is a
/// finished decision rather than backlog. Mirrors `RoborevBranchState` in
/// `services/mergeGuard/types.ts`; the bucketing rules are stated there and must not diverge.
pub fn roborev_gate_from_rows(
    enabled: bool,
    jobs: Option<&[crate::roborev_probe::RoborevJobRow]>,
    error: Option<&str>,
) -> RoborevGate {
    if !enabled {
        return RoborevGate::NotApplicable;
    }
    let Some(rows) = jobs else {
        return RoborevGate::Unknown(
            error.unwrap_or("roborev could not be read").to_string(),
        );
    };
    let mut blocking = 0usize;
    let mut in_flight = 0usize;
    for row in rows.iter().filter(|r| !r.closed) {
        match row.status.trim().to_ascii_lowercase().as_str() {
            "queued" | "running" => in_flight += 1,
            // A done job with no verdict is an UNREAD review, not a passing one.
            "done" => match row.verdict.as_deref().map(str::trim) {
                Some("P") | Some("p") => {}
                _ => blocking += 1,
            },
            // `failed`, or a status string we have no rule for: unknown is not clean.
            _ => blocking += 1,
        }
    }
    RoborevGate::Read { blocking, in_flight }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// TAURI COMMANDS
// ════════════════════════════════════════════════════════════════════════════════════════════

/// `[integration_assistant]` as the frontend reads it, plus whether the tooling this module
/// consumes is actually present in the repo it was asked about.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub enabled: bool,
    pub auto_rebase: bool,
    pub require_roborev_clean: bool,
    pub merge_strategy: String,
    pub cleanup_after_merge: bool,
    /// `scripts/pr-checks.sh` exists here. Without it every gate answers `unknown`.
    pub pr_checks_available: bool,
    /// `scripts/pr-file-overlap.sh` exists here. Advisory only.
    pub pr_overlap_available: bool,
    /// The repo slug, when it could be resolved. `None` is not "unprotected" — a slug that cannot
    /// be read cannot be cleared by the merge-protected pin either.
    #[serde(default)]
    pub slug: Option<String>,
    pub merge_protected: bool,
    /// The [`LocalGate`] seam's current state — `not-run` until bead `.1` lands.
    pub local_gate: String,
}

/// Config for this module, read fresh on every command so a change takes effect without a restart.
fn cfg() -> crate::config::IntegrationAssistantConfig {
    crate::config::current_effective().config.integration_assistant.clone()
}

/// This repo's `owner/name` slug from `remote.origin.url`, or `None` when it cannot be read.
fn repo_slug(root: &str) -> Option<String> {
    let url = crate::worktree::git(root, &["config", "--get", "remote.origin.url"]).ok()?;
    crate::sparkle_agent::repo_slug_from_url(&url)
}

/// Is this module turned on? Ships OFF (`enabled = false`) — it merges pull requests, and a feature
/// that merges must be asked for rather than discovered.
fn require_enabled() -> Result<crate::config::IntegrationAssistantConfig, String> {
    let c = cfg();
    if !c.enabled {
        return Err("the integration assistant is off. Turn it on with \
                    `[integration_assistant].enabled = true` in Sparkle's config."
            .to_string());
    }
    Ok(c)
}

/// Plan a safe sequential merge order across N ready branches, naming every file collision.
///
/// FROM TYPESCRIPT: `invoke("integration_plan", { root, base, candidates })`.
#[tauri::command]
pub async fn integration_plan(
    root: String,
    project_id: String,
    base: String,
    candidates: Vec<BranchCandidate>,
) -> Result<MergePlan, String> {
    let c = require_enabled()?;
    let _ = c;
    tauri::async_runtime::spawn_blocking(move || {
        let base = if base.trim().is_empty() {
            format!("origin/{}", crate::worktree::resolve_default_branch(&root))
        } else {
            base.trim().to_string()
        };
        let lister = GitDiffLister { root: root.clone() };
        let mut plan = plan_merge_order(&base, &candidates, &lister);
        // The advisory pass and the PR draft both run AFTER the plan, per branch. Neither can
        // change the ORDER — a note about a competitor outside the queue is information for a
        // human, and a draft is a proposal, so letting either reshuffle the plan would make the
        // ordering rules untestable in the one place they are decided.
        let agent_of: BTreeMap<&str, Option<&str>> = candidates
            .iter()
            .map(|c| (c.branch.trim(), c.agent_id.as_deref()))
            .collect();
        for entry in plan.order.iter_mut() {
            let Ok(files) = lister.changed_files(&base, &entry.branch) else { continue };
            entry.external_overlap = probe_external_overlap(&root, &files);
            if entry.pr.is_some() {
                continue;
            }
            let agent = agent_of.get(entry.branch.as_str()).copied().flatten().unwrap_or("");
            // `pr_owner` owns the marker format; this never rebuilds it. An empty agent id yields a
            // marker that `parse_pr_body_marker` rejects, so ownership degrades to "unresolved"
            // rather than resolving to a bogus agent — the rule `pr_owner.rs` is built around.
            let marker = crate::pr_owner::pr_body_marker(agent, &project_id);
            entry.pr_draft = Some(draft_scoped_pr(&root, &base, &entry.branch, &files, &marker));
        }
        Ok(plan)
    })
    .await
    .map_err(|e| format!("integration_plan task failed: {e}"))?
}

/// Gate one branch: `scripts/pr-checks.sh` + roborev + `gh`'s mergeable state.
///
/// `auto_rebase` catches the branch up onto fresh `origin/<default>` FIRST and then re-reads the
/// gate, picking `merge` over `rebase` when the branch carries merge commits (see [`catchup_verb`]).
///
/// FROM TYPESCRIPT: `invoke("integration_gate", { root, branch, pr })`.
#[tauri::command]
pub async fn integration_gate(
    root: String,
    branch: String,
    pr: Option<u64>,
) -> Result<GateReport, String> {
    let c = require_enabled()?;
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("no branch to gate".to_string());
    }
    if c.auto_rebase {
        // Best-effort: a catch-up that fails leaves the branch where it was, and the gate below
        // then reports the real state rather than a state we wished for.
        let (r, b) = (root.clone(), branch.clone());
        let _ = tauri::async_runtime::spawn_blocking(move || catch_up_branch(&r, &b)).await;
    }
    let roborev = read_roborev_gate(&root, &branch).await;
    let (root_b, branch_b, c_b) = (root.clone(), branch.clone(), c.clone());
    tauri::async_runtime::spawn_blocking(move || {
        Ok(gate_branch(&root_b, &branch_b, pr, &c_b, &NoLocalGate, roborev))
    })
    .await
    .map_err(|e| format!("integration_gate task failed: {e}"))?
}

/// Ask [`crate::roborev_probe`] — the ONE reader of roborev's verdict for a branch — and narrow its
/// three-state answer to this gate's three-state view. An `Err` from the probe is a malformed
/// request rather than a roborev fault, and it still fails closed: unknown, never clean.
async fn read_roborev_gate(root: &str, branch: &str) -> RoborevGate {
    match crate::roborev_probe::roborev_branch_probe(root.to_string(), branch.to_string(), None)
        .await
    {
        Ok(p) => roborev_gate_from_rows(p.enabled, p.jobs.as_deref(), p.error.as_deref()),
        Err(e) => RoborevGate::Unknown(e),
    }
}

/// The gate, assembled. Split out of the command so the assembly — not just the pure verdict — is
/// reachable from a caller that supplies its own [`LocalGate`], which is how bead `.1`
/// wires in without touching the command.
pub fn gate_branch(
    root: &str,
    branch: &str,
    pr: Option<u64>,
    c: &crate::config::IntegrationAssistantConfig,
    local: &dyn LocalGate,
    roborev: RoborevGate,
) -> GateReport {
    let (checks, checks_err) = match pr {
        Some(n) => read_pr_checks(root, n),
        // No PR means nothing to read; that is UNKNOWN, not a pass.
        None => (
            CheckState::Unreadable,
            Some("no pull request exists for this branch, so its checks cannot be read".to_string()),
        ),
    };
    let mergeable = pr.and_then(|n| read_mergeable(root, n));
    let facts = GateFacts {
        checks: checks.clone(),
        roborev: roborev.clone(),
        mergeable,
        require_roborev_clean: c.require_roborev_clean,
        local: local.evaluate(root, branch),
    };
    let (verdict, mut reason) = gate_verdict(&facts);
    // The script's own words, when we have them, are strictly more useful than "could not be read".
    if let (Some(e), Some(r)) = (checks_err, reason.as_mut()) {
        r.push_str(" (");
        r.push_str(&e);
        r.push(')');
    }
    GateReport {
        branch: branch.to_string(),
        pr,
        verdict,
        reason,
        checks: checks.word(),
        roborev_blocking: match roborev {
            RoborevGate::Read { blocking, .. } => Some(blocking),
            // NOT zero: "roborev does not apply" and "roborev found nothing" are different facts.
            _ => None,
        },
        local_gate: facts.local.word(),
    }
}

/// `gh pr view <n> --json mergeable`. `None` when it could not be read — which the verdict treats
/// as "not CONFLICTING", because the checks path already fails closed on an unreadable `gh`.
fn read_mergeable(root: &str, pr: u64) -> Option<String> {
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.args(["pr", "view", &pr.to_string(), "--json", "mergeable", "-q", ".mergeable"])
        .current_dir(root);
    apply_noninteractive(&mut cmd);
    let out = crate::worktree::output_with_timeout(cmd, SCRIPT_TIMEOUT).ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Fetch `origin/<default>` and catch `branch` up onto it with the RIGHT verb.
fn catch_up_branch(root: &str, branch: &str) -> Result<CatchUp, String> {
    let default = crate::worktree::resolve_default_branch(root);
    let base_ref = format!("origin/{default}");
    let mut fetch = Command::new(crate::preflight::git_program());
    fetch.arg("-C").arg(root).args(["fetch", "--quiet", "--no-tags", "origin", &default]);
    apply_noninteractive(&mut fetch);
    let _ = crate::worktree::output_with_timeout(fetch, SCRIPT_TIMEOUT);

    let merges = crate::worktree::git(
        root,
        &["rev-list", "--merges", "--count", &format!("{base_ref}..{branch}")],
    )
    .map_err(|e| format!("could not tell whether {branch} carries merge commits: {e}"))?;
    let count: usize = merges.trim().parse().map_err(|_| {
        format!("git answered {merges:?} for the merge-commit count, which is not a number")
    })?;
    let verb = catchup_verb(count);
    let argv = catchup_argv(verb, &base_ref);
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    crate::worktree::git(root, &refs).map(|_| verb)
}

/// The result of an attempted merge — including the case where nothing was merged.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub branch: String,
    pub pr: u64,
    /// True ONLY when ancestry proved it. Never the merge command's own claim.
    pub landed: bool,
    #[serde(default)]
    pub refusal: Option<MergeRefusal>,
    /// The head sha the merge decision was made against, and the one ancestry was checked for.
    #[serde(default)]
    pub head_sha: Option<String>,
    /// What cleanup did, or why it did not run.
    pub cleanup: String,
    /// `merge_pr`'s post-merge stranded-work report, when it produced one — the mirror of
    /// `strandedWarning` on the TypeScript side.
    ///
    /// SOME HERE MEANS THE MERGE LANDED, not that it failed. It is the one `Err` `merge_pr` can
    /// return that means the repository DID move: the PR is merged, and commits that were on the
    /// pushed branch head are not in the merge commit. `landed` is true alongside it and the
    /// remote branch is deliberately NOT deleted, because that branch is the only thing still
    /// holding the stranded commits (roborev 72459, bead `sparkle-a08oi0`).
    #[serde(default)]
    pub stranded: Option<String>,
}

/// Gate, refuse or merge, then PROVE it landed before cleaning anything up.
///
/// FROM TYPESCRIPT: `invoke("integration_merge", { root, projectId, branch, pr })`.
#[tauri::command]
pub async fn integration_merge(
    app: tauri::AppHandle,
    root: String,
    project_id: String,
    branch: String,
    pr: u64,
) -> Result<MergeOutcome, String> {
    let c = require_enabled()?;
    if c.auto_rebase {
        let (r, b) = (root.clone(), branch.clone());
        let _ = tauri::async_runtime::spawn_blocking(move || catch_up_branch(&r, &b)).await;
    }
    let roborev = read_roborev_gate(&root, &branch).await;
    let root_for_gate = root.clone();
    let branch_for_gate = branch.clone();
    let cfg_for_gate = c.clone();
    let (gate, slug, head_sha) = tauri::async_runtime::spawn_blocking(move || {
        let gate = gate_branch(
            &root_for_gate,
            &branch_for_gate,
            Some(pr),
            &cfg_for_gate,
            &NoLocalGate,
            roborev,
        );
        let slug = repo_slug(&root_for_gate);
        let head = crate::worktree::git(&root_for_gate, &["rev-parse", &branch_for_gate]).ok();
        (gate, slug, head)
    })
    .await
    .map_err(|e| format!("integration_merge gate task failed: {e}"))?;

    // A slug we could not read is treated as PROTECTED: the pin cannot clear a repo it cannot name.
    let protected = slug.as_deref().map(crate::config::is_merge_protected_slug).unwrap_or(true);
    let slug_label = slug.clone().unwrap_or_else(|| "this repository".to_string());
    if let Some(refusal) = merge_refusal(&slug_label, protected, &c.merge_strategy, &gate) {
        return Ok(MergeOutcome {
            branch,
            pr,
            landed: false,
            refusal: Some(refusal),
            head_sha,
            cleanup: "not run — nothing was merged".to_string(),
            stranded: None,
        });
    }

    // The single sink for every in-app merge: it carries the merge-protected policy gate, the
    // knightwatch review gate and the base-branch gate, and it uses `--merge`.
    //
    // NOT `.await?`. That bare `?` was the defect roborev 72459 found: `merge_pr` has ONE `Err`
    // that means the merge SUCCEEDED, and propagating it as an ordinary failure here built no
    // `MergeOutcome` at all, so a merge that landed was recorded with `landed: false`, the ancestry
    // proof and cleanup never ran, and the entry stayed in the queue for a second Merge click
    // against an already-merged PR. [`outcome_after_merge`] owns that branch, and keeps `?` for
    // every other `Err`.
    let merged = crate::worktree::merge_pr(
        app,
        root.clone(),
        project_id,
        pr,
        None,
        head_sha.clone(),
    )
    .await;

    let root_for_proof = root.clone();
    let sha_for_proof = head_sha.clone();
    let cleanup_wanted = c.cleanup_after_merge;
    tauri::async_runtime::spawn_blocking(move || {
        let root_for_delete = root_for_proof.clone();
        outcome_after_merge(
            merged,
            branch,
            pr,
            head_sha,
            cleanup_wanted,
            move || {
                let default = crate::worktree::resolve_default_branch(&root_for_proof);
                let base_ref = format!("origin/{default}");
                let mut fetch = Command::new(crate::preflight::git_program());
                fetch.arg("-C").arg(&root_for_proof).args([
                    "fetch", "--quiet", "--no-tags", "origin", &default,
                ]);
                apply_noninteractive(&mut fetch);
                let _ = crate::worktree::output_with_timeout(fetch, SCRIPT_TIMEOUT);
                match sha_for_proof.as_deref() {
                    Some(sha) => {
                        confirm_landed_by_ancestry(&root_for_proof, sha, &base_ref).unwrap_or(false)
                    }
                    None => false,
                }
            },
            move |branch| {
                let mut push = Command::new(crate::preflight::git_program());
                push.arg("-C").arg(&root_for_delete).args([
                    "push",
                    "origin",
                    "--delete",
                    branch,
                ]);
                apply_noninteractive(&mut push);
                match crate::worktree::output_with_timeout(push, SCRIPT_TIMEOUT) {
                    Ok(o) if o.status.success() => Ok(()),
                    Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
                    Err(e) => Err(e),
                }
            },
        )
    })
    .await
    .map_err(|e| format!("integration_merge cleanup task failed: {e}"))?
}

/// THE POST-MERGE HALF OF [`integration_merge`], with its two effects injected so the decision it
/// makes can be driven without a Tauri host, a network, or a `gh` anywhere near the machine.
///
/// THE BRANCH THIS EXISTS FOR. `merge_pr` returns `Err` for a refusal — nothing merged, the
/// repository is exactly where it was — with ONE exception: [`crate::worktree`]'s post-merge
/// landing report, which means the merge SUCCEEDED and left commits behind. `integration_merge`
/// used to reach this code through a bare `?`, so that one report took the failure path with
/// `workflow.ts` and `OpenPrMenu.tsx` already wired to treat it as a completed merge — the third
/// consumer of a channel two doc headers described as having two (roborev 72459).
///
/// SO A STRANDED REPORT IS LANDED, AND ITS BRANCH IS NEVER DELETED. `landed` is what takes the
/// entry out of `nextActionable`'s queue, and leaving it false is what offered a second Merge click
/// against an already-merged PR. But the report's own remedy is to open a NEW pull request for the
/// commits that did not land, and the remote branch is the only thing still holding them — so this
/// arm proves landing and then declines the delete, which is the opposite of what `landed: true`
/// means everywhere else here. `prove_landed` is still called on it: the fetch and the ancestry read
/// are what the cleanup line is written from, and skipping them would make the stranded arm the one
/// path through this function that never looks at the repository.
///
/// A GENUINE FAILURE STILL ERRORS, and errors BEFORE either effect runs. Conflating the two
/// directions would be worse than the bug: reporting a merge that never happened as landed clears
/// the row, empties the queue, and deletes the branch of a PR stuck on a conflict.
fn outcome_after_merge(
    merged: Result<(), String>,
    branch: String,
    pr: u64,
    head_sha: Option<String>,
    cleanup_wanted: bool,
    prove_landed: impl FnOnce() -> bool,
    delete_remote_branch: impl FnOnce(&str) -> Result<(), String>,
) -> Result<MergeOutcome, String> {
    // ONE spelling of the token, shared with `mergedButStranded.ts` and `OpenPrMenu.tsx`.
    let stranded = match merged {
        Ok(()) => None,
        Err(msg) if crate::worktree::is_merged_but_stranded_report(&msg) => Some(msg),
        Err(msg) => return Err(msg),
    };
    let proven = prove_landed();
    let (landed, cleanup) = match (stranded.is_some(), proven, cleanup_wanted) {
        (true, _, _) => (
            true,
            format!(
                "not run — the merge landed but left commits on {branch} that it did not take, and                  that branch is the only thing still holding them"
            ),
        ),
        (false, false, _) => (
            false,
            "not run — ancestry could not prove the merge landed, so nothing was deleted".to_string(),
        ),
        (false, true, false) => (true, "skipped — cleanup_after_merge is false".to_string()),
        (false, true, true) => match delete_remote_branch(&branch) {
            Ok(()) => (true, format!("deleted the remote branch {branch}")),
            Err(e) => (true, format!("the merge landed, but deleting {branch} failed: {e}")),
        },
    };
    Ok(MergeOutcome { branch, pr, landed, refusal: None, head_sha, cleanup, stranded })
}

/// What this assistant is configured to do, and whether the tooling it needs is here.
///
/// FROM TYPESCRIPT: `invoke("integration_status", { root })`.
#[tauri::command]
pub async fn integration_status(root: String) -> Result<IntegrationStatus, String> {
    let c = cfg();
    tauri::async_runtime::spawn_blocking(move || {
        let slug = repo_slug(&root);
        Ok(IntegrationStatus {
            enabled: c.enabled,
            auto_rebase: c.auto_rebase,
            require_roborev_clean: c.require_roborev_clean,
            merge_strategy: c.merge_strategy.clone(),
            cleanup_after_merge: c.cleanup_after_merge,
            pr_checks_available: Path::new(&root).join("scripts/pr-checks.sh").exists(),
            pr_overlap_available: Path::new(&root).join("scripts/pr-file-overlap.sh").exists(),
            merge_protected: slug
                .as_deref()
                .map(crate::config::is_merge_protected_slug)
                .unwrap_or(true),
            slug,
            local_gate: NoLocalGate.evaluate("", "").word(),
        })
    })
    .await
    .map_err(|e| format!("integration_status task failed: {e}"))?
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// TESTS
//
// Every test here asserts the SIDE EFFECT — the verdict, the order, the sentence a human reads —
// rather than a precondition. Where a rule could be masked by an earlier one deciding the outcome
// first (the "an earlier guard short-circuits the path" shape this repo tracks as its most common
// vacuous test), the test states the OTHER facts as clean, so only the rule under test can move the
// answer, and its negative pair is written beside it.
// ════════════════════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    // ── THE SEAM MUST BE ON THE PATH, NOT MERELY CORRECT (roborev 72492) ─────────────────────
    // `outcome_after_merge` is unit-tested directly, and those tests prove it DECIDES correctly.
    // They do not prove `integration_merge` ROUTES THROUGH IT. Restore the bare `.await?` on the
    // `merge_pr` call — the exact two-character defect this whole change exists to remove — and
    // `outcome_after_merge` becomes an orphan that the test module still calls directly: every
    // behavioural test here stays green, `worktree.rs`'s matcher tests stay green, and the panel
    // test stays green because it mocks `mergeBranch` at the TS boundary and never crosses into
    // Rust. The crate has no `deny(dead_code)`, so the orphan does not even warn. That is the
    // vacuous-coverage shape AGENTS.md calls the #1 fleet-wide finding, sitting on the one line
    // that actually carried the bug.
    //
    // So this is a STRUCTURAL pin, the same `include_str!` idiom `worktree.rs` and `knightwatch.rs`
    // already use for exactly this problem. It is the only assertion here that reddens when the
    // seam is bypassed.
    #[test]
    fn integration_merge_routes_its_merge_result_through_outcome_after_merge() {
        let src = include_str!("integration_assistant.rs");
        let start = src
            .find("pub async fn integration_merge(")
            .expect("integration_merge's signature");
        // Bound the slice at the NEXT top-level item, so a later function's text can never satisfy
        // — or falsify — an assertion about this one.
        let rest = &src[start..];
        let end = rest.find("\nfn outcome_after_merge(").expect("outcome_after_merge follows it");
        let body = &rest[..end];

        // 1. The result is BOUND, not `?`-propagated. This is the line the bug lived on.
        assert!(
            body.contains("let merged = crate::worktree::merge_pr("),
            "integration_merge must BIND merge_pr's result so the stranded arm can be inspected, \
             not propagate it with `?` — a MERGED-BUT-STRANDED report means the merge LANDED"
        );

        // 2. …and it is handed to the seam. Binding it and then ignoring it would pass (1) alone.
        assert!(
            body.contains("outcome_after_merge("),
            "integration_merge must pass merge_pr's result to outcome_after_merge"
        );

        // 3. …and nothing in this function `?`-propagates a merge_pr result after all. Asserted on
        //    the WHOLE-LINE form, because a substring test passes for a commented-out call.
        assert!(
            !body.lines().any(|l| l.trim() == ".await?;"),
            "integration_merge must not `?`-propagate merge_pr's Err — that is the third-consumer \
             gap roborev 72492 reports, and it is reintroducible with a two-character edit"
        );
    }

    use super::*;

    // ── the check-code contract ────────────────────────────────────────────────────────────

    /// A `GateFacts` where nothing but the named fact can move the verdict.
    fn facts(checks: CheckState, roborev: RoborevGate) -> GateFacts {
        GateFacts {
            checks,
            roborev,
            mergeable: Some("MERGEABLE".to_string()),
            require_roborev_clean: true,
            local: LocalGateOutcome::NotRun,
        }
    }

    fn clean_roborev() -> RoborevGate {
        RoborevGate::Read { blocking: 0, in_flight: 0 }
    }

    #[test]
    fn every_pr_checks_exit_code_gets_its_own_verdict_and_only_zero_is_ready() {
        // The point of the whole table: 2/3/4/5 are NOT green, and they are not the same as each
        // other either — collapsing 4 (never tested, never will be) into 2 (ask again later) is how
        // a PR sat three days waiting for a run GitHub was never going to create.
        let cases: [(i32, CheckState, &'static str); 7] = [
            (0, CheckState::Pass, VERDICT_READY),
            (1, CheckState::Failed, VERDICT_BLOCKED),
            (2, CheckState::Pending, VERDICT_UNKNOWN),
            (3, CheckState::Unreadable, VERDICT_UNKNOWN),
            (4, CheckState::RebaseRequired, VERDICT_BLOCKED),
            (5, CheckState::NeverRan, VERDICT_BLOCKED),
            (7, CheckState::Unexpected(7), VERDICT_UNKNOWN),
        ];
        for (code, state, verdict) in cases.clone() {
            assert_eq!(classify_pr_checks_exit(code), state, "exit {code} classified wrong");
            let (got, reason) = gate_verdict(&facts(state.clone(), clean_roborev()));
            assert_eq!(got, verdict, "exit {code} ({}) reached the wrong verdict", state.word());
            if verdict == VERDICT_READY {
                assert!(reason.is_none(), "a ready verdict carries no reason");
            } else {
                // A refusal with no reason is unactionable, and every non-zero code here is one a
                // human has to do something about.
                assert!(
                    reason.as_deref().is_some_and(|r| !r.trim().is_empty()),
                    "exit {code} refused without saying why"
                );
            }
        }
        // And every state has its OWN word, so a UI chip cannot show two of them identically.
        let words: BTreeSet<String> =
            cases.iter().map(|(_, s, _)| s.word()).collect();
        assert_eq!(words.len(), cases.len(), "two check states render as the same word");
    }

    #[test]
    fn a_blocked_gate_names_every_reason_not_just_the_first_one_found() {
        // THE ANTI-SHORT-CIRCUIT TEST. With red checks AND undrained findings, a gate that returned
        // at the first bad fact would report one problem, the human would fix it, and the second
        // would surface a full round-trip later. It is also what would make the roborev rule below
        // untestable: the checks rule would already have decided the answer.
        let (verdict, reason) = gate_verdict(&facts(
            CheckState::Failed,
            RoborevGate::Read { blocking: 2, in_flight: 1 },
        ));
        assert_eq!(verdict, VERDICT_BLOCKED);
        let reason = reason.expect("a blocked gate must say why");
        assert!(reason.contains("CI checks failed"), "lost the checks reason: {reason}");
        assert!(reason.contains("2 open roborev"), "lost the roborev reason: {reason}");
        // The still-unknown fact survives too — blocking wins the VERDICT, it does not delete the
        // rest of what the reader needs.
        assert!(reason.contains("in flight"), "lost the in-flight reason: {reason}");
    }

    #[test]
    fn could_not_tell_is_never_ready_and_says_which_thing_could_not_be_told() {
        // Fail closed, one fact at a time, each with green checks so only the named fact can move
        // the verdict.
        let (v, r) = gate_verdict(&facts(
            CheckState::Pass,
            RoborevGate::Unknown("daemon is down".to_string()),
        ));
        assert_eq!(v, VERDICT_UNKNOWN);
        assert!(r.unwrap().contains("daemon is down"), "the tool's own words must survive");

        // A review round still running is unknown, NOT blocked: there is no verdict to acknowledge
        // yet, which is exactly the state PR #806 was merged in.
        let (v, r) = gate_verdict(&facts(
            CheckState::Pass,
            RoborevGate::Read { blocking: 0, in_flight: 3 },
        ));
        assert_eq!(v, VERDICT_UNKNOWN);
        assert!(r.unwrap().contains("3 roborev review round(s)"));
    }

    #[test]
    fn roborev_gates_only_while_require_roborev_clean_is_on_and_not_applicable_is_not_a_pass() {
        // The PAIR. "Off does not block" alone would pass for a gate that never consulted roborev
        // at all, so the ON case is asserted beside it on the identical facts.
        let mut on = facts(CheckState::Pass, RoborevGate::Read { blocking: 1, in_flight: 0 });
        assert_eq!(gate_verdict(&on).0, VERDICT_BLOCKED, "with the switch on, a FAIL must block");
        on.require_roborev_clean = false;
        assert_eq!(gate_verdict(&on).0, VERDICT_READY, "with the switch off, it must not");

        // NotApplicable is roborev being absent, not roborev being clean — it does not gate, and it
        // must not be reported as a count either (see the GateReport field's comment).
        assert_eq!(
            gate_verdict(&facts(CheckState::Pass, RoborevGate::NotApplicable)).0,
            VERDICT_READY
        );
    }

    #[test]
    fn a_conflicting_pr_is_blocked_even_when_the_rollup_reads_green() {
        // The two facts come from different queries: a rollup cached against an older head can be
        // green on a head that no longer merges. Green checks here are what makes this test about
        // the mergeable rule and nothing else.
        let mut f = facts(CheckState::Pass, clean_roborev());
        f.mergeable = Some("CONFLICTING".to_string());
        let (v, r) = gate_verdict(&f);
        assert_eq!(v, VERDICT_BLOCKED);
        assert!(r.unwrap().contains("CONFLICTING"));
        // UNKNOWN mergeable must NOT block on its own — the checks path already fails closed on an
        // unreadable gh, and blocking here too would freeze every PR gh cannot classify.
        f.mergeable = Some("UNKNOWN".to_string());
        assert_eq!(gate_verdict(&f).0, VERDICT_READY);
    }

    #[test]
    fn the_local_gate_seam_blocks_when_it_fails_and_not_running_is_not_passing() {
        // Bead .1's seam. THREE states: a failing local gate blocks, and `NotRun` — what
        // production answers today — must not be recorded as a pass, or wiring the real gate in
        // later would be a silent downgrade of every verdict taken before it.
        let mut f = facts(CheckState::Pass, clean_roborev());
        f.local = LocalGateOutcome::Fail("3 unit tests failed".to_string());
        let (v, r) = gate_verdict(&f);
        assert_eq!(v, VERDICT_BLOCKED);
        assert!(r.unwrap().contains("3 unit tests failed"));

        f.local = LocalGateOutcome::NotRun;
        assert_eq!(gate_verdict(&f).0, VERDICT_READY, "an unwired gate must not block");
        assert_ne!(
            LocalGateOutcome::NotRun.word(),
            LocalGateOutcome::Pass.word(),
            "not-run and pass must be distinguishable on the wire"
        );
        assert_eq!(NoLocalGate.evaluate("/repo", "b"), LocalGateOutcome::NotRun);
    }

    // ── roborev row bucketing ──────────────────────────────────────────────────────────────

    fn row(id: u64, status: &str, verdict: Option<&str>, closed: bool)
        -> crate::roborev_probe::RoborevJobRow
    {
        crate::roborev_probe::RoborevJobRow {
            id,
            branch: "b".into(),
            git_ref: "deadbeef".into(),
            status: status.into(),
            verdict: verdict.map(str::to_string),
            closed,
            commit_subject: None,
            finished_at: None,
        }
    }

    #[test]
    fn row_bucketing_matches_the_merge_guard_contract() {
        let rows = vec![
            row(1, "done", Some("F"), false),  // open FAIL           → blocking
            row(2, "done", Some("F"), true),   // CLOSED fail         → judged, not blocking
            row(3, "done", None, false),       // done, no verdict    → unread, blocking
            row(4, "running", None, false),    // in flight
            row(5, "queued", None, false),     // in flight
            row(6, "done", Some("P"), false),  // open PASS           → informational
            row(7, "failed", None, false),     // errored             → unknown is not clean
            row(8, "banana", None, false),     // unrecognised status → unknown is not clean
        ];
        assert_eq!(
            roborev_gate_from_rows(true, Some(&rows), None),
            RoborevGate::Read { blocking: 4, in_flight: 2 }
        );
        // roborev not in play: the gate does not apply. NOT "clean".
        assert_eq!(roborev_gate_from_rows(false, Some(&rows), None), RoborevGate::NotApplicable);
        // Enabled but unreadable: unknown, carrying the tool's own words.
        assert_eq!(
            roborev_gate_from_rows(true, None, Some("wedged")),
            RoborevGate::Unknown("wedged".to_string())
        );
        // An authoritative EMPTY reading is a real answer and is different from the one above.
        assert_eq!(
            roborev_gate_from_rows(true, Some(&[]), None),
            RoborevGate::Read { blocking: 0, in_flight: 0 }
        );
    }

    // ── the merge-order planner ────────────────────────────────────────────────────────────

    struct FakeLister(BTreeMap<String, Result<Vec<String>, String>>);

    impl FakeLister {
        fn new(pairs: &[(&str, &[&str])]) -> Self {
            FakeLister(
                pairs
                    .iter()
                    .map(|(b, files)| {
                        ((*b).to_string(), Ok(files.iter().map(|f| (*f).to_string()).collect()))
                    })
                    .collect(),
            )
        }
    }

    impl DiffLister for FakeLister {
        fn changed_files(&self, _base: &str, branch: &str) -> Result<Vec<String>, String> {
            self.0.get(branch).cloned().unwrap_or_else(|| Err("no such branch".to_string()))
        }
    }

    fn cands(names: &[&str]) -> Vec<BranchCandidate> {
        names
            .iter()
            .map(|n| BranchCandidate { branch: (*n).to_string(), pr: None, agent_id: None })
            .collect()
    }

    #[test]
    fn the_most_entangled_branch_merges_last_and_the_order_is_deterministic() {
        // THE FIXTURE IS THE TEST. `hub` collides with BOTH others (degree 2); `a` and `b` collide
        // only with `hub` (degree 1) and not with each other. And the degrees deliberately run the
        // OPPOSITE WAY to the diff sizes — `hub` is a SMALLEST diff and must still sort last, while
        // `a` is the largest and sorts second — so this pins all three sort terms at once:
        //
        //   * reverse the degree comparison  -> hub, b, a  -> red
        //   * drop the degree term entirely  -> b, hub, a  -> red   (size then name)
        //   * drop the size tie-break        -> a, b, hub  -> red   (degree then name)
        //
        // The first version of this test gave all three branches the SAME degree (every pair shared
        // one file), so the degree term was a no-op and reversing it changed nothing — a green test
        // with no grip on the rule it named. `scripts/mutation-gate.sh` still reported PASS on the
        // file, because a line-scan passes on the first mutation ANY test in it catches.
        let lister = FakeLister::new(&[
            ("a", &["src/a1.rs", "src/a2.rs", "src/a3.rs", "src/a4.rs", "src/shared.rs"]),
            ("b", &["src/b1.rs", "src/other.rs"]),
            ("hub", &["src/shared.rs", "src/other.rs"]),
        ]);
        let plan = plan_merge_order("main", &cands(&["hub", "a", "b"]), &lister);
        let order: Vec<&str> = plan.order.iter().map(|p| p.branch.as_str()).collect();
        assert_eq!(order, vec!["b", "a", "hub"], "the most entangled branch must merge LAST");
        assert_eq!(plan.order[0].position, 1, "positions are 1-based");
        assert_eq!(plan.order[2].overlaps_with, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(plan.order[1].changed_files, 5);
        // `a` and `b` share nothing, so neither may be listed against the other.
        assert_eq!(plan.order[0].overlaps_with, vec!["hub".to_string()]);

        // Re-planning the same set in a different input order yields the SAME plan: a plan that
        // reshuffles between two identical runs cannot be reviewed.
        let again = plan_merge_order("main", &cands(&["b", "hub", "a"]), &lister);
        assert_eq!(again.order, plan.order, "the plan must be deterministic");
    }

    #[test]
    fn every_overlapping_pair_is_warned_about_by_name_and_the_sentence_names_the_paths() {
        let lister = FakeLister::new(&[
            ("a", &["src/one.rs", "src/two.rs"]),
            ("b", &["src/two.rs", "src/one.rs"]),
            ("c", &["src/three.rs"]),
        ]);
        let plan = plan_merge_order("main", &cands(&["a", "b", "c"]), &lister);
        assert_eq!(plan.warnings.len(), 1, "exactly one pair collides: {:?}", plan.warnings);
        let w = &plan.warnings[0];
        assert_eq!((w.a.as_str(), w.b.as_str()), ("a", "b"));
        // SORTED, so the text is stable — and BOTH shared paths, not just the first one found.
        assert_eq!(w.paths, vec!["src/one.rs".to_string(), "src/two.rs".to_string()]);
        assert!(w.sentence.contains("src/one.rs") && w.sentence.contains("src/two.rs"));
        assert!(w.sentence.contains("2 files"), "the sentence must count them: {}", w.sentence);
        assert_eq!(w.sentence, overlap_sentence(w), "the row carries the canonical sentence");
        // `c` shares nothing, so it must not be dragged into a warning.
        assert!(!w.sentence.contains(" c "), "c collides with nobody: {}", w.sentence);
    }

    #[test]
    fn a_branch_whose_diff_cannot_be_read_is_unplannable_rather_than_quietly_dropped() {
        let mut map = BTreeMap::new();
        map.insert("good".to_string(), Ok(vec!["src/x.rs".to_string()]));
        map.insert("broken".to_string(), Err("fatal: bad revision".to_string()));
        map.insert("empty".to_string(), Ok(vec![]));
        let lister = FakeLister(map);
        let plan = plan_merge_order("main", &cands(&["good", "broken", "empty", "good"]), &lister);

        // The side effect that matters: the unreadable branch is REPORTED, not silently missing,
        // because a caller reading only `order` would otherwise never learn it was skipped.
        assert_eq!(plan.order.len(), 1, "only `good` is plannable: {:?}", plan.order);
        let reasons: BTreeMap<&str, &str> =
            plan.unplannable.iter().map(|u| (u.branch.as_str(), u.reason.as_str())).collect();
        assert!(reasons["broken"].contains("fatal: bad revision"), "git's own words must survive");
        assert!(reasons["empty"].contains("nothing here to merge"));
        // The duplicate `good` is one branch, not two entries in the order.
        assert_eq!(plan.order[0].branch, "good");
    }

    // ── catching up ────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_branch_with_merge_commits_is_merged_and_the_merge_never_opens_an_editor() {
        assert_eq!(catchup_verb(0), CatchUp::Rebase);
        assert_eq!(catchup_verb(1), CatchUp::Merge, "one merge commit is enough to forbid a rebase");
        assert_eq!(catchup_verb(8), CatchUp::Merge);
        assert_eq!(catchup_argv(CatchUp::Rebase, "origin/main"), vec!["rebase", "origin/main"]);
        // `--no-edit` is load-bearing: without it git opens $EDITOR and the call hangs until
        // something kills it, taking everything chained after it down with it.
        assert_eq!(
            catchup_argv(CatchUp::Merge, "origin/main"),
            vec!["merge", "--no-edit", "origin/main"]
        );
    }

    // ── refusals ───────────────────────────────────────────────────────────────────────────

    fn gate(verdict: &str, reason: Option<&str>, checks: CheckState) -> GateReport {
        GateReport {
            branch: "b".into(),
            pr: Some(7),
            verdict: verdict.into(),
            reason: reason.map(str::to_string),
            checks: checks.word(),
            roborev_blocking: Some(0),
            local_gate: "not-run".into(),
        }
    }

    /// A remedy must be safe under the SAME conditions that produced the refusal. These are the
    /// spellings of "do the unsafe thing by hand" — a remedy containing one of them would have
    /// turned the refusal into an instruction to route around it.
    fn assert_remedy_is_safe(r: &MergeRefusal) {
        for unsafe_advice in ["gh pr merge", "--admin", "--squash", "--auto", "force"] {
            assert!(
                !r.remedy.to_ascii_lowercase().contains(unsafe_advice),
                "the remedy tells the reader to {unsafe_advice}, which is the thing that was \
                 refused: {}",
                r.remedy
            );
        }
        assert!(!r.remedy.trim().is_empty(), "a refusal with no remedy is unactionable");
    }

    #[test]
    fn a_merge_protected_repo_is_refused_first_and_its_remedy_does_not_route_around_the_pin() {
        // FIRST, on a gate that is otherwise perfectly ready: the policy floor must not depend on
        // the checks having been read, or a repo we will never merge in could still be gated on a
        // network round-trip.
        let r = merge_refusal("plow-pbc/tkmx-server", true, "merge", &gate(VERDICT_READY, None, CheckState::Pass))
            .expect("a merge-protected repo must refuse even a green gate");
        assert!(r.reason.contains("plow-pbc/tkmx-server"), "the refusal must name the repo");
        assert!(r.reason.contains("merge-protected"));
        assert_remedy_is_safe(&r);
        assert!(r.remedy.contains("human"), "the only safe path is a person: {}", r.remedy);
    }

    #[test]
    fn squash_is_refused_with_the_reason_and_merge_is_the_only_accepted_strategy() {
        assert_eq!(validate_merge_strategy("merge").unwrap(), "merge");
        assert_eq!(validate_merge_strategy("  MERGE ").unwrap(), "merge");
        // An absent value means the default, not an error.
        assert_eq!(validate_merge_strategy("").unwrap(), "merge");
        let e = validate_merge_strategy("squash").unwrap_err();
        assert!(e.contains("ancestor"), "the refusal must say WHY, not just no: {e}");
        assert!(validate_merge_strategy("rebase").is_err());

        // And it refuses at the merge path too, on an otherwise-ready gate, so the rule is not
        // reachable only through config.
        let r = merge_refusal("drodio/sparkle", false, "squash", &gate(VERDICT_READY, None, CheckState::Pass))
            .expect("a squash strategy must refuse");
        assert!(r.reason.contains("ancestor"));
        assert_remedy_is_safe(&r);
    }

    #[test]
    fn a_ready_gate_in_an_unprotected_repo_is_not_refused() {
        // The POSITIVE pair for every refusal above. Without it, all of them would pass for a
        // function that refused unconditionally.
        assert_eq!(
            merge_refusal("drodio/sparkle", false, "merge", &gate(VERDICT_READY, None, CheckState::Pass)),
            None
        );
    }

    #[test]
    fn each_blocked_reason_gets_a_remedy_that_leaves_the_pr_unmerged() {
        let cases = [
            (
                gate(VERDICT_BLOCKED, Some("the PR is CONFLICTING with its base"), CheckState::RebaseRequired),
                "origin/main",
            ),
            (
                gate(VERDICT_BLOCKED, Some("2 open roborev review(s) carry a FAIL verdict"), CheckState::Pass),
                "roborev",
            ),
            (gate(VERDICT_BLOCKED, Some("CI checks failed"), CheckState::Failed), "failing check"),
            (gate(VERDICT_UNKNOWN, Some("CI checks have no verdict yet"), CheckState::Pending), "again"),
        ];
        for (g, expected) in cases {
            let r = merge_refusal("drodio/sparkle", false, "merge", &g)
                .unwrap_or_else(|| panic!("{} must refuse", g.verdict));
            assert_eq!(r.reason, g.reason.clone().unwrap());
            assert!(
                r.remedy.contains(expected),
                "the remedy for {:?} does not point anywhere useful: {}",
                g.reason,
                r.remedy
            );
            assert_remedy_is_safe(&r);
        }
    }

    // ── the scoped PR ──────────────────────────────────────────────────────────────────────

    #[test]
    fn the_title_carries_the_convention_once_and_only_once() {
        assert_eq!(scoped_pr_title("fix", Some("preview"), "keep the route", "b"), "fix(preview): keep the route");
        // An already-prefixed subject must not be prefixed twice — the naive format! did exactly
        // that, and it reads as a bug in the tool rather than a bug in the input.
        assert_eq!(
            scoped_pr_title("fix", Some("preview"), "fix(preview): keep the route", "b"),
            "fix(preview): keep the route"
        );
        // An unrecognised type is normalized, not rejected: a slightly-wrong title beats no PR.
        assert_eq!(scoped_pr_title("wibble", None, "do a thing", "b"), "chore: do a thing");
        assert_eq!(scoped_pr_title("FEAT", None, "do a thing.", "b"), "feat: do a thing");
        // A blank subject falls back rather than producing a title `gh` will reject at the far end
        // of a long operation.
        assert_eq!(scoped_pr_title("feat", None, "   ", "my-branch"), "feat: my-branch");
        // Prose that merely contains a colon keeps all of its words.
        assert_eq!(
            scoped_pr_title("docs", None, "TODO: write the guide", "b"),
            "docs: TODO: write the guide"
        );
    }

    #[test]
    fn the_body_fills_the_repos_template_without_deleting_any_of_it() {
        let template = "## Summary\n\n<!-- describe your change -->\n\n## Checklist\n\n- [ ] I read CONTRIBUTING.md\n";
        let marker = crate::pr_owner::pr_body_marker("a1", "p1");
        let body = scoped_pr_body(
            Some(template),
            &PrBodyContext {
                summary: "Adds the integration assistant.",
                scope_paths: &["src/integration_assistant.rs".to_string()],
                verification: &["cargo test — 12 passed".to_string()],
                beads: &[".2".to_string()],
                owner_marker: &marker,
            },
        );
        // THE TEMPLATE'S OWN CONTRACT SURVIVES. A builder that discards what it does not recognise
        // silently deletes the repo's review checklist, which is the thing the template is for.
        assert!(body.contains("## Checklist"), "the template's other sections must survive:\n{body}");
        assert!(body.contains("- [ ] I read CONTRIBUTING.md"));
        // Our summary lands UNDER the template's own heading, not in a second one we invented.
        assert_eq!(body.matches("## Summary").count(), 1, "no duplicate Summary heading:\n{body}");
        let summary_at = body.find("## Summary").unwrap();
        let checklist_at = body.find("## Checklist").unwrap();
        let text_at = body.find("Adds the integration assistant.").unwrap();
        assert!(summary_at < text_at && text_at < checklist_at, "summary landed outside its section:\n{body}");
        // The author-guidance comment is gone; the OWNER MARKER, which is also an HTML comment, is
        // not — it is added after the strip, which is the whole reason for that ordering.
        assert!(!body.contains("describe your change"), "guidance comments must be dropped:\n{body}");
        assert_eq!(
            crate::pr_owner::parse_pr_body_marker(&body),
            Some(("a1".into(), "p1".into())),
            "the body we would send must parse back to the same owner:\n{body}"
        );
        assert!(body.trim_end().ends_with(&marker), "the marker must be last:\n{body}");
        // Sections the template has no heading for are appended rather than lost.
        assert!(body.contains("Refs: .2"), "the Refs trailer must be present:\n{body}");
        assert!(body.contains("- cargo test — 12 passed"));
    }

    #[test]
    fn with_no_template_the_builder_writes_its_own_sections_and_omits_the_empty_ones() {
        let marker = crate::pr_owner::pr_body_marker("a1", "p1");
        let body = scoped_pr_body(
            None,
            &PrBodyContext {
                summary: "One line.",
                scope_paths: &["a.rs".to_string()],
                verification: &[],
                beads: &[],
                owner_marker: &marker,
            },
        );
        assert!(body.contains("## Summary\n\nOne line."));
        assert!(body.contains("## Scope\n\n- a.rs"));
        // An empty `## Verification` reads as "verified: nothing", which is worse than no heading.
        assert!(!body.contains("## Verification"), "an empty section must be omitted:\n{body}");
        assert!(!body.contains("## Beads"));
        assert!(body.trim_end().ends_with(&marker));
    }

    #[test]
    fn an_unclosed_html_comment_does_not_swallow_the_rest_of_the_template() {
        // The same rule `parse_pr_body_marker` applies, for the same reason: a truncated comment
        // must cost one line, not the whole document.
        let body = scoped_pr_body(
            Some("## Notes\n\n<!-- oops\n\n## Checklist\n\n- [ ] keep me\n"),
            &PrBodyContext { summary: "s", ..Default::default() },
        );
        assert!(body.contains("- [ ] keep me"), "an unclosed comment ate the template:\n{body}");
    }

    #[test]
    fn the_convention_and_the_bead_refs_are_read_off_the_branchs_own_commits() {
        let subjects: Vec<String> = ["fix(preview): b", "fix(preview): a", "chore: c"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            infer_type_and_scope(&subjects),
            ("fix".to_string(), Some("preview".to_string())),
            "the branch's own majority convention must win"
        );
        // No conventional prefix anywhere is an honest fallback, not a guess.
        assert_eq!(
            infer_type_and_scope(&["just some words".to_string()]),
            ("chore".to_string(), None)
        );

        // EVERY bead named across the branch, deduped — a bead whose fix shipped unnamed stays at
        // the top of the inbox forever, accruing recurrences from agents rediscovering the fix.
        let messages = "fix: a\n\nRefs: , \n\nfix: b\n\nRefs: \n";
        assert_eq!(
            beads_from_messages(messages),
            vec!["".to_string(), "".to_string()]
        );
        assert!(beads_from_messages("no trailer here").is_empty());
    }

    // ── proof of landing ───────────────────────────────────────────────────────────────────

    #[test]
    fn landing_is_proven_by_ancestry_and_an_unknown_commit_is_never_landed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_string_lossy().to_string();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .expect("git ran");
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        run(&["init", "--quiet", "-b", "main"]);
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "--quiet", "-m", "first"]);
        let first = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "--quiet", "-b", "side"]);
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "--quiet", "-m", "second"]);
        let side = run(&["rev-parse", "HEAD"]);

        // `first` IS on main; `side` is NOT — and the second answer is the one that must be a
        // definitive `false` rather than an error, because it is what stops the cleanup.
        assert_eq!(confirm_landed_by_ancestry(&root, &first, "main"), Ok(true));
        assert_eq!(confirm_landed_by_ancestry(&root, &side, "main"), Ok(false));
        // No sha at all is an ERROR, never a `false` and never a `true`: refusing to answer is the
        // only honest thing to do about a commit we cannot name, and `false` would read as a
        // decided "did not land".
        assert!(confirm_landed_by_ancestry(&root, "  ", "main").is_err());
        // A commit this repo has never heard of cannot be proven landed either.
        assert!(confirm_landed_by_ancestry(&root, "0".repeat(40).as_str(), "main").is_err());
    }

    // ── the THIRD consumer of `merge_pr`'s `Err` channel (roborev 72459) ───────────────────

    /// Drive [`outcome_after_merge`] with both effects recorded, so what is asserted is the
    /// OUTCOME — what `MergeOutcome` was built and what ran — and not that a matcher matched.
    fn drive(
        merged: Result<(), String>,
        cleanup_wanted: bool,
        proven: bool,
    ) -> (Result<MergeOutcome, String>, bool, bool) {
        let proved = std::cell::Cell::new(false);
        let deleted = std::cell::Cell::new(false);
        let out = outcome_after_merge(
            merged,
            "sparkle/agent-x".to_string(),
            2580,
            Some("cafe1234".to_string()),
            cleanup_wanted,
            || {
                proved.set(true);
                proven
            },
            |_| {
                deleted.set(true);
                Ok(())
            },
        );
        (out, proved.get(), deleted.get())
    }

    /// The REAL report, from the writer, rather than a hand-typed token — a fixture spelled here
    /// would be exactly the two-halves-wrong-the-same-way shape AGENTS.md warns about.
    fn real_stranded_report() -> String {
        crate::worktree::stranded_after_merge_report(
            2580,
            "sparkle/agent-x",
            "aaaa1111",
            "bbbb2222",
            2,
        )
    }

    /// THE BUG, ASSERTED AS AN OUTCOME. The bare `?` this replaced returned `Err` here, so no
    /// `MergeOutcome` existed at all: `landed` was never true, `nextActionable` kept offering the
    /// entry, and a second Merge click re-issued `gh pr merge` against an already-merged PR.
    #[test]
    fn a_stranded_report_is_a_LANDED_merge_that_carries_the_report_and_keeps_its_branch() {
        let report = real_stranded_report();
        // Ancestry `false` on purpose: the stranded case is precisely the one where the head the
        // merge was decided against may not be on the default branch, so a fix that merely let
        // the existing block run would still record `landed: false` and still offer the Merge.
        let (out, proved, deleted) = drive(Err(report.clone()), true, false);
        let o = out.expect("a merge that LANDED must not reach the Err channel");
        assert!(o.landed, "the PR IS merged — `landed: false` is what keeps it in the queue");
        assert_eq!(o.stranded.as_deref(), Some(report.as_str()), "the report must be carried");
        assert!(o.refusal.is_none(), "nothing refused — the merge happened");
        // The ancestry proof and the cleanup block are REACHED, which the bare `?` skipped.
        assert!(proved, "the post-merge proof must still run on this arm");
        // ...but the branch is the only thing still holding the stranded commits.
        assert!(!deleted, "deleting the branch destroys the commits the report says to re-open");
        assert!(o.cleanup.contains("sparkle/agent-x"), "the cleanup line must say why: {}", o.cleanup);
        // Even with ancestry AGREEING, the branch still survives — `landed` is not the delete rule
        // here, and a stranded merge that happened to prove ancestry must not be swept up by it.
        let (out, _, deleted) = drive(Err(real_stranded_report()), true, true);
        assert!(!deleted, "still stranded, still not deleted");
        assert!(out.expect("landed").landed);
    }

    /// THE PAIR. Conflating these two directions would be worse than the bug it fixes: a merge
    /// that never happened, recorded as landed, clears the row, empties the queue and deletes the
    /// branch of a PR that is stuck on a conflict.
    #[test]
    fn a_genuine_merge_failure_still_errors_and_touches_nothing() {
        for msg in [
            "gh pr merge #2580 failed: Pull request is not mergeable: the merge commit cannot be cleanly created",
            "knightwatch: 3 open fail-verdict findings on this branch",
            "",
        ] {
            let (out, proved, deleted) = drive(Err(msg.to_string()), true, true);
            assert_eq!(out.as_ref().err().map(String::as_str), Some(msg), "must stay an Err: {msg:?}");
            // Nothing merged, so nothing may be proven and nothing may be deleted.
            assert!(!proved && !deleted, "a refusal must not reach the post-merge half: {msg:?}");
        }
        // A message that merely QUOTES the report is not the report — the token has to lead.
        let quoted = format!("gh pr merge #2580 failed; the previous run said: {}", real_stranded_report());
        assert!(drive(Err(quoted), true, true).0.is_err(), "an embedded token is not a landed merge");
    }

    /// The `Ok(())` path is unchanged, and it is what pins that the stranded arm is a genuinely
    /// separate state rather than "landed" being handed out to everything that is not an error.
    #[test]
    fn an_ordinary_merge_still_needs_ancestry_and_still_deletes_the_branch() {
        let (out, _, deleted) = drive(Ok(()), true, true);
        let o = out.expect("ok");
        assert!(o.landed && o.stranded.is_none());
        assert!(deleted, "an ordinary landed merge still cleans up");
        assert!(o.cleanup.contains("deleted"), "{}", o.cleanup);

        // Ancestry could not prove it: NOT landed, nothing deleted — the pre-existing rule.
        let (out, _, deleted) = drive(Ok(()), true, false);
        let o = out.expect("ok");
        assert!(!o.landed, "an unproven merge is not landed");
        assert!(!deleted && o.cleanup.contains("ancestry"), "{}", o.cleanup);

        // Cleanup turned off: landed, nothing deleted.
        let (out, _, deleted) = drive(Ok(()), false, true);
        assert!(out.expect("ok").landed && !deleted);
    }
}

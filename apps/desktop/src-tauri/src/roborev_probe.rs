//! Reading roborev's verdict for a branch, so a merge gate can honour it.
//!
//! WHY THIS EXISTS: on 2026-07-29 PR #806 was merged on CI-green while its owning agent was holding
//! it for a roborev round. The concierge could not see roborev at all — not because roborev was
//! silent, but because nothing in the app could ask it. This module is that question.
//!
//! THE ONE INVARIANT: three states, never two. "roborev is not the gate here" (`enabled: false`),
//! "it IS the gate and I could not read it" (`enabled: true, jobs: None`), and an authoritative
//! answer (`jobs: Some(_)`, where `Some([])` means "asked; this branch has no reviews"). Collapsing
//! the middle state into either of the others reintroduces the exact bug this change exists to fix,
//! which is why the failure paths below all return `Ok(..)` with `jobs: None` rather than a bare
//! `Err` the caller would be tempted to treat as "probably fine".

use std::process::Command;
use std::time::Duration;

/// Bound the probe's wall clock. The roborev CLI talks to a local daemon, so a healthy call is
/// milliseconds; the case this guards is a WEDGED daemon, where the CLI blocks indefinitely on its
/// socket. A merge gate that hangs is worse than one that says "unknown" — unknown at least blocks
/// with a reason a human can act on.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Default number of jobs to read for a branch, and the range a caller's request is clamped into.
/// Mirrors the design doc. The lower bound exists because `--limit 0` means "no rows" to the CLI,
/// which would masquerade as the authoritative "this branch has no reviews" answer.
const DEFAULT_LIMIT: u32 = 50;
const MIN_LIMIT: u32 = 1;
const MAX_LIMIT: u32 = 200;

/// One review job, narrowed to what a merge gate reads. Mirrors `RoborevJobRow` in
/// `services/mergeGuard/types.ts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoborevJobRow {
    pub id: u64,
    pub branch: String,
    pub git_ref: String,
    pub status: String,
    pub verdict: Option<String>,
    pub closed: bool,
    pub commit_subject: Option<String>,
    pub finished_at: Option<String>,
}

/// What `roborev_branch_probe` answers. See the module header for why `enabled` and `jobs` are two
/// separate facts rather than one tri-state.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoborevProbe {
    pub enabled: bool,
    pub jobs: Option<Vec<RoborevJobRow>>,
    pub error: Option<String>,
}

impl RoborevProbe {
    /// roborev is not in play on this machine — the gate does not apply. NOT "clean".
    fn disabled() -> Self {
        Self { enabled: false, jobs: None, error: None }
    }

    /// roborev IS the gate and we could not read it. `error` carries the tool's own words so a human
    /// sees why, and is never parsed.
    fn unknown(error: String) -> Self {
        Self { enabled: true, jobs: None, error: Some(error) }
    }
}

/// The row as the CLI actually emits it. Every field but `id` is `#[serde(default)]` on purpose: the
/// CLI emits ~29 fields today and adds more over time, and a probe that fails to parse because
/// roborev grew a column would report UNKNOWN — i.e. block every merge — on a healthy machine.
/// Unknown fields are ignored by serde's default, which is the other half of the same tolerance.
#[derive(Debug, serde::Deserialize)]
struct RawRow {
    id: u64,
    /// PRESENT ONLY WHEN roborev RECORDED ONE. The CLI omits null fields entirely (Go `omitempty`),
    /// so this key is ABSENT — not `null` — for any job that died before its branch was written, and
    /// present for every job that has one. Both shapes arrive in the same response.
    ///
    /// `roborev list --branch X` returns X's rows PLUS every branchless row, even for a branch name
    /// that exists nowhere — so this field alone cannot rule a row out. When it is missing,
    /// attribution falls back to asking git about `git_ref` (see `ShaAttribution`); treating the
    /// absence itself as unknowable froze every merge in the repo.
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    git_ref: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    verdict: Option<String>,
    #[serde(default)]
    closed: bool,
    #[serde(default)]
    commit_subject: Option<String>,
    #[serde(default)]
    finished_at: Option<String>,
}

/// Clamp a caller's `limit` into a range the CLI answers meaningfully. See `MIN_LIMIT` for why the
/// floor is 1 rather than 0.
fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(MIN_LIMIT, MAX_LIMIT)
}

/// Project one CLI row down to what crosses the IPC boundary.
///
/// `verdict` is passed through UNTOUCHED, including `None`. A done-but-verdictless job is an unread
/// review, not a passing one; coercing `None` to a pass here would silently un-gate exactly the jobs
/// most worth gating on.
fn project_row(raw: RawRow, queried_branch: &str) -> RoborevJobRow {
    RoborevJobRow {
        id: raw.id,
        // The row's OWN branch when it has one. The fallback is now REACHED, and only for rows git
        // proved are on the branch under test (`ShaAttribution::OnBranch`) — so labelling them with
        // the queried branch states something verified, not something assumed. Rows we could not
        // attribute never get here: they are dropped or reported, never relabelled.
        branch: raw.branch.clone().unwrap_or_else(|| queried_branch.to_string()),
        git_ref: raw.git_ref.unwrap_or_default(),
        // A row with no status is not "done" and not in flight — say so in a word the consumer can
        // see, rather than an empty string that reads like a missing value.
        status: raw.status.unwrap_or_else(|| "unknown".to_string()),
        verdict: raw.verdict,
        closed: raw.closed,
        commit_subject: raw.commit_subject,
        finished_at: raw.finished_at,
    }
}

/// Parse `roborev list --json` output into projected rows. An `Err` here is the UNKNOWN state — the
/// caller must not turn it into an empty row list.
/// `attribute` answers "is this commit on the branch under test?" and is INJECTED so the parsing
/// rules can be tested without a git repo — the previous fixtures could not reach this decision at
/// all, which is how the repo-wide freeze shipped green.
fn parse_rows(
    stdout: &str,
    queried_branch: &str,
    attribute: &dyn Fn(&str) -> ShaAttribution,
) -> Result<Vec<RoborevJobRow>, String> {
    // An empty document is what the CLI prints when it dies before saying anything; treating it as
    // `[]` would invent an authoritative answer out of silence.
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("roborev list produced no output".to_string());
    }
    // `roborev list --json` prints the LITERAL `null` — not `[]` — when the result set is empty
    // (verified against the CLI: `roborev list --json --repo <a repo it knows nothing about>`).
    // That is an ANSWER of zero rows, and parsing it as a failure would put every branch with no
    // reviews into the unknown-and-blocking state — i.e. a fresh repo could never merge anything.
    if trimmed == "null" {
        return Ok(Vec::new());
    }
    let raws: Vec<RawRow> = serde_json::from_str(trimmed)
        .map_err(|e| format!("could not parse roborev list output: {e}"))?;

    let raw_count = raws.len();
    let (mine, foreign): (Vec<RawRow>, Vec<RawRow>) =
        raws.into_iter().partition(|r| belongs_to_branch(r, queried_branch));

    // A DISCARD MUST NOT BECOME AN AUTHORITATIVE EMPTY — but neither may an un-ASKED question become
    // a repo-wide refusal. A row whose `branch` is null is not unknowable; it carries a `git_ref`,
    // and git can say whether that commit is on the branch we were asked about. Ask, and the row
    // stops being a mystery: it is either ours (keep it, and let the ordinary buckets judge it) or
    // demonstrably not (drop it).
    //
    // WHY THIS REPLACED A BLANKET `Err`: this function used to treat every null-branch blocking row
    // as UNKNOWN for the branch under test. Because `roborev list --branch X` returns null-branch
    // rows for EVERY X — including branch names that exist nowhere — one such row made every merge
    // in the repository refuse, unwaivably (`roborev-unknown` takes no acknowledgement). On
    // 2026-08-05 six jobs died at agent startup on Claude quota exhaustion, before roborev could
    // record their branch. They produced no review output, so they had no row in roborev's `reviews`
    // table; `closed` lives on THAT table, so `roborev close` answered `404 review not found for
    // job` — the very remedy this error told the reader to run. `/api/job/cancel` refused them as
    // terminal, and `/api/job/rerun` refused them because their worktrees were gone. The result was
    // a gate that failed closed across the whole repo with no exit at all, and PRs were merged with
    // `gh` to route around it — which is the opposite of what a review gate is for.
    //
    // Attribution by SHA is strictly MORE precise than the branch column, not a weakening: a row is
    // now judged against the commits the branch actually contains.
    let mut kept = mine;
    let mut undecidable: Vec<u64> = Vec::new();
    for raw in foreign {
        // Rows whose branch is present and DIFFERENT are genuinely not ours; they never count here.
        if raw.branch.is_some() {
            continue;
        }
        let sha = raw.git_ref.as_deref().unwrap_or("").trim().to_string();
        match attribute(&sha) {
            // git says this branch contains the commit: it IS ours. Keeping it means the ordinary
            // buckets judge it — an in-flight row still blocks, a FAIL still blocks, and a crashed
            // row lands in `errored`, which IS waivable by acknowledgement. That is the exit the
            // old blanket `Err` did not have.
            ShaAttribution::OnBranch => kept.push(raw),
            // Not on this branch, or a commit git has never heard of (garbage-collected, or never
            // fetched into this clone). Either way it cannot be a finding about the code being
            // merged here, so it must not block this merge.
            ShaAttribution::NotOnBranch | ShaAttribution::ShaUnknown => {}
            // We could not ASK — git itself is unavailable or the row carries no ref. That is a
            // genuine "I could not find out", so it still fails closed, but only for rows that
            // would actually have blocked.
            ShaAttribution::Undecidable => {
                if would_block(&raw) {
                    undecidable.push(raw.id);
                }
            }
        }
    }
    if !undecidable.is_empty() {
        // NAME THE IDS, and name a remedy that WORKS. `roborev close <id>` is deliberately not
        // suggested first: it 404s on exactly the crashed, output-less rows that reach this path.
        let ids = undecidable.iter().map(u64::to_string).collect::<Vec<_>>().join(", ");
        return Err(format!(
            "roborev row(s) {ids} carry no branch, and git could not be consulted to attribute \
             their commits to {queried_branch} or rule them out — so each is still unresolved. \
             Re-attribute them with roborev's daemon API \
             (`POST /api/job/update-branch {{\"job_id\":<id>,\"branch\":\"<branch>\"}}`), which \
             works even on a crashed job; `roborev close <id>` only works once a job has review \
             output, and returns 404 for jobs that died before producing any."
        ));
    }
    // There is deliberately NO second check for "this build never recorded the branch column".
    //
    // It was tried and it was a no-op that caused a wedge. `--branch X` returns X's rows PLUS
    // null-branch rows and nothing else, so `foreign` can only ever contain null-branch rows and
    // any "did every foreign row lack a branch?" test is trivially true — while the state it fired
    // on (this branch kept nothing) is the ordinary state of a BRAND-NEW branch. The result was
    // that one legacy null-branch row made every fresh branch permanently unmergeable.
    //
    // It is also unnecessary. A column-less build is only dangerous if it hides something that
    // would BLOCK, and the check above already fails closed on exactly that. If every
    // unattributable row is closed or passing, then "no blocking reviews are attributable to this
    // branch" is a true statement about the whole repo, and reporting it is honest rather than
    // optimistic.
    Ok(kept.into_iter().map(|r| project_row(r, queried_branch)).collect())
}

/// What git can tell us about a row's commit, relative to the branch under test.
///
/// Four answers, not three: "git says no" and "git could not be asked" are different facts, and
/// collapsing them is what turned a missing branch column into a repo-wide merge freeze.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShaAttribution {
    /// The branch under test contains this commit — the row is about the code being merged.
    OnBranch,
    /// The branch does not contain it. Some other branch's row.
    NotOnBranch,
    /// git ran and has never heard of this commit (garbage-collected, or never fetched here). It
    /// cannot be a finding about this branch, so it does not block.
    ShaUnknown,
    /// We could not ask at all — no ref on the row, or git is unavailable. Fails closed.
    Undecidable,
}

/// Ask git whether `branch` contains `sha`. The production resolver behind `parse_rows`'s injected
/// `attribute` closure; tests supply their own so the parsing logic stays pure.
///
/// Ancestry is asked with `merge-base --is-ancestor`, whose exit status is the answer: 0 contains,
/// 1 does not. Any other status is a failure to ask, NOT a "no" — which is why existence is probed
/// separately first, so a genuinely unknown commit is reported as such instead of masquerading as a
/// broken git.
fn attribute_sha(root: &str, branch: &str, sha: &str) -> ShaAttribution {
    if sha.is_empty() {
        return ShaAttribution::Undecidable;
    }
    // Does this clone know the commit at all?
    let mut exists = Command::new("git");
    exists.args(["cat-file", "-e", &format!("{sha}^{{commit}}")]).current_dir(root);
    apply_noninteractive(&mut exists);
    match crate::worktree::output_with_timeout(exists, PROBE_TIMEOUT) {
        Ok(o) if o.status.success() => {}
        // git ran and said "no such object" — a real answer.
        Ok(_) => return ShaAttribution::ShaUnknown,
        // git could not be run at all.
        Err(_) => return ShaAttribution::Undecidable,
    }
    // The branch ref has to be resolvable before ancestry means anything. A PR head branch may only
    // exist as a remote-tracking ref in this clone, so try that spelling too before giving up.
    let branch_ref = ["", "origin/"].iter().find_map(|prefix| {
        let candidate = format!("{prefix}{branch}");
        let mut probe = Command::new("git");
        probe.args(["rev-parse", "--verify", "--quiet", &format!("{candidate}^{{commit}}")])
            .current_dir(root);
        apply_noninteractive(&mut probe);
        match crate::worktree::output_with_timeout(probe, PROBE_TIMEOUT) {
            Ok(o) if o.status.success() => Some(candidate),
            _ => None,
        }
    });
    let Some(branch_ref) = branch_ref else {
        // We know the commit but cannot resolve the branch, so we cannot decide. Fail closed.
        return ShaAttribution::Undecidable;
    };
    let mut anc = Command::new("git");
    anc.args(["merge-base", "--is-ancestor", sha, &branch_ref]).current_dir(root);
    apply_noninteractive(&mut anc);
    match crate::worktree::output_with_timeout(anc, PROBE_TIMEOUT) {
        Ok(o) if o.status.success() => ShaAttribution::OnBranch,
        // Exit 1 is git's definitive "not an ancestor". Anything else is a failure to ask.
        Ok(o) if o.status.code() == Some(1) => ShaAttribution::NotOnBranch,
        _ => ShaAttribution::Undecidable,
    }
}

/// Would this row block a merge if it DID belong to the branch? Used only to decide whether an
/// unattributable row is safe to drop: a closed row, or one carrying a clean pass, is not.
fn would_block(raw: &RawRow) -> bool {
    if raw.closed {
        return false;
    }
    let status = raw.status.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    match status.as_str() {
        "queued" | "running" => true,
        // Mirrors the TS summarizer: only a legible PASS is non-blocking.
        "done" => !matches!(raw.verdict.as_deref().map(str::trim), Some("P") | Some("p")),
        _ => true,
    }
}

/// The exact `roborev list` argv. PURE so the flags — and the CANONICALIZED root — are assertable:
/// the canonicalization used to happen inline in the command, where no test could observe it, so a
/// mutation that handed the CLI a tolerated spelling (`/repo/`, which `--repo` does not match)
/// stayed green while the probe silently answered for the wrong repo.
///
/// `--open` is load-bearing, not tidiness: closed rows are discarded downstream anyway, so without
/// it every auto-closed PASS burns a slot in a fixed-size window and the row that falls off the end
/// is the oldest — an old, still-open FAIL. That fails the gate OPEN.
fn list_argv(root: &str, branch: &str, limit: u32) -> Vec<String> {
    [
        "list",
        "--json",
        "--open",
        "--repo",
        &canonical_root(root),
        "--branch",
        branch,
        "--limit",
        &limit.to_string(),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect()
}

/// Turn the CLI's stdout into a probe answer. PURE, and extracted for exactly one reason: the
/// saturation decision used to live inside the async command, where no unit test could reach it —
/// a mutation that treated a full window as authoritative stayed GREEN, which is the vacuous-test
/// failure this repo tracks as its #1 finding. The command is now a shell around this.
fn probe_from_stdout(
    stdout: &str,
    branch: &str,
    limit: u32,
    attribute: &dyn Fn(&str) -> ShaAttribution,
) -> RoborevProbe {
    match parse_rows(stdout, branch, attribute) {
        // A SATURATED window is not an authoritative answer. The CLI returns the newest N rows with
        // no truncation signal, so at the cap we cannot know whether an older open FAIL fell off the
        // end — and reporting the window as the whole truth is precisely how a gate merges over
        // unresolved findings. A cap that lies by omission is worse than no cap.
        //
        // The RAW count is what is reported, not the post-filter one: interpolating the filtered
        // count made the common case read "0 row(s) returned … the window is full". And the remedy
        // names only what the caller can actually DO — no tool on this surface exposes a limit.
        Ok(_) if window_saturated(stdout, limit) => RoborevProbe::unknown(format!(
            // The remedy must RAISE THE WINDOW, which is the actual problem here — and it must not
            // prescribe the bare `roborev list --open --branch` form, which exits 0 while printing
            // a connection banner, so its emptiness cannot be told from "reviewed, nothing found".
            // A reader sent to re-look with that form can come back with nothing and conclude the
            // branch is clear, which is the same lie this saturated-window verdict refuses to tell.
            // `--json` plus an explicit --limit gives both a bigger window and a readable answer.
            "roborev filled its {limit}-row window for {branch} ({} row(s) returned), so an older \
             unresolved finding may have fallen off the end and this reading cannot be treated as \
             complete. Read the branch with a bigger window: `roborev list --open --json --branch \
             {branch} --limit 500` — an empty or non-array answer there means COULD NOT ASK, not \
             \"no findings\".",
            raw_row_count(stdout)
        )),
        Ok(jobs) => RoborevProbe { enabled: true, jobs: Some(jobs), error: None },
        Err(e) => RoborevProbe::unknown(e),
    }
}

/// Did the CLI return as many rows as we asked for? Judged on the RAW output, before our branch
/// filter — the window was chosen before we filtered, so a full window that filters down to two
/// rows still may have dropped an older finding.
fn window_saturated(stdout: &str, limit: u32) -> bool {
    raw_row_count(stdout) >= limit as usize
}

/// One canonical spelling for a repo path. Mirrors `canonical_root` in `pr_claims.rs` and
/// `normalizeRoot` in the TS workflow layer — three copies because each sits at a different
/// boundary, and the CLI at the far end of this one is the least forgiving of the three.
fn canonical_root(root: &str) -> String {
    root.trim().trim_end_matches(['/', '\\']).to_string()
}

/// How many rows the CLI actually returned, BEFORE our own branch filter.
///
/// Saturation has to be judged on the CLI's output, not on what survives `belongs_to_branch`:
/// filtering happens after the window was already chosen, so a full window that filters down to
/// two rows is still a window that may have dropped an older finding.
fn raw_row_count(stdout: &str) -> usize {
    let trimmed = stdout.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return 0;
    }
    serde_json::from_str::<Vec<serde_json::Value>>(trimmed)
        .map(|v| v.len())
        .unwrap_or(0)
}

/// Does this row actually belong to the branch we asked about?
///
/// `roborev list --branch X` is NOT a clean filter: alongside X's rows it also returns rows whose
/// `branch` is null (jobs whose branch was never recorded), and it returns them even for a branch
/// name that exists nowhere. Those rows belong to no branch in particular, so counting them against
/// the PR under test would let an unrelated open FAIL block a merge — the gate refusing for a
/// reason that has nothing to do with the code being merged. Re-filter on our side rather than
/// trusting the flag.
fn belongs_to_branch(raw: &RawRow, queried_branch: &str) -> bool {
    match raw.branch.as_deref() {
        Some(b) => b == queried_branch,
        None => false,
    }
}

/// Pull the review markdown out of `roborev show --json`. `None` whenever we cannot get a non-empty
/// body — "there is nothing to show you" and "I could not read it" are the same thing to the caller
/// here, because neither can be summarised into findings.
fn extract_review_output(stdout: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let output = value.get("output")?.as_str()?;
    if output.trim().is_empty() {
        None
    } else {
        Some(output.to_string())
    }
}

/// Keep the roborev CLI from ever blocking on a prompt. Mirrors the same helper in `worktree.rs` /
/// `github.rs` (each module carries its own copy by house precedent): the CLI shells out to git for
/// diffs, so the git prompt vars are the ones that matter.
fn apply_noninteractive(cmd: &mut Command) {
    // One shared definition — see `claude_oneshot::apply_noninteractive` for why eight per-module
    // copies of this env setup were consolidated into it.
    crate::claude_oneshot::apply_noninteractive(cmd);
}

/// Whether roborev is the gate on this machine, and where its binary is. `None` means the gate does
/// not apply — either the binary is absent or the user turned `[tools].roborev` off.
fn resolve_enabled_binary(root: &str) -> Option<String> {
    let path = crate::preflight::cached_roborev_path()?;
    if !crate::config::for_project(root).config.tools.roborev {
        return None;
    }
    Some(path)
}

/// Read roborev's jobs for one branch. Never `Err`s for a roborev-side failure — see the module
/// header; an `Err` here is reserved for a malformed request, which is a programmer error rather
/// than a state the gate has to reason about.
#[tauri::command]
pub async fn roborev_branch_probe(
    root: String,
    branch: String,
    limit: Option<u32>,
) -> Result<RoborevProbe, String> {
    if root.trim().is_empty() {
        return Err("roborev_branch_probe requires a project root".to_string());
    }
    if branch.trim().is_empty() {
        return Err("roborev_branch_probe requires a branch".to_string());
    }
    // spawn_blocking: this shells out, and the UI thread awaits the invoke.
    tauri::async_runtime::spawn_blocking(move || {
        let Some(program) = resolve_enabled_binary(&root) else {
            return Ok(RoborevProbe::disabled());
        };
        // Canonicalize before the CLI sees it. `--repo` and `current_dir` both want the real repo
        // path; a trailing separator is tolerated by every check upstream and matched by neither
        // here, which made the probe answer for the wrong (empty) repo and report the branch clean.
        let root = canonical_root(&root);
        let limit = clamp_limit(limit);
        let mut cmd = Command::new(program);
        cmd.args(list_argv(&root, &branch, limit))
            .current_dir(&root);
        apply_noninteractive(&mut cmd);

        let output = match crate::worktree::output_with_timeout(cmd, PROBE_TIMEOUT) {
            Ok(o) => o,
            Err(e) => return Ok(RoborevProbe::unknown(format!("roborev list failed: {e}"))),
        };
        if !output.status.success() {
            // The tool's own words, stderr first — this is shown, never parsed.
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let msg = if stderr.is_empty() {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            } else {
                stderr
            };
            return Ok(RoborevProbe::unknown(format!("roborev list exited non-zero: {msg}")));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let attribute = |sha: &str| attribute_sha(&root, &branch, sha);
        Ok(probe_from_stdout(&stdout, &branch, limit, &attribute))
    })
    .await
    .map_err(|e| format!("roborev_branch_probe task failed: {e}"))?
}

/// The review markdown for one job, or `None` when it cannot be read. Best-effort by design: the
/// gate already made its decision from the job rows; this only enriches it with findings, so a
/// failure to read one review must degrade to "no findings parsed" rather than fail the caller.
#[tauri::command]
pub async fn roborev_job_review(root: String, job_id: u64) -> Result<Option<String>, String> {
    if root.trim().is_empty() {
        return Err("roborev_job_review requires a project root".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(program) = resolve_enabled_binary(&root) else {
            return Ok(None);
        };
        let mut cmd = Command::new(program);
        cmd.args(["show", "--job", &job_id.to_string(), "--json"]).current_dir(&root);
        apply_noninteractive(&mut cmd);
        let Ok(output) = crate::worktree::output_with_timeout(cmd, PROBE_TIMEOUT) else {
            return Ok(None);
        };
        if !output.status.success() {
            return Ok(None);
        }
        Ok(extract_review_output(&String::from_utf8_lossy(&output.stdout)))
    })
    .await
    .map_err(|e| format!("roborev_job_review task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row shaped like the real CLI's, including fields we do not read.
    fn cli_row(extra: &str) -> String {
        format!(
            r#"[{{"id":53382,"repo_id":12,"git_ref":"dc52c3b","status":"done","branch":"sparkle/left-pair",
                  "commit_subject":"a subject","closed":true,"verdict":"P"{extra}}}]"#
        )
    }

    // Stand-ins for the four answers git can give. Injecting these is the whole point: before this,
    // no fixture could reach the attribution decision, so the repo-wide freeze shipped green.
    fn on_branch(_sha: &str) -> ShaAttribution {
        ShaAttribution::OnBranch
    }
    fn not_on_branch(_sha: &str) -> ShaAttribution {
        ShaAttribution::NotOnBranch
    }
    fn sha_unknown(_sha: &str) -> ShaAttribution {
        ShaAttribution::ShaUnknown
    }
    fn undecidable(_sha: &str) -> ShaAttribution {
        ShaAttribution::Undecidable
    }

    /// THE REAL CLI SHAPE. roborev is Go and omits null fields, so a job that died before recording
    /// a branch emits NO `branch` key at all — and no `closed`, and no `verdict`. Every fixture in
    /// this module used to include `branch`, which is exactly why the freeze below shipped green.
    /// Both shapes arrive in one response, so the fixture carries one of each.
    const REAL_CLI_MIXED: &str = r#"[
        {"id":59204,"repo_id":12,"git_ref":"13de4544","status":"failed","commit_subject":"a subject",
         "error":"agent: claude-code failed\nstream errors: You've hit your monthly spend limit"},
        {"id":62759,"repo_id":12,"git_ref":"fd0a363","status":"done","branch":"someone-else",
         "closed":false,"verdict":"P"}
    ]"#;

    /// THE REGRESSION. On 2026-08-05 six jobs died at agent startup on quota exhaustion before their
    /// branch was recorded. `roborev list --branch X` returns branchless rows for EVERY X, so those
    /// six made every merge in the repository refuse with `roborev-unknown` — which takes no
    /// acknowledgement — while the remedy the refusal named (`roborev close <id>`) returned 404,
    /// because `closed` lives on the `reviews` table and a crashed job has no row there.
    ///
    /// Asking git instead: the commit is not on this branch, so the row cannot be a finding about
    /// the code being merged, and the branch reads CLEAN.
    #[test]
    fn a_branchless_failed_row_does_not_make_an_unrelated_branch_unreadable() {
        let rows = parse_rows(REAL_CLI_MIXED, "sparkle/some-other-agent", &not_on_branch)
            .expect("a branchless row git can rule out must NOT make the branch unknowable");
        assert_eq!(rows, vec![], "nothing on this branch, and that is an ANSWER — not unknown");
    }

    /// The PAIRED half, which is what makes the test above mean anything: the same fixture, the same
    /// crashed row, and the only thing that changed is git's answer. Proving absence alone is
    /// ambiguous — this pins that attribution, not leniency, is doing the work.
    #[test]
    fn the_same_branchless_row_is_kept_when_git_says_the_commit_is_on_this_branch() {
        let rows = parse_rows(REAL_CLI_MIXED, "sparkle/owns-it", &on_branch)
            .expect("an attributable row is an answer, not an unknown");
        assert_eq!(rows.len(), 1, "the branchless row is now attributed to this branch");
        assert_eq!(rows[0].id, 59204);
        assert_eq!(rows[0].status, "failed");
        assert_eq!(
            rows[0].branch, "sparkle/owns-it",
            "labelled with the branch git PROVED contains it"
        );
        // And it reaches the caller as a row rather than an unknowable — `failed` lands in the TS
        // summarizer's `errored` bucket, which acknowledgement CAN clear. That is the exit the old
        // blanket refusal did not have.
        assert!(!rows[0].closed, "a crashed job is not closed — it has no review row to close");
    }

    /// A commit this clone has never heard of (garbage-collected, or never fetched) cannot be a
    /// finding about this branch, so it must not block it.
    #[test]
    fn a_commit_git_has_never_heard_of_does_not_block() {
        let rows = parse_rows(REAL_CLI_MIXED, "mine", &sha_unknown)
            .expect("an unknown SHA is ruled out, not fatal");
        assert_eq!(rows, vec![]);
    }

    /// But a failure to ASK is still unknown, and still fails closed. This is the one direction a
    /// merge gate must never get wrong, and the fix must not have widened it into a pass.
    #[test]
    fn git_being_unavailable_still_fails_closed_and_names_a_remedy_that_works() {
        let err = parse_rows(REAL_CLI_MIXED, "mine", &undecidable)
            .expect_err("if git cannot be consulted, a blocking branchless row is UNKNOWN");
        assert!(err.contains("59204"), "the refusal must name the row: {err}");
        // The remedy has to be one that actually succeeds on a crashed, output-less job. It does
        // not: `roborev close` 404s on exactly these rows, so the copy must not offer it as THE fix.
        assert!(
            err.contains("update-branch"),
            "must name the daemon call that works on a crashed job: {err}"
        );
        assert!(
            err.contains("404"),
            "and must say why `roborev close` is not the answer here: {err}"
        );
    }

    /// A branchless row that would NOT have blocked stays harmless under every git answer — the fix
    /// must not have made previously-clean branches noisy.
    #[test]
    fn a_harmless_branchless_row_is_clean_however_git_answers() {
        let json = r#"[{"id":2,"status":"done","verdict":"P","closed":false}]"#;
        for resolver in [
            &on_branch as &dyn Fn(&str) -> ShaAttribution,
            &not_on_branch,
            &sha_unknown,
            &undecidable,
        ] {
            let rows = parse_rows(json, "mine", resolver).expect("a passing row is never unknown");
            // On-branch keeps it (as a passing row); every other answer drops it. Neither blocks.
            assert!(rows.len() <= 1);
            assert!(rows.iter().all(|r| r.verdict.as_deref() == Some("P")));
        }
    }

    #[test]
    fn projection_keeps_the_fields_a_gate_reads() {
        let rows = parse_rows(&cli_row(""), "sparkle/left-pair", &undecidable).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.id, 53382);
        assert_eq!(row.git_ref, "dc52c3b");
        assert_eq!(row.status, "done");
        assert_eq!(row.verdict.as_deref(), Some("P"));
        assert!(row.closed);
        assert_eq!(row.commit_subject.as_deref(), Some("a subject"));
        assert_eq!(row.branch, "sparkle/left-pair");
    }

    /// THE regression this module exists to prevent: a missing verdict must arrive as `None`, never
    /// as a pass. A running job and an errored job both have no verdict, and both must block.
    #[test]
    fn a_null_verdict_stays_null_and_is_never_coerced_to_a_pass() {
        let json = r#"[{"id":1,"status":"running","verdict":null,"closed":false,"branch":"b"},
                       {"id":2,"status":"done","closed":false,"branch":"b"}]"#;
        let rows = parse_rows(json, "b", &undecidable).unwrap();
        assert_eq!(rows[0].verdict, None, "an explicit null verdict must stay null");
        assert_eq!(rows[1].verdict, None, "an absent verdict must stay null");
        assert!(rows.iter().all(|r| r.verdict.as_deref() != Some("P")));
    }

    /// roborev grows columns. A new one must not turn a healthy machine into a blocked one.
    #[test]
    fn an_unknown_extra_field_parses_fine() {
        let rows = parse_rows(
            &cli_row(r#","some_field_invented_next_month":{"a":[1,2]}"#),
            "sparkle/left-pair",
            &undecidable,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, 53382);
    }

    /// The row the CLI really emits carries a multi-kilobyte `prompt`. It must not survive the
    /// projection — a concierge's context is the thing being protected.
    #[test]
    fn the_review_prompt_never_crosses_the_boundary() {
        let bulk = "x".repeat(4096);
        let json = format!(
            r#"[{{"id":7,"status":"done","verdict":"F","branch":"b","prompt":"{bulk}"}}]"#
        );
        let rows = parse_rows(&json, "b", &undecidable).unwrap();
        let serialized = serde_json::to_string(&rows[0]).unwrap();
        assert!(!serialized.contains(&bulk), "the raw prompt must be dropped in projection");
        assert!(serialized.len() < 512);
    }

    /// Malformed output is UNKNOWN, and unknown must be distinguishable from "no reviews". This is
    /// the conflation that let #806 through.
    #[test]
    fn malformed_json_is_unknown_not_an_empty_answer() {
        assert!(parse_rows("{not json", "b", &undecidable).is_err());
        assert!(parse_rows("", "b", &undecidable).is_err(), "silence is not an authoritative empty answer");
        assert!(parse_rows("   \n", "b", &undecidable).is_err());
        // And the real empty answers still parse as answers.
        assert_eq!(parse_rows("[]", "b", &undecidable).unwrap(), vec![]);
    }

    /// `roborev list --json` prints the LITERAL `null` for an empty result set, not `[]`. Parsing
    /// that as a failure would put every branch with no reviews into unknown-and-blocking — a fresh
    /// repo could never merge anything. Verified against the real CLI.
    #[test]
    fn a_bare_null_document_is_zero_rows_not_a_parse_failure() {
        assert_eq!(parse_rows("null", "b", &undecidable).unwrap(), vec![]);
        assert_eq!(parse_rows("  null\n", "b", &undecidable).unwrap(), vec![]);
    }

    /// `--branch X` leaks rows that belong to no branch (their `branch` is null), and returns them
    /// even for a name that exists nowhere. Counting those against the PR under test would let an
    /// unrelated open FAIL block a merge for a reason that has nothing to do with the code.
    #[test]
    fn rows_from_another_branch_are_dropped_and_harmless_unattributable_ones_too() {
        let json = r#"[{"id":1,"status":"done","verdict":"F","closed":false,"branch":"mine"},
                       {"id":2,"status":"done","verdict":"P","closed":false,"branch":null},
                       {"id":3,"status":"done","verdict":"F","closed":false,"branch":"someone-else"},
                       {"id":4,"status":"done","verdict":"F","closed":true}]"#;
        let rows = parse_rows(json, "mine", &undecidable).unwrap();
        assert_eq!(rows.len(), 1, "only the row actually on `mine` survives");
        assert_eq!(rows[0].id, 1);
    }

    /// A dropped row must never become a clean answer. An unattributable row that WOULD have
    /// blocked makes the branch's state unknowable — under-blocking is the one direction a merge
    /// gate must never fail.
    #[test]
    fn an_unattributable_row_that_would_block_makes_the_answer_unknown() {
        for row in [
            r#"{"id":9,"status":"running","verdict":null,"closed":false,"branch":null}"#,
            r#"{"id":9,"status":"done","verdict":"F","closed":false,"branch":null}"#,
            r#"{"id":9,"status":"failed","verdict":null,"closed":false,"branch":null}"#,
            r#"{"id":9,"status":"done","verdict":null,"closed":false}"#,
        ] {
            let json =
                format!(r#"[{{"id":1,"status":"done","verdict":"P","closed":false,"branch":"mine"}},{row}]"#);
            let err = parse_rows(&json, "mine", &undecidable).expect_err(
                "an unattributable blocking row must be UNKNOWN, not silently dropped",
            );
            // The id, so `roborev close <id>` is a one-step remedy rather than a hunt.
            assert!(err.contains("9"), "the refusal must name the row: {err}");
            assert!(err.contains("roborev close"), "and the remedy: {err}");
        }
    }

    /// A FRESH branch has no reviews of its own, and the store almost always holds some legacy
    /// null-branch row. This is the SHAPE THE CLI ACTUALLY RETURNS for such a query — only
    /// null-branch rows, no foreign-branch row, nothing closed (the probe passes `--open`) — which
    /// the previous fixture got wrong, and which made the guard it "proved" a no-op.
    #[test]
    fn a_fresh_branch_beside_a_harmless_legacy_row_is_a_clean_empty_answer() {
        let json = r#"[{"id":2,"status":"done","verdict":"P","closed":false}]"#;
        assert_eq!(
            parse_rows(json, "mine", &undecidable).unwrap(),
            vec![],
            "a new branch alongside a non-blocking unattributable row is CLEAN, not unknown"
        );
        // Explicit JSON null, the other spelling of the same thing.
        let explicit = r#"[{"id":2,"status":"done","verdict":"P","closed":false,"branch":null}]"#;
        assert_eq!(parse_rows(explicit, "mine", &undecidable).unwrap(), vec![]);
    }

    /// The dangerous half of a column-less build is still caught: an unattributable row that WOULD
    /// block fails closed, whatever the rest of the result set looks like.
    #[test]
    fn a_column_less_build_still_fails_closed_on_anything_that_would_block() {
        let json = r#"[{"id":1,"status":"done","verdict":"P","closed":false},
                       {"id":2,"status":"running","verdict":null,"closed":false}]"#;
        let err = parse_rows(json, "mine", &undecidable).expect_err("a blocking unattributable row is UNKNOWN");
        assert!(err.contains("2"), "naming the row: {err}");
    }

    /// The argv the CLI actually receives — including the canonical root, which `--repo` will not
    /// match if a trailing separator survives, and `--open`, without which the window truncates on
    /// closed passes and drops the oldest open FAIL. (Restored: deleting the inert branch-column
    /// guard took this with it, and it never had anything to do with that guard.)
    #[test]
    fn the_cli_argv_carries_a_canonical_root_and_the_open_filter() {
        let argv = list_argv("/Users/x/Projects/sparkle/", "sparkle/left-pair", 50);
        assert!(argv.contains(&"--open".to_string()), "closed rows must not eat the window: {argv:?}");
        let repo = argv.iter().position(|a| a == "--repo").expect("--repo") + 1;
        assert_eq!(
            argv[repo], "/Users/x/Projects/sparkle",
            "the trailing separator must be gone — the CLI does not match it"
        );
        let branch = argv.iter().position(|a| a == "--branch").expect("--branch") + 1;
        assert_eq!(argv[branch], "sparkle/left-pair");
        let lim = argv.iter().position(|a| a == "--limit").expect("--limit") + 1;
        assert_eq!(argv[lim], "50");
        let padded = list_argv("  /Users/x/Projects/sparkle  ", "b", 1);
        assert_eq!(
            padded[padded.iter().position(|a| a == "--repo").unwrap() + 1],
            "/Users/x/Projects/sparkle"
        );
    }

    /// `raw_row_count`'s direct cases. Saturation is judged on this, and an empty/`null` document
    /// counting as anything but zero would make every quiet branch look truncated.
    #[test]
    fn raw_row_count_reads_the_cli_forms_it_will_actually_see() {
        assert_eq!(raw_row_count("null"), 0);
        assert_eq!(raw_row_count(""), 0);
        assert_eq!(raw_row_count("   \n "), 0);
        assert_eq!(raw_row_count("[]"), 0);
        assert_eq!(raw_row_count(r#"[{"id":1}]"#), 1);
        assert_eq!(raw_row_count("{not json"), 0);
    }

    /// The saturation decision, now reachable. Previously it lived inside the async command and no
    /// test could touch it: a mutation that treated a full window as authoritative stayed green.
    #[test]
    fn a_full_window_is_unknown_and_a_short_one_is_authoritative() {
        let full: Vec<String> = (0..50)
            .map(|i| format!(r#"{{"id":{i},"status":"done","verdict":"P","branch":"mine"}}"#))
            .collect();
        let saturated = format!("[{}]", full.join(","));
        let p = probe_from_stdout(&saturated, "mine", 50, &undecidable);
        assert!(p.enabled);
        assert!(p.jobs.is_none(), "a saturated window must NOT be an authoritative answer");
        let err = p.error.expect("and it must say why");
        assert!(err.contains("50-row window"), "naming the window: {err}");
        assert!(err.contains("50 row(s) returned"), "with the RAW count, not the filtered one: {err}");
        // A RUNNABLE remedy, and specifically one that RAISES the window — the saturated window is
        // the whole complaint, so a remedy that re-reads at the same size answers nothing.
        assert!(err.contains("--branch mine"), "and a runnable remedy naming the branch: {err}");
        assert!(err.contains("--limit"), "that raises the window rather than re-reading it: {err}");
        // NEGATIVE HALF, and it is the load-bearing one. The previous assertion pinned the exact
        // string `roborev list --open --branch mine`, which is the form banned for exiting 0 while
        // printing a connection banner — so the test REQUIRED the defect and would have failed on
        // the fix. Pinning a bad string in place is how the same class survived in the orchestrator
        // persona until it was found by review. This bans the bare form while leaving the `--json`
        // one (a superstring of it under a naive check) reachable, so the two cannot be conflated.
        assert!(
            !err.contains("roborev list --open --branch"),
            "must not prescribe the bare list form, which cannot distinguish an outage from a clean branch: {err}"
        );

        // One row short of the cap is a real answer.
        let short = format!("[{}]", full[..49].join(","));
        let ok = probe_from_stdout(&short, "mine", 50, &undecidable);
        assert_eq!(ok.jobs.expect("authoritative").len(), 49);
        assert!(ok.error.is_none());
    }

    /// The saturation message must report what the CLI RETURNED, even when our branch filter keeps
    /// nothing — otherwise it reads "0 row(s) returned … the window is full".
    #[test]
    fn a_full_window_of_other_branches_still_reports_the_raw_count() {
        let rows: Vec<String> = (0..50)
            .map(|i| format!(r#"{{"id":{i},"status":"done","verdict":"P","branch":"theirs"}}"#))
            .collect();
        let p = probe_from_stdout(&format!("[{}]", rows.join(",")), "mine", 50, &undecidable);
        assert!(p.jobs.is_none());
        assert!(p.error.unwrap().contains("50 row(s) returned"));
    }

    /// An empty answer and a parse failure must still come through the extracted path unchanged.
    #[test]
    fn probe_from_stdout_preserves_the_empty_and_unknown_states() {
        let empty = probe_from_stdout("null", "mine", 50, &undecidable);
        assert_eq!(empty.jobs.expect("null is an ANSWER of zero rows"), vec![]);
        let broken = probe_from_stdout("{not json", "mine", 50, &undecidable);
        assert!(broken.enabled && broken.jobs.is_none(), "unparseable is unknown, not empty");
    }

    /// The three probe states must be tellable apart by a consumer reading only the struct.
    #[test]
    fn the_three_probe_states_are_distinguishable() {
        let disabled = RoborevProbe::disabled();
        let unknown = RoborevProbe::unknown("daemon down".to_string());
        let answered = RoborevProbe { enabled: true, jobs: Some(vec![]), error: None };
        assert!(!disabled.enabled && disabled.jobs.is_none());
        assert!(unknown.enabled && unknown.jobs.is_none());
        assert!(answered.enabled && answered.jobs.as_ref().unwrap().is_empty());
        assert_ne!(disabled.enabled, unknown.enabled, "'not the gate' != 'could not read it'");
        assert_ne!(unknown.jobs, answered.jobs, "'could not read it' != 'no reviews'");
    }

    #[test]
    fn limit_is_clamped_into_a_range_the_cli_answers_meaningfully() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), MIN_LIMIT, "0 would look like 'no reviews'");
        assert_eq!(clamp_limit(Some(1)), 1);
        assert_eq!(clamp_limit(Some(50)), 50);
        assert_eq!(clamp_limit(Some(200)), 200);
        assert_eq!(clamp_limit(Some(10_000)), MAX_LIMIT);
    }

    #[test]
    fn review_output_is_extracted_and_emptiness_reads_as_unreadable() {
        // r###…### and not r#…#: the body contains `"##` (the markdown heading right after the
        // opening quote of `output`), which IS the `r#` terminator, so the shorter form ends the
        // literal mid-JSON.
        let json = r###"{"id":1,"job_id":1,"output":"## Review Findings\n- **Severity**: High"}"###;
        assert_eq!(
            extract_review_output(json).as_deref(),
            Some("## Review Findings\n- **Severity**: High")
        );
        assert_eq!(extract_review_output(r#"{"id":1,"output":""}"#), None);
        assert_eq!(extract_review_output(r#"{"id":1,"output":null}"#), None);
        assert_eq!(extract_review_output(r#"{"id":1}"#), None);
        assert_eq!(extract_review_output("not json"), None);
    }
}

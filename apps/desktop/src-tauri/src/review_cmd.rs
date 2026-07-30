// apps/desktop/src-tauri/src/review_cmd.rs
//
// THE ROBOREV READ/RESOLVE SURFACE — the commands behind the concierge's `review` domain.
//
// WHY A NEW MODULE AND NOT MORE OF `setup.rs`. setup.rs owns roborev's INSTALL lifecycle: download
// the binary, load the LaunchAgent, wire a repo's git hooks, tear all three down. Everything there
// is about whether roborev EXISTS. Nothing there reads a single finding, which is why the concierge
// could tell you roborev was installed and not one thing it had found. This module is the other
// half — the daemon's review QUEUE — and it keeps setup.rs's binary resolution
// (`preflight::cached_roborev_path`) rather than re-deriving it.
//
// ROBOREV IS A CLIENT/SERVER TOOL, AND THAT SHAPES EVERY ERROR HERE. The `roborev` binary is a thin
// CLI over a local daemon; with the daemon stopped, EVERY read fails with one message
// ("failed to connect to daemon") no matter how healthy the install is. So "roborev is installed"
// and "roborev can answer" are different facts, and a surface that collapses them would tell the
// human their repo has no findings when what actually happened is that a background process is
// down. Each is its own tag below.
//
// THE FOUR OUTCOMES A CALLER MUST BE ABLE TO TELL APART, and none of them is a bug:
//
//   `roborev-missing`      — the binary isn't installed. roborev is OPTIONAL (a user can run
//                            Sparkle without it), so this is a supported state, not a failure.
//   `roborev-daemon-down`  — installed, but the daemon isn't running. Fixable in one command.
//   `roborev-unregistered` — the daemon is up and has never heard of THIS repo. Distinct from
//                            "registered with zero open findings", which is a successful read.
//   `roborev-timeout`      — the CLI wedged. Bounded rather than hung; see ROBOREV_TIMEOUT.
//
// They travel as an `Err(String)` whose FIRST TOKEN is the tag (`"roborev-daemon-down: …"`), which
// is the same convention `worktree.rs`'s diff commands use for `missing-head:` / `missing-base:`.
// The frontend classifies on the prefix rather than regexing English — see conciergeTools/review.ts.
//
// THIS MODULE DOES NOT PARSE roborev's JSON. `roborev list --json` is handed back as a raw string,
// exactly as `notes.rs` does for `bd`, and the normalizing lives in TypeScript where it is cheap to
// unit-test against the shapes a version bump can produce. What Rust owns is what only Rust can:
// binary resolution, argument validation, the timeout, and the comment-then-close ORDERING.

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::preflight;

/// How long any single roborev invocation may run before it is killed and reported as a timeout.
///
/// Generous because the daemon can be slow to answer a cold query over a large review database
/// (this repo's is ~400 MB), but finite: a wedged CLI must surface as a typed error rather than
/// hanging the concierge's turn, which sits behind a bridge round-trip with a human on the far end.
const ROBOREV_TIMEOUT: Duration = Duration::from_secs(30);

/// Rows requested when the caller names no limit. Findings land in an LLM context window and are
/// never evicted from it, so the default is a readable page rather than the CLI's own 50.
const DEFAULT_LIMIT: usize = 25;

/// Hard ceiling, applied even when the caller asks for more.
///
/// THERE IS NO PAGING, and this comment used to say there was (roborev 55466): it read "a caller
/// that wants the whole backlog pages for it", but `roborev_list_findings` sends `--limit` and no
/// offset, so a full page is a hard stop. Now that the ceiling equals `DEFAULT_LIMIT`, `limit` is a
/// lower-only knob — it can ask for fewer rows, never more. Two things make that acceptable rather
/// than a dead end, and neither is an offset:
///
///   • The query is always `--branch`-scoped (see `roborev_list_findings`), so a page is one
///     branch's open findings, not the machine-wide backlog. 25 is generous per branch.
///   • Draining IS the continuation. Findings leave `--open` as they are fixed or closed, so the
///     next call surfaces what the last one could not reach — which is the order an agent works in
///     anyway. `capped: true` means "there is more on THIS branch", and the way forward is to deal
///     with what you were handed and read again.
///
/// Raising the ceiling to buy a few more rows was the alternative (the arithmetic below admits 29),
/// and it is rejected on purpose: it would spend the headroom that keeps a row above the observed
/// peak from turning into an opaque capture-cap failure, in exchange for a lever a caller can only
/// use when it already knows the count.
///
/// 25, NOT 100, AND THE NUMBER IS LOAD-BEARING (roborev 55402, corrected by 55436).
///
/// `run_roborev` uses the strict `output_with_timeout`, which ERRORS when a stream exceeds
/// `worktree::DRAIN_BUF_CAP` — 4 MiB (4,194,304 bytes) in release. `roborev list --json` rows carry
/// the prebuilt prompt and reasoning, so they are enormous: measured live on this repo at ~30.5 KB
/// average and ~68 KB peak per row, and reported at ~137 KiB peak on prompt-heavy branches. At 100
/// rows that is ~3.0 MB typical and ~6.8 MB at the peak seen here, so a value the API advertised as
/// legal failed with an opaque "child wrote past the 4194304-byte per-stream capture cap".
///
/// 30 WAS STILL TOO HIGH, and the first version of this comment asserted otherwise without doing
/// the arithmetic: 30 × 137 KiB = 4,208,640 bytes, which is 14 KB OVER the cap before the JSON
/// array's own brackets and commas. 25 × 137 KiB = 3,507,200 leaves ~16% of headroom for that
/// framing and for a row somewhat above the observed peak. `the_row_ceiling_cannot_breach_the_cap`
/// asserts it with no slack.
const MAX_LIMIT: usize = 25;

/// Max chars of roborev stderr echoed into an error message. roborev can emit a long trace; the
/// caller needs the first line to act on, not the whole thing.
const ERROR_MESSAGE_CHARS: usize = 600;

// ── The list result ───────────────────────────────────────────────────────────────────────────

/// `roborev list --json`'s raw output, plus the branch it was actually read for.
///
/// The branch is returned rather than assumed because the CALLER cannot otherwise state it: a read
/// that comes back empty carries no rows to infer it from, and "no open findings" is a claim that
/// means nothing without saying no open findings ON WHAT. Resolving it here (rather than letting
/// roborev apply its own current-branch default) is what makes the answer self-describing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoborevListOut {
    /// The branch the findings were read for — the caller's, or this repo's current HEAD.
    pub branch: String,
    /// The row cap ACTUALLY applied, after the clamp below.
    ///
    /// Returned rather than left for the caller to mirror, because a caller that re-derived it
    /// would have to duplicate `DEFAULT_LIMIT` and `MAX_LIMIT` — and the moment those drift, a full
    /// page stops being recognised as a possibly-truncated one. A hallucinated `limit: 5000` is
    /// clamped to MAX_LIMIT here, and the caller is told THAT, not 5000. Naming the constant
    /// rather than its value is deliberate: the value has already moved once (100 -> 25).
    pub limit: usize,
    /// `roborev list --json` stdout, verbatim. Parsed on the frontend; see the header.
    pub json: String,
}

// ── Argument validation ───────────────────────────────────────────────────────────────────────

/// Is this a job id roborev will accept, and that cannot be read as a flag?
///
/// roborev takes either a numeric job id or a commit sha, so the accepted alphabet is exactly
/// [0-9a-f]. That is not merely a tidiness check: these values arrive from a MODEL, they are passed
/// as positional arguments, and a value beginning `-` would be parsed by cobra as a flag rather than
/// as the id — turning `close <id>` into `close --reopen`-shaped nonsense at best. An allowlist of
/// characters makes the whole class unrepresentable instead of blocking the spellings we thought of.
pub fn valid_finding_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c.to_ascii_lowercase()))
}

/// Is this a branch name safe to pass as a `--branch` value?
///
/// Same reasoning as above plus git's own rules: no leading `-`, no whitespace or control
/// characters, no `..` (which git reads as a range). Deliberately permissive about the rest —
/// this repo's branches are `sparkle/agent-<uuid>`, and a validator that guessed at a shape would
/// reject the real ones.
pub fn valid_branch(branch: &str) -> bool {
    !branch.is_empty()
        && branch.len() <= 255
        && !branch.starts_with('-')
        && !branch.contains("..")
        && !branch.bytes().any(|c| c.is_ascii_control() || c == b' ' || c == b'\t')
}

/// Trim roborev's stderr to something a human can read in a sentence.
fn short_error(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return "roborev produced no output".to_string();
    }
    if trimmed.chars().count() <= ERROR_MESSAGE_CHARS {
        return trimmed.to_string();
    }
    trimmed.chars().take(ERROR_MESSAGE_CHARS).collect::<String>() + "…"
}

/// Which tagged failure a roborev invocation's output represents, or `None` when it is not one we
/// recognise (which stays an untagged `roborev-failed` rather than being guessed at).
///
/// PURE, so the classification is unit-tested without a daemon — which matters here more than
/// usual, because the daemon-down case is the one that must never be reported as "no findings" and
/// it is precisely the case a developer cannot reproduce on a healthy machine.
pub fn classify_roborev_error(combined: &str) -> Option<&'static str> {
    let lower = combined.to_lowercase();
    // roborev's own wording, from `failed to connect to daemon: %w`. Matched on the stable
    // "connect to daemon" fragment rather than the whole sentence so the surrounding phrasing can
    // change without silently reclassifying this as an unknown failure.
    if lower.contains("connect to daemon") {
        return Some("roborev-daemon-down");
    }
    if lower.contains("no repositories found") || lower.contains("repository not found") {
        return Some("roborev-unregistered");
    }
    None
}

// ── Running the CLI ───────────────────────────────────────────────────────────────────────────

/// One roborev invocation, run in `repo`, returning stdout.
///
/// Every failure mode is folded into a tagged `Err` here so no call site has to remember to do it.
fn run_roborev(repo: &str, args: &[&str]) -> Result<String, String> {
    let Some(bin) = preflight::cached_roborev_path() else {
        return Err(
            "roborev-missing: the roborev binary isn't installed on this machine".to_string()
        );
    };
    let mut cmd = Command::new(&bin);
    cmd.args(args);
    // CWD is the repo, so roborev resolves "the current repo" the same way it does for a human
    // typing in that directory. `--repo` is passed by the callers as well; the two agree, and the
    // cwd is what makes a bare `repo show` work.
    cmd.current_dir(repo);
    let out = crate::worktree::output_with_timeout(cmd, ROBOREV_TIMEOUT).map_err(|e| {
        // `output_with_timeout` reports expiry as "timed out after Ns"; anything else is a spawn or
        // capture failure, which is not a timeout and must not claim to be one.
        if e.contains("timed out") {
            format!("roborev-timeout: roborev took longer than {}s to answer", ROBOREV_TIMEOUT.as_secs())
        } else {
            format!("roborev-failed: {e}")
        }
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    // A non-zero exit. roborev prints its connection failure on stderr but its usage banner on
    // stdout, so BOTH are classified — reading only stderr missed the daemon case on some paths.
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = format!("{stderr}\n{stdout}");
    match classify_roborev_error(&combined) {
        Some(tag) => Err(format!("{tag}: {}", short_error(&stderr))),
        None => Err(format!("roborev-failed: {}", short_error(&combined))),
    }
}

/// This repo's current branch, for the default scope of a findings read.
///
/// A detached HEAD (`rev-parse --abbrev-ref` prints "HEAD") is reported as an error rather than
/// passed to roborev as a branch named "HEAD": filtering on that would return nothing and read as
/// "no findings", which is the fake-empty-answer this whole module is written to avoid.
fn current_branch(repo: &str) -> Result<String, String> {
    let mut cmd = Command::new(preflight::git_program());
    cmd.args(["rev-parse", "--abbrev-ref", "HEAD"]);
    cmd.current_dir(repo);
    let out = crate::worktree::output_with_timeout(cmd, Duration::from_secs(15))
        .map_err(|e| format!("roborev-failed: reading the current branch failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "roborev-failed: {} is not a git repository I can read a branch from",
            repo
        ));
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Err(
            "roborev-detached-head: this repo has no current branch (detached HEAD), so I don't \
             know which branch's findings to read. Name a branch explicitly."
                .to_string(),
        );
    }
    Ok(branch)
}

/// The MAIN checkout of whatever repo `dir` belongs to — the path roborev registers a repo under.
///
/// `git-common-dir` is the shared `.git` directory: `<main>/.git` from the main checkout, and the
/// SAME `<main>/.git` from any linked worktree. Its parent is therefore the main checkout root from
/// anywhere in the repo. Returns None rather than guessing when git cannot answer.
fn main_checkout_root(dir: &str) -> Option<String> {
    let mut cmd = Command::new(preflight::git_program());
    cmd.args(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    cmd.current_dir(dir);
    let out = crate::worktree::output_with_timeout(cmd, Duration::from_secs(15)).ok()?;
    if !out.status.success() {
        return None;
    }
    let common = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if common.is_empty() {
        return None;
    }
    Path::new(&common).parent().map(|p| p.to_string_lossy().to_string())
}

/// Did the daemon say, definitively, that it has never heard of this repo?
///
/// Used ONLY to explain an empty result. `roborev list` on an unregistered repo returns an empty
/// array — indistinguishable from a registered repo with nothing open — and the difference is the
/// whole answer: one means "you're clear", the other means "nothing has ever reviewed this code".
/// Reporting the second as the first is the specific false reassurance this probe exists to prevent.
///
/// TWO THINGS THIS GETS RIGHT THAT THE FIRST VERSION DID NOT (roborev 55402).
///
/// 1. IT PROBES THE MAIN CHECKOUT, NOT THE WORKTREE. roborev registers a repo by its main checkout
///    path. `roborev list --repo <worktree>` answers fine, but `roborev repo show <worktree>` fails
///    with "repository not found" — verified on this machine. Since nearly all work in this repo
///    happens in a worktree, probing the worktree path meant a branch that is genuinely CLEAR was
///    reported as "roborev has never reviewed anything here": the exact inverse of the false
///    reassurance the probe exists to prevent, and the more alarming direction of the two.
///
/// 2. IT ONLY SPEAKS WHEN THE PROBE ACTUALLY RAN. The old form folded every failure into `false`,
///    so a 30s timeout, a missing binary, or a down daemon all minted a confident
///    "never reviewed". Absence of an answer is not an answer — anything that is not a clean
///    not-found leaves the empty result unexplained, which is the honest outcome.
fn is_definitely_unregistered(repo: &str) -> bool {
    let Some(root) = main_checkout_root(repo) else {
        return false;
    };
    match run_roborev(&root, &["repo", "show", &root]) {
        Ok(_) => false,
        // roborev's own words for the one case that means what we are asking about.
        Err(e) => e.contains("repository not found"),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────

/// Open (unresolved) roborev findings, scoped to one branch of one repo.
///
/// NEVER MACHINE-WIDE. `roborev list` with no `--repo`/`--branch` answers for whatever repo the
/// process happens to sit in and, worse, is easy to widen by accident — and a concierge that
/// answers "you have 316 open findings" across 172 branches has told the human nothing they can
/// act on. Both filters are always sent.
#[tauri::command]
pub async fn roborev_list_findings(
    repo: String,
    branch: Option<String>,
    limit: Option<usize>,
) -> Result<RoborevListOut, String> {
    if let Some(b) = branch.as_deref() {
        if !valid_branch(b) {
            return Err(format!("roborev-bad-args: {b:?} is not a usable branch name"));
        }
    }
    let cap = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    tauri::async_runtime::spawn_blocking(move || {
        let branch = match branch {
            Some(b) => b,
            None => current_branch(&repo)?,
        };
        let cap_s = cap.to_string();
        let json = run_roborev(
            &repo,
            &["list", "--open", "--json", "--repo", &repo, "--branch", &branch, "--limit", &cap_s],
        )?;
        // An empty answer is ambiguous until we know the repo is tracked at all — see is_registered.
        // Probed ONLY on the empty path, so the common case costs one daemon round-trip, not two.
        let looks_empty = json.trim().is_empty() || json.trim() == "[]" || json.trim() == "null";
        if looks_empty && is_definitely_unregistered(&repo) {
            return Err(format!(
                "roborev-unregistered: roborev has never reviewed anything in {repo}, so an empty \
                 result here means \"never looked\", not \"nothing found\""
            ));
        }
        Ok(RoborevListOut { branch, limit: cap, json })
    })
    .await
    .map_err(|e| format!("roborev-failed: roborev_list_findings task failed: {e}"))?
}

/// The full review text for one finding.
///
/// `--job` is forced rather than left to roborev's ref-then-id guessing: a numeric id is tried as a
/// git ref FIRST, so a job id that happens to also name a tag would silently answer about a
/// different commit's review. The id is validated above to be digits/hex, so forcing it is safe.
#[tauri::command]
pub async fn roborev_show_finding(repo: String, id: String) -> Result<String, String> {
    if !valid_finding_id(&id) {
        return Err(format!(
            "roborev-bad-args: {id:?} is not a roborev job id (they are numeric, or a commit sha)"
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_roborev(&repo, &["show", "--job", &id, "--json"])
    })
    .await
    .map_err(|e| format!("roborev-failed: roborev_show_finding task failed: {e}"))?
}

/// Record a rationale against a finding and then close it.
///
/// THE ORDER IS THE CONTRACT, and it lives here rather than in the caller. roborev's own workflow is
/// comment-then-close (`roborev comment <id> -m "<why>"` then `roborev close <id>`): a closed
/// finding with no comment is indistinguishable from one somebody dismissed without reading, which
/// is exactly the state AGENTS.md's "close any Low you still see with a stated rationale" exists to
/// prevent. If the comment fails, the close DOES NOT RUN — an unexplained close is worse than a
/// finding left open, because the finding at least still asks its question.
///
/// The rationale is passed via `-m`, as one argv element. It is never interpolated into a shell
/// string; there is no shell in this path at all.
#[tauri::command]
pub async fn roborev_close_finding(
    repo: String,
    id: String,
    rationale: String,
) -> Result<(), String> {
    if !valid_finding_id(&id) {
        return Err(format!(
            "roborev-bad-args: {id:?} is not a roborev job id (they are numeric, or a commit sha)"
        ));
    }
    let rationale = rationale.trim().to_string();
    if rationale.is_empty() {
        return Err(
            "roborev-bad-args: closing a finding needs a rationale — it is recorded on the review \
             so the next reader knows why it was dismissed"
                .to_string(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Comment FIRST. See the doc comment: a failure here must abort the close.
        run_roborev(&repo, &["comment", "--job", &id, "-m", &rationale])?;
        run_roborev(&repo, &["close", &id])?;
        Ok(())
    })
    .await
    .map_err(|e| format!("roborev-failed: roborev_close_finding task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_in(dir: &str, args: &[&str]) -> bool {
        Command::new(preflight::git_program())
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// THE PROBE MUST ANSWER FOR THE MAIN CHECKOUT, NOT THE WORKTREE (roborev 55402).
    ///
    /// roborev registers a repo by its main checkout path: `roborev repo show <worktree>` fails with
    /// "repository not found" even when `roborev list --repo <worktree>` answers fine. Since nearly
    /// all work in this repo happens in a linked worktree, probing the worktree path turned a branch
    /// that was genuinely CLEAR into "roborev has never reviewed anything here". This pins the
    /// resolution step that fix rests on: from inside a linked worktree, we resolve back to the main
    /// checkout. Reverting `main_checkout_root` to return its input fails here.
    #[test]
    fn main_checkout_root_resolves_back_from_a_linked_worktree() {
        let dir = tempfile::tempdir().expect("temp dir");
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).expect("mkdir");
        let main_s = main.to_string_lossy().to_string();
        assert!(git_in(&main_s, &["init", "-q", "-b", "main"]), "init");
        assert!(git_in(&main_s, &["config", "user.email", "t@example.com"]), "email");
        assert!(git_in(&main_s, &["config", "user.name", "T"]), "name");
        assert!(git_in(&main_s, &["commit", "-q", "--allow-empty", "-m", "root"]), "commit");

        let wt = dir.path().join("wt");
        let wt_s = wt.to_string_lossy().to_string();
        assert!(git_in(&main_s, &["worktree", "add", "-q", "--detach", &wt_s]), "worktree add");

        // From the worktree, the answer is the MAIN checkout — not the worktree it was asked from.
        let resolved = main_checkout_root(&wt_s).expect("worktree resolves");
        assert_eq!(
            std::fs::canonicalize(&resolved).expect("canonical resolved"),
            std::fs::canonicalize(&main).expect("canonical main"),
            "a linked worktree must resolve to the main checkout, got {resolved}"
        );

        // …and from the main checkout it is still itself, so the fix did not trade one error for another.
        let from_main = main_checkout_root(&main_s).expect("main resolves");
        assert_eq!(
            std::fs::canonicalize(&from_main).expect("canonical from_main"),
            std::fs::canonicalize(&main).expect("canonical main"),
        );
    }

    /// Absence of an answer is not an answer. A directory that is not a repo at all cannot yield a
    /// confident "roborev has never reviewed this" — the old form folded every failure, including a
    /// timeout or a missing binary, into exactly that claim.
    #[test]
    fn a_probe_that_cannot_run_never_reports_unregistered() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(main_checkout_root(&dir.path().to_string_lossy()).is_none());
        assert!(
            !is_definitely_unregistered(&dir.path().to_string_lossy()),
            "an unresolvable repo must not mint a confident 'never reviewed'"
        );
    }

    /// The ceiling is arithmetic against the capture cap, not a round number: rows carry the
    /// prebuilt prompt and measure ~30 KB average / ~68 KiB peak here, ~137 KiB peak reported.
    /// Raising it reintroduces an opaque capture-cap failure for an argument the API calls legal.
    ///
    /// NO SLACK IN THE ASSERTION (roborev 55436). The first version allowed one whole row of
    /// overshoot (`<= CAP + WORST_ROW_BYTES`), which is the only reason MAX_LIMIT = 30 passed —
    /// 30 × 137 KiB is 4,208,640, i.e. 14 KB PAST the cap. A test calibrated to accept the current
    /// value rather than to assert the property is worse than no test: it reads as proof.
    ///
    /// The release cap is IMPORTED, not restated (roborev 55466). `worktree::DRAIN_BUF_CAP` is
    /// deliberately smaller under `#[cfg(test)]` (512 KiB, so a test can reach it without writing
    /// 4 MiB), which is why this cannot just read that name — but `RELEASE_DRAIN_BUF_CAP` is
    /// compiled unconditionally beside it precisely so this test can reference the shipping value
    /// instead of hand-copying it.
    ///
    /// BRACKETED FROM BOTH SIDES. An upper bound alone is satisfied by `MAX_LIMIT = 1`, so it does
    /// not assert what its own comment claims — that the number is doing real work rather than
    /// sitting comfortably under whatever bound was chosen. The lower bound is what makes a
    /// uselessly small ceiling fail too. The old second assertion (`30 * WORST_ROW_BYTES > CAP`)
    /// compared two literals, never mentioned `MAX_LIMIT`, and would have mis-fired on a legitimate
    /// re-measurement of `WORST_ROW_BYTES` downward; that arithmetic is history and belongs in the
    /// doc comment on `MAX_LIMIT`, where it already is.
    #[test]
    fn the_row_ceiling_cannot_breach_the_cap() {
        use crate::worktree::RELEASE_DRAIN_BUF_CAP;
        /// The largest per-row size reported in the wild, in BYTES (137 KiB, not 137 × 1000).
        const WORST_ROW_BYTES: usize = 137 << 10;

        assert!(
            MAX_LIMIT * WORST_ROW_BYTES <= RELEASE_DRAIN_BUF_CAP,
            "MAX_LIMIT={MAX_LIMIT} can produce {} bytes, past the {RELEASE_DRAIN_BUF_CAP}-byte cap",
            MAX_LIMIT * WORST_ROW_BYTES
        );
        assert!(
            MAX_LIMIT * WORST_ROW_BYTES > RELEASE_DRAIN_BUF_CAP / 2,
            "MAX_LIMIT={MAX_LIMIT} spends only {} of the {RELEASE_DRAIN_BUF_CAP}-byte budget — a \
             ceiling this far under the cap is throwing away rows it could safely return",
            MAX_LIMIT * WORST_ROW_BYTES
        );
        assert!(DEFAULT_LIMIT <= MAX_LIMIT);
    }

    #[test]
    fn finding_ids_are_digits_or_hex_only() {
        assert!(valid_finding_id("46911"));
        assert!(valid_finding_id("a088195c9"));
        assert!(!valid_finding_id(""));
        // The whole point of the allowlist: a leading dash would be read by cobra as a FLAG, not
        // as the positional id, so `close <id>` could become something else entirely.
        assert!(!valid_finding_id("-reopen"));
        assert!(!valid_finding_id("46911 --reopen"));
        assert!(!valid_finding_id("46911;rm"));
        assert!(!valid_finding_id("zzz"));
    }

    #[test]
    fn branch_names_reject_flags_ranges_and_control_chars() {
        assert!(valid_branch("main"));
        assert!(valid_branch("sparkle/agent-b0e5c32a-bda9-4716-abba-0ba3a5c28c12"));
        assert!(!valid_branch(""));
        assert!(!valid_branch("--repo"));
        // `..` is a git RANGE, and a value carrying one would silently change what is being asked.
        assert!(!valid_branch("main..HEAD"));
        assert!(!valid_branch("main branch"));
        assert!(!valid_branch("main\nlist"));
    }

    // The classification that must never be wrong: a stopped daemon looks like every other failure
    // from the outside, and calling it anything else lets the concierge report "no findings" about a
    // repo whose findings simply could not be reached.
    #[test]
    fn a_stopped_daemon_is_classified_as_such() {
        assert_eq!(
            classify_roborev_error("Error: failed to connect to daemon (is it running?)"),
            Some("roborev-daemon-down")
        );
        // Casing and surrounding prose vary; the stable fragment is what is matched.
        assert_eq!(
            classify_roborev_error("FAILED TO CONNECT TO DAEMON: dial unix: no such file"),
            Some("roborev-daemon-down")
        );
    }

    #[test]
    fn an_untracked_repo_is_classified_as_unregistered() {
        assert_eq!(
            classify_roborev_error("No repositories found"),
            Some("roborev-unregistered")
        );
    }

    // An unrecognised failure stays unrecognised. Guessing here would mint a confident, wrong
    // explanation for something nobody has seen yet.
    #[test]
    fn an_unknown_failure_is_not_guessed_at() {
        assert_eq!(classify_roborev_error("panic: runtime error"), None);
        assert_eq!(classify_roborev_error(""), None);
    }

    #[test]
    fn stderr_is_trimmed_but_never_emptied() {
        assert_eq!(short_error("   "), "roborev produced no output");
        assert_eq!(short_error("  boom  "), "boom");
        let long = "x".repeat(ERROR_MESSAGE_CHARS + 50);
        let short = short_error(&long);
        assert!(short.ends_with('…'));
        assert_eq!(short.chars().count(), ERROR_MESSAGE_CHARS + 1);
    }
}

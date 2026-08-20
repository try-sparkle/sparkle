// apps/desktop/src-tauri/src/bead_dup.rs
//! FILE-TIME DUPLICATE DETECTION for the app's own `bd create` paths.
//!
//! The contract this is built against is `docs/bead-dedupe-contract.md` — it is frozen, and the
//! scanner (`scripts/bead-dup-check.sh`) is owned by a different workstream. Nothing here
//! reimplements the scorer: this module RESOLVES the scanner, runs it, and decides what to do with
//! its exit code. Section 7 of the contract forbids a second scorer in Rust or TS explicitly,
//! because a tokenizer + stopword list + four thresholds + a ranking function cannot be kept in
//! step across two languages.
//!
//! ══ THE SAFETY CORE ═══════════════════════════════════════════════════════════════════════════
//!
//! An UNCONDITIONAL fold is DESTRUCTIVE, and that is not a hypothetical. Three of the app's create
//! paths file beads that are near-identical BY CONSTRUCTION:
//!
//!   * `services/buildAgentSpawn.ts` — title = the agent's name (often literally `Build task`), an
//!     EMPTY body, label `sparkle-auto`. A fold binds two different Build agents to ONE bead id via
//!     `setAgentBeadId`.
//!   * `stores/runtimeStore.ts` — the fixed body "Auto-created by Sparkle for a deliverable Build
//!     agent." for EVERY agent. A 100% self-match; every agent would collapse onto one bead.
//!   * `services/tasks.ts::createChildTasks` — decomposition children, each carrying
//!     `parent=<epicId>`. Folding siblings collapses a plan into a single task.
//!
//! These are also the MEASURED false-positive family — the `Build 1` … `Build 13` clusters, 268
//! beads. They are telemetry and structure, not findings.
//!
//! So the fold is gated by an ARGV-LEVEL SKIP LIST evaluated BEFORE any scan ([`fold_decision`]).
//! **A score threshold cannot substitute for it**: these beads are genuinely identical, so they
//! score at the very top of the range. The skip list is the only thing standing between this
//! feature and corrupted agent↔bead bindings.
//!
//! ══ THE SAFETY DIRECTION IS INVERTED ══════════════════════════════════════════════════════════
//!
//! For every other guard in this repo, "could not tell" means STOP. Here it means PROCEED: falsely
//! claiming a duplicate LOSES a finding outright, while a redundant bead is merely untidy and is
//! exactly what happens today. So every uncertainty in this module — scanner missing, scanner
//! errored, exit 3, unparseable output, an id we cannot re-verify, a comment that failed — returns
//! `None`, i.e. CREATE THE BEAD. There is no path here that folds on a maybe.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::beads_cmd::{self, BD_TIMEOUT, ChildEnv};
use crate::notes::{cached_bd_path, valid_bead_id};

/// The label the app stamps on the beads it auto-files for Build agents (`services/beads.ts`
/// `AUTO_LABEL`). Its presence is the single strongest skip signal — see the module note.
pub(crate) const AUTO_LABEL: &str = "sparkle-auto";

/// The environment variable that overrides scanner resolution. It is BOTH the operator escape
/// hatch and the module's test seam: [`fold_or_create`] reads it out of the caller's [`ChildEnv`]
/// first, so a test can point the PRODUCTION call sites at a fake scanner without a defaulted
/// `deps` parameter that every test overrides (which would leave the real resolution covered by
/// nothing) and without `std::env::set_var`, which leaks across `cargo test`'s parallel threads.
pub(crate) const SCANNER_ENV_VAR: &str = "SPARKLE_BEAD_DUP_SCAN";

/// Where the scanner lives inside a project when the env var is unset. Deliberately resolved from
/// the project checkout rather than bundled as a Tauri resource: bundling means a SECOND copy of
/// the file and the drift this repo hates.
const SCANNER_REL_PATH: [&str; 2] = ["scripts", "bead-dup-check.sh"];

/// Contract §3: the match is OPEN / in_progress / deferred — comment on it, do not create.
const EXIT_DUPLICATE_OPEN: i32 = 10;
/// Contract §3: the match is CLOSED — reopen it and comment; the fix regressed.
const EXIT_DUPLICATE_CLOSED: i32 = 11;

/// Bound on the scanner itself. The contract measures the local awk scan at ~1.0s CPU and forbids
/// it from touching bd, so this is a generous ceiling on a fast path, not a budget to spend.
const SCAN_TIMEOUT: Duration = Duration::from_secs(20);

/// How much of the incoming body is quoted into the fold comment. The comment is the durable record
/// that a create was folded; it is not a copy of the bead.
const FOLD_BODY_EXCERPT_CHARS: usize = 600;

/// Distinctive title tokens required before a title is even eligible to be scanned. Named for the
/// contract's `RETRO_CONTAINMENT_MIN_TOKENS`, which the scorer uses for the same purpose, and
/// overridable through that variable so both halves move together.
const DEFAULT_MIN_TITLE_TOKENS: usize = 4;

/// Words that carry no distinguishing signal in a bead title. Small on purpose: this list exists to
/// stop `Build task` and `Sparkle Project Tab` from clearing the token floor, NOT to be a second
/// tokenizer competing with the scorer's (contract §7 forbids that).
const STOPWORDS: [&str; 40] = [
    "the", "and", "for", "with", "from", "that", "this", "into", "onto", "when", "then", "than",
    "are", "was", "were", "not", "but", "its", "has", "have", "had", "will", "can", "does", "did",
    "should", "would", "could", "task", "build", "agent", "sparkle", "issue", "bead", "new", "add",
    "fix", "make", "use", "run",
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The skip list — a PURE function, tested independently of any process
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Whether a proposed create may be scanned for duplicates at all.
///
/// `Skip` carries a `&'static str` REASON rather than a bare bool so a log line (and a failing
/// test) names which clause fired. Each variant of the reason is a distinct catastrophic case; see
/// the module note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FoldDecision {
    /// Do not scan and do not fold. Create the bead exactly as the caller asked.
    Skip(&'static str),
    /// The create is eligible; run the scanner and act on its verdict.
    Scan,
}

/// The ARGV-LEVEL skip list of contract §6, evaluated before any scoring.
///
/// `labels` is the comma-separated form both create paths already carry. `issue_type` and `parent`
/// are the raw argv values ("" when the caller passes none).
///
/// ORDERING is meaningful only for the reason string; every clause is independently sufficient.
pub fn fold_decision(labels: &str, issue_type: &str, parent: &str, title: &str) -> FoldDecision {
    if has_label(labels, AUTO_LABEL) {
        // App telemetry, one per Build-agent spawn. Folding two of these binds two live agents to
        // ONE bead id through `setAgentBeadId`.
        return FoldDecision::Skip("sparkle-auto");
    }
    if issue_type.trim().eq_ignore_ascii_case("epic") {
        // An epic is a container. Folding one onto another merges two plans.
        return FoldDecision::Skip("epic");
    }
    if !parent.trim().is_empty() {
        // A child of a decomposition. Its siblings are near-identical by construction, so folding
        // them collapses the plan they describe.
        return FoldDecision::Skip("parented");
    }
    if distinctive_tokens(title).len() < min_title_tokens() {
        // `Build 1` … `Build 13`: 268 measured beads of distinct work sharing a generic auto-title.
        return FoldDecision::Skip("title-too-generic");
    }
    FoldDecision::Scan
}

/// Is `label` one of the comma-separated entries in `labels`? Whole-token, case-insensitive — a
/// substring test would match `sparkle-automation` and skip a real finding.
fn has_label(labels: &str, label: &str) -> bool {
    labels.split(',').any(|l| l.trim().eq_ignore_ascii_case(label))
}

/// The distinctive (lowercased, de-duplicated, non-stopword) tokens of a title.
///
/// This is a PRECONDITION check, not a similarity score: it answers "is there enough here to be
/// worth asking the scanner about", and the scanner remains the only thing that decides similarity.
fn distinctive_tokens(title: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in title.split(|c: char| !c.is_alphanumeric()) {
        let t = raw.to_lowercase();
        if t.len() < 3 || t.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if STOPWORDS.contains(&t.as_str()) {
            continue;
        }
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// The token floor, from `RETRO_CONTAINMENT_MIN_TOKENS` when the process environment sets it.
/// A malformed or zero value falls back to the default rather than disabling the floor — a floor of
/// zero would make every generic auto-title eligible, which is the exact corruption this prevents.
fn min_title_tokens() -> usize {
    std::env::var("RETRO_CONTAINMENT_MIN_TOKENS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_MIN_TITLE_TOKENS)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The fold proper
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Look for an existing bead this create would duplicate; on a confident match, record the sighting
/// on it and return ITS row so the caller can hand that back instead of filing a second bead.
///
/// `Some(row)` means DO NOT CREATE — the row is the bead object `bd show --json` returned, which is
/// the same shape `bd create --json` emits, so every existing parser on both sides of the bridge
/// already handles it. `None` means CREATE, and it is the answer to every uncertainty (see the
/// module note on the inverted safety direction).
///
/// The sequence, and why each step is there:
///
///   1. [`fold_decision`] — the skip list. Nothing below runs for a skipped create.
///   2. Resolve the scanner: `$SPARKLE_BEAD_DUP_SCAN`, else `<project>/scripts/bead-dup-check.sh`,
///      else give up and create.
///   3. Run it with the title and body as the query. Only exits 10 and 11 fold; 0 and 3 both create
///      (contract §3), and so does a timeout, a spawn failure, or any other status.
///   4. RE-VERIFY the match with `bd show <id> --json` — the STALE-INDEX GUARD. The scanner reads a
///      cached TSV with a 900s TTL, so the bead it names may have been deleted or renumbered since;
///      commenting on a stale id would lose the finding with no trace.
///   5. `bd reopen` first when the match was CLOSED (exit 11) — a closed match means the fix
///      regressed, and a comment on a closed bead is invisible to every "open work" query.
///   6. Comment through `beads_cmd::build_comment_args`, which already handles the leading-dash
///      hazard with `--`.
///
/// A failure at 4, 5 or 6 returns `None` and creates. That is deliberate and is the direction that
/// preserves the finding: creating a duplicate is today's behaviour and is recoverable, while
/// folding onto a bead we could not verify or annotate loses the report entirely.
pub fn fold_or_create(
    project_path: &str,
    title: &str,
    body: &str,
    labels: &str,
    issue_type: &str,
    parent: &str,
    env: ChildEnv<'_>,
) -> Option<Value> {
    if let FoldDecision::Skip(_) = fold_decision(labels, issue_type, parent, title) {
        return None;
    }
    let scanner = resolve_scanner(project_path, env)?;
    let verdict = scan(&scanner, project_path, title, body, env)?;
    let bd = cached_bd_path()?;

    // Stale-index guard: the scanner's answer is only a claim about a cached TSV.
    let mut row = show_row(&bd, project_path, &verdict.id, env)?;

    if verdict.reopen {
        let out = beads_cmd::run_cmd_timed(
            &bd,
            project_path,
            &["reopen".into(), verdict.id.clone()],
            BD_TIMEOUT,
            env,
        )
        .ok()?;
        if !out.success {
            return None;
        }
        // The row was read BEFORE the reopen, so its status is the stale `closed`. Correct it
        // rather than paying a second `bd show`: the caller reports this row to a human.
        if let Some(obj) = row.as_object_mut() {
            obj.insert("status".into(), Value::String("open".into()));
        }
    }

    let comment = fold_comment(title, body, verdict.reopen);
    let args = beads_cmd::build_comment_args(&verdict.id, &comment);
    // `EDITOR=true` for the same reason `notes::run_bd_env` pins it: bd's comment path can fall back
    // to an editor, and an editor opened from a Tauri command has no terminal to close it.
    let comment_env: Vec<(&str, &str)> = env.iter().copied().chain([("EDITOR", "true")]).collect();
    let out =
        beads_cmd::run_cmd_timed(&bd, project_path, &args, BD_TIMEOUT, &comment_env).ok()?;
    if !out.success {
        return None;
    }
    Some(row)
}

/// What the scanner said, once we believe it enough to act on.
struct Verdict {
    id: String,
    /// Exit 11 — the match is closed, so it must be reopened before the comment lands anywhere
    /// anyone looks.
    reopen: bool,
}

/// `$SPARKLE_BEAD_DUP_SCAN`, else `<project_path>/scripts/bead-dup-check.sh`, else `None`.
///
/// An env var that names a path which is not a file resolves to `None` (create), NOT to the default
/// path: an operator who pointed this at something specific and got the repo copy instead would be
/// running a scanner they did not choose.
fn resolve_scanner(project_path: &str, env: ChildEnv<'_>) -> Option<PathBuf> {
    if let Some(p) = env_value(env, SCANNER_ENV_VAR) {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let mut p = PathBuf::from(project_path);
    for seg in SCANNER_REL_PATH {
        p.push(seg);
    }
    p.is_file().then_some(p)
}

/// Read a variable from the caller's child environment FIRST, falling back to this process's own.
/// The child-env lookup is what makes the production call sites drivable from a test.
fn env_value(env: ChildEnv<'_>, key: &str) -> Option<String> {
    env.iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| (*v).to_string())
        .or_else(|| std::env::var(key).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Run the scanner and translate its exit code per contract §3. `None` for every status other than
/// 10 and 11 — including `0` (no duplicate), `3` (could not tell) and `4` (usage error).
fn scan(
    scanner: &Path,
    project_path: &str,
    title: &str,
    body: &str,
    env: ChildEnv<'_>,
) -> Option<Verdict> {
    let mut args: Vec<String> = vec!["--title".into(), title.trim().to_string()];
    if !body.trim().is_empty() {
        args.push("--body".into());
        args.push(body.trim().to_string());
    }
    let out = beads_cmd::run_cmd_timed(
        &scanner.to_string_lossy(),
        project_path,
        &args,
        SCAN_TIMEOUT,
        env,
    )
    .ok()?;
    // `status` is None when the child was killed on expiry — which is "could not tell", so create.
    let reopen = match out.status? {
        EXIT_DUPLICATE_OPEN => false,
        EXIT_DUPLICATE_CLOSED => true,
        _ => return None,
    };
    let payload: Value = serde_json::from_str(out.stdout.trim()).ok()?;
    let id = payload.get("id").and_then(Value::as_str)?.trim().to_string();
    // An id we cannot pass back to bd is unusable, and `valid_bead_id` is also the flag-injection
    // guard — a scanner emitting `-rf` must not become an argv option.
    valid_bead_id(&id).then_some(Verdict { id, reopen })
}

/// `bd show <id> --json`, returning the row whose id actually matches. `bd` emits either a bare
/// object or a one-element array depending on the subcommand, so both are accepted — the same
/// tolerance `beads_cmd::parse_bead_rows` applies.
fn show_row(bd: &str, project_path: &str, id: &str, env: ChildEnv<'_>) -> Option<Value> {
    let out = beads_cmd::run_cmd_timed(
        bd,
        project_path,
        &["show".into(), id.to_string(), "--json".into()],
        BD_TIMEOUT,
        env,
    )
    .ok()?;
    if !out.success {
        return None;
    }
    row_with_id(out.stdout.trim(), id)
}

/// Pick the row carrying `id` out of bd's `show --json` stdout. Pure, so the stale-index guard's
/// matching rule is testable without bd. A payload carrying an `error` key, or no row with this id,
/// yields `None` — which creates.
fn row_with_id(stdout: &str, id: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(stdout).ok()?;
    if parsed.get("error").is_some() {
        return None;
    }
    let rows: Vec<Value> = match parsed {
        Value::Array(rows) => rows,
        v @ Value::Object(_) => vec![v],
        _ => return None,
    };
    rows.into_iter().find(|r| {
        let got = r.get("id").or_else(|| r.get("issue_id")).and_then(Value::as_str);
        got == Some(id)
    })
}

/// The durable record that a create was folded. Written to the bead because a `log.warn` dies with
/// the session and this is the only place a human ever looks for "why is there no new bead".
fn fold_comment(title: &str, body: &str, reopened: bool) -> String {
    let lead = if reopened {
        "Reopened by Sparkle: a new report matched this CLOSED bead, so the fix appears to have regressed."
    } else {
        "Duplicate folded by Sparkle: a new report matched this bead, so no second bead was filed."
    };
    let mut s = format!("{lead}\n\nTitle: {}", title.trim());
    let body = body.trim();
    if !body.is_empty() {
        s.push_str("\n\n");
        s.push_str(&excerpt(body, FOLD_BODY_EXCERPT_CHARS));
    }
    s
}

/// First `max` CHARS (not bytes — a `&str[..n]` slice panics mid-codepoint), with an ellipsis when
/// anything was dropped.
fn excerpt(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

/// Write an executable stand-in for `scripts/bead-dup-check.sh` and return its path.
///
/// The scanner is owned by a different workstream and is NOT present in this crate, so every test
/// that drives the fold supplies its own. Executable-on-PATH rather than a Rust closure for the
/// same reason `scripts/tests/retro-near-duplicate.test.sh` uses a PATH shim: the production code
/// SPAWNS this, so a fake that is not a process would not exercise the code under test at all.
#[cfg(all(test, unix))]
pub(crate) fn write_fake_scanner(
    dir: &Path,
    name: &str,
    exit_code: i32,
    stdout: &str,
) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    // The payload is written through a quoted heredoc so nothing in it is re-expanded by sh.
    std::fs::write(
        &path,
        format!("#!/bin/sh\ncat <<'SPARKLE_FAKE_SCAN_EOF'\n{stdout}\nSPARKLE_FAKE_SCAN_EOF\nexit {exit_code}\n"),
    )
    .expect("write fake scanner");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
        .expect("chmod fake scanner");
    path
}

#[cfg(test)]
// `pub(crate)` so `notes.rs`'s integration tests share `id_of` rather than each re-deriving how to
// pull an id out of a raw bd row.
pub(crate) mod tests {
    use super::*;

    /// The `id` out of a raw bd `--json` row string. `notes.rs`'s create surface returns bd's stdout
    /// verbatim (its frontend contract is stringly), so its tests need this to say anything about
    /// which bead came back.
    pub(crate) fn id_of(raw: &str) -> String {
        let v: Value = serde_json::from_str(raw.trim()).unwrap_or_else(|e| panic!("not JSON: {e}: {raw}"));
        let row = if v.is_array() { v.get(0).cloned().unwrap_or(Value::Null) } else { v };
        row.get("id")
            .or_else(|| row.get("issue_id"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("no id in {row}"))
            .to_string()
    }

    // ── The skip list ────────────────────────────────────────────────────────────────────────
    //
    // Each of these encodes a CATASTROPHIC case. A regression here does not produce a tidier
    // backlog, it produces two Build agents bound to one bead id, or a decomposed plan collapsed
    // into a single task. They are asserted on the reason string as well as the variant so a clause
    // cannot be silently satisfied by a different one.

    #[test]
    fn a_sparkle_auto_bead_is_never_scanned() {
        // buildAgentSpawn.ts: title = the agent name, EMPTY body, label sparkle-auto. Folding two of
        // these binds two live Build agents to ONE bead id via setAgentBeadId.
        assert_eq!(
            fold_decision(
                "sparkle-auto",
                "task",
                "",
                "Wire duplicate detection into the create paths"
            ),
            FoldDecision::Skip("sparkle-auto")
        );
        // …and it must win even when the title is richly distinctive, i.e. the label is what
        // decides, not the score.
        assert_eq!(
            fold_decision(
                "agent-feedback,sparkle-auto,seen-2",
                "task",
                "",
                "Deepgram relay probe reports a false production outage over HTTP/2"
            ),
            FoldDecision::Skip("sparkle-auto")
        );
    }

    #[test]
    fn a_label_that_merely_starts_with_the_auto_label_does_not_skip() {
        // A substring test here would silently switch the feature off for a whole label family.
        assert_eq!(
            fold_decision(
                "sparkle-automation",
                "task",
                "",
                "Deepgram relay probe reports a false production outage"
            ),
            FoldDecision::Scan
        );
    }

    #[test]
    fn an_epic_is_never_scanned() {
        // An epic is a container; folding one onto another merges two plans.
        assert_eq!(
            fold_decision("", "epic", "", "Harden the release pipeline against stale bases"),
            FoldDecision::Skip("epic")
        );
        assert_eq!(
            fold_decision("", "EPIC", "", "Harden the release pipeline against stale bases"),
            FoldDecision::Skip("epic")
        );
    }

    #[test]
    fn a_parented_bead_is_never_scanned() {
        // tasks.ts::createChildTasks: decomposition children each carry parent=<epicId> and are
        // near-identical by construction. Folding siblings collapses the plan.
        assert_eq!(
            fold_decision("", "task", "sparkle-43ho5u", "Add the scanner resolution and its tests"),
            FoldDecision::Skip("parented")
        );
    }

    #[test]
    fn a_generic_auto_title_yields_too_few_distinctive_tokens() {
        // The measured false-positive family: `Build 1` … `Build 13`, 268 beads of distinct work
        // sharing one generic auto-title.
        for t in ["Build task", "Build 1", "Build 13", "Sparkle Project Tab Shading"] {
            assert_eq!(
                fold_decision("", "task", "", t),
                FoldDecision::Skip("title-too-generic"),
                "{t} must not be eligible for scanning"
            );
        }
    }

    #[test]
    fn an_ordinary_finding_is_eligible() {
        // The positive assertion, so "the skip list matched everything" fails instead of passing
        // silently — a guard that never says Scan is a feature that never runs.
        assert_eq!(
            fold_decision(
                "agent-feedback",
                "task",
                "",
                "curl probing a WebSocket route silently strips the upgrade header"
            ),
            FoldDecision::Scan
        );
        assert_eq!(
            fold_decision("", "", "  ", "Rebase before the first full verification run"),
            FoldDecision::Scan
        );
    }

    #[test]
    fn distinctive_tokens_drop_noise_and_duplicates() {
        assert_eq!(distinctive_tokens("Build task"), Vec::<String>::new());
        assert_eq!(distinctive_tokens("Build 13"), Vec::<String>::new());
        // Case-folded, de-duplicated, punctuation-split, bare numbers dropped.
        assert_eq!(
            distinctive_tokens("Relay probe: relay PROBE returns 404 over HTTP/2"),
            vec!["relay", "probe", "returns", "over", "http"]
        );
    }

    // ── The stale-index guard's matching rule ────────────────────────────────────────────────

    #[test]
    fn row_with_id_accepts_an_object_or_a_one_element_array() {
        let obj = r#"{"id":"sparkle-43ho5u","title":"t"}"#;
        assert_eq!(
            row_with_id(obj, "sparkle-43ho5u").unwrap()["title"],
            Value::String("t".into())
        );
        let arr = r#"[{"issue_id":"sparkle-43ho5u","title":"t"}]"#;
        assert!(row_with_id(arr, "sparkle-43ho5u").is_some());
    }

    #[test]
    fn row_with_id_refuses_a_stale_or_errored_answer() {
        // The whole point of the re-verify: the scanner named a bead that is no longer there.
        assert!(row_with_id(r#"[]"#, "sparkle-43ho5u").is_none());
        assert!(row_with_id(r#"{"id":"sparkle-other"}"#, "sparkle-43ho5u").is_none());
        assert!(row_with_id(r#"{"error":"issue not found"}"#, "sparkle-43ho5u").is_none());
        assert!(row_with_id("not json", "sparkle-43ho5u").is_none());
        assert!(row_with_id("", "sparkle-43ho5u").is_none());
    }

    #[test]
    fn env_value_prefers_the_child_env_over_the_process() {
        assert_eq!(
            env_value(&[(SCANNER_ENV_VAR, "/tmp/fake-scan.sh")], SCANNER_ENV_VAR).as_deref(),
            Some("/tmp/fake-scan.sh")
        );
        // An empty value is not an override — it must fall through to the default resolution.
        assert_eq!(env_value(&[(SCANNER_ENV_VAR, "   ")], SCANNER_ENV_VAR), None);
    }

    #[test]
    fn a_scanner_path_that_is_not_a_file_resolves_to_nothing() {
        // …so the fold gives up and the bead is CREATED, rather than silently falling back to a
        // scanner the operator did not choose.
        assert!(
            resolve_scanner("/nonexistent-project", &[(SCANNER_ENV_VAR, "/nonexistent/scan.sh")])
                .is_none()
        );
    }

    #[test]
    fn the_fold_comment_names_the_reopen_case_distinctly() {
        let folded = fold_comment("A title", "A body", false);
        assert!(folded.contains("Duplicate folded"), "{folded}");
        assert!(folded.contains("A title") && folded.contains("A body"), "{folded}");
        let reopened = fold_comment("A title", "", true);
        assert!(reopened.contains("regressed"), "{reopened}");
    }

    #[test]
    fn excerpt_cuts_on_chars_not_bytes() {
        // A byte slice through a multi-byte codepoint panics; the bead body is user text.
        let s = "é".repeat(10);
        assert_eq!(excerpt(&s, 4), format!("{}…", "é".repeat(4)));
        assert_eq!(excerpt("short", 40), "short");
    }

    // ── THE SOURCE GUARD ─────────────────────────────────────────────────────────────────────
    //
    // Asserted against the OTHER MODULES' SOURCE, in the style of `notes.rs`'s
    // `no_bd_invocation_in_this_module_is_unbounded`, because the defect this catches is an
    // ABSENCE: a fourth create path (or a refactor of one of these three) that never calls the
    // fold. No behavioural test can see that — the unguarded path works perfectly, it just files a
    // duplicate — so the only place it is visible is the text of the function itself.

    /// The three functions that actually issue `bd create` in this app, by module and name. Every
    /// one of the ~12 TS/MCP create paths crosses the bridge into exactly one of them.
    const CREATE_SITES: [(&str, &str); 3] = [
        ("notes.rs", "create_bead_inner"),
        ("notes.rs", "create_bead_full_inner"),
        ("beads_cmd.rs", "create_bead"),
    ];

    fn module_source(module: &str) -> &'static str {
        match module {
            "notes.rs" => include_str!("notes.rs"),
            "beads_cmd.rs" => include_str!("beads_cmd.rs"),
            other => panic!("unknown module {other}"),
        }
    }

    /// Everything before the `#[cfg(test)]` module. A test function of the same name must not be
    /// able to satisfy the guard on the production function's behalf.
    fn production_source(module: &str) -> &'static str {
        let src = module_source(module);
        let cut = src.find("\n#[cfg(test)]").map(|i| &src[..i]).unwrap_or(src);
        assert!(cut.len() < src.len(), "{module}: no test-module marker, so the scan region is wrong");
        cut
    }

    /// The text of a top-level `fn <name>`, with whole-line comments stripped.
    ///
    /// Comment stripping is not decoration: without it a doc line MENTIONING `fold_or_create` would
    /// satisfy the guard while the call underneath had been deleted — the exact vacuous shape this
    /// repo keeps hitting. The declaration is anchored on the whole LINE, so only visibility/async
    /// modifiers may precede it and a helper whose name merely CONTAINS the target (`create_bead`
    /// inside `create_bead_full`) cannot capture the slice.
    fn fn_body(src: &str, name: &str) -> Option<String> {
        let sig = format!("fn {name}(");
        let mut from = 0usize;
        while let Some(i) = src[from..].find(&sig) {
            let abs = from + i;
            let line_start = src[..abs].rfind('\n').map(|n| n + 1).unwrap_or(0);
            let prefix = src[line_start..abs].trim();
            let declaration = prefix.is_empty()
                || prefix.split_whitespace().all(|w| {
                    w == "pub" || w == "async" || w == "unsafe" || w.starts_with("pub(")
                });
            if declaration {
                let rest = &src[line_start..];
                // Top-level fn bodies close on a column-0 brace (rustfmt guarantees it).
                let end = rest.find("\n}")? + 2;
                return Some(
                    rest[..end]
                        .lines()
                        .filter(|l| !l.trim_start().starts_with("//"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
            }
            from = abs + sig.len();
        }
        None
    }

    /// EVERY create path must consult the fold. This is what stops a fourth one shipping unguarded.
    #[test]
    fn every_bd_create_site_calls_fold_or_create() {
        for (module, name) in CREATE_SITES {
            let body = fn_body(production_source(module), name)
                .unwrap_or_else(|| panic!("{module}: no top-level `fn {name}` — was it renamed?"));
            // POSITIVE assertion on the body first: an empty/misparsed slice must FAIL rather than
            // vacuously satisfy the `contains` below.
            assert!(
                body.contains("bd create") || body.contains("build_create") || body.contains("\"create\""),
                "{module}::{name} no longer looks like a create path — the guard is pointed at the \
                 wrong function:\n{body}"
            );
            assert!(
                body.contains("fold_or_create("),
                "{module}::{name} issues `bd create` WITHOUT calling `bead_dup::fold_or_create` — \
                 an unguarded create path files a duplicate every time:\n{body}"
            );
        }
    }

    /// The async Tauri commands must delegate to the guarded cores rather than growing a second,
    /// unguarded body of their own — the extraction is what makes the guard reachable at all.
    #[test]
    fn the_tauri_create_commands_delegate_to_the_guarded_cores() {
        let src = production_source("notes.rs");
        for (command, core) in
            [("create_bead", "create_bead_inner("), ("create_bead_full", "create_bead_full_inner(")]
        {
            let body = fn_body(src, command)
                .unwrap_or_else(|| panic!("no top-level `fn {command}`"));
            assert!(body.contains(core), "{command} must delegate to {core}:\n{body}");
        }
    }

    /// The guard is only meaningful if its parser can actually SEE a missing call. Feeds the REAL
    /// parser the shape it must reject, so a green guard means "every site is wired" rather than
    /// "the parser matched nothing".
    #[test]
    fn the_source_guard_would_notice_an_unguarded_create_path() {
        let regressed = "/// a doc line mentioning fold_or_create( which must NOT count\n\
                         fn create_bead_inner(p: &str) -> R {\n\
                         \x20   let args = build_create_args(p);\n\
                         \x20   run_bd(p, &args)\n\
                         }\n";
        let body = fn_body(regressed, "create_bead_inner").expect("parser finds the fn");
        assert!(
            !body.contains("fold_or_create("),
            "the comment must be stripped, or a deleted call still reads as present:\n{body}"
        );

        // …and the guarded shape must still be recognised, or the guard could never go green.
        let guarded = "pub(crate) async fn create_bead_inner(p: &str) -> R {\n\
                       \x20   if let Some(row) = crate::bead_dup::fold_or_create(p) { return Ok(row); }\n\
                       \x20   run_bd(p, &[\"create\"])\n\
                       }\n";
        let body = fn_body(guarded, "create_bead_inner").expect("parser handles pub(crate) async");
        assert!(body.contains("fold_or_create("), "{body}");

        // A helper whose name merely CONTAINS the target must not capture the slice.
        let sibling = "fn create_bead_full_inner(p: &str) -> R {\n\
                       \x20   fold_or_create(p)\n\
                       }\n\
                       fn create_bead_inner(p: &str) -> R {\n\
                       \x20   run_bd(p)\n\
                       }\n";
        let body = fn_body(sibling, "create_bead_inner").expect("parser finds the exact fn");
        assert!(
            !body.contains("fold_or_create("),
            "matched the SIBLING's body, so the guard would pass on the wrong function:\n{body}"
        );
    }
}

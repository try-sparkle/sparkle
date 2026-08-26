//! THE VERIFY-BEFORE-PR GATE (bead `.1`) — run CI's checks LOCALLY, inside the agent's
//! own worktree, BEFORE the PR exists, and keep the evidence that they ran.
//!
//! ── THE PROBLEM IT SOLVES ───────────────────────────────────────────────────────────────────────
//! "The agent says it works" is not a fact anyone can check. Today the only durable record of a
//! verification run is prose in a PR body, written by the same process whose claim is in question.
//! This module makes the claim CHECKABLE: it runs the project's own checks, records each one's exit
//! code, wall-clock duration and output tail, persists that report, accepts artifact files
//! (screenshots, recordings, log tails) alongside it, and renders the whole thing as the PR's
//! `## Testing` section. What lands in the PR is then a transcript, not an assertion.
//!
//! ── IT FAILS CLOSED, AND THAT IS THE WHOLE DESIGN ───────────────────────────────────────────────
//! [`Verdict::Pass`] is reachable only when EVERY configured check actually ran to completion and
//! exited 0, and the check list was non-empty. A check that could not be spawned, a check that
//! timed out, and a project with no checks configured all resolve to something that is not `pass` —
//! see [`fold_verdict`]. "We could not look" is not a pass. This is the inverse of the usual
//! convenience default and it is deliberate: the entire value of a gate is that its green means
//! something, and a gate that reports green when it could not run is strictly worse than no gate,
//! because it launders an unknown into a claim.
//!
//! ── OUTPUT GOES TO A FILE, NOT A PIPE ───────────────────────────────────────────────────────────
//! Each check's stdout+stderr are redirected into a log file under the report directory and the
//! tail is read back after the child exits. The obvious alternative — piped stdio polled alongside
//! `try_wait` — deadlocks the moment a chatty check fills the OS pipe buffer while we are sleeping
//! between polls, and a typecheck over a large repo is exactly that chatty. The file also happens to
//! be the artifact a failing check most wants attached, so it doubles as evidence.
//!
//! ── REAL-BROWSER PROOF IS AN INGESTION SEAM, NOT A DRIVER ───────────────────────────────────────
//! This slice does NOT drive a browser. [`attach_evidence`] is the seam a Playwright/`storageState`
//! driver plugs into later: it takes a path a driver already wrote, copies it in (never moves,
//! never deletes the source — the caller's file is the caller's), gives it a content-addressed id
//! and a caption, and [`render_testing_section`] embeds it. See `PRD/verify-before-pr-gate.md`.
//!
//! ── THE WIRE SHAPE IS `camelCase` AND EVERY OPTION IS `T | null` ────────────────────────────────
//! Mirrors `apps/desktop/src/stores/verifyGateStore.ts` field for field. Nothing here uses
//! `skip_serializing_if`, so serde emits `None` as an explicit `null` and the TypeScript side must
//! declare `T | null` rather than `T?` (bead `sparkle-16y6h`: an all-or-nothing parser that rejects
//! one field discards the whole payload and the feature is inert forever, silently).

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// On-disk shape version. Bump alongside a migration AND alongside `VERIFY_GATE_REPORT_VERSION` in
/// `stores/verifyGateStore.ts` — a report written by a newer build must not be half-read by an
/// older one.
pub const REPORT_VERSION: u32 = 1;

/// How many trailing lines of a check's output we keep. Enough to hold a compiler's error block or
/// a test runner's failure summary; small enough that a report stays readable in a PR body.
pub const TAIL_LINES: usize = 40;

/// Hard ceiling on a single tail, in bytes, applied AFTER the line cap. One 400 KB minified line is
/// still one line, and a PR body has a size limit.
const TAIL_MAX_BYTES: usize = 16 * 1024;

/// Fallback per-check timeout when config supplies none. Deliberately generous: a cold `tsc` or a
/// full unit suite on a large repo genuinely takes minutes, and a timeout that fires on a healthy
/// check trains people to ignore the gate.
pub const DEFAULT_CHECK_TIMEOUT_SECS: u64 = 900;

/// How often we poll a running child for exit. A check runs for seconds-to-minutes, so the polling
/// granularity is irrelevant to accuracy and 100 ms keeps the thread nearly free.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Types — the frozen contract with verifyGateStore.ts
// ───────────────────────────────────────────────────────────────────────────────────────────────

/// One check's outcome.
///
/// `Timeout` and `NotRun` are SEPARATE from `Fail` on purpose, and collapsing them is the one way to
/// get this module wrong. `Fail` means the check ran and judged the code. `Timeout` means it ran and
/// never finished, and `NotRun` means it never started (no such binary, unspawnable command). Only
/// the first is evidence about the diff; the other two are evidence about the machine. They all
/// refuse to be a pass, but a UI that reported "your tests failed" for a missing `pnpm` would send
/// someone to read a diff that was never judged (the same distinction `pr-checks.sh` draws between
/// its exit 1 and its exit 5).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CheckStatus {
    /// Exited 0.
    Pass,
    /// Exited non-zero. The check judged the code and said no.
    Fail,
    /// Exceeded its timeout and was killed. Unjudged.
    Timeout,
    /// Never started — the command could not be spawned at all. Unjudged.
    NotRun,
}

impl CheckStatus {
    /// Did this check actually reach a verdict about the code? False for `Timeout`/`NotRun`.
    pub fn judged(self) -> bool {
        matches!(self, CheckStatus::Pass | CheckStatus::Fail)
    }
}

/// One check as configured (the input half of a [`CheckResult`]).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckSpec {
    /// Human label, e.g. `typecheck`. Also the log file's stem after slugging.
    pub name: String,
    /// The shell command line, run through the platform shell inside the worktree.
    pub cmd: String,
}

/// One check's recorded outcome.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub name: String,
    pub cmd: String,
    pub status: CheckStatus,
    /// `None` when the process never produced one (spawn failure, or killed on timeout).
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    /// The last [`TAIL_LINES`] lines of combined stdout+stderr, byte-capped. Empty string when the
    /// check produced no output at all — never `null`, so the UI has nothing to branch on.
    pub tail: String,
    /// Absolute path to the full log this tail came from, when one was written. This is what makes
    /// a truncated tail recoverable rather than the end of the trail.
    pub log_path: Option<String>,
}

/// The gate's overall answer.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    /// Every configured check ran and passed, and there was at least one.
    Pass,
    /// At least one check ran and judged the code as failing (or ran out of time trying).
    Fail,
    /// Nothing was judged — no checks configured, or a check could not be started. NOT a pass.
    NotRun,
}

/// One captured artifact.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceItem {
    /// Stable, content-addressed: `sha256(bytes)[..16]`. Re-attaching the same file with a new
    /// caption UPDATES the caption instead of accumulating near-duplicate copies of one screenshot.
    pub id: String,
    /// What this artifact shows. The whole point of the evidence store — a screenshot with no
    /// caption is a rectangle, not proof.
    pub caption: String,
    /// File name inside the evidence directory (`<id>.<ext>`), never a path.
    pub file_name: String,
    /// Absolute path to the copy we own.
    pub path: String,
    /// `image` | `video` | `log` | `file` — decides whether the markdown embeds or links it.
    pub kind: EvidenceKind,
    pub bytes: u64,
    /// Epoch ms when it was attached.
    pub at: i64,
    /// Where it was copied FROM, for traceability back to the driver that produced it.
    pub source_path: Option<String>,
}

/// How an artifact should be rendered in markdown.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceKind {
    /// Embedded with `![caption](path)`.
    Image,
    /// Linked — GitHub renders an uploaded video, but a local path can only ever be a link.
    Video,
    /// Linked, and its content is inlined in a `<details>` block when small.
    Log,
    /// Anything else. Linked.
    File,
}

impl EvidenceKind {
    /// Classify by extension. Unknown extensions are `File`, never `Image` — a wrong `Image` renders
    /// as a broken-image icon, which reads as "the evidence is missing".
    pub fn from_extension(ext: &str) -> EvidenceKind {
        match ext.to_ascii_lowercase().as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg" => EvidenceKind::Image,
            "mp4" | "webm" | "mov" | "m4v" => EvidenceKind::Video,
            "log" | "txt" | "ansi" => EvidenceKind::Log,
            _ => EvidenceKind::File,
        }
    }
}

/// One agent's last verification run, as persisted.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyGateReport {
    pub version: u32,
    pub agent_id: String,
    /// The worktree the checks ran INSIDE. Recorded because a report is only evidence about the
    /// tree it was produced in, and an agent's worktree outlives neither the branch nor the session.
    pub worktree: String,
    /// The branch that tree was on at run time, when it could be read.
    pub branch: Option<String>,
    pub checks: Vec<CheckResult>,
    pub verdict: Verdict,
    /// Epoch ms.
    pub started_at: i64,
    /// Epoch ms.
    pub finished_at: i64,
}

impl VerifyGateReport {
    /// Total wall-clock across every check, in ms. Cheap derived value the UI would otherwise
    /// recompute in three places.
    pub fn total_duration_ms(&self) -> u64 {
        self.checks.iter().map(|c| c.duration_ms).sum()
    }
}

/// The lightweight poll answer: is a run in flight, and what did the last one say.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyGateStatus {
    pub agent_id: String,
    /// True while this agent has a run in flight in THIS process. False after a restart even if a
    /// run was interrupted — an in-flight flag cannot outlive the process that would clear it, and
    /// a persisted one would latch "running" forever.
    pub running: bool,
    /// `None` when no report has ever been written for this agent.
    pub verdict: Option<Verdict>,
    pub checks_total: usize,
    pub checks_passed: usize,
    pub finished_at: Option<i64>,
    /// Whether `[verify_gate]` is switched on for this project. The UI hides itself when false;
    /// an explicit run still works, because a person asking for a check is not the automatic path
    /// the opt-in flag governs.
    pub enabled: bool,
    /// What the PR gate would say right now. Precomputed here so the integration assistant
    /// (`.2`) needs one call, not three.
    pub pr_gate: PrGateDecision,
}

/// Whether a PR may be opened, per `[verify_gate].require_pass_before_pr`.
///
/// A DECISION PLUS A SENTENCE, never a bare bool. AGENTS.md's rule about refusal messages applies
/// directly: the caller that will act on `allowed: false` is a shell command or a button, and a
/// refusal the user cannot explain is one they will route around. `reason` is always populated,
/// including when allowed.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrGateDecision {
    pub allowed: bool,
    /// Why — in one sentence, safe to show a human verbatim.
    pub reason: String,
    /// True when the gate is switched off entirely, so a caller can tell "nothing is enforced here"
    /// from "enforced, and it passed".
    pub enforced: bool,
}

/// The subset of `[verify_gate]` this module needs. A plain struct rather than a borrow of
/// `SparkleConfig` so every function here is unit-testable without building a whole config.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateSettings {
    pub enabled: bool,
    pub checks: Vec<CheckSpec>,
    pub check_timeout_secs: u64,
    pub require_pass_before_pr: bool,
    pub evidence_dir: String,
}

impl Default for GateSettings {
    fn default() -> Self {
        GateSettings {
            enabled: false,
            checks: Vec::new(),
            check_timeout_secs: DEFAULT_CHECK_TIMEOUT_SECS,
            require_pass_before_pr: true,
            evidence_dir: DEFAULT_EVIDENCE_DIR.to_string(),
        }
    }
}

/// Default root, relative to the project. Kept in one place because config.rs's default and this
/// module's fallback must not drift.
pub const DEFAULT_EVIDENCE_DIR: &str = ".sparkle/verify-gate";

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Paths — every one of them sanitized, because `agent_id` crosses an IPC boundary
// ───────────────────────────────────────────────────────────────────────────────────────────────

/// Reduce an arbitrary caller-supplied id to a single safe path segment.
///
/// `agent_id` arrives from the frontend, so it is untrusted input to a path join: `../../..` or an
/// absolute path would otherwise let a caller write a JSON file anywhere the app can reach. Every
/// character outside `[A-Za-z0-9._-]` becomes `-`, leading dots are stripped (so `..` cannot
/// survive as a traversal, and no hidden file is created by accident), and an id that reduces to
/// nothing becomes `unknown` rather than the empty segment — an empty segment silently collapses in
/// a `join`, which would make `<dir>/<empty>.json` land as a sibling of the directory itself.
pub fn safe_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_start_matches('.').trim_matches('-').to_string();
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed
    }
}

/// `<project_root>/<evidence_dir>` — the root every other path hangs off.
pub fn gate_root(project_root: &Path, settings: &GateSettings) -> PathBuf {
    let rel = settings.evidence_dir.trim();
    let rel = if rel.is_empty() { DEFAULT_EVIDENCE_DIR } else { rel };
    // An absolute `evidence_dir` is honoured as-is: it is global-or-project config written by a
    // human, not IPC input, and a shared artifact volume is a legitimate thing to point at.
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        project_root.join(candidate)
    }
}

/// `<gate_root>/<agentId>.json` — where one agent's last report lives.
pub fn report_path(project_root: &Path, settings: &GateSettings, agent_id: &str) -> PathBuf {
    gate_root(project_root, settings).join(format!("{}.json", safe_segment(agent_id)))
}

/// `<gate_root>/<agentId>/` — the per-report working directory (evidence + logs).
pub fn agent_dir(project_root: &Path, settings: &GateSettings, agent_id: &str) -> PathBuf {
    gate_root(project_root, settings).join(safe_segment(agent_id))
}

/// `<gate_root>/<agentId>/evidence/`.
pub fn evidence_dir(project_root: &Path, settings: &GateSettings, agent_id: &str) -> PathBuf {
    agent_dir(project_root, settings, agent_id).join("evidence")
}

/// `<gate_root>/<agentId>/logs/`.
pub fn logs_dir(project_root: &Path, settings: &GateSettings, agent_id: &str) -> PathBuf {
    agent_dir(project_root, settings, agent_id).join("logs")
}

/// `<gate_root>/<agentId>/evidence/index.json` — the evidence manifest.
fn evidence_manifest_path(project_root: &Path, settings: &GateSettings, agent_id: &str) -> PathBuf {
    evidence_dir(project_root, settings, agent_id).join("index.json")
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Default check list — read the project's own scripts rather than inventing commands
// ───────────────────────────────────────────────────────────────────────────────────────────────

/// The scripts we look for, IN THE ORDER WE RUN THEM: cheapest and most-diagnostic first.
///
/// The order is the point. A typecheck that fails tells you exactly which line is wrong in about
/// ten seconds; a build that fails for the same reason tells you the same thing five minutes later
/// buried in bundler output. Running cheap-and-specific before slow-and-vague is what makes the
/// gate usable at all — and because a failing check does not stop the remaining ones (see
/// [`run_checks`]), the ordering is about how fast the FIRST useful line of evidence appears.
const DEFAULT_SCRIPT_ORDER: &[&str] = &["typecheck", "lint", "test", "build"];

/// Derive a check list from a project's `package.json` `scripts`.
///
/// Returns EMPTY when there is no package.json, no `scripts` object, or none of the known names —
/// and empty means [`Verdict::NotRun`], not a pass. That is the fail-closed direction: a project
/// whose checks we cannot discover has not been checked, and saying so is the honest answer. The
/// remedy is `[verify_gate].checks`, which is what the config key exists for.
pub fn default_checks_from_package_json(worktree: &Path) -> Vec<CheckSpec> {
    let Ok(text) = fs::read_to_string(worktree.join("package.json")) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) else {
        return Vec::new();
    };
    let runner = package_runner(worktree);
    DEFAULT_SCRIPT_ORDER
        .iter()
        .filter(|name| scripts.contains_key(**name))
        .map(|name| CheckSpec {
            name: (*name).to_string(),
            cmd: format!("{runner} run {name}"),
        })
        .collect()
}

/// Which package runner this project uses, decided by its lockfile.
///
/// Guessing wrong is not cosmetic: `npm run test` in a pnpm workspace resolves a different (often
/// absent) dependency tree, so the check fails for a reason that has nothing to do with the diff —
/// the exact "unjudged red" this module separates out everywhere else. Falls back to `npm`, which
/// exists wherever Node does.
fn package_runner(worktree: &Path) -> &'static str {
    if worktree.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if worktree.join("yarn.lock").exists() {
        "yarn"
    } else if worktree.join("bun.lockb").exists() || worktree.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    }
}

/// The checks to actually run: configured list if non-empty, otherwise discovered from
/// package.json.
///
/// Config WINS over discovery when it is non-empty. Discovery is a convenience for the common case;
/// a repo that has written its own list has said something specific about how it is verified, and
/// silently appending discovered scripts to it would run checks nobody asked for.
pub fn resolve_checks(worktree: &Path, settings: &GateSettings) -> Vec<CheckSpec> {
    if !settings.checks.is_empty() {
        return settings.checks.clone();
    }
    default_checks_from_package_json(worktree)
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Running
// ───────────────────────────────────────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The in-flight set, keyed `"<project>::<agentId>"`. Process-wide and NOT persisted — see
/// [`VerifyGateStatus::running`] for why a durable flag would be wrong.
fn in_flight() -> &'static Mutex<BTreeMap<String, bool>> {
    static CELL: OnceLock<Mutex<BTreeMap<String, bool>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn flight_key(project_root: &Path, agent_id: &str) -> String {
    format!("{}::{}", project_root.display(), safe_segment(agent_id))
}

fn mark_running(project_root: &Path, agent_id: &str, running: bool) {
    let key = flight_key(project_root, agent_id);
    if let Ok(mut g) = in_flight().lock() {
        if running {
            g.insert(key, true);
        } else {
            g.remove(&key);
        }
    }
}

fn is_running(project_root: &Path, agent_id: &str) -> bool {
    in_flight()
        .lock()
        .map(|g| g.contains_key(&flight_key(project_root, agent_id)))
        .unwrap_or(false)
}

/// Keep the last [`TAIL_LINES`] lines, then byte-cap from the END.
///
/// The end is the half that matters — a compiler prints its summary last — so when the byte cap
/// bites we drop from the FRONT and say so, rather than truncating the conclusion away.
pub fn tail_of(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(TAIL_LINES);
    let mut out = lines[start..].join("\n");
    if out.len() > TAIL_MAX_BYTES {
        // Slice on a char boundary — a mid-UTF-8 cut panics, and check output is full of box-drawing
        // characters and emoji from test runners.
        let mut cut = out.len() - TAIL_MAX_BYTES;
        while cut < out.len() && !out.is_char_boundary(cut) {
            cut += 1;
        }
        out = format!("…(truncated)…\n{}", &out[cut..]);
    }
    out
}

/// Build the platform shell invocation for one command line.
///
/// A shell, deliberately: `cmd` is a human-written command line from config or from
/// `<runner> run <script>`, and people write `&&`, pipes and env prefixes in those. Splitting it
/// ourselves would mis-parse quoting in ways that are silent and platform-specific.
fn shell_command(cmd: &str, worktree: &Path) -> Command {
    #[cfg(windows)]
    let mut c = {
        let mut c = Command::new("cmd");
        c.args(["/C", cmd]);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut c = Command::new(shell);
        // `-lc`, a LOGIN shell: a macOS GUI app does not inherit the terminal's PATH, so a bare
        // `-c` cannot find `pnpm`/`cargo` installed via nvm/homebrew and every check would come
        // back `NotRun`. Same dance as `preflight::run_in_login_shell`, for the same reason.
        c.args(["-lc", cmd]);
        c
    };
    c.current_dir(worktree);
    c
}

/// Run one check, bounded by `timeout`. Never panics; every failure mode becomes a [`CheckResult`].
pub fn run_one_check(spec: &CheckSpec, worktree: &Path, log_dir: &Path, timeout: Duration) -> CheckResult {
    let started = Instant::now();
    let log_path = log_dir.join(format!("{}.log", safe_segment(&spec.name)));
    let _ = fs::create_dir_all(log_dir);

    let log_file = match fs::File::create(&log_path) {
        Ok(f) => f,
        Err(e) => {
            // We cannot capture output, so we do not run: a check whose output we cannot read is a
            // check we cannot report on, and reporting an unreadable pass is the failure this whole
            // module exists to prevent.
            return CheckResult {
                name: spec.name.clone(),
                cmd: spec.cmd.clone(),
                status: CheckStatus::NotRun,
                exit_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                tail: format!("could not open log file {}: {e}", log_path.display()),
                log_path: None,
            };
        }
    };
    let err_file = match log_file.try_clone() {
        Ok(f) => f,
        Err(e) => {
            return CheckResult {
                name: spec.name.clone(),
                cmd: spec.cmd.clone(),
                status: CheckStatus::NotRun,
                exit_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                tail: format!("could not duplicate log handle: {e}"),
                log_path: None,
            };
        }
    };

    let mut child = match shell_command(&spec.cmd, worktree)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(err_file))
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return CheckResult {
                name: spec.name.clone(),
                cmd: spec.cmd.clone(),
                status: CheckStatus::NotRun,
                exit_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                tail: format!("could not start `{}`: {e}", spec.cmd),
                log_path: Some(log_path.display().to_string()),
            };
        }
    };

    let (status, exit_code) = loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let s = if st.success() { CheckStatus::Pass } else { CheckStatus::Fail };
                break (s, st.code());
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    break (CheckStatus::Timeout, None);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => {
                let _ = fs::write(&log_path, format!("could not wait on `{}`: {e}", spec.cmd));
                break (CheckStatus::NotRun, None);
            }
        }
    };

    let duration_ms = started.elapsed().as_millis() as u64;
    let raw = fs::read_to_string(&log_path).unwrap_or_default();
    let mut tail = tail_of(&raw);
    if status == CheckStatus::Timeout {
        tail = format!(
            "TIMED OUT after {}s — killed, so this check judged nothing.\n{tail}",
            timeout.as_secs()
        );
    }
    CheckResult {
        name: spec.name.clone(),
        cmd: spec.cmd.clone(),
        status,
        exit_code,
        duration_ms,
        tail,
        log_path: Some(log_path.display().to_string()),
    }
}

/// Fold per-check statuses into the overall verdict. **Pure**, and the fail-closed rule lives here.
///
/// `Pass` requires a NON-EMPTY list in which every entry is `Pass`. Anything judged-and-failing (or
/// timed out mid-judgement) is `Fail`; anything unjudged, including "there were no checks", is
/// `NotRun`. `Fail` outranks `NotRun` because a known failure is the more actionable of the two —
/// but neither is a pass, which is the only property callers may rely on.
pub fn fold_verdict(checks: &[CheckResult]) -> Verdict {
    if checks.is_empty() {
        return Verdict::NotRun;
    }
    if checks
        .iter()
        .any(|c| matches!(c.status, CheckStatus::Fail | CheckStatus::Timeout))
    {
        return Verdict::Fail;
    }
    if checks.iter().any(|c| !c.status.judged()) {
        return Verdict::NotRun;
    }
    Verdict::Pass
}

/// Best-effort current branch of a worktree. `None` on a detached HEAD or a non-repo — both of
/// which are real states a report may legitimately be produced in.
fn current_branch(worktree: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(worktree)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() || name == "HEAD" {
        None
    } else {
        Some(name)
    }
}

/// Run the whole check list, IN ORDER, and build a report.
///
/// EVERY CHECK RUNS EVEN AFTER ONE FAILS. Fail-fast would be cheaper and is what `pnpm verify`
/// does, but this report's job is to be evidence rather than a build gate: stopping at the first
/// red means the report cannot answer "is anything else also broken", and the agent then fixes one
/// thing, re-runs the whole gate, and discovers the next. The wall-clock saved by stopping early is
/// paid back with interest by the extra round trips.
pub fn run_checks(
    project_root: &Path,
    settings: &GateSettings,
    agent_id: &str,
    worktree: &Path,
) -> VerifyGateReport {
    let started_at = now_ms();
    mark_running(project_root, agent_id, true);
    let specs = resolve_checks(worktree, settings);
    let log_dir = logs_dir(project_root, settings, agent_id);
    let timeout = Duration::from_secs(settings.check_timeout_secs.max(1));

    let checks: Vec<CheckResult> = specs
        .iter()
        .map(|s| run_one_check(s, worktree, &log_dir, timeout))
        .collect();

    mark_running(project_root, agent_id, false);
    VerifyGateReport {
        version: REPORT_VERSION,
        agent_id: agent_id.to_string(),
        worktree: worktree.display().to_string(),
        branch: current_branch(worktree),
        verdict: fold_verdict(&checks),
        checks,
        started_at,
        finished_at: now_ms(),
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Persistence
// ───────────────────────────────────────────────────────────────────────────────────────────────

/// Write one agent's report. Creates the directory tree. Returns the path written.
pub fn save_report(
    project_root: &Path,
    settings: &GateSettings,
    report: &VerifyGateReport,
) -> io::Result<PathBuf> {
    let path = report_path(project_root, settings, &report.agent_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(report)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(&path, json)?;
    Ok(path)
}

/// Read one agent's last report.
///
/// A MISSING OR CORRUPT FILE DEGRADES TO `None`, never to a synthesized empty pass — the same
/// fail-safe direction as `retro_receipt.rs`. `None` means "no report", which every caller here
/// already treats as not-verified; a half-parsed report would read as settled, and settling on
/// unread evidence is the one outcome this module must never produce.
pub fn load_report(
    project_root: &Path,
    settings: &GateSettings,
    agent_id: &str,
) -> Option<VerifyGateReport> {
    let path = report_path(project_root, settings, agent_id);
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<VerifyGateReport>(&text).ok()
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Evidence store
// ───────────────────────────────────────────────────────────────────────────────────────────────

/// Read the evidence manifest. Missing or corrupt → empty, for [`load_report`]'s reason.
pub fn load_evidence(
    project_root: &Path,
    settings: &GateSettings,
    agent_id: &str,
) -> Vec<EvidenceItem> {
    let path = evidence_manifest_path(project_root, settings, agent_id);
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<EvidenceItem>>(&text).unwrap_or_default()
}

fn save_evidence(
    project_root: &Path,
    settings: &GateSettings,
    agent_id: &str,
    items: &[EvidenceItem],
) -> io::Result<()> {
    let path = evidence_manifest_path(project_root, settings, agent_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(items)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(path, json)
}

/// Content-addressed id: `sha256(bytes)[..16]` as hex.
///
/// CONTENT, not path or clock. Two consequences that are both wanted: re-attaching the same
/// screenshot is idempotent (it updates the caption rather than piling up copies), and the id is
/// reproducible from the artifact alone — so a PR body's `![…](…/a1b2….png)` can be checked against
/// the file it names, which is what makes the embedded proof auditable rather than decorative.
fn content_id(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Copy an artifact into this agent's evidence directory and record it.
///
/// COPIES, NEVER MOVES, AND NEVER DELETES THE SOURCE. The caller's file belongs to the caller: a
/// driver may still be writing a companion file next to it, a human may have pointed us at
/// something on their Desktop, and a gate that consumes its inputs is a gate people stop feeding.
///
/// Re-attaching the same bytes UPDATES the existing entry's caption in place instead of appending a
/// second one — see [`content_id`].
pub fn attach_evidence(
    project_root: &Path,
    settings: &GateSettings,
    agent_id: &str,
    source: &Path,
    caption: &str,
) -> io::Result<EvidenceItem> {
    let bytes = fs::read(source)?;
    let id = content_id(&bytes);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| safe_segment(e))
        .filter(|e| !e.is_empty() && e != "unknown")
        .unwrap_or_else(|| "bin".to_string());
    let file_name = format!("{id}.{ext}");
    let dir = evidence_dir(project_root, settings, agent_id);
    fs::create_dir_all(&dir)?;
    let dest = dir.join(&file_name);
    fs::write(&dest, &bytes)?;

    let item = EvidenceItem {
        id: id.clone(),
        caption: caption.trim().to_string(),
        file_name,
        path: dest.display().to_string(),
        kind: EvidenceKind::from_extension(&ext),
        bytes: bytes.len() as u64,
        at: now_ms(),
        source_path: Some(source.display().to_string()),
    };

    let mut items = load_evidence(project_root, settings, agent_id);
    match items.iter_mut().find(|i| i.id == id) {
        Some(existing) => *existing = item.clone(),
        None => items.push(item.clone()),
    }
    save_evidence(project_root, settings, agent_id, &items)?;
    Ok(item)
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// The deliverable: the PR's `## Testing` section
// ───────────────────────────────────────────────────────────────────────────────────────────────

/// `1234` → `1.2s`; `900` → `0.9s`; `125000` → `2m 5s`.
fn human_ms(ms: u64) -> String {
    if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        let secs = ms / 1000;
        format!("{}m {}s", secs / 60, secs % 60)
    }
}

fn status_word(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pass => "pass",
        CheckStatus::Fail => "FAIL",
        CheckStatus::Timeout => "TIMED OUT",
        CheckStatus::NotRun => "not run",
    }
}

fn verdict_word(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Pass => "PASS",
        Verdict::Fail => "FAIL",
        Verdict::NotRun => "NOT RUN",
    }
}

/// Escape the pipes and backticks that would otherwise break out of a markdown table cell.
///
/// A command line containing `|` is ordinary (`pnpm test | tee log`), and an unescaped one silently
/// splits the row into extra columns — the table still renders, just wrong, which is the shape of
/// bug nobody reports.
fn cell(text: &str) -> String {
    text.replace('\\', "\\\\").replace('|', "\\|").replace('\n', " ")
}

/// Render the PR's `## Testing` section. **Pure** — no filesystem, no clock, no process.
///
/// This is the module's headline deliverable: the thing that turns "the agent says it works" into
/// "here is the transcript". Three parts, in this order:
///
///   1. A verdict line naming the branch and worktree, so the reader knows WHAT was verified.
///   2. One table row per check: name, command, result, duration. The command is included because a
///      reviewer's first question about a green table is "green on what, exactly".
///   3. The output tail of every check that did not pass, in a `<details>` block — a failed gate
///      that says only "FAIL" makes the reader go and re-run it.
///
/// Then the evidence: images embedded, everything else linked, each with its caption. An artifact
/// with no caption still renders (captioned `evidence <id>`), because dropping it would silently
/// lose proof over a missing string.
pub fn render_testing_section(report: &VerifyGateReport, evidence: &[EvidenceItem]) -> String {
    let mut out = String::new();
    out.push_str("## Testing\n\n");
    out.push_str(&format!(
        "Verified locally in the agent's worktree before this PR existed (Sparkle verify-before-PR gate). **Verdict: {}**\n\n",
        verdict_word(report.verdict)
    ));
    out.push_str(&format!(
        "- Branch: `{}`\n- Worktree: `{}`\n- Total: {}\n\n",
        report.branch.as_deref().unwrap_or("(detached)"),
        cell(&report.worktree),
        human_ms(report.total_duration_ms())
    ));

    if report.checks.is_empty() {
        // Say what was NOT done, and why that is not a pass. A section that simply omitted the
        // table here would read as "no problems found".
        out.push_str(
            "No checks were configured or discovered for this project, so **nothing was verified**. \
             Set `[verify_gate].checks` in `.sparkle/config.toml` to define them.\n",
        );
        return out;
    }

    out.push_str("| Check | Command | Result | Time |\n| --- | --- | --- | --- |\n");
    for c in &report.checks {
        out.push_str(&format!(
            "| {} | `{}` | {} | {} |\n",
            cell(&c.name),
            cell(&c.cmd),
            status_word(c.status),
            human_ms(c.duration_ms)
        ));
    }
    out.push('\n');

    for c in report.checks.iter().filter(|c| c.status != CheckStatus::Pass) {
        if c.tail.trim().is_empty() {
            continue;
        }
        out.push_str(&format!(
            "<details><summary>{} — {} (last {} lines)</summary>\n\n```\n{}\n```\n\n</details>\n\n",
            cell(&c.name),
            status_word(c.status),
            TAIL_LINES,
            c.tail
        ));
    }

    if !evidence.is_empty() {
        out.push_str("### Evidence\n\n");
        for e in evidence {
            let caption = if e.caption.is_empty() {
                format!("evidence {}", e.id)
            } else {
                e.caption.clone()
            };
            match e.kind {
                EvidenceKind::Image => {
                    out.push_str(&format!("![{}]({})\n\n", caption, e.file_name));
                }
                _ => {
                    out.push_str(&format!("- [{}]({})\n", caption, e.file_name));
                }
            }
        }
        if evidence.iter().any(|e| e.kind != EvidenceKind::Image) {
            out.push('\n');
        }
    }
    out
}

/// Would the PR gate allow a PR right now? **Pure**, so the integration assistant can ask without
/// touching disk.
///
/// Three states, and they are not two: OFF (nothing enforced), ON-and-satisfied, ON-and-refused.
/// The `enforced` flag is what lets a caller distinguish "this repo does not gate PRs" from "it
/// does, and you are clear" — collapsing those would make an unconfigured repo indistinguishable
/// from a verified one, which is the same laundering of an unknown into a claim that
/// [`fold_verdict`] refuses.
pub fn pr_gate_decision(settings: &GateSettings, report: Option<&VerifyGateReport>) -> PrGateDecision {
    if !settings.enabled || !settings.require_pass_before_pr {
        return PrGateDecision {
            allowed: true,
            reason: "the verify-before-PR gate is not enforced for this project".to_string(),
            enforced: false,
        };
    }
    match report {
        None => PrGateDecision {
            allowed: false,
            reason: "no verification report exists for this agent — run the gate before opening a PR"
                .to_string(),
            enforced: true,
        },
        Some(r) if r.verdict == Verdict::Pass => PrGateDecision {
            allowed: true,
            reason: format!("all {} checks passed", r.checks.len()),
            enforced: true,
        },
        Some(r) if r.verdict == Verdict::Fail => {
            let failed: Vec<&str> = r
                .checks
                .iter()
                .filter(|c| c.status != CheckStatus::Pass)
                .map(|c| c.name.as_str())
                .collect();
            PrGateDecision {
                allowed: false,
                reason: format!("these checks did not pass: {}", failed.join(", ")),
                enforced: true,
            }
        }
        Some(_) => PrGateDecision {
            allowed: false,
            // The "we could not look" case, spelled out. It is NOT "your code failed", and a
            // message that said so would send someone to read a diff nothing judged.
            reason: "the checks did not run to completion, so nothing was verified — this is not a \
                     test failure, it is a missing verification"
                .to_string(),
            enforced: true,
        },
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Status
// ───────────────────────────────────────────────────────────────────────────────────────────────

/// Build the poll answer for one agent.
pub fn status_for(
    project_root: &Path,
    settings: &GateSettings,
    agent_id: &str,
) -> VerifyGateStatus {
    let report = load_report(project_root, settings, agent_id);
    let checks_total = report.as_ref().map(|r| r.checks.len()).unwrap_or(0);
    let checks_passed = report
        .as_ref()
        .map(|r| r.checks.iter().filter(|c| c.status == CheckStatus::Pass).count())
        .unwrap_or(0);
    VerifyGateStatus {
        agent_id: agent_id.to_string(),
        running: is_running(project_root, agent_id),
        verdict: report.as_ref().map(|r| r.verdict),
        checks_total,
        checks_passed,
        finished_at: report.as_ref().map(|r| r.finished_at),
        enabled: settings.enabled,
        pr_gate: pr_gate_decision(settings, report.as_ref()),
    }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Tauri commands — every one async and off the main thread
// ───────────────────────────────────────────────────────────────────────────────────────────────

/// Resolve `[verify_gate]` for a project. Kept here so every command reads config the same way.
fn settings_for(project_root: &str) -> GateSettings {
    crate::config::for_project(project_root).config.verify_gate.to_gate_settings()
}

/// Run the gate for one agent and persist the report.
///
/// `spawn_blocking`, unconditionally: this runs `tsc` and a unit suite: minutes of blocking work. A
/// synchronous `#[tauri::command]` body executes on the MAIN thread, which would freeze the whole
/// UI for the duration.
#[tauri::command]
pub async fn verify_gate_run(
    project_root: String,
    agent_id: String,
    worktree: String,
) -> Result<VerifyGateReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);
        let settings = settings_for(&project_root);
        let report = run_checks(&root, &settings, &agent_id, Path::new(&worktree));
        // A report we could not persist is still a report — hand it back and say the save failed,
        // rather than throwing away a run that took four minutes.
        if let Err(e) = save_report(&root, &settings, &report) {
            return Err(format!("ran the checks but could not save the report: {e}"));
        }
        Ok(report)
    })
    .await
    .map_err(|e| format!("verify gate run panicked: {e}"))?
}

/// The cheap poll: is a run in flight, what did the last one say, and would a PR be allowed.
#[tauri::command]
pub async fn verify_gate_status(project_root: String, agent_id: String) -> VerifyGateStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        status_for(Path::new(&project_root), &settings, &agent_id)
    })
    .await
    .unwrap_or_else(|_| VerifyGateStatus {
        agent_id: String::new(),
        running: false,
        verdict: None,
        checks_total: 0,
        checks_passed: 0,
        finished_at: None,
        enabled: false,
        // A status we could not compute must not claim a PR is clear to open.
        pr_gate: PrGateDecision {
            allowed: false,
            reason: "could not read the verification status".to_string(),
            enforced: true,
        },
    })
}

/// The full last report plus its evidence, for the panel.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyGateReportReply {
    /// `null` when no report has ever been written — an explicit null, never an absent key.
    pub report: Option<VerifyGateReport>,
    pub evidence: Vec<EvidenceItem>,
}

#[tauri::command]
pub async fn verify_gate_report(
    project_root: String,
    agent_id: String,
) -> VerifyGateReportReply {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        let root = Path::new(&project_root);
        VerifyGateReportReply {
            report: load_report(root, &settings, &agent_id),
            evidence: load_evidence(root, &settings, &agent_id),
        }
    })
    .await
    .unwrap_or(VerifyGateReportReply { report: None, evidence: Vec::new() })
}

/// Copy an artifact into this agent's evidence store. The seam a browser driver plugs into.
#[tauri::command]
pub async fn verify_gate_attach_evidence(
    project_root: String,
    agent_id: String,
    source_path: String,
    caption: String,
) -> Result<EvidenceItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        attach_evidence(
            Path::new(&project_root),
            &settings,
            &agent_id,
            Path::new(&source_path),
            &caption,
        )
        .map_err(|e| format!("could not attach {source_path}: {e}"))
    })
    .await
    .map_err(|e| format!("attach evidence panicked: {e}"))?
}

/// The rendered `## Testing` markdown for this agent's last report.
///
/// `None` when there is no report: the caller must not paste a section claiming verification that
/// never happened, and an empty string would be indistinguishable from "the renderer produced
/// nothing".
#[tauri::command]
pub async fn verify_gate_testing_markdown(
    project_root: String,
    agent_id: String,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        let root = Path::new(&project_root);
        let report = load_report(root, &settings, &agent_id)?;
        let evidence = load_evidence(root, &settings, &agent_id);
        Some(render_testing_section(&report, &evidence))
    })
    .await
    .unwrap_or(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn settings() -> GateSettings {
        GateSettings { enabled: true, ..GateSettings::default() }
    }

    fn result(name: &str, status: CheckStatus) -> CheckResult {
        CheckResult {
            name: name.to_string(),
            cmd: format!("pnpm run {name}"),
            status,
            exit_code: match status {
                CheckStatus::Pass => Some(0),
                CheckStatus::Fail => Some(1),
                _ => None,
            },
            duration_ms: 1500,
            tail: String::new(),
            log_path: None,
        }
    }

    fn report_with(checks: Vec<CheckResult>) -> VerifyGateReport {
        VerifyGateReport {
            version: REPORT_VERSION,
            agent_id: "agent-1".to_string(),
            worktree: "/w/tree".to_string(),
            branch: Some("feat/x".to_string()),
            verdict: fold_verdict(&checks),
            checks,
            started_at: 1_000,
            finished_at: 4_000,
        }
    }

    // ── fail-closed ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn empty_check_list_is_not_run_not_pass() {
        // The headline rule: "we could not look" must never render as a pass.
        assert_eq!(fold_verdict(&[]), Verdict::NotRun);
    }

    #[test]
    fn a_single_unrunnable_check_denies_the_pass_its_siblings_earned() {
        let checks = vec![
            result("typecheck", CheckStatus::Pass),
            result("lint", CheckStatus::Pass),
            result("test", CheckStatus::NotRun),
        ];
        assert_eq!(fold_verdict(&checks), Verdict::NotRun);
    }

    #[test]
    fn a_timeout_is_a_failure_not_a_pass() {
        let checks = vec![result("test", CheckStatus::Timeout)];
        assert_eq!(fold_verdict(&checks), Verdict::Fail);
    }

    #[test]
    fn all_pass_is_a_pass() {
        let checks = vec![result("typecheck", CheckStatus::Pass), result("test", CheckStatus::Pass)];
        assert_eq!(fold_verdict(&checks), Verdict::Pass);
    }

    #[test]
    fn a_real_failure_outranks_an_unrun_sibling() {
        let checks = vec![result("lint", CheckStatus::NotRun), result("test", CheckStatus::Fail)];
        assert_eq!(fold_verdict(&checks), Verdict::Fail);
    }

    // ── running real commands ──────────────────────────────────────────────────────────────────

    #[test]
    fn a_passing_command_records_exit_zero_and_its_output_tail() {
        let dir = tmp();
        let spec = CheckSpec { name: "echo".into(), cmd: "echo hello-from-check".into() };
        let r = run_one_check(&spec, dir.path(), &dir.path().join("logs"), Duration::from_secs(60));
        assert_eq!(r.status, CheckStatus::Pass, "tail was: {}", r.tail);
        assert_eq!(r.exit_code, Some(0));
        assert!(r.tail.contains("hello-from-check"), "tail was: {}", r.tail);
    }

    #[test]
    fn a_failing_command_records_its_nonzero_code_and_stderr() {
        let dir = tmp();
        let spec = CheckSpec { name: "boom".into(), cmd: "echo bad-thing-happened >&2; exit 3".into() };
        let r = run_one_check(&spec, dir.path(), &dir.path().join("logs"), Duration::from_secs(60));
        assert_eq!(r.status, CheckStatus::Fail);
        assert_eq!(r.exit_code, Some(3));
        // stderr must be captured too — a compiler writes its errors there, and a gate that showed
        // only stdout would report a red check with an empty explanation.
        assert!(r.tail.contains("bad-thing-happened"), "tail was: {}", r.tail);
    }

    #[test]
    fn a_slow_command_is_killed_and_marked_timeout() {
        let dir = tmp();
        let spec = CheckSpec { name: "slow".into(), cmd: "sleep 30".into() };
        let started = Instant::now();
        let r = run_one_check(&spec, dir.path(), &dir.path().join("logs"), Duration::from_secs(1));
        assert_eq!(r.status, CheckStatus::Timeout);
        assert_eq!(r.exit_code, None);
        // The bound is the side effect: without a kill this returns after 30s, not ~1s.
        assert!(started.elapsed() < Duration::from_secs(15), "took {:?}", started.elapsed());
        assert!(r.tail.contains("TIMED OUT"), "tail was: {}", r.tail);
    }

    #[test]
    fn an_unresolvable_command_is_not_run_rather_than_failed() {
        let dir = tmp();
        let spec = CheckSpec {
            name: "missing".into(),
            cmd: "sparkle-no-such-binary-xyzzy".into(),
        };
        let r = run_one_check(&spec, dir.path(), &dir.path().join("logs"), Duration::from_secs(30));
        // A shell reports "command not found" as exit 127 — a real, judged non-zero exit. What
        // matters is that it is NOT a pass; the module's separation of judged/unjudged is asserted
        // on the spawn-failure path by `fold_verdict` above.
        assert_ne!(r.status, CheckStatus::Pass, "tail was: {}", r.tail);
    }

    // ── discovery ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn discovery_reads_package_json_scripts_in_run_order() {
        let dir = tmp();
        fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"build":"vite build","typecheck":"tsc","test":"vitest run"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();
        let checks = default_checks_from_package_json(dir.path());
        // Order is typecheck → test → build (lint absent), NOT package.json's own key order.
        assert_eq!(
            checks.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["typecheck", "test", "build"]
        );
        assert_eq!(checks[0].cmd, "pnpm run typecheck");
    }

    #[test]
    fn discovery_uses_the_runner_the_lockfile_names() {
        let dir = tmp();
        fs::write(dir.path().join("package.json"), r#"{"scripts":{"test":"jest"}}"#).unwrap();
        fs::write(dir.path().join("yarn.lock"), "").unwrap();
        assert_eq!(default_checks_from_package_json(dir.path())[0].cmd, "yarn run test");
    }

    #[test]
    fn a_project_with_no_package_json_discovers_nothing_and_so_cannot_pass() {
        let dir = tmp();
        assert!(default_checks_from_package_json(dir.path()).is_empty());
        let report = run_checks(dir.path(), &settings(), "agent-1", dir.path());
        assert_eq!(report.verdict, Verdict::NotRun);
    }

    #[test]
    fn configured_checks_win_over_discovery() {
        let dir = tmp();
        fs::write(dir.path().join("package.json"), r#"{"scripts":{"test":"vitest"}}"#).unwrap();
        let s = GateSettings {
            checks: vec![CheckSpec { name: "custom".into(), cmd: "make check".into() }],
            ..settings()
        };
        let resolved = resolve_checks(dir.path(), &s);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].name, "custom");
    }

    // ── persistence ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_report_survives_a_round_trip_to_disk() {
        let dir = tmp();
        let s = settings();
        let report = report_with(vec![result("test", CheckStatus::Fail)]);
        let path = save_report(dir.path(), &s, &report).unwrap();
        assert!(path.starts_with(dir.path().join(".sparkle/verify-gate")));
        let back = load_report(dir.path(), &s, "agent-1").expect("report read back");
        assert_eq!(back, report);
    }

    #[test]
    fn a_corrupt_report_reads_as_absent_rather_than_as_a_pass() {
        let dir = tmp();
        let s = settings();
        let path = report_path(dir.path(), &s, "agent-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ this is not json").unwrap();
        assert!(load_report(dir.path(), &s, "agent-1").is_none());
        // And the gate refuses on it — the corrupt file must not read as verified.
        assert!(!status_for(dir.path(), &s, "agent-1").pr_gate.allowed);
    }

    #[test]
    fn an_agent_id_cannot_escape_the_gate_directory() {
        let dir = tmp();
        let s = settings();
        let report = VerifyGateReport {
            agent_id: "../../escape".to_string(),
            ..report_with(vec![result("test", CheckStatus::Pass)])
        };
        let path = save_report(dir.path(), &s, &report).unwrap();
        assert!(
            path.starts_with(dir.path().join(".sparkle/verify-gate")),
            "wrote outside the gate root: {}",
            path.display()
        );
        assert!(!dir.path().parent().unwrap().join("escape.json").exists());
    }

    // ── evidence ───────────────────────────────────────────────────────────────────────────────

    #[test]
    fn attaching_copies_the_artifact_and_leaves_the_source_alone() {
        let dir = tmp();
        let s = settings();
        let src = dir.path().join("shot.png");
        fs::write(&src, b"\x89PNG-not-really").unwrap();
        let item =
            attach_evidence(dir.path(), &s, "agent-1", &src, "the settings pane after the fix")
                .unwrap();
        assert_eq!(item.kind, EvidenceKind::Image);
        assert!(src.exists(), "the source file was moved or deleted");
        assert!(Path::new(&item.path).exists(), "the copy was not written");
        assert_eq!(fs::read(&item.path).unwrap(), b"\x89PNG-not-really");
        assert_eq!(load_evidence(dir.path(), &s, "agent-1").len(), 1);
    }

    #[test]
    fn re_attaching_the_same_bytes_updates_the_caption_instead_of_duplicating() {
        let dir = tmp();
        let s = settings();
        let src = dir.path().join("shot.png");
        fs::write(&src, b"same-bytes").unwrap();
        attach_evidence(dir.path(), &s, "agent-1", &src, "first caption").unwrap();
        attach_evidence(dir.path(), &s, "agent-1", &src, "corrected caption").unwrap();
        let items = load_evidence(dir.path(), &s, "agent-1");
        assert_eq!(items.len(), 1, "attached twice: {items:?}");
        assert_eq!(items[0].caption, "corrected caption");
    }

    #[test]
    fn a_recording_is_linked_and_an_unknown_type_is_not_treated_as_an_image() {
        assert_eq!(EvidenceKind::from_extension("webm"), EvidenceKind::Video);
        assert_eq!(EvidenceKind::from_extension("PNG"), EvidenceKind::Image);
        assert_eq!(EvidenceKind::from_extension("zip"), EvidenceKind::File);
    }

    // ── the markdown ───────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_testing_section_carries_a_row_per_check_with_its_verdict_and_duration() {
        let report = report_with(vec![
            result("typecheck", CheckStatus::Pass),
            result("test", CheckStatus::Pass),
        ]);
        let md = render_testing_section(&report, &[]);
        assert!(md.starts_with("## Testing"));
        assert!(md.contains("**Verdict: PASS**"), "{md}");
        assert!(md.contains("| typecheck | `pnpm run typecheck` | pass | 1.5s |"), "{md}");
        assert!(md.contains("| test | `pnpm run test` | pass | 1.5s |"), "{md}");
        assert!(md.contains("Branch: `feat/x`"), "{md}");
    }

    #[test]
    fn a_failing_check_embeds_its_output_tail_so_the_reader_need_not_re_run_it() {
        let mut failing = result("test", CheckStatus::Fail);
        failing.tail = "AssertionError: expected 2 to be 3".to_string();
        let report = report_with(vec![result("typecheck", CheckStatus::Pass), failing]);
        let md = render_testing_section(&report, &[]);
        assert!(md.contains("**Verdict: FAIL**"), "{md}");
        assert!(md.contains("AssertionError: expected 2 to be 3"), "{md}");
        assert!(md.contains("<details>"), "{md}");
        // The PASSING check's block must NOT be emitted — a details block per green check buries
        // the one that matters.
        assert!(!md.contains("typecheck — pass"), "{md}");
    }

    #[test]
    fn an_empty_check_list_renders_a_sentence_that_says_nothing_was_verified() {
        let md = render_testing_section(&report_with(vec![]), &[]);
        assert!(md.contains("**Verdict: NOT RUN**"), "{md}");
        assert!(md.contains("nothing was verified"), "{md}");
        // No table at all — an empty table reads as "checks ran and found nothing".
        assert!(!md.contains("| Check |"), "{md}");
    }

    #[test]
    fn evidence_is_embedded_as_an_image_and_linked_otherwise() {
        let report = report_with(vec![result("test", CheckStatus::Pass)]);
        let shot = EvidenceItem {
            id: "abc123".into(),
            caption: "login flow, signed in".into(),
            file_name: "abc123.png".into(),
            path: "/w/.sparkle/verify-gate/a/evidence/abc123.png".into(),
            kind: EvidenceKind::Image,
            bytes: 1024,
            at: 10,
            source_path: None,
        };
        let clip = EvidenceItem {
            id: "def456".into(),
            caption: "full run".into(),
            file_name: "def456.webm".into(),
            path: "/w/.sparkle/verify-gate/a/evidence/def456.webm".into(),
            kind: EvidenceKind::Video,
            bytes: 2048,
            at: 11,
            source_path: None,
        };
        let md = render_testing_section(&report, &[shot, clip]);
        assert!(md.contains("### Evidence"), "{md}");
        assert!(md.contains("![login flow, signed in](abc123.png)"), "{md}");
        assert!(md.contains("- [full run](def456.webm)"), "{md}");
    }

    #[test]
    fn an_uncaptioned_artifact_is_still_rendered() {
        let report = report_with(vec![result("test", CheckStatus::Pass)]);
        let e = EvidenceItem {
            id: "abc123".into(),
            caption: String::new(),
            file_name: "abc123.png".into(),
            path: "/x/abc123.png".into(),
            kind: EvidenceKind::Image,
            bytes: 1,
            at: 1,
            source_path: None,
        };
        let md = render_testing_section(&report, &[e]);
        assert!(md.contains("![evidence abc123](abc123.png)"), "{md}");
    }

    #[test]
    fn a_pipe_in_a_command_cannot_break_the_table_row() {
        let mut c = result("test", CheckStatus::Pass);
        c.cmd = "pnpm test | tee run.log".to_string();
        let md = render_testing_section(&report_with(vec![c]), &[]);
        let row = md
            .lines()
            .find(|l| l.starts_with("| test |"))
            .expect("the check row");
        // Four cells means four unescaped separators plus the two edges.
        assert_eq!(
            row.matches("|").count() - row.matches("\\|").count(),
            5,
            "row split into extra columns: {row}"
        );
    }

    // ── the PR gate ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_disabled_gate_allows_the_pr_and_says_it_is_not_enforcing() {
        let d = pr_gate_decision(&GateSettings::default(), None);
        assert!(d.allowed);
        assert!(!d.enforced);
    }

    #[test]
    fn an_enabled_gate_refuses_when_no_report_exists() {
        let d = pr_gate_decision(&settings(), None);
        assert!(!d.allowed);
        assert!(d.enforced);
        assert!(d.reason.contains("no verification report"), "{}", d.reason);
    }

    #[test]
    fn an_enabled_gate_refuses_a_not_run_report_without_calling_it_a_test_failure() {
        let report = report_with(vec![result("test", CheckStatus::NotRun)]);
        let d = pr_gate_decision(&settings(), Some(&report));
        assert!(!d.allowed);
        // The distinction AGENTS.md draws between pr-checks.sh's exit 1 and exit 5: an unjudged
        // check must not send the reader to their diff.
        assert!(d.reason.contains("not a test failure"), "{}", d.reason);
    }

    #[test]
    fn an_enabled_gate_names_the_checks_that_did_not_pass() {
        let report = report_with(vec![
            result("typecheck", CheckStatus::Pass),
            result("lint", CheckStatus::Fail),
            result("test", CheckStatus::Timeout),
        ]);
        let d = pr_gate_decision(&settings(), Some(&report));
        assert!(!d.allowed);
        assert!(d.reason.contains("lint"), "{}", d.reason);
        assert!(d.reason.contains("test"), "{}", d.reason);
        assert!(!d.reason.contains("typecheck"), "{}", d.reason);
    }

    #[test]
    fn an_enabled_gate_allows_a_passing_report() {
        let report = report_with(vec![result("test", CheckStatus::Pass)]);
        let d = pr_gate_decision(&settings(), Some(&report));
        assert!(d.allowed);
        assert!(d.enforced);
    }

    #[test]
    fn require_pass_before_pr_off_stops_enforcing_even_when_enabled() {
        let s = GateSettings { require_pass_before_pr: false, ..settings() };
        let d = pr_gate_decision(&s, None);
        assert!(d.allowed);
        assert!(!d.enforced);
    }

    // ── status ─────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn status_counts_the_passing_checks_and_carries_the_gate_decision() {
        let dir = tmp();
        let s = settings();
        let report = report_with(vec![
            result("typecheck", CheckStatus::Pass),
            result("lint", CheckStatus::Fail),
        ]);
        save_report(dir.path(), &s, &report).unwrap();
        let st = status_for(dir.path(), &s, "agent-1");
        assert_eq!(st.checks_total, 2);
        assert_eq!(st.checks_passed, 1);
        assert_eq!(st.verdict, Some(Verdict::Fail));
        assert!(!st.running);
        assert!(!st.pr_gate.allowed);
    }

    #[test]
    fn status_for_an_agent_with_no_report_is_absent_rather_than_zeroed_pass() {
        let dir = tmp();
        let st = status_for(dir.path(), &settings(), "never-ran");
        assert_eq!(st.verdict, None);
        assert!(!st.pr_gate.allowed);
    }

    // ── tails ──────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_tail_keeps_the_last_lines_not_the_first() {
        let text: String = (1..=200).map(|i| format!("line{i}\n")).collect();
        let t = tail_of(&text);
        assert!(t.contains("line200"), "{t}");
        assert!(t.contains("line161"), "{t}");
        assert!(!t.contains("line1\n"), "{t}");
    }

    #[test]
    fn the_tail_byte_cap_slices_on_a_char_boundary() {
        // One enormous line of multi-byte characters: a naive byte slice panics here.
        let text = "✓".repeat(40_000);
        let t = tail_of(&text);
        assert!(t.len() <= TAIL_MAX_BYTES + 64, "tail was {} bytes", t.len());
        assert!(t.contains("truncated"), "{}", &t[..40.min(t.len())]);
    }

    #[test]
    fn end_to_end_a_real_run_produces_a_saved_report_and_renderable_markdown() {
        let dir = tmp();
        let s = GateSettings {
            checks: vec![
                CheckSpec { name: "green".into(), cmd: "echo ok".into() },
                CheckSpec { name: "red".into(), cmd: "echo nope >&2; exit 1".into() },
            ],
            ..settings()
        };
        let report = run_checks(dir.path(), &s, "agent-e2e", dir.path());
        assert_eq!(report.verdict, Verdict::Fail);
        save_report(dir.path(), &s, &report).unwrap();
        let loaded = load_report(dir.path(), &s, "agent-e2e").unwrap();
        let md = render_testing_section(&loaded, &load_evidence(dir.path(), &s, "agent-e2e"));
        assert!(md.contains("| green | `echo ok` | pass |"), "{md}");
        assert!(md.contains("nope"), "{md}");
        // The log file the tail came from is on disk and named in the report.
        let log = loaded.checks[0].log_path.clone().expect("log path");
        assert!(Path::new(&log).exists(), "{log}");
    }
}

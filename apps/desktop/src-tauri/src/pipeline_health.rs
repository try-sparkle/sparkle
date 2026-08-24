//! Deployment-pipeline health, aggregated for the top-bar indicator.
//!
//! WHY THIS EXISTS: a review-daemon or a release-runner can fail with NO surface to the founder. The
//! seed case (bead `sparkle-m6jov5`): the roborev daemon wedged — its process alive and holding the
//! port, but `roborev status` reporting "not running" — so code review silently stopped for ~1h36m,
//! commits queued unreviewed, and PRs merged without a completed review. It was found by accident.
//! The whole point of this module is that a silent pipeline outage becomes a VISIBLE one.
//!
//! THE SHAPE: each pipeline component (roborev, the CI runner pool, the release runner, release
//! publication, the PR reviewer) is probed independently and reduced to one [`ComponentHealth`] — a name, a
//! [`HealthState`], and a one-line human `detail`. [`overall_state`] folds them to the single worst
//! state, which drives the top-bar icon (green check / amber triangle / red exclamation). The list
//! is deliberately open: adding a component is one probe function plus one push, not a schema change.
//!
//! THE SEVERITY DISCIPLINE — blocking vs warning is decided by ONE question: does the failure
//! PREVENT a deployment, or merely degrade/pause a non-deploy function?
//!   * roborev down/wedged → WARNING. Code review stops, but merges and deploys still work.
//!   * CI self-hosted pool saturated (all runners busy) → WARNING. Tests are slow, not impossible.
//!   * CI self-hosted pool empty (no runner online) → BLOCKING. Real tests cannot run at all.
//!   * release runner (`MacBook-Pro-sparkle-release`) offline → BLOCKING. The notarized DMG builds
//!     there and nowhere else on `auto`, so no release can be cut.
//!   * a version TAGGED (or drafted) but never PUBLISHED, above the newest published release →
//!     BLOCKING. The DMG built and users cannot get it, so the deployment did not happen. This one
//!     is the module's own blind spot, closed after the fact: on 2026-08-20 a notarized v0.120.0 was
//!     discarded and an audit found fifteen tags with no Release behind them, while this module
//!     reported GREEN throughout — the release-runner probe reads the RUNNERS endpoint, and the Mac
//!     was online and idle the entire time. A runner that CAN build says nothing about whether
//!     anything SHIPPED.
//! An UNKNOWN component (a probe that could not read its signal) is surfaced as amber rather than
//! hidden — "I cannot see this" is itself worth the founder knowing — but it never escalates to red,
//! because an unreadable probe is not proof of an outage.
//!
//! Everything network- or CLI-touching is split into a PURE classifier over the tool's output plus a
//! thin shell that runs the tool, so the severity mapping is unit-tested without a daemon, a runner,
//! or a live `gh` — the failure modes this exists to catch are exactly the ones a developer cannot
//! reproduce on a healthy machine.

use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The CI/release repository whose runners gate deployments. NOT `SPARKLE_REPO_URL`
/// (`try-sparkle/sparkle`, the open-source mirror) — that repo has no runners. Mirrors the default in
/// `scripts/lib/runner-health.sh` (`RH_REPO`) and the release workflow's `$GITHUB_REPOSITORY`.
const RELEASE_REPO: &str = "drodio/sparkle";

/// The self-hosted GCP pool that runs CI test jobs. Matches `CIA_LABEL` in
/// `scripts/runner/ci-autoscale-tick.sh` and `CIR_LABEL` in `scripts/lib/ci-runner-common.sh`.
const CI_RUNNER_LABEL: &str = "linux-ci";

/// The self-hosted macOS runner that builds the notarized DMG. Matches `PR_LABEL` in
/// `scripts/lib/pick-runner.sh`.
const RELEASE_RUNNER_LABEL: &str = "sparkle-release";

/// The PUBLIC mirror whose GitHub Releases the auto-updater actually serves — `tauri.conf.json`'s
/// updater endpoint is `https://github.com/try-sparkle/sparkle/releases/latest/download/latest.json`.
/// A DMG that built on [`RELEASE_REPO`] but never became a Release HERE is invisible to every user,
/// which is exactly the state [`classify_release_publication`] exists to surface.
const PUBLIC_RELEASE_REPO: &str = "try-sparkle/sparkle";

/// Bound `roborev status`. A healthy call answers in well under a second (it talks to a local
/// daemon); the case this guards is a WEDGED daemon, where the CLI blocks on its socket indefinitely.
/// A probe that hangs is worse than one that says "wedged", so the timeout IS a signal here, not a
/// failure to suppress.
const ROBOREV_STATUS_TIMEOUT: Duration = Duration::from_secs(8);
const ROBOREV_STATUS_TIMEOUT_SECS: u64 = 8;

/// The roborev store size at which a cold sqlite open can plausibly outrun the probe bound above —
/// i.e. above which "the daemon is merely SLOW" is a live explanation for a silent `roborev status`.
/// Arithmetic, not a guess: the measured 860MB store took ~20s to open (~43MB/s on this machine), so
/// an 8s bound is exhausted somewhere around 340MB. 300MB is the round number just under that.
/// Mirrored by `PH_ROBOREV_DB_BLOAT_BYTES` in scripts/lib/pipeline-health.sh.
const ROBOREV_DB_BLOAT_BYTES: u64 = 314_572_800;

/// How the roborev store is referred to in verdict text (the path a human would go look at).
const ROBOREV_DB_LABEL: &str = "~/.roborev/reviews.db";

/// How recent a lock line in roborev's RAW ERROR LOG must be to be evidence about NOW.
///
/// Two minutes, not an hour, and the difference is the whole point. `~/.roborev/errors.log` is a
/// 14MB append-only file whose 200-line tail was MEASURED to span **~59 minutes**, so any window on
/// the order of an hour makes that tail permanently "evidence" — a wedged daemon's pre-wedge
/// collisions then read as current contention. Contention that is actually starving the status RPC
/// is losing the lock RIGHT NOW, within seconds.
/// Mirrored by `PH_LOCK_EVIDENCE_WINDOW_SECS` in scripts/pipeline-health-scan.sh.
const LOCK_EVIDENCE_WINDOW_SECS: i64 = 120;

/// How many SERVER-path lock lines inside that window before the raw log is called proof.
///
/// Kept low because [`is_server_lock_line`] — not volume — is what removes the idle background.
/// MEASURED over 40 days of this machine's log (13,227 lock lines): 13,096 worker vs 131 server.
/// Conditioned on the mtime fail-fast passing, a trailing-120s window holds ≥2 WORKER lock lines in
/// **99.97%** of seconds on an idle, healthy daemon, against **0.76%** for ≥2 SERVER lines. Raising
/// the number instead would be tuning against one machine's noise floor, which rises on a busier
/// machine; filtering by component does not.
/// Mirrored by `PH_MIN_SERVER_LOCK_LINES` in scripts/pipeline-health-scan.sh.
const MIN_SERVER_LOCK_LINES: usize = 2;

/// Bound the `gh api` runner read. `gh` has no deadline of its own; this is the Rust twin of
/// `runner-health.sh`'s `rh_status_bounded`. A timeout reads as "could not tell" (Unknown), never as
/// "offline".
const RUNNER_QUERY_TIMEOUT: Duration = Duration::from_secs(15);

/// Bound the two `gh api` release/tag reads. Same reasoning as [`RUNNER_QUERY_TIMEOUT`]: a timeout
/// reads as "could not tell" (Unknown), never as "nothing has been published".
const RELEASE_QUERY_TIMEOUT: Duration = Duration::from_secs(20);

/// One component's health, as the top-bar panel renders it. Mirrors the TS `ComponentHealth`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentHealth {
    /// Stable machine id (`roborev`, `ci_runners`, `release_runner`, `release_publication`,
    /// `knightwatch`). The React key.
    pub id: String,
    /// Display name for the panel row.
    pub name: String,
    pub state: HealthState,
    /// One human-readable line: what is wrong (or right) and, when actionable, what to do about it.
    pub detail: String,
}

/// The whole reading, as one IPC payload.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineHealth {
    /// The folded worst-of, driving the icon glyph and colour.
    pub overall: HealthState,
    pub components: Vec<ComponentHealth>,
    /// STRUCTURED release-in-progress signal for the fleet CI-budget governor
    /// (`services/ciBudgetGovernor.ts`), so it never has to parse the human `detail` string.
    /// `Some(true)` = the `sparkle-release` runner is busy building a DMG right now, so the fleet's
    /// ships pause to leave the shared pool for the release's base CI; `Some(false)` = ready but
    /// idle; **`None` = the runners read could not be made** — which the governor treats fail-safe
    /// (it does NOT release-hold on an unknown, so a transient `gh` hiccup can't freeze the fleet;
    /// the numeric budget still caps it). camelCase on the wire → `releaseInProgress`.
    pub release_in_progress: Option<bool>,
}

/// A component's, or the pipeline's, health. `NotApplicable` is DISTINCT from `Healthy`: a component
/// that is deliberately off (roborev disabled, no PR reviewer configured) is not "green", it is "not
/// part of this pipeline" — it is excluded from the fold entirely rather than counted as passing.
/// `Unknown` is DISTINCT from `Warning`: it means the probe could not read its signal, which is
/// surfaced as amber but must never escalate the icon to red.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthState {
    Healthy,
    Warning,
    Blocking,
    Unknown,
    NotApplicable,
}

/// The fold order. `None` = excluded from aggregation (a `NotApplicable` component says nothing about
/// the pipeline's health). The ranks are what make "worst of" mean the right thing:
/// `Blocking` > `Warning` > `Unknown` > `Healthy`. `Warning` outranks `Unknown` so that when both are
/// present the icon's reason comes from a KNOWN degradation rather than a "could not tell".
fn severity_rank(state: HealthState) -> Option<u8> {
    match state {
        HealthState::NotApplicable => None,
        HealthState::Healthy => Some(0),
        HealthState::Unknown => Some(1),
        HealthState::Warning => Some(2),
        HealthState::Blocking => Some(3),
    }
}

/// Fold components to the single worst applicable state. `NotApplicable` components are excluded; if
/// EVERY component is `NotApplicable` (nothing to monitor on this machine), the pipeline itself reads
/// `NotApplicable` and the icon shows its muted "nothing monitored" form rather than a false green.
pub fn overall_state(components: &[ComponentHealth]) -> HealthState {
    components
        .iter()
        .filter_map(|c| severity_rank(c.state).map(|r| (r, c.state)))
        .max_by_key(|(r, _)| *r)
        .map(|(_, s)| s)
        .unwrap_or(HealthState::NotApplicable)
}

// ── roborev ─────────────────────────────────────────────────────────────────────────────────────

/// The three shapes a `roborev status` invocation can take, as the PURE classifier sees them.
/// Separating "the call timed out" from "the call failed some other way" from "here is the text" is
/// the whole point: a TIMEOUT is the wedge signature, not an ordinary error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusProbe {
    /// The CLI did not answer within [`ROBOREV_STATUS_TIMEOUT`] — the daemon is wedged (its socket
    /// accepts but never replies), which is exactly the seed incident.
    TimedOut,
    /// The CLI answered non-zero or could not be spawned; the string is its own words.
    Failed(String),
    /// The CLI printed its status; classify the text.
    Text(String),
}

/// What we could learn about the daemon BESIDES the fact that it did not answer. A silent
/// `roborev status` has three causes that need OPPOSITE remedies (see [`classify_not_answering`]),
/// and these are the readings that separate them. Every field is an `Option` because every one of
/// them can fail to be read, and a failed read must produce "we do not know", never a confident
/// wrong answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DaemonEvidence {
    /// `launchctl print gui/<uid>/co.plow.roborev-daemon` succeeded — the LaunchAgent is REGISTERED.
    /// Registration is not the same fact as a running process, which is why `alive` exists.
    loaded: Option<bool>,
    /// A `roborev daemon` PROCESS actually exists. Outranks `loaded` when both are present.
    alive: Option<bool>,
    /// Size of the roborev store (`reviews.db` plus its `-wal` sidecar), in bytes.
    db_bytes: Option<u64>,
    /// Is roborev's own error log showing SERVER-path lock collisions RIGHT NOW? `None` = we could
    /// not tell, which is never read as "no contention". See [`roborev_recent_lock_evidence`].
    lock_evidence: Option<bool>,
}

impl DaemonEvidence {
    /// Only the LaunchAgent reading — used where no process/store reading was taken.
    fn loaded(loaded: Option<bool>) -> Self {
        Self { loaded, ..Default::default() }
    }

    /// Is a daemon process there? The direct process reading WINS over the LaunchAgent
    /// registration; the registration is only the fallback when no process reading was taken.
    fn is_alive(&self) -> Option<bool> {
        self.alive.or(self.loaded)
    }
}

/// Classify roborev's health from a `status` probe plus whatever [`DaemonEvidence`] we could
/// collect. PURE, so every branch is tested without a daemon.
///
/// roborev is NEVER `Blocking`: review stopping does not stop merges or deploys, so its worst state
/// is `Warning`. The caller decides `NotApplicable` (roborev disabled) before reaching here.
fn classify_roborev(status: &StatusProbe, evidence: DaemonEvidence) -> (HealthState, String) {
    match status {
        // A TIMEOUT is not a diagnosis. See `classify_not_answering` for why this no longer says
        // "wedged" on its own evidence.
        StatusProbe::TimedOut => classify_not_answering(true, evidence),
        StatusProbe::Failed(err) => {
            // roborev's own "failed to connect to daemon" wording — down, wedged, or merely slow.
            if err.to_lowercase().contains("connect to daemon") {
                classify_not_answering(false, evidence)
            } else {
                (
                    HealthState::Unknown,
                    format!("could not read roborev status: {}", first_line(err)),
                )
            }
        }
        StatusProbe::Text(out) => {
            let daemon_line = out
                .lines()
                .find(|l| l.trim_start().starts_with("Daemon:"))
                .unwrap_or("")
                .to_ascii_lowercase();
            if daemon_line.contains("not running") {
                classify_not_answering(false, evidence)
            } else if daemon_line.contains("running") {
                classify_running(out)
            } else {
                (
                    HealthState::Unknown,
                    format!("roborev status was unreadable: {}", first_line(out)),
                )
            }
        }
    }
}

/// One non-healthy subsystem line under `Health:`, e.g. `! workers: 7 stalled job(s) running > 30
/// min`. roborev prints one indented line per subsystem, each led by a status marker: `+` healthy,
/// `!` degraded/warn, `-` (or `x`) unhealthy. We keep the `hard` bit (a `-`/`x` marker, or the word
/// "unhealthy") apart from the subsystem name and detail because the whole calibration turns on it.
struct HealthProblem {
    /// The subsystem token before the colon, lowercased (`database`, `workers`, …).
    subsystem: String,
    /// The remainder after the colon, lowercased.
    detail: String,
    /// A hard-unhealthy marker (`-`/`x`) or the literal "unhealthy" — a genuinely sick subsystem, as
    /// opposed to a soft `!` warning.
    hard: bool,
}

/// Every non-healthy subsystem under `Health:`, plus whether the parse was clean.
struct HealthReading {
    problems: Vec<HealthProblem>,
    /// TRUE if any line inside the health block could not be classified — an indented line with a
    /// marker we do not recognise, or a marker line with no `<subsystem>: <detail>` shape. This is
    /// the whole reason the greening decision can fail CLOSED: an unrecognised line is exactly where
    /// a hard failure could hide, so its mere presence forbids a green (`sparkle` roborev finding —
    /// the parser must not drop evidence and then read "all benign").
    saw_unrecognised: bool,
}

/// Parse the subsystem lines under a `Health:` line into the not-healthy problems plus a
/// `saw_unrecognised` flag. Each roborev health sub-line reads `<marker> <subsystem>: <detail>`; a
/// `+`/healthy line contributes nothing. The block is the run of INDENTED lines right after
/// `Health:`; the first NON-indented, non-blank line (e.g. `Recent Errors:`) legitimately ends it.
/// An indented line we cannot classify does NOT silently vanish — it sets `saw_unrecognised`, which
/// the caller treats as "cannot confirm benign" and so refuses to green.
fn roborev_health_problems(out: &str) -> HealthReading {
    let mut seen_health = false;
    let mut problems = Vec::new();
    let mut saw_unrecognised = false;
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Health:") {
            seen_health = true;
            continue;
        }
        if !seen_health {
            continue;
        }
        if trimmed.is_empty() {
            // A blank line inside/after the block — skip it (the real output has one before
            // `Recent Errors:`). It neither ends the block nor counts as unrecognised.
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            // A non-indented, non-blank line is the next top-level section — the block ends here and
            // nothing below it is a subsystem. This is the ONLY safe terminator.
            break;
        }
        // An INDENTED, non-blank line must be a subsystem marker line. Anything we cannot classify
        // here is evidence we are not equipped to read, so we flag it rather than drop it — and we
        // keep scanning so a later hard line is still collected too.
        let marker = trimmed.chars().next().unwrap_or(' ');
        if !matches!(marker, '+' | '!' | '-' | 'x' | 'X') {
            saw_unrecognised = true;
            continue;
        }
        let body = trimmed[marker.len_utf8()..].trim();
        let Some((subsystem, detail)) = body.split_once(':') else {
            saw_unrecognised = true;
            continue;
        };
        let subsystem = subsystem.trim().to_ascii_lowercase();
        let detail = detail.trim().to_ascii_lowercase();
        // A `+`/healthy subsystem is not a problem. Everything else is, and its severity is `hard`
        // when the marker is `-`/`x` or the detail says "unhealthy".
        if marker == '+' || (detail == "healthy" && marker != '-' && marker != 'x' && marker != 'X')
        {
            continue;
        }
        let hard = matches!(marker, '-' | 'x' | 'X') || detail.contains("unhealthy");
        problems.push(HealthProblem { subsystem, detail, hard });
    }
    HealthReading { problems, saw_unrecognised }
}

/// A detail line that mentions stalled jobs but ALSO signals a real fault. Only UNAMBIGUOUS fault
/// words count (`sparkle` roborev findings): the earlier version also scanned for `"active"` and
/// `"0/"`, but `active` is the very word roborev uses for HEALTHY capacity (`4/4 active`) and `0/`
/// matches inside any number ending in zero (`10/12`), so both silently and permanently ambered a
/// working daemon. A genuinely lost worker is reported by roborev with one of these explicit words
/// (or a hard `-`/unhealthy marker, already handled), which is what we key on.
fn detail_bundles_a_fault(detail: &str) -> bool {
    const FAULT_TOKENS: &[&str] =
        &["down", "fail", "error", "offline", "unavailable", "not running", "crash", "unhealthy"];
    FAULT_TOKENS.iter().any(|t| detail.contains(t))
}

/// Is this problem the benign "stale review jobs" kind — a soft (`!`) worker/job line whose detail is
/// ONLY about stalled or stuck jobs? These are doomed temp-fixture review jobs (`sparkle-o4mqng`)
/// that pile up on a busy machine as zombie rows; they are counted under "running" but are not held
/// by a live worker, so they do not consume worker capacity or stop new review. A detail that also
/// carries an explicit fault word (a worker down, offline, crashed) is excluded — that is review
/// actually stopping, not debris.
fn is_benign_stalled(p: &HealthProblem) -> bool {
    !p.hard
        && (p.subsystem.contains("worker") || p.subsystem.contains("job"))
        && (p.detail.contains("stall") || p.detail.contains("stuck"))
        && !detail_bundles_a_fault(&p.detail)
}

/// The health VERDICT word — the first token after `Health:`, lowercased. Matched by EQUALITY, never
/// substring (`sparkle` roborev finding): `contains("ok")` greened `Health: BROKEN` (br-OK-en) and
/// `Health: DEGRADED (database not ok)`, short-circuiting every fence below. `None` when there is no
/// parseable word after the colon.
fn health_word(health_line: &str) -> Option<String> {
    let after = health_line.trim().strip_prefix("Health:")?.trim();
    after.split_whitespace().next().map(|w| w.to_ascii_lowercase())
}

/// A `Daemon: running` reading — healthy unless the `Health:` line says otherwise.
///
/// CALIBRATION: `roborev status` reports `Health: DEGRADED` whenever ANY subsystem is off, and on a
/// busy machine the near-permanent driver is `workers: N stalled job(s) running > 30 min` — doomed
/// temp-fixture jobs (`sparkle-o4mqng`) with the database healthy and workers active. A genuinely
/// working daemon then reads amber forever, which is the signal-erosion defect `sparkle-ot4dxb` names
/// for this exact panel: an alert that fires on a condition it simultaneously declares harmless. So a
/// DEGRADED whose ONLY non-healthy subsystems are stale review jobs (database healthy, nothing hard)
/// reads Healthy with a note; a genuinely sick subsystem (a `-`/unhealthy line, or any degradation we
/// cannot confirm is the benign stale-jobs kind) stays Warning.
///
/// The green path is fenced THREE ways, every one fail-closed, because it overrides roborev's own
/// verdict: the verdict word must be exactly `degraded` (a strictly-worse `unhealthy`/`critical` is
/// never discounted), the parse must be clean (`!saw_unrecognised` — an unreadable subsystem line
/// could be the hard one), and every problem must be benign stalled-jobs debris with no explicit
/// fault word. There is deliberately NO worker-count fence: `Workers: N/M active` counts workers
/// BUSY, not alive, so `0/M active` is a healthy IDLE daemon — blocking on it would re-amber exactly
/// the drained-queue case this fix greens (`sparkle` roborev finding). A genuinely dead worker
/// surfaces as a fault word / hard marker in the health block instead.
fn classify_running(out: &str) -> (HealthState, String) {
    let health_line = out.lines().find(|l| l.trim_start().starts_with("Health:"));
    match health_line {
        Some(h) => {
            let word = health_word(h);
            // "Health: OK" — the daemon reports itself sound. Summarise the queue for the panel.
            if word.as_deref() == Some("ok") {
                return (
                    HealthState::Healthy,
                    format!("Review daemon running. {}", jobs_summary(out)),
                );
            }
            // A non-OK health. Decide between benign stale-job debris (green) and a real degradation
            // (amber) from the subsystem lines.
            let reading = roborev_health_problems(out);
            // Green ONLY when every fence passes: the verdict word is exactly `degraded`, the parse
            // saw nothing it could not classify, and there is at least one problem with every problem
            // benign stalled-jobs debris. An empty problem list (a bare `Health: DEGRADED`) is not
            // confirmable and stays amber.
            let is_degraded = word.as_deref() == Some("degraded");
            let all_benign_stalled =
                !reading.problems.is_empty() && reading.problems.iter().all(is_benign_stalled);
            if is_degraded && !reading.saw_unrecognised && all_benign_stalled {
                let stalled = reading
                    .problems
                    .iter()
                    .map(|p| p.detail.as_str())
                    .collect::<Vec<_>>()
                    .join("; ");
                (
                    HealthState::Healthy,
                    format!(
                        "Review daemon running ({stalled}) — stale review jobs that do not stop \
                         review; merges and deploys are unaffected. {}",
                        jobs_summary(out)
                    ),
                )
            } else {
                (
                    HealthState::Warning,
                    format!(
                        "roborev is running but reports {} — review may be degraded. Merges and \
                         deploys are unaffected.",
                        h.trim()
                    ),
                )
            }
        }
        // Running with no Health line (an older CLI). Take the running line at its word.
        None => (HealthState::Healthy, format!("Review daemon running. {}", jobs_summary(out))),
    }
}

/// THE NOT-ANSWERING RESULT — three causes, three remedies (bead `sparkle-4i8kd6`).
///
/// This used to fold every silent-daemon shape onto one word ("wedged") and one instruction
/// ("Recover with `roborev daemon stop && roborev daemon start`"). Measured on the founder's
/// machine, both halves were wrong at once:
///   * `~/.roborev/reviews.db` had grown to 860MB (17589 completed + 4377 failed jobs). Opening a
///     store that size takes ~20s, so the 8s bound above expires first and the probe reports its OWN
///     client-side timeout as a dead daemon — while the launchd-supervised process is alive and
///     serving reviews throughout. The chip flapped WARNING→healthy three times in an hour.
///   * The prescribed remedy is HARMFUL. `roborev daemon start` is broken on this macOS (it needs
///     `setsid`; scripts/roborev-maintenance.sh's header records the finding), launchd's KeepAlive
///     re-starts whatever `stop` stopped, and each failed `start` leaves an ORPHAN that cannot bind
///     127.0.0.1:7373. Three were created by following this very text before it was noticed.
///
/// A remedy is an INSTRUCTION the reader will follow, so it must be safe under the conditions that
/// produced it (AGENTS.md, bead `sparkle-8bvh`). So the verdict now splits on evidence:
///   SLOW  — process alive + a bloated store → name the store, point at compaction, forbid a restart
///   WEDGE — process alive + a small store   → a real wedge; `launchctl kickstart -k`
///   DOWN  — no daemon process               → start it via launchd, not the broken subcommand
///   UNDETERMINED — the evidence is unreadable → say so and diagnose; NEVER restart blind
/// All four are `Warning`: a down or unreadable daemon must never read as "nothing to do".
///
/// Mirrored by `ph_classify_roborev_not_answering` in scripts/lib/pipeline-health.sh.
fn classify_not_answering(timed_out: bool, ev: DaemonEvidence) -> (HealthState, String) {
    let why = if timed_out {
        format!("roborev status did not answer within {ROBOREV_STATUS_TIMEOUT_SECS}s")
    } else {
        "roborev could not reach its review daemon".to_string()
    };
    let db_mb = ev.db_bytes.map(|b| b / 1_048_576);
    let bloated = ev.db_bytes.is_some_and(|b| b >= ROBOREV_DB_BLOAT_BYTES);

    // DOWN — no process at all. Not a wedge, and the remedy is launchd's, because `roborev daemon
    // start` cannot bring it back on this machine.
    if ev.is_alive() == Some(false) {
        let detail = if ev.loaded == Some(false) {
            format!(
                "{why}, and there is no roborev daemon process and launchd does not have the agent \
                 loaded — the review daemon is not running. Code review is stopped; merges and \
                 deploys are unaffected. Start it with `launchctl bootstrap gui/$(id -u) \
                 ~/Library/LaunchAgents/co.plow.roborev-daemon.plist`; `roborev daemon start` is \
                 broken on this machine (it needs setsid) and each failed attempt leaves an orphan \
                 holding 127.0.0.1:7373."
            )
        } else {
            format!(
                "{why}, and there is no roborev daemon process — the review daemon is not running. \
                 Code review is stopped; merges and deploys are unaffected. Start it with \
                 `launchctl kickstart -k gui/$(id -u)/co.plow.roborev-daemon`; `roborev daemon \
                 start` is broken on this machine (it needs setsid) and each failed attempt leaves \
                 an orphan holding 127.0.0.1:7373."
            )
        };
        return (HealthState::Warning, detail);
    }

    if ev.is_alive() == Some(true) {
        // CONTENDED — the daemon is alive and its SERVER path is losing the SQLite lock right now,
        // so the silence is a STARVED read, not a stuck process. This arm exists because the WEDGE
        // arm below otherwise calls a live daemon "a genuine WEDGE" on the ABSENCE of store bloat
        // alone, and a small store is not evidence that the daemon is stuck — it only rules out the
        // one alternative explanation that main's ladder could see. Ranked BELOW the bloated case
        // deliberately: when the store IS oversized, SLOW already names the disease and prescribes
        // the compaction that actually fixes it, and lock collisions are a symptom of that same
        // store rather than a competing diagnosis.
        if !bloated && ev.lock_evidence == Some(true) {
            return (
                HealthState::Warning,
                format!(
                    "{why}, but the daemon process is ALIVE and its own error log shows the SERVER \
                     path losing the SQLite write lock within the last \
                     {LOCK_EVIDENCE_WINDOW_SECS}s — so the status read is being THROTTLED by lock \
                     contention, not answered by a wedged daemon. Review is slowed, NOT stopped; \
                     merges and deploys are unaffected. A restart does not clear contention and \
                     `roborev daemon stop && roborev daemon start` is broken on this machine \
                     besides (launchd restarts what you stopped, and the failed start orphans a \
                     process holding 127.0.0.1:7373). If it persists, shrink the store offline with \
                     `scripts/roborev-maintenance.sh --compact` — write-lock contention is what a \
                     growing store causes."
                ),
            );
        }
        if let Some(mb) = db_mb {
            // SLOW — the store alone explains the silence, and a restart cannot shrink a store.
            if bloated {
                return (
                    HealthState::Warning,
                    format!(
                        "{why}, but the daemon process is ALIVE and {ROBOREV_DB_LABEL} is {mb} MB — \
                         this is SLOW, not wedged: a store that size takes longer to open than the \
                         {ROBOREV_STATUS_TIMEOUT_SECS}s probe waits, so the probe is reporting its \
                         own timeout. Reviews are queued behind a contended store; merges and \
                         deploys are unaffected. Do NOT run `roborev daemon stop && roborev daemon \
                         start` — it is broken on this machine, launchd restarts whatever you stop, \
                         and the failed start orphans a process holding 127.0.0.1:7373. The store \
                         size is the disease: check `scripts/roborev-maintenance.sh --status`, then \
                         shrink it offline with `scripts/roborev-maintenance.sh --compact`."
                    ),
                );
            }
            // WEDGE — alive, and the store is demonstrably small, so the daemon itself is stuck.
            return (
                HealthState::Warning,
                format!(
                    "{why}, the daemon process is ALIVE, and {ROBOREV_DB_LABEL} is only {mb} MB — so \
                     this is a genuine WEDGE, not store slowness. Code review is stopped; merges \
                     and deploys are unaffected. Restart it with `launchctl kickstart -k \
                     gui/$(id -u)/co.plow.roborev-daemon` — NOT `roborev daemon stop && roborev \
                     daemon start`, which is broken on this machine (launchd restarts what you \
                     stopped, and the failed start orphans a process holding 127.0.0.1:7373)."
                ),
            );
        }
    }

    // UNDETERMINED — we cannot tell SLOW from WEDGED, and they need opposite remedies. Say so.
    let evidence = match (ev.is_alive(), db_mb, bloated) {
        (Some(true), _, _) => {
            format!("the daemon process is alive, but {ROBOREV_DB_LABEL} could not be read")
        }
        (_, Some(mb), true) => format!(
            "no process reading was taken, though {ROBOREV_DB_LABEL} is {mb} MB, which on its own \
             can explain the silence"
        ),
        (_, Some(mb), false) => {
            format!("no process reading was taken, and {ROBOREV_DB_LABEL} is only {mb} MB")
        }
        _ => format!("neither the daemon process nor {ROBOREV_DB_LABEL} could be read"),
    };
    (
        HealthState::Warning,
        format!(
            "{why}, and the cause is UNDETERMINED: {evidence}. A daemon that is merely slow behind \
             a bloated store and one that is genuinely wedged look identical from here and need \
             opposite remedies, so diagnose before restarting: \
             `scripts/roborev-maintenance.sh --status`, and `pgrep -fl \"roborev daemon\"`. Code \
             review may be stopped; merges and deploys are unaffected. Do not restart blind — \
             `roborev daemon stop && roborev daemon start` is broken on this machine and orphans a \
             process holding 127.0.0.1:7373."
        ),
    )
}

/// Pull the `Jobs:` line out of `roborev status` for the panel detail, e.g.
/// "14 queued, 4 running, 15488 completed". Best-effort — an empty string if the line is absent.
fn jobs_summary(out: &str) -> String {
    out.lines()
        .find(|l| l.trim_start().starts_with("Jobs:"))
        .map(|l| l.trim_start().trim_start_matches("Jobs:").trim().to_string())
        .unwrap_or_default()
}

/// First non-empty line of a possibly-multiline tool message, trimmed — so a panel detail is one
/// line even when the tool wrote a banner.
fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

// ── CI + release runners ────────────────────────────────────────────────────────────────────────

/// What one `gh api .../actions/runners` read tells us about ONE labelled pool. `None` from
/// [`read_runner_pool`] means the JSON was unreadable or the wrong shape — kept distinct from "zero
/// online", because collapsing them turns a 503/auth-error into a false "the pool is down" (the exact
/// bug `scripts/lib/pick-runner.sh`'s three-way split exists to prevent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RunnerPoolReading {
    online_idle: usize,
    online_busy: usize,
    /// Did we see the WHOLE registration list, or only a page of it?
    ///
    /// The endpoint reports `total_count` — every registration on the repo — beside the page of
    /// runners it actually returned. Registrations exceed the live-VM ceiling because stale/offline
    /// ghosts accrue until the reaper clears them (a live diagnosis in `pick-runner.sh` saw 61
    /// against a ~26 ceiling), so ONE page can silently drop the `sparkle-release` runner onto an
    /// unfetched page. That produced the measured false positive this field exists to kill: the
    /// monitor announced "the macOS release runner (sparkle-release) is offline — wake the release
    /// Mac" while a direct read showed `status=online, busy=false`.
    ///
    /// A truncated page can prove PRESENCE but can NEVER prove ABSENCE, so `false` here must
    /// downgrade an "everything is offline" verdict to `Unknown` rather than publish an outage.
    /// An ABSENT `total_count` counts as complete: a stub or a hand-written fixture that omits it
    /// is a complete answer about the world it describes, not a truncated one.
    complete: bool,
}

impl RunnerPoolReading {
    fn online_total(&self) -> usize {
        self.online_idle + self.online_busy
    }
}

/// Read one labelled pool from the runners-endpoint JSON. Returns `None` when the payload is not the
/// `{ "runners": [ … ] }` shape — an error object (`{"message": "…"}`) or truncated body must classify
/// as UNKNOWN downstream, never as "no runners online".
///
/// TWO SHAPES ARE ACCEPTED, and both are real:
///   * a lone `{total_count, runners:[…]}` object — one un-paginated page, and what every stub and
///     fixture hands us;
///   * an ARRAY of such page objects — what `gh api --paginate … --slurp` returns, which is how
///     [`runner_components`] now reads the endpoint (mirroring `pr_query_runners`). Every page's
///     `runners` are merged; `total_count` comes from the first element, because GitHub reports the
///     same repo-wide count on every page.
fn read_runner_pool(json: &str, label: &str) -> Option<RunnerPoolReading> {
    let value: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let pages: Vec<&serde_json::Value> = match value.as_array() {
        Some(items) => items.iter().collect(),
        None => vec![&value],
    };
    // An empty array carries no page at all — a shape we cannot read, not an empty pool.
    let first = pages.first().copied()?;
    let total_count = first.get("total_count").and_then(|t| t.as_u64());
    let mut merged: Vec<&serde_json::Value> = Vec::new();
    for page in pages {
        // A page without a `runners` array is a shape we do not understand; fail the WHOLE read
        // rather than quietly merging the pages we happened to parse, which would under-report the
        // pool exactly like the truncation this function exists to detect.
        let runners = page.get("runners").and_then(|r| r.as_array())?;
        merged.extend(runners.iter());
    }
    let complete = total_count.map(|t| t as usize <= merged.len()).unwrap_or(true);
    let mut online_idle = 0;
    let mut online_busy = 0;
    for r in merged {
        if r.get("status").and_then(|s| s.as_str()) != Some("online") {
            continue;
        }
        let has_label = r
            .get("labels")
            .and_then(|l| l.as_array())
            .map(|labels| {
                labels.iter().any(|l| l.get("name").and_then(|n| n.as_str()) == Some(label))
            })
            .unwrap_or(false);
        if !has_label {
            continue;
        }
        if r.get("busy").and_then(|b| b.as_bool()).unwrap_or(false) {
            online_busy += 1;
        } else {
            online_idle += 1;
        }
    }
    Some(RunnerPoolReading { online_idle, online_busy, complete })
}

/// Read `.total_count` from `gh api "repos/<repo>/actions/runs?status=queued&per_page=1"`.
///
/// `None` for ANY shape we do not understand, and the caller must keep that distinct from `0`: a
/// failed read that presented as "no backlog" would restore precisely the false RECOVERED this input
/// exists to prevent.
fn read_queued_runs(json: &str) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let n = value.get("total_count")?.as_u64()?;
    Some(n as usize)
}

/// Below this many queued runs, a backlog is NOT worth a warning even when it exceeds free capacity.
///
/// The autoscaler dispatches on a ~300s grace (`CIA_STOCKOUT_GRACE_S` in `scripts/lib/ci-autoscale.sh`,
/// whose own comment puts the normal look of a healthy scale-up at ~3 minutes), so a handful of queued
/// runs clears inside one dispatch cycle without anyone doing anything. Warning on that would be
/// exactly the paper-cut flapping this whole component is being fixed to remove: an amber chip that
/// blinks several times an hour on a pipeline that is working teaches its reader to skim past it, and
/// then a REAL stockout arrives into a channel nobody watches.
const CI_QUEUE_BACKLOG_MIN: usize = 5;

/// Classify the CI test pool (`linux-ci`) from the runner pool AND the repo-wide queued-run count.
///
/// WHY QUEUE DEPTH IS AN INPUT (bead `sparkle-1xg2f6`). Reading only the pool, this returned Healthy
/// the moment ONE runner was idle, and announced "CI test runners RECOVERED — 1 of 21 idle and ready.
/// No action needed; close the pipeline-health bead" while 43 runs were queued, 20 of 21 runners were
/// busy, and main's three newest runs were all queued. One idle runner out of twenty-one against
/// forty-three queued runs is not recovery, and a verdict that also tells you to close the bead
/// erases its own evidence.
///
/// The ladder, in order — the same one `scripts/lib/pipeline-health-scan` mirrors:
///   1. no reading at all → Unknown.
///   2. nothing online but the list was TRUNCATED → Unknown. Absence is unprovable from a page.
///   3. nothing online on a complete list → Blocking. Real tests cannot run.
///   4. all busy → Warning, naming the queue when we could read it.
///   5. idle runners but the queue is UNREADABLE → Unknown. Unknown never alarms and never fires a
///      recovery notice, so an unreadable queue produces SILENCE rather than a false RECOVERED.
///   6. queue deeper than free capacity (and past [`CI_QUEUE_BACKLOG_MIN`]) → Warning.
///   7. otherwise → Healthy, stating the queue depth it was judged against.
fn classify_ci_pool(
    reading: Option<RunnerPoolReading>,
    queued: Option<usize>,
) -> (HealthState, String) {
    let Some(r) = reading else {
        return (
            HealthState::Unknown,
            "could not read CI runner status from GitHub — pipeline visibility is degraded."
                .to_string(),
        );
    };
    if r.online_total() == 0 && !r.complete {
        return (
            HealthState::Unknown,
            format!(
                "the runner list was TRUNCATED and no CI runner ({CI_RUNNER_LABEL}) appeared on the \
                 page read — this is a limit of the probe, not proof the pool is down. Re-read with \
                 pagination."
            ),
        );
    }
    if r.online_total() == 0 {
        return (
            HealthState::Blocking,
            format!(
                "no self-hosted CI runners ({CI_RUNNER_LABEL}) are online — CI cannot run tests, so \
                 nothing can be verified for merge or release."
            ),
        );
    }
    if r.online_idle == 0 {
        let queue_clause = match queued {
            Some(q) => format!(" with {q} run(s) queued"),
            None => String::new(),
        };
        return (
            HealthState::Warning,
            format!(
                "all {} self-hosted CI runners ({CI_RUNNER_LABEL}) are busy{queue_clause} — CI is \
                 queued and slow but still running; merges and deploys are not blocked.",
                r.online_busy
            ),
        );
    }
    let Some(queued) = queued else {
        return (
            HealthState::Unknown,
            format!(
                "{} of {} CI runners ({CI_RUNNER_LABEL}) idle, but the queued-run count could not be \
                 read — readiness cannot be confirmed, so this is not reported as ready.",
                r.online_idle,
                r.online_total()
            ),
        );
    };
    if queued > r.online_idle && queued >= CI_QUEUE_BACKLOG_MIN {
        return (
            HealthState::Warning,
            format!(
                "{queued} runs are queued against only {} idle CI runner(s) ({CI_RUNNER_LABEL}) of \
                 {} — the backlog exceeds free capacity, so work is waiting. CI is slow but still \
                 running; merges and deploys are not blocked.",
                r.online_idle,
                r.online_total()
            ),
        );
    }
    (
        HealthState::Healthy,
        format!(
            "{} of {} CI runners ({CI_RUNNER_LABEL}) idle and ready ({queued} run(s) queued).",
            r.online_idle,
            r.online_total()
        ),
    )
}

/// Classify the release runner (`sparkle-release`). The notarized DMG builds only here on `auto`, so
/// offline is BLOCKING to releases. Busy is not a problem — a busy release runner is a release in
/// flight.
///
/// The TRUNCATION arm comes first and is the measured bug: an unpaginated read dropped this runner
/// onto page 2 and the monitor filed a P1 "wake the release Mac" against a Mac that was online and
/// idle. A page that did not contain the runner is not evidence the runner is gone.
fn classify_release_runner(reading: Option<RunnerPoolReading>) -> (HealthState, String) {
    match reading {
        None => (
            HealthState::Unknown,
            "could not read release-runner status from GitHub — pipeline visibility is degraded."
                .to_string(),
        ),
        Some(r) if r.online_total() == 0 && !r.complete => (
            HealthState::Unknown,
            format!(
                "the runner list was TRUNCATED and the release runner ({RELEASE_RUNNER_LABEL}) did \
                 not appear on the page read — this is a limit of the probe, not proof the Mac is \
                 offline. Re-read with pagination."
            ),
        ),
        Some(r) if r.online_total() == 0 => (
            HealthState::Blocking,
            format!(
                "the macOS release runner ({RELEASE_RUNNER_LABEL}) is offline — no notarized DMG can \
                 be built until it is back online. Wake the release Mac and re-check."
            ),
        ),
        Some(r) if r.online_busy > 0 => (
            HealthState::Healthy,
            format!("release runner ({RELEASE_RUNNER_LABEL}) online and building a release."),
        ),
        Some(_) => (
            HealthState::Healthy,
            format!("release runner ({RELEASE_RUNNER_LABEL}) online and ready to build."),
        ),
    }
}

// ── release publication ─────────────────────────────────────────────────────────────────────────

/// A `vMAJOR.MINOR.PATCH` release tag, parsed for ORDERED comparison. The derived `Ord` over the
/// numeric fields in declaration order IS the point of this type: comparing the STRINGS gets
/// `v0.99.0` vs `v0.110.0` backwards ("9" > "1"), and that mistake is silent in exactly the
/// direction this component exists to catch — a lexicographic compare ranks v0.99.0 above v0.110.0,
/// so an unpublished v0.110.0 would read as already below the high-water mark and stay green.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Parse `v0.120.0` (or a bare `0.120.0`). `None` for anything that is not exactly three numeric
/// components: this repo also carries `archive/2026-07-27/...` tags, which are not release tags and
/// must not be counted as work that failed to ship.
fn parse_version(raw: &str) -> Option<Version> {
    let trimmed = raw.trim();
    let body = trimmed.strip_prefix('v').or_else(|| trimmed.strip_prefix('V')).unwrap_or(trimmed);
    let mut parts = body.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(Version { major, minor, patch })
}

/// One read of the PUBLIC repo's Releases list. `None` from [`read_releases`] means the payload was
/// unreadable — kept distinct from "nothing is published", because a 503 or an auth failure must
/// classify UNKNOWN rather than as the very outage this component exists to catch.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReleasesReading {
    /// Tags of every PUBLISHED release — non-draft AND non-prerelease. A prerelease is not what the
    /// updater endpoint serves, so it is no evidence that a version reached a user.
    published: Vec<String>,
    /// Tags of every DRAFT release. A draft is a release object that exists but is invisible to
    /// users — the v0.111.0 shape: created, carrying a 404-byte `.sig` and no DMG, never published.
    drafts: Vec<String>,
}

/// Read the `[{tag_name, draft, prerelease}, …]` payload of `gh api repos/<repo>/releases`. `None`
/// when the body is not an array, or is a non-empty array we could not pull a single `tag_name` out
/// of — a shape we do not understand must not present as "nothing is published".
fn read_releases(json: &str) -> Option<ReleasesReading> {
    let value: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let items = value.as_array()?;
    let mut published = Vec::new();
    let mut drafts = Vec::new();
    let mut read_any = false;
    for r in items {
        let Some(tag) = r.get("tag_name").and_then(|t| t.as_str()) else {
            continue;
        };
        read_any = true;
        let draft = r.get("draft").and_then(|d| d.as_bool()).unwrap_or(false);
        let prerelease = r.get("prerelease").and_then(|p| p.as_bool()).unwrap_or(false);
        if draft {
            drafts.push(tag.to_string());
        } else if !prerelease {
            published.push(tag.to_string());
        }
    }
    if !items.is_empty() && !read_any {
        return None;
    }
    Some(ReleasesReading { published, drafts })
}

/// Read tag names from `gh api repos/<repo>/tags`. `None` on the same two unreadable shapes as
/// [`read_releases`], for the same reason.
fn read_version_tags(json: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let items = value.as_array()?;
    let names: Vec<String> = items
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect();
    if !items.is_empty() && names.is_empty() {
        return None;
    }
    Some(names)
}

/// Page size used for the single-page tag read. Named so the truncation guard below and the
/// request that produces it can never drift apart.
const TAG_PAGE_SIZE: usize = 100;

/// Refuse to report `Healthy` off a tag list we could NOT read in full (roborev finding, Medium).
///
/// HISTORY. The tag read used to be ONE page of [`TAG_PAGE_SIZE`], and this repo carries 159 `v*`
/// tags plus non-version `archive/...` refs — so page 1 always dropped ~59 tags. A truncated page
/// is a perfectly well-formed array that `read_version_tags` cannot tell from a complete one, so
/// `classify_release_publication` saw a short tag list, found no orphans, and reported **Healthy**
/// — and this guard then had to blanket-downgrade any Healthy verdict read from a full page to
/// Unknown, which is why RELEASE PUBLICATION showed "Unknown" on every scan.
///
/// [`release_publication_component`] now PAGINATES the tag read (`gh api --paginate`), so the read
/// is COMPLETE and `tags_complete` is `true`, and a real Healthy verdict survives. This guard stays
/// as the fail-safe: if a read is ever marked incomplete (`tags_complete == false`), an "all clear"
/// is still downgraded to Unknown rather than shipped as a silent false-green.
///
/// Only the HEALTHY verdict is downgraded. A positive finding (Blocking/Warning) was reached from
/// tags we actually read and stays true whatever else went unread; Unknown and NotApplicable are
/// already non-committal. Downgrading only the "all clear" is the fail-closed direction.
fn apply_tag_page_truncation(
    state: HealthState,
    detail: String,
    tags_complete: bool,
) -> (HealthState, String) {
    if state == HealthState::Healthy && !tags_complete {
        return (
            HealthState::Unknown,
            "the tag list could not be read in full, so a built version that was never published \
             cannot be ruled out. This is a limit of the probe, not a fault in the pipeline."
                .to_string(),
        );
    }
    (state, detail)
}

/// How many versions a detail line names before it summarises the rest. The panel row is ONE line,
/// and fifteen orphan tags spelled out is not readable. The list is rendered highest-first so the
/// version that matters most is never the one elided.
const MAX_NAMED_VERSIONS: usize = 4;

/// Render versions highest-first for a one-line panel detail, naming at most
/// [`MAX_NAMED_VERSIONS`] and counting the rest.
fn name_versions(versions: &[Version]) -> String {
    let mut sorted = versions.to_vec();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    let named: Vec<String> = sorted.iter().take(MAX_NAMED_VERSIONS).map(|v| v.to_string()).collect();
    let rest = sorted.len().saturating_sub(named.len());
    if rest > 0 {
        format!("{} (+{rest} more)", named.join(", "))
    } else {
        named.join(", ")
    }
}

/// The workflow whose conclusion the release gate reads. `scripts/lib/ci-gate.sh` filters on exactly
/// this name, and so must we — a repo's head SHA carries runs from several workflows and any other
/// one's conclusion says nothing about whether the tree passed CI.
const CI_WORKFLOW_NAME: &str = "CI";

/// What `scripts/lib/ci-gate.sh`'s `cc_gate` would decide about a draft's tag.
///
/// WHY THIS EXISTS, AND WHY IT WAS THE MOST EXPENSIVE VERDICT OF THE NIGHT. The monitor said
/// "v0.131.0 built and STAGED as a draft… release-finalize.yml publishes v0.131.0 once its CI
/// concludes green." CI concluded green TWICE and nothing published, because the gate certifies the
/// draft's BUILD BASE and that base is red — permanently. The measured chain: tag v0.131.0 →
/// d2f98e73, which has ZERO workflow runs, so the gate falls back to its build base e3e8f146, whose
/// run named "CI" concluded `failure`; release-finalize run 32605085872 logged `gate rc=1 → BLOCKED`.
/// A false reassurance is worse than no message: it stops anyone from acting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateVerdict {
    /// The newest completed CI run for the SHA concluded `success`.
    Green,
    /// It concluded anything else. The draft will NEVER be auto-published.
    Red,
    /// A CI run exists but has not completed. Never read THROUGH a pending run to an older green —
    /// a red result could still be in flight, which is `cc_verdict`'s own discipline.
    Pending,
    /// No CI run exists for the SHA at all.
    None,
    /// We could not read the signal. NEVER Red and never Green: an unreadable gate must not
    /// manufacture either a false all-clear or a false permanent hold.
    Unknown,
}

/// Decide a gate verdict from `gh api "repos/<repo>/actions/runs?head_sha=<sha>&per_page=100"`.
///
/// PURE, and it mirrors `cc_verdict` rather than approximating it: filter to the workflow named
/// exactly [`CI_WORKFLOW_NAME`]; no run at all → `None`; ANY matching run not `completed` → `Pending`
/// (never read through to an older green); otherwise the newest run — GitHub returns them
/// newest-first, which covers reruns — and ONLY the literal conclusion `success` passes.
fn read_ci_gate_verdict(runs_json: &str) -> GateVerdict {
    read_ci_gate_reading(runs_json).0
}

/// The same decision, plus the id of the run the verdict came from. The id is what lets a `Red` be
/// re-examined at the JOBS level (see [`run_judged_nothing`]) — the reclassification `cc_gate`
/// performs and `cc_verdict` alone does not.
fn read_ci_gate_reading(runs_json: &str) -> (GateVerdict, Option<u64>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(runs_json.trim()) else {
        return (GateVerdict::Unknown, None);
    };
    let Some(runs) = value.get("workflow_runs").and_then(|r| r.as_array()) else {
        return (GateVerdict::Unknown, None);
    };
    let matches: Vec<&serde_json::Value> = runs
        .iter()
        .filter(|r| r.get("name").and_then(|n| n.as_str()) == Some(CI_WORKFLOW_NAME))
        .collect();
    let Some(newest) = matches.first() else {
        return (GateVerdict::None, None);
    };
    if matches.iter().any(|r| r.get("status").and_then(|s| s.as_str()) != Some("completed")) {
        return (GateVerdict::Pending, None);
    }
    let id = newest.get("id").and_then(|i| i.as_u64());
    if newest.get("conclusion").and_then(|c| c.as_str()) == Some("success") {
        (GateVerdict::Green, id)
    } else {
        (GateVerdict::Red, id)
    }
}

/// Did this run JUDGE ANYTHING, or did it merely fail to start?
///
/// WHY THIS EXISTS, and why omitting it inverts the whole feature. `cc_gate` is the function that
/// actually decides whether a draft publishes, and it is strictly weaker than `cc_verdict`: a
/// completed-`failure` run whose jobs never reached a runner is reclassified rather than treated as
/// a red tree (`_cc_blocked_check`, internal `rc=4`; the base-side twin `_cc_base_red_class` turns
/// a pure-infra base red into a HOLD, `rc=5/6`). The shell's own header records the unreclassified
/// shape as the one that made "EVERY release structurally unpublishable" — the common case, not a
/// corner.
///
/// Porting only `cc_verdict` therefore produced the exact harm this module exists to remove, merely
/// inverted: a draft whose tag run died at `Set up job` over a GREEN base would read `Blocking` with
/// "cut a NEW version from green main", telling an operator to burn a full signed, notarized build
/// to replace a release that was about to publish itself.
///
/// The test mirrors the shell's: a run judged nothing when it executed ZERO steps — no jobs at all,
/// or every job's step list empty, or the single synthetic `Set up job` step being the only one and
/// itself failed. A step-less job BESIDE a sibling that did execute is NOT this shape (that is a
/// real, if odd, failure) and returns false, which is the fail-closed direction: we only ever soften
/// a Red when we can positively see that nothing was judged.
fn run_judged_nothing(jobs_json: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(jobs_json.trim()) else {
        return false;
    };
    // Accept the `{total_count, jobs:[…]}` envelope OR a bare array, exactly as the shell does.
    let (jobs, total_count) = match value.as_array() {
        Some(arr) => (arr.clone(), None),
        None => (
            value.get("jobs").and_then(|j| j.as_array()).cloned().unwrap_or_default(),
            value.get("total_count").and_then(|t| t.as_u64()),
        ),
    };
    // TRUNCATION IS NOT ZERO — and this is the one misread the shell calls the most dangerous
    // available here. The jobs endpoint is paginated; a short page must never read as "nothing else
    // failed", or a genuinely red run is waved through to the base fallback. A payload carrying NO
    // total_count (a bare array, a hand-built fixture) is never treated as truncated: the guard
    // requires the field to be PRESENT before it can fire.
    if let Some(total) = total_count {
        if total > jobs.len() as u64 {
            return false;
        }
    }
    // THE NUMERATOR IS THE FAILED JOBS, NOT THE WHOLE RUN. Counting executed steps across every job
    // makes this predicate INERT for the shape it exists to catch: one green sibling contributes
    // executed steps and the run reads as "judged". The measured release-bump run is exactly that —
    // nine self-hosted jobs PASS with full step lists while the hosted Rust jobs fail having
    // executed nothing — so a whole-run count answers "judged" on precisely the case that blocks
    // the release. Green siblings are STRONGER evidence, not weaker: they prove the suite really
    // ran, leaving only jobs that were never placed on a runner and judged no code at all.
    //
    // Succeeded, SKIPPED and NEUTRAL jobs are excluded deliberately: a path-filtered job is
    // `completed/skipped` with zero steps, so counting it as "never ran" would make almost every run
    // look unjudged. Jobs that are not `completed` are excluded too — they have rendered no verdict.
    let failed: Vec<&serde_json::Value> = jobs
        .iter()
        .filter(|j| j.get("status").and_then(|s| s.as_str()) == Some("completed"))
        .filter(|j| {
            let c = j
                .get("conclusion")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            c != "success" && c != "skipped" && c != "neutral"
        })
        .collect();
    // At least one FAILED job is required. An empty jobs array, or a run whose failure is not
    // attributable to any completed-failed job (a `startup_failure` from a broken workflow file),
    // establishes NOTHING positively — and softening is the fail-OPEN direction, so it stays Red.
    if failed.is_empty() {
        return false;
    }
    // A job that never got a runner reports either NO steps, or exactly ONE — GitHub's synthetic
    // `Set up job` — concluding failure. Every other step counts, INCLUDING a SUCCEEDED `Set up
    // job`, so a job dying at its first real step counts 2 and can never be mistaken for one that
    // never started. (The measured shape is steps=1, not steps=0, so a literal `steps == 0` is wrong.)
    failed.iter().all(|job| {
        let steps = job.get("steps").and_then(|s| s.as_array());
        let executed = match steps {
            None => 0,
            Some(steps) => steps
                .iter()
                .filter(|st| {
                    let is_synthetic_setup_failure = st.get("number").and_then(|n| n.as_u64())
                        == Some(1)
                        && st.get("name").and_then(|n| n.as_str()) == Some("Set up job")
                        && st
                            .get("conclusion")
                            .and_then(|c| c.as_str())
                            .unwrap_or("")
                            .to_ascii_lowercase()
                            != "success";
                    !is_synthetic_setup_failure
                })
                .count(),
        };
        executed == 0
    })
}

/// Read `.sha` and the FIRST parent's `.sha` from `gh api "repos/<repo>/commits/<tag>"`. The first
/// parent is the BUILD BASE: the tagged commit is the version bump sitting on top of it, which is
/// why `cc_gate` certifies the base when the tag itself has no run.
fn read_commit_and_base(json: &str) -> Option<(String, Option<String>)> {
    let value: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let sha = value.get("sha")?.as_str()?.to_string();
    let base = value
        .get("parents")
        .and_then(|p| p.as_array())
        .and_then(|p| p.first())
        .and_then(|p| p.get("sha"))
        .and_then(|s| s.as_str())
        .map(str::to_string);
    Some((sha, base))
}

/// Resolve one draft tag's gate verdict, following `cc_gate`'s ORDER **and its reclassifications**:
/// the tag commit first, falling back to the build base when the tag has no CI run — or when its run
/// FAILED WITHOUT JUDGING ANYTHING (see [`run_judged_nothing`]). Any read failure is `Unknown`.
///
/// THE RECLASSIFICATION IS NOT OPTIONAL. `cc_gate`, not `cc_verdict`, is what decides whether a
/// draft publishes, and it routes an unjudged red past itself rather than blocking on it. Mirroring
/// only `cc_verdict` reported a draft over a GREEN base as a permanent hold and told the operator to
/// cut a new signed build to replace a release that was about to ship itself.
///
/// A `Red` that judged nothing NEVER becomes `Red` here. On the tag it triggers the base fallback
/// (`cc_gate`'s `rc=4`); on the BASE it becomes `Unknown`, which is the HOLD direction (`rc=5/6`) —
/// unknown never claims a permanent block and never claims an all-clear.
///
/// `fetch` maps a `gh api` path to its body, so the whole decision is testable without a network —
/// the shell that actually runs `gh` is the only uncovered part.
fn resolve_draft_gate<F>(tag: &str, fetch: &F) -> GateVerdict
where
    F: Fn(&str) -> Option<String>,
{
    // Returns the verdict with an unjudged red already collapsed to `None`, so the caller's match
    // treats "no run" and "a run that judged nothing" identically — which is what `cc_gate` does.
    let gate_at = |sha: &str| -> GateVerdict {
        let Some(body) =
            fetch(&format!("repos/{RELEASE_REPO}/actions/runs?head_sha={sha}&per_page=100"))
        else {
            return GateVerdict::Unknown;
        };
        let (verdict, run_id) = read_ci_gate_reading(&body);
        if verdict != GateVerdict::Red {
            return verdict;
        }
        // A red we cannot re-examine stays Red: we only ever SOFTEN on positive evidence that the
        // run judged nothing, never on a failed lookup.
        let Some(run_id) = run_id else { return GateVerdict::Red };
        match fetch(&format!("repos/{RELEASE_REPO}/actions/runs/{run_id}/jobs?per_page=100")) {
            Some(jobs) if run_judged_nothing(&jobs) => GateVerdict::None,
            _ => GateVerdict::Red,
        }
    };
    let Some(commit) = fetch(&format!("repos/{RELEASE_REPO}/commits/{tag}")) else {
        return GateVerdict::Unknown;
    };
    let Some((sha, base)) = read_commit_and_base(&commit) else {
        return GateVerdict::Unknown;
    };
    match gate_at(&sha) {
        // No run, or a run that judged nothing: both route to the build base.
        GateVerdict::None => match base {
            Some(base) if base != sha => match gate_at(&base) {
                // The BASE judged nothing either — that is a HOLD, not a permanent block. Reporting
                // Red here is what would manufacture the false "cut a NEW version" instruction.
                GateVerdict::None => GateVerdict::Unknown,
                v => v,
            },
            _ => GateVerdict::None,
        },
        verdict => verdict,
    }
}

/// Resolve the gate for EVERY draft version. Drafts are normally zero or one, so the two `gh api`
/// calls each costs are not a hot path.
fn resolve_draft_gates<F>(
    drafts: &[Version],
    fetch: &F,
) -> std::collections::BTreeMap<Version, GateVerdict>
where
    F: Fn(&str) -> Option<String>,
{
    drafts.iter().map(|v| (*v, resolve_draft_gate(&v.to_string(), fetch))).collect()
}

/// The acceptance file `.github/workflows/release-reconcile.yml` already honours, read relative to
/// the project root. Landed by PR #2451; its header is the spec this module implements.
const ORPHAN_BASELINE_PATH: &str = ".github/release-orphan-baseline.txt";

/// The parsed acceptance file: which orphan tags, and which stuck drafts, have already been DECIDED
/// about.
///
/// TWO NAMESPACES, AND KEEPING THEM APART IS LOAD-BEARING — the file header says so and the shell
/// side enforces it by test. A bare `vX.Y.Z` line records "this tag was abandoned"; only a
/// `draft:vX.Y.Z` line records "this draft will never publish and we accept that". Sharing one flat
/// list would let every tag already recorded as an abandoned orphan retroactively silence a stuck
/// draft on that same tag — and release.yml's documented `existing_tag` recovery re-cuts against
/// exactly those tags, so a real FUTURE draft would be pre-cleared before anyone decided anything.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ReleaseBaseline {
    /// Accepted ORPHAN TAGS — a tag with no release object behind it, and only that.
    tags: std::collections::BTreeSet<Version>,
    /// Accepted STUCK DRAFTS — a draft that can never publish, and only that.
    drafts: std::collections::BTreeSet<Version>,
}

/// Parse `.github/release-orphan-baseline.txt`. PURE, and deliberately the same parse as
/// `rr_baseline_tags` in `scripts/lib/release-reconcile.sh`: strip `#` comments (whole-line or
/// trailing), strip surrounding whitespace and a trailing CR, drop blank lines. A `draft:` prefix
/// selects the drafts namespace; anything else is read as a bare tag. A line we cannot parse as a
/// version is IGNORED rather than fatal — the file is prose-heavy by design, and a typo must not
/// take the whole acceptance list down with it.
fn read_orphan_baseline(text: &str) -> ReleaseBaseline {
    let mut baseline = ReleaseBaseline::default();
    for raw in text.lines() {
        let line = match raw.find('#') {
            Some(i) => &raw[..i],
            None => raw,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("draft:") {
            if let Some(v) = parse_version(rest.trim()) {
                baseline.drafts.insert(v);
            }
        } else if let Some(v) = parse_version(line) {
            baseline.tags.insert(v);
        }
    }
    baseline
}

/// The sentence that states what the baseline accepted — or that it could not be read at all.
///
/// THE FILE ACCEPTS HISTORY, IT DOES NOT FORGIVE IT, so the accepted counts are ALWAYS stated
/// wherever there was anything to accept: filtering an orphan out of the finding must never make it
/// invisible. And a MISSING OR UNREADABLE baseline FAILS LOUD rather than green — nothing is
/// accepted, every orphan still counts, and the detail says the file could not be read, because an
/// unreadable acceptance file silently read as blanket acceptance is how a real orphan would vanish.
fn baseline_note(
    baseline: Option<&ReleaseBaseline>,
    accepted_tags: usize,
    accepted_drafts: usize,
) -> String {
    if baseline.is_none() {
        return format!(
            " {ORPHAN_BASELINE_PATH} could not be read, so nothing is treated as accepted and every \
             orphan below is still counted."
        );
    }
    let mut parts = Vec::new();
    if accepted_tags > 0 {
        parts.push(format!("{accepted_tags} orphan tag(s)"));
    }
    if accepted_drafts > 0 {
        parts.push(format!("{accepted_drafts} stuck draft(s)"));
    }
    if parts.is_empty() {
        return String::new();
    }
    format!(" {} are accepted in {ORPHAN_BASELINE_PATH}.", parts.join(" and "))
}

/// Classify RELEASE PUBLICATION: is what was BUILT actually PUBLISHED where users can get it?
///
/// WHY THIS COMPONENT EXISTS (2026-08-20): a fully built, fully NOTARIZED v0.120.0 DMG was discarded
/// because the release CI gate could not obtain a verdict, and the audit that followed found FIFTEEN
/// tags on `drodio/sparkle` with no GitHub Release behind them, plus one stuck draft (v0.111.0,
/// carrying a 404-byte `.sig` and no DMG). Throughout ALL of it this module reported GREEN, because
/// [`classify_release_runner`] reads only the RUNNERS endpoint and the release Mac was online and
/// idle the entire time. A runner being up says a DMG CAN be built; it says nothing about whether
/// one ever reached a user, and the founder's only other signal was an auto-updater telling him he
/// was up to date while two versions of merged work sat unshipped.
///
/// The severity question is the module's standard one — does this PREVENT a deployment?
///   * a tag or draft strictly ABOVE the newest published version → BLOCKING. The work is built and
///     users cannot get it. That is a deployment that did not happen, not a degraded one.
///   * orphan tags/drafts entirely BELOW the high-water mark → WARNING. Stale publication debris
///     worth clearing (the v0.111.0 draft against a shipped v0.118.0); nothing current is stuck.
///   * releases or tags unreadable → UNKNOWN, never Healthy. A probe that could not read its signal
///     presenting as fine is precisely the silence this whole module exists to end.
///
/// PURE: it takes the newest published version, the drafts and the tags as already-read data, so
/// every branch is tested from fixtures with no `gh` and no network.
fn classify_release_publication(
    releases: Option<&ReleasesReading>,
    tags: Option<&[String]>,
    baseline: Option<&ReleaseBaseline>,
    draft_gates: &std::collections::BTreeMap<Version, GateVerdict>,
) -> (HealthState, String) {
    let Some(releases) = releases else {
        return (
            HealthState::Unknown,
            format!(
                "could not read {PUBLIC_RELEASE_REPO} releases from GitHub — cannot tell whether \
                 built versions have been published to users."
            ),
        );
    };
    let Some(tags) = tags else {
        return (
            HealthState::Unknown,
            format!(
                "could not read {RELEASE_REPO} tags from GitHub — cannot tell whether built \
                 versions have been published to users."
            ),
        );
    };

    // Everything below is set membership plus ORDERED comparison over parsed versions. Fail closed
    // at each step: a list we read but could not parse a single version out of is UNKNOWN, because
    // treating it as empty would silently report the unpublished state as fine.
    let published: std::collections::BTreeSet<Version> =
        releases.published.iter().filter_map(|t| parse_version(t)).collect();
    if !releases.published.is_empty() && published.is_empty() {
        return (
            HealthState::Unknown,
            "published releases carry no recognizable vMAJOR.MINOR.PATCH tag — cannot tell what has \
             shipped."
                .to_string(),
        );
    }
    let mut drafts: Vec<Version> = releases.drafts.iter().filter_map(|t| parse_version(t)).collect();
    if !releases.drafts.is_empty() && drafts.is_empty() {
        return (
            HealthState::Unknown,
            "draft releases carry no recognizable vMAJOR.MINOR.PATCH tag — cannot tell what is \
             waiting to be published."
                .to_string(),
        );
    }
    let tagged: Vec<Version> = tags.iter().filter_map(|t| parse_version(t)).collect();
    if !tags.is_empty() && tagged.is_empty() {
        return (
            HealthState::Unknown,
            format!(
                "no recognizable vMAJOR.MINOR.PATCH tag among the {RELEASE_REPO} tags read — cannot \
                 tell what has been built."
            ),
        );
    }

    let high_water = published.iter().copied().max();
    // The OLDEST release we read bounds the window we can speak about: the reads are one page each,
    // so a tag older than that is one we simply did not go back far enough to judge. Calling it an
    // orphan would manufacture a permanent warning out of a page boundary rather than out of the
    // pipeline.
    let floor = published.iter().copied().min();

    let draft_set: std::collections::BTreeSet<Version> = drafts.iter().copied().collect();
    let mut orphans: Vec<Version> = tagged
        .iter()
        .copied()
        .filter(|v| !published.contains(v))
        .filter(|v| floor.map(|f| *v >= f).unwrap_or(true))
        // A version that has a draft is reported as a stuck draft, not counted twice.
        .filter(|v| !draft_set.contains(v))
        .collect();
    orphans.sort_unstable();
    orphans.dedup();
    drafts.sort_unstable();
    drafts.dedup();

    // THE ACCEPTANCE FILTER (bead `sparkle-6yit8m`). Every claim in the hourly warning "20 tags with
    // no release … all below the newest published release v0.132.0" was TRUE, and that was the
    // problem: those 20 orphans are discarded builds nobody will ever publish, and
    // `scripts/release-reconcile.sh` is report-only by design because a tag is the ONLY surviving
    // evidence of what a discarded build was cut from. A WARNING on a permanent accepted condition
    // is indistinguishable from one on a new failure, so the channel that would report a genuine
    // publication failure became noise everyone skims past.
    //
    // The filter is applied BEFORE the above/below-high-water split, deliberately: a baseline entry
    // is a recorded decision that the version is abandoned, and that decision does not depend on
    // where the version happens to sit relative to what shipped afterwards.
    let (accepted_orphans, orphans): (Vec<Version>, Vec<Version>) = orphans
        .into_iter()
        .partition(|v| baseline.map(|b| b.tags.contains(v)).unwrap_or(false));
    let (accepted_drafts, drafts): (Vec<Version>, Vec<Version>) = drafts
        .into_iter()
        .partition(|v| baseline.map(|b| b.drafts.contains(v)).unwrap_or(false));
    let note = baseline_note(baseline, accepted_orphans.len(), accepted_drafts.len());
    let nothing_accepted = accepted_orphans.is_empty() && accepted_drafts.is_empty();

    // HELD BY GATE vs IN FLIGHT (bead `sparkle-6yit8m`, FIX 4). The old message said
    // "release-finalize.yml publishes v0.131.0 once its CI concludes green". CI concluded green
    // TWICE and nothing published, because the gate certifies the draft's BUILD BASE and that base
    // is red — permanently. A draft whose gate is RED is the DESIGNED end state: release-finalize
    // deliberately keeps it for forensics and will never auto-publish it. So it is informational,
    // not debris implying someone should act, and it must never be described as pending on CI.
    let (held_drafts, drafts): (Vec<Version>, Vec<Version>) =
        drafts.into_iter().partition(|v| draft_gates.get(v) == Some(&GateVerdict::Red));

    // Strictly ABOVE the published high-water mark is built work users cannot get. With NOTHING
    // published, every tag and draft is above the (empty) mark.
    //
    // ORPHANS AND DRAFTS ARE SPLIT HERE, and the split is the difference between an alarm worth
    // acting on and one that fires on every healthy release (roborev finding, Medium).
    // release.yml pushes the tag BEFORE it publishes, so from the tag push until the flip there is
    // always a window where a version is tagged and not yet published. Counting that as Blocking
    // reds the indicator on every normal cut, and an indicator that is red routinely is one nobody
    // reads — which is the failure this component exists to remove, reintroduced.
    //
    // The discriminator needs no clock: a DRAFT existing for that version means the release object
    // is there with its assets attached and something will flip it (release.yml on a green gate, or
    // release-finalize.yml once CI concludes). That is in-flight -> Warning. A tag with NO release
    // object at all has nothing staged and nothing scheduled to act; it stays stranded until a human
    // re-dispatches -> Blocking. That is precisely the v0.119.0 / v0.120.0 shape, and precisely NOT
    // the shape of a release that is merely mid-flight.
    let is_above = |v: &Version| high_water.map(|h| *v > h).unwrap_or(true);
    let above_orphans: Vec<Version> = orphans.iter().copied().filter(|v| is_above(v)).collect();
    let above_drafts: Vec<Version> = drafts.iter().copied().filter(|v| is_above(v)).collect();
    let above_held: Vec<Version> = held_drafts.iter().copied().filter(|v| is_above(v)).collect();
    let below_held: Vec<Version> = held_drafts.iter().copied().filter(|v| !is_above(v)).collect();
    let shipped = match high_water {
        Some(h) => format!("the newest release users can get is {h}"),
        None => format!("{PUBLIC_RELEASE_REPO} has no published release at all"),
    };
    let held = held_clause(&below_held);

    // 1. A STRANDED TAG above the mark. Nothing is staged and nothing is scheduled to act, so this
    //    is the worst fact available and it outranks every draft state.
    if let Some(newest) = above_orphans.iter().copied().max() {
        return (
            HealthState::Blocking,
            format!(
                "{} built but NOT published — {shipped}. The auto-updater serves \
                 {PUBLIC_RELEASE_REPO}'s newest release, so this work has shipped to nobody. \
                 There is no release object at all for {newest} — not even a draft — so nothing is \
                 scheduled to publish it. Re-dispatch release.yml with existing_tag={newest}.{held}{note}",
                name_versions(&above_orphans)
            ),
        );
    }

    // 2. A RED-GATED DRAFT above the mark. Built work users cannot get, which will NEVER publish
    //    itself — Blocking. And the remediation must NOT send anyone back to this tag: release.yml's
    //    own error text says "re-dispatching this tag re-hits the same red run", and anyone who
    //    follows the old advice burns a full signed, notarized build for nothing.
    if !above_held.is_empty() {
        return (
            HealthState::Blocking,
            format!(
                "{} built and staged as a draft but HELD BY GATE — {shipped}. The build base's CI \
                 concluded RED, so release-finalize.yml will NEVER publish it: this is built work \
                 users cannot get and nothing will ship it on its own. Cut a NEW version from green \
                 main — building this same tag again would only hit the same red run.{note}",
                name_versions(&above_held)
            ),
        );
    }

    // 3. An IN-FLIGHT draft above the mark: gate green, pending, run-less or unreadable. Something
    //    may yet flip it, so the existing in-flight wording is still true in those states.
    if let Some(newest) = above_drafts.iter().copied().max() {
        return (
            HealthState::Warning,
            format!(
                "{} built and STAGED as a draft, not yet published — {shipped}. The assets are \
                 attached, so no rebuild is needed: release-finalize.yml publishes {newest} once \
                 its CI concludes green. If this persists across several CI runs, read that \
                 workflow's summary.{held}{note}",
                name_versions(&above_drafts)
            ),
        );
    }

    // 4. Nothing above the mark. What is left is debris below it — plus, possibly, a held draft,
    //    which is stated but does NOT itself raise a warning.
    let mut parts = Vec::new();
    if !orphans.is_empty() {
        parts.push(format!(
            "{} tag{} with no release ({})",
            orphans.len(),
            if orphans.len() == 1 { "" } else { "s" },
            name_versions(&orphans)
        ));
    }
    if !drafts.is_empty() {
        parts.push(format!(
            "{} stuck draft release{} ({})",
            drafts.len(),
            if drafts.len() == 1 { "" } else { "s" },
            name_versions(&drafts)
        ));
    }

    if parts.is_empty() {
        let detail = match high_water {
            // Nothing found, nothing accepted, nothing held: the plain all-clear, unchanged.
            Some(h) if nothing_accepted && below_held.is_empty() && baseline.is_some() => format!(
                "every version tag has a published release on {PUBLIC_RELEASE_REPO}; the newest \
                 users can get is {h}."
            ),
            // Everything outstanding is either accounted for in the baseline or held by a red gate.
            // Healthy — but the accepted counts and the held draft are stated, so nothing is hidden.
            Some(h) => format!(
                "no unaccounted orphan tag or stuck draft on {PUBLIC_RELEASE_REPO}; the newest \
                 users can get is {h}.{held}{note}"
            ),
            None if nothing_accepted => {
                "no version tags and no releases yet — nothing is waiting to be published."
                    .to_string()
            }
            // Accepted debris with NOTHING published at all: we have no high-water mark, so we
            // cannot say whether anything current is stuck. Fail toward "cannot tell", never green.
            None => {
                return (
                    HealthState::Unknown,
                    format!(
                        "accepted orphan tags or drafts exist but {PUBLIC_RELEASE_REPO} has no \
                         published release at all — cannot rank them.{note}"
                    ),
                )
            }
        };
        return (HealthState::Healthy, detail);
    }

    match high_water {
        Some(h) => (
            HealthState::Warning,
            format!(
                "{} — all below the newest published release {h}, so nothing current is stuck. \
                 Stale publication debris worth clearing.{held}{note}",
                parts.join(" and ")
            ),
        ),
        // Unreachable: with nothing published, every orphan/draft is above the empty high-water mark
        // and was reported above. Fail toward the honest "cannot tell", never toward green.
        None => (
            HealthState::Unknown,
            "orphan tags or drafts exist but nothing is published — cannot rank them.".to_string(),
        ),
    }
}

/// The sentence for a draft that is HELD BY GATE below the high-water mark.
///
/// It must read as "there is nothing to do here", because there genuinely is not: the draft cannot
/// publish, nothing in this repo discards it, and release-finalize deliberately keeps it for
/// forensics. It names the TWO real remedies, and it never suggests re-dispatching the tag — that is
/// the one action release.yml explicitly forbids, and following it burns a full signed notarized
/// build for nothing.
fn held_clause(held: &[Version]) -> String {
    let Some(newest) = held.iter().copied().max() else {
        return String::new();
    };
    format!(
        " {} {} HELD BY GATE — the build base's CI concluded RED, so release-finalize.yml keeps the \
         draft for forensics and will never auto-publish it. That is the designed end state, not \
         something to chase: either cut a NEW version from green main, or record it as \
         draft:{newest} in {ORPHAN_BASELINE_PATH}.",
        name_versions(held),
        if held.len() == 1 { "is a draft" } else { "are drafts" }
    )
}

// ── knightwatch / sparkle-reviewer (the PR-scoped reviewer) ─────────────────────────────────────
//
// The configured reviewer today is `sparkle-reviewer` (`scripts/pr-review.sh`): ONE local `claude`
// call under the user's own login, dispatched per push by the app's babysit sweep. It is not a
// daemon this app can ping, so its liveness is read from its OUTPUT — the review comments it posts,
// each stamped `<!-- sparkle-reviewer:auto-post -->`. A reviewer that is live has posted a review
// recently; one that has stopped leaves open PRs sitting unreviewed. That is the freshness signal
// [`classify_knightwatch`] classifies, replacing the flat "liveness is not yet monitored" Unknown.

/// Marker every sparkle-reviewer review comment carries (stamped by `scripts/pr-review.sh`). It is
/// how both merge gates already recognise a review, so it is the right liveness fingerprint too.
const REVIEWER_COMMENT_MARKER: &str = "sparkle-reviewer:auto-post";

/// How fresh the newest review must be for the reviewer to read as live. Reviews are dispatched per
/// push by the app's babysit sweep, so a couple of days without one — WHILE PRs wait — is the signal
/// that the reviewer has stopped, not a quiet minute. Generous on purpose: a probe that cries wolf
/// on an idle afternoon gets muted, and then misses the real outage.
const KNIGHTWATCH_FRESH_SECS: u64 = 48 * 3600;

/// The liveness reading for the PR reviewer, assembled from GitHub by [`read_knightwatch_liveness`].
/// A `None` from that reader means the signal was UNREADABLE (-> Unknown); this struct is built only
/// once a reading succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
struct KnightwatchLiveness {
    /// Age in seconds of the newest sparkle-reviewer review comment found, or `None` when none was
    /// seen in the scanned window (never posted, or older than the window).
    last_review_age_secs: Option<u64>,
    /// Whether the repo has at least one OPEN PR — work the reviewer would be expected to cover.
    /// Distinguishes a genuinely-idle reviewer (no PRs) from a silent-but-should-be-working one.
    has_open_prs: bool,
}

/// Current wall-clock as a Unix epoch in seconds. `0` if the clock is before the epoch (never on a
/// real machine); an age computed against it then clamps to `0` and reads as "just now" — the
/// fail-safe direction for a liveness probe (Healthy, not a false stale-warning).
fn now_epoch_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Days since the Unix epoch for a civil (proleptic Gregorian) date — Howard Hinnant's algorithm,
/// exact for every date GitHub emits. This crate has no date/time dependency, so the arithmetic
/// lives here.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Parse a GitHub RFC3339 timestamp (`YYYY-MM-DDTHH:MM:SSZ`) to a Unix epoch in seconds. `None` on
/// any shape we do not recognise — a timestamp we cannot parse must never read as "just now".
fn github_ts_to_epoch(ts: &str) -> Option<i64> {
    let ts = ts.trim().trim_end_matches('Z');
    let (date, time) = ts.split_once('T')?;
    let mut dp = date.split('-');
    let y: i64 = dp.next()?.parse().ok()?;
    let mo: i64 = dp.next()?.parse().ok()?;
    let d: i64 = dp.next()?.parse().ok()?;
    let mut tp = time.split(':');
    let h: i64 = tp.next()?.parse().ok()?;
    let mi: i64 = tp.next()?.parse().ok()?;
    // Seconds may carry a fractional part on some payloads; take the integer part.
    let s: i64 = tp.next().unwrap_or("0").split('.').next()?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s)
}

/// Age in seconds of `ts` measured against `now_epoch`. `None` if `ts` is unparseable; clamped to
/// `0` for a timestamp in the future (clock skew), which reads as fresh — the fail-safe direction.
fn github_ts_age_secs(ts: &str, now_epoch: i64) -> Option<u64> {
    let then = github_ts_to_epoch(ts)?;
    Some((now_epoch - then).max(0) as u64)
}

/// The newest sparkle-reviewer review timestamp in a `gh api .../issues/comments` payload, or `None`
/// if no comment in the page carries the marker. Takes the MAX `updated_at` (RFC3339 sorts
/// chronologically as text) rather than trusting the request's sort order.
fn newest_reviewer_comment_ts(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let items = value.as_array()?;
    let mut newest: Option<String> = None;
    for c in items {
        let body = c.get("body").and_then(|b| b.as_str()).unwrap_or("");
        if !body.contains(REVIEWER_COMMENT_MARKER) {
            continue;
        }
        let ts = c
            .get("updated_at")
            .and_then(|t| t.as_str())
            .or_else(|| c.get("created_at").and_then(|t| t.as_str()));
        if let Some(ts) = ts {
            if newest.as_deref().map_or(true, |n| ts > n) {
                newest = Some(ts.to_string());
            }
        }
    }
    newest
}

/// Whether a `gh api .../pulls?state=open` payload lists at least one open PR. A non-array (an error
/// body) reads as `false` — the fail-safe direction: it never manufactures "work is waiting".
fn has_open_prs_from_json(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json.trim())
        .ok()
        .and_then(|v| v.as_array().map(|a| !a.is_empty()))
        .unwrap_or(false)
}

/// Render a seconds age as a short human string for the panel detail.
fn humanize_age(secs: u64) -> String {
    if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

/// Classify the PR reviewer from its liveness reading.
///
///   * `pr_reviewer = "none"` → `NotApplicable`. The reviewer is deliberately off; excluded from the
///     fold rather than dragging the icon amber.
///   * `liveness == None` → `Unknown`. The signal could not be read (auth lapse / 503) — honest
///     visibility gap, never a fabricated verdict.
///   * a review posted within [`KNIGHTWATCH_FRESH_SECS`] → `Healthy` — the reviewer is demonstrably
///     posting reviews.
///   * no fresh review WHILE open PRs wait → `Warning` — it appears to have stopped, with the exact
///     manual-restart command in the detail.
///   * no fresh review and NO open PRs → `Healthy` (idle): nothing to review, and the reviewer runs
///     on demand, so silence is expected and not a fault.
fn classify_knightwatch(
    has_no_reviewer: bool,
    reviewer_name: &str,
    liveness: Option<&KnightwatchLiveness>,
) -> (HealthState, String) {
    if has_no_reviewer {
        return (
            HealthState::NotApplicable,
            "no PR-review bot is configured for this repo (pr_reviewer = none).".to_string(),
        );
    }
    let Some(l) = liveness else {
        return (
            HealthState::Unknown,
            format!(
                "could not read '{reviewer_name}' review activity from GitHub — pipeline visibility \
                 is degraded; check its host directly."
            ),
        );
    };
    const RESTART: &str = "Reviews are dispatched by the app's babysit sweep; run \
                           `scripts/pr-review.sh <PR#> --post` to review manually.";
    match l.last_review_age_secs {
        Some(age) if age <= KNIGHTWATCH_FRESH_SECS => (
            HealthState::Healthy,
            format!("'{reviewer_name}' posted a review {} ago — the reviewer is live.", humanize_age(age)),
        ),
        Some(age) if l.has_open_prs => (
            HealthState::Warning,
            format!(
                "'{reviewer_name}' last posted a review {} ago and open PR(s) are waiting — the \
                 reviewer may not be running. {}",
                humanize_age(age),
                RESTART
            ),
        ),
        Some(age) => (
            HealthState::Healthy,
            format!(
                "'{reviewer_name}' last posted a review {} ago; no open PRs are awaiting review.",
                humanize_age(age)
            ),
        ),
        None if l.has_open_prs => (
            HealthState::Warning,
            format!(
                "no recent '{reviewer_name}' review was found and open PR(s) are waiting — the \
                 reviewer may not be running. {}",
                RESTART
            ),
        ),
        None => (
            HealthState::Healthy,
            format!("no open PRs are awaiting review; '{reviewer_name}' runs on demand."),
        ),
    }
}

/// Read the PR reviewer's liveness from GitHub. `None` (-> Unknown) ONLY when the PRIMARY read (the
/// repo's recent issue comments) could not be performed — an auth lapse or a 503, the same fail-safe
/// as every other component. A successful read with no reviewer comment in it is a real answer
/// ("no recent review"), not an unreadable one.
fn read_knightwatch_liveness(gh_program: Option<&str>, root: &str) -> Option<KnightwatchLiveness> {
    let program = gh_program?;
    let comments = gh_api_text(
        program,
        root,
        &format!("repos/{RELEASE_REPO}/issues/comments?sort=updated&direction=desc&per_page=100"),
    )?;
    let last_review_age_secs =
        newest_reviewer_comment_ts(&comments).and_then(|ts| github_ts_age_secs(&ts, now_epoch_secs()));
    // Open-PR presence refines stale/never into warn-vs-idle. A failed read defaults to `false` —
    // the fail-safe direction, so an unreadable PR list never manufactures a stale-warning.
    let has_open_prs = gh_api_text(program, root, &format!("repos/{RELEASE_REPO}/pulls?state=open&per_page=1"))
        .map(|j| has_open_prs_from_json(&j))
        .unwrap_or(false);
    Some(KnightwatchLiveness { last_review_age_secs, has_open_prs })
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

/// Keep any child from blocking on a prompt. Mirrors the per-module copy in `worktree.rs` /
/// `roborev_probe.rs` (house precedent is one copy per module rather than a shared import).
fn apply_noninteractive(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "true");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.env("GH_NO_UPDATE_NOTIFIER", "1");
}

/// Run `roborev status` in `root`, mapping the outcome to a [`StatusProbe`]. A timeout becomes
/// [`StatusProbe::TimedOut`] specifically — that is the wedge signal, not a generic failure.
fn probe_roborev_status(program: &str, root: &str) -> StatusProbe {
    let mut cmd = Command::new(program);
    cmd.arg("status").current_dir(root);
    apply_noninteractive(&mut cmd);
    match crate::worktree::output_with_timeout(cmd, ROBOREV_STATUS_TIMEOUT) {
        Ok(o) if o.status.success() => {
            StatusProbe::Text(String::from_utf8_lossy(&o.stdout).into_owned())
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            let stdout = String::from_utf8_lossy(&o.stdout);
            StatusProbe::Failed(format!("{stderr}\n{stdout}"))
        }
        Err(e) if e.contains("timed out") => StatusProbe::TimedOut,
        Err(e) => StatusProbe::Failed(e),
    }
}

/// Is the roborev LaunchAgent loaded? Best-effort refinement of a not-running result (wedged vs
/// down). `None` when we cannot ask — non-macOS, or `launchctl` unavailable.
#[cfg(target_os = "macos")]
fn roborev_daemon_loaded() -> Option<bool> {
    let uid = users_uid()?;
    let out = Command::new("launchctl")
        .args(["print", &format!("gui/{uid}/co.plow.roborev-daemon")])
        .output()
        .ok()?;
    Some(out.status.success())
}

#[cfg(not(target_os = "macos"))]
fn roborev_daemon_loaded() -> Option<bool> {
    None
}

/// Is there a `roborev daemon` PROCESS? This is the reading that separates a daemon that is merely
/// SLOW (alive, behind a bloated store) from one that is genuinely DOWN — and the LaunchAgent
/// registration cannot answer it, because a registered agent whose process died still prints as
/// loaded. `None` when `pgrep` is unavailable or could not be run: unknown, never a guessed `false`.
/// `2026-08-23T19:58:53.437835-07:00` → epoch seconds. Accepts `Z`, `+HH:MM` and `+HHMM`, and an
/// optional fractional part. `None` on anything it cannot fully account for — an un-parseable
/// timestamp must never be treated as recent.
///
/// SEPARATE FROM [`github_ts_to_epoch`] deliberately, and not a duplicate of it: that one parses the
/// `YYYY-MM-DDTHH:MM:SSZ` GitHub emits and rejects everything else, while roborev writes a LOCAL
/// timestamp with a numeric UTC offset and microseconds. Feeding roborev's shape to the GitHub
/// parser returns `None` for every line, which fails safe but would make this evidence permanently
/// absent. Both share the crate's one [`days_from_civil`].
fn parse_rfc3339_epoch(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    if b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    if !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> {
        let f = s.get(a..z)?;
        if f.bytes().all(|c| c.is_ascii_digit()) { f.parse::<i64>().ok() } else { None }
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    // Fractional seconds carry no information we need, but an empty `.` is malformed.
    let rest = match s[19..].strip_prefix('.') {
        Some(frac) => {
            let n = frac.bytes().take_while(|c| c.is_ascii_digit()).count();
            if n == 0 {
                return None;
            }
            &frac[n..]
        }
        None => &s[19..],
    };
    let off = if rest.eq_ignore_ascii_case("z") {
        0
    } else {
        let sign: i64 = match rest.as_bytes().first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let body: String = rest[1..].chars().filter(|c| *c != ':').collect();
        if body.len() != 4 || !body.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let oh: i64 = body[0..2].parse().ok()?;
        let om: i64 = body[2..4].parse().ok()?;
        if oh > 23 || om > 59 {
            return None;
        }
        sign * (oh * 3600 + om * 60)
    };
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - off)
}

/// The value of a top-level `"<key>":"<value>"` string field on one line of roborev's error log
/// (it is line-delimited JSON). Tolerates whitespace after the colon; `None` when absent.
fn json_str_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\":");
    let at = line.find(&needle)?;
    let inner = line[at + needle.len()..].trim_start().strip_prefix('"')?;
    let end = inner.find('"')?;
    Some(&inner[..end])
}

/// The `"ts":"…"` field of one roborev error-log line, as epoch seconds.
fn json_ts_epoch(line: &str) -> Option<i64> {
    parse_rfc3339_epoch(json_str_field(line, "ts")?)
}

/// Does this line carry roborev's SQLite lock signature at all?
fn has_lock_contention(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("sqlite_busy") || lower.contains("database is locked")
}

/// Is this log line a lock collision on the SERVER path — the path that answers `roborev status`?
///
/// THIS PREDICATE IS THE WHOLE DISCRIMINATOR, and volume or recency alone could never be. Two
/// components log the lock signature and they answer DIFFERENT QUESTIONS:
///
/// * `worker: claim job: database is locked` — a worker losing the job-claim lock. At
///   `busy_timeout = 0` this is the EXPECTED idle background of a perfectly healthy daemon, because
///   workers poll for work continuously. It says nothing about whether a status read can get through.
/// * `server: get repo: database is locked` — the SERVER losing the lock. That is the same path
///   `roborev status` is starved on, so it is the only line that is evidence for the claim made here.
///
/// MEASURED (see [`MIN_SERVER_LOCK_LINES`]): 13,096 worker against 131 server lines over 40 days, and
/// ≥2 worker lines are present in 99.97% of idle 120-second windows. Ageing alone does not remove
/// that background — only the component does.
///
/// FAILS SAFE: if roborev ever drops or renames the `component` field this returns false, the
/// evidence goes absent, and the classifier keeps whichever verdict still offers a recovery command
/// — never the "do not restart" that a genuinely wedged daemon must not receive.
fn is_server_lock_line(line: &str) -> bool {
    has_lock_contention(line) && json_str_field(line, "component") == Some("server")
}

/// PURE half of [`roborev_recent_lock_evidence`]: does this log tail prove the STATUS PATH is losing
/// the lock right NOW?
///
/// Two independent fences, both load-bearing. Every line is aged by its OWN timestamp — a line whose
/// timestamp cannot be parsed is NOT counted, because the log is the one input where "cannot be aged"
/// and "is recent" must not collapse together, its tail being arbitrarily old bytes rather than a
/// window roborev chose to report. And only SERVER-path collisions count.
fn log_proves_recent_contention(text: &str, now_epoch: i64) -> bool {
    text.lines()
        .filter(|l| is_server_lock_line(l))
        .filter(|l| match json_ts_epoch(l) {
            // Absolute difference, so a clock skewed into the future is not read as ancient.
            Some(ts) => (now_epoch - ts).abs() <= LOCK_EVIDENCE_WINDOW_SECS,
            None => false,
        })
        .count()
        >= MIN_SERVER_LOCK_LINES
}

/// POSITIVE lock evidence, read from roborev's own error log.
///
/// This is the reading that separates a STARVED status read from a WEDGED daemon when the store is
/// NOT bloated — the one case where [`classify_not_answering`] would otherwise call a live daemon a
/// "genuine WEDGE" on the absence of store bloat alone. `None` = could not tell, which the
/// classifier treats as "not proven", never as "no contention".
fn roborev_recent_lock_evidence() -> Option<bool> {
    let home = std::env::var("HOME").ok()?;
    let log = std::path::Path::new(&home).join(".roborev/errors.log");
    let meta = std::fs::metadata(&log).ok()?;
    // Cheap fail-fast only: a log nobody has appended to since the window opened cannot hold a line
    // inside it. NECESSARY, NEVER SUFFICIENT — the per-line fence below is what actually decides.
    let age = std::time::SystemTime::now().duration_since(meta.modified().ok()?).ok()?;
    if age.as_secs() as i64 > LOCK_EVIDENCE_WINDOW_SECS {
        return Some(false);
    }
    let now = now_epoch_secs();
    let mut cmd = Command::new("tail");
    cmd.arg("-n").arg("200").arg(&log);
    match crate::worktree::output_with_timeout(cmd, Duration::from_secs(3)) {
        Ok(o) if o.status.success() => {
            Some(log_proves_recent_contention(&String::from_utf8_lossy(&o.stdout), now))
        }
        _ => None,
    }
}

fn roborev_daemon_alive() -> Option<bool> {
    let out = Command::new("pgrep").args(["-f", "roborev daemon"]).output().ok()?;
    Some(out.status.success())
}

/// Size of the roborev store in bytes — `reviews.db` plus its `-wal` sidecar, because an
/// uncheckpointed WAL is part of what has to be opened. `None` when it cannot be read (no `HOME`,
/// no such file): unknown, never `0`, which would be a positive claim that the store is small.
fn roborev_db_bytes() -> Option<u64> {
    let home = std::env::var("HOME").ok()?;
    let db = std::path::Path::new(&home).join(".roborev").join("reviews.db");
    let main = std::fs::metadata(&db).ok()?.len();
    let wal = std::fs::metadata(db.with_extension("db-wal")).map(|m| m.len()).unwrap_or(0);
    Some(main + wal)
}

/// The current user's numeric uid, for the launchd `gui/<uid>` domain. `None` if `id -u` is
/// unreadable.
#[cfg(target_os = "macos")]
fn users_uid() -> Option<String> {
    let out = Command::new("id").arg("-u").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Build the roborev component. `NotApplicable` when roborev is disabled for this repo or absent.
fn roborev_component(root: &str) -> ComponentHealth {
    let enabled = crate::preflight::cached_roborev_path().is_some()
        && crate::config::for_project(root).config.tools.roborev;
    let (state, detail) = if !enabled {
        (
            HealthState::NotApplicable,
            "roborev code review is turned off for this repo.".to_string(),
        )
    } else {
        // Safe to unwrap: `enabled` proved the path resolves.
        let program = crate::preflight::cached_roborev_path().unwrap();
        let status = probe_roborev_status(&program, root);
        // Collect the WHY-evidence for every non-answering shape, INCLUDING a timeout. A timeout
        // used to short-circuit to "wedged" without asking anything further, which is precisely how
        // a healthy daemon behind an 860MB store got reported as wedged (bead sparkle-4i8kd6).
        // Each reading costs a subprocess, so they are taken only for the shapes whose remedy
        // depends on them: a daemon that did not answer, or one that says it is not running.
        let not_answering = match &status {
            StatusProbe::TimedOut | StatusProbe::Failed(_) => true,
            StatusProbe::Text(out) => out
                .lines()
                .find(|l| l.trim_start().starts_with("Daemon:"))
                .is_some_and(|l| l.to_ascii_lowercase().contains("not running")),
        };
        let evidence = if not_answering {
            DaemonEvidence {
                loaded: roborev_daemon_loaded(),
                alive: roborev_daemon_alive(),
                db_bytes: roborev_db_bytes(),
                lock_evidence: roborev_recent_lock_evidence(),
            }
        } else {
            DaemonEvidence::default()
        };
        classify_roborev(&status, evidence)
    };
    ComponentHealth {
        id: "roborev".to_string(),
        name: "Code review (roborev)".to_string(),
        state,
        detail,
    }
}

/// Is a release being built right now? `Some(true)` when the release runner has a busy VM,
/// `Some(false)` when it is online but idle, `None` when the pool read failed (UNKNOWN — the
/// governor must not read this as "no release"). PURE, so the fleet-budget contract is unit-tested
/// without a network. Note the release runner is `Healthy` in BOTH the busy and idle cases (its
/// `HealthState` says nothing about in-progress), which is exactly why this boolean exists.
fn release_in_progress(reading: Option<RunnerPoolReading>) -> Option<bool> {
    reading.map(|r| r.online_busy > 0)
}

/// Build the CI-runner and release-runner components from ONE runners-endpoint read, plus the
/// structured `release_in_progress` signal the fleet CI-budget governor needs.
fn runner_components(
    gh_program: Option<String>,
    root: &str,
) -> (Vec<ComponentHealth>, Option<bool>) {
    let gh_program_for_queue = gh_program.clone();
    // One network read feeds both pools. `--paginate` + `--slurp` mirrors `pr_query_runners` in
    // `scripts/lib/pick-runner.sh`, and it is a CORRECTNESS fix rather than tuning: registrations
    // exceed the live-VM ceiling because stale/offline ghosts accrue until the reaper clears them, so
    // even `per_page=100` can drop the `sparkle-release` runner onto an unfetched page — which is
    // exactly how this module came to file an hourly P1 against a release Mac that was online and
    // idle. With `--slurp` the reply is a JSON ARRAY of `{total_count, runners}` page objects, which
    // `read_runner_pool` merges (it still accepts a lone object, so every stub and fixture is
    // unaffected).
    let json = gh_program.and_then(|program| {
        let mut cmd = Command::new(&program);
        cmd.arg("api")
            .arg("--paginate")
            .arg(format!("repos/{RELEASE_REPO}/actions/runners?per_page=100"))
            .arg("--slurp")
            .current_dir(root);
        apply_noninteractive(&mut cmd);
        match crate::worktree::output_with_timeout(cmd, RUNNER_QUERY_TIMEOUT) {
            Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
            _ => None,
        }
    });

    // The SECOND bounded read: how deep is the repo-wide queue? A failed read is `None`, never `0` —
    // "I could not see the backlog" and "there is no backlog" are the two facts whose collapse
    // produced the false RECOVERED (bead `sparkle-1xg2f6`).
    let queued = gh_program_for_queue.and_then(|program| {
        let mut cmd = Command::new(program);
        cmd.arg("api")
            .arg(format!("repos/{RELEASE_REPO}/actions/runs?status=queued&per_page=1"))
            .current_dir(root);
        apply_noninteractive(&mut cmd);
        match crate::worktree::output_with_timeout(cmd, RUNNER_QUERY_TIMEOUT) {
            Ok(o) if o.status.success() => read_queued_runs(&String::from_utf8_lossy(&o.stdout)),
            _ => None,
        }
    });

    let ci = json.as_deref().and_then(|j| read_runner_pool(j, CI_RUNNER_LABEL));
    let release = json.as_deref().and_then(|j| read_runner_pool(j, RELEASE_RUNNER_LABEL));
    let (ci_state, ci_detail) = classify_ci_pool(ci, queued);
    let (rel_state, rel_detail) = classify_release_runner(release);

    let components = vec![
        ComponentHealth {
            id: "ci_runners".to_string(),
            name: "CI test runners".to_string(),
            state: ci_state,
            detail: ci_detail,
        },
        ComponentHealth {
            id: "release_runner".to_string(),
            name: "Release runner (DMG build)".to_string(),
            state: rel_state,
            detail: rel_detail,
        },
    ];
    (components, release_in_progress(release))
}

/// Build the knightwatch (PR reviewer) component from config.
fn knightwatch_component(gh_program: Option<&str>, root: &str) -> ComponentHealth {
    let review = crate::config::for_project(root).config.review;
    // A reviewer that is deliberately off (`pr_reviewer = none`) is NotApplicable, so skip the
    // network entirely; otherwise read its liveness from GitHub.
    let liveness = if review.has_no_pr_reviewer() {
        None
    } else {
        read_knightwatch_liveness(gh_program, root)
    };
    let (state, detail) =
        classify_knightwatch(review.has_no_pr_reviewer(), review.pr_reviewer.trim(), liveness.as_ref());
    ComponentHealth {
        id: "knightwatch".to_string(),
        name: "PR reviewer (knightwatch)".to_string(),
        state,
        detail,
    }
}

/// Run one bounded `gh api <path>` in `root`, returning stdout on success. `None` on ANY failure —
/// the caller turns that into UNKNOWN, so an auth lapse or a 503 can never read as "nothing is
/// published".
fn gh_api_text(program: &str, root: &str, path: &str) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.arg("api").arg(path).current_dir(root);
    apply_noninteractive(&mut cmd);
    match crate::worktree::output_with_timeout(cmd, RELEASE_QUERY_TIMEOUT) {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        _ => None,
    }
}

/// Like [`gh_api_text`] but follows pagination with `--paginate`. For an endpoint that returns a
/// JSON ARRAY (e.g. `/tags`), `gh` concatenates every page into ONE array, so the caller parses it
/// exactly as it would a single page — but now sees EVERY item, not just the first page. `None` on
/// ANY failure (including a mid-pagination 4xx/5xx, which fails the whole `gh` invocation), so a
/// partial read can never masquerade as a complete one.
fn gh_api_paginated_text(program: &str, root: &str, path: &str) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.arg("api").arg("--paginate").arg(path).current_dir(root);
    apply_noninteractive(&mut cmd);
    match crate::worktree::output_with_timeout(cmd, RELEASE_QUERY_TIMEOUT) {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        _ => None,
    }
}

/// Load the acceptance file from a project root.
///
/// A MISSING OR UNREADABLE BASELINE IS `None`, WHICH ACCEPTS NOTHING. Reading it as blanket
/// acceptance would make the one channel that reports a genuine publication failure go quiet the
/// moment the file was deleted or renamed — the opposite of what an acceptance file is for.
/// Separated from [`release_publication_component`] so the wiring itself is covered: with the read
/// inlined there, deleting it would pass `None` and every classifier test would stay green.
fn read_baseline_at(root: &str) -> Option<ReleaseBaseline> {
    let text = std::fs::read_to_string(std::path::Path::new(root).join(ORPHAN_BASELINE_PATH)).ok()?;
    Some(read_orphan_baseline(&text))
}

/// Build the release-publication component from two reads: the PUBLIC repo's Releases (what users
/// can actually get) and the PRIVATE repo's tags (what was built). One page each — the BLOCKING
/// direction only ever concerns versions above the published high-water mark, which are by
/// construction the newest, and [`classify_release_publication`] refuses to judge tags older than
/// the oldest release it read.
fn release_publication_component(gh_program: Option<&str>, root: &str) -> ComponentHealth {
    let releases_json = gh_program
        .and_then(|p| gh_api_text(p, root, &format!("repos/{PUBLIC_RELEASE_REPO}/releases?per_page=100")));
    // PAGINATE the tag read. `drodio/sparkle` carries 159 tags today, and a single page of
    // TAG_PAGE_SIZE (100) dropped the other ~59 — which forced [`apply_tag_page_truncation`] to
    // downgrade an otherwise-Healthy verdict to Unknown on EVERY scan (the "Release publication:
    // Unknown" the founder saw). `gh api --paginate` on `/tags` (a JSON ARRAY endpoint) concatenates
    // every page into ONE array, so `read_version_tags` parses it unchanged but now sees EVERY tag.
    // The read is therefore COMPLETE on success (`gh` fails the whole read if any page 4xx/5xxs, and
    // a failed read is `None` -> Unknown), so `tags_complete = true` below.
    let tags_json = gh_program.and_then(|p| {
        gh_api_paginated_text(p, root, &format!("repos/{RELEASE_REPO}/tags?per_page={TAG_PAGE_SIZE}"))
    });
    // The gate reads are per DRAFT and drafts are normally zero or one, so `fetch` is called at most
    // twice per draft. With no `gh` it is never called at all and every draft stays in-flight, which
    // is the pre-FIX-4 behaviour.
    let fetch = |path: &str| gh_program.and_then(|p| gh_api_text(p, root, path));
    release_publication_from_json(releases_json.as_deref(), tags_json.as_deref(), true, root, &fetch)
}

/// Everything [`release_publication_component`] does EXCEPT talk to `gh`: parse the two payloads,
/// load the acceptance file from `root`, classify, and fail closed on a truncated tag page.
///
/// Split out so the FILE READ is covered. With that read inlined in the shell above, deleting it
/// would silently pass `None` (accept nothing) and every classifier test would stay green, because
/// none of them go through the shell — the "defaulted seam every test injects" shape AGENTS.md
/// names. Here the seam is the two JSON payloads, which the shell supplies from `gh` and a test
/// supplies from a fixture, while `root` is the SAME real argument on both paths.
fn release_publication_from_json<F>(
    releases_json: Option<&str>,
    tags_json: Option<&str>,
    tags_complete: bool,
    root: &str,
    fetch: &F,
) -> ComponentHealth
where
    F: Fn(&str) -> Option<String>,
{
    let releases = releases_json.and_then(read_releases);
    let tags = tags_json.and_then(read_version_tags);
    let baseline = read_baseline_at(root);
    let draft_versions: Vec<Version> = releases
        .as_ref()
        .map(|r| r.drafts.iter().filter_map(|t| parse_version(t)).collect())
        .unwrap_or_default();
    let draft_gates = resolve_draft_gates(&draft_versions, fetch);
    let (state, detail) = classify_release_publication(
        releases.as_ref(),
        tags.as_deref(),
        baseline.as_ref(),
        &draft_gates,
    );
    // Fail closed on a tag list we could not read in full before this reaches the panel. With the
    // paginated read above (`release_publication_component`) `tags_complete` is `true`, so a real
    // Healthy verdict survives; only an incomplete read is downgraded.
    let (state, detail) = apply_tag_page_truncation(state, detail, tags_complete);
    ComponentHealth {
        id: "release_publication".to_string(),
        name: "Release publication".to_string(),
        state,
        detail,
    }
}

/// Probe every pipeline component and fold to an overall state for the top-bar indicator.
///
/// Shells out (roborev status, one `gh api` runner read), so it runs off the async runtime's worker
/// threads. Never `Err`s for a component-side failure — a probe that cannot read its signal reports
/// `Unknown`, which the panel shows; an `Err` here is reserved for a malformed request.
#[tauri::command]
pub async fn pipeline_health_probe(root: String) -> Result<PipelineHealth, String> {
    if root.trim().is_empty() {
        return Err("pipeline_health_probe requires a project root".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let gh_program = crate::preflight::cached_gh_path();
        let mut components = Vec::new();
        components.push(roborev_component(&root));
        let (runner_comps, release_in_progress) = runner_components(gh_program.clone(), &root);
        components.extend(runner_comps);
        components.push(release_publication_component(gh_program.as_deref(), &root));
        components.push(knightwatch_component(gh_program.as_deref(), &root));
        let overall = overall_state(&components);
        Ok(PipelineHealth { overall, components, release_in_progress })
    })
    .await
    .map_err(|e| format!("pipeline_health_probe task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comp(state: HealthState) -> ComponentHealth {
        ComponentHealth {
            id: "x".into(),
            name: "X".into(),
            state,
            detail: String::new(),
        }
    }

    // ── aggregation ─────────────────────────────────────────────────────────────────────────────

    /// THE crux: the icon state is the worst APPLICABLE component. Any blocking → red; else any
    /// warning → amber; else green.
    #[test]
    fn overall_is_the_worst_applicable_state() {
        // All healthy → green.
        assert_eq!(
            overall_state(&[comp(HealthState::Healthy), comp(HealthState::Healthy)]),
            HealthState::Healthy
        );
        // A warning with no blocking → amber, even beside healthy components.
        assert_eq!(
            overall_state(&[comp(HealthState::Healthy), comp(HealthState::Warning)]),
            HealthState::Warning
        );
        // A single blocking wins over any number of warnings/healthy → red.
        assert_eq!(
            overall_state(&[
                comp(HealthState::Healthy),
                comp(HealthState::Warning),
                comp(HealthState::Blocking),
            ]),
            HealthState::Blocking
        );
    }

    /// `NotApplicable` is EXCLUDED, not counted as healthy: a pipeline of one warning and three
    /// disabled components is amber, and an all-disabled pipeline is `NotApplicable` (muted icon),
    /// never a false green.
    #[test]
    fn not_applicable_components_are_excluded_from_the_fold() {
        assert_eq!(
            overall_state(&[
                comp(HealthState::NotApplicable),
                comp(HealthState::Warning),
                comp(HealthState::NotApplicable),
            ]),
            HealthState::Warning
        );
        assert_eq!(
            overall_state(&[comp(HealthState::NotApplicable), comp(HealthState::NotApplicable)]),
            HealthState::NotApplicable
        );
        // Disabled beside healthy is green, not muted — one real signal is enough to speak.
        assert_eq!(
            overall_state(&[comp(HealthState::NotApplicable), comp(HealthState::Healthy)]),
            HealthState::Healthy
        );
    }

    /// `Unknown` is amber-tier but never red: a pipeline whose only non-healthy signal is "could not
    /// tell" is amber, and a real `Warning` outranks `Unknown` so the icon's reason is the known one.
    #[test]
    fn unknown_is_amber_tier_and_never_outranks_a_real_warning_or_blocking() {
        assert_eq!(
            overall_state(&[comp(HealthState::Healthy), comp(HealthState::Unknown)]),
            HealthState::Unknown
        );
        assert_eq!(
            overall_state(&[comp(HealthState::Unknown), comp(HealthState::Warning)]),
            HealthState::Warning
        );
        // Unknown must NOT manufacture a red — a probe that could not read is not proof of an outage.
        assert_ne!(
            overall_state(&[comp(HealthState::Unknown), comp(HealthState::Healthy)]),
            HealthState::Blocking
        );
    }

    // ── roborev ─────────────────────────────────────────────────────────────────────────────────

    /// Does this text TELL the reader to run the restart that is broken on this machine? NOT a bare
    /// substring test: every verdict below NAMES `roborev daemon stop && roborev daemon start` in
    /// order to warn the reader OFF it, so a substring test would pin the defect while reading
    /// green. What separates the two is the imperative.
    fn prescribes_daemon_restart(detail: &str) -> bool {
        detail.contains("Recover with `roborev daemon stop")
            || detail.contains("Start it with `roborev daemon start`")
    }

    /// The helper above must keep recognising the OLD prescription (or every negative assertion
    /// below is vacuous) and must NOT fire on a prohibition (or every positive one is unreachable).
    #[test]
    fn prescribes_daemon_restart_recognises_the_prescription_but_not_the_prohibition() {
        assert!(prescribes_daemon_restart(
            "x. Recover with `roborev daemon stop && roborev daemon start`."
        ));
        assert!(prescribes_daemon_restart("x. Start it with `roborev daemon start`."));
        assert!(!prescribes_daemon_restart(
            "Do NOT run `roborev daemon stop && roborev daemon start` — it orphans a process."
        ));
    }

    fn evidence(alive: Option<bool>, loaded: Option<bool>, db_bytes: Option<u64>) -> DaemonEvidence {
        DaemonEvidence { loaded, alive, db_bytes, lock_evidence: None }
    }

    /// The same evidence WITH a lock-evidence reading. Separate constructor so every pre-existing
    /// test keeps passing `None` — "we did not look" — and none of them silently acquires a verdict
    /// it was not written to assert.
    fn evidence_with_lock(
        alive: Option<bool>,
        loaded: Option<bool>,
        db_bytes: Option<u64>,
        lock_evidence: Option<bool>,
    ) -> DaemonEvidence {
        DaemonEvidence { loaded, alive, db_bytes, lock_evidence }
    }

    const RB_BLOATED: u64 = 901_775_360; // 860 MB — the measured size of the founder's store
    const RB_SMALL: u64 = 5_242_880; // 5 MB

    // ── RAW-LOG LOCK EVIDENCE ────────────────────────────────────────────────────────────────────

    /// 2026-08-23T20:00:00-07:00, the wall clock of the measured production read below. Fixed so the
    /// whole log-evidence path is tested without a clock.
    const NOW: i64 = 1_787_540_400;

    /// One `~/.roborev/errors.log` line, built so each test varies exactly ONE fence. Two fences
    /// guard this path (age, and component), so a fixture that trips both makes its test vacuous.
    fn log_line(ts: &str, component: &str, message: &str) -> String {
        format!(
            "{{\"ts\":\"{ts}\",\"level\":\"error\",\"component\":\"{component}\",\
             \"message\":\"{message}\"}}"
        )
    }
    /// The SERVER-path collision — the only shape that is evidence about a starved status read.
    fn server_lock(ts: &str) -> String {
        log_line(ts, "server", "get repo: database is locked (5) (SQLITE_BUSY)")
    }
    /// The WORKER-path collision — the healthy idle background on this machine.
    fn worker_lock(ts: &str) -> String {
        log_line(ts, "worker", "claim job: database is locked (5) (SQLITE_BUSY)")
    }
    fn repeat(line: &str, n: usize) -> String {
        std::iter::repeat(line).take(n).collect::<Vec<_>>().join("\n")
    }

    /// The RFC3339 parser, against values computed independently of it. Every downstream fence is
    /// only as good as this, and a parser that silently returned `None` would make the log evidence
    /// permanently absent — which fails SAFE but would also make the tests below vacuous, so the
    /// known-value table is what keeps them honest.
    #[test]
    fn rfc3339_timestamps_parse_to_known_epochs() {
        assert_eq!(parse_rfc3339_epoch("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_epoch("2000-01-01T00:00:00Z"), Some(946_684_800));
        // A leap day, which a naive month-length table gets wrong.
        assert_eq!(parse_rfc3339_epoch("2024-02-29T12:00:00Z"), Some(1_709_208_000));
        // The exact shape roborev writes: fractional seconds and a colon-bearing offset.
        assert_eq!(parse_rfc3339_epoch("2026-08-23T19:58:53.437835-07:00"), Some(1_787_540_333));
        // The colon-less offset `date +%z` prints, which the shell mirror's fixtures use.
        assert_eq!(parse_rfc3339_epoch("2026-08-23T19:58:53-0700"), Some(1_787_540_333));
        for bad in [
            "",
            "not a timestamp at all",
            "2026-08-23 19:58:53",        // no offset
            "2026-08-23T19:58:53.-07:00", // empty fraction
            "2026-13-01T00:00:00Z",       // month 13
            "2026-08-23T25:00:00Z",       // hour 25
            "2026-08-23T19:58:53+7:00",   // one-digit offset hour
        ] {
            assert_eq!(parse_rfc3339_epoch(bad), None, "must not parse: {bad:?}");
        }
    }

    /// The field reader both fences depend on.
    #[test]
    fn json_string_fields_are_read_by_key_not_by_position() {
        let line = server_lock("2026-08-23T19:59:55-07:00");
        assert_eq!(json_str_field(&line, "component"), Some("server"));
        assert_eq!(json_str_field(&line, "level"), Some("error"));
        assert_eq!(json_str_field(&line, "ts"), Some("2026-08-23T19:59:55-07:00"));
        assert_eq!(json_str_field(&line, "nope"), None);
        assert_eq!(
            json_str_field("{\"component\": \"server\"}", "component"),
            Some("server"),
            "a space after the colon must not read as a missing field"
        );
        // A prefix of a real key must not match it.
        assert_eq!(json_str_field("{\"tsx\":\"x\"}", "ts"), None);
        assert!(is_server_lock_line(&server_lock("2026-08-23T19:59:55-07:00")));
        assert!(!is_server_lock_line(&worker_lock("2026-08-23T19:59:55-07:00")));
        // A server line with no lock signature is not a lock line at all.
        assert!(!is_server_lock_line(&log_line(
            "2026-08-23T19:59:55-07:00",
            "server",
            "get repo: no such repo"
        )));
    }

    /// THE MEASURED PRODUCTION SHAPE, AND THE DEFECT IT CAUSED. `~/.roborev/errors.log` is 14 MB and
    /// its last 200 lines span ~59 MINUTES. An mtime-only fence made that tail always "evidence".
    /// SERVER lines on purpose here, so AGE is the only fence under test.
    #[test]
    fn a_tail_of_fifty_minute_old_collisions_is_not_evidence_about_now() {
        let stale = repeat(&server_lock("2026-08-23T19:10:00-07:00"), 200);
        assert!(
            !log_proves_recent_contention(&stale, NOW),
            "200 collisions from 50 minutes ago say nothing about NOW — and reading them as current \
             contention is what told the operator not to restart a wedged daemon"
        );
    }

    /// THE SECOND FENCE, AND THE ONE THE MEASUREMENT FORCED. Per-line ageing alone was NOT enough:
    /// 13,096 `worker: claim job` collisions against 131 `server: get repo` over 40 days, and ≥2
    /// WORKER lock lines are present in 99.97% of idle 120-second windows. A freshly-written wall of
    /// worker collisions is the NORMAL state here.
    #[test]
    fn fresh_worker_job_claim_collisions_are_the_idle_background_not_evidence() {
        let fresh_workers = repeat(&worker_lock("2026-08-23T19:59:55-07:00"), 200);
        assert!(
            !log_proves_recent_contention(&fresh_workers, NOW),
            "200 job-claim collisions from 5 seconds ago are what a HEALTHY idle daemon looks like \
             at busy_timeout=0 — not evidence that the STATUS read is being starved"
        );
        // The paired positive: same timestamp, same count, ONLY the component differs — so the pair
        // pins the component as the cause and nothing else.
        let fresh_servers = repeat(&server_lock("2026-08-23T19:59:55-07:00"), 200);
        assert!(
            log_proves_recent_contention(&fresh_servers, NOW),
            "the identical tail on the SERVER path IS a starved status read"
        );
        // Server lines buried in worker background are still evidence…
        let mixed = format!(
            "{}\n{}",
            repeat(&worker_lock("2026-08-23T19:59:55-07:00"), 198),
            repeat(&server_lock("2026-08-23T19:59:55-07:00"), 2)
        );
        assert!(log_proves_recent_contention(&mixed, NOW), "server lines buried in background count");
        // …and the background can never top a single server line up to the threshold.
        let one_server = format!(
            "{}\n{}",
            repeat(&worker_lock("2026-08-23T19:59:55-07:00"), 199),
            server_lock("2026-08-23T19:59:55-07:00")
        );
        assert!(
            !log_proves_recent_contention(&one_server, NOW),
            "199 worker collisions cannot top a single server collision up to the threshold"
        );
    }

    /// A LOG LINE THAT CANNOT BE AGED IS NOT RECENT — and a log roborev has reformatted must go to a
    /// verdict that still offers the restart, never to "do not restart".
    #[test]
    fn unstampable_log_lines_are_never_counted_as_recent() {
        let unstamped = repeat(&server_lock("not-a-timestamp"), 200);
        assert!(
            !log_proves_recent_contention(&unstamped, NOW),
            "200 un-ageable lines are 200 unknowns, not proof of a live throttle"
        );
        let no_ts = repeat(
            "{\"level\":\"error\",\"component\":\"server\",\
             \"message\":\"get repo: database is locked (5) (SQLITE_BUSY)\"}",
            200,
        );
        assert!(!log_proves_recent_contention(&no_ts, NOW), "no ts field → unknown, not recent");
        let no_component = repeat(
            "{\"ts\":\"2026-08-23T19:59:55-07:00\",\"level\":\"error\",\
             \"message\":\"get repo: database is locked (5) (SQLITE_BUSY)\"}",
            200,
        );
        assert!(
            !log_proves_recent_contention(&no_component, NOW),
            "no component field means the server path cannot be established — fail SAFE"
        );
    }

    /// THE WIRING ONTO MAIN'S LADDER, without which every fence above is unreachable in production.
    ///
    /// The arm this pins is the one main's ladder could not reach: a live daemon behind a SMALL store
    /// is called "a genuine WEDGE" on the ABSENCE of store bloat alone, and prescribes a kickstart.
    /// A small store rules out the slow-store explanation; it is NOT evidence that the process is
    /// stuck. Positive lock evidence supplies the third reading, and the PAIR below is what pins it:
    /// identical evidence apart from the lock reading must produce the two OPPOSITE verdicts.
    #[test]
    fn a_live_daemon_with_fresh_server_lock_evidence_is_throttled_not_wedged() {
        let (state, detail) = classify_roborev(
            &StatusProbe::TimedOut,
            evidence_with_lock(Some(true), Some(true), Some(RB_SMALL), Some(true)),
        );
        assert_eq!(state, HealthState::Warning, "contention is amber, never blocking: {detail}");
        let lower = detail.to_ascii_lowercase();
        assert!(lower.contains("throttled"), "must name the throttle: {detail}");
        assert!(!lower.contains("genuine wedge"), "a starved read is not a wedge: {detail}");
        assert!(
            detail.contains("merges and deploys are unaffected"),
            "roborev is never blocking: {detail}"
        );
        assert!(
            !prescribes_daemon_restart(&detail),
            "a restart cannot clear lock contention, and the command is broken here: {detail}"
        );

        // THE PAIRED NEGATIVE — the SAME evidence with NO lock reading is still the WEDGE verdict.
        // Without this, the test above also passes for a change that made every alive+small-store
        // daemon read as throttled, which would withhold the recovery from a real wedge.
        let (_, wedged) = classify_roborev(
            &StatusProbe::TimedOut,
            evidence_with_lock(Some(true), Some(true), Some(RB_SMALL), None),
        );
        assert!(
            wedged.contains("genuine WEDGE"),
            "no lock evidence must leave main's WEDGE verdict exactly as it was: {wedged}"
        );
        // `prescribes_daemon_restart` matches the HARMFUL `roborev daemon` imperative, which main's
        // verdicts deliberately avoid — so the recovery a real wedge must still receive is the
        // launchd one, asserted by name.
        assert!(
            wedged.contains("launchctl kickstart -k"),
            "and a real wedge must still be handed its recovery command: {wedged}"
        );
        // …and PROVEN-ABSENT evidence is the same as no evidence: still a wedge, never "throttled".
        let (_, absent) = classify_roborev(
            &StatusProbe::TimedOut,
            evidence_with_lock(Some(true), Some(true), Some(RB_SMALL), Some(false)),
        );
        assert!(absent.contains("genuine WEDGE"), "Some(false) is not contention: {absent}");
    }

    /// PRECEDENCE: a BLOATED store outranks lock evidence. The two are not competing diagnoses — a
    /// growing store is what CAUSES write-lock contention — and SLOW is the arm that names the
    /// disease and prescribes the compaction that actually fixes it.
    #[test]
    fn a_bloated_store_still_reads_slow_even_with_lock_evidence() {
        let (state, detail) = classify_roborev(
            &StatusProbe::TimedOut,
            evidence_with_lock(Some(true), Some(true), Some(RB_BLOATED), Some(true)),
        );
        assert_eq!(state, HealthState::Warning, "{detail}");
        assert!(detail.contains("SLOW, not wedged"), "the store verdict outranks: {detail}");
        assert!(detail.contains("--compact"), "and still names the real remedy: {detail}");
        assert!(!prescribes_daemon_restart(&detail), "{detail}");
    }

    /// A daemon with NO PROCESS is DOWN whatever the log says. Lock evidence must never resurrect a
    /// dead daemon into "merely throttled" and withhold the start command.
    #[test]
    fn lock_evidence_never_overrides_a_missing_process() {
        let (_, detail) = classify_roborev(
            &StatusProbe::TimedOut,
            evidence_with_lock(Some(false), Some(false), Some(RB_SMALL), Some(true)),
        );
        assert!(
            detail.contains("not running"),
            "no process is DOWN, regardless of stale log contention: {detail}"
        );
        assert!(
            detail.contains("launchctl bootstrap"),
            "and must still say how to start it: {detail}"
        );
    }

    /// THE MEASURED PRODUCTION SHAPE (bead `sparkle-4i8kd6`): `roborev status` times out while the
    /// daemon is ALIVE and its store is 860MB. That is SLOW, not wedged — and the old verdict's
    /// remedy (`roborev daemon stop && roborev daemon start`) is broken on this machine and orphans
    /// a process holding the port, so it must not be prescribed here.
    #[test]
    fn a_timed_out_status_behind_a_bloated_store_is_slow_not_wedged() {
        let (state, detail) =
            classify_roborev(&StatusProbe::TimedOut, evidence(Some(true), Some(true), Some(RB_BLOATED)));
        assert_eq!(state, HealthState::Warning, "a degraded review daemon is a warning, not healthy");
        assert!(detail.contains("860 MB"), "the store SIZE is the actionable number: {detail}");
        assert!(detail.contains(ROBOREV_DB_LABEL), "and the store itself must be named: {detail}");
        assert!(
            detail.contains("scripts/roborev-maintenance.sh --compact"),
            "the remedy must be the one that shrinks the store: {detail}"
        );
        assert!(
            !prescribes_daemon_restart(&detail),
            "a restart cannot shrink a store, and this one orphans a process: {detail}"
        );
        assert!(!detail.contains("appears wedged"), "a slow daemon is not a wedged one: {detail}");
        // Non-blocking: review degrades but deploys proceed. The severity crux for roborev.
        assert!(
            detail.contains("merges and deploys are unaffected"),
            "roborev degradation must say deploys still work: {detail}"
        );
    }

    /// THE PAIRED CASE, differing ONLY in the store size: the same alive-but-silent daemon behind a
    /// SMALL store IS a wedge and must still be reported as one — otherwise "never say wedged" would
    /// pass just as well. The restart it names is the one that works here.
    #[test]
    fn not_running_while_alive_with_a_small_store_is_a_real_wedge() {
        let out = "Daemon: not running\n".to_string();
        let (state, detail) =
            classify_roborev(&StatusProbe::Text(out), evidence(Some(true), Some(true), Some(RB_SMALL)));
        assert_eq!(state, HealthState::Warning);
        assert!(detail.contains("WEDGE"), "alive + a small store is the genuine wedge: {detail}");
        assert!(
            detail.contains("launchctl kickstart -k"),
            "the wedge remedy must be the restart that works on this machine: {detail}"
        );
        assert!(!prescribes_daemon_restart(&detail), "even a wedge must not prescribe it: {detail}");
    }

    /// No daemon process at all is genuinely DOWN — still WARNING (review only), never "wedged", and
    /// the remedy is launchd's, because `roborev daemon start` cannot bring it back here.
    #[test]
    fn no_daemon_process_is_down_not_wedged() {
        let out = "Daemon: not running\n".to_string();
        let (state, detail) =
            classify_roborev(&StatusProbe::Text(out), evidence(Some(false), Some(false), Some(RB_SMALL)));
        assert_eq!(state, HealthState::Warning);
        assert!(detail.contains("not running"), "{detail}");
        assert!(detail.contains("launchctl bootstrap"), "start it through launchd: {detail}");
        assert!(!detail.to_lowercase().contains("wedge"), "a dead daemon is not wedged: {detail}");
        assert!(!prescribes_daemon_restart(&detail), "the roborev subcommand is broken here: {detail}");
    }

    /// THE UNREADABLE CASE — no evidence at all. SLOW and WEDGED need opposite remedies, so the only
    /// honest verdict is "diagnose first", and it must still be a WARNING: an unreadable or down
    /// review daemon must never render as "nothing to do".
    #[test]
    fn no_evidence_is_undetermined_and_never_restarts_blind() {
        for probe in [StatusProbe::TimedOut, StatusProbe::Text("Daemon: not running\n".into())] {
            let (state, detail) = classify_roborev(&probe, DaemonEvidence::default());
            assert_eq!(state, HealthState::Warning, "never silent: {detail}");
            assert!(detail.contains("UNDETERMINED"), "say what we do not know: {detail}");
            assert!(
                detail.contains("scripts/roborev-maintenance.sh --status"),
                "and name the diagnostic that settles it: {detail}"
            );
            assert!(!prescribes_daemon_restart(&detail), "never restart blind: {detail}");
        }
    }

    /// A PROCESS reading outranks the LaunchAgent registration: a registered agent whose process
    /// died still prints as loaded, so `loaded` alone must not keep a dead daemon out of the DOWN
    /// verdict. Pins that `alive` is actually consulted rather than being decoration.
    #[test]
    fn a_process_reading_outranks_the_launchagent_registration() {
        let out = "Daemon: not running\n".to_string();
        let (_, detail) =
            classify_roborev(&StatusProbe::Text(out), evidence(Some(false), Some(true), Some(RB_SMALL)));
        assert!(
            detail.contains("there is no roborev daemon process"),
            "a loaded agent with no process is DOWN, not wedged: {detail}"
        );
    }

    /// THE healthy negative case, so the classifier is not vacuously always-unhealthy: the real
    /// `roborev status` output of a sound daemon must read HEALTHY, and the panel detail must carry
    /// the queue summary.
    #[test]
    fn a_healthy_daemon_reads_healthy_with_a_queue_summary() {
        let out = "Daemon: running (uptime: 3m 54s) [v0.53.1]\n\
                   Workers: 4/4 active\n\
                   Jobs:    14 queued, 4 running, 15488 completed, 3437 failed, 0 skipped\n\
                   \n\
                   Health: OK\n  + database: healthy\n  + workers: healthy\n"
            .to_string();
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Healthy, "a running, OK daemon is green");
        assert!(detail.contains("14 queued"), "the panel detail carries the queue: {detail}");
        assert!(detail.contains("15488 completed"), "{detail}");
    }

    /// A running daemon that reports a non-OK health (a sick subsystem) is degraded → WARNING, not
    /// hidden behind the running line.
    #[test]
    fn a_running_daemon_with_bad_health_is_a_warning() {
        let out = "Daemon: running (uptime: 1h) [v0.53.1]\n\
                   Health: DEGRADED\n  - database: unhealthy\n"
            .to_string();
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Warning);
        assert!(detail.to_lowercase().contains("degraded"), "{detail}");
    }

    /// The founder's ACTUAL, near-permanent case (`sparkle-o4mqng` / `sparkle-ot4dxb`): the daemon is
    /// working — database healthy, workers active, jobs completing — and reports `Health: DEGRADED`
    /// ONLY because doomed temp-fixture jobs pile up as `workers: N stalled job(s) running > 30 min`.
    /// A genuinely-working daemon must read HEALTHY here, or the deployment panel is amber forever on
    /// a condition it declares harmless. The stalled jobs are still NAMED in the detail, not hidden.
    #[test]
    fn degraded_only_by_stale_review_jobs_reads_healthy() {
        let out = "Daemon: running (uptime: 48h 31m) [v0.53.1]\n\
                   Workers: 4/4 active\n\
                   Jobs:    8 queued, 11 running, 17014 completed, 4064 failed, 0 skipped\n\
                   \n\
                   Health: DEGRADED\n  + database: healthy\n  \
                   ! workers: 7 stalled job(s) running > 30 min\n\
                   \n\
                   Recent Errors (last 24h): 100\n  \
                   [11m0s ago] worker: claim job: database is locked (5) (SQLITE_BUSY)\n"
            .to_string();
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(
            state,
            HealthState::Healthy,
            "a working daemon degraded only by stale review jobs is green: {detail}"
        );
        // The stalled jobs must still be surfaced, and the deploy-safety line must survive.
        assert!(detail.contains("7 stalled job(s)"), "names the stale jobs: {detail}");
        assert!(detail.contains("17014 completed"), "carries the queue summary: {detail}");
        assert!(detail.contains("do not stop review"), "{detail}");
    }

    /// The DISCRIMINATOR, paired with the test above: the SAME stale-jobs line, but the database is
    /// also unhealthy. A real sick subsystem alongside the debris must NOT be greened — the benign
    /// case is greened only when the debris is the *only* thing wrong.
    #[test]
    fn stale_jobs_beside_a_sick_database_stays_a_warning() {
        let out = "Daemon: running (uptime: 48h) [v0.53.1]\n\
                   Health: DEGRADED\n  - database: unhealthy\n  \
                   ! workers: 7 stalled job(s) running > 30 min\n"
            .to_string();
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Warning, "a sick database is not debris: {detail}");
        assert!(detail.to_lowercase().contains("degraded"), "{detail}");
    }

    /// A non-OK health whose degraded subsystem is NOT the stale-jobs kind (here a soft `!` on the
    /// database) is a degradation we cannot confirm is benign → WARNING. Fail toward honest amber.
    #[test]
    fn a_soft_non_stall_degradation_stays_a_warning() {
        let out = "Daemon: running [v0.53.1]\n\
                   Health: DEGRADED\n  ! database: replication lag 40s\n"
            .to_string();
        let (state, _) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Warning);
    }

    /// A bare `Health: DEGRADED` with no subsystem lines is not confirmable as benign, so it must NOT
    /// green — the greening path requires a positively-identified stale-jobs subsystem line.
    #[test]
    fn a_bare_degraded_with_no_subsystems_stays_a_warning() {
        let out = "Daemon: running [v0.53.1]\nHealth: DEGRADED\n".to_string();
        let (state, _) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Warning, "unconfirmable degradation is honest amber");
    }

    /// Ordering-independence for a RECOGNISED hard marker: a benign stalled line first, then a hard
    /// `- database: unhealthy`, still Warning. (This shape was already handled — both are marker lines
    /// the parser collects — so this is a regression guard, not the fix for the drop bug; the dropped
    /// shapes are covered by `an_unrecognised_subsystem_line_forbids_greening` and
    /// `a_colonless_marker_line_forbids_greening`.)
    #[test]
    fn a_hard_line_after_the_stalled_line_still_warns() {
        let out = "Daemon: running\nWorkers: 4/4 active\n\
                   Health: DEGRADED\n  ! workers: 7 stalled job(s) running > 30 min\n  \
                   - database: unhealthy\n"
            .to_string();
        let (state, _) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Warning, "a hard line below the debris must be seen");
    }

    /// An UNRECOGNISED indented subsystem line (a marker we do not know, e.g. `✗`) sits BEFORE a hard
    /// line. It must not silently drop the rest of the block: the unrecognised line alone forbids a
    /// green, so the panel stays Warning (roborev finding, High — the parser must fail closed).
    #[test]
    fn an_unrecognised_subsystem_line_forbids_greening() {
        let out = "Daemon: running\nWorkers: 4/4 active\n\
                   Health: DEGRADED\n  ! workers: 7 stalled job(s) running > 30 min\n  \
                   \u{2717} database: connection refused\n"
            .to_string();
        let (state, _) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Warning, "an unclassifiable line is not proof of benign");
    }

    /// A worker line that bundles an EXPLICIT fault word with the stall count — `2 workers down, 7
    /// stalled job(s)` — is review actually failing, not debris, and must stay Warning (roborev
    /// finding, Medium: the benign test was an over-broad substring match).
    #[test]
    fn a_stall_line_bundling_a_fault_stays_a_warning() {
        let out = "Daemon: running\nWorkers: 2/4 active\n\
                   Health: DEGRADED\n  ! workers: 2 workers down, 7 stalled job(s) running > 30 min\n"
            .to_string();
        let (state, _) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Warning, "an explicit fault word is not benign debris");
    }

    /// The PAIR to the fault-word test AND the fix for the "active"/"0/" substring bug: a detail that
    /// carries the worker COUNT (`4/4 active`) beside the stall count is still benign — the count is
    /// healthy capacity, not a fault — so the panel greens. Earlier code ambered this permanently.
    #[test]
    fn a_stall_line_carrying_a_healthy_worker_count_still_greens() {
        let out = "Daemon: running\nWorkers: 4/4 active\n\
                   Health: DEGRADED\n  ! workers: 4/4 active, 7 stalled job(s) running > 30 min\n"
            .to_string();
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Healthy, "a healthy worker count is not a fault: {detail}");
    }

    /// The verdict word is matched by EQUALITY, not substring (roborev finding, Medium). A
    /// strictly-worse `Health: UNHEALTHY` with the same stalled line is never discounted, and — the
    /// sharper case — `Health: DEGRADED (database not ok)` must NOT hit the old `contains("ok")` arm
    /// and green with no fences: the verdict word is `degraded` but a real subsystem is sick, and here
    /// the "(database not ok)" is only in the summary while the block shows the stall, so equality on
    /// the FIRST word plus the fences is what holds. `Health: BROKEN` (contains "ok") must be Warning.
    #[test]
    fn the_verdict_word_is_matched_by_equality_not_substring() {
        for (h, tag) in [
            ("Health: UNHEALTHY", "unhealthy is worse than degraded"),
            ("Health: BROKEN", "broken contains 'ok' but is not ok"),
            ("Health: NOT OK", "'not ok' is not ok"),
        ] {
            let out = format!(
                "Daemon: running\nWorkers: 4/4 active\n{h}\n  \
                 ! workers: 7 stalled job(s) running > 30 min\n"
            );
            let (state, _) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
            assert_eq!(state, HealthState::Warning, "{tag}");
        }
    }

    /// A recognised marker line with NO colon (`! disk usage above 95%`) is unclassifiable and must
    /// set `saw_unrecognised`, forbidding a green even though the only real problem parsed is the
    /// benign stall (roborev finding, Medium — the colon-less half of the fail-closed fix was
    /// untested). A hard line BELOW the colon-less line must also still force Warning.
    #[test]
    fn a_colonless_marker_line_forbids_greening() {
        let out = "Daemon: running\nWorkers: 4/4 active\n\
                   Health: DEGRADED\n  ! workers: 7 stalled job(s) running > 30 min\n  \
                   ! disk usage above 95%\n"
            .to_string();
        let (state, _) = classify_roborev(&StatusProbe::Text(out), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Warning, "a colon-less marker line is unclassifiable");

        let with_hard = "Daemon: running\nWorkers: 4/4 active\n\
                         Health: DEGRADED\n  ! disk usage above 95%\n  \
                         - database: unhealthy\n"
            .to_string();
        let (state, _) = classify_roborev(&StatusProbe::Text(with_hard), DaemonEvidence::loaded(Some(true)));
        assert_eq!(state, HealthState::Warning, "the hard line below is still collected");
    }

    /// A connect-to-daemon failure is the down/wedged path; an unrelated failure is UNKNOWN, not a
    /// false warning about the daemon.
    #[test]
    fn connect_failure_is_down_but_an_unrelated_failure_is_unknown() {
        let (down, _) =
            classify_roborev(&StatusProbe::Failed("failed to connect to daemon: x".into()), DaemonEvidence::loaded(Some(true)));
        assert_eq!(down, HealthState::Warning);
        let (unknown, detail) =
            classify_roborev(&StatusProbe::Failed("some other CLI explosion".into()), DaemonEvidence::loaded(None));
        assert_eq!(unknown, HealthState::Unknown, "an unrelated error is not a daemon verdict");
        assert!(detail.contains("some other CLI explosion"), "carries the tool's words: {detail}");
    }

    // ── runners ───────────────────────────────────────────────────────────────────────────────────

    fn runners_json(entries: &[(&str, &str, bool)]) -> String {
        // (label, status, busy)
        let items: Vec<String> = entries
            .iter()
            .map(|(label, status, busy)| {
                format!(
                    r#"{{"name":"r","status":"{status}","busy":{busy},"labels":[{{"name":"{label}"}}]}}"#
                )
            })
            .collect();
        format!(r#"{{"total_count":{},"runners":[{}]}}"#, entries.len(), items.join(","))
    }

    /// The same page, but with a `total_count` the caller chooses — the shape of a TRUNCATED read,
    /// where GitHub reports every registration on the repo beside the page it actually returned.
    fn runners_page(total_count: usize, entries: &[(&str, &str, bool)]) -> String {
        let items: Vec<String> = entries
            .iter()
            .map(|(label, status, busy)| {
                format!(
                    r#"{{"name":"r","status":"{status}","busy":{busy},"labels":[{{"name":"{label}"}}]}}"#
                )
            })
            .collect();
        format!(r#"{{"total_count":{total_count},"runners":[{}]}}"#, items.join(","))
    }

    /// An error payload (no `.runners` array) must read UNKNOWN, never "zero online". This is the
    /// three-way split `pick-runner.sh` exists for: a 503/auth error is not proof the pool is empty.
    #[test]
    fn an_error_payload_is_unknown_not_an_empty_pool() {
        assert_eq!(read_runner_pool(r#"{"message":"Not Found"}"#, CI_RUNNER_LABEL), None);
        assert_eq!(read_runner_pool("{not json", CI_RUNNER_LABEL), None);
        let (state, _) =
            classify_ci_pool(read_runner_pool(r#"{"message":"503"}"#, CI_RUNNER_LABEL), Some(0));
        assert_eq!(state, HealthState::Unknown, "an unreadable read is UNKNOWN, not blocking");
    }

    /// The CI pool severity ladder: empty → BLOCKING (nothing can test), all-busy → WARNING (slow),
    /// some-idle → HEALTHY. The empty case is the one red state CI runners produce.
    #[test]
    fn ci_pool_empty_blocks_saturated_warns_idle_is_healthy() {
        // No linux-ci runner online (an unrelated label online does not count).
        let none = runners_json(&[("sparkle-release", "online", false)]);
        let (state, detail) = classify_ci_pool(read_runner_pool(&none, CI_RUNNER_LABEL), Some(0));
        assert_eq!(state, HealthState::Blocking, "no CI runner online cannot run tests");
        assert!(detail.contains("cannot run tests"), "{detail}");

        // All linux-ci runners busy → saturated, slow but functioning.
        let busy = runners_json(&[("linux-ci", "online", true), ("linux-ci", "online", true)]);
        let (state, detail) = classify_ci_pool(read_runner_pool(&busy, CI_RUNNER_LABEL), Some(0));
        assert_eq!(state, HealthState::Warning, "saturated is slow, not blocking");
        assert!(detail.contains("not blocked"), "{detail}");

        // At least one idle → healthy.
        let idle = runners_json(&[("linux-ci", "online", true), ("linux-ci", "online", false)]);
        let (state, _) = classify_ci_pool(read_runner_pool(&idle, CI_RUNNER_LABEL), Some(0));
        assert_eq!(state, HealthState::Healthy);
    }

    /// The release runner: offline → BLOCKING (no DMG can build), online (idle or busy) → HEALTHY.
    /// An offline runner is filtered out by the online gate, so an all-offline read is zero-online.
    #[test]
    fn release_runner_offline_blocks_online_is_healthy() {
        let offline = runners_json(&[("sparkle-release", "offline", false)]);
        let (state, detail) = classify_release_runner(read_runner_pool(&offline, RELEASE_RUNNER_LABEL));
        assert_eq!(state, HealthState::Blocking, "an offline release runner blocks releases");
        assert!(detail.contains("no notarized DMG can"), "{detail}");

        let online = runners_json(&[("sparkle-release", "online", false)]);
        let (state, _) = classify_release_runner(read_runner_pool(&online, RELEASE_RUNNER_LABEL));
        assert_eq!(state, HealthState::Healthy);

        // Busy (a release in flight) is still healthy, not a warning.
        let busy = runners_json(&[("sparkle-release", "online", true)]);
        let (state, detail) = classify_release_runner(read_runner_pool(&busy, RELEASE_RUNNER_LABEL));
        assert_eq!(state, HealthState::Healthy);
        assert!(detail.contains("building a release"), "{detail}");
    }

    /// Reading is label-scoped: a busy linux-ci runner must not count toward the release pool and
    /// vice-versa. Proves the two components read the same JSON but see different pools.
    #[test]
    fn pool_reads_are_label_scoped() {
        let mixed = runners_json(&[
            ("linux-ci", "online", false),
            ("sparkle-release", "online", true),
        ]);
        let ci = read_runner_pool(&mixed, CI_RUNNER_LABEL).unwrap();
        assert_eq!((ci.online_idle, ci.online_busy), (1, 0), "only the linux-ci runner");
        let rel = read_runner_pool(&mixed, RELEASE_RUNNER_LABEL).unwrap();
        assert_eq!((rel.online_idle, rel.online_busy), (0, 1), "only the sparkle-release runner");
    }

    /// A `linux-ci` pool of `busy` busy runners and `idle` idle ones, as ONE complete page.
    fn ci_pool(idle: usize, busy: usize) -> Option<RunnerPoolReading> {
        let mut entries: Vec<(&str, &str, bool)> = Vec::new();
        for _ in 0..busy {
            entries.push(("linux-ci", "online", true));
        }
        for _ in 0..idle {
            entries.push(("linux-ci", "online", false));
        }
        read_runner_pool(&runners_json(&entries), CI_RUNNER_LABEL)
    }

    /// FIX 1, THE MEASURED CONTRADICTION FED BACK IN. The monitor announced "the macOS release
    /// runner (sparkle-release) is offline — wake the release Mac" at a moment when a direct read of
    /// the same endpoint showed `status=online, busy=false`. Feed exactly that reading in: it must
    /// come out Healthy, and the word "offline" must not appear anywhere in what the founder reads.
    #[test]
    fn an_online_idle_release_runner_is_never_reported_offline() {
        let json = runners_json(&[("sparkle-release", "online", false)]);
        let (state, detail) = classify_release_runner(read_runner_pool(&json, RELEASE_RUNNER_LABEL));
        assert_eq!(state, HealthState::Healthy, "online + not busy is a healthy Mac: {detail}");
        assert!(
            !detail.to_lowercase().contains("offline"),
            "an online runner must never be described as offline: {detail}"
        );
    }

    /// FIX 1, THE OTHER HALF. The measured truncation: 61 registrations against a page carrying 30,
    /// none of them the release runner. A page that did not contain the runner PROVES NOTHING about
    /// the Mac — absence is unprovable from a truncated list — so this must be Unknown (which never
    /// escalates the icon to red and files nothing), not the Blocking "wake the release Mac".
    #[test]
    fn a_truncated_runner_page_is_unknown_not_an_offline_verdict() {
        let entries: Vec<(&str, &str, bool)> = (0..30).map(|_| ("linux-ci", "online", true)).collect();
        let json = runners_page(61, &entries);

        let reading = read_runner_pool(&json, RELEASE_RUNNER_LABEL).expect("a readable page");
        assert!(!reading.complete, "61 registrations against 30 read is a truncated list");
        let (state, detail) = classify_release_runner(Some(reading));
        assert_eq!(state, HealthState::Unknown, "a truncated page cannot prove absence: {detail}");
        assert_ne!(state, HealthState::Blocking, "and must never publish an outage: {detail}");
        // The frozen string DOES contain the word "offline", inside the clause that denies it
        // ("not proof the Mac is offline"). What must never appear is the CLAIM: the Blocking
        // wording that asserts the runner is down and sends someone to the Mac.
        assert!(
            !detail.contains(&format!("({RELEASE_RUNNER_LABEL}) is offline")),
            "it must not assert the runner is offline: {detail}"
        );
        assert!(
            !detail.contains("Wake the release Mac"),
            "and must not dispatch anyone to a Mac that is probably fine: {detail}"
        );
        assert!(detail.contains("TRUNCATED"), "it must say WHY it cannot tell: {detail}");

        // The CI half of the same arm: a truncated page with no linux-ci runner on it.
        let rel_only: Vec<(&str, &str, bool)> =
            (0..30).map(|_| ("sparkle-release", "online", false)).collect();
        let (state, detail) =
            classify_ci_pool(read_runner_pool(&runners_page(61, &rel_only), CI_RUNNER_LABEL), Some(0));
        assert_eq!(state, HealthState::Unknown, "same discipline for the CI pool: {detail}");
        assert!(detail.contains("TRUNCATED"), "{detail}");
    }

    /// The PAIRED negative, so the truncation arm cannot be satisfied by downgrading everything: a
    /// COMPLETE page with nothing online is still the real outage, and still Blocking. An absent
    /// `total_count` (every hand-written stub) counts as complete for the same reason.
    #[test]
    fn a_complete_page_with_nothing_online_still_blocks() {
        let entries: Vec<(&str, &str, bool)> = (0..30).map(|_| ("linux-ci", "online", true)).collect();
        let (state, detail) =
            classify_release_runner(read_runner_pool(&runners_page(30, &entries), RELEASE_RUNNER_LABEL));
        assert_eq!(state, HealthState::Blocking, "a complete list CAN prove absence: {detail}");
        assert!(detail.contains("offline"), "{detail}");

        let no_count = r#"{"runners":[{"name":"r","status":"offline","busy":false,"labels":[{"name":"sparkle-release"}]}]}"#;
        let reading = read_runner_pool(no_count, RELEASE_RUNNER_LABEL).expect("readable");
        assert!(reading.complete, "an absent total_count is a complete answer, not a truncated one");
        let (state, _) = classify_release_runner(Some(reading));
        assert_eq!(state, HealthState::Blocking, "so existing fixtures keep their verdicts");
    }

    /// FIX 1(a)'s wire shape. `gh api --paginate … --slurp` returns an ARRAY of
    /// `{total_count, runners}` page objects; every page's runners must be MERGED and `total_count`
    /// taken from the first. Merging is what makes the reading complete — read only page 1 and the
    /// release runner is missing, which is the whole bug.
    #[test]
    fn a_slurped_page_array_is_merged_into_one_pool() {
        let page1 = runners_page(2, &[("linux-ci", "online", false)]);
        let page2 = runners_page(2, &[("sparkle-release", "online", false)]);
        let slurped = format!("[{page1},{page2}]");

        let rel = read_runner_pool(&slurped, RELEASE_RUNNER_LABEL).expect("readable");
        assert_eq!((rel.online_idle, rel.online_busy), (1, 0), "page 2's runner is merged in");
        assert!(rel.complete, "2 registrations, 2 runners merged — nothing was dropped");
        let (state, detail) = classify_release_runner(Some(rel));
        assert_eq!(state, HealthState::Healthy, "{detail}");

        // Page 1 ALONE is the pre-fix read: the same runner is missing and the list is short of its
        // own total_count, so it must be Unknown rather than the false "offline".
        let (state, _) = classify_release_runner(read_runner_pool(&page1, RELEASE_RUNNER_LABEL));
        assert_eq!(state, HealthState::Unknown, "one page of two cannot prove absence");

        // An empty array carries no page at all — unreadable, not an empty pool.
        assert_eq!(read_runner_pool("[]", RELEASE_RUNNER_LABEL), None);
        // …and a page array with one unreadable member fails the WHOLE read.
        assert_eq!(read_runner_pool(&format!("[{page1},{{\"message\":\"503\"}}]"), CI_RUNNER_LABEL), None);
    }

    /// FIX 2, THE MEASURED CONTRADICTION FED BACK IN (bead `sparkle-1xg2f6`). "CI test runners
    /// RECOVERED — 1 of 21 idle and ready. No action needed; close the pipeline-health bead" was
    /// announced with 43 runs queued and 20 of 21 runners busy. One idle runner against forty-three
    /// queued runs is not recovery, and the notice told its reader to close the bead — a wrong
    /// verdict that erases its own evidence.
    #[test]
    fn one_idle_runner_against_a_deep_queue_is_not_recovery() {
        let (state, detail) = classify_ci_pool(ci_pool(1, 20), Some(43));
        assert_ne!(state, HealthState::Healthy, "43 queued against 1 idle is not healthy: {detail}");
        assert_eq!(state, HealthState::Warning, "{detail}");
        assert!(
            !detail.contains("idle and ready"),
            "the RECOVERED wording must not be reachable in this state: {detail}"
        );
        assert!(detail.contains("43"), "and the queue depth must be named: {detail}");
    }

    /// The autoscaler's own measured line: `queue health: healthy — queued=94 idle=0`. Zero idle
    /// runners is already a Warning, but the depth is what tells an operator this is a stockout
    /// rather than a busy minute, so the saturated wording must carry it.
    #[test]
    fn a_saturated_pool_names_the_queue_depth() {
        let (state, detail) = classify_ci_pool(ci_pool(0, 21), Some(94));
        assert_ne!(state, HealthState::Healthy, "{detail}");
        assert_eq!(state, HealthState::Warning, "{detail}");
        assert!(detail.contains("94"), "the depth is the diagnosis: {detail}");
        assert!(detail.contains("not blocked"), "but merges still are not blocked: {detail}");
    }

    /// The PAIRED positives, so the queue rule is not vacuously always-unhealthy — and the grace
    /// window that keeps it from flapping. A backlog under CI_QUEUE_BACKLOG_MIN clears inside one
    /// autoscaler dispatch cycle and must NOT warn, even when it exceeds free capacity.
    #[test]
    fn a_drained_queue_is_healthy_and_a_small_backlog_is_within_grace() {
        let (state, detail) = classify_ci_pool(ci_pool(5, 1), Some(0));
        assert_eq!(state, HealthState::Healthy, "spare capacity and no queue is ready: {detail}");
        assert!(detail.contains("idle and ready"), "{detail}");

        // 2 queued > 1 idle, but 2 < CI_QUEUE_BACKLOG_MIN — one dispatch cycle clears it.
        let (state, detail) = classify_ci_pool(ci_pool(1, 20), Some(2));
        assert_eq!(state, HealthState::Healthy, "a backlog inside the grace does not warn: {detail}");

        // And the grace is a THRESHOLD, not a blanket: at CI_QUEUE_BACKLOG_MIN it warns.
        let (state, detail) = classify_ci_pool(ci_pool(1, 20), Some(CI_QUEUE_BACKLOG_MIN));
        assert_eq!(state, HealthState::Warning, "the threshold itself is over budget: {detail}");
    }

    /// AN UNREADABLE QUEUE IS SILENCE, NOT A FALSE RECOVERED. `Unknown` never alarms and never fires
    /// a recovery notice, so a failed queue read produces nothing rather than "1 of 21 idle and
    /// ready". That is the fail-safe direction, and it is why `read_queued_runs` must answer `None`
    /// — never `0` — for a shape it does not understand.
    #[test]
    fn an_unreadable_queue_is_unknown_never_ready() {
        let (state, detail) = classify_ci_pool(ci_pool(5, 1), None);
        assert_eq!(state, HealthState::Unknown, "readiness cannot be confirmed: {detail}");
        assert!(!detail.contains("idle and ready"), "{detail}");
        assert!(detail.contains("could not be read"), "and it must say so: {detail}");

        // The reader's own contract, both directions.
        assert_eq!(read_queued_runs(r#"{"total_count":0,"workflow_runs":[]}"#), Some(0));
        assert_eq!(read_queued_runs(r#"{"total_count":43,"workflow_runs":[]}"#), Some(43));
        assert_eq!(read_queued_runs(r#"{"message":"Bad credentials"}"#), None, "an error is not 0");
        assert_eq!(read_queued_runs("{not json"), None);
        assert_eq!(read_queued_runs("[]"), None);
    }


    // ── release publication ───────────────────────────────────────────────────────────────────────

    /// The state of the world on 2026-08-20, verbatim from the audit: 125 published releases topping
    /// out at v0.118.0, one stuck DRAFT (v0.111.0), and version tags on the private repo running two
    /// versions past what shipped.
    fn measured_releases() -> ReleasesReading {
        ReleasesReading {
            published: vec![
                "v0.118.0".into(),
                "v0.116.3".into(),
                "v0.116.1".into(),
                "v0.115.0".into(),
                "v0.114.0".into(),
                "v0.113.0".into(),
                "v0.108.0".into(),
            ],
            drafts: vec!["v0.111.0".into()],
        }
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// Most release-publication tests care about the orphan/draft ladder, not about acceptance, so
    /// they run against an EMPTY-but-READABLE baseline (nothing accepted) — which is exactly the
    /// behaviour the classifier had before the baseline existed, so their verdicts are unchanged.
    fn classify_pub(
        releases: Option<&ReleasesReading>,
        tags: Option<&[String]>,
    ) -> (HealthState, String) {
        classify_release_publication(
            releases,
            tags,
            Some(&ReleaseBaseline::default()),
            &std::collections::BTreeMap::new(),
        )
    }

    /// THE incident this component exists for. A fully built, fully notarized v0.120.0 (and the
    /// v0.119.0 before it) is TAGGED on the private repo with no Release behind it, while the newest
    /// thing a user can install is v0.118.0. That must be BLOCKING — built work nobody can get is a
    /// deployment that did not happen — and the detail must NAME the stuck versions and what it is
    /// waiting on, because "amber somewhere in the pipeline" is what was already failing to reach
    /// the founder.
    #[test]
    fn tags_above_the_published_high_water_mark_block_and_name_the_versions() {
        let tags = strings(&["v0.120.0", "v0.119.0", "v0.118.0", "v0.116.3", "v0.113.0", "v0.108.0"]);
        let (state, detail) =
            classify_pub(Some(&measured_releases()), Some(&tags));
        assert_eq!(state, HealthState::Blocking, "built-but-unpublished work is blocking: {detail}");
        assert!(detail.contains("v0.120.0"), "names the newest stuck version: {detail}");
        assert!(detail.contains("v0.119.0"), "and the one behind it: {detail}");
        assert!(detail.contains("v0.118.0"), "and what users actually have: {detail}");
        // Assert the ACTIONABLE REMEDY, not the phrasing. A stranded tag's whole problem is that
        // nothing is scheduled to publish it, so the one thing the detail must carry is the
        // command that fixes it — the gate printed the right remedy fifteen times into failed run
        // logs nobody read, and this is the surface that is actually looked at.
        assert!(
            detail.contains("existing_tag=v0.120.0"),
            "and names the remedy for the newest stranded version: {detail}"
        );
    }

    /// The PAIRED half — one direction alone is half the evidence. The SAME fixture with the two
    /// above-water tags removed must NOT block: every remaining tag has a release behind it, and the
    /// only debris (the v0.111.0 draft) sits below the v0.118.0 high-water mark. If this went
    /// Blocking too, the test above would be proving nothing about the comparison.
    #[test]
    fn a_tag_below_the_high_water_mark_does_not_block() {
        // v0.111.0 is a real tag on the private repo AND the draft's version — it must be counted
        // ONCE, as the stuck draft, not also as a tag with no release.
        let tags = strings(&["v0.118.0", "v0.116.3", "v0.113.0", "v0.111.0", "v0.108.0"]);
        let (state, detail) =
            classify_pub(Some(&measured_releases()), Some(&tags));
        assert_ne!(state, HealthState::Blocking, "nothing is above what shipped: {detail}");
        assert_eq!(state, HealthState::Warning, "but the debris is still worth saying: {detail}");
        assert!(
            detail.contains("1 stuck draft release (v0.111.0)"),
            "the draft is named once, in the singular: {detail}"
        );
        // Every other tag here IS published, so the draft is the only debris. Without the
        // draft-vs-orphan de-duplication, v0.111.0 would ALSO be reported as "1 tag with no
        // release" — one stuck draft counted twice, in one sentence.
        assert!(
            !detail.contains("tag with no release"),
            "v0.111.0 is the draft, not additionally an orphan tag: {detail}"
        );
    }

    /// Plural agreement in the same detail — two orphan tags read "2 tags with no release", not
    /// "2 tag". Cosmetic, but the panel line is user-facing copy.
    #[test]
    fn two_orphan_tags_read_in_the_plural() {
        let releases = ReleasesReading {
            published: strings(&["v0.118.0", "v0.108.0"]),
            drafts: Vec::new(),
        };
        let tags = strings(&["v0.118.0", "v0.114.0", "v0.113.0", "v0.108.0"]);
        let (state, detail) = classify_pub(Some(&releases), Some(&tags));
        assert_eq!(state, HealthState::Warning, "{detail}");
        assert!(detail.contains("2 tags with no release"), "plural: {detail}");
        assert!(detail.contains("v0.114.0"), "{detail}");
        assert!(detail.contains("v0.113.0"), "{detail}");
    }

    /// Two stuck drafts read in the plural too — the draft half of the same sentence.
    #[test]
    fn two_stuck_drafts_read_in_the_plural() {
        let releases = ReleasesReading {
            published: strings(&["v0.118.0", "v0.108.0"]),
            drafts: strings(&["v0.111.0", "v0.110.0"]),
        };
        let tags = strings(&["v0.118.0", "v0.108.0"]);
        let (state, detail) = classify_pub(Some(&releases), Some(&tags));
        assert_eq!(state, HealthState::Warning, "{detail}");
        assert!(detail.contains("2 stuck draft releases"), "plural: {detail}");
    }

    /// The v0.111.0 draft on its own: a real finding (a release object created 2026-08-17 carrying a
    /// 404-byte .sig and no DMG) but NOT urgent, because v0.118.0 already shipped past it. WARNING,
    /// naming the draft — and explicitly not Blocking, which is what separates stale debris from a
    /// stuck deployment.
    #[test]
    fn a_stuck_draft_below_the_high_water_mark_warns_and_names_itself() {
        let releases = ReleasesReading {
            published: strings(&["v0.118.0", "v0.116.3", "v0.108.0"]),
            drafts: strings(&["v0.111.0"]),
        };
        let tags = strings(&["v0.118.0", "v0.116.3", "v0.108.0"]);
        let (state, detail) = classify_pub(Some(&releases), Some(&tags));
        assert_eq!(state, HealthState::Warning);
        assert!(detail.contains("v0.111.0"), "names the stuck draft: {detail}");
        assert!(detail.to_lowercase().contains("draft"), "and says it is a draft: {detail}");
        assert!(detail.contains("v0.118.0"), "and what did ship: {detail}");
    }

    /// The healthy negative, so the classifier is not vacuously always-unhealthy: every version tag
    /// has a published release and there is no draft at all → GREEN, naming the shipped high-water
    /// mark.
    #[test]
    fn every_tag_published_and_no_drafts_is_healthy() {
        let releases = ReleasesReading {
            published: strings(&["v0.118.0", "v0.116.3", "v0.108.0"]),
            drafts: Vec::new(),
        };
        let tags = strings(&["v0.118.0", "v0.116.3", "v0.108.0"]);
        let (state, detail) = classify_pub(Some(&releases), Some(&tags));
        assert_eq!(state, HealthState::Healthy, "{detail}");
        assert!(detail.contains("v0.118.0"), "names what users can get: {detail}");
    }

    /// THE comparison crux, asserted through the CLASSIFIER in BOTH directions — a lexicographic
    /// compare ranks "v0.99.0" above "v0.110.0" because "9" > "1", and each direction of that error
    /// is its own bug:
    ///   * unpublished v0.110.0 against a shipped v0.99.0 would look BELOW the mark → the silence
    ///     this component exists to end;
    ///   * an already-published v0.99.0 against a shipped v0.110.0 would look ABOVE it → a permanent
    ///     false red.
    /// Both must come out right, which only a numeric compare achieves.
    #[test]
    fn version_comparison_is_semantic_not_lexicographic() {
        // The silent direction: v0.110.0 IS newer than the shipped v0.99.0, so it blocks.
        let shipped_99 = ReleasesReading { published: strings(&["v0.99.0"]), drafts: Vec::new() };
        let (state, detail) = classify_pub(
            Some(&shipped_99),
            Some(&strings(&["v0.110.0", "v0.99.0"])),
        );
        assert_eq!(
            state,
            HealthState::Blocking,
            "v0.110.0 > v0.99.0 numerically; a string compare would hide it: {detail}"
        );
        assert!(detail.contains("v0.110.0"), "{detail}");

        // The false-alarm direction: v0.99.0 is OLDER than the shipped v0.110.0 and is itself
        // published, so nothing is stuck.
        let shipped_110 =
            ReleasesReading { published: strings(&["v0.110.0", "v0.99.0"]), drafts: Vec::new() };
        let (state, detail) = classify_pub(
            Some(&shipped_110),
            Some(&strings(&["v0.110.0", "v0.99.0"])),
        );
        assert_eq!(state, HealthState::Healthy, "a string compare would call this red: {detail}");

        // And the patch component orders numerically too (v0.110.1 > v0.110.0).
        assert!(parse_version("v0.99.0").unwrap() < parse_version("v0.110.0").unwrap());
        assert!(parse_version("v0.110.0").unwrap() < parse_version("v0.110.1").unwrap());
    }

    /// UNKNOWN, never Healthy: a probe that could not read its signal must not present as fine —
    /// that is the module's whole premise. Both reads are separately fallible and both must say so.
    #[test]
    fn unreadable_releases_or_tags_are_unknown_never_healthy() {
        let tags = strings(&["v0.120.0"]);
        let (state, detail) = classify_pub(None, Some(&tags));
        assert_eq!(state, HealthState::Unknown, "unreadable releases are not green: {detail}");
        assert!(detail.contains("could not read"), "{detail}");

        let (state, detail) = classify_pub(Some(&measured_releases()), None);
        assert_eq!(state, HealthState::Unknown, "unreadable tags are not green: {detail}");
        assert!(detail.contains("could not read"), "{detail}");

        // And an error payload from `gh` reads as unreadable rather than as an empty world — the
        // same three-way split the runner pools use.
        assert_eq!(read_releases(r#"{"message":"Bad credentials"}"#), None);
        assert_eq!(read_version_tags(r#"{"message":"Bad credentials"}"#), None);
        assert_eq!(read_releases("{not json"), None);
        // A non-empty array we cannot pull a single tag out of is a shape we do not understand.
        assert_eq!(read_releases(r#"[{"id":1}]"#), None);
        assert_eq!(read_version_tags(r#"[{"id":1}]"#), None);
        let (state, _) = classify_pub(
            read_releases(r#"{"message":"503"}"#).as_ref(),
            Some(&tags),
        );
        assert_eq!(state, HealthState::Unknown);
    }

    /// Fail-closed on unparseable versions: a releases list we read but whose tags are not
    /// vMAJOR.MINOR.PATCH gives us no high-water mark, so we cannot rank anything. UNKNOWN, not the
    /// "nothing published → everything blocks" red and not green.
    #[test]
    fn unparseable_published_tags_are_unknown_not_a_verdict() {
        let releases =
            ReleasesReading { published: strings(&["latest", "nightly"]), drafts: Vec::new() };
        let (state, detail) =
            classify_pub(Some(&releases), Some(&strings(&["v0.120.0"])));
        assert_eq!(state, HealthState::Unknown, "{detail}");
        assert!(detail.contains("recognizable"), "{detail}");

        // Same discipline on the tags side.
        let (state, detail) = classify_pub(
            Some(&measured_releases()),
            Some(&strings(&["nightly", "latest"])),
        );
        assert_eq!(state, HealthState::Unknown, "{detail}");

        // …and on the DRAFTS side: a draft we cannot rank must not be silently dropped, which would
        // turn a stuck draft into a clean green.
        let releases = ReleasesReading {
            published: strings(&["v0.118.0", "v0.108.0"]),
            drafts: strings(&["untagged-draft"]),
        };
        let (state, detail) = classify_pub(
            Some(&releases),
            Some(&strings(&["v0.118.0", "v0.108.0"])),
        );
        assert_eq!(state, HealthState::Unknown, "an unrankable draft is not green: {detail}");
        assert!(detail.contains("waiting to be published"), "{detail}");
    }

    /// A tag that is not a release tag at all is not unpublished work. `drodio/sparkle` carries
    /// `archive/2026-07-27/...` tags; counting them as orphans would make this component permanently
    /// amber for a reason that has nothing to do with shipping.
    #[test]
    fn non_version_tags_are_not_unpublished_work() {
        let releases = ReleasesReading {
            published: strings(&["v0.118.0", "v0.108.0"]),
            drafts: Vec::new(),
        };
        let tags = strings(&[
            "v0.118.0",
            "v0.108.0",
            "archive/2026-07-27/perf/sec-hardening",
            "archive/2026-07-27/feature/voice-dictation",
            // FOUR components is not a release tag either. Observable, not merely ignored: read as
            // a version it would be v0.130.0 — above the high-water mark, and a false red.
            "v0.130.0.1",
        ]);
        let (state, detail) = classify_pub(Some(&releases), Some(&tags));
        assert_eq!(state, HealthState::Healthy, "archive tags are not releases: {detail}");
        assert!(!detail.contains("v0.130.0"), "a four-component tag is not a version: {detail}");
        assert_eq!(parse_version("v0.130.0.1"), None, "and the parser says so directly");
    }

    /// The reads are ONE page each, so a tag older than the oldest release we read is a tag we did
    /// not go back far enough to judge. Reporting it as an orphan would manufacture a permanent
    /// warning out of a page boundary rather than out of the pipeline.
    #[test]
    fn tags_older_than_the_oldest_release_read_are_outside_the_window() {
        let releases = ReleasesReading {
            published: strings(&["v0.118.0", "v0.108.0"]),
            drafts: Vec::new(),
        };
        // v0.4.0 predates every release in our page; v0.118.0/v0.108.0 are both published.
        let (state, detail) = classify_pub(
            Some(&releases),
            Some(&strings(&["v0.118.0", "v0.108.0", "v0.4.0"])),
        );
        assert_eq!(state, HealthState::Healthy, "an out-of-window tag is not an orphan: {detail}");

        // But a tag INSIDE the window with no release behind it still warns — that is what proves
        // the window is a window and not a blanket exemption.
        let (state, detail) = classify_pub(
            Some(&releases),
            Some(&strings(&["v0.118.0", "v0.113.0", "v0.108.0"])),
        );
        assert_eq!(state, HealthState::Warning, "{detail}");
        assert!(detail.contains("v0.113.0"), "names the in-window orphan: {detail}");
        assert!(!detail.contains("v0.4.0"), "and still not the out-of-window one: {detail}");
    }

    /// The tag reader's own contract, in both directions — the half a "does it reject junk" test
    /// cannot reach. An EMPTY tag list is a READABLE answer (a repo that has tagged nothing), NOT an
    /// unreadable payload: collapsing the two would report a tagless repo as UNKNOWN forever, and
    /// would equally let a real read report as empty. Only exercising the happy path pins that.
    #[test]
    fn read_version_tags_reads_names_and_an_empty_list_is_readable() {
        let names = read_version_tags(
            r#"[{"name":"v0.120.0","commit":{"sha":"abc"}},{"name":"v0.119.0"},{"name":"archive/x"}]"#,
        )
        .expect("a well-formed tags payload is readable");
        assert_eq!(names, strings(&["v0.120.0", "v0.119.0", "archive/x"]), "every name, verbatim");

        // Empty is readable-and-empty, never unreadable.
        assert_eq!(read_version_tags("[]"), Some(Vec::new()), "no tags is an ANSWER, not a failure");

        // …and that empty answer reaches the classifier as "nothing waiting", not as UNKNOWN.
        let releases = ReleasesReading { published: Vec::new(), drafts: Vec::new() };
        let (state, _) = classify_pub(
            Some(&releases),
            read_version_tags("[]").as_deref(),
        );
        assert_eq!(state, HealthState::Healthy, "an untagged repo has nothing to publish");
    }

    /// A PRERELEASE is not what the updater endpoint serves, so it is no evidence that a version
    /// reached a user: a prerelease at the newest tag leaves that tag unpublished, and BLOCKING.
    #[test]
    fn a_prerelease_is_not_a_published_release() {
        let json = r#"[
            {"tag_name":"v0.120.0","draft":false,"prerelease":true},
            {"tag_name":"v0.118.0","draft":false,"prerelease":false},
            {"tag_name":"v0.111.0","draft":true,"prerelease":false}
        ]"#;
        let reading = read_releases(json).unwrap();
        assert_eq!(reading.published, strings(&["v0.118.0"]), "the prerelease is not published");
        assert_eq!(reading.drafts, strings(&["v0.111.0"]), "and the draft is a draft");

        let (state, detail) =
            classify_pub(Some(&reading), Some(&strings(&["v0.120.0", "v0.118.0"])));
        assert_eq!(state, HealthState::Blocking, "a prerelease does not ship it: {detail}");
        assert!(detail.contains("v0.120.0"), "{detail}");
    }

    /// Nothing published at ALL, with work tagged, is the worst case, not an empty one: every tag is
    /// above an empty high-water mark. It must not fall into the "no high-water mark → cannot rank"
    /// hole and read green.
    #[test]
    fn nothing_published_at_all_blocks_when_a_tag_exists() {
        let releases = ReleasesReading { published: Vec::new(), drafts: Vec::new() };
        let (state, detail) =
            classify_pub(Some(&releases), Some(&strings(&["v0.1.0"])));
        assert_eq!(state, HealthState::Blocking, "{detail}");
        assert!(detail.contains("no published release at all"), "{detail}");

        // …and a repo with nothing tagged and nothing released has nothing waiting — green.
        let (state, detail) = classify_pub(Some(&releases), Some(&[]));
        assert_eq!(state, HealthState::Healthy, "{detail}");
    }

    /// The detail is ONE panel line, so a long list is capped — but sorted highest-first, so the
    /// version that matters most is never the one elided, and the count of the rest is still shown.
    #[test]
    fn a_capped_detail_still_names_the_highest_version() {
        let releases = ReleasesReading { published: strings(&["v0.100.0"]), drafts: Vec::new() };
        let tags = strings(&[
            "v0.100.0", "v0.101.0", "v0.102.0", "v0.103.0", "v0.104.0", "v0.105.0", "v0.106.0",
        ]);
        let (state, detail) = classify_pub(Some(&releases), Some(&tags));
        assert_eq!(state, HealthState::Blocking, "{detail}");
        assert!(detail.contains("v0.106.0"), "the highest is always named: {detail}");
        assert!(detail.contains("(+2 more)"), "and the elided ones are counted: {detail}");
        assert!(!detail.contains("v0.101.0"), "the lowest of six is the one elided: {detail}");
    }

    /// The component the panel renders: a stable id, a human name, and the classified state — so the
    /// blind spot is actually VISIBLE, not merely computable.
    #[test]
    fn the_release_publication_component_serialises_with_its_state() {
        let comp = ComponentHealth {
            id: "release_publication".into(),
            name: "Release publication".into(),
            state: HealthState::Blocking,
            detail: "v0.120.0 built but NOT published".into(),
        };
        let json = serde_json::to_string(&comp).unwrap();
        assert!(json.contains(r#""id":"release_publication""#), "{json}");
        assert!(json.contains(r#""state":"blocking""#), "{json}");
    }

    // ── the orphan baseline ───────────────────────────────────────────────────────────────────────

    /// THE REAL ACCEPTANCE FILE, not a paraphrase of it. `include_str!` resolves against this source
    /// file, so this test reads the same bytes `release-reconcile.yml` reads — if the two ever
    /// disagree about what is accepted, that is the bug this exists to catch.
    const REAL_BASELINE: &str = include_str!("../../../../.github/release-orphan-baseline.txt");

    /// THE MEASURED FALSE WARNING, FED BACK IN (bead `sparkle-6yit8m`). Every claim in "20 tags with
    /// no release (v0.129.0, v0.126.0, …) — all below the newest published release v0.132.0" was
    /// TRUE. That is the problem: the condition is permanent and accepted, and a WARNING on a
    /// permanent accepted condition is indistinguishable from one on a new failure, so the channel
    /// that would report a genuine publication failure became noise.
    ///
    /// The orphan list is DERIVED from the real file rather than retyped, so it cannot drift out of
    /// agreement with it — and the derived list is asserted non-empty first, because a fixture whose
    /// orphan list is silently empty would pass this test while proving nothing at all.
    #[test]
    fn a_baselined_orphan_never_raises_a_warning() {
        let baseline = read_orphan_baseline(REAL_BASELINE);
        assert!(
            baseline.tags.len() >= 20,
            "the real baseline must still carry the accepted orphans; got {}",
            baseline.tags.len()
        );
        assert!(baseline.tags.contains(&parse_version("v0.129.0").unwrap()), "the newest orphan");
        assert!(baseline.tags.contains(&parse_version("v0.59.0").unwrap()), "and the oldest");

        // Today's published state: v0.132.0 is live, and the window reaches back past every orphan.
        let releases =
            ReleasesReading { published: strings(&["v0.132.0", "v0.58.0"]), drafts: Vec::new() };
        let mut tags: Vec<String> = baseline.tags.iter().map(|v| v.to_string()).collect();
        tags.push("v0.132.0".to_string());
        tags.push("v0.58.0".to_string());

        let (state, detail) =
            classify_release_publication(
            Some(&releases),
            Some(&tags),
            Some(&baseline),
            &std::collections::BTreeMap::new(),
        );
        assert_ne!(state, HealthState::Warning, "a baselined orphan must not warn: {detail}");
        assert_eq!(state, HealthState::Healthy, "{detail}");
        assert!(detail.contains("v0.132.0"), "the high-water mark is still named: {detail}");
        // THE FILE ACCEPTS HISTORY, IT DOES NOT FORGIVE IT — the accepted count is still stated, so
        // filtering never makes an orphan invisible.
        assert!(
            detail.contains(&format!("{} orphan tag(s) are accepted", baseline.tags.len())),
            "the accepted count must still be stated: {detail}"
        );
        assert!(detail.contains(ORPHAN_BASELINE_PATH), "and where to read the decisions: {detail}");
    }

    /// THE PAIRED DIRECTION, and the one that makes the filter a filter rather than a mute button:
    /// an UNACCOUNTED orphan in the same fixture still warns and is still named. Without this, a
    /// classifier that simply never warned would pass the test above.
    #[test]
    fn an_unaccounted_orphan_still_warns_beside_the_baselined_ones() {
        let baseline = read_orphan_baseline(REAL_BASELINE);
        let releases =
            ReleasesReading { published: strings(&["v0.132.0", "v0.58.0"]), drafts: Vec::new() };
        let mut tags: Vec<String> = baseline.tags.iter().map(|v| v.to_string()).collect();
        tags.push("v0.132.0".to_string());
        tags.push("v0.58.0".to_string());
        // v0.130.0 is a real gap in the baseline: an orphan nobody has decided about yet.
        assert!(!baseline.tags.contains(&parse_version("v0.130.0").unwrap()), "still unaccounted");
        tags.push("v0.130.0".to_string());

        let (state, detail) =
            classify_release_publication(
            Some(&releases),
            Some(&tags),
            Some(&baseline),
            &std::collections::BTreeMap::new(),
        );
        assert_eq!(state, HealthState::Warning, "a NEW orphan is the signal: {detail}");
        assert!(detail.contains("1 tag with no release"), "counted alone: {detail}");
        assert!(detail.contains("v0.130.0"), "and named: {detail}");
        assert!(!detail.contains("v0.129.0"), "the accepted ones are not re-listed: {detail}");
        assert!(detail.contains("are accepted in"), "but their count is still stated: {detail}");
    }

    /// THE TWO NAMESPACES, ASSERTED IN BOTH DIRECTIONS — the file header says the split is enforced
    /// by test on the shell side, and it must be enforced here too. Sharing one flat list would let
    /// a tag already recorded as an abandoned orphan retroactively silence a stuck draft on that
    /// same tag, and release.yml's `existing_tag` recovery re-cuts against exactly those tags — so a
    /// real future draft would be pre-cleared before anyone decided anything.
    #[test]
    fn the_baseline_namespaces_do_not_leak_into_each_other() {
        let published = strings(&["v0.132.0", "v0.58.0"]);
        let tag_only = read_orphan_baseline("v0.131.0");
        let draft_only = read_orphan_baseline("draft:v0.131.0");
        assert_eq!(tag_only.tags.len(), 1, "a bare line is a TAG decision");
        assert!(tag_only.drafts.is_empty(), "and only a tag decision");
        assert_eq!(draft_only.drafts.len(), 1, "a draft: line is a DRAFT decision");
        assert!(draft_only.tags.is_empty(), "and only a draft decision");

        // A bare `v0.131.0` line must NOT silence the v0.131.0 STUCK DRAFT.
        let with_draft =
            ReleasesReading { published: published.clone(), drafts: strings(&["v0.131.0"]) };
        let tags = strings(&["v0.132.0", "v0.131.0", "v0.58.0"]);
        let (state, detail) =
            classify_release_publication(
            Some(&with_draft),
            Some(&tags),
            Some(&tag_only),
            &std::collections::BTreeMap::new(),
        );
        assert_eq!(state, HealthState::Warning, "a tag decision does not accept a draft: {detail}");
        assert!(detail.contains("1 stuck draft release (v0.131.0)"), "{detail}");

        // …and the `draft:` line DOES silence it, so the assertion above is about the namespace and
        // not about the classifier being unable to accept a draft at all.
        let (state, detail) =
            classify_release_publication(
            Some(&with_draft),
            Some(&tags),
            Some(&draft_only),
            &std::collections::BTreeMap::new(),
        );
        assert_eq!(state, HealthState::Healthy, "the draft decision accepts it: {detail}");
        assert!(detail.contains("1 stuck draft(s) are accepted"), "and says so: {detail}");

        // The mirror image: a `draft:v0.131.0` line must NOT silence a v0.131.0 ORPHAN TAG.
        let no_draft = ReleasesReading { published, drafts: Vec::new() };
        let (state, detail) =
            classify_release_publication(
            Some(&no_draft),
            Some(&tags),
            Some(&draft_only),
            &std::collections::BTreeMap::new(),
        );
        assert_eq!(state, HealthState::Warning, "a draft decision does not accept a tag: {detail}");
        assert!(detail.contains("1 tag with no release (v0.131.0)"), "{detail}");

        // …and the bare line DOES accept that orphan tag.
        let (state, detail) =
            classify_release_publication(
            Some(&no_draft),
            Some(&tags),
            Some(&tag_only),
            &std::collections::BTreeMap::new(),
        );
        assert_eq!(state, HealthState::Healthy, "{detail}");
        assert!(detail.contains("1 orphan tag(s) are accepted"), "{detail}");
    }

    /// AN UNREADABLE BASELINE FAILS LOUD, NOT GREEN. `None` accepts nothing — every orphan still
    /// counts — and the detail says the file could not be read, so a deleted or renamed acceptance
    /// file cannot silently become blanket acceptance for everything.
    #[test]
    fn a_missing_baseline_accepts_nothing_and_says_so() {
        let releases =
            ReleasesReading { published: strings(&["v0.132.0", "v0.58.0"]), drafts: Vec::new() };
        let tags = strings(&["v0.132.0", "v0.129.0", "v0.58.0"]);
        let (state, detail) = classify_release_publication(
            Some(&releases),
            Some(&tags),
            None,
            &std::collections::BTreeMap::new(),
        );
        assert_eq!(state, HealthState::Warning, "an unreadable baseline accepts nothing: {detail}");
        assert!(detail.contains("v0.129.0"), "the orphan is still counted: {detail}");
        assert!(detail.contains("could not be read"), "and the reason is stated: {detail}");
        assert!(detail.contains(ORPHAN_BASELINE_PATH), "naming the file: {detail}");
    }

    /// The parser's own contract, mirroring `rr_baseline_tags`: `#` comments (whole-line AND
    /// trailing), blank lines, surrounding whitespace and a trailing CR are all stripped; a line
    /// that is not a version is ignored rather than fatal, because the real file is prose-heavy and
    /// one typo must not take the whole acceptance list down with it.
    #[test]
    fn the_baseline_parser_strips_comments_blank_lines_and_carriage_returns() {
        let b = read_orphan_baseline(
            "# a whole-line comment\r\n\
             \r\n\
             v0.129.0\r\n\
             \t v0.126.0  # trailing comment\r\n\
             draft:v0.131.0\r\n\
             draft: v0.111.0 \r\n\
             not-a-version\r\n\
             #v0.999.0\r\n",
        );
        assert_eq!(
            b.tags,
            ["v0.129.0", "v0.126.0"].iter().map(|v| parse_version(v).unwrap()).collect(),
            "two tag decisions, whitespace and trailing comments stripped"
        );
        assert_eq!(
            b.drafts,
            ["v0.131.0", "v0.111.0"].iter().map(|v| parse_version(v).unwrap()).collect(),
            "two draft decisions, with and without a space after the prefix"
        );
        assert!(
            !b.tags.contains(&parse_version("v0.999.0").unwrap()),
            "a commented-out line is not a decision"
        );
        // An empty file is a real, usable answer — "this baseline accepts nothing" — and must be
        // kept distinct from an UNREADABLE one, which is the `None` the caller passes instead.
        assert_eq!(read_orphan_baseline(""), ReleaseBaseline::default());
    }

    /// THE WIRING, not just the parser. With the file read inlined in the component, deleting that
    /// line would pass `None` to the classifier and every test above would stay green — so the read
    /// is its own function and this drives it against the REAL repo root.
    #[test]
    fn the_component_reads_the_acceptance_file_from_the_project_root() {
        let repo_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
        let baseline = read_baseline_at(repo_root).expect("the real repo carries the baseline file");
        assert!(baseline.tags.len() >= 20, "and it is the real one: {}", baseline.tags.len());
        assert_eq!(baseline, read_orphan_baseline(REAL_BASELINE), "the same bytes, parsed the same");

        // A root without the file accepts NOTHING — never blanket acceptance.
        assert_eq!(read_baseline_at(concat!(env!("CARGO_MANIFEST_DIR"), "/src")), None);
    }

    /// …and the CALL SITE, driven end-to-end. The payloads are fixtures; `root` is the real repo, so
    /// the acceptance file is really read from disk. Drop the `read_baseline_at(root)` line and this
    /// goes from Healthy to Warning — which is precisely the hourly false alarm being removed.
    #[test]
    fn the_component_honours_the_acceptance_file_end_to_end() {
        let repo_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
        let baseline = read_baseline_at(repo_root).expect("the real baseline");

        // Published: v0.132.0 (today's high-water mark) and an old floor so every orphan is
        // in-window. Tagged: those two plus every accepted orphan.
        let releases_json =
            r#"[{"tag_name":"v0.132.0","draft":false,"prerelease":false},
                {"tag_name":"v0.58.0","draft":false,"prerelease":false}]"#;
        let mut names: Vec<String> = baseline.tags.iter().map(|v| v.to_string()).collect();
        names.push("v0.132.0".to_string());
        names.push("v0.58.0".to_string());
        assert!(names.len() < TAG_PAGE_SIZE, "short of the page limit, so truncation is not the reason");
        let tags_json = format!(
            "[{}]",
            names.iter().map(|n| format!(r#"{{"name":"{n}"}}"#)).collect::<Vec<_>>().join(",")
        );

        let no_gh = |_: &str| None;
        let c = release_publication_from_json(
            Some(releases_json),
            Some(&tags_json),
            true,
            repo_root,
            &no_gh,
        );
        assert_eq!(c.id, "release_publication");
        assert_eq!(c.state, HealthState::Healthy, "the baseline must reach the classifier: {}", c.detail);
        assert!(c.detail.contains("are accepted in"), "{}", c.detail);

        // The paired direction, through the SAME entry point: a root with no acceptance file accepts
        // nothing, so the identical payloads warn.
        let c = release_publication_from_json(
            Some(releases_json),
            Some(&tags_json),
            true,
            concat!(env!("CARGO_MANIFEST_DIR"), "/src"),
            &no_gh,
        );
        assert_eq!(c.state, HealthState::Warning, "no file means nothing accepted: {}", c.detail);
        assert!(c.detail.contains("could not be read"), "{}", c.detail);
    }

    // ── the CI gate behind a held draft ───────────────────────────────────────────────────────────

    /// The MEASURED chain behind v0.131.0, verbatim: the tag commit, its build base (the first
    /// parent), and the run named exactly "CI" on that base.
    const TAG_SHA: &str = "d2f98e732f4e30526e8769971b12a83d6cda9d70";
    const BASE_SHA: &str = "e3e8f146d94e2d8fd7b9a0777f1954a46d872a45";

    fn gate_map(pairs: &[(&str, GateVerdict)]) -> std::collections::BTreeMap<Version, GateVerdict> {
        pairs.iter().map(|(v, g)| (parse_version(v).unwrap(), *g)).collect()
    }

    /// A `fetch` standing in for `gh api` over the measured v0.131.0 chain: the tag commit has ZERO
    /// workflow runs, so the gate must fall back to the build base, whose CI run concluded FAILURE.
    fn measured_gate_fetch(path: &str) -> Option<String> {
        if path == format!("repos/{RELEASE_REPO}/commits/v0.131.0") {
            return Some(format!(r#"{{"sha":"{TAG_SHA}","parents":[{{"sha":"{BASE_SHA}"}}]}}"#));
        }
        if path.contains(TAG_SHA) {
            return Some(r#"{"total_count":0,"workflow_runs":[]}"#.to_string());
        }
        if path.contains(BASE_SHA) {
            return Some(
                r#"{"total_count":1,"workflow_runs":[
                    {"name":"CI","status":"completed","conclusion":"failure"}]}"#
                    .to_string(),
            );
        }
        None
    }

    /// The MEASURED chain behind v0.133.0, the draft that replaced v0.131.0 as the held one: the
    /// tag commit, its build base (the first parent), and the run named exactly "CI" on that base.
    /// Read from the API on 2026-08-23 — the tag commit has ZERO workflow runs and the base's CI
    /// concluded `failure`, the identical shape v0.131.0 had. That is why v0.133.0 is recorded as
    /// abandoned in the baseline rather than re-dispatched.
    const TAG_SHA_133: &str = "71fc24896150f20975c3aeb4203425b708c029af";
    const BASE_SHA_133: &str = "baa82b32ef1804bec5882ecec18745a97f52fa75";

    /// The same `gh api` stand-in as `measured_gate_fetch`, over the v0.133.0 chain.
    fn measured_gate_fetch_133(path: &str) -> Option<String> {
        if path == format!("repos/{RELEASE_REPO}/commits/v0.133.0") {
            return Some(format!(
                r#"{{"sha":"{TAG_SHA_133}","parents":[{{"sha":"{BASE_SHA_133}"}}]}}"#
            ));
        }
        if path.contains(TAG_SHA_133) {
            return Some(r#"{"total_count":0,"workflow_runs":[]}"#.to_string());
        }
        if path.contains(BASE_SHA_133) {
            return Some(
                r#"{"total_count":1,"workflow_runs":[
                    {"name":"CI","status":"completed","conclusion":"failure"}]}"#
                    .to_string(),
            );
        }
        None
    }

    /// A `fetch` whose TAG run concluded `failure` having executed nothing (the job died at the
    /// synthetic `Set up job` step), over a build base whose CI is GREEN. This is the shape
    /// `cc_gate` reclassifies and routes to the base — `rc=4`.
    fn unjudged_tag_red_over_green_base(path: &str) -> Option<String> {
        if path == format!("repos/{RELEASE_REPO}/commits/v0.140.0") {
            return Some(format!(r#"{{"sha":"{TAG_SHA}","parents":[{{"sha":"{BASE_SHA}"}}]}}"#));
        }
        if path.contains("runs/77/jobs") {
            // THE MEASURED SHAPE: green self-hosted siblings with full step lists, beside hosted
            // jobs that failed having executed nothing. A whole-run step count reads this as
            // "judged" and is therefore inert on exactly the case that blocks a release.
            return Some(
                r#"{"total_count":2,"jobs":[
                    {"name":"shell","status":"completed","conclusion":"success","steps":[
                        {"number":1,"name":"Set up job","conclusion":"success"},
                        {"number":2,"name":"run tests","conclusion":"success"}]},
                    {"name":"rust","status":"completed","conclusion":"failure","steps":[
                        {"number":1,"name":"Set up job","conclusion":"failure"}]}]}"#
                    .to_string(),
            );
        }
        if path.contains(TAG_SHA) {
            return Some(
                r#"{"total_count":1,"workflow_runs":[
                    {"id":77,"name":"CI","status":"completed","conclusion":"failure"}]}"#
                    .to_string(),
            );
        }
        if path.contains(BASE_SHA) {
            return Some(
                r#"{"total_count":1,"workflow_runs":[
                    {"id":88,"name":"CI","status":"completed","conclusion":"success"}]}"#
                    .to_string(),
            );
        }
        None
    }

    /// THE INVERTED HARM THIS MODULE EXISTS TO PREVENT (roborev 68157, High).
    ///
    /// Porting `cc_verdict` alone rather than `cc_gate` made a tag run that FAILED WITHOUT JUDGING
    /// ANYTHING read as a permanent block. The panel would then say "cut a NEW version from green
    /// main" about a release sitting over a green base that the real gate publishes on its next
    /// tick — instructing an operator to burn a full signed, notarized build for nothing. That is
    /// the same wrong-because-approximated verdict this whole change removes, merely inverted.
    #[test]
    fn an_unjudged_tag_red_over_a_green_base_is_not_a_false_permanent_hold() {
        let verdict = resolve_draft_gate("v0.140.0", &unjudged_tag_red_over_green_base);
        assert_ne!(
            verdict,
            GateVerdict::Red,
            "a tag run that executed ZERO steps judged nothing about the tree; cc_gate routes it to \
             the build base rather than blocking on it"
        );
        assert_eq!(
            verdict,
            GateVerdict::Green,
            "and the base it routes to is green, so this draft publishes on the next finalize tick"
        );
    }

    /// THE PAIRED NEGATIVE, without which the test above passes for code that never blocks at all.
    /// A tag run that really did execute its steps and failed is a red TREE and must still block.
    #[test]
    fn a_tag_red_that_actually_judged_the_tree_still_blocks() {
        let fetch = |path: &str| -> Option<String> {
            if path == format!("repos/{RELEASE_REPO}/commits/v0.141.0") {
                return Some(format!(r#"{{"sha":"{TAG_SHA}","parents":[{{"sha":"{BASE_SHA}"}}]}}"#));
            }
            if path.contains("runs/99/jobs") {
                return Some(
                    r#"{"total_count":1,"jobs":[
                        {"name":"test","status":"completed","conclusion":"failure","steps":[
                            {"number":1,"name":"Set up job","conclusion":"success"},
                            {"number":2,"name":"cargo test","conclusion":"failure"}]}]}"#
                        .to_string(),
                );
            }
            if path.contains(TAG_SHA) {
                return Some(
                    r#"{"total_count":1,"workflow_runs":[
                        {"id":99,"name":"CI","status":"completed","conclusion":"failure"}]}"#
                        .to_string(),
                );
            }
            None
        };
        assert_eq!(
            resolve_draft_gate("v0.141.0", &fetch),
            GateVerdict::Red,
            "a run whose steps executed and failed judged the tree RED and must still block"
        );
    }

    /// A BASE red that judged nothing is a HOLD (`cc_gate` rc=5/6), never a permanent block. Unknown
    /// is the honest answer: it claims neither an all-clear nor a block.
    #[test]
    fn an_unjudged_base_red_holds_rather_than_claiming_a_permanent_block() {
        let fetch = |path: &str| -> Option<String> {
            if path == format!("repos/{RELEASE_REPO}/commits/v0.142.0") {
                return Some(format!(r#"{{"sha":"{TAG_SHA}","parents":[{{"sha":"{BASE_SHA}"}}]}}"#));
            }
            if path.contains(TAG_SHA) {
                return Some(r#"{"total_count":0,"workflow_runs":[]}"#.to_string());
            }
            if path.contains("runs/55/jobs") {
                return Some(
                    r#"{"total_count":1,"jobs":[
                        {"name":"rust","status":"completed","conclusion":"failure","steps":[
                            {"number":1,"name":"Set up job","conclusion":"failure"}]}]}"#
                        .to_string(),
                );
            }
            if path.contains(BASE_SHA) {
                return Some(
                    r#"{"total_count":1,"workflow_runs":[
                        {"id":55,"name":"CI","status":"completed","conclusion":"failure"}]}"#
                        .to_string(),
                );
            }
            None
        };
        assert_eq!(
            resolve_draft_gate("v0.142.0", &fetch),
            GateVerdict::Unknown,
            "an infra-only base red must HOLD, not manufacture a permanent block with a rebuild remedy"
        );
    }

    /// The softening is deliberately narrow, and this pins the boundary: a step-less job BESIDE a
    /// sibling that really executed is a genuine failure, not an unstarted run. Softening there
    /// would let a real red publish.
    #[test]
    fn the_unjudged_predicate_mirrors_cc_run_unjudged_failure() {
        // THE NUMERATOR IS THE FAILED JOBS. A succeeded multi-step sibling beside a setup-failed job
        // is the MEASURED release-bump shape; counting steps across the whole run reads it as
        // "judged" and makes the predicate inert on exactly the case that blocks a release.
        assert!(
            run_judged_nothing(
                r#"{"total_count":2,"jobs":[
                    {"name":"shell","status":"completed","conclusion":"success","steps":[
                        {"number":1,"name":"Set up job","conclusion":"success"},
                        {"number":2,"name":"run tests","conclusion":"success"}]},
                    {"name":"rust","status":"completed","conclusion":"failure","steps":[
                        {"number":1,"name":"Set up job","conclusion":"failure"}]}]}"#
            ),
            "green siblings are STRONGER evidence, not weaker: the only red job never reached a \
             runner, so this run judged no code at all"
        );

        // A failed job that reached its first REAL step judged the tree. Note it counts 2, not 0 —
        // a succeeded synthetic `Set up job` is an executed step, which is why a literal
        // `steps == 0` test would be wrong.
        assert!(
            !run_judged_nothing(
                r#"{"total_count":1,"jobs":[
                    {"name":"rust","status":"completed","conclusion":"failure","steps":[
                        {"number":1,"name":"Set up job","conclusion":"success"},
                        {"number":2,"name":"build","conclusion":"failure"}]}]}"#
            ),
            "this job executed a real step and failed — a red TREE, which must still block"
        );

        // SOFTENING IS THE FAIL-OPEN DIRECTION, so every "could not tell" answers NO.
        assert!(
            !run_judged_nothing(r#"{"total_count":0,"jobs":[]}"#),
            "no failed job establishes NOTHING positively (cc_run_unjudged_failure requires n_failed > 0)"
        );
        assert!(
            !run_judged_nothing(r#"{"total_count":9,"jobs":[]}"#),
            "a TRUNCATED page must never read as 'nothing else failed' — the single most dangerous \
             misread available here, and the same truncation lesson as the runner-pool read"
        );
        assert!(
            !run_judged_nothing(
                r#"{"total_count":3,"jobs":[
                    {"name":"rust","status":"completed","conclusion":"failure","steps":[
                        {"number":1,"name":"Set up job","conclusion":"failure"}]}]}"#
            ),
            "a SHORT page is truncated too: the unread jobs could each be a judging red"
        );
        assert!(
            !run_judged_nothing("not json"),
            "an unreadable jobs payload must never soften a Red — fail closed"
        );

        // A path-filtered job is `completed/skipped` carrying zero steps. Counting it as "never
        // ran" would make almost every run look unjudged.
        assert!(
            !run_judged_nothing(
                r#"{"total_count":1,"jobs":[
                    {"name":"skipped-leg","status":"completed","conclusion":"skipped","steps":[]}]}"#
            ),
            "a skipped job is not a failed one, so nothing failed and nothing is proven"
        );

        // A bare ARRAY carries no total_count and is never treated as truncated — the guard needs
        // the field PRESENT before it can fire.
        assert!(
            run_judged_nothing(
                r#"[{"name":"rust","status":"completed","conclusion":"failure","steps":[
                    {"number":1,"name":"Set up job","conclusion":"failure"}]}]"#
            ),
            "a bare array is the CC_JOB_LIST seam shape and must still be judgeable"
        );
    }

    /// `read_ci_gate_verdict` must REPRODUCE `cc_verdict`, not approximate it. The two rules that
    /// are easy to get wrong are both asserted: a run still in flight is Pending and must NEVER be
    /// read through to an older green (a red result could still be coming), and ONLY the literal
    /// conclusion "success" passes.
    #[test]
    fn the_gate_reader_reproduces_cc_verdict() {
        let green = r#"{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"success"}]}"#;
        assert_eq!(read_ci_gate_verdict(green), GateVerdict::Green);

        let red = r#"{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"failure"}]}"#;
        assert_eq!(read_ci_gate_verdict(red), GateVerdict::Red);

        // Cancelled / timed_out / neutral / skipped all FAIL — only "success" passes.
        for c in ["cancelled", "timed_out", "neutral", "skipped", "startup_failure"] {
            let j = format!(
                r#"{{"workflow_runs":[{{"name":"CI","status":"completed","conclusion":"{c}"}}]}}"#
            );
            assert_eq!(read_ci_gate_verdict(&j), GateVerdict::Red, "{c} is not success");
        }

        // A run in flight is Pending EVEN BESIDE an older completed green — never read through.
        let in_flight = r#"{"workflow_runs":[
            {"name":"CI","status":"in_progress","conclusion":null},
            {"name":"CI","status":"completed","conclusion":"success"}]}"#;
        assert_eq!(read_ci_gate_verdict(in_flight), GateVerdict::Pending);

        // Only the workflow named "CI" counts: another workflow's green says nothing about the tree.
        let other = r#"{"workflow_runs":[{"name":"Secret scan","status":"completed","conclusion":"success"}]}"#;
        assert_eq!(read_ci_gate_verdict(other), GateVerdict::None, "a different workflow is no run");
        assert_eq!(read_ci_gate_verdict(r#"{"workflow_runs":[]}"#), GateVerdict::None);

        // And an unreadable payload is Unknown — never Red, never Green.
        assert_eq!(read_ci_gate_verdict(r#"{"message":"Bad credentials"}"#), GateVerdict::Unknown);
        assert_eq!(read_ci_gate_verdict("{not json"), GateVerdict::Unknown);
    }

    /// THE MEASURED CHAIN, END TO END, in the order `cc_gate` walks it: the tag commit first, and
    /// only a RUN-LESS tag falls back to the build base. This is what makes "release-finalize
    /// publishes it once its CI concludes green" false — the base is red, permanently.
    #[test]
    fn a_run_less_tag_falls_back_to_its_red_build_base() {
        assert_eq!(resolve_draft_gate("v0.131.0", &measured_gate_fetch), GateVerdict::Red);
        assert_eq!(
            read_commit_and_base(&measured_gate_fetch(&format!(
                "repos/{RELEASE_REPO}/commits/v0.131.0"
            ))
            .unwrap()),
            Some((TAG_SHA.to_string(), Some(BASE_SHA.to_string()))),
        );

        // The PAIRED direction: a tag that DOES have a run of its own is answered by that run, and
        // the base is never consulted — so a green base cannot rescue a red tag.
        let tag_red = |path: &str| -> Option<String> {
            if path.contains(TAG_SHA) && path.contains("runs?") {
                return Some(
                    r#"{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"failure"}]}"#
                        .to_string(),
                );
            }
            if path.contains(BASE_SHA) {
                panic!("the build base must not be consulted when the tag has its own run");
            }
            measured_gate_fetch(path)
        };
        assert_eq!(resolve_draft_gate("v0.131.0", &tag_red), GateVerdict::Red);

        // …and a run-less tag whose BASE is green is Green, so the fallback is a real fallback and
        // not a hard-coded Red.
        let base_green = |path: &str| -> Option<String> {
            if path.contains(BASE_SHA) {
                return Some(
                    r#"{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"success"}]}"#
                        .to_string(),
                );
            }
            measured_gate_fetch(path)
        };
        assert_eq!(resolve_draft_gate("v0.131.0", &base_green), GateVerdict::Green);

        // Any read failure is Unknown — never Red (a false permanent hold) and never Green.
        assert_eq!(resolve_draft_gate("v0.131.0", &|_: &str| None), GateVerdict::Unknown);
        let bad_commit = |_: &str| Some(r#"{"message":"Not Found"}"#.to_string());
        assert_eq!(resolve_draft_gate("v0.131.0", &bad_commit), GateVerdict::Unknown);
    }

    /// THE MOST EXPENSIVE VERDICT OF THE NIGHT, FED BACK IN. The monitor said "v0.131.0 built and
    /// STAGED as a draft… release-finalize.yml publishes v0.131.0 once its CI concludes green." CI
    /// concluded green TWICE and nothing published. A red-gated draft BELOW the high-water mark is
    /// the DESIGNED end state — kept for forensics, never auto-published — so it is stated inside an
    /// otherwise-Healthy verdict, and the false reassurance must be unreachable.
    #[test]
    fn a_red_gated_draft_reads_as_held_and_never_promises_publication() {
        let releases = ReleasesReading {
            published: strings(&["v0.132.0", "v0.58.0"]),
            drafts: strings(&["v0.131.0"]),
        };
        let tags = strings(&["v0.132.0", "v0.131.0", "v0.58.0"]);
        let (state, detail) = classify_release_publication(
            Some(&releases),
            Some(&tags),
            Some(&ReleaseBaseline::default()),
            &gate_map(&[("v0.131.0", GateVerdict::Red)]),
        );
        assert_eq!(state, HealthState::Healthy, "a held draft is expected, not debris: {detail}");
        assert!(detail.contains("HELD"), "and it is named as held: {detail}");
        assert!(detail.contains("v0.131.0"), "{detail}");
        assert!(
            !detail.contains("once its CI concludes green"),
            "the false reassurance must be unreachable in this state: {detail}"
        );
        assert!(
            !detail.to_lowercase().contains("re-dispatch") && !detail.contains("existing_tag"),
            "and it must never send anyone back to the held tag: {detail}"
        );
        // The two remedies that actually work.
        assert!(detail.contains("cut a NEW version from green main"), "{detail}");
        assert!(detail.contains(&format!("draft:v0.131.0 in {ORPHAN_BASELINE_PATH}")), "{detail}");
    }

    /// ABOVE the high-water mark the SAME red-gated draft is BLOCKING: built work users cannot get
    /// that will never publish itself. Its remediation still must not name the tag — release.yml's
    /// own error text says re-dispatching it re-hits the same red run, and anyone who follows the
    /// old advice burns a full signed, notarized build for nothing.
    #[test]
    fn a_red_gated_draft_above_the_mark_blocks_without_naming_the_tag_as_the_remedy() {
        let releases =
            ReleasesReading { published: strings(&["v0.130.0"]), drafts: strings(&["v0.131.0"]) };
        let tags = strings(&["v0.131.0", "v0.130.0"]);
        let (state, detail) = classify_release_publication(
            Some(&releases),
            Some(&tags),
            Some(&ReleaseBaseline::default()),
            &gate_map(&[("v0.131.0", GateVerdict::Red)]),
        );
        assert_eq!(state, HealthState::Blocking, "users cannot get it and nothing will ship it: {detail}");
        assert!(detail.contains("HELD"), "{detail}");
        assert!(detail.contains("v0.131.0"), "{detail}");
        assert!(detail.contains("Cut a NEW version from green main"), "{detail}");
        assert!(
            !detail.to_lowercase().contains("re-dispatch") && !detail.contains("existing_tag"),
            "never re-dispatch a held tag: {detail}"
        );
        assert!(!detail.contains("once its CI concludes green"), "{detail}");
    }

    /// The PAIRED negative for the gate split: Pending, None and Unknown all keep TODAY'S in-flight
    /// wording, which is true in those states — something may yet flip the draft. Without this, a
    /// classifier that called every draft "held" would pass the two tests above.
    #[test]
    fn a_draft_whose_gate_is_not_red_keeps_the_in_flight_wording() {
        let releases =
            ReleasesReading { published: strings(&["v0.130.0"]), drafts: strings(&["v0.131.0"]) };
        let tags = strings(&["v0.131.0", "v0.130.0"]);
        for verdict in [GateVerdict::Pending, GateVerdict::None, GateVerdict::Unknown, GateVerdict::Green] {
            let (state, detail) = classify_release_publication(
                Some(&releases),
                Some(&tags),
                Some(&ReleaseBaseline::default()),
                &gate_map(&[("v0.131.0", verdict)]),
            );
            assert_eq!(state, HealthState::Warning, "{verdict:?} is in flight, not held: {detail}");
            assert!(detail.contains("once its CI concludes green"), "{verdict:?}: {detail}");
            assert!(!detail.contains("HELD"), "{verdict:?}: {detail}");
        }

        // And an EMPTY gate map — no gate was resolved at all — is in-flight too, so the pre-FIX-4
        // behaviour is what a gh-less probe still produces.
        let (state, detail) = classify_pub(Some(&releases), Some(&tags));
        assert_eq!(state, HealthState::Warning, "{detail}");
        assert!(detail.contains("once its CI concludes green"), "{detail}");
    }

    /// TODAY'S REAL STATE, THROUGH THE REAL ENTRY POINT: the baselined orphan tags, v0.134.0
    /// published, v0.133.0 drafted over a RED build base, and v0.131.0 — the draft that produced
    /// an hourly Warning all night — now RECORDED as abandoned in the baseline. It must be
    /// HEALTHY, state the accepted count, and name the held draft without promising it will
    /// publish.
    ///
    /// AND IT PINS THE PRECEDENCE, which is the one thing this state changed. v0.133.0's gate
    /// really does resolve RED here — the fetch below is the measured API shape, not a hand-set
    /// verdict — yet it is reported as ACCEPTED rather than HELD, because a recorded decision
    /// outranks the held-by-gate presentation. That is only safe while nothing is hidden, so the
    /// count of accepted drafts and the file that holds the decisions are both asserted: the file
    /// accepts history, it does not forgive it. The HELD wording itself stays covered, against an
    /// EMPTY acceptance set, by `a_red_gated_draft_reads_as_held_and_never_promises_publication`
    /// and its above-the-mark sibling; and `an_unrecorded_draft_below_the_mark_is_still_reported`
    /// is the paired direction proving the acceptance file — not the passage of a release — is
    /// what moves a draft out of the report.
    #[test]
    fn todays_real_state_is_healthy_end_to_end() {
        let repo_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
        let baseline = read_baseline_at(repo_root).expect("the real baseline");
        assert!(baseline.tags.len() >= 20, "not a vacuous fixture: {}", baseline.tags.len());
        assert!(
            baseline.drafts.contains(&parse_version("v0.131.0").unwrap()),
            "the abandoned draft is recorded: {:?}",
            baseline.drafts
        );

        let releases_json = r#"[{"tag_name":"v0.134.0","draft":false,"prerelease":false},
                                {"tag_name":"v0.133.0","draft":true,"prerelease":false},
                                {"tag_name":"v0.131.0","draft":true,"prerelease":false},
                                {"tag_name":"v0.58.0","draft":false,"prerelease":false}]"#;
        let mut names: Vec<String> = baseline.tags.iter().map(|v| v.to_string()).collect();
        names.extend([
            "v0.134.0".to_string(),
            "v0.133.0".to_string(),
            "v0.131.0".to_string(),
            "v0.58.0".to_string(),
        ]);
        let tags_json = format!(
            "[{}]",
            names.iter().map(|n| format!(r#"{{"name":"{n}"}}"#)).collect::<Vec<_>>().join(",")
        );

        // Either measured chain answers for its own tag and `None` for anything else, so the gate
        // resolves v0.133.0 RED from the real API shape rather than from a hand-set verdict.
        let fetch = |path: &str| measured_gate_fetch(path).or_else(|| measured_gate_fetch_133(path));

        let c = release_publication_from_json(
            Some(releases_json),
            Some(&tags_json),
            true,
            repo_root,
            &fetch,
        );
        assert_eq!(
            c.state,
            HealthState::Healthy,
            "the whole night's Warning must be gone: {}",
            c.detail
        );
        assert!(c.detail.contains("v0.134.0"), "the high-water mark: {}", c.detail);
        assert!(c.detail.contains("are accepted in"), "the accepted count: {}", c.detail);
        assert!(c.detail.contains(ORPHAN_BASELINE_PATH), "and where the decisions are: {}", c.detail);
        // NOTHING IS HIDDEN: both drafts are still counted, by number, in the verdict a human
        // reads. An implementation that filtered them out silently would satisfy Healthy above and
        // fail right here.
        assert!(
            c.detail.contains("2 stuck draft(s) are accepted"),
            "both recorded drafts are still counted: {}",
            c.detail
        );
        assert!(!c.detail.contains("once its CI concludes green"), "{}", c.detail);
        assert!(!c.detail.to_lowercase().contains("re-dispatch"), "{}", c.detail);

        // THE PRECEDENCE, asserted rather than assumed: v0.133.0's gate resolves RED from the
        // measured shape, so without its baseline line this same call would read HELD. Remove the
        // draft: entries and the assertion below goes red — which is what makes the acceptance
        // file, and not the gate, the thing doing the work here.
        assert_eq!(
            resolve_draft_gate("v0.133.0", &fetch),
            GateVerdict::Red,
            "the fixture really is a red-gated draft"
        );
        assert!(
            !c.detail.contains("HELD"),
            "a recorded decision outranks the held-by-gate wording: {}",
            c.detail
        );
    }

    /// THE PAIRED DIRECTION, and the one that stops the assertion above from being a snapshot: with
    /// the SAME fixture and the v0.133.0 line removed from the acceptance set, an accepted draft
    /// goes back to being an unaccepted one. Recording a decision must be what moves it — not the
    /// mere passage of a release.
    #[test]
    fn an_unrecorded_draft_below_the_mark_is_still_reported() {
        let repo_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
        let releases =
            ReleasesReading { published: strings(&["v0.134.0"]), drafts: strings(&["v0.131.0"]) };
        let tags = strings(&["v0.134.0", "v0.131.0"]);

        // An EMPTY acceptance set and no gate verdict: v0.131.0 is neither accepted nor held, so it
        // must still be named as a stuck draft.
        let (state, detail) = classify_release_publication(
            Some(&releases),
            Some(&tags),
            Some(&ReleaseBaseline::default()),
            &std::collections::BTreeMap::new(),
        );
        assert_eq!(state, HealthState::Warning, "an unrecorded draft still warns: {detail}");
        assert!(detail.contains("v0.131.0"), "and is named: {detail}");

        // The REAL acceptance file, which now records it — the only difference — clears it.
        let baseline = read_baseline_at(repo_root).expect("the real baseline");
        let (state, detail) = classify_release_publication(
            Some(&releases),
            Some(&tags),
            Some(&baseline),
            &std::collections::BTreeMap::new(),
        );
        assert_eq!(state, HealthState::Healthy, "recording the decision clears it: {detail}");
        assert!(detail.contains("stuck draft(s) are accepted"), "still counted: {detail}");
    }

    // ── knightwatch ───────────────────────────────────────────────────────────────────────────────

    fn liveness(age: Option<u64>, open: bool) -> KnightwatchLiveness {
        KnightwatchLiveness { last_review_age_secs: age, has_open_prs: open }
    }

    /// `pr_reviewer = none` → NotApplicable (excluded from the fold), and an UNREADABLE signal is
    /// honest Unknown — never a fake green.
    #[test]
    fn knightwatch_none_is_not_applicable_unreadable_is_unknown() {
        let (state, detail) = classify_knightwatch(true, "none", None);
        assert_eq!(state, HealthState::NotApplicable, "a disabled reviewer is not part of the fold");
        assert!(detail.contains("none"), "{detail}");

        // Configured but the signal could not be read (gh down) → Unknown, and it names the reviewer.
        let (state, detail) = classify_knightwatch(false, "sparkle-reviewer", None);
        assert_eq!(state, HealthState::Unknown, "an unreadable signal is honest UNKNOWN");
        assert!(detail.contains("sparkle-reviewer"), "names the reviewer: {detail}");
        assert!(detail.contains("could not read"), "and says why it is unknown: {detail}");
    }

    /// FIX 2 (knightwatch liveness). The freshness ladder, each band asserted on its SIDE EFFECT (the
    /// verdict), so mutating a band flips the state:
    ///   * a review within the window        → Healthy
    ///   * stale/never WHILE open PRs wait    → Warning (the real "reviewer is down" case), and the
    ///     detail carries the exact manual-restart command
    ///   * stale/never with NO open PRs       → Healthy (idle; on-demand reviewer, nothing to do)
    #[test]
    fn knightwatch_freshness_ladder() {
        // Fresh review → live, whatever the PR state.
        let (state, detail) = classify_knightwatch(false, "sparkle-reviewer", Some(&liveness(Some(3600), true)));
        assert_eq!(state, HealthState::Healthy, "a fresh review is live: {detail}");
        assert!(detail.contains("live"), "{detail}");

        // Stale review, open PRs waiting → the reviewer appears down.
        let stale = KNIGHTWATCH_FRESH_SECS + 3600;
        let (state, detail) = classify_knightwatch(false, "sparkle-reviewer", Some(&liveness(Some(stale), true)));
        assert_eq!(state, HealthState::Warning, "stale + open PRs is a down reviewer: {detail}");
        assert!(detail.contains("pr-review.sh"), "and names the restart command: {detail}");

        // NEVER posted, open PRs waiting → down (this is TODAY's live state on drodio/sparkle).
        let (state, detail) = classify_knightwatch(false, "sparkle-reviewer", Some(&liveness(None, true)));
        assert_eq!(state, HealthState::Warning, "never-posted + open PRs is a down reviewer: {detail}");
        assert!(detail.contains("pr-review.sh"), "and names the restart command: {detail}");

        // Stale/never but NO open PRs → idle, not a fault.
        let (state, _) = classify_knightwatch(false, "sparkle-reviewer", Some(&liveness(None, false)));
        assert_eq!(state, HealthState::Healthy, "no open PRs to review → idle is fine");
        let (state, _) = classify_knightwatch(false, "sparkle-reviewer", Some(&liveness(Some(stale), false)));
        assert_eq!(state, HealthState::Healthy, "no open PRs to review → an old last-review is fine");
    }

    /// The liveness PARSERS, so the reads feeding the ladder above are covered too.
    #[test]
    fn knightwatch_liveness_parsers() {
        // A known epoch: 2021-01-01T00:00:00Z == 1609459200.
        assert_eq!(github_ts_to_epoch("2021-01-01T00:00:00Z"), Some(1_609_459_200));
        // Fractional seconds and missing Z tolerated; garbage is None (never "just now").
        assert_eq!(github_ts_to_epoch("2021-01-01T00:00:00.123Z"), Some(1_609_459_200));
        assert_eq!(github_ts_to_epoch("not-a-date"), None);
        // Age clamps a future timestamp to 0 and returns None for an unparseable one.
        assert_eq!(github_ts_age_secs("2021-01-01T00:00:00Z", 1_609_459_260), Some(60));
        assert_eq!(github_ts_age_secs("2021-01-01T00:00:00Z", 1_609_459_100), Some(0), "future clamps to 0");
        assert_eq!(github_ts_age_secs("nonsense", 1_609_459_260), None);

        // newest_reviewer_comment_ts: only marker-bearing comments count, and the MAX ts wins even
        // when the payload is not sorted.
        let comments = r#"[
            {"body":"just a human comment","updated_at":"2026-01-05T00:00:00Z"},
            {"body":"review <!-- sparkle-reviewer:auto-post -->","updated_at":"2026-01-02T00:00:00Z"},
            {"body":"newer review <!-- sparkle-reviewer:auto-post -->","updated_at":"2026-01-04T00:00:00Z"}
        ]"#;
        assert_eq!(newest_reviewer_comment_ts(comments).as_deref(), Some("2026-01-04T00:00:00Z"));
        // No marker anywhere → None (real "no review", distinct from an unreadable read).
        assert_eq!(newest_reviewer_comment_ts(r#"[{"body":"hi","updated_at":"2026-01-01T00:00:00Z"}]"#), None);
        // An error body (not an array) → None.
        assert_eq!(newest_reviewer_comment_ts(r#"{"message":"Bad credentials"}"#), None);

        // has_open_prs_from_json: non-empty array true, empty false, error body false.
        assert!(has_open_prs_from_json(r#"[{"number":1}]"#));
        assert!(!has_open_prs_from_json("[]"));
        assert!(!has_open_prs_from_json(r#"{"message":"Not Found"}"#));
    }

    /// The knightwatch CONSTRUCTOR on its no-gh path: with no `gh` there is no reading, and no
    /// reading must be Unknown — never a fake green (the "not monitored" flat-Unknown is gone, but
    /// an UNREADABLE signal is still honestly Unknown). Drives the real component wiring.
    #[test]
    fn the_knightwatch_constructor_is_unknown_without_gh() {
        let c = knightwatch_component(None, concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."));
        assert_eq!(c.id, "knightwatch", "the panel keys on this id");
        // The real repo config sets pr_reviewer = sparkle-reviewer (not "none"), so with no gh the
        // liveness read fails and the honest verdict is Unknown.
        assert_eq!(
            c.state,
            HealthState::Unknown,
            "a configured reviewer with no readable signal is Unknown, not green: {}",
            c.detail
        );
    }

    /// The whole payload serialises to the camelCase shape the TS side reads, and the state enum is
    /// snake_case — so a consumer can tell the five states apart.
    #[test]
    fn the_payload_serialises_to_the_shape_the_frontend_reads() {
        let health = PipelineHealth {
            overall: HealthState::Warning,
            components: vec![comp(HealthState::Blocking)],
            release_in_progress: Some(true),
        };
        let json = serde_json::to_string(&health).unwrap();
        assert!(json.contains(r#""overall":"warning""#), "{json}");
        assert!(json.contains(r#""state":"blocking""#), "{json}");
        // NotApplicable is two words in Rust, one snake_case token on the wire.
        let na = serde_json::to_string(&comp(HealthState::NotApplicable)).unwrap();
        assert!(na.contains(r#""state":"not_applicable""#), "{na}");
        // The fleet-budget governor's structured signal is present and camelCased.
        assert!(json.contains(r#""releaseInProgress":true"#), "{json}");
    }

    /// The release-in-progress signal the fleet CI-budget governor reads: busy VM ⇒ Some(true),
    /// idle ⇒ Some(false), and — critically — an UNREADABLE pool ⇒ None, never Some(false). A
    /// runner that is `Healthy` in both the busy and idle cases is exactly why `HealthState` alone
    /// cannot answer this, and why the governor gets a dedicated boolean.
    #[test]
    fn release_in_progress_is_busy_true_idle_false_unknown_none() {
        assert_eq!(
            release_in_progress(Some(RunnerPoolReading { online_idle: 0, online_busy: 1, complete: true })),
            Some(true),
            "a busy release VM means a DMG is building — the fleet must pause"
        );
        assert_eq!(
            release_in_progress(Some(RunnerPoolReading { online_idle: 1, online_busy: 0, complete: true })),
            Some(false),
            "online but idle is NOT a release in progress"
        );
        assert_eq!(
            release_in_progress(None),
            None,
            "an unreadable pool is UNKNOWN, never a false 'no release' — the governor fails safe on it"
        );
    }
    // ── roborev findings on this component, all Medium, all fixed and pinned here ────────────

    /// FINDING 1. release.yml pushes the tag BEFORE it publishes, so every healthy release has a
    /// window where a version is tagged and unpublished. Counting that as Blocking reds the
    /// indicator on every normal cut, and an indicator that is red routinely is one nobody reads —
    /// which is the exact failure this component exists to remove.
    ///
    /// PAIRED, because one direction alone is half the evidence: the SAME unpublished version is
    /// Warning when a draft is staged for it and Blocking when nothing exists for it at all.
    #[test]
    fn a_staged_draft_is_in_flight_warning_while_a_bare_tag_is_blocking() {
        let published = strings(&["v0.118.0"]);

        // In flight / deliberately held: the release object exists with its assets attached, and
        // release-finalize.yml will publish it. Not an emergency.
        let staged = ReleasesReading { published: published.clone(), drafts: strings(&["v0.121.0"]) };
        let (state, detail) =
            classify_pub(Some(&staged), Some(&strings(&["v0.121.0", "v0.118.0"])));
        assert_eq!(state, HealthState::Warning, "a staged draft above the mark is in-flight, not stranded: {detail}");
        assert!(detail.contains("v0.121.0"), "detail must name the version: {detail}");
        assert!(detail.contains("no rebuild"), "detail must say no rebuild is needed: {detail}");

        // Stranded: a tag with NO release object at all. Nothing is scheduled to publish it — the
        // measured v0.119.0 / v0.120.0 shape.
        let bare = ReleasesReading { published, drafts: Vec::new() };
        let (state, detail) =
            classify_pub(Some(&bare), Some(&strings(&["v0.121.0", "v0.118.0"])));
        assert_eq!(state, HealthState::Blocking, "a tag with no release object is stranded: {detail}");
        assert!(detail.contains("existing_tag=v0.121.0"), "detail must name the remedy: {detail}");
    }

    /// A stranded tag must still win over a staged draft when BOTH are above the mark — the worse
    /// fact is the one the operator needs.
    #[test]
    fn a_stranded_tag_outranks_a_staged_draft() {
        let releases =
            ReleasesReading { published: strings(&["v0.118.0"]), drafts: strings(&["v0.121.0"]) };
        let (state, _) = classify_pub(
            Some(&releases),
            Some(&strings(&["v0.121.0", "v0.120.0", "v0.118.0"])),
        );
        assert_eq!(state, HealthState::Blocking, "v0.120.0 has nothing staged; that must dominate");
    }

    /// FINDING 2. An INCOMPLETE tag read must never report Healthy — that is the silent false-green
    /// this guard exists to prevent (the classifier would see a short list, find no orphans, and
    /// call it all-clear). `tags_complete == false` is the fail-closed signal.
    #[test]
    fn an_incomplete_tag_read_can_never_report_healthy() {
        let (state, detail) =
            apply_tag_page_truncation(HealthState::Healthy, "all published".into(), false);
        assert_eq!(state, HealthState::Unknown, "an incomplete read must not report all-clear: {detail}");
        assert!(detail.contains("could not be read in full"), "and must say why: {detail}");
    }

    /// The paired negatives, so the guard cannot be satisfied by downgrading everything.
    #[test]
    fn truncation_downgrades_only_the_all_clear() {
        // A COMPLETE read (what the paginated tag read now produces) keeps its Healthy verdict.
        let (state, _) =
            apply_tag_page_truncation(HealthState::Healthy, "all published".into(), true);
        assert_eq!(state, HealthState::Healthy, "a complete read keeps its all-clear");

        // A positive finding was reached from tags we DID read and stays true even if incomplete.
        for kept in [HealthState::Blocking, HealthState::Warning] {
            let (state, detail) = apply_tag_page_truncation(kept, "keep me".into(), false);
            assert_eq!(state, kept, "a positive finding must survive an incomplete read");
            assert_eq!(detail, "keep me", "and keep its own detail");
        }
    }

    /// FIX 1 (release publication). The whole bug: the tag read capped at ONE page of TAG_PAGE_SIZE
    /// while `drodio/sparkle` carries 159 tags, so `apply_tag_page_truncation` downgraded a real
    /// Healthy verdict to Unknown on every scan. Now the read PAGINATES, so it hands the classifier
    /// EVERY tag and marks the read complete — and a fixture of MORE than a page of tags, all
    /// published, must verdict Healthy, not "Unknown-by-truncation".
    ///
    /// The side effect asserted is the VERDICT off a >page-size tag set, driven through the real
    /// `release_publication_from_json` entry point (not the guard in isolation): revert the
    /// pagination — pass `false` for `tags_complete` — and this same call goes Unknown, which is the
    /// bug returning.
    #[test]
    fn a_paginated_tag_read_over_the_page_limit_is_not_truncated() {
        // A tag set LARGER than one page (TAG_PAGE_SIZE + 40), every one of which has a PUBLISHED
        // release behind it — so there is no orphan (a built tag with no release), and the honest
        // verdict is Healthy. v0.134.0 is the high-water mark; v0.10.0 an old floor so nothing is
        // out of window.
        let mut names = vec!["v0.134.0".to_string(), "v0.10.0".to_string()];
        let mut minor = 11u64;
        while names.len() < TAG_PAGE_SIZE + 40 {
            names.push(format!("v0.{minor}.0"));
            minor += 1;
        }
        assert!(names.len() > TAG_PAGE_SIZE, "the fixture must exceed one page: {}", names.len());
        // Publish every tag, so the set is genuinely clean (no orphan drives Blocking/Warning).
        let releases_json = format!(
            "[{}]",
            names
                .iter()
                .map(|n| format!(r#"{{"tag_name":"{n}","draft":false,"prerelease":false}}"#))
                .collect::<Vec<_>>()
                .join(",")
        );
        let tags_json = format!(
            "[{}]",
            names.iter().map(|n| format!(r#"{{"name":"{n}"}}"#)).collect::<Vec<_>>().join(",")
        );
        let no_gh = |_: &str| None;

        // COMPLETE read (paginated, production): a >page-size clean set is Healthy, NOT Unknown.
        let c = release_publication_from_json(Some(&releases_json), Some(&tags_json), true, ".", &no_gh);
        assert_eq!(
            c.state,
            HealthState::Healthy,
            "a fully-read tag set with no orphan is Healthy, not Unknown-by-truncation: {}",
            c.detail
        );
        assert!(
            !c.detail.contains("could not be read in full"),
            "the truncation downgrade must not fire on a complete read: {}",
            c.detail
        );

        // The MUTATION that proves the pagination is load-bearing: mark the SAME read incomplete and
        // the verdict collapses to Unknown — the exact bug this fix removes.
        let c = release_publication_from_json(Some(&releases_json), Some(&tags_json), false, ".", &no_gh);
        assert_eq!(c.state, HealthState::Unknown, "an incomplete read of the same tags is Unknown: {}", c.detail);
    }

    /// FINDING 3. The serialisation test hand-built a ComponentHealth and asserted serde's output,
    /// so it never called the constructor and the `components.push(...)` wiring was covered by
    /// nothing — delete that line and the suite stayed green. Drive the REAL constructor instead,
    /// on its no-gh path, which needs no network.
    #[test]
    fn the_real_constructor_produces_the_component_the_panel_looks_up() {
        let c = release_publication_component(None, ".");
        assert_eq!(c.id, "release_publication", "the panel keys on this id");
        assert_eq!(c.name, "Release publication");
        assert_eq!(
            c.state,
            HealthState::Unknown,
            "with no gh there is no reading, and no reading must never be Healthy: {}",
            c.detail
        );
    }

}

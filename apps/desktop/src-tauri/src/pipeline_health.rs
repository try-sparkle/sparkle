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
use std::time::Duration;

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

/// Classify roborev's health from a `status` probe and, when we could ask it, whether launchd still
/// has the daemon LaunchAgent loaded (`daemon_loaded`). PURE, so every branch is tested without a
/// daemon.
///
/// roborev is NEVER `Blocking`: review stopping does not stop merges or deploys, so its worst state
/// is `Warning`. The caller decides `NotApplicable` (roborev disabled) before reaching here.
///
/// `daemon_loaded` only refines the WORDING of a not-running result — wedged (registered but
/// unresponsive) vs plainly down — and the remedy that follows. Both are `Warning`.
fn classify_roborev(status: &StatusProbe, daemon_loaded: Option<bool>) -> (HealthState, String) {
    match status {
        StatusProbe::TimedOut => (
            HealthState::Warning,
            format!(
                "roborev status did not respond within {ROBOREV_STATUS_TIMEOUT_SECS}s — the review \
                 daemon appears wedged. Code review is stopped; merges and deploys are unaffected. \
                 Recover with `roborev daemon stop && roborev daemon start`."
            ),
        ),
        StatusProbe::Failed(err) => {
            // roborev's own "failed to connect to daemon" wording — the daemon is down or wedged.
            if err.to_lowercase().contains("connect to daemon") {
                down_or_wedged(daemon_loaded)
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
                down_or_wedged(daemon_loaded)
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

/// The not-running result. Wedged vs down changes only the wording and the remedy; both `Warning`.
fn down_or_wedged(daemon_loaded: Option<bool>) -> (HealthState, String) {
    let detail = match daemon_loaded {
        // The LaunchAgent is loaded but the daemon does not answer — the classic wedge (a lingering
        // process holding the port). A plain `start` cannot recover this; only stop-then-start does.
        Some(true) => {
            "roborev daemon is registered but not responding — it appears wedged. Code review is \
             stopped; merges and deploys are unaffected. Recover with `roborev daemon stop && \
             roborev daemon start`."
        }
        // Not loaded and not answering — genuinely down. A plain start brings it back.
        Some(false) => {
            "roborev daemon is not running — code review is stopped. Merges and deploys are \
             unaffected. Start it with `roborev daemon start`."
        }
        // We could not ask launchd (non-macOS, or the probe failed). Give the recovery that works in
        // both cases.
        None => {
            "roborev daemon is not responding — code review is stopped. Merges and deploys are \
             unaffected. Recover with `roborev daemon stop && roborev daemon start`."
        }
    };
    (HealthState::Warning, detail.to_string())
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
}

impl RunnerPoolReading {
    fn online_total(&self) -> usize {
        self.online_idle + self.online_busy
    }
}

/// Read one labelled pool from the runners-endpoint JSON. Returns `None` when the payload is not the
/// `{ "runners": [ … ] }` shape — an error object (`{"message": "…"}`) or truncated body must classify
/// as UNKNOWN downstream, never as "no runners online".
fn read_runner_pool(json: &str, label: &str) -> Option<RunnerPoolReading> {
    let value: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let runners = value.get("runners")?.as_array()?;
    let mut online_idle = 0;
    let mut online_busy = 0;
    for r in runners {
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
    Some(RunnerPoolReading { online_idle, online_busy })
}

/// Classify the CI test pool (`linux-ci`). This pool runs the real tests, so its absence is
/// BLOCKING; saturation (all busy) is merely slow → WARNING.
fn classify_ci_pool(reading: Option<RunnerPoolReading>) -> (HealthState, String) {
    match reading {
        None => (
            HealthState::Unknown,
            "could not read CI runner status from GitHub — pipeline visibility is degraded."
                .to_string(),
        ),
        Some(r) if r.online_total() == 0 => (
            HealthState::Blocking,
            format!(
                "no self-hosted CI runners ({CI_RUNNER_LABEL}) are online — CI cannot run tests, so \
                 nothing can be verified for merge or release."
            ),
        ),
        Some(r) if r.online_idle == 0 => (
            HealthState::Warning,
            format!(
                "all {} self-hosted CI runners ({CI_RUNNER_LABEL}) are busy — CI is queued and slow \
                 but still running; merges and deploys are not blocked.",
                r.online_busy
            ),
        ),
        Some(r) => (
            HealthState::Healthy,
            format!(
                "{} of {} CI runners ({CI_RUNNER_LABEL}) idle and ready.",
                r.online_idle,
                r.online_total()
            ),
        ),
    }
}

/// Classify the release runner (`sparkle-release`). The notarized DMG builds only here on `auto`, so
/// offline is BLOCKING to releases. Busy is not a problem — a busy release runner is a release in
/// flight.
fn classify_release_runner(reading: Option<RunnerPoolReading>) -> (HealthState, String) {
    match reading {
        None => (
            HealthState::Unknown,
            "could not read release-runner status from GitHub — pipeline visibility is degraded."
                .to_string(),
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

/// Refuse to report `Healthy` off a tag page that may have been truncated (roborev finding, Medium).
///
/// WHY THIS IS NOT HYPOTHETICAL. The tag read is ONE page of [`TAG_PAGE_SIZE`], and this repo
/// currently carries 141 `v*` tags plus non-version `archive/...` refs. So the page IS truncated
/// today. GitHub does not document the ordering of `GET /repos/{owner}/{repo}/tags`, so a newest
/// version tag falling outside page 1 is not something the caller can rule out.
///
/// A truncated page is a perfectly well-formed array, so `read_version_tags` cannot detect it and
/// `classify_release_publication` would see a short tag list, find no orphans, and report
/// **Healthy** — the exact false-green this component exists to prevent, delivered silently.
///
/// Only the HEALTHY verdict is downgraded. A positive finding (Blocking/Warning) was reached from
/// tags we actually read and stays true whatever else was on page 2; Unknown and NotApplicable are
/// already non-committal. Downgrading only the "all clear" is the fail-closed direction.
fn apply_tag_page_truncation(
    state: HealthState,
    detail: String,
    tags_read: usize,
) -> (HealthState, String) {
    if state == HealthState::Healthy && tags_read >= TAG_PAGE_SIZE {
        return (
            HealthState::Unknown,
            format!(
                "read {tags_read} tags in one page (the page limit), so the tag list may be \
                 truncated — cannot rule out a built version that was never published. This is a \
                 limit of the probe, not a fault in the pipeline."
            ),
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

    if orphans.is_empty() && drafts.is_empty() {
        let detail = match high_water {
            Some(h) => format!(
                "every version tag has a published release on {PUBLIC_RELEASE_REPO}; the newest \
                 users can get is {h}."
            ),
            None => "no version tags and no releases yet — nothing is waiting to be published."
                .to_string(),
        };
        return (HealthState::Healthy, detail);
    }

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
    // release-finalize.yml once CI concludes). That is in-flight or deliberately held -> Warning.
    // A tag with NO release object at all has nothing staged and nothing scheduled to act; it stays
    // stranded until a human re-dispatches -> Blocking. That is precisely the v0.119.0 / v0.120.0
    // shape, and precisely NOT the shape of a release that is merely mid-flight.
    let above_orphans: Vec<Version> = orphans
        .iter()
        .copied()
        .filter(|v| high_water.map(|h| *v > h).unwrap_or(true))
        .collect();
    let above_drafts: Vec<Version> = drafts
        .iter()
        .copied()
        .filter(|v| high_water.map(|h| *v > h).unwrap_or(true))
        .collect();
    let above: Vec<Version> = above_orphans.iter().chain(above_drafts.iter()).copied().collect();

    if above_orphans.is_empty() {
        if let Some(newest) = above_drafts.iter().copied().max() {
            let shipped = match high_water {
                Some(h) => format!("the newest release users can get is {h}"),
                None => format!("{PUBLIC_RELEASE_REPO} has no published release at all"),
            };
            return (
                HealthState::Warning,
                format!(
                    "{} built and STAGED as a draft, not yet published — {shipped}. The assets are                      attached, so no rebuild is needed: release-finalize.yml publishes {newest} once                      its CI concludes green. If this persists across several CI runs, read that                      workflow's summary.",
                    name_versions(&above_drafts)
                ),
            );
        }
    }

    if let Some(newest) = above_orphans.iter().copied().max() {
        let shipped = match high_water {
            Some(h) => format!("the newest release users can get is {h}"),
            None => format!("{PUBLIC_RELEASE_REPO} has no published release at all"),
        };
        return (
            HealthState::Blocking,
            format!(
                "{} built but NOT published — {shipped}. The auto-updater serves \
                 {PUBLIC_RELEASE_REPO}'s newest release, so this work has shipped to nobody. \
                 There is no release object at all for {newest} — not even a draft — so nothing is \
                 scheduled to publish it. Re-dispatch release.yml with existing_tag={newest}.",
                name_versions(&above_orphans)
            ),
        );
    }

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
    match high_water {
        Some(h) => (
            HealthState::Warning,
            format!(
                "{} — all below the newest published release {h}, so nothing current is stuck. \
                 Stale publication debris worth clearing.",
                parts.join(" and ")
            ),
        ),
        // Unreachable: with nothing published, every orphan/draft is above the empty high-water mark
        // and was reported Blocking above. Fail toward the honest "cannot tell", never toward green.
        None => (
            HealthState::Unknown,
            "orphan tags or drafts exist but nothing is published — cannot rank them.".to_string(),
        ),
    }
}

// ── knightwatch (the PR-scoped reviewer bot) ────────────────────────────────────────────────────

/// Classify the PR reviewer from config. It is NOT a daemon this app can reach — it runs as a remote
/// bot that posts GitHub comments — so its only local signal is whether it is configured at all.
///
///   * `pr_reviewer = "none"` (today's state) → `NotApplicable`. The reviewer is deliberately off;
///     showing it green would be a lie and showing it amber would be noise.
///   * any other value → `Unknown`. A reviewer is expected but this app has no liveness signal for
///     it yet, and claiming green for a bot we cannot see is exactly the silent-failure this whole
///     surface exists to prevent. Honest "not monitored" beats fake green.
fn classify_knightwatch(has_no_reviewer: bool, reviewer_name: &str) -> (HealthState, String) {
    if has_no_reviewer {
        (
            HealthState::NotApplicable,
            "no PR-review bot is configured for this repo (pr_reviewer = none).".to_string(),
        )
    } else {
        (
            HealthState::Unknown,
            format!(
                "PR reviewer '{reviewer_name}' is configured, but its liveness is not yet monitored \
                 from the app — check its host directly."
            ),
        )
    }
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
        let loaded = if matches!(status, StatusProbe::Text(_) | StatusProbe::Failed(_)) {
            roborev_daemon_loaded()
        } else {
            // A timeout already tells us it is wedged; no need to also ask launchd.
            None
        };
        classify_roborev(&status, loaded)
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
    // One network read feeds both pools.
    let json = gh_program.and_then(|program| {
        let mut cmd = Command::new(program);
        cmd.arg("api")
            .arg(format!("repos/{RELEASE_REPO}/actions/runners?per_page=100"))
            .current_dir(root);
        apply_noninteractive(&mut cmd);
        match crate::worktree::output_with_timeout(cmd, RUNNER_QUERY_TIMEOUT) {
            Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
            _ => None,
        }
    });

    let ci = json.as_deref().and_then(|j| read_runner_pool(j, CI_RUNNER_LABEL));
    let release = json.as_deref().and_then(|j| read_runner_pool(j, RELEASE_RUNNER_LABEL));
    let (ci_state, ci_detail) = classify_ci_pool(ci);
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
fn knightwatch_component(root: &str) -> ComponentHealth {
    let review = crate::config::for_project(root).config.review;
    let (state, detail) = classify_knightwatch(review.has_no_pr_reviewer(), review.pr_reviewer.trim());
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

/// Build the release-publication component from two reads: the PUBLIC repo's Releases (what users
/// can actually get) and the PRIVATE repo's tags (what was built). One page each — the BLOCKING
/// direction only ever concerns versions above the published high-water mark, which are by
/// construction the newest, and [`classify_release_publication`] refuses to judge tags older than
/// the oldest release it read.
fn release_publication_component(gh_program: Option<&str>, root: &str) -> ComponentHealth {
    let releases = gh_program
        .and_then(|p| gh_api_text(p, root, &format!("repos/{PUBLIC_RELEASE_REPO}/releases?per_page=100")))
        .as_deref()
        .and_then(read_releases);
    let tags = gh_program
        .and_then(|p| gh_api_text(p, root, &format!("repos/{RELEASE_REPO}/tags?per_page={TAG_PAGE_SIZE}")))
        .as_deref()
        .and_then(read_version_tags);
    let (state, detail) = classify_release_publication(releases.as_ref(), tags.as_deref());
    // Fail closed on a possibly-truncated tag page before this reaches the panel.
    let (state, detail) =
        apply_tag_page_truncation(state, detail, tags.as_deref().map(<[String]>::len).unwrap_or(0));
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
        components.push(knightwatch_component(&root));
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

    /// THE seed incident: `roborev status` hangs (the daemon's socket accepts but never replies).
    /// That timeout must classify as WEDGED → WARNING, and the detail must name the stop-then-start
    /// recovery that actually works (a plain `start` cannot reclaim the held port).
    #[test]
    fn a_timed_out_status_is_a_wedge_warning_with_the_recovery_that_works() {
        let (state, detail) = classify_roborev(&StatusProbe::TimedOut, None);
        assert_eq!(state, HealthState::Warning, "a wedged daemon is a warning, not healthy");
        assert!(detail.contains("wedged"), "the detail must name the wedge: {detail}");
        assert!(
            detail.contains("roborev daemon stop && roborev daemon start"),
            "and the recovery that works — a plain start cannot reclaim the port: {detail}"
        );
        // Non-blocking: review stops but deploys proceed. This is the severity crux for roborev.
        assert!(
            detail.contains("merges and deploys are unaffected"),
            "roborev down must say deploys still work: {detail}"
        );
    }

    /// The OTHER wedge shape observed in the seed session: `roborev status` returns cleanly but says
    /// "Daemon: not running" while the process lingers. With launchd reporting the agent still
    /// loaded, that is a wedge (registered but unresponsive) → WARNING, stop-then-start.
    #[test]
    fn status_says_not_running_while_launchd_says_loaded_is_a_wedge() {
        let out = "Daemon: not running\n".to_string();
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), Some(true));
        assert_eq!(state, HealthState::Warning);
        assert!(detail.contains("wedged"), "registered-but-unresponsive is a wedge: {detail}");
        assert!(detail.contains("stop && roborev daemon start"), "needs stop+start: {detail}");
    }

    /// Not running AND not loaded is genuinely down — still WARNING (review only), but the remedy is
    /// a plain start, not stop-then-start. Pins that `daemon_loaded` actually changes the outcome.
    #[test]
    fn not_running_and_not_loaded_is_down_with_a_plain_start() {
        let out = "Daemon: not running\n".to_string();
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), Some(false));
        assert_eq!(state, HealthState::Warning);
        assert!(detail.contains("not running"), "{detail}");
        assert!(
            detail.contains("Start it with `roborev daemon start`"),
            "a plain start recovers a down (not wedged) daemon: {detail}"
        );
        // And it must NOT prescribe the wedge remedy — that is what proves loaded/not-loaded diverge.
        assert!(!detail.contains("stop && roborev daemon start"), "down is not wedged: {detail}");
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
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
        let (state, _) = classify_roborev(&StatusProbe::Text(out), Some(true));
        assert_eq!(state, HealthState::Warning);
    }

    /// A bare `Health: DEGRADED` with no subsystem lines is not confirmable as benign, so it must NOT
    /// green — the greening path requires a positively-identified stale-jobs subsystem line.
    #[test]
    fn a_bare_degraded_with_no_subsystems_stays_a_warning() {
        let out = "Daemon: running [v0.53.1]\nHealth: DEGRADED\n".to_string();
        let (state, _) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
        let (state, _) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
        let (state, _) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
        let (state, _) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
        let (state, detail) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
            let (state, _) = classify_roborev(&StatusProbe::Text(out), Some(true));
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
        let (state, _) = classify_roborev(&StatusProbe::Text(out), Some(true));
        assert_eq!(state, HealthState::Warning, "a colon-less marker line is unclassifiable");

        let with_hard = "Daemon: running\nWorkers: 4/4 active\n\
                         Health: DEGRADED\n  ! disk usage above 95%\n  \
                         - database: unhealthy\n"
            .to_string();
        let (state, _) = classify_roborev(&StatusProbe::Text(with_hard), Some(true));
        assert_eq!(state, HealthState::Warning, "the hard line below is still collected");
    }

    /// A connect-to-daemon failure is the down/wedged path; an unrelated failure is UNKNOWN, not a
    /// false warning about the daemon.
    #[test]
    fn connect_failure_is_down_but_an_unrelated_failure_is_unknown() {
        let (down, _) =
            classify_roborev(&StatusProbe::Failed("failed to connect to daemon: x".into()), Some(true));
        assert_eq!(down, HealthState::Warning);
        let (unknown, detail) =
            classify_roborev(&StatusProbe::Failed("some other CLI explosion".into()), None);
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

    /// An error payload (no `.runners` array) must read UNKNOWN, never "zero online". This is the
    /// three-way split `pick-runner.sh` exists for: a 503/auth error is not proof the pool is empty.
    #[test]
    fn an_error_payload_is_unknown_not_an_empty_pool() {
        assert_eq!(read_runner_pool(r#"{"message":"Not Found"}"#, CI_RUNNER_LABEL), None);
        assert_eq!(read_runner_pool("{not json", CI_RUNNER_LABEL), None);
        let (state, _) = classify_ci_pool(read_runner_pool(r#"{"message":"503"}"#, CI_RUNNER_LABEL));
        assert_eq!(state, HealthState::Unknown, "an unreadable read is UNKNOWN, not blocking");
    }

    /// The CI pool severity ladder: empty → BLOCKING (nothing can test), all-busy → WARNING (slow),
    /// some-idle → HEALTHY. The empty case is the one red state CI runners produce.
    #[test]
    fn ci_pool_empty_blocks_saturated_warns_idle_is_healthy() {
        // No linux-ci runner online (an unrelated label online does not count).
        let none = runners_json(&[("sparkle-release", "online", false)]);
        let (state, detail) = classify_ci_pool(read_runner_pool(&none, CI_RUNNER_LABEL));
        assert_eq!(state, HealthState::Blocking, "no CI runner online cannot run tests");
        assert!(detail.contains("cannot run tests"), "{detail}");

        // All linux-ci runners busy → saturated, slow but functioning.
        let busy = runners_json(&[("linux-ci", "online", true), ("linux-ci", "online", true)]);
        let (state, detail) = classify_ci_pool(read_runner_pool(&busy, CI_RUNNER_LABEL));
        assert_eq!(state, HealthState::Warning, "saturated is slow, not blocking");
        assert!(detail.contains("not blocked"), "{detail}");

        // At least one idle → healthy.
        let idle = runners_json(&[("linux-ci", "online", true), ("linux-ci", "online", false)]);
        let (state, _) = classify_ci_pool(read_runner_pool(&idle, CI_RUNNER_LABEL));
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
            classify_release_publication(Some(&measured_releases()), Some(&tags));
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
            classify_release_publication(Some(&measured_releases()), Some(&tags));
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
        let (state, detail) = classify_release_publication(Some(&releases), Some(&tags));
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
        let (state, detail) = classify_release_publication(Some(&releases), Some(&tags));
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
        let (state, detail) = classify_release_publication(Some(&releases), Some(&tags));
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
        let (state, detail) = classify_release_publication(Some(&releases), Some(&tags));
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
        let (state, detail) = classify_release_publication(
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
        let (state, detail) = classify_release_publication(
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
        let (state, detail) = classify_release_publication(None, Some(&tags));
        assert_eq!(state, HealthState::Unknown, "unreadable releases are not green: {detail}");
        assert!(detail.contains("could not read"), "{detail}");

        let (state, detail) = classify_release_publication(Some(&measured_releases()), None);
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
        let (state, _) = classify_release_publication(
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
            classify_release_publication(Some(&releases), Some(&strings(&["v0.120.0"])));
        assert_eq!(state, HealthState::Unknown, "{detail}");
        assert!(detail.contains("recognizable"), "{detail}");

        // Same discipline on the tags side.
        let (state, detail) = classify_release_publication(
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
        let (state, detail) = classify_release_publication(
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
        let (state, detail) = classify_release_publication(Some(&releases), Some(&tags));
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
        let (state, detail) = classify_release_publication(
            Some(&releases),
            Some(&strings(&["v0.118.0", "v0.108.0", "v0.4.0"])),
        );
        assert_eq!(state, HealthState::Healthy, "an out-of-window tag is not an orphan: {detail}");

        // But a tag INSIDE the window with no release behind it still warns — that is what proves
        // the window is a window and not a blanket exemption.
        let (state, detail) = classify_release_publication(
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
        let (state, _) = classify_release_publication(
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
            classify_release_publication(Some(&reading), Some(&strings(&["v0.120.0", "v0.118.0"])));
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
            classify_release_publication(Some(&releases), Some(&strings(&["v0.1.0"])));
        assert_eq!(state, HealthState::Blocking, "{detail}");
        assert!(detail.contains("no published release at all"), "{detail}");

        // …and a repo with nothing tagged and nothing released has nothing waiting — green.
        let (state, detail) = classify_release_publication(Some(&releases), Some(&[]));
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
        let (state, detail) = classify_release_publication(Some(&releases), Some(&tags));
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

    // ── knightwatch ───────────────────────────────────────────────────────────────────────────────

    /// `pr_reviewer = none` (today) → NotApplicable, so it is EXCLUDED from the fold rather than
    /// dragging the icon amber. A configured-but-unmonitored reviewer is honest UNKNOWN, never a fake
    /// green.
    #[test]
    fn knightwatch_none_is_not_applicable_configured_is_unknown() {
        let (state, detail) = classify_knightwatch(true, "none");
        assert_eq!(state, HealthState::NotApplicable, "a disabled reviewer is not part of the fold");
        assert!(detail.contains("none"), "{detail}");

        let (state, detail) = classify_knightwatch(false, "knightwatch");
        assert_eq!(state, HealthState::Unknown, "configured but unmonitored is honest UNKNOWN");
        assert!(detail.contains("knightwatch"), "names the reviewer: {detail}");
        assert!(detail.contains("not yet monitored"), "and says why it is unknown: {detail}");
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
            release_in_progress(Some(RunnerPoolReading { online_idle: 0, online_busy: 1 })),
            Some(true),
            "a busy release VM means a DMG is building — the fleet must pause"
        );
        assert_eq!(
            release_in_progress(Some(RunnerPoolReading { online_idle: 1, online_busy: 0 })),
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
            classify_release_publication(Some(&staged), Some(&strings(&["v0.121.0", "v0.118.0"])));
        assert_eq!(state, HealthState::Warning, "a staged draft above the mark is in-flight, not stranded: {detail}");
        assert!(detail.contains("v0.121.0"), "detail must name the version: {detail}");
        assert!(detail.contains("no rebuild"), "detail must say no rebuild is needed: {detail}");

        // Stranded: a tag with NO release object at all. Nothing is scheduled to publish it — the
        // measured v0.119.0 / v0.120.0 shape.
        let bare = ReleasesReading { published, drafts: Vec::new() };
        let (state, detail) =
            classify_release_publication(Some(&bare), Some(&strings(&["v0.121.0", "v0.118.0"])));
        assert_eq!(state, HealthState::Blocking, "a tag with no release object is stranded: {detail}");
        assert!(detail.contains("existing_tag=v0.121.0"), "detail must name the remedy: {detail}");
    }

    /// A stranded tag must still win over a staged draft when BOTH are above the mark — the worse
    /// fact is the one the operator needs.
    #[test]
    fn a_stranded_tag_outranks_a_staged_draft() {
        let releases =
            ReleasesReading { published: strings(&["v0.118.0"]), drafts: strings(&["v0.121.0"]) };
        let (state, _) = classify_release_publication(
            Some(&releases),
            Some(&strings(&["v0.121.0", "v0.120.0", "v0.118.0"])),
        );
        assert_eq!(state, HealthState::Blocking, "v0.120.0 has nothing staged; that must dominate");
    }

    /// FINDING 2. The tag read is ONE page of TAG_PAGE_SIZE and this repo has 141 v* tags, so the
    /// page IS truncated today. A truncated page is a well-formed array, so nothing downstream can
    /// see it, and the classifier would find no orphans and report Healthy — a silent false-green.
    #[test]
    fn a_full_tag_page_can_never_report_healthy() {
        let (state, detail) =
            apply_tag_page_truncation(HealthState::Healthy, "all published".into(), TAG_PAGE_SIZE);
        assert_eq!(state, HealthState::Unknown, "a full page must not report all-clear: {detail}");
        assert!(detail.contains("truncated"), "and must say why: {detail}");
    }

    /// The paired negatives, so the guard cannot be satisfied by downgrading everything.
    #[test]
    fn truncation_downgrades_only_the_all_clear() {
        // A short page is a complete read; Healthy survives.
        let (state, _) =
            apply_tag_page_truncation(HealthState::Healthy, "all published".into(), TAG_PAGE_SIZE - 1);
        assert_eq!(state, HealthState::Healthy, "a short page is a complete read");

        // A positive finding was reached from tags we DID read and stays true regardless of page 2.
        for kept in [HealthState::Blocking, HealthState::Warning] {
            let (state, detail) = apply_tag_page_truncation(kept, "keep me".into(), TAG_PAGE_SIZE);
            assert_eq!(state, kept, "a positive finding must survive truncation");
            assert_eq!(detail, "keep me", "and keep its own detail");
        }
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

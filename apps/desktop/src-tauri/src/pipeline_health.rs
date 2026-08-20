//! Deployment-pipeline health, aggregated for the top-bar indicator.
//!
//! WHY THIS EXISTS: a review-daemon or a release-runner can fail with NO surface to the founder. The
//! seed case (bead `sparkle-m6jov5`): the roborev daemon wedged — its process alive and holding the
//! port, but `roborev status` reporting "not running" — so code review silently stopped for ~1h36m,
//! commits queued unreviewed, and PRs merged without a completed review. It was found by accident.
//! The whole point of this module is that a silent pipeline outage becomes a VISIBLE one.
//!
//! THE SHAPE: each pipeline component (roborev, the CI runner pool, the release runner, the PR
//! reviewer) is probed independently and reduced to one [`ComponentHealth`] — a name, a
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

/// One component's health, as the top-bar panel renders it. Mirrors the TS `ComponentHealth`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentHealth {
    /// Stable machine id (`roborev`, `ci_runners`, `release_runner`, `knightwatch`). The React key.
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

/// A `Daemon: running` reading — healthy unless the `Health:` line says otherwise.
fn classify_running(out: &str) -> (HealthState, String) {
    let health_line = out.lines().find(|l| l.trim_start().starts_with("Health:"));
    match health_line {
        // "Health: OK" — the daemon reports itself sound. Summarise the queue for the panel.
        Some(h) if h.to_ascii_lowercase().contains("ok") => {
            (HealthState::Healthy, format!("Review daemon running. {}", jobs_summary(out)))
        }
        // A running daemon that reports a non-OK health (e.g. a sick database) — degraded, not down.
        Some(h) => (
            HealthState::Warning,
            format!(
                "roborev is running but reports {} — review may be degraded. Merges and deploys are \
                 unaffected.",
                h.trim()
            ),
        ),
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

/// Build the CI-runner and release-runner components from ONE runners-endpoint read.
fn runner_components(gh_program: Option<String>, root: &str) -> Vec<ComponentHealth> {
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

    vec![
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
    ]
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
        components.extend(runner_components(gh_program, &root));
        components.push(knightwatch_component(&root));
        let overall = overall_state(&components);
        Ok(PipelineHealth { overall, components })
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
        };
        let json = serde_json::to_string(&health).unwrap();
        assert!(json.contains(r#""overall":"warning""#), "{json}");
        assert!(json.contains(r#""state":"blocking""#), "{json}");
        // NotApplicable is two words in Rust, one snake_case token on the wire.
        let na = serde_json::to_string(&comp(HealthState::NotApplicable)).unwrap();
        assert!(na.contains(r#""state":"not_applicable""#), "{na}");
    }
}

//! THE DURABLE ANSWER TO "WHY DID THIS AGENT DIE", WRITTEN WHERE A DYING APP CANNOT ERASE IT.
//!
//! ── THE FAILURE THIS CLOSES ───────────────────────────────────────────────────────────────────
//! Nothing in this app can tell a transient death from a permanent one, so nothing can safely bring
//! an agent back. The fleet-handoff retrospective declined to propose auto-resurrection for exactly
//! that reason. This module is the missing fact.
//!
//! Measured on the founder's machine, 2026-08-06:
//!   • 18:20 PT — the app quit. 54 `SessionEnd` in ONE minute.
//!   • 18:21 — it relaunched; 45 panes resumed.
//!   • 18:47 — it quit again, taking 49 more agents. Exactly ONE came back.
//! App restart is the largest single killer of agents in this app, and it is precisely the case in
//! which the WebView gets no chance to write anything down.
//!
//! ── SO THIS IS AN OPEN/CLOSE LEDGER, OPENED AT SPAWN — NOT A RECORD WRITTEN AT DEATH ──────────
//! A design whose durability depends on a write AT death loses the largest killer by construction.
//! Instead:
//!   open   `state: Live`, stamped with this app instance's epoch — at PTY spawn, always, cheap.
//!   close  an OBSERVED cause — only when the app is alive to see it.
//!   seal   `AppRestart` — INFERRED at the next launch from `Live` + a provably dead epoch.
//!
//! `AppRestart` is never observed and never claims to be. It is what an unclosed record MEANS once
//! its owning instance is gone. Honest limits: app quit, `SIGKILL`, a panic, an OS logout and power
//! loss are ONE value here, because the signal is the absence of a close and every one of them
//! produces exactly that.
//!
//! ── LIVENESS IS A KERNEL-RELEASED `flock`, NOT A HEARTBEAT ────────────────────────────────────
//! Reuses `babysit_lease::epoch_is_alive`. This is correctness, not taste: sleep does NOT release an
//! `flock`, so a slept-and-woken app reads ALIVE and its records correctly stay `Live`. A
//! timestamp-threshold heartbeat would read an 8-hour sleep as death and resurrect a live fleet —
//! and would cost a write per agent per tick to do it.
//!
//! ── WHY THE RECORD IS NOT IN THE AGENT'S WORKTREE ─────────────────────────────────────────────
//! `.sparkle/` is the tempting home (it already holds `worker.json` and `result.json`), but it is
//! NOT in `fleet::WALK_SKIP_DIRS`. Every write would bump `newest_write_ms` — the field whose whole
//! meaning is "is this agent writing anything at all" — so a DEAD agent would look like it was
//! writing forever, and the `git_fingerprint` memo keyed on that walk would re-run per agent per
//! tick. It lives beside `hook-events/` instead.
//!
//! ── NO MODEL CALL ON ANY PATH ─────────────────────────────────────────────────────────────────
//! When the wall is fleet-wide, every LLM in the app is gated behind the same account limit. This
//! module is file I/O and integer comparisons, so it keeps working exactly when it is needed —
//! the same discipline `nudger.rs` states for the same reason.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::babysit_lease::epoch_is_alive;

/// How long a dead-but-resurrectable record keeps its worktree safe from the reaper, measured from
/// the DEATH.
///
/// Chosen to match `retention::HookEventsPolicy::default().orphan_max_age`, but honestly: this is a
/// DUPLICATED literal, not a derived one. An earlier comment here claimed the two "cannot drift",
/// which was false in two ways (roborev 60090) — it is a separate literal, and the thing it mirrors
/// is a runtime-overridable default, so they can diverge by edit and by configuration alike. Keep
/// them in step by hand.
///
/// A protection that never expires is a leak — `wall-spend` in particular could otherwise pin a
/// worktree forever — so it does expire, and the record becomes reapable when it does.
pub const PROTECTION_MAX: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Previous deaths retained on a reopened record. Bounded so a flapping agent cannot grow its own
/// record without limit.
const MAX_PRIOR: usize = 3;

/// The rolling window `attempts_at` is counted over, matching the TS-side per-agent daily cap.
///
/// `attempts_at` MUST be pruned to it (roborev 60103). Left unbounded, the vector grows forever in a
/// file rewritten on every wall/wip/claim/release, and — worse — any consumer reading a count off it
/// sees a LIFETIME total that never decays. An agent respawned enough times over months would report
/// an exhausted budget on a day when the rolling window is empty, so the ladder would be permanently
/// spent for exactly the agents that need it most.
pub const ATTEMPT_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

/// Drop attempts that have aged out of the rolling window.
fn prune_attempts(attempts_at: &mut Vec<i64>, now_ms: i64) {
    let floor = now_ms.saturating_sub(ATTEMPT_WINDOW.as_millis() as i64);
    attempts_at.retain(|t| *t > floor);
}

/// Why an agent session ended. Mirrors `apps/desktop/src/engine/deathTypes.ts`.
///
/// `the_serde_strings_match_deathtypes_ts` guards this vocabulary in BOTH directions, and it is
/// worth knowing exactly how far that goes before trusting it (roborev 60090, 61725, 61785 — two
/// earlier versions of this comment overstated it, then understated it):
///
///   - It parses the `DeathCause` / `DeathEvidence` unions out of `deathTypes.ts` with
///     `include_str!` and compares them against the serde vocabulary as SETS, so a rename on either
///     side fails the test rather than producing records the other end reads as an unknown variant.
///   - `serde_name_cause` / `serde_name_evidence` are exhaustive `match`es, so a new variant cannot
///     compile until someone names its wire string.
///
/// RESIDUAL, and the reason this is a paragraph rather than a sentence: the variant LIST inside the
/// test is still hand-written, because Rust cannot enumerate an enum's variants without `strum`. An
/// author who adds a variant, satisfies the compiler in `serde_name_*`, and never adds it to that
/// list still slips past. The compile error is what brings them to the file; nothing yet forces the
/// last step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeathCause {
    TransportTransient,
    WallSession,
    WallSpend,
    CleanGoalMet,
    BlockedOnHuman,
    AppRestart,
    /// THE AGENT'S PROCESS IS GONE AND NO WINDOW SAW IT GO (bead: transport-death-revival).
    ///
    /// Distinct from `AppRestart`, which means the whole app died and is keyed on a dead EPOCH, and
    /// distinct from `Unknown`, which means a window WATCHED the exit and had nothing to say about
    /// it. This one is written by `reap_dead_sessions_at` on the running app's own tick, for a
    /// record still `Live` under THIS epoch whose PTY session has vanished.
    ///
    /// IT IS RESURRECTABLE, AND THE ASYMMETRY WITH `Unknown` IS THE WHOLE POINT. `Unknown` refuses
    /// resurrection because a human clicking "stop" produces exactly a quiet observed exit — but a
    /// human clicking stop is BY CONSTRUCTION observed, because a mounted pane is what renders the
    /// button. This cause is reached only when NOTHING observed the exit, which is the one case a
    /// deliberate stop cannot produce. Measured on the founder's install: 7 agents sat with a dead
    /// process, a `Live` record and a `working` status for 47 minutes, invisible to recovery,
    /// because the only sealer (`seal_stale_at`) runs at app LAUNCH and keys on a dead epoch.
    ProcessGone,
    Unknown,
}

/// What was actually SEEN. Not decoration: this is what stops a record claiming knowledge nobody had.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeathEvidence {
    QuotaBlock,
    #[serde(rename = "transcript-429")]
    Transcript429,
    ApiBanner,
    BlockingTool,
    GoalMetMarked,
    EpochDead,
    /// The PTY session was ABSENT from the app's own session map while the epoch was still
    /// alive — the reaper's inference, made with no observer. Distinct from `PtyExit`, which means
    /// a window WATCHED the close. Sharing `PtyExit` made `validate` reject every record the
    /// reaper writes (roborev 61705).
    SessionVanished,
    PtyExit,
    SessionEndHook,
    None,
}

/// The cause a given evidence can support ON ITS OWN; `None` when it is compatible with both wall
/// shapes and `resetParsed` is the discriminator. Mirrors `deathTypes.causeOf`.
pub fn cause_of(evidence: DeathEvidence) -> Option<DeathCause> {
    match evidence {
        DeathEvidence::QuotaBlock | DeathEvidence::Transcript429 => None,
        DeathEvidence::ApiBanner => Some(DeathCause::TransportTransient),
        DeathEvidence::BlockingTool => Some(DeathCause::BlockedOnHuman),
        DeathEvidence::GoalMetMarked => Some(DeathCause::CleanGoalMet),
        DeathEvidence::EpochDead => Some(DeathCause::AppRestart),
        DeathEvidence::SessionVanished => Some(DeathCause::ProcessGone),
        DeathEvidence::PtyExit | DeathEvidence::SessionEndHook | DeathEvidence::None => {
            Some(DeathCause::Unknown)
        }
    }
}

/// May this cause EVER be brought back automatically? Mirrors `deathTypes.isResurrectable`.
///
/// `WallSpend` is TRUE, and that is the correction that matters: it cannot be armed on a CLOCK
/// (there is no reset instant), but it is recovered by PROBING — the fleet keeps testing the door on
/// a bounded backoff and returns the moment a probe succeeds. Telling the founder is a byproduct so
/// he can shorten the outage; it is never what the system waits on.
///
/// EXHAUSTIVE `match`, NOT `matches!` (roborev 61725). `matches!` compiles fine against a variant
/// added later and silently answers `false` — so a new cause would default to "never recover", the
/// one direction that costs the user work, with no compile error and no test failure to say so. The
/// `match` forces whoever adds a variant to state the policy.
pub fn is_resurrectable(cause: DeathCause) -> bool {
    match cause {
        DeathCause::TransportTransient
        | DeathCause::WallSession
        | DeathCause::WallSpend
        | DeathCause::AppRestart
        | DeathCause::ProcessGone => true,
        DeathCause::CleanGoalMet | DeathCause::BlockedOnHuman | DeathCause::Unknown => false,
    }
}

/// Only `WallSession` names an instant. Everything else retries or probes, which is what lets this
/// crate compare integers instead of carrying a date/time crate it deliberately does not have.
///
/// Exhaustive for the same reason as `is_resurrectable` above.
pub fn arms_on_clock(cause: DeathCause) -> bool {
    match cause {
        DeathCause::WallSession => true,
        DeathCause::TransportTransient
        | DeathCause::WallSpend
        | DeathCause::CleanGoalMet
        | DeathCause::BlockedOnHuman
        | DeathCause::AppRestart
        | DeathCause::ProcessGone
        | DeathCause::Unknown => false,
    }
}

/// The EXACT wire string serde emits for a cause, written as an exhaustive `match` so a new variant
/// cannot be added without naming its string (roborev 61725).
///
/// This exists because the pin test it feeds was a hand-written `[(variant, "string")]` array, which
/// catches a RENAME but not an ADDITION — a new variant simply is not in the array, so the test
/// passes while the TS union never learns about it. That is precisely how the `SessionVanished`
/// drift got in. The TS side got a `CoversUnion` compile-time guard; this is its Rust mirror.
#[cfg(test)]
fn serde_name_cause(cause: DeathCause) -> &'static str {
    match cause {
        DeathCause::TransportTransient => "transport-transient",
        DeathCause::WallSession => "wall-session",
        DeathCause::WallSpend => "wall-spend",
        DeathCause::CleanGoalMet => "clean-goal-met",
        DeathCause::BlockedOnHuman => "blocked-on-human",
        DeathCause::AppRestart => "app-restart",
        DeathCause::ProcessGone => "process-gone",
        DeathCause::Unknown => "unknown",
    }
}

/// The EXACT wire string serde emits for an evidence. Exhaustive for the same reason as
/// `serde_name_cause` above.
#[cfg(test)]
fn serde_name_evidence(evidence: DeathEvidence) -> &'static str {
    match evidence {
        DeathEvidence::QuotaBlock => "quota-block",
        DeathEvidence::Transcript429 => "transcript-429",
        DeathEvidence::ApiBanner => "api-banner",
        DeathEvidence::BlockingTool => "blocking-tool",
        DeathEvidence::GoalMetMarked => "goal-met-marked",
        DeathEvidence::EpochDead => "epoch-dead",
        DeathEvidence::SessionVanished => "session-vanished",
        DeathEvidence::PtyExit => "pty-exit",
        DeathEvidence::SessionEndHook => "session-end-hook",
        DeathEvidence::None => "none",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifeState {
    Live,
    Dead,
    Claimed,
    Retired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Death {
    pub cause: DeathCause,
    pub evidence: DeathEvidence,
    pub at: i64,
    /// VERBATIM. Never trimmed, normalized or re-cased — cohort correlation keys a map on exact
    /// equality, and a shared-outage report has already silently never fired because two agents'
    /// bytes differed by a newline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_met_at: Option<i64>,
}

/// A wall the agent hit, carried INDEPENDENTLY of `Death`.
///
/// Orthogonal on purpose. An agent that hit a session limit at 18:19 and died to the app quit at
/// 18:20 has BOTH facts true, and recovery needs both — resurrect *because the app died*, but *not
/// before the reset*. Collapsing them loses whichever is written second.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wall {
    pub message: String,
    /// ABSENT when `reset_parsed` is false. Persisting the bounded re-check fallback as a reset
    /// instant would convert a re-check into a durable claim about when someone's money reappears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<i64>,
    pub reset_parsed: bool,
    pub observed_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wip {
    pub head_sha: String,
    /// `None` is NOT `Some(0)` — it means the git read failed, which must not read as "clean".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dirty_files: Option<u32>,
    pub committed: bool,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub by: String,
    pub epoch: String,
    pub at: i64,
    pub attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLifeRecord {
    pub v: u32,
    pub agent_id: String,
    pub project_id: String,
    pub worktree: String,
    pub epoch: String,
    pub opened_at: i64,
    pub state: LifeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub death: Option<Death>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall: Option<Wall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wip: Option<Wip>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<Claim>,
    /// DURABLE respawn timestamps. The per-agent daily cap reads this, and it must survive an app
    /// restart — an in-memory counter would be zeroed by the very event the cap exists to bound.
    #[serde(default)]
    pub attempts_at: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_reason: Option<String>,
    #[serde(default)]
    pub prior: Vec<Death>,
}

/// What a reaper may do with this agent's worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReaperVerdict {
    Protected,
    Reapable,
    /// The honest middle. Emitted for an ABSENT record too: absence is not permission to delete.
    Unknown,
}

/// A record plus everything derived from it. Derivation happens HERE, once, so the TS side cannot
/// grow a second copy of the rules that drifts from this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLifeReading {
    pub record: AgentLifeRecord,
    pub alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_cause: Option<DeathCause>,
    pub resurrectable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_before_ms: Option<i64>,
    pub reaper_verdict: ReaperVerdict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifeError {
    /// A cause its evidence cannot support, or a required field missing.
    Invalid(String),
    /// The stored JSON does not parse. FAIL CLOSED — refuse, do not treat as absent.
    ///
    /// Distinct from `Io` on purpose (roborev 60103). Collapsing the two made a transient `EMFILE` /
    /// `ENFILE` / `EACCES` — realistic in this app, and which `babysit_lease` deliberately treats as
    /// "not evidence" — fail the agent SPAWN path exactly as if the record were corrupt. A caller
    /// can retry an `Io`; it must never retry its way past a `Corrupt`.
    Corrupt(String),
    /// A close that would downgrade a `CleanGoalMet` record.
    Downgrade,
    /// A claim on a record a LIVE epoch already holds.
    HeldLive,
    Io(String),
    BadAgentId,
}

impl std::fmt::Display for LifeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LifeError::Invalid(m) => write!(f, "invalid: {m}"),
            LifeError::Corrupt(m) => write!(f, "corrupt: {m}"),
            LifeError::Downgrade => write!(f, "refused: would downgrade a clean-goal-met record"),
            LifeError::HeldLive => write!(f, "refused: claimed by a live epoch"),
            LifeError::Io(m) => write!(f, "io: {m}"),
            LifeError::BadAgentId => write!(f, "bad agent id"),
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealStats {
    pub scanned: u32,
    pub sealed: u32,
    /// Records left alone because their epoch is still ALIVE — the sleep case.
    pub still_live: u32,
}

// ── store ────────────────────────────────────────────────────────────────────────────────────

/// Same confinement rule `retention.rs` uses. An id that could escape the directory is refused
/// rather than sanitized, because a silently-rewritten id would read and write different files.
fn usable_agent_id(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && !id.contains('/') && !id.contains('\\')
}

fn record_path(dir: &Path, agent_id: &str) -> Option<PathBuf> {
    usable_agent_id(agent_id).then(|| dir.join(format!("{agent_id}.json")))
}

/// Read one record. `Ok(None)` means genuinely absent; a CORRUPT file is `Err`, never `Ok(None)` —
/// the two must not collapse, because "absent" and "unreadable" lead to opposite reaper verdicts.
pub fn read_record_at(dir: &Path, agent_id: &str) -> Result<Option<AgentLifeRecord>, LifeError> {
    let path = record_path(dir, agent_id).ok_or(LifeError::BadAgentId)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(LifeError::Io(e.to_string())),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| LifeError::Corrupt(format!("corrupt record: {e}")))
}

/// Replace a record atomically: temp file in the SAME directory, fsync, rename.
///
/// The fsync matters as much as the rename. `rename` is atomic so a crash can never expose a
/// half-written file under the real name, but without the fsync a crash just after the rename could
/// leave the name pointing at unwritten blocks.
fn write_record_at(dir: &Path, rec: &AgentLifeRecord) -> Result<(), LifeError> {
    let path = record_path(dir, &rec.agent_id).ok_or(LifeError::BadAgentId)?;
    std::fs::create_dir_all(dir).map_err(|e| LifeError::Io(e.to_string()))?;
    // UNIQUE PER WRITE, not per process (roborev 60090). Keying the temp path on the pid alone meant
    // two concurrent writers in the SAME instance — a `note_wall_at` from the quota watcher and a
    // `close_at` from the PTY-exit path — opened the identical file and interleaved their bytes
    // before either renamed, publishing a mixed record under the real name.
    static WRITE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = WRITE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{}.{}.{seq}.tmp", rec.agent_id, std::process::id()));
    let body = serde_json::to_string_pretty(rec).map_err(|e| LifeError::Io(e.to_string()))?;
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| LifeError::Io(e.to_string()))?;
        f.write_all(body.as_bytes())
            .map_err(|e| LifeError::Io(e.to_string()))?;
        f.sync_all().map_err(|e| LifeError::Io(e.to_string()))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| LifeError::Io(e.to_string()))
}

// ── transitions ──────────────────────────────────────────────────────────────────────────────

/// Open (or REOPEN) a record for an agent that is starting. Always safe to call.
///
/// A reopen pushes the previous death onto `prior` and clears the live fields, so a resurrected
/// agent starts clean but its history is not lost. `attempts_at` is deliberately CARRIED OVER — the
/// rolling daily cap counts respawns of an agent, and zeroing it on respawn would make the cap
/// vacuous exactly when it matters.
pub fn open_at(
    dir: &Path,
    agent_id: &str,
    project_id: &str,
    worktree: &str,
    epoch: &str,
    now_ms: i64,
) -> Result<AgentLifeRecord, LifeError> {
    // PROPAGATE an unreadable record rather than treating it as absent (roborev 60090).
    // `read_record_at` separates absent from corrupt precisely because the two must not collapse,
    // and collapsing them here made a reopen behave as a first open: `attempts_at` silently reset,
    // `prior` discarded, and the `clean-goal-met` latch cleared. That would make the daily respawn
    // cap vacuous under exactly the conditions it exists for — a thrashing agent, descriptor
    // pressure — and would let a finished agent be resurrected after a bad read.
    let existing = read_record_at(dir, agent_id)?;
    let mut prior = Vec::new();
    let mut attempts_at = Vec::new();
    if let Some(old) = existing {
        if let Some(d) = old.death.clone() {
            prior.push(d);
        }
        prior.extend(old.prior.into_iter());
        prior.truncate(MAX_PRIOR);
        attempts_at = old.attempts_at;
    }
    let rec = AgentLifeRecord {
        v: 1,
        agent_id: agent_id.to_string(),
        project_id: project_id.to_string(),
        worktree: worktree.to_string(),
        epoch: epoch.to_string(),
        opened_at: now_ms,
        state: LifeState::Live,
        death: None,
        wall: None,
        wip: None,
        claim: None,
        attempts_at,
        retired_at: None,
        retired_reason: None,
        prior,
    };
    write_record_at(dir, &rec)?;
    Ok(rec)
}

/// Validate a death against the honesty rule before anything is persisted.
fn validate(death: &Death, wall: Option<&Wall>) -> Result<(), LifeError> {
    if death.evidence == DeathEvidence::None && death.cause != DeathCause::Unknown {
        return Err(LifeError::Invalid(
            "a cause with no evidence is a guess wearing a fact's clothes".into(),
        ));
    }
    if death.cause == DeathCause::CleanGoalMet && death.goal_met_at.is_none() {
        return Err(LifeError::Invalid(
            "clean-goal-met needs a positive metAt; a turn merely ending is not a met goal".into(),
        ));
    }
    if death.cause == DeathCause::WallSpend {
        if let Some(w) = wall {
            if w.reset_at.is_some() {
                return Err(LifeError::Invalid(
                    "a spend cap has no reset instant; persisting the fallback would claim one".into(),
                ));
            }
        }
    }
    match cause_of(death.evidence) {
        None => {
            if !matches!(death.cause, DeathCause::WallSession | DeathCause::WallSpend) {
                return Err(LifeError::Invalid("wall evidence supports only a wall cause".into()));
            }
        }
        Some(only) if only != death.cause => {
            return Err(LifeError::Invalid(format!(
                "evidence {:?} cannot support cause {:?}",
                death.evidence, death.cause
            )));
        }
        _ => {}
    }
    Ok(())
}

/// RECORD A DELIBERATE STOP — the whole mechanism `pty_kill` performs, as one testable call.
///
/// This is the ledger half of "the user stopped this agent", and it lives here rather than in
/// `pty.rs` so a test can drive the REAL thing (roborev 61770). It used to be a private fn taking
/// an `&AppHandle`, which nothing could call: the Rust test that asserted what the write buys
/// hand-built the same `Death` and called `close_at` itself — a COPY of the mechanism. Deleting the
/// call from `pty_kill`, or changing its cause to something resurrectable, left the entire suite
/// green while every ordinary stop path became resurrectable again.
///
/// ── WHY `Dead`/`unknown` AND NOT `Retired` (roborev 61714) ────────────────────────────────────
/// `Retired` carries more meaning than "do not resurrect": `derive` maps it to
/// `ReaperVerdict::Reapable` UNCONDITIONALLY, with none of the `PROTECTION_MAX` grace `Dead` gets.
/// But "stop the agents when I close this window" is explicitly not "delete them" — the records and
/// tabs are meant to survive — and the promotion cutover kills the LOCAL pty for an agent that is
/// still alive in the cloud on that same worktree. Marking either `Reapable` would hand a worktree
/// holding uncommitted work to any future reaper.
///
/// `unknown` needs no new vocabulary: `deathTypes` documents it as "a human clicking stop produces
/// exactly this observation", and `is_resurrectable` refuses it. `PtyExit` is the honest evidence —
/// a window watched this close, which is what makes it distinct from the reaper's `SessionVanished`.
///
/// ONLY a `Live` record is touched, so this can never downgrade a richer verdict a window already
/// observed (a met goal, a wall, a transport banner). `Ok(false)` means "there was nothing to mark",
/// which is a normal outcome and not a failure.
pub fn mark_stopped_at(dir: &Path, agent_id: &str, now_ms: i64) -> Result<bool, LifeError> {
    match read_record_at(dir, agent_id)? {
        Some(rec) if rec.state == LifeState::Live => {}
        _ => return Ok(false),
    }
    let death = Death {
        cause: DeathCause::Unknown,
        evidence: DeathEvidence::PtyExit,
        at: now_ms,
        message: None,
        goal_met_at: None,
    };
    close_at(dir, agent_id, death, None)?;
    Ok(true)
}

/// Record an OBSERVED death. Refuses to downgrade a finished agent.
pub fn close_at(
    dir: &Path,
    agent_id: &str,
    death: Death,
    wall: Option<Wall>,
) -> Result<AgentLifeRecord, LifeError> {
    validate(&death, wall.as_ref())?;
    let mut rec = read_record_at(dir, agent_id)?
        .ok_or_else(|| LifeError::Invalid("no open record".into()))?;

    // The latch that makes "never resurrect a finished agent" survive a later stray `unknown`.
    // Only `open_at` (a genuine respawn) clears it.
    if rec
        .death
        .as_ref()
        .is_some_and(|d| d.cause == DeathCause::CleanGoalMet)
        && death.cause != DeathCause::CleanGoalMet
    {
        return Err(LifeError::Downgrade);
    }

    rec.state = LifeState::Dead;
    rec.death = Some(death);
    // A wall the caller reports is recorded; one already on the record is NEVER dropped, because it
    // is an independent fact this close may know nothing about.
    if wall.is_some() {
        rec.wall = wall;
    }

    // THE DEATH IS ALWAYS WRITTEN (roborev 60103).
    //
    // An earlier version validated the RESULTING record and returned `Err` when a stale wall made
    // the shape illegal — so a session wall noted by the quota watcher, followed by a spend-cap
    // death from the PTY-exit path that knows nothing about it, dropped the death entirely. The
    // record stayed `Live` under the current epoch, and `derive` then reported that dead agent as
    // alive, not resurrectable and Protected: permanently mis-stated, never sealed, worktree
    // pinned. Trading a fail-open on liveness for a shape invariant is the wrong trade.
    //
    // A caller that PASSES a spend wall carrying a reset is still rejected outright by `validate`
    // above, which is where that mistake belongs.
    // THE STORED WALL IS LEFT ALONE. Two earlier attempts got this wrong in opposite directions and
    // both failed the same way — resolving an ambiguity in favour of the weaker source (roborev
    // 60103, 60112, 60123). Rewriting `reset_parsed` to false forged the spend-cap signal onto a
    // message that names a reset time; dropping the wall wholesale deleted that message AND its
    // reset instant, so nothing durable remained to correct the classification later.
    //
    // Neither was necessary. `arms_on_clock(WallSpend)` is false, so `derive` never reads
    // `wall.reset_at` for a spend death — retaining the wall costs the reader nothing. The shape
    // rule belongs on CALLER INPUT, where `validate` already enforces it, not on the stored record:
    // a wall already here is an independent observation this close may know nothing about, which is
    // exactly what `seal_stale_at` is pinned to preserve. Keeping both facts is what lets a later
    // reader see that a spend classification landed on top of a parsed session wall.
    write_record_at(dir, &rec)?;
    Ok(rec)
}

/// Record a wall without closing the record. Used when an agent is walled but still alive.
pub fn note_wall_at(dir: &Path, agent_id: &str, wall: Wall) -> Result<(), LifeError> {
    let mut rec = read_record_at(dir, agent_id)?
        .ok_or_else(|| LifeError::Invalid("no open record".into()))?;
    rec.wall = Some(wall);
    write_record_at(dir, &rec)
}

pub fn note_wip_at(dir: &Path, agent_id: &str, wip: Wip) -> Result<(), LifeError> {
    let mut rec = read_record_at(dir, agent_id)?
        .ok_or_else(|| LifeError::Invalid("no open record".into()))?;
    rec.wip = Some(wip);
    write_record_at(dir, &rec)
}

/// Take the resurrection claim. A claim held by a DEAD epoch is taken over — with its `attempts`
/// preserved, so a claimant that died mid-ladder cannot hand its successor a fresh budget.
pub fn claim_at(
    dir: &Path,
    app_data: &Path,
    agent_id: &str,
    by: &str,
    epoch: &str,
    now_ms: i64,
) -> Result<AgentLifeRecord, LifeError> {
    let mut rec = read_record_at(dir, agent_id)?
        .ok_or_else(|| LifeError::Invalid("no record".into()))?;
    if let Some(c) = &rec.claim {
        if c.epoch != epoch && epoch_still_running(app_data, &c.epoch) {
            return Err(LifeError::HeldLive);
        }
    }
    // Attempts come from the DURABLE list, not from the claim being taken over — `release_at` clears
    // the claim, so reading a count off it would hand every new claimant a fresh budget. Pruned to
    // the rolling window first, so this is a budget that decays rather than a lifetime total.
    prune_attempts(&mut rec.attempts_at, now_ms);
    let attempts = u32::try_from(rec.attempts_at.len()).unwrap_or(u32::MAX);
    rec.state = LifeState::Claimed;
    rec.claim = Some(Claim {
        by: by.to_string(),
        epoch: epoch.to_string(),
        at: now_ms,
        attempts,
    });
    write_record_at(dir, &rec)?;
    Ok(rec)
}

/// Give the claim back after an attempt. `spawned` records the attempt durably, which is what the
/// rolling daily cap counts.
pub fn release_at(
    dir: &Path,
    app_data: &Path,
    agent_id: &str,
    epoch: &str,
    spawned: bool,
    now_ms: i64,
) -> Result<AgentLifeRecord, LifeError> {
    let mut rec = read_record_at(dir, agent_id)?
        .ok_or_else(|| LifeError::Invalid("no record".into()))?;

    // OWNERSHIP CHECK, mirroring `claim_at` (roborev 60103). Release became destructive in the last
    // change, and a destructive release with no owner check hands exclusivity away: an instance
    // correctly refused by `claim_at` with `HeldLive` could call this — from a retry path, a cleanup
    // sweep, a reconciler tidying anything in `Claimed` — clear the holder's claim, take it, and
    // respawn an agent the holder is respawning at that same moment. Two processes, one worktree.
    if let Some(c) = &rec.claim {
        if c.epoch != epoch && epoch_still_running(app_data, &c.epoch) {
            return Err(LifeError::HeldLive);
        }
    }

    if spawned {
        rec.attempts_at.push(now_ms);
    }
    prune_attempts(&mut rec.attempts_at, now_ms);
    // ACTUALLY RELEASE (roborev 60090). The claim used to be left in place, so a claim recorded by
    // one epoch kept returning `HeldLive` to every other live epoch with no path to relinquish it.
    // `attempts_at` is the durable count, so nothing is lost by dropping the claim itself.
    rec.claim = None;
    // …and only demote a record that is still CLAIMED. Under the natural protocol — claim, respawn
    // (which calls `open_at` and sets Live), release — an unconditional demotion stamped a freshly
    // respawned, RUNNING agent as `Dead` with no death, which `derive` then reported as not alive
    // and `seal_stale_at` would never touch: permanently mis-stated.
    if rec.state == LifeState::Claimed {
        rec.state = LifeState::Dead;
    }
    write_record_at(dir, &rec)?;
    Ok(rec)
}

pub fn retire_at(
    dir: &Path,
    agent_id: &str,
    reason: &str,
    now_ms: i64,
) -> Result<(), LifeError> {
    let mut rec = read_record_at(dir, agent_id)?
        .ok_or_else(|| LifeError::Invalid("no record".into()))?;
    rec.state = LifeState::Retired;
    rec.retired_at = Some(now_ms);
    rec.retired_reason = Some(reason.to_string());
    write_record_at(dir, &rec)
}

/// Turn every `Live` record whose epoch is provably dead into an `AppRestart` death.
///
/// Idempotent, and it must run BEFORE any pane mounts, so a reader sees a settled record instead of
/// racing the sealer. A record whose epoch is still ALIVE is left completely alone — that is the
/// sleep case, and getting it wrong would resurrect a live fleet.
pub fn seal_stale_at(
    dir: &Path,
    app_data: &Path,
    current_epoch: &str,
    now_ms: i64,
) -> Result<SealStats, LifeError> {
    let mut stats = SealStats::default();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(stats),
        Err(e) => return Err(LifeError::Io(e.to_string())),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(agent_id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Ok(Some(mut rec)) = read_record_at(dir, agent_id) else { continue };
        stats.scanned += 1;
        if rec.state != LifeState::Live {
            continue;
        }
        if rec.epoch == current_epoch || epoch_is_alive(app_data, &rec.epoch) {
            stats.still_live += 1;
            continue;
        }
        rec.state = LifeState::Dead;
        rec.death = Some(Death {
            cause: DeathCause::AppRestart,
            evidence: DeathEvidence::EpochDead,
            at: now_ms,
            message: None,
            goal_met_at: None,
        });
        // `rec.wall` is left EXACTLY as it was. An agent walled at 18:19 and killed by the quit at
        // 18:20 has both facts, and recovery needs both — the sealer observed only one of them.
        write_record_at(dir, &rec)?;
        stats.sealed += 1;
    }
    Ok(stats)
}

/// How long a freshly-opened record is immune from the session reaper.
///
/// NOT a tuning knob — it closes a REAL race with a definite direction. `openDeathRecord` runs at
/// SPAWN, deliberately before anything else (its own doc: "the open is the load-bearing write"),
/// and `pty_spawn` inserts the session only afterwards. So between those two writes a perfectly
/// healthy agent has a `Live` record and NO live session, which is byte-for-byte the state this
/// reaper kills on. Without the grace window the reaper would seal every agent the instant it was
/// created, and the resurrector would then respawn it — an infinite spawn/kill loop across the
/// whole fleet, which is the single worst outcome available in this module.
///
/// 60s is orders of magnitude more than the observed open→spawn gap (milliseconds) while still
/// being far below the 15s×N it takes the TS sweep to act on anything.
pub const REAP_GRACE_MS: i64 = 60_000;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReapStats {
    pub scanned: u32,
    pub reaped: u32,
    /// Left alone because a live PTY session still answers for them.
    pub still_live: u32,
    /// Left alone because they are younger than {@link REAP_GRACE_MS}.
    pub too_young: u32,
    /// Left alone because they belong to a DIFFERENT epoch — not ours to judge.
    pub not_ours: u32,
}

/// SEAL EVERY RECORD WHOSE AGENT PROCESS IS GONE, ON THE RUNNING APP'S OWN CLOCK.
///
/// ── THE HOLE THIS FILLS ───────────────────────────────────────────────────────────────────────
/// `seal_stale_at` is the only other sealer and it runs at APP LAUNCH, keyed on a dead EPOCH. So it
/// covers exactly one death: the app quitting. It cannot see the far more common one — a single
/// agent's `claude` exiting while the app keeps running — because that record's epoch is this very
/// process, which is alive by definition.
///
/// The consequence was measured on the founder's install and it is total: `derive` computes
/// `alive = state == Live && epoch_alive`, so an agent whose process died hours ago still reads
/// ALIVE, `due_at`'s first gate skips it, and it can never be published as due. Seven agents sat in
/// exactly that state for 47 minutes — dead process, `Live` record, and a `working` status the
/// screen scraper kept re-asserting off a frozen spinner frame. Every death record on that machine
/// arrived in an app-quit burst; individual deaths produced four records in two days against ~40
/// agents a day restarted by hand.
///
/// ── WHY THE WEBVIEW CANNOT BE THE ANSWER ──────────────────────────────────────────────────────
/// `StatusEngine.exit()` → `recordDeath` is the observed path, and it requires a MOUNTED pane —
/// `classifyDeath`'s Gate 0 refuses to write anything when `liveness !== "local"`. Panes mount
/// lazily per project, so most of the fleet has no observer at any given moment. A death nobody is
/// watching has to be inferred from an artifact, and the PTY session map is that artifact.
///
/// ── THE THREE GATES, AND WHY EACH ONE IS LOAD-BEARING ─────────────────────────────────────────
///  1. `rec.epoch == current_epoch`. `live_sessions` is THIS process's PTY map, so it is evidence
///     about OUR agents only. Judging another live instance's records against it would report its
///     entire healthy fleet as dead — the same catastrophic direction `epoch_still_running`'s
///     short-circuit exists to prevent. A record under a DEAD epoch is `seal_stale_at`'s job and is
///     deliberately left alone here.
///  2. The session is absent. Present ⇒ the agent is running; nothing to do.
///  3. Older than {@link REAP_GRACE_MS} — see that constant for the open-before-spawn race.
///
/// Idempotent: a record already `Dead`, `Claimed` or `Retired` is skipped, so re-running never
/// rewrites a verdict a window recorded with real evidence.
pub fn reap_dead_sessions_at(
    dir: &Path,
    current_epoch: &str,
    live_sessions: &std::collections::HashSet<String>,
    now_ms: i64,
) -> Result<ReapStats, LifeError> {
    let mut stats = ReapStats::default();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(stats),
        Err(e) => return Err(LifeError::Io(e.to_string())),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(agent_id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        // A record we cannot parse is SKIPPED, never sealed. Same asymmetry `revival::read_ledger`
        // argues for: one torn file must not take the rest of the ledger with it, and inventing a
        // death for bytes we could not read would be the worst possible way to fail.
        let Ok(Some(mut rec)) = read_record_at(dir, agent_id) else { continue };
        stats.scanned += 1;
        if rec.state != LifeState::Live {
            continue;
        }
        if rec.epoch != current_epoch {
            stats.not_ours += 1;
            continue;
        }
        if live_sessions.contains(agent_id) {
            stats.still_live += 1;
            continue;
        }
        if now_ms.saturating_sub(rec.opened_at) < REAP_GRACE_MS {
            stats.too_young += 1;
            continue;
        }
        let death = Death {
            cause: DeathCause::ProcessGone,
            evidence: DeathEvidence::SessionVanished,
            at: now_ms,
            message: None,
            goal_met_at: None,
        };
        // THROUGH `validate`, not around it (roborev 61705). Writing straight to
        // `write_record_at` is what let the first version persist a `{ProcessGone, PtyExit}` pair
        // that `validate` would have rejected — an invariant the module states and enforces "at the
        // persistence boundary" quietly becoming untrue for the only records this path writes.
        // A record that fails the check is SKIPPED, never forced: this is an inference, and an
        // inference that cannot satisfy the module's own honesty rule has no business being stored.
        if let Err(e) = validate(&death, rec.wall.as_ref()) {
            tracing::warn!(target: "revival", agent_id, error = %e, "refusing to write an unsupported reaper verdict");
            continue;
        }
        rec.state = LifeState::Dead;
        rec.death = Some(death);
        // `rec.wall` survives untouched, exactly as in `seal_stale_at`: an agent walled at 18:19
        // whose process then vanished has both facts true, and recovery needs both — resurrect
        // because it died, but not before the reset.
        write_record_at(dir, &rec)?;
        stats.reaped += 1;
    }
    Ok(stats)
}

// ── reading ──────────────────────────────────────────────────────────────────────────────────

/// Is the epoch that stamped this record still running?
///
/// THE CURRENT EPOCH IS ALIVE BY DEFINITION, and that short-circuit is load-bearing rather than an
/// optimisation (roborev 60090). `epoch_is_alive` answers from a `babysit-instance-<epoch>.lock`
/// that only the babysit LEASE path ever creates, so an app instance that has not yet taken a lease
/// has no lock file — and "no liveness file" reads as `false`. On a non-Unix build the predicate is
/// a hardcoded `false` outright. Without this guard, every `Live` record in a perfectly healthy app
/// derived `alive: false`, `effective_cause: AppRestart`, `resurrectable: true`: the entire RUNNING
/// fleet reporting as dead and immediately respawnable, which is precisely the catastrophic
/// direction this module's flock is supposed to rule out. `seal_stale_at` already had the guard;
/// `derive` did not, and only `derive` feeds the resurrection path.
pub(crate) fn epoch_still_running(app_data: &Path, epoch: &str) -> bool {
    epoch == crate::babysit_lease::process_epoch() || epoch_is_alive(app_data, epoch)
}

fn derive(rec: AgentLifeRecord, app_data: &Path, now_ms: i64) -> AgentLifeReading {
    let epoch_alive = epoch_still_running(app_data, &rec.epoch);
    let alive = rec.state == LifeState::Live && epoch_alive;

    // A `Live` record under a dead epoch is ALREADY an app restart; it just has not been sealed yet.
    // Reporting it as such here is what makes a reader that races the sealer still correct.
    let effective_cause = match rec.state {
        LifeState::Live if epoch_alive => None,
        LifeState::Live => Some(DeathCause::AppRestart),
        _ => rec.death.as_ref().map(|d| d.cause),
    };

    let resurrectable = effective_cause.is_some_and(is_resurrectable);
    let not_before_ms = effective_cause.and_then(|c| {
        if !is_resurrectable(c) {
            None
        } else if arms_on_clock(c) {
            rec.wall.as_ref().and_then(|w| w.reset_at)
        } else {
            // An app restart still honours a wall that rode along with it — and so does a process
            // that simply vanished. Neither death OBSERVED the wall, but the record carries it, and
            // respawning into a window that has not reopened is the measured 45-retry failure.
            match c {
                DeathCause::AppRestart | DeathCause::ProcessGone => {
                    rec.wall.as_ref().and_then(|w| w.reset_at).or(Some(now_ms))
                }
                _ => Some(now_ms),
            }
        }
    });

    let reaper_verdict = match rec.state {
        // A reaper racing the sealer must LOSE: this record is about to become the most
        // resurrectable state there is.
        LifeState::Live => ReaperVerdict::Protected,
        // Claimed ages out too (roborev 60090). A claimant that dies between `claim_at` and
        // `release_at` is a first-class case — `claim_at` is written to take over from one — and
        // without an expiry its record stays Claimed forever, pinning the worktree forever. That is
        // exactly the leak PROTECTION_MAX exists to rule out.
        LifeState::Claimed => {
            // BOUNDED BY THE DEATH, not by the claim (roborev 60103). Measuring from `claim.at` let a
            // claim RE-ARM protection past the deadline the death had already set: a record dead for
            // seven days, already Reapable, became Protected for another full window the instant a
            // resurrector claimed it — and since `claim_at` rewrites `claim.at` on every takeover, a
            // claimant that keeps claiming without releasing extends the pin indefinitely. That is
            // the same never-expiring protection this constant exists to rule out, reintroduced
            // through the state the previous change was hardening.
            let since = rec
                .death
                .as_ref()
                .map(|d| d.at)
                .or_else(|| rec.claim.as_ref().map(|c| c.at))
                .unwrap_or(rec.opened_at);
            if now_ms.saturating_sub(since) > PROTECTION_MAX.as_millis() as i64 {
                ReaperVerdict::Reapable
            } else {
                ReaperVerdict::Protected
            }
        }
        LifeState::Retired => ReaperVerdict::Reapable,
        LifeState::Dead => {
            // Measured from the DEATH, not from the open (roborev 60090). An agent that ran happily
            // for eight days and then died to an app restart was `Reapable` the instant it died —
            // its worktree destroyed while it was still resurrectable, the exact opposite of what
            // this constant is documented to guarantee.
            let since = rec.death.as_ref().map_or(rec.opened_at, |d| d.at);
            let expired = now_ms.saturating_sub(since) > PROTECTION_MAX.as_millis() as i64;
            match effective_cause {
                Some(DeathCause::CleanGoalMet) => ReaperVerdict::Reapable,
                _ if expired => ReaperVerdict::Reapable,
                Some(c) if is_resurrectable(c) => ReaperVerdict::Protected,
                // An unclassified death is protected too: fail closed in BOTH directions — do not
                // resurrect it, and do not destroy it either.
                _ => ReaperVerdict::Protected,
            }
        }
    };

    AgentLifeReading {
        record: rec,
        alive,
        effective_cause,
        resurrectable,
        not_before_ms,
        reaper_verdict,
    }
}

pub fn read_at(
    dir: &Path,
    app_data: &Path,
    agent_id: &str,
    now_ms: i64,
) -> Result<Option<AgentLifeReading>, LifeError> {
    Ok(read_record_at(dir, agent_id)?.map(|r| derive(r, app_data, now_ms)))
}

/// THE RECONCILER'S ONE QUESTION.
///
/// An ABSENT record answers `Unknown`, never `Reapable`. A worktree this module never saw is one the
/// reaper must judge on its own evidence — absence is not permission to delete. An UNREADABLE record
/// answers `Unknown` for the same reason.
pub fn reaper_verdict_at(dir: &Path, app_data: &Path, agent_id: &str, now_ms: i64) -> ReaperVerdict {
    match read_at(dir, app_data, agent_id, now_ms) {
        Ok(Some(r)) => r.reaper_verdict,
        Ok(None) => ReaperVerdict::Unknown,
        Err(_) => ReaperVerdict::Unknown,
    }
}

/// Every record, keyed by agent id.
///
/// Returns `Result`, NEVER a bare map: a module that hands back an empty collection when it cannot
/// read its own store has told the reaper "nothing is protected", which is the most destructive
/// possible way to fail.
pub fn list_at(
    dir: &Path,
    app_data: &Path,
    now_ms: i64,
) -> Result<BTreeMap<String, AgentLifeReading>, LifeError> {
    let mut out = BTreeMap::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(LifeError::Io(e.to_string())),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(agent_id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if let Some(reading) = read_at(dir, app_data, agent_id, now_ms)? {
            out.insert(agent_id.to_string(), reading);
        }
    }
    Ok(out)
}

// ── the command layer ────────────────────────────────────────────────────────────────────────
//
// THIN WRAPPERS ONLY. Every rule above stays in the pure `*_at` cores, which is what lets the 37
// tests in this file exercise the whole policy against a `tempdir` with no Tauri runtime in sight.
// A command here may resolve a directory, stamp the clock and hop off the main thread — nothing
// else. If you find yourself writing an `if` in one of these, it belongs upstairs.
//
// EVERY ONE IS `pub async fn` + `spawn_blocking`, and `every_tauri_command_here_runs_off_the_main_thread`
// below fails the build if one is not. That is not ceremony: a sync `#[tauri::command]` body runs on
// the MAIN thread, and these do file I/O over the whole ledger — `list_at` reads and derives every
// record, once per sweep. Put that in front of the AppKit event loop and the symptom is the
// concierge control bridge timing out (`bridge request timeout: concierge_tool`), which is the exact
// failure `inbox.rs` documents and guards the same way.

/// `<app_data>/agent-life`. Beside `hook-events/`, deliberately NOT inside the agent's worktree —
/// see this module's header for why a write there would make a dead agent look like it was writing.
pub fn life_dir(base: &Path) -> PathBuf {
    base.join("agent-life")
}

/// `(ledger dir, app_data)`. Both, because every reading predicate needs `app_data` to answer
/// "is that epoch still alive" from its `flock`.
fn dirs_of(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let base = crate::dev_identity::app_data_dir(app)?;
    Ok((life_dir(&base), base))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Open (or reopen) a record. Called at PTY spawn, always, and safe to call more than once.
#[tauri::command]
pub async fn agent_life_open(
    app: tauri::AppHandle,
    agent_id: String,
    project_id: String,
    worktree: String,
) -> Result<(), String> {
    let (dir, _) = dirs_of(&app)?;
    let epoch = crate::babysit_lease::process_epoch();
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || {
        open_at(&dir, &agent_id, &project_id, &worktree, epoch, now).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Record an OBSERVED death. The caller supplies the whole verdict; the classification rules live in
/// `engine/deathRecord.ts` and the honesty rule is re-checked by `validate` on this side.
#[tauri::command]
pub async fn agent_life_close(
    app: tauri::AppHandle,
    agent_id: String,
    death: Death,
    wall: Option<Wall>,
) -> Result<(), String> {
    let (dir, _) = dirs_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || close_at(&dir, &agent_id, death, wall).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Record a wall on a record that is still open. A walled agent is not yet a dead one.
#[tauri::command]
pub async fn agent_life_note_wall(
    app: tauri::AppHandle,
    agent_id: String,
    wall: Wall,
) -> Result<(), String> {
    let (dir, _) = dirs_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || note_wall_at(&dir, &agent_id, wall))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_life_read(
    app: tauri::AppHandle,
    agent_id: String,
) -> Result<Option<AgentLifeReading>, String> {
    let (dir, app_data) = dirs_of(&app)?;
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || read_at(&dir, &app_data, &agent_id, now))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_life_list(
    app: tauri::AppHandle,
) -> Result<BTreeMap<String, AgentLifeReading>, String> {
    let (dir, app_data) = dirs_of(&app)?;
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || list_at(&dir, &app_data, now))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Take the resurrection claim. `Ok(false)` means a LIVE epoch already holds it — a refusal, not an
/// error, because that is the ordinary outcome of two windows racing and the caller's correct
/// response is to skip this agent rather than to log a failure.
#[tauri::command]
pub async fn agent_life_claim(
    app: tauri::AppHandle,
    agent_id: String,
    by: String,
) -> Result<bool, String> {
    let (dir, app_data) = dirs_of(&app)?;
    let epoch = crate::babysit_lease::process_epoch();
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || {
        match claim_at(&dir, &app_data, &agent_id, &by, epoch, now) {
            Ok(_) => Ok(true),
            Err(LifeError::HeldLive) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Give the claim back. `spawned` is what records the attempt DURABLY, which is the number the
/// rolling per-agent daily cap counts — so it must be true exactly when a respawn was performed.
#[tauri::command]
pub async fn agent_life_release(
    app: tauri::AppHandle,
    agent_id: String,
    spawned: bool,
) -> Result<(), String> {
    let (dir, app_data) = dirs_of(&app)?;
    let epoch = crate::babysit_lease::process_epoch();
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || {
        release_at(&dir, &app_data, &agent_id, epoch, spawned, now).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Retire a record: this agent is finished with, and its worktree may be reaped.
#[tauri::command]
pub async fn agent_life_retire(
    app: tauri::AppHandle,
    agent_id: String,
    reason: String,
) -> Result<(), String> {
    let (dir, _) = dirs_of(&app)?;
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || retire_at(&dir, &agent_id, &reason, now))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_754_534_400_000;
    const SESSION_WALL: &str = "You've hit your session limit · resets 10:30pm (America/Los_Angeles)";
    const SPEND_WALL: &str =
        "You've hit your monthly spend limit · raise it at claude.ai/settings/usage";

    fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let td = tempfile::tempdir().expect("tempdir");
        let dir = td.path().join("agent-life");
        let app_data = td.path().join("app-data");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&app_data).unwrap();
        (td, dir, app_data)
    }

    fn open(dir: &Path, id: &str, epoch: &str) -> AgentLifeRecord {
        open_at(dir, id, "proj", "/wt", epoch, NOW).expect("open")
    }

    /// Register a REAL held liveness lock for `epoch`, the way a running instance does.
    ///
    /// The returned `File` owns the lock: keep it in scope for as long as the epoch should read
    /// alive, drop it to simulate that instance exiting. `flock` is per open-file-description, so a
    /// separate `File::open` inside `epoch_is_alive` genuinely conflicts even in this same process —
    /// which is what makes this an honest test of the predicate rather than of a stub.
    #[cfg(unix)]
    fn hold_test_lock(app_data: &Path, epoch: &str) -> std::fs::File {
        use std::os::unix::io::AsRawFd;
        let path = app_data.join(format!("babysit-instance-{epoch}.lock"));
        let file = std::fs::File::create(&path).expect("create lock file");
        // SAFETY: an advisory lock on a descriptor we just created and own.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_eq!(rc, 0, "test could not take the lock it is about to assert on");
        file
    }

    fn death(cause: DeathCause, evidence: DeathEvidence) -> Death {
        Death { cause, evidence, at: NOW, message: None, goal_met_at: None }
    }

    /// The TS union's own members, read out of `deathTypes.ts` at compile time.
    ///
    /// Only lines whose trimmed form starts with `| "` are taken: the doc comments BETWEEN the
    /// members quote other members by name (`Distinct from "pty-exit"`), so a naive scan for quoted
    /// strings would silently accept a union that lost a member as long as some comment still
    /// mentioned it.
    fn ts_union_members(src: &str, type_name: &str) -> Vec<String> {
        let head = format!("export type {type_name} =");
        let body = src.split(&head).nth(1).unwrap_or_else(|| panic!("{type_name} not found in deathTypes.ts"));
        let mut out = Vec::new();
        for line in body.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("| \"") {
                let Some(end) = rest.find('"') else { continue };
                out.push(rest[..end].to_string());
            }
            // The union ends at the first `;` that terminates a member line.
            if t.ends_with("\";") {
                break;
            }
        }
        assert!(!out.is_empty(), "parsed no members for {type_name} — the parser, not the union, is probably wrong");
        out
    }

    /// THE RUST↔TS WIRE VOCABULARY IS ONE SET, AND BOTH ENDS MUST HOLD ALL OF IT.
    ///
    /// This used to be a hand-written `[(variant, "string")]` array, which catches a RENAME and not
    /// an ADDITION (roborev 61725): a new variant simply is not in the array, so the array agrees
    /// with itself and the test passes while the other end never learns the value exists. That is
    /// how the `session-vanished` drift got in, and it is the exact hole the TS side closed with its
    /// `CoversUnion` guard. Two changes close it here:
    ///
    ///   1. The expected string comes from `serde_name_cause` / `serde_name_evidence`, which are
    ///      EXHAUSTIVE matches — a new variant fails to COMPILE until someone names its string.
    ///   2. The resulting set is compared against the TS union parsed out of `deathTypes.ts`, so a
    ///      value that exists on one side and not the other is a test failure rather than a record
    ///      the other end reads as an unknown variant.
    ///
    /// Residual, stated rather than papered over: the variant LIST below is still hand-written
    /// (Rust cannot enumerate an enum's variants without `strum`), so an author who adds a variant,
    /// satisfies the compiler in `serde_name_*`, and does not add it here still slips past. The
    /// compile error is the moment they are told to come to this file; the doc comment on
    /// `serde_name_cause` is what tells them the rest.
    #[test]
    fn the_serde_strings_match_deathtypes_ts() {
        let src = include_str!("../../src/engine/deathTypes.ts");

        let causes = [
            DeathCause::TransportTransient,
            DeathCause::WallSession,
            DeathCause::WallSpend,
            DeathCause::CleanGoalMet,
            DeathCause::BlockedOnHuman,
            DeathCause::AppRestart,
            DeathCause::ProcessGone,
            DeathCause::Unknown,
        ];
        for c in causes {
            // serde really emits what the exhaustive helper claims…
            assert_eq!(
                serde_json::to_string(&c).unwrap(),
                format!("\"{}\"", serde_name_cause(c)),
                "serde's wire string for {c:?} is not what serde_name_cause says it is"
            );
        }
        // …and that vocabulary is exactly the TS union's, in both directions.
        let mut rust: Vec<String> = causes.iter().map(|c| serde_name_cause(*c).to_string()).collect();
        let mut ts = ts_union_members(src, "DeathCause");
        rust.sort();
        ts.sort();
        assert_eq!(
            rust, ts,
            "DeathCause has drifted from deathTypes.ts — a value one end emits the other reads as \
             an unknown variant"
        );

        let evidence = [
            DeathEvidence::QuotaBlock,
            DeathEvidence::Transcript429,
            DeathEvidence::ApiBanner,
            DeathEvidence::BlockingTool,
            DeathEvidence::GoalMetMarked,
            DeathEvidence::EpochDead,
            DeathEvidence::SessionVanished,
            DeathEvidence::PtyExit,
            DeathEvidence::SessionEndHook,
            DeathEvidence::None,
        ];
        for e in evidence {
            assert_eq!(
                serde_json::to_string(&e).unwrap(),
                format!("\"{}\"", serde_name_evidence(e)),
                "serde's wire string for {e:?} is not what serde_name_evidence says it is"
            );
        }
        let mut rust: Vec<String> =
            evidence.iter().map(|e| serde_name_evidence(*e).to_string()).collect();
        let mut ts = ts_union_members(src, "DeathEvidence");
        rust.sort();
        ts.sort();
        assert_eq!(
            rust, ts,
            "DeathEvidence has drifted from deathTypes.ts — a value one end emits the other reads \
             as an unknown variant"
        );
    }

    // ── the session reaper ───────────────────────────────────────────────────────────────────
    //
    // Written as INVERTED PAIRS over one record wherever possible: each test changes exactly one
    // input, so it cannot pass by the record being dropped for one of the other three reasons.

    fn sessions(ids: &[&str]) -> std::collections::HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    /// THE ONE THAT MATTERS, asserted on the END-TO-END side effect rather than on the write.
    ///
    /// `reaped == 1` would be satisfied by a reaper that wrote any death at all. What the founder
    /// actually needs is for the agent to become DUE, and that runs through `derive`'s `alive` gate
    /// and `is_resurrectable` — so this asserts the reading, which is what `revival::due_at`
    /// consumes. Against today's code (no reaper) the record stays `Live`, `derive` reports
    /// `alive: true`, and the agent is invisible to recovery forever.
    #[test]
    #[cfg(unix)]
    fn a_live_record_whose_session_vanished_is_reaped_and_becomes_resurrectable() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "epoch-mine");
        // THE EPOCH MUST BE GENUINELY ALIVE or this test proves nothing. `derive` computes
        // `alive = Live && epoch_alive`, so against a fake epoch the `!alive` assertion below would
        // hold whether or not the reaper ever ran — and `effective_cause` would read `AppRestart`
        // from the dead-epoch path rather than from our write. Holding a real `flock` puts the
        // record in the exact state the bug lives in: alive epoch, vanished session.
        let _lock = hold_test_lock(&app_data, "epoch-mine");
        let at = NOW + REAP_GRACE_MS;

        // BEFORE: this is the founder's stuck state — dead process, and the ledger says alive.
        let before = read_at(&dir, &app_data, "a1", at).unwrap().unwrap();
        assert!(before.alive, "precondition: an unreaped record reads ALIVE — the bug");
        assert!(!before.resurrectable, "and is therefore invisible to recovery");

        let stats = reap_dead_sessions_at(&dir, "epoch-mine", &sessions(&[]), at).unwrap();
        assert_eq!(stats.reaped, 1, "a dead session under our own epoch must be sealed");

        let r = read_at(&dir, &app_data, "a1", at).unwrap().unwrap();
        assert!(!r.alive, "the whole point: it must stop reading ALIVE");
        assert_eq!(r.effective_cause, Some(DeathCause::ProcessGone));
        assert!(r.resurrectable, "a process that vanished unobserved must be recoverable");
        assert_eq!(r.not_before_ms, Some(at), "due immediately; the TS ladder paces it");
    }

    /// The paired positive. Same record, same clock, ONLY the session set differs — so the test
    /// above cannot be passing because of the grace window or the epoch gate.
    #[test]
    #[cfg(unix)]
    fn a_live_record_with_a_live_session_is_left_completely_alone() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "epoch-mine");
        let _lock = hold_test_lock(&app_data, "epoch-mine");
        let at = NOW + REAP_GRACE_MS;

        // IDENTICAL to the test above in every input except the session set.
        let stats = reap_dead_sessions_at(&dir, "epoch-mine", &sessions(&["a1"]), at).unwrap();
        assert_eq!(stats.reaped, 0);
        assert_eq!(stats.still_live, 1);
        assert_eq!(read_record_at(&dir, "a1").unwrap().unwrap().state, LifeState::Live);
        assert!(
            read_at(&dir, &app_data, "a1", at).unwrap().unwrap().alive,
            "a running agent must keep reading ALIVE — reaping one would be catastrophic"
        );
    }

    /// THE SPAWN RACE, which is the one that would have been catastrophic. `openDeathRecord` writes
    /// the record BEFORE `pty_spawn` registers the session, so a healthy just-created agent looks
    /// exactly like a dead one. Reaping it would seal every agent at birth and the resurrector
    /// would respawn it — an unbounded spawn/kill loop across the fleet.
    ///
    /// Inverted pair on the CLOCK alone: one millisecond under the window is immune, the window
    /// itself is fair game.
    #[test]
    fn a_freshly_opened_record_is_immune_until_the_grace_window_passes() {
        let (_td, dir, _app_data) = dirs();
        open(&dir, "a1", "epoch-mine");

        let early = reap_dead_sessions_at(&dir, "epoch-mine", &sessions(&[]), NOW + REAP_GRACE_MS - 1).unwrap();
        assert_eq!(early.reaped, 0, "the open→spawn gap must never be read as death");
        assert_eq!(early.too_young, 1);
        assert_eq!(read_record_at(&dir, "a1").unwrap().unwrap().state, LifeState::Live);

        let late = reap_dead_sessions_at(&dir, "epoch-mine", &sessions(&[]), NOW + REAP_GRACE_MS).unwrap();
        assert_eq!(late.reaped, 1, "and once it is past, the reaper must still fire");
    }

    /// THE CATASTROPHIC DIRECTION. `live_sessions` is THIS process's PTY map, so it is evidence
    /// about our agents only. A second running instance's records must be untouchable — judging
    /// them against our session map would report its entire healthy fleet as dead and hand all of
    /// it to the resurrector at once.
    #[test]
    fn a_record_belonging_to_another_epoch_is_never_reaped() {
        let (_td, dir, _app_data) = dirs();
        open(&dir, "theirs", "some-other-epoch");
        let stats =
            reap_dead_sessions_at(&dir, "epoch-mine", &sessions(&[]), NOW + 86_400_000).unwrap();
        assert_eq!(stats.reaped, 0, "another instance's agents are not ours to judge");
        assert_eq!(stats.not_ours, 1);
        assert_eq!(read_record_at(&dir, "theirs").unwrap().unwrap().state, LifeState::Live);
    }

    /// A verdict a WINDOW recorded with real evidence must survive. The reaper infers from an
    /// absence; an observed classification is strictly better information and must not be
    /// overwritten by a later tick.
    #[test]
    fn an_already_classified_death_is_never_rewritten() {
        let (_td, dir, _app_data) = dirs();
        open(&dir, "a1", "epoch-mine");
        close_at(
            &dir,
            "a1",
            death(DeathCause::BlockedOnHuman, DeathEvidence::BlockingTool),
            None,
        )
        .unwrap();

        let stats =
            reap_dead_sessions_at(&dir, "epoch-mine", &sessions(&[]), NOW + 86_400_000).unwrap();
        assert_eq!(stats.reaped, 0);
        let rec = read_record_at(&dir, "a1").unwrap().unwrap();
        assert_eq!(
            rec.death.unwrap().cause,
            DeathCause::BlockedOnHuman,
            "the reaper must never clobber a verdict a window observed — this agent is waiting on \
             a PERSON, and re-labelling it `process-gone` would make it resurrectable and respawn \
             an agent that asked someone a question"
        );
    }

    /// A DELIBERATELY STOPPED AGENT MUST NEVER BE REAPED OR RESURRECTED (roborev 61700/61714).
    ///
    /// The reaper infers death from "open record, absent session" — and a deliberate stop produces
    /// exactly that whenever no pane was mounted to observe it. The ordinary stop paths are all
    /// like that: `spinDownWorker`, `ProjectModal` killing a whole project's agents,
    /// `AgentSidebar` closing a row, `killAllOpenAgents` on window close.
    ///
    /// `pty_kill` marks the record `Dead`/`unknown` before killing (see
    /// `pty.rs::mark_stopped_before_kill`), and this asserts what that buys. `unknown` rather than
    /// `Retired` is load-bearing in BOTH directions, so both are asserted:
    ///   - not resurrectable, so the fleet cannot restart what the user stopped
    ///   - still PROTECTED from the worktree reaper, because "stop" is not "delete" and the
    ///     promotion cutover kills a local pty for an agent still alive in the cloud. `Retired`
    ///     maps to `Reapable` unconditionally, with none of `Dead`'s `PROTECTION_MAX` grace.
    ///
    /// Inverted pair against `a_live_record_whose_session_vanished_is_reaped_and_becomes_
    /// resurrectable`: identical inputs, and ONLY the recorded stop differs.
    #[test]
    #[cfg(unix)]
    fn a_deliberately_stopped_agent_is_neither_reaped_nor_reapable() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "epoch-mine");
        let _lock = hold_test_lock(&app_data, "epoch-mine");
        // THE MECHANISM ITSELF, not a copy of it (roborev 61770). This used to hand-build the same
        // `Death` and call `close_at` — so deleting the call from `pty_kill`, or changing its cause
        // to something resurrectable, left this green while every stop path became resurrectable.
        assert!(
            mark_stopped_at(&dir, "a1", NOW).unwrap(),
            "a Live record must actually be marked — an Ok(false) here would make everything below \
             assert about a record nothing touched"
        );

        let at = NOW + REAP_GRACE_MS;
        let stats = reap_dead_sessions_at(&dir, "epoch-mine", &sessions(&[]), at).unwrap();
        assert_eq!(stats.reaped, 0, "a stop the user asked for is not a death to recover from");

        let r = read_at(&dir, &app_data, "a1", at).unwrap().unwrap();
        assert!(
            !r.resurrectable,
            "must stay unresurrectable — respawning it would fight the user"
        );
        assert_eq!(
            r.reaper_verdict,
            ReaperVerdict::Protected,
            "and must stay PROTECTED: stop is not delete, and the promotion cutover kills a local \
             pty for an agent still alive in the cloud on that worktree"
        );
    }

    /// THE OTHER HALF: A STOP MUST NOT OVERWRITE A RICHER VERDICT SOMEONE ALREADY OBSERVED.
    ///
    /// This is the one behaviour that distinguishes `mark_stopped_at` from a bare `close_at`, and it
    /// had no test (roborev 61789) — so deleting the `Live`-only pre-check left the suite green
    /// while changing real behaviour. `close_at` refuses a downgrade ONLY for `CleanGoalMet`; every
    /// other recorded death is overwritten. So an agent already sealed on a session wall — whose
    /// `reset_at` is exactly what `arms_on_clock` uses to bring it back — that is then swept by
    /// `killAllOpenAgents` or `ProjectModal` would have its cause rewritten to `unknown`, which
    /// `is_resurrectable` refuses. It would silently never come back at reset.
    ///
    /// Paired with the test above: same call, and the ONLY difference is the record's prior state.
    #[test]
    #[cfg(unix)]
    fn a_stop_never_overwrites_a_death_a_window_already_observed() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "epoch-mine");
        let _lock = hold_test_lock(&app_data, "epoch-mine");
        let wall = Wall {
            message: "session limit reached, resets 4pm".into(),
            reset_at: Some(NOW + 60_000),
            reset_parsed: true,
            observed_at: NOW,
        };
        close_at(&dir, "a1", death(DeathCause::WallSession, DeathEvidence::QuotaBlock), Some(wall))
            .unwrap();

        assert!(
            !mark_stopped_at(&dir, "a1", NOW + 1).unwrap(),
            "the record is no longer Live, so there is nothing to mark — reporting true would mean \
             the stop had claimed a record it must not touch"
        );

        let rec = read_record_at(&dir, "a1").unwrap().unwrap();
        assert_eq!(
            rec.death.as_ref().unwrap().cause,
            DeathCause::WallSession,
            "the wall death must survive the stop — rewriting it to `unknown` makes an agent that \
             would have returned at reset never return at all"
        );
        assert_eq!(
            rec.wall.as_ref().unwrap().reset_at,
            Some(NOW + 60_000),
            "and its reset instant with it, since that is what arms the recovery"
        );
        let r = read_at(&dir, &app_data, "a1", NOW + 2).unwrap().unwrap();
        assert!(r.resurrectable, "a session wall is recoverable, and a stop must not have taken that away");
    }

    /// A wall observed before the process vanished rides along, exactly as `seal_stale_at` keeps
    /// one. Recovery needs BOTH facts: resurrect because it died, but not before the reset.
    #[test]
    fn reaping_preserves_a_wall_it_did_not_observe() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "epoch-mine");
        note_wall_at(
            &dir,
            "a1",
            Wall {
                message: SESSION_WALL.into(),
                reset_at: Some(NOW + 3_600_000),
                reset_parsed: true,
                observed_at: NOW,
            },
        )
        .unwrap();

        let at = NOW + REAP_GRACE_MS;
        assert_eq!(reap_dead_sessions_at(&dir, "epoch-mine", &sessions(&[]), at).unwrap().reaped, 1);

        let r = read_at(&dir, &app_data, "a1", at).unwrap().unwrap();
        assert_eq!(r.effective_cause, Some(DeathCause::ProcessGone));
        assert_eq!(
            r.not_before_ms,
            Some(NOW + 3_600_000),
            "the wall it rode in with must still gate the respawn"
        );
    }

    #[test]
    fn an_open_record_under_a_dead_epoch_seals_to_app_restart() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "epoch-that-died");
        let stats = seal_stale_at(&dir, &app_data, "epoch-now", NOW + 1_000).unwrap();
        assert_eq!(stats.sealed, 1);
        let r = read_at(&dir, &app_data, "a1", NOW + 1_000).unwrap().unwrap();
        assert_eq!(r.effective_cause, Some(DeathCause::AppRestart));
        assert!(r.resurrectable);
    }

    #[test]
    fn an_open_record_under_this_apps_own_epoch_is_never_sealed() {
        // The trivial half of the sleep case: our own epoch is alive by definition. This one passes
        // on the `rec.epoch == current_epoch` short-circuit and never consults the lock — which is
        // exactly why the test below exists.
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "epoch-current");
        let stats = seal_stale_at(&dir, &app_data, "epoch-current", NOW + 8 * 3_600_000).unwrap();
        assert_eq!(stats.sealed, 0);
        assert_eq!(stats.still_live, 1);
        assert_eq!(read_record_at(&dir, "a1").unwrap().unwrap().state, LifeState::Live);
    }

    #[test]
    fn a_foreign_epoch_that_still_holds_its_lock_is_never_sealed() {
        // THE REAL SLEEP CASE, and it was previously untested (roborev 60090): the prior test
        // short-circuited on `rec.epoch == current_epoch`, so `epoch_is_alive` was never called with
        // a true result anywhere in the suite. Deleting the flock entirely left it green.
        //
        // Here a DIFFERENT instance is genuinely running — its lock file exists and is held — so a
        // second instance sweeping at launch must leave its records alone. Getting this wrong
        // declares another window's whole live fleet dead and respawns it underneath it.
        let (_td, dir, app_data) = dirs();
        let foreign = "epoch-of-a-live-sibling";
        let _held = hold_test_lock(&app_data, foreign);

        open(&dir, "a1", foreign);
        let stats = seal_stale_at(&dir, &app_data, "epoch-mine", NOW + 8 * 3_600_000).unwrap();

        assert_eq!(stats.sealed, 0, "a live sibling's record must not be sealed");
        assert_eq!(stats.still_live, 1);

        let r = read_at(&dir, &app_data, "a1", NOW).unwrap().unwrap();
        assert!(r.alive, "a record under a live foreign epoch reads alive");
        assert_eq!(r.effective_cause, None);
        assert!(!r.resurrectable);
    }

    #[test]
    fn a_live_record_under_this_apps_epoch_is_alive_even_with_no_lock_file() {
        // The catastrophic case (roborev 60090). `epoch_is_alive` answers from a lock only the
        // babysit LEASE path creates, so a healthy instance that has not taken a lease has no lock
        // file — and every Live record derived alive:false / AppRestart / resurrectable:true. The
        // entire RUNNING fleet reading as dead and respawnable.
        let (_td, dir, app_data) = dirs();
        let mine = crate::babysit_lease::process_epoch();
        open(&dir, "a1", mine);

        let r = read_at(&dir, &app_data, "a1", NOW).unwrap().unwrap();
        assert!(r.alive);
        assert_eq!(r.effective_cause, None);
        assert!(!r.resurrectable, "a running agent must never be a respawn candidate");
        assert_eq!(r.reaper_verdict, ReaperVerdict::Protected);
    }

    #[test]
    fn sealing_an_app_restart_preserves_a_wall_it_did_not_observe() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "epoch-that-died");
        note_wall_at(
            &dir,
            "a1",
            Wall {
                message: SESSION_WALL.into(),
                reset_at: Some(NOW + 3_600_000),
                reset_parsed: true,
                observed_at: NOW,
            },
        )
        .unwrap();

        seal_stale_at(&dir, &app_data, "epoch-now", NOW + 60_000).unwrap();

        let r = read_at(&dir, &app_data, "a1", NOW + 60_000).unwrap().unwrap();
        assert_eq!(r.effective_cause, Some(DeathCause::AppRestart));
        // Both facts survive, and the wall still governs WHEN it may come back.
        assert_eq!(r.record.wall.as_ref().unwrap().message, SESSION_WALL);
        assert_eq!(r.not_before_ms, Some(NOW + 3_600_000));
    }

    #[test]
    fn a_clean_goal_met_record_is_never_resurrectable_and_is_immediately_reapable() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        let mut d = death(DeathCause::CleanGoalMet, DeathEvidence::GoalMetMarked);
        d.goal_met_at = Some(NOW - 1_000);
        close_at(&dir, "a1", d, None).unwrap();

        let r = read_at(&dir, &app_data, "a1", NOW).unwrap().unwrap();
        assert!(!r.resurrectable);
        assert_eq!(r.not_before_ms, None);
        assert_eq!(r.reaper_verdict, ReaperVerdict::Reapable);
    }

    #[test]
    fn a_close_to_clean_goal_met_without_goal_met_at_is_refused() {
        let (_td, dir, _app) = dirs();
        open(&dir, "a1", "e");
        let err = close_at(
            &dir,
            "a1",
            death(DeathCause::CleanGoalMet, DeathEvidence::GoalMetMarked),
            None,
        )
        .unwrap_err();
        assert!(matches!(err, LifeError::Invalid(_)));
    }

    #[test]
    fn a_close_may_not_downgrade_a_clean_goal_met_record() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        let mut d = death(DeathCause::CleanGoalMet, DeathEvidence::GoalMetMarked);
        d.goal_met_at = Some(NOW);
        close_at(&dir, "a1", d, None).unwrap();

        let err = close_at(&dir, "a1", death(DeathCause::Unknown, DeathEvidence::PtyExit), None)
            .unwrap_err();
        assert_eq!(err, LifeError::Downgrade);

        // …and it is STILL unresurrectable afterwards, which is the property that matters.
        let r = read_at(&dir, &app_data, "a1", NOW).unwrap().unwrap();
        assert!(!r.resurrectable);
    }

    #[test]
    fn a_cause_with_no_evidence_is_refused() {
        let (_td, dir, _app) = dirs();
        open(&dir, "a1", "e");
        let err = close_at(
            &dir,
            "a1",
            death(DeathCause::TransportTransient, DeathEvidence::None),
            None,
        )
        .unwrap_err();
        assert!(matches!(err, LifeError::Invalid(_)));
    }

    #[test]
    fn wall_spend_never_carries_a_reset_at() {
        let (_td, dir, _app) = dirs();
        open(&dir, "a1", "e");
        let err = close_at(
            &dir,
            "a1",
            death(DeathCause::WallSpend, DeathEvidence::QuotaBlock),
            Some(Wall {
                message: SPEND_WALL.into(),
                reset_at: Some(NOW + 5 * 3_600_000),
                reset_parsed: false,
                observed_at: NOW,
            }),
        )
        .unwrap_err();
        assert!(matches!(err, LifeError::Invalid(_)));
    }

    #[test]
    fn wall_spend_is_resurrectable_but_never_clock_armed() {
        // The founder's correction, pinned: a spend cap is recovered by PROBING. Gating it on a
        // clock that never ticks would park the fleet forever.
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(
            &dir,
            "a1",
            death(DeathCause::WallSpend, DeathEvidence::QuotaBlock),
            Some(Wall {
                message: SPEND_WALL.into(),
                reset_at: None,
                reset_parsed: false,
                observed_at: NOW,
            }),
        )
        .unwrap();
        let r = read_at(&dir, &app_data, "a1", NOW).unwrap().unwrap();
        assert!(r.resurrectable);
        assert_eq!(r.not_before_ms, Some(NOW));
        assert!(!arms_on_clock(DeathCause::WallSpend));
    }

    #[test]
    fn wall_session_not_before_equals_the_parsed_reset() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(
            &dir,
            "a1",
            death(DeathCause::WallSession, DeathEvidence::QuotaBlock),
            Some(Wall {
                message: SESSION_WALL.into(),
                reset_at: Some(NOW + 3_600_000),
                reset_parsed: true,
                observed_at: NOW,
            }),
        )
        .unwrap();
        let r = read_at(&dir, &app_data, "a1", NOW).unwrap().unwrap();
        assert_eq!(r.not_before_ms, Some(NOW + 3_600_000));
    }

    #[test]
    fn an_absent_record_reads_unknown_and_the_reaper_verdict_is_unknown_not_reapable() {
        let (_td, dir, app_data) = dirs();
        assert!(read_at(&dir, &app_data, "nope", NOW).unwrap().is_none());
        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "nope", NOW),
            ReaperVerdict::Unknown
        );
    }

    #[test]
    fn a_corrupt_file_reads_unknown_and_never_free() {
        let (_td, dir, app_data) = dirs();
        std::fs::write(dir.join("a1.json"), b"{ not json").unwrap();
        assert!(read_record_at(&dir, "a1").is_err());
        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "a1", NOW),
            ReaperVerdict::Unknown
        );
    }

    #[test]
    fn a_live_record_is_protected_even_before_the_sealer_runs() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "epoch-that-died");
        // Unsealed, epoch dead — a reaper racing the sealer must lose.
        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "a1", NOW),
            ReaperVerdict::Protected
        );
    }

    #[test]
    fn a_claimed_record_is_protected_and_a_dead_claimants_claim_is_taken_over() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::AppRestart, DeathEvidence::EpochDead), None).unwrap();

        claim_at(&dir, &app_data, "a1", "resurrector", "epoch-dead-claimant", NOW).unwrap();
        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "a1", NOW),
            ReaperVerdict::Protected
        );
        release_at(&dir, &app_data, "a1", "epoch-mine", true, NOW).unwrap();

        // The prior claimant's epoch is not alive (no lock file), so a new claimant takes over —
        // and inherits the attempts rather than getting a fresh budget.
        let rec = claim_at(&dir, &app_data, "a1", "resurrector", "epoch-new", NOW + 1_000).unwrap();
        assert_eq!(rec.claim.as_ref().unwrap().attempts, 1);
        assert_eq!(rec.attempts_at, vec![NOW]);
    }

    #[test]
    fn protection_runs_from_the_DEATH_not_from_the_open() {
        // roborev 60090: measuring from `opened_at` made a long-lived agent Reapable the instant it
        // died — its worktree destroyed while it was still resurrectable.
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        let died = NOW + PROTECTION_MAX.as_millis() as i64 + 60_000; // ran for over a week, then died
        let mut d = death(DeathCause::AppRestart, DeathEvidence::EpochDead);
        d.at = died;
        close_at(&dir, "a1", d, None).unwrap();

        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "a1", died + 60_000),
            ReaperVerdict::Protected,
            "still resurrectable, so the worktree must survive"
        );
        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "a1", died + PROTECTION_MAX.as_millis() as i64 + 1),
            ReaperVerdict::Reapable
        );
    }

    #[test]
    fn a_claim_whose_owner_died_does_not_pin_the_worktree_forever() {
        // roborev 60090: Claimed had no expiry, so a claimant dying between claim and release — a
        // case `claim_at` is explicitly written to handle — pinned the worktree permanently.
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::AppRestart, DeathEvidence::EpochDead), None).unwrap();
        claim_at(&dir, &app_data, "a1", "resurrector", "epoch-gone", NOW).unwrap();

        assert_eq!(reaper_verdict_at(&dir, &app_data, "a1", NOW), ReaperVerdict::Protected);
        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "a1", NOW + PROTECTION_MAX.as_millis() as i64 + 1),
            ReaperVerdict::Reapable
        );
    }

    #[test]
    fn a_caller_passing_a_spend_wall_with_a_reset_is_still_rejected_outright() {
        // The shape rule is enforced on CALLER INPUT and nowhere else: a caller handing in a spend
        // cap that carries a reset instant is a caller bug and is refused here, while a wall already
        // on the record is left untouched (roborev 60090, narrowed by 60103 and 60123).
        let (_td, dir, _app) = dirs();
        open(&dir, "a1", "e");
        let err = close_at(
            &dir,
            "a1",
            death(DeathCause::WallSpend, DeathEvidence::QuotaBlock),
            Some(Wall {
                message: SPEND_WALL.into(),
                reset_at: Some(NOW + 5 * 3_600_000),
                reset_parsed: false,
                observed_at: NOW,
            }),
        )
        .unwrap_err();
        assert!(matches!(err, LifeError::Invalid(_)));
    }

    #[test]
    fn a_spend_cap_death_is_recorded_without_disturbing_a_stale_session_wall() {
        // roborev 60103/60123. Two things at once: the death is ALWAYS written (refusing the close meant
        // never written, the record stayed Live under the current epoch, and `derive` then reported
        // a DEAD agent as alive, not resurrectable and Protected — never sealed, worktree pinned.
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", crate::babysit_lease::process_epoch());
        note_wall_at(
            &dir,
            "a1",
            Wall {
                message: SESSION_WALL.into(),
                reset_at: Some(NOW + 3_600_000),
                reset_parsed: true,
                observed_at: NOW,
            },
        )
        .unwrap();

        let rec = close_at(
            &dir,
            "a1",
            death(DeathCause::WallSpend, DeathEvidence::QuotaBlock),
            None,
        )
        .expect("the death must be recorded, not refused");

        assert_eq!(rec.state, LifeState::Dead);
        assert_eq!(rec.death.as_ref().unwrap().cause, DeathCause::WallSpend);
        // BOTH facts survive. The wall is an independent observation this close knew nothing about,
        // and neither rewriting nor deleting it was necessary: `arms_on_clock(WallSpend)` is false,
        // so nothing reads `reset_at` here. Keeping it is what lets a later reader see that a spend
        // classification landed on top of a parsed session wall.
        let wall = rec.wall.as_ref().expect("the observed wall is preserved");
        assert_eq!(wall.message, SESSION_WALL, "verbatim, neither relabelled nor erased");
        assert_eq!(wall.reset_at, Some(NOW + 3_600_000));
        assert!(wall.reset_parsed, "the discriminator is not forged");

        // …and it is genuinely resurrectable, by probing rather than on a clock.
        let r = read_at(&dir, &app_data, "a1", NOW).unwrap().unwrap();
        assert!(r.resurrectable);
        assert_eq!(r.not_before_ms, Some(NOW));
    }

    #[test]
    fn an_observed_spend_wall_survives_a_close_over_a_stale_session_wall() {
        // roborev 60123: the only assertion on this path checked `resurrectable` and `not_before_ms`,
        // both of which hold identically with `wall: None` — so deleting the caller's own observed
        // spend wall would have left the suite green, losing the verbatim message that cohort
        // correlation keys on by exact equality.
        let (_td, dir, _app) = dirs();
        open(&dir, "a1", "e");
        note_wall_at(
            &dir,
            "a1",
            Wall {
                message: SESSION_WALL.into(),
                reset_at: Some(NOW + 3_600_000),
                reset_parsed: true,
                observed_at: NOW,
            },
        )
        .unwrap();

        let rec = close_at(
            &dir,
            "a1",
            death(DeathCause::WallSpend, DeathEvidence::QuotaBlock),
            Some(Wall {
                message: SPEND_WALL.into(),
                reset_at: None,
                reset_parsed: false,
                observed_at: NOW + 1_000,
            }),
        )
        .expect("a valid spend wall is accepted");

        let wall = rec.wall.as_ref().expect("the caller's own observation must survive");
        assert_eq!(wall.message, SPEND_WALL, "verbatim — cohort correlation keys on exact bytes");
        assert_eq!(wall.reset_at, None);
    }

    #[test]
    fn an_attempt_older_than_the_window_neither_counts_nor_persists() {
        // roborev 60103: an unbounded lifetime list made the budget permanently spent for exactly
        // the agents that have needed it most, and grew a file rewritten on every mutation.
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::AppRestart, DeathEvidence::EpochDead), None).unwrap();

        let stale = NOW - ATTEMPT_WINDOW.as_millis() as i64 - 60_000;
        let mut rec = read_record_at(&dir, "a1").unwrap().unwrap();
        rec.attempts_at = vec![stale, stale, stale];
        write_record_at(&dir, &rec).unwrap();

        let claimed = claim_at(&dir, &app_data, "a1", "resurrector", "epoch-mine", NOW).unwrap();
        assert_eq!(claimed.claim.as_ref().unwrap().attempts, 0, "aged-out attempts do not count");
        assert!(claimed.attempts_at.is_empty(), "and they do not persist");
    }

    #[test]
    fn a_live_epoch_cannot_have_its_claim_released_by_anyone_else() {
        // roborev 60103: release became destructive, so without an ownership check an instance that
        // `claim_at` had correctly refused could clear the holder's claim, take it, and respawn an
        // agent the holder was respawning — two processes, one worktree.
        let (_td, dir, app_data) = dirs();
        let holder = "epoch-holding-the-claim";
        let _held = hold_test_lock(&app_data, holder);
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::AppRestart, DeathEvidence::EpochDead), None).unwrap();
        claim_at(&dir, &app_data, "a1", "resurrector", holder, NOW).unwrap();

        let err = release_at(&dir, &app_data, "a1", "epoch-intruder", true, NOW + 1).unwrap_err();
        assert_eq!(err, LifeError::HeldLive);

        // The holder's claim is intact, so exclusivity was not handed away.
        let rec = read_record_at(&dir, "a1").unwrap().unwrap();
        assert_eq!(rec.claim.as_ref().unwrap().epoch, holder);
    }

    #[test]
    fn a_claim_cannot_re_arm_protection_past_the_deadline_the_death_set() {
        // roborev 60103: measuring the Claimed expiry from `claim.at` let a record already Reapable
        // become Protected for another full window the moment a resurrector touched it — and
        // `claim_at` rewrites `claim.at` on every takeover, so it could be extended indefinitely.
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::AppRestart, DeathEvidence::EpochDead), None).unwrap();

        let long_after = NOW + PROTECTION_MAX.as_millis() as i64 + 60_000;
        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "a1", long_after),
            ReaperVerdict::Reapable
        );

        claim_at(&dir, &app_data, "a1", "resurrector", "epoch-mine", long_after).unwrap();
        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "a1", long_after),
            ReaperVerdict::Reapable,
            "a late claim must not resurrect the protection"
        );
    }

    #[test]
    fn a_corrupt_record_is_distinguishable_from_a_transient_read_failure() {
        // roborev 60103: collapsing both into Io meant a momentary EMFILE failed the agent SPAWN
        // path exactly as if the record were corrupt, with no way for a caller to tell them apart.
        let (_td, dir, _app) = dirs();
        std::fs::write(dir.join("a1.json"), b"{ not json").unwrap();
        assert!(matches!(read_record_at(&dir, "a1"), Err(LifeError::Corrupt(_))));
    }

    #[test]
    fn a_corrupt_record_never_reopens_as_a_blank_slate() {
        // roborev 60090: collapsing Err into None made a reopen behave as a first open — attempts
        // reset, prior discarded, the clean-goal-met latch cleared — under exactly the conditions
        // (thrash, descriptor pressure) the cap exists for.
        let (_td, dir, _app) = dirs();
        std::fs::write(dir.join("a1.json"), b"{ not json").unwrap();
        assert!(open_at(&dir, "a1", "proj", "/wt", "e", NOW).is_err());
    }

    #[test]
    fn releasing_a_respawned_agent_does_not_stamp_it_dead() {
        // roborev 60090: the natural protocol is claim -> respawn (open_at sets Live) -> release.
        // An unconditional demotion marked a RUNNING agent Dead with no death, which derive then
        // reported as not alive and the sealer would never revisit.
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::AppRestart, DeathEvidence::EpochDead), None).unwrap();
        claim_at(&dir, &app_data, "a1", "resurrector", "epoch-mine", NOW).unwrap();

        open(&dir, "a1", crate::babysit_lease::process_epoch()); // the respawn itself
        let rec = release_at(&dir, &app_data, "a1", "epoch-mine", true, NOW + 1_000).unwrap();

        assert_eq!(rec.state, LifeState::Live, "a respawned agent is not dead");
        assert!(rec.claim.is_none(), "release must actually release");
        assert_eq!(rec.attempts_at, vec![NOW + 1_000]);
    }

    #[test]
    fn a_released_claim_can_be_taken_by_another_epoch() {
        // The claim used to be left in place, so it kept answering HeldLive to every other epoch
        // with no path to relinquish it.
        let (_td, dir, app_data) = dirs();
        let mine = crate::babysit_lease::process_epoch();
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::AppRestart, DeathEvidence::EpochDead), None).unwrap();
        claim_at(&dir, &app_data, "a1", "resurrector", mine, NOW).unwrap();
        // The HOLDER releases its own claim — which is now the only way it can be released.
        release_at(&dir, &app_data, "a1", mine, true, NOW).unwrap();

        let again = claim_at(&dir, &app_data, "a1", "resurrector", "epoch-other", NOW + 1).unwrap();
        // …and the new claimant inherits the DURABLE attempt count rather than a fresh budget.
        assert_eq!(again.claim.as_ref().unwrap().attempts, 1);
    }

    #[test]
    fn a_live_claim_is_refused_to_a_different_epoch() {
        let (_td, dir, app_data) = dirs();
        let foreign = "epoch-holding-the-claim";
        let _held = hold_test_lock(&app_data, foreign);
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::AppRestart, DeathEvidence::EpochDead), None).unwrap();
        claim_at(&dir, &app_data, "a1", "resurrector", foreign, NOW).unwrap();

        let err = claim_at(&dir, &app_data, "a1", "resurrector", "epoch-mine", NOW + 1).unwrap_err();
        assert_eq!(err, LifeError::HeldLive);
    }

    #[test]
    fn attempts_survive_a_reopen_so_the_daily_cap_cannot_be_laundered() {
        // The cap exists to bound respawns, so zeroing its counter ON respawn would make it vacuous
        // exactly when it matters.
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::AppRestart, DeathEvidence::EpochDead), None).unwrap();
        release_at(&dir, &app_data, "a1", "epoch-mine", true, NOW).unwrap();

        let reopened = open_at(&dir, "a1", "proj", "/wt", "e2", NOW + 5_000).unwrap();
        assert_eq!(reopened.attempts_at, vec![NOW]);
        assert_eq!(reopened.state, LifeState::Live);
        assert_eq!(reopened.prior.len(), 1);
        assert_eq!(reopened.prior[0].cause, DeathCause::AppRestart);
    }

    #[test]
    fn the_death_message_round_trips_byte_for_byte() {
        // Cohort correlation keys a map on exact equality. A trim or a re-case here silently
        // prevents "N agents died of one cause" from ever grouping.
        let (_td, dir, _app) = dirs();
        let raw = "  You've hit your session limit · resets 10:30pm (America/Los_Angeles)  \t";
        open(&dir, "a1", "e");
        let mut d = death(DeathCause::WallSession, DeathEvidence::QuotaBlock);
        d.message = Some(raw.to_string());
        close_at(
            &dir,
            "a1",
            d,
            Some(Wall {
                message: raw.into(),
                reset_at: Some(NOW + 60_000),
                reset_parsed: true,
                observed_at: NOW,
            }),
        )
        .unwrap();
        let rec = read_record_at(&dir, "a1").unwrap().unwrap();
        assert_eq!(rec.death.unwrap().message.unwrap(), raw);
        assert_eq!(rec.wall.unwrap().message, raw);
    }

    #[test]
    fn protection_expires_so_a_spend_cap_cannot_pin_a_worktree_forever() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(
            &dir,
            "a1",
            death(DeathCause::WallSpend, DeathEvidence::QuotaBlock),
            Some(Wall {
                message: SPEND_WALL.into(),
                reset_at: None,
                reset_parsed: false,
                observed_at: NOW,
            }),
        )
        .unwrap();
        assert_eq!(
            reaper_verdict_at(&dir, &app_data, "a1", NOW + 60_000),
            ReaperVerdict::Protected
        );
        let past = NOW + PROTECTION_MAX.as_millis() as i64 + 1;
        assert_eq!(reaper_verdict_at(&dir, &app_data, "a1", past), ReaperVerdict::Reapable);
    }

    #[test]
    fn an_unclassified_death_is_neither_resurrected_nor_destroyed() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        close_at(&dir, "a1", death(DeathCause::Unknown, DeathEvidence::PtyExit), None).unwrap();
        let r = read_at(&dir, &app_data, "a1", NOW).unwrap().unwrap();
        assert!(!r.resurrectable);
        assert_eq!(r.reaper_verdict, ReaperVerdict::Protected);
    }

    #[test]
    fn the_store_survives_a_crash_mid_write() {
        // A stray temp file must never be mistaken for the record, and the record must still parse.
        let (_td, dir, _app) = dirs();
        open(&dir, "a1", "e");
        std::fs::write(dir.join(".a1.999.tmp"), b"{ half-written").unwrap();
        let rec = read_record_at(&dir, "a1").unwrap().unwrap();
        assert_eq!(rec.state, LifeState::Live);
    }

    #[test]
    fn list_reports_every_record_and_skips_stray_files() {
        let (_td, dir, app_data) = dirs();
        open(&dir, "a1", "e");
        open(&dir, "a2", "e");
        std::fs::write(dir.join("notes.txt"), b"ignore me").unwrap();
        let all = list_at(&dir, &app_data, NOW).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.contains_key("a1") && all.contains_key("a2"));
    }

    #[test]
    fn a_bad_agent_id_is_refused_rather_than_sanitized() {
        let (_td, dir, _app) = dirs();
        assert!(matches!(
            open_at(&dir, "../escape", "p", "/wt", "e", NOW),
            Err(LifeError::BadAgentId)
        ));
    }

    // ── the command layer's one structural guard ──────────────────────────────────────────────

    /// The source text of one fn's body, bounded by its OWN braces.
    ///
    /// Bounding a "scoped" source scan by the next attribute is not a scope (roborev 61789): the
    /// slice then runs to whatever happens to follow, so it is non-vacuous by luck rather than by
    /// construction. Callers should still assert something the slice must NOT contain — brace
    /// counting is blind to braces inside string literals, and this is a test helper, not a parser.
    fn fn_body(src: &str, signature: &str) -> String {
        let after = src
            .split(signature)
            .nth(1)
            .unwrap_or_else(|| panic!("`{signature}` not found — renamed, or no longer async"));
        let start = after.find('{').expect("that fn has no body");
        let mut depth = 0usize;
        for (i, ch) in after[start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return after[start..=start + i].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces after `{signature}`");
    }

    /// Scan Rust source for `#[tauri::command]` fns, returning `(total_commands, sync_signatures)`.
    ///
    /// Deliberately the SAME shape as `inbox.rs`'s scanner, including the anti-vacuity test below —
    /// the two files must not grow different definitions of "is this command async".
    fn tauri_commands_in(src: &str) -> (usize, Vec<String>) {
        let lines: Vec<&str> = src.lines().collect();
        let mut total = 0usize;
        let mut sync = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            // `starts_with`, not equality: `#[tauri::command(async)]` and
            // `#[tauri::command(rename_all = "snake_case")]` are commands too, and an exact-match
            // matcher would skip them and pass having matched nothing.
            if !line.trim().starts_with("#[tauri::command") {
                continue;
            }
            let Some(sig) = lines[i..].iter().find(|l| l.contains("fn ")) else {
                continue;
            };
            total += 1;
            if !sig.contains("async fn") {
                sync.push(sig.trim().to_string());
            }
        }
        (total, sync)
    }

    /// EVERY `#[tauri::command]` in this module must be `pub async fn`, because a sync Tauri command
    /// body runs on the MAIN thread and these commands do file I/O over the whole ledger.
    /// `agent_life_list` reads and derives EVERY record — once per resurrection sweep, forever — and
    /// `services/fleetWatch` already showed what recurring blocking disk I/O in front of the AppKit
    /// event loop costs: the concierge control bridge times out (`bridge request timeout:
    /// concierge_tool`) and the app cannot see or talk to any agent.
    ///
    /// Asserted against this file's own SOURCE because there is no runtime handle to check: the
    /// defect is a missing `async` keyword, invisible to every behavioural test.
    #[test]
    fn every_tauri_command_here_runs_off_the_main_thread() {
        let (total, sync_cmds) = tauri_commands_in(include_str!("agent_life.rs"));
        // POSITIVE assertion first, so "the matcher found nothing" FAILS instead of passing
        // silently — the "assertion already true before the change" shape this repo calls its #1
        // finding. Renaming the attribute or moving the commands to a submodule must break this.
        assert!(
            total >= 8,
            "expected at least the 8 agent-life commands (open/close/note_wall/read/list/claim/\
             release/retire), found {total} — the scanner matched nothing, so this guard is not \
             guarding anything"
        );
        assert!(
            sync_cmds.is_empty(),
            "these agent-life commands are synchronous, so they run on the main thread and can \
             starve the concierge control bridge. Make them `pub async fn` + \
             `tauri::async_runtime::spawn_blocking`: {sync_cmds:#?}"
        );
    }

    /// THE RULE FOLLOWS THE LEDGER, NOT THE FILE (roborev 61770).
    ///
    /// The guard above scans `agent_life.rs`, so it could not see a command in ANOTHER module that
    /// writes this ledger — and one arrived: `pty_kill` calls `mark_stopped_at`, whose `close_at`
    /// writes a temp file, `fsync`s it and renames. Sync, that is a read + an fsync on the main
    /// thread PER AGENT for `windowClose.stopOpenProjectAgents` and `ProjectModal`'s
    /// `Promise.all(agents.map(killPty))`, in front of the AppKit event loop the concierge bridge
    /// needs. A guard that stops at its own file would have watched that land.
    ///
    /// Scoped to the commands that touch the ledger rather than every command in `pty.rs`: the sync
    /// ones next door (`pty_ack`, `pty_resize`, `pty_live_sessions`) are a mutex and a `Vec` clone
    /// with no I/O, and deliberately stay sync.
    #[test]
    fn pty_commands_that_write_the_agent_life_ledger_run_off_the_main_thread() {
        let src = include_str!("pty.rs");
        // SCOPED TO `pty_kill`'S OWN BODY, not to the file. A file-wide `contains` passes on the
        // mutation that matters: deleting the call from `pty_kill` leaves the helper defined and
        // still mentioning `mark_stopped_at`, so the whole-file scan stays green while every stop
        // path silently becomes resurrectable again. Measured — the first version of this guard did
        // exactly that.
        let body = fn_body(src, "pub async fn pty_kill");
        // The slice is bounded by pty_kill's own BRACES, not by the next `#[tauri::command]`
        // attribute (roborev 61789). An attribute terminator is not a scope: moving the helper's
        // definition below its caller — an ordinary "helper after caller" refactor — would pull
        // `fn mark_stopped_before_kill`'s own body into the slice and make the assertion below
        // satisfiable without `pty_kill` calling anything. This is the self-check for that.
        assert!(
            !body.contains("fn mark_stopped_before_kill"),
            "the slice swallowed the helper's own DEFINITION, so the call-site assertion below \
             cannot fail — re-scope it before trusting this guard"
        );
        let call = body.find("mark_stopped_before_kill(").unwrap_or_else(|| {
            panic!(
                "`pty_kill` no longer records the deliberate stop, so the session reaper will seal \
                 these agents `process-gone` and resurrect what the user just stopped (roborev 61700)"
            )
        });
        // PRESENCE IS NOT THE PROPERTY — POSITION IS (roborev 61789). Dropping the `.await`, or
        // moving the mark below the session removal, leaves every test green while the record is
        // still read `Live` after the session has vanished: exactly the state
        // `reap_dead_sessions_at` seals as `process-gone`.
        let kill = body.find("sessions.lock()").expect("pty_kill no longer removes the session");
        assert!(
            call < kill,
            "the deliberate-stop mark must run BEFORE the session is removed, or the reaper can \
             land in the window where the session is gone and the record still reads Live"
        );
        assert!(
            body[call..kill].contains(".await"),
            "the mark is dispatched but not awaited before the kill, so the ordering above is not \
             actually enforced at runtime"
        );
        let (total, sync_cmds) = tauri_commands_in(src);
        assert!(total >= 5, "the scanner matched {total} pty commands, so it is not guarding anything");
        let offenders: Vec<&String> = sync_cmds.iter().filter(|s| s.contains("pty_kill")).collect();
        assert!(
            offenders.is_empty(),
            "`pty_kill` writes the agent-life ledger (fsync + rename), so a synchronous body runs \
             that on the main thread — once per agent on window close. Make it `pub async fn` + \
             `tauri::async_runtime::spawn_blocking`: {offenders:#?}"
        );
    }

    /// The guard is only meaningful if its scanner can actually SEE a sync command. Feeds the REAL
    /// scanner the shape it must reject, so a green guard means "all async" rather than "matched
    /// nothing".
    #[test]
    fn the_async_guard_would_notice_a_sync_command() {
        let sample =
            "#[tauri::command]\npub fn agent_life_regressed(app: AppHandle) -> Result<(), String> {\n";
        let (total, sync) = tauri_commands_in(sample);
        assert_eq!(total, 1, "scanner must see the command");
        assert_eq!(sync.len(), 1, "scanner must flag it as sync: {sync:?}");

        let ok = "#[tauri::command(rename_all = \"snake_case\")]\npub async fn fine(app: AppHandle) {\n";
        let (total_ok, sync_ok) = tauri_commands_in(ok);
        assert_eq!(total_ok, 1, "attribute with args must still be counted");
        assert!(sync_ok.is_empty(), "async command must not be flagged: {sync_ok:?}");
    }

    /// The ledger lives BESIDE `hook-events/`, never inside a worktree — the header's reason is that
    /// a write under `.sparkle/` would bump `fleet`'s `newest_write_ms` and make a dead agent look
    /// like it was writing forever. Pinned so a later "tidy up" cannot relocate it silently.
    #[test]
    fn the_ledger_sits_in_app_data_beside_hook_events() {
        let base = Path::new("/tmp/-data");
        assert_eq!(life_dir(base), base.join("agent-life"));
        assert_eq!(
            life_dir(base).parent(),
            base.join("hook-events").parent(),
            "the ledger must be a sibling of hook-events, not a child of any worktree"
        );
    }
}

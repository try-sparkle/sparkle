//! THE CLOCK THAT SURVIVES THE WALL IT IS WAITING FOR (bead sparkle-ggnh5).
//!
//! ── THE FAILURE THIS CLOSES ───────────────────────────────────────────────────────────────────
//! `agent_life.rs` records WHY every agent died, durably, in a place a dying app cannot erase. But a
//! record nobody reads brings nothing back. This is the reader: a plain OS thread that wakes once a
//! second, asks the ledger which dead agents are now DUE, and publishes that list.
//!
//! ── NO MODEL CALL ON ANY PATH. NOT ONE ────────────────────────────────────────────────────────
//! This is the whole reason the module is in Rust rather than in the WebView, and it is the same
//! argument `nudger.rs` makes for itself: when the wall is fleet-wide, EVERY LLM in the app is gated
//! behind the same account limit. The concierge is a `claude -p` child, `turnFollowup` runs a Haiku
//! judge, `claude_oneshot` is a model call — each one is dead at precisely the moment recovery is
//! needed. A recovery path that consults any of them has no recovery path.
//!
//! So this module is `read_dir`, `serde_json`, and INTEGER COMPARISONS. Nothing else.
//!
//! ── AND IT DOES NOT PARSE TIME ────────────────────────────────────────────────────────────────
//! `now_ms >= not_before_ms` is the entire arithmetic. `src-tauri` carries no date crate and this
//! module does not add one: the TS side already resolved `resets 10:30pm (America/Los_Angeles)` to
//! an epoch integer at OBSERVATION time (`quotaBlock.parseResetInstant`), where the timezone, the
//! locale and the ambiguity all still exist. Re-parsing it here would be a second matcher for a
//! string that has already been read once — the exact drift `deathRecord.ts` refuses to introduce —
//! and it would be re-derived hours later, in a different DST offset, from a message whose only
//! remaining context is the bytes.
//!
//! `deathTypes::arms_on_clock` is what makes that affordable: only `WallSession` names an instant at
//! all. Everything else resurrectable either retries on a ladder or PROBES, and neither needs date
//! arithmetic.
//!
//! ── WHAT IT DELIBERATELY DOES NOT DECIDE ──────────────────────────────────────────────────────
//! Due is not the same as admitted, and this module only answers the first. The ladder, the rolling
//! daily cap, the cohort canary and the release drain all live in the pure TS engine
//! (`engine/resurrection.ts`, `engine/resurrectionCohort.ts`) and are applied by
//! `services/resurrectionRunner.ts`. Duplicating any of them here would be a second copy of a
//! policy that is already tested — this thread's job is to make sure the QUESTION keeps being asked
//! on a clock the WebView cannot stall.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::agent_life::{self, AgentLifeReading, DeathCause, LifeState};

/// How often the thread wakes. Equal to `nudger.rs`'s and `watchdog.rs`'s TICK, and for the same
/// reason they give: a fixed cheap tick is easier to reason about than a forest of per-agent timers.
/// The shortest thing anyone waits on here is the 60s first rung of the respawn ladder, so a second
/// of resolution is ample and the cost is a `read_dir` over a directory with one small file per
/// agent.
const TICK: Duration = Duration::from_secs(1);

/// How often the LEDGER is actually re-read. The thread still wakes on `TICK`; this is how many of
/// those wakes do any work.
///
/// The two are separated because they answer to different costs (roborev 60222). A tick is free; a
/// scan is not — per record it is a `read_to_string`, a `serde_json` parse, and `epoch_is_alive`'s
/// `File::open` plus two `flock` syscalls, none of it memoized, and nothing prunes
/// `<app_data>/agent-life` today, so the file count grows with every agent this machine has ever
/// run. At 1 Hz that is a steady scan of an unbounded directory for a question whose fastest
/// consumer is a 15s sweep and whose shortest deadline is the ladder's 60s first rung.
///
/// Five seconds costs at most five seconds of latency against that 60s rung and cuts the syscall
/// load by 5x. It is NOT the whole answer to the growth — that is retention, filed separately — but
/// it stops this module being the thing that makes the growth expensive.
const LEDGER_SCAN_INTERVAL: Duration = Duration::from_secs(5);

/// How long a claim held by a LIVE epoch may hide an agent from the due list.
///
/// ── WHY THE GATE IS BOUNDED BY AGE AND NOT BY LIVENESS ALONE (roborev 60246) ──────────────────
/// Suppressing on liveness alone is safe only if a claim is ALWAYS given back, and it is not.
/// `resurrectionRunner.admit` has two ordinary paths that leak one: the `agent_life_claim` invoke
/// can reject AFTER the record was written (a lost ack is a documented failure shape for these
/// commands), in which case the caller never learns it owns the claim and never releases it; and
/// `release` itself can throw, which is logged and not retried.
///
/// Before the claim gate existed, both cases SELF-HEALED on the next sweep — the agent stayed due,
/// and `claim_at` lets the same epoch re-claim (it refuses only a DIFFERENT live epoch). An
/// unbounded gate turns that into a silent permanent strand for the rest of the app run, which is
/// precisely the failure this module's header says the feature exists to end. A recovery mechanism
/// must not have a state it cannot leave.
///
/// 90s is several sweep intervals (the TS sweep is 15s), so an honest claim→mount→release round
/// trip is never interrupted, while a leaked one costs at most a minute and a half.
const CLAIM_STALE_MS: i64 = 90_000;

/// A dead agent whose not-before instant has arrived.
///
/// Carries everything the TS runner needs to build BOTH a `CohortMember` and a `ResurrectionInput`
/// without a second round trip. That matters more than it looks: the runner sweeps the whole fleet,
/// and an N+1 of `agent_life_read` calls per sweep would put the ledger back in front of the main
/// thread one agent at a time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DueAgent {
    pub agent_id: String,
    pub project_id: String,
    pub worktree: String,
    pub cause: DeathCause,
    /// The app-launch epoch that owned this agent. `resurrectionCohort.cohortKeyOf` groups an
    /// app-restart on this, because a killed process prints no banner to group on.
    pub epoch: String,
    /// When the death was recorded. The ladder's first rung is measured from here.
    pub died_at: i64,
    /// The instant the ledger says this agent may return. ALREADY REACHED — a `DueAgent` that is not
    /// yet due is not emitted at all.
    pub not_before_ms: i64,
    /// VERBATIM, never trimmed or re-cased. Cohort correlation keys a Map on exact equality, and a
    /// shared-outage report has already silently never fired because two agents' bytes differed by
    /// a newline.
    pub message: Option<String>,
    /// The DURABLE respawn timestamps, already pruned to the rolling 24h window by the ledger. The
    /// per-agent daily cap counts these, and it must survive an app restart — an in-memory counter
    /// would be zeroed by the very event the cap exists to bound.
    pub attempts_at: Vec<i64>,
}

/// The current due list, republished on every tick. Read by the `revival_due` command.
#[derive(Default)]
pub struct RevivalState(pub Mutex<Vec<DueAgent>>);

/// WHO IS DUE, from a set of readings and a clock. THE PURE CORE — no I/O, no `AppHandle`, no
/// ambient time — so the whole rule is testable with a literal map and an integer.
///
/// Four gates, and the ORDER of the first two is the one that keeps a running fleet safe:
///
///  1. `alive` → skip. `derive` computes this from a kernel-released `flock`, not a heartbeat, so a
///     machine asleep for eight hours still reads ALIVE and its agents are left alone.
///  2. `Retired` → skip. A retired record is one somebody finished with deliberately; bringing it
///     back would undo a human decision, which is the same reason `unclassified-death` refuses.
///  3. `resurrectable` → skip when false. `clean-goal-met`, `blocked-on-human` and `unknown` are
///     terminal, and the ledger has already applied `is_resurrectable`.
///  4. THE COMPARISON. `now_ms >= not_before`, and that is all the arithmetic there is.
///
/// A resurrectable cause with NO `not_before_ms` falls through as due, mirroring
/// `decideResurrection`, whose clock gate reads `armsOnClock(cause) && notBeforeMs !== undefined`.
/// The only way to reach that state is a `wall-session` death whose wall was never recorded — an
/// agent we know is waiting on a window but cannot say until when. Treating it as due hands it to
/// the ladder, which backs off; treating it as never-due would strand it silently forever, and a
/// silent permanent strand is the failure this whole feature exists to end.
pub fn due_at(
    readings: &BTreeMap<String, AgentLifeReading>,
    now_ms: i64,
    live_epochs: &HashSet<String>,
) -> Vec<DueAgent> {
    let mut out = Vec::new();
    for (agent_id, r) in readings {
        if r.alive {
            continue;
        }
        if r.record.state == LifeState::Retired {
            continue;
        }
        if !r.resurrectable {
            continue;
        }
        // A CLAIM HELD BY A STILL-RUNNING EPOCH MEANS SOMEONE IS ALREADY ON IT (roborev 60222).
        //
        // `claim_at` sets `state: Claimed` and leaves the `death` intact, so `derive` keeps
        // reporting the agent as not-alive and resurrectable — and without this gate the record is
        // republished as due on every scan for the whole time its respawn is in flight. The window
        // that matters is claim → `pty_spawn`: `pty_live_sessions` cannot see a session before
        // `pty_spawn` has inserted it, so during that gap the process-global backstop has nothing to
        // report and this is the only durable exclusion there is.
        //
        // Mirrors `claim_at`'s own rule exactly — a claim held by a DEAD epoch is taken over, so it
        // must not suppress anything. Liveness arrives as a pre-computed set rather than being read
        // here, which is what keeps this function pure and testable against a literal map.
        if let Some(claim) = &r.record.claim {
            // AND the claim must be RECENT. See `CLAIM_STALE_MS`: a claim that leaked (a lost ack, a
            // release that threw) is held by an epoch that is still very much alive, so a
            // liveness-only gate hides its agent for the rest of the app run.
            let fresh = now_ms.saturating_sub(claim.at) < CLAIM_STALE_MS;
            if fresh && live_epochs.contains(&claim.epoch) {
                continue;
            }
        }
        let Some(cause) = r.effective_cause else {
            continue;
        };
        // An UNSEALED app-restart record (still `Live` under a dead epoch) has no `death` yet —
        // `derive` reports the cause anyway so a reader racing the sealer is still correct. Fall
        // back to the open instant rather than dropping it: the agent is genuinely dead, and the
        // ladder measuring from a slightly older instant only ever makes it due SOONER, never later.
        let died_at = r.record.death.as_ref().map_or(r.record.opened_at, |d| d.at);
        let not_before = r.not_before_ms.unwrap_or(died_at);
        if now_ms < not_before {
            continue;
        }
        // The wall's message is the fallback because a sealed app-restart death carries none — it
        // was never observed, nobody was alive to print it — while the wall that rode along with it
        // may still name the incident the fleet shared.
        let message = r
            .record
            .death
            .as_ref()
            .and_then(|d| d.message.clone())
            .or_else(|| r.record.wall.as_ref().map(|w| w.message.clone()));
        out.push(DueAgent {
            agent_id: agent_id.clone(),
            project_id: r.record.project_id.clone(),
            worktree: r.record.worktree.clone(),
            cause,
            epoch: r.record.epoch.clone(),
            died_at,
            not_before_ms: not_before,
            message,
            attempts_at: r.record.attempts_at.clone(),
        });
    }
    out
}

/// Read every record, SKIPPING the ones that cannot be read — and failing only when the DIRECTORY
/// itself cannot be listed.
///
/// ── WHY NOT `agent_life::list_at`, WHICH IS THE OBVIOUS CALL ─────────────────────────────────
/// `list_at` propagates a per-RECORD failure as a whole-map `Err` (its `read_at(...)?`), and that is
/// right for the caller it was written for. Its doc says so outright: it returns `Result`, never a
/// bare map, because "a module that hands back an empty collection when it cannot read its own store
/// has told the reaper 'nothing is protected', which is the most destructive possible way to fail."
/// A reaper that cannot read must not delete.
///
/// The resurrector's asymmetry runs the other way, and one file is enough to expose it. A single
/// unparseable `<agentId>.json` — a torn write from a power loss, a half-flushed record, a file
/// whose stem `usable_agent_id` refuses — makes `list_at` return `Corrupt` for the WHOLE directory.
/// `tick` then keeps its previous list, which after a launch is empty, so **every** dead agent on the
/// machine stops being recoverable, permanently and silently, until someone finds and deletes that
/// one file. That is precisely the "an agent sits dead and nobody is told" failure this feature
/// exists to end, reintroduced by the recovery path itself.
///
/// So: an unreadable DIRECTORY still fails closed (the caller keeps its last list — we genuinely
/// cannot see the store), while an unreadable RECORD is skipped and logged. Skipping one record can
/// only ever mean one agent is not resurrected, which is the same outcome as it having no record at
/// all — the honest reading of a file we cannot parse.
fn read_ledger(
    dir: &Path,
    app_data: &Path,
    now_ms: i64,
) -> Result<BTreeMap<String, AgentLifeReading>, agent_life::LifeError> {
    let mut out = BTreeMap::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        // An ABSENT ledger is not a failure: it is a machine that has never opened a record. Empty
        // is the correct answer, and it is what `list_at` says too.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(agent_life::LifeError::Io(e.to_string())),
    };
    let mut skipped: BTreeSet<String> = BTreeSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(agent_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        match agent_life::read_at(dir, app_data, agent_id, now_ms) {
            Ok(Some(reading)) => {
                out.insert(agent_id.to_string(), reading);
            }
            Ok(None) => {}
            Err(e) => {
                // Recorded, not logged here. A torn record is a PERMANENT state — nothing repairs,
                // quarantines or deletes the file — so a line per record per scan is ~17k lines a
                // day, forever, burying every other `revival` log including the one that would
                // explain it. Logged below, once, and only when the SET changes.
                tracing::debug!(target: "revival", agent_id, error = %e, "unreadable agent-life record");
                skipped.insert(agent_id.to_string());
            }
        }
    }
    // ONCE PER CHANGED SET. A new bad file, or an old one going away, is news; the same three bad
    // files on the ten-thousandth scan is not.
    {
        let mut last = LAST_SKIPPED.lock().unwrap_or_else(|e| e.into_inner());
        if *last != skipped {
            if skipped.is_empty() {
                tracing::info!(target: "revival", "every agent-life record is readable again");
            } else {
                tracing::warn!(
                    target: "revival",
                    skipped = skipped.len(),
                    readable = out.len(),
                    agent_ids = ?skipped,
                    "skipping unreadable agent-life records; the rest of the ledger still counts"
                );
            }
            *last = skipped;
        }
    }
    Ok(out)
}

/// One pass: read the ledger, compute the due list, publish it. Returns the list so a caller (and a
/// test) sees what was published rather than having to read the state back.
///
/// NEVER PROPAGATES A READ FAILURE AS AN EMPTY LIST. An unreadable ledger leaves the previously
/// published list exactly as it was — the same fail-closed discipline `list_at` states for the
/// reaper, in the other direction: a module that answers "nobody is due" when it cannot read its own
/// store has quietly told the fleet that nothing needs recovering.
fn tick(dir: &Path, app_data: &Path, state: &RevivalState, now_ms: i64) -> Option<Vec<DueAgent>> {
    let readings = match read_ledger(dir, app_data, now_ms) {
        Ok(r) => r,
        Err(e) => {
            // ONCE PER TRANSITION, never once per scan (roborev 60222). An unreadable ledger is a
            // STATE, not an event: left as a per-scan warning it emitted a line every few seconds
            // for as long as the condition held, which buries every other log this app writes —
            // and the condition is exactly the one somebody would be reading the log to diagnose.
            if !LEDGER_UNREADABLE.swap(true, Ordering::Relaxed) {
                tracing::warn!(target: "revival", error = %e, "ledger unreadable; keeping the last due list");
            }
            return None;
        }
    };
    if LEDGER_UNREADABLE.swap(false, Ordering::Relaxed) {
        tracing::info!(target: "revival", "ledger readable again");
    }

    // Which epochs holding a claim are still running, probed at most ONCE per distinct epoch.
    //
    // BOTH answers are memoized, not just the positive one (roborev 60246). Caching only the live
    // epochs meant every record naming a DEAD one was re-probed on every scan — and that is exactly
    // the app-restart shape, where many records share the one epoch that just died. Since nothing
    // prunes `<app_data>/agent-life`, those stale claims accumulate and re-pay a `File::open` per
    // record every 5s forever: the cost `LEDGER_SCAN_INTERVAL` exists to bound, re-introduced
    // underneath it.
    let mut probed: HashMap<String, bool> = HashMap::new();
    let mut live_epochs = HashSet::new();
    for r in readings.values() {
        if let Some(claim) = &r.record.claim {
            // ONE definition of the liveness rule, borrowed rather than re-derived. `agent_life`'s
            // own doc calls the `process_epoch()` short-circuit load-bearing — without it every
            // record of a perfectly healthy fleet reads as dead — so a hand-copy here is precisely
            // the drift hazard the rest of this module argues against.
            let alive = *probed
                .entry(claim.epoch.clone())
                .or_insert_with(|| agent_life::epoch_still_running(app_data, &claim.epoch));
            if alive {
                live_epochs.insert(claim.epoch.clone());
            }
        }
    }

    let due = due_at(&readings, now_ms, &live_epochs);
    publish_due(state, &due);
    Some(due)
}

/// WHICH DEATH THIS IS, as opposed to WHEN THE ANSWER WAS COMPUTED.
///
/// `not_before_ms` is deliberately absent, and it is the entire reason this function exists.
/// `agent_life::derive` recomputes it as `Some(now_ms)` for every cause that is not clock-armed —
/// which is load-bearing and must NOT change ("due immediately" has to mean *now*, not an instant
/// frozen when the record was written). So a freshly computed `DueAgent` differs from the one
/// published five seconds ago on EVERY scan, `*guard != due` was therefore always true, and
/// `due-for-resurrection set changed` was logged once per scan with a byte-identical id list:
/// 3,138 lines in one day on the founder's install, burying every other `revival` line — including
/// the ones that say why an agent did or did not come back, which is what someone reading this log
/// came for. The same shape as the two edge-triggered logs above (`LEDGER_UNREADABLE`,
/// `LAST_SKIPPED`), which this one was supposed to be and was not.
///
/// The five fields are what identify a death: which agent, of what, when, under which app epoch,
/// and how many respawns it has already spent. `project_id` and `worktree` cannot change without
/// the record being reopened (which changes `died_at`). `message` CAN — a wall arriving after a
/// transport death rewrites it — so a message-only change goes unlogged; that is accepted, because
/// the due SET is what this line reports and it has not moved. The full struct is still published
/// (see `publish_due`), so nothing downstream loses the newer message.
fn due_identity(d: &DueAgent) -> (&str, DeathCause, i64, &str, usize) {
    (
        d.agent_id.as_str(),
        d.cause,
        d.died_at,
        d.epoch.as_str(),
        d.attempts_at.len(),
    )
}

/// Publish `due`, logging only when the SET genuinely changed. Returns whether a line was written.
///
/// The return value is what makes the change detection testable: it is the exact boolean the log is
/// gated on, in the same `if`, so a test asserting `[true, false]` across two identical-but-
/// recomputed scans goes red the moment the comparison goes back to whole structs.
///
/// Element-wise comparison is sound because `due_at` walks a `BTreeMap`, so both lists are ordered
/// by `agent_id`; a set that gained or lost a member changes the length or the ids at some index.
fn publish_due(state: &RevivalState, due: &[DueAgent]) -> bool {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let changed = guard.len() != due.len()
        || guard
            .iter()
            .zip(due.iter())
            .any(|(was, now)| due_identity(was) != due_identity(now));
    if changed {
        // Logged on CHANGE only. A per-scan line for a steady state would bury the transition that
        // matters, and this is the record a human reads when they ask why an agent came back.
        tracing::info!(
            target: "revival",
            due = due.len(),
            ids = ?due.iter().map(|d| d.agent_id.as_str()).collect::<Vec<_>>(),
            "due-for-resurrection set changed"
        );
    }
    // REPUBLISHED EVERY SCAN, changed or not. `revival_due` serves this list to the TS runner, whose
    // ladder compares `not_before_ms` against a live clock — so freezing the published struct to
    // keep the log quiet would trade a logging bug for a scheduling one. Only the log's change test
    // changed here; the payload is exactly what it always was.
    guard.clear();
    guard.extend_from_slice(due);
    changed
}

static STARTED: AtomicBool = AtomicBool::new(false);
/// Is the ledger currently unreadable? Edge state for the log line only — see `tick`.
static LEDGER_UNREADABLE: AtomicBool = AtomicBool::new(false);
/// Has the session reaper failed? Edge state for the log line only — a reaper that cannot read the
/// ledger fails on EVERY scan, and a per-scan warning would bury the rest of this target's output.
static REAP_FAILED: AtomicBool = AtomicBool::new(false);
/// The agent ids skipped on the LAST scan. Edge state for the log line only — see `read_ledger`.
static LAST_SKIPPED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Start the revival thread. Idempotent; safe to call more than once.
///
/// A plain `std::thread`, not a Tauri async task, for the reason the header gives: this must keep
/// ticking when the WebView is wedged and when every model in the app is behind the same wall.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let base = match crate::dev_identity::app_data_dir(app) {
        Ok(b) => b,
        Err(e) => {
            // Nothing to read and nowhere to read it from. Undo the latch so a later caller (a
            // retry, a second window) can try again rather than being told the thread is running.
            STARTED.store(false, Ordering::SeqCst);
            tracing::warn!(target: "revival", error = %e, "app_data_dir unavailable; revival not started");
            return;
        }
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let dir = agent_life::life_dir(&base);
        let mut next_scan_at = 0i64;
        loop {
            std::thread::sleep(TICK);
            let now = now_ms();
            // The thread wakes on TICK; the LEDGER is read on its own, slower interval. Gated on the
            // wall clock rather than a tick counter so a machine suspend does not bank up a burst of
            // scans on wake — the same hazard `nudger.rs` handles explicitly for its deadlines.
            if now < next_scan_at {
                continue;
            }
            next_scan_at = now.saturating_add(LEDGER_SCAN_INTERVAL.as_millis() as i64);
            let Some(state) = app.try_state::<RevivalState>() else {
                continue;
            };
            // SEAL BEFORE PUBLISHING, on the same scan, so a newly-reaped agent is due immediately
            // rather than a scan later.
            //
            // This is the input side of the whole feature. `agent_life::seal_stale_at` runs only at
            // app LAUNCH and only for a DEAD epoch, so the far more common death — one agent's
            // `claude` exiting while the app keeps running — was never written down at all: the
            // record stayed `Live`, `derive` reported `alive: true`, and `due_at`'s first gate
            // skipped it forever. Measured on a live install: seven agents with no process, a
            // `Live` record and a `working` status 47 minutes after their last hook event.
            //
            // The PTY session map is the artifact that settles it, and it is the RIGHT one: it is
            // app-global (`pty_spawn` from any webview reaches any agent id), it needs no mounted
            // pane, and it costs a mutex lock and a `Vec<String>` clone. No model call, in keeping
            // with this module's header.
            if let Some(pty) = app.try_state::<crate::pty::PtyManager>() {
                let live: HashSet<String> = pty.session_ids().into_iter().collect();
                match agent_life::reap_dead_sessions_at(
                    &dir,
                    crate::babysit_lease::process_epoch(),
                    &live,
                    now,
                ) {
                    Ok(stats) if stats.reaped > 0 => {
                        // Logged unconditionally when it fires: a death being inferred is exactly
                        // the line a human wants when they ask why an agent came back.
                        tracing::info!(
                            target: "revival",
                            reaped = stats.reaped,
                            still_live = stats.still_live,
                            too_young = stats.too_young,
                            "sealed agents whose PTY session is gone"
                        );
                    }
                    Ok(_) => {}
                    Err(e) => {
                        // ONCE PER TRANSITION, same discipline as the ledger-unreadable log below.
                        if !REAP_FAILED.swap(true, Ordering::Relaxed) {
                            tracing::warn!(target: "revival", error = %e, "could not reap dead sessions");
                        }
                    }
                }
            }
            tick(&dir, &base, &state, now);
        }
    });
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The due list as of the last tick.
///
/// `async` + no blocking work at all: it is a `Vec` clone out of a mutex the thread holds for
/// microseconds. The ledger read happens on the revival thread, which is the point — the sweep asks
/// a question that has already been answered.
#[tauri::command]
pub async fn revival_due(app: AppHandle) -> Result<Vec<DueAgent>, String> {
    let state = app
        .try_state::<RevivalState>()
        .ok_or_else(|| "revival state not managed".to_string())?;
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_life::{
        AgentLifeRecord, Claim, Death, DeathEvidence, ReaperVerdict, Wall,
    };

    const NOW: i64 = 1_754_534_400_000;

    fn record(agent_id: &str, state: LifeState) -> AgentLifeRecord {
        AgentLifeRecord {
            v: 1,
            agent_id: agent_id.to_string(),
            project_id: "proj".into(),
            worktree: "/wt".into(),
            epoch: "epoch-1".into(),
            opened_at: NOW - 600_000,
            state,
            death: None,
            wall: None,
            wip: None,
            claim: None,
            attempts_at: Vec::new(),
            retired_at: None,
            retired_reason: None,
            retired_by: None,
            retired_evidence: None,
            prior: Vec::new(),
        }
    }

    fn reading(
        record: AgentLifeRecord,
        alive: bool,
        cause: Option<DeathCause>,
        not_before_ms: Option<i64>,
    ) -> AgentLifeReading {
        AgentLifeReading {
            record,
            alive,
            effective_cause: cause,
            resurrectable: cause.is_some_and(agent_life::is_resurrectable),
            not_before_ms,
            reaper_verdict: ReaperVerdict::Protected,
        }
    }

    fn dead(agent_id: &str, cause: DeathCause, at: i64) -> AgentLifeRecord {
        let mut rec = record(agent_id, LifeState::Dead);
        rec.death = Some(Death {
            cause,
            evidence: match cause {
                DeathCause::AppRestart => DeathEvidence::EpochDead,
                DeathCause::TransportTransient => DeathEvidence::ApiBanner,
                DeathCause::CleanGoalMet => DeathEvidence::GoalMetMarked,
                _ => DeathEvidence::QuotaBlock,
            },
            at,
            message: None,
            goal_met_at: None,
        });
        rec
    }

    /// No epoch is holding a claim. The ordinary case, and the default for every test that is not
    /// about the claim gate.
    fn no_claims() -> HashSet<String> {
        HashSet::new()
    }

    fn map(readings: Vec<AgentLifeReading>) -> BTreeMap<String, AgentLifeReading> {
        readings
            .into_iter()
            .map(|r| (r.record.agent_id.clone(), r))
            .collect()
    }

    /// The comparison, in both directions, off ONE record — so this cannot pass by the agent being
    /// dropped for some unrelated reason.
    #[test]
    fn a_wall_is_due_at_its_reset_instant_and_not_one_millisecond_before() {
        let reset = NOW + 60_000;
        let mut rec = dead("a1", DeathCause::WallSession, NOW);
        rec.wall = Some(Wall {
            message: "You've hit your session limit · resets 10:30pm (America/Los_Angeles)".into(),
            reset_at: Some(reset),
            reset_parsed: true,
            observed_at: NOW,
        });
        let readings = map(vec![reading(
            rec,
            false,
            Some(DeathCause::WallSession),
            Some(reset),
        )]);

        assert!(
            due_at(&readings, reset - 1, &no_claims()).is_empty(),
            "a wall that has not lifted must not be due"
        );
        let at_instant = due_at(&readings, reset, &no_claims());
        assert_eq!(at_instant.len(), 1, "the reset instant itself is due");
        assert_eq!(at_instant[0].agent_id, "a1");
        assert_eq!(at_instant[0].not_before_ms, reset);
        assert_eq!(due_at(&readings, reset + 3_600_000, &no_claims()).len(), 1, "and stays due after");
    }

    /// The direction that would be catastrophic: a LIVE fleet reported as due. `derive` answers
    /// `alive` from a kernel-released `flock`, so an app asleep for hours still reads alive — and if
    /// this gate were dropped, every running agent would be handed to the resurrector at once.
    #[test]
    fn a_live_agent_is_never_due_however_old_its_record() {
        let readings = map(vec![reading(record("a1", LifeState::Live), true, None, None)]);
        assert!(due_at(&readings, NOW + 86_400_000, &no_claims()).is_empty());
    }

    /// The three terminal causes, each refused for its own reason. Asserted together because the
    /// mistake they guard against is one mistake: reading "we do not know" as "bring it back".
    #[test]
    fn terminal_causes_are_never_due() {
        let readings = map(vec![
            reading(
                dead("finished", DeathCause::CleanGoalMet, NOW),
                false,
                Some(DeathCause::CleanGoalMet),
                None,
            ),
            reading(
                dead("asking", DeathCause::BlockedOnHuman, NOW),
                false,
                Some(DeathCause::BlockedOnHuman),
                None,
            ),
            reading(
                dead("mystery", DeathCause::Unknown, NOW),
                false,
                Some(DeathCause::Unknown),
                None,
            ),
        ]);
        assert!(
            due_at(&readings, NOW + 86_400_000, &no_claims()).is_empty(),
            "clean-goal-met, blocked-on-human and unknown are all terminal"
        );
    }

    /// A retired record is one a human finished with. Distinct from the terminal causes above: the
    /// CAUSE here is resurrectable, and only the state refuses it.
    #[test]
    fn a_retired_record_is_not_due_even_with_a_resurrectable_cause() {
        let mut rec = dead("a1", DeathCause::TransportTransient, NOW);
        rec.state = LifeState::Retired;
        rec.retired_at = Some(NOW);
        let readings = map(vec![reading(
            rec,
            false,
            Some(DeathCause::TransportTransient),
            Some(NOW),
        )]);
        assert!(due_at(&readings, NOW + 1, &no_claims()).is_empty());
    }

    /// A spend cap names NO reset instant and must never be gated on one — it is recovered by
    /// probing. The ledger hands it `not_before_ms: Some(now)`, so it is due immediately and the TS
    /// ladder is what paces it.
    #[test]
    fn a_spend_cap_is_due_immediately_because_only_a_probe_can_clear_it() {
        let mut rec = dead("a1", DeathCause::WallSpend, NOW);
        rec.wall = Some(Wall {
            message: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage"
                .into(),
            reset_at: None,
            reset_parsed: false,
            observed_at: NOW,
        });
        let readings = map(vec![reading(
            rec,
            false,
            Some(DeathCause::WallSpend),
            Some(NOW),
        )]);
        let due = due_at(&readings, NOW, &no_claims());
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].cause, DeathCause::WallSpend);
        assert_eq!(
            due[0].message.as_deref(),
            Some("You've hit your monthly spend limit · raise it at claude.ai/settings/usage"),
            "the wall's message must survive verbatim — cohort grouping keys on exact equality"
        );
    }

    /// A `wall-session` whose wall was never recorded: we know it is waiting, not until when.
    /// Mirrors `decideResurrection`, whose clock gate is skipped when `notBeforeMs === undefined`.
    /// The alternative — never due — is a silent permanent strand.
    #[test]
    fn a_clock_armed_cause_with_no_recorded_instant_falls_through_to_the_ladder() {
        let readings = map(vec![reading(
            dead("a1", DeathCause::WallSession, NOW),
            false,
            Some(DeathCause::WallSession),
            None,
        )]);
        let due = due_at(&readings, NOW, &no_claims());
        assert_eq!(due.len(), 1, "an unknown reset must not strand the agent forever");
        assert_eq!(due[0].not_before_ms, NOW, "it falls back to the death instant");
    }

    /// An unsealed app-restart — `Live` under a dead epoch, which is what a reader racing
    /// `seal_stale_at` sees. It has no `death` at all, so `died_at` must come from `opened_at`
    /// rather than dropping the agent.
    #[test]
    fn an_unsealed_app_restart_is_due_and_dates_from_the_open() {
        let rec = record("a1", LifeState::Live);
        let opened = rec.opened_at;
        let readings = map(vec![reading(
            rec,
            false, // the epoch is dead, so `derive` reports not-alive
            Some(DeathCause::AppRestart),
            Some(NOW),
        )]);
        let due = due_at(&readings, NOW, &no_claims());
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].died_at, opened);
        assert_eq!(due[0].epoch, "epoch-1", "the dead epoch is the cohort key for a restart");
    }

    /// The durable attempt list must reach the TS side intact — it IS the rolling daily cap, and an
    /// in-memory count would be zeroed by the app restart the cap exists to bound.
    #[test]
    fn the_durable_attempt_timestamps_are_carried_through() {
        let mut rec = dead("a1", DeathCause::TransportTransient, NOW);
        rec.attempts_at = vec![NOW - 3_600_000, NOW - 1_800_000];
        let readings = map(vec![reading(
            rec,
            false,
            Some(DeathCause::TransportTransient),
            Some(NOW),
        )]);
        let due = due_at(&readings, NOW, &no_claims());
        assert_eq!(due[0].attempts_at, vec![NOW - 3_600_000, NOW - 1_800_000]);
    }

    /// A CLAIM HELD BY A LIVE EPOCH SUPPRESSES THE AGENT; ONE HELD BY A DEAD EPOCH DOES NOT.
    ///
    /// Written as an inverted pair over the SAME record, changing only the live-epoch set, so it
    /// cannot pass by the record being dropped for any of the other four reasons. The dead-epoch
    /// half is the one that matters most: `claim_at` is written to TAKE OVER from a claimant that
    /// died mid-ladder, so a stale claim must never be able to strand an agent permanently — which
    /// is exactly what a naive `state == Claimed → skip` would do.
    #[test]
    fn a_claim_held_by_a_live_epoch_suppresses_the_agent_and_a_dead_ones_does_not() {
        let mut rec = dead("a1", DeathCause::TransportTransient, NOW);
        rec.state = LifeState::Claimed;
        rec.claim = Some(Claim {
            by: "resurrectionRunner".into(),
            epoch: "claimant-epoch".into(),
            at: NOW,
            attempts: 0,
        });
        let readings = map(vec![reading(
            rec,
            false,
            Some(DeathCause::TransportTransient),
            Some(NOW),
        )]);

        let live: HashSet<String> = ["claimant-epoch".to_string()].into_iter().collect();
        assert!(
            due_at(&readings, NOW + 1, &live).is_empty(),
            "a respawn already in flight must not be published as due again"
        );

        // The SAME record, with that epoch now dead: it must come back, because nobody is on it.
        let due = due_at(&readings, NOW + 1, &no_claims());
        assert_eq!(due.len(), 1, "a claim from a dead epoch must not strand the agent");
        assert_eq!(due[0].agent_id, "a1");
    }

    /// A LEAKED CLAIM MUST AGE OUT. The gate is bounded by claim age, not by epoch liveness alone.
    ///
    /// The epoch here is THIS process's own — the realistic leak, since it is our own `admit` that
    /// can fail to release — so it is alive by definition and a liveness-only gate would hide this
    /// agent for the rest of the app run. Inverted pair over one record: fresh claim suppresses,
    /// stale claim does not.
    #[test]
    fn a_claim_that_was_never_released_stops_hiding_the_agent_once_it_goes_stale() {
        let epoch = crate::babysit_lease::process_epoch().to_string();
        let mut rec = dead("a1", DeathCause::TransportTransient, NOW);
        rec.state = LifeState::Claimed;
        rec.claim = Some(Claim {
            by: "resurrectionRunner".into(),
            epoch: epoch.clone(),
            at: NOW,
            attempts: 0,
        });
        let readings = map(vec![reading(
            rec,
            false,
            Some(DeathCause::TransportTransient),
            Some(NOW),
        )]);
        let live: HashSet<String> = [epoch].into_iter().collect();

        assert!(
            due_at(&readings, NOW + CLAIM_STALE_MS - 1, &live).is_empty(),
            "a claim younger than the staleness window is an admission in flight"
        );
        assert_eq!(
            due_at(&readings, NOW + CLAIM_STALE_MS, &live).len(),
            1,
            "a claim nobody released must stop hiding the agent — before this bound existed it \
             stranded the agent silently for the rest of the app run"
        );
    }

    /// THE MAPPING FROM RECORD → PROBED EPOCH, which the `due_at` tests cannot cover because they
    /// inject `live_epochs` as a literal.
    ///
    /// That is where the dangerous mistake lives: probing `record.epoch` instead of
    /// `record.claim.epoch` would suppress an entire app-restart cohort under one live epoch, and
    /// dropping the `process_epoch()` short-circuit would make a healthy fleet read as dead — and
    /// BOTH would still pass every test that hands the set in ready-made. Driven through the real
    /// `tick` over a real directory, as an inverted pair.
    #[test]
    fn tick_probes_the_CLAIM_epoch_and_honours_this_process_being_alive() {
        let td = tempfile::tempdir().expect("tempdir");
        let dir = td.path().join("agent-life");
        let app_data = td.path().join("app-data");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&app_data).unwrap();

        // Both records are stamped with a DEAD owning epoch, so both are dead and resurrectable.
        // They differ only in who holds the CLAIM.
        for id in ["claimed-by-us", "claimed-by-a-ghost"] {
            agent_life::open_at(&dir, id, "proj", "/wt", "dead-owner-epoch", NOW).unwrap();
            agent_life::close_at(
                &dir,
                id,
                Death {
                    cause: DeathCause::TransportTransient,
                    evidence: DeathEvidence::ApiBanner,
                    at: NOW,
                    message: None,
                    goal_met_at: None,
                },
                None,
            )
            .unwrap();
        }
        // Ours: the live current process. `epoch_still_running` answers true via the short-circuit,
        // with no lock file anywhere — which is the case the short-circuit exists for.
        agent_life::claim_at(&dir, &app_data, "claimed-by-us", "runner", crate::babysit_lease::process_epoch(), NOW)
            .unwrap();
        // A ghost: an epoch that never took a lease, so there is no lock file and it reads dead.
        agent_life::claim_at(&dir, &app_data, "claimed-by-a-ghost", "runner", "ghost-epoch", NOW)
            .unwrap();

        let state = RevivalState::default();
        let due = tick(&dir, &app_data, &state, NOW + 1).expect("ledger readable");
        let ids: Vec<&str> = due.iter().map(|d| d.agent_id.as_str()).collect();

        assert_eq!(
            ids,
            vec!["claimed-by-a-ghost"],
            "only the ghost's claim may be ignored; ours is an admission in flight"
        );
    }

    /// An unreadable ledger must LEAVE the published list alone rather than publish an empty one.
    /// Driven through the real `tick` against a path that is a FILE, not a directory, so the failure
    /// is a genuine `read_dir` error rather than a mocked one.
    #[test]
    fn an_unreadable_ledger_keeps_the_last_published_list() {
        let td = tempfile::tempdir().expect("tempdir");
        let not_a_dir = td.path().join("agent-life");
        std::fs::write(&not_a_dir, b"this is a file, not a directory").unwrap();
        let app_data = td.path().to_path_buf();

        let state = RevivalState::default();
        let previous = vec![DueAgent {
            agent_id: "a1".into(),
            project_id: "p".into(),
            worktree: "/wt".into(),
            cause: DeathCause::TransportTransient,
            epoch: "e".into(),
            died_at: NOW,
            not_before_ms: NOW,
            message: None,
            attempts_at: Vec::new(),
        }];
        *state.0.lock().unwrap() = previous.clone();

        assert!(
            tick(&not_a_dir, &app_data, &state, NOW).is_none(),
            "an unreadable ledger must report no answer, not an empty one"
        );
        assert_eq!(
            *state.0.lock().unwrap(),
            previous,
            "the previously published list must survive an unreadable ledger"
        );
    }

    /// The positive half of the pair above, through the SAME `tick`: a real ledger with one dead
    /// agent publishes it. Without this, the test above would pass against a `tick` that never
    /// publishes anything.
    #[test]
    fn tick_publishes_a_due_agent_from_a_real_ledger() {
        let td = tempfile::tempdir().expect("tempdir");
        let dir = td.path().join("agent-life");
        let app_data = td.path().join("app-data");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&app_data).unwrap();

        // A record stamped with an epoch that never took a lease, so it reads DEAD.
        agent_life::open_at(&dir, "a1", "proj", "/wt", "dead-epoch", NOW).unwrap();
        agent_life::close_at(
            &dir,
            "a1",
            Death {
                cause: DeathCause::TransportTransient,
                evidence: DeathEvidence::ApiBanner,
                at: NOW,
                message: Some("API Error: Unable to connect to API (ENOTFOUND)".into()),
                goal_met_at: None,
            },
            None,
        )
        .unwrap();

        let state = RevivalState::default();
        let due = tick(&dir, &app_data, &state, NOW + 1).expect("ledger readable");
        assert_eq!(due.len(), 1, "the dead agent must be published as due");
        assert_eq!(due[0].agent_id, "a1");
        assert_eq!(due[0].cause, DeathCause::TransportTransient);
        assert_eq!(
            due[0].message.as_deref(),
            Some("API Error: Unable to connect to API (ENOTFOUND)")
        );
        assert_eq!(*state.0.lock().unwrap(), due, "the state holds what tick returned");
    }

    /// ONE CORRUPT FILE MUST NOT STRAND THE WHOLE MACHINE.
    ///
    /// `agent_life::list_at` answers `Err(Corrupt)` for the entire directory if any single record
    /// fails to parse — correct for the reaper it was written for, catastrophic here: `tick` would
    /// keep its previous list, which after a launch is empty, so EVERY dead agent stops being
    /// recoverable, silently and permanently, until a human finds that one file.
    ///
    /// Drives the real `tick` over a ledger holding one good record and two bad ones. The good one
    /// must still be published. Fails against a `tick` that calls `list_at`.
    #[test]
    fn one_unparseable_record_does_not_hide_every_other_agent() {
        let td = tempfile::tempdir().expect("tempdir");
        let dir = td.path().join("agent-life");
        let app_data = td.path().join("app-data");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&app_data).unwrap();

        // The good record: dead, resurrectable, due.
        agent_life::open_at(&dir, "healthy", "proj", "/wt", "dead-epoch", NOW).unwrap();
        agent_life::close_at(
            &dir,
            "healthy",
            Death {
                cause: DeathCause::TransportTransient,
                evidence: DeathEvidence::ApiBanner,
                at: NOW,
                message: Some("API Error: 529 Overloaded".into()),
                goal_met_at: None,
            },
            None,
        )
        .unwrap();

        // A torn write — the realistic shape after a power loss mid-rename.
        std::fs::write(dir.join("truncated.json"), b"{\"v\":1,\"agentId\":\"trunc").unwrap();
        // …and a file that parses as JSON but is not a record at all.
        std::fs::write(dir.join("wrong-shape.json"), b"[1,2,3]").unwrap();

        // Positive control: `list_at` — the call this module deliberately does NOT make — really
        // does fail outright on this directory. Without it, a green test below could mean the
        // fixtures were harmless rather than that the skip works.
        assert!(
            agent_life::list_at(&dir, &app_data, NOW + 1).is_err(),
            "the fixtures must actually break list_at, or this test proves nothing"
        );

        let state = RevivalState::default();
        let due = tick(&dir, &app_data, &state, NOW + 1).expect("a corrupt record is not a dead ledger");
        assert_eq!(
            due.iter().map(|d| d.agent_id.as_str()).collect::<Vec<_>>(),
            vec!["healthy"],
            "the readable agent must still be published"
        );
    }

    // ── THE LOG THAT BURIED EVERYTHING ELSE ─────────────────────────────────────────────────────
    //
    // These assert the LINE, not a helper's return value, because the defect was a log: `tick`
    // wrote `due-for-resurrection set changed` on every 5s scan with an identical id list — 3,138
    // lines in one day. A test that only checked `publish_due`'s boolean would still pass against a
    // `tick` that logged unconditionally beside it.

    /// Run `f` with `tracing` output captured into a string, so the number of emitted lines can be
    /// counted. Thread-local (`with_default`), so a parallel test run cannot cross-contaminate.
    fn capture_logs<T>(f: impl FnOnce() -> T) -> (T, String) {
        use std::io::Write;
        use std::sync::{Arc, Mutex};

        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl Write for Buf {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buf {
            type Writer = Buf;
            fn make_writer(&'a self) -> Buf {
                self.clone()
            }
        }

        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .finish();
        let out = tracing::subscriber::with_default(subscriber, f);
        let text = {
            let bytes = buf.0.lock().unwrap_or_else(|e| e.into_inner());
            String::from_utf8_lossy(&bytes).into_owned()
        };
        (out, text)
    }

    const CHANGE_LINE: &str = "due-for-resurrection set changed";

    /// A ledger holding one dead, resurrectable, due agent. Returns the tempdir (which must be held
    /// alive) plus the two paths `tick` takes.
    fn one_dead_agent_ledger(id: &str) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let td = tempfile::tempdir().expect("tempdir");
        let dir = td.path().join("agent-life");
        let app_data = td.path().join("app-data");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&app_data).unwrap();
        add_dead_agent(&dir, id);
        (td, dir, app_data)
    }

    fn add_dead_agent(dir: &Path, id: &str) {
        // "dead-epoch" never took a lease, so `epoch_still_running` reads it as dead.
        agent_life::open_at(dir, id, "proj", "/wt", "dead-epoch", NOW).unwrap();
        agent_life::close_at(
            dir,
            id,
            Death {
                cause: DeathCause::TransportTransient,
                evidence: DeathEvidence::ApiBanner,
                at: NOW,
                message: Some("API Error: Unable to connect to API (ENOTFOUND)".into()),
                goal_met_at: None,
            },
            None,
        )
        .unwrap();
    }

    /// THE 3,138-LINES-A-DAY BUG.
    ///
    /// `transport-transient` is not clock-armed, so `derive` computes `not_before_ms = Some(now_ms)`
    /// — a DIFFERENT value on every scan, by design. Comparing whole `DueAgent`s therefore made
    /// `*guard != due` unconditionally true. Two scans over an unchanged ledger must produce ONE
    /// line, not two.
    #[test]
    fn an_unchanged_due_set_logs_once_even_though_not_before_is_recomputed_each_scan() {
        let (_td, dir, app_data) = one_dead_agent_ledger("a1");
        let state = RevivalState::default();

        let ((first, second), logs) = capture_logs(|| {
            let first = tick(&dir, &app_data, &state, NOW + 1).expect("ledger readable");
            let second = tick(&dir, &app_data, &state, NOW + 5_000).expect("ledger readable");
            (first, second)
        });

        // POSITIVE CONTROL — without it a green test could mean the fixture never recomputed
        // anything, which is the vacuous version of this assertion.
        assert_ne!(
            first, second,
            "the fixture must actually produce two different structs, or this test proves nothing"
        );
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_ne!(
            first[0].not_before_ms, second[0].not_before_ms,
            "`not_before_ms` must be the recomputed field — that is the whole premise here"
        );
        assert_eq!(
            first[0].agent_id, second[0].agent_id,
            "the due SET is unchanged; only the recomputed instant moved"
        );

        assert_eq!(
            logs.matches(CHANGE_LINE).count(),
            1,
            "a steady due set must log once, not once per scan — got:\n{logs}"
        );
    }

    /// THE PAIRED POSITIVE. Without it, a `publish_due` that never logged at all would satisfy the
    /// test above — and a change nobody is told about is the failure this module exists to end.
    #[test]
    fn a_genuinely_changed_due_set_still_logs() {
        let (_td, dir, app_data) = one_dead_agent_ledger("a1");
        let state = RevivalState::default();

        let (sets, logs) = capture_logs(|| {
            let first = tick(&dir, &app_data, &state, NOW + 1).expect("ledger readable");
            // A SECOND agent dies. Same cause, same epoch — so nothing but MEMBERSHIP changed.
            add_dead_agent(&dir, "a2");
            let second = tick(&dir, &app_data, &state, NOW + 5_000).expect("ledger readable");
            (first, second)
        });

        assert_eq!(sets.0.len(), 1);
        assert_eq!(sets.1.len(), 2, "the second scan must genuinely see two agents");
        assert_eq!(
            logs.matches(CHANGE_LINE).count(),
            2,
            "an agent joining the due set is news and must be logged — got:\n{logs}"
        );
    }

    /// A RESPAWN IS A CHANGE TOO. `attempts_at.len()` is in the identity precisely so that an agent
    /// that stayed due while spending one of its 24 daily attempts re-logs — that is the transition
    /// a human is reading this log to find. Driven through `publish_due` because the attempt count
    /// is the one identity axis that moves without the membership moving.
    #[test]
    fn a_new_respawn_attempt_on_the_same_agent_counts_as_a_change() {
        fn due(attempts: Vec<i64>, not_before: i64) -> Vec<DueAgent> {
            vec![DueAgent {
                agent_id: "a1".into(),
                project_id: "proj".into(),
                worktree: "/wt".into(),
                cause: DeathCause::TransportTransient,
                epoch: "e".into(),
                died_at: NOW,
                not_before_ms: not_before,
                message: None,
                attempts_at: attempts,
            }]
        }

        let state = RevivalState::default();
        assert!(publish_due(&state, &due(vec![], NOW)), "the first publish is always a change");
        assert!(
            !publish_due(&state, &due(vec![], NOW + 5_000)),
            "a recomputed instant alone is not a change"
        );
        assert!(
            publish_due(&state, &due(vec![NOW + 6_000], NOW + 10_000)),
            "a respawn attempt recorded against the same agent IS a change"
        );
        assert_eq!(
            state.0.lock().unwrap().first().map(|d| d.not_before_ms),
            Some(NOW + 10_000),
            "the FULL struct is still published every scan, including the unchanged-set one"
        );
    }
}

//! Notice that the main thread is wedged **while it is still wedged**, and capture proof.
//!
//! ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
//! On 2026-07-29 Sparkle beachballed twice during a window resize; the user waited a full minute
//! and force-quit. The app recorded NOTHING: no crash file, no panic-hook fire, no jank line. That
//! was not an oversight in what we chose to log — it is structural. Every instrument we had ran ON
//! the main thread:
//!
//!   * the panic hook only fires on a panic, and a hang is not one;
//!   * the rAF jank monitor (`perfTrace.ts`) can only report a stall AFTER it ends, because the
//!     thread that would write the line is the thread that is blocked. A logged stall is by
//!     definition a RECOVERED stall, so the fatal one is invisible by construction;
//!   * and the actual culprit — found later by `sample` — was the main thread parked in
//!     `semaphore_timedwait_trap` on a synchronous XPC call to the notification daemon. A thread
//!     asleep in the kernel cannot log its own condition.
//!
//! So the app could not report its own worst failure mode, and every future hang would have been
//! equally undiagnosable. This module is the fix, and its one non-negotiable property is that it
//! runs **off the main thread by construction** — a plain OS thread that never touches the UI, so
//! nothing the main thread does can stop it from writing.
//!
//! ── WHAT IT CAN AND CANNOT PROVE ──────────────────────────────────────────────────────────────
//! It observes ONE thing: heartbeats from the webview stopped while this thread kept running. That
//! is strong evidence of a blocked main thread but it is not proof, because on macOS the webview's
//! JS runs in a separate WebContent process — so a dead, crashed, or reloading content process
//! produces identical silence with a perfectly healthy main thread. The log lines are worded for
//! what is actually observed ("no heartbeat for Xms") rather than asserting a diagnosis, and the
//! restates back off exponentially so a permanently dead webview cannot fill the log with confident
//! false claims for the life of the process. That matters: this log is what the next person reads
//! to diagnose a real hang.
//!
//! ── HOW IT TELLS A HANG FROM A SLEEPING MACHINE ───────────────────────────────────────────────
//! This is the discrimination the webview cannot make (see the note above `startJankMonitor` in
//! perfTrace.ts: on this platform `performance.now()` keeps advancing through App Nap and display
//! sleep, so both of the webview's clocks agree in both cases). Here it is direct rather than
//! inferred: a machine suspend freezes THIS thread too, so we watch our own tick.
//!
//!   * our sleep took roughly as long as we asked  → we were running normally. If heartbeats also
//!     stopped, something is genuinely wrong. REPORT.
//!   * our sleep took far longer than we asked     → we were frozen alongside everything else, so
//!     the missing heartbeats mean nothing. Rebaseline and stay quiet.
//!
//! Measured in WALL time (`SystemTime`) on purpose. Whether a monotonic clock counts suspended time
//! is platform- and clock-specific, and that ambiguity is exactly what this has to resolve; the wall
//! clock always advances, so "how much real time passed during our sleep" has one answer.

use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Runtime};

/// How often the watchdog wakes to check. Also the resolution of everything below.
const TICK: Duration = Duration::from_secs(1);

/// How long the main thread may be silent, WHILE VISIBLE, before we report and capture a stack.
///
/// Above the noise floor and below human patience. The webview heartbeats every second, so this is
/// several missed beats — not one late frame. Ordinary severe jank (the `jank stall` tail runs to
/// ~10s) will trip it, which is intended: those are the stalls we most want stacks for.
const HANG_AFTER: Duration = Duration::from_secs(5);

/// The same threshold while the window is HIDDEN. Deliberately an order of magnitude larger, and
/// hidden episodes are also quieter (`info`, not `warn` — see `is_reportable_evidence`) and their
/// stacks go to a separate, rate-limited, small pool — see `dump_target` and `may_capture_hidden`.
///
/// ── WHY THIS NUMBER IS SO MUCH BIGGER, AND WHY IT MOVED TWICE ─────────────────────────────────
/// The first version of this module disarmed completely while hidden. That is wrong in the
/// expensive direction: the 2026-07-29 root cause (`attention.rs`'s notification poll calling
/// `deliveredNotifications` synchronously) runs regardless of visibility, so the app can wedge while
/// backgrounded and the user meets the beachball when they click the dock icon. Disarming made
/// exactly that case unreportable.
///
/// The second version over-corrected to 60s, which is worse still, because **silence from a hidden
/// WKWebView is the DOCUMENTED behaviour, not a symptom**: the frontend heartbeat is a
/// `setInterval`, and a backgrounded webview has its timers throttled hard or stopped outright (see
/// `watchdogHeartbeat.ts`). At 60s every ordinary cmd-tab longer than a minute becomes a reported
/// episode with a multi-megabyte `sample(1)` capture of a perfectly healthy app — and since the dump
/// budget is finite (`MAX_HANG_DUMPS`), those false captures would EVICT the real hang stacks this
/// module exists to preserve. An instrument whose noise deletes its own evidence is worse than no
/// instrument.
///
/// Ten minutes is chosen because it is past every innocent explanation: throttled beats that still
/// trickle in at even one a minute never open an episode at all, and a webview whose timers stopped
/// outright opens exactly one, whose restates then back off. Note also that the case the 60s bar was
/// defending — a freeze that occludes the window on its way down — does NOT actually arrive here: a
/// wedged main thread cannot run the `visibilitychange` handler that would send the `hidden: true`
/// beat, so the last beat we hold still says VISIBLE and the 5s bar applies. That case was already
/// covered; the 60s bar bought nothing and cost the dump budget.
const HIDDEN_HANG_AFTER: Duration = Duration::from_secs(600);

/// First restate delay for an ongoing episode. Doubles each time (see `restate_delay_ms`).
const RESTATE_EVERY: Duration = Duration::from_secs(10);

/// Ceiling on the backoff. A genuinely long hang still leaves a progress trail — the thing that
/// proves it was STILL hung at T+60s — without a dead webview emitting a line forever at 10s.
const RESTATE_MAX: Duration = Duration::from_secs(300);

/// If our own tick overran by this much, we were not running either — a machine suspend, not a
/// hang. Generously above scheduler jitter under heavy load; a real suspend overshoots by seconds
/// to hours, so nothing lands near this boundary in practice.
const SUSPEND_OVERSHOOT: Duration = Duration::from_secs(5);

/// Keep at most this many `sample(1)` dumps on disk. `retention.rs` only reaps `sparkle.log*`
/// entries directly in the log dir and explicitly does not recurse, so nothing else would ever
/// collect these — and each is hundreds of KB to several MB.
const MAX_HANG_DUMPS: usize = 20;

/// Dumps kept for HIDDEN episodes, in their own directory with their own budget.
///
/// Zero was wrong. Hidden episodes were given no capture at all on the argument that an ordinary
/// backgrounding must not evict real stacks — sound as far as it goes, but it zeroes out exactly the
/// case the hidden path exists for. Walk it: the user cmd-tabs away, THEN the main thread wedges.
/// The `hidden: true` beat was delivered before the wedge, so the episode opens hidden; and the
/// wedged thread cannot process a `visible` beat either, so it never reclassifies — not even when
/// the user clicks the dock icon and meets the beachball in the foreground. That is the 2026-07-29
/// root cause reproducing with a log line and no evidence, from a module whose stated
/// non-negotiable is "capture proof".
///
/// A SEPARATE, much smaller budget resolves both concerns at once: a real backgrounded wedge still
/// leaves a stack, and it cannot displace a visible one, because they are never in the same pool.
/// Small because the false-positive rate here is high by construction — a stopped-timer
/// backgrounding opens one episode per cmd-tab — and because these are diagnosed by correlation
/// with a user report, where the most recent couple are what matter.
const MAX_HIDDEN_HANG_DUMPS: usize = 3;

/// Minimum wall time between HIDDEN stack captures. See `may_capture_hidden` for why retention
/// alone is not a bound. Thirty minutes: long enough that ordinary backgrounding costs at most two
/// samples an hour, short enough that a real backgrounded wedge is still caught promptly.
const HIDDEN_CAPTURE_MIN_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Epoch ms of the last hidden capture; `0` = none this launch.
static LAST_HIDDEN_CAPTURE_MS: AtomicU64 = AtomicU64::new(0);

/// Milliseconds since the epoch of the last heartbeat from the webview. `0` = none yet.
static LAST_BEAT_MS: AtomicU64 = AtomicU64::new(0);
/// The webview told us it went hidden. See `watchdog_heartbeat`.
static HIDDEN: AtomicBool = AtomicBool::new(false);
/// Set once the watchdog thread is running, so a second call cannot start a second one.
static STARTED: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The webview says it is alive. Called on a timer from the frontend.
///
/// Deliberately the cheapest possible command: two relaxed atomic stores, no lock, no allocation,
/// no app state. It runs on whatever thread Tauri dispatches commands on and must never be able to
/// contribute to the very stall it is watching for.
///
/// `hidden` lets the tick apply `HIDDEN_HANG_AFTER` instead of `HANG_AFTER`. A backgrounded or
/// occluded WKWebView has its timers throttled hard, so silence there has an innocent explanation
/// that needs room — but only room, not amnesty; see `HIDDEN_HANG_AFTER`. The frontend sends a beat
/// with `hidden: true` on `visibilitychange`, before the throttling lands.
#[tauri::command]
pub fn watchdog_heartbeat(hidden: bool) {
    HIDDEN.store(hidden, Ordering::Relaxed);
    LAST_BEAT_MS.store(now_ms(), Ordering::Relaxed);
}

/// Everything one tick observes. Grouped so the step function below is pure and testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TickInput {
    pub now_ms: u64,
    /// How much longer our own sleep took than we asked — our evidence about whether WE were running.
    pub overshoot_ms: u64,
    /// Epoch ms of the last heartbeat; `0` means none has ever arrived.
    pub last_beat_ms: u64,
    pub hidden: bool,
}

/// The watchdog's carried state between ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WatchdogState {
    /// An episode is open — we have said something and not yet seen recovery.
    reporting: bool,
    /// Epoch ms when the heartbeats actually stopped (NOT when we noticed).
    hang_started_ms: u64,
    /// Epoch ms of our last emitted line for this episode.
    last_report_ms: u64,
    /// How many restates this episode has emitted, driving the backoff.
    restates: u32,
    /// Was the window hidden at ANY point during this episode? Sticky, because the discount belongs
    /// to the whole episode: a wedge that began while backgrounded is a weaker claim even if the
    /// window is visible again by the time we report the recovery.
    hidden: bool,
}

/// What a tick decided to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// Nothing to say.
    Quiet,
    /// We could not have observed anything meaningful; reset the heartbeat baseline to this value.
    ///
    /// Carries the value rather than leaving the loop to reach for `now` itself: the store is the
    /// guard against a phantom hang on every lid-open, and as an implicit convention it was
    /// unreachable from any test. See `apply_baseline`.
    Rebaseline { new_last_beat_ms: u64 },
    /// Heartbeats have stopped for `stalled_ms`. First line of an episode.
    ReportNew { stalled_ms: u64, hidden: bool },
    /// Still silent. `stalled_ms` is measured from when the beats stopped, not from the last line.
    Restate { stalled_ms: u64, hidden: bool },
    /// Beats resumed. `hung_for_ms` is the TRUE total, from the moment they stopped.
    ///
    /// `hidden` is not decoration here — it is the difference between an eight-hour wedge and an
    /// eight-hour cmd-tab, which are otherwise byte-for-byte identical on this line.
    Recovered { hung_for_ms: u64, hidden: bool },
}

/// Is this episode strong enough evidence to shout about?
///
/// Only a VISIBLE episode is. Silence from a hidden webview is documented platform behaviour rather
/// than a symptom (see `HIDDEN_HANG_AFTER`), so a hidden episode is recorded at `info`: a timestamp
/// to correlate against if the user later reports a freeze, not a claim.
///
/// Note this governs the LOG LEVEL only. Hidden episodes still capture a stack — into their own
/// small, separate, rate-limited budget — because the backgrounded wedge is the case the hidden path
/// exists for. See `MAX_HIDDEN_HANG_DUMPS`, `dump_target` and `may_capture_hidden`.
fn is_reportable_evidence(hidden: bool) -> bool {
    !hidden
}

/// Where an episode's stack goes, and how many that pool keeps.
///
/// Two pools, never one. Sharing them is what forces the false choice between "an ordinary cmd-tab
/// can evict a real hang stack" and "a backgrounded wedge gets no stack at all" — the first is why
/// the hidden budget was zeroed, the second is what zeroing it cost.
///
/// Returns the resolved path rather than a subdirectory name so the WIRING is reachable from a test.
/// The previous version returned a bare `&str` the loop had to join itself, which meant the join,
/// the pool choice and the retention count were all only assertable as relations between constants —
/// the exact vacuous shape this repo's own docs condemn. Dropping the join, or passing
/// `MAX_HANG_DUMPS` to both pools, left every test green.
fn dump_target(root: &std::path::Path, hidden: bool) -> (std::path::PathBuf, usize) {
    if hidden {
        (root.join("hidden"), MAX_HIDDEN_HANG_DUMPS)
    } else {
        (root.to_path_buf(), MAX_HANG_DUMPS)
    }
}

/// May we spend a HIDDEN stack capture now?
///
/// The pool size bounds RETAINED FILES, not captures — a distinction that matters because the
/// expensive part is not the file. `sample(1)` attaches to the process and walks every thread for
/// five seconds; keeping only the newest three still pays that cost once per hidden episode, and a
/// backgrounded webview's timers stop outright, so essentially every cmd-tab past
/// `HIDDEN_HANG_AFTER` would trigger one. On battery, on a perfectly healthy app. That is half of
/// the cost this module already argued against in its own words — the design fixed the eviction
/// half and left this one, while the docs read as though it had fixed both.
///
/// A minimum interval bounds it without giving up the case that matters: a genuine backgrounded
/// wedge is a rare event that persists, so it will still be captured; a user who cmd-tabs away
/// repeatedly pays at most one sample per interval. The honest discriminator would be a main-thread
/// ping (a no-op posted from this thread, captured only if it does not return), which would prove a
/// blocked main thread independent of visibility — but that gives this module a live dependency on
/// the very thread it exists to observe from outside, so it is deliberately not built here.
fn may_capture_hidden(last_capture_ms: u64, now_ms: u64, min_interval_ms: u64) -> bool {
    last_capture_ms == 0 || now_ms.saturating_sub(last_capture_ms) >= min_interval_ms
}

/// Apply the one piece of state a tick can write back outside `WatchdogState`.
///
/// Extracted so it is reachable from a test. Deleting the store leaves every lid-open filing a
/// phantom `ReportNew`, and against a `static` inside the loop nothing could catch that.
fn apply_baseline(last_beat: &AtomicU64, effect: &Effect) {
    if let Effect::Rebaseline { new_last_beat_ms } = effect {
        last_beat.store(*new_last_beat_ms, Ordering::Relaxed);
    }
}

/// How long to wait before the Nth restate. Exponential, capped — see `RESTATE_MAX`.
fn restate_delay_ms(restates: u32) -> u64 {
    let base = RESTATE_EVERY.as_millis() as u64;
    let max = RESTATE_MAX.as_millis() as u64;
    base.saturating_mul(1u64 << restates.min(20)).min(max)
}

/// Advance the state machine by one tick. Pure: every side effect is in the returned `Effect`, so
/// the transitions — not just the classification — can be tested.
///
/// Order matters. The suspend check short-circuits first: if the machine slept, every other input
/// this tick is meaningless (of course there were no heartbeats — nothing was running), and treating
/// that as a hang would report a phantom freeze on every lid-open.
pub fn step(state: &mut WatchdogState, input: TickInput) -> Effect {
    if input.overshoot_ms >= SUSPEND_OVERSHOOT.as_millis() as u64 {
        // Clearing the episode is not housekeeping. Leaving it open keeps a `hang_started_ms` from
        // before the sleep, so the next in-threshold tick emits a `Recovered` spanning the whole
        // machine suspend — the phantom multi-hour hang this branch exists to prevent, re-entering
        // through the recovery line instead of the report line.
        *state = WatchdogState::default();
        return Effect::Rebaseline { new_last_beat_ms: input.now_ms };
    }
    // Silence from something that has never spoken is not evidence of anything: the webview has not
    // booted yet, or this build predates the frontend half.
    if input.last_beat_ms == 0 {
        return Effect::Quiet;
    }
    let stalled_ms = input.now_ms.saturating_sub(input.last_beat_ms);
    let threshold =
        if input.hidden { HIDDEN_HANG_AFTER.as_millis() } else { HANG_AFTER.as_millis() } as u64;

    if stalled_ms < threshold {
        // Beats are current. If an episode was open, this is the recovery — and this is the ONLY
        // place the true duration exists, because `stalled_ms` here is the residual staleness of the
        // first beat back (a few hundred ms), NOT the length of the wedge. Reporting `stalled_ms`
        // was the original bug: a 90s beachball logged ~143ms and read as brief.
        if state.reporting {
            let hung_for_ms = input.now_ms.saturating_sub(state.hang_started_ms);
            // The EPISODE's flag, never this tick's. `input.hidden` on the recovery tick describes
            // the world AFTER the block ended, and the most likely way it becomes true is the worst
            // one: a user who gives up on a beachball and cmd-tabs away. Their `visibilitychange`
            // beat is queued behind the wedge and lands as the first beat after it, so ORing it in
            // would close a genuine, stack-captured, warn-level visible wedge at info with
            // "likely backgrounding, not a hang" — the exact conflation this flag exists to prevent,
            // running backwards, on the one line that carries the true duration.
            //
            // `state.hidden` alone loses nothing: an episode that opened hidden already has it set,
            // and a beat that would change visibility mid-episode is itself a beat, so it ends the
            // episode through this same branch rather than changing anything under it.
            let hidden = state.hidden;
            *state = WatchdogState::default();
            return Effect::Recovered { hung_for_ms, hidden };
        }
        return Effect::Quiet;
    }

    if !state.reporting {
        state.reporting = true;
        // When the beats STOPPED, not when we noticed — otherwise every episode under-reports by up
        // to the threshold.
        state.hang_started_ms = input.last_beat_ms;
        state.last_report_ms = input.now_ms;
        state.restates = 0;
        state.hidden = input.hidden;
        return Effect::ReportNew { stalled_ms, hidden: input.hidden };
    }

    if input.now_ms.saturating_sub(state.last_report_ms) >= restate_delay_ms(state.restates) {
        state.last_report_ms = input.now_ms;
        state.restates = state.restates.saturating_add(1);
        return Effect::Restate { stalled_ms, hidden: state.hidden };
    }
    Effect::Quiet
}

/// Start the watchdog. Idempotent.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let hangs_dir = crate::dev_identity::app_log_dir(app).map(|d| d.join("hangs")).ok();
    if let Some(dir) = &hangs_dir {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!(target: "watchdog", "could not create hangs dir, stacks disabled: {e}");
        }
    }
    std::thread::spawn(move || {
        let mut state = WatchdogState::default();
        loop {
            let before = now_ms();
            std::thread::sleep(TICK);
            let after = now_ms();
            // Saturating: a wall clock can step backwards (NTP), and a negative overshoot must read
            // as "no overshoot" rather than wrapping into a huge one that fakes a suspend.
            let overshoot = after.saturating_sub(before).saturating_sub(TICK.as_millis() as u64);
            let input = TickInput {
                now_ms: after,
                overshoot_ms: overshoot,
                last_beat_ms: LAST_BEAT_MS.load(Ordering::Relaxed),
                hidden: HIDDEN.load(Ordering::Relaxed),
            };

            match step(&mut state, input) {
                Effect::Quiet => {}
                effect @ Effect::Rebaseline { .. } => {
                    // Without this the first tick after a wake sees a heartbeat as old as the whole
                    // suspend and reports a hang that never happened.
                    apply_baseline(&LAST_BEAT_MS, &effect);
                }
                Effect::ReportNew { stalled_ms, hidden } => {
                    // Worded for what is OBSERVED, not for a diagnosis we cannot prove: on macOS the
                    // webview runs in its own process, so a dead/reloading content process makes
                    // identical silence with a healthy main thread. Written while the app is still
                    // hung, which is the whole point — everything else could only speak afterwards.
                    if is_reportable_evidence(hidden) {
                        tracing::warn!(
                            target: "watchdog",
                            stalled_ms,
                            hidden,
                            "no heartbeat from the webview — the main thread may be blocked right now; capturing stack"
                        );
                    } else {
                        tracing::info!(
                            target: "watchdog",
                            stalled_ms,
                            hidden,
                            "no heartbeat from a HIDDEN webview — expected while backgrounded (throttled timers), but capturing a stack in case it is a backgrounded wedge"
                        );
                    }
                    // BOTH cases capture — into separate pools, so a cmd-tab can never evict a
                    // visible hang's stack and a backgrounded wedge is never left without evidence.
                    // Hidden captures are additionally rate-limited: the pool bounds files kept, not
                    // the five-second whole-process `sample` run itself. See `may_capture_hidden`.
                    let allowed = if hidden {
                        let ok = may_capture_hidden(
                            LAST_HIDDEN_CAPTURE_MS.load(Ordering::Relaxed),
                            after,
                            HIDDEN_CAPTURE_MIN_INTERVAL.as_millis() as u64,
                        );
                        if ok {
                            LAST_HIDDEN_CAPTURE_MS.store(after, Ordering::Relaxed);
                        }
                        ok
                    } else {
                        true
                    };
                    if allowed {
                        if let Some(dir) = &hangs_dir {
                            let (target, keep) = dump_target(dir, hidden);
                            capture_stack_into(&target, after, keep);
                        }
                    }
                }
                Effect::Restate { stalled_ms, hidden } => {
                    if is_reportable_evidence(hidden) {
                        tracing::warn!(
                            target: "watchdog",
                            stalled_ms,
                            "still no heartbeat from the webview"
                        );
                    } else {
                        tracing::info!(
                            target: "watchdog",
                            stalled_ms,
                            hidden,
                            "still no heartbeat from a hidden webview"
                        );
                    }
                }
                Effect::Recovered { hung_for_ms, hidden } => {
                    // The duration no other instrument can produce: a hang that outlives the user's
                    // patience has no other record anywhere. `hidden` is what separates that from an
                    // equally long cmd-tab, which is otherwise the identical line.
                    if is_reportable_evidence(hidden) {
                        tracing::warn!(
                            target: "watchdog",
                            hung_for_ms,
                            "webview heartbeat resumed"
                        );
                    } else {
                        tracing::info!(
                            target: "watchdog",
                            hung_for_ms,
                            hidden,
                            "webview heartbeat resumed after a hidden gap (likely backgrounding, not a hang)"
                        );
                    }
                }
            }
        }
    });
    tracing::info!(
        target: "watchdog",
        hang_after_ms = HANG_AFTER.as_millis() as u64,
        hidden_hang_after_ms = HIDDEN_HANG_AFTER.as_millis() as u64,
        "main-thread watchdog started (off-thread)"
    );
}

/// Delete all but the newest `keep` dumps in one pool. Best-effort.
///
/// `retention.rs` cannot do this: it only considers entries directly in the log dir with the
/// `sparkle.log` prefix and deliberately does not recurse, so without this the directory grows
/// without bound — multi-MB per capture, on a threshold that ordinary severe jank can trip.
///
/// `keep` is per-pool rather than global precisely so a hidden episode can never evict a visible
/// one; see `dump_pool`.
#[cfg(target_os = "macos")]
fn prune_hang_dumps(dir: &std::path::Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut dumps: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("hang-"))
        .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (t, e.path())))
        .collect();
    if dumps.len() <= keep {
        return;
    }
    dumps.sort_by_key(|(t, _)| *t); // oldest first
    for (_, path) in dumps.iter().take(dumps.len() - keep) {
        let _ = std::fs::remove_file(path);
    }
}

/// Shell out to macOS `sample(1)` against our own pid, so a hang leaves a blocked-thread stack
/// without the user having to know the command or reach a terminal before force-quitting.
///
/// Best-effort by design: `sample` may be unavailable or refused, and a watchdog that panicked or
/// blocked while trying to take a sample would be strictly worse than one that logged the WARN and
/// moved on. The watchdog thread must also stay on its tick to keep restating an ongoing hang, so it
/// never waits here — a short-lived helper thread reaps the child and reports what actually
/// happened. Reporting only the fork/exec succeeding would name a file that may hold nothing.
#[cfg(target_os = "macos")]
fn capture_stack_into(dir: &std::path::Path, stamp_ms: u64, keep: usize) {
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!(target: "watchdog", "could not create dump dir {dir:?}, stack skipped: {e}");
        return;
    }
    prune_hang_dumps(dir, keep);
    let path = dir.join(format!("hang-{stamp_ms}.txt"));
    let pid = std::process::id().to_string();
    // 5 seconds at the default interval: long enough to show whether the blocking frame persists
    // rather than catching one unlucky instant, short enough to land while the hang is still on.
    let spawned = Command::new("/usr/bin/sample")
        .args([&pid, "5", "-file"])
        .arg(&path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        Ok(mut child) => {
            let path = path.clone();
            // Reaped on its own thread: an unwaited child stays a zombie for the life of the app,
            // and the exit status is the only thing that distinguishes a real capture from a file
            // that was never written.
            std::thread::spawn(move || match child.wait() {
                Ok(status) if status.success() => {
                    tracing::warn!(target: "watchdog", path = %path.display(), "captured hang stack")
                }
                Ok(status) => {
                    tracing::warn!(target: "watchdog", ?status, "sample(1) exited non-zero; no stack captured")
                }
                Err(e) => tracing::warn!(target: "watchdog", "could not reap sample(1): {e}"),
            });
        }
        Err(e) => tracing::warn!(target: "watchdog", "could not run sample(1): {e}"),
    }
}

#[cfg(not(target_os = "macos"))]
fn capture_stack_into(_dir: &std::path::Path, _stamp_ms: u64, _keep: usize) {}

#[cfg(test)]
mod tests {
    use super::*;

    const VISIBLE: bool = false;
    /// A tick that ran on schedule — i.e. we were NOT suspended.
    const PUNCTUAL: u64 = 0;
    const HANG_MS: u64 = HANG_AFTER.as_millis() as u64;

    fn input(now_ms: u64, last_beat_ms: u64, hidden: bool) -> TickInput {
        TickInput { now_ms, overshoot_ms: PUNCTUAL, last_beat_ms, hidden }
    }

    /// Drive an episode: beats stop at `beats_stopped_at`, we tick until `until`, and the effects
    /// are returned in order. Exercises the real loop's state threading, not a single call.
    fn run(from: u64, until: u64, beats_stopped_at: u64) -> (WatchdogState, Vec<Effect>) {
        let mut state = WatchdogState::default();
        let mut effects = Vec::new();
        let mut t = from;
        while t <= until {
            effects.push(step(&mut state, input(t, beats_stopped_at, VISIBLE)));
            t += 1_000;
        }
        (state, effects)
    }

    // ── THE HEADLINE NUMBER ────────────────────────────────────────────────────────────────────
    // The recovery line is the whole justification for this module: a hang that outlives the user's
    // patience has no other record anywhere. It reported the WRONG QUANTITY. `Recovered` is only
    // reachable once beats are current again, so the residual staleness there is a few hundred ms —
    // a 90-second beachball logged ~143ms and read as "brief". The duration must be measured from
    // when the beats STOPPED.
    #[test]
    fn recovery_reports_the_whole_wedge_not_the_residual_staleness() {
        let mut state = WatchdogState::default();
        // Beats stopped at t=10_000. We notice at 16_000 and keep ticking to 100_000.
        assert!(matches!(
            step(&mut state, input(16_000, 10_000, VISIBLE)),
            Effect::ReportNew { .. }
        ));
        for t in (17_000..=100_000).step_by(1_000) {
            step(&mut state, input(t, 10_000, VISIBLE));
        }
        // At t=100_500 a beat lands (stamped 100_400): 90.4s after the beats stopped.
        let effect = step(&mut state, input(100_500, 100_400, VISIBLE));
        assert_eq!(
            effect,
            Effect::Recovered { hung_for_ms: 90_500, hidden: false },
            "must measure from when beats stopped (10_000), not the ~100ms residual"
        );
    }

    // The episode must start when the beats stopped, not when we noticed, or every hang
    // under-reports by up to the threshold.
    #[test]
    fn the_episode_starts_when_beats_stopped_not_when_we_noticed() {
        let mut state = WatchdogState::default();
        step(&mut state, input(16_000, 10_000, VISIBLE));
        assert_eq!(state.hang_started_ms, 10_000);
    }

    // ── SUSPEND vs HANG ────────────────────────────────────────────────────────────────────────
    #[test]
    fn our_own_tick_overrunning_means_we_were_suspended_not_that_the_ui_hung() {
        let overshoot = SUSPEND_OVERSHOOT.as_millis() as u64;
        let mut state = WatchdogState::default();
        // Every other input says "hung", and it still must not report.
        let effect = step(
            &mut state,
            TickInput { now_ms: 8 * 3600 * 1000, overshoot_ms: overshoot, last_beat_ms: 1, hidden: false },
        );
        assert_eq!(effect, Effect::Rebaseline { new_last_beat_ms: 8 * 3600 * 1000 });
    }

    // The previous version of the test above asserted `state == default` after a suspend and called
    // that "it must CLEAR any open episode". It was VACUOUS: the state started at default and no
    // episode was ever opened, so it passed identically with the `*state = default()` line deleted.
    //
    // The mutation is not cosmetic. Leaving the episode open across a suspend keeps a stale
    // `hang_started_ms` from BEFORE the sleep, so the next healthy tick emits a `Recovered` spanning
    // the whole machine suspend — the phantom multi-hour hang this module exists to prevent, coming
    // back in through the recovery line instead of the report line. So: open a real episode FIRST.
    #[test]
    fn a_suspend_closes_an_open_episode_so_the_wake_is_not_reported_as_a_recovery() {
        let mut state = WatchdogState::default();
        // A genuine episode is open and has been running for a while.
        assert!(matches!(step(&mut state, input(16_000, 10_000, VISIBLE)), Effect::ReportNew { .. }));
        assert!(state.reporting, "precondition: the episode really is open");

        // Now the lid closes for eight hours.
        let wake = 8 * 3600 * 1000;
        let effect = step(
            &mut state,
            TickInput {
                now_ms: wake,
                overshoot_ms: SUSPEND_OVERSHOOT.as_millis() as u64,
                last_beat_ms: 10_000,
                hidden: false,
            },
        );
        assert_eq!(effect, Effect::Rebaseline { new_last_beat_ms: wake });
        assert_eq!(state, WatchdogState::default(), "the open episode must be cleared, not carried");

        // The assertion that actually bites: the next healthy tick must be silent, NOT a recovery
        // claiming the machine slept for eight hours of hang.
        assert_eq!(
            step(&mut state, input(wake + 1_000, wake + 900, VISIBLE)),
            Effect::Quiet,
            "a wake must not surface as a recovery claiming ~8h of hang"
        );
    }

    // The one piece of state a tick writes outside `WatchdogState`, and the guard against a phantom
    // hang on every lid-open. Against a `static` inside the loop it was unreachable from any test —
    // deleting the store left the suite green and every wake filing a false ReportNew.
    #[test]
    fn a_rebaseline_actually_moves_the_heartbeat_baseline_forward() {
        let last_beat = AtomicU64::new(10_000);
        let wake = 8 * 3600 * 1000;
        apply_baseline(&last_beat, &Effect::Rebaseline { new_last_beat_ms: wake });
        assert_eq!(
            last_beat.load(Ordering::Relaxed),
            wake,
            "without this the first tick after a wake sees a beat as old as the whole suspend"
        );
    }

    #[test]
    fn only_a_rebaseline_touches_the_baseline() {
        let last_beat = AtomicU64::new(10_000);
        for effect in [
            Effect::Quiet,
            Effect::ReportNew { stalled_ms: 5_000, hidden: false },
            Effect::Restate { stalled_ms: 5_000, hidden: false },
            Effect::Recovered { hung_for_ms: 5_000, hidden: false },
        ] {
            apply_baseline(&last_beat, &effect);
        }
        assert_eq!(last_beat.load(Ordering::Relaxed), 10_000, "only a suspend may move the baseline");
    }

    // The visible threshold, at the boundary — where an off-by-one actually shows up.
    #[test]
    fn a_punctual_tick_with_no_heartbeat_is_reported_at_the_threshold() {
        let beat_at = 1_000;
        // One ms short: still quiet.
        assert_eq!(
            step(&mut WatchdogState::default(), input(beat_at + HANG_MS - 1, beat_at, VISIBLE)),
            Effect::Quiet
        );
        // Exactly at it: reported.
        assert_eq!(
            step(&mut WatchdogState::default(), input(beat_at + HANG_MS, beat_at, VISIBLE)),
            Effect::ReportNew { stalled_ms: HANG_MS, hidden: false }
        );
    }

    #[test]
    fn silence_from_a_webview_that_never_beat_is_not_a_hang() {
        let mut state = WatchdogState::default();
        // Boot: no heartbeat has ever arrived, so `last_beat_ms` is 0 and the age would be enormous.
        assert_eq!(step(&mut state, input(u64::MAX, 0, VISIBLE)), Effect::Quiet);
    }

    // ── HIDDEN: A HIGHER BAR, QUIETER, AND NO STACK ────────────────────────────────────────────
    // Silence from a hidden WKWebView is DOCUMENTED behaviour (throttled or stopped timers), not a
    // symptom. So a hidden episode is a timestamp to correlate against, never a claim — and above
    // all it must not spend the finite dump budget, because a false capture evicts a real one.
    #[test]
    fn a_hidden_episode_is_reported_quietly() {
        assert!(!is_reportable_evidence(true), "info, not warn — silence while hidden is expected");
        assert!(is_reportable_evidence(false), "a visible episode still earns a warn");
    }

    // Hidden episodes DO capture a stack — just into their own pool. Giving them none was the
    // wrong end of the trade: the case the hidden path exists for is "already backgrounded, THEN
    // wedges", where the hidden beat landed before the wedge and the wedged thread can never
    // process a visible beat to reclassify — not even when the user clicks the dock icon and meets
    // the beachball. Zeroing the budget left that reproducing with a log line and no evidence.
    // Asserts the RESOLVED TARGET, not a relation between two constants. The previous version of
    // this test compared `hidden_keep > 0` and `visible_sub != hidden_sub` and nothing else, which
    // is the vacuous shape this repo's own docs condemn: dropping the path join, or passing
    // MAX_HANG_DUMPS to both pools, left it green while the hidden pool silently got a 20-file
    // budget in the visible directory.
    #[test]
    fn a_hidden_episode_writes_to_its_own_small_pool_and_a_visible_one_to_the_root() {
        let root = std::path::Path::new("/logs/hangs");
        assert_eq!(dump_target(root, false), (root.to_path_buf(), MAX_HANG_DUMPS));
        assert_eq!(dump_target(root, true), (root.join("hidden"), MAX_HIDDEN_HANG_DUMPS));
        // The property that makes the two-pool design work at all: separate directories, so pruning
        // one can never reach the other.
        assert_ne!(dump_target(root, true).0, dump_target(root, false).0);
        assert!(
            MAX_HIDDEN_HANG_DUMPS > 0,
            "a backgrounded wedge must still leave proof — zeroing this is what the design fixes"
        );
        assert!(
            MAX_HIDDEN_HANG_DUMPS < MAX_HANG_DUMPS,
            "the hidden pool is deliberately small; its false-positive rate is high by construction"
        );
    }

    // The pool bounds FILES KEPT, not captures — and the expensive part is the capture. `sample(1)`
    // attaches and walks every thread for five seconds, so keeping only the newest three still paid
    // that cost on every cmd-tab past the hidden threshold, on a healthy app, on battery.
    #[test]
    fn hidden_captures_are_rate_limited_not_merely_pruned() {
        let interval = HIDDEN_CAPTURE_MIN_INTERVAL.as_millis() as u64;
        assert!(may_capture_hidden(0, 1_000, interval), "the first one is always allowed");
        assert!(
            !may_capture_hidden(1_000, 1_000 + interval - 1, interval),
            "a second cmd-tab inside the interval must not spawn another five-second sample"
        );
        assert!(
            may_capture_hidden(1_000, 1_000 + interval, interval),
            "the boundary is inclusive, so the limiter cannot wedge shut"
        );
        // A backwards clock step must not permanently disable hidden captures.
        assert!(!may_capture_hidden(10_000, 5_000, interval), "saturating: reads as no time passed");
        assert!(may_capture_hidden(10_000, 10_000 + interval, interval), "and recovers after it");
    }

    // `prune_hang_dumps` gained a `keep` parameter and nothing asserted it was honoured — replacing
    // `keep` with MAX_HANG_DUMPS in the body silently handed the hidden pool a 20-file budget.
    #[cfg(target_os = "macos")]
    #[test]
    fn pruning_keeps_the_newest_and_leaves_the_other_pool_alone() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("sparkle-prune-test-{}", std::process::id()));
        let hidden = root.join("hidden");
        std::fs::create_dir_all(&hidden).unwrap();
        // Four dumps, oldest first. A short pause between them so the filesystem records distinct
        // mtimes — "newest" has to be unambiguous or this asserts nothing. No filetime crate: not
        // worth a dependency for one test.
        for name in ["hang-1.txt", "hang-2.txt", "hang-3.txt", "hang-4.txt"] {
            let mut f = std::fs::File::create(root.join(name)).unwrap();
            writeln!(f, "stack").unwrap();
            drop(f);
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::File::create(hidden.join("hang-9.txt")).unwrap();
        // A non-dump file must survive too — this prunes its own artefacts, not the directory.
        std::fs::File::create(root.join("notes.txt")).unwrap();

        prune_hang_dumps(&root, 2);

        let mut left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["hang-3.txt", "hang-4.txt", "notes.txt"], "exactly the two newest");
        assert!(hidden.join("hang-9.txt").exists(), "the other pool must be untouched");
        let _ = std::fs::remove_dir_all(&root);
    }

    // The bar the High finding was about. At 60s every ordinary cmd-tab past a minute filed a hang
    // and burned a multi-MB capture on a healthy app. Ten minutes is past every innocent
    // explanation: throttled beats trickling in at even one a minute never open an episode at all.
    #[test]
    fn an_ordinary_backgrounding_is_not_an_episode() {
        let beat_at = 1_000;
        // Two minutes hidden — a routine cmd-tab, and far past the old 60s bar.
        assert_eq!(step(&mut WatchdogState::default(), input(beat_at + 120_000, beat_at, true)), Effect::Quiet);
        // Five minutes. Still routine.
        assert_eq!(step(&mut WatchdogState::default(), input(beat_at + 300_000, beat_at, true)), Effect::Quiet);
        // A throttled beat arriving even once a minute never accumulates an episode at all.
        let mut state = WatchdogState::default();
        for minute in 1..=30u64 {
            let t = minute * 60_000;
            assert_eq!(
                step(&mut state, input(t, t - 59_000, true)),
                Effect::Quiet,
                "a beat every 60s while hidden must never open an episode"
            );
        }
    }

    #[test]
    fn a_backgrounded_window_still_records_a_very_long_silence() {
        let hidden_ms = HIDDEN_HANG_AFTER.as_millis() as u64;
        let mut state = WatchdogState::default();
        assert_eq!(step(&mut state, input(hidden_ms - 1, 1, true)), Effect::Quiet);
        assert_eq!(
            step(&mut state, input(hidden_ms + 1, 1, true)),
            Effect::ReportNew { stalled_ms: hidden_ms, hidden: true }
        );
    }

    // The hidden bar must be genuinely higher, or occlusion floods the log with phantom hangs.
    #[test]
    fn hidden_tolerates_what_visible_would_report() {
        let beat_at = 1_000;
        let now = beat_at + HANG_MS + 1_000; // comfortably past the visible bar
        assert_eq!(
            step(&mut WatchdogState::default(), input(now, beat_at, VISIBLE)),
            Effect::ReportNew { stalled_ms: HANG_MS + 1_000, hidden: false }
        );
        assert_eq!(step(&mut WatchdogState::default(), input(now, beat_at, true)), Effect::Quiet);
    }

    // ── THE HIDDEN DISCOUNT IS STICKY ──────────────────────────────────────────────────────────
    // `Recovered` is the line this whole rewrite made authoritative, and it was the ONE effect that
    // did not carry `hidden`. A window backgrounded for eight hours with paused timers recovered as
    // `hung_for_ms=28800000` — byte-for-byte how a genuine eight-hour wedge reads. Fixing the number
    // being too small had introduced a path where it is spuriously enormous, with the discount
    // stripped on exactly the line that matters most.
    #[test]
    fn recovery_carries_the_hidden_discount_so_a_long_cmd_tab_is_not_a_long_wedge() {
        let hidden_ms = HIDDEN_HANG_AFTER.as_millis() as u64;
        let mut state = WatchdogState::default();
        assert!(matches!(
            step(&mut state, input(hidden_ms + 1, 1, true)),
            Effect::ReportNew { hidden: true, .. }
        ));
        let wake = 8 * 3600 * 1000;
        assert_eq!(
            step(&mut state, input(wake, wake - 100, true)),
            Effect::Recovered { hung_for_ms: wake - 1, hidden: true },
            "an 8h backgrounding must not read as an 8h wedge"
        );
    }

    // Sticky, not sampled at the end: an episode that BEGAN hidden is a weaker claim even if the
    // window is visible again by the time we notice recovery. Sampling `input.hidden` at the
    // recovery tick would report `hidden: false` for precisely the cmd-tab-then-come-back case,
    // which is the common one.
    #[test]
    fn the_discount_survives_the_window_becoming_visible_again() {
        let hidden_ms = HIDDEN_HANG_AFTER.as_millis() as u64;
        let mut state = WatchdogState::default();
        step(&mut state, input(hidden_ms + 1, 1, true));
        // The user comes back: the window is visible on the tick that sees the beats resume.
        let effect = step(&mut state, input(hidden_ms + 5_000, hidden_ms + 4_900, VISIBLE));
        assert_eq!(
            effect,
            Effect::Recovered { hung_for_ms: hidden_ms + 4_999, hidden: true },
            "the episode began hidden, so its recovery keeps the discount"
        );
    }

    #[test]
    fn a_restate_carries_the_discount_too() {
        let hidden_ms = HIDDEN_HANG_AFTER.as_millis() as u64;
        let mut state = WatchdogState::default();
        step(&mut state, input(hidden_ms + 1, 1, true));
        let mut saw_restate = false;
        for t in (hidden_ms + 2_000..hidden_ms + 60_000).step_by(1_000) {
            if let Effect::Restate { hidden, .. } = step(&mut state, input(t, 1, true)) {
                assert!(hidden, "a hidden episode's restates must stay discounted");
                saw_restate = true;
            }
        }
        assert!(saw_restate, "the loop must actually produce a restate for this to prove anything");
    }

    // The converse, so the discount cannot be applied everywhere and pass vacuously.
    #[test]
    fn a_visible_episode_is_never_discounted() {
        let mut state = WatchdogState::default();
        step(&mut state, input(16_000, 10_000, VISIBLE));
        assert_eq!(
            step(&mut state, input(100_500, 100_400, VISIBLE)),
            Effect::Recovered { hung_for_ms: 90_500, hidden: false }
        );
    }

    // THE DIRECTION THAT WAS UNPINNED, and the reason the recovery tick's own `hidden` must not be
    // ORed in. The most likely way a user reacts to a beachball is to cmd-tab away — macOS lets
    // them — and their `visibilitychange` beat is queued behind the wedge, so it lands as the FIRST
    // beat after it. Sampling `input.hidden` there closes a genuine 90-second visible wedge, whose
    // own ReportNew was a warn with a captured stack, at info with "likely backgrounding, not a
    // hang". The episode's own log would contradict itself, and anyone triaging by warn would never
    // see the duration — which is the one number no other instrument in the app can produce.
    #[test]
    fn a_visible_wedge_the_user_cmd_tabbed_away_from_is_still_a_wedge() {
        let mut state = WatchdogState::default();
        assert_eq!(
            step(&mut state, input(16_000, 10_000, VISIBLE)),
            Effect::ReportNew { stalled_ms: 6_000, hidden: false },
            "the episode opens visible, warn-level, with a stack"
        );
        for t in (17_000..=100_000).step_by(1_000) {
            step(&mut state, input(t, 10_000, VISIBLE));
        }
        // The queued `hidden: true` beat lands as the first beat after the block clears.
        assert_eq!(
            step(&mut state, input(100_500, 100_400, true)),
            Effect::Recovered { hung_for_ms: 90_500, hidden: false },
            "a visible episode must not be relabelled by where the window ended up"
        );
    }

    // ── RESTATE BACKOFF ────────────────────────────────────────────────────────────────────────
    // A dead WebContent process produces permanent silence with a healthy main thread. Without
    // backoff the watchdog restates every 10s for the life of the app — an unbounded stream of
    // confident false diagnoses in the log someone will later read to diagnose a real hang.
    #[test]
    fn restates_back_off_instead_of_repeating_forever() {
        let (_, effects) = run(0, 600_000, 1);
        let restates = effects.iter().filter(|e| matches!(e, Effect::Restate { .. })).count();
        // Linear 10s restates over 10 minutes would be ~60. Exponential backoff is ~6.
        assert!(restates <= 10, "expected backoff, got {restates} restates in 10 minutes");
        assert!(restates >= 3, "must still leave a progress trail, got {restates}");
    }

    #[test]
    fn the_backoff_doubles_and_then_holds_at_the_ceiling() {
        assert_eq!(restate_delay_ms(0), 10_000);
        assert_eq!(restate_delay_ms(1), 20_000);
        assert_eq!(restate_delay_ms(2), 40_000);
        assert_eq!(restate_delay_ms(99), RESTATE_MAX.as_millis() as u64, "and never overflows");
    }

    // Exactly one ReportNew per episode, however long it runs — the stack capture hangs off it.
    #[test]
    fn an_episode_reports_once_and_captures_one_stack() {
        let (_, effects) = run(0, 600_000, 1);
        let opens = effects.iter().filter(|e| matches!(e, Effect::ReportNew { .. })).count();
        assert_eq!(opens, 1);
    }

    // A healthy tick with no episode open is not a recovery, or every ordinary second logs one.
    #[test]
    fn recovery_is_reported_only_when_an_episode_was_open() {
        let mut state = WatchdogState::default();
        assert_eq!(step(&mut state, input(1_000, 1_000, VISIBLE)), Effect::Quiet);
    }

    // After recovery the machine must be fully rearmed, or a second hang in one session is missed.
    #[test]
    fn a_second_hang_after_a_recovery_is_still_reported() {
        let mut state = WatchdogState::default();
        step(&mut state, input(16_000, 10_000, VISIBLE));
        assert!(matches!(
            step(&mut state, input(20_000, 20_000, VISIBLE)),
            Effect::Recovered { .. }
        ));
        assert_eq!(state, WatchdogState::default(), "recovery must fully reset the episode");
        assert!(matches!(
            step(&mut state, input(40_000, 30_000, VISIBLE)),
            Effect::ReportNew { .. }
        ));
    }
}

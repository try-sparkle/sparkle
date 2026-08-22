//! In-flight drag/drop tracking, so a file drag that BLOCKS names its own phase and window.
//!
//! ## The blind spot this exists to close (bead `sparkle-bxidpw`)
//!
//! A file drag over a Sparkle window is delivered to `lib.rs`'s `on_window_event` closure, which
//! Tauri runs SYNCHRONOUSLY ON THE APPKIT MAIN THREAD. Whatever that closure does, the UI is
//! stopped for the duration. Until this module existed, a stall there was invisible to every
//! instrument the app has:
//!
//!   - `watchdog.rs` only reports after 5 SECONDS of heartbeat silence, so a 1-4 second stall —
//!     long enough that a user calls it a freeze and files a bug — produced not one line.
//!   - the renderer's jank monitor measures RENDERER frame time and cannot see host main-thread
//!     time at all. The webview is idle while the host main thread is wedged; that is exactly what
//!     the `sparkle-epc1zh` capture showed (458/459 renderer samples in `mach_msg`).
//!
//! So a whole class of user-visible freeze was unrecorded, and the founder's report ("a hang for 30
//! seconds or more when I tried to drop a file into a terminal window") arrived with no capture at
//! all. This module makes the gesture name itself.
//!
//! ## Why this is a watcher thread and not a stopwatch
//!
//! Deliberately the same shape as `pty_write_watch.rs`, for the same reason spelled out there: the
//! obvious instrument — time the call, warn if it took too long — is precisely the one that CANNOT
//! see the worst case. A `canonicalize(2)` against a dataless iCloud file or a stalled NFS mount
//! may not return at all, and a stopwatch has no "after" to log from. It would emit nothing on the
//! only occasions that matter while reporting itself as working, which is the vacuous-instrument
//! shape this repo's testing guidance is about.
//!
//! So the report comes from a SECOND thread that looks at spans which are still OUTSTANDING. A span
//! that completes slowly is also reported, on drop, but that is the cheap half.
//!
//! ## What it does NOT log
//!
//! NEVER a path, and never a path fragment. `attachments.rs`'s own drop log records why: this log
//! ships with support tickets. Counts and durations only, plus the window LABEL (`main`, `helper`,
//! `capture` — a fixed vocabulary, already logged beside the existing "Drop reached Rust" line) and
//! the drag phase name.
//!
//! ## Why a sibling module rather than a generic shared with `pty_write_watch`
//!
//! The two carry different facts (session + byte count vs window + phase + path count) and emit
//! different messages, so the shared part is the ~30 lines of `due`/`sweep` policy. `pty_write_watch`
//! is live, covered, and named in a shipped bead; rewriting it into a generic to save that much
//! would put a freeze fix's blast radius across the PTY hang instrumentation too. The backoff
//! discipline is reproduced exactly, and both modules' tests pin it independently.
//!
//! ## Cost when nothing is wrong
//!
//! The watcher thread starts lazily on the first registration and parks on a condvar whenever the
//! registry is empty, so an app that never sees a drag pays nothing. Registration is one `HashMap`
//! insert under a short-lived lock — no filesystem, no allocation beyond the two small strings.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a drag span may be outstanding before it is worth a line in the log.
///
/// Deliberately the same 250ms as `pty_write_watch::SLOW_WRITE_MS`, and for the same reasoning: far
/// above any healthy drag delivery (the main-thread half is now lock-only bookkeeping, measured in
/// microseconds) and far below the point at which a human notices a frozen UI. It is a DIAGNOSTIC
/// threshold, not a timeout — nothing is cancelled or failed when it is crossed.
pub const SLOW_DRAG_MS: u64 = 250;

/// How often the watcher re-reports a span that is STILL outstanding.
///
/// Same discipline as `pty_write_watch::REWARN_BACKOFF_MS`: a 30-second wedge should not produce
/// hundreds of identical lines, and it must not produce exactly one either — the escalating elapsed
/// time is the evidence that separates a momentary stall from a wedge.
const REWARN_BACKOFF_MS: u64 = 500;

/// WHICH THREAD the span is on. This is the single most important field in the log line, because
/// the two have completely different severity:
///
///   - `Dispatch` is the AppKit MAIN THREAD, inside `lib.rs`'s `on_window_event`. Every millisecond
///     here is a millisecond the whole UI is stopped. This is the one that was the bug.
///   - `Resolve` is the background path-resolution worker. A slow span here delays a subsequent
///     `load_attachment` (which waits for it) but freezes NOTHING, which is the entire point of
///     moving the work there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Running on the AppKit main thread — the UI is stopped for this whole span.
    Dispatch,
    /// Running on the background drag-path resolution worker. Nothing is frozen.
    Resolve,
}

impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Stage::Dispatch => "main-thread-dispatch",
            Stage::Resolve => "background-resolve",
        }
    }
}

/// One drag span that has been registered and not yet finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The Tauri window label (`main`, `helper`, `capture`). A fixed vocabulary, not user data.
    pub window: String,
    /// The drag phase: `enter` / `over` / `drop` / `leave` / `teardown` / `other`. Never a path.
    pub phase: &'static str,
    /// How many paths this span carries. A COUNT — never the paths themselves.
    pub paths: usize,
    /// Process-monotonic milliseconds at registration.
    pub started_ms: u64,
    /// When the watcher last reported this entry, or `None` if it never has.
    pub last_warn_ms: Option<u64>,
    pub stage: Stage,
}

/// A span the watcher has decided to report, with the elapsed time to report it at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overdue {
    pub window: String,
    pub phase: &'static str,
    pub paths: usize,
    pub elapsed_ms: u64,
    pub stage: Stage,
}

/// Should this entry be reported at `now_ms`?
///
/// True on the first crossing of `threshold_ms`, then again once per `backoff_ms` for as long as it
/// stays outstanding. Pure, so the escalation policy is testable without sleeping.
fn due(entry: &Entry, now_ms: u64, threshold_ms: u64, backoff_ms: u64) -> bool {
    let elapsed = now_ms.saturating_sub(entry.started_ms);
    if elapsed < threshold_ms {
        return false;
    }
    match entry.last_warn_ms {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= backoff_ms,
    }
}

/// Every entry due for a report at `now_ms`, stamping each one as reported.
///
/// Takes `&mut` and updates `last_warn_ms` in the same pass, because "decide" and "record that we
/// decided" cannot be separated without reintroducing the duplicate-report bug the backoff exists to
/// prevent. Sorted with `Dispatch` (main thread, UI stopped) ahead of `Resolve` (background, nothing
/// stopped) and longest-blocked first within each, so the line a human reads first is the one that
/// is actually freezing the app.
fn sweep(
    entries: &mut HashMap<u64, Entry>,
    now_ms: u64,
    threshold_ms: u64,
    backoff_ms: u64,
) -> Vec<Overdue> {
    let mut out = Vec::new();
    for entry in entries.values_mut() {
        if !due(entry, now_ms, threshold_ms, backoff_ms) {
            continue;
        }
        entry.last_warn_ms = Some(now_ms);
        out.push(Overdue {
            window: entry.window.clone(),
            phase: entry.phase,
            paths: entry.paths,
            elapsed_ms: now_ms.saturating_sub(entry.started_ms),
            stage: entry.stage,
        });
    }
    out.sort_by(|a, b| {
        stage_rank(a.stage)
            .cmp(&stage_rank(b.stage))
            .then_with(|| b.elapsed_ms.cmp(&a.elapsed_ms))
            .then_with(|| a.window.cmp(&b.window))
            .then_with(|| a.phase.cmp(b.phase))
    });
    out
}

/// `Dispatch` before `Resolve`: a main-thread stall outranks a background one however long the
/// background one has been running, because only one of them is freezing the UI.
fn stage_rank(stage: Stage) -> u8 {
    match stage {
        Stage::Dispatch => 0,
        Stage::Resolve => 1,
    }
}

/// Process-monotonic milliseconds. `Instant`, not `SystemTime`: a clock step during a freeze must
/// not be able to turn a 30-second wedge into a negative duration.
fn mono_ms() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The live registry, plus the condvar the watcher parks on while it is empty.
struct Registry {
    entries: Mutex<HashMap<u64, Entry>>,
    /// Signalled when an entry is added, to unpark a watcher sleeping on an empty registry.
    /// Notified on registration only — a removal can never create work for the watcher.
    wake: Condvar,
}

fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| Registry { entries: Mutex::new(HashMap::new()), wake: Condvar::new() })
}

static NEXT_SEQ: AtomicU64 = AtomicU64::new(1);

/// A registered in-flight drag span. Deregisters on drop, reporting the span if it was slow.
///
/// RAII rather than an explicit `end()` so an early return or a `?` cannot leak an entry — a leaked
/// entry would be reported as a permanently blocked drag forever, which is worse than no instrument.
pub struct Guard {
    seq: u64,
    started_ms: u64,
    window: String,
    phase: &'static str,
    paths: usize,
    stage: Stage,
}

impl Drop for Guard {
    fn drop(&mut self) {
        let previously_reported = {
            let mut entries = registry().entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.remove(&self.seq).and_then(|e| e.last_warn_ms).is_some()
        };
        let elapsed = mono_ms().saturating_sub(self.started_ms);
        // Report a slow COMPLETION when it crossed the threshold — whether or not the watcher
        // already reported it outstanding. When the watcher did report it, this line is what closes
        // the episode; without it a log shows a drag starting to block and never says whether it
        // recovered, which is exactly the ambiguity that made the PTY hang captures unusable.
        if elapsed >= SLOW_DRAG_MS {
            match self.stage {
                Stage::Dispatch => tracing::warn!(
                    target: "drag",
                    window = %self.window,
                    phase = self.phase,
                    paths = self.paths,
                    elapsed_ms = elapsed,
                    stage = self.stage.as_str(),
                    previously_reported,
                    "slow drag dispatch COMPLETED — the UI main thread was stopped this long by one drag event"
                ),
                Stage::Resolve => tracing::warn!(
                    target: "drag",
                    window = %self.window,
                    phase = self.phase,
                    paths = self.paths,
                    elapsed_ms = elapsed,
                    stage = self.stage.as_str(),
                    previously_reported,
                    "slow drag path resolution COMPLETED — a read of these paths waited this long (UI was NOT blocked)"
                ),
            }
        }
    }
}

/// Register a drag span about to be attempted on `window` for drag phase `phase`, carrying `paths`
/// paths. Starts the watcher thread on first use; the returned guard must be held across the span.
pub fn begin(stage: Stage, window: &str, phase: &'static str, paths: usize) -> Guard {
    let seq = NEXT_SEQ.fetch_add(1, Ordering::Relaxed);
    let started_ms = mono_ms();
    let reg = registry();
    {
        let mut entries = reg.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.insert(
            seq,
            Entry {
                window: window.to_string(),
                phase,
                paths,
                started_ms,
                last_warn_ms: None,
                stage,
            },
        );
    }
    reg.wake.notify_all();
    ensure_watcher();
    Guard { seq, started_ms, window: window.to_string(), phase, paths, stage }
}

/// A snapshot of every drag span currently in flight, main-thread stalls first.
///
/// Cloning under the lock is deliberate: a caller is very likely running while the main thread is
/// wedged, and it must not hold this lock across formatting.
///
/// `allow(dead_code)` because today only this module's own tests read it. It is the accessor the
/// hang-capture path in `watchdog.rs` wants — annotating a drag span onto a capture is the obvious
/// next use — but that file is deliberately out of scope for this change, so the accessor is kept
/// and the wiring is not invented here. Same role `pty_write_watch::in_flight` plays for PTY writes.
#[allow(dead_code)]
pub fn in_flight() -> Vec<Overdue> {
    let now = mono_ms();
    let entries = registry().entries.lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<Overdue> = entries
        .values()
        .map(|e| Overdue {
            window: e.window.clone(),
            phase: e.phase,
            paths: e.paths,
            elapsed_ms: now.saturating_sub(e.started_ms),
            stage: e.stage,
        })
        .collect();
    out.sort_by(|a, b| {
        stage_rank(a.stage)
            .cmp(&stage_rank(b.stage))
            .then_with(|| b.elapsed_ms.cmp(&a.elapsed_ms))
            .then_with(|| a.window.cmp(&b.window))
            .then_with(|| a.phase.cmp(b.phase))
    });
    out
}

/// Start the watcher thread once.
fn ensure_watcher() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        // A named thread, so it is identifiable in the very stack captures it exists to annotate.
        let _ = std::thread::Builder::new()
            .name("drag-watch".to_string())
            .spawn(watch_loop);
    });
}

fn watch_loop() {
    let reg = registry();
    loop {
        let overdue = {
            let mut entries = reg.entries.lock().unwrap_or_else(|e| e.into_inner());
            // Park while there is nothing to watch. `wait` releases the lock, so registration is
            // never blocked by a sleeping watcher.
            while entries.is_empty() {
                let (guard, _) = reg
                    .wake
                    .wait_timeout(entries, Duration::from_secs(60))
                    .unwrap_or_else(|e| e.into_inner());
                entries = guard;
            }
            sweep(&mut entries, mono_ms(), SLOW_DRAG_MS, REWARN_BACKOFF_MS)
        };
        for o in overdue {
            match o.stage {
                Stage::Dispatch => tracing::warn!(
                    target: "drag",
                    window = %o.window,
                    phase = o.phase,
                    paths = o.paths,
                    elapsed_ms = o.elapsed_ms,
                    stage = o.stage.as_str(),
                    "drag dispatch STILL ON THE MAIN THREAD — the UI has been frozen this long by one drag event"
                ),
                Stage::Resolve => tracing::warn!(
                    target: "drag",
                    window = %o.window,
                    phase = o.phase,
                    paths = o.paths,
                    elapsed_ms = o.elapsed_ms,
                    stage = o.stage.as_str(),
                    "drag path resolution STILL OUTSTANDING — a read of these paths is waiting (UI is NOT blocked)"
                ),
            }
        }
        std::thread::sleep(Duration::from_millis(SLOW_DRAG_MS / 2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(started_ms: u64, last_warn_ms: Option<u64>) -> Entry {
        Entry {
            window: "main".to_string(),
            phase: "drop",
            paths: 3,
            started_ms,
            last_warn_ms,
            stage: Stage::Dispatch,
        }
    }

    /// The healthy case: an ordinary drag delivery is lock-only bookkeeping, microseconds long, and
    /// none of them may produce a line. An instrument that reports every drag is an instrument
    /// whose output nobody reads.
    #[test]
    fn a_fast_drag_is_never_reported() {
        assert!(!due(&entry(0, None), 0, SLOW_DRAG_MS, REWARN_BACKOFF_MS));
        assert!(!due(&entry(0, None), 1, SLOW_DRAG_MS, REWARN_BACKOFF_MS));
        assert!(!due(&entry(0, None), SLOW_DRAG_MS - 1, SLOW_DRAG_MS, REWARN_BACKOFF_MS));
    }

    #[test]
    fn crossing_the_threshold_reports_once() {
        assert!(due(&entry(0, None), SLOW_DRAG_MS, SLOW_DRAG_MS, REWARN_BACKOFF_MS));
        // Already reported at 250; not due again until the backoff elapses.
        assert!(!due(&entry(0, Some(250)), 260, SLOW_DRAG_MS, REWARN_BACKOFF_MS));
        assert!(!due(&entry(0, Some(250)), 749, SLOW_DRAG_MS, REWARN_BACKOFF_MS));
        assert!(due(&entry(0, Some(250)), 750, SLOW_DRAG_MS, REWARN_BACKOFF_MS));
    }

    /// THE BLIND SPOT, as a test. The founder's report was "a hang for 30 seconds or more when I
    /// tried to drop a file into a terminal window", and the app logged NOTHING: `watchdog.rs` only
    /// fires at 5s of heartbeat silence and the renderer jank monitor cannot see host main-thread
    /// time at all.
    ///
    /// Asserts on the reports produced across a simulated 30-second freeze, not on `due` in
    /// isolation: the property is that the window and phase are named REPEATEDLY with a growing
    /// elapsed time — a stopwatch on the completed call would emit nothing at all for a
    /// `canonicalize` that never returns.
    #[test]
    fn a_thirty_second_drop_freeze_reports_repeatedly_and_names_the_window() {
        let mut entries = HashMap::new();
        entries.insert(1u64, entry(0, None));

        let mut reports = Vec::new();
        // Tick at the watcher's real cadence across the reported freeze duration.
        let mut now = 0u64;
        while now <= 30_000 {
            reports.extend(sweep(&mut entries, now, SLOW_DRAG_MS, REWARN_BACKOFF_MS));
            now += SLOW_DRAG_MS / 2;
        }

        assert!(
            reports.len() > 50,
            "a 30s freeze must keep reporting, got {} report(s)",
            reports.len()
        );
        assert!(
            reports.iter().all(|r| r.window == "main" && r.phase == "drop"),
            "every report must name the window and the drag phase — that is the whole point"
        );
        assert!(
            reports.iter().all(|r| r.stage == Stage::Dispatch),
            "and must say it is the MAIN THREAD, which is what makes it a freeze rather than a delay"
        );
        assert_eq!(reports[0].paths, 3, "carries the path COUNT (never the paths)");
        // The elapsed time must GROW, so a reader can tell a momentary stall from a wedge.
        assert!(reports[0].elapsed_ms < 1_000);
        // Within one backoff of the full 30s — reports land every `REWARN_BACKOFF_MS`, so the last
        // one before the freeze ends is at most that far short of it.
        assert!(
            reports.last().unwrap().elapsed_ms > 30_000 - REWARN_BACKOFF_MS,
            "the last report must show the true age of the freeze, got {}ms",
            reports.last().unwrap().elapsed_ms
        );
        // Strictly increasing: a repeated identical elapsed would mean the clock, not the drag, was
        // being reported.
        assert!(reports.windows(2).all(|w| w[1].elapsed_ms > w[0].elapsed_ms));
    }

    /// A main-thread stall and a background resolution are wildly different severities — one is a
    /// frozen app, the other is a delayed attachment — so the log must say which, and must put the
    /// frozen one first even when the background span is older.
    #[test]
    fn a_main_thread_stall_outranks_an_older_background_one() {
        let mut entries = HashMap::new();
        // The BACKGROUND span is much older, and must still sort second.
        entries.insert(1u64, Entry { stage: Stage::Resolve, phase: "enter", ..entry(0, None) });
        entries.insert(2u64, Entry { stage: Stage::Dispatch, ..entry(9_000, None) });

        let reports = sweep(&mut entries, 10_000, SLOW_DRAG_MS, REWARN_BACKOFF_MS);
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0].stage, Stage::Dispatch, "the frozen UI is the first line a human reads");
        assert_eq!(reports[0].elapsed_ms, 1_000);
        assert_eq!(reports[1].stage, Stage::Resolve);
        assert_eq!(reports[1].elapsed_ms, 10_000);
    }

    /// Two stalled windows must both be named; reporting only the worst would hide a second frozen
    /// window behind the first.
    #[test]
    fn every_stalled_window_is_named_not_just_the_worst() {
        let mut entries = HashMap::new();
        entries.insert(1u64, Entry { window: "main".to_string(), ..entry(0, None) });
        entries.insert(2u64, Entry { window: "helper".to_string(), ..entry(0, None) });

        let reports = sweep(&mut entries, 1_000, SLOW_DRAG_MS, REWARN_BACKOFF_MS);
        let mut windows: Vec<&str> = reports.iter().map(|r| r.window.as_str()).collect();
        windows.sort();
        assert_eq!(windows, vec!["helper", "main"]);
    }

    /// `sweep` must record that it reported, or the backoff cannot hold and a wedge produces a line
    /// every tick.
    #[test]
    fn sweep_stamps_what_it_reported() {
        let mut entries = HashMap::new();
        entries.insert(1u64, entry(0, None));

        assert_eq!(sweep(&mut entries, 300, SLOW_DRAG_MS, REWARN_BACKOFF_MS).len(), 1);
        assert_eq!(entries[&1].last_warn_ms, Some(300));
        // Immediately again: nothing, because the stamp is in place.
        assert!(sweep(&mut entries, 310, SLOW_DRAG_MS, REWARN_BACKOFF_MS).is_empty());
    }

    /// The registry is a process global shared with the live app, so this drives the real
    /// `begin`/`Guard` path end to end. Uses a unique window label so it cannot collide with
    /// another test's entries.
    #[test]
    fn begin_registers_and_the_guard_deregisters() {
        let window = "test-window-begin-registers";
        assert!(!in_flight().iter().any(|e| e.window == window));

        let guard = begin(Stage::Dispatch, window, "drop", 7);
        let seen = in_flight();
        let mine = seen.iter().find(|e| e.window == window).expect("registered while in flight");
        assert_eq!(mine.paths, 7);
        assert_eq!(mine.phase, "drop");
        assert_eq!(mine.stage, Stage::Dispatch);

        drop(guard);
        assert!(
            !in_flight().iter().any(|e| e.window == window),
            "the guard must deregister on drop — a leaked entry reads as a permanent freeze"
        );
    }
}

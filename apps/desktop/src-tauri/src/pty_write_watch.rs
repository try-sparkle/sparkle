//! In-flight `pty_write` tracking, so a PTY write that BLOCKS names its own session.
//!
//! A `write(2)` to a PTY master blocks when the slave's input queue is full and the child has
//! stopped draining stdin. Twice now that has frozen the whole app — bead `sparkle-epc1zh`, whose
//! first half moves the write off the AppKit main thread and whose second half is this module,
//! because NEITHER capture could name the session, the fd, or the child.
//!
//! ## Why this is a watcher thread and not a stopwatch
//!
//! The obvious instrument — time the write, warn if it took too long — is precisely the one that
//! CANNOT see this bug. Both measured occurrences were writes that **never returned**: the app was
//! still inside `write_all` when the watchdog captured it (6715 of 6715 main-thread samples in
//! `UnixMasterWriter::write_all`). A stopwatch has no "after" to log from, so it would have
//! emitted nothing on both occasions while reporting itself as working — the vacuous-instrument
//! shape this repo's testing guidance is about.
//!
//! So the report comes from a SECOND thread that looks at writes which are still OUTSTANDING. A
//! write that completes slowly is also reported, on drop, but that is the cheap half; the
//! outstanding report is the one that would have named the session in the two real incidents.
//!
//! ## What it does NOT claim
//!
//! Nothing here diagnoses *why* a child stopped reading stdin. A full slave input queue is the
//! standard mechanism and it fits the evidence, but no capture has ever identified the session or
//! the child, so this module reports observable facts only — which session, how many bytes, which
//! phase, how long so far — and infers no cause.
//!
//! ## Cost when nothing is wrong
//!
//! The watcher thread is started lazily on the first registration and then parks on a condvar
//! whenever the registry is empty, so an idle app pays nothing. Registration itself is one
//! `HashMap` insert under a short-lived lock, on a path that already takes the session's writer
//! mutex.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a write may be outstanding before it is worth a line in the log.
///
/// 250ms is far above any healthy write — in the 99-second window around the measured hang, all 45
/// other `pty_write`s returned in under 0.1ms, a margin of more than 2500x — and far below the
/// point at which a human notices a frozen UI. It is a diagnostic threshold, not a timeout:
/// nothing is cancelled or failed when it is crossed.
pub const SLOW_WRITE_MS: u64 = 250;

/// How often the watcher re-reports a write that is STILL blocked.
///
/// A hang measured at 73.5 seconds should not produce 294 identical lines, and it should not
/// produce exactly one either — the escalating elapsed time is the evidence that distinguishes a
/// momentary stall from a wedge. Doubling from the first report gives ~9 lines across 73 seconds.
const REWARN_BACKOFF_MS: u64 = 500;

/// The phase a registered write is in. Both can block, for different reasons, and telling them
/// apart is most of the diagnostic value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Waiting for this session's writer mutex — i.e. blocked behind ANOTHER write to the same
    /// session that is itself stuck. Distinct from `Writing`: this one is a queue, and the write
    /// at the head of it is the one to look at.
    Queued,
    /// Inside `write_all` on the PTY master. This is the phase both measured hangs were in.
    Writing,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Queued => "queued",
            Phase::Writing => "writing",
        }
    }
}

/// One write that has been registered and not yet finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The PTY session id — a uuid the app mints per terminal. Not a secret, and it is the single
    /// fact both hang captures lacked.
    pub id: String,
    /// How many bytes this write is carrying.
    pub bytes: usize,
    /// Process-monotonic milliseconds at registration.
    pub started_ms: u64,
    /// When the watcher last reported this entry, or `None` if it never has.
    pub last_warn_ms: Option<u64>,
    pub phase: Phase,
}

/// A write the watcher has decided to report, with the elapsed time to report it at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overdue {
    pub id: String,
    pub bytes: usize,
    pub elapsed_ms: u64,
    pub phase: Phase,
}

/// Should this entry be reported at `now_ms`?
///
/// True on the first crossing of `threshold_ms`, then again once per `backoff_ms` for as long as
/// it stays outstanding. Pure, so the escalation policy is testable without sleeping.
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
/// decided" cannot be separated without reintroducing the duplicate-report bug the backoff exists
/// to prevent. Sorted by elapsed descending, so the longest-blocked write — the one at the head of
/// any queue behind it — is the first line a human reads.
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
            id: entry.id.clone(),
            bytes: entry.bytes,
            elapsed_ms: now_ms.saturating_sub(entry.started_ms),
            phase: entry.phase,
        });
    }
    out.sort_by(|a, b| b.elapsed_ms.cmp(&a.elapsed_ms).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Process-monotonic milliseconds. `Instant`, not `SystemTime`: a clock step during a hang must
/// not be able to turn a 73-second wedge into a negative duration.
fn mono_ms() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The live registry, plus the condvar the watcher parks on while it is empty.
struct Registry {
    entries: Mutex<HashMap<u64, Entry>>,
    /// Signalled when an entry is added, to unpark a watcher that has gone to sleep on an empty
    /// registry. Notified on registration only — a removal can never create work for the watcher.
    wake: Condvar,
}

fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| Registry { entries: Mutex::new(HashMap::new()), wake: Condvar::new() })
}

static NEXT_SEQ: AtomicU64 = AtomicU64::new(1);

/// A registered in-flight write. Deregisters on drop, reporting the write if it was slow.
///
/// RAII rather than an explicit `end()` so an early return or a `?` on the write's error cannot
/// leak an entry — a leaked entry would be reported as a permanently blocked write forever, which
/// is worse than no instrument at all.
pub struct Guard {
    seq: u64,
    started_ms: u64,
    id: String,
    bytes: usize,
}

impl Guard {
    /// Mark this write as having acquired the writer lock and entered `write_all`.
    pub fn writing(&self) {
        let mut entries = registry().entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get_mut(&self.seq) {
            entry.phase = Phase::Writing;
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let reported = {
            let mut entries = registry().entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.remove(&self.seq).and_then(|e| e.last_warn_ms.map(|_| ()))
        };
        let elapsed = mono_ms().saturating_sub(self.started_ms);
        // Report a slow COMPLETION when it crossed the threshold — whether or not the watcher
        // already reported it outstanding. When the watcher did report it, this line is what
        // closes the episode; without it a log shows a write starting to block and never says
        // whether it recovered, which is exactly the ambiguity that made the two captures unusable.
        if elapsed >= SLOW_WRITE_MS {
            tracing::warn!(
                target: "pty",
                session = %self.id,
                bytes = self.bytes,
                elapsed_ms = elapsed,
                previously_reported = reported.is_some(),
                "slow pty write COMPLETED — a PTY master write blocked this long before returning"
            );
        }
    }
}

/// Register a write about to be attempted against `id`, carrying `bytes` bytes.
///
/// Starts the watcher thread on first use. The returned guard must be held across the write.
pub fn begin(id: &str, bytes: usize) -> Guard {
    let seq = NEXT_SEQ.fetch_add(1, Ordering::Relaxed);
    let started_ms = mono_ms();
    let reg = registry();
    {
        let mut entries = reg.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.insert(
            seq,
            Entry {
                id: id.to_string(),
                bytes,
                started_ms,
                last_warn_ms: None,
                phase: Phase::Queued,
            },
        );
    }
    reg.wake.notify_all();
    ensure_watcher();
    Guard { seq, started_ms, id: id.to_string(), bytes }
}

/// A snapshot of every write currently in flight, longest-blocked first.
///
/// Exposed for the hang-capture path and for tests. Cloning under the lock is deliberate: the
/// caller is very likely running while the main thread is wedged, and it must not hold this lock
/// across formatting.
pub fn in_flight() -> Vec<Overdue> {
    let now = mono_ms();
    let entries = registry().entries.lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<Overdue> = entries
        .values()
        .map(|e| Overdue {
            id: e.id.clone(),
            bytes: e.bytes,
            elapsed_ms: now.saturating_sub(e.started_ms),
            phase: e.phase,
        })
        .collect();
    out.sort_by(|a, b| b.elapsed_ms.cmp(&a.elapsed_ms).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Start the watcher thread once.
fn ensure_watcher() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        // A named thread, so it is identifiable in the very stack captures it exists to annotate.
        let _ = std::thread::Builder::new()
            .name("pty-write-watch".to_string())
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
            sweep(&mut entries, mono_ms(), SLOW_WRITE_MS, REWARN_BACKOFF_MS)
        };
        for o in overdue {
            tracing::warn!(
                target: "pty",
                session = %o.id,
                bytes = o.bytes,
                elapsed_ms = o.elapsed_ms,
                phase = o.phase.as_str(),
                "pty write STILL BLOCKED — child appears to have stopped reading its stdin"
            );
        }
        std::thread::sleep(Duration::from_millis(SLOW_WRITE_MS / 2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(started_ms: u64, last_warn_ms: Option<u64>) -> Entry {
        Entry {
            id: "s1".to_string(),
            bytes: 632,
            started_ms,
            last_warn_ms,
            phase: Phase::Writing,
        }
    }

    /// The healthy case: every write measured beside the real hang returned in well under a
    /// millisecond, and none of them may produce a line.
    #[test]
    fn a_fast_write_is_never_reported() {
        assert!(!due(&entry(0, None), 0, SLOW_WRITE_MS, REWARN_BACKOFF_MS));
        assert!(!due(&entry(0, None), 1, SLOW_WRITE_MS, REWARN_BACKOFF_MS));
        assert!(!due(&entry(0, None), SLOW_WRITE_MS - 1, SLOW_WRITE_MS, REWARN_BACKOFF_MS));
    }

    #[test]
    fn crossing_the_threshold_reports_once() {
        assert!(due(&entry(0, None), SLOW_WRITE_MS, SLOW_WRITE_MS, REWARN_BACKOFF_MS));
        // Already reported at 250; not due again until the backoff elapses.
        assert!(!due(&entry(0, Some(250)), 260, SLOW_WRITE_MS, REWARN_BACKOFF_MS));
        assert!(!due(&entry(0, Some(250)), 749, SLOW_WRITE_MS, REWARN_BACKOFF_MS));
        assert!(due(&entry(0, Some(250)), 750, SLOW_WRITE_MS, REWARN_BACKOFF_MS));
    }

    /// THE CASE THAT MATTERS. A write that never returns must keep naming itself for as long as it
    /// is blocked — a stopwatch on the completed write would emit nothing at all here, which is
    /// what both real captures did.
    ///
    /// Asserts on the reports produced across a simulated 73.5-second wedge (the measured
    /// `hung_for_ms=73491`), not on `due` in isolation: the property is that the session is named
    /// repeatedly with a growing elapsed time, and that it is named at all.
    #[test]
    fn a_write_that_never_returns_reports_repeatedly_and_names_the_session() {
        let mut entries = HashMap::new();
        entries.insert(1u64, entry(0, None));

        let mut reports = Vec::new();
        // Tick at the watcher's real cadence across the measured hang duration.
        let mut now = 0u64;
        while now <= 73_491 {
            reports.extend(sweep(&mut entries, now, SLOW_WRITE_MS, REWARN_BACKOFF_MS));
            now += SLOW_WRITE_MS / 2;
        }

        assert!(
            reports.len() > 100,
            "a 73.5s wedge must keep reporting, got {} report(s)",
            reports.len()
        );
        assert!(
            reports.iter().all(|r| r.id == "s1"),
            "every report must name the session — that is the whole point"
        );
        assert_eq!(reports[0].bytes, 632, "carries the write size from the real capture");
        assert_eq!(reports[0].phase, Phase::Writing);
        // The elapsed time must GROW, so a reader can tell a momentary stall from a wedge.
        assert!(reports[0].elapsed_ms < 1_000);
        assert!(
            reports.last().unwrap().elapsed_ms > 70_000,
            "the last report must show the true age of the wedge"
        );
        // Strictly increasing: a repeated identical elapsed would mean the clock, not the write,
        // was being reported.
        assert!(reports.windows(2).all(|w| w[1].elapsed_ms > w[0].elapsed_ms));
    }

    /// A write blocked BEHIND another write to the same session is a different fact from the write
    /// that is actually stuck in `write_all`, and the log has to say which is which.
    #[test]
    fn queued_and_writing_are_reported_distinctly_longest_first() {
        let mut entries = HashMap::new();
        entries.insert(1u64, Entry { phase: Phase::Writing, ..entry(0, None) });
        entries.insert(
            2u64,
            Entry { id: "s1".to_string(), phase: Phase::Queued, ..entry(400, None) },
        );

        let reports = sweep(&mut entries, 1_000, SLOW_WRITE_MS, REWARN_BACKOFF_MS);
        assert_eq!(reports.len(), 2);
        // Longest-blocked first: the one in `write_all` is the one to investigate.
        assert_eq!(reports[0].phase, Phase::Writing);
        assert_eq!(reports[0].elapsed_ms, 1_000);
        assert_eq!(reports[1].phase, Phase::Queued);
        assert_eq!(reports[1].elapsed_ms, 600);
    }

    /// Two stuck sessions must both be named; reporting only the worst would hide a second wedged
    /// terminal behind the first.
    #[test]
    fn every_blocked_session_is_named_not_just_the_worst() {
        let mut entries = HashMap::new();
        entries.insert(1u64, Entry { id: "aaa".to_string(), ..entry(0, None) });
        entries.insert(2u64, Entry { id: "bbb".to_string(), ..entry(0, None) });

        let reports = sweep(&mut entries, 1_000, SLOW_WRITE_MS, REWARN_BACKOFF_MS);
        let mut ids: Vec<&str> = reports.iter().map(|r| r.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["aaa", "bbb"]);
    }

    /// `sweep` must record that it reported, or the backoff cannot hold and a wedge produces a
    /// line every tick.
    #[test]
    fn sweep_stamps_what_it_reported() {
        let mut entries = HashMap::new();
        entries.insert(1u64, entry(0, None));

        assert_eq!(sweep(&mut entries, 300, SLOW_WRITE_MS, REWARN_BACKOFF_MS).len(), 1);
        assert_eq!(entries[&1].last_warn_ms, Some(300));
        // Immediately again: nothing, because the stamp is in place.
        assert!(sweep(&mut entries, 310, SLOW_WRITE_MS, REWARN_BACKOFF_MS).is_empty());
    }

    /// The registry is a process global shared with the live app, so this drives the real
    /// `begin`/`Guard` path end to end: an in-flight write is visible by session id, and the guard
    /// removes it on drop. Uses a unique id so it cannot collide with another test's entries.
    #[test]
    fn begin_registers_and_the_guard_deregisters() {
        let id = "test-session-begin-registers";
        assert!(!in_flight().iter().any(|e| e.id == id));

        let guard = begin(id, 42);
        let seen = in_flight();
        let mine = seen.iter().find(|e| e.id == id).expect("registered while in flight");
        assert_eq!(mine.bytes, 42);
        assert_eq!(mine.phase, Phase::Queued, "starts queued, before the writer lock is held");

        guard.writing();
        let mine = in_flight().into_iter().find(|e| e.id == id).expect("still in flight");
        assert_eq!(mine.phase, Phase::Writing, "phase advances once write_all is entered");

        drop(guard);
        assert!(
            !in_flight().iter().any(|e| e.id == id),
            "the guard must deregister on drop — a leaked entry reads as a permanent wedge"
        );
    }
}

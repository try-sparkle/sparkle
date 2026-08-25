//! R5 OF "RESTART WORK RECOVERY" — THE LAST CHANCE TO WRITE UNCOMMITTED AGENT WORK DOWN.
//!
//! ── WHAT IS STILL LOST WITHOUT THIS ───────────────────────────────────────────────────────────
//! `PRD/sparkle/restart-work-recovery.md` shipped four shell-layer pieces: a session-start probe
//! that SURFACES uncommitted work (R1), a `Stop` hook that CHECKPOINTS it after every agent turn
//! (R2), a prior-session digest (R3), and the wiring (R4). R2 is the durability floor, and its
//! trigger is the hole this module fills: `Stop` fires when a TURN ENDS. An app quit or restart
//! that lands mid-turn — the single largest killer of agents in this app, measured at 54 deaths in
//! one minute (`agent_life.rs`) — takes everything written since the last turn boundary with it,
//! and takes it from every agent at once.
//!
//! An agent whose worktree is later reaped by `spin_down_worker` then has no copy of that work
//! anywhere: the worktree directory is deleted, and nothing was committed.
//!
//! ── SO: ONE BOUNDED SWEEP AT TEARDOWN, WRITING TO THE SAME SIDE REF R2 USES ───────────────────
//! On the way out, snapshot every agent worktree that has uncommitted changes into
//! `refs/sparkle-autosave/<agent-id>` via [`crate::worktree::autosave_worktree_wip_within`] — the
//! SAME mechanism, the SAME ref namespace, and the same non-destructive plumbing (a throwaway
//! index, `commit-tree`, `update-ref`; the agent's index, HEAD, branch and working tree are never
//! touched). Reusing it is the point: recovery instructions, the ref namespace, the mid-operation
//! guard, the `.env` exclusions and the leaked-ref-lock repair all already exist and are tested.
//! This module contributes exactly one thing that did not exist — a caller on the teardown path.
//!
//! Because the refs and their commit objects live in the SHARED git dir rather than in the
//! worktree, a snapshot written here survives both the quit and the later worktree deletion.
//!
//! ── AND IT IS PUBLISHED WHERE THE RECOVERY CHAIN ACTUALLY LOOKS ───────────────────────────────
//! A snapshot nobody reads is not a recovery feature. `refs/sparkle-autosave/<agent-id>` had two
//! writers and ZERO readers — no script, no command, no UI — while the chain that actually runs at
//! session start reads `refs//<branch>` and nothing else: `session-workstate-check.sh`
//! (R1) prints the checkpoint and the command to recover it, and `session-resume-digest.sh` (R3)
//! treats it as a signal that the prior session is worth re-surfacing. So every teardown snapshot
//! ALSO points that branch-keyed alias at the same commit
//! ([`crate::worktree::publish_wip_alias`]).
//!
//! The branch key is the half that survives: `spin_down_worker` deletes the worktree and KEEPS the
//! branch, so an agent-id-keyed ref is addressable only through a directory name that no longer
//! exists, whereas the alias is surfaced by R1 to anyone who checks that branch out, anywhere. A
//! detached HEAD has no such name and keeps only the agent-id ref — the same documented gap
//! `wip-autosave.sh` has.
//!
//! ── WHICH QUITS THIS ACTUALLY REACHES ─────────────────────────────────────────────────────────
//! It hangs off `RunEvent::Exit`, deliberately, and not off `ExitRequested`. `lib.rs`'s
//! `updater_quit` header block reads the two out of the locked crate sources: `ExitRequested` is
//! emitted only from `AppHandle::exit`/`restart` and last-window-destroyed, whereas the macOS
//! `terminate:` path (the Dock's Quit, a system logout or restart) arrives as
//! `Event::LoopDestroyed` → `RunEvent::Exit`. `Exit` is therefore the strictly broader arm, and it
//! still fires BEFORE the `process::exit()` phase, which is why the dictation, improve-pass and
//! preview teardowns already live there.
//!
//! HONEST LIMITS, because a recovery feature that overstates its coverage is worse than none:
//! `SIGKILL`, Force Quit and power loss reach no arm at all and are covered ONLY by R2's per-turn
//! checkpoint. This narrows the window from "a whole turn" to "since the last turn boundary, and
//! only if the kill was un-catchable" — it does not close it.
//!
//! ── THE BUDGET IS A CORRECTNESS PROPERTY, NOT A TUNING KNOB ───────────────────────────────────
//! This runs on the main thread as the event loop leaves, so every millisecond spent here is a
//! millisecond the user's app has not quit — and on the `terminate:` path macOS is already running
//! its own watchdog. An unbounded sweep would turn "recover my work" into "the app won't close",
//! which is a worse bug than the one being fixed. So the whole sweep shares ONE deadline, every
//! git call inside `autosave_worktree_wip_within` checks it (`git_autosave` returns early once it
//! is reached), and workers stop taking new targets the moment it passes. Blowing the budget costs
//! coverage — reported as `unattempted` — never a hung quit.
//!
//! ── NO MODEL CALL, NO NETWORK, NO WEBVIEW ─────────────────────────────────────────────────────
//! Same discipline as `agent_life.rs`: this is `read_dir` plus `git` plumbing. The webview may
//! already be gone by the time this runs (last-window-destroyed reaches `Exit` with the window map
//! empty), so nothing here may depend on it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Runtime};

use crate::worktree::{autosave_worktree_wip_within, AutosaveKind, AutosaveOutcome};

/// How long the ENTIRE teardown sweep may take, across every worktree.
///
/// Chosen against the thing that actually bounds it: on the macOS `terminate:` path this runs
/// inside the app's termination handling, where the OS will force-kill an app that dawdles, and on
/// every path it is time the user is staring at an app that has not closed. Four seconds is enough
/// for a full sweep of a large fleet at [`SWEEP_THREADS`] concurrency (a clean tree costs one
/// `git status`) and short enough that the worst case still reads as "quitting", not "hung".
///
/// Deliberately LARGER than `worktree::AUTOSAVE_TIMEOUT` is small: that one bounds a single agent's
/// periodic autosave against a live tree; this one bounds the whole fleet, once, at the end.
pub const DEFAULT_BUDGET: Duration = Duration::from_millis(4_000);

/// Worktrees snapshotted concurrently. Each one is `git` subprocesses and disk, not CPU, so this is
/// well above core count on purpose — the sweep is latency-bound, and the deadline (not the thread
/// count) is what keeps it from running long.
const SWEEP_THREADS: usize = 8;

/// Env kill-switch, for a machine where the sweep is unwanted or is suspected of delaying a quit.
/// `0`/`false`/`off`/`no` disable it; anything else (including unset) leaves it on.
///
/// An env var rather than a `[recovery]` key on purpose: mirroring the shell defaults into
/// `config.rs` is its OWN follow-up in the PRD's out-of-scope list, and inventing half of that
/// schema here would leave two owners for one setting.
pub const DISABLE_ENV: &str = "SPARKLE_TEARDOWN_GUARD";

/// Env override for [`DEFAULT_BUDGET`], in milliseconds. Also what the integration test uses to
/// prove the budget is honoured without sleeping for seconds.
pub const BUDGET_ENV: &str = "SPARKLE_TEARDOWN_GUARD_MS";

/// One agent worktree the sweep may snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// The agent id, which is BOTH the directory name and the side-ref suffix. Taken from the path
    /// rather than from any in-memory roster: at teardown the roster lives in a webview that may
    /// already be gone, and the directory layout is the durable fact.
    pub agent_id: String,
    pub path: PathBuf,
}

/// What one sweep did. Every target lands in exactly one of the outcome buckets, so
/// `snapshotted + clean + skipped + failed + unattempted == found` — asserted by a test, because a
/// tally that silently drops a target is how a coverage hole hides.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct TeardownReport {
    /// Live worktrees discovered on disk.
    pub found: usize,
    /// Had uncommitted work and now have a snapshot commit on their side ref.
    pub snapshotted: usize,
    /// Nothing uncommitted (or nothing but excluded env files) — the ordinary case.
    pub clean: usize,
    /// Left alone on purpose: mid-merge/rebase/cherry-pick, or the directory was already gone.
    pub skipped: usize,
    /// Attempted and errored. Best-effort by contract; the count exists so a fleet-wide failure is
    /// visible in the log instead of silent.
    pub failed: usize,
    /// The budget ran out before these were reached. THE FIELD THAT MUST NOT BE DROPPED: it is the
    /// difference between "every dirty tree is safe" and "an unknown number of them are not".
    pub unattempted: usize,
    /// Of the `snapshotted`, how many also got their `refs//<branch>` alias — i.e. how
    /// many are DISCOVERABLE by R1/R3 rather than only durable. NOT a bucket: it is a subset of
    /// `snapshotted`, so it is excluded from the one-bucket-per-target invariant on purpose.
    pub published: usize,
    pub elapsed_ms: u128,
}

impl TeardownReport {
    /// Did the sweep actually do anything worth a log line? A quit where every tree was clean is
    /// the happy path and stays silent, matching the PRD's "silent on the happy path" principle.
    pub fn worth_logging(&self) -> bool {
        self.snapshotted > 0 || self.failed > 0 || self.unattempted > 0
    }
}

/// Is the guard enabled? Reads [`DISABLE_ENV`]; anything but an explicit off value means on.
pub fn enabled() -> bool {
    match std::env::var(DISABLE_ENV) {
        Ok(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no"),
        Err(_) => true,
    }
}

/// The sweep's total budget: [`BUDGET_ENV`] when it parses as a number of milliseconds, else
/// [`DEFAULT_BUDGET`]. A garbage value falls back rather than erroring — this path may never fail a
/// quit.
pub fn budget() -> Duration {
    std::env::var(BUDGET_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_BUDGET)
}

/// Every live agent worktree under `<app_data>/worktrees/<project_id>/<agent_id>`.
///
/// `.git` is a FILE in a linked worktree, so its presence is the cheap proof this directory is a
/// live worktree rather than a husk `git worktree prune` has already disowned — the same test
/// `conflict_watch::discover_repos` uses, for the same reason.
///
/// ORDERED NEWEST-TOUCHED FIRST, and that ordering is load-bearing rather than cosmetic: when the
/// budget runs out it decides WHICH trees go unprotected, and the agent that was typing when the
/// app died is the one whose work is least likely to exist anywhere else. The signal is the
/// worktree directory's own mtime — two stats per target, no walk — which is a HEURISTIC (it moves
/// when a top-level entry is added or removed, not on every nested edit) and is used for order
/// ONLY. Nothing is ever excluded by it. Ties break on the path so the order is deterministic.
pub fn sweep_targets(app_data: &Path) -> Vec<Target> {
    let base = app_data.join("worktrees");
    let Ok(projects) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut project_dirs: Vec<PathBuf> =
        projects.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    project_dirs.sort();

    let mut out: Vec<(i64, Target)> = Vec::new();
    for project in project_dirs {
        let Ok(entries) = std::fs::read_dir(&project) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.join(".git").exists() {
                continue;
            }
            let Some(agent_id) = path.file_name().and_then(|n| n.to_str()).map(str::to_string)
            else {
                continue;
            };
            out.push((crate::fleet::mtime_ms(&path).unwrap_or(0), Target { agent_id, path }));
        }
    }
    // Newest first; equal mtimes fall back to the path so two runs agree.
    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));
    out.into_iter().map(|(_, t)| t).collect()
}

/// Snapshot `targets` under one shared `deadline`, `SWEEP_THREADS` at a time.
///
/// The `snapshot` seam exists so the deadline behaviour and the tally are testable WITHOUT a real
/// fleet of git repos; the production caller ([`run_on_exit`]) passes the real autosave, and an
/// end-to-end test below drives that same production closure against real repos, so the real path
/// is not covered by fakes alone.
///
/// THE DEADLINE IS CHECKED BEFORE CLAIMING A TARGET, not after finishing one. A worker that has run
/// out of budget must not start a fresh worktree's `git status`; the already-claimed one is bounded
/// from inside by `git_autosave`, which refuses to spawn once the deadline has passed.
pub fn sweep_with<F>(targets: &[Target], deadline: Instant, snapshot: F) -> TeardownReport
where
    F: Fn(&Target, Instant) -> Result<AutosaveOutcome, String> + Sync,
{
    let started = Instant::now();
    let next = AtomicUsize::new(0);
    let snapshotted = AtomicUsize::new(0);
    let clean = AtomicUsize::new(0);
    let skipped = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let attempted = AtomicUsize::new(0);

    let threads = SWEEP_THREADS.min(targets.len().max(1));
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                if Instant::now() >= deadline {
                    return;
                }
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(target) = targets.get(i) else {
                    return;
                };
                attempted.fetch_add(1, Ordering::SeqCst);
                match snapshot(target, deadline) {
                    Ok(out) => match out.kind {
                        AutosaveKind::Snapshotted => {
                            snapshotted.fetch_add(1, Ordering::SeqCst);
                        }
                        AutosaveKind::NothingToCommit => {
                            clean.fetch_add(1, Ordering::SeqCst);
                        }
                        AutosaveKind::SkippedMidOperation | AutosaveKind::NoWorktree => {
                            skipped.fetch_add(1, Ordering::SeqCst);
                        }
                    },
                    Err(e) => {
                        failed.fetch_add(1, Ordering::SeqCst);
                        tracing::debug!(
                            "app-teardown wip guard: {} could not be snapshotted: {e}",
                            target.agent_id
                        );
                    }
                }
            });
        }
    });

    let found = targets.len();
    TeardownReport {
        found,
        snapshotted: snapshotted.load(Ordering::SeqCst),
        clean: clean.load(Ordering::SeqCst),
        skipped: skipped.load(Ordering::SeqCst),
        failed: failed.load(Ordering::SeqCst),
        unattempted: found.saturating_sub(attempted.load(Ordering::SeqCst)),
        // The alias is published by `sweep_app_data`, which owns the real snapshot closure; the
        // generic sweep cannot know whether a caller's closure wrote one.
        published: 0,
        elapsed_ms: started.elapsed().as_millis(),
    }
}

/// The production sweep, split from [`run_on_exit`] so a test can drive the REAL snapshot closure
/// against real worktrees without needing an `AppHandle` (which cannot be built in a unit test).
pub fn sweep_app_data(app_data: &Path, budget: Duration) -> TeardownReport {
    let targets = sweep_targets(app_data);
    let deadline = Instant::now() + budget;
    let published = AtomicUsize::new(0);
    let mut report = sweep_with(&targets, deadline, |t, d| {
        let worktree = t.path.to_string_lossy().to_string();
        let out = autosave_worktree_wip_within(&worktree, &t.agent_id, d)?;
        // ONLY AFTER the durable snapshot exists. The alias is what makes it DISCOVERABLE — see the
        // module header — and it is strictly best-effort: a failure here loses the R1 banner, never
        // the bytes, so the outcome is returned unchanged either way.
        if out.kind == AutosaveKind::Snapshotted {
            if let Some(sha) = out.sha.as_deref() {
                match crate::worktree::publish_wip_alias(&worktree, sha, d) {
                    Ok(Some(_)) => {
                        published.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(None) => tracing::debug!(
                        "app-teardown wip guard: {} is on no branch; its snapshot keeps only the \
                         agent-id ref",
                        t.agent_id
                    ),
                    Err(e) => tracing::debug!(
                        "app-teardown wip guard: {} snapshotted but its wip alias failed: {e}",
                        t.agent_id
                    ),
                }
            }
        }
        Ok(out)
    });
    report.published = published.load(Ordering::SeqCst);
    report
}

/// Ran already this process? `RunEvent::Exit` fires once, but a second sweep would be pure quit
/// latency for zero new coverage, so the guard is explicit rather than assumed.
static RAN: AtomicBool = AtomicBool::new(false);

/// Hang off `RunEvent::Exit`. Best-effort and total: it never returns an error, never panics out,
/// and never runs longer than [`budget`].
pub fn run_on_exit<R: Runtime>(app: &AppHandle<R>) {
    if !enabled() {
        return;
    }
    if RAN.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(app_data) = crate::dev_identity::app_data_dir(app) else {
        return;
    };
    let report = sweep_app_data(&app_data, budget());
    if report.worth_logging() {
        tracing::info!(
            "app-teardown wip guard: {} worktree(s) found, {} snapshotted, {} clean, {} skipped, \
             {} failed, {} unattempted (budget ran out), {} discoverable via refs/, \
             {}ms",
            report.found,
            report.snapshotted,
            report.clean,
            report.skipped,
            report.failed,
            report.unattempted,
            report.published,
            report.elapsed_ms
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn unique_root(tag: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "sparkle-teardown-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn target(id: &str) -> Target {
        Target { agent_id: id.to_string(), path: PathBuf::from(format!("/nope/{id}")) }
    }

    fn outcome(kind: AutosaveKind) -> AutosaveOutcome {
        AutosaveOutcome { kind, sha: None, ref_name: None, files: 0 }
    }

    // ── discovery ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn discovery_finds_live_worktrees_and_ignores_husks_and_stray_files() {
        let app_data = unique_root("discovery");
        let base = app_data.join("worktrees");
        for (project, agent) in [("p1", "a1"), ("p1", "a2"), ("p2", "b1")] {
            let wt = base.join(project).join(agent);
            std::fs::create_dir_all(&wt).unwrap();
            std::fs::write(wt.join(".git"), "gitdir: /somewhere").unwrap();
        }
        // A husk `git worktree prune` already disowned: a directory with no `.git`.
        std::fs::create_dir_all(base.join("p1").join("husk")).unwrap();
        // And a stray file where a project directory would be.
        std::fs::write(base.join("loose.txt"), "x").unwrap();

        let found = sweep_targets(&app_data);
        let mut ids: Vec<&str> = found.iter().map(|t| t.agent_id.as_str()).collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["a1", "a2", "b1"],
            "every live worktree is a target; the husk and the stray file are not"
        );
        for t in &found {
            assert!(t.path.join(".git").exists(), "a target always names a real worktree");
        }
    }

    #[test]
    fn discovery_is_empty_and_silent_when_there_is_no_worktrees_dir() {
        // A first launch, or a machine that has never spawned an agent. Must not error.
        assert!(sweep_targets(&unique_root("no-worktrees")).is_empty());
    }

    #[test]
    fn discovery_orders_the_most_recently_touched_worktree_first() {
        // The order decides who loses coverage when the budget runs out, so it is asserted rather
        // than left to `read_dir`. Written oldest-first on purpose: a pass that merely echoed
        // directory order would have a coin-flip chance of looking correct.
        let app_data = unique_root("order");
        let base = app_data.join("worktrees").join("p1");
        for agent in ["oldest", "middle", "newest"] {
            let wt = base.join(agent);
            std::fs::create_dir_all(&wt).unwrap();
            std::fs::write(wt.join(".git"), "gitdir: /somewhere").unwrap();
            // Touch the DIRECTORY (adding an entry bumps its mtime) with a gap big enough that a
            // coarse filesystem timestamp still separates them.
            std::thread::sleep(Duration::from_millis(1_100));
            std::fs::write(wt.join("marker"), agent).unwrap();
        }
        let found = sweep_targets(&app_data);
        let ids: Vec<&str> = found.iter().map(|t| t.agent_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["newest", "middle", "oldest"],
            "newest-touched first — the agent that was working when the app died is snapshotted \
             before the budget can run out"
        );
    }

    // ── the sweep ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn every_target_is_attempted_and_lands_in_exactly_one_bucket() {
        let targets =
            vec![target("snap"), target("clean"), target("mid-op"), target("gone"), target("boom")];
        let seen = Mutex::new(Vec::<String>::new());
        let report = sweep_with(&targets, Instant::now() + Duration::from_secs(30), |t, _| {
            seen.lock().unwrap().push(t.agent_id.clone());
            match t.agent_id.as_str() {
                "snap" => Ok(AutosaveOutcome {
                    kind: AutosaveKind::Snapshotted,
                    sha: Some("deadbeef".into()),
                    ref_name: Some("refs/sparkle-autosave/snap".into()),
                    files: 3,
                }),
                "clean" => Ok(outcome(AutosaveKind::NothingToCommit)),
                "mid-op" => Ok(outcome(AutosaveKind::SkippedMidOperation)),
                "gone" => Ok(outcome(AutosaveKind::NoWorktree)),
                _ => Err("git exploded".into()),
            }
        });

        let mut seen = seen.into_inner().unwrap();
        seen.sort();
        assert_eq!(seen.len(), 5, "with budget to spare, every target is attempted exactly once");

        assert_eq!(report.found, 5);
        assert_eq!(report.snapshotted, 1);
        assert_eq!(report.clean, 1);
        assert_eq!(report.skipped, 2, "mid-operation and already-gone are both left alone");
        assert_eq!(report.failed, 1);
        assert_eq!(report.unattempted, 0);
        assert_eq!(
            report.snapshotted
                + report.clean
                + report.skipped
                + report.failed
                + report.unattempted,
            report.found,
            "no target may fall out of the tally — a dropped one is an invisible coverage hole"
        );
        assert!(report.worth_logging(), "a quit that saved work says so");
        assert_eq!(
            report.published, 0,
            "`published` counts real alias writes only — the fake snapshotter performs none, so a \
             field that merely mirrored `snapshotted` would show 1 here"
        );
    }

    #[test]
    fn an_expired_budget_stops_the_sweep_and_reports_what_it_never_reached() {
        // THE PROPERTY: a blown budget costs COVERAGE, never a hung quit — and the cost is
        // reported rather than swallowed. The deadline is already in the past, so no target may be
        // claimed at all.
        let targets: Vec<Target> = (0..20).map(|i| target(&format!("a{i}"))).collect();
        let calls = AtomicUsize::new(0);
        let report = sweep_with(&targets, Instant::now() - Duration::from_millis(1), |_, _| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(outcome(AutosaveKind::Snapshotted))
        });

        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "an exhausted budget must not start a single fresh worktree's git status"
        );
        assert_eq!(report.unattempted, 20, "and every one of them is reported as unprotected");
        assert_eq!(report.snapshotted, 0);
        assert!(report.worth_logging(), "unattempted work is exactly what the log must not hide");
    }

    #[test]
    fn the_sweep_returns_within_the_budget_even_when_every_target_is_slow() {
        // The paired half of the test above: with a LIVE budget and work that outlasts it, the
        // sweep still returns promptly instead of grinding through all 200 targets. Without the
        // pre-claim deadline check this takes ~5s at 8 threads; with it, ~200ms.
        let targets: Vec<Target> = (0..200).map(|i| target(&format!("a{i}"))).collect();
        let started = Instant::now();
        let report = sweep_with(&targets, Instant::now() + Duration::from_millis(200), |_, _| {
            std::thread::sleep(Duration::from_millis(200));
            Ok(outcome(AutosaveKind::Snapshotted))
        });
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_millis(2_000),
            "the sweep must not outrun its budget by an order of magnitude (took {elapsed:?})"
        );
        assert!(report.unattempted > 0, "and it must say that it did not get to everything");
        assert_eq!(report.found, 200);
    }

    #[test]
    fn a_clean_fleet_is_silent() {
        let targets = vec![target("a"), target("b")];
        let report = sweep_with(&targets, Instant::now() + Duration::from_secs(30), |_, _| {
            Ok(outcome(AutosaveKind::NothingToCommit))
        });
        assert_eq!(report.clean, 2);
        assert!(
            !report.worth_logging(),
            "the happy path prints nothing — the PRD's silent-on-clean principle"
        );
    }

    #[test]
    fn the_sweep_is_a_no_op_on_an_empty_fleet() {
        let report = sweep_with(&[], Instant::now() + Duration::from_secs(30), |_, _| {
            panic!("nothing to snapshot")
        });
        assert_eq!(report, TeardownReport { elapsed_ms: report.elapsed_ms, ..Default::default() });
    }

    // ── the knobs ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_budget_falls_back_rather_than_failing_on_garbage() {
        // Parsed with the env unset in-process is not assertable here (the suite runs in one
        // process and env is global), so the parse itself is what is pinned.
        let parse = |v: &str| v.trim().parse::<u64>().ok().map(Duration::from_millis);
        assert_eq!(parse("250"), Some(Duration::from_millis(250)));
        assert_eq!(parse(" 250 "), Some(Duration::from_millis(250)));
        assert_eq!(parse("soon"), None, "garbage falls back to the default, it does not error");
        assert_eq!(parse(""), None);
        assert!(DEFAULT_BUDGET <= Duration::from_secs(5), "the quit stays a quit");
    }

    #[test]
    fn only_an_explicit_off_value_disables_the_guard() {
        let off = |v: &str| matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no");
        for v in ["0", "false", "FALSE", "off", "no", " no "] {
            assert!(off(v), "{v:?} must disable the guard");
        }
        for v in ["1", "true", "on", "yes", "", "maybe"] {
            assert!(!off(v), "{v:?} must NOT disable the guard — it defaults ON");
        }
    }

    // ── the wiring ───────────────────────────────────────────────────────────────────────────

    /// A GUARD FOR THE ONE LINE NOTHING ELSE COVERS.
    ///
    /// Every test above exercises the sweep directly. The production trigger is a single call in
    /// `lib.rs`'s `RunEvent::Exit` arm, and that arm only runs when a real app really quits — so
    /// deleting the call would leave this whole module compiling, fully tested, and INERT, with a
    /// green suite saying otherwise. That is the exact "wired but never ran" shape `AGENTS.md`
    /// warns about, so the wiring is asserted from source rather than assumed.
    ///
    /// It checks the arm, not merely the file: a call sitting anywhere else in `lib.rs` would not
    /// fire at teardown.
    #[test]
    fn the_guard_is_wired_into_the_exit_arm() {
        let lib = include_str!("lib.rs");
        let arm = lib
            .split("tauri::RunEvent::Exit => {")
            .nth(1)
            .expect("lib.rs must still have a RunEvent::Exit arm to hang the guard off");
        assert!(
            arm.contains("teardown_guard::run_on_exit(app)"),
            "the teardown guard must be CALLED from the RunEvent::Exit arm; without it this module \
             is inert and every test above still passes"
        );
    }

    // ── end to end, against real git ─────────────────────────────────────────────────────────

    /// Drives the REAL production closure ([`sweep_app_data`]) over REAL worktrees, and asserts the
    /// thing the whole module exists for: the uncommitted bytes are recoverable from the side ref
    /// AFTER the worktree that held them is deleted — which is what `spin_down_worker` does to a
    /// killed agent's tree.
    ///
    /// This is what keeps the fake-seam tests above honest: they prove the sweep's control flow,
    /// this proves the sweep actually saves work.
    #[test]
    fn a_teardown_sweep_saves_work_that_outlives_the_worktree() {
        let repo = unique_root("e2e-repo");
        let r = repo.to_string_lossy().to_string();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&r)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "core.hooksPath", "/dev/null"]);
        git(&["commit", "--allow-empty", "-m", "init"]);
        git(&["branch", "-M", "main"]);

        let app_data = unique_root("e2e-appdata");
        let dirty = app_data.join("worktrees").join("p1").join("a-dirty");
        let clean = app_data.join("worktrees").join("p1").join("a-clean");
        git(&["worktree", "add", "-q", "-b", "wt-dirty", &dirty.to_string_lossy(), "main"]);
        git(&["worktree", "add", "-q", "-b", "wt-clean", &clean.to_string_lossy(), "main"]);
        std::fs::write(dirty.join("unsaved.txt"), "870 lines of work").unwrap();

        let report = sweep_app_data(&app_data, Duration::from_secs(60));
        assert_eq!(report.found, 2, "both worktrees are discovered");
        assert_eq!(report.snapshotted, 1, "only the dirty one produces a snapshot");
        assert_eq!(report.clean, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(report.unattempted, 0);
        assert_eq!(report.published, 1, "and it is published where R1 will look for it");

        // The branch-keyed alias and the agent-id ref name the SAME commit — the alias is a second
        // name for one snapshot, not a second snapshot.
        assert_eq!(
            git(&["rev-parse", "refs//wt-dirty"]),
            git(&["rev-parse", "refs/sparkle-autosave/a-dirty"]),
        );

        // THE SIDE EFFECT THAT MATTERS: delete the worktree the way a spin-down would, then read
        // the file back from the shared git dir. Before this module, that content was simply gone.
        git(&["worktree", "remove", "--force", &dirty.to_string_lossy()]);
        assert!(!dirty.exists(), "PRECONDITION: the tree that held the work is gone");
        assert_eq!(
            git(&["show", "refs/sparkle-autosave/a-dirty:unsaved.txt"]),
            "870 lines of work",
            "the uncommitted work survives the teardown that deleted its worktree"
        );

        // …AND IT IS FINDABLE WITHOUT KNOWING THE REF NAME. Durable-but-unaddressable is not
        // recovery: the branch outlives the worktree, so someone picking that branch up anywhere
        // must be TOLD about the checkpoint. Drive the real R1 probe — the actual shell script the
        // SessionStart hook runs — in a fresh checkout of the same branch. Note the tree there is
        // CLEAN and there is no origin, so the wip alias is R1's ONLY possible signal: without it
        // this script prints nothing at all.
        let recovered = app_data.join("recovered");
        git(&["worktree", "add", "-q", &recovered.to_string_lossy(), "wt-dirty"]);
        let probe = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/session-workstate-check.sh");
        let out = std::process::Command::new("bash")
            .arg(&probe)
            .current_dir(&recovered)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();
        let banner = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(
            banner.contains("refs//wt-dirty"),
            "the session-start probe must NAME the teardown checkpoint; it printed: {banner:?}"
        );
        assert!(
            banner.contains("git checkout"),
            "and tell the reader how to get the work back; it printed: {banner:?}"
        );

        // …and the clean worktree got no ref at all: a quit must not manufacture snapshots.
        for name in ["refs/sparkle-autosave/a-clean", "refs//wt-clean"] {
            assert!(
                std::process::Command::new("git")
                    .arg("-C")
                    .arg(&r)
                    .args(["rev-parse", "--verify", "--quiet", name])
                    .output()
                    .map(|o| !o.status.success())
                    .unwrap_or(false),
                "a clean worktree gets no {name}"
            );
        }
    }

    /// A DETACHED HEAD has no branch to key the alias on. The bytes must still be saved — losing
    /// them would be a data-loss path, not a documented gap — so the agent-id ref is written and
    /// only the alias is skipped. Asserted rather than assumed, because "it also skipped the
    /// snapshot" and "it skipped only the alias" look identical from the report's `snapshotted`.
    #[test]
    fn a_detached_head_still_gets_its_snapshot_and_simply_has_no_alias_to_publish() {
        let repo = unique_root("e2e-detached");
        let r = repo.to_string_lossy().to_string();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&r)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "core.hooksPath", "/dev/null"]);
        git(&["commit", "--allow-empty", "-m", "init"]);
        git(&["branch", "-M", "main"]);

        let app_data = unique_root("e2e-detached-appdata");
        let wt = app_data.join("worktrees").join("p1").join("a-detached");
        git(&["worktree", "add", "-q", "--detach", &wt.to_string_lossy(), "main"]);
        std::fs::write(wt.join("unsaved.txt"), "work with nowhere to key an alias").unwrap();

        let report = sweep_app_data(&app_data, Duration::from_secs(60));
        assert_eq!(report.snapshotted, 1, "the work is saved even with no branch name");
        assert_eq!(report.published, 0, "…and nothing was published, because there is no branch");
        assert_eq!(
            git(&["show", "refs/sparkle-autosave/a-detached:unsaved.txt"]),
            "work with nowhere to key an alias"
        );
    }
}

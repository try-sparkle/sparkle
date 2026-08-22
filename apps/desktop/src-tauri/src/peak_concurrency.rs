//! The CONCURRENCY + PER-AGENT MEMORY RECORD on disk — `<app_data>/peak-concurrency.json`.
//!
//! The frozen contract is `docs/peak-concurrency.md`; its canonical instance is
//! `scripts/tests/fixtures/peak-concurrency.json`, which BOTH suites (these tests and the shell
//! tests) parse, so the two halves cannot drift apart silently.
//!
//! It records two things, and the second is the more valuable half:
//!
//! 1. **How many agents ran at once** — a persistent peak, so a public claim has evidence behind it.
//!    Nothing in the app wrote a peak down before this; a peak that resets on relaunch is worthless,
//!    which is exactly why the record lives on disk, outside the repo, and is merged by Rust.
//! 2. **What one agent actually costs in RAM** — a persistent distribution of per-agent TREE RSS, so
//!    the ceiling that number feeds can one day be re-grounded in a measurement.
//!
//! ── THIS MODULE MEASURES. IT CHANGES NO CEILING. ────────────────────────────────────────────────
//! Not `agent_ram_budget_mb`, not `AGENT_TYPICAL_RSS_MB`, not `AGENTS_PER_CORE`. Re-grounding the
//! divisor is a separate, deliberate change that needs the measurement FIRST: lowering a
//! jetsam-guard constant on fresh arithmetic is what bead `sparkle-mjmuj` records as actively
//! harmful, and `AGENTS_PER_CORE`'s own doc comment refuses clearance on exactly those grounds.
//!
//! ── THE TRAP: per-PROCESS RSS is NOT per-AGENT RSS ──────────────────────────────────────────────
//! An agent is a process TREE — measured mean ~1.95 processes, peak 5 under subagent fan-out. A
//! "520 MB per agent" claim was made twice from per-process data and was wrong both times
//! (`sparkle-mjmuj`). So every RSS figure here carries its `proc_count` and the mean is published:
//! **if `mean_proc_count_milli` reads near 1000, the data is per-process and the number is wrong.**
//! The only acceptable source is `memwatch::agent_footprints`, which walks each root's descendant
//! tree and attributes each pid to at most one agent. Those numbers reach us through the frontend
//! (`sample.agent_rss`) rather than being re-derived here, because `agent_footprints` needs a full
//! uncached `ps -axo` and running that a SECOND time every 5 seconds is precisely the cost
//! `agent_memory_watchdog`'s own doc comment warns about.
//!
//! ── EVERY FIELD IS TOTAL — NO `Option`, IN EITHER DIRECTION ─────────────────────────────────────
//! A Rust `Option` crosses the wire as `null`, never as an absent key, so a TypeScript `field?: T`
//! describes a shape the wire cannot produce; an all-or-nothing parser then discards the WHOLE
//! payload, falls back to its "we did not look" default, and the feature is inert forever with
//! nothing logged (`sparkle-16y6h` — two agents built two halves against a frozen field list, both
//! suites green, the shipped feature never once ran). Unknowns are in-band: `basis` is `""`, counts
//! are `0`, `hourly` is `[]`. Deserialization is `#[serde(default)]` throughout so an older or
//! partial file LOADS rather than being discarded — the shape grew once already.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ============================== constants ==============================

/// On-disk schema version. Bumped only by a shape change both halves ship together.
const VERSION: u32 = 1;

/// Which field IS the public claim. A literal in the file rather than an assumption in a reader's
/// head, so a future reader cannot re-derive the wrong one of the three counts.
const HEADLINE: &str = "processes";

/// 64 MiB per histogram bucket. A percentile is the MIDPOINT of its bucket, so the resolution is
/// ±32 MiB — never quote one more precisely than that.
const HIST_BUCKET_BYTES: u64 = 64 * 1024 * 1024;

/// Index of the OVERFLOW bucket (everything ≥ 8 GiB), so the histogram is `HIST_LEN` long. An
/// outlier is COUNTED here rather than dropped or clamped into a real bucket.
const HIST_OVERFLOW_INDEX: usize = 128;
const HIST_LEN: usize = HIST_OVERFLOW_INDEX + 1;

/// ~30 days of hourly rows. Trimmed from the FRONT, so the NEWEST survive.
const MAX_HOURLY: usize = 720;

const MS_PER_HOUR: i64 = 3_600_000;

/// The fixed filename under the app-data root. NOTHING from the frontend reaches this path — unlike
/// `agent_goal_record`, whose name embeds an untrusted `agentId`, there is no traversal surface here
/// and therefore no allowlist to maintain.
const FILE_NAME: &str = "peak-concurrency.json";

// ============================== the shape ==============================

/// The moment of the peak. **The whole row is replaced together** (merge rule 2): every field
/// describes that one instant, so updating any of them independently would produce a row that
/// describes no moment that ever happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PeakRow {
    /// THE NUMBER: live agent PTY processes, app-wide, counted in Rust. The headline.
    pub processes: u32,
    /// Frontend `localAgentCapacity().live` — mounted panes in ONE window, so it can undercount.
    pub live: u32,
    /// Slots consumed, including rows in project tabs nobody has opened. Always ≥ `processes`.
    pub used: u32,
    /// The ceiling actually enforced at that instant — memory-narrowed, so it MOVES.
    pub limit: u32,
    /// How that ceiling was derived; `""` when unknown.
    pub basis: String,
    /// Installed RAM, so a peak can be compared across machines. Read by Rust, never the frontend.
    pub total_ram_bytes: u64,
    /// When it happened. A peak without this cannot be corroborated.
    pub at_ms: i64,
    pub at_iso: String,
}

impl Default for PeakRow {
    fn default() -> Self {
        Self {
            processes: 0,
            live: 0,
            used: 0,
            limit: 0,
            basis: String::new(),
            total_ram_bytes: 0,
            at_ms: 0,
            at_iso: String::new(),
        }
    }
}

/// PER-AGENT TREE RSS, all-time. Read "the trap" in this module's header before reading these.
///
/// `hist` and the counters are AUTHORITATIVE; `p50_bytes`/`p90_bytes`/`mean_proc_count_milli` are
/// DERIVED and recomputed from scratch on every merge, so they cannot drift from their inputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryStats {
    /// `false` ⇒ never sampled, and every number below is then 0. An unmeasured machine is not an
    /// empty one.
    pub observed: bool,
    /// One per AGENT per sample — NOT a count of agents.
    pub agent_observations: u64,
    /// Most agents ever measured in one sample.
    pub agents_seen_max: u32,
    /// Derived from `hist`: the MIDPOINT of the bucket the rank falls in (±32 MiB).
    pub p50_bytes: u64,
    pub p90_bytes: u64,
    /// EXACT, not bucketed — a bucketed max would understate the worst case by up to 64 MiB, and
    /// the worst case is the whole point of a max.
    pub max_bytes: u64,
    /// EXACT, not bucketed. `0` means UNSET; the first observation sets it.
    pub min_bytes: u64,
    /// ÷ `agent_observations` = mean processes per agent.
    pub proc_count_total: u64,
    pub proc_count_max: u32,
    /// 1950 = 1.950 processes/agent. **NEAR 1000 ⇒ THE DATA IS PER-PROCESS** (`sparkle-mjmuj`).
    pub mean_proc_count_milli: u64,
    pub hist_bucket_bytes: u64,
    /// `HIST_LEN` counts, the last an overflow bucket for ≥ 8 GiB.
    pub hist: Vec<u64>,
    pub first_at_ms: i64,
    pub first_at_iso: String,
    pub last_at_ms: i64,
    pub last_at_iso: String,
}

impl Default for MemoryStats {
    fn default() -> Self {
        Self {
            observed: false,
            agent_observations: 0,
            agents_seen_max: 0,
            p50_bytes: 0,
            p90_bytes: 0,
            max_bytes: 0,
            min_bytes: 0,
            proc_count_total: 0,
            proc_count_max: 0,
            mean_proc_count_milli: 0,
            // Structural constants, not observations: a fresh record already knows the shape of the
            // histogram it will fill, so a reader never has to special-case an empty one.
            hist_bucket_bytes: HIST_BUCKET_BYTES,
            hist: vec![0; HIST_LEN],
            first_at_ms: 0,
            first_at_iso: String::new(),
            last_at_ms: 0,
            last_at_iso: String::new(),
        }
    }
}

/// One hour of the rolling series. Counts take the element-wise MAX; the memory half carries MEAN
/// and MAX only (merge rule 6) — a per-hour histogram would be 129 counts × 720 hours rewritten to
/// disk every 5 seconds, and percentiles are worth that cost once, all-time, not 720 times over.
///
/// So: say "mean" (`rss_sum_bytes ÷ agent_observations`) when quoting this series, and "p50" only
/// for the all-time block. On a skewed distribution they differ a lot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HourRow {
    pub hour_start_ms: i64,
    pub hour_start_iso: String,
    pub processes: u32,
    pub live: u32,
    pub used: u32,
    pub limit: u32,
    pub total_ram_bytes: u64,
    pub agent_observations: u64,
    pub rss_sum_bytes: u64,
    pub rss_max_bytes: u64,
    pub proc_count_total: u64,
}

impl Default for HourRow {
    fn default() -> Self {
        Self {
            hour_start_ms: 0,
            hour_start_iso: String::new(),
            processes: 0,
            live: 0,
            used: 0,
            limit: 0,
            total_ram_bytes: 0,
            agent_observations: 0,
            rss_sum_bytes: 0,
            rss_max_bytes: 0,
            proc_count_total: 0,
        }
    }
}

/// The whole record. `peak.processes == 0` with `samples == 0` means NOTHING HAS BEEN OBSERVED YET
/// — a reader must say "no peak recorded", never "the peak is 0".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PeakRecord {
    pub version: u32,
    /// Which field IS the claim — the literal `"processes"`.
    pub headline: String,
    pub peak: PeakRow,
    pub memory: MemoryStats,
    /// Oldest first, at most `MAX_HOURLY`.
    pub hourly: Vec<HourRow>,
    /// How many samples have ever been merged.
    pub samples: u64,
    pub updated_at_ms: i64,
    pub updated_at_iso: String,
}

impl Default for PeakRecord {
    fn default() -> Self {
        Self {
            version: VERSION,
            headline: HEADLINE.to_string(),
            peak: PeakRow::default(),
            memory: MemoryStats::default(),
            hourly: Vec::new(),
            samples: 0,
            updated_at_ms: 0,
            updated_at_iso: String::new(),
        }
    }
}

/// One agent's tree RSS, straight from `WatchdogVerdict` — see the trap in the header for why
/// `proc_count` travels with every RSS figure rather than being optional context.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentRssIn {
    pub agent_id: String,
    pub rss_bytes: u64,
    pub proc_count: u32,
}

impl Default for AgentRssIn {
    fn default() -> Self {
        Self { agent_id: String::new(), rss_bytes: 0, proc_count: 0 }
    }
}

/// The `record_agent_concurrency` argument. The frontend supplies neither the clock nor the machine:
/// Rust reads `total_ram_bytes` and every timestamp ITSELF, so a wrong client cannot forge a peak's
/// time or inflate the RAM it is compared against.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConcurrencySampleIn {
    /// Local (non-cloud) build/worker ROW ids. Rust intersects these with its live PTY sessions:
    /// the frontend owns "which rows are agents", Rust owns "which of those are really running",
    /// and neither half can report a peak on its own.
    pub agent_ids: Vec<String>,
    pub live: u32,
    pub used: u32,
    pub limit: u32,
    pub basis: String,
    /// Up to one 5s tick stale relative to the counts beside it — immaterial to a distribution
    /// accumulated over days, and why the memory block keeps its OWN `first_at_ms`/`last_at_ms`
    /// instead of borrowing the peak's.
    pub agent_rss: Vec<AgentRssIn>,
}

impl Default for ConcurrencySampleIn {
    fn default() -> Self {
        Self {
            agent_ids: Vec::new(),
            live: 0,
            used: 0,
            limit: 0,
            basis: String::new(),
            agent_rss: Vec::new(),
        }
    }
}

// ============================== pure logic ==============================

/// THE definition of the headline: rows the frontend says are local build/worker agents, that Rust
/// can see have a PTY session with a real spawned pid. The size of the INTERSECTION.
///
/// A candidate with no session does NOT count (a row in an unvisited project tab holds a slot but
/// has no process). A session absent from the candidate list does NOT count either — Rust cannot
/// tell a build agent from a plain shell, since a session id is just an agent id.
///
/// Both sides are de-duplicated, so a repeated id cannot inflate the claim.
pub fn count_live_processes(candidate_ids: &[String], sessions: &[(String, u32)]) -> u32 {
    let live: HashSet<&str> = sessions.iter().map(|(id, _)| id.as_str()).collect();
    let matched: HashSet<&str> = candidate_ids
        .iter()
        .map(|s| s.as_str())
        .filter(|id| live.contains(id))
        .collect();
    matched.len() as u32
}

/// p50 and p90 as the MIDPOINT of the bucket the rank falls in. Rank is `ceil(p × total)`,
/// 1-indexed, computed in integer arithmetic so it cannot drift with float rounding.
///
/// Resolution is ±32 MiB BY CONSTRUCTION — the histogram is what is stored, and a midpoint is the
/// most honest point estimate a bucket supports.
pub fn percentiles_from_hist(hist: &[u64], bucket_bytes: u64) -> (u64, u64) {
    let total: u64 = hist.iter().copied().sum();
    if total == 0 || bucket_bytes == 0 {
        return (0, 0);
    }
    let rank_at = |pct: u64| -> u64 {
        // ceil(total * pct / 100) without floats.
        (total.saturating_mul(pct) + 99) / 100
    };
    let midpoint_at = |rank: u64| -> u64 {
        let mut cum: u64 = 0;
        for (i, count) in hist.iter().enumerate() {
            cum += *count;
            if cum >= rank {
                return (i as u64) * bucket_bytes + bucket_bytes / 2;
            }
        }
        // Unreachable while `rank <= total`, but stated rather than unwrapped: the last bucket is
        // the honest answer if a caller ever hands in a rank past the end.
        ((hist.len().saturating_sub(1)) as u64) * bucket_bytes + bucket_bytes / 2
    };
    (midpoint_at(rank_at(50)), midpoint_at(rank_at(90)))
}

/// Merge rule 4b: fold every entry of `agent_rss` into the all-time memory block, one observation
/// each.
///
/// **An EMPTY slice returns `stats` byte-for-byte unchanged.** An empty `agentRss` means "no basis",
/// not "zero bytes" — folding it would drag a p50 of 0 into a real distribution, which is the same
/// rule `memoryAdmission` states for a null reading. An unmeasured machine is not an empty one.
pub fn fold_memory(stats: &MemoryStats, rss: &[AgentRssIn], now_ms: i64) -> MemoryStats {
    if rss.is_empty() {
        return stats.clone();
    }
    let mut out = stats.clone();

    // A record written by an older shape (or a hand-edited file) may carry a short/absent histogram
    // or a zero bucket width. Repair the SHAPE without discarding the counts already in it.
    if out.hist_bucket_bytes == 0 {
        out.hist_bucket_bytes = HIST_BUCKET_BYTES;
    }
    if out.hist.len() < HIST_LEN {
        out.hist.resize(HIST_LEN, 0);
    }

    for obs in rss {
        let idx = (obs.rss_bytes / out.hist_bucket_bytes).min(HIST_OVERFLOW_INDEX as u64) as usize;
        out.hist[idx] += 1;
        out.agent_observations += 1;
        out.proc_count_total += obs.proc_count as u64;
        out.proc_count_max = out.proc_count_max.max(obs.proc_count);
        // EXACT extremes, deliberately un-bucketed (see `MemoryStats::max_bytes`).
        out.max_bytes = out.max_bytes.max(obs.rss_bytes);
        if out.min_bytes == 0 || obs.rss_bytes < out.min_bytes {
            out.min_bytes = obs.rss_bytes;
        }
    }
    out.agents_seen_max = out.agents_seen_max.max(rss.len() as u32);
    out.observed = true;
    if out.first_at_ms == 0 {
        out.first_at_ms = now_ms;
        out.first_at_iso = format_iso8601_utc(now_ms);
    }
    out.last_at_ms = now_ms;
    out.last_at_iso = format_iso8601_utc(now_ms);

    // DERIVED, recomputed from scratch every merge — so the published numbers and the authoritative
    // histogram can never disagree.
    let (p50, p90) = percentiles_from_hist(&out.hist, out.hist_bucket_bytes);
    out.p50_bytes = p50;
    out.p90_bytes = p90;
    out.mean_proc_count_milli = if out.agent_observations > 0 {
        out.proc_count_total.saturating_mul(1000) / out.agent_observations
    } else {
        0
    };
    out
}

/// The UTC hour containing `now_ms`, floored. `div_euclid` rather than `/` so a pre-epoch timestamp
/// floors DOWN instead of toward zero.
pub fn hour_start_ms(now_ms: i64) -> i64 {
    now_ms.div_euclid(MS_PER_HOUR) * MS_PER_HOUR
}

/// `YYYY-MM-DDTHH:MM:SSZ`.
///
/// There is deliberately NO chrono/time crate in this Cargo.toml. The civil-date half is
/// `spend::civil_from_days` (Howard Hinnant's algorithm), reused rather than copied a THIRD time —
/// `concierge_guidelines::ymd_from_unix` is the second copy and formats a date only, with no
/// time-of-day, so it could not serve here.
pub fn format_iso8601_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = crate::spend::civil_from_days(days);
    let (hh, mm, ss) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Merge rules 1–6. PURE: `now_ms` is a PARAMETER, never `SystemTime::now()`, so every rule below
/// is driven deterministically by a test.
///
/// Rule 5 — **nothing ever decreases** — is what makes the record survive a restart: the caller
/// loads from disk before merging, so a fresh session that sees 3 agents leaves a stored peak of 41
/// untouched, and `hist` counts and `max_bytes` only ever accumulate across relaunches.
pub fn merge_sample(
    record: &PeakRecord,
    processes: u32,
    sample: &ConcurrencySampleIn,
    total_ram_bytes: u64,
    now_ms: i64,
) -> PeakRecord {
    let mut out = record.clone();
    // Stamped rather than trusted: a record loaded from an older shape must come back out naming the
    // headline the contract froze, not whatever string was on disk.
    out.version = VERSION;
    out.headline = HEADLINE.to_string();

    // Rule 1 + 2: STRICTLY greater, and the whole row together — so the FIRST occurrence keeps the
    // timestamp and a later tie does not relabel when it happened.
    if processes > out.peak.processes {
        out.peak = PeakRow {
            processes,
            live: sample.live,
            used: sample.used,
            limit: sample.limit,
            basis: sample.basis.clone(),
            total_ram_bytes,
            at_ms: now_ms,
            at_iso: format_iso8601_utc(now_ms),
        };
    }

    // Rule 4b, before the hourly fold so both halves see the same observations.
    out.memory = fold_memory(&out.memory, &sample.agent_rss, now_ms);

    // Rule 3 + 6.
    let hour = hour_start_ms(now_ms);
    let rss_sum: u64 = sample.agent_rss.iter().map(|o| o.rss_bytes).sum();
    let rss_max: u64 = sample.agent_rss.iter().map(|o| o.rss_bytes).max().unwrap_or(0);
    let proc_sum: u64 = sample.agent_rss.iter().map(|o| o.proc_count as u64).sum();
    match out.hourly.iter_mut().find(|h| h.hour_start_ms == hour) {
        Some(row) => {
            row.processes = row.processes.max(processes);
            row.live = row.live.max(sample.live);
            row.used = row.used.max(sample.used);
            row.limit = row.limit.max(sample.limit);
            row.total_ram_bytes = row.total_ram_bytes.max(total_ram_bytes);
            // MEAN and MAX, not percentiles: these three accumulate, `rss_max_bytes` takes the max.
            row.agent_observations += sample.agent_rss.len() as u64;
            row.rss_sum_bytes += rss_sum;
            row.rss_max_bytes = row.rss_max_bytes.max(rss_max);
            row.proc_count_total += proc_sum;
        }
        None => {
            out.hourly.push(HourRow {
                hour_start_ms: hour,
                hour_start_iso: format_iso8601_utc(hour),
                processes,
                live: sample.live,
                used: sample.used,
                limit: sample.limit,
                total_ram_bytes,
                agent_observations: sample.agent_rss.len() as u64,
                rss_sum_bytes: rss_sum,
                rss_max_bytes: rss_max,
                proc_count_total: proc_sum,
            });
            // Sorted rather than merely appended: a clock that steps backwards (NTP, a sleep/wake)
            // would otherwise leave the series out of order forever, and "oldest first" is the
            // property the FRONT-trim below depends on to keep the NEWEST.
            out.hourly.sort_by_key(|h| h.hour_start_ms);
        }
    }
    if out.hourly.len() > MAX_HOURLY {
        let drop = out.hourly.len() - MAX_HOURLY;
        out.hourly.drain(0..drop);
    }

    // Rule 4.
    out.samples += 1;
    out.updated_at_ms = now_ms;
    out.updated_at_iso = format_iso8601_utc(now_ms);
    out
}

// ============================== io ==============================

/// `<dir>/peak-concurrency.json`. A fixed filename — see {@link FILE_NAME}.
pub fn record_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Load the record, or `default()` when there is nothing readable there.
///
/// Missing, unreadable, malformed and un-parseable all collapse to the same answer on purpose: **a
/// peak we cannot parse is not evidence.** The caller then overwrites it. `#[serde(default)]` on
/// every struct means an OLDER or PARTIAL file still loads with its real numbers rather than being
/// discarded here — the discard is reserved for bytes that are not this record at all.
pub fn load_at(dir: &Path) -> PeakRecord {
    let path = record_path(dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return PeakRecord::default();
    };
    serde_json::from_str::<PeakRecord>(&text).unwrap_or_default()
}

/// Write the record ATOMICALLY (temp sibling + rename), so a shell reader
/// (`scripts/peak-concurrency.sh`) racing us never observes half a file.
///
/// Reuses `hooks::atomic_write_settings` rather than re-implementing the rename dance, so the two
/// properties that matter — invalid JSON is refused BEFORE the rename, and a reader never sees a
/// partial file — cannot drift between two copies.
pub fn write_at(dir: &Path, rec: &PeakRecord) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("peak concurrency record: mkdir: {e}"))?;
    let path = record_path(dir);
    let json = serde_json::to_string_pretty(rec)
        .map_err(|e| format!("peak concurrency record: serialize: {e}"))?;
    crate::hooks::atomic_write_settings(&path, &json)?;
    Ok(path)
}

// ============================== app-data root ==============================

/// Environment override for the app-data root, named in the frozen contract because the SHELL
/// reader's tests rely on it: `scripts/peak-concurrency.sh` and this writer must be pointable at one
/// temp dir so a test can exercise both halves against the same file.
const APP_DATA_ENV: &str = "SPARKLE_APP_DATA";

/// The override rule as a PURE function of the raw variable — no environment read.
///
/// An EMPTY value is ignored rather than treated as the root: an unset-but-exported variable is a
/// routine shell accident, and honoring it would relocate the record to `/peak-concurrency.json`.
///
/// Split from the `var_os` read for the reason `agent_goal_record` states at length:
/// `std::env::set_var` is process-global, `cargo test` runs this module's other tests on parallel
/// threads, and every one of them reaches `getenv` through `tempfile::tempdir()`. Concurrent
/// `setenv`/`getenv` is UB and surfaces as a rare segfault rather than a clean failure. With the
/// rule pure, its test asserts it with NO environment at all.
fn app_data_override_from(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

fn app_data_override() -> Option<PathBuf> {
    app_data_override_from(std::env::var_os(APP_DATA_ENV))
}

fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    match app_data_override() {
        Some(over) => Ok(over),
        None => crate::dev_identity::app_data_dir(app),
    }
}

/// Serializes the whole read-modify-write. **The frontend poll runs in EVERY window**, so concurrent
/// calls are the normal case, not an edge one — and an unsynchronized load→merge→write loses peaks
/// (two windows each read 40, each merge their own sample, and the second write erases the first).
fn merge_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ============================== tauri commands ==============================

/// Merge one sample into the record and return the merged result.
///
/// `async` + `spawn_blocking` because a sync `#[tauri::command]` body runs INLINE on the macOS
/// event-loop thread (see `memwatch::agent_memory_watchdog`), and this one does filesystem work on
/// a 5s poll from every window. The session pids are read on the sync side — a lock + clone, so the
/// `State` borrow ends before the blocking half, exactly as `agent_memory_watchdog` does it.
///
/// **This does NOT call `agent_footprints` or run `ps`.** The per-agent RSS arrives in
/// `sample.agent_rss`, already computed by `agent_memory_watchdog` on the same tick; a second
/// uncached `ps -axo` every 5 seconds is the cost that command's own doc comment warns about.
#[tauri::command]
pub async fn record_agent_concurrency(
    app: AppHandle,
    manager: tauri::State<'_, crate::pty::PtyManager>,
    sample: ConcurrencySampleIn,
) -> Result<PeakRecord, String> {
    let dir = app_data_root(&app)?;
    let sessions = manager.session_pids();
    tauri::async_runtime::spawn_blocking(move || {
        // Poisoned is not a reason to stop recording: the data this guards is append-only counters,
        // so a panicking peer left nothing half-applied that a later merge could not tolerate.
        let _guard = merge_lock().lock().unwrap_or_else(|e| e.into_inner());
        let processes = count_live_processes(&sample.agent_ids, &sessions);
        // Rust reads the machine itself. `0` when unmeasurable — in-band, never a `null`.
        let total_ram_bytes = crate::memwatch::sampler().sample().map_or(0, |s| s.total_bytes);
        let merged = merge_sample(&load_at(&dir), processes, &sample, total_ram_bytes, now_ms());
        write_at(&dir, &merged)?;
        Ok(merged)
    })
    .await
    .map_err(|e| format!("record_agent_concurrency task failed: {e}"))?
}

/// The record as it stands. A PURE READ — no merge, no write, no sample counted.
#[tauri::command]
pub async fn agent_concurrency_peak(app: AppHandle) -> Result<PeakRecord, String> {
    let dir = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_at(&dir))
        .await
        .map_err(|e| format!("agent_concurrency_peak task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("agent-{i}")).collect()
    }

    fn rss(entries: &[(u64, u32)]) -> Vec<AgentRssIn> {
        entries
            .iter()
            .enumerate()
            .map(|(i, (bytes, procs))| AgentRssIn {
                agent_id: format!("agent-{i}"),
                rss_bytes: *bytes,
                proc_count: *procs,
            })
            .collect()
    }

    fn sample(live: u32, used: u32, limit: u32, agent_rss: Vec<AgentRssIn>) -> ConcurrencySampleIn {
        ConcurrencySampleIn {
            agent_ids: Vec::new(),
            live,
            used,
            limit,
            basis: "RAM-bound: test".to_string(),
            agent_rss,
        }
    }

    /// THE REASON THIS RECORD EXISTS. A peak that resets on relaunch is worthless — that reset is
    /// precisely the bug that left the app with no history at all.
    ///
    /// Simulates a real relaunch: seed a record, drop it, `load_at` FRESH from disk, merge a small
    /// sample, write, load AGAIN. Every assertion is on the value read back off the disk, so the
    /// test fails if the load step is ever dropped from the command's read-modify-write.
    #[test]
    fn survives_restart() {
        let d = dir();
        let seeded_at = 1_700_000_000_000_i64;

        let mut seed = PeakRecord::default();
        seed.peak = PeakRow {
            processes: 41,
            live: 39,
            used: 47,
            limit: 81,
            basis: "RAM-bound: the original".to_string(),
            total_ram_bytes: 128 * GIB,
            at_ms: seeded_at,
            at_iso: format_iso8601_utc(seeded_at),
        };
        seed.memory = fold_memory(&MemoryStats::default(), &rss(&[(1 * GIB, 2); 8]), seeded_at);
        seed.samples = 500;
        write_at(d.path(), &seed).expect("seed write");
        let seeded_observations = seed.memory.agent_observations;
        assert_eq!(seeded_observations, 8, "control: the seed really carries observations");
        drop(seed);

        // ── relaunch ──
        let reloaded = load_at(d.path());
        let later = seeded_at + 9 * MS_PER_HOUR;
        let merged = merge_sample(
            &reloaded,
            3, // a fresh session with three agents up
            &sample(3, 4, 81, rss(&[(700 * 1024 * 1024, 1); 3])),
            64 * GIB, // a different machine reading, which must NOT overwrite the peak's
            later,
        );
        write_at(d.path(), &merged).expect("merge write");

        let after = load_at(d.path());
        assert_eq!(after.peak.processes, 41, "a smaller sample must not lower the stored peak");
        assert_eq!(after.peak.at_ms, seeded_at, "the peak's timestamp is the ORIGINAL moment");
        assert_eq!(after.peak.total_ram_bytes, 128 * GIB, "the whole peak row moves together");
        assert_eq!(after.peak.basis, "RAM-bound: the original");
        assert!(
            after.memory.agent_observations > seeded_observations,
            "the memory block must GROW across a restart, not reset: {} vs {}",
            after.memory.agent_observations,
            seeded_observations
        );
        assert_eq!(after.memory.agent_observations, 11);
        assert_eq!(after.samples, 501, "samples accumulate across the relaunch");
    }

    /// The headline counts LIVE PROCESSES, not roster rows. Ten rows claim to be agents; only three
    /// have a PTY session with a pid.
    #[test]
    fn counts_live_processes_not_roster_rows() {
        let candidates = ids(10);
        let sessions: Vec<(String, u32)> = vec![
            ("agent-1".to_string(), 111),
            ("agent-4".to_string(), 444),
            ("agent-9".to_string(), 999),
        ];
        assert_eq!(count_live_processes(&candidates, &sessions), 3);

        // …and that count, not `used`, is what lands in the peak. The numbers are deliberately
        // distinct so a swapped field is visible.
        let merged = merge_sample(
            &PeakRecord::default(),
            3,
            &sample(5, 47, 81, Vec::new()),
            128 * GIB,
            1_700_000_000_000,
        );
        assert_eq!(merged.peak.processes, 3, "processes is the PTY count");
        assert_eq!(merged.peak.used, 47, "used is stored beside it, never as the headline");
        assert_eq!(merged.peak.live, 5);
        assert_eq!(merged.headline, "processes");
    }

    /// The intersection is symmetric: Rust cannot tell a build agent from a plain shell, so a
    /// session the frontend did not nominate is NOT an agent.
    #[test]
    fn a_session_absent_from_the_candidate_list_does_not_count() {
        let candidates = vec!["agent-a".to_string()];
        let sessions = vec![
            ("agent-a".to_string(), 1),
            ("some-terminal".to_string(), 2),
            ("agent-zzz".to_string(), 3),
        ];
        assert_eq!(count_live_processes(&candidates, &sessions), 1);
        // …and the mirror case: a nominated row with no session is not running.
        assert_eq!(count_live_processes(&ids(10), &[]), 0);
    }

    /// Merge rule 1 + 2: STRICTLY greater. A tie must not relabel when the peak happened, and a new
    /// peak replaces the ENTIRE row rather than any field independently.
    #[test]
    fn peak_replaces_only_on_strictly_greater() {
        let first_at = 1_700_000_000_000_i64;
        let base = merge_sample(
            &PeakRecord::default(),
            10,
            &sample(10, 12, 81, Vec::new()),
            128 * GIB,
            first_at,
        );
        assert_eq!(base.peak.at_ms, first_at);

        let tie = merge_sample(
            &base,
            10,
            &ConcurrencySampleIn { basis: "TIED".into(), ..sample(99, 99, 99, Vec::new()) },
            1,
            first_at + 60_000,
        );
        assert_eq!(tie.peak.at_ms, first_at, "an equal sample must not relabel the peak's time");
        assert_eq!(tie.peak.live, 10, "…nor bleed any other field of the row in");
        assert_eq!(tie.peak.basis, "RAM-bound: test");
        assert_eq!(tie.peak.total_ram_bytes, 128 * GIB);

        let greater_at = first_at + 120_000;
        let up = merge_sample(
            &tie,
            11,
            &ConcurrencySampleIn { basis: "NEW".into(), ..sample(11, 13, 90, Vec::new()) },
            64 * GIB,
            greater_at,
        );
        assert_eq!(up.peak.processes, 11);
        assert_eq!(up.peak.at_ms, greater_at);
        assert_eq!(up.peak.at_iso, format_iso8601_utc(greater_at));
        assert_eq!(up.peak.live, 11);
        assert_eq!(up.peak.used, 13);
        assert_eq!(up.peak.limit, 90);
        assert_eq!(up.peak.basis, "NEW");
        assert_eq!(up.peak.total_ram_bytes, 64 * GIB, "the whole row moved together");
    }

    /// Merge rule 3 + 6: one row per UTC hour taking the element-wise max of the counts, while the
    /// memory half ACCUMULATES; oldest-first; trimmed from the FRONT so the newest survive.
    #[test]
    fn hourly_series_collapses_maxes_accumulates_memory_and_trims_the_front() {
        let h0 = 1_700_000_000_000_i64 - 1_700_000_000_000_i64.rem_euclid(MS_PER_HOUR);

        let a = merge_sample(
            &PeakRecord::default(),
            7,
            &sample(7, 9, 81, rss(&[(1 * GIB, 2), (2 * GIB, 3)])),
            128 * GIB,
            h0 + 60_000,
        );
        let b = merge_sample(
            &a,
            4,
            &sample(12, 5, 81, rss(&[(3 * GIB, 1)])),
            128 * GIB,
            h0 + 3_000_000, // still inside the same hour
        );
        assert_eq!(b.hourly.len(), 1, "two samples in one hour collapse to one row");
        let row = &b.hourly[0];
        assert_eq!(row.hour_start_ms, h0);
        assert_eq!(row.hour_start_iso, format_iso8601_utc(h0));
        assert_eq!(row.processes, 7, "element-wise MAX of the counts");
        assert_eq!(row.live, 12, "…each field independently");
        assert_eq!(row.used, 9);
        // The memory half is MEAN and MAX, so these accumulate rather than taking a max.
        assert_eq!(row.agent_observations, 3);
        assert_eq!(row.rss_sum_bytes, 6 * GIB);
        assert_eq!(row.rss_max_bytes, 3 * GIB);
        assert_eq!(row.proc_count_total, 6);

        let c = merge_sample(&b, 2, &sample(2, 2, 81, Vec::new()), 128 * GIB, h0 + MS_PER_HOUR + 5);
        assert_eq!(c.hourly.len(), 2, "the next hour appends");
        assert_eq!(c.hourly[0].hour_start_ms, h0, "oldest first");
        assert_eq!(c.hourly[1].hour_start_ms, h0 + MS_PER_HOUR);

        // Past the ring size, the FRONT is dropped and the NEWEST is kept.
        let mut rec = PeakRecord::default();
        for i in 0..(MAX_HOURLY as i64 + 5) {
            rec = merge_sample(&rec, 1, &sample(1, 1, 81, Vec::new()), 128 * GIB, h0 + i * MS_PER_HOUR);
        }
        assert_eq!(rec.hourly.len(), MAX_HOURLY);
        assert_eq!(rec.hourly[0].hour_start_ms, h0 + 5 * MS_PER_HOUR, "trimmed from the front");
        assert_eq!(
            rec.hourly[MAX_HOURLY - 1].hour_start_ms,
            h0 + (MAX_HOURLY as i64 + 4) * MS_PER_HOUR,
            "the newest hour survives"
        );
    }

    /// "An unmeasured machine is not an empty one." An empty `agentRss` means NO BASIS, and must
    /// leave the memory block byte-for-byte unchanged — never fold in a p50 of 0.
    ///
    /// Asserted against a POPULATED block, so returning zeros (the tempting bug) fails loudly
    /// instead of trivially satisfying an equality against a default.
    #[test]
    fn empty_agent_rss_changes_nothing() {
        let populated = fold_memory(
            &MemoryStats::default(),
            &rss(&[(1 * GIB, 2), (2 * GIB, 3), (900 * 1024 * 1024, 1)]),
            1_700_000_000_000,
        );
        assert!(populated.observed && populated.p50_bytes > 0, "control: the block is populated");

        let after = fold_memory(&populated, &[], 1_700_009_999_999);
        assert_eq!(after, populated, "an empty agentRss must change nothing at all");
        // Spelled out field-for-field on the ones a "just zero it" bug would hit first.
        assert_eq!(after.p50_bytes, populated.p50_bytes);
        assert_eq!(after.min_bytes, populated.min_bytes);
        assert_eq!(after.agent_observations, populated.agent_observations);
        assert_eq!(after.last_at_ms, populated.last_at_ms, "not even the clock moves");

        // …and through the real merge path, where the rest of the record still advances.
        let mut rec = PeakRecord::default();
        rec.memory = populated.clone();
        let merged = merge_sample(&rec, 5, &sample(5, 5, 81, Vec::new()), 128 * GIB, 1_700_009_999_999);
        assert_eq!(merged.memory, populated, "a sample with no RSS report leaves memory alone");
        assert_eq!(merged.samples, 1, "control: the merge really ran");
    }

    /// Percentiles are the MIDPOINT of the bucket the rank falls in, with the rank `ceil(p × total)`.
    #[test]
    fn percentiles_are_bucket_midpoints_and_count_the_overflow() {
        let b = HIST_BUCKET_BYTES;

        // Hand-computable: 100 observations spread over four buckets.
        //   idx 1: 10  (cum 10)   idx 2: 40 (cum 50)   idx 3: 40 (cum 90)   idx 9: 10 (cum 100)
        //   p50 rank = ceil(50)  = 50  -> lands in idx 2
        //   p90 rank = ceil(90)  = 90  -> lands in idx 3
        let mut hist = vec![0u64; HIST_LEN];
        hist[1] = 10;
        hist[2] = 40;
        hist[3] = 40;
        hist[9] = 10;
        assert_eq!(percentiles_from_hist(&hist, b), (2 * b + b / 2, 3 * b + b / 2));

        // ALL MASS IN ONE BUCKET: both percentiles are that bucket's midpoint.
        let mut single = vec![0u64; HIST_LEN];
        single[10] = 100;
        assert_eq!(percentiles_from_hist(&single, b), (10 * b + b / 2, 10 * b + b / 2));

        // THE OVERFLOW BUCKET IS COUNTED, not dropped and not clamped into a real bucket. Five small
        // observations and five ≥ 8 GiB: p50 rank 5 is still small, p90 rank 9 lands in the overflow.
        let mut over = vec![0u64; HIST_LEN];
        over[0] = 5;
        over[HIST_OVERFLOW_INDEX] = 5;
        let (p50, p90) = percentiles_from_hist(&over, b);
        assert_eq!(p50, b / 2);
        assert_eq!(p90, HIST_OVERFLOW_INDEX as u64 * b + b / 2, "the overflow bucket must be reachable");
        assert!(p90 >= 8 * GIB, "p90 must not be clamped below the overflow floor: {p90}");

        // An empty histogram has no percentile — 0, not a panic and not a fabricated bucket.
        assert_eq!(percentiles_from_hist(&vec![0u64; HIST_LEN], b), (0, 0));

        // And a real ≥ 8 GiB observation lands there via the fold, rather than being discarded.
        let folded = fold_memory(&MemoryStats::default(), &rss(&[(9 * GIB, 4)]), 1);
        assert_eq!(folded.hist[HIST_OVERFLOW_INDEX], 1, "a 9 GiB agent is counted, not dropped");
        assert_eq!(folded.hist.iter().sum::<u64>(), 1, "…and counted exactly once");
    }

    /// `max_bytes` / `min_bytes` are EXACT. A bucketed max would understate the worst case by up to
    /// 64 MiB, and the worst case is the whole point of a max.
    #[test]
    fn exact_extremes_are_not_bucketed() {
        let odd_high = 3 * GIB + 12_345_678; // deliberately not a bucket multiple
        let odd_low = 201_326_593; // one byte past a bucket edge
        let folded = fold_memory(&MemoryStats::default(), &rss(&[(odd_high, 3), (odd_low, 1)]), 1);

        assert_eq!(folded.max_bytes, odd_high, "max must be the exact observation");
        assert_eq!(folded.min_bytes, odd_low, "min must be the exact observation");
        // The tells that a bucketed implementation would produce instead.
        let edge = odd_high / HIST_BUCKET_BYTES * HIST_BUCKET_BYTES;
        assert_ne!(folded.max_bytes, edge, "not the bucket edge");
        assert_ne!(folded.max_bytes, edge + HIST_BUCKET_BYTES / 2, "not the bucket midpoint");
        assert_eq!(folded.proc_count_max, 3);

        // `min_bytes == 0` means UNSET, and the FIRST observation sets it — a default of 0 must not
        // survive as an eternal minimum.
        assert_ne!(folded.min_bytes, 0);
    }

    /// **THE GUARD ON THE TRAP.** An agent is a process TREE (measured mean ~1.95, peak 5). A
    /// "520 MB per agent" claim was derived from per-PROCESS data twice and was wrong both times;
    /// bead `sparkle-mjmuj` is the standing refutation and says in its own title not to re-derive it.
    ///
    /// `mean_proc_count_milli` is the published tell. NEAR 1000 ⇒ one process per "agent" ⇒ the data
    /// is per-process and every RSS figure beside it is roughly half what it should be.
    #[test]
    fn mean_proc_count_is_per_agent_not_per_process() {
        // 20 agent observations: 19 trees of 2 processes, one of 1 → 39/20 = 1.95 processes/agent.
        let mut obs: Vec<AgentRssIn> = rss(&[(1 * GIB, 2); 19]);
        obs.push(AgentRssIn { agent_id: "lonely".into(), rss_bytes: 1 * GIB, proc_count: 1 });
        let folded = fold_memory(&MemoryStats::default(), &obs, 1);

        assert_eq!(folded.agent_observations, 20, "one observation per AGENT, not per process");
        assert_eq!(folded.proc_count_total, 39);
        assert_eq!(folded.mean_proc_count_milli, 1950, "1.950 processes per agent");

        // sparkle-mjmuj: a mean near 1000 is the tell that the source was per-PROCESS. Assert the
        // published number is nowhere near it, so a future change that swaps the source in fails
        // HERE rather than in a public claim.
        assert!(
            folded.mean_proc_count_milli > 1500,
            "a mean near 1000 means per-PROCESS data (sparkle-mjmuj) — got {}",
            folded.mean_proc_count_milli
        );
        assert_eq!(folded.agents_seen_max, 20);
    }

    /// The frozen fixture is the SHARED instance: these tests and the shell tests parse the same
    /// file, so the two halves cannot drift apart silently.
    ///
    /// The last assertion is the ANTI-DRIFT one: recomputing the percentiles from the fixture's own
    /// histogram must reproduce the values stored beside it. `hist` is authoritative; `p50`/`p90` are
    /// derived. If they ever disagree, one of them is a lie and this says which.
    #[test]
    fn the_frozen_fixture_parses() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/tests/fixtures/peak-concurrency.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let rec: PeakRecord = serde_json::from_str(&text).expect("the fixture must parse");

        assert_eq!(rec.version, 1);
        assert_eq!(rec.headline, "processes");
        assert_eq!(rec.peak.processes, 41);
        assert_eq!(rec.hourly.len(), 2);
        assert_eq!(rec.memory.hist.len(), HIST_LEN);
        assert_eq!(rec.memory.hist_bucket_bytes, HIST_BUCKET_BYTES);
        assert_eq!(
            rec.memory.hist.iter().sum::<u64>(),
            rec.memory.agent_observations,
            "the histogram must account for every observation"
        );
        assert_eq!(
            percentiles_from_hist(&rec.memory.hist, rec.memory.hist_bucket_bytes),
            (rec.memory.p50_bytes, rec.memory.p90_bytes),
            "the stored percentiles and the authoritative histogram must agree"
        );

        // Round-trip: every contract key must survive serialization, or the shell reader (which
        // greps for them by name) goes blind.
        let back = serde_json::to_value(&rec).expect("serialize");
        let obj = back.as_object().expect("an object");
        for key in ["version", "headline", "peak", "memory", "hourly", "samples", "updated_at_ms", "updated_at_iso"] {
            assert!(obj.contains_key(key), "missing top-level key {key}");
        }
        let peak = obj["peak"].as_object().unwrap();
        for key in ["processes", "live", "used", "limit", "basis", "total_ram_bytes", "at_ms", "at_iso"] {
            assert!(peak.contains_key(key), "missing peak key {key}");
        }
        let mem = obj["memory"].as_object().unwrap();
        for key in [
            "observed", "agent_observations", "agents_seen_max", "p50_bytes", "p90_bytes",
            "max_bytes", "min_bytes", "proc_count_total", "proc_count_max",
            "mean_proc_count_milli", "hist_bucket_bytes", "hist", "first_at_ms", "first_at_iso",
            "last_at_ms", "last_at_iso",
        ] {
            assert!(mem.contains_key(key), "missing memory key {key}");
        }
        let hour = obj["hourly"][0].as_object().unwrap();
        for key in [
            "hour_start_ms", "hour_start_iso", "processes", "live", "used", "limit",
            "total_ram_bytes", "agent_observations", "rss_sum_bytes", "rss_max_bytes",
            "proc_count_total",
        ] {
            assert!(hour.contains_key(key), "missing hourly key {key}");
        }
        // No `null` anywhere: every field is TOTAL in both directions (sparkle-16y6h).
        assert!(!text.contains("null"), "the fixture must carry no nulls");
        assert!(!serde_json::to_string(&rec).unwrap().contains("null"), "we must emit no nulls");
    }

    /// A peak we cannot parse is not evidence. Garbage loads as `default()` without panicking, and
    /// the caller then overwrites it.
    #[test]
    fn malformed_is_not_evidence() {
        let d = dir();
        std::fs::write(record_path(d.path()), b"\x00\x01 not json at all {{{").expect("write");
        let rec = load_at(d.path());
        assert_eq!(rec, PeakRecord::default());
        assert_eq!(rec.samples, 0);
        assert_eq!(rec.peak.processes, 0);
        assert!(!rec.memory.observed, "no reading is not a reading of zero");

        // A MISSING file is the same answer — the ordinary state on a first run.
        assert_eq!(load_at(dir().path()), PeakRecord::default());

        // …and a PARTIAL record still loads its real numbers rather than being discarded, because
        // the shape grew once already.
        let d2 = dir();
        std::fs::write(record_path(d2.path()), r#"{"peak":{"processes":41},"samples":9}"#).unwrap();
        let partial = load_at(d2.path());
        assert_eq!(partial.peak.processes, 41, "an older/partial file must LOAD, not be discarded");
        assert_eq!(partial.samples, 9);
        assert_eq!(partial.memory.hist.len(), HIST_LEN, "the missing half defaults to the shape");
    }

    /// The write must be atomic and the round trip lossless.
    #[test]
    fn write_then_load_round_trips() {
        let d = dir();
        let rec = merge_sample(
            &PeakRecord::default(),
            41,
            &sample(39, 47, 81, rss(&[(1 * GIB, 2), (9 * GIB, 5)])),
            128 * GIB,
            1_700_000_000_000,
        );
        let path = write_at(d.path(), &rec).expect("write");
        assert_eq!(path, record_path(d.path()));
        assert_eq!(load_at(d.path()), rec);

        // No staging debris left beside the record for the shell reader to trip over.
        let entries: Vec<String> = std::fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![FILE_NAME.to_string()], "stray files: {entries:?}");
    }

    #[test]
    fn formats_iso8601_utc() {
        assert_eq!(format_iso8601_utc(0), "1970-01-01T00:00:00Z");
        // A leap day, and one on a century that IS a leap year (2000) — the two cases a naive
        // "every 4 years" rule gets wrong in opposite directions.
        assert_eq!(format_iso8601_utc(1_709_210_096_000), "2024-02-29T12:34:56Z");
        assert_eq!(format_iso8601_utc(951_868_799_000), "2000-02-29T23:59:59Z");
        assert_eq!(format_iso8601_utc(1_787_424_000_000), "2026-08-22T18:40:00Z");
        // Sub-second remainders floor rather than round, so a stamp never reads ahead of its ms.
        assert_eq!(format_iso8601_utc(1_787_424_000_999), "2026-08-22T18:40:00Z");
    }

    #[test]
    fn hour_start_floors_to_the_utc_hour() {
        let h = 1_787_421_600_000_i64; // 2026-08-22T18:00:00Z
        assert_eq!(hour_start_ms(h), h);
        assert_eq!(hour_start_ms(h + 1), h);
        assert_eq!(hour_start_ms(h + MS_PER_HOUR - 1), h);
        assert_eq!(hour_start_ms(h + MS_PER_HOUR), h + MS_PER_HOUR);
        assert_eq!(format_iso8601_utc(hour_start_ms(h + 59 * 60_000)), "2026-08-22T18:00:00Z");
        // Pre-epoch floors DOWN, not toward zero — `/` would give 0 here and mislabel the hour.
        assert_eq!(hour_start_ms(-1), -MS_PER_HOUR);
    }

    /// `SPARKLE_APP_DATA` is the seam the shell reader's tests point at a temp dir. Driven as a PURE
    /// function with NO environment access: `std::env::set_var` is process-global, `cargo test` runs
    /// this module's other tests on parallel threads, and concurrent `setenv`/`getenv` is UB that
    /// surfaces as a rare segfault rather than a clean failure. See `app_data_override_from`.
    #[test]
    fn honors_app_data_env_override_rule() {
        let d = dir();
        let root = d.path().join("overridden-app-data");
        let over = app_data_override_from(Some(root.clone().into_os_string()))
            .expect("a non-empty override must be read");
        assert_eq!(over, root);

        // The override really carries a record — the rule is only useful if the path is used.
        let written = write_at(&over, &PeakRecord::default()).expect("write under the override");
        assert!(written.starts_with(&root), "record landed outside the override: {}", written.display());

        assert_eq!(
            app_data_override_from(Some(std::ffi::OsString::new())),
            None,
            "an empty override must be ignored — honoring it would relocate the record to /"
        );
        assert_eq!(app_data_override_from(None), None, "an unset variable is no override");
    }
}

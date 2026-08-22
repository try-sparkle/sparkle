//! Runtime memory MEASUREMENT — the half of the concurrency ceiling that `config.rs` cannot do.
//!
//! `config.rs` PREDICTS: it reads *installed* RAM once, memoizes it in a `OnceLock`, divides by an
//! assumed per-agent budget and calls that the ceiling. That prediction is blind to everything that
//! actually decides whether the next agent fits — how much memory is *available right now*, whether
//! the compressor is thrashing, whether Chrome and Xcode are resident, whether one agent has run
//! itself up past its assumed share. On 2026-07-20 the ramp that jetsam-killed a machine "was
//! visible for five minutes before the machine became unrecoverable. Nothing watched it"
//! (`sparkle-0bye`). This module is the thing that watches it.
//!
//! Two products, both built on the same injectable seam:
//!
//! 1. **A sampled admission bound** ([`sampled_admission`]). It can only ever LOWER the count the
//!    static derivation admits, never raise it. That "additive, can only refuse" property is
//!    deliberate and load-bearing: it is what let the previous global-cap change land without
//!    disturbing 34 existing tests, and it means a broken/absent sampler degrades to exactly
//!    today's behavior rather than to an unbounded one.
//! 2. **A per-agent RSS watchdog** ([`agent_footprints`] + [`watchdog_verdicts`]). Auto-kill is
//!    OPT-IN; the default is to warn and offer, because killing an agent throws away the user's
//!    work and a false positive is worse than a slow machine.
//!
//! **The trap this module is written around: RSS per PROCESS is not RSS per AGENT.** Two separate
//! people have sized the budget off a single pid. Measured 2026-07-29 on the dev machine: 37 live
//! `claude` processes across 19 agent worktrees = **1.95 processes per agent** (peak 5 when an agent
//! runs subagents), 21.1 GiB total = **1.11 GiB per AGENT** against 582 MiB mean per PROCESS. So
//! [`agent_footprints`] sums the whole descendant TREE of an agent's root pid, and the admission
//! arithmetic below divides available memory by a per-AGENT figure.
//!
//! Everything that makes a decision here is a pure function over a [`MemorySample`] / a process
//! table, so tests drive it deterministically. Nothing in a unit test shells out to `vm_stat`.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::config::{agent_ram_budget_mb, Bound};

// ============================== the sample ==============================

/// How hard the OS is currently squeezing. Ordered: `Normal < Warn < Critical`, so `.max()` of two
/// independently derived readings is "the more alarming of the two", which is the direction this
/// module always errs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PressureLevel {
    Normal,
    Warn,
    Critical,
}

/// One reading of the machine's memory at an instant. Distinct from `config.rs`'s installed-RAM
/// figure in the only way that matters: this one changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MemorySample {
    /// Physical RAM installed. Same number `config.rs` memoizes; carried here so a consumer can
    /// state the fraction without re-reading sysctl.
    pub total_bytes: u64,
    /// What could be handed to a new process without evicting something that is in use: free +
    /// inactive + speculative + purgeable. Deliberately NOT `total - resident`: on macOS the file
    /// cache is resident and reclaimable, and treating it as consumed would refuse every spawn on
    /// a machine that has merely been running for a while.
    pub available_bytes: u64,
    /// Bytes the compressor holds. A large value with low `available_bytes` is the signature of the
    /// pre-jetsam ramp — the machine is *working* to stay alive rather than merely being full.
    pub compressed_bytes: u64,
    /// Swap in use. Non-zero means the prediction has already been wrong.
    pub swap_used_bytes: u64,
    /// The level to act on: the more alarming of what the OS reports and what the numbers above
    /// imply (see [`classify_pressure`]).
    pub level: PressureLevel,
}

/// The seam. The real implementation shells out; tests use [`FixedSampler`].
pub trait MemorySampler: Send + Sync {
    /// `None` = "could not measure", which callers must treat as "no basis to narrow" (i.e. leave
    /// the static ceiling alone), never as "zero available".
    fn sample(&self) -> Option<MemorySample>;
}

/// A sampler that returns a fixed reading. Not `#[cfg(test)]`: it is also how a caller injects a
/// reading it already has, and how the admission path is exercised from an integration test.
///
/// `allow(dead_code)` because the APP does not construct one — only tests and future injectors do,
/// and a non-test build would otherwise warn. Deliberately kept rather than gated behind
/// `cfg(test)`, so the seam stays available to integration tests and to a headless mode.
#[allow(dead_code)]
pub struct FixedSampler(pub Option<MemorySample>);

impl MemorySampler for FixedSampler {
    fn sample(&self) -> Option<MemorySample> {
        self.0
    }
}

/// Classify a reading. Pure, so the thresholds are testable and reviewable in one place.
///
/// The fractions are chosen against the measured coalition, not invented: a 32 GiB Mac running
/// Sparkle normally was measured at 33.48 GiB resident (`sparkle-hfhs`) — i.e. it crosses into
/// swap during ORDINARY work. Warn at 20% available catches that machine while it can still be
/// saved; critical at 8% is past the point where a new agent is a bet against the compressor.
///
/// **Swap is a CORROBORATING signal, not an independent trigger** (roborev 55384, High). It used to
/// escalate on its own — `swap_used_bytes >= 1 GiB` → `Warn`, `>= 4 GiB` → `Critical`, whatever the
/// free pool looked like. That is wrong because macOS's `vm.swapusage used` is a cumulative
/// high-water figure, not a live one: pages written to the swapfiles stay counted until they are
/// faulted back in, so a Mac that swapped during one heavy build keeps reporting GiBs of swap for
/// hours afterward while Activity Monitor shows green. `compose_sample` takes `max(os_level,
/// derived)`, so the kernel reporting `Normal` could not undo it.
///
/// The concrete failure: a 128 GiB Mac with 95 GiB free and 4.2 GiB of stale swap classified
/// `Critical` forever, and `sampled_admission` held admission at `in_use` — so after the first agent
/// started, every subsequent spawn was refused with "refused: memory pressure is CRITICAL (95.0 GiB
/// available of 128.0 GiB…)". `pressure_gate` defaults to `true` and the frontend gate consumes this,
/// so that was the shipped path: a permanent false refusal on a healthy machine, which is this
/// module's own stated anti-goal ("a warning that is always on is a warning the user learns to
/// dismiss").
///
/// So swap now only escalates when the free pool is ALSO tight enough to make swapping plausible as
/// a present-tense fact rather than a historical one. Chosen over a rate signal (`vm_stat`
/// swapins/swapouts deltas) because a rate needs two samples and a retained previous reading, which
/// this deliberately-pure function cannot have; the conjunction gets the same protection with no
/// state. If a rate signal is ever wanted, it belongs in `compose_sample`, which already sees the
/// raw `vm_stat` text.
/// The absolute free pool below which heavy swap counts as PRESENT-TENSE pressure, not history.
///
/// Three agents' worth of the derived per-agent budget (1536 MiB — `agent_ram_budget_mb(3072)`). Held
/// as a literal rather than computed from `agent_ram_budget_mb` because `classify_pressure` is pure
/// over its three arguments and taking a config-derived fourth would make every caller and test thread
/// the heap ceiling through; the constant is asserted against the real budget in
/// `the_swap_headroom_floor_tracks_the_per_agent_budget` so the two cannot silently drift.
///
/// Sized so a machine with room for only a couple more agents AND GiBs of swap is judged squeezed,
/// while one with tens of GiB free is not — the distinction a percentage could not draw across both
/// 16 GiB and 128 GiB hosts.
const SWAP_CRITICAL_HEADROOM_BYTES: u64 = 3 * 1536 * 1024 * 1024;

pub fn classify_pressure(available_bytes: u64, total_bytes: u64, swap_used_bytes: u64) -> PressureLevel {
    const GIB: u64 = 1024 * 1024 * 1024;
    // A machine whose total we don't know cannot be judged by fraction. Judge it by swap alone —
    // this is the one case where swap must stand on its own, because there is nothing to corroborate
    // it against, and an unmeasurable total is not a reason to assume health.
    let Some(frac_pct) = (total_bytes > 0)
        .then(|| available_bytes.saturating_mul(100) / total_bytes)
    else {
        // No total, so no fraction — but `available_bytes` is still a real reading, and the absolute
        // rule below does not need the total at all. Apply exactly that rule: heavy swap plus a free
        // pool too small for a few more agents is a hard stop; heavy swap alone is a throttle.
        return if swap_used_bytes >= 4 * GIB && available_bytes < SWAP_CRITICAL_HEADROOM_BYTES {
            PressureLevel::Critical
        } else if swap_used_bytes >= 1 * GIB {
            PressureLevel::Warn
        } else {
            PressureLevel::Normal
        };
    };

    // The corroboration window: below this fraction, swap is evidence the machine is squeezed NOW.
    // Above it, GiBs of `used` swap are almost certainly a leftover high-water mark. 35% is set
    // deliberately above the `Warn` fraction so swap can escalate a machine that is merely getting
    // tight (25% free + swapping → Warn) without being able to touch one that is comfortable.
    const SWAP_CORROBORATION_PCT: u64 = 35;
    let swap_corroborated = frac_pct < SWAP_CORROBORATION_PCT;

    // `Critical` needs either a measured tiny free FRACTION, or heavy swap alongside a tiny ABSOLUTE
    // free pool. Third pass over this condition; the reasoning of all three is worth keeping, because
    // each correction over-shot in the opposite direction.
    //
    //  1. Originally swap escalated on its own: `>= 4 GiB` → `Critical`, whatever was free. Since
    //     macOS's `vm.swapusage used` is a cumulative high-water figure, a 128 GiB Mac with 95 GiB
    //     free and hours-old swap froze admission permanently (roborev 55384).
    //  2. Making swap merely *corroborated* (also require `frac_pct < 35`) fixed that 47%-free case
    //     but left a narrower copy: 32–44 GiB free on a 128 GiB Mac still froze (roborev 55425).
    //  3. Capping swap at `Warn` outright fixed THAT and broke the case the module exists for
    //     (roborev 55450): on the 32 GiB Mac `sparkle-hfhs` measured at 33.48 GiB resident — i.e.
    //     swapping during ORDINARY work — the 8–20% band is only 2.5–6.4 GiB free, and dropping the
    //     freeze there admits 1–4 more agents straight onto the pre-jetsam ramp.
    //
    // A percentage cannot express "there is almost nothing left" on both a 16 GiB and a 128 GiB
    // machine, which is why every pass that used one alone was wrong somewhere. So swap now escalates
    // on ABSOLUTE headroom: heavy swap plus a free pool too small to hold a few more agents is
    // present-tense evidence, not history.
    //
    // Three reasons this must not lean on anything else to supply that verdict, all documented in
    // this file already: `available_bytes` deliberately counts inactive/speculative/purgeable, so it
    // reads optimistically exactly when the compressor is working; `compose_sample`'s note says
    // `kern.memorystatus_vm_pressure_level` "reports NORMAL right up until the kernel is nearly ready
    // to jetsam", so `os_level` cannot be relied on for it; and `compressed_bytes` — called out at the
    // top of this file as *the* signature of the pre-jetsam ramp — is still never passed in here. That
    // last one is a real gap and is filed rather than fixed in this pass.
    if frac_pct < 8 || (swap_used_bytes >= 4 * GIB && available_bytes < SWAP_CRITICAL_HEADROOM_BYTES) {
        return PressureLevel::Critical;
    }
    if frac_pct < 20 || (swap_corroborated && swap_used_bytes >= 1 * GIB) {
        return PressureLevel::Warn;
    }
    PressureLevel::Normal
}

// ============================== admission ==============================

/// What the RUNTIME sample says about admitting another agent, on top of whatever the static
/// derivation already allows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Admission {
    /// The ceiling to enforce. **Invariant: `admitted <= static_max`** — sampling can only refuse,
    /// never grant. Also `>= 1`, for the same reason `ram_derived_concurrency` floors at 1: a
    /// ceiling of zero deadlocks the orchestrator instead of degrading it.
    pub admitted: u32,
    /// The static ceiling this narrowed (or didn't), carried so a consumer can show both numbers.
    pub static_max: u32,
    /// Which dimension binds `admitted`. `Bound::Pressure` / `Bound::Available` are the two this
    /// module can introduce; anything else means the static derivation still binds and is passed
    /// through unchanged by [`sampled_concurrency`].
    pub bound: Bound,
    /// One human sentence. The point of the whole exercise: the human must be able to read
    /// "refused: memory pressure", not just "at capacity".
    pub basis: String,
    /// False when nothing could be measured — the consumer is then looking at the static ceiling
    /// verbatim, and should say so rather than implying a measurement backed it.
    pub sampled: bool,
    /// The reading that produced this, for the UI's memory readout. `None` when `sampled` is false.
    pub sample: Option<MemorySample>,
}

fn gib1(bytes: u64) -> String {
    format!("{:.1} GiB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

/// Narrow `static_max` by what the machine can actually carry RIGHT NOW.
///
/// **`in_use` MUST be the count of RESIDENT agents — the ones that actually hold memory — not a
/// count of agent rows.** The two differ: the frontend's `CapacityReading` carries `used` (every
/// build/worker row, including rows in project tabs the user has never opened, which have no PTY and
/// no footprint) and `live` (the mounted subset). This function needs `live`.
///
/// The reason is the `in_use +` term below. Adding back a share that dormant rows never took inflates
/// the ceiling by `(used - live) × per_agent_bytes`, and it inflates it in the PERMISSIVE direction —
/// the `available` bound stops narrowing at all, because `by_available >= used` then holds almost
/// always (roborev 55383). Passing rows here does not make the gate stricter or looser at random; it
/// makes it quietly inert, which is worse than absent because it still reports a basis sentence.
///
/// Three inputs, `min()`ed:
///   * `static_max` — the prediction, from `config.rs`. Never exceeded.
///   * `in_use + available/per_agent` — what is left to hand out, measured. Note the `in_use +`:
///     the agents already resident are already *accounted for* in `available_bytes`, so their share
///     must be added back or the ceiling would collapse toward zero as agents start.
///   * the pressure level — `Critical` holds the line at `in_use` (admit no more). **`Warn` does
///     NOT**: it defers to the measured `by_available` bound instead (roborev 55384).
///
/// That `Warn`/`Critical` split is a correction, and the reasoning it replaces is worth recording
/// because it was superficially sensible: "once the OS is squeezing, one more agent is the wrong bet
/// either way." The flaw is that `Warn`'s trigger is a FRACTION while the thing it was gating is an
/// ABSOLUTE quantity. `frac_pct < 20` on a 128 GiB machine means 25.6 GiB free — which this module's
/// own per-agent budget (1536 MiB) says is room for sixteen more agents — and the gate admitted
/// zero. The bigger the machine, the more real headroom got discarded, which inverts the scaling
/// `sparkle-hfhs` asked for. Letting `by_available` bind at `Warn` keeps the protection (a genuinely
/// tight machine has a small `by_available`, so it still narrows, and hard) while a large machine
/// with tens of GiB free is throttled in proportion to what it actually has.
///
/// `Critical` keeps the hard stop, because that is the pre-jetsam ramp. It is reached from a measured
/// `frac_pct < 8`, from heavy swap alongside an absolute free pool under
/// `SWAP_CRITICAL_HEADROOM_BYTES`, or from the OS's own critical verdict — see the note on
/// `classify_pressure` for why swap alone (at any volume) is deliberately not enough, and why a
/// percentage alone was not either.
///
/// Floored at 1 so an idle machine under critical pressure can still start the one agent the user
/// asked for — refusing everything would present as a hung app, and the watchdog is the tool for a
/// machine that is genuinely over the line.
pub fn sampled_admission(
    static_max: u32,
    in_use: u32,
    per_agent_bytes: u64,
    sample: Option<&MemorySample>,
) -> Admission {
    let Some(s) = sample else {
        return Admission {
            admitted: static_max,
            static_max,
            bound: Bound::Unknown,
            basis: "memory could not be sampled, so the static ceiling stands unnarrowed".into(),
            sampled: false,
            sample: None,
        };
    };
    let per_agent = per_agent_bytes.max(1);
    let headroom = (s.available_bytes / per_agent).min(u32::MAX as u64) as u32;
    let by_available = in_use.saturating_add(headroom);
    let by_level = match s.level {
        // `Warn` defers to the measured bound rather than hard-stopping. See the note on the
        // fraction-vs-absolute mismatch in this function's doc comment: a 20%-free 128 GiB machine
        // still has room for sixteen agents, and freezing it at `in_use` discarded all of that.
        PressureLevel::Normal | PressureLevel::Warn => u32::MAX,
        PressureLevel::Critical => in_use,
    };
    let admitted = static_max.min(by_available).min(by_level).max(1);

    let per_agent_mb = per_agent / (1024 * 1024);
    // Only `Critical` can claim `Bound::Pressure`, because only `Critical` now contributes a
    // `by_level`. Keyed on the level itself rather than on `by_level <= by_available`: with `Warn`
    // mapping to `u32::MAX` that comparison is false in every realistic case, but it would go true if
    // `by_available` also saturated — and a `Warn` reading labelled "refused: memory pressure" while
    // the available bound is what actually narrowed would name the wrong dimension, the exact class
    // of bug `basis` exists to prevent.
    let pressure_binds = s.level == PressureLevel::Critical && by_level <= by_available;
    let (bound, basis) = if admitted >= static_max {
        // Nothing narrowed. Say which measurement cleared it, so "at capacity" on a machine with
        // memory to spare is legibly a CPU/pin decision rather than an unexplained refusal.
        (
            Bound::Unknown,
            format!(
                "memory is not the constraint: {} available of {} ({} pressure), enough for {} more agent(s)",
                gib1(s.available_bytes),
                gib1(s.total_bytes),
                level_word(s.level),
                headroom,
            ),
        )
    } else if pressure_binds {
        (
            Bound::Pressure,
            format!(
                "refused: memory pressure is {} ({} available of {}, {} compressed, {} swap) — \
                 holding at the {in_use} agent(s) already running instead of the {static_max} the \
                 static ceiling allows",
                level_word(s.level).to_uppercase(),
                gib1(s.available_bytes),
                gib1(s.total_bytes),
                gib1(s.compressed_bytes),
                gib1(s.swap_used_bytes),
            ),
        )
    } else {
        (
            Bound::Available,
            format!(
                "refused: only {} of memory is available right now ÷ {per_agent_mb} MiB per agent = \
                 room for {headroom} more on top of the {in_use} running — the static ceiling of \
                 {static_max} assumes memory this machine does not currently have free",
                gib1(s.available_bytes),
            ),
        )
    };
    Admission { admitted, static_max, bound, basis, sampled: true, sample: Some(*s) }
}

fn level_word(l: PressureLevel) -> &'static str {
    match l {
        PressureLevel::Normal => "normal",
        PressureLevel::Warn => "warning",
        PressureLevel::Critical => "critical",
    }
}

/// The full runtime concurrency answer, in the SHAPE the app already plumbs: an effective number, a
/// [`Bound`], and a basis sentence. Deliberately reuses `config.rs`'s vocabulary rather than
/// inventing a parallel path — the human sees "refused: memory pressure" in the same place they
/// already see "CPU-bound: 18 cores × 2 agents per core".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConcurrencyAdmission {
    /// `min(static, sampled)` — what to enforce.
    pub effective: u32,
    /// The static (predicted) ceiling, unchanged.
    pub static_max: u32,
    /// The static ceiling's own bound, so the UI can still explain the un-narrowed case.
    pub static_bound: Bound,
    /// The bound on `effective`: the static one when memory isn't the constraint, `pressure` /
    /// `available` when it is.
    pub bound: Bound,
    pub basis: String,
    pub sampled: bool,
    pub sample: Option<MemorySample>,
}

/// Compose the static derivation with a runtime sample. Pure — the caller supplies both.
pub fn sampled_concurrency(
    static_max: u32,
    static_bound: Bound,
    static_basis: &str,
    in_use: u32,
    per_agent_bytes: u64,
    sample: Option<&MemorySample>,
) -> ConcurrencyAdmission {
    let a = sampled_admission(static_max, in_use, per_agent_bytes, sample);
    let narrowed = a.admitted < static_max;
    ConcurrencyAdmission {
        effective: a.admitted,
        static_max,
        static_bound,
        bound: if narrowed { a.bound } else { static_bound },
        basis: if narrowed { a.basis } else { static_basis.to_string() },
        sampled: a.sampled,
        sample: a.sample,
    }
}

// ============================== the RSS watchdog ==============================

/// One row of the process table: enough to rebuild the tree and sum it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: u32,
    pub rss_bytes: u64,
}

/// The seam for the process table, so the watchdog's grouping is unit-tested without running `ps`.
pub trait ProcessTable: Send + Sync {
    fn rows(&self) -> Option<Vec<ProcRow>>;
}

/// A fixed table, for tests and for injecting a snapshot taken elsewhere. `allow(dead_code)` for
/// the same reason as [`FixedSampler`]: the app itself only ever uses [`PsProcessTable`].
#[allow(dead_code)]
pub struct FixedProcessTable(pub Option<Vec<ProcRow>>);

impl ProcessTable for FixedProcessTable {
    fn rows(&self) -> Option<Vec<ProcRow>> {
        self.0.clone()
    }
}

/// What ONE agent costs: its root process plus every descendant of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentFootprint {
    pub agent_id: String,
    pub root_pid: u32,
    /// Processes in the tree, including the root. Measured mean is ~2 and peak 5 — a count far
    /// above that is itself a signal, which is why it is reported rather than only summed.
    pub proc_count: u32,
    pub rss_bytes: u64,
}

/// Sum RSS per AGENT by walking each root's descendant tree.
///
/// This function is the whole point of the module's header note. Summing one pid per agent
/// undercounts by ~2x (measured 1.95 processes per agent, peak 5), and a watchdog that undercounts
/// is a watchdog that never fires.
///
/// Three properties worth stating because all three were reachable bugs:
///   * **A pid is attributed to at most one agent.** Roots are claimed in order, and a pid already
///     claimed is not re-counted — otherwise an agent that (somehow) sits under another agent's
///     tree would have its RSS counted twice and both would look runaway.
///   * **A subtree belongs to its NEAREST enclosing root.** A walk stops descending when it reaches
///     another declared root: that process, and everything under it, is that agent's cost, not this
///     one's. Without this the claim-set alone still yields a wrong answer — it prevents the
///     double-count but hands the whole nested subtree to whichever root was listed FIRST, so the
///     outer agent reads as a runaway and the inner one reads as using no memory at all. (Caught by
///     `a_pid_is_attributed_to_at_most_one_agent` the first time this module was ever compiled: A
///     reported 1800 MiB of a 1800 MiB total and B reported 0.)
///   * **Cycles cannot hang it.** A corrupt/racy `ps` snapshot can contain a ppid loop; the visited
///     set bounds the walk at one visit per pid.
pub fn agent_footprints(rows: &[ProcRow], roots: &[(String, u32)]) -> Vec<AgentFootprint> {
    let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
    let mut by_pid: HashMap<u32, usize> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        // A pid appearing twice would double-count; keep the first and ignore the duplicate.
        by_pid.entry(r.pid).or_insert(i);
        // Self-parenting (pid == ppid) would be an immediate cycle; the visited set handles it, but
        // not recording the edge keeps the common walk cheap.
        if r.ppid != r.pid {
            children.entry(r.ppid).or_default().push(i);
        }
    }
    // Every OTHER agent's root is a boundary for this agent's walk. Built once up front rather than
    // scanned per edge, so a machine with many agents stays linear in the process count.
    let root_pids: HashSet<u32> = roots.iter().map(|(_, pid)| *pid).collect();
    let mut claimed: HashSet<u32> = HashSet::new();
    let mut out = Vec::with_capacity(roots.len());
    for (agent_id, root_pid) in roots {
        let mut rss = 0u64;
        let mut count = 0u32;
        let mut queue: VecDeque<u32> = VecDeque::new();
        queue.push_back(*root_pid);
        while let Some(pid) = queue.pop_front() {
            if !claimed.insert(pid) {
                continue;
            }
            if let Some(&i) = by_pid.get(&pid) {
                rss = rss.saturating_add(rows[i].rss_bytes);
                count += 1;
            }
            if let Some(kids) = children.get(&pid) {
                for &k in kids {
                    let kid = rows[k].pid;
                    // Stop at another agent's root. `kid != *root_pid` keeps a ppid cycle that
                    // points back at our own root from being treated as someone else's tree.
                    if kid != *root_pid && root_pids.contains(&kid) {
                        continue;
                    }
                    queue.push_back(kid);
                }
            }
        }
        out.push(AgentFootprint {
            agent_id: agent_id.clone(),
            root_pid: *root_pid,
            proc_count: count,
            rss_bytes: rss,
        });
    }
    out
}

/// Every pid in `root`'s process TREE, including `root` itself. Deterministic (a `BTreeSet`), so a
/// caller can render it into an argument list and get a stable command line.
///
/// **Why this exists separately from [`agent_footprints`].** `preview.rs` has to find the TCP port a
/// dev server bound, and the process that binds it is never the child Sparkle spawned: `pnpm` execs
/// `node`, which forks the framework's CLI, which forks the server — measured four levels deep for
/// `next dev`. A discovery that only inspects the direct child finds no listener and times out on
/// every preview, silently. So the tree walk is the load-bearing part, and it is shared code rather
/// than a second copy of the BFS.
///
/// It is deliberately NOT a refactor of `agent_footprints` to call this. That function's boundary
/// rule — a subtree belongs to its NEAREST enclosing root, and a pid is claimed at most once — is
/// what keeps per-AGENT RSS attribution honest, and it has no analogue here: a preview tree has one
/// root and nothing to be attributed away to. Folding the two would either drag that rule into a
/// place it means nothing, or dilute it where it is load-bearing.
///
/// A ppid cycle (a racy `ps` snapshot can produce one) cannot hang it: the output set doubles as the
/// visited set, so each pid is expanded once.
pub fn descendant_pids(rows: &[ProcRow], root: u32) -> BTreeSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in rows {
        // Self-parenting is an immediate cycle; not recording the edge keeps the common walk cheap
        // (the visited set would catch it anyway).
        if r.ppid != r.pid {
            children.entry(r.ppid).or_default().push(r.pid);
        }
    }
    let mut out: BTreeSet<u32> = BTreeSet::new();
    let mut queue: VecDeque<u32> = VecDeque::new();
    queue.push_back(root);
    while let Some(pid) = queue.pop_front() {
        if !out.insert(pid) {
            continue;
        }
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids.iter().copied());
        }
    }
    out
}

/// Watchdog severity for one agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchdogLevel {
    Ok,
    Warn,
    Critical,
}

/// Thresholds, in MiB, plus the opt-in kill switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchdogThresholds {
    pub warn_mb: u32,
    pub kill_mb: u32,
    /// OFF by default. Killing an agent discards work the user cannot get back, so the default
    /// behavior is to warn and OFFER — the human decides. `sparkle-0bye` asks for "offer to kill";
    /// auto-kill is the escalation a user opts into, not the shipped default.
    pub auto_kill: bool,
}

/// What the UI should do about one agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WatchdogVerdict {
    pub agent_id: String,
    pub root_pid: u32,
    pub rss_bytes: u64,
    pub proc_count: u32,
    pub level: WatchdogLevel,
    /// True past the kill threshold — the UI shows a "Kill agent" action. Set independently of
    /// `auto_kill` so the offer exists whether or not the user armed the automatic version.
    pub kill_offered: bool,
    /// True only when the user opted in AND the agent is past the kill threshold.
    pub auto_kill: bool,
    /// A sentence naming the number and the threshold it crossed.
    pub message: String,
}

/// Judge each footprint. Pure over the footprints, so the thresholds are tested without processes.
///
/// `warn_mb >= kill_mb` is treated as "warn at kill" rather than rejected: a mis-set config must
/// degrade to a working watchdog, not to no watchdog.
///
/// That clamp applies ONLY when the kill tier is armed. `kill_mb = 0` is the documented opt-out for
/// that tier (`validate()` deliberately exempts 0 from `MIN_AGENT_RSS_THRESHOLD_MB`), and
/// `min(warn_mb, 0)` would drag the warn threshold to zero along with it — making `over_warn` true
/// for EVERY agent, so a 100 MiB agent reports "past the 0 MiB warn threshold". That is a permanent
/// false alarm: precisely the "a warning that is always on is a warning the user learns to dismiss"
/// failure the RSS floor exists to prevent, reached by turning ONE tier off.
pub fn watchdog_verdicts(
    footprints: &[AgentFootprint],
    t: WatchdogThresholds,
) -> Vec<WatchdogVerdict> {
    let mib = 1024u64 * 1024;
    let kill_bytes = t.kill_mb as u64 * mib;
    let warn_mb = if t.kill_mb > 0 { t.warn_mb.min(t.kill_mb) } else { t.warn_mb };
    let warn_bytes = warn_mb as u64 * mib;
    footprints
        .iter()
        .map(|f| {
            // A zero threshold means "disabled" — never fire on it, or setting 0 to turn the
            // watchdog off would instead make every agent critical.
            let over_kill = t.kill_mb > 0 && f.rss_bytes >= kill_bytes;
            let over_warn = t.warn_mb > 0 && f.rss_bytes >= warn_bytes;
            let level = if over_kill {
                WatchdogLevel::Critical
            } else if over_warn {
                WatchdogLevel::Warn
            } else {
                WatchdogLevel::Ok
            };
            let message = match level {
                WatchdogLevel::Ok => String::new(),
                WatchdogLevel::Warn => format!(
                    "{} across {} process(es) — past the {} MiB warn threshold",
                    gib1(f.rss_bytes),
                    f.proc_count,
                    warn_mb,
                ),
                WatchdogLevel::Critical => format!(
                    "{} across {} process(es) — past the {} MiB kill threshold. This is the ramp \
                     that precedes an unrecoverable machine.",
                    gib1(f.rss_bytes),
                    f.proc_count,
                    t.kill_mb,
                ),
            };
            WatchdogVerdict {
                agent_id: f.agent_id.clone(),
                root_pid: f.root_pid,
                rss_bytes: f.rss_bytes,
                proc_count: f.proc_count,
                level,
                kill_offered: over_kill,
                auto_kill: over_kill && t.auto_kill,
                message,
            }
        })
        .collect()
}

// ============================== the real (macOS) sampler ==============================

/// Parsed `vm_stat` page counts. Separated from the parsing of the command output so the arithmetic
/// is testable against a captured fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct VmStat {
    pub page_size: u64,
    pub free: u64,
    pub inactive: u64,
    pub speculative: u64,
    pub purgeable: u64,
    pub compressor: u64,
}

impl VmStat {
    /// Reclaimable-without-eviction bytes. See [`MemorySample::available_bytes`].
    pub fn available_bytes(&self) -> u64 {
        self.page_size
            .saturating_mul(self.free + self.inactive + self.speculative + self.purgeable)
    }
    pub fn compressed_bytes(&self) -> u64 {
        self.page_size.saturating_mul(self.compressor)
    }
}

/// Parse `vm_stat` output. Returns `None` when the page size is missing — without it every count is
/// meaningless, and a plausible-looking answer built on a guessed page size is worse than no answer.
pub fn parse_vm_stat(text: &str) -> Option<VmStat> {
    let mut v = VmStat::default();
    for line in text.lines() {
        if v.page_size == 0 {
            // "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
            if let Some(rest) = line.split("page size of ").nth(1) {
                v.page_size = rest.split_whitespace().next()?.parse().ok()?;
                continue;
            }
        }
        let Some((key, val)) = line.split_once(':') else { continue };
        let n: u64 = match val.trim().trim_end_matches('.').parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        match key.trim() {
            "Pages free" => v.free = n,
            "Pages inactive" => v.inactive = n,
            "Pages speculative" => v.speculative = n,
            "Pages purgeable" => v.purgeable = n,
            "Pages occupied by compressor" => v.compressor = n,
            _ => {}
        }
    }
    if v.page_size == 0 {
        return None;
    }
    Some(v)
}

/// Parse `sysctl -n vm.swapusage`:
/// `total = 4096.00M  used = 1234.50M  free = 2861.50M  (encrypted)`
pub fn parse_swap_used_bytes(text: &str) -> Option<u64> {
    let rest = text.split("used =").nth(1)?.trim_start();
    let token = rest.split_whitespace().next()?;
    let (num, unit) = token.split_at(token.len().checked_sub(1)?);
    let scale: f64 = match unit {
        "K" => 1024.0,
        "M" => 1024.0 * 1024.0,
        "G" => 1024.0 * 1024.0 * 1024.0,
        // No suffix (or an unknown one): treat the whole token as bytes.
        _ => return token.parse::<f64>().ok().map(|n| n as u64),
    };
    num.parse::<f64>().ok().map(|n| (n * scale) as u64)
}

/// Parse `sysctl -n kern.memorystatus_vm_pressure_level`: 1 = normal, 2 = warn, 4 = critical.
/// An unrecognized value yields `None` so the caller falls back to [`classify_pressure`] rather
/// than assuming the machine is fine.
pub fn parse_pressure_level(text: &str) -> Option<PressureLevel> {
    match text.trim() {
        "1" => Some(PressureLevel::Normal),
        "2" => Some(PressureLevel::Warn),
        "4" => Some(PressureLevel::Critical),
        _ => None,
    }
}

/// Build a sample from the three raw command outputs. Pure, so the whole composition — including
/// "take the more alarming of the OS level and our own classification" — is unit-tested.
///
/// Taking the max is not belt-and-braces: `kern.memorystatus_vm_pressure_level` reports NORMAL
/// right up until the kernel is nearly ready to jetsam, which is exactly the five silent minutes
/// `sparkle-0bye` describes. Our own fraction/swap test sees the ramp earlier. Neither is allowed
/// to veto the other downward.
pub fn compose_sample(
    total_bytes: u64,
    vm: &VmStat,
    swap_used_bytes: u64,
    os_level: Option<PressureLevel>,
) -> MemorySample {
    let available_bytes = vm.available_bytes();
    let derived = classify_pressure(available_bytes, total_bytes, swap_used_bytes);
    let level = os_level.map_or(derived, |o| o.max(derived));
    MemorySample {
        total_bytes,
        available_bytes,
        compressed_bytes: vm.compressed_bytes(),
        swap_used_bytes,
        level,
    }
}

/// The production sampler: `vm_stat` + `sysctl`, cached for [`SAMPLE_TTL`].
///
/// Cached because the admission gate is consulted on every spawn and every capacity render, and
/// forking three processes per check would make the memory watchdog its own memory problem. The TTL
/// is short enough that a ramp is caught within a second of it starting.
pub struct SystemSampler;

/// How long a reading is reused. Short: this exists to catch a ramp that took five minutes to kill
/// a machine, so a one-second staleness is invisible, while a per-check fork is not.
pub const SAMPLE_TTL: Duration = Duration::from_millis(1000);

impl MemorySampler for SystemSampler {
    fn sample(&self) -> Option<MemorySample> {
        static CACHE: OnceLock<Mutex<Option<(Instant, Option<MemorySample>)>>> = OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(None));
        // Poison-tolerant like the rest of the app's global locks: a panic elsewhere must not wedge
        // memory sampling app-wide.
        let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, cached)) = guard.as_ref() {
            if at.elapsed() < SAMPLE_TTL {
                return *cached;
            }
        }
        let fresh = sample_now();
        *guard = Some((Instant::now(), fresh));
        fresh
    }
}

#[cfg(target_os = "macos")]
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(target_os = "macos")]
fn sample_now() -> Option<MemorySample> {
    let total: u64 = run("/usr/sbin/sysctl", &["-n", "hw.memsize"])?.trim().parse().ok()?;
    let vm = parse_vm_stat(&run("/usr/bin/vm_stat", &[])?)?;
    // Swap and the OS pressure level are BEST-EFFORT: losing either must not lose the whole
    // sample, because a sample-less gate is a gate that never refuses.
    let swap = run("/usr/sbin/sysctl", &["-n", "vm.swapusage"])
        .and_then(|s| parse_swap_used_bytes(&s))
        .unwrap_or(0);
    let os_level = run("/usr/sbin/sysctl", &["-n", "kern.memorystatus_vm_pressure_level"])
        .and_then(|s| parse_pressure_level(&s));
    Some(compose_sample(total, &vm, swap, os_level))
}

#[cfg(not(target_os = "macos"))]
fn sample_now() -> Option<MemorySample> {
    // Not implemented off macOS (Sparkle ships mac-only). None = "no basis to narrow", so the
    // static ceiling governs exactly as it does today.
    None
}

/// The app-wide sampler. A `OnceLock` so a test binary — or a future headless mode — can install a
/// deterministic one before anything reads it.
static SAMPLER: OnceLock<Box<dyn MemorySampler>> = OnceLock::new();

/// Install the process-wide sampler. Returns false if one was already installed (first wins), so a
/// late caller cannot silently swap the gate's basis out from under a running app.
///
/// `allow(dead_code)`: nothing in the app calls this yet — the production path falls through to
/// `SystemSampler` via `sampler()`'s `get_or_init`. It exists so a test binary or a future headless
/// mode can install a deterministic sampler BEFORE anything reads one.
#[allow(dead_code)]
pub fn install_sampler(s: Box<dyn MemorySampler>) -> bool {
    SAMPLER.set(s).is_ok()
}

pub(crate) fn sampler() -> &'static dyn MemorySampler {
    SAMPLER.get_or_init(|| Box::new(SystemSampler)).as_ref()
}

// ============================== tauri commands ==============================

/// Per-agent RAM budget in BYTES — the denominator the admission arithmetic divides available
/// memory by. Derived from the same `agent_ram_budget_mb` the static ceiling uses, so the two can
/// never disagree about what an agent costs.
pub fn per_agent_budget_bytes() -> u64 {
    let eff = crate::config::current_effective();
    let heap = eff.config.workers.agent_heap_mb;
    agent_ram_budget_mb(if heap > 0 { heap } else { 4096 }) as u64 * 1024 * 1024
}

/// The runtime concurrency ceiling, sampled. Called by the frontend's capacity gate.
///
/// `in_use` comes from the frontend because the frontend is where the authoritative agent-row count
/// lives (`localAgentCapacity`); Rust knows only about PTY sessions, which is a subset (a row in an
/// unvisited project tab holds a slot with no PTY yet).
///
/// `async` + `spawn_blocking` for the SAMPLE, because a plain `#[tauri::command]` runs its body
/// inline on the IPC-delivering thread — the main/event-loop thread on macOS (see the long note in
/// `project_window.rs`). Sampling forks up to four processes (`sysctl` ×3, `vm_stat`), and this is
/// consulted on every spawn and every capacity render, so doing it on the event loop would jank the
/// UI. Note `#[tauri::command(async)]` on a sync fn is NOT the fix — it only parks a shared tokio
/// worker; the blocking half must go through `spawn_blocking`, as `auth.rs` / `folder_picker.rs` do.
///
/// Reading the effective config stays on this side: it is a lock + clone, not a fork.
#[tauri::command]
pub async fn memory_admission(in_use: u32) -> ConcurrencyAdmission {
    let eff = crate::config::current_effective();
    let per_agent = per_agent_budget_bytes();
    let sample = if eff.config.memory.pressure_gate {
        // A join failure degrades to "could not measure", which `sampled_admission` already treats
        // as "no basis to narrow" — the static ceiling stands. Never as "zero available".
        tauri::async_runtime::spawn_blocking(|| sampler().sample()).await.unwrap_or(None)
    } else {
        None
    };
    sampled_concurrency(
        eff.effective_max_concurrent,
        eff.concurrency_bound,
        &eff.concurrency_basis,
        in_use,
        per_agent,
        sample.as_ref(),
    )
}

/// The watchdog's report: one verdict per live agent, plus the sample that frames it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WatchdogReport {
    pub verdicts: Vec<WatchdogVerdict>,
    pub sample: Option<MemorySample>,
    /// Total RSS across every agent tree — the "coalition" figure from `scripts/agent-mem.sh`,
    /// which is what macOS's Force Quit dialog attributes to Sparkle and what a human recognizes.
    pub coalition_bytes: u64,
    /// True when the process table could not be read, so an empty `verdicts` means "unknown", not
    /// "nothing is wrong".
    pub unavailable: bool,
}

/// Read the live agent process trees and judge them. The agent ids are the PTY session ids, which
/// ARE the agent ids (`pty:output:<agentId>`), so no mapping table is needed or can drift.
///
/// `async` + `spawn_blocking` for the same reason as [`memory_admission`], and more urgently: this
/// runs `/bin/ps -axo` with NO cache (the 1s TTL covers the sampler only), and `ps` on a machine
/// with hundreds of processes is exactly the condition the watchdog exists to detect. Running that
/// on the event-loop thread would freeze the UI precisely when the machine is already struggling.
///
/// Returns `Result` because a Tauri `async` command that borrows `State<'_, _>` must. The session
/// pids are read on this side (a lock + clone) so the borrow ends before the blocking half.
#[tauri::command]
pub async fn agent_memory_watchdog(
    manager: tauri::State<'_, crate::pty::PtyManager>,
) -> Result<WatchdogReport, String> {
    let eff = crate::config::current_effective();
    let roots = manager.session_pids();
    let thresholds = WatchdogThresholds {
        warn_mb: eff.config.memory.agent_rss_warn_mb,
        kill_mb: eff.config.memory.agent_rss_kill_mb,
        auto_kill: eff.config.memory.agent_rss_auto_kill,
    };
    tauri::async_runtime::spawn_blocking(move || {
        // One sample, reused by both exits — the old code sampled twice per call, which on a cache
        // miss meant two rounds of forks for one report.
        let sample = sampler().sample();
        let Some(rows) = PsProcessTable.rows() else {
            return WatchdogReport {
                verdicts: Vec::new(),
                sample,
                coalition_bytes: 0,
                unavailable: true,
            };
        };
        let footprints = agent_footprints(&rows, &roots);
        let coalition_bytes = footprints.iter().map(|f| f.rss_bytes).sum();
        let verdicts = watchdog_verdicts(&footprints, thresholds);
        WatchdogReport { verdicts, sample, coalition_bytes, unavailable: false }
    })
    .await
    .map_err(|e| format!("the memory watchdog task failed to run: {e}"))
}

/// The real process table, via `ps`. RSS from `ps` is in KiB.
pub struct PsProcessTable;

impl ProcessTable for PsProcessTable {
    #[cfg(unix)]
    fn rows(&self) -> Option<Vec<ProcRow>> {
        let out = std::process::Command::new("/bin/ps").args(["-axo", "pid=,ppid=,rss="]).output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(parse_ps(&String::from_utf8_lossy(&out.stdout)))
    }
    #[cfg(not(unix))]
    fn rows(&self) -> Option<Vec<ProcRow>> {
        None
    }
}

/// Parse `ps -axo pid=,ppid=,rss=` output. Malformed lines are SKIPPED rather than failing the
/// whole snapshot: `ps` races process exit, and one truncated row must not blind the watchdog.
pub fn parse_ps(text: &str) -> Vec<ProcRow> {
    text.lines()
        .filter_map(|line| {
            let mut f = line.split_whitespace();
            let pid = f.next()?.parse().ok()?;
            let ppid = f.next()?.parse().ok()?;
            let rss_kib: u64 = f.next()?.parse().ok()?;
            Some(ProcRow { pid, ppid, rss_bytes: rss_kib * 1024 })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;
    const MIB: u64 = 1024 * 1024;
    /// The per-AGENT budget `config.rs` derives for the default 3072 MiB heap ceiling: 1536 MiB.
    /// Note it is comfortably above the 1.11 GiB per AGENT measured on 2026-07-29.
    const PER_AGENT: u64 = 1536 * MIB;

    fn sample(total: u64, available: u64, level: PressureLevel) -> MemorySample {
        MemorySample {
            total_bytes: total,
            available_bytes: available,
            compressed_bytes: 0,
            swap_used_bytes: 0,
            level,
        }
    }

    // ---------------- the invariant that lets this land ----------------

    #[test]
    fn sampling_can_only_lower_the_static_ceiling_never_raise_it() {
        // A machine with absurd headroom and zero pressure must NOT be granted more than the
        // static ceiling. This is the property that made the previous global-cap change safe, and
        // breaking it would let a sampled reading re-create the jetsam coalition from below.
        let s = sample(1024 * GIB, 900 * GIB, PressureLevel::Normal);
        for static_max in [1u32, 3, 6, 36, 108] {
            for in_use in [0u32, 1, 5, 200] {
                let a = sampled_admission(static_max, in_use, PER_AGENT, Some(&s));
                assert!(
                    a.admitted <= static_max,
                    "admitted {} > static {static_max} (in_use {in_use})",
                    a.admitted
                );
                assert!(a.admitted >= 1, "a ceiling of zero deadlocks the orchestrator");
            }
        }
    }

    #[test]
    fn an_unmeasurable_machine_degrades_to_todays_behavior() {
        let a = sampled_admission(36, 4, PER_AGENT, None);
        assert_eq!(a.admitted, 36, "no measurement = no basis to narrow");
        assert!(!a.sampled);
        assert_eq!(a.bound, Bound::Unknown);
    }

    // ---------------- high pressure refuses what the static cap allows ----------------

    #[test]
    fn high_pressure_refuses_a_spawn_the_static_cap_would_allow() {
        // 128 GiB machine, static ceiling 36, only 4 agents running — the static arithmetic says
        // "plenty of room". The OS says otherwise.
        let s = MemorySample {
            total_bytes: 128 * GIB,
            available_bytes: 6 * GIB,
            compressed_bytes: 40 * GIB,
            swap_used_bytes: 12 * GIB,
            level: PressureLevel::Critical,
        };
        let a = sampled_admission(36, 4, PER_AGENT, Some(&s));
        assert_eq!(a.admitted, 4, "hold at what is already running");
        assert_eq!(a.bound, Bound::Pressure);
        assert!(a.basis.contains("refused"), "the human must read a refusal: {}", a.basis);
        assert!(a.basis.to_lowercase().contains("pressure"), "{}", a.basis);
    }

    /// `Warn` NARROWS to the measured bound; it does not freeze at `in_use` (roborev 55384).
    ///
    /// This test previously asserted `admitted == 7` — a hard stop at whatever was already running.
    /// The replacement keeps the protection (it still narrows, and hard) while fixing the case below.
    #[test]
    fn warn_pressure_narrows_to_what_memory_measures_rather_than_freezing() {
        // 32 GiB machine, 5 GiB free = room for 3 more on top of the 7 running.
        let s = sample(32 * GIB, 5 * GIB, PressureLevel::Warn);
        let a = sampled_admission(20, 7, PER_AGENT, Some(&s));
        assert_eq!(a.admitted, 10, "7 running + 3 that measurably fit, not a freeze at 7");
        assert!(a.admitted < 20, "and it must still narrow the static ceiling");
        assert_eq!(a.bound, Bound::Available, "the AVAILABLE bound is what binds at warn");
        assert!(
            !a.basis.to_lowercase().contains("pressure is"),
            "a warn reading must not claim the pressure bound: {}",
            a.basis
        );
    }

    /// The scaling inversion the `Warn` freeze caused (roborev 55384, Medium).
    ///
    /// `Warn`'s trigger is a FRACTION but what it gated was an ABSOLUTE quantity. Under the old
    /// behavior this machine — 25.6 GiB genuinely free, room for sixteen more agents by this module's
    /// own per-agent budget — admitted ZERO beyond the one already running, and the larger the
    /// machine the more real headroom got discarded. That inverts the scaling `sparkle-hfhs` asked for.
    #[test]
    fn a_big_machine_at_warn_is_throttled_in_proportion_not_frozen() {
        let s = sample(128 * GIB, 25 * GIB, PressureLevel::Warn);
        let a = sampled_admission(36, 1, PER_AGENT, Some(&s));
        // 25 GiB / 1536 MiB = 16 that fit, + the 1 running.
        assert_eq!(a.admitted, 17, "was 1 under the freeze");
        assert!(a.admitted > 1, "the freeze is what this test exists to prevent");
        assert!(a.admitted < 36, "but the static ceiling is still narrowed");
    }

    /// `Critical` keeps the hard stop — the fix above must not weaken the pre-jetsam ramp.
    #[test]
    fn critical_pressure_still_holds_the_line_at_what_is_running() {
        let s = sample(128 * GIB, 25 * GIB, PressureLevel::Critical);
        let a = sampled_admission(36, 3, PER_AGENT, Some(&s));
        assert_eq!(a.admitted, 3, "critical still refuses more, even with headroom on paper");
        assert_eq!(a.bound, Bound::Pressure);
    }

    #[test]
    fn critical_pressure_on_an_idle_machine_still_admits_one() {
        // Refusing everything presents as a hung app; the watchdog, not the gate, is the tool for a
        // machine that is genuinely over the line.
        let s = sample(16 * GIB, 100 * MIB, PressureLevel::Critical);
        assert_eq!(sampled_admission(6, 0, PER_AGENT, Some(&s)).admitted, 1);
    }

    #[test]
    fn low_pressure_never_admits_above_the_static_cap() {
        let s = sample(128 * GIB, 110 * GIB, PressureLevel::Normal);
        let a = sampled_admission(36, 0, PER_AGENT, Some(&s));
        assert_eq!(a.admitted, 36, "110 GiB could hold 73 agents; the static ceiling still wins");
        assert_eq!(a.bound, Bound::Unknown, "memory did not bind");
        assert!(a.basis.contains("not the constraint"), "{}", a.basis);
    }

    #[test]
    fn available_memory_binds_below_the_static_cap_even_at_normal_pressure() {
        // The Chrome/Xcode case from the PRD's concerns: nothing is "under pressure" yet, but the
        // memory the static ceiling assumed is simply not free.
        let s = sample(128 * GIB, 9 * GIB, PressureLevel::Normal);
        let a = sampled_admission(36, 2, PER_AGENT, Some(&s));
        assert_eq!(a.admitted, 8, "2 running + 9 GiB / 1536 MiB = 6 more");
        assert_eq!(a.bound, Bound::Available);
        assert!(a.basis.contains("available right now"), "{}", a.basis);
    }

    #[test]
    fn running_agents_are_added_back_so_the_ceiling_does_not_collapse_as_agents_start() {
        // The subtle one: available_bytes ALREADY excludes what the running agents hold. Without
        // the `in_use +` term the ceiling would fall by one for every agent that starts, and the
        // gate would refuse at roughly half the true capacity.
        let s = sample(128 * GIB, 30 * GIB, PressureLevel::Normal);
        let idle = sampled_admission(36, 0, PER_AGENT, Some(&s)).admitted;
        let busy = sampled_admission(36, 10, PER_AGENT, Some(&s)).admitted;
        assert_eq!(idle, 20);
        assert_eq!(busy, 30);
        assert!(busy > idle, "agents already accounted for in `available` must be added back");
    }

    // ---------------- it must scale DOWN (sparkle-hfhs) ----------------

    /// A machine at a REALISTIC idle: ~55% of RAM available before Sparkle starts (the rest is the
    /// OS, the browser, the editor). This is the state a consumer Mac is actually in.
    fn realistic_idle(total: u64) -> MemorySample {
        let available = total * 55 / 100;
        MemorySample {
            total_bytes: total,
            available_bytes: available,
            compressed_bytes: 0,
            swap_used_bytes: 0,
            level: classify_pressure(available, total, 0),
        }
    }

    #[test]
    fn a_16_gib_machine_admits_fewer_agents_than_a_128_gib_one() {
        // The static ceiling on both is CPU-bound and identical (same core count) — which is
        // precisely the bug `sparkle-hfhs` describes: a ceiling that only knows about cores ships a
        // machine-killer to everyone not on a 128 GiB Mac.
        const STATIC_MAX: u32 = 36;
        let small = sampled_admission(STATIC_MAX, 0, PER_AGENT, Some(&realistic_idle(16 * GIB)));
        let mid = sampled_admission(STATIC_MAX, 0, PER_AGENT, Some(&realistic_idle(32 * GIB)));
        let big = sampled_admission(STATIC_MAX, 0, PER_AGENT, Some(&realistic_idle(128 * GIB)));
        assert_eq!(small.admitted, 5, "16 GiB: 8.8 GiB available / 1536 MiB");
        assert_eq!(mid.admitted, 11, "32 GiB: 17.6 GiB available / 1536 MiB");
        assert_eq!(big.admitted, 36, "128 GiB: 70.4 GiB would hold 46 — static ceiling still caps");
        assert!(small.admitted < mid.admitted, "16 GiB must admit fewer than 32 GiB");
        assert!(mid.admitted < big.admitted, "32 GiB must admit fewer than 128 GiB");
        assert!(
            small.admitted < STATIC_MAX && mid.admitted < STATIC_MAX,
            "both small machines must be narrowed BELOW the static ceiling"
        );
    }

    #[test]
    fn the_measured_hfhs_coalition_would_now_be_refused() {
        // The exact reading from sparkle-hfhs: a 32 GiB Mac carrying 33.48 GiB of Sparkle during
        // NORMAL operation — i.e. already swapping. Whatever the static ceiling says, no further
        // agent is admitted.
        let s = MemorySample {
            total_bytes: 32 * GIB,
            available_bytes: 512 * MIB,
            compressed_bytes: 9 * GIB,
            swap_used_bytes: 6 * GIB,
            level: classify_pressure(512 * MIB, 32 * GIB, 6 * GIB),
        };
        assert_eq!(s.level, PressureLevel::Critical);
        let a = sampled_admission(20, 12, PER_AGENT, Some(&s));
        assert_eq!(a.admitted, 12, "no 13th agent onto a machine already in swap");
        assert_eq!(a.bound, Bound::Pressure);
    }

    // ---------------- classification ----------------

    #[test]
    fn classification_thresholds() {
        assert_eq!(classify_pressure(50 * GIB, 128 * GIB, 0), PressureLevel::Normal);
        assert_eq!(classify_pressure(20 * GIB, 128 * GIB, 0), PressureLevel::Warn, "15.6% available");
        assert_eq!(classify_pressure(5 * GIB, 128 * GIB, 0), PressureLevel::Critical, "3.9%");
        // Unknown total: judged on swap alone rather than dividing by zero.
        assert_eq!(classify_pressure(0, 0, 0), PressureLevel::Normal);
        // No total, so no fraction — the absolute rule applies on its own. A reported 0 bytes
        // available IS below the headroom floor, so heavy swap there is a hard stop; light swap is
        // only a throttle.
        assert_eq!(classify_pressure(0, 0, 2 * GIB), PressureLevel::Warn, "swapping, but not heavily");
        assert_eq!(classify_pressure(0, 0, 5 * GIB), PressureLevel::Critical, "nothing free + heavy swap");
        // ...and heavy swap with a real free pool is still only a throttle, total or no total.
        assert_eq!(classify_pressure(40 * GIB, 0, 5 * GIB), PressureLevel::Warn);
    }

    /// Swap CORROBORATES a tight free pool; it does not escalate on its own (roborev 55384, High).
    ///
    /// These two rows are the regression. `classify_pressure(60 * GIB, 128 * GIB, 2 * GIB)` used to
    /// assert `Warn` — i.e. it enshrined the claim that a machine with 47% of its RAM free is
    /// squeezed, purely because it had touched 2 GiB of swap at some point. macOS's `vm.swapusage
    /// used` is a cumulative high-water figure, so on a long-uptime Mac that condition is close to
    /// permanent, and `sampled_admission` turned it into a permanent refusal.
    #[test]
    fn stale_swap_on_a_machine_with_memory_to_spare_is_not_pressure() {
        // 47% free. Was Warn, and at 5 GiB was Critical — the shipped false-refusal path.
        assert_eq!(classify_pressure(60 * GIB, 128 * GIB, 2 * GIB), PressureLevel::Normal);
        assert_eq!(classify_pressure(60 * GIB, 128 * GIB, 5 * GIB), PressureLevel::Normal);
        // The exact machine from the review: 128 GiB, 95 GiB free, 5 GiB of leftover swap.
        assert_eq!(classify_pressure(95 * GIB, 128 * GIB, 5 * GIB), PressureLevel::Normal);

        // ...but swap MUST still bite once the free pool corroborates it. 25% free is above the
        // fraction-only Warn line (20%), so these rows fail if the conjunction is dropped entirely
        // — which is what stops this fix from becoming "ignore swap".
        assert_eq!(classify_pressure(32 * GIB, 128 * GIB, 2 * GIB), PressureLevel::Warn, "25% free + swapping");
        // ...and it caps at Warn however much swap there is. This row asserted `Critical` in the
        // first pass, which enshrined a narrower copy of the very bug being fixed: 32 GiB free on a
        // 128 GiB Mac is room for 21 agents, and Critical would have admitted zero indefinitely
        // (roborev 55425). Swap records what the machine DID; only a measured free fraction under 8%
        // — a fact about NOW — earns the hard stop.
        assert_eq!(classify_pressure(32 * GIB, 128 * GIB, 5 * GIB), PressureLevel::Warn);
        assert_eq!(classify_pressure(32 * GIB, 128 * GIB, 64 * GIB), PressureLevel::Warn, "no amount of swap freezes it");
        // And with no swap, that same 25%-free machine is fine.
        assert_eq!(classify_pressure(32 * GIB, 128 * GIB, 0), PressureLevel::Normal);
    }

    /// The hard stop always has a PRESENT-TENSE justification — a tiny fraction, or heavy swap with a
    /// tiny absolute pool. Never stale swap on a machine with room (roborev 55425, then 55450).
    #[test]
    fn only_a_measured_tiny_free_pool_earns_the_hard_stop() {
        // Under 8% free: Critical, with or without swap.
        assert_eq!(classify_pressure(5 * GIB, 128 * GIB, 0), PressureLevel::Critical);
        assert_eq!(classify_pressure(5 * GIB, 128 * GIB, 40 * GIB), PressureLevel::Critical);

        // BIG machine, plenty of absolute headroom: no swap figure reaches Critical. Every one of
        // these has >= 11 GiB free, well above the 4.5 GiB floor.
        for free_gib in [11u64, 16, 25, 32, 44, 60, 95] {
            for swap_gib in [0u64, 1, 5, 40] {
                let level = classify_pressure(free_gib * GIB, 128 * GIB, swap_gib * GIB);
                assert_ne!(
                    level,
                    PressureLevel::Critical,
                    "{free_gib} GiB free of 128 with {swap_gib} GiB swap must not hard-stop admission"
                );
            }
        }
        // An unmeasurable total, heavy swap, but a big free pool: throttle, don't freeze.
        assert_eq!(classify_pressure(40 * GIB, 0, 40 * GIB), PressureLevel::Warn);
    }

    /// The case the 128-GiB-only sweep above structurally could not see (roborev 55450).
    ///
    /// A percentage cannot express "almost nothing left" on both a 16 GiB and a 128 GiB host, and the
    /// incident that motivated this whole module was on a SMALL machine: `sparkle-hfhs` measured a
    /// 32 GiB Mac at 33.48 GiB resident — swapping during ordinary work. In its 8–20% band there is
    /// only 2.5–6.4 GiB free, so a fraction-only rule reads "not critical" while the machine is on the
    /// pre-jetsam ramp. Nothing else can supply the missing verdict: `available_bytes` counts purgeable
    /// and speculative pages, and the kernel's own pressure level reports NORMAL until it is nearly
    /// ready to jetsam.
    #[test]
    fn a_small_machine_swapping_with_almost_no_headroom_still_hard_stops() {
        // 32 GiB Mac, 3 GiB free = 9.4% — ABOVE the 8% fraction line, so only the absolute rule can
        // catch it. With GiBs of swap it is the ramp; this must be Critical.
        assert_eq!(classify_pressure(3 * GIB, 32 * GIB, 5 * GIB), PressureLevel::Critical);
        assert_eq!(classify_pressure(4 * GIB, 32 * GIB, 8 * GIB), PressureLevel::Critical);
        // ...and 16 GiB hosts likewise: 2 GiB free is 12.5%, fraction says fine, absolute says no.
        assert_eq!(classify_pressure(2 * GIB, 16 * GIB, 6 * GIB), PressureLevel::Critical);

        // Same small machines WITHOUT heavy swap only throttle — the absolute floor must not become a
        // second fraction-free way to freeze a machine that is merely tight.
        assert_eq!(classify_pressure(3 * GIB, 32 * GIB, 0), PressureLevel::Warn);
        assert_eq!(classify_pressure(3 * GIB, 32 * GIB, 2 * GIB), PressureLevel::Warn);

        // And a small machine with real headroom is untouched.
        assert_eq!(classify_pressure(20 * GIB, 32 * GIB, 0), PressureLevel::Normal);
        assert_eq!(classify_pressure(20 * GIB, 32 * GIB, 40 * GIB), PressureLevel::Normal, "62% free");

        // The 128 GiB rows the previous pass pinned must NOT regress — they are the false-refusal
        // cases, and this fix has to leave them alone.
        assert_eq!(classify_pressure(32 * GIB, 128 * GIB, 5 * GIB), PressureLevel::Warn);
        assert_eq!(classify_pressure(95 * GIB, 128 * GIB, 5 * GIB), PressureLevel::Normal);
    }

    /// The absolute floor is derived from the same per-agent budget the ceiling arithmetic uses, so a
    /// change to one cannot silently desynchronise the other.
    #[test]
    fn the_swap_headroom_floor_tracks_the_per_agent_budget() {
        let per_agent = crate::config::agent_ram_budget_mb(3072) as u64 * MIB;
        assert_eq!(
            SWAP_CRITICAL_HEADROOM_BYTES,
            3 * per_agent,
            "the floor is documented as three agents' worth of the derived budget"
        );
    }

    #[test]
    fn compose_takes_the_more_alarming_of_the_two_readings() {
        let vm = VmStat { page_size: 16384, free: 100, ..Default::default() };
        // The OS still says NORMAL while our own fraction test sees a nearly-empty machine. The
        // silent five minutes before jetsam is exactly this disagreement.
        let s = compose_sample(128 * GIB, &vm, 0, Some(PressureLevel::Normal));
        assert_eq!(s.level, PressureLevel::Critical);
        // …and the reverse: we see a comfortable fraction, the OS is already screaming.
        let vm_big = VmStat { page_size: 16384, free: 4 * 1024 * 1024, ..Default::default() };
        let s2 = compose_sample(128 * GIB, &vm_big, 0, Some(PressureLevel::Critical));
        assert_eq!(s2.level, PressureLevel::Critical);
        assert_eq!(compose_sample(128 * GIB, &vm_big, 0, None).level, PressureLevel::Normal);
    }

    // ---------------- parsing ----------------

    #[test]
    fn parses_real_vm_stat_output() {
        // Captured from macOS 25.6.
        let text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
                    Pages free:                              123456.\n\
                    Pages active:                           1000000.\n\
                    Pages inactive:                          200000.\n\
                    Pages speculative:                        50000.\n\
                    Pages throttled:                              0.\n\
                    Pages wired down:                        400000.\n\
                    Pages purgeable:                          10000.\n\
                    \"Translation faults\":                 999999999.\n\
                    Pages occupied by compressor:             80000.\n";
        let v = parse_vm_stat(text).expect("page size present");
        assert_eq!(v.page_size, 16384);
        assert_eq!(v.free, 123456);
        assert_eq!(v.inactive, 200000);
        assert_eq!(v.speculative, 50000);
        assert_eq!(v.purgeable, 10000);
        assert_eq!(v.compressor, 80000);
        assert_eq!(v.available_bytes(), 16384 * (123456 + 200000 + 50000 + 10000));
        assert_eq!(v.compressed_bytes(), 16384 * 80000);
    }

    #[test]
    fn vm_stat_without_a_page_size_is_no_answer_not_a_guessed_one() {
        assert!(parse_vm_stat("Pages free: 100.\n").is_none());
        assert!(parse_vm_stat("").is_none());
    }

    #[test]
    fn parses_swapusage_and_pressure_level() {
        let s = "total = 4096.00M  used = 1234.50M  free = 2861.50M  (encrypted)";
        assert_eq!(parse_swap_used_bytes(s), Some((1234.5 * 1048576.0) as u64));
        assert_eq!(parse_swap_used_bytes("total = 0.00M  used = 0.00M  free = 0.00M"), Some(0));
        assert_eq!(parse_swap_used_bytes("nonsense"), None);
        assert_eq!(parse_pressure_level("1\n"), Some(PressureLevel::Normal));
        assert_eq!(parse_pressure_level("2"), Some(PressureLevel::Warn));
        assert_eq!(parse_pressure_level("4"), Some(PressureLevel::Critical));
        assert_eq!(parse_pressure_level("wat"), None, "unknown must not read as 'fine'");
    }

    #[test]
    fn parses_ps_and_skips_torn_rows() {
        let rows = parse_ps("  1     0  12345\n 42     1   6789\nbroken line\n 99\n");
        assert_eq!(rows.len(), 2, "torn rows are skipped, not fatal: {rows:?}");
        assert_eq!(rows[0], ProcRow { pid: 1, ppid: 0, rss_bytes: 12345 * 1024 });
        assert_eq!(rows[1], ProcRow { pid: 42, ppid: 1, rss_bytes: 6789 * 1024 });
    }

    // ---------------- per-AGENT grouping (the trap) ----------------

    fn row(pid: u32, ppid: u32, mib: u64) -> ProcRow {
        ProcRow { pid, ppid, rss_bytes: mib * MIB }
    }

    #[test]
    fn a_footprint_sums_the_whole_process_tree_not_one_pid() {
        // The measured shape: an agent is ~2 processes, peaking at 5 when it runs subagents.
        // Counting the root alone would report 600 MiB for an agent that costs 2.1 GiB.
        let rows = vec![
            row(100, 1, 600),   // agent A root
            row(101, 100, 700), // its claude child
            row(102, 101, 800), // a subagent under that child (grandchild — depth matters)
            row(200, 1, 500),   // agent B root
            row(900, 1, 4000),  // unrelated: Chrome. Must NOT be attributed to any agent.
        ];
        let f = agent_footprints(&rows, &[("A".into(), 100), ("B".into(), 200)]);
        assert_eq!(f[0].rss_bytes, 2100 * MIB, "root + child + grandchild");
        assert_eq!(f[0].proc_count, 3);
        assert_eq!(f[1].rss_bytes, 500 * MIB);
        assert_eq!(f[1].proc_count, 1);
    }

    /// `descendant_pids` must reach the WHOLE tree, not one generation. `preview.rs` asks a dev
    /// server's tree which TCP port it bound, and the listener belongs to a great-grandchild
    /// (`pnpm` → `node` → `next` → `next-server`); a walk that stopped at the direct child would
    /// return a set that contains no listener at all, and every preview would time out.
    #[test]
    fn descendant_pids_reaches_the_whole_tree_and_only_that_tree() {
        let rows = vec![
            row(100, 1, 0),   // pnpm — the child Sparkle spawned
            row(101, 100, 0), // node
            row(102, 101, 0), // next
            row(103, 102, 0), // next-server: the process that actually listens
            row(900, 1, 0),   // an unrelated process, at the same depth as the root
        ];
        let tree = descendant_pids(&rows, 100);
        assert_eq!(tree, BTreeSet::from([100, 101, 102, 103]), "four levels, root included");
        assert!(!tree.contains(&900), "a sibling subtree is not ours to signal or probe");
        // A pid with no rows at all is still returned as itself: `ps` races process exit, and a
        // root that has just been spawned may not be in the snapshot yet.
        assert_eq!(descendant_pids(&rows, 555), BTreeSet::from([555]));
    }

    /// A racy `ps` snapshot can contain a parent cycle. The walk must terminate — a hang here would
    /// wedge the preview supervisor thread rather than fail it.
    #[test]
    fn descendant_pids_terminates_on_a_ppid_cycle() {
        let rows = vec![row(10, 12, 0), row(11, 10, 0), row(12, 11, 0)];
        assert_eq!(descendant_pids(&rows, 10), BTreeSet::from([10, 11, 12]));
    }

    #[test]
    fn a_pid_is_attributed_to_at_most_one_agent() {
        // B's root sits under A's tree. Without the claim set both would be charged for B's
        // subtree and both would look runaway.
        let rows = vec![row(100, 1, 600), row(200, 100, 900), row(201, 200, 300)];
        let f = agent_footprints(&rows, &[("A".into(), 100), ("B".into(), 200)]);
        assert_eq!(f[0].rss_bytes + f[1].rss_bytes, 1800 * MIB, "total is conserved");
        assert_eq!(f[0].rss_bytes, 600 * MIB, "A claimed first, keeps only its own");
        assert_eq!(f[1].rss_bytes, 1200 * MIB);
        // Conservation alone does NOT prove correct attribution — this is how the original walk
        // passed the sum check while being completely wrong: it gave A all 1800 MiB and B nothing,
        // which is a false runaway on A and an invisible B. Pin both counts, not just the total.
        assert_eq!(f[0].proc_count, 1, "A owns only its own process");
        assert_eq!(f[1].proc_count, 2, "B owns its root AND its child");

        // Listing order must not decide who is charged: B first yields the same attribution.
        let g = agent_footprints(&rows, &[("B".into(), 200), ("A".into(), 100)]);
        assert_eq!(g[0].rss_bytes, 1200 * MIB, "B still owns its own subtree when listed first");
        assert_eq!(g[1].rss_bytes, 600 * MIB, "…and A still owns only its own");
    }

    #[test]
    fn a_ppid_cycle_cannot_hang_the_walk() {
        // A racy/corrupt ps snapshot: 100 → 101 → 100.
        let rows = vec![row(100, 101, 10), row(101, 100, 20), row(7, 7, 5)];
        let f = agent_footprints(&rows, &[("A".into(), 100), ("S".into(), 7)]);
        assert_eq!(f[0].proc_count, 2);
        assert_eq!(f[1].proc_count, 1, "a self-parented pid is counted once");
    }

    #[test]
    fn a_dead_root_reports_zero_rather_than_vanishing() {
        // The agent exited between the pid snapshot and the ps run. It must still appear, at zero,
        // so the caller can tell "gone" from "not measured".
        let f = agent_footprints(&[row(1, 0, 10)], &[("gone".into(), 424242)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].rss_bytes, 0);
        assert_eq!(f[0].proc_count, 0);
    }

    // ---------------- watchdog thresholds ----------------

    fn foot(id: &str, mib: u64) -> AgentFootprint {
        AgentFootprint { agent_id: id.into(), root_pid: 1, proc_count: 2, rss_bytes: mib * MIB }
    }

    const T: WatchdogThresholds =
        WatchdogThresholds { warn_mb: 4096, kill_mb: 8192, auto_kill: false };

    #[test]
    fn the_watchdog_fires_past_the_threshold_and_not_below_it() {
        let v = watchdog_verdicts(
            &[foot("calm", 1100), foot("edge", 4095), foot("warn", 4096), foot("huge", 9000)],
            T,
        );
        assert_eq!(v[0].level, WatchdogLevel::Ok, "the measured 1.11 GiB per agent is normal");
        assert!(v[0].message.is_empty());
        assert_eq!(v[1].level, WatchdogLevel::Ok, "one MiB below the threshold does not fire");
        assert_eq!(v[2].level, WatchdogLevel::Warn, "at the threshold it does");
        assert_eq!(v[3].level, WatchdogLevel::Critical);
        assert!(v[3].message.contains("kill threshold"), "{}", v[3].message);
    }

    #[test]
    fn auto_kill_is_opt_in_and_the_offer_exists_either_way() {
        let over = [foot("huge", 9000)];
        let default = watchdog_verdicts(&over, T);
        assert!(default[0].kill_offered, "the human is always OFFERED the kill");
        assert!(!default[0].auto_kill, "…but nothing kills automatically by default");

        let armed = watchdog_verdicts(&over, WatchdogThresholds { auto_kill: true, ..T });
        assert!(armed[0].auto_kill, "opted in, past the kill threshold");

        let under = watchdog_verdicts(&[foot("warn", 5000)], WatchdogThresholds { auto_kill: true, ..T });
        assert!(!under[0].auto_kill, "armed, but only WARN — auto-kill needs the kill threshold");
        assert!(!under[0].kill_offered);
    }

    #[test]
    fn a_zero_threshold_disables_that_tier_rather_than_firing_on_everything() {
        let v = watchdog_verdicts(
            &[foot("big", 20000)],
            WatchdogThresholds { warn_mb: 0, kill_mb: 0, auto_kill: true },
        );
        assert_eq!(v[0].level, WatchdogLevel::Ok);
        assert!(!v[0].auto_kill);
    }

    #[test]
    fn disabling_only_the_kill_tier_leaves_the_warn_tier_at_its_own_threshold() {
        // roborev 55361. `kill_mb = 0` is a documented opt-out for THAT tier, and `validate()`
        // exempts 0 from the RSS floor — so this config is reachable by a user who wants warnings
        // but never a kill offer. Clamping warn to kill unconditionally made `warn_bytes` 0, so
        // EVERY agent warned ("past the 0 MiB warn threshold") — a permanent false alarm.
        // `a_zero_threshold_disables_that_tier…` misses it because it zeroes BOTH thresholds, so
        // the `warn_mb > 0` guard short-circuits before the collapsed threshold is ever compared.
        let t = WatchdogThresholds { warn_mb: 4096, kill_mb: 0, auto_kill: false };
        let v = watchdog_verdicts(&[foot("normal", 1100), foot("big", 5000)], t);
        assert_eq!(
            v[0].level,
            WatchdogLevel::Ok,
            "a healthy 1.1 GiB agent must not warn merely because the kill tier is off"
        );
        assert!(v[0].message.is_empty(), "…and says nothing: {}", v[0].message);
        assert_eq!(v[1].level, WatchdogLevel::Warn, "the warn tier still fires on its own value");
        assert!(
            v[1].message.contains("4096 MiB"),
            "the message must quote the real threshold, not 0: {}",
            v[1].message
        );
        assert!(!v[1].kill_offered, "no kill is offered while that tier is disabled");
    }

    #[test]
    fn an_inverted_threshold_config_still_watches() {
        // warn above kill is nonsense; it must degrade to a working watchdog, not to none.
        let v = watchdog_verdicts(
            &[foot("x", 9000)],
            WatchdogThresholds { warn_mb: 16384, kill_mb: 8192, auto_kill: false },
        );
        assert_eq!(v[0].level, WatchdogLevel::Critical);
    }

    #[test]
    fn the_fixed_sampler_seam_drives_the_gate_without_touching_the_system() {
        let s = sample(16 * GIB, 1 * GIB, PressureLevel::Critical);
        let sampler: Box<dyn MemorySampler> = Box::new(FixedSampler(Some(s)));
        let a = sampled_admission(36, 3, PER_AGENT, sampler.sample().as_ref());
        assert_eq!(a.admitted, 3);
        let none: Box<dyn MemorySampler> = Box::new(FixedSampler(None));
        assert_eq!(sampled_admission(36, 3, PER_AGENT, none.sample().as_ref()).admitted, 36);
    }

    #[test]
    fn the_process_table_seam_feeds_the_watchdog_end_to_end() {
        // Exercises the OTHER injectable seam (`ProcessTable`), so the watchdog's full chain —
        // table → per-agent tree sum → verdict — is proven without running `ps`. Only the sampler
        // seam had coverage before; this is the path `agent_memory_watchdog` actually walks.
        let table: Box<dyn ProcessTable> = Box::new(FixedProcessTable(Some(vec![
            row(100, 1, 600),
            row(101, 100, 8000), // agent A's child has run away
            row(200, 1, 900),    // agent B is fine
        ])));
        let rows = table.rows().expect("a fixed table always has rows");
        let f = agent_footprints(&rows, &[("A".into(), 100), ("B".into(), 200)]);
        let v = watchdog_verdicts(&f, T);
        assert_eq!(v[0].level, WatchdogLevel::Critical, "600 + 8000 MiB is past the kill tier");
        assert!(v[0].kill_offered);
        assert_eq!(v[1].level, WatchdogLevel::Ok, "B must not be tarred by A's runaway");

        // An unreadable table is "unknown", not "nothing is wrong" — the distinction
        // `WatchdogReport::unavailable` exists to carry.
        let blind: Box<dyn ProcessTable> = Box::new(FixedProcessTable(None));
        assert!(blind.rows().is_none());
    }

    #[test]
    fn installing_a_sampler_is_first_wins_so_the_gates_basis_cannot_be_swapped() {
        // The whole test binary shares one `SAMPLER` OnceLock, so this is deliberately the ONLY
        // test that touches `install_sampler` — a second one would be order-dependent.
        let s = sample(8 * GIB, 1 * GIB, PressureLevel::Warn);
        assert!(install_sampler(Box::new(FixedSampler(Some(s)))), "the first install takes");
        assert!(
            !install_sampler(Box::new(FixedSampler(None))),
            "a later caller must NOT be able to swap the running gate's basis out"
        );
        assert_eq!(
            sampler().sample(),
            Some(s),
            "…and the reading served is still the one first installed"
        );
    }

    #[test]
    fn sampled_concurrency_passes_the_static_basis_through_when_memory_does_not_bind() {
        let s = sample(128 * GIB, 100 * GIB, PressureLevel::Normal);
        let c = sampled_concurrency(36, Bound::Cpu, "CPU-bound: 18 cores × 2 agents per core", 0, PER_AGENT, Some(&s));
        assert_eq!(c.effective, 36);
        assert_eq!(c.bound, Bound::Cpu, "the static attribution survives");
        assert!(c.basis.starts_with("CPU-bound"));

        let tight = sample(128 * GIB, 3 * GIB, PressureLevel::Normal);
        let c2 = sampled_concurrency(36, Bound::Cpu, "CPU-bound: …", 1, PER_AGENT, Some(&tight));
        assert_eq!(c2.effective, 3);
        assert_eq!(c2.bound, Bound::Available, "…and is replaced when memory takes over");
        assert_eq!(c2.static_bound, Bound::Cpu, "both are reported, so neither is lost");
    }
}

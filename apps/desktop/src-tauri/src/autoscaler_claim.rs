//! THE BACKLOG-AUTOSCALER BEAD CLAIM — exactly one autoscaler spawn per bead, durably, ACROSS
//! WINDOWS and across app restarts, decided by a real compare-and-set (bead `sparkle-n2feho.10`,
//! PHASE 3 of the never-idle epic `sparkle-n2feho`).
//!
//! ── WHAT BREAKS WITHOUT IT ────────────────────────────────────────────────────────────────────
//! `services/backlogAutoscaler.ts` picks ONE next ready bead per pass and, when armed, starts an
//! agent on it. Phase 2's de-duplication was a `Set<string>` living in one window's JS heap. A
//! second Sparkle window runs its own module instance on its own 60s tick, and so does the same
//! window after a restart, so that set cannot see a peer deciding on the same board a second later:
//! two windows both select the top ready bead and both spawn. Phase 2 shipped
//! `PHASE2_MAX_SPAWNS_PER_PASS = 1` as a workaround for exactly this, and its own comment says so.
//!
//! A duplicate here is not a duplicate log line. It is two agents on two worktrees on two branches
//! doing identical work, discovered at merge time.
//!
//! ── NOT `notes::bead_claim`, WHICH IS A DIFFERENT VERB WITH THE SAME WORD IN IT ───────────────
//! `notes.rs` already exports a Tauri command called `bead_claim`: it shells `bd update <id>
//! --claim`, which marks the bead **in_progress** in the shared beads store. That is a genuinely
//! durable, genuinely cross-window mark — and it is the wrong instrument here for two reasons that
//! are each disqualifying. It NEVER EXPIRES, so a window that dies mid-spawn leaves the bead
//! in_progress forever and a human has to notice and undo it; on a never-idle epic that converts a
//! double-book into a permanent stall, which the bead filing this work forbids in as many words.
//! And it is a `bd` SHELL CALL against a single-writer Dolt store the whole machine contends on,
//! issued from a 60-second timer in every mounted window — the autoscaler's whole design point is
//! that its pass reads a cached snapshot and shells nothing.
//!
//! So this module is named for WHO is claiming, not for what is claimed: an `autoscaler_claim` is
//! this window's short-lived, self-expiring reservation on a bead it is about to staff. The bead's
//! own status is untouched.
//!
//! ── WHY THIS MODULE AND NOT ONE OF THE TWO EXISTING ONES ──────────────────────────────────────
//! Both precedents were read before writing a third (the bead required it), and neither answers
//! this question:
//!
//!   * [`crate::babysit_lease`] is the right SHAPE and the wrong KEY: it is keyed `(repo, pr)` and
//!     its whole vocabulary is about one `/babysit-pr` driver. Its primitives — [`process_epoch`],
//!     [`epoch_is_alive`], [`hold_instance_lock`] — are REUSED here verbatim, which is the same
//!     thing `agent_life.rs` and `preview.rs` already do. That is the opposite of inventing a third
//!     mechanism: one liveness rule, one instance-lock file family, three consumers.
//!   * `scripts/file-claim.sh` is the ledger an AGENT writes before editing a file. It is a shell
//!     script over a text ledger, read by other shell scripts, with no compare-and-set at all — the
//!     right tool for "declare intent to a human peer", and unusable from a 60s timer in the app
//!     that must not double-spawn.
//!
//! ── THE STATES, AND WHY UNKNOWN IS NOT FREE ───────────────────────────────────────────────────
//!   * **FREE** — the store was read and nothing holds this bead. Acquire WINS.
//!   * **HELD-LIVE** — a claim exists and its holder is still plausibly alive. Acquire REFUSES.
//!   * **HELD-DEAD** — a claim exists and its holder is gone (dead launch, or expired). Acquire
//!     TAKES IT OVER and says so, because on a NEVER-IDLE epic a permanently parked bead is a worse
//!     failure than the double-book — see EXPIRY below.
//!   * **UNKNOWN** — the store could not be read, parsed, locked or written. Acquire REFUSES,
//!     naming that reason, and the TS caller spawns NOTHING this pass.
//!   * **INVALID** — the CALL was malformed. Acquire REFUSES, and this is a FOURTH reason rather
//!     than a flavour of UNKNOWN: `unknown` means "ask again next tick" and `invalid` means "these
//!     arguments will never be accepted", which are opposite instructions (`sparkle-nlxgd2`).
//!
//! ── EXPIRY IS MANDATORY, AND ITS SHAPE IS NOT THE LEASE'S ─────────────────────────────────────
//! A window that dies holding a claim must not park that bead forever. On the never-idle epic that
//! converts a double-book into a PERMANENT STALL, which this epic's own retro (roborev 80561)
//! records as the more expensive failure: a double-spawn fix turned out to be a head-of-line block
//! — one agent for the life of the window, then permanent idleness — and its test pinned the stall
//! as the intent. So there are THREE independent ways a claim stops binding, and the fast two are
//! the ones that matter in practice:
//!
//!   1. **EPOCH DEATH — instant.** Every claim records its holder's app-launch epoch. A claim from
//!      a launch that is provably gone (flock-proven, never a pid probe — see [`epoch_is_alive`])
//!      is reclaimable immediately. This is how a window actually dies, so restart recovery costs
//!      a string comparison rather than a timeout.
//!   2. **EXPLICIT RELEASE — the normal path.** The autoscaler releases a claim as soon as the bead
//!      leaves the ready column (the work moved on) or the agent it started is gone from the fleet.
//!      Both are computed in the sweep from state it already reads.
//!   3. **HEARTBEAT EXPIRY — the backstop.** [`STALE_MS_DEFAULT`] since the last check-in. The
//!      autoscaler renews the claims it holds on every 60s pass for as long as the agent it started
//!      is still alive, so a live claim is refreshed 30× inside the window; anything that stops
//!      renewing is not doing the work.
//!
//! `heartbeatAtMs` is separate from `claimedAtMs` for the reason `babysit_lease` keeps both: the
//! age that decides expiry must be "time since somebody last asserted this is live", not "time
//! since the work started", or a long, healthy job expires itself.
//!
//! ── ATOMICITY ─────────────────────────────────────────────────────────────────────────────────
//! Two windows ticking in the same second must not both win, so acquire is a genuine
//! compare-and-set: the whole read-decide-write runs under [`lock_store`], which is a process-wide
//! `Mutex` **and** an advisory `flock` on a sidecar file. In THIS module the mutex alone would
//! already cover the headline case — two windows of one app share one backend process — but two
//! INSTANCES of the same build share one app-data dir and this app has no single-instance guard, so
//! the file lock is what makes the guarantee hold in the configuration the bead actually describes.
//! The store itself is replaced by write-fsync-rename onto a temp file in the same directory, so a
//! crash mid-write leaves either the old store or the new one, never a truncated file.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::babysit_lease::{epoch_is_alive, process_epoch};

// ══ TUNING ══════════════════════════════════════════════════════════════════════════════════════

/// How long a claim survives without a check-in before it is DEAD and takeable: **30 minutes**.
///
/// Derived from what actually renews it, not picked for roundness. The autoscaler sweep runs every
/// 60s ([`BACKLOG_AUTOSCALER_SWEEP_MS`]) and renews every claim it holds whose agent is still in the
/// fleet, so a healthy claim is refreshed **thirty times** inside this window. The threshold has to
/// survive a machine under real load — this repo's own unit stage runs 22-35 minutes and the app
/// competes with it — but it does NOT have to survive the length of the agent's task, because
/// renewal is not tied to the task finishing.
///
/// The asymmetry is the opposite of the babysit lease's, and that is why the number is so much
/// smaller. There, expiring early manufactures a double-post on a stranger's PR; here, expiring
/// early costs at worst a second agent on a bead that the fleet is already working, while expiring
/// LATE costs a bead parked out of a never-idle backlog for the whole window. Thirty minutes is
/// generous against a 60-second renewal and bounded against a stall.
///
/// The epoch check makes the common recovery instant anyway: a window that dies is detected at once
/// and never waits this out.
pub const STALE_MS_DEFAULT: u64 = 30 * 60 * 1000;

/// A claim dead by BOTH epoch and heartbeat for longer than this is dropped the next time we are
/// writing anyway. Purely to stop the file growing without bound; never consulted for a liveness
/// decision, and the prune only runs on a path that already holds the lock and is already writing.
const PRUNE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Refusal reasons — a TYPED vocabulary, not prose, because the TypeScript consumer branches on
/// them. Deliberately the SAME spellings `babysit_lease` uses: one vocabulary across the app, so a
/// reader who has learned `unknown` there does not have to learn a second word for it here.
pub const REASON_HELD_LIVE: &str = "held-live";
pub const REASON_UNKNOWN: &str = "unknown";
pub const REASON_INVALID: &str = "invalid";

/// `lost` and `absent` both mean STOP; `unknown` means RETRY; `invalid` means the call was
/// malformed and will never succeed as written.
pub const CLAIM_ERR_LOST: &str = "lost";
pub const CLAIM_ERR_ABSENT: &str = "absent";
pub const CLAIM_ERR_UNKNOWN: &str = REASON_UNKNOWN;
pub const CLAIM_ERR_INVALID: &str = REASON_INVALID;

/// A typed failure from [`heartbeat_at`], [`release_at`] or [`list_at`]. Serializes to
/// `{ reason, message }` so a rejected promise on the TS side is branchable, never
/// substring-matched.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimError {
    /// One of the `CLAIM_ERR_*` constants.
    pub reason: String,
    /// Human-readable elaboration for the log. Never branched on.
    pub message: String,
}

impl ClaimError {
    fn new(reason: &str, message: impl Into<String>) -> Self {
        ClaimError { reason: reason.to_string(), message: message.into() }
    }
    fn lost(message: impl Into<String>) -> Self {
        Self::new(CLAIM_ERR_LOST, message)
    }
    fn absent(message: impl Into<String>) -> Self {
        Self::new(CLAIM_ERR_ABSENT, message)
    }
    fn unknown(message: impl Into<String>) -> Self {
        Self::new(CLAIM_ERR_UNKNOWN, message)
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(CLAIM_ERR_INVALID, message)
    }
}

impl std::fmt::Display for ClaimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.reason, self.message)
    }
}

// ══ THE WIRE CONTRACT ═══════════════════════════════════════════════════════════════════════════

/// One window's claim on one bead.
///
/// `#[serde(rename_all = "camelCase")]`, so the TypeScript side reads `beadId` / `claimantId` /
/// `agentId` / `claimedAtMs` / `heartbeatAtMs`. AGENTS.md's wire-casing rule: a hand-written
/// snake_case interface would read `undefined` for every field with NOTHING logged, and
/// `scripts/serde-ts-wire-casing-check.sh` is the guard that keeps the two halves honest.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BeadClaim {
    /// The bead id, verbatim as the board carries it (`sparkle-xxxxx`, or a dotted child).
    pub bead_id: String,
    /// WHO HOLDS IT — the autoscaler instance in one window, NOT the agent it starts. The claim is
    /// taken BEFORE the spawn, so at acquire time there is no agent to name yet.
    pub claimant_id: String,
    /// The agent this claim was ultimately spent on, recorded by the first heartbeat after a
    /// successful spawn. `None` between acquire and that heartbeat — a real, short-lived state, and
    /// the reason renewal cannot simply require an agent to point at.
    ///
    /// A Rust `Option` with no `skip_serializing_if`, so it crosses the wire as `null`, never as an
    /// absent key: the TS side must declare `agentId: string | null`, not `agentId?: string`.
    pub agent_id: Option<String>,
    pub claimed_at_ms: u64,
    pub heartbeat_at_ms: u64,
    /// The app-launch epoch of the holder. See [`process_epoch`].
    pub epoch: String,
}

/// Whether a stored claim still binds. Computed in ONE place ([`standing`]) and handed to callers
/// pre-computed by [`list_at`], so nobody re-implements the liveness rule slightly differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaimStanding {
    /// Same launch (or a launch still proven alive), checked in within [`STALE_MS_DEFAULT`].
    Live,
    /// Recorded by a launch that is provably gone. Reclaimable instantly.
    DeadEpoch,
    /// A live launch, but nothing has checked in for [`STALE_MS_DEFAULT`]. Reclaimable.
    DeadStale,
}

/// What [`acquire_at`] hands back.
///
/// `tookOver` + `previousHolder` are the entire difference between "this bead got its first agent"
/// and "we silently started a SECOND one on work already in flight". A log that cannot tell those
/// apart cannot audit the property this module exists to guarantee.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub acquired: bool,
    /// The claim now held by the caller. `None` iff `acquired` is false.
    pub claim: Option<BeadClaim>,
    /// Who holds it instead. `None` when `acquired`, and `None` when the reason is `unknown` — we
    /// could not read the store, so we do not know who, and must not imply nobody.
    pub held_by: Option<BeadClaim>,
    /// [`REASON_HELD_LIVE`], [`REASON_UNKNOWN`] or [`REASON_INVALID`]. `None` iff `acquired`.
    pub reason: Option<String>,
    /// True when the acquisition RECLAIMED a dead claim rather than starting from free.
    pub took_over: bool,
    /// The dead claim that was reclaimed, when `tookOver`.
    pub previous_holder: Option<BeadClaim>,
    /// Human-readable elaboration for the log. Never branched on — that is what `reason` is for.
    pub detail: Option<String>,
}

impl ClaimOutcome {
    fn won(claim: BeadClaim, previous: Option<BeadClaim>, detail: Option<String>) -> Self {
        ClaimOutcome {
            acquired: true,
            claim: Some(claim),
            held_by: None,
            reason: None,
            took_over: previous.is_some(),
            previous_holder: previous,
            detail,
        }
    }

    fn held_live(holder: BeadClaim) -> Self {
        let detail = format!(
            "{} is already claimed by autoscaler {} (agent {}, heartbeat {}ms). One spawn per bead.",
            holder.bead_id,
            holder.claimant_id,
            holder.agent_id.clone().unwrap_or_else(|| "(not yet started)".into()),
            holder.heartbeat_at_ms
        );
        ClaimOutcome {
            acquired: false,
            claim: None,
            held_by: Some(holder),
            reason: Some(REASON_HELD_LIVE.into()),
            took_over: false,
            previous_holder: None,
            detail: Some(detail),
        }
    }

    fn unknown(detail: impl Into<String>) -> Self {
        ClaimOutcome {
            acquired: false,
            claim: None,
            held_by: None,
            reason: Some(REASON_UNKNOWN.into()),
            took_over: false,
            previous_holder: None,
            detail: Some(detail.into()),
        }
    }

    /// The call was malformed. Same SHAPE as [`ClaimOutcome::unknown`] — refuse, write nothing, name
    /// nobody — and a DIFFERENT `reason`, because the caller's next move is the opposite one.
    fn invalid(detail: impl Into<String>) -> Self {
        ClaimOutcome {
            acquired: false,
            claim: None,
            held_by: None,
            reason: Some(REASON_INVALID.into()),
            took_over: false,
            previous_holder: None,
            detail: Some(detail.into()),
        }
    }
}

/// A claim WITH its computed standing, for the sweep that has to decide what is still binding.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeadClaimView {
    pub claim: BeadClaim,
    pub standing: ClaimStanding,
    /// Milliseconds since the last check-in, clamped at zero for a future timestamp.
    pub heartbeat_age_ms: u64,
}

/// The whole durable store: a plain JSON map keyed by bead id. Flat and human-readable on purpose —
/// the first thing anybody debugging a stuck backlog will do is `cat` it.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(transparent)]
pub struct BeadClaimStore {
    pub claims: BTreeMap<String, BeadClaim>,
}

// ══ PURE RULES ══════════════════════════════════════════════════════════════════════════════════

/// Milliseconds since the Unix epoch, or 0 for a clock before it (nothing here depends on that).
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A bead id as this repo mints them, validated rather than sanitised because it becomes a store
/// KEY. Beads are `sparkle-abc12`, sometimes dotted (`sparkle-n2feho.10`), so `.` is legal; nothing
/// else outside `[A-Za-z0-9_-]` is. Rejecting propagates to a refusal, which fails closed.
pub fn is_bead_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        // A key that is only dots would collide with path-ish nonsense in a hand-edited file.
        && id.bytes().any(|b| b.is_ascii_alphanumeric())
}

/// Claimant and agent ids as this app mints them — the same `[A-Za-z0-9_-]{1,128}` shape
/// `worktree::validate_id` enforces before an id is joined onto a path.
fn is_actor_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// How long since `claim` last checked in, clamped at zero.
///
/// `saturating_sub` is the clock-skew guard: a heartbeat stamped in the future (an NTP step, a
/// machine waking with a bad RTC) yields age 0 — the claim reads LIVE — rather than wrapping to a
/// colossal age that would read DEAD and hand a working agent's bead to a second one.
fn heartbeat_age_ms(claim: &BeadClaim, now_ms: u64) -> u64 {
    now_ms.saturating_sub(claim.heartbeat_at_ms)
}

/// Whether a stored claim still binds. THE liveness rule; there is no second copy.
///
/// THE `epoch != current_epoch` TEST IS A SHORT-CIRCUIT, NOT A GUARD, and it is labelled so because
/// a bidirectional mutation check says so out loud: forcing it TRUE — sending our OWN launch's
/// claims through the liveness probe as well — leaves every test green, because [`lock_store`]
/// registers this launch's instance lock before any read, so [`epoch_is_alive`] answers `true` for
/// our own epoch and control falls through to the heartbeat test exactly as it would have. What the
/// branch buys is SYSCALLS: the probe opens a file and takes a `flock`, and skipping it for the
/// claims we ourselves wrote is the common case on every 60-second pass.
///
/// Forcing it FALSE is a real defect and IS caught — a claim from a dead launch would then never be
/// reclaimed by epoch, and a dead window would park its bead for the whole expiry window. Both
/// directions of the two tests inside it are caught as well. Recording which of the three lines is
/// load-bearing is the point: a future reader who deletes the "dead" branch as unpinned would be
/// deleting a performance path, and one who keeps it believing it is a safety check would be
/// looking in the wrong place for the safety argument.
pub fn standing(
    app_data: &Path,
    claim: &BeadClaim,
    current_epoch: &str,
    now_ms: u64,
    stale_ms: u64,
) -> ClaimStanding {
    if claim.epoch != current_epoch {
        // A different launch — but "different launch" and "dead holder" are only the same thing
        // when at most one instance is running, and this app has no single-instance guard. A live
        // sibling that can still prove it is running vetoes the verdict; we then fall through to
        // the heartbeat test, which resolves it the slow-but-safe way.
        if !epoch_is_alive(app_data, &claim.epoch) {
            return ClaimStanding::DeadEpoch;
        }
    }
    // Strictly greater: a claim sitting exactly ON the threshold is still live. Ties go to the
    // incumbent, like every other tie in this module.
    if heartbeat_age_ms(claim, now_ms) > stale_ms {
        return ClaimStanding::DeadStale;
    }
    ClaimStanding::Live
}

// ══ FILE-BACKED STORE ═══════════════════════════════════════════════════════════════════════════

/// `<app_data>/autoscaler-claims.json`, alongside `babysit-leases.json`.
pub fn store_path(app_data: &Path) -> PathBuf {
    app_data.join("autoscaler-claims.json")
}

/// The in-process half of the compare-and-set, held across the read and the write. Without it two
/// windows' ticks on the same backend process could both read FREE and both write themselves in,
/// and the last writer would look like the sole holder while two agents ran.
fn store_mutex() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// `<app_data>/autoscaler-claims.lock` — a sidecar the store write never touches, so the lock can never be
/// lost by the `rename` that replaces the store.
fn lock_path(app_data: &Path) -> PathBuf {
    app_data.join("autoscaler-claims.lock")
}

/// How long to wait for a sibling instance to finish its critical section before giving up. The
/// section is two syscalls, so anything approaching this means the other side is wedged — at which
/// point UNKNOWN (spawn nothing) is the right answer, not "wait forever".
#[cfg(not(test))]
const FLOCK_ATTEMPTS: u32 = 100;
/// Tests exercise the exhaustion branch deliberately, and 100 × 20ms of real sleeping per case is a
/// price the suite should not pay to prove a `for` loop terminates.
#[cfg(test)]
const FLOCK_ATTEMPTS: u32 = 3;
const FLOCK_RETRY_MS: u64 = 20;

/// Both halves of the compare-and-set, in series: the process-wide mutex, then an advisory `flock`.
/// Dropping the returned guard releases both. The mutex is taken FIRST so the `flock` is only ever
/// contended by a genuine sibling instance, never by our own threads.
struct StoreGuard {
    _mutex: std::sync::MutexGuard<'static, ()>,
    #[cfg(unix)]
    _file: std::fs::File,
}

fn lock_store(app_data: &Path, epoch: &str) -> Result<StoreGuard, String> {
    let mutex = store_mutex().lock().map_err(|e| format!("autoscaler claim lock poisoned: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        std::fs::create_dir_all(app_data).map_err(|e| format!("autoscaler claim lock dir: {e}"))?;
        let path = lock_path(app_data);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| format!("autoscaler claim lock file {}: {e}", path.display()))?;
        for attempt in 0..FLOCK_ATTEMPTS {
            // SAFETY: `flock` only takes an advisory lock on the fd we just opened and own.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                // Register OUR liveness only now, INSIDE the critical section — the same ordering
                // `babysit_lease::lock_store` documents at length, and for the same reason: a
                // sibling's prune runs under this lock and would otherwise find our just-created
                // liveness file owning nothing and delete it.
                crate::babysit_lease::hold_instance_lock(app_data, epoch);
                return Ok(StoreGuard { _mutex: mutex, _file: file });
            }
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
                return Err(format!("autoscaler claim lock {} failed: {err}", path.display()));
            }
            if attempt + 1 < FLOCK_ATTEMPTS {
                std::thread::sleep(std::time::Duration::from_millis(FLOCK_RETRY_MS));
            }
        }
        Err(format!(
            "another Sparkle instance has held the autoscaler claim lock at {} for over {}ms — refusing to guess whether a bead is claimed",
            path.display(),
            FLOCK_ATTEMPTS as u64 * FLOCK_RETRY_MS
        ))
    }
    #[cfg(not(unix))]
    {
        let _ = (app_data, epoch);
        Ok(StoreGuard { _mutex: mutex })
    }
}

/// Read the store, distinguishing MISSING from UNREADABLE.
///
/// A missing file is `Ok(empty)` — nothing has ever been claimed, genuinely FREE. An I/O error, a
/// parse failure, or an EMPTY file is `Err` (UNKNOWN, and every caller refuses). The empty case is
/// not pedantry: this code can never publish an empty store, because every write is a fully-written,
/// fsync'd temp file renamed into place. A file that exists and is empty is positive evidence that
/// something outside this module truncated it, and "there is provably no claim in it" is exactly the
/// reasoning that would re-enable the double-spawn, silently.
pub fn load_store(app_data: &Path) -> Result<BeadClaimStore, String> {
    let path = store_path(app_data);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BeadClaimStore::default()),
        Err(e) => return Err(format!("autoscaler claim store unreadable at {}: {e}", path.display())),
    };
    if text.trim().is_empty() {
        return Err(format!(
            "autoscaler claim store at {} exists but is empty — this module never writes an empty store, so it was truncated externally. UNKNOWN, not free.",
            path.display()
        ));
    }
    serde_json::from_str(&text)
        .map_err(|e| format!("autoscaler claim store unparseable at {}: {e}", path.display()))
}

/// Replace the store atomically: write a temp file in the SAME directory, fsync it, then `rename`.
/// Together those guarantee the store is always either the old JSON or the new JSON.
fn save_store(app_data: &Path, store: &BeadClaimStore) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let final_path = store_path(app_data);
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = app_data.join(format!("autoscaler-claims.tmp.{}.{seq}.tmp", std::process::id()));
    let write = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, &final_path)
    })();
    if let Err(e) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("autoscaler claim store write failed at {}: {e}", final_path.display()));
    }
    Ok(())
}

/// Drop claims that are dead by BOTH tests and older than [`PRUNE_MS`], skipping `keep`.
///
/// Only ever called on a path that is already writing, so a REFUSAL never touches the file — which
/// keeps "acquire refused" observationally read-only.
fn prune(store: &mut BeadClaimStore, current_epoch: &str, now_ms: u64, keep: &str) {
    store.claims.retain(|key, claim| {
        key == keep || claim.epoch == current_epoch || heartbeat_age_ms(claim, now_ms) <= PRUNE_MS
    });
}

// ══ OPERATIONS ══════════════════════════════════════════════════════════════════════════════════

/// Take the claim on `bead_id` for `claimant_id`, or explain why not.
///
/// Time, epoch and threshold are parameters rather than reads of the clock, so every rule above is
/// testable without sleeping through half an hour. The Tauri command supplies the real ones.
///
/// Re-acquiring a claim the SAME claimant already holds in the SAME launch succeeds and refreshes
/// it: the caller is the incumbent, so this is idempotent rather than a collision.
pub fn acquire_at(
    app_data: &Path,
    bead_id: &str,
    claimant_id: &str,
    epoch: &str,
    now_ms: u64,
    stale_ms: u64,
) -> ClaimOutcome {
    // ARGUMENT VALIDATION — `invalid`, NOT `unknown`. Both fail closed and both write nothing; what
    // differs is the caller's next move. These arguments are wrong in the caller and re-sending
    // them can never start working, whereas every `unknown` bail below is a condition that clears
    // on its own and the next 60s tick is the right response.
    if !is_bead_id(bead_id) {
        return ClaimOutcome::invalid(format!("not a valid bead id: {bead_id:?}"));
    }
    if !is_actor_id(claimant_id) {
        return ClaimOutcome::invalid(format!("not a valid claimant id: {claimant_id:?}"));
    }

    let _guard = match lock_store(app_data, epoch) {
        Ok(g) => g,
        // Could not take the lock. UNKNOWN: we cannot even look, so we certainly cannot say the
        // bead is free.
        Err(e) => return ClaimOutcome::unknown(e),
    };
    let mut store = match load_store(app_data) {
        Ok(s) => s,
        Err(e) => return ClaimOutcome::unknown(e),
    };

    let mut previous: Option<BeadClaim> = None;
    let mut carried_agent: Option<String> = None;
    if let Some(existing) = store.claims.get(bead_id) {
        let is_self = existing.claimant_id == claimant_id && existing.epoch == epoch;
        match standing(app_data, existing, epoch, now_ms, stale_ms) {
            ClaimStanding::Live if !is_self => {
                return ClaimOutcome::held_live(existing.clone());
            }
            // Our own live claim: refresh it, and KEEP the agent we already recorded. Dropping it
            // would make the renewal rule (see the module header) unable to tell "we started an
            // agent on this" from "we have not spawned yet", and the sweep would stop renewing a
            // claim whose agent is alive.
            ClaimStanding::Live => carried_agent = existing.agent_id.clone(),
            // HELD-DEAD: reclaimable. Take it over rather than refuse — otherwise a dead window
            // parks this bead out of the backlog and a human has to notice and delete a file.
            ClaimStanding::DeadEpoch | ClaimStanding::DeadStale => {
                previous = Some(existing.clone());
            }
        }
    }

    let claim = BeadClaim {
        bead_id: bead_id.to_string(),
        claimant_id: claimant_id.to_string(),
        agent_id: carried_agent,
        // A takeover starts its OWN clock: the age a human wants to read is how long THIS holder
        // has had it, not how long the bead has been claimed by anybody.
        claimed_at_ms: now_ms,
        heartbeat_at_ms: now_ms,
        epoch: epoch.to_string(),
    };
    store.claims.insert(bead_id.to_string(), claim.clone());
    prune(&mut store, epoch, now_ms, bead_id);
    if let Err(e) = save_store(app_data, &store) {
        // We could not durably record the acquisition, so we must not report holding it — a window
        // that believes it holds an unrecorded claim is exactly a second spawn waiting to happen.
        return ClaimOutcome::unknown(e);
    }

    let detail = previous.as_ref().map(|p| {
        let why = match standing(app_data, p, epoch, now_ms, stale_ms) {
            ClaimStanding::DeadEpoch => "its holder was from a previous app launch",
            ClaimStanding::DeadStale => "its holder stopped checking in",
            ClaimStanding::Live => "recovered",
        };
        format!("took over {bead_id} from autoscaler {} — {why}", p.claimant_id)
    });
    ClaimOutcome::won(claim, previous, detail)
}

/// Refresh a claim we hold, and record the agent it was spent on.
///
/// `agent_id` is `Option` rather than required because the claim is taken BEFORE the spawn: the
/// first renewal after a successful spawn names the agent, and every later one repeats it. Passing
/// `None` refreshes without disturbing an agent already recorded — it never CLEARS one, because
/// clearing would make the claim look like a spawn that never happened and stop the sweep from
/// renewing it.
pub fn heartbeat_at(
    app_data: &Path,
    bead_id: &str,
    claimant_id: &str,
    agent_id: Option<&str>,
    epoch: &str,
    now_ms: u64,
) -> Result<BeadClaim, ClaimError> {
    if !is_bead_id(bead_id) {
        return Err(ClaimError::invalid(format!("not a valid bead id: {bead_id:?}")));
    }
    if !is_actor_id(claimant_id) {
        return Err(ClaimError::invalid(format!("not a valid claimant id: {claimant_id:?}")));
    }
    if let Some(a) = agent_id {
        if !is_actor_id(a) {
            return Err(ClaimError::invalid(format!("not a valid agent id: {a:?}")));
        }
    }
    let _guard = lock_store(app_data, epoch).map_err(ClaimError::unknown)?;
    let mut store = load_store(app_data).map_err(ClaimError::unknown)?;
    let Some(existing) = store.claims.get(bead_id).cloned() else {
        return Err(ClaimError::absent(format!("no claim on {bead_id} — stop working it")));
    };
    // LOST is not UNKNOWN. Somebody else holds this bead now (we were taken over while dead, or a
    // stale caller is renewing something it no longer has). "Stop" and "retry" are opposite
    // instructions and the caller branches on the word.
    if existing.claimant_id != claimant_id || existing.epoch != epoch {
        return Err(ClaimError::lost(format!(
            "{bead_id} is now claimed by {} (epoch {}) — you no longer hold it",
            existing.claimant_id, existing.epoch
        )));
    }
    let refreshed = BeadClaim {
        heartbeat_at_ms: now_ms,
        agent_id: agent_id.map(str::to_string).or(existing.agent_id.clone()),
        ..existing
    };
    store.claims.insert(bead_id.to_string(), refreshed.clone());
    prune(&mut store, epoch, now_ms, bead_id);
    save_store(app_data, &store).map_err(ClaimError::unknown)?;
    Ok(refreshed)
}

/// Give up a claim we hold. The normal end of a claim's life: the bead left the ready column, or
/// the agent we started on it is gone.
///
/// Releasing a claim we do NOT hold is `lost`, not success: reporting success would let a stale
/// caller delete the incumbent's claim and re-open the double-spawn from the other direction.
pub fn release_at(
    app_data: &Path,
    bead_id: &str,
    claimant_id: &str,
    epoch: &str,
) -> Result<(), ClaimError> {
    if !is_bead_id(bead_id) {
        return Err(ClaimError::invalid(format!("not a valid bead id: {bead_id:?}")));
    }
    if !is_actor_id(claimant_id) {
        return Err(ClaimError::invalid(format!("not a valid claimant id: {claimant_id:?}")));
    }
    let _guard = lock_store(app_data, epoch).map_err(ClaimError::unknown)?;
    let mut store = load_store(app_data).map_err(ClaimError::unknown)?;
    let Some(existing) = store.claims.get(bead_id).cloned() else {
        return Err(ClaimError::absent(format!("no claim on {bead_id} to release")));
    };
    if existing.claimant_id != claimant_id || existing.epoch != epoch {
        return Err(ClaimError::lost(format!(
            "{bead_id} is claimed by {} (epoch {}), not by you — refusing to release it",
            existing.claimant_id, existing.epoch
        )));
    }
    store.claims.remove(bead_id);
    save_store(app_data, &store).map_err(ClaimError::unknown)
}

/// Every stored claim WITH its computed standing.
///
/// Returns `Result`, never a bare `Vec`, for the reason the module header gives: a caller that reads
/// an empty list as "nothing is claimed" when we could not read the store has re-introduced the
/// exact bug this module was written to close.
pub fn list_at(
    app_data: &Path,
    epoch: &str,
    now_ms: u64,
    stale_ms: u64,
) -> Result<Vec<BeadClaimView>, ClaimError> {
    let store = load_store(app_data).map_err(ClaimError::unknown)?;
    Ok(store
        .claims
        .values()
        .map(|claim| BeadClaimView {
            standing: standing(app_data, claim, epoch, now_ms, stale_ms),
            heartbeat_age_ms: heartbeat_age_ms(claim, now_ms),
            claim: claim.clone(),
        })
        .collect())
}

// ══ TAURI COMMANDS ══════════════════════════════════════════════════════════════════════════════
//
// `async` + `spawn_blocking` throughout: a synchronous `#[tauri::command]` body runs on the MAIN
// thread, and one that takes a lock can freeze the whole UI if any other holder wedges.

#[tauri::command]
pub async fn autoscaler_claim_acquire(
    app: AppHandle,
    bead_id: String,
    claimant_id: String,
) -> Result<ClaimOutcome, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        acquire_at(&app_data, &bead_id, &claimant_id, process_epoch(), now_ms(), STALE_MS_DEFAULT)
    })
    .await
    .map_err(|e| format!("autoscaler_claim_acquire task failed: {e}"))
}

#[tauri::command]
pub async fn autoscaler_claim_heartbeat(
    app: AppHandle,
    bead_id: String,
    claimant_id: String,
    agent_id: Option<String>,
) -> Result<BeadClaim, ClaimError> {
    let app_data = crate::dev_identity::app_data_dir(&app).map_err(ClaimError::unknown)?;
    tauri::async_runtime::spawn_blocking(move || {
        heartbeat_at(
            &app_data,
            &bead_id,
            &claimant_id,
            agent_id.as_deref(),
            process_epoch(),
            now_ms(),
        )
    })
    .await
    .map_err(|e| ClaimError::unknown(format!("autoscaler_claim_heartbeat task failed: {e}")))?
}

#[tauri::command]
pub async fn autoscaler_claim_release(
    app: AppHandle,
    bead_id: String,
    claimant_id: String,
) -> Result<(), ClaimError> {
    let app_data = crate::dev_identity::app_data_dir(&app).map_err(ClaimError::unknown)?;
    tauri::async_runtime::spawn_blocking(move || {
        release_at(&app_data, &bead_id, &claimant_id, process_epoch())
    })
    .await
    .map_err(|e| ClaimError::unknown(format!("autoscaler_claim_release task failed: {e}")))?
}

#[tauri::command]
pub async fn autoscaler_claims(app: AppHandle) -> Result<Vec<BeadClaimView>, ClaimError> {
    let app_data = crate::dev_identity::app_data_dir(&app).map_err(ClaimError::unknown)?;
    tauri::async_runtime::spawn_blocking(move || {
        list_at(&app_data, process_epoch(), now_ms(), STALE_MS_DEFAULT)
    })
    .await
    .map_err(|e| ClaimError::unknown(format!("autoscaler_claims task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A launch that NEVER registered a liveness lock — so `epoch_is_alive` answers false and a
    /// claim carrying it is `DeadEpoch`. That is what a previous app launch looks like from here.
    const EPOCH_GONE: &str = "launch-gone";
    /// The launch the test itself is acting as. Registering happens inside `lock_store`.
    const EPOCH_NOW: &str = "launch-now";
    /// An arbitrary but realistic wall-clock base, so ages are never computed against 0.
    const T0: u64 = 1_754_000_000_000;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    /// Put a claim in the store WITHOUT going through `acquire_at`.
    ///
    /// Load-bearing rather than convenience: `lock_store` registers whatever epoch it is handed as a
    /// LIVE instance for the rest of this process, and nothing in this crate can un-register it. A
    /// test that "acquired as EPOCH_GONE" and then expected a takeover would be asserting that a
    /// live sibling can be robbed — the catastrophic direction. Writing the file directly is the
    /// only faithful model of "a claim left behind by a launch that is over".
    fn seed(dir: &Path, claim: BeadClaim) {
        let mut store = load_store(dir).unwrap_or_default();
        store.claims.insert(claim.bead_id.clone(), claim);
        save_store(dir, &store).unwrap();
    }

    fn claim_of(bead: &str, claimant: &str, epoch: &str, at: u64) -> BeadClaim {
        BeadClaim {
            bead_id: bead.into(),
            claimant_id: claimant.into(),
            agent_id: None,
            claimed_at_ms: at,
            heartbeat_at_ms: at,
            epoch: epoch.into(),
        }
    }

    fn acquire(dir: &Path, bead: &str, claimant: &str, now: u64) -> ClaimOutcome {
        acquire_at(dir, bead, claimant, EPOCH_NOW, now, STALE_MS_DEFAULT)
    }

    // ═══ THE HEADLINE PROPERTY: TWO WINDOWS, ONE BEAD ══════════════════════════════════════════

    #[test]
    fn two_windows_ticking_on_the_same_board_cannot_both_claim_one_bead() {
        let d = tmp();
        // Two DIFFERENT claimants in the SAME launch — which is exactly two Sparkle windows: one
        // backend process, two webviews, two module instances, two 60s tickers.
        let first = acquire(d.path(), "sparkle-n2feho.10", "autoscaler-aaaa", T0);
        let second = acquire(d.path(), "sparkle-n2feho.10", "autoscaler-bbbb", T0 + 900);

        assert!(first.acquired, "the first window must win: {first:?}");
        assert!(!second.acquired, "the second window must NOT also win: {second:?}");
        assert_eq!(second.reason.as_deref(), Some(REASON_HELD_LIVE));
        assert_eq!(
            second.held_by.map(|c| c.claimant_id),
            Some("autoscaler-aaaa".to_string()),
            "the refusal must name the incumbent, or a log cannot audit the guarantee"
        );
    }

    #[test]
    fn a_second_window_is_free_to_claim_a_DIFFERENT_bead() {
        // The other direction, and the one a narrowing mutant breaks: refusing the duplicate must
        // not become refusing everything. A guard that only ever says no is a permanent stall, and
        // on this epic that is the more expensive failure (roborev 80561).
        let d = tmp();
        assert!(acquire(d.path(), "", "autoscaler-aaaa", T0).acquired);
        let other = acquire(d.path(), "", "autoscaler-bbbb", T0 + 900);
        assert!(other.acquired, "a different bead must still be claimable: {other:?}");
        assert!(!other.took_over);
    }

    #[test]
    fn the_incumbent_re_acquiring_its_own_claim_is_idempotent_not_a_collision() {
        let d = tmp();
        assert!(acquire(d.path(), "", "autoscaler-aaaa", T0).acquired);
        let again = acquire(d.path(), "", "autoscaler-aaaa", T0 + 60_000);
        assert!(again.acquired, "the same claimant in the same launch is the incumbent: {again:?}");
        assert!(!again.took_over, "refreshing your own claim is not a takeover");
        assert_eq!(again.claim.unwrap().heartbeat_at_ms, T0 + 60_000);
    }

    #[test]
    fn re_acquiring_our_own_claim_KEEPS_the_agent_it_was_spent_on() {
        // Dropping it would make the sweep unable to tell "we started an agent on this" from "we
        // have not spawned yet", and its renewal rule reads exactly that field.
        let d = tmp();
        assert!(acquire(d.path(), "", "autoscaler-aaaa", T0).acquired);
        heartbeat_at(d.path(), "", "autoscaler-aaaa", Some("agent-7"), EPOCH_NOW, T0 + 10)
            .unwrap();
        let again = acquire(d.path(), "", "autoscaler-aaaa", T0 + 20).unwrap_claim();
        assert_eq!(again.agent_id.as_deref(), Some("agent-7"));
    }

    // ═══ EXPIRY — A DEAD WINDOW MUST NOT PARK A BEAD FOREVER ═══════════════════════════════════

    #[test]
    fn a_claim_from_a_launch_that_is_GONE_is_taken_over_instantly() {
        let d = tmp();
        // Heartbeated one second ago — so ONLY the epoch rule can make this reclaimable. If the
        // epoch test were removed this claim would read LIVE and the bead would be parked until
        // STALE_MS_DEFAULT, which is the slow half of the very stall this test exists to prevent.
        seed(d.path(), claim_of("", "autoscaler-dead", EPOCH_GONE, T0));
        let took = acquire(d.path(), "", "autoscaler-live", T0 + 1_000);
        assert!(took.acquired, "a dead window's claim must not park the bead: {took:?}");
        assert!(took.took_over);
        assert_eq!(took.previous_holder.unwrap().claimant_id, "autoscaler-dead");
        assert!(took.detail.unwrap().contains("previous app launch"));
    }

    #[test]
    fn a_claim_from_a_DIFFERENT_BUT_LIVE_launch_is_NOT_taken_over() {
        // THE SIBLING VETO, and without it the epoch rule is catastrophic rather than merely wrong.
        // This app has no single-instance guard, so two instances of the same build share one
        // app-data dir. Each has its own `process_epoch`, so each would classify the OTHER's LIVE
        // claim as dead-by-epoch and take it over — forever, in both directions. That is not a
        // degraded lock; it is a lock that MANUFACTURES the double-spawn it exists to prevent.
        //
        // So a different epoch only means "dead" when that launch cannot prove it is running, and
        // the proof is a lock the KERNEL releases on death rather than a pid probe.
        let d = tmp();
        crate::babysit_lease::hold_instance_lock(d.path(), "launch-sibling");
        seed(d.path(), claim_of("", "autoscaler-sibling", "launch-sibling", T0));
        let refused = acquire(d.path(), "", "autoscaler-live", T0 + 1_000);
        assert!(!refused.acquired, "a LIVE sibling's claim must not be stolen: {refused:?}");
        assert_eq!(refused.reason.as_deref(), Some(REASON_HELD_LIVE));
        // ...and the veto only defers to the HEARTBEAT rule, it does not override it: the same live
        // sibling that stops checking in is still reclaimable, or a wedged instance would park the
        // bead for as long as its process happened to stay up.
        let took = acquire(d.path(), "", "autoscaler-live", T0 + STALE_MS_DEFAULT + 1);
        assert!(took.acquired, "a live sibling that went quiet is still reclaimable: {took:?}");
        assert!(took.took_over);
    }

    #[test]
    fn a_claim_that_stopped_checking_in_expires_and_is_taken_over() {
        let d = tmp();
        // Same launch as the taker, so the epoch rule cannot help — this is the heartbeat backstop
        // on its own.
        seed(d.path(), claim_of("", "autoscaler-stuck", EPOCH_NOW, T0));
        let took = acquire(d.path(), "", "autoscaler-live", T0 + STALE_MS_DEFAULT + 1);
        assert!(took.acquired, "an expired claim must be reclaimable: {took:?}");
        assert!(took.took_over);
        assert!(took.detail.unwrap().contains("stopped checking in"));
    }

    #[test]
    fn a_claim_exactly_ON_the_threshold_is_still_live_ties_go_to_the_incumbent() {
        let d = tmp();
        seed(d.path(), claim_of("", "autoscaler-busy", EPOCH_NOW, T0));
        let refused = acquire(d.path(), "", "autoscaler-live", T0 + STALE_MS_DEFAULT);
        assert!(!refused.acquired, "strictly-greater: a claim AT the threshold still binds");
        assert_eq!(refused.reason.as_deref(), Some(REASON_HELD_LIVE));
    }

    #[test]
    fn a_heartbeat_from_the_FUTURE_reads_as_age_zero_not_as_a_wrapped_age() {
        // Clock skew (an NTP step, a machine waking with a bad RTC) must not hand a working agent's
        // bead to a second one.
        let d = tmp();
        seed(d.path(), claim_of("", "autoscaler-busy", EPOCH_NOW, T0 + 10 * 60 * 1000));
        let refused = acquire(d.path(), "", "autoscaler-live", T0);
        assert!(!refused.acquired, "a future stamp must read LIVE, not wrap to a colossal age");
    }

    #[test]
    fn renewing_keeps_a_claim_alive_indefinitely_across_repeated_passes() {
        // The steady state the 60s sweep produces: renew, renew, renew. A claim that expired
        // anyway would double-book a bead an agent is still working.
        let d = tmp();
        assert!(acquire(d.path(), "", "autoscaler-aaaa", T0).acquired);
        let mut t = T0;
        for pass in 0..40 {
            t += 60_000;
            heartbeat_at(d.path(), "", "autoscaler-aaaa", Some("agent-7"), EPOCH_NOW, t)
                .unwrap_or_else(|e| panic!("renewal {pass} failed: {e}"));
            let rival = acquire_at(d.path(), "", "autoscaler-bbbb", EPOCH_NOW, t, STALE_MS_DEFAULT);
            assert!(!rival.acquired, "pass {pass}: a renewed claim must keep binding");
        }
        // 40 minutes of renewals — past STALE_MS_DEFAULT — and it is still held.
        assert!(t - T0 > STALE_MS_DEFAULT);
    }

    #[test]
    fn a_released_claim_frees_the_bead_for_the_very_next_pass() {
        let d = tmp();
        assert!(acquire(d.path(), "", "autoscaler-aaaa", T0).acquired);
        release_at(d.path(), "", "autoscaler-aaaa", EPOCH_NOW).unwrap();
        let next = acquire(d.path(), "", "autoscaler-bbbb", T0 + 60_000);
        assert!(next.acquired, "release is the normal end of a claim's life: {next:?}");
        assert!(!next.took_over, "a released bead is FREE, not a takeover");
    }

    // ═══ REFUSALS THAT MUST NOT LOOK LIKE A FREE BEAD ══════════════════════════════════════════

    #[test]
    fn an_unparseable_store_is_UNKNOWN_and_writes_nothing() {
        let d = tmp();
        std::fs::write(store_path(d.path()), "{ not json").unwrap();
        let out = acquire(d.path(), "", "autoscaler-aaaa", T0);
        assert!(!out.acquired);
        assert_eq!(out.reason.as_deref(), Some(REASON_UNKNOWN));
        assert!(out.held_by.is_none(), "unknown must not imply WHO holds it");
        assert_eq!(
            std::fs::read_to_string(store_path(d.path())).unwrap(),
            "{ not json",
            "a refusal must be observationally read-only"
        );
    }

    #[test]
    fn an_EMPTY_store_file_is_UNKNOWN_not_free() {
        // This module never publishes an empty store (write-fsync-rename), so an empty file is
        // positive evidence of external truncation. Reading it as "no claims" is exactly the
        // reasoning that re-enables the double-spawn.
        let d = tmp();
        std::fs::write(store_path(d.path()), "   \n").unwrap();
        let out = acquire(d.path(), "", "autoscaler-aaaa", T0);
        assert!(!out.acquired);
        assert_eq!(out.reason.as_deref(), Some(REASON_UNKNOWN));
    }

    #[test]
    fn a_missing_store_is_FREE_because_nothing_has_ever_been_claimed() {
        let d = tmp();
        assert!(!store_path(d.path()).exists());
        let out = acquire(d.path(), "", "autoscaler-aaaa", T0);
        assert!(out.acquired, "a missing store is genuinely free: {out:?}");
    }

    #[test]
    fn a_malformed_call_is_INVALID_not_UNKNOWN() {
        // Opposite instructions: `unknown` says ask again next tick, `invalid` says these arguments
        // will never be accepted. Collapsing them told a sibling dispatcher to retry forever.
        let d = tmp();
        for bad in ["", "sparkle/aaa", "sparkle aaa", ".."] {
            let out = acquire(d.path(), bad, "autoscaler-aaaa", T0);
            assert_eq!(out.reason.as_deref(), Some(REASON_INVALID), "bead id {bad:?}");
        }
        let out = acquire(d.path(), "", "autoscaler:aaaa", T0);
        assert_eq!(out.reason.as_deref(), Some(REASON_INVALID), "claimant with a colon");
        assert!(!store_path(d.path()).exists(), "an invalid call must write nothing at all");
    }

    #[test]
    fn heartbeating_a_claim_someone_else_now_holds_is_LOST_not_UNKNOWN() {
        let d = tmp();
        assert!(acquire(d.path(), "", "autoscaler-aaaa", T0).acquired);
        let err = heartbeat_at(d.path(), "", "autoscaler-bbbb", None, EPOCH_NOW, T0 + 5)
            .unwrap_err();
        assert_eq!(err.reason, CLAIM_ERR_LOST, "{err}");
    }

    #[test]
    fn heartbeating_a_claim_that_does_not_exist_is_ABSENT() {
        let d = tmp();
        let err = heartbeat_at(d.path(), "", "autoscaler-aaaa", None, EPOCH_NOW, T0)
            .unwrap_err();
        assert_eq!(err.reason, CLAIM_ERR_ABSENT, "{err}");
    }

    #[test]
    fn releasing_a_claim_we_do_not_hold_is_refused_rather_than_silently_succeeding() {
        // The double-spawn from the other direction: a stale caller deleting the incumbent's claim.
        let d = tmp();
        assert!(acquire(d.path(), "", "autoscaler-aaaa", T0).acquired);
        let err = release_at(d.path(), "", "autoscaler-bbbb", EPOCH_NOW).unwrap_err();
        assert_eq!(err.reason, CLAIM_ERR_LOST, "{err}");
        let still = acquire(d.path(), "", "autoscaler-cccc", T0 + 10);
        assert!(!still.acquired, "the incumbent's claim must survive a foreign release");
    }

    #[test]
    fn heartbeat_never_CLEARS_an_agent_already_recorded() {
        let d = tmp();
        assert!(acquire(d.path(), "", "autoscaler-aaaa", T0).acquired);
        heartbeat_at(d.path(), "", "autoscaler-aaaa", Some("agent-7"), EPOCH_NOW, T0 + 1)
            .unwrap();
        let kept = heartbeat_at(d.path(), "", "autoscaler-aaaa", None, EPOCH_NOW, T0 + 2)
            .unwrap();
        assert_eq!(kept.agent_id.as_deref(), Some("agent-7"));
    }

    // ═══ LISTING ══════════════════════════════════════════════════════════════════════════════

    #[test]
    fn list_reports_each_claims_standing_and_REFUSES_rather_than_returning_an_empty_vec() {
        let d = tmp();
        assert!(acquire(d.path(), "sparkle-live", "autoscaler-aaaa", T0).acquired);
        seed(d.path(), claim_of("sparkle-gone", "autoscaler-dead", EPOCH_GONE, T0));
        seed(d.path(), claim_of("sparkle-stale", "autoscaler-stuck", EPOCH_NOW, T0));

        let now = T0 + STALE_MS_DEFAULT + 1;
        let views = list_at(d.path(), EPOCH_NOW, now, STALE_MS_DEFAULT).unwrap();
        let standing_of = |id: &str| {
            views.iter().find(|v| v.claim.bead_id == id).unwrap_or_else(|| panic!("{id} missing")).standing
        };
        // `sparkle-live` was acquired at T0 too, so at `now` it is stale by the heartbeat rule —
        // which is the point: a claim nobody renewed is dead however it was created.
        assert_eq!(standing_of("sparkle-live"), ClaimStanding::DeadStale);
        assert_eq!(standing_of("sparkle-gone"), ClaimStanding::DeadEpoch);
        assert_eq!(standing_of("sparkle-stale"), ClaimStanding::DeadStale);

        std::fs::write(store_path(d.path()), "{ not json").unwrap();
        let err = list_at(d.path(), EPOCH_NOW, now, STALE_MS_DEFAULT).unwrap_err();
        assert_eq!(err.reason, CLAIM_ERR_UNKNOWN, "an unreadable store is never an empty list");
    }

    #[test]
    fn list_reports_a_renewed_claim_as_LIVE() {
        let d = tmp();
        assert!(acquire(d.path(), "sparkle-live", "autoscaler-aaaa", T0).acquired);
        let views = list_at(d.path(), EPOCH_NOW, T0 + 60_000, STALE_MS_DEFAULT).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].standing, ClaimStanding::Live);
        assert_eq!(views[0].heartbeat_age_ms, 60_000);
    }

    // ═══ THE IDS PRODUCTION ACTUALLY SENDS ════════════════════════════════════════════════════
    //
    // The sibling lease was green for the whole time its ONE production caller minted an id its own
    // validator rejected: hand-written ids on this side, a stubbed `invoke` on the TS side, and
    // NEITHER suite ever saw the real string (sparkle-2hsrlz). `apps/desktop/shared/
    // autoscaler-claim-id.fixture.json` is the one payload both halves parse.

    fn fixture() -> serde_json::Value {
        // Resolved from CARGO_MANIFEST_DIR, not the process CWD, and built with `.join()` to match
        // every sibling read in `apps/desktop/shared/`.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("shared")
            .join("autoscaler-claim-id.fixture.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        serde_json::from_str(&raw).expect("the shared bead-claim id fixture must be valid JSON")
    }

    #[test]
    fn every_bead_id_the_board_carries_is_accepted_and_actually_claimable() {
        let f = fixture();
        let cases = f["beadIds"].as_array().expect("`beadIds` must be an array").clone();
        // GUARDS THE GUARD: an emptied or renamed array would make the loop vacuously pass, which
        // is the exact shape of the failure this test exists to end.
        assert!(cases.len() >= 4, "the fixture must carry the real cases, got {}", cases.len());
        let mut saw_dotted_child = false;
        let d = tmp();
        for case in &cases {
            let id = case["id"].as_str().expect("each case needs an `id`");
            let why = case["why"].as_str().unwrap_or("");
            assert!(is_bead_id(id), "the claim store would REFUSE this board id: {id:?} ({why})");
            // Not just the validator — the REAL entry point, so a store-key rule that rejected one
            // of these later could not hide behind a passing predicate.
            let out = acquire(d.path(), id, "autoscaler-0123456789abcdef", T0);
            assert!(out.acquired, "acquire refused a real board id {id:?}: {out:?}");
            if id.contains('.') {
                saw_dotted_child = true;
            }
        }
        assert!(saw_dotted_child, "the fixture must still cover a DOTTED child bead — the common case");
    }

    #[test]
    fn the_claimant_ids_the_TS_side_mints_all_pass_the_real_validator() {
        let f = fixture();
        let cases = f["claimantIds"].as_array().expect("`claimantIds` must be an array").clone();
        assert!(!cases.is_empty(), "the fixture must carry the minted shapes");
        let d = tmp();
        for (i, case) in cases.iter().enumerate() {
            let id = case["id"].as_str().expect("each case needs an `id`");
            assert!(is_actor_id(id), "the claim store would REFUSE this minted claimant id: {id:?}");
            let out = acquire(d.path(), &format!("sparkle-mint{i}"), id, T0);
            assert!(out.acquired, "acquire refused a minted claimant id {id:?}: {out:?}");
        }
    }

    #[test]
    fn the_ids_the_fixture_marks_REJECTED_really_are_rejected() {
        // The other half of the validator, and the direction a widening mutant breaks.
        let f = fixture();
        let cases = f["rejectedBeadIds"].as_array().expect("`rejectedBeadIds` must be an array").clone();
        assert!(!cases.is_empty());
        for case in &cases {
            let id = case["id"].as_str().expect("each case needs an `id`");
            assert!(!is_bead_id(id), "this must NOT be accepted as a store key: {id:?}");
        }
    }

    #[test]
    fn the_wire_carries_camelCase_so_the_TS_side_reads_real_values() {
        // A snake_case TS interface over a camelCase struct reads `undefined` for every field with
        // NOTHING logged (AGENTS.md). `autoscalerClaim.test.ts` pins the other half.
        let claim = claim_of("", "autoscaler-aaaa", EPOCH_NOW, T0);
        let json = serde_json::to_value(&claim).unwrap();
        for key in ["beadId", "claimantId", "agentId", "claimedAtMs", "heartbeatAtMs", "epoch"] {
            assert!(json.get(key).is_some(), "the wire must carry {key}: {json}");
        }
        // A Rust `Option` with no `skip_serializing_if` crosses as `null`, NEVER as an absent key —
        // so the TS interface must be `agentId: string | null`, not `agentId?: string`.
        assert!(json["agentId"].is_null());
    }

    impl ClaimOutcome {
        fn unwrap_claim(self) -> BeadClaim {
            self.claim.expect("expected an acquired claim")
        }
    }
}

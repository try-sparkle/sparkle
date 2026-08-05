//! THE BABYSIT DRIVER LEASE — exactly one `/babysit-pr` driver per pull request, durably, across
//! app restarts, and decided by a real compare-and-set rather than by an agent eyeballing
//! timestamps (bead `sparkle-5gxom`; the auto-dispatch half is `sparkle-4cd0x`).
//!
//! ── WHAT BREAKS WITHOUT IT ────────────────────────────────────────────────────────────────────
//! `.claude/skills/babysit-pr/SKILL.md` is a self-driving loop that REPLIES to review comments on a
//! human's pull request. Its own Step 1 forbids two drivers on one PR — "two drivers collide with
//! the never-reply-twice guardrail. One babysit driver per PR, decided up front." Today that rule
//! is enforced only by an agent reading comment timestamps and using judgement.
//!
//! Sparkle is about to dispatch that skill AUTOMATICALLY from a background timer. Two ticks that
//! both dispatch would double-post on a stranger's PR — the loudest, least-recoverable failure this
//! app can produce, because the damage is published to GitHub before anyone can see it. Judgement
//! does not survive being run on a timer; a lock does. This module is that lock.
//!
//! ── WHY NOT `pr_claims` ───────────────────────────────────────────────────────────────────────
//! `pr_claims.rs` answers a different question and says so in its own first paragraph: "A CLAIM IS
//! A COURTESY, NOT A LOCK." It lives in memory (dies with the app), caps at two hours, and a lapsed
//! claim is takeover-able BY DESIGN so a dead agent cannot wedge a PR. Every one of those choices is
//! right for "I intend to land this" and wrong for "I am the one running the reply loop". Extending
//! it would have to break the property its own consumers depend on. It is left completely alone.
//!
//! `pr_owner.rs` is the storage model this borrows — a small JSON file under the app-data dir,
//! process-wide mutex around read-modify-write — but it records OWNERSHIP, a fact that never
//! expires, not a RUNNING LOOP that must be detected as dead. Also left alone.
//!
//! ── THREE STATES, NEVER TWO ───────────────────────────────────────────────────────────────────
//! The same discipline `knightwatch.rs` and `services/mergeGuard/types.ts` spell out at length, and
//! here it is the whole safety argument:
//!
//!   * **FREE** — the store was read successfully and nothing holds `(repo, pr)`.
//!   * **HELD-LIVE** — a lease exists and its holder is still plausibly alive. Acquire REFUSES.
//!   * **HELD-DEAD** — a lease exists but its holder is gone. Acquire TAKES IT OVER, and says so.
//!   * **UNKNOWN** — the store could not be read or parsed. Acquire REFUSES, naming that reason.
//!
//! UNKNOWN MUST NEVER COLLAPSE INTO FREE. The harm being prevented is double-posting on a human's
//! pull request, so "I could not tell whether a driver exists" has to fail CLOSED against dispatch.
//! A module that returns an empty list when it cannot read its own store has re-introduced exactly
//! the bug it was written to close — which is why [`list_at`] returns `Result` rather than a `Vec`
//! that a caller would read as "no drivers running".
//!
//! ── WHAT MAKES A LEASE DEAD ───────────────────────────────────────────────────────────────────
//! Two independent tests, and the cheap one is checked first:
//!
//!   1. **EPOCH MISMATCH ⇒ DEAD, once the holder's process is provably gone.** Every lease records
//!      the app-launch epoch of its holder. Sparkle restarted three times in one day and lost every
//!      PTY each time, so a driver from a PREVIOUS launch is normally gone — there is no process
//!      left to double-post — and recording the epoch turns restart recovery into a string
//!      comparison instead of making a freshly-launched app sit out a 90-minute timeout with a PR
//!      unwatched. The ONE case where a different epoch does not mean a dead holder is a live
//!      SIBLING instance sharing this app-data dir, and treating that as dead would be catastrophic
//!      rather than merely slow (see ATOMICITY below), so an instance that can still prove it is
//!      running vetoes the verdict. That proof is a lock the KERNEL releases on death rather than a
//!      pid probe — see [`epoch_is_alive`] for why a pid cannot answer this question.
//!   2. **STALE HEARTBEAT ⇒ DEAD.** Same launch, but nothing has checked in for
//!      [`STALE_MS_DEFAULT`]. See that constant for why the number is what it is.
//!
//! A LIVE HOLDER THAT SIMPLY HAS NOT HEARTBEATED RECENTLY IS THE DANGEROUS CASE, so everything here
//! errs toward keeping the lease: the threshold is generous, the comparison is strictly-greater (a
//! lease exactly at the threshold is still live), and a heartbeat from the future (clock skew, an
//! NTP step) reads as age zero rather than as a negative that wraps.
//!
//! ── ATOMICITY, AT BOTH LEVELS ─────────────────────────────────────────────────────────────────
//! Two Pusher ticks must not both dispatch, so acquire is a genuine compare-and-set. The entire
//! read-decide-write runs under [`lock_store`], which is TWO locks in series:
//!
//!   * a process-wide `Mutex` (as `pr_owner` and `conflict_watch` hold theirs), and
//!   * an advisory `flock` on a sidecar file, because this app has no single-instance guard and two
//!     instances of the same build would otherwise share one app-data dir.
//!
//! The second one is not belt-and-braces. Without it, two instances break the guarantee TWICE: they
//! could both read FREE and both rename themselves in — and, far worse, each has its own
//! [`process_epoch`], so each would classify the other's LIVE lease as `DeadEpoch` and take it over,
//! forever. That is not a degraded lock; it is a lock that actively manufactures the two-drivers
//! outcome. The pid veto in rule 1 above closes the second half; the `flock` closes the first.
//!
//! The file itself is replaced by write-fsync-rename onto a temp file in the SAME directory, so a
//! crash mid-write leaves either the old store or the new one — never a truncated file, which would
//! parse as corrupt and, under a less careful design, as FREE.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

// ══ TUNING ══════════════════════════════════════════════════════════════════════════════════════

/// How long a lease survives without a heartbeat before it is DEAD and takeable: **90 minutes**.
///
/// Derived from the skill's real cadence, not picked for roundness. `babysit-pr`'s idle wait is a
/// `Monitor` capped at 14 × 120s ≈ **28 minutes** (`timeout_ms` 30 min sits just above it), and a
/// driver that wakes then does a FULL PASS on top of that: drain roborev (~3 min typical, ~6 min
/// p95, and it waits on reviews of the commits it just pushed), fetch and triage every GitHub
/// comment, apply fixes, run the suite, push, reply, re-arm. A pass with real work in it routinely
/// runs longer than the wait that preceded it.
///
/// So the threshold must comfortably exceed **one full re-arm plus one pass**. Setting it anywhere
/// near 28 minutes is the trap: a perfectly healthy driver in the middle of a long pass would have
/// its lease stolen and a second driver dispatched — MANUFACTURING the double-driver this module
/// exists to prevent, at the exact moment the PR is busiest. 90 minutes leaves ~62 minutes of pass
/// headroom past the wait, which is longer than any pass observed, and the cost of being generous is
/// only that a genuinely-crashed driver's PR waits at most 90 minutes for a takeover — while the
/// cost of being tight is a double-post on a stranger's PR. The asymmetry is not close.
///
/// The epoch check makes the common recovery instant anyway: an app restart (the way a driver
/// actually dies here) is detected immediately and never waits this out.
pub const STALE_MS_DEFAULT: u64 = 90 * 60 * 1000;

/// A lease dead by BOTH epoch and heartbeat for longer than this is dropped from the store the next
/// time we are writing anyway. Purely to stop the file growing without bound over months; it is
/// never consulted for a liveness decision, and the prune only ever runs on a path that already
/// holds the lock and is already writing.
const PRUNE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Refusal reasons. A TYPED vocabulary, not prose: the TypeScript consumer branches on these, and a
/// free sentence would make "held by a live driver" and "I cannot see the store" indistinguishable
/// to anything but a human reading a log.
pub const REASON_HELD_LIVE: &str = "held-live";
pub const REASON_UNKNOWN: &str = "unknown";

/// The same discipline for the OTHER two operations, and for the same reason — here it is if
/// anything sharper. A failed heartbeat is the only signal a running driver gets that it no longer
/// holds its lease, and "you were taken over, STOP DRIVING NOW" versus "the store was momentarily
/// unreadable, retry" are opposite instructions. A consumer that treats every `Err` as transient
/// keeps posting after losing the lease (a second driver); one that treats every `Err` as fatal
/// abandons a live PR on a blip. Neither is recoverable from a prose message.
///
/// `lost` and `absent` both mean STOP; `unknown` means RETRY; `invalid` means the call was
/// malformed and will never succeed as written.
pub const LEASE_ERR_LOST: &str = "lost";
pub const LEASE_ERR_ABSENT: &str = "absent";
pub const LEASE_ERR_UNKNOWN: &str = REASON_UNKNOWN;
pub const LEASE_ERR_INVALID: &str = "invalid";

/// A typed failure from [`heartbeat_at`], [`release_at`] or [`list_at`]. Serializes to
/// `{ reason, message }`, so a rejected promise on the TS side is branchable rather than
/// substring-matched.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseError {
    /// One of the `LEASE_ERR_*` constants.
    pub reason: String,
    /// Human-readable elaboration for the log. Never branched on.
    pub message: String,
}

impl LeaseError {
    fn new(reason: &str, message: impl Into<String>) -> Self {
        LeaseError { reason: reason.to_string(), message: message.into() }
    }
    fn lost(message: impl Into<String>) -> Self {
        Self::new(LEASE_ERR_LOST, message)
    }
    fn absent(message: impl Into<String>) -> Self {
        Self::new(LEASE_ERR_ABSENT, message)
    }
    fn unknown(message: impl Into<String>) -> Self {
        Self::new(LEASE_ERR_UNKNOWN, message)
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(LEASE_ERR_INVALID, message)
    }
}

impl std::fmt::Display for LeaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.reason, self.message)
    }
}

// ══ THE WIRE CONTRACT ═══════════════════════════════════════════════════════════════════════════

/// One driver's lease on one pull request.
///
/// IDENTITY IS `(repo, pr)`, NEVER `pr` ALONE. The same number names a different pull request in a
/// different repository — babysit-pr's own Step 1 says so about its argument, and `claim_pr` carries
/// the analogous note. A lease keyed on the bare number would let a driver on somebody else's #1176
/// block ours, and the failure would look like a mystery rather than a bug.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BabysitLease {
    /// `owner/name`, lowercased on the way in so `DRodio/Sparkle` and `drodio/sparkle` cannot hold
    /// two leases on the same PR.
    pub repo: String,
    pub pr: u64,
    /// The driver agent's id.
    pub agent_id: String,
    pub acquired_at_ms: u64,
    pub heartbeat_at_ms: u64,
    /// The app-launch epoch of the holder. See [`process_epoch`].
    pub epoch: String,
}

/// Whether a stored lease still binds. Computed in ONE place ([`standing`]) and handed to callers
/// pre-computed by [`list_at`], so nobody re-implements the liveness rule and gets it subtly
/// different — a second, slightly-wrong copy of this rule is how a double-driver gets dispatched.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeaseStanding {
    /// Same launch, heartbeated within [`STALE_MS_DEFAULT`]. Binding.
    Live,
    /// Recorded by a PREVIOUS app launch. Reclaimable, instantly.
    DeadEpoch,
    /// This launch, but nothing has checked in for [`STALE_MS_DEFAULT`]. Reclaimable.
    DeadStale,
}

/// What [`acquire_at`] hands back.
///
/// `tookOver` + `previousHolder` are not decoration: they are the entire difference between "this
/// PR got a fresh driver" and "we silently started a SECOND one". A log that cannot tell those apart
/// cannot be used to audit the thing this module exists to guarantee.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireOutcome {
    pub acquired: bool,
    /// The lease now held by the caller. `None` iff `acquired` is false.
    pub lease: Option<BabysitLease>,
    /// Who holds it instead. `None` when `acquired`, or when the reason is `unknown` (we could not
    /// read the store, so we do not know who — and must not imply nobody).
    pub held_by: Option<BabysitLease>,
    /// [`REASON_HELD_LIVE`] or [`REASON_UNKNOWN`]. `None` iff `acquired`.
    pub reason: Option<String>,
    /// True when the acquisition RECLAIMED a dead lease rather than starting from free.
    pub took_over: bool,
    /// The dead lease that was reclaimed, when `tookOver`.
    pub previous_holder: Option<BabysitLease>,
    /// Human-readable elaboration for the log. Never branched on — that is what `reason` is for.
    pub detail: Option<String>,
}

impl AcquireOutcome {
    fn won(lease: BabysitLease, previous: Option<BabysitLease>, detail: Option<String>) -> Self {
        AcquireOutcome {
            acquired: true,
            lease: Some(lease),
            held_by: None,
            reason: None,
            took_over: previous.is_some(),
            previous_holder: previous,
            detail,
        }
    }

    fn held_live(holder: BabysitLease) -> Self {
        let detail = format!(
            "{}#{} is already being babysat by agent {} (heartbeat {}ms). One driver per PR.",
            holder.repo, holder.pr, holder.agent_id, holder.heartbeat_at_ms
        );
        AcquireOutcome {
            acquired: false,
            lease: None,
            held_by: Some(holder),
            reason: Some(REASON_HELD_LIVE.into()),
            took_over: false,
            previous_holder: None,
            detail: Some(detail),
        }
    }

    fn unknown(detail: impl Into<String>) -> Self {
        AcquireOutcome {
            acquired: false,
            lease: None,
            held_by: None,
            reason: Some(REASON_UNKNOWN.into()),
            took_over: false,
            previous_holder: None,
            detail: Some(detail.into()),
        }
    }
}

/// A lease WITH its computed standing, for anything listing the fleet of drivers.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BabysitLeaseView {
    /// The store key, `"owner/name#123"`.
    pub key: String,
    pub lease: BabysitLease,
    pub standing: LeaseStanding,
    /// Milliseconds since the last heartbeat, clamped at zero for a future timestamp.
    pub heartbeat_age_ms: u64,
}

/// The whole durable store: a plain JSON map keyed `"owner/name#123"`. Flat and human-readable on
/// purpose — the first thing anybody debugging a stuck driver will do is `cat` it.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(transparent)]
pub struct BabysitLeaseStore {
    pub leases: BTreeMap<String, BabysitLease>,
}

// ══ EPOCH ═══════════════════════════════════════════════════════════════════════════════════════

/// This app launch's epoch, generated ONCE per process.
///
/// Format is `<launch_ms:x>-<pid:x>-<salt:016x>`, and uniqueness is the whole requirement: two
/// launches inside the same millisecond — a crash-restart loop, exactly when this matters — must
/// still differ, or a dead driver from the previous launch would read as LIVE and its PR would sit
/// unwatched until the heartbeat threshold expired. Hence all three components. The epoch is also
/// used as a FILENAME by [`instance_lock_path`], which is why every character here is
/// `[0-9a-f-]` — and why that function validates rather than trusts an epoch read back off disk.
pub fn process_epoch() -> &'static str {
    static EPOCH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    EPOCH.get_or_init(|| {
        let ms = now_ms();
        let pid = std::process::id();
        let salt: u64 = rand::random();
        format!("{ms:x}-{pid:x}-{salt:016x}")
    })
}

/// Milliseconds since the Unix epoch, or 0 for a clock before it (nothing here depends on that).
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ══ PURE RULES ══════════════════════════════════════════════════════════════════════════════════

/// `owner/name`, lowercased and validated, or `None`.
///
/// Rejecting rather than sanitising is deliberate: the result becomes half of a store KEY, and a
/// repo string carrying a `#` or a second `/` could forge a different PR's key. `None` propagates
/// to a refusal, which fails closed.
pub fn normalize_repo(repo: &str) -> Option<String> {
    let lowered = repo.trim().to_ascii_lowercase();
    if lowered.is_empty() || lowered.len() > 256 {
        return None;
    }
    let mut parts = lowered.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let segment_ok = |s: &str| {
        !s.is_empty()
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    (segment_ok(owner) && segment_ok(name)).then_some(lowered)
}

/// Agent ids as this app mints them — the same `[A-Za-z0-9_-]{1,128}` shape `worktree::validate_id`
/// enforces before an id is joined onto a path.
fn is_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The store key for a normalized repo and a PR number.
pub fn lease_key(repo: &str, pr: u64) -> String {
    format!("{repo}#{pr}")
}

/// How long since `lease` last checked in, clamped at zero.
///
/// `saturating_sub` is the clock-skew guard: a heartbeat stamped in the future (an NTP step, a
/// machine waking with a bad RTC) yields age 0 — the lease reads LIVE — rather than wrapping to a
/// colossal age that would read DEAD and hand a live driver's PR to a second one.
fn heartbeat_age_ms(lease: &BabysitLease, now_ms: u64) -> u64 {
    now_ms.saturating_sub(lease.heartbeat_at_ms)
}

/// Whether a stored lease still binds. THE liveness rule; there is no second copy.
///
/// Epoch first because it is both cheaper and stronger: a lease from a previous launch is normally
/// dead no matter how recent its heartbeat, since the process that wrote it no longer exists. The
/// exception is the whole reason [`epoch_is_alive`] exists — see the branch below.
pub fn standing(
    app_data: &Path,
    lease: &BabysitLease,
    current_epoch: &str,
    now_ms: u64,
    stale_ms: u64,
) -> LeaseStanding {
    if lease.epoch != current_epoch {
        // A different launch — but "different launch" and "dead holder" are only the same thing
        // when at most one instance is running. This app has NO single-instance guard, so a live
        // sibling sharing this app-data dir would otherwise be declared dead by us while declaring
        // US dead by the same rule: mutual takeover, forever, two drivers posting on one PR. An
        // instance that can still prove it is running vetoes the verdict, and we fall through to
        // the heartbeat test, which resolves it the slow-but-safe way.
        if !epoch_is_alive(app_data, &lease.epoch) {
            return LeaseStanding::DeadEpoch;
        }
    }
    // Strictly greater: a lease sitting exactly ON the threshold is still live. Ties go to the
    // incumbent, like every other tie in this module.
    if heartbeat_age_ms(lease, now_ms) > stale_ms {
        return LeaseStanding::DeadStale;
    }
    LeaseStanding::Live
}

// ══ FILE-BACKED STORE ═══════════════════════════════════════════════════════════════════════════

/// `<app_data>/babysit-leases.json`, alongside `pr_owner`'s `pr-owners.json`.
pub fn store_path(app_data: &Path) -> PathBuf {
    app_data.join("babysit-leases.json")
}

/// The in-process half of the compare-and-set. Exactly like `pr_owner`'s: held across a small read
/// and a small write. Without it, two threads could both read FREE and both write themselves in, and
/// the last writer would look like the sole holder while two drivers ran.
fn store_mutex() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// `<app_data>/babysit-leases.lock` — a sidecar the store write never touches, so the lock can never
/// be lost by the `rename` that replaces the store.
fn lock_path(app_data: &Path) -> PathBuf {
    app_data.join("babysit-leases.lock")
}

// ── INSTANCE LIVENESS ───────────────────────────────────────────────────────────────────────────
//
// "Is the app launch that minted this epoch still running?" — the question the epoch-death rule
// hinges on, and the one that must not be answered by probing a pid. `kill(pid, 0)` is wrong twice:
// a SIGKILLed instance lingering as a ZOMBIE still answers yes, and a pid recycled by the OS answers
// yes for a process that is not us at all. Both faults point the same way — a dead holder read as
// live — which silently reverts rule 1 from INSTANT restart recovery to the full 90-minute wait the
// epoch was introduced to remove. And with leases kept for `PRUNE_MS` (7 days) against a pid space
// that wraps at ~100k on a machine churning `git`/`gh` subprocesses, recycling is not a corner case.
//
// So liveness is proven by a mechanism the KERNEL maintains: every instance holds an exclusive
// `flock` on its own file for its entire lifetime. The kernel closes every descriptor when a process
// dies — SIGKILL included, and before any reaping, so a zombie holds nothing. Asking "is that
// instance alive" is therefore "can I take its lock": success means nobody holds it and it is gone.

/// `<app_data>/babysit-instance-<epoch>.lock`, or `None` for an epoch that must not reach a path.
///
/// A stored epoch can be anything a hand-edited file contains, and it is about to be joined onto a
/// path — so the character set is validated rather than trusted. Anything else yields `None`, which
/// reads as "cannot prove it alive" (i.e. dead), the same as an unrecognised epoch always did.
fn instance_lock_path(app_data: &Path, epoch: &str) -> Option<PathBuf> {
    let ok = !epoch.is_empty()
        && epoch.len() <= 64
        && epoch.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    ok.then(|| app_data.join(format!("babysit-instance-{epoch}.lock")))
}

/// The instance locks this process holds, one per app-data dir, for the process's whole life.
///
/// Keyed by path rather than a bare `OnceLock` because the tests drive several app-data dirs through
/// one process; production has exactly one. Nothing ever removes an entry outside tests — that is
/// the point, the `File` must outlive every operation.
fn instance_locks() -> &'static Mutex<std::collections::HashMap<PathBuf, std::fs::File>> {
    static LOCKS: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, std::fs::File>>> =
        std::sync::OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

/// Whether an open descriptor and a path still refer to the same file.
///
/// `false` on any stat failure, which routes to a re-registration attempt — the direction that can
/// only cost a redundant open, never a lost registration (see [`hold_instance_lock`]).
#[cfg(unix)]
fn is_same_file(file: &std::fs::File, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (file.metadata(), std::fs::metadata(path)) {
        (Ok(held), Ok(on_disk)) => held.dev() == on_disk.dev() && held.ino() == on_disk.ino(),
        _ => false,
    }
}

/// Take and HOLD this instance's liveness lock, so other instances can see we are running.
///
/// Idempotent and cheap after the first call. A failure is not fatal: it costs us the veto (other
/// instances may declare our leases dead by epoch), which is the same exposure as before this
/// mechanism existed — so it must not block the operation the caller actually asked for.
fn hold_instance_lock(app_data: &Path, epoch: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let Some(path) = instance_lock_path(app_data, epoch) else { return };
        let Ok(mut held) = instance_locks().lock() else { return };
        // A CACHED REGISTRATION IS ONLY VALID WHILE THE DESCRIPTOR WE HOLD STILL NAMES THE FILE AT
        // `path`. Caching on presence alone made any later disappearance permanent and silent for
        // the rest of the launch: a cleanup tool, a partial reinstall, a user clearing app data or a
        // stray `rm` unlinks the file while this long-lived process keeps its descriptor, and from
        // that instant `epoch_is_alive(us)` opens nothing, reads `NotFound`, and answers false — so
        // every sibling classifies our LIVE leases as `DeadEpoch` and takes them over. Comparing the
        // held fd's inode against the path costs two `stat`s inside a critical section we already
        // hold, and it is what makes the cache self-healing instead of a one-way latch.
        if held.get(&path).is_some_and(|f| is_same_file(f, &path)) {
            return;
        }
        // Re-register WITHOUT dropping the old entry first: if this fails (a transient stat error
        // over a file that is really still ours, a permissions change), keeping the descriptor we
        // have is strictly better than being left registered by nothing at all.
        let Ok(file) = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&path)
        else {
            return;
        };
        // SAFETY: an advisory lock on a descriptor we just opened and own.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            // `insert` returns the superseded `File`, whose drop releases the lock on the inode that
            // is no longer at `path`. If the inode WAS still ours the flock above would have
            // contended with our own descriptor and we would have kept it.
            held.insert(path, file);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (app_data, epoch);
    }
}

/// Whether the instance that minted `epoch` is still running.
///
/// Errs toward ALIVE on anything ambiguous — the direction that KEEPS a lease rather than stealing
/// it — but returns `false` when the liveness file is simply absent, because an epoch that never
/// registered cannot be a sibling of ours and must stay instantly reclaimable (that is rule 1).
fn epoch_is_alive(app_data: &Path, epoch: &str) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let Some(path) = instance_lock_path(app_data, epoch) else { return false };
        // READ-ONLY: `flock` works fine on a read-only descriptor, and opening for write would let a
        // permissions difference masquerade as death.
        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            // No liveness file: nothing has ever claimed this epoch is running.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
            // ANY OTHER ERROR IS NOT EVIDENCE OF DEATH. `EMFILE`/`ENFILE` is realistic in this app
            // (PTYs, watchers, agent subprocesses all hold descriptors), and collapsing it into
            // "dead" would declare a LIVE sibling dead — the catastrophic direction. It compounds
            // too: `prune_instance_locks` shares this predicate, so one transient failure would
            // DELETE a live instance's liveness file and cost it the veto for the rest of its life.
            Err(_) => return true,
        };
        // SAFETY: an advisory lock on a descriptor we just opened and own.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            // We took it, so nobody held it, so that instance is gone. Release immediately —
            // holding it would make US look like the owner of somebody else's epoch.
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
            return false;
        }
        // EWOULDBLOCK (someone holds it) or any other error: assume alive, keep the lease.
        true
    }
    #[cfg(not(unix))]
    {
        let _ = (app_data, epoch);
        false
    }
}

/// Delete liveness files for instances that are gone and own no surviving lease.
///
/// Called only from the write path, alongside [`prune`], so a refusal stays read-only. Without it
/// one small file accumulates per app launch, forever.
fn prune_instance_locks(app_data: &Path, store: &BabysitLeaseStore, current_epoch: &str) {
    let Ok(entries) = std::fs::read_dir(app_data) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(epoch) = name
            .to_str()
            .and_then(|n| n.strip_prefix("babysit-instance-"))
            .and_then(|n| n.strip_suffix(".lock"))
        else {
            continue;
        };
        if epoch == current_epoch || store.leases.values().any(|l| l.epoch == epoch) {
            continue;
        }
        if !epoch_is_alive(app_data, epoch) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// How long to wait for a sibling instance to finish its critical section before giving up. The
/// section is two syscalls, so anything approaching this means the other side is wedged — at which
/// point UNKNOWN (refuse to dispatch) is the right answer, not "wait forever".
#[cfg(not(test))]
const FLOCK_ATTEMPTS: u32 = 100;
/// Tests exercise the exhaustion branch deliberately, and 100 × 20ms of real sleeping per case is a
/// price the suite should not pay to prove a `for` loop terminates.
#[cfg(test)]
const FLOCK_ATTEMPTS: u32 = 3;
const FLOCK_RETRY_MS: u64 = 20;

/// Both halves of the compare-and-set, in series: the process-wide mutex, then an advisory `flock`
/// on [`lock_path`]. Dropping the returned guard releases both.
///
/// The mutex is taken FIRST on purpose. `flock` contends between file descriptions, so two threads
/// of ours opening the lock file separately would contend with each other and the non-blocking
/// retry loop would burn its budget against our own process. Serializing in-process first means the
/// `flock` is only ever contended by a genuine sibling instance.
///
/// See the module header for why the file lock is load-bearing rather than paranoia: without it two
/// instances of the same build take each other's live leases over in a loop.
struct StoreGuard {
    _mutex: std::sync::MutexGuard<'static, ()>,
    #[cfg(unix)]
    _file: std::fs::File,
}

fn lock_store(app_data: &Path, epoch: &str) -> Result<StoreGuard, String> {
    let mutex = store_mutex().lock().map_err(|e| format!("lease lock poisoned: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        std::fs::create_dir_all(app_data).map_err(|e| format!("lease lock dir: {e}"))?;
        let path = lock_path(app_data);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| format!("lease lock file {}: {e}", path.display()))?;
        for attempt in 0..FLOCK_ATTEMPTS {
            // SAFETY: `flock` only takes an advisory lock on the fd we just opened and own.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                // Register OUR liveness only now, INSIDE the critical section — still before any
                // store read, but no longer racing the sweep.
                //
                // Registering before the lock was a real hazard: a sibling's `prune_instance_locks`
                // runs under this same lock, and it would find our just-created file owning no
                // lease yet, take its still-free flock, call it dead and DELETE it. We would then
                // flock an unlinked inode and cache it in `instance_locks()`, so `contains_key`
                // short-circuits forever and we never re-register — after which every
                // `epoch_is_alive` about us answers false and our LIVE leases get taken over. Small
                // window, catastrophic direction.
                hold_instance_lock(app_data, epoch);
                return Ok(StoreGuard { _mutex: mutex, _file: file });
            }
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
                return Err(format!("lease lock {} failed: {err}", path.display()));
            }
            if attempt + 1 < FLOCK_ATTEMPTS {
                std::thread::sleep(std::time::Duration::from_millis(FLOCK_RETRY_MS));
            }
        }
        Err(format!(
            "another Sparkle instance has held the babysit lease lock at {} for over {}ms — refusing to guess whether a driver is running",
            path.display(),
            FLOCK_ATTEMPTS as u64 * FLOCK_RETRY_MS
        ))
    }
    #[cfg(not(unix))]
    {
        // No `flock`. The in-process mutex still makes this correct for a single instance, which is
        // the only configuration this platform is shipped in.
        let _ = (app_data, epoch);
        Ok(StoreGuard { _mutex: mutex })
    }
}

/// Read the store, distinguishing MISSING from UNREADABLE.
///
/// This is the single most important line in the module: a missing file is `Ok(empty)` (nothing has
/// ever been babysat — genuinely FREE), while an I/O error or a parse failure is `Err` (UNKNOWN, and
/// every caller refuses). `pr_owner::load_store` deliberately collapses both to empty because losing
/// an ownership mapping is harmless; losing a LEASE is a double-post.
pub fn load_store(app_data: &Path) -> Result<BabysitLeaseStore, String> {
    let path = store_path(app_data);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BabysitLeaseStore::default()),
        Err(e) => return Err(format!("babysit lease store unreadable at {}: {e}", path.display())),
    };
    if text.trim().is_empty() {
        // UNKNOWN, not FREE — and the reasoning is the opposite of the tempting one. This code can
        // NEVER publish an empty store: every write is a fully-written, fsync'd temp file renamed
        // into place. So a file that exists and is empty is positive evidence that something
        // OUTSIDE this module truncated it (a disk-full write by another tool, FS corruption, an
        // editor that saved a blank buffer). "There is provably no lease in it" is exactly the
        // reasoning that would re-enable double-dispatch on a human's PR, silently.
        return Err(format!(
            "babysit lease store at {} exists but is empty — this module never writes an empty store, so it was truncated externally. UNKNOWN, not free.",
            path.display()
        ));
    }
    serde_json::from_str(&text)
        .map_err(|e| format!("babysit lease store unparseable at {}: {e}", path.display()))
}

/// Replace the store atomically: write a temp file in the SAME directory, fsync it, then `rename`.
///
/// The fsync matters as much as the rename. `rename` is atomic, so a crash can never expose a
/// half-written file under the real name — but without the fsync a crash after the rename could
/// leave the new name pointing at unflushed (zero-length) content on some filesystems. Together they
/// guarantee the store is always either the old JSON or the new JSON.
fn save_store(app_data: &Path, store: &BabysitLeaseStore) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let final_path = store_path(app_data);
    // Unique per process AND per call: writes are serialized by `store_lock` within a process, but a
    // dev build and a release build could point at the same dir, and a leftover temp must never be
    // mistaken for another writer's in-flight file.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = app_data.join(format!(".babysit-leases.{}.{seq}.tmp", std::process::id()));
    let write = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, &final_path)
    })();
    if let Err(e) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("babysit lease store write failed at {}: {e}", final_path.display()));
    }
    Ok(())
}

/// Drop leases that are dead by BOTH tests and older than [`PRUNE_MS`], skipping `keep`.
///
/// Only ever called on a path that is already writing, so a REFUSAL never touches the file — which
/// keeps "acquire refused" observationally read-only and makes the corrupt-store test's "nothing was
/// written" assertion mean what it says.
fn prune(store: &mut BabysitLeaseStore, current_epoch: &str, now_ms: u64, keep: &str) {
    store.leases.retain(|key, lease| {
        key == keep
            || lease.epoch == current_epoch
            || heartbeat_age_ms(lease, now_ms) <= PRUNE_MS
    });
}

// ══ OPERATIONS ══════════════════════════════════════════════════════════════════════════════════

/// Take the lease on `(repo, pr)` for `agent_id`, or explain why not.
///
/// Time, epoch and threshold are parameters rather than reads of the clock so every rule above is
/// testable without sleeping through 90 minutes. The Tauri command supplies the real ones.
///
/// Re-acquiring a lease the SAME agent already holds in the SAME launch succeeds and refreshes it.
/// That is not a second driver: the caller is the incumbent, so a re-dispatch of the same agent is
/// idempotent rather than a collision.
pub fn acquire_at(
    app_data: &Path,
    repo: &str,
    pr: u64,
    agent_id: &str,
    epoch: &str,
    now_ms: u64,
    stale_ms: u64,
) -> AcquireOutcome {
    let Some(repo) = normalize_repo(repo) else {
        // Fails CLOSED, and reports `unknown` rather than inventing a third reason value: we truly
        // cannot say whether a driver exists for a repository we cannot name.
        return AcquireOutcome::unknown(format!("not a valid owner/name repo: {repo:?}"));
    };
    if pr == 0 || !is_agent_id(agent_id) {
        return AcquireOutcome::unknown(format!("invalid pr {pr} or agent id {agent_id:?}"));
    }

    let _guard = match lock_store(app_data, epoch) {
        Ok(g) => g,
        // Could not take the lock (a wedged sibling instance, or a poisoned mutex). UNKNOWN: we
        // cannot even look, so we certainly cannot say the PR is free.
        Err(e) => return AcquireOutcome::unknown(e),
    };
    let mut store = match load_store(app_data) {
        Ok(s) => s,
        // UNKNOWN. Refuse, write nothing, and do not imply the PR is free.
        Err(e) => return AcquireOutcome::unknown(e),
    };

    let key = lease_key(&repo, pr);
    let mut previous: Option<BabysitLease> = None;
    if let Some(existing) = store.leases.get(&key) {
        let is_self = existing.agent_id == agent_id && existing.epoch == epoch;
        match standing(app_data, existing, epoch, now_ms, stale_ms) {
            LeaseStanding::Live if !is_self => {
                return AcquireOutcome::held_live(existing.clone());
            }
            LeaseStanding::Live => {}
            // HELD-DEAD: reclaimable. Take it over rather than refuse — otherwise a restart leaves
            // the PR unwatched forever and a human has to notice and delete a file.
            LeaseStanding::DeadEpoch | LeaseStanding::DeadStale => {
                previous = Some(existing.clone());
            }
        }
    }

    let lease = BabysitLease {
        repo: repo.clone(),
        pr,
        agent_id: agent_id.to_string(),
        acquired_at_ms: now_ms,
        heartbeat_at_ms: now_ms,
        epoch: epoch.to_string(),
    };
    store.leases.insert(key.clone(), lease.clone());
    prune(&mut store, epoch, now_ms, &key);
    prune_instance_locks(app_data, &store, epoch);
    if let Err(e) = save_store(app_data, &store) {
        // We could not durably record the acquisition, so we must not report holding it — a driver
        // that believes it holds an unrecorded lease is exactly a second driver waiting to happen.
        return AcquireOutcome::unknown(e);
    }

    let detail = previous.as_ref().map(|p| {
        let why = match standing(app_data, p, epoch, now_ms, stale_ms) {
            LeaseStanding::DeadEpoch => "its holder was from a previous app launch",
            LeaseStanding::DeadStale => "its holder stopped heartbeating",
            LeaseStanding::Live => "recovered",
        };
        format!("took over {key} from agent {} — {why}", p.agent_id)
    });
    AcquireOutcome::won(lease, previous, detail)
}

/// Refresh the caller's lease. REFUSES when the caller is not the current holder.
///
/// The holder check is `(agent_id, epoch)`, not `agent_id` alone: an agent id reused across app
/// launches is a DIFFERENT process, and letting it refresh would resurrect a lease the epoch rule
/// just declared dead. A non-holder that could refresh someone else's lease is a lock with no owner.
///
/// A FAILURE HERE IS THE ONLY SIGNAL A RUNNING DRIVER GETS that it no longer holds the PR, so the
/// error is typed: [`LEASE_ERR_LOST`] and [`LEASE_ERR_ABSENT`] mean STOP DRIVING, and
/// [`LEASE_ERR_UNKNOWN`] means retry. A caller that cannot tell those apart either keeps posting
/// after being taken over (a second driver) or abandons a live PR on a transient read error.
pub fn heartbeat_at(
    app_data: &Path,
    repo: &str,
    pr: u64,
    agent_id: &str,
    epoch: &str,
    now_ms: u64,
) -> Result<(), LeaseError> {
    let repo = normalize_repo(repo)
        .ok_or_else(|| LeaseError::invalid(format!("not a valid owner/name repo: {repo:?}")))?;
    let _guard = lock_store(app_data, epoch).map_err(LeaseError::unknown)?;
    let mut store = load_store(app_data).map_err(LeaseError::unknown)?;
    let key = lease_key(&repo, pr);
    let Some(existing) = store.leases.get_mut(&key) else {
        return Err(LeaseError::absent(format!("no babysit lease on {key} to heartbeat")));
    };
    if existing.agent_id != agent_id || existing.epoch != epoch {
        return Err(LeaseError::lost(format!(
            "{key} is held by agent {} (epoch {}), not by {agent_id} — refusing to refresh someone else's lease",
            existing.agent_id, existing.epoch
        )));
    }
    if existing.heartbeat_at_ms >= now_ms {
        // Nothing to record (a repeated tick within the same millisecond, or a clock that stepped
        // backwards). Never move a heartbeat BACKWARDS — that would age a live lease toward death.
        return Ok(());
    }
    existing.heartbeat_at_ms = now_ms;
    save_store(app_data, &store).map_err(LeaseError::unknown)
}

/// Give the lease up. Same holder check and the same typed vocabulary as [`heartbeat_at`] —
/// releasing a lease you do not hold must not succeed silently, or one driver could free another's
/// PR for a third.
pub fn release_at(
    app_data: &Path,
    repo: &str,
    pr: u64,
    agent_id: &str,
    epoch: &str,
) -> Result<(), LeaseError> {
    let repo = normalize_repo(repo)
        .ok_or_else(|| LeaseError::invalid(format!("not a valid owner/name repo: {repo:?}")))?;
    let _guard = lock_store(app_data, epoch).map_err(LeaseError::unknown)?;
    let mut store = load_store(app_data).map_err(LeaseError::unknown)?;
    let key = lease_key(&repo, pr);
    let Some(existing) = store.leases.get(&key) else {
        return Err(LeaseError::absent(format!("no babysit lease on {key} to release")));
    };
    if existing.agent_id != agent_id || existing.epoch != epoch {
        return Err(LeaseError::lost(format!(
            "{key} is held by agent {} (epoch {}), not by {agent_id} — refusing to release someone else's lease",
            existing.agent_id, existing.epoch
        )));
    }
    store.leases.remove(&key);
    save_store(app_data, &store).map_err(LeaseError::unknown)
}

/// Every lease WITH its computed standing.
///
/// `Result`, not `Vec`, on purpose: an unreadable store must not render as an empty fleet. See the
/// module header — that collapse IS the bug this module closes.
pub fn list_at(
    app_data: &Path,
    epoch: &str,
    now_ms: u64,
    stale_ms: u64,
) -> Result<Vec<BabysitLeaseView>, LeaseError> {
    let _guard = lock_store(app_data, epoch).map_err(LeaseError::unknown)?;
    let store = load_store(app_data).map_err(LeaseError::unknown)?;
    Ok(store
        .leases
        .into_iter()
        .map(|(key, lease)| BabysitLeaseView {
            standing: standing(app_data, &lease, epoch, now_ms, stale_ms),
            heartbeat_age_ms: heartbeat_age_ms(&lease, now_ms),
            key,
            lease,
        })
        .collect())
}

// ══ TAURI COMMANDS ══════════════════════════════════════════════════════════════════════════════
//
// Thin wrappers that resolve the app-data dir, the process epoch and the real clock, then delegate.
// `async` + `spawn_blocking` throughout: a synchronous `#[tauri::command]` body runs on the MAIN
// thread, and one that takes a lock can freeze the whole UI if any other holder wedges. The file
// work and the mutex both belong off the event loop.

#[tauri::command]
pub async fn babysit_lease_acquire(
    app: AppHandle,
    repo: String,
    pr: u64,
    agent_id: String,
) -> Result<AcquireOutcome, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        acquire_at(
            &app_data,
            &repo,
            pr,
            &agent_id,
            process_epoch(),
            now_ms(),
            STALE_MS_DEFAULT,
        )
    })
    .await
    .map_err(|e| format!("babysit_lease_acquire task failed: {e}"))
}

#[tauri::command]
pub async fn babysit_lease_heartbeat(
    app: AppHandle,
    repo: String,
    pr: u64,
    agent_id: String,
) -> Result<(), LeaseError> {
    let app_data = crate::dev_identity::app_data_dir(&app).map_err(LeaseError::unknown)?;
    tauri::async_runtime::spawn_blocking(move || {
        heartbeat_at(&app_data, &repo, pr, &agent_id, process_epoch(), now_ms())
    })
    .await
    .map_err(|e| LeaseError::unknown(format!("babysit_lease_heartbeat task failed: {e}")))?
}

#[tauri::command]
pub async fn babysit_lease_release(
    app: AppHandle,
    repo: String,
    pr: u64,
    agent_id: String,
) -> Result<(), LeaseError> {
    let app_data = crate::dev_identity::app_data_dir(&app).map_err(LeaseError::unknown)?;
    tauri::async_runtime::spawn_blocking(move || {
        release_at(&app_data, &repo, pr, &agent_id, process_epoch())
    })
    .await
    .map_err(|e| LeaseError::unknown(format!("babysit_lease_release task failed: {e}")))?
}

#[tauri::command]
pub async fn babysit_leases(app: AppHandle) -> Result<Vec<BabysitLeaseView>, LeaseError> {
    let app_data = crate::dev_identity::app_data_dir(&app).map_err(LeaseError::unknown)?;
    tauri::async_runtime::spawn_blocking(move || {
        list_at(&app_data, process_epoch(), now_ms(), STALE_MS_DEFAULT)
    })
    .await
    .map_err(|e| LeaseError::unknown(format!("babysit_leases task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPOCH_A: &str = "launch-a";
    const EPOCH_B: &str = "launch-b";
    /// An arbitrary but realistic wall-clock base, so ages are never accidentally computed against 0.
    const T0: u64 = 1_754_000_000_000;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    /// Model an app launch ENDING. Dropping the held `File` closes the descriptor, which is exactly
    /// what the kernel does when a process dies, so [`epoch_is_alive`] starts answering `false`.
    ///
    /// Tests that model a restart must call this. That is not test scaffolding overhead — it is the
    /// semantics made explicit: "epoch B took over from epoch A" is only correct if A's process is
    /// GONE, and a test that skips this is asserting a live instance can be robbed.
    fn simulate_process_death(app_data: &Path, epoch: &str) {
        let path = instance_lock_path(app_data, epoch).expect("test epochs must be path-safe");
        let removed = instance_locks().lock().unwrap().remove(&path);
        assert!(removed.is_some(), "{epoch} never registered as running, so it cannot die");
        // Taking it OUT of the map is not the death; closing the descriptor is. Holding `removed`
        // one line longer keeps the lock and the "process" alive.
        drop(removed);
        assert!(!epoch_is_alive(app_data, epoch), "the liveness lock must be released on death");
    }

    fn acquire(d: &Path, agent: &str, now: u64) -> AcquireOutcome {
        acquire_at(d, "drodio/sparkle", 1176, agent, EPOCH_A, now, STALE_MS_DEFAULT)
    }

    /// Who the STORE says holds it — read back off disk, never from a return value. Every assertion
    /// below goes through this so the test is proving the persisted side effect, not the API's
    /// opinion of what it did.
    fn stored(d: &Path, repo: &str, pr: u64) -> Option<BabysitLease> {
        load_store(d).unwrap().leases.get(&lease_key(repo, pr)).cloned()
    }

    #[test]
    fn concurrent_acquires_produce_exactly_one_winner_and_one_stored_holder() {
        // THE HEADLINE CASE. Two Pusher ticks — or eight — must not both dispatch a driver. The
        // assertion is on the SIDE EFFECT: how many calls actually took the lease, and whose id the
        // file ends up carrying. That the calls returned proves nothing.
        let d = tmp();
        let dir = d.path().to_path_buf();
        let winners: Vec<AcquireOutcome> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let dir = dir.clone();
                    s.spawn(move || acquire(&dir, &format!("agent-{i}"), T0))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        let won: Vec<&AcquireOutcome> = winners.iter().filter(|o| o.acquired).collect();
        assert_eq!(won.len(), 1, "exactly one driver may hold a PR, got {}", won.len());
        let winner = won[0].lease.clone().unwrap();
        assert!(!won[0].took_over, "a first acquisition on a free PR is not a takeover");

        // The store is the authority, and it must name the ONE winner.
        let held = stored(d.path(), "drodio/sparkle", 1176).expect("a lease must be on disk");
        assert_eq!(held.agent_id, winner.agent_id);
        assert_eq!(held.epoch, EPOCH_A);
        assert_eq!(load_store(d.path()).unwrap().leases.len(), 1);

        // Every loser must be refused with the TYPED reason and must be told who won — a refusal
        // that cannot name the holder is unactionable.
        for lost in winners.iter().filter(|o| !o.acquired) {
            assert_eq!(lost.reason.as_deref(), Some(REASON_HELD_LIVE));
            assert_eq!(lost.held_by.as_ref().unwrap().agent_id, winner.agent_id);
            assert!(lost.lease.is_none());
        }
        assert_eq!(winners.iter().filter(|o| !o.acquired).count(), 7);
    }

    #[test]
    fn a_second_agent_is_refused_while_the_lease_is_live_and_the_holder_is_unchanged() {
        let d = tmp();
        assert!(acquire(d.path(), "driver-1", T0).acquired);
        let out = acquire(d.path(), "driver-2", T0 + 60_000);
        assert!(!out.acquired);
        assert_eq!(out.reason.as_deref(), Some(REASON_HELD_LIVE));
        assert_eq!(out.held_by.unwrap().agent_id, "driver-1");
        // The side effect that matters: the refusal did NOT touch the stored holder or its clock.
        let held = stored(d.path(), "drodio/sparkle", 1176).unwrap();
        assert_eq!(held.agent_id, "driver-1");
        assert_eq!(held.heartbeat_at_ms, T0);
        assert_eq!(held.acquired_at_ms, T0);
    }

    #[test]
    fn a_lease_from_a_previous_app_launch_is_taken_over_immediately() {
        // Requirement 4: respect the one-driver rule ACROSS RESTARTS — without waiting out a
        // 90-minute timeout while a PR sits unwatched.
        let d = tmp();
        assert!(acquire_at(d.path(), "drodio/sparkle", 1176, "old-driver", EPOCH_A, T0, STALE_MS_DEFAULT)
            .acquired);
        // That launch ENDS — the kernel drops its liveness lock. One millisecond later a NEW launch
        // finds the lease instantly dead, no matter how fresh its heartbeat.
        simulate_process_death(d.path(), EPOCH_A);
        let out = acquire_at(
            d.path(),
            "drodio/sparkle",
            1176,
            "new-driver",
            EPOCH_B,
            T0 + 1,
            STALE_MS_DEFAULT,
        );
        assert!(out.acquired);
        assert!(out.took_over, "a restart recovery must be reported as a takeover, not a fresh start");
        assert_eq!(out.previous_holder.unwrap().agent_id, "old-driver");
        let held = stored(d.path(), "drodio/sparkle", 1176).unwrap();
        assert_eq!(held.agent_id, "new-driver");
        assert_eq!(held.epoch, EPOCH_B);
        assert_eq!(held.acquired_at_ms, T0 + 1);
    }

    #[test]
    fn a_lease_whose_holder_stopped_heartbeating_is_taken_over() {
        let d = tmp();
        assert!(acquire(d.path(), "wedged-driver", T0).acquired);
        let out = acquire(d.path(), "fresh-driver", T0 + STALE_MS_DEFAULT + 1);
        assert!(out.acquired);
        assert!(out.took_over);
        assert_eq!(out.previous_holder.unwrap().agent_id, "wedged-driver");
        assert_eq!(stored(d.path(), "drodio/sparkle", 1176).unwrap().agent_id, "fresh-driver");
    }

    #[test]
    fn a_driver_mid_pass_keeps_its_lease_at_realistic_babysit_latencies() {
        // THE TEST THAT CATCHES A THRESHOLD SET TOO LOW. A driver that woke from the ~28-minute
        // Monitor and is grinding through a pass (roborev drain, triage, fixes, suite, push) has NOT
        // heartbeated recently — and stealing its lease would DISPATCH THE SECOND DRIVER this module
        // exists to prevent. Each of these is a plausible point mid-pass.
        for elapsed_min in [1u64, 28, 45, 60, 89] {
            let d = tmp();
            assert!(acquire(d.path(), "working-driver", T0).acquired);
            let out = acquire(d.path(), "impatient-driver", T0 + elapsed_min * 60_000);
            assert!(
                !out.acquired,
                "a driver {elapsed_min} minutes into a pass must keep its lease (threshold too low)"
            );
            assert_eq!(out.reason.as_deref(), Some(REASON_HELD_LIVE));
            assert_eq!(stored(d.path(), "drodio/sparkle", 1176).unwrap().agent_id, "working-driver");
        }
        // And the boundary itself belongs to the incumbent: dead is strictly PAST the threshold.
        let d = tmp();
        assert!(acquire(d.path(), "working-driver", T0).acquired);
        assert!(!acquire(d.path(), "impatient-driver", T0 + STALE_MS_DEFAULT).acquired);
        assert!(acquire(d.path(), "impatient-driver", T0 + STALE_MS_DEFAULT + 1).acquired);
    }

    #[test]
    fn the_stale_threshold_clears_one_full_monitor_rearm_plus_a_pass() {
        // Pins the reasoning in STALE_MS_DEFAULT's doc comment to a number, so lowering it toward
        // the Monitor cadence fails here rather than in production on somebody's PR.
        const MONITOR_REARM_MS: u64 = 28 * 60 * 1000;
        assert!(
            STALE_MS_DEFAULT >= MONITOR_REARM_MS * 3,
            "the threshold must comfortably exceed one re-arm plus one pass",
        );
    }

    #[test]
    fn a_heartbeat_from_a_non_holder_is_refused_and_changes_nothing() {
        let d = tmp();
        assert!(acquire(d.path(), "holder", T0).acquired);
        let before = stored(d.path(), "drodio/sparkle", 1176).unwrap();

        let err = heartbeat_at(d.path(), "drodio/sparkle", 1176, "interloper", EPOCH_A, T0 + 60_000)
            .unwrap_err();
        assert_eq!(err.reason, LEASE_ERR_LOST, "unexpected error: {err}");
        assert_eq!(
            stored(d.path(), "drodio/sparkle", 1176).unwrap(),
            before,
            "a refused heartbeat must not move the holder's clock",
        );

        // Same id, a PREVIOUS launch: also not the holder. Letting this through would resurrect a
        // lease the epoch rule just killed.
        let err = heartbeat_at(d.path(), "drodio/sparkle", 1176, "holder", EPOCH_B, T0 + 60_000)
            .unwrap_err();
        assert_eq!(err.reason, LEASE_ERR_LOST);
        assert!(err.message.contains("epoch"), "unexpected error: {err}");
        assert_eq!(stored(d.path(), "drodio/sparkle", 1176).unwrap(), before);

        // The real holder DOES move it — otherwise the assertions above would pass vacuously.
        heartbeat_at(d.path(), "drodio/sparkle", 1176, "holder", EPOCH_A, T0 + 60_000).unwrap();
        assert_eq!(stored(d.path(), "drodio/sparkle", 1176).unwrap().heartbeat_at_ms, T0 + 60_000);
    }

    #[test]
    fn a_heartbeat_keeps_a_long_running_driver_alive_past_the_threshold() {
        // The point of heartbeating at all: a driver that checks in survives arbitrarily long
        // passes, so the threshold never has to be tuned for the worst case.
        let d = tmp();
        assert!(acquire(d.path(), "long-driver", T0).acquired);
        for tick in 1..=4u64 {
            heartbeat_at(d.path(), "drodio/sparkle", 1176, "long-driver", EPOCH_A, T0 + tick * 60 * 60 * 1000)
                .unwrap();
        }
        // Four hours in, still held.
        let out = acquire(d.path(), "usurper", T0 + 4 * 60 * 60 * 1000 + 1000);
        assert!(!out.acquired);
        assert_eq!(stored(d.path(), "drodio/sparkle", 1176).unwrap().agent_id, "long-driver");
    }

    #[test]
    fn a_release_by_a_non_holder_is_refused_and_the_lease_still_stands() {
        let d = tmp();
        assert!(acquire(d.path(), "holder", T0).acquired);
        let before = stored(d.path(), "drodio/sparkle", 1176).unwrap();

        assert_eq!(
            release_at(d.path(), "drodio/sparkle", 1176, "interloper", EPOCH_A).unwrap_err().reason,
            LEASE_ERR_LOST,
        );
        assert_eq!(
            release_at(d.path(), "drodio/sparkle", 1176, "holder", EPOCH_B).unwrap_err().reason,
            LEASE_ERR_LOST,
        );
        assert_eq!(stored(d.path(), "drodio/sparkle", 1176).unwrap(), before);
        // Still binding: a third agent is still refused.
        assert!(!acquire(d.path(), "third", T0 + 1).acquired);

        // The holder can release, and then the PR is genuinely free.
        release_at(d.path(), "drodio/sparkle", 1176, "holder", EPOCH_A).unwrap();
        assert_eq!(stored(d.path(), "drodio/sparkle", 1176), None);
        let out = acquire(d.path(), "third", T0 + 2);
        assert!(out.acquired);
        assert!(!out.took_over, "acquiring a released PR is a fresh start, not a takeover");
    }

    #[test]
    fn a_corrupt_store_refuses_with_unknown_and_writes_nothing() {
        // UNKNOWN MUST NOT COLLAPSE INTO FREE. If it did, one bad file would re-enable exactly the
        // double-dispatch this module exists to prevent — and silently.
        let d = tmp();
        std::fs::create_dir_all(d.path()).unwrap();
        std::fs::write(store_path(d.path()), "{ not json").unwrap();

        let out = acquire(d.path(), "driver-1", T0);
        assert!(!out.acquired);
        assert_eq!(out.reason.as_deref(), Some(REASON_UNKNOWN));
        assert!(out.held_by.is_none(), "unknown must not claim to know that nobody holds it");
        assert_eq!(
            std::fs::read_to_string(store_path(d.path())).unwrap(),
            "{ not json",
            "a refusal must not have rewritten the store",
        );
        // Listing must fail loudly rather than render an empty fleet.
        assert_eq!(list_at(d.path(), EPOCH_A, T0, STALE_MS_DEFAULT).unwrap_err().reason, REASON_UNKNOWN);
        assert_eq!(
            heartbeat_at(d.path(), "drodio/sparkle", 1176, "driver-1", EPOCH_A, T0).unwrap_err().reason,
            LEASE_ERR_UNKNOWN,
            "an unreadable store must say RETRY, not `lost` — a driver told `lost` stops driving",
        );

        // …and a store that has never existed is genuinely FREE, which is the distinction the whole
        // three-state rule rests on.
        let fresh = tmp();
        assert!(acquire(fresh.path(), "driver-1", T0).acquired);
    }

    #[test]
    fn an_externally_truncated_store_is_unknown_not_free() {
        // roborev 58258. A zero-length store is NOT "provably no lease": this module can never
        // publish one (every write is a fully-written, fsync'd temp renamed into place), so an empty
        // file is positive evidence something outside truncated it. Reading it as FREE would
        // re-enable double dispatch on a human's PR, silently — from a file nobody would look twice
        // at, unlike the obviously-corrupt case above.
        for truncated in ["", "   \n"] {
            let d = tmp();
            std::fs::create_dir_all(d.path()).unwrap();
            std::fs::write(store_path(d.path()), truncated).unwrap();
            let out = acquire(d.path(), "driver-1", T0);
            assert!(!out.acquired, "an empty store must not read as FREE");
            assert_eq!(out.reason.as_deref(), Some(REASON_UNKNOWN));
            assert_eq!(
                std::fs::read_to_string(store_path(d.path())).unwrap(),
                truncated,
                "a refusal must not have rewritten the store",
            );
        }
    }

    #[test]
    fn a_driver_that_was_taken_over_learns_it_from_a_typed_lost_heartbeat() {
        // The taken-over path, which is the ONLY way a running driver finds out it must stop. If
        // this were indistinguishable from a transient read failure, a caller retrying on `Err`
        // would keep posting to the PR alongside its replacement.
        let d = tmp();
        assert!(acquire(d.path(), "driver-a", T0).acquired);
        let taken = acquire(d.path(), "driver-b", T0 + STALE_MS_DEFAULT + 1);
        assert!(taken.acquired && taken.took_over);

        let err = heartbeat_at(d.path(), "drodio/sparkle", 1176, "driver-a", EPOCH_A, T0 + STALE_MS_DEFAULT + 2)
            .unwrap_err();
        assert_eq!(err.reason, LEASE_ERR_LOST, "a taken-over driver must be told to STOP: {err}");
        assert_eq!(stored(d.path(), "drodio/sparkle", 1176).unwrap().agent_id, "driver-b");

        // A lease that is simply GONE is its own reason — also "stop", but not the same event.
        release_at(d.path(), "drodio/sparkle", 1176, "driver-b", EPOCH_A).unwrap();
        let err = heartbeat_at(d.path(), "drodio/sparkle", 1176, "driver-b", EPOCH_A, T0).unwrap_err();
        assert_eq!(err.reason, LEASE_ERR_ABSENT);
        // …and a malformed call is neither: it will never succeed as written.
        let err = heartbeat_at(d.path(), "not-a-repo", 1, "driver-b", EPOCH_A, T0).unwrap_err();
        assert_eq!(err.reason, LEASE_ERR_INVALID);
    }

    #[test]
    fn a_live_sibling_instances_lease_is_not_declared_dead_by_epoch() {
        // roborev 58258/58275. Two instances of the same build share one app-data dir (there is no
        // single-instance guard), and each has its own `process_epoch()`. Under a bare epoch
        // comparison each would read the OTHER's live lease as `DeadEpoch` and take it over — a
        // mutual-takeover loop that MANUFACTURES two drivers on one PR.
        let d = tmp();
        // `sibling` acquires; from OUR epoch's point of view its lease is from another launch.
        assert!(acquire_at(d.path(), "o/r", 1, "sibling-driver", EPOCH_B, T0, STALE_MS_DEFAULT).acquired);
        let lease = stored(d.path(), "o/r", 1).unwrap();

        // It is still running — so LIVE, not DeadEpoch, and a takeover is REFUSED.
        assert_eq!(standing(d.path(), &lease, EPOCH_A, T0, STALE_MS_DEFAULT), LeaseStanding::Live);
        let out = acquire_at(d.path(), "o/r", 1, "us", EPOCH_A, T0, STALE_MS_DEFAULT);
        assert!(!out.acquired, "a live sibling's lease must not be stolen");
        assert_eq!(out.reason.as_deref(), Some(REASON_HELD_LIVE));
        assert_eq!(stored(d.path(), "o/r", 1).unwrap().agent_id, "sibling-driver");

        // The veto is not a blanket amnesty: the heartbeat rule still reclaims a wedged sibling.
        assert_eq!(
            standing(d.path(), &lease, EPOCH_A, T0 + STALE_MS_DEFAULT + 1, STALE_MS_DEFAULT),
            LeaseStanding::DeadStale,
        );

        // Now that instance DIES — a SIGKILL, a crash, a quit. The kernel drops its lock, and the
        // ordinary restart case is reclaimed INSTANTLY rather than waiting out the threshold.
        simulate_process_death(d.path(), EPOCH_B);
        assert_eq!(standing(d.path(), &lease, EPOCH_A, T0, STALE_MS_DEFAULT), LeaseStanding::DeadEpoch);
        let out = acquire_at(d.path(), "o/r", 1, "us", EPOCH_A, T0, STALE_MS_DEFAULT);
        assert!(out.acquired && out.took_over);
        assert_eq!(stored(d.path(), "o/r", 1).unwrap().agent_id, "us");
    }

    #[test]
    fn an_epoch_that_never_registered_or_could_escape_a_path_is_not_alive() {
        let d = tmp();
        // An epoch nothing ever claimed cannot veto anything — that is rule 1 staying intact.
        assert!(!epoch_is_alive(d.path(), "never-seen"));
        // And an epoch read back off a hand-edited store must never reach the filesystem.
        assert_eq!(instance_lock_path(d.path(), "../../etc/passwd"), None);
        assert_eq!(instance_lock_path(d.path(), "a/b"), None);
        assert_eq!(instance_lock_path(d.path(), ""), None);
        assert_eq!(instance_lock_path(d.path(), &"x".repeat(65)), None);
        assert!(!epoch_is_alive(d.path(), "../../etc/passwd"));
        assert!(instance_lock_path(d.path(), process_epoch()).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn a_liveness_file_unlinked_behind_our_back_is_re_registered_not_cached_forever() {
        // roborev 58393. The file lives in the user's app-data dir; a cleanup tool, a partial
        // reinstall, a user clearing app data or a stray `rm` can unlink it while this long-lived
        // process keeps its descriptor. Caching registration on presence alone made that PERMANENT:
        // from that instant every sibling reads our LIVE leases as DeadEpoch and takes them over.
        let d = tmp();
        assert!(acquire(d.path(), "driver-1", T0).acquired);
        let path = instance_lock_path(d.path(), EPOCH_A).unwrap();
        assert!(path.exists());

        std::fs::remove_file(&path).unwrap();
        assert!(!epoch_is_alive(d.path(), EPOCH_A), "nothing on disk says we are running");

        // Any subsequent operation must re-establish it rather than short-circuit on a stale entry.
        heartbeat_at(d.path(), "drodio/sparkle", 1176, "driver-1", EPOCH_A, T0 + 1).unwrap();
        assert!(path.exists(), "registration must be re-established, not cached forever");
        assert!(epoch_is_alive(d.path(), EPOCH_A), "and it must be LOCKED, not merely present");

        // A REPLACED file (same path, different inode) is the same hazard and must also re-register.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"").unwrap();
        assert!(!epoch_is_alive(d.path(), EPOCH_A));
        heartbeat_at(d.path(), "drodio/sparkle", 1176, "driver-1", EPOCH_A, T0 + 2).unwrap();
        assert!(epoch_is_alive(d.path(), EPOCH_A));

        // …and the steady state does NOT churn: an untouched registration is left exactly as it was.
        use std::os::unix::fs::MetadataExt;
        let ino = std::fs::metadata(&path).unwrap().ino();
        heartbeat_at(d.path(), "drodio/sparkle", 1176, "driver-1", EPOCH_A, T0 + 3).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().ino(), ino);
    }

    #[cfg(unix)]
    #[test]
    fn a_liveness_file_we_cannot_open_reads_alive_and_survives_the_sweep() {
        // roborev 58318. Only NotFound means "never registered". Every other open failure —
        // EMFILE/ENFILE from descriptor exhaustion (realistic here: PTYs, watchers, agent
        // subprocesses), a permissions difference, a transient FS error — must read ALIVE. Reading
        // it as dead would declare a LIVE sibling dead, and because the sweep shares this predicate
        // it would also DELETE that sibling's file, turning a momentary misread into a permanent
        // loss of the veto.
        use std::os::unix::fs::PermissionsExt;
        let d = tmp();
        assert!(acquire_at(d.path(), "o/r", 1, "sibling", EPOCH_B, T0, STALE_MS_DEFAULT).acquired);
        let path = instance_lock_path(d.path(), EPOCH_B).unwrap();
        // Make it unopenable, then model that instance no longer being tracked in THIS process, so
        // the only remaining signal is the (failing) open.
        simulate_process_death(d.path(), EPOCH_B);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert!(epoch_is_alive(d.path(), EPOCH_B), "an unopenable file is not evidence of death");

        // …and the sweep must therefore leave it alone. Releasing the lease removes the last
        // reference to the epoch, which is exactly the state the sweep would otherwise collect.
        release_at(d.path(), "o/r", 1, "sibling", EPOCH_B).unwrap();
        assert!(acquire_at(d.path(), "o/other", 2, "us", EPOCH_A, T0, STALE_MS_DEFAULT).acquired);
        assert!(path.exists(), "a sweep must not delete a file it could not read");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!epoch_is_alive(d.path(), EPOCH_B), "readable and unlocked is genuinely dead");
    }

    #[test]
    fn dead_instances_liveness_files_are_cleaned_up_but_a_live_ones_is_kept() {
        let d = tmp();
        assert!(acquire_at(d.path(), "o/dead", 1, "a", EPOCH_B, T0, STALE_MS_DEFAULT).acquired);
        assert!(acquire_at(d.path(), "o/live", 2, "b", EPOCH_A, T0, STALE_MS_DEFAULT).acquired);
        let file_for = |e: &str| instance_lock_path(d.path(), e).unwrap().exists();
        assert!(file_for(EPOCH_A) && file_for(EPOCH_B));

        // EPOCH_B's instance dies and its lease is released, so nothing references it any more.
        release_at(d.path(), "o/dead", 1, "a", EPOCH_B).unwrap();
        simulate_process_death(d.path(), EPOCH_B);
        // The next write-path operation sweeps it; the LIVE instance's file survives.
        assert!(acquire_at(d.path(), "o/other", 3, "c", EPOCH_A, T0, STALE_MS_DEFAULT).acquired);
        assert!(!file_for(EPOCH_B), "a dead instance's liveness file must not accumulate forever");
        assert!(file_for(EPOCH_A), "the running instance's own file must survive its own sweep");
    }

    #[test]
    fn identity_is_repo_and_number_so_the_same_pr_number_elsewhere_is_independent() {
        // A driver on somebody else's #5 must not block ours.
        let d = tmp();
        let a = acquire_at(d.path(), "a/b", 5, "driver-a", EPOCH_A, T0, STALE_MS_DEFAULT);
        let c = acquire_at(d.path(), "c/d", 5, "driver-c", EPOCH_A, T0, STALE_MS_DEFAULT);
        assert!(a.acquired && c.acquired);
        assert_eq!(stored(d.path(), "a/b", 5).unwrap().agent_id, "driver-a");
        assert_eq!(stored(d.path(), "c/d", 5).unwrap().agent_id, "driver-c");
        // …and the SAME repo+number still collides.
        assert!(!acquire_at(d.path(), "a/b", 5, "driver-x", EPOCH_A, T0, STALE_MS_DEFAULT).acquired);
        // Case and surrounding whitespace name the same repo, not a second one.
        assert!(!acquire_at(d.path(), " A/B ", 5, "driver-x", EPOCH_A, T0, STALE_MS_DEFAULT).acquired);
        assert_eq!(load_store(d.path()).unwrap().leases.len(), 2);
    }

    #[test]
    fn the_same_agent_re_acquiring_its_own_live_lease_refreshes_it() {
        // A re-dispatch of the incumbent is not a collision; it must be idempotent, and it must
        // refresh the heartbeat so a re-entering driver cannot age itself out.
        let d = tmp();
        assert!(acquire(d.path(), "driver-1", T0).acquired);
        let again = acquire(d.path(), "driver-1", T0 + 60_000);
        assert!(again.acquired);
        assert!(!again.took_over);
        assert_eq!(stored(d.path(), "drodio/sparkle", 1176).unwrap().heartbeat_at_ms, T0 + 60_000);
        assert_eq!(load_store(d.path()).unwrap().leases.len(), 1);
    }

    #[test]
    fn listing_reports_the_computed_standing_so_no_caller_re_derives_it() {
        let d = tmp();
        acquire_at(d.path(), "o/live", 1, "a", EPOCH_A, T0, STALE_MS_DEFAULT);
        acquire_at(d.path(), "o/stale", 2, "b", EPOCH_A, T0, STALE_MS_DEFAULT);
        acquire_at(d.path(), "o/old", 3, "c", EPOCH_B, T0, STALE_MS_DEFAULT);
        simulate_process_death(d.path(), EPOCH_B);

        let now = T0 + STALE_MS_DEFAULT + 1;
        // `o/live` heartbeats; the other two do not.
        heartbeat_at(d.path(), "o/live", 1, "a", EPOCH_A, now).unwrap();
        let views = list_at(d.path(), EPOCH_A, now, STALE_MS_DEFAULT).unwrap();

        let by_key = |k: &str| views.iter().find(|v| v.key == k).unwrap().clone();
        assert_eq!(by_key("o/live#1").standing, LeaseStanding::Live);
        assert_eq!(by_key("o/live#1").heartbeat_age_ms, 0);
        assert_eq!(by_key("o/stale#2").standing, LeaseStanding::DeadStale);
        assert_eq!(by_key("o/old#3").standing, LeaseStanding::DeadEpoch);
        assert_eq!(views.len(), 3);
    }

    #[test]
    fn a_heartbeat_stamped_in_the_future_reads_live_rather_than_ancient() {
        // Clock skew must not kill a live driver. A negative age that wrapped would read as
        // hundreds of millions of years stale and hand the PR straight to a second driver.
        let lease = BabysitLease {
            repo: "o/r".into(),
            pr: 1,
            agent_id: "a".into(),
            acquired_at_ms: T0,
            heartbeat_at_ms: T0 + 10 * 60_000,
            epoch: EPOCH_A.into(),
        };
        assert_eq!(standing(Path::new("/nonexistent"), &lease, EPOCH_A, T0, STALE_MS_DEFAULT), LeaseStanding::Live);
        assert_eq!(heartbeat_age_ms(&lease, T0), 0);
        // …and a heartbeat must never be moved BACKWARDS by a stepped clock.
        let d = tmp();
        assert!(acquire(d.path(), "holder", T0 + 60_000).acquired);
        heartbeat_at(d.path(), "drodio/sparkle", 1176, "holder", EPOCH_A, T0).unwrap();
        assert_eq!(stored(d.path(), "drodio/sparkle", 1176).unwrap().heartbeat_at_ms, T0 + 60_000);
    }

    #[test]
    fn a_repo_string_that_could_forge_a_key_is_refused_at_the_boundary() {
        assert_eq!(normalize_repo("drodio/sparkle"), Some("drodio/sparkle".into()));
        assert_eq!(normalize_repo(" DRodio/Sparkle \n"), Some("drodio/sparkle".into()));
        // A `#` or an extra `/` in a repo could name a different PR's key entirely.
        assert_eq!(normalize_repo("a/b#9"), None);
        assert_eq!(normalize_repo("a/b/c"), None);
        assert_eq!(normalize_repo("sparkle"), None);
        assert_eq!(normalize_repo("a/"), None);
        assert_eq!(normalize_repo("../../etc"), None);
        assert_eq!(normalize_repo(""), None);

        // …and the refusal reaches the caller as UNKNOWN (fail closed), writing nothing.
        let d = tmp();
        let out = acquire_at(d.path(), "a/b#9", 1, "driver", EPOCH_A, T0, STALE_MS_DEFAULT);
        assert!(!out.acquired);
        assert_eq!(out.reason.as_deref(), Some(REASON_UNKNOWN));
        assert!(!store_path(d.path()).exists(), "an invalid request must not create a store");
        // A bogus PR number or agent id is refused the same way.
        assert!(!acquire_at(d.path(), "a/b", 0, "driver", EPOCH_A, T0, STALE_MS_DEFAULT).acquired);
        assert!(!acquire_at(d.path(), "a/b", 1, "bad id", EPOCH_A, T0, STALE_MS_DEFAULT).acquired);
        assert!(!acquire_at(d.path(), "a/b", 1, "", EPOCH_A, T0, STALE_MS_DEFAULT).acquired);
    }

    #[test]
    fn the_store_survives_a_process_restart_on_disk() {
        // Durability is the whole reason this is not `pr_claims`. Nothing in-process carries state:
        // a completely separate read of the file must see the lease.
        let d = tmp();
        assert!(acquire(d.path(), "driver-1", T0).acquired);
        let raw = std::fs::read_to_string(store_path(d.path())).unwrap();
        assert!(raw.contains("\"agentId\""), "the on-disk shape is the camelCase wire contract");
        assert!(raw.contains("drodio/sparkle#1176"), "keyed by repo AND number: {raw}");
        let reread: BabysitLeaseStore = serde_json::from_str(&raw).unwrap();
        assert_eq!(reread.leases["drodio/sparkle#1176"].agent_id, "driver-1");
    }

    #[test]
    fn long_dead_leases_are_pruned_only_on_a_write_never_on_a_refusal() {
        let d = tmp();
        acquire_at(d.path(), "o/ancient", 1, "ghost", EPOCH_B, T0, STALE_MS_DEFAULT);
        simulate_process_death(d.path(), EPOCH_B);
        acquire_at(d.path(), "o/live", 2, "holder", EPOCH_A, T0, STALE_MS_DEFAULT);
        assert_eq!(load_store(d.path()).unwrap().leases.len(), 2);

        // A refusal reads only — the ancient row is still there afterwards.
        let now = T0 + PRUNE_MS + 1;
        assert!(!acquire_at(d.path(), "o/live", 2, "other", EPOCH_A, T0 + 1000, STALE_MS_DEFAULT)
            .acquired);
        assert_eq!(load_store(d.path()).unwrap().leases.len(), 2);

        // A successful acquire is already writing, so it drops the long-dead row.
        assert!(acquire_at(d.path(), "o/new", 3, "fresh", EPOCH_A, now, STALE_MS_DEFAULT).acquired);
        let keys: Vec<String> = load_store(d.path()).unwrap().leases.into_keys().collect();
        assert!(!keys.contains(&"o/ancient#1".to_string()), "left: {keys:?}");
        assert!(keys.contains(&"o/new#3".to_string()));
        // The lease being acquired is never pruned out from under its own takeover.
        let out = acquire_at(d.path(), "o/live", 2, "taker", EPOCH_A, now, STALE_MS_DEFAULT);
        assert!(out.acquired && out.took_over);
        assert_eq!(out.previous_holder.unwrap().agent_id, "holder");
    }

    #[cfg(unix)]
    #[test]
    fn a_sibling_holding_the_store_flock_blocks_acquisition_rather_than_racing_it() {
        // roborev 58275: the previous version of this test asserted only that the sidecar existed
        // and kept its inode — all of which passes with `libc::flock` DELETED from `lock_store`, or
        // with `LOCK_SH` in place of `LOCK_EX`. This asserts the exclusion itself, which is the only
        // thing that fails if the cross-process half of the compare-and-set is broken.
        //
        // A SECOND OPEN FILE DESCRIPTION contends with the first even inside one process, so this
        // models the sibling instance faithfully without needing a second binary.
        use std::os::unix::io::AsRawFd;
        let d = tmp();
        std::fs::create_dir_all(d.path()).unwrap();
        let sibling = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(lock_path(d.path()))
            .unwrap();
        assert_eq!(unsafe { libc::flock(sibling.as_raw_fd(), libc::LOCK_EX) }, 0);

        // The whole point: we must NOT proceed to read-decide-write while someone else is mid-CAS.
        let out = acquire(d.path(), "driver-1", T0);
        assert!(!out.acquired, "acquisition must not race a sibling's critical section");
        assert_eq!(out.reason.as_deref(), Some(REASON_UNKNOWN));
        assert!(!store_path(d.path()).exists(), "a blocked acquire must not have written a lease");
        // Heartbeat and list are behind the same gate, and must say RETRY rather than STOP.
        assert_eq!(
            heartbeat_at(d.path(), "drodio/sparkle", 1176, "driver-1", EPOCH_A, T0).unwrap_err().reason,
            LEASE_ERR_UNKNOWN,
        );
        assert!(list_at(d.path(), EPOCH_A, T0, STALE_MS_DEFAULT).is_err());

        // A SHARED lock must block us too, and this is the case that pins `LOCK_EX`. If `lock_store`
        // were weakened to `LOCK_SH`, two instances would BOTH take a shared lock and BOTH proceed —
        // and a test whose sibling holds `LOCK_EX` cannot see that, because `LOCK_SH` still conflicts
        // with `LOCK_EX`. Holding the shared lock here models the mutated sibling exactly.
        assert_eq!(unsafe { libc::flock(sibling.as_raw_fd(), libc::LOCK_SH) }, 0);
        let out = acquire(d.path(), "driver-1", T0);
        assert!(!out.acquired, "a shared lock must still exclude us — the store lock is EXCLUSIVE");
        assert!(!store_path(d.path()).exists());

        // roborev 58318: registration happens INSIDE the critical section, so a blocked operation
        // must not have created our liveness file. Registering before the lock let a sibling's sweep
        // delete it in the window between create and flock, after which we could never re-register
        // and our own live leases became takeable.
        assert!(
            !instance_lock_path(d.path(), EPOCH_A).unwrap().exists(),
            "liveness registration must not happen outside the store lock",
        );

        // Once the sibling finishes, everything proceeds normally — the refusal was the wait
        // expiring, not a wedged lock of our own.
        assert_eq!(unsafe { libc::flock(sibling.as_raw_fd(), libc::LOCK_UN) }, 0);
        assert!(acquire(d.path(), "driver-1", T0).acquired);

        // The lock lives on its OWN file because the store is replaced by `rename`, which would
        // otherwise swap the locked inode out from under us mid-critical-section.
        use std::os::unix::fs::MetadataExt;
        let inode = |p: &Path| std::fs::metadata(lock_path(p)).unwrap().ino();
        let before = inode(d.path());
        heartbeat_at(d.path(), "drodio/sparkle", 1176, "driver-1", EPOCH_A, T0 + 1).unwrap();
        release_at(d.path(), "drodio/sparkle", 1176, "driver-1", EPOCH_A).unwrap();
        assert_ne!(lock_path(d.path()), store_path(d.path()));
        assert_eq!(inode(d.path()), before, "a store write must not replace the lock file");
    }

    #[test]
    fn the_process_epoch_is_stable_within_a_run_and_shaped_to_differ_between_runs() {
        assert_eq!(process_epoch(), process_epoch());
        // Three components (launch ms, pid, random salt) so two launches in the same millisecond
        // still differ — the crash-restart loop is exactly when that matters.
        assert_eq!(process_epoch().split('-').count(), 3, "epoch: {}", process_epoch());
        assert!(!process_epoch().is_empty());
    }
}

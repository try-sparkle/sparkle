//! Runtime arbitration for parallel agents: **port leases** and **gate locks**, both shared
//! machine-wide (bead `.5`).
//!
//! # The failure this exists for
//!
//! Filesystem isolation is solved — one worktree per agent. RUNTIME isolation is not. Two agents
//! verifying at once both reach for the same dev-server port, and the second one dies with a bare
//! "port is already in use" that names nobody. Mark's report was "task ui errors on the port —
//! testing is one-at-a-time"; Luis hand-rolled the answer as a `.gate.lock` under `.worktrees/`.
//!
//! There are TWO different problems in there, and collapsing them is why a single mechanism keeps
//! not working:
//!
//! * **A port that can move** — an ordinary preview dev server. Nobody cares *which* port it binds,
//!   only that no two agents pick the same one. That wants an ALLOCATOR: hand each asker a
//!   different number. [`acquire_port`].
//! * **A port that cannot move** — Sparkle's own dev server is `port: 1420, strictPort: true`
//!   (`vite.config.ts`), and `tauri.conf.json` names `devUrl = http://localhost:1420`. There is no
//!   second port to hand out, so allocation has nothing to say. That wants a QUEUE: exactly one
//!   holder at a time, and everybody else told who has it. [`acquire_gate_lock`].
//!
//! The same split covers a browser gate, a fixed test database, or any other genuinely-shared
//! singleton: if the resource can be duplicated, lease it; if it cannot, lock it.
//!
//! # Where the registry lives, and why it is not per-worktree
//!
//! `<git-common-dir>/sparkle-port-broker/`. `--git-common-dir` answers with the MAIN checkout's
//! `.git` from every linked worktree, so every agent on this machine reads and writes ONE registry.
//! A per-worktree path would give each agent its own private view in which it is always alone —
//! which is precisely the bug, restated as a directory layout. (Same resolution `drainer.rs` and
//! the beads store use, for the same reason.)
//!
//! Nothing here is tracked by git: the directory is inside `.git`, so there is no diff to review
//! and no branch to merge. That is correct — a lease is a fact about a running machine, not about
//! a revision.
//!
//! # It allocates. It does not kill.
//!
//! [`crate::dev_port_preflight`] draws a hard line: it will *name* a process holding a port and it
//! will never signal one it did not start. This module honours the same line from the other side.
//! It writes lease records and it removes its own; it never sends a signal, and it never removes a
//! record belonging to a live holder. The strongest thing it does to a peer is RECLAIM a lease, and
//! that needs BOTH conditions to hold at once:
//!
//!   1. the lease's heartbeat is older than the TTL, **and**
//!   2. the port is observably unbound right now.
//!
//! One alone is not enough, and the second is the important one. A holder that took a lease and is
//! sitting quietly on the socket — a dev server nobody has poked in an hour — is LIVE, and stealing
//! its port would produce the exact collision this module exists to prevent. So a quiet holder is
//! never reclaimed, however stale its heartbeat looks.
//!
//! # Concurrency is the whole feature
//!
//! Every mutation is an ATOMIC filesystem primitive, never a read-then-write:
//!
//! * **Take** — `OpenOptions::create_new` (`O_CREAT|O_EXCL`). Exactly one of N concurrent creators
//!   gets `Ok`; the rest get `AlreadyExists` and move on. Read-then-write would let two agents both
//!   observe "free" and both write.
//! * **Reclaim** — `fs::rename` the stale record aside. POSIX `rename` on a source that is already
//!   gone fails `ENOENT`, so exactly one of N concurrent reclaimers wins the right to re-create the
//!   record; the losers see the failure and skip. Overwriting in place would be last-write-wins,
//!   which is two holders believing they own the same port.
//!
//! # The clock
//!
//! Every expiry comparison goes through [`is_stale`], which uses `checked_duration_since` and reads
//! its `None` as NOT STALE. `saturating_duration_since` answers `0` for a backwards clock, and zero
//! elapsed reads as "heartbeated just now" — so a clock that steps backwards (NTP, a VM resume, a
//! user changing the date) would silently EXTEND every TTL and then, on the way back, make live
//! leases look freshly-stale. Refusing to judge is the only safe answer, and it fails in the
//! direction that never steals.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// One named gate lock and how long a holder may keep it without renewing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateLockSpec {
    pub name: String,
    pub ttl_secs: u64,
}

/// The subset of `[port_broker]` this module needs.
///
/// A plain struct rather than a borrow of `SparkleConfig`, exactly as `verify_gate::GateSettings`
/// is: every function here has to be unit-testable without building a whole config, and config.rs
/// must not depend on the module it configures. `PortBrokerConfig::to_broker_settings` is the one
/// seam between them, so a field added on one side and forgotten on the other fails to COMPILE
/// rather than going quietly inert.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrokerSettings {
    /// Opt-in master switch. FALSE by default — see `PortBrokerConfig`.
    pub enabled: bool,
    /// Inclusive allocation range. Reserved ports inside it are skipped, never handed out.
    pub range_start: u16,
    pub range_end: u16,
    /// How long a lease survives without a heartbeat before it is ELIGIBLE for reclamation. Note
    /// "eligible": staleness alone never reclaims — the port must also be observably unbound.
    pub lease_ttl_secs: u64,
    /// How often a holder is expected to renew. Advisory: this module never renews on its own
    /// behalf, it just publishes the cadence so a caller and the UI agree on one number.
    pub heartbeat_secs: u64,
    /// Named gate locks and their TTLs. A lock not listed here still works — it falls back to
    /// [`BrokerSettings::gate_ttl_for`]'s default — because refusing to lock an unlisted resource
    /// would make the config a gate on the gate.
    pub gate_locks: Vec<GateLockSpec>,
}

/// The default range. Deliberately high and narrow: well clear of every framework's own default
/// (3000/3001/5173/8080), clear of Sparkle's 1420, and small enough that "the range is full" is a
/// real, reportable state rather than a number nobody could ever exhaust.
pub const DEFAULT_RANGE_START: u16 = 45000;
pub const DEFAULT_RANGE_END: u16 = 45099;
/// 15 minutes. Long enough that a dev server mid-install is never judged dead, short enough that a
/// machine rebooted out from under a fleet clears itself before anyone files a bug.
pub const DEFAULT_LEASE_TTL_SECS: u64 = 900;
/// 60s. A twelfth of the TTL, so a holder has to miss a dozen beats before it looks gone.
pub const DEFAULT_HEARTBEAT_SECS: u64 = 60;
/// The gate-lock TTL for a name the config does not mention. 30 minutes: a browser gate or a
/// `pnpm dev` on the pinned port is a human-scale activity, and a TTL shorter than the work it
/// protects would hand the resource to a second agent while the first is still using it.
pub const DEFAULT_GATE_TTL_SECS: u64 = 1800;

/// The canonical gate lock for Sparkle's OWN dev server.
///
/// It is a lock rather than a lease because `strictPort` removes the only thing a lease could offer:
/// vite on 1420 does not walk to 1421, it exits. See this module's header.
pub const SPARKLE_DEV_GATE: &str = "-1420";

impl Default for BrokerSettings {
    fn default() -> Self {
        BrokerSettings {
            enabled: false,
            range_start: DEFAULT_RANGE_START,
            range_end: DEFAULT_RANGE_END,
            lease_ttl_secs: DEFAULT_LEASE_TTL_SECS,
            heartbeat_secs: DEFAULT_HEARTBEAT_SECS,
            gate_locks: vec![GateLockSpec {
                name: SPARKLE_DEV_GATE.to_string(),
                ttl_secs: DEFAULT_GATE_TTL_SECS,
            }],
        }
    }
}

impl BrokerSettings {
    /// The range as `(low, high)`, whichever order it was written in.
    ///
    /// A reversed range (`start = 45100, end = 45000`) would make `start..=end` EMPTY, and an empty
    /// range is indistinguishable from a full one at the call site: both report "no port available".
    /// Swapping is what a reader means by it, and it removes a failure whose message would send
    /// somebody looking for a leak.
    pub fn normalized_range(&self) -> (u16, u16) {
        if self.range_start <= self.range_end {
            (self.range_start, self.range_end)
        } else {
            (self.range_end, self.range_start)
        }
    }

    pub fn lease_ttl(&self) -> Duration {
        Duration::from_secs(self.lease_ttl_secs.max(1))
    }

    /// The TTL for a named gate lock: the configured one, or the default for a name nobody listed.
    pub fn gate_ttl_for(&self, name: &str) -> Duration {
        self.gate_locks
            .iter()
            .find(|g| g.name == name)
            .map(|g| Duration::from_secs(g.ttl_secs.max(1)))
            .unwrap_or_else(|| Duration::from_secs(DEFAULT_GATE_TTL_SECS))
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  RECORDS
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// One held port. Written as `<registry>/leases/<port>.json`; the FILE is the lock.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortLease {
    pub port: u16,
    pub agent_id: String,
    /// What the port is for — `"preview"`, `"dev-server"`, a test harness. Part of the identity of
    /// a lease, so one agent may hold a preview port and a separate harness port at once without
    /// the second request being answered with the first port.
    pub kind: String,
    pub pid: u32,
    pub acquired_at_ms: i64,
    pub heartbeat_at_ms: i64,
}

/// One held gate lock. Written as `<registry>/gates/<safe-name>.json`.
///
/// `ttl_secs` is stored ON THE RECORD rather than read from the reader's config, so a peer judges
/// expiry by the terms the HOLDER took the lock under. Two agents whose configs disagree would
/// otherwise disagree about whether a lock is live, and the one with the shorter TTL would steal it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateLock {
    /// The name as the caller wrote it. The FILENAME is a sanitized form of this; the raw name
    /// lives here so `gate_lock_status` can report what was actually asked for.
    pub name: String,
    pub agent_id: String,
    pub pid: u32,
    pub acquired_at_ms: i64,
    pub ttl_secs: u64,
}

/// A lease plus what the machine says about it right now. The read-side view; never persisted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseView {
    #[serde(flatten)]
    pub lease: PortLease,
    /// Heartbeat older than the TTL. NOT the same as reclaimable — see `bound`.
    pub expired: bool,
    /// Something is listening on the port right now. An expired lease whose port is BOUND is a live
    /// holder that simply has not checked in, and is never reclaimed.
    pub bound: bool,
}

/// A record file that exists and does not parse, named by its port.
///
/// SURFACED RATHER THAN SWALLOWED. Such a record holds its port against every acquirer until it is
/// old enough to reclaim, and it names nobody — so without this a port would go quietly missing from
/// the range with no way to find out which one or why. A number a human can act on beats a range
/// that is mysteriously one short.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadableLease {
    pub port: u16,
    pub path: String,
}

/// A gate lock plus its live expiry. The read-side view; never persisted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateLockView {
    #[serde(flatten)]
    pub lock: GateLock,
    pub expired: bool,
}

/// What [`acquire_gate_lock`] did.
///
/// A struct rather than a tagged enum because the frontend has to render all four cases and three
/// of them carry the same record. `lock` is ALWAYS the record in force afterwards — ours when we
/// took it, the HOLDER'S when we were refused — so a refusal message can always name somebody.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateLockOutcome {
    /// Did the caller end up holding it? True for taken / re-entered / reclaimed, false for refused.
    pub acquired: bool,
    pub state: GateState,
    pub lock: GateLock,
    /// The agent the lock was taken FROM, when `state` is `reclaimed`. `null` otherwise.
    pub reclaimed_from: Option<String>,
    /// Empty unless `state` is `refused`. Names the holder, its pid and when it took the lock.
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GateState {
    /// Nobody held it; we created the record.
    Acquired,
    /// WE already held it. Re-entrant by `agent_id`: an agent that takes the same lock twice gets
    /// it, refreshed, rather than deadlocking against itself.
    Reentered,
    /// The previous holder's TTL had run out and we took it over.
    Reclaimed,
    /// Somebody else holds it and their TTL has not run out. `message` says who.
    Refused,
}

/// What a release did. `holder` is `null` except for `held-by-other`, where it names the agent whose
/// record was left alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseOutcome {
    pub outcome: ReleaseState,
    pub holder: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReleaseState {
    /// It was ours and it is gone.
    Released,
    /// There was no record. Idempotent on purpose: releasing twice is not an error, and a stop path
    /// that has to distinguish them would grow a branch for a state nobody can act on.
    NotHeld,
    /// Somebody ELSE holds it. Left standing — releasing a peer's lock is exactly the collision this
    /// module exists to prevent, and doing it "helpfully" would be the worst version of it.
    HeldByOther,
}

/// Everything the registry currently holds. The status command's reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerStatus {
    /// The resolved registry directory, so a human can go look at it.
    pub registry: String,
    pub enabled: bool,
    pub range_start: u16,
    pub range_end: u16,
    pub lease_ttl_secs: u64,
    pub heartbeat_secs: u64,
    pub leases: Vec<LeaseView>,
    /// Lease files that exist and do not parse. Empty in every healthy registry; a non-empty list is
    /// a port held against everybody by a record that names nobody.
    pub unreadable: Vec<UnreadableLease>,
    pub gate_locks: Vec<GateLockView>,
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SEAMS — the clock, the pid, and "is anything on this port"
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Everything about the running machine that a decision here depends on, in one place so a test can
/// drive the REAL registry code against a controlled clock and a controlled port sense.
///
/// `is_bound` is a closure rather than a constant function because the racing cases this module has
/// to get right — an expired lease whose port is still bound, a dead holder whose port is free —
/// differ ONLY in what this answers.
pub struct Env<'a> {
    pub now_ms: i64,
    pub pid: u32,
    pub is_bound: &'a dyn Fn(u16) -> bool,
}

impl Env<'_> {
    /// The real machine: wall clock, this process, and an actual bind attempt.
    pub fn live() -> Env<'static> {
        Env { now_ms: now_ms(), pid: std::process::id(), is_bound: &port_is_bound }
    }
}

/// Milliseconds since the epoch. Zero if the clock is before 1970, which is not a state worth a
/// branch anywhere else.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Is anything listening on `port` right now?
///
/// Asked by BINDING rather than by shelling out to `lsof`: this runs inside an allocation loop that
/// may touch a hundred ports, and a hundred bounded subprocesses would take longer than the dev
/// server it is allocating for. A successful bind is dropped immediately.
///
/// KNOWN NARROWNESS, stated rather than hidden: this probes IPv4 loopback. A server bound only on
/// `[::1]` reads as unbound here. That is the same blind spot `preview::choose_listener` documents
/// on the discovery side and it fails in the tolerable direction — the worst outcome is a lease
/// handed out for a port a v6-only server holds, which the child's own bind then reports loudly.
/// It is NOT tolerable in the reclamation path, which is why reclamation additionally requires the
/// lease to be stale: a v6-only holder that is heartbeating is protected by the TTL alone.
pub fn port_is_bound(port: u16) -> bool {
    if port == 0 {
        return true;
    }
    TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)).is_err()
}

/// Has `stamp_ms` fallen further behind `now_ms` than `ttl`?
///
/// **THE CHECKED SUBTRACTION, NEVER THE SATURATING ONE.** `Instant::saturating_duration_since`
/// answers `Duration::ZERO` when the clock has run backwards, and zero elapsed is indistinguishable
/// from "stamped a moment ago" — so every TTL in this module would be silently EXTENDED for as long
/// as the skew lasted, and a lease that really had expired would be protected. Worse in the other
/// direction: a clock that jumps forward and back makes live records flap in and out of
/// reclaimability, which is two agents on one port.
///
/// The stamps here are wall-clock (they cross processes, which an `Instant` cannot), so the checked
/// form is `SystemTime::duration_since` — `Err` for a backwards clock, exactly where
/// `Instant::checked_duration_since` gives `None`. Both are read the same way, and it is the ONLY
/// expiry comparison in this module: nothing else subtracts two timestamps.
///
/// A backwards clock answers NOT STALE. That is the fail-closed direction for every caller here:
/// staleness is only ever used to justify taking something away from somebody else.
pub fn is_stale(now_ms: i64, stamp_ms: i64, ttl: Duration) -> bool {
    let (Some(now), Some(stamp)) = (ms_to_system_time(now_ms), ms_to_system_time(stamp_ms)) else {
        return false;
    };
    match now.duration_since(stamp) {
        Ok(elapsed) => elapsed >= ttl,
        Err(_) => false,
    }
}

/// Epoch milliseconds as a `SystemTime`. `None` for a value the platform cannot represent, which
/// [`is_stale`] reads as "cannot judge", i.e. not stale.
fn ms_to_system_time(ms: i64) -> Option<SystemTime> {
    if ms >= 0 {
        UNIX_EPOCH.checked_add(Duration::from_millis(ms as u64))
    } else {
        UNIX_EPOCH.checked_sub(Duration::from_millis(ms.unsigned_abs()))
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  PATHS
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// The registry directory name under the shared gitdir.
pub const REGISTRY_DIR: &str = "sparkle-port-broker";

/// `<git-common-dir>/sparkle-port-broker` for the repo `project_root` belongs to.
///
/// `--git-common-dir` is the flag that makes this SHARED: from a linked worktree it names the MAIN
/// repository's `.git`, so every agent on this machine resolves the same directory. `--git-dir`
/// would name each worktree's own admin dir and give every agent a private registry in which it is
/// permanently alone — the bug, spelled as a path. Mirrors `drainer::drainer_state_dir`.
///
/// Falls back to `<project_root>/.git/…` when git cannot be run at all. A guess is right for this
/// caller (a plain clone is the common shape, and the alternative is the feature simply not
/// working) and would be wrong for `worktree::repo_key_at`, which is why that one propagates the
/// failure instead.
pub fn registry_root(project_root: &Path) -> PathBuf {
    if let Some(dir) = std::env::var_os("SPARKLE_PORT_BROKER_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let common = Command::new("git")
        .arg("-C")
        .arg(project_root)
        .arg("rev-parse")
        .arg("--path-format=absolute")
        .arg("--git-common-dir")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { None } else { Some(PathBuf::from(s)) }
        })
        .unwrap_or_else(|| project_root.join(".git"));
    common.join(REGISTRY_DIR)
}

pub fn leases_dir(root: &Path) -> PathBuf {
    root.join("leases")
}

pub fn gates_dir(root: &Path) -> PathBuf {
    root.join("gates")
}

fn lease_path(root: &Path, port: u16) -> PathBuf {
    leases_dir(root).join(format!("{port}.json"))
}

/// Reduce a caller-supplied gate-lock name to ONE safe path segment.
///
/// `name` crosses the IPC boundary, so it is untrusted input to a path join: `../../..` would
/// otherwise let a caller create a JSON file anywhere the app can reach. Reuses
/// `verify_gate::safe_segment` rather than growing a second, subtly-different sanitizer — two
/// spellings of "make this safe" is how one of them ends up being the weaker one.
///
/// It is LOSSY (`a/b` and `a-b` both become `a-b`), which is why [`GateLock::name`] carries the raw
/// name: the filename is an address, the record is the answer.
fn gate_path(root: &Path, name: &str) -> PathBuf {
    gates_dir(root).join(format!("{}.json", crate::verify_gate::safe_segment(name)))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  ATOMIC PRIMITIVES — the two moves, and why neither is a read-then-write
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Monotonic within this process; combined with the pid it makes a name no concurrent reclaimer can
/// collide with. `Math.random`'s Rust equivalent is deliberately not reached for: a counter is
/// enough here and it keeps every test deterministic.
static NONCE: AtomicU64 = AtomicU64::new(0);

fn nonce() -> String {
    format!("{}-{}", std::process::id(), NONCE.fetch_add(1, Ordering::Relaxed))
}

/// TAKE. `O_CREAT|O_EXCL` — the kernel decides which of N concurrent creators wins.
///
/// `Err(AlreadyExists)` is the ordinary losing answer, not a fault: the caller moves to the next
/// port, or reports the holder. Any other error is a real filesystem problem and is propagated.
fn create_exclusive(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(bytes)?;
    f.flush()
}

/// RECLAIM. Rename the stale record aside; `true` means WE won the right to re-create it.
///
/// POSIX `rename` fails `ENOENT` when the source is already gone, so of N agents that all judge one
/// record stale at the same instant, exactly one gets `Ok`. The losers get `false` and skip the
/// port entirely rather than racing the winner to re-create it.
///
/// Overwriting the record in place would be the obvious implementation and is the bug: two
/// reclaimers would both "succeed", last write wins, and two agents would each hold a record saying
/// the port is theirs.
fn claim_stale(path: &Path) -> bool {
    let aside = path.with_extension(format!("reclaim-{}", nonce()));
    match fs::rename(path, &aside) {
        Ok(()) => {
            let _ = fs::remove_file(&aside);
            true
        }
        Err(_) => false,
    }
}

/// Overwrite an existing record we already own, atomically (write a temp, rename over).
///
/// Only ever called on a record whose `agent_id` we just read as ours, so this is a RENEWAL rather
/// than a claim, and the atomic-take rule does not apply: there is no second party competing to
/// write it. A concurrent reclaimer would have to have judged the record stale, which a renewal is
/// what prevents.
fn write_over(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", nonce()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.flush()?;
    }
    fs::rename(&tmp, path)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// A record that will not parse is `None`, never an error — the caller decides what that means.
///
/// It is NOT the same as absent, and conflating them is a real bug this file already had: a corrupt
/// file reads as `None`, so the acquirer skipped the reclaim branch, then lost `create_new` to the
/// file that is still sitting there, and the port was wedged forever with nothing saying why. See
/// [`unreadable_is_reclaimable`] for the discriminator that closes it.
fn read_lease(path: &Path) -> Option<PortLease> {
    read_json(path)
}

/// May an UNREADABLE record be reclaimed?
///
/// The tempting answer is "yes, it names nobody, so it protects nobody" — and it is wrong, because
/// there is a real window in which a perfectly valid lease is unreadable: [`create_exclusive`]
/// creates the file and then writes it, so for a few microseconds the winner's record is an empty
/// file. An acquirer that reclaimed every unparseable record would race the winner and hand two
/// agents one port, which is the exact collision this module exists to prevent.
///
/// The discriminator is AGE. An in-flight create is microseconds old; a corpse left by a crash is
/// minutes or hours old. So an unreadable record is reclaimable only once its mtime is older than
/// the lease TTL — and, as everywhere else here, only when the port is also observably unbound.
/// Both conditions, same as for a stale-but-readable lease.
///
/// A file whose mtime cannot be read at all answers `false`: refusing to judge is the direction
/// that never steals.
///
/// **IT READS THE WALL CLOCK ITSELF AND IGNORES [`Env::now_ms`], WHICH IS NOT AN OVERSIGHT.** An
/// mtime comes from the filesystem's clock; `Env::now_ms` is injected and, in a test, is whatever
/// the test chose. Comparing across the two is comparing readings of DIFFERENT clocks, and it
/// produced the failure that put this paragraph here: the racing test drives a synthetic `now` two
/// months in the future, so every freshly-created file looked two months old, every acquirer
/// "reclaimed" its rivals' in-flight creates, and eight agents came out holding five ports. A
/// timestamp may only ever be compared against the clock that produced it.
///
/// The consequence for callers is the useful half: an injected clock governs LEASE STAMPS (both
/// sides of which the caller supplies) and never file ages. A test that needs an aged corpse ages
/// the FILE, with `File::set_modified` — which is also a truer test, since that is the thing the
/// production path actually reads.
fn unreadable_is_reclaimable(path: &Path, ttl: Duration) -> bool {
    let Ok(modified) = fs::metadata(path).and_then(|m| m.modified()) else {
        return false;
    };
    match SystemTime::now().duration_since(modified) {
        Ok(age) => age >= ttl,
        // The file is stamped in the FUTURE — the same backwards-clock case `is_stale` refuses to
        // judge, and refused here for the same reason.
        Err(_) => false,
    }
}

fn read_gate(path: &Path) -> Option<GateLock> {
    read_json(path)
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  PORT LEASES
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Take a port for `agent_id`, or say why the range had nothing to give.
///
/// RE-ENTRANT BY `(agent_id, kind)`. An agent that asks twice gets the port it already holds, with a
/// refreshed heartbeat — not a second port. Without that, a preview that restarts leaks a lease per
/// restart and the range drains without a single real collision.
///
/// The scan order is deterministic (low to high), which makes a fleet's port assignment readable
/// rather than scattered, and makes a test able to say WHICH port an acquirer should have got.
pub fn acquire_port(
    root: &Path,
    settings: &BrokerSettings,
    agent_id: &str,
    kind: &str,
    env: &Env,
) -> Result<PortLease, String> {
    let dir = leases_dir(root);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create the port-lease registry at {}: {e}", dir.display()))?;

    // RE-ENTRY FIRST, before any allocation. Done as its own pass rather than inside the scan
    // because an existing lease on a HIGH port must win over a free LOW one — a scan that returned
    // the first free port would hand this agent a second port while it still holds the first.
    if let Some(mine) = find_lease(root, agent_id, kind) {
        let path = lease_path(root, mine.port);
        return renew_record(&path, mine, env);
    }

    let (low, high) = settings.normalized_range();
    let ttl = settings.lease_ttl();
    let mut held_by_others = 0usize;
    let mut occupied = 0usize;

    for port in low..=high {
        // Sparkle's own dev port is never allocated to a preview: a preview framed there would be
        // SAME-ORIGIN with the app document. `preview::is_reserved_port` is the one list.
        if crate::preview::is_reserved_port(port) {
            continue;
        }
        let path = lease_path(root, port);
        // THREE STATES, NOT TWO. A readable record, an UNREADABLE one, and nothing at all — and the
        // middle one is a distinct case with its own reclamation rule (see `unreadable_is_reclaimable`).
        let present = path.exists();
        let existing = read_lease(&path);
        if present {
            let reclaimable = match &existing {
                Some(lease) => {
                    // STALE IS NOT ENOUGH. A holder sitting quietly on its socket is LIVE; taking
                    // its port because it stopped heartbeating is the collision this whole module
                    // exists to prevent. Both conditions, in the cheap order.
                    is_stale(env.now_ms, lease.heartbeat_at_ms, ttl) && !(env.is_bound)(port)
                }
                None => unreadable_is_reclaimable(&path, ttl) && !(env.is_bound)(port),
            };
            if !reclaimable {
                held_by_others += 1;
                continue;
            }
            if !claim_stale(&path) {
                // Another reclaimer won the rename. Theirs now; do not race them for it.
                held_by_others += 1;
                continue;
            }
        }
        // Never hand out a port something is already on, lease or no lease — a human's `pnpm dev`
        // is invisible to this registry and is exactly as much of a collision.
        if (env.is_bound)(port) {
            occupied += 1;
            continue;
        }
        let lease = PortLease {
            port,
            agent_id: agent_id.to_string(),
            kind: kind.to_string(),
            pid: env.pid,
            acquired_at_ms: env.now_ms,
            heartbeat_at_ms: env.now_ms,
        };
        let bytes = serde_json::to_vec_pretty(&lease)
            .map_err(|e| format!("could not encode a port lease: {e}"))?;
        match create_exclusive(&path, &bytes) {
            Ok(()) => return Ok(lease),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Lost the create to a concurrent acquirer between our read and our write. This is
                // the ORDINARY outcome under contention, not a fault — move along.
                held_by_others += 1;
                continue;
            }
            Err(e) => return Err(format!("could not write the port lease for {port}: {e}")),
        }
    }

    Err(format!(
        "the port broker has no free port in {low}-{high}: {held_by_others} are leased by other \
         agents and {occupied} are bound by something outside the registry. Widen \
         `[port_broker].range` in .sparkle/config.toml, or stop an agent that is holding one — \
         `port_broker_status` lists every holder."
    ))
}

/// The lease this agent already holds for `kind`, if any. Deterministic (lowest port first) so two
/// records for one agent — which should not happen, but a crash mid-reclaim could leave — resolve
/// the same way for every reader.
pub fn find_lease(root: &Path, agent_id: &str, kind: &str) -> Option<PortLease> {
    list_leases(root).into_iter().find(|l| l.agent_id == agent_id && l.kind == kind)
}

/// Every lease in the registry, lowest port first. Unparseable files are skipped, not fatal.
pub fn list_leases(root: &Path) -> Vec<PortLease> {
    let Ok(rd) = fs::read_dir(leases_dir(root)) else {
        return Vec::new();
    };
    let mut out: BTreeMap<u16, PortLease> = BTreeMap::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(lease) = read_lease(&path) {
            out.insert(lease.port, lease);
        }
    }
    out.into_values().collect()
}

/// Lease files that exist and do not parse, lowest port first. See [`UnreadableLease`].
pub fn unreadable_leases(root: &Path) -> Vec<UnreadableLease> {
    let Ok(rd) = fs::read_dir(leases_dir(root)) else {
        return Vec::new();
    };
    let mut out: BTreeMap<u16, UnreadableLease> = BTreeMap::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if read_lease(&path).is_some() {
            continue;
        }
        // The port comes from the FILENAME here, because the only other place it lives is inside the
        // record we just failed to read.
        let Some(port) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u16>().ok())
        else {
            continue;
        };
        out.insert(port, UnreadableLease { port, path: path.to_string_lossy().to_string() });
    }
    out.into_values().collect()
}

/// The lease on one port, if the registry has one. This is what
/// [`crate::dev_port_preflight`] consults to turn "something is on 1420" into a name.
pub fn lease_on(root: &Path, port: u16) -> Option<PortLease> {
    read_lease(&lease_path(root, port))
}

/// Heartbeat: say the holder is still alive, so the TTL never runs out under it.
///
/// Refuses to touch a record belonging to somebody else. A renew that "helpfully" adopted a peer's
/// lease would be a silent transfer of ownership, which is the one thing a registry may not do.
pub fn renew_port(root: &Path, port: u16, agent_id: &str, env: &Env) -> Result<PortLease, String> {
    let path = lease_path(root, port);
    let Some(existing) = read_lease(&path) else {
        return Err(format!(
            "port {port} has no lease to renew — it may have been reclaimed after its TTL ran out. \
             Acquire it again rather than assuming it is still yours."
        ));
    };
    if existing.agent_id != agent_id {
        return Err(format!(
            "port {port} is leased by agent {} (pid {}), not by {agent_id} — refusing to renew \
             somebody else's lease.",
            existing.agent_id, existing.pid
        ));
    }
    renew_record(&path, existing, env)
}

fn renew_record(path: &Path, mut lease: PortLease, env: &Env) -> Result<PortLease, String> {
    lease.heartbeat_at_ms = env.now_ms;
    lease.pid = env.pid;
    let bytes =
        serde_json::to_vec_pretty(&lease).map_err(|e| format!("could not encode a port lease: {e}"))?;
    write_over(path, &bytes).map_err(|e| format!("could not renew the lease on {}: {e}", lease.port))?;
    Ok(lease)
}

/// Give a port back. Idempotent, and it never removes somebody else's record.
pub fn release_port(root: &Path, port: u16, agent_id: &str) -> ReleaseOutcome {
    let path = lease_path(root, port);
    let Some(existing) = read_lease(&path) else {
        // Includes the unparseable case. Reporting "not held" is right: there is nothing of ours
        // there, and the next acquirer's reclaim path clears the corpse.
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        return ReleaseOutcome { outcome: ReleaseState::NotHeld, holder: None };
    };
    if existing.agent_id != agent_id {
        return ReleaseOutcome {
            outcome: ReleaseState::HeldByOther,
            holder: Some(existing.agent_id),
        };
    }
    match fs::remove_file(&path) {
        Ok(()) => ReleaseOutcome { outcome: ReleaseState::Released, holder: None },
        Err(_) => ReleaseOutcome { outcome: ReleaseState::NotHeld, holder: None },
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  GATE LOCKS
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// How many times an acquire retries when it loses a race. Bounded, because "the record vanished
/// between our read and our create" can in principle repeat, and an unbounded loop in a lock
/// acquisition is how a fleet hangs. Four is far past what contention among a dozen agents needs;
/// exhausting it reports a refusal, which is the safe answer.
const GATE_ATTEMPTS: usize = 4;

/// How long to wait before LOOKING AGAIN after an attempt lost the race.
///
/// A LOST RACE IS A TORN READ, NOT AN EMPTY REGISTRY, and spinning straight back into a
/// `create_exclusive` that must fail is what turned that into a give-up. [`create_exclusive`]
/// creates the record and THEN writes it, so the winner's file is briefly zero bytes and
/// [`read_gate`] answers `None` for a file that plainly exists — the same window
/// [`unreadable_is_reclaimable`] exists for on the lease side. Four attempts issued back to back
/// all land inside it, and `acquire_gate_lock` ends in the "the record kept changing under us"
/// error rather than in the sentence it exists to produce.
///
/// MEASURED: six threads racing one name, with the machine under load, put FOUR of the six on that
/// error — so four of five losers were told "try again" instead of being told WHO holds the lock,
/// which is the one thing a refused caller needs. A few milliseconds is nothing against a
/// filesystem lock whose TTL is measured in tens of seconds, and it is long enough for the winner's
/// `write_all` + `flush` to land.
///
/// It is a BACKOFF, not a fixed sleep: the wait grows with the attempt, so the worst case across
/// every retry plus the final re-read stays under ~20ms while a badly-descheduled winner still gets
/// a widening window to finish in.
const GATE_RETRY_BACKOFF: Duration = Duration::from_millis(2);

/// Take the named lock for `agent_id`, or say who has it.
///
/// Four outcomes, all in [`GateLockOutcome`]: taken, RE-ENTERED (we already had it), reclaimed from
/// an expired holder, or refused. Re-entrancy is by `agent_id` and is not optional — the pinned-port
/// case takes this lock on every preview open for the same agent, so a non-re-entrant lock would
/// make an agent deadlock against its own previous run.
pub fn acquire_gate_lock(
    root: &Path,
    settings: &BrokerSettings,
    name: &str,
    agent_id: &str,
    ttl_override: Option<u64>,
    env: &Env,
) -> Result<GateLockOutcome, String> {
    let dir = gates_dir(root);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the gate-lock registry at {}: {e}", dir.display()))?;
    let path = gate_path(root, name);
    let ttl_secs = ttl_override
        .map(|s| s.max(1))
        .unwrap_or_else(|| settings.gate_ttl_for(name).as_secs());

    let mine = GateLock {
        name: name.to_string(),
        agent_id: agent_id.to_string(),
        pid: env.pid,
        acquired_at_ms: env.now_ms,
        ttl_secs,
    };
    let bytes =
        serde_json::to_vec_pretty(&mine).map_err(|e| format!("could not encode a gate lock: {e}"))?;

    for attempt in 0..GATE_ATTEMPTS {
        // Back off before looking again — see `GATE_RETRY_BACKOFF`. Never before the FIRST look:
        // the uncontended acquire is the common case and must not pay for the contended one.
        if attempt > 0 {
            std::thread::sleep(GATE_RETRY_BACKOFF * attempt as u32);
        }
        match read_gate(&path) {
            None => match create_exclusive(&path, &bytes) {
                Ok(()) => {
                    return Ok(GateLockOutcome {
                        acquired: true,
                        state: GateState::Acquired,
                        lock: mine,
                        reclaimed_from: None,
                        message: String::new(),
                    })
                }
                // Somebody created it between our read and our create. Go round: the next read sees
                // their record and answers re-entrant / refused / reclaim on its own terms.
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("could not write the gate lock `{name}`: {e}")),
            },
            Some(held) if held.agent_id == agent_id => {
                // RE-ENTRANT. Refresh the stamp so a long-running holder's own TTL cannot expire
                // under it mid-work, and keep the TTL the caller asked for this time.
                let refreshed = GateLock { pid: env.pid, acquired_at_ms: env.now_ms, ttl_secs, ..held };
                let fresh = serde_json::to_vec_pretty(&refreshed)
                    .map_err(|e| format!("could not encode a gate lock: {e}"))?;
                write_over(&path, &fresh)
                    .map_err(|e| format!("could not refresh the gate lock `{name}`: {e}"))?;
                return Ok(GateLockOutcome {
                    acquired: true,
                    state: GateState::Reentered,
                    lock: refreshed,
                    reclaimed_from: None,
                    message: String::new(),
                });
            }
            Some(held) => {
                // Judged by the HOLDER'S OWN TTL, off their record — see `GateLock::ttl_secs`.
                if !is_stale(env.now_ms, held.acquired_at_ms, Duration::from_secs(held.ttl_secs.max(1))) {
                    return Ok(GateLockOutcome {
                        acquired: false,
                        state: GateState::Refused,
                        message: refusal_message(&held, env.now_ms),
                        lock: held,
                        reclaimed_from: None,
                    });
                }
                if !claim_stale(&path) {
                    // Another reclaimer won the rename; go round and read whatever they wrote.
                    continue;
                }
                match create_exclusive(&path, &bytes) {
                    Ok(()) => {
                        return Ok(GateLockOutcome {
                            acquired: true,
                            state: GateState::Reclaimed,
                            lock: mine,
                            reclaimed_from: Some(held.agent_id),
                            message: String::new(),
                        })
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(format!("could not write the gate lock `{name}`: {e}")),
                }
            }
        }
    }

    // Every attempt lost a race. One last backoff before the give-up read, for the same reason the
    // loop has one: the record we could not parse a moment ago is almost certainly complete now, and
    // reading it turns an opaque "try again" into the holder's name.
    std::thread::sleep(GATE_RETRY_BACKOFF * GATE_ATTEMPTS as u32);
    // Report the holder we can see rather than inventing a success.
    match read_gate(&path) {
        Some(held) => Ok(GateLockOutcome {
            acquired: false,
            state: GateState::Refused,
            message: refusal_message(&held, env.now_ms),
            lock: held,
            reclaimed_from: None,
        }),
        None => Err(format!(
            "could not take the gate lock `{name}` after {GATE_ATTEMPTS} attempts — the record kept \
             changing under us, which means several agents are contending for it right now. Try again."
        )),
    }
}

/// The sentence a refused caller meets. NAMES THE HOLDER, because "the port is in use" without a
/// name is the original complaint this bead is about — a human who cannot tell which of eight
/// agents to stop has been told nothing.
pub fn refusal_message(held: &GateLock, now_ms: i64) -> String {
    let held_for = if now_ms >= held.acquired_at_ms {
        format!("{}s", (now_ms - held.acquired_at_ms) / 1000)
    } else {
        "an unknown time (this machine's clock has moved backwards)".to_string()
    };
    format!(
        "`{}` is held by agent {} (pid {}), taken {held_for} ago with a {}s TTL. It is a PINNED \
         resource, so there is no second one to hand out — wait for that agent, stop it, or release \
         the lock with `gate_lock_release`.",
        held.name, held.agent_id, held.pid, held.ttl_secs
    )
}

/// Give the named lock back. Idempotent; never removes somebody else's.
pub fn release_gate_lock(root: &Path, name: &str, agent_id: &str) -> ReleaseOutcome {
    let path = gate_path(root, name);
    let Some(held) = read_gate(&path) else {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        return ReleaseOutcome { outcome: ReleaseState::NotHeld, holder: None };
    };
    if held.agent_id != agent_id {
        return ReleaseOutcome { outcome: ReleaseState::HeldByOther, holder: Some(held.agent_id) };
    }
    match fs::remove_file(&path) {
        Ok(()) => ReleaseOutcome { outcome: ReleaseState::Released, holder: None },
        Err(_) => ReleaseOutcome { outcome: ReleaseState::NotHeld, holder: None },
    }
}

/// Every gate lock in the registry, by name.
pub fn list_gate_locks(root: &Path) -> Vec<GateLock> {
    let Ok(rd) = fs::read_dir(gates_dir(root)) else {
        return Vec::new();
    };
    let mut out: BTreeMap<String, GateLock> = BTreeMap::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(lock) = read_gate(&path) {
            out.insert(lock.name.clone(), lock);
        }
    }
    out.into_values().collect()
}

/// One named lock's record, if it exists.
pub fn gate_lock_on(root: &Path, name: &str) -> Option<GateLock> {
    read_gate(&gate_path(root, name))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  STATUS
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Everything the registry holds, with live expiry and boundness folded in.
pub fn status(root: &Path, settings: &BrokerSettings, env: &Env) -> BrokerStatus {
    let ttl = settings.lease_ttl();
    let (low, high) = settings.normalized_range();
    BrokerStatus {
        registry: root.to_string_lossy().to_string(),
        enabled: settings.enabled,
        range_start: low,
        range_end: high,
        lease_ttl_secs: settings.lease_ttl_secs,
        heartbeat_secs: settings.heartbeat_secs,
        unreadable: unreadable_leases(root),
        leases: list_leases(root)
            .into_iter()
            .map(|l| LeaseView {
                expired: is_stale(env.now_ms, l.heartbeat_at_ms, ttl),
                bound: (env.is_bound)(l.port),
                lease: l,
            })
            .collect(),
        gate_locks: list_gate_locks(root)
            .into_iter()
            .map(|l| GateLockView {
                expired: is_stale(env.now_ms, l.acquired_at_ms, Duration::from_secs(l.ttl_secs.max(1))),
                lock: l,
            })
            .collect(),
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE PREVIEW SEAM
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// What a preview took in order to bind its port, and everything needed to give it back.
///
/// Held on the preview's registry entry (`preview::Server`) rather than recomputed at stop time,
/// because stop has neither the project root nor the broker settings in hand, and re-resolving them
/// on a teardown path is how a release ends up being skipped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewPortHold {
    pub port: u16,
    /// Where the registry lives. Empty for the un-brokered path, which holds nothing.
    pub root: PathBuf,
    pub agent_id: String,
    /// A LEASE was taken on `port` and must be released.
    pub leased: bool,
    /// A GATE LOCK was taken (a pinned port, which cannot be reassigned) and must be released.
    pub gate: Option<String>,
}

impl PreviewPortHold {
    /// The un-brokered answer: a port, and nothing to give back.
    pub fn unheld(port: u16) -> Self {
        PreviewPortHold {
            port,
            root: PathBuf::new(),
            agent_id: String::new(),
            leased: false,
            gate: None,
        }
    }

    pub fn holds_anything(&self) -> bool {
        self.leased || self.gate.is_some()
    }
}

/// Decide the port a preview will bind, taking whatever the broker requires to hold it.
///
/// THE ONE ENTRY POINT the preview spawn path uses, and it answers BOTH configurations so the
/// enabled/disabled behaviour is one testable function rather than a branch inside `open_reserved`,
/// which no test can call:
///
/// * **disabled** — the historic `preview::allocate_port()` ephemeral bind-and-drop, and NOTHING is
///   written to the registry. A feature that is off must leave no trace, or "off" is not a state
///   anyone can verify.
/// * **enabled, no pin** — a LEASE from the configured range. The port can move, so allocation is
///   the right primitive.
/// * **enabled, pinned** — a GATE LOCK named `port-<n>`. A pinned port cannot be reassigned, so
///   there is nothing to allocate; the only question is who gets to use it, and a refusal names the
///   agent that has it.
pub fn choose_preview_port(
    root: &Path,
    settings: &BrokerSettings,
    agent_id: &str,
    pinned: Option<u16>,
) -> Result<PreviewPortHold, String> {
    choose_preview_port_with(root, settings, agent_id, pinned, &Env::live())
}

/// [`choose_preview_port`] with the machine injected, so a test drives the real registry code
/// against a controlled clock and port sense.
pub fn choose_preview_port_with(
    root: &Path,
    settings: &BrokerSettings,
    agent_id: &str,
    pinned: Option<u16>,
    env: &Env,
) -> Result<PreviewPortHold, String> {
    if !settings.enabled {
        let port = match pinned {
            Some(p) => p,
            None => crate::preview::allocate_port()?,
        };
        return Ok(PreviewPortHold::unheld(port));
    }
    match pinned {
        Some(port) => {
            let name = pinned_gate_name(port);
            let outcome = acquire_gate_lock(root, settings, &name, agent_id, None, env)?;
            if !outcome.acquired {
                return Err(format!(
                    "this project pins port {port}, and {}",
                    outcome.message
                ));
            }
            Ok(PreviewPortHold {
                port,
                root: root.to_path_buf(),
                agent_id: agent_id.to_string(),
                leased: false,
                gate: Some(name),
            })
        }
        None => {
            let lease = acquire_port(root, settings, agent_id, PREVIEW_KIND, env)?;
            Ok(PreviewPortHold {
                port: lease.port,
                root: root.to_path_buf(),
                agent_id: agent_id.to_string(),
                leased: true,
                gate: None,
            })
        }
    }
}

/// The `kind` a preview's lease carries. One constant so the acquire and the re-entry agree.
pub const PREVIEW_KIND: &str = "preview";

/// The gate-lock name for a pinned port. `port-5173`, so it reads as itself in
/// `port_broker_status` and a human can match it to the `[preview]` block that pinned it.
pub fn pinned_gate_name(port: u16) -> String {
    format!("port-{port}")
}

/// Give back whatever a preview took. Safe to call on a hold that took nothing, and safe to call
/// twice — both halves are idempotent.
pub fn release_preview_hold(hold: &PreviewPortHold) {
    if !hold.holds_anything() {
        return;
    }
    if hold.leased {
        let outcome = release_port(&hold.root, hold.port, &hold.agent_id);
        tracing::info!(
            port = hold.port,
            agent_id = %hold.agent_id,
            outcome = ?outcome.outcome,
            "port broker: released a preview lease"
        );
    }
    if let Some(name) = &hold.gate {
        let outcome = release_gate_lock(&hold.root, name, &hold.agent_id);
        tracing::info!(
            gate = %name,
            agent_id = %hold.agent_id,
            outcome = ?outcome.outcome,
            "port broker: released a pinned-port gate lock"
        );
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  WIRING
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Resolve `[port_broker]` for a project. One place, so every command reads config the same way.
pub fn settings_for(project_root: &str) -> BrokerSettings {
    crate::config::for_project(project_root).config.port_broker.to_broker_settings()
}

/// Take a port. `kind` defaults to `preview` for a caller that does not care.
#[tauri::command]
pub async fn port_broker_acquire(
    project_root: String,
    agent_id: String,
    kind: Option<String>,
) -> Result<PortLease, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        let root = registry_root(Path::new(&project_root));
        let kind = kind.unwrap_or_else(|| PREVIEW_KIND.to_string());
        acquire_port(&root, &settings, &agent_id, &kind, &Env::live())
    })
    .await
    .map_err(|e| format!("port_broker_acquire task failed: {e}"))?
}

/// Heartbeat one lease, so its TTL never runs out under a live holder.
#[tauri::command]
pub async fn port_broker_renew(
    project_root: String,
    port: u16,
    agent_id: String,
) -> Result<PortLease, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = registry_root(Path::new(&project_root));
        renew_port(&root, port, &agent_id, &Env::live())
    })
    .await
    .map_err(|e| format!("port_broker_renew task failed: {e}"))?
}

/// Give a port back.
#[tauri::command]
pub async fn port_broker_release(
    project_root: String,
    port: u16,
    agent_id: String,
) -> Result<ReleaseOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = registry_root(Path::new(&project_root));
        Ok(release_port(&root, port, &agent_id))
    })
    .await
    .map_err(|e| format!("port_broker_release task failed: {e}"))?
}

/// Everything the registry holds, plus the settings in force.
#[tauri::command]
pub async fn port_broker_status(project_root: String) -> Result<BrokerStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        let root = registry_root(Path::new(&project_root));
        Ok(status(&root, &settings, &Env::live()))
    })
    .await
    .map_err(|e| format!("port_broker_status task failed: {e}"))?
}

/// Take a named gate lock. Never rejects on refusal — a refusal is an ANSWER, carrying the holder,
/// and turning it into an `Err` would throw away the one thing the caller needs to say.
#[tauri::command]
pub async fn gate_lock_acquire(
    project_root: String,
    name: String,
    agent_id: String,
    ttl_secs: Option<u64>,
) -> Result<GateLockOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        let root = registry_root(Path::new(&project_root));
        acquire_gate_lock(&root, &settings, &name, &agent_id, ttl_secs, &Env::live())
    })
    .await
    .map_err(|e| format!("gate_lock_acquire task failed: {e}"))?
}

/// Give a named gate lock back.
#[tauri::command]
pub async fn gate_lock_release(
    project_root: String,
    name: String,
    agent_id: String,
) -> Result<ReleaseOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = registry_root(Path::new(&project_root));
        Ok(release_gate_lock(&root, &name, &agent_id))
    })
    .await
    .map_err(|e| format!("gate_lock_release task failed: {e}"))?
}

/// Read gate locks — one by `name`, or all of them.
#[tauri::command]
pub async fn gate_lock_status(
    project_root: String,
    name: Option<String>,
) -> Result<Vec<GateLockView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = registry_root(Path::new(&project_root));
        let env = Env::live();
        let locks = match name {
            Some(n) => gate_lock_on(&root, &n).into_iter().collect::<Vec<_>>(),
            None => list_gate_locks(&root),
        };
        Ok(locks
            .into_iter()
            .map(|l| GateLockView {
                expired: is_stale(env.now_ms, l.acquired_at_ms, Duration::from_secs(l.ttl_secs.max(1))),
                lock: l,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("gate_lock_status task failed: {e}"))?
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  TESTS
//
//  CONCURRENCY IS THE FEATURE, so these drive the REAL filesystem registry in a temp directory
//  rather than a mock: what is being asserted is WHO ENDED UP HOLDING THE THING, which a mock of
//  the registry cannot answer. `Env` injects the clock and the port sense, so the racing cases —
//  an expired lease whose port is still bound, a dead holder whose port is free — differ only in
//  the two inputs that actually distinguish them.
// ══════════════════════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    /// A narrow range, so "the range is full" is reachable and the port a test expects is namable.
    fn settings() -> BrokerSettings {
        BrokerSettings {
            enabled: true,
            range_start: 45000,
            range_end: 45004,
            lease_ttl_secs: 60,
            heartbeat_secs: 5,
            gate_locks: vec![GateLockSpec { name: "browser".into(), ttl_secs: 30 }],
        }
    }

    const T0: i64 = 1_800_000_000_000;
    fn never_bound(_p: u16) -> bool {
        false
    }
    fn always_bound(_p: u16) -> bool {
        true
    }

    fn env_at(now_ms: i64) -> Env<'static> {
        Env { now_ms, pid: 4242, is_bound: &never_bound }
    }

    /// Backdate a file's mtime. The production path judges an unreadable record by the FILESYSTEM's
    /// clock, so a test that needs an old one has to age the file, not the injected clock.
    fn age_file(path: &Path, by: Duration) {
        let when = SystemTime::now().checked_sub(by).expect("a representable mtime");
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open to set mtime")
            .set_modified(when)
            .expect("set_modified");
    }

    // ── PORT LEASES ─────────────────────────────────────────────────────────────────────────

    /// THE RACING CASE, with real threads and one real registry. The assertion is the SIDE EFFECT —
    /// how many DISTINCT ports the fleet ended up holding — not that a function was called.
    #[test]
    fn eight_agents_racing_for_one_range_end_up_on_eight_distinct_ports() {
        let dir = tmp();
        let root: PathBuf = dir.path().to_path_buf();
        let s = BrokerSettings { range_end: 45007, ..settings() };
        let mut handles = Vec::new();
        for i in 0..8 {
            let root = root.clone();
            let s = s.clone();
            handles.push(std::thread::spawn(move || {
                let env = Env { now_ms: T0, pid: 100 + i as u32, is_bound: &never_bound };
                acquire_port(&root, &s, &format!("agent-{i}"), "preview", &env)
            }));
        }
        let ports: Vec<u16> =
            handles.into_iter().map(|h| h.join().expect("thread").expect("a lease")).map(|l| l.port).collect();
        let mut uniq = ports.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq.len(), 8, "eight racing acquirers must hold eight DIFFERENT ports: {ports:?}");
        // And the registry agrees — the leases on disk are the record, not the return values.
        let on_disk = list_leases(&root);
        assert_eq!(on_disk.len(), 8);
        let mut agents: Vec<String> = on_disk.iter().map(|l| l.agent_id.clone()).collect();
        agents.sort();
        agents.dedup();
        assert_eq!(agents.len(), 8, "each port must be recorded to a DIFFERENT agent");
    }

    /// A range that runs out says so, and says what it is full OF — a message that only reported
    /// "no port" would send a reader looking for a leak that is not there.
    #[test]
    fn an_exhausted_range_names_who_filled_it() {
        let dir = tmp();
        let s = BrokerSettings { range_start: 45000, range_end: 45001, ..settings() };
        for i in 0..2 {
            acquire_port(dir.path(), &s, &format!("a{i}"), "preview", &env_at(T0)).expect("lease");
        }
        let err = acquire_port(dir.path(), &s, "late", "preview", &env_at(T0)).expect_err("full");
        assert!(err.contains("45000-45001"), "{err}");
        assert!(err.contains("2 are leased"), "{err}");
        assert!(err.contains("port_broker_status"), "the remedy must be reachable: {err}");
    }

    /// RE-ENTRANT BY (agent, kind). A preview that restarts must get its OWN port back, not a
    /// second one — otherwise every restart leaks a lease and the range drains with no collision.
    #[test]
    fn the_same_agent_and_kind_gets_the_same_port_back() {
        let dir = tmp();
        let s = settings();
        // Fill the low ports so the agent under test lands high, which is what makes this test able
        // to fail: a scan that returned "the first free port" would hand back 45000, not 45002.
        acquire_port(dir.path(), &s, "other-a", "preview", &env_at(T0)).unwrap();
        acquire_port(dir.path(), &s, "other-b", "preview", &env_at(T0)).unwrap();
        let first = acquire_port(dir.path(), &s, "mine", "preview", &env_at(T0)).unwrap();
        assert_eq!(first.port, 45002);
        release_port(dir.path(), 45000, "other-a");
        let again = acquire_port(dir.path(), &s, "mine", "preview", &env_at(T0 + 5_000)).unwrap();
        assert_eq!(again.port, 45002, "a re-ask must return the held port, not the now-free 45000");
        assert_eq!(again.heartbeat_at_ms, T0 + 5_000, "and it must beat the heartbeat forward");
        assert_eq!(list_leases(dir.path()).iter().filter(|l| l.agent_id == "mine").count(), 1);
    }

    /// A DIFFERENT `kind` is a different resource, so it gets its own port.
    #[test]
    fn one_agent_may_hold_two_ports_for_two_kinds() {
        let dir = tmp();
        let s = settings();
        let a = acquire_port(dir.path(), &s, "mine", "preview", &env_at(T0)).unwrap();
        let b = acquire_port(dir.path(), &s, "mine", "storybook", &env_at(T0)).unwrap();
        assert_ne!(a.port, b.port);
        assert_eq!(list_leases(dir.path()).len(), 2);
    }

    /// A LEASE HELD BY A LIVE PROCESS. The TTL has run out — but the port is still BOUND, so the
    /// holder is a live-but-quiet dev server and must never be stolen from. This is the case one
    /// condition alone gets wrong.
    #[test]
    fn an_expired_lease_whose_port_is_still_bound_is_never_reclaimed() {
        let dir = tmp();
        let s = settings();
        acquire_port(dir.path(), &s, "quiet-holder", "preview", &env_at(T0)).unwrap();
        assert_eq!(lease_on(dir.path(), 45000).unwrap().agent_id, "quiet-holder");

        // Long past the TTL, and 45000 is still bound; everything else is free.
        let bound_45000 = |p: u16| p == 45000;
        let env = Env { now_ms: T0 + 10 * 60_000, pid: 9, is_bound: &bound_45000 };
        let got = acquire_port(dir.path(), &s, "newcomer", "preview", &env).unwrap();

        assert_ne!(got.port, 45000, "a live-but-quiet holder must keep its port");
        assert_eq!(
            lease_on(dir.path(), 45000).unwrap().agent_id,
            "quiet-holder",
            "and its RECORD must still be standing — the side effect, not the return value"
        );
    }

    /// A LEASE WHOSE HOLDER IS GONE. Past the TTL *and* the port is unbound: both conditions, so
    /// the port comes back to the pool and the newcomer gets exactly it.
    #[test]
    fn an_expired_lease_whose_holder_is_gone_is_reclaimed() {
        let dir = tmp();
        let s = settings();
        acquire_port(dir.path(), &s, "dead-holder", "preview", &env_at(T0)).unwrap();
        let got = acquire_port(dir.path(), &s, "newcomer", "preview", &env_at(T0 + 10 * 60_000)).unwrap();
        assert_eq!(got.port, 45000, "the lowest port must come back to the pool");
        assert_eq!(lease_on(dir.path(), 45000).unwrap().agent_id, "newcomer");
        assert_eq!(list_leases(dir.path()).len(), 1, "the stale record must be REPLACED, not doubled");
    }

    /// A LEASE INSIDE ITS TTL is untouchable even when its port is wide open — a dev server that
    /// has not started listening yet is the ordinary shape of the first ten seconds of a preview.
    #[test]
    fn a_live_lease_is_never_reclaimed_however_free_its_port_looks() {
        let dir = tmp();
        let s = settings();
        acquire_port(dir.path(), &s, "starting-up", "preview", &env_at(T0)).unwrap();
        let got = acquire_port(dir.path(), &s, "newcomer", "preview", &env_at(T0 + 59_000)).unwrap();
        assert_ne!(got.port, 45000);
        assert_eq!(lease_on(dir.path(), 45000).unwrap().agent_id, "starting-up");
    }

    /// A BACKWARDS CLOCK MUST NEVER EXPIRE ANYTHING. `saturating_duration_since` answers 0 here,
    /// and 0 elapsed reads as "stamped a moment ago" — which silently EXTENDS every TTL. The
    /// checked form answers `None`, which this module reads as NOT STALE.
    #[test]
    fn a_clock_that_ran_backwards_expires_nothing() {
        // Forward, past the TTL: stale.
        assert!(is_stale(T0 + 61_000, T0, Duration::from_secs(60)));
        // Forward, inside the TTL: not stale.
        assert!(!is_stale(T0 + 59_000, T0, Duration::from_secs(60)));
        // BACKWARDS — the case the saturating form gets wrong.
        assert!(!is_stale(T0 - 10 * 60_000, T0, Duration::from_secs(60)));
        // …and the reclamation path inherits it: a record stamped in the FUTURE is not reclaimable.
        let dir = tmp();
        let s = settings();
        acquire_port(dir.path(), &s, "future-holder", "preview", &env_at(T0 + 60 * 60_000)).unwrap();
        let got = acquire_port(dir.path(), &s, "newcomer", "preview", &env_at(T0)).unwrap();
        assert_ne!(got.port, 45000, "a future-stamped lease must not be stolen");
        assert_eq!(lease_on(dir.path(), 45000).unwrap().agent_id, "future-holder");
    }

    /// EXACTLY ONE of two concurrent reclaimers may win the rename. Both would "succeed" under an
    /// overwrite-in-place implementation, which is two agents holding one port.
    #[test]
    fn exactly_one_of_two_reclaimers_wins_the_rename() {
        let dir = tmp();
        let path = dir.path().join("contended.json");
        fs::write(&path, b"{}").unwrap();
        let wins = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..6 {
            let path = path.clone();
            let wins = Arc::clone(&wins);
            handles.push(std::thread::spawn(move || {
                if claim_stale(&path) {
                    wins.fetch_add(1, Ordering::Relaxed);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(wins.load(Ordering::Relaxed), 1, "the rename must admit exactly one reclaimer");
        assert!(!path.exists(), "and the stale record must be gone");
    }

    /// A port everything else is on is never handed out, lease or no lease — a human's `pnpm dev`
    /// is invisible to this registry and is exactly as much of a collision.
    #[test]
    fn a_port_bound_by_a_stranger_is_never_leased() {
        let dir = tmp();
        let s = BrokerSettings { range_start: 45000, range_end: 45001, ..settings() };
        let bound_45000 = |p: u16| p == 45000;
        let env = Env { now_ms: T0, pid: 1, is_bound: &bound_45000 };
        let got = acquire_port(dir.path(), &s, "a", "preview", &env).unwrap();
        assert_eq!(got.port, 45001);
        assert!(lease_on(dir.path(), 45000).is_none(), "nothing may be written for a stranger's port");

        let env2 = Env { now_ms: T0, pid: 2, is_bound: &always_bound };
        let err = acquire_port(dir.path(), &s, "b", "preview", &env2).expect_err("nothing free");
        assert!(err.contains("bound by something outside the registry"), "{err}");
    }

    /// Sparkle's own dev port is never allocated, even when the configured range covers it.
    #[test]
    fn the_reserved_dev_port_is_skipped_even_inside_the_range() {
        let dir = tmp();
        let reserved = crate::preview::RESERVED_PORTS[0];
        let s = BrokerSettings { range_start: reserved, range_end: reserved + 1, ..settings() };
        let got = acquire_port(dir.path(), &s, "a", "preview", &env_at(T0)).unwrap();
        assert_eq!(got.port, reserved + 1);
        assert!(lease_on(dir.path(), reserved).is_none());
    }

    /// A REVERSED range is read as the range somebody meant, not as an empty one. An empty range
    /// reports "no port available", which is indistinguishable from a full one.
    #[test]
    fn a_reversed_range_still_allocates() {
        let dir = tmp();
        let s = BrokerSettings { range_start: 45004, range_end: 45000, ..settings() };
        assert_eq!(s.normalized_range(), (45000, 45004));
        assert_eq!(acquire_port(dir.path(), &s, "a", "preview", &env_at(T0)).unwrap().port, 45000);
    }

    /// A release may not touch somebody else's record. The assertion is that the RECORD SURVIVES.
    #[test]
    fn releasing_a_lease_you_do_not_hold_leaves_it_standing() {
        let dir = tmp();
        let s = settings();
        acquire_port(dir.path(), &s, "owner", "preview", &env_at(T0)).unwrap();
        let out = release_port(dir.path(), 45000, "impostor");
        assert_eq!(out.outcome, ReleaseState::HeldByOther);
        assert_eq!(out.holder.as_deref(), Some("owner"));
        assert_eq!(lease_on(dir.path(), 45000).unwrap().agent_id, "owner");

        let out = release_port(dir.path(), 45000, "owner");
        assert_eq!(out.outcome, ReleaseState::Released);
        assert!(lease_on(dir.path(), 45000).is_none());
        // Idempotent: a second release is `not-held`, not an error.
        assert_eq!(release_port(dir.path(), 45000, "owner").outcome, ReleaseState::NotHeld);
    }

    /// A renew is a heartbeat, not a transfer of ownership.
    #[test]
    fn renew_refuses_a_lease_that_is_not_yours_and_names_who_holds_it() {
        let dir = tmp();
        let s = settings();
        acquire_port(dir.path(), &s, "owner", "preview", &env_at(T0)).unwrap();
        let err = renew_port(dir.path(), 45000, "impostor", &env_at(T0 + 1_000)).expect_err("refused");
        assert!(err.contains("leased by agent owner"), "{err}");
        assert_eq!(
            lease_on(dir.path(), 45000).unwrap().heartbeat_at_ms,
            T0,
            "and the holder's heartbeat must be untouched"
        );
        let ok = renew_port(dir.path(), 45000, "owner", &env_at(T0 + 1_000)).unwrap();
        assert_eq!(ok.heartbeat_at_ms, T0 + 1_000);
        assert_eq!(lease_on(dir.path(), 45000).unwrap().heartbeat_at_ms, T0 + 1_000);
    }

    /// Renewing a lease that was already reclaimed is an ERROR, not a silent re-acquire. A holder
    /// that has lost its port must find out, or it goes on believing it owns one somebody else has.
    #[test]
    fn renewing_a_reclaimed_lease_says_so() {
        let dir = tmp();
        let err = renew_port(dir.path(), 45000, "ghost", &env_at(T0)).expect_err("gone");
        assert!(err.contains("no lease to renew"), "{err}");
    }

    /// AN UNREADABLE RECORD, BOTH DIRECTIONS — and the two are the whole point of the age rule.
    ///
    /// A record that names nobody protects nobody, which makes "just reclaim it" the tempting
    /// answer. It is wrong: `create_exclusive` creates the file and THEN writes it, so a valid
    /// lease is briefly an empty file, and an acquirer that reclaimed every unparseable record
    /// would race the winner and hand two agents one port. So a FRESH corpse is left alone and an
    /// OLD one is taken, and the test that only checked the second would have passed against the
    /// racing implementation.
    #[test]
    fn an_unreadable_lease_is_reclaimed_only_once_it_is_older_than_the_ttl() {
        let dir = tmp();
        let s = settings(); // lease_ttl_secs = 60
        fs::create_dir_all(leases_dir(dir.path())).unwrap();
        let corpse = leases_dir(dir.path()).join("45000.json");
        fs::write(&corpse, b"{ truncated").unwrap();

        // FRESH — it was written a moment ago, which is indistinguishable from a create in flight.
        let fresh = acquire_port(dir.path(), &s, "a", "preview", &env_at(T0)).unwrap();
        assert_ne!(fresh.port, 45000, "a just-written unreadable record must be left alone");
        let st = status(dir.path(), &s, &env_at(T0));
        assert_eq!(
            st.unreadable.iter().map(|u| u.port).collect::<Vec<_>>(),
            vec![45000],
            "and it must be REPORTED, or a port goes quietly missing from the range"
        );
        release_port(dir.path(), fresh.port, "a");

        // OLD — the SAME file, aged on the FILESYSTEM's clock rather than by moving `Env::now_ms`.
        // That is the clock `unreadable_is_reclaimable` reads, and mixing the two is the bug its
        // docblock records.
        age_file(&corpse, Duration::from_secs(2 * 60 * 60));
        let taken = acquire_port(dir.path(), &s, "b", "preview", &env_at(T0)).unwrap();
        assert_eq!(taken.port, 45000, "an aged unreadable record must not wedge its port forever");
        assert_eq!(lease_on(dir.path(), 45000).unwrap().agent_id, "b");
        assert!(status(dir.path(), &s, &env_at(T0)).unreadable.is_empty());
    }

    /// …and the age rule still yields to the bound check: an unreadable record on a port something
    /// is ACTUALLY listening on is never reclaimed, however old it is. Both conditions, always.
    #[test]
    fn an_aged_unreadable_lease_on_a_bound_port_is_still_left_alone() {
        let dir = tmp();
        let s = settings();
        fs::create_dir_all(leases_dir(dir.path())).unwrap();
        let corpse = leases_dir(dir.path()).join("45000.json");
        fs::write(&corpse, b"{ truncated").unwrap();
        age_file(&corpse, Duration::from_secs(2 * 60 * 60));
        let bound_45000 = |p: u16| p == 45000;
        let env = Env { now_ms: T0, pid: 1, is_bound: &bound_45000 };
        let got = acquire_port(dir.path(), &s, "a", "preview", &env).unwrap();
        assert_ne!(got.port, 45000);
        assert!(read_lease(&leases_dir(dir.path()).join("45000.json")).is_none());
        assert!(leases_dir(dir.path()).join("45000.json").exists(), "the record must survive");
    }

    // ── GATE LOCKS ──────────────────────────────────────────────────────────────────────────

    /// THE RACING CASE for the lock. Six threads, one name: exactly one holds it, and every acquirer
    /// that does not hold it is told WHO does — the sentence that answers "task ui errors on the
    /// port".
    ///
    /// **NOTHING IN A SPAWNED THREAD MAY `unwrap`, AND THAT IS THE POINT OF THIS DOCBLOCK.** The
    /// previous shape called `acquire_gate_lock(..).unwrap()` inside each racing thread, and it was
    /// intermittently red on `origin/main`'s own bytes. A panic in a spawned thread DESTROYS THE
    /// EVIDENCE: the thread dies, `join().unwrap()` re-raises an opaque `Any { .. }`, and the report
    /// names neither the error nor an assertion — so the failure reads as "the one-winner rule
    /// broke" when the one-winner rule was never reached. Every thread now hands its `Result` back
    /// and every judgement is made here, where a message can be printed.
    ///
    /// **A CONTENDED ACQUIRE MAY LEGITIMATELY ERROR, AND IT IS TOLERATED — NARROWLY.**
    /// `acquire_gate_lock` retries `GATE_ATTEMPTS` times and gives up when every attempt read a
    /// record that would not parse. That is a real window, not a defect: `create_exclusive` creates
    /// the file and THEN writes it, so the winner's record is briefly an empty file (the same window
    /// `unreadable_is_reclaimable` exists for on the lease side), and six threads on one name land
    /// in it. Giving up there is the honest answer — it acquired NOTHING, so it cannot double-hold
    /// the gate, and the message says to try again. So the tolerance is keyed to THAT sentence
    /// only: any other error — an unwritable registry, an unencodable record — still fails the test.
    ///
    /// What the test pins, whatever the interleaving, is HOLDERS: exactly one acquirer, the disk
    /// agreeing with it, and nobody who failed to acquire believing otherwise.
    #[test]
    fn six_agents_racing_one_gate_lock_leave_exactly_one_holder() {
        let dir = tmp();
        let root: PathBuf = dir.path().to_path_buf();
        let s = settings();
        let mut handles = Vec::new();
        for i in 0..6 {
            let root = root.clone();
            let s = s.clone();
            handles.push(std::thread::spawn(move || {
                let env = Env { now_ms: T0, pid: 200 + i as u32, is_bound: &never_bound };
                // NO `unwrap` HERE — see the docblock. The Result travels back intact.
                acquire_gate_lock(&root, &s, "browser", &format!("agent-{i}"), None, &env)
            }));
        }
        let outcomes: Vec<Result<GateLockOutcome, String>> = handles
            .into_iter()
            .enumerate()
            .map(|(i, h)| h.join().unwrap_or_else(|_| panic!("racing thread {i} panicked")))
            .collect();

        // Any error must be the CONTENTION give-up, which acquired nothing. Anything else is a real
        // fault and is reported with its own text rather than swallowed by the tolerance.
        for out in &outcomes {
            if let Err(e) = out {
                assert!(
                    e.contains("the record kept changing under us"),
                    "a racing acquire failed for a reason that is not contention: {e}"
                );
            }
        }

        let winners: Vec<&GateLockOutcome> =
            outcomes.iter().filter_map(|o| o.as_ref().ok()).filter(|o| o.acquired).collect();
        assert_eq!(
            winners.len(),
            1,
            "exactly one acquirer may hold the lock, got {:?}",
            outcomes
                .iter()
                .map(|o| match o {
                    Ok(g) => format!("{}={:?}", g.lock.agent_id, g.state),
                    Err(e) => format!("Err({e})"),
                })
                .collect::<Vec<_>>()
        );

        let holder = gate_lock_on(&root, "browser").expect("a record on disk");
        assert_eq!(holder.agent_id, winners[0].lock.agent_id, "the disk must agree with the winner");

        // Every non-holder either NAMES the holder, or errored above having taken nothing. Neither
        // may come back believing it holds the gate.
        for refused in outcomes.iter().filter_map(|o| o.as_ref().ok()).filter(|o| !o.acquired) {
            assert_eq!(refused.state, GateState::Refused);
            assert!(
                refused.message.contains(&holder.agent_id),
                "a refusal must NAME the holder, not just say busy: {}",
                refused.message
            );
            assert!(refused.message.contains(&holder.pid.to_string()), "{}", refused.message);
        }
    }

    /// A TORN RECORD IS RE-READ AFTER A WAIT, NOT SPUN ON.
    ///
    /// The defect this pins is not a wrong answer, it is a wrong SCHEDULE. `create_exclusive`
    /// creates the record and THEN writes it, so a winner's file is briefly zero bytes and
    /// `read_gate` answers `None` for a file that plainly exists. Four attempts issued back to back
    /// all land inside that window, and `acquire_gate_lock` gives up with an opaque "try again"
    /// instead of naming the holder — measured on this machine under load, FOUR of six racing
    /// threads got that instead of the one sentence a refused caller needs.
    ///
    /// So the assertion is the SIDE EFFECT of [`GATE_RETRY_BACKOFF`]: the call must have SPENT the
    /// backoff before giving up. A zero-byte record here never becomes readable, so the VERDICT is
    /// fixed and only the elapsed time is under test — delete the sleeps and this goes red, while no
    /// amount of machine load can red it spuriously, because a sleep only ever overshoots.
    #[test]
    fn a_torn_gate_record_is_re_read_after_a_backoff_rather_than_spun_on() {
        let dir = tmp();
        let s = settings();
        fs::create_dir_all(gates_dir(dir.path())).unwrap();
        // EXACTLY the state `create_exclusive` leaves for the microseconds between its `open` and
        // its `write_all`: the file exists and holds nothing.
        fs::write(gate_path(dir.path(), "browser"), b"").unwrap();

        let started = std::time::Instant::now();
        let out = acquire_gate_lock(dir.path(), &s, "browser", "waiter", None, &env_at(T0));
        let waited = started.elapsed();

        let err = out.expect_err("a record that never becomes readable cannot be acquired");
        assert!(err.contains("the record kept changing under us"), "{err}");

        // Every retry inside the loop, plus the one before the give-up read.
        let floor: Duration = (1..GATE_ATTEMPTS as u32).map(|n| GATE_RETRY_BACKOFF * n).sum::<Duration>()
            + GATE_RETRY_BACKOFF * GATE_ATTEMPTS as u32;
        assert!(
            waited >= floor,
            "the retry loop spun instead of waiting: {waited:?} < {floor:?} — a winner still mid-write \
             never gets to finish, and its rivals are told `try again` instead of who holds the lock"
        );
    }

    /// RE-ENTRANT for the same agent. A pinned-port preview takes this lock on every open, so a
    /// non-re-entrant lock would make an agent deadlock against its own previous run.
    #[test]
    fn the_same_agent_re_enters_its_own_gate_lock() {
        let dir = tmp();
        let s = settings();
        let first = acquire_gate_lock(dir.path(), &s, "browser", "mine", None, &env_at(T0)).unwrap();
        assert_eq!(first.state, GateState::Acquired);
        let again =
            acquire_gate_lock(dir.path(), &s, "browser", "mine", None, &env_at(T0 + 10_000)).unwrap();
        assert!(again.acquired);
        assert_eq!(again.state, GateState::Reentered);
        assert_eq!(
            gate_lock_on(dir.path(), "browser").unwrap().acquired_at_ms,
            T0 + 10_000,
            "re-entry must refresh the stamp so a long holder cannot expire under itself"
        );
        assert_eq!(list_gate_locks(dir.path()).len(), 1, "and must not create a second record");
    }

    /// A crashed holder self-releases on its TTL, and the reclaim SAYS whose it was.
    #[test]
    fn an_expired_gate_lock_is_reclaimed_and_names_the_agent_it_came_from() {
        let dir = tmp();
        let s = settings(); // `browser` ttl = 30s
        acquire_gate_lock(dir.path(), &s, "browser", "crashed", None, &env_at(T0)).unwrap();
        let refused =
            acquire_gate_lock(dir.path(), &s, "browser", "next", None, &env_at(T0 + 29_000)).unwrap();
        assert!(!refused.acquired, "inside the TTL it is still theirs");

        let taken =
            acquire_gate_lock(dir.path(), &s, "browser", "next", None, &env_at(T0 + 31_000)).unwrap();
        assert!(taken.acquired);
        assert_eq!(taken.state, GateState::Reclaimed);
        assert_eq!(taken.reclaimed_from.as_deref(), Some("crashed"));
        assert_eq!(gate_lock_on(dir.path(), "browser").unwrap().agent_id, "next");
    }

    /// EXPIRY IS JUDGED BY THE HOLDER'S OWN TTL, off their record — not by the reader's config.
    /// Otherwise the agent with the shortest configured TTL steals from everybody.
    #[test]
    fn a_peer_with_a_shorter_configured_ttl_cannot_steal_early() {
        let dir = tmp();
        let generous = BrokerSettings {
            gate_locks: vec![GateLockSpec { name: "browser".into(), ttl_secs: 600 }],
            ..settings()
        };
        acquire_gate_lock(dir.path(), &generous, "browser", "holder", None, &env_at(T0)).unwrap();

        let impatient = BrokerSettings {
            gate_locks: vec![GateLockSpec { name: "browser".into(), ttl_secs: 5 }],
            ..settings()
        };
        let out =
            acquire_gate_lock(dir.path(), &impatient, "browser", "thief", None, &env_at(T0 + 60_000))
                .unwrap();
        assert!(!out.acquired, "the holder took it for 600s; a reader's 5s config may not shorten that");
        assert_eq!(gate_lock_on(dir.path(), "browser").unwrap().agent_id, "holder");
    }

    /// An unlisted name still locks. Requiring a config entry would make the config a gate on the
    /// gate — the resource would be unprotected precisely when nobody thought to declare it.
    #[test]
    fn an_unconfigured_lock_name_still_serializes_on_the_default_ttl() {
        let dir = tmp();
        let s = settings();
        assert_eq!(s.gate_ttl_for("nobody-declared-me").as_secs(), DEFAULT_GATE_TTL_SECS);
        acquire_gate_lock(dir.path(), &s, "nobody-declared-me", "a", None, &env_at(T0)).unwrap();
        let out =
            acquire_gate_lock(dir.path(), &s, "nobody-declared-me", "b", None, &env_at(T0 + 60_000))
                .unwrap();
        assert!(!out.acquired);
    }

    /// The release rules mirror the lease's: idempotent, and never somebody else's.
    #[test]
    fn releasing_a_gate_lock_you_do_not_hold_leaves_it_standing() {
        let dir = tmp();
        let s = settings();
        acquire_gate_lock(dir.path(), &s, "browser", "owner", None, &env_at(T0)).unwrap();
        let out = release_gate_lock(dir.path(), "browser", "impostor");
        assert_eq!(out.outcome, ReleaseState::HeldByOther);
        assert_eq!(out.holder.as_deref(), Some("owner"));
        assert_eq!(gate_lock_on(dir.path(), "browser").unwrap().agent_id, "owner");

        assert_eq!(release_gate_lock(dir.path(), "browser", "owner").outcome, ReleaseState::Released);
        assert!(gate_lock_on(dir.path(), "browser").is_none());
        assert_eq!(release_gate_lock(dir.path(), "browser", "owner").outcome, ReleaseState::NotHeld);
    }

    /// `name` crosses the IPC boundary, so it is untrusted input to a path join. The record must
    /// land INSIDE the registry, and the raw name must survive on the record.
    #[test]
    fn a_traversing_lock_name_cannot_escape_the_registry() {
        let dir = tmp();
        let s = settings();
        let evil = "../../../../etc/sparkle-pwned";
        acquire_gate_lock(dir.path(), &s, evil, "a", None, &env_at(T0)).unwrap();
        let written = gate_path(dir.path(), evil);
        assert!(written.starts_with(gates_dir(dir.path())), "escaped to {}", written.display());
        assert!(written.exists());
        assert_eq!(
            list_gate_locks(dir.path())[0].name,
            evil,
            "the filename is lossy; the RECORD must carry what was asked for"
        );
    }

    // ── THE PREVIEW SEAM ────────────────────────────────────────────────────────────────────

    /// THE WIRING, in both directions. Enabled: a lease appears in the registry, naming this agent.
    /// Disabled: a port still comes back and the registry is UNTOUCHED — a feature that is off must
    /// leave no trace, or "off" is not a state anyone can verify.
    #[test]
    fn the_preview_port_path_consults_the_broker_only_when_it_is_enabled() {
        let on = tmp();
        let s = settings();
        let hold = choose_preview_port_with(on.path(), &s, "agent-1", None, &env_at(T0)).unwrap();
        assert_eq!(hold.port, 45000);
        assert!(hold.leased);
        assert_eq!(
            lease_on(on.path(), 45000).map(|l| l.agent_id),
            Some("agent-1".to_string()),
            "an enabled broker must LEASE the port it hands out"
        );
        assert_eq!(lease_on(on.path(), 45000).unwrap().kind, PREVIEW_KIND);

        let off = tmp();
        let disabled = BrokerSettings { enabled: false, ..settings() };
        let hold = choose_preview_port_with(off.path(), &disabled, "agent-1", None, &env_at(T0)).unwrap();
        assert!(hold.port > 1024, "the un-brokered path still allocates an ephemeral port");
        assert!(!crate::preview::is_reserved_port(hold.port));
        assert!(!hold.holds_anything(), "a disabled broker holds nothing to release");
        assert!(list_leases(off.path()).is_empty(), "and writes NOTHING to the registry");
        assert!(list_gate_locks(off.path()).is_empty());
        assert!(!leases_dir(off.path()).exists(), "not even the directory");
    }

    /// A PINNED PORT TAKES A LOCK, NOT A LEASE — there is no second port to hand out. The second
    /// agent is refused, and the refusal names the first.
    #[test]
    fn a_pinned_preview_port_is_gate_locked_and_the_refusal_names_the_holder() {
        let dir = tmp();
        let s = settings();
        let first = choose_preview_port_with(dir.path(), &s, "agent-1", Some(5173), &env_at(T0)).unwrap();
        assert_eq!(first.port, 5173);
        assert!(!first.leased, "a pinned port is not leased — it cannot be reassigned");
        assert_eq!(first.gate.as_deref(), Some("port-5173"));
        assert!(list_leases(dir.path()).is_empty(), "and no lease may be written for it");
        assert_eq!(gate_lock_on(dir.path(), "port-5173").unwrap().agent_id, "agent-1");

        let err = choose_preview_port_with(dir.path(), &s, "agent-2", Some(5173), &env_at(T0 + 1_000))
            .expect_err("the second agent must be refused");
        assert!(err.contains("pins port 5173"), "{err}");
        assert!(err.contains("agent-1"), "the failure path must say WHICH agent holds it: {err}");
        assert_eq!(
            gate_lock_on(dir.path(), "port-5173").unwrap().agent_id,
            "agent-1",
            "and the holder's record must be untouched"
        );

        // The SAME agent re-opening its own preview is not blocked by its own lock.
        let again =
            choose_preview_port_with(dir.path(), &s, "agent-1", Some(5173), &env_at(T0 + 2_000)).unwrap();
        assert_eq!(again.port, 5173);
    }

    /// A hold is given back in full, whichever kind it is — and giving back twice is safe, because
    /// a teardown path that has to be called exactly once is a teardown path that leaks.
    #[test]
    fn releasing_a_preview_hold_gives_back_both_kinds_and_is_idempotent() {
        let dir = tmp();
        let s = settings();
        let leased = choose_preview_port_with(dir.path(), &s, "a", None, &env_at(T0)).unwrap();
        let gated = choose_preview_port_with(dir.path(), &s, "a", Some(5173), &env_at(T0)).unwrap();
        release_preview_hold(&leased);
        release_preview_hold(&gated);
        assert!(list_leases(dir.path()).is_empty());
        assert!(list_gate_locks(dir.path()).is_empty());
        release_preview_hold(&leased);
        release_preview_hold(&gated);
        assert!(list_leases(dir.path()).is_empty());

        // And a hold from the disabled path releases nothing at all — no root, no agent, no writes.
        release_preview_hold(&PreviewPortHold::unheld(51234));
    }

    // ── STATUS ──────────────────────────────────────────────────────────────────────────────

    /// `expired` and `bound` are DIFFERENT columns, and the difference is the whole reclamation
    /// rule: expired-and-bound is a live holder, expired-and-unbound is a corpse.
    #[test]
    fn status_reports_expiry_and_boundness_separately() {
        let dir = tmp();
        let s = settings();
        let bound_45000 = |p: u16| p == 45000;
        acquire_port(dir.path(), &s, "quiet", "preview", &env_at(T0)).unwrap();
        // The second acquire runs with 45000 BOUND, or `quiet`'s ten-minute-stale lease would be
        // reclaimed out from under it and there would be nothing to report as expired-and-bound.
        let ten_min = Env { now_ms: T0 + 10 * 60_000, pid: 1, is_bound: &bound_45000 };
        acquire_port(dir.path(), &s, "fresh", "preview", &ten_min).unwrap();
        acquire_gate_lock(dir.path(), &s, "browser", "gatekeeper", None, &env_at(T0)).unwrap();

        let env = Env { now_ms: T0 + 10 * 60_000, pid: 1, is_bound: &bound_45000 };
        let st = status(dir.path(), &s, &env);
        assert_eq!(st.range_start, 45000);
        assert_eq!(st.leases.len(), 2);
        let quiet = st.leases.iter().find(|l| l.lease.agent_id == "quiet").unwrap();
        assert!(quiet.expired && quiet.bound, "a live-but-quiet holder is expired AND bound");
        let fresh = st.leases.iter().find(|l| l.lease.agent_id == "fresh").unwrap();
        assert!(!fresh.expired && !fresh.bound);
        assert_eq!(st.gate_locks.len(), 1);
        assert!(st.gate_locks[0].expired, "a 30s lock is expired ten minutes later");
    }

    /// The registry is resolved through `--git-common-dir`, so every worktree of one repo shares it.
    /// A per-worktree path would give each agent a private view in which it is permanently alone —
    /// which is the bug, spelled as a directory layout.
    #[test]
    fn every_worktree_of_one_repo_resolves_the_same_registry() {
        let dir = tmp();
        let main = dir.path().join("main");
        fs::create_dir_all(&main).unwrap();
        let git = |args: &[&str]| {
            Command::new("git").arg("-C").arg(&main).args(args).output().expect("git")
        };
        if !git(&["init", "-q"]).status.success() {
            return; // no git on this machine; nothing to assert
        }
        let _ = git(&["config", "user.email", "t@example.com"]);
        let _ = git(&["config", "user.name", "t"]);
        fs::write(main.join("f"), b"x").unwrap();
        let _ = git(&["add", "-A"]);
        if !git(&["commit", "-qm", "init"]).status.success() {
            return;
        }
        let linked = dir.path().join("wt");
        if !git(&["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "side"]).status.success() {
            return;
        }
        assert_eq!(
            registry_root(&main),
            registry_root(&linked),
            "a linked worktree must resolve the MAIN checkout's registry, not its own admin dir"
        );
    }
}

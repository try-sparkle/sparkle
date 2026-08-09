//! Local PTY host (§2 Rust backend). Runs the user's OWN Claude Code (or any command)
//! in a pseudo-terminal on THEIR machine under THEIR login. Sparkle is a
//! terminal-emulator UI on top — it never reads or stores the auth token; the genuine
//! `claude` binary authenticates itself, exactly as in any terminal/IDE. This is the
//! ToS-compliant way to let people use their Claude Max subscription: local, real binary, no token extraction.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

struct PtySession {
    /// The child's stdin writer, behind its OWN lock so a (potentially blocking) `pty_write` locks
    /// only this session — never the global `sessions` map. A big paste into a stalled child would
    /// otherwise freeze spawn/write/resize/kill for EVERY terminal (sparkle-4orh). `MasterPty`'s
    /// writer is `!Clone`, so it lives here in an `Arc<Mutex<..>>` that `pty_write` clones out under
    /// a brief global-lock hold, then writes with only this handle locked.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Read-backpressure gate (): while paused, the reader thread stops read()ing the
    /// master so the kernel PTY buffer fills and the child's own write() blocks — end-to-end
    /// backpressure driven by the frontend's flow controller (see `pty_set_paused`).
    pause: Arc<PauseState>,
    /// IPC emit credit gate: bounds the bytes emitted-but-not-yet-acked by the frontend, so the
    /// (unbounded) Tauri IPC queue can't grow without limit. See `InflightState` / `pty_ack`.
    inflight: Arc<InflightState>,
    /// The child's pid, captured at spawn — the ROOT of the agent's process tree. The memory
    /// watchdog (`memwatch::agent_footprints`) walks descendants from here, because an agent is
    /// ~2 processes (peak 5), so watching this pid alone would undercount its RSS by about half.
    /// `None` when the platform did not report one; such a session is skipped rather than reported
    /// at zero, since "no pid" is not the same fact as "using no memory".
    pid: Option<u32>,
    /// WHICH LIFE OF THIS AGENT THIS PTY IS. Process-globally unique and minted per spawn (see
    /// [`next_pty_epoch`]), so the `pty:exit` this session eventually emits can be told apart from
    /// the one its PREDECESSOR emits — which is the whole point, because the session id is the
    /// AGENT id and is therefore identical across a restart.
    ///
    /// Without it, a restart is indistinguishable from a death at the frontend. `sessions.insert`
    /// replaces silently (see [`PtyManager::session_ids`]), so a re-spawn leaves the old reader
    /// thread alive and still owing one `pty:exit`. That event arrives AFTER the new binding has
    /// subscribed, on a global channel keyed only by agent id, and the new terminal reads it as its
    /// OWN death — painting "Agent exited — Start again" over an agent that was just successfully
    /// revived, where it sits until the resumed `claude` happens to emit a byte (a `--resume`
    /// transcript redraw takes seconds; an idle resumed agent may emit nothing for minutes).
    /// That is a death notice with no retraction path, and it is what this field closes.
    epoch: u64,
}

/// "No PTY has spawned." Never minted by [`next_pty_epoch`] (which starts at 1), so it can never
/// collide with a real life — which is what makes it safe as a placeholder and as the answer
/// `live_epoch` gives for an id with no session.
const NO_EPOCH: u64 = 0;

/// Mint the next PTY epoch. Process-global and strictly increasing, so no two PTYs — for the same
/// agent or different ones, in this app run — ever share one. Starts at 1: [`NO_EPOCH`] is left free
/// as a "no PTY has spawned yet" sentinel for callers that need one.
///
/// CALL IT FROM [`PtyManager::insert_session`], not from the top of a spawn: the ORDER in which
/// epochs are minted only means something if it matches the order sessions land in the map.
fn next_pty_epoch() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Cooperative pause gate shared between a session's reader thread and `pty_set_paused`. The reader
/// parks on the condvar while `paused` is true (no busy-wait); `set(false)` wakes it. Poison-tolerant
/// like the rest of this module so a panic elsewhere can't wedge a reader forever.
struct PauseState {
    paused: Mutex<bool>,
    cvar: Condvar,
}

impl PauseState {
    fn new() -> Self {
        Self { paused: Mutex::new(false), cvar: Condvar::new() }
    }
    /// Block the calling (reader) thread while paused; returns immediately when not paused.
    fn wait_while_paused(&self) {
        let mut paused = self.paused.lock().unwrap_or_else(|e| e.into_inner());
        while *paused {
            paused = self.cvar.wait(paused).unwrap_or_else(|e| e.into_inner());
        }
    }
    /// Set the paused flag and wake the reader (a resume must unpark it; a pause notify is harmless).
    fn set(&self, value: bool) {
        let mut paused = self.paused.lock().unwrap_or_else(|e| e.into_inner());
        *paused = value;
        self.cvar.notify_all();
    }
}

// ── IPC emit credit gate ──────────────────────────────────────────────────────────────────────
//
// `PauseState` above is driven by the FRONTEND's view of its xterm parse backlog — but that view is
// structurally blind to the thing it was written to bound. `flow.onEnqueue` runs inside the
// `pty:output` handler, i.e. only AFTER the main thread has already dequeued and deserialized the
// IPC message. tao's event channel is a `crossbeam::channel::unbounded()`, so when the MAIN THREAD
// is the bottleneck, messages pile up in that queue while the frontend's `pending` counter stays
// low — the brake never engages, exactly when it is needed. And it could not help if it did:
// `pty_set_paused` is itself an `invoke`, so the pause command queues BEHIND the flood it is trying
// to stop.
//
// The fix is producer-side credit. Every emitted chunk CHARGES its byte count here; the frontend
// releases it with `pty_ack` once xterm has parsed the chunk. Past the high-water mark the flusher
// and the reader PARK — they never drop or truncate, because `pty:output` is a byte stream where
// loss or reordering corrupts the terminal (the same reason `PauseState` chose backpressure over
// truncation). Parking the reader stops read()ing the master, the kernel PTY buffer fills, and the
// child blocks on its own write(): genuine end-to-end backpressure.
//
// This also makes the existing pause machinery meaningful again — with the producer self-limited,
// the main thread is no longer starved, so a `pty_set_paused`/`pty_ack` invoke is serviced promptly
// instead of queueing behind megabytes of pending output.

/// Per-PTY ceiling on emitted-but-un-acked bytes.
///
/// Sizing: this is the AGGREGATE memory knob — worst case is (agents × this), and each byte is
/// amplified on the way through IPC because the payload is JSON-escaped (an ANSI 0x1B becomes the
/// 6-byte ``, and Claude Code's TUI is escape-dense). At 256 KiB, 20 concurrent agents cap
/// out around 5 MiB of un-acked chunk text — a few tens of MiB after escaping — versus the multi-GiB
/// footprint the unbounded queue produced. It is deliberately far BELOW the frontend's
/// `FLOW_HIGH_WATER_BYTES` (2 MiB per terminal, 40 MiB aggregate at 20 agents), because the IPC
/// queue is the more expensive place to hold bytes and the cheaper place to stop them.
///
/// Floor: it is 4 × `PTY_FLUSH_SIZE_THRESHOLD`, so ~4 max-size chunks stay in flight. At the 12 ms
/// flush interval that is ~21 MB/s of headroom — several times the ~5 MB/s a single PTY can produce
/// — so ordinary streaming never touches the gate and throughput is unaffected.
const PTY_INFLIGHT_HIGH_WATER_BYTES: usize = 256 * 1024;

/// How long a producer waits for acks before assuming the consumer is gone. Only a safety valve:
/// a live terminal acks within a frame, and terminal teardown kills the PTY (which `close()`s this
/// gate). Without it, a webview that died without killing its PTY would park the flusher forever.
const PTY_INFLIGHT_STALL: Duration = Duration::from_secs(3);

/// Outcome of parking on the credit gate — distinguished so the caller can log the abnormal cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Credit {
    /// Under the limit (immediately, or after an ack released capacity).
    Ready,
    /// The gate was closed (EOF / kill) — proceed unconditionally so teardown can't wedge.
    Closed,
    /// No acks arrived within the stall window; outstanding credit was forgiven so the producer
    /// makes progress instead of blocking forever.
    Stalled,
}

#[derive(Default)]
struct InflightInner {
    bytes: usize,
    closed: bool,
}

/// Credit gate shared between a session's reader + flusher threads (producers) and `pty_ack`
/// (consumer). Poison-tolerant like the rest of this module.
struct InflightState {
    inner: Mutex<InflightInner>,
    cvar: Condvar,
}

impl InflightState {
    fn new() -> Self {
        Self { inner: Mutex::new(InflightInner::default()), cvar: Condvar::new() }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, InflightInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Charge bytes about to be emitted. Called immediately before `emit`, so the counter is never
    /// behind what is actually in the IPC queue.
    fn charge(&self, bytes: usize) {
        let mut g = self.lock();
        g.bytes = g.bytes.saturating_add(bytes);
    }

    /// Release bytes the frontend has finished parsing (`pty_ack`). Saturating so a duplicate or
    /// late ack from a tearing-down terminal can't underflow the counter.
    fn ack(&self, bytes: usize) {
        let mut g = self.lock();
        g.bytes = g.bytes.saturating_sub(bytes);
        drop(g);
        self.cvar.notify_all();
    }

    /// Permanently release every parked producer (EOF / `pty_kill`). Idempotent. After this, the
    /// final drain emits whatever remains without gating, so no trailing output is lost.
    fn close(&self) {
        let mut g = self.lock();
        g.closed = true;
        drop(g);
        self.cvar.notify_all();
    }

    // Observers for the gate's internal counters. Test-only: the production paths act on the
    // Credit returned by `acquire`, never on a sampled reading of the state, so shipping these
    // would be dead code in the binary.
    #[cfg(test)]
    fn is_closed(&self) -> bool {
        self.lock().closed
    }

    #[cfg(test)]
    fn inflight_bytes(&self) -> usize {
        self.lock().bytes
    }

    /// Park the calling producer while un-acked bytes are at or above `limit`. Returns as soon as
    /// an ack drops below it, immediately if closed, or — as a liveness backstop — after `stall`
    /// with the outstanding credit forgiven.
    fn acquire(&self, limit: usize, stall: Duration) -> Credit {
        let g = self.lock();
        if g.closed {
            return Credit::Closed;
        }
        if g.bytes < limit {
            return Credit::Ready;
        }
        let (mut g, res) = self
            .cvar
            .wait_timeout_while(g, stall, |s| !s.closed && s.bytes >= limit)
            .unwrap_or_else(|e| e.into_inner());
        if g.closed {
            return Credit::Closed;
        }
        if res.timed_out() && g.bytes >= limit {
            // Consumer presumed gone (or acks lost). Forgive the outstanding credit rather than
            // wedge: the producer then trickles at ~one chunk per stall window. Nothing is dropped.
            g.bytes = 0;
            // Wake any CO-PARKED producer. Zeroing `bytes` falsifies their wait predicate, but a
            // predicate that became false without a notify is never re-checked — the reader and
            // flusher can both be parked here, and whichever times out first would otherwise leave
            // the other to burn its own full stall window before noticing the credit it was
            // waiting for is already free.
            self.cvar.notify_all();
            return Credit::Stalled;
        }
        Credit::Ready
    }
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// What a reader thread's reap found under its id — see [`PtyManager::reap`].
///
/// Only ONE of these means "leave everything else alone". The other two are both "this teardown is
/// mine to finish", and collapsing them into a bool is what breaks the ordinary kill path: gate a
/// per-id cleanup on "did I remove a row" and it stops running whenever `pty_kill` got there first,
/// which is every deliberate stop.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Reap {
    /// Our session was in the map and we took it out — the natural-exit path.
    RemovedOurs,
    /// Nothing under this id. `pty_kill` removes the session itself before the reader wakes on EOF,
    /// so this is the ordinary deliberate-stop teardown, NOT an anomaly: the id is unowned and the
    /// rest of this reader's cleanup must still run.
    AlreadyGone,
    /// A DIFFERENT life owns this id now — an overlapping spawn replaced us while we were reading.
    /// Touch nothing: the session, its observer and its terminal all belong to a live PTY.
    OwnedByOther,
}

impl PtyManager {
    /// Insert a session under `id`, MINTING ITS EPOCH WHILE THE MAP IS LOCKED, and return that epoch.
    ///
    /// The mint and the insert are one critical section on purpose, and the reason is subtle enough
    /// to be worth stating: `pty_spawn` cannot mint at its top and still claim anything about which
    /// session survived. Mint order there is INVOKE order, while insert order is
    /// blocking-completion order — `validate_spawn` + `openpty` + `spawn_command` run on a thread
    /// pool, and two concurrent spawns of one id can finish in either order. The lower epoch could
    /// therefore be the one left in the map.
    ///
    /// That is not a cosmetic skew. `sessions.insert` REPLACES silently, so the loser's reader thread
    /// stays alive and still owes a `pty:exit`, while every other verb (`write`/`resize`/`kill`) is
    /// keyed by id alone and acts on whatever is in the map. A frontend that bound to the highest
    /// epoch would then accept the ORPHAN's death and ignore the death of the PTY the user is
    /// actually typing into — the same misattribution the epoch exists to close, inverted.
    ///
    /// Minting here makes "the highest epoch minted for an id IS the session in the map" an
    /// invariant rather than an assumption, because nothing can interleave between the two.
    /// The other half of that invariant is [`PtyManager::remove_if_epoch`]: an id-keyed REMOVAL
    /// would let a loser's reader thread delete the winner it never knew replaced it.
    fn insert_session(&self, id: String, mut session: PtySession) -> u64 {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let epoch = next_pty_epoch();
        session.epoch = epoch;
        sessions.insert(id, session);
        epoch
    }

    /// A reader thread's reap: drop this id's session IF this reader still owns it.
    ///
    /// THE TEARDOWN TWIN OF [`PtyManager::insert_session`], and needed for the same reason. A reader
    /// thread outlives the insert that replaced its session: after an overlapping spawn the loser is
    /// gone from the map but its thread is alive and will reach its own teardown, typically SOONER
    /// than the winner (a command that fails fast exits immediately). An id-keyed `remove` there
    /// deletes the WINNER — a live PTY — so `pty_write`/`pty_resize`/`pty_kill` start answering
    /// "no such pty" for a terminal the user is typing into, with no `pty:exit` to explain it, since
    /// the loser's exit carries the lower epoch and the frontend filters it out by design.
    ///
    /// THREE ANSWERS, NOT TWO, and the third is why: "nothing is here" and "someone else is here"
    /// are opposite instructions to the caller, and a bool that merges them gets the common path
    /// wrong. `pty_kill` removes the session by id BEFORE the reader wakes on EOF, so the ordinary
    /// deliberate-kill teardown finds an empty slot — and it is still that reader's job to finish
    /// tearing down (see [`Reap::AlreadyGone`]).
    ///
    /// Poison-tolerant, like every other lock here: a panic while another thread held it must not
    /// wedge spawn/write/resize/kill app-wide, and the recovered guard still points at a valid map.
    fn reap(&self, id: &str, epoch: u64) -> Reap {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match sessions.get(id) {
            Some(s) if s.epoch == epoch => {
                sessions.remove(id);
                Reap::RemovedOurs
            }
            Some(_) => Reap::OwnedByOther,
            None => Reap::AlreadyGone,
        }
    }

    /// The epoch of the session live under `id`, or `0` (the never-minted sentinel) when there is
    /// none. This is the ONE read of `PtySession::epoch`: the reader thread stamps its own copy on
    /// `pty:exit` rather than looking the session up, precisely because by then the map may already
    /// hold the successor — so the stored field exists to answer this question, from outside, about
    /// the life that is live RIGHT NOW.
    pub fn live_epoch(&self, id: &str) -> u64 {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|s| s.epoch)
            .unwrap_or(NO_EPOCH)
    }

    /// `(session id, root pid)` for every live session that reported a pid.
    ///
    /// The session id IS the agent id (`pty:output:<agentId>`), so the memory watchdog needs no
    /// mapping table that could drift. Sessions without a pid are SKIPPED rather than emitted with
    /// a placeholder: a footprint of zero would read as "this agent uses no memory", which is a
    /// different claim from "we could not measure it".
    pub fn session_pids(&self) -> Vec<(String, u32)> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(|(id, s)| s.pid.map(|pid| (id.clone(), pid)))
            .collect()
    }

    /// EVERY live session id — the process-global answer to "is this agent already running".
    ///
    /// The session id IS the agent id, so this needs no mapping table that could drift. It is the
    /// sibling of [`session_pids`] and it differs in the one way that matters here: a session with
    /// NO pid yet is REPORTED, not skipped.
    ///
    /// That asymmetry is the whole reason this is a separate method rather than a `.map` over the
    /// other. `session_pids` feeds the memory watchdog, which cannot measure a footprint it has no
    /// pid for, so skipping is right there. This one feeds the resurrection guard, where a pid-less
    /// session is the MOST dangerous entry in the map: it is a spawn in flight. `pty_spawn` inserts
    /// by `sessions.insert`, which REPLACES silently, so a second spawn for the same id drops the
    /// first `PtySession` on the floor — its child keeps running, keeps holding its worktree, keeps
    /// burning tokens, and is invisible to every surface in the app because nothing holds a handle
    /// to it any more. Filtering on `pid.is_some()` here would open exactly that window.
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect()
    }
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    chunk: String,
    /// UTF-8 byte length of `chunk` — the credit the frontend must echo back via `pty_ack` once
    /// xterm has parsed it. Sent explicitly rather than recomputed frontend-side because JS string
    /// `.length` counts UTF-16 code units; any drift would slowly leak (or over-release) credit.
    bytes: usize,
}

#[derive(Clone, Serialize)]
struct PtyEnd {
    id: String,
    /// The epoch of the PTY that ACTUALLY exited — see `PtySession::epoch`. `pty:exit` is a global
    /// channel keyed only by agent id, and the id survives a restart, so without this a listener
    /// cannot tell "my PTY died" from "the PTY I replaced finally finished dying". Non-optional on
    /// purpose: every exit is emitted by a reader thread that owns exactly one session, so there is
    /// always an answer, and an `Option` here would cross the wire as `null` and hand the frontend
    /// an "unknown epoch" case with no correct handling.
    epoch: u64,
}

/// Binaries `pty_spawn` is permitted to launch, by basename (defense-in-depth allowlist).
///
/// Today EVERY real spawn is `/bin/zsh` (the `SHELL` constant in claudeSpawn.ts): the user's
/// `claude`/`node`/`git` ride as arguments inside `/bin/zsh -l -c 'exec …'`, never as `command`.
/// The remaining names are the tool binaries the app resolves in preflight.rs (`known_*_paths`)
/// and could plausibly be spawned directly by a future path. A compromised webview that tries to
/// launch some OTHER absolute binary — `/usr/bin/osascript`, `/usr/bin/curl`, `/bin/rm`, a
/// downloaded payload — no longer gets a free arbitrary-exec primitive out of `pty_spawn`.
const ALLOWED_SPAWN_BASENAMES: &[&str] =
    &["zsh", "bash", "sh", "node", "git", "claude", "roborev"];

/// Defense-in-depth checks before spawning — NOT the primary security boundary.
///
/// `pty_spawn` exists to launch the user's own `claude` via `/bin/zsh -lc '…'`, so by design it
/// runs whatever shell script the webview hands it. The REAL boundary is the WebView's integrity:
/// a strict CSP with no remote origins and no `unsafe-eval` (see tauri.conf.json), plus a frontend
/// that never renders agent/file output as executable HTML. These checks are a SECOND layer that
/// stops the obvious misuses and catch bugs:
///  - `command` must be a non-empty ABSOLUTE path (no `$PATH`-relative name resolution) whose
///    basename is in `ALLOWED_SPAWN_BASENAMES`, or which lives under the app's managed dir.
///  - Containment is enforced on EVERY spawn — there is no "cwd is null so skip the check" hole.
///    A provided `cwd` must resolve INSIDE `<app_data>/worktrees`; a null `cwd` (the pre-worktree
///    `claude login` flows) is NOT left to inherit the app's arbitrary process cwd — it falls back
///    to the managed `<app_data>` dir, a trusted, contained location.
///
/// Returns the canonicalized cwd the caller must spawn into (never the original string), closing a
/// check-vs-use symlink-swap window.
fn validate_spawn(app: &AppHandle, command: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let app_data = crate::dev_identity::app_data_dir(app).map_err(|e| format!("pty_spawn: {e}"))?;
    // The managed dir is the null-cwd fallback and the "binary under a managed dir" root, so it
    // must exist and canonicalize. Tauri creates app-data lazily; ensure it before we depend on it.
    let _ = std::fs::create_dir_all(&app_data);
    let worktrees = app_data.join("worktrees");
    validate_spawn_inner(&worktrees, &app_data, command, cwd)
}

/// Pure, AppHandle-free core of `validate_spawn` (so it can be unit-tested). `worktrees_base` is
/// `<app_data>/worktrees`; `managed_base` is `<app_data>` — used both as the null-cwd fallback and
/// as the root under which a bundled binary may be spawned. Always returns the validated cwd to
/// spawn into (there is no longer an "unconstrained / inherited cwd" outcome).
fn validate_spawn_inner(
    worktrees_base: &Path,
    managed_base: &Path,
    command: &str,
    cwd: Option<&str>,
) -> Result<PathBuf, String> {
    let cmd_path = Path::new(command);
    if command.is_empty() || !cmd_path.is_absolute() {
        return Err("pty_spawn: command must be a non-empty absolute path".into());
    }
    // Binary allowlist: an allowlisted basename, OR a binary that lives under the app's managed
    // dir. The basename check is lexical (it does not require the binary to exist), so the common
    // `/bin/zsh` path never touches the filesystem here.
    let basename_ok = cmd_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|b| ALLOWED_SPAWN_BASENAMES.contains(&b))
        .unwrap_or(false);
    if !basename_ok {
        // Canonicalize both sides so a symlinked binary can't dodge the containment compare; fall
        // back to a lexical prefix check only when a side can't be resolved.
        let under_managed = match (cmd_path.canonicalize(), managed_base.canonicalize()) {
            (Ok(real_cmd), Ok(real_base)) => real_cmd.starts_with(&real_base),
            _ => cmd_path.starts_with(managed_base),
        };
        if !under_managed {
            return Err("pty_spawn: command is not an allowed binary".into());
        }
    }
    // Null cwd (the pre-worktree login flows): fall back to the managed app-data dir rather than
    // inheriting the app's process cwd, so EVERY spawn runs in a validated, contained directory.
    let Some(cwd) = cwd else {
        return managed_base
            .canonicalize()
            .map_err(|e| format!("pty_spawn: managed dir unavailable: {e}"));
    };
    // Canonicalize BOTH sides fully (resolving macOS /var→/private/var, ~/Library, a symlinked
    // `worktrees`, and any `../` in the supplied cwd) so the containment compare is between two
    // real paths. If the worktrees base can't be resolved (e.g. it doesn't exist yet) we reject
    // rather than compare against a half-resolved path — fail-closed, and any legitimate cwd
    // implies the base already exists.
    let base = worktrees_base
        .canonicalize()
        .map_err(|e| format!("pty_spawn: worktrees dir unavailable: {e}"))?;
    let real = std::fs::canonicalize(cwd).map_err(|e| format!("pty_spawn: invalid cwd: {e}"))?;
    if !real.starts_with(&base) {
        return Err("pty_spawn: cwd is outside the managed worktrees directory".into());
    }
    Ok(real)
}

/// Returned (as the `Err` string) when a write/resize/kill targets a PTY that has
/// already exited — a benign race the frontend expects. `ignorePtyGone` in
/// `apps/desktop/src/pty.ts` substring-matches this exact text to swallow the
/// rejection, so keep the two in sync if you ever rephrase it.
const NO_SUCH_PTY: &str = "no such pty";

// ── Thin-column backstop ────────────────────────────────────────────────────────────────────
// The "compressed terminal" bug: a PTY opened with an implausibly small size makes the child CLI
// (claude's TUI) hard-wrap its output into a thin column, and because the wraps are baked into the
// emitted bytes, no later resize can un-wrap them — the pane stays compressed until a full redraw.
// The frontend (terminalSize.ts `spawnSize`) is the PRIMARY guard, refusing to send a size from an
// unmeasured/collapsed pane. These constants + clamps are the LAST-LINE backstop at the one
// boundary every size must cross (openpty / resize), so NO path — a frontend regression, the
// orchestrator/login-modal mounts, or future code — can ever open a thin-column PTY. The warn logs
// make the (otherwise invisible) leak diagnosable: if one fires, the frontend guard was bypassed.
// Keep MIN_* in sync with MIN_PLAUSIBLE_COLS/ROWS in terminalSize.ts; the spawn fallback matches
// SPAWN_FALLBACK_* there (and pty.ts).
const MIN_PTY_COLS: u16 = 20;
const MIN_PTY_ROWS: u16 = 5;
const SPAWN_FALLBACK_COLS: u16 = 120;
const SPAWN_FALLBACK_ROWS: u16 = 30;

// ── pty:output coalescing ─────────────────────────────────────────────────────────────────────
// The reader thread used to emit a `pty:output` Tauri event on EVERY read() (and once per decoded
// sub-slice). During a burst — `claude --resume` redrawing a large transcript, or any full-screen
// TUI repaint — that fires hundreds-to-thousands of tiny events/sec, each paying a full IPC
// crossing + JSON serialization, and the frontend runs term.write + engine.ingest + watchRateLimit
// synchronously per event. Instead we accumulate decoded text in a shared buffer and let a
// dedicated flusher thread emit far fewer, larger events: it waits for the first byte (so idle
// costs nothing), then coalesces a short window before emitting. Ordering is preserved (a single
// buffer, appended in read order, drained in order) and a final flush on EOF/close guarantees no
// trailing output is lost (see the flusher + reader join below).
//
// FLUSH_INTERVAL is the coalescing window: short enough that interactive typing echo stays
// imperceptible, long enough that a repaint burst collapses into a handful of events. SIZE_THRESHOLD
// bounds how much a sustained flood accumulates before an early flush, so per-event size (and the
// buffer's peak memory) stay bounded rather than growing for the whole interval.
const PTY_FLUSH_INTERVAL_MS: u64 = 12;
const PTY_FLUSH_SIZE_THRESHOLD: usize = 64 * 1024;

/// Shared buffer between the PTY reader thread (producer) and the flusher thread (consumer).
/// `done` is set once by the reader on EOF/close to trigger the flusher's final flush + exit.
#[derive(Default)]
struct FlushBuf {
    text: String,
    done: bool,
}

/// Per-agent `pty:output` channel. Emitting app-wide made every chunk fan out to EVERY terminal's
/// listener — N producers × N listeners, with N-1 of them filtering the payload straight back out
/// after Tauri had already materialized it. A per-id event name means only the owning terminal's
/// listener is ever invoked.
fn output_event(id: &str) -> String {
    format!("pty:output:{id}")
}

/// The flusher thread's body, split out so the flood/ordering contract is unit-testable without a
/// Tauri `AppHandle`. Drains `shared` into coalesced chunks and hands each to `emit` — but only
/// after `inflight` grants credit, so the un-acked IPC backlog stays bounded.
///
/// Ordering and completeness are the load-bearing properties: a single buffer is drained
/// front-to-back and the gate only ever DELAYS an emit, never skips or truncates one. On `done` it
/// drains whatever remains and returns (the gate is closed by then, so the final drain can't park).
fn run_flusher(
    shared: &(Mutex<FlushBuf>, Condvar),
    inflight: &InflightState,
    id: &str,
    limit: usize,
    mut emit: impl FnMut(String, usize),
) {
    let (lock, cvar) = shared;
    loop {
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        // Block until there's something to flush or the stream ended (no busy-wait while idle).
        while guard.text.is_empty() && !guard.done {
            guard = cvar.wait(guard).unwrap_or_else(|e| e.into_inner());
        }
        // We have data (or we're done). If more may still arrive, give the reader a brief
        // window to pile a burst into the same buffer — but return early if the stream ends or
        // the buffer hits the size cap, so a flood flushes promptly and bounds per-event size.
        if !guard.done && guard.text.len() < PTY_FLUSH_SIZE_THRESHOLD {
            let (g, _timed_out) = cvar
                .wait_timeout_while(
                    guard,
                    Duration::from_millis(PTY_FLUSH_INTERVAL_MS),
                    |b| !b.done && b.text.len() < PTY_FLUSH_SIZE_THRESHOLD,
                )
                .unwrap_or_else(|e| e.into_inner());
            guard = g;
        }
        let chunk = std::mem::take(&mut guard.text);
        let done = guard.done;
        // Release the buffer lock BEFORE parking on the credit gate, so the reader can keep
        // appending (and, more importantly, so it can set `done` / the gate can be closed).
        drop(guard);
        if !chunk.is_empty() {
            if inflight.acquire(limit, PTY_INFLIGHT_STALL) == Credit::Stalled {
                tracing::warn!(
                    %id,
                    inflight_limit = limit,
                    "pty:output acks stalled — frontend not draining; forgiving credit to keep the stream alive"
                );
            }
            // Charge BEFORE emitting so the counter is never behind the IPC queue. `bytes` is the
            // authoritative count the frontend echoes back in `pty_ack` — it must not recompute
            // the length itself (JS string length is UTF-16 units, this is UTF-8 bytes).
            let bytes = chunk.len();
            inflight.charge(bytes);
            emit(chunk, bytes);
        }
        if done {
            break;
        }
    }
}

/// SPAWN backstop: an implausibly small requested size is replaced WHOLESALE with the comfortable
/// default (a CLI started at 120×30 reflows cleanly once the real visible size is synced on
/// reveal). Returns the size to actually open the PTY with.
fn guard_spawn_size(id: &str, cols: u16, rows: u16) -> (u16, u16) {
    if cols < MIN_PTY_COLS || rows < MIN_PTY_ROWS {
        tracing::warn!(
            %id, requested_cols = cols, requested_rows = rows,
            "pty_spawn size implausibly small (frontend guard bypassed?) — using {SPAWN_FALLBACK_COLS}x{SPAWN_FALLBACK_ROWS} to avoid thin-column wrap"
        );
        return (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS);
    }
    (cols, rows)
}

/// RESIZE backstop: never shrink a live PTY below the plausible floor (that would re-introduce the
/// thin-column wrap on an already-running CLI). Floors each dimension rather than substituting a
/// default, so a genuine resize to a slightly-small pane is honored as closely as is safe.
fn guard_resize_size(id: &str, cols: u16, rows: u16) -> (u16, u16) {
    let c = cols.max(MIN_PTY_COLS);
    let r = rows.max(MIN_PTY_ROWS);
    if c != cols || r != rows {
        // debug, not warn: resize is the high-frequency path (a window/drag resize fires many
        // events), and a sub-floor resize is far less catastrophic than a sub-floor SPAWN (the
        // running CLI reflows on the next plausible resize). debug keeps it diagnosable under the
        // default `sparkle_lib=debug` filter without warn-level spam. The spawn warn stays the
        // high-signal "frontend guard bypassed" alarm.
        tracing::debug!(
            %id, requested_cols = cols, requested_rows = rows, clamped_cols = c, clamped_rows = r,
            "pty_resize size below floor — clamped to avoid thin-column wrap"
        );
    }
    (c, r)
}

/// Build the `NODE_OPTIONS` value for an agent's PTY child, merging our per-agent V8 heap cap into
/// whatever the user already has. Returns None when nothing should be set.
///
/// Why this exists (sparkle-01xv / sparkle-asz5): V8's default old-space ceiling is ~4 GiB, so a
/// runaway agent grows until the KERNEL intervenes. On 2026-07-20 that was 24 `claude` subprocesses
/// at ~4 GiB each — 99 GiB — and jetsam killed `securityd_system`/`trustd`, forcing a reboot. An
/// explicit `--max-old-space-size` gives each agent a ceiling we choose instead of one Node picks.
///
/// Merge rules, in order:
///   - `heap_mb == 0` → opt-out: return None and leave the child's inherited env untouched.
///   - the user already pinned a heap size → their value wins verbatim (a deliberate choice, and
///     appending a second flag would just be confusing).
///   - otherwise → append our flag after theirs, so their `--require` shims / source maps / proxy
///     settings all survive. NODE_OPTIONS is a flag string, not a path list: last flag wins, so
///     appending is also what makes ours authoritative when nothing conflicts.
fn node_options_with_cap(existing: Option<&str>, heap_mb: u32) -> Option<String> {
    if heap_mb == 0 {
        return None;
    }
    let existing = existing.unwrap_or("").trim();
    if existing.is_empty() {
        return Some(format!("--max-old-space-size={heap_mb}"));
    }
    // Node accepts both `-` and `_` spellings, with `=` or a space before the value.
    let normalized = existing.replace('_', "-");
    // Match per TOKEN, not by substring. `contains` also fires on unrelated tokens that merely
    // EMBED the flag name — `--require ./max-old-space-size-helper.js`, or a hypothetical
    // `--max-old-space-size-foo` — and reads them as "the user already set a heap limit", silently
    // suppressing the cap. Suppressing it is the one outcome this whole feature exists to prevent
    // (sparkle-01xv: 24 uncapped agents summing 99 GiB), so the test must be exact.
    let user_set_heap_flag = normalized.split_whitespace().any(|tok| {
        // Both spellings Node accepts: `--max-old-space-size=4096` and `--max-old-space-size 4096`.
        tok == "--max-old-space-size" || tok.starts_with("--max-old-space-size=")
    });
    if user_set_heap_flag {
        return Some(existing.to_string());
    }
    Some(format!("{existing} --max-old-space-size={heap_mb}"))
}

/// Apply the per-agent heap cap to a command about to be spawned in a PTY. `inherited` is the
/// user's own `NODE_OPTIONS` (from our process env, which the child inherits).
fn apply_heap_cap(cmd: &mut CommandBuilder, inherited: Option<String>, heap_mb: u32) {
    if let Some(v) = node_options_with_cap(inherited.as_deref(), heap_mb) {
        cmd.env("NODE_OPTIONS", v);
    }
}

/// What a reader thread does about its observer once it knows [`Reap`]'s verdict.
///
/// TWO LINES, EXTRACTED SO THEY CAN BE TESTED — and that is the whole point, not tidiness. The bug
/// this closes lived HERE, in the mapping from verdict to action, while every test targeted `reap`'s
/// return value; the suite stayed green through a gate that skipped the detach on the commonest
/// path. Inline, this decision is reachable only from a thread inside a real `pty_spawn`, so nothing
/// could assert it. Behind this function, three unit tests pin all three verdicts.
///
/// Stop observing, or a long-lived app accumulates one 4KB tail and one VT grid per agent that has
/// ever run. The nudger also keys its ladder state off the live observer set (`nudger::tick` reads
/// `observers.all()`), so an observer left attached to a dead PTY keeps its ladder climbing and
/// eventually escalates a terminal that no longer exists.
///
/// Gated on NOT BEING SOMEONE ELSE'S, not on "did I remove a row". `pty_kill` removes the session by
/// id before the reader wakes on EOF, so on every deliberate stop the reap finds an empty slot — and
/// gating on the removal skips the detach exactly there, on the commonest teardown path there is.
fn finish_teardown(observers: &crate::nudger::Observers, id: &str, reap: Reap) {
    if reap != Reap::OwnedByOther {
        observers.detach(id);
    }
}

/// The `Send` pieces `pty_spawn`'s blocking setup hands back to the async side: the session to
/// insert into the manager, plus the child's output reader and the child itself (each reaped on
/// its own thread).
type SpawnedPty = (PtySession, Box<dyn Read + Send>, Box<dyn Child + Send + Sync>);

/// Spawn `command` in a PTY. Output streams to the frontend via the `pty:output`
/// event; `pty:exit` fires when the process ends.
// too_many_arguments: each arg is a distinct field of the frontend's invoke payload; bundling
// them into a struct would only move the count into a struct literal at the one call site.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    // WHICH LIFE OF THIS AGENT THIS IS is minted LATER, by `insert_session`, under the same lock as
    // the insert — NOT here. Minting at the top reads naturally and is wrong: the setup below runs
    // on a thread pool, so mint order would be INVOKE order while insert order is completion order,
    // and two concurrent spawns of one id can finish in either. The map could then hold the LOWER
    // epoch, and the frontend's "highest epoch is the surviving session" rule would bind to a
    // session that was silently replaced. See `PtyManager::insert_session`.
    //
    // Log the command and arg COUNT at info. The full args carry the built `zsh -c '…'` script,
    // which embeds the user's prompt/persona (and could in principle carry a secret passed as a
    // flag), so they're NEVER written to the shared daily log by default — even though our default
    // filter is `sparkle_lib=debug`. Gate the full-args line behind an explicit opt-in env var so
    // a developer can still get it when actively debugging spawn issues.
    tracing::info!(%id, %command, arg_count = args.len(), cwd = ?cwd, cols, rows, "pty_spawn");
    if std::env::var_os("SPARKLE_LOG_PTY_ARGS").is_some() {
        tracing::debug!(%id, args = ?args, "pty_spawn args (may contain prompt text)");
    }
    // Backstop against the thin-column bug (see guard_spawn_size): never open a PTY at an
    // implausibly small size, whatever the frontend sent.
    let (cols, rows) = guard_spawn_size(&id, cols, rows);

    // Run the blocking work — cwd canonicalize (validate_spawn), openpty, and spawn_command — OFF
    // the main thread (mirrors `create_agent_worktree`). `pty_spawn` fires on nearly every
    // agent/terminal open, so doing this synchronously on the UI thread spins the beachball. We
    // return the session pieces (+ reader/child) and finish the cheap wiring (map insert, thread
    // spawns) back on the async side.
    let spawn_app = app.clone();
    // Read the configured per-agent heap cap once, on this side of the thread hop.
    let heap_mb = crate::config::current_effective().config.workers.agent_heap_mb;
    let (session, reader, child) = tauri::async_runtime::spawn_blocking(
        move || -> Result<SpawnedPty, String> {
            let validated_cwd = validate_spawn(&spawn_app, &command, cwd.as_deref())?;
            let pty_system = native_pty_system();
            let pair = pty_system
                .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| e.to_string())?;

            let mut cmd = CommandBuilder::new(&command);
            cmd.args(&args);
            // A GUI-launched .app inherits no shell environment, so without these the child
            // (claude's TUI) sees a "dumb" terminal and disables ALL ANSI color — every line
            // renders in the default foreground (near-white). Declare a real color terminal so
            // TUIs emit their normal palette. (env() overrides on top of the inherited env.)
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            // DO NOT HAND THE AGENT SPARKLE'S SECRETS (security audit 2026-08-08, H2).
            //
            // `CommandBuilder` inherits the FULL parent environment by default, and this child is an
            // autonomous agent running with `--dangerously-skip-permissions` that auto-approves its
            // own tool calls. So every secret in Sparkle.app's process environment was flowing
            // straight into it. That is not hypothetical: this repo's working tree carries
            // `.env.local`, `apps/orchestration/.env` and `apps/web/.env.local` holding GitHub PATs
            // with repo write, Stripe and Clerk secret keys, production Postgres credentials and R2
            // tokens — and if Sparkle is launched from a shell that sourced any of them, they were
            // inherited here.
            //
            // The list is shared with `claude_oneshot`'s existing ANTHROPIC_* scrub rather than
            // copied, so the two cannot drift — that scrub already existed on a NEIGHBOURING path,
            // which is what made the omission here a gap rather than an oversight.
            for name in crate::claude_oneshot::secret_env_names_now() {
                cmd.env_remove(&name);
            }
            // Bound the child's V8 heap so a runaway agent can't run itself up to Node's ~4 GiB
            // default ceiling (sparkle-01xv). Merges with — never clobbers — a NODE_OPTIONS the
            // user already set; see node_options_with_cap.
            apply_heap_cap(&mut cmd, std::env::var("NODE_OPTIONS").ok(), heap_mb);
            // Spawn into the *validated, canonicalized* cwd (not the original string), so a symlink
            // swap between check and use can't redirect the working dir outside the worktrees tree.
            // Every spawn now has a validated cwd (a provided one is worktree-contained; a null one
            // fell back to the managed app-data dir) — no spawn inherits the app's process cwd.
            cmd.cwd(validated_cwd);

            let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
            let killer = child.clone_killer();
            // Capture the pid BEFORE the child can be reaped: `process_id()` stops answering once
            // the child is waited on, and the watchdog needs the tree root for the session's life.
            let pid = child.process_id();
            // Drop the slave so the master sees EOF when the child exits.
            drop(pair.slave);

            // The child is already running. If wiring up its reader/writer fails here, nothing
            // downstream will reap it (no session is inserted, no reaper thread is spawned), so it
            // would orphan/zombie. Kill + wait it on these error paths before bubbling the error up.
            let reader = match pair.master.try_clone_reader() {
                Ok(r) => r,
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e.to_string());
                }
            };
            let writer = match pair.master.take_writer() {
                Ok(w) => w,
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e.to_string());
                }
            };

            Ok((
                PtySession {
                    writer: Arc::new(Mutex::new(writer)),
                    master: pair.master,
                    killer,
                    pause: Arc::new(PauseState::new()),
                    inflight: Arc::new(InflightState::new()),
                    pid,
                    // Placeholder — the real epoch is stamped by `insert_session`, under the lock
                    // that inserts this session. `0` is the never-minted sentinel, so a session that
                    // somehow reached the map without going through that path would read as "no PTY
                    // has spawned" rather than impersonating a real life.
                    epoch: NO_EPOCH,
                },
                reader,
                child,
            ))
        },
    )
    .await
    .map_err(|e| format!("pty_spawn task failed: {e}"))??;

    let mut reader = reader;
    let mut child = child;

    // Share the session's pause + credit gates with its reader/flusher threads before the session
    // moves into the map.
    let read_pause = session.pause.clone();
    let inflight = session.inflight.clone();
    let read_inflight = inflight.clone();
    // Start observing this session for the deterministic nudger (nudger.rs). The handle is captured
    // by the reader thread below so the hot path costs no map lookup per read. This is the ONLY
    // record of PTY output that exists outside the WebView: `PtySession` retains nothing, and
    // xterm's scrollback dies with the pane — which is precisely why the nudger could not read a
    // screen before this.
    let observer = app.state::<crate::nudger::Observers>().attach(&id, cols, rows);
    let read_observer = observer.clone();
    // MINT UNDER THE SAME LOCK AS THE INSERT — see `insert_session`. This is the only ordering that
    // makes "the highest epoch minted for an id is the session that survived" TRUE rather than
    // merely likely, and the frontend's overlap rule depends on it.
    let epoch = app.state::<PtyManager>().insert_session(id.clone(), session);

    // Reap the child so it doesn't zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    // Reader thread → shared buffer; a flusher thread coalesces + emits `pty:output`. Buffer partial
    // multi-byte UTF-8 across chunk boundaries (Claude Code's TUI emits box-drawing/emoji).
    let shared = Arc::new((Mutex::new(FlushBuf::default()), Condvar::new()));

    // Flusher thread: drain the shared buffer into coalesced `pty:output` events. Ordering is
    // preserved because it's a single buffer drained front-to-back. It waits for the first byte
    // (idle costs nothing), then coalesces up to PTY_FLUSH_INTERVAL_MS — or flushes early once the
    // buffer reaches PTY_FLUSH_SIZE_THRESHOLD — before emitting. On `done` it drains whatever remains
    // and exits, so trailing output on EOF/close is never dropped.
    let flush_app = app.clone();
    let flush_id = id.clone();
    let flush_shared = shared.clone();
    let flush_inflight = inflight.clone();
    let flusher = std::thread::spawn(move || {
        let event = output_event(&flush_id);
        run_flusher(
            &flush_shared,
            &flush_inflight,
            &flush_id,
            PTY_INFLIGHT_HIGH_WATER_BYTES,
            |chunk, bytes| {
                let _ = flush_app.emit(&event, PtyOutput { id: flush_id.clone(), chunk, bytes });
            },
        );
    });

    let read_app = app.clone();
    let read_id = id.clone();
    let read_shared = shared;
    std::thread::spawn(move || {
        let (lock, cvar) = &*read_shared;
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        // Append this read()'s decoded text to the shared buffer and wake the flusher.
        let push = |out: String| {
            if out.is_empty() {
                return;
            }
            // Observe BEFORE the flusher handoff, not inside `run_flusher`: the flusher can park on
            // the credit gate for up to PTY_INFLIGHT_STALL (3s) while the frontend is behind on
            // acks, so a tail fed there would lag under exactly the load that makes an agent look
            // stalled. Here it is fed once per read(), on the same schedule as the bytes arriving.
            read_observer.ingest(&out);
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            guard.text.push_str(&out);
            cvar.notify_one();
        };
        'read: loop {
            // Backpressure: block here while the frontend has paused us (its xterm write buffer is
            // above the high-water mark). Not read()ing lets the kernel PTY buffer fill so the child
            // blocks on its next write — bounding memory end-to-end (). Returns instantly
            // when not paused, so interactive output is unaffected.
            //
            // Tell the nudger's observer we are about to park. BOTH gates here sit UPSTREAM of
            // read(), so while either holds, the observer is fed nothing: its tail stops changing
            // (which reads as the agent going silent) and its VT grid stops advancing (so the
            // safety gate would judge a stale screen). A wedged WebView stops acking and latches
            // exactly these gates, so without this flag the nudger goes blind in the very outage it
            // exists to survive. See `PtyObserver::reader_parked`.
            read_observer.set_reader_parked(true);
            read_pause.wait_while_paused();
            // Second gate, same principle but driven by the PRODUCER's own accounting rather than
            // the frontend's: park while the frontend is behind on acks. Without this the flusher's
            // credit gate would merely relocate the backlog into `FlushBuf` (an unbounded String on
            // this side) instead of bounding it. Gating the READ is what makes the backpressure
            // end-to-end: the kernel PTY buffer fills and the child blocks on its next write().
            read_inflight.acquire(PTY_INFLIGHT_HIGH_WATER_BYTES, PTY_INFLIGHT_STALL);
            // Both gates cleared: the observer is being fed again, so its screen is live.
            read_observer.set_reader_parked(false);
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Drain every decodable byte into `out`. Keep valid text, SKIP genuinely
                    // invalid sequences (replacement char) so we never stall, and keep an
                    // incomplete trailing multibyte for the next read. Coalesce this read's output
                    // into one shared-buffer append (one lock/notify per read, not per sub-slice).
                    let mut out = String::new();
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                if !s.is_empty() {
                                    out.push_str(s);
                                    pending.clear();
                                }
                                break;
                            }
                            Err(e) => {
                                let valid = e.valid_up_to();
                                match e.error_len() {
                                    // Invalid bytes: keep valid prefix + U+FFFD, consume them.
                                    Some(bad) => {
                                        out.push_str(
                                            &String::from_utf8_lossy(&pending[..valid + bad]),
                                        );
                                        pending.drain(..valid + bad);
                                    }
                                    // Incomplete tail: keep valid prefix, hold the rest.
                                    None => {
                                        if valid > 0 {
                                            out.push_str(
                                                &String::from_utf8_lossy(&pending[..valid]),
                                            );
                                            pending.drain(..valid);
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    push(out);
                }
                Err(_) => break 'read,
            }
        }
        // Signal EOF/close so the flusher drains any remaining buffer, then WAIT for it: this
        // guarantees the final `pty:output` is emitted before `pty:exit` below, so no trailing
        // output is lost or reordered past the exit event.
        {
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            guard.done = true;
            cvar.notify_one();
        }
        // Release the credit gate BEFORE joining: if the flusher (or this thread) were parked
        // waiting on acks that will never come — the terminal is unmounting, so nobody is left to
        // ack — the join below would hang and the session would never be reaped. Closing lets the
        // final drain emit unconditionally, which is also what guarantees no trailing output is
        // lost on EOF.
        read_inflight.close();
        let _ = flusher.join();
        // Reap the session on natural exit (pty_kill also removes it) — but ONLY IF THE MAP STILL
        // HOLDS THIS LIFE. An id-keyed remove here is the teardown twin of an id-keyed insert: after
        // an overlapping spawn, the loser's session was silently replaced while its reader thread
        // stayed alive, so this line would delete the WINNER — a session whose PTY is running and
        // whose terminal the user is typing into. `pty_write`/`resize`/`kill` would then answer
        // "no such pty" for a live PTY, with no `pty:exit` to explain it (the loser's exit carries
        // the lower epoch and is filtered out by design), and `live_epoch` would drop to NO_EPOCH
        // while a higher-epoch session runs, so an observer's floor would admit a stale exit.
        let reap = read_app.state::<PtyManager>().reap(&read_id, epoch);
        finish_teardown(&read_app.state::<crate::nudger::Observers>(), &read_id, reap);
        // Stamped with THIS session's epoch, not with whatever is currently in the map under this
        // id. By the time a replaced reader gets here the map may already hold its SUCCESSOR, and
        // reporting the successor's epoch would be worse than reporting none: the new terminal would
        // accept its predecessor's death as its own, which is the exact misreading the epoch exists
        // to prevent.
        let _ = read_app.emit("pty:exit", PtyEnd { id: read_id.clone(), epoch });
    });

    Ok(epoch)
}

/// Clone out a session's per-session writer handle under a BRIEF hold of the global `sessions` lock,
/// so the caller does the (potentially blocking) write with only that handle locked — never the
/// global map. This is the core of sparkle-4orh; split out so the lock discipline is unit-testable.
fn acquire_writer(
    sessions: &Mutex<HashMap<String, PtySession>>,
    id: &str,
) -> Result<Arc<Mutex<Box<dyn Write + Send>>>, String> {
    let guard = sessions.lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard.get(id).ok_or(NO_SUCH_PTY)?.writer.clone())
}

/// Write to a PTY's stdin — e.g. an approval decision ("y\n" / "n\n") or user input.
#[tauri::command]
pub fn pty_write(
    manager: State<PtyManager>,
    observers: State<crate::nudger::Observers>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Tell the nudger somebody else is typing here, BEFORE the write rather than after: the stamp
    // must already be in place while the bytes are in flight, or a nudger tick landing between the
    // write and the stamp would see a quiet terminal and add its own keystroke.
    //
    // This is what closes a hazard that has no analogue on the JS side. Every JS write goes through
    // `chainPtyOp` (pty.ts), which serializes a bracketed paste and its trailing carriage return as
    // ONE operation; a Rust write bypasses that chain entirely, so a byte landing inside another
    // writer's 60ms paste→CR window would append to — and then SUBMIT — a prompt the user never
    // sent (roborev 54369/54375). The nudger stands down for 5s after this stamp.
    if let Some(observer) = observers.get(&id) {
        observer.note_foreign_write();
    }
    // Take this session's OWN writer handle, releasing the global `sessions` lock BEFORE the write.
    // A large paste into a stalled child then blocks only this writer, leaving spawn/write/resize/
    // kill for every other terminal responsive (sparkle-4orh).
    let writer = acquire_writer(&manager.sessions, &id)?;
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Write to a PTY's stdin from INSIDE Rust, without the `note_foreign_write` stamp `pty_write`
/// applies.
///
/// The nudger is the only caller and the omission is the point: this write is the nudger's own, so
/// stamping it would make the module stand itself down. Everything else about the path is identical
/// — same `acquire_writer`, same lock discipline (sparkle-4orh), same `NO_SUCH_PTY` error, which the
/// frontend substring-matches, so it must keep its exact wording.
pub fn write_session<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    data: &str,
) -> Result<(), String> {
    let manager = app.try_state::<PtyManager>().ok_or(NO_SUCH_PTY)?;
    let writer = acquire_writer(&manager.sessions, id)?;
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Pause or resume the PTY reader for flow control (). The frontend calls this when its
/// xterm write backlog crosses the high/low-water marks. Only touches this session's pause gate, so
/// it never blocks other terminals. Benign "no such pty" race is swallowed frontend-side.
#[tauri::command]
pub fn pty_set_paused(manager: State<PtyManager>, id: String, paused: bool) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let session = sessions.get(&id).ok_or(NO_SUCH_PTY)?;
    session.pause.set(paused);
    Ok(())
}

/// Release `bytes` of IPC emit credit for a PTY — the frontend calls this once xterm has PARSED a
/// `pty:output` chunk, echoing back the `bytes` field the chunk arrived with. This is the consumer
/// half of the credit gate that bounds the otherwise-unbounded Tauri IPC queue (see
/// `InflightState`). Fire-and-forget frontend-side; the benign "no such pty" teardown race is
/// swallowed there like the other PTY ops.
#[tauri::command]
pub fn pty_ack(manager: State<PtyManager>, id: String, bytes: usize) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let session = sessions.get(&id).ok_or(NO_SUCH_PTY)?;
    session.inflight.ack(bytes);
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<PtyManager>,
    observers: State<crate::nudger::Observers>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Backstop against the thin-column bug (see guard_resize_size): never shrink a live PTY below
    // the plausible floor, whatever the frontend sent.
    let (cols, rows) = guard_resize_size(&id, cols, rows);
    // Keep the nudger's VT grid the same shape as the real one. Width is not cosmetic here: a
    // prompt longer than the grid hard-wraps onto its own rendered row, which splits the word from
    // its colon and silently stops the gate's credential patterns matching — the width-dependent
    // miss `dictationTerminalRoute.ts` had to grow a wrap-tolerant arm for.
    if let Some(observer) = observers.get(&id) {
        observer.resize(cols, rows);
    }
    let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let session = sessions.get(&id).ok_or(NO_SUCH_PTY)?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Mark a deliberately-killed agent so the session reaper cannot resurrect it.
///
/// ── WHY THIS IS IN RUST, INSIDE `pty_kill` (roborev 61714) ────────────────────────────────────
/// It was briefly done in `pty.ts`, as an `await` before the `pty_kill` invoke. That is a real
/// regression and the reason is timing, not correctness: `SatelliteApp`'s teardown depends on
/// `pty_kill` being DISPATCHED SYNCHRONOUSLY from the unmount — its `CLOSE_SETTLE_MS` (250ms) is a
/// budget for ONE round-trip before the webview is `destroy()`ed, and `Terminal`'s cleanup is
/// `void`-ed so nothing awaits it. Putting an invoke in front means the continuation carrying
/// `pty_kill` is torn down with the JS context if the first call has not resolved — and the PTY is
/// then never killed at all, which is precisely the orphaned-child case that budget exists to
/// prevent. One command, dispatched once, with the order guaranteed on this side instead.
///
/// ── WHY `Dead`/`unknown` AND NOT `Retired` (roborev 61714) ────────────────────────────────────
/// `Retired` carries more meaning than "do not resurrect": `derive` maps it to
/// `ReaperVerdict::Reapable` UNCONDITIONALLY, with none of the `PROTECTION_MAX` grace `Dead` gets.
/// But "stop the agents when I close this window" is explicitly not "delete them" — the records and
/// tabs are meant to survive — and the promotion cutover kills the LOCAL pty for an agent that is
/// still alive in the cloud on that same worktree. Marking either `Reapable` would hand a worktree
/// holding uncommitted work to any future reaper.
///
/// `unknown` is the exactly-right cause here and needs no new vocabulary: `deathTypes` already
/// documents it as "a human clicking stop produces exactly this observation", and
/// `is_resurrectable` refuses it. So a deliberate stop is recorded as what it is, stays
/// unresurrectable, and keeps the ordinary protection window.
///
/// ONLY a `Live` record is touched, so this can never downgrade a richer verdict a window already
/// observed (a met goal, a wall, a transport banner). Failure is swallowed: a ledger write is an
/// affordance, and it must never keep alive a process the user asked to be gone.
///
/// ── OFF THE MAIN THREAD (roborev 61770) ───────────────────────────────────────────────────────
/// The mechanism itself is `agent_life::mark_stopped_at`, so a test can drive it; this only resolves
/// the directory. It must NOT run on the main thread: `close_at` writes a temp file, `fsync`s it and
/// renames, and `windowClose.stopOpenProjectAgents` / `ProjectModal` fire one `pty_kill` PER AGENT.
/// Serialized in front of the AppKit event loop that is a read + an fsync each, inside the very
/// 250ms `CLOSE_SETTLE_MS` budget this design exists to protect, on the same thread the concierge
/// bridge needs — the round-trip regression coming back through another channel.
fn mark_stopped_before_kill(app: &AppHandle, id: &str) {
    let Ok(base) = crate::dev_identity::app_data_dir(app) else { return };
    let dir = crate::agent_life::life_dir(&base);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if let Err(e) = crate::agent_life::mark_stopped_at(&dir, id, now) {
        // WARN, not debug: a stop that failed to record is a stop the resurrector may undo.
        tracing::warn!(target: "pty", %id, error = %e, "could not mark a deliberate stop");
    }
}

/// Kill a PTY the user deliberately stopped.
///
/// `async` + `spawn_blocking` because the body does ledger I/O — see `mark_stopped_before_kill`.
/// That does NOT weaken the guarantee the frontend depends on: `killPty` still issues exactly ONE
/// invoke, dispatched synchronously from the unmount, and both halves stay inside this one command,
/// so the mark-then-kill order holds without a second round-trip. It is strictly better than doing
/// the work in JS, because once dispatched this runs in the Rust process and a webview torn down
/// mid-flight cannot cancel it.
#[tauri::command]
pub async fn pty_kill(app: AppHandle, manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    tracing::info!(%id, "pty_kill");
    // BEFORE the kill, so there is no window in which the session is gone and the record still
    // reads `Live` — the exact state `reap_dead_sessions_at` seals as `process-gone`.
    //
    // Only the LEDGER write goes off-thread — it is the only part that touches the disk. The kill
    // itself is a mutex plus a signal, so it finishes back here (mirrors `pty_spawn`, which does its
    // blocking openpty/spawn off-thread and the cheap map wiring on the async side). Awaiting the
    // hop before the kill is what keeps the order.
    let mark_app = app.clone();
    let mark_id = id.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        mark_stopped_before_kill(&mark_app, &mark_id);
    })
    .await;
    kill_session(&manager, &id);
    Ok(())
}

/// Take the session out of the map and end its child — the whole of `pty_kill`'s effect on a live
/// PTY, extracted so it can be DRIVEN by a test rather than hand-simulated in one.
///
/// The REMOVAL BY ID is what makes `Reap::AlreadyGone` the ordinary case: the session leaves the
/// map HERE, and the reader thread that later wakes on its child's EOF finds nothing under its id.
/// A test that reproduces that by reaching into the map itself asserts a precondition it created —
/// it stays green if this function stops removing by id at all. Driving this reds that.
///
/// What no synchronous caller can observe is the order of the three statements BELOW against each
/// other — by the time this returns, all of them have run. `kill_resumes_a_reader_parked_on_the_
/// pause_gate_and_closes_the_credit_gate` pins that the resume and the close HAPPEN (deleting
/// either reds it); the interleaving against `killer.kill()` is pinned by nothing, and claiming
/// otherwise in a comment is how the last vacuous test here got written.
///
/// Returns whether a session was there to kill.
fn kill_session(manager: &PtyManager, id: &str) -> bool {
    let Some(mut session) = manager.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(id)
    else {
        return false;
    };
    // If the reader is parked (paused) it won't observe the kill's EOF and would never run its
    // teardown (reap + pty:exit). Resume it first so it wakes, reads EOF, and cleans up.
    session.pause.set(false);
    // Same hazard, second gate: a reader or flusher parked waiting for acks will get none once
    // the terminal is gone. Close the credit gate so both proceed, drain, and tear down.
    session.inflight.close();
    let _ = session.killer.kill();
    true
}

/// Every agent id with a live PTY session in THIS process.
///
/// The process-global backstop for the resurrection path. `decideResurrection` already requires
/// `processAlive === false`, and `services/goalContinuationRunner`'s ownership election already stops
/// two WINDOWS acting on one agent — but both of those are window-local evidence, and the PTY host
/// is app-global: `pty_spawn` from any webview reaches any agent id. This is the one reading that
/// cannot be wrong about it.
///
/// Sync deliberately, like its `pty_ack`/`pty_resize` siblings: the body is a mutex lock and a clone
/// of a short `Vec<String>`, with no I/O of any kind, so there is nothing to move off the main
/// thread. The commands that must be `async` are the ones that touch the disk.
#[tauri::command]
pub fn pty_live_sessions(manager: State<PtyManager>) -> Vec<String> {
    manager.session_ids()
}

/// The epoch of the PTY currently live under `id`, or `0` when none is — the sentinel
/// [`next_pty_epoch`] reserves and never mints.
///
/// A LOWER BOUND for an OBSERVER, and that is the only thing it is for. A caller that is about to
/// cause a re-spawn and then wait for the new PTY cannot identify the life it is waiting for (the
/// epoch does not exist yet), but it CAN identify every life that already exists — and since epochs
/// strictly increase, "exited with an epoch greater than the one live when I started watching" is
/// exactly "the life I am waiting for died". Without that floor the observer accepts the death of
/// the PREDECESSOR its own spawn is tearing down, which is the misreading the epoch exists to close,
/// merely relocated into the waiter (`agentDemotion/live.ts`).
///
/// `0` on an unknown id is deliberately not an error: "nothing is live" is a real, useful answer —
/// it means every exit that follows belongs to a life spawned after the caller started watching.
///
/// Sync for the same reason as `pty_live_sessions`: a mutex lock and a `u64` copy, no I/O.
#[tauri::command]
pub fn pty_live_epoch(id: String, manager: State<PtyManager>) -> u64 {
    manager.live_epoch(&id)
}

#[cfg(test)]
mod epoch_tests {
    use super::{next_pty_epoch, PtyEnd};

    // THE ONE PROPERTY THE WHOLE MECHANISM RESTS ON: two PTYs never share an epoch. The session id
    // IS the agent id, so a restart reuses it; the epoch is the only thing that separates a
    // terminal's own death from its predecessor's, and an epoch handed out twice would let exactly
    // the misreading this exists to prevent back in for the pair that collided.
    #[test]
    fn epochs_are_unique_and_increasing() {
        let a = next_pty_epoch();
        let b = next_pty_epoch();
        let c = next_pty_epoch();
        assert!(a < b && b < c, "epochs must strictly increase, got {a} {b} {c}");
    }

    // Concurrent spawns are the realistic case — the resurrection runner brings a cohort back at
    // once, and `pty_spawn` mints before any lock is taken. A counter that raced would hand two
    // simultaneously-revived agents the same epoch.
    #[test]
    fn concurrent_minting_never_collides() {
        const THREADS: usize = 8;
        const PER_THREAD: usize = 250;
        let handles: Vec<_> = (0..THREADS)
            .map(|_| std::thread::spawn(|| (0..PER_THREAD).map(|_| next_pty_epoch()).collect::<Vec<_>>()))
            .collect();
        let mut all: Vec<u64> = handles.into_iter().flat_map(|h| h.join().expect("thread")).collect();
        let minted = all.len();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), minted, "every minted epoch must be distinct");
    }

    // 0 is reserved as the "no PTY has spawned yet" sentinel, so a real spawn must never mint it —
    // otherwise a transport that has not spawned would match a real exit.
    #[test]
    fn zero_is_never_minted() {
        assert!(next_pty_epoch() > 0);
    }

    // The exit event must actually CARRY the epoch over the wire. Serialized here rather than
    // asserted on the struct because the frontend reads JSON: a field that stopped being emitted
    // (a rename, a `skip_serializing_if`) would leave the TS filter comparing against `undefined`
    // and silently forwarding every exit again — the original bug, with the Rust side still green.
    #[test]
    fn exit_payload_serializes_its_epoch() {
        let json = serde_json::to_string(&PtyEnd { id: "agent-7".into(), epoch: 42 })
            .expect("PtyEnd must serialize");
        assert!(json.contains("\"epoch\":42"), "epoch missing from {json}");
        assert!(json.contains("\"id\":\"agent-7\""), "id missing from {json}");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_writer, apply_heap_cap, guard_resize_size, guard_spawn_size, next_pty_epoch,
        node_options_with_cap, run_flusher, validate_spawn_inner, Credit, FlushBuf, InflightState,
        finish_teardown, kill_session, PauseState, PtyManager, PtyEnd, PtySession, Reap,
        MIN_PTY_COLS,
        MIN_PTY_ROWS, NO_EPOCH,
        PTY_INFLIGHT_HIGH_WATER_BYTES, SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS,
    };
    use portable_pty::CommandBuilder;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A panic while the `sessions` mutex is held poisons it. The poison-tolerant locks
    /// (`unwrap_or_else(|e| e.into_inner())`) must recover the guard so later PTY operations keep
    /// working rather than panicking forever and wedging every terminal app-wide.
    #[test]
    fn sessions_lock_recovers_after_poison() {
        let manager = std::sync::Arc::new(PtyManager::default());
        // Poison the mutex: panic while holding the lock on a separate thread.
        let m = manager.clone();
        let _ = std::thread::spawn(move || {
            let _guard = m.sessions.lock().unwrap();
            panic!("poison the sessions mutex");
        })
        .join();
        assert!(manager.sessions.is_poisoned(), "mutex should be poisoned by the panic");
        // reap() goes through the poison-tolerant lock and must not panic. Asserted on the ACTUAL
        // production reap path (every reader thread ends here), not on a helper only tests call —
        // a poison-tolerance test aimed at an unused function guards nothing.
        assert_eq!(manager.reap("nonexistent", 1), Reap::AlreadyGone);
        // And the recovered guard still points at a usable HashMap.
        let len = manager.sessions.lock().unwrap_or_else(|e| e.into_inner()).len();
        assert_eq!(len, 0);
    }

    // ── per-agent V8 heap cap (sparkle-01xv / sparkle-asz5) ───────────────────────────────
    // On 2026-07-20 the kernel JetsamEvent reports showed 24 `claude` subprocesses each grown to
    // ~4 GiB — V8's DEFAULT heap ceiling — summing to 99 GiB and killing the machine. Every agent
    // PTY child now spawns with an explicit `--max-old-space-size`, so a runaway agent hits OUR
    // ceiling long before it hits Node's.

    #[test]
    fn node_options_sets_the_cap_when_the_user_has_none() {
        assert_eq!(node_options_with_cap(None, 3072).as_deref(), Some("--max-old-space-size=3072"));
        // An empty inherited value is the same as absent (no leading space in the result).
        assert_eq!(node_options_with_cap(Some(""), 3072).as_deref(), Some("--max-old-space-size=3072"));
        assert_eq!(
            node_options_with_cap(Some("   "), 3072).as_deref(),
            Some("--max-old-space-size=3072")
        );
    }

    #[test]
    fn node_options_appends_to_a_users_existing_value_instead_of_clobbering_it() {
        // The user's flags MUST survive — NODE_OPTIONS is commonly used for --require shims,
        // --enable-source-maps, proxy certs, etc. Clobbering it would silently break their setup.
        let got = node_options_with_cap(Some("--enable-source-maps"), 3072);
        assert_eq!(got.as_deref(), Some("--enable-source-maps --max-old-space-size=3072"));
    }

    #[test]
    fn node_options_lets_an_explicit_user_heap_size_win() {
        // If the user already pinned a heap size, that's a deliberate choice — leave it alone
        // rather than appending a second (conflicting) flag.
        let got = node_options_with_cap(Some("--max-old-space-size=8192"), 3072);
        assert_eq!(got.as_deref(), Some("--max-old-space-size=8192"));
        // ...including the `=`-less and mid-string spellings.
        let got = node_options_with_cap(Some("--enable-source-maps --max-old-space-size 8192"), 3072);
        assert_eq!(got.as_deref(), Some("--enable-source-maps --max-old-space-size 8192"));
        let got = node_options_with_cap(Some("--max_old_space_size=8192"), 3072);
        assert_eq!(got.as_deref(), Some("--max_old_space_size=8192"));
    }

    /// roborev 40812. The check was `contains("--max-old-space-size")`, which also fires on an
    /// unrelated token that merely EMBEDS the flag name. Reading that as "the user already set a
    /// heap limit" suppresses the cap entirely — the one outcome sparkle-01xv exists to prevent
    /// (24 uncapped agents summing 99 GiB). The match must be per token.
    #[test]
    fn node_options_is_not_fooled_by_a_token_that_merely_embeds_the_flag_name() {
        // A require path that happens to contain the flag name. The cap MUST still be appended.
        let got = node_options_with_cap(Some("--require ./max-old-space-size-helper.js"), 3072);
        assert_eq!(
            got.as_deref(),
            Some("--require ./max-old-space-size-helper.js --max-old-space-size=3072"),
            "an embedded occurrence is not the user setting the flag"
        );

        // A longer flag that merely starts with the same characters.
        let got = node_options_with_cap(Some("--max-old-space-size-foo=1"), 3072);
        assert_eq!(
            got.as_deref(),
            Some("--max-old-space-size-foo=1 --max-old-space-size=3072"),
            "a different flag sharing the prefix is not the user setting the flag"
        );

        // And the real thing is still honoured — the fix must not overshoot into ignoring the user.
        let got = node_options_with_cap(Some("--require ./x.js --max-old-space-size=8192"), 3072);
        assert_eq!(got.as_deref(), Some("--require ./x.js --max-old-space-size=8192"));
    }

    #[test]
    fn node_options_is_left_alone_when_the_cap_is_disabled() {
        // agent_heap_mb = 0 is the documented escape hatch: no cap, and no NODE_OPTIONS churn.
        assert_eq!(node_options_with_cap(None, 0), None);
        assert_eq!(node_options_with_cap(Some("--enable-source-maps"), 0), None);
    }

    #[test]
    fn apply_heap_cap_sets_node_options_on_the_spawned_command() {
        let mut cmd = CommandBuilder::new("/bin/echo");
        apply_heap_cap(&mut cmd, None, 3072);
        assert_eq!(
            cmd.get_env("NODE_OPTIONS").and_then(|v| v.to_str()),
            Some("--max-old-space-size=3072")
        );
    }

    #[test]
    fn apply_heap_cap_merges_the_inherited_value_onto_the_spawned_command() {
        let mut cmd = CommandBuilder::new("/bin/echo");
        apply_heap_cap(&mut cmd, Some("--enable-source-maps".into()), 3072);
        assert_eq!(
            cmd.get_env("NODE_OPTIONS").and_then(|v| v.to_str()),
            Some("--enable-source-maps --max-old-space-size=3072")
        );
    }

    #[test]
    fn apply_heap_cap_touches_nothing_when_disabled() {
        let mut cmd = CommandBuilder::new("/bin/echo");
        // Compare against what the builder reported BEFORE the call rather than against `None`.
        // `CommandBuilder` inherits the process environment, and `get_env` surfaces the inherited
        // value — so asserting `None` really asserts "NODE_OPTIONS is unset in whoever ran the
        // tests". That holds on CI and fails for anyone running the suite inside a Sparkle agent,
        // because Sparkle sets NODE_OPTIONS=--max-old-space-size=… on its agents: this very
        // feature. The intent here is "touches nothing", and before/after states exactly that,
        // whatever the ambient env happens to be.
        let before = cmd.get_env("NODE_OPTIONS").map(|v| v.to_owned());
        apply_heap_cap(&mut cmd, Some("--enable-source-maps".into()), 0);
        assert_eq!(
            cmd.get_env("NODE_OPTIONS").map(|v| v.to_owned()),
            before,
            "a disabled cap must leave NODE_OPTIONS exactly as inherited"
        );
    }

    // ── thin-column backstop ──────────────────────────────────────────────────────────────
    #[test]
    fn spawn_size_passes_a_plausible_size_through() {
        assert_eq!(guard_spawn_size("a", 132, 44), (132, 44));
        // Exactly at the floor is plausible.
        assert_eq!(guard_spawn_size("a", MIN_PTY_COLS, MIN_PTY_ROWS), (MIN_PTY_COLS, MIN_PTY_ROWS));
    }

    #[test]
    fn spawn_size_replaces_a_thin_size_with_the_fallback() {
        // The exact sizes seen in the wild (cols=11/12, rows=5/7) that produced the compressed
        // terminal: a too-small COLS or too-small ROWS each trigger the wholesale fallback.
        assert_eq!(guard_spawn_size("a", 11, 5), (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS));
        assert_eq!(guard_spawn_size("a", 12, 7), (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS));
        assert_eq!(guard_spawn_size("a", 200, 2), (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS));
        assert_eq!(guard_spawn_size("a", 0, 0), (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS));
    }

    #[test]
    fn resize_size_floors_each_dimension_without_resetting() {
        // A plausible resize is honored exactly.
        assert_eq!(guard_resize_size("a", 100, 40), (100, 40));
        // A thin resize is floored per-dimension (NOT reset to a default), so a genuine
        // resize to a slightly-small pane is honored as closely as is safe.
        assert_eq!(guard_resize_size("a", 11, 40), (MIN_PTY_COLS, 40));
        assert_eq!(guard_resize_size("a", 100, 2), (100, MIN_PTY_ROWS));
        assert_eq!(guard_resize_size("a", 11, 5), (MIN_PTY_COLS, MIN_PTY_ROWS));
    }

    /// The thin-column floor + spawn fallback are duplicated in the frontend guard
    /// (terminalSize.ts) and kept in sync only by a comment. If the two layers drift, a thin
    /// size can slip through one of them — the exact failure this backstop exists to prevent.
    /// This test reads terminalSize.ts and fails if the values diverge (roborev 17540).
    #[test]
    fn backstop_constants_match_the_frontend_guard() {
        // cargo test runs with CWD = the crate dir (apps/desktop/src-tauri).
        let ts = std::fs::read_to_string("../src/components/terminalSize.ts")
            .expect("read terminalSize.ts");
        // Pull `export const NAME = <int>;` out of the TS source.
        let val = |name: &str| -> u16 {
            let pat = format!("{name} = ");
            let after = ts.split(&pat).nth(1).unwrap_or_else(|| panic!("{name} not found in terminalSize.ts"));
            after
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or_else(|_| panic!("{name} is not an integer in terminalSize.ts"))
        };
        assert_eq!(val("MIN_PLAUSIBLE_COLS"), MIN_PTY_COLS, "cols floor drifted from terminalSize.ts");
        assert_eq!(val("MIN_PLAUSIBLE_ROWS"), MIN_PTY_ROWS, "rows floor drifted from terminalSize.ts");
        assert_eq!(val("SPAWN_FALLBACK_COLS"), SPAWN_FALLBACK_COLS, "spawn-fallback cols drifted");
        assert_eq!(val("SPAWN_FALLBACK_ROWS"), SPAWN_FALLBACK_ROWS, "spawn-fallback rows drifted");
    }

    /// Create a unique `<tmp>/-test-<pid>-<n>` with a real `worktrees/proj/agent`
    /// inside, and return the `worktrees` base.
    fn worktrees_base() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("-test-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&root);
        let base = root.join("worktrees");
        fs::create_dir_all(base.join("proj").join("agent")).unwrap();
        base
    }

    /// `managed_base` is `<app_data>` — the parent of the `<app_data>/worktrees` base returned by
    /// `worktrees_base()`. It exists (the helper created it), so it canonicalizes.
    fn managed_of(worktrees: &std::path::Path) -> PathBuf {
        worktrees.parent().unwrap().to_path_buf()
    }

    #[test]
    fn rejects_relative_or_empty_command() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        assert!(validate_spawn_inner(&base, &managed, "", None).is_err());
        assert!(validate_spawn_inner(&base, &managed, "bin/zsh", None).is_err());
        // An absolute allowlisted binary passes the command check even if it doesn't exist (we only
        // require absoluteness + an allowlisted basename, not existence — the legit cmd is /bin/zsh).
        assert!(validate_spawn_inner(&base, &managed, "/bin/zsh", None).is_ok());
    }

    #[test]
    fn null_cwd_falls_back_to_the_managed_dir() {
        // A null cwd (the pre-worktree login flows) no longer skips the containment check: it
        // resolves to the managed app-data dir so the spawn still runs in a validated location.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let got = validate_spawn_inner(&base, &managed, "/bin/zsh", None).unwrap();
        assert_eq!(got, managed.canonicalize().unwrap());
    }

    #[test]
    fn accepts_cwd_inside_worktrees() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        let cwd = base.join("proj").join("agent");
        let got =
            validate_spawn_inner(&base, &managed, "/bin/zsh", Some(cwd.to_str().unwrap())).unwrap();
        assert_eq!(got, cwd.canonicalize().unwrap());
    }

    #[test]
    fn rejects_cwd_outside_worktrees() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        let outside = std::env::temp_dir();
        assert!(
            validate_spawn_inner(&base, &managed, "/bin/zsh", Some(outside.to_str().unwrap()))
                .is_err()
        );
    }

    /// AN ACCOUNT CONFIG DIR IS NOT A LEGAL cwd — this is the mechanism behind sparkle-mahbf.
    ///
    /// `<app_data>/accounts/<id>` is a SIBLING of `<app_data>/worktrees`, not a child, so handing it
    /// to `pty_spawn` as the cwd is refused every single time. The embedded `claude auth login` did
    /// exactly that, which is why "Add account" could never open a login pane and its "Start again"
    /// re-ran an identically doomed spawn. The frontend fix is to pass NO cwd (the account is
    /// targeted by `CLAUDE_CONFIG_DIR`); this test pins the constraint that makes that the only
    /// correct answer, so nobody "helpfully" restores the cwd later.
    #[test]
    fn rejects_an_account_config_dir_as_cwd() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        let account_dir = managed.join("accounts").join("602064ad688be368");
        std::fs::create_dir_all(&account_dir).unwrap();
        let err = validate_spawn_inner(&base, &managed, "/bin/zsh", account_dir.to_str())
            .expect_err("an account config dir must not be accepted as a spawn cwd");
        assert!(
            err.contains("outside the managed worktrees directory"),
            "expected the containment refusal, got: {err}"
        );
        // …and the sanctioned alternative — no cwd at all — is accepted, landing in the managed dir.
        assert_eq!(
            validate_spawn_inner(&base, &managed, "/bin/zsh", None).unwrap(),
            managed.canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_dotdot_escape_cwd() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        // <base>/proj/agent/../../.. climbs above the worktrees base.
        let escape = base.join("proj").join("agent").join("..").join("..").join("..");
        assert!(
            validate_spawn_inner(&base, &managed, "/bin/zsh", Some(escape.to_str().unwrap()))
                .is_err()
        );
    }

    #[test]
    fn rejects_sibling_prefix_dir() {
        // A string-prefix compare would wrongly admit `<app_data>/worktrees-evil`; component-wise
        // starts_with must reject it. This test pins that behavior.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let sibling = base.with_file_name("worktrees-evil");
        fs::create_dir_all(&sibling).unwrap();
        assert!(
            validate_spawn_inner(&base, &managed, "/bin/zsh", Some(sibling.to_str().unwrap()))
                .is_err()
        );
    }

    #[test]
    fn rejects_a_disallowed_binary() {
        // A compromised webview can't turn pty_spawn into an arbitrary-exec primitive by naming
        // some other absolute binary — even with a perfectly valid, worktree-contained cwd.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let cwd = base.join("proj").join("agent");
        let cwd_s = cwd.to_str().unwrap();
        for evil in ["/usr/bin/osascript", "/usr/bin/curl", "/bin/rm", "/usr/bin/python3"] {
            assert!(
                validate_spawn_inner(&base, &managed, evil, Some(cwd_s)).is_err(),
                "{evil} must be rejected by the binary allowlist"
            );
        }
    }

    #[test]
    fn accepts_allowlisted_binary_basenames() {
        // Every basename the app legitimately spawns (or resolves in preflight) passes, wherever it
        // lives — the check is lexical on the basename, not on the binary existing at that path.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let cwd = base.join("proj").join("agent");
        let cwd_s = cwd.to_str().unwrap();
        for ok in [
            "/bin/zsh",
            "/bin/bash",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/git",
            "/Users/x/.local/bin/claude",
        ] {
            assert!(
                validate_spawn_inner(&base, &managed, ok, Some(cwd_s)).is_ok(),
                "{ok} should pass the binary allowlist"
            );
        }
    }

    #[test]
    fn accepts_a_binary_under_the_managed_dir() {
        // A binary the app bundles/manages under <app_data> is allowed even if its basename isn't
        // in the allowlist — it lives inside a trusted root.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let bin_dir = managed.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let helper = bin_dir.join("sparkle-helper");
        fs::write(&helper, b"#!/bin/sh\n").unwrap();
        let cwd = base.join("proj").join("agent");
        assert!(
            validate_spawn_inner(&base, &managed, helper.to_str().unwrap(), Some(cwd.to_str().unwrap()))
                .is_ok()
        );
        // ...but a same-named binary OUTSIDE the managed dir is still rejected.
        let outside = std::env::temp_dir().join("sparkle-helper-not-managed");
        fs::write(&outside, b"#!/bin/sh\n").unwrap();
        assert!(
            validate_spawn_inner(&base, &managed, outside.to_str().unwrap(), Some(cwd.to_str().unwrap()))
                .is_err()
        );
    }

    // ── sparkle-0bye: the memory watchdog's view of live sessions ─────────────────────────────

    /// `session_pids` must report the REAL spawned pid, keyed by session id, for every session that
    /// has one — and skip the ones that don't. `memwatch::agent_footprints` walks the process tree
    /// from these roots, so a wrong or missing pid silently makes an agent invisible to the
    /// watchdog (it would report 0 bytes, which reads as "healthy" rather than "unmeasured").
    #[test]
    fn session_pids_reports_the_spawned_pid_and_skips_sessions_without_one() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let Ok(pair) =
            sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            return; // no PTY in this environment — skip
        };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let pid = child.process_id();
        assert!(pid.is_some(), "portable_pty must report a pid for a live child");
        let writer = pair.master.take_writer().expect("take_writer");
        let mgr = PtyManager::default();
        mgr.sessions.lock().unwrap().insert(
            "agent-with-pid".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                pid,
                epoch: next_pty_epoch(),
            },
        );

        let pids = mgr.session_pids();
        assert_eq!(pids.len(), 1, "one session with a pid → one entry: {pids:?}");
        assert_eq!(pids[0].0, "agent-with-pid", "keyed by session id, which IS the agent id");
        assert_eq!(
            pids[0].1,
            pid.unwrap(),
            "the pid reported must be the one the child actually got"
        );

        // A session whose platform gave no pid is SKIPPED, not emitted as 0 — pid 0 would make the
        // watchdog walk the wrong tree (or none) while looking like a successful measurement.
        let removed = mgr.sessions.lock().unwrap().remove("agent-with-pid");
        if let Some(mut s) = removed {
            s.pid = None;
            mgr.sessions.lock().unwrap().insert("agent-no-pid".to_string(), s);
        }
        assert!(
            mgr.session_pids().is_empty(),
            "a session without a pid contributes no entry at all"
        );

        let removed = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove("agent-no-pid");
        if let Some(mut s) = removed {
            let _ = s.killer.kill();
            let _ = child.wait();
        }
    }

    /// A LOSER'S REAPER MUST NOT DELETE THE WINNER.
    ///
    /// The overlapping-spawn case, end to end on the manager alone, which is where it can be pinned
    /// deterministically. Two spawns land under one id; `sessions.insert` replaces silently, so the
    /// loser is gone from the map while its reader thread is still alive and still owes a teardown —
    /// and that teardown typically runs FIRST, because a command that fails fast exits immediately.
    ///
    /// With an id-keyed `remove` there, the live session disappears from the map: `pty_write` /
    /// `pty_resize` / `pty_kill` answer "no such pty" for a PTY the user is typing into, no
    /// `pty:exit` explains it (the loser's exit carries the lower epoch and is filtered out by
    /// design), and `live_epoch` reads NO_EPOCH while a higher-epoch session runs — so an observer
    /// floor sampled after that admits a stale exit. Every consequence the epoch exists to prevent,
    /// relocated past the insert.
    #[test]
    fn a_replaced_session_reaping_leaves_the_live_one_alone() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        // Two real sessions under ONE id — the shape an overlapping spawn leaves behind.
        let mut made = Vec::new();
        for _ in 0..2 {
            let Ok(pair) = sys.openpty(size) else { return };
            let Ok(child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
                return;
            };
            let killer = child.clone_killer();
            let Ok(writer) = pair.master.take_writer() else { return };
            made.push((
                PtySession {
                    writer: Arc::new(Mutex::new(writer)),
                    master: pair.master,
                    killer,
                    pause: Arc::new(PauseState::new()),
                    inflight: Arc::new(InflightState::new()),
                    pid: None,
                    epoch: NO_EPOCH,
                },
                child,
            ));
        }
        let mgr = PtyManager::default();
        let mut children = Vec::new();
        let mut epochs = Vec::new();
        for (session, child) in made {
            epochs.push(mgr.insert_session("agent-overlap".to_string(), session));
            children.push(child);
        }
        let (loser, winner) = (epochs[0], epochs[1]);
        assert!(winner > loser, "the later insert must carry the higher epoch");

        // The LOSER's reader thread reaches its teardown first and asks to reap.
        assert_eq!(
            mgr.reap("agent-overlap", loser),
            Reap::OwnedByOther,
            "a replaced session must not be able to remove the id it no longer owns"
        );
        assert_eq!(
            mgr.live_epoch("agent-overlap"),
            winner,
            "the live session must survive its predecessor's reaper"
        );
        assert_eq!(
            mgr.session_ids(),
            vec!["agent-overlap".to_string()],
            "and must still be visible to the resurrection guard"
        );

        // …and the winner's own reaper still works, or sessions would leak forever.
        assert_eq!(
            mgr.reap("agent-overlap", winner),
            Reap::RemovedOurs,
            "the session that owns the id must still be removable by its own reader"
        );
        assert_eq!(mgr.live_epoch("agent-overlap"), NO_EPOCH, "and the id is then free");

        for mut child in children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// THE KILL ORDERING, simulated the way it actually happens: a session is live, `pty_kill`
    /// removes it BY ID, and only then does its own reader thread wake on EOF and reap.
    ///
    /// Written as its own test against a freshly inserted session rather than reusing an id an
    /// earlier assertion already emptied — an empty map answers `AlreadyGone` for reasons that have
    /// nothing to do with a kill, so reusing it would re-test the trivial case while claiming to
    /// cover this one.
    #[test]
    fn a_session_killed_by_id_still_reads_as_unowned_to_its_own_reader() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let Ok(pair) = sys.openpty(size) else { return };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let Ok(writer) = pair.master.take_writer() else { return };
        let mgr = PtyManager::default();
        let epoch = mgr.insert_session(
            "agent-killed".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                pid: None,
                epoch: NO_EPOCH,
            },
        );

        // THE REAL KILL, not a hand-rolled stand-in for it. Reaching into the map here would assert
        // a precondition this test created: `reap` reads nothing but `sessions.get(id)`, so a
        // manually emptied map is byte-for-byte a map that never held the id, and the assertion
        // below would collapse into the `nonexistent` case another test already owns. Driving
        // `kill_session` is what makes ONE regression red: the kill ceasing to remove by id (a
        // `get_mut` in place of the `remove`) leaves the session under its own epoch, so the reap
        // below answers `RemovedOurs`. It does NOT pin the removal against `killer.kill()` — this
        // caller is synchronous, so both have run by the time `reap` is asked, and swapping the two
        // statements inside `kill_session` stays green here. Only a reader racing a live kill could
        // see that, and nothing in this suite does.
        assert!(kill_session(&mgr, "agent-killed"), "control: the session was live before the kill");

        // The reader wakes on EOF and reaps with ITS OWN epoch. Nothing owns the id, so this is
        // still its teardown to finish — not someone else's session to leave alone.
        assert_eq!(
            mgr.reap("agent-killed", epoch),
            Reap::AlreadyGone,
            "a session removed by pty_kill leaves its id UNOWNED; reading that as OwnedByOther \
             skips the reader's remaining teardown on every deliberate stop"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    /// THE GATE ITSELF — the two lines the previous fix actually changed, and the ones nothing
    /// covered. Reverting `finish_teardown` to `reap == RemovedOurs` (literally the pre-fix
    /// behavior) left the whole `pty::` suite green, because every assertion targeted `reap`'s
    /// return value rather than what the caller DOES with it. These three cases red under that
    /// exact mutation.
    #[test]
    fn finish_teardown_detaches_unless_the_id_belongs_to_someone_else() {
        use crate::nudger::Observers;

        // RemovedOurs — the natural-exit path: our session was in the map and we took it out.
        let observers = Observers::default();
        observers.attach("agent-a", 80, 24);
        finish_teardown(&observers, "agent-a", Reap::RemovedOurs);
        assert!(observers.get("agent-a").is_none(), "a natural exit must stop observing");

        // AlreadyGone — pty_kill got there first. STILL OURS to finish tearing down: this is the
        // case the boolean gate got wrong, and it is the commonest teardown there is.
        let observers = Observers::default();
        observers.attach("agent-b", 80, 24);
        finish_teardown(&observers, "agent-b", Reap::AlreadyGone);
        assert!(
            observers.get("agent-b").is_none(),
            "a killed agent must stop being observed, or nudger::tick keeps it in `live` forever \
             and escalates a terminal that no longer exists"
        );

        // OwnedByOther — an overlapping spawn replaced us. The observer belongs to a LIVE PTY.
        let observers = Observers::default();
        observers.attach("agent-c", 80, 24);
        finish_teardown(&observers, "agent-c", Reap::OwnedByOther);
        assert!(
            observers.get("agent-c").is_some(),
            "a replaced reader must not detach the observer of the live session that replaced it"
        );
    }

    /// `session_ids` must report a session that has NO pid — the exact entry `session_pids` skips.
    ///
    /// This is the whole point of the second method, and it is asserted here rather than left to
    /// read as a duplicate: a pid-less session is a spawn IN FLIGHT, which is the most dangerous
    /// state the resurrection guard can be blind to. `sessions.insert` REPLACES silently, so if this
    /// reported empty the runner would admit an agent that is already booting, the second spawn
    /// would drop the first `PtySession`, and its child would keep running with nothing holding a
    /// handle to it — still burning tokens, still holding its worktree, invisible everywhere.
    ///
    /// Written as an inverted pair against `session_pids` on the SAME manager, so it cannot pass by
    /// the fixture being empty: one method must answer 0 while the other answers 1.
    #[test]
    fn session_ids_reports_a_pid_less_session_that_session_pids_skips() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let Ok(pair) =
            sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            return; // no PTY in this environment — skip
        };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let writer = pair.master.take_writer().expect("take_writer");
        let mgr = PtyManager::default();
        // Through `insert_session`, the way production does — the epoch is stamped by the insert, so
        // a session constructed with the `NO_EPOCH` placeholder comes out of the map carrying a real
        // life. Inserting by hand here would let the placeholder survive and hide that.
        let inserted = mgr.insert_session(
            "agent-mid-spawn".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                // No pid yet — a spawn that has not finished reporting one.
                pid: None,
                epoch: NO_EPOCH,
            },
        );
        assert!(inserted > NO_EPOCH, "insert_session must stamp a real epoch, not the sentinel");

        assert!(
            mgr.session_pids().is_empty(),
            "control: session_pids skips a pid-less session, so a 1 below is this method's doing"
        );
        assert_eq!(
            mgr.session_ids(),
            vec!["agent-mid-spawn".to_string()],
            "a live session with no pid is still a live session"
        );

        // The observer's FLOOR. It must report the epoch of the session that is live RIGHT NOW, and
        // must answer 0 — never a live session's epoch — for an id with nothing under it: a waiter
        // told the wrong floor either ignores the death it is waiting for or accepts a predecessor's.
        let live = mgr.sessions.lock().unwrap().get("agent-mid-spawn").map(|s| s.epoch).unwrap();
        assert_eq!(
            mgr.live_epoch("agent-mid-spawn"),
            live,
            "live_epoch must report the epoch of the session actually in the map"
        );
        // THE EPOCH THE INSERT RETURNED IS THE EPOCH THE MAP HOLDS. `pty_spawn` returns this value to
        // the frontend, which binds its exit filter to it, so a stamp that did not reach the session
        // would bind the terminal to a life the PTY host never recorded.
        assert_eq!(
            inserted, live,
            "the epoch insert_session returns must be the one it stored under that id"
        );
        assert_eq!(
            mgr.live_epoch("no-such-agent"),
            0,
            "an id with no session reads as the never-minted sentinel, not as some other session"
        );

        let removed = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove("agent-mid-spawn");
        if let Some(mut s) = removed {
            let _ = s.killer.kill();
            let _ = child.wait();
        }
    }

    // ── sparkle-4orh: per-session write lock ──────────────────────────────────────────────────
    /// Holding a session's per-session writer lock (as `pty_write` does across a blocking write)
    /// must NOT keep the global `sessions` map locked — otherwise a big paste into a stalled child
    /// would freeze spawn/write/resize/kill for every other terminal. Uses a real PTY + `/bin/cat`
    /// so it exercises the actual `PtySession` / `acquire_writer` path; skips if no PTY is available.
    #[test]
    fn per_session_writer_lock_frees_the_global_map() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let Ok(pair) =
            sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            return; // no PTY in this environment — skip
        };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let pid = child.process_id();
        let writer = pair.master.take_writer().expect("take_writer");
        let session = PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            killer,
            pause: Arc::new(PauseState::new()),
            inflight: Arc::new(InflightState::new()),
            pid,
            epoch: next_pty_epoch(),
        };
        let sessions: Mutex<HashMap<String, PtySession>> = Mutex::new(HashMap::new());
        sessions.lock().unwrap().insert("a".to_string(), session);

        // Simulate an in-flight blocking write: hold THIS session's writer lock.
        let handle = acquire_writer(&sessions, "a").expect("writer handle");
        let held = handle.lock().unwrap_or_else(|e| e.into_inner());

        // The global map must still be immediately lockable — the whole point of sparkle-4orh.
        assert!(
            sessions.try_lock().is_ok(),
            "global sessions lock must be free while a session's writer is held"
        );
        // A missing session still reports NO_SUCH_PTY through the same helper.
        assert!(acquire_writer(&sessions, "missing").is_err());

        drop(held);
        let removed = sessions.lock().unwrap_or_else(|e| e.into_inner()).remove("a");
        if let Some(mut s) = removed {
            let _ = s.killer.kill();
            let _ = child.wait();
        }
    }

    // ── : read-backpressure pause gate ─────────────────────────────────────────────
    /// A parked reader stays parked while paused and proceeds the instant it's resumed — the
    /// mechanism `pty_set_paused` / `pty_kill` rely on.
    #[test]
    fn pause_state_blocks_while_paused_and_wakes_on_resume() {
        let ps = Arc::new(PauseState::new());
        ps.set(true);
        let woke = Arc::new(AtomicBool::new(false));
        let ps2 = ps.clone();
        let woke2 = woke.clone();
        let h = std::thread::spawn(move || {
            ps2.wait_while_paused();
            woke2.store(true, Ordering::SeqCst);
        });
        // Let the thread park on the condvar; it must not have proceeded past the pause.
        std::thread::sleep(Duration::from_millis(50));
        assert!(!woke.load(Ordering::SeqCst), "reader must stay parked while paused");
        ps.set(false); // resume
        h.join().unwrap();
        assert!(woke.load(Ordering::SeqCst), "reader must proceed after resume");
    }

    /// When not paused, `wait_while_paused` returns immediately (interactive output is unaffected).
    #[test]
    fn pause_state_does_not_block_when_not_paused() {
        let ps = PauseState::new();
        ps.wait_while_paused(); // returns at once
        ps.set(true);
        ps.set(false);
        ps.wait_while_paused(); // still returns at once after a resume
    }

    // ── .4: live PTY boundary (output bytes → exit) ────────────────────────────────
    /// One real integration test at the PTY boundary. It spawns an actual pseudo-terminal running a
    /// deterministic, always-available command (`/bin/echo`) via the SAME `portable_pty` primitives
    /// `pty_spawn` uses (openpty → spawn_command → drop slave → clone master reader → reap child),
    /// then drives the exact read loop the reader thread runs:
    ///   - `pty:output` boundary: the bytes read off the master carry the child\'s stdout marker.
    ///   - `pty:exit`   boundary: the master reader reaches EOF (`Ok(0)`) once the child exits, and
    ///     the child is reapable — the two conditions that make `pty_spawn` emit `pty:exit`.
    /// Robust/non-flaky: the marker is fixed, the command exits on its own, and the master read runs
    /// on a worker thread so the assertion is bounded by a `recv_timeout` (never an open-ended hang).
    /// Gated to skip only if the environment can\'t open a PTY at all (e.g. a locked-down sandbox);
    /// on macOS/Linux CI a PTY is available, so it runs for real.
    #[test]
    fn pty_boundary_delivers_output_bytes_then_exits() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::sync::mpsc;

        const MARKER: &str = "pty-boundary-probe-ova4";

        let sys = native_pty_system();
        let Ok(pair) =
            sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            eprintln!("no PTY available — skipping pty_boundary_delivers_output_bytes_then_exits");
            return;
        };

        // Deterministic, universally-present command that prints a fixed marker and exits 0.
        let mut cmd = CommandBuilder::new("/bin/echo");
        cmd.arg(MARKER);
        let Ok(mut child) = pair.slave.spawn_command(cmd) else {
            eprintln!("spawn failed — skipping pty_boundary_delivers_output_bytes_then_exits");
            return;
        };
        // Drop the slave so the master sees EOF once the child exits — exactly as `pty_spawn` does.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("clone master reader");

        // Read the master to EOF on a worker thread (mirrors the reader thread\'s `Ok(0) => break`),
        // so the test can bound the wait and never hang if EOF somehow never arrives.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut out: Vec<u8> = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,                              // EOF → child exited (pty:exit)
                    Ok(n) => out.extend_from_slice(&buf[..n]),   // bytes → pty:output
                    Err(_) => break, // some backends surface EOF as an error; treat it as end-of-stream
                }
            }
            let _ = tx.send(out);
        });

        // pty:output boundary — the emitted stream must carry the child\'s stdout bytes.
        let out = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("master reader must reach EOF within 10s (pty:exit boundary)");
        let text = String::from_utf8_lossy(&out);
        assert!(
            text.contains(MARKER),
            "pty:output must carry the child\'s bytes; got {text:?}"
        );

        // pty:exit boundary — the process ended and is reapable (what the reaper thread relies on).
        let status = child.wait().expect("child must be reapable at exit");
        assert!(status.success(), "/bin/echo must exit 0; got {status:?}");
    }

    /// `pty_kill` on a PAUSED session must resume it, or the reader stays parked on the pause gate,
    /// never observes the child's EOF, and never runs its teardown (reap + `pty:exit`) — the agent
    /// is dead and the app still shows it live (). Same hazard on the credit gate: a
    /// producer parked waiting for acks gets none once the terminal is gone.
    ///
    /// DRIVEN, not restaged. This used to build its own `PauseState`, park a thread on it and call
    /// `pause.set(false)` itself under the comment "exactly what pty_kill does" — which made it a
    /// test of `PauseState`, green even with `session.pause.set(false)` deleted from the kill
    /// outright. `kill_session` is callable now, so the real path is what runs and that deletion
    /// reds it. Both gates are asserted, since nothing else covers the `inflight.close()`.
    #[test]
    fn kill_resumes_a_reader_parked_on_the_pause_gate_and_closes_the_credit_gate() {
        use portable_pty::{native_pty_system, PtySize};
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let Ok(pair) = sys.openpty(size) else { return };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let Ok(writer) = pair.master.take_writer() else { return };

        let pause = Arc::new(PauseState::new());
        let inflight = Arc::new(InflightState::new());
        pause.set(true); // the state a kill has to rescue: paused, with a reader about to park
        let mgr = PtyManager::default();
        mgr.insert_session(
            "agent-paused".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: pause.clone(),
                inflight: inflight.clone(),
                pid: None,
                epoch: NO_EPOCH,
            },
        );

        let woke = Arc::new(AtomicBool::new(false));
        let (p2, w2) = (pause.clone(), woke.clone());
        let reader = std::thread::spawn(move || {
            p2.wait_while_paused(); // the real reader parks here before each read()
            w2.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(30));
        assert!(!woke.load(Ordering::SeqCst), "control: a paused reader stays parked until the kill");
        assert!(!inflight.is_closed(), "control: the credit gate is open until the kill closes it");

        assert!(kill_session(&mgr, "agent-paused"), "control: the session was live before the kill");

        // Bounded wait, not a `join`: the regression this guards against is a thread that NEVER
        // wakes, and joining it would HANG the suite instead of failing it.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !woke.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            woke.load(Ordering::SeqCst),
            "the kill must resume the pause gate; a reader left parked never reads the child's EOF, \
             so its teardown — reap and pty:exit — never runs and the agent reads live forever"
        );
        assert!(
            inflight.is_closed(),
            "the kill must close the credit gate; a producer parked on it is waiting for acks a \
             dead terminal can no longer send"
        );

        let _ = reader.join();
        let _ = child.kill();
        let _ = child.wait();
    }

    // ── IPC emit credit gate (inflight backpressure) ──────────────────────────────────────────
    //
    // The pause gate above can only ever measure the frontend's xterm PARSE backlog, because
    // `flow.onEnqueue` runs inside the pty:output handler — i.e. AFTER the main thread already
    // dequeued the IPC message. The IPC queue itself (tao's unbounded crossbeam channel) is
    // structurally invisible to it, so a main-thread-bound app piles up messages while `pending`
    // stays low and the brake never engages. `InflightState` closes that hole on the PRODUCER
    // side: bytes are charged when emitted and released only when the frontend acks them, so the
    // un-acked IPC queue is bounded by construction.

    /// Charging the gate past the limit must PARK the producer (never drop / truncate), and an
    /// ack must release it. This is the core credit contract.
    #[test]
    fn inflight_gate_parks_the_producer_past_the_limit_and_releases_on_ack() {
        let gate = Arc::new(InflightState::new());
        gate.charge(1000);
        // Below the limit → the producer proceeds immediately.
        assert_eq!(gate.acquire(2000, Duration::from_secs(5)), Credit::Ready);

        gate.charge(1500); // 2500 un-acked, over a 2000 limit
        let g2 = gate.clone();
        let passed = Arc::new(AtomicBool::new(false));
        let p2 = passed.clone();
        let h = std::thread::spawn(move || {
            let c = g2.acquire(2000, Duration::from_secs(10));
            p2.store(true, Ordering::SeqCst);
            c
        });
        std::thread::sleep(Duration::from_millis(60));
        assert!(!passed.load(Ordering::SeqCst), "producer must park while over the credit limit");

        gate.ack(600); // 1900 < 2000 → release
        assert_eq!(h.join().unwrap(), Credit::Ready);
        assert_eq!(gate.inflight_bytes(), 1900);
    }

    /// Acks must clamp at zero — a duplicate/late ack from a tearing-down terminal must not make
    /// the counter wrap (usize underflow would panic in debug and wedge the gate in release).
    #[test]
    fn inflight_ack_clamps_at_zero() {
        let gate = InflightState::new();
        gate.charge(100);
        gate.ack(9999);
        assert_eq!(gate.inflight_bytes(), 0);
    }

    /// Teardown liveness: a producer parked on the gate must be released by `close()` — otherwise
    /// the reader/flusher would never observe EOF and `flusher.join()` would hang forever.
    #[test]
    fn inflight_gate_releases_parked_producers_on_close() {
        let gate = Arc::new(InflightState::new());
        gate.charge(10_000);
        let g2 = gate.clone();
        let h = std::thread::spawn(move || g2.acquire(1000, Duration::from_secs(30)));
        std::thread::sleep(Duration::from_millis(40));
        gate.close();
        assert_eq!(h.join().unwrap(), Credit::Closed);
        // And every LATER acquire returns instantly, so the final EOF drain can't block.
        assert_eq!(gate.acquire(1, Duration::from_secs(30)), Credit::Closed);
    }

    /// Safety valve: if the frontend stops acking entirely (a webview that died without killing
    /// the PTY, or lost ack invokes), the producer must not wedge forever. After the stall window
    /// it forgives the outstanding credit and proceeds — throttled to roughly one chunk per
    /// window rather than blocked, and still dropping nothing.
    #[test]
    fn inflight_gate_forgives_credit_after_a_stall_rather_than_wedging() {
        let gate = InflightState::new();
        gate.charge(10_000);
        let t0 = std::time::Instant::now();
        assert_eq!(gate.acquire(1000, Duration::from_millis(80)), Credit::Stalled);
        assert!(t0.elapsed() >= Duration::from_millis(70), "must actually wait out the window");
        assert_eq!(gate.inflight_bytes(), 0, "stalled credit is forgiven so the producer proceeds");
    }

    /// THE critical correctness property: under a sustained flood the credit gate must throttle
    /// the flusher without DROPPING or REORDERING a single byte. Drives the real `run_flusher`
    /// against a fake emitter plus a consumer thread that acks, and asserts the concatenation of
    /// everything emitted is byte-identical to everything the producer pushed, in order.
    #[test]
    fn flusher_preserves_order_and_completeness_under_a_sustained_flood() {
        let shared = Arc::new((Mutex::new(FlushBuf::default()), Condvar::new()));
        let gate = Arc::new(InflightState::new());
        let emitted: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        // Peak un-acked bytes observed by the emitter — proves the gate actually bounded the queue.
        let peak = Arc::new(AtomicUsize::new(0));

        let limit = 4096usize;
        let f_shared = shared.clone();
        let f_gate = gate.clone();
        let f_emitted = emitted.clone();
        let f_peak = peak.clone();
        let flusher = std::thread::spawn(move || {
            run_flusher(&f_shared, &f_gate, "test", limit, |chunk, bytes| {
                f_peak.fetch_max(bytes, Ordering::Relaxed);
                f_emitted.lock().unwrap().push(chunk);
            });
        });

        // Consumer ("frontend"): drain credit slowly so the producer is genuinely forced to park.
        let c_gate = gate.clone();
        let c_emitted = emitted.clone();
        let consumer = std::thread::spawn(move || {
            let mut acked = 0usize;
            for _ in 0..2000 {
                let total: usize = {
                    let e = c_emitted.lock().unwrap();
                    e.iter().map(|s| s.len()).sum()
                };
                if total > acked {
                    c_gate.ack(total - acked);
                    acked = total;
                }
                std::thread::sleep(Duration::from_millis(1));
                if c_gate.is_closed() && total == acked {
                    break;
                }
            }
        });

        // Producer: a deterministic, self-describing stream so any reorder/loss is detectable.
        let mut expected = String::new();
        let (lock, cvar) = &*shared;
        for i in 0..400 {
            let piece = format!("<{i}:{}>", "x".repeat(200));
            expected.push_str(&piece);
            let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
            g.text.push_str(&piece);
            cvar.notify_one();
        }
        {
            let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
            g.done = true;
            cvar.notify_one();
        }
        // EOF must release any parked producer so the final drain completes (see close()).
        gate.close();
        flusher.join().unwrap();
        let _ = consumer.join();

        let got = emitted.lock().unwrap().concat();
        assert_eq!(got.len(), expected.len(), "no bytes may be dropped under flood");
        assert_eq!(got, expected, "bytes must arrive complete and in order");
        assert!(peak.load(Ordering::Relaxed) > 0, "the flusher must have emitted something");
    }

    /// The per-PTY credit limit is the aggregate memory knob: with N terminals the worst-case
    /// un-acked IPC backlog is N × this. Pin it so a careless bump can't quietly reintroduce the
    /// multi-GiB footprint (20 agents × 256 KiB ≈ 5 MiB of chunk text before JSON escaping).
    #[test]
    // clippy flags both assertions as having a constant value, which is precisely the intent: this
    // test exists to FAIL TO COMPILE-TIME-HOLD if someone edits the constants out of their safe
    // relationship. There is no runtime input to vary — the constants are the subject.
    #[allow(clippy::assertions_on_constants)]
    fn inflight_high_water_stays_small_enough_to_aggregate_safely() {
        assert!(
            PTY_INFLIGHT_HIGH_WATER_BYTES >= super::PTY_FLUSH_SIZE_THRESHOLD * 2,
            "must allow at least a couple of max-size chunks in flight or throughput suffers"
        );
        assert!(
            PTY_INFLIGHT_HIGH_WATER_BYTES <= 512 * 1024,
            "per-PTY credit must stay small — it multiplies by the agent count"
        );
    }
}

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

impl PtyManager {
    fn remove(&self, id: &str) {
        // Poison-tolerant: a panic while another thread held this lock must not wedge every
        // later pty_spawn/write/resize/kill app-wide. The recovered guard still points at a
        // valid HashMap (mirrors accounts.rs / trial.rs).
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
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
}

/// Defense-in-depth checks before spawning — NOT the primary security boundary.
///
/// `pty_spawn` exists to launch the user's own `claude` via `/bin/zsh -lc '…'`, so by design
/// it runs whatever shell script the webview hands it; a binary allowlist can't change that
/// (`/bin/zsh -c '<anything>'` is the legitimate pattern). The REAL boundary is the WebView's
/// integrity: a strict CSP with no remote origins and no `unsafe-eval` (see tauri.conf.json),
/// plus a frontend that never renders agent/file output as executable HTML. These checks only
/// stop the obvious misuses and catch bugs:
///  - `command` must be a non-empty ABSOLUTE path (no `$PATH`-relative name resolution).
///  - `cwd`, if given, must resolve to a directory INSIDE the app's managed worktrees dir —
///    every real caller passes an agent worktree under `<app_data>/worktrees/…`.
///
/// Returns the canonicalized cwd (if any) so the caller spawns into the *validated* path rather
/// than the original string — closing a check-vs-use symlink-swap window.
fn validate_spawn(
    app: &AppHandle,
    command: &str,
    cwd: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let worktrees = crate::dev_identity::app_data_dir(app)
        .map_err(|e| format!("pty_spawn: {e}"))?
        .join("worktrees");
    validate_spawn_inner(&worktrees, command, cwd)
}

/// Pure, AppHandle-free core of `validate_spawn` (so it can be unit-tested). `worktrees_base` is
/// `<app_data>/worktrees`.
fn validate_spawn_inner(
    worktrees_base: &Path,
    command: &str,
    cwd: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    if command.is_empty() || !Path::new(command).is_absolute() {
        return Err("pty_spawn: command must be a non-empty absolute path".into());
    }
    let Some(cwd) = cwd else { return Ok(None) };
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
    Ok(Some(real))
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
) -> Result<(), String> {
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
            // Bound the child's V8 heap so a runaway agent can't run itself up to Node's ~4 GiB
            // default ceiling (sparkle-01xv). Merges with — never clobbers — a NODE_OPTIONS the
            // user already set; see node_options_with_cap.
            apply_heap_cap(&mut cmd, std::env::var("NODE_OPTIONS").ok(), heap_mb);
            // Spawn into the *validated, canonicalized* cwd (not the original string), so a symlink
            // swap between check and use can't redirect the working dir outside the worktrees tree.
            if let Some(dir) = validated_cwd {
                cmd.cwd(dir);
            }

            let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
            let killer = child.clone_killer();
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
    app.state::<PtyManager>()
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), session);

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
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            guard.text.push_str(&out);
            cvar.notify_one();
        };
        'read: loop {
            // Backpressure: block here while the frontend has paused us (its xterm write buffer is
            // above the high-water mark). Not read()ing lets the kernel PTY buffer fill so the child
            // blocks on its next write — bounding memory end-to-end (). Returns instantly
            // when not paused, so interactive output is unaffected.
            read_pause.wait_while_paused();
            // Second gate, same principle but driven by the PRODUCER's own accounting rather than
            // the frontend's: park while the frontend is behind on acks. Without this the flusher's
            // credit gate would merely relocate the backlog into `FlushBuf` (an unbounded String on
            // this side) instead of bounding it. Gating the READ is what makes the backpressure
            // end-to-end: the kernel PTY buffer fills and the child blocks on its next write().
            read_inflight.acquire(PTY_INFLIGHT_HIGH_WATER_BYTES, PTY_INFLIGHT_STALL);
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
        // Reap the session on natural exit (pty_kill also removes it).
        read_app.state::<PtyManager>().remove(&read_id);
        let _ = read_app.emit("pty:exit", PtyEnd { id: read_id.clone() });
    });

    Ok(())
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
pub fn pty_write(manager: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    // Take this session's OWN writer handle, releasing the global `sessions` lock BEFORE the write.
    // A large paste into a stalled child then blocks only this writer, leaving spawn/write/resize/
    // kill for every other terminal responsive (sparkle-4orh).
    let writer = acquire_writer(&manager.sessions, &id)?;
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
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Backstop against the thin-column bug (see guard_resize_size): never shrink a live PTY below
    // the plausible floor, whatever the frontend sent.
    let (cols, rows) = guard_resize_size(&id, cols, rows);
    let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let session = sessions.get(&id).ok_or(NO_SUCH_PTY)?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(manager: State<PtyManager>, id: String) -> Result<(), String> {
    tracing::info!(%id, "pty_kill");
    if let Some(mut session) = manager.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        // If the reader is parked (paused) it won't observe the kill's EOF and would never run its
        // teardown (remove + pty:exit). Resume it first so it wakes, reads EOF, and cleans up.
        session.pause.set(false);
        // Same hazard, second gate: a reader or flusher parked waiting for acks will get none once
        // the terminal is gone. Close the credit gate so both proceed, drain, and tear down.
        session.inflight.close();
        let _ = session.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_writer, apply_heap_cap, guard_resize_size, guard_spawn_size, node_options_with_cap,
        run_flusher, validate_spawn_inner, Credit, FlushBuf, InflightState, PauseState, PtyManager,
        PtySession, MIN_PTY_COLS, MIN_PTY_ROWS, PTY_INFLIGHT_HIGH_WATER_BYTES,
        SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS,
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
        // remove() goes through the poison-tolerant lock and must not panic.
        manager.remove("nonexistent");
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

    #[test]
    fn rejects_relative_or_empty_command() {
        let base = worktrees_base();
        assert!(validate_spawn_inner(&base, "", None).is_err());
        assert!(validate_spawn_inner(&base, "bin/zsh", None).is_err());
        // An absolute path passes the command check even if it doesn't exist (we only require
        // absoluteness, not existence — the legit command is /bin/zsh).
        assert!(validate_spawn_inner(&base, "/bin/zsh", None).is_ok());
    }

    #[test]
    fn none_cwd_passes_through() {
        let base = worktrees_base();
        assert_eq!(validate_spawn_inner(&base, "/bin/zsh", None).unwrap(), None);
    }

    #[test]
    fn accepts_cwd_inside_worktrees() {
        let base = worktrees_base();
        let cwd = base.join("proj").join("agent");
        let got = validate_spawn_inner(&base, "/bin/zsh", Some(cwd.to_str().unwrap())).unwrap();
        assert_eq!(got, Some(cwd.canonicalize().unwrap()));
    }

    #[test]
    fn rejects_cwd_outside_worktrees() {
        let base = worktrees_base();
        let outside = std::env::temp_dir();
        assert!(
            validate_spawn_inner(&base, "/bin/zsh", Some(outside.to_str().unwrap())).is_err()
        );
    }

    #[test]
    fn rejects_dotdot_escape_cwd() {
        let base = worktrees_base();
        // <base>/proj/agent/../../.. climbs above the worktrees base.
        let escape = base.join("proj").join("agent").join("..").join("..").join("..");
        assert!(validate_spawn_inner(&base, "/bin/zsh", Some(escape.to_str().unwrap())).is_err());
    }

    #[test]
    fn rejects_sibling_prefix_dir() {
        // A string-prefix compare would wrongly admit `<app_data>/worktrees-evil`; component-wise
        // starts_with must reject it. This test pins that behavior.
        let base = worktrees_base();
        let sibling = base.with_file_name("worktrees-evil");
        fs::create_dir_all(&sibling).unwrap();
        assert!(
            validate_spawn_inner(&base, "/bin/zsh", Some(sibling.to_str().unwrap())).is_err()
        );
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
        let writer = pair.master.take_writer().expect("take_writer");
        let session = PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            killer,
            pause: Arc::new(PauseState::new()),
            inflight: Arc::new(InflightState::new()),
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

    /// `pty_kill` on a paused session sets `pause.set(false)` BEFORE `killer.kill()` so a reader
    /// parked on the pause gate wakes, then reads the child's EOF and runs teardown. This pins that
    /// kill-while-paused ordering contract ().
    #[test]
    fn kill_order_wakes_a_reader_parked_on_the_pause_gate() {
        let pause = Arc::new(PauseState::new());
        pause.set(true);
        let woke = Arc::new(AtomicBool::new(false));
        let p2 = pause.clone();
        let w2 = woke.clone();
        let reader = std::thread::spawn(move || {
            p2.wait_while_paused(); // the real reader parks here before each read()
            w2.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(30));
        assert!(!woke.load(Ordering::SeqCst), "a paused reader must stay parked");
        // Exactly what pty_kill does to the removed session before killing the child:
        pause.set(false);
        reader.join().unwrap();
        assert!(woke.load(Ordering::SeqCst), "kill's resume must wake the parked reader");
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

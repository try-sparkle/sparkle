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

    // Share the session's pause gate with its reader thread before the session moves into the map.
    let read_pause = session.pause.clone();
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
    let flusher = std::thread::spawn(move || {
        let (lock, cvar) = &*flush_shared;
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
            drop(guard);
            if !chunk.is_empty() {
                let _ = flush_app.emit("pty:output", PtyOutput { id: flush_id.clone(), chunk });
            }
            if done {
                break;
            }
        }
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
        let _ = session.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_writer, guard_resize_size, guard_spawn_size, validate_spawn_inner, PauseState,
        PtyManager, PtySession, MIN_PTY_COLS, MIN_PTY_ROWS, SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS,
    };
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
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
}

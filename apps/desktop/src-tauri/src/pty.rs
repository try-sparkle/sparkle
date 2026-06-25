//! Local PTY host (§2 Rust backend). Runs the user's OWN Claude Code (or any command)
//! in a pseudo-terminal on THEIR machine under THEIR login. Sparkle is a
//! terminal-emulator UI on top — it never reads or stores the auth token; the genuine
//! `claude` binary authenticates itself, exactly as in any terminal/IDE. This is the
//! ToS-compliant way to let people use their Claude Max subscription: local, real binary, no token extraction.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
    fn remove(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
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
    let worktrees = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("pty_spawn: no app data dir: {e}"))?
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

/// Spawn `command` in a PTY. Output streams to the frontend via the `pty:output`
/// event; `pty:exit` fires when the process ends.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<PtyManager>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let validated_cwd = validate_spawn(&app, &command, cwd.as_deref())?;
    // Log the command and arg COUNT at info, but keep the full args at debug only: the args
    // carry the built `zsh -c '…'` script, which embeds the user's prompt/persona (and could
    // in principle carry a secret passed as a flag) — not something to write to the shared
    // daily log by default.
    tracing::info!(%id, %command, arg_count = args.len(), cwd = ?cwd, cols, rows, "pty_spawn");
    tracing::debug!(%id, args = ?args, "pty_spawn args (may contain prompt text)");
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
    // Spawn into the *validated, canonicalized* cwd (not the original string), so a symlink swap
    // between check and use can't redirect the working dir outside the worktrees tree.
    if let Some(dir) = validated_cwd {
        cmd.cwd(dir);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    // Drop the slave so the master sees EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    manager.sessions.lock().unwrap().insert(
        id.clone(),
        PtySession { writer, master: pair.master, killer },
    );

    // Reap the child so it doesn't zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    // Reader thread → emit output. Buffer partial multi-byte UTF-8 across chunk
    // boundaries (Claude Code's TUI emits box-drawing/emoji).
    let read_app = app.clone();
    let read_id = id.clone();
    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        let emit = |chunk: String| {
            let _ = read_app.emit("pty:output", PtyOutput { id: read_id.clone(), chunk });
        };
        'read: loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Drain every decodable byte. Emit valid text, SKIP genuinely
                    // invalid sequences (replacement char) so we never stall, and
                    // keep an incomplete trailing multibyte for the next read.
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                if !s.is_empty() {
                                    emit(s.to_owned());
                                    pending.clear();
                                }
                                break;
                            }
                            Err(e) => {
                                let valid = e.valid_up_to();
                                match e.error_len() {
                                    // Invalid bytes: emit valid prefix + U+FFFD, consume them.
                                    Some(bad) => {
                                        emit(
                                            String::from_utf8_lossy(&pending[..valid + bad])
                                                .into_owned(),
                                        );
                                        pending.drain(..valid + bad);
                                    }
                                    // Incomplete tail: emit valid prefix, keep the rest.
                                    None => {
                                        if valid > 0 {
                                            emit(
                                                String::from_utf8_lossy(&pending[..valid])
                                                    .into_owned(),
                                            );
                                            pending.drain(..valid);
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                Err(_) => break 'read,
            }
        }
        // Reap the session on natural exit (pty_kill also removes it).
        read_app.state::<PtyManager>().remove(&read_id);
        let _ = read_app.emit("pty:exit", PtyEnd { id: read_id.clone() });
    });

    Ok(())
}

/// Write to a PTY's stdin — e.g. an approval decision ("y\n" / "n\n") or user input.
#[tauri::command]
pub fn pty_write(manager: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or(NO_SUCH_PTY)?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
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
    if let Some(mut session) = manager.sessions.lock().unwrap().remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_spawn_inner;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

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
}

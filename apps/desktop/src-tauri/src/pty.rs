//! Local PTY host (§2 Rust backend). Runs the user's OWN Claude Code (or any command)
//! in a pseudo-terminal on THEIR machine under THEIR login. Sparkle is a
//! terminal-emulator UI on top — it never reads or stores the auth token; the genuine
//! `claude` binary authenticates itself, exactly as in any terminal/IDE. This is the
//! ToS-compliant way to let people use their Claude Max subscription: local, real binary, no token extraction.

use std::collections::HashMap;
use std::io::{Read, Write};
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
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    if let Some(dir) = cwd {
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
    let session = sessions.get_mut(&id).ok_or("no such pty")?;
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
    let session = sessions.get(&id).ok_or("no such pty")?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(manager: State<PtyManager>, id: String) -> Result<(), String> {
    if let Some(mut session) = manager.sessions.lock().unwrap().remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

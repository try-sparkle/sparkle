//! Headless Claude Code chat engine for the Think tab (design spec
//! PRD/feature/think-tab-claude-code-redesign.md, §"Engine: Claude Code headless").
//!
//! Like `pty.rs`, this runs the user's OWN `claude` binary on THEIR machine under THEIR
//! login — Sparkle never reads or stores the auth token; the genuine `claude` binary
//! authenticates itself (the ToS-compliant Claude Max path, bead ). The
//! difference from `pty.rs` is the surface: instead of a raw terminal, this drives
//! `claude -p … --output-format stream-json` headlessly and re-emits the NDJSON event
//! stream as clean Tauri events the Think chat UI renders as streamed markdown.
//!
//! Permission posture — Think is a READ-ONLY "safe zone": the documented invariant
//! (sparkle.ai/docs/think-plan-build) is that in Think no files change and the session
//! must NEVER hang on a permission prompt the headless UI can't answer. We satisfy both
//! with a read-only `--allowedTools` allowlist (no Bash, no writes); in `-p` print mode
//! a disallowed tool is simply refused rather than prompted, so the session can't hang.
//! We deliberately do NOT use `--dangerously-skip-permissions`.
//!
//! Security note (mirrors `pty.rs`): cwd confinement here is best-effort, NOT the primary
//! boundary. This command exists to launch the user's own `claude` via `/bin/zsh -l -c
//! '…'`, so by design it runs a shell script the webview hands it; the REAL boundary is
//! the WebView's integrity (a strict CSP with no remote origins / no `unsafe-eval`, see
//! tauri.conf.json) plus a frontend that never renders agent output as executable HTML.
//! Unlike `pty.rs` (whose cwd must live inside the managed worktrees dir), the cwd here is
//! the PROJECT ROOT, not a worktree — that is intentional and safe: Think runs read-only,
//! and running in the project root is what loads the project's CLAUDE.md/AGENTS.md + skills
//! (superpowers) exactly like the Build terminal, so the user can invoke skills from Think.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

/// Login shell we launch `claude` through, as `zsh -l -c 'exec …'`: a login but
/// NON-interactive shell, so it sources `.zprofile`/`.zlogin` for the user's real PATH/env
/// but not `.zshrc`. Matches `pty.rs` / `claudeSpawn.ts` so the launcher can't diverge.
const SHELL: &str = "/bin/zsh";

/// Read-only tool allowlist for the Think safe zone: reads, search, web, and the
/// skill/agent/todo tools — writes and Bash are NOT listed, so they're refused (not
/// prompted) in `-p` mode. Keep in sync with the spec's documented posture.
const ALLOWED_TOOLS: &str = "Read,Grep,Glob,WebFetch,WebSearch,Skill,Task,TodoWrite";

/// Appended to Claude Code's system prompt so it answers in clean GitHub-flavored markdown
/// (the Think chat surface renders responses as styled GFM — see the Markdown component).
const MD_SYSTEM_PROMPT: &str = "You are answering inside a chat surface that renders your \
replies as GitHub-flavored markdown. Respond in clean, well-structured GitHub-flavored \
markdown: use headings, bullet/numbered lists, fenced code blocks with language tags, \
tables, and inline code where they aid clarity. Do not wrap the whole reply in a single \
code fence. Keep prose tight and skimmable.";

/// Monotonic per-turn token. Every `claude_chat_send` mints one; the map entry and the
/// reader thread both carry it. A reader only reaps/emits when the map's entry STILL carries
/// its own token — so if a newer turn (same id) supersedes it, or a cancel removes it, the
/// stale reader stays silent instead of clobbering the live turn's child or its events. This
/// is the guard against the same-id reuse race (roborev 17683): the Think-agent id is reused
/// across sequential turns, and a rapid re-send/interrupt would otherwise orphan the old
/// `claude` process and misroute or drop the `done`/`error` event (hanging the UI).
static TURN_SEQ: AtomicU64 = AtomicU64::new(1);

/// One in-flight headless turn: the child (kept for kill/reap) tagged with its turn token.
struct ChatSession {
    child: Child,
    token: u64,
}

/// Tracks in-flight headless `claude` children by Think-agent id so `claude_chat_cancel`
/// can kill one (mirrors `PtyManager`). The reader thread removes its OWN entry (token-matched)
/// on natural exit, so a cancel after completion is a harmless no-op.
#[derive(Default)]
pub struct ClaudeChatManager {
    sessions: Mutex<HashMap<String, ChatSession>>,
}

/// Lock the session map, recovering from poisoning rather than panicking: a panic in one
/// thread while holding the lock must not permanently brick the chat engine for the rest of
/// the process (roborev). The map is simple owned state, so an `into_inner` recovery is safe.
fn lock_sessions(
    sessions: &Mutex<HashMap<String, ChatSession>>,
) -> MutexGuard<'_, HashMap<String, ChatSession>> {
    sessions.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Serialize)]
struct ChatDelta {
    id: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDone {
    id: String,
    session_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct ChatError {
    id: String,
    message: String,
}

/// Single-quote a value for safe use inside a `zsh -c '…'` string (mirrors `shellQuote`
/// in `claudeSpawn.ts`). A `'` becomes `'\''` so an attacker-controlled prompt/path/sid
/// can't break out of the quoting. `pub(crate)`: also used by `sparkle_improve.rs`, which
/// builds its own headless `claude -p` exec the same way.
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Build the `exec …` script handed to `zsh -l -c`. Mirrors `buildClaudeExec` in
/// `claudeSpawn.ts`: prepend `~/.local/bin` to PATH (so a Finder/Dock-launched .app, which
/// inherits no shell PATH, can still find user-local tools the skills/hooks may shell out
/// to), then `exec` the resolved `claude` so the child PID is `claude` itself (kill targets
/// it directly). `--model` is intentionally OMITTED so the session inherits the user's
/// configured Claude Code model.
fn build_claude_exec(claude_path: &str, prompt: &str, resume_session_id: Option<&str>) -> String {
    let mut cmd = format!("exec {}", shell_quote(claude_path));
    cmd.push_str(" -p ");
    cmd.push_str(&shell_quote(prompt));
    cmd.push_str(" --output-format stream-json --verbose --include-partial-messages");
    cmd.push_str(" --append-system-prompt ");
    cmd.push_str(&shell_quote(MD_SYSTEM_PROMPT));
    cmd.push_str(" --allowedTools ");
    cmd.push_str(&shell_quote(ALLOWED_TOOLS));
    // Multi-turn: resume the per-Think-agent session so the conversation is continuous.
    if let Some(sid) = resume_session_id {
        if !sid.is_empty() {
            cmd.push_str(" --resume ");
            cmd.push_str(&shell_quote(sid));
        }
    }
    format!("export PATH=\"$HOME/.local/bin:$PATH\"; {cmd}")
}

/// Handle one parsed NDJSON event, capturing session id + final text and accumulating
/// streamed assistant text. `emit_delta` is called with each incremental text chunk (the
/// reader thread wires it to `claude_chat:delta`); taking a closure instead of an
/// `AppHandle` keeps this stream-parsing core pure and unit-testable (the
/// pure-core-for-testing pattern from `pty.rs`/`preflight.rs`).
///  - `system`/`init` → capture `session_id`.
///  - `stream_event` content_block_delta/text_delta → incremental assistant text → `emit_delta`.
///  - `result` → capture the final `session_id` and the clean final `result` text.
///
/// `pub(crate)`: `sparkle_improve.rs` drives the same `claude -p --output-format stream-json`
/// NDJSON stream, so it reuses this parser rather than forking the event shapes.
pub(crate) fn handle_event(
    ev: &Value,
    session_id: &mut String,
    final_text: &mut String,
    acc: &mut String,
    emit_delta: &mut dyn FnMut(&str),
) {
    match ev.get("type").and_then(Value::as_str).unwrap_or("") {
        "system" => {
            if ev.get("subtype").and_then(Value::as_str) == Some("init") {
                if let Some(sid) = ev.get("session_id").and_then(Value::as_str) {
                    if !sid.is_empty() {
                        *session_id = sid.to_string();
                    }
                }
            }
        }
        "stream_event" => {
            let inner = ev.get("event");
            let is_text_delta = inner
                .and_then(|e| e.get("type"))
                .and_then(Value::as_str)
                == Some("content_block_delta")
                && inner
                    .and_then(|e| e.get("delta"))
                    .and_then(|d| d.get("type"))
                    .and_then(Value::as_str)
                    == Some("text_delta");
            if is_text_delta {
                if let Some(txt) = inner
                    .and_then(|e| e.get("delta"))
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                {
                    if !txt.is_empty() {
                        acc.push_str(txt);
                        emit_delta(txt);
                    }
                }
            }
        }
        "result" => {
            if let Some(sid) = ev.get("session_id").and_then(Value::as_str) {
                if !sid.is_empty() {
                    *session_id = sid.to_string();
                }
            }
            if let Some(r) = ev.get("result").and_then(Value::as_str) {
                if !r.trim().is_empty() {
                    *final_text = r.to_string();
                }
            }
        }
        _ => {}
    }
}

/// Run the user's own headless `claude` for one Think turn. Returns immediately; the child
/// and its stdout reader run on background threads. Streams arrive as Tauri events keyed by
/// `id`: `claude_chat:delta {id, text}` (incremental), `claude_chat:done {id, sessionId,
/// text}` on success, `claude_chat:error {id, message}` on failure / non-zero exit.
///
/// `claude_path` is resolved on the FRONTEND via preflight (`checkClaude`) and passed in, so
/// path resolution stays in one place (preflight.rs). `cwd` is the project root.
#[tauri::command]
pub fn claude_chat_send(
    app: AppHandle,
    manager: State<ClaudeChatManager>,
    id: String,
    prompt: String,
    cwd: String,
    claude_path: String,
    resume_session_id: Option<String>,
) -> Result<(), String> {
    // Defense-in-depth (NOT the primary boundary — that's the WebView CSP, see module docs):
    // require an absolute claude path (no $PATH-relative resolution) and a real cwd directory.
    if claude_path.is_empty() || !std::path::Path::new(&claude_path).is_absolute() {
        return Err("claude_chat_send: claude_path must be a non-empty absolute path".into());
    }
    if cwd.is_empty() {
        return Err("claude_chat_send: cwd must be provided".into());
    }
    // Canonicalize so we spawn into the resolved real path (closing a check-vs-use window) and
    // so a bogus cwd fails fast here rather than as an opaque spawn error.
    let real_cwd =
        std::fs::canonicalize(&cwd).map_err(|e| format!("claude_chat_send: invalid cwd: {e}"))?;

    let script = build_claude_exec(&claude_path, &prompt, resume_session_id.as_deref());
    // Log id/path/cwd but never the built script: it embeds the user's prompt (and could carry
    // a secret), matching pty.rs's "args may contain prompt text" caution.
    tracing::info!(
        %id, %claude_path, cwd = %real_cwd.display(),
        resume = resume_session_id.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
        "claude_chat_send"
    );

    let mut cmd = Command::new(SHELL);
    cmd.args(["-l", "-c", &script]);
    cmd.current_dir(&real_cwd);
    // No stdin: `-p` is one-shot, and a null stdin guarantees nothing can block on input.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("claude_chat_send: spawn failed: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude_chat_send: child has no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "claude_chat_send: child has no stderr".to_string())?;

    // Register this turn under a fresh token. If an entry already exists for this id, a prior
    // turn is still in flight (same-id reuse / rapid re-send): this send SUPERSEDES it — we
    // take the old child out (atomically, under the lock) and kill+reap it below. Its reader
    // will EOF, find a different token in the map, and stay silent (see the reader's reap).
    let token = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    let superseded = lock_sessions(&manager.sessions).insert(id.clone(), ChatSession { child, token });
    if let Some(mut old) = superseded {
        tracing::info!(%id, "claude_chat_send superseded an in-flight turn; killing the old child");
        let _ = old.child.kill();
        let _ = old.child.wait();
    }

    // Drain stderr on its own thread so a full stderr pipe can't deadlock the child, and join
    // it before reading so an error message is complete. Only used on the failure path.
    let stderr_handle = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s);
        s
    });

    // Reader thread: parse NDJSON line-by-line, emit deltas, then decide the outcome on EOF.
    let read_app = app.clone();
    let read_id = id.clone();
    let read_token = token;
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut session_id = String::new();
        let mut final_text = String::new();
        let mut acc = String::new();
        let mut line: Vec<u8> = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    // Split on the newline BYTE: 0x0A never appears inside a UTF-8 multibyte
                    // sequence, so a complete NDJSON line is always whole valid UTF-8 — line
                    // buffering subsumes the partial-multibyte concern pty.rs handles by hand.
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // Login profiles can echo non-JSON noise before `exec claude`; skip anything
                    // that isn't a JSON event rather than treating it as a failure — but log it
                    // at debug so a future claude stream-format change (which would otherwise
                    // present as a silent blank reply) is diagnosable (roborev).
                    if let Ok(ev) = serde_json::from_str::<Value>(trimmed) {
                        handle_event(
                            &ev,
                            &mut session_id,
                            &mut final_text,
                            &mut acc,
                            &mut |txt| {
                                let _ = read_app.emit(
                                    "claude_chat:delta",
                                    ChatDelta { id: read_id.clone(), text: txt.to_string() },
                                );
                            },
                        );
                    } else {
                        tracing::debug!(id = %read_id, "claude_chat: skipped non-JSON stdout line");
                    }
                }
                Err(_) => break,
            }
        }

        // Reap + decide the outcome — but ONLY if the map still holds OUR turn (token match).
        // If a newer same-id send superseded us, that send already took and reaped our child,
        // and the map now carries its token; if claude_chat_cancel removed us, the entry is
        // gone. In both cases the frontend initiated the teardown, so we stay silent (no
        // done/error) and leave the live turn's entry untouched.
        let child = {
            let manager = read_app.state::<ClaudeChatManager>();
            let mut sessions = lock_sessions(&manager.sessions);
            match sessions.get(&read_id) {
                Some(s) if s.token == read_token => sessions.remove(&read_id).map(|s| s.child),
                _ => None,
            }
        };
        let Some(mut child) = child else { return };
        let ok = matches!(child.wait(), Ok(status) if status.success());
        // Prefer the clean final `result` text; fall back to the accumulated deltas.
        let text = if !final_text.is_empty() { final_text } else { acc };

        if ok {
            // A successful exit with no text is unusual (e.g. a tool-only turn or a claude
            // stream-format change). It's still a valid `done` — ThinkPanel renders an empty
            // reply gracefully — but log it so a regression isn't an undiagnosable blank.
            if text.trim().is_empty() {
                tracing::debug!(id = %read_id, "claude_chat: successful turn produced no assistant text");
            }
            let _ = read_app.emit(
                "claude_chat:done",
                ChatDone { id: read_id.clone(), session_id, text },
            );
        } else {
            let stderr_text = stderr_handle.join().unwrap_or_default();
            let message = if !stderr_text.trim().is_empty() {
                stderr_text.trim().to_string()
            } else {
                "claude exited without a successful result".to_string()
            };
            let _ = read_app.emit("claude_chat:error", ChatError { id: read_id.clone(), message });
        }
    });

    Ok(())
}

/// Kill an in-flight Think turn (mirrors `pty_kill`). Removing the entry first means the
/// reader thread's token-matched reap finds no entry on EOF, so it stays silent rather than
/// racing a late done/error event. A no-op if the session already finished.
#[tauri::command]
pub fn claude_chat_cancel(manager: State<ClaudeChatManager>, id: String) -> Result<(), String> {
    tracing::info!(%id, "claude_chat_cancel");
    let session = lock_sessions(&manager.sessions).remove(&id);
    if let Some(mut session) = session {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_and_escapes_single_quotes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        // A single quote is closed, escaped, and reopened: it can't break out of the quoting.
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn build_exec_has_readonly_allowlist_and_md_prompt_no_model() {
        let script = build_claude_exec("/usr/local/bin/claude", "hello", None);
        assert!(script.contains("export PATH=\"$HOME/.local/bin:$PATH\";"));
        assert!(script.contains("exec '/usr/local/bin/claude'"));
        assert!(script.contains("-p 'hello'"));
        assert!(script.contains("--output-format stream-json --verbose --include-partial-messages"));
        assert!(script.contains("--allowedTools 'Read,Grep,Glob,WebFetch,WebSearch,Skill,Task,TodoWrite'"));
        assert!(script.contains("--append-system-prompt "));
        // Inherit the user's configured model, and never bypass permissions.
        assert!(!script.contains("--model"));
        assert!(!script.contains("--dangerously-skip-permissions"));
        // No resume when none is supplied.
        assert!(!script.contains("--resume"));
    }

    #[test]
    fn build_exec_appends_resume_when_session_id_present() {
        let script = build_claude_exec("/bin/claude", "hi", Some("sess-123"));
        assert!(script.contains("--resume 'sess-123'"));
        // An empty session id is treated as no resume (fresh turn).
        let none = build_claude_exec("/bin/claude", "hi", Some(""));
        assert!(!none.contains("--resume"));
    }

    #[test]
    fn build_exec_quotes_a_hostile_prompt() {
        // A prompt that tries to close the quote and inject a command stays a single quoted
        // argument — the injected text can't escape into the shell.
        let script = build_claude_exec("/bin/claude", "'; rm -rf /; echo '", None);
        assert!(script.contains(r"-p ''\''; rm -rf /; echo '\'''"));
    }

    fn init_event(sid: &str) -> Value {
        serde_json::json!({ "type": "system", "subtype": "init", "session_id": sid })
    }
    fn text_delta_event(text: &str) -> Value {
        serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": text } }
        })
    }
    fn result_event(sid: &str, text: &str) -> Value {
        serde_json::json!({ "type": "result", "subtype": "success", "session_id": sid, "result": text })
    }

    /// Drive `handle_event` over a realistic init → deltas → result sequence and assert it
    /// captures the session id, streams each delta, accumulates them, and prefers the final
    /// `result` text. Uses these exact event shapes captured from a real `claude -p
    /// --output-format stream-json` smoke test.
    #[test]
    fn handle_event_streams_deltas_and_captures_session_and_final_text() {
        let mut session_id = String::new();
        let mut final_text = String::new();
        let mut acc = String::new();
        let mut deltas: Vec<String> = Vec::new();

        let events = [
            init_event("sess-A"),
            text_delta_event("Hello"),
            text_delta_event(" world"),
            // A non-text stream_event must be ignored (not streamed).
            serde_json::json!({ "type": "stream_event", "event": { "type": "message_stop" } }),
            result_event("sess-A", "Hello world"),
        ];
        for ev in &events {
            handle_event(ev, &mut session_id, &mut final_text, &mut acc, &mut |t| {
                deltas.push(t.to_string());
            });
        }

        assert_eq!(session_id, "sess-A");
        assert_eq!(deltas, vec!["Hello", " world"]);
        assert_eq!(acc, "Hello world");
        // The clean `result` text is captured for the done event.
        assert_eq!(final_text, "Hello world");
    }

    #[test]
    fn handle_event_ignores_empty_text_deltas_and_unknown_types() {
        let mut session_id = String::new();
        let mut final_text = String::new();
        let mut acc = String::new();
        let mut count = 0;
        let mut emit = |_: &str| count += 1;

        handle_event(&text_delta_event(""), &mut session_id, &mut final_text, &mut acc, &mut emit);
        handle_event(
            &serde_json::json!({ "type": "rate_limit_event" }),
            &mut session_id,
            &mut final_text,
            &mut acc,
            &mut emit,
        );
        assert_eq!(count, 0);
        assert!(acc.is_empty());
        assert!(session_id.is_empty());
        assert!(final_text.is_empty());
    }
}

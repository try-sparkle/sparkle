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

/// Sibling of `handle_event`: on a `result` event, capture whether it reported FAILURE — its
/// `subtype` (when not `"success"`) and its `is_error` flag — so a non-zero exit with empty
/// stderr can be turned into a specific error message instead of a bare fallback. Kept as a
/// separate function (rather than folded into `handle_event`) so the shared parser's signature,
/// which `sparkle_improve.rs` also depends on, stays unchanged.
pub(crate) fn capture_result_status(ev: &Value, subtype: &mut Option<String>, is_error: &mut bool) {
    if ev.get("type").and_then(Value::as_str) != Some("result") {
        return;
    }
    if ev.get("is_error").and_then(Value::as_bool) == Some(true) {
        *is_error = true;
    }
    if let Some(st) = ev.get("subtype").and_then(Value::as_str) {
        if st != "success" && !st.is_empty() {
            *subtype = Some(st.to_string());
        }
    }
}

/// Structured outcome of ONE headless `claude` run (one child, its stdout read to EOF and the
/// child reaped). Returned by `run_reader` so the caller can decide whether to retry and how to
/// phrase a failure. `owned` is false when the session map no longer held our token by the time
/// we reached EOF (a newer same-id send superseded us, or `claude_chat_cancel` removed us): the
/// frontend already initiated teardown, so the caller must stay silent and NOT retry.
struct TurnOutcome {
    owned: bool,
    ok: bool,
    /// The child's exit code, or `None` if it was killed by a signal / the code was unavailable.
    exit_code: Option<i32>,
    /// The session id captured from the stream (used for the `done` event's `sessionId`).
    session_id: String,
    /// Clean final `result` text if present, else the accumulated deltas.
    text: String,
    /// Drained stderr (already `join`ed); the preferred error message when non-empty.
    stderr: String,
    /// A non-`"success"` `result` subtype the stream carried, if any (self-diagnosed failure).
    result_subtype: Option<String>,
    /// Whether the stream carried a `result` event with `is_error == true`.
    is_error: bool,
}

/// Decide whether a FAILED turn should be retried once WITHOUT `--resume`. A stale
/// `--resume <sid>` — a session id no longer in the cwd's `claude` history — is the #1
/// real-world cause of a non-zero exit with empty stderr (the first turn, which had no resume,
/// works; a later turn resumes a now-gone session and `claude` exits non-zero). So: retry iff
/// the turn FAILED *and* it carried a non-empty resume session id. A first turn with no resume
/// id, and any successful turn, never retries. Pure so it can be unit-tested.
fn should_retry_without_resume(ok: bool, resume_session_id: Option<&str>) -> bool {
    !ok && matches!(resume_session_id, Some(sid) if !sid.is_empty())
}

/// Build the `claude_chat:error` message for a failed turn. Prefers the child's own stderr
/// (its real diagnostics) when non-empty; otherwise synthesizes a SPECIFIC message from the
/// exit code and any non-`"success"` `result` subtype / `is_error` flag the stream carried,
/// replacing the old bare `"claude exited without a successful result"` fallback. Appends
/// `— retried without --resume` whenever a resume-retry was attempted. Pure so it can be
/// unit-tested.
fn build_error_message(
    stderr: &str,
    exit_code: Option<i32>,
    result_subtype: Option<&str>,
    is_error: bool,
    retried_without_resume: bool,
) -> String {
    let mut msg = {
        let stderr = stderr.trim();
        if !stderr.is_empty() {
            // Prefer the child's own diagnostics verbatim.
            stderr.to_string()
        } else {
            // No stderr: say exactly what we observed instead of the old bare fallback.
            let mut m = match exit_code {
                Some(code) => format!("claude exited (code {code}) with no output"),
                None => "claude exited (killed by signal) with no output".to_string(),
            };
            if let Some(st) = result_subtype {
                m.push_str(&format!("; result subtype '{st}'"));
            } else if is_error {
                m.push_str("; stream reported an error result");
            }
            m
        }
    };
    if retried_without_resume {
        msg.push_str(" — retried without --resume");
    }
    msg
}

/// Drain a child's stderr on its own thread so a full stderr pipe can't deadlock the child.
/// The caller `join`s the returned handle to get the complete text (only needed on failure).
fn drain_stderr(stderr: std::process::ChildStderr) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s);
        s
    })
}

/// Spawn the user's `claude` for ONE turn and register it in the session map under a fresh
/// token, returning the child's stdout/stderr pipes and that token. On a same-id collision the
/// existing in-flight child is superseded (killed + reaped), matching the module's
/// same-id-supersedes rule; its reader will EOF, find a different token, and stay silent.
/// Never logs the built script (it embeds the user's prompt / possible secrets), matching
/// pty.rs's caution.
fn spawn_turn(
    app: &AppHandle,
    id: &str,
    prompt: &str,
    real_cwd: &std::path::Path,
    claude_path: &str,
    resume_session_id: Option<&str>,
) -> Result<(std::process::ChildStdout, std::process::ChildStderr, u64), String> {
    let script = build_claude_exec(claude_path, prompt, resume_session_id);
    tracing::info!(
        id = %id, %claude_path, cwd = %real_cwd.display(),
        resume = resume_session_id.map(|s| !s.is_empty()).unwrap_or(false),
        "claude_chat spawn"
    );

    let mut cmd = Command::new(SHELL);
    cmd.args(["-l", "-c", &script]);
    cmd.current_dir(real_cwd);
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

    let token = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    let superseded = {
        let manager = app.state::<ClaudeChatManager>();
        let mut sessions = lock_sessions(&manager.sessions);
        sessions.insert(id.to_string(), ChatSession { child, token })
    };
    if let Some(mut old) = superseded {
        tracing::info!(id = %id, "claude_chat_send superseded an in-flight turn; killing the old child");
        let _ = old.child.kill();
        let _ = old.child.wait();
    }
    Ok((stdout, stderr, token))
}

/// Run one already-spawned turn to completion on the CURRENT thread: read the child's NDJSON
/// stdout to EOF (emitting `claude_chat:delta` for each text chunk), then — ONLY if the session
/// map still holds OUR token — reap the child and return a structured `TurnOutcome`. When the
/// map no longer holds our token (superseded or cancelled), returns `owned: false` and the
/// caller stays silent. Factored out of `claude_chat_send` so the retry path can call it a
/// second time (for the fresh, no-`--resume` run) without duplicating the parse/reap logic.
fn run_reader(
    app: &AppHandle,
    id: &str,
    token: u64,
    stdout: std::process::ChildStdout,
    stderr_handle: std::thread::JoinHandle<String>,
) -> TurnOutcome {
    let mut reader = BufReader::new(stdout);
    let mut session_id = String::new();
    let mut final_text = String::new();
    let mut acc = String::new();
    let mut result_subtype: Option<String> = None;
    let mut is_error = false;
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
                    handle_event(&ev, &mut session_id, &mut final_text, &mut acc, &mut |txt| {
                        let _ = app.emit(
                            "claude_chat:delta",
                            ChatDelta { id: id.to_string(), text: txt.to_string() },
                        );
                    });
                    // Alongside the parse: note a self-diagnosed failure so a non-zero exit
                    // with empty stderr still yields a specific error message.
                    capture_result_status(&ev, &mut result_subtype, &mut is_error);
                } else {
                    tracing::debug!(id = %id, "claude_chat: skipped non-JSON stdout line");
                }
            }
            Err(_) => break,
        }
    }

    // Reap + decide the outcome — but ONLY if the map still holds OUR turn (token match).
    // If a newer same-id send superseded us, that send already took and reaped our child,
    // and the map now carries its token; if claude_chat_cancel removed us, the entry is
    // gone. In both cases the frontend initiated the teardown, so we stay silent (owned:false)
    // and leave the live turn's entry untouched.
    let child = {
        let manager = app.state::<ClaudeChatManager>();
        let mut sessions = lock_sessions(&manager.sessions);
        match sessions.get(id) {
            Some(s) if s.token == token => sessions.remove(id).map(|s| s.child),
            _ => None,
        }
    };
    let Some(mut child) = child else {
        // Superseded / cancelled: join the stderr drain so its thread isn't leaked, then bow out.
        let _ = stderr_handle.join();
        return TurnOutcome {
            owned: false,
            ok: false,
            exit_code: None,
            session_id,
            text: String::new(),
            stderr: String::new(),
            result_subtype,
            is_error,
        };
    };
    let status = child.wait();
    let ok = matches!(&status, Ok(s) if s.success());
    let exit_code = status.ok().and_then(|s| s.code());
    // Prefer the clean final `result` text; fall back to the accumulated deltas.
    let text = if !final_text.is_empty() { final_text } else { acc };
    let stderr = stderr_handle.join().unwrap_or_default();
    TurnOutcome { owned: true, ok, exit_code, session_id, text, stderr, result_subtype, is_error }
}

/// Emit the terminal event for a decided (owned) turn: `claude_chat:done` on success or
/// `claude_chat:error` on failure, with a specific message. `retried_without_resume` annotates
/// a failure that already fell back to a fresh session.
fn emit_outcome(app: &AppHandle, id: &str, outcome: TurnOutcome, retried_without_resume: bool) {
    if outcome.ok {
        // A successful exit with no text is unusual (e.g. a tool-only turn or a claude
        // stream-format change). It's still a valid `done` — ThinkPanel renders an empty
        // reply gracefully — but log it so a regression isn't an undiagnosable blank.
        if outcome.text.trim().is_empty() {
            tracing::debug!(id = %id, "claude_chat: successful turn produced no assistant text");
        }
        let _ = app.emit(
            "claude_chat:done",
            ChatDone { id: id.to_string(), session_id: outcome.session_id, text: outcome.text },
        );
    } else {
        let message = build_error_message(
            &outcome.stderr,
            outcome.exit_code,
            outcome.result_subtype.as_deref(),
            outcome.is_error,
            retried_without_resume,
        );
        let _ = app.emit("claude_chat:error", ChatError { id: id.to_string(), message });
    }
}

/// Run the user's own headless `claude` for one Think turn. Returns immediately; the child
/// and its stdout reader run on background threads. Streams arrive as Tauri events keyed by
/// `id`: `claude_chat:delta {id, text}` (incremental), `claude_chat:done {id, sessionId,
/// text}` on success, `claude_chat:error {id, message}` on failure / non-zero exit.
///
/// Stale-session self-heal: the #1 real-world cause of a non-zero exit with empty stderr is a
/// stale `--resume <sid>` (a session id no longer in the cwd's history). So when a turn that
/// carried a resume id fails, we RE-RUN the same prompt ONCE more WITHOUT `--resume` (a fresh
/// session) and use that run's outcome. A first turn with no resume id never retries.
///
/// `claude_path` is resolved on the FRONTEND via preflight (`checkClaude`) and passed in, so
/// path resolution stays in one place (preflight.rs). `cwd` is the project root.
/// `async` + `spawn_blocking` (mirroring `create_agent_worktree` in worktree.rs) so the blocking
/// work — cwd canonicalize, the `zsh -l -c 'exec claude …'` spawn, and (critically) the kill+wait
/// of any superseded in-flight child on a same-id re-send — runs OFF the Tauri main thread. Waiting
/// for the old `claude` to die used to freeze the UI on every rapid resend. The manager is reached
/// via `app.state()` inside the closure (the same pattern the reader thread's reap already uses)
/// rather than a `State` param, so no non-`Send` borrow crosses the `.await`.
#[tauri::command]
pub async fn claude_chat_send(
    app: AppHandle,
    id: String,
    prompt: String,
    cwd: String,
    claude_path: String,
    resume_session_id: Option<String>,
) -> Result<(), String> {
    // Defense-in-depth (NOT the primary boundary — that's the WebView CSP, see module docs):
    // require an absolute claude path (no $PATH-relative resolution) and a real cwd directory.
    // (Cheap, no I/O — keep it on the async side so a bad payload fails fast.)
    if claude_path.is_empty() || !std::path::Path::new(&claude_path).is_absolute() {
        return Err("claude_chat_send: claude_path must be a non-empty absolute path".into());
    }
    if cwd.is_empty() {
        return Err("claude_chat_send: cwd must be provided".into());
    }

    // Spawn the first child (and reap any superseded one) off the main thread; hand stdout/stderr,
    // the turn token, and the resolved cwd back so the reader thread (and any retry spawn) can be
    // wired up below. Failing here (bad cwd / spawn error) returns Err to the frontend fast.
    let blk_app = app.clone();
    let blk_id = id.clone();
    let blk_prompt = prompt.clone();
    let blk_claude = claude_path.clone();
    let blk_resume = resume_session_id.clone();
    let (stdout, stderr, token, real_cwd) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(std::process::ChildStdout, std::process::ChildStderr, u64, std::path::PathBuf), String> {
            // Canonicalize so we spawn into the resolved real path (closing a check-vs-use window)
            // and so a bogus cwd fails fast here rather than as an opaque spawn error.
            let real_cwd = std::fs::canonicalize(&cwd)
                .map_err(|e| format!("claude_chat_send: invalid cwd: {e}"))?;
            let (stdout, stderr, token) = spawn_turn(
                &blk_app,
                &blk_id,
                &blk_prompt,
                &real_cwd,
                &blk_claude,
                blk_resume.as_deref(),
            )?;
            Ok((stdout, stderr, token, real_cwd))
        },
    )
    .await
    .map_err(|e| format!("claude_chat_send task failed: {e}"))??;

    // Reader thread: run the first turn to a decided outcome, then — if it failed WITH a resume
    // id — self-heal by re-running once WITHOUT `--resume` and using that outcome instead.
    let read_app = app.clone();
    let read_id = id.clone();
    let read_prompt = prompt.clone();
    let read_claude = claude_path.clone();
    let read_resume = resume_session_id.clone();
    std::thread::spawn(move || {
        let stderr_handle = drain_stderr(stderr);
        let outcome = run_reader(&read_app, &read_id, token, stdout, stderr_handle);
        // Superseded / cancelled mid-turn: the frontend already tore down. Stay silent, no retry.
        if !outcome.owned {
            return;
        }

        if should_retry_without_resume(outcome.ok, read_resume.as_deref()) {
            // Stale `--resume` is the likely culprit. Re-run the same prompt once with a fresh
            // session (no `--resume`) and use THAT outcome. (A stale resume typically fails
            // immediately with no deltas, so the retry streams a clean reply from scratch.)
            tracing::info!(
                id = %read_id,
                "claude_chat_send: turn failed with a resume session id; retrying once without --resume (stale-session self-heal)"
            );
            match spawn_turn(&read_app, &read_id, &read_prompt, &real_cwd, &read_claude, None) {
                Ok((stdout2, stderr2, token2)) => {
                    let stderr_handle2 = drain_stderr(stderr2);
                    let retry = run_reader(&read_app, &read_id, token2, stdout2, stderr_handle2);
                    // Superseded / cancelled during the retry: stay silent like any owned turn.
                    if !retry.owned {
                        return;
                    }
                    emit_outcome(&read_app, &read_id, retry, true);
                }
                Err(e) => {
                    // Couldn't even spawn the retry; surface the original failure, noting the
                    // attempt. Fold the spawn error in only when the first run had no stderr.
                    let mut original = outcome;
                    if original.stderr.trim().is_empty() {
                        original.stderr = e;
                    }
                    emit_outcome(&read_app, &read_id, original, true);
                }
            }
        } else {
            emit_outcome(&read_app, &read_id, outcome, false);
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

    #[test]
    fn capture_result_status_flags_only_non_success_results() {
        // A successful `result` event flags nothing.
        let mut subtype = None;
        let mut is_error = false;
        capture_result_status(&result_event("s", "hi"), &mut subtype, &mut is_error);
        assert_eq!(subtype, None);
        assert!(!is_error);

        // A non-success subtype + is_error are both captured.
        let ev = serde_json::json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true
        });
        let mut subtype = None;
        let mut is_error = false;
        capture_result_status(&ev, &mut subtype, &mut is_error);
        assert_eq!(subtype.as_deref(), Some("error_during_execution"));
        assert!(is_error);

        // A non-`result` event is ignored entirely.
        let mut subtype = None;
        let mut is_error = false;
        capture_result_status(&text_delta_event("x"), &mut subtype, &mut is_error);
        assert_eq!(subtype, None);
        assert!(!is_error);
    }

    #[test]
    fn should_retry_only_on_failure_with_a_resume_id() {
        // Non-zero exit + a real resume id => retry once without --resume.
        assert!(should_retry_without_resume(false, Some("sess-123")));
        // Non-zero exit but NO resume id (a first turn) => never retry.
        assert!(!should_retry_without_resume(false, None));
        // An empty resume id is treated as no resume => never retry.
        assert!(!should_retry_without_resume(false, Some("")));
        // A successful turn never retries, resume id or not.
        assert!(!should_retry_without_resume(true, Some("sess-123")));
        assert!(!should_retry_without_resume(true, None));
    }

    #[test]
    fn error_message_prefers_stderr_then_synthesizes_specifics() {
        // Non-empty stderr is preferred verbatim (trimmed).
        let m = build_error_message("  boom: no conversation found  ", Some(1), None, false, false);
        assert_eq!(m, "boom: no conversation found");

        // Empty stderr => synthesize a specific message from the exit code...
        let m = build_error_message("", Some(7), None, false, false);
        assert_eq!(m, "claude exited (code 7) with no output");

        // ...plus the result subtype when the stream self-diagnosed a failure...
        let m = build_error_message("", Some(1), Some("error_during_execution"), true, false);
        assert!(m.contains("claude exited (code 1) with no output"), "got: {m}");
        assert!(m.contains("result subtype 'error_during_execution'"), "got: {m}");

        // ...and the is_error hint when there's no subtype.
        let m = build_error_message("", Some(1), None, true, false);
        assert!(m.contains("stream reported an error result"), "got: {m}");

        // A missing exit code (killed by signal) is phrased as such.
        let m = build_error_message("", None, None, false, false);
        assert!(m.contains("killed by signal"), "got: {m}");
    }

    #[test]
    fn error_message_appends_retry_note_when_retried() {
        // The retry note is appended for a synthesized message...
        let m = build_error_message("", Some(1), Some("error_during_execution"), false, true);
        assert!(m.contains("claude exited (code 1) with no output"), "got: {m}");
        assert!(m.contains("result subtype 'error_during_execution'"), "got: {m}");
        assert!(m.ends_with("— retried without --resume"), "got: {m}");

        // ...and also when we fell back to preferring stderr.
        let m = build_error_message("boom", Some(1), None, false, true);
        assert_eq!(m, "boom — retried without --resume");
    }
}

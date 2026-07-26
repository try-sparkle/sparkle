//! Headless brain for Concierge Mode (PRD/sparkle/concierge-mode.md §5, bead sparkle-ma6e).
//!
//! The concierge is a long-lived cross-project minder: the frontend (U7) feeds it snapshots of
//! app state — the agent roster, statuses, attention events, terminal prompts — as turn prompts,
//! and it streams back plain-language "what needs you + what I recommend" replies into the
//! concierge thread. Like `claude_chat.rs` / `sparkle_improve.rs`, each turn runs the user's OWN
//! `claude` binary on THEIR machine under THEIR login — Sparkle never reads or stores the auth
//! token; the genuine `claude` binary authenticates itself (the ToS-compliant path, bead
//! ). Continuity across turns comes from `--resume <session_id>`: the frontend keeps
//! the session id from each `concierge:done` and passes it back on the next turn.
//!
//! Permission posture — the brain OBSERVES and RECOMMENDS, it never acts. Two hard properties:
//! an unattended `-p` session must never hang on a permission prompt, and the concierge must
//! never mutate files or run commands un-prompted. Both are satisfied with a READ-ONLY
//! `--allowedTools` allowlist (no Bash, no writes): in `-p` print mode a disallowed tool is
//! refused, not prompted, so the session can't hang. We deliberately do NOT use
//! `--dangerously-skip-permissions` — the concierge's ability to ACT (relaying dispatched
//! answers into terminals) is a separate, user-gated unit (U4, `conciergeDispatch.ts`) that
//! never flows through this process.
//!
//! Process shape — one turn at a time, `sparkle_improve.rs`-style: the child runs in its OWN
//! process group (unix), so cancel/supersede kills `claude` AND anything it spawned; a new turn
//! supersedes an in-flight one (the concierge always answers the LATEST snapshot); the reader
//! thread only reaps/emits under a matching turn token, so a superseded reader stays silent.
//! The cwd is the app-data dir — deliberately NOT a repo worktree: the concierge doesn't own a
//! checkout and must not compete with builder agents for one.
//!
//! Security note (mirrors `claude_chat.rs`): this command launches the user's own `claude` via
//! `/bin/zsh -c '…'`, so by design it runs a shell script the webview hands it; the REAL
//! boundary is the WebView's integrity (strict CSP, no remote origins) plus the read-only
//! allowlist above. Everything user-influenced is `shell_quote`d so it can't escape the quoting.

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::claude_chat::{
    cached_login_shell_path, capture_result_status, handle_event, shell_quote,
};
use crate::preflight::cached_claude_path;

/// Login shell we launch `claude` through — matches `pty.rs` / `claude_chat.rs` /
/// `sparkle_improve.rs` so the launcher can't diverge.
const SHELL: &str = "/bin/zsh";

/// Read-only tool allowlist for the concierge brain: reads + search + web only. No Bash, no
/// writes, no Edit — in `-p` mode a disallowed tool is refused (not prompted), so the session
/// can never hang AND can never mutate anything. Deliberately narrower than the Think tab's
/// list (no Skill/Task): the concierge summarizes state it is HANDED; it doesn't need to spawn
/// subagents or run skills, and the smaller surface is easier to reason about.
const CONCIERGE_ALLOWED_TOOLS: &str = "Read,Grep,Glob,WebFetch,WebSearch,TodoWrite";

/// The concierge's role, appended to Claude Code's system prompt on every turn. Kept as ONE
/// clearly-editable constant so tuning the concierge's voice is a one-line-of-history change.
/// The mission ("observe and recommend, never act") must stay in sync with the read-only
/// allowlist above — the persona states the contract, the allowlist enforces it.
pub(crate) const CONCIERGE_PERSONA: &str = "You are the user's cross-project concierge and \
minder — their eyes, ears, and best friend across everything happening in their projects. Each \
message you receive is a snapshot of live app state: builder agents and their statuses, what \
needs attention, and terminal prompts awaiting a decision. Your job: tell the user plainly what \
needs THEM right now, recommend the single best next action for each item, and stay calm and \
brief — no filler, no alarmism. When nothing needs them, say so in a sentence. You OBSERVE and \
RECOMMEND only — you never take actions yourself; the user dispatches any action through the \
app. Respond in clean GitHub-flavored markdown, tightest-first: lead with what needs the user, \
one short line per item with your recommendation.";

/// Monotonic per-turn token (same guard as `claude_chat::TURN_SEQ`): the reader thread only
/// reaps/emits when the slot STILL carries its own token, so a reader whose turn was superseded
/// or cancelled stays silent instead of clobbering the live turn. Also serves as the `id` on
/// this turn's `concierge:*` events, so the frontend can correlate deltas with their done/error.
static TURN_SEQ: AtomicU64 = AtomicU64::new(1);

/// One in-flight concierge turn: the child (kept for kill/reap) tagged with its turn token.
struct ConciergeTurn {
    child: Child,
    token: u64,
}

/// At most one concierge turn in flight, process-wide (there is exactly one concierge). A new
/// `concierge_turn` supersedes the current one; `concierge_cancel` takes the slot and kills it.
#[derive(Default)]
pub struct ConciergeManager {
    turn: Mutex<Option<ConciergeTurn>>,
}

/// Best-effort cleanup on app teardown: a still-running turn must not outlive the app as a
/// detached process. (On a hard kill this never runs; the child is a read-only `-p` one-shot,
/// so the worst case is a soon-to-exit orphan, not a mutator.)
impl Drop for ConciergeManager {
    fn drop(&mut self) {
        if let Some(mut turn) = lock_turn(&self.turn).take() {
            kill_turn_group(&mut turn.child);
        }
    }
}

/// Lock the turn slot, recovering from poisoning rather than panicking (same rationale as
/// `claude_chat.rs`): a panicked reader must not brick the concierge for the rest of the process.
fn lock_turn(m: &Mutex<Option<ConciergeTurn>>) -> MutexGuard<'_, Option<ConciergeTurn>> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Kill a turn and everything it spawned, then reap it. The child is placed in its own process
/// group at spawn (unix), so signal the GROUP — `claude` may have `WebFetch`/search helpers in
/// flight — with a direct `kill()` as the non-unix / group-signal-failed fallback. (Local copy
/// of `sparkle_improve.rs`'s `kill_pass_group`; that one is private to its module.)
fn kill_turn_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        // Negative pid = the whole process group (set via process_group(0) at spawn).
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Clone, Serialize)]
struct ConciergeDelta {
    id: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConciergeDone {
    id: String,
    session_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct ConciergeError {
    id: String,
    detail: String,
}

/// Build the `exec …` script handed to `zsh -c` (with the cached login PATH injected by the
/// caller). Mirrors `claude_chat::build_claude_exec`: everything user-influenced is
/// single-quoted via `shell_quote`; `--model` is intentionally OMITTED so the session inherits
/// the user's configured Claude Code model; `--resume` continues the concierge's one ongoing
/// session when the frontend passes the id back.
fn build_concierge_exec(claude_path: &str, prompt: &str, resume_session_id: Option<&str>) -> String {
    let mut cmd = format!("exec {}", shell_quote(claude_path));
    cmd.push_str(" -p ");
    cmd.push_str(&shell_quote(prompt));
    cmd.push_str(" --output-format stream-json --verbose --include-partial-messages");
    cmd.push_str(" --append-system-prompt ");
    cmd.push_str(&shell_quote(CONCIERGE_PERSONA));
    cmd.push_str(" --allowedTools ");
    cmd.push_str(&shell_quote(CONCIERGE_ALLOWED_TOOLS));
    if let Some(sid) = resume_session_id {
        if !sid.is_empty() {
            cmd.push_str(" --resume ");
            cmd.push_str(&shell_quote(sid));
        }
    }
    format!("export PATH=\"$HOME/.local/bin:$PATH\"; {cmd}")
}

/// Decide whether a FAILED turn should be retried once WITHOUT `--resume` (same self-heal as
/// `claude_chat.rs`): a stale `--resume <sid>` is the #1 real-world cause of a non-zero exit
/// with empty stderr, and the concierge resumes on EVERY turn after the first. Pure for tests.
fn should_retry_without_resume(ok: bool, resume_session_id: Option<&str>) -> bool {
    !ok && matches!(resume_session_id, Some(sid) if !sid.is_empty())
}

/// Build the `concierge:error` detail for a failed turn. Same priority order as
/// `claude_chat::build_error_message` / `sparkle_improve::failure_message` (both private to
/// their modules), so a failure reads the same wherever it surfaces:
///  1. the child's own stderr when non-empty;
///  2. claude's OWN error text lifted off the failed `result` event by `capture_result_status`
///     (a stale resume, a usage limit, an auth/API error, …);
///  3. a synthesized phrase from the exit code + any non-`"success"` subtype / `is_error` flag.
/// Pure so the precedence is unit-testable without spawning a real turn.
fn failure_detail(
    stderr: &str,
    exit_code: Option<i32>,
    result_subtype: Option<&str>,
    is_error: bool,
    error_detail: Option<&str>,
) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    if let Some(detail) = error_detail.map(str::trim).filter(|s| !s.is_empty()) {
        return detail.to_string();
    }
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

/// Structured outcome of ONE headless `claude` run (stdout read to EOF, child reaped). `owned`
/// is false when the slot no longer held our token by EOF (superseded or cancelled): the
/// teardown was initiated elsewhere, so the caller must stay silent and not retry.
struct TurnOutcome {
    owned: bool,
    ok: bool,
    exit_code: Option<i32>,
    session_id: String,
    text: String,
    stderr: String,
    result_subtype: Option<String>,
    is_error: bool,
    error_detail: Option<String>,
}

/// Spawn one concierge `claude` child and install it in the singleton slot under a fresh token,
/// superseding (killing, whole group) any in-flight turn — the concierge always answers the
/// LATEST snapshot; a reply to a stale one is noise. Returns the child's pipes + token. Never
/// logs the built script (it embeds the prompt, which carries app state).
fn spawn_turn(
    app: &AppHandle,
    prompt: &str,
    cwd: &std::path::Path,
    claude_path: &str,
    resume_session_id: Option<&str>,
) -> Result<(std::process::ChildStdout, std::process::ChildStderr, u64), String> {
    let script = build_concierge_exec(claude_path, prompt, resume_session_id);
    tracing::info!(
        %claude_path, cwd = %cwd.display(),
        resume = resume_session_id.map(|s| !s.is_empty()).unwrap_or(false),
        "concierge_turn spawn"
    );

    let mut cmd = Command::new(SHELL);
    // NON-login shell: the login PATH is resolved once and injected (see
    // `cached_login_shell_path`), so no per-turn dotfile-sourcing latency.
    cmd.args(["-c", &script]);
    cmd.env("PATH", cached_login_shell_path());
    cmd.current_dir(cwd);
    // No stdin: `-p` is one-shot, and a null stdin guarantees nothing can block on input.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Own process group, so cancel/supersede can take out claude AND its children in one signal.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("concierge_turn: spawn failed: {e}"))?;
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            // Never expected with Stdio::piped(), but the just-spawned child must not be left
            // running with no cancel handle.
            kill_turn_group(&mut child);
            return Err("concierge_turn: child has no stdout".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            kill_turn_group(&mut child);
            return Err("concierge_turn: child has no stderr".into());
        }
    };

    let token = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    let superseded = {
        let manager = app.state::<ConciergeManager>();
        let mut slot = lock_turn(&manager.turn);
        slot.replace(ConciergeTurn { child, token })
    };
    if let Some(mut old) = superseded {
        tracing::info!("concierge_turn superseded an in-flight turn; killing the old child (group)");
        kill_turn_group(&mut old.child);
    }
    Ok((stdout, stderr, token))
}

/// Drain a child's stderr on its own thread so a full stderr pipe can't deadlock the child.
fn drain_stderr(stderr: std::process::ChildStderr) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut s = String::new();
        use std::io::Read;
        let _ = std::io::BufReader::new(stderr).read_to_string(&mut s);
        s
    })
}

/// Run one already-spawned turn to completion on the CURRENT thread: parse the NDJSON stdout to
/// EOF (emitting `concierge:delta` per text chunk via the shared `handle_event` parser), then —
/// ONLY if the slot still holds OUR token — reap the child and return the outcome. Factored out
/// of `concierge_turn` so the stale-resume retry can run it a second time.
fn run_reader(
    app: &AppHandle,
    id: &str,
    token: u64,
    stdout: std::process::ChildStdout,
    stderr_handle: std::thread::JoinHandle<String>,
) -> TurnOutcome {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(stdout);
    let mut session_id = String::new();
    let mut final_text = String::new();
    let mut acc = String::new();
    let mut result_subtype: Option<String> = None;
    let mut is_error = false;
    let mut error_detail: Option<String> = None;
    let mut line: Vec<u8> = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(ev) = serde_json::from_str::<Value>(trimmed) {
                    handle_event(&ev, &mut session_id, &mut final_text, &mut acc, &mut |txt| {
                        let _ = app.emit(
                            "concierge:delta",
                            ConciergeDelta { id: id.to_string(), text: txt.to_string() },
                        );
                    });
                    capture_result_status(&ev, &mut result_subtype, &mut is_error, &mut error_detail);
                } else {
                    tracing::debug!("concierge: skipped non-JSON stdout line");
                }
            }
            Err(_) => break,
        }
    }

    // Reap — but only if the slot still holds OUR turn (token match). A cancel or a newer turn
    // took the slot first (and killed/reaped the child); the frontend initiated that teardown,
    // so we stay silent and leave the live turn's entry untouched.
    let child = {
        let manager = app.state::<ConciergeManager>();
        let mut slot = lock_turn(&manager.turn);
        match slot.as_ref() {
            Some(t) if t.token == token => slot.take().map(|t| t.child),
            _ => None,
        }
    };
    let Some(mut child) = child else {
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
            error_detail,
        };
    };
    let status = child.wait();
    let ok = matches!(&status, Ok(s) if s.success());
    let exit_code = status.ok().and_then(|s| s.code());
    // Prefer the clean final `result` text; fall back to the accumulated deltas.
    let text = if !final_text.is_empty() { final_text } else { acc };
    let stderr = stderr_handle.join().unwrap_or_default();
    TurnOutcome {
        owned: true,
        ok,
        exit_code,
        session_id,
        text,
        stderr,
        result_subtype,
        is_error,
        error_detail,
    }
}

/// Emit the terminal event for a decided (owned) turn: `concierge:done` on success or
/// `concierge:error` (with a specific detail) on failure.
fn emit_outcome(app: &AppHandle, id: &str, outcome: TurnOutcome) {
    if outcome.ok {
        if outcome.text.trim().is_empty() {
            tracing::debug!(id = %id, "concierge: successful turn produced no assistant text");
        }
        let _ = app.emit(
            "concierge:done",
            ConciergeDone { id: id.to_string(), session_id: outcome.session_id, text: outcome.text },
        );
    } else {
        let detail = failure_detail(
            &outcome.stderr,
            outcome.exit_code,
            outcome.result_subtype.as_deref(),
            outcome.is_error,
            outcome.error_detail.as_deref(),
        );
        // The detail is claude's error reason / exit code — no prompt, no secret — safe to log
        // (the built script, which embeds the prompt, is never logged).
        tracing::warn!(id = %id, exit_code = ?outcome.exit_code, "concierge turn failed: {detail}");
        let _ = app.emit("concierge:error", ConciergeError { id: id.to_string(), detail });
    }
}

/// Run one concierge turn: the user's own headless `claude` over the snapshot in `prompt`,
/// continuing the concierge session when `resume_session_id` is passed. Returns immediately;
/// the child and its reader run on background threads. Streams arrive as Tauri events keyed by
/// the turn's `id` (the monotonic turn token as a string): `concierge:delta { id, text }`,
/// `concierge:done { id, sessionId, text }` on success (keep `sessionId` and pass it back as
/// `resume_session_id` next turn), `concierge:error { id, detail }` on failure.
///
/// A new turn SUPERSEDES an in-flight one (killed, whole group) — the concierge always answers
/// the latest snapshot. Stale-session self-heal: a failed turn that carried a resume id is
/// re-run ONCE without `--resume` (fresh session), mirroring `claude_chat_send`.
///
/// `async` + `spawn_blocking` (same as `claude_chat_send`): the spawn and — critically — the
/// kill+wait of a superseded child run OFF the Tauri main thread, so a rapid re-send can't
/// freeze the UI.
#[tauri::command]
pub async fn concierge_turn(
    app: AppHandle,
    prompt: String,
    resume_session_id: Option<String>,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("concierge_turn: prompt must be non-empty".into());
    }
    let claude_path = cached_claude_path()
        .ok_or_else(|| "concierge_turn: claude binary not found (is Claude Code installed?)".to_string())?;
    // The concierge runs in the app-data dir — NOT a repo worktree (it observes; it doesn't own
    // a checkout). The dir is created by the app at startup, but ensure it exists so a fresh
    // install can't fail the spawn on a missing cwd.
    let cwd = crate::dev_identity::app_data_dir(&app).map_err(|e| format!("concierge_turn: {e}"))?;
    std::fs::create_dir_all(&cwd).map_err(|e| format!("concierge_turn: app data dir unavailable: {e}"))?;

    let blk_app = app.clone();
    let blk_prompt = prompt.clone();
    let blk_resume = resume_session_id.clone();
    let blk_cwd = cwd.clone();
    let blk_claude = claude_path.clone();
    let (stdout, stderr, token) = tauri::async_runtime::spawn_blocking(move || {
        spawn_turn(&blk_app, &blk_prompt, &blk_cwd, &blk_claude, blk_resume.as_deref())
    })
    .await
    .map_err(|e| format!("concierge_turn task failed: {e}"))??;

    let read_app = app.clone();
    std::thread::spawn(move || {
        let id = token.to_string();
        let stderr_handle = drain_stderr(stderr);
        let outcome = run_reader(&read_app, &id, token, stdout, stderr_handle);
        // Superseded / cancelled mid-turn: the frontend already tore down. Stay silent, no retry.
        if !outcome.owned {
            return;
        }

        if should_retry_without_resume(outcome.ok, resume_session_id.as_deref()) {
            tracing::info!(
                id = %id,
                "concierge_turn: turn failed with a resume session id; retrying once without --resume"
            );
            match spawn_turn(&read_app, &prompt, &cwd, &claude_path, None) {
                Ok((stdout2, stderr2, token2)) => {
                    let stderr_handle2 = drain_stderr(stderr2);
                    // Emit the retry under the ORIGINAL `id`: the self-heal is a transparent
                    // continuation of the same logical turn, so the original id always receives a
                    // terminal event (no bubble left permanently in-progress if the first run
                    // streamed a delta before failing), and the `done` carries the full final text.
                    // Ownership still uses the retry's own token2 for the slot check.
                    let retry = run_reader(&read_app, &id, token2, stdout2, stderr_handle2);
                    if !retry.owned {
                        return;
                    }
                    emit_outcome(&read_app, &id, retry);
                }
                Err(e) => {
                    // Couldn't even spawn the retry; surface the original failure, folding the
                    // spawn error in only when the first run gave us nothing better to show.
                    let mut original = outcome;
                    if original.stderr.trim().is_empty() && original.error_detail.is_none() {
                        original.stderr = e;
                    }
                    emit_outcome(&read_app, &id, original);
                }
            }
        } else {
            emit_outcome(&read_app, &id, outcome);
        }
    });

    Ok(())
}

/// Cancel the in-flight concierge turn — the whole process group, so nothing it spawned keeps
/// running. A no-op if none is in flight. The reader thread finds the slot token changed (entry
/// gone) on EOF and stays silent, so no late done/error races the cancel.
#[tauri::command]
pub fn concierge_cancel(manager: State<ConciergeManager>) -> Result<(), String> {
    let turn = lock_turn(&manager.turn).take();
    if let Some(mut turn) = turn {
        tracing::info!("concierge_cancel: killing in-flight turn (group)");
        kill_turn_group(&mut turn.child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_exec_is_readonly_and_streamed() {
        let script = build_concierge_exec("/usr/local/bin/claude", "snapshot", None);
        assert!(script.contains("export PATH=\"$HOME/.local/bin:$PATH\";"));
        assert!(script.contains("exec '/usr/local/bin/claude'"));
        assert!(script.contains("-p 'snapshot'"));
        assert!(script.contains("--output-format stream-json --verbose --include-partial-messages"));
        // The persona rides along on every turn.
        assert!(script.contains("--append-system-prompt "));
        assert!(script.contains("cross-project concierge"));
        // Observe-only posture: the read-only allowlist is present, permission-skip is ABSENT,
        // and no mutating tool sneaks onto the list.
        assert!(script.contains("--allowedTools 'Read,Grep,Glob,WebFetch,WebSearch,TodoWrite'"));
        assert!(!script.contains("--dangerously-skip-permissions"));
        for tool in ["Bash", "Edit", "Write", "NotebookEdit"] {
            assert!(
                !CONCIERGE_ALLOWED_TOOLS.split(',').any(|t| t == tool),
                "mutating tool {tool} must not be allowlisted"
            );
        }
        // Inherit the user's configured model; fresh session when no resume id.
        assert!(!script.contains("--model"));
        assert!(!script.contains("--resume"));
    }

    #[test]
    fn build_exec_appends_resume_when_session_id_present() {
        let script = build_concierge_exec("/bin/claude", "hi", Some("sess-42"));
        assert!(script.contains("--resume 'sess-42'"));
        // An empty session id is treated as no resume (fresh turn).
        let none = build_concierge_exec("/bin/claude", "hi", Some(""));
        assert!(!none.contains("--resume"));
    }

    #[test]
    fn build_exec_quotes_a_hostile_prompt() {
        // A snapshot that tries to close the quote and inject a command stays a single quoted
        // argument — the injected text can't escape into the shell.
        let script = build_concierge_exec("/bin/claude", "'; rm -rf /; echo '", None);
        assert!(script.contains(r"-p ''\''; rm -rf /; echo '\'''"));
    }

    #[test]
    fn persona_states_the_observe_only_contract() {
        // The persona is the contract the allowlist enforces — if someone edits it into an
        // "act on my behalf" prompt, this is the tripwire that says the allowlist (and U4's
        // dispatch gate) must be revisited too.
        assert!(CONCIERGE_PERSONA.contains("never take actions yourself"));
        assert!(CONCIERGE_PERSONA.contains("OBSERVE and RECOMMEND"));
    }

    #[test]
    fn should_retry_only_on_failure_with_a_resume_id() {
        assert!(should_retry_without_resume(false, Some("sess-42")));
        assert!(!should_retry_without_resume(false, None));
        assert!(!should_retry_without_resume(false, Some("")));
        assert!(!should_retry_without_resume(true, Some("sess-42")));
    }

    #[test]
    fn failure_detail_prefers_stderr_then_claude_detail_then_synthesizes() {
        // Non-empty stderr wins verbatim (trimmed), even over claude's detail.
        let m = failure_detail("  boom  ", Some(1), None, true, Some("detail"));
        assert_eq!(m, "boom");

        // Empty stderr + claude's own reason => surface the reason.
        let m = failure_detail("", Some(1), None, true, Some("Claude usage limit reached"));
        assert_eq!(m, "Claude usage limit reached");

        // Nothing to quote => synthesize from the exit code + subtype…
        let m = failure_detail("", Some(1), Some("error_max_turns"), true, None);
        assert!(m.contains("claude exited (code 1) with no output"), "got: {m}");
        assert!(m.contains("result subtype 'error_max_turns'"), "got: {m}");

        // …or the is_error hint, and phrase a signal kill as such.
        let m = failure_detail("", None, None, true, None);
        assert!(m.contains("killed by signal"), "got: {m}");
        assert!(m.contains("stream reported an error result"), "got: {m}");

        // A blank detail is ignored — fall through to the synthesized message.
        let m = failure_detail("", Some(1), None, false, Some("   "));
        assert_eq!(m, "claude exited (code 1) with no output");
    }

    /// The shared parser (`claude_chat::handle_event`) drives this module's delta emission and
    /// session capture; assert the wiring assumptions hold for the event shapes the concierge
    /// reader feeds it (init → deltas → result), including the failed-result path feeding
    /// `failure_detail`.
    #[test]
    fn reader_seam_captures_session_deltas_and_failure_reason() {
        let mut session_id = String::new();
        let mut final_text = String::new();
        let mut acc = String::new();
        let mut deltas: Vec<String> = Vec::new();
        let events = [
            serde_json::json!({ "type": "system", "subtype": "init", "session_id": "sess-C" }),
            serde_json::json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "All quiet." } }
            }),
            serde_json::json!({ "type": "result", "subtype": "success", "session_id": "sess-C", "result": "All quiet." }),
        ];
        for ev in &events {
            handle_event(ev, &mut session_id, &mut final_text, &mut acc, &mut |t| {
                deltas.push(t.to_string());
            });
        }
        assert_eq!(session_id, "sess-C");
        assert_eq!(deltas, vec!["All quiet."]);
        assert_eq!(final_text, "All quiet.");

        // A failed result's own error text reaches the emitted detail, not a generic fallback.
        let ev = serde_json::json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "errors": ["Error: --resume requires a valid session ID or session title."],
        });
        let (mut subtype, mut is_error, mut detail) = (None, false, None);
        capture_result_status(&ev, &mut subtype, &mut is_error, &mut detail);
        let m = failure_detail("", Some(1), subtype.as_deref(), is_error, detail.as_deref());
        assert_eq!(m, "Error: --resume requires a valid session ID or session title.");
    }
}

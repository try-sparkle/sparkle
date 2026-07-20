//! Headless runner for the Sparkle self-improvement agent's HOURLY pass (bead sparkle-4xwk.2).
//!
//! This is what makes the consent banner's first bullet true: "Once per hour, we use a small
//! amount of your Claude Code subscription to evaluate your logs." The frontend scheduler
//! (`useImprovementScheduler` → `services/improvementPass.ts`) decides WHEN a pass is due and
//! builds the persona + mission prompt (both consent-mode aware, see `sparkleAgent.ts`); this
//! command just runs the user's own `claude -p` headlessly in the agent's app-owned worktree
//! and reports the outcome as Tauri events.
//!
//! Like `claude_chat.rs` this runs the user's OWN `claude` binary under THEIR login — Sparkle
//! never touches the auth token (the ToS-compliant path, bead ). Unlike the Think
//! engine, the pass MUST be able to edit code, commit, and run `gh`, and it runs unattended —
//! so it launches with `--dangerously-skip-permissions`, the exact posture Sparkle's WORKER
//! agents already use (see `claudeSpawn.ts`): a permission prompt in an unattended `-p` session
//! is a silent deadlock. Fences bounding that power:
//!  - the cwd is REQUIRED to be a directory STRICTLY inside the app's managed worktrees dir
//!    (the same containment check as `pty.rs::validate_spawn`) — i.e. the app-owned clone of
//!    the OSS Sparkle repo, never the user's project — and `log_dir` must be a real directory;
//!  - at most ONE pass runs at a time (the manager slot), a pass that outlives
//!    `STALE_PASS_MAX` is killed and its slot reclaimed by the next run attempt (a hung child
//!    must not wedge the hourly loop forever — the TS side carries a matching client timeout),
//!    and the frontend additionally skips a pass while the interactive pane session is live;
//!  - the child runs in its OWN process group (unix), and kill/cancel signals the whole group —
//!    claude routinely spawns `git`/`gh`/test children, and an orphaned mutator left running in
//!    the worktree would defeat the one-claude-per-worktree rule cancel exists to keep;
//!  - what the agent may DO with its output is governed by the consent-mode persona + the
//!    `scripts/sparkle-scrub.sh` PII gate (Unit A, bead sparkle-4xwk.1).
//!
//! As everywhere in this app, the REAL security boundary is the WebView's integrity (strict
//! CSP, no remote origins) — these checks stop obvious misuse and bugs, not a compromised
//! webview (see the `pty.rs` module docs).

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::claude_chat::{handle_event, shell_quote};

/// Login shell, as `zsh -l -c 'exec …'` — matches `pty.rs` / `claude_chat.rs` / `claudeSpawn.ts`.
const SHELL: &str = "/bin/zsh";

/// A pass older than this is presumed hung (network stall, wedged subprocess) and is killed +
/// reclaimed by the next `sparkle_improve_run`. Generous: a legitimate pass — review logs,
/// implement one small change, draft/submit a PR — finishes well inside it. MUST strictly
/// exceed `PASS_TIMEOUT_MS` in `services/improvementPass.ts` (the client-side timeout that
/// owns the normal path — it cancels at 30 min); this reclaim is only the backstop for a
/// reloaded webview whose latch was lost, and the margin keeps the two from racing at the
/// boundary (roborev #24984).
const STALE_PASS_MAX: Duration = Duration::from_secs(35 * 60);

/// Monotonic per-pass token (same guard as `claude_chat::TURN_SEQ`): the reader thread only
/// reaps/emits when the slot STILL carries its own token, so a stale reader that EOFs after
/// its pass was killed-and-replaced (stale reclaim below) can't take the live pass's child.
static PASS_SEQ: AtomicU64 = AtomicU64::new(1);

/// One in-flight pass: the child (kept for kill/reap), its start time (stale detection), and
/// its token (reader/slot matching).
struct RunningPass {
    child: Child,
    started: Instant,
    token: u64,
}

/// At most one improvement pass in flight, process-wide. `sparkle_improve_cancel` and the
/// stale reclaim `take()` the slot (whoever takes the pass kills/reaps it); the reader thread
/// takes it on EOF only under a matching token.
#[derive(Default)]
pub struct SparkleImproveManager {
    pass: Mutex<Option<RunningPass>>,
}

/// Best-effort cleanup on app teardown: a still-running pass must not outlive the app as a
/// detached `--dangerously-skip-permissions` process holding the agent worktree. (On a hard
/// kill this never runs — the stale reclaim covers the next launch.)
impl Drop for SparkleImproveManager {
    fn drop(&mut self) {
        if let Some(mut pass) = lock_pass(&self.pass).take() {
            kill_pass_group(&mut pass.child);
        }
    }
}

fn lock_pass(m: &Mutex<Option<RunningPass>>) -> MutexGuard<'_, Option<RunningPass>> {
    // Recover from poisoning rather than panicking (same rationale as claude_chat.rs): a
    // panicked reader must not brick the hourly pass for the rest of the process.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Kill a pass and everything it spawned, then reap it. The child was placed in its own
/// process group at spawn (unix), so signal the GROUP — `Child::kill` alone would SIGKILL only
/// `claude` and orphan its `git`/`gh`/test children mid-mutation in the agent worktree. The
/// direct `kill()` afterwards is the fallback for the (never-expected) case the group signal
/// failed, and the non-unix path.
fn kill_pass_group(child: &mut Child) {
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
#[serde(rename_all = "camelCase")]
struct ImproveDone {
    session_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct ImproveError {
    message: String,
}

/// Build the `exec …` script handed to `zsh -l -c`. Everything user-influenced is
/// single-quoted via `shell_quote`, so prompt/persona/paths can't escape into the shell.
/// `--model` is intentionally omitted (inherit the user's configured model), and there is
/// no `--resume`: each hourly pass starts FRESH — the persona + mission carry all needed
/// context, and the interactive pane resumes the pass's session afterwards anyway (it picks
/// the worktree's most recent session), which is how a case-by-case draft reaches the user.
fn build_improve_exec(claude_path: &str, prompt: &str, persona: &str, log_dir: &str) -> String {
    let mut cmd = format!("exec {}", shell_quote(claude_path));
    cmd.push_str(" -p ");
    cmd.push_str(&shell_quote(prompt));
    cmd.push_str(" --output-format stream-json --verbose");
    cmd.push_str(" --append-system-prompt ");
    cmd.push_str(&shell_quote(persona));
    cmd.push_str(" --add-dir ");
    cmd.push_str(&shell_quote(log_dir));
    // Unattended pass: see the module docs for why this is required and how it is fenced.
    cmd.push_str(" --dangerously-skip-permissions");
    format!("export PATH=\"$HOME/.local/bin:$PATH\"; {cmd}")
}

/// Pure containment check (mirrors `pty.rs::validate_spawn_inner`): `claude_path` must be a
/// non-empty absolute path; `cwd` must canonicalize to a DIRECTORY strictly inside the managed
/// worktrees dir (the base itself doesn't count — a pass belongs in a specific worktree); and
/// `log_dir` — handed to `--add-dir` as an extra read grant — must be a non-empty absolute
/// path to a real directory. Returns the canonicalized cwd so the caller spawns into the
/// validated path (closing the check-vs-use window).
fn validate_run_inner(
    worktrees_base: &Path,
    claude_path: &str,
    cwd: &str,
    log_dir: &str,
) -> Result<std::path::PathBuf, String> {
    if claude_path.is_empty() || !Path::new(claude_path).is_absolute() {
        return Err("sparkle_improve_run: claude_path must be a non-empty absolute path".into());
    }
    if log_dir.is_empty() || !Path::new(log_dir).is_absolute() || !Path::new(log_dir).is_dir() {
        return Err(
            "sparkle_improve_run: log_dir must be an absolute path to an existing directory"
                .into(),
        );
    }
    let base = worktrees_base
        .canonicalize()
        .map_err(|e| format!("sparkle_improve_run: worktrees dir unavailable: {e}"))?;
    let real = std::fs::canonicalize(cwd)
        .map_err(|e| format!("sparkle_improve_run: invalid cwd: {e}"))?;
    if !real.is_dir() {
        return Err("sparkle_improve_run: cwd is not a directory".into());
    }
    if !real.starts_with(&base) || real == base {
        return Err("sparkle_improve_run: cwd is outside the managed worktrees directory".into());
    }
    Ok(real)
}

/// Run ONE hourly improvement pass headlessly. Returns immediately; the outcome arrives as a
/// Tauri event: `sparkle_improve:done { sessionId, text }` on a clean exit (text is the final
/// assistant message — the frontend parses its trailing `IMPROVE_RESULT:` marker), or
/// `sparkle_improve:error { message }` on spawn failure / non-zero exit. Errors immediately if
/// a pass is already in flight — unless that pass is older than `STALE_PASS_MAX`, in which
/// case it is presumed hung, killed (whole group), and its slot reclaimed for this run.
#[tauri::command]
pub fn sparkle_improve_run(
    app: AppHandle,
    manager: State<SparkleImproveManager>,
    cwd: String,
    claude_path: String,
    persona: String,
    prompt: String,
    log_dir: String,
) -> Result<(), String> {
    let worktrees = crate::dev_identity::app_data_dir(&app)
        .map_err(|e| format!("sparkle_improve_run: {e}"))?
        .join("worktrees");
    let real_cwd = validate_run_inner(&worktrees, &claude_path, &cwd, &log_dir)?;

    let script = build_improve_exec(&claude_path, &prompt, &persona, &log_dir);
    // Log paths only — the script embeds the persona/prompt (which reference the log dir and
    // could quote user-visible strings), matching the "args may contain prompt text" caution.
    tracing::info!(%claude_path, cwd = %real_cwd.display(), "sparkle_improve_run: starting hourly pass");

    let mut cmd = Command::new(SHELL);
    cmd.args(["-l", "-c", &script]);
    cmd.current_dir(&real_cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Own process group, so kill/cancel can take out claude AND its spawned children (git, gh,
    // tests) in one signal — see kill_pass_group.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // Claim the singleton slot BEFORE spawning so two racing invokes can't both launch.
    {
        let mut slot = lock_pass(&manager.pass);
        if let Some(prior) = slot.as_ref() {
            if prior.started.elapsed() < STALE_PASS_MAX {
                return Err("sparkle_improve_run: a pass is already running".into());
            }
            // Stale: presume hung and reclaim. Once we take the slot, the stale reader EOFs,
            // fails its token match, and stays silent. Deliberately NO error event here: on
            // this path the stale pass's webview listeners are gone (reload lost the latch),
            // so an emit would land on the fresh run's just-registered listeners and falsely
            // fail it (roborev #24983/#24984). The log line is the record. NOTE this silence
            // guarantee covers the reclaim only — a stale pass that finishes NATURALLY before
            // we take the slot still token-matches and emits, a milliseconds-wide untagged-
            // event race accepted as-is (roborev #25141); don't add an emit back here, and if
            // that race ever matters, the fix is token-tagging the done/error payloads.
            tracing::warn!("sparkle_improve_run: reclaiming a stale pass (older than {STALE_PASS_MAX:?})");
            if let Some(mut stale) = slot.take() {
                kill_pass_group(&mut stale.child);
            }
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("sparkle_improve_run: spawn failed: {e}"))?;
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                // Never expected with Stdio::piped(), but if it happens the just-spawned
                // unattended child must not be left running with no cancel handle.
                kill_pass_group(&mut child);
                return Err("sparkle_improve_run: child has no stdout".into());
            }
        };
        let stderr = match child.stderr.take() {
            Some(s) => s,
            None => {
                kill_pass_group(&mut child);
                return Err("sparkle_improve_run: child has no stderr".into());
            }
        };
        let token = PASS_SEQ.fetch_add(1, Ordering::Relaxed);
        *slot = Some(RunningPass { child, started: Instant::now(), token });

        // Drain stderr on its own thread so a full pipe can't deadlock the child.
        let stderr_handle = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut s);
            s
        });

        let read_app = app.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut session_id = String::new();
            let mut final_text = String::new();
            let mut acc = String::new();
            let mut line: Vec<u8> = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&line);
                        let trimmed = text.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Ok(ev) = serde_json::from_str::<Value>(trimmed) {
                            // No delta consumer for the hourly pass — the closure only feeds
                            // `acc`, the fallback if the stream ends without a `result` event.
                            handle_event(&ev, &mut session_id, &mut final_text, &mut acc, &mut |_| {});
                        } else {
                            tracing::debug!("sparkle_improve: skipped non-JSON stdout line");
                        }
                    }
                    Err(_) => break,
                }
            }

            // Reap — but only if the slot still holds OUR pass (token match). A cancel or a
            // stale reclaim takes the pass first (and kills/reaps it); in both cases the
            // teardown was initiated elsewhere, so we stay silent and leave the slot alone.
            let child = {
                let manager = read_app.state::<SparkleImproveManager>();
                let mut slot = lock_pass(&manager.pass);
                match slot.as_ref() {
                    Some(p) if p.token == token => slot.take().map(|p| p.child),
                    _ => None,
                }
            };
            let Some(mut child) = child else { return };
            let wait_result = child.wait();
            let ok = matches!(wait_result, Ok(ref status) if status.success());
            let text = if !final_text.is_empty() { final_text } else { acc };

            if ok {
                tracing::info!(chars = text.len(), "sparkle_improve: pass finished");
                let _ = read_app.emit("sparkle_improve:done", ImproveDone { session_id, text });
            } else {
                let stderr_text = stderr_handle.join().unwrap_or_default();
                // When the child dies with NO stderr, the bare "exited without a successful
                // result" line left the recurring hourly-pass failures undiagnosable. Append the
                // exit status (code, or on unix the terminating signal) so an ordinary error exit
                // is distinguishable from an OOM/SIGKILL or a SIGTERM reap. It's just an integer —
                // no user data.
                let message = if !stderr_text.trim().is_empty() {
                    stderr_text.trim().to_string()
                } else {
                    format!(
                        "claude exited without a successful result ({})",
                        describe_exit_status(&wait_result)
                    )
                };
                tracing::warn!(%message, "sparkle_improve: pass failed");
                let _ = read_app.emit("sparkle_improve:error", ImproveError { message });
            }
        });
    }

    Ok(())
}

/// Kill an in-flight hourly pass — the whole process group, so nothing it spawned keeps
/// mutating the worktree. A no-op if none is running. Called by the frontend when the user
/// opens the interactive pane (so two `claude` processes never share the agent worktree) and
/// by the client-side pass timeout — the reader thread finds the slot token changed (entry
/// gone) on EOF and stays silent.
#[tauri::command]
pub fn sparkle_improve_cancel(manager: State<SparkleImproveManager>) -> Result<(), String> {
    let pass = lock_pass(&manager.pass).take();
    if let Some(mut pass) = pass {
        tracing::info!("sparkle_improve_cancel: killing in-flight pass (group)");
        kill_pass_group(&mut pass.child);
    }
    Ok(())
}

/// Render a failed child's exit status into a compact, PII-free phrase for the failure
/// message. The hourly pass's `claude` child frequently dies with EMPTY stderr, which left the
/// "pass failed" WARN with no clue why; the exit code — or, on unix, the terminating signal —
/// distinguishes an ordinary error exit from an OOM/SIGKILL (137) or a SIGTERM (143) reap, which
/// is exactly what triage of a recurring failure needs. It carries no user data, just an integer.
fn describe_exit_status(status: &std::io::Result<std::process::ExitStatus>) -> String {
    match status {
        Ok(s) => {
            if let Some(code) = s.code() {
                return format!("exit code {code}");
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(sig) = s.signal() {
                    return format!("killed by signal {sig}");
                }
            }
            "terminated abnormally".to_string()
        }
        Err(e) => format!("could not reap the process: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp base dir with a real worktree-ish child dir inside it, for validation tests.
    fn test_base(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("sparkle-improve-test-{name}"));
        let inside = base.join("wt");
        std::fs::create_dir_all(&inside).unwrap();
        (base, inside)
    }

    #[test]
    fn build_exec_is_unattended_and_scoped() {
        let script = build_improve_exec(
            "/usr/local/bin/claude",
            "hourly pass",
            "persona text",
            "/logs/dir",
        );
        assert!(script.contains("export PATH=\"$HOME/.local/bin:$PATH\";"));
        assert!(script.contains("exec '/usr/local/bin/claude'"));
        assert!(script.contains("-p 'hourly pass'"));
        assert!(script.contains("--output-format stream-json --verbose"));
        assert!(script.contains("--append-system-prompt 'persona text'"));
        assert!(script.contains("--add-dir '/logs/dir'"));
        // Unattended: auto-approve is REQUIRED here (fenced by worktree containment) …
        assert!(script.contains("--dangerously-skip-permissions"));
        // … but the model is inherited and each pass starts fresh.
        assert!(!script.contains("--model"));
        assert!(!script.contains("--resume"));
    }

    #[test]
    fn build_exec_quotes_hostile_values() {
        let script = build_improve_exec("/bin/claude", "'; rm -rf /; echo '", "p", "/l");
        assert!(script.contains(r"-p ''\''; rm -rf /; echo '\'''"));
    }

    #[test]
    fn validate_rejects_relative_or_empty_claude_path() {
        let (base, inside) = test_base("claudepath");
        let log = inside.to_str().unwrap(); // any real dir works as log_dir here
        assert!(validate_run_inner(&base, "", inside.to_str().unwrap(), log).is_err());
        assert!(validate_run_inner(&base, "claude", inside.to_str().unwrap(), log).is_err());
    }

    #[test]
    fn validate_requires_a_real_absolute_log_dir() {
        let (base, inside) = test_base("logdir");
        let cwd = inside.to_str().unwrap();
        for bad in ["", "relative/logs", "/definitely/not/a/real/dir-xyz"] {
            let err = validate_run_inner(&base, "/bin/claude", cwd, bad).unwrap_err();
            assert!(err.contains("log_dir"), "{bad:?} → {err}");
        }
    }

    #[test]
    fn validate_confines_cwd_to_strict_inside_of_worktrees_base() {
        let (base, inside) = test_base("confine");
        let log = inside.to_str().unwrap();
        assert!(validate_run_inner(&base, "/bin/claude", inside.to_str().unwrap(), log).is_ok());
        // Outside the base → rejected.
        let err = validate_run_inner(&base, "/bin/claude", "/", log);
        assert!(err.unwrap_err().contains("outside the managed worktrees"));
        // The base ITSELF is not a valid pass cwd — a pass belongs in a specific worktree.
        let err = validate_run_inner(&base, "/bin/claude", base.to_str().unwrap(), log);
        assert!(err.unwrap_err().contains("outside the managed worktrees"));
    }

    #[test]
    fn validate_rejects_a_file_as_cwd() {
        let (base, inside) = test_base("filecwd");
        let log = inside.to_str().unwrap();
        let file = inside.join("not-a-dir.txt");
        std::fs::write(&file, "x").unwrap();
        let err = validate_run_inner(&base, "/bin/claude", file.to_str().unwrap(), log);
        assert!(err.unwrap_err().contains("not a directory"));
    }

    #[cfg(unix)]
    #[test]
    fn validate_rejects_symlink_escape_from_inside_base() {
        // A symlink INSIDE the base pointing OUTSIDE must not pass containment — this is the
        // reason both sides are canonicalized before the starts_with compare.
        let (base, inside) = test_base("symlink");
        let log = inside.to_str().unwrap();
        let escape = base.join("escape");
        let _ = std::fs::remove_file(&escape);
        std::os::unix::fs::symlink("/", &escape).unwrap();
        let err = validate_run_inner(&base, "/bin/claude", escape.to_str().unwrap(), log);
        assert!(err.unwrap_err().contains("outside the managed worktrees"));
    }

    #[test]
    fn describe_exit_status_reports_code_and_reap_error() {
        use std::process::Command;
        // An ordinary non-zero exit surfaces the code.
        let s = Command::new("sh").args(["-c", "exit 3"]).status();
        assert_eq!(describe_exit_status(&s), "exit code 3");
        // A failed reap never panics and yields a non-empty phrase.
        let err: std::io::Result<std::process::ExitStatus> =
            Err(std::io::Error::other("boom"));
        assert!(describe_exit_status(&err).contains("could not reap"));
    }

    #[cfg(unix)]
    #[test]
    fn describe_exit_status_reports_signal_when_killed() {
        use std::process::Command;
        // No exit code when killed by a signal — the signal number must be surfaced instead,
        // so an OOM/SIGKILL is distinguishable from a clean error exit.
        let s = Command::new("sh").args(["-c", "kill -9 $$"]).status();
        assert_eq!(describe_exit_status(&s), "killed by signal 9");
    }
}

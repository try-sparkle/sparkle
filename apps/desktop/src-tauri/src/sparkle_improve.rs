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

use crate::claude_chat::{
    cached_login_shell_path, capture_result_status, handle_event, shell_quote,
};

/// Login shell, as `zsh -l -c 'exec …'` — matches `pty.rs` / `claude_chat.rs` / `claudeSpawn.ts`.
const SHELL: &str = "/bin/zsh";

/// The CANONICAL Improve-Sparkle agent id. MUST match `SPARKLE_CANONICAL_AGENT_ID` in
/// `sparkle_agent.rs` and `SPARKLE_AGENT_ID` in `src/services/sparkleAgent.ts`. Mirrored here
/// (rather than made `pub`) so this file stays self-contained; it is exported into the headless
/// pass as `SPARKLE_INBOX_AGENT` — see `build_improve_exec`.
const SPARKLE_CANONICAL_AGENT_ID: &str = "__sparkle_self__";

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

/// THE PROCESS'S OWN ANSWER to "is a pass working right now" — the reading the pinned
/// "Improve Sparkle" row needs and could not previously get.
///
/// The row is a raw read of `runtimeStore.status["__sparkle_self__"]`, and that key had exactly
/// two writers, BOTH of them JS that can be absent while this child keeps working: a mounted
/// `SparkleAgentPane` (its status engine detaches on unmount, freezing the key at its last
/// resting value) and the in-process pass driver (whose latch is MODULE state, so a webview
/// reload loses it while the child below survives up to `STALE_PASS_MAX`). With neither live the
/// row falls to a GRAY dot on a plainly working agent and nothing can retract it.
///
/// This is deliberately a POLLED READING rather than an event: an event is exactly what a
/// reloaded webview missed, so re-emitting one would rebuild the same hole.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImproveLiveness {
    /// True while the slot holds a pass that has NOT yet outlived `STALE_PASS_MAX`. Past that
    /// ceiling the pass is presumed hung (the same rule `sparkle_improve_run` reclaims on), so it
    /// stops counting as live — one definition of "in flight" for this file, and it keeps a wedged
    /// child from pinning the row green forever.
    pub active: bool,
    /// How long the occupying pass has been running, or `null` when the slot is empty. Present
    /// even when `active` is false so a caller can tell "nothing running" from "running but past
    /// the staleness ceiling".
    ///
    /// ⚠️ A Rust `Option` crosses the wire as `null`, NEVER as an absent key (no
    /// `skip_serializing_if` here, deliberately). The TS side must therefore declare
    /// `elapsedMs?: number | null` and any fixture must carry `null` rather than omit the key — a
    /// parser written against `number | undefined` describes a shape this can never produce.
    pub elapsed_ms: Option<u64>,
}

/// Pure decision behind [`SparkleImproveManager::liveness`], split out so the staleness ceiling is
/// testable without spawning a child and waiting 35 minutes.
fn liveness_for(elapsed: Option<Duration>) -> ImproveLiveness {
    match elapsed {
        Some(d) => ImproveLiveness {
            active: d < STALE_PASS_MAX,
            elapsed_ms: Some(d.as_millis() as u64),
        },
        None => ImproveLiveness { active: false, elapsed_ms: None },
    }
}

impl SparkleImproveManager {
    /// Kill and RECORD an in-flight pass because the app is going away. Idempotent: it `take()`s
    /// the slot, so a second call (or a call after the pass already ended) is a cheap no-op.
    ///
    /// This is the app-teardown entry point wired from `RunEvent::Exit` in `lib.rs`, NOT `Drop`.
    /// On macOS the ordinary Cmd+Q path never drops managed state: tao's event loop ends in
    /// `process::exit()` and never returns, so `App` (and this manager) leak at exit rather than
    /// being dropped — the same reason dictation stops its capture from `RunEvent::Exit`. Driving
    /// the record from there is what makes the `app-teardown` log line actually appear on quit,
    /// which is the entire point of recording it. `Drop` stays as an idempotent backstop for the
    /// paths that DO drop (tests, and any non-macOS runtime that unwinds the state).
    /// Is a pass child alive right now? Read from the SLOT, which the reader thread takes on the
    /// child's stdout EOF (i.e. on process exit), so an occupied slot means a live process rather
    /// than a stale flag. Read-only on purpose: it never `try_wait`s the child, which would reap it
    /// out from under the reader thread that owns that.
    pub fn liveness(&self) -> ImproveLiveness {
        liveness_for(lock_pass(&self.pass).as_ref().map(|p| p.started.elapsed()))
    }

    pub fn end_in_flight_pass(&self) {
        if let Some(pass) = lock_pass(&self.pass).take() {
            end_pass_early(pass, PassEnd::AppTeardown);
        }
    }
}

/// Best-effort backstop: a still-running pass must not outlive the app as a detached
/// `--dangerously-skip-permissions` process holding the agent worktree. The live quit path is
/// `end_in_flight_pass` via `RunEvent::Exit` (see there for why macOS never runs this `Drop`); on
/// a hard kill neither runs and the stale reclaim covers the next launch.
impl Drop for SparkleImproveManager {
    fn drop(&mut self) {
        self.end_in_flight_pass();
    }
}

/// Why a pass ended before it could report its own result. Each variant is a different actor
/// taking the slot; all of them kill the process group, and WHICH one it was is the fact you
/// need when reading back a pass that produced no outcome.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PassEnd {
    /// The frontend cancelled — its 30-minute timeout, or the user opening the interactive pane.
    Cancelled,
    /// A later run presumed this one hung and reclaimed the slot (see `STALE_PASS_MAX`).
    Reclaimed,
    /// The app itself is going away and is taking the pass with it.
    AppTeardown,
}

impl PassEnd {
    fn reason(self) -> &'static str {
        match self {
            PassEnd::Cancelled => "cancelled",
            PassEnd::Reclaimed => "stale-reclaim",
            PassEnd::AppTeardown => "app-teardown",
        }
    }

    /// A reclaim means a pass sat past `STALE_PASS_MAX` without finishing — anomalous, so WARN.
    /// Cancel and app teardown are routine, so they stay at INFO and don't cry wolf.
    fn is_anomalous(self) -> bool {
        self == PassEnd::Reclaimed
    }
}

/// Kill a pass that was taken over mid-flight, and RECORD that it happened.
///
/// The reader thread only reports an outcome when the slot still holds its token, so on every
/// one of these paths the pass dies silently as far as `pass finished` / `pass failed` are
/// concerned. App teardown used to be silent in the log too, which makes an interrupted pass
/// indistinguishable from one that is still running: it logs `starting hourly pass` and then
/// simply never logs an end, and dating the interruption means noticing the missing line and
/// correlating it against the next `Sparkle starting`. One line here closes that, and
/// `elapsed_ms` says how much of the pass's ~30-minute budget it got through first.
fn end_pass_early(mut pass: RunningPass, end: PassEnd) {
    let elapsed_ms = pass.started.elapsed().as_millis() as u64;
    let reason = end.reason();
    if end.is_anomalous() {
        tracing::warn!(reason, elapsed_ms, "sparkle_improve: pass ended before it reported a result (group killed)");
    } else {
        tracing::info!(reason, elapsed_ms, "sparkle_improve: pass ended before it reported a result (group killed)");
    }
    kill_pass_group(&mut pass.child);
}

fn lock_pass(m: &Mutex<Option<RunningPass>>) -> MutexGuard<'_, Option<RunningPass>> {
    // Recover from poisoning rather than panicking (same rationale as claude_chat.rs): a
    // panicked reader must not brick the hourly pass for the rest of the process.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Kill a pass and everything it spawned, then reap it. `Child::kill` alone would SIGKILL only
/// `claude` and orphan its `git`/`gh`/test children mid-mutation in the agent worktree, so the whole
/// GROUP has to go — see [`crate::proc::kill_process_group`]. The child is placed in its own process
/// group at spawn (unix), which that helper requires.
fn kill_pass_group(child: &mut Child) {
    crate::proc::kill_process_group(child);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImproveDone {
    session_id: String,
    text: String,
}

/// Payload of `sparkle_improve:error`.
///
/// CARRIES THE SESSION ID TOO, for the same reason `ImproveDone` does and with more at stake
/// (roborev 63251). A failing pass still wrote a conversation, and a failure is the ending someone
/// is most likely to open the pane to READ. `session_id` was in scope on this branch all along —
/// it is moved into `ImproveDone` only on the `ok` side — and was simply dropped, so the exact case
/// the `done` bind exists to cover (the pass forked or continued mid-flight, so the once-only early
/// announcement names a different file than the final one) left the tail unreadable on every
/// failure. It also covers a stream whose `init` line carried no id: on the error path `done` never
/// arrives, so this is the ONLY id the app would ever see.
///
/// `rename_all` is required now that a second, multi-word field exists — without it this would
/// cross as `session_id` while every other payload in this module sends camelCase. It is a plain
/// `String` (empty when unknown), not an `Option`, matching `ImproveDone`; the TS handler treats
/// the empty string as "no id" via a falsy check rather than a null test.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImproveError {
    message: String,
    session_id: String,
}

/// Payload of `sparkle_improve:session` — the id of the Claude session THIS pass is writing,
/// announced as soon as Claude reports it rather than held until the pass ends.
///
/// WHY EARLY MATTERS. The mounted transcript reads an agent's history by SESSION ID and fails closed
/// on an agent whose sessions it does not know. This pass is the one Sparkle agent with no pane and
/// therefore no hook events, so the app has no other authoritative way to learn which session is
/// its own — and `sparkle_improve:done` carries the id at turn END, which is far too late for
/// someone watching the pass work. Everything else available mid-flight is a directory scan
/// ("the newest `*.jsonl` in the worktree"), which cannot tell this pass's file from any other
/// `claude` that has run in the same tree. This id can: the app spawned the process that reported it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImproveSession {
    session_id: String,
}

/// The session-id announcement a stream line should produce, if any — `Some(id)` exactly ONCE, the
/// first time `handle_event` has filled one in.
///
/// Pulled out of the reader loop so the once-only rule is testable: `handle_event` re-assigns
/// `session_id` on the `result` event as well as on `system/init`, so an emit written inline as
/// "non-empty → emit" would fire again at the end of every pass. A duplicate is harmless downstream
/// (the binding is a set that no-ops on a known id) but it is a claim the event's name does not
/// make, and a second announcement of a DIFFERENT id would be a real signal nothing is listening for.
fn session_announcement(session_id: &str, announced: &mut bool) -> Option<String> {
    if *announced || session_id.is_empty() {
        return None;
    }
    *announced = true;
    Some(session_id.to_string())
}

/// Build the `exec …` script handed to `zsh -l -c`. Everything user-influenced is
/// single-quoted via `shell_quote`, so prompt/persona/paths can't escape into the shell.
/// `--model` is intentionally omitted (inherit the user's configured model), and there is
/// no `--resume`: each hourly pass starts FRESH — the persona + mission carry all needed
/// context, and the interactive pane resumes the pass's session afterwards anyway (it picks
/// the worktree's most recent session), which is how a case-by-case draft reaches the user.
fn build_improve_exec(
    claude_path: &str,
    prompt: &str,
    persona: &str,
    log_dir: &str,
    mcp_config: Option<&str>,
) -> String {
    let mut cmd = format!("exec {}", shell_quote(claude_path));
    cmd.push_str(" -p ");
    cmd.push_str(&shell_quote(prompt));
    cmd.push_str(" --output-format stream-json --verbose");
    cmd.push_str(" --append-system-prompt ");
    cmd.push_str(&shell_quote(persona));
    cmd.push_str(" --add-dir ");
    cmd.push_str(&shell_quote(log_dir));
    // THE sparkle-control MCP (bead sparkle-hdlhox). Without it this pass can RECEIVE a message —
    // the `SPARKLE_INBOX_AGENT` export below makes it a draining recipient — and cannot SEND one.
    // That half-duplex shape is the original defect relocated rather than fixed: the concierge can
    // answer a directive with "that contradicts what I observe", and the agent it is correcting has
    // no way to reply, so the correction is the end of the conversation instead of the start of one.
    // It also matters which body this is: the hourly pass does the log-mining and bead triage, so it
    // is the one that HAS the cross-agent findings worth pushing, while the interactive pane is
    // mostly the user chatting.
    //
    // SCOPE, stated because this pass is unattended and auto-approving: what it gains is the
    // ORDINARY agent surface (`get_state`, `send_peer_message`, self-narration), not the
    // concierge's. The wide `concierge_tool` domains refuse a non-concierge caller frontend-side in
    // `controlListener.dispatch`, which is the real gate — `--allowedTools` deliberately is NOT
    // relied on here, because it does not gate MCP tools at all (see concierge.rs's P0 note).
    //
    // No `--strict-mcp-config`: same as every other agent kind, the user's own servers still load.
    // Placed before a following FLAG, never before the positional prompt — `--mcp-config` is
    // variadic and would otherwise swallow it.
    if let Some(json) = mcp_config {
        cmd.push_str(" --mcp-config ");
        cmd.push_str(&shell_quote(json));
    }
    // Unattended pass: see the module docs for why this is required and how it is fenced.
    cmd.push_str(" --dangerously-skip-permissions");
    // EXPORT THE INBOX-OWNER ID (bead sparkle-179b2s). `mayDrain` in sparkle-hook.mjs only drains an
    // inbox when `SPARKLE_INBOX_AGENT === <that agent's id>`; the hourly headless pass never sets it,
    // so Improve Sparkle's inbox was written but never drained by the pass that has no pane. Export
    // the canonical id here — mirroring `claudeSpawn.ts`'s `inboxAgentExport` — so the headless pass
    // is a first-class draining recipient, not a black hole. `shell_quote` keeps it fenced like every
    // other value in this exec string.
    format!(
        "export PATH=\"$HOME/.local/bin:$PATH\"; export SPARKLE_INBOX_AGENT={}; {cmd}",
        shell_quote(SPARKLE_CANONICAL_AGENT_ID)
    )
}

/// Assemble the `Command` for one improvement pass — everything up to (but not including)
/// `.spawn()`. Split out of [`sparkle_improve_run`] for the same reason `concierge.rs` splits its
/// own: the account binding IS an environment entry, so proving it requires reading
/// `Command::get_envs()`. Asserting on the script string would prove nothing — `CLAUDE_CONFIG_DIR`
/// has never appeared there, before this change or after it.
fn build_pass_command(script: &str, cwd: &Path, config_dir: Option<&str>) -> Command {
    let mut cmd = Command::new(SHELL);
    // NON-login shell: we inject the login PATH ourselves (resolved once, cached — see
    // `cached_login_shell_path`) instead of re-sourcing the user's dotfiles on every pass. The
    // pass still shells out to `git`/`gh`/tests, so it gets the SAME full PATH `zsh -l` gave it,
    // just without the per-run login-startup latency.
    cmd.args(["-c", script]);
    cmd.env("PATH", cached_login_shell_path());
    // The account this pass runs under, on the CHILD only. Bound at SPAWN — which for this command
    // is always a pass boundary, since a pass is a single one-shot `claude -p` and at most one runs
    // at a time. A switch mid-pass therefore cannot reach the running child at all; it takes effect
    // on the next hourly pass. See the module docs and PRD/sparkle/account-rotation.md §6.
    crate::claude::apply_spawn_config_dir(&mut cmd, config_dir);
    cmd.current_dir(cwd);
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
    cmd
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
    // Inline JSON for `claude --mcp-config`, assembled by the frontend (it owns the control
    // bridge's socket + token). Optional so a pass whose bridge did not start spawns exactly as
    // before, with its cross-agent tools absent rather than the pass failing.
    mcp_config: Option<String>,
    // The chosen account's `CLAUDE_CONFIG_DIR` (Tauri maps JS `configDir` → this `config_dir`),
    // resolved by the frontend through the SAME `pickAccount` the build-agent spawn uses. Optional
    // so a build with no accounts configured spawns exactly as before.
    config_dir: Option<String>,
) -> Result<(), String> {
    let worktrees = crate::dev_identity::app_data_dir(&app)
        .map_err(|e| format!("sparkle_improve_run: {e}"))?
        .join("worktrees");
    let real_cwd = validate_run_inner(&worktrees, &claude_path, &cwd, &log_dir)?;

    let script = build_improve_exec(&claude_path, &prompt, &persona, &log_dir, mcp_config.as_deref());
    // Log paths only — the script embeds the persona/prompt (which reference the log dir and
    // could quote user-visible strings), matching the "args may contain prompt text" caution.
    // The account is logged as a BOOLEAN, never the dir (it is account-identifying).
    tracing::info!(
        %claude_path,
        cwd = %real_cwd.display(),
        account_pinned = crate::claude::spawn_env_config_dir(config_dir.as_deref()).is_some(),
        "sparkle_improve_run: starting hourly pass"
    );

    let mut cmd = build_pass_command(&script, &real_cwd, config_dir.as_deref());

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
            if let Some(stale) = slot.take() {
                end_pass_early(stale, PassEnd::Reclaimed);
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
            // Failure fields off the `result` event. `handle_event` deliberately ignores these
            // (its signature is shared with the chat engine), so capture them alongside it —
            // otherwise an empty-stderr failure throws away the only account of what went wrong.
            let mut result_subtype: Option<String> = None;
            let mut is_error = false;
            let mut error_detail: Option<String> = None;
            // Plain-text stdout the CLI printed instead of NDJSON. When `claude` fails during
            // STARTUP — before the stream exists — it commonly writes its reason to stdout and
            // exits non-zero, leaving stderr empty and no `result` event to lift a detail off.
            // That combination used to dead-end on the bare "(exit code 1)" fallback, which is
            // the one failure shape triage can do nothing with.
            let mut plain_stdout = String::new();
            // Has this pass's session id been announced yet? See `session_announcement`.
            let mut session_announced = false;
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
                            // Announce WHICH session this pass is writing, the moment Claude says so
                            // (its `system/init` line, i.e. within a second of the spawn). The
                            // frontend binds it as this agent's own so a mounted pane can read the
                            // pass while it works; see `ImproveSession`.
                            if let Some(sid) = session_announcement(&session_id, &mut session_announced) {
                                let _ = read_app.emit("sparkle_improve:session", ImproveSession { session_id: sid });
                            }
                            capture_result_status(
                                &ev,
                                &mut result_subtype,
                                &mut is_error,
                                &mut error_detail,
                            );
                        } else {
                            tracing::debug!("sparkle_improve: skipped non-JSON stdout line");
                            push_plain_stdout(&mut plain_stdout, trimmed);
                        }
                    }
                    Err(_) => break,
                }
            }

            // Reap — but only if the slot still holds OUR pass (token match). A cancel or a
            // stale reclaim takes the pass first (and kills/reaps it); in both cases the
            // teardown was initiated elsewhere, so we stay silent and leave the slot alone.
            let taken = {
                let manager = read_app.state::<SparkleImproveManager>();
                let mut slot = lock_pass(&manager.pass);
                match slot.as_ref() {
                    Some(p) if p.token == token => slot.take().map(|p| (p.child, p.started)),
                    _ => None,
                }
            };
            let Some((mut child, started)) = taken else { return };
            let wait_result = child.wait();
            let ok = matches!(wait_result, Ok(ref status) if status.success());
            let text = if !final_text.is_empty() { final_text } else { acc };
            // Same field the early-teardown paths log, so "how long did that pass run" is one
            // question with one answer however the pass ended.
            let elapsed_ms = started.elapsed().as_millis() as u64;

            if ok {
                tracing::info!(chars = text.len(), elapsed_ms, "sparkle_improve: pass finished");
                let _ = read_app.emit("sparkle_improve:done", ImproveDone { session_id, text });
            } else {
                let stderr_text = stderr_handle.join().unwrap_or_default();
                let message = failure_message(
                    &stderr_text,
                    result_subtype.as_deref(),
                    is_error,
                    error_detail.as_deref(),
                    &plain_stdout,
                    &wait_result,
                );
                tracing::warn!(%message, elapsed_ms, "sparkle_improve: pass failed");
                // `session_id` goes with it — see `ImproveError`. It is still owned here because
                // only the `ok` arm above moves it.
                let _ = read_app.emit(
                    "sparkle_improve:error",
                    ImproveError {
                        message,
                        session_id,
                    },
                );
            }
        });
    }

    Ok(())
}

/// Report whether an hourly improvement pass child is alive — the AUTHORITATIVE, process-driven
/// liveness signal behind the pinned "Improve Sparkle" row's status dot. See [`ImproveLiveness`]
/// for why this exists and why it is polled rather than emitted. Infallible: an empty slot is a
/// perfectly good answer (`active: false`), not an error.
///
/// ⚠️ `async` IS REQUIRED, NOT STYLE (bead sparkle-rfhu5, enforced by
/// `cmd_timing::main_thread_guard::every_tauri_command_is_async_or_explicitly_exempt`). A SYNC
/// `#[tauri::command]` runs its body inline on the AppKit main thread, so it freezes the whole UI
/// for its duration. This body is one mutex read and would almost never be felt — but the guard is
/// deliberately absolute rather than case-by-case, because "this one is cheap" is exactly the
/// reasoning that accumulates into a hang, and because a later edit to `liveness()` would inherit
/// the main-thread exposure silently. No `spawn_blocking`: there is nothing blocking to move, and
/// wrapping a lock read would cost a task hop for no gain.
///
/// The frontend polls this every 10s, so it is also the wrong place to spend main-thread time.
#[tauri::command]
pub async fn sparkle_improve_active(manager: State<'_, SparkleImproveManager>) -> Result<ImproveLiveness, String> {
    Ok(manager.liveness())
}

/// Kill an in-flight hourly pass — the whole process group, so nothing it spawned keeps
/// mutating the worktree. A no-op if none is running. Called by the frontend when the user
/// opens the interactive pane (so two `claude` processes never share the agent worktree) and
/// by the client-side pass timeout — the reader thread finds the slot token changed (entry
/// gone) on EOF and stays silent.
#[tauri::command]
pub fn sparkle_improve_cancel(manager: State<SparkleImproveManager>) -> Result<(), String> {
    let pass = lock_pass(&manager.pass).take();
    if let Some(pass) = pass {
        end_pass_early(pass, PassEnd::Cancelled);
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

/// Cap on the retained plain-stdout tail. A startup failure states its reason in a line or two;
/// anything longer is a stream that went wrong in some other way, and an unbounded buffer would
/// let a chatty child grow it without limit for a string that only ever ends up in one log line.
const PLAIN_STDOUT_MAX: usize = 2_000;
/// Keep the FIRST lines rather than the last: a CLI that fails to start prints its reason first
/// and then any usage/help banner, so the head is the diagnostic and the tail is boilerplate.
fn push_plain_stdout(buf: &mut String, line: &str) {
    if buf.len() >= PLAIN_STDOUT_MAX {
        return;
    }
    if !buf.is_empty() {
        buf.push('\n');
    }
    buf.push_str(line);
    if buf.len() > PLAIN_STDOUT_MAX {
        // Truncate at a CHAR boundary: these lines come from `from_utf8_lossy`, so a multi-byte
        // char can straddle the cap, and `String::truncate` PANICS on a non-boundary index — a
        // panic here would kill the reader thread and strand the pass's child unreaped.
        let cut = (0..=PLAIN_STDOUT_MAX)
            .rev()
            .find(|&i| buf.is_char_boundary(i))
            .unwrap_or(0);
        buf.truncate(cut);
    }
}

/// Build the `sparkle_improve:error` message for a failed pass. Priority, most-useful first —
/// the same order `claude_chat::build_error_message` uses for the Think tab, so a failure reads
/// the same wherever it surfaces:
///  1. the child's own stderr (its real diagnostics) when non-empty;
///  2. `detail` — claude's OWN error text lifted off the failed `result` event by
///     `capture_result_status` (a usage limit, an API/auth error, …). This is the fix for the
///     recurring empty-stderr exit-1 pass, which used to dead-end on (3) alone;
///  3. `plain_stdout` — plain-text the CLI printed to stdout instead of NDJSON. A startup failure
///     (bad flag, unreadable config, auth refusal) exits non-zero with empty stderr and no
///     `result` event, so (1) and (2) are both blank and this is the ONLY account of the reason;
///  4. the synthesized exit-status phrase, now naming any non-`"success"` subtype / `is_error`
///     flag so a max-turns stop is distinguishable from a crash.
/// Pure, so the precedence is unit-testable without spawning a real pass.
fn failure_message(
    stderr: &str,
    result_subtype: Option<&str>,
    is_error: bool,
    detail: Option<&str>,
    plain_stdout: &str,
    status: &std::io::Result<std::process::ExitStatus>,
) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    if let Some(detail) = detail.map(str::trim).filter(|s| !s.is_empty()) {
        return detail.to_string();
    }
    // Below the stream's own account (a `result` event is structured and authoritative) but above
    // the exit code, which says only THAT it failed.
    let plain_stdout = plain_stdout.trim();
    if !plain_stdout.is_empty() {
        return plain_stdout.to_string();
    }
    // Keep the long-standing fallback wording — it's what the existing log history reads like —
    // and append whatever the stream managed to tell us.
    let mut m = format!(
        "claude exited without a successful result ({})",
        describe_exit_status(status)
    );
    if let Some(st) = result_subtype {
        m.push_str(&format!("; result subtype '{st}'"));
    } else if is_error {
        m.push_str("; stream reported an error result");
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real, killable stand-in for an in-flight pass: its own process group, like the spawn
    /// path gives a live one, so `kill_pass_group`'s negative-pid signal has a group to land on.
    #[cfg(unix)]
    fn spawn_sleeper() -> RunningPass {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 60"]);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.process_group(0);
        let child = cmd.spawn().expect("spawn sleeper");
        RunningPass { child, started: Instant::now(), token: 0 }
    }

    /// `kill(pid, 0)` probes for existence without signalling. `end_pass_early` reaps (via
    /// `kill_process_group`'s `wait`), so a killed child is GONE here, not left as a zombie.
    #[cfg(unix)]
    fn is_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// The row's whole problem was a signal that could be ABSENT while the child worked, so the
    /// thing worth pinning is that an occupied slot reads live and an empty one does not — and that
    /// a pass past the staleness ceiling stops counting, so a wedged child can't pin the row green.
    #[test]
    fn liveness_tracks_the_slot_and_stops_at_the_staleness_ceiling() {
        assert_eq!(
            liveness_for(None),
            ImproveLiveness { active: false, elapsed_ms: None },
            "an empty slot is not live"
        );
        let young = liveness_for(Some(Duration::from_secs(90)));
        assert!(young.active, "a pass inside the ceiling is live");
        assert_eq!(young.elapsed_ms, Some(90_000));
        let stale = liveness_for(Some(STALE_PASS_MAX + Duration::from_secs(1)));
        assert!(!stale.active, "a pass past STALE_PASS_MAX is presumed hung, not live");
        assert!(
            stale.elapsed_ms.is_some(),
            "…but its age is still reported, so 'nothing running' stays distinguishable from 'hung'"
        );
    }

    /// `Option<u64>` crosses the wire as `null`, NEVER as an absent key — the TS side declares
    /// `elapsedMs?: number | null` on the strength of this, and a `skip_serializing_if` slipped in
    /// here would silently make that type describe a shape the wire cannot produce (AGENTS.md).
    #[test]
    fn liveness_serializes_camel_case_with_an_explicit_null() {
        let idle = serde_json::to_value(liveness_for(None)).expect("serialize");
        assert_eq!(idle["active"], serde_json::Value::Bool(false));
        assert!(idle.get("elapsedMs").is_some(), "the key must be PRESENT");
        assert_eq!(idle["elapsedMs"], serde_json::Value::Null);
        let live = serde_json::to_value(liveness_for(Some(Duration::from_millis(1234)))).expect("serialize");
        assert_eq!(live["active"], serde_json::Value::Bool(true));
        assert_eq!(live["elapsedMs"], serde_json::json!(1234));
    }

    /// THE SEAM, pinned from the side that can actually see both halves. This writer's failure mode
    /// is SILENCE: an unregistered command makes `invoke` reject, the poller swallows the rejection
    /// on purpose (a failed probe is not evidence the child died), and the row is back to being
    /// gray forever with nothing logged. A misspelled name on either side does the same. Both
    /// suites would stay green — so assert the two spellings and the registration together.
    #[test]
    fn the_liveness_command_is_registered_and_named_the_same_on_both_sides() {
        const NAME: &str = "sparkle_improve_active";
        assert!(
            include_str!("lib.rs").contains(&format!("sparkle_improve::{NAME}")),
            "{NAME} is missing from lib.rs's invoke handler list"
        );
        assert!(
            include_str!("../../src/services/improvePassLiveness.ts").contains(&format!("\"{NAME}\"")),
            "the TS poller does not invoke {NAME}"
        );
    }

    /// End to end over the real manager: the slot a spawned pass occupies is what `liveness()`
    /// reads, and taking the slot (cancel / teardown) releases it.
    #[cfg(unix)]
    #[test]
    fn manager_liveness_follows_a_real_pass_in_and_out_of_the_slot() {
        let manager = SparkleImproveManager::default();
        assert!(!manager.liveness().active, "nothing spawned yet");
        *lock_pass(&manager.pass) = Some(spawn_sleeper());
        assert!(manager.liveness().active, "an occupied slot reads live");
        manager.end_in_flight_pass();
        assert!(!manager.liveness().active, "and a taken slot stops reading live");
    }

    #[test]
    fn every_early_end_names_itself_and_only_a_reclaim_is_anomalous() {
        // The reason strings are the whole point of the field — a log that can't tell teardown
        // from a cancel can't date an interrupted pass, which is what this exists to fix.
        let all = [PassEnd::Cancelled, PassEnd::Reclaimed, PassEnd::AppTeardown];
        let reasons: Vec<&str> = all.iter().map(|e| e.reason()).collect();
        assert_eq!(reasons, ["cancelled", "stale-reclaim", "app-teardown"]);
        // A hung pass is the only anomaly; routine endings must not log at WARN and cry wolf.
        assert!(PassEnd::Reclaimed.is_anomalous());
        assert!(!PassEnd::Cancelled.is_anomalous());
        assert!(!PassEnd::AppTeardown.is_anomalous());
    }

    #[cfg(unix)]
    #[test]
    fn end_pass_early_still_kills_the_group_it_reports_on() {
        // Recording the end must not have cost us the kill: an unattended
        // --dangerously-skip-permissions child outliving its slot would keep mutating the
        // agent worktree with nothing holding a handle to stop it.
        let pass = spawn_sleeper();
        let pid = pass.child.id() as i32;
        end_pass_early(pass, PassEnd::Cancelled);
        assert!(!is_alive(pid), "cancelled pass survived the group kill");
    }

    #[cfg(unix)]
    #[test]
    fn end_in_flight_pass_kills_records_and_is_idempotent() {
        // This is the entry point `RunEvent::Exit` calls on quit — the path that actually runs on
        // macOS, where `Drop` does not. It must kill the group (so a detached pass can't outlive
        // the app) and tolerate a second call: `RunEvent::Exit` firing and a later `Drop` both
        // reach it, and after the first `take()` the rest are no-ops.
        let manager = SparkleImproveManager::default();
        let pass = spawn_sleeper();
        let pid = pass.child.id() as i32;
        *lock_pass(&manager.pass) = Some(pass);
        assert!(is_alive(pid));
        manager.end_in_flight_pass();
        assert!(!is_alive(pid), "quit path did not kill the in-flight pass");
        // Idempotent: no pass in the slot now, so this neither panics nor signals anything.
        manager.end_in_flight_pass();
    }

    #[cfg(unix)]
    #[test]
    fn dropping_the_manager_takes_the_in_flight_pass_with_it() {
        // App teardown was the one path that killed the pass without leaving any record. It
        // still has to kill it — the record is additive.
        let manager = SparkleImproveManager::default();
        let pass = spawn_sleeper();
        let pid = pass.child.id() as i32;
        *lock_pass(&manager.pass) = Some(pass);
        assert!(is_alive(pid));
        drop(manager);
        assert!(!is_alive(pid), "pass outlived the app that spawned it");
    }

    /// The app-teardown record and group kill only actually happen if `RunEvent::Exit` calls
    /// `end_in_flight_pass` — `Drop` does not run on the macOS Cmd+Q path (tao ends in
    /// `process::exit()`). The unit tests above drive `end_in_flight_pass` directly, so they pass
    /// whether or not that one line in `lib.rs` exists — which is exactly the blind spot that let
    /// the parent commit hang the record off a never-run `Drop` with a green suite. Pin the wiring
    /// in source the same way `accounts.rs`, `app_menu.rs`, and `beads_cmd.rs` pin theirs: the bug
    /// is one deleted line away, and this is the only test that catches that deletion.
    #[test]
    fn lib_rs_drives_teardown_from_run_event_exit() {
        let lib_rs = include_str!("lib.rs");
        assert!(
            lib_rs.contains("SparkleImproveManager>().end_in_flight_pass()"),
            "RunEvent::Exit must call end_in_flight_pass — Drop does not run on the macOS quit \
             path, so without this line the app-teardown record and the group kill silently stop"
        );
        // And it must live in the Exit arm, next to the dictation stop that is there for the same
        // before-exit() reason — a call floated out of that arm would not fire on quit.
        let exit_arm = lib_rs
            .split("RunEvent::Exit =>")
            .nth(1)
            .expect("lib.rs must have a RunEvent::Exit arm");
        let arm_body = &exit_arm[..exit_arm.find("\n            }").unwrap_or(exit_arm.len())];
        assert!(
            arm_body.contains("stop_capture()") && arm_body.contains("end_in_flight_pass()"),
            "end_in_flight_pass must be called from within the RunEvent::Exit arm"
        );
    }

    /// The `CLAUDE_CONFIG_DIR` a built pass command would hand its child, or None if it sets none.
    fn child_config_dir(cmd: &Command) -> Option<std::ffi::OsString> {
        cmd.get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("CLAUDE_CONFIG_DIR"))
            .and_then(|(_, v)| v)
            .map(|v| v.to_os_string())
    }

    /// THE PHASE-0 BUG. The hourly pass set only `PATH` on its child, so `claude` resolved its
    /// config from whatever the app process happened to carry — in practice nothing, i.e.
    /// `$HOME/.claude`, the `isDefault` account. Signing into a different account anywhere else in
    /// Sparkle could not move the pass off it, which is half of the human's "three separate
    /// logins". This asserts the SIDE EFFECT (the child's environment), not the script text:
    /// `CLAUDE_CONFIG_DIR` never appeared in the script, so a string assertion would have been
    /// green against the broken code.
    #[test]
    fn the_pass_child_runs_under_the_chosen_account() {
        let cmd = build_pass_command("exec claude -p x", Path::new("/tmp"), Some("/accounts/ab12"));
        assert_eq!(
            child_config_dir(&cmd).as_deref(),
            Some(std::ffi::OsStr::new("/accounts/ab12")),
            "the hourly pass must run under the account the user selected, not $HOME/.claude"
        );
    }

    /// "No override" must mean SET NOTHING, not set empty. The default account records
    /// `config_dir: ""` for exactly this meaning (accounts.rs), and an empty `CLAUDE_CONFIG_DIR`
    /// makes Claude Code resolve a RELATIVE `projects/` against the cwd instead of falling back to
    /// `$HOME/.claude` — the semantics `claude::resolve_session_config_dir` already guards on the
    /// read side, preserved here on the spawn side.
    #[test]
    fn no_account_and_the_empty_default_both_leave_the_child_inheriting() {
        for absent in [None, Some("")] {
            let cmd = build_pass_command("exec claude -p x", Path::new("/tmp"), absent);
            assert_eq!(
                child_config_dir(&cmd),
                None,
                "config_dir {absent:?} must set no CLAUDE_CONFIG_DIR at all"
            );
        }
    }

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
            None,
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
    fn build_exec_carries_the_control_mcp_so_the_headless_pass_can_SEND_not_just_receive() {
        // bead sparkle-hdlhox. The export asserted in the test below makes this pass a draining
        // RECIPIENT; without `--mcp-config` it had no way to send anything back. Half-duplex is the
        // original defect relocated: the concierge can reply "that contradicts what I observe" and
        // the agent being corrected cannot answer, so the correction ends the exchange.
        let script = build_improve_exec("/bin/claude", "p", "persona", "/logs", Some("{\"mcpServers\":{}}"));
        assert!(
            script.contains("--mcp-config '{\"mcpServers\":{}}'"),
            "the pass must carry the control MCP when one was assembled; got: {script}"
        );
        // NOT strict — the user's own MCP servers must still load, same as every other agent kind.
        assert!(!script.contains("--strict-mcp-config"));
        // `--mcp-config` is VARIADIC: a following flag has to terminate it, or it swallows whatever
        // comes next. The prompt is positional and already consumed by `-p` above, but this pins the
        // ordering so a later edit cannot move the flag to the end of the string.
        let at = script.find("--mcp-config").expect("flag present");
        assert!(
            script[at..].contains("--dangerously-skip-permissions"),
            "a FLAG must follow --mcp-config so its variadic list is terminated; got: {script}"
        );
    }

    #[test]
    fn build_exec_omits_the_mcp_flag_entirely_when_no_bridge_came_up() {
        // THE PAIRED NEGATIVE, and the degradation contract. A control bridge that will not start
        // must cost this pass its cross-agent tools and nothing else — never an empty or malformed
        // `--mcp-config`, which `claude` would reject and which would take the whole hourly pass
        // down with it. Absent, not empty.
        let script = build_improve_exec("/bin/claude", "p", "persona", "/logs", None);
        assert!(!script.contains("--mcp-config"), "no bridge must mean no flag at all; got: {script}");
        // …and the pass is otherwise completely intact.
        assert!(script.contains("--dangerously-skip-permissions"));
        assert!(script.contains("export SPARKLE_INBOX_AGENT='__sparkle_self__';"));
    }

    #[test]
    fn build_exec_exports_inbox_agent_id_so_the_headless_pass_drains_its_inbox() {
        // bead sparkle-179b2s. `mayDrain` (sparkle-hook.mjs) only drains an inbox when
        // SPARKLE_INBOX_AGENT equals that agent's id. Without this export the hourly headless pass —
        // which owns no pane — writes an inbox nobody drains. Assert the SIDE EFFECT (the export is in
        // the exec string the pass actually runs), quoted exactly the way `shell_quote` emits it, so a
        // mutation that drops the export turns this red.
        let script = build_improve_exec("/bin/claude", "p", "persona", "/logs", None);
        assert!(
            script.contains("export SPARKLE_INBOX_AGENT='__sparkle_self__';"),
            "headless pass must export its inbox-owner id; got: {script}"
        );
    }

    #[test]
    fn build_exec_quotes_hostile_values() {
        let script = build_improve_exec("/bin/claude", "'; rm -rf /; echo '", "p", "/l", None);
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

    /// A non-zero exit status to hang the synthesized-fallback tests off of.
    fn failed_status() -> std::io::Result<std::process::ExitStatus> {
        Command::new("sh").args(["-c", "exit 1"]).status()
    }

    #[test]
    fn failure_message_prefers_stderr_over_everything() {
        // The child's own diagnostics are the most useful thing we have — quote them verbatim
        // rather than the stream's detail or a synthesized phrase.
        let m = failure_message(
            "  boom: real stderr\n",
            Some("error_during_execution"),
            true,
            Some("claude's detail"),
            "",
            &failed_status(),
        );
        assert_eq!(m, "boom: real stderr");
    }

    #[test]
    fn failure_message_surfaces_claude_detail_when_stderr_empty() {
        // The recurring hourly failure: exit 1 with EMPTY stderr. The stream carried claude's
        // OWN reason — surface THAT instead of the bare exit-status fallback.
        let m = failure_message(
            "",
            Some("error_during_execution"),
            true,
            Some("Claude usage limit reached"),
            "",
            &failed_status(),
        );
        assert_eq!(m, "Claude usage limit reached");
        assert!(!m.contains("without a successful result"), "got: {m}");
    }

    #[test]
    fn failure_message_falls_back_to_exit_status_and_names_the_subtype() {
        // Nothing to quote: keep the existing fallback wording (log continuity) but append the
        // non-success subtype, which distinguishes e.g. a max-turns stop from a crash.
        let m = failure_message("", Some("error_max_turns"), true, None, "", &failed_status());
        assert!(m.contains("claude exited without a successful result (exit code 1)"), "got: {m}");
        assert!(m.contains("error_max_turns"), "got: {m}");
    }

    #[test]
    fn failure_message_notes_an_error_result_with_no_subtype() {
        // is_error with no subtype still beats saying nothing about the stream.
        let m = failure_message("", None, true, None, "", &failed_status());
        assert!(m.contains("stream reported an error result"), "got: {m}");
    }

    #[test]
    fn failure_message_is_bare_fallback_when_stream_said_nothing() {
        // Child died before emitting any result event (crash/auth failure) — unchanged behavior.
        let m = failure_message("", None, false, None, "", &failed_status());
        assert_eq!(m, "claude exited without a successful result (exit code 1)");
    }

    #[test]
    fn failure_message_ignores_blank_detail_and_falls_through() {
        // A whitespace-only detail must not win over the synthesized fallback.
        let m = failure_message("", None, false, Some("   "), "", &failed_status());
        assert_eq!(m, "claude exited without a successful result (exit code 1)");
    }

    #[test]
    fn failure_message_surfaces_plain_stdout_when_the_stream_never_started() {
        // The observed startup failure: the pass died seconds after launch with exit 1, EMPTY
        // stderr, and no `result` event — so the CLI's reason existed only as plain text on
        // stdout, which the reader parsed as non-JSON and dropped. That left the one failure
        // shape triage can do nothing with. Quote it instead.
        let m = failure_message(
            "",
            None,
            false,
            None,
            "error: unknown option '--append-system-prompt'",
            &failed_status(),
        );
        assert_eq!(m, "error: unknown option '--append-system-prompt'");
        assert!(!m.contains("without a successful result"), "got: {m}");
    }

    #[test]
    fn plain_stdout_ranks_below_stderr_and_the_streams_own_detail() {
        // Precedence guard: plain stdout is the LAST resort before the exit code, never a
        // substitute for the child's real diagnostics or a structured `result` detail.
        let over_stderr =
            failure_message("real stderr", None, false, None, "noise", &failed_status());
        assert_eq!(over_stderr, "real stderr");
        let over_detail = failure_message(
            "",
            None,
            false,
            Some("claude's detail"),
            "noise",
            &failed_status(),
        );
        assert_eq!(over_detail, "claude's detail");
    }

    #[test]
    fn blank_plain_stdout_still_falls_through_to_the_exit_status() {
        // Whitespace-only stdout must not shadow the synthesized fallback (cf. blank detail).
        let m = failure_message("", None, false, None, "  \n ", &failed_status());
        assert_eq!(m, "claude exited without a successful result (exit code 1)");
    }

    #[test]
    fn plain_stdout_accumulates_lines_and_is_bounded() {
        // Multi-line reasons stay readable in order …
        let mut buf = String::new();
        push_plain_stdout(&mut buf, "first");
        push_plain_stdout(&mut buf, "second");
        assert_eq!(buf, "first\nsecond");

        // … but a chatty child can't grow the buffer without limit, and the HEAD is kept
        // (a startup failure states its reason before any banner).
        let mut big = String::new();
        for _ in 0..500 {
            push_plain_stdout(&mut big, &"x".repeat(50));
        }
        assert!(big.len() <= PLAIN_STDOUT_MAX, "len {}", big.len());
        assert!(big.starts_with("xxxx"), "kept the head");
    }

    #[test]
    fn plain_stdout_cap_does_not_split_a_multibyte_char() {
        // Regression guard: `String::truncate` panics on a non-char-boundary index, and stdout
        // reaches us via `from_utf8_lossy`, so a multi-byte char CAN straddle the cap. A panic
        // here would kill the reader thread and strand the child unreaped.
        let mut buf = String::new();
        // "é" is 2 bytes, so a 3-byte-per-char run lands the cap mid-char for some offsets.
        for _ in 0..400 {
            push_plain_stdout(&mut buf, &"é…".repeat(10));
        }
        assert!(buf.len() <= PLAIN_STDOUT_MAX, "len {}", buf.len());
        // The real assertion is simply that we got here without panicking, and that what
        // survived is still valid UTF-8 we can round-trip.
        assert_eq!(buf, String::from_utf8(buf.clone().into_bytes()).unwrap());
    }

    #[test]
    fn a_failed_result_event_reaches_the_message_instead_of_being_dropped() {
        // The actual regression guard: drive the SEAM the reader loop uses — the same NDJSON
        // `result` shape a failed `claude -p --output-format stream-json` emits — through
        // capture_result_status into failure_message. Before this wiring the pass parsed this
        // event, kept nothing from it, and reported only "(exit code 1)".
        let line = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Claude usage limit reached"]}"#;
        let ev: Value = serde_json::from_str(line).unwrap();

        let (mut session_id, mut final_text, mut acc) = (String::new(), String::new(), String::new());
        let (mut subtype, mut is_error, mut detail) = (None, false, None);
        handle_event(&ev, &mut session_id, &mut final_text, &mut acc, &mut |_| {});
        capture_result_status(&ev, &mut subtype, &mut is_error, &mut detail);

        let m = failure_message(
            "",
            subtype.as_deref(),
            is_error,
            detail.as_deref(),
            "",
            &failed_status(),
        );
        assert_eq!(m, "Claude usage limit reached");
    }

    // The mounted transcript keys on SESSION ID and fails closed on an agent whose sessions it does
    // not know. This pass has no pane and so no hook events, which made the app-owned Sparkle agent
    // permanently unbindable while a pass ran (roborev 63133/63135). Drive the same seam the reader
    // loop uses — `handle_event` over the real NDJSON, then the announcement decision.
    #[test]
    fn the_pass_announces_its_session_id_once_from_the_first_line_claude_writes() {
        let (mut session_id, mut final_text, mut acc) = (String::new(), String::new(), String::new());
        let mut announced = false;

        // Claude has not said anything yet: nothing to announce, and nothing announced by accident.
        assert_eq!(session_announcement(&session_id, &mut announced), None);
        assert!(!announced);

        // The stream's FIRST line — this is where the id arrives, ~a second after the spawn, which
        // is the whole point of announcing here rather than on `sparkle_improve:done`.
        let init: Value = serde_json::from_str(
            r#"{"type":"system","subtype":"init","session_id":"pass-live-1"}"#,
        )
        .unwrap();
        handle_event(&init, &mut session_id, &mut final_text, &mut acc, &mut |_| {});
        assert_eq!(
            session_announcement(&session_id, &mut announced),
            Some("pass-live-1".to_string())
        );

        // ONCE. `handle_event` re-assigns `session_id` on the `result` event too, so a bare
        // "non-empty → emit" would fire a second time at the end of every pass.
        let result: Value = serde_json::from_str(
            r#"{"type":"result","subtype":"success","session_id":"pass-live-1","result":"done"}"#,
        )
        .unwrap();
        handle_event(&result, &mut session_id, &mut final_text, &mut acc, &mut |_| {});
        assert_eq!(session_announcement(&session_id, &mut announced), None);
    }
}

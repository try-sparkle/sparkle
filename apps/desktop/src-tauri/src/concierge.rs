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

/// Every turn whose token is BELOW this is retired: the user has sent again (or cancelled), so it
/// must stop emitting immediately — even though it may still be holding the slot.
///
/// The slot alone is too late (roborev 53105). `concierge_turn` only takes the slot AFTER it has
/// resolved the claude path, prepared the cwd and spawned a fresh `zsh`/`claude` — hundreds of
/// milliseconds during which the OLD turn still legitimately owns it, and any first tokens it
/// produces in that window were emitted as if live, stranding a bubble that answers the previous
/// question (and, since that turn is then killed, never gets a terminal event to clear it). This
/// is published at the TOP of a send, before any of that work, so "the user moved on" takes effect
/// the instant they act rather than whenever the replacement process happens to finish starting.
static RETIRE_BELOW: AtomicU64 = AtomicU64::new(0);

/// Bumped by every cancel. A send reads it on entry and again after its prep: a change across that
/// window means the user cancelled the very turn being started, before it had a token or a child —
/// the state no floor and no slot can describe, because it has neither yet (roborev 53147).
static CANCEL_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Sentinels for the two NON-failures a send can end in: the user superseded it or cancelled it.
/// Stable strings because the frontend matches on them to stay silent — neither is something to
/// tell the user about, and both are ordinary outcomes of two fast sends (roborev 53186).
pub const SUPERSEDED_ERR: &str = "concierge_turn: superseded before install";
pub const CANCELLED_ERR: &str = "concierge_turn: cancelled";

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

/// May this turn still SPEAK? Two facts: the send-time retirement floor (checked first, lock-free,
/// because it covers the window in which this turn still holds the slot but the user has already
/// moved on) and the slot itself.
///
/// Gates the delta emit ONLY — its single caller. The reap does its own inline slot match in
/// `drain_turn` and deliberately does NOT consult the floor: a retired turn that still holds the
/// slot is the one that must reap its own child and emit its terminal event, or the process leaks
/// and the frontend's turn never ends (roborev 53130).
fn still_owns_turn(app: &AppHandle, token: u64) -> bool {
    // Retired at send time — checked FIRST, and without the lock, because it covers the window in
    // which this turn still holds the slot but the user has already moved on (see RETIRE_BELOW).
    if is_retired(token, RETIRE_BELOW.load(Ordering::Relaxed)) {
        return false;
    }
    let manager = app.state::<ConciergeManager>();
    let slot = lock_turn(&manager.turn);
    matches!(slot.as_ref(), Some(t) if t.token == token)
}

/// Is the turn in the slot ours to tear down? Only one strictly OLDER than us: our floor retired
/// it, so it is silenced-but-running unless we kill it. A NEWER occupant owns both the floor and
/// the slot — killing it is how a refused older send murders the live turn (roborev 53205).
///
/// A real function called by both teardown sites, not a rule each restates: the fifth round of that
/// finding, and it was right every time.
fn mine_to_tear_down(token: u64, slot_holds: Option<u64>) -> bool {
    matches!(slot_holds, Some(t) if t < token)
}

/// Did a cancel land while this send was preparing? A REAL function, called from `concierge_turn`,
/// so a test drives the production control flow rather than a copy of the comparison — deleting
/// the call then leaves a dead-code warning instead of a silent hole (roborev 53181).
fn cancelled_during_prep(entry_epoch: u64) -> bool {
    CANCEL_EPOCH.load(Ordering::Relaxed) != entry_epoch
}

/// Which of the two things a `spawn_turn` can be. The install rule differs between them because
/// only ONE of them is evidence of fresh user intent (roborev 53397).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TurnKind {
    /// A user send. Its token was reserved by `reserve_turn_token`, which floors at that token in
    /// the same breath — so for a send, and ONLY for a send, "a higher token means the user asked
    /// more recently" is true by construction.
    Send,
    /// The stale-resume retry: the same logical turn, continuing, under the token its send already
    /// reserved. It publishes no floor and claims no recency.
    Continuation,
}

/// May this turn take the slot? A REAL function, called from the install site under the lock, so
/// a test can drive the actual rule (roborev 53186 — four rounds running, a test asserting against
/// a local copy of a predicate would have stayed green with the call site deleted).
///
/// No when we have been retired, and then it depends on WHAT is installing:
///
/// * A `Send` refuses only a strictly NEWER occupant. Spawns finish out of order, so an older send
///   must never stomp the entry of the one the user is waiting on — but it may legitimately take
///   the slot from a turn its own floor already retired.
/// * A `Continuation` refuses ANY occupant (roborev 53397). The reap that precedes the retry
///   emptied the slot itself, so whatever is in there now was installed AFTER that — i.e. by a send
///   the user made while the first attempt was failing. Comparing tokens cannot express that: the
///   continuation reuses its own turn's token, which is by definition older than that send's.
fn may_install(kind: TurnKind, token: u64, retire_below: u64, slot_holds: Option<u64>) -> bool {
    if is_retired(token, retire_below) {
        return false;
    }
    match kind {
        TurnKind::Send => !matches!(slot_holds, Some(t) if t > token),
        TurnKind::Continuation => slot_holds.is_none(),
    }
}

/// Pure half of the retirement rule: a turn is retired once a LATER send (or a cancel) has
/// published a floor above its token. Split out so the rule is testable without a Tauri app.
fn is_retired(token: u64, retire_below: u64) -> bool {
    token < retire_below
}

/// Claim the next turn token AND retire everything below it, in that order. Called immediately
/// before the spawn — AFTER the cheap fallible prep (claude path, app-data dir, `create_dir_all`),
/// deliberately, so a send that fails before it ever spawns cannot silence a turn it never
/// replaced. See the note at the call site.
///
/// Reserving first is what makes it correct under two concurrent sends (`concierge_turn` is an
/// async command; nothing serializes two rapid ones). Publishing `TURN_SEQ.load()` without taking
/// a token loses that race: send B can read 5 and store 5 while send A has not yet taken token 5,
/// so A — the OLDER turn — ends up unretired by the very send that superseded it. Taking the token
/// first means the floor is always "strictly below ME", which is true by construction.
///
/// `fetch_max`, not `store`: floors only ever rise, so a slower thread can't lower one a newer
/// send has already published.
fn reserve_turn_token() -> u64 {
    let token = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    RETIRE_BELOW.fetch_max(token, Ordering::Relaxed);
    token
}

/// How the stale-resume retry must be spawned: as a `Continuation`, under the SAME token the turn
/// it continues already reserved. A real function called by the retry site, so a test drives the
/// production rule instead of a restatement of it — and deleting the call leaves a dead-code
/// warning rather than a silent hole (roborev 53397, same pattern as `cancelled_during_prep`).
///
/// It used to draw a FRESH token off `TURN_SEQ` "without publishing a floor", which looked
/// conservative and was not: every comparison in this module reads a higher token as more recent
/// user intent, and a fresh draw is higher than every send that exists. Turn 5 fails with a resume
/// id and reaps; the user sends, taking token 6 and flooring at 6; the retry draws 7, is not
/// retired by a floor of 6, and installs — killing turn 6's child. Turn 6's reader then finds the
/// slot changed, returns `owned: false` and emits NOTHING, while the retry's answer to the previous
/// question arrives under id "5", which the frontend has already retired. The user's newest
/// question dies unanswered and the typing indicator hangs for the session.
///
/// Reusing the turn's own token makes the retry's position in the ordering its TRUE position — the
/// moment the user asked this question — so every existing rule becomes correct for it for free:
/// a later send's floor retires it (`is_retired`), and a later send that has not floored yet still
/// out-ranks it at the install site and supersedes it there instead. Note that no reordering of a
/// fresh `fetch_add` against the floor read could have closed this: a token above every send is
/// wrong no matter when it is compared.
///
/// The retry needs no unique token of its own: the reap it comes after took its turn OUT of the
/// slot, so there is nothing left to tell apart.
fn continuation_install(original_token: u64) -> (TurnKind, u64) {
    (TurnKind::Continuation, original_token)
}

/// Retire every turn RESERVED so far — for cancel, which starts nothing itself.
///
/// The floor alone cannot stop a send that has not reached its reservation yet, whatever it is
/// derived from: a barrier token would simply land above that send's later token, exactly as this
/// load does (roborev 53147 proposed the barrier; it moves the arithmetic without closing the
/// gap). What covers "Escape while Enter is still resolving the claude path" is CANCEL_EPOCH,
/// which `concierge_turn` re-checks after its prep.
fn retire_issued_turns() {
    CANCEL_EPOCH.fetch_add(1, Ordering::Relaxed);
    RETIRE_BELOW.fetch_max(TURN_SEQ.load(Ordering::Relaxed), Ordering::Relaxed);
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
    // A user send, or the stale-resume retry continuing one — they install under different rules
    // (see may_install / continuation_install).
    kind: TurnKind,
    // Reserved by the CALLER before any of this work began (see reserve_turn_token) — minting it
    // here would mean the previous turn stays live until the new child finishes spawning.
    token: u64,
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

    // Install CONDITIONALLY, under the same lock (roborev 53165). Two sends race on separate
    // spawn_blocking threads and the spawns can finish out of order, so an unconditional replace
    // lets an OLDER turn stomp the newer one's entry — killing the child the user is actually
    // waiting on. The floor already stops that turn from speaking; without this it could still take
    // the slot, leaving the live turn dead with no `done` and the typing indicator hung forever.
    //
    // Refuse when this turn is retired, or when the slot holds a turn `kind` says is not ours to
    // replace, and take our own just-spawned child down with us. That makes "who owns the slot"
    // agree with "who owns the floor" by construction — for the stale-resume retry too, which is
    // held to the stricter "any occupant wins" rule because its token predates that occupant by
    // construction (roborev 53397).
    // Held in an Option so the child can be moved into the slot under the lock, and is still ours
    // to kill if we refuse — a `slot.replace` in one branch would conditionally move it and leave
    // the refuse path with a running, unreferenced `claude`.
    let mut ours = Some(child);
    let superseded = {
        let manager = app.state::<ConciergeManager>();
        let mut slot = lock_turn(&manager.turn);
        let allowed = may_install(
            kind,
            token,
            RETIRE_BELOW.load(Ordering::Relaxed),
            slot.as_ref().map(|t| t.token),
        );
        // Total, not `expect` (roborev 53186): a panic here would fire while holding the turn
        // mutex, and `Child::drop` neither signals nor reaps — the failure mode of the assertion
        // would be exactly the orphaned process group this Option exists to prevent.
        match (allowed, ours.take()) {
            (true, Some(child)) => slot.replace(ConciergeTurn { child, token }),
            (_, kept) => {
                ours = kept;
                None
            }
        }
    };
    if let Some(mut orphan) = ours {
        // We never installed: the turn we just spawned is already superseded. Take it down rather
        // than leaving an unreferenced claude running with no cancel handle.
        tracing::info!(token, "concierge_turn: superseded before install; killing the new child");
        kill_turn_group(&mut orphan);
        return Err(SUPERSEDED_ERR.into());
    }
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
///
/// THE DELTA EMIT IS GATED TOO (roborev 53088/53105), not just the reap. It used to be
/// unconditional, so a superseded reader kept flushing whatever stdout it had already buffered
/// under its own id, interleaved with the turn that replaced it — and the frontend cannot sort
/// that out after the fact, because those deltas are emitted before `concierge_turn` returns and
/// Tauri gives no ordering guarantee between events and an invoke response. The gate is
/// `still_owns_turn`, which answers "does the user still want this?" from two facts: the
/// send-time retirement floor (RETIRE_BELOW — set BEFORE the replacement child is spawned, which
/// is the window a slot-only check misses) and the slot itself.
fn run_reader(
    app: &AppHandle,
    id: &str,
    token: u64,
    stdout: std::process::ChildStdout,
    stderr_handle: std::thread::JoinHandle<String>,
) -> TurnOutcome {
    drain_turn(app, id, stdout, stderr_handle, token, &|| still_owns_turn(app, token))
}

/// What one turn's stdout yielded, minus anything that needs an app handle.
struct DrainedStream {
    session_id: String,
    final_text: String,
    /// The streamed chunks, concatenated — the fallback text when no `result` carried a final.
    acc: String,
    result_subtype: Option<String>,
    is_error: bool,
    error_detail: Option<String>,
}

/// Parse a turn's NDJSON stdout to EOF, emitting each text chunk through `emit` — but ONLY while
/// `owns` says this turn is still the one the user is waiting on.
///
/// No AppHandle, so the gate is drivable in a test against the REAL loop (roborev 53105): the
/// previous test declared its own `false` and asserted that `if false {}` skips, which would have
/// stayed green with the production gate deleted.
///
/// The gate is checked once per LINE and LATCHED. Ownership is one-way — a superseded turn never
/// becomes live again — so after the first `false` there is nothing to re-ask, and the check is
/// per line rather than per chunk because `--include-partial-messages` makes a chunk roughly a
/// token while the check contends with the UI thread for the manager's mutex on every send.
/// Parsing continues either way, so `session_id`/`final_text` stay coherent for the caller's
/// ownership check.
fn drain_stream(
    stdout: impl std::io::Read,
    owns: &dyn Fn() -> bool,
    retired: &dyn Fn() -> bool,
    emit: &mut dyn FnMut(&str),
) -> DrainedStream {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(stdout);
    let mut session_id = String::new();
    let mut final_text = String::new();
    let mut acc = String::new();
    let mut result_subtype: Option<String> = None;
    let mut is_error = false;
    let mut error_detail: Option<String> = None;
    let mut line: Vec<u8> = Vec::new();
    let mut live = true;
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
                if live {
                    live = owns();
                }
                if let Ok(ev) = serde_json::from_str::<Value>(trimmed) {
                    handle_event(&ev, &mut session_id, &mut final_text, &mut acc, &mut |txt| {
                        // Two checks, deliberately: the per-line one above takes the manager's
                        // mutex and is hoisted out of the hot path, while this one is a relaxed
                        // atomic load — cheap enough to run per chunk, and it closes the window in
                        // which a send lands DURING this line's JSON parse (roborev 53130). One
                        // admitted chunk is the whole failure mode: a delta for a never-before-seen
                        // id paints a bubble that then never receives a terminal event.
                        if !live || retired() {
                            return;
                        }
                        emit(txt);
                    });
                    capture_result_status(&ev, &mut result_subtype, &mut is_error, &mut error_detail);
                } else {
                    tracing::debug!("concierge: skipped non-JSON stdout line");
                }
            }
            Err(_) => break,
        }
    }
    DrainedStream { session_id, final_text, acc, result_subtype, is_error, error_detail }
}

/// The drain loop, with the ownership gate INJECTED so it can be driven in a test — the previous
/// version's test asserted a locally-declared `false` and would have stayed green with the gate
/// deleted, which is the one regression it existed to prevent (roborev 53105).
fn drain_turn(
    app: &AppHandle,
    id: &str,
    stdout: impl std::io::Read,
    stderr_handle: std::thread::JoinHandle<String>,
    token: u64,
    owns: &dyn Fn() -> bool,
) -> TurnOutcome {
    let drained = drain_stream(
        stdout,
        owns,
        &|| is_retired(token, RETIRE_BELOW.load(Ordering::Relaxed)),
        &mut |txt| {
            let _ = app.emit(
                "concierge:delta",
                ConciergeDelta { id: id.to_string(), text: txt.to_string() },
            );
        },
    );
    let DrainedStream { session_id, final_text, acc, result_subtype, is_error, error_detail } =
        drained;

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
///
/// RETURNS the turn's id (the monotonic token as a string) — the same id every `concierge:*` event
/// for this turn carries, so the frontend can correlate a delta with its own done/error.
///
/// It is NOT the straggler guard (roborev 53105). It cannot be: an invoke response has no ordering
/// guarantee against the event channel, so it can lose to deltas already in flight. Retirement is
/// enforced at the source instead, by `reserve_turn_token()` below — the floor is this sender's
/// OWN token, published after the cheap fallible prep and before the spawn, so every earlier turn
/// is retired before the replacement child exists and `drain_stream`'s gate sees it. (Not
/// `retire_issued_turns`, which is the cancel path; and not "the instant the user sends" — the
/// prep runs first, deliberately, so a send that fails before spawning cannot silence a turn it
/// never replaced. roborev 53165.) The id is defence in depth on top.
#[tauri::command]
pub async fn concierge_turn(
    app: AppHandle,
    prompt: String,
    resume_session_id: Option<String>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("concierge_turn: prompt must be non-empty".into());
    }
    // Read BEFORE the prep below; re-read after it. A cancel in between is aimed at this send.
    let cancel_epoch = CANCEL_EPOCH.load(Ordering::Relaxed);
    let claude_path = cached_claude_path()
        .ok_or_else(|| "concierge_turn: claude binary not found (is Claude Code installed?)".to_string())?;
    // The concierge runs in the app-data dir — NOT a repo worktree (it observes; it doesn't own
    // a checkout). The dir is created by the app at startup, but ensure it exists so a fresh
    // install can't fail the spawn on a missing cwd.
    let cwd = crate::dev_identity::app_data_dir(&app).map_err(|e| format!("concierge_turn: {e}"))?;
    std::fs::create_dir_all(&cwd).map_err(|e| format!("concierge_turn: app data dir unavailable: {e}"))?;

    // Reserve + retire HERE: after the fallible prep, immediately before the spawn.
    //
    // Not at the top of the command (roborev 53130): the path lookup, the app-data dir and
    // `create_dir_all` can all fail, and retirement is not rolled back — so a send that never
    // spawned would leave the previous turn permanently silenced but still RUNNING (nothing killed
    // it, since `spawn_turn` never ran), burning a claude process while its reply stopped
    // mid-sentence and the typing indicator hung for the session. Those steps are cheap; the
    // process spawn below is the window that actually matters, and it is still fully covered.
    // Reserve FIRST, then check (roborev 53181). Checking first leaves a gap exactly one
    // instruction wide: cancel can bump the epoch after our read and floor at `TURN_SEQ` before
    // our `fetch_add`, so the floor lands ON the token we then take, `is_retired` is false, the
    // slot is empty so cancel killed nothing — and the turn spawns as if Escape was never pressed.
    // With the reservation first, every cancel falls on one side by construction: it either bumps
    // the epoch before our read (refused here) or loads TURN_SEQ after our fetch_add, flooring
    // above us so the install guard refuses.
    let token = reserve_turn_token();
    if cancelled_during_prep(cancel_epoch) {
        tracing::info!("concierge_turn: cancelled before spawn; not starting the turn");
        // The floor has risen by now, so the previous turn is retired: same teardown as any other
        // post-reservation failure, and same rule — only a turn older than ours.
        let ours_to_kill = {
            let manager = app.state::<ConciergeManager>();
            let mut slot = lock_turn(&manager.turn);
            if mine_to_tear_down(token, slot.as_ref().map(|t| t.token)) {
                slot.take()
            } else {
                None
            }
        };
        if let Some(mut turn) = ours_to_kill {
            kill_turn_group(&mut turn.child);
        }
        return Err(CANCELLED_ERR.into());
    }
    let blk_app = app.clone();
    let blk_prompt = prompt.clone();
    let blk_resume = resume_session_id.clone();
    let blk_cwd = cwd.clone();
    let blk_claude = claude_path.clone();
    let spawned = tauri::async_runtime::spawn_blocking(move || {
        spawn_turn(
            &blk_app,
            &blk_prompt,
            &blk_cwd,
            &blk_claude,
            blk_resume.as_deref(),
            TurnKind::Send,
            token,
        )
    })
    .await
    .map_err(|e| format!("concierge_turn task failed: {e}"))
    .and_then(|r| r);
    // ANY failure after the floor was published (the spawn itself, a missing pipe, a join error)
    // leaves the previous turn retired — muted by the gate — but still RUNNING, because
    // `slot.replace` never happened: a claude process burning on, its reply stopped mid-sentence,
    // and its `done` dropped by the frontend's own send-time floor, so the typing indicator hangs
    // for the session (roborev 53165). A `fetch_max` floor cannot be rolled back, so teardown is
    // the only coherent direction: make "the previous turn is dead" true.
    let (stdout, stderr, token) = match spawned {
        Ok(v) => v,
        Err(e) => {
            // ONLY a turn strictly older than ours (roborev 53186). "Take whatever is in the slot"
            // kills the LIVE turn on the most likely path into here: A refuses to install because
            // B already owns the floor and the slot, and then this teardown pulls B out and kills
            // it — the newest question dying unanswered with no terminal event, which is the whole
            // failure this guard exists to prevent. A newer occupant is not ours to clean up: it
            // owns both the floor and the slot, so there is nothing of ours left behind.
            let ours_to_kill = {
                let manager = app.state::<ConciergeManager>();
                let mut slot = lock_turn(&manager.turn);
                if mine_to_tear_down(token, slot.as_ref().map(|t| t.token)) {
                    slot.take()
                } else {
                    None
                }
            };
            if let Some(mut turn) = ours_to_kill {
                tracing::info!(
                    "concierge_turn failed after retiring the previous turn; killing it rather \
                     than leaving it silenced and running"
                );
                kill_turn_group(&mut turn.child);
            }
            return Err(e);
        }
    };

    let started_id = token.to_string();
    let read_app = app.clone();
    std::thread::spawn(move || {
        let id = token.to_string();
        let stderr_handle = drain_stderr(stderr);
        let outcome = run_reader(&read_app, &id, token, stdout, stderr_handle);
        // Superseded / cancelled mid-turn: the frontend already tore down. Stay silent, no retry.
        if !outcome.owned {
            return;
        }

        // A retry is a self-heal for a turn the user is still waiting on. If they have moved on,
        // it must not run at all: `spawn_turn` would take the slot from — and kill — the live turn
        // (roborev 53147). The reap above consults the slot only, so `owned` can still be true here
        // for a turn the floor has already retired.
        //
        // The floor is tested against OUR OWN token, and that is now the whole of it (roborev
        // 53397): the retry runs under this turn's token rather than a fresh one, so there is no
        // second, higher token to reason about and no reserve-versus-read gap to order. Whatever
        // the floor says here, the install site is the backstop — see `continuation_install`.
        let retired = is_retired(token, RETIRE_BELOW.load(Ordering::Relaxed));
        if retired {
            tracing::info!(id = %id, "concierge: turn was superseded; not retrying the stale resume");
        }
        if !retired && should_retry_without_resume(outcome.ok, resume_session_id.as_deref()) {
            tracing::info!(
                id = %id,
                "concierge_turn: turn failed with a resume session id; retrying once without --resume"
            );
            let (kind2, token2) = continuation_install(token);
            match spawn_turn(&read_app, &prompt, &cwd, &claude_path, None, kind2, token2) {
                Ok((stdout2, stderr2, installed)) => {
                    let stderr_handle2 = drain_stderr(stderr2);
                    // Emit the retry under the ORIGINAL `id`: the self-heal is a transparent
                    // continuation of the same logical turn, so the original id always receives a
                    // terminal event (no bubble left permanently in-progress if the first run
                    // streamed a delta before failing), and the `done` carries the full final text.
                    // The ownership token is the same one — id and token now agree, which is the
                    // point of `continuation_install`.
                    let retry = run_reader(&read_app, &id, installed, stdout2, stderr_handle2);
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

    Ok(started_id)
}

/// Cancel the in-flight concierge turn — the whole process group, so nothing it spawned keeps
/// running. A no-op if none is in flight. The reader thread finds the slot token changed (entry
/// gone) on EOF and stays silent, so no late done/error races the cancel.
#[tauri::command]
pub fn concierge_cancel(manager: State<ConciergeManager>) -> Result<(), String> {
    // Same floor as a send: a cancelled turn must go quiet immediately, not merely lose the slot.
    retire_issued_turns();
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

    /// The comparison itself (the relationship between the floor and a real reservation is covered
    /// by the two tests below, which drive the actual functions).
    #[test]
    fn a_send_retires_every_turn_issued_before_it() {
        // Tokens 5 and 6 are in flight; the user sends again and that send takes token 7.
        assert!(is_retired(5, 7));
        assert!(is_retired(6, 7));
        // Its own floor must not retire it…
        assert!(!is_retired(7, 7));
        // …nor anything after it.
        assert!(!is_retired(8, 7));
        // Nothing is retired before the first send.
        assert!(!is_retired(1, 0));
    }

    /// The turn statics are process globals and cargo runs tests in parallel, so every test that
    /// touches TURN_SEQ / RETIRE_BELOW takes this first (roborev 53147).
    static TEST_SEQ_LOCK: Mutex<()> = Mutex::new(());

    /// Reserve-THEN-publish, monotonic, and driving the REAL functions — a local re-implementation
    /// would stay green with `reserve_turn_token` reverted or its call deleted, which is the whole
    /// regression (roborev 53147; the same criticism accepted one level down last round).
    #[test]
    fn two_concurrent_sends_still_retire_the_older_one() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Interleaved worst case: both sends reserve before either has spawned anything.
        let a = reserve_turn_token();
        let b = reserve_turn_token();
        assert!(a < b);
        let floor = RETIRE_BELOW.load(Ordering::Relaxed);
        assert!(is_retired(a, floor), "the send that arrived first must be retired by the second");
        assert!(!is_retired(b, floor), "the newest send is the live one");

        // A continuation (the stale-resume retry) claims NO token of its own — it reuses the one its
        // turn was sent under — so it can neither silence nor outrank a turn the user sent while
        // the first attempt was failing (roborev 53397).
        let seq_before = TURN_SEQ.load(Ordering::Relaxed);
        let (kind, cont) = continuation_install(a);
        assert_eq!((kind, cont), (TurnKind::Continuation, a));
        assert_eq!(TURN_SEQ.load(Ordering::Relaxed), seq_before, "a continuation takes no token");
        assert_eq!(RETIRE_BELOW.load(Ordering::Relaxed), floor, "a continuation publishes no floor");
        assert!(!is_retired(b, RETIRE_BELOW.load(Ordering::Relaxed)));
    }

    /// A send that fails AFTER publishing its floor tears down only what IT retired. Killing
    /// "whatever is in the slot" takes out the live turn on the most likely path in — an older
    /// send refusing to install because a newer one already owns the floor and the slot
    /// (roborev 53186).
    #[test]
    fn a_failed_send_kills_only_a_turn_older_than_itself() {
        // The REAL function both teardown sites call (roborev 53205).
        // The previous turn, which our floor retired: ours to take down.
        assert!(mine_to_tear_down(6, Some(5)));
        // A NEWER turn owns both the floor and the slot — killing it is how a refused older send
        // murders the turn the user is waiting on.
        assert!(!mine_to_tear_down(5, Some(6)));
        // Nothing installed at all.
        assert!(!mine_to_tear_down(5, None));
        // Our own entry can't be there: we failed before installing.
        assert!(!mine_to_tear_down(5, Some(5)));
    }

    /// The two sentinels are matched by the FRONTEND (apps/desktop/src/services/concierge.ts,
    /// `SUPERSEDED_DETAILS`) to keep a superseded or cancelled send silent. Nothing else ties the
    /// two languages together, so reword either side and the frontend quietly stops matching —
    /// fast second sends go back to posting "I couldn't reach my brain just now" and clearing the
    /// typing indicator for the turn that is still streaming (roborev 53205).
    ///
    /// This test pins the RUST side. The TS side is pinned by its own literal assertion — the
    /// `it("pins the sentinel literals Rust emits, …")` case in concierge.test.ts — NOT by the fact
    /// that its other tests import the constant (roborev 53392): importing it and feeding it back
    /// into its own matcher is tautological and stays green through any reword. The two mirrored
    /// literal assertions are the whole guard, so neither may be deleted as "duplication".
    #[test]
    fn the_silent_outcome_sentinels_are_the_strings_the_frontend_matches() {
        assert_eq!(SUPERSEDED_ERR, "concierge_turn: superseded before install");
        assert_eq!(CANCELLED_ERR, "concierge_turn: cancelled");
    }

    /// The REAL drain loop, gate injected: emissions stop the moment ownership is lost, MID-STREAM,
    /// and the parse keeps running so the reap sees a coherent turn. The constant-closure tests
    /// below cannot cover this — hoisting the per-line check out of the loop leaves them green
    /// while a superseded reader flushes the rest of its buffer (roborev 53181; I deleted this test
    /// by writing the cancel cases over it and did not notice, which is exactly its point).
    #[test]
    fn the_drain_goes_quiet_the_moment_ownership_is_lost() {
        let ndjson = concat!(
            r#"{"type":"system","subtype":"init","session_id":"sess-Q"}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"live "}}}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"and retired"}}}"#, "\n",
            r#"{"type":"result","subtype":"success","session_id":"sess-Q","result":"live and retired"}"#, "\n",
        );
        // Ownership is lost after the reader has already asked twice — mid-stream, as a send lands
        // while the previous turn is talking.
        let asks = AtomicU64::new(0);
        let owns = || asks.fetch_add(1, Ordering::Relaxed) < 2;
        let mut seen: Vec<String> = Vec::new();

        let out = drain_stream(ndjson.as_bytes(), &owns, &|| false, &mut |t| seen.push(t.to_string()));

        assert_eq!(seen, vec!["live "], "everything after the supersede must be silent");
        // Parsing continued regardless, so the reap's ownership check sees a coherent turn.
        assert_eq!(out.session_id, "sess-Q");
        assert_eq!(out.final_text, "live and retired");
        // Latched: once lost, the gate stops taking the manager's mutex (4 lines, 3 asks).
        assert_eq!(asks.load(Ordering::Relaxed), 3);
    }

    /// Cancel while a send is still PREPARING — the state neither the floor nor the slot can
    /// describe, because that send has neither a token nor a child yet. Drives the REAL
    /// `cancelled_during_prep` the command calls (roborev 53147/53181).
    #[test]
    fn a_cancel_during_the_prep_stops_the_send_that_had_not_started() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // What concierge_turn reads on entry, before the claude-path lookup and the cwd prep.
        let on_entry = CANCEL_EPOCH.load(Ordering::Relaxed);
        assert!(!cancelled_during_prep(on_entry), "an uneventful send proceeds");

        retire_issued_turns(); // Escape, while that prep is in flight
        assert!(
            cancelled_during_prep(on_entry),
            "a cancel must be visible to a send that has not reached its reservation",
        );

        // A send that starts AFTER the cancel is unaffected by it.
        let fresh = CANCEL_EPOCH.load(Ordering::Relaxed);
        let _ = reserve_turn_token();
        assert!(!cancelled_during_prep(fresh));
    }

    /// The install decision — the rule that keeps "who owns the slot" agreeing with "who owns the
    /// floor". Two sends race on separate threads and their spawns can finish out of order, so an
    /// unconditional replace lets an OLDER turn stomp the newer one's entry and kill the child the
    /// user is waiting on (roborev 53165).
    #[test]
    fn an_older_or_retired_turn_never_takes_the_slot() {
        // The REAL function the install site calls (roborev 53186) — a local copy would have
        // stayed green with that call deleted.
        // The live turn installs over an older entry.
        assert!(may_install(TurnKind::Send, 6, 6, Some(5)));
        // …but the older one, spawning a moment later, must NOT stomp it.
        assert!(!may_install(TurnKind::Send, 5, 6, Some(6)));
        // Retired even with an empty slot (the floor moved while we were spawning).
        assert!(!may_install(TurnKind::Send, 5, 6, None));
        // First turn of the session.
        assert!(may_install(TurnKind::Send, 1, 0, None));
        // Equal tokens cannot happen (each reservation is unique), but re-installing over yourself
        // is not a supersession either way.
        assert!(may_install(TurnKind::Send, 7, 7, Some(7)));
    }

    /// The stale-resume retry installs under a STRICTER rule than a send: any occupant at all wins
    /// (roborev 53397). Token order cannot stand in for it — the continuation's token predates that
    /// occupant by construction, and the fresh token the retry used to draw was numerically ABOVE
    /// every send in existence, which is how it came to kill a live turn.
    #[test]
    fn a_continuation_never_installs_over_an_occupied_slot() {
        // The reap that precedes the retry emptied the slot itself, so this is the normal case.
        assert!(may_install(TurnKind::Continuation, 5, 5, None));

        // A send landed while the first attempt was failing and has already installed. The retry
        // must stand down — killing turn 6's child strands the user's newest question, which gets
        // no terminal event at all, while the retry answers the PREVIOUS one under a retired id.
        assert!(!may_install(TurnKind::Continuation, 5, 6, Some(6)));

        // THE REGRESSION ITSELF: the old code drew a fresh token for the retry, so it presented at
        // the install site numerically ABOVE the live send it was about to stomp — and a
        // send-shaped rule ("refuse only a strictly newer occupant") waves that straight through.
        // Both halves of the fix are needed for this line: the kind-aware rule, and a token that no
        // longer outranks a send.
        assert!(!may_install(TurnKind::Continuation, 7, 6, Some(6)));
        // Same shape with the slot older still — a continuation is never anyone's cleanup crew.
        assert!(!may_install(TurnKind::Continuation, 7, 0, Some(1)));

        // A send in the same position DOES install: it owns the floor, and the occupant is a turn
        // its own floor retired. The two rules genuinely differ, so neither can be dropped.
        assert!(may_install(TurnKind::Send, 7, 7, Some(6)));

        // The floor still comes first, whatever the kind.
        assert!(!may_install(TurnKind::Continuation, 5, 6, None));
    }

    /// Cancel still retires everything already RESERVED — the turns that do have a token, whether
    /// or not their child has spawned.
    #[test]
    fn cancel_retires_every_reserved_turn() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let live = reserve_turn_token();
        assert!(!is_retired(live, RETIRE_BELOW.load(Ordering::Relaxed)));
        retire_issued_turns();
        assert!(is_retired(live, RETIRE_BELOW.load(Ordering::Relaxed)));
    }

    /// The per-CHUNK floor check: a send that lands during a line's parse still silences that
    /// line's chunks. The per-line check is hoisted for the mutex, so this is the half that closes
    /// the parse-width window — and one admitted chunk is the whole failure mode, since a delta for
    /// a never-before-seen id paints a bubble that never gets a terminal event (roborev 53130).
    #[test]
    fn a_send_landing_mid_parse_still_silences_that_line() {
        let ndjson = concat!(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"too late"}}}"#, "\n",
        );
        let mut seen: Vec<String> = Vec::new();
        // Owns the slot (the replacement child has not spawned yet) but the floor has already risen.
        let out = drain_stream(ndjson.as_bytes(), &|| true, &|| true, &mut |t| seen.push(t.to_string()));
        assert!(seen.is_empty(), "a retired turn must not emit even while it holds the slot: {seen:?}");
        assert_eq!(out.acc, "too late", "…and the parse still ran");
    }

    /// The floor and the token come from the SAME reservation — the relationship the previous test
    /// only asserted in a comment (roborev 53130). Exercises the real statics.
    #[test]
    fn a_reserved_token_is_live_and_retires_the_one_before_it() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let first = reserve_turn_token();
        assert!(!is_retired(first, RETIRE_BELOW.load(Ordering::Relaxed)), "a send's own token is live");
        let second = reserve_turn_token();
        assert!(second > first);
        let floor = RETIRE_BELOW.load(Ordering::Relaxed);
        assert!(is_retired(first, floor), "the newer send retires the older turn immediately");
        assert!(!is_retired(second, floor));
        // `first` failed with a stale resume id and retries. The continuation runs under `first`'s
        // OWN token, so `second`'s floor retires it — the retry of a question the user has moved on
        // from does not run (roborev 53397). A fresh token here would have landed ABOVE `second` and
        // sailed through this very check.
        let (kind, cont) = continuation_install(first);
        assert_eq!(kind, TurnKind::Continuation);
        assert_eq!(cont, first, "a continuation reuses its turn's token; it does not mint one");
        assert!(cont < second);
        assert_eq!(RETIRE_BELOW.load(Ordering::Relaxed), floor, "a continuation publishes no floor");
        assert!(is_retired(cont, floor), "a send after the failure retires the retry");
        assert!(!is_retired(second, RETIRE_BELOW.load(Ordering::Relaxed)));
    }

    /// A reader that has ALREADY lost the slot when the drain starts says nothing at all.
    #[test]
    fn a_reader_that_never_owned_the_turn_emits_nothing() {
        let ndjson = concat!(
            r#"{"type":"system","subtype":"init","session_id":"sess-OLD"}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"the dead turn's buffered output"}}}"#, "\n",
        );
        let mut seen: Vec<String> = Vec::new();
        let out = drain_stream(ndjson.as_bytes(), &|| false, &|| false, &mut |t| seen.push(t.to_string()));
        assert!(seen.is_empty(), "a superseded reader must not emit: {seen:?}");
        assert_eq!(out.session_id, "sess-OLD");
        assert_eq!(out.acc, "the dead turn's buffered output");
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

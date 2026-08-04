//! Per-agent git worktree isolation (§5 agent lifecycle). Each agent runs in its
//! OWN git worktree on its OWN branch so agents can't clobber each other's files.
//! All git mechanics are hidden from the user — Sparkle frames this as "each agent
//! works in its own safe space" (§2). The hidden worktrees live OUTSIDE the project
//! tree, under `<app_data>/worktrees/<projectId>/<agentId>` (see `worktree_path`), on
//! branch `sparkle/agent-<agentId>`.
//!
//! Dependency-free: we shell out to the system `git` via std::process::Command.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// A frontend-supplied id component (project_id / agent_id / worker_id) that gets joined into a
/// filesystem path AND embedded into a git branch name. These are UUIDs in practice, so we hold
/// them to a strict allowlist: anything with `/`, `..`, a leading `-`, or other path/option
/// metacharacters is rejected before it can escape `<app_data>/worktrees` or weaponize a git arg.
fn validate_id(label: &str, id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err(format!("invalid {label}: must be 1-128 chars"));
    }
    if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(format!("invalid {label}: only [A-Za-z0-9_-] allowed"));
    }
    Ok(())
}

/// Validate a frontend/agent-supplied git ref before it reaches `git` as an argument. Every caller
/// passes a BRANCH NAME (never a rev expression like `HEAD~1`), so this checks branch-name shape.
/// Names legitimately contain `/` (e.g. `release/2026`), so we don't allowlist; we reject the
/// shapes that turn a ref into a weaponized argument:
///
///   * a leading `-` — parsed as an option (`--upload-pack=` on fetch, `--exec=` on rebase →
///     command execution);
///   * a leading `+` and any `:` — the two halves of a REFSPEC. `git fetch origin <arg>` reads its
///     argument as `<src>:<dst>`, so `+refs/heads/evil:refs/heads/main` is not a branch to fetch
///     but an instruction to force-overwrite a LOCAL ref. Sparkle reaches that sink automatically
///     (the background status poll's origin refresh, and parking an agent worktree), and a base can
///     arrive from a `.sparkle/config.toml` checked into a repo the user merely opened — so this
///     shape would clobber a branch holding committed-but-unpushed work with no user action at all;
///   * the remaining characters and sequences git itself forbids in a ref name (`~ ^ ? * [ \`, `..`,
///     whitespace/control).
///
/// Nothing legitimate is lost: `git check-ref-format` rejects all of the above too, so a name that
/// fails here could never have named a real branch.
fn validate_ref(branch: &str) -> Result<(), String> {
    let b = branch.trim();
    if b.is_empty() {
        return Err("empty git ref".into());
    }
    if b.starts_with('-') || b.starts_with('+') {
        return Err(format!("refusing git ref starting with '-'/'+': {b:?}"));
    }
    if b.bytes().any(|c| c.is_ascii_control() || c == b' ') {
        return Err(format!("git ref has whitespace/control chars: {b:?}"));
    }
    let forbidden = |c: u8| matches!(c, b':' | b'~' | b'^' | b'?' | b'*' | b'[' | b'\\');
    if b.bytes().any(forbidden) || b.contains("..") {
        return Err(format!("git ref has characters git forbids in a ref name: {b:?}"));
    }
    Ok(())
}

/// Absolute path to an agent's worktree, OUTSIDE the project tree, under Sparkle's app-data
/// dir. Keyed by project_id (a UUID) so same-named project folders never collide. Validates both
/// id components (Err on path-traversal / metacharacters) so a malicious id can't escape the dir.
pub fn worktree_path(app_data: &Path, project_id: &str, agent_id: &str) -> Result<PathBuf, String> {
    validate_id("project_id", project_id)?;
    validate_id("agent_id", agent_id)?;
    Ok(app_data.join("worktrees").join(project_id).join(agent_id))
}

/// Resolve Sparkle's per-user app-data dir (e.g. ~/Library/Application Support/ai.sparkle.desktop).
/// Routes through `dev_identity` so DEBUG builds get the isolated `-dev` sibling and never mutate
/// production workspace state.
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::dev_identity::app_data_dir(app)
}

/// Public wrapper around `app_data_dir` for use by other modules (e.g. bridge.rs).
pub fn app_data_dir_pub(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_dir(app)
}

#[derive(Serialize)]
pub struct WorktreeInfo {
    /// Absolute path to the agent's isolated worktree directory.
    path: String,
    /// Branch the worktree is checked out on (e.g. `sparkle/agent-<id>`).
    branch: String,
}

/// Run `git -C <cwd> <args...>`, returning trimmed stdout on success or an Err
/// Force every git invocation to fail fast instead of blocking on an interactive
/// credential/host-key/passphrase prompt — a hung subprocess would otherwise freeze the
/// command the UI awaits and defeat the documented "fall back to local branch" path.
fn apply_noninteractive(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "true");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    #[cfg(test)]
    apply_test_hook_isolation(cmd);
}

/// TEST-ONLY: keep the suite's throwaway fixture repos from firing the developer's git hooks.
///
/// The suite builds real git repos under the system temp dir, commits into them (and into linked
/// worktrees cut from them), then deletes the directory. A developer with a GLOBAL
/// `core.hooksPath` — which is how the roborev review loop installs itself, and how Sparkle's own
/// `AGENTS.md` workflow expects it to be installed — has those hooks fire inside every one of
/// those fixtures. A post-commit hook that enqueues a code review then queues one job per fixture
/// commit against a directory that is gone by the time a worker picks it up, so each job burns its
/// full retry budget and dies. One `cargo test --lib` run injects dozens; they accumulate into
/// thousands of permanently-failed jobs that occupy worker slots and bury the real review signal.
///
/// The hook's own skip heuristics are not a substitute. They match on the basename of
/// `--show-toplevel`, so they can only recognise a fixture whose repo IS the tagged root; a commit
/// made inside a linked worktree reports that worktree's arbitrary basename and is never matched.
/// They are also not durable — the hook is rewritten wholesale by its tool's self-update.
///
/// So suppress at the only layer that is both complete and ours: `GIT_CONFIG_*` env overrides,
/// which git applies with the same precedence as `-c` and which therefore beat config at every
/// level, on every subcommand, regardless of argument order.
///
/// `#[cfg(test)]` — the production binary never compiles this, and user repos keep their hooks.
#[cfg(test)]
pub(crate) fn apply_test_hook_isolation(cmd: &mut Command) {
    cmd.env("GIT_CONFIG_COUNT", "1");
    cmd.env("GIT_CONFIG_KEY_0", "core.hooksPath");
    // A path that can never BE a directory, rather than merely one we expect to be absent: on unix
    // `/dev/null` is a character device, so resolving any child of it fails with ENOTDIR and git
    // finds no hook of any name. Deliberately not a predictable name under the temp dir — that is
    // shared and world-writable on Linux, so another process could create it and have the suite
    // execute whatever it put there. Elsewhere this is simply a path that does not exist, which is
    // the same outcome.
    cmd.env("GIT_CONFIG_VALUE_0", "/dev/null/sparkle-hooks-disabled");
}

/// carrying stderr (falling back to stdout) on failure.
///
/// `pub(crate)` so `fleet.rs` reads its Level 0 git observations through the SAME runner: the
/// non-interactive env (`apply_noninteractive`) disables hooks, credential prompts and pagers, and
/// a second git invocation elsewhere in the crate that forgot any one of those would hang the
/// digest on a credential prompt instead of returning.
pub(crate) fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.arg("-C").arg(cwd).args(args);
    apply_noninteractive(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        };
        Err(format!("git {} failed: {msg}", args.join(" ")))
    }
}

/// Wall-clock ceiling for the NETWORK-touching subprocesses (`git fetch`, `gh`). On a network
/// partition such a child otherwise hangs for the OS default (~75s+ TCP timeout), and since
/// `project_agents_status` runs these per changed agent on a ~30s poll, stuck children pile up on
/// Tauri's blocking pool. Only the network touches go through this deadline — local ref reads
/// (rev-parse, status of local worktrees, merge-base) are unaffected and stay on the plain `git()`.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(15);

/// How long we'll wait for the drain threads to finish AFTER the child has exited or been killed.
///
/// THE BUG THIS BOUNDS: `Child::kill` only reaches the DIRECT child. A grandchild it forked (a
/// `git clone` under `claude plugin install`, an `npm` helper) inherits the same stdout/stderr write
/// ends, so those pipes stay open and a reader blocked in `read` never sees EOF — the deadline
/// expires, we kill, and then block FOREVER joining a reader. With `output_with_timeout` called
/// under the plugin-install mutex, that wedges every later pass. The process-group kill below is the
/// primary fix (it reaches the grandchild); this grace is the backstop for the case where even that
/// misses — a grandchild that re-parented itself into another group, or the non-unix path. Two
/// seconds is far more than a drained pipe needs (the readers have been running all along) and far
/// less than any caller's own deadline.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// How long the readers get to reach EOF ON THEIR OWN after a child exits normally, before we
/// conclude something else is holding the write ends and kill the group to release them.
///
/// Deliberately short, and paid only when a pipe really is held: everything the command wrote is
/// already in the pipe by the time it exits, so a healthy capture joins here in microseconds.
/// Waiting out the full [`DRAIN_GRACE`] first — let alone whatever remains of the caller's deadline
/// — would spend seconds on the path that runs every single time, for a command that finished in
/// 200ms.
const POST_EXIT_SETTLE: Duration = Duration::from_millis(250);

/// Cap on what a drain thread may RETAIN, per stream. A pipe held open by a long-lived grandchild
/// (an ssh ControlMaster lives for hours) means the thread outlives its caller; without a bound it
/// would append into a buffer nobody will ever read for the life of the holder — and these captures
/// run on ~30s polls, so the threads stack up. 4 MiB is far past any output a caller actually
/// parses.
///
/// The real ceiling is this plus one 8 KiB chunk, per stream, so ~2x that for a capture with both
/// pipes. Overshoot by a chunk, not by the megabyte.
///
/// Hitting it is REPORTED, never silent: see [`Drain::truncated`]. Dropping bytes while
/// `drain_complete` stayed true handed the strict [`output_with_timeout`] a plausible-looking
/// prefix with `status.success()` — the exact failure that form exists to make impossible.
///
/// What survives is the TAIL, not the head: past the cap the front half of the buffer is dropped
/// and appending continues. For both callers that read this text — a failed `gh pr merge`, a failed
/// `claude plugin install` — the reason a command failed is the LAST thing it wrote, so keeping the
/// head would have guaranteed the loss of exactly the bytes the message exists to carry.
/// The cap that governs in a build a user runs, defined UNCONDITIONALLY so nothing has to restate
/// it. `review_cmd`'s row-ceiling test needs the release figure specifically — the `#[cfg(test)]`
/// arm below is deliberately 8× smaller — and it used to hand-copy `4 << 20` with a "keep in step"
/// comment. A number copied rather than referenced drifts silently in the unsafe direction: lower
/// this and that test would keep asserting against the old value and keep passing, which reads as
/// proof the ceiling is safe when it no longer is (roborev 55466).
pub(crate) const RELEASE_DRAIN_BUF_CAP: usize = 4 << 20;
#[cfg(not(test))]
const DRAIN_BUF_CAP: usize = RELEASE_DRAIN_BUF_CAP;
/// Small enough that a test can reach it without writing 4 MiB. `cap_is_above_the_kept_whole_fixture`
/// pins the relationship to the "kept whole" fixture, so a bigger fixture fails as a clear
/// assertion rather than as a mystery `expect()` on the capped path.
#[cfg(test)]
const DRAIN_BUF_CAP: usize = 512 << 10;

/// One pipe's drain: the shared buffer and the two ways its contents can be INCOMPLETE.
struct Drain {
    buf: Arc<Mutex<Vec<u8>>>,
    /// Set once the cap forced bytes out of the buffer. The thread keeps reading (so the child
    /// never blocks on a full pipe) and keeps the tail; this flag is what stops the loss from
    /// passing as a complete capture.
    truncated: Arc<AtomicBool>,
    /// Set when a read failed mid-stream (EIO on a pty-backed pipe, a bad fd after an exotic kill).
    /// Without it that path returned early and the capture looked JOINED and uncapped — a
    /// mid-stream prefix reported as the whole output, which is the same lie as the cap by a third
    /// route, and the one that needs neither a grandchild nor 4 MiB to happen.
    read_error: Arc<AtomicBool>,
    /// Set by [`take_drained`] once the caller has its snapshot. From then on the thread reads and
    /// DISCARDS: keeping the tail only helps someone who will read it, and an abandoned thread
    /// (an ssh ControlMaster holds the pipe for hours while ~30s polls stack more threads up)
    /// would otherwise refill a whole cap's worth of bytes nobody will ever look at.
    abandoned: Arc<AtomicBool>,
}

/// Drain one pipe into a SHARED buffer on its own thread.
///
/// The buffer is shared (rather than returned via `join`) precisely so the caller never has to join
/// to get the bytes: on a wedged pipe we abandon the thread and still report everything read so far.
/// Chunked reads (not `read_to_end`) are what make that snapshot non-empty.
fn spawn_drain<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
) -> (Drain, std::thread::JoinHandle<()>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let read_error = Arc::new(AtomicBool::new(false));
    let abandoned = Arc::new(AtomicBool::new(false));
    let sink = Arc::clone(&buf);
    let overflowed = Arc::clone(&truncated);
    let errored = Arc::clone(&read_error);
    let given_up_on = Arc::clone(&abandoned);
    let handle = std::thread::spawn(move || {
        let Some(mut s) = pipe else { return };
        let mut chunk = [0u8; 8192];
        loop {
            match s.read(&mut chunk) {
                Ok(0) => return,
                // EINTR is not EOF. `read_to_end` — which this loop replaced — retries on it; a
                // bare `Err(_) => return` would abandon the rest of the stream when a signal
                // happens to land mid-read, and the caller would parse the truncated bytes as
                // complete. That failure needs no grandchild at all, so it must be handled here.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    // Release, and the caller loads with Acquire: `await_threads` polls
                    // `is_finished` instead of joining, so nothing else in this path establishes
                    // happens-before between this store and the read of the flag.
                    errored.store(true, Ordering::Release);
                    return;
                }
                Ok(n) => {
                    let mut b = sink.lock().unwrap_or_else(|e| e.into_inner());
                    // Checked INSIDE the critical section: `take_drained` sets the flag and empties
                    // the buffer under this same lock, so a check before acquiring it could pass,
                    // lose the race, and append a chunk into the buffer nobody will read again.
                    // Keep draining so the child never blocks on a full pipe — just stop retaining.
                    if given_up_on.load(Ordering::Acquire) {
                        continue;
                    }
                    if b.len() + n > DRAIN_BUF_CAP {
                        // Keep the TAIL: drop the front half and carry on appending, so the buffer
                        // stays bounded while the newest output — where a failure reason lives —
                        // survives.
                        let drop_to = (DRAIN_BUF_CAP / 2).min(b.len());
                        b.drain(..drop_to);
                        overflowed.store(true, Ordering::Release);
                    }
                    b.extend_from_slice(&chunk[..n]);
                }
            }
        }
    });
    (Drain { buf, truncated, read_error, abandoned }, handle)
}

/// Take whatever a drain thread has read so far, and tell it to stop retaining: this is the last
/// read of that buffer, so anything it kept afterwards would be unreachable bytes held for as long
/// as whatever is holding the pipe open lives.
fn take_drained(drain: &Drain) -> Vec<u8> {
    // Flag and buffer are touched under ONE lock acquisition, so "abandoned ⇒ nothing accumulates
    // afterwards" is an invariant rather than a race the caller usually wins.
    let mut b = drain.buf.lock().unwrap_or_else(|e| e.into_inner());
    drain.abandoned.store(true, Ordering::Release);
    std::mem::take(&mut *b)
}

/// Has the child exited — WITHOUT reaping it?
///
/// The distinction is load-bearing, not fastidious. [`std::process::Child::try_wait`] REAPS, which
/// releases the pid, and with it the process-GROUP id once the group is empty. That is fatal for
/// the post-exit group kill in [`output_with_timeout_lenient`], because the case that kill exists
/// for is a descendant still holding the pipes: if it escaped the group (it `setsid`'d, or an fd
/// was handed to a daemon) the group is EMPTY, the pgid is free for reuse, and
/// `kill(-pid, SIGKILL)` can land on whatever unrelated process group has since taken it. Every
/// other [`crate::proc::kill_process_group`] call site signals a child that is still un-reaped;
/// this keeps the post-exit path honest to the same invariant.
///
/// `WNOWAIT` leaves the child waitable — it stays a zombie, and a zombie is still a MEMBER of its
/// process group — so the kernel keeps the pid reserved and `-pid` provably still names OUR group.
/// The caller reaps with `Child::wait` afterwards.
///
/// `waitid`, not `waitpid`: Darwin defines `WNOWAIT` but its `waitpid` rejects it with `EINVAL` —
/// the flag is only honored by `waitid` there. `waitid` takes it on both platforms, so one call
/// covers the dev machine and Linux CI.
///
/// Non-unix falls back to `try_wait` (which does reap): there is no group kill on that path, so
/// nothing depends on the pid staying reserved, and a later `Child::wait` still returns the status
/// std cached at the reap.
fn exited_without_reaping(child: &mut std::process::Child) -> Result<bool, String> {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::id_t;
        loop {
            // Zeroed, then read back: with `WNOHANG` and nothing to report, POSIX leaves the
            // struct's fields untouched, so "did anything happen?" IS "did `si_signo` become
            // non-zero (SIGCHLD)?". `si_signo` is a plain public field on both macOS and Linux;
            // `si_pid` is a field on one and an accessor method on the other, which is why the
            // check reads the signal instead.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // SAFETY: `child` is our own direct, un-reaped child, so its pid is ours to wait on.
            // `WNOWAIT` means this does NOT consume the exit status — `Child::wait` still reaps it
            // afterwards — and `info` is a live, correctly-sized, zero-initialized `siginfo_t`.
            let r = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if r != 0 {
                let e = std::io::Error::last_os_error();
                // Retried, exactly as std's own `wait`/`try_wait` do: an EINTR here is not a
                // failure, and reporting it as one would kill the group and fail a command that
                // was fine.
                if e.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e.to_string());
            }
            return Ok(info.si_signo != 0);
        }
    }
    #[cfg(not(unix))]
    {
        child.try_wait().map(|s| s.is_some()).map_err(|e| e.to_string())
    }
}

/// Run `cmd` to completion but ABORT it after `timeout`, killing the child and returning an Err.
/// std-only (no tokio, per the backend constraint): the child stays owned here so we can kill it,
/// two reader threads drain stdout/stderr concurrently (so a chatty child can't deadlock on a full
/// pipe while we wait), and we poll `try_wait` until the deadline (std has no wait-with-timeout).
///
/// GRANDCHILDREN are the hard part, and both halves of the fix live here: the child gets its own
/// process group so expiry can kill the whole tree ([`crate::proc::kill_process_group`]), and the
/// drain is joined with a bounded grace so a pipe held open by something we still couldn't reach
/// costs two seconds, not the life of the process. This function returns within
/// `timeout + DRAIN_GRACE`, always.
///
/// The LENIENT form: an incomplete or capped drain is DATA, reported in-band as
/// [`Captured::drain_complete`], not an error. git legitimately spawns long-lived helpers that
/// inherit these pipes (`ssh` ControlPersist, `git credential-cache--daemon`), so "we gave up
/// draining" is a state that really happens, and a mutating caller whose operation already took
/// effect must not report it as failed. [`output_with_timeout`] is the strict wrapper that turns
/// the same condition into an `Err` for callers that parse the output as a whole value.
pub(crate) fn output_with_timeout_lenient(
    mut cmd: Command,
    timeout: Duration,
) -> Result<Captured, String> {
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group, so expiry can signal the child AND its descendants. Safe for these
        // callers: every one of them is a non-interactive capture with stdin closed, so nothing here
        // wants the terminal's job-control signals. REQUIRED by `proc::kill_process_group`.
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn: {e}"))?;

    let (out_buf, out_thread) = spawn_drain(child.stdout.take());
    let (err_buf, err_thread) = spawn_drain(child.stderr.take());
    let drained = |grace| crate::proc::await_threads(&[&out_thread, &err_thread], grace);

    let deadline = Instant::now() + timeout;
    // Deliberately NOT `try_wait`: see [`exited_without_reaping`]. The child stays a zombie — and
    // so its pid, and with it its process-group id, stay reserved — until the post-exit drain below
    // is finished with them. It is reaped LAST.
    loop {
        match exited_without_reaping(&mut child) {
            Ok(true) => break,
            Ok(false) => {
                if Instant::now() >= deadline {
                    // Deadline hit: kill the whole process group, reap, give the readers a bounded
                    // grace to finish, and report the timeout.
                    crate::proc::kill_process_group(&mut child);
                    drained(DRAIN_GRACE);
                    return Err(format!("timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                crate::proc::kill_process_group(&mut child);
                drained(DRAIN_GRACE);
                return Err(format!("wait failed: {e}"));
            }
        }
    }
    // The child is gone, but a surviving grandchild can still hold the write ends — so this join is
    // bounded too. Two steps, and the order matters:
    //
    //  1. A SETTLE window. Everything the command itself wrote is already in the pipe, so a healthy
    //     capture joins here in microseconds and pays nothing.
    //  2. Still held ⇒ KILL THE GROUP, then join under the full grace. Nothing inside the command
    //     needs to run any more — it has already exited — and closing the pipe is precisely what
    //     lets the readers reach EOF and hand over the whole output. Abandoning instead (what this
    //     used to do) cost the bytes AND leaked a reader thread plus a pipe fd for as long as the
    //     holder lived, which for an ssh ControlMaster on a ~30s poll is hours.
    //
    // BOTH steps run while the child is still UNREAPED — that is the whole reason the loop above
    // does not use `try_wait`. Reaping first releases the pid, and an EMPTY group (which is exactly
    // the shape that reaches step 2: the holder escaped the group) releases the pgid with it, so
    // the `kill(-pid, …)` below could reach an unrelated group. See `exited_without_reaping`.
    //
    // A bound we still hit after that does NOT mean failure: the holder escaped the group (it
    // `setsid`'d, or this is a non-unix build with no group kill), the bytes MAY be short, and the
    // caller picks a policy — a parse-sensitive caller treats it as unusable, a mutating caller
    // keeps trusting `status.success()` (its operation already happened; failing it here would
    // report a merged PR as unmerged).
    // Joined-to-EOF is not enough on its own: a stream that overran DRAIN_BUF_CAP reached EOF with
    // bytes DROPPED, and a stream whose read ERRORED mid-way finished the thread with a prefix in
    // the buffer. Both are the same lie ("this is the whole output") by different routes.
    let mut joined = drained(POST_EXIT_SETTLE);
    if !joined {
        crate::proc::kill_process_group(&mut child);
        joined = drained(DRAIN_GRACE);
    }
    // Reaped HERE, and deliberately nowhere earlier — this is the other half of the fix. The wait
    // loop above left the child a zombie precisely so its pid, and with it the pgid that
    // `kill(-pid, …)` names, stayed reserved across the group kill directly above. Nothing needs the
    // pid now, so collect the status and release it. `WNOWAIT` did not consume the exit state, so it
    // is still here to collect.
    let status = child.wait().map_err(|e| format!("wait failed: {e}"))?;
    let stdout_capped = out_buf.truncated.load(Ordering::Acquire);
    let stderr_capped = err_buf.truncated.load(Ordering::Acquire);
    let stdout_read_error = out_buf.read_error.load(Ordering::Acquire);
    let stderr_read_error = err_buf.read_error.load(Ordering::Acquire);
    Ok(Captured {
        output: std::process::Output {
            status,
            stdout: take_drained(&out_buf),
            stderr: take_drained(&err_buf),
        },
        drain_complete: joined
            && !stdout_capped
            && !stderr_capped
            && !stdout_read_error
            && !stderr_read_error,
        pipes_held: !joined,
        stdout_capped,
        stderr_capped,
        stdout_read_error,
        stderr_read_error,
    })
}

/// A finished capture plus whether its drain provably reached EOF with nothing dropped.
/// `!drain_complete` does not mean the child failed — a pipe-holder outlived it, a stream overran
/// [`DRAIN_BUF_CAP`], or a read errored mid-stream, so `output.stdout`/`stderr` may be short.
pub(crate) struct Captured {
    pub(crate) output: std::process::Output,
    pub(crate) drain_complete: bool,
    /// A pipe-holder outlived the child AND survived the group kill, so BOTH buffers may be short —
    /// the drain threads were still running when the grace expired. Its own field because it is the
    /// only cause that isn't per-stream: the join covers both threads at once.
    ///
    /// Rare by construction now that the success path kills the group: what reaches this is a holder
    /// that escaped it (a `setsid`'d descendant, an fd handed to a daemon) or a non-unix build,
    /// where there is no group kill and this is the ordinary outcome.
    pub(crate) pipes_held: bool,
    /// Per-STREAM, not collapsed bits: both lenient callers build their message from stderr, so a
    /// stdout overrun (progress spam) or a stdout read error must not make them say the reason may
    /// be missing when the reason was captured whole.
    pub(crate) stdout_capped: bool,
    pub(crate) stderr_capped: bool,
    pub(crate) stdout_read_error: bool,
    pub(crate) stderr_read_error: bool,
}

impl Captured {
    /// The clause to append to a failure message built from STDERR when that text may be short.
    /// Empty when stderr is known whole, so call sites can push it unconditionally.
    ///
    /// Both lenient call sites build their user-facing error from the captured stderr, which is
    /// where `gh` and `claude` put the reason — so a lost tail turns "why the merge was declined"
    /// into a bare `gh pr merge #N failed`, with nothing saying why it's empty.
    pub(crate) fn truncation_note(&self) -> &'static str {
        // Ordered by what actually happened to STDERR, then the one cause that hits both streams.
        // Testing a collapsed "did anything go wrong" bit first was wrong twice: a stdout read
        // error shadowed the more accurate stderr-capped wording, and gating the held-pipes clause
        // on `!stdout_capped` silently returned "" for "stdout overran AND a helper held the
        // pipes", where stderr really can be short.
        if self.stderr_read_error {
            " (the output pipe errored mid-read, so this message may be incomplete)"
        } else if self.stderr_capped {
            " (output was too large to capture in full — this is the tail, and earlier lines were dropped)"
        } else if self.pipes_held {
            " (output may be truncated — a helper process still held the pipes open)"
        } else {
            // Only stdout was short: the message the caller is building from stderr is intact.
            ""
        }
    }
}

/// The strict form: an incomplete or capped drain is an `Err`. For callers that PARSE the output as
/// a whole value — a sha, a version line, a JSON document — where a plausible-looking prefix would
/// be worse than an error.
pub(crate) fn output_with_timeout(
    cmd: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let captured = output_with_timeout_lenient(cmd, timeout)?;
    if !captured.drain_complete {
        let partial = captured.output.stdout.len() + captured.output.stderr.len();
        if captured.stdout_read_error || captured.stderr_read_error {
            return Err(format!(
                "reading the child's output failed mid-stream; {partial} bytes kept, which are a \
                 fragment, not the whole output"
            ));
        }
        // EITHER stream capping fails the call: this form hands the caller both streams, so
        // "the one you were going to parse is fine" isn't ours to assume.
        if captured.stdout_capped || captured.stderr_capped {
            return Err(format!(
                "child wrote past the {DRAIN_BUF_CAP}-byte per-stream capture cap; {partial} bytes \
                 kept, which are the tail, not the whole output"
            ));
        }
        return Err(format!(
            "child exited but its output pipes stayed open past {}s (a grandchild still holds \
             them); {partial} bytes read, which may be truncated",
            DRAIN_GRACE.as_secs()
        ));
    }
    Ok(captured.output)
}

/// Like [`git`], but for the NETWORK-touching invocations (a `fetch`): bounds the wall-clock via
/// [`output_with_timeout`] so a partition can't hang the child for the OS default. Same
/// non-interactive env and stdout/stderr-on-failure semantics as `git`; a timeout reads as an Err
/// (which every caller already treats as "offline/degrade — fall back to the local ref").
fn git_networked(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.arg("-C").arg(cwd).args(args);
    apply_noninteractive(&mut cmd);
    let output = output_with_timeout(cmd, NETWORK_TIMEOUT)
        .map_err(|e| format!("git {} failed: {e}", args.join(" ")))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        };
        Err(format!("git {} failed: {msg}", args.join(" ")))
    }
}

/// Resolve the project's logical integration branch name. An explicit `[workflow].default_branch`
/// from the editable config (per-project file beats global) wins; otherwise auto-detect in order:
/// origin/HEAD symref → local `main` → local `master` → the branch currently checked out at `root`.
///
/// The configured value is `validate_ref`d before it is trusted. It reaches `git fetch origin
/// <branch>` as a bare argument, and the per-project layer of that config is a file CHECKED INTO
/// THE REPO — so an unvalidated `default_branch = "--upload-pack=…"` would be exactly the
/// option-injection `validate_ref` exists to block, arriving from a repo the user merely opened.
/// Callers that validate their OWN input still fall back here, so validating at the caller is not
/// enough; rejecting an unsafe override falls through to auto-detection, which only ever yields
/// names git itself produced.
pub fn resolve_default_branch(root: &str) -> String {
    // Config override: a non-empty default_branch pins the base; empty means "auto-detect" below.
    let configured = crate::config::for_project(root).config.workflow.default_branch;
    let configured = configured.trim();
    if !configured.is_empty() {
        if validate_ref(configured).is_ok() {
            return configured.to_string();
        }
        tracing::warn!("resolve_default_branch: unsafe [workflow].default_branch, auto-detecting");
    }
    if let Ok(symref) = git(root, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        // e.g. "refs/remotes/origin/main" -> "main"; preserve slashes in names like
        // "release/2026" by stripping the fixed prefix rather than splitting on the last '/'.
        if let Some(name) = symref.strip_prefix("refs/remotes/origin/") {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    for candidate in ["main", "master"] {
        if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{candidate}")]).is_ok() {
            return candidate.to_string();
        }
    }
    git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "main".to_string())
}

/// The ref creation/status/refresh compare or cut against. With a remote: `origin/<branch>`,
/// fetched first when `fetch` is true. Any fetch failure (offline/auth/unreachable) or a
/// missing remote-tracking ref falls back to the local `<branch>` — a command must never
/// break just because the network is down. `branch` is always a logical name (never `origin/…`).
///
/// Guarantees a ref that actually RESOLVES, never a phantom name: `origin/<branch>` →
/// local `<branch>` → detected default (local or `origin/<default>`) → `HEAD` → the original
/// name (only when nothing resolves, e.g. an unborn HEAD). The last two fallbacks fire ONLY
/// when the recorded base has drifted to something git can't resolve — a state in which the
/// prior "return the name verbatim" behavior already hard-failed every caller. So for the
/// status/rebase `rev-list` callers, a `HEAD` return is a graceful degradation (compare/cut
/// against the current checkout) of a case that used to error outright, not a regression of a
/// path that previously worked.
fn effective_base(root: &str, branch: &str, fetch: bool) -> String {
    // Defensive: a legacy agent whose baseBranch was never persisted can send "" from the
    // frontend. An empty ref would feed `git rebase ""` / `rev-list "...<branch>"` and break the
    // command; resolve the project's default branch instead of trusting the caller.
    let resolved;
    let trimmed = branch.trim();
    let branch = if trimmed.is_empty() || validate_ref(trimmed).is_err() {
        // Empty (a legacy agent whose baseBranch was never persisted) OR a ref crafted to be
        // parsed as a git option (leading '-' → --upload-pack=/--exec=) or carrying control
        // chars: never hand it to git. Resolve the project's default branch instead. git forbids
        // '-'-leading branch names, so no legitimate ref is lost by this fallback.
        if !trimmed.is_empty() {
            tracing::warn!(rejected = %trimmed, "effective_base: unsafe base ref, using default branch");
        }
        resolved = resolve_default_branch(root);
        resolved.as_str()
    } else {
        trimmed
    };
    let has_origin = git(root, &["remote", "get-url", "origin"]).is_ok();
    if has_origin {
        if fetch {
            // Best-effort; ignore failure and fall through to the existence check below.
            // Network touch → bounded wall-clock so a partition can't hang this for the OS default.
            let _ = git_networked(root, &["fetch", "origin", branch]);
        }
        let remote_ref = format!("origin/{branch}");
        if git(root, &["rev-parse", "--verify", "--quiet", &remote_ref]).is_ok() {
            return remote_ref;
        }
    }
    // The logical base may not exist as a LOCAL branch either — a recorded default that has since
    // drifted from reality: the repo was renamed (`main` → `master`), the base branch was deleted,
    // or the project was re-cloned with a different default. Handing a name that resolves to nothing
    // straight to `git worktree add … <base>` fails with a cryptic `fatal: invalid reference: <name>`
    // that a user installing Sparkle has no way to act on. Guarantee a resolvable commit-ish instead:
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok() {
        return branch.to_string();
    }
    // Requested base is a phantom. Fall back to the repo's ACTUAL default branch (origin/HEAD →
    // local main → local master → checked-out branch), honoring it as either a local branch or a
    // remote-tracking ref — a fresh clone's default frequently exists only as `origin/main` with no
    // local counterpart yet, so a local-only check would wrongly skip it.
    let detected = resolve_default_branch(root);
    if detected != branch {
        if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{detected}")]).is_ok() {
            tracing::warn!(
                requested = %branch, using = %detected,
                "effective_base: recorded base branch not found; falling back to detected default"
            );
            return detected;
        }
        if has_origin {
            let detected_remote = format!("origin/{detected}");
            if git(root, &["rev-parse", "--verify", "--quiet", &detected_remote]).is_ok() {
                tracing::warn!(
                    requested = %branch, using = %detected_remote,
                    "effective_base: recorded base branch not found; falling back to detected default (remote)"
                );
                return detected_remote;
            }
        }
    }
    // Neither the requested base nor a named default resolves (e.g. origin/HEAD points at a branch
    // with no local counterpart, or an unusual layout). HEAD always resolves in a repo with a born
    // commit — and the create path ensures one — so cutting the new branch from it beats erroring.
    if git(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
        tracing::warn!(
            requested = %branch,
            "effective_base: no named base branch resolves; using HEAD as the cut point"
        );
        return "HEAD".to_string();
    }
    // Truly nothing resolves (unborn HEAD / empty repo). Return the original name and let the
    // caller's born-HEAD handling or git's own error surface a clear, actionable failure.
    branch.to_string()
}

/// Auto-detect the project's logical integration branch name (e.g. `main`).
#[tauri::command]
pub async fn project_default_branch(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(resolve_default_branch(&root)))
        .await
        .map_err(|e| format!("project_default_branch task failed: {e}"))?
}

/// Reconcile a project's PERSISTED integration branch against reality (AppHandle-free, testable).
/// A non-empty `recorded` that still resolves — local `refs/heads/<recorded>` OR a remote-tracking
/// `refs/remotes/origin/<recorded>` — is honored verbatim, so a deliberate non-default choice (a
/// feature integration branch set in Project settings) is never silently overwritten. Otherwise —
/// empty, or a name that has drifted to something git can't resolve (repo renamed `main` → `master`,
/// base branch deleted, re-cloned with a different default) — the repo's actual default is returned
/// so the caller can re-persist a valid value. This is the STORE-healing companion to
/// `effective_base`: `effective_base` fixes the cut point at spawn time, this stops the UI from
/// lingering on a phantom base and keeps new agents from inheriting one. Always non-empty:
/// `resolve_default_branch`'s terminal fallback is the literal `"main"`.
pub fn reconcile_default_branch_at(root: &str, recorded: &str) -> String {
    let trimmed = recorded.trim();
    if !trimmed.is_empty() && validate_ref(trimmed).is_ok() {
        let resolves = git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{trimmed}")]).is_ok()
            || git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{trimmed}")]).is_ok();
        if resolves {
            return trimmed.to_string();
        }
    }
    resolve_default_branch(root)
}

/// Tauri wrapper around [`reconcile_default_branch_at`]. Runs off the main thread (git subprocesses).
#[tauri::command]
pub async fn reconcile_default_branch(root: String, recorded: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(reconcile_default_branch_at(&root, &recorded)))
        .await
        .map_err(|e| format!("reconcile_default_branch task failed: {e}"))?
}

/// Roots whose repo has already been ensured this session. `ensure_project_repo` is idempotent but
/// runs 3-4 git subprocesses; caching "ready" means only the FIRST agent per project pays that cost
/// (subsequent concurrent opens hit the fast path instead of re-running init/config/commit checks).
fn ready_repos() -> &'static Mutex<HashSet<String>> {
    static READY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    READY.get_or_init(|| Mutex::new(HashSet::new()))
}

/// `(root, error)` pairs whose roborev hook-install failure has already been reported at WARN this
/// session. Hook installation is best-effort and retried on EVERY `ensure_project_repo` — i.e. once
/// per agent open — so a root with a genuinely unresolvable hooks dir emits the identical warning
/// indefinitely; session telemetry shows a single such root producing this line in the hundreds
/// within one day, which buries every other warning in the log.
///
/// Keying on the error text as well as the root is deliberate: a root whose failure CHANGES has
/// something new to say and gets its own WARN, while the repeated-identical case (the flooding
/// shape) is demoted to DEBUG after the first. Nothing is silenced — the detail is still on disk at
/// DEBUG, which is where a repeat belongs.
fn warned_hook_failures() -> &'static Mutex<HashSet<(String, String)>> {
    static WARNED: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    WARNED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// True the FIRST time this exact `(root, error)` failure is seen this session, false for repeats.
/// A poisoned lock returns true — losing the dedupe is strictly better than losing the warning.
fn should_warn_hook_failure(root: &str, error: &str) -> bool {
    match warned_hook_failures().lock() {
        Ok(mut seen) => seen.insert((root.to_string(), error.to_string())),
        Err(_) => true,
    }
}

/// If `<path>/.git` is a gitfile (an orphaned worktree/submodule pointer) whose target gitdir no
/// longer exists, rename it aside so a fresh `git init` can succeed. A real `.git` *directory*, or a
/// gitfile whose target still exists (a live worktree/submodule), is left completely untouched — the
/// caller only reaches here after `git rev-parse --git-dir` already failed, so a healthy repo never
/// gets this far. Best-effort: any I/O error leaves `.git` as-is and lets `git init` report the fault.
fn clear_dangling_gitfile(path: &str) {
    let dot_git = Path::new(path).join(".git");
    // Only a regular file is a gitfile; a real `.git` directory (or symlink) is never touched.
    match std::fs::symlink_metadata(&dot_git) {
        Ok(meta) if meta.is_file() => {}
        _ => return,
    }
    let Ok(contents) = std::fs::read_to_string(&dot_git) else { return };
    // gitfile format is a first line `gitdir: <path>`. Read only that line so a valid but
    // multi-line file can't smuggle an embedded newline into the target and get mis-resolved.
    let Some(target) = contents.lines().next().and_then(|l| l.strip_prefix("gitdir:")).map(str::trim) else { return };
    if target.is_empty() {
        return;
    }
    // Relative targets resolve against the directory that holds `.git`.
    let target_path = Path::new(target);
    let resolved = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        Path::new(path).join(target_path)
    };
    if resolved.exists() {
        return; // live worktree/submodule — do not disturb it.
    }
    // Dangling pointer: move it aside rather than hard-deleting, so nothing is silently destroyed.
    let aside = Path::new(path).join(".git.orphaned");
    // Clear any prior salvage (file OR directory) so the rename can't fail on a name collision.
    let _ = std::fs::remove_file(&aside).or_else(|_| std::fs::remove_dir_all(&aside));
    let _ = std::fs::rename(&dot_git, &aside);
}

/// Ensure `<path>` is a git repo with a committable identity, at least one commit,
/// and `.sparkle/` ignored. Idempotent. Cached per root for the session (see [`ready_repos`]).
/// Sync core of [`ensure_project_repo`] (the git-subprocess work). Kept as a plain fn so the
/// async command can offload it via `spawn_blocking` and the test suite can drive it directly.
fn ensure_project_repo_inner(path: String) -> Result<(), String> {
    // Fast path: already ensured this session. The underlying work is idempotent, so this only
    // skips redundant git subprocesses — the first successful call is what seeds the set.
    if ready_repos().lock().map(|s| s.contains(&path)).unwrap_or(false) {
        return Ok(());
    }

    // 1. Make it a repo if it isn't one yet.
    if git(&path, &["rev-parse", "--git-dir"]).is_err() {
        // An orphaned worktree — a `.git` *file* (gitfile) pointing at a worktree/submodule
        // admin dir that no longer exists — leaves the files intact but unreachable by git.
        // A plain `git init` then follows the dangling pointer and dies with
        // "fatal: not a git repository: <gitdir>", surfacing as "Couldn't start this agent".
        // Move the dead pointer aside first so we can initialize a fresh standalone repo from
        // the surviving files. Live worktrees pass the rev-parse check above and never reach here.
        clear_dangling_gitfile(&path);
        git(&path, &["init"])?;
    }

    // 2. Ensure a committable identity exists for THIS repo (the user may have no
    //    global git config — worktree commits would otherwise fail).
    if git(&path, &["config", "user.email"]).map(|s| s.is_empty()).unwrap_or(true) {
        git(&path, &["config", "user.email", "agent@sparkle.local"])?;
        git(&path, &["config", "user.name", "Sparkle"])?;
    }

    // 3. Worktrees require a born HEAD — make an empty initial commit if needed.
    if git(&path, &["rev-parse", "HEAD"]).is_err() {
        git(&path, &["commit", "--allow-empty", "-m", "Sparkle: initialize project"])?;
    }

    // 4. Make sure the hidden worktrees dir is never tracked. Both halves matter: the tracked
    //    `.gitignore` is the durable record, and `info/exclude` is what makes the scratch-worktree
    //    patterns effective on a worktree ALREADY pinned to a branch that predates them.
    ensure_gitignore(&path)?;
    ensure_worktree_excludes(&path)?;

    // Mark ready so subsequent agents on this root skip the checks above.
    if let Ok(mut set) = ready_repos().lock() {
        set.insert(path);
    }
    Ok(())
}

/// Ensure `<path>` is a git repo with a committable identity, at least one commit, and `.sparkle/`
/// ignored. Idempotent. `async` + `spawn_blocking` so the 3-4 git subprocesses the first agent per
/// project pays never stall the UI thread.
///
/// After the repo is ensured, best-effort installs the roborev per-commit review hooks into the
/// repo's `.git/hooks` when `[tools].roborev` is on — so every commit (including those in the
/// `.sparkle/` agent worktrees, which share the common-dir hooks) gets reviewed. Hook installation
/// NEVER fails the command: a missing bundled resource / copy error is logged and swallowed. The
/// `app` arg is injected by Tauri; the JS `invoke("ensure_project_repo", { path })` is unchanged.
#[tauri::command]
pub async fn ensure_project_repo(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_project_repo_inner(path.clone())?;
        // Best-effort roborev hook wiring, gated on BOTH the machine-wide [tools].roborev toggle AND
        // the one-time consent having been resolved — so we never review (or touch .git/hooks in) a
        // user's repo before they've answered the consent prompt, matching the daemon-ensure gate in
        // lib.rs. On Enable the frontend sweeps install_repo_hooks over existing projects. Kept OUT
        // of ensure_project_repo_inner so its direct-call unit tests stay hook-free.
        let cfg = crate::config::for_project(&path).config;
        if cfg.tools.roborev && cfg.roborev.consent_prompted {
            if let Err(e) = install_repo_hooks(&app, &path) {
                // First occurrence per (root, error) is the one worth surfacing; the retry-driven
                // repeats that follow it go to DEBUG. See `warned_hook_failures`.
                if should_warn_hook_failure(&path, &e) {
                    tracing::warn!(%path, error = %e, "roborev hook install failed (non-fatal)");
                } else {
                    tracing::debug!(%path, error = %e, "roborev hook install failed again (non-fatal, repeat)");
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("ensure_project_repo task failed: {e}"))?
}

/// The two git hooks roborev drives, and the marker substring the vendored copy of each carries.
/// `remove_repo_hooks` uses the marker to ensure it only ever deletes a hook that is OURS, never a
/// user's own same-named hook. The markers are stable comment lines in the bundled scripts.
// The marker is a DISTINCTIVE line the vendored script carries (not the bare phrase "roborev
// post-commit", which a user's own hook could mention in a comment) so ownership detection can't
// misfire on a foreign hook.
const ROBOREV_HOOKS: &[(&str, &str)] = &[
    ("post-commit", "seed-owned wrapper"),
    ("post-rewrite", "vendored copy owned by the Sparkle app"),
];

/// Decide whether it is safe to write our vendored hook over what is at `dest`. NEVER clobber a
/// user's own same-named hook: write only when nothing is there, or when a readable existing file is
/// already OURS (carries the vendored marker). CRITICAL: `exists` and `contents` are separate — a
/// git hook can be a compiled binary or a non-UTF-8 / unreadable script, where reading-as-text fails
/// (`contents == None`) even though the file IS present. Collapsing that into "absent" would silently
/// overwrite the foreign hook — the exact data loss this guards against — so a present-but-unreadable
/// hook is treated as foreign and preserved. Pure, so the rule is unit-tested without the resolver.
fn may_write_hook(exists: bool, contents: Option<&str>, marker: &str) -> bool {
    if !exists {
        return true; // nothing there — safe to install
    }
    match contents {
        Some(c) => c.contains(marker), // readable → ours (refresh) iff the vendored marker is present
        None => false,                 // present but unreadable (binary / permission) → foreign, preserve
    }
}

/// Resolve the directory git actually reads hooks from for the repo at `repo_root`.
///
/// `<repo_root>/.git` is a DIRECTORY only in a normal clone. In a linked worktree it is a gitlink
/// *file* pointing at the real gitdir, so joining `.git/hooks` yields a path under a regular file —
/// `create_dir_all` there fails with ENOTDIR and hook install never happens. `--git-common-dir`
/// returns the shared gitdir in both layouts, so a worktree correctly resolves to its parent repo's
/// hooks.
///
/// KNOWN LIMITATION: this is where git runs hooks from *unless* `core.hooksPath` is set, which
/// redirects them elsewhere; hooks we install here are then never executed. We deliberately do NOT
/// resolve via `--git-path hooks` (which would honour `core.hooksPath`), because that config is
/// frequently set GLOBALLY to a directory shared by every repo on the machine — installing into it
/// would silently affect repos the user never opened in this app. Confining our writes to this
/// repo's own gitdir is the safer failure: ineffective, not invasive.
///
/// Git may answer with a path relative to `repo_root` (typically a bare `.git`), so a relative
/// answer is re-anchored.
///
/// When git can't answer at all (not on PATH, or the gitlink points at an admin dir that no longer
/// exists, so `rev-parse` exits non-zero) we do NOT go straight to the literal `.git/hooks`: on a
/// worktree-rooted project that join is a path under a regular file, so every install re-fails with
/// a bare ENOTDIR. We read the gitlink ourselves first via [`gitfile_common_dir`], and only use
/// `<root>/.git` when `.git` really is a directory — correct for the normal-clone majority.
fn hooks_dir_for(repo_root: &str) -> PathBuf {
    common_dir_for(repo_root).join("hooks")
}

/// The SHARED (common) gitdir for `repo_root` — `hooks/` and `info/exclude` both live under it.
///
/// Extracted from [`hooks_dir_for`] so `info/exclude` resolves through exactly the same
/// battle-tested fallback chain rather than a second, thinner copy of it. See `hooks_dir_for`'s doc
/// comment for why each branch exists (gitlink files, relative answers, and the ENOTDIR trap when
/// git cannot answer at all).
fn common_dir_for(repo_root: &str) -> PathBuf {
    let common = git(repo_root, &["rev-parse", "--git-common-dir"])
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    match common {
        Some(dir) if dir.is_absolute() => dir,
        Some(dir) => Path::new(repo_root).join(dir),
        None => gitfile_common_dir(repo_root)
            .unwrap_or_else(|| Path::new(repo_root).join(".git")),
    }
}

/// Resolve `<repo_root>/.git` when it is a gitlink FILE, returning the SHARED (common) gitdir —
/// the one holding `hooks/`. `None` when `.git` is a directory (a normal clone, where the caller's
/// own `.git` join is already right) or when the file doesn't carry a parsable `gitdir:` pointer.
///
/// This is the no-git-subprocess twin of `rev-parse --git-common-dir`, used only on that command's
/// failure path. Two gitlink shapes exist and they resolve differently:
///   * a linked worktree points at `<common>/worktrees/<name>` → the common dir is two levels up
///   * a submodule points directly at its own gitdir → that IS the common dir
fn gitfile_common_dir(repo_root: &str) -> Option<PathBuf> {
    // `read_to_string` on a directory is an Err, which is exactly the "normal clone" signal.
    let contents = std::fs::read_to_string(Path::new(repo_root).join(".git")).ok()?;
    let target = contents.lines().find_map(|l| l.trim().strip_prefix("gitdir:"))?.trim();
    if target.is_empty() {
        return None;
    }
    // A gitlink may hold a path relative to the repo root; re-anchor it the same way git does.
    let target = match Path::new(target) {
        p if p.is_absolute() => p.to_path_buf(),
        p => Path::new(repo_root).join(p),
    };
    if target.parent().and_then(|p| p.file_name()) == Some(std::ffi::OsStr::new("worktrees")) {
        target.parent()?.parent().map(PathBuf::from)
    } else {
        Some(target)
    }
}

/// Repos we have already warned about an inert `core.hooksPath` for. `install_repo_hooks` runs on
/// every project open (and on the Enable sweep), so without this the same unactionable-once warning
/// would repeat hundreds of times a session and drown the log.
///
/// Keyed by the RESOLVED hooks dir, not by `repo_root` — see `hooks_warn_key`.
fn hooks_path_warned() -> &'static Mutex<HashSet<String>> {
    static WARNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    WARNED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// The dedupe key for the inert-hooks warning: the hooks dir git would actually read, not the
/// `repo_root` we were handed.
///
/// Those two differ for exactly the case this app generates most. `install_repo_hooks` is called
/// with an agent WORKTREE as `repo_root`, and `hooks_dir_for` resolves every worktree of a repo to
/// the same shared `--git-common-dir` hooks. Keying on `repo_root` therefore made each worktree its
/// own "repo": the same unactionable warning re-fired on every agent spawn — in bursts of several
/// within a few seconds — while the doc comment promised once per repo. Keying on the resolved dir
/// collapses a repo and all of its worktrees to the single warning that was intended, because that
/// dir is precisely what the message is about (it is reported as `installed_into`, and it is the
/// path `core.hooksPath` is being compared against).
///
/// Canonicalized so that a symlinked or `..`-laden spelling of one dir is not two keys — the same
/// normalization `hooks_are_inert` compares with. An unresolvable path (configured but not yet
/// created) falls back to the literal spelling, which is still stable per worktree family and so
/// still strictly better than the old key. Pure, for testing.
fn hooks_warn_key(hooks_dir: &Path) -> String {
    hooks_dir
        .canonicalize()
        .unwrap_or_else(|_| hooks_dir.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Which git config SCOPE sets `core.hooksPath`, from `git config --show-scope --get` output
/// (`<scope>\t<value>`). Returns `"unknown"` for anything unrecognised.
///
/// The scope is the missing half of the inert-hooks warning below. "Point `core.hooksPath` at the
/// repo's own hooks dir, or unset it" is not actionable without it: `--unset` needs the right
/// `--global`/`--local` flag to do anything, and a GLOBAL setting is the one case where unsetting is
/// the wrong advice — it would disable the user's hooks in every repo on the machine to fix one.
///
/// Knowing the scope is also what keeps the REMEDY honest, and the honest answer is that BOTH ways
/// out cost something — so the message states the costs rather than recommending one, and every
/// clause in it is there because the confident version of it was wrong:
///   * `core.hooksPath` is a single path, not additive. A repo-local override does not sit alongside
///     the configured dir; it replaces it for that repo, and whatever hooks lived there (husky, a
///     company `pre-commit`, a secret scanner) stop running. Trading one silent no-op for another is
///     the failure this warning exists to surface.
///   * Populating the configured dir instead is not free either. `ROBOREV_HOOKS` is
///     `post-commit`/`post-rewrite` — names a hook manager commonly owns — so a plain copy clobbers
///     one, the exact data loss `may_write_hook` refuses to commit 30 lines below. And a
///     global/system dir is shared by every repo on the machine, which is why this code does not
///     write there itself (see `hooks_dir_for`).
///   * `worktree` scope outranks local when `extensions.worktreeConfig` is on, so an override there
///     must be written with `--worktree` or it is silently a no-op. `command` scope takes neither
///     route: the redirect comes from the invocation environment, which no config write reaches.
/// The warn is deduped per repo, so the user acts on it once — a caveat left out is not one they get
/// a second chance to hear.
///
/// Only the scope token is taken, never the value: this runs for every project the user opens,
/// including their own repositories, and a configured path is theirs. The token is a small fixed
/// vocabulary, so it carries the whole decision above and nothing else. Anything outside that
/// vocabulary — a git too old for `--show-scope`, an empty or garbled line — reads as `"unknown"`
/// rather than being echoed, so an unexpected shape can never leak through as content.
fn hooks_path_scope(raw: &str) -> &'static str {
    match raw.split('\t').next().map(str::trim) {
        Some("system") => "system",
        Some("global") => "global",
        Some("local") => "local",
        Some("worktree") => "worktree",
        Some("command") => "command",
        _ => "unknown",
    }
}

/// Would hooks written to `installed_into` be INERT — i.e. is git configured to read hooks from
/// somewhere else entirely?
///
/// `core.hooksPath` (commonly set GLOBALLY, so it applies to repos the user never configured by
/// hand) redirects git away from the gitdir we install into. When that happens our install still
/// SUCCEEDS — files are written, no error is raised — but git never executes them, so roborev
/// silently reviews nothing. That silent-success is worse than the loud ENOTDIR failure it replaced,
/// hence this check.
///
/// A relative `core.hooksPath` is interpreted by git relative to the repo root, so it is re-anchored
/// before comparing. Paths are compared after canonicalization where possible so that a symlinked or
/// `..`-laden spelling of the SAME directory is not misreported as a redirect; an unresolvable path
/// (typically: configured but not yet created) falls back to a literal compare.
fn hooks_are_inert(repo_root: &str, installed_into: &Path, configured: Option<&str>) -> bool {
    let configured = match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return false, // unset → git reads the gitdir hooks, which is where we installed
    };
    let configured = Path::new(configured);
    let configured = if configured.is_absolute() {
        configured.to_path_buf()
    } else {
        Path::new(repo_root).join(configured)
    };
    let resolve = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    resolve(&configured) != resolve(installed_into)
}

/// Copy the vendored roborev git hooks into the repo's hooks dir, mode 0755. Idempotent, and
/// NON-DESTRUCTIVE: a pre-existing hook that is not ours (no vendored marker) is left untouched
/// (see `may_write_hook`) — since `[tools].roborev` defaults on and this runs for every project,
/// silently overwriting a user's own `post-commit`/`post-rewrite` would be data loss. Each script is
/// resolved from the app bundle's `resources/roborev/<name>` and `.exists()`-guarded, so a dev build
/// with un-bundled resources degrades to a clear Err rather than a panic. Git worktrees share the
/// common-dir hooks (see `hooks_dir_for`), so installing once transparently covers every
/// `.sparkle/` agent worktree cut from the repo — and works when `repo_root` IS such a worktree.
pub fn install_repo_hooks(app: &AppHandle, repo_root: &str) -> Result<(), String> {
    let hooks_dir = hooks_dir_for(repo_root);
    std::fs::create_dir_all(&hooks_dir)
        .map_err(|e| format!("cannot create {hooks_dir:?}: {e}"))?;

    for (name, marker) in ROBOREV_HOOKS {
        let src = app
            .path()
            .resolve(
                format!("resources/roborev/{name}"),
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("bundled roborev {name} hook missing: {e}"))?;
        if !src.exists() {
            return Err(format!(
                "bundled roborev {name} hook not found at {} (run apps/desktop build to bundle it)",
                src.display()
            ));
        }
        let dest = hooks_dir.join(name);
        // Never clobber a user's own hook: skip if a foreign hook already sits here. Pass existence
        // separately from readable contents so a present-but-unreadable (binary/perm) hook is NOT
        // mistaken for "absent" and overwritten.
        if !may_write_hook(dest.exists(), std::fs::read_to_string(&dest).ok().as_deref(), marker) {
            tracing::info!(
                hook = %name, repo = %repo_root,
                "preserving a pre-existing non-roborev {name} hook (not overwriting)"
            );
            continue;
        }
        std::fs::copy(&src, &dest)
            .map_err(|e| format!("copying roborev {name} hook to {dest:?} failed: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod roborev {name} hook failed: {e}"))?;
        }
    }

    // The install above succeeded, but succeeding is not the same as taking effect: if
    // `core.hooksPath` points elsewhere, git will never run what we just wrote. Say so ONCE per
    // repo — counting all of its agent worktrees as that one repo, since they share the hooks dir
    // this warns about (`hooks_warn_key`) — rather than letting roborev appear enabled while
    // silently reviewing nothing. This is
    // deliberately only a warning — writing into a (usually global) shared hooksPath would affect
    // repos the user never opened here; see `hooks_dir_for`.
    let configured = git(repo_root, &["config", "--get", "core.hooksPath"]).ok();
    if hooks_are_inert(repo_root, &hooks_dir, configured.as_deref()) {
        let first_time = hooks_path_warned()
            .lock()
            .map(|mut w| w.insert(hooks_warn_key(&hooks_dir)))
            .unwrap_or(true);
        if first_time {
            // Which scope set it decides what the user should actually DO — see `hooks_path_scope`.
            // A second `git config` call, on this rare path only, so the read above that park and
            // the inertness check depend on keeps its exact shape.
            let scope = git(repo_root, &["config", "--show-scope", "--get", "core.hooksPath"])
                .map(|raw| hooks_path_scope(&raw))
                .unwrap_or("unknown");
            tracing::warn!(
                repo = %repo_root,
                installed_into = %hooks_dir.display(),
                scope = %scope,
                "roborev hooks installed but core.hooksPath redirects git elsewhere — they will \
                 not run, so per-commit review is inert here. Re-enabling means one of two \
                 things, each with a cost: make the configured dir run them (it may already hold \
                 a post-commit/post-rewrite of its own, which wants chaining rather than \
                 overwriting, and a global/system dir is shared by every repo on this machine), \
                 or point core.hooksPath at installed_into for this repo — core.hooksPath is a \
                 single path, not additive, so that REPLACES the configured dir here and its \
                 hooks stop running in this repo. Write that override with --worktree, not \
                 --local, when the scope below is `worktree`; a scope of `command` comes from the \
                 invocation environment (-c / GIT_CONFIG_*), which no config change reaches."
            );
        }
    }
    Ok(())
}

/// Remove the roborev git hooks from the repo's hooks dir, but ONLY when a hook's contents mark
/// it as ours (the vendored marker substring) — a user's own same-named hook is left untouched. A
/// missing hook is a no-op. Idempotent. Best-effort per file: an unreadable/undeletable hook is
/// skipped rather than aborting the sweep.
pub fn remove_repo_hooks(repo_root: &str) -> Result<(), String> {
    let hooks_dir = hooks_dir_for(repo_root);
    for (name, marker) in ROBOREV_HOOKS {
        let hook = hooks_dir.join(name);
        // Only touch a hook that EXISTS and whose contents identify it as ours.
        let Ok(contents) = std::fs::read_to_string(&hook) else {
            continue; // missing or unreadable — nothing of ours to remove
        };
        if contents.contains(marker) {
            let _ = std::fs::remove_file(&hook); // best-effort; a failure just leaves it in place
        }
    }
    Ok(())
}

/// Thin Tauri wrapper: install the roborev hooks into `path`'s repo (frontend toggle-on sweep).
#[tauri::command]
pub async fn install_repo_hooks_cmd(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_repo_hooks(&app, &path))
        .await
        .map_err(|e| format!("install_repo_hooks task failed: {e}"))?
}

/// Thin Tauri wrapper: remove the roborev hooks from `path`'s repo (frontend toggle-off sweep).
#[tauri::command]
pub async fn remove_repo_hooks_cmd(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_repo_hooks(&path))
        .await
        .map_err(|e| format!("remove_repo_hooks task failed: {e}"))?
}

/// Append `.sparkle/` to `<root>/.gitignore` if not already ignored. Idempotent.
/// The scratch-worktree paths that must never read as untracked dirt.
///
/// `park_worktree_on_base_at` declines on ANY `??` entry and nothing ever claims a scratch worktree,
/// so one left behind pins the app-owned worktree to its branch permanently — every later hourly
/// pass then starts from a base drifting further behind `origin/main`. These are the two locations
/// agents are told to cut them (AGENTS.md); the `.wt-` dot prefix is load-bearing, keeping the glob
/// from matching real source directories like `wt-real.ts` or `src/wt-foo/`.
// Includes `.sparkle-*/`: the hourly improvement pass cuts its OWN scratch worktrees/dirs under a
// `.sparkle-` prefix (seen live as `.sparkle-improve-wt/`, `.sparkle-scratch/`), and those `??`
// entries are exactly what made the app-owned worktree's park decline `dirty` every hour. A glob,
// like `.wt-*/`, so a future name is covered; the trailing slash and the hyphen keep it off the
// tracked `.sparkle/` config dir. Kept in step with `.gitignore` by
// `scripts/tests/ignore-agent-worktrees.test.sh`.
//
// The last three are the beads runtime store (`sparkle-3u61`). `.beads/.gitignore` already excludes
// `embeddeddolt/`, `dolt/` and `proxieddb/`, but those patterns are DIRECTORY-ONLY (trailing slash)
// and do NOT match a SYMLINK. On the live machine a beads consolidation left `.beads/embeddeddolt`
// as a symlink to the canonical store, so `git status` reported `?? .beads/embeddeddolt`
// permanently and every hourly park declined `dirty` — the wedge this const already exists to
// prevent, in a new disguise. These entries carry NO trailing slash so they match the store whether
// it is a symlink, a directory OR a file, and independent of how stale the checked-out
// `.beads/.gitignore` is (a wedged worktree is pinned to an old branch that predates any fix). The
// store is runtime data that is never committed, so excluding it in the untracked `info/exclude`
// only ever suppresses dirt that had no business blocking the park.
const AGENT_WORKTREE_IGNORES: [&str; 6] = [
    ".claude/worktrees/",
    ".wt-*/",
    ".sparkle-*/",
    ".beads/embeddeddolt",
    ".beads/dolt",
    ".beads/proxieddb",
];

/// Append any of `patterns` missing from the newline-delimited `existing`, or `None` when all are
/// already present. Pure so the idempotency rule is unit-testable without a filesystem.
///
/// Matching trims each line and also accepts a pattern's slashless form, so a hand-written
/// `.sparkle` counts as `.sparkle/` and we never append a near-duplicate to a user's own file.
fn append_missing_ignores(existing: &str, patterns: &[&str]) -> Option<String> {
    let present: Vec<&str> = existing.lines().map(str::trim).collect();
    let missing: Vec<&str> = patterns
        .iter()
        .copied()
        .filter(|p| {
            let bare = p.trim_end_matches('/');
            !present.iter().any(|l| *l == *p || *l == bare)
        })
        .collect();
    if missing.is_empty() {
        return None;
    }
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for p in missing {
        out.push_str(p);
        out.push('\n');
    }
    Some(out)
}

/// Seed the project's tracked `.gitignore` with `.sparkle/`.
///
/// DELIBERATELY ONLY `.sparkle/` — the scratch-worktree patterns are carried by
/// [`ensure_worktree_excludes`] instead, and that is not an oversight (roborev 55374). Adding them
/// here regressed two things:
///
///   * it appended to a TRACKED file in every already-provisioned user project on the next open, an
///     unrequested modification that shows up in the user's `git status`/`git diff` and can be swept
///     into a `git commit -a`; and
///   * it turned a path that previously returned `Ok(())` without touching the filesystem into one
///     that writes, and the error propagates via `?` from `ensure_project_repo_inner` — so a
///     read-only project root that opened fine before would fail to open.
///
/// Neither cost bought anything: `park_worktree_on_base` never runs on user projects (its only
/// caller is the improvement pass, against the app-owned Sparkle clone), and `info/exclude` — shared
/// and untracked — already covers the hygiene goal without dirtying a tree. This repo's own
/// checked-in `.gitignore` remains the durable record for the patterns, pinned by
/// `scripts/tests/ignore-agent-worktrees.test.sh`.
fn ensure_gitignore(root: &str) -> Result<(), String> {
    let gitignore: PathBuf = Path::new(root).join(".gitignore");
    let existing = std::fs::read_to_string(&gitignore).unwrap_or_default();

    match append_missing_ignores(&existing, &[".sparkle/"]) {
        None => Ok(()),
        Some(contents) => std::fs::write(&gitignore, contents)
            .map_err(|e| format!("failed to write .gitignore: {e}")),
    }
}

/// Seed the scratch-worktree patterns into `$GIT_COMMON_DIR/info/exclude` as well.
///
/// A TRACKED `.gitignore` rule is inert in exactly the state it is meant to fix (roborev 54865). The
/// park reads `git status --porcelain` inside the app-owned worktree, which honours the `.gitignore`
/// of *whatever branch is checked out there* — and a wedged worktree is pinned to an old branch that
/// predates the rule. So the `??` entry still appears, the park still declines `dirty`, and the
/// worktree never advances to a branch containing the fix: self-perpetuating.
///
/// `info/exclude` breaks that loop because it lives in the COMMON gitdir, shared by every linked
/// worktree and independent of the checked-out branch and of any commit. It is also untracked, so
/// this never dirties the user's tree — which matters given the caller runs on repo prep.
///
/// Best-effort by design: this is a hygiene measure on a path whose failure must not block opening a
/// project, so an unwritable gitdir returns Ok. The tracked `.gitignore` entry remains the durable
/// record for repo hygiene; this is what makes it effective on an already-pinned worktree.
fn ensure_worktree_excludes(root: &str) -> Result<(), String> {
    let info = common_dir_for(root).join("info");
    if std::fs::create_dir_all(&info).is_err() {
        return Ok(());
    }
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if let Some(contents) = append_missing_ignores(&existing, &AGENT_WORKTREE_IGNORES) {
        let _ = std::fs::write(&exclude, contents);
    }
    Ok(())
}

/// Core (AppHandle-free, testable): create or reuse an agent's worktree under `app_data`,
/// OUTSIDE the project tree. Idempotent: re-running for an existing worktree returns its info.
pub fn create_worktree_at(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Result<WorktreeInfo, String> {
    let branch = format!("sparkle/agent-{agent_id}");

    // Migrate a legacy in-tree worktree (<root>/.sparkle/worktrees/<id>) out to app_data.
    let legacy = Path::new(root).join(".sparkle").join("worktrees").join(agent_id);
    if legacy.exists() {
        let legacy_str = legacy.to_string_lossy().to_string();
        let dirty = git(&legacy_str, &["status", "--porcelain"]).map(|s| !s.is_empty()).unwrap_or(false);
        if dirty {
            return Err(format!(
                "This agent has uncommitted work in its old location ({legacy_str}). \
                 Commit it before reopening so Sparkle can relocate the workspace safely."
            ));
        }
        // Clean: drop the legacy worktree; its branch persists and is re-checked-out below.
        let _ = git(root, &["worktree", "remove", "--force", &legacy_str]);
    }

    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt_str = wt.to_string_lossy().to_string();

    // Idempotent: if the path already exists and is a valid worktree, return it.
    if wt.exists() && git(&wt_str, &["rev-parse", "--is-inside-work-tree"]).is_ok() {
        return Ok(WorktreeInfo { path: wt_str, branch });
    }

    // Ensure parent dirs exist (git creates the leaf, but not intermediate dirs).
    if let Some(parent) = wt.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create worktree dir: {e}"))?;
    }

    // Create the branch off HEAD and add the worktree. If the branch already exists
    // from a prior run, fall back to adding a worktree on the existing branch.
    let branch_exists = git(
        root,
        &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")],
    )
    .is_ok();

    if branch_exists {
        // RESUME: the branch already exists (a reopened agent whose worktree dir was removed). Re-
        // attach it directly — NOT via the pool, whose slots are fresh detached checkouts that would
        // discard the branch's existing commits. Under the per-repo lock so a background warm can't
        // collide on index.lock.
        let gl = repo_git_lock(root);
        let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());
        git(root, &["worktree", "add", &wt_str, &branch])?;
    } else {
        // FAST PATH: claim a pre-warmed parked worktree if one is available and still cut from the
        // current base. The claim moves it to `wt` and cuts `branch` there — an identical result to
        // the slow path below, minus the multi-second tree materialization.
        if let Some(info) = try_claim_pooled_worktree(root, project_id, agent_id, base_branch, app_data) {
            // Preserve the slow path's cadence: kick the throttled `origin/<base>` refresh (so a
            // fully-warmed workflow, where every spawn claims, still nudges the fetch), then refill
            // the slot we just consumed. Both off the critical path.
            spawn_background_origin_refresh(root, base_branch);
            spawn_pool_topup(root, project_id, base_branch, app_data);
            return Ok(info);
        }
        // SLOW PATH (pool disabled / empty / stale): cut IMMEDIATELY from the last-known integration
        // base (no blocking network fetch on the spawn critical path — an unreachable remote must
        // never stall opening an agent). A background, throttled fetch then refreshes `origin/<base>`
        // so the NEXT agent's cut and this branch's later refresh see a fresh tip. Held under the
        // per-repo lock so a background warm can't collide on index.lock.
        let base = effective_base(root, base_branch, false);
        // `effective_base` guarantees a RESOLVABLE ref in every normal repo, but documents one
        // terminal case where it hands back the logical name verbatim: an unborn HEAD / empty repo
        // where nothing — not origin/<base>, a local branch, the detected default, nor even HEAD —
        // resolves to a commit. Feeding that name straight to `git worktree add -b … <base>` dead-ends
        // with a cryptic `fatal: invalid reference: main` (seen in the wild) that reads like a Sparkle
        // bug and gives the user nothing to act on. Pre-check the cut point and, when it has no commit,
        // return the actionable message `effective_base`'s own contract defers to the caller for.
        if git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).is_err() {
            return Err(format!(
                "Can't open an agent here: the base branch '{base}' has no commits yet, so there's \
                 nothing to branch a workspace from. Make an initial commit in this repository, then \
                 try again."
            ));
        }
        {
            let gl = repo_git_lock(root);
            let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());
            git(root, &["worktree", "add", "-b", &branch, &wt_str, &base])?;
        }
        spawn_background_origin_refresh(root, base_branch);
        // Seed/refill the pool so the NEXT spawn in this fan-out can claim instead of cutting inline.
        spawn_pool_topup(root, project_id, base_branch, app_data);
    }

    Ok(WorktreeInfo { path: wt_str, branch })
}

/// Cut a worker's worktree from a parent agent's LOCAL branch, with NO network fetch.
/// Workers branch off another agent's local branch (e.g. `sparkle/agent-<build>`), which never
/// exists on a remote — so unlike `create_worktree_at` we never touch `origin`. Idempotent.
pub fn create_worktree_from_local(
    root: &str,
    project_id: &str,
    worker_id: &str,
    local_base_branch: &str,
    app_data: &Path,
) -> Result<WorktreeInfo, String> {
    let base = local_base_branch.trim();
    if base.is_empty() {
        return Err("parent_branch is required".into());
    }
    // Reject a ref shaped like a git option / with control chars before it reaches any git arg.
    validate_ref(base)?;
    // The base must exist locally — workers descend from a sibling agent's local branch.
    git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{base}")])
        .map_err(|_| format!("parent branch '{base}' does not exist locally"))?;

    let branch = format!("sparkle/agent-{worker_id}");
    let wt = worktree_path(app_data, project_id, worker_id)?;
    let wt_str = wt.to_string_lossy().to_string();

    // Idempotent: existing valid worktree → return it. This path is keyed by `worker_id`, which
    // is a fresh UUID per worker agent and never reused across cuts, so an existing worktree here
    // is always THIS worker's own (already on `sparkle/agent-<worker_id>`) — not a stale cut from
    // a different base. We therefore don't re-verify its branch/ancestry.
    if wt.exists() && git(&wt_str, &["rev-parse", "--is-inside-work-tree"]).is_ok() {
        return Ok(WorktreeInfo { path: wt_str, branch });
    }
    if let Some(parent) = wt.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create worktree dir: {e}"))?;
    }

    let branch_exists =
        git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if branch_exists {
        // Recovery path: the worker's own branch already exists but its worktree dir is gone
        // (e.g. externally deleted). Under the UUID `worker_id` invariant this branch is always
        // THIS worker's — already cut from `base` on the first call — so re-attaching it (rather
        // than re-cutting from `base`) is correct and preserves the lineage established then. We
        // intentionally do NOT pass `base` here: a re-cut would discard the worker's own commits.
        git(root, &["worktree", "add", &wt_str, &branch])?;
    } else {
        git(root, &["worktree", "add", "-b", &branch, &wt_str, base])?;
    }
    Ok(WorktreeInfo { path: wt_str, branch })
}

/// Create (or return) a worker's worktree, cut from `parent_branch` (a local branch).
#[tauri::command]
pub async fn create_worker_worktree(
    app: AppHandle,
    root: String,
    project_id: String,
    worker_id: String,
    parent_branch: String,
) -> Result<WorktreeInfo, String> {
    tracing::info!(%root, %project_id, %worker_id, %parent_branch, "create_worker_worktree");
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree_from_local(&root, &project_id, &worker_id, &parent_branch, &app_data)
            .inspect_err(|e| tracing::error!(%worker_id, error = %e, "create_worker_worktree failed"))
    })
    .await
    .map_err(|e| format!("create_worker_worktree task failed: {e}"))?
}

/// Create (or return, if it already exists) the isolated worktree for `agent_id`.
/// Idempotent: re-running for an existing worktree returns its info without error.
/// `base_branch` is the logical integration branch (e.g. `main`) the new branch is cut from.
#[tauri::command]
pub async fn create_agent_worktree(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
) -> Result<WorktreeInfo, String> {
    tracing::info!(%root, %project_id, %agent_id, %base_branch, "create_agent_worktree");
    let app_data = app_data_dir(&app)?;
    let started = std::time::Instant::now();
    // Run the git worktree mechanics off the main thread so the subprocess work (and any residual
    // git I/O) can't freeze the UI. The network fetch is now backgrounded inside `create_worktree_at`,
    // so this task is bounded by local git only.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        create_worktree_at(&root, &project_id, &agent_id, &base_branch, &app_data)
            .inspect_err(|e| tracing::error!(%agent_id, error = %e, "create_agent_worktree failed"))
    })
    .await
    .map_err(|e| format!("create_agent_worktree task failed: {e}"))?;
    log_worktree_op_duration("create_agent_worktree", started.elapsed(), outcome.is_ok());
    outcome
}

/// How long a worktree create/remove may take before its duration is worth a WARN rather than an
/// INFO. Both operations sit on the spawn path — they serialize on the per-root git lock, so one
/// slow teardown delays every prepare and remove queued behind it on the same project.
///
/// 10s is the top of the range the removal doc comment has always claimed (`git worktree remove
/// --force` deletes the whole checkout from disk), so crossing it means the operation is outside
/// the cost this code was written for rather than merely on a slow day.
const WORKTREE_OP_SLOW_MS: u128 = 10_000;

/// Record what a worktree create/remove actually COST, which until now was unrecorded.
///
/// Both commands logged only that they had started, so their duration could be recovered solely by
/// diffing timestamps against whatever unrelated line happened to come next — and only when one
/// did. That made a real regression invisible: with dependencies now installed into every fresh
/// worktree, a teardown deletes a fully populated `node_modules` (a hundred thousand-odd hardlinked
/// files), and the per-root git lock makes the next agent's prepare wait behind it. Observed on this
/// path as a ~33s removal sitting in front of an unrelated agent's spawn, which surfaced to the user
/// only as a spawn that took 39s to reach a prompt with no phase to blame it on.
///
/// Deliberately just a measurement: no timeout, no change to what either command does. The point is
/// to make the cost show up in the logs as its own number so a fix can be aimed at it — and so it
/// stays visible afterwards rather than silently regressing again.
///
/// No path, no id: the caller has already logged those, and the duration is the part that was
/// missing.
/// Is this duration past [`WORKTREE_OP_SLOW_MS`]? Split out from the logging so the boundary is
/// testable — the logging itself is a `tracing` call with nothing to assert against.
fn worktree_op_is_slow(elapsed: std::time::Duration) -> bool {
    elapsed.as_millis() >= WORKTREE_OP_SLOW_MS
}

fn log_worktree_op_duration(op: &'static str, elapsed: std::time::Duration, ok: bool) {
    let ms = elapsed.as_millis();
    if worktree_op_is_slow(elapsed) {
        tracing::warn!(
            op, elapsed_ms = %ms, ok,
            "worktree operation was slow; see the matching repo-lock wait to tell queueing from work"
        );
    } else {
        tracing::info!(op, elapsed_ms = %ms, ok, "worktree operation finished");
    }
}

/// A lock wait at or past this is worth its own line. Deliberately well under
/// [`WORKTREE_OP_SLOW_MS`]: the point is to explain a total that has ALREADY crossed the slow
/// threshold, so the wait has to be visible before it alone would trip that threshold. Any shorter
/// and the ordinary contention of a fan-out teardown — every window issuing its own removal —
/// would log continuously without telling anyone anything.
const REPO_LOCK_WAIT_LOG_MS: u128 = 1_000;

/// Is this lock wait worth a line of its own? Split out from the logging for the same reason as
/// [`worktree_op_is_slow`] — a `tracing` call has nothing to assert against.
fn repo_lock_wait_is_notable(waited: std::time::Duration) -> bool {
    waited.as_millis() >= REPO_LOCK_WAIT_LOG_MS
}

/// Record how long an op sat waiting for the per-repo git lock, as a number distinct from its
/// total.
///
/// [`log_worktree_op_duration`]'s clock starts in the async command, BEFORE the blocking body
/// takes the lock — so its `elapsed_ms` is lock wait plus work, and on its own it cannot say which
/// dominates. The warning used to assert the strong reading ("anything queued behind it waited
/// too"), which the number does not support: a 30s removal that waited 29s for the lock did almost
/// nothing itself and delayed nobody further.
///
/// The distinction picks the fix, which is why it is worth a field. A large wait means too many
/// removals are serialized against one repo — teardown fan-out, addressed by deduplicating them.
/// A large total-minus-wait means the deletion itself is the cost — addressed by moving the
/// `node_modules` unlink out from under the lock. Aiming at the wrong one buys nothing.
///
/// Logged at INFO, not WARN: a wait is context for a warning that has already fired, not a second
/// alarm. No path, no id — the caller has logged those.
fn log_repo_lock_wait(op: &'static str, waited: std::time::Duration) {
    if repo_lock_wait_is_notable(waited) {
        let ms = waited.as_millis();
        tracing::info!(op, waited_ms = %ms, "waited for this project's git lock before starting");
    }
}

/// What a park is allowed to do about a worktree that is dirty with something OTHER than the
/// session-tooling churn [`tooling_churn_to_restore`] already whitelists.
///
/// OPT-IN BY CONSTRUCTION, and that is the whole point of it being a parameter rather than a
/// behaviour change. [`park_worktree_on_base_at`] is generic over worktrees, but only ONE caller
/// today points it at a worktree the app itself owns end-to-end (the recurring headless
/// self-improvement pass). A worktree cut from a USER'S own repository must keep the historical
/// decline-don't-touch semantics: their uncommitted edits are not ours to relocate, however
/// recoverable the relocation is. So the default is [`DirtyPolicy::Decline`], and widening it is
/// something a call site has to say out loud.
#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DirtyPolicy {
    /// Today's behaviour, and the default: real dirt declines the park and the tree is left exactly
    /// as it was found.
    #[default]
    Decline,
    /// Set real dirt aside into a per-agent stash and park anyway. STASH, never commit and never
    /// discard — see the call site in [`park_worktree_on_base_at`] for why those are the two things
    /// this deliberately does not do.
    Stash,
}

/// What [`park_worktree_on_base_at`] did (or, when `parked` is false, why it declined). `reason`
/// is a stable machine token, never prose, so the caller can log it without leaking a path.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ParkOutcome {
    /// True only when the worktree now sits on the freshly-fetched base.
    pub parked: bool,
    /// `already-fresh` | `no-worktree` | `dirty` | `unpushed` | `no-base` | `checkout-failed`.
    pub reason: String,
    /// True when this park pushed a stash — session-tooling churn, or (under
    /// [`DirtyPolicy::Stash`]) the whole leftover tree. It means "something was set aside and is
    /// recoverable by hand from `git stash list`", so the caller can say so rather than implying a
    /// park found nothing to move. Single bare word deliberately: [`ParkOutcome`] has no
    /// `rename_all`, so the field name crosses to TypeScript exactly as written.
    pub stashed: bool,
}

impl ParkOutcome {
    fn declined(reason: &str) -> Self {
        Self { parked: false, reason: reason.into(), stashed: false }
    }
}

/// Tracked files that the agent's OWN session tooling rewrites, which are therefore never work in
/// progress. Exact repo-relative paths, never prefixes: a directory rule would quietly grow to
/// cover files that are genuine work.
///
/// `.beads/interactions.jsonl` is the whole list today. Beads is the work-tracker Sparkle installs
/// hooks for, and those hooks append to this log on every agent session — so the file is modified
/// within seconds of an agent starting, long before the pass has decided to do anything.
///
/// "Regenerated" is NOT "worthless": the lines are real records (an issue closing, and the reason
/// written for closing it) and the file has a commit history, so they are meant to land. Eligibility
/// here means only that they can be moved OUT OF THE WAY without asking — which is why the park
/// stashes them rather than restoring over them. See the call site.
const TOOLING_CHURN_PATHS: &[&str] = &[".beads/interactions.jsonl"];

/// Stash message identifying a park's own churn entry, so the next park can retire it rather than
/// stack another. Matched by substring against `git stash list`, so it must stay distinctive.
const PARK_CHURN_STASH_MARKER: &str = "sparkle: session-tooling churn from park";

/// Stash message for the WHOLE leftover tree a [`DirtyPolicy::Stash`] park sets aside.
///
/// DISTINCT FROM [`PARK_CHURN_STASH_MARKER`], not a reuse of it, because retiring is scoped by
/// marker. Sharing one marker would bound the stash at a single entry per agent, but it would do so
/// by letting a churn-only park — the cheap, routine case — retire the entry holding a previous
/// pass's REAL leftover work, which is the more valuable of the two and the one a human is more
/// likely to come looking for. Two markers means at most one live entry of each kind per agent:
/// still bounded, and the retiring never crosses between kinds.
const PARK_DIRT_STASH_MARKER: &str = "sparkle: leftover worktree dirt from park";

/// How many leftover-dirt stashes survive per agent, newest first.
///
/// NOT ONE, which is what churn keeps and what this originally copied. Each dirt entry holds a
/// DIFFERENT pass's unrecovered work — hour 1's half-finished edit and hour 2's unrelated one are
/// not the same content, and neither supersedes the other — and a dirt stash is only ever popped by
/// hand, so retiring on the churn rule silently destroyed the older one before anyone knew it
/// existed (roborev 55238).
///
/// A ring rather than no bound at all: an unbounded push still stacks an entry per failed pass
/// forever, pinning blobs against gc. Ten is the operating point because dirt is EXCEPTIONAL — it
/// takes a pass that died mid-edit to produce any, unlike churn which is dirty on essentially every
/// pass — so ten covers well over a day of consecutive failures, by which point the red row and its
/// remedy text have been sitting in front of the user for a long time.
const PARK_DIRT_STASH_KEEP: usize = 10;

/// Churn keeps exactly one: the file is whitelisted and routinely regenerated, so entry N+1 really
/// does supersede entry N. Named rather than inlined so the contrast with the constant above is
/// visible at both call sites.
const PARK_CHURN_STASH_KEEP: usize = 1;

/// Push a stash under a PER-AGENT marker, then retire that marker's older entries. `Ok(())` only
/// when the push itself succeeded — every caller keys its fail-closed handling off that.
///
/// The marker is per agent because `refs/stash` is REPOSITORY-WIDE, not per worktree: several
/// app-owned worktrees share one repo, so a shared marker would have agent A's park retiring agent
/// B's only recovery copy — the reverse of what retiring is for.
///
/// PUSH FIRST, RETIRE AFTER — never the other way round. Retiring first was deletion deferred by one
/// pass: `stash push` is fallible (a locked index, a pathspec git refuses), and on that path the
/// previous entry was already gone and no new one existed, so an operation that was supposed to lose
/// nothing had destroyed the only recoverable copy. Sequenced this way, a failed push leaves the
/// older entry exactly where it was and the tree untouched.
///
/// Retiring at all is bounded growth, not supersession: park runs hourly, so an unconditional push
/// stacks an entry per hour forever, each pinning its blobs against gc and each surfacing in the
/// main checkout's `git stash list`. Do NOT read the surviving entry as containing the retired ones
/// — each stash is the diff against the tree at ITS park, and the tree is reverted in between.
///
/// HOW MANY TO KEEP IS THE CALLER'S CALL, and it is not a tuning knob — the two kinds of stash have
/// different contents and the wrong answer DESTROYS WORK (roborev 55238). Churn is a whitelisted,
/// routinely-regenerated file, so entry N+1 genuinely supersedes entry N and keeping one is right.
/// Leftover DIRT is different in kind: each entry holds a *different* pass's unrecovered work, it is
/// only ever popped by hand, and nothing tells anyone it exists — so retiring on the churn rule
/// meant hour 1's half-finished `notes.md` was dropped, unreachable and gc-able, the moment hour 2
/// stashed an unrelated `plan.md`. That is a destroy path in the one module whose whole invariant is
/// "declines rather than destroys". Dirt therefore keeps a bounded RING (see
/// [`PARK_DIRT_STASH_KEEP`]) instead of a single entry.
///
/// `keep` is how many entries under this marker survive, newest first. It is clamped to at least 1,
/// so the entry just pushed can never be retired by the call that pushed it.
fn push_park_stash(
    wt: &str,
    agent_id: &str,
    marker_base: &str,
    extra_args: &[&str],
    paths: &[String],
    keep: usize,
) -> Result<(), String> {
    let marker = format!("{marker_base} [{agent_id}]");
    let mut cmd: Vec<&str> = vec!["stash", "push", "--quiet"];
    cmd.extend_from_slice(extra_args);
    cmd.extend_from_slice(&["-m", &marker]);
    if !paths.is_empty() {
        cmd.push("--");
        cmd.extend(paths.iter().map(String::as_str));
    }
    git(wt, &cmd)?;
    // `git stash list` is NEWEST FIRST, so this marker's entries come back in that order and
    // `skip(keep)` leaves exactly the `keep` most recent alive. The entry just pushed is
    // `stash@{0}` and is therefore always among them (keep is at least 1), which is what keeps this
    // a retire rather than a self-erase.
    //
    // Dropped HIGHEST INDEX FIRST — `stash drop` renumbers everything below the entry it removes, so
    // dropping in list order would make every later index refer to the wrong entry. `.rev()` over a
    // newest-first list gives descending indices.
    let keep = keep.max(1);
    if let Ok(list) = git(wt, &["stash", "list", "--format=%gd%x09%gs"]) {
        let stale: Vec<String> = list
            .lines()
            .filter(|l| l.contains(&marker))
            .filter_map(|l| l.split('\t').next())
            .skip(keep)
            .map(str::to_string)
            .collect();
        for entry in stale.iter().rev() {
            let _ = git(wt, &["stash", "drop", "--quiet", entry]);
        }
    }
    Ok(())
}

/// Split one porcelain-v1 line into its `XY` status code and its path.
///
/// Porcelain v1 is `XY<space><path>`, which would be a fixed-offset slice were it not for [`git`]
/// TRIMMING its output: the FIRST line of the status arrives with its leading `X` space already
/// eaten, so the real caller sees `M .beads/…` where the format says ` M .beads/…`. Reading a fixed
/// offset there yields the code `M ` and a path missing its first character — which matched nothing
/// in [`TOOLING_CHURN_PATHS`], so the fix silently did nothing on a one-file status, the only shape
/// it was written for. Accept both, and re-pad the stripped form so callers always compare a real
/// two-column code.
///
/// Returns `None` for anything that is not recognisably `XY<space><path>`, so a garbled or
/// truncated line can never read as clean.
fn split_status_line(line: &str) -> Option<(String, &str)> {
    // Status codes are ASCII, so a line that does not start with two single-byte characters is not
    // one — the boundary checks keep the slicing panic-free rather than merely correct.
    if line.len() > 3 && line.is_char_boundary(2) && line.is_char_boundary(3) && &line[2..3] == " " {
        return Some((line[..2].to_string(), &line[3..]));
    }
    if line.len() > 2 && line.is_char_boundary(1) && line.is_char_boundary(2) && &line[1..2] == " " {
        return Some((format!(" {}", &line[..1]), &line[2..]));
    }
    None
}

/// Decide whether a `git status --porcelain` tree is parkable, and if so which paths must be
/// restored first. `None` means "real work in progress — decline"; `Some(paths)` means the only
/// dirt is session-tooling churn (possibly none at all, for an already-clean tree).
///
/// WHY THIS EXISTS. The dirty check was a bare `!porcelain.is_empty()`, which is correct for an
/// interactive agent but made parking IMPOSSIBLE for the recurring headless one. The tooling above
/// dirties the worktree during pass N; nothing commits it (a pass is instructed not to commit work
/// it did not author); pass N+1 reads a dirty tree and declines; repeat every hour, forever. The
/// decline is not a one-off — it is a fixed point. Observed on the app-owned worktree as an
/// unbroken hourly run of `starting from a stale base — dirty` while the branch drifted to 38
/// commits behind `origin/main`, past the threshold at which the desktop build refuses to build
/// from it at all. The staleness this function exists to prevent was being caused by its own guard.
///
/// STILL CONSERVATIVE, deliberately, because the cost of a false positive here is destroyed work:
///   * only the exact paths in [`TOOLING_CHURN_PATHS`] are ever eligible,
///   * only status codes made of ` ` and `M` (` M`, `M `, `MM`) — an ordinary edit to a tracked
///     file. Untracked (`??`) is excluded so this can never DELETE a file; added/deleted/renamed
///     and every unmerged code (`U`, `AA`, `DD`) is excluded because each one means something
///     happened that a plain restore would not faithfully undo,
///   * a rename entry (`old -> new`) or a quoted path is refused outright rather than parsed,
///   * ONE ineligible entry declines the WHOLE tree. Tooling churn alongside real work is real
///     work, so a pass that left an edit behind is protected exactly as it was before.
fn tooling_churn_to_restore(porcelain: &str) -> Option<Vec<String>> {
    let mut restore = Vec::new();
    for line in porcelain.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let (code, path) = split_status_line(line)?;
        if !matches!(code.as_str(), " M" | "M " | "MM") {
            return None;
        }
        // A path git had to quote (spaces, non-ASCII, control characters) is C-escaped, so the
        // bytes here are not the bytes to hand back to git. None of the eligible paths need it.
        if path.starts_with('"') || path.contains(" -> ") {
            return None;
        }
        if !TOOLING_CHURN_PATHS.contains(&path) {
            return None;
        }
        restore.push(path.to_string());
    }
    Some(restore)
}

/// Whether HEAD's commits are put at risk by the park, given HEAD's branch (`None` when detached)
/// and the agent's own branch name.
///
/// WHY THIS IS NARROWER THAN "HEAD HAS UNPUSHED COMMITS". The park ends in
/// `checkout -B sparkle/agent-<id> <base>`, which moves exactly ONE ref: the agent's own branch.
/// Every other local branch is left pointing exactly where it was. So a commit that some *other*
/// named branch holds is still reachable by name after the park — `git log <that branch>` shows it,
/// and it is not a candidate for gc. It was never at risk, and refusing to park over it protects
/// nothing.
///
/// That distinction is the whole bug. The recurring headless pass does its work on a topic branch
/// (`sparkle/improve-<topic>`), not on `sparkle/agent-<id>`. When a pass is killed by its watchdog —
/// or finishes but cannot push, e.g. an unauthenticated `gh` — it leaves that topic branch checked
/// out with commits no origin ref contains. Counting HEAD unconditionally then reads those as
/// unpushed and declines, *and does so on every subsequent hour*: nothing ever pushes an abandoned
/// branch, so the decline is permanent. The worktree is pinned to that branch forever, and every
/// later pass starts from a base that drifts further behind `origin/main` — eventually past the
/// threshold at which the desktop build refuses to build from it. This is the same shape as the
/// `dirty` valve's own regression (see [`tooling_churn_to_restore`]): a guard against destroying
/// work became the thing causing the staleness it exists to prevent.
///
/// STILL CONSERVATIVE where it counts. Two cases keep HEAD in the at-risk set:
///   * DETACHED HEAD — no ref names those commits, so moving off them strands them outright. This
///     is the case the valve is really for, and it stays fully protected.
///   * HEAD ON THE AGENT'S OWN BRANCH — that is precisely the ref `checkout -B` resets, so its
///     commits go unreachable. Unchanged from before.
/// The agent branch is also checked independently of HEAD by the caller, so it is protected whether
/// or not it happens to be checked out.
fn head_is_at_risk(head_branch: Option<&str>, agent_branch: &str) -> bool {
    match head_branch {
        None => true,
        Some(b) => b == agent_branch,
    }
}

/// Summarise a `git status --porcelain` tree by STATUS CODE ONLY, for the log line that accompanies
/// a `dirty` decline.
///
/// WHY CODES AND NOT PATHS. A decline currently reports the single word `dirty`, which says a park
/// was refused but nothing about what refused it — and the two causes want opposite fixes. Dirt that
/// is entirely ` M` on tracked files is a leftover EDIT from a pass that died before it could commit
/// or set its work aside; dirt that is `??` is untracked residue (a scratch file, a half-written
/// build artifact) that no pass will ever claim. Told apart, the first is a bug in how a killed pass
/// unwinds and the second is a file somebody forgot to ignore. Told only as `dirty`, neither is
/// actionable, and the episode is unreconstructable after the fact because the tree has moved on.
///
/// Paths are deliberately NOT included. This runs for every agent worktree, including ones cut from
/// a user's own repository, where a filename is their content — and the codes alone carry the whole
/// distinction above. `??` is reported separately from the rest for the same reason
/// [`tooling_churn_to_restore`] excludes it: it is the one class that a restore could never undo.
///
/// A line this cannot parse is counted under `?` rather than dropped, so the total always equals the
/// number of non-blank porcelain lines and a garbled status can never read as a smaller tree.
fn describe_blocking_dirt(porcelain: &str) -> String {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut total = 0usize;
    for line in porcelain.lines() {
        if line.trim().is_empty() {
            continue;
        }
        total += 1;
        let code = match split_status_line(line) {
            Some((code, _)) => code,
            None => "?".to_string(),
        };
        *counts.entry(code).or_insert(0) += 1;
    }
    if total == 0 {
        return "0 entries".to_string();
    }
    let breakdown = counts
        .iter()
        .map(|(code, n)| format!("{n}×'{code}'"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{total} entries: {breakdown}")
}

/// Core (AppHandle-free, testable): park an UNATTENDED, app-owned agent worktree back on a fresh
/// `origin/<base>` so the next headless run starts from an up-to-date base instead of inheriting
/// whatever branch the previous run left checked out.
///
/// `create_worktree_at` is idempotent by *returning the existing worktree untouched* — correct for
/// an interactive agent (its in-progress branch must survive), but it means a recurring headless
/// pass accumulates staleness forever: each run reuses the last run's topic branch, drifting
/// further behind `origin/main` every hour. That is precisely the trap AGENTS.md calls out ("Start
/// work on a FRESH branch (never a stale base)"), and it eventually blocks the desktop build, whose
/// staleness gate refuses a branch too far behind.
///
/// This is deliberately CONSERVATIVE — it declines rather than destroys. Parking happens only when
/// there is provably nothing to lose:
///   * the worktree exists and is a real worktree (`no-worktree` otherwise),
///   * the tree is clean — no uncommitted or unmerged files (`dirty`),
///   * every commit this park could put beyond reach already exists on some `origin/*` ref
///     (`unpushed`) — this is the valve that protects a run which committed but could not push
///     (e.g. an unauthenticated `gh`). That set is the agent's own branch, plus HEAD only when HEAD
///     is detached or on the agent branch: `checkout -B` moves one ref, so a commit any OTHER named
///     branch holds stays reachable by name and was never at risk. See [`head_is_at_risk`] for why
///     counting HEAD unconditionally made this decline PERMANENTLY on the recurring headless
///     worktree. A draft on a topic branch is therefore kept by that branch's ref, not by this valve.
/// Only then does it `checkout -B` the agent branch onto the fresh base. A failed fetch is
/// non-fatal: it falls through to the last-known `origin/<base>`, so an offline machine still gets
/// parked (just not freshened) rather than erroring.
///
/// THE FETCH RUNS FIRST, before the containment proof and before every decline path, and both
/// orderings are load-bearing:
///   * Containment is a claim about origin AS IT IS NOW. Proving it against a stale snapshot of
///     `refs/remotes/origin/*` reads a merged-and-pruned branch as `unpushed`: the pass's commits
///     live in `origin/<base>` upstream, but the last local view predates the merge, so no local
///     origin ref contains them and park refuses to touch a worktree that has nothing left to lose.
///   * A decline is exactly when `origin/<base>` matters MOST. Declining leaves the pass to cut its
///     own branch off `origin/<base>`, so fetching only on the success path handed the stalest base
///     to the one run that had to rely on it. Worse, it was self-reinforcing — the decline suppressed
///     the fetch that would have cleared the decline, so a single interrupted pass could keep the
///     worktree drifting for as long as nothing else in the repo happened to fetch.
///
/// `dirty_policy` widens ONLY the dirt rule, and only for a caller that asks. Under
/// [`DirtyPolicy::Stash`] real dirt is set aside into a per-agent stash instead of declining the
/// park — see the branch below for why stashing is the only one of the three obvious moves that is
/// acceptable. Every OTHER valve above is unaffected: `unpushed` in particular still declines under
/// both policies, because a stash cannot save a commit.
pub fn park_worktree_on_base_at(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_branch: &str,
    app_data: &Path,
    dirty_policy: DirtyPolicy,
) -> Result<ParkOutcome, String> {
    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt_str = wt.to_string_lossy().to_string();
    if !wt.exists() || git(&wt_str, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        // Nothing to park — the caller creates it fresh from the base anyway.
        return Ok(ParkOutcome::declined("no-worktree"));
    }

    // Freshen the base BEFORE anything reads an origin ref. Best-effort and time-bounded
    // (git_networked): offline must degrade to "park on the last-known base", never to an error
    // that blocks the run. Two things depend on this happening first — see the doc comment:
    // the containment proof below, and the freshness of `origin/<base>` on every decline path.
    let logical = if base_branch.trim().is_empty() || validate_ref(base_branch.trim()).is_err() {
        resolve_default_branch(root)
    } else {
        base_branch.trim().to_string()
    };
    let _ = git_networked(root, &["fetch", "--quiet", "--no-tags", "origin", &logical]);

    // Never disturb work in progress. `--porcelain` covers untracked, staged, modified AND the
    // unmerged entries a halted rebase/merge leaves behind, so a mid-operation tree lands here too.
    //
    // The one exception is dirt the AGENT'S OWN TOOLING writes: see `tooling_churn_to_restore` for
    // why a bare emptiness check made this decline PERMANENTLY on the recurring headless worktree.
    // Seed the scratch-worktree excludes HERE, immediately before the status read they exist to
    // change (roborev 55374). Wiring this only into project-open provisioning was the wrong place:
    // `park_worktree_on_base` runs exclusively against the app-owned Sparkle clone
    // (`improvementPass.ts` → `ensureSparkleRepo`), which `ensure_sparkle_repo_at` builds with a bare
    // `git clone` and never routes through `ensure_project_repo_inner`. So the seeding landed on user
    // projects — where the park never runs — and never on the one repo that wedges. Calling it at the
    // decision point makes that class of gap impossible: whatever repo the park is about to judge is
    // the repo that just got seeded.
    //
    // Cheap and idempotent (one small read, and a write only when a pattern is genuinely absent), and
    // best-effort by construction — its Ok(()) return means a failure here can never convert a
    // parkable worktree into an error.
    let _ = ensure_worktree_excludes(&wt_str);
    let porcelain = git(&wt_str, &["status", "--porcelain"])?;
    // How much was set aside, for the log. A COUNT, never the paths — see `describe_blocking_dirt`.
    let dirt_entries = porcelain.lines().filter(|l| !l.trim().is_empty()).count();
    // `None` from the churn whitelist means REAL dirt. Whether that ends the park is the one thing
    // `dirty_policy` decides; `stash_all` carries the answer down to the single stash step below so
    // that nothing between here and there has to re-derive it.
    let mut stash_all = false;
    let churn = match tooling_churn_to_restore(&porcelain) {
        Some(paths) => paths,
        None if dirty_policy == DirtyPolicy::Stash => {
            // The whitelist exists because a RESTORE cannot faithfully undo an arbitrary change. A
            // stash can, which is what makes widening this safe where widening the whitelist would
            // not be — and why the three moves are not interchangeable:
            //   * COMMIT would put unreviewed leftovers into branch history that can later be
            //     pushed, laundering something nobody read into the repo.
            //   * RESET/checkout-over would destroy work outright; this module's entire design is
            //     that it declines rather than destroys.
            //   * STASH (with `-u`, so untracked residue comes too) loses nothing — every line
            //     stays recoverable by hand — and it is the mechanism this function already trusts
            //     for churn. Same argument, wider input.
            // Logged as a COUNT, never paths: see `describe_blocking_dirt` for why status codes are
            // the most any of this may say about a worktree that can be cut from a user's own repo.
            tracing::info!(
                agent_id = %agent_id,
                blocking = %describe_blocking_dirt(&porcelain),
                "park: setting leftover worktree dirt aside into a stash so the next run starts clean"
            );
            stash_all = true;
            Vec::new()
        }
        None => {
            // The decline itself is routine; being unable to say WHY is what made the recurring
            // stale-base episodes unfixable. `describe_blocking_dirt` reports status codes only —
            // see its doc comment for why that is both sufficient and the most this may say.
            tracing::warn!(
                agent_id = %agent_id,
                blocking = %describe_blocking_dirt(&porcelain),
                "park declined: the worktree has uncommitted changes, so the next run starts from \
                 whatever branch the last one left behind"
            );
            return Ok(ParkOutcome::declined("dirty"));
        }
    };

    // Containment check: refuse if ANY commit this park would put beyond reach is missing from every
    // origin ref. `--not --remotes=origin` is the whole safety story — a run that committed and
    // failed to push is indistinguishable from a run that pushed, except right here.
    let branch = format!("sparkle/agent-{agent_id}");
    let branch_ref = format!("refs/heads/{branch}");
    let head_branch =
        git(&wt_str, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default().trim().to_string();
    // `--abbrev-ref` prints the literal string `HEAD` when detached; an empty result means the probe
    // itself failed, which must not read as "on a branch".
    let head_branch_name = match head_branch.as_str() {
        "" | "HEAD" => None,
        b => Some(b),
    };
    let mut tips: Vec<&str> = Vec::new();
    if head_is_at_risk(head_branch_name, &branch) {
        tips.push("HEAD");
    }
    if git(root, &["rev-parse", "--verify", "--quiet", &branch_ref]).is_ok() {
        tips.push(branch_ref.as_str());
    }
    // Counted here (the tree is still on the departing branch) but REPORTED only after the park
    // actually happens — see the emit site at the end of this function.
    let stepped_over: u32 = match head_branch_name.filter(|_| !head_is_at_risk(head_branch_name, &branch)) {
        Some(_) => git(&wt_str, &["rev-list", "--count", "HEAD", "--not", "--remotes=origin"])
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0),
        None => 0,
    };

    // Nothing this park touches can strand a commit, so there is nothing to prove — and no rev-list
    // to run, which matters because rev-list with no positive tip is an error, not a zero.
    if !tips.is_empty() {
        let mut rev_list: Vec<&str> = vec!["rev-list", "--count"];
        rev_list.extend_from_slice(&tips);
        rev_list.extend_from_slice(&["--not", "--remotes=origin"]);
        // A failure here (no origin, unborn HEAD) must read as "can't prove it's safe" → decline.
        let unpushed: u32 = match git(&wt_str, &rev_list).ok().and_then(|s| s.trim().parse().ok()) {
            Some(n) => n,
            None => return Ok(ParkOutcome::declined("unpushed")),
        };
        if unpushed > 0 {
            return Ok(ParkOutcome::declined("unpushed"));
        }
    }

    let base = effective_base(root, &logical, false);
    let base_rev = format!("{base}^{{commit}}");
    let base_sha = match git(root, &["rev-parse", "--verify", "--quiet", &base_rev]) {
        Ok(sha) => sha.trim().to_string(),
        Err(_) => return Ok(ParkOutcome::declined("no-base")),
    };

    // Already sitting on the fresh base with the right branch checked out → nothing to do. Checking
    // the branch too (not just the SHA) keeps the outcome honest when a topic branch happens to
    // point at the base commit.
    //
    // `!stash_all` is what keeps this a pure short-circuit under the default policy: an already-fresh
    // tree returns having had NOTHING done to it, exactly as it did before `dirty_policy` existed
    // (session-tooling churn included — it survives an already-fresh park today and still does).
    //
    // A Stash-policy caller falls through instead, because "already on the base" and "clean" are
    // different facts and only the second one is what the next pass needs. A pass that edited files
    // and died before committing leaves the worktree on the agent branch at the base commit with the
    // edits still in the tree — already-fresh by SHA, and carrying the very leftovers this policy
    // exists to clear. Returning here would hand the next pass a tree it cannot trust while telling
    // it everything was fine. The stash below runs, then the park reports `already-fresh` honestly.
    let head_sha = git(&wt_str, &["rev-parse", "HEAD"]).unwrap_or_default().trim().to_string();
    let already_fresh = head_sha == base_sha && head_branch == branch;
    if already_fresh && !stash_all {
        return Ok(ParkOutcome::declined("already-fresh"));
    }

    // Whether the park that is about to happen set anything aside — read by the success return at
    // the very end, outside the lock's scope.
    let parked_stashed;
    // `checkout -B` creates-or-resets the agent's own branch at the base and checks it out in one
    // step. Under the per-repo lock so a background pool warm can't collide on index.lock.
    {
        let gl = repo_git_lock(root);
        let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());
        // Clear the tooling churn FIRST, inside the lock and immediately before the checkout, so the
        // tree the checkout sees is the clean one every other branch above already required.
        //
        // STASHED, NOT DISCARDED, and the difference is the whole argument for doing this at all.
        // `checkout HEAD --` would be simpler and was the first cut — but these lines are not noise:
        // the log carries work-tracker state (an issue closing, with the reason someone wrote for
        // closing it), and it has a real commit history, so its lines are meant to land. Being
        // *routinely regenerated* is what makes the churn safe to move out of the way; it is not
        // what would make it safe to delete. A stash keeps every line recoverable by hand.
        //
        // It also makes the failure path honest. `checkout -B` can still fail, and returning
        // `checkout-failed` after having destroyed content would be a decline that first deleted
        // something — strictly worse than the pre-change decline, which never touched the tree.
        // With a stash, that path loses nothing either.
        //
        // Best-effort for CHURN: if the stash fails the tree stays dirty and `checkout -B` reports
        // `checkout-failed`, which is the conservative outcome. The leftover-dirt branch below is
        // stricter — see its own comment.
        let mut stashed = false;
        if stash_all {
            // `-u` so untracked residue comes too. The whole tree is the pathspec, deliberately:
            // the point is that the next pass starts from a tree it can trust, and a partial stash
            // would leave exactly the entries the whitelist could not classify.
            //
            // NOT `-a`/`--all`: ignored files stay put. Sweeping those in would mean stashing
            // `target/`, `node_modules/` and every build artifact — enormous, and destructive to the
            // next pass's own incremental state rather than protective of anything.
            //
            // FAIL CLOSED. A failed push means the leftovers are NOT saved anywhere, and the very
            // next statement would `checkout -B` over them. Falling through to let the checkout
            // "probably fail too" is not a safety property — git carries a modified file across a
            // checkout whenever the file is identical in both commits, so the fall-through can
            // silently succeed and take the unsaved dirt with it. Decline `dirty` instead, which is
            // precisely the pre-change outcome: nothing saved, so nothing touched.
            match push_park_stash(
                &wt_str,
                agent_id,
                PARK_DIRT_STASH_MARKER,
                &["-u"],
                &[],
                PARK_DIRT_STASH_KEEP,
            ) {
                Ok(()) => {
                    stashed = true;
                    tracing::info!(
                        %agent_id,
                        entries = dirt_entries,
                        "park stashed leftover worktree dirt"
                    );
                }
                Err(_) => {
                    // The error TEXT is dropped on purpose. git names the path it could not write
                    // (`…/index.lock`) or the pathspec it refused, and this runs for worktrees that
                    // can be cut from a user's own repository — the same rule `describe_blocking_dirt`
                    // follows. The churn branch below can afford `error = %e` because its pathspec is
                    // a fixed whitelist; a whole-tree stash has no such bound.
                    tracing::warn!(
                        %agent_id,
                        entries = dirt_entries,
                        "park declined: could not stash the leftover worktree dirt, so the tree was \
                         left exactly as it was found"
                    );
                    return Ok(ParkOutcome::declined("dirty"));
                }
            }
        } else if !churn.is_empty() {
            match push_park_stash(
                &wt_str,
                agent_id,
                PARK_CHURN_STASH_MARKER,
                &[],
                &churn,
                PARK_CHURN_STASH_KEEP,
            ) {
                Ok(()) => {
                    stashed = true;
                    tracing::info!(paths = churn.len(), "park stashed session-tooling churn");
                }
                Err(e) => tracing::warn!(
                    paths = churn.len(),
                    error = %e,
                    "park could not stash session-tooling churn"
                ),
            }
        }
        // Reached only under `stash_all` (the check above returns otherwise): the tree needed
        // clearing but the branch and base were already right, so there is no checkout to do. Report
        // the same token the short-circuit does — `parked` stays false because nothing moved — with
        // `stashed` telling the caller the tree is now clean.
        if already_fresh {
            return Ok(ParkOutcome { parked: false, reason: "already-fresh".into(), stashed });
        }
        if git(&wt_str, &["checkout", "-B", &branch, &base_sha]).is_err() {
            // Carries `stashed`: a decline that already moved something must say so, or a caller
            // reading `stashed: false` would go looking for leftovers that are now in the stash.
            return Ok(ParkOutcome { parked: false, reason: "checkout-failed".into(), stashed });
        }
        parked_stashed = stashed;
    }
    // SAY WHAT WE STEPPED OVER — and only now, because only now is it true. Every path above can
    // still decline (`unpushed` on the agent branch, `no-base`, `checkout-failed`), and a diagnostic
    // that announces a park which then did not happen is worse than none.
    //
    // COUNT ONLY, NEVER THE BRANCH NAME. This runs for every agent worktree, including ones cut from
    // a user's own repository, where a branch name is their content — the same rule
    // `describe_blocking_dirt` follows for filenames and `park_worktree_on_base` follows for its
    // reason token. The count is what makes the situation legible ("something was left behind, go
    // look"); `git branch --no-merged` in that clone is what names it, and that is the caller's to
    // run, not ours to log.
    if stepped_over > 0 {
        // `agent_id` and nothing more: park runs hourly for every app-owned worktree into one log
        // stream, so a bare count says something was left behind without saying WHERE — and the
        // follow-up this delegates to (`git branch --no-merged`) has to be run in a specific clone.
        // It is a Sparkle-generated id, already carried by the sibling `park_worktree_on_base` line,
        // so it identifies the worktree without naming any of its content.
        tracing::warn!(
            %agent_id,
            commits = stepped_over,
            "park: stepped over unpushed commits still held by the branch we left; \
             they remain reachable by that branch, but nothing else records them"
        );
    }
    Ok(ParkOutcome { parked: true, reason: "parked".into(), stashed: parked_stashed })
}

/// Park an app-owned, unattended agent worktree back on a fresh integration base before its next
/// headless run. Declines (never destroys) when the tree holds unpushed commits, and — unless the
/// caller passes `dirtyPolicy: "stash"` — when it is dirty.
///
/// `dirty_policy` is `Option` so that OMITTING it is a valid call that means [`DirtyPolicy::Decline`].
/// The safe reading has to be the one you get by not thinking about it: a future caller pointing this
/// at a user's own project worktree must inherit decline-don't-touch without having to know the
/// parameter exists.
#[tauri::command]
pub async fn park_worktree_on_base(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
    dirty_policy: Option<DirtyPolicy>,
) -> Result<ParkOutcome, String> {
    let app_data = app_data_dir(&app)?;
    let policy = dirty_policy.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let out =
            park_worktree_on_base_at(&root, &project_id, &agent_id, &base_branch, &app_data, policy);
        // Log the machine token only — never the path, branch, or any user content.
        if let Ok(o) = &out {
            tracing::info!(
                %agent_id,
                parked = o.parked,
                reason = %o.reason,
                stashed = o.stashed,
                "park_worktree_on_base"
            );
        }
        out
    })
    .await
    .map_err(|e| format!("park_worktree_on_base task failed: {e}"))?
}

/// How many porcelain paths a BRANCH STATUS carries. Deliberately far smaller than
/// [`crate::promotion::DIRTY_FILES_CAP`] (50), because the two have opposite cost profiles: the
/// promotion preflight is a ONE-SHOT read of a SINGLE agent, while this rides the 30s batch poll for
/// EVERY agent — a 50-path cap across a 50-agent fleet is 2,500 strings crossing the IPC boundary
/// every tick to fill a row that has room for about three. The row says "and N more" from
/// `dirty_count`, which is always the TRUE total, so nothing is hidden by the smaller budget.
pub(crate) const STATUS_DIRTY_FILES_CAP: usize = 5;

/// Parse `git status --porcelain` into (capped paths, TRUE total).
///
/// ONE IMPLEMENTATION, TWO CALLERS. This is the parser `promotion::promotion_preflight` uses and the
/// one `agent_branch_status` uses; `cap` is the only thing that differs (see
/// [`STATUS_DIRTY_FILES_CAP`]). A second copy would drift on exactly the two edge cases below, both
/// of which are already-fixed bugs rather than hypotheticals.
///
/// Parsed tolerantly rather than by slicing a fixed 3-char offset, because [`git`] trims the whole
/// capture: the very first porcelain line loses the leading space of a ` M path` status column, so a
/// fixed offset would return `path` for every line but the first and `ath` for that one.
///
/// `git status --porcelain` honours `.gitignore` with no extra flag — ignored files are simply not
/// listed — which is the founder's "respect .gitignore" requirement satisfied by the command itself
/// rather than by a filter here that could fall out of step with the repo's ignore rules.
pub(crate) fn parse_porcelain_capped(out: &str, cap: usize) -> (Vec<String>, u32) {
    let mut paths: Vec<String> = Vec::new();
    let mut count: u32 = 0;
    for raw in out.lines() {
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        count = count.saturating_add(1);
        if paths.len() >= cap {
            continue; // keep counting: `count` is the truth, `paths` is the preview
        }
        let rest = line.trim_start();
        let path = match rest.split_once(' ') {
            Some((_, p)) => p.trim_start(),
            None => rest,
        };
        // Rename/copy entries read `R  old -> new`; the file that exists on disk is the NEW one.
        let path = path.rsplit(" -> ").next().unwrap_or(path);
        paths.push(path.to_string());
    }
    (paths, count)
}

/// A worktree's uncommitted-changes reading: the boolean every existing consumer wants, plus the
/// NAMES that let a row say what it is holding.
///
/// WHY THE NAMES EXIST (sparkle-biezi). "Local: Uncommitted" told the founder an agent was holding
/// unsaved work and named no file, so they could not tell a forgotten fix from a leftover build
/// artifact without opening a terminal — which is the work this app exists to remove. A row that
/// claims uncommitted work must be able to say WHICH.
///
/// IT COSTS NO EXTRA GIT CALL. Both status paths already ran `git status --porcelain` and threw the
/// output away on `.is_empty()`; this keeps what was already in hand. That matters because the batch
/// poll's per-agent cost is load-bearing (sparkle-zlic) — adding a second git invocation per agent
/// per tick to answer this would not have been worth it.
#[derive(Default, Clone)]
pub(crate) struct DirtyReading {
    pub dirty: bool,
    pub files: Vec<String>,
    pub count: u32,
}

impl DirtyReading {
    /// Read a worktree's dirt. `exists: false` (no worktree on disk) is CLEAN-and-empty, matching the
    /// long-standing behaviour of both call sites — there is no tree to hold anything.
    ///
    /// `no_optional_locks` mirrors the batch path's flag. ⚠️ It is a TOP-LEVEL git option and must
    /// precede the subcommand; misplaced, git exits 129 with "unknown option" (the bug fleet.rs
    /// records at its own porcelain call). Passing it as a separate arg here keeps that ordering in
    /// one place instead of at every call site.
    fn read(wt_str: &str, exists: bool, no_optional_locks: bool) -> Result<Self, String> {
        if !exists {
            return Ok(Self::default());
        }
        let args: &[&str] = if no_optional_locks {
            &["--no-optional-locks", "status", "--porcelain"]
        } else {
            &["status", "--porcelain"]
        };
        let out = git(wt_str, args)?;
        let (files, count) = parse_porcelain_capped(&out, STATUS_DIRTY_FILES_CAP);
        Ok(Self { dirty: count > 0, files, count })
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    ahead: u32,
    behind: u32,
    /// Uncommitted changes in the agent's worktree. ONLY meaningful when `worktree_on_branch`
    /// is true — see that field. Every OTHER field on this struct is derived from the branch
    /// REF and is therefore immune to whatever the worktree happens to be checked out to.
    dirty: bool,
    files_changed: u32,
    insertions: u32,
    deletions: u32,
    /// Does the worktree actually have `sparkle/agent-<id>` checked out? Normally yes. It goes
    /// false when something moved the worktree off its own branch — the old `land.sh` checked
    /// `main` out into agent worktrees (sparkle-rhgm), and a manual checkout does it too.
    ///
    /// When false, `dirty` is reported as false, and that false means "NOT KNOWN", not "clean":
    /// the tree sitting there belongs to some other branch, so its dirt is not this branch's
    /// dirt and must not be asserted as such. Consumers must not apply the unsaved-edits stage
    /// floor on a false reading. Same unknown-vs-false shape as `hasRemote` in WorkflowState.
    worktree_on_branch: bool,
    /// WHICH files are uncommitted — porcelain paths, capped at [`STATUS_DIRTY_FILES_CAP`], already
    /// `.gitignore`-filtered by git itself. Empty whenever `dirty` is false.
    ///
    /// Carries the SAME caveat as `dirty`: only meaningful when `worktree_on_branch` is true, since a
    /// parked tree's files belong to whatever branch got checked out into it. Consumers must apply
    /// the same gate to both — reading the names while ignoring the gate would attribute another
    /// branch's files to this agent BY NAME, which is a worse version of that mistake, not a lesser
    /// one.
    dirty_files: Vec<String>,
    /// The TRUE number of uncommitted paths, which may exceed `dirty_files.len()`. A "+N more"
    /// affordance must count from THIS; `dirty_files` is a preview, not an inventory.
    dirty_count: u32,
}

/// Status for an agent branch whose base ref can't be resolved: there's no base to diverge from,
/// so count the branch's OWN commits as `ahead` (behind 0) and skip the base diff. `dirty` is passed
/// through from the caller's worktree read. Shared by both the single-agent and batched status paths
/// so their unresolvable-base guards can't drift apart.
fn ahead_only_status(root: &str, branch: &str, d: &DirtyReading, worktree_on_branch: bool) -> BranchStatus {
    let ahead = git(root, &["rev-list", "--count", branch])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    BranchStatus { ahead, behind: 0, dirty: d.dirty, files_changed: 0, insertions: 0, deletions: 0, worktree_on_branch, dirty_files: d.files.clone(), dirty_count: d.count }
}

/// The branch an agent's worktree is actually checked out on, or "" when the tree is missing, the
/// read fails, or the head is DETACHED (git reports the literal "HEAD" for that, which names no
/// branch). `--abbrev-ref` doesn't touch the index, so this can't defeat the batch poll's
/// index-mtime fingerprint skip.
fn worktree_head_branch(wt_str: &str, exists: bool) -> String {
    if !exists {
        return String::new();
    }
    match git(wt_str, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(h) if h.trim() != "HEAD" => h.trim().to_string(),
        _ => String::new(),
    }
}

/// Does `refs/heads/<branch>` exist in this repo?
fn local_branch_exists(root: &str, branch: &str) -> bool {
    !branch.trim().is_empty()
        && git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

/// The branch a status/workflow probe must REPORT ON for an agent, plus whether the agent's
/// worktree is actually sitting on it.
///
/// WHY THIS IS NOT JUST `format!("sparkle/agent-{id}")` (the ladder's false "Unsaved" rung).
/// Every read path used to mint the branch name from the agent id and stop there. An agent that
/// RENAMES its working branch — which AGENTS.md now actively encourages, because a descriptive
/// name resolves better and `pr_owner` no longer needs the id — leaves no `sparkle/agent-<id>` ref
/// behind. `rev-parse` then misses, the probe returns the zeroed "no branch yet" status
/// (`ahead: 0`), and `gitDerivedStage` reads `ahead == 0` as `building_unsaved`. So a worktree with
/// a SPOTLESS tree and ten committed-but-unpushed commits filed itself under "Local: Uncommitted"
/// with an 'Unsaved' badge — telling the user their work is one close away from being lost when it
/// was safely committed the whole time. It also dropped such a parent BELOW its own workers on the
/// ladder, since the workers' own branches still resolved.
///
/// The resolution order below is deliberately conservative — it changes the answer ONLY in the case
/// that was previously unanswerable, and leaves the parked-worktree contract (sparkle-rhgm) exactly
/// as it was:
///   1. The tree is on the minted branch — the overwhelmingly common case. Unchanged.
///   2. The minted ref EXISTS but the tree is elsewhere — the PARKED case. Keep reporting the
///      minted branch with `worktree_on_branch: false`, so `dirty` stays attributable to whatever
///      got checked out and every consumer's existing filtering still applies.
///   3. The minted ref is GONE and the tree is on some other branch — the RENAME. Report on the
///      branch the work is actually on. `worktree_on_branch` is true because it genuinely is.
///   4. Anything else (fresh agent, no worktree, detached HEAD, parked on the base branch with its
///      own ref already deleted) — fall back to the minted name and let the existing
///      "branch doesn't exist" guards return the zeroed status, as before.
///
/// `base` is the integration base (`main`, `origin/main`, `develop`, …); an `origin/` prefix is
/// stripped before comparing. Case 4's base check is what stops a tree parked on `main` from
/// reporting `main`'s ahead/behind as the agent's own work.
/// `head` is the worktree's current HEAD branch (`worktree_head_branch`), passed IN rather than
/// re-read: every caller already has it, and re-reading would spawn a second `git rev-parse` per
/// agent per poll — undoing half of the sparkle-zlic batch saving.
/// `pub(crate)` so `promotion.rs` resolves a promoted agent's branch through THIS ladder rather
/// than minting `sparkle/agent-<id>` at its own call site — a copy would drift, and the renamed
/// case (rung 3) is exactly the one a promotion must not get wrong: it pushes and clones the ref.
pub(crate) fn resolve_agent_branch(root: &str, head: &str, agent_id: &str, base: &str) -> (String, bool) {
    let minted = format!("sparkle/agent-{agent_id}");
    if head == minted {
        return (minted, true);
    }
    if local_branch_exists(root, &minted) {
        return (minted, false);
    }
    let base_name = base.strip_prefix("origin/").unwrap_or(base);
    // Never adopt ANOTHER agent's minted branch: a worktree parked on `sparkle/agent-<other>` would
    // otherwise report that agent's commits as this one's. Unknown beats wrong-but-confident.
    let is_other_agents = head.starts_with("sparkle/agent-") && head != minted;
    if !head.is_empty() && head != base_name && !is_other_agents {
        return (head.to_string(), true);
    }
    (minted, false)
}

/// Resolve the PARENT (orchestrator) branch a worker integrates into.
///
/// The frontend mints this as `sparkle/agent-<parentId>`, so it has exactly the same blind spot the
/// agent's own branch had — and a worse consequence. `workflow_state_shared` computes
/// `in_parent = ref_contains(root, parent_branch, tip)`, and `ref_contains` on a ref that does not
/// exist is `false`. So the moment an ORCHESTRATOR renames its branch, every one of its workers
/// reports `inParent: false`, `agent_landed_check` loses its `where: "parent-branch"` verdict, and a
/// worker whose work demonstrably merged into its parent is told it has not landed. A confidently
/// wrong "not landed" is worse than an unknown, and renaming is the behaviour this change is
/// enabling.
///
/// Self-contained in Rust (no frontend change): if the passed ref resolves, use it. Otherwise, if it
/// carries the minted shape, recover the parent's agent id and resolve THAT agent's worktree the
/// same way `resolve_agent_branch` does. Falls back to the name as given, so a parent whose worktree
/// is gone behaves exactly as it does today.
fn resolve_parent_branch(
    root: &str,
    app_data: &Path,
    project_id: &str,
    parent_branch: &str,
    base: &str,
) -> String {
    if parent_branch.trim().is_empty() || local_branch_exists(root, parent_branch) {
        return parent_branch.to_string();
    }
    let Some(parent_id) = parent_branch.strip_prefix("sparkle/agent-") else {
        return parent_branch.to_string();
    };
    let Ok(wt) = worktree_path(app_data, project_id, parent_id) else {
        return parent_branch.to_string();
    };
    let head = worktree_head_branch(&wt.to_string_lossy(), wt.exists());
    resolve_agent_branch(root, &head, parent_id, base).0
}

/// RECORD which branch an agent is working on, whatever it is called.
///
/// This is what resolves a PR back to its agent when the branch name embeds no id — the case
/// branch-name parsing could never answer (`sparkle/left-pair` → #806) — and the only signal that
/// covers a PR an agent opened by running `gh pr create` in its own shell instead of through
/// `open_agent_pr`. It is deliberately called from the status probes, because those are the only
/// places that see a branch an agent chose for ITSELF, after the fact.
///
/// Cheap by construction: `pr_owner::record_branch` writes only when the mapping actually changes,
/// so a steady-state poll re-reads a small file and writes nothing. Best-effort — a failure costs a
/// resolvable owner, never a status reading.
fn observe_worktree_branch(app_data: &Path, project_id: &str, agent_id: &str, head_branch: &str) {
    if head_branch.is_empty() {
        return;
    }
    if let Err(e) = crate::pr_owner::observe_branch(app_data, project_id, head_branch, agent_id) {
        tracing::warn!(
            %head_branch, %agent_id, error = %e,
            "could not record branch → agent ownership (non-fatal)"
        );
    }
}

/// Core (AppHandle-free, testable): live ahead/behind + dirty + size of an agent branch vs its
/// (no-fetch) effective base. The worktree lives OUTSIDE the project, under `app_data`.
pub fn agent_branch_status_at(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Result<BranchStatus, String> {
    let base = effective_base(root, base_branch, false); // status never hits the network
    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt_str = wt.to_string_lossy().to_string();

    // Is the worktree actually on the branch we're reporting about? Something may have moved it
    // (the old land.sh checked `main` out into agent worktrees — sparkle-rhgm; a manual checkout
    // does it too). If it has, the tree there belongs to a DIFFERENT branch, so its dirt is not
    // this branch's dirt. A missing tree is not a mismatch — that case is handled below and has
    // its own long-standing meaning.
    // Resolve the branch we report on from the tree, not from the id alone — a renamed branch has
    // no `sparkle/agent-<id>` ref and used to read as a zeroed (⇒ "Unsaved") status. See
    // `resolve_agent_branch` for the full ordering and why the parked case is unaffected.
    let head_branch = worktree_head_branch(&wt_str, wt.exists());
    let (branch, worktree_on_branch) =
        resolve_agent_branch(root, &head_branch, agent_id, &base);
    observe_worktree_branch(app_data, project_id, agent_id, &head_branch);

    // Dirtiness needs the actual worktree. When it's GONE (a landed/cleaned-up agent whose tab
    // stays open and keeps getting polled), a removed tree has no uncommitted changes — report
    // dirty=false instead of erroring, so the 30s poll doesn't re-fail every tick forever and
    // bury real errors in the log. When the tree EXISTS, still propagate a failed read rather than
    // masking it as a misleading "clean" false-negative on the common UI-status path.
    //
    // `dirty` stays the RAW worktree reading even when the worktree is parked — deliberately.
    // Two consumers need opposite things from it and only the caller knows which:
    //   - stage/bead attribution must NOT count another branch's dirt as this branch's work
    //   - close-safety must NOT tear down a tree that may still hold uncommitted files; parking
    //     CARRIES uncommitted changes along, so they are still there and still the user's
    // Zeroing it here would silently serve the first at the cost of the second, and the second
    // loses data (see shouldPromptOnClose, which already errs toward prompting on unknown).
    // So: report what is there, publish `worktree_on_branch`, and let each consumer decide.
    let d = DirtyReading::read(&wt_str, wt.exists(), false)?;

    // A brand-new or non-git agent (chat/think/shell, or one polled before its first commit) has no
    // `sparkle/agent-<id>` ref yet. `rev-list <base>...<missing>` then hard-fails with
    // "fatal: ambiguous argument ... unknown revision" — an error the removed-worktree latch
    // (isWorktreeGoneError in runtimeStore.ts) does NOT match, so the 30s poll would re-fail every
    // tick for the app's lifetime, spam the log, and never resolve. There's no divergence to count
    // against a ref that doesn't exist: return a zeroed status (mirrors the born-fresh model), still
    // reflecting the worktree's dirty state.
    if git(
        root,
        &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")],
    )
    .is_err()
    {
        return Ok(BranchStatus { ahead: 0, behind: 0, dirty: d.dirty, files_changed: 0, insertions: 0, deletions: 0, worktree_on_branch, dirty_files: d.files.clone(), dirty_count: d.count });
    }

    // The agent branch exists, but its RESOLVED base may not: `effective_base` documents an
    // unborn/HEAD-less fallback that can hand back a name git cannot resolve. `rev-list
    // <unresolvable-base>...<branch>` then hard-fails with "fatal: ambiguous argument", failing the
    // whole status read on EVERY 30s poll for the app's lifetime — spamming the log and never
    // resolving. There's no divergence to measure against a base that doesn't exist, so report the
    // branch's own commits as `ahead` (behind 0 — the born-off-nothing model), still reflecting the
    // worktree's dirty state, instead of erroring.
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).is_err() {
        return Ok(ahead_only_status(root, &branch, &d, worktree_on_branch));
    }

    // `--left-right --count A...B` emits "<left>\t<right>": left = base-only = behind,
    // right = branch-only = ahead.
    let counts = git(root, &["rev-list", "--left-right", "--count", &format!("{base}...{branch}")])?;
    let mut it = counts.split_whitespace();
    let behind: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);

    // numstat: sum insertions/deletions, count file lines.
    let numstat = git(root, &["diff", "--numstat", &format!("{base}...{branch}")]).unwrap_or_default();
    let (mut files_changed, mut insertions, mut deletions) = (0u32, 0u32, 0u32);
    for line in numstat.lines().filter(|l| !l.trim().is_empty()) {
        files_changed += 1;
        let mut cols = line.split_whitespace();
        insertions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0); // "-" for binary -> 0
        deletions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    }

    Ok(BranchStatus { ahead, behind, dirty: d.dirty, files_changed, insertions, deletions, worktree_on_branch, dirty_files: d.files, dirty_count: d.count })
}

/// Live ahead/behind + dirty + size of an agent branch vs its (no-fetch) effective base.
/// `async` + `spawn_blocking` (mirroring `create_agent_worktree`) so the several synchronous `git`
/// subprocesses this runs per sidebar/status poll never stall the UI thread.
#[tauri::command]
pub async fn agent_branch_status(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
) -> Result<BranchStatus, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        agent_branch_status_at(&root, &project_id, &agent_id, &base_branch, &app_data)
    })
    .await
    .map_err(|e| format!("agent_branch_status task failed: {e}"))?
}

/// Where an agent's work sits in the land-to-green workflow, beyond what ahead/behind can show.
/// All reachability is "does ref X already contain the agent branch tip" — i.e. the work has
/// landed there. Computed entirely from LOCAL refs (no fetch), so it's fast and offline-safe;
/// `in_origin_main` reflects the last-fetched `origin/<default>`. The optional GitHub PR probe is
/// the only network touch and is strictly best-effort (absent `gh`/remote/PR ⇒ all-None).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    /// Agent branch tip is contained in the LOCAL default branch (e.g. work merged into `main`).
    in_local_main: bool,
    /// …in `origin/<default>` as of the last fetch (landed on the remote integration branch).
    in_origin_main: bool,
    /// …in the parent/orchestrator branch (workers only; false when `parent_branch` is empty or
    /// missing). This is a worker's "On Main": its work merged into its orchestrator's branch.
    in_parent: bool,
    /// Commits the agent authored that aren't yet in the ref it was cut from — `origin/<default>`
    /// when that remote-tracking ref exists, else local `<default>` (>0 ⇒ real unlanded work).
    /// Lets the caller distinguish "did work, now merged" from "never committed anything". Measured
    /// against the cut ref (not strictly local main) so a fresh branch off an ahead-of-local
    /// `origin/<default>` reads 0 rather than counting inherited, un-pulled commits as its own.
    ahead_of_base: u32,
    /// The branch's WORK is already in the integration branch via a SQUASH or REBASE merge — its tip
    /// COMMIT isn't an ancestor (squash makes a new commit, so `in_local_main`/`in_origin_main` are
    /// both false), but merging it into `<default>` would add nothing (see `merge_adds_nothing`,
    /// which survives an advancing `<default>`). Kept a strict superset of reachability (true whenever
    /// those are). The frontend gates this on `committedSeen` so a no-op branch — which also trivially
    /// adds nothing — can't claim it landed.
    landed: bool,
    /// The agent branch has been PUSHED to `origin` — its remote-tracking ref
    /// (`refs/remotes/origin/sparkle/agent-<id>`) exists. git creates/updates that ref on push, so
    /// this is a pure LOCAL lookup: offline-safe, no fetch, reflects a push made from THIS repo (the
    /// common case — an agent pushing its own branch). Drives the "Pushed" stage LIVE even when no PR
    /// exists yet (a PR previously the only path to Pushed). Distinct from `in_origin_main`, which is
    /// about the tip landing on the DEFAULT branch, not the agent branch existing on the remote.
    pushed: bool,
    /// The agent's work is SHIPPED — its branch tip is contained in a published release tag (a
    /// semver-ish tag like `v1.2.3`; `nightly`/`latest` don't count). `git tag --contains <tip>`,
    /// filtered by `delivery::is_semver_tag`. Local + offline. Drives the top "Shipped to Production"
    /// stage LIVE (previously unreachable — nothing ever set it). Gated by `committedSeen` downstream.
    /// EDGE: a squash-landed branch's tip isn't an ancestor of the tagged release, so this reads false
    /// for squashed work (the merge/`landed` signal still lights "Merged"); tip-relative on purpose.
    shipped: bool,
    /// The repo has an `origin` remote. Gated on `probe_pr_state` (same as the PR probe), so a
    /// fast/local poll reports false — the frontend stores this stickily and treats a false from a
    /// non-probing tick as "unknown", never as "no remote". Without this, a remoteless repo can
    /// never reach `in_origin_main` and would strand at "Push to Origin Main" with Close unreachable.
    has_remote: bool,
    /// Best-effort GitHub PR state for this branch via `gh`, if one is found: "open" | "merged" |
    /// "closed". None when gh is absent/unauthed, there's no remote, or no PR matches the branch.
    pr_state: Option<String>,
    pr_number: Option<u64>,
    pr_url: Option<String>,
}

/// True iff `target` exists and already contains `commit` (i.e. `commit` is an ancestor of, or
/// equal to, `target`). A missing/invalid target ref or any git error reads as "not contained".
fn ref_contains(root: &str, target: &str, commit: &str) -> bool {
    if target.trim().is_empty() {
        return false;
    }
    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.arg("-C").arg(root).args(["merge-base", "--is-ancestor", commit, target]);
    // A missing target ref makes git print "fatal: Not a valid object name" to stderr; null the
    // child stdio so that expected, frequent case (e.g. no origin/main) doesn't spam app logs.
    cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    apply_noninteractive(&mut cmd);
    matches!(cmd.status(), Ok(s) if s.success())
}

/// True iff merging `branch` into `target` would change NOTHING — i.e. `target` already contains all
/// of `branch`'s work. Catches a SQUASH/REBASE merge (the tip isn't an ancestor, so `ref_contains`
/// misses it) AND survives an ADVANCING `target` (other commits landing after the squash), because
/// it asks the three-way question "does this branch still contribute anything?" rather than comparing
/// whole tip trees — important here, where many agents land onto one shared `main`. Uses
/// `git merge-tree --write-tree` (git ≥2.38): on a clean merge it prints the merged tree's OID, which
/// we compare to `target`'s own tree. A conflict (non-zero exit) or any git error reads as "not
/// landed" — a branch that conflicts with `target` plainly hasn't landed.
/// KNOWN EDGE: a branch that authored commits and then net-reverted them merges as a no-op too, so it
/// reads as landed; tolerated (a degenerate case) and gated upstream only by committedSeen.
fn merge_adds_nothing(root: &str, target: &str, branch: &str) -> bool {
    if target.trim().is_empty() || branch.trim().is_empty() {
        return false;
    }
    let Ok(merged) = git(root, &["merge-tree", "--write-tree", target, branch]) else {
        return false; // merge conflict (non-zero exit) or git error ⇒ not cleanly landed
    };
    if merged.is_empty() {
        return false;
    }
    match git(root, &["rev-parse", &format!("{target}^{{tree}}")]) {
        Ok(tree) => !tree.is_empty() && tree == merged,
        Err(_) => false,
    }
}

/// Is `branch` effectively landed on the integration branch? The single source of the "landed"
/// rule, used by BOTH the workflow-state signal and the close-agent safe branch delete so they can
/// never disagree. Checks fast-forward ancestry into LOCAL or ORIGIN `<target>`, OR a merge-tree
/// no-op against either (which catches squash/rebase merges — where the work lands on the remote as
/// a NEW commit and the branch tip is not an ancestor — and survives an advancing target). `tip` is
/// the branch's resolved SHA ("" = no tip). Callers wanting the freshest remote state refresh origin
/// first; `||` short-circuits so the merge-tree probes only run for not-already-reachable branches.
fn branch_landed(root: &str, target: &str, branch: &str, tip: &str) -> bool {
    let origin_ref = format!("origin/{target}");
    (!tip.is_empty() && (ref_contains(root, target, tip) || ref_contains(root, &origin_ref, tip)))
        || merge_adds_nothing(root, target, branch)
        || merge_adds_nothing(root, &origin_ref, branch)
}

/// Commits reachable from `branch` but not from `base` — i.e. what `branch` authored on top of it.
/// A missing ref or any git error reads as 0; callers that must not mistake "couldn't count" for
/// "authored nothing" pair this with an ancestry check (see `branch_carries_no_own_work`).
fn commits_beyond(root: &str, base: &str, branch: &str) -> u32 {
    if base.trim().is_empty() || branch.trim().is_empty() {
        return 0;
    }
    git(root, &["rev-list", "--count", &format!("{base}..{branch}")])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// The ref an agent branch was CUT FROM: a worker is cut from its orchestrator's branch, everyone
/// else from the project's integration ref. `None` means "cut point unknown" — a worker whose
/// orchestrator branch no longer resolves (a spun-down parent whose branch was deleted). That case
/// must NOT quietly fall back to `base`: measured against main, the worker's INHERITED orchestrator
/// commits read as its own work, which switches the no-op guard off for precisely the branch it
/// exists to protect. Callers decline to attribute instead (see `branch_carries_no_own_work`).
fn cut_from_ref(root: &str, parent_branch: &str, base: &str) -> Option<String> {
    if parent_branch.trim().is_empty() {
        return Some(base.to_string());
    }
    if rev_parse_tip(root, parent_branch).is_empty() {
        return None;
    }
    Some(parent_branch.to_string())
}

/// Reflog verbs that mean the branch gained work AUTHORED ON IT. git does not translate reflog
/// messages, so matching them is stable across locales. Every OTHER way a ref moves — `branch:
/// Created from`, `checkout:`, `rebase (finish):`, `reset:` — advances it without the agent having
/// written anything, which is why "did the ref ever move" is the wrong question to ask.
/// `revert` earns its place empirically, not by analogy: `git revert --no-edit HEAD` writes
/// `revert: Revert "…"`, NOT `commit: …` (verified on git 2.54), so the `commit` prefix does not
/// cover it. It needs no no-op exclusion the way `merge` does — a revert always creates a commit.
const WORK_REFLOG_VERBS: [&str; 4] = ["commit", "cherry-pick", "am", "revert"];

/// Does one reflog message describe the branch gaining a commit of its own?
///
/// `merge` needs the extra clause. An ORCHESTRATOR integrates its workers with
/// `git merge --no-ff sparkle/agent-<worker>` into its own branch and may never run `git commit`
/// itself — pure coordination is a normal shape here — so its whole reflog can read
/// `merge …: Merge made by the 'ort' strategy.` That merge commit IS a commit authored on this
/// branch. A FAST-FORWARD merge is not: the ref just adopts another branch's history, creating
/// nothing.
///
/// Match "Fast-forward" as a SUBSTRING, not a suffix. git only ends the line there when no `-m` was
/// given; with a message it writes `merge <ref>: Fast-forward (no commit created; -m option
/// ignored)` (verified on git 2.54 for both `merge -m` and `merge --ff-only -m`). A suffix test
/// therefore reads `git merge -m "sync" main` on an EMPTY agent branch as authored work, whose tip
/// is main's HEAD — which is precisely the misattribution this whole guard exists to prevent.
fn reflog_entry_is_work(msg: &str) -> bool {
    if msg.starts_with("merge ") {
        return !msg.contains("Fast-forward");
    }
    WORK_REFLOG_VERBS.iter().any(|v| msg.starts_with(v))
}

/// Has this branch ever recorded a commit of its own? Read from the branch's REFLOG — the only
/// local record that survives the branch's work being absorbed into another ref.
///
/// This is the durable answer to "did this agent ever do anything", and it is durable in the two
/// ways the inferential clauses below are not: a LOCAL `merge --no-ff` (`land_agent_branch_at`,
/// Sparkle's own landing path, and how EVERY worker integrates) leaves the agent's `commit:`
/// entries untouched, and a `fetch --prune` that deletes the remote-tracking ref cannot touch them
/// either.
///
/// `None` = UNKNOWN, never "no": a bare repo, `core.logAllRefUpdates=false`, or a reflog gc'd to
/// nothing all yield an empty log, and the caller falls back to inference rather than reading
/// silence as proof. (A reflog expired down to only later non-work entries would read `Some(false)`;
/// that is bounded by `gc.reflogExpire` — 90 days for reachable entries — and fails in the
/// one-directional way described below.)
fn branch_ever_committed(root: &str, branch: &str) -> Option<bool> {
    if branch.trim().is_empty() {
        return None;
    }
    let log = git(root, &["reflog", "show", "--format=%gs", &format!("refs/heads/{branch}")]).ok()?;
    let mut lines = log.lines().map(str::trim).filter(|l| !l.is_empty()).peekable();
    lines.peek()?; // no reflog at all ⇒ unknown, not "never committed"
    Some(lines.any(reflog_entry_is_work))
}

/// Pure: does this branch carry NONE of its own work — is its tip simply the commit it was cut from?
///
/// `ever_committed` — read from the branch's reflog — DECIDES IT WHENEVER IT IS KNOWN, in both
/// directions. The reflog is a complete record of every movement of this ref, so if none of those
/// movements authored anything, nothing did; and if one of them did, that survives the work being
/// absorbed elsewhere, which is what rescues a branch landed by a local `merge --no-ff` (whose
/// arithmetic is identical to a brand-new branch's).
///
/// `cut_relative` — `(commits beyond the cut ref, is the tip still inside it)` — is ONLY the
/// fallback for a repo that keeps no reflog. It is not a second opinion, because it is wrong in the
/// dangerous direction: rewrite the cut ref (an upstream force-push or rebase of `main`, then a
/// fetch) and a work-free branch reads `(authored > 0, tip outside)` — the has-work shape —
/// attributing the stale integration HEAD's PR and release tag to an agent that did nothing. Only
/// the reflog can tell those apart, so a conclusive reflog is never overruled by arithmetic.
/// `None` there means the cut point ITSELF is unknown (a worker whose orchestrator branch was
/// deleted); an unknown cut point can only yield a guess about someone else's history, so we
/// decline to attribute.
///
/// `pushed` is deliberately NOT evidence of work, in either direction: the close-agent Save/Ship
/// path will push a branch that has committed nothing, which would switch the guard off for the
/// exact no-op branch it exists to catch; and `refs/remotes/origin/<branch>` is deletable by an
/// ordinary `fetch --prune`, which would retroactively demote a genuinely merged branch to no-op.
///
/// Erring toward "no own work" is deliberate: it can only WITHHOLD tip-derived rungs, never
/// fabricate them, and the monotonic stage watermark keeps every rung the branch already earned.
/// Showing a seconds-old agent as "Merged to Main" is the failure that actually misleads someone
/// about where their work is.
fn branch_carries_no_own_work(
    ever_committed: Option<bool>,
    cut_relative: Option<(u32, bool)>,
) -> bool {
    match ever_committed {
        Some(ever) => !ever,
        None => match cut_relative {
            Some((authored, tip_in_cut_ref)) => authored == 0 && tip_in_cut_ref,
            None => true,
        },
    }
}

/// True iff the agent branch has been pushed to `origin` — its remote-tracking ref exists locally.
/// git creates/updates `refs/remotes/origin/<branch>` on a successful push, so a pure `rev-parse` of
/// that ref answers "was this branch pushed" offline, with no fetch. Any missing ref / git error
/// reads as not-pushed. This reflects a push done from THIS repo (the normal agent-pushes-its-own-
/// branch flow); a push made elsewhere would only show after a fetch that includes the ref.
fn branch_pushed(root: &str, branch: &str) -> bool {
    if branch.trim().is_empty() {
        return false;
    }
    let remote_ref = format!("refs/remotes/origin/{branch}");
    git(root, &["rev-parse", "--verify", "--quiet", &remote_ref])
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// True iff `tip` is contained in a published RELEASE tag — a semver-ish tag (`v1.2.3` / `1.2`), per
/// `delivery::is_semver_tag`. `git tag --contains <tip>` lists every tag whose history includes the
/// commit; we keep only release-looking ones so a `nightly`/`latest` tag can't read as shipped.
/// Local + offline; an empty tip, no matching tag, or any git error reads as not-shipped. Because it
/// is TIP-relative, a squash-landed branch (whose tip isn't an ancestor of the tagged release) reads
/// false here on purpose — the `landed` signal still carries it to "Merged".
fn tip_in_release(root: &str, tip: &str) -> bool {
    if tip.trim().is_empty() {
        return false;
    }
    match git(root, &["tag", "--contains", tip]) {
        Ok(out) => out.lines().any(crate::delivery::is_semver_tag),
        Err(_) => false,
    }
}

/// Best-effort GitHub PR lookup for `branch` via the `gh` CLI. Returns (state, number, url) where
/// state is lowercased ("open"/"merged"/"closed"). Any failure — gh not installed, not authed, no
/// network, no remote, no matching PR, unparsable output — yields all-None and never errors. Fast
/// path: callers should only invoke this when an `origin` remote exists.
fn probe_pr(root: &str, branch: &str) -> (Option<String>, Option<u64>, Option<String>) {
    let none = (None, None, None);
    if branch.trim().is_empty() {
        return none;
    }
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.arg("pr")
        .args(["list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,url"])
        .current_dir(root)
        // Keep gh non-interactive and quiet; never let it block the poll on a prompt or updater.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    // Network touch → bounded wall-clock; a timeout reads as failure (all-None), like gh being absent.
    let Ok(output) = output_with_timeout(cmd, NETWORK_TIMEOUT) else {
        return none; // gh not installed / failed to spawn / timed out
    };
    if !output.status.success() {
        return none;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(rows) = serde_json::from_str::<Vec<Value>>(&stdout) else {
        return none;
    };
    let Some(pr) = rows.first() else {
        return none; // no PR for this branch
    };
    let state = pr.get("state").and_then(Value::as_str).map(str::to_ascii_lowercase);
    let number = pr.get("number").and_then(Value::as_u64);
    let url = pr.get("url").and_then(Value::as_str).map(str::to_string);
    (state, number, url)
}

/// Pure decoder for a GitHub `commits/<sha>/pulls` response array → (state, number, url). That
/// endpoint reports `state` as only "open"/"closed" plus a separate `merged_at`; we fold
/// `merged_at != null` into the "merged" state the rest of the pipeline expects, and it carries the
/// PR link as `html_url` (not `url`). Takes the first row; empty array ⇒ all-None. Kept pure so the
/// state-folding is unit-testable without spawning `gh`.
fn decode_commit_pulls(rows: &[Value]) -> (Option<String>, Option<u64>, Option<String>) {
    let none = (None, None, None);
    // The endpoint can return SEVERAL PRs whose head contains the tip (a reused branch, cherry-picks,
    // or an old + a new PR), and its ordering is not guaranteed "most relevant first". Prefer a merged
    // PR (the tip shipped), then an open one (in review), else the first — so a stale closed PR can't
    // shadow the one that actually reflects this tip's stage.
    let merged_idx =
        rows.iter().position(|pr| pr.get("merged_at").map(|v| !v.is_null()).unwrap_or(false));
    let open_idx = rows.iter().position(|pr| pr.get("state").and_then(Value::as_str) == Some("open"));
    let pick = merged_idx
        .or(open_idx)
        .map(|i| &rows[i])
        .or_else(|| rows.first());
    let Some(pr) = pick else {
        return none;
    };
    let merged = pr.get("merged_at").map(|v| !v.is_null()).unwrap_or(false);
    let state = if merged {
        Some("merged".to_string())
    } else {
        pr.get("state").and_then(Value::as_str).map(str::to_ascii_lowercase)
    };
    let number = pr.get("number").and_then(Value::as_u64);
    let url = pr.get("html_url").and_then(Value::as_str).map(str::to_string);
    (state, number, url)
}

/// The tip-relative lookup is authoritative iff it actually identified a PR — i.e. it carries a PR
/// NUMBER (a PR isn't actionable without one). Pure + tested so the "fall back to the branch-name
/// probe" decision can't silently regress; kept as a predicate (not an eager 2-arg chooser) so the
/// caller still short-circuits the second `gh` round-trip on the common success path.
fn commit_pr_is_usable(by_commit: &(Option<String>, Option<u64>, Option<String>)) -> bool {
    by_commit.1.is_some()
}

/// TIP-RELATIVE PR lookup: find the PR whose head contains commit `tip`, via the GitHub API, so a PR
/// opened from a RENAMED branch (head ≠ `sparkle/agent-<id>`) is still detected — the branch-name
/// probe (`probe_pr`) misses those. Being keyed on the current tip also means it stops reporting
/// "merged" once new commits are stacked past a merge (the new tip isn't in that PR), which is what
/// lets the tracker reset for a fresh work cycle. Best-effort: any failure yields all-None.
fn probe_pr_by_commit(root: &str, tip: &str) -> (Option<String>, Option<u64>, Option<String>) {
    let none = (None, None, None);
    if tip.trim().is_empty() {
        return none;
    }
    let mut cmd = Command::new(crate::preflight::gh_program());
    // gh substitutes {owner}/{repo} from the repo at `current_dir`. The endpoint returns the PRs
    // whose head branch contains `tip`, regardless of that branch's name.
    cmd.arg("api")
        .arg(format!("repos/{{owner}}/{{repo}}/commits/{tip}/pulls"))
        .arg("-H")
        .arg("Accept: application/vnd.github+json")
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    // Network touch → bounded wall-clock; a timeout reads as failure (all-None), like gh being absent.
    let Ok(output) = output_with_timeout(cmd, NETWORK_TIMEOUT) else {
        return none; // gh not installed / failed to spawn / timed out
    };
    if !output.status.success() {
        return none; // un-pushed tip (404), not authed, no network, …
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(rows) = serde_json::from_str::<Vec<Value>>(&stdout) else {
        return none;
    };
    decode_commit_pulls(&rows)
}

/// Pure decoder for a `gh pr list --json number` response → the number of open PRs. Kept separate
/// from the spawn so the "what does this output mean" half is unit-testable without a network or a
/// `gh` binary. Unparsable output reads as UNKNOWN (`None`), never as zero: the badge must be able
/// to distinguish "no PRs waiting" from "couldn't find out", because rendering a confident `0` on a
/// failed probe is exactly the false reassurance this feature exists to prevent.
fn decode_open_pr_count(stdout: &str) -> Option<u32> {
    let rows = serde_json::from_str::<Vec<Value>>(stdout).ok()?;
    u32::try_from(rows.len()).ok()
}

/// Best-effort count of OPEN pull requests in `root`'s repo authored by the current `gh` identity.
///
/// Repo-scoped on purpose, and deliberately NOT keyed on any agent: an agent leaves the sidebar
/// when its session ends, and a PR-awaiting-merge signal that dies with the agent is precisely the
/// gap this closes (see PRD/sparkle-pr-awaiting-merge-badge.md). Scoped to `--author @me` so that
/// on a repo with other contributors this counts only work this identity owns and can merge, rather
/// than a teammate's review queue.
///
/// Best-effort by the same convention as `probe_pr`: gh absent, unauthed, offline, no remote, or a
/// timeout all yield `None` (unknown) and never an error.
fn probe_open_pr_count(root: &str) -> Option<u32> {
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.arg("pr")
        .args(["list", "--state", "open", "--author", "@me", "--limit", "100", "--json", "number"])
        .current_dir(root)
        // Keep gh non-interactive and quiet; never let it block on a prompt or updater.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    // Network touch → bounded wall-clock, so a hung remote can't stall the poll behind it.
    let output = output_with_timeout(cmd, NETWORK_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    decode_open_pr_count(&String::from_utf8_lossy(&output.stdout))
}

/// How many open PRs authored by this identity are waiting in `root`'s repo. `Ok(None)` means
/// "couldn't find out" (see `probe_open_pr_count`); the badge renders nothing for it.
#[tauri::command]
pub async fn project_open_pr_count(root: String) -> Result<Option<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || probe_open_pr_count(&root))
        .await
        .map_err(|e| format!("project_open_pr_count task failed: {e}"))
}

/// Pure decoder: `gh repo view --json url` → the repo's PR-list URL. Split from the spawn so the
/// URL-shaping is testable without `gh`. Anything that isn't a plausible https URL yields None
/// rather than a half-built link — the badge would rather do nothing than open a wrong page.
fn decode_pr_list_url(stdout: &str) -> Option<String> {
    let v = serde_json::from_str::<Value>(stdout).ok()?;
    let url = v.get("url").and_then(Value::as_str)?.trim_end_matches('/');
    if !url.starts_with("https://") {
        return None;
    }
    Some(format!("{url}/pulls"))
}

/// The repo's pull-request list URL, for the badge's click-through. Asks `gh` rather than parsing
/// `git remote get-url`, so SSH remotes, enterprise hosts, and renamed repos all resolve the same
/// way the rest of the PR machinery already resolves them. Best-effort: `None` on any failure, and
/// the caller simply doesn't navigate.
/// Best-effort PR-list URL for `root`'s repo. Mirrors `probe_open_pr_count`'s shape deliberately:
/// the gh-invocation boilerplate (non-interactive env, bounded wall-clock, failure reads as None)
/// is identical, and having one path inline it while the other used a helper made the pair harder
/// to compare than it needed to be.
fn probe_pr_list_url(root: &str) -> Option<String> {
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.args(["repo", "view", "--json", "url"])
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    let output = output_with_timeout(cmd, NETWORK_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    decode_pr_list_url(&String::from_utf8_lossy(&output.stdout))
}

#[tauri::command]
pub async fn project_pr_list_url(root: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || probe_pr_list_url(&root))
        .await
        .map_err(|e| format!("project_pr_list_url task failed: {e}"))
}

/// One open pull request, richer than the bare `probe_open_pr_count` count: enough for the TopBar
/// PR menu to LIST each PR, name the agent that owns it, and gate its Merge action on
/// `checks`/`mergeable`. Serialized camelCase for the JS side.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrRow {
    pub number: u64,
    pub title: String,
    pub head_ref_name: String,
    pub url: String,
    /// Aggregate CI rollup: "passing" | "pending" | "failing" | "none". "none" is a PR with no
    /// checks at all — distinct from "couldn't tell", which drops the whole probe to `None`.
    pub checks: String,
    /// "mergeable" | "conflicting" | "unknown". GitHub computes mergeability asynchronously, so a
    /// freshly opened PR often reads "unknown"; the UI treats that as "not yet known", which is a
    /// reason to WAIT rather than a reason to offer a one-click merge.
    pub mergeable: String,
    /// GitHub's `mergeStateStatus`, lowercased: "clean" | "dirty" | "unstable" | "blocked" |
    /// "behind" | "draft" | "has_hooks" | "unknown".
    ///
    /// This is the axis `mergeable` alone cannot express, and the reason the dot used to read as
    /// arbitrary. `mergeable` answers "would git accept this merge"; `merge_state_status` answers
    /// "is anything else wrong". UNSTABLE is the case that matters: GitHub reports
    /// `mergeable: MERGEABLE` — you genuinely CAN merge — while a non-required check is failing or
    /// still running. Collapsing those two axes into one colour is what put an enabled Merge button
    /// under a yellow dot.
    pub merge_state_status: String,
    /// Names of the checks that FAILED, so the UI can say which one rather than "checks failing".
    /// Deduplicated, in rollup order. Empty when nothing failed.
    pub failing_checks: Vec<String>,
    /// Names of the checks still RUNNING, same shape as `failing_checks`. A PR can have both (some
    /// checks red while others are still going).
    pub pending_checks: Vec<String>,
    /// The agent that opened this PR, from the DURABLE mapping in `pr_owner` — `None` when nothing
    /// identifies it. Never inferred: a pill carrying the wrong id opens the wrong agent, which is
    /// worse than no pill, so "couldn't tell" stays null. See `pr_owner`'s module header.
    pub agent_id: Option<String>,
    /// Which `pr_owner::SOURCE_*` produced `agent_id`; `None` alongside a `None` owner.
    pub agent_id_source: Option<String>,
    /// The PR body, carried only so `pr_owner`'s marker can be read out of it. NOT serialized — the
    /// JS side has no use for 100 PR bodies, and shipping them would bloat every poll.
    #[serde(skip)]
    pub body: String,
}

/// Aggregate a `gh` `statusCheckRollup` array into one word. A failing check dominates (red beats
/// everything); else any still-running check makes the whole rollup "pending"; else if there are any
/// checks they have all succeeded → "passing"; an empty rollup is "none". Pure so the CI-shaping is
/// unit-tested without a network or a `gh` binary — the same split the badge's decoders use.
fn classify_checks(rollup: &[Value]) -> &'static str {
    let mut saw_any = false;
    let mut saw_pending = false;
    let mut saw_failing = false;
    for c in rollup {
        saw_any = true;
        match check_state(c) {
            CheckState::Failing => saw_failing = true,
            CheckState::Pending => saw_pending = true,
            CheckState::Passing => {}
        }
    }
    // Precedence is unchanged: a failure dominates, then anything still running, then success.
    if saw_failing {
        "failing"
    } else if saw_pending {
        "pending"
    } else if saw_any {
        "passing"
    } else {
        "none"
    }
}

/// How ONE `statusCheckRollup` entry reads.
///
/// Split out of `classify_checks` so that function and `collect_check_names` decide a given check
/// the same way BY CONSTRUCTION. They must not drift: the rollup word colours the dot and the names
/// write the label beside it, so two independent readings of the same entry is how you get a green
/// dot sitting next to the words "1 check failing".
#[derive(PartialEq, Eq, Clone, Copy, Debug)]
enum CheckState {
    Passing,
    Pending,
    Failing,
}

fn check_state(c: &Value) -> CheckState {
    // A check run reports status+conclusion; a legacy commit-status context reports one `state`.
    if let Some(state) = c.get("state").and_then(Value::as_str) {
        return match state {
            "SUCCESS" => CheckState::Passing,
            "PENDING" | "EXPECTED" => CheckState::Pending,
            _ => CheckState::Failing, // FAILURE | ERROR
        };
    }
    // Not COMPLETED yet → still running (QUEUED | IN_PROGRESS | WAITING | REQUESTED | ...).
    if c.get("status").and_then(Value::as_str) != Some("COMPLETED") {
        return CheckState::Pending;
    }
    match c.get("conclusion").and_then(Value::as_str).unwrap_or("") {
        // A neutral/skipped/successful check does not block a merge.
        "SUCCESS" | "NEUTRAL" | "SKIPPED" => CheckState::Passing,
        _ => CheckState::Failing, // FAILURE | CANCELLED | TIMED_OUT | ACTION_REQUIRED | STALE
    }
}

/// The NAME a check shows under. Check runs carry `name`; legacy commit statuses carry `context`.
/// An entry with neither is still worth counting — it is a real check that is really failing — so
/// it gets a placeholder rather than being silently dropped from the count.
fn check_name(c: &Value) -> String {
    c.get("name")
        .and_then(Value::as_str)
        .or_else(|| c.get("context").and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .unwrap_or("unnamed check")
        .to_string()
}

/// `(failing, pending)` check names, in rollup order, deduplicated.
///
/// Deduplicated because the same check can appear twice in a rollup (a re-run, or a job reported
/// under both its own name and a rollup context), and a list that names the same check twice reads
/// as a bug in the reader rather than a fact about the PR.
fn collect_check_names(rollup: &[Value]) -> (Vec<String>, Vec<String>) {
    let mut failing: Vec<String> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    for c in rollup {
        let bucket = match check_state(c) {
            CheckState::Failing => &mut failing,
            CheckState::Pending => &mut pending,
            CheckState::Passing => continue,
        };
        let name = check_name(c);
        if !bucket.contains(&name) {
            bucket.push(name);
        }
    }
    (failing, pending)
}

/// GitHub's `mergeStateStatus` enum → the lowercase word the UI reads. An unrecognised or absent
/// value reads "unknown", which the UI treats as "we cannot promise this is safe" — never as clean.
fn normalize_merge_state(v: Option<&str>) -> &'static str {
    match v {
        Some("CLEAN") => "clean",
        Some("DIRTY") => "dirty",
        Some("UNSTABLE") => "unstable",
        Some("BLOCKED") => "blocked",
        Some("BEHIND") => "behind",
        Some("DRAFT") => "draft",
        Some("HAS_HOOKS") => "has_hooks",
        _ => "unknown",
    }
}

/// GitHub's `mergeable` enum → the lowercase word the UI reads. Anything other than the two known
/// terminal values (including the very common asynchronously-not-yet-computed `UNKNOWN`) reads as
/// "unknown", which the UI treats as NOT-YET: the dot goes amber and the Merge button is withheld.
///
/// That used to say the opposite — "attempt the merge and let gh decide rather than a hard block" —
/// and it is exactly how an amber dot ended up beside a live one-click Merge. GitHub invalidates
/// mergeability on every push to the base branch, so UNKNOWN is routine rather than rare, and a
/// gate must not offer a confident button over an answer it does not have. The panel's Refresh
/// re-asks on demand, so nothing is stranded behind the poll (see services/openPrs.ts).
fn normalize_mergeable(v: Option<&str>) -> &'static str {
    match v {
        Some("MERGEABLE") => "mergeable",
        Some("CONFLICTING") => "conflicting",
        _ => "unknown",
    }
}

/// Pure decoder: `gh pr list --json number,title,headRefName,url,mergeable,statusCheckRollup` → rows.
/// Unparsable output yields `None` (unknown), never an empty list — the same null-vs-zero discipline
/// as `decode_open_pr_count`: an empty JSON *array* is a known "no PRs waiting", but garbage means
/// "couldn't tell", and the menu must not render a confident empty state on a failed probe.
fn decode_open_prs(stdout: &str) -> Option<Vec<PrRow>> {
    let rows = serde_json::from_str::<Vec<Value>>(stdout).ok()?;
    Some(
        rows.iter()
            .filter_map(|r| {
                // A PR without a number is unusable (nothing to merge or link), so drop just that row
                // rather than failing the whole probe.
                let number = r.get("number").and_then(Value::as_u64)?;
                let str_field = |k: &str| {
                    r.get(k).and_then(Value::as_str).unwrap_or("").to_string()
                };
                let rollup = r.get("statusCheckRollup").and_then(Value::as_array);
                let checks = rollup.map(|a| classify_checks(a)).unwrap_or("none").to_string();
                let (failing_checks, pending_checks) =
                    rollup.map(|a| collect_check_names(a)).unwrap_or_default();
                let mergeable =
                    normalize_mergeable(r.get("mergeable").and_then(Value::as_str)).to_string();
                let merge_state_status =
                    normalize_merge_state(r.get("mergeStateStatus").and_then(Value::as_str))
                        .to_string();
                Some(PrRow {
                    number,
                    title: str_field("title"),
                    head_ref_name: str_field("headRefName"),
                    url: str_field("url"),
                    checks,
                    mergeable,
                    merge_state_status,
                    failing_checks,
                    pending_checks,
                    // Ownership is resolved by the caller, which has the app-data store; the pure
                    // decoder only carries the raw material (`body`) forward.
                    agent_id: None,
                    agent_id_source: None,
                    body: str_field("body"),
                })
            })
            .collect(),
    )
}

/// The open PRs authored by this identity in `root`'s repo, each joined to the agent that owns it.
/// Mirrors `probe_open_pr_count`'s gh-invocation shape (non-interactive env, bounded wall-clock,
/// failure reads as `None`) but asks for the richer field set the menu needs. Best-effort: gh
/// absent, unauthed, offline, no remote, or a timeout all yield `None`.
///
/// `body` is requested purely so `pr_owner`'s marker can be read off PRs this machine never opened
/// — the one channel that survives a lost store or a fresh install. Resolving here (rather than in
/// JS) also BACKFILLS the durable store in the same pass, so a legacy `sparkle/agent-<id>` PR keeps
/// resolving once its branch is renamed or deleted.
fn probe_open_prs(root: &str, project_id: &str, app_data: &Path) -> Option<Vec<PrRow>> {
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.arg("pr")
        .args([
            "list",
            "--state",
            "open",
            "--author",
            "@me",
            "--limit",
            "100",
            "--json",
            "number,title,headRefName,url,mergeable,mergeStateStatus,statusCheckRollup,body",
        ])
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    let output = output_with_timeout(cmd, NETWORK_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    let rows = decode_open_prs(&String::from_utf8_lossy(&output.stdout))?;
    Some(attach_pr_owners(rows, project_id, app_data))
}

/// Fill each row's `agent_id`/`agent_id_source` from the durable mapping, backfilling it as a side
/// effect. Split out from the `gh` call so the join is unit-tested without a network or a binary.
fn attach_pr_owners(mut rows: Vec<PrRow>, project_id: &str, app_data: &Path) -> Vec<PrRow> {
    let inputs: Vec<(u64, String, String)> = rows
        .iter()
        .map(|r| (r.number, r.head_ref_name.clone(), r.body.clone()))
        .collect();
    for (row, owner) in
        rows.iter_mut().zip(crate::pr_owner::resolve_and_backfill(app_data, project_id, &inputs))
    {
        // Bodies exist only to be read for the marker; drop them once they have been.
        row.body = String::new();
        if let Some(o) = owner {
            row.agent_id = Some(o.agent_id);
            row.agent_id_source = Some(o.source);
        }
    }
    rows
}

/// The open PRs waiting in `root`'s repo, for the TopBar PR menu. `Ok(None)` means "couldn't find
/// out" (see `probe_open_prs`); the menu renders nothing for it, exactly as the count badge does.
#[tauri::command]
pub async fn project_open_prs(
    app: AppHandle,
    root: String,
    project_id: String,
) -> Result<Option<Vec<PrRow>>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || probe_open_prs(&root, &project_id, &app_data))
        .await
        .map_err(|e| format!("project_open_prs task failed: {e}"))
}

/// Read one PR's head branch and body — the two fields `pr_owner` resolves against — for a PR that
/// `project_open_prs` did not list (someone else's, or past the 100-row cap).
///
/// A failed probe yields `None`, which the caller must keep DISTINCT from "no owner": a PR nobody
/// could read is unknown, not unowned.
fn probe_pr_ref_and_body(root: &str, number: u64) -> Option<(String, String)> {
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.arg("pr")
        .args(["view", &number.to_string(), "--json", "headRefName,body"])
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    let output = output_with_timeout(cmd, NETWORK_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    let v: Value = serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).ok()?;
    let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Some((field("headRefName"), field("body")))
}

/// Which agent owns PR `number`, for a PR `project_open_prs` did not list.
///
/// Answers from the durable store first and only shells out to `gh` when it has nothing — so a PR
/// recorded at creation resolves offline. Always returns a full answer; an unknown owner is
/// `agentId: null` WITH a reason, never a guess.
#[tauri::command]
pub async fn pr_owner(
    app: AppHandle,
    root: String,
    project_id: String,
    number: u64,
) -> Result<crate::pr_owner::PrOwnerAnswer, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // A record written at creation time is first-hand and needs no network round-trip.
        let store = crate::pr_owner::load_store(&app_data);
        if let Some(o) = crate::pr_owner::resolve_owner(&store, &project_id, number, "", "") {
            return crate::pr_owner::PrOwnerAnswer {
                number,
                agent_id: Some(o.agent_id),
                source: Some(o.source),
                branch: None,
                reason: None,
            };
        }
        let (head_ref, body) = probe_pr_ref_and_body(&root, number).unwrap_or_default();
        crate::pr_owner::answer_for(&app_data, &project_id, number, &head_ref, &body)
    })
    .await
    .map_err(|e| format!("pr_owner task failed: {e}"))
}

/// Wall-clock ceiling for a user-initiated `gh pr merge`. Longer than `NETWORK_TIMEOUT`: a merge does
/// more server-side work than a read, and this path is one deliberate click (not a background poll),
/// so a slightly longer wait is acceptable where a stalled poll would not be.
const MERGE_TIMEOUT: Duration = Duration::from_secs(60);

/// Merge an open PR by number with a MERGE COMMIT. This is the human gate the workflow is built
/// around, invoked from the TopBar PR menu — for a PR whose opening agent has already left the
/// sidebar, it is the only way to merge from the app at all.
///
/// Deliberately `--merge`, NOT `--squash`: a squash rewrites the commits so the branch tip stops
/// being an ancestor of `main`, which breaks Sparkle's landed-by-ancestry proof (see AGENTS.md).
/// Deliberately NOT `--auto`: on a repo without auto-merge enabled `gh` silently degrades `--auto`
/// to an immediate merge, so it is not the guard it looks like. The UI only enables this once the
/// PR's checks are green and it is mergeable; `gh` is the backstop that refuses a merge whose
/// required checks are still red. The `gh` error text is returned verbatim on failure so the menu
/// can show exactly why a merge was declined.
#[tauri::command]
pub async fn merge_pr(root: String, number: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(crate::preflight::gh_program());
        cmd.args(["pr", "merge", &number.to_string(), "--merge"])
            .current_dir(&root)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1");
        apply_noninteractive(&mut cmd);
        // Lenient on purpose: this is a MUTATING call. `gh` inherits its pipes to ssh/credential
        // helpers that can outlive it, and an unfinished drain must not report a PR that actually
        // merged as failed — the exit status is the truth here, not the output tail.
        let captured = output_with_timeout_lenient(cmd, MERGE_TIMEOUT)?;
        if captured.output.status.success() {
            return Ok(());
        }
        let output = &captured.output;
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        };
        // `gh`'s own words are what the menu shows, so when they may be short, SAY so — an
        // unexplained empty reason is the least actionable thing this can return.
        let note = captured.truncation_note();
        Err(if msg.is_empty() {
            format!("gh pr merge #{number} failed{note}")
        } else {
            format!("{msg}{note}")
        })
    })
    .await
    .map_err(|e| format!("merge_pr task failed: {e}"))?
}

/// Per-repo cooldown between opportunistic `git fetch`es. Reachability into `origin/<default>` is
/// only as fresh as the last fetch; when a PR is merged in ANOTHER worktree/session this repo's
/// remote-tracking ref goes stale and the tracker understates "On Main"/"Merged" until something
/// fetches. We refresh it ourselves on the slow (network-allowed) poll — but at most once per repo
/// per cooldown, so N open agents don't trigger N fetches and we don't hammer the remote. The poll
/// runs ~every 30s, so 20s makes it fire about once per poll cycle. (The gh PR probe is already
/// authoritative for merged PRs; this self-heals the *reachability* path for merges with no PR, or
/// when gh is unavailable.)
const FETCH_COOLDOWN: Duration = Duration::from_secs(20);

fn last_fetch() -> &'static Mutex<HashMap<String, Instant>> {
    static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pure throttle decision (testable without a clock): fetch if we never have, or the cooldown has
/// elapsed since the last one.
fn fetch_due(last: Option<Instant>, now: Instant) -> bool {
    match last {
        Some(t) => now.duration_since(t) >= FETCH_COOLDOWN,
        None => true,
    }
}

/// Best-effort, throttled refresh of `origin/<default>` so a cross-worktree/session merge shows up
/// without the user pulling. Any failure (offline, no auth, no remote) is ignored — `git` already
/// runs non-interactive, so a missing credential fails fast rather than prompting.
fn maybe_refresh_origin(root: &str, default_branch: &str) {
    let now = Instant::now();
    {
        let Ok(mut map) = last_fetch().lock() else {
            return; // a poisoned lock must never break the poll
        };
        if !fetch_due(map.get(root).copied(), now) {
            return;
        }
        map.insert(root.to_string(), now);
    }
    // Network touch → bounded wall-clock (see git_networked); an offline/partition fetch fails fast.
    let _ = git_networked(root, &["fetch", "--quiet", "--no-tags", "origin", default_branch]);
}

/// Kick a background, throttled refresh of `origin/<base>` off the worktree-create critical path.
/// Resolves the logical base (falling back to the project default for an empty/unsafe ref) on the
/// spawned thread, then reuses [`maybe_refresh_origin`] so N agents opening at once don't each fetch,
/// and an unreachable remote never stalls the spawn — the fetch just fails quietly in the background.
fn spawn_background_origin_refresh(root: &str, base_branch: &str) {
    let root = root.to_string();
    let base = base_branch.trim().to_string();
    std::thread::spawn(move || {
        let logical = if base.is_empty() || validate_ref(&base).is_err() {
            resolve_default_branch(&root)
        } else {
            base
        };
        maybe_refresh_origin(&root, &logical);
    });
}

// ── Pre-warmed worktree pool (sparkle worktree-pool) ─────────────────────────────────────────────
//
// `git worktree add -b <branch> <path> <base>` is slow because it MATERIALIZES the whole working
// tree (measured at 86-98% of every build-agent spawn, 2s uncontended and up to 16s queued behind
// other worktree ops). But creating a branch in an ALREADY-materialized worktree whose files equal
// the base tree is O(1). So at idle we park a few detached-HEAD worktrees checked out at the base
// commit under a SEPARATE app-data subtree; a spawn then CLAIMS one — `git worktree move` it to the
// agent path + `git checkout -b sparkle/agent-<id>` — both near-instant ref ops. The claim returns
// the IDENTICAL `WorktreeInfo` the slow path would, so nothing downstream can tell the difference.
//
// The pool is a PURE optimization: disabled by config, empty, cut from a since-moved base, or any
// git failure ⇒ transparently fall back to the original `git worktree add` in `create_worktree_at`.

/// A parked pool worktree's on-disk root: `<app_data>/worktree-pool/<project_id>/<slot-id>`. This is
/// a SEPARATE subtree from agent worktrees (`worktrees/<project_id>/<agent_id>`) on purpose — every
/// scanner that enumerates agent worktrees (heal_agent_hooks, scan_worker_manifests, the Sparkle
/// self-improve reaper) walks `worktrees/<project_id>/…` and would otherwise have to special-case a
/// pool entry; keeping pool slots out of that tree entirely means none of them ever see a slot.
fn pool_dir(app_data: &Path, project_id: &str) -> Result<PathBuf, String> {
    validate_id("project_id", project_id)?;
    Ok(app_data.join("worktree-pool").join(project_id))
}

/// One parked, detached-HEAD worktree checked out at `base_commit`, ready to be claimed.
#[derive(Clone)]
struct PoolSlot {
    path: PathBuf,
    /// The commit the slot was warmed at. Re-checked against the CURRENT effective base at claim
    /// time so a slot cut from a since-advanced base is discarded rather than handed out.
    base_commit: String,
}

/// In-memory pool state, keyed by project_id. Guarded by this mutex ONLY for the brief push/pop;
/// the slow `git worktree add` runs outside it (under the per-repo git lock) so warming never blocks
/// a claim that just needs to pop a slot.
fn pools() -> &'static Mutex<HashMap<String, Vec<PoolSlot>>> {
    static POOLS: OnceLock<Mutex<HashMap<String, Vec<PoolSlot>>>> = OnceLock::new();
    POOLS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-repo-root serialization for index/ref-mutating git worktree ops (add/move/remove/prune/
/// checkout -b). The frontend `withRepoLock` already serializes FRONTEND-initiated ops among
/// themselves; this additionally serializes the BACKGROUND warm/top-up thread against them, so a
/// warm's `git worktree add` can never collide with a concurrent claim/create/worker-cut on
/// `index.lock`. A plain per-root mutex — held only around the git call, never nested — so there is
/// no deadlock risk with the frontend chain.
fn repo_git_lock(root: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.entry(root.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// Projects whose leftover pool dirs have been swept this session (startup cleanup, once per project).
fn pool_cleaned() -> &'static Mutex<HashSet<String>> {
    static CLEANED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CLEANED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Projects with a top-up currently in flight, so a mount storm / burst of claims doesn't stack
/// redundant warmers (each would race to the same `size` target and over-warm).
fn topup_in_flight() -> &'static Mutex<HashSet<String>> {
    static INFLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    INFLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Remove parked worktrees left behind by a CRASHED prior session and prune stale git admin entries.
/// Runs at most ONCE per project per session, and (because the in-memory pool boots empty) always
/// BEFORE the first warm — so it can only ever delete leftovers, never a slot this session created.
/// Idempotent + best-effort: any I/O or git error is ignored.
fn cleanup_pool_once(root: &str, project_id: &str, app_data: &Path) {
    {
        let mut set = pool_cleaned().lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(project_id.to_string()) {
            return; // already swept this session
        }
    }
    let gl = repo_git_lock(root);
    let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(dir) = pool_dir(app_data, project_id) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let ps = p.to_string_lossy().to_string();
                    // Deregister it as a worktree (no-op if git doesn't know it), then delete the dir.
                    let _ = git(root, &["worktree", "remove", "--force", &ps]);
                    let _ = std::fs::remove_dir_all(&p);
                }
            }
        }
    }
    // Clear git's admin records for any now-missing worktrees (pool leftovers or reaped agents).
    let _ = git(root, &["worktree", "prune"]);
}

/// A filesystem-safe random slot id (32 hex chars). Uses `rand` (already a dependency) so we need no
/// time/uuid crate and two concurrent warms can't collide on a name.
fn new_slot_id() -> String {
    let a: u64 = rand::random();
    let b: u64 = rand::random();
    format!("{a:016x}{b:016x}")
}

/// Warm ONE parked worktree: `git worktree add --detach <pool>/<slot> <base_commit>`, then record it
/// in the in-memory pool. Takes the per-repo git lock only around the add. The base is resolved
/// no-network (same commit `create_worktree_at` would cut from today), so warming never blocks on a
/// fetch. Err on any resolve/add failure (the caller stops topping up rather than spinning).
fn warm_one_slot(
    root: &str,
    project_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Result<(), String> {
    let base = effective_base(root, base_branch, false);
    let base_commit =
        git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")])?;
    if base_commit.is_empty() {
        return Err("pool warm: base commit did not resolve".into());
    }
    let dir = pool_dir(app_data, project_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create pool dir: {e}"))?;
    let slot_path = dir.join(new_slot_id());
    let slot_str = slot_path.to_string_lossy().to_string();
    {
        let gl = repo_git_lock(root);
        let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());
        git(root, &["worktree", "add", "--detach", &slot_str, &base_commit])?;
    }
    pools()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(project_id.to_string())
        .or_default()
        .push(PoolSlot { path: slot_path, base_commit });
    Ok(())
}

/// Bring the pool up to the configured size, warming ONE worktree at a time. No-op when the feature
/// is disabled, `size == 0`, or the pool is already full. Sweeps crashed-session leftovers first.
/// Blocking core of [`warm_worktree_pool`] and the post-claim/post-cut refill — always run off the
/// critical path (a background thread or `spawn_blocking`), never inline on a spawn.
fn topup_pool_blocking(root: &str, project_id: &str, base_branch: &str, app_data: &Path) {
    let cfg = crate::config::for_project(root).config.worktree_pool;
    if !cfg.enabled || cfg.size == 0 {
        return;
    }
    cleanup_pool_once(root, project_id, app_data);
    // At most one top-up per project at a time.
    {
        let mut set = topup_in_flight().lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(project_id.to_string()) {
            return;
        }
    }
    // RAII: clear the in-flight flag on EVERY exit — normal return AND an unwind out of a git helper
    // — so a mid-warm panic can't leave the project permanently marked "in flight", which would
    // silently disable pool warming for the rest of the session (the slow-path cut would still work,
    // masking it). Guarantees the manual `.remove()` this replaced can never be skipped.
    struct InFlightGuard(String);
    impl Drop for InFlightGuard {
        fn drop(&mut self) {
            topup_in_flight().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
        }
    }
    let _in_flight = InFlightGuard(project_id.to_string());
    let target = cfg.size as usize;
    loop {
        let have = pools()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(project_id)
            .map(|v| v.len())
            .unwrap_or(0);
        if have >= target {
            break;
        }
        if let Err(e) = warm_one_slot(root, project_id, base_branch, app_data) {
            tracing::debug!(%project_id, error = %e, "pool warm failed; leaving pool short");
            break; // don't spin on a persistent failure
        }
    }
}

/// Kick a pool top-up on a background thread so it never blocks the spawn that triggered it. Fired
/// on project open (via [`warm_worktree_pool`]) and after each successful claim / inline cut, so a
/// consumed or seeded slot is refilled while the user's fan-out continues.
fn spawn_pool_topup(root: &str, project_id: &str, base_branch: &str, app_data: &Path) {
    let root = root.to_string();
    let project_id = project_id.to_string();
    let base_branch = base_branch.to_string();
    let app_data = app_data.to_path_buf();
    std::thread::spawn(move || {
        topup_pool_blocking(&root, &project_id, &base_branch, &app_data);
    });
}

/// Try to satisfy an agent-worktree request from the parked pool. Pops a slot, verifies it is still
/// cut from the CURRENT effective base and clean, then `git worktree move`s it to the agent path and
/// `git checkout -b`s the agent branch on it — both near-instant ref ops. Returns the SAME
/// `WorktreeInfo` the slow path would (files == base tree, branch `sparkle/agent-<id>`). Any miss
/// (disabled, empty, stale base, dirty, an existing branch, or any git failure) returns None so the
/// caller transparently falls back to `git worktree add`. A rejected slot is pruned in passing.
fn try_claim_pooled_worktree(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Option<WorktreeInfo> {
    if !crate::config::for_project(root).config.worktree_pool.enabled {
        return None;
    }
    let branch = format!("sparkle/agent-{agent_id}");
    // Resolve the agent path FIRST — before consuming a slot — so an invalid id returns None without
    // popping (and then leaking) a parked worktree. (In practice create_worktree_at already resolved
    // this same path at its top, so the Err arm is unreachable here; resolving up front keeps the
    // slot-consuming code strictly after the only fallible-without-a-slot step.)
    let target = worktree_path(app_data, project_id, agent_id).ok()?;
    let target_str = target.to_string_lossy().to_string();

    // Pop the most-recently-warmed slot (LIFO — most likely to still match the current base).
    let slot = {
        let mut map = pools().lock().unwrap_or_else(|e| e.into_inner());
        map.get_mut(project_id).and_then(|v| v.pop())
    }?;
    let slot_str = slot.path.to_string_lossy().to_string();

    // Hold the per-repo git lock across the WHOLE verify → move → branch sequence, and resolve the
    // current effective base INSIDE it, so a background fetch can't advance the base between the
    // staleness check and the move — the "never hand out the wrong base" guarantee holds against the
    // lock, not a read taken before it.
    let gl = repo_git_lock(root);
    let _lock = gl.lock().unwrap_or_else(|e| e.into_inner());

    // What would the slow path cut from RIGHT NOW? If the base advanced since we warmed (e.g. a
    // background fetch moved origin/<base>), the slot is stale — discard it, never hand it out.
    let base = effective_base(root, base_branch, false);
    let current_base_commit = git(root, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")])
        .unwrap_or_default();

    // Validity + staleness guard: a real worktree, still detached at the commit we recorded, that
    // commit still the current effective base, and a clean tree. Anything else ⇒ discard + fall back.
    let head = git(&slot_str, &["rev-parse", "HEAD"]).unwrap_or_default();
    let clean = git(&slot_str, &["status", "--porcelain"]).map(|s| s.is_empty()).unwrap_or(false);
    let valid_worktree = git(&slot_str, &["rev-parse", "--is-inside-work-tree"]).is_ok();
    let usable = !current_base_commit.is_empty()
        && head == slot.base_commit
        && slot.base_commit == current_base_commit
        && clean
        && valid_worktree;
    if !usable {
        let _ = git(root, &["worktree", "remove", "--force", &slot_str]);
        let _ = std::fs::remove_dir_all(&slot.path);
        let _ = git(root, &["worktree", "prune"]);
        return None;
    }

    // Never claim onto a branch that already exists — that's a RESUME, which must go through the
    // branch-reattach path in create_worktree_at (a fresh `checkout -b` would fail or discard work).
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok() {
        let _ = git(root, &["worktree", "remove", "--force", &slot_str]);
        let _ = std::fs::remove_dir_all(&slot.path);
        return None;
    }

    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Move the parked tree to the agent path (git rewrites its admin gitdir), then create + check out
    // the agent branch on it. HEAD is detached at the base commit, so `checkout -b` cuts the branch
    // there — files already equal the base tree, so nothing is materialized.
    if git(root, &["worktree", "move", &slot_str, &target_str]).is_err() {
        let _ = git(root, &["worktree", "remove", "--force", &slot_str]);
        let _ = std::fs::remove_dir_all(&slot.path);
        let _ = git(root, &["worktree", "prune"]);
        return None;
    }
    if git(&target_str, &["checkout", "-b", &branch]).is_err() {
        // Moved but the branch didn't attach — tear the half-built worktree down so the caller's
        // `git worktree add` fallback starts from a clean slate at the agent path.
        let _ = git(root, &["worktree", "remove", "--force", &target_str]);
        let _ = git(root, &["worktree", "prune"]);
        return None;
    }
    Some(WorktreeInfo { path: target_str, branch })
}

/// Warm this project's parked worktree pool up to the configured size, off the main thread. Call on
/// project open/activation so a later agent spawn can claim a ready worktree instead of paying
/// `git worktree add` on the critical path. No-op when `[worktree_pool].enabled = false`. Never
/// errors on a warm miss — the pool is a pure optimization.
#[tauri::command]
pub async fn warm_worktree_pool(
    app: AppHandle,
    root: String,
    project_id: String,
    base_branch: String,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        topup_pool_blocking(&root, &project_id, &base_branch, &app_data);
    })
    .await
    .map_err(|e| format!("warm_worktree_pool task failed: {e}"))
}

/// Prewarm what the first agent spawn needs so it's already hot: the claude + node path caches, and
/// a throttled background `origin/<default>` fetch. Runs off the main thread; every step is
/// best-effort (a warm miss just means the spawn resolves it itself). Safe to call on project open
/// or before the first spawn — the fetch is throttled so repeated calls don't hammer the remote.
#[tauri::command]
pub async fn prewarm_spawn(root: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::preflight::cached_claude_path();
        let _ = crate::preflight::resolve_node_path_cached();
        // Fetch the project's default branch so the first real worktree cut sees a fresh origin tip
        // without paying the fetch synchronously. Throttled + offline-safe via maybe_refresh_origin.
        let default = resolve_default_branch(&root);
        maybe_refresh_origin(&root, &default);
    })
    .await
    .ok();
}

/// Core (AppHandle-free, testable): the agent's land-to-green workflow state. `parent_branch` is
/// the orchestrator's branch for workers (empty/None for others). `probe_pr_state` gates the gh
/// network probe so a pure-local project (or a fast poll) can skip it entirely.
/// Production callers go through `agent_workflow_state_in` (they know the worktree); this
/// worktree-less form is kept for the test suite, which drives repos directly.
#[cfg_attr(not(test), allow(dead_code))]
pub fn agent_workflow_state_at(
    root: &str,
    agent_id: &str,
    parent_branch: &str,
    probe_pr_state: bool,
) -> Result<WorkflowState, String> {
    agent_workflow_state_in(root, agent_id, parent_branch, probe_pr_state, None)
}

/// As `agent_workflow_state_at`, but the caller may supply `(app_data, project_id)` so the agent's
/// worktree — and its PARENT's — can be located, which is what lets a RENAMED branch resolve at all
/// (see `resolve_agent_branch` / `resolve_parent_branch`). Without it this falls back to the minted
/// `sparkle/agent-<id>` names, which read as "no branch yet" for a renamed branch — the zeroed state
/// that put a fully-committed agent on the "Unsaved" rung.
pub fn agent_workflow_state_in(
    root: &str,
    agent_id: &str,
    parent_branch: &str,
    probe_pr_state: bool,
    ctx: Option<(&Path, &str)>,
) -> Result<WorkflowState, String> {
    let default_branch_for_resolve = resolve_default_branch(root);
    let branch = match ctx.and_then(|(app_data, pid)| worktree_path(app_data, pid, agent_id).ok()) {
        Some(wt) => {
            let head = worktree_head_branch(&wt.to_string_lossy(), wt.exists());
            resolve_agent_branch(root, &head, agent_id, &default_branch_for_resolve).0
        }
        None => format!("sparkle/agent-{agent_id}"),
    };
    // Same treatment for the integration target: a renamed ORCHESTRATOR otherwise makes every one
    // of its workers read `inParent: false`. See `resolve_parent_branch`.
    let parent_branch: String = match ctx {
        Some((app_data, pid)) => {
            resolve_parent_branch(root, app_data, pid, parent_branch, &default_branch_for_resolve)
        }
        None => parent_branch.to_string(),
    };
    // The branch tip lives in the shared repo (worktree add -b created the ref), so we can resolve
    // and compare it from `root` without touching the worktree dir.
    let tip = match git(root, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")]) {
        Ok(sha) if !sha.is_empty() => sha,
        // No branch yet (worktree never created) ⇒ nothing has landed anywhere.
        _ => return Ok(WorkflowState::default()),
    };

    let default_branch = resolve_default_branch(root);
    // On the network-allowed poll, opportunistically refresh origin/<default> FIRST so the
    // reachability checks below see a merge that landed in another worktree/session (throttled per
    // repo). Gated on `probe_pr_state` so the fast/local poll skips the `git remote` spawn entirely;
    // computed once and reused for the PR-probe gate below (both uses are network-poll-only).
    let has_origin = probe_pr_state && git(root, &["remote", "get-url", "origin"]).is_ok();
    if has_origin {
        maybe_refresh_origin(root, &default_branch);
    }
    // ONE implementation, shared with the batched project poll — see `workflow_state_shared`. These
    // two used to carry byte-identical copies of the whole derivation, which is how a fix applied to
    // one silently left the other (the path the sidebar actually polls) wrong.
    Ok(workflow_state_shared(root, &branch, &parent_branch, &default_branch, has_origin, &tip))
}

/// Live workflow stage signals for an agent: local-ref reachability + a best-effort GitHub PR
/// probe. See `WorkflowState`. The PR probe is gated by `probe_pr_state` (skip it on fast polls or
/// remoteless projects).
/// `async` + `spawn_blocking` (mirroring `create_agent_worktree`) so the several `git` subprocesses
/// plus the (network) `gh` PR probe this runs per poll never stall the UI thread.
#[tauri::command]
pub async fn agent_workflow_state(
    app: AppHandle,
    root: String,
    // Carries `project_id` for the same reason `agent_branch_status` does: the worktree lives
    // OUTSIDE the project (in app-data) and is keyed by project id. Optional so a caller that
    // genuinely has no project context still works — it just loses renamed-branch resolution.
    project_id: Option<String>,
    agent_id: String,
    parent_branch: String,
    probe_pr_state: bool,
) -> Result<WorkflowState, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = project_id.as_deref().map(|pid| (app_data.as_path(), pid));
        agent_workflow_state_in(&root, &agent_id, &parent_branch, probe_pr_state, ctx)
    })
    .await
    .map_err(|e| format!("agent_workflow_state task failed: {e}"))?
}

// ── Batched per-project status (sparkle-zlic) ────────────────────────────────────────────────────
// The 30s sidebar poll used to fan out ~3-4 git/bd subprocesses PER open agent (branch status +
// workflow reachability + an opportunistic origin fetch + a `gh` PR probe), i.e. N agents ⇒ a burst
// of ~3-4N processes every tick. `project_agents_status` collapses that into ONE call per project:
// shared repo discovery (default branch, origin presence, one throttled origin fetch, the
// git-common-dir) is done ONCE, `effective_base` resolution is memoized per distinct base, and an
// idle agent whose FINGERPRINT — its branch tip + its base tip + the integration-branch tip + its
// worktree's index mtime — is unchanged since the last tick is SKIPPED entirely (its prior result is
// reused). Runs on the blocking pool via `spawn_blocking` so it never stalls the UI thread.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusInput {
    agent_id: String,
    /// The logical branch this agent's branch is compared against for ahead/behind (its own base).
    base_branch: String,
    /// The orchestrator branch for a worker (empty otherwise) — drives `in_parent`.
    parent_branch: String,
    /// "build" | "worker" | "think" | "shell". think/shell have no git workflow and are skipped.
    kind: String,
    /// The frontend sets this when the agent is actively working (PTY live): never skip it, so its
    /// dirty/ahead counts stay fresh while Claude edits/commits. Idle agents can be skipped.
    force: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusResult {
    agent_id: String,
    /// false ⇒ nothing changed since the last tick; the frontend keeps its prior store values.
    changed: bool,
    branch: Option<BranchStatus>,
    workflow: Option<WorkflowState>,
}

/// The cheap change-detection key for one agent. When every component is unchanged since the last
/// tick the agent's git state can't have moved (own tip, its base, the integration branch, and its
/// worktree's index are all identical), so the cached result is reused instead of recomputing.
#[derive(Clone, PartialEq)]
struct StatusFingerprint {
    tip: String,
    base_tip: String,
    default_tip: String,
    index_mtime_ms: u128,
}

/// Per-worktree-path cache of the last-seen fingerprint (sparkle-zlic). Keyed by worktree path
/// (stable per agent). We store only the fingerprint (not the result): on a skip the frontend keeps
/// its prior store values, so there's nothing to hand back. Session-scoped: boots empty so the first
/// tick always computes.
fn status_cache() -> &'static Mutex<HashMap<String, StatusFingerprint>> {
    static CACHE: OnceLock<Mutex<HashMap<String, StatusFingerprint>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How long a worktree's last gh PR probe stays authoritative before the batch re-probes it EVEN IF
/// the git fingerprint is unchanged (sparkle-prpb). The fingerprint (tip/base/default/index) only
/// tracks GIT movement, but a PR opening, merging, or closing is a server-side fact that moves no
/// git ref — so without this an out-of-band PR open (e.g. the agent ran `gh pr create`) would leave
/// the CTA stuck on "Open Pull Request" until the branch happened to commit again. 90s bounds that
/// staleness while keeping gh calls to ~one per idle agent per TTL (vs. every 15s tick), preserving
/// the point of the fingerprint skip (sparkle-zlic).
const PR_REPROBE_TTL: Duration = Duration::from_secs(90);

/// Per-worktree-path clock of the last time the batch actually RAN the gh PR probe for that agent
/// (sparkle-prpb). Separate from `status_cache` because it advances on a different axis (wall-clock,
/// not git state). Session-scoped; evicted alongside the fingerprint in `remove_worktree_at`.
fn pr_probe_cache() -> &'static Mutex<HashMap<String, Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pure throttle decision (testable without a clock): re-probe PR state if we never have for this
/// worktree, or PR_REPROBE_TTL has elapsed since the last probe. Mirrors `fetch_due`.
fn pr_reprobe_due(last: Option<Instant>, now: Instant) -> bool {
    match last {
        Some(t) => now.duration_since(t) >= PR_REPROBE_TTL,
        None => true,
    }
}

/// mtime (ms since epoch) of a linked worktree's private git index, or 0 when it can't be read. The
/// index lives under the shared repo at `<git-common-dir>/worktrees/<name>/index`; our worktree leaf
/// name IS the agent id (a UUID, never deduped by git), so we stat it without spawning a subprocess.
fn worktree_index_mtime_ms(git_common_dir: &Path, agent_id: &str) -> u128 {
    let index = git_common_dir.join("worktrees").join(agent_id).join("index");
    std::fs::metadata(&index)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Resolve a git ref to its commit sha (empty when it doesn't resolve). For the fingerprint tips.
fn rev_parse_tip(root: &str, refname: &str) -> String {
    if refname.trim().is_empty() {
        return String::new();
    }
    git(root, &["rev-parse", "--verify", "--quiet", &format!("{refname}^{{commit}}")])
        .unwrap_or_default()
}

/// Live ahead/behind + dirty + size for an agent branch vs an ALREADY-RESOLVED base ref. Mirrors
/// `agent_branch_status_at` but takes the base ref precomputed, so a batch resolves `effective_base`
/// once per distinct base instead of once per agent.
fn branch_status_with_base(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_ref: &str,
    wt: &Path,
    app_data: &Path,
) -> Result<BranchStatus, String> {
    let wt_str = wt.to_string_lossy().to_string();
    // `--no-optional-locks`: a plain `git status` refreshes and REWRITES the worktree index (to
    // update its stat cache), which would bump the index mtime our fingerprint keys on and defeat the
    // skip on the very next tick. This top-level flag tells git not to take the index lock / write it,
    // so the mtime stays stable and an idle, unchanged agent is actually skipped (sparkle-zlic).
    // Same worktree-identity check as `agent_branch_status_at` (sparkle-xk3x). This is the path
    // the sidebar/status BATCH poll uses, so it is the one that actually drives what the user
    // sees — fixing only the single-agent path would leave the misreport live in the UI.
    // `rev-parse` doesn't touch the index, so it can't defeat the fingerprint skip above.
    let head_branch = worktree_head_branch(&wt_str, wt.exists());
    let (branch, worktree_on_branch) =
        resolve_agent_branch(root, &head_branch, agent_id, base_ref);
    // Only agents the fingerprint did NOT skip reach here — which is exactly right for ownership:
    // a skipped agent is unchanged by definition, so its branch mapping cannot have moved either.
    observe_worktree_branch(app_data, project_id, agent_id, &head_branch);
    let d = DirtyReading::read(&wt_str, wt.exists(), true)?;
    // A brand-new/non-git agent polled before its first commit has no `sparkle/agent-<id>` ref yet;
    // `rev-list <base>...<missing>` then hard-fails with "ambiguous argument ... unknown revision",
    // which fails the WHOLE batch read for that agent and re-logs "batch branch status failed" every
    // 30s poll for the app's lifetime. Mirror `agent_branch_status_at`'s guard (the #291 fix, lost in
    // the batch refactor): return a zeroed status — still reflecting the worktree's dirty state — when
    // the branch ref doesn't exist, so there's nothing to count against a ref that isn't there.
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_err() {
        return Ok(BranchStatus { ahead: 0, behind: 0, dirty: d.dirty, files_changed: 0, insertions: 0, deletions: 0, worktree_on_branch, dirty_files: d.files.clone(), dirty_count: d.count });
    }
    // The branch exists, but the RESOLVED base may not (`effective_base`'s documented unborn/HEAD-less
    // fallback can return a name git can't resolve). `rev-list <unresolvable-base>...<branch>` then
    // hard-fails with "fatal: ambiguous argument", failing the whole batch read for that agent and
    // re-logging "batch branch status failed" every 30s tick for the app's lifetime. There's nothing to
    // diverge from when the base doesn't exist, so report the branch's own commits as `ahead` (behind 0)
    // instead of erroring — mirrors `agent_branch_status_at`'s base guard.
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{base_ref}^{{commit}}")]).is_err() {
        return Ok(ahead_only_status(root, &branch, &d, worktree_on_branch));
    }
    let counts = git(root, &["rev-list", "--left-right", "--count", &format!("{base_ref}...{branch}")])?;
    let mut it = counts.split_whitespace();
    let behind: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let numstat = git(root, &["diff", "--numstat", &format!("{base_ref}...{branch}")]).unwrap_or_default();
    let (mut files_changed, mut insertions, mut deletions) = (0u32, 0u32, 0u32);
    for line in numstat.lines().filter(|l| !l.trim().is_empty()) {
        files_changed += 1;
        let mut cols = line.split_whitespace();
        insertions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        deletions += cols.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    }
    Ok(BranchStatus { ahead, behind, dirty: d.dirty, files_changed, insertions, deletions, worktree_on_branch, dirty_files: d.files, dirty_count: d.count })
}

/// The agent's workflow state given ALREADY-RESOLVED shared inputs (default branch, origin presence)
/// and its precomputed branch `tip`. Mirrors `agent_workflow_state_at` minus the per-call
/// resolve_default_branch + origin refresh, which the batch does ONCE up front. `has_origin` already
/// folds in the caller's PR-probe gate (as in `agent_workflow_state_at`): a remote exists AND the
/// caller asked to probe — so the `gh` lookup runs iff `has_origin`.
fn workflow_state_shared(
    root: &str,
    branch: &str,
    parent_branch: &str,
    default_branch: &str,
    has_origin: bool,
    tip: &str,
) -> WorkflowState {
    if tip.trim().is_empty() {
        return WorkflowState::default();
    }
    let in_local_main = ref_contains(root, default_branch, tip);
    let origin_ref = format!("origin/{default_branch}");
    let in_origin_main = ref_contains(root, &origin_ref, tip);
    let in_parent = ref_contains(root, parent_branch, tip);
    let landed = branch_landed(root, default_branch, &branch, tip);
    // Live Pushed signal (sparkle-v7d0) — a pure local, offline-safe remote-tracking-ref lookup.
    let pushed = branch_pushed(root, &branch);
    // Commits the agent AUTHORED that aren't yet landed (0 once merged into the integration ref).
    // Measured against the ref the branch was actually CUT FROM — `origin/<default>` when a
    // remote-tracking ref exists (see `effective_base`, which cuts new branches from origin),
    // else local `<default>`. Comparing against LOCAL `<default>` here is wrong when it lags the
    // remote: a brand-new branch cut from `origin/<default>` would count the inherited, un-pulled
    // commits as the agent's own work — tripping the frontend's `committedSeen` gate which, together
    // with `in_origin_main` (trivially true for such a tip), falsely reads a no-op agent as "Merged".
    let base_for_ahead = if git(root, &["rev-parse", "--verify", "--quiet", &origin_ref]).is_ok() {
        origin_ref.clone()
    } else {
        default_branch.to_string()
    };
    let ahead_of_base = commits_beyond(root, &base_for_ahead, &branch);

    // ── The no-op-branch guard for TIP-INHERITED facts (sparkle: "Build 5 → Remote: Merged") ─────
    // `tip_in_release` and `probe_pr_by_commit` both answer a question about a COMMIT, not about
    // this agent. A branch that has authored nothing carries the commit it was cut from — the
    // integration branch's HEAD — so those two probes describe MAIN'S history and get attributed to
    // an agent that has done no work at all. On this repo that reads: a seconds-old build agent's
    // tip is main's HEAD, which is the merge commit of the last merged PR, so the commit probe
    // returns that PR with `merged_at` set → `pr_state = "merged"` → the row files itself under
    // "Remote: Merged to Main"; and if the cut point is old enough to be inside a release tag,
    // `shipped` fires too → "Remote: Shipped to Production". Worse, `pr_state != null` is one of the
    // frontend's `committedSeen` sources, so the bogus signal ALSO unlocks the reachability bumps
    // (`in_origin_main` is trivially true for such a tip) that the no-op guard exists to hold shut.
    //
    // So: when the branch carries none of its own work, suppress both. Ancestry (`in_local_main` /
    // `landed`) is left alone — those stay honest raw facts and the frontend already gates them.
    //
    // Answered from the branch's REFLOG plus arithmetic against the ref it was cut from. The reflog
    // is what keeps a branch's `commit:` entries visible after a local `merge --no-ff` absorbs the
    // work into main (Sparkle's own land path, and how every worker integrates) — at which point the
    // arithmetic alone reads exactly like a brand-new branch. See `branch_carries_no_own_work`.
    let cut_relative = cut_from_ref(root, parent_branch, &base_for_ahead).map(|cut_ref| {
        (commits_beyond(root, &cut_ref, &branch), ref_contains(root, &cut_ref, tip))
    });
    let no_own_work = branch_carries_no_own_work(branch_ever_committed(root, &branch), cut_relative);
    let shipped = !no_own_work && tip_in_release(root, tip);

    // Only spend a network round-trip on the PR probe when asked AND a remote exists. Try the
    // TIP-RELATIVE lookup first (finds the PR by commit, so a renamed head still resolves and a
    // tip stacked past a merge stops reading as "merged"); fall back to the branch-name probe when
    // the tip isn't associated with any PR (e.g. un-pushed, or a head gh can't map by commit).
    // The branch-name probe is agent-scoped by construction (`--head sparkle/agent-<id>`), so it is
    // safe to keep running for a no-op branch — it simply finds nothing.
    let (pr_state, pr_number, pr_url) = if has_origin {
        let by_commit =
            if no_own_work { (None, None, None) } else { probe_pr_by_commit(root, tip) };
        if commit_pr_is_usable(&by_commit) {
            by_commit
        } else {
            probe_pr(root, &branch)
        }
    } else {
        (None, None, None)
    };
    WorkflowState {
        in_local_main,
        in_origin_main,
        in_parent,
        ahead_of_base,
        landed,
        pushed,
        shipped,
        // `has_origin` already folds in the caller's probe gate (see this fn's doc comment), so this
        // carries the same "false means no-remote OR not-probed" ambiguity as the per-agent path.
        has_remote: has_origin,
        pr_state,
        pr_number,
        pr_url,
    }
}

/// Core (AppHandle-free, testable): compute branch + workflow status for EVERY agent of a project in
/// one pass, sharing repo discovery and skipping fingerprint-unchanged idle agents (sparkle-zlic).
pub fn project_agents_status_at(
    root: &str,
    project_id: &str,
    agents: &[AgentStatusInput],
    probe_pr_state: bool,
    app_data: &Path,
) -> Vec<AgentStatusResult> {
    // ── Shared repo discovery, done ONCE for the whole batch ──
    let default_branch = resolve_default_branch(root);
    // `has_origin` folds in the PR-probe gate exactly as agent_workflow_state_at does: the network
    // touches (origin fetch + gh probe) only happen on a probe-enabled poll against a repo with a
    // remote. Reachability into origin/<default> still runs regardless (it's a local ref read).
    let has_origin = probe_pr_state && git(root, &["remote", "get-url", "origin"]).is_ok();
    if has_origin {
        maybe_refresh_origin(root, &default_branch);
    }
    // One clock read for the whole batch, so every agent's PR-reprobe TTL is measured from the same
    // instant (sparkle-prpb).
    let now = Instant::now();
    // git-common-dir for locating each worktree's private index (fingerprint input). Best-effort.
    let git_common_dir: Option<PathBuf> = git(root, &["rev-parse", "--git-common-dir"]).ok().map(|d| {
        let p = PathBuf::from(&d);
        if p.is_absolute() { p } else { Path::new(root).join(p) }
    });
    // The integration-branch tips — BOTH local <default> and origin/<default> — folded into EVERY
    // agent's fingerprint so ANY advance of main re-evaluates everyone. This matters for reachability
    // ("On Main"/"Merged") that moves without the agent's OWN tip changing: a LOCAL merge advances
    // local main only (origin unchanged), a fetched remote merge advances origin only — capturing
    // both means the background tick still picks up an orchestrator reaching main (and, in turn, its
    // workers' "Merged", which tracks the parent) instead of waiting for the agent to commit again.
    let origin_default_ref = format!("origin/{default_branch}");
    let default_tip = format!(
        "{}:{}",
        rev_parse_tip(root, &default_branch),
        rev_parse_tip(root, &origin_default_ref),
    );

    // Memoize effective base ref + its tip per distinct logical base (avoid re-resolving per agent).
    let mut base_ref_memo: HashMap<String, String> = HashMap::new();
    let mut base_tip_memo: HashMap<String, String> = HashMap::new();

    let mut out = Vec::with_capacity(agents.len());
    let skipped = |id: &str| AgentStatusResult {
        agent_id: id.to_string(),
        changed: false,
        branch: None,
        workflow: None,
    };
    for a in agents {
        // think/shell have no git workflow — report unchanged so the frontend leaves them alone.
        if a.kind == "think" || a.kind == "shell" {
            out.push(skipped(&a.agent_id));
            continue;
        }
        let wt = match worktree_path(app_data, project_id, &a.agent_id) {
            Ok(p) => p,
            Err(_) => {
                out.push(skipped(&a.agent_id));
                continue;
            }
        };
        let base_ref = base_ref_memo
            .entry(a.base_branch.clone())
            .or_insert_with(|| effective_base(root, &a.base_branch, false))
            .clone();
        // Resolve the branch from the TREE, not the id: a renamed branch has no
        // `sparkle/agent-<id>` ref, so minting the name here left `tip` empty, which made
        // `workflow_state_shared` return the all-false default and `branch_status_with_base`
        // return ahead=0 — the pair that renders a fully-committed agent as "Unsaved".
        //
        // COSTS NOTHING IN THE STEADY STATE, which matters because this runs BEFORE the
        // fingerprint skip (the `tip` below is part of the fingerprint, so it cannot be deferred).
        // `rev_parse_tip` on the minted name is the same call the batch already made; a non-empty
        // answer means the minted branch exists, and `resolve_agent_branch` returns the minted name
        // in that case regardless of the head. So the extra `git rev-parse` for the head is paid
        // ONLY when the minted ref is missing — the renamed agent and the brand-new one, never the
        // idle-and-unchanged majority the sparkle-zlic skip exists to keep cheap.
        let minted = format!("sparkle/agent-{}", a.agent_id);
        let minted_tip = rev_parse_tip(root, &minted);
        let (branch, tip) = if minted_tip.is_empty() {
            let head = worktree_head_branch(&wt.to_string_lossy(), wt.exists());
            let resolved = resolve_agent_branch(root, &head, &a.agent_id, &base_ref).0;
            let resolved_tip = rev_parse_tip(root, &resolved);
            (resolved, resolved_tip)
        } else {
            (minted, minted_tip)
        };
        let base_tip = base_tip_memo
            .entry(base_ref.clone())
            .or_insert_with(|| rev_parse_tip(root, &base_ref))
            .clone();
        let index_mtime_ms = git_common_dir
            .as_deref()
            .map(|d| worktree_index_mtime_ms(d, &a.agent_id))
            .unwrap_or(0);
        let fp = StatusFingerprint {
            tip: tip.clone(),
            base_tip,
            default_tip: default_tip.clone(),
            index_mtime_ms,
        };
        let wt_key = wt.to_string_lossy().to_string();

        // Skip an idle agent whose fingerprint matches the cache — reuse the prior result. EXCEPTION
        // (sparkle-prpb): PR state (open/merged/closed) is a SERVER-SIDE fact that moves no git ref,
        // so a fingerprint match does NOT prove the CTA is fresh — the gh probe is pr_state's only
        // source and it lives past this skip. On a probe-enabled poll against a remote we therefore
        // still recompute once PR_REPROBE_TTL has elapsed since this worktree's last probe, so an
        // out-of-band PR open flips "Open Pull Request" → "Merge PR #N" within the TTL instead of
        // never. `has_origin` confines this to polls that would actually run gh; the local-only /
        // no-probe path is byte-for-byte unchanged.
        if !a.force {
            let fp_match = status_cache()
                .lock()
                .ok()
                .map(|c| c.get(&wt_key).map(|prev| *prev == fp).unwrap_or(false))
                .unwrap_or(false);
            if fp_match {
                let last_pr_probe =
                    pr_probe_cache().lock().ok().and_then(|m| m.get(&wt_key).copied());
                if !(has_origin && pr_reprobe_due(last_pr_probe, now)) {
                    out.push(skipped(&a.agent_id));
                    continue;
                }
            }
        }

        // Compute fresh. A per-agent branch-status error (e.g. a missing branch) is non-fatal: report
        // unchanged so one bad agent can't fail the whole batch (mirrors pollBranchStatus swallowing).
        let branch_status = match branch_status_with_base(
            root,
            project_id,
            &a.agent_id,
            &base_ref,
            &wt,
            app_data,
        ) {
            Ok(bs) => bs,
            Err(e) => {
                tracing::debug!(agent = %a.agent_id, error = %e, "batch branch status failed");
                out.push(skipped(&a.agent_id));
                continue;
            }
        };
        // A renamed ORCHESTRATOR would otherwise make every one of its workers read
        // `inParent: false` — see `resolve_parent_branch`.
        let parent_branch =
            resolve_parent_branch(root, app_data, project_id, &a.parent_branch, &base_ref);
        let workflow =
            workflow_state_shared(root, &branch, &parent_branch, &default_branch, has_origin, &tip);

        if let Ok(mut cache) = status_cache().lock() {
            cache.insert(wt_key.clone(), fp);
        }
        // Stamp the PR-probe clock whenever this recompute actually ran the gh probe (has_origin), so
        // the next TTL window starts now. Both a git-moved recompute and a PR-refresh recompute run
        // the probe, so both reset it (sparkle-prpb).
        if has_origin {
            if let Ok(mut cache) = pr_probe_cache().lock() {
                cache.insert(wt_key, now);
            }
        }
        out.push(AgentStatusResult {
            agent_id: a.agent_id.clone(),
            changed: true,
            branch: Some(branch_status),
            workflow: Some(workflow),
        });
    }
    out
}

/// Branch + workflow status for ALL of a project's agents in ONE call (sparkle-zlic). Async +
/// `spawn_blocking` so the (possibly many) git/gh subprocesses never block the UI thread.
#[tauri::command]
pub async fn project_agents_status(
    app: AppHandle,
    root: String,
    project_id: String,
    agents: Vec<AgentStatusInput>,
    probe_pr_state: bool,
) -> Result<Vec<AgentStatusResult>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        project_agents_status_at(&root, &project_id, &agents, probe_pr_state, &app_data)
    })
    .await
    .map_err(|e| format!("project_agents_status task failed: {e}"))
}

#[derive(Serialize)]
pub struct MarkdownChange {
    /// Repo-root-relative path of the markdown file.
    path: String,
    /// Current content of the file in the worktree.
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSync {
    /// The worktree's current HEAD — the caller stores this as the next sync marker.
    head_sha: String,
    files: Vec<MarkdownChange>,
}

/// Core (AppHandle-free, testable): markdown files an agent committed that the Chief library
/// hasn't seen yet. `since_sha` is the last-synced commit; empty/unknown reseeds from every
/// tracked markdown file. The reseed intentionally includes docs inherited from the base branch
/// (not just ones this agent authored) — the goal is to give Chief the full catch-up of existing
/// project docs, and assets are named by path + commit, not attributed to an agent. `dirs` are
/// directory pathspecs to scope to (e.g. `PRD`, `docs/superpowers/specs`); only `.md` files under
/// them are returned, with current content.
pub fn markdown_changed_since_at(
    project_id: &str,
    agent_id: &str,
    since_sha: &str,
    dirs: &[String],
    app_data: &Path,
) -> Result<MarkdownSync, String> {
    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt_str = wt.to_string_lossy().to_string();
    let head = git(&wt_str, &["rev-parse", "HEAD"])?;

    // A non-empty marker is only usable if it still resolves to a commit in this worktree.
    // Anything else (empty, rewritten history, typo) reseeds rather than erroring.
    let since_valid = !since_sha.is_empty()
        && git(
            &wt_str,
            &["rev-parse", "--verify", "--quiet", &format!("{since_sha}^{{commit}}")],
        )
        .is_ok();

    // `-c core.quotePath=false` keeps non-ASCII paths (e.g. `PRD/café.md`) raw instead of
    // C-quoted (`"PRD/caf\303\251.md"`), which would fail the `.md` suffix test below and be
    // silently dropped.
    let range = format!("{since_sha}..HEAD");
    let mut args: Vec<&str> = if since_valid {
        vec![
            "-c",
            "core.quotePath=false",
            "diff",
            "--name-only",
            "--diff-filter=ACMR",
            &range,
            "--",
        ]
    } else {
        vec!["-c", "core.quotePath=false", "ls-files", "--"]
    };
    for d in dirs {
        args.push(d.as_str());
    }
    // Propagate (don't swallow) a listing failure: a transient git error must leave the marker
    // un-advanced so the next tick retries the range, rather than reporting an empty result that
    // advances HEAD past commits whose markdown was never examined.
    let listing = git(&wt_str, &args)?;

    let mut files = Vec::new();
    for rel in listing.lines().map(str::trim).filter(|l| !l.is_empty()) {
        // Scope to markdown; a directory pathspec also matches sibling non-md files.
        if !rel.ends_with(".md") {
            continue;
        }
        // Read the file's CURRENT content from the worktree (not the historical blob). A file
        // that was changed then deleted, or is unreadable, is skipped rather than fatal.
        if let Ok(content) = std::fs::read_to_string(wt.join(rel)) {
            files.push(MarkdownChange { path: rel.to_string(), content });
        }
    }
    Ok(MarkdownSync { head_sha: head, files })
}

/// Markdown an agent committed since `since_sha`, scoped to `dirs`, for upload into Chief.
#[tauri::command]
pub async fn markdown_changed_since(
    app: AppHandle,
    project_id: String,
    agent_id: String,
    since_sha: String,
    dirs: Vec<String>,
) -> Result<MarkdownSync, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        markdown_changed_since_at(&project_id, &agent_id, &since_sha, &dirs, &app_data)
    })
    .await
    .map_err(|e| format!("markdown_changed_since task failed: {e}"))?
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum RefreshOutcome {
    Ok { ok: bool, ahead: u32, behind: u32 },
    Err { ok: bool, reason: String, files: Vec<String> },
}

/// Core (AppHandle-free, testable): rebase an agent branch onto its fresh effective base.
/// Preconditions enforced defensively: clean working tree AND no in-progress git operation.
/// Conflicts abort cleanly so the branch is byte-identical to before.
pub fn refresh_agent_branch_at(
    root: &str,
    project_id: &str,
    agent_id: &str,
    base_branch: &str,
    app_data: &Path,
) -> Result<RefreshOutcome, String> {
    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt = wt.to_string_lossy().to_string();

    // Precondition: clean AND settled (no rebase/merge mid-flight — porcelain can be empty
    // mid-rebase). Propagate a failed status read (e.g. missing/invalid worktree) instead of
    // letting `unwrap_or_default()` report it as "clean" and then rebasing against a bad cwd.
    let dirty = !git(&wt, &["status", "--porcelain"])?.is_empty();
    let git_dir = git(&wt, &["rev-parse", "--git-path", "."]).unwrap_or_default();
    let in_progress = ["rebase-merge", "rebase-apply"].iter().any(|d| {
        Path::new(&wt).join(".git").join(d).exists() || Path::new(&git_dir).join(d).exists()
    }) || git(&wt, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).is_ok();
    if dirty || in_progress {
        return Ok(RefreshOutcome::Err { ok: false, reason: "dirty".into(), files: vec![] });
    }

    let base = effective_base(root, base_branch, true); // fetch fresh tip
    let mut rebase = Command::new(crate::preflight::git_program());
    rebase.arg("-C").arg(&wt).args(["rebase", &base]);
    apply_noninteractive(&mut rebase);
    match rebase.output() {
        Ok(o) if o.status.success() => {
            let st = agent_branch_status_at(root, project_id, agent_id, base_branch, app_data)?;
            Ok(RefreshOutcome::Ok { ok: true, ahead: st.ahead, behind: st.behind })
        }
        _ => {
            // Capture conflicted files, then abort so the branch is byte-identical to before.
            let files = git(&wt, &["diff", "--name-only", "--diff-filter=U"])
                .unwrap_or_default()
                .lines()
                .map(|s| s.to_string())
                .collect();
            let _ = git(&wt, &["rebase", "--abort"]);
            Ok(RefreshOutcome::Err { ok: false, reason: "conflict".into(), files })
        }
    }
}

/// Rebase an agent branch onto its fresh effective base. Refuses a dirty/mid-operation tree;
/// aborts cleanly on conflict. `busy` (a live PTY) is gated on the frontend.
#[tauri::command]
pub async fn refresh_agent_branch(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    base_branch: String,
) -> Result<RefreshOutcome, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        refresh_agent_branch_at(&root, &project_id, &agent_id, &base_branch, &app_data)
    })
    .await
    .map_err(|e| format!("refresh_agent_branch task failed: {e}"))?
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum LandOutcome {
    // `merge_sha` is the merge commit this land created on the target — captured so the caller can
    // record it on the bead and the delivery monitor can later test that exact commit for release
    // containment (Task B). Empty only if `rev-parse` failed. NOTE: `LandOutcome` is `untagged` with
    // no container `rename_all`, so this multi-word field MUST carry an explicit `rename` — the TS
    // `LandResult` reads `mergeSha`, and without this it would deserialize as undefined (silent
    // no-op). The pre-existing fields are single words, which is why none needed a rename.
    Ok {
        ok: bool,
        target: String,
        #[serde(rename = "mergeSha")]
        merge_sha: String,
    },
    Err { ok: bool, reason: String, files: Vec<String> },
}

/// Path of the worktree that currently has `branch` checked out (`refs/heads/<branch>`), via
/// `git worktree list --porcelain`. None when no worktree has it checked out.
fn worktree_on_branch(root: &str, branch: &str) -> Option<String> {
    let listing = git(root, &["worktree", "list", "--porcelain"]).ok()?;
    let want = format!("refs/heads/{branch}");
    let mut cur_path: Option<String> = None;
    for line in listing.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if b.trim() == want {
                return cur_path;
            }
        }
    }
    None
}

/// Core (AppHandle-free, testable): merge an agent's branch into `target_branch` LOCALLY. The merge
/// runs INSIDE whichever worktree currently has `target_branch` checked out, sidestepping git's
/// "cannot update a checked-out branch" refusal. Guarded — refuses unless that worktree is clean —
/// and aborts cleanly on conflict so the target is byte-identical to before. `target_branch` is the
/// orchestrator's branch for a worker, or the project's default branch for a build agent. A live
/// PTY on the target is gated on the frontend (like refresh).
pub fn land_agent_branch_at(
    root: &str,
    agent_id: &str,
    target_branch: &str,
) -> Result<LandOutcome, String> {
    let err = |reason: &str, files: Vec<String>| {
        Ok(LandOutcome::Err { ok: false, reason: reason.into(), files })
    };
    let target = target_branch.trim();
    if target.is_empty() {
        return err("no-target", vec![]);
    }
    let branch = format!("sparkle/agent-{agent_id}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")]).is_err() {
        return err("no-branch", vec![]);
    }
    // The target must resolve to a real commit. Otherwise the rev-list below errors and would
    // collapse to ahead==0, masquerading a missing/typo'd target as a misleading "nothing-to-land".
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{target}^{{commit}}")]).is_err() {
        return err("no-target", vec![]);
    }
    // Nothing to land if the target already contains every commit on the branch.
    let ahead: u32 = git(root, &["rev-list", "--count", &format!("{target}..{branch}")])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if ahead == 0 {
        return err("nothing-to-land", vec![]);
    }
    // The target must be checked out somewhere so we can merge there without fighting git.
    let Some(wt) = worktree_on_branch(root, target) else {
        return err("target-not-checked-out", vec![]);
    };
    // Never disturb a dirty target checkout (the user's main, or a busy orchestrator's tree).
    if !git(&wt, &["status", "--porcelain"])?.is_empty() {
        return err("dirty", vec![]);
    }
    let msg = format!("Land {branch} into {target}");
    let mut merge = Command::new(crate::preflight::git_program());
    merge.arg("-C").arg(&wt).args(["merge", "--no-ff", &branch, "-m", &msg]);
    apply_noninteractive(&mut merge);
    match merge.output() {
        Ok(o) if o.status.success() => {
            // The merge (--no-ff) left a merge commit at the target worktree's HEAD — record it so
            // the bead can carry its exact landed SHA for release-containment checks. Best-effort:
            // an empty string just means the monitor treats this bead as not-yet-testable (honest).
            let merge_sha = git(&wt, &["rev-parse", "HEAD"]).unwrap_or_default().trim().to_string();
            Ok(LandOutcome::Ok { ok: true, target: target.to_string(), merge_sha })
        }
        _ => {
            // Conflicted paths distinguish a real merge conflict from a non-conflict failure (git
            // errored, or the process failed to spawn): only the former populates --diff-filter=U.
            let files: Vec<String> = git(&wt, &["diff", "--name-only", "--diff-filter=U"])
                .unwrap_or_default()
                .lines()
                .map(|s| s.to_string())
                .collect();
            // Abort to leave the target byte-identical (a no-op if no merge was actually in flight).
            let _ = git(&wt, &["merge", "--abort"]);
            if files.is_empty() {
                err("merge-failed", vec![])
            } else {
                err("conflict", files)
            }
        }
    }
}

/// Merge an agent's branch into its integration target (orchestrator branch for a worker, project
/// default for a build agent) locally. Refuses a dirty target; aborts cleanly on conflict. A live
/// PTY on the target worktree is gated on the frontend.
#[tauri::command]
pub async fn land_agent_branch(
    root: String,
    agent_id: String,
    target_branch: String,
) -> Result<LandOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        land_agent_branch_at(&root, &agent_id, &target_branch)
    })
    .await
    .map_err(|e| format!("land_agent_branch task failed: {e}"))?
}

/// Core (testable): push an agent's branch to `origin`. Returns "pushed" on success, or "no-remote"
/// when the project has no `origin` (the caller then falls back to a local land or keeps the branch
/// locally). A git failure (auth/network) surfaces as Err so the UI can report it.
pub fn push_agent_branch_at(root: &str, agent_id: &str) -> Result<String, String> {
    if git(root, &["remote", "get-url", "origin"]).is_err() {
        return Ok("no-remote".to_string());
    }
    let branch = format!("sparkle/agent-{agent_id}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")]).is_err() {
        return Err("no-branch".to_string());
    }
    git(root, &["push", "-u", "origin", &branch]).map(|_| "pushed".to_string())
}

/// Push an agent's branch to `origin` for the close-agent Ship/Save paths. "pushed" | "no-remote".
#[tauri::command]
pub async fn push_agent_branch(root: String, agent_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || push_agent_branch_at(&root, &agent_id))
        .await
        .map_err(|e| format!("push_agent_branch task failed: {e}"))?
}

/// WHAT A DELETE ACTUALLY DID. Both delete commands below succeed (`Ok`) in cases where the branch
/// is still there — `delete_agent_branch_if_merged_at` keeps an unlanded branch by design, and both
/// are idempotent for a branch that was already gone. A caller that reads "the call resolved" as
/// "the branch is deleted" therefore reports a deletion that never happened, which is exactly the
/// false report the concierge tool layer exists to prevent. This is the observed outcome, so the
/// caller never has to assume.
///
/// Serialized as a plain kebab-case string (`"deleted"` / `"already-absent"` / `"kept-not-merged"`).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BranchDeleteOutcome {
    /// The ref existed and is now gone.
    Deleted,
    /// There was no such branch — nothing was destroyed.
    AlreadyAbsent,
    /// The branch is NOT landed on the target, so it was left alone. Only `*_if_merged` returns this.
    KeptNotMerged,
}

/// Core (testable): delete an agent's local branch — the Discard path. Force (`-D`) because the
/// branch is intentionally unmerged here; that's what Discard means. Idempotent: an already-gone
/// branch is Ok, reported as `AlreadyAbsent` so the caller can tell it apart from a real delete.
/// The caller MUST remove the worktree first (git refuses to delete a checked-out branch) and gate
/// this behind an explicit confirmation.
pub fn delete_agent_branch_at(root: &str, agent_id: &str) -> Result<BranchDeleteOutcome, String> {
    let branch = format!("sparkle/agent-{agent_id}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_err() {
        return Ok(BranchDeleteOutcome::AlreadyAbsent); // already gone — Discard is idempotent
    }
    git(root, &["branch", "-D", &branch]).map(|_| BranchDeleteOutcome::Deleted)
}

/// Delete an agent's local branch (Discard). See `delete_agent_branch_at`.
#[tauri::command]
pub async fn delete_agent_branch(
    root: String,
    agent_id: String,
) -> Result<BranchDeleteOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || delete_agent_branch_at(&root, &agent_id))
        .await
        .map_err(|e| format!("delete_agent_branch task failed: {e}"))?
}

/// Core (testable): delete an agent's local branch on close, ONLY when it's effectively landed on
/// the integration branch; otherwise KEEP it. Uses the SAME robust detection as the workflow
/// "landed" signal — `ref_contains` (fast-forward ancestry) OR `merge_adds_nothing` (merge-tree,
/// which catches squash/rebase merges where the branch tip isn't an ancestor of the target). A plain
/// `git branch -d` would refuse the squash/rebase case and silently no-op the user's "delete"
/// setting on the common GitHub path.
///
/// PRECONDITION: invoked only for a SHIPPED agent (the caller — closeBuildAgent / the Close button —
/// gates on `workflowShipped`). Note `merge_adds_nothing` means "adds nothing to the target", which
/// is true of a genuinely merged branch but ALSO of a zero-diff branch (never committed, or
/// net-reverted) — so this is "effectively landed", not a strict merge proof. That's safe under the
/// shipped gate (a zero-work branch never ships); a future caller without that gate must not reuse
/// this assuming it strictly means "merged". Idempotent (already-gone is Ok); the caller MUST remove
/// the worktree first (git refuses to delete a checked-out branch).
///
/// KEEPING THE BRANCH IS A SUCCESS, NOT AN ERROR — but it is a DIFFERENT success from deleting it,
/// so the two are reported as distinct `BranchDeleteOutcome`s rather than as one indistinguishable
/// `Ok(())`. A failed `git branch -D` is likewise propagated instead of swallowed: it used to be
/// `let _ = git(...)`, which returned Ok for a branch git had refused to delete.
pub fn delete_agent_branch_if_merged_at(
    root: &str,
    agent_id: &str,
) -> Result<BranchDeleteOutcome, String> {
    let branch = format!("sparkle/agent-{agent_id}");
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_err() {
        return Ok(BranchDeleteOutcome::AlreadyAbsent); // already gone — idempotent
    }
    let target = resolve_default_branch(root);
    // Refresh origin first when there's a remote: a squash/rebase PR merge lands on origin/<target>,
    // and local <target> is typically NOT fast-forwarded in the desktop flow, so without this the
    // delete would miss the common GitHub path. Throttled per repo (maybe_refresh_origin).
    if git(root, &["remote", "get-url", "origin"]).is_ok() {
        maybe_refresh_origin(root, &target);
    }
    let tip = git(root, &["rev-parse", &branch]).unwrap_or_default();
    if !branch_landed(root, &target, &branch, tip.trim()) {
        return Ok(BranchDeleteOutcome::KeptNotMerged); // not landed → keep the branch
    }
    // Confirmed landed on local OR origin <target> → safe to remove (force, since a squash/rebase
    // merge means `-d`'s ancestry check would refuse a branch that IS effectively landed).
    git(root, &["branch", "-D", &branch]).map(|_| BranchDeleteOutcome::Deleted)
}

/// SAFELY delete an agent's merged branch (close a shipped agent). See
/// `delete_agent_branch_if_merged_at`.
#[tauri::command]
pub async fn delete_agent_branch_if_merged(
    root: String,
    agent_id: String,
) -> Result<BranchDeleteOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || delete_agent_branch_if_merged_at(&root, &agent_id))
        .await
        .map_err(|e| format!("delete_agent_branch_if_merged task failed: {e}"))?
}

/// Build the `gh pr create` argv for an agent branch. Pure + tested so the guard/defaulting logic is
/// exercised without invoking `gh`: rejects a blank `target` (else `--base ""` yields an opaque gh
/// error) and falls back to the branch name when `title` is blank.
///
/// The body carries `pr_owner`'s ownership marker. That marker is the ONLY copy of the PR→agent
/// mapping that lives on GitHub rather than on this machine, so it is what lets another install (or
/// this one after its store is lost) still name the owning agent. It is an HTML comment, so it is
/// invisible in the rendered PR.
fn pr_create_args(
    branch: &str,
    target: &str,
    title: &str,
    owner_marker: &str,
) -> Result<Vec<String>, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("no target branch".to_string());
    }
    let title = if title.trim().is_empty() { branch } else { title.trim() };
    Ok(vec![
        "pr".into(),
        "create".into(),
        "--head".into(),
        branch.to_string(),
        "--base".into(),
        target.to_string(),
        "--title".into(),
        title.to_string(),
        "--body".into(),
        format!("Opened by Sparkle (close-agent → Ship).\n\n{owner_marker}"),
    ])
}

/// Open a GitHub PR for an agent's branch via `gh pr create` (best-effort: needs `gh`, auth, and an
/// `origin`). Returns the PR URL on success. The caller pushes FIRST. This is the close-agent Ship
/// path's default so work goes through review (roborev) rather than merging straight to main.
/// Pre-checks the branch exists and the target is non-empty so a missing branch / blank base surface
/// as clear errors instead of opaque `gh` stderr; other failures (no gh / PR already exists / no
/// remote) surface as Err for the caller to handle.
///
/// The PR→agent mapping is RECORDED here, twice over: once in the durable local store and once as a
/// marker in the PR body. Both are best-effort side effects — a failure to record costs a resolvable
/// owner, never the PR, so it is logged and swallowed rather than turned into an error the user sees
/// after their PR already exists.
#[tauri::command]
pub async fn open_agent_pr(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
    target_branch: String,
    title: String,
) -> Result<String, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let branch = format!("sparkle/agent-{agent_id}");
        if git(&root, &["rev-parse", "--verify", "--quiet", &format!("{branch}^{{commit}}")]).is_err() {
            return Err("no-branch".to_string());
        }
        let marker = crate::pr_owner::pr_body_marker(&agent_id, &project_id);
        let args = pr_create_args(&branch, &target_branch, &title, &marker)?;
        let mut cmd = Command::new(crate::preflight::gh_program());
        cmd.args(&args)
            .current_dir(&root)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1");
        apply_noninteractive(&mut cmd);
        let out = cmd.output().map_err(|e| format!("failed to run gh: {e}"))?;
        if out.status.success() {
            let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
            match crate::pr_owner::pr_number_from_url(&url) {
                Some(number) => {
                    if let Err(e) = crate::pr_owner::record_pr_created(
                        &app_data, &project_id, number, &agent_id, &branch,
                    ) {
                        tracing::warn!(
                            number, %agent_id, error = %e,
                            "open_agent_pr: could not record PR ownership (non-fatal)"
                        );
                    }
                }
                // The body marker still carries the mapping, so this degrades rather than losing it.
                None => tracing::warn!(
                    %url,
                    "open_agent_pr: no PR number in gh output; owner recorded only in the PR body"
                ),
            }
            Ok(url)
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("open_agent_pr task failed: {e}"))?
}

/// Where an evacuated checkout waits for the slow part of its deletion, once the git lock has
/// stopped caring about it.
///
/// A SIBLING of `worktrees/`, deliberately, not a child. `scan_worker_manifests_at`, `retention.rs`
/// and `pty.rs` all enumerate under `worktrees/` and read what they find as a project dir or an
/// agent slot — and a parked checkout still carries its `.sparkle/worker.json`, so a trash dir
/// placed inside would get a worker re-adopted at a path that is about to be deleted out from under
/// it. Under `app_data` either way, which is what keeps the rename below on one filesystem.
pub fn removal_trash_dir(app_data: &Path) -> PathBuf {
    app_data.join("worktree-trash")
}

/// A filesystem-safe, collision-free name for a parked checkout.
///
/// The ids are already validated by `worktree_path`, so this is defence in depth rather than the
/// only guard — but this name is joined onto a path we then `remove_dir_all`, and that is not a
/// place to rely on a check made somewhere else. Anything not `[A-Za-z0-9_-]` becomes `-`.
///
/// `.` is NOT in that set, and that is the whole point rather than an oversight: allowing it lets
/// `..` survive intact, and a tag of `..` turns `trash.join(tag)` into the trash dir's PARENT. The
/// first version of this permitted `.` and a test caught exactly that.
///
/// The pid is not decoration: the sweep below uses it to tell a checkout THIS process is actively
/// deleting from one a previous run left behind.
fn trash_tag(project_id: &str, agent_id: &str) -> String {
    let safe = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
            .collect()
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{}-{}-p{}-{nanos}",
        safe(project_id),
        safe(agent_id),
        std::process::id()
    )
}

/// Rename a checkout out of the way so the slow half of a teardown happens off the git lock.
///
/// `Some(parked)` means the checkout is GONE from its worktree path — which is the only thing the
/// lock is protecting — and the caller owns the returned path. `None` means nothing moved and the
/// caller must fall back to `git worktree remove`: a missing checkout (teardown is idempotent), an
/// undeletable trash dir, or a rename that failed. That last one is the case worth naming: a rename
/// across filesystems is `EXDEV`, and while `app_data` puts both paths under one root today, a
/// bind-mounted or relocated worktrees dir would break that silently. Falling back is exactly the
/// behavior that shipped before this, so the failure mode is "slow again", never "not removed".
fn evacuate_checkout(wt: &Path, trash: &Path, tag: &str) -> Option<PathBuf> {
    if !wt.exists() {
        return None;
    }
    std::fs::create_dir_all(trash).ok()?;
    let dest = trash.join(tag);
    std::fs::rename(wt, &dest).ok()?;
    Some(dest)
}

/// Delete a parked checkout on a detached thread, and sweep what earlier runs left behind.
///
/// Detached because the whole point is that the caller — and the git lock it just released — does
/// not wait out a multi-second `remove_dir_all`. Nothing downstream depends on the deletion having
/// finished: the worktree path is already free for a fresh `git worktree add`, and git's admin
/// record is already pruned.
///
/// The sweep bounds what a quit-mid-delete can leave: entries are only reclaimed when their name
/// does NOT carry this process's pid, so a concurrent teardown's live directory is never raced.
fn delete_parked_checkout(parked: PathBuf) {
    let trash = parked.parent().map(Path::to_path_buf);
    std::thread::spawn(move || {
        if let Err(e) = std::fs::remove_dir_all(&parked) {
            // Warned, never escalated: the teardown itself already succeeded and the caller has
            // long since returned. What is left is reclaimable disk, and the next teardown's sweep
            // is what reclaims it.
            tracing::warn!(error = %e, "failed to delete a parked worktree checkout; the next teardown will sweep it");
        }
        let Some(trash) = trash else { return };
        let mine = format!("-p{}-", std::process::id());
        if let Ok(entries) = std::fs::read_dir(&trash) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().contains(&mine) {
                    continue; // another teardown in THIS process still owns it
                }
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    });
}

/// Remove a checkout the way this path always has: hand the whole thing to git and let it walk the
/// tree. Kept as the fallback for when a checkout cannot be parked (see `evacuate_checkout`).
///
/// MUST be called with the per-project git lock held — it mutates git's admin records.
fn remove_via_git(root: &str, wt: &Path, wt_str: &str) -> Result<(), String> {
    match git(root, &["worktree", "remove", "--force", wt_str]) {
        // Success is NOT proof the dir is gone. For a path git no longer recognizes as a
        // worktree it exits 0 having deleted nothing, so a "clean" teardown can still leak the
        // orphaned dir. Only an absent dir ends the removal; anything left goes through cleanup.
        Ok(_) if !wt.exists() => Ok(()),
        Ok(_) => discard_half_deleted_worktree(root, wt),
        Err(e) => {
            if removal_error_is_recoverable(&e.to_lowercase(), wt.exists()) {
                discard_half_deleted_worktree(root, wt)
            } else {
                Err(e)
            }
        }
    }
}

/// Core (AppHandle-free, testable): remove an agent's external worktree (force, to discard
/// any uncommitted changes). The branch is intentionally left in place so reopening the agent
/// can resume it. Idempotent: a missing worktree is not an error.
pub fn remove_worktree_at(
    root: &str,
    project_id: &str,
    agent_id: &str,
    app_data: &Path,
) -> Result<(), String> {
    let wt = worktree_path(app_data, project_id, agent_id)?;
    let wt_str = wt.to_string_lossy().to_string();
    // Evict this worktree's batch-poll status fingerprint (keyed by worktree path). Otherwise the
    // entry lingers for the app's lifetime for a removed agent — and if a future agent ever reused
    // the same path, a stale fingerprint could wrongly skip its first real recompute.
    if let Ok(mut cache) = status_cache().lock() {
        cache.remove(&wt_str);
    }
    // Evict the PR-probe clock alongside the fingerprint so a reused worktree path re-probes
    // immediately on its first tick (sparkle-prpb).
    if let Ok(mut cache) = pr_probe_cache().lock() {
        cache.remove(&wt_str);
    }
    // Serialize with the repo's other index/ref-mutating worktree ops — the case this lock's own
    // doc comment lists as "remove", but which this path never actually took.
    //
    // Closing ONE agent fans teardown out to EVERY open window, so N windows issue N concurrent
    // `git worktree remove --force` against the same path. The frontend's `withRepoLock` cannot
    // help: `repoLocks` is a module-level Map in the webview bundle, so each window has its own
    // independent chain and they serialize only against themselves. The backend is the only place
    // that can order these. Unserialized they race — the winner unlinks the checkout's `.git`, and
    // a loser past its own existence check dies on `validation failed, cannot remove working tree`
    // for a removal that in fact succeeded. `git` never re-acquires this lock, so it cannot nest.
    // The guard is held across the whole removal — including the half-deleted-checkout recovery
    // below — so the recovery's own prune/delete is serialized against a concurrent add too.
    let gl = repo_git_lock(root);
    let parked = {
        // Timed because the command's own duration clock starts before this point — see
        // [`log_repo_lock_wait`] for why separating the two is what makes the number actionable.
        let lock_since = std::time::Instant::now();
        let _g = gl.lock().unwrap_or_else(|e| e.into_inner());
        log_repo_lock_wait("remove_agent_worktree", lock_since.elapsed());
        // The expensive half of a teardown is walking the checkout to delete it, and since
        // dependencies started being installed into every fresh worktree that walk has a populated
        // `node_modules` in it. Measured on this path: 11–31s per removal, ALL of it with this lock
        // held — so every prepare and every other remove queued behind it on the same project waits
        // that long too, which is what `log_worktree_op_duration` had started reporting.
        //
        // A rename is O(1), and the only thing the lock actually needs is for the checkout to be
        // GONE from its worktree path. So park it first, let `prune` retire the admin record — it
        // acts on precisely the state a rename produces, a record whose checkout is missing, which
        // is the same reordering `discard_half_deleted_worktree` already relies on — and do the
        // delete after the lock is released.
        match evacuate_checkout(
            &wt,
            &removal_trash_dir(app_data),
            &trash_tag(project_id, agent_id),
        ) {
            // Nothing moved (already gone, or the rename failed) — remove it the old way, which is
            // still correct, just as slow as before.
            None => return remove_via_git(root, &wt, &wt_str),
            Some(parked) => {
                if let Err(e) = git(root, &["worktree", "prune"]) {
                    // Not escalated, for the same reason `discard_half_deleted_worktree` does not:
                    // the checkout is already gone, and a surviving record is repairable by any
                    // later `git worktree prune`. Logged because a branch left claimed is otherwise
                    // indistinguishable from a clean teardown.
                    tracing::warn!(error = %e, "worktree prune failed after parking a checkout for deletion; a stale admin record may still claim the branch");
                }
                parked
            }
        }
    };
    // Lock released. The multi-second delete now stalls nothing.
    delete_parked_checkout(parked);
    Ok(())
}

/// Does a lowercased `git worktree remove --force` failure describe a checkout that our own
/// cleanup can finish, rather than a reason to give up and report the error?
///
/// Everything here shares one property: **re-running the same command cannot converge.** Git has
/// already stopped recognizing the path as a removable worktree, so each retry reproduces the
/// identical failure, and the caller — which retries on error — spins. That is not hypothetical:
/// the un-matched case below produced bursts of the same warning, several within a single
/// hundred milliseconds, repeating for minutes against one path.
///
/// `checkout_remains` is `wt.exists()`, read after the failure. Only the last branch needs it.
fn removal_error_is_recoverable(lower: &str, checkout_remains: bool) -> bool {
    // Already gone, or never a worktree — removal is idempotent.
    lower.contains("not a working tree")
        || lower.contains("is not a working tree")
        || lower.contains("no such file or directory")
        // A checkout whose own `.git` link file is broken, phrased as
        // `validation failed, cannot remove working tree: '<path>/.git' <reason>`.
        || (lower.contains("validation failed") && broken_git_link_reason(lower))
        // `failed to delete '<path>': Directory not empty` — git unlinked the tree bottom-up and
        // then could not rmdir, because something landed in a directory it had already emptied
        // (a tool still writing, a package manager finishing an install, the OS dropping a
        // metadata file). Git aborts having already destroyed most of the checkout, so what is
        // left IS a half-deleted worktree, and the one thing it will never be again is a valid
        // one. `remove_dir_all` deletes a non-empty directory, so the recovery finishes exactly
        // the step git gave up on — where a retry only re-walks the tree git already deleted and
        // re-hits the same rmdir, forever.
        //
        // Anchored on BOTH halves of the phrase, and gated on the checkout still being there.
        // `git worktree remove` deletes two things and uses this same wording for both: after
        // the checkout it removes the admin dir under the git common dir, and an ENOTEMPTY
        // *there* means the opposite of a leak we can finish. The recovery's `remove_dir_all`
        // would no-op, `prune` would hit the same ENOTEMPTY and only warn, and we would return
        // Ok while the record still claims the agent's branch.
        //
        // `checkout_remains` separates them exactly, and is the only signal that does. Which
        // path git names in the message cannot be matched reliably from here: matching the
        // worktree path positively fails open because git prints the path it RESOLVED and ours
        // is not canonicalized (on macOS a `/var/...` path is stored as `/private/var/...`),
        // and excluding the admin path fails open on any layout where it isn't `<root>/.git`
        // — a submodule (`.git/modules/<name>/worktrees/`), a bare repo, `--separate-git-dir`.
        // Both would also be scanning the whole multi-line stderr blob rather than the failing
        // line. Existence is a fact about the one directory we care about, needs no parsing,
        // and holds under every layout.
        || (checkout_remains
            && lower.contains("failed to delete")
            && lower.contains("directory not empty"))
}

/// Does a lowercased `validation failed` message blame the checkout's own `.git` link file?
///
/// Git's worktree validation rejects a broken link with one of three reasons, and it reaches for
/// a different one depending on HOW the link broke: the file is gone, it survives as something
/// that isn't a gitfile (truncated, or replaced by a real dir), or it still parses but points at
/// an admin record that no longer names it back. All three describe the same half-deleted
/// checkout and leak the same way, so all three route to the same cleanup.
///
/// Matching only the first reason is what let the other two escape: they carry no `does not
/// exist`, so they fell through to `Err` and teardown never converged.
fn broken_git_link_reason(lower: &str) -> bool {
    lower.contains("does not exist")
        || lower.contains("is not a .git file")
        || lower.contains("does not point back to")
}

/// Finish tearing down a worktree that `git worktree remove` won't handle because its checkout
/// is already broken — the dir's `.git` link file is missing, or git no longer recognizes the
/// path as a worktree at all.
///
/// Both shapes leave the SAME leak, and neither converges on retry: git either errors out
/// ("validation failed") or reports success while deleting nothing, so the admin record in
/// `.git/worktrees/` keeps the agent's branch claimed and the orphaned dir keeps its disk for
/// the life of the repo. Prune the record and delete the remains ourselves.
///
/// Idempotent: a worktree that is genuinely gone leaves nothing to prune or delete, which is
/// what makes repeat teardowns of an already-removed agent a no-op rather than an error.
fn discard_half_deleted_worktree(root: &str, wt: &Path) -> Result<(), String> {
    // Delete BEFORE pruning. `prune` drops only those records whose checkout is already missing,
    // so pruning first leaves the record standing for any break that keeps a `.git` entry on disk
    // — a corrupt link file reads as present enough for prune to keep it. Deleting the dir first
    // makes the checkout unambiguously missing, which is the one state prune acts on, so a single
    // pass clears both halves for every break instead of just the ones that erased `.git`.
    if wt.exists() {
        std::fs::remove_dir_all(wt)
            .map_err(|io| format!("couldn't remove half-deleted worktree: {io}"))?;
    }
    // `prune` is repo-wide by design. Deleting `.git/worktrees/<id>` by hand would scope it to
    // this agent, but that means hand-editing git's admin store — a worse trade than the blast
    // radius, which is small: prune only drops records whose checkout is ALREADY missing, and a
    // record dropped from a worktree that later comes back is rebuilt by `git worktree repair`.
    //
    // A prune failure is not escalated: the disk is already reclaimed, and the surviving record
    // is repairable (the next teardown or any `git worktree prune` clears it), so failing here
    // would turn a recovered teardown back into the error the caller retries forever. But since
    // the reorder above makes prune the last step that can silently leave the record standing,
    // log it — a branch that stays claimed is otherwise indistinguishable from a clean teardown.
    if let Err(e) = git(root, &["worktree", "prune"]) {
        tracing::warn!(error = %e, "worktree prune failed after discarding a half-deleted checkout; a stale admin record may still claim the branch");
    }
    Ok(())
}

/// Remove an agent's worktree (force, to discard any uncommitted changes). The
/// branch is intentionally left in place so reopening the agent can resume it.
/// Idempotent: a missing worktree is not an error.
///
/// `async` + `spawn_blocking` so the slow part (`git worktree remove --force`,
/// which deletes the whole worktree dir from disk) runs on the blocking thread
/// pool instead of the main thread. A synchronous command would block the event
/// loop and freeze the window for the seconds-to-tens-of-seconds the deletion can
/// take. That range used to be documented as 2–10s; it grew once dependencies
/// started being installed into every fresh worktree, because the deletion now has
/// a fully populated `node_modules` to walk. Off the main thread the window stays
/// responsive, but the per-root git lock is still held, so the next prepare on the
/// same project waits — which is why the duration is now logged (see
/// [`log_worktree_op_duration`]).
#[tauri::command]
pub async fn remove_agent_worktree(
    app: AppHandle,
    root: String,
    project_id: String,
    agent_id: String,
) -> Result<(), String> {
    tracing::info!(%root, %project_id, %agent_id, "remove_agent_worktree");
    let app_data = app_data_dir(&app)?;
    let started = std::time::Instant::now();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        remove_worktree_at(&root, &project_id, &agent_id, &app_data)
    })
    .await
    .map_err(|e| format!("worktree removal task failed: {e}"))?;
    log_worktree_op_duration("remove_agent_worktree", started.elapsed(), outcome.is_ok());
    outcome
}

/// Move/rename a project folder on disk (rename = move within the same parent), then
/// repair the git worktree links so the per-agent worktrees keep working at the new
/// location. Caller must stop the project's agents first (their PTYs hold the old cwd).
/// Sync core of [`move_project`]; a plain fn so the async command can offload it via
/// `spawn_blocking` and the test suite can drive it directly.
fn move_project_inner(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);
    if old_path == new_path {
        return Ok(());
    }
    if !old.exists() {
        return Err(format!("the project folder no longer exists at {old_path}"));
    }
    if new.exists() {
        return Err(format!("a folder already exists at {}", new.display()));
    }
    if let Some(parent) = new.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("couldn't create destination: {e}"))?;
    }
    // std::fs::rename works within a volume; across volumes it returns EXDEV.
    std::fs::rename(old, new).map_err(|e| {
        format!("couldn't move the folder (moving across disks isn't supported yet): {e}")
    })?;
    // The repo moved; its per-agent worktrees live OUTSIDE the repo (in app-data) so a bare
    // `worktree repair` from the repo can't discover them. Collect their paths from the repo's
    // admin records and repair them explicitly (repairs both directions of the link).
    if git(&new_path, &["rev-parse", "--git-dir"]).is_ok() {
        let list = git(&new_path, &["worktree", "list", "--porcelain"]).unwrap_or_default();
        let wt_paths: Vec<String> = list
            .lines()
            .filter_map(|l| l.strip_prefix("worktree ").map(|s| s.to_string()))
            .collect();
        let mut args: Vec<&str> = vec!["worktree", "repair"];
        for p in &wt_paths {
            args.push(p);
        }
        let _ = git(&new_path, &args);
    }
    Ok(())
}

/// Move/rename a project folder on disk, then repair its worktree links. `async` + `spawn_blocking`
/// so the `std::fs::rename` (cross-dir) and `git worktree repair` subprocesses can't stall the UI.
#[tauri::command]
pub async fn move_project(old_path: String, new_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || move_project_inner(old_path, new_path))
        .await
        .map_err(|e| format!("move_project task failed: {e}"))?
}

/// Tripwire: confirm a worktree path's git toplevel IS that worktree — i.e. it can't resolve
/// up into a parent checkout. Called before spawning an agent's PTY.
/// Sync core of [`assert_workspace_integrity`]; a plain fn so the async command can offload it via
/// `spawn_blocking` and the test suite can drive it directly.
fn assert_workspace_integrity_inner(worktree: String) -> Result<(), String> {
    let canon_wt = std::fs::canonicalize(&worktree)
        .map_err(|e| format!("worktree path does not exist: {e}"))?;
    let toplevel = git(&worktree, &["rev-parse", "--show-toplevel"])
        .map_err(|e| format!("not a git worktree: {e}"))?;
    let canon_top = std::fs::canonicalize(&toplevel)
        .map_err(|e| format!("cannot resolve toplevel: {e}"))?;
    if canon_top == canon_wt {
        Ok(())
    } else {
        Err(format!(
            "workspace isolation broken: git toplevel is {} but the worktree is {}",
            canon_top.display(), canon_wt.display()
        ))
    }
}

/// Confirm a worktree path's git toplevel IS that worktree (isolation tripwire, run before spawning
/// an agent's PTY). `async` + `spawn_blocking` so the `canonicalize` + `git rev-parse` never stall
/// the UI thread.
#[tauri::command]
pub async fn assert_workspace_integrity(worktree: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || assert_workspace_integrity_inner(worktree))
        .await
        .map_err(|e| format!("assert_workspace_integrity task failed: {e}"))?
}

/// Tools that Sparkle pre-approves in every worktree's `.claude/settings.local.json` so
/// interactive agents (Think/Build/generic) stop prompting for them. Two buckets:
///   1. Sparkle's OWN control-plane MCP servers — the app driving itself should never ask the
///      human for permission (that's the friction shown in the set_agent_activity prompt). A bare
///      `mcp__<server>` rule allows every tool the server exposes.
///   2. Read-only operations agents perform constantly — reading files, searching, fetching the
///      web, and *reading* browser state. Nothing here mutates the world.
/// Deliberately EXCLUDED (still prompt on interactive agents): Bash, Edit, Write, MultiEdit,
/// NotebookEdit, and any browser tool that acts (navigate/computer/form_input). Workers already
/// run with `--dangerously-skip-permissions`, so for them this list is a harmless no-op.
const SPARKLE_ALLOWED_TOOLS: &[&str] = &[
    // Sparkle's own control plane.
    "mcp__sparkle-control",
    "mcp__sparkle-orchestrator",
    // Read-only built-ins.
    "Read",
    "Grep",
    "Glob",
    "WebFetch",
    "WebSearch",
    // Read-only browser inspection (claude-in-chrome), for non-strict agents that load it.
    "mcp__claude-in-chrome__read_page",
    "mcp__claude-in-chrome__get_page_text",
    "mcp__claude-in-chrome__read_console_messages",
    "mcp__claude-in-chrome__read_network_requests",
    "mcp__claude-in-chrome__tabs_context_mcp",
];

/// Merge Sparkle's pre-approved allowlist into `permissions.allow`, preserving any rules the user
/// already added and de-duplicating by rule string (idempotent across re-runs).
fn merge_allowed_tools(root: &mut Value) {
    let obj = root.as_object_mut().unwrap();
    let permissions = obj.entry("permissions").or_insert_with(|| json!({}));
    if !permissions.is_object() {
        *permissions = json!({});
    }
    let allow = permissions
        .as_object_mut()
        .unwrap()
        .entry("allow")
        .or_insert_with(|| json!([]));
    if !allow.is_array() {
        *allow = json!([]);
    }
    let arr = allow.as_array_mut().unwrap();
    for tool in SPARKLE_ALLOWED_TOOLS {
        let already = arr.iter().any(|e| e.as_str() == Some(*tool));
        if !already {
            arr.push(json!(tool));
        }
    }
}

/// Merge the PreToolUse guard hook into existing settings JSON (or a fresh object), preserving
/// any keys the user already has.
pub fn merge_guard_settings(existing: Option<&str>, guard_cmd: &str) -> String {
    let mut root: Value = existing
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    // Bash is included so the guard also sees shell commands: it blocks a `security`-CLI invocation
    // against the ai.sparkle.desktop keychain (sparkle-0ezz) in addition to its Edit/Write file-path
    // containment. The guard script exits 0 for any Bash command that isn't the keychain pattern.
    let hook_entry = json!({
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": guard_cmd } ]
    });
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let pre = hooks
        .as_object_mut()
        .unwrap()
        .entry("PreToolUse")
        .or_insert_with(|| json!([]));
    if !pre.is_array() {
        *pre = json!([]);
    }
    // Replace any prior Sparkle guard, then push the current one (idempotent).
    let arr = pre.as_array_mut().unwrap();
    arr.retain(|e| {
        !e.get("hooks")
            .and_then(|h| h.get(0))
            .and_then(|h| h.get("command"))
            .and_then(|c| c.as_str())
            .map(|c| c.contains("worktree-guard.mjs"))
            .unwrap_or(false)
    });
    arr.push(hook_entry);
    // Pre-approve Sparkle's own MCP tools + read-only ops so interactive agents stop prompting.
    merge_allowed_tools(&mut root);
    serde_json::to_string_pretty(&root).unwrap()
}

/// Write/merge the guard into `<worktree>/.claude/settings.local.json` (the gitignored variant).
#[tauri::command]
pub async fn install_worktree_guard(app: AppHandle, worktree: String) -> Result<(), String> {
    // `async` + `spawn_blocking`: the resource staging (fs copy into app-data) and the
    // settings.local.json read/merge/write are IO that must not stall the UI thread. AppHandle is
    // Send + Clone, so it moves cleanly onto the blocking task.
    tauri::async_runtime::spawn_blocking(move || {
        // Stage the guard to a stable app-data path (not the app bundle) so the command baked into
        // settings.local.json survives the bundle being renamed/replaced/removed. See
        // hooks::stage_resource_script; hooks::heal_agent_hooks re-points stale copies at launch.
        let guard = crate::hooks::stage_resource_script(&app, "worktree-guard.mjs")?;
        let guard_cmd = format!(
            "node {} {}",
            shell_quote(&guard.to_string_lossy()),
            shell_quote(&worktree)
        );

        let dir = Path::new(&worktree).join(".claude");
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir .claude: {e}"))?;
        let file = dir.join("settings.local.json");
        let existing = std::fs::read_to_string(&file).ok();
        let merged = merge_guard_settings(existing.as_deref(), &guard_cmd);
        std::fs::write(&file, merged).map_err(|e| format!("write settings.local.json: {e}"))
    })
    .await
    .map_err(|e| format!("install_worktree_guard task failed: {e}"))?
}

/// Minimal POSIX single-quote escaping for embedding a path in a hook command string.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Read a worker's `.sparkle/result.json` from its worktree. `Ok(None)` if not yet written.
pub fn read_worker_result_at(worktree: &Path) -> Result<Option<String>, String> {
    let path = worktree.join(".sparkle").join("result.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read worker result: {e}")),
    }
}

#[tauri::command]
pub async fn read_worker_result(worktree: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_worker_result_at(Path::new(&worktree)))
        .await
        .map_err(|e| format!("read_worker_result task failed: {e}"))?
}

// ── Durable per-worktree worker manifest (sparkle-hwfv / a670 / 3xus) ──────────────────────────
//
// A worker's identity + ownership used to live ONLY in the frontend projectStore, which is
// persisted-per-mutation, cross-window synced (last-writer-wins), and rebuilt by reconcile /
// relocation passes that can EVICT a just-added worker AFTER its worktree is cut. When that
// happens the worker is lost from list_workers, spin_down reports "not owned", and the worker
// stalls with no task — needing an app restart. The fix writes an authoritative copy of the
// worker's identity to disk INSIDE its worktree (`.sparkle/worker.json`, sibling of the
// `result.json` read above), so an evicted in-memory record can be re-derived from disk without
// a restart. Mirrors `read_worker_result_at` — same `.sparkle/` dir (gitignored by
// `ensure_project_repo`), same not-found-is-Ok semantics.

/// Path to a worker's durable manifest inside its worktree.
pub fn worker_manifest_path(worktree: &Path) -> PathBuf {
    worktree.join(".sparkle").join("worker.json")
}

/// Write a worker's manifest (`.sparkle/worker.json`) into its worktree, creating `.sparkle/` if
/// needed. Pretty-printed for human inspection. `manifest` is the full identity object the
/// frontend assembled at spawn (`{workerId,buildAgentId,projectId,branch,worktree,task,beadId,
/// createdAt}`). Written BEFORE spawn replies, so the reply can never precede the durable record.
pub fn write_worker_manifest_at(worktree: &Path, manifest: &Value) -> Result<(), String> {
    let sparkle = worktree.join(".sparkle");
    std::fs::create_dir_all(&sparkle).map_err(|e| format!("mkdir .sparkle: {e}"))?;
    let body = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("serialize worker manifest: {e}"))?;
    std::fs::write(worker_manifest_path(worktree), body)
        .map_err(|e| format!("write worker manifest: {e}"))
}

/// Read a worker's manifest from its worktree. `Ok(None)` if absent (a legacy worker cut before
/// manifests existed, or a worktree that was never a worker). Malformed JSON is surfaced as Err.
pub fn read_worker_manifest_at(worktree: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(worker_manifest_path(worktree)) {
        Ok(s) => {
            let v: Value =
                serde_json::from_str(&s).map_err(|e| format!("parse worker manifest: {e}"))?;
            Ok(Some(v))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read worker manifest: {e}")),
    }
}

/// Scan every worktree under `<app_data>/worktrees/<project_id>/` and return the parsed manifest
/// of each one that has a readable `.sparkle/worker.json`. Each returned manifest has its
/// `worktree` field set to the ACTUAL directory found on disk (authoritative, even if the value
/// written at spawn is stale), so the reconcile pass can re-adopt the worker at its real path.
/// Worktrees without a manifest (legacy workers, agent worktrees) or with unparseable JSON are
/// skipped — the scan is a best-effort self-heal, never fatal. A missing worktrees dir -> empty.
pub fn scan_worker_manifests_at(app_data: &Path, project_id: &str) -> Result<Vec<Value>, String> {
    validate_id("project_id", project_id)?;
    let dir = app_data.join("worktrees").join(project_id);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read worktrees dir: {e}")),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let wt = entry.path();
        if !wt.is_dir() {
            continue;
        }
        // Skip unreadable/malformed manifests rather than failing the whole scan.
        let mut v = match read_worker_manifest_at(&wt) {
            Ok(Some(v)) => v,
            _ => continue,
        };
        let Some(obj) = v.as_object_mut() else { continue };
        // Overwrite `worktree` with the real on-disk path — the source of truth for adoption.
        obj.insert(
            "worktree".to_string(),
            Value::String(wt.to_string_lossy().to_string()),
        );
        out.push(v);
    }
    Ok(out)
}

/// Write a worker's durable manifest into its worktree (Tauri command). Called by spawnWorker
/// after the worktree is cut and BEFORE the orchestration reply is assembled (sparkle-hwfv).
#[tauri::command]
pub async fn write_worker_manifest(worktree: String, manifest: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_worker_manifest_at(Path::new(&worktree), &manifest)
    })
    .await
    .map_err(|e| format!("write_worker_manifest task failed: {e}"))?
}

/// Read a single worker's manifest (Tauri command). `Ok(None)` if absent.
#[tauri::command]
pub async fn read_worker_manifest(worktree: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || read_worker_manifest_at(Path::new(&worktree)))
        .await
        .map_err(|e| format!("read_worker_manifest task failed: {e}"))?
}

/// Scan a project's worktrees for worker manifests (Tauri command). Powers the on-disk reconcile
/// pass (sparkle-3xus): the frontend re-adopts any worker whose worktree+manifest survive on disk
/// but whose in-memory store record was evicted.
#[tauri::command]
pub async fn scan_worker_manifests(app: AppHandle, project_id: String) -> Result<Vec<Value>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || scan_worker_manifests_at(&app_data, &project_id))
        .await
        .map_err(|e| format!("scan_worker_manifests task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    //! Engine harness (spec §10): proves the "multiple tabs, never overwriting each
    //! other" guarantee headlessly — N isolated worktrees, each driving its own
    //! concurrent PTY in its own directory. Run with `cargo test`.
    use super::*;
    use std::io::Read;
    use std::sync::mpsc;

    fn unique_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sparkle-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `exited_without_reaping` must report the exit WITHOUT collecting it — the property the
    /// post-exit group kill depends on, and the one a plain `try_wait` breaks.
    ///
    /// Why this matters rather than being pedantic: `try_wait` reaps, which releases the pid and,
    /// once the group is empty, the process-GROUP id with it. The only case the post-exit
    /// `kill_process_group` exists for is a holder that escaped the group — i.e. the group IS empty
    /// and that pgid is prime for reuse — so reaping first can turn `kill(-pid, SIGKILL)` into a
    /// SIGKILL against an unrelated process group on the user's machine. This shipped in v0.44.0.
    ///
    /// The assertion that carries the test is the `wait()` at the end: it can only succeed if the
    /// child was still un-reaped, because a second reap of the same child fails. Swap
    /// `exited_without_reaping` back to `try_wait` and that `wait()` errors — the test fails.
    #[cfg(unix)]
    #[test]
    fn exited_without_reaping_reports_exit_but_leaves_the_child_waitable() {
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 7")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn");
        let pid = child.id();

        // Poll until it reports the exit. Bounded so a hang fails loudly instead of hanging CI.
        let started = Instant::now();
        loop {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "child never reported exit"
            );
            if exited_without_reaping(&mut child).expect("waitid must not error") {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        // THE load-bearing assertion, and it has to go through the OS rather than through `Child`.
        // `Child::wait()` CACHES the status std collected at a reap, so it succeeds either way —
        // a version of this test that asserted on `wait()` passed even with `try_wait` restored,
        // which is to say it tested nothing. `kill(pid, 0)` asks the kernel instead: it succeeds
        // while the pid is still reserved (a zombie is still a process, and still a member of its
        // process group) and fails with ESRCH once the reap has released it. That reservation is
        // the entire property the post-exit `kill(-pid, …)` relies on.
        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) };
        assert_eq!(
            alive,
            0,
            "pid must still be RESERVED after the probe (zombie), else the pgid can be recycled \
             and the post-exit group kill can hit an unrelated group: {}",
            std::io::Error::last_os_error()
        );

        // Now reap for real, and confirm the exit state was never consumed by the probe.
        let status = child.wait().expect("child must still be waitable");
        assert_eq!(status.code(), Some(7), "the real status still comes back");

        // And after the reap the kernel HAS released it — proving the assertion above was
        // discriminating rather than vacuously true for any pid.
        let after = unsafe { libc::kill(pid as libc::pid_t, 0) };
        assert_eq!(after, -1, "pid must be released once actually reaped");
    }

    /// The regression this whole process-group/bounded-drain rework exists for: a child that forks a
    /// GRANDCHILD which outlives it and keeps the inherited stdout/stderr write ends open. Killing
    /// only the direct child leaves the reader blocked in `read` with no EOF, so the old code
    /// returned `timed out` only after the GRANDCHILD's own 30s — with the plugin-install mutex held
    /// the whole time. `/bin/sh` throughout so nothing depends on the developer's own shell.
    #[cfg(unix)]
    #[test]
    fn a_surviving_grandchild_cannot_hold_the_drain_past_the_deadline() {
        let root = unique_root("grandchild-kill");
        let marker = root.join("grandchild-survived");
        // Single-quoted in the script: a TMPDIR containing a space would otherwise make `: >` fail,
        // the marker would never appear, and the "grandchild is dead" assertion below would hold
        // VACUOUSLY. (No `'` can appear in it — `unique_root` builds the name from a literal and a
        // pid — so simple quoting is sufficient here.)
        let marker_arg = format!("'{}'", marker.to_string_lossy());
        // Prove the marker is actually creatable, so a green run means "killed", not "couldn't
        // write". This is the assertion that keeps the real one honest.
        std::fs::write(&marker, "").unwrap();
        std::fs::remove_file(&marker).unwrap();

        let mut cmd = Command::new("/bin/sh");
        // The backgrounded subshell is the GRANDCHILD: it inherits the pipes and, if it survives the
        // kill, touches the marker. `exec sleep 30` is the direct child that hangs past the deadline.
        cmd.arg("-c").arg(format!("(sleep 1; : > {marker_arg}) & exec sleep 30"));
        let started = Instant::now();
        let err = output_with_timeout(cmd, Duration::from_millis(300))
            .expect_err("a hung child must expire, not block");
        assert!(err.contains("timed out"), "expiry should say so: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "must return at the deadline (+ the drain grace), not after the grandchild's own sleep: \
             took {:?}",
            started.elapsed()
        );

        // The timing above is satisfied by the drain grace alone; THIS is what proves the kill
        // actually reached the process GROUP rather than just the direct child.
        std::thread::sleep(Duration::from_millis(1500));
        let survived = marker.exists();
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            !survived,
            "the grandchild outlived the expiry — the kill did not reach the process group"
        );
    }

    /// The OTHER guard, on the path the DEADLINE never runs at all: the child EXITS NORMALLY while a
    /// grandchild keeps the pipes open. This is the live shape for these callers, since git spawns
    /// `ssh` ControlPersist and `git credential-cache--daemon` helpers that outlive it.
    ///
    /// The timeout is deliberately LONG (10s) and the assertion tight (2s): the command exits
    /// immediately, so everything it wrote is already in the pipe and the only thing left to wait on
    /// is the lingering descendant. That wait is `POST_EXIT_SETTLE` + a group kill, NOT the
    /// remaining deadline — with a 300ms timeout and a 5s window, bounding by the full deadline
    /// would have passed just as well, which is the whole distinction being pinned.
    #[cfg(unix)]
    #[test]
    fn a_cleanly_exited_child_cannot_hang_the_call_by_leaving_a_grandchild_on_the_pipes() {
        let root = unique_root("pgroup-success");
        let pidfile = root.join("grandchild.pid");
        // The direct child is gone in milliseconds, but the backgrounded `sleep` holds the inherited
        // pipes for 30s.
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(format!(
            "echo started; sh -c 'echo $$ > {}; sleep 30' & exit 0",
            pidfile.display()
        ));
        let started = Instant::now();
        let out = output_with_timeout(cmd, Duration::from_secs(10))
            .expect("the command SUCCEEDED — a lingering descendant must not turn that into an error");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the post-exit drain must be bounded by the settle + kill, not by the remaining \
             deadline; took {:?}",
            started.elapsed()
        );
        // The output survives the bounding: killing the group is what closes the pipe, which is what
        // lets the reader reach EOF. Cutting the wait must not cost us the bytes.
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "started");

        // And the grandchild is actually GONE — the elapsed-time assertion alone would also pass if
        // we had simply stopped waiting and left it running (which is what abandoning the drain did,
        // at the cost of the bytes, a reader thread and a pipe fd for the holder's whole life).
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .expect("the grandchild should have written its pid")
            .trim()
            .parse()
            .expect("pid");
        let mut alive = true;
        for _ in 0..40 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                alive = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = std::fs::remove_dir_all(&root);
        assert!(!alive, "the group kill must have taken the grandchild (pid {pid}) with it");
    }

    /// The SAME shape through the lenient form. The child exited 0 and its operation already
    /// happened, so a mutating caller (`gh pr merge`, `claude plugin install`) must not be told
    /// anything went wrong — and once the group kill releases the pipe there is nothing wrong to
    /// tell: the capture is COMPLETE and carries no truncation note.
    #[cfg(unix)]
    #[test]
    fn a_grandchild_holding_the_pipes_open_is_released_not_reported_as_truncation() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("echo started; sleep 30 &");
        let started = Instant::now();
        let captured =
            output_with_timeout_lenient(cmd, Duration::from_secs(30)).expect("lenient returns Ok");

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(captured.output.status.success(), "the child itself exited 0");
        assert_eq!(String::from_utf8_lossy(&captured.output.stdout).trim(), "started");
        assert!(captured.drain_complete, "the kill released the pipe, so the capture is whole");
        assert_eq!(captured.truncation_note(), "", "nothing was lost, so say nothing");
    }

    /// Past [`DRAIN_BUF_CAP`] the drain keeps READING (so the child never blocks on a full pipe)
    /// but stops retaining — and that loss must be reported. Dropping bytes while `drain_complete`
    /// stayed true handed the strict form a plausible prefix with a successful status, which is
    /// precisely what the strict form exists to prevent.
    #[cfg(unix)]
    #[test]
    fn output_past_the_capture_cap_is_reported_not_silently_dropped() {
        let lines = (DRAIN_BUF_CAP / 1001) + 200; // comfortably past the cap
        let script = format!("i=0; while [ $i -lt {lines} ]; do printf '%01000d\\n' 0; i=$((i+1)); done");

        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(&script);
        let captured =
            output_with_timeout_lenient(cmd, Duration::from_secs(30)).expect("the child runs");
        assert!(captured.output.status.success(), "the child is not blocked by the cap");
        assert!(captured.stdout_capped, "the cap must be recorded, on the stream that hit it");
        assert!(!captured.stderr_capped, "stderr wrote nothing and is whole");
        assert!(!captured.drain_complete, "capped output is not a complete capture");
        assert!(captured.output.stdout.len() <= DRAIN_BUF_CAP + 8192, "retention is bounded");
        assert_eq!(
            captured.truncation_note(),
            "",
            "a message built from stderr is intact when only stdout overran"
        );

        // And the strict form refuses it rather than handing back the prefix.
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(&script);
        let err = output_with_timeout(cmd, Duration::from_secs(30))
            .expect_err("a prefix must not read as the whole output");
        assert!(err.contains("capture cap"), "the error must name the cap: {err}");
    }

    /// The half the note exists for: a chatty FAILING command whose reason is on stderr. What
    /// survives must be the TAIL — the reason is the last thing written — and the note must say so.
    #[cfg(unix)]
    #[test]
    fn a_capped_stderr_keeps_the_tail_and_says_the_message_may_be_short() {
        let lines = (DRAIN_BUF_CAP / 1001) + 200;
        let script = format!(
            "i=0; while [ $i -lt {lines} ]; do printf '%01000d\\n' 0 >&2; i=$((i+1)); done; \
             echo 'THE ACTUAL REASON' >&2; exit 1"
        );
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(&script);
        let captured =
            output_with_timeout_lenient(cmd, Duration::from_secs(30)).expect("the child runs");

        assert!(!captured.output.status.success());
        assert!(captured.stderr_capped, "stderr hit the cap");
        assert!(!captured.stdout_capped, "stdout wrote nothing");
        assert!(!captured.drain_complete);
        assert!(captured.output.stderr.len() <= DRAIN_BUF_CAP + 8192, "retention is bounded");
        assert!(
            String::from_utf8_lossy(&captured.output.stderr).contains("THE ACTUAL REASON"),
            "the TAIL survives — keeping the head would drop exactly the line that explains the failure"
        );
        assert!(
            captured.truncation_note().contains("too large"),
            "and the caller's message says the earlier lines are gone: {}",
            captured.truncation_note()
        );
    }

    /// A clean capture must add nothing, or every healthy error message grows a scary clause.
    #[test]
    fn a_clean_capture_has_no_truncation_note() {
        // A fresh `Captured` per case: `output` isn't Copy, so a struct-update from one binding
        // can only be used once.
        let with = |f: fn(&mut Captured)| {
            let mut c = Captured {
                output: std::process::Output {
                    status: Default::default(),
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                },
                drain_complete: true,
                pipes_held: false,
                stdout_capped: false,
                stderr_capped: false,
                stdout_read_error: false,
                stderr_read_error: false,
            };
            f(&mut c);
            c
        };

        assert_eq!(with(|_| {}).truncation_note(), "");

        // A mid-read failure on STDERR gets its own words: no cap size would have prevented it.
        let errored = with(|c| {
            c.drain_complete = false;
            c.stderr_read_error = true;
        });
        assert!(errored.truncation_note().contains("errored mid-read"));

        // The note describes what happened to STDERR, which is what both callers build their
        // message from. A stdout-only problem must not put words in that message...
        let stdout_only = with(|c| {
            c.drain_complete = false;
            c.stdout_capped = true;
            c.stdout_read_error = true;
        });
        assert_eq!(stdout_only.truncation_note(), "", "stderr is whole; say nothing about it");

        // ...and a stdout problem must not SHADOW a real stderr one.
        let both = with(|c| {
            c.drain_complete = false;
            c.stdout_read_error = true;
            c.stderr_capped = true;
        });
        assert!(both.truncation_note().contains("too large"), "the accurate stderr wording wins");

        // A held pipe still gets its clause even when stdout also overran — the case that
        // previously fell through to "" while stderr really could be short.
        let held_and_capped = with(|c| {
            c.drain_complete = false;
            c.pipes_held = true;
            c.stdout_capped = true;
        });
        assert!(held_and_capped.truncation_note().contains("held the pipes open"));
    }

    /// Once the caller has taken the buffer, an abandoned thread must stop retaining: the bytes are
    /// unreachable, and these captures run on ~30s polls against pipe-holders that live for hours.
    #[cfg(unix)]
    #[test]
    fn an_abandoned_drain_stops_retaining_after_its_buffer_is_taken() {
        let (drain, handle) = spawn_drain(Some(std::io::Cursor::new(vec![b'x'; 4096])));
        // Take it before the thread necessarily finishes; either way `abandoned` is now set.
        let _first = take_drained(&drain);
        let _ = handle.join();

        assert!(drain.abandoned.load(Ordering::Acquire), "take_drained gives up on the buffer");
        assert!(
            drain.buf.lock().unwrap().is_empty(),
            "nothing accumulates after the reader has gone"
        );
    }

    /// The `#[cfg(test)]` cap and the "kept whole" fixture are coupled: if the fixture ever grows
    /// past the cap it lands on the capped path and fails as a confusing `expect()`. Pin it here so
    /// the failure names the real cause.
    /// A const assertion, so a fixture or cap change fails at COMPILE time with these words rather
    /// than as a mysterious `expect()` on the capped path. (`assert!` on two consts is a clippy
    /// `assertions_on_constants` warning for exactly that reason — it belongs in a const block.)
    const _: () = assert!(
        DRAIN_BUF_CAP > 200 * 1001 * 2,
        "output_with_timeout_captures_both_streams_in_full writes 200*1001 bytes and must stay well \
         under DRAIN_BUF_CAP"
    );

    /// The chunked shared-buffer drain must still capture a child's full output — including more
    /// than one pipe-buffer's worth, which is what a naive "snapshot whatever we have" would drop.
    #[cfg(unix)]
    #[test]
    fn output_with_timeout_captures_both_streams_in_full() {
        let mut cmd = Command::new("/bin/sh");
        // ~200KB on stdout (well past the 64KB pipe buffer), a marker on stderr, exit 0.
        cmd.arg("-c")
            .arg("i=0; while [ $i -lt 200 ]; do printf '%01000d\\n' 0; i=$((i+1)); done; \
                  echo 'on stderr' >&2");
        let out = output_with_timeout(cmd, Duration::from_secs(20)).expect("a fast child succeeds");
        assert!(out.status.success());
        assert_eq!(out.stdout.len(), 200 * 1001, "every stdout byte must survive the drain");
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "on stderr");
    }

    /// `remove_repo_hooks` deletes ONLY hooks whose contents carry our vendored marker, and never
    /// clobbers a user's own same-named hook. (The `install_repo_hooks` copy path needs an AppHandle
    /// resource resolver, so it's exercised via the app; the safety-critical marker guard is pure.)
    #[test]
    fn remove_repo_hooks_only_deletes_our_marked_hooks() {
        let root = unique_root("roborev-hooks");
        let root_str = root.to_string_lossy().to_string();
        let hooks = root.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();

        // Ours: carries the vendored marker → must be removed.
        let ours = hooks.join("post-commit");
        std::fs::write(&ours, "#!/bin/sh\n# roborev post-commit — seed-owned wrapper\n").unwrap();
        // The user's OWN post-rewrite hook (no marker) → must be preserved.
        let theirs = hooks.join("post-rewrite");
        std::fs::write(&theirs, "#!/bin/sh\necho my own hook\n").unwrap();

        remove_repo_hooks(&root_str).unwrap();

        assert!(!ours.exists(), "our marked post-commit hook should be removed");
        assert!(theirs.exists(), "a user's unmarked post-rewrite hook must be left untouched");

        // Idempotent: a second sweep (nothing of ours left) is a clean no-op.
        remove_repo_hooks(&root_str).unwrap();
        assert!(theirs.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A fixture commit must NOT run the repo's git hooks. On a machine where the review loop is
    /// installed via a global `core.hooksPath` (the layout `AGENTS.md` assumes), every commit this
    /// suite makes in a throwaway repo otherwise enqueues a review against a directory the test is
    /// about to delete — a job that can only fail, dozens per run.
    ///
    /// A REPO-LOCAL `core.hooksPath` stands in for that global one: the isolation is a
    /// `GIT_CONFIG_*` env override, which outranks config at every level, so beating the local
    /// setting is the stronger proof. Both commit shapes are covered — the second is made inside a
    /// LINKED WORKTREE, which is where the flood actually came from, since a hook that filters on
    /// the basename of `--show-toplevel` sees the worktree's arbitrary name and can't recognise it.
    #[cfg(unix)]
    #[test]
    fn a_fixture_commit_does_not_run_the_repos_hooks() {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_root("hook-isolation");
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_str = repo.to_string_lossy().to_string();

        // A hook that leaves a marker file behind if git ever runs it.
        let hooks = root.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let marker = root.join("HOOK_RAN");
        let hook = hooks.join("post-commit");
        std::fs::write(&hook, format!("#!/bin/sh\n: > '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "sparkle-test"],
            vec!["config", "user.name", "sparkle-test"],
            vec!["config", "core.hooksPath", &hooks.to_string_lossy()],
            vec!["commit", "-q", "--allow-empty", "-m", "seed"],
        ] {
            git(&repo_str, &args).unwrap();
        }

        let wt = root.join("wt");
        let wt_str = wt.to_string_lossy().to_string();
        git(&repo_str, &["worktree", "add", "-q", &wt_str, "-b", "side"]).unwrap();
        git(&wt_str, &["commit", "-q", "--allow-empty", "-m", "work"]).unwrap();

        assert!(
            !marker.exists(),
            "a fixture commit ran the repo's post-commit hook — test git invocations must not"
        );

        // Sanity: the hook is genuinely runnable, so the assertion above is about suppression and
        // not about a hook that could never have fired in the first place.
        assert!(Command::new("/bin/sh").arg(&hook).status().unwrap().success());
        assert!(marker.exists(), "the hook does create its marker when actually run");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A linked worktree's `.git` is a gitlink FILE, so the old `<root>/.git/hooks` join produced a
    /// path under a regular file and every install failed with ENOTDIR — roborev review silently
    /// never installed for worktree-rooted projects. `hooks_dir_for` must resolve a worktree to its
    /// parent repo's shared hooks dir, which is where git actually runs hooks from.
    #[test]
    fn hooks_dir_for_resolves_a_worktree_to_the_shared_hooks_dir() {
        let root = unique_root("hooks-dir-worktree");
        let main = root.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let main_str = main.to_string_lossy().to_string();

        // A real repo with one commit, so a worktree can be cut from it.
        for args in [
            vec!["init", "-q"],
            // Identity is required to commit; git does not validate the shape, so keep these
            // free of anything resembling a real address.
            vec!["config", "user.email", "sparkle-test"],
            vec!["config", "user.name", "sparkle-test"],
            vec!["commit", "-q", "--allow-empty", "-m", "seed"],
        ] {
            git(&main_str, &args).unwrap();
        }

        // Normal clone: hooks live in the repo's own .git/hooks.
        assert_eq!(hooks_dir_for(&main_str), main.join(".git").join("hooks"));

        let wt = root.join("wt");
        let wt_str = wt.to_string_lossy().to_string();
        git(&main_str, &["worktree", "add", "-q", &wt_str, "-b", "side"]).unwrap();

        // Precondition: this is the layout that used to break — .git is a file, not a directory.
        assert!(wt.join(".git").is_file(), "a linked worktree's .git must be a gitlink file");

        // The worktree resolves to the SHARED hooks dir, and creating it succeeds (the ENOTDIR fix).
        let resolved = hooks_dir_for(&wt_str);
        assert_eq!(
            std::fs::canonicalize(resolved.parent().unwrap()).unwrap(),
            std::fs::canonicalize(main.join(".git")).unwrap(),
            "worktree hooks must resolve under the parent repo's gitdir"
        );
        std::fs::create_dir_all(&resolved).expect("hooks dir must be creatable (was ENOTDIR)");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The FALLBACK path: when `rev-parse --git-common-dir` can't answer (git missing, or the
    /// gitlink points at an admin dir that's been deleted) the old code went straight to
    /// `<root>/.git/hooks`. On a worktree-rooted project that is a path under a regular file, so
    /// every install re-failed with a bare ENOTDIR and roborev review silently never installed.
    /// `gitfile_common_dir` must read the gitlink itself and land on the shared hooks dir.
    #[test]
    fn gitfile_common_dir_resolves_both_gitlink_shapes_without_git() {
        let root = unique_root("gitfile-common-dir");
        std::fs::create_dir_all(&root).unwrap();

        // A normal clone (.git is a DIRECTORY) has no gitlink to resolve — the caller's own join wins.
        let clone = root.join("clone");
        std::fs::create_dir_all(clone.join(".git")).unwrap();
        assert_eq!(gitfile_common_dir(&clone.to_string_lossy()), None);

        // Linked worktree: gitdir is <common>/worktrees/<name>, so the common dir is two levels up.
        let wt = root.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        let common = root.join("parent").join(".git");
        std::fs::write(wt.join(".git"), format!("gitdir: {}/worktrees/wt\n", common.display()))
            .unwrap();
        assert_eq!(gitfile_common_dir(&wt.to_string_lossy()), Some(common.clone()));

        // Submodule: the gitlink points straight at its own gitdir, which IS the common dir.
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let sub_gitdir = root.join("parent").join(".git").join("modules").join("sub");
        std::fs::write(sub.join(".git"), format!("gitdir: {}\n", sub_gitdir.display())).unwrap();
        assert_eq!(gitfile_common_dir(&sub.to_string_lossy()), Some(sub_gitdir));

        // A relative pointer is re-anchored on the repo root, the way git resolves it.
        let rel = root.join("rel");
        std::fs::create_dir_all(&rel).unwrap();
        std::fs::write(rel.join(".git"), "gitdir: ../parent/.git/worktrees/rel\n").unwrap();
        assert_eq!(
            gitfile_common_dir(&rel.to_string_lossy()),
            Some(rel.join("../parent/.git")),
        );

        // A gitlink with no parsable pointer must not invent a directory.
        let junk = root.join("junk");
        std::fs::create_dir_all(&junk).unwrap();
        std::fs::write(junk.join(".git"), "not a gitlink\n").unwrap();
        assert_eq!(gitfile_common_dir(&junk.to_string_lossy()), None);

        // End to end: the worktree case now resolves to a CREATABLE hooks dir. `rev-parse` fails
        // here (the admin dir was never created), so this exercises the fallback, not the git path.
        let resolved = hooks_dir_for(&wt.to_string_lossy());
        assert_eq!(resolved, common.join("hooks"));
        std::fs::create_dir_all(&resolved).expect("fallback hooks dir must be creatable");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The INSTALL-side safety rule (the fix for the clobber regression): we may write our hook only
    /// when there's nothing there, or when the existing file is already ours — never over a user's
    /// own same-named hook. Pure, so it's pinned without the bundle resource resolver.
    #[test]
    fn may_write_hook_never_clobbers_a_foreign_hook() {
        let marker = "seed-owned wrapper"; // the distinctive marker line in the vendored post-commit
        // Absent → safe to install.
        assert!(may_write_hook(false, None, marker), "no existing hook → safe to install");
        // Present + readable + ours → safe to refresh.
        assert!(
            may_write_hook(true, Some("#!/bin/sh\n# roborev post-commit — seed-owned wrapper\n"), marker),
            "our own hook → safe to refresh"
        );
        // Present + readable + foreign → preserve.
        assert!(
            !may_write_hook(true, Some("#!/bin/sh\necho my own precommit\n"), marker),
            "a user's foreign hook → must NOT be overwritten"
        );
        // Present + readable + merely MENTIONS roborev in a comment (but not our marker) → foreign.
        assert!(
            !may_write_hook(true, Some("#!/bin/sh\n# I run roborev post-commit myself\ntrue\n"), marker),
            "a foreign hook that only mentions roborev → must NOT be misclassified as ours"
        );
        // Present but UNREADABLE (binary hook / permission error → contents None) → foreign, preserve.
        // This is the key regression: `exists=true, contents=None` must NOT be treated as absent.
        assert!(
            !may_write_hook(true, None, marker),
            "a present-but-unreadable (binary/perm) hook → must NOT be overwritten"
        );
        // Empty-but-present foreign file is still foreign.
        assert!(!may_write_hook(true, Some(""), marker));
    }

    /// The warning is only actionable if it says which SCOPE set `core.hooksPath`, and the scope
    /// must be read out of `--show-scope`'s `<scope>\t<value>` WITHOUT the value coming with it —
    /// that value is a path in the user's own repository. Every unrecognised shape has to collapse
    /// to `"unknown"`, because the alternative on this path is echoing content.
    #[test]
    fn hooks_path_scope_reads_the_token_and_never_the_value() {
        // The real shapes: scope, a tab, then the configured path.
        assert_eq!(hooks_path_scope("global\t/Users/someone/.config/git/hooks"), "global");
        assert_eq!(hooks_path_scope("local\t.githooks"), "local");
        assert_eq!(hooks_path_scope("system\t/etc/githooks"), "system");
        assert_eq!(hooks_path_scope("worktree\t.git/hooks"), "worktree");
        assert_eq!(hooks_path_scope("command\t/tmp/h"), "command");

        // `git` trims its output, so a trailing newline (and a stray space) must still resolve.
        assert_eq!(hooks_path_scope("global\t/x/y\n"), "global");
        assert_eq!(hooks_path_scope(" global \t/x/y"), "global");

        // Anything else is `unknown` — never a passthrough. A git too old for `--show-scope` prints
        // the bare value, which is precisely the string that must NOT be reported.
        assert_eq!(hooks_path_scope("/Users/someone/.config/git/hooks"), "unknown");
        assert_eq!(hooks_path_scope(""), "unknown");
        assert_eq!(hooks_path_scope("\t/x/y"), "unknown");
        assert_eq!(hooks_path_scope("GLOBAL\t/x/y"), "unknown", "scope tokens are lowercase");

        // The returned token is 'static and from the fixed vocabulary, so no caller can smuggle a
        // borrowed slice of the input out of here.
        for raw in ["global\t/secret/path", "/secret/path", "nonsense"] {
            let scope = hooks_path_scope(raw);
            assert!(
                ["system", "global", "local", "worktree", "command", "unknown"].contains(&scope),
                "scope {scope:?} escaped the vocabulary"
            );
            assert!(!scope.contains('/'), "scope {scope:?} carried part of the value");
        }
    }

    /// The `dirty` decline's diagnostic must tell an unfinished EDIT apart from untracked residue —
    /// they want opposite fixes — while never naming a file, because this runs over user repos too.
    #[test]
    fn blocking_dirt_summarises_by_code_and_never_leaks_a_path() {
        // A leftover edit from a pass that died before committing: all tracked modifications.
        let edits = " M apps/desktop/src/services/improvementPass.ts\n M PRD/topic.md\n";
        assert_eq!(describe_blocking_dirt(edits), "2 entries: 2×' M'");

        // Untracked residue: nothing a restore could ever undo, so it reads differently.
        assert_eq!(describe_blocking_dirt("?? scratch.log\n"), "1 entries: 1×'??'");

        // Mixed trees keep every class visible rather than collapsing to the loudest one. The
        // breakdown is sorted by code (BTreeMap), so the same tree always renders the same string —
        // which is what makes these lines greppable across sessions.
        let mixed = "?? scratch.log\n M src/a.rs\nM  src/b.rs\n";
        assert_eq!(describe_blocking_dirt(mixed), "3 entries: 1×' M' 1×'??' 1×'M '");

        // No filename from any of the above may reach the log line.
        for sample in [edits, "?? scratch.log\n", mixed] {
            let out = describe_blocking_dirt(sample);
            for token in ["improvementPass", "PRD", "scratch", "src/", ".ts", ".rs"] {
                assert!(!out.contains(token), "summary leaked {token:?}: {out}");
            }
        }

        // `git` trims its output, so the FIRST line arrives with its leading space eaten — the same
        // shape `split_status_line` exists to re-pad. A one-file status is the common case here.
        assert_eq!(describe_blocking_dirt("M src/a.rs\n"), "1 entries: 1×' M'");

        // An unparsable line is COUNTED, not dropped: the total must never understate the tree.
        let garbled = "M src/a.rs\nxx\n";
        assert!(
            describe_blocking_dirt(garbled).starts_with("2 entries:"),
            "a garbled line must still be counted: {}",
            describe_blocking_dirt(garbled)
        );

        // Blank lines are not entries, and a clean tree never reaches this path but must not panic.
        assert_eq!(describe_blocking_dirt("\n\n"), "0 entries");
        assert_eq!(describe_blocking_dirt(""), "0 entries");
    }

    /// `core.hooksPath` is frequently set GLOBALLY, which silently redirects git away from the
    /// gitdir we install into: the install succeeds, the hooks never run, and roborev appears
    /// enabled while reviewing nothing. `hooks_are_inert` is what turns that silent no-op into a
    /// warning, so it must not cry wolf on the ordinary unset case, nor on a differently-spelled
    /// path that names the very directory we installed into.
    #[test]
    fn hooks_are_inert_only_when_git_reads_from_somewhere_else() {
        let tmp = std::env::temp_dir().join(format!("sparkle-hookspath-{}", std::process::id()));
        let installed = tmp.join(".git").join("hooks");
        std::fs::create_dir_all(&installed).expect("create installed hooks dir");
        let root = tmp.to_string_lossy().to_string();

        // Unset / blank → git reads the gitdir hooks, which is exactly where we installed.
        assert!(!hooks_are_inert(&root, &installed, None), "unset core.hooksPath → effective");
        assert!(!hooks_are_inert(&root, &installed, Some("")), "blank → effective");
        assert!(!hooks_are_inert(&root, &installed, Some("   ")), "whitespace-only → effective");

        // Set to somewhere else entirely (the global-config case seen in the wild) → inert.
        assert!(
            hooks_are_inert(&root, &installed, Some("/somewhere/else/git-hooks")),
            "an absolute core.hooksPath elsewhere → hooks we install never run"
        );

        // A RELATIVE core.hooksPath is resolved by git against the repo root, not the cwd.
        assert!(
            !hooks_are_inert(&root, &installed, Some(".git/hooks")),
            "relative path naming our own hooks dir → effective, must not warn"
        );
        assert!(
            hooks_are_inert(&root, &installed, Some("other-hooks")),
            "relative path naming a different dir → inert"
        );

        // Same directory, noisier spelling — canonicalization must see through it.
        assert!(
            !hooks_are_inert(&root, &installed, Some(".git/./hooks")),
            "a `.`-laden spelling of our own hooks dir → effective, must not warn"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The inert-hooks warning is documented as firing ONCE per repo, but the set it dedupes
    /// against used to be keyed by the `repo_root` string it was handed. This app hands it an agent
    /// WORKTREE on every spawn, and `hooks_dir_for` resolves all of a repo's worktrees to one shared
    /// `--git-common-dir` hooks dir — so each worktree registered as a separate repo and re-fired
    /// the same unactionable ~700-char warning, several within a few seconds of one another during a
    /// spawn burst. Keying on the resolved hooks dir is what makes "once per repo" true: distinct
    /// worktree roots that share a hooks dir must collapse to ONE key, while genuinely different
    /// repos must stay distinct (or the second repo's warning would be swallowed).
    #[test]
    fn hooks_warn_key_is_shared_across_a_repos_worktrees() {
        let tmp = std::env::temp_dir().join(format!("sparkle-hookskey-{}", std::process::id()));
        let shared = tmp.join("repo-a").join(".git").join("hooks");
        let other = tmp.join("repo-b").join(".git").join("hooks");
        std::fs::create_dir_all(&shared).expect("create shared hooks dir");
        std::fs::create_dir_all(&other).expect("create other hooks dir");

        // Every worktree of one repo resolves to the SAME hooks dir → one key, one warning.
        assert_eq!(
            hooks_warn_key(&shared),
            hooks_warn_key(&shared),
            "the same hooks dir must key identically"
        );

        // A noisier spelling of that same dir is still that dir — canonicalized, as `hooks_are_inert`
        // does, so a `..`/`.`-laden worktree path can't sneak a second warning through.
        assert_eq!(
            hooks_warn_key(&shared),
            hooks_warn_key(&tmp.join("repo-a").join(".git").join(".").join("hooks")),
            "a `.`-laden spelling of one hooks dir must not become a second key"
        );

        // Two different repos must NOT collide, or opening the second one would warn about nothing.
        assert_ne!(
            hooks_warn_key(&shared),
            hooks_warn_key(&other),
            "different repos must keep distinct keys"
        );

        // An unresolvable path (configured but never created) still yields a stable key rather than
        // panicking or degrading to a value that collides with a real dir.
        let missing = tmp.join("repo-c").join(".git").join("hooks");
        assert_eq!(hooks_warn_key(&missing), hooks_warn_key(&missing), "stable when unresolvable");
        assert_ne!(hooks_warn_key(&missing), hooks_warn_key(&shared), "and still distinct");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Spawn `sh -c <script>` in a PTY with the given cwd, read stdout to EOF, return it.
    /// Mirrors how the app spawns each agent (portable-pty), so it exercises the real
    /// mechanism behind every tab.
    fn pty_run(cwd: &str, script: &str) -> String {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", script]);
        cmd.cwd(cwd);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave); // so the master sees EOF when the child exits
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let _ = reader.read_to_string(&mut out);
        let status = child.wait().expect("pty child wait");
        assert!(status.success(), "pty child exited non-zero: {status:?}");
        out
    }

    /// Minimal git repo on `main` with one commit, for branch-delete tests.
    fn init_repo(tag: &str) -> String {
        let root = unique_root(tag);
        let r = root.to_str().unwrap().to_string();
        git(&r, &["init", "-q"]).unwrap();
        git(&r, &["config", "user.email", "t@t"]).unwrap();
        git(&r, &["config", "user.name", "t"]).unwrap();
        git(&r, &["commit", "--allow-empty", "-m", "init"]).unwrap();
        git(&r, &["branch", "-M", "main"]).unwrap();
        r
    }

    fn branch_exists(root: &str, branch: &str) -> bool {
        git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
    }

    // Regression: opening a project directory that is an ORPHANED git worktree — a `.git`
    // gitfile pointing at a `.git/worktrees/<name>` admin dir that has since been pruned — used to
    // dead-end with "git init failed: fatal: not a git repository: <gitdir>" because `git init`
    // follows the dangling pointer. ensure_project_repo_inner must recover it into a fresh repo.
    #[test]
    fn ensure_project_repo_recovers_orphaned_worktree() {
        let root = unique_root("orphan-worktree");
        let r = root.to_str().unwrap().to_string();
        // Simulate the survivor: real files plus a `.git` gitfile whose target no longer exists.
        std::fs::write(format!("{r}/keep.txt"), "user data").unwrap();
        let dead_gitdir = format!("{r}/nonexistent/.git/worktrees/gone");
        std::fs::write(format!("{r}/.git"), format!("gitdir: {dead_gitdir}\n")).unwrap();

        // Precondition: this is exactly the state that made `git init` fail.
        assert!(git(&r, &["rev-parse", "--git-dir"]).is_err(), "orphaned worktree must not resolve");
        assert!(git(&r, &["init"]).is_err(), "plain init follows the dead pointer and fails");

        // The fix recovers it into a real standalone repo with a born HEAD.
        ensure_project_repo_inner(r.clone()).expect("orphaned worktree should be recovered");
        assert!(git(&r, &["rev-parse", "HEAD"]).is_ok(), "recovered repo has a born HEAD");
        assert!(Path::new(&r).join(".git").is_dir(), ".git is now a real repo directory");
        assert!(Path::new(&r).join(".git.orphaned").exists(), "dead pointer preserved, not destroyed");
        assert!(Path::new(&r).join("keep.txt").exists(), "user files are untouched");
    }

    // A LIVE worktree (its admin dir still exists) must be left completely alone — the helper only
    // fires after rev-parse fails, but guard against ever disturbing a healthy `.git` gitfile.
    #[test]
    fn clear_dangling_gitfile_leaves_live_worktree_alone() {
        let root = unique_root("live-worktree");
        let r = root.to_str().unwrap().to_string();
        let live_gitdir = format!("{r}/real-admin-dir");
        std::fs::create_dir_all(&live_gitdir).unwrap();
        std::fs::write(format!("{r}/.git"), format!("gitdir: {live_gitdir}\n")).unwrap();

        clear_dangling_gitfile(&r);
        assert!(Path::new(&r).join(".git").is_file(), "live gitfile must remain in place");
        assert!(!Path::new(&r).join(".git.orphaned").exists(), "nothing should be moved aside");
    }

    // ── park_worktree_on_base_at ────────────────────────────────────────────────────────────────
    //
    // A repo with a REAL `origin` (a bare clone we can push to), plus an agent worktree cut from
    // main. Returns (root, worktree path, app_data) — enough to drive every park branch.
    fn init_repo_with_origin(tag: &str) -> (String, String, PathBuf) {
        let r = init_repo(tag);
        let bare = unique_root(&format!("{tag}-origin"));
        let bare_str = bare.to_string_lossy().to_string();
        git(&bare_str, &["init", "-q", "--bare"]).unwrap();
        git(&r, &["remote", "add", "origin", &bare_str]).unwrap();
        git(&r, &["push", "-q", "origin", "main"]).unwrap();
        let app_data = unique_root(&format!("{tag}-appdata"));
        let info = create_worktree_at(&r, "p1", "a1", "main", &app_data).unwrap();
        (r, info.path, app_data)
    }

    /// Advance `origin/main` from a THROWAWAY CLONE, leaving `root`'s own
    /// `refs/remotes/origin/main` pointing at the old tip until something fetches.
    ///
    /// `advance_origin_main` pushes from `root` itself, and a push updates the remote-tracking ref
    /// as a side effect — so every test built on it starts with a perfectly current view of origin,
    /// which is the one state in which a stale-snapshot bug cannot show. This helper reproduces what
    /// a real repo looks like between polls: upstream moved, we have not looked yet.
    fn advance_origin_main_elsewhere(root: &str, tag: &str, name: &str) {
        let url = git(root, &["remote", "get-url", "origin"]).unwrap().trim().to_string();
        let clone = unique_root(&format!("{tag}-elsewhere"));
        let clone_str = clone.to_string_lossy().to_string();
        git(&clone_str, &["clone", "-q", &url, "."]).unwrap();
        git(&clone_str, &["config", "user.email", "t@t"]).unwrap();
        git(&clone_str, &["config", "user.name", "t"]).unwrap();
        // The bare origin was `init --bare`d before `main` existed, so its HEAD names a branch that
        // never got created and the clone lands on an unborn one. Pin the checkout to the real tip
        // rather than committing a second root history that can never fast-forward.
        git(&clone_str, &["checkout", "-q", "-B", "main", "refs/remotes/origin/main"]).unwrap();
        std::fs::write(clone.join(format!("{name}.txt")), "upstream").unwrap();
        git(&clone_str, &["add", "."]).unwrap();
        git(&clone_str, &["commit", "-q", "-m", name]).unwrap();
        git(&clone_str, &["push", "-q", "origin", "HEAD:refs/heads/main"]).unwrap();
    }

    /// Advance `origin/main` by one commit made directly in the source repo's main checkout.
    fn advance_origin_main(root: &str, name: &str) {
        std::fs::write(format!("{root}/{name}.txt"), "upstream").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-q", "-m", name]).unwrap();
        git(root, &["push", "-q", "origin", "main"]).unwrap();
    }

    // THE BUG: `create_worktree_at` is idempotent by leaving an existing worktree ALONE, so a
    // recurring headless pass reuses the previous pass's topic branch and falls further behind
    // origin/main every run (observed at 56 commits). Parking must pull a clean, fully-pushed
    // worktree back onto the fresh base — and land it on the agent's own branch, not the stale one.
    #[test]
    fn park_returns_a_stale_pushed_worktree_to_the_fresh_base() {
        let (r, wt, app_data) = init_repo_with_origin("park-stale");

        // A previous pass left the worktree on its own topic branch, whose work already landed.
        git(&wt, &["checkout", "-q", "-b", "sparkle/last-pass-topic"]).unwrap();
        // Upstream moved on twice since. The worktree is now demonstrably behind.
        advance_origin_main(&r, "up1");
        advance_origin_main(&r, "up2");
        let behind: u32 = git(&wt, &["rev-list", "--count", "HEAD..origin/main"])
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(behind, 2, "precondition: the reused worktree is stale");

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert!(out.parked, "a clean, fully-pushed worktree must be parked: {out:?}");

        assert_eq!(
            git(&wt, &["rev-list", "--count", "HEAD..origin/main"]).unwrap().trim(),
            "0",
            "the worktree must now sit ON the fresh base"
        );
        assert_eq!(
            git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(),
            "sparkle/agent-a1",
            "parking lands on the agent's OWN branch, not the previous pass's topic branch"
        );
    }

    // The safety valve that matters most: a pass that COMMITTED but could not push (unauthenticated
    // `gh`/no network) — or a case-by-case draft awaiting review — has work that exists nowhere but
    // this worktree. Parking would erase it, so it must decline instead.
    #[test]
    fn park_declines_when_the_worktree_holds_unpushed_commits() {
        let (r, wt, app_data) = init_repo_with_origin("park-unpushed");
        std::fs::write(format!("{wt}/pass-work.txt"), "committed but never pushed").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work from a pass that could not push"]).unwrap();
        let tip = git(&wt, &["rev-parse", "HEAD"]).unwrap();
        advance_origin_main(&r, "up1");

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(out, ParkOutcome::declined("unpushed"));
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]).unwrap(), tip, "the commit must survive");
        assert!(Path::new(&wt).join("pass-work.txt").exists(), "its files must survive");
    }

    /// The regression this fix exists for: a killed pass leaves its OWN topic branch checked out
    /// with commits no origin ref contains. `checkout -B sparkle/agent-a1` does not move that
    /// branch, so its commits stay reachable by name — nothing is at risk and the park must proceed.
    /// Before this, the decline was permanent: nothing ever pushes an abandoned branch, so every
    /// later hourly pass inherited a base drifting further behind `origin/main`.
    #[test]
    fn park_proceeds_when_the_unpushed_commits_are_held_by_another_branch() {
        let (r, wt, app_data) = init_repo_with_origin("park-abandoned-topic");
        git(&wt, &["checkout", "-q", "-b", "sparkle/improve-some-topic"]).unwrap();
        std::fs::write(format!("{wt}/pass-work.txt"), "committed by a pass that was killed").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work from a pass the watchdog killed"]).unwrap();
        let abandoned_tip = git(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        advance_origin_main(&r, "up1");

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert!(out.parked, "an abandoned topic branch must not pin the worktree: {out:?}");
        assert_eq!(
            git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(),
            "sparkle/agent-a1",
            "the park must land on the agent's own branch",
        );
        // The point of allowing this: the commits are still there, just not checked out.
        assert_eq!(
            git(&r, &["rev-parse", "refs/heads/sparkle/improve-some-topic"]).unwrap().trim(),
            abandoned_tip,
            "the abandoned branch must still name its commits",
        );
    }

    /// A DETACHED HEAD keeps the full protection: no ref names those commits, so parking off them
    /// strands them outright. This is the case the valve is really for.
    #[test]
    fn park_still_declines_on_unpushed_commits_at_a_detached_head() {
        let (r, wt, app_data) = init_repo_with_origin("park-detached");
        git(&wt, &["checkout", "-q", "--detach"]).unwrap();
        std::fs::write(format!("{wt}/loose.txt"), "reachable from nothing but HEAD").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "a commit no branch names"]).unwrap();
        let tip = git(&wt, &["rev-parse", "HEAD"]).unwrap();
        advance_origin_main(&r, "up1");

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(out, ParkOutcome::declined("unpushed"));
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]).unwrap(), tip, "the commit must survive");
    }

    /// The agent's own branch is checked independently of HEAD, so unpushed work on it is protected
    /// even while the worktree sits on some other branch — `checkout -B` would reset it.
    #[test]
    fn park_declines_for_the_agent_branch_even_when_head_is_elsewhere() {
        let (r, wt, app_data) = init_repo_with_origin("park-agent-branch-offscreen");
        std::fs::write(format!("{wt}/agent-work.txt"), "on the agent's own branch").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "unpushed work on the agent branch"]).unwrap();
        let agent_tip = git(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        // Move HEAD onto a branch that IS fully contained in origin, leaving the agent branch behind.
        git(&wt, &["checkout", "-q", "-b", "sparkle/improve-elsewhere", "origin/main"]).unwrap();
        advance_origin_main(&r, "up1");

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(out, ParkOutcome::declined("unpushed"));
        assert_eq!(
            git(&r, &["rev-parse", "refs/heads/sparkle/agent-a1"]).unwrap().trim(),
            agent_tip,
            "the ref `checkout -B` would reset must be left where it is",
        );
    }

    /// The empty-tip-set path: HEAD on a topic branch AND no `sparkle/agent-<id>` ref at all, so
    /// nothing this park touches can strand a commit. Worth its own test because the skip is not
    /// merely an optimisation — `git rev-list --count --not --remotes=origin` with no positive tip
    /// EXITS NON-ZERO, and the failure branch reads that as "can't prove it's safe" and declines.
    /// Running it anyway would resurrect the permanent decline this commit exists to remove.
    #[test]
    fn park_proceeds_when_no_ref_it_touches_exists_at_all() {
        let (r, wt, app_data) = init_repo_with_origin("park-no-agent-branch");
        git(&wt, &["checkout", "-q", "-b", "sparkle/improve-orphan"]).unwrap();
        std::fs::write(format!("{wt}/pass-work.txt"), "unpushed, held only by this branch").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work from a pass that could not push"]).unwrap();
        // Retire the agent branch, leaving nothing in the at-risk tip set.
        git(&r, &["branch", "-D", "sparkle/agent-a1"]).unwrap();
        assert!(
            git(&r, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-a1"]).is_err(),
            "precondition: the agent branch must be absent",
        );
        advance_origin_main(&r, "up1");

        let orphan_tip = git(&r, &["rev-parse", "refs/heads/sparkle/improve-orphan"])
            .unwrap()
            .trim()
            .to_string();

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert!(out.parked, "an empty tip set has nothing to prove: {out:?}");
        // The property that MAKES parking acceptable here, not just that it happened: parking is
        // only safe because the departing branch keeps naming its commits.
        assert_eq!(
            git(&r, &["rev-parse", "refs/heads/sparkle/improve-orphan"]).unwrap().trim(),
            orphan_tip,
            "the departing branch must survive the checkout at its tip",
        );
    }

    #[test]
    fn head_is_at_risk_only_when_detached_or_on_the_agent_branch() {
        // Detached: nothing else names these commits.
        assert!(head_is_at_risk(None, "sparkle/agent-a1"));
        // The one ref the park resets.
        assert!(head_is_at_risk(Some("sparkle/agent-a1"), "sparkle/agent-a1"));
        // Any other branch survives the checkout untouched, so it puts nothing at risk.
        assert!(!head_is_at_risk(Some("sparkle/improve-topic"), "sparkle/agent-a1"));
        assert!(!head_is_at_risk(Some("main"), "sparkle/agent-a1"));
        // Not a prefix match: a branch that merely starts with the agent branch's name is a
        // different ref, and `checkout -B` does not touch it.
        assert!(!head_is_at_risk(Some("sparkle/agent-a10"), "sparkle/agent-a1"));
    }

    // THE TEST THAT MATTERS, and the one whose absence hid a wiring gap (roborev 55374).
    //
    // The previous round asserted the ignore MECHANISM (`check-ignore` in a synthetic repo) but never
    // the park's DECISION. Both passed while the feature did not reach its target: the seeding was
    // wired into project-open provisioning, and the park only ever runs against the app-owned Sparkle
    // clone, which is built by a bare `git clone` that never goes through that path. A green suite
    // over a feature that cannot fire is exactly the vacuous-test shape AGENTS.md warns about — so
    // this asserts the outcome (`parked`, not `declined("dirty")`), which is the thing that was false.
    #[test]
    fn park_ignores_a_scratch_worktree_left_at_the_repo_root() {
        let (r, wt, app_data) = init_repo_with_origin("park-scratch-wt");
        // A scratch worktree an agent cut and never cleaned up. Nothing claims it, so before this fix
        // it made every subsequent park decline forever.
        std::fs::create_dir_all(format!("{wt}/.wt-leftover")).unwrap();
        std::fs::write(format!("{wt}/.wt-leftover/file.txt"), "scratch").unwrap();
        advance_origin_main(&r, "up1");

        // DirtyPolicy::Decline deliberately — the STRICTEST policy, and the one the improvement
        // pass's reap-precondition probe uses (`improvementPass.ts:399` passes "decline"). That probe
        // is exactly where a scratch worktree still wedges even now that `Stash` exists, so proving
        // the fix under `Decline` proves it without leaning on the stash escape hatch.
        let out =
            park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert!(out.parked, "a stray scratch worktree must no longer wedge the park: {out:?}");
        // Nothing was set aside: an ignored path is not dirt, so it must not cost a stash entry.
        assert!(!out.stashed, "an ignored scratch worktree must not be stashed: {out:?}");
        // The park must IGNORE it, not delete it — this is somebody's scratch space, and silently
        // destroying it would be a far worse bug than the decline.
        assert!(
            Path::new(&wt).join(".wt-leftover/file.txt").exists(),
            "the scratch worktree's contents must survive the park",
        );
    }

    // The dot prefix, asserted at the PARK level rather than only via check-ignore: a bare `wt-*`
    // would make the park silently carry on over real untracked source, which is the opposite of what
    // the guard is for. An undotted directory must still decline.
    #[test]
    fn park_still_declines_on_an_undotted_directory_that_only_looks_like_scratch() {
        let (r, wt, app_data) = init_repo_with_origin("park-undotted-wt");
        std::fs::create_dir_all(format!("{wt}/wt-real")).unwrap();
        std::fs::write(format!("{wt}/wt-real/src.ts"), "real source").unwrap();
        advance_origin_main(&r, "up1");

        let out =
            park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(
            out,
            ParkOutcome::declined("dirty"),
            "an undotted dir is real work — the park must still refuse to touch it",
        );
        assert!(Path::new(&wt).join("wt-real/src.ts").exists(), "real work must survive");
    }

    // Uncommitted work is even more fragile than a commit — `checkout -B` would carry or clobber it.
    #[test]
    fn park_declines_on_a_dirty_worktree() {
        let (r, wt, app_data) = init_repo_with_origin("park-dirty");
        std::fs::write(format!("{wt}/scratch.txt"), "uncommitted").unwrap();
        advance_origin_main(&r, "up1");

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(out, ParkOutcome::declined("dirty"));
        assert!(Path::new(&wt).join("scratch.txt").exists(), "uncommitted work must survive");
    }

    // THE FIXED POINT: the agent's own beads hook appends to a TRACKED log on every session, so the
    // worktree is dirty before the pass does anything. With a bare emptiness check that dirt made
    // every future park decline — the observed hourly `stale base — dirty` that let the app-owned
    // worktree drift 38 commits behind. Churn alone must park, and must not survive the park.
    #[test]
    fn park_restores_session_tooling_churn_instead_of_declining() {
        let (r, wt, app_data) = init_repo_with_origin("park-churn");
        let beads = Path::new(&wt).join(".beads");
        std::fs::create_dir_all(&beads).unwrap();
        std::fs::write(beads.join("interactions.jsonl"), "{\"id\":1}\n").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "beads log"]).unwrap();
        git(&wt, &["push", "-q", "origin", "HEAD:refs/heads/main"]).unwrap();
        advance_origin_main_elsewhere(&r, "park-churn", "up1");
        // What the hook does the moment an agent starts: one more line, uncommitted.
        std::fs::write(beads.join("interactions.jsonl"), "{\"id\":1}\n{\"id\":2}\n").unwrap();

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert!(out.parked, "tooling churn alone must not block parking: {out:?}");
        assert!(
            git(&wt, &["status", "--porcelain"]).unwrap().is_empty(),
            "the churn must be cleared, not carried onto the fresh base"
        );
        // MOVED, NOT DESTROYED. These lines are work-tracker records, not noise — being routinely
        // regenerated is what makes them safe to set aside, not safe to delete.
        assert!(
            git(&wt, &["stash", "list"]).unwrap().contains("session-tooling churn"),
            "the churn must be recoverable from the stash"
        );
        assert!(
            git(&wt, &["stash", "show", "-p", "stash@{0}"]).unwrap().contains("{\"id\":2}"),
            "every churn line must survive inside the stash"
        );
    }

    /// Reproduce the dirt the app-owned worktree was actually observed stuck on — the log line read
    /// `4 entries: 2×' M' 2×'??'`, i.e. a killed pass left uncommitted edits to tracked files AND
    /// untracked residue behind. The tracked baseline is committed and PUSHED first so the
    /// containment valve has nothing to object to and the DIRT is the only thing under test.
    fn seed_leftovers(wt: &str) {
        std::fs::write(format!("{wt}/notes.md"), "committed baseline\n").unwrap();
        std::fs::write(format!("{wt}/plan.md"), "committed baseline\n").unwrap();
        git(wt, &["add", "."]).unwrap();
        git(wt, &["commit", "-q", "-m", "baseline the pass will edit"]).unwrap();
        git(wt, &["push", "-q", "origin", "HEAD:refs/heads/main"]).unwrap();
        std::fs::write(format!("{wt}/notes.md"), "half-finished edit\n").unwrap();
        std::fs::write(format!("{wt}/plan.md"), "half-finished edit\n").unwrap();
        std::fs::write(format!("{wt}/scratch.log"), "residue\n").unwrap();
        std::fs::write(format!("{wt}/tmp-output.txt"), "residue\n").unwrap();
    }

    // DEFECT 2, the fixed point this parameter exists to break: real dirt is outside the churn
    // whitelist, so the park declined every hour forever and each headless pass inherited the last
    // one's leftovers. Under `Stash` the leftovers are SET ASIDE and the park proceeds.
    #[test]
    fn park_stashes_leftover_dirt_and_parks_when_the_policy_allows_it() {
        let (r, wt, app_data) = init_repo_with_origin("park-dirt-stash");
        seed_leftovers(&wt);
        advance_origin_main_elsewhere(&r, "park-dirt-stash", "up1");

        let out =
            park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Stash).unwrap();

        assert!(out.parked, "leftover dirt must not block a Stash-policy park: {out:?}");
        assert!(out.stashed, "the outcome must report that something was set aside: {out:?}");
        // THE SIDE EFFECT, not the precondition: the tree the next pass inherits is clean...
        assert!(
            git(&wt, &["status", "--porcelain"]).unwrap().is_empty(),
            "the leftovers must be cleared, not carried onto the fresh base"
        );
        // ...and it sits on the fresh base, on the agent's own branch. Both, because "clean" and
        // "fresh" are separate claims and the defect is about the second one.
        assert_eq!(
            git(&wt, &["rev-list", "--count", "HEAD..origin/main"]).unwrap().trim(),
            "0",
            "the worktree must now sit ON the fresh base"
        );
        assert_eq!(
            git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(),
            "sparkle/agent-a1",
            "parking lands on the agent's OWN branch"
        );
        // MOVED, NOT DESTROYED — the whole reason this is a stash and not a reset. Assert the
        // CONTENT comes back, not merely that `git stash list` is non-empty.
        assert!(
            !Path::new(&wt).join("scratch.log").exists(),
            "precondition: the untracked residue really did leave the tree"
        );
        git(&wt, &["stash", "pop"]).unwrap();
        assert_eq!(
            std::fs::read_to_string(format!("{wt}/notes.md")).unwrap(),
            "half-finished edit\n",
            "the uncommitted edit must come back intact"
        );
        assert_eq!(
            std::fs::read_to_string(format!("{wt}/scratch.log")).unwrap(),
            "residue\n",
            "`-u`: untracked residue must be recoverable too, not silently deleted"
        );
    }

    // THE OPT-IN, pinned. `park_worktree_on_base_at` is generic over worktrees and a future caller
    // may point it at a USER'S project — where uncommitted edits are not ours to relocate, however
    // recoverable the relocation is. The default policy must behave exactly as it did before.
    #[test]
    fn park_declines_the_same_leftover_dirt_under_the_default_policy() {
        let (r, wt, app_data) = init_repo_with_origin("park-dirt-decline");
        seed_leftovers(&wt);
        advance_origin_main_elsewhere(&r, "park-dirt-decline", "up1");
        let head_before = git(&wt, &["rev-parse", "HEAD"]).unwrap();

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline)
            .unwrap();

        assert_eq!(out, ParkOutcome::declined("dirty"), "widening the dirt rule must be OPT-IN");
        assert_eq!(
            git(&wt, &["rev-parse", "HEAD"]).unwrap(),
            head_before,
            "a decline must not move the worktree"
        );
        assert_eq!(
            std::fs::read_to_string(format!("{wt}/notes.md")).unwrap(),
            "half-finished edit\n",
            "the edit must be left exactly where it was"
        );
        assert!(Path::new(&wt).join("scratch.log").exists(), "untracked residue must be left too");
        assert!(
            git(&wt, &["stash", "list"]).unwrap().is_empty(),
            "and nothing may be stashed either — Decline means UNTOUCHED, not 'moved somewhere safe'"
        );
    }

    // FAIL CLOSED. A stash push that fails leaves the leftovers saved nowhere, and the very next
    // statement would `checkout -B` over them. Falling through to let the checkout "probably fail
    // too" is not a safety property: git carries a modified file across a checkout whenever the file
    // is identical in both commits, so the fall-through can succeed and take unsaved dirt with it.
    #[test]
    fn park_declines_and_touches_nothing_when_the_leftovers_cannot_be_stashed() {
        let (r, wt, app_data) = init_repo_with_origin("park-dirt-stash-fails");
        seed_leftovers(&wt);
        advance_origin_main_elsewhere(&r, "park-dirt-stash-fails", "up1");
        let head_before = git(&wt, &["rev-parse", "HEAD"]).unwrap();

        // Fail the stash the way it really fails in the field: something else holds the index lock.
        // `git status` still succeeds under it (it just skips writing the refreshed index), so the
        // park reaches the stash step and fails THERE — which is the path under test, rather than
        // some earlier probe erroring out and reaching the same token by accident.
        let git_dir = git(&wt, &["rev-parse", "--absolute-git-dir"]).unwrap().trim().to_string();
        std::fs::write(format!("{git_dir}/index.lock"), "").unwrap();

        let out =
            park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Stash).unwrap();

        // `dirty`, NOT `checkout-failed`: reaching the checkout at all would mean the park had tried
        // to move a tree it knew it had failed to save.
        assert_eq!(
            out,
            ParkOutcome::declined("dirty"),
            "an unsaveable tree must decline BEFORE the checkout, not through it"
        );
        assert!(!out.stashed, "nothing was saved, so the outcome must not claim otherwise");
        assert_eq!(
            git(&wt, &["rev-parse", "HEAD"]).unwrap(),
            head_before,
            "nothing may be checked out over dirt that could not be saved"
        );
        assert_eq!(
            std::fs::read_to_string(format!("{wt}/notes.md")).unwrap(),
            "half-finished edit\n",
            "the unsaved edit must survive verbatim"
        );
        assert!(Path::new(&wt).join("scratch.log").exists(), "untracked residue must survive too");
    }

    // Hourly x forever, the leftover-dirt edition: an unconditional push stacks an entry per pass
    // into the REPOSITORY-WIDE `refs/stash`, each pinning its blobs against gc and each surfacing in
    // the main checkout's `git stash list`.
    #[test]
    fn repeated_parks_do_not_stack_leftover_dirt_stashes() {
        let (r, wt, app_data) = init_repo_with_origin("park-dirt-twice");
        std::fs::write(format!("{wt}/notes.md"), "committed baseline\n").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "baseline"]).unwrap();
        git(&wt, &["push", "-q", "origin", "HEAD:refs/heads/main"]).unwrap();

        // PAST THE RING, so the bound is actually exercised rather than assumed.
        for n in 1..=(PARK_DIRT_STASH_KEEP + 3) {
            advance_origin_main_elsewhere(&r, "park-dirt-twice", &format!("up{n}"));
            std::fs::write(format!("{wt}/notes.md"), format!("pass {n} leftovers\n")).unwrap();
            std::fs::write(format!("{wt}/scratch.log"), format!("pass {n} leftovers\n")).unwrap();
            let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Stash)
                .unwrap();
            assert!(out.parked && out.stashed, "park {n} must stash and park: {out:?}");
        }

        let entries = git(&wt, &["stash", "list"]).unwrap();
        assert_eq!(
            entries.lines().filter(|l| l.contains("leftover worktree dirt")).count(),
            PARK_DIRT_STASH_KEEP,
            "leftover-dirt stashes are a bounded ring, not an unbounded stack: {entries}"
        );
        // Bounded AND still real: the newest entry is THIS pass's leftovers, poppable. Each stash is
        // the diff at its own park, so no entry contains another.
        git(&wt, &["stash", "pop"]).unwrap();
        let newest = format!("pass {} leftovers\n", PARK_DIRT_STASH_KEEP + 3);
        assert_eq!(std::fs::read_to_string(format!("{wt}/notes.md")).unwrap(), newest);
        assert_eq!(std::fs::read_to_string(format!("{wt}/scratch.log")).unwrap(), newest);
    }

    /// THE DESTROY PATH THE RING EXISTS TO CLOSE (roborev 55238).
    ///
    /// Retiring dirt on the churn rule — keep exactly one — silently drops a previous pass's
    /// unrecovered work: churn is a regenerated file where entry N+1 supersedes entry N, but each
    /// dirt entry holds a DIFFERENT pass's leftovers and is only ever popped by hand, so nothing
    /// tells anyone the older one existed before it becomes unreachable and gc-able.
    ///
    /// The sibling test above could not catch this: it writes the SAME files every pass, which is
    /// the one shape where dropping is harmless because the survivor happens to cover the retired
    /// entry's paths. Here pass 2 touches a file pass 1 never did, so a lost entry is lost content.
    #[test]
    fn a_later_park_does_not_destroy_an_earlier_passes_leftovers() {
        let (r, wt, app_data) = init_repo_with_origin("park-dirt-distinct");
        std::fs::write(format!("{wt}/notes.md"), "committed\n").unwrap();
        std::fs::write(format!("{wt}/plan.md"), "committed\n").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "baseline"]).unwrap();
        git(&wt, &["push", "-q", "origin", "HEAD:refs/heads/main"]).unwrap();

        // Pass 1 dies mid-edit to notes.md.
        advance_origin_main_elsewhere(&r, "park-dirt-distinct", "up1");
        std::fs::write(format!("{wt}/notes.md"), "hour one, half finished\n").unwrap();
        assert!(
            park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Stash)
                .unwrap()
                .stashed
        );

        // Pass 2 dies mid-edit to a DIFFERENT file. Nothing about this supersedes pass 1's work.
        advance_origin_main_elsewhere(&r, "park-dirt-distinct", "up2");
        std::fs::write(format!("{wt}/plan.md"), "hour two, unrelated\n").unwrap();
        assert!(
            park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Stash)
                .unwrap()
                .stashed
        );

        // THE SIDE EFFECT: pass 1's edit is still THERE, and comes back as content. Asserting the
        // entry count alone would pass against a stash whose blob had been dropped.
        let entries = git(&wt, &["stash", "list"]).unwrap();
        assert_eq!(
            entries.lines().filter(|l| l.contains("leftover worktree dirt")).count(),
            2,
            "both passes' leftovers must survive — they are different work: {entries}"
        );
        git(&wt, &["stash", "pop", "stash@{1}"]).unwrap();
        assert_eq!(
            std::fs::read_to_string(format!("{wt}/notes.md")).unwrap(),
            "hour one, half finished\n",
            "the FIRST pass's uncommitted edit must still be recoverable after a later park"
        );
    }

    /// The two-marker split, pinned. Its doc comment justifies the split as a safety property — a
    /// cheap churn-only park must not retire the entry holding a previous pass's REAL leftovers —
    /// but every other test exercises one marker at a time, so collapsing the two constants (or
    /// reusing the churn marker in the `stash_all` branch) would keep the suite green while
    /// reintroducing exactly that data loss. roborev 55238.
    #[test]
    fn a_churn_only_park_does_not_retire_a_previous_passes_leftover_dirt() {
        let (r, wt, app_data) = init_repo_with_origin("park-marker-split");
        let beads = Path::new(&wt).join(".beads");
        std::fs::create_dir_all(&beads).unwrap();
        std::fs::write(beads.join("interactions.jsonl"), "{\"id\":1}\n").unwrap();
        std::fs::write(format!("{wt}/notes.md"), "committed\n").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "baseline"]).unwrap();
        git(&wt, &["push", "-q", "origin", "HEAD:refs/heads/main"]).unwrap();

        // A pass dies leaving real leftovers → a DIRT stash.
        advance_origin_main_elsewhere(&r, "park-marker-split", "up1");
        std::fs::write(format!("{wt}/notes.md"), "real leftover work\n").unwrap();
        assert!(
            park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Stash)
                .unwrap()
                .stashed
        );

        // The next park sees ONLY session-tooling churn — the cheap, routine case, which takes the
        // churn branch and its keep-exactly-one retirement.
        advance_origin_main_elsewhere(&r, "park-marker-split", "up2");
        std::fs::write(beads.join("interactions.jsonl"), "{\"id\":1}\n{\"id\":2}\n").unwrap();
        assert!(
            park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Stash)
                .unwrap()
                .parked
        );

        let entries = git(&wt, &["stash", "list"]).unwrap();
        assert_eq!(
            entries.lines().filter(|l| l.contains("leftover worktree dirt")).count(),
            1,
            "the churn park must not have retired the dirt entry — different marker: {entries}"
        );
        // Content, not just presence.
        let dirt = entries
            .lines()
            .find(|l| l.contains("leftover worktree dirt"))
            .and_then(|l| l.split(':').next())
            .unwrap()
            .to_string();
        git(&wt, &["stash", "pop", &dirt]).unwrap();
        assert_eq!(
            std::fs::read_to_string(format!("{wt}/notes.md")).unwrap(),
            "real leftover work\n",
            "the earlier pass's leftovers must survive a churn-only park intact"
        );
    }

    /// `already-fresh` is a claim about the BASE, not about the tree — and only the second is what
    /// the next pass needs. A pass that edited files and died before committing leaves the worktree
    /// on the agent branch AT the base commit, already fresh by SHA and still carrying every
    /// leftover; returning early there would hand the next pass a tree it cannot trust while telling
    /// it everything was fine. That is defect 2 again, in the one window where origin has not moved.
    #[test]
    fn park_clears_leftover_dirt_even_when_the_base_is_already_fresh() {
        let (r, wt, app_data) = init_repo_with_origin("park-dirt-already-fresh");
        // No `advance_origin_main`: the worktree already sits on the base, on its own branch.
        std::fs::write(format!("{wt}/scratch.log"), "residue\n").unwrap();
        let head_before = git(&wt, &["rev-parse", "HEAD"]).unwrap();

        // The dirt rule is evaluated BEFORE the base is, so the default policy still reports `dirty`
        // here — and, either way, touches nothing.
        let decline = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline)
            .unwrap();
        assert_eq!(decline, ParkOutcome::declined("dirty"));
        assert!(Path::new(&wt).join("scratch.log").exists(), "the default policy must touch nothing");

        let out =
            park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Stash).unwrap();

        assert!(!out.parked, "nothing was checked out — the base was already right");
        assert_eq!(out.reason, "already-fresh", "so the token must stay honest: {out:?}");
        assert!(out.stashed, "but the tree WAS cleared, and the outcome must say so: {out:?}");
        assert!(
            git(&wt, &["status", "--porcelain"]).unwrap().is_empty(),
            "the next pass must inherit a CLEAN tree even when the base needed no move"
        );
        assert_eq!(
            git(&wt, &["rev-parse", "HEAD"]).unwrap(),
            head_before,
            "clearing the tree must not move HEAD"
        );
        git(&wt, &["stash", "pop"]).unwrap();
        assert_eq!(
            std::fs::read_to_string(format!("{wt}/scratch.log")).unwrap(),
            "residue\n",
            "recoverable, as everywhere else"
        );
    }

    // Hourly x forever: an unconditional stash push would stack an entry per pass into the
    // REPOSITORY-WIDE `refs/stash`, where they also surface in the main checkout's `git stash list`.
    // Parking twice must leave exactly one — and it must still be the real content, poppable.
    #[test]
    fn repeated_parks_keep_exactly_one_recoverable_churn_stash() {
        let (r, wt, app_data) = init_repo_with_origin("park-churn-twice");
        let beads = Path::new(&wt).join(".beads");
        std::fs::create_dir_all(&beads).unwrap();
        std::fs::write(beads.join("interactions.jsonl"), "{\"id\":1}\n").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "beads log"]).unwrap();
        git(&wt, &["push", "-q", "origin", "HEAD:refs/heads/main"]).unwrap();

        for (n, line) in [(1, "{\"id\":2}"), (2, "{\"id\":3}")] {
            advance_origin_main_elsewhere(&r, "park-churn-twice", &format!("up{n}"));
            std::fs::write(beads.join("interactions.jsonl"), format!("{{\"id\":1}}\n{line}\n"))
                .unwrap();
            let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
            assert!(out.parked, "park {n} must succeed: {out:?}");
        }

        let entries = git(&wt, &["stash", "list"]).unwrap();
        assert_eq!(
            entries.lines().filter(|l| l.contains("session-tooling churn")).count(),
            1,
            "a park retires its previous churn stash instead of stacking another: {entries}"
        );
        // Recoverable in the sense that matters: pop reproduces the file, not just a diff mentioning it.
        git(&wt, &["stash", "pop"]).unwrap();
        assert_eq!(
            std::fs::read_to_string(beads.join("interactions.jsonl")).unwrap(),
            "{\"id\":1}\n{\"id\":3}\n",
            "the surviving stash holds THIS pass's churn, restored intact (each stash is the diff \
             at its own park — a later one does not contain an earlier one)"
        );
    }

    // The valve that keeps the exception from becoming a hole: one real edit alongside the churn is
    // real work, and gets exactly the protection it had before.
    #[test]
    fn park_still_declines_when_real_work_sits_beside_the_churn() {
        let (r, wt, app_data) = init_repo_with_origin("park-churn-mixed");
        let beads = Path::new(&wt).join(".beads");
        std::fs::create_dir_all(&beads).unwrap();
        std::fs::write(beads.join("interactions.jsonl"), "{\"id\":1}\n").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "beads log"]).unwrap();
        git(&wt, &["push", "-q", "origin", "HEAD:refs/heads/main"]).unwrap();
        advance_origin_main_elsewhere(&r, "park-churn-mixed", "up1");
        std::fs::write(beads.join("interactions.jsonl"), "{\"id\":1}\n{\"id\":2}\n").unwrap();
        std::fs::write(format!("{wt}/scratch.txt"), "uncommitted").unwrap();

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(out, ParkOutcome::declined("dirty"));
        assert!(Path::new(&wt).join("scratch.txt").exists(), "uncommitted work must survive");
        assert_eq!(
            std::fs::read_to_string(beads.join("interactions.jsonl")).unwrap(),
            "{\"id\":1}\n{\"id\":2}\n",
            "a decline restores nothing at all"
        );
    }

    // Unit-level pins for the parser, where the destructive mistakes would live.
    #[test]
    fn only_modifications_to_known_tooling_paths_are_restorable() {
        assert_eq!(tooling_churn_to_restore(""), Some(vec![]));
        for code in [" M", "M ", "MM"] {
            assert_eq!(
                tooling_churn_to_restore(&format!("{code} .beads/interactions.jsonl")),
                Some(vec![".beads/interactions.jsonl".into()]),
                "{code} is an ordinary edit to the churn file"
            );
        }
        // Untracked is excluded so restoring can never delete a file someone's tool just wrote.
        assert_eq!(tooling_churn_to_restore("?? .beads/interactions.jsonl"), None);
        // Deletes, adds, renames and unmerged states are not faithfully undone by a plain restore.
        for line in [
            " D .beads/interactions.jsonl",
            "A  .beads/interactions.jsonl",
            "UU .beads/interactions.jsonl",
            "R  .beads/old.jsonl -> .beads/interactions.jsonl",
        ] {
            assert_eq!(tooling_churn_to_restore(line), None, "{line} must not be restorable");
        }
        // A path outside the list — including a near-miss under the same directory — is work.
        assert_eq!(tooling_churn_to_restore(" M .beads/config.yaml"), None);
        assert_eq!(tooling_churn_to_restore(" M src/main.rs"), None);
        // One ineligible entry declines the whole tree, whichever side it is on.
        assert_eq!(
            tooling_churn_to_restore(" M .beads/interactions.jsonl\n M src/main.rs"),
            None
        );
        assert_eq!(
            tooling_churn_to_restore(" M src/main.rs\n M .beads/interactions.jsonl"),
            None
        );
        // A quoted (C-escaped) path is refused rather than parsed back into bytes for git.
        assert_eq!(tooling_churn_to_restore(" M \".beads/interactions.jsonl\""), None);
        // Truncated/garbage lines are not silently treated as clean.
        assert_eq!(tooling_churn_to_restore(" M"), None);
        // THE SHAPE THE REAL CALLER PASSES: `git` trims, so a one-file status arrives without its
        // leading column and a multi-line one only loses it on the FIRST line. Reading a fixed
        // offset here made the whole fix a no-op on exactly the case it exists for.
        assert_eq!(
            tooling_churn_to_restore("M .beads/interactions.jsonl"),
            Some(vec![".beads/interactions.jsonl".into()]),
            "a trimmed ` M` line is still an ordinary edit"
        );
        assert_eq!(
            tooling_churn_to_restore("M  .beads/interactions.jsonl"),
            Some(vec![".beads/interactions.jsonl".into()]),
            "a trimmed `M ` line is unchanged by the trim and must still parse"
        );
        assert_eq!(tooling_churn_to_restore("M src/main.rs"), None, "trimmed real work declines");
        assert_eq!(
            tooling_churn_to_restore("M .beads/interactions.jsonl\n M .beads/interactions.jsonl"),
            Some(vec![".beads/interactions.jsonl".into(), ".beads/interactions.jsonl".into()]),
            "only the first line loses its column; later ones keep it"
        );
    }

    // Already on the fresh base → a reported no-op, so the caller doesn't log a false "stale base".
    #[test]
    fn park_is_a_reported_no_op_when_already_fresh() {
        let (r, _wt, app_data) = init_repo_with_origin("park-fresh");
        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(out, ParkOutcome::declined("already-fresh"));
    }

    // No worktree yet (first ever run, or one that was reaped): nothing to park, and NOT an error —
    // the caller creates it from the base immediately after.
    #[test]
    fn park_declines_when_there_is_no_worktree() {
        let r = init_repo("park-none");
        let app_data = unique_root("park-none-appdata");
        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(out, ParkOutcome::declined("no-worktree"));
    }

    // With no `origin` at all, "is this commit pushed?" is unanswerable — the conservative reading
    // is "can't prove it's safe", so decline rather than reset against a local-only base.
    #[test]
    fn park_declines_when_containment_cannot_be_proven() {
        let r = init_repo("park-no-origin");
        let app_data = unique_root("park-no-origin-appdata");
        create_worktree_at(&r, "p1", "a1", "main", &app_data).unwrap();
        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(out, ParkOutcome::declined("unpushed"));
    }

    // Containment is a claim about origin AS IT IS NOW, so it has to be proven against a FRESHLY
    // fetched origin. Proving it against the last local snapshot reads a merged-and-pruned branch as
    // `unpushed`: the pass's commits sit in `origin/main` upstream, but the local view predates the
    // merge and the branch's remote-tracking ref is gone, so nothing local contains them — and park
    // refuses to touch a worktree that provably has nothing left to lose.
    #[test]
    fn park_proves_containment_against_a_freshly_fetched_origin() {
        let (r, wt, app_data) = init_repo_with_origin("park-pruned");

        // The previous pass committed ON THE AGENT'S OWN BRANCH and pushed it for review under a
        // topic name. Staying on the agent branch is load-bearing: `head_is_at_risk` excludes HEAD
        // when it sits on any other branch, so committing on a topic branch here would empty the
        // at-risk tip set down to the pushed initial commit and make the containment proof — and
        // therefore this whole test — pass trivially whether or not the fetch ran first.
        std::fs::write(format!("{wt}/landed.txt"), "work that got merged").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work from the previous pass"]).unwrap();
        let landed = git(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        git(&wt, &["push", "-q", "origin", "HEAD:refs/heads/sparkle/last-pass-topic"]).unwrap();

        // Upstream: the PR lands and the branch is deleted, then later work stacks on top.
        let url = git(&r, &["remote", "get-url", "origin"]).unwrap().trim().to_string();
        git(&url, &["update-ref", "refs/heads/main", &landed]).unwrap();
        let _ = git(&url, &["update-ref", "-d", "refs/heads/sparkle/last-pass-topic"]);
        advance_origin_main_elsewhere(&r, "park-pruned", "up1");

        // Our view of origin predates all of it: pruned locally, and main never refetched. The
        // deletion is load-bearing, not best-effort — the push above created that tracking ref, and
        // containment consults ALL of `--remotes=origin`, so a surviving one would satisfy the check
        // and make this test pass against the old ordering too.
        git(&r, &["update-ref", "-d", "refs/remotes/origin/sparkle/last-pass-topic"]).unwrap();
        // Assert the precondition with the exact predicate park evaluates, not a narrower proxy:
        // ancestry against `origin/main` alone says nothing about the other origin refs.
        assert_ne!(
            git(&wt, &["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]).unwrap().trim(),
            "0",
            "precondition: no LOCAL origin ref contains the landed commit"
        );

        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert!(out.parked, "work already on origin/main must not read as unpushed: {out:?}");
        assert_eq!(
            git(&wt, &["rev-list", "--count", "HEAD..origin/main"]).unwrap().trim(),
            "0",
            "and the worktree lands on the fresh base"
        );
    }

    // A decline is exactly when `origin/<base>` matters MOST: the pass is left to cut its own branch
    // off it. Fetching only on the success path handed the stalest base to the one run that had to
    // rely on it — and made the decline self-reinforcing, since it suppressed the fetch that would
    // have cleared it.
    #[test]
    fn park_freshens_the_base_even_when_it_declines() {
        let (r, wt, app_data) = init_repo_with_origin("park-decline-fetch");
        let before = git(&r, &["rev-parse", "refs/remotes/origin/main"]).unwrap().trim().to_string();
        advance_origin_main_elsewhere(&r, "park-decline-fetch", "up1");
        assert_eq!(
            git(&r, &["rev-parse", "refs/remotes/origin/main"]).unwrap().trim(),
            before,
            "precondition: our view of origin/main is stale"
        );

        // Uncommitted work → park must still decline, and must not touch it.
        std::fs::write(format!("{wt}/scratch.txt"), "uncommitted").unwrap();
        let out = park_worktree_on_base_at(&r, "p1", "a1", "main", &app_data, DirtyPolicy::Decline).unwrap();
        assert_eq!(out, ParkOutcome::declined("dirty"));
        assert!(Path::new(&wt).join("scratch.txt").exists(), "uncommitted work must survive");

        assert_ne!(
            git(&r, &["rev-parse", "refs/remotes/origin/main"]).unwrap().trim(),
            before,
            "a declined park must still leave origin/main fresh for the pass about to branch off it"
        );
    }

    // sparkle-zlic: the batched status command computes every agent in one pass and, crucially,
    // SKIPS an idle agent whose fingerprint (tip + base + default + index mtime) is unchanged since
    // the last tick — while `force` always recomputes and a new commit re-evaluates.
    #[test]
    fn batch_status_skips_unchanged_and_recomputes_on_change() {
        let r = init_repo("batch-skip");
        let app_data = unique_root("batch-skip-appdata");
        let info = create_worktree_at(&r, "p1", "a1", "main", &app_data).unwrap();
        let wt = info.path;
        // One commit in the worktree → the branch is 1 ahead of main.
        std::fs::write(format!("{wt}/w.txt"), "work").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work"]).unwrap();

        let input = |force: bool| AgentStatusInput {
            agent_id: "a1".into(),
            base_branch: "main".into(),
            parent_branch: String::new(),
            kind: "build".into(),
            force,
        };
        // probe_pr_state=false ⇒ no origin fetch / gh probe, purely local + offline-safe.
        let first = project_agents_status_at(&r, "p1", &[input(false)], false, &app_data);
        assert_eq!(first.len(), 1);
        assert!(first[0].changed, "first tick computes");
        assert_eq!(first[0].branch.as_ref().unwrap().ahead, 1);

        // Nothing changed → skipped (no payload; the frontend keeps its prior values).
        let second = project_agents_status_at(&r, "p1", &[input(false)], false, &app_data);
        assert!(!second[0].changed, "unchanged idle agent is skipped");
        assert!(second[0].branch.is_none());

        // force=true recomputes even when the fingerprint is unchanged.
        let forced = project_agents_status_at(&r, "p1", &[input(true)], false, &app_data);
        assert!(forced[0].changed, "force always recomputes");
        assert_eq!(forced[0].branch.as_ref().unwrap().ahead, 1);

        // A new commit moves the tip → fingerprint changes → recompute picks up ahead=2.
        std::fs::write(format!("{wt}/w2.txt"), "more").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "more"]).unwrap();
        let after = project_agents_status_at(&r, "p1", &[input(false)], false, &app_data);
        assert!(after[0].changed, "a new commit re-evaluates");
        assert_eq!(after[0].branch.as_ref().unwrap().ahead, 2);
    }

    // sparkle-prpb: an idle agent whose git fingerprint never moves must still get its PR state
    // re-probed once PR_REPROBE_TTL elapses — otherwise an out-of-band PR open leaves the CTA stuck
    // on "Open Pull Request". Exercises the batch's skip-vs-recompute wiring end to end: fresh probe
    // skips, a back-dated probe clock forces a recompute, the recompute re-stamps the clock, the
    // no-remote path never reprobes, and removal evicts the clock. (The gh probe finds nothing for a
    // local-path origin — this asserts the RECOMPUTE decision, not pr_state.)
    #[test]
    fn batch_reprobes_pr_state_after_ttl_even_when_git_unchanged() {
        let r = init_repo("batch-reprobe");
        // A local bare repo standing in as `origin` so `has_origin` is true on a probe poll.
        let origin = unique_root("batch-reprobe-origin");
        let origin_str = origin.to_str().unwrap().to_string();
        git(&origin_str, &["init", "-q", "--bare"]).unwrap();
        git(&r, &["remote", "add", "origin", &origin_str]).unwrap();
        git(&r, &["push", "-q", "origin", "main"]).unwrap();

        let app_data = unique_root("batch-reprobe-appdata");
        let info = create_worktree_at(&r, "p1", "a1", "main", &app_data).unwrap();
        let wt = info.path;
        std::fs::write(format!("{wt}/w.txt"), "work").unwrap();
        git(&wt, &["add", "."]).unwrap();
        git(&wt, &["commit", "-q", "-m", "work"]).unwrap();

        let input = |force: bool| AgentStatusInput {
            agent_id: "a1".into(),
            base_branch: "main".into(),
            parent_branch: String::new(),
            kind: "build".into(),
            force,
        };
        let wt_key =
            worktree_path(&app_data, "p1", "a1").unwrap().to_string_lossy().to_string();
        // Make the next poll see this worktree's last probe as "older than the TTL". If the monotonic
        // clock is itself younger than the TTL (a container booted <~91s ago), no Instant can
        // represent that instant — so drop the entry instead, which pr_reprobe_due reads as
        // never-probed (also due). Either path yields "reprobe is due", and neither can panic.
        let back_date_probe_clock = |key: &str| {
            let mut cache = pr_probe_cache().lock().unwrap();
            match Instant::now().checked_sub(PR_REPROBE_TTL + Duration::from_secs(1)) {
                Some(stale) => {
                    cache.insert(key.to_string(), stale);
                }
                None => {
                    cache.remove(key);
                }
            }
        };

        // First probe poll computes and stamps the PR-probe clock.
        let first = project_agents_status_at(&r, "p1", &[input(false)], true, &app_data);
        assert!(first[0].changed, "first tick computes");

        // Immediately again: fingerprint matches AND the probe clock is fresh → skipped.
        let second = project_agents_status_at(&r, "p1", &[input(false)], true, &app_data);
        assert!(!second[0].changed, "unchanged idle agent within the TTL is skipped");

        // Back-date the probe clock past the TTL (git still untouched) → the next probe poll must
        // recompute to refresh PR state, even though the fingerprint is identical.
        back_date_probe_clock(&wt_key);
        let before_third = Instant::now();
        let third = project_agents_status_at(&r, "p1", &[input(false)], true, &app_data);
        assert!(third[0].changed, "past the PR-reprobe TTL an idle agent recomputes to refresh PR state");
        // Direct proof (not just the `changed` proxy) that the reprobe actually ran and re-stamped the
        // probe clock: the stored instant is now fresh — at or after the moment just before this poll.
        let stamped = *pr_probe_cache()
            .lock()
            .unwrap()
            .get(&wt_key)
            .expect("a reprobe recompute must re-stamp the PR-probe clock");
        assert!(stamped >= before_third, "the recompute re-stamped the PR-probe clock to a fresh instant");

        // The recompute re-stamped the clock → the very next poll skips again.
        let fourth = project_agents_status_at(&r, "p1", &[input(false)], true, &app_data);
        assert!(!fourth[0].changed, "recompute re-stamps the clock, so the following tick skips");

        // A poll with NO remote gate (probe_pr_state=false ⇒ has_origin=false) must NEVER reprobe on
        // the TTL, even with a stale clock — the local-only path is unchanged.
        back_date_probe_clock(&wt_key);
        let local_only = project_agents_status_at(&r, "p1", &[input(false)], false, &app_data);
        assert!(!local_only[0].changed, "a no-remote poll never reprobes on the TTL");

        // Removing the worktree evicts the probe clock so a reused path re-probes on its first tick.
        remove_worktree_at(&r, "p1", "a1", &app_data).unwrap();
        assert!(
            !pr_probe_cache().lock().unwrap().contains_key(&wt_key),
            "remove_worktree_at evicts the PR-probe clock",
        );
    }

    // Resilience: a recorded base branch that no longer exists (the repo was renamed
    // `main` → `master`, or the base was deleted) must NOT be handed to git as a phantom ref.
    // `effective_base` falls back to the repo's actual default; a base that DOES exist is
    // returned unchanged.
    #[test]
    fn effective_base_recovers_from_a_drifted_recorded_base() {
        let r = init_repo("eb-drift"); // one commit, on `main`
        // Drift: the integration branch was renamed out from under the recorded default.
        git(&r, &["branch", "-m", "main", "master"]).unwrap();
        assert!(!branch_exists(&r, "main"), "precondition: main is gone");
        assert!(branch_exists(&r, "master"), "precondition: master is the real default");

        // The now-missing "main" resolves to the detected default instead of a bogus name.
        assert_eq!(effective_base(&r, "main", false), "master");
        // A base that still exists is returned verbatim.
        assert_eq!(effective_base(&r, "master", false), "master");
        // An empty/legacy base still auto-detects (unchanged behavior).
        assert_eq!(effective_base(&r, "", false), "master");
    }

    // Store-healing: reconcile_default_branch_at keeps a still-valid recorded value (including a
    // deliberate non-default), but heals a drifted/empty one to the repo's actual default.
    #[test]
    fn reconcile_default_branch_heals_drift_but_preserves_valid_choices() {
        let r = init_repo("reconcile-drift"); // one commit, on `main`
        // A recorded value that still exists is kept verbatim.
        assert_eq!(reconcile_default_branch_at(&r, "main"), "main");
        // A deliberate non-default branch that exists is preserved, NOT overwritten with the default.
        git(&r, &["branch", "develop"]).unwrap();
        assert_eq!(reconcile_default_branch_at(&r, "develop"), "develop");
        // Drift: rename main → master so the recorded "main" no longer resolves → heal to master.
        git(&r, &["branch", "-m", "main", "master"]).unwrap();
        assert_eq!(reconcile_default_branch_at(&r, "main"), "master");
        // An empty recorded value auto-detects the default.
        assert_eq!(reconcile_default_branch_at(&r, ""), "master");
        // A syntactically unsafe recorded value is never trusted; it heals to the default.
        assert_eq!(reconcile_default_branch_at(&r, "--upload-pack=evil"), "master");
    }

    // A recorded value that resolves ONLY as a remote-tracking ref (origin/<name>, no local branch —
    // the common fresh-clone shape) is still preserved verbatim, not overwritten with the default.
    #[test]
    fn reconcile_default_branch_preserves_a_remote_only_recorded_value() {
        let upstream = init_repo("reconcile-remote-up"); // has `main`
        git(&upstream, &["branch", "release"]).unwrap(); // a non-default integration branch upstream
        let local_root = unique_root("reconcile-remote-local");
        let l = local_root.to_str().unwrap().to_string();
        git(&l, &["init", "-q"]).unwrap();
        git(&l, &["config", "user.email", "t@t"]).unwrap();
        git(&l, &["config", "user.name", "t"]).unwrap();
        git(&l, &["remote", "add", "origin", &upstream]).unwrap();
        git(&l, &["fetch", "-q", "origin"]).unwrap();
        assert!(!branch_exists(&l, "release"), "no local branch, remote-tracking only");
        assert!(git(&l, &["rev-parse", "--verify", "--quiet", "refs/remotes/origin/release"]).is_ok());

        // "release" exists only as origin/release → preserved, NOT healed to a different default.
        assert_eq!(reconcile_default_branch_at(&l, "release"), "release");
    }

    // Remote-only detected default: a fresh clone whose default exists solely as `origin/<default>`
    // (no local branch yet). When the recorded base is a phantom, effective_base must cut from that
    // remote-tracking ref rather than dropping to HEAD.
    #[test]
    fn effective_base_uses_remote_detected_default_when_local_missing() {
        let upstream = init_repo("eb-remote-up"); // has `main`, one commit
        let local_root = unique_root("eb-remote-local");
        let l = local_root.to_str().unwrap().to_string();
        git(&l, &["init", "-q"]).unwrap();
        git(&l, &["config", "user.email", "t@t"]).unwrap();
        git(&l, &["config", "user.name", "t"]).unwrap();
        git(&l, &["remote", "add", "origin", &upstream]).unwrap();
        git(&l, &["fetch", "-q", "origin"]).unwrap();
        // origin/HEAD → origin/main, but fetch created NO local `main` branch.
        git(&l, &["remote", "set-head", "origin", "main"]).unwrap();
        assert!(!branch_exists(&l, "main"), "no local default branch exists");
        assert!(git(&l, &["rev-parse", "--verify", "--quiet", "origin/main"]).is_ok());

        // Recorded base "develop" resolves to nothing (no local, no origin/develop); the detected
        // default "main" exists only as origin/main → cut from origin/main, never HEAD.
        assert_eq!(effective_base(&l, "develop", false), "origin/main");
    }

    // Last-resort cascade: when neither the requested base NOR any named default branch resolves
    // (detached HEAD, every branch deleted, no remote), `effective_base` cuts from `HEAD` rather
    // than handing git a phantom name.
    #[test]
    fn effective_base_uses_head_when_no_named_base_resolves() {
        let r = init_repo("eb-head"); // one commit, on `main`
        let sha = git(&r, &["rev-parse", "HEAD"]).unwrap();
        // Detach, then delete every named branch so nothing but HEAD resolves.
        git(&r, &["checkout", "-q", "--detach", &sha]).unwrap();
        git(&r, &["branch", "-D", "main"]).unwrap();
        assert!(!branch_exists(&r, "main"));
        assert!(!branch_exists(&r, "master"));
        assert_eq!(effective_base(&r, "main", false), "HEAD");
    }

    // Degenerate case: an unborn HEAD (freshly `git init`'d, no commits). Nothing resolves, so the
    // original logical name is returned for the caller's born-HEAD handling / git error to surface.
    #[test]
    fn effective_base_returns_original_name_in_an_unborn_repo() {
        let root = unique_root("eb-unborn");
        let r = root.to_str().unwrap().to_string();
        git(&r, &["init", "-q"]).unwrap();
        // A logical name that can't coincide with the auto-detected default, so the assertion holds
        // regardless of this machine's `init.defaultBranch`.
        assert_eq!(effective_base(&r, "feature-x", false), "feature-x");
    }

    // End-to-end: opening an agent whose persisted baseBranch drifted to a now-missing branch
    // used to dead-end with `fatal: invalid reference: main`. It must instead cut the worktree
    // from the repo's real default branch.
    #[test]
    fn create_worktree_survives_a_missing_recorded_base_branch() {
        let r = init_repo("wt-drift"); // on `main`
        let main_sha = git(&r, &["rev-parse", "main"]).unwrap();
        git(&r, &["branch", "-m", "main", "master"]).unwrap();
        let app_data = unique_root("wt-drift-appdata");

        // Recorded baseBranch is the stale "main" — creation must survive it, not hard-fail.
        let info = create_worktree_at(&r, "p1", "a1", "main", &app_data)
            .expect("worktree creation must survive a drifted base branch");
        assert!(
            git(&info.path, &["rev-parse", "--is-inside-work-tree"]).is_ok(),
            "a real worktree was created"
        );
        // The agent branch was cut from the surviving default (same tip main used to point at).
        assert_eq!(
            git(&info.path, &["rev-parse", "HEAD"]).unwrap(),
            main_sha,
            "new branch descends from the detected default branch's tip"
        );
    }

    // Degenerate but real: opening an agent in a freshly `git init`'d repo with NO commits (unborn
    // HEAD). `effective_base` finds nothing resolvable and hands back the logical name verbatim, so
    // the raw `git worktree add` used to dead-end with a cryptic `fatal: invalid reference: <name>`.
    // Creation must instead fail with a clear, actionable message (and never leave a half-made tree).
    #[test]
    fn create_worktree_errors_clearly_in_an_unborn_repo() {
        let root = unique_root("wt-unborn");
        let r = root.to_str().unwrap().to_string();
        git(&r, &["init", "-q"]).unwrap();
        let app_data = unique_root("wt-unborn-appdata");

        let err = match create_worktree_at(&r, "p1", "a1", "main", &app_data) {
            Ok(_) => panic!("creation must fail when the repo has no commit to branch from"),
            Err(e) => e,
        };
        assert!(
            err.contains("no commits yet"),
            "error must explain the unborn-repo cause, got: {err}"
        );
        assert!(
            !err.contains("invalid reference"),
            "the cryptic raw-git error must not leak to the user, got: {err}"
        );
    }

    #[test]
    fn safe_delete_removes_a_merged_branch() {
        let r = init_repo("safedel-merged");
        // A merged agent branch: branch off main, commit, merge back into main.
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-m1"]).unwrap();
        git(&r, &["commit", "--allow-empty", "-m", "work"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();
        git(&r, &["merge", "--no-ff", "-m", "merge", "sparkle/agent-m1"]).unwrap();
        assert!(branch_exists(&r, "sparkle/agent-m1"));

        let out = delete_agent_branch_if_merged_at(&r, "m1").unwrap();
        assert_eq!(out, BranchDeleteOutcome::Deleted, "the caller must be told it was deleted");
        assert!(!branch_exists(&r, "sparkle/agent-m1"), "merged branch should be deleted");
    }

    // THE POINT OF THE OUTCOME TYPE. This command reports success (`Ok`) whether it deleted the
    // branch or kept it, so a caller that reads "the call resolved" as "the branch is gone" tells the
    // human a branch was deleted while it is still sitting there. The outcome is the only thing that
    // distinguishes the two, so every arm asserts it explicitly.
    #[test]
    fn safe_delete_reports_the_outcome_it_actually_produced() {
        let r = init_repo("safedel-outcome");
        // Kept: a real unmerged change.
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-k1"]).unwrap();
        std::fs::write(format!("{r}/k.txt"), "unmerged work").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-m", "work"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();
        assert_eq!(
            delete_agent_branch_if_merged_at(&r, "k1").unwrap(),
            BranchDeleteOutcome::KeptNotMerged,
            "an unmerged branch is KEPT, and the caller must be able to see that"
        );
        assert!(branch_exists(&r, "sparkle/agent-k1"));

        // Absent: never existed. Distinct from "deleted" — nothing was destroyed here.
        assert_eq!(
            delete_agent_branch_if_merged_at(&r, "ghost").unwrap(),
            BranchDeleteOutcome::AlreadyAbsent
        );
    }

    // The force-delete used to be `let _ = git(...)`, so a `-D` that failed (e.g. the branch is
    // checked out in a worktree) still returned Ok and read as "deleted". Now it propagates.
    #[test]
    fn safe_delete_propagates_a_failed_force_delete_instead_of_swallowing_it() {
        let r = init_repo("safedel-checkedout");
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-c1"]).unwrap();
        git(&r, &["commit", "--allow-empty", "-m", "work"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();
        git(&r, &["merge", "--no-ff", "-m", "merge", "sparkle/agent-c1"]).unwrap();
        // Check the (merged) branch out in a second worktree: git now refuses to delete the ref.
        let wt = unique_root("safedel-checkedout-wt");
        git(&r, &["worktree", "add", wt.to_str().unwrap(), "sparkle/agent-c1"]).unwrap();

        let err = delete_agent_branch_if_merged_at(&r, "c1")
            .expect_err("a `git branch -D` that git refuses must not read as a successful delete");
        assert!(!err.is_empty());
        assert!(branch_exists(&r, "sparkle/agent-c1"), "the branch is still there");
    }

    #[test]
    fn discard_delete_reports_deleted_vs_already_absent() {
        let r = init_repo("discard-outcome");
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-d1"]).unwrap();
        std::fs::write(format!("{r}/d.txt"), "unmerged").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-m", "work"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();

        // Discard force-deletes even an unmerged branch — that IS what Discard means.
        assert_eq!(delete_agent_branch_at(&r, "d1").unwrap(), BranchDeleteOutcome::Deleted);
        assert!(!branch_exists(&r, "sparkle/agent-d1"));
        // Idempotent, but the second call must not claim to have deleted anything.
        assert_eq!(delete_agent_branch_at(&r, "d1").unwrap(), BranchDeleteOutcome::AlreadyAbsent);
    }

    #[test]
    fn safe_delete_keeps_an_unmerged_branch() {
        let r = init_repo("safedel-unmerged");
        // An UNMERGED agent branch with a REAL change (a file main doesn't have), so merging it into
        // main would genuinely add something — neither an ancestor nor a net-noop. (An empty commit
        // would net-add-nothing and correctly read as landed, so it must carry actual content here.)
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-u1"]).unwrap();
        std::fs::write(format!("{r}/u.txt"), "unmerged work").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-m", "work"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();
        assert!(branch_exists(&r, "sparkle/agent-u1"));

        let out = delete_agent_branch_if_merged_at(&r, "u1").unwrap();
        assert_eq!(out, BranchDeleteOutcome::KeptNotMerged, "the caller must be told it was KEPT");
        assert!(branch_exists(&r, "sparkle/agent-u1"), "unmerged branch must be kept");
    }

    #[test]
    fn safe_delete_removes_a_squash_merged_branch() {
        let r = init_repo("safedel-squash");
        // A squash-merged agent branch: its changes land on main as a NEW commit, so the branch tip
        // is NOT an ancestor of main (plain `git branch -d` would wrongly refuse). The merge-tree
        // check (merge_adds_nothing) still recognizes it as landed.
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-s1"]).unwrap();
        std::fs::write(format!("{r}/f.txt"), "hello").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-m", "work"]).unwrap();
        git(&r, &["checkout", "-q", "main"]).unwrap();
        git(&r, &["merge", "--squash", "sparkle/agent-s1"]).unwrap();
        git(&r, &["commit", "-m", "squash work"]).unwrap();
        assert!(branch_exists(&r, "sparkle/agent-s1"));

        delete_agent_branch_if_merged_at(&r, "s1").unwrap();
        assert!(!branch_exists(&r, "sparkle/agent-s1"), "squash-merged branch should be deleted");
    }

    #[test]
    fn safe_delete_removes_a_branch_merged_only_on_origin() {
        // The REAL GitHub path: the squash commit lands on origin/main, NOT local main. The delete
        // must still recognize it (the prior local-only check would wrongly keep the branch).
        let r = init_repo("safedel-origin");
        let origin = unique_root("safedel-origin-remote");
        let o = origin.to_str().unwrap();
        git(o, &["init", "--bare", "-q"]).unwrap();
        git(&r, &["remote", "add", "origin", o]).unwrap();
        git(&r, &["push", "-q", "origin", "main"]).unwrap();

        git(&r, &["checkout", "-q", "-b", "sparkle/agent-o1"]).unwrap();
        std::fs::write(format!("{r}/f.txt"), "hi").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-m", "work"]).unwrap();

        // Squash-merge onto main, push to origin, then REWIND local main so the merge exists ONLY on
        // origin/main (mirroring the desktop flow where local main isn't fast-forwarded after a PR).
        git(&r, &["checkout", "-q", "main"]).unwrap();
        git(&r, &["merge", "--squash", "sparkle/agent-o1"]).unwrap();
        git(&r, &["commit", "-m", "squash"]).unwrap();
        git(&r, &["push", "-q", "origin", "main"]).unwrap();
        git(&r, &["reset", "-q", "--hard", "HEAD~1"]).unwrap();
        git(&r, &["fetch", "-q", "origin"]).unwrap();
        assert!(branch_exists(&r, "sparkle/agent-o1"));

        delete_agent_branch_if_merged_at(&r, "o1").unwrap();
        assert!(
            !branch_exists(&r, "sparkle/agent-o1"),
            "branch merged only on origin/main should be deleted"
        );
    }

    #[test]
    fn safe_delete_is_idempotent_for_a_missing_branch() {
        let r = init_repo("safedel-missing");
        delete_agent_branch_if_merged_at(&r, "nope").unwrap(); // no such branch → Ok
    }

    #[test]
    fn decode_commit_pulls_folds_state() {
        // Open PR: state "open", no merge timestamp, link comes from `html_url`.
        let open = json!([{ "number": 7, "state": "open", "merged_at": Value::Null, "html_url": "https://gh/7" }]);
        let (s, n, u) = decode_commit_pulls(open.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("open"));
        assert_eq!(n, Some(7));
        assert_eq!(u.as_deref(), Some("https://gh/7"));

        // Merged: the endpoint still says state "closed" — `merged_at` is what proves it merged.
        let merged = json!([{ "number": 8, "state": "closed", "merged_at": "2026-01-01T00:00:00Z", "html_url": "https://gh/8" }]);
        let (s, n, _) = decode_commit_pulls(merged.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("merged"));
        assert_eq!(n, Some(8));

        // Closed but not merged stays "closed".
        let closed = json!([{ "number": 9, "state": "closed", "merged_at": Value::Null }]);
        let (s, _, _) = decode_commit_pulls(closed.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("closed"));

        // No PR associated with the commit ⇒ all-None.
        let (s, n, u) = decode_commit_pulls(&[]);
        assert!(s.is_none() && n.is_none() && u.is_none());
    }

    #[test]
    fn decode_pr_list_url_builds_the_pulls_link() {
        assert_eq!(
            decode_pr_list_url(r#"{"url":"https://github.com/owner/repo"}"#).as_deref(),
            Some("https://github.com/owner/repo/pulls")
        );
        // A trailing slash must not produce a double slash in the path.
        assert_eq!(
            decode_pr_list_url(r#"{"url":"https://github.com/owner/repo/"}"#).as_deref(),
            Some("https://github.com/owner/repo/pulls")
        );
        // Enterprise / self-hosted hosts work the same way — nothing here assumes github.com.
        assert_eq!(
            decode_pr_list_url(r#"{"url":"https://git.example.com/team/app"}"#).as_deref(),
            Some("https://git.example.com/team/app/pulls")
        );
    }

    #[test]
    fn decode_pr_list_url_refuses_anything_that_is_not_a_plausible_https_url() {
        // Rather than open a half-built or attacker-influenced link, decline to navigate at all.
        assert_eq!(decode_pr_list_url(""), None);
        assert_eq!(decode_pr_list_url("not json"), None);
        assert_eq!(decode_pr_list_url("{}"), None);
        assert_eq!(decode_pr_list_url(r#"{"url":""}"#), None);
        assert_eq!(decode_pr_list_url(r#"{"url":"http://insecure/repo"}"#), None);
        assert_eq!(decode_pr_list_url(r#"{"url":"javascript:alert(1)"}"#), None);
        assert_eq!(decode_pr_list_url(r#"{"url":"file:///etc/passwd"}"#), None);
    }

    #[test]
    fn decode_open_pr_count_counts_rows() {
        assert_eq!(decode_open_pr_count("[]"), Some(0));
        assert_eq!(decode_open_pr_count(r#"[{"number":1}]"#), Some(1));
        assert_eq!(decode_open_pr_count(r#"[{"number":1},{"number":2},{"number":3}]"#), Some(3));
    }

    #[test]
    fn decode_open_pr_count_reads_garbage_as_unknown_not_zero() {
        // The whole point of the badge is that it must never claim "nothing is waiting" when it
        // simply failed to look. An empty array is a KNOWN zero; everything else that isn't a
        // JSON array is UNKNOWN, and the UI renders nothing rather than a reassuring "0".
        assert_eq!(decode_open_pr_count(""), None);
        assert_eq!(decode_open_pr_count("not json"), None);
        assert_eq!(decode_open_pr_count("gh: command not found"), None);
        // A JSON object (e.g. an error payload) is not a row list either.
        assert_eq!(decode_open_pr_count(r#"{"message":"Bad credentials"}"#), None);
        // Known-zero and unknown are genuinely different values, not just different renderings.
        assert_ne!(decode_open_pr_count("[]"), decode_open_pr_count("Bad credentials"));
    }

    #[test]
    fn classify_checks_lets_failure_dominate_then_pending_then_success() {
        // Empty rollup → "none" (a PR with no CI at all, not an unknown).
        assert_eq!(classify_checks(&[]), "none");
        // All green check runs → passing; a neutral/skipped conclusion doesn't block.
        assert_eq!(
            classify_checks(&[
                json!({ "status": "COMPLETED", "conclusion": "SUCCESS" }),
                json!({ "status": "COMPLETED", "conclusion": "SKIPPED" }),
                json!({ "status": "COMPLETED", "conclusion": "NEUTRAL" }),
            ]),
            "passing"
        );
        // A still-running check makes the whole rollup pending, even beside green ones.
        assert_eq!(
            classify_checks(&[
                json!({ "status": "COMPLETED", "conclusion": "SUCCESS" }),
                json!({ "status": "IN_PROGRESS", "conclusion": Value::Null }),
            ]),
            "pending"
        );
        // A single failure dominates both pending and success.
        assert_eq!(
            classify_checks(&[
                json!({ "status": "COMPLETED", "conclusion": "SUCCESS" }),
                json!({ "status": "IN_PROGRESS", "conclusion": Value::Null }),
                json!({ "status": "COMPLETED", "conclusion": "FAILURE" }),
            ]),
            "failing"
        );
        // Legacy commit-status contexts (a single `state`) classify the same way.
        assert_eq!(classify_checks(&[json!({ "state": "SUCCESS" })]), "passing");
        assert_eq!(classify_checks(&[json!({ "state": "PENDING" })]), "pending");
        assert_eq!(classify_checks(&[json!({ "state": "FAILURE" })]), "failing");
        assert_eq!(classify_checks(&[json!({ "state": "ERROR" })]), "failing");
    }

    /// A throwaway repo with one commit — enough for `git status --porcelain` to be meaningful.
    fn scratch_repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().to_string_lossy().to_string();
        git(&root, &["init"]).unwrap();
        git(&root, &["config", "user.email", "t@t.local"]).unwrap();
        git(&root, &["config", "user.name", "T"]).unwrap();
        git(&root, &["commit", "--allow-empty", "-m", "init"]).unwrap();
        d
    }

    #[test]
    fn append_missing_ignores_is_idempotent_and_accepts_the_slashless_form() {
        // Nothing to add → None, so the caller never rewrites an untouched file.
        assert!(append_missing_ignores(".sparkle/\n.wt-*/\n", &[".sparkle/", ".wt-*/"]).is_none());
        // A hand-written slashless entry still counts — we must not append a near-duplicate.
        assert!(append_missing_ignores(".sparkle\n", &[".sparkle/"]).is_none());
        // Only the genuinely missing pattern is appended.
        let out = append_missing_ignores(".sparkle/\n", &[".sparkle/", ".wt-*/"]).unwrap();
        assert_eq!(out, ".sparkle/\n.wt-*/\n");
        // A file with no trailing newline gets one rather than a glued-on pattern.
        assert_eq!(append_missing_ignores("x", &[".wt-*/"]).unwrap(), "x\n.wt-*/\n");
    }

    #[test]
    fn ensure_gitignore_leaves_an_already_provisioned_project_byte_for_byte_alone() {
        // roborev 55374: this must NOT append the scratch-worktree patterns. A project whose
        // .gitignore already has `.sparkle/` is fully provisioned, and appending to a TRACKED file on
        // every open is an unrequested edit to the user's repo — it lands in their `git status` and
        // can be swept into a `git commit -a`. The patterns belong in info/exclude, which is
        // untracked. Byte-for-byte so any future append fails this immediately.
        let d = scratch_repo();
        let root = d.path().to_string_lossy().to_string();
        let before = "node_modules/\n.sparkle/\n*.log\n";
        std::fs::write(d.path().join(".gitignore"), before).unwrap();
        ensure_gitignore(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(d.path().join(".gitignore")).unwrap(),
            before,
            "dirtied a tracked file in an already-provisioned project",
        );
    }

    #[test]
    fn ensure_gitignore_still_seeds_sparkle_and_preserves_existing_rules() {
        let d = scratch_repo();
        let root = d.path().to_string_lossy().to_string();
        std::fs::write(d.path().join(".gitignore"), "node_modules/\n*.log\n").unwrap();
        ensure_gitignore(&root).unwrap();
        let written = std::fs::read_to_string(d.path().join(".gitignore")).unwrap();
        assert!(written.contains("node_modules/"), "clobbered the user's rules: {written:?}");
        assert!(written.contains("*.log"));
        assert!(written.lines().any(|l| l.trim() == ".sparkle/"), "{written:?}");
    }

    #[test]
    fn scratch_worktrees_stop_reading_as_untracked_dirt_via_info_exclude() {
        // THE SIDE EFFECT, not the precondition: a `.wt-*` directory must actually disappear from
        // `git status --porcelain`, because that is the exact string the park declines on. Asserting
        // only that a line was written to a file would pass even if the pattern never matched.
        let d = scratch_repo();
        let root = d.path().to_string_lossy().to_string();
        std::fs::create_dir_all(d.path().join(".wt-ci-node")).unwrap();
        std::fs::write(d.path().join(".wt-ci-node/f"), "x").unwrap();
        std::fs::create_dir_all(d.path().join(".claude/worktrees/x")).unwrap();
        std::fs::write(d.path().join(".claude/worktrees/x/f"), "x").unwrap();
        // The improvement pass's OWN scratch, the `??` entries observed wedging the live park.
        std::fs::create_dir_all(d.path().join(".sparkle-improve-wt")).unwrap();
        std::fs::write(d.path().join(".sparkle-improve-wt/f"), "x").unwrap();
        std::fs::create_dir_all(d.path().join(".sparkle-scratch")).unwrap();
        std::fs::write(d.path().join(".sparkle-scratch/f"), "x").unwrap();

        // Baseline: without the fix this repo IS dirty — proves the assertion below can fail.
        let before = git(&root, &["status", "--porcelain"]).unwrap();
        assert!(before.contains(".wt-ci-node"), "expected dirt to start with: {before:?}");
        assert!(before.contains(".sparkle-improve-wt"), "expected pass-scratch dirt: {before:?}");

        // Deliberately NOT ensure_gitignore: info/exclude alone must do it, since that is the half
        // that works on a worktree pinned to a branch predating the tracked rule.
        ensure_worktree_excludes(&root).unwrap();
        let after = git(&root, &["status", "--porcelain"]).unwrap();
        assert!(!after.contains(".wt-ci-node"), "scratch worktree still dirty: {after:?}");
        assert!(!after.contains(".claude/worktrees"), "still dirty: {after:?}");
        // The exact strings the park declined on, hour after hour, now gone from the status read.
        assert!(!after.contains(".sparkle-improve-wt"), "pass scratch worktree still dirty: {after:?}");
        assert!(!after.contains(".sparkle-scratch"), "pass scratch dir still dirty: {after:?}");
        assert!(after.trim().is_empty(), "expected a clean tree, got {after:?}");
    }

    #[test]
    fn the_dot_prefix_keeps_the_glob_off_real_source_directories() {
        // The commit calls the dot prefix load-bearing; this is what holds it to that. A bare `wt-*`
        // would swallow `wt-real.ts` and `src/wt-foo/`, silently un-tracking real source.
        //
        // `check-ignore` rather than `status --porcelain`: status collapses an untracked directory to
        // its parent (`?? src/`), so it cannot distinguish "src/wt-foo is ignored" from "src/ is
        // simply reported one level up". check-ignore answers the actual question per path.
        let d = scratch_repo();
        let root = d.path().to_string_lossy().to_string();
        ensure_worktree_excludes(&root).unwrap();
        let ignored = |p: &str| git(&root, &["check-ignore", "-q", "--no-index", p]).is_ok();

        // Ignored — the two paths agents are told to use, plus the pass's own `.sparkle-` scratch.
        assert!(ignored(".wt-ci-node/"), ".wt-*/ should be ignored");
        assert!(ignored(".claude/worktrees/x/"), ".claude/worktrees/ should be ignored");
        assert!(ignored(".sparkle-improve-wt/"), ".sparkle-*/ should ignore the pass scratch worktree");
        assert!(ignored(".sparkle-scratch/"), ".sparkle-*/ should ignore the pass scratch dir");
        // NOT ignored — real source that a bare `wt-*` would have swallowed.
        assert!(!ignored("wt-real.ts"), "a real source FILE must not be ignored");
        assert!(!ignored("src/wt-foo/"), "a real source DIRECTORY must not be ignored");
        assert!(!ignored("wt-foo/"), "an undotted top-level dir must not be ignored");
        // The hyphen keeps the glob OFF the tracked `.sparkle/` config dir and off real source.
        assert!(!ignored(".sparkle/config.toml"), "the tracked .sparkle/ config dir must not be ignored");
        assert!(!ignored("sparkle-real.ts"), "an undotted source file must not be ignored");
    }

    #[test]
    fn ensure_worktree_excludes_is_idempotent_and_keeps_existing_excludes() {
        let d = scratch_repo();
        let root = d.path().to_string_lossy().to_string();
        let exclude = common_dir_for(&root).join("info").join("exclude");
        std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        std::fs::write(&exclude, "# user's own\nscratch.txt\n").unwrap();

        ensure_worktree_excludes(&root).unwrap();
        let once = std::fs::read_to_string(&exclude).unwrap();
        ensure_worktree_excludes(&root).unwrap();
        let twice = std::fs::read_to_string(&exclude).unwrap();

        assert_eq!(once, twice, "second call appended duplicates");
        assert!(once.contains("scratch.txt"), "clobbered the user's excludes: {once:?}");
        assert_eq!(once.lines().filter(|l| l.trim() == ".wt-*/").count(), 1);
    }

    #[test]
    fn ensure_worktree_excludes_hides_the_beads_store_from_status() {
        // sparkle-3u61: a beads store symlinked to a canonical clone reads as
        // `?? .beads/embeddeddolt` because `.beads/.gitignore`'s `embeddeddolt/` is DIRECTORY-ONLY
        // (trailing slash) and does not match a symlink. `park_worktree_on_base` declines `dirty` on
        // any such untracked entry, so the store wedged the hourly pass permanently. The seeded
        // excludes must cover the store by path so it never counts as blocking dirt — whether it is a
        // symlink, a dir or a file, and regardless of a stale checked-out `.beads/.gitignore`.
        let d = scratch_repo();
        let root = d.path().to_string_lossy().to_string();

        // `.beads/` must hold a TRACKED file, because the real repo does (`.beads/config.yaml`,
        // `metadata.json`, `README.md` and `hooks/*` are all in git — `bd` needs `metadata.json` to
        // resolve the DB). Without one, git COLLAPSES the wholly-untracked directory and reports
        // `?? .beads/` instead of descending to `?? .beads/embeddeddolt/` — which is what made the
        // precondition below unsatisfiable in CI. Measured both ways:
        //     nothing tracked under .beads/  -> "?? .beads/"
        //     a tracked file under .beads/   -> "?? .beads/embeddeddolt/"
        // The second is the shape the wedge actually has, so it is the shape this test must build.
        std::fs::create_dir_all(d.path().join(".beads")).unwrap();
        std::fs::write(d.path().join(".beads/config.yaml"), b"# tracked, as in the real repo\n").unwrap();
        git(&root, &["add", ".beads/config.yaml"]).unwrap();
        git(&root, &["commit", "-m", "beads config (tracked, mirrors the real repo)"]).unwrap();

        // A real untracked entry at the store path. A plain dir stands in for the symlink: both are
        // untracked, and the scratch repo has no `.beads/.gitignore` at all, so ONLY the seeded
        // `info/exclude` can hide it. That is exactly the path under test.
        std::fs::create_dir_all(d.path().join(".beads/embeddeddolt")).unwrap();
        std::fs::write(d.path().join(".beads/embeddeddolt/store"), b"x").unwrap();

        // Precondition: without the seeded exclude, the store reads as blocking dirt — the wedge.
        let before = git(&root, &["status", "--porcelain"]).unwrap();
        assert!(
            before.contains(".beads/embeddeddolt"),
            "precondition: the store should read as untracked dirt before excludes are seeded: {before:?}"
        );

        ensure_worktree_excludes(&root).unwrap();

        // Side effect under test: the store no longer appears in status, so the park will not decline
        // `dirty` on it. Fails if `.beads/embeddeddolt` is absent from AGENT_WORKTREE_IGNORES.
        let after = git(&root, &["status", "--porcelain"]).unwrap();
        assert!(
            !after.contains(".beads/embeddeddolt"),
            "the beads store must be excluded so the hourly park does not decline 'dirty': {after:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn ensure_worktree_excludes_hides_a_symlinked_beads_store() {
        // THE DISCRIMINATING CASE (roborev 56704). The sibling test above builds the store as a plain
        // DIRECTORY, which both the shipped slash-less `.beads/embeddeddolt` and the buggy
        // directory-only `.beads/embeddeddolt/` match — so it cannot tell a correct pattern from the
        // one that caused sparkle-3u61. And `append_missing_ignores` deliberately treats `p` and
        // `p.trim_end_matches('/')` as equivalent, so someone "normalizing" AGENT_WORKTREE_IGNORES to
        // a trailing slash would reintroduce the exact wedge with the whole suite still green.
        //
        // A SYMLINK is what actually separates them. Measured against real git:
        //     pattern `.beads/embeddeddolt/` + symlink  ->  "?? .beads/embeddeddolt"   (the wedge)
        //     pattern `.beads/embeddeddolt`  + symlink  ->  ""                          (hidden)
        //     pattern `.beads/embeddeddolt/` + dir      ->  ""                          (no signal)
        // So this test fails against a trailing-slash pattern and passes against the shipped one,
        // which is the assertion the directory case cannot make.
        //
        // This is the shape the live machine was actually in: a beads consolidation left
        // `.beads/embeddeddolt` as a symlink to the canonical store, and every hourly park declined
        // `dirty` on it.
        let d = scratch_repo();
        let root = d.path().to_string_lossy().to_string();

        // Tracked content under `.beads/`, for the same reason as the sibling test: without it git
        // collapses the whole untracked directory to `?? .beads/` and never names the store.
        std::fs::create_dir_all(d.path().join(".beads")).unwrap();
        std::fs::write(d.path().join(".beads/config.yaml"), b"# tracked, as in the real repo\n").unwrap();
        git(&root, &["add", ".beads/config.yaml"]).unwrap();
        git(&root, &["commit", "-m", "beads config (tracked, mirrors the real repo)"]).unwrap();

        // The store as a SYMLINK to a canonical clone living outside the repo.
        let canonical = d.path().join("canonical-store");
        std::fs::create_dir_all(&canonical).unwrap();
        std::os::unix::fs::symlink(&canonical, d.path().join(".beads/embeddeddolt")).unwrap();

        let before = git(&root, &["status", "--porcelain"]).unwrap();
        assert!(
            before.contains(".beads/embeddeddolt"),
            "precondition: a symlinked store must read as untracked dirt before excludes are seeded: {before:?}"
        );

        ensure_worktree_excludes(&root).unwrap();

        let after = git(&root, &["status", "--porcelain"]).unwrap();
        assert!(
            !after.contains(".beads/embeddeddolt"),
            "a SYMLINKED beads store must be excluded too — a directory-only pattern (trailing \
             slash) does not match a symlink, which is the sparkle-3u61 wedge: {after:?}"
        );
    }

    #[test]
    fn common_dir_for_resolves_a_linked_worktree_to_the_shared_gitdir() {
        // The whole point of using info/exclude: it must be the COMMON dir, shared by every linked
        // worktree, so seeding it once covers a wedged worktree too. A per-worktree gitdir would not.
        let d = scratch_repo();
        let root = d.path().to_string_lossy().to_string();
        let wt = d.path().join("linked");
        git(&root, &["worktree", "add", "--detach", &wt.to_string_lossy(), "HEAD"]).unwrap();
        let wt_str = wt.to_string_lossy().to_string();
        assert_eq!(
            std::fs::canonicalize(common_dir_for(&wt_str)).unwrap(),
            std::fs::canonicalize(common_dir_for(&root)).unwrap(),
            "a linked worktree must resolve to the same shared gitdir as its parent",
        );
    }

    #[test]
    fn normalize_mergeable_maps_only_the_two_terminal_values() {
        assert_eq!(normalize_mergeable(Some("MERGEABLE")), "mergeable");
        assert_eq!(normalize_mergeable(Some("CONFLICTING")), "conflicting");
        // UNKNOWN (async-not-yet-computed), an unexpected value, and a missing field all read as
        // "unknown" — the UI treats that as "let gh decide", never as a block.
        assert_eq!(normalize_mergeable(Some("UNKNOWN")), "unknown");
        assert_eq!(normalize_mergeable(Some("SOMETHING_NEW")), "unknown");
        assert_eq!(normalize_mergeable(None), "unknown");
    }

    #[test]
    fn decode_open_prs_shapes_rows_and_defaults_missing_fields() {
        let rows = decode_open_prs(
            r#"[
                {
                    "number": 42,
                    "title": "fix: a thing",
                    "headRefName": "sparkle/agent-abc",
                    "url": "https://github.com/o/r/pull/42",
                    "mergeable": "MERGEABLE",
                    "mergeStateStatus": "CLEAN",
                    "statusCheckRollup": [{ "status": "COMPLETED", "conclusion": "SUCCESS" }]
                },
                { "number": 7 }
            ]"#,
        )
        .expect("valid array decodes");
        assert_eq!(
            rows[0],
            PrRow {
                number: 42,
                title: "fix: a thing".into(),
                head_ref_name: "sparkle/agent-abc".into(),
                url: "https://github.com/o/r/pull/42".into(),
                checks: "passing".into(),
                mergeable: "mergeable".into(),
                merge_state_status: "clean".into(),
                failing_checks: vec![],
                pending_checks: vec![],
                // Ownership is attached by `attach_pr_owners`, not by the pure decoder.
                agent_id: None,
                agent_id_source: None,
                body: String::new(),
            }
        );
        // A sparse row keeps its number and defaults the rest — a missing rollup is "none", a missing
        // mergeable is "unknown", and a missing merge state is "unknown" (never "clean": an absent
        // answer must not read as a safe one).
        assert_eq!(
            rows[1],
            PrRow {
                number: 7,
                title: String::new(),
                head_ref_name: String::new(),
                url: String::new(),
                checks: "none".into(),
                mergeable: "unknown".into(),
                merge_state_status: "unknown".into(),
                failing_checks: vec![],
                pending_checks: vec![],
                agent_id: None,
                agent_id_source: None,
                body: String::new(),
            }
        );
    }

    /// THE UNSTABLE CASE, decoded end-to-end from the real `gh pr list` shape.
    ///
    /// PR #934 as GitHub actually reported it: `mergeable: MERGEABLE` (git would accept the merge)
    /// with `mergeStateStatus: UNSTABLE` because two non-required checks are red. The decoder has to
    /// keep those two facts APART — collapsing them is what put a one-click Merge under a
    /// non-green dot — and it has to carry the failing checks BY NAME so the UI can say which.
    #[test]
    fn decode_open_prs_keeps_mergeable_and_merge_state_apart_and_names_the_failing_checks() {
        let rows = decode_open_prs(
            r#"[{
                "number": 934,
                "mergeable": "MERGEABLE",
                "mergeStateStatus": "UNSTABLE",
                "statusCheckRollup": [
                    { "name": "Node — static", "status": "COMPLETED", "conclusion": "SUCCESS" },
                    { "name": "Node — coverage (shard 3/4)", "status": "COMPLETED", "conclusion": "FAILURE" },
                    { "name": "Node — typecheck · test · build", "status": "COMPLETED", "conclusion": "FAILURE" },
                    { "name": "Vercel Agent Review", "status": "IN_PROGRESS" }
                ]
            }]"#,
        )
        .expect("valid array decodes");
        let r = &rows[0];
        // Mergeable per git, and NOT clean per GitHub. Both true at once; that is the whole point.
        assert_eq!(r.mergeable, "mergeable");
        assert_eq!(r.merge_state_status, "unstable");
        // A failure dominates the rollup word even with a check still running.
        assert_eq!(r.checks, "failing");
        assert_eq!(
            r.failing_checks,
            vec!["Node — coverage (shard 3/4)", "Node — typecheck · test · build"]
        );
        assert_eq!(r.pending_checks, vec!["Vercel Agent Review"]);
    }

    /// PR #944 as GitHub reported it: a genuine conflict, with a check still running. The conflict
    /// is the headline, but the pending check is still carried — the UI names both.
    #[test]
    fn decode_open_prs_carries_a_conflict_alongside_a_still_running_check() {
        let rows = decode_open_prs(
            r#"[{
                "number": 944,
                "mergeable": "CONFLICTING",
                "mergeStateStatus": "DIRTY",
                "statusCheckRollup": [
                    { "name": "Vercel Agent Review", "status": "IN_PROGRESS" },
                    { "context": "Vercel", "state": "SUCCESS" }
                ]
            }]"#,
        )
        .expect("valid array decodes");
        assert_eq!(rows[0].mergeable, "conflicting");
        assert_eq!(rows[0].merge_state_status, "dirty");
        assert_eq!(rows[0].checks, "pending");
        assert!(rows[0].failing_checks.is_empty());
        assert_eq!(rows[0].pending_checks, vec!["Vercel Agent Review"]);
    }

    #[test]
    fn collect_check_names_buckets_by_state_dedupes_and_falls_back_to_context() {
        let rollup = vec![
            json!({ "name": "ok", "status": "COMPLETED", "conclusion": "SUCCESS" }),
            json!({ "name": "red", "status": "COMPLETED", "conclusion": "FAILURE" }),
            // Same check reported twice (a re-run) must be named once, not counted twice.
            json!({ "name": "red", "status": "COMPLETED", "conclusion": "FAILURE" }),
            // A legacy commit status names itself with `context`, not `name`.
            json!({ "context": "legacy-ci", "state": "ERROR" }),
            json!({ "context": "legacy-slow", "state": "PENDING" }),
            json!({ "name": "running", "status": "QUEUED" }),
            // Neither name nor context: still a real failing check, so still counted.
            json!({ "status": "COMPLETED", "conclusion": "TIMED_OUT" }),
        ];
        let (failing, pending) = collect_check_names(&rollup);
        assert_eq!(failing, vec!["red", "legacy-ci", "unnamed check"]);
        assert_eq!(pending, vec!["legacy-slow", "running"]);
    }

    /// The names and the rollup word are two readings of the same array, and they must agree.
    /// A green rollup with a name in the failing list (or vice versa) is the drift `check_state`
    /// exists to make impossible.
    #[test]
    fn check_names_and_the_rollup_word_never_disagree() {
        let cases: Vec<Vec<Value>> = vec![
            vec![],
            vec![json!({ "name": "a", "status": "COMPLETED", "conclusion": "SUCCESS" })],
            vec![json!({ "name": "a", "status": "COMPLETED", "conclusion": "SKIPPED" })],
            vec![json!({ "name": "a", "status": "IN_PROGRESS" })],
            vec![json!({ "name": "a", "status": "COMPLETED", "conclusion": "FAILURE" })],
            vec![
                json!({ "name": "a", "status": "COMPLETED", "conclusion": "FAILURE" }),
                json!({ "name": "b", "status": "IN_PROGRESS" }),
            ],
            vec![json!({ "context": "c", "state": "EXPECTED" })],
        ];
        for rollup in cases {
            let word = classify_checks(&rollup);
            let (failing, pending) = collect_check_names(&rollup);
            match word {
                // "failing" must name at least one failing check, or the label would read
                // "0 checks failing" beside a red dot.
                "failing" => assert!(!failing.is_empty(), "failing word with no named check"),
                // "pending" means nothing failed, and something is running.
                "pending" => {
                    assert!(failing.is_empty(), "pending word but a check is failing");
                    assert!(!pending.is_empty(), "pending word with no named check");
                }
                // "passing"/"none" must have nothing outstanding at all — this is the case that
                // guards a GREEN dot, so it is the one that matters most.
                _ => {
                    assert!(failing.is_empty(), "{word} word but a check is failing");
                    assert!(pending.is_empty(), "{word} word but a check is running");
                }
            }
        }
    }

    #[test]
    fn normalize_merge_state_maps_the_github_enum_and_defaults_unknown() {
        assert_eq!(normalize_merge_state(Some("CLEAN")), "clean");
        assert_eq!(normalize_merge_state(Some("DIRTY")), "dirty");
        assert_eq!(normalize_merge_state(Some("UNSTABLE")), "unstable");
        assert_eq!(normalize_merge_state(Some("BLOCKED")), "blocked");
        assert_eq!(normalize_merge_state(Some("BEHIND")), "behind");
        assert_eq!(normalize_merge_state(Some("DRAFT")), "draft");
        assert_eq!(normalize_merge_state(Some("HAS_HOOKS")), "has_hooks");
        // An unrecognised or absent state must never read as "clean" — an unknown answer is not a
        // safe answer.
        assert_eq!(normalize_merge_state(Some("SOMETHING_NEW")), "unknown");
        assert_eq!(normalize_merge_state(None), "unknown");
    }

    #[test]
    fn attach_pr_owners_names_the_agent_for_a_descriptive_branch_and_stays_null_otherwise() {
        // THE HEADLINE CASE. `sparkle/left-pair` (#806) carries no agent id anywhere, so the old
        // branch-name parse could only say "owner unresolved". Now the recorded mapping answers it,
        // while a PR nothing knows about stays honestly null rather than borrowing a neighbour's id.
        let d = tempfile::tempdir().unwrap();
        crate::pr_owner::record_pr_created(d.path(), "p1", 806, "agent-cockpit", "sparkle/left-pair")
            .unwrap();
        let rows = decode_open_prs(
            r#"[
                { "number": 806, "headRefName": "sparkle/left-pair" },
                { "number": 802, "headRefName": "sparkle/router-skip-doomed-classify" },
                { "number": 804, "headRefName": "sparkle/agent-9e48bf5c-02fb-499b-9bc7-d24034577799" }
            ]"#,
        )
        .unwrap();
        let out = attach_pr_owners(rows, "p1", d.path());

        assert_eq!(out[0].agent_id.as_deref(), Some("agent-cockpit"));
        assert_eq!(out[0].agent_id_source.as_deref(), Some(crate::pr_owner::SOURCE_CREATED));
        // Nothing has ever identified #802 — null, never a guess.
        assert_eq!(out[1].agent_id, None);
        assert_eq!(out[1].agent_id_source, None);
        // The legacy convention still resolves, and is now BACKFILLED into the durable store, so it
        // survives the branch being renamed or deleted.
        assert_eq!(
            out[2].agent_id.as_deref(),
            Some("9e48bf5c-02fb-499b-9bc7-d24034577799")
        );
        let store = crate::pr_owner::load_store(d.path());
        assert_eq!(
            crate::pr_owner::resolve_owner(&store, "p1", 804, "", "").unwrap().agent_id,
            "9e48bf5c-02fb-499b-9bc7-d24034577799",
        );
        // Bodies are read for the marker and then dropped — they must never reach the JS side.
        assert!(out.iter().all(|r| r.body.is_empty()));
    }

    #[test]
    fn attach_pr_owners_reads_the_body_marker_when_the_store_knows_nothing() {
        // A PR opened on ANOTHER machine (or before this store existed) still resolves, because the
        // marker rides along on GitHub rather than on this disk.
        let d = tempfile::tempdir().unwrap();
        let marker = crate::pr_owner::pr_body_marker("agent-elsewhere", "p1");
        let rows = decode_open_prs(&format!(
            r#"[{{ "number": 12, "headRefName": "feature/no-id", "body": "hello\n\n{marker}" }}]"#
        ))
        .unwrap();
        let out = attach_pr_owners(rows, "p1", d.path());
        assert_eq!(out[0].agent_id.as_deref(), Some("agent-elsewhere"));
        assert_eq!(out[0].agent_id_source.as_deref(), Some(crate::pr_owner::SOURCE_PR_BODY));
    }

    #[test]
    fn pr_create_args_embeds_the_ownership_marker_in_the_body() {
        // The marker is the only copy of the mapping that lives on GitHub. If it stops being written
        // the app still works — and silently loses cross-machine resolution — so assert it directly.
        let marker = crate::pr_owner::pr_body_marker("a1", "p1");
        let args = pr_create_args("sparkle/agent-a1", "main", "T", &marker).unwrap();
        let body = args.last().unwrap();
        assert!(body.contains(&marker), "body must carry the owner marker, got {body:?}");
        assert_eq!(
            crate::pr_owner::parse_pr_body_marker(body),
            Some(("a1".into(), "p1".into())),
            "the body we send must parse back to the same owner",
        );
    }

    #[test]
    fn decode_open_prs_reads_garbage_as_unknown_and_drops_only_numberless_rows() {
        // Garbage (not a JSON array) is UNKNOWN — the whole probe drops to None, never an empty list,
        // matching decode_open_pr_count's null-vs-zero discipline.
        assert_eq!(decode_open_prs(""), None);
        assert_eq!(decode_open_prs("not json"), None);
        assert_eq!(decode_open_prs(r#"{"message":"Bad credentials"}"#), None);
        // A known-empty array is Some(empty), not None.
        assert_eq!(decode_open_prs("[]"), Some(vec![]));
        // A row without a number is unusable (nothing to merge/link) and is dropped, but a valid
        // sibling still comes through — one bad row must not blank the menu.
        let rows = decode_open_prs(r#"[{"title":"no number"},{"number":9}]"#).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].number, 9);
    }

    #[test]
    fn every_gh_invocation_goes_through_gh_program() {
        // A Finder/Dock-launched app doesn't inherit the login-shell PATH, so spawning gh by its
        // bare name can't find a homebrew/`~/.local/bin` install — and because every gh caller here
        // SWALLOWS a spawn failure, the miss reads as "no PRs" instead of an error.
        // `preflight::gh_program()` resolves the absolute path and is the only correct spawn form.
        // This is a structural guard, not a behavioral one: the gap has been introduced twice, once
        // per batch of new gh callers, and neither time did a test fail.
        let needle = format!("Command::new(\"{}\")", "gh"); // built at runtime so this test can't match itself
        let src = include_str!("worktree.rs");
        assert!(
            !src.contains(&needle),
            "spawn gh via crate::preflight::gh_program(), not the bare name"
        );
    }

    #[test]
    fn decode_commit_pulls_disambiguates_multiple_prs() {
        // Several PRs contain the tip and the order isn't relevance-sorted: a merged PR wins over
        // anything else, so a trailing closed/open row can't shadow the ship.
        let many = json!([
            { "number": 1, "state": "closed", "merged_at": Value::Null },
            { "number": 2, "state": "open", "merged_at": Value::Null },
            { "number": 3, "state": "closed", "merged_at": "2026-01-01T00:00:00Z" },
        ]);
        let (s, n, _) = decode_commit_pulls(many.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("merged"));
        assert_eq!(n, Some(3));

        // No merged PR ⇒ an OPEN one is preferred over a leading closed row.
        let no_merge = json!([
            { "number": 4, "state": "closed", "merged_at": Value::Null },
            { "number": 5, "state": "open", "merged_at": Value::Null },
        ]);
        let (s, n, _) = decode_commit_pulls(no_merge.as_array().unwrap());
        assert_eq!(s.as_deref(), Some("open"));
        assert_eq!(n, Some(5));
    }

    #[test]
    fn fetch_due_respects_cooldown() {
        let now = Instant::now();
        assert!(fetch_due(None, now), "never fetched ⇒ due");
        assert!(!fetch_due(Some(now), now), "just fetched ⇒ not due");
        let long_ago = now.checked_sub(FETCH_COOLDOWN + Duration::from_secs(1)).unwrap();
        assert!(fetch_due(Some(long_ago), now), "past the cooldown ⇒ due");
        let recent = now.checked_sub(FETCH_COOLDOWN / 2).unwrap();
        assert!(!fetch_due(Some(recent), now), "within the cooldown ⇒ not due");
    }

    // sparkle-prpb: an idle agent whose git fingerprint never moves must still get its PR state
    // re-probed once the TTL elapses, so an out-of-band PR open (agent ran `gh pr create`) flips the
    // CTA instead of leaving it stuck on "Open Pull Request". This is the pure decision the batch's
    // skip consults.
    #[test]
    fn pr_reprobe_due_respects_ttl() {
        let now = Instant::now();
        assert!(pr_reprobe_due(None, now), "never probed ⇒ due (first sighting always computes)");
        assert!(!pr_reprobe_due(Some(now), now), "just probed ⇒ not due");
        let long_ago = now.checked_sub(PR_REPROBE_TTL + Duration::from_secs(1)).unwrap();
        assert!(pr_reprobe_due(Some(long_ago), now), "past the TTL ⇒ re-probe");
        let recent = now.checked_sub(PR_REPROBE_TTL / 2).unwrap();
        assert!(!pr_reprobe_due(Some(recent), now), "within the TTL ⇒ reuse cached PR state");
    }

    #[test]
    fn commit_pr_usability_gates_on_number() {
        // A PR is only authoritative (skip the branch-name fallback) when it carries a number.
        assert!(commit_pr_is_usable(&(Some("open".into()), Some(7), None)));
        assert!(!commit_pr_is_usable(&(Some("open".into()), None, None))); // state but no number ⇒ fall back
        assert!(!commit_pr_is_usable(&(None, None, None)));
    }

    #[test]
    fn three_agents_are_isolated_and_each_drives_its_own_pty() {
        let root = unique_root("iso");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("iso-appdata");

        ensure_project_repo_inner(root_str.clone()).expect("ensure repo");

        // .sparkle/ must be ignored so agent worktrees never pollute the user's repo.
        let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|l| l.trim() == ".sparkle/"));

        // Three agents -> three distinct worktrees on three distinct branches.
        let base = resolve_default_branch(&root_str);
        let ids = ["alpha", "beta", "gamma"];
        let mut infos = Vec::new();
        for id in ids {
            let info = create_worktree_at(&root_str, "isoproj", id, &base, &app_data)
                .unwrap_or_else(|e| panic!("worktree for {id}: {e}"));
            assert!(Path::new(&info.path).is_dir(), "{id} worktree dir exists");
            assert_eq!(info.branch, format!("sparkle/agent-{id}"));
            infos.push((id, info));
        }
        let paths: Vec<_> = infos.iter().map(|(_, i)| i.path.clone()).collect();
        assert_eq!(
            paths.iter().collect::<std::collections::HashSet<_>>().len(),
            3,
            "worktree paths are distinct"
        );

        // Idempotent: re-requesting an existing agent's worktree returns the same path.
        let again = create_worktree_at(&root_str, "isoproj", "alpha", &base, &app_data).unwrap();
        assert_eq!(again.path, infos[0].1.path);

        // Drive all three PTYs concurrently; each writes a file IN ITS OWN worktree.
        let (tx, rx) = mpsc::channel();
        let mut handles = Vec::new();
        for (id, info) in &infos {
            let id = id.to_string();
            let path = info.path.clone();
            let tx = tx.clone();
            handles.push(std::thread::spawn(move || {
                let out = pty_run(&path, &format!("echo SPARKLE_{id}; echo {id} > agent.txt"));
                tx.send((id, out)).unwrap();
            }));
        }
        drop(tx);
        for h in handles {
            h.join().unwrap();
        }
        let mut seen = 0;
        for (id, out) in rx.iter() {
            assert!(out.contains(&format!("SPARKLE_{id}")), "pty output for {id}: {out:?}");
            seen += 1;
        }
        assert_eq!(seen, 3, "all three PTYs produced output");

        // Isolation: each worktree has ONLY its own agent.txt with its own content.
        for (id, info) in &infos {
            let mine = std::fs::read_to_string(Path::new(&info.path).join("agent.txt")).unwrap();
            assert_eq!(mine.trim(), *id, "{id} wrote its own file");
            for (other_id, other) in &infos {
                if other_id == id {
                    continue;
                }
                let leaked = std::fs::read_to_string(Path::new(&other.path).join("agent.txt"))
                    .unwrap();
                assert_ne!(leaked.trim(), *id, "{id}'s write must not appear in {other_id}");
            }
        }

        // Removal is clean + idempotent.
        for (id, _) in &infos {
            let wt = worktree_path(&app_data, "isoproj", id).unwrap();
            let _ = git(&root_str, &["worktree", "remove", "--force", &wt.to_string_lossy()]);
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // ── Pre-warmed worktree pool (worktree-pool) ────────────────────────────────────────────────

    /// The detached HEAD sha of a worktree (for asserting a parked slot sits at the base commit).
    fn head_sha(wt: &str) -> String {
        git(wt, &["rev-parse", "HEAD"]).unwrap()
    }

    // Warming parks a DETACHED-HEAD worktree at the effective base, under the SEPARATE
    // `worktree-pool/<project>` subtree (never `worktrees/<project>`), and records it in the pool.
    #[test]
    fn warm_parks_a_detached_worktree_at_base() {
        let r = init_repo("pool-warm");
        let app_data = unique_root("pool-warm-appdata");
        let base_commit = git(&r, &["rev-parse", "main"]).unwrap();

        warm_one_slot(&r, "pw", "main", &app_data).expect("warm one slot");

        // Recorded in the in-memory pool at the base commit.
        let slot = {
            let map = pools().lock().unwrap();
            map.get("pw").and_then(|v| v.last()).cloned()
        }
        .expect("a slot was parked");
        assert_eq!(slot.base_commit, base_commit);
        // It's a real worktree, detached at the base, and lives under worktree-pool/ (NOT worktrees/).
        assert!(Path::new(&slot.path).is_dir());
        assert_eq!(head_sha(&slot.path.to_string_lossy()), base_commit);
        assert!(slot.path.starts_with(app_data.join("worktree-pool").join("pw")));
        assert!(!slot.path.starts_with(app_data.join("worktrees")));
        // Detached HEAD: no branch is checked out.
        assert!(git(&slot.path.to_string_lossy(), &["symbolic-ref", "-q", "HEAD"]).is_err());

        let _ = git(&r, &["worktree", "remove", "--force", &slot.path.to_string_lossy()]);
    }

    // Claiming a parked slot moves it to the agent path on `sparkle/agent-<id>`, with files == base
    // tree — an identical result to the slow `git worktree add -b` path.
    #[test]
    fn claim_moves_pooled_worktree_to_agent_path_on_branch() {
        let r = init_repo("pool-claim");
        let app_data = unique_root("pool-claim-appdata");
        // A tracked file in the base so we can assert the claimed tree materializes it.
        std::fs::write(format!("{r}/base.txt"), "base content").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-q", "-m", "base file"]).unwrap();
        let base_commit = git(&r, &["rev-parse", "main"]).unwrap();

        warm_one_slot(&r, "pc", "main", &app_data).unwrap();
        let info = try_claim_pooled_worktree(&r, "pc", "a1", "main", &app_data)
            .expect("claim should succeed from a fresh pool");

        // Exactly what create_worktree_at would return: the canonical agent path + branch.
        let expected = worktree_path(&app_data, "pc", "a1").unwrap();
        assert_eq!(info.path, expected.to_string_lossy());
        assert_eq!(info.branch, "sparkle/agent-a1");
        // On the right branch, at the base commit, with the base tree materialized.
        assert_eq!(git(&info.path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(), "sparkle/agent-a1");
        assert_eq!(head_sha(&info.path), base_commit);
        assert_eq!(std::fs::read_to_string(format!("{}/base.txt", info.path)).unwrap(), "base content");
        // The pool is now empty (the slot was consumed), and the old pool path is gone.
        assert_eq!(pools().lock().unwrap().get("pc").map(|v| v.len()).unwrap_or(0), 0);

        let _ = git(&r, &["worktree", "remove", "--force", &info.path]);
    }

    // A slot cut from a base that has since MOVED is rejected (not handed out) and pruned — the
    // caller then falls back to a correct fresh cut.
    #[test]
    fn claim_rejects_stale_base_and_prunes() {
        let r = init_repo("pool-stale");
        let app_data = unique_root("pool-stale-appdata");
        warm_one_slot(&r, "ps", "main", &app_data).unwrap();
        let parked = pools().lock().unwrap().get("ps").unwrap().last().unwrap().path.clone();

        // Advance main AFTER warming, so the parked slot is now cut from a stale base.
        std::fs::write(format!("{r}/new.txt"), "moved on").unwrap();
        git(&r, &["add", "."]).unwrap();
        git(&r, &["commit", "-q", "-m", "advance main"]).unwrap();

        // The claim must refuse the stale slot (⇒ caller falls back).
        assert!(try_claim_pooled_worktree(&r, "ps", "a2", "main", &app_data).is_none());
        // The stale slot is discarded from memory AND disk.
        assert_eq!(pools().lock().unwrap().get("ps").map(|v| v.len()).unwrap_or(0), 0);
        assert!(!parked.exists(), "stale parked worktree dir should be pruned");
        // No agent worktree was created from the wrong base.
        assert!(!worktree_path(&app_data, "ps", "a2").unwrap().exists());
    }

    // The disabled flag makes claim a no-op (always falls back), and create_worktree_at still works
    // end-to-end via the slow path.
    #[test]
    fn disabled_flag_falls_back_to_slow_path() {
        let r = init_repo("pool-disabled");
        let app_data = unique_root("pool-disabled-appdata");
        // Disable the pool for THIS repo via a per-project .sparkle/config.toml.
        std::fs::create_dir_all(format!("{r}/.sparkle")).unwrap();
        std::fs::write(format!("{r}/.sparkle/config.toml"), "[worktree_pool]\nenabled = false\n").unwrap();

        // Even with a parked slot present, a disabled pool never claims it.
        warm_one_slot(&r, "pd", "main", &app_data).unwrap();
        assert!(try_claim_pooled_worktree(&r, "pd", "a3", "main", &app_data).is_none());
        assert_eq!(pools().lock().unwrap().get("pd").map(|v| v.len()).unwrap_or(0), 1, "slot left intact");

        // create_worktree_at still produces a correct worktree via the slow path.
        let info = create_worktree_at(&r, "pd", "a3", "main", &app_data).unwrap();
        assert_eq!(info.branch, "sparkle/agent-a3");
        assert_eq!(info.path, worktree_path(&app_data, "pd", "a3").unwrap().to_string_lossy());
        assert_eq!(git(&info.path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(), "sparkle/agent-a3");

        let leftover = pools().lock().unwrap().get("pd").unwrap().last().unwrap().path.clone();
        let _ = git(&r, &["worktree", "remove", "--force", &info.path]);
        let _ = git(&r, &["worktree", "remove", "--force", &leftover.to_string_lossy()]);
    }

    // create_worktree_at claims from a warm pool transparently: same result as the slow path, and it
    // does NOT go through `git worktree add -b` (the pooled slot is reused instead).
    #[test]
    fn create_worktree_at_claims_from_warm_pool() {
        let r = init_repo("pool-e2e");
        let app_data = unique_root("pool-e2e-appdata");
        // Pin size=0 so the post-claim background refill is a deterministic no-op — the pool stays
        // empty after the single parked slot is consumed, so the len==0 assertion below can't race a
        // refill thread. (enabled stays true by default, so the claim itself still fires.)
        std::fs::create_dir_all(format!("{r}/.sparkle")).unwrap();
        std::fs::write(format!("{r}/.sparkle/config.toml"), "[worktree_pool]\nsize = 0\n").unwrap();
        let base_commit = git(&r, &["rev-parse", "main"]).unwrap();
        warm_one_slot(&r, "pe", "main", &app_data).unwrap();
        assert_eq!(pools().lock().unwrap().get("pe").unwrap().len(), 1);

        let info = create_worktree_at(&r, "pe", "a4", "main", &app_data).unwrap();
        assert_eq!(info.branch, "sparkle/agent-a4");
        assert_eq!(info.path, worktree_path(&app_data, "pe", "a4").unwrap().to_string_lossy());
        assert_eq!(head_sha(&info.path), base_commit);
        // The slot was consumed by the claim.
        assert_eq!(pools().lock().unwrap().get("pe").map(|v| v.len()).unwrap_or(0), 0);

        let _ = git(&r, &["worktree", "remove", "--force", &info.path]);
    }

    // Startup cleanup removes a leftover parked worktree from a "crashed" prior session and is a
    // no-op on the second call (idempotent, once-per-project).
    #[test]
    fn cleanup_sweeps_crashed_pool_leftovers_once() {
        let r = init_repo("pool-clean");
        let app_data = unique_root("pool-clean-appdata");
        // Simulate a crash survivor: a real parked worktree on disk with NO in-memory record.
        let base_commit = git(&r, &["rev-parse", "main"]).unwrap();
        let dir = pool_dir(&app_data, "pcl").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let orphan = dir.join(new_slot_id());
        git(&r, &["worktree", "add", "--detach", &orphan.to_string_lossy(), &base_commit]).unwrap();
        assert!(orphan.exists());

        cleanup_pool_once(&r, "pcl", &app_data);
        assert!(!orphan.exists(), "leftover parked worktree should be swept");
        // Second call is a guarded no-op (does not error, nothing to do).
        cleanup_pool_once(&r, "pcl", &app_data);
    }

    // topup_pool_blocking fills the pool up to the configured size and never over-warms.
    #[test]
    fn topup_fills_to_configured_size() {
        let r = init_repo("pool-topup");
        let app_data = unique_root("pool-topup-appdata");
        std::fs::create_dir_all(format!("{r}/.sparkle")).unwrap();
        std::fs::write(format!("{r}/.sparkle/config.toml"), "[worktree_pool]\nsize = 3\n").unwrap();

        topup_pool_blocking(&r, "pt", "main", &app_data);
        assert_eq!(pools().lock().unwrap().get("pt").map(|v| v.len()).unwrap_or(0), 3);

        // Re-running is a no-op once full (still exactly 3, not 6).
        topup_pool_blocking(&r, "pt", "main", &app_data);
        assert_eq!(pools().lock().unwrap().get("pt").unwrap().len(), 3);

        for slot in pools().lock().unwrap().get("pt").unwrap().clone() {
            let _ = git(&r, &["worktree", "remove", "--force", &slot.path.to_string_lossy()]);
        }
    }

    /// The trash dir must NOT sit under `worktrees/`. `scan_worker_manifests_at`, `retention.rs`
    /// and `pty.rs` all enumerate that directory and read what they find as a project dir or an
    /// agent slot — and a parked checkout still carries its `.sparkle/worker.json`, so a trash dir
    /// placed inside would get a worker re-adopted at a path that is about to be deleted.
    #[test]
    fn the_trash_dir_is_not_somewhere_the_worktree_scans_will_find_it() {
        let app_data = Path::new("/tmp/appdata");
        let trash = removal_trash_dir(app_data);
        assert!(!trash.starts_with(app_data.join("worktrees")));
        assert!(trash.starts_with(app_data), "must stay on one filesystem: {trash:?}");
    }

    #[test]
    fn a_trash_name_cannot_escape_the_trash_dir() {
        // The ids are validated upstream by `worktree_path`, but this name is joined onto a path we
        // then `remove_dir_all` — not a place to lean on a check made somewhere else.
        let tag = trash_tag("../../etc", "a/b");
        assert!(!tag.contains('/'), "no separators: {tag}");
        assert!(!tag.contains(".."), "no traversal: {tag}");
        assert!(
            tag.contains(&format!("-p{}-", std::process::id())),
            "the sweep needs this process's pid to spot its own live entries: {tag}"
        );
    }

    #[test]
    fn evacuating_frees_the_worktree_path_without_doing_the_slow_delete() {
        // The whole point: the path the git lock cares about is free IMMEDIATELY, and the bytes are
        // still there to be deleted later, off the lock.
        let base = unique_root("evacuate");
        let wt = base.join("wt");
        std::fs::create_dir_all(wt.join("node_modules/pkg")).unwrap();
        std::fs::write(wt.join("node_modules/pkg/index.js"), "x").unwrap();
        let trash = base.join("trash");

        let parked = evacuate_checkout(&wt, &trash, "tag").expect("a present checkout must park");

        assert!(!wt.exists(), "the worktree path must be free for a fresh `git worktree add`");
        assert!(parked.starts_with(&trash));
        assert!(
            parked.join("node_modules/pkg/index.js").exists(),
            "a rename must MOVE the tree, not delete it — the delete happens off the lock"
        );
    }

    #[test]
    fn evacuating_declines_when_there_is_nothing_to_move() {
        // Teardown is idempotent, and `None` is what routes an absent checkout back to the
        // git path that already treats "not a working tree" as success.
        let base = unique_root("evacuate-missing");
        assert_eq!(evacuate_checkout(&base.join("gone"), &base.join("trash"), "t"), None);
    }

    /// End-to-end: a real worktree, removed through the real path, must leave nothing behind at the
    /// worktree path and nothing claiming it in git's admin records — the two properties the old
    /// `git worktree remove --force` provided and which the rename-then-prune reordering has to
    /// keep. The branch must survive, because reopening the agent resumes it.
    #[test]
    fn removing_a_worktree_frees_the_path_and_retires_the_admin_record() {
        let r = init_repo("remove-off-lock");
        let app_data = unique_root("remove-off-lock-appdata");
        let wt = worktree_path(&app_data, "proj", "agent").unwrap();
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(&r, &["worktree", "add", "-q", "-b", "sparkle/agent-agent", &wt.to_string_lossy()])
            .unwrap();
        // The untracked, gitignored tree that made this slow in the first place.
        std::fs::create_dir_all(wt.join("node_modules/pkg")).unwrap();
        std::fs::write(wt.join("node_modules/pkg/index.js"), "x").unwrap();

        remove_worktree_at(&r, "proj", "agent", &app_data).unwrap();

        assert!(!wt.exists(), "the worktree path must be free");
        let list = git(&r, &["worktree", "list", "--porcelain"]).unwrap();
        assert!(
            !list.contains(&wt.to_string_lossy().to_string()),
            "no admin record may still claim the branch: {list}"
        );
        assert!(
            branch_exists(&r, "sparkle/agent-agent"),
            "the branch is left in place so reopening the agent resumes it"
        );
        // Idempotent: a second teardown of an already-removed agent is not an error.
        remove_worktree_at(&r, "proj", "agent", &app_data).unwrap();
    }

    #[test]
    fn worktree_path_is_outside_the_project_root() {
        use std::path::Path;
        let app_data = Path::new("/tmp/sparkle-appdata");
        let root = "/Users/dev/Projects/myrepo";
        let p = worktree_path(app_data, "proj-123", "agent-abc").unwrap();
        assert_eq!(p, Path::new("/tmp/sparkle-appdata/worktrees/proj-123/agent-abc"));
        // The crucial property: the worktree is NOT under the project root.
        assert!(!p.starts_with(root), "worktree must live outside the project tree");
    }

    #[test]
    fn worktree_path_rejects_traversal_and_metacharacters() {
        let app_data = Path::new("/tmp/sparkle-appdata");
        // A UUID-shaped id (the real-world case) is accepted.
        assert!(worktree_path(app_data, "proj-123_X", "08f7a420-ca27-4452-a1f8-4d27b6fc5a05").is_ok());
        // Path traversal / separators / emptiness in either component are rejected, so a crafted
        // id can never escape <app_data>/worktrees.
        assert!(worktree_path(app_data, "../../etc", "agent").is_err());
        assert!(worktree_path(app_data, "proj", "../../../tmp/evil").is_err());
        assert!(worktree_path(app_data, "proj/sub", "agent").is_err());
        assert!(worktree_path(app_data, "proj", "a b").is_err());
        assert!(worktree_path(app_data, "", "agent").is_err());
        assert!(worktree_path(app_data, "proj", "").is_err());
    }

    #[test]
    fn validate_ref_blocks_option_injection_but_allows_slash_branches() {
        // Legit branch names, including slashed ones, pass (after trimming).
        assert!(validate_ref("main").is_ok());
        assert!(validate_ref("release/2026").is_ok());
        assert!(validate_ref("  develop  ").is_ok());
        // A ref crafted to be parsed as a git option (the RCE vector via fetch/rebase) is rejected.
        assert!(validate_ref("--upload-pack=touch /tmp/pwned").is_err());
        assert!(validate_ref("-x").is_err());
        // Empty / control / whitespace refs are rejected.
        assert!(validate_ref("").is_err());
        assert!(validate_ref("   ").is_err());
        assert!(validate_ref("a b").is_err());
        assert!(validate_ref("a\nb").is_err());
        // A REFSPEC is not an option, so the leading-'-' check never saw it — but `git fetch origin
        // <arg>` reads `<src>:<dst>`, so this is an instruction to force-overwrite a LOCAL ref, not
        // a branch to fetch. Both halves of the shape are rejected.
        assert!(validate_ref("+refs/heads/evil:refs/heads/main").is_err());
        assert!(validate_ref("refs/heads/evil:refs/heads/sparkle/agent-a1").is_err());
        assert!(validate_ref("+main").is_err());
        // The rest of what git itself forbids in a ref name.
        for bad in ["a~1", "a^", "a?", "a*", "a[b", "a\\b", "a..b"] {
            assert!(validate_ref(bad).is_err(), "must reject {bad:?}");
        }
    }

    #[test]
    fn worktree_lives_outside_root_and_toplevel_cannot_escape() {
        let root = unique_root("ext-iso");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("ext-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        let info = create_worktree_at(&root_str, "proj1", "a1", "HEAD", &app_data).unwrap();

        // 1. The worktree path is OUTSIDE the project root.
        assert!(!Path::new(&info.path).starts_with(&root), "worktree under project root!");
        assert!(Path::new(&info.path).starts_with(&app_data), "worktree not under app_data");

        // 2. THE regression test: rev-parse --show-toplevel from the worktree is the worktree
        //    itself, never the parent checkout.
        let toplevel = git(&info.path, &["rev-parse", "--show-toplevel"]).unwrap();
        let canon_wt = std::fs::canonicalize(&info.path).unwrap();
        assert_eq!(std::fs::canonicalize(&toplevel).unwrap(), canon_wt);
        assert!(!canon_wt.starts_with(std::fs::canonicalize(&root).unwrap()));

        // 3. It is still a real worktree OF the project repo.
        let common = git(&info.path, &["rev-parse", "--git-common-dir"]).unwrap();
        assert!(std::fs::canonicalize(&common).unwrap()
            .starts_with(std::fs::canonicalize(&root).unwrap()));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn remove_worktree_cleans_external_dir_and_is_idempotent() {
        let root = unique_root("rm-ext");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("rm-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();
        assert!(Path::new(&info.path).exists());

        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap();
        assert!(!Path::new(&info.path).exists(), "external worktree dir removed");
        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap(); // twice = no-op

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// Closing one agent fans teardown out to every open window, so the same worktree takes several
    /// concurrent removal calls; all must converge on success with the dir gone.
    ///
    /// NOTE: this is a contract guard, NOT a reproduction. It passes with the serialization removed
    /// — a fixture worktree is deleted in microseconds, while the production race window is the
    /// 2-10s it takes to delete a real one. It fails only if a change makes concurrent removes
    /// error outright, so it is not evidence that the lock is what fixes the observed failure.
    #[test]
    fn concurrent_removes_of_the_same_worktree_all_succeed() {
        let root = unique_root("rm-race");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("rm-race-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();
        assert!(Path::new(&info.path).exists());

        // Six racers, released together: the observed fan-out width for a close with six windows.
        let barrier = std::sync::Barrier::new(6);
        let errs: Vec<String> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..6)
                .map(|_| {
                    let (r, ad, b) = (root_str.clone(), app_data.clone(), &barrier);
                    s.spawn(move || {
                        b.wait();
                        remove_worktree_at(&r, "p", "a", &ad)
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().unwrap().err()).collect()
        });

        assert!(errs.is_empty(), "concurrent removals reported failures: {errs:?}");
        assert!(!Path::new(&info.path).exists(), "external worktree dir removed");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// A half-deleted worktree — dir still on disk, its `.git` link file gone — is the shape
    /// `git worktree remove` cannot finish: it either fails ("validation failed, cannot remove
    /// working tree") or reports success while deleting nothing. Teardown has to prune the
    /// admin record and delete the remains itself, or the agent's branch stays claimed and the
    /// orphaned dir leaks for the life of the repo.
    #[test]
    fn remove_worktree_recovers_from_a_missing_dot_git_link() {
        let root = unique_root("rm-broken");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("rm-broken-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();

        // Break the checkout the way a half-finished teardown does: drop the `.git` link file,
        // leaving both the dir and the parent repo's admin record behind.
        std::fs::remove_file(Path::new(&info.path).join(".git")).unwrap();

        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap();
        assert!(!Path::new(&info.path).exists(), "half-deleted worktree dir removed");
        assert!(
            !git(&root_str, &["worktree", "list", "--porcelain"])
                .unwrap()
                .contains(&info.path),
            "stale admin record pruned"
        );
        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap(); // still idempotent

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The same broken link, phrased differently: when the `.git` file survives as something
    /// that isn't a gitfile, git blames it with `is not a .git file, error code N` instead of
    /// `does not exist`. Same half-deleted checkout, same leak — but a guard keyed to the first
    /// wording alone lets this one through, so teardown errors out and never converges.
    #[test]
    fn remove_worktree_recovers_from_a_corrupt_dot_git_link() {
        let root = unique_root("rm-corrupt");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("rm-corrupt-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();

        // Truncated/overwritten link file: present, but no longer a `gitdir:` pointer.
        std::fs::write(Path::new(&info.path).join(".git"), b"not a gitfile\n").unwrap();

        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap();
        assert!(!Path::new(&info.path).exists(), "corrupt-link worktree dir removed");
        assert!(
            !git(&root_str, &["worktree", "list", "--porcelain"])
                .unwrap()
                .contains(&info.path),
            "stale admin record pruned"
        );
        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap(); // still idempotent

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The fourth way teardown gets stuck, and the only one where the checkout was fine until
    /// git touched it: `git worktree remove --force` unlinks the tree bottom-up, and if anything
    /// lands in a directory it has already emptied, the final rmdir fails with
    /// `failed to delete '<path>': Directory not empty`. By then most of the checkout is gone, so
    /// a retry re-walks a tree that no longer exists and re-hits the same rmdir — which is why
    /// this signature arrived in bursts, several per hundred milliseconds, against one path.
    ///
    /// Reproducing the race deterministically would mean winning it, so this asserts the two
    /// halves separately: the classifier routes git's exact wording to the recovery, and the
    /// recovery clears a non-empty leftover dir and prunes the record it leaves claimed.
    #[test]
    fn a_failed_rmdir_routes_to_the_recovery_instead_of_erroring() {
        // Git's phrasing, verbatim except for the path. Lowercased, as the caller passes it.
        // The checkout is still on disk, which is what makes it the checkout's rmdir that failed.
        let msg = "error: failed to delete '/tmp/wt/agent': directory not empty";
        assert!(removal_error_is_recoverable(msg, true));
        // Same wording, opposite meaning: git reuses it for the admin dir it deletes AFTER the
        // checkout, and by then the checkout is gone. The recovery would no-op and reporting
        // success would leave the record still claiming the agent's branch, so this must surface.
        // Only `checkout_remains` tells the two apart — the message alone cannot.
        assert!(!removal_error_is_recoverable(msg, false));

        // The pre-existing recoverable shapes must keep routing there regardless of the flag.
        for remains in [true, false] {
            assert!(removal_error_is_recoverable(
                "fatal: '/tmp/wt/agent' is not a working tree",
                remains
            ));
            assert!(removal_error_is_recoverable(
                "fatal: validation failed, cannot remove working tree: '/tmp/wt/agent/.git' does not exist",
                remains
            ));
            // A genuine reason to stop must still surface, not be swallowed as a leak to clean up.
            assert!(!removal_error_is_recoverable(
                "fatal: could not lock config file .git/config: permission denied",
                remains
            ));
            assert!(!removal_error_is_recoverable("fatal: not a git repository", remains));
        }
    }

    /// The recovery half of the case above: whatever git left behind is non-empty by definition
    /// (that is why its rmdir failed), so the cleanup has to delete a populated directory and
    /// still prune the admin record that keeps the agent's branch claimed.
    #[test]
    fn the_recovery_clears_a_non_empty_leftover_dir() {
        let root = unique_root("rm-notempty");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("rm-notempty-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();

        // Stand in for the post-abort remains: the checkout is destroyed (no `.git` link), but
        // the dir is far from empty — nested, and holding the kind of stray file that wins the
        // race in the first place.
        let wt = Path::new(&info.path);
        std::fs::remove_file(wt.join(".git")).unwrap();
        std::fs::create_dir_all(wt.join("node_modules/pkg/dist")).unwrap();
        std::fs::write(wt.join("node_modules/pkg/dist/index.js"), b"//\n").unwrap();
        std::fs::write(wt.join(".DS_Store"), b"\0").unwrap();

        // Count the admin records directly instead of grepping `worktree list` for our path:
        // git stores the path it RESOLVED, and on macOS a `/var/...` temp path comes back as
        // `/private/var/...`, so a substring assertion would hold whether or not prune ran.
        let records = || {
            std::fs::read_dir(root.join(".git/worktrees"))
                .map(|d| d.filter_map(|e| e.ok()).count())
                .unwrap_or(0)
        };
        assert_eq!(records(), 1, "the agent's admin record exists before teardown");

        discard_half_deleted_worktree(&root_str, wt).unwrap();
        assert!(!wt.exists(), "non-empty leftover dir removed");
        assert_eq!(records(), 0, "stale admin record pruned");
        // Nothing left to delete or prune — the repeat teardown the caller issues is a no-op.
        discard_half_deleted_worktree(&root_str, wt).unwrap();

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The third phrasing, and the subtlest break: the `.git` file is a perfectly well-formed
    /// gitfile, but the admin record it names belongs to a DIFFERENT worktree, so the link no
    /// longer round-trips. Git rejects it with `does not point back to`. Nothing about the file
    /// looks wrong on disk, which is exactly why the guard has to match on git's reason rather
    /// than on any property we could check ourselves.
    #[test]
    fn remove_worktree_recovers_from_a_dot_git_link_that_points_elsewhere() {
        let root = unique_root("rm-crosslink");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("rm-crosslink-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let a = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();
        let b = create_worktree_at(&root_str, "p", "b", "HEAD", &app_data).unwrap();

        // Point a's link at b's admin record. b's record still names b, so validating a fails.
        let b_link = std::fs::read_to_string(Path::new(&b.path).join(".git")).unwrap();
        std::fs::write(Path::new(&a.path).join(".git"), b_link).unwrap();

        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap();
        assert!(!Path::new(&a.path).exists(), "cross-linked worktree dir removed");
        assert!(
            !git(&root_str, &["worktree", "list", "--porcelain"])
                .unwrap()
                .contains(&a.path),
            "stale admin record pruned"
        );
        // The bystander must survive: cleanup is repo-wide but only drops missing checkouts.
        assert!(Path::new(&b.path).exists(), "unrelated worktree left intact");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The quieter half of the same leak: for a path git does NOT recognize as a worktree,
    /// `git worktree remove` exits 0 having deleted nothing. Teardown that trusts the exit code
    /// reports success and leaves the dir on disk forever.
    #[test]
    fn remove_worktree_deletes_an_orphan_git_reports_success_for() {
        let root = unique_root("rm-orphan");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("rm-orphan-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        // An orphan git never knew about: the dir exists at the agent's worktree path with no
        // admin record backing it. This is what a crash mid-`worktree add` leaves behind.
        let wt = worktree_path(&app_data, "p", "a").unwrap();
        std::fs::create_dir_all(wt.join("nested")).unwrap();
        std::fs::write(wt.join("nested/leftover.txt"), b"x").unwrap();

        remove_worktree_at(&root_str, "p", "a", &app_data).unwrap();
        assert!(!wt.exists(), "orphaned dir removed despite git reporting success");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn moving_project_keeps_external_worktree_usable() {
        let root = unique_root("mv-from");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("mv-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();

        let dest = root.parent().unwrap().join(format!("mv-to-{}", std::process::id()));
        let dest_str = dest.to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&dest);
        move_project_inner(root_str.clone(), dest_str.clone()).unwrap();

        // The worktree (in app_data) still works and now points at the repo's NEW location.
        let common = git(&info.path, &["rev-parse", "--git-common-dir"]).unwrap();
        assert!(std::fs::canonicalize(&common).unwrap()
            .starts_with(std::fs::canonicalize(&dest).unwrap()));

        let _ = std::fs::remove_dir_all(&dest);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn integrity_ok_for_real_external_worktree_err_for_nested_dir() {
        let root = unique_root("intg");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("intg-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();

        // A correct external worktree passes.
        assert!(assert_workspace_integrity_inner(info.path.clone()).is_ok());

        // A nested dir inside the project checkout fails (its toplevel is the parent repo).
        let nested = root.join("subdir");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(assert_workspace_integrity_inner(nested.to_string_lossy().to_string()).is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn merge_guard_preserves_existing_settings() {
        // Existing local settings with an unrelated key must survive the merge.
        let existing = r#"{ "model": "opus", "hooks": { "PreToolUse": [] } }"#;
        let merged = merge_guard_settings(Some(existing), "node /abs/worktree-guard.mjs /wt/a");
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["model"], "opus", "unrelated key preserved");
        let hooks = &v["hooks"]["PreToolUse"];
        assert!(hooks.is_array() && !hooks.as_array().unwrap().is_empty(), "guard hook added");
        let cmd = hooks[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("worktree-guard.mjs"));
        let matcher = hooks[0]["matcher"].as_str().unwrap();
        assert!(matcher.contains("Edit"));
        // Bash is matched too so the keychain guard (sparkle-0ezz) sees shell commands.
        assert!(matcher.contains("Bash"));
    }

    #[test]
    fn merge_guard_seeds_sparkle_allowlist() {
        // A fresh worktree (no prior settings) gets the pre-approved allow rules so interactive
        // agents stop prompting for Sparkle's own MCP tools and read-only ops.
        let merged = merge_guard_settings(None, "node /abs/worktree-guard.mjs /wt/a");
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        let allow = v["permissions"]["allow"].as_array().expect("allow array");
        let rules: Vec<&str> = allow.iter().filter_map(|e| e.as_str()).collect();
        // Sparkle's control plane is allowed (this is the friction in the screenshot).
        assert!(rules.contains(&"mcp__sparkle-control"));
        assert!(rules.contains(&"mcp__sparkle-orchestrator"));
        // Read-only ops are allowed.
        assert!(rules.contains(&"Read"));
        assert!(rules.contains(&"WebFetch"));
        // Mutating tools are NOT pre-approved — they must still prompt on interactive agents.
        assert!(!rules.contains(&"Bash"));
        assert!(!rules.contains(&"Edit"));
        assert!(!rules.contains(&"Write"));
    }

    #[test]
    fn merge_guard_allowlist_is_idempotent_and_preserves_user_rules() {
        // A user-added rule plus a pre-existing Sparkle rule: re-merging must keep the user's rule
        // and must not duplicate any Sparkle rule.
        let existing = r#"{
            "permissions": { "allow": ["Bash(git status:*)", "mcp__sparkle-control"] }
        }"#;
        let once = merge_guard_settings(Some(existing), "node /abs/worktree-guard.mjs /wt/a");
        let twice = merge_guard_settings(Some(&once), "node /abs/worktree-guard.mjs /wt/a");
        let v: serde_json::Value = serde_json::from_str(&twice).unwrap();
        let rules: Vec<&str> = v["permissions"]["allow"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e.as_str())
            .collect();
        // User's custom rule survives.
        assert!(rules.contains(&"Bash(git status:*)"), "user rule preserved");
        // Sparkle rules present exactly once each despite two merges + a pre-existing copy.
        assert_eq!(
            rules.iter().filter(|r| **r == "mcp__sparkle-control").count(),
            1,
            "no duplicate sparkle-control rule"
        );
        assert_eq!(
            rules.iter().filter(|r| **r == "mcp__sparkle-orchestrator").count(),
            1,
            "no duplicate sparkle-orchestrator rule"
        );
    }

    #[test]
    fn clean_legacy_worktree_is_migrated_dirty_is_refused() {
        let root = unique_root("migrate");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("migrate-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        // Simulate a legacy nested worktree for agent "a".
        let legacy = root.join(".sparkle").join("worktrees").join("a");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        git(&root_str, &["worktree", "add", "-b", "sparkle/agent-a",
                         &legacy.to_string_lossy(), "HEAD"]).unwrap();

        // Clean legacy → migrates: external worktree created, legacy gone.
        let info = create_worktree_at(&root_str, "p", "a", "HEAD", &app_data).unwrap();
        assert!(Path::new(&info.path).starts_with(&app_data));
        assert!(!legacy.exists(), "clean legacy worktree removed");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn refresh_fast_forwards_clean_branch_and_zeroes_behind() {
        let root = unique_root("refresh-ok");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("refresh-ok-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "r1", "main", &app_data).unwrap();
        // Advance main by one commit; agent is now behind 1.
        std::fs::write(root.join("m.txt"), "m").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "main moves"]).unwrap();

        let out = refresh_agent_branch_at(&root_str, "p", "r1", "main", &app_data).unwrap();
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["behind"], serde_json::json!(0), "refresh zeroes behind");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn refresh_refuses_dirty_tree_and_changes_nothing() {
        let root = unique_root("refresh-dirty");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("refresh-dirty-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "r2", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("wip.txt"), "wip").unwrap();
        let before = git(&info.path, &["rev-parse", "HEAD"]).unwrap();

        let out = refresh_agent_branch_at(&root_str, "p", "r2", "main", &app_data).unwrap();
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["ok"], serde_json::json!(false));
        assert_eq!(v["reason"], serde_json::json!("dirty"));
        assert_eq!(git(&info.path, &["rev-parse", "HEAD"]).unwrap(), before, "untouched");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn refresh_aborts_on_conflict_leaving_branch_byte_identical() {
        let root = unique_root("refresh-conflict");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("refresh-conflict-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        // Seed a shared file on main.
        std::fs::write(root.join("f.txt"), "base\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "seed f"]).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "r3", "main", &app_data).unwrap();
        // Conflicting edits on each side.
        std::fs::write(Path::new(&info.path).join("f.txt"), "agent\n").unwrap();
        git(&info.path, &["commit", "-am", "agent edits f"]).unwrap();
        std::fs::write(root.join("f.txt"), "main\n").unwrap();
        git(&root_str, &["commit", "-am", "main edits f"]).unwrap();
        let before = git(&info.path, &["rev-parse", "HEAD"]).unwrap();

        let out = refresh_agent_branch_at(&root_str, "p", "r3", "main", &app_data).unwrap();
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["ok"], serde_json::json!(false));
        assert_eq!(v["reason"], serde_json::json!("conflict"));
        assert!(v["files"].as_array().unwrap().iter().any(|f| f == "f.txt"));
        assert_eq!(git(&info.path, &["rev-parse", "HEAD"]).unwrap(), before, "abort restored HEAD");
        // No rebase left in progress.
        assert!(git(&info.path, &["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn a_status_poll_records_the_branch_an_agents_worktree_is_actually_on() {
        // roborev 55253. The `worktree-branch` source — the one that rescues a PR an agent opened by
        // running `gh pr create` in its own shell — is WIRED here and nowhere else, and nothing was
        // asserting the wiring: `pr_owner`'s own tests call `observe_branch` directly (the
        // precondition, not this side effect), and the two `branch_status_with_base` tests point at a
        // nonexistent worktree, so `head_branch` was "" and the call returned at its first guard.
        // Deleting both call sites left the whole suite green with the feature 100% dead.
        //
        // So: a REAL worktree, a real status poll, and an assertion on the store it wrote.
        let root = unique_root("observe-branch");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("observe-branch-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "s1", "main", &app_data).unwrap();

        // The single-agent path.
        agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert_eq!(
            crate::pr_owner::resolve_owner(
                &crate::pr_owner::load_store(&app_data),
                "p",
                1,
                "sparkle/agent-s1",
                "",
            )
            .map(|o| (o.agent_id, o.source)),
            Some(("s1".to_string(), crate::pr_owner::SOURCE_WORKTREE_BRANCH.to_string())),
            "the poll must record (project, branch) -> agent",
        );

        // The BATCH path is the one that actually drives the sidebar, so it gets its own assertion
        // against a fresh store — fixing only the single-agent path would leave the feature dead
        // where it is used.
        let batch_data = unique_root("observe-branch-batch");
        branch_status_with_base(&root_str, "p", "s1", "main", Path::new(&info.path), &batch_data)
            .unwrap();
        assert_eq!(
            crate::pr_owner::resolve_owner(
                &crate::pr_owner::load_store(&batch_data),
                "p",
                1,
                "sparkle/agent-s1",
                "",
            )
            .map(|o| o.agent_id),
            Some("s1".to_string()),
        );

        // A DESCRIPTIVE branch the agent chose itself — the whole point. Nothing in the name
        // identifies the agent, and the mapping is recorded anyway. Same `app_data` as above,
        // because that is where the worktree this poll reads actually lives.
        git(&info.path, &["checkout", "-b", "sparkle/left-pair"]).unwrap();
        agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert_eq!(
            crate::pr_owner::resolve_owner(
                &crate::pr_owner::load_store(&app_data),
                "p",
                806,
                "sparkle/left-pair",
                "",
            )
            .map(|o| o.agent_id),
            Some("s1".to_string()),
            "a branch with no agent id in its name must still be recorded",
        );

        // A DETACHED head names no branch — git reports the literal "HEAD" — so recording it would
        // map every detached worktree in the project to whichever agent was polled last.
        let head_sha = git(&info.path, &["rev-parse", "HEAD"]).unwrap();
        git(&info.path, &["checkout", "--detach", head_sha.trim()]).unwrap();
        agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        let branches = crate::pr_owner::load_store(&app_data).branches;
        let recorded = branches.get("p").expect("the earlier polls recorded branches");
        assert!(
            !recorded.contains_key("HEAD"),
            "a detached head must record nothing — got {:?}",
            recorded.keys().collect::<Vec<_>>(),
        );
        assert_eq!(
            recorded.len(),
            2,
            "exactly the two real branches, and no third entry from the detached poll",
        );

        for d in [&root, &app_data, &batch_data] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn agent_branch_status_counts_ahead_behind_and_dirty() {
        let root = unique_root("status");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("status-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "s1", "main", &app_data).unwrap();

        // Asymmetric counts (ahead 2 vs behind 1) so a transposed left/right parse would fail.
        std::fs::write(Path::new(&info.path).join("a.txt"), "a1\na2\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work 1"]).unwrap();
        std::fs::write(Path::new(&info.path).join("b.txt"), "b\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work 2"]).unwrap();
        std::fs::write(root.join("m.txt"), "m").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "main work"]).unwrap();

        let st = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert_eq!(st.ahead, 2, "two agent commits");
        assert_eq!(st.behind, 1, "one main commit (left/right mapping correct, not transposed)");
        assert!(!st.dirty, "clean tree");
        // A CLEAN tree names nothing. `dirty_files` must never carry a stale preview, because a row
        // that lists a file is telling the founder to go and deal with that file (sparkle-biezi).
        assert!(st.dirty_files.is_empty(), "a clean tree holds no uncommitted paths");
        assert_eq!(st.dirty_count, 0, "and counts none");
        // numstat parse: two new files added on the agent side, 3 inserted lines, 0 deletions.
        assert_eq!(st.files_changed, 2, "a.txt + b.txt");
        assert_eq!(st.insertions, 3, "2 + 1 inserted lines");
        assert_eq!(st.deletions, 0);

        // Make it dirty.
        std::fs::write(Path::new(&info.path).join("uncommitted.txt"), "u").unwrap();
        let st2 = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert!(st2.dirty, "uncommitted file flips dirty");
        // THE POINT OF THE FIELD: it says WHICH. "Local: Uncommitted" naming no file is what the
        // founder could not act on — a forgotten fix and a leftover build artifact read identically.
        assert_eq!(st2.dirty_files, vec!["uncommitted.txt".to_string()], "and names it");
        assert_eq!(st2.dirty_count, 1);

        // .gitignore IS RESPECTED, and by git itself rather than by a filter of ours that could fall
        // out of step with the repo's rules. An ignored artifact must not make a finished agent look
        // like it is holding work.
        // Remove the untracked file FIRST: the `add -A` below would otherwise sweep it into the
        // commit, and deleting a TRACKED file is itself dirt — which would make this assert pass or
        // fail for a reason that has nothing to do with .gitignore.
        std::fs::remove_file(Path::new(&info.path).join("uncommitted.txt")).unwrap();
        std::fs::write(Path::new(&info.path).join(".gitignore"), "ignored.log\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "ignore rule"]).unwrap();
        std::fs::write(Path::new(&info.path).join("ignored.log"), "noise").unwrap();
        let st3 = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert!(!st3.dirty, "an ignored file is not uncommitted work");
        assert!(st3.dirty_files.is_empty(), "and is never named");

        // The preview is CAPPED but the count stays TRUE — a "+N more" affordance reads the count.
        for i in 0..(STATUS_DIRTY_FILES_CAP + 3) {
            std::fs::write(Path::new(&info.path).join(format!("f{i}.txt")), "x").unwrap();
        }
        let st4 = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert_eq!(st4.dirty_files.len(), STATUS_DIRTY_FILES_CAP, "preview is bounded");
        assert_eq!(
            st4.dirty_count as usize,
            STATUS_DIRTY_FILES_CAP + 3,
            "but the count is the whole truth, not the preview's length"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn agent_branch_status_does_not_attribute_a_parked_worktrees_dirt_to_the_branch() {
        // sparkle-xk3x. `dirty` is the ONE field read from the worktree rather than from the
        // branch ref — every other field here comes from `rev-list <base>...refs/heads/<branch>`
        // and is immune to this. So when a worktree gets moved OFF its own branch (the old
        // land.sh checked `main` out into it — sparkle-rhgm), `dirty` silently stops describing
        // the agent's branch and starts describing whatever tree is sitting there now.
        //
        // Downstream that is not cosmetic: a dirty reading applies the "unsaved edits" floor in
        // gitDerivedStage, which is exactly the founder screenshot — stage pinned below
        // merged_local with ahead == 0, so the CTA offered "Land to Main" for landed work.
        //
        // The probe deliberately keeps reporting RAW `dirty` and publishes the identity flag
        // separately, rather than zeroing `dirty` when parked. Zeroing looks tidier and is
        // wrong: parking CARRIES uncommitted files along, and shouldPromptOnClose reads `dirty`
        // to decide whether tearing the worktree down would discard the user's work. Suppressing
        // it there would trade a cosmetic stage misreport for silent data loss. Attribution is
        // the CONSUMER's decision — see the two callers in runtimeStore.ts and closeAgent.ts.
        let root = unique_root("status-parked");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("status-parked-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "s1", "main", &app_data).unwrap();

        // Real agent work, so ahead is non-zero and provably survives the parking.
        std::fs::write(Path::new(&info.path).join("a.txt"), "a\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();

        // Baseline: on its own branch, a dirty tree IS the branch's dirt and must be reported.
        std::fs::write(Path::new(&info.path).join("uncommitted.txt"), "u").unwrap();
        let before = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert!(before.dirty, "on its own branch, dirt belongs to the branch");
        assert!(before.worktree_on_branch, "worktree is on the agent branch");
        assert_eq!(before.ahead, 1);

        // Park it, exactly as the old land.sh did: free `main` at the root, then check `main`
        // out INTO the agent's worktree. The uncommitted file rides along, so the tree is still
        // dirty — but that dirt now belongs to `main`, not to sparkle/agent-s1.
        git(&root_str, &["checkout", "--detach"]).unwrap();
        git(&info.path, &["checkout", "main"]).unwrap();
        assert_eq!(
            git(&info.path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(),
            "main",
            "worktree is parked on main (precondition)"
        );
        assert!(
            !git(&info.path, &["status", "--porcelain"]).unwrap().is_empty(),
            "parked tree really is dirty — so a naive read WOULD report dirty=true"
        );

        let parked = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert!(
            !parked.worktree_on_branch,
            "probe must notice the worktree is not on sparkle/agent-s1"
        );
        assert!(
            parked.dirty,
            "dirty stays RAW so close-safety can still see files at risk — attribution is the \
             consumer's job, not the probe's"
        );
        // The ref-derived fields are unaffected by parking — that is the whole point of only
        // distrusting `dirty`. If this regresses, the fix over-corrected.
        assert_eq!(parked.ahead, 1, "ahead comes from the branch ref, not the worktree");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The founder's ladder bug, end to end: an agent that RENAMED its working branch, with a
    /// spotless tree and every commit made, rendered under "Local: Uncommitted" with an 'Unsaved'
    /// badge — telling the user their work was one close away from being lost.
    ///
    /// The assertion is on the SIDE EFFECT that decides the rung (`ahead`), not on the rename
    /// having happened. Before the fix `ahead` was 0 here — the zeroed "no branch yet" status —
    /// and `gitDerivedStage` maps `ahead == 0` to `building_unsaved`.
    #[test]
    fn a_renamed_branch_reports_its_commits_instead_of_reading_as_unsaved() {
        let root = unique_root("status-renamed");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("status-renamed-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "renamer", "main", &app_data).unwrap();

        // Two real commits, then rename the branch to a descriptive name — which AGENTS.md now
        // actively encourages ("Name a branch for what the work IS").
        for (n, body) in [("a.txt", "a\n"), ("b.txt", "b\n")] {
            std::fs::write(Path::new(&info.path).join(n), body).unwrap();
            git(&info.path, &["add", "-A"]).unwrap();
            git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        }
        git(&info.path, &["branch", "-m", "sparkle/column-edges"]).unwrap();

        // Preconditions that make this the founder's case exactly: the minted ref is GONE and the
        // tree is spotless.
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-renamer"])
                .is_err(),
            "precondition: the minted branch no longer exists"
        );
        assert!(
            git(&info.path, &["status", "--porcelain"]).unwrap().is_empty(),
            "precondition: the tree is clean — nothing is actually unsaved"
        );

        let st = agent_branch_status_at(&root_str, "p", "renamer", "main", &app_data).unwrap();
        assert_eq!(
            st.ahead, 2,
            "the renamed branch's commits must be counted — ahead=0 is what renders 'Unsaved'"
        );
        assert!(!st.dirty, "a clean tree must not report dirty");
        assert!(
            st.worktree_on_branch,
            "the tree IS on the branch being reported; this is a rename, not a parked checkout"
        );

        // The workflow probe must follow the same branch, or the row still can't leave the bottom
        // rung: `aheadOfBase` feeds the frontend's `committedSeen` gate.
        let ws =
            agent_workflow_state_in(&root_str, "renamer", "", false, Some((app_data.as_path(), "p")))
                .unwrap();
        assert_eq!(ws.ahead_of_base, 2, "workflow state must resolve the renamed branch too");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The batch path is the one the sidebar actually polls, so fixing only the single-agent path
    /// would leave the misreport live on screen (the exact split this file's own comments warn
    /// about twice). Same rename, asserted through `project_agents_status_at`.
    #[test]
    fn the_batch_poll_also_resolves_a_renamed_branch() {
        let root = unique_root("batch-renamed");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("batch-renamed-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "renamer", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("a.txt"), "a\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        git(&info.path, &["branch", "-m", "sparkle/descriptive-name"]).unwrap();

        let results = project_agents_status_at(
            &root_str,
            "p",
            &[AgentStatusInput {
                agent_id: "renamer".to_string(),
                kind: "build".to_string(),
                base_branch: "main".to_string(),
                parent_branch: String::new(),
                force: false,
            }],
            false,
            &app_data,
        );
        let row = results.first().expect("one result row");
        let bs = row.branch.as_ref().expect("branch status present");
        assert_eq!(bs.ahead, 1, "the batch poll must count the renamed branch's commits");
        assert!(bs.worktree_on_branch);

        // `bs.ahead` alone does NOT guard the batch path's own work: it comes out of
        // `branch_status_with_base`, which resolves the branch independently. The lazy
        // `minted_tip.is_empty()` derivation beside it is what feeds `workflow` (and the status
        // fingerprint), so it could pick the wrong branch or a stale tip with `bs.ahead` still
        // green. Assert the value that derivation actually produces (roborev 56051).
        let ws = row.workflow.as_ref().expect("workflow state present");
        assert_eq!(
            ws.ahead_of_base, 1,
            "the batch poll's own (branch, tip) derivation must resolve the renamed branch too"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The parent fix has TWO call sites, and the sidebar polls the one the test above this pair
    /// does not reach. `workflow_state_shared`'s `parent_branch` feeds `cut_from_ref` → `no_own_work`
    /// as well as `in_parent`, so an unresolved parent is not a one-field misreport here — the whole
    /// batch row is derived against a ref that does not exist (roborev 56051).
    #[test]
    fn the_batch_poll_also_resolves_a_renamed_parent_branch() {
        let root = unique_root("batch-parent-renamed");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("batch-parent-renamed-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        let boss = create_worktree_at(&root_str, "p", "boss", "main", &app_data).unwrap();
        std::fs::write(Path::new(&boss.path).join("boss.txt"), "b\n").unwrap();
        git(&boss.path, &["add", "-A"]).unwrap();
        git(&boss.path, &["commit", "-m", "orchestrator work"]).unwrap();

        let wk = create_worktree_from_local(&root_str, "p", "wk", &boss.branch, &app_data).unwrap();
        std::fs::write(Path::new(&wk.path).join("wk.txt"), "w\n").unwrap();
        git(&wk.path, &["add", "-A"]).unwrap();
        git(&wk.path, &["commit", "-m", "worker work"]).unwrap();
        git(&boss.path, &["merge", "--no-ff", "-m", "integrate", "sparkle/agent-wk"]).unwrap();
        git(&boss.path, &["branch", "-m", "sparkle/cockpit-columns"]).unwrap();

        // The sidebar mints `sparkle/agent-<parentId>` for every worker row it polls
        // (AgentSidebar's batch input), so this is the exact string the batch path receives.
        let results = project_agents_status_at(
            &root_str,
            "p",
            &[AgentStatusInput {
                agent_id: "wk".to_string(),
                kind: "worker".to_string(),
                base_branch: "main".to_string(),
                parent_branch: "sparkle/agent-boss".to_string(),
                force: false,
            }],
            false,
            &app_data,
        );
        let ws = results
            .first()
            .expect("one result row")
            .workflow
            .as_ref()
            .expect("workflow state present");
        assert!(
            ws.in_parent,
            "the worker's work IS in the renamed parent — the batch poll must resolve it too"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// A renamed ORCHESTRATOR must not strand its workers. `in_parent` is
    /// `ref_contains(root, parent_branch, tip)`, and a nonexistent ref answers `false` — so before
    /// `resolve_parent_branch` a worker whose work had demonstrably merged into its parent reported
    /// `inParent: false`, and `agent_landed_check` answered "not landed" with confidence.
    #[test]
    fn a_worker_still_sees_its_parent_after_the_orchestrator_renames_its_branch() {
        let root = unique_root("parent-renamed");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("parent-renamed-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // The orchestrator commits, then renames its branch to something descriptive.
        let boss = create_worktree_at(&root_str, "p", "boss", "main", &app_data).unwrap();
        std::fs::write(Path::new(&boss.path).join("boss.txt"), "b\n").unwrap();
        git(&boss.path, &["add", "-A"]).unwrap();
        git(&boss.path, &["commit", "-m", "orchestrator work"]).unwrap();

        // A worker cut from the orchestrator's branch, committing its own work...
        let wk =
            create_worktree_from_local(&root_str, "p", "wk", &boss.branch, &app_data).unwrap();
        std::fs::write(Path::new(&wk.path).join("wk.txt"), "w\n").unwrap();
        git(&wk.path, &["add", "-A"]).unwrap();
        git(&wk.path, &["commit", "-m", "worker work"]).unwrap();
        // ...merged back into the orchestrator, which is what `in_parent` should observe.
        git(&boss.path, &["merge", "--no-ff", "-m", "integrate", "sparkle/agent-wk"]).unwrap();
        git(&boss.path, &["branch", "-m", "sparkle/cockpit-columns"]).unwrap();
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-boss"])
                .is_err(),
            "precondition: the orchestrator's minted branch is gone"
        );

        // The frontend still mints the parent ref as `sparkle/agent-boss`; Rust must recover it.
        let ws = agent_workflow_state_in(
            &root_str,
            "wk",
            "sparkle/agent-boss",
            false,
            Some((app_data.as_path(), "p")),
        )
        .unwrap();
        assert!(
            ws.in_parent,
            "the worker's work IS in the parent — a renamed parent must not read as 'not landed'"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// Guard on the resolver's conservatism: it must never adopt ANOTHER agent's minted branch,
    /// or a worktree parked on one would report that agent's commits as its own.
    #[test]
    fn the_branch_resolver_refuses_another_agents_minted_branch() {
        let root = unique_root("resolve-other");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("resolve-other-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        // `mine`'s worktree, but checked out on another agent's branch, and `mine`'s own ref gone.
        let info = create_worktree_at(&root_str, "p", "mine", "main", &app_data).unwrap();
        git(&root_str, &["branch", "sparkle/agent-other", "main"]).unwrap();
        git(&info.path, &["checkout", "sparkle/agent-other"]).unwrap();
        git(&root_str, &["branch", "-D", "sparkle/agent-mine"]).unwrap();

        let (branch, on_branch) =
            resolve_agent_branch(&root_str, &worktree_head_branch(&info.path, true), "mine", "main");
        assert_eq!(
            branch, "sparkle/agent-mine",
            "must fall back to the minted name, never adopt another agent's branch"
        );
        assert!(!on_branch, "the tree is demonstrably not on this agent's branch");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The other half of the conservatism guard: a tree parked on the BASE branch with its own ref
    /// already deleted must not start reporting `main`'s history as the agent's work.
    #[test]
    fn the_branch_resolver_refuses_the_base_branch() {
        let root = unique_root("resolve-base");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("resolve-base-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "--detach"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "parked", "main", &app_data).unwrap();
        git(&info.path, &["checkout", "main"]).unwrap();
        git(&root_str, &["branch", "-D", "sparkle/agent-parked"]).unwrap();

        let (branch, on_branch) =
            resolve_agent_branch(&root_str, &worktree_head_branch(&info.path, true), "parked", "main");
        assert_eq!(branch, "sparkle/agent-parked", "must not adopt the base branch");
        assert!(!on_branch);
        // Same via the origin-prefixed base, which is what `effective_base` hands back when a
        // remote-tracking ref exists.
        let (branch2, _) =
            resolve_agent_branch(&root_str, &worktree_head_branch(&info.path, true), "parked", "origin/main");
        assert_eq!(branch2, "sparkle/agent-parked", "the origin/ prefix must be stripped");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn agent_branch_status_tolerates_a_removed_worktree() {
        // Repro of the FATAL-log spam: a landed/cleaned-up agent's worktree is gone, but its tab
        // stays open and the 30s poll keeps calling this. The in-worktree `git status` would fail
        // with "cannot change to <path>: No such file or directory". We must still return Ok with
        // dirty=false (a removed tree has no uncommitted changes) and keep ahead/behind correct.
        let root = unique_root("status-gone");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("status-gone-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "s1", "main", &app_data).unwrap();

        // One agent commit so ahead=1, then physically remove the worktree directory.
        std::fs::write(Path::new(&info.path).join("a.txt"), "a\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        std::fs::remove_dir_all(&info.path).unwrap();
        assert!(!Path::new(&info.path).exists(), "worktree dir removed");

        let st = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert_eq!(st.ahead, 1, "ahead/behind still computed from refs in root");
        assert_eq!(st.behind, 0);
        assert!(!st.dirty, "a removed worktree reports clean, not an error");
        assert_eq!(st.files_changed, 1, "numstat runs against root refs, unaffected");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn agent_branch_status_zeroes_when_branch_ref_is_absent() {
        // Repro of the indefinite-poll log spam: an agent with no `sparkle/agent-<id>` ref yet
        // (chat/think/shell, or polled before its first commit). The old code ran
        // `rev-list <base>...sparkle/agent-<id>` against a non-existent ref, which fails with
        // "ambiguous argument ... unknown revision" — not matched by the removed-worktree latch, so
        // the 30s poll re-failed forever. We must return Ok with a zeroed, clean status instead.
        let root = unique_root("status-noref");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("status-noref-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // No create_worktree_at for "s1" → refs/heads/sparkle/agent-s1 never exists.
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-s1"]).is_err(),
            "precondition: agent branch ref absent",
        );

        let st = agent_branch_status_at(&root_str, "p", "s1", "main", &app_data).unwrap();
        assert_eq!(st.ahead, 0, "no ref ⇒ nothing ahead");
        assert_eq!(st.behind, 0, "no ref ⇒ nothing behind");
        assert!(!st.dirty, "no worktree ⇒ clean");
        assert_eq!(st.files_changed, 0);
        assert_eq!(st.insertions, 0);
        assert_eq!(st.deletions, 0);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn batch_branch_status_zeroes_when_branch_ref_is_absent() {
        // The batched 30s poll (branch_status_with_base) must carry the SAME absent-ref guard the
        // single-agent path got in the #291 fix — it was lost when the poll was batched, so a
        // brand-new agent (no `sparkle/agent-<id>` ref yet) made `rev-list <base>...<missing>` fail
        // with "unknown revision", failing that agent's read and re-logging "batch branch status
        // failed" every tick forever. It must return Ok with a zeroed, clean status instead.
        let root = unique_root("batch-status-noref");
        let root_str = root.to_string_lossy().to_string();
        // Use the sync core (mirrors the idempotent test below); `ensure_project_repo` is the async
        // Tauri command and can't be `.unwrap()`-ed directly in a sync `#[test]`.
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // No worktree/branch for "s1" → refs/heads/sparkle/agent-s1 never exists.
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-s1"]).is_err(),
            "precondition: agent branch ref absent",
        );

        // A non-existent worktree path (the agent hasn't been created) — dirty must read clean, not error.
        let wt = root.join("nonexistent-wt");
        // Ownership recording writes under app-data; give it a throwaway dir so the test doesn't
        // touch the real store.
        let owners = tempfile::tempdir().unwrap();
        let st =
            branch_status_with_base(&root_str, "p", "s1", "main", &wt, owners.path()).unwrap();
        assert_eq!(st.ahead, 0, "no ref ⇒ nothing ahead");
        assert_eq!(st.behind, 0, "no ref ⇒ nothing behind");
        assert!(!st.dirty, "no worktree ⇒ clean");
        assert_eq!(st.files_changed, 0);
        assert_eq!(st.insertions, 0);
        assert_eq!(st.deletions, 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn batch_branch_status_survives_an_unresolvable_base_ref() {
        // The agent branch EXISTS but its resolved base does not — `effective_base`'s documented
        // unborn/HEAD-less fallback can hand back a name git can't resolve. Previously
        // `rev-list <unresolvable-base>...<branch>` hard-failed with "fatal: ambiguous argument",
        // failing that agent's read and re-logging "batch branch status failed" every 30s tick for
        // the app's lifetime. It must return Ok, reporting the branch's own commits as `ahead`.
        let root = unique_root("batch-status-ghostbase");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // A real agent branch with commits of its own.
        git(&root_str, &["checkout", "-q", "-b", "sparkle/agent-s1"]).unwrap();
        std::fs::write(format!("{root_str}/w1.txt"), "a").unwrap();
        git(&root_str, &["add", "."]).unwrap();
        git(&root_str, &["commit", "-q", "-m", "w1"]).unwrap();
        std::fs::write(format!("{root_str}/w2.txt"), "b").unwrap();
        git(&root_str, &["add", "."]).unwrap();
        git(&root_str, &["commit", "-q", "-m", "w2"]).unwrap();
        git(&root_str, &["checkout", "-q", "main"]).unwrap();

        let total: u32 = git(&root_str, &["rev-list", "--count", "sparkle/agent-s1"])
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(total > 0, "precondition: the agent branch has commits");

        // A base ref that does not resolve — the failure mode observed in the logs.
        let ghost = "sparkle/ghost-base-does-not-exist";
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", &format!("{ghost}^{{commit}}")]).is_err(),
            "precondition: ghost base does not resolve",
        );

        let wt = root.join("nonexistent-wt");
        let owners = tempfile::tempdir().unwrap();
        let st = branch_status_with_base(&root_str, "p", "s1", ghost, &wt, owners.path()).unwrap();
        assert_eq!(st.ahead, total, "unresolvable base ⇒ ahead = the branch's own commits");
        assert_eq!(st.behind, 0, "unresolvable base ⇒ nothing to be behind");
        assert!(!st.dirty, "no worktree ⇒ clean");
        assert_eq!(st.files_changed, 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn agent_branch_status_tolerates_a_drifted_base_name() {
        // Contract for the single-agent entry point: a recorded base NAME that doesn't exist must not
        // error. Note this does NOT exercise the `ahead_only_status` guard directly — `effective_base`
        // recovers a resolvable base (here the detected default `main`) whenever HEAD resolves, so the
        // call flows through the normal `--left-right` path. The guard's own contract (base_ref that
        // resolves to nothing ⇒ ahead = branch's own commits) is asserted exactly by the lower-level
        // `batch_branch_status_survives_an_unresolvable_base_ref`; this test only pins the entry point's
        // no-error tolerance of a drifted base name.
        let root = unique_root("agent-status-drift-base");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("agent-status-drift-base-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // A real agent branch exactly one commit ahead of `main`.
        git(&root_str, &["checkout", "-q", "-b", "sparkle/agent-s1"]).unwrap();
        std::fs::write(format!("{root_str}/w1.txt"), "a").unwrap();
        git(&root_str, &["add", "."]).unwrap();
        git(&root_str, &["commit", "-q", "-m", "w1"]).unwrap();
        git(&root_str, &["checkout", "-q", "main"]).unwrap();

        // The recorded base "sparkle/ghost-base" resolves to nothing; effective_base recovers the
        // detected default `main`, so the call succeeds and measures against it (ahead == 1).
        let st = agent_branch_status_at(&root_str, "p", "s1", "sparkle/ghost-base", &app_data).unwrap();
        assert_eq!(st.ahead, 1, "drifted base name recovers to `main`; agent-s1 is 1 ahead");
        assert_eq!(st.behind, 0, "nothing to be behind");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn workflow_state_tracks_reachability_through_a_local_merge() {
        let root = unique_root("wf-state");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-state-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "w1", "main", &app_data).unwrap();

        // No commits yet. The tip IS main's HEAD, so reachability is trivially true — the
        // distinguishing signal that no real work exists is ahead_of_base == 0, which the
        // frontend folds into its committedSeen gate to avoid a false "On Main" for a no-op agent.
        let s0 = agent_workflow_state_at(&root_str, "w1", "", false).unwrap();
        assert_eq!(s0.ahead_of_base, 0, "no work ⇒ no commits unique to the branch (the gate)");

        // Agent commits real work → ahead of main, not yet contained in it.
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        let s1 = agent_workflow_state_at(&root_str, "w1", "", false).unwrap();
        assert_eq!(s1.ahead_of_base, 1, "one unlanded commit");
        assert!(!s1.in_local_main, "committed but not merged into main yet");

        // Land it into local main (the merge the user/orchestrator would do).
        git(&root_str, &["merge", "--no-ff", "sparkle/agent-w1", "-m", "land w1"]).unwrap();
        let s2 = agent_workflow_state_at(&root_str, "w1", "", false).unwrap();
        assert!(s2.in_local_main, "after merge, main contains the agent tip → On Main");
        assert_eq!(s2.ahead_of_base, 0, "no commits remain unique to the branch");
        assert!(!s2.in_origin_main, "no origin remote in this fixture → not Merged");
        assert!(s2.pr_state.is_none(), "no PR probe requested / no remote");
        assert!(s2.landed, "a normal --no-ff merge is reachable, so landed is trivially true too");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // ── The no-op-branch guard on TIP-INHERITED facts ────────────────────────────────────────────
    // A seconds-old build agent was filing itself under "Remote: Merged to Main" / "Remote: Shipped
    // to Production". Its branch tip IS main's HEAD, so every tip-keyed probe answered about MAIN:
    // `git tag --contains <tip>` found the last release, and the commit→PR lookup found the merged
    // PR whose merge commit main is sitting on. Neither fact belongs to an agent that has authored
    // nothing. These pin the guard that suppresses them.

    #[test]
    fn branch_carries_no_own_work_lets_a_known_reflog_decide() {
        // `Some(true)` rescues the case arithmetic cannot see: after a local `merge --no-ff` the
        // work is inside main, so `(authored 0, tip inside)` is the brand-new-branch shape exactly.
        assert!(!branch_carries_no_own_work(Some(true), Some((0, true))));
        // `Some(false)` is conclusive TOO, and must not be overruled by the arithmetic: a rewritten
        // cut ref (upstream force-push/rebase, then fetch) makes a work-free branch read
        // `(authored > 0, tip outside)` — the has-work shape — which would fabricate a rung.
        assert!(branch_carries_no_own_work(Some(false), Some((3, false))));
        assert!(branch_carries_no_own_work(Some(false), Some((0, true))));
        // Unknown reflog (bare repo / logAllRefUpdates off / gc'd away) ⇒ the arithmetic decides.
        assert!(branch_carries_no_own_work(None, Some((0, true))));
        // Its very FIRST commit takes it out of the no-op class — this is not an age heuristic.
        assert!(!branch_carries_no_own_work(None, Some((1, true))));
        // A squash/rebase-landed branch's tip is NOT an ancestor of the cut ref — and this clause is
        // also what stops a `commits_beyond` git error (which reads 0) from faking the no-op case.
        assert!(!branch_carries_no_own_work(None, Some((0, false))));
        // Cut point unknown (worker whose orchestrator branch was deleted) ⇒ decline to attribute
        // rather than measure the parent's inherited commits as this branch's own work.
        assert!(branch_carries_no_own_work(None, None));
    }

    /// `pushed` is not a parameter at all, and that is load-bearing: the close-agent Save/Ship path
    /// pushes without an `ahead > 0` guard, so a work-free push must not buy an exemption — and
    /// `refs/remotes/origin/<branch>` is deletable by `fetch --prune`, so its absence must not
    /// demote a merged branch. Both readings are fixed by the signals above, not by the push.
    #[test]
    fn a_work_free_push_does_not_exempt_a_branch_from_the_no_op_guard() {
        let root = unique_root("pushed-noop");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("pushed-noop-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        git(&root_str, &["tag", "v5.0.0"]).unwrap();
        create_worktree_at(&root_str, "p", "pushy", "main", &app_data).unwrap();
        // Fake the push's only observable trace: the remote-tracking ref.
        let tip = rev_parse_tip(&root_str, "sparkle/agent-pushy");
        git(&root_str, &["update-ref", "refs/remotes/origin/sparkle/agent-pushy", &tip]).unwrap();

        let st = agent_workflow_state_at(&root_str, "pushy", "", false).unwrap();
        assert!(st.pushed, "fixture: the branch reads as pushed");
        assert!(!st.shipped, "a pushed but work-free branch is still a no-op branch");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The reflog verbs must classify each way a ref can move. `rebase (finish)` is the one that
    /// makes "did the ref ever advance" the wrong question: Refresh rebases an idle agent's empty
    /// branch onto a newer base, moving the ref without the agent having written anything. And a
    /// MERGE COMMIT is work authored here (an orchestrator that only integrates workers may never
    /// run `git commit` at all) while a FAST-FORWARD merely adopts another branch's history.
    #[test]
    fn reflog_entry_is_work_separates_authored_commits_from_bare_ref_moves() {
        for authored in [
            "commit: agent work",
            "commit (amend): agent work",
            "commit (initial): first",
            "cherry-pick: picked",
            "am: patch",
            // git revert writes its OWN verb, not `commit:` — assuming otherwise silently withheld
            // every rung from a branch whose only authored commit was a revert.
            "revert: Revert \"agent work\"",
            "merge sparkle/agent-wk: Merge made by the 'ort' strategy.",
        ] {
            assert!(reflog_entry_is_work(authored), "should count as work: {authored}");
        }
        for moved in [
            "branch: Created from main",
            "checkout: moving from main to sparkle/agent-x",
            "rebase (finish): refs/heads/sparkle/agent-x onto abc123",
            "reset: moving to main",
            "merge main: Fast-forward",
            // git only ENDS the line at "Fast-forward" when no -m was given; `git merge -m …` and
            // `git merge --ff-only -m …` both append this (git 2.54). A suffix match read these as
            // authored work on a branch whose tip is main's HEAD — the original bug, restored.
            "merge main: Fast-forward (no commit created; -m option ignored)",
            "merge origin/main: Fast-forward (no commit created; -m option ignored)",
        ] {
            assert!(!reflog_entry_is_work(moved), "should NOT count as work: {moved}");
        }
    }

    /// End-to-end for the two shapes that make the reflog authoritative in BOTH directions: a
    /// work-free branch that fast-forwards main into itself with `-m` (reflog says work, wrongly,
    /// unless the FF suffix is matched as a substring), and a work-free branch whose cut ref was
    /// REWRITTEN out from under it (arithmetic says work, wrongly, unless a conclusive reflog wins).
    /// Both would otherwise attribute main's release tag to an agent that has done nothing.
    #[test]
    fn workflow_state_holds_the_line_for_a_work_free_branch_after_a_merge_or_a_rewritten_base() {
        let root = unique_root("ff-and-rewrite");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("ff-and-rewrite-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let ff = create_worktree_at(&root_str, "p", "ffagent", "main", &app_data).unwrap();

        // main moves on, and someone syncs the (still empty) agent branch with an -m fast-forward.
        std::fs::write(Path::new(&root_str).join("m.txt"), "main work").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "main advances"]).unwrap();
        git(&root_str, &["tag", "v7.0.0"]).unwrap();
        git(&ff.path, &["merge", "-m", "sync main", "main"]).unwrap();
        assert_eq!(
            branch_ever_committed(&root_str, "sparkle/agent-ffagent"),
            Some(false),
            "fixture: the -m fast-forward is the only entry beyond creation, and authored nothing"
        );
        let st = agent_workflow_state_at(&root_str, "ffagent", "", false).unwrap();
        assert!(
            !st.shipped,
            "a fast-forward authored nothing, whatever message form git recorded it under"
        );

        // A second agent cut from the ADVANCED main, whose cut ref is then REWRITTEN out from under
        // it (the upstream-force-push shape): its untouched tip now carries a commit main dropped.
        create_worktree_at(&root_str, "p", "rwagent", "main", &app_data).unwrap();
        git(&root_str, &["reset", "--hard", "HEAD~1"]).unwrap();
        git(&root_str, &["commit", "--allow-empty", "-m", "rewritten history"]).unwrap();
        let st2 = agent_workflow_state_at(&root_str, "rwagent", "", false).unwrap();
        assert!(
            st2.ahead_of_base > 0,
            "fixture: the rewrite strands its inherited tip, so the arithmetic reads has-work"
        );
        assert!(
            !st2.shipped,
            "the reflog conclusively says it authored nothing — arithmetic must not overrule it"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// A branch whose ONLY authored commit is a revert. Since the reflog is conclusive, the verb
    /// list is the sole gate on "did this branch author anything", and `git revert` files its work
    /// under its own verb rather than `commit:` — so omitting it silently withheld every tip-derived
    /// rung from a legitimate revert, even once landed and released.
    #[test]
    fn workflow_state_reports_shipped_for_a_branch_whose_only_commit_is_a_revert() {
        let root = unique_root("revert-only");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("revert-only-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        std::fs::write(Path::new(&root_str).join("bad.txt"), "regression").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "the change to be reverted"]).unwrap();

        let agent = create_worktree_at(&root_str, "p", "reverter", "main", &app_data).unwrap();
        git(&agent.path, &["revert", "--no-edit", "HEAD"]).unwrap();
        assert_eq!(
            branch_ever_committed(&root_str, "sparkle/agent-reverter"),
            Some(true),
            "fixture: its reflog reads `revert: …`, never `commit: …`"
        );
        // Land it locally and release it — the shape three rounds of this fix exist to protect.
        git(&root_str, &["merge", "--no-ff", "sparkle/agent-reverter", "-m", "land revert"]).unwrap();
        git(&root_str, &["tag", "v8.0.0"]).unwrap();

        let st = agent_workflow_state_at(&root_str, "reverter", "", false).unwrap();
        assert_eq!(st.ahead_of_base, 0, "fixture: absorbed into main, so the arithmetic reads 0");
        assert!(st.shipped, "a revert is authored work like any other commit");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// An ORCHESTRATOR that only integrates its workers (`merge --no-ff` into its own branch) and
    /// never runs `git commit` itself still carries real, released work. Its whole reflog is one
    /// `merge …: Merge made by …` entry, so a verb list without that case would suppress its
    /// `shipped` — a regression against the arithmetic this guard replaced.
    #[test]
    fn workflow_state_reports_shipped_for_an_orchestrator_that_only_merged_its_workers() {
        let root = unique_root("merge-only");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("merge-only-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let boss = create_worktree_at(&root_str, "p", "boss2", "main", &app_data).unwrap();
        let hand = create_worktree_at(&root_str, "p", "hand2", "sparkle/agent-boss2", &app_data)
            .unwrap();
        std::fs::write(Path::new(&hand.path).join("w.txt"), "worker work").unwrap();
        git(&hand.path, &["add", "-A"]).unwrap();
        git(&hand.path, &["commit", "-m", "worker work"]).unwrap();
        // The orchestrator ONLY merges — it authors no commit of its own.
        git(&boss.path, &["merge", "--no-ff", "sparkle/agent-hand2", "-m", "land hand2"]).unwrap();
        assert_eq!(
            branch_ever_committed(&root_str, "sparkle/agent-boss2"),
            Some(true),
            "fixture: its reflog holds a merge-commit entry and no `commit:` entry"
        );
        // Land it and release it, all locally and unpushed.
        git(&root_str, &["merge", "--no-ff", "sparkle/agent-boss2", "-m", "land boss2"]).unwrap();
        git(&root_str, &["tag", "v6.0.0"]).unwrap();

        let st = agent_workflow_state_at(&root_str, "boss2", "", false).unwrap();
        assert_eq!(st.ahead_of_base, 0, "fixture: absorbed into main, so the arithmetic reads 0");
        assert!(st.shipped, "integration commits are work authored on this branch");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn branch_ever_committed_reads_work_verbs_and_ignores_ref_moves() {
        let r = init_repo("reflog-verbs");
        git(&r, &["branch", "sparkle/agent-idle", "main"]).unwrap();
        assert_eq!(
            branch_ever_committed(&r, "sparkle/agent-idle"),
            Some(false),
            "only a `branch: Created from` entry ⇒ never committed"
        );
        // Move the ref WITHOUT authoring: the Refresh/rebase shape.
        git(&r, &["commit", "--allow-empty", "-q", "-m", "main advances"]).unwrap();
        git(&r, &["branch", "-f", "sparkle/agent-idle", "main"]).unwrap();
        assert_eq!(
            branch_ever_committed(&r, "sparkle/agent-idle"),
            Some(false),
            "a ref that moved but recorded no work verb is still a no-op branch"
        );
        // A branch that actually commits.
        git(&r, &["checkout", "-q", "-b", "sparkle/agent-busy", "main"]).unwrap();
        git(&r, &["commit", "--allow-empty", "-q", "-m", "agent work"]).unwrap();
        assert_eq!(branch_ever_committed(&r, "sparkle/agent-busy"), Some(true));
        // A branch with no reflog at all is UNKNOWN, never "never committed".
        git(&r, &["-c", "core.logAllRefUpdates=false", "branch", "sparkle/agent-nolog", "main"])
            .unwrap();
        assert_eq!(branch_ever_committed(&r, "sparkle/agent-nolog"), None);
        assert_eq!(branch_ever_committed(&r, "sparkle/agent-missing"), None);
        let _ = std::fs::remove_dir_all(std::path::Path::new(&r));
    }

    /// Sparkle's OWN landing path is a local `git merge --no-ff` with no push of the agent branch
    /// (`land_agent_branch_at`, and how every worker integrates). That leaves the branch looking
    /// exactly like a brand-new one under ancestry — authored 0, unpushed, tip inside main — so an
    /// inference-only guard suppressed `shipped` for every landed branch. The reflog is what tells
    /// them apart.
    #[test]
    fn workflow_state_still_reports_shipped_for_a_branch_landed_by_a_local_merge() {
        let root = unique_root("landed-tag");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("landed-tag-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "lander", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("f.txt"), "work").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        // Land it locally and cut a release from the merge — the branch is never pushed.
        git(&root_str, &["merge", "--no-ff", "sparkle/agent-lander", "-m", "land"]).unwrap();
        git(&root_str, &["tag", "v4.0.0"]).unwrap();

        let st = agent_workflow_state_at(&root_str, "lander", "", false).unwrap();
        assert_eq!(st.ahead_of_base, 0, "fixture: its work is absorbed into main, so authored reads 0");
        assert!(!st.pushed, "fixture: never pushed — the inference clauses see a no-op branch");
        assert!(st.shipped, "the reflog proves it committed, so its release tag is its own");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// A branch cut from main that has authored nothing must NOT inherit main's release tag. This is
    /// the "Prepare changes for main branch → Remote: Shipped to Production" half of the bug, and it
    /// shares its gate with the commit→PR probe (the "Build 5 → Remote: Merged to Main" half), which
    /// needs a live `gh` to observe directly.
    #[test]
    fn workflow_state_does_not_inherit_a_release_tag_onto_a_branch_that_authored_nothing() {
        let root = unique_root("noop-tag");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("noop-tag-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        // A published release containing main's current tip — exactly the shape a real repo is in.
        git(&root_str, &["tag", "v1.0.0"]).unwrap();
        create_worktree_at(&root_str, "p", "fresh", "main", &app_data).unwrap();

        // Precondition: the tip really is inside the release tag, so the suppression (not an absent
        // tag) is what this asserts.
        let tip = rev_parse_tip(&root_str, "sparkle/agent-fresh");
        assert!(tip_in_release(&root_str, &tip), "fixture: the inherited tip IS in v1.0.0");

        let st = agent_workflow_state_at(&root_str, "fresh", "", false).unwrap();
        assert!(!st.shipped, "a branch that authored nothing must not read as Shipped");
        assert_eq!(st.ahead_of_base, 0, "fixture: nothing authored yet");
        assert!(st.in_local_main, "ancestry is still reported honestly — only attribution is gated");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The other side of the gate: once the agent has authored a commit that a release tag covers,
    /// `shipped` is its own fact and must be reported.
    #[test]
    fn workflow_state_reports_shipped_once_the_agent_authored_the_tagged_work() {
        let root = unique_root("own-tag");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("own-tag-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "real", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("f.txt"), "work").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        // The release was cut from this agent's own commit.
        let tip = rev_parse_tip(&root_str, "sparkle/agent-real");
        git(&root_str, &["tag", "v2.0.0", &tip]).unwrap();

        let st = agent_workflow_state_at(&root_str, "real", "", false).unwrap();
        assert!(st.shipped, "the tagged commit is the agent's OWN work → Shipped");
        assert_eq!(st.ahead_of_base, 1);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// A freshly spawned WORKER is cut from its orchestrator's branch, not from main, so its
    /// inherited tip carries the PARENT's commits. Measuring "did I author anything" against main
    /// would count those as the worker's own and re-open the same misattribution one level down —
    /// `cut_from_ref` is what aims the question at the parent instead.
    #[test]
    fn workflow_state_measures_a_fresh_workers_own_work_against_its_parent_branch() {
        let root = unique_root("noop-worker");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("noop-worker-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        // The orchestrator: a branch with real commits of its own, released.
        let parent = create_worktree_at(&root_str, "p", "boss", "main", &app_data).unwrap();
        std::fs::write(Path::new(&parent.path).join("boss.txt"), "boss work").unwrap();
        git(&parent.path, &["add", "-A"]).unwrap();
        git(&parent.path, &["commit", "-m", "orchestrator work"]).unwrap();
        let parent_branch = "sparkle/agent-boss";
        git(&root_str, &["tag", "v3.0.0", &rev_parse_tip(&root_str, parent_branch)]).unwrap();
        // The worker, cut from the orchestrator's branch, having done nothing yet.
        create_worktree_at(&root_str, "p", "hand", parent_branch, &app_data).unwrap();

        let st = agent_workflow_state_at(&root_str, "hand", parent_branch, false).unwrap();
        assert!(!st.shipped, "a worker that authored nothing must not inherit the parent's release");
        assert!(st.in_parent, "its tip is (trivially) inside the parent branch");
        assert!(
            st.ahead_of_base > 0,
            "aheadOfBase is still measured vs main — the parent's commits inflate it, which is \
             exactly why the no-op question must never be asked with main as the cut ref"
        );

        // …and the guard must survive the orchestrator being spun down and its branch deleted.
        //
        // To make `cut_from_ref → None` the thing under test, this half REMOVES the worker's reflog
        // (the shape a bare repo or `core.logAllRefUpdates=false` produces) so the decision falls to
        // the cut-relative arithmetic. Were the cut ref to fall back to main, that arithmetic reads
        // `(authored > 0, tip NOT inside main)` — the has-work shape — and the parent's release
        // would be attributed to a worker that did nothing. Only `None` makes this assertion hold.
        git(&root_str, &["worktree", "remove", "--force", &parent.path]).unwrap();
        git(&root_str, &["branch", "-D", parent_branch]).unwrap();
        let hand_reflog = Path::new(&root_str).join(".git/logs/refs/heads/sparkle/agent-hand");
        std::fs::remove_file(&hand_reflog).unwrap();
        assert_eq!(
            branch_ever_committed(&root_str, "sparkle/agent-hand"),
            None,
            "fixture: with no reflog the arithmetic decides, so the cut ref is what's under test"
        );
        assert!(
            !ref_contains(&root_str, "main", &rev_parse_tip(&root_str, "sparkle/agent-hand")),
            "fixture: the worker's tip is NOT inside main, so a base-ref fallback would classify \
             it as having work and this assertion would fail"
        );
        let orphaned = agent_workflow_state_at(&root_str, "hand", parent_branch, false).unwrap();
        assert!(
            !orphaned.shipped,
            "with the parent branch gone the cut point is unknown — decline to attribute, don't guess"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// A repo with no `origin` must report has_remote=false so the UI never strands the user at
    /// "Push to Origin Main" with Close unreachable. Uses the real fixture shape (unique_root +
    /// ensure_project_repo_inner + create_worktree_at) so the branch exists and we exercise the
    /// full computation rather than the tip-missing `WorkflowState::default()` early return.
    #[test]
    fn workflow_state_reports_has_remote_false_without_origin() {
        let root = unique_root("hr-noremote");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("hr-noremote-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "hr1", "main", &app_data).unwrap();

        // probe_pr_state=true, so the `git remote get-url origin` lookup DOES run — and finds nothing.
        let st = agent_workflow_state_at(&root_str, "hr1", "", true).unwrap();
        assert!(!st.has_remote, "no origin remote ⇒ has_remote must be false");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// has_origin is gated on probe_pr_state to avoid a `git remote` spawn on fast polls, so a
    /// non-probing call reports false EVEN WITH a real origin. The FRONTEND must treat this as
    /// "unknown", not "no remote" — see the sticky store note in runtimeStore.
    #[test]
    fn workflow_state_has_remote_is_false_when_probe_is_off() {
        let root = unique_root("hr-probeoff");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("hr-probeoff-appdata");
        let origin = unique_root("hr-probeoff-remote");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let o = origin.to_str().unwrap();
        git(o, &["init", "--bare", "-q"]).unwrap();
        git(&root_str, &["remote", "add", "origin", o]).unwrap();
        git(&root_str, &["push", "-q", "origin", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "hr2", "main", &app_data).unwrap();

        // A real origin EXISTS, but the fast/local poll doesn't probe → reported false.
        let off = agent_workflow_state_at(&root_str, "hr2", "", false).unwrap();
        assert!(!off.has_remote, "probe off ⇒ has_remote false even though origin exists");

        // …and the probing poll sees it. This is the pair that proves `false` is genuinely
        // ambiguous (no-remote vs not-probed) and why the frontend latches an observed true.
        let on = agent_workflow_state_at(&root_str, "hr2", "", true).unwrap();
        assert!(on.has_remote, "probing poll against a repo with origin ⇒ has_remote true");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&origin);
    }

    /// The full expected `WorkflowState` shape at one step of the e2e walk. Mirrors the TS fixture
    /// (`agentCta.e2e.test.ts`'s `wsOf`) field for field.
    struct Shape {
        in_local_main: bool,
        in_origin_main: bool,
        in_parent: bool,
        ahead_of_base: u32,
        landed: bool,
        pushed: bool,
        shipped: bool,
        has_remote: bool,
        pr_state: Option<&'static str>,
        pr_number: Option<u64>,
        pr_url: Option<&'static str>,
    }

    impl Shape {
        /// The baseline for this fixture: a build agent (no parent), against a repo with an origin,
        /// probing, with no release tag and no PR anywhere in the walk.
        fn nothing_landed() -> Self {
            Shape {
                in_local_main: false,
                in_origin_main: false,
                in_parent: false,
                ahead_of_base: 0,
                landed: false,
                pushed: false,
                shipped: false,
                has_remote: true,
                pr_state: None,
                pr_number: None,
                pr_url: None,
            }
        }
    }

    /// Assert a `WorkflowState` matches `want` field for field — `Shape` models the whole struct,
    /// so a caller can express any state (a future step that opens a PR included).
    ///
    /// The destructuring is the point: with no `..` rest pattern, ADDING a field to WorkflowState
    /// fails to compile HERE, so it can't land without someone deciding what this walk should pin.
    /// Precisely: E0027 forces the new field to be MENTIONED, not asserted — a pattern can still
    /// bind `_new_field: _` — and it binds only the Rust side; the TS fixture is held by its own
    /// `Required<WorkflowState>` defaults literal. Both force a decision, neither reads minds.
    ///
    /// Worth the machinery because hand-adding one assertion per field is exactly what let `shipped`
    /// — the strongest signal in the ladder (deriveLiveStage bumps straight to "shipped" on it) —
    /// go unpinned through two review rounds.
    fn assert_workflow_shape(got: &WorkflowState, want: Shape, step: &str) {
        let WorkflowState {
            in_local_main,
            in_origin_main,
            in_parent,
            ahead_of_base,
            landed,
            pushed,
            shipped,
            has_remote,
            pr_state,
            pr_number,
            pr_url,
        } = got;
        assert_eq!(*in_local_main, want.in_local_main, "{step}: in_local_main");
        assert_eq!(*in_origin_main, want.in_origin_main, "{step}: in_origin_main");
        assert_eq!(*in_parent, want.in_parent, "{step}: in_parent");
        assert_eq!(*ahead_of_base, want.ahead_of_base, "{step}: ahead_of_base");
        assert_eq!(*landed, want.landed, "{step}: landed");
        assert_eq!(*pushed, want.pushed, "{step}: pushed");
        // No release tag exists in this fixture. Pinned because deriveLiveStage treats `shipped` as
        // the TOP of the ladder — a tip_in_release/is_semver_tag regression reading true here would
        // silently outrank Land/Push/Close and neither half of the pair would notice.
        assert_eq!(*shipped, want.shipped, "{step}: shipped");
        assert_eq!(*has_remote, want.has_remote, "{step}: has_remote");
        // pr_state is read by deriveLiveStage, so drift here would change the button.
        assert_eq!(pr_state.as_deref(), want.pr_state, "{step}: pr_state");
        assert_eq!(*pr_number, want.pr_number, "{step}: pr_number");
        assert_eq!(pr_url.as_deref(), want.pr_url, "{step}: pr_url");
    }

    /// END-TO-END, against real git: walk a build agent through commit → land on LOCAL main →
    /// push main to origin, pinning the WHOLE `WorkflowState` shape at each step (see
    /// `assert_workflow_shape` — no enumeration here, because a hand-maintained list of fields is
    /// what went stale twice already). The TS half, `agentCta.e2e.test.ts`, transcribes these same
    /// values and asserts what the UI does with them. That transcription IS the seam, so a field
    /// drifting from its default has to fail HERE rather than leave the TS fixture silently wrong.
    /// (The TS fixture is held by its own `Required<WorkflowState>` literal — this walk can't force
    /// it; the two halves are compiler-forced independently.)
    ///
    /// The middle step is the founder's screenshot-2 state ("Landed on main… Nothing is pushed
    /// yet") — the one that used to read as plain `merged` and get a Close pill.
    #[test]
    fn workflow_state_walks_committed_then_local_land_then_origin_push() {
        let root = unique_root("e2e-stages");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("e2e-stages-appdata");
        let origin = unique_root("e2e-stages-remote");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let o = origin.to_str().unwrap();
        git(o, &["init", "--bare", "-q"]).unwrap();
        git(&root_str, &["remote", "add", "origin", o]).unwrap();
        git(&root_str, &["push", "-q", "origin", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "e1", "main", &app_data).unwrap();

        // 1. Committed on its own branch, nothing landed → the frontend reads building_saved → Land.
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        // Every field the TS fixture (agentCta.e2e.test.ts `wsOf`) models is pinned here, so a shape
        // change in Rust fails THIS test rather than leaving the hand-transcribed TS fixture
        // silently stale — the transcription is the seam, so it's the thing worth pinning.
        let s1 = agent_workflow_state_at(&root_str, "e1", "", true).unwrap();
        assert_workflow_shape(
            &s1,
            Shape { ahead_of_base: 1, ..Shape::nothing_landed() },
            "committed on its branch, nothing landed",
        );

        // 2. Landed on LOCAL main only — the founder's screenshot 2. The distinguishing signal is
        //    in_local_main=true while in_origin_main=false; before the split these collapsed into
        //    one `merged` stage and the composer offered Close over unpushed work.
        //
        //    Two values here are counter-intuitive: `landed` is true (a --no-ff merge is reachable,
        //    so the squash signal is trivially true too), and ahead_of_base is 1 rather than 0 —
        //    it's measured against the ref the branch was cut from, which is `origin/main` when that
        //    ref exists, and origin doesn't have the work yet.
        git(&root_str, &["merge", "--no-ff", "sparkle/agent-e1", "-m", "land e1"]).unwrap();
        let s2 = agent_workflow_state_at(&root_str, "e1", "", true).unwrap();
        assert_workflow_shape(
            &s2,
            Shape { in_local_main: true, landed: true, ahead_of_base: 1, ..Shape::nothing_landed() },
            "landed on local main, nothing pushed (founder screenshot 2)",
        );

        // 3. Pushed to origin → in_origin_main flips true → the work is genuinely done → Close.
        git(&root_str, &["push", "-q", "origin", "main"]).unwrap();
        let s3 = agent_workflow_state_at(&root_str, "e1", "", true).unwrap();
        assert_workflow_shape(
            &s3,
            Shape {
                in_local_main: true,
                in_origin_main: true,
                landed: true,
                ahead_of_base: 0,
                ..Shape::nothing_landed()
            },
            "pushed to origin main",
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&origin);
    }

    #[test]
    fn pr_create_args_guards_blank_target_and_defaults_title() {
        // Blank base would become `gh pr create --base ""` (opaque error) — reject early.
        assert!(pr_create_args("sparkle/agent-x", "  ", "t", "").is_err());
        // Title falls back to the branch name when blank.
        let a = pr_create_args("sparkle/agent-x", "main", "  ", "").unwrap();
        let joined = a.join(" ");
        assert!(joined.contains("--base main"));
        assert!(joined.contains("--head sparkle/agent-x"));
        assert!(joined.contains("--title sparkle/agent-x"), "blank title → branch name");
        // A real title is preserved (trimmed).
        let b = pr_create_args("sparkle/agent-x", "main", " Ship it ", "").unwrap();
        assert!(b.join(" ").contains("--title Ship it"));
    }

    #[test]
    fn delete_agent_branch_removes_the_ref_and_is_idempotent() {
        let root = unique_root("del-branch");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("del-branch-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "d1", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "unmerged work"]).unwrap();
        assert!(git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-d1"]).is_ok());

        // The branch is checked out in the worktree → must remove the worktree before deleting.
        git(&root_str, &["worktree", "remove", "--force", &info.path]).unwrap();
        delete_agent_branch_at(&root_str, "d1").unwrap();
        assert!(
            git(&root_str, &["rev-parse", "--verify", "--quiet", "refs/heads/sparkle/agent-d1"]).is_err(),
            "branch ref is gone after Discard"
        );
        // Idempotent: deleting an already-gone branch is Ok, not an error.
        delete_agent_branch_at(&root_str, "d1").unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn push_agent_branch_reports_no_remote_when_origin_is_absent() {
        let root = unique_root("push-noremote");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("push-noremote-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "pp", "main", &app_data).unwrap();
        // No `origin` in this fixture → Ship/Save must learn to fall back, not error.
        assert_eq!(push_agent_branch_at(&root_str, "pp").unwrap(), "no-remote");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // A SQUASH merge creates a NEW commit on main, so the agent tip is NOT an ancestor — ancestor
    // reachability (`in_local_main`) misses it. The `landed` tree-identity signal catches it, while
    // the branch still carries its original commit so `ahead_of_base > 0` keeps committedSeen true.
    #[test]
    fn workflow_state_detects_a_squash_merge_even_as_main_advances() {
        let root = unique_root("wf-squash");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-squash-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "sq", "main", &app_data).unwrap();

        // Agent authors real work on its branch.
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();

        // Squash-land it: stage the branch's net change as a fresh commit on main (no merge parent).
        git(&root_str, &["merge", "--squash", "sparkle/agent-sq"]).unwrap();
        git(&root_str, &["commit", "-m", "squash land sq"]).unwrap();

        let s = agent_workflow_state_at(&root_str, "sq", "", false).unwrap();
        assert!(!s.in_local_main, "squash made a new commit → tip is not an ancestor of main");
        assert!(s.landed, "merging the branch into main now adds nothing → landed (the squash signal)");
        assert!(s.ahead_of_base > 0, "branch still carries its original commit → committedSeen holds");

        // Main ADVANCES with unrelated work after the squash (the shared-main reality). Whole-tree
        // equality would now read false; the merge-tree "adds nothing" check must still see it landed.
        std::fs::write(root.join("unrelated.txt"), "other agent's work\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "unrelated work on main"]).unwrap();
        let s2 = agent_workflow_state_at(&root_str, "sq", "", false).unwrap();
        assert!(!s2.in_local_main, "still not an ancestor");
        assert!(s2.landed, "merging adds nothing even though main moved on → landed survives advancing main");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // A no-op branch (no authored commits) is trivially tree-identical to an unchanged default, so
    // `landed` is true — but `ahead_of_base == 0`, so the frontend committedSeen gate keeps it from
    // ever reading as Merged. This pins that `landed` alone never implies "merged".
    #[test]
    fn workflow_state_landed_is_gated_by_authored_work_for_a_noop_branch() {
        let root = unique_root("wf-noop");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-noop-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        create_worktree_at(&root_str, "p", "noop", "main", &app_data).unwrap();

        let s = agent_workflow_state_at(&root_str, "noop", "", false).unwrap();
        assert!(s.landed, "no changes ⇒ tip tree == main tree ⇒ trivially landed");
        assert_eq!(s.ahead_of_base, 0, "no authored work ⇒ committedSeen gate stays closed");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // `pushed` reflects whether the agent branch's remote-tracking ref exists — the LIVE signal that
    // lights the "Pushed" stage without needing a PR. Before pushing there is no `origin/<branch>`
    // ref; simulating a push (creating the remote-tracking ref, exactly what `git push` does locally)
    // flips it true. Kept a pure local ref lookup so it's offline-safe.
    #[test]
    fn workflow_state_pushed_tracks_the_remote_tracking_ref() {
        let root = unique_root("wf-pushed");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-pushed-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "push", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();

        let before = agent_workflow_state_at(&root_str, "push", "", false).unwrap();
        assert!(!before.pushed, "no remote-tracking ref yet ⇒ not pushed");

        // Simulate a push: git creates refs/remotes/origin/<branch> on a successful push.
        let tip = git(&root_str, &["rev-parse", "sparkle/agent-push"]).unwrap();
        git(&root_str, &["update-ref", "refs/remotes/origin/sparkle/agent-push", &tip]).unwrap();
        let after = agent_workflow_state_at(&root_str, "push", "", false).unwrap();
        assert!(after.pushed, "remote-tracking ref now exists ⇒ pushed (drives the Pushed stage live)");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // `shipped` is true only when the branch tip is contained in a RELEASE tag (semver-ish). A
    // non-release tag (`nightly`) must NOT read as shipped; a `v*` tag must. This drives the top
    // "Shipped to Production" stage live — previously unreachable.
    #[test]
    fn workflow_state_shipped_requires_a_release_tag_on_the_tip() {
        let root = unique_root("wf-shipped");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-shipped-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "ship", "main", &app_data).unwrap();
        std::fs::write(Path::new(&info.path).join("w.txt"), "work\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent work"]).unwrap();
        let tip = git(&root_str, &["rev-parse", "sparkle/agent-ship"]).unwrap();

        // A non-release tag on the tip must not count as shipped.
        git(&root_str, &["tag", "nightly", &tip]).unwrap();
        let s0 = agent_workflow_state_at(&root_str, "ship", "", false).unwrap();
        assert!(!s0.shipped, "a non-release tag (nightly) is not a ship signal");

        // A semver release tag containing the tip ⇒ shipped.
        git(&root_str, &["tag", "v1.2.3", &tip]).unwrap();
        let s1 = agent_workflow_state_at(&root_str, "ship", "", false).unwrap();
        assert!(s1.shipped, "a v* release tag containing the tip ⇒ shipped (drives the Shipped stage live)");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // Regression: a brand-new agent whose branch is cut from `origin/<default>` while the LOCAL
    // default lags the remote must NOT read as having done work. Before the fix, `ahead_of_base`
    // was counted against local `main`, so the inherited (un-pulled) commits looked like the agent's
    // own — tripping the frontend `committedSeen` gate which, with `in_origin_main` trivially true,
    // rendered a fresh no-op agent as "Merged".
    #[test]
    fn fresh_branch_cut_from_origin_default_reads_as_no_work_when_local_lags() {
        let root = unique_root("wf-lag");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-lag-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // Advance the remote integration branch ahead of local main on a temp branch (local main
        // itself never moves, so it lags origin) — exactly the state of a user who hasn't pulled.
        git(&root_str, &["checkout", "-b", "remote-advance"]).unwrap();
        std::fs::write(root.join("r1.txt"), "remote work\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "remote ahead"]).unwrap();
        let remote_tip = git(&root_str, &["rev-parse", "HEAD"]).unwrap();
        git(&root_str, &["update-ref", "refs/remotes/origin/main", &remote_tip]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        git(&root_str, &["branch", "-D", "remote-advance"]).unwrap();

        // A brand-new agent: branch cut from origin/main (as effective_base would), zero authored work.
        let wt = worktree_path(&app_data, "p", "fresh").unwrap();
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(&root_str, &["worktree", "add", "-b", "sparkle/agent-fresh", &wt.to_string_lossy(), "origin/main"]).unwrap();

        let ws = agent_workflow_state_at(&root_str, "fresh", "", false).unwrap();
        assert!(ws.in_origin_main, "tip IS origin/main");
        assert!(!ws.in_local_main, "lagging local main does not contain the tip");
        assert_eq!(
            ws.ahead_of_base, 0,
            "no AUTHORED work ⇒ gate stays closed even though local main lags origin (regression)"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn land_merges_agent_branch_into_main_and_guards_dirty_and_empty() {
        let root = unique_root("land");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("land-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap(); // main is checked out at root
        // ensure_project_repo leaves .gitignore UNTRACKED; commit it so the root (our land target)
        // starts clean — a real well-kept project root would have it committed.
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "chore: gitignore"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "L1", "main", &app_data).unwrap();

        // Nothing committed yet → nothing to land.
        match land_agent_branch_at(&root_str, "L1", "main").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "nothing-to-land"),
            LandOutcome::Ok { .. } => panic!("should refuse an empty branch"),
        }

        // Commit real work on the agent branch.
        std::fs::write(Path::new(&info.path).join("f.txt"), "feature\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent feature"]).unwrap();

        // A dirty target (root) is refused without touching anything.
        std::fs::write(root.join("scratch.txt"), "wip").unwrap();
        match land_agent_branch_at(&root_str, "L1", "main").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "dirty"),
            LandOutcome::Ok { .. } => panic!("should refuse a dirty target"),
        }
        std::fs::remove_file(root.join("scratch.txt")).unwrap();

        // Clean target → the merge lands and main now contains the agent tip.
        match land_agent_branch_at(&root_str, "L1", "main").unwrap() {
            LandOutcome::Ok { target, ok, merge_sha } => {
                assert!(ok);
                assert_eq!(target, "main");
                // The land captured the merge commit it created — a full 40-char SHA equal to
                // main's new HEAD (Task B: the bead records this for release-containment checks).
                let head = git(&root_str, &["rev-parse", "main"]).unwrap().trim().to_string();
                assert_eq!(merge_sha, head, "captured merge_sha should be main's new HEAD");
                assert_eq!(merge_sha.len(), 40, "expected a full commit SHA");
            }
            LandOutcome::Err { reason, .. } => panic!("expected land to succeed, got {reason}"),
        }
        let ws = agent_workflow_state_at(&root_str, "L1", "", false).unwrap();
        assert!(ws.in_local_main, "after land, main contains the agent tip");
        assert_eq!(ws.ahead_of_base, 0, "no commits remain unique to the branch");

        // Re-landing is now a no-op (idempotent guard).
        match land_agent_branch_at(&root_str, "L1", "main").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "nothing-to-land"),
            LandOutcome::Ok { .. } => panic!("re-land should be a no-op"),
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn land_outcome_serializes_merge_sha_as_camelcase_for_the_ts_client() {
        // Guards the serde field-name boundary the in-process land test can't see: `LandOutcome` is
        // untagged with no container rename_all, so the multi-word field must serialize as `mergeSha`
        // (what TS `LandResult` reads). Without the explicit rename this is `merge_sha` and the whole
        // capture feature no-ops silently in production.
        let ok = LandOutcome::Ok { ok: true, target: "main".into(), merge_sha: "deadbeef".into() };
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v.get("mergeSha").and_then(|s| s.as_str()), Some("deadbeef"));
        assert!(v.get("merge_sha").is_none(), "must not leak the snake_case field name");
    }

    #[test]
    fn land_conflict_aborts_cleanly_and_target_not_checked_out_is_reported() {
        let root = unique_root("land-conflict");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("land-conflict-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        // A base file both sides will edit differently → a guaranteed merge conflict.
        std::fs::write(root.join("c.txt"), "base\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "base"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "L2", "main", &app_data).unwrap();

        // Agent edits c.txt one way…
        std::fs::write(Path::new(&info.path).join("c.txt"), "agent side\n").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "agent edit"]).unwrap();
        // …main edits the same lines another way.
        std::fs::write(root.join("c.txt"), "main side\n").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "main edit"]).unwrap();
        let main_before = git(&root_str, &["rev-parse", "main"]).unwrap();

        // A target that doesn't resolve → no-target (and it returns BEFORE the rev-list, so a
        // missing target never masquerades as "nothing-to-land" — the regression this guards).
        match land_agent_branch_at(&root_str, "L2", "does-not-exist").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "no-target"),
            LandOutcome::Ok { .. } => panic!("a missing target can't be landed into"),
        }

        // A branch that exists but is checked out nowhere → target-not-checked-out (not "conflict").
        git(&root_str, &["branch", "shelf", "main"]).unwrap();
        match land_agent_branch_at(&root_str, "L2", "shelf").unwrap() {
            LandOutcome::Err { reason, .. } => assert_eq!(reason, "target-not-checked-out"),
            LandOutcome::Ok { .. } => panic!("a non-checked-out target can't be landed into"),
        }

        // Landing into main conflicts; it must abort cleanly and leave main byte-identical.
        match land_agent_branch_at(&root_str, "L2", "main").unwrap() {
            LandOutcome::Err { reason, files, .. } => {
                assert_eq!(reason, "conflict");
                assert!(files.iter().any(|f| f == "c.txt"), "conflicted file reported: {files:?}");
            }
            LandOutcome::Ok { .. } => panic!("expected a conflict"),
        }
        assert_eq!(git(&root_str, &["rev-parse", "main"]).unwrap(), main_before, "main HEAD unchanged");
        assert!(git(&root_str, &["status", "--porcelain"]).unwrap().is_empty(), "abort left a clean tree");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn workflow_state_in_parent_tracks_merge_into_orchestrator_branch() {
        let root = unique_root("wf-parent");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("wf-parent-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();

        // Orchestrator agent + a worker cut from the orchestrator's branch.
        let orch = create_worktree_at(&root_str, "p", "orch", "main", &app_data).unwrap();
        std::fs::write(Path::new(&orch.path).join("o.txt"), "orch\n").unwrap();
        git(&orch.path, &["add", "-A"]).unwrap();
        git(&orch.path, &["commit", "-m", "orch base"]).unwrap();
        let worker = create_worktree_from_local(&root_str, "p", "wk", "sparkle/agent-orch", &app_data).unwrap();
        std::fs::write(Path::new(&worker.path).join("wk.txt"), "wk\n").unwrap();
        git(&worker.path, &["add", "-A"]).unwrap();
        git(&worker.path, &["commit", "-m", "worker work"]).unwrap();

        // Before merge: worker not yet in orchestrator branch.
        let s0 = agent_workflow_state_at(&root_str, "wk", "sparkle/agent-orch", false).unwrap();
        assert!(!s0.in_parent, "worker work not yet merged into the orchestrator branch");

        // Merge worker → orchestrator branch (worker's "On Main").
        git(&orch.path, &["merge", "--no-ff", "sparkle/agent-wk", "-m", "land worker"]).unwrap();
        let s1 = agent_workflow_state_at(&root_str, "wk", "sparkle/agent-orch", false).unwrap();
        assert!(s1.in_parent, "orchestrator branch now contains the worker tip → worker On Main");
        assert!(!s1.in_local_main, "orchestrator hasn't landed on main, so worker isn't Merged");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn markdown_changed_since_seeds_then_increments_scoped_to_dirs() {
        let root = unique_root("md-sync");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("md-sync-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        git(&root_str, &["checkout", "main"]).unwrap();
        let info = create_worktree_at(&root_str, "p", "md1", "main", &app_data).unwrap();
        let wt = Path::new(&info.path);
        let dirs = vec!["PRD".to_string(), "docs/superpowers/specs".to_string()];

        // Commit a progress doc, a spec, an out-of-scope README, and an in-scope non-md file.
        std::fs::create_dir_all(wt.join("PRD")).unwrap();
        std::fs::create_dir_all(wt.join("docs/superpowers/specs")).unwrap();
        std::fs::write(wt.join("PRD/main.md"), "# progress v1").unwrap();
        std::fs::write(wt.join("docs/superpowers/specs/x.md"), "# spec").unwrap();
        std::fs::write(wt.join("PRD/notes.txt"), "not markdown").unwrap();
        std::fs::write(wt.join("README.md"), "# readme outside scope").unwrap();
        git(&info.path, &["add", "-A"]).unwrap();
        git(&info.path, &["commit", "-m", "docs"]).unwrap();
        let after_first = git(&info.path, &["rev-parse", "HEAD"]).unwrap();

        // Seed (empty since): both in-scope markdown files, with their content; nothing else.
        let seed = markdown_changed_since_at("p", "md1", "", &dirs, &app_data).unwrap();
        let mut paths: Vec<&str> = seed.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["PRD/main.md", "docs/superpowers/specs/x.md"]);
        let prd = seed.files.iter().find(|f| f.path == "PRD/main.md").unwrap();
        assert_eq!(prd.content, "# progress v1");
        assert_eq!(seed.head_sha, after_first);

        // Increment: change only the progress doc; since=after_first → only that file.
        std::fs::write(wt.join("PRD/main.md"), "# progress v2").unwrap();
        git(&info.path, &["commit", "-am", "update progress"]).unwrap();
        let inc = markdown_changed_since_at("p", "md1", &after_first, &dirs, &app_data).unwrap();
        let inc_paths: Vec<&str> = inc.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(inc_paths, vec!["PRD/main.md"]);
        assert_eq!(inc.files[0].content, "# progress v2", "current content, not the old blob");

        // A bogus/unknown since falls back to a full seed rather than erroring.
        let fallback = markdown_changed_since_at("p", "md1", "deadbeef", &dirs, &app_data).unwrap();
        assert_eq!(fallback.files.len(), 2, "unknown sha → reseed");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worktree_is_cut_from_base_branch_not_arbitrary_head() {
        let root = unique_root("cut-base");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("cut-base-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        // Move HEAD onto an unrelated branch with a divergent commit.
        git(&root_str, &["checkout", "-b", "scratch"]).unwrap();
        std::fs::write(root.join("scratch.txt"), "x").unwrap();
        git(&root_str, &["add", "-A"]).unwrap();
        git(&root_str, &["commit", "-m", "scratch commit"]).unwrap();
        // A new agent based on `main` must NOT contain scratch.txt (cut from main, not HEAD).
        let info = create_worktree_at(&root_str, "p", "agg", "main", &app_data).unwrap();
        assert!(!Path::new(&info.path).join("scratch.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn resolve_default_branch_uses_current_branch_with_no_remote() {
        let root = unique_root("rdb-noremote");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        // ensure_project_repo's first commit lands on whatever `git init` defaults to.
        let current = git(&root_str, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(resolve_default_branch(&root_str), current);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_default_branch_prefers_local_main() {
        let root = unique_root("rdb-main");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        // Create a `main` branch even if the repo initialized on `master`.
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        assert_eq!(resolve_default_branch(&root_str), "main");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_default_branch_honors_config_override() {
        // A non-empty [workflow].default_branch from the per-project config must win over git
        // auto-detection; a whitespace-only value falls through to auto-detect.
        let root = unique_root("rdb-config");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        assert_eq!(resolve_default_branch(&root_str), "main");

        let sparkle = root.join(".sparkle");
        std::fs::create_dir_all(&sparkle).unwrap();
        let cfg = sparkle.join("config.toml");

        std::fs::write(&cfg, "[workflow]\ndefault_branch = \"release/x\"\n").unwrap();
        assert_eq!(resolve_default_branch(&root_str), "release/x");

        std::fs::write(&cfg, "[workflow]\ndefault_branch = \"   \"\n").unwrap();
        assert_eq!(resolve_default_branch(&root_str), "main");

        let _ = std::fs::remove_dir_all(&root);
    }

    // The per-project layer of this config is a file CHECKED INTO THE REPO, and the resolved name
    // reaches `git fetch origin <branch>` as a bare argument — so an override shaped like an option
    // is the exact injection `validate_ref` exists to block, arriving from a repo the user merely
    // opened. Callers that validate their own input fall back to this function, so it has to reject
    // the value itself rather than trust a caller-side check.
    #[test]
    fn resolve_default_branch_rejects_an_option_shaped_config_override() {
        let root = unique_root("rdb-unsafe");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();

        let sparkle = root.join(".sparkle");
        std::fs::create_dir_all(&sparkle).unwrap();
        let cfg = sparkle.join("config.toml");

        // The option shape, and the refspec shape that is not an option and so slipped past a
        // not-an-option check — `git fetch origin <arg>` would read the latter as `<src>:<dst>` and
        // force-overwrite a local branch on a poll tick.
        let hostile_values = [
            "--upload-pack=touch /tmp/pwned",
            "-x",
            "main\nfetch",
            "+refs/heads/evil:refs/heads/main",
            "refs/heads/evil:refs/heads/sparkle/agent-a1",
        ];
        for hostile in hostile_values {
            std::fs::write(&cfg, format!("[workflow]\ndefault_branch = {hostile:?}\n")).unwrap();
            assert_eq!(
                resolve_default_branch(&root_str),
                "main",
                "an unsafe override must fall through to auto-detection, not reach git: {hostile:?}"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn effective_base_falls_back_to_local_when_remote_unreachable() {
        let root = unique_root("eb-offline");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        git(&root_str, &["branch", "-f", "main", "HEAD"]).unwrap();
        // A remote that cannot be fetched.
        git(&root_str, &["remote", "add", "origin", "file:///nonexistent/repo.git"]).unwrap();
        // fetch:true must NOT panic/return an origin ref it can't reach — falls back to local.
        assert_eq!(effective_base(&root_str, "main", true), "main");
        // fetch:false with no remote-tracking ref also falls back to local.
        assert_eq!(effective_base(&root_str, "main", false), "main");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The flooding shape: hook install is retried once per agent open, so an unresolvable root
    /// repeats the SAME failure forever. Only the first occurrence may warn; repeats are demoted.
    /// A root whose error text changes is a different fact and warns again.
    #[test]
    fn hook_failure_warns_once_per_root_and_error() {
        let root = unique_root("hookwarn").to_string_lossy().to_string();
        let other = unique_root("hookwarn2").to_string_lossy().to_string();
        let enotdir = "cannot create hooks dir: Not a directory (os error 20)";

        // First sighting warns; the identical retries that follow do not.
        assert!(should_warn_hook_failure(&root, enotdir));
        assert!(!should_warn_hook_failure(&root, enotdir));
        assert!(!should_warn_hook_failure(&root, enotdir));

        // A DIFFERENT failure on the same root is new information — it gets its own warning.
        assert!(should_warn_hook_failure(&root, "bundled resource missing"));
        assert!(!should_warn_hook_failure(&root, "bundled resource missing"));

        // Dedupe is per-root: another project hitting the same error still warns once.
        assert!(should_warn_hook_failure(&other, enotdir));
        assert!(!should_warn_hook_failure(&other, enotdir));
    }

    #[test]
    fn ensure_project_repo_is_idempotent_on_empty_and_existing() {
        let root = unique_root("idem");
        let root_str = root.to_string_lossy().to_string();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        // HEAD exists (born) so worktrees are possible.
        assert!(git(&root_str, &["rev-parse", "HEAD"]).is_ok());
        // Running again is a no-op (no second commit, no error).
        let head1 = git(&root_str, &["rev-parse", "HEAD"]).unwrap();
        ensure_project_repo_inner(root_str.clone()).unwrap();
        let head2 = git(&root_str, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(head1, head2, "no extra commit on re-run");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn worker_worktree_is_cut_from_parent_local_branch() {
        let root = unique_root("worker-cut");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("worker-cut-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        // Parent agent "build1" gets a worktree off HEAD, then makes a unique commit on its branch.
        let parent = create_worktree_at(&root_str, "p", "build1", "HEAD", &app_data).unwrap();
        std::fs::write(Path::new(&parent.path).join("PARENT_MARK.txt"), "x").unwrap();
        git(&parent.path, &["add", "-A"]).unwrap();
        git(&parent.path, &["commit", "-m", "parent unique commit"]).unwrap();

        // Worker "w1" is cut from the parent's LOCAL branch — must contain the parent's commit.
        let worker =
            create_worktree_from_local(&root_str, "p", "w1", &parent.branch, &app_data).unwrap();
        assert_eq!(worker.branch, "sparkle/agent-w1");
        assert!(Path::new(&worker.path).join("PARENT_MARK.txt").exists(),
            "worker branch should descend from the parent branch");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worker_prepare_idempotent_does_not_reclobber_lineage() {
        // CRITICAL lineage guard: when the worker tab opens, AgentPane.prepare() calls
        // create_worktree_at with the worker's baseBranch (= project default, e.g. "main"). That must
        // NOT re-cut the worker off main — the idempotency short-circuit (worktree.rs:202, which runs
        // BEFORE any base resolution) returns the existing parent-branch worktree unchanged. This test
        // pins that behavior so a future change to the guard can't silently clobber worker lineage.
        let root = unique_root("worker-prep");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("worker-prep-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        let parent = create_worktree_at(&root_str, "p", "build1", "HEAD", &app_data).unwrap();
        std::fs::write(Path::new(&parent.path).join("PARENT_MARK.txt"), "x").unwrap();
        git(&parent.path, &["add", "-A"]).unwrap();
        git(&parent.path, &["commit", "-m", "parent unique commit"]).unwrap();

        let worker = create_worktree_from_local(&root_str, "p", "w1", &parent.branch, &app_data).unwrap();
        // Simulate the subsequent prepare() call with the project default base.
        let again = create_worktree_at(&root_str, "p", "w1", "main", &app_data).unwrap();
        assert_eq!(again.path, worker.path);
        assert!(Path::new(&again.path).join("PARENT_MARK.txt").exists(),
            "parent-branch lineage must be preserved, not re-cut from main");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worker_worktree_rejects_empty_parent_branch() {
        let root = unique_root("worker-empty");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("worker-empty-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        for bad in ["", "   "] {
            let err = create_worktree_from_local(&root_str, "p", "w1", bad, &app_data)
                .err()
                .expect("expected Err for empty parent_branch");
            assert!(err.contains("parent_branch is required"), "got: {err}");
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn worker_worktree_rejects_nonexistent_local_base() {
        let root = unique_root("worker-nobase");
        let root_str = root.to_string_lossy().to_string();
        let app_data = unique_root("worker-nobase-appdata");
        ensure_project_repo_inner(root_str.clone()).unwrap();

        let err = create_worktree_from_local(&root_str, "p", "w1", "sparkle/agent-missing", &app_data)
            .err()
            .expect("expected Err for nonexistent local base");
        assert!(err.contains("does not exist locally"), "got: {err}");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn read_worker_result_returns_none_then_some() {
        let dir = unique_root("worker-result");
        // Absent → None.
        assert!(read_worker_result_at(&dir).unwrap().is_none());
        // Present → Some(contents).
        let sparkle = dir.join(".sparkle");
        std::fs::create_dir_all(&sparkle).unwrap();
        std::fs::write(sparkle.join("result.json"), r#"{"ok":true}"#).unwrap();
        assert_eq!(read_worker_result_at(&dir).unwrap().as_deref(), Some(r#"{"ok":true}"#));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn worker_manifest_write_then_read_roundtrips() {
        // sparkle-hwfv: writing a manifest into a worktree makes it readable back verbatim,
        // creating `.sparkle/` as needed.
        let dir = unique_root("worker-manifest-rt");
        assert!(read_worker_manifest_at(&dir).unwrap().is_none()); // absent → None
        let manifest = json!({
            "workerId": "w1", "buildAgentId": "b1", "projectId": "p1",
            "branch": "sparkle/agent-w1", "worktree": dir.to_string_lossy(),
            "task": "do it", "beadId": "bead-9", "createdAt": "2026-07-06T00:00:00Z",
        });
        write_worker_manifest_at(&dir, &manifest).unwrap();
        let got = read_worker_manifest_at(&dir).unwrap().expect("manifest present after write");
        assert_eq!(got["workerId"], "w1");
        assert_eq!(got["buildAgentId"], "b1");
        assert_eq!(got["task"], "do it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_worker_manifests_collects_and_injects_worktree_path() {
        // sparkle-3xus: the scan returns each worktree's manifest, overwriting `worktree` with the
        // ACTUAL on-disk directory (authoritative) and skipping dirs without a manifest.
        let app_data = unique_root("scan-app-data");
        let project_id = "proj-scan";
        let wt_root = app_data.join("worktrees").join(project_id);
        std::fs::create_dir_all(&wt_root).unwrap();

        // Worker A: has a manifest (with a deliberately STALE worktree value to prove it's fixed).
        let wa = wt_root.join("worker-a");
        std::fs::create_dir_all(&wa).unwrap();
        write_worker_manifest_at(
            &wa,
            &json!({ "workerId": "worker-a", "buildAgentId": "b1", "projectId": project_id,
                     "branch": "sparkle/agent-a", "worktree": "/stale/path", "task": "t",
                     "createdAt": "x" }),
        )
        .unwrap();

        // Worker B: a bare worktree dir with NO manifest (legacy worker) → skipped.
        std::fs::create_dir_all(wt_root.join("worker-b")).unwrap();

        let found = scan_worker_manifests_at(&app_data, project_id).unwrap();
        assert_eq!(found.len(), 1, "only the dir with a manifest is returned");
        let m = &found[0];
        assert_eq!(m["workerId"], "worker-a");
        // `worktree` is the REAL directory found, not the stale value written into the file.
        assert_eq!(m["worktree"], wa.to_string_lossy().to_string());

        // A project with no worktrees dir yet → empty (not an error).
        assert!(scan_worker_manifests_at(&app_data, "no-such-project").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// The slow-operation boundary, pinned at the edges rather than in the middle.
    ///
    /// The values that matter are the ones either side of the threshold: an ordinary teardown must
    /// stay an INFO (a WARN on every agent close is noise nobody reads), and the observed ~33s
    /// removal that delayed an unrelated spawn must come out as a WARN — that case is the entire
    /// reason the duration is recorded.
    #[test]
    fn slow_worktree_op_boundary() {
        use std::time::Duration;
        assert!(!worktree_op_is_slow(Duration::from_millis(0)));
        assert!(!worktree_op_is_slow(Duration::from_secs(2)));
        assert!(!worktree_op_is_slow(Duration::from_millis(
            WORKTREE_OP_SLOW_MS as u64 - 1
        )));
        // The threshold itself is slow: the doc calls 10s the top of the expected range, so
        // reaching it is already outside it.
        assert!(worktree_op_is_slow(Duration::from_millis(WORKTREE_OP_SLOW_MS as u64)));
        assert!(worktree_op_is_slow(Duration::from_secs(33)));
    }

    /// The lock-wait boundary, and the ordering property that makes the field worth logging.
    ///
    /// A wait only ever explains a total that has already tripped the slow threshold, so it has to
    /// become visible strictly BEFORE it would trip that threshold on its own — otherwise the two
    /// numbers cross at the same point and the wait can never distinguish queueing from work,
    /// which is its whole purpose.
    #[test]
    fn repo_lock_wait_boundary() {
        use std::time::Duration;
        // Uncontended is the common case on every agent close; it must stay silent.
        assert!(!repo_lock_wait_is_notable(Duration::from_millis(0)));
        assert!(!repo_lock_wait_is_notable(Duration::from_millis(
            REPO_LOCK_WAIT_LOG_MS as u64 - 1
        )));
        assert!(repo_lock_wait_is_notable(Duration::from_millis(
            REPO_LOCK_WAIT_LOG_MS as u64
        )));
        // The case from the logs: a removal reporting ~30s total that spent nearly all of it
        // queued behind other removals rather than deleting anything.
        assert!(repo_lock_wait_is_notable(Duration::from_secs(29)));
        // A notable wait must not itself require a slow total to be reported.
        assert!(REPO_LOCK_WAIT_LOG_MS < WORKTREE_OP_SLOW_MS);
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DIFF INSPECTION (concierge PRD section J)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// "What did this agent actually change?" was unanswerable from the concierge column. It could see
// that a branch was ahead by N commits (`agent_branch_status`) and it could read the agent's
// terminal, but the terminal narrates INTENT — what the agent said it did — and the two diverge
// exactly when it matters. The diff is the only account of the work that cannot be wrong.
//
// READ-ONLY BY CONSTRUCTION. Every git invocation here is a plumbing read (`diff --stat`,
// `diff --numstat`, `diff -- <path>`, `log`). Nothing writes a ref, stages, stashes or checks out.
// That is what lets the whole surface sit in the `read-only` risk tier and run without an approval.
//
// TWO BUDGETS, BOTH MANDATORY. A diff is unbounded and lands in an LLM context window, so:
//   • the FILE LIST is capped by count — a 900-file refactor returns the first N and says so;
//   • a FILE'S TEXT is capped by lines AND chars, and a truncated body says so, in words, with
//     amounts. Silent truncation would let the concierge report "that's the whole change" about a
//     fragment, which is the confident-and-wrong failure this surface must not have.

/// Ceiling on files returned by one `diff_files` call. A caller may ask for fewer, never more.
const DIFF_MAX_FILES: usize = 200;
/// Ceiling on lines of one file's patch text.
const DIFF_MAX_LINES: usize = 400;
/// Ceiling on chars of one file's patch text — the same budget the terminal read uses, for the same
/// reason (a runaway payload someone pays for).
const DIFF_MAX_CHARS: usize = 4000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    /// Lines added / removed. `None` for a binary file — numstat prints "-" there, and reporting 0
    /// would read as "nothing changed" rather than "not countable".
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub binary: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub base: String,
    pub head: String,
    pub files: Vec<DiffFile>,
    /// How many files the diff ACTUALLY has, before the cap. Equal to `files.len()` when nothing
    /// was dropped; larger when the cap bit — so a caller can always tell the difference between
    /// "that's all of them" and "that's the first 200 of 900".
    pub total_files: usize,
    pub truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffText {
    pub path: String,
    pub text: String,
    pub truncated: bool,
    /// Present only when truncated: what was left out, so the caller can say so honestly.
    pub omitted_lines: Option<usize>,
    /// Bytes left out. The LINE count alone understates badly when one dropped line is a minified
    /// bundle: "1 line omitted" is true and useless about 200 KB.
    pub omitted_bytes: Option<usize>,
}

/// The two-dot range every op here reads. `base...head` (three-dot) would diff against the merge
/// base, which is what a PR shows; two-dot shows the literal difference between the two trees. We
/// use three-dot deliberately: "what did this agent change" means its own commits, not other
/// people's work that landed on the base since it branched.
fn diff_range(base: &str, head: &str) -> String {
    format!("{base}...{head}")
}

/// Apply BOTH budgets in one pass, returning the text and how many lines it actually holds.
///
/// Applying the line cap, deciding `omitted_lines` from it, and THEN cutting on chars made the
/// number a lie whenever the char cap bound first — which it does for any patch averaging over 10
/// chars a line, i.e. essentially every real one. A 300-line patch came back `truncated: true,
/// omitted_lines: null` (no amount to report, though both descriptors tell the model to report one),
/// and a 500-line patch came back `omitted_lines: 100` when the text stopped near line 100 — a
/// confident ~4x under-report, worse than silence (roborev 55193).
///
/// Cuts on a LINE boundary: a mid-line cut leaves `- if (x) return` as the last emitted line, which
/// reads as a complete diff line rather than as a fragment.
fn clip_patch(lines: &[&str], cap: usize) -> (String, usize) {
    let mut text = String::new();
    let mut emitted = 0usize;
    for line in lines.iter().take(cap) {
        let cost = line.len() + usize::from(!text.is_empty());
        if text.len() + cost > DIFF_MAX_CHARS {
            // THE FIRST LINE IS NOT EXEMPT. Guarding this on `!text.is_empty()` meant line one was
            // emitted whole and unbounded — and a patch whose first line is a minified bundle, a
            // source map, a lockfile blob or an inlined data URI is one line. `read_file_diff` then
            // returned hundreds of KB with `truncated: false`, blowing the stated cap by orders of
            // magnitude while reporting a complete patch: wrong about itself in the opposite
            // direction from the bug this function was written to fix (roborev 55201).
            if text.is_empty() {
                // Nothing would fit at all. Emit a prefix so the caller sees SOMETHING of the
                // patch, cut on a char boundary — a byte slice through UTF-8 panics, and diffs are
                // full of it. It does NOT count as emitted, so `omitted_lines` still reports every
                // line as missing, which is true: no line was delivered in full.
                let mut end = DIFF_MAX_CHARS.min(line.len());
                while end > 0 && !line.is_char_boundary(end) {
                    end -= 1;
                }
                text.push_str(&line[..end]);
            }
            break;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(line);
        emitted += 1;
    }
    (text, emitted)
}

/// How a clip is REPORTED. Extracted so the mapping can be tested directly: the previous test
/// asserted `400 - emitted == 400 - text.lines().count()`, which reduces to `emitted ==
/// text.lines().count()` — a tautology of clip_patch's own loop that would pass against any
/// implementation, including one reporting `omitted_lines` wrongly (roborev 55201). The behaviour
/// that actually regressed is this mapping, so this is the thing to test.
fn clip_report(total: usize, emitted: usize) -> (bool, Option<usize>) {
    if emitted < total {
        (true, Some(total - emitted))
    } else {
        (false, None)
    }
}

/// How many BYTES were dropped, which the line count alone can badly understate: a patch of four
/// header lines plus one 200 KB minified line reports `omitted_lines: 1`, literally true and wildly
/// misleading about the size of what is missing (roborev 55208). Reported alongside the line count
/// so a caller can say "1 line, 200 KB" rather than "1 line".
fn omitted_bytes(lines: &[&str], emitted: usize) -> Option<usize> {
    let dropped: usize = lines.iter().skip(emitted).map(|l| l.len() + 1).sum();
    if dropped > 0 {
        Some(dropped)
    } else {
        None
    }
}

/// git C-QUOTES any path with non-ASCII bytes, a quote or a backslash unless `core.quotepath` is
/// off: `src/café.ts` comes back as `"src/caf\303\251.ts"`. The descriptor tells the model to feed a
/// path straight from `diff_files` into `diff_file_text`, and a quoted literal matches NO pathspec —
/// git then exits 0 with empty output, so the answer is "that file is unchanged" about a file that
/// was rewritten. A silent wrong answer on the one surface whose stated purpose is that it cannot be
/// wrong about itself (roborev 55193). `-c` rather than a repo config write: this is a read.
fn git_raw_paths(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut full = vec!["-c", "core.quotepath=false"];
    full.extend_from_slice(args);
    git(cwd, &full)
}

/// Which ref could not be resolved — so a caller can tell "this agent hasn't committed" from "this
/// project's default branch isn't checked out locally". Both surface as git's one `ambiguous
/// argument` message, and the first is a claim about the AGENT while the second is a claim about the
/// REPO; reporting the second as the first tells the human an agent did no work while its branch
/// sits there with commits on it (roborev 55193).
/// The ref prelude every diff command runs. One helper so the three call sites cannot drift —
/// `diff_commits` was missing it while the TS classifier's fallback regex was simultaneously
/// removed, so a branchless agent's `list_commits` regressed from the supported `no-branch` state to
/// a raw `fatal: ambiguous argument` reaching the concierge (roborev 55201).
fn require_refs(cwd: &str, base: &str, head: &str) -> Result<(), String> {
    // PROBE THE REPO FIRST. `rev-parse --verify --quiet` exits non-zero for a ref that is absent AND
    // for a repo that cannot be read at all — a moved project root, a deleted checkout, git missing
    // from PATH. Treating the second as the first makes `list_commits` answer "that agent hasn't
    // committed anything" about an agent whose branch and commits are sitting right there, which is
    // the confident false claim this helper's own doc says it exists to prevent (roborev 55208).
    // A failure here is returned RAW so it classifies as `git-failed`.
    git(cwd, &["rev-parse", "--git-dir"])?;
    match missing_ref(cwd, base, head) {
        Some("missing-head") => Err(format!("missing-head: {head}")),
        Some(which) => Err(format!("{which}: {base}")),
        None => Ok(()),
    }
}

fn missing_ref(cwd: &str, base: &str, head: &str) -> Option<&'static str> {
    let resolves = |r: &str| git(cwd, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]).is_ok();
    if !resolves(head) {
        return Some("missing-head");
    }
    if !resolves(base) {
        return Some("missing-base");
    }
    None
}

fn parse_numstat(line: &str) -> Option<DiffFile> {
    let mut parts = line.splitn(3, '\t');
    let a = parts.next()?;
    let r = parts.next()?;
    let path = parts.next()?.to_string();
    // git prints "-\t-\tpath" for a binary file.
    let binary = a == "-" || r == "-";
    Some(DiffFile {
        path,
        added: a.parse::<u32>().ok(),
        removed: r.parse::<u32>().ok(),
        binary,
    })
}

/// The files an agent's branch changed against its base, with per-file line counts.
#[tauri::command]
pub async fn diff_files(
    cwd: String,
    base: String,
    head: String,
    limit: Option<usize>,
) -> Result<DiffSummary, String> {
    validate_ref(&base)?;
    validate_ref(&head)?;
    let cap = limit.unwrap_or(DIFF_MAX_FILES).min(DIFF_MAX_FILES).max(1);
    tauri::async_runtime::spawn_blocking(move || {
        require_refs(&cwd, &base, &head)?;
        let range = diff_range(&base, &head);
        // `--no-renames` so a rename reports as one add + one delete rather than a path pair the
        // parser would mis-split on the tab-separated form.
        let out = git_raw_paths(&cwd, &["diff", "--numstat", "--no-renames", &range, "--"])?;
        let all: Vec<DiffFile> = out.lines().filter_map(parse_numstat).collect();
        let total_files = all.len();
        let truncated = total_files > cap;
        Ok(DiffSummary {
            base,
            head,
            files: all.into_iter().take(cap).collect(),
            total_files,
            truncated,
        })
    })
    .await
    .map_err(|e| format!("diff_files task failed: {e}"))?
}

/// One file's patch text, capped by lines and chars.
#[tauri::command]
pub async fn diff_file_text(
    cwd: String,
    base: String,
    head: String,
    path: String,
    max_lines: Option<usize>,
) -> Result<DiffText, String> {
    validate_ref(&base)?;
    validate_ref(&head)?;
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    // A path is passed after `--`, so git treats it as a pathspec and never as an option — but a
    // leading '-' would still be ambiguous to anything that re-parses the string later, and a
    // control char has no business in a repo path.
    if path.starts_with('-') || path.bytes().any(|c| c.is_ascii_control()) {
        return Err(format!("refusing suspicious path: {path:?}"));
    }
    let cap = max_lines.unwrap_or(DIFF_MAX_LINES).min(DIFF_MAX_LINES).max(1);
    tauri::async_runtime::spawn_blocking(move || {
        require_refs(&cwd, &base, &head)?;
        let range = diff_range(&base, &head);
        let out = git_raw_paths(&cwd, &["diff", "--no-renames", &range, "--", &path])?;
        let lines: Vec<&str> = out.lines().collect();
        let total = lines.len();

        let (text, emitted) = clip_patch(&lines, cap);
        let (truncated, omitted_lines) = clip_report(total, emitted);
        Ok(DiffText {
            path,
            text,
            truncated,
            omitted_lines,
            omitted_bytes: omitted_bytes(&lines, emitted),
        })
    })
    .await
    .map_err(|e| format!("diff_file_text task failed: {e}"))?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitRow {
    pub sha: String,
    pub subject: String,
    pub author: String,
    /// Unix seconds — the caller formats. A pre-formatted date here would bake in a locale the
    /// caller may not want.
    pub timestamp: i64,
}

/// The commits on `head` that are not on `base` — the agent's own work, newest first.
#[tauri::command]
pub async fn diff_commits(
    cwd: String,
    base: String,
    head: String,
    limit: Option<usize>,
) -> Result<Vec<CommitRow>, String> {
    validate_ref(&base)?;
    validate_ref(&head)?;
    let cap = limit.unwrap_or(50).min(200).max(1);
    tauri::async_runtime::spawn_blocking(move || {
        require_refs(&cwd, &base, &head)?;
        let range = format!("{base}..{head}");
        // %x1f (unit separator) rather than a printable delimiter: a commit subject can contain
        // any printable char, and splitting on one that appears in the subject silently corrupts
        // every later field.
        let out = git(
            &cwd,
            &[
                "log",
                &format!("-{cap}"),
                "--format=%H%x1f%s%x1f%an%x1f%at",
                &range,
            ],
        )?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let mut f = l.split('\u{1f}');
                Some(CommitRow {
                    sha: f.next()?.to_string(),
                    subject: f.next()?.to_string(),
                    author: f.next()?.to_string(),
                    timestamp: f.next()?.parse().ok()?,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| format!("diff_commits task failed: {e}"))?
}

#[cfg(test)]
mod diff_tests {
    use super::*;

    // A binary file is "-\t-\tpath" in numstat. Reporting 0/0 would read as "nothing changed" when
    // the truth is "not countable", and a caller relaying that would tell the human a changed
    // binary was untouched.
    #[test]
    fn binary_files_report_none_not_zero() {
        let f = parse_numstat("-\t-\tassets/icon.png").expect("parses");
        assert_eq!(f.path, "assets/icon.png");
        assert!(f.binary);
        assert_eq!(f.added, None);
        assert_eq!(f.removed, None);
    }

    #[test]
    fn text_files_carry_their_counts() {
        let f = parse_numstat("12\t3\tsrc/pty.rs").expect("parses");
        assert_eq!((f.added, f.removed, f.binary), (Some(12), Some(3), false));
    }

    // A path may contain a tab-free but space-bearing name, and splitn(3) must hand the WHOLE
    // remainder back as the path rather than splitting it further.
    #[test]
    fn paths_with_spaces_survive() {
        let f = parse_numstat("1\t0\tdocs/My Notes.md").expect("parses");
        assert_eq!(f.path, "docs/My Notes.md");
    }

    #[test]
    fn junk_lines_are_skipped_rather_than_panicking() {
        assert!(parse_numstat("").is_none());
        assert!(parse_numstat("not numstat").is_none());
    }

    // THREE-dot, not two. Two-dot attributes everything that landed on the base since the agent
    // branched to that agent, and a stale branch is the normal state here — so the wrong operator
    // makes this tool actively misleading rather than merely incomplete.
    // THE ACCOUNTING MUST MATCH THE TEXT. Asserting the REPORT directly, against ground truth —
    // the previous version compared `400 - emitted` to `400 - text.lines().count()`, which reduces
    // to `emitted == text.lines().count()`: a tautology of clip_patch's own loop that would pass
    // against any implementation, including one reporting omitted_lines wrongly (roborev 55201).
    #[test]
    fn a_char_bound_clip_reports_a_real_count() {
        // 400 lines of 100 chars: the CHAR cap binds long before the 400-line cap.
        let owned: Vec<String> = (0..400).map(|i| format!("+{:0>99}", i)).collect();
        let lines: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
        let (text, emitted) = clip_patch(&lines, 400);

        assert!(text.len() <= DIFF_MAX_CHARS);
        assert!(400 - emitted > 300, "the char cap must drop most of the patch");
        // The report is non-None and EQUAL to the real shortfall — the old code said None here.
        assert_eq!(clip_report(400, emitted), (true, Some(400 - emitted)));
        // …and the last line delivered is WHOLE, not a mid-line fragment.
        assert_eq!(text.lines().last().unwrap().len(), 100);
    }

    // THE REALISTIC SHAPE: a real `git diff` starts with header lines, so the giant line is never
    // line 0 — a test built from a bare giant line does not exercise what actually happens
    // (roborev 55208).
    #[test]
    fn a_real_patch_whose_body_is_one_giant_line_stays_bounded_and_honest() {
        let giant = format!("+{}", "x".repeat(200_000));
        let owned = vec![
            "diff --git a/bundle.min.js b/bundle.min.js".to_string(),
            "index 1234567..89abcde 100644".to_string(),
            "--- a/bundle.min.js".to_string(),
            "+++ b/bundle.min.js".to_string(),
            giant,
        ];
        let lines: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
        let (text, emitted) = clip_patch(&lines, 400);

        assert!(text.len() <= DIFF_MAX_CHARS, "got {} chars", text.len());
        assert_eq!(emitted, 4, "the four header lines fit; the body does not");
        assert_eq!(clip_report(5, emitted), (true, Some(1)));
        // "1 line omitted" is true and useless about 200 KB — the byte count is what makes it usable.
        let bytes = omitted_bytes(&lines, emitted).expect("some bytes were dropped");
        assert!(bytes > 200_000, "got {bytes}");
    }

    // A SINGLE ENORMOUS LINE. Exempting the first line from the char budget let a minified bundle,
    // a source map or an inlined data URI through whole — hundreds of KB reported as a COMPLETE,
    // untruncated patch, blowing the stated cap by orders of magnitude (roborev 55201).
    #[test]
    fn one_giant_line_is_still_bounded_and_reported_as_truncated() {
        let giant = format!("+{}", "x".repeat(100_000));
        let (text, emitted) = clip_patch(&[giant.as_str()], 400);

        assert!(text.len() <= DIFF_MAX_CHARS, "got {} chars", text.len());
        // No line was delivered IN FULL, so the report must not claim one was.
        assert_eq!(emitted, 0);
        assert_eq!(clip_report(1, emitted), (true, Some(1)));
        assert!(omitted_bytes(&[giant.as_str()], emitted).unwrap() > 100_000);
    }

    // …and the prefix is cut on a char boundary: a byte slice through UTF-8 panics, and diffs are
    // full of it.
    #[test]
    fn a_giant_multibyte_line_does_not_panic() {
        let giant = format!("+{}", "é".repeat(100_000));
        let (text, _) = clip_patch(&[giant.as_str()], 400);
        assert!(text.len() <= DIFF_MAX_CHARS);
        assert!(text.chars().all(|c| c == '+' || c == 'é'));
    }

    #[test]
    fn a_line_bound_clip_reports_the_line_shortfall() {
        let owned: Vec<String> = (0..50).map(|i| format!("+{i}")).collect();
        let lines: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
        let (text, emitted) = clip_patch(&lines, 10);

        assert_eq!(emitted, 10);
        assert_eq!(text.lines().count(), 10);
        assert_eq!(clip_report(50, emitted), (true, Some(40)));
    }

    #[test]
    fn a_patch_inside_both_budgets_is_untruncated() {
        let lines = vec!["+a", "-b", " c"];
        let (text, emitted) = clip_patch(&lines, 400);
        assert_eq!((emitted, text.as_str()), (3, "+a\n-b\n c"));
        // The untruncated case must report NO amount, not Some(0).
        assert_eq!(clip_report(3, emitted), (false, None));
        // Nothing dropped means NO byte count either — not Some(0).
        assert_eq!(omitted_bytes(&lines, emitted), None);
    }

    // THE REPO PROBE. Deleting the `rev-parse --git-dir` line left every other test in this module
    // green while restoring the confident false claim it exists to prevent — "that agent hasn't
    // committed anything" about an agent whose branch is sitting right there (roborev 55218). These
    // pin both arms of the branch.
    #[test]
    fn a_directory_that_is_not_a_repo_is_a_git_failure_not_a_missing_branch() {
        let dir = tempfile::tempdir().expect("temp dir");
        let err = require_refs(&dir.path().to_string_lossy(), "main", "sparkle/agent-1")
            .expect_err("a non-repo must not resolve");

        // The RAW git error, so the TS side classifies it `git-failed` — NOT either sentinel, which
        // would make the concierge report the agent as having done no work.
        assert!(!err.starts_with("missing-head"), "got {err}");
        assert!(!err.starts_with("missing-base"), "got {err}");
        assert!(err.contains("not a git repository"), "got {err}");
    }

    #[test]
    fn a_real_repo_missing_the_agent_branch_reports_missing_head() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cwd = dir.path().to_string_lossy().to_string();
        git(&cwd, &["init", "-q", "-b", "main"]).expect("init");
        git(&cwd, &["config", "user.email", "t@example.com"]).expect("email");
        git(&cwd, &["config", "user.name", "T"]).expect("name");
        git(&cwd, &["commit", "-q", "--allow-empty", "-m", "root"]).expect("commit");

        let err = require_refs(&cwd, "main", "sparkle/agent-1").expect_err("no such branch");
        assert_eq!(err, "missing-head: sparkle/agent-1");

        // …and the base arm, which must name the ref that failed rather than the agent's.
        let err = require_refs(&cwd, "nope-branch", "main").expect_err("no such base");
        assert_eq!(err, "missing-base: nope-branch");

        // Both present resolves cleanly.
        assert!(require_refs(&cwd, "main", "main").is_ok());
    }

    #[test]
    fn the_range_is_merge_base_relative() {
        assert_eq!(diff_range("main", "sparkle/agent-1"), "main...sparkle/agent-1");
    }

    // The refs reach a subprocess, so an option-shaped one must be refused rather than passed
    // through — the same guard the rest of this module applies to every ref it takes.
    #[test]
    fn option_shaped_refs_are_refused() {
        assert!(validate_ref("--upload-pack=touch /tmp/pwn").is_err());
        assert!(validate_ref("-x").is_err());
        assert!(validate_ref("main").is_ok());
    }
}

//! Who is holding a reserved dev port — a **report-only** probe, and the teardown interlock that
//! keeps the Rust removal path from silently skipping the preview stop (bead `sparkle-r28em`).
//!
//! # The failure this exists for
//!
//! Sparkle's own dev server is pinned: `tauri.conf.json` names `devUrl = http://localhost:1420` and
//! `vite.config.ts` sets `port: 1420, strictPort: true`. **`strictPort` means there is no
//! fallback** — vite does not walk to 1421, it exits. So a single process left listening on 1420
//! breaks every later `tauri dev` / `pnpm dev` on the machine, with a bare "port is already in use"
//! that names neither the process nor where it came from.
//!
//! The way that process gets left behind is worktree teardown. `worktree::remove_worktree_at`
//! renames an agent's checkout into `worktree-trash` and deletes it on a background thread; a dev
//! server whose cwd was inside that checkout keeps running, now with its cwd pointing at a renamed
//! (or unlinked) inode and with nothing left that would ever stop it. `preview::sweep_orphans`
//! reclaims only servers in the preview registry, so anything a human or an agent started in a PTY
//! (`pnpm dev`, `tauri dev`) is invisible to it — permanently.
//!
//! # Two halves, and the line between them
//!
//! * [`build_report`] — **REPORT ONLY.** It kills nothing, signals nothing and writes nothing. Its
//!   entire job is to turn a bare port-in-use into a sentence naming the pid, the command and the
//!   working directory, and to say out loud when that working directory is inside `worktree-trash`.
//!   Attribution by cwd is good enough to *name* a process in a message; it is deliberately **not**
//!   used as a basis for sending a signal to anything Sparkle did not start.
//! * [`stop_preview_before_teardown`] — the kill, and it reuses the ONE proven path
//!   ([`crate::preview::preview_stop_for_agent`] → `stop_one` → `proc::kill_process_group`) rather
//!   than adding a second killer. That path signals only a `Child` Sparkle itself spawned with
//!   `process_group(0)`, after `exited_without_reaping` has established it has not exited, so a
//!   recycled pid can never be signalled. Nothing here ever calls `kill` on a pid it merely read
//!   out of `lsof`.
//!
//! # Fail closed, stay silent
//!
//! Every "we could not look" answer is [`Verdict::Undetermined`], never a guess. `lsof` missing,
//! `lsof` timing out, output that does not parse, a cwd that cannot be read — all of them report
//! *could not determine* and name nobody. A probe that accuses an innocent process is worse than a
//! probe that says nothing, because the message is an instruction a human will follow.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

/// Absolute path for the same reason [`crate::preview`] uses one: `lsof` lives in `/usr/sbin`,
/// which a Finder-launched app's PATH may not carry, and this must not resolve to something a repo
/// put earlier on PATH.
const LSOF: &str = "/usr/sbin/lsof";

/// `lsof` has no timeout flag of its own and can block indefinitely on a wedged network mount, so
/// it never runs as a bare `Command::output()`. Matches `preview::LSOF_TIMEOUT`; an unbounded probe
/// in a teardown path would be its own outage.
const LSOF_TIMEOUT: Duration = Duration::from_secs(5);

/// `ps` is fast, but it is still a subprocess in a teardown path. Matches `preview::PsIdentity`.
const PS_TIMEOUT: Duration = Duration::from_secs(5);

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SHAPE OF AN ANSWER
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// What became of the directory a port-holding process is sitting in.
///
/// This is the whole point of the report: `Evacuated` is the case the bead is about, and it is the
/// one a human can act on without hesitating, because a checkout that has been renamed into
/// `worktree-trash` belongs to an agent that no longer exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CwdState {
    /// The cwd is inside Sparkle's `worktree-trash` — the agent checkout this process was started
    /// in has been torn down, so nothing will ever stop it.
    Evacuated,
    /// The cwd names a path that is not on disk any more. Either a teardown deleted the parked copy
    /// out from under it, or a checkout was removed some other way.
    Deleted,
    /// The cwd is a directory that still exists. This is somebody's live dev server, not an orphan.
    Live,
    /// We could not read a cwd for this pid. Reported as-is; never filled in with a guess.
    Unknown,
}

/// One process listening on the port, as far as we could establish it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortHolder {
    pub pid: u32,
    /// The listening address exactly as `lsof` printed it (`*:1420`, `127.0.0.1:1420`). Kept raw
    /// for the same reason [`crate::preview::Listener::addr`] is: it is what a message has to name
    /// back, and `*:1420` means something to a reader that a parsed struct does not.
    pub addr: String,
    /// `ps -o command=`. `None` when `ps` could not be read — an empty string would read as "a
    /// process with no command", which is a claim we have not earned.
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub cwd_state: CwdState,
}

/// Whether we found a holder, found none, or could not look. The three are deliberately distinct:
/// collapsing `Undetermined` into `Free` is what turns a broken probe into a false all-clear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    /// We looked, and nothing is listening on the port.
    Free,
    /// We looked, and something is.
    Held,
    /// We could not look, or what came back did not parse. Names nobody.
    Undetermined,
}

/// The full answer, and the sentence that goes with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPortReport {
    pub port: u16,
    pub verdict: Verdict,
    pub holders: Vec<PortHolder>,
    /// The sentence to show a human. Empty **only** when the port is free AND the port broker has
    /// no record on it — there is nothing to say about a port nobody is holding, and an empty
    /// string is what call sites test to decide whether to say anything at all.
    pub message: String,
    /// What Sparkle's OWN port broker recorded about this port, if anything (bead `.5`).
    ///
    /// `null` for every port the registry has never heard of, which is the overwhelming majority
    /// and includes every process a human started by hand. See [`RegistryClaim`] for why naming an
    /// agent from a record does not breach this module's accuse-nobody rule.
    ///
    /// `Option`, so it crosses the wire as an explicit `null` rather than an absent key — the TS
    /// side declares it `RegistryClaim | null`.
    pub registry: Option<RegistryClaim>,
}

impl DevPortReport {
    /// Is there something here worth putting in front of a person?
    ///
    /// True for `Held` and for `Undetermined`-with-a-reason. False for `Free`, which is the
    /// overwhelmingly common outcome and must stay silent.
    pub fn worth_reporting(&self) -> bool {
        !self.message.is_empty()
    }
}

/// What Sparkle's own port broker knows about this port — a name that came from a RECORD SOMEBODY
/// WROTE, not from an inference about a process (bead `.5`).
///
/// This is the one kind of attribution that does not strain this module's accuse-nobody rule, and
/// the distinction is worth stating because it is the whole reason it is allowed here. Everything
/// else in this file infers: `lsof` says a pid is on a port, `ps` says what its command line is,
/// the cwd says which checkout it came from — every step a guess about somebody else's process,
/// which is why none of them may justify a signal. A broker record is different in kind. An agent
/// WROTE it, naming itself, before it started. Repeating what it said back is not an accusation.
///
/// The discipline is unchanged for everything else: a port with no record produces `None` and the
/// report says exactly what it said before. Silence about a stranger is the default, and this
/// speaks only where somebody volunteered their name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryClaim {
    /// The agent that recorded the claim.
    pub agent_id: String,
    pub pid: u32,
    /// `lease` for an allocated port, `gate-lock` for a pinned one. Different remedies: a lease
    /// moves, a pinned port cannot, so a reader has to be told which they are looking at.
    pub kind: ClaimKind,
    /// The gate lock's name, for a `gate-lock` claim. `null` for a lease.
    pub name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaimKind {
    Lease,
    GateLock,
}

/// Ask the port broker's registry who, if anyone, recorded a claim on `port`.
///
/// A LEASE WINS over a gate lock when both exist, which they should not: a lease is a claim on
/// exactly this port, while a gate lock named `port-<n>` is a claim on the right to USE it. If the
/// registry somehow holds both, the narrower fact is the more useful one to print.
pub fn registry_claim(registry_root: &Path, port: u16) -> Option<RegistryClaim> {
    if let Some(lease) = crate::port_broker::lease_on(registry_root, port) {
        return Some(RegistryClaim {
            agent_id: lease.agent_id,
            pid: lease.pid,
            kind: ClaimKind::Lease,
            name: None,
        });
    }
    let gate_name = crate::port_broker::pinned_gate_name(port);
    let gate = crate::port_broker::gate_lock_on(registry_root, &gate_name)?;
    Some(RegistryClaim {
        agent_id: gate.agent_id,
        pid: gate.pid,
        kind: ClaimKind::GateLock,
        name: Some(gate.name),
    })
}

/// Fold a registry claim into a report. PURE, so the sentence it appends is testable without a
/// registry on disk.
///
/// Appends to `message` for EVERY verdict, `Free` and `Undetermined` included, and the two
/// non-`Held` cases are the interesting ones:
///   * `Undetermined` — we could not see who is on the port, and the registry can still name the
///     agent that reserved it. That is the case a reader is most stuck on, and the one where a
///     volunteered name helps most.
///   * `Free` — a record with nothing listening is a LEAK, not a collision: an agent took the port
///     and died without releasing it. Saying so is how the lease gets cleaned up before it expires.
pub fn with_registry_claim(mut report: DevPortReport, claim: Option<RegistryClaim>) -> DevPortReport {
    let Some(claim) = claim else { return report };
    let port = report.port;
    let sentence = match (report.verdict, claim.kind) {
        (Verdict::Free, _) => format!(
            "Sparkle's port broker still has a record on port {port} for agent {} (pid {}), but \
             nothing is listening there — that is a LEAK, not a collision: the agent went away \
             without releasing it. It clears itself when its TTL runs out, or immediately with \
             `port_broker_release`.",
            claim.agent_id, claim.pid
        ),
        (_, ClaimKind::Lease) => format!(
            "Sparkle's port broker records port {port} as LEASED by agent {} (pid {}). A lease can \
             move: stop that agent's preview, or let it finish, and the port comes back on its own.",
            claim.agent_id, claim.pid
        ),
        (_, ClaimKind::GateLock) => format!(
            "Sparkle's port broker records port {port} as GATE-LOCKED by agent {} (pid {}) under \
             `{}`. A gate lock is for a PINNED port, so there is no second port to move to — wait \
             for that agent, or release the lock with `gate_lock_release`.",
            claim.agent_id,
            claim.pid,
            claim.name.as_deref().unwrap_or("(unnamed)")
        ),
    };
    if report.message.is_empty() {
        report.message = sentence;
    } else {
        report.message.push(' ');
        report.message.push_str(&sentence);
    }
    report.registry = Some(claim);
    report
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SEAM
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// "Ask the machine who is on this port", as three raw-text reads.
///
/// Mirrors [`crate::preview::ListenTable`], including the meaning of `None`: **`None` is WE COULD
/// NOT LOOK** (the binary is missing, the run timed out), which is deliberately distinct from
/// `Some("")`, meaning we looked and nothing came back. The first must never be read as "the port
/// is free", or a broken `lsof` would report every collision as an all-clear.
pub trait PortProbe {
    /// stdout of `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pn`.
    fn listeners_on(&self, port: u16) -> Option<String>;
    /// stdout of `lsof -nP -a -d cwd -p <pid> -F n`.
    fn cwd_of(&self, pid: u32) -> Option<String>;
    /// stdout of `ps -o pid=,command= -p <pid>`.
    fn command_of(&self, pid: u32) -> Option<String>;
}

/// The real probe. Every call is bounded; every failure collapses to `None`.
pub struct SystemProbe;

impl PortProbe for SystemProbe {
    #[cfg(unix)]
    fn listeners_on(&self, port: u16) -> Option<String> {
        let mut cmd = Command::new(LSOF);
        // `-a` ANDs the selections, the same reason `preview::LsofListenTable` passes it: without
        // it lsof ORs them and hands back every listener on the machine.
        cmd.args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-a", "-F", "pn"]);
        run_capture(cmd, LSOF_TIMEOUT)
    }

    #[cfg(unix)]
    fn cwd_of(&self, pid: u32) -> Option<String> {
        let mut cmd = Command::new(LSOF);
        cmd.args(["-nP", "-a", "-d", "cwd", "-p", &pid.to_string(), "-F", "n"]);
        run_capture(cmd, LSOF_TIMEOUT)
    }

    #[cfg(unix)]
    fn command_of(&self, pid: u32) -> Option<String> {
        // `/bin/ps`, absolute, exactly as `preview::PsIdentity` resolves it. `command=` MUST be
        // last in the format string for the same reason `lstart=` must be there: it contains
        // spaces, so nothing after it would be parseable.
        let mut cmd = Command::new("/bin/ps");
        cmd.args(["-o", "pid=,command=", "-p", &pid.to_string()]);
        run_capture(cmd, PS_TIMEOUT)
    }

    #[cfg(not(unix))]
    fn listeners_on(&self, _port: u16) -> Option<String> {
        None
    }
    #[cfg(not(unix))]
    fn cwd_of(&self, _pid: u32) -> Option<String> {
        None
    }
    #[cfg(not(unix))]
    fn command_of(&self, _pid: u32) -> Option<String> {
        None
    }
}

/// Run a bounded capture and hand back stdout, or `None` for anything that went wrong.
///
/// **The exit status is deliberately ignored**, for the reason
/// [`crate::preview::listeners_from_lsof`] documents at length and measured twice: `lsof` exits
/// non-zero when *any* pid in its selection has since gone away, while still printing a perfectly
/// good listing for the ones that remain. Gating on the status would discard good output. What we
/// do NOT ignore is a failure to spawn or a timeout — those come back as `Err` and become `None`,
/// which is `Undetermined`, which names nobody.
#[cfg(unix)]
fn run_capture(cmd: Command, timeout: Duration) -> Option<String> {
    let captured = crate::worktree::output_with_timeout_lenient(cmd, timeout).ok()?;
    Some(String::from_utf8_lossy(&captured.output.stdout).into_owned())
}

/// A probe backed by captured fixture text, for tests. Keyed by pid so a test can give two holders
/// different answers — including "this one's cwd could not be read".
#[cfg(test)]
pub struct FixedProbe {
    pub listeners: Option<String>,
    pub cwds: std::collections::HashMap<u32, Option<String>>,
    pub commands: std::collections::HashMap<u32, Option<String>>,
}

#[cfg(test)]
impl PortProbe for FixedProbe {
    fn listeners_on(&self, _port: u16) -> Option<String> {
        self.listeners.clone()
    }
    fn cwd_of(&self, pid: u32) -> Option<String> {
        self.cwds.get(&pid).cloned().flatten()
    }
    fn command_of(&self, pid: u32) -> Option<String> {
        self.commands.get(&pid).cloned().flatten()
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  PARSING + ATTRIBUTION  (pure, and where the tests live)
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Pull the pid → listening-address pairs out of `lsof -F pn` output.
///
/// Reuses [`crate::preview::parse_lsof_fields`] rather than writing a second parser: the field
/// format is identical, its handling of a malformed `p` line (clear the pid rather than attribute
/// the sockets that follow to the previous process) is exactly the fail-closed behaviour this
/// module needs, and it is already covered by that module's tests.
pub fn holders_from_lsof(stdout: &str) -> Vec<(u32, String)> {
    crate::preview::parse_lsof_fields(stdout)
        .into_iter()
        .map(|l| (l.pid, l.addr))
        .collect()
}

/// Pull a cwd out of `lsof -d cwd -F n` output.
///
/// Same field format, same parser. The `n` line for an `fcwd` descriptor is a plain path rather
/// than an address, which is why this is a separate named function: the reuse is real, but the
/// *meaning* of the field differs and a reader should not have to work that out.
///
/// Returns `None` for empty or unparseable output — the caller reports that as
/// [`CwdState::Unknown`], never as "the cwd is /".
pub fn cwd_from_lsof(pid: u32, stdout: &str) -> Option<String> {
    crate::preview::parse_lsof_fields(stdout)
        .into_iter()
        .find(|l| l.pid == pid && l.addr.starts_with('/'))
        .map(|l| l.addr)
}

/// Pull the command out of `ps -o pid=,command= -p <pid>`.
///
/// The pid is re-checked against the line rather than trusted: `ps` given a pid that has exited
/// prints a header-less blank, and on some platforms prints nothing at all, so a line whose first
/// field is not the pid we asked about is dropped rather than attributed.
pub fn command_from_ps(pid: u32, stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let mut fields = line.split_whitespace();
        let Some(first) = fields.next() else { continue };
        if first.parse::<u32>().ok() != Some(pid) {
            continue;
        }
        let rest: Vec<&str> = fields.collect();
        if rest.is_empty() {
            return None;
        }
        return Some(rest.join(" "));
    }
    None
}

/// Decide what became of a holder's working directory.
///
/// `on_disk` is passed in rather than read here so the whole classification is pure and testable
/// without touching the filesystem.
///
/// Two ways a path counts as evacuated, and the second is not redundant. The prefix test is the
/// real one. The component test covers the case where `lsof` prints a path that has been resolved
/// through a symlink (`/private/var/…` for `/var/…` on macOS) so the prefix no longer matches
/// textually: `worktree-trash` is a name Sparkle chose, and a path carrying it as a whole component
/// is ours. It is safe to be generous here *only* because this is report-only — the worst outcome
/// of a wrong label is a wrong sentence, and nothing downstream signals anything based on it.
pub fn classify_cwd(cwd: Option<&str>, trash: &Path, on_disk: bool) -> CwdState {
    let Some(cwd) = cwd else { return CwdState::Unknown };
    let path = Path::new(cwd);
    let trash_name = trash.file_name();
    let in_trash = path.starts_with(trash)
        || (trash_name.is_some() && path.components().any(|c| Some(c.as_os_str()) == trash_name));
    if in_trash {
        return CwdState::Evacuated;
    }
    if on_disk {
        CwdState::Live
    } else {
        CwdState::Deleted
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE REPORT
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Why nobody is being named. Kept as one string per cause so the message says which kind of
/// not-knowing this is — "lsof did not answer" and "lsof answered something I could not read" send
/// a reader to different places.
const COULD_NOT_LOOK: &str = "could not run /usr/sbin/lsof (it is missing, or it did not answer \
                              within 5s)";
const COULD_NOT_PARSE: &str = "/usr/sbin/lsof answered, but nothing in its output parsed as a \
                               listening socket";

/// Build the whole answer. **Report only** — reads three subprocesses and a directory existence
/// bit, writes nothing, signals nothing.
///
/// `on_disk` is the seam for "does this path exist"; the real caller passes `Path::is_dir`.
pub fn build_report(
    port: u16,
    probe: &dyn PortProbe,
    trash: &Path,
    on_disk: &dyn Fn(&Path) -> bool,
) -> DevPortReport {
    let Some(stdout) = probe.listeners_on(port) else {
        return undetermined(port, COULD_NOT_LOOK);
    };
    let pairs = holders_from_lsof(&stdout);
    if pairs.is_empty() {
        // Distinguish "lsof printed nothing" (nobody is listening — a real, common answer) from
        // "lsof printed something we could not read" (we do not know). Collapsing the second into
        // the first is exactly how a broken probe becomes a false all-clear.
        return if stdout.trim().is_empty() {
            DevPortReport {
                port,
                verdict: Verdict::Free,
                holders: Vec::new(),
                message: String::new(),
                registry: None,
            }
        } else {
            undetermined(port, COULD_NOT_PARSE)
        };
    }

    // Dedupe by pid: a server bound on both `127.0.0.1` and `[::1]` is ONE process and must be
    // named once. First address wins, which is the order lsof printed them in.
    let mut seen: BTreeSet<u32> = BTreeSet::new();
    let mut holders: Vec<PortHolder> = Vec::new();
    for (pid, addr) in pairs {
        if !seen.insert(pid) {
            continue;
        }
        let cwd = probe.cwd_of(pid).as_deref().and_then(|t| cwd_from_lsof(pid, t));
        let command = probe.command_of(pid).as_deref().and_then(|t| command_from_ps(pid, t));
        let cwd_state = classify_cwd(cwd.as_deref(), trash, cwd.as_deref().is_some_and(|c| on_disk(Path::new(c))));
        holders.push(PortHolder { pid, addr, command, cwd, cwd_state });
    }

    let message = held_message(port, &holders);
    DevPortReport { port, verdict: Verdict::Held, holders, message, registry: None }
}

fn undetermined(port: u16, why: &str) -> DevPortReport {
    DevPortReport {
        port,
        verdict: Verdict::Undetermined,
        holders: Vec::new(),
        registry: None,
        message: format!(
            "could not determine who is listening on port {port}: {why}. Nothing is being named as \
             the holder — a wrong name here would send you after an innocent process. Check by \
             hand with `lsof -nP -iTCP:{port} -sTCP:LISTEN`."
        ),
    }
}

/// The sentence a human meets.
///
/// Follows the `Decline::message` discipline in `preview.rs`: name the problem, name the specific
/// pid and path, name the remedy — and make the remedy match the case, because a remedy is an
/// instruction someone will follow. `kill <pid>` is offered ONLY for a holder whose checkout has
/// been evacuated or deleted, where the process is definitionally an orphan of a worktree that no
/// longer exists. A holder sitting in a live directory is somebody's running dev server, so it gets
/// told where to look instead.
pub fn held_message(port: u16, holders: &[PortHolder]) -> String {
    if holders.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for h in holders {
        if !out.is_empty() {
            out.push(' ');
        }
        let cmd = match h.command.as_deref() {
            Some(c) => format!(" (`{c}`)"),
            None => " (its command could not be read)".to_string(),
        };
        out.push_str(&format!("port {port} is held by pid {}{cmd}, listening on {}.", h.pid, h.addr));
        match (h.cwd_state, h.cwd.as_deref()) {
            (CwdState::Evacuated, Some(cwd)) => out.push_str(&format!(
                " Its working directory `{cwd}` is inside Sparkle's worktree-trash: the agent \
                 checkout it was started in has been torn down, so nothing will ever stop it. Run \
                 `kill {}` to free the port.",
                h.pid
            )),
            (CwdState::Deleted, Some(cwd)) => out.push_str(&format!(
                " Its working directory `{cwd}` no longer exists on disk, so it is an orphan of a \
                 removed checkout. Run `kill {}` to free the port.",
                h.pid
            )),
            (CwdState::Live, Some(cwd)) => out.push_str(&format!(
                " Its working directory `{cwd}` still exists, so this is a dev server somebody is \
                 running — stop it where it was started rather than killing it from here."
            )),
            _ => out.push_str(
                " Its working directory could not be determined, so Sparkle cannot say whether it \
                 is an orphan — check it before stopping it.",
            ),
        }
    }
    out.push_str(&format!(
        " Sparkle's dev server is `strictPort` on {port} (tauri.conf.json `devUrl`), so there is no \
         fallback: every later `tauri dev` / `pnpm dev` fails with a bare port-in-use until this is \
         cleared."
    ));
    out
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  WIRING
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// The port a report defaults to: Sparkle's own `devUrl`, and the only entry in
/// [`crate::preview_csp::RESERVED_PORTS`].
///
/// Read from that constant rather than re-typing `1420`, so the two cannot drift. `RESERVED_PORTS`
/// is non-empty by construction (its own module test pins 1420), but the fallback is written out
/// rather than `[0]`-indexed because a panic in a diagnostic path would be absurd.
pub fn default_dev_port() -> u16 {
    crate::preview_csp::RESERVED_PORTS.first().copied().unwrap_or(1420)
}

/// Probe a reserved dev port and hand back the report. The command the frontend calls.
///
/// Report-only by construction — there is no code path from here to a signal.
#[tauri::command]
pub async fn dev_port_preflight(
    app: tauri::AppHandle,
    port: Option<u16>,
    project_root: Option<String>,
) -> Result<DevPortReport, String> {
    let port = port.unwrap_or_else(default_dev_port);
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let trash = crate::worktree::removal_trash_dir(&app_data);
        let report = build_report(port, &SystemProbe, &trash, &|p| p.is_dir());
        // A `project_root` is optional because this command is reachable with no project in hand
        // (the teardown path below has none either). Without one there is no registry to consult
        // and the report is exactly what it always was — the accuse-nobody default, unchanged.
        let claim = project_root
            .as_deref()
            .map(|r| crate::port_broker::registry_root(Path::new(r)))
            .and_then(|root| registry_claim(&root, port));
        Ok(with_registry_claim(report, claim))
    })
    .await
    .map_err(|e| format!("dev_port_preflight task failed: {e}"))?
}

/// Run the report after a teardown and log it, on a DETACHED thread.
///
/// Detached for the same reason [`crate::worktree`]'s parked-checkout delete is: the caller has
/// already finished the removal, nothing downstream depends on this, and three bounded subprocess
/// calls (worst case ~15s) must not be added to a teardown's latency. A diagnostic that slows down
/// the thing it is diagnosing would not survive its first measurement.
///
/// Never returns an error and never panics into the caller — the whole function is best-effort by
/// construction, because a probe that can wedge cleanup is worse than the bug it reports.
pub fn report_after_teardown(app_data: PathBuf) {
    std::thread::spawn(move || {
        let trash = crate::worktree::removal_trash_dir(&app_data);
        let port = default_dev_port();
        let report = build_report(port, &SystemProbe, &trash, &|p| p.is_dir());
        if !report.worth_reporting() {
            return;
        }
        match report.verdict {
            Verdict::Held => {
                tracing::warn!(port, holders = report.holders.len(), "{}", report.message)
            }
            // Undetermined is INFO, not WARN. "we could not look" is not evidence of a problem, and
            // logging it at warn on every teardown of a machine without lsof would be noise that
            // trains a reader to skip the line that matters.
            _ => tracing::info!(port, "{}", report.message),
        }
    });
}

/// Reach the SAME preview stop the frontend interlock uses, from the Rust teardown path.
///
/// `services/worktree.ts::stopPreviewBeforeTeardown` has always called `preview_stop_for_agent`
/// before removal, but that is frontend-only: anything invoking the `remove_agent_worktree` command
/// directly skipped it silently. This closes that, and it does so by calling the existing command
/// function — **not** by writing a second killer. Everything downstream is unchanged:
/// `stop_one` checks `exited_without_reaping` before signalling and only ever signals a `Child`
/// this process spawned with `process_group(0)`, so a recycled pid cannot be hit and the signal
/// cannot land on Sparkle's own group.
///
/// **Never propagates a failure.** It returns `()`, so there is no error for a caller to bubble up
/// and no way for a stray preview to wedge a teardown — the same guarantee
/// `stopPreviewBeforeTeardown` gives on the TypeScript side, for the same reason: an un-removed
/// worktree is a permanent problem, while a preview that outlived its stop is a leaked process the
/// supervisor's own reaping still covers.
///
/// The `try_state` guard is not decoration: `preview_stop_for_agent` reaches for
/// `app.state::<PreviewManager>()`, which **panics** if the manager was never managed. That cannot
/// happen in the shipped app (it is managed in `lib.rs` setup) but it can in a harness, and a
/// teardown must not be the thing that discovers it.
pub async fn stop_preview_before_teardown(app: &tauri::AppHandle, agent_id: &str) {
    use tauri::Manager;
    if app.try_state::<crate::preview::PreviewManager>().is_none() {
        return;
    }
    match crate::preview::preview_stop_for_agent(app.clone(), agent_id.to_string()).await {
        Ok(o) => {
            tracing::info!(%agent_id, outcome = o.outcome, "preview: stopped from the Rust worktree teardown path")
        }
        Err(e) => {
            tracing::warn!(%agent_id, error = %e, "preview: could not stop before worktree teardown; removing anyway")
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Verbatim `lsof -nP -iTCP:1420 -sTCP:LISTEN -a -F pn` capture shape.
    const LSOF_ONE: &str = "p48213\nf24\nn127.0.0.1:1420\n";
    /// The same process bound twice — one pid, two `n` lines. Must be named ONCE.
    const LSOF_DUAL_BIND: &str = "p48213\nf24\nn127.0.0.1:1420\nf25\nn[::1]:1420\n";
    /// `lsof -nP -a -d cwd -p 48213 -F n` capture shape.
    const LSOF_CWD_TRASH: &str =
        "p48213\nfcwd\nn/Users/x/Library/Application Support/ai.sparkle.desktop/worktree-trash/p-a-p999-1\n";
    const LSOF_CWD_LIVE: &str = "p48213\nfcwd\nn/Users/x/Projects/sparkle\n";
    /// `ps -o pid=,command= -p 48213` capture shape.
    const PS_VITE: &str = " 48213 node /Users/x/repo/node_modules/.bin/vite --port 1420\n";

    fn trash() -> PathBuf {
        PathBuf::from("/Users/x/Library/Application Support/ai.sparkle.desktop/worktree-trash")
    }

    fn probe(
        listeners: Option<&str>,
        cwd: Option<&str>,
        command: Option<&str>,
    ) -> FixedProbe {
        let mut cwds = HashMap::new();
        cwds.insert(48213u32, cwd.map(str::to_string));
        let mut commands = HashMap::new();
        commands.insert(48213u32, command.map(str::to_string));
        FixedProbe { listeners: listeners.map(str::to_string), cwds, commands }
    }

    // ── THE HEADLINE: the diagnostic NAMES the pid and the cwd ───────────────────────────────────

    /// The side effect, not the precondition. It is not enough that a probe ran or that a verdict
    /// came back `Held` — the whole value of this module is the SENTENCE, so the sentence is what
    /// is asserted, by the pid and the path it must contain.
    #[test]
    fn an_evacuated_holder_is_named_by_pid_command_and_trash_path() {
        let r = build_report(
            1420,
            &probe(Some(LSOF_ONE), Some(LSOF_CWD_TRASH), Some(PS_VITE)),
            &trash(),
            &|_| false,
        );
        assert_eq!(r.verdict, Verdict::Held);
        assert_eq!(r.holders.len(), 1);
        assert_eq!(r.holders[0].pid, 48213);
        assert_eq!(r.holders[0].cwd_state, CwdState::Evacuated);

        // `pid 48213`, not a bare `48213`: the identification clause must name it independently of
        // the `kill 48213` remedy below. Asserting the bare number let a mutation that stripped the
        // pid out of the identification clause stay green on the remedy alone.
        assert!(
            r.message.contains("pid 48213"),
            "the identification clause must name the pid: {}",
            r.message
        );
        assert!(
            r.message.contains("worktree-trash/p-a-p999-1"),
            "the cwd must be in the message: {}",
            r.message
        );
        assert!(r.message.contains("vite"), "the command must be in the message: {}", r.message);
        assert!(
            r.message.contains("kill 48213"),
            "an orphan's remedy must name the pid to kill: {}",
            r.message
        );
        assert!(
            r.message.contains("strictPort"),
            "the message must say why there is no fallback: {}",
            r.message
        );
    }

    /// A holder in a LIVE directory is somebody's running server. The message must NOT tell a
    /// reader to kill it — a remedy is an instruction someone will follow, and killing a colleague's
    /// dev server because it happens to hold the port is the failure this distinction prevents.
    #[test]
    fn a_live_checkout_holder_is_named_but_never_told_to_be_killed() {
        let r = build_report(
            1420,
            &probe(Some(LSOF_ONE), Some(LSOF_CWD_LIVE), Some(PS_VITE)),
            &trash(),
            &|_| true,
        );
        assert_eq!(r.holders[0].cwd_state, CwdState::Live);
        assert!(r.message.contains("/Users/x/Projects/sparkle"), "{}", r.message);
        assert!(!r.message.contains("kill 48213"), "must not offer a kill: {}", r.message);
        assert!(r.message.contains("stop it where it was started"), "{}", r.message);
    }

    /// A cwd that parses but is not on disk is an orphan too — the parked copy was already deleted.
    #[test]
    fn a_cwd_that_is_gone_from_disk_reads_as_deleted_not_live() {
        let r = build_report(
            1420,
            &probe(Some(LSOF_ONE), Some(LSOF_CWD_LIVE), Some(PS_VITE)),
            &trash(),
            &|_| false,
        );
        assert_eq!(r.holders[0].cwd_state, CwdState::Deleted);
        assert!(r.message.contains("no longer exists on disk"), "{}", r.message);
        assert!(r.message.contains("kill 48213"), "{}", r.message);
    }

    // ── THE UNSURE PATHS: never a false accusation ───────────────────────────────────────────────

    /// `lsof` missing or timed out. `None` from the probe must NOT read as "the port is free" —
    /// that is the shape that turns a broken diagnostic into a confident all-clear.
    #[test]
    fn a_tool_that_cannot_be_run_reports_could_not_determine_and_names_nobody() {
        let r = build_report(1420, &probe(None, None, None), &trash(), &|_| false);
        assert_eq!(r.verdict, Verdict::Undetermined);
        assert!(r.holders.is_empty(), "nobody may be named: {:?}", r.holders);
        assert!(r.message.contains("could not determine"), "{}", r.message);
        assert!(r.message.starts_with("could not determine who is listening on port 1420"), "{}", r.message);
    }

    /// Output that came back but does not parse is ALSO not-knowing, and must be distinguishable in
    /// the message from "we could not run it at all" — the two send a reader to different places.
    #[test]
    fn unparseable_output_reports_could_not_determine_with_its_own_reason() {
        let r = build_report(
            1420,
            &probe(Some("lsof: WARNING: can't stat() smbfs file system\n???\n"), None, None),
            &trash(),
            &|_| false,
        );
        assert_eq!(r.verdict, Verdict::Undetermined);
        assert!(r.holders.is_empty());
        assert!(r.message.contains("answered, but nothing in its output parsed"), "{}", r.message);
    }

    /// Empty output is a REAL answer: we looked, nobody is there. It must be `Free`, and it must
    /// stay silent — a warning on every teardown of a healthy machine is noise.
    #[test]
    fn empty_output_is_free_and_says_nothing() {
        let r = build_report(1420, &probe(Some(""), None, None), &trash(), &|_| false);
        assert_eq!(r.verdict, Verdict::Free);
        assert_eq!(r.message, "");
        assert!(!r.worth_reporting());
    }

    /// A holder we found but whose cwd we could not read is still named — we know it holds the port,
    /// that much is certain from lsof — but the message must NOT claim it is an orphan, because
    /// that is the part we do not know.
    #[test]
    fn a_holder_with_an_unreadable_cwd_is_named_without_being_accused() {
        let r = build_report(1420, &probe(Some(LSOF_ONE), None, Some(PS_VITE)), &trash(), &|_| false);
        assert_eq!(r.verdict, Verdict::Held);
        assert_eq!(r.holders[0].cwd_state, CwdState::Unknown);
        assert_eq!(r.holders[0].cwd, None);
        assert!(r.message.contains("48213"), "{}", r.message);
        assert!(r.message.contains("could not be determined"), "{}", r.message);
        assert!(!r.message.contains("kill 48213"), "must not offer a kill on a guess: {}", r.message);
        assert!(!r.message.contains("worktree-trash"), "must not claim evacuation: {}", r.message);
    }

    /// `ps` unreadable must not become an empty backtick pair that reads as "a process with no
    /// command".
    #[test]
    fn a_holder_with_an_unreadable_command_says_so_rather_than_printing_nothing() {
        let r = build_report(
            1420,
            &probe(Some(LSOF_ONE), Some(LSOF_CWD_TRASH), None),
            &trash(),
            &|_| false,
        );
        assert_eq!(r.holders[0].command, None);
        assert!(r.message.contains("its command could not be read"), "{}", r.message);
        assert!(!r.message.contains("(``)"), "{}", r.message);
    }

    // ── PARSING + ATTRIBUTION ────────────────────────────────────────────────────────────────────

    /// One process bound on two addresses is ONE holder. Naming it twice would read as two separate
    /// culprits and send a reader looking for a second process that does not exist.
    #[test]
    fn a_dual_bound_process_is_named_once() {
        let r = build_report(
            1420,
            &probe(Some(LSOF_DUAL_BIND), Some(LSOF_CWD_TRASH), Some(PS_VITE)),
            &trash(),
            &|_| false,
        );
        assert_eq!(r.holders.len(), 1);
        assert_eq!(r.holders[0].addr, "127.0.0.1:1420", "the first address lsof printed wins");
        assert_eq!(r.message.matches("pid 48213").count(), 1, "{}", r.message);
    }

    /// `ps` output whose first field is a DIFFERENT pid is dropped, not attributed. `ps` given a
    /// dead pid can print a stray line, and borrowing another process's command line into this
    /// report is precisely the false accusation this module must not make.
    #[test]
    fn a_ps_line_for_another_pid_is_not_attributed() {
        assert_eq!(command_from_ps(48213, " 99999 node other-thing\n"), None);
        assert_eq!(command_from_ps(48213, ""), None);
        // A pid with no command text is None, not Some("").
        assert_eq!(command_from_ps(48213, " 48213 \n"), None);
        assert_eq!(
            command_from_ps(48213, " 48213 node vite --port 1420\n").as_deref(),
            Some("node vite --port 1420")
        );
    }

    /// The cwd read must not pick up a non-path `n` field, and must not attribute another pid's.
    #[test]
    fn cwd_parsing_takes_only_this_pids_absolute_path() {
        assert_eq!(cwd_from_lsof(48213, LSOF_CWD_TRASH).as_deref(), Some(
            "/Users/x/Library/Application Support/ai.sparkle.desktop/worktree-trash/p-a-p999-1"
        ));
        assert_eq!(cwd_from_lsof(48213, "p999\nfcwd\nn/other/place\n"), None);
        assert_eq!(cwd_from_lsof(48213, "p48213\nfcwd\nnnot-a-path\n"), None);
        assert_eq!(cwd_from_lsof(48213, ""), None);
    }

    /// Evacuation is recognised both by prefix and — for a symlink-resolved path that no longer
    /// matches the prefix textually — by the `worktree-trash` component. `/private/var/…` for
    /// `/var/…` on macOS is the case that makes the second test necessary.
    #[test]
    fn a_trash_path_is_recognised_by_prefix_and_by_component() {
        let t = trash();
        assert_eq!(
            classify_cwd(Some("/Users/x/Library/Application Support/ai.sparkle.desktop/worktree-trash/p-a"), &t, false),
            CwdState::Evacuated
        );
        assert_eq!(
            classify_cwd(Some("/private/var/folders/zz/app/worktree-trash/p-a"), &t, true),
            CwdState::Evacuated,
            "a symlink-resolved trash path must still read as evacuated"
        );
        // A directory merely NAMED like it, as a substring rather than a whole component, is not.
        assert_eq!(
            classify_cwd(Some("/Users/x/Projects/worktree-trashcan/app"), &t, true),
            CwdState::Live,
            "substring matching would accuse an innocent directory"
        );
        assert_eq!(classify_cwd(None, &t, false), CwdState::Unknown);
    }

    /// The port is read from the reserved list, not typed twice. If someone changes `devUrl` and
    /// `RESERVED_PORTS` together, this follows; if they type a literal here, it silently would not.
    #[test]
    fn the_default_port_is_the_reserved_one() {
        assert_eq!(default_dev_port(), 1420);
        assert_eq!(Some(default_dev_port()), crate::preview_csp::RESERVED_PORTS.first().copied());
    }

    /// Report-only is a property worth PINNING rather than trusting to a reader's discipline: a
    /// future edit that reaches for a signal from the report path should have to delete a test that
    /// says out loud why it must not.
    ///
    /// The slice is deliberate and is the whole subtlety of this test. It runs from the first
    /// section banner to the `WIRING` banner, which is exactly the probe + report machinery —
    /// [`SystemProbe`], the parsers, [`classify_cwd`], [`build_report`], [`held_message`]. It
    /// EXCLUDES the module doc and the wiring section on purpose, because
    /// [`stop_preview_before_teardown`] lives there and legitimately names
    /// `proc::kill_process_group` when explaining which already-proven stop it reuses. Scoping this
    /// at the whole file instead was the first thing written here, and it failed on that prose —
    /// which is the useful reminder that "no signal anywhere in the module" is not the claim. The
    /// claim is that nothing on the path from a port number to a sentence can signal.
    #[test]
    fn the_report_path_never_signals() {
        let src = include_str!("dev_port_preflight.rs");
        let after_intro = src
            .split_once("//  THE SHAPE OF AN ANSWER")
            .expect("the opening banner is in this file")
            .1;
        let report_path = after_intro
            .split_once("//  WIRING")
            .expect("the wiring banner is in this file")
            .0;
        for forbidden in ["kill_process_group", "libc::kill", "signal::kill", "SIGKILL", "SIGTERM"] {
            assert!(
                !report_path.contains(forbidden),
                "the report path must not signal anything, but it mentions `{forbidden}`"
            );
        }
        // And the slice must actually be the report path, not an empty string that trivially
        // contains nothing — the failure mode that would make this test permanently vacuous.
        assert!(report_path.contains("pub fn build_report"), "the slice must cover build_report");
        assert!(report_path.contains("pub fn held_message"), "the slice must cover held_message");
    }

    // ── REGISTRY ATTRIBUTION (bead `.5`) ─────────────────────────────────────────

    fn free_report() -> DevPortReport {
        DevPortReport {
            port: 1420,
            verdict: Verdict::Free,
            holders: Vec::new(),
            message: String::new(),
            registry: None,
        }
    }

    fn held_report() -> DevPortReport {
        build_report(
            1420,
            &probe(Some(LSOF_ONE), Some(LSOF_CWD_LIVE), Some(PS_VITE)),
            &trash(),
            &|_| true,
        )
    }

    /// A PORT THE REGISTRY HAS NEVER HEARD OF CHANGES NOTHING. The accuse-nobody discipline is the
    /// default and stays the default: this is the case every process a human started falls into.
    #[test]
    fn a_port_with_no_record_reports_exactly_what_it_always_did() {
        let before = held_report();
        let after = with_registry_claim(before.clone(), None);
        assert_eq!(after, before, "no record must mean no change, byte for byte");
        assert!(after.registry.is_none());

        let free = with_registry_claim(free_report(), None);
        assert!(free.message.is_empty(), "and a free port must still say nothing at all");
        assert!(!free.worth_reporting());
    }

    /// A LEASE NAMES ITS AGENT — the sentence the original complaint was missing. "The port is in
    /// use" without a name tells a human with eight agents running precisely nothing.
    #[test]
    fn a_leased_port_names_the_agent_that_recorded_it() {
        let claim = RegistryClaim {
            agent_id: "agent-7".into(),
            pid: 991,
            kind: ClaimKind::Lease,
            name: None,
        };
        let r = with_registry_claim(held_report(), Some(claim.clone()));
        assert!(r.message.contains("agent-7"), "{}", r.message);
        assert!(r.message.contains("991"), "{}", r.message);
        assert!(r.message.contains("LEASED"), "{}", r.message);
        assert!(r.message.contains("A lease can move"), "the remedy must match the kind: {}", r.message);
        assert_eq!(r.registry, Some(claim));
        // The original sentence survives — the claim is ADDITIVE, never a replacement.
        assert!(r.message.contains("pid 48213"), "{}", r.message);
    }

    /// A GATE LOCK GETS A DIFFERENT REMEDY, because a pinned port has no second port to move to.
    /// A remedy is an instruction somebody will follow, so offering "stop it and it will come back
    /// on its own" for a resource that cannot move would be a dead instruction.
    #[test]
    fn a_gate_locked_port_is_told_apart_from_a_leased_one() {
        let r = with_registry_claim(
            held_report(),
            Some(RegistryClaim {
                agent_id: "agent-3".into(),
                pid: 12,
                kind: ClaimKind::GateLock,
                name: Some("-1420".into()),
            }),
        );
        assert!(r.message.contains("GATE-LOCKED by agent agent-3"), "{}", r.message);
        assert!(r.message.contains("-1420"), "{}", r.message);
        assert!(r.message.contains("no second port to move to"), "{}", r.message);
        assert!(!r.message.contains("A lease can move"), "the lease remedy must NOT appear: {}", r.message);
    }

    /// A RECORD ON A PORT NOTHING IS LISTENING ON IS A LEAK, and saying so is what gets the lease
    /// cleaned up before its TTL runs out. `Free` normally reports nothing at all, so this is the
    /// one thing that can make a free port worth reporting.
    #[test]
    fn a_record_on_a_free_port_is_reported_as_a_leak() {
        let r = with_registry_claim(
            free_report(),
            Some(RegistryClaim {
                agent_id: "gone".into(),
                pid: 4,
                kind: ClaimKind::Lease,
                name: None,
            }),
        );
        assert_eq!(r.verdict, Verdict::Free);
        assert!(r.worth_reporting(), "a leaked lease must break the free-port silence");
        assert!(r.message.contains("that is a LEAK, not a collision"), "{}", r.message);
        assert!(r.message.contains("port_broker_release"), "the remedy must be reachable: {}", r.message);
    }

    /// UNDETERMINED IS THE CASE A READER IS MOST STUCK ON: `lsof` could not say who is on the port,
    /// and the registry still holds a name somebody volunteered. Both sentences must survive.
    #[test]
    fn an_undetermined_verdict_still_reports_what_the_registry_knows() {
        let r = with_registry_claim(
            undetermined(1420, COULD_NOT_LOOK),
            Some(RegistryClaim {
                agent_id: "agent-9".into(),
                pid: 77,
                kind: ClaimKind::Lease,
                name: None,
            }),
        );
        assert_eq!(r.verdict, Verdict::Undetermined);
        assert!(r.message.contains("could not determine"), "{}", r.message);
        assert!(r.message.contains("agent-9"), "{}", r.message);
    }

    /// THE READ SIDE, against a REAL registry: a lease written by the broker is the one this module
    /// reads back. A pure test of the sentence cannot catch the two modules disagreeing about where
    /// records live or what shape they are.
    #[test]
    fn the_claim_is_read_back_from_the_brokers_own_registry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let settings = crate::port_broker::BrokerSettings {
            enabled: true,
            range_start: 45000,
            range_end: 45000,
            ..crate::port_broker::BrokerSettings::default()
        };
        let unbound = |_: u16| false;
        let env =
            crate::port_broker::Env { now_ms: 1_800_000_000_000, pid: 1234, is_bound: &unbound };
        crate::port_broker::acquire_port(dir.path(), &settings, "agent-x", "preview", &env)
            .expect("a lease");
        let claim = registry_claim(dir.path(), 45000).expect("the registry must name the holder");
        assert_eq!(claim.agent_id, "agent-x");
        assert_eq!(claim.pid, 1234);
        assert_eq!(claim.kind, ClaimKind::Lease);
        assert!(registry_claim(dir.path(), 45001).is_none(), "and must stay silent about every other port");

        crate::port_broker::acquire_gate_lock(
            dir.path(),
            &settings,
            &crate::port_broker::pinned_gate_name(1420),
            "agent-pin",
            None,
            &env,
        )
        .expect("a lock");
        let gate = registry_claim(dir.path(), 1420).expect("a pinned port's lock must be readable");
        assert_eq!(gate.kind, ClaimKind::GateLock);
        assert_eq!(gate.agent_id, "agent-pin");
        assert_eq!(gate.name.as_deref(), Some("port-1420"));
    }

    /// The attribution must not have smuggled a signal into this module. The header's whole rule is
    /// that nothing here ever kills; a record naming an agent is a stronger temptation than an
    /// inference about a pid, so the guard is re-run over the new code path explicitly.
    #[test]
    fn the_attribution_path_signals_nothing() {
        let whole = include_str!("dev_port_preflight.rs");
        let start = whole.find("pub fn registry_claim").expect("registry_claim must exist");
        let end = whole.find("#[cfg(test)]").expect("test marker");
        let path = &whole[start..end];
        assert!(path.len() > 500, "the slice must not have been truncated to nothing");
        for forbidden in ["kill_process_group", "libc::kill", "signal::kill", "SIGKILL", "SIGTERM"] {
            assert!(!path.contains(forbidden), "the attribution path mentions `{forbidden}`");
        }
        assert!(path.contains("pub fn with_registry_claim"), "the slice must cover the fold");
    }
}

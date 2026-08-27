// apps/desktop/src-tauri/src/notes.rs
//! Lightweight "save selection" sinks for the terminal selection popup:
//! append a note to the project's NOTES.md, or create a beads issue via the `bd` CLI.
//! Both run against the user-chosen project root (not the hidden worktree).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::beads_cmd::{self, BdOutput, BeadsError, BeadsErrorKind};

// ---------------------------------------------------------------------------
// `bd` resolution — kill the per-call login shell (PERF)
//
// Every bd invocation below used to run `/bin/zsh -l -c 'cd "$N" && bd …'`. A `zsh -l` startup
// re-sources the user's login dotfiles (nvm/pyenv/heavy .zprofile) and costs 100-500ms — and
// `list_beads` alone pays it EVERY 5s per open project (the beadsStore poll). Instead we resolve
// bd's ABSOLUTE path ONCE per session (a login-shell PATH probe + canonical-location fallback —
// the exact approach preflight.rs uses for claude/node/git; those resolver helpers are private to
// that module, so the small probe is mirrored here across the module boundary) and exec bd
// DIRECTLY, with no shell on the hot path. bd's own args were already passed positionally
// (injection-safe); as real argv tokens now they keep that property with no shell in the loop.
// ---------------------------------------------------------------------------

/// How long a NEGATIVE resolution (bd is not installed) is trusted before probing again.
///
/// Caching the miss at all is the point: the module note above exists because a `zsh -l` probe
/// costs 100-500ms and `list_beads` runs EVERY 5s per open project. A positive-hit-only cache
/// delivers that win on machines where bd IS installed and defeats it completely on machines where
/// it is NOT — every miss re-ran the full login-shell probe, so the one configuration that gets no
/// value out of bd paid the entire cost of it, forever, on the poll interval.
///
/// The TTL is what keeps the original property intact. The policy that motivated positive-only
/// caching — "a bd installed while the app runs is picked up without a restart" — only needs the
/// miss to EXPIRE, not to be re-probed on literally every call. At 30s against a 5s poll that is a
/// 6x cut in login shells for the missing-bd case, and a bd installed mid-session is still picked
/// up within half a minute with no restart.
const BD_MISS_TTL: Duration = Duration::from_secs(30);

/// Session cache for bd's resolved absolute path.
///
/// A hit is cached for the whole session. A miss is cached for [`BD_MISS_TTL`] — see that
/// constant for why the miss is cached at all and why it expires.
#[derive(Default)]
struct BdPathCache {
    /// A successful resolution, kept for the session.
    hit: Option<String>,
    /// When the last failed resolution happened, if any.
    last_miss: Option<Instant>,
}

fn bd_path_cache() -> &'static Mutex<BdPathCache> {
    static CACHE: OnceLock<Mutex<BdPathCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BdPathCache::default()))
}

/// Whether a cache in this state has to run the (expensive) resolver.
///
/// Pure so the TTL policy is testable without a clock or a machine that lacks bd.
fn bd_cache_needs_probe(cache: &BdPathCache, now: Instant, ttl: Duration) -> bool {
    if cache.hit.is_some() {
        return false;
    }
    match cache.last_miss {
        // `saturating_` because a non-monotonic reading must degrade to "probe again", never panic.
        Some(at) => now.saturating_duration_since(at) >= ttl,
        None => true,
    }
}

/// Canonical absolute `bd` install locations, user-first: native/non-sudo installs (`~/.local/bin`),
/// `go install` (`~/go/bin`), `cargo install` (`~/.cargo/bin`), then Homebrew prefixes. Pure form
/// (home passed in) so it's unit-testable without mutating the process-global HOME.
fn known_bd_paths_for(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/bd")); // native / non-sudo install
        paths.push(home.join("go/bin/bd")); // `go install`
        paths.push(home.join(".cargo/bin/bd")); // `cargo install`
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/bd")); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin/bd")); // homebrew (Intel) / npm
    paths
}

/// True if `p` resolves to an existing, executable file (symlinks followed). Mirrors preflight.rs's
/// private `is_executable` (can't be reused across the module boundary).
#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Windows has no executable bit; treat any existing regular file as runnable (the candidates are
/// absolute install paths, and the primary resolver there is `where` anyway).
#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

/// First candidate that exists and is executable, as an absolute path string.
fn first_executable(candidates: &[PathBuf]) -> Option<String> {
    candidates
        .iter()
        .find(|p| is_executable(p))
        .map(|p| p.to_string_lossy().into_owned())
}

/// How long the login-shell probe may take before it is abandoned in favour of [`known_bd_paths_for`].
///
/// A `command -v` is microseconds of work; everything this bound is spending is the user's rc files.
/// Generous enough for a heavy-but-finite profile (nvm, rbenv, conda all init well inside it), short
/// enough that a wedged one costs a startup hiccup instead of the session.
#[cfg(unix)]
const BD_WHICH_TIMEOUT: Duration = Duration::from_secs(5);

/// Probe a login shell for `bd`'s absolute path, BOUNDED. Shell and script are parameters so the
/// bound is testable without a machine whose real login shell hangs on demand.
///
/// THE DEFECT THIS REMOVES: this probe ended in `.output()`, which waits FOREVER. That is the same
/// unbounded call this module already eliminated from [`run_bd`] — see its doc on
/// `bridge request timeout: concierge_tool` — but it survived one level DOWN, in the resolver, where
/// it is strictly worse. `-lc` runs the user's full rc files, which routinely block on a network
/// mount, a VPN-gated prompt or a version manager reaching for a registry; and because every bd call
/// funnels through [`cached_bd_path`] on a cold cache, one such hang wedges the FIRST bd call of the
/// session with `BD_TIMEOUT` never even started — the bound lives above the resolver, so it cannot
/// fire on a resolver that has not returned. The whole timeout ladder sits above this line.
///
/// The fallback makes the bound cheap rather than lossy: giving up here does not mean "no bd", it
/// means [`resolve_bd_uncached`] goes on to check the canonical install locations, which is where a
/// Homebrew or user-local bd already is. Answering from that list beats waiting on a shell that is
/// never coming back.
///
/// `output_with_timeout` rather than this module's `run_cmd_bounded`: that one routes through
/// `run_cmd_timed`, which sets `PATH` from [`bd_exec_path`] — which resolves bd — so using it inside
/// the resolver would re-enter it. It also puts the child in its own process group, so expiry kills
/// the rc files' descendants too rather than leaving the shell's children behind.
#[cfg(unix)]
fn which_via_login_shell(shell: &str, script: &str, timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(shell);
    cmd.args(["-lc", script]);
    crate::worktree::output_with_timeout(cmd, timeout)
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|p| Path::new(p).is_absolute() && is_executable(Path::new(p)))
}

/// Probe the user's LOGIN shell ONCE for `bd`'s absolute path. macOS GUI apps inherit no shell
/// PATH, so a bare `Command::new("bd")` misses a Homebrew/user-local bd; the login shell resolves
/// whatever PATH the user actually configured. Mirrors preflight.rs's
/// `run_in_login_shell("command -v …")` — except that this one is BOUNDED; see
/// [`which_via_login_shell`].
#[cfg(unix)]
fn login_shell_which_bd() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    which_via_login_shell(&shell, "command -v bd", BD_WHICH_TIMEOUT)
}

/// Windows: resolve `bd` via `where` (GUI apps inherit PATH). Returns the first hit.
#[cfg(not(unix))]
fn windows_which_bd() -> Option<String> {
    Command::new("where")
        .arg("bd")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .find(|l| !l.is_empty())
        })
}

/// Resolve bd's absolute path WITHOUT caching: login/`where` probe first, then the canonical
/// install locations.
fn resolve_bd_uncached() -> Option<String> {
    #[cfg(unix)]
    {
        login_shell_which_bd().or_else(|| {
            first_executable(&known_bd_paths_for(std::env::var_os("HOME").map(PathBuf::from)))
        })
    }
    #[cfg(not(unix))]
    {
        windows_which_bd().or_else(|| {
            let home = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from);
            first_executable(&known_bd_paths_for(home))
        })
    }
}

/// bd's resolved absolute path, cached for the session — a hit forever, a miss for
/// [`BD_MISS_TTL`] (see the cache note).
/// Concurrent callers may both resolve on a cold cache (idempotent); a poisoned lock falls back to
/// an uncached resolve.
/// `pub(crate)` so `beads_cmd` (the typed planning/beads command surface) resolves bd through THIS
/// resolver instead of standing up a second, divergent one — the same reuse rationale
/// `preflight::run_in_login_shell` documents at its own definition.
pub(crate) fn cached_bd_path() -> Option<String> {
    let now = Instant::now();
    if let Ok(guard) = bd_path_cache().lock() {
        if let Some(path) = guard.hit.as_ref() {
            return Some(path.clone());
        }
        if !bd_cache_needs_probe(&guard, now, BD_MISS_TTL) {
            // A recent probe already said bd is not installed. Answer from the cache rather than
            // paying another login shell — that repeat cost is the whole defect this guards.
            return None;
        }
    }
    let resolved = resolve_bd_uncached();
    if let Ok(mut guard) = bd_path_cache().lock() {
        match resolved.as_ref() {
            Some(path) => {
                guard.hit = Some(path.clone());
                guard.last_miss = None;
            }
            // Stamp the miss AFTER the probe: the TTL should bound the gap between probes, not
            // start running while a slow login shell is still going.
            None => guard.last_miss = Some(Instant::now()),
        }
    }
    resolved
}

/// PATH we hand `bd` so its OWN child processes resolve — bd shells out to `git` for its
/// git-backed jsonl storage, and a GUI app's inherited PATH is too bare to find it. Built ONCE
/// from bd's dir + the resolved git dir (reusing preflight's cached git resolver) + the canonical
/// bin locations, ahead of the inherited PATH. Cached for the session.
/// `pub(crate)` for `beads_cmd` — see the note on [`cached_bd_path`]. Sharing this matters more than
/// sharing the resolver: the PATH bd's own `git` child needs is easy to get subtly wrong twice.
pub(crate) fn bd_exec_path() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut candidates: Vec<PathBuf> = Vec::new();
            // bd's own dir (a helper next to bd resolves) and git's dir (bd → git).
            if let Some(bd) = cached_bd_path() {
                if let Some(dir) = Path::new(&bd).parent() {
                    candidates.push(dir.to_path_buf());
                }
            }
            if let Some(git) = crate::preflight::resolve_git_path_cached() {
                if let Some(dir) = Path::new(&git).parent() {
                    candidates.push(dir.to_path_buf());
                }
            }
            if let Some(home) = std::env::var_os("HOME") {
                candidates.push(PathBuf::from(&home).join(".local/bin"));
            }
            for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            {
                candidates.push(PathBuf::from(d));
            }
            let mut dirs: Vec<String> = Vec::new();
            for c in candidates {
                let s = c.to_string_lossy().to_string();
                if !s.is_empty() && !dirs.contains(&s) {
                    dirs.push(s);
                }
            }
            if let Ok(inherited) = std::env::var("PATH") {
                if !inherited.is_empty() {
                    dirs.push(inherited);
                }
            }
            dirs.join(":")
        })
        .clone()
}

/// Run `bd <args>` inside `project_path`, DIRECTLY (no shell) using the session-cached absolute bd
/// path and an augmented PATH (so bd's `git` subprocess resolves under a GUI app's bare PATH).
/// Replaces the old `/bin/zsh -l -c 'cd "$N" && bd …'` on every call — see the module note on why
/// the login shell was a hot-path tax. `args` are real argv tokens (never a shell string), so they
/// stay injection-safe exactly as the old positional-`$N` scheme was. The cwd is pinned by the
/// runner (and, as a bonus, that drops the dotfile-`cd` hazard the old comment guarded).
///
/// BOUNDED — this is the fix for `bridge request timeout: concierge_tool` on board writes. This fn
/// used to end in `.output()`, which waits FOREVER. bd is Dolt/git-backed and takes a lock on a
/// store every worktree in the repo shares, and `beadsStore.ts` polls `bd list`/`bd blocked` on a 5s
/// interval concurrently with writes — so under contention bd BLOCKS rather than failing, and every
/// call site here could hang permanently. The timeout ladder above it is all finite (30s MCP socket
/// < 60s liveness stall << 600s Rust rendezvous), so an unbounded call at the bottom meant the
/// caller was told "timeout" by a transport while the real work sat wedged with nothing to cancel
/// it. See `beads_cmd::run_cmd_timed`, whose own doc named this exact defect.
///
/// Returns `beads_cmd::BdOutput`, not `std::process::Output`: a bounded runner has to synthesize its
/// result when it kills the child, and `ExitStatus` cannot be constructed portably on stable
/// (`ExitStatusExt::from_raw` is unix-only) while this crate must keep building on Windows. Callers
/// read `success` / `stdout` / `stderr`, which is what they did with `Output` anyway.
fn run_bd(project_path: &str, args: &[&str]) -> Result<BdOutput, String> {
    let bd = cached_bd_path()
        .ok_or_else(|| "bd not found — install beads or add `bd` to your PATH".to_string())?;
    run_cmd_bounded(&bd, project_path, args, beads_cmd::BD_TIMEOUT)
}

/// `run_bd` with extra environment for the child. Exists for `bd comment`, which falls back to
/// `$EDITOR` when no comment text is supplied — and an editor opened from a Tauri command has no
/// terminal attached, so it would hang until the bd timeout with nothing to show for it. Pinning
/// `EDITOR=true` turns that into an immediate, readable "empty comment, aborting" instead.
fn run_bd_env(
    project_path: &str,
    args: &[&str],
    env: beads_cmd::ChildEnv<'_>,
) -> Result<BdOutput, String> {
    let bd = cached_bd_path()
        .ok_or_else(|| "bd not found — install beads or add `bd` to your PATH".to_string())?;
    run_cmd_bounded_env(&bd, project_path, args, beads_cmd::BD_TIMEOUT, env)
}

/// The delegation proper, with the program and the bound as parameters so BOTH are testable without
/// a bd that hangs on demand — `run_cmd_timed` takes the program explicitly for the same reason.
///
/// Reuses `beads_cmd`'s runner rather than growing a second timeout here: that one already drains
/// both pipes on their own threads (a child filling a 64 KB pipe buffer would otherwise deadlock
/// against our wait — `bd list` over this repo emits ~2.9 MB), kills the child on expiry, and
/// deliberately returns WITHOUT touching the readers on the timeout path, because bd's background
/// `dolt sql-server` grandchild can hold the pipes open forever. Each of those is a hang; a
/// re-implementation would have to rediscover all three.
fn run_cmd_bounded(
    program: &str,
    project_path: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<BdOutput, String> {
    run_cmd_bounded_env(program, project_path, args, timeout, beads_cmd::NO_EXTRA_ENV)
}

/// `run_cmd_bounded` with extra child environment. See [`run_bd_env`] for the one caller.
fn run_cmd_bounded_env(
    program: &str,
    project_path: &str,
    args: &[&str],
    timeout: Duration,
    env: beads_cmd::ChildEnv<'_>,
) -> Result<BdOutput, String> {
    let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    beads_cmd::run_cmd_timed(program, project_path, &owned, timeout, env)
        .map_err(|e| describe_bd_failure(&e, bd_subcommand_mutates(args)))
}

/// The bd subcommands this module issues that only READ. Everything else is treated as a mutation.
///
/// Defaulting an UNKNOWN subcommand to "mutation" is the safe direction, and the asymmetry is the
/// whole reason to state it: over-caution on a read merely tells someone to look before retrying,
/// while under-caution on a write invites exactly the duplicate this message exists to prevent.
const BD_READ_SUBCOMMANDS: [&str; 5] = ["list", "show", "blocked", "where", "memories"];

/// Does this invocation change the store? Pure, so the classification is testable without bd.
///
/// Derived from the SUBCOMMAND rather than threaded through all twelve call sites, because the
/// subcommand IS the operation — a marker passed by hand at each site is one more thing to get
/// wrong, and it would silently disagree with the argv actually sent.
fn bd_subcommand_mutates(args: &[&str]) -> bool {
    match args.first() {
        Some(sub) => !BD_READ_SUBCOMMANDS.contains(sub),
        None => true,
    }
}

/// Flatten a typed `BeadsError` into the `String` this module's frontend contract speaks — and, for
/// a TIMEOUT, say plainly that the outcome is UNKNOWN.
///
/// This is half the fix, not polish. Nothing cancels bd when we stop waiting: the transport that
/// gave up at 30s left the `bd create` running to completion, so the bead very probably WAS created
/// and only the ack was lost — and now that we kill bd ourselves, bd may equally have committed the
/// row in the instant before the kill. A message that reads like a clean "it failed" invites exactly
/// the wrong next action from a human and from a model.
///
/// And it must NOT invite a retry. `bd create` has no idempotency key, so a blind retry after a
/// create that actually committed files a SECOND bead. The remedy is to look, not to re-send —
/// which is why the copy names the board rather than offering a retry.
/// `mutates` is what keeps this copy HONEST, and it was missing (roborev 59622). `run_bd` is the
/// single choke point for reads and writes alike, so an unconditional write-ambiguity message told a
/// timed-out `bd list` that "the item may or may not have been created" — about a call that created
/// nothing — and warned it off the retry that is precisely the right next action for a read. That is
/// the repo's own "a remedy string is an instruction the reader follows" failure, in the code added
/// to fix an instance of it.
///
/// The Timeout variants are also NOT one outcome, and there are THREE of them, not two — an earlier
/// version of this comment said two and the code agreed with it, which is how the bug below shipped.
///
///   * `None` — the KILL path. bd was still running when the bound fired, so whether it committed
///     first is genuinely unknown. (A drain-path child killed by a SIGNAL also lands here, because
///     `status.code()` is `None` for it. That is fine: "unknown" is the honest answer there too.)
///   * `Some(0)` — the DRAIN path, succeeding. bd EXITED cleanly and only its output pipe stayed
///     open (a background `dolt sql-server` grandchild holding the write end). The operation ran to
///     completion; what was lost is the reply, not the write.
///   * `Some(non-zero)` — the DRAIN path, FAILING. bd ran and rejected the operation, so the change
///     most likely did NOT land.
///
/// Branching on `Some(_)` instead of on SUCCESS is what made the failing case claim the write had
/// landed (roborev 59629) — the inverse of the truth, and inverted in the costly direction: a caller
/// following that copy looks at a board showing nothing, concludes the item was already filed, and
/// never re-files it. Keep this list in step with the match arms; a doc that still described two
/// variants is what made the third one easy to miss.
fn describe_bd_failure(e: &BeadsError, mutates: bool) -> String {
    if e.kind != BeadsErrorKind::Timeout {
        return e.message.clone();
    }
    if !mutates {
        return format!(
            "{} — this was a read, so nothing was written and retrying is safe.",
            e.message
        );
    }
    match e.exit_code {
        // Drain path, bd SUCCEEDED: it ran to completion and only its reply was lost.
        Some(0) => format!(
            "{} — bd itself finished successfully; what was lost is its reply, not the write, so \
             the change most likely LANDED. Verify on the board rather than retrying: bd create has \
             no idempotency key, so a retry can file a second item.",
            e.message
        ),
        // Drain path, bd FAILED. Branching on the presence of a code rather than on SUCCESS claimed
        // the write landed for a non-zero exit too (roborev 59629) — the inverse of the truth, and
        // the costly inversion: a caller following that copy looks at a board showing nothing and
        // concludes the item was already filed, so it never gets re-filed. `bd create` losing the
        // store lock is exactly this shape. Third occurrence of "who is this advice wrong for?" in
        // one change; the axis moved from read-vs-write to success-vs-failure, the defect did not.
        Some(code) => format!(
            "{} — bd exited with a FAILING status (exit {code}), so the change most likely did NOT \
             land; its diagnostics could not be read. Re-check the board, then retry if the change \
             is absent.",
            e.message
        ),
        // Kill path: bd was still running, so it may or may not have committed first.
        None => format!(
            "{} — whether the change landed is UNKNOWN: the item may or may not have been created \
             or updated. Check the board before retrying; do not retry blindly, because bd create \
             is not idempotent and a retry can file a second item.",
            e.message
        ),
    }
}

/// Constrain `project_path` to a legitimate project root before we touch the filesystem under it
/// (SECURITY). The basename is already gated (`validate_bare_filename`), but an unrestricted
/// `project_path` let the webview write `NOTES.md` / `PRD/<name>.md` into — or read
/// `PRD/<name>.md` out of — ANY directory the user can access (`~/.ssh`, `~/Library`, `/etc`, …).
/// Every real Sparkle project root is a git repository (the whole app is git-worktree based;
/// `bd`/PRD/NOTES all live in a repo), so we require an absolute, existing directory that contains
/// a `.git` entry — a DIR in a normal clone, a FILE in a linked worktree — which those sensitive
/// non-repo targets never do. We canonicalize FIRST so a symlink or `..` can't smuggle the check
/// across a repo boundary. Returns the canonical root to use for the join.
fn validate_project_root(project_path: &str) -> Result<PathBuf, String> {
    if project_path.is_empty() {
        return Err("project_path must not be empty".into());
    }
    let raw = Path::new(project_path);
    if !raw.is_absolute() {
        return Err(format!("project_path must be an absolute path: {project_path}"));
    }
    let real = std::fs::canonicalize(raw)
        .map_err(|e| format!("project_path is not an accessible directory: {project_path} ({e})"))?;
    if !real.is_dir() {
        return Err(format!("project_path is not a directory: {}", real.display()));
    }
    if !real.join(".git").exists() {
        return Err(format!(
            "project_path is not a registered project root (no git repository): {}",
            real.display()
        ));
    }
    Ok(real)
}

/// Append a timestamped note to `<project_path>/NOTES.md`, creating the file if needed.
/// The timestamp is supplied by the frontend (ISO 8601) to avoid pulling a date crate.
/// `project_path` is constrained to a real project root (see `validate_project_root`).
#[tauri::command]
pub fn append_note(project_path: String, text: String, timestamp: String) -> Result<(), String> {
    let root = validate_project_root(&project_path)?;
    let path = root.join("NOTES.md");
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    write!(f, "\n\n## {timestamp}\n{text}\n").map_err(|e| format!("write NOTES.md: {e}"))?;
    Ok(())
}

/// Create a beads issue in `project_path` via `bd create`. Execs bd DIRECTLY (resolved absolute
/// path, no login shell — see the module note). Title/body are passed as real argv tokens, never
/// interpolated into a shell string, so they can't break out of the command; `run_bd` pins the cwd
/// via `.current_dir` (replacing the old `cd "$3"`). Returns bd's raw `--json` stdout (the created
/// issue, or an `{"error": …}` object).
///
/// `labels` is an optional comma-separated list forwarded as `-l`. It exists so the app can stamp
/// `sparkle-auto` on the beads it auto-creates for Build agents: unlabeled, those are
/// indistinguishable from human-filed backlog the moment the agent is gone, which is how 299 of
/// them accumulated. `Option` rather than `String` so existing callers that omit it still compile
/// and no `-l` is passed at all when it's absent (bd rejects an empty label).
#[tauri::command]
pub async fn create_bead(
    project_path: String,
    title: String,
    body: String,
    labels: Option<String>,
    priority: Option<i64>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_bead_inner(
            &project_path,
            &title,
            &body,
            labels.as_deref(),
            priority,
            beads_cmd::NO_EXTRA_ENV,
        )
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Sync core of [`create_bead`]; a plain fn so the async command offloads it via `spawn_blocking`
/// and a test can drive the PRODUCTION path (the fold included) without a Tauri runtime.
///
/// `env` is the injection seam and it is the one the call already had: `bead_dup::fold_or_create`
/// reads `SPARKLE_BEAD_DUP_SCAN` out of this slice before the process environment, so a test points
/// the real resolution at a fake scanner instead of overriding a defaulted `deps` parameter — which
/// would leave the line that supplies the real value covered by nothing.
///
/// The title rides `--title=<t>`, NOT the positional `bd create <title>` slot. A positional operand
/// is the one place bd's parser cannot tell content from a flag: it rejects a title starting with
/// `-` outright, and a plain markdown bullet ("- fix the thing") is enough to trigger it. The `=`
/// form binds the value inside a single argv token, so no leading dash can be re-read as an option.
/// `beads_cmd::build_create_args` already did this; this path was the one still exposed.
fn create_bead_inner(
    project_path: &str,
    title: &str,
    body: &str,
    labels: Option<&str>,
    priority: Option<i64>,
    env: beads_cmd::ChildEnv<'_>,
) -> Result<String, String> {
    let labels = labels.map(str::trim).filter(|s| !s.is_empty());
    // Duplicate detection runs BEFORE the create and is gated by `bead_dup`'s skip list — see that
    // module's note on why an unconditional fold corrupts agent↔bead bindings. `None` (which is
    // every uncertainty, not just "no match") falls through to the create below.
    if let Some(row) = crate::bead_dup::fold_or_create(
        project_path,
        title,
        body,
        labels.unwrap_or(""),
        "",
        "",
        env,
    ) {
        return Ok(row.to_string());
    }
    let priority = priority.map(bd_priority_arg).transpose()?;
    let title_arg = format!("--title={}", title.trim());
    let mut args: Vec<&str> = vec!["create", &title_arg, "-d", body, "--json"];
    if let Some(l) = labels {
        args.push("-l");
        args.push(l);
    }
    if let Some(p) = priority.as_deref() {
        args.push("-p");
        args.push(p);
    }
    let output = run_bd_env(project_path, &args, env)?;
    select_bd_result(output.success, output.stdout.trim(), output.stderr.trim())
}

/// bd's `-p` value for a caller-supplied priority, or an error naming the range.
///
/// Validated HERE as well as in the concierge registry's zod schema because this command is reached
/// from more than that one route, and bd's own rejection of an out-of-range value surfaces as an
/// opaque non-zero exit rather than something the caller can act on.
fn bd_priority_arg(p: i64) -> Result<String, String> {
    if !(0..=4).contains(&p) {
        return Err(format!("invalid priority: {p} (expected 0-4)"));
    }
    Ok(p.to_string())
}

/// Decide what to return from `create_bead` given bd's process result. Extracted as a pure
/// function so the (otherwise shell-dependent) branch ordering is unit-testable.
///
/// bd emits a JSON object on both success and (caught) error. The frontend parses that JSON
/// (success -> id, caught error -> `{"error": …}`), so whenever stdout looks like bd's JSON
/// payload we return it regardless of exit status — even if bd also wrote a warning to stderr
/// on a non-zero exit. Only when stdout is NOT bd's JSON (shell error, missing `bd`, crash) do
/// we surface stderr (or stdout) as a raw error string for the frontend to display.
fn select_bd_result(success: bool, stdout: &str, stderr: &str) -> Result<String, String> {
    if stdout.starts_with('{') {
        return Ok(stdout.to_string());
    }
    if success {
        if stdout.is_empty() {
            return Err("bd produced no output".into());
        }
        // Clean exit but non-JSON stdout — pass it through; the frontend reports it verbatim.
        return Ok(stdout.to_string());
    }
    if !stderr.is_empty() {
        return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("bd produced no output".into())
}

/// Result handling for bd READ commands (`bd list`/`bd show --json`) whose stdout is a JSON
/// array/object the frontend parses directly. Unlike `select_bd_result` (which extracts an id),
/// this returns bd's full stdout verbatim on success.
fn select_bd_raw(success: bool, stdout: &str, stderr: &str) -> Result<String, String> {
    if success {
        if stdout.is_empty() {
            return Err("bd produced no output".into());
        }
        return Ok(stdout.to_string());
    }
    // Failure: prefer bd's structured JSON error if it emitted one, else stderr, else stdout.
    if stdout.starts_with('{') {
        return Ok(stdout.to_string());
    }
    if !stderr.is_empty() {
        return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("bd produced no output".into())
}

/// Result handling for bd MUTATION commands (`dep add`, `label add/remove`) whose stdout may be
/// empty on success and is not necessarily JSON. Returns "ok" for a silent success so the caller
/// always gets a non-empty confirmation string.
fn select_bd_action(success: bool, stdout: &str, stderr: &str) -> Result<String, String> {
    if success {
        return Ok(if stdout.is_empty() { "ok".to_string() } else { stdout.to_string() });
    }
    if stdout.starts_with('{') {
        return Ok(stdout.to_string());
    }
    if !stderr.is_empty() {
        return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("bd produced no output".into())
}

/// Shared bare-filename gate for the PRD read/write commands: reject anything containing a path
/// separator, a `..` traversal, an absolute path, or a `:` (a Windows drive-relative name like
/// `C:secret.txt` is neither separated nor absolute, yet `Path::join` would replace the whole
/// base path there), so a caller can never escape `PRD/`.
fn validate_bare_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains(':')
        || filename.contains("..")
        || Path::new(filename).is_absolute()
    {
        return Err(format!("invalid filename (must be a bare filename): {filename}"));
    }
    Ok(())
}

/// Write a markdown doc into the project's `PRD/` directory. `filename` MUST be a bare filename
/// (see `validate_bare_filename`). Creates `PRD/` if needed and returns the repo-relative path
/// (`PRD/<filename>`) on success.
#[tauri::command]
pub fn write_prd(project_path: String, filename: String, content: String) -> Result<String, String> {
    validate_bare_filename(&filename)?;
    let root = validate_project_root(&project_path)?;
    let prd_dir = root.join("PRD");
    std::fs::create_dir_all(&prd_dir).map_err(|e| format!("create {}: {e}", prd_dir.display()))?;
    let path = prd_dir.join(&filename);
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(format!("PRD/{filename}"))
}

/// Read a markdown doc back out of the project's `PRD/` directory — the read counterpart of
/// `write_prd`, behind the same `validate_bare_filename` gate. Returns the file content; a
/// missing file is an Err (caller decides how to degrade).
#[tauri::command]
pub fn read_prd(project_path: String, filename: String) -> Result<String, String> {
    validate_bare_filename(&filename)?;
    let root = validate_project_root(&project_path)?;
    let path = root.join("PRD").join(&filename);
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}

/// The `.gitignore` rule keeping capture screenshots out of git history. Screen captures
/// routinely contain sensitive content (tokens, emails, other apps) and must never be
/// committed — they stay local, referenced by repo-relative path.
const CAPTURE_ASSETS_IGNORE: &str = "PRD/assets/";

/// Pure: return `.gitignore` content with the `PRD/assets/` rule appended, or `None` when the
/// rule (with or without the trailing slash) is already present and no write is needed.
fn ensure_ignore_rule(existing: &str) -> Option<String> {
    let already = existing
        .lines()
        .map(|l| l.trim())
        .any(|l| l == CAPTURE_ASSETS_IGNORE || l == "PRD/assets");
    if already {
        return None;
    }
    let mut contents = existing.to_string();
    if !contents.is_empty() && !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(CAPTURE_ASSETS_IGNORE);
    contents.push('\n');
    Some(contents)
}

/// Copy a capture screenshot into `<project_path>/PRD/assets/<filename>` (dir created if
/// needed) and ensure `PRD/assets/` is gitignored. `filename` MUST be a bare filename (same
/// `validate_bare_filename` traversal gate as `write_prd`). `src` is an absolute path to the
/// screencapture temp file (copied FROM, not resolved within the repo). Returns the
/// repo-relative path (`PRD/assets/<filename>`).
#[tauri::command]
pub fn copy_capture_asset(
    project_path: String,
    src: String,
    filename: String,
) -> Result<String, String> {
    validate_bare_filename(&filename)?;
    let root = validate_project_root(&project_path)?;
    let assets_dir = root.join("PRD").join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("create {}: {e}", assets_dir.display()))?;
    // Tell macOS Spotlight / `mediaanalysisd` never to index this directory's images. Unlike the
    // temp capture/drop dirs, `PRD/assets` is a real, named directory inside the user's project, so
    // the `.noindex` suffix trick is not available; the empty `.metadata_never_index` marker file is
    // the documented equivalent for a directory whose name we do not control. Best-effort and
    // idempotent: it must NEVER fail the copy, so its error is deliberately swallowed. The marker is
    // already covered by the `PRD/assets/` gitignore rule below, so it is not committed.
    let _ = std::fs::write(assets_dir.join(".metadata_never_index"), b"");
    let dest = assets_dir.join(&filename);
    std::fs::copy(&src, &dest).map_err(|e| format!("copy {src} -> {}: {e}", dest.display()))?;

    let gitignore = root.join(".gitignore");
    let existing = std::fs::read_to_string(&gitignore).unwrap_or_default();
    if let Some(updated) = ensure_ignore_rule(&existing) {
        std::fs::write(&gitignore, updated)
            .map_err(|e| format!("write {}: {e}", gitignore.display()))?;
    }
    Ok(format!("PRD/assets/{filename}"))
}

/// List all beads in `project_path` via `bd list --all --limit 0 --json`. Returns bd's raw JSON
/// stdout (a JSON array) for the frontend to parse. `--all` is REQUIRED: a bare `bd list` applies
/// a default filter that excludes closed issues (so the board's "done"/"delivered" columns come
/// back empty) and caps output at 50 rows; `--all --limit 0` overrides both so the board sees every
/// issue in every status. Execs bd DIRECTLY (resolved absolute path, no login shell — see the
/// module note); this is the 5s-poll hot path the perf fix targets.
#[tauri::command]
pub async fn list_beads(project_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_bd(&project_path, &["list", "--all", "--limit", "0", "--json"])?;
        select_bd_raw(output.success, output.stdout.trim(), output.stderr.trim())
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// List the beads that are BLOCKED — open, with at least one unmet blocker — via `bd blocked
/// --json`. Returns bd's raw JSON stdout for the frontend to parse.
///
/// WHY THIS IS A SEPARATE CALL AND NOT A FIELD ON `list_beads`. `bd list --all --json` carries a
/// `status`, but "blocked" is not one of the values this repo's beads store: it is DERIVED from
/// dependency edges at query time. The row does expose `dependency_count`, and reading blocked off
/// that would be wrong in the direction that matters — a bead whose dependencies are all CLOSED has
/// a non-zero count and is perfectly ready. A lane that lies is worse than no lane, so the board
/// asks bd the question bd can actually answer.
///
/// NEVER FATAL. A bd too old to know `blocked`, or any other failure, yields an empty list rather
/// than an error: the Blocked lane going quiet is a far better failure than the whole board
/// refusing to load because one derived column could not be computed. The caller runs this
/// CONCURRENTLY with `list_beads` (see beadsStore.refresh) so the 5s poll pays one wall-clock cost,
/// not two — that hot path is the one the perf work in this module targets.
#[tauri::command]
pub async fn blocked_beads(project_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match run_bd(&project_path, &["blocked", "--json"]) {
            Ok(output) if output.success => {
                let stdout = output.stdout.trim();
                Ok(if stdout.is_empty() { "[]".to_string() } else { stdout.to_string() })
            }
            // Non-zero exit or a spawn failure: degrade to "nothing is blocked".
            _ => Ok("[]".to_string()),
        }
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Ensure `project_path` has a beads database, creating one with `bd init` if none resolves yet.
/// Idempotent and safe to call on every board open: it first probes `bd where` (which honors
/// BEADS_DIR / parent-directory / redirect resolution, so a project that legitimately inherits a
/// parent's beads workspace is left untouched) and only runs `bd init` when NO workspace resolves.
/// `--non-interactive` avoids any prompt in the GUI-spawned (TTY-less) shell; `--quiet` keeps
/// stdout clean; the issue prefix defaults to the project directory name. Execs bd DIRECTLY
/// (resolved absolute path, no login shell — see the module note). Returns "exists" when a DB
/// already resolved, "initialized" after a fresh `bd init`, and Err(..) only when `bd init` itself
/// failed — a probe (`bd where`) failure is treated as "needs init", never fatal.
#[tauri::command]
pub async fn ensure_beads_db(project_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Probe: does bd already resolve a workspace here (own DB, a parent's, or a redirect)?
        // `bd where` exits 0 when one resolves, non-zero when none does.
        let probe = run_bd(&project_path, &["where"])?;
        if probe.success {
            return Ok("exists".to_string());
        }

        // No workspace resolved — create one in the project root.
        let init = run_bd(&project_path, &["init", "--non-interactive", "--quiet"])?;
        if init.success {
            return Ok("initialized".to_string());
        }
        let stderr = init.stderr.trim().to_string();
        let stdout = init.stdout.trim().to_string();
        Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "bd init failed".to_string()
        })
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Show a single bead via `bd show <id> --json`. Returns bd's raw JSON stdout. `id` is validated
/// (can't be flag-like) and passed as a real argv token, never interpolated into a script.
#[tauri::command]
pub async fn bead_show(project_path: String, id: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_bd(&project_path, &["show", &id, "--json"])?;
        select_bd_raw(output.success, output.stdout.trim(), output.stderr.trim())
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Assemble the `bd create …` argv (the tokens AFTER `bd`). Every value (title, body, type,
/// parent, deps, labels) is a distinct argv token — NEVER interpolated into a shell string — so it
/// is injection-safe, matching `create_bead`. Optional flags (`--parent`/`--deps`/`-l`) and their
/// values are appended ONLY when non-empty. Empty `issue_type` defaults to "task". Pure (no I/O) so
/// the assembly is unit-testable without invoking bd. The cwd is set by `run_bd` (`.current_dir`),
/// so — unlike the old shell form — the project path is not part of the argv.
fn build_create_bead_args(
    title: &str,
    body: &str,
    issue_type: &str,
    parent: &str,
    deps: &str,
    labels: &str,
) -> Vec<String> {
    let issue_type = if issue_type.trim().is_empty() { "task" } else { issue_type };
    let mut args: Vec<String> = vec![
        "create".to_string(),
        // `--title=<t>`, never the positional slot — see `create_bead_inner` for why bd's parser
        // cannot tell a `-`-leading positional operand from a flag.
        format!("--title={}", title.trim()),
        "-d".to_string(),
        body.to_string(),
        "-t".to_string(),
        issue_type.to_string(),
    ];
    if !parent.trim().is_empty() {
        args.push("--parent".to_string());
        args.push(parent.to_string());
    }
    if !deps.trim().is_empty() {
        args.push("--deps".to_string());
        args.push(deps.to_string());
    }
    if !labels.trim().is_empty() {
        args.push("-l".to_string());
        args.push(labels.to_string());
    }
    args.push("--json".to_string());
    args
}

/// Create a fully-specified bead: title + body, with an issue type (default "task") and optional
/// parent, dependencies, and labels. See `build_create_bead_args` for the injection-safe arg
/// assembly. Returns bd's `--json` payload via `select_bd_result` (id on success, `{"error":…}`
/// on a caught bd error).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_bead_full(
    project_path: String,
    title: String,
    body: String,
    issue_type: String,
    parent: String,
    deps: String,
    labels: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_bead_full_inner(
            &project_path,
            &title,
            &body,
            &issue_type,
            &parent,
            &deps,
            &labels,
            beads_cmd::NO_EXTRA_ENV,
        )
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Sync core of [`create_bead_full`]. See [`create_bead_inner`] for why `env` is the seam.
///
/// This is the path `buildAgentSpawn.ts` and `tasks.ts::createChildTasks` reach, which is exactly
/// why the fold's skip list matters more here than anywhere: those callers pass `sparkle-auto` and
/// a non-empty `parent` respectively, and both are refused a scan outright.
#[allow(clippy::too_many_arguments)]
fn create_bead_full_inner(
    project_path: &str,
    title: &str,
    body: &str,
    issue_type: &str,
    parent: &str,
    deps: &str,
    labels: &str,
    env: beads_cmd::ChildEnv<'_>,
) -> Result<String, String> {
    if let Some(row) =
        crate::bead_dup::fold_or_create(project_path, title, body, labels, issue_type, parent, env)
    {
        return Ok(row.to_string());
    }
    let args = build_create_bead_args(title, body, issue_type, parent, deps, labels);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_bd_env(project_path, &arg_refs, env)?;
    select_bd_result(output.success, output.stdout.trim(), output.stderr.trim())
}

/// Add a dependency: `bd dep add <blocked> <blocker>` — `blocked_id` depends on (is blocked by)
/// `blocker_id`. Both ids are validated (can't be flag-like) and passed as real argv tokens.
#[tauri::command]
pub async fn bead_dep_add(
    project_path: String,
    blocked_id: String,
    blocker_id: String,
) -> Result<String, String> {
    if !valid_bead_id(&blocked_id) {
        return Err(format!("invalid bead id: {blocked_id}"));
    }
    if !valid_bead_id(&blocker_id) {
        return Err(format!("invalid bead id: {blocker_id}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_bd(&project_path, &["dep", "add", &blocked_id, &blocker_id])?;
        select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Claim a bead — mark it in_progress. `bd update <id> --claim`. Idempotent server-side, so the
/// app can fire it on every entry into a "building" stage without churn.
/// Sync core of [`bead_claim`]; a plain fn so the async command offloads it via `spawn_blocking`
/// and the tests can drive the id-validation guard directly.
fn bead_claim_inner(project_path: String, id: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    let output = run_bd(&project_path, &["update", &id, "--claim"])?;
    select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
}

#[tauri::command]
pub async fn bead_claim(project_path: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bead_claim_inner(project_path, id))
        .await
        .map_err(|e| format!("bd task failed: {e}"))?
}

/// Assemble the argv for an unclaim. Pure, so the STATUS *and the assignee* the release actually
/// writes are both assertable without bd — the id guard alone proves only that a bad id is refused,
/// never that either half of the claim is undone.
///
/// `update … -s open` rather than an invented `bd unclaim` subcommand: that is the flag shape
/// `beads_cmd::build_update_args` already uses for STATUS, and the one its round-trip test covers.
///
/// ⚠️ THAT PRECEDENT COVERS ONLY THE FIRST HALF. `build_update_args` filters an EMPTY value out
/// entirely (`.filter(|s| !s.is_empty())`), so it has never sent `-a ""` to bd and cannot be cited
/// for it — the two assemblies deliberately disagree here. The convention being followed for the
/// empty value is `build_close_args`' `--reason ""` handling and bd's own documented
/// empty-string-clears flags (`--parent`, `--defer`, `--due`). Confirmed against bd directly on a
/// throwaway ephemeral wisp: `-s open -a ""` clears the Assignee line and moves the status in one
/// update. The argv test below asserts what we ASSEMBLE, not what bd does with it.
///
/// ══ `-a ""` IS THE OTHER HALF OF THE CLAIM, NOT A FLOURISH ═════════════════════════════════════
/// `bd update <id> --claim` is documented by bd itself as *"sets assignee to you, status to
/// in_progress"* — TWO writes. A release that set only the status left the bead back in the backlog
/// STILL ASSIGNED to an orchestrator that was never created, and that assignee is an advisory lease:
/// `docs/superpowers/specs/2026-07-16-beads-worktree-safety-design.md` has bd refusing a competing
/// claim against it (exit 1). So a failed dispatch would have handed the epic back to the board as
/// startable while quietly holding a lease nothing would ever release, and the next actor to claim
/// it — a worker on another machine — would be refused by a ghost.
///
/// Verified against bd directly before it was written: `-a ""` clears the Assignee line while
/// `-s open` moves the status, in one update. (`--parent`/`--defer`/`--due` document the same
/// empty-string-clears convention.) The `Owner` field is bd's CREATOR and is deliberately untouched:
/// `--claim` never wrote it, so undoing the claim must not either.
fn bead_unclaim_args(id: &str) -> [String; 6] {
    [
        "update".into(),
        id.to_string(),
        "-s".into(),
        "open".into(),
        "-a".into(),
        String::new(),
    ]
}

/// Release a claim — move a bead from `in_progress` back to `open`. `bd update <id> -s open`.
///
/// THE MISSING EDGE. Every other status mutator in this module moves work FORWARD — claim, close,
/// delete — so once a bead was claimed there was no path back, and a claim that outlived the thing
/// it was claimed for was permanent. The board's handoff claims the epic BEFORE dispatching to the
/// orchestrator, and a dispatch that throws after the claim leaves the bead marked in progress with
/// no orchestrator bound; `sendToBuild`'s own preflight doc names that outcome verbatim and can only
/// ever be a preflight. This is what the frontend calls to undo it.
///
/// ══ IT WRITES TWO FIELDS, AND IT CLEARS RATHER THAN RESTORES ══════════════════════════════════
/// `--claim` sets a status AND an assignee, so undoing it must do both — a release that moved only
/// the status handed the bead back to the board as startable while still holding an advisory lease
/// (`docs/superpowers/specs/2026-07-16-beads-worktree-safety-design.md` has bd refusing a competing
/// claim against one). But the undo is a CLEAR, not a restore: it has no memory of who was assigned
/// before, so a bead a human had assigned to themselves before Build It was pressed comes back with
/// an EMPTY assignee, not their name. That is correct for the dispatch-failed path this exists for —
/// the claim being undone is the one this app just wrote — and it is why the function is named for
/// releasing a CLAIM rather than for setting a status. A caller that only wants to walk a status
/// back, without touching ownership, must not use this.
///
/// The `Owner` field (bd's creator) is untouched: `--claim` never wrote it.
///
/// Idempotent server-side, like `bead_claim`: setting an already-open bead to `open` is a no-op, so
/// a best-effort caller can fire it without first reading the status.
/// Sync core of [`bead_unclaim`]; a plain fn so the async command offloads it via `spawn_blocking`
/// and the tests can drive the id-validation guard directly.
fn bead_unclaim_inner(project_path: String, id: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    let args = bead_unclaim_args(&id);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_bd(&project_path, &arg_refs)?;
    select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
}

#[tauri::command]
pub async fn bead_unclaim(project_path: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bead_unclaim_inner(project_path, id))
        .await
        .map_err(|e| format!("bd task failed: {e}"))?
}

/// Close a bead (mark done). `bd close <id>`. Idempotent server-side.
#[tauri::command]
pub async fn bead_close(project_path: String, id: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_bd(&project_path, &["close", &id])?;
        select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Set a bead's priority: `bd update <id> -p <0-4>`.
///
/// THE MISSING HALF OF THE PRIORITY SEAM. Priority could not be set at filing time from anywhere in
/// the app, and it could not be changed afterwards either — the board's `update_item` reached only
/// status and labels — so a triage rubric had nothing to write through and every bead sat at bd's
/// default forever. `bd update -p` rather than the `bd priority` subcommand because that is the argv
/// shape `beads_cmd::build_update_args` already uses and the round-trip test already covers.
/// Sync core of [`bead_priority`]; a plain fn so the async command offloads it via `spawn_blocking`
/// and the tests can drive the id/range guards directly.
fn bead_priority_inner(project_path: String, id: String, priority: i64) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    let p = bd_priority_arg(priority)?;
    let output = run_bd(&project_path, &["update", &id, "-p", &p])?;
    select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
}

#[tauri::command]
pub async fn bead_priority(
    project_path: String,
    id: String,
    priority: i64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bead_priority_inner(project_path, id, priority))
        .await
        .map_err(|e| format!("bd task failed: {e}"))?
}

/// Add or remove a label on a bead: `bd label add|remove "$2" "$3"`. `action` is validated to be
/// exactly "add" or "remove"; id and label are positional args, never interpolated.
/// Sync core of [`bead_label`]; a plain fn so the async command offloads it via `spawn_blocking`
/// and the tests can drive the action/id validation guards directly.
fn bead_label_inner(
    project_path: String,
    action: String,
    id: String,
    label: String,
) -> Result<String, String> {
    if action != "add" && action != "remove" {
        return Err(format!("invalid label action: {action} (expected \"add\" or \"remove\")"));
    }
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    let output = run_bd(&project_path, &["label", &action, &id, &label])?;
    select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
}

#[tauri::command]
pub async fn bead_label(
    project_path: String,
    action: String,
    id: String,
    label: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bead_label_inner(project_path, action, id, label))
        .await
        .map_err(|e| format!("bd task failed: {e}"))?
}

/// Append a comment to a bead: `bd comment <id> -- <text>`.
///
/// The durable audit trail for machine-driven actions — the epic sweep's auto-restart records what
/// it restarted and why here, because a console log dies with the app session and a label can only
/// carry a timestamp. The store is shared by every worktree, so the note is readable from anywhere.
///
/// The text is passed POSITIONALLY after a `--` separator: `bd comment` takes `<id> [text...]` and
/// has NO `-m` flag (its shorthand is git's, not bd's — this is the sparkle-s8n643 trap). The `--`
/// stops flag parsing so a note that happens to begin with a dash is still a comment, not an option.
///
/// TWO GUARDS, both about the editor fallback. `bd comment` with no text can open an editor, and an
/// editor spawned from a Tauri command has no terminal attached, so it would sit there until the bd
/// timeout expires and report nothing useful:
///   1. A blank message is refused HERE, before spawning, so the common case never reaches bd.
///   2. `EDITOR=true` is pinned on the child, so any path that still reaches the fallback exits
///      immediately with bd's own "empty comment, aborting" rather than blocking.
/// The second is not redundant with the first: it also covers a future bd that decides some other
/// input is editor-worthy.
fn bead_comment_inner(project_path: String, id: String, text: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    if text.trim().is_empty() {
        return Err("refusing to write an empty bead comment".to_string());
    }
    let output = run_bd_env(&project_path, &["comment", &id, "--", &text], &[("EDITOR", "true")])?;
    select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
}

#[tauri::command]
pub async fn bead_comment(project_path: String, id: String, text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bead_comment_inner(project_path, id, text))
        .await
        .map_err(|e| format!("bd task failed: {e}"))?
}

/// A bead id is safe to pass as a positional operand only if it can't be mistaken for a flag. Even
/// though it's already an argv arg (not shell-interpolated), an id beginning with `-` would be parsed
/// by `bd` as an OPTION, not an issue id. Restrict to bd's id charset and forbid a leading dash.
pub(crate) fn valid_bead_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Permanently delete a bead via `bd delete <id> --force` — used by the close-agent Discard path.
/// Destructive and irreversible; the caller MUST gate it behind an explicit user confirmation. `id`
/// is validated (can't be flag-like) and passed as a real argv token, never interpolated.
/// Sync core of [`delete_bead`]; a plain fn so the async command offloads it via `spawn_blocking`
/// and the tests can drive the id-validation guard directly.
fn delete_bead_inner(project_path: String, id: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    let output = run_bd(&project_path, &["delete", &id, "--force"])?;
    select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
}

#[tauri::command]
pub async fn delete_bead(project_path: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || delete_bead_inner(project_path, id))
        .await
        .map_err(|e| format!("bd task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Concierge durable MEMORY — `bd remember` / `bd memories` / `bd forget`
// (PRD/sparkle/concierge-durable-memory-design.md, PR #1877; bead sparkle-jce9).
// ---------------------------------------------------------------------------
//
// The concierge is a `claude -p` per turn with NO Bash in its allowlist (concierge.rs), so it cannot
// run `bd` itself; these app-side commands are how its memory tool reaches the store. Unlike every
// OTHER bd command in this file, these do NOT take a project_path: concierge memory lives in ONE
// fixed store — the concierge's own app-data dir — so `recall` finds what `remember` wrote no matter
// which project a turn concerns, and a `remember` never files a row onto a user project's Tasks
// board. The dir is created and a beads DB initialized on first use; every call is bounded by
// `run_bd` (BD_TIMEOUT), so a wedged Dolt store surfaces as an error, never a hung turn.

/// The one stable directory the concierge's memory beads DB lives in — the same app-data `concierge`
/// dir the brain runs its turns in (concierge.rs). Resolved from the AppHandle so there is a single
/// source of truth for "where concierge state lives".
fn concierge_memory_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::worktree::app_data_dir_pub(app)?.join("concierge"))
}

/// Serializes `ensure_memory_db` across the whole process. `ensure_memory_db` is a check-then-act
/// (`bd where` then maybe `bd init`), and it is reachable CONCURRENTLY on first use: the mount effect
/// fires `refresh()` while a dispatch or a `remember` can fire another before the first `bd init`
/// returns. Without this, both probes see no DB and both run `bd init` in the same dir — one wins and
/// the other errors "already initialized", surfacing a spurious failure on first use. Contention is
/// only ever at first use (the `bd where` fast-path returns before this matters afterwards).
static MEMORY_INIT_LOCK: Mutex<()> = Mutex::new(());

/// Ensure the concierge memory dir exists and has a beads DB, creating both if needed. Idempotent
/// and cheap on the common path (a `bd where` probe short-circuits once a DB resolves). Mirrors
/// `ensure_beads_db`, but for the fixed concierge dir rather than a project the caller named, and
/// serialized behind {@link MEMORY_INIT_LOCK} so concurrent first-use callers init at most once.
fn ensure_memory_db(dir: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create concierge memory dir: {e}"))?;
    // Hold the lock across the whole check-then-act. A poisoned lock (a prior panic) must not wedge
    // memory forever, so recover the guard rather than propagating the poison.
    let _guard = MEMORY_INIT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // `bd where` exits 0 once any workspace resolves here; only init when none does.
    if run_bd(dir, &["where"])?.success {
        return Ok(());
    }
    let init = run_bd(dir, &["init", "--non-interactive", "--quiet"])?;
    if init.success {
        return Ok(());
    }
    let stderr = init.stderr.trim().to_string();
    Err(if stderr.is_empty() { "bd init failed".to_string() } else { stderr })
}

/// The `bd memories` argv for a recall, as owned tokens. Pure, so the flag-safety shape is unit-
/// testable without invoking bd. A blank query LISTS everything; a query with content SEARCHES,
/// passed after a `--` terminator so a hyphen-leading term (`-race`, `--json`) is treated as a
/// search string and not as a flag. `--json` must precede `--`, or it too becomes positional.
fn memory_recall_argv(query: Option<&str>) -> Vec<String> {
    let q = query.map(str::trim).unwrap_or("");
    if q.is_empty() {
        vec!["memories".into(), "--json".into()]
    } else {
        vec!["memories".into(), "--json".into(), "--".into(), q.into()]
    }
}

/// A memory key is a single argv token; reject empty, flag-like (leading `-`, which cobra would
/// parse as a flag), and control characters. The VALUE has no such restriction — it is passed after
/// a `--` terminator so it can be arbitrary prose, dashes and all.
fn valid_memory_key(key: &str) -> bool {
    !key.is_empty() && !key.starts_with('-') && !key.contains(|c: char| c.is_control())
}

/// Store one durable fact under `key`. `bd remember --key <key> -- <value>`: the `--` terminator lets
/// the value start with a dash without cobra reading it as a flag.
#[tauri::command]
pub async fn concierge_memory_remember(
    app: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<String, String> {
    if !valid_memory_key(&key) {
        return Err(format!("invalid memory key: {key}"));
    }
    if value.trim().is_empty() {
        return Err("refusing to remember an empty value".to_string());
    }
    let dir = concierge_memory_dir(&app)?.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_memory_db(&dir)?;
        let output = run_bd(&dir, &["remember", "--key", &key, "--", &value])?;
        select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Read memory as `bd memories [query] --json` (a key→value JSON map). A null/blank `query` lists
/// everything; a query filters. Returns bd's raw JSON stdout for the frontend to parse. An empty
/// store yields `{}` rather than an error — "no memories" is a valid answer, not a failure.
#[tauri::command]
pub async fn concierge_memory_recall(
    app: tauri::AppHandle,
    query: Option<String>,
) -> Result<String, String> {
    let dir = concierge_memory_dir(&app)?.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_memory_db(&dir)?;
        // A query that trims to empty LISTS; anything with content SEARCHES, passed after `--` so a
        // hyphen-leading search term is not misread as a flag. See `memory_recall_argv`.
        let argv = memory_recall_argv(query.as_deref());
        let arg_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let output = run_bd(&dir, &arg_refs)?;
        if output.success {
            let stdout = output.stdout.trim();
            Ok(if stdout.is_empty() { "{}".to_string() } else { stdout.to_string() })
        } else {
            let stderr = output.stderr.trim();
            Err(if stderr.is_empty() { "bd memories failed".to_string() } else { stderr.to_string() })
        }
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Drop one memory by key. `bd forget -- <key>` (the `--` keeps a stored key that begins with a dash
/// from being read as a flag, mirroring `remember`).
#[tauri::command]
pub async fn concierge_memory_forget(app: tauri::AppHandle, key: String) -> Result<String, String> {
    if !valid_memory_key(&key) {
        return Err(format!("invalid memory key: {key}"));
    }
    let dir = concierge_memory_dir(&app)?.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_memory_db(&dir)?;
        let output = run_bd(&dir, &["forget", "--", &key])?;
        select_bd_action(output.success, output.stdout.trim(), output.stderr.trim())
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_bead_id_forbids_flag_like_and_exotic_ids() {
        assert!(valid_bead_id(""));
        assert!(valid_bead_id("bd-1.2_x"));
        assert!(!valid_bead_id("")); // empty
        assert!(!valid_bead_id("-s")); // would be parsed by bd as a flag
        assert!(!valid_bead_id("--force"));
        assert!(!valid_bead_id("a b")); // space
        assert!(!valid_bead_id("a;b")); // metachar
        // The id-taking commands reject a flag-like id before shelling out.
        assert!(bead_claim_inner("/tmp".into(), "-s".into()).is_err());
        assert!(delete_bead_inner("/tmp".into(), "--force".into()).is_err());
    }

    #[test]
    fn unclaim_argv_sets_the_status_back_to_open() {
        // THE SIDE EFFECT, not the guard. The id check below proves only that a flag-like id is
        // refused — it stays green for an argv that writes any status at all, or none. This pins
        // the one thing the missing edge is FOR: the status moving back to `open`.
        // BOTH HALVES OF THE CLAIM. `--claim` writes a status AND an assignee, so asserting only
        // the status would stay green for a release that leaves an advisory lease behind on a bead
        // it just handed back to the board as startable.
        assert_eq!(
            bead_unclaim_args("sparkle-tsyh5u"),
            ["update", "sparkle-tsyh5u", "-s", "open", "-a", ""],
        );
        // ...and it is a WRITE, so a timeout gets the "may or may not have landed" copy rather
        // than a read's clean failure (roborev 59622's defect).
        let argv = bead_unclaim_args("sparkle-tsyh5u");
        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        assert!(bd_subcommand_mutates(&refs));
        // The id guard, same shape as `bead_claim_inner`'s above.
        assert!(bead_unclaim_inner("/tmp".into(), "-s".into()).is_err());
        assert!(bead_unclaim_inner("/tmp".into(), "".into()).is_err());
    }

    #[test]
    fn valid_memory_key_forbids_empty_and_flag_like() {
        assert!(valid_memory_key("test-fact"));
        assert!(valid_memory_key("account:storytell owns pr 1877"));
        assert!(!valid_memory_key("")); // empty
        assert!(!valid_memory_key("-k")); // cobra would read it as a flag
        assert!(!valid_memory_key("--key")); // ditto
        assert!(!valid_memory_key("a\nb")); // control char
    }

    #[test]
    fn bd_memories_is_classified_as_a_read_not_a_mutation() {
        // A recall that times out must NOT get the write-ambiguity "may or may not have landed" copy
        // (roborev 59622's defect, reintroduced for the new subcommand). `memories` reads.
        assert!(!bd_subcommand_mutates(&["memories", "--json"]));
        assert!(!bd_subcommand_mutates(&["memories", "--json", "--", "race"]));
        // `remember`/`forget` still classify as writes.
        assert!(bd_subcommand_mutates(&["remember", "--key", "k", "--", "v"]));
        assert!(bd_subcommand_mutates(&["forget", "--", "k"]));
    }

    #[test]
    fn memory_recall_argv_lists_when_blank_and_searches_after_dash_dash() {
        // Blank / whitespace / absent → list everything, no `--`.
        assert_eq!(memory_recall_argv(None), vec!["memories", "--json"]);
        assert_eq!(memory_recall_argv(Some("   ")), vec!["memories", "--json"]);
        // A real query goes AFTER `--`, so a hyphen-leading term is a search string, not a flag —
        // and `--json` precedes `--`, or bd would treat it as positional too.
        assert_eq!(
            memory_recall_argv(Some("-race")),
            vec!["memories", "--json", "--", "-race"],
        );
        assert_eq!(
            memory_recall_argv(Some("dolt")),
            vec!["memories", "--json", "--", "dolt"],
        );
    }

    #[test]
    fn append_note_creates_and_appends() {
        let dir = std::env::temp_dir().join(format!("sparkle_notes_{}", std::process::id()));
        // Start clean: a prior aborted run could leave a stale NOTES.md that breaks the count.
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        // A real project root is a git repo; `validate_project_root` requires a `.git` entry.
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let p = dir.to_string_lossy().to_string();

        append_note(p.clone(), "first".into(), "2026-06-24T00:00:00Z".into()).unwrap();
        append_note(p.clone(), "second".into(), "2026-06-24T00:01:00Z".into()).unwrap();

        let body = std::fs::read_to_string(Path::new(&p).join("NOTES.md")).unwrap();
        assert!(body.contains("## 2026-06-24T00:00:00Z"));
        assert!(body.contains("first"));
        assert!(body.contains("second"));
        // Two appends → two heading markers.
        assert_eq!(body.matches("## ").count(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn select_bd_result_prefers_json_stdout_even_on_nonzero_exit() {
        // bd exited non-zero but emitted its caught-error JSON on stdout AND a warning on stderr:
        // the JSON must win so the frontend can surface the structured `error` message.
        let r = select_bd_result(
            false,
            r#"{"error":"database not initialized"}"#,
            "warning: deprecated flag",
        );
        assert_eq!(r, Ok(r#"{"error":"database not initialized"}"#.to_string()));
    }

    #[test]
    fn select_bd_result_returns_json_on_success() {
        let r = select_bd_result(true, r#"{"id":"tt-4qs"}"#, "");
        assert_eq!(r, Ok(r#"{"id":"tt-4qs"}"#.to_string()));
    }

    #[test]
    fn select_bd_result_surfaces_stderr_when_stdout_is_not_json() {
        // Shell failure (missing `bd`, bad cd): non-JSON stdout, real stderr -> Err(stderr).
        let r = select_bd_result(false, "", "zsh: command not found: bd");
        assert_eq!(r, Err("zsh: command not found: bd".to_string()));
    }

    #[test]
    fn select_bd_result_errors_when_no_output() {
        assert_eq!(select_bd_result(true, "", ""), Err("bd produced no output".to_string()));
        assert_eq!(select_bd_result(false, "", ""), Err("bd produced no output".to_string()));
    }

    #[test]
    fn select_bd_raw_passes_through_json_array_on_success() {
        // `bd list --json` emits a JSON array (starts with '['), not '{' — it must pass through
        // verbatim rather than being treated as an error.
        let r = select_bd_raw(true, r#"[{"id":"sparkle-x"}]"#, "");
        assert_eq!(r, Ok(r#"[{"id":"sparkle-x"}]"#.to_string()));
    }

    #[test]
    fn select_bd_raw_surfaces_failure_and_empty() {
        assert_eq!(
            select_bd_raw(false, "", "zsh: command not found: bd"),
            Err("zsh: command not found: bd".to_string())
        );
        assert_eq!(select_bd_raw(true, "", ""), Err("bd produced no output".to_string()));
        // A caught bd error on failure (JSON on stdout) is passed through, not errored.
        assert_eq!(
            select_bd_raw(false, r#"{"error":"no such issue"}"#, ""),
            Ok(r#"{"error":"no such issue"}"#.to_string())
        );
    }

    #[test]
    fn select_bd_action_reports_ok_on_silent_success() {
        assert_eq!(select_bd_action(true, "", ""), Ok("ok".to_string()));
        assert_eq!(select_bd_action(true, "added dep", ""), Ok("added dep".to_string()));
        assert_eq!(
            select_bd_action(false, "", "no such issue"),
            Err("no such issue".to_string())
        );
    }

    #[test]
    fn write_prd_rejects_unsafe_filenames() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_reject_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();

        for bad in ["../escape.md", "sub/dir.md", "a\\b.md", "..", "/etc/passwd", ""] {
            let r = write_prd(p.clone(), bad.to_string(), "x".into());
            assert!(r.is_err(), "expected rejection for {bad:?}, got {r:?}");
        }
        // None of the rejected writes should have created a PRD dir/file outside intent.
        assert!(!dir.join("PRD").join("escape.md").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_prd_writes_and_returns_relative_path() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_write_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap(); // a real project root is a git repo
        let p = dir.to_string_lossy().to_string();

        let rel = write_prd(p.clone(), "branch.md".into(), "# hello\n".into()).unwrap();
        assert_eq!(rel, "PRD/branch.md");
        let written = std::fs::read_to_string(Path::new(&p).join("PRD").join("branch.md")).unwrap();
        assert_eq!(written, "# hello\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_prd_rejects_unsafe_filenames() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_read_reject_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("PRD")).unwrap();
        std::fs::write(dir.join("secret.txt"), "top secret").unwrap();
        let p = dir.to_string_lossy().to_string();

        // `C:secret.txt` is drive-relative on Windows: no separator, not absolute, yet
        // Path::join would replace the whole base path there. Reject it everywhere.
        for bad in ["../secret.txt", "sub/dir.md", "a\\b.md", "..", "/etc/passwd", "", "C:secret.txt"] {
            let r = read_prd(p.clone(), bad.to_string());
            let w = write_prd(p.clone(), bad.to_string(), "x".into());
            assert!(r.is_err(), "expected read rejection for {bad:?}, got {r:?}");
            assert!(w.is_err(), "expected write rejection for {bad:?}, got {w:?}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_prd_round_trips_a_written_prd() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_read_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap(); // a real project root is a git repo
        let p = dir.to_string_lossy().to_string();

        write_prd(p.clone(), "branch.md".into(), "# hello\n".into()).unwrap();
        assert_eq!(read_prd(p.clone(), "branch.md".into()).unwrap(), "# hello\n");
        // A missing file is an Err, not a panic.
        assert!(read_prd(p.clone(), "nope.md".into()).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn build_create_bead_args_minimal_uses_defaults() {
        // Empty type defaults to "task"; no optional flags appended. The project path is NOT in
        // the argv (run_bd sets cwd via .current_dir), and every value is a distinct argv token.
        let args = build_create_bead_args("My Title", "body text", "", "", "", "");
        assert_eq!(
            args,
            vec!["create", "--title=My Title", "-d", "body text", "-t", "task", "--json"]
        );
    }

    #[test]
    fn build_create_bead_args_all_fields_are_distinct_argv_tokens() {
        let args = build_create_bead_args(
            "Title",
            "Body",
            "bug",
            "sparkle-parent",
            "blocks:sparkle-x,sparkle-y",
            "ui,backend",
        );
        // Flags appended in order (parent, deps, labels); values are their own tokens, never inlined.
        assert_eq!(
            args,
            vec![
                "create",
                "--title=Title",
                "-d",
                "Body",
                "-t",
                "bug",
                "--parent",
                "sparkle-parent",
                "--deps",
                "blocks:sparkle-x,sparkle-y",
                "-l",
                "ui,backend",
                "--json",
            ]
        );
    }

    #[test]
    fn build_create_bead_args_skips_omitted_optionals() {
        // Only labels provided: parent/deps flags are absent, `-l docs` still appended.
        let args = build_create_bead_args("T", "B", "task", "", "", "docs");
        assert_eq!(
            args,
            vec!["create", "--title=T", "-d", "B", "-t", "task", "-l", "docs", "--json"]
        );
    }

    #[test]
    fn build_create_bead_args_never_inlines_hostile_values() {
        // A shell-injection payload as the title stays a single argv token (no shell parses it),
        // so it can never break out — the direct-exec equivalent of the old positional-arg scheme.
        let args = build_create_bead_args("'; rm -rf / #", "b", "", "", "", "");
        assert_eq!(args[0], "create");
        assert_eq!(args[1], "--title='; rm -rf / #");
        assert!(args.contains(&"--json".to_string()));
    }

    /// THE POSITIONAL-TITLE HAZARD, on the path that still had it.
    ///
    /// `bd` rejects a positional title beginning with `-` outright — a plain markdown bullet is
    /// enough — and its own error names `--title=` as the way to mean it. `beads_cmd` was already on
    /// the safe form; these two were not. Asserting the `=` FORM specifically matters: a
    /// separate-token `--title <t>` would still let a `-`-leading value be re-read as an option.
    #[test]
    fn both_notes_create_paths_bind_the_title_inside_one_argv_token() {
        let args = build_create_bead_args("- fix the thing", "b", "", "", "", "");
        assert_eq!(args[1], "--title=- fix the thing");
        assert!(
            !args.iter().any(|a| a == "--title"),
            "a separate-token --title still exposes a dash-leading value: {args:?}"
        );
    }

    #[test]
    fn bd_priority_arg_accepts_bds_range_and_refuses_anything_else() {
        for p in 0..=4 {
            assert_eq!(bd_priority_arg(p).unwrap(), p.to_string());
        }
        for p in [-1, 5, 99] {
            assert!(bd_priority_arg(p).is_err(), "priority {p} must be refused");
        }
    }

    #[test]
    fn bead_comment_refuses_an_empty_message() {
        // The whole reason this guard exists: `bd comment` with no text opens $EDITOR — and an
        // editor spawned from a Tauri command hangs until the bd timeout with nothing to show.
        // Refuse before spawning. Whitespace counts as empty.
        for blank in ["", "   ", "\n\t "] {
            let r = bead_comment_inner("/proj".into(), "sparkle-x".into(), blank.into());
            assert!(r.is_err(), "must refuse blank comment {blank:?}");
            assert!(
                r.unwrap_err().contains("empty"),
                "the error must name the reason so a caller can tell it from a bd failure"
            );
        }
    }

    #[test]
    fn bead_comment_rejects_an_id_that_could_be_read_as_a_flag() {
        let r = bead_comment_inner("/proj".into(), "--force".into(), "a real note".into());
        assert!(r.is_err(), "a dash-leading id must be refused, not passed to bd as an option");
    }

    #[test]
    fn bead_comment_is_classified_as_a_mutation() {
        // `comment` is not in BD_READ_SUBCOMMANDS, so a failure must be described as a write that
        // may have landed — which is what stops a caller blindly retrying it into a duplicate.
        assert!(bd_subcommand_mutates(&["comment", "sparkle-x", "--", "note"]));
    }

    #[test]
    fn bead_label_rejects_invalid_action() {
        let r = bead_label_inner("/proj".into(), "delete".into(), "sparkle-x".into(), "ui".into());
        assert!(r.is_err());
    }

    #[test]
    fn ensure_ignore_rule_appends_when_missing() {
        assert_eq!(ensure_ignore_rule(""), Some("PRD/assets/\n".into()));
        assert_eq!(
            ensure_ignore_rule("node_modules/\n.sparkle/\n"),
            Some("node_modules/\n.sparkle/\nPRD/assets/\n".into())
        );
        // Existing content missing its trailing newline gets one before the rule.
        assert_eq!(
            ensure_ignore_rule("node_modules/"),
            Some("node_modules/\nPRD/assets/\n".into())
        );
    }

    #[test]
    fn ensure_ignore_rule_is_idempotent() {
        assert_eq!(ensure_ignore_rule("PRD/assets/\n"), None);
        assert_eq!(ensure_ignore_rule("  PRD/assets/  \n"), None); // trimmed match
        assert_eq!(ensure_ignore_rule("PRD/assets\n"), None); // slashless variant counts
    }

    #[test]
    fn copy_capture_asset_rejects_traversal_and_copies_plus_ignores() {
        let dir = std::env::temp_dir().join(format!("sparkle_capasset_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap(); // a real project root is a git repo
        let proj = dir.to_string_lossy().to_string();
        let src = dir.join("shot.png");
        std::fs::write(&src, b"png-bytes").unwrap();
        let src_s = src.to_string_lossy().to_string();

        assert!(copy_capture_asset(proj.clone(), src_s.clone(), "../evil.png".into()).is_err());
        assert!(copy_capture_asset(proj.clone(), src_s.clone(), "a/b.png".into()).is_err());

        let rel = copy_capture_asset(proj.clone(), src_s, "t-capture.png".into()).unwrap();
        assert_eq!(rel, "PRD/assets/t-capture.png");
        assert_eq!(
            std::fs::read(dir.join("PRD/assets/t-capture.png")).unwrap(),
            b"png-bytes"
        );
        let ignore = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l.trim() == "PRD/assets/"));

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- SECURITY: project_path is constrained to a real project root -------------------------

    #[test]
    fn validate_project_root_accepts_a_git_repo_dir() {
        let dir = std::env::temp_dir().join(format!("sparkle_root_ok_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let real = validate_project_root(&dir.to_string_lossy()).unwrap();
        // Returns the CANONICAL root (symlinks/.. resolved) so callers join a real path.
        assert_eq!(real, std::fs::canonicalize(&dir).unwrap());
        // A `.git` FILE (linked worktree) counts too, not just a dir.
        let wt = std::env::temp_dir().join(format!("sparkle_root_wt_{}", std::process::id()));
        std::fs::remove_dir_all(&wt).ok();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: /somewhere/else\n").unwrap();
        assert!(validate_project_root(&wt.to_string_lossy()).is_ok());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&wt).ok();
    }

    #[test]
    fn validate_project_root_rejects_non_git_and_bad_paths() {
        // A real dir that is NOT a git repo (the ~/.ssh / ~/Library / /etc class the vuln let the
        // webview write into) must be rejected.
        let dir = std::env::temp_dir().join(format!("sparkle_root_bad_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        assert!(validate_project_root(&dir.to_string_lossy()).is_err());
        // Empty, relative, and non-existent paths are all rejected before any fs write.
        assert!(validate_project_root("").is_err());
        assert!(validate_project_root("relative/path").is_err());
        assert!(validate_project_root("/no/such/sparkle/dir/xyz").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_note_and_prd_reject_a_non_project_dir() {
        // End-to-end: the three fs-writing commands must refuse a directory that isn't a repo,
        // even with a perfectly valid basename — the crux of the security fix.
        let dir = std::env::temp_dir().join(format!("sparkle_np_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap(); // NOT a git repo
        let p = dir.to_string_lossy().to_string();
        assert!(append_note(p.clone(), "x".into(), "2026-01-01T00:00:00Z".into()).is_err());
        assert!(write_prd(p.clone(), "branch.md".into(), "x".into()).is_err());
        assert!(read_prd(p.clone(), "branch.md".into()).is_err());
        // Nothing was written into the non-project dir.
        assert!(!dir.join("NOTES.md").exists());
        assert!(!dir.join("PRD").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- PERF: bd path resolution + augmented PATH -------------------------------------------

    #[test]
    fn known_bd_paths_prioritizes_user_then_brew() {
        let paths = known_bd_paths_for(Some(PathBuf::from("/Users/x")));
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert_eq!(strs[0], "/Users/x/.local/bin/bd"); // user-local first
        assert!(strs.contains(&"/Users/x/go/bin/bd".to_string()));
        assert!(strs.contains(&"/Users/x/.cargo/bin/bd".to_string()));
        assert!(strs.contains(&"/opt/homebrew/bin/bd".to_string()));
        assert!(strs.contains(&"/usr/local/bin/bd".to_string()));
    }

    #[test]
    fn known_bd_paths_handles_no_home() {
        let paths = known_bd_paths_for(None);
        // No home → no ~/.local or ~/go entry, but the system locations are still present.
        assert!(paths.iter().any(|p| p.ends_with("opt/homebrew/bin/bd")));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains(".local")));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains("go/bin")));
    }

    // ── The login-shell probe is BOUNDED ────────────────────────────────────────────────────
    // These assert the SIDE EFFECT of the bound — that a hanging rc file is ABANDONED and the
    // caller gets control back — rather than that a fast shell resolves, which passed against the
    // unbounded `.output()` too and is why the hang survived this long. Drop the timeout and the
    // first of these does not fail, it HANGS, which is precisely the production symptom.

    #[cfg(unix)]
    #[test]
    fn a_hanging_login_shell_is_abandoned_at_the_bound() {
        let bound = Duration::from_secs(1);
        let started = Instant::now();
        // Prints a plausible answer, but only after far longer than any caller will wait. The sleep
        // dwarfs the bound so a slow machine cannot make this flaky in the direction of passing.
        let got = which_via_login_shell("/bin/sh", "sleep 60; echo /usr/local/bin/bd", bound);
        let waited = started.elapsed();
        assert_eq!(got, None, "an expired probe has no answer to give");
        assert!(
            waited < Duration::from_secs(30),
            "the probe must come back at its bound, not run to completion; waited {waited:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn giving_up_on_the_shell_still_leaves_the_known_paths_to_try() {
        // The bound is only affordable because abandoning the shell is not the end of resolution.
        // If this list were empty, timing out WOULD mean "no bd" and the bound would cost answers.
        let after = known_bd_paths_for(Some(PathBuf::from("/Users/x")));
        assert!(!after.is_empty(), "the fallback is what makes the bound cheap rather than lossy");
    }

    #[cfg(unix)]
    #[test]
    fn a_prompt_shell_answer_is_still_accepted() {
        // The paired case: the bound must not reject a shell that answers normally, or every probe
        // would "time out" and the fallback would be doing all the work unnoticed.
        let got = which_via_login_shell("/bin/sh", "echo /bin/sh", Duration::from_secs(5));
        assert_eq!(got.as_deref(), Some("/bin/sh"), "a fast, valid, executable answer survives");
    }

    #[cfg(unix)]
    #[test]
    fn a_relative_or_missing_answer_is_rejected() {
        // `command -v` can print a shell builtin or a relative name; neither is a path to spawn.
        assert_eq!(which_via_login_shell("/bin/sh", "echo bd", Duration::from_secs(5)), None);
        assert_eq!(
            which_via_login_shell("/bin/sh", "echo /nonexistent/bd", Duration::from_secs(5)),
            None
        );
    }

    // ── Negative-resolution cache (PERF) ────────────────────────────────────────────────────
    // These assert the DECISION `cached_bd_path` makes — "must I run the login-shell probe?" —
    // because that decision is the entire cost being saved. Asserting the cache merely holds a
    // timestamp would pass against the old positive-only cache too, and prove nothing.

    #[test]
    fn a_cached_hit_never_probes() {
        let cache = BdPathCache { hit: Some("/usr/local/bin/bd".into()), last_miss: None };
        assert!(!bd_cache_needs_probe(&cache, Instant::now(), BD_MISS_TTL));
    }

    #[test]
    fn a_cold_cache_probes() {
        let cache = BdPathCache::default();
        assert!(bd_cache_needs_probe(&cache, Instant::now(), BD_MISS_TTL));
    }

    #[test]
    fn a_fresh_miss_suppresses_the_probe() {
        // The regression this exists for: bd is not installed, the beads poll comes round again
        // 5s later, and we must NOT re-run `zsh -lc`. Under the old positive-hit-only cache this
        // call re-probed every single time.
        let now = Instant::now();
        let cache = BdPathCache { hit: None, last_miss: Some(now) };
        assert!(!bd_cache_needs_probe(&cache, now + Duration::from_secs(5), BD_MISS_TTL));
    }

    #[test]
    fn a_stale_miss_probes_again() {
        // The property the TTL preserves: a bd installed while the app runs is still picked up
        // without a restart, just not on every call.
        let now = Instant::now();
        let cache = BdPathCache { hit: None, last_miss: Some(now) };
        assert!(bd_cache_needs_probe(&cache, now + BD_MISS_TTL, BD_MISS_TTL));
        assert!(bd_cache_needs_probe(&cache, now + BD_MISS_TTL + Duration::from_secs(1), BD_MISS_TTL));
    }

    #[test]
    fn the_miss_ttl_is_short_enough_to_stay_unnoticeable() {
        // A miss that outlived a user's patience would trade one defect for another: they install
        // bd, come back to the app, and the board is still empty.
        assert!(BD_MISS_TTL <= Duration::from_secs(60), "a mid-session bd install must be picked up promptly");
        assert!(BD_MISS_TTL >= Duration::from_secs(10), "a TTL under the poll interval saves nothing");
    }

    #[test]
    fn cached_bd_path_is_stable_across_calls() {
        // The whole perf win is resolving bd ONCE; two calls must agree (whether or not bd is
        // installed on this machine — both None and Some(path) must be consistent).
        assert_eq!(cached_bd_path(), cached_bd_path());
    }

    #[test]
    fn bd_exec_path_includes_git_and_system_dirs() {
        // bd shells out to git, so its exec PATH must carry a plausible git dir + the system bins.
        let path = bd_exec_path();
        assert!(!path.is_empty());
        let segs: Vec<&str> = path.split(':').collect();
        assert!(segs.contains(&"/usr/bin"));
        assert!(segs.contains(&"/bin"));
        // Whatever git the resolver found, its directory is on the PATH we hand bd.
        if let Some(git) = crate::preflight::resolve_git_path_cached() {
            if let Some(dir) = Path::new(&git).parent() {
                assert!(
                    segs.contains(&dir.to_string_lossy().as_ref()),
                    "expected git dir {dir:?} on bd PATH; got {path}"
                );
            }
        }
        // Cached: a second call returns the identical string.
        assert_eq!(bd_exec_path(), path);
    }

    // ── The bd bound ──────────────────────────────────────────────────────────────────────────
    //
    // These guard the fix for `bridge request timeout: concierge_tool` on board writes: every bd
    // invocation in this module used to end in `.output()`, which waits forever, and bd BLOCKS
    // rather than failing when another worktree holds the Dolt lock.

    /// A directory that certainly exists, for the runner's project-root precondition. The bound is
    /// what is under test here, not `require_project_dir`.
    fn a_real_dir() -> String {
        std::env::temp_dir().to_string_lossy().to_string()
    }

    /// THE BOUND FIRES. Against the pre-fix `.output()` path this test does not fail, it HANGS —
    /// which is why it is asserted on a watchdog channel rather than inline: an unbounded call would
    /// never return and would take the whole test binary down with it, and a timed-out `recv` is a
    /// readable failure instead.
    ///
    /// Driven through `run_cmd_bounded` with an explicit program and an explicit 1s bound, exactly
    /// as `run_cmd_timed` is parameterised for: no bd needs to be installed, and no bd needs to be
    /// coaxed into wedging. The child sleeps 60s against a 1s bound, so a pass cannot come from the
    /// child finishing on its own.
    #[test]
    fn the_bd_bound_fires_instead_of_waiting_forever() {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let r = run_cmd_bounded(
                "/bin/sh",
                &a_real_dir(),
                &["-c", "sleep 60"],
                Duration::from_secs(1),
            );
            tx.send(r.map(|_| ())).ok();
        });
        let got = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("run_bd's runner never returned — the bd invocation is UNBOUNDED again");
        let err = got.expect_err("a 60s child under a 1s bound must not report success");

        // The duration in the message is the one that was actually applied, not a fixed string —
        // this is what makes the "30s" the production path advertises a true statement, since
        // `run_bd` passes `beads_cmd::BD_TIMEOUT` (pinned below and by the source guard).
        assert!(
            err.contains("within 1s") && err.contains("terminated"),
            "the message must say bd was killed, and after how long: {err}"
        );
        assert_eq!(beads_cmd::BD_TIMEOUT, Duration::from_secs(30), "the production bound is 30s");
    }

    /// NEGATIVE CONTROL. Without this, a runner that returned `Timeout` unconditionally would
    /// satisfy every "it did not hang" assertion above while destroying the entire feature — the
    /// board would answer "bd was killed" for every read and write on a perfectly healthy machine.
    #[test]
    fn a_healthy_command_still_returns_its_output_successfully() {
        let out = run_cmd_bounded(
            "/bin/sh",
            &a_real_dir(),
            &["-c", "printf 'bd-is-fine'"],
            Duration::from_secs(10),
        )
        .expect("a fast, healthy program must succeed under the bound");
        assert!(out.success, "a zero exit must be reported as success");
        assert_eq!(out.stdout.trim(), "bd-is-fine", "stdout must survive the bounded runner");
    }

    /// THE OUTCOME IS AMBIGUOUS, AND THE COPY MUST SAY SO. Nothing cancels bd when we stop waiting:
    /// the transport that gave up at 30s left the `bd create` running to completion, and now that we
    /// kill bd ourselves it may still have committed the row just before the kill. A message that
    /// reads like a clean "it failed" invites the wrong next action — and the wrong action here is
    /// specifically a retry, because `bd create` has no idempotency key and a retry after a create
    /// that landed files a SECOND bead.
    ///
    /// Pinned so a later edit cannot quietly shorten this back to a bare failure.
    #[test]
    fn a_timeout_is_reported_as_an_unknown_outcome_never_a_clean_failure() {
        let timed_out = BeadsError {
            kind: BeadsErrorKind::Timeout,
            message: "bd did not finish within 30s and was terminated".to_string(),
            exit_code: None,
        };
        let msg = describe_bd_failure(&timed_out, true);
        assert!(msg.contains("30s") && msg.contains("terminated"), "must name the bound: {msg}");
        assert!(msg.contains("UNKNOWN"), "must say the outcome is unknown: {msg}");
        assert!(
            msg.contains("may or may not have been created"),
            "must say the write may have landed anyway: {msg}"
        );
        assert!(msg.contains("Check the board"), "must tell the caller how to find out: {msg}");
        assert!(
            msg.contains("not idempotent"),
            "must say why a blind retry is wrong, not merely that it is: {msg}"
        );

        // NOT a blanket suffix: a genuine failure must stay a genuine failure, or the ambiguity
        // wording means nothing because every error carries it.
        let failed = BeadsError {
            kind: BeadsErrorKind::BdFailed,
            message: "issue not found: sparkle-nope".to_string(),
            exit_code: Some(1),
        };
        let msg = describe_bd_failure(&failed, true);
        assert_eq!(msg, "issue not found: sparkle-nope");
        assert!(!msg.contains("UNKNOWN"), "a definite failure must not be dressed up as ambiguous");
    }

    /// A READ that times out must not be handed the write-ambiguity copy (roborev 59622).
    ///
    /// `run_bd` is the single choke point for reads and writes alike, so the unconditional version
    /// told a timed-out `bd list` that "the item may or may not have been created" — about a call
    /// that created nothing — and warned it off the retry that is the correct next action. A remedy
    /// string is an instruction the reader follows, so pointing it away from the right remedy is the
    /// same defect class the ambiguity copy was written to fix.
    #[test]
    fn a_read_that_times_out_is_told_retrying_is_safe_not_to_check_the_board() {
        let timed_out = BeadsError {
            kind: BeadsErrorKind::Timeout,
            message: "bd did not finish within 30s and was terminated".to_string(),
            exit_code: None,
        };
        let msg = describe_bd_failure(&timed_out, false);
        assert!(msg.contains("retrying is safe"), "a read must be told to retry: {msg}");
        assert!(msg.contains("nothing was written"), "must say why it is safe: {msg}");
        // The write-only copy must be ABSENT, not merely accompanied — asserting only the presence
        // of the new sentence would pass on a message that said both and contradicted itself.
        assert!(!msg.contains("may or may not have been created"), "read got write copy: {msg}");
        assert!(!msg.contains("do not retry blindly"), "read told not to retry: {msg}");
    }

    /// A `StoreBusy` from the NEVER-SPAWNED producer (`queue_saturated`) is provably write-safe and
    /// must keep its own retry-safe message — NOT get dressed up as an ambiguous write.
    ///
    /// This pins the second half of the bounded-bd fix's correctness argument (roborev 67729): a
    /// permit-starvation error is `StoreBusy`/`exit_code: None`/`mutates: true`, and because it is
    /// not `Timeout`, `describe_bd_failure` passes its message through verbatim. The guard this test
    /// provides: adding a `StoreBusy` arm to `describe_bd_failure` that emits the ambiguous-write
    /// copy — a plausible, locally-correct-looking edit, since a real store-lock LOSS on a mutation
    /// *is* ambiguous — would re-attach "UNKNOWN … do not retry blindly" to a call that provably
    /// never ran, exactly the defect this fix removed. That edit reds this test.
    #[test]
    fn a_never_spawned_store_busy_mutation_keeps_its_write_safe_message() {
        // Derive the fixture from the REAL producer, not a hand-copied string, so this test and
        // production fail TOGETHER if queue_saturated's wording drifts (roborev 67773/67774).
        let saturated = crate::beads_cmd::queue_saturated(std::time::Duration::from_secs(30));
        assert_eq!(saturated.kind, BeadsErrorKind::StoreBusy, "producer contract: kind");
        assert!(saturated.exit_code.is_none(), "producer contract: never-spawned has no exit code");
        // Grip on PRODUCTION's copy (not describe_bd_failure's echo of it): the write-safe phrases
        // must actually be in what queue_saturated emits.
        assert!(
            saturated.message.contains("nothing was run and nothing was written"),
            "producer must state it was write-safe: {}",
            saturated.message
        );
        assert!(
            saturated.message.contains("retrying in a moment is safe"),
            "producer must state retry is safe: {}",
            saturated.message
        );
        let msg = describe_bd_failure(&saturated, true);
        // POSITIVE grip on the CONSUMER path (roborev 67795/67796): the write-safe remedy must
        // survive describe_bd_failure's pass-through, not just exist on the producer. A future
        // StoreBusy arm that REPLACES the message with copy dropping these phrases reds this.
        assert!(
            msg.contains("nothing was run and nothing was written"),
            "describe_bd_failure must pass the write-safe copy through: {msg}"
        );
        assert!(
            msg.contains("retrying in a moment is safe"),
            "describe_bd_failure must pass the retry-safe remedy through: {msg}"
        );
        // The ambiguous-write copy must be ABSENT — a never-spawned call did not "maybe land".
        assert!(!msg.contains("may or may not have been created"), "never-ran got write copy: {msg}");
        assert!(!msg.contains("UNKNOWN"), "never-ran told outcome is unknown: {msg}");
        assert!(!msg.contains("do not retry blindly"), "safe call told not to retry: {msg}");
    }

    /// The two Timeout variants are DIFFERENT outcomes, and conflating them overstates the doubt.
    ///
    /// `exit_code: Some(_)` is the drain path — bd EXITED with a status we read, and only its output
    /// pipe stayed open because a background `dolt sql-server` grandchild holds the write end. The
    /// operation ran to completion there; what was lost is the reply, not the write. Reporting that
    /// as "may or may not have been created" tells the caller to doubt something that happened.
    #[test]
    fn a_drained_pipe_timeout_says_the_write_most_likely_landed() {
        let drained = BeadsError {
            kind: BeadsErrorKind::Timeout,
            message: "bd exited but its output pipe stayed open".to_string(),
            exit_code: Some(0),
        };
        let msg = describe_bd_failure(&drained, true);
        assert!(msg.contains("most likely LANDED"), "must not overstate the doubt: {msg}");
        assert!(msg.contains("finished successfully"), "must say WHY it likely landed: {msg}");
        assert!(msg.contains("Verify"), "must still say to look before retrying: {msg}");
        assert!(
            !msg.contains("may or may not have been created"),
            "the kill-path copy must not be reused where the child demonstrably exited: {msg}"
        );
    }

    /// A drained pipe over a FAILING exit is the opposite claim, and getting it backwards is the
    /// costly direction (roborev 59629).
    ///
    /// The first version branched on the PRESENCE of an exit code rather than on SUCCESS, so a
    /// `bd create` that lost the store lock — exit 1 with a `dolt sql-server` grandchild still
    /// holding stdout, exactly this shape — was reported as "the change most likely LANDED". A
    /// caller following that instruction looks at a board showing nothing, concludes the item was
    /// already filed, and never re-files it. The bead is then lost precisely as in the incident this
    /// whole branch exists to fix.
    #[test]
    fn a_drained_pipe_over_a_failing_exit_says_the_write_most_likely_did_not_land() {
        let failed_drain = BeadsError {
            kind: BeadsErrorKind::Timeout,
            message: "bd exited but its output pipe stayed open".to_string(),
            exit_code: Some(1),
        };
        let msg = describe_bd_failure(&failed_drain, true);
        assert!(msg.contains("did NOT"), "a failing exit must not claim the write landed: {msg}");
        assert!(msg.contains("exit 1"), "must name the failing status: {msg}");
        // The success copy must be ABSENT, not merely accompanied — a message carrying both would
        // contradict itself and still pass a presence-only assertion.
        assert!(!msg.contains("most likely LANDED"), "success copy leaked onto a failure: {msg}");
        assert!(!msg.contains("finished successfully"), "claims success on exit 1: {msg}");
    }

    /// A drain-path timeout whose child died to a SIGNAL has `status.code() == None`, so it lands in
    /// the kill-path arm. That arm is still HONEST there — we genuinely do not know whether the row
    /// was committed — but the two halves of the sentence must not contradict each other, since
    /// `e.message` says bd exited while the suffix speaks to what is unknown (roborev 59629,
    /// secondary). Pinned rather than argued.
    #[test]
    fn a_signal_killed_drain_reads_coherently_rather_than_contradicting_itself() {
        let signalled = BeadsError {
            kind: BeadsErrorKind::Timeout,
            message: "bd exited but its output pipe stayed open".to_string(),
            exit_code: None,
        };
        let msg = describe_bd_failure(&signalled, true);
        assert!(msg.contains("UNKNOWN"), "an unreadable outcome must be called unknown: {msg}");
        // It must NOT assert the opposite of its own prefix in either direction.
        assert!(!msg.contains("most likely LANDED"), "cannot claim success it did not read: {msg}");
        assert!(!msg.contains("did NOT land"), "cannot claim failure it did not read: {msg}");
    }

    /// The read/write split is derived from the SUBCOMMAND, so pin the classification itself —
    /// otherwise the two tests above only prove `describe_bd_failure` branches, not that anything
    /// ever reaches it with the right flag.
    #[test]
    fn the_read_write_split_matches_the_subcommands_this_module_actually_sends() {
        for read in ["list", "show", "blocked", "where"] {
            assert!(!bd_subcommand_mutates(&[read, "--json"]), "`bd {read}` only reads");
        }
        // Every mutating subcommand this module issues, from the real call sites.
        for write in ["create", "update", "close", "label", "delete", "dep", "init"] {
            assert!(bd_subcommand_mutates(&[write, "x"]), "`bd {write}` mutates");
        }
        // UNKNOWN and EMPTY both default to "mutation" — the safe direction. Over-caution on a read
        // only costs a look; under-caution on a write invites the duplicate this all exists to stop.
        assert!(bd_subcommand_mutates(&["some-future-subcommand"]), "unknown must default to write");
        assert!(bd_subcommand_mutates(&[]), "empty argv must default to write");
    }

    /// Scan Rust source for `.output()` calls, returning `(allowed_resolver_probes, offenders)`.
    ///
    /// Extracted so the guard and its anti-vacuity test exercise the SAME code — a negative test
    /// that re-implements the loop can drift, and would then keep passing while the real guard rots.
    ///
    /// Comment lines are skipped: `run_bd`'s own doc comment quotes `.output()` when explaining the
    /// defect it fixed, and a real call is never on a comment line. Ownership is resolved by walking
    /// back to the nearest `fn` declaration, so the allowlist is by FUNCTION rather than by line
    /// number (which every later edit would invalidate).
    fn unbounded_output_calls_in(src: &str) -> (usize, Vec<String>) {
        // The bd RESOLVER probes. These run once per session to find out WHERE bd is; they are not
        // bd operations against the Dolt store, so they cannot be caught behind its lock.
        const ALLOWED_PROBES: [&str; 2] = ["login_shell_which_bd", "windows_which_bd"];

        /// Name of the function DECLARED on this line, if any.
        ///
        /// Visibility is stripped GENERICALLY rather than matched against a list of prefixes
        /// (roborev 59622). The list form accepted `pub ` but not `pub(crate) `, which this very
        /// file uses three times — so a `.output()` added inside a `pub(crate) fn` was not
        /// attributed to it. The scan then walked further back to the nearest RECOGNISED
        /// declaration, and if that happened to be one of the allow-listed resolver probes, the
        /// guard went green over a genuinely unbounded bd call: a hole in the shape of the very
        /// thing it exists to catch.
        fn declared_fn_name(line: &str) -> Option<String> {
            let mut rest = line.trim_start();
            // `pub`, `pub(crate)`, `pub(super)`, `pub(in path)` — strip the keyword and any group.
            if let Some(after) = rest.strip_prefix("pub") {
                rest = match after.strip_prefix('(') {
                    Some(group) => group[group.find(')')? + 1..].trim_start(),
                    None => after.trim_start(),
                };
            }
            // Modifiers that may precede `fn`, in any order.
            loop {
                let next = ["const ", "async ", "unsafe ", "extern "]
                    .iter()
                    .find_map(|m| rest.strip_prefix(m));
                match next {
                    Some(r) => rest = r.trim_start(),
                    None => break,
                }
            }
            // `extern "C" fn` leaves a quoted ABI behind.
            if let Some(after_quote) = rest.strip_prefix('"') {
                rest = after_quote[after_quote.find('"')? + 1..].trim_start();
            }
            let name = rest.strip_prefix("fn ")?.trim_start();
            let end = name.find(|c: char| !(c.is_alphanumeric() || c == '_'))?;
            Some(name[..end].to_string())
        }

        let lines: Vec<&str> = src.lines().collect();
        let mut probes = 0usize;
        let mut offenders = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if line.trim_start().starts_with("//") || !line.contains(".output()") {
                continue;
            }
            let owner = lines[..=i]
                .iter()
                .rev()
                .find_map(|l| declared_fn_name(l))
                .unwrap_or_else(|| "<unknown fn>".to_string());
            if ALLOWED_PROBES.contains(&owner.as_str()) {
                probes += 1;
            } else {
                offenders.push(format!("{owner} (line {})", i + 1));
            }
        }
        (probes, offenders)
    }

    /// The production half of this file, i.e. everything before its test module.
    ///
    /// The guard is about shipped code, and the tests below deliberately carry `.output()` inside
    /// sample fixtures. Returned with the split asserted so "the marker moved and we scanned
    /// nothing" cannot pass as "no offenders".
    fn production_source() -> &'static str {
        let src = include_str!("notes.rs");
        let cut = src.split("\n#[cfg(test)]").next().unwrap_or(src);
        assert!(
            cut.len() < src.len(),
            "could not find the test-module marker, so the scan region is wrong"
        );
        cut
    }

    /// NO bd INVOCATION HERE MAY BE UNBOUNDED. Asserted against this file's own SOURCE because the
    /// defect is the ABSENCE of a bound — invisible to every behavioural test on a healthy machine,
    /// and it was the actual shape of the bug (all 12 call sites went through one `.output()`).
    ///
    /// bd takes a lock on a Dolt store shared by every worktree in this repo, and `beadsStore.ts`
    /// polls `bd list`/`bd blocked` concurrently with writes, so under contention bd blocks instead
    /// of failing. Every timeout above this call is finite (30s MCP socket < 60s liveness stall <<
    /// 600s Rust rendezvous), so an unbounded call at the bottom hands the user a transport error
    /// while the real work stays wedged with nothing able to cancel it.
    /// ANTI-VACUITY IS ASSERTED AS A PROPERTY, NOT AS A COUNT OF UNBOUNDED SHAPES — and the
    /// difference is the whole reason this bead exists (sparkle-ozw542).
    ///
    /// The guard used to open with `assert!(probes >= 2)`, naming BOTH resolver probes. That floor
    /// was a membership count of the very shape the module is trying to eliminate, so it inverted
    /// the incentive: PR #2481 did the RIGHT thing — it bounded `login_shell_which_bd`, which was
    /// the actual bug — and this guard went red at it, reporting "the scanner matched nothing" when
    /// the scanner was working perfectly and one fewer unbounded call existed to find. The floor
    /// was then lowered to `>= 1`, which merely defers the identical failure to the day
    /// `windows_which_bd` is bounded too. A guard that reds on its own subject being FIXED is a
    /// guard people switch off rather than repair.
    ///
    /// So the canary is now the property the floor was a proxy for: *can this scanner still catch
    /// an unbounded bd call in THIS FILE'S REAL TEXT?* A regression is spliced onto the live scan
    /// region and must be flagged. That cannot go stale — it holds whether the file contains two
    /// unbounded probes, one, or none — and it is strictly stronger, because it exercises the real
    /// `production_source()` plumbing (`include_str!` + the `#[cfg(test)]` split) rather than a
    /// hand-written fixture that could drift from it.
    #[test]
    fn no_bd_invocation_in_this_module_is_unbounded() {
        let src = production_source();
        let (_probes, offenders) = unbounded_output_calls_in(src);
        assert!(
            offenders.is_empty(),
            "these run bd with an UNBOUNDED `.output()`, so a wedged bd hangs the caller forever \
             and surfaces as `bridge request timeout: concierge_tool`. Route them through \
             `run_bd` / `run_cmd_bounded` (beads_cmd::run_cmd_timed): {offenders:#?}"
        );

        // THE CANARY. Splice the offending shape onto the REAL scan region and require it to be
        // named. Green above therefore means "everything in this file is bounded"; it can no longer
        // mean "the scanner was handed the wrong text, or nothing at all".
        let seeded = format!(
            "{src}\nfn seeded_unbounded_bd_call(project_path: &str) -> Result<Output, String> {{\n\
             \x20   Command::new(&bd).args(args).current_dir(project_path).output()\n\
             }}\n"
        );
        let (_, seeded_offenders) = unbounded_output_calls_in(&seeded);
        assert!(
            seeded_offenders.iter().any(|o| o.starts_with("seeded_unbounded_bd_call")),
            "the scanner no longer detects an unbounded bd call in this file's OWN source, so the \
             assertion above proves nothing about it. Fix the scanner (or `production_source`'s \
             scan region) — do NOT re-add an unbounded probe to satisfy it. Found: \
             {seeded_offenders:#?}"
        );
    }

    /// The guard is only meaningful if its scanner can actually SEE an unbounded bd call. Feeds the
    /// REAL scanner the shape it must reject, so a green guard means "everything is bounded" rather
    /// than "matched nothing".
    #[test]
    fn the_bound_guard_would_notice_an_unbounded_bd_call() {
        // The pre-fix `run_bd`, plus a doc line quoting `.output()` — the comment must be ignored
        // and the call must still be caught, which is exactly the pair the real file contains.
        let regressed = "/// used to end in `.output()`, which waits FOREVER\n\
                         fn run_bd(project_path: &str) -> Result<Output, String> {\n\
                         \x20   Command::new(&bd).args(args).current_dir(project_path).output()\n\
                         }\n";
        let (probes, offenders) = unbounded_output_calls_in(regressed);
        assert_eq!(probes, 0, "a bd operation is not a resolver probe");
        assert_eq!(offenders.len(), 1, "scanner must flag the unbounded call: {offenders:?}");
        assert!(offenders[0].starts_with("run_bd"), "must name the offender: {offenders:?}");

        // …and it must NOT flag the resolver probe, or the guard could never go green and would be
        // switched off rather than fixed.
        let probe = "fn login_shell_which_bd() -> Option<String> {\n\
                     \x20   Command::new(shell).args([\"-lc\", \"command -v bd\"]).output().ok()\n\
                     }\n";
        let (probes, offenders) = unbounded_output_calls_in(probe);
        assert_eq!(probes, 1, "the resolver probe must be recognised as allowed");
        assert!(offenders.is_empty(), "the resolver probe must not be flagged: {offenders:?}");
    }

    /// THE HOLE THIS GUARD HAD, IN THE SHAPE OF THE THING IT EXISTS TO CATCH (roborev 59622).
    ///
    /// Ownership was matched against a list of prefixes that accepted `pub ` but not `pub(crate) `
    /// — a form used three times in this very file. An unbounded call inside such a function was
    /// therefore not attributed to it; the scan walked further back to the nearest RECOGNISED
    /// declaration, and when that was one of the allow-listed resolver probes the guard counted the
    /// offender as an allowed probe and went GREEN.
    ///
    /// The fixture reproduces exactly that adjacency: a `pub(crate) fn` placed AFTER an allow-listed
    /// probe, so the pre-fix parser would credit it to `windows_which_bd`. Asserting only "one
    /// offender" would not have caught it — the misattribution turns it into a probe, so the counts
    /// are what pin the bug.
    #[test]
    fn the_guard_attributes_a_call_inside_a_pub_crate_fn_to_that_fn() {
        let sneaky = "fn windows_which_bd() -> Option<String> {\n\
                      \x20   Command::new(\"where\").arg(\"bd\").output().ok()\n\
                      }\n\
                      pub(crate) fn wedged(project_path: &str) -> Result<Output, String> {\n\
                      \x20   Command::new(&bd).args(args).current_dir(project_path).output()\n\
                      }\n";
        let (probes, offenders) = unbounded_output_calls_in(sneaky);
        assert_eq!(probes, 1, "only the real resolver probe may count as one: {offenders:?}");
        assert_eq!(offenders.len(), 1, "the pub(crate) call must be flagged: {offenders:?}");
        assert!(
            offenders[0].starts_with("wedged"),
            "must name the pub(crate) fn itself, not the probe above it: {offenders:?}"
        );
    }

    /// The visibility/modifier stripping is now generic, so pin the forms it must handle. Without
    /// this, the fix above is only proven for the single shape that motivated it.
    #[test]
    fn the_guard_recognises_every_declaration_form_this_crate_uses() {
        let forms = [
            ("fn plain() {\n    x.output()\n}\n", "plain"),
            ("pub fn public() {\n    x.output()\n}\n", "public"),
            ("pub(crate) fn crate_vis() {\n    x.output()\n}\n", "crate_vis"),
            ("pub(super) fn super_vis() {\n    x.output()\n}\n", "super_vis"),
            ("async fn asyncy() {\n    x.output()\n}\n", "asyncy"),
            ("pub(crate) async fn both() {\n    x.output()\n}\n", "both"),
            ("pub unsafe fn unsafey() {\n    x.output()\n}\n", "unsafey"),
        ];
        for (src, expected) in forms {
            let (_, offenders) = unbounded_output_calls_in(src);
            assert_eq!(offenders.len(), 1, "{expected}: expected one offender, got {offenders:?}");
            assert!(
                offenders[0].starts_with(expected),
                "{expected}: misattributed to {offenders:?}"
            );
        }
    }

    /// The two surfaces that drive bd must share ONE budget. A second constant here would be a
    /// second policy, and the two would drift — which is the reason `BD_TIMEOUT` was widened to
    /// `pub(crate)` instead of being copied.
    /// Every bound `run_bd` actually passes to `run_cmd_bounded`, as raw argument-list text.
    ///
    /// EXTRACTED AS A PURE FUNCTION because the inline version had a real defect found in it on
    /// THREE consecutive review rounds — scope, then anchor, then comment-blindness — and each fix
    /// could only be validated by a hand mutation recorded in a commit message, which the next
    /// editor cannot re-run (roborev 59650). Straight-line code inside a test is unpinnable; a pure
    /// function fed fixture strings fails loudly when its parsing rules regress. This file already
    /// demonstrates the pattern with `unbounded_output_calls_in`, so this is adopting the local
    /// remedy rather than inventing one.
    ///
    /// Returns EVERY call's arguments, not the first. Binding only the first textual match is its
    /// own hole: a `run_bd` that grew an early-return path would have a second, unchecked call, and
    /// the guard would pass on the strength of the one that happened to come first.
    fn bd_bounds_passed_by_run_bd(src: &str) -> Result<Vec<String>, String> {
        bd_bounds_passed_by(src, "run_bd", "run_cmd_bounded(")
    }

    /// The same extraction, parameterized over WHICH funnel and WHICH bounded runner.
    ///
    /// Generalized when `run_bd_env` was added for `bd comment` (which needs `EDITOR=true` on the
    /// child so an empty `-m` cannot open an editor no terminal is attached to). A second funnel is
    /// exactly the shape this guard exists to police — an unbounded or self-declared timeout hiding
    /// beside the checked one — so it is covered by the same rule rather than exempted from it.
    ///
    /// The callee is passed WITH its open paren, which is what keeps `run_cmd_bounded(` from also
    /// matching `run_cmd_bounded_env(`.
    fn bd_bounds_passed_by(src: &str, fn_name: &str, callee: &str) -> Result<Vec<String>, String> {
        // Anchor on the SIGNATURE: `find` returns the first match, so a helper merely STARTING with
        // the name (`run_bd_json`) declared above the funnel would otherwise capture the slice.
        // A declaration at the very start of the input has no preceding newline, so match that case
        // too rather than requiring one. Anchoring on `\nfn` alone is a real limitation, not merely
        // a fixture quirk — it would silently report "no run_bd" for a file that opens with it.
        let sig = format!("fn {fn_name}(");
        let start = if src.starts_with(&sig) {
            0
        } else {
            src.find(&format!("\n{sig}")).ok_or("no matching fn declaration")? + 1
        };
        // Top-level fn bodies close on a column-0 brace (rustfmt guarantees it).
        let len = src[start..].find("\n}").ok_or("the funnel has no closing brace")? + 1;
        // Strip whole-line comments: otherwise a `//` line quoting the call form is what gets read,
        // while the real call underneath passes something else.
        let body: String = src[start..start + len]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");

        // BALANCE THE PARENS rather than stopping at the first `)`. A naive scan truncates
        // `Duration::from_secs(300)` to `Duration::from_secs(300`, which happens to still contain
        // the substring the caller greps for — so it works BY LUCK on today's text and silently
        // truncates before a later argument the moment any call nests a paren. Correct here is
        // cheap; relying on the accident is how the last three rounds of holes got in.
        let mut calls = Vec::new();
        let mut rest = body.as_str();
        while let Some(i) = rest.find(callee) {
            let after = &rest[i + callee.len()..];
            let mut depth = 1usize;
            let mut end = None;
            for (j, c) in after.char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = Some(j);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let end = end.ok_or("unterminated bounded-runner call")?;
            calls.push(after[..end].to_string());
            rest = &after[end..];
        }
        if calls.is_empty() {
            return Err("the funnel does not delegate to the bounded runner at all".to_string());
        }
        Ok(calls)
    }

    /// The extractor's PARSING RULES, pinned against fixtures — the coverage whose absence let three
    /// rounds of defects through (roborev 59650). Each case is one rule that regressed once.
    #[test]
    fn the_bd_bound_extractor_reads_the_real_call_and_nothing_else() {
        // A decoy declared ABOVE the funnel, carrying the CORRECT call, must not be read instead.
        // The decoy MUST be newline-preceded, or this case cannot fail on the rule it names
        // (roborev 59688). With `run_bd_json` at offset 0 there is no `\nfn run_bd_json(` in the
        // input at all, so mutating the anchor back to the bare prefix `\nfn run_bd` — the exact
        // 59636 regression this fixture exists to catch — still selects `run_bd` and the case stays
        // green. A leading line makes the decoy actually reachable by the buggy anchor, so the
        // assertion can fail. That is the "would this pass against the code as it was before?" test
        // this file's other guards exist to enforce, applied to itself.
        let decoy = "fn unrelated() {}\n\
                     fn run_bd_json(p: &str) -> R {\n\
                     \x20   run_cmd_bounded(&bd, p, args, beads_cmd::BD_TIMEOUT)\n\
                     }\n\
                     fn run_bd(p: &str) -> R {\n\
                     \x20   run_cmd_bounded(&bd, p, args, Duration::from_secs(300))\n\
                     }\n";
        let got = bd_bounds_passed_by_run_bd(decoy).expect("must find run_bd");
        assert_eq!(got.len(), 1, "must read exactly run_bd's call: {got:?}");
        assert!(got[0].contains("from_secs(300)"), "must read run_bd's own args: {got:?}");

        // A COMMENT quoting the correct call must not satisfy the check.
        let commented = "fn run_bd(p: &str) -> R {\n\
                         \x20   // delegates to run_cmd_bounded(&bd, p, args, beads_cmd::BD_TIMEOUT)\n\
                         \x20   run_cmd_bounded(&bd, p, args, Duration::from_secs(300))\n\
                         }\n";
        let got = bd_bounds_passed_by_run_bd(commented).expect("must find run_bd");
        assert_eq!(got.len(), 1, "the comment must be stripped, not counted: {got:?}");
        assert!(got[0].contains("from_secs(300)"), "must read the REAL call: {got:?}");

        // EVERY call is returned, so a second one on an early-return path cannot hide behind the
        // first. This is the finding the extraction was written alongside.
        let two = "fn run_bd(p: &str) -> R {\n\
                   \x20   if x { return run_cmd_bounded(&bd, p, args, beads_cmd::BD_TIMEOUT); }\n\
                   \x20   run_cmd_bounded(&bd, p, args, Duration::from_secs(300))\n\
                   }\n";
        let got = bd_bounds_passed_by_run_bd(two).expect("must find run_bd");
        assert_eq!(got.len(), 2, "both calls must be reported: {got:?}");

        // And it must FAIL LOUDLY rather than silently pass when its assumptions break.
        assert!(bd_bounds_passed_by_run_bd("fn other() {}\n").is_err(), "no run_bd => Err");
        assert!(
            bd_bounds_passed_by_run_bd("fn run_bd(p: &str) -> R {\n    todo!()\n}\n").is_err(),
            "run_bd that does not delegate => Err, never an empty pass"
        );
    }

    #[test]
    fn the_bd_timeout_constant_is_reused_not_redeclared() {
        let src = production_source();

        // The extractor above is fixture-pinned, so this reads the REAL binding rather than
        // re-deriving it inline. EVERY call must pass the shared constant — not merely the first.
        let calls = bd_bounds_passed_by_run_bd(src).expect("run_bd must delegate to the bounded runner");
        for call in &calls {
            assert!(
                call.contains("beads_cmd::BD_TIMEOUT"),
                "run_bd must PASS beads_cmd::BD_TIMEOUT, not merely mention it: args were `{call}`"
            );
            assert!(
                !call.contains("Duration::from_secs"),
                "run_bd must not inline its own duration — an inlined literal is not a `const` \
                 declaration, so the check below would never catch it: args were `{call}`"
            );
        }

        // ── THE SECOND FUNNEL IS HELD TO THE SAME RULE ──────────────────────────────────────
        // `run_bd_env` exists so `bd comment` can pin `EDITOR=true` on the child. It is a second
        // path to the same binary, which is precisely where an unbounded or hand-rolled timeout
        // would hide — so it is checked here rather than trusted for being small.
        let env_calls = bd_bounds_passed_by(src, "run_bd_env", "run_cmd_bounded_env(")
            .expect("run_bd_env must delegate to the bounded runner");
        for call in &env_calls {
            assert!(
                call.contains("beads_cmd::BD_TIMEOUT"),
                "run_bd_env must PASS beads_cmd::BD_TIMEOUT: args were `{call}`"
            );
            assert!(
                !call.contains("Duration::from_secs"),
                "run_bd_env must not inline its own duration: args were `{call}`"
            );
        }

        assert!(
            !src.contains("const BD_TIMEOUT"),
            "this module must not declare its own bd timeout — the two would drift apart"
        );
    }

    // ── THE BOARD'S CREATE PATHS, END TO END, AGAINST A REAL bd ──────────────────────────────
    //
    // These drive `create_bead_inner` / `create_bead_full_inner` — the PRODUCTION bodies the Tauri
    // commands delegate to — with a fake scanner supplied through the SAME `ChildEnv` the call
    // already carries. No defaulted `deps` parameter: the line that resolves the real scanner is
    // the line these exercise.
    //
    // The workspace harness is `beads_cmd`'s, reused rather than re-created: its two roborev guards
    // are easy to get subtly wrong twice, and an unguarded temp repo orphans review rows.

    #[cfg(unix)]
    fn scan_env<'a>(scanner: &'a str) -> Vec<(&'a str, &'a str)> {
        let mut v: Vec<(&str, &str)> = crate::beads_cmd::tests::TEST_GIT_ENV.to_vec();
        v.push((crate::bead_dup::SCANNER_ENV_VAR, scanner));
        v
    }

    /// The ids currently in the workspace, read straight from bd rather than through any code under
    /// test — so "no second bead was filed" is measured, not inferred.
    #[cfg(unix)]
    fn bead_ids(ws: &crate::beads_cmd::tests::TempWorkspace, bd: &str) -> Vec<String> {
        let out = ws.bd(bd, &["list", "--status", "all", "--json", "--limit", "0"]).expect("bd list");
        let v: serde_json::Value =
            serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Null);
        v.as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| r.get("id").and_then(|i| i.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[cfg(unix)]
    #[test]
    fn create_bead_inner_folds_onto_the_match_instead_of_filing_a_second_bead() {
        let Some(ws) = crate::beads_cmd::tests::TempWorkspace::new("notes-fold") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let Some(bd) = cached_bd_path() else { return };
        let path = ws.dir.to_string_lossy().to_string();
        let title = "The staleness hook fires once and never re-asks mid session";

        let first = create_bead_inner(&path, title, "first report", None, None, beads_cmd::NO_EXTRA_ENV)
            .expect("first create ran");
        let first_id = crate::bead_dup::tests::id_of(&first);
        let before = bead_ids(&ws, &bd);
        assert_eq!(before.len(), 1, "the first call must CREATE: {before:?}");

        let scanner = crate::bead_dup::write_fake_scanner(
            &ws.dir,
            "notes-fold.sh",
            10,
            &format!(r#"{{"id":"{first_id}","status":"open","title":"x"}}"#),
        );
        let env = scan_env(scanner.to_str().unwrap());
        let folded =
            create_bead_inner(&path, title, "the same thing, said differently", None, None, &env)
                .expect("second create ran");

        // (1) The caller was handed the EXISTING bead's row — same JSON shape `bd create` emits, so
        //     `parseCreatedBeadId` on the TS side reads it unchanged.
        assert_eq!(crate::bead_dup::tests::id_of(&folded), first_id);
        // (2) NO SECOND BEAD. False against the pre-change code, which always creates.
        assert_eq!(bead_ids(&ws, &bd), before, "a second bead was filed");
        // (3) The sighting was recorded, so the report is not simply dropped.
        let shown = ws.bd(&bd, &["show", &first_id, "--json", "--include-comments"]).expect("bd show");
        let text = String::from_utf8_lossy(&shown.stdout);
        assert!(text.contains("Duplicate folded by Sparkle"), "no fold comment on the match: {text}");
    }

    /// sparkle-s8n643: the epic audit-note writer must invoke `bd comment` with a flag bd actually
    /// defines. The pre-fix body passed `-m`, which bd (Go/Cobra) rejects with "unknown shorthand
    /// flag: 'm' in -m", so an epic restart silently failed to record what it restarted or why.
    /// This drives the PRODUCTION body against a REAL store and reads the note back — it goes RED on
    /// the `-m` form because the write never lands, and the `--` separator keeps a note that begins
    /// with a dash a comment rather than an option.
    #[cfg(unix)]
    #[test]
    fn bead_comment_inner_writes_the_note_to_the_store() {
        let Some(ws) = crate::beads_cmd::tests::TempWorkspace::new("notes-comment") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let Some(bd) = cached_bd_path() else { return };
        let path = ws.dir.to_string_lossy().to_string();

        let created =
            create_bead_inner(&path, "A bead the sweep will annotate", "body", None, None, beads_cmd::NO_EXTRA_ENV)
                .expect("create ran");
        let id = crate::bead_dup::tests::id_of(&created);

        // A realistic audit note, deliberately beginning with a dash to also exercise the `--` guard.
        let note = "-- advisor:reviewed — epic restarted by the sweep; model=x verdict=go";
        bead_comment_inner(path.clone(), id.clone(), note.to_string())
            .expect("bead_comment_inner must succeed with a flag bd defines");

        let shown =
            ws.bd(&bd, &["show", &id, "--json", "--include-comments"]).expect("bd show");
        let text = String::from_utf8_lossy(&shown.stdout);
        assert!(
            text.contains("advisor:reviewed — epic restarted by the sweep"),
            "the audit note was not written to the store: {text}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn create_bead_full_inner_never_folds_a_parented_child() {
        let Some(ws) = crate::beads_cmd::tests::TempWorkspace::new("notes-parent") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let Some(bd) = cached_bd_path() else { return };
        let path = ws.dir.to_string_lossy().to_string();

        // The epic the children hang off.
        let epic = create_bead_full_inner(
            &path,
            "Decompose the duplicate detection work into shippable pieces",
            "",
            "epic",
            "",
            "",
            "",
            beads_cmd::NO_EXTRA_ENV,
        )
        .expect("epic create ran");
        let epic_id = crate::bead_dup::tests::id_of(&epic);

        // A scanner rigged to call EVERYTHING a duplicate of the epic. Only the skip list can save
        // these; a score threshold never could, since decomposition siblings are near-identical.
        let scanner = crate::bead_dup::write_fake_scanner(
            &ws.dir,
            "notes-always-dup.sh",
            10,
            &format!(r#"{{"id":"{epic_id}","status":"open","title":"x"}}"#),
        );
        let env = scan_env(scanner.to_str().unwrap());

        let mut ids = Vec::new();
        for child in ["Wire the scanner resolution and its bounds", "Wire the priority seam through the board"] {
            let row = create_bead_full_inner(&path, child, "", "task", &epic_id, "", "", &env)
                .expect("child create ran");
            ids.push(crate::bead_dup::tests::id_of(&row));
        }
        assert_ne!(ids[0], ids[1], "two decomposition siblings collapsed onto one bead");
        assert!(!ids.contains(&epic_id), "a child was folded onto its own epic");
        assert_eq!(bead_ids(&ws, &bd).len(), 3, "every child must be filed in its own right");
    }

    #[cfg(unix)]
    #[test]
    fn a_priority_supplied_at_filing_time_reaches_the_bead() {
        let Some(ws) = crate::beads_cmd::tests::TempWorkspace::new("notes-priority") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let Some(bd) = cached_bd_path() else { return };
        let path = ws.dir.to_string_lossy().to_string();
        // Priority 0 specifically — bd's HIGHEST, and the value a truthiness test would drop.
        let row = create_bead_inner(
            &path,
            "A finding urgent enough to be filed at the top of the queue",
            "b",
            None,
            Some(0),
            beads_cmd::NO_EXTRA_ENV,
        )
        .expect("create ran");
        let id = crate::bead_dup::tests::id_of(&row);
        let shown = ws.bd(&bd, &["show", &id, "--json"]).expect("bd show");
        let v: serde_json::Value = serde_json::from_slice(&shown.stdout).expect("show json");
        let got = v.get("priority").or_else(|| v.get(0).and_then(|r| r.get("priority")));
        assert_eq!(got.and_then(|p| p.as_i64()), Some(0), "priority did not reach bd: {v}");

        // …and the update half: `bead_priority_inner` moves it afterwards.
        bead_priority_inner(path.clone(), id.clone(), 3).expect("bd update -p ran");
        let shown = ws.bd(&bd, &["show", &id, "--json"]).expect("bd show");
        let v: serde_json::Value = serde_json::from_slice(&shown.stdout).expect("show json");
        let got = v.get("priority").or_else(|| v.get(0).and_then(|r| r.get("priority")));
        assert_eq!(got.and_then(|p| p.as_i64()), Some(3), "priority was not updated: {v}");
    }

    #[cfg(unix)]
    #[test]
    fn a_dash_leading_title_survives_the_notes_create_path() {
        let Some(ws) = crate::beads_cmd::tests::TempWorkspace::new("notes-dash") else {
            eprintln!("SKIP: bd not installed or could not init a workspace");
            return;
        };
        let Some(bd) = cached_bd_path() else { return };
        let path = ws.dir.to_string_lossy().to_string();
        // bd REJECTS this in the positional slot, which is what this path used to use.
        let title = "- a bullet-leading title bd would reject positionally";
        let row = create_bead_inner(&path, title, "b", None, None, beads_cmd::NO_EXTRA_ENV)
            .expect("create ran");
        let id = crate::bead_dup::tests::id_of(&row);
        let shown = ws.bd(&bd, &["show", &id, "--json"]).expect("bd show");
        let v: serde_json::Value = serde_json::from_slice(&shown.stdout).expect("show json");
        let got = v.get("title").or_else(|| v.get(0).and_then(|r| r.get("title")));
        assert_eq!(got.and_then(|t| t.as_str()), Some(title));
    }
}

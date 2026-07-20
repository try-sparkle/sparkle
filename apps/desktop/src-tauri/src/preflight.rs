//! Preflight checks. Detects whether the user's own `claude` (Claude Code) is
//! installed, resolving it via the LOGIN shell — macOS GUI apps don't inherit the
//! shell PATH, so `claude` (installed via npm/homebrew) won't be found otherwise.
//!
//! The login-shell probe alone is not enough: `$SHELL -lc` is a login but
//! NON-interactive shell, and zsh sources `.zshrc` only for INTERACTIVE shells.
//! The official native installer puts `claude` at `~/.local/bin/claude` and adds
//! that dir to PATH in `.zshrc`, so a Finder/Dock-launched app never sees it. We
//! therefore fall back to checking the canonical absolute install locations.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

#[derive(Serialize)]
pub struct ClaudeStatus {
    installed: bool,
    /// Absolute path to the claude binary (pass this to pty_spawn to avoid PATH issues).
    path: Option<String>,
    version: Option<String>,
}

/// roborev install status, mirroring [`ClaudeStatus`]: the resolved absolute path plus, when it
/// resolves, `roborev --version`. Drives the roborev onboarding/consent surface.
#[derive(Serialize)]
pub struct RoborevStatus {
    installed: bool,
    /// Absolute path to the roborev binary.
    path: Option<String>,
    version: Option<String>,
}

#[cfg(unix)]
fn login_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

#[cfg(unix)]
fn run_in_login_shell(script: &str) -> Option<String> {
    Command::new(login_shell())
        .args(["-lc", script])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Run a login-shell script that references a runtime value as `"$1"`, passing `arg` as a real
/// argv parameter instead of interpolating it into the script string. We still need the login
/// shell (so `claude`'s `#!/usr/bin/env node` shebang resolves `node` off the user's PATH), but a
/// path that contains a quote/space/`;`/`$(…)` must NOT be able to break out of the command — a
/// quoted positional `"$1"` is substituted verbatim and never re-tokenized.
#[cfg(unix)]
fn run_in_login_shell_with_arg(script: &str, arg: &str) -> Option<String> {
    Command::new(login_shell())
        // The token after the script becomes $0; `arg` becomes $1.
        .args(["-lc", script, "sparkle-preflight", arg])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Windows: resolve a binary by name via `where`. Unlike macOS, a Windows GUI app inherits the
/// user's PATH, so there's no login-shell dance — `where` returns the same matches a terminal
/// would. Returns the first hit as an absolute path.
#[cfg(not(unix))]
fn resolve_on_path(bin: &str) -> Option<String> {
    Command::new("where")
        .arg(bin)
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

/// Windows home directory (`%USERPROFILE%`, falling back to `HOME` for MSYS/Git-Bash setups).
#[cfg(not(unix))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Canonical absolute locations the official installers use, in priority order.
/// Covers the native installer (`~/.local/bin`), the legacy local install
/// (`~/.claude/local`), and homebrew/npm global prefixes.
#[cfg(unix)]
fn known_claude_paths() -> Vec<PathBuf> {
    known_claude_paths_for(std::env::var_os("HOME").map(PathBuf::from))
}

/// Canonical absolute `node` locations, user-first. Mirrors `known_claude_paths_for`.
pub fn known_node_paths_for(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/node"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/node")); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin/node")); // homebrew (Intel) / npm
    paths
}

/// Resolve an absolute `node` path: prefer the login-shell `command -v node` (covers nvm/asdf and
/// any PATH the user set up), then fall back to the canonical install locations. Returns None if
/// node can't be found at all.
#[cfg(unix)]
pub fn resolve_node_path() -> Option<String> {
    run_in_login_shell("command -v node")
        .filter(|p| Path::new(p).is_absolute() && is_executable(Path::new(p)))
        .or_else(|| {
            first_executable(&known_node_paths_for(
                std::env::var_os("HOME").map(PathBuf::from),
            ))
        })
}

/// Windows: prefer `where node`, then the canonical install locations.
#[cfg(not(unix))]
pub fn resolve_node_path() -> Option<String> {
    resolve_on_path("node").or_else(|| first_executable(&known_node_paths_for(home_dir())))
}

// ---------------------------------------------------------------------------
// git detection
//
// git backs every worktree op (worktree.rs / sparkle_agent.rs / delivery.rs / github.rs), so a
// brand-new Mac with no git makes them all fail. Those call sites spawn git via `git_program()`
// (below), which resolves the ABSOLUTE path — a Finder/Dock-launched GUI app doesn't inherit the
// login-shell PATH, so a bare `Command::new("git")` could miss a user-scope git. We also detect git
// up front here so onboarding can offer to install it when it's genuinely absent.
//
// SUBTLETY (macOS): `/usr/bin/git` is a Command-Line-Tools *shim*. The file EXISTS even when the
// CLT are NOT installed — and *running* it then pops Apple's "install developer tools" dialog. So
// a plain `is_executable("/usr/bin/git")` check would report git as installed on a fresh Mac (and
// probing its version would trigger the very installer we're trying to drive from the UI). We
// therefore treat `/usr/bin/git` as the LAST candidate and only trust it when the CLT/Xcode are
// actually present — checked via `xcode-select -p`, which never triggers the installer.
// ---------------------------------------------------------------------------

/// The macOS Command-Line-Tools `git` shim. Present on every Mac; only a usable git once the CLT or
/// Xcode are installed (see the module note above). Kept last in [`known_git_paths_for`].
const SYSTEM_GIT_SHIM: &str = "/usr/bin/git";

/// Canonical absolute `git` locations, user-first: `~/.local/bin` (our own non-sudo installs and
/// nvm-style setups), homebrew prefixes, then the macOS system shim last.
pub fn known_git_paths_for(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/git"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/git")); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin/git")); // homebrew (Intel)
    paths.push(PathBuf::from(SYSTEM_GIT_SHIM)); // macOS CLT shim — trusted only when CLT present
    paths
}

/// True if the Xcode Command Line Tools (or full Xcode) are installed — i.e. `xcode-select -p`
/// resolves to a developer dir. Authoritative "is `/usr/bin/git` real?" signal on macOS, checked
/// WITHOUT running git so detection never triggers the CLT installer dialog.
#[cfg(all(unix, target_os = "macos"))]
fn command_line_tools_installed() -> bool {
    Command::new("xcode-select")
        .arg("-p")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// On non-macOS unix, `/usr/bin/git` (when present) is a genuine binary, so there's no shim caveat.
#[cfg(all(unix, not(target_os = "macos")))]
fn command_line_tools_installed() -> bool {
    true
}

/// Resolve an absolute `git` path. Prefer whatever the login shell resolves (covers a custom PATH),
/// then the canonical install locations — but NEVER report the bare macOS system shim as git unless
/// the Command Line Tools are actually installed (else running it triggers Apple's installer).
#[cfg(unix)]
pub fn resolve_git_path() -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    // A standalone git (login-shell PATH, brew, ~/.local) that isn't the system shim works
    // regardless of the CLT, so prefer it.
    if let Some(p) = run_in_login_shell("command -v git") {
        if p != SYSTEM_GIT_SHIM && Path::new(&p).is_absolute() && is_executable(Path::new(&p)) {
            return Some(p);
        }
    }
    let real_first: Vec<PathBuf> = known_git_paths_for(home)
        .into_iter()
        .filter(|p| p != Path::new(SYSTEM_GIT_SHIM))
        .collect();
    if let Some(p) = first_executable(&real_first) {
        return Some(p);
    }
    // Fall back to the system shim only when it's backed by a real git (CLT/Xcode present).
    let shim = PathBuf::from(SYSTEM_GIT_SHIM);
    if is_executable(&shim) && command_line_tools_installed() {
        return Some(SYSTEM_GIT_SHIM.to_string());
    }
    None
}

/// Windows: `where git` (GUI apps inherit PATH), then canonical install locations.
#[cfg(not(unix))]
pub fn resolve_git_path() -> Option<String> {
    resolve_on_path("git").or_else(|| first_executable(&known_git_paths_for(home_dir())))
}

// ---------------------------------------------------------------------------
// roborev detection
//
// roborev is the per-commit AI code-review daemon we ship to end-users. Like `claude`, it's a
// user-scope binary (installed to ~/.local/bin, brew, or npm-global prefixes) that a Finder/Dock-
// launched GUI app won't see on its bare PATH — so we resolve it the same way: a login-shell
// `command -v roborev`, then the canonical absolute install locations. Cached for the session with
// the same "only cache a positive hit" policy (a fresh install is picked up on the next probe).
// ---------------------------------------------------------------------------

/// Canonical absolute `roborev` locations, user-first: our own non-sudo install (`~/.local/bin`,
/// where `install_roborev` lands it), then homebrew prefixes. Pure form takes the home dir
/// explicitly so it can be unit-tested without mutating the process-global `HOME`.
pub fn known_roborev_paths_for(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/roborev")); // our installer / native install
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/roborev")); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin/roborev")); // homebrew (Intel) / npm
    paths
}

/// Resolve the absolute `roborev` path WITHOUT a version probe (login-shell PATH probe, then the
/// canonical absolute install locations). Unix form.
#[cfg(unix)]
fn resolve_roborev_uncached() -> Option<String> {
    run_in_login_shell("command -v roborev").or_else(|| {
        first_executable(&known_roborev_paths_for(std::env::var_os("HOME").map(PathBuf::from)))
    })
}

/// Windows form: `where roborev` (GUI apps inherit PATH), then canonical install paths.
#[cfg(not(unix))]
fn resolve_roborev_uncached() -> Option<String> {
    resolve_on_path("roborev").or_else(|| first_executable(&known_roborev_paths_for(home_dir())))
}

// ---------------------------------------------------------------------------
// Session-lifetime path caches
//
// Both `claude` and `node` are resolved by shelling out to a LOGIN shell (`command -v …`), which is
// slow on a cold node (hundreds of ms) — and their absolute paths effectively never change for the
// life of the app process. The spawn path used to re-resolve on every "new agent". We cache the
// resolved path once per session so only the first spawn pays.
//
// We cache ONLY a positive hit (`Some(path)` = cached, `None` = not yet resolved / re-probe). A
// "not installed" result is intentionally NOT cached, so a user who installs Claude Code (or Node)
// while the app is running is picked up on the next probe rather than being stuck on "not installed"
// for the session. Re-probing the miss is cheap and rare — a not-installed result routes to the
// no-claude screen, not a spawn. `invalidate_preflight_caches` additionally forces a re-probe of a
// cached hit (e.g. after a toolchain move/reinstall).
// ---------------------------------------------------------------------------

fn claude_path_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn node_path_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn git_path_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn roborev_path_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Resolve the absolute `claude` path WITHOUT the version probe (login-shell PATH probe, then the
/// canonical absolute install locations). Unix form.
#[cfg(unix)]
fn resolve_claude_uncached() -> Option<String> {
    run_in_login_shell("command -v claude").or_else(|| first_executable(&known_claude_paths()))
}

/// Windows form: `where claude` (GUI apps inherit PATH), then canonical install paths.
#[cfg(not(unix))]
fn resolve_claude_uncached() -> Option<String> {
    resolve_on_path("claude").or_else(|| first_executable(&known_claude_paths_for(home_dir())))
}

/// Resolved absolute `claude` path, cached for the app session. Only a positive hit is cached (a
/// miss re-probes next time — see the cache note above). Concurrent callers may both resolve on a
/// cold cache (idempotent); a poisoned lock falls back to an uncached resolve.
pub fn cached_claude_path() -> Option<String> {
    if let Ok(guard) = claude_path_cache().lock() {
        if let Some(path) = guard.as_ref() {
            return Some(path.clone());
        }
    }
    let resolved = resolve_claude_uncached();
    if let Some(path) = resolved.as_ref() {
        if let Ok(mut guard) = claude_path_cache().lock() {
            *guard = Some(path.clone());
        }
    }
    resolved
}

/// Resolved absolute `node` path, cached for the app session (resolution per [`resolve_node_path`]).
/// Only a positive hit is cached — see the cache note above.
pub fn resolve_node_path_cached() -> Option<String> {
    if let Ok(guard) = node_path_cache().lock() {
        if let Some(path) = guard.as_ref() {
            return Some(path.clone());
        }
    }
    let resolved = resolve_node_path();
    if let Some(path) = resolved.as_ref() {
        if let Ok(mut guard) = node_path_cache().lock() {
            *guard = Some(path.clone());
        }
    }
    resolved
}

/// Resolved absolute `git` path, cached for the app session (resolution per [`resolve_git_path`]).
/// Only a positive hit is cached — see the cache note above.
pub fn resolve_git_path_cached() -> Option<String> {
    if let Ok(guard) = git_path_cache().lock() {
        if let Some(path) = guard.as_ref() {
            return Some(path.clone());
        }
    }
    let resolved = resolve_git_path();
    if let Some(path) = resolved.as_ref() {
        if let Ok(mut guard) = git_path_cache().lock() {
            *guard = Some(path.clone());
        }
    }
    resolved
}

/// The `git` program to spawn for any internal git invocation: the cached resolved ABSOLUTE path,
/// or the bare name `"git"` as a last resort. A Finder/Dock-launched GUI app does NOT inherit the
/// login-shell PATH, so a bare `Command::new("git")` can fail to locate a user-scope git (Homebrew,
/// Xcode CLT) with "failed to run git" — which surfaces to the user as "Couldn't start this agent"
/// on an otherwise-healthy machine (a fresh external-user install is the common case). Routing every
/// git spawn through this keeps behavior identical where git is already on PATH (`resolve_git_path`
/// prefers exactly that) while healing the GUI-PATH gap. When git is genuinely absent, the bare-name
/// fallback errors the same way it does today and the ReadinessGate/prereq check surfaces the cause.
pub fn git_program() -> String {
    resolve_git_path_cached().unwrap_or_else(|| "git".to_string())
}

/// Resolved absolute `roborev` path, cached for the app session (resolution per
/// [`resolve_roborev_uncached`]). Only a positive hit is cached — see the cache note above — so a
/// just-installed roborev is picked up on the next probe. Concurrent callers may both resolve on a
/// cold cache (idempotent); a poisoned lock falls back to an uncached resolve.
pub fn cached_roborev_path() -> Option<String> {
    if let Ok(guard) = roborev_path_cache().lock() {
        if let Some(path) = guard.as_ref() {
            return Some(path.clone());
        }
    }
    let resolved = resolve_roborev_uncached();
    if let Some(path) = resolved.as_ref() {
        if let Ok(mut guard) = roborev_path_cache().lock() {
            *guard = Some(path.clone());
        }
    }
    resolved
}

/// Clear the cached claude/node/git/roborev paths so the next resolve re-probes (e.g. the user
/// moved/reinstalled a toolchain, or just finished an in-app install, while the app was running).
/// Note that a "not installed" result is never cached in the first place, so a fresh install is
/// already picked up without calling this.
pub fn invalidate_preflight_caches() {
    if let Ok(mut g) = claude_path_cache().lock() {
        *g = None;
    }
    if let Ok(mut g) = node_path_cache().lock() {
        *g = None;
    }
    if let Ok(mut g) = git_path_cache().lock() {
        *g = None;
    }
    if let Ok(mut g) = roborev_path_cache().lock() {
        *g = None;
    }
}

/// Pure form of [`known_claude_paths`]: takes the home dir explicitly so it can be
/// unit-tested without mutating the process-global `HOME` env var.
fn known_claude_paths_for(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/claude")); // native installer
        paths.push(home.join(".claude/local/claude")); // legacy local install
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/claude")); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin/claude")); // homebrew (Intel) / npm
    paths
}

/// True if `p` resolves to an existing, executable file (symlinks are followed).
#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Windows has no executable bit; treat any existing regular file as runnable. The candidate
/// lists are absolute install paths, and the primary resolver on Windows is `where` anyway.
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

/// Detect whether the user's own `claude` (Claude Code) is installed, resolving its absolute path
/// via the login shell (see module docs). The result is cached for the session and resolved OFF the
/// main thread so a cold-node login shell can't freeze the UI on the "new agent" hot path.
///
/// `version` is intentionally NOT populated here: resolving it cold-boots node purely to print a
/// string, and nothing on the spawn path reads it. Call [`claude_version`] lazily where a version is
/// actually needed (onboarding, diagnostics).
#[tauri::command]
pub async fn claude_preflight() -> ClaudeStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let path = cached_claude_path();
        ClaudeStatus { installed: path.is_some(), path, version: None }
    })
    .await
    .unwrap_or(ClaudeStatus { installed: false, path: None, version: None })
}

/// Resolve the installed Claude Code version string, LAZILY and off the main thread. Kept off the
/// spawn hot path because it cold-boots node just to print a version. Returns None when claude isn't
/// installed or the probe fails. Uses the cached path so it doesn't re-run the (slow) PATH probe.
#[cfg(unix)]
#[tauri::command]
pub async fn claude_version() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = cached_claude_path()?;
        // Pass the path as a positional `$1` (never interpolated) so a quoted/space-y path can't
        // break out of the command — same invariant the detection path relies on.
        run_in_login_shell_with_arg("\"$1\" --version", &path)
    })
    .await
    .ok()
    .flatten()
}

/// Windows: the version probe runs through `cmd /c` so a `claude.cmd`/`.bat` shim is invoked
/// correctly. Lazy + off the main thread, mirroring the Unix form.
#[cfg(not(unix))]
#[tauri::command]
pub async fn claude_version() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = cached_claude_path()?;
        Command::new("cmd")
            .args(["/c", &path, "--version"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    })
    .await
    .ok()
    .flatten()
}

/// Combined session probe for the spawn path. `has_session` (is there a resumable `claude`
/// conversation for this worktree?) and `latest_session_id` (its newest transcript stem) are
/// returned together in ONE IPC round-trip — and off the main thread. (The two underlying helpers
/// still each scan the transcript dir; the win here is collapsing two serial IPC commands into one,
/// not a shared directory scan.) Replaces the two separate SYNC commands (`claude_has_session` +
/// `claude_latest_session_id`) the spawn path used to await serially on the main thread.
/// Best-effort: a task failure yields the empty result, so the caller falls back to a fresh `claude`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionInfo {
    has_session: bool,
    latest_session_id: Option<String>,
}

#[tauri::command]
pub async fn claude_session_info(
    worktree_path: String,
    config_dir: Option<String>,
) -> ClaudeSessionInfo {
    tauri::async_runtime::spawn_blocking(move || {
        let latest = crate::claude::claude_latest_session_id_sync(
            &worktree_path,
            config_dir.as_deref(),
        );
        let has_session =
            crate::claude::claude_has_session_sync(&worktree_path, config_dir.as_deref());
        ClaudeSessionInfo { has_session, latest_session_id: latest }
    })
    .await
    .unwrap_or(ClaudeSessionInfo { has_session: false, latest_session_id: None })
}

/// Clear the cached claude/node paths (e.g. the user just installed Claude Code); the next preflight
/// re-probes. Exposed so onboarding/login flows can force a re-detect after an install.
#[tauri::command]
pub fn refresh_preflight() {
    invalidate_preflight_caches();
}

/// Generic install status for a runtime prerequisite (node/git). `installed` mirrors
/// `path.is_some()`; both are returned so the UI can show the resolved location.
#[derive(Serialize)]
pub struct PrereqStatus {
    pub installed: bool,
    pub path: Option<String>,
}

impl PrereqStatus {
    fn from_path(path: Option<String>) -> Self {
        PrereqStatus { installed: path.is_some(), path }
    }
}

/// Detect whether `node` is installed, resolving its absolute path off the main thread (cached for
/// the session). Drives the first-run setup checklist.
#[tauri::command]
pub async fn node_preflight() -> PrereqStatus {
    tauri::async_runtime::spawn_blocking(|| PrereqStatus::from_path(resolve_node_path_cached()))
        .await
        .unwrap_or(PrereqStatus { installed: false, path: None })
}

/// Detect whether `git` is installed, resolving its absolute path off the main thread (cached for
/// the session). On macOS this never triggers the CLT installer (see [`resolve_git_path`]).
#[tauri::command]
pub async fn git_preflight() -> PrereqStatus {
    tauri::async_runtime::spawn_blocking(|| PrereqStatus::from_path(resolve_git_path_cached()))
        .await
        .unwrap_or(PrereqStatus { installed: false, path: None })
}

/// Detect whether `roborev` (the per-commit AI code-review daemon) is installed, resolving its
/// absolute path off the main thread (cached for the session), together with `roborev --version`.
/// Mirrors [`claude_preflight`] but DOES populate the version — roborev is a native binary (no
/// node cold-boot), so probing its version is cheap. Returns None for version when the probe fails.
#[cfg(unix)]
#[tauri::command]
pub async fn roborev_preflight() -> RoborevStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let path = cached_roborev_path();
        let version = path
            .as_deref()
            // Pass the path as a positional `$1` (never interpolated) so a quoted/space-y path can't
            // break out of the command — same invariant claude_version relies on.
            .and_then(|p| run_in_login_shell_with_arg("\"$1\" --version", p));
        RoborevStatus { installed: path.is_some(), path, version }
    })
    .await
    .unwrap_or(RoborevStatus { installed: false, path: None, version: None })
}

/// Windows form: the version probe runs `roborev --version` directly (native binary, no shim shell).
#[cfg(not(unix))]
#[tauri::command]
pub async fn roborev_preflight() -> RoborevStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let path = cached_roborev_path();
        let version = path.as_deref().and_then(|p| {
            Command::new(p)
                .arg("--version")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        });
        RoborevStatus { installed: path.is_some(), path, version }
    })
    .await
    .unwrap_or(RoborevStatus { installed: false, path: None, version: None })
}

/// Combined first-run probe for the three runtime prerequisites (claude / node / git) in ONE IPC
/// round-trip, resolved off the main thread. Drives the setup checklist's initial detection pass.
#[derive(Serialize)]
pub struct PrereqsReport {
    pub claude: PrereqStatus,
    pub node: PrereqStatus,
    pub git: PrereqStatus,
}

#[tauri::command]
pub async fn prereqs_preflight() -> PrereqsReport {
    tauri::async_runtime::spawn_blocking(|| PrereqsReport {
        claude: PrereqStatus::from_path(cached_claude_path()),
        node: PrereqStatus::from_path(resolve_node_path_cached()),
        git: PrereqStatus::from_path(resolve_git_path_cached()),
    })
    .await
    .unwrap_or(PrereqsReport {
        claude: PrereqStatus { installed: false, path: None },
        node: PrereqStatus { installed: false, path: None },
        git: PrereqStatus { installed: false, path: None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_executable_finds_existing_skips_missing() {
        let candidates = vec![
            PathBuf::from("/nonexistent/claude"),
            PathBuf::from("/bin/sh"), // exists & executable on macOS/Linux
        ];
        assert_eq!(first_executable(&candidates), Some("/bin/sh".to_string()));
    }

    #[test]
    fn first_executable_none_when_all_missing() {
        let candidates = vec![
            PathBuf::from("/nope/a/claude"),
            PathBuf::from("/nope/b/claude"),
        ];
        assert_eq!(first_executable(&candidates), None);
    }

    #[test]
    fn first_executable_skips_non_executable_file() {
        // A regular, non-executable file must not count as the binary.
        assert_eq!(first_executable(&[PathBuf::from("/etc/hosts")]), None);
    }

    #[test]
    fn git_program_returns_a_runnable_git() {
        // Regression guard for the GUI-PATH fix: every internal git spawn goes through
        // `git_program()`, so whatever it returns MUST actually run git. Resolution prefers an
        // absolute path (login-shell/known locations) and falls back to the bare name; either way
        // `<git_program> --version` must succeed. If this breaks, build-agent spawn dies with
        // "Couldn't start this agent" on a fresh machine — the exact bug this closes.
        let prog = git_program();
        assert!(!prog.is_empty(), "git_program() must never be empty");
        let out = std::process::Command::new(&prog)
            .arg("--version")
            .output()
            .unwrap_or_else(|e| panic!("git_program() ({prog}) is not runnable: {e}"));
        assert!(out.status.success(), "`{prog} --version` failed");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.starts_with("git version"),
            "unexpected `{prog} --version` output: {stdout}"
        );
    }

    #[test]
    fn git_program_matches_resolver_when_it_resolves() {
        // When resolution succeeds, git_program() must return exactly that absolute path (not the
        // bare fallback) — otherwise the GUI-PATH gap isn't actually closed.
        if let Some(resolved) = resolve_git_path_cached() {
            assert_eq!(git_program(), resolved);
        }
    }

    #[test]
    fn known_paths_includes_native_installer_location() {
        // Regression guard: the native installer's ~/.local/bin/claude must be a
        // candidate even though its PATH entry lives in the interactive-only
        // .zshrc the login shell never sources.
        let paths = known_claude_paths_for(Some(PathBuf::from("/Users/test")));
        assert!(paths.contains(&PathBuf::from("/Users/test/.local/bin/claude")));
        assert!(paths.contains(&PathBuf::from("/Users/test/.claude/local/claude")));
    }

    #[test]
    fn known_node_paths_prioritizes_user_then_brew_then_usr_local() {
        let home = Some(std::path::PathBuf::from("/Users/x"));
        let paths = super::known_node_paths_for(home);
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert_eq!(strs[0], "/Users/x/.local/bin/node");
        assert!(strs.contains(&"/opt/homebrew/bin/node".to_string()));
        assert!(strs.contains(&"/usr/local/bin/node".to_string()));
    }

    #[test]
    fn known_roborev_paths_prioritizes_user_then_brew_then_usr_local() {
        let home = Some(std::path::PathBuf::from("/Users/x"));
        let paths = super::known_roborev_paths_for(home);
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        // Our installer's ~/.local/bin/roborev must be the first candidate.
        assert_eq!(strs[0], "/Users/x/.local/bin/roborev");
        assert!(strs.contains(&"/opt/homebrew/bin/roborev".to_string()));
        assert!(strs.contains(&"/usr/local/bin/roborev".to_string()));
    }

    #[test]
    fn known_roborev_paths_handles_no_home() {
        let paths = super::known_roborev_paths_for(None);
        // No home → no ~/.local entry, but the system locations are still present.
        assert!(paths.iter().any(|p| p.ends_with("opt/homebrew/bin/roborev")));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains(".local")));
    }

    #[test]
    fn known_node_paths_handles_no_home() {
        let paths = super::known_node_paths_for(None);
        // No home → no ~/.local entry, but the system locations are still present.
        assert!(paths.iter().any(|p| p.ends_with("opt/homebrew/bin/node")));
    }

    #[test]
    fn known_git_paths_prioritizes_user_then_brew_then_system_shim_last() {
        let paths = super::known_git_paths_for(Some(PathBuf::from("/Users/x")));
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        // User-local first.
        assert_eq!(strs[0], "/Users/x/.local/bin/git");
        // The macOS system shim MUST be last — it's the least-trusted candidate (see module note).
        assert_eq!(strs.last().unwrap(), super::SYSTEM_GIT_SHIM);
        assert!(strs.contains(&"/opt/homebrew/bin/git".to_string()));
        assert!(strs.contains(&"/usr/local/bin/git".to_string()));
    }

    #[test]
    fn known_git_paths_handles_no_home() {
        let paths = super::known_git_paths_for(None);
        // No home → no ~/.local entry, but the system locations (incl. the shim) are still present.
        assert!(paths.iter().any(|p| p.ends_with("opt/homebrew/bin/git")));
        assert_eq!(paths.last().unwrap(), &PathBuf::from(super::SYSTEM_GIT_SHIM));
        // Guard against the shim leaking in twice / a stray ~/.local entry with no home.
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains(".local")));
    }

    #[test]
    fn known_git_paths_first_executable_prefers_real_git_over_shim() {
        // With the shim filtered out (as resolve_git_path does), a real brew/local git wins. Here we
        // just assert the filter leaves the shim out and keeps the rest ordered.
        let filtered: Vec<PathBuf> = super::known_git_paths_for(Some(PathBuf::from("/Users/x")))
            .into_iter()
            .filter(|p| p != Path::new(super::SYSTEM_GIT_SHIM))
            .collect();
        assert!(!filtered.iter().any(|p| p == Path::new(super::SYSTEM_GIT_SHIM)));
        assert_eq!(filtered[0], PathBuf::from("/Users/x/.local/bin/git"));
    }

    // Exercises the Unix login-shell arg-passing path; the helper it calls is Unix-only.
    #[cfg(unix)]
    #[test]
    fn version_probe_passes_path_as_arg_not_shell_interpolation() {
        use std::os::unix::fs::PermissionsExt;
        // A binary whose path contains a single quote AND a space — the exact shape that broke
        // out of the old `format!("'{p}' --version")` interpolation. With "$1" arg-passing it must
        // execute correctly (proving no breakout and that the real binary ran).
        let dir = std::env::temp_dir().join(format!("sparkle-pf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("we'ird claude");
        std::fs::write(&bin, "#!/bin/sh\necho SPARKLE-MARKER-9\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let out = run_in_login_shell_with_arg("\"$1\" --version", bin.to_str().unwrap());
        // Contains (not equals): a dev/CI login profile may emit its own stdout noise.
        assert!(
            out.as_deref().map(|s| s.contains("SPARKLE-MARKER-9")).unwrap_or(false),
            "expected the quoted-path binary to run; got {out:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

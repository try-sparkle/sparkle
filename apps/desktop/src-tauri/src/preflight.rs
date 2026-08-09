//! Preflight checks. Detects whether the user's own `claude` (Claude Code) is
//! installed, resolving it via the LOGIN shell — macOS GUI apps don't inherit the
//! shell PATH, so `claude` (installed via npm/homebrew) won't be found otherwise.
//!
//! The login-shell probe alone is not enough: `$SHELL -lc` is a login but
//! NON-interactive shell, and zsh sources `.zshrc` only for INTERACTIVE shells.
//! The official native installer puts `claude` at `~/.local/bin/claude` and adds
//! that dir to PATH in `.zshrc`, so a Finder/Dock-launched app never sees it. We
//! therefore fall back to checking the canonical absolute install locations.

use std::collections::{BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

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

/// `pub(crate)` so sibling modules that must resolve a user-scope binary the same way (see
/// `onepassword::resolve_op_uncached`) reuse this rather than re-deriving the login-shell dance.
#[cfg(unix)]
pub(crate) fn run_in_login_shell(script: &str) -> Option<String> {
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
pub(crate) fn run_in_login_shell_with_arg(script: &str, arg: &str) -> Option<String> {
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
pub(crate) fn resolve_on_path(bin: &str) -> Option<String> {
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
pub(crate) fn home_dir() -> Option<PathBuf> {
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

/// Canonical absolute `npm` locations, user-first. Mirrors [`known_node_paths_for`] exactly — the
/// pinned Node tarball install symlinks `node`/`npm`/`npx` side by side into `~/.local/bin`, so npm
/// lives wherever node does.
pub fn known_npm_paths_for(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/npm"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/npm")); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin/npm")); // homebrew (Intel) / npm
    paths
}

/// Resolve an absolute `npm` path — the managed package manager the LSP installers drive. Same
/// two-step as [`resolve_node_path`]: login-shell `command -v npm` (covers nvm/asdf), then the
/// canonical install locations.
#[cfg(unix)]
pub fn resolve_npm_path() -> Option<String> {
    run_in_login_shell("command -v npm")
        .filter(|p| Path::new(p).is_absolute() && is_executable(Path::new(p)))
        .or_else(|| {
            first_executable(&known_npm_paths_for(
                std::env::var_os("HOME").map(PathBuf::from),
            ))
        })
}

/// Windows: prefer `where npm`, then the canonical install locations.
#[cfg(not(unix))]
pub fn resolve_npm_path() -> Option<String> {
    resolve_on_path("npm").or_else(|| first_executable(&known_npm_paths_for(home_dir())))
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
// gh detection
//
// The GitHub CLI backs every PR probe (worktree.rs: PR state for the workflow CTA, the open-PR
// count badge, the PR-list URL, and `gh pr create`). Those probes swallow a failed spawn as "no PR
// found" by design — so when a Finder/Dock-launched app (bare GUI PATH) can't see a homebrew gh,
// they don't error, they silently report no PR forever: the composer keeps offering "Open Pull
// Request" over a PR that's already open. Resolve gh like the other user-scope binaries: login-shell
// `command -v gh`, then the canonical absolute install locations.
// ---------------------------------------------------------------------------

/// Canonical absolute `gh` locations, user-first: `~/.local/bin` (manual tarball installs), then
/// homebrew prefixes. Pure form takes the home dir explicitly so it can be unit-tested without
/// mutating the process-global `HOME`.
pub fn known_gh_paths_for(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/gh"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/gh")); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin/gh")); // homebrew (Intel) / manual install
    paths
}

/// Resolve the absolute `gh` path (login-shell PATH probe, then the canonical absolute install
/// locations). Unix form.
#[cfg(unix)]
fn resolve_gh_uncached() -> Option<String> {
    run_in_login_shell("command -v gh").or_else(|| {
        first_executable(&known_gh_paths_for(std::env::var_os("HOME").map(PathBuf::from)))
    })
}

/// Windows form: `where gh` (GUI apps inherit PATH), then canonical install paths.
#[cfg(not(unix))]
fn resolve_gh_uncached() -> Option<String> {
    resolve_on_path("gh").or_else(|| first_executable(&known_gh_paths_for(home_dir())))
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

fn gh_path_cache() -> &'static Mutex<Option<String>> {
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

/// Resolved absolute `gh` path, cached for the app session (resolution per
/// [`resolve_gh_uncached`]). Only a positive hit is cached — see the cache note above — so a
/// just-installed gh is picked up on the next probe. Concurrent callers may both resolve on a
/// cold cache (idempotent); a poisoned lock falls back to an uncached resolve.
pub fn cached_gh_path() -> Option<String> {
    if let Ok(guard) = gh_path_cache().lock() {
        if let Some(path) = guard.as_ref() {
            return Some(path.clone());
        }
    }
    let resolved = resolve_gh_uncached();
    if let Some(path) = resolved.as_ref() {
        if let Ok(mut guard) = gh_path_cache().lock() {
            *guard = Some(path.clone());
        }
    }
    resolved
}

/// The `gh` program to spawn for any internal GitHub CLI invocation: the cached resolved ABSOLUTE
/// path, or the bare name `"gh"` as a last resort. Mirrors [`git_program`] and exists for the same
/// reason — a Finder/Dock-launched GUI app doesn't inherit the login-shell PATH, so a bare
/// `Command::new("gh")` misses a homebrew gh. Unlike git, a failed gh spawn is SWALLOWED by every
/// caller (the PR probes read it as "no PR"), which turned this PATH gap into a silent wrong answer
/// rather than an error: the workflow CTA stuck on "Open Pull Request" over an already-open PR.
pub fn gh_program() -> String {
    cached_gh_path().unwrap_or_else(|| "gh".to_string())
}

/// Clear the cached claude/node/git/roborev/gh paths so the next resolve re-probes (e.g. the user
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
    if let Ok(mut g) = gh_path_cache().lock() {
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
pub(crate) fn first_executable(candidates: &[PathBuf]) -> Option<String> {
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

impl ClaudeSessionInfo {
    /// Nothing found (also the best-effort result when the probe task dies).
    fn none() -> Self {
        ClaudeSessionInfo { has_session: false, latest_session_id: None }
    }

    fn from_probe((has_session, latest_session_id): (bool, Option<String>)) -> Self {
        ClaudeSessionInfo { has_session, latest_session_id }
    }
}

#[tauri::command]
pub async fn claude_session_info(
    worktree_path: String,
    config_dir: Option<String>,
) -> ClaudeSessionInfo {
    tauri::async_runtime::spawn_blocking(move || {
        ClaudeSessionInfo::from_probe(crate::claude::claude_session_info_sync(
            &worktree_path,
            config_dir.as_deref(),
        ))
    })
    .await
    .unwrap_or_else(|_| ClaudeSessionInfo::none())
}

/// The same probe, aimed at the CONCIERGE's conversation instead of an agent worktree's.
///
/// The concierge is not a worktree agent, which is the only reason this needs its own command: it
/// runs headless `claude -p` with its cwd set to Sparkle's app-data dir (`concierge.rs` →
/// `dev_identity::app_data_dir`), so Claude Code files its transcripts under THAT path's slug like
/// any other project. The frontend cannot name that dir — it is build-flavored (`-dev` in debug) and
/// Tauri-resolved — so the path is resolved here and handed to the identical scan. Restoring the
/// pointer at boot is what lets the concierge remember a conversation across an app restart; the
/// transcript itself was never the thing that was lost (see `docs/superpowers/specs/
/// 2026-07-27-concierge-control-design.md` §3, subsystem C).
///
/// `config_dir` IS the concierge's account, and it has to be, because the concierge spawn is now
/// account-aware: `concierge_turn` sets `CLAUDE_CONFIG_DIR` on its child from the selected account
/// (PRD/sparkle/account-rotation.md Phase 0), so the transcript lands under THAT account's tree.
/// A probe that ignored it would read `$HOME/.claude` and answer about a different account
/// entirely — finding nothing (an amnesiac concierge after every restart, which is the exact
/// symptom subsystem C exists to prevent) or, worse, finding a stale id from the default account
/// and seeding it, so the next turn spawns `--resume <foreign-id>`, fails, and burns a second
/// `claude` on the self-heal.
///
/// This argument therefore moves WITH the spawn, exactly as the worktree probe's does: pass the
/// same value `concierge_turn` was given. `None`/empty keeps the pre-accounts meaning — resolve
/// from Sparkle's own process env — which is also what a build with no accounts configured sends.
#[tauri::command]
pub async fn concierge_session_info<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    config_dir: Option<String>,
) -> ClaudeSessionInfo {
    let Ok(cwd) = crate::dev_identity::app_data_dir(&app) else {
        return ClaudeSessionInfo::none();
    };
    let cwd = cwd.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        ClaudeSessionInfo::from_probe(crate::claude::claude_session_info_sync(
            &cwd,
            config_dir.as_deref(),
        ))
    })
    .await
    .unwrap_or_else(|_| ClaudeSessionInfo::none())
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

// ---------------------------------------------------------------------------
// LSP auto-provisioning: project language detection
//
// Claude Code ships a NATIVE LSP client, activated per project by thin official plugins
// (`typescript-lsp`, `pyright-lsp`, `rust-analyzer-lsp`, `gopls-lsp`, `swift-lsp`, …). Those plugins
// are README-only: they carry NO language-server binary, they just tell Claude Code which server to
// drive — the binary must already exist on the machine. That's the gap Sparkle can close, since it
// already auto-installs prerequisites without sudo.
//
// Step one is knowing WHICH servers a project actually needs, so we never install (or offer) five
// language servers for a repo that is only TypeScript. Detection is manifest-based: a bounded scan
// for the marker files each ecosystem's tooling already requires.
// ---------------------------------------------------------------------------

/// A language Sparkle can map to an official Claude Code LSP plugin + a language-server binary.
/// Ordered so a `BTreeSet<ProjectLanguage>` is deterministic (matters for tests and for the UI).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProjectLanguage {
    #[serde(rename = "typescript")]
    TypeScript,
    #[serde(rename = "python")]
    Python,
    #[serde(rename = "rust")]
    Rust,
    #[serde(rename = "go")]
    Go,
    #[serde(rename = "swift")]
    Swift,
}

impl ProjectLanguage {
    /// Every language we detect, in the enum's own (sorted) order.
    pub const ALL: [ProjectLanguage; 5] = [
        ProjectLanguage::TypeScript,
        ProjectLanguage::Python,
        ProjectLanguage::Rust,
        ProjectLanguage::Go,
        ProjectLanguage::Swift,
    ];

    /// The stable wire key — what crosses the Tauri boundary and what `install_lsp_server` accepts.
    pub fn key(self) -> &'static str {
        match self {
            ProjectLanguage::TypeScript => "typescript",
            ProjectLanguage::Python => "python",
            ProjectLanguage::Rust => "rust",
            ProjectLanguage::Go => "go",
            ProjectLanguage::Swift => "swift",
        }
    }

    /// Parse a wire key back into a language, accepting the handful of aliases a caller (or a user
    /// typing into a config) plausibly uses. Case-insensitive. Pure — unit-tested.
    pub fn from_key(s: &str) -> Option<ProjectLanguage> {
        match s.trim().to_ascii_lowercase().as_str() {
            "typescript" | "ts" | "javascript" | "js" => Some(ProjectLanguage::TypeScript),
            "python" | "py" => Some(ProjectLanguage::Python),
            "rust" | "rs" => Some(ProjectLanguage::Rust),
            "go" | "golang" => Some(ProjectLanguage::Go),
            "swift" => Some(ProjectLanguage::Swift),
            _ => None,
        }
    }
}

/// Map a directory-entry NAME (file or directory) to the language its presence implies, or None when
/// the name isn't a manifest marker. Deliberately manifest-based rather than extension-based: a lone
/// `.py` script in a JS repo shouldn't provision a Python language server, but a `pyproject.toml`
/// means the project really is Python. Pure — unit-tested.
pub fn language_for_manifest(name: &str) -> Option<ProjectLanguage> {
    match name {
        // JS/TS: package.json alone is enough — Claude Code's typescript-lsp covers .js/.jsx too.
        "package.json" | "tsconfig.json" | "jsconfig.json" => Some(ProjectLanguage::TypeScript),
        "pyproject.toml" | "requirements.txt" | "setup.py" | "setup.cfg" | "Pipfile" => {
            Some(ProjectLanguage::Python)
        }
        "Cargo.toml" => Some(ProjectLanguage::Rust),
        "go.mod" => Some(ProjectLanguage::Go),
        "Package.swift" => Some(ProjectLanguage::Swift),
        // Xcode projects/workspaces are DIRECTORIES with these suffixes, not files.
        _ if name.ends_with(".xcodeproj") || name.ends_with(".xcworkspace") => {
            Some(ProjectLanguage::Swift)
        }
        _ => None,
    }
}

/// Directory names we never descend into while scanning: dependency/build output (huge, and their
/// vendored manifests describe someone else's project, not this one), plus Xcode bundles, which are
/// matched as markers and hold nothing else we want. Hidden dirs are skipped separately.
const SCAN_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "venv",
    "__pycache__",
    "Pods",
    "DerivedData",
    "coverage",
    "bower_components",
];

/// Should the scan descend into a directory with this name? Pure — unit-tested.
pub fn should_skip_scan_dir(name: &str) -> bool {
    name.starts_with('.')
        || SCAN_SKIP_DIRS.contains(&name)
        || name.ends_with(".xcodeproj")
        || name.ends_with(".xcworkspace")
}

/// How many directory levels below the repo root the manifest scan descends. 3 reaches a monorepo's
/// `apps/<app>/<pkg>/package.json` (the shape this very repo uses) without walking a whole tree.
const MAX_SCAN_DEPTH: usize = 3;

/// Hard ceiling on directories visited, so a pathological repo can't turn detection into a long
/// filesystem walk. Well above what a normal repo needs at depth 3 with the skip-list applied.
const MAX_SCAN_DIRS: usize = 750;

/// Detect the languages a repo is written in, from the manifests at (and just below) its root.
/// Breadth-first, depth- and count-bounded, skipping dependency/build dirs; returns a deterministic
/// typed set. An unreadable directory is skipped rather than failing the scan — partial detection
/// beats no detection. Pure w.r.t. the filesystem it's handed, so it's tested against fixture dirs.
pub fn detect_project_languages(root: &Path) -> BTreeSet<ProjectLanguage> {
    let mut found: BTreeSet<ProjectLanguage> = BTreeSet::new();
    bounded_scan(root, &mut |_dir: &Path, name: &str, _is_dir: bool| {
        if let Some(lang) = language_for_manifest(name) {
            found.insert(lang);
        }
        // Nothing more to learn once every language is accounted for.
        if found.len() == ProjectLanguage::ALL.len() {
            ScanFlow::Stop
        } else {
            ScanFlow::Continue
        }
    });
    found
}

/// Whether [`bounded_scan`] should keep walking after this entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanFlow {
    Continue,
    Stop,
}

/// The bounded breadth-first manifest walk, with the visitor supplied by the caller.
///
/// Extracted from [`detect_project_languages`] so `preview.rs` can enumerate a monorepo's
/// `package.json` files under the SAME bounds rather than writing a second walk with its own depth,
/// count and skip-list to get subtly different. The bounds are the point: `MAX_SCAN_DEPTH` reaches
/// `apps/<app>/package.json` (the shape this very repo uses) and `MAX_SCAN_DIRS` stops a
/// pathological repo turning detection into a long filesystem walk.
///
/// The visitor is called once per directory entry with `(containing dir, entry name, is_dir)`, and
/// returning [`ScanFlow::Stop`] ends the whole walk. An unreadable directory is skipped rather than
/// failing the scan — partial detection beats no detection.
pub fn bounded_scan(root: &Path, visit: &mut dyn FnMut(&Path, &str, bool) -> ScanFlow) {
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));
    let mut visited = 0usize;

    'walk: while let Some((dir, depth)) = queue.pop_front() {
        if visited >= MAX_SCAN_DIRS {
            break;
        }
        visited += 1;
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue; // unreadable (permissions, race) — skip, don't abort the scan
        };
        for entry in entries.flatten() {
            let raw_name = entry.file_name();
            let name = raw_name.to_string_lossy();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if visit(&dir, &name, is_dir) == ScanFlow::Stop {
                break 'walk;
            }
            if is_dir && depth < MAX_SCAN_DEPTH && !should_skip_scan_dir(&name) {
                queue.push_back((entry.path(), depth + 1));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// LSP auto-provisioning: language-server detection
//
// Two tiers, deliberately:
//  - AUTO-INSTALLABLE (typescript-language-server, pyright): npm-distributed, so Sparkle's managed
//    npm (the pinned Node install) can put them in a user-local prefix with no sudo. `setup.rs`
//    owns those installs; this module owns "is it there, and what version".
//  - DETECTION-ONLY (rust-analyzer, gopls, sourcekit-lsp): each needs a toolchain we don't manage
//    (rustup / the Go toolchain / Xcode). We report present-or-absent so the UI can tell the user
//    exactly what to run; installers are a deliberate TODO (see `setup.rs`).
// ---------------------------------------------------------------------------

/// A language server Sparkle can detect (and, for the npm-distributed ones, install).
/// `Hash` so it can key the session cache in [`lsp_cache`].
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LspServer {
    #[serde(rename = "typescript-language-server")]
    TypeScriptLanguageServer,
    #[serde(rename = "pyright")]
    Pyright,
    #[serde(rename = "rust-analyzer")]
    RustAnalyzer,
    #[serde(rename = "gopls")]
    Gopls,
    #[serde(rename = "sourcekit-lsp")]
    SourceKitLsp,
}

impl LspServer {
    /// The server for a language. One server per language today; if that ever forks (e.g. a
    /// TypeScript project that prefers `vtsls`), this is the seam to widen.
    pub fn for_language(language: ProjectLanguage) -> LspServer {
        match language {
            ProjectLanguage::TypeScript => LspServer::TypeScriptLanguageServer,
            ProjectLanguage::Python => LspServer::Pyright,
            ProjectLanguage::Rust => LspServer::RustAnalyzer,
            ProjectLanguage::Go => LspServer::Gopls,
            ProjectLanguage::Swift => LspServer::SourceKitLsp,
        }
    }

    /// The language this server serves (inverse of [`LspServer::for_language`]).
    pub fn language(self) -> ProjectLanguage {
        match self {
            LspServer::TypeScriptLanguageServer => ProjectLanguage::TypeScript,
            LspServer::Pyright => ProjectLanguage::Python,
            LspServer::RustAnalyzer => ProjectLanguage::Rust,
            LspServer::Gopls => ProjectLanguage::Go,
            LspServer::SourceKitLsp => ProjectLanguage::Swift,
        }
    }

    /// Stable wire key for this server.
    pub fn key(self) -> &'static str {
        match self {
            LspServer::TypeScriptLanguageServer => "typescript-language-server",
            LspServer::Pyright => "pyright",
            LspServer::RustAnalyzer => "rust-analyzer",
            LspServer::Gopls => "gopls",
            LspServer::SourceKitLsp => "sourcekit-lsp",
        }
    }

    /// The plugin name in Claude Code's OFFICIAL marketplace that drives this server. Verified
    /// against the marketplace's `plugins/` listing — the wiring task (sparkle-s3g2.4) enables these
    /// by name, and they only work if the binary below is on PATH.
    pub fn claude_plugin(self) -> &'static str {
        match self {
            LspServer::TypeScriptLanguageServer => "typescript-lsp",
            LspServer::Pyright => "pyright-lsp",
            LspServer::RustAnalyzer => "rust-analyzer-lsp",
            LspServer::Gopls => "gopls-lsp",
            LspServer::SourceKitLsp => "swift-lsp",
        }
    }

    /// The executable whose presence means "this server is available". For pyright that's
    /// `pyright-langserver` (the stdio LSP entry point), NOT the `pyright` CLI wrapper.
    pub fn primary_binary(self) -> &'static str {
        match self {
            LspServer::TypeScriptLanguageServer => "typescript-language-server",
            LspServer::Pyright => "pyright-langserver",
            LspServer::RustAnalyzer => "rust-analyzer",
            LspServer::Gopls => "gopls",
            LspServer::SourceKitLsp => "sourcekit-lsp",
        }
    }

    /// Executables an npm install of this server drops in the managed prefix that should be linked
    /// onto the user's PATH. Empty for the detection-only servers (nothing of ours to link).
    pub fn linked_binaries(self) -> &'static [&'static str] {
        match self {
            LspServer::TypeScriptLanguageServer => &["typescript-language-server"],
            // Link the CLI too: `pyright` is what a user runs to sanity-check the install by hand.
            LspServer::Pyright => &["pyright-langserver", "pyright"],
            _ => &[],
        }
    }

    /// Can Sparkle install this server itself (no sudo, no extra toolchain)? True only for the
    /// npm-distributed pair; see the module note on the two tiers.
    pub fn auto_installable(self) -> bool {
        matches!(self, LspServer::TypeScriptLanguageServer | LspServer::Pyright)
    }

    /// Args that make this server print its version and EXIT. `None` means "don't probe": a bare
    /// `sourcekit-lsp` invocation starts a stdio language server, and older toolchain builds don't
    /// understand `--version`, so we report its path without claiming a version we didn't read.
    /// Note `gopls` uses the subcommand form (`gopls version`), not a flag.
    pub fn version_args(self) -> Option<&'static [&'static str]> {
        match self {
            LspServer::TypeScriptLanguageServer | LspServer::Pyright | LspServer::RustAnalyzer => {
                Some(&["--version"])
            }
            LspServer::Gopls => Some(&["version"]),
            LspServer::SourceKitLsp => None,
        }
    }

    /// The executable to ASK for the version, when it isn't [`Self::primary_binary`].
    ///
    /// pyright ships two entry points and only one of them answers. `pyright-langserver` is the
    /// stdio LSP binary — it does NOT implement `--version`, so probing it yields `version: None`
    /// forever ("version unknown" in the UI) or, worse, starts a language server that produces no
    /// output and burns the probe timeout. The `pyright` CLI wrapper does implement it, and we
    /// already link it (see [`Self::linked_binaries`]) precisely so a user can sanity-check the
    /// install by hand. `None` here means "probe the primary binary", which is right for every
    /// other server.
    pub fn version_binary(self) -> Option<&'static str> {
        match self {
            LspServer::Pyright => Some("pyright"),
            _ => None,
        }
    }

    /// Every server, language order.
    pub fn all() -> Vec<LspServer> {
        ProjectLanguage::ALL.iter().map(|l| LspServer::for_language(*l)).collect()
    }
}

/// The user-local prefix Sparkle installs npm-distributed language servers into. Deliberately NOT
/// the machine's npm global prefix: that's often `/usr/local` (needs sudo) or the user's own nvm
/// version dir (ours to break). A Sparkle-owned prefix keeps the install no-sudo, uninstallable by
/// deleting one directory, and — crucially — makes "did WE install this?" answerable, which is what
/// lets the symlink step refuse to clobber a binary the user installed themselves.
pub fn lsp_npm_prefix_for(home: &Path) -> PathBuf {
    home.join(".local/share/sparkle/lsp")
}

/// `<prefix>/bin` — where `npm install --global --prefix <prefix>` puts executables.
pub fn lsp_managed_bin_dir_for(home: &Path) -> PathBuf {
    lsp_npm_prefix_for(home).join("bin")
}

/// Canonical absolute locations for a server's primary binary, most-trusted first: Sparkle's managed
/// prefix, then `~/.local/bin` (where we symlink it, and where the Claude Code installer's PATH entry
/// already points), then the per-toolchain user dirs, then homebrew. Pure form takes the home dir
/// explicitly so it can be unit-tested without mutating the process-global `HOME`.
pub fn known_lsp_paths_for(server: LspServer, home: Option<PathBuf>) -> Vec<PathBuf> {
    let bin = server.primary_binary();
    let mut paths = Vec::new();
    if let Some(home) = &home {
        paths.push(lsp_managed_bin_dir_for(home).join(bin)); // our managed install
        paths.push(home.join(".local/bin").join(bin)); // our symlink / a user-local install
        match server {
            // rustup's `rust-analyzer` proxy lands in the cargo bin dir.
            LspServer::RustAnalyzer => paths.push(home.join(".cargo/bin").join(bin)),
            // `go install` writes to $GOPATH/bin, which defaults to ~/go/bin.
            LspServer::Gopls => paths.push(home.join("go/bin").join(bin)),
            _ => {}
        }
    }
    paths.push(PathBuf::from("/opt/homebrew/bin").join(bin)); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin").join(bin)); // homebrew (Intel) / npm
    paths
}

/// A PATH string with `dir` prepended to `current`. Used wherever we spawn an npm-installed server
/// or npm itself: their shebang is `#!/usr/bin/env node`, so `node` must be resolvable — and a
/// Finder/Dock-launched GUI app's PATH frequently has no node at all. Pure — unit-tested.
pub fn path_with_dir_first(dir: &Path, current: Option<&str>) -> String {
    let dir = dir.to_string_lossy();
    match current.map(str::trim).filter(|c| !c.is_empty()) {
        // Already first — don't duplicate the entry on a re-run.
        Some(cur) if cur == dir || cur.starts_with(&format!("{dir}:")) => cur.to_string(),
        Some(cur) => format!("{dir}:{cur}"),
        None => dir.to_string(),
    }
}

/// Spawn-ready `Command` for an LSP-related executable, with the resolved `node` directory prepended
/// to PATH (see [`path_with_dir_first`]) so a node-shebang server actually starts.
fn lsp_command(path: &str) -> Command {
    let mut cmd = Command::new(path);
    if let Some(node) = resolve_node_path_cached() {
        if let Some(dir) = Path::new(&node).parent() {
            let current = std::env::var("PATH").ok();
            cmd.env("PATH", path_with_dir_first(dir, current.as_deref()));
        }
    }
    cmd
}

/// Wall-clock ceiling for a language-server version probe. These are cold node/JVM-free processes
/// that print a line and exit; anything slower is wedged and must not hang the setup UI.
const LSP_VERSION_TIMEOUT: Duration = Duration::from_secs(20);

/// Which executable to run for a version probe, given where the server itself resolved.
///
/// For most servers that's the server binary. For pyright it's the sibling `pyright` CLI (see
/// [`LspServer::version_binary`]) — resolved next to the resolved server rather than off PATH,
/// so the version we report belongs to the SAME install we just reported the path of. `None` when
/// that sibling isn't there, because a version read from some other copy would be a lie. Pure —
/// unit-tested.
pub fn version_probe_path(server: LspServer, resolved: &Path) -> Option<PathBuf> {
    match server.version_binary() {
        None => Some(resolved.to_path_buf()),
        Some(bin) => {
            let sibling = resolved.parent()?.join(bin);
            sibling.exists().then_some(sibling)
        }
    }
}

/// Read a language server's version by running its version command with a deadline and stdin closed
/// (via [`crate::worktree::output_with_timeout`]) — so a server that ignores its args and tries to
/// speak LSP on stdin gets EOF and dies instead of hanging forever. Returns the first non-empty
/// output line, or None when the server declines to report / the probe fails.
pub fn lsp_server_version(server: LspServer, path: &str) -> Option<String> {
    let args = server.version_args()?;
    let probe = version_probe_path(server, Path::new(path))?;
    let mut cmd = lsp_command(&probe.to_string_lossy());
    cmd.args(args);
    let out = crate::worktree::output_with_timeout(cmd, LSP_VERSION_TIMEOUT).ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}

/// macOS: locate `sourcekit-lsp` inside the active Xcode/CLT toolchain via `xcrun --find`.
///
/// Gated on [`command_line_tools_installed`] for the same reason [`resolve_git_path`] guards
/// `/usr/bin/git`: on a Mac with no developer tools, running `xcrun` pops Apple's "install developer
/// tools" dialog — a *detection* pass must never do that. `xcode-select -p` never triggers it.
#[cfg(all(unix, target_os = "macos"))]
fn resolve_sourcekit_lsp() -> Option<String> {
    if !command_line_tools_installed() {
        return None;
    }
    let mut cmd = Command::new("xcrun");
    cmd.args(["--find", "sourcekit-lsp"]);
    let out = crate::worktree::output_with_timeout(cmd, LSP_VERSION_TIMEOUT).ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(path).filter(|p| Path::new(p).is_absolute() && is_executable(Path::new(p)))
}

/// Non-macOS: `sourcekit-lsp` ships in the Linux Swift toolchain and is found by the generic PATH
/// probe; there's no `xcrun` to consult.
#[cfg(not(all(unix, target_os = "macos")))]
fn resolve_sourcekit_lsp() -> Option<String> {
    None
}

/// Ask rustup where its `rust-analyzer` component lives — covers a toolchain whose proxy isn't in
/// `~/.cargo/bin` yet. Best-effort; None when rustup is absent or the component isn't installed.
#[cfg(unix)]
fn resolve_rust_analyzer_via_rustup() -> Option<String> {
    run_in_login_shell("rustup which rust-analyzer")
        .filter(|p| Path::new(p).is_absolute() && is_executable(Path::new(p)))
}

#[cfg(not(unix))]
fn resolve_rust_analyzer_via_rustup() -> Option<String> {
    None
}

/// Resolve a language server's absolute path, or None when it isn't installed.
///
/// Login shell FIRST, deliberately: that's what Claude Code's own LSP client will resolve, so
/// reporting anything else would be reporting a binary that isn't the one that runs. The canonical
/// absolute locations (managed prefix included) are the fallback for the GUI-PATH gap, and the
/// per-toolchain probes (`xcrun`, `rustup which`) come last.
#[cfg(unix)]
pub fn resolve_lsp_server_path(server: LspServer) -> Option<String> {
    let bin = server.primary_binary();
    // `bin` is one of our own compile-time constants, never user input — safe to interpolate.
    if let Some(p) = run_in_login_shell(&format!("command -v {bin}"))
        .filter(|p| Path::new(p).is_absolute() && is_executable(Path::new(p)))
    {
        return Some(p);
    }
    if let Some(p) = first_executable(&known_lsp_paths_for(
        server,
        std::env::var_os("HOME").map(PathBuf::from),
    )) {
        return Some(p);
    }
    match server {
        LspServer::SourceKitLsp => resolve_sourcekit_lsp(),
        LspServer::RustAnalyzer => resolve_rust_analyzer_via_rustup(),
        _ => None,
    }
}

/// Windows: `where <bin>` (GUI apps inherit PATH), then the canonical install locations.
#[cfg(not(unix))]
pub fn resolve_lsp_server_path(server: LspServer) -> Option<String> {
    resolve_on_path(server.primary_binary())
        .or_else(|| first_executable(&known_lsp_paths_for(server, home_dir())))
}

/// Resolve a server's path within Sparkle's MANAGED prefix only — the post-install verification
/// question ("did *our* install land?"), as distinct from [`resolve_lsp_server_path`]'s "what will
/// Claude Code run?". Returns None when we have no managed copy.
pub fn managed_lsp_server_path(server: LspServer) -> Option<String> {
    let candidate = lsp_managed_bin_dir_for(&lsp_home_for_this_machine()?)
        .join(server.primary_binary());
    first_executable(&[candidate])
}

/// [`resolve_lsp_server_path`] with the managed prefix EXCLUDED — the KeepForeign question ("we
/// left the user's own binary in place; which one actually runs?"). The general resolver can't
/// answer it because its candidate list puts the managed copy first. Symlinks are followed before
/// the containment test so a `~/.local/bin` link INTO the managed prefix still counts as managed.
#[cfg(unix)]
pub fn resolve_lsp_server_path_outside_managed(server: LspServer) -> Option<String> {
    // `is_managed_lsp_path`, not a second containment test. The ad-hoc one here canonicalized the
    // CANDIDATE and compared it against the LITERAL prefix — the one-sided canonicalization whose
    // failure that helper's doc spells out: on macOS `/var/…` canonicalizes to `/private/var/…`, so
    // on any machine with a symlinked component in the prefix our OWN managed binary read as
    // "outside" and got reported as the foreign one that runs.
    let managed_prefix = lsp_prefix_for_this_machine();
    let outside = |p: &str| match &managed_prefix {
        Some(prefix) => !is_managed_lsp_path(Path::new(p), prefix),
        None => true,
    };
    let bin = server.primary_binary();
    if let Some(p) = run_in_login_shell(&format!("command -v {bin}"))
        .filter(|p| Path::new(p).is_absolute() && is_executable(Path::new(p)))
        .filter(|p| outside(p))
    {
        return Some(p);
    }
    known_lsp_paths_for(server, std::env::var_os("HOME").map(PathBuf::from))
        .iter()
        .filter_map(|c| first_executable(std::slice::from_ref(c)))
        .find(|p| outside(p))
}

/// This machine's home dir as the LSP paths resolve it. Split out so `managed_lsp_server_path` and
/// the `managed` containment check can't drift into using different homes.
fn lsp_home_for_this_machine() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(not(unix))]
    {
        home_dir()
    }
}

/// Sparkle's managed LSP prefix on this machine, or None when the home dir can't be resolved.
fn lsp_prefix_for_this_machine() -> Option<PathBuf> {
    lsp_home_for_this_machine().map(|h| lsp_npm_prefix_for(&h))
}

/// Per-server install status for the setup UI and for the plugin-toggle wiring (sparkle-s3g2.4).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    /// Stable server key, e.g. "typescript-language-server".
    pub server: String,
    /// The language it serves, e.g. "typescript" — the argument `install_lsp_server` takes.
    pub language: String,
    /// The official Claude Code marketplace plugin that drives it, e.g. "typescript-lsp".
    pub plugin: String,
    /// The executable we look for on PATH.
    pub binary: String,
    /// Mirrors `path.is_some()`.
    pub installed: bool,
    /// Absolute path to the resolved binary.
    pub path: Option<String>,
    /// Version line, when the server reports one (never probed for sourcekit-lsp — see
    /// [`LspServer::version_args`]).
    pub version: Option<String>,
    /// True when `install_lsp_server` can provision it; false for the detection-only tier.
    pub auto_installable: bool,
    /// True when this copy lives in Sparkle's managed prefix (i.e. we installed it).
    pub managed: bool,
}

/// Is `resolved` a copy that lives in Sparkle's managed prefix — i.e. did WE install it?
///
/// THE BUG THIS FIXES: this used to be a STRING comparison of the resolved path against
/// `managed_lsp_server_path`. For a server Sparkle actually installed, `resolve_lsp_server_path`
/// normally returns the `~/.local/bin/<bin>` SYMLINK (the login-shell `command -v` hit, or the
/// second candidate in `known_lsp_paths_for`), which never string-equals
/// `~/.local/share/sparkle/lsp/bin/<bin>`. So `managed` reported false for our own installs
/// whenever `~/.local/bin` was on the login PATH and true only when it wasn't — an
/// environment-dependent flag, not an answer to "did we install this?".
///
/// Now it resolves the link and tests CONTAINMENT under the managed prefix, the same shape
/// `setup::link_action` uses to decide what it's allowed to overwrite. Both the literal and the
/// canonicalized prefix are accepted for the same reason it gives: canonicalizing only one side
/// breaks on macOS, where `/var/…` canonicalizes to `/private/var/…`. Pure — unit-tested against
/// real temp-dir symlinks.
pub fn is_managed_lsp_path(resolved: &Path, managed_prefix: &Path) -> bool {
    let canonical_prefix = std::fs::canonicalize(managed_prefix).ok();
    let under_prefix = |p: &Path| {
        p.starts_with(managed_prefix)
            || canonical_prefix.as_ref().map(|c| p.starts_with(c)).unwrap_or(false)
    };
    if under_prefix(resolved) {
        return true;
    }
    // A symlink: compare the target (resolved against the link's own dir when relative) and its
    // canonical form. `read_link` rather than `canonicalize` alone, so a DANGLING link of ours is
    // still recognized as ours.
    let target = std::fs::read_link(resolved).map(|t| {
        if t.is_absolute() {
            t
        } else {
            resolved.parent().map(|d| d.join(&t)).unwrap_or(t)
        }
    });
    let Ok(target) = target else {
        // Not a link. Fall back to canonicalizing the path itself — covers a resolved path that
        // reaches the prefix through a symlinked PARENT directory.
        return std::fs::canonicalize(resolved).map(|c| under_prefix(&c)).unwrap_or(false);
    };
    under_prefix(&target)
        || std::fs::canonicalize(&target).map(|c| under_prefix(&c)).unwrap_or(false)
}

/// Session cache for the two EXPENSIVE parts of a status build: resolving a server's path (one
/// `$SHELL -lc` spawn, which sources the user's profile) and probing its version (another process
/// spawn, with a 20s ceiling). Five servers × both = up to ten profile-sourcing shells and five
/// version probes per call — inside a single IPC round-trip, on a command meant to run PER PROJECT.
///
/// Two different invalidation rules, because the two answers go stale differently:
///   * PATHS follow the established `resolve_node_path_cached` rule — cache a POSITIVE hit and drop
///     it the moment the file stops existing. Misses are cached too, but only for [`MISS_TTL`]
///     (30s), because the miss is what a fresh machine hits on EVERY per-project preflight and each
///     one pays a full `$SHELL -lc` probe. The TTL is the ceiling on how long a hand-install stays
///     invisible; `install_lsp_server` clears both maps outright via `forget_paths`, so Sparkle's
///     own installs are still picked up immediately.
///   * VERSIONS are keyed by the binary's (mtime, len), the same identity `spend.rs`'s memo uses,
///     so an upgrade in place invalidates itself rather than reporting the old number forever.
mod lsp_cache {
    use super::LspServer;
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};
    use std::time::SystemTime;

    fn paths() -> &'static Mutex<HashMap<LspServer, String>> {
        static C: OnceLock<Mutex<HashMap<LspServer, String>>> = OnceLock::new();
        C.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Negative entries: servers a resolve MISSED, with when. Without these, the case a fresh
    /// machine hits on every per-project preflight — server not installed — is exactly the one
    /// that is never memoized, and each miss pays the full `$SHELL -lc` probe again. TTL'd (and
    /// cleared by [`forget_paths`]) so a mid-session hand-install is picked up within seconds.
    fn misses() -> &'static Mutex<HashMap<LspServer, std::time::Instant>> {
        static C: OnceLock<Mutex<HashMap<LspServer, std::time::Instant>>> = OnceLock::new();
        C.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) const MISS_TTL: std::time::Duration = std::time::Duration::from_secs(30);

    pub(super) fn missed_recently(server: LspServer) -> bool {
        let mut guard = lock(misses());
        match guard.get(&server) {
            Some(at) if at.elapsed() < MISS_TTL => true,
            Some(_) => {
                guard.remove(&server);
                false
            }
            None => false,
        }
    }

    pub(super) fn remember_miss(server: LspServer) {
        // Deliberately does NOT clear the positive entry. It looks symmetric with `remember_path`,
        // but the two maps are behind separate mutexes, so the pair is not atomic: two concurrent
        // resolves for the same server could interleave as B-clears-miss, B-inserts-path,
        // A-removes-path, A-inserts-miss — leaving a cached MISS for a server that resolves, for up
        // to MISS_TTL. Nothing needs the removal either: `path()` re-validates existence and is
        // consulted BEFORE `missed_recently` (see `resolve_lsp_server_path_cached`), so a stale hit
        // can never be answered from here.
        lock(misses()).insert(server, std::time::Instant::now());
    }

    /// (binary path, mtime, len) → the version line we read from it.
    type VersionKey = (String, SystemTime, u64);
    fn versions() -> &'static Mutex<HashMap<VersionKey, String>> {
        static C: OnceLock<Mutex<HashMap<VersionKey, String>>> = OnceLock::new();
        C.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn lock<T: 'static>(m: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The cached path for `server`, if we have one AND it still exists.
    pub(super) fn path(server: LspServer) -> Option<String> {
        let mut guard = lock(paths());
        let hit = guard.get(&server).cloned()?;
        if Path::new(&hit).exists() {
            return Some(hit);
        }
        // Uninstalled since we cached it — drop the entry so the next call re-probes for real.
        guard.remove(&server);
        None
    }

    pub(super) fn remember_path(server: LspServer, path: &str) {
        // And clear any negative entry: without this, a server installed and then removed inside
        // one TTL window answers from the stale miss the moment `path()` drops the positive entry.
        lock(misses()).remove(&server);
        lock(paths()).insert(server, path.to_string());
    }

    fn version_key(path: &str) -> Option<VersionKey> {
        let meta = std::fs::metadata(path).ok()?;
        Some((path.to_string(), meta.modified().ok()?, meta.len()))
    }

    pub(super) fn version(path: &str) -> Option<String> {
        let key = version_key(path)?;
        lock(versions()).get(&key).cloned()
    }

    pub(super) fn remember_version(path: &str, version: &str) {
        if let Some(key) = version_key(path) {
            lock(versions()).insert(key, version.to_string());
        }
    }

    /// Drop every cached path AND every negative entry. Called after an install/uninstall so the
    /// next preflight reflects it without waiting for the existence check or the miss TTL.
    pub(super) fn forget_paths() {
        lock(paths()).clear();
        lock(misses()).clear();
    }
}

/// Forget the cached language-server paths. Call after anything that CHANGES what's installed, so
/// the next preflight reports the new reality rather than the pre-install one.
pub fn invalidate_lsp_path_cache() {
    lsp_cache::forget_paths();
}

/// [`resolve_lsp_server_path`] with the session cache in front of it. Each uncached resolve costs a
/// `$SHELL -lc` spawn that sources the user's profile; this is what keeps a per-project preflight
/// from paying that five times on every call. Misses are cached too ([`lsp_cache::MISS_TTL`]) —
/// "not installed" is the answer a fresh machine gets for every server on every call, and it's as
/// expensive to recompute as a hit.
pub fn resolve_lsp_server_path_cached(server: LspServer) -> Option<String> {
    if let Some(hit) = lsp_cache::path(server) {
        return Some(hit);
    }
    if lsp_cache::missed_recently(server) {
        return None;
    }
    let resolved = resolve_lsp_server_path(server);
    match resolved.as_deref() {
        Some(p) => lsp_cache::remember_path(server, p),
        None => lsp_cache::remember_miss(server),
    }
    resolved
}

/// [`lsp_server_version`] memoized on the probed binary's (path, mtime, len), so a repeat call is a
/// `stat` instead of a process spawn, and an upgrade in place still re-probes.
pub fn lsp_server_version_cached(server: LspServer, path: &str) -> Option<String> {
    let probe = version_probe_path(server, Path::new(path))?;
    let probe = probe.to_string_lossy().into_owned();
    if let Some(hit) = lsp_cache::version(&probe) {
        return Some(hit);
    }
    let version = lsp_server_version(server, path)?;
    lsp_cache::remember_version(&probe, &version);
    Some(version)
}

/// Build the status for one server. `with_version` is false on the cheap paths — a version probe
/// spawns the server, which for a cold node install costs a few hundred ms.
///
/// Both halves go through the session cache ([`lsp_cache`]), so calling this per project is a
/// handful of `stat`s once the first call has warmed it.
pub fn lsp_server_status(server: LspServer, with_version: bool) -> LspServerStatus {
    let path = resolve_lsp_server_path_cached(server);
    let managed = path
        .as_deref()
        .zip(lsp_prefix_for_this_machine())
        .map(|(p, prefix)| is_managed_lsp_path(Path::new(p), &prefix))
        .unwrap_or(false);
    let version = if with_version {
        path.as_deref().and_then(|p| lsp_server_version_cached(server, p))
    } else {
        None
    };
    LspServerStatus {
        server: server.key().to_string(),
        language: server.language().key().to_string(),
        plugin: server.claude_plugin().to_string(),
        binary: server.primary_binary().to_string(),
        installed: path.is_some(),
        path,
        version,
        auto_installable: server.auto_installable(),
        managed,
    }
}

/// Detect every language server Sparkle knows about (installed/missing, path, version), off the main
/// thread. Drives the LSP section of the setup surface. Does NOT install anything.
///
/// `with_version: true` here because this is the SETUP surface, where the version is the point;
/// [`project_lsp_preflight`] — the one that runs per project — deliberately does not pay for it.
/// Both go through the session cache, so a repeat call doesn't re-spawn anything.
///
/// Returns `Result` rather than collapsing a join failure to an empty vec: an empty list is
/// indistinguishable from "no servers known", so a crashed task would render as a confidently wrong
/// "nothing detected".
#[tauri::command]
pub async fn lsp_preflight() -> Result<Vec<LspServerStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        LspServer::all().into_iter().map(|s| lsp_server_status(s, true)).collect()
    })
    .await
    .map_err(|e| format!("lsp_preflight task failed: {e}"))
}

/// What a specific repo needs: the languages detected in it, and the status of only those servers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLspReport {
    /// Detected language keys, e.g. `["rust", "typescript"]`.
    pub languages: Vec<String>,
    /// Status of the server for each detected language, same order.
    pub servers: Vec<LspServerStatus>,
}

/// Scan a repo for its languages and report the matching language servers' install status in ONE IPC
/// round-trip, off the main thread. This is the call the plugin-toggle wiring (sparkle-s3g2.4) drives
/// per project: languages → which official LSP plugins to enable → whether their binaries exist yet.
///
/// `with_version: false` on purpose. This runs PER PROJECT, and the question it answers is "does the
/// binary exist?", not "which build is it?" — a version probe is a process spawn with a 20s ceiling
/// per server, and paying that on every project open bought nothing the caller reads. The setup
/// surface ([`lsp_preflight`]) is where versions are shown.
///
/// Returns `Result` rather than collapsing a join failure to an empty report — an empty report reads
/// as "no languages detected", which is a confident wrong answer.
#[tauri::command]
pub async fn project_lsp_preflight(repo_path: String) -> Result<ProjectLspReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let languages = detect_project_languages(Path::new(&repo_path));
        ProjectLspReport {
            languages: languages.iter().map(|l| l.key().to_string()).collect(),
            servers: languages
                .iter()
                .map(|l| lsp_server_status(LspServer::for_language(*l), false))
                .collect(),
        }
    })
    .await
    .map_err(|e| format!("project_lsp_preflight task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every test that touches the PROCESS-WIDE `lsp_cache` maps takes this. Cargo runs tests
    /// concurrently in one process, and `resolve_lsp_server_path_cached` writes those maps, so a
    /// real resolve landing mid-assertion would clear the entry under test — and this test's own
    /// `forget_paths()` would perturb the others.
    static LSP_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// The negative cache's contract, which until now lived only in a doc comment that had already
    /// drifted from the code once.
    #[test]
    fn the_lsp_cache_negative_entries_expire_and_never_shadow_a_real_hit() {
        let _guard = LSP_CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let server = LspServer::TypeScriptLanguageServer;
        lsp_cache::forget_paths();
        assert!(!lsp_cache::missed_recently(server), "cleared");

        lsp_cache::remember_miss(server);
        assert!(lsp_cache::missed_recently(server), "a miss is remembered");

        // A later positive resolve clears the miss, so the install is visible immediately rather
        // than after MISS_TTL.
        lsp_cache::remember_path(server, "/bin/sh");
        assert!(!lsp_cache::missed_recently(server), "the positive resolve dropped the miss");
        assert_eq!(lsp_cache::path(server).as_deref(), Some("/bin/sh"));

        // A subsequent miss does NOT clear the hit — the two maps are behind separate mutexes, so
        // clearing across them isn't atomic, and `path()` (which re-validates existence) is
        // consulted before `missed_recently` anyway.
        lsp_cache::remember_miss(server);
        assert_eq!(lsp_cache::path(server).as_deref(), Some("/bin/sh"));

        // A cached path whose file has gone drops itself.
        lsp_cache::remember_path(server, "/definitely/not/here/tsserver");
        assert_eq!(lsp_cache::path(server), None);

        lsp_cache::forget_paths();
        assert!(!lsp_cache::missed_recently(server));
        assert_eq!(lsp_cache::path(server), None);
    }

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
    fn known_gh_paths_prioritizes_user_then_brew_then_usr_local() {
        let home = Some(std::path::PathBuf::from("/Users/x"));
        let paths = super::known_gh_paths_for(home);
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert_eq!(strs[0], "/Users/x/.local/bin/gh");
        assert!(strs.contains(&"/opt/homebrew/bin/gh".to_string()));
        assert!(strs.contains(&"/usr/local/bin/gh".to_string()));
    }

    #[test]
    fn known_gh_paths_handles_no_home() {
        let paths = super::known_gh_paths_for(None);
        // No home → no ~/.local entry, but the system locations are still present.
        assert!(paths.iter().any(|p| p.ends_with("opt/homebrew/bin/gh")));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains(".local")));
    }

    #[test]
    fn gh_program_never_returns_empty() {
        // Whatever the machine looks like, gh_program must yield something spawnable-shaped:
        // either an absolute resolved path or the bare "gh" fallback — never an empty string.
        let prog = super::gh_program();
        assert!(!prog.is_empty());
        assert!(prog == "gh" || std::path::Path::new(&prog).is_absolute());
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

    // ── LSP: language detection ───────────────────────────────────────────────────────────────

    /// Build a throwaway fixture tree: every entry in `files` is created relative to a fresh temp
    /// dir (a trailing `/` makes it a directory, otherwise an empty file with its parents).
    fn fixture_repo(tag: &str, files: &[&str]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "-fixture-{}-{}-{tag}",
            std::process::id(),
            // Distinct per fixture within a process so parallel tests can't collide.
            files.len(),
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        for f in files {
            let path = root.join(f.trim_end_matches('/'));
            if f.ends_with('/') {
                std::fs::create_dir_all(&path).unwrap();
            } else {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).unwrap();
                }
                std::fs::write(&path, b"").unwrap();
            }
        }
        root
    }

    #[test]
    fn language_for_manifest_maps_each_ecosystems_markers() {
        use ProjectLanguage::*;
        for (name, lang) in [
            ("package.json", TypeScript),
            ("tsconfig.json", TypeScript),
            ("jsconfig.json", TypeScript),
            ("pyproject.toml", Python),
            ("requirements.txt", Python),
            ("setup.py", Python),
            ("Cargo.toml", Rust),
            ("go.mod", Go),
            ("Package.swift", Swift),
            // Xcode project/workspace bundles are directories with these suffixes.
            ("Sparkle.xcodeproj", Swift),
            ("Sparkle.xcworkspace", Swift),
        ] {
            assert_eq!(language_for_manifest(name), Some(lang), "marker {name}");
        }
    }

    #[test]
    fn language_for_manifest_ignores_non_manifests() {
        // Source files must NOT imply a language: a stray build script or vendored .py in a JS repo
        // shouldn't provision a Python language server. Manifests are the signal, by design.
        for name in ["main.py", "lib.rs", "index.ts", "README.md", "go.sum", "Cargo.lock", ""] {
            assert_eq!(language_for_manifest(name), None, "{name} must not be a marker");
        }
    }

    #[test]
    fn detect_project_languages_reads_a_root_manifest() {
        let repo = fixture_repo("rust-root", &["Cargo.toml", "src/lib.rs"]);
        let langs = detect_project_languages(&repo);
        assert_eq!(langs.into_iter().collect::<Vec<_>>(), vec![ProjectLanguage::Rust]);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn detect_project_languages_finds_every_language_in_a_polyglot_monorepo() {
        // The shape this repo actually has: a JS root, a nested Rust crate, plus other ecosystems.
        let repo = fixture_repo(
            "polyglot",
            &[
                "package.json",
                "apps/desktop/src-tauri/Cargo.toml",
                "services/api/pyproject.toml",
                "tools/cli/go.mod",
                "ios/Package.swift",
            ],
        );
        let langs: Vec<_> = detect_project_languages(&repo).into_iter().collect();
        assert_eq!(langs, ProjectLanguage::ALL.to_vec(), "expected all five, got {langs:?}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn detect_project_languages_ignores_dependency_dirs() {
        // A vendored manifest describes someone ELSE's project. Provisioning a Python server
        // because a node_modules package ships a setup.py is exactly the noise this guards against.
        let repo = fixture_repo(
            "vendored",
            &[
                "package.json",
                "node_modules/some-pkg/setup.py",
                "node_modules/other/Cargo.toml",
                "target/debug/build/go.mod",
                ".venv/lib/pyproject.toml",
            ],
        );
        let langs: Vec<_> = detect_project_languages(&repo).into_iter().collect();
        assert_eq!(langs, vec![ProjectLanguage::TypeScript]);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn detect_project_languages_empty_for_a_repo_with_no_manifests() {
        let repo = fixture_repo("docs-only", &["README.md", "docs/guide.md"]);
        assert!(detect_project_languages(&repo).is_empty());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn detect_project_languages_handles_a_missing_path() {
        // An unreadable/absent root yields an empty set, never a panic — the scan is best-effort.
        assert!(detect_project_languages(Path::new("/nonexistent/sparkle/repo")).is_empty());
    }

    #[test]
    fn detect_project_languages_stops_below_the_depth_limit() {
        // Deeper than MAX_SCAN_DEPTH (3) directory levels is out of scope; the bound is what keeps
        // detection from turning into a full-tree walk on a large repo.
        let repo = fixture_repo("too-deep", &["a/b/c/d/e/Cargo.toml"]);
        assert!(detect_project_languages(&repo).is_empty());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn should_skip_scan_dir_skips_hidden_deps_and_xcode_bundles() {
        for name in [".git", ".venv", "node_modules", "target", "App.xcodeproj", "Pods"] {
            assert!(should_skip_scan_dir(name), "{name} must be skipped");
        }
        for name in ["src", "apps", "packages", "services"] {
            assert!(!should_skip_scan_dir(name), "{name} must be scanned");
        }
    }

    #[test]
    fn project_language_keys_round_trip() {
        for lang in ProjectLanguage::ALL {
            assert_eq!(ProjectLanguage::from_key(lang.key()), Some(lang));
        }
        // Aliases a caller or a hand-edited config plausibly uses.
        assert_eq!(ProjectLanguage::from_key("TypeScript"), Some(ProjectLanguage::TypeScript));
        assert_eq!(ProjectLanguage::from_key("js"), Some(ProjectLanguage::TypeScript));
        assert_eq!(ProjectLanguage::from_key("golang"), Some(ProjectLanguage::Go));
        assert_eq!(ProjectLanguage::from_key("cobol"), None);
    }

    // ── LSP: server mapping + paths ───────────────────────────────────────────────────────────

    #[test]
    fn every_language_maps_to_a_server_and_back() {
        for lang in ProjectLanguage::ALL {
            let server = LspServer::for_language(lang);
            assert_eq!(server.language(), lang, "{lang:?} round-trip");
            assert!(!server.key().is_empty());
            assert!(!server.primary_binary().is_empty());
        }
        assert_eq!(LspServer::all().len(), ProjectLanguage::ALL.len());
    }

    #[test]
    fn only_the_npm_distributed_servers_are_auto_installable() {
        // The two tiers are a load-bearing distinction: `install_lsp_server` must refuse anything
        // needing a toolchain we don't manage (rustup / Go / Xcode) rather than half-installing it.
        assert!(LspServer::TypeScriptLanguageServer.auto_installable());
        assert!(LspServer::Pyright.auto_installable());
        for s in [LspServer::RustAnalyzer, LspServer::Gopls, LspServer::SourceKitLsp] {
            assert!(!s.auto_installable(), "{s:?} has no installer yet");
            assert!(s.linked_binaries().is_empty(), "{s:?} has nothing of ours to link");
        }
    }

    #[test]
    fn plugin_names_match_the_official_marketplace() {
        // Verified against Claude Code's official marketplace `plugins/` listing. If these drift,
        // the wiring task enables a plugin that doesn't exist and LSP silently never turns on.
        assert_eq!(LspServer::TypeScriptLanguageServer.claude_plugin(), "typescript-lsp");
        assert_eq!(LspServer::Pyright.claude_plugin(), "pyright-lsp");
        assert_eq!(LspServer::RustAnalyzer.claude_plugin(), "rust-analyzer-lsp");
        assert_eq!(LspServer::Gopls.claude_plugin(), "gopls-lsp");
        assert_eq!(LspServer::SourceKitLsp.claude_plugin(), "swift-lsp");
    }

    #[test]
    fn pyright_detection_targets_the_language_server_entry_point() {
        // `pyright` is the CLI type-checker; `pyright-langserver` is the stdio LSP binary Claude
        // Code drives. Detecting the wrong one would report "installed" for a pip install that
        // ships only the CLI.
        assert_eq!(LspServer::Pyright.primary_binary(), "pyright-langserver");
        assert!(LspServer::Pyright.linked_binaries().contains(&"pyright-langserver"));
    }

    #[test]
    fn gopls_version_uses_the_subcommand_not_a_flag() {
        // `gopls --version` is not a thing; `gopls version` is. Getting this wrong reports every
        // installed gopls as version-unknown.
        assert_eq!(LspServer::Gopls.version_args(), Some(&["version"][..]));
        assert_eq!(
            LspServer::TypeScriptLanguageServer.version_args(),
            Some(&["--version"][..])
        );
        // sourcekit-lsp is deliberately never probed — a bare invocation is a stdio LSP server.
        assert_eq!(LspServer::SourceKitLsp.version_args(), None);
    }

    #[test]
    fn known_lsp_paths_prefer_the_managed_prefix_then_local_bin() {
        let home = PathBuf::from("/Users/x");
        let paths = known_lsp_paths_for(LspServer::TypeScriptLanguageServer, Some(home.clone()));
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert_eq!(
            strs[0],
            "/Users/x/.local/share/sparkle/lsp/bin/typescript-language-server"
        );
        assert_eq!(strs[1], "/Users/x/.local/bin/typescript-language-server");
        assert!(strs.contains(&"/opt/homebrew/bin/typescript-language-server".to_string()));
    }

    #[test]
    fn known_lsp_paths_include_the_per_toolchain_user_dirs() {
        let home = Some(PathBuf::from("/Users/x"));
        let ra = known_lsp_paths_for(LspServer::RustAnalyzer, home.clone());
        assert!(ra.contains(&PathBuf::from("/Users/x/.cargo/bin/rust-analyzer")));
        let gopls = known_lsp_paths_for(LspServer::Gopls, home);
        assert!(gopls.contains(&PathBuf::from("/Users/x/go/bin/gopls")));
        // …and those dirs belong ONLY to their own server.
        assert!(!gopls.iter().any(|p| p.to_string_lossy().contains(".cargo")));
    }

    #[test]
    fn known_lsp_paths_handle_no_home() {
        let paths = known_lsp_paths_for(LspServer::Pyright, None);
        assert!(paths.iter().any(|p| p.ends_with("opt/homebrew/bin/pyright-langserver")));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains(".local")));
    }

    #[test]
    fn lsp_prefix_is_a_sparkle_owned_dir_under_local_share() {
        let home = Path::new("/Users/x");
        assert_eq!(
            lsp_npm_prefix_for(home),
            PathBuf::from("/Users/x/.local/share/sparkle/lsp")
        );
        assert_eq!(
            lsp_managed_bin_dir_for(home),
            PathBuf::from("/Users/x/.local/share/sparkle/lsp/bin")
        );
    }

    #[test]
    fn known_npm_paths_mirror_the_node_install_locations() {
        // npm is symlinked beside node by install_node, so their candidate lists must agree — else
        // we resolve a node we installed and an npm from somewhere else.
        let home = Some(PathBuf::from("/Users/x"));
        let npm = known_npm_paths_for(home.clone());
        let node = known_node_paths_for(home);
        assert_eq!(npm.len(), node.len());
        assert_eq!(npm[0], PathBuf::from("/Users/x/.local/bin/npm"));
        for (n, d) in npm.iter().zip(node.iter()) {
            assert_eq!(n.parent(), d.parent(), "npm and node must come from the same dirs");
        }
    }

    #[test]
    fn path_with_dir_first_prepends_and_is_idempotent() {
        let dir = Path::new("/Users/x/.local/bin");
        assert_eq!(
            path_with_dir_first(dir, Some("/usr/bin:/bin")),
            "/Users/x/.local/bin:/usr/bin:/bin"
        );
        // A re-run must not keep growing the PATH.
        let once = path_with_dir_first(dir, Some("/usr/bin:/bin"));
        assert_eq!(path_with_dir_first(dir, Some(&once)), once);
        // Empty/absent PATH degrades to just the dir.
        assert_eq!(path_with_dir_first(dir, None), "/Users/x/.local/bin");
        assert_eq!(path_with_dir_first(dir, Some("   ")), "/Users/x/.local/bin");
        // A dir that merely PREFIXES an existing entry is still prepended (not a false match).
        assert_eq!(
            path_with_dir_first(Path::new("/usr"), Some("/usr/bin:/bin")),
            "/usr:/usr/bin:/bin"
        );
    }

    #[test]
    fn lsp_server_status_never_claims_an_uninstalled_server() {
        // Resolves through the shared cache — see LSP_CACHE_TEST_LOCK.
        let _guard = LSP_CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Whatever this machine has, the report must be internally consistent: no path ⇒ not
        // installed, not managed, no version. (A false "installed" makes the UI skip an install the
        // user needs, and Claude Code then silently runs with no LSP.)
        for server in LspServer::all() {
            let status = lsp_server_status(server, false);
            assert_eq!(status.installed, status.path.is_some(), "{server:?}");
            if status.path.is_none() {
                assert!(!status.managed, "{server:?} can't be managed with no path");
            }
            assert_eq!(status.auto_installable, server.auto_installable());
            assert_eq!(status.plugin, server.claude_plugin());
        }
    }

    /// `managed` used to be a STRING comparison against `managed_lsp_server_path`, so the
    /// `~/.local/bin` SYMLINK we create for our own installs never matched — the flag read false for
    /// Sparkle's installs whenever `~/.local/bin` was on the login PATH and true only when it
    /// wasn't. Real temp-dir symlinks, because that is the whole failure.
    #[cfg(unix)]
    #[test]
    fn managed_follows_the_symlink_instead_of_string_matching_the_prefix() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("sparkle-managed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let prefix = lsp_npm_prefix_for(&home);
        let managed_bin = lsp_managed_bin_dir_for(&home);
        let local_bin = home.join(".local/bin");
        std::fs::create_dir_all(&managed_bin).unwrap();
        std::fs::create_dir_all(&local_bin).unwrap();

        let target = managed_bin.join("typescript-language-server");
        std::fs::write(&target, "#!/bin/sh\n").unwrap();

        // The managed copy itself is obviously ours.
        assert!(is_managed_lsp_path(&target, &prefix));

        // THE REGRESSION: the `~/.local/bin` symlink we create is also ours, even though its path
        // string shares nothing with the managed prefix.
        let link = local_bin.join("typescript-language-server");
        symlink(&target, &link).unwrap();
        assert!(
            is_managed_lsp_path(&link, &prefix),
            "our own ~/.local/bin symlink must read as managed"
        );

        // A RELATIVE link is resolved against the link's own directory, not the process cwd.
        let rel = local_bin.join("rel-tsserver");
        symlink(Path::new("../share/sparkle/lsp/bin/typescript-language-server"), &rel).unwrap();
        assert!(is_managed_lsp_path(&rel, &prefix), "a relative link of ours is still ours");

        // A DANGLING link of ours still reads as ours — read_link, not canonicalize alone.
        let dangling = local_bin.join("gone");
        symlink(managed_bin.join("removed"), &dangling).unwrap();
        assert!(is_managed_lsp_path(&dangling, &prefix));

        // The user's OWN binary is NOT ours, and neither is a link pointing at it.
        let foreign = root.join("brew-bin");
        std::fs::create_dir_all(&foreign).unwrap();
        let foreign_bin = foreign.join("typescript-language-server");
        std::fs::write(&foreign_bin, "#!/bin/sh\n").unwrap();
        assert!(!is_managed_lsp_path(&foreign_bin, &prefix));
        let foreign_link = local_bin.join("foreign");
        symlink(&foreign_bin, &foreign_link).unwrap();
        assert!(!is_managed_lsp_path(&foreign_link, &prefix));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// pyright ships two entry points and only the CLI answers `--version`; `pyright-langserver`
    /// (the primary binary) does not implement the flag, so probing it yields "version unknown"
    /// forever or starts a language server that burns the timeout.
    #[test]
    fn the_pyright_version_probe_targets_the_cli_not_the_language_server() {
        assert_eq!(LspServer::Pyright.version_binary(), Some("pyright"));
        // And the CLI is one we actually link, so it's there to probe.
        assert!(LspServer::Pyright.linked_binaries().contains(&"pyright"));
        for other in LspServer::all().into_iter().filter(|s| *s != LspServer::Pyright) {
            assert_eq!(other.version_binary(), None, "{other:?} probes its own binary");
        }

        let root = std::env::temp_dir().join(format!("sparkle-pyright-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let langserver = root.join("pyright-langserver");
        std::fs::write(&langserver, "#!/bin/sh\n").unwrap();

        // No sibling CLI → no probe at all, rather than asking a binary that can't answer.
        assert_eq!(version_probe_path(LspServer::Pyright, &langserver), None);

        // With the CLI next to it, THAT is what gets asked — and it's the copy that sits beside the
        // server we just reported, not some other pyright off PATH.
        let cli = root.join("pyright");
        std::fs::write(&cli, "#!/bin/sh\n").unwrap();
        assert_eq!(version_probe_path(LspServer::Pyright, &langserver), Some(cli));

        // Every other server probes itself.
        let gopls = root.join("gopls");
        assert_eq!(
            version_probe_path(LspServer::Gopls, &gopls),
            Some(gopls.clone()),
            "a server with no separate CLI is probed directly"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The per-project command runs on every project open; a version probe is a process spawn with a
    /// 20s ceiling per server and answers a question that path never asks.
    #[test]
    fn the_per_project_preflight_does_not_pay_for_version_probes() {
        let _guard = LSP_CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let status = lsp_server_status(LspServer::Gopls, false);
        assert!(status.version.is_none(), "with_version:false must not probe");
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

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

/// Clear the cached claude/node paths so the next resolve re-probes (e.g. the user moved/reinstalled
/// a toolchain while the app was running). Note that a "not installed" result is never cached in the
/// first place, so a fresh install is already picked up without calling this.
pub fn invalidate_preflight_caches() {
    if let Ok(mut g) = claude_path_cache().lock() {
        *g = None;
    }
    if let Ok(mut g) = node_path_cache().lock() {
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
        let latest =
            crate::claude::claude_latest_session_id(worktree_path.clone(), config_dir.clone());
        let has_session = crate::claude::claude_has_session(worktree_path, config_dir);
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
    fn known_node_paths_handles_no_home() {
        let paths = super::known_node_paths_for(None);
        // No home → no ~/.local entry, but the system locations are still present.
        assert!(paths.iter().any(|p| p.ends_with("opt/homebrew/bin/node")));
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

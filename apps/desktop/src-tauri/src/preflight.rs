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

use serde::Serialize;

#[derive(Serialize)]
pub struct ClaudeStatus {
    installed: bool,
    /// Absolute path to the claude binary (pass this to pty_spawn to avoid PATH issues).
    path: Option<String>,
    version: Option<String>,
}

fn login_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

fn run_in_login_shell(script: &str) -> Option<String> {
    Command::new(login_shell())
        .args(["-lc", script])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Canonical absolute locations the official installers use, in priority order.
/// Covers the native installer (`~/.local/bin`), the legacy local install
/// (`~/.claude/local`), and homebrew/npm global prefixes.
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
pub fn resolve_node_path() -> Option<String> {
    run_in_login_shell("command -v node")
        .filter(|p| Path::new(p).is_absolute() && is_executable(Path::new(p)))
        .or_else(|| {
            first_executable(&known_node_paths_for(
                std::env::var_os("HOME").map(PathBuf::from),
            ))
        })
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
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// First candidate that exists and is executable, as an absolute path string.
fn first_executable(candidates: &[PathBuf]) -> Option<String> {
    candidates
        .iter()
        .find(|p| is_executable(p))
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn claude_preflight() -> ClaudeStatus {
    // 1. Login-shell PATH probe — handles npm/homebrew and any install whose dir
    //    is exported from `.zprofile`/`.zshenv`/`path_helper`.
    // 2. Fallback to canonical absolute paths — handles the native installer
    //    (`~/.local/bin`), whose PATH entry lives in the interactive-only `.zshrc`.
    let path = run_in_login_shell("command -v claude")
        .or_else(|| first_executable(&known_claude_paths()));
    let version = path
        .as_ref()
        .and_then(|p| run_in_login_shell(&format!("'{p}' --version")));
    ClaudeStatus { installed: path.is_some(), path, version }
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
}

//! Preflight checks. Detects whether the user's own `claude` (Claude Code) is
//! installed, resolving it via the LOGIN shell — macOS GUI apps don't inherit the
//! shell PATH, so `claude` (installed via npm/homebrew) won't be found otherwise.

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

#[tauri::command]
pub fn claude_preflight() -> ClaudeStatus {
    let path = run_in_login_shell("command -v claude");
    let version = path
        .as_ref()
        .and_then(|p| run_in_login_shell(&format!("'{p}' --version")));
    ClaudeStatus { installed: path.is_some(), path, version }
}

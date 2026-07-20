//! Dev-vs-production identity isolation.
//!
//! DEBUG builds of the app (every `cargo build` / `tauri dev` build — what agents run to verify
//! changes) are adhoc/linker-signed yet share the bundle identifier `ai.sparkle.desktop` with the
//! installed, Developer-ID-signed production app. Without isolation a throwaway dev build reads and
//! writes the PRODUCTION app-data dir, log dir, and keychain item — corrupting live workspace state
//! and popping a macOS keychain prompt (the signed app owns the keychain ACL; the adhoc binary does
//! not match it, so macOS asks the user to authorize "ai.sparkle.desktop").
//!
//! Fix: in DEBUG builds ONLY, suffix the app-data dir, log dir, and keychain service with `-dev`, so
//! dev runs get their own isolated `ai.sparkle.desktop-dev` identity. The RELEASE notarized DMG
//! (`debug_assertions` off) is byte-for-byte unchanged.
//!
//! Intentionally left SHARED between dev and release (harmless in dev, and per-build churn buys no
//! isolation): the notification bundle id (`attention.rs`) and the `ai.sparkle.desktop.auth`
//! deep-link URL scheme (`Info.plist`). Neither touches persistent state.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

/// Base (production) identity — the keychain service and the final path component of the app-data
/// and log dirs all share this value in release builds.
const BASE_IDENTITY: &str = "ai.sparkle.desktop";

/// True in DEBUG builds (`cargo build` / `tauri dev`), false in the RELEASE notarized DMG. The
/// single axis separating a throwaway dev build from the shipped app.
#[inline]
pub fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// Append the `-dev` suffix to `base` when `is_dev`, else return it unchanged. Pure.
fn apply_dev_suffix(base: &str, is_dev: bool) -> String {
    if is_dev {
        format!("{base}-dev")
    } else {
        base.to_string()
    }
}

/// Suffix ONLY the final component of `path` (the identity segment), leaving the parent untouched:
/// `~/Library/Application Support/ai.sparkle.desktop` -> `.../ai.sparkle.desktop-dev`. Pure. If the
/// path has no final component or it is non-UTF8, it is returned unchanged (nothing safe to rename).
fn apply_dev_suffix_path(path: &Path, is_dev: bool) -> PathBuf {
    if !is_dev {
        return path.to_path_buf();
    }
    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => {
            let renamed = format!("{name}-dev");
            match path.parent() {
                Some(parent) => parent.join(renamed),
                None => PathBuf::from(renamed),
            }
        }
        None => path.to_path_buf(),
    }
}

/// The macOS keychain service name for THIS build: `ai.sparkle.desktop` (release) or
/// `ai.sparkle.desktop-dev` (debug). Both `auth.rs` and `trial_remote.rs` route through this so a
/// dev build never touches the production keychain item's ACL (no confidential-info prompt).
pub fn keychain_service() -> String {
    apply_dev_suffix(BASE_IDENTITY, is_dev())
}

/// Sparkle's per-user app-data dir for THIS build. Release: the Tauri default
/// (`~/Library/Application Support/ai.sparkle.desktop`). Debug: the `-dev` sibling, so dev runs get
/// their own isolated worktrees / orchestration state / history and never mutate production.
pub fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("no app data dir: {e}"))?;
    Ok(apply_dev_suffix_path(&base, is_dev()))
}

/// Sparkle's per-user log dir for THIS build (`~/Library/Logs/ai.sparkle.desktop[-dev]`). Debug
/// builds log to the `-dev` sibling so they don't pollute the production log the user reads.
pub fn app_log_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_log_dir().map_err(|e| format!("no app log dir: {e}"))?;
    Ok(apply_dev_suffix_path(&base, is_dev()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_str_only_in_dev() {
        assert_eq!(apply_dev_suffix("ai.sparkle.desktop", false), "ai.sparkle.desktop");
        assert_eq!(apply_dev_suffix("ai.sparkle.desktop", true), "ai.sparkle.desktop-dev");
    }

    #[test]
    fn suffix_path_touches_only_final_component() {
        let p = Path::new("/Users/x/Library/Application Support/ai.sparkle.desktop");
        assert_eq!(apply_dev_suffix_path(p, false), p.to_path_buf());
        assert_eq!(
            apply_dev_suffix_path(p, true),
            PathBuf::from("/Users/x/Library/Application Support/ai.sparkle.desktop-dev")
        );
    }

    #[test]
    fn suffix_path_log_dir_sibling() {
        let p = Path::new("/Users/x/Library/Logs/ai.sparkle.desktop");
        assert_eq!(
            apply_dev_suffix_path(p, true),
            PathBuf::from("/Users/x/Library/Logs/ai.sparkle.desktop-dev")
        );
    }

    #[test]
    fn suffix_path_noop_on_root() {
        assert_eq!(apply_dev_suffix_path(Path::new("/"), true), PathBuf::from("/"));
    }

    #[test]
    fn keychain_service_is_dev_suffixed_under_test() {
        // Tests compile with debug_assertions on, so this build's service is the dev-suffixed one.
        assert_eq!(keychain_service(), "ai.sparkle.desktop-dev");
    }
}

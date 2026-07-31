// Stale-build detection (bead sparkle-jeen).
//
// THE TRAP: the running app is an embedded, non-hot-reloading process. When the auto-updater (or a
// hand-drag install) replaces the .app on disk, the OLD process keeps running until the user
// restarts. That reliably produces the most expensive support-report class — "I already asked for
// this to be fixed" — because a bug fixed in the shipped binary is still present in the running one.
//
// This module gathers the facts a "Restart to finish updating" banner needs. The RUNNING side is
// two compile-time constants baked into THIS binary:
//   - version: `app.package_info().version` (from tauri.conf.json), and
//   - sha:     `SPARKLE_GIT_SHA`, embedded by build.rs (bead sparkle-cehe).
// The INSTALLED side is read from the bundle on disk at `/Applications/Sparkle.app`:
//   - version: `CFBundleShortVersionString` from its Info.plist (reliably readable — Tauri writes it).
//   - sha:     NOT stored in the plist today. The commit SHA lives only as a compile-time constant
//              inside the Mach-O binary, so it cannot be read off disk without executing that binary
//              — which is exactly the process we're trying NOT to depend on. So `installed_sha` is
//              `None` for now; the field (and the JS predicate) are carried so that the day the build
//              stamps the SHA into the plist, SHA-level detection lights up with no client change.
//              See PRD/sparkle/stale-build-banner.md.
//
// The version comparison is the reliable signal and drives the banner. The mtime-vs-process-start
// pair is the bead's "minimum viable" fallback for the bug-report template: an installed bundle
// whose mtime is AFTER this process's start time is corroborating evidence a newer build landed on
// disk mid-session. The banner predicate does NOT use mtime (a re-sign / xattr touch bumps mtime
// without changing the build); it's diagnostic only.
//
// PLATFORM: the installed-bundle reads are macOS-only (`defaults`, `ps`, /Applications). Every one
// is `#[cfg(target_os = "macos")]` with a non-macOS stub returning the degraded (`None`) shape, so
// the whole module still COMPILES on the Windows CI target — `stale_build_probe` there returns the
// running side plus `None` for everything read off disk.

use serde::Serialize;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Runtime};

/// The canonical install location we compare against (bead sparkle-jeen names it explicitly).
const INSTALLED_APP_PATH: &str = "/Applications/Sparkle.app";

/// The git SHA THIS binary was built from (SPARKLE_GIT_SHA, embedded at compile time by build.rs;
/// bead sparkle-cehe). "unknown" when git was unavailable at build (e.g. a tarball build). Read
/// directly from the compile-time env here rather than via `bridge::running_build_sha()` because
/// that module is `#[cfg(unix)]` (its Windows twin has no such fn) and this must compile everywhere;
/// the two definitions are intentionally identical.
fn running_build_sha() -> &'static str {
    option_env!("SPARKLE_GIT_SHA").unwrap_or("unknown")
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StaleBuildProbe {
    /// Version of the RUNNING process (compile-time, from tauri.conf.json).
    pub running_version: String,
    /// Commit SHA of the RUNNING process (compile-time SPARKLE_GIT_SHA; "unknown" for tarball builds).
    pub running_sha: String,
    /// `CFBundleShortVersionString` read from the installed bundle's Info.plist. `None` when the
    /// bundle isn't at `/Applications` (dev run, DMG launched from Downloads), off macOS, or unreadable.
    pub installed_version: Option<String>,
    /// Installed commit SHA. `None` today — not stored on disk (see module docs); future-proofed.
    pub installed_sha: Option<String>,
    /// mtime of the installed .app bundle, ms since epoch. Bug-report fallback only.
    pub installed_mtime_ms: Option<u64>,
    /// This process's start time, ms since epoch. Bug-report fallback companion to the mtime.
    pub running_started_ms: Option<u64>,
    /// The bundle path probed, so a ticket records WHICH install was compared.
    pub installed_path: String,
}

fn installed_app_path() -> PathBuf {
    PathBuf::from(INSTALLED_APP_PATH)
}

/// Read `CFBundleShortVersionString` from an installed macOS bundle's Info.plist. Uses `defaults`
/// (handles both XML and binary plists, which a built .app usually is) so we need no plist crate.
/// Returns `None` off macOS, when the bundle is absent, or when the key is missing/empty.
#[cfg(target_os = "macos")]
fn read_installed_version(app_path: &std::path::Path) -> Option<String> {
    // `defaults read <path-without-extension> KEY` — the arg is the Info.plist path minus ".plist".
    let info = app_path.join("Contents/Info");
    let out = std::process::Command::new("/usr/bin/defaults")
        .arg("read")
        .arg(&info)
        .arg("CFBundleShortVersionString")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(not(target_os = "macos"))]
fn read_installed_version(_app_path: &std::path::Path) -> Option<String> {
    None
}

/// mtime of `path` as ms since the Unix epoch. `None` when the path is missing or the clock is odd.
/// Cross-platform (used in every `probe`).
fn mtime_ms(path: &std::path::Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

#[cfg(target_os = "macos")]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse the integer seconds printed by `ps -o etimes=` (elapsed run time). The column can carry
/// leading whitespace; anything non-numeric yields `None` so a `ps` quirk never fabricates a time.
/// macOS-only (its sole caller is the macOS `process_started_ms`).
#[cfg(target_os = "macos")]
fn parse_etimes(raw: &str) -> Option<u64> {
    raw.trim().parse::<u64>().ok()
}

/// This process's start time, ms since epoch, derived from `ps -o etimes=` (seconds since start).
/// macOS-only; `None` anywhere the command isn't available or its output doesn't parse.
#[cfg(target_os = "macos")]
fn process_started_ms() -> Option<u64> {
    let pid = std::process::id().to_string();
    let out = std::process::Command::new("/bin/ps")
        .arg("-o")
        .arg("etimes=")
        .arg("-p")
        .arg(&pid)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let elapsed_s = parse_etimes(&String::from_utf8_lossy(&out.stdout))?;
    Some(now_ms().saturating_sub(elapsed_s.saturating_mul(1000)))
}

#[cfg(not(target_os = "macos"))]
fn process_started_ms() -> Option<u64> {
    None
}

/// Gather the running-vs-installed build facts. Pure-ish: every disk/`ps` read degrades to `None`
/// rather than failing, so the command never throws into the UI.
pub fn probe<R: Runtime>(app: &AppHandle<R>) -> StaleBuildProbe {
    let app_path = installed_app_path();
    StaleBuildProbe {
        running_version: app.package_info().version.to_string(),
        running_sha: running_build_sha().to_string(),
        installed_version: read_installed_version(&app_path),
        installed_sha: None,
        installed_mtime_ms: mtime_ms(&app_path),
        running_started_ms: process_started_ms(),
        installed_path: app_path.to_string_lossy().to_string(),
    }
}

/// Tauri command: the frontend polls this on an interval and feeds it to the pure JS `isStaleBuild`
/// predicate (staleBuildService.ts) to decide whether to show the "Restart to finish updating"
/// banner.
///
/// ── RUNS ON THE BLOCKING POOL ─────────────────────────────────────────────────────────────────
/// This doc used to say "Cheap — a couple of stat/`defaults`/`ps` calls — so an interval poll is
/// fine." Two of those three are `Command::output()`: a full fork/exec of `/usr/bin/defaults` and
/// of `/bin/ps`, each WAITED on. Process creation from a large-RSS app is not cheap, and on a cold
/// cache Gatekeeper/`amfid` can push `defaults` past 100 ms. As a plain `#[tauri::command]` those
/// two spawns ran inline on the AppKit main thread, on a timer AND on every window refocus.
/// "Cheap" was the unexamined word; `sparkle-rfhu5` records that the same word hid three defects.
///
/// A join failure degrades to a probe with the compile-time fields populated and the installed-side
/// fields unknown, preserving this module's stated contract that it "never throws into the UI".
#[tauri::command]
pub async fn stale_build_probe<R: Runtime>(app: AppHandle<R>) -> StaleBuildProbe {
    // `package_info()` is an in-memory read of a struct Tauri built at startup — no syscall — so it
    // is safe to take here and gives the fallback something truthful to report.
    let running_version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || probe(&app)).await.unwrap_or_else(|_| {
        StaleBuildProbe {
            running_version,
            running_sha: running_build_sha().to_string(),
            installed_version: None,
            installed_sha: None,
            installed_mtime_ms: None,
            running_started_ms: None,
            installed_path: installed_app_path().to_string_lossy().into_owned(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The etimes parser is macOS-only (so is its sole caller), so its tests are too.
    #[cfg(target_os = "macos")]
    #[test]
    fn parse_etimes_reads_plain_and_padded_seconds() {
        assert_eq!(parse_etimes("42"), Some(42));
        // ps right-pads the column; leading whitespace must not defeat the parse.
        assert_eq!(parse_etimes("   1337\n"), Some(1337));
        assert_eq!(parse_etimes("0"), Some(0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_etimes_rejects_nonnumeric() {
        assert_eq!(parse_etimes(""), None);
        assert_eq!(parse_etimes("   \n"), None);
        // A wall-clock "elapsed" format (dd-hh:mm:ss) is NOT etimes; refuse it rather than misread.
        assert_eq!(parse_etimes("01-02:03:04"), None);
        assert_eq!(parse_etimes("abc"), None);
    }

    #[test]
    fn installed_app_path_is_the_applications_bundle() {
        assert_eq!(installed_app_path(), PathBuf::from("/Applications/Sparkle.app"));
    }

    #[test]
    fn mtime_ms_is_none_for_a_missing_path() {
        assert_eq!(mtime_ms(std::path::Path::new("/no/such/bundle.app")), None);
    }

    #[test]
    fn running_build_sha_is_unknown_or_a_real_value() {
        // Unstamped test builds have no SPARKLE_GIT_SHA, so this is "unknown"; a stamped build
        // yields the real SHA. Either way it's non-empty — the JS predicate treats "unknown" as
        // "no identity" (never a mismatch).
        assert!(!running_build_sha().is_empty());
    }
}

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
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
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

/// The `.app` bundle an executable lives inside: the nearest ancestor whose name ends in `.app`.
/// `None` for a binary with no such ancestor — `cargo run`, `cargo test`, a Windows `.exe`.
///
/// PURE, and taking the exe path as an argument, because this is the half of
/// [`bundle_replaced_since_launch_now`] that decides WHICH bundle gets stat'd.
fn app_bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        .map(Path::to_path_buf)
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

/// Was the installed bundle replaced on disk AFTER this process started? PURE — the two facts are
/// passed in, so the decision is unit-testable without a filesystem or a `ps`.
///
/// Unknown on either side is `false`: a missing bundle (dev run, DMG launched from Downloads) or an
/// unreadable start time is not evidence that a swap happened, and inventing one here would put the
/// "quit and reopen" story in front of a user whose microphone is dead for an ordinary reason.
///
/// ── WHY MTIME AND NOT A VERSION COMPARISON ────────────────────────────────────────────────────
/// The TCC microphone grant is keyed to CODE IDENTITY at a path, not to a version string. A
/// same-version rebuild, or a re-sign of the identical version, invalidates the running process's
/// grant exactly as a version bump does. mtime is the only fact available off disk that covers all
/// three, and `install_inner` (tauri-plugin-updater) always `touch`es the bundle after swapping it
/// in — so a real swap ALWAYS stamps the mtime. A version comparison would add zero true positives
/// (the touch already guarantees the mtime moves) and one PERMANENT false positive: the
/// side-by-side case, where a dev build or a DMG runs from somewhere other than /Applications while
/// /Applications holds a different release, where a version comparison would report "replaced"
/// forever. So this deliberately does NOT `||` in a version mismatch.
///
/// The side-by-side case is handled by probing the RIGHT BUNDLE, not by hoping /Applications is
/// never written: see [`bundle_replaced_for`]. This function is only the comparison — it is told
/// which mtime to use.
///
/// NO TIME MARGIN, and that is deliberate too: `process_started_ms` derives from `ps -o etimes=`,
/// which truncates to whole seconds, so it OVER-estimates the start time by up to 999 ms. The
/// comparison is therefore already biased fail-closed — a swap in the same second as launch reads
/// as "not replaced" rather than the other way round.
///
/// ── THIS IS NOT stale_build.rs:21-25 CONTRADICTING ITSELF ─────────────────────────────────────
/// The module docs above say the BANNER predicate deliberately excludes mtime, and that reasoning
/// is correct FOR THAT PREDICATE and does not transfer. `isStaleBuild` runs hourly against a
/// healthy app and gates worker spawn (workerSpawn.ts:102-111 THROWS on it), so a false positive
/// there is expensive. This one runs only inside `FaultAction::Report` — after `is_stale_grant` has
/// already established not-muted, not-virtual, `zero_source == Os` and `tcc == Authorized`. We are
/// not deciding whether anything is wrong; we are choosing between two explanations for a fault
/// that ALREADY happened, and one of the two remedies is free.
pub fn bundle_replaced_since_launch(
    installed_mtime_ms: Option<u64>,
    running_started_ms: Option<u64>,
) -> bool {
    match (installed_mtime_ms, running_started_ms) {
        (Some(m), Some(s)) => m > s,
        _ => false,
    }
}

/// This process's start time, gathered once. Process start is IMMUTABLE, so caching it is not just
/// an optimization: it also removes the per-call jitter of re-running `ps -o etimes=`, whose
/// whole-second truncation would otherwise make the same launch resolve to a slightly different
/// millisecond on every read.
///
/// `OnceLock<u64>`, NOT `OnceLock<Option<u64>>`: the latter memoizes a FAILURE just as permanently
/// as a success, and the failure mode is a `/bin/ps` fork that did not happen — most likely under
/// exactly the memory/load pressure that accompanies an incident. One such miss would disable
/// bundle-swap detection for the whole process lifetime, silently and with nothing logged.
static PROCESS_STARTED_MS: OnceLock<u64> = OnceLock::new();

/// Memoize ONLY a `Some`. The seam takes the cell and the reader so a test can drive the property
/// that matters — a failed read is RETRIED on the next call, a successful one never is.
fn started_ms_memo(cell: &OnceLock<u64>, read: impl FnOnce() -> Option<u64>) -> Option<u64> {
    if let Some(v) = cell.get() {
        return Some(*v);
    }
    let v = read()?;
    Some(*cell.get_or_init(|| v))
}

/// The decision behind [`bundle_replaced_since_launch_now`], with every impure input injected: the
/// executable this process was exec'd as, its start time, and how to read an mtime.
///
/// THE BUNDLE PROBED IS THE ONE THIS PROCESS RUNS FROM, not the hard-coded `/Applications` path —
/// the question is "was MY bundle replaced under me", and `/Applications` is written during an
/// ordinary session by the OTHER copy's own hourly auto-update. A DMG copy running from
/// `~/Downloads`, or a dev build outliving the release copy's update, would otherwise both read as
/// "replaced" with the running binary's code identity untouched — handing the user a confidently
/// wrong cause and a remedy (quit and reopen) that cannot fix their fault.
///
/// The TRUE POSITIVE survives: `_NSGetExecutablePath` returns the path recorded at exec, so after a
/// real in-place swap `current_exe()` STILL resolves to the replaced bundle. Only the side-by-side
/// case changes, and it changes to a correct negative.
///
/// THE `.app`-LESS CASE IS A NEGATIVE, NOT A FALLBACK (roborev 67429). When `current_exe()`
/// SUCCEEDS and the path has no `.app` ancestor we know with certainty this process is not running
/// from `/Applications/Sparkle.app`, so statting that bundle would reintroduce the exact false
/// positive this function exists to remove. `tauri dev` / `cargo run` produces precisely that shape
/// (a bare `target/debug/sparkle`), and the release copy's own hourly auto-update then writes
/// `/Applications` mid-session — the very trigger this change is about. Such a process cannot have
/// had its bundle swapped by the updater, so `false` is the correct answer, not a guess.
///
/// `installed_app_path()` remains the fallback ONLY for a `current_exe()` that failed, where we
/// genuinely cannot tell where we are running from and the installed path is the best guess left.
fn bundle_replaced_for(
    exe: Option<&Path>,
    running_started_ms: Option<u64>,
    mtime: &dyn Fn(&Path) -> Option<u64>,
) -> bool {
    let bundle = match exe {
        Some(exe) => match app_bundle_of(exe) {
            Some(bundle) => bundle,
            None => return false,
        },
        None => installed_app_path(),
    };
    bundle_replaced_since_launch(mtime(&bundle), running_started_ms)
}

/// [`bundle_replaced_since_launch`] against live facts: one `stat` of the installed bundle, plus
/// the cached process start.
///
/// DELIBERATELY NOT `probe()`. It needs no `AppHandle` and no `R: Runtime` generic (so it is
/// callable from the audio watchdog, which has neither), and it skips the `/usr/bin/defaults` fork
/// entirely — the expensive half of `probe`, and the one this decision has no use for.
///
/// SAFE TO CALL FROM THE WATCHDOG. `watchdog_tick` runs on the dedicated `audio-watchdog` thread
/// (dictation.rs:2983-3008), never the AppKit main thread, and the `Report` arm is latched by
/// `sess.audio_reported` — so this is ONE `stat` per fault, on a background thread, plus ONE FORK,
/// ONCE PER PROCESS, off the main thread. That last clause used to read "there is no fork here at
/// all", which was inaccurate: the first call forks `/bin/ps` through [`process_started_ms`]. The
/// THREAD is the real safeguard against the warning at stale_build.rs:107-113 about forking from a
/// large-RSS app on the main thread — a reader who took "no fork" at face value could call this from
/// the main thread, which is precisely what that warning forbids.
pub fn bundle_replaced_since_launch_now() -> bool {
    let started = started_ms_memo(&PROCESS_STARTED_MS, process_started_ms);
    bundle_replaced_for(std::env::current_exe().ok().as_deref(), started, &mtime_ms)
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

    /// The bundle-replaced predicate, at the boundary that decides which remedy a user is shown.
    ///
    /// STRICTLY GREATER, and the equal case is the assertion that pins it. `process_started_ms`
    /// truncates `ps -o etimes=` to whole seconds and therefore OVER-estimates the start time by up
    /// to 999 ms, so the comparison is already biased fail-closed; loosening it to `>=` would tip
    /// a same-millisecond reading — the launch-time stat of a bundle we ourselves just opened —
    /// into "we were replaced", which is the false positive this side of the boundary exists to
    /// exclude.
    #[test]
    fn bundle_replaced_only_when_the_install_is_strictly_newer_than_the_launch() {
        // A swap under a running process: the bundle's mtime postdates our start.
        assert!(bundle_replaced_since_launch(Some(2_000), Some(1_000)));
        // Installed BEFORE we launched — the ordinary healthy shape, and the side-by-side case
        // (a dev build running while /Applications holds an older release).
        assert!(!bundle_replaced_since_launch(Some(1_000), Some(2_000)));
        // EQUAL is not replaced. See the doc above: `>=` would make this true and would be wrong.
        assert!(!bundle_replaced_since_launch(Some(1_000), Some(1_000)));
    }

    /// Unknown is NOT evidence. Each of the three degraded readings has a real producer — no bundle
    /// at /Applications (dev run, DMG from Downloads), a `ps` that did not parse, and the non-macOS
    /// build where BOTH stubs return `None` — and in every one of them claiming a swap would put
    /// "Sparkle updated in the background, quit and reopen" in front of a user whose microphone is
    /// dead for a completely different reason.
    #[test]
    fn an_unknown_side_is_never_read_as_a_replacement() {
        assert!(!bundle_replaced_since_launch(None, Some(1_000)));
        assert!(!bundle_replaced_since_launch(Some(1_000), None));
        assert!(!bundle_replaced_since_launch(None, None));
    }

    /// FINDING 4. The predicate must answer "was MY bundle replaced under me", so it has to stat the
    /// bundle THIS process runs from. Statting the hard-coded `/Applications/Sparkle.app` instead
    /// turns every write to /Applications during the session — the OTHER copy's own hourly
    /// auto-update — into a confident, wrong "Sparkle updated in the background" story with a
    /// remedy (quit and reopen) that cannot fix the user's fault.
    #[test]
    fn a_bundle_running_from_elsewhere_is_not_replaced_by_a_write_to_slash_applications() {
        let started = Some(1_000);
        // /Applications got a NEW build 5 s into our session. Our own copy did not move.
        let stat = |p: &Path| -> Option<u64> {
            match p.to_string_lossy().as_ref() {
                "/Applications/Sparkle.app" => Some(6_000),
                "/Users/x/Downloads/Sparkle.app" => Some(500),
                _ => None,
            }
        };

        // THE CASE THAT MUST BE NEGATIVE: a DMG copy running from ~/Downloads.
        assert!(
            !bundle_replaced_for(
                Some(Path::new("/Users/x/Downloads/Sparkle.app/Contents/MacOS/Sparkle")),
                started,
                &stat,
            ),
            "a write to /Applications is not a replacement of the bundle we are running from"
        );

        // THE TRUE POSITIVE IS PRESERVED. `current_exe()` reports the path recorded at exec, so
        // after a real in-place swap it still names the bundle that was replaced.
        assert!(
            bundle_replaced_for(
                Some(Path::new("/Applications/Sparkle.app/Contents/MacOS/Sparkle")),
                started,
                &stat,
            ),
            "an in-place swap of OUR bundle is still detected"
        );

        // A KNOWN `.app`-LESS PATH IS A NEGATIVE, NOT A FALLBACK (roborev 67429). This assertion
        // used to expect `true` here, which pinned the very false positive the test above exists to
        // remove: `current_exe()` SUCCEEDED, so we know for certain this process is not running from
        // /Applications, and `tauri dev` / `cargo run` produces exactly this shape. Statting
        // /Applications anyway would tell a developer their bundle was swapped every time the
        // release copy auto-updated beside them.
        assert!(
            !bundle_replaced_for(Some(Path::new("/tmp/target/debug/sparkle")), started, &stat),
            "a dev build with no .app ancestor cannot have been swapped by the updater"
        );

        // A FAILED `current_exe()` still falls back to the installed path: there we genuinely cannot
        // tell where we are running from, and the installed bundle is the best guess left.
        assert!(
            bundle_replaced_for(None, started, &stat),
            "an unreadable current_exe() falls back to the installed path"
        );
    }

    #[test]
    fn the_app_bundle_is_the_nearest_dot_app_ancestor() {
        assert_eq!(
            app_bundle_of(Path::new("/Users/x/Downloads/Sparkle.app/Contents/MacOS/Sparkle")),
            Some(PathBuf::from("/Users/x/Downloads/Sparkle.app"))
        );
        // NEAREST, not outermost: a bundle nested inside another (a helper .app) belongs to itself.
        assert_eq!(
            app_bundle_of(Path::new("/A/Sparkle.app/Contents/Helpers/H.app/Contents/MacOS/H")),
            Some(PathBuf::from("/A/Sparkle.app/Contents/Helpers/H.app"))
        );
        assert_eq!(app_bundle_of(Path::new("/tmp/target/debug/sparkle")), None);
        assert_eq!(app_bundle_of(Path::new("/Applications/Sparkle.apple/x")), None);
    }

    /// FINDING 5. A `OnceLock<Option<u64>>` memoizes the FAILURE too, and the failure is a `/bin/ps`
    /// fork that did not happen — most likely under exactly the load that accompanies an incident.
    /// One miss would disable bundle-swap detection for the rest of the process lifetime, silently.
    #[test]
    fn a_failed_process_start_read_is_retried_rather_than_memoized() {
        static CELL: OnceLock<u64> = OnceLock::new();
        static READS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        use std::sync::atomic::Ordering;

        let bump = || READS.fetch_add(1, Ordering::Relaxed);

        assert_eq!(started_ms_memo(&CELL, || { bump(); None }), None, "the fork failed");
        assert_eq!(
            started_ms_memo(&CELL, || { bump(); Some(1_234) }),
            Some(1_234),
            "detection must come back, not stay dead for the process lifetime"
        );
        assert_eq!(READS.load(Ordering::Relaxed), 2, "the failure was retried, not sealed");

        // A SUCCESS is still sealed: process start is immutable, and re-reading `ps -o etimes=`
        // would re-truncate to a different millisecond on every call.
        assert_eq!(
            started_ms_memo(&CELL, || panic!("a successful read must never be repeated")),
            Some(1_234)
        );
        assert_eq!(READS.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn running_build_sha_is_unknown_or_a_real_value() {
        // Unstamped test builds have no SPARKLE_GIT_SHA, so this is "unknown"; a stamped build
        // yields the real SHA. Either way it's non-empty — the JS predicate treats "unknown" as
        // "no identity" (never a mismatch).
        assert!(!running_build_sha().is_empty());
    }
}

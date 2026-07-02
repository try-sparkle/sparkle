//! First-run auto-install for the three runtime prerequisites a brand-new Mac lacks: Claude Code
//! (`claude`), Node.js (`node`), and `git`. Detection lives in `preflight.rs`; this module drives
//! the *installs* the onboarding checklist offers.
//!
//! Design rules (see the install-readiness task):
//!  - **No sudo.** Claude Code uses the official `~/.local/bin` installer; Node.js is unpacked from
//!    the official nodejs.org tarball into `~/.local`; git uses Apple's `xcode-select --install`
//!    (a user-space GUI installer). Homebrew is never required.
//!  - **Idempotent.** Re-running any install overwrites/reuses in place and never leaves a
//!    half-state — symlinks are replaced atomically-ish (remove + recreate), a failed download
//!    aborts before touching the install tree.
//!  - **Streamed.** Each install emits `setup:progress` events (`{prereq, message}`) the UI shows
//!    live, then returns the resolved absolute path (or a structured error the UI surfaces as
//!    guidance).
//!
//! The pure URL/path helpers (`node_platform_tag`, `node_tarball_url`, `node_bin_symlinks`, …) are
//! unit-tested; the install commands themselves shell out and are exercised manually.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::preflight;

/// The Node.js version we install: the active maintenance LTS line ("Jod"). Pinned so the download
/// URL is deterministic and reproducible; bump deliberately.
pub const NODE_VERSION: &str = "v22.12.0";

/// Progress line streamed to the UI during an install (Tauri event `setup:progress`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SetupProgress {
    /// Which prerequisite this line belongs to: "claude" | "node" | "git".
    prereq: String,
    /// A single human-readable status/output line.
    message: String,
}

fn emit(app: &AppHandle, prereq: &str, message: impl Into<String>) {
    let _ = app.emit(
        "setup:progress",
        SetupProgress { prereq: prereq.into(), message: message.into() },
    );
}

/// Spawn a command and stream its stdout+stderr to the UI line-by-line as `setup:progress` events.
/// Returns Ok(()) on a zero exit status, else an Err describing the failure. stderr is drained on a
/// separate thread so a chatty installer can't deadlock by filling one pipe while we read the other.
fn run_streaming(app: &AppHandle, prereq: &str, mut cmd: Command) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("failed to start installer: {e}"))?;

    let stderr_handle = child.stderr.take().map(|err| {
        let app = app.clone();
        let prereq = prereq.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    emit(&app, &prereq, line);
                }
            }
        })
    });

    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                emit(app, prereq, line);
            }
        }
    }
    if let Some(h) = stderr_handle {
        let _ = h.join();
    }

    let status = child.wait().map_err(|e| format!("installer wait failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "installer exited with {}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "a signal".into())
        ))
    }
}

// ── Node.js ──────────────────────────────────────────────────────────────────────────────────

/// nodejs.org tarball platform tag for an (os, arch) pair, e.g. "darwin-arm64". `os` is the Rust
/// `target_os` value, `arch` the `target_arch` value. Returns None for an unsupported target (the
/// UI then falls back to manual guidance). Pure — unit-tested.
pub fn node_platform_tag(os: &str, arch: &str) -> Option<String> {
    let os_tag = match os {
        "macos" => "darwin",
        "linux" => "linux",
        _ => return None,
    };
    let arch_tag = match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return None,
    };
    Some(format!("{os_tag}-{arch_tag}"))
}

/// The platform tag for the *build target* this binary was compiled for.
fn current_platform_tag() -> Option<String> {
    node_platform_tag(std::env::consts::OS, std::env::consts::ARCH)
}

/// Official Node.js `.tar.gz` download URL for a version + platform tag. Pure — unit-tested.
pub fn node_tarball_url(version: &str, platform_tag: &str) -> String {
    format!("https://nodejs.org/dist/{version}/node-{version}-{platform_tag}.tar.gz")
}

/// The single top-level directory the tarball unpacks into. Pure — unit-tested.
pub fn node_extracted_dirname(version: &str, platform_tag: &str) -> String {
    format!("node-{version}-{platform_tag}")
}

/// Official `SHASUMS256.txt` URL for a Node.js version (lists the sha256 of every artifact). Pure.
pub fn node_shasums_url(version: &str) -> String {
    format!("https://nodejs.org/dist/{version}/SHASUMS256.txt")
}

/// Extract the expected sha256 for `filename` from a `SHASUMS256.txt` body. Each line is
/// `<hex-sha256>  <filename>` (the filename may carry a leading `*`/`./`). Returns the lowercased
/// hash, or None if the file isn't listed. Pure — unit-tested.
pub fn parse_shasums(text: &str, filename: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut it = line.split_whitespace();
        let hash = it.next()?;
        let name = it.next()?;
        let name = name.trim_start_matches('*').trim_start_matches("./");
        if name == filename {
            Some(hash.to_ascii_lowercase())
        } else {
            None
        }
    })
}

/// The (symlink → target) pairs to create in `<local>/bin` so `node`/`npm`/`npx` land on the same
/// `~/.local/bin` that preflight's `known_node_paths_for` already probes. Pure — unit-tested.
pub fn node_bin_symlinks(local_dir: &Path, extracted_dirname: &str) -> Vec<(PathBuf, PathBuf)> {
    let link_dir = local_dir.join("bin");
    let src_bin = local_dir.join(extracted_dirname).join("bin");
    ["node", "npm", "npx"]
        .iter()
        .map(|name| (link_dir.join(name), src_bin.join(name)))
        .collect()
}

/// Install Node.js WITHOUT sudo/Homebrew: download the official macOS tarball into `~/.local`,
/// unpack it, and symlink `node`/`npm`/`npx` into `~/.local/bin` (already on preflight's probe
/// list). Idempotent: a re-run re-downloads and overwrites in place. Streams progress; returns the
/// resolved absolute `node` path on success.
#[tauri::command]
pub async fn install_node(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_node_blocking(&app))
        .await
        .map_err(|e| format!("install task panicked: {e}"))?
}

#[cfg(unix)]
fn install_node_blocking(app: &AppHandle) -> Result<String, String> {
    use std::os::unix::fs::symlink;

    // Already have node? Detection WINS over the pinned NODE_VERSION here: onboarding only needs a
    // *working* node for Claude Code, so any node already on PATH (system, nvm, brew, an older
    // version) short-circuits the install. That means bumping NODE_VERSION does NOT upgrade a
    // machine that already has node — that's intentional for a first-run "make it work" flow, not a
    // version manager.
    preflight::invalidate_preflight_caches();
    if let Some(existing) = preflight::resolve_node_path() {
        emit(app, "node", format!("Node.js already installed at {existing}"));
        return Ok(existing);
    }

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "no HOME directory".to_string())?;
    let local_dir = home.join(".local");
    let bin_dir = local_dir.join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("cannot create {bin_dir:?}: {e}"))?;

    let tag = current_platform_tag()
        .ok_or_else(|| "unsupported platform for automatic Node.js install".to_string())?;
    let url = node_tarball_url(NODE_VERSION, &tag);
    let extracted = node_extracted_dirname(NODE_VERSION, &tag);

    // Download to a temp file next to the install dir (same filesystem, so extraction is local).
    let filename = format!("node-{NODE_VERSION}-{tag}.tar.gz");
    let tarball = local_dir.join(format!(".{filename}.download"));
    emit(app, "node", format!("Downloading Node.js {NODE_VERSION} ({tag})…"));
    // curl ships with macOS at /usr/bin/curl (base system, no CLT needed). -f fails on HTTP errors,
    // -s is quiet (no progress-meter noise on stderr), -S still shows real errors, -L follows
    // redirects, --retry rides out a transient blip.
    let mut curl = Command::new("curl");
    curl.args(["-fsSL", "--retry", "3", "-o", &tarball.to_string_lossy(), &url]);
    run_streaming(app, "node", curl).map_err(|e| format!("download failed: {e}"))?;

    // Integrity: verify the tarball's sha256 against the official SHASUMS256.txt BEFORE unpacking
    // and running any of its binaries. This catches a corrupt/truncated download and an on-path
    // tamper that touches only the tarball. It is NOT full mirror-poisoning protection: SHASUMS256.txt
    // is fetched over the same HTTPS origin and its GPG signature (SHASUMS256.txt.sig) is not
    // verified, so an attacker who can replace both files could still match. Signature verification
    // against Node's release keys would be the stronger guarantee; deliberately out of scope here.
    emit(app, "node", "Verifying download integrity…");
    verify_node_download(&tarball, &filename)?;

    emit(app, "node", "Unpacking…");
    // bsdtar (system /usr/bin/tar) handles gzip natively; -C extracts into local_dir, overwriting a
    // prior unpack so a re-run is idempotent.
    let mut tar = Command::new("tar");
    tar.args(["-xzf", &tarball.to_string_lossy(), "-C", &local_dir.to_string_lossy()]);
    run_streaming(app, "node", tar).map_err(|e| format!("unpack failed: {e}"))?;
    // Best-effort cleanup of the download artifact; leaving it is harmless.
    let _ = std::fs::remove_file(&tarball);

    // Symlink node/npm/npx into ~/.local/bin (replace any stale links from a prior version).
    for (link, target) in node_bin_symlinks(&local_dir, &extracted) {
        if !target.exists() {
            return Err(format!("expected {target:?} in the unpacked tarball, but it's missing"));
        }
        let _ = std::fs::remove_file(&link); // remove stale link/file; ignore "not found"
        symlink(&target, &link).map_err(|e| format!("symlink {link:?} → {target:?} failed: {e}"))?;
    }

    emit(app, "node", "Verifying…");
    preflight::invalidate_preflight_caches();
    match preflight::resolve_node_path() {
        Some(path) => {
            emit(app, "node", format!("Node.js installed at {path}"));
            Ok(path)
        }
        None => Err("Node.js unpacked but could not be resolved on PATH afterwards".into()),
    }
}

/// Fetch the official `SHASUMS256.txt`, compute the downloaded tarball's sha256 (via the system
/// `shasum`, present on macOS), and abort — deleting the tarball — on any mismatch or missing entry.
#[cfg(unix)]
fn verify_node_download(tarball: &Path, filename: &str) -> Result<(), String> {
    let fail = |tarball: &Path, msg: String| -> Result<(), String> {
        let _ = std::fs::remove_file(tarball); // never leave an unverified artifact behind
        Err(msg)
    };

    let url = node_shasums_url(NODE_VERSION);
    let out = Command::new("curl")
        .args(["-fsSL", "--retry", "3", &url])
        .output()
        .map_err(|e| format!("could not fetch checksums: {e}"))?;
    if !out.status.success() {
        return fail(tarball, "could not fetch SHASUMS256.txt for integrity check".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let expected = match parse_shasums(&text, filename) {
        Some(h) => h,
        None => return fail(tarball, format!("no published checksum for {filename}")),
    };
    let actual = match sha256_of_file(tarball) {
        Ok(h) => h,
        Err(e) => return fail(tarball, e),
    };
    if actual != expected {
        return fail(
            tarball,
            format!("checksum mismatch (expected {expected}, got {actual}) — download may be corrupt"),
        );
    }
    Ok(())
}

/// Parse the leading hex digest from a `shasum`/`sha256sum` line — `<hash>  <path>` (BSD and GNU
/// both lead with the hash). Returns the lowercased hash, or None on empty/garbage output. Pure —
/// unit-tested so a future format assumption can't regress silently.
pub fn parse_shasum_output(out: &str) -> Option<String> {
    out.split_whitespace()
        .next()
        .filter(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|h| h.to_ascii_lowercase())
}

/// sha256 of a file, lowercased hex, via the system `shasum -a 256` (base macOS; no crate needed).
#[cfg(unix)]
fn sha256_of_file(path: &Path) -> Result<String, String> {
    let out = Command::new("shasum")
        .args(["-a", "256", &path.to_string_lossy()])
        .output()
        .map_err(|e| format!("shasum failed: {e}"))?;
    if !out.status.success() {
        return Err("shasum exited non-zero".into());
    }
    parse_shasum_output(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| "could not parse shasum output".into())
}

#[cfg(not(unix))]
fn install_node_blocking(_app: &AppHandle) -> Result<String, String> {
    Err("automatic Node.js install is only supported on macOS/Unix".into())
}

// ── Claude Code ──────────────────────────────────────────────────────────────────────────────

/// Install Claude Code via the official non-sudo installer (`curl -fsSL https://claude.ai/install.sh
/// | bash`), which lands `claude` at `~/.local/bin/claude`. Idempotent (the installer re-installs in
/// place). Streams progress; returns the resolved absolute `claude` path on success.
#[tauri::command]
pub async fn install_claude_code(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_claude_blocking(&app))
        .await
        .map_err(|e| format!("install task panicked: {e}"))?
}

#[cfg(unix)]
fn install_claude_blocking(app: &AppHandle) -> Result<String, String> {
    emit(app, "claude", "Running the official Claude Code installer…");
    // Run through a LOGIN shell so the installer sees the user's PATH (it probes for node, git) and
    // its post-install PATH edits apply. curl + bash are both in the base macOS system.
    let mut cmd = Command::new("/bin/bash");
    cmd.args(["-lc", "curl -fsSL https://claude.ai/install.sh | bash"]);
    run_streaming(app, "claude", cmd)?;

    emit(app, "claude", "Verifying…");
    preflight::invalidate_preflight_caches();
    match preflight::cached_claude_path() {
        Some(path) => {
            emit(app, "claude", format!("Claude Code installed at {path}"));
            Ok(path)
        }
        None => Err(
            "the installer finished but `claude` could not be found afterwards — try re-running, \
             or install it manually from https://docs.claude.com/en/docs/claude-code/setup"
                .into(),
        ),
    }
}

#[cfg(not(unix))]
fn install_claude_blocking(_app: &AppHandle) -> Result<String, String> {
    Err("automatic Claude Code install is only supported on macOS/Unix".into())
}

// ── git (macOS Command Line Tools) ─────────────────────────────────────────────────────────────

/// Outcome of triggering the git install, so the UI knows whether to poll for completion.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallResult {
    /// "already-installed" (git resolved right away), "triggered" (CLT GUI installer opened; the UI
    /// should poll `git_preflight`), or "unavailable" (couldn't trigger; show guidance).
    pub status: String,
    /// Resolved git path when `status == "already-installed"`.
    pub path: Option<String>,
}

/// Trigger a non-sudo git install. On macOS git comes with the Xcode Command Line Tools, so we open
/// Apple's `xcode-select --install` GUI installer and tell the UI to poll `git_preflight` until it
/// resolves (the installer is user-driven and can take minutes). Idempotent: if git is already
/// present — or the CLT are already installed — we report that instead of re-triggering.
#[tauri::command]
pub async fn install_git(app: AppHandle) -> Result<GitInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || install_git_blocking(&app))
        .await
        .map_err(|e| format!("install task panicked: {e}"))?
}

#[cfg(all(unix, target_os = "macos"))]
fn install_git_blocking(app: &AppHandle) -> Result<GitInstallResult, String> {
    preflight::invalidate_preflight_caches();
    if let Some(path) = preflight::resolve_git_path() {
        emit(app, "git", format!("git already installed at {path}"));
        return Ok(GitInstallResult { status: "already-installed".into(), path: Some(path) });
    }

    emit(app, "git", "Opening the Command Line Tools installer…");
    // `xcode-select --install` pops Apple's GUI installer and returns immediately. When the CLT are
    // already installed it exits non-zero with "already installed" — treat that as success and let
    // the poll pick up the (now-real) system git.
    let out = Command::new("xcode-select").arg("--install").output();
    match out {
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            // When the CLT are ALREADY installed, `xcode-select --install` exits non-zero with an
            // "already installed" message and opens no dialog. Don't tell the UI to poll for a
            // never-appearing installer: re-probe git and report it done.
            if stderr.contains("already installed") {
                preflight::invalidate_preflight_caches();
                if let Some(path) = preflight::resolve_git_path() {
                    emit(app, "git", format!("git already available at {path}"));
                    return Ok(GitInstallResult {
                        status: "already-installed".into(),
                        path: Some(path),
                    });
                }
                // CLT present but git still not resolving (rare) — fall through to a poll.
            }
            if !stderr.trim().is_empty() {
                emit(app, "git", stderr.trim().to_string());
            }
            emit(
                app,
                "git",
                "Follow the macOS “Install” prompt. This can take a few minutes; we'll detect it \
                 automatically when it finishes.",
            );
            Ok(GitInstallResult { status: "triggered".into(), path: None })
        }
        Err(e) => Err(format!(
            "couldn't open the Command Line Tools installer ({e}). Install git manually — e.g. run \
             `xcode-select --install` in Terminal, or install Homebrew git."
        )),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn install_git_blocking(app: &AppHandle) -> Result<GitInstallResult, String> {
    preflight::invalidate_preflight_caches();
    if let Some(path) = preflight::resolve_git_path() {
        return Ok(GitInstallResult { status: "already-installed".into(), path: Some(path) });
    }
    emit(app, "git", "Install git via your system package manager (e.g. `apt install git`).");
    Err("automatic git install is only wired up for macOS; install git via your package manager".into())
}

#[cfg(not(unix))]
fn install_git_blocking(_app: &AppHandle) -> Result<GitInstallResult, String> {
    if let Some(path) = preflight::resolve_git_path() {
        return Ok(GitInstallResult { status: "already-installed".into(), path: Some(path) });
    }
    Err("install git from https://git-scm.com/download/win".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_platform_tag_maps_supported_targets() {
        assert_eq!(node_platform_tag("macos", "aarch64").as_deref(), Some("darwin-arm64"));
        assert_eq!(node_platform_tag("macos", "x86_64").as_deref(), Some("darwin-x64"));
        assert_eq!(node_platform_tag("linux", "x86_64").as_deref(), Some("linux-x64"));
    }

    #[test]
    fn node_platform_tag_none_for_unsupported() {
        assert_eq!(node_platform_tag("windows", "x86_64"), None);
        assert_eq!(node_platform_tag("macos", "riscv64"), None);
    }

    #[test]
    fn node_tarball_url_is_official_dist_gz() {
        let url = node_tarball_url("v22.12.0", "darwin-arm64");
        assert_eq!(
            url,
            "https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-arm64.tar.gz"
        );
        // Must be HTTPS and point at the official host.
        assert!(url.starts_with("https://nodejs.org/dist/"));
    }

    #[test]
    fn node_extracted_dirname_matches_tarball_stem() {
        assert_eq!(
            node_extracted_dirname("v22.12.0", "darwin-arm64"),
            "node-v22.12.0-darwin-arm64"
        );
    }

    #[test]
    fn node_bin_symlinks_land_in_local_bin_pointing_at_unpacked_bin() {
        let local = PathBuf::from("/Users/x/.local");
        let links = node_bin_symlinks(&local, "node-v22.12.0-darwin-arm64");
        // node/npm/npx, in that order.
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].0, PathBuf::from("/Users/x/.local/bin/node"));
        assert_eq!(
            links[0].1,
            PathBuf::from("/Users/x/.local/node-v22.12.0-darwin-arm64/bin/node")
        );
        assert_eq!(links[2].0, PathBuf::from("/Users/x/.local/bin/npx"));
        // Every symlink must live in the ~/.local/bin dir preflight already probes.
        for (link, _) in &links {
            assert!(link.starts_with("/Users/x/.local/bin"));
        }
    }

    #[test]
    fn node_shasums_url_points_at_official_dist() {
        assert_eq!(
            node_shasums_url("v22.12.0"),
            "https://nodejs.org/dist/v22.12.0/SHASUMS256.txt"
        );
    }

    #[test]
    fn parse_shasums_finds_the_matching_artifact() {
        let text = "\
aaaa1111  node-v22.12.0-linux-x64.tar.gz
bbbb2222  node-v22.12.0-darwin-arm64.tar.gz
cccc3333  node-v22.12.0-darwin-x64.tar.gz
";
        assert_eq!(
            parse_shasums(text, "node-v22.12.0-darwin-arm64.tar.gz").as_deref(),
            Some("bbbb2222")
        );
    }

    #[test]
    fn parse_shasums_handles_binary_mode_star_and_dot_slash_and_uppercase() {
        assert_eq!(
            parse_shasums("DEADBEEF  *file.tar.gz\n", "file.tar.gz").as_deref(),
            Some("deadbeef")
        );
        assert_eq!(
            parse_shasums("abc123  ./file.tar.gz\n", "file.tar.gz").as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn parse_shasums_none_when_not_listed() {
        assert_eq!(parse_shasums("aaaa  other.tar.gz\n", "missing.tar.gz"), None);
        assert_eq!(parse_shasums("", "anything"), None);
    }

    #[test]
    fn parse_shasum_output_takes_leading_hex_digest_bsd_and_gnu() {
        // BSD `shasum -a 256` and GNU `sha256sum` both lead with the hex digest.
        assert_eq!(
            parse_shasum_output("ABCDEF0123  /tmp/node.tar.gz\n").as_deref(),
            Some("abcdef0123")
        );
        assert_eq!(
            parse_shasum_output("deadbeef  file\n").as_deref(),
            Some("deadbeef")
        );
    }

    #[test]
    fn parse_shasum_output_rejects_empty_or_nonhex() {
        assert_eq!(parse_shasum_output(""), None);
        assert_eq!(parse_shasum_output("   \n"), None);
        // A non-hex first token (e.g. an error line) is not a digest.
        assert_eq!(parse_shasum_output("shasum: no such file\n"), None);
    }

    #[test]
    fn node_version_is_pinned_https_reachable_shape() {
        // Guard the pinned version stays a well-formed vX.Y.Z the URL builder expects.
        assert!(NODE_VERSION.starts_with('v'));
        assert_eq!(NODE_VERSION.split('.').count(), 3);
    }
}

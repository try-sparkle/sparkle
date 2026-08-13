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
use crate::preflight::LspServer;
// `ProjectLanguage` is referenced only from the `#[cfg(unix)]` install function and the tests, so
// importing it unconditionally makes a Windows build warn (and fail under `-D warnings`).
#[cfg(any(unix, test))]
use crate::preflight::ProjectLanguage;

/// The Node.js version we install: the active maintenance LTS line ("Jod"). Pinned so the download
/// URL is deterministic and reproducible; bump deliberately.
pub const NODE_VERSION: &str = "v22.12.0";

/// The pinned roborev release we ship. Bump deliberately alongside the pinned asset sha256 in
/// [`roborev_asset`]. The published assets live on the seed-auto-roborev GitHub release for this tag.
pub const ROBOREV_TAG: &str = "v0.1";

/// Progress line streamed to the UI during an install (Tauri event `setup:progress`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SetupProgress {
    /// Which prerequisite this line belongs to: "claude" | "node" | "git" | "roborev", or a
    /// language-server key ("typescript-language-server" | "pyright") for the LSP installs.
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

/// Bound on how long we wait for the line-emitting reader threads after the child is gone. A helper
/// that escaped the group kill would otherwise hold the pipes open forever; two seconds is orders of
/// magnitude more than draining a closed pipe needs.
const READER_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// Like [`run_streaming`], but ABORTS the child after `timeout` (killing it) instead of waiting
/// forever. Kept as a separate function rather than a parameter on `run_streaming` deliberately: the
/// node/claude/git/roborev installs are shipping code whose streaming behaviour is already proven,
/// and this only needs to cover the new network-bound `npm install`. Both pipes are drained on their
/// own threads so a chatty installer can't deadlock while we poll for the deadline (std has no
/// wait-with-timeout).
///
/// The child runs in its OWN process group on unix so expiry kills npm AND the helpers it forked.
/// Killing only npm leaves those helpers holding the inherited pipe write ends, so the reader
/// threads never see EOF and the `join` below hangs indefinitely — the 600s npm budget makes that
/// far more likely here than anywhere else, and the UI would hang on the very toggle this deadline
/// exists to protect. Same shape as `worktree::output_with_timeout`.
fn run_streaming_with_timeout(
    app: &AppHandle,
    prereq: &str,
    mut cmd: Command,
    timeout: std::time::Duration,
) -> Result<(), String> {
    // stdin is closed so a child that decides to prompt gets EOF and exits rather than blocking
    // until the deadline.
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start installer: {e}"))?;

    // Set once this call is done with the child. A reader we ABANDON at the grace below is detached,
    // not stopped — without this it keeps calling `emit` and a timed-out npm's output interleaves
    // into whatever prereq step runs next, in exactly the failure case a user screenshots.
    let silenced = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut readers = Vec::new();
    for pipe in [
        child.stdout.take().map(|o| Box::new(o) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|e| Box::new(e) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let app = app.clone();
        let prereq = prereq.to_string();
        let silenced = std::sync::Arc::clone(&silenced);
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if silenced.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                if !line.trim().is_empty() {
                    emit(&app, &prereq, line);
                }
            }
        }));
    }
    let finish = |child: &mut std::process::Child, kill: bool| {
        if kill {
            crate::proc::kill_process_group(child);
        }
        let refs: Vec<&std::thread::JoinHandle<()>> = readers.iter().collect();
        let done = crate::proc::await_threads(&refs, READER_DRAIN_GRACE);
        if !done {
            silenced.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        done
    };

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() >= deadline => {
                finish(&mut child, true);
                return Err(format!("timed out after {}s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(e) => {
                finish(&mut child, true);
                return Err(format!("installer wait failed: {e}"));
            }
        }
    };
    // Unlike `output_with_timeout`, an incomplete drain is NOT an error here: this function's result
    // is the child's exit status, and the lines were streamed to the UI as they arrived rather than
    // parsed afterwards. Silencing the abandoned readers is the whole remedy.
    finish(&mut child, false);
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

// ── roborev (per-commit AI code-review daemon) ─────────────────────────────────────────────────
//
// roborev ships as a single self-contained binary published on the seed-auto-roborev GitHub
// release. Unlike node/claude it has NO official installer script: we fetch the pinned asset by
// URL, verify its sha256 against a hardcoded pin (the release lists no SHASUMS file), drop it at
// ~/.local/bin/roborev, point it at the user's `claude` login as its review agent, and run it under
// a launchd LaunchAgent so the daemon survives logout/reboot. macOS + Apple Silicon only at v0.1 —
// no Intel/darwin-x64 asset is published, so an Intel Mac gets a clean surfaced error, not a panic.
//
// The daemon's `claude` child authenticates as a SUBSCRIPTION login, never an API key: the plist
// carries NO ANTHROPIC_API_KEY and NO CLAUDE_CODE_SIMPLE, so an end-user who authenticated via
// `claude login` is used as-is.
//
// WHICH login it uses is now chosen per review job by Sparkle's account-selecting shim, first on
// the daemon PATH (see `crate::roborev_account`). Before that shim existed the child always
// inherited `$HOME/.claude` — one account, forever — so a wall on that single account killed every
// review: 1,020 of 3,013 failed jobs in ~/.roborev/reviews.db are the quota/credential family, none
// ever recovered. The shim only ever sets CLAUDE_CONFIG_DIR, and falls open to the pre-shim
// behavior if anything about its candidate list is wrong.

/// The label for the roborev launchd LaunchAgent (also the plist basename stem).
const ROBOREV_DAEMON_LABEL: &str = "co.plow.roborev-daemon";

/// The published (asset filename, pinned sha256) for an (os, arch) pair, or None when no asset is
/// published for that target. At v0.1 ONLY Apple Silicon macOS ships an asset; Intel/darwin-x64 has
/// none (so the UI surfaces a clean "Apple Silicon only" error rather than downloading a 404). `os`
/// is the Rust `target_os` value ("macos"), `arch` the `target_arch` value ("aarch64" on arm64 Mac;
/// "arm64" is accepted as a synonym in case a caller passes the asset-style tag). Pure — unit-tested.
pub fn roborev_asset(os: &str, arch: &str) -> Option<(&'static str, &'static str)> {
    match (os, arch) {
        ("macos", "aarch64") | ("macos", "arm64") => Some((
            "roborev-darwin-arm64",
            "ebaba77e6a62670cd6bcc793fd484eda64b8ecebb1d2f9997e950363c37ab070",
        )),
        _ => None,
    }
}

/// The GitHub release download URL for a roborev asset filename at [`ROBOREV_TAG`]. Pure —
/// unit-tested so a host/path assumption can't regress silently.
pub fn roborev_download_url(tag: &str, filename: &str) -> String {
    format!("https://github.com/plow-pbc/seed-auto-roborev/releases/download/{tag}/{filename}")
}

/// Minimal XML-escape for the five predefined entities, so a home dir / path containing `&`, `<`,
/// `>`, or a quote can't produce a malformed plist. Pure — unit-tested.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The PATH the roborev daemon runs with: Sparkle's account-selecting `claude` shim first, then a
/// NORMAL user PATH. NO `ANTHROPIC_API_KEY` and NO API-key shim — roborev's `claude` child still
/// authenticates as a SUBSCRIPTION login; the shim only chooses WHICH of the user's registered
/// Claude accounts that is (see [`crate::roborev_account`]).
///
/// The shim prefix is what makes review rotation possible at all: roborev exposes no flag, env var
/// or config key for account selection, so intercepting its `claude` lookup is the only hook. If
/// the shim is not installed the directory simply does not exist and PATH resolution falls through
/// to the real `claude` — the pre-shim behavior.
///
/// This is DISTINCT from `~/.roborev-shim`, the retired installer shim that injected
/// `ANTHROPIC_API_KEY` + `CLAUDE_CODE_SIMPLE=1` and killed every review against an unfunded key.
/// That directory remains banned from this PATH by name, and a unit test still pins the ban.
///
/// SINGLE SOURCE OF TRUTH — the daemon plist and the auth self-test ([`roborev_auth_selftest`])
/// both build their environment from this, so the probe can never drift from the environment it
/// exists to test. Pure — unit-tested.
pub fn daemon_path_env(home: &Path) -> String {
    format!(
        "{}:{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        crate::roborev_account::shim_dir(home).to_string_lossy(),
        home.to_string_lossy()
    )
}

/// Generate the launchd LaunchAgent plist for the roborev daemon. `ProgramArguments` runs
/// `<roborev> daemon run`; `RunAtLoad`+`KeepAlive` keep it alive across logout/reboot. The
/// `EnvironmentVariables → PATH` comes from [`daemon_path_env`]. Pure (takes the roborev path +
/// home explicitly) — unit-tested.
pub fn roborev_daemon_plist(roborev_path: &str, home: &Path) -> String {
    let prog = xml_escape(roborev_path);
    let path_env = xml_escape(&daemon_path_env(home));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{ROBOREV_DAEMON_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{prog}</string>
        <string>daemon</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{path_env}</string>
    </dict>
</dict>
</plist>
"#
    )
}

/// The current user's numeric uid, for `launchctl … gui/<uid>/…` domain targeting. Uses the
/// system `id -u` (base macOS; no crate). Returns an Err the caller surfaces to the UI.
#[cfg(unix)]
fn current_uid() -> Result<String, String> {
    let out = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|e| format!("could not resolve uid: {e}"))?;
    if !out.status.success() {
        return Err("`id -u` exited non-zero".into());
    }
    let uid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if uid.is_empty() || !uid.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("unexpected uid from `id -u`: {uid:?}"));
    }
    Ok(uid)
}

/// Is the roborev LaunchAgent currently loaded in the user's gui domain? `launchctl print` exits 0
/// only when the service is bootstrapped, so this lets the (idempotent) install skip a disruptive
/// bootout/bootstrap when the daemon is already healthy — e.g. the every-launch startup ensure.
#[cfg(unix)]
fn roborev_daemon_loaded(uid: &str) -> bool {
    Command::new("launchctl")
        .args(["print", &format!("gui/{uid}/{ROBOREV_DAEMON_LABEL}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Install roborev on macOS: fetch the pinned Apple-Silicon asset, verify its sha256, drop it at
/// `~/.local/bin/roborev`, point it at the user's `claude` login, and (re)load its launchd daemon.
/// Idempotent: if roborev already resolves we skip the fetch and just (re)load the daemon. Streams
/// progress; returns the resolved absolute `roborev` path on success.
#[tauri::command]
pub async fn install_roborev(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_roborev_blocking(&app))
        .await
        .map_err(|e| format!("install task panicked: {e}"))?
}

#[cfg(all(unix, target_os = "macos"))]
fn install_roborev_blocking(app: &AppHandle) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;

    // Serialize installs: the best-effort startup ensure and a UI-triggered install run on the same
    // async runtime and would otherwise race on the shared `roborev.tmp` download path (a corrupt
    // binary / spurious checksum mismatch) and on the daemon reload. A process-wide lock is enough —
    // the desktop app is single-instance. Recover a poisoned guard rather than panicking the install.
    static ROBOREV_INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _install_guard = ROBOREV_INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // (1) Idempotent: already installed? Skip the download and go straight to (re)loading the daemon
    //     so a re-enable after reboot is cheap. A fresh install isn't cached as a miss, so this picks
    //     up a manual install too.
    let mut freshly_installed = false;
    let roborev_path = if let Some(existing) = preflight::cached_roborev_path() {
        emit(app, "roborev", format!("roborev already installed at {existing}"));
        existing
    } else {
        freshly_installed = true;
        // (2) Resolve the published asset for THIS Mac. No asset (Intel/darwin-x64 at v0.1) → clean
        //     surfaced error, never a panic.
        let (asset, expected_sha) = roborev_asset(std::env::consts::OS, std::env::consts::ARCH)
            .ok_or_else(|| {
                "roborev isn't available for this Mac architecture yet (Apple Silicon only at v0.1)"
                    .to_string()
            })?;

        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "no HOME directory".to_string())?;
        let bin_dir = home.join(".local/bin");
        std::fs::create_dir_all(&bin_dir)
            .map_err(|e| format!("cannot create {bin_dir:?}: {e}"))?;
        let tmp = bin_dir.join("roborev.tmp");
        let final_path = bin_dir.join("roborev");

        // (3) Download to a temp file, verify sha256 against the pin BEFORE trusting the bits.
        let url = roborev_download_url(ROBOREV_TAG, asset);
        emit(app, "roborev", format!("Downloading roborev {ROBOREV_TAG} ({asset})…"));
        let mut curl = Command::new("curl");
        curl.args(["-fsSL", &url, "-o", &tmp.to_string_lossy()]);
        run_streaming(app, "roborev", curl).map_err(|e| format!("download failed: {e}"))?;

        emit(app, "roborev", "Verifying download integrity…");
        match sha256_of_file(&tmp) {
            Ok(actual) if actual == expected_sha => {}
            Ok(actual) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!(
                    "checksum mismatch (expected {expected_sha}, got {actual}) — download may be corrupt"
                ));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        }

        // chmod 0755, then atomic rename into place.
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod roborev failed: {e}"))?;
        std::fs::rename(&tmp, &final_path)
            .map_err(|e| format!("installing roborev to {final_path:?} failed: {e}"))?;

        preflight::invalidate_preflight_caches();
        let resolved = preflight::cached_roborev_path()
            .unwrap_or_else(|| final_path.to_string_lossy().to_string());
        emit(app, "roborev", format!("roborev installed at {resolved}"));
        resolved
    };

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "no HOME directory".to_string())?;

    // Install/refresh the account-selecting `claude` shim BEFORE any early return below, so an
    // already-running daemon still picks it up. Best-effort: a shim that fails to install leaves
    // roborev exactly as it was (the real `claude`, default account), which is the pre-rotation
    // behavior — never a reason to fail the whole install.
    match preflight::cached_claude_path() {
        Some(real_claude) => match crate::roborev_account::install_shim(&home, &real_claude) {
            Ok(()) => emit(app, "roborev", "Installed the Claude account-selecting shim."),
            Err(e) => emit(app, "roborev", format!("Could not install the account shim ({e}); reviews will use the default account.")),
        },
        None => emit(app, "roborev", "No `claude` on PATH yet; skipping the account shim."),
    }
    // Publish an initial candidate list so the very first review after install already rotates.
    // Without this the shim would fail open to the default account until the first observed wall
    // triggered a republish — i.e. rotation would only start working after it was first needed.
    if let Ok(app_data) = crate::worktree::app_data_dir_pub(app) {
        crate::accounts::republish_roborev_candidates(&app_data, &home);
    }

    let plist_path = home
        .join("Library/LaunchAgents")
        .join(format!("{ROBOREV_DAEMON_LABEL}.plist"));
    let desired_plist = roborev_daemon_plist(&roborev_path, &home);

    // Don't tear down a healthy, already-running daemon on every app launch (the startup ensure
    // calls this): RunAtLoad/KeepAlive already persist the service across reboots. If we didn't just
    // install a new binary and the service is already loaded, leave it — and any in-flight review —
    // alone. Skipping the `config set default_agent` step (below) is safe here: this LaunchAgent is
    // ONLY ever bootstrapped by this function, which always runs that configure step BEFORE the
    // bootstrap — so a loaded daemon implies the agent was already configured. We only (re)configure
    // + (re)bootstrap on a fresh install or a not-currently-loaded service.
    //
    // EXCEPT when the on-disk plist no longer matches what we generate. The daemon's environment is
    // fixed at bootstrap, so a running daemon keeps the OLD PATH until it is reloaded — which is
    // exactly what happens when the shim directory is added to `daemon_path_env`. Without this
    // check, rotation would only reach machines that happened to reinstall roborev.
    let uid = current_uid()?;
    let plist_current = std::fs::read_to_string(&plist_path).unwrap_or_default();
    if !freshly_installed && roborev_daemon_loaded(&uid) && plist_current == desired_plist {
        emit(app, "roborev", "roborev daemon already running.");
        return Ok(roborev_path);
    }

    // (4) Point roborev at the user's claude login as its default review agent. Best-effort but
    //     surfaced on failure — a fresh install needs this to review at all.
    emit(app, "roborev", "Configuring roborev to use claude-code…");
    let mut cfg = Command::new(&roborev_path);
    cfg.args(["config", "set", "--global", "default_agent", "claude-code"]);
    run_streaming(app, "roborev", cfg)
        .map_err(|e| format!("`roborev config set default_agent` failed: {e}"))?;

    // (5) Write + (re)load the launchd daemon so reviews run in the background across reboots.
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {parent:?}: {e}"))?;
    }
    emit(app, "roborev", "Writing the roborev daemon LaunchAgent…");
    std::fs::write(&plist_path, &desired_plist)
        .map_err(|e| format!("writing daemon plist failed: {e}"))?;

    // bootout first so a reload picks up an updated plist/binary. Ignore its result: the service is
    // frequently NOT loaded (first install), which bootout reports as an error.
    emit(app, "roborev", "Reloading the roborev daemon…");
    let _ = Command::new("launchctl")
        .args(["bootout", &format!("gui/{uid}/{ROBOREV_DAEMON_LABEL}")])
        .output();
    let boot = Command::new("launchctl")
        .args(["bootstrap", &format!("gui/{uid}"), &plist_path.to_string_lossy()])
        .output()
        .map_err(|e| format!("launchctl bootstrap failed to run: {e}"))?;
    if !boot.status.success() {
        let stderr = String::from_utf8_lossy(&boot.stderr).trim().to_string();
        return Err(format!(
            "launchctl bootstrap of the roborev daemon failed: {}",
            if stderr.is_empty() { "unknown error".into() } else { stderr }
        ));
    }
    emit(app, "roborev", "roborev daemon is running.");
    Ok(roborev_path)
}

#[cfg(not(all(unix, target_os = "macos")))]
fn install_roborev_blocking(_app: &AppHandle) -> Result<String, String> {
    Err("roborev is only supported on macOS (Apple Silicon) at this time".into())
}

// ---------------------------------------------------------------------------
// Auth self-test
//
// Why this exists: roborev reviews run in a launchd daemon that spawns `claude` with the env
// STRIPPED — no ANTHROPIC_API_KEY reaches it. We rely on the user's own `claude login` credentials
// (on macOS: the login Keychain) being readable from that context. When that assumption breaks the
// daemon fails SILENTLY: the toggle reads ON, the daemon runs, and no review ever appears. Nobody
// notices. So we probe the exact daemon environment up front and refuse to report "on" unless a
// review could actually happen.
//
// We shell out to roborev's own `check-agents` rather than invoking `claude` ourselves: it runs a
// real smoke-test prompt through roborev's actual agent-invocation path, so the probe tests the
// thing that will really run instead of our re-implementation of it.
// ---------------------------------------------------------------------------

/// What the auth probe concluded. Distinguishes "no claude at all" from "claude present but can't
/// authenticate" because the user-facing fix differs (install it vs `claude login`).
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum RoborevAuthVerdict {
    /// claude-code answered the smoke-test prompt — reviews will work.
    Passed,
    /// The roborev binary itself isn't installed, so there's nothing to probe. Distinct from an
    /// Unknown/failed probe: this is a deterministic, expected state (the daemon never installed, or
    /// its install failed), not an anomaly — so the UI can say so plainly instead of "couldn't
    /// confirm", and callers needn't log it as a warning.
    NotInstalled,
    /// `claude` isn't on the daemon's PATH.
    ClaudeMissing,
    /// `claude` ran but couldn't produce output (almost always: not logged in).
    NotAuthenticated,
    /// Output we don't recognise — carries the raw text so the UI can show something honest
    /// rather than claiming a pass we didn't observe.
    Unknown(String),
}

/// Parse the `"<n> passed, <n> failed, <n> skipped"` summary roborev's check-agents prints.
/// Returns (passed, failed) or None when `line` isn't that summary. Pure — unit-tested.
fn parse_check_agents_summary(line: &str) -> Option<(u32, u32)> {
    let (mut passed, mut failed) = (None, None);
    for part in line.trim().split(',') {
        let mut it = part.trim().split_whitespace();
        let n: u32 = it.next()?.parse().ok()?;
        match it.next()? {
            "passed" => passed = Some(n),
            "failed" => failed = Some(n),
            "skipped" => {}
            _ => return None,
        }
    }
    Some((passed?, failed?))
}

/// Classify `roborev check-agents --agent claude-code` stdout into a verdict.
///
/// We check the per-agent line for "not found in PATH" FIRST: a missing binary is reported as
/// *skipped*, not failed, so the summary alone would read as a vacuous `0 failed` pass. Pure —
/// unit-tested, which is what lets us assert the "0 passed" case can never be mistaken for success.
pub fn classify_check_agents(stdout: &str) -> RoborevAuthVerdict {
    if let Some(line) = stdout.lines().find(|l| l.contains("claude-code")) {
        if line.contains("not found in PATH") {
            return RoborevAuthVerdict::ClaudeMissing;
        }
    }
    for line in stdout.lines() {
        if let Some((passed, failed)) = parse_check_agents_summary(line) {
            if failed > 0 {
                return RoborevAuthVerdict::NotAuthenticated;
            }
            if passed > 0 {
                return RoborevAuthVerdict::Passed;
            }
            // 0 passed AND 0 failed: claude-code was skipped for a reason we didn't match above.
            // Explicitly NOT a pass.
            return RoborevAuthVerdict::Unknown(stdout.trim().to_string());
        }
    }
    RoborevAuthVerdict::Unknown(stdout.trim().to_string())
}

/// Probe whether roborev can actually authenticate `claude` in the daemon's environment. Runs
/// roborev's own check-agents smoke test with the env CLEARED down to exactly what launchd hands
/// the daemon (see [`daemon_path_env`]) — notably WITHOUT ANTHROPIC_API_KEY, so a key in the app's
/// own environment can't mask a login that would fail for the real daemon.
#[tauri::command]
pub async fn roborev_auth_selftest(app: AppHandle) -> Result<RoborevAuthVerdict, String> {
    tauri::async_runtime::spawn_blocking(move || roborev_auth_selftest_blocking(&app))
        .await
        .map_err(|e| format!("auth self-test task panicked: {e}"))?
}

#[cfg(all(unix, target_os = "macos"))]
fn roborev_auth_selftest_blocking(app: &AppHandle) -> Result<RoborevAuthVerdict, String> {
    let Some(roborev_path) = preflight::cached_roborev_path() else {
        // Not an error: the binary simply isn't present. Report it as a first-class verdict so the
        // frontend doesn't have to string-match an error message — and doesn't log it as a warning.
        return Ok(RoborevAuthVerdict::NotInstalled);
    };
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "no HOME directory".to_string())?;

    emit(app, "roborev", "Checking that roborev can authenticate claude…");
    let mut cmd = Command::new(&roborev_path);
    cmd.args(["check-agents", "--agent", "claude-code", "--timeout", "60"]);
    // Reproduce the daemon's env exactly: launchd gives a LaunchAgent a near-empty environment plus
    // the plist's EnvironmentVariables. env_clear() then re-adding only HOME/PATH/USER is what makes
    // this a real test — inheriting our own env would smuggle in an ANTHROPIC_API_KEY the daemon
    // will never see and turn the probe into a false pass.
    cmd.env_clear();
    cmd.env("HOME", &home);
    cmd.env("PATH", daemon_path_env(&home));
    if let Some(user) = std::env::var_os("USER") {
        cmd.env("USER", user);
    }

    // Generous ceiling: check-agents' own per-agent timeout is 60s, so this only fires if roborev
    // itself wedges. Bounded either way — a hung probe must not hang the toggle forever.
    let out = crate::worktree::output_with_timeout(cmd, std::time::Duration::from_secs(90))
        .map_err(|e| format!("roborev check-agents: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut verdict = classify_check_agents(&stdout);
    // An Unknown means we couldn't read the output — attach the exit status and stderr so a hard
    // failure (crash, non-zero exit, output only on stderr) is diagnosable instead of looking
    // identical to "roborev printed something we don't recognise".
    if let RoborevAuthVerdict::Unknown(detail) = &verdict {
        let stderr = String::from_utf8_lossy(&out.stderr);
        verdict = RoborevAuthVerdict::Unknown(format!(
            "exit {}; stdout: {}; stderr: {}",
            out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
            if detail.is_empty() { "<empty>" } else { detail },
            if stderr.trim().is_empty() { "<empty>" } else { stderr.trim() },
        ));
    }
    emit(app, "roborev", format!("roborev auth self-test: {verdict:?}"));
    Ok(verdict)
}

#[cfg(not(all(unix, target_os = "macos")))]
fn roborev_auth_selftest_blocking(_app: &AppHandle) -> Result<RoborevAuthVerdict, String> {
    Err("roborev is only supported on macOS (Apple Silicon) at this time".into())
}

/// Stop the roborev launchd daemon (best-effort), leaving the binary + plist in place so a later
/// re-enable is a cheap reload. Returns Ok even when the daemon wasn't loaded (bootout of an
/// unloaded service errors, which we deliberately swallow — the post-state is the same: not running).
#[tauri::command]
pub async fn deactivate_roborev(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || deactivate_roborev_blocking(&app))
        .await
        .map_err(|e| format!("deactivate task panicked: {e}"))?
}

#[cfg(all(unix, target_os = "macos"))]
fn deactivate_roborev_blocking(app: &AppHandle) -> Result<String, String> {
    let uid = current_uid()?;
    emit(app, "roborev", "Stopping the roborev daemon…");
    // Best-effort: an unloaded service makes bootout exit non-zero; that's still the desired
    // end-state (not running), so we don't propagate it.
    let _ = Command::new("launchctl")
        .args(["bootout", &format!("gui/{uid}/{ROBOREV_DAEMON_LABEL}")])
        .output();
    emit(app, "roborev", "roborev daemon stopped.");
    Ok("roborev daemon stopped".into())
}

#[cfg(not(all(unix, target_os = "macos")))]
fn deactivate_roborev_blocking(_app: &AppHandle) -> Result<String, String> {
    Ok("roborev is not supported on this platform; nothing to stop".into())
}

// ── LSP language servers ───────────────────────────────────────────────────────────────────────
//
// Claude Code's official LSP plugins (`typescript-lsp`, `pyright-lsp`, …) are README-only: they
// activate Claude Code's NATIVE LSP client but bundle no binary, so LSP silently stays off unless
// the language server already exists on the machine. Sparkle closes that gap the same no-sudo way it
// installs node/claude/roborev.
//
// Two of the five are npm-distributed and therefore installable with the pinned Node install's npm:
//
//   typescript-language-server + typescript   →  typescript-lsp
//   pyright                                   →  pyright-lsp
//
// The rest (rust-analyzer, gopls, sourcekit-lsp) each need a toolchain we don't manage, so they stay
// DETECTION-ONLY for now — see the TODO seam at the bottom of this section.
//
// Design rules, matching the rest of this module:
//  - **No sudo.** `npm install --global --prefix ~/.local/share/sparkle/lsp` writes only under the
//    user's home. We never touch the machine's npm global prefix, which is frequently `/usr/local`
//    (needs sudo) or the user's own nvm version dir (not ours to mutate).
//  - **Never clobber the user's own tools.** The `~/.local/bin` symlinks are created only when the
//    name is free or already points into our prefix; a foreign binary of the same name is left
//    alone and reported back (see [`link_action`]).
//  - **Idempotent.** Already resolvable → we report it and return without touching the disk.

/// Pinned `typescript-language-server` release. Bump deliberately, together with the TypeScript pin.
pub const TYPESCRIPT_LANGUAGE_SERVER_VERSION: &str = "5.3.0";

/// Pinned `typescript` release, which is where `tsserver` — the thing typescript-language-server
/// actually drives — comes from.
///
/// **This pin is load-bearing, not cosmetic.** As of TypeScript 7 the npm package is the native Go
/// port and ships ONLY `bin/tsc`: `lib/tsserver.js` is gone (verified against the published
/// tarballs — 5.9.3 and 6.0.3 have it, 7.0.2 does not). So the install line the official plugin's
/// README suggests, `npm i -g typescript-language-server typescript`, now resolves `typescript` to
/// a release with no tsserver and yields a language server that starts and does nothing. We pin the
/// last widely-compatible release that ships tsserver instead. Revisit when
/// typescript-language-server supports the native port.
pub const TYPESCRIPT_VERSION: &str = "5.9.3";

/// Pinned `pyright` release (the npm distribution provides both `pyright` and `pyright-langserver`).
pub const PYRIGHT_VERSION: &str = "1.1.411";

/// Wall-clock ceiling for one `npm install` of a language server. Generous: a cold npm cache on a
/// slow link genuinely takes a while, but a wedged install must not hang the toggle forever.
const LSP_NPM_INSTALL_TIMEOUT_SECS: u64 = 600;

/// The exact npm package specs to install for a server, version-pinned, or None for the
/// detection-only tier. Pure — unit-tested so a pin can't silently go missing.
pub fn lsp_npm_specs(server: LspServer) -> Option<Vec<String>> {
    match server {
        LspServer::TypeScriptLanguageServer => Some(vec![
            format!("typescript-language-server@{TYPESCRIPT_LANGUAGE_SERVER_VERSION}"),
            format!("typescript@{TYPESCRIPT_VERSION}"),
        ]),
        LspServer::Pyright => Some(vec![format!("pyright@{PYRIGHT_VERSION}")]),
        _ => None,
    }
}

/// The full `npm` argv for installing `specs` into Sparkle's managed prefix without sudo.
///
/// `--global` + `--prefix <dir>` is the whole no-sudo trick: it redirects what would be a
/// system-wide install into a directory we own (`<prefix>/lib/node_modules` + `<prefix>/bin`).
/// `--no-fund`/`--no-audit` keep the streamed output to install progress. Pure — unit-tested.
pub fn npm_install_args(prefix: &Path, specs: &[String]) -> Vec<String> {
    let mut args = vec![
        "install".to_string(),
        "--global".to_string(),
        "--prefix".to_string(),
        prefix.to_string_lossy().to_string(),
        "--no-fund".to_string(),
        "--no-audit".to_string(),
    ];
    args.extend(specs.iter().cloned());
    args
}

/// What to do about a `~/.local/bin/<name>` entry when linking a managed server onto the PATH.
#[derive(Debug, PartialEq, Eq)]
pub enum LinkAction {
    /// Nothing is there — create the symlink.
    Create,
    /// A symlink we own (it resolves into our managed prefix) — replace it, so a version bump or a
    /// re-run points at the new install.
    Replace,
    /// Something we did NOT install occupies the name. Leave it: the user's own
    /// `typescript-language-server` (nvm, brew, pipx) is the one Claude Code should keep running,
    /// and silently overwriting a binary outside our prefix is not ours to do.
    KeepForeign,
}

/// Decide the action for one link path. A link is "ours" when it resolves into `managed_prefix`;
/// anything else — a real file, or a symlink pointing elsewhere — is foreign. Unit-tested against
/// real temp-dir symlinks, since this is the guard that keeps installs non-destructive.
pub fn link_action(link: &Path, managed_prefix: &Path) -> LinkAction {
    // symlink_metadata does NOT follow the link, so a DANGLING symlink of ours still reads as
    // present here (fs::metadata would report it missing and we'd try to create over it).
    if std::fs::symlink_metadata(link).is_err() {
        return LinkAction::Create;
    }
    // Compare against BOTH the literal and the canonicalized prefix. Canonicalizing only one side
    // silently breaks whenever the other can't be resolved: a DANGLING link of ours (its target was
    // cleaned up) canonicalizes to nothing, so it would be compared literally — `/var/…/managed`
    // against a canonical `/private/var/…/managed` on macOS — and read as foreign, leaving the
    // broken link in place forever.
    let canonical_prefix = std::fs::canonicalize(managed_prefix).ok();
    let under_prefix = |p: &Path| {
        p.starts_with(managed_prefix)
            || canonical_prefix.as_ref().map(|c| p.starts_with(c)).unwrap_or(false)
    };
    let points_into_prefix = std::fs::read_link(link)
        .ok()
        .map(|target| {
            // Resolve a relative link against the link's own directory before comparing.
            if target.is_absolute() {
                target
            } else {
                link.parent().map(|d| d.join(&target)).unwrap_or(target)
            }
        })
        .map(|target| {
            let resolved = std::fs::canonicalize(&target);
            under_prefix(&target) || resolved.map(|r| under_prefix(&r)).unwrap_or(false)
        })
        .unwrap_or(false);
    if points_into_prefix {
        LinkAction::Replace
    } else {
        LinkAction::KeepForeign
    }
}

/// The (link → target) pairs for putting a server's managed binaries on the user's PATH: each name
/// in `bins` gets `<link_dir>/<name>` → `<managed_bin_dir>/<name>`. Mirrors [`node_bin_symlinks`],
/// and lands in the same `~/.local/bin` preflight already probes. Pure — unit-tested.
pub fn lsp_bin_symlinks(
    managed_bin_dir: &Path,
    link_dir: &Path,
    bins: &[&str],
) -> Vec<(PathBuf, PathBuf)> {
    bins.iter()
        .map(|name| (link_dir.join(name), managed_bin_dir.join(name)))
        .collect()
}

/// Outcome of an [`install_lsp_server`] call.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInstallResult {
    /// Server key, e.g. "typescript-language-server".
    pub server: String,
    /// Language key, e.g. "typescript".
    pub language: String,
    /// The official Claude Code plugin this unblocks, e.g. "typescript-lsp".
    pub plugin: String,
    /// "already-installed" (found on PATH, nothing done), "installed", or "installed-not-linked"
    /// (ours is on disk but a foreign binary of the same name shadows it — see `install_verdict`).
    pub status: String,
    /// Resolved absolute path to the language server.
    pub path: String,
    /// Version line read back from the installed binary, when it reports one.
    pub version: Option<String>,
    /// Binaries we did NOT link into `~/.local/bin` because a foreign binary already owns the name.
    /// Not an error — the user's own copy stays authoritative — but surfaced so the UI can say so.
    pub skipped_links: Vec<String>,
}

/// Install the language server for `language` (a [`ProjectLanguage`] key such as "typescript" or
/// "python") without sudo, into Sparkle's managed npm prefix, and link it onto `~/.local/bin`.
///
/// Idempotent: when the server already resolves — ours or the user's own — we report it and change
/// nothing. Deliberately NOT called at startup; it exists so the plugin-toggle wiring
/// (sparkle-s3g2.4) can provision on demand when a project's language is detected.
#[tauri::command]
pub async fn install_lsp_server(app: AppHandle, language: String) -> Result<LspInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || install_lsp_server_blocking(&app, &language))
        .await
        .map_err(|e| format!("install task panicked: {e}"))?
}

#[cfg(unix)]
fn install_lsp_server_blocking(app: &AppHandle, language: &str) -> Result<LspInstallResult, String> {
    use std::os::unix::fs::symlink;

    let lang = ProjectLanguage::from_key(language)
        .ok_or_else(|| format!("unknown language {language:?} — no language server is mapped to it"))?;
    let server = LspServer::for_language(lang);
    let key = server.key();

    if !server.auto_installable() {
        // TODO(sparkle-s3g2): installers for the detection-only tier. Each needs a toolchain
        // Sparkle doesn't manage, so each is its own no-sudo problem:
        //   - rust-analyzer:  `rustup component add rust-analyzer` when rustup exists, else fetch
        //                     the pinned GitHub release asset (the roborev pattern in this file).
        //   - gopls:          `go install golang.org/x/tools/gopls@<pin>` — needs a Go toolchain,
        //                     which we'd have to provision first (tarball into ~/.local, like node).
        //   - sourcekit-lsp:  ships inside Xcode/CLT; the install is `xcode-select --install`
        //                     (already wired as `install_git`), so this is really a detect+guide.
        return Err(format!(
            "{key} isn't auto-installed by Sparkle yet — install it with the toolchain that owns it \
             ({}), then re-check. Detection already works, so it'll be picked up automatically.",
            match server {
                LspServer::RustAnalyzer => "rustup component add rust-analyzer",
                LspServer::Gopls => "go install golang.org/x/tools/gopls@latest",
                _ => "install Xcode or the Swift toolchain",
            }
        ));
    }

    // Serialize installs: the TypeScript and Python toggles can be flipped back to back, and both
    // write into the same managed prefix — concurrent `npm install --prefix` runs on one prefix
    // race on its node_modules tree. The desktop app is single-instance, so a process-wide lock is
    // enough. Recover a poisoned guard rather than panicking the install.
    static LSP_INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LSP_INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let result_for = |status: &str, path: String, skipped_links: Vec<String>| LspInstallResult {
        server: key.to_string(),
        language: lang.key().to_string(),
        plugin: server.claude_plugin().to_string(),
        status: status.to_string(),
        version: preflight::lsp_server_version(server, &path),
        path,
        skipped_links,
    };

    // Any path through this function can change what's installed, so the session path cache that
    // `lsp_server_status` reads must not outlive it. Dropped up front too: the idempotency check
    // below has to see the machine, not a cached answer from before a manual uninstall.
    preflight::invalidate_lsp_path_cache();

    // (1) Idempotent: already resolvable (ours from a previous run, or the user's own install)?
    //     Detection WINS — same rule as install_node. Re-running is an "ensure", not an upgrade.
    if let Some(existing) = preflight::resolve_lsp_server_path(server) {
        emit(app, key, format!("{key} already installed at {existing}"));
        return Ok(result_for("already-installed", existing, Vec::new()));
    }

    // (2) We need Sparkle's managed npm. It's installed alongside the pinned node, so a missing npm
    //     means node onboarding hasn't run — say that instead of a bare spawn failure.
    let npm = preflight::resolve_npm_path().ok_or_else(|| {
        "npm is required to install this language server, and it isn't installed yet — install \
         Node.js from Setup first"
            .to_string()
    })?;
    let node = preflight::resolve_node_path_cached()
        .ok_or_else(|| "Node.js is required to install this language server".to_string())?;

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "no HOME directory".to_string())?;
    let prefix = preflight::lsp_npm_prefix_for(&home);
    let managed_bin = preflight::lsp_managed_bin_dir_for(&home);
    let link_dir = home.join(".local/bin");
    std::fs::create_dir_all(&prefix).map_err(|e| format!("cannot create {prefix:?}: {e}"))?;
    std::fs::create_dir_all(&link_dir).map_err(|e| format!("cannot create {link_dir:?}: {e}"))?;

    // (3) Install into the managed prefix. npm's shebang is `#!/usr/bin/env node`, and a
    //     Finder/Dock-launched GUI app's PATH often has no node at all — so prepend the resolved
    //     node's directory rather than trusting the inherited PATH.
    let specs = lsp_npm_specs(server).ok_or_else(|| format!("no npm packages defined for {key}"))?;
    emit(app, key, format!("Installing {} …", specs.join(" ")));
    let mut cmd = Command::new(&npm);
    cmd.args(npm_install_args(&prefix, &specs));
    if let Some(node_dir) = Path::new(&node).parent() {
        let current = std::env::var("PATH").ok();
        cmd.env("PATH", preflight::path_with_dir_first(node_dir, current.as_deref()));
    }
    run_streaming_with_timeout(
        app,
        key,
        cmd,
        std::time::Duration::from_secs(LSP_NPM_INSTALL_TIMEOUT_SECS),
    )
    .map_err(|e| format!("npm install of {key} failed: {e}"))?;

    // (4) Put the server on the user's PATH — but never over a binary that isn't ours.
    let mut skipped_links = Vec::new();
    for (link, target) in lsp_bin_symlinks(&managed_bin, &link_dir, server.linked_binaries()) {
        if !target.exists() {
            return Err(format!(
                "expected {target:?} after the npm install, but it's missing — the install may be \
                 incomplete"
            ));
        }
        match link_action(&link, &prefix) {
            LinkAction::KeepForeign => {
                let name = link.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                emit(
                    app,
                    key,
                    format!("Leaving your existing {} at {} alone.", name, link.display()),
                );
                skipped_links.push(name);
            }
            LinkAction::Replace | LinkAction::Create => {
                let _ = std::fs::remove_file(&link); // no-op when nothing is there
                symlink(&target, &link)
                    .map_err(|e| format!("symlink {link:?} → {target:?} failed: {e}"))?;
            }
        }
    }

    // (5) Verify the install actually landed — a zero-exit npm that produced no binary must not be
    //     reported as success (that's how LSP ends up silently off).
    emit(app, key, "Verifying…");
    // The npm install changed the machine; drop the cached resolutions before asking about it.
    preflight::invalidate_lsp_path_cache();

    // When the PRIMARY binary's link was skipped as KeepForeign, our copy is in the managed prefix
    // — a directory on nobody's PATH — and the binary Claude Code will actually run is whatever
    // `~/.local/bin` (or the login-shell PATH) resolves. Reporting `installed` at the managed path
    // would name a file that never runs, so say `installed-not-linked` and point at what does.
    // The general resolver can't answer that — its candidate list puts the managed prefix FIRST,
    // so it would just hand the managed copy back — so resolve outside the managed prefix
    // explicitly. When THAT misses too (the foreign entry is non-executable or dangling), the
    // install still succeeded, so this is not an error — but it is emphatically not plain
    // `installed` either: the only copy we can name is the one on nobody's PATH, and what Claude
    // Code will resolve is the broken foreign entry, i.e. the silently-off-LSP outcome this whole
    // step exists to catch. It keeps `installed-not-linked` (with the managed path) so the status
    // still carries the warning.
    let primary_kept_foreign = skipped_links.iter().any(|n| n == server.primary_binary());
    let managed = preflight::managed_lsp_server_path(server);
    let unmanaged_running = if primary_kept_foreign {
        preflight::resolve_lsp_server_path_outside_managed(server)
    } else {
        None
    };
    let verdict = match install_verdict(primary_kept_foreign, unmanaged_running, managed) {
        Some(v) => v,
        // Nothing in the managed prefix either: fall back to the general resolver, and only then
        // call the install a failure.
        None => Verdict::Installed(preflight::resolve_lsp_server_path(server).ok_or_else(|| {
            format!("npm finished but {} could not be found afterwards", server.primary_binary())
        })?),
    };
    let result = result_for(verdict.status(), verdict.path().to_string(), skipped_links);
    // The STREAMED LINE is the only channel the user actually sees today — no frontend reads
    // `status` or `skippedLinks` — so the verdict has to reach the message too. Saying
    // "pyright installed at <path>" for a not-linked row is the same false claim the status stopped
    // making — and WHICH lie it is depends on the shape, which is why the two share a status but
    // not a sentence.
    emit(
        app,
        key,
        install_progress_line(key, &verdict, result.version.as_deref(), server.primary_binary()),
    );
    Ok(result)
}

/// The `setup:progress` line for a finished install. Pure so the wording — the part a user reads —
/// is assertable without an npm run. One sentence per verdict, because the two not-linked shapes
/// carry different paths and imply different actions: sharing a sentence made it false for
/// whichever shape it wasn't written for.
#[cfg(unix)]
fn install_progress_line(key: &str, verdict: &Verdict, version: Option<&str>, bin: &str) -> String {
    let version = version.map(|v| format!(" ({v})")).unwrap_or_default();
    let path = verdict.path();
    match verdict {
        Verdict::Installed(_) => format!("{key} installed at {path}{version}"),
        // `path` is the FOREIGN binary and the probed version is ITS version, so this must not say
        // "installed at {path}" — that names the shadowing binary as ours.
        Verdict::ShadowedBy(_) => format!(
            "{key} installed, but {path} is what your PATH resolves for {bin}{version} and it \
             isn't ours — Claude Code will keep running that one"
        ),
        // `path` is OUR copy, in a directory on nobody's PATH — this shape is only reached when
        // the link into ~/.local/bin was never created (KeepForeign). So "remove the foreign entry
        // and Claude Code picks ours up" would be FALSE: removing it leaves nothing at that name,
        // and nothing links ours until the install runs again and takes the Create branch. Name the
        // action that actually works.
        Verdict::ShadowedUnresolved(_) => format!(
            "{key} installed at {path}{version}, but something named {bin} on your PATH shadows it \
             and we couldn't run that one — remove or fix that entry, then install again so \
             Sparkle can link ours"
        ),
    }
}

/// The status string for "ours is on disk but it is not what will run". A const because
/// [`install_verdict`] produces it and the frontend contract quotes it; spelled twice, a rename in
/// one place silently changes what the UI is told.
#[cfg(unix)]
const STATUS_NOT_LINKED: &str = "installed-not-linked";

/// What an install actually achieved. THREE outcomes for two statuses: the two not-linked shapes
/// mean different things — one names the foreign binary that will run, the other names our own
/// copy that won't — and a single message for both is necessarily false for one of them.
#[cfg(unix)]
#[derive(Debug, PartialEq)]
enum Verdict {
    /// Ours is what runs. Path = our copy.
    Installed(String),
    /// A foreign binary shadows ours and we resolved it. Path = THAT binary: what Claude Code will
    /// run, and whose version gets probed.
    ShadowedBy(String),
    /// A foreign entry shadows ours and we could NOT resolve it (dangling, non-executable).
    /// Path = OUR copy, which is on nobody's PATH until the user fixes that entry.
    ShadowedUnresolved(String),
}

#[cfg(unix)]
impl Verdict {
    fn status(&self) -> &'static str {
        match self {
            Verdict::Installed(_) => "installed",
            Verdict::ShadowedBy(_) | Verdict::ShadowedUnresolved(_) => STATUS_NOT_LINKED,
        }
    }

    fn path(&self) -> &str {
        match self {
            Verdict::Installed(p) | Verdict::ShadowedBy(p) | Verdict::ShadowedUnresolved(p) => p,
        }
    }
}

/// Which verdict an install earns, given what the machine actually has. Pure, so the one thing that
/// must never drift — "never call a binary on nobody's PATH plainly `installed`" — is assertable
/// without an npm run. `None` means neither candidate exists and the caller should fall back to the
/// general resolver.
///
/// `cfg(unix)`: the only caller is the unix-only installer, and on Windows this would be dead code.
#[cfg(unix)]
fn install_verdict(
    primary_kept_foreign: bool,
    unmanaged_running: Option<String>,
    managed: Option<String>,
) -> Option<Verdict> {
    match (primary_kept_foreign, unmanaged_running, managed) {
        (true, Some(running), _) => Some(Verdict::ShadowedBy(running)),
        (true, None, Some(managed)) => Some(Verdict::ShadowedUnresolved(managed)),
        // Nothing shadows us. `unmanaged_running` is only ever resolved when the primary link was
        // kept foreign, so the `Some` here is unreachable from the caller; matching it explicitly
        // means a future caller that resolves it unconditionally gets the RIGHT answer (ours runs)
        // rather than silently inheriting the shadowed verdict.
        (false, _, Some(managed)) => Some(Verdict::Installed(managed)),
        (_, _, None) => None,
    }
}

#[cfg(not(unix))]
fn install_lsp_server_blocking(_app: &AppHandle, _language: &str) -> Result<LspInstallResult, String> {
    Err("automatic language-server install is only supported on macOS/Unix".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wording a user actually sees, per verdict. The status field is invisible today — no
    /// frontend reads it — so a correct verdict with a wrong message is still a false claim.
    #[cfg(unix)]
    #[test]
    fn each_verdict_gets_a_message_that_is_true_of_its_own_path() {
        let managed = "/home/me/.local/share/sparkle/lsp/bin/pyright";
        let foreign = "/opt/homebrew/bin/pyright";
        let line = |v: &Verdict| install_progress_line("pyright", v, Some("1.2.3"), "pyright");

        assert_eq!(
            line(&Verdict::Installed(managed.into())),
            format!("pyright installed at {managed} (1.2.3)")
        );

        // `path` is the foreign binary here — never call it ours.
        let shadowed = line(&Verdict::ShadowedBy(foreign.into()));
        assert!(shadowed.contains(&format!("{foreign} is what your PATH resolves")), "{shadowed}");
        assert!(!shadowed.contains(&format!("installed at {foreign}")), "{shadowed}");
        assert!(shadowed.contains("keep running that one"), "{shadowed}");

        // `path` is OURS here, and nothing will run it — the previous single not-linked sentence
        // said this path "is what your PATH resolves … and it isn't ours", false three ways over.
        let unresolved = line(&Verdict::ShadowedUnresolved(managed.into()));
        assert!(unresolved.contains(&format!("installed at {managed}")), "{unresolved}");
        assert!(!unresolved.contains("isn't ours"), "our own copy is ours: {unresolved}");
        assert!(unresolved.contains("shadows it"), "{unresolved}");
        // The action has to be one that WORKS: this shape means our copy was never linked, so
        // removing the foreign entry alone leaves the name unclaimed and LSP still off.
        assert!(unresolved.contains("remove or fix that entry"), "{unresolved}");
        assert!(
            unresolved.contains("install again"),
            "removing the shadow is not enough on its own — say so: {unresolved}"
        );

        // Both not-linked shapes still report ONE status, so the UI contract is unchanged.
        assert_eq!(Verdict::ShadowedBy(foreign.into()).status(), STATUS_NOT_LINKED);
        assert_eq!(Verdict::ShadowedUnresolved(managed.into()).status(), STATUS_NOT_LINKED);
        assert_eq!(Verdict::Installed(managed.into()).status(), "installed");
    }

    /// The install's verdict table. The row that matters is the third: a KeepForeign primary whose
    /// foreign entry we could NOT resolve. Collapsing that into plain `installed` told the user the
    /// server was ready while pointing at a copy in a directory on nobody's PATH — the silently-off
    /// LSP the verification step exists to prevent.
    #[cfg(unix)]
    #[test]
    fn install_verdict_never_calls_a_shadowed_managed_copy_plainly_installed() {
        let managed = || Some("/home/me/.local/share/sparkle/lsp/bin/pyright".to_string());
        let foreign = || Some("/opt/homebrew/bin/pyright".to_string());

        // Nothing was skipped: our copy is the one that runs.
        assert_eq!(
            install_verdict(false, None, managed()),
            Some(Verdict::Installed(managed().unwrap()))
        );
        // A foreign binary shadows ours AND resolves: report the one that actually runs.
        assert_eq!(
            install_verdict(true, foreign(), managed()),
            Some(Verdict::ShadowedBy(foreign().unwrap()))
        );
        // A foreign binary shadows ours and does NOT resolve (dangling / non-executable): still a
        // successful install, still NOT a clean `installed` — and a DIFFERENT shape from the row
        // above, which is why they are separate variants rather than one status string.
        assert_eq!(
            install_verdict(true, None, managed()),
            Some(Verdict::ShadowedUnresolved(managed().unwrap()))
        );
        // Nothing was skipped, so whatever a foreign resolve turned up is irrelevant: ours runs.
        assert_eq!(
            install_verdict(false, foreign(), managed()),
            Some(Verdict::Installed(managed().unwrap())),
            "a foreign runner without a kept-foreign primary must not downgrade the verdict"
        );
        // Neither: the caller falls back to the general resolver.
        assert_eq!(install_verdict(true, None, None), None);
        assert_eq!(install_verdict(false, None, None), None);
    }

    // Captured VERBATIM from a real `roborev check-agents --agent claude-code` run inside a launchd
    // LaunchAgent using daemon_path_env() — the exact environment the shipped daemon gets. Pinning
    // the real bytes (not a hand-written approximation) is the point: if a roborev upgrade changes
    // this format, these fail instead of the probe silently returning Unknown forever.
    const REAL_PASS: &str = "  ? claude-code    claude (/Users/drodio/.local/bin/claude) ... OK (2 bytes)\n\n1 passed, 0 failed, 0 skipped\n";
    const REAL_MISSING: &str =
        "  - claude-code    claude (not found in PATH)\n\n0 passed, 0 failed, 1 skipped\n";

    #[test]
    fn classify_check_agents_reads_a_real_launchd_pass() {
        assert_eq!(classify_check_agents(REAL_PASS), RoborevAuthVerdict::Passed);
    }

    #[test]
    fn classify_check_agents_distinguishes_missing_claude_from_a_failure() {
        // "not found in PATH" is reported as SKIPPED, so the summary alone reads `0 failed` — which
        // must NOT be mistaken for a pass. This is the vacuous-success trap the probe exists to avoid.
        assert_eq!(classify_check_agents(REAL_MISSING), RoborevAuthVerdict::ClaudeMissing);
    }

    #[test]
    fn classify_check_agents_calls_a_failed_smoke_test_not_authenticated() {
        let out = "  x claude-code    claude (/usr/local/bin/claude) ... FAILED\n\n0 passed, 1 failed, 0 skipped\n";
        assert_eq!(classify_check_agents(out), RoborevAuthVerdict::NotAuthenticated);
    }

    #[test]
    fn classify_check_agents_never_invents_a_pass() {
        // Zero passed + zero failed (skipped for an unmatched reason), unparseable output, and empty
        // output must all decline to claim success — a silent no-op daemon is the failure we're
        // guarding against, so "I don't know" can never render as "on".
        for out in ["0 passed, 0 failed, 1 skipped\n", "totally unexpected text\n", ""] {
            assert!(
                matches!(classify_check_agents(out), RoborevAuthVerdict::Unknown(_)),
                "expected Unknown for {out:?}"
            );
        }
    }

    #[test]
    fn parse_check_agents_summary_only_matches_the_summary_line() {
        assert_eq!(parse_check_agents_summary("1 passed, 0 failed, 0 skipped"), Some((1, 0)));
        assert_eq!(parse_check_agents_summary("  2 passed, 3 failed, 1 skipped  "), Some((2, 3)));
        // Not the summary → None, so a stray line can't be read as a verdict.
        assert_eq!(parse_check_agents_summary("  ? claude-code    claude ... OK"), None);
        assert_eq!(parse_check_agents_summary(""), None);
        assert_eq!(parse_check_agents_summary("1 passed"), None);
    }

    #[test]
    fn daemon_path_env_puts_the_account_shim_first_and_still_bans_the_api_key_shim() {
        let p = daemon_path_env(Path::new("/Users/ada"));
        // The account-selecting shim must resolve BEFORE the real claude, or roborev looks the real
        // one up directly and no rotation can happen.
        assert!(
            p.starts_with("/Users/ada/.sparkle/roborev-claude:"),
            "account shim must be first on the daemon PATH: {p}"
        );
        assert!(p.contains("/Users/ada/.local/bin:"), "user bin must still be on PATH: {p}");
        assert!(
            p.find("/Users/ada/.sparkle/roborev-claude").unwrap()
                < p.find("/Users/ada/.local/bin").unwrap(),
            "shim must precede the real claude: {p}"
        );
        // The RETIRED shim — which injected ANTHROPIC_API_KEY and forced CLAUDE_CODE_SIMPLE=1
        // against an unfunded key, killing every review — must NEVER be on the daemon PATH. That
        // ban is unrelated to the account shim above and still holds.
        assert!(!p.contains(".roborev-shim"), "API-key shim must not be on the daemon PATH: {p}");
    }

    #[test]
    fn daemon_plist_path_comes_from_daemon_path_env() {
        // The plist and the self-test MUST agree, or the probe tests an environment the daemon
        // never runs in. Assert the plist actually embeds the shared helper's output.
        let home = Path::new("/Users/ada");
        let plist = roborev_daemon_plist("/Users/ada/.local/bin/roborev", home);
        assert!(plist.contains(&daemon_path_env(home)), "plist PATH drifted from daemon_path_env");
    }

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
    fn roborev_asset_only_apple_silicon_macos() {
        // Apple Silicon macOS is the ONLY published target at v0.1 (aarch64 is what
        // std::env::consts::ARCH yields on an arm64 Mac; the arm64 synonym is also accepted).
        assert_eq!(
            roborev_asset("macos", "aarch64"),
            Some((
                "roborev-darwin-arm64",
                "ebaba77e6a62670cd6bcc793fd484eda64b8ecebb1d2f9997e950363c37ab070"
            ))
        );
        assert_eq!(
            roborev_asset("macos", "arm64").map(|(n, _)| n),
            Some("roborev-darwin-arm64")
        );
        // Intel macOS and every non-macOS target have NO asset — the install surfaces a clean error.
        assert_eq!(roborev_asset("macos", "x86_64"), None);
        assert_eq!(roborev_asset("linux", "x86_64"), None);
        assert_eq!(roborev_asset("windows", "aarch64"), None);
    }

    #[test]
    fn roborev_download_url_is_the_pinned_github_release_asset() {
        let (asset, _) = roborev_asset("macos", "aarch64").unwrap();
        let url = roborev_download_url(ROBOREV_TAG, asset);
        assert_eq!(
            url,
            "https://github.com/plow-pbc/seed-auto-roborev/releases/download/v0.1/roborev-darwin-arm64"
        );
        assert!(url.starts_with("https://github.com/plow-pbc/seed-auto-roborev/releases/download/"));
    }

    #[test]
    fn roborev_daemon_plist_has_daemon_run_normal_path_no_key() {
        let plist = roborev_daemon_plist(
            "/Users/x/.local/bin/roborev",
            std::path::Path::new("/Users/x"),
        );
        // Label + ProgramArguments `daemon run`.
        assert!(plist.contains("<string>co.plow.roborev-daemon</string>"));
        assert!(plist.contains("<string>/Users/x/.local/bin/roborev</string>"));
        assert!(plist.contains("<string>daemon</string>"));
        assert!(plist.contains("<string>run</string>"));
        // RunAtLoad + KeepAlive so the daemon survives logout/reboot.
        assert!(plist.contains("<key>RunAtLoad</key>\n    <true/>"));
        assert!(plist.contains("<key>KeepAlive</key>\n    <true/>"));
        // A NORMAL user PATH, with Sparkle's account-selecting shim ahead of it so roborev's
        // `claude` lookup can be pointed at a healthy account per review job.
        assert!(plist.contains(
            "/Users/x/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        ));
        assert!(plist.contains("/Users/x/.sparkle/roborev-claude"));
        // CRUCIALLY still no API key anywhere: the claude child authenticates as a SUBSCRIPTION
        // login. The shim chooses WHICH subscription account; it never supplies a credential.
        // (The blanket `!contains("shim")` this replaces was a proxy for these two invariants —
        // it banned the mechanism by name rather than the behavior that was actually unsafe.)
        assert!(!plist.contains("ANTHROPIC_API_KEY"));
        assert!(!plist.contains("CLAUDE_CODE_SIMPLE"));
        assert!(!plist.contains(".roborev-shim"), "the retired API-key shim must stay off PATH");
    }

    #[test]
    fn roborev_daemon_plist_xml_escapes_a_weird_home() {
        // A home dir containing `&`/`<` must not corrupt the plist XML.
        let plist = roborev_daemon_plist("/Users/a&b/.local/bin/roborev", std::path::Path::new("/Users/a&b"));
        assert!(plist.contains("/Users/a&amp;b/.local/bin/roborev"));
        assert!(!plist.contains("a&b/.local")); // the raw ampersand must be gone
    }

    #[test]
    fn roborev_tag_is_pinned_shape() {
        assert!(ROBOREV_TAG.starts_with('v'));
    }

    #[test]
    fn node_version_is_pinned_https_reachable_shape() {
        // Guard the pinned version stays a well-formed vX.Y.Z the URL builder expects.
        assert!(NODE_VERSION.starts_with('v'));
        assert_eq!(NODE_VERSION.split('.').count(), 3);
    }

    // ── LSP language-server installs ──────────────────────────────────────────────────────────

    #[test]
    fn lsp_npm_specs_pin_every_auto_installable_server() {
        let ts = lsp_npm_specs(LspServer::TypeScriptLanguageServer).unwrap();
        // typescript-language-server drives `tsserver`, which comes from the `typescript` package —
        // installing one without the other yields a server that starts and does nothing.
        assert_eq!(
            ts,
            vec![
                format!("typescript-language-server@{TYPESCRIPT_LANGUAGE_SERVER_VERSION}"),
                format!("typescript@{TYPESCRIPT_VERSION}"),
            ]
        );
        assert_eq!(lsp_npm_specs(LspServer::Pyright).unwrap(), vec![format!("pyright@{PYRIGHT_VERSION}")]);
        // Every spec must carry an explicit version — an unpinned `latest` is how an install that
        // worked yesterday breaks today (see the TYPESCRIPT_VERSION note).
        for spec in ts.iter().chain(lsp_npm_specs(LspServer::Pyright).unwrap().iter()) {
            assert!(spec.contains('@'), "unpinned spec: {spec}");
            let version = spec.rsplit('@').next().unwrap();
            assert!(!version.is_empty() && version != "latest", "unpinned spec: {spec}");
        }
    }

    #[test]
    fn lsp_npm_specs_none_for_the_detection_only_tier() {
        for s in [LspServer::RustAnalyzer, LspServer::Gopls, LspServer::SourceKitLsp] {
            assert!(lsp_npm_specs(s).is_none(), "{s:?} must have no npm install path");
        }
    }

    #[test]
    fn typescript_pin_predates_the_tsserver_removal() {
        // TypeScript 7 is the native Go port and ships no `lib/tsserver.js`, so pinning to `latest`
        // would install a language server that can't do anything. Guard the pin stays on a major
        // that still ships tsserver — if someone bumps this to 7.x, this test is the tripwire.
        let major: u32 = TYPESCRIPT_VERSION.split('.').next().unwrap().parse().unwrap();
        assert!(
            major <= 6,
            "typescript@{TYPESCRIPT_VERSION} has no tsserver — typescript-language-server needs one"
        );
    }

    #[test]
    fn npm_install_args_are_a_no_sudo_prefixed_global_install() {
        let args = npm_install_args(
            Path::new("/Users/x/.local/share/sparkle/lsp"),
            &["pyright@1.2.3".to_string()],
        );
        assert_eq!(args[0], "install");
        // --global WITHOUT --prefix would write to the machine's npm prefix (often /usr/local →
        // sudo, or the user's nvm dir → not ours to touch). The pair is what makes this no-sudo.
        assert!(args.contains(&"--global".to_string()));
        let prefix_at = args.iter().position(|a| a == "--prefix").expect("--prefix must be passed");
        assert_eq!(args[prefix_at + 1], "/Users/x/.local/share/sparkle/lsp");
        assert_eq!(args.last().unwrap(), "pyright@1.2.3");
    }

    #[test]
    fn npm_install_args_pass_every_spec() {
        let specs = lsp_npm_specs(LspServer::TypeScriptLanguageServer).unwrap();
        let args = npm_install_args(Path::new("/tmp/prefix"), &specs);
        for spec in &specs {
            assert!(args.contains(spec), "{spec} missing from argv");
        }
    }

    #[test]
    fn lsp_bin_symlinks_link_managed_bins_into_the_probed_dir() {
        let managed = PathBuf::from("/Users/x/.local/share/sparkle/lsp/bin");
        let link_dir = PathBuf::from("/Users/x/.local/bin");
        let links = lsp_bin_symlinks(
            &managed,
            &link_dir,
            LspServer::Pyright.linked_binaries(),
        );
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].0, PathBuf::from("/Users/x/.local/bin/pyright-langserver"));
        assert_eq!(
            links[0].1,
            PathBuf::from("/Users/x/.local/share/sparkle/lsp/bin/pyright-langserver")
        );
        // Every link must land in the ~/.local/bin dir preflight already probes, or Claude Code
        // never sees the server we just installed.
        for (link, target) in &links {
            assert!(link.starts_with(&link_dir));
            assert!(target.starts_with(&managed));
        }
    }

    #[test]
    fn lsp_bin_symlinks_empty_for_detection_only_servers() {
        let links = lsp_bin_symlinks(
            Path::new("/m/bin"),
            Path::new("/l/bin"),
            LspServer::Gopls.linked_binaries(),
        );
        assert!(links.is_empty(), "we install nothing for gopls, so there's nothing to link");
    }

    // link_action is the guard that keeps a re-install non-destructive; exercise it against REAL
    // symlinks/files in a temp dir rather than mocking the filesystem.
    #[cfg(unix)]
    #[test]
    fn link_action_creates_replaces_ours_and_keeps_foreign() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("sparkle-link-action-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let prefix = root.join("managed");
        let managed_bin = prefix.join("bin");
        let link_dir = root.join("localbin");
        std::fs::create_dir_all(&managed_bin).unwrap();
        std::fs::create_dir_all(&link_dir).unwrap();
        let target = managed_bin.join("pyright-langserver");
        std::fs::write(&target, b"#!/bin/sh\n").unwrap();

        // (a) Nothing there yet → create.
        let link = link_dir.join("pyright-langserver");
        assert_eq!(link_action(&link, &prefix), LinkAction::Create);

        // (b) A symlink into our managed prefix → ours, replace it (this is the idempotent re-run:
        //     installing twice must repoint the link, not fail and not duplicate).
        symlink(&target, &link).unwrap();
        assert_eq!(link_action(&link, &prefix), LinkAction::Replace);

        // (c) A real binary the user installed themselves → never clobber it.
        let foreign_link = link_dir.join("typescript-language-server");
        std::fs::write(&foreign_link, b"#!/bin/sh\necho users own\n").unwrap();
        assert_eq!(link_action(&foreign_link, &prefix), LinkAction::KeepForeign);

        // (d) A symlink pointing OUTSIDE our prefix (e.g. nvm) is foreign too.
        let elsewhere = root.join("nvm-tsls");
        std::fs::write(&elsewhere, b"#!/bin/sh\n").unwrap();
        let nvm_link = link_dir.join("nvm-linked");
        symlink(&elsewhere, &nvm_link).unwrap();
        assert_eq!(link_action(&nvm_link, &prefix), LinkAction::KeepForeign);

        // (e) A DANGLING symlink of ours still reads as ours and gets replaced — otherwise a
        //     half-cleaned prefix would leave the link permanently broken.
        std::fs::remove_file(&target).unwrap();
        assert_eq!(link_action(&link, &prefix), LinkAction::Replace);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn link_action_is_stable_across_repeated_installs() {
        // Idempotency in the shape the installer actually uses it: link, then re-decide, then
        // re-link. The second pass must not error, duplicate, or turn our own link into "foreign".
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("sparkle-link-idem-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let prefix = root.join("managed");
        let managed_bin = prefix.join("bin");
        let link_dir = root.join("localbin");
        std::fs::create_dir_all(&managed_bin).unwrap();
        std::fs::create_dir_all(&link_dir).unwrap();
        let target = managed_bin.join("typescript-language-server");
        std::fs::write(&target, b"#!/bin/sh\n").unwrap();
        let link = link_dir.join("typescript-language-server");

        for pass in 0..3 {
            match link_action(&link, &prefix) {
                LinkAction::Create | LinkAction::Replace => {
                    let _ = std::fs::remove_file(&link);
                    symlink(&target, &link).unwrap();
                }
                LinkAction::KeepForeign => panic!("pass {pass}: our own link read as foreign"),
            }
            assert_eq!(std::fs::read_link(&link).unwrap(), target);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_rejects_an_unknown_language_key() {
        // The command takes a string across the IPC boundary; a typo must be a clean error, not a
        // silent no-op or a panic.
        assert!(ProjectLanguage::from_key("kotlin").is_none());
        assert!(ProjectLanguage::from_key("").is_none());
    }
}

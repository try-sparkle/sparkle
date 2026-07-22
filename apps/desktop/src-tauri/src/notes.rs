// apps/desktop/src-tauri/src/notes.rs
//! Lightweight "save selection" sinks for the terminal selection popup:
//! append a note to the project's NOTES.md, or create a beads issue via the `bd` CLI.
//! Both run against the user-chosen project root (not the hidden worktree).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// `bd` resolution — kill the per-call login shell (PERF)
//
// Every bd invocation below used to run `/bin/zsh -l -c 'cd "$N" && bd …'`. A `zsh -l` startup
// re-sources the user's login dotfiles (nvm/pyenv/heavy .zprofile) and costs 100-500ms — and
// `list_beads` alone pays it EVERY 5s per open project (the beadsStore poll). Instead we resolve
// bd's ABSOLUTE path ONCE per session (a login-shell PATH probe + canonical-location fallback —
// the exact approach preflight.rs uses for claude/node/git; those resolver helpers are private to
// that module, so the small probe is mirrored here across the module boundary) and exec bd
// DIRECTLY, with no shell on the hot path. bd's own args were already passed positionally
// (injection-safe); as real argv tokens now they keep that property with no shell in the loop.
// ---------------------------------------------------------------------------

/// Session cache for bd's resolved absolute path. Only a positive hit is cached (a miss re-probes
/// next call) so a bd installed while the app runs is picked up without a restart — matching
/// preflight.rs's cache policy.
fn bd_path_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Canonical absolute `bd` install locations, user-first: native/non-sudo installs (`~/.local/bin`),
/// `go install` (`~/go/bin`), `cargo install` (`~/.cargo/bin`), then Homebrew prefixes. Pure form
/// (home passed in) so it's unit-testable without mutating the process-global HOME.
fn known_bd_paths_for(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/bd")); // native / non-sudo install
        paths.push(home.join("go/bin/bd")); // `go install`
        paths.push(home.join(".cargo/bin/bd")); // `cargo install`
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/bd")); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin/bd")); // homebrew (Intel) / npm
    paths
}

/// True if `p` resolves to an existing, executable file (symlinks followed). Mirrors preflight.rs's
/// private `is_executable` (can't be reused across the module boundary).
#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Windows has no executable bit; treat any existing regular file as runnable (the candidates are
/// absolute install paths, and the primary resolver there is `where` anyway).
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

/// Probe the user's LOGIN shell ONCE for `bd`'s absolute path. macOS GUI apps inherit no shell
/// PATH, so a bare `Command::new("bd")` misses a Homebrew/user-local bd; the login shell resolves
/// whatever PATH the user actually configured. Mirrors preflight.rs's
/// `run_in_login_shell("command -v …")`.
#[cfg(unix)]
fn login_shell_which_bd() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    Command::new(shell)
        .args(["-lc", "command -v bd"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|p| Path::new(p).is_absolute() && is_executable(Path::new(p)))
}

/// Windows: resolve `bd` via `where` (GUI apps inherit PATH). Returns the first hit.
#[cfg(not(unix))]
fn windows_which_bd() -> Option<String> {
    Command::new("where")
        .arg("bd")
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

/// Resolve bd's absolute path WITHOUT caching: login/`where` probe first, then the canonical
/// install locations.
fn resolve_bd_uncached() -> Option<String> {
    #[cfg(unix)]
    {
        login_shell_which_bd().or_else(|| {
            first_executable(&known_bd_paths_for(std::env::var_os("HOME").map(PathBuf::from)))
        })
    }
    #[cfg(not(unix))]
    {
        windows_which_bd().or_else(|| {
            let home = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from);
            first_executable(&known_bd_paths_for(home))
        })
    }
}

/// bd's resolved absolute path, cached for the session (positive-hit-only, per the cache note).
/// Concurrent callers may both resolve on a cold cache (idempotent); a poisoned lock falls back to
/// an uncached resolve.
fn cached_bd_path() -> Option<String> {
    if let Ok(guard) = bd_path_cache().lock() {
        if let Some(path) = guard.as_ref() {
            return Some(path.clone());
        }
    }
    let resolved = resolve_bd_uncached();
    if let Some(path) = resolved.as_ref() {
        if let Ok(mut guard) = bd_path_cache().lock() {
            *guard = Some(path.clone());
        }
    }
    resolved
}

/// PATH we hand `bd` so its OWN child processes resolve — bd shells out to `git` for its
/// git-backed jsonl storage, and a GUI app's inherited PATH is too bare to find it. Built ONCE
/// from bd's dir + the resolved git dir (reusing preflight's cached git resolver) + the canonical
/// bin locations, ahead of the inherited PATH. Cached for the session.
fn bd_exec_path() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut candidates: Vec<PathBuf> = Vec::new();
            // bd's own dir (a helper next to bd resolves) and git's dir (bd → git).
            if let Some(bd) = cached_bd_path() {
                if let Some(dir) = Path::new(&bd).parent() {
                    candidates.push(dir.to_path_buf());
                }
            }
            if let Some(git) = crate::preflight::resolve_git_path_cached() {
                if let Some(dir) = Path::new(&git).parent() {
                    candidates.push(dir.to_path_buf());
                }
            }
            if let Some(home) = std::env::var_os("HOME") {
                candidates.push(PathBuf::from(&home).join(".local/bin"));
            }
            for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            {
                candidates.push(PathBuf::from(d));
            }
            let mut dirs: Vec<String> = Vec::new();
            for c in candidates {
                let s = c.to_string_lossy().to_string();
                if !s.is_empty() && !dirs.contains(&s) {
                    dirs.push(s);
                }
            }
            if let Ok(inherited) = std::env::var("PATH") {
                if !inherited.is_empty() {
                    dirs.push(inherited);
                }
            }
            dirs.join(":")
        })
        .clone()
}

/// Run `bd <args>` inside `project_path`, DIRECTLY (no shell) using the session-cached absolute bd
/// path and an augmented PATH (so bd's `git` subprocess resolves under a GUI app's bare PATH).
/// Replaces the old `/bin/zsh -l -c 'cd "$N" && bd …'` on every call — see the module note on why
/// the login shell was a hot-path tax. `args` are real argv tokens (never a shell string), so they
/// stay injection-safe exactly as the old positional-`$N` scheme was. `.current_dir` replaces the
/// script's `cd "$N"` (and, as a bonus, drops the dotfile-`cd` hazard the old comment guarded).
fn run_bd(project_path: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let bd = cached_bd_path()
        .ok_or_else(|| "bd not found — install beads or add `bd` to your PATH".to_string())?;
    Command::new(&bd)
        .args(args)
        .current_dir(project_path)
        .env("PATH", bd_exec_path())
        .output()
        .map_err(|e| format!("failed to run bd: {e}"))
}

/// Constrain `project_path` to a legitimate project root before we touch the filesystem under it
/// (SECURITY). The basename is already gated (`validate_bare_filename`), but an unrestricted
/// `project_path` let the webview write `NOTES.md` / `PRD/<name>.md` into — or read
/// `PRD/<name>.md` out of — ANY directory the user can access (`~/.ssh`, `~/Library`, `/etc`, …).
/// Every real Sparkle project root is a git repository (the whole app is git-worktree based;
/// `bd`/PRD/NOTES all live in a repo), so we require an absolute, existing directory that contains
/// a `.git` entry — a DIR in a normal clone, a FILE in a linked worktree — which those sensitive
/// non-repo targets never do. We canonicalize FIRST so a symlink or `..` can't smuggle the check
/// across a repo boundary. Returns the canonical root to use for the join.
fn validate_project_root(project_path: &str) -> Result<PathBuf, String> {
    if project_path.is_empty() {
        return Err("project_path must not be empty".into());
    }
    let raw = Path::new(project_path);
    if !raw.is_absolute() {
        return Err(format!("project_path must be an absolute path: {project_path}"));
    }
    let real = std::fs::canonicalize(raw)
        .map_err(|e| format!("project_path is not an accessible directory: {project_path} ({e})"))?;
    if !real.is_dir() {
        return Err(format!("project_path is not a directory: {}", real.display()));
    }
    if !real.join(".git").exists() {
        return Err(format!(
            "project_path is not a registered project root (no git repository): {}",
            real.display()
        ));
    }
    Ok(real)
}

/// Append a timestamped note to `<project_path>/NOTES.md`, creating the file if needed.
/// The timestamp is supplied by the frontend (ISO 8601) to avoid pulling a date crate.
/// `project_path` is constrained to a real project root (see `validate_project_root`).
#[tauri::command]
pub fn append_note(project_path: String, text: String, timestamp: String) -> Result<(), String> {
    let root = validate_project_root(&project_path)?;
    let path = root.join("NOTES.md");
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    write!(f, "\n\n## {timestamp}\n{text}\n").map_err(|e| format!("write NOTES.md: {e}"))?;
    Ok(())
}

/// Create a beads issue in `project_path` via `bd create`. Execs bd DIRECTLY (resolved absolute
/// path, no login shell — see the module note). Title/body are passed as real argv tokens, never
/// interpolated into a shell string, so they can't break out of the command; `run_bd` pins the cwd
/// via `.current_dir` (replacing the old `cd "$3"`). Returns bd's raw `--json` stdout (the created
/// issue, or an `{"error": …}` object).
#[tauri::command]
pub async fn create_bead(project_path: String, title: String, body: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_bd(&project_path, &["create", &title, "-d", &body, "--json"])?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        select_bd_result(output.status.success(), &stdout, &stderr)
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Decide what to return from `create_bead` given bd's process result. Extracted as a pure
/// function so the (otherwise shell-dependent) branch ordering is unit-testable.
///
/// bd emits a JSON object on both success and (caught) error. The frontend parses that JSON
/// (success -> id, caught error -> `{"error": …}`), so whenever stdout looks like bd's JSON
/// payload we return it regardless of exit status — even if bd also wrote a warning to stderr
/// on a non-zero exit. Only when stdout is NOT bd's JSON (shell error, missing `bd`, crash) do
/// we surface stderr (or stdout) as a raw error string for the frontend to display.
fn select_bd_result(success: bool, stdout: &str, stderr: &str) -> Result<String, String> {
    if stdout.starts_with('{') {
        return Ok(stdout.to_string());
    }
    if success {
        if stdout.is_empty() {
            return Err("bd produced no output".into());
        }
        // Clean exit but non-JSON stdout — pass it through; the frontend reports it verbatim.
        return Ok(stdout.to_string());
    }
    if !stderr.is_empty() {
        return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("bd produced no output".into())
}

/// Result handling for bd READ commands (`bd list`/`bd show --json`) whose stdout is a JSON
/// array/object the frontend parses directly. Unlike `select_bd_result` (which extracts an id),
/// this returns bd's full stdout verbatim on success.
fn select_bd_raw(success: bool, stdout: &str, stderr: &str) -> Result<String, String> {
    if success {
        if stdout.is_empty() {
            return Err("bd produced no output".into());
        }
        return Ok(stdout.to_string());
    }
    // Failure: prefer bd's structured JSON error if it emitted one, else stderr, else stdout.
    if stdout.starts_with('{') {
        return Ok(stdout.to_string());
    }
    if !stderr.is_empty() {
        return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("bd produced no output".into())
}

/// Result handling for bd MUTATION commands (`dep add`, `label add/remove`) whose stdout may be
/// empty on success and is not necessarily JSON. Returns "ok" for a silent success so the caller
/// always gets a non-empty confirmation string.
fn select_bd_action(success: bool, stdout: &str, stderr: &str) -> Result<String, String> {
    if success {
        return Ok(if stdout.is_empty() { "ok".to_string() } else { stdout.to_string() });
    }
    if stdout.starts_with('{') {
        return Ok(stdout.to_string());
    }
    if !stderr.is_empty() {
        return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("bd produced no output".into())
}

/// Shared bare-filename gate for the PRD read/write commands: reject anything containing a path
/// separator, a `..` traversal, an absolute path, or a `:` (a Windows drive-relative name like
/// `C:secret.txt` is neither separated nor absolute, yet `Path::join` would replace the whole
/// base path there), so a caller can never escape `PRD/`.
fn validate_bare_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains(':')
        || filename.contains("..")
        || Path::new(filename).is_absolute()
    {
        return Err(format!("invalid filename (must be a bare filename): {filename}"));
    }
    Ok(())
}

/// Write a markdown doc into the project's `PRD/` directory. `filename` MUST be a bare filename
/// (see `validate_bare_filename`). Creates `PRD/` if needed and returns the repo-relative path
/// (`PRD/<filename>`) on success.
#[tauri::command]
pub fn write_prd(project_path: String, filename: String, content: String) -> Result<String, String> {
    validate_bare_filename(&filename)?;
    let root = validate_project_root(&project_path)?;
    let prd_dir = root.join("PRD");
    std::fs::create_dir_all(&prd_dir).map_err(|e| format!("create {}: {e}", prd_dir.display()))?;
    let path = prd_dir.join(&filename);
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(format!("PRD/{filename}"))
}

/// Read a markdown doc back out of the project's `PRD/` directory — the read counterpart of
/// `write_prd`, behind the same `validate_bare_filename` gate. Returns the file content; a
/// missing file is an Err (caller decides how to degrade).
#[tauri::command]
pub fn read_prd(project_path: String, filename: String) -> Result<String, String> {
    validate_bare_filename(&filename)?;
    let root = validate_project_root(&project_path)?;
    let path = root.join("PRD").join(&filename);
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}

/// The `.gitignore` rule keeping capture screenshots out of git history. Screen captures
/// routinely contain sensitive content (tokens, emails, other apps) and must never be
/// committed — they stay local, referenced by repo-relative path.
const CAPTURE_ASSETS_IGNORE: &str = "PRD/assets/";

/// Pure: return `.gitignore` content with the `PRD/assets/` rule appended, or `None` when the
/// rule (with or without the trailing slash) is already present and no write is needed.
fn ensure_ignore_rule(existing: &str) -> Option<String> {
    let already = existing
        .lines()
        .map(|l| l.trim())
        .any(|l| l == CAPTURE_ASSETS_IGNORE || l == "PRD/assets");
    if already {
        return None;
    }
    let mut contents = existing.to_string();
    if !contents.is_empty() && !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(CAPTURE_ASSETS_IGNORE);
    contents.push('\n');
    Some(contents)
}

/// Copy a capture screenshot into `<project_path>/PRD/assets/<filename>` (dir created if
/// needed) and ensure `PRD/assets/` is gitignored. `filename` MUST be a bare filename (same
/// `validate_bare_filename` traversal gate as `write_prd`). `src` is an absolute path to the
/// screencapture temp file (copied FROM, not resolved within the repo). Returns the
/// repo-relative path (`PRD/assets/<filename>`).
#[tauri::command]
pub fn copy_capture_asset(
    project_path: String,
    src: String,
    filename: String,
) -> Result<String, String> {
    validate_bare_filename(&filename)?;
    let root = validate_project_root(&project_path)?;
    let assets_dir = root.join("PRD").join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("create {}: {e}", assets_dir.display()))?;
    let dest = assets_dir.join(&filename);
    std::fs::copy(&src, &dest).map_err(|e| format!("copy {src} -> {}: {e}", dest.display()))?;

    let gitignore = root.join(".gitignore");
    let existing = std::fs::read_to_string(&gitignore).unwrap_or_default();
    if let Some(updated) = ensure_ignore_rule(&existing) {
        std::fs::write(&gitignore, updated)
            .map_err(|e| format!("write {}: {e}", gitignore.display()))?;
    }
    Ok(format!("PRD/assets/{filename}"))
}

/// List all beads in `project_path` via `bd list --all --limit 0 --json`. Returns bd's raw JSON
/// stdout (a JSON array) for the frontend to parse. `--all` is REQUIRED: a bare `bd list` applies
/// a default filter that excludes closed issues (so the board's "done"/"delivered" columns come
/// back empty) and caps output at 50 rows; `--all --limit 0` overrides both so the board sees every
/// issue in every status. Execs bd DIRECTLY (resolved absolute path, no login shell — see the
/// module note); this is the 5s-poll hot path the perf fix targets.
#[tauri::command]
pub async fn list_beads(project_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_bd(&project_path, &["list", "--all", "--limit", "0", "--json"])?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        select_bd_raw(output.status.success(), &stdout, &stderr)
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Ensure `project_path` has a beads database, creating one with `bd init` if none resolves yet.
/// Idempotent and safe to call on every board open: it first probes `bd where` (which honors
/// BEADS_DIR / parent-directory / redirect resolution, so a project that legitimately inherits a
/// parent's beads workspace is left untouched) and only runs `bd init` when NO workspace resolves.
/// `--non-interactive` avoids any prompt in the GUI-spawned (TTY-less) shell; `--quiet` keeps
/// stdout clean; the issue prefix defaults to the project directory name. Execs bd DIRECTLY
/// (resolved absolute path, no login shell — see the module note). Returns "exists" when a DB
/// already resolved, "initialized" after a fresh `bd init`, and Err(..) only when `bd init` itself
/// failed — a probe (`bd where`) failure is treated as "needs init", never fatal.
#[tauri::command]
pub async fn ensure_beads_db(project_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Probe: does bd already resolve a workspace here (own DB, a parent's, or a redirect)?
        // `bd where` exits 0 when one resolves, non-zero when none does.
        let probe = run_bd(&project_path, &["where"])?;
        if probe.status.success() {
            return Ok("exists".to_string());
        }

        // No workspace resolved — create one in the project root.
        let init = run_bd(&project_path, &["init", "--non-interactive", "--quiet"])?;
        if init.status.success() {
            return Ok("initialized".to_string());
        }
        let stderr = String::from_utf8_lossy(&init.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&init.stdout).trim().to_string();
        Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "bd init failed".to_string()
        })
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Show a single bead via `bd show <id> --json`. Returns bd's raw JSON stdout. `id` is validated
/// (can't be flag-like) and passed as a real argv token, never interpolated into a script.
#[tauri::command]
pub async fn bead_show(project_path: String, id: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_bd(&project_path, &["show", &id, "--json"])?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        select_bd_raw(output.status.success(), &stdout, &stderr)
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Assemble the `bd create …` argv (the tokens AFTER `bd`). Every value (title, body, type,
/// parent, deps, labels) is a distinct argv token — NEVER interpolated into a shell string — so it
/// is injection-safe, matching `create_bead`. Optional flags (`--parent`/`--deps`/`-l`) and their
/// values are appended ONLY when non-empty. Empty `issue_type` defaults to "task". Pure (no I/O) so
/// the assembly is unit-testable without invoking bd. The cwd is set by `run_bd` (`.current_dir`),
/// so — unlike the old shell form — the project path is not part of the argv.
fn build_create_bead_args(
    title: &str,
    body: &str,
    issue_type: &str,
    parent: &str,
    deps: &str,
    labels: &str,
) -> Vec<String> {
    let issue_type = if issue_type.trim().is_empty() { "task" } else { issue_type };
    let mut args: Vec<String> = vec![
        "create".to_string(),
        title.to_string(),
        "-d".to_string(),
        body.to_string(),
        "-t".to_string(),
        issue_type.to_string(),
    ];
    if !parent.trim().is_empty() {
        args.push("--parent".to_string());
        args.push(parent.to_string());
    }
    if !deps.trim().is_empty() {
        args.push("--deps".to_string());
        args.push(deps.to_string());
    }
    if !labels.trim().is_empty() {
        args.push("-l".to_string());
        args.push(labels.to_string());
    }
    args.push("--json".to_string());
    args
}

/// Create a fully-specified bead: title + body, with an issue type (default "task") and optional
/// parent, dependencies, and labels. See `build_create_bead_args` for the injection-safe arg
/// assembly. Returns bd's `--json` payload via `select_bd_result` (id on success, `{"error":…}`
/// on a caught bd error).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_bead_full(
    project_path: String,
    title: String,
    body: String,
    issue_type: String,
    parent: String,
    deps: String,
    labels: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args = build_create_bead_args(&title, &body, &issue_type, &parent, &deps, &labels);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = run_bd(&project_path, &arg_refs)?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        select_bd_result(output.status.success(), &stdout, &stderr)
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Add a dependency: `bd dep add <blocked> <blocker>` — `blocked_id` depends on (is blocked by)
/// `blocker_id`. Both ids are validated (can't be flag-like) and passed as real argv tokens.
#[tauri::command]
pub async fn bead_dep_add(
    project_path: String,
    blocked_id: String,
    blocker_id: String,
) -> Result<String, String> {
    if !valid_bead_id(&blocked_id) {
        return Err(format!("invalid bead id: {blocked_id}"));
    }
    if !valid_bead_id(&blocker_id) {
        return Err(format!("invalid bead id: {blocker_id}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_bd(&project_path, &["dep", "add", &blocked_id, &blocker_id])?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        select_bd_action(output.status.success(), &stdout, &stderr)
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Claim a bead — mark it in_progress. `bd update <id> --claim`. Idempotent server-side, so the
/// app can fire it on every entry into a "building" stage without churn.
/// Sync core of [`bead_claim`]; a plain fn so the async command offloads it via `spawn_blocking`
/// and the tests can drive the id-validation guard directly.
fn bead_claim_inner(project_path: String, id: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    let output = run_bd(&project_path, &["update", &id, "--claim"])?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_action(output.status.success(), &stdout, &stderr)
}

#[tauri::command]
pub async fn bead_claim(project_path: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bead_claim_inner(project_path, id))
        .await
        .map_err(|e| format!("bd task failed: {e}"))?
}

/// Close a bead (mark done). `bd close <id>`. Idempotent server-side.
#[tauri::command]
pub async fn bead_close(project_path: String, id: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_bd(&project_path, &["close", &id])?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        select_bd_action(output.status.success(), &stdout, &stderr)
    })
    .await
    .map_err(|e| format!("bd task failed: {e}"))?
}

/// Add or remove a label on a bead: `bd label add|remove "$2" "$3"`. `action` is validated to be
/// exactly "add" or "remove"; id and label are positional args, never interpolated.
/// Sync core of [`bead_label`]; a plain fn so the async command offloads it via `spawn_blocking`
/// and the tests can drive the action/id validation guards directly.
fn bead_label_inner(
    project_path: String,
    action: String,
    id: String,
    label: String,
) -> Result<String, String> {
    if action != "add" && action != "remove" {
        return Err(format!("invalid label action: {action} (expected \"add\" or \"remove\")"));
    }
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    let output = run_bd(&project_path, &["label", &action, &id, &label])?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_action(output.status.success(), &stdout, &stderr)
}

#[tauri::command]
pub async fn bead_label(
    project_path: String,
    action: String,
    id: String,
    label: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bead_label_inner(project_path, action, id, label))
        .await
        .map_err(|e| format!("bd task failed: {e}"))?
}

/// A bead id is safe to pass as a positional operand only if it can't be mistaken for a flag. Even
/// though it's already an argv arg (not shell-interpolated), an id beginning with `-` would be parsed
/// by `bd` as an OPTION, not an issue id. Restrict to bd's id charset and forbid a leading dash.
fn valid_bead_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Permanently delete a bead via `bd delete <id> --force` — used by the close-agent Discard path.
/// Destructive and irreversible; the caller MUST gate it behind an explicit user confirmation. `id`
/// is validated (can't be flag-like) and passed as a real argv token, never interpolated.
/// Sync core of [`delete_bead`]; a plain fn so the async command offloads it via `spawn_blocking`
/// and the tests can drive the id-validation guard directly.
fn delete_bead_inner(project_path: String, id: String) -> Result<String, String> {
    if !valid_bead_id(&id) {
        return Err(format!("invalid bead id: {id}"));
    }
    let output = run_bd(&project_path, &["delete", &id, "--force"])?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_action(output.status.success(), &stdout, &stderr)
}

#[tauri::command]
pub async fn delete_bead(project_path: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || delete_bead_inner(project_path, id))
        .await
        .map_err(|e| format!("bd task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_bead_id_forbids_flag_like_and_exotic_ids() {
        assert!(valid_bead_id(""));
        assert!(valid_bead_id("bd-1.2_x"));
        assert!(!valid_bead_id("")); // empty
        assert!(!valid_bead_id("-s")); // would be parsed by bd as a flag
        assert!(!valid_bead_id("--force"));
        assert!(!valid_bead_id("a b")); // space
        assert!(!valid_bead_id("a;b")); // metachar
        // The id-taking commands reject a flag-like id before shelling out.
        assert!(bead_claim_inner("/tmp".into(), "-s".into()).is_err());
        assert!(delete_bead_inner("/tmp".into(), "--force".into()).is_err());
    }

    #[test]
    fn append_note_creates_and_appends() {
        let dir = std::env::temp_dir().join(format!("sparkle_notes_{}", std::process::id()));
        // Start clean: a prior aborted run could leave a stale NOTES.md that breaks the count.
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        // A real project root is a git repo; `validate_project_root` requires a `.git` entry.
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let p = dir.to_string_lossy().to_string();

        append_note(p.clone(), "first".into(), "2026-06-24T00:00:00Z".into()).unwrap();
        append_note(p.clone(), "second".into(), "2026-06-24T00:01:00Z".into()).unwrap();

        let body = std::fs::read_to_string(Path::new(&p).join("NOTES.md")).unwrap();
        assert!(body.contains("## 2026-06-24T00:00:00Z"));
        assert!(body.contains("first"));
        assert!(body.contains("second"));
        // Two appends → two heading markers.
        assert_eq!(body.matches("## ").count(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn select_bd_result_prefers_json_stdout_even_on_nonzero_exit() {
        // bd exited non-zero but emitted its caught-error JSON on stdout AND a warning on stderr:
        // the JSON must win so the frontend can surface the structured `error` message.
        let r = select_bd_result(
            false,
            r#"{"error":"database not initialized"}"#,
            "warning: deprecated flag",
        );
        assert_eq!(r, Ok(r#"{"error":"database not initialized"}"#.to_string()));
    }

    #[test]
    fn select_bd_result_returns_json_on_success() {
        let r = select_bd_result(true, r#"{"id":"tt-4qs"}"#, "");
        assert_eq!(r, Ok(r#"{"id":"tt-4qs"}"#.to_string()));
    }

    #[test]
    fn select_bd_result_surfaces_stderr_when_stdout_is_not_json() {
        // Shell failure (missing `bd`, bad cd): non-JSON stdout, real stderr -> Err(stderr).
        let r = select_bd_result(false, "", "zsh: command not found: bd");
        assert_eq!(r, Err("zsh: command not found: bd".to_string()));
    }

    #[test]
    fn select_bd_result_errors_when_no_output() {
        assert_eq!(select_bd_result(true, "", ""), Err("bd produced no output".to_string()));
        assert_eq!(select_bd_result(false, "", ""), Err("bd produced no output".to_string()));
    }

    #[test]
    fn select_bd_raw_passes_through_json_array_on_success() {
        // `bd list --json` emits a JSON array (starts with '['), not '{' — it must pass through
        // verbatim rather than being treated as an error.
        let r = select_bd_raw(true, r#"[{"id":"sparkle-x"}]"#, "");
        assert_eq!(r, Ok(r#"[{"id":"sparkle-x"}]"#.to_string()));
    }

    #[test]
    fn select_bd_raw_surfaces_failure_and_empty() {
        assert_eq!(
            select_bd_raw(false, "", "zsh: command not found: bd"),
            Err("zsh: command not found: bd".to_string())
        );
        assert_eq!(select_bd_raw(true, "", ""), Err("bd produced no output".to_string()));
        // A caught bd error on failure (JSON on stdout) is passed through, not errored.
        assert_eq!(
            select_bd_raw(false, r#"{"error":"no such issue"}"#, ""),
            Ok(r#"{"error":"no such issue"}"#.to_string())
        );
    }

    #[test]
    fn select_bd_action_reports_ok_on_silent_success() {
        assert_eq!(select_bd_action(true, "", ""), Ok("ok".to_string()));
        assert_eq!(select_bd_action(true, "added dep", ""), Ok("added dep".to_string()));
        assert_eq!(
            select_bd_action(false, "", "no such issue"),
            Err("no such issue".to_string())
        );
    }

    #[test]
    fn write_prd_rejects_unsafe_filenames() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_reject_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();

        for bad in ["../escape.md", "sub/dir.md", "a\\b.md", "..", "/etc/passwd", ""] {
            let r = write_prd(p.clone(), bad.to_string(), "x".into());
            assert!(r.is_err(), "expected rejection for {bad:?}, got {r:?}");
        }
        // None of the rejected writes should have created a PRD dir/file outside intent.
        assert!(!dir.join("PRD").join("escape.md").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_prd_writes_and_returns_relative_path() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_write_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap(); // a real project root is a git repo
        let p = dir.to_string_lossy().to_string();

        let rel = write_prd(p.clone(), "branch.md".into(), "# hello\n".into()).unwrap();
        assert_eq!(rel, "PRD/branch.md");
        let written = std::fs::read_to_string(Path::new(&p).join("PRD").join("branch.md")).unwrap();
        assert_eq!(written, "# hello\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_prd_rejects_unsafe_filenames() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_read_reject_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("PRD")).unwrap();
        std::fs::write(dir.join("secret.txt"), "top secret").unwrap();
        let p = dir.to_string_lossy().to_string();

        // `C:secret.txt` is drive-relative on Windows: no separator, not absolute, yet
        // Path::join would replace the whole base path there. Reject it everywhere.
        for bad in ["../secret.txt", "sub/dir.md", "a\\b.md", "..", "/etc/passwd", "", "C:secret.txt"] {
            let r = read_prd(p.clone(), bad.to_string());
            let w = write_prd(p.clone(), bad.to_string(), "x".into());
            assert!(r.is_err(), "expected read rejection for {bad:?}, got {r:?}");
            assert!(w.is_err(), "expected write rejection for {bad:?}, got {w:?}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_prd_round_trips_a_written_prd() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_read_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap(); // a real project root is a git repo
        let p = dir.to_string_lossy().to_string();

        write_prd(p.clone(), "branch.md".into(), "# hello\n".into()).unwrap();
        assert_eq!(read_prd(p.clone(), "branch.md".into()).unwrap(), "# hello\n");
        // A missing file is an Err, not a panic.
        assert!(read_prd(p.clone(), "nope.md".into()).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn build_create_bead_args_minimal_uses_defaults() {
        // Empty type defaults to "task"; no optional flags appended. The project path is NOT in
        // the argv (run_bd sets cwd via .current_dir), and every value is a distinct argv token.
        let args = build_create_bead_args("My Title", "body text", "", "", "", "");
        assert_eq!(
            args,
            vec!["create", "My Title", "-d", "body text", "-t", "task", "--json"]
        );
    }

    #[test]
    fn build_create_bead_args_all_fields_are_distinct_argv_tokens() {
        let args = build_create_bead_args(
            "Title",
            "Body",
            "bug",
            "sparkle-parent",
            "blocks:sparkle-x,sparkle-y",
            "ui,backend",
        );
        // Flags appended in order (parent, deps, labels); values are their own tokens, never inlined.
        assert_eq!(
            args,
            vec![
                "create",
                "Title",
                "-d",
                "Body",
                "-t",
                "bug",
                "--parent",
                "sparkle-parent",
                "--deps",
                "blocks:sparkle-x,sparkle-y",
                "-l",
                "ui,backend",
                "--json",
            ]
        );
    }

    #[test]
    fn build_create_bead_args_skips_omitted_optionals() {
        // Only labels provided: parent/deps flags are absent, `-l docs` still appended.
        let args = build_create_bead_args("T", "B", "task", "", "", "docs");
        assert_eq!(
            args,
            vec!["create", "T", "-d", "B", "-t", "task", "-l", "docs", "--json"]
        );
    }

    #[test]
    fn build_create_bead_args_never_inlines_hostile_values() {
        // A shell-injection payload as the title stays a single argv token (no shell parses it),
        // so it can never break out — the direct-exec equivalent of the old positional-arg scheme.
        let args = build_create_bead_args("'; rm -rf / #", "b", "", "", "", "");
        assert_eq!(args[0], "create");
        assert_eq!(args[1], "'; rm -rf / #");
        assert!(args.contains(&"--json".to_string()));
    }

    #[test]
    fn bead_label_rejects_invalid_action() {
        let r = bead_label_inner("/proj".into(), "delete".into(), "sparkle-x".into(), "ui".into());
        assert!(r.is_err());
    }

    #[test]
    fn ensure_ignore_rule_appends_when_missing() {
        assert_eq!(ensure_ignore_rule(""), Some("PRD/assets/\n".into()));
        assert_eq!(
            ensure_ignore_rule("node_modules/\n.sparkle/\n"),
            Some("node_modules/\n.sparkle/\nPRD/assets/\n".into())
        );
        // Existing content missing its trailing newline gets one before the rule.
        assert_eq!(
            ensure_ignore_rule("node_modules/"),
            Some("node_modules/\nPRD/assets/\n".into())
        );
    }

    #[test]
    fn ensure_ignore_rule_is_idempotent() {
        assert_eq!(ensure_ignore_rule("PRD/assets/\n"), None);
        assert_eq!(ensure_ignore_rule("  PRD/assets/  \n"), None); // trimmed match
        assert_eq!(ensure_ignore_rule("PRD/assets\n"), None); // slashless variant counts
    }

    #[test]
    fn copy_capture_asset_rejects_traversal_and_copies_plus_ignores() {
        let dir = std::env::temp_dir().join(format!("sparkle_capasset_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap(); // a real project root is a git repo
        let proj = dir.to_string_lossy().to_string();
        let src = dir.join("shot.png");
        std::fs::write(&src, b"png-bytes").unwrap();
        let src_s = src.to_string_lossy().to_string();

        assert!(copy_capture_asset(proj.clone(), src_s.clone(), "../evil.png".into()).is_err());
        assert!(copy_capture_asset(proj.clone(), src_s.clone(), "a/b.png".into()).is_err());

        let rel = copy_capture_asset(proj.clone(), src_s, "t-capture.png".into()).unwrap();
        assert_eq!(rel, "PRD/assets/t-capture.png");
        assert_eq!(
            std::fs::read(dir.join("PRD/assets/t-capture.png")).unwrap(),
            b"png-bytes"
        );
        let ignore = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l.trim() == "PRD/assets/"));

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- SECURITY: project_path is constrained to a real project root -------------------------

    #[test]
    fn validate_project_root_accepts_a_git_repo_dir() {
        let dir = std::env::temp_dir().join(format!("sparkle_root_ok_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let real = validate_project_root(&dir.to_string_lossy()).unwrap();
        // Returns the CANONICAL root (symlinks/.. resolved) so callers join a real path.
        assert_eq!(real, std::fs::canonicalize(&dir).unwrap());
        // A `.git` FILE (linked worktree) counts too, not just a dir.
        let wt = std::env::temp_dir().join(format!("sparkle_root_wt_{}", std::process::id()));
        std::fs::remove_dir_all(&wt).ok();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: /somewhere/else\n").unwrap();
        assert!(validate_project_root(&wt.to_string_lossy()).is_ok());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&wt).ok();
    }

    #[test]
    fn validate_project_root_rejects_non_git_and_bad_paths() {
        // A real dir that is NOT a git repo (the ~/.ssh / ~/Library / /etc class the vuln let the
        // webview write into) must be rejected.
        let dir = std::env::temp_dir().join(format!("sparkle_root_bad_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        assert!(validate_project_root(&dir.to_string_lossy()).is_err());
        // Empty, relative, and non-existent paths are all rejected before any fs write.
        assert!(validate_project_root("").is_err());
        assert!(validate_project_root("relative/path").is_err());
        assert!(validate_project_root("/no/such/sparkle/dir/xyz").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_note_and_prd_reject_a_non_project_dir() {
        // End-to-end: the three fs-writing commands must refuse a directory that isn't a repo,
        // even with a perfectly valid basename — the crux of the security fix.
        let dir = std::env::temp_dir().join(format!("sparkle_np_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap(); // NOT a git repo
        let p = dir.to_string_lossy().to_string();
        assert!(append_note(p.clone(), "x".into(), "2026-01-01T00:00:00Z".into()).is_err());
        assert!(write_prd(p.clone(), "branch.md".into(), "x".into()).is_err());
        assert!(read_prd(p.clone(), "branch.md".into()).is_err());
        // Nothing was written into the non-project dir.
        assert!(!dir.join("NOTES.md").exists());
        assert!(!dir.join("PRD").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- PERF: bd path resolution + augmented PATH -------------------------------------------

    #[test]
    fn known_bd_paths_prioritizes_user_then_brew() {
        let paths = known_bd_paths_for(Some(PathBuf::from("/Users/x")));
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert_eq!(strs[0], "/Users/x/.local/bin/bd"); // user-local first
        assert!(strs.contains(&"/Users/x/go/bin/bd".to_string()));
        assert!(strs.contains(&"/Users/x/.cargo/bin/bd".to_string()));
        assert!(strs.contains(&"/opt/homebrew/bin/bd".to_string()));
        assert!(strs.contains(&"/usr/local/bin/bd".to_string()));
    }

    #[test]
    fn known_bd_paths_handles_no_home() {
        let paths = known_bd_paths_for(None);
        // No home → no ~/.local or ~/go entry, but the system locations are still present.
        assert!(paths.iter().any(|p| p.ends_with("opt/homebrew/bin/bd")));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains(".local")));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains("go/bin")));
    }

    #[test]
    fn cached_bd_path_is_stable_across_calls() {
        // The whole perf win is resolving bd ONCE; two calls must agree (whether or not bd is
        // installed on this machine — both None and Some(path) must be consistent).
        assert_eq!(cached_bd_path(), cached_bd_path());
    }

    #[test]
    fn bd_exec_path_includes_git_and_system_dirs() {
        // bd shells out to git, so its exec PATH must carry a plausible git dir + the system bins.
        let path = bd_exec_path();
        assert!(!path.is_empty());
        let segs: Vec<&str> = path.split(':').collect();
        assert!(segs.contains(&"/usr/bin"));
        assert!(segs.contains(&"/bin"));
        // Whatever git the resolver found, its directory is on the PATH we hand bd.
        if let Some(git) = crate::preflight::resolve_git_path_cached() {
            if let Some(dir) = Path::new(&git).parent() {
                assert!(
                    segs.contains(&dir.to_string_lossy().as_ref()),
                    "expected git dir {dir:?} on bd PATH; got {path}"
                );
            }
        }
        // Cached: a second call returns the identical string.
        assert_eq!(bd_exec_path(), path);
    }
}

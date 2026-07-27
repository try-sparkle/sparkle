//! 1Password `.env` backup / restore backend (bead `sparkle-a0wg`).
//!
//! `.env` / `.env.*` are gitignored, so a freshly cut agent worktree never carries one and every
//! worker agent starts life without the secrets its project needs. This module backs those files up
//! to a 1Password vault as Document items and restores them into new worktrees.
//!
//! ## The contract
//!
//! Every command here implements `apps/desktop/src/services/onepassword.ts` — the FROZEN IPC
//! contract. The TS types are camelCase, so every struct that crosses the boundary carries
//! `#[serde(rename_all = "camelCase")]`. Don't change shapes here without changing that file.
//!
//! ## SECURITY INVARIANTS
//!
//! * **Secret CONTENTS never cross this boundary.** `op` reads and writes the real file on disk
//!   itself — we only ever hand it PATHS (`op document create <path>` /
//!   `op document get --out-file <path>`). No plaintext lands in a temp file, an event payload, or
//!   the PTY transcript.
//!   The one place bytes touch this process is [`sha256_of_file`], which must read the file to hash
//!   it. It streams through a small buffer, keeps nothing, and returns only a digest.
//! * **Never log a file's contents, and never log an absolute path at info level.** The repo has a
//!   standing privacy precedent for this ("log dropped-file kinds, never their absolute paths"), and
//!   here the paths themselves name the user's projects. Logs carry counts and outcomes only.
//! * A restore that would clobber a *differing* on-disk file requires an explicit `overwrite`. That
//!   is the single irreversible action in the whole feature.
//!
//! ## FLAG UNCERTAINTY — read before "fixing" a command
//!
//! The real `op` CLI is not installed on the machine this was written on, and its desktop-app
//! integration needs an interactive Touch ID prompt no unattended process can satisfy. Every `op`
//! invocation below is therefore built from the *documented* v2 surface and verified only against a
//! fake `op` in the tests. To make a correction cheap, EVERY command line is constructed by one
//! small `*_argv` function ([`vault_list_argv`], [`item_list_argv`], [`item_get_argv`],
//! [`document_upload_argv`], [`sha_field_argv`], [`document_get_argv`]) and nothing else builds
//! argv. If a flag turns out to be wrong, fix it in exactly one place.
//!
//! The known-shaky one is the `op document get` output flag: the docs spell it `--out-file` (with an
//! `-o` short form) while the contract's comments say `--output`. [`download_document`] tries them
//! in order and retries on an "unknown flag" error, so either spelling works.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Tag every Sparkle-written Document item carries. The sole basis for "is this ours?".
const SPARKLE_TAG: &str = "";

/// Custom text field on each item holding the SHA-256 of the bytes as backed up. Comparing it to
/// the on-disk hash is what surfaces drift — and what lets [`restore_one`] decide whether an
/// existing file differs WITHOUT downloading anything.
const SHA_FIELD: &str = "sparkle_sha256";

/// Wall-clock ceiling for a normal `op` call. `op_seed_worktree` runs on the worktree-creation path
/// (i.e. agent spawn), so a hanging or slow `op` must never wedge it — every invocation is bounded.
const OP_TIMEOUT: Duration = Duration::from_secs(20);

/// Shorter ceiling for the readiness probe: it runs on UI paint, and "op is wedged" should read as
/// "not ready", fast.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// `brew install --cask` downloads a package; it needs far longer than an `op` call.
const BREW_TIMEOUT: Duration = Duration::from_secs(600);

/// How deep [`env_scan`] recurses below a project root. A monorepo keeps its env files within a
/// couple of levels (`apps/web/.env.local`); going deeper mostly buys `node_modules`-shaped cost.
const MAX_SCAN_DEPTH: usize = 4;

/// Directories never worth descending into when hunting for env files.
const SKIP_DIRS: [&str; 4] = ["node_modules", ".git", "target", "dist"];

/// Dot-segments that mark a committed TEMPLATE rather than a real secret file: `.env.example`,
/// `.env.sample`, `.env.template`, and compounds like `.env.example.local`. These are checked into
/// git, carry no secrets, and backing them up would be noise.
/// Segments that mark a file as a committed TEMPLATE rather than a real secret. Matched against any
/// dot-segment, so `.env.example.local` is excluded too.
const TEMPLATE_SEGMENTS: [&str; 6] =
    ["example", "sample", "template", "dist", "defaults", "schema"];

/// Segments that mark a STALE COPY — an editor backup or a hand-made snapshot. Excluded for a
/// different reason than templates: these do hold real secrets, but they are throwaway duplicates,
/// and every one backed up becomes a vault item that then seeds into every future worktree.
/// `sparkle-restore` is our own in-flight download temp (see [`restore_temp_path`]) — its suffix
/// naming keeps it under the user's `.env*` gitignore rules, and this entry keeps it out of scans.
const STALE_COPY_SEGMENTS: [&str; 6] = ["bak", "backup", "orig", "swp", "save", "sparkle-restore"];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Contract types (mirror apps/desktop/src/services/onepassword.ts)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// How far along the user is toward a working `op`. Serializes to the contract's kebab-case union
/// (`"cli-missing" | "integration-off" | "ready"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpReadiness {
    /// No `op` binary anywhere we look — offer `brew install --cask 1password-cli`.
    CliMissing,
    /// `op` runs but reports no authenticated account — the desktop-app integration toggle is off.
    IntegrationOff,
    /// `op` runs and is authenticated. Backup/restore are available.
    Ready,
}

/// Result of probing the `op` CLI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpStatus {
    pub readiness: OpReadiness,
    pub path: Option<String>,
    pub version: Option<String>,
    pub account_url: Option<String>,
    /// Present when the probe failed for a reason the user can act on; redacted for display.
    pub error: Option<String>,
}

impl OpStatus {
    fn cli_missing(error: Option<String>) -> Self {
        OpStatus {
            readiness: OpReadiness::CliMissing,
            path: None,
            version: None,
            account_url: None,
            error,
        }
    }
}

/// A vault the signed-in account can write to.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpVault {
    pub id: String,
    pub name: String,
}

/// A project root to scan, projected from the frontend's project store so Rust needs no store
/// access.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRoot {
    pub project_id: String,
    pub project_name: String,
    pub root_path: String,
}

/// An env file found on disk. Carries a hash, never contents.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvFile {
    pub project_id: String,
    pub project_name: String,
    pub rel_path: String,
    pub abs_path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub modified_at: String,
}

/// A Document item in the vault that Sparkle wrote.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpBackupRecord {
    pub item_id: String,
    pub title: String,
    pub sha256: String,
    pub updated_at: String,
}

/// Arguments for [`op_backup`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpBackupArgs {
    pub vault_id: String,
    pub abs_path: String,
    pub title: String,
    pub sha256: String,
    /// Existing item to update in place. Omit to create.
    #[serde(default)]
    pub item_id: Option<String>,
}

/// Arguments for [`op_restore`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpRestoreArgs {
    pub item_id: String,
    pub abs_path: String,
    pub overwrite: bool,
}

/// Minimal item summary from `op item list` — everything `op_seed_worktree` needs, WITHOUT the
/// per-item `op item get` round trip that reading `sparkle_sha256` costs.
#[derive(Debug, Clone, PartialEq)]
struct OpItemSummary {
    id: String,
    title: String,
    updated_at: String,
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `op` program resolution — the injectable seam
//
// Mirrors `preflight::gh_program`: a Finder/Dock-launched macOS app does NOT inherit the shell PATH
// Homebrew installs into, so a bare `Command::new("op")` misses a perfectly good `op`. We resolve
// through the LOGIN shell, then fall back to the canonical absolute install locations, and cache the
// hit for the app session.
//
// Unlike gh_program, this one is OVERRIDABLE. The real `op` cannot be installed on a build machine
// (its desktop-app integration needs an interactive Touch ID prompt), so every test drives a FAKE
// `op` script instead. Every worker function below takes the program path as a parameter for exactly
// that reason; the override static exists so an integration harness can point the *commands* at a
// fake too.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Canonical absolute `op` locations, user-first. Pure form takes the home dir explicitly so it can
/// be unit-tested without mutating the process-global `HOME`.
pub fn known_op_paths_for(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/op")); // manual tarball install
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/op")); // homebrew (Apple silicon)
    paths.push(PathBuf::from("/usr/local/bin/op")); // homebrew (Intel)
    paths
}

fn op_path_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn op_program_override() -> &'static Mutex<Option<String>> {
    static OVERRIDE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    OVERRIDE.get_or_init(|| Mutex::new(None))
}

/// Point every `op` invocation at `path` (or clear the override with `None`). The test/harness seam
/// — see the module note. Not wired to any command; nothing in the shipping app calls it.
#[allow(dead_code)] // the seam exists for tests/harnesses; the shipping app never overrides.
pub fn set_op_program_override(path: Option<String>) {
    if let Ok(mut g) = op_program_override().lock() {
        *g = path;
    }
}

/// Resolve the absolute `op` path WITHOUT caching. Unix form: login-shell PATH probe, then the
/// canonical absolute install locations.
#[cfg(unix)]
fn resolve_op_uncached() -> Option<String> {
    crate::preflight::run_in_login_shell("command -v op")
        .filter(|p| Path::new(p).is_absolute())
        .or_else(|| {
            crate::preflight::first_executable(&known_op_paths_for(
                std::env::var_os("HOME").map(PathBuf::from),
            ))
        })
}

/// Windows form: `where op` (GUI apps inherit PATH), then the canonical install locations.
#[cfg(not(unix))]
fn resolve_op_uncached() -> Option<String> {
    crate::preflight::resolve_on_path("op").or_else(|| {
        crate::preflight::first_executable(&known_op_paths_for(crate::preflight::home_dir()))
    })
}

/// Resolved absolute `op` path: the override if one is set, else the session cache, else a fresh
/// resolve. Only a positive hit is cached, so installing `op` while the app runs is picked up on the
/// next probe without a restart.
pub fn cached_op_path() -> Option<String> {
    if let Ok(g) = op_program_override().lock() {
        if let Some(p) = g.as_ref() {
            return Some(p.clone());
        }
    }
    if let Ok(g) = op_path_cache().lock() {
        if let Some(p) = g.as_ref() {
            return Some(p.clone());
        }
    }
    let resolved = resolve_op_uncached();
    if let Some(p) = resolved.as_ref() {
        if let Ok(mut g) = op_path_cache().lock() {
            *g = Some(p.clone());
        }
    }
    resolved
}

/// Drop the cached `op` path so the next resolve re-probes (after an install, or a toolchain move).
pub fn invalidate_op_path_cache() {
    if let Ok(mut g) = op_path_cache().lock() {
        *g = None;
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Running `op`
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Replace the user's home directory with `~` in a message headed for the UI or a log. Not a full
/// redaction — its job is to keep `/Users/<real name>/…` out of anything we display or persist.
fn redact_home(s: &str) -> String {
    match std::env::var("HOME") {
        Ok(h) if h.len() > 1 => s.replace(&h, "~"),
        _ => s.to_string(),
    }
}

/// First non-empty line of `op`'s complaint, home-redacted — what the UI shows. `op` is chatty on
/// failure and the tail is rarely actionable.
///
/// SECURITY: `stdout` is only ever consulted when the caller passes `allow_stdout`. For the
/// document commands stdout is where the document's PLAINTEXT goes, so a non-zero exit with a
/// quiet stderr would otherwise put a line of the user's secret into a string that crosses the IPC
/// boundary and gets rendered. The module's stated invariant is that secret contents never cross
/// that boundary, and a fallback that reads stdout is precisely how such an invariant erodes.
fn sanitize_op_error(stderr: &str, stdout: &str, allow_stdout: bool) -> String {
    let pick = |s: &str| -> Option<String> {
        s.lines().map(|l| l.trim()).find(|l| !l.is_empty()).map(|l| l.to_string())
    };
    let msg = pick(stderr)
        .or_else(|| if allow_stdout { pick(stdout) } else { None })
        .unwrap_or_else(|| "no output".to_string());
    redact_home(&msg)
}

/// Whether a command's stdout is safe to quote in an error message. `op document get` streams the
/// document itself to stdout when no output file is used, and `op document create`/`edit` can echo
/// item JSON; everything else here prints diagnostics. Default-deny: an unrecognized subcommand is
/// treated as unsafe.
fn stdout_is_safe_to_quote(args: &[String]) -> bool {
    !matches!(args.first().map(String::as_str), Some("document") | None)
}

/// Run `op` with `args`, bounded by `timeout`. Returns trimmed stdout on success.
///
/// Never logs the argv: `op document create` carries an absolute path, and `op item edit` carries a
/// field assignment. Both are exactly what must not reach a log line.
fn run_op(op: &str, args: &[String], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new(op);
    cmd.args(args);
    // `op` must never try to interact: stdin is already /dev/null under output_with_timeout, and
    // these keep it from reaching for a TTY-based prompt or a pager.
    cmd.env("NO_COLOR", "1");
    cmd.env("OP_ISO_TIMESTAMPS", "1");
    let out = crate::worktree::output_with_timeout(cmd, timeout)
        .map_err(|e| format!("`op {}` {}", args.first().map(String::as_str).unwrap_or(""), e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(sanitize_op_error(
            &String::from_utf8_lossy(&out.stderr),
            &String::from_utf8_lossy(&out.stdout),
            stdout_is_safe_to_quote(args),
        ))
    }
}

/// `&str` convenience over [`run_op`].
fn run_op_str(op: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    run_op(op, &owned, timeout)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Command construction — the single place any `op` argv is built (see the module note on flags)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// `op vault list --format=json`
fn vault_list_argv() -> Vec<String> {
    vec!["vault".into(), "list".into(), "--format=json".into()]
}

/// `op item list --vault <id> --tags  --format=json`
fn item_list_argv(vault_id: &str) -> Vec<String> {
    vec![
        "item".into(),
        "list".into(),
        "--vault".into(),
        vault_id.into(),
        "--tags".into(),
        SPARKLE_TAG.into(),
        "--format=json".into(),
    ]
}

/// `op item get <item> [--vault <id>] --format=json` — the only call that returns an item's fields,
/// and so the only way to read `sparkle_sha256` back.
fn item_get_argv(item_id: &str, vault_id: Option<&str>) -> Vec<String> {
    let mut v: Vec<String> = vec!["item".into(), "get".into(), item_id.into()];
    if let Some(vault) = vault_id {
        v.push("--vault".into());
        v.push(vault.into());
    }
    v.push("--format=json".into());
    v
}

/// The upload command for one backup.
///
/// * No `itemId` → `op document create <absPath> --title <title> --vault <id> --tags `
/// * With one   → `op document edit <itemId> <absPath> --vault <id>`
///
/// The create/edit split is load-bearing, not an optimization: **editing preserves 1Password's own
/// item history**, so every prior version of the file stays recoverable inside 1Password. Never
/// "replace" a backup by deleting and re-creating it — that throws the user's rollback path away.
fn document_upload_argv(args: &OpBackupArgs) -> Vec<String> {
    match args.item_id.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(item_id) => vec![
            "document".into(),
            "edit".into(),
            item_id.into(),
            args.abs_path.clone(),
            "--vault".into(),
            args.vault_id.clone(),
            "--format=json".into(),
        ],
        None => vec![
            "document".into(),
            "create".into(),
            args.abs_path.clone(),
            "--title".into(),
            args.title.clone(),
            "--vault".into(),
            args.vault_id.clone(),
            "--tags".into(),
            SPARKLE_TAG.into(),
            "--format=json".into(),
        ],
    }
}

/// `op item edit <item> --vault <id> sparkle_sha256[text]=<hash> --format=json` — records the hash
/// of the bytes just uploaded, using v2's `field[type]=value` assignment syntax.
fn sha_field_argv(item_id: &str, vault_id: &str, sha256: &str) -> Vec<String> {
    vec![
        "item".into(),
        "edit".into(),
        item_id.into(),
        "--vault".into(),
        vault_id.into(),
        format!("{SHA_FIELD}[text]={sha256}"),
        "--format=json".into(),
    ]
}

/// The output flag for `op document get`, in preference order. The v2 docs spell it `--out-file`;
/// the IPC contract's comments say `--output`. Neither could be executed here, so
/// [`download_document`] tries them in order.
const DOC_GET_OUT_FLAGS: [&str; 2] = ["--out-file", "--output"];

/// `op document get <item> <out-flag> <absPath>`
fn document_get_argv(item_id: &str, dest: &str, out_flag: &str) -> Vec<String> {
    vec!["document".into(), "get".into(), item_id.into(), out_flag.into(), dest.into()]
}

/// True when `op` rejected a flag we spelled wrong (rather than failing for a real reason). Drives
/// the `--out-file` / `--output` retry.
fn looks_like_unknown_flag(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("unknown flag")
        || e.contains("unknown shorthand")
        || e.contains("flag provided but not defined")
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// JSON helpers — deliberately lenient
//
// `op` v2's JSON is not uniform: `item list` emits snake_case (`updated_at`) while `document create`
// emits the legacy camelCase shape (`uuid`, `updatedAt`). Since none of it could be executed here,
// every read accepts the plausible spellings rather than binding a struct to one guess.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// First present key of `keys` read as a non-empty string.
fn json_str(v: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Normalize `op`'s "list" output to a slice of objects: a JSON array as-is, a bare object as a
/// one-element list, anything else empty.
fn json_rows(v: &serde_json::Value) -> Vec<serde_json::Value> {
    match v {
        serde_json::Value::Array(a) => a.clone(),
        serde_json::Value::Object(_) => vec![v.clone()],
        _ => Vec::new(),
    }
}

fn parse_vaults(stdout: &str) -> Result<Vec<OpVault>, String> {
    let v: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|e| format!("couldn't read the vault list from 1Password: {e}"))?;
    Ok(json_rows(&v)
        .iter()
        .filter_map(|row| {
            let id = json_str(row, &["id", "uuid"])?;
            let name = json_str(row, &["name", "title"]).unwrap_or_else(|| id.clone());
            Some(OpVault { id, name })
        })
        .collect())
}

fn parse_items(stdout: &str) -> Result<Vec<OpItemSummary>, String> {
    let v: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|e| format!("couldn't read the item list from 1Password: {e}"))?;
    Ok(json_rows(&v)
        .iter()
        .filter_map(|row| {
            let id = json_str(row, &["id", "uuid"])?;
            let title = json_str(row, &["title", "name"])?;
            let updated_at = json_str(row, &["updated_at", "updatedAt"]).unwrap_or_default();
            Some(OpItemSummary { id, title, updated_at })
        })
        .collect())
}

/// Pull the `sparkle_sha256` custom field out of an `op item get --format=json` payload.
fn parse_sha_field(stdout: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(stdout).ok()?;
    let fields = v.get("fields")?.as_array()?;
    fields.iter().find_map(|f| {
        let matches = ["label", "id"]
            .iter()
            .any(|k| f.get(*k).and_then(|x| x.as_str()).map(|s| s == SHA_FIELD).unwrap_or(false));
        if matches {
            json_str(f, &["value"])
        } else {
            None
        }
    })
}

/// Sign-in address of the first account `op` reports (`op account list` / `op whoami`).
fn parse_account_url(stdout: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(stdout).ok()?;
    json_rows(&v).iter().find_map(|row| json_str(row, &["url", "domain", "shorthand", "email"]))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Readiness probe
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Probe an already-resolved `op` binary. Three-state by construction:
/// `--version` fails → `cli-missing` (a broken install is indistinguishable from none, and the
/// remedy is the same); no account from `account list` *or* `whoami` → `integration-off`; otherwise
/// `ready`.
fn probe_op(op: &str) -> OpStatus {
    let version = match run_op_str(op, &["--version"], PROBE_TIMEOUT) {
        Ok(v) if !v.is_empty() => v,
        Ok(_) => return OpStatus::cli_missing(Some("`op --version` printed nothing".into())),
        Err(e) => {
            return OpStatus::cli_missing(Some(format!("the 1Password CLI wouldn't run: {e}")))
        }
    };

    // `op account list` is the authoritative "is there an account?" question; `whoami` is the
    // fallback for a setup where the account is provided by the desktop app / a service token and
    // doesn't show up in the account list.
    let account_url = run_op_str(op, &["account", "list", "--format=json"], PROBE_TIMEOUT)
        .ok()
        .and_then(|out| parse_account_url(&out))
        .or_else(|| {
            run_op_str(op, &["whoami", "--format=json"], PROBE_TIMEOUT)
                .ok()
                .and_then(|out| parse_account_url(&out))
        });

    match account_url {
        Some(url) => OpStatus {
            readiness: OpReadiness::Ready,
            path: Some(op.to_string()),
            version: Some(version),
            account_url: Some(url),
            error: None,
        },
        None => OpStatus {
            readiness: OpReadiness::IntegrationOff,
            path: Some(op.to_string()),
            version: Some(version),
            account_url: None,
            error: Some(
                "The 1Password CLI is installed but no account is signed in. In the 1Password app, \
                 turn on Settings → Developer → “Integrate with 1Password CLI”, then refresh."
                    .into(),
            ),
        },
    }
}

/// Resolve `op` and probe it. `cli-missing` when nothing resolves.
fn op_status_now() -> OpStatus {
    match cached_op_path() {
        Some(p) => probe_op(&p),
        None => OpStatus::cli_missing(None),
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Homebrew (for op_install)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Message shown when Homebrew is absent — the UI pairs it with a link to 1Password's own installer
/// so the button is never a dead end.
const NO_BREW: &str = "Homebrew isn't installed, so Sparkle can't install the 1Password CLI for \
                       you. Install it from 1Password's downloads page (or install Homebrew first) \
                       and then refresh.";

#[cfg(unix)]
fn resolve_brew_path() -> Option<String> {
    crate::preflight::run_in_login_shell("command -v brew")
        .filter(|p| Path::new(p).is_absolute())
        .or_else(|| {
            crate::preflight::first_executable(&[
                PathBuf::from("/opt/homebrew/bin/brew"),
                PathBuf::from("/usr/local/bin/brew"),
            ])
        })
}

#[cfg(not(unix))]
fn resolve_brew_path() -> Option<String> {
    crate::preflight::resolve_on_path("brew")
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Hashing / time
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Lowercase-hex SHA-256 of a file's bytes.
///
/// The ONE place secret bytes enter this process (a hash can't be computed otherwise). It streams
/// through an 8 KiB buffer, never holds the file, never logs, and returns only a digest.
pub fn sha256_of_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("couldn't read {}: {e}", display_name(path)))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("couldn't read {}: {e}", display_name(path)))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// File name only — what an error message may safely carry. Never the absolute path.
fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into())
}

/// Howard Hinnant's `civil_from_days`: exact integer calendar arithmetic, no leap-year tables and no
/// date crate (the tree has none). Inverse of `accounts::days_from_civil`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Unix epoch seconds → `YYYY-MM-DDTHH:MM:SSZ` (UTC), the ISO 8601 form the contract asks for.
fn epoch_to_iso8601(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn system_time_to_iso8601(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    epoch_to_iso8601(secs)
}

fn now_iso8601() -> String {
    system_time_to_iso8601(SystemTime::now())
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// env_scan
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// True for a file name Sparkle should back up: an `.env`-family file that is NOT a committed
/// template. `.env`, `.env.local`, `.env.production` are in; `.env.example`, `.env.sample`,
/// `.env.example.local` are out.
fn is_backupable_env_name(name: &str) -> bool {
    // Exactly `.env` or a dotted member of the family. A bare `starts_with(".env")` also swallows
    // `.envrc` (direnv — a shell script, not a dotenv) and `.environment`, each of which would
    // become a vault item that later seeds into every worktree.
    if name != ".env" && !name.starts_with(".env.") {
        return false;
    }
    // An editor's trailing-tilde backup (`.env.local~`) is a stale copy by a different convention.
    if name.ends_with('~') {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    // `.env.example` splits to ["", "env", "example"]; a marker in ANY segment disqualifies it,
    // which also catches compounds like `.env.example.local` and `.env.local.bak`.
    !lower
        .split('.')
        .any(|seg| TEMPLATE_SEGMENTS.contains(&seg) || STALE_COPY_SEGMENTS.contains(&seg))
}

/// Collect `.env*` files under `dir`, bounded to [`MAX_SCAN_DEPTH`] levels and skipping
/// [`SKIP_DIRS`]. Symlinked directories are not followed (a cycle would hang the scan).
fn collect_env_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // unreadable dir (permissions, a race) is simply not scanned
    };
    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if ft.is_dir() {
            if depth + 1 > MAX_SCAN_DEPTH || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect_env_files(&entry.path(), depth + 1, out);
        } else if is_backupable_env_name(&name) {
            let p = entry.path();
            // Follows a symlink deliberately: a `.env -> ../shared/.env` is a real, common setup.
            if std::fs::metadata(&p).map(|m| m.is_file()).unwrap_or(false) {
                out.push(p);
            }
        }
    }
}

/// Scan one project root into [`EnvFile`] rows. A file that can't be hashed is skipped rather than
/// failing the whole scan.
fn scan_one_root(root: &ScanRoot) -> Vec<EnvFile> {
    let base = Path::new(&root.root_path);
    let mut paths = Vec::new();
    collect_env_files(base, 0, &mut paths);
    paths.sort();
    let mut out = Vec::new();
    for p in paths {
        let meta = match std::fs::metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let sha256 = match sha256_of_file(&p) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let rel = p
            .strip_prefix(base)
            .map(|r| r.to_string_lossy().into_owned())
            .unwrap_or_else(|_| display_name(&p));
        out.push(EnvFile {
            project_id: root.project_id.clone(),
            project_name: root.project_name.clone(),
            rel_path: rel,
            abs_path: p.to_string_lossy().into_owned(),
            size_bytes: meta.len(),
            sha256,
            modified_at: meta.modified().map(system_time_to_iso8601).unwrap_or_default(),
        });
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Vault / item operations
// ─────────────────────────────────────────────────────────────────────────────────────────────

fn list_vaults(op: &str) -> Result<Vec<OpVault>, String> {
    parse_vaults(&run_op(op, &vault_list_argv(), OP_TIMEOUT)?)
}

fn list_backup_items(op: &str, vault_id: &str) -> Result<Vec<OpItemSummary>, String> {
    parse_items(&run_op(op, &item_list_argv(vault_id), OP_TIMEOUT)?)
}

fn item_sha256(op: &str, item_id: &str, vault_id: Option<&str>) -> Result<Option<String>, String> {
    Ok(parse_sha_field(&run_op(op, &item_get_argv(item_id, vault_id), OP_TIMEOUT)?))
}

/// Back one file up, then record its hash on the item. See [`document_upload_argv`] for why the
/// create/edit split matters.
fn backup_one(op: &str, args: &OpBackupArgs) -> Result<OpBackupRecord, String> {
    let upload = run_op(op, &document_upload_argv(args), OP_TIMEOUT)?;
    let upload_json: serde_json::Value =
        serde_json::from_str(&upload).unwrap_or(serde_json::Value::Null);

    let item_id = args
        .item_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| json_str(&upload_json, &["id", "uuid"]))
        .ok_or_else(|| "1Password didn't return an item id for the uploaded document".to_string())?;

    // Record the hash of the bytes just uploaded. This is what drift detection reads back, and what
    // lets a restore tell "same file" from "different file" without downloading anything.
    //
    // These are two non-atomic `op` calls, and the failure between them matters: the document is
    // already in the vault. Returning Err here would throw away the item id the caller needs, so
    // the NEXT backup would still pass itemId: undefined and CREATE A SECOND ITEM — silently
    // duplicating the user's secret in their vault, once per retry. So a failed field edit still
    // returns the record, with an empty sha256 to mark the hash as unrecorded. The drift engine
    // reads an empty hash as "drifted" (never as in-sync), so the row stays visibly unfinished and
    // the next attempt edits this item in place instead of spawning another.
    let edited = run_op(op, &sha_field_argv(&item_id, &args.vault_id, &args.sha256), OP_TIMEOUT);
    let sha_recorded = edited.is_ok();
    if !sha_recorded {
        tracing::warn!(
            "onepassword: document stored but its checksum field could not be written; the next \
             backup will update this item in place"
        );
    }
    let edited_json: serde_json::Value = edited
        .ok()
        .and_then(|e| serde_json::from_str(&e).ok())
        .unwrap_or(serde_json::Value::Null);

    let updated_at = json_str(&edited_json, &["updated_at", "updatedAt"])
        .or_else(|| json_str(&upload_json, &["updated_at", "updatedAt"]))
        .unwrap_or_else(now_iso8601);

    Ok(OpBackupRecord {
        item_id,
        title: args.title.clone(),
        sha256: if sha_recorded { args.sha256.clone() } else { String::new() },
        updated_at,
    })
}

/// `op document get` straight to `dest`, retrying the alternate output flag when the first spelling
/// is rejected (see [`DOC_GET_OUT_FLAGS`]). `op` writes the file itself — the bytes never enter this
/// process.
fn download_document(op: &str, item_id: &str, dest: &Path) -> Result<(), String> {
    let dest_s = dest.to_string_lossy().into_owned();
    let mut last: Option<String> = None;
    // Was `dest` empty when we were called? The existence gate below only means "THIS attempt's
    // `op` wrote a file" if each attempt starts from nothing, so on a retry we clear the previous
    // attempt's debris — but only debris we can prove is ours. If something was already here at
    // entry it belongs to the CALLER (concretely: the seed path treats a dangling symlink as
    // absent, and `remove_file` would delete the user's LINK), so we never touch it.
    let starts_empty = std::fs::symlink_metadata(dest).is_err();
    for (attempt, flag) in DOC_GET_OUT_FLAGS.into_iter().enumerate() {
        // BETWEEN attempts only — never before the first, which is the caller's to guarantee.
        if attempt > 0 && starts_empty {
            match std::fs::remove_file(dest) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!(
                        "couldn't clear {} before retrying the download: {e}",
                        display_name(dest)
                    ));
                }
            }
        }
        match run_op(op, &document_get_argv(item_id, &dest_s, flag), OP_TIMEOUT) {
            Ok(_) => {
                // A zero exit is NOT proof the document landed. If `op` treats the output flag as a
                // positional (a live possibility while the flag spelling is unconfirmed), the
                // document goes to stdout and exits 0 with nothing written — and we would report a
                // successful restore for a file that does not exist. Every caller ensures the
                // destination is absent before this call, so EXISTENCE is the discriminator: a file
                // being there now can only mean `op` wrote it — the clear above keeps that true on
                // a retry, so attempt 1's partial output can't be read as attempt 2's success.
                // Size must not be the discriminator — a legitimately empty `.env` (a `touch`ed
                // placeholder) is backed up at 0 bytes and has to restore.
                // On an absent destination, fall through to the next flag spelling.
                if dest.metadata().is_ok() {
                    set_owner_only_permissions(dest);
                    return Ok(());
                }
                last = Some(format!(
                    "`op document get` reported success but wrote nothing to {}",
                    display_name(dest)
                ));
            }
            Err(e) => {
                if !looks_like_unknown_flag(&e) {
                    return Err(e);
                }
                last = Some(e);
            }
        }
    }
    Err(last.unwrap_or_else(|| "`op document get` failed".to_string()))
}

/// The in-flight download temp for a restore to `dest`: a SIBLING named
/// `<file>.sparkle-restore` (`.env.local` → `.env.local.sparkle-restore`). The suffix form is
/// load-bearing twice over:
/// * the real file's name stays a PREFIX of the temp's, so any gitignore rule that covers the
///   real file (`.env*`, or the literal name) covers the temp too — a mid-download crash must
///   never leave a plaintext secret at a path `git add -A` would stage;
/// * `sparkle-restore` sits in [`STALE_COPY_SEGMENTS`], so [`is_backupable_env_name`] rejects it
///   and a leftover temp is never itself backed up and seeded into future worktrees.
fn restore_temp_path(dest: &Path) -> Option<PathBuf> {
    let mut tmp_name = dest.file_name()?.to_os_string();
    tmp_name.push(".sparkle-restore");
    Some(dest.with_file_name(tmp_name))
}

/// Download to a sibling temp file and rename over `dest` only once the bytes are actually there.
///
/// The naive form — delete `dest`, then download — destroys the user's file whenever the download
/// then fails (network, revoked item, timeout, a re-auth prompt, an unconfirmed flag spelling).
/// Those are the exact bytes this whole module exists to protect, and "the item was reachable a
/// moment ago" does not prove the download will succeed.
///
/// The temp file is a sibling (same directory, so the rename is atomic and never crosses a
/// filesystem — see [`restore_temp_path`] for why its name matters). `op` creates it itself with
/// its own 0600 `--file-mode` default, and we re-assert 0600 as soon as the download lands — we
/// can't chmod a file `op` hasn't created yet, so there is a window where the mode is `op`'s
/// default rather than our assertion. That does not weaken the no-plaintext-temp invariant: the
/// secret is about to live at `dest` in plaintext anyway, and this keeps it inside the same
/// directory rather than a world-readable temp dir. On any failure the temp is removed and the
/// original is left exactly as it was.
fn download_document_atomically(op: &str, item_id: &str, dest: &Path) -> Result<(), String> {
    let Some(tmp) = restore_temp_path(dest) else {
        return Err(format!("{} is not a file path", display_name(dest)));
    };

    // A leftover temp from a previous crash must not be mistaken for a fresh download, and if it
    // can't be cleared we must REFUSE rather than download "over" it: [`download_document`] gates
    // success on the temp existing, so stale bytes still sitting there would pass that gate and be
    // renamed over the user's file as a "successful" restore. Anything but NotFound is fatal.
    // This is also the sole owner of the pre-attempt-1 clear that gate depends on.
    match std::fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            // Name the TEMP — its NAME, not a path (the module's privacy rule) — and say where it
            // lives, so the user knows what to remove to unblock every future restore of this file.
            return Err(format!(
                "a leftover restore temp ({}) sits next to the file being restored and couldn't be \
                 removed: {e} — delete it, then restore again",
                display_name(&tmp)
            ));
        }
    }

    if let Err(e) = download_document(op, item_id, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("couldn't put the restored file in place at {}: {e}", display_name(dest))
    })?;
    set_owner_only_permissions(dest);
    Ok(())
}

/// Restrict a restored secret to its owner (`0600`). `op --file-mode` defaults to 0600 already, but
/// the contract promises it, so we assert it rather than trusting a default we couldn't verify.
#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

/// Windows has no POSIX mode bits; NTFS inheritance governs access. No-op.
#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) {}

/// Where the restored bytes for `dest` should land. A plain path is itself; a symlink resolves to
/// the file it points at — via `canonicalize` when the link is live, and by hand (`read_link`
/// joined to the link's parent) when it dangles — so a restore recreates the linked-to file
/// instead of quietly replacing the user's link with a regular file. A dangling chain
/// (link → link → nothing) has no single safe answer, so it is refused rather than guessed at.
fn restore_write_target(dest: &Path) -> Result<PathBuf, String> {
    let is_symlink = std::fs::symlink_metadata(dest)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !is_symlink {
        return Ok(dest.to_path_buf());
    }
    if let Ok(resolved) = std::fs::canonicalize(dest) {
        return Ok(resolved);
    }
    // canonicalize refuses a dangling link; resolve one level ourselves.
    let raw = std::fs::read_link(dest).map_err(|e| {
        format!("{} is a symlink that couldn't be read: {e}", display_name(dest))
    })?;
    let resolved = if raw.is_absolute() {
        raw
    } else {
        match dest.parent() {
            Some(parent) => parent.join(raw),
            None => raw,
        }
    };
    if std::fs::symlink_metadata(&resolved).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err(format!(
            "{} is a dangling chain of symlinks, so there is no safe place to restore to — fix \
             or remove the link, then restore again",
            display_name(dest)
        ));
    }
    Ok(resolved)
}

/// Restore one document to `absPath`.
///
/// The overwrite guard is the whole point of this function. When something is already at the
/// destination — a regular file OR a symlink, live or dangling ([`std::fs::symlink_metadata`]
/// rather than `exists()`, which follows links and would read a broken link as "nothing here") —
/// we compare the on-disk SHA-256 against the item's recorded `sparkle_sha256`:
/// * equal → nothing to do, return Ok WITHOUT touching the file;
/// * different and `overwrite == false` → Err, and the file is not touched;
/// * different and `overwrite == true` → proceed.
///
/// Comparing hashes rather than downloading-then-diffing is deliberate: it answers "do these differ?"
/// without ever materializing the vault copy, so no plaintext temp file is created. An item with no
/// recorded hash reads as "differs" — the conservative direction — and so does a dangling symlink,
/// which has no bytes to hash at all.
fn restore_one(op: &str, args: &OpRestoreArgs) -> Result<(), String> {
    let dest = PathBuf::from(&args.abs_path);
    if let Ok(meta) = std::fs::symlink_metadata(&dest) {
        // Only a genuinely DANGLING link is excused from hashing — it has no bytes, so it can never
        // prove itself identical to the vault copy and takes the conservative "differs" branch.
        // Dangling means the target is MISSING (NotFound) specifically, not merely unreachable: a
        // LIVE link behind an unreadable parent (EACCES), or a symlink loop (ELOOP), must stay a
        // hard error rather than be told its "target is missing" and then hand-resolved into a
        // second, more confusing failure downstream.
        let dangling = meta.file_type().is_symlink()
            && matches!(std::fs::metadata(&dest), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
        let on_disk = match sha256_of_file(&dest) {
            Ok(h) => Some(h),
            Err(_) if dangling => None,
            Err(e) => return Err(e),
        };
        if let Some(on_disk) = on_disk {
            let in_vault = item_sha256(op, &args.item_id, None)?;
            if in_vault.as_deref() == Some(on_disk.as_str()) {
                return Ok(()); // byte-identical — a no-op either way
            }
        }
        if !args.overwrite {
            // A dangling link gets its OWN message: "differs from the backup / discard those local
            // changes" describes a file that isn't there. It locates where the bytes would land,
            // but only when that can be done without emitting an absolute path (the module-wide
            // privacy rule — these strings cross the IPC boundary and may be logged): a RELATIVE
            // target is quoted verbatim, since it is what the user wrote and carries no machine
            // specifics; an absolute one is reduced to a flat locator rather than leaked.
            return Err(if dangling {
                let points_at = match std::fs::read_link(&dest) {
                    Ok(t) if t.is_relative() => format!(" ({})", t.to_string_lossy()),
                    Ok(_) => " (an absolute path)".to_string(),
                    Err(_) => String::new(),
                };
                format!(
                    "{} already exists on disk as a symlink whose target{points_at} is missing. \
                     Restoring will recreate the file the link points at — confirm the overwrite \
                     to continue.",
                    display_name(&dest)
                )
            } else {
                format!(
                    "{} already exists on disk and differs from the backup. Restoring would \
                     discard those local changes — confirm the overwrite to continue.",
                    display_name(&dest)
                )
            });
        }
        // Overwrite was granted — but the existing file is NOT removed here. It stays untouched
        // until a complete replacement exists next to it; see download_document_atomically.
    }
    // Write through a symlink rather than replacing it: env_scan deliberately follows symlinked
    // `.env` files, so a `.env -> ../shared/.env` setup is a supported arrangement, and renaming
    // over the link would silently detach it from the shared source it points at.
    let target = restore_write_target(&dest)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("couldn't create the destination folder: {e}"))?;
    }
    download_document_atomically(op, &args.item_id, &target)
}

/// A title's relative part, validated against path traversal. Returns None unless every component is
/// an ordinary name — no `..`, no absolute path, no root, no drive prefix.
///
/// A 1Password item title is data a *vault* supplies, and `op_seed_worktree` turns it into a write
/// path. Without this, a title like `sparkle/../../../../.ssh/authorized_keys` would write outside
/// the worktree.
fn safe_relative_path(rel: &str) -> Option<PathBuf> {
    use std::path::Component;
    let rel = rel.trim();
    if rel.is_empty() {
        return None;
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    let mut any = false;
    for c in p.components() {
        match c {
            Component::Normal(part) => {
                if part.to_string_lossy().contains('\0') {
                    return None;
                }
                out.push(part);
                any = true;
            }
            // ParentDir escapes; RootDir/Prefix are absolute; CurDir is a no-op we'd rather reject
            // than silently normalize, since a title should never contain one.
            _ => return None,
        }
    }
    if any {
        Some(out)
    } else {
        None
    }
}

/// Resolve one symlink hop without requiring the target to exist.
///
/// `canonicalize` is the right answer whenever it works, but it fails through a DANGLING link — and
/// a dangling link is exactly the case that matters here, because a repo can track one and it costs
/// an attacker nothing. Falling back to `read_link` joined against the link's own parent gives us
/// the path the link points at, which is what containment has to be judged against.
fn resolve_link_target(link: &Path) -> Option<PathBuf> {
    if let Ok(real) = link.canonicalize() {
        return Some(real);
    }
    let target = std::fs::read_link(link).ok()?;
    Some(if target.is_absolute() {
        target
    } else {
        link.parent()?.join(target)
    })
}

/// How many symlink hops [`is_contained`] will follow before refusing.
const MAX_LINK_HOPS: usize = 16;

/// Whether `dest` really lands under `root_real` (an ALREADY canonicalized root), following any
/// symlinked directories on the way. The deepest existing ancestor is what gets resolved: `dest`
/// itself doesn't exist yet, and neither may some of its parents, so canonicalizing the full path
/// would just fail and tell us nothing.
///
/// A SYMLINK IS JUDGED BY ITS TARGET, wherever it sits on the path — leaf included. See the body for
/// why the leaf needs saying out loud: the pop-walk alone reads a dangling `.env ->
/// ../../../../.ssh/authorized_keys` as contained, and `op` then writes the secret through it.
fn is_contained(root_real: &Path, dest: &Path) -> bool {
    // PRECONDITION: `dest` is `dest_root` joined with a `safe_relative_path`, so it carries no `..`
    // component. The walk below uses `PathBuf::pop`, which treats `..` as an ordinary component —
    // a `dest` containing one could pop back onto a symlink and be judged by a target the write
    // never lands on. Every production caller satisfies this; the assert catches a test or a future
    // caller that doesn't.
    debug_assert!(
        !dest.components().any(|c| c == std::path::Component::ParentDir),
        "is_contained requires a `..`-free dest (see safe_relative_path): {dest:?}"
    );

    // ONE walk, one budget. A symlink anywhere on the path — leaf or ancestor — is judged by what it
    // POINTS AT, and a chain that cannot be resolved at all is refused rather than walked past.
    //
    // The leaf used to get its own loop ahead of this one, because the ancestor walk ALONE is
    // defeated by a dangling symlink at `dest`: `canonicalize` fails through it (ENOENT on the
    // target), the walk pops to the parent, finds that legitimately inside the worktree, and returns
    // true — after which `op` opens the path `O_CREAT|O_WRONLY`, follows the link, and writes the
    // plaintext secret wherever it points. (`dest.exists()` doesn't catch it either: that follows
    // the link too, and a dangling link does not "exist". A repo shipping
    // `.env -> ../../../../.ssh/authorized_keys` is all it takes, with no race involved.)
    //
    // That hazard is real, but the `Err` arm below already answers it: `probe` starts AT `dest`, so
    // a symlinked leaf is resolved and judged by its target before anything pops. The separate loop
    // was only load-bearing while it rejoined a suffix — behaviour that was wrong for the one shape
    // that reached it. Without that, it was a second copy of this arm with a second 16-hop budget.
    let mut probe = dest.to_path_buf();
    let mut ancestor_hops = 0;
    loop {
        match probe.canonicalize() {
            Ok(real) => {
                // The deepest existing ancestor resolved. Anything created below it stays below it,
                // so containment of that ancestor implies containment of `dest`.
                return real.starts_with(root_real);
            }
            Err(_) => {
                // A dangling link — at the leaf on the first pass, or among the ancestors after a
                // pop — is judged by its target rather than skipped over. The popped suffix is
                // deliberately
                // dropped: containment of an ancestor implies containment of everything below it,
                // and `safe_relative_path` has already guaranteed the suffix carries no `..`, so it
                // cannot climb back out of the target.
                let is_link = std::fs::symlink_metadata(&probe)
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false);
                if is_link {
                    ancestor_hops += 1;
                    if ancestor_hops > MAX_LINK_HOPS {
                        return false;
                    }
                    match resolve_link_target(&probe) {
                        Some(t) => {
                            probe = t;
                            continue;
                        }
                        None => return false,
                    }
                }
                if !probe.pop() {
                    return false; // walked past the filesystem root without resolving anything
                }
            }
        }
    }
}

/// What a seed run actually did. The counters are not decoration: `rejected` means a vault-supplied
/// title tried to escape the worktree — the number you'd read to decide whether a vault is hostile —
/// so a benign mid-run teardown must NOT land in it. Keeping them in the return type (rather than
/// only in a tracing line) is what lets a test tell those two cases apart.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct SeedOutcome {
    pub written: Vec<String>,
    pub rejected: usize,
    pub failed: usize,
    /// The worktree vanished mid-run and the loop stopped. Distinct from `rejected`.
    pub torn_down: bool,
}

/// [`seed_worktree_outcome`] with the counters dropped — the shape callers on the spawn path want.
fn seed_worktree(
    op: &str,
    vault_id: &str,
    project_name: &str,
    dest_root: &str,
) -> Result<Vec<String>, String> {
    seed_worktree_outcome(op, vault_id, project_name, dest_root).map(|o| o.written)
}

/// Restore every `` document titled `<projectName>/<relPath>` into `dest_root`.
///
/// NEVER overwrites: a file already present is left exactly as it is and omitted from the result.
/// This runs on the worktree-creation path (agent spawn), so every `op` call is bounded by
/// [`OP_TIMEOUT`] and a single failed document is skipped rather than failing the whole seed — a
/// missing `.env` is a worse outcome than a partially seeded worktree, but a blocked spawn is worse
/// than both.
fn seed_worktree_outcome(
    op: &str,
    vault_id: &str,
    project_name: &str,
    dest_root: &str,
) -> Result<SeedOutcome, String> {
    let root = PathBuf::from(dest_root);
    if !root.is_dir() {
        return Err("the destination worktree folder doesn't exist".to_string());
    }
    // Resolve the root ONCE so every destination can be proven to land inside it even when an
    // intermediate directory is a symlink (see `is_contained`).
    let root_real = root
        .canonicalize()
        .map_err(|_| "the destination worktree folder couldn't be resolved".to_string())?;
    let prefix = format!("{}/", project_name.trim_end_matches('/'));
    let items = list_backup_items(op, vault_id)?;

    let mut written = Vec::new();
    let mut skipped_unsafe = 0usize;
    let mut failed = 0usize;
    let mut torn_down = false;
    for item in items {
        let Some(rest) = item.title.strip_prefix(&prefix) else { continue };
        let Some(rel) = safe_relative_path(rest) else {
            skipped_unsafe += 1;
            continue;
        };
        let dest = root.join(&rel);
        // TEARDOWN CHECK FIRST — it must come BEFORE containment, not after. A worktree can be torn
        // down WHILE this loop runs (an agent closed moments after opening). Checked second, the
        // containment probe walks up past the deleted root to its parent, finds that outside
        // `root_real`, and takes the `skipped_unsafe` branch — so the break below was unreachable,
        // a benign teardown was counted as a REJECTED path (conflating it with a hostile
        // vault-supplied title in the one counter you'd read to decide whether a vault is attacking
        // you), and the test for the break passed via the wrong branch. It is also the cheaper test.
        if !root.is_dir() {
            torn_down = true;
            break;
        }
        // `safe_relative_path` rejects `..`, but a symlink can still redirect the write: a repo
        // that tracks `apps -> /etc` turns `proj/apps/x.env` into a write at `/etc/x.env`, and a
        // DANGLING leaf link (`.env -> ../../../.ssh/authorized_keys`) slips past both
        // `create_dir_all` and `exists()`. Prove containment against the resolved root instead of
        // trusting the joined path.
        if !is_contained(&root_real, &dest) {
            skipped_unsafe += 1;
            continue;
        }
        // `exists()` follows symlinks, so a dangling link is not "already present" — which is why
        // containment above has to judge the link's TARGET rather than relying on this.
        //
        // Note the deliberate asymmetry with `collect_env_files` and `restore_one`, which both
        // support a `.env -> ../shared/.env` layout: on THIS path an out-of-tree link is refused,
        // because the relative path came from a vault item title (data) rather than from a user
        // pointing at a file they chose. Don't "fix" the inconsistency without that distinction.
        if dest.exists() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                failed += 1;
                continue;
            }
        }
        match download_document(op, &item.id, &dest) {
            Ok(()) => written.push(rel.to_string_lossy().into_owned()),
            Err(_) => failed += 1,
        }
    }
    // Counts only — never a path, never a title (a title names a user's project and file).
    tracing::info!(
        written = written.len(),
        rejected = skipped_unsafe,
        failed,
        "seeded env files into a new worktree"
    );
    Ok(SeedOutcome { written, rejected: skipped_unsafe, failed, torn_down })
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Probe the `op` CLI (see [`probe_op`]). Off the main thread: resolution shells out to a login
/// shell, which is slow on a cold machine.
#[tauri::command]
pub async fn op_preflight() -> OpStatus {
    tauri::async_runtime::spawn_blocking(op_status_now)
        .await
        .unwrap_or_else(|_| OpStatus::cli_missing(Some("the 1Password probe didn't finish".into())))
}

/// Drop the cached `op` path and re-probe — after an install, or after the user flips the
/// desktop-app integration toggle.
#[tauri::command]
pub async fn op_refresh() -> OpStatus {
    tauri::async_runtime::spawn_blocking(|| {
        invalidate_op_path_cache();
        op_status_now()
    })
    .await
    .unwrap_or_else(|_| OpStatus::cli_missing(Some("the 1Password probe didn't finish".into())))
}

/// `brew install --cask 1password-cli`, then re-probe. A missing Homebrew returns [`NO_BREW`] — a
/// displayable message the pane can pair with a link to 1Password's own installer — rather than a
/// generic failure that leaves the user with a dead button.
#[tauri::command]
pub async fn op_install() -> Result<OpStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let brew = resolve_brew_path().ok_or_else(|| NO_BREW.to_string())?;
        let mut cmd = Command::new(&brew);
        cmd.args(["install", "--cask", "1password-cli"]);
        cmd.env("HOMEBREW_NO_AUTO_UPDATE", "1");
        cmd.env("HOMEBREW_NO_ANALYTICS", "1");
        cmd.env("NONINTERACTIVE", "1");
        let out = crate::worktree::output_with_timeout(cmd, BREW_TIMEOUT)
            .map_err(|e| format!("Homebrew {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "Homebrew couldn't install the 1Password CLI: {}",
                // Homebrew's stdout is install chatter, never document contents.
                sanitize_op_error(
                    &String::from_utf8_lossy(&out.stderr),
                    &String::from_utf8_lossy(&out.stdout),
                    true
                )
            ));
        }
        invalidate_op_path_cache();
        Ok(op_status_now())
    })
    .await
    .map_err(|_| "the 1Password CLI install didn't finish".to_string())?
}

/// List the account's vaults, for the one-time vault picker.
#[tauri::command]
pub async fn op_vaults() -> Result<Vec<OpVault>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let op = cached_op_path().ok_or_else(|| "the 1Password CLI isn't installed".to_string())?;
        list_vaults(&op)
    })
    .await
    .map_err(|_| "listing 1Password vaults didn't finish".to_string())?
}

/// Find every backup-worthy `.env*` file under the given project roots. Returns hashes, never
/// contents.
#[tauri::command]
pub async fn env_scan(roots: Vec<ScanRoot>) -> Result<Vec<EnvFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let files: Vec<EnvFile> = roots.iter().flat_map(scan_one_root).collect();
        // Counts only: the paths themselves name the user's projects.
        tracing::info!(roots = roots.len(), found = files.len(), "scanned for env files");
        files
    })
    .await
    .map_err(|_| "the env scan didn't finish".to_string())
}

/// List the Document items Sparkle has written to this vault, each paired with the hash recorded on
/// it. The per-item `op item get` is unavoidable — `op item list` doesn't return fields.
#[tauri::command]
pub async fn op_list_backups(vault_id: String) -> Result<Vec<OpBackupRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let op = cached_op_path().ok_or_else(|| "the 1Password CLI isn't installed".to_string())?;
        let items = list_backup_items(&op, &vault_id)?;
        Ok(items
            .into_iter()
            .map(|item| {
                let sha256 =
                    item_sha256(&op, &item.id, Some(&vault_id)).ok().flatten().unwrap_or_default();
                OpBackupRecord {
                    item_id: item.id,
                    title: item.title,
                    sha256,
                    updated_at: item.updated_at,
                }
            })
            .collect())
    })
    .await
    .map_err(|_| "listing 1Password backups didn't finish".to_string())?
}

/// Back a single env file up to the vault as a Document item tagged ``.
#[tauri::command]
pub async fn op_backup(args: OpBackupArgs) -> Result<OpBackupRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let op = cached_op_path().ok_or_else(|| "the 1Password CLI isn't installed".to_string())?;
        let record = backup_one(&op, &args)?;
        // Neither the path nor the title is logged — both name the user's project and file.
        tracing::info!(updated_existing = args.item_id.is_some(), "backed up an env file");
        Ok(record)
    })
    .await
    .map_err(|_| "the backup didn't finish".to_string())?
}

/// Restore one backed-up env file to disk, `0600`, refusing to clobber a differing file unless
/// `overwrite` is set.
#[tauri::command]
pub async fn op_restore(args: OpRestoreArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let op = cached_op_path().ok_or_else(|| "the 1Password CLI isn't installed".to_string())?;
        restore_one(&op, &args)
    })
    .await
    .map_err(|_| "the restore didn't finish".to_string())?
}

/// Seed a freshly cut worktree with the project's backed-up env files. Never overwrites.
#[tauri::command]
pub async fn op_seed_worktree(
    vault_id: String,
    project_name: String,
    dest_root: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let op = cached_op_path().ok_or_else(|| "the 1Password CLI isn't installed".to_string())?;
        seed_worktree(&op, &vault_id, &project_name, &dest_root)
    })
    .await
    .map_err(|_| "seeding the worktree didn't finish".to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
//
// SCOPE, stated plainly: these drive a FAKE `op` — a shell script in a tempdir that logs its argv
// and echoes canned JSON. They prove ARGUMENT CONSTRUCTION and OUTPUT PARSING, plus every local
// filesystem rule (the overwrite refusal, the scan exclusions, the traversal guard). They CANNOT
// prove the real CLI's flag spellings or its JSON shapes — the real `op` is not installable here
// (its desktop-app integration requires an interactive Touch ID prompt). One manual pass on a
// machine with `op` set up is still required before trusting the flags.
// ─────────────────────────────────────────────────────────────────────────────────────────────

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Write an executable fake `op` into `dir` whose body is `body` (POSIX sh). The script appends
    /// each argument, one per line, to `<dir>/argv.log` followed by a `--` separator, so a test can
    /// assert on the exact argv the production code built.
    fn fake_op(dir: &Path, body: &str) -> String {
        let log = dir.join("argv.log");
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\nprintf -- '--\\n' >> '{}'\n{body}\n",
            log.display(),
            log.display()
        );
        let bin = dir.join("op");
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin.to_string_lossy().into_owned()
    }

    /// The argv of each fake-`op` invocation, in order.
    fn argv_calls(dir: &Path) -> Vec<Vec<String>> {
        let raw = std::fs::read_to_string(dir.join("argv.log")).unwrap_or_default();
        let mut calls = Vec::new();
        let mut cur = Vec::new();
        for line in raw.lines() {
            if line == "--" {
                calls.push(std::mem::take(&mut cur));
            } else {
                cur.push(line.to_string());
            }
        }
        calls
    }

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    // ── readiness: the three states ──────────────────────────────────────────────────────────

    #[test]
    fn readiness_is_ready_when_an_account_is_signed_in() {
        let d = tmp();
        let op = fake_op(
            d.path(),
            r#"
case "$1" in
  --version) echo "2.30.0" ;;
  account) echo '[{"url":"my.1password.com","email":"a@b.c","user_uuid":"U1"}]' ;;
  *) exit 1 ;;
esac
"#,
        );
        let st = probe_op(&op);
        assert_eq!(st.readiness, OpReadiness::Ready);
        assert_eq!(st.version.as_deref(), Some("2.30.0"));
        assert_eq!(st.account_url.as_deref(), Some("my.1password.com"));
        assert_eq!(st.error, None);
        assert_eq!(st.path.as_deref(), Some(op.as_str()));
    }

    #[test]
    fn readiness_is_integration_off_when_no_account_is_reported() {
        // `op` runs, but the desktop-app integration toggle is off: an empty account list AND a
        // failing whoami. This must NOT read as cli-missing — the remedy is completely different.
        let d = tmp();
        let op = fake_op(
            d.path(),
            r#"
case "$1" in
  --version) echo "2.30.0" ;;
  account) echo '[]' ;;
  whoami) echo "no account found" >&2; exit 1 ;;
  *) exit 1 ;;
esac
"#,
        );
        let st = probe_op(&op);
        assert_eq!(st.readiness, OpReadiness::IntegrationOff);
        assert_eq!(st.version.as_deref(), Some("2.30.0"));
        assert_eq!(st.account_url, None);
        assert!(st.error.unwrap().contains("Integrate with 1Password CLI"));
    }

    #[test]
    fn readiness_falls_back_to_whoami_when_account_list_is_empty() {
        // A service-token / desktop-app setup can report nothing from `account list` yet still be
        // authenticated. whoami is the tiebreaker, and it must win.
        let d = tmp();
        let op = fake_op(
            d.path(),
            r#"
case "$1" in
  --version) echo "2.30.0" ;;
  account) echo '[]' ;;
  whoami) echo '{"url":"team.1password.com","user_type":"HUMAN"}' ;;
  *) exit 1 ;;
esac
"#,
        );
        let st = probe_op(&op);
        assert_eq!(st.readiness, OpReadiness::Ready);
        assert_eq!(st.account_url.as_deref(), Some("team.1password.com"));
    }

    #[test]
    fn readiness_is_cli_missing_when_the_binary_does_not_run() {
        let st = probe_op("/definitely/not/here/op");
        assert_eq!(st.readiness, OpReadiness::CliMissing);
        assert!(st.error.is_some());
        assert_eq!(st.version, None);
    }

    #[test]
    fn readiness_is_cli_missing_when_nothing_resolves() {
        // The no-path branch of op_status_now, without touching the process-global cache.
        let st = OpStatus::cli_missing(None);
        assert_eq!(st.readiness, OpReadiness::CliMissing);
        assert_eq!(st.path, None);
    }

    // ── vault list ───────────────────────────────────────────────────────────────────────────

    #[test]
    fn vault_list_parses_json_and_uses_the_documented_argv() {
        let d = tmp();
        let op = fake_op(
            d.path(),
            r#"echo '[{"id":"v1","name":"Private","content_version":3},{"id":"v2","name":"Shared"}]'"#,
        );
        let vaults = list_vaults(&op).unwrap();
        assert_eq!(
            vaults,
            vec![
                OpVault { id: "v1".into(), name: "Private".into() },
                OpVault { id: "v2".into(), name: "Shared".into() },
            ]
        );
        assert_eq!(argv_calls(d.path())[0], vec!["vault", "list", "--format=json"]);
    }

    #[test]
    fn vault_list_surfaces_a_failure_message_instead_of_an_empty_list() {
        let d = tmp();
        let op = fake_op(d.path(), r#"echo "could not connect to 1Password" >&2; exit 1"#);
        let err = list_vaults(&op).unwrap_err();
        assert!(err.contains("could not connect"), "got {err}");
    }

    // ── backup: create vs edit ───────────────────────────────────────────────────────────────

    #[test]
    fn backup_without_item_id_creates_a_tagged_document() {
        let d = tmp();
        let op = fake_op(
            d.path(),
            r#"
if [ "$1" = "document" ]; then
  echo '{"uuid":"ITEM1","createdAt":"2026-07-24T00:00:00Z","updatedAt":"2026-07-24T00:00:00Z"}'
else
  echo '{"id":"ITEM1","updated_at":"2026-07-24T00:00:05Z"}'
fi
"#,
        );
        let args = OpBackupArgs {
            vault_id: "V1".into(),
            abs_path: "/p/.env.local".into(),
            title: "sparkle/.env.local".into(),
            sha256: "abc123".into(),
            item_id: None,
        };
        let rec = backup_one(&op, &args).unwrap();
        assert_eq!(rec.item_id, "ITEM1");
        assert_eq!(rec.title, "sparkle/.env.local");
        assert_eq!(rec.sha256, "abc123");
        assert_eq!(rec.updated_at, "2026-07-24T00:00:05Z");

        let calls = argv_calls(d.path());
        assert_eq!(
            calls[0],
            vec![
                "document",
                "create",
                "/p/.env.local",
                "--title",
                "sparkle/.env.local",
                "--vault",
                "V1",
                "--tags",
                "",
                "--format=json",
            ]
        );
        // The hash is recorded on the freshly created item, using the id the create returned.
        assert_eq!(
            calls[1],
            vec![
                "item",
                "edit",
                "ITEM1",
                "--vault",
                "V1",
                "sparkle_sha256[text]=abc123",
                "--format=json",
            ]
        );
    }

    #[test]
    fn backup_with_item_id_edits_in_place_and_never_recreates() {
        // Editing is what preserves 1Password's item history — the user's rollback path. A
        // delete-then-create would throw it away, so assert no `document create` is ever issued.
        let d = tmp();
        let op = fake_op(d.path(), r#"echo '{"id":"ITEM9","updated_at":"2026-07-24T01:00:00Z"}'"#);
        let args = OpBackupArgs {
            vault_id: "V1".into(),
            abs_path: "/p/.env".into(),
            title: "sparkle/.env".into(),
            sha256: "deadbeef".into(),
            item_id: Some("ITEM9".into()),
        };
        let rec = backup_one(&op, &args).unwrap();
        assert_eq!(rec.item_id, "ITEM9");

        let calls = argv_calls(d.path());
        assert_eq!(
            calls[0],
            vec!["document", "edit", "ITEM9", "/p/.env", "--vault", "V1", "--format=json"]
        );
        assert!(
            !calls.iter().any(|c| c.first().map(|s| s == "document").unwrap_or(false)
                && c.get(1).map(|s| s == "create").unwrap_or(false)),
            "a re-backup must never create a new item: {calls:?}"
        );
        assert!(!calls.iter().any(|c| c.get(1).map(|s| s == "delete").unwrap_or(false)));
    }

    #[test]
    fn backup_treats_a_blank_item_id_as_a_create() {
        let args = OpBackupArgs {
            vault_id: "V".into(),
            abs_path: "/p/.env".into(),
            title: "t".into(),
            sha256: "s".into(),
            item_id: Some("   ".into()),
        };
        assert_eq!(document_upload_argv(&args)[1], "create");
    }

    // ── list backups ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn list_backups_filters_by_tag_and_reads_the_sha_field_back() {
        let d = tmp();
        let op = fake_op(
            d.path(),
            r#"
if [ "$2" = "list" ]; then
  echo '[{"id":"I1","title":"sparkle/.env.local","updated_at":"2026-07-01T00:00:00Z"}]'
else
  echo '{"id":"I1","title":"sparkle/.env.local","fields":[{"id":"notes","value":"x"},{"id":"sparkle_sha256","label":"sparkle_sha256","type":"STRING","value":"HASH1"}]}'
fi
"#,
        );
        let items = list_backup_items(&op, "V1").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "sparkle/.env.local");
        assert_eq!(
            argv_calls(d.path())[0],
            vec!["item", "list", "--vault", "V1", "--tags", "", "--format=json"]
        );
        assert_eq!(item_sha256(&op, "I1", Some("V1")).unwrap().as_deref(), Some("HASH1"));
        assert_eq!(
            argv_calls(d.path())[1],
            vec!["item", "get", "I1", "--vault", "V1", "--format=json"]
        );
    }

    // ── restore: the overwrite guard ─────────────────────────────────────────────────────────

    /// A fake `op` that reports `sha` for any item and would write `payload` on a document get.
    fn fake_op_with_sha(dir: &Path, sha: &str, payload: &str) -> String {
        fake_op(
            dir,
            &format!(
                r#"
if [ "$1" = "item" ]; then
  printf '{{"id":"I1","fields":[{{"id":"sparkle_sha256","value":"{sha}"}}]}}\n'
else
  # emulate `op document get --out-file <path>`: write the payload to $5.
  printf '%s' '{payload}' > "$5"
fi
"#
            ),
        )
    }

    #[test]
    fn restore_refuses_to_clobber_a_differing_file_without_overwrite() {
        let d = tmp();
        let dest = d.path().join(".env.local");
        std::fs::write(&dest, "LOCAL=edits\n").unwrap();
        let op = fake_op_with_sha(d.path(), "a-different-hash", "FROM=vault\n");

        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap_err();
        assert!(err.contains("already exists"), "got {err}");
        // The irreversible thing must not have happened: the file is byte-for-byte untouched.
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "LOCAL=edits\n");
        // ...and no download was even attempted.
        assert!(
            !argv_calls(d.path()).iter().any(|c| c.first().map(|s| s == "document").unwrap_or(false)),
            "a refused restore must not run `op document get`"
        );
    }

    #[test]
    fn restore_is_a_noop_when_the_existing_file_is_byte_identical() {
        let d = tmp();
        let dest = d.path().join(".env.local");
        std::fs::write(&dest, "SAME=1\n").unwrap();
        let sha = sha256_of_file(&dest).unwrap();
        let op = fake_op_with_sha(d.path(), &sha, "SHOULD_NOT_BE_WRITTEN=1\n");

        restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "SAME=1\n");
        assert!(
            !argv_calls(d.path()).iter().any(|c| c.first().map(|s| s == "document").unwrap_or(false)),
            "an identical file must not be re-downloaded"
        );
    }

    #[test]
    fn restore_overwrites_a_differing_file_when_explicitly_allowed() {
        let d = tmp();
        let dest = d.path().join("nested").join(".env.local");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, "OLD=1\n").unwrap();
        let op = fake_op_with_sha(d.path(), "vault-hash", "NEW=1\n");

        restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: true,
            },
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "NEW=1\n");
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a restored secret must be owner-only");
    }

    #[test]
    fn a_failed_download_leaves_the_users_file_untouched() {
        // THE case this function exists for. Overwrite is granted, then the download fails
        // (network, revoked item, timeout, a wrong flag spelling). Deleting the file up front
        // would destroy uncommitted local secrets with no replacement — "the item was reachable a
        // moment ago" does not prove the download will succeed.
        let d = tmp();
        let dest = d.path().join(".env.local");
        std::fs::write(&dest, "PRECIOUS=local-edits\n").unwrap();

        // item get succeeds (so we get past the hash check), document get fails hard.
        let op = fake_op(
            d.path(),
            r#"
if [ "$1" = "item" ]; then
  printf '{"id":"I1","fields":[{"id":"sparkle_sha256","value":"a-different-hash"}]}\n'
else
  echo "network unreachable" >&2
  exit 1
fi
"#,
        );

        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: true,
            },
        )
        .unwrap_err();
        assert!(err.contains("network unreachable"), "got {err}");
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "PRECIOUS=local-edits\n",
            "a failed restore must not destroy the local file"
        );
        // And no debris left beside it.
        let leftovers: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("sparkle-restore"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
    }

    #[test]
    fn a_silent_no_write_download_is_not_reported_as_success() {
        // `op` exits 0 but writes nothing (e.g. the output flag was taken as a positional and the
        // document went to stdout). Reporting success here would tell the user a file was restored
        // that does not exist, and seed_worktree would list it as written.
        let d = tmp();
        let dest = d.path().join(".env.local");
        let op = fake_op(
            d.path(),
            r#"
if [ "$1" = "item" ]; then
  printf '{"id":"I1","fields":[]}\n'
else
  exit 0
fi
"#,
        );

        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: true,
            },
        )
        .unwrap_err();
        assert!(err.contains("wrote nothing"), "got {err}");
        assert!(!dest.exists(), "nothing should have been created");
    }

    #[test]
    fn restore_creates_missing_parent_directories() {
        let d = tmp();
        let dest = d.path().join("a").join("b").join(".env");
        let op = fake_op_with_sha(d.path(), "irrelevant", "K=V\n");
        restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "K=V\n");
    }

    #[test]
    fn restore_requires_overwrite_when_the_item_has_no_recorded_hash() {
        // No `sparkle_sha256` on the item → we cannot prove the bytes match, so the conservative
        // reading is "differs" and the refusal stands.
        let d = tmp();
        let dest = d.path().join(".env");
        std::fs::write(&dest, "X=1\n").unwrap();
        let op = fake_op(d.path(), r#"echo '{"id":"I1","fields":[]}'"#);
        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap_err();
        assert!(err.contains("already exists"), "got {err}");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "X=1\n");
    }

    // ── restore: empty documents and symlinked destinations ─────────────────────────────────

    #[test]
    fn restore_of_a_legitimately_empty_document_succeeds() {
        // `touch .env` placeholders are real backups (env_scan reports them at 0 bytes and
        // backup_one uploads them), so a zero-byte document must restore. The "op wrote nothing"
        // guard has to discriminate on EXISTENCE, not size — on size, an empty backup is
        // permanently unrestorable.
        let d = tmp();
        let dest = d.path().join(".env");
        let op = fake_op_with_sha(d.path(), "irrelevant", "");
        restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "");
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a restored secret must be owner-only");
    }

    #[test]
    fn a_broken_symlink_at_the_destination_still_requires_overwrite() {
        // `exists()` follows links, so a dangling `.env -> …` used to read as "no file here" —
        // skipping the overwrite gate AND renaming a regular file over the user's link. The link
        // is an existing arrangement; replacing or writing through it needs the same explicit
        // consent as overwriting a file.
        let d = tmp();
        let dest = d.path().join(".env.local");
        std::os::unix::fs::symlink("no-such-target.env", &dest).unwrap();
        let op = fake_op_with_sha(d.path(), "vault-hash", "FROM=vault\n");

        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap_err();
        assert!(err.contains("already exists"), "got {err}");
        // The link itself is untouched — still a symlink, still pointing where it did.
        let meta = std::fs::symlink_metadata(&dest).unwrap();
        assert!(meta.file_type().is_symlink(), "the user's symlink was replaced");
        assert_eq!(std::fs::read_link(&dest).unwrap(), PathBuf::from("no-such-target.env"));
        assert!(
            !argv_calls(d.path()).iter().any(|c| c.first().map(|s| s == "document").unwrap_or(false)),
            "a refused restore must not run `op document get`"
        );
    }

    #[test]
    fn restore_through_a_broken_symlink_recreates_the_linked_file() {
        // With overwrite granted, the restore goes THROUGH the dangling link — recreating the
        // file it points at — rather than replacing the link with a regular file.
        let d = tmp();
        let dest = d.path().join(".env.local");
        std::os::unix::fs::symlink("shared/real.env", &dest).unwrap();
        let op = fake_op_with_sha(d.path(), "vault-hash", "FROM=vault\n");

        restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: true,
            },
        )
        .unwrap();
        assert!(
            std::fs::symlink_metadata(&dest).unwrap().file_type().is_symlink(),
            "the user's symlink must survive the restore"
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("shared/real.env")).unwrap(),
            "FROM=vault\n"
        );
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "FROM=vault\n");
    }

    #[test]
    fn restore_writes_through_a_live_symlink_without_replacing_it() {
        let d = tmp();
        std::fs::create_dir_all(d.path().join("shared")).unwrap();
        std::fs::write(d.path().join("shared/real.env"), "OLD=1\n").unwrap();
        let dest = d.path().join(".env.local");
        std::os::unix::fs::symlink("shared/real.env", &dest).unwrap();
        let op = fake_op_with_sha(d.path(), "vault-hash", "NEW=1\n");

        restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: true,
            },
        )
        .unwrap();
        assert!(std::fs::symlink_metadata(&dest).unwrap().file_type().is_symlink());
        assert_eq!(
            std::fs::read_to_string(d.path().join("shared/real.env")).unwrap(),
            "NEW=1\n"
        );
    }

    #[test]
    fn a_stale_leftover_temp_never_passes_as_a_fresh_download() {
        // THE shape where the pre-clear is load-bearing: a crash left a temp holding STALE bytes,
        // and this time `op` exits 0 WITHOUT writing (the stdout-positional case). If the stale
        // temp survived it would satisfy the existence gate and be renamed over the destination as
        // a "successful" restore. It is cleared first, so the restore FAILS and the stale bytes go
        // nowhere.
        let d = tmp();
        let dest = d.path().join(".env");
        std::fs::write(d.path().join(".env.sparkle-restore"), "STALE=1\n").unwrap();
        let op = fake_op(
            d.path(),
            r#"
if [ "$1" = "item" ]; then
  printf '{"id":"I1","fields":[]}\n'
else
  exit 0
fi
"#,
        );

        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap_err();
        assert!(err.contains("wrote nothing"), "got {err}");
        assert!(!dest.exists(), "stale bytes must never be renamed into place");
    }

    #[test]
    fn an_unclearable_leftover_temp_refuses_the_restore_without_touching_the_file() {
        // Something unremovable (here: a directory) squats at the temp name. Downloading "over" it
        // would let stale bytes pass the existence gate, so the restore refuses BEFORE any
        // `op document` call — and the user's file stays byte-for-byte untouched.
        let d = tmp();
        let dest = d.path().join(".env");
        std::fs::write(&dest, "PRECIOUS=1\n").unwrap();
        std::fs::create_dir(d.path().join(".env.sparkle-restore")).unwrap();
        let op = fake_op_with_sha(d.path(), "a-different-hash", "NEW=1\n");

        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: true,
            },
        )
        .unwrap_err();
        assert!(err.contains("leftover restore temp"), "got {err}");
        assert!(err.contains(".env.sparkle-restore"), "the message must name the temp: {err}");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "PRECIOUS=1\n");
        assert!(
            !argv_calls(d.path())
                .iter()
                .any(|c| c.first().map(|s| s == "document").unwrap_or(false)),
            "no download may be attempted when the temp can't be cleared"
        );
    }

    #[test]
    fn debris_from_a_failed_flag_attempt_never_passes_as_the_next_attempts_success() {
        // Attempt 1 (--out-file) partially writes, then dies with an unknown-flag-shaped error;
        // attempt 2 exits 0 but streams to stdout, writing nothing. The existence gate must judge
        // each attempt on ITS OWN output: without the between-attempt clear, attempt 1's debris is
        // reported — and renamed into place — as attempt 2's success.
        let d = tmp();
        let dest = d.path().join(".env");
        let op = fake_op(
            d.path(),
            r#"
if [ "$4" = "--out-file" ]; then
  printf 'DEBRIS=1' > "$5"
  echo "unknown flag: --out-file" >&2; exit 1
fi
exit 0
"#,
        );
        let err = download_document(&op, "I1", &dest).unwrap_err();
        assert!(err.contains("wrote nothing"), "got {err}");
        assert!(!dest.exists(), "attempt 1's debris must not survive as a 'restored' file");
    }

    #[test]
    fn unremovable_debris_from_attempt_one_refuses_the_retry() {
        // Attempt 1 leaves something unremovable (a non-empty directory) at the scratch path and
        // dies with an unknown-flag error. The between-attempt clear refuses the retry — the
        // hard-fail arm of that clear, which nothing else exercises.
        let d = tmp();
        let dest = d.path().join(".env");
        let op = fake_op(
            d.path(),
            r#"
if [ "$4" = "--out-file" ]; then
  mkdir -p "$5/sub" && echo x > "$5/sub/x"
  echo "unknown flag: --out-file" >&2; exit 1
fi
printf 'OK=1\n' > "$5"
"#,
        );
        let err = download_document(&op, "I1", &dest).unwrap_err();
        assert!(err.contains("before retrying"), "got {err}");
    }

    #[test]
    fn the_between_attempt_clear_never_deletes_something_the_caller_left() {
        // The guard on that clear. `download_document`'s contract is that `dest` starts empty, and
        // the seed path satisfies it with `exists()` — which a DANGLING symlink passes while
        // `remove_file` would delete the user's LINK. So when anything is present at entry the
        // clear must stand down: attempt 1 writes nothing (unknown flag), attempt 2 also writes
        // nothing, and the link must still be there afterwards.
        let d = tmp();
        let dest = d.path().join(".env");
        std::os::unix::fs::symlink("shared/gone.env", &dest).unwrap();
        let op = fake_op(
            d.path(),
            r#"
if [ "$4" = "--out-file" ]; then
  echo "unknown flag: --out-file" >&2; exit 1
fi
exit 0
"#,
        );
        let err = download_document(&op, "I1", &dest).unwrap_err();
        assert!(err.contains("wrote nothing"), "got {err}");
        assert!(
            std::fs::symlink_metadata(&dest).unwrap().file_type().is_symlink(),
            "a caller-owned dangling link must survive the retry path"
        );
    }

    #[test]
    fn an_absolute_link_target_is_never_leaked_into_the_overwrite_message() {
        // The privacy rule: error strings cross the IPC boundary and may be logged, so an ABSOLUTE
        // link target is reduced to a flat "(an absolute path)" locator. Only a relative target —
        // what the user wrote, carrying no machine specifics — is quoted verbatim.
        let d = tmp();
        let dest = d.path().join(".env");
        std::os::unix::fs::symlink(d.path().join("shared").join(".env"), &dest).unwrap();
        let op = fake_op_with_sha(d.path(), "vault-hash", "NEW=1\n");

        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap_err();
        assert!(err.contains("is missing"), "got {err}");
        assert!(err.contains("an absolute path"), "the flat locator must appear: {err}");
        let abs = d.path().to_string_lossy().into_owned();
        assert!(!err.contains(&abs), "no absolute path may cross the boundary: {err}");
    }

    #[test]
    fn a_relative_dangling_link_target_is_named_in_the_overwrite_message() {
        // The other half: a relative target IS quoted, so the confirmation says where the bytes
        // will land. Pins the branch the absolute case suppresses.
        let d = tmp();
        let dest = d.path().join(".env");
        std::os::unix::fs::symlink("shared/gone.env", &dest).unwrap();
        let op = fake_op_with_sha(d.path(), "vault-hash", "NEW=1\n");

        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap_err();
        assert!(err.contains("is missing"), "got {err}");
        assert!(err.contains("shared/gone.env"), "the relative target must be quoted: {err}");
        assert!(
            !err.contains("local changes"),
            "a dangling link has no local changes to discard: {err}"
        );
    }

    #[test]
    fn a_self_referential_symlink_fails_hard_not_as_dangling() {
        // `.env -> .env`: metadata fails with ELOOP, which is not NotFound — so it must NOT be
        // classified dangling (that message would offer to "recreate the file the link points at",
        // i.e. itself) and the hash read's hard error surfaces instead. overwrite: false, so a
        // misclassification WOULD reach the dangling message — keeping the negative assertion
        // falsifiable.
        let d = tmp();
        let dest = d.path().join(".env");
        std::os::unix::fs::symlink(Path::new(".env"), &dest).unwrap();
        let op = fake_op_with_sha(d.path(), "vault-hash", "NEW=1\n");

        let err = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        )
        .unwrap_err();
        assert!(err.contains("couldn't read"), "expected the hash-read hard error, got {err}");
        assert!(!err.contains("is missing"), "a symlink loop is not a missing target: {err}");
        assert!(std::fs::symlink_metadata(&dest).unwrap().file_type().is_symlink());
    }

    #[test]
    fn an_unreachable_live_link_is_a_hard_error_not_a_dangling_one() {
        // A LIVE `.env -> shared/.env` whose parent directory is unreadable (EACCES). "Dangling"
        // means the target is MISSING — an unreachable target must surface as a hard error, not as
        // "target is missing" followed by a second confusing resolution failure.
        let d = tmp();
        let shared = d.path().join("shared");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join(".env"), "S=1\n").unwrap();
        let dest = d.path().join(".env");
        std::os::unix::fs::symlink(Path::new("shared").join(".env"), &dest).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::metadata(&dest).is_ok() {
            // Running as root — permissions don't bite, the scenario can't be constructed.
            std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipping an_unreachable_live_link test: running as root");
            return;
        }
        // The fake `op` is never reached (the hash read fails first) — it exists so a regression
        // that DID reach op would fail on assertions rather than on a missing binary.
        let op = fake_op_with_sha(d.path(), "vault-hash", "NEW=1\n");
        let result = restore_one(
            &op,
            &OpRestoreArgs {
                item_id: "I1".into(),
                abs_path: dest.to_string_lossy().into_owned(),
                overwrite: false,
            },
        );
        // Restore permissions BEFORE any assertion can panic, so the tempdir always cleans up.
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = result.unwrap_err();
        assert!(err.contains("couldn't read"), "expected the hash-read hard error, got {err}");
        assert!(!err.contains("is missing"), "an unreadable target is not a MISSING one: {err}");
        assert!(std::fs::symlink_metadata(&dest).unwrap().file_type().is_symlink());
        assert_eq!(
            std::fs::read_to_string(shared.join(".env")).unwrap(),
            "S=1\n",
            "the live target must be untouched by the failed restore"
        );
        assert!(
            !d.path().join(".env.sparkle-restore").exists()
                && !shared.join(".env.sparkle-restore").exists(),
            "no temp may be created before the destination is validated"
        );
    }

    #[test]
    fn the_restore_temp_name_is_ignore_matchable_and_never_backupable() {
        // The temp must keep BOTH properties: a `.env*`-shaped gitignore rule that covers the
        // real file also covers the temp (a mid-download crash must not leave a plaintext secret
        // at a path `git add -A` would stage), and env_scan must never back the temp itself up.
        let tmp = restore_temp_path(Path::new("/p/.env.local")).unwrap();
        assert_eq!(tmp, PathBuf::from("/p/.env.local.sparkle-restore"));
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with(".env.local"),
            "the real file's name must remain a prefix of the temp's, so the same ignore rules \
             match both: {name}"
        );
        assert!(!is_backupable_env_name(&name), "the scanner must reject the restore temp");
        assert!(!is_backupable_env_name(".env.sparkle-restore"));
        assert_eq!(restore_temp_path(Path::new("/")), None, "no file name → no temp path");
    }

    #[test]
    fn document_get_retries_the_alternate_output_flag() {
        // Neither `--out-file` nor `--output` could be verified against a real `op`, so the download
        // must survive whichever one is wrong. Here the first spelling is rejected as unknown.
        let d = tmp();
        let dest = d.path().join(".env");
        let op = fake_op(
            d.path(),
            r#"
if [ "$4" = "--out-file" ]; then
  echo "unknown flag: --out-file" >&2; exit 1
fi
printf 'OK=1\n' > "$5"
"#,
        );
        download_document(&op, "I1", &dest).unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "OK=1\n");
        let calls = argv_calls(d.path());
        assert_eq!(calls[0][3], "--out-file");
        assert_eq!(calls[1][3], "--output");
    }

    #[test]
    fn document_get_does_not_retry_a_real_failure() {
        let d = tmp();
        let op = fake_op(d.path(), r#"echo "item not found" >&2; exit 1"#);
        let err = download_document(&op, "I1", &d.path().join(".env")).unwrap_err();
        assert!(err.contains("item not found"), "got {err}");
        assert_eq!(argv_calls(d.path()).len(), 1, "a real failure must not retry the other flag");
    }

    #[test]
    fn unknown_flag_detection() {
        assert!(looks_like_unknown_flag("Error: unknown flag: --out-file"));
        assert!(looks_like_unknown_flag("unknown shorthand flag: 'o'"));
        assert!(!looks_like_unknown_flag("could not find item"));
    }

    // ── env_scan ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn env_name_filter_keeps_secrets_and_drops_templates() {
        for keep in [".env", ".env.local", ".env.production", ".env.development.local"] {
            assert!(is_backupable_env_name(keep), "{keep} should be backed up");
        }
        for drop in [
            ".env.example",
            ".env.sample",
            ".env.template",
            ".env.example.local",
            ".env.EXAMPLE",
            "env.local",
            "README.md",
            ".environment-notes.example",
        ] {
            assert!(!is_backupable_env_name(drop), "{drop} should NOT be backed up");
        }
    }

    #[test]
    fn env_scan_finds_real_env_files_hashes_them_and_skips_templates_and_vendor_dirs() {
        let d = tmp();
        let root = d.path();
        std::fs::write(root.join(".env.local"), "A=1\n").unwrap();
        std::fs::write(root.join(".env.example"), "A=\n").unwrap();
        std::fs::create_dir_all(root.join("apps/web")).unwrap();
        std::fs::write(root.join("apps/web/.env"), "B=2\n").unwrap();
        for skip in SKIP_DIRS {
            std::fs::create_dir_all(root.join(skip)).unwrap();
            std::fs::write(root.join(skip).join(".env"), "SECRET=leak\n").unwrap();
        }

        let files = scan_one_root(&ScanRoot {
            project_id: "P1".into(),
            project_name: "sparkle".into(),
            root_path: root.to_string_lossy().into_owned(),
        });
        let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
        // Sorted by absolute path, so the root-level dotfile precedes the nested one.
        assert_eq!(rels, vec![".env.local", "apps/web/.env"], "got {rels:?}");

        let local = files.iter().find(|f| f.rel_path == ".env.local").unwrap();
        assert_eq!(local.project_id, "P1");
        assert_eq!(local.project_name, "sparkle");
        assert_eq!(local.size_bytes, 4);
        // sha256("A=1\n") — the sole basis for drift detection, so pin the exact digest.
        assert_eq!(
            local.sha256,
            "91d6a3d55e9fea7911c537afae6607c77fa8bc0f3a76c375e104ac5a8cfa84db"
        );
        assert!(local.modified_at.ends_with('Z') && local.modified_at.len() == 20);
        assert!(local.abs_path.ends_with(".env.local"));
    }

    #[test]
    fn env_scan_bounds_recursion_depth() {
        let d = tmp();
        let root = d.path();
        // depth 1..=4 are in range; depth 5 is past MAX_SCAN_DEPTH and must be invisible.
        let mut p = root.to_path_buf();
        for i in 1..=5 {
            p = p.join(format!("l{i}"));
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join(".env"), format!("L={i}\n")).unwrap();
        }
        let files = scan_one_root(&ScanRoot {
            project_id: "P".into(),
            project_name: "n".into(),
            root_path: root.to_string_lossy().into_owned(),
        });
        let rels: Vec<String> = files.iter().map(|f| f.rel_path.clone()).collect();
        assert!(rels.contains(&"l1/l2/l3/l4/.env".to_string()), "got {rels:?}");
        assert!(
            !rels.iter().any(|r| r.contains("l5")),
            "the scan must stop at {MAX_SCAN_DEPTH} levels: {rels:?}"
        );
    }

    #[test]
    fn sha256_of_file_is_lowercase_hex_of_the_bytes() {
        let d = tmp();
        let f = d.path().join("x");
        std::fs::write(&f, b"").unwrap();
        assert_eq!(
            sha256_of_file(&f).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    // ── op_seed_worktree ─────────────────────────────────────────────────────────────────────

    #[test]
    fn seed_writes_the_relative_layout_and_never_overwrites() {
        let d = tmp();
        let dest = d.path().join("wt");
        std::fs::create_dir_all(dest.join("apps/web")).unwrap();
        // Already present: must be left EXACTLY as-is and omitted from the result.
        std::fs::write(dest.join("apps/web/.env"), "PRESERVE=me\n").unwrap();

        let op = fake_op(
            d.path(),
            r#"
if [ "$1" = "item" ]; then
  echo '[{"id":"I1","title":"sparkle/.env.local","updated_at":"2026-07-01T00:00:00Z"},{"id":"I2","title":"sparkle/apps/web/.env","updated_at":"2026-07-01T00:00:00Z"},{"id":"I3","title":"other-project/.env","updated_at":"2026-07-01T00:00:00Z"}]'
else
  printf 'RESTORED=1\n' > "$5"
fi
"#,
        );
        let written =
            seed_worktree(&op, "V1", "sparkle", &dest.to_string_lossy()).unwrap();
        assert_eq!(written, vec![".env.local".to_string()]);
        assert_eq!(std::fs::read_to_string(dest.join(".env.local")).unwrap(), "RESTORED=1\n");
        // The pre-existing file is untouched, and the other project's item was never considered.
        assert_eq!(std::fs::read_to_string(dest.join("apps/web/.env")).unwrap(), "PRESERVE=me\n");
        assert!(!dest.join("other-project").exists());
    }

    #[test]
    fn seed_refuses_to_write_through_a_symlinked_directory_out_of_the_worktree() {
        // safe_relative_path blocks `..`, but a symlinked DIRECTORY inside the worktree redirects
        // the write just as effectively: a repo tracking `apps -> /somewhere/else` turns
        // `sparkle/apps/.env` into a write outside the tree, and create_dir_all follows it happily.
        let d = tmp();
        let dest = d.path().join("wt");
        let outside = d.path().join("outside");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // No #[cfg(unix)] needed — the enclosing test module is already cfg(all(test, unix)), and
        // the attribute here read as if the test were portable when it is not.
        std::os::unix::fs::symlink(&outside, dest.join("apps")).unwrap();

        let op = fake_op(
            d.path(),
            r#"
if [ "$1" = "item" ]; then
  echo '[{"id":"I1","title":"sparkle/apps/.env","updated_at":"2026-07-01T00:00:00Z"}]'
else
  printf 'LEAKED=1\n' > "$5"
fi
"#,
        );
        let written = seed_worktree(&op, "V1", "sparkle", &dest.to_string_lossy()).unwrap();
        assert!(written.is_empty(), "a redirected write must be rejected, not counted as written");
        assert!(!outside.join(".env").exists(), "nothing may land outside the worktree");
    }

    #[test]
    fn a_dangling_leaf_symlink_reads_as_uncontained() {
        // The PREDICATE half of the escape the ancestor walk alone misses; the seed path itself is
        // covered by the test below. A repo can TRACK a dangling symlink, so this needs no race and
        // no privilege: canonicalize() fails through it, exists() reports false for it, and `op`
        // opening it O_CREAT|O_WRONLY follows it and writes the secret wherever it points.
        // Containment has to judge the link's TARGET.
        let d = tmp();
        let root = d.path().join("wt");
        std::fs::create_dir_all(&root).unwrap();
        let outside_target = d.path().join("outside").join("stolen.env");

        // `.env` -> a path outside the worktree whose target does NOT exist.
        std::os::unix::fs::symlink(&outside_target, root.join(".env")).unwrap();
        assert!(!root.join(".env").exists(), "a dangling link does not 'exist'");

        let root_real = root.canonicalize().unwrap();
        assert!(
            !is_contained(&root_real, &root.join(".env")),
            "a dangling leaf symlink pointing outside the worktree must not read as contained"
        );
        // Deliberately NOT asserting `!outside_target.exists()` here: no `op` ran, so that could
        // never have failed. The seed path's real guarantee is the next test's job.
    }

    #[test]
    fn a_dangling_leaf_escape_is_refused_by_the_seed_path_and_counted_as_rejected() {
        // Drives the escape through the real seed path with a fake `op` that genuinely WRITES, so
        // the assertions have teeth: they prove the containment check runs BEFORE download_document,
        // not merely that the predicate returns false in isolation.
        let d = tmp();
        let root = d.path().join("wt");
        std::fs::create_dir_all(&root).unwrap();
        let outside = d.path().join("outside").join("stolen.env");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".env")).unwrap();

        let op = fake_op(
            d.path(),
            r#"
if [ "$1" = "item" ]; then
  echo '[{"id":"I1","title":"sparkle/.env","updated_at":"2026-07-01T00:00:00Z"}]'
else
  printf 'STOLEN=1\n' > "$5"
fi
"#,
        );

        let out = seed_worktree_outcome(&op, "V1", "sparkle", &root.to_string_lossy()).unwrap();
        assert!(out.written.is_empty());
        // The hostile direction of the counters, which nothing asserted before: an escape is
        // REJECTED, not merely absent from `written` and not folded into `failed` or `torn_down`.
        // A regression that stopped counting escapes would otherwise be invisible.
        assert_eq!(out.rejected, 1, "a vault-supplied escape must be counted as rejected");
        assert_eq!(out.failed, 0);
        assert!(!out.torn_down);
        assert!(
            !outside.exists(),
            "the secret must not have been written through the dangling link"
        );
        // What actually pins the ORDERING. "Nothing landed outside" also holds if `document get`
        // ran and merely failed for an unrelated reason (a fake-script typo, a flag spelling this
        // fake ignores). The argv log says it was never issued at all: one `item list`, no download.
        let calls = argv_calls(d.path());
        assert_eq!(calls.len(), 1, "no `op document get` may be issued for a rejected path");
        assert_eq!(calls[0].first().map(String::as_str), Some("item"));
    }

    #[test]
    fn a_dangling_ancestor_symlink_pointing_outside_is_refused() {
        // Branch coverage for the ancestor arm. The cycle test reaches that branch but exits via the
        // hop budget, so this is the case that would go green if the branch were deleted: the walk
        // would pop past the link, land on `wt`, and falsely accept.
        let d = tmp();
        let root = d.path().join("wt");
        std::fs::create_dir_all(&root).unwrap();
        let root_real = root.canonicalize().unwrap();

        std::os::unix::fs::symlink(d.path().join("gone-outside"), root.join("apps")).unwrap();
        assert!(
            !is_contained(&root_real, &root.join("apps").join(".env")),
            "a dangling ancestor pointing outside the worktree must be refused"
        );
    }

    #[test]
    fn a_dangling_ancestor_symlink_resolving_back_inside_still_seeds() {
        // The anti-OVER-blocking guard, not branch coverage — be honest about which: with the
        // ancestor branch deleted this still passes, because the pop-walk lands on `wt` and accepts
        // anyway. It exists because over-blocking would silently drop every nested seed, which is
        // just as broken as the escape and much quieter. Its own temp root, so a failure in the
        // reject case above can't hide it (and no hostile `apps` link is left lying around).
        let d = tmp();
        let root = d.path().join("wt");
        std::fs::create_dir_all(&root).unwrap();
        let root_real = root.canonicalize().unwrap();

        std::os::unix::fs::symlink(root.join("packages").join("web"), root.join("inside")).unwrap();
        assert!(
            is_contained(&root_real, &root.join("inside").join(".env")),
            "a dangling ancestor resolving back inside the worktree must still seed"
        );
    }

    #[test]
    fn a_multi_hop_leaf_chain_is_judged_by_where_it_ends() {
        // REGRESSION cover, not branch cover — say which. Only the END of the chain decides, in both
        // directions, and nothing covered a chain longer than one hop before. It does not prove any
        // particular loop exists: the containment walk resolves this shape as a whole.
        let d = tmp();
        let root = d.path().join("wt");
        std::fs::create_dir_all(&root).unwrap();
        let root_real = root.canonicalize().unwrap();

        // .env -> hop -> (dangling, outside) → refuse.
        std::os::unix::fs::symlink(root.join("hop"), root.join(".env")).unwrap();
        std::os::unix::fs::symlink(d.path().join("gone-outside"), root.join("hop")).unwrap();
        assert!(
            !is_contained(&root_real, &root.join(".env")),
            "a chain ending outside the worktree must be refused however many hops it takes"
        );

        // ok.env -> hop2 -> (dangling, inside) → accept.
        std::os::unix::fs::symlink(root.join("hop2"), root.join("ok.env")).unwrap();
        std::os::unix::fs::symlink(root.join("pkg").join(".env"), root.join("hop2")).unwrap();
        assert!(
            is_contained(&root_real, &root.join("ok.env")),
            "a chain ending inside the worktree must still seed"
        );
    }

    #[test]
    fn a_leaf_chain_that_loops_back_to_an_inside_dir_is_accepted() {
        // The shape that the retired `target.join(suffix)` form got wrong: a link whose target is an
        // ANCESTOR of dest. That form rebuilt `dest`, re-entered the symlink branch and burned the
        // hop budget to a reject; the walk resolves it to the directory and accepts.
        //
        // Accepting is the right answer: the write lands INSIDE the worktree. It lands on a
        // directory, so `op` fails with EISDIR and the item counts as `failed` — which is the honest
        // bucket, since nothing here tried to escape. `rejected` must keep meaning "a vault-supplied
        // title tried to leave the worktree", or the one signal you would read to decide a vault is
        // hostile gets diluted by a user's own odd symlink.
        let d = tmp();
        let root = d.path().join("wt");
        std::fs::create_dir_all(&root).unwrap();
        let root_real = root.canonicalize().unwrap();

        std::os::unix::fs::symlink(&root, root.join("link")).unwrap();
        std::os::unix::fs::symlink(root.join("link"), root.join(".env")).unwrap();
        assert!(
            is_contained(&root_real, &root.join("link").join(".env")),
            "a chain that loops back to a directory inside the worktree stays contained"
        );
    }

    #[test]
    fn containment_allows_the_legitimate_layouts_it_must_not_break() {
        // Only the reject direction was covered. Over-blocking would silently drop every seeded
        // .env while leaving the suite green, so pin the allow direction too.
        let d = tmp();
        let root = d.path().join("wt");
        std::fs::create_dir_all(root.join("packages").join("apps")).unwrap();
        let root_real = root.canonicalize().unwrap();

        // A dir symlink resolving INSIDE the worktree (an ordinary monorepo shape) still seeds.
        std::os::unix::fs::symlink(root.join("packages").join("apps"), root.join("apps")).unwrap();
        assert!(is_contained(&root_real, &root.join("apps").join(".env.local")));

        // A plain nested path that doesn't exist yet is fine — that's the common case.
        assert!(is_contained(&root_real, &root.join("services").join("api").join(".env")));

        // A SIBLING worktree sharing a path prefix is NOT contained. String-prefix comparison
        // without a boundary would wrongly accept this.
        let sibling = d.path().join("wt-2");
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(!is_contained(&root_real, &sibling.join(".env")));
    }

    #[test]
    fn a_symlink_loop_is_refused_rather_than_spun_on() {
        let d = tmp();
        let root = d.path().join("wt");
        std::fs::create_dir_all(&root).unwrap();
        let a = root.join("a");
        let b = root.join("b");
        std::os::unix::fs::symlink(&b, &a).unwrap();
        std::os::unix::fs::symlink(&a, &b).unwrap();
        let root_real = root.canonicalize().unwrap();
        // Terminates (the hop bound) and refuses, rather than hanging the seed loop.
        assert!(!is_contained(&root_real, &a.join(".env")));
    }

    #[test]
    fn seed_stops_when_the_worktree_is_removed_mid_run() {
        // An agent closed moments after opening: `git worktree remove` lands while op is still
        // writing. Without the per-item re-check, create_dir_all re-creates the tree git just
        // deleted — leaving a stray directory at a slot path a later `worktree add` fails on, and a
        // plaintext .env outside any worktree.
        let d = tmp();
        let dest = d.path().join("wt");
        std::fs::create_dir_all(&dest).unwrap();
        let marker = d.path().join("removed");

        // The fake op deletes the worktree as a side effect of the FIRST download, standing in for
        // the teardown that races this loop.
        let op = fake_op(
            d.path(),
            &format!(
                r#"
if [ "$1" = "item" ]; then
  echo '[{{"id":"I1","title":"sparkle/a.env","updated_at":"2026-07-01T00:00:00Z"}},{{"id":"I2","title":"sparkle/b.env","updated_at":"2026-07-01T00:00:00Z"}}]'
else
  printf 'X=1\n' > "$5"
  if [ ! -f "{marker}" ]; then
    : > "{marker}"
    rm -rf "{dest}"
  fi
fi
"#,
                marker = marker.to_string_lossy(),
                dest = dest.to_string_lossy(),
            ),
        );
        let out = seed_worktree_outcome(&op, "V1", "sparkle", &dest.to_string_lossy()).unwrap();
        // The first item fails its post-download EXISTENCE check (`dest.metadata()` — existence
        // only, never size: a legitimately empty .env must still count as restored), because the
        // fake deleted the tree out from under it, so nothing is written. The SECOND item is where
        // the old behavior bit: `create_dir_all` on
        // its parent — the worktree root itself — would silently re-create the tree git just deleted.
        assert!(out.written.is_empty());
        assert!(!dest.exists(), "the removed worktree must not be re-created by a later item");

        // THE assertions that actually pin the teardown `break`. An empty `written` does NOT pin
        // it: a containment rejection produces exactly the same empty result, which is why the
        // earlier version of this test stayed green with the break deleted. Only the counters tell
        // the two apart — and that distinction is not bookkeeping. `rejected` counts vault-supplied
        // titles trying to escape the worktree, so folding a benign teardown into it corrupts the
        // one signal you would read to decide whether a vault is attacking you.
        assert!(out.torn_down, "a mid-run teardown must stop the loop via the teardown break");
        assert_eq!(out.rejected, 0, "a teardown must never be counted as a hostile path");
        // The only place in the suite where `failed` is nonzero. Without this, every assertion on
        // the field is `== 0` and "failures are counted" is indistinguishable from "the field is
        // always zero" — so a regression folding failures into `rejected` (the exact conflation
        // SeedOutcome exists to prevent) would stay invisible.
        assert_eq!(out.failed, 1, "the first item's failed post-download check must be counted");
    }

    #[test]
    fn seed_recreates_nested_directories_for_a_monorepo_layout() {
        let d = tmp();
        let dest = d.path().join("wt");
        std::fs::create_dir_all(&dest).unwrap();
        let op = fake_op(
            d.path(),
            r#"
if [ "$1" = "item" ]; then
  echo '[{"id":"I1","title":"sparkle/apps/desktop/.env.local","updated_at":"2026-07-01T00:00:00Z"}]'
else
  printf 'K=V\n' > "$5"
fi
"#,
        );
        let written = seed_worktree(&op, "V1", "sparkle", &dest.to_string_lossy()).unwrap();
        assert_eq!(written, vec!["apps/desktop/.env.local".to_string()]);
        assert_eq!(
            std::fs::read_to_string(dest.join("apps/desktop/.env.local")).unwrap(),
            "K=V\n"
        );
    }

    #[test]
    fn seed_rejects_path_traversal_in_an_item_title() {
        // A title is data the VAULT supplies and seed turns into a write path. It must never be able
        // to escape destRoot.
        let d = tmp();
        let dest = d.path().join("wt");
        std::fs::create_dir_all(&dest).unwrap();
        let outside = d.path().join("outside.env");
        std::fs::write(&outside, "ORIGINAL=1\n").unwrap();

        let op = fake_op(
            d.path(),
            r#"
if [ "$1" = "item" ]; then
  echo '[{"id":"I1","title":"sparkle/../outside.env","updated_at":"x"},{"id":"I2","title":"sparkle//etc/evil.env","updated_at":"x"},{"id":"I3","title":"sparkle/ok.env","updated_at":"x"}]'
else
  printf 'PWNED=1\n' > "$5"
fi
"#,
        );
        let written = seed_worktree(&op, "V1", "sparkle", &dest.to_string_lossy()).unwrap();
        assert_eq!(written, vec!["ok.env".to_string()], "only the safe title may be written");
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "ORIGINAL=1\n",
            "a `..` title must not write outside destRoot"
        );
    }

    #[test]
    fn safe_relative_path_rejects_escapes_and_accepts_ordinary_names() {
        assert_eq!(safe_relative_path(".env.local"), Some(PathBuf::from(".env.local")));
        assert_eq!(
            safe_relative_path("apps/web/.env"),
            Some(PathBuf::from("apps/web/.env"))
        );
        for bad in ["../x", "a/../../x", "/etc/passwd", "", "   ", "./x", "..", "/"] {
            assert_eq!(safe_relative_path(bad), None, "{bad:?} must be rejected");
        }
    }

    #[test]
    fn seed_fails_fast_when_the_destination_does_not_exist() {
        let d = tmp();
        let op = fake_op(d.path(), "echo '[]'");
        let err = seed_worktree(&op, "V", "p", &d.path().join("nope").to_string_lossy()).unwrap_err();
        assert!(err.contains("doesn't exist"), "got {err}");
    }

    // ── plumbing ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn op_calls_are_bounded_so_a_hung_cli_cannot_wedge_agent_spawn() {
        // seed_worktree runs on the worktree-creation path. A hanging `op` must time out, not block.
        let d = tmp();
        // The body deliberately spawns a GRANDCHILD that outlives the direct child and inherits the
        // stdout pipe: `sh -c` forks, `&` detaches it, `wait` keeps the fake `op` itself alive. A
        // bare `sleep 30` is the last command in the script, so the shell may just EXEC it — then
        // there is no grandchild and killing the child alone is enough. That is exactly why the bug
        // showed up only in Linux CI (dash forked) and never locally on macOS. Mutation-checked:
        // with the process-group kill removed from output_with_timeout, this test fails on macOS
        // too ("the timeout did not fire" — the reader joins block on the orphaned sleep).
        let op = fake_op(d.path(), "sh -c 'sleep 30' & wait");
        let started = std::time::Instant::now();
        let err = run_op_str(&op, &["vault", "list"], Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("timed out"), "got {err}");
        assert!(started.elapsed() < Duration::from_secs(5), "the timeout did not fire");
    }

    #[test]
    fn errors_are_first_line_only_and_home_redacted() {
        let home = std::env::var("HOME").unwrap_or_default();
        let msg = format!("could not open {home}/Projects/x/.env\nstack frame\nmore noise");
        let out = sanitize_op_error(&msg, "", true);
        assert!(!out.contains('\n'));
        if home.len() > 1 {
            assert!(!out.contains(&home), "the home dir must be redacted: {out}");
            assert!(out.contains("~/Projects/x/.env"));
        }
    }

    #[test]
    fn a_document_commands_stdout_never_reaches_the_error_message() {
        // `op document get` streams the DOCUMENT to stdout. A non-zero exit with a quiet stderr
        // must not put a line of the user's secret into a string that crosses the IPC boundary.
        let secret = "SUPER_SECRET_TOKEN=hunter2";
        let out = sanitize_op_error("", secret, stdout_is_safe_to_quote(&["document".into()]));
        assert!(!out.contains("hunter2"), "a secret leaked into an error message: {out}");
        assert_eq!(out, "no output");

        // Non-document commands print diagnostics on stdout, which stay useful to show.
        let out = sanitize_op_error("", "vault not found", stdout_is_safe_to_quote(&["vault".into()]));
        assert_eq!(out, "vault not found");
    }

    #[test]
    fn stdout_is_untrusted_for_document_commands_and_for_an_empty_argv() {
        assert!(!stdout_is_safe_to_quote(&["document".to_string()]));
        // Default-deny: an argv we don't recognize is not assumed safe.
        assert!(!stdout_is_safe_to_quote(&[]));
        assert!(stdout_is_safe_to_quote(&["item".to_string()]));
        assert!(stdout_is_safe_to_quote(&["vault".to_string()]));
    }

    #[test]
    fn env_name_filter_rejects_lookalikes_and_stale_copies() {
        // The real family.
        assert!(is_backupable_env_name(".env"));
        assert!(is_backupable_env_name(".env.local"));
        assert!(is_backupable_env_name(".env.production"));

        // Not dotenv at all: .envrc is a direnv shell script, .environment is something else.
        // A bare starts_with(".env") would back both up and then seed them into every worktree.
        assert!(!is_backupable_env_name(".envrc"));
        assert!(!is_backupable_env_name(".environment"));

        // Committed templates, by several conventions.
        for name in [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults", ".env.schema"] {
            assert!(!is_backupable_env_name(name), "{name} is a template");
        }
        assert!(!is_backupable_env_name(".env.example.local"), "a compound template");

        // Stale copies: real secrets, but throwaway duplicates that would each become a vault item.
        for name in [".env.local.bak", ".env.local.orig", ".env.local.swp", ".env.local.save", ".env.local~"] {
            assert!(!is_backupable_env_name(name), "{name} is a stale copy");
        }
    }

    #[test]
    fn known_op_paths_prioritizes_user_then_brew_then_usr_local() {
        let paths = known_op_paths_for(Some(PathBuf::from("/Users/x")));
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert_eq!(strs[0], "/Users/x/.local/bin/op");
        assert!(strs.contains(&"/opt/homebrew/bin/op".to_string()));
        assert!(strs.contains(&"/usr/local/bin/op".to_string()));

        let none = known_op_paths_for(None);
        assert!(!none.iter().any(|p| p.to_string_lossy().contains(".local")));
        assert!(none.iter().any(|p| p.ends_with("opt/homebrew/bin/op")));
    }

    #[test]
    fn program_override_is_the_test_seam_for_the_commands() {
        // The only test that touches the process-global override; it restores it immediately so no
        // other test can observe it.
        set_op_program_override(Some("/tmp/fake-op".into()));
        assert_eq!(cached_op_path().as_deref(), Some("/tmp/fake-op"));
        set_op_program_override(None);
    }

    #[test]
    fn iso8601_formatting_matches_known_instants() {
        assert_eq!(epoch_to_iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(epoch_to_iso8601(1), "1970-01-01T00:00:01Z");
        assert_eq!(epoch_to_iso8601(1_784_902_800), "2026-07-24T14:20:00Z");
        // A leap day, to prove the calendar arithmetic rather than a lucky offset.
        assert_eq!(epoch_to_iso8601(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(system_time_to_iso8601(UNIX_EPOCH), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn readiness_serializes_to_the_contracts_kebab_case_union() {
        // The frontend switches on these exact strings (OpReadiness in onepassword.ts).
        let j = serde_json::to_value(OpStatus {
            readiness: OpReadiness::IntegrationOff,
            path: Some("/opt/homebrew/bin/op".into()),
            version: Some("2.30.0".into()),
            account_url: None,
            error: None,
        })
        .unwrap();
        assert_eq!(j["readiness"], "integration-off");
        assert_eq!(j["accountUrl"], serde_json::Value::Null);
        assert!(j.get("account_url").is_none(), "the contract is camelCase");
        assert_eq!(
            serde_json::to_value(OpReadiness::CliMissing).unwrap(),
            "cli-missing"
        );
        assert_eq!(serde_json::to_value(OpReadiness::Ready).unwrap(), "ready");
    }

    #[test]
    fn contract_structs_serialize_camel_case() {
        let f = EnvFile {
            project_id: "P".into(),
            project_name: "n".into(),
            rel_path: ".env".into(),
            abs_path: "/p/.env".into(),
            size_bytes: 3,
            sha256: "h".into(),
            modified_at: "1970-01-01T00:00:00Z".into(),
        };
        let j = serde_json::to_value(&f).unwrap();
        for k in ["projectId", "projectName", "relPath", "absPath", "sizeBytes", "modifiedAt"] {
            assert!(j.get(k).is_some(), "EnvFile is missing {k}");
        }
        let r = OpBackupRecord {
            item_id: "I".into(),
            title: "t".into(),
            sha256: "h".into(),
            updated_at: "1970-01-01T00:00:00Z".into(),
        };
        let j = serde_json::to_value(&r).unwrap();
        assert!(j.get("itemId").is_some() && j.get("updatedAt").is_some());
    }

    #[test]
    fn contract_args_deserialize_from_camel_case_ipc_payloads() {
        let a: OpBackupArgs = serde_json::from_str(
            r#"{"vaultId":"V","absPath":"/p/.env","title":"t","sha256":"h"}"#,
        )
        .unwrap();
        assert_eq!(a.vault_id, "V");
        assert_eq!(a.item_id, None);
        let r: OpRestoreArgs =
            serde_json::from_str(r#"{"itemId":"I","absPath":"/p/.env","overwrite":true}"#).unwrap();
        assert_eq!(r.item_id, "I");
        assert!(r.overwrite);
        let s: Vec<ScanRoot> =
            serde_json::from_str(r#"[{"projectId":"P","projectName":"n","rootPath":"/p"}]"#)
                .unwrap();
        assert_eq!(s[0].root_path, "/p");
    }
}

//! Multi Claude Max account registry (multi-max design, Phase 1). An "account" is
//! a named, isolated Claude config directory the user logged into via a normal
//! `claude login`. Sparkle owns the *folder* and the metadata, never the tokens —
//! pointing the genuine `claude` binary at the right folder per-spawn (via
//! `CLAUDE_CONFIG_DIR`) is the whole mechanism, so this stays ToS-clean exactly
//! like `pty.rs` (see bead  / ).
//!
//! Metadata persists as JSON at `<app_data>/accounts.json`; each added account's
//! config dir lives at `<app_data>/accounts/<id>/`. Usage is tallied by reading
//! each account's own `<config_dir>/projects/**/*.jsonl` transcripts and bucketing
//! token counts into trailing 5h / 7d windows — we can't read Anthropic's caps, so
//! "near cap" is learned from these tallies plus failover-on-rate-limit.
//!
//! Inner functions are pure (take paths / the `now` epoch, never an `AppHandle`)
//! so they unit-test without a Tauri runtime; the `#[tauri::command]`s are thin
//! wrappers that resolve `app_data_dir` and delegate.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

/// Process-wide lock serializing the read-modify-write of `accounts.json`. Held in
/// Tauri managed state (registered in `lib.rs` via `.manage(...)`); every mutating
/// command acquires it for its whole critical section, so concurrent commands —
/// notably the rate-limit failover calling `accounts_mark_exhausted` while the user
/// adds/renames/removes — can't clobber each other's writes (lost-update race). The
/// pure `*_at` fns stay lock-free and unit-testable; the lock lives only in the
/// command-wrapper layer. Reads (`accounts_list`, `accounts_usage`) stay lock-free:
/// each does a single `read` syscall that, thanks to the atomic-rename write
/// (`write_accounts_at`), always sees a complete prior-or-next version of the file.
#[derive(Default)]
pub struct AccountsLock(pub std::sync::Mutex<()>);

impl AccountsLock {
    /// Acquire the registry lock, recovering from a poisoned mutex (a panic in a
    /// prior holder must not permanently brick account management). The guard is
    /// `()`, held only for RAII serialization.
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A registered Claude config directory. Serialized to `accounts.json` with
/// camelCase keys (`configDir`, `isDefault`, `createdAt`, `exhaustedUntil`) to
/// match the frontend's JS shape.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub nickname: String,
    /// The directory used as `CLAUDE_CONFIG_DIR` for jobs on this account. For an
    /// added account this is `<app_data>/accounts/<id>/`; for the imported default
    /// it's the user's real `~/.claude` (or `$CLAUDE_CONFIG_DIR`).
    pub config_dir: String,
    pub is_default: bool,
    /// Epoch SECONDS the account was registered (Unix time). The frontend treats this
    /// as seconds too (display-only; never compared to `Date.now()`).
    pub created_at: i64,
    /// Epoch SECONDS until which this account is known-exhausted (hit a real rate
    /// limit). Optional — absent on accounts that have never been throttled. The TS
    /// writer (`markExhausted`) converts its `Date.now()`-based ms to seconds before
    /// calling `accounts_mark_exhausted`, and reads it back multiplied to ms; keeping
    /// this in seconds is what lets `usage_for_account`'s `e > now_secs()` future-filter
    /// actually clear expired exhaustions (sparkle-ggvp). Legacy values persisted in ms
    /// (pre-fix) are repaired on read by [`normalize_epoch_seconds`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exhausted_until: Option<i64>,
}

/// Any epoch at or above this is a stray MILLISECONDS value that must be scaled back to
/// seconds. As seconds this is year ~5138; as ms it's year 1973 — so every realistic
/// current/near-future instant is unambiguous: a seconds epoch is well below it (~1.7e9)
/// and an ms epoch well above it (~1.7e12). Used by [`normalize_epoch_seconds`] to migrate
/// records written before the seconds/ms unit was unified (sparkle-ggvp).
const MS_EPOCH_THRESHOLD: i64 = 100_000_000_000;

/// Coerce a possibly-milliseconds epoch to seconds. Idempotent: a real seconds value
/// (< [`MS_EPOCH_THRESHOLD`]) is returned unchanged, a millisecond value is divided by
/// 1000. This is the one-way migration for exhaustions persisted in ms before the unit fix.
fn normalize_epoch_seconds(epoch: i64) -> i64 {
    if epoch >= MS_EPOCH_THRESHOLD {
        epoch / 1000
    } else {
        epoch
    }
}

/// Per-account usage snapshot returned by [`accounts_usage`]: token tallies in the
/// trailing 5h and 7d windows, plus the still-in-effect exhausted-until epoch.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub id: String,
    pub tokens_5h: u64,
    pub tokens_7d: u64,
    pub exhausted_until: Option<i64>,
}

/// The REAL authenticated Claude identity for one account, returned by
/// [`accounts_identities`]. Read from that account's own `<config_dir>/.claude.json`
/// (`oauthAccount.emailAddress` / `oauthAccount.organizationName`) — the trustworthy
/// label the badge/AccountsScreen shows, as opposed to the user-typed `nickname`.
/// `email`/`organization` are `None` for an account whose config dir has no
/// `.claude.json` yet (created but never `claude login`ed → "not signed in").
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub id: String,
    pub email: Option<String>,
    pub organization: Option<String>,
}

/// Trailing usage windows, in seconds.
const WINDOW_5H: i64 = 5 * 60 * 60;
const WINDOW_7D: i64 = 7 * 24 * 60 * 60;

// ---- path helpers -------------------------------------------------------------

/// `<app_data>/accounts.json` — the metadata file.
fn accounts_json_path(app_data: &Path) -> PathBuf {
    app_data.join("accounts.json")
}

/// `<app_data>/accounts/<id>/` — an added account's isolated config dir.
fn account_config_dir(app_data: &Path, id: &str) -> PathBuf {
    app_data.join("accounts").join(id)
}

// ---- time / id ----------------------------------------------------------------

/// Current Unix epoch seconds. Backend window math only — never fed to the JS side.
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A short random hex id (8 bytes → 16 hex chars) from `/dev/urandom`. Mirrors
/// `bridge.rs::generate_token` so we add no new dependency for randomness.
fn generate_account_id() -> Result<String, String> {
    let mut f = std::fs::File::open("/dev/urandom").map_err(|e| format!("urandom open: {e}"))?;
    let mut buf = [0u8; 8];
    f.read_exact(&mut buf).map_err(|e| format!("urandom read: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

// ---- persistence (pure) -------------------------------------------------------

/// Read `accounts.json`, returning an empty vec when the file is absent (a clean
/// install). A present-but-unparseable file is an error rather than silent loss.
fn read_accounts_at(path: &Path) -> Result<Vec<Account>, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let mut accounts: Vec<Account> =
                serde_json::from_slice(&bytes).map_err(|e| format!("parse accounts.json: {e}"))?;
            // Migrate any epoch field persisted in milliseconds (pre-unit-fix) back to seconds so
            // the future-filter and window math see a consistent unit (sparkle-ggvp). Idempotent —
            // a no-op on records already written in seconds. Applied in-memory on every read; the
            // next mutating write persists the repaired values.
            for a in &mut accounts {
                a.created_at = normalize_epoch_seconds(a.created_at);
                a.exhausted_until = a.exhausted_until.map(normalize_epoch_seconds);
            }
            Ok(accounts)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read accounts.json: {e}")),
    }
}

/// Write `accounts.json` (pretty-printed), creating the parent dir if needed.
/// Atomic: serialize to a sibling temp file in the SAME directory, then `rename`
/// over the target (an atomic replace on the same filesystem). A crash or full disk
/// mid-write thus leaves the previous valid file intact rather than a truncated one
/// — important because `read_accounts_at` treats a present-but-unparseable file as a
/// hard error that would lock the user out of all account management.
fn write_accounts_at(path: &Path, accounts: &[Account]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir app data dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(accounts).map_err(|e| format!("serialize accounts: {e}"))?;
    // Temp file in the same dir so the final rename stays on one filesystem (atomic).
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("write accounts.json tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup of the orphan temp
        format!("rename accounts.json into place: {e}")
    })
}

// ---- mutations (pure) ---------------------------------------------------------

/// Create the account's config dir, append it (non-default) to `accounts.json`,
/// and return it. The frontend launches `claude login` against `config_dir`
/// separately — we never spawn it here.
fn add_account_at(
    app_data: &Path,
    accounts_path: &Path,
    nickname: String,
    id: String,
    now: i64,
) -> Result<Account, String> {
    let mut accounts = read_accounts_at(accounts_path)?;
    let dir = account_config_dir(app_data, &id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create account dir: {e}"))?;
    // Owner-only: `claude login` writes its OAuth tokens under this dir. Best-effort.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let acct = Account {
        id,
        nickname,
        config_dir: dir.to_string_lossy().into_owned(),
        is_default: false,
        created_at: now,
        exhausted_until: None,
    };
    accounts.push(acct.clone());
    write_accounts_at(accounts_path, &accounts)?;
    Ok(acct)
}

/// Rename an account in place.
fn set_nickname_at(accounts_path: &Path, id: &str, nickname: String) -> Result<(), String> {
    let mut accounts = read_accounts_at(accounts_path)?;
    let acct = accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("account not found: {id}"))?;
    acct.nickname = nickname;
    write_accounts_at(accounts_path, &accounts)
}

/// Which directory (if any) [`remove_account_at`] should delete for `acct`.
/// NEVER returns a path for a default account — that guards the user's real
/// `~/.claude`, which is imported by reference and must survive a "remove".
fn dir_to_remove_on_remove(acct: &Account) -> Option<PathBuf> {
    if acct.is_default {
        None
    } else {
        Some(PathBuf::from(&acct.config_dir))
    }
}

/// Drop an account from `accounts.json` and delete its config dir — but never the
/// dir of a default account (see [`dir_to_remove_on_remove`]).
fn remove_account_at(accounts_path: &Path, id: &str) -> Result<(), String> {
    let mut accounts = read_accounts_at(accounts_path)?;
    let pos = accounts
        .iter()
        .position(|a| a.id == id)
        .ok_or_else(|| format!("account not found: {id}"))?;
    let acct = accounts.remove(pos);
    if let Some(dir) = dir_to_remove_on_remove(&acct) {
        let _ = std::fs::remove_dir_all(&dir); // best-effort; metadata removal is the source of truth
    }
    write_accounts_at(accounts_path, &accounts)
}

/// Idempotently register the default account: if one already exists, return it
/// unchanged; otherwise add a `Default`, `is_default = true` record pointing at
/// the existing config dir (imported by reference, never copied).
fn import_default_at(
    accounts_path: &Path,
    config_dir: String,
    id: String,
    now: i64,
) -> Result<Account, String> {
    let mut accounts = read_accounts_at(accounts_path)?;
    if let Some(existing) = accounts.iter().find(|a| a.is_default) {
        return Ok(existing.clone());
    }
    let acct = Account {
        id,
        nickname: "Default".to_string(),
        config_dir,
        is_default: true,
        created_at: now,
        exhausted_until: None,
    };
    accounts.push(acct.clone());
    write_accounts_at(accounts_path, &accounts)?;
    Ok(acct)
}

/// Persist a per-account exhausted-until epoch (the moment the rate limit resets).
fn mark_exhausted_at(accounts_path: &Path, id: &str, until_epoch: i64) -> Result<(), String> {
    let mut accounts = read_accounts_at(accounts_path)?;
    let acct = accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("account not found: {id}"))?;
    acct.exhausted_until = Some(until_epoch);
    write_accounts_at(accounts_path, &accounts)
}

// ---- usage tally (pure) -------------------------------------------------------

/// Sum the four token counters Claude Code records in a `usage` object. Defensive:
/// any missing/non-numeric field contributes 0.
fn sum_usage_tokens(usage: &serde_json::Value) -> u64 {
    let g = |k: &str| usage.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
    g("input_tokens")
        + g("output_tokens")
        + g("cache_creation_input_tokens")
        + g("cache_read_input_tokens")
}

/// Parse a UTC ISO-8601 timestamp (`2026-06-25T21:20:25.931Z`, the form Claude
/// Code writes) to Unix epoch seconds. Defensive: returns `None` on anything
/// malformed. Fractional seconds and any trailing `Z`/offset are ignored — we only
/// need second-resolution window bucketing.
fn parse_iso8601_to_epoch(s: &str) -> Option<i64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    if d.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Take just "HH:MM:SS" off the front of the time part (drops ".931Z", "+00:00", etc.).
    let hms = time.get(0..8)?;
    let mut t = hms.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let min: i64 = t.next()?.parse().ok()?;
    let sec: i64 = t.next()?.parse().ok()?;
    if !(0..24).contains(&hour) || !(0..60).contains(&min) || !(0..=60).contains(&sec) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3_600 + min * 60 + sec)
}

/// Days since the Unix epoch (1970-01-01) for a proleptic-Gregorian Y-M-D.
/// Howard Hinnant's `days_from_civil` — exact integer arithmetic, no leap-year
/// special-casing bugs, no dependency.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400; // [0, 399]
    let m = m as i64;
    let d = d as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Sum token records into (5h, 7d) tallies. A record counts toward a window when
/// its timestamp is within that trailing window of `now` (the 7d total is a
/// superset of the 5h total).
fn bucket_tokens(records: &[(i64, u64)], now: i64) -> (u64, u64) {
    let mut t5: u64 = 0;
    let mut t7: u64 = 0;
    for &(ts, tokens) in records {
        if ts >= now - WINDOW_7D {
            t7 = t7.saturating_add(tokens);
            if ts >= now - WINDOW_5H {
                t5 = t5.saturating_add(tokens);
            }
        }
    }
    (t5, t7)
}

/// Pull (timestamp, tokens) records from one `.jsonl` transcript into `out`.
/// Best-effort and DEFENSIVE: a missing file, a non-JSON line, or a line missing
/// `timestamp`/`usage` is skipped rather than failing the whole scan. The
/// `usage` object is read from `message.usage` (where Claude Code records it),
/// falling back to a top-level `usage` for robustness.
fn collect_usage_from_file(path: &Path, out: &mut Vec<(i64, u64)>) {
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        // Cheap pre-filter: only the minority of lines carrying token usage matter.
        if line.is_empty() || !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(ts) = v
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .and_then(parse_iso8601_to_epoch)
        else {
            continue;
        };
        let usage = v
            .get("message")
            .and_then(|m| m.get("usage"))
            .or_else(|| v.get("usage"));
        let Some(usage) = usage else { continue };
        let tokens = sum_usage_tokens(usage);
        if tokens > 0 {
            out.push((ts, tokens));
        }
    }
}

/// Recursively collect usage records from every `.jsonl` under `projects_root`.
/// Missing root → no records (a never-used account).
///
/// Recursion follows REAL subdirectories only — `entry.file_type()` reports the link
/// itself (it does not follow), so `is_dir()` is true only for a true directory and a
/// symlinked dir is never descended into. That's the cycle guard: a self-referential
/// symlink under `projects/` can't drive unbounded recursion. Tradeoff: a project dir
/// the user *legitimately* symlinks elsewhere is also not traversed (its transcripts
/// are excluded); we accept that minor under-count rather than add canonicalized-path
/// cycle tracking. Symlinked `.jsonl` *files*, however, are still counted — a symlinked
/// transcript is real usage and a dir symlink has no `.jsonl` extension to match here.
///
/// `cutoff_epoch` (Unix seconds) is a fast pre-filter: a `.jsonl` whose last-modified time is older
/// than it is skipped WITHOUT opening/parsing it. Because a transcript's records are only ever
/// APPENDED (a record's timestamp ≤ the file's mtime), a file untouched since before `now - 7d`
/// contains only out-of-window records — every one of which `bucket_tokens` would discard anyway —
/// so skipping it changes no in-window total while avoiding streaming+parsing the whole file on the
/// main thread. Pass `0` to disable the filter (stat every file in). A file whose mtime can't be
/// read fails OPEN (is parsed), so we never under-count on a stat error.
fn collect_usage_records(projects_root: &Path, cutoff_epoch: i64, out: &mut Vec<(i64, u64)>) {
    let Ok(entries) = std::fs::read_dir(projects_root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            collect_usage_records(&path, cutoff_epoch, out);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        {
            // Skip transcripts untouched since before the 7d window (all their records are stale).
            // Use std::fs::metadata (which FOLLOWS symlinks) rather than DirEntry::metadata (an
            // lstat that returns the symlink node's own mtime): a symlinked transcript must be
            // judged by its TARGET's mtime — the real file we'd otherwise parse — or a link node
            // older than the window would wrongly skip a target being appended today (under-count).
            // Fail open: if the stat/mtime read errors (e.g. broken symlink), we don't skip.
            if cutoff_epoch > 0 {
                if let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) {
                    if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
                        if (dur.as_secs() as i64) < cutoff_epoch {
                            continue;
                        }
                    }
                }
            }
            collect_usage_from_file(&path, out);
        }
    }
}

/// Compute the usage snapshot for one account at `now`. Resolves the transcript
/// root the SAME way session detection does (`claude.rs::claude_projects_root`,
/// passing the account's own `config_dir`), then buckets. A stored
/// `exhausted_until` is surfaced only while still in the future.
fn usage_for_account(acct: &Account, now: i64) -> AccountUsage {
    let mut records = Vec::new();
    if let Some(root) =
        crate::claude::claude_projects_root(Some(Path::new(&acct.config_dir)), None)
    {
        // Only files touched within the trailing 7d window can hold in-window records; older ones
        // are skipped by mtime before we open them (see collect_usage_records).
        collect_usage_records(&root, now - WINDOW_7D, &mut records);
    }
    let (tokens_5h, tokens_7d) = bucket_tokens(&records, now);
    AccountUsage {
        id: acct.id.clone(),
        tokens_5h,
        tokens_7d,
        exhausted_until: acct.exhausted_until.filter(|&e| e > now),
    }
}

// ---- real OAuth identity (pure) -----------------------------------------------

/// Resolve which config dir to read the OAuth identity from: an explicit non-empty
/// path (a named account's `<app_data>/accounts/<id>/` or the imported default's
/// `~/.claude`), else fall back to `<home>/.claude`. Mirrors how the spawn path treats
/// an empty `CLAUDE_CONFIG_DIR` as "use the default". Returns `None` only when neither
/// a usable explicit dir nor a home is available.
fn resolve_identity_config_dir(config_dir: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(d) = config_dir {
        if !d.as_os_str().is_empty() {
            return Some(d.to_path_buf());
        }
    }
    home.map(|h| h.join(".claude"))
}

/// Read the REAL authenticated identity Claude Code records in
/// `<config_dir>/.claude.json` under `oauthAccount` (`emailAddress`,
/// `organizationName`). DEFENSIVE and never errors: a missing file, unparseable JSON,
/// a missing/empty `oauthAccount`, or a missing/empty `emailAddress` all yield `None`
/// (an account dir created but never logged into — "not signed in"). The org is `None`
/// when absent/empty even if the email is present. The email is the authoritative
/// label; the nickname is only a secondary alias.
fn read_oauth_identity_at(
    config_dir: Option<&Path>,
    home: Option<&Path>,
) -> Option<(String, Option<String>)> {
    let dir = resolve_identity_config_dir(config_dir, home)?;
    let bytes = std::fs::read(dir.join(".claude.json")).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let oauth = v.get("oauthAccount")?;
    let email = oauth
        .get("emailAddress")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let organization = oauth
        .get("organizationName")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some((email, organization))
}

// ---- Tauri commands (thin wrappers) -------------------------------------------

/// All registered accounts (empty vec on a clean install).
///
/// `async` + `spawn_blocking`: reads `accounts.json` off the event loop. The (cheap) app-data-dir
/// resolution needs `&app`, so it stays on the caller thread; the blocking file read moves to the
/// blocking pool.
#[tauri::command]
pub async fn accounts_list(app: AppHandle) -> Result<Vec<Account>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_accounts_at(&accounts_json_path(&app_data)))
        .await
        .map_err(|e| format!("accounts_list task failed: {e}"))?
}

/// Register a new (non-default) account: create `<app_data>/accounts/<id>/` and
/// append it. The frontend drives `claude login` against the new dir separately.
#[tauri::command]
pub fn accounts_add(
    app: AppHandle,
    lock: State<'_, AccountsLock>,
    nickname: String,
) -> Result<Account, String> {
    let _guard = lock.guard();
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    let id = generate_account_id()?;
    add_account_at(
        &app_data,
        &accounts_json_path(&app_data),
        nickname,
        id,
        now_secs(),
    )
}

/// Rename an account.
#[tauri::command]
pub fn accounts_set_nickname(
    app: AppHandle,
    lock: State<'_, AccountsLock>,
    id: String,
    nickname: String,
) -> Result<(), String> {
    let _guard = lock.guard();
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    set_nickname_at(&accounts_json_path(&app_data), &id, nickname)
}

/// Remove an account and delete its config dir — never a default's (which would be
/// the user's real `~/.claude`).
#[tauri::command]
pub fn accounts_remove(
    app: AppHandle,
    lock: State<'_, AccountsLock>,
    id: String,
) -> Result<(), String> {
    let _guard = lock.guard();
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    remove_account_at(&accounts_json_path(&app_data), &id)
}

/// Idempotently import the user's existing default config dir as an account.
/// `config_dir` = `$CLAUDE_CONFIG_DIR` if set, else `$HOME/.claude`.
#[tauri::command]
pub fn accounts_import_default(
    app: AppHandle,
    lock: State<'_, AccountsLock>,
) -> Result<Account, String> {
    let _guard = lock.guard();
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))
        .ok_or_else(|| "cannot resolve default config dir (no CLAUDE_CONFIG_DIR or HOME)".to_string())?
        .to_string_lossy()
        .into_owned();
    let id = generate_account_id()?;
    import_default_at(&accounts_json_path(&app_data), config_dir, id, now_secs())
}

/// Record that an account hit a real rate limit, resetting at `until_epoch`.
/// (Tauri maps the JS `untilEpoch` camelCase arg to this snake_case param.)
#[tauri::command]
pub fn accounts_mark_exhausted(
    app: AppHandle,
    lock: State<'_, AccountsLock>,
    id: String,
    until_epoch: i64,
) -> Result<(), String> {
    let _guard = lock.guard();
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    mark_exhausted_at(&accounts_json_path(&app_data), &id, until_epoch)
}

/// Per-account token tallies (5h / 7d) plus any in-effect exhausted-until epoch.
///
/// `async` + `spawn_blocking`: reads `accounts.json` AND scans each account's transcript files to
/// tally tokens — real blocking IO that must stay off the Tauri event-loop thread.
#[tauri::command]
pub async fn accounts_usage(app: AppHandle) -> Result<Vec<AccountUsage>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AccountUsage>, String> {
        let accounts = read_accounts_at(&accounts_json_path(&app_data))?;
        let now = now_secs();
        Ok(accounts.iter().map(|a| usage_for_account(a, now)).collect())
    })
    .await
    .map_err(|e| format!("accounts_usage task failed: {e}"))?
}

/// The REAL authenticated identity (email + org) for every account, read from each
/// account's own `<config_dir>/.claude.json`. `email`/`organization` are `null` for an
/// account with no identity yet (dir created but never `claude login`ed). This is the
/// trustworthy account label the badge and Accounts screen surface, so the user can see
/// which account a session actually runs under — not just the nickname they typed.
///
/// `async` + `spawn_blocking`: this opens `accounts.json` PLUS every account's own `.claude.json`,
/// so it is the heaviest read here — it must never run inline on the Tauri event-loop thread.
#[tauri::command]
pub async fn accounts_identities(app: AppHandle) -> Result<Vec<AccountIdentity>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AccountIdentity>, String> {
        let accounts = read_accounts_at(&accounts_json_path(&app_data))?;
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Ok(accounts
            .iter()
            .map(|a| {
                // The `<home>/.claude` fallback is only correct for the DEFAULT account (whose
                // config_dir IS ~/.claude, sometimes stored empty). A NAMED account with an empty
                // config_dir must NOT fall back to the home identity — that would mislabel the home
                // user's email as this account's, the exact trust bug this change fixes. So pass home
                // only for the default; a named account with no usable dir resolves to None ("not
                // signed in") instead.
                let home_for = if a.is_default { home.as_deref() } else { None };
                let identity = read_oauth_identity_at(Some(Path::new(&a.config_dir)), home_for);
                let (email, organization) = match identity {
                    Some((e, o)) => (Some(e), o),
                    None => (None, None),
                };
                AccountIdentity { id: a.id.clone(), email, organization }
            })
            .collect())
    })
    .await
    .map_err(|e| format!("accounts_identities task failed: {e}"))?
}

/// Whether Claude Code has a completed sign-in for the given config dir — i.e. `claude login` wrote
/// an `oauthAccount.emailAddress` into `<config_dir>/.claude.json`. Drives the first-run setup
/// checklist's "Sign in to Claude Code" step: unlike a mere binary-presence check, this confirms the
/// user actually authenticated. `config_dir` omitted/empty → the default `~/.claude` (the first-run
/// case, before any named account exists). Never errors — an unreadable/missing file is "not signed
/// in". Note: this detects the OAuth (`claude login`) flow, which is exactly what the step runs.
///
/// `async` + `spawn_blocking`: reads `.claude.json` off the event loop. On a JoinError we default to
/// `false` ("not signed in"), the same safe fallback the sync core returns for an unreadable file.
/// The sync core lives in `claude_signed_in_sync` so the unit tests can drive it without a runtime.
#[tauri::command]
pub async fn claude_signed_in(config_dir: Option<String>) -> bool {
    tauri::async_runtime::spawn_blocking(move || claude_signed_in_sync(config_dir))
        .await
        .unwrap_or(false)
}

/// Blocking core of [`claude_signed_in`]: resolve the config dir and check for a recorded
/// `oauthAccount.emailAddress`. Kept synchronous (no Tauri runtime) so the unit tests exercise it
/// directly.
fn claude_signed_in_sync(config_dir: Option<String>) -> bool {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dir = config_dir.filter(|s| !s.is_empty()).map(PathBuf::from);
    read_oauth_identity_at(dir.as_deref(), home.as_deref()).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sparkle-accounts-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Pins the JSON keys `accounts_usage` puts on the wire. The TS boundary
    /// (`accountStore.ts` `mapUsage`) has to read exactly these — it once read
    /// snake_case (`tokens_5h`) against this camelCase struct, so every tally
    /// deserialized to `undefined` and the usage bars sat at 0 for every account.
    /// Note serde's camelCase rule leaves the digit attached: `tokens_5h` → `tokens5h`.
    #[test]
    fn account_usage_serializes_camel_case_keys() {
        let json = serde_json::to_string(&AccountUsage {
            id: "a1".to_string(),
            tokens_5h: 111,
            tokens_7d: 222,
            exhausted_until: Some(1_700_000_000),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"id":"a1","tokens5h":111,"tokens7d":222,"exhaustedUntil":1700000000}"#
        );
    }

    fn sample(id: &str, is_default: bool, config_dir: &str) -> Account {
        Account {
            id: id.to_string(),
            nickname: format!("acct-{id}"),
            config_dir: config_dir.to_string(),
            is_default,
            created_at: 1_700_000_000,
            exhausted_until: None,
        }
    }

    #[test]
    fn accounts_json_round_trip() {
        let base = unique_dir("roundtrip");
        let path = accounts_json_path(&base);

        // Absent file → empty vec.
        assert_eq!(read_accounts_at(&path).unwrap(), Vec::<Account>::new());

        let mut accounts = vec![
            sample("a1", true, "/home/me/.claude"),
            sample("b2", false, "/data/accounts/b2"),
        ];
        accounts[1].exhausted_until = Some(1_800_000_000);
        write_accounts_at(&path, &accounts).unwrap();

        // Round-trips byte-for-byte at the struct level, including the optional field.
        assert_eq!(read_accounts_at(&path).unwrap(), accounts);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn write_is_atomic_and_leaves_valid_file_with_no_temp() {
        let base = unique_dir("atomic");
        let path = accounts_json_path(&base);
        let accounts = vec![sample("a1", true, "/home/me/.claude")];

        write_accounts_at(&path, &accounts).unwrap();

        // The target is present and parses back to exactly what we wrote.
        assert_eq!(read_accounts_at(&path).unwrap(), accounts);
        // No orphan temp file left behind after a successful rename.
        assert!(
            !path.with_extension("json.tmp").exists(),
            "temp file must be renamed away, not left behind"
        );

        // An overwrite likewise yields a valid file (rename-over-existing).
        let accounts2 = vec![
            sample("a1", true, "/home/me/.claude"),
            sample("b2", false, "/data/accounts/b2"),
        ];
        write_accounts_at(&path, &accounts2).unwrap();
        assert_eq!(read_accounts_at(&path).unwrap(), accounts2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn collect_usage_records_skips_symlinked_dirs_but_counts_symlinked_files() {
        // A symlink cycle under projects/ must not drive unbounded recursion, while a
        // symlinked transcript *file* must still be counted (it's real usage).
        let base = unique_dir("symlink");
        let projects = base.join("projects");
        let real = projects.join("real");
        std::fs::create_dir_all(&real).unwrap();

        // A real transcript that SHOULD be counted (20 tokens).
        let ts = "2026-06-25T21:20:25.931Z";
        let epoch = parse_iso8601_to_epoch(ts).unwrap();
        let body = format!(
            "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"usage\":{{\"input_tokens\":10,\"output_tokens\":5,\"cache_creation_input_tokens\":2,\"cache_read_input_tokens\":3}}}}}}\n",
            ts = ts
        );
        let transcript = real.join("sess.jsonl");
        std::fs::write(&transcript, body).unwrap();

        // A self-referential symlink: projects/loop -> projects. Following it would recurse forever.
        std::os::unix::fs::symlink(&projects, projects.join("loop")).unwrap();
        // A symlinked transcript FILE (20 more tokens) — must still be tallied.
        std::os::unix::fs::symlink(&transcript, projects.join("linked.jsonl")).unwrap();

        let mut out = Vec::new();
        // cutoff 0 = stat every file in (this test is about symlink handling, not the mtime filter).
        collect_usage_records(&projects, 0, &mut out); // must terminate, ignoring the dir symlink
        let (t5, t7) = bucket_tokens(&out, epoch + 10);
        assert_eq!(t5, 40, "real transcript + symlinked transcript file both counted");
        assert_eq!(t7, 40, "dir symlink cycle skipped (no hang); file symlink counted");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn mtime_filter_drives_the_symlinked_transcript_via_its_target() {
        // The mtime pre-filter must stat a symlinked transcript through its TARGET (std::fs::metadata
        // follows symlinks) rather than the link node. We can't independently age a symlink node with
        // std, so we drive the filter through the symlink in BOTH directions: a target written "now"
        // is COUNTED under a past cutoff and SKIPPED under a far-future cutoff — proving the symlink
        // participates in the filter and that stat'ing it doesn't error.
        let base = unique_dir("mtime-symlink");
        let projects = base.join("projects").join("-tmp");
        std::fs::create_dir_all(&projects).unwrap();
        let ts = "2026-06-25T21:20:25.931Z";
        let epoch = parse_iso8601_to_epoch(ts).unwrap();
        let body = format!(
            "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"usage\":{{\"input_tokens\":10,\"output_tokens\":5,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}}}}\n",
            ts = ts
        );
        let target = projects.join("real.jsonl");
        std::fs::write(&target, body).unwrap();
        std::os::unix::fs::symlink(&target, projects.join("linked.jsonl")).unwrap();

        // Past cutoff (1970): the symlinked transcript is stat'd via its target (mtime ~ now) → counted.
        let mut out = Vec::new();
        collect_usage_records(&projects, 1, &mut out);
        let (_t5, t7) = bucket_tokens(&out, epoch + 10);
        assert_eq!(t7, 30, "target + symlink to it both counted under a past cutoff");

        // Far-future cutoff (year ~2100): now < cutoff → both the real file and the symlink are skipped.
        let mut out2 = Vec::new();
        collect_usage_records(&projects, 4_102_444_800, &mut out2);
        assert!(out2.is_empty(), "future cutoff skips the symlinked transcript via its target too");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn collect_usage_records_skips_files_older_than_cutoff() {
        // The mtime pre-filter: a recently-written transcript is INCLUDED when the cutoff is in the
        // past, and SKIPPED (never opened/parsed) when its mtime is older than the cutoff. We drive
        // both branches with the cutoff (rather than back-dating the file) since the file's mtime is
        // "now": a cutoff far in the future makes now < cutoff, exercising the skip deterministically.
        let base = unique_dir("mtime-cutoff");
        let projects = base.join("projects").join("-tmp-proj");
        std::fs::create_dir_all(&projects).unwrap();
        let ts = "2026-06-25T21:20:25.931Z";
        let body = format!(
            "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"usage\":{{\"input_tokens\":10,\"output_tokens\":5,\"cache_creation_input_tokens\":2,\"cache_read_input_tokens\":3}}}}}}\n",
            ts = ts
        );
        std::fs::write(projects.join("sess.jsonl"), body).unwrap();

        // Cutoff in the past (0) → the recent file is parsed; its 20 tokens are collected.
        let mut included = Vec::new();
        collect_usage_records(&projects, 0, &mut included);
        assert_eq!(included.len(), 1, "recent file parsed when cutoff is in the past");

        // Cutoff far in the future → the file's mtime (~now) is older than it, so it's skipped
        // WITHOUT being opened — no records collected.
        let mut skipped = Vec::new();
        collect_usage_records(&projects, i64::MAX, &mut skipped);
        assert!(skipped.is_empty(), "file older than cutoff is skipped before parsing");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn import_default_is_idempotent() {
        let base = unique_dir("import");
        let path = accounts_json_path(&base);

        let first = import_default_at(&path, "/home/me/.claude".into(), "id1".into(), 100).unwrap();
        assert!(first.is_default);
        assert_eq!(first.nickname, "Default");

        // A second import — even with a different id/config — returns the SAME record and
        // does not add a duplicate default.
        let second =
            import_default_at(&path, "/somewhere/else".into(), "id2".into(), 200).unwrap();
        assert_eq!(first, second);

        let all = read_accounts_at(&path).unwrap();
        assert_eq!(all.len(), 1, "import_default must not duplicate the default account");
        assert_eq!(all[0].id, "id1");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn window_bucketing_sums_5h_and_7d_correctly() {
        let now = 1_000_000_000;
        let records = vec![
            (now - 60, 10),                    // within 5h → both
            (now - WINDOW_5H + 5, 20),         // just inside 5h → both
            (now - WINDOW_5H - 5, 100),        // just outside 5h, inside 7d → 7d only
            (now - WINDOW_7D + 5, 1_000),      // just inside 7d → 7d only
            (now - WINDOW_7D - 5, 9_999),      // older than 7d → excluded entirely
        ];
        let (t5, t7) = bucket_tokens(&records, now);
        assert_eq!(t5, 30, "5h window = 10 + 20");
        assert_eq!(t7, 1130, "7d window = 10 + 20 + 100 + 1000 (excludes the >7d record)");
    }

    #[test]
    fn usage_for_account_scans_real_transcripts() {
        // End-to-end of the file scan: a config dir with a projects/<slug>/x.jsonl transcript.
        let base = unique_dir("usage");
        let config = base.join("acct-config");
        let slug_dir = config.join("projects").join("-tmp-proj");
        std::fs::create_dir_all(&slug_dir).unwrap();

        let recent = "2026-06-25T21:20:25.931Z"; // parsed to epoch below
        let recent_epoch = parse_iso8601_to_epoch(recent).unwrap();
        let body = format!(
            concat!(
                // A real usage line (message.usage): 10+5+2+3 = 20 tokens.
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"usage\":",
                "{{\"input_tokens\":10,\"output_tokens\":5,\"cache_creation_input_tokens\":2,",
                "\"cache_read_input_tokens\":3}}}}}}\n",
                // Malformed JSON line — must be skipped, not abort the scan.
                "{{not json at all\n",
                // A line with no usage — skipped.
                "{{\"timestamp\":\"{ts}\",\"type\":\"user\"}}\n",
            ),
            ts = recent
        );
        std::fs::write(slug_dir.join("sess.jsonl"), body).unwrap();

        let acct = sample("u1", false, config.to_str().unwrap());
        // `now` just after the transcript timestamp so it lands in both windows.
        let usage = usage_for_account(&acct, recent_epoch + 10);
        assert_eq!(usage.tokens_5h, 20);
        assert_eq!(usage.tokens_7d, 20);
        assert_eq!(usage.exhausted_until, None);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn usage_surfaces_exhausted_until_only_while_in_future() {
        let acct = Account {
            exhausted_until: Some(500),
            ..sample("e1", false, "/nonexistent")
        };
        // Reset epoch in the future → surfaced.
        assert_eq!(usage_for_account(&acct, 400).exhausted_until, Some(500));
        // Reset epoch in the past → cleared.
        assert_eq!(usage_for_account(&acct, 600).exhausted_until, None);
    }

    #[test]
    fn normalize_epoch_seconds_scales_ms_and_leaves_seconds() {
        let secs = 1_750_000_000; // ~2025, a realistic seconds epoch — must pass through unchanged
        assert_eq!(normalize_epoch_seconds(secs), secs);
        // A milliseconds epoch (~1.75e12) is scaled back to seconds…
        assert_eq!(normalize_epoch_seconds(secs * 1000), secs);
        // …and doing it again is a no-op (idempotent, so re-reads don't keep shrinking it).
        assert_eq!(normalize_epoch_seconds(normalize_epoch_seconds(secs * 1000)), secs);
        assert_eq!(normalize_epoch_seconds(0), 0);
    }

    #[test]
    fn read_migrates_legacy_ms_exhaustion_so_it_can_expire() {
        // Reproduces sparkle-ggvp: an exhaustion persisted in epoch MILLISECONDS (what the old TS
        // writer stored) is always astronomically greater than `now_secs()`, so the Rust
        // future-filter `e > now` could NEVER clear it. read_accounts_at now scales it back to
        // seconds, after which it expires normally.
        let base = unique_dir("ms-exhaustion-migrate");
        let path = accounts_json_path(&base);

        let reset_secs: i64 = 1_750_000_000; // ~2025
        let created_secs: i64 = 1_749_000_000;
        let mut acct = sample("legacy", false, "/nonexistent");
        acct.created_at = created_secs * 1000; // legacy: stored in ms
        acct.exhausted_until = Some(reset_secs * 1000); // legacy: stored in ms
        write_accounts_at(&path, std::slice::from_ref(&acct)).unwrap();

        // On read, both epoch fields are repaired to seconds.
        let read = read_accounts_at(&path).unwrap();
        assert_eq!(read[0].created_at, created_secs);
        assert_eq!(read[0].exhausted_until, Some(reset_secs));

        // Before the reset instant it's still surfaced; once `now` passes it, it clears — the exact
        // behaviour the ms unit broke.
        assert_eq!(
            usage_for_account(&read[0], reset_secs - 60).exhausted_until,
            Some(reset_secs),
            "still exhausted just before the reset"
        );
        assert_eq!(
            usage_for_account(&read[0], reset_secs + 60).exhausted_until,
            None,
            "expired exhaustion clears once now_secs passes the (migrated) reset"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn remove_refuses_to_delete_a_default_dir() {
        let base = unique_dir("remove");
        let path = accounts_json_path(&base);

        // A "default" account whose config_dir is a real dir standing in for ~/.claude,
        // and a non-default account with its own dir.
        let default_dir = base.join("real-claude");
        std::fs::create_dir_all(&default_dir).unwrap();
        let added_dir = base.join("accounts").join("added1");
        std::fs::create_dir_all(&added_dir).unwrap();

        let accounts = vec![
            sample("def", true, default_dir.to_str().unwrap()),
            sample("added1", false, added_dir.to_str().unwrap()),
        ];
        write_accounts_at(&path, &accounts).unwrap();

        // Removing the DEFAULT drops the record but must NOT delete its dir.
        remove_account_at(&path, "def").unwrap();
        assert!(default_dir.exists(), "default config dir must survive removal");
        assert_eq!(read_accounts_at(&path).unwrap().len(), 1);

        // Removing a non-default DOES delete its dir.
        remove_account_at(&path, "added1").unwrap();
        assert!(!added_dir.exists(), "non-default config dir is deleted");
        assert!(read_accounts_at(&path).unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn dir_to_remove_guards_default() {
        assert_eq!(dir_to_remove_on_remove(&sample("d", true, "/x")), None);
        assert_eq!(
            dir_to_remove_on_remove(&sample("n", false, "/x")),
            Some(PathBuf::from("/x"))
        );
    }

    #[test]
    fn add_and_set_nickname_and_mark_exhausted() {
        let base = unique_dir("add");
        let app_data = base.clone();
        let path = accounts_json_path(&base);

        let acct = add_account_at(&app_data, &path, "Work".into(), "x1".into(), 42).unwrap();
        assert!(!acct.is_default);
        assert_eq!(acct.created_at, 42);
        // The config dir was created under <app_data>/accounts/<id>/.
        assert!(account_config_dir(&app_data, "x1").is_dir());
        assert_eq!(acct.config_dir, account_config_dir(&app_data, "x1").to_string_lossy());

        set_nickname_at(&path, "x1", "Personal".into()).unwrap();
        assert_eq!(read_accounts_at(&path).unwrap()[0].nickname, "Personal");

        mark_exhausted_at(&path, "x1", 999).unwrap();
        assert_eq!(read_accounts_at(&path).unwrap()[0].exhausted_until, Some(999));

        // Operating on an unknown id is an error, not a silent no-op.
        assert!(set_nickname_at(&path, "missing", "z".into()).is_err());
        assert!(mark_exhausted_at(&path, "missing", 1).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parse_iso8601_handles_valid_and_rejects_garbage() {
        // Unix epoch.
        assert_eq!(parse_iso8601_to_epoch("1970-01-01T00:00:00.000Z"), Some(0));
        // A known instant: 2026-06-25T21:20:25Z. Verify via independent recomputation.
        let expected = days_from_civil(2026, 6, 25) * 86_400 + 21 * 3600 + 20 * 60 + 25;
        assert_eq!(parse_iso8601_to_epoch("2026-06-25T21:20:25.931Z"), Some(expected));
        // No fractional / no Z still parses.
        assert_eq!(
            parse_iso8601_to_epoch("2026-06-25T21:20:25"),
            Some(expected)
        );
        // Garbage / partial → None (defensive).
        assert_eq!(parse_iso8601_to_epoch("not-a-date"), None);
        assert_eq!(parse_iso8601_to_epoch("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_iso8601_to_epoch("2026-06-25"), None);
    }

    /// Write a `.claude.json` into `dir` with the given raw JSON body.
    fn write_claude_json(dir: &Path, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(".claude.json"), body).unwrap();
    }

    #[test]
    fn claude_signed_in_true_for_explicit_dir_with_oauth_email() {
        // The first-run setup gate's real sign-in check: an oauthAccount.emailAddress means
        // `claude login` completed. An explicit non-empty dir bypasses the HOME fallback.
        let base = unique_dir("signed-in-yes");
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#);
        assert!(claude_signed_in_sync(Some(base.to_string_lossy().into_owned())));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn claude_signed_in_false_when_no_file_or_no_email() {
        let base = unique_dir("signed-in-no");
        // Dir exists but never logged in (no .claude.json) → not signed in.
        std::fs::create_dir_all(&base).unwrap();
        assert!(!claude_signed_in_sync(Some(base.to_string_lossy().into_owned())));
        // oauthAccount present but empty email → not signed in.
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":""}}"#);
        assert!(!claude_signed_in_sync(Some(base.to_string_lossy().into_owned())));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_oauth_identity_reads_email_and_org() {
        let base = unique_dir("identity-ok");
        write_claude_json(
            &base,
            r#"{"oauthAccount":{"emailAddress":"me@example.com","organizationName":"Acme Org"},"other":1}"#,
        );
        let id = read_oauth_identity_at(Some(&base), None);
        assert_eq!(id, Some(("me@example.com".to_string(), Some("Acme Org".to_string()))));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_oauth_identity_email_present_org_absent_or_empty() {
        let base = unique_dir("identity-no-org");
        // organizationName missing entirely.
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":"solo@example.com"}}"#);
        assert_eq!(
            read_oauth_identity_at(Some(&base), None),
            Some(("solo@example.com".to_string(), None))
        );
        // organizationName present but empty → treated as None.
        write_claude_json(
            &base,
            r#"{"oauthAccount":{"emailAddress":"solo@example.com","organizationName":""}}"#,
        );
        assert_eq!(
            read_oauth_identity_at(Some(&base), None),
            Some(("solo@example.com".to_string(), None))
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_oauth_identity_missing_file_is_none() {
        // A never-logged-in account dir: exists but has no .claude.json.
        let base = unique_dir("identity-missing-file");
        assert_eq!(read_oauth_identity_at(Some(&base), None), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_oauth_identity_missing_oauth_account_is_none() {
        // .claude.json present but with no oauthAccount (e.g. logged out / fresh config).
        let base = unique_dir("identity-no-oauth");
        write_claude_json(&base, r#"{"numStartups":3,"theme":"dark"}"#);
        assert_eq!(read_oauth_identity_at(Some(&base), None), None);
        // oauthAccount present but with no emailAddress → also None.
        write_claude_json(&base, r#"{"oauthAccount":{"accountUuid":"abc"}}"#);
        assert_eq!(read_oauth_identity_at(Some(&base), None), None);
        // oauthAccount.emailAddress present but empty → None.
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":""}}"#);
        assert_eq!(read_oauth_identity_at(Some(&base), None), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_oauth_identity_unparseable_json_is_none() {
        let base = unique_dir("identity-garbage");
        write_claude_json(&base, "{not valid json at all");
        assert_eq!(read_oauth_identity_at(Some(&base), None), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_identity_config_dir_falls_back_to_home_claude() {
        // Empty / None config dir → <home>/.claude (the default account's real dir).
        let home = Path::new("/home/me");
        assert_eq!(
            resolve_identity_config_dir(None, Some(home)),
            Some(PathBuf::from("/home/me/.claude"))
        );
        assert_eq!(
            resolve_identity_config_dir(Some(Path::new("")), Some(home)),
            Some(PathBuf::from("/home/me/.claude"))
        );
        // An explicit non-empty dir wins over home.
        assert_eq!(
            resolve_identity_config_dir(Some(Path::new("/data/accounts/x")), Some(home)),
            Some(PathBuf::from("/data/accounts/x"))
        );
        // No dir and no home → None.
        assert_eq!(resolve_identity_config_dir(None, None), None);
        // GUARD: an empty config dir WITHOUT a home fallback → None (the way `accounts_identities`
        // calls it for a NAMED account: passing home = None so an empty/missing dir can't
        // mislabel the home user's identity as this account's).
        assert_eq!(resolve_identity_config_dir(Some(Path::new("")), None), None);
        assert_eq!(read_oauth_identity_at(Some(Path::new("")), None), None);
    }

    #[test]
    fn read_oauth_identity_defaults_to_home_claude_when_dir_absent() {
        // With no explicit config dir, the reader looks in <home>/.claude/.claude.json.
        let home = unique_dir("identity-home");
        write_claude_json(
            &home.join(".claude"),
            r#"{"oauthAccount":{"emailAddress":"default@example.com","organizationName":"Home Org"}}"#,
        );
        assert_eq!(
            read_oauth_identity_at(None, Some(&home)),
            Some(("default@example.com".to_string(), Some("Home Org".to_string())))
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn sum_usage_tokens_is_defensive() {
        let full = serde_json::json!({
            "input_tokens": 1, "output_tokens": 2,
            "cache_creation_input_tokens": 4, "cache_read_input_tokens": 8
        });
        assert_eq!(sum_usage_tokens(&full), 15);
        // Missing fields contribute 0; non-numeric is ignored.
        let partial = serde_json::json!({ "input_tokens": 5, "output_tokens": "oops" });
        assert_eq!(sum_usage_tokens(&partial), 5);
        assert_eq!(sum_usage_tokens(&serde_json::json!({})), 0);
    }
}

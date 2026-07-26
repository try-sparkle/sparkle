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

/// Cross-project Claude Code spend, returned by [`accounts_spend`] and rendered by the concierge
/// spend pill. `spend_today_usd` is the estimated USD value of every account's token usage in the
/// trailing 24h (`WINDOW_24H`), priced per-model from [`rate_for_model`]; the 7d figures are the
/// same over the longer window. `fallback_model_records` counts in-window records whose model was
/// unrecognized and therefore priced at the fallback rate — a nonzero value means the total leans
/// on an estimate for at least one model, never that any usage was dropped. These are *estimates*
/// (list-price valuations of Max-plan usage), not a billed amount.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpendSummary {
    pub spend_today_usd: f64,
    pub tokens_today: u64,
    pub spend_7d_usd: f64,
    pub tokens_7d: u64,
    pub fallback_model_records: u64,
}

/// The REAL authenticated Claude identity for one account, returned by
/// [`accounts_identities`]. Read from that account's own `<config_dir>/.claude.json`
/// (`oauthAccount.emailAddress` / `oauthAccount.organizationName`) — the trustworthy
/// label the badge/AccountsScreen shows, as opposed to the user-typed `nickname`.
/// `email`/`organization` are `None` for an account whose config dir has no
/// `.claude.json` yet (created but never `claude login`ed → "not signed in").
///
/// `account_uuid` is the ANTHROPIC-side account id, and it is the only field that can answer
/// "are these two registered accounts actually the same login?". Email alone cannot: two config
/// dirs can hold logins to the same account, which is exactly what happened on a real machine —
/// "DROdio Storytell" and "DROdio Gmail" both resolved to `5fb3d67c-…`, so failing over between
/// them switched to the SAME quota and re-hit the limit immediately, while the UI showed two
/// independent headroom bars. Nothing could detect it because this field wasn't read.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub id: String,
    pub email: Option<String>,
    pub organization: Option<String>,
    pub account_uuid: Option<String>,
}

/// The `oauthAccount` fields we read out of an account's `.claude.json`. A present value means
/// the account is genuinely signed in (see [`read_oauth_identity_at`]).
#[derive(Debug, PartialEq, Eq)]
pub struct OauthIdentity {
    pub email: String,
    pub organization: Option<String>,
    /// Anthropic's account id — the duplicate-login discriminator. `None` on older logins that
    /// predate the field, in which case duplicate detection falls back to email.
    pub account_uuid: Option<String>,
}

/// Trailing usage windows, in seconds. `WINDOW_24H` ("today") backs the concierge spend pill; the
/// 5h/7d pair backs the per-account near-cap tallies.
const WINDOW_5H: i64 = 5 * 60 * 60;
const WINDOW_24H: i64 = 24 * 60 * 60;
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

/// Read the four token counters Claude Code records in a `usage` object as a tuple
/// `(input, output, cache_write, cache_read)`. Defensive: any missing/non-numeric field is 0.
fn read_usage_counts(usage: &serde_json::Value) -> (u64, u64, u64, u64) {
    let g = |k: &str| usage.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
    (
        g("input_tokens"),
        g("output_tokens"),
        g("cache_creation_input_tokens"),
        g("cache_read_input_tokens"),
    )
}

/// Sum the four token counters Claude Code records in a `usage` object. Defensive:
/// any missing/non-numeric field contributes 0. The production path reads the counters SEPARATELY
/// via [`read_usage_counts`] (each is priced at its own rate); this total-sum helper is retained
/// only for the defensiveness unit test, hence `#[cfg(test)]`.
#[cfg(test)]
fn sum_usage_tokens(usage: &serde_json::Value) -> u64 {
    let (i, o, cw, cr) = read_usage_counts(usage);
    i.saturating_add(o).saturating_add(cw).saturating_add(cr)
}

// ---- per-model USD pricing (pure) --------------------------------------------------------------
//
// The spend pill needs a dollar figure, so we value each usage record at Anthropic list price by
// model. Rates mirror apps/orchestration/src/lib/aiPricing.ts (the authoritative server table) for
// input/output; cache-write / cache-read follow Anthropic's standard cache multipliers (1.25× /
// 0.10× the model's base input rate). NOTE these value *Max-plan* usage at list price — an estimate
// of what the same tokens would cost on the metered API, not a billed amount.

/// Per-model USD rate, dollars per MILLION tokens, split across the four token classes.
#[derive(Clone, Copy, Debug)]
struct ModelRate {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

// Dollars per MTok. Keep these in sync with aiPricing.ts's input/output list prices.
const RATE_HAIKU: ModelRate = ModelRate { input: 1.0, output: 5.0, cache_write: 1.25, cache_read: 0.10 };
const RATE_SONNET: ModelRate = ModelRate { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.30 };
const RATE_OPUS: ModelRate = ModelRate { input: 5.0, output: 25.0, cache_write: 6.25, cache_read: 0.50 };
/// Fallback for an UNRECOGNIZED model: priced at the mid (Sonnet) tier and flagged by
/// [`rate_for_model`] so an unknown model is surfaced (never silently dropped or zero-priced).
const RATE_FALLBACK: ModelRate = RATE_SONNET;

/// Normalize a model id to its rate-table key: strip a trailing context-variant bracket (`[1m]`,
/// the 1M-context ids Sparkle spawns) and a trailing dated suffix (`-YYYYMMDD`). Mirrors
/// aiPricing.ts `baseModelId`, plus the bracket handling. e.g. `claude-opus-4-8[1m]` and
/// `claude-haiku-4-5-20251001` both normalize to their base id.
fn base_model_id(model: &str) -> &str {
    let mut m = model;
    if let Some(idx) = m.find('[') {
        m = &m[..idx];
    }
    // Strip a trailing "-" + exactly 8 digits. Transcript input is untrusted: guard the
    // byte-boundary so a multibyte tail can't panic split_at (roborev 46151).
    if m.len() > 9 && m.is_char_boundary(m.len() - 9) {
        let (head, tail) = m.split_at(m.len() - 9);
        if tail.as_bytes()[0] == b'-' && tail[1..].bytes().all(|b| b.is_ascii_digit()) {
            return head;
        }
    }
    m
}

/// Resolve a model id to `(rate, is_fallback)`. Unknown / absent models resolve to
/// [`RATE_FALLBACK`] with `is_fallback = true`.
fn rate_for_model(model: Option<&str>) -> (ModelRate, bool) {
    match model.map(base_model_id) {
        Some("claude-haiku-4-5") => (RATE_HAIKU, false),
        // Sonnet family (4-6, 5, …) shares the mid tier.
        Some("claude-sonnet-4-6") | Some("claude-sonnet-5") => (RATE_SONNET, false),
        Some("claude-opus-4-8") => (RATE_OPUS, false),
        _ => (RATE_FALLBACK, true),
    }
}

/// One usage record: a timestamp, the model that produced it (if recorded), and the four token
/// counters kept SEPARATE (each is priced at its own rate). Replaces the old `(ts, total)` tuple so
/// the spend path can price per class while the token-tally path just sums via [`token_pairs`].
#[derive(Clone, Debug, PartialEq)]
struct SpendRecord {
    ts: i64,
    model: Option<String>,
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
}

impl SpendRecord {
    /// Total tokens across all four classes — the SPEND unit (how many tokens were processed).
    /// Correct for the spend pill, wrong for headroom: see [`SpendRecord::limit_tokens`].
    fn total_tokens(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_write)
            .saturating_add(self.cache_read)
    }

    /// Tokens that count toward a rate limit — everything EXCEPT `cache_read`.
    ///
    /// This is the near-cap tally's unit, and the split from [`SpendRecord::total_tokens`] is
    /// empirical, not stylistic. Measured across 11 real rate-limit episodes on a live machine
    /// (the 5h consumption immediately preceding each limit):
    ///
    /// | unit                        | median at limit | coefficient of variation |
    /// |-----------------------------|-----------------|--------------------------|
    /// | all four classes            |   1,068,516,810 | 0.31                     |
    /// | excluding `cache_read`      |      43,889,909 | **0.24**                 |
    ///
    /// Cache reads dominate by more than an order of magnitude and are mostly noise with respect
    /// to the limit, so including them both loosened the predictor and inflated the number into
    /// meaninglessness — which is why `DEFAULT_NEAR_CAP` had to be disabled entirely
    /// (`MAX_SAFE_INTEGER`) to stop it benching every account. Excluding them yields a figure that
    /// is both tighter and interpretable (~44M/5h for this user), so a near-cap ceiling can be
    /// learned per account instead of switched off.
    fn limit_tokens(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_write)
    }

    /// `(usd, is_fallback)` — the record's list-price USD value and whether its model was unpriced
    /// (fallback rate).
    fn cost_usd(&self) -> (f64, bool) {
        let (r, fallback) = rate_for_model(self.model.as_deref());
        let usd = self.input as f64 / 1e6 * r.input
            + self.output as f64 / 1e6 * r.output
            + self.cache_write as f64 / 1e6 * r.cache_write
            + self.cache_read as f64 / 1e6 * r.cache_read;
        (usd, fallback)
    }
}

/// Collapse spend records to `(ts, limit_tokens)` pairs — the input `bucket_tokens` expects for the
/// 5h/7d near-cap tallies, which don't care about model or per-class split.
///
/// Uses [`SpendRecord::limit_tokens`] (cache reads excluded), NOT `total_tokens`: these windows
/// exist to predict a rate limit, and cache reads make that prediction both looser and unreadable.
/// The spend path keeps `total_tokens` — counting every token processed is the right answer there.
fn token_pairs(records: &[SpendRecord]) -> Vec<(i64, u64)> {
    records.iter().map(|r| (r.ts, r.limit_tokens())).collect()
}

/// Aggregate spend records into the trailing-24h ("today") and trailing-7d spend/token totals at
/// `now`. Records older than 7d are ignored (the 7d window is a superset of today). A record priced
/// at the fallback rate (unknown model) increments `fallback_model_records` when it lands in the 7d
/// window, so the caller can tell the figure leans on an estimate.
fn spend_summary(records: &[SpendRecord], now: i64) -> SpendSummary {
    let mut spend_today = 0.0f64;
    let mut tokens_today = 0u64;
    let mut spend_7d = 0.0f64;
    let mut tokens_7d = 0u64;
    let mut fallback_model_records = 0u64;
    for r in records {
        if r.ts < now - WINDOW_7D {
            continue;
        }
        let (usd, fallback) = r.cost_usd();
        let toks = r.total_tokens();
        spend_7d += usd;
        tokens_7d = tokens_7d.saturating_add(toks);
        if fallback {
            fallback_model_records += 1;
        }
        if r.ts >= now - WINDOW_24H {
            spend_today += usd;
            tokens_today = tokens_today.saturating_add(toks);
        }
    }
    SpendSummary {
        spend_today_usd: spend_today,
        tokens_today,
        spend_7d_usd: spend_7d,
        tokens_7d,
        fallback_model_records,
    }
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

/// One memoized transcript parse: the file identity that produced `records`.
/// Transcripts are append-only, so an unchanged `(modified, len)` pair means the
/// bytes we parsed last time are still exactly the bytes on disk.
#[derive(Clone)]
struct CachedFileUsage {
    modified: SystemTime,
    len: u64,
    records: Vec<SpendRecord>,
}

type UsageCache = std::collections::HashMap<PathBuf, CachedFileUsage>;

/// Safety valve on the memo's footprint. One entry holds only the usage-bearing records of its
/// transcript (a handful of [`SpendRecord`]s), so this bound is generous; past it the memo is
/// dropped wholesale and the next scan repopulates it.
const USAGE_CACHE_MAX_FILES: usize = 20_000;

/// Process-wide memo of parsed transcripts, shared by every window's `accounts_usage` call.
/// `OnceLock` (the idiom already used for the process caches in `notes.rs` / `preflight.rs`)
/// because `HashMap::new` is not a const fn.
fn usage_cache() -> &'static std::sync::Mutex<UsageCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<UsageCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(UsageCache::new()))
}

/// The memoized records for `path`, if the file is byte-for-byte the one we parsed.
/// Pure (takes the map) so the hit/miss rules unit-test without touching the static.
fn usage_cache_lookup<'a>(
    cache: &'a UsageCache,
    path: &Path,
    modified: SystemTime,
    len: u64,
) -> Option<&'a [SpendRecord]> {
    let hit = cache.get(path)?;
    (hit.modified == modified && hit.len == len).then_some(hit.records.as_slice())
}

/// Memoize `records` for `path` under the identity it was parsed at, clearing the map first if it
/// has grown past {@link USAGE_CACHE_MAX_FILES}. Replacing by path (not inserting a new key per
/// revision) keeps an append-only transcript to ONE entry no matter how often it grows.
fn usage_cache_store(
    cache: &mut UsageCache,
    path: &Path,
    modified: SystemTime,
    len: u64,
    records: Vec<SpendRecord>,
) {
    if cache.len() >= USAGE_CACHE_MAX_FILES && !cache.contains_key(path) {
        cache.clear();
    }
    cache.insert(
        path.to_path_buf(),
        CachedFileUsage {
            modified,
            len,
            records,
        },
    );
}

/// Memoizing wrapper around {@link collect_usage_from_file}. `accounts_usage` re-walks the SAME
/// transcript tree on every call — and it sits on the agent-spawn critical path — so re-reading
/// files that have not changed since the last scan is the dominant cost: a heavy user's trailing-7d
/// transcripts run to hundreds of megabytes, which is tens of seconds of IO plus a JSON parse per
/// usage-bearing line. Keyed on the `(modified, len)` the caller already stat'ed, a repeat scan
/// costs one map lookup per file and re-parses only the transcripts actually appended to since.
///
/// Degrades to the uncached parse whenever the memo can't be trusted or reached: no stat (`meta`
/// is `None` — the caller's fail-open path) or a poisoned lock.
fn collect_usage_from_file_memoized(
    path: &Path,
    meta: Option<&std::fs::Metadata>,
    out: &mut Vec<SpendRecord>,
) {
    let Some((modified, len)) = meta.and_then(|m| m.modified().ok().map(|t| (t, m.len()))) else {
        collect_usage_from_file(path, out);
        return;
    };
    if let Ok(cache) = usage_cache().lock() {
        if let Some(records) = usage_cache_lookup(&cache, path, modified, len) {
            out.extend_from_slice(records);
            return;
        }
    }
    let mut fresh = Vec::new();
    collect_usage_from_file(path, &mut fresh);
    if let Ok(mut cache) = usage_cache().lock() {
        usage_cache_store(&mut cache, path, modified, len, fresh.clone());
    }
    out.append(&mut fresh);
}

/// Pull [`SpendRecord`]s (timestamp, model, per-class token counts) from one `.jsonl` transcript
/// into `out`. Best-effort and DEFENSIVE: a missing file, a non-JSON line, or a line missing
/// `timestamp`/`usage` is skipped rather than failing the whole scan. The `usage` object and the
/// `model` are read from `message.*` (where Claude Code records them), falling back to a top-level
/// `usage` for robustness. `model` is `None` when absent (priced at the fallback rate).
fn collect_usage_from_file(path: &Path, out: &mut Vec<SpendRecord>) {
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
        let message = v.get("message");
        let usage = message
            .and_then(|m| m.get("usage"))
            .or_else(|| v.get("usage"));
        let Some(usage) = usage else { continue };
        let (input, output, cache_write, cache_read) = read_usage_counts(usage);
        // `message.model` names the model that produced the usage; fall back to a top-level `model`.
        let model = message
            .and_then(|m| m.get("model"))
            .or_else(|| v.get("model"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let rec = SpendRecord { ts, model, input, output, cache_write, cache_read };
        if rec.total_tokens() > 0 {
            out.push(rec);
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
fn collect_usage_records(projects_root: &Path, cutoff_epoch: i64, out: &mut Vec<SpendRecord>) {
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
            // The same stat also keys the parse memo below, so an in-window file costs one stat.
            let meta = std::fs::metadata(&path).ok();
            if cutoff_epoch > 0 {
                if let Some(modified) = meta.as_ref().and_then(|m| m.modified().ok()) {
                    if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
                        if (dur.as_secs() as i64) < cutoff_epoch {
                            continue;
                        }
                    }
                }
            }
            // Memoized on that stat. Sound because these transcripts are APPEND-ONLY — the
            // writer only ever adds lines — so an unchanged (mtime, len) is an unchanged file.
            // That invariant lives outside this module; if transcripts ever gain in-place
            // rewrites, the memo key has to become a digest rather than an identity.
            collect_usage_from_file_memoized(&path, meta.as_ref(), out);
        }
    }
}

// ---- structured rate-limit events ---------------------------------------------
//
// GROUND TRUTH for "did this account actually hit its limit?". Claude Code writes a real limit
// into its own transcript as a synthetic assistant turn carrying `"error": "rate_limit"` and
// `"apiErrorStatus": 429`. That flag is authoritative in a way terminal text can never be: the
// previous detector matched free text off the PTY, which meant an agent *writing about* rate
// limiting benched a healthy account for hours (and, because the phrasing had drifted, it never
// matched a genuine limit at all). A transcript record cannot be forged by output.
//
// Attribution is free: transcripts live under each account's OWN `<config_dir>/projects/`, so the
// account that hit the limit is the one whose tree the record was found in.
//
// Reset-time parsing deliberately does NOT happen here — the message names an IANA zone
// (`America/Bogota`, `America/Los_Angeles`) and src-tauri carries no date/time crate by design.
// The raw text goes to the frontend, where `Intl.DateTimeFormat` resolves zones exactly and
// DST-correctly for free (services/rateLimitWatch.ts `parseResetInstant`).

/// How far back to look for a limit event. A Claude Max *session* window is 5h, so an event older
/// than that has necessarily reset; doubling it leaves margin for a weekly-cap message whose reset
/// is further out, while keeping the scan bounded.
const LIMIT_EVENT_LOOKBACK: i64 = 2 * WINDOW_5H;

/// A real rate-limit event observed in an account's transcripts, surfaced to the frontend.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountLimitEvent {
    /// The account whose transcripts held the record.
    pub id: String,
    /// Epoch SECONDS of the event (the transcript's UTC `timestamp`). The frontend converts to ms.
    pub at_epoch: i64,
    /// The limit message verbatim, e.g. `You've hit your session limit · resets 2:20pm
    /// (America/Bogota)`. Parsed for a reset instant on the frontend.
    pub text: String,
}

/// Pull the limit message text out of a transcript record's `message.content[]` (the synthetic
/// turn carries a single text block). Returns `None` if the record has no text block.
fn limit_event_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?.as_array()?;
    content
        .iter()
        .find(|b| b.get("type").and_then(serde_json::Value::as_str) == Some("text"))
        .and_then(|b| b.get("text"))
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Scan one transcript for `error: "rate_limit"` records at or after `since_epoch`, keeping the
/// NEWEST. Defensive throughout: an unreadable file or an unparseable line is skipped, never fatal.
fn latest_limit_event_in_file(path: &Path, since_epoch: i64) -> Option<(i64, String)> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut best: Option<(i64, String)> = None;
    for line in text.lines() {
        // Cheap substring reject before paying for a JSON parse — the overwhelming majority of
        // lines in a transcript are ordinary turns. Both spacings appear depending on the writer.
        if !line.contains("\"rate_limit\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // The discriminator. Checked on the PARSED value so the substring above can't false-positive
        // (e.g. an agent's transcript that merely quotes the string in its prose — which is exactly
        // how the old text-scraping detector went wrong).
        if v.get("error").and_then(serde_json::Value::as_str) != Some("rate_limit") {
            continue;
        }
        let Some(ts) = v
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .and_then(parse_iso8601_to_epoch)
        else {
            continue;
        };
        if ts < since_epoch {
            continue;
        }
        let Some(msg) = limit_event_text(&v) else { continue };
        if best.as_ref().is_none_or(|(bts, _)| ts > *bts) {
            best = Some((ts, msg));
        }
    }
    best
}

/// Recursively find the newest rate-limit event under `projects_root` at or after `since_epoch`.
/// Mirrors [`collect_usage_records`]'s traversal, including its symlink-cycle guard (real
/// subdirectories only) and its mtime pre-filter.
fn latest_limit_event(
    projects_root: &Path,
    since_epoch: i64,
    best: &mut Option<(i64, String)>,
) {
    let Ok(entries) = std::fs::read_dir(projects_root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            latest_limit_event(&path, since_epoch, best);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        {
            // Transcripts are append-only, so a file untouched since before the lookback cannot
            // hold an in-window event. Fail OPEN on a stat error (parse it) — missing a real limit
            // is worse than an extra read. `metadata` (not `DirEntry::metadata`) so a symlinked
            // transcript is judged by its target's mtime.
            if let Some(modified) = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok()) {
                if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
                    if (dur.as_secs() as i64) < since_epoch {
                        continue;
                    }
                }
            }
            if let Some((ts, msg)) = latest_limit_event_in_file(&path, since_epoch) {
                if best.as_ref().is_none_or(|(bts, _)| ts > *bts) {
                    *best = Some((ts, msg));
                }
            }
        }
    }
}

/// The newest rate-limit event for one account within the lookback window, or `None` if it hasn't
/// hit a limit recently.
fn limit_event_for_account(acct: &Account, now: i64) -> Option<AccountLimitEvent> {
    let root = crate::claude::claude_projects_root(Some(Path::new(&acct.config_dir)), None)?;
    let mut best = None;
    latest_limit_event(&root, now - LIMIT_EVENT_LOOKBACK, &mut best);
    best.map(|(at_epoch, text)| AccountLimitEvent { id: acct.id.clone(), at_epoch, text })
}

// ---- learned per-account ceilings ----------------------------------------------
//
// "Warn me BEFORE I hit the limit" needs a number to compare against, and Anthropic's real caps
// aren't readable. So we learn each account's ceiling from its OWN history: for every past
// rate-limit event, how much did that account consume in the 5h window leading up to it? The
// median of those samples is the ceiling.
//
// Learning per account matters — a Max 5x and a Max 20x subscription have very different caps, and
// a global constant would be wrong for at least one of them. It also self-corrects: a plan change
// shows up in later samples and the median follows it.
//
// The unit is `limit_tokens` (cache reads excluded); on measured data that choice takes the
// coefficient of variation across samples from 0.31 to 0.24, i.e. it is what makes the ceiling
// predictive enough to warn on at all.

/// How far back to learn from. Long enough to gather several limit episodes, short enough that a
/// plan change or a shift in working style ages out.
const CEILING_LEARN_WINDOW: i64 = 30 * 24 * 60 * 60;

/// Minimum samples before a learned ceiling is trusted. One limit event could be an anomaly (a
/// single enormous run); the banner should not fire off it.
const CEILING_MIN_SAMPLES: usize = 3;

/// How long a computed ceiling set is reused. Learning walks 30d of transcripts, which is far too
/// expensive to redo per poll — and a ceiling moves only as new limit events accrue.
const CEILING_CACHE_TTL: i64 = 15 * 60;

/// A learned rate-limit ceiling for one account.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountCeiling {
    pub id: String,
    /// 5h `limit_tokens` consumption observed at each past limit event, oldest first.
    pub samples: Vec<u64>,
    /// Median of `samples`, or `None` with fewer than [`CEILING_MIN_SAMPLES`] — the frontend must
    /// treat `None` as "not enough evidence to warn", never as zero.
    pub ceiling: Option<u64>,
}

/// Every rate-limit event time under `projects_root` at or after `since_epoch` (not just the
/// newest, unlike [`latest_limit_event`]) — the raw material for learning.
fn collect_limit_event_times(projects_root: &Path, since_epoch: i64, out: &mut Vec<i64>) {
    let Ok(entries) = std::fs::read_dir(projects_root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            collect_limit_event_times(&path, since_epoch, out);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        {
            if let Some(modified) = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok()) {
                if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
                    if (dur.as_secs() as i64) < since_epoch {
                        continue;
                    }
                }
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            for line in text.lines() {
                if !line.contains("\"rate_limit\"") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                if v.get("error").and_then(serde_json::Value::as_str) != Some("rate_limit") {
                    continue;
                }
                if let Some(ts) = v
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .and_then(parse_iso8601_to_epoch)
                {
                    if ts >= since_epoch {
                        out.push(ts);
                    }
                }
            }
        }
    }
}

/// Collapse raw limit-event timestamps into distinct EPISODES. A single limit produces a burst of
/// records (every in-flight request fails at once), and counting each as its own sample would
/// weight one episode dozens of times. Events within `WINDOW_5H` of the previous one are the same
/// episode. Input need not be sorted.
fn limit_episodes(mut times: Vec<i64>) -> Vec<i64> {
    times.sort_unstable();
    let mut eps: Vec<i64> = Vec::new();
    for t in times {
        if eps.last().is_none_or(|prev| t - prev > WINDOW_5H) {
            eps.push(t);
        }
    }
    eps
}

/// Sum `limit_tokens` over the 5h window ending at `at`. `records` must be sorted by `ts`.
fn consumption_before(records: &[SpendRecord], at: i64) -> u64 {
    records
        .iter()
        .filter(|r| r.ts > at - WINDOW_5H && r.ts <= at)
        .fold(0u64, |acc, r| acc.saturating_add(r.limit_tokens()))
}

/// Median of a non-empty slice. Even lengths average the two middle values.
fn median(sorted: &[u64]) -> u64 {
    let n = sorted.len();
    if n == 0 {
        return 0;
    }
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        // Average without overflowing: a + (b-a)/2.
        let (a, b) = (sorted[n / 2 - 1], sorted[n / 2]);
        a + (b - a) / 2
    }
}

/// Learn one account's ceiling by pairing each past limit episode with the consumption that
/// preceded it. Pure given the filesystem; the caching wrapper is [`ceilings_cached`].
fn ceiling_for_account(acct: &Account, now: i64) -> AccountCeiling {
    let mut samples = Vec::new();
    if let Some(root) = crate::claude::claude_projects_root(Some(Path::new(&acct.config_dir)), None)
    {
        let since = now - CEILING_LEARN_WINDOW;
        let mut times = Vec::new();
        collect_limit_event_times(&root, since, &mut times);
        let episodes = limit_episodes(times);
        if !episodes.is_empty() {
            let mut records = Vec::new();
            collect_usage_records(&root, since, &mut records);
            records.sort_by_key(|r| r.ts);
            for ep in episodes {
                let c = consumption_before(&records, ep);
                // A zero-consumption sample means we have no usage data covering that episode
                // (transcripts pruned, or the limit was inherited from another window). Including
                // it would drag the median toward zero and make the banner fire constantly.
                if c > 0 {
                    samples.push(c);
                }
            }
        }
    }
    let ceiling = if samples.len() >= CEILING_MIN_SAMPLES {
        let mut s = samples.clone();
        s.sort_unstable();
        Some(median(&s))
    } else {
        None
    };
    AccountCeiling { id: acct.id.clone(), samples, ceiling }
}

/// Cache for [`accounts_ceilings`]: `(computed_at, value)`.
type CeilingCache = Option<(i64, Vec<AccountCeiling>)>;

fn ceiling_cache() -> &'static std::sync::Mutex<CeilingCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<CeilingCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
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
    let (tokens_5h, tokens_7d) = bucket_tokens(&token_pairs(&records), now);
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
) -> Option<OauthIdentity> {
    let dir = resolve_identity_config_dir(config_dir, home)?;
    let bytes = std::fs::read(dir.join(".claude.json")).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let oauth = v.get("oauthAccount")?;
    let email = oauth
        .get("emailAddress")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let str_field = |k: &str| {
        oauth
            .get(k)
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(OauthIdentity {
        email,
        organization: str_field("organizationName"),
        account_uuid: str_field("accountUuid"),
    })
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

/// Cross-project Claude Code spend "today" (trailing 24h) plus a 7d figure — the concierge spend
/// pill's data source. Aggregates every account's transcripts, valued per-model at list price (see
/// [`spend_summary`] / [`rate_for_model`]). Distinct config dirs are deduped by resolved projects
/// root so two account records pointing at the same dir can't double-count.
///
/// `async` + `spawn_blocking`: scans every account's transcript tree (the same heavy IO as
/// `accounts_usage`), so it must stay off the Tauri event-loop thread.
#[tauri::command]
pub async fn accounts_spend(app: AppHandle) -> Result<SpendSummary, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<SpendSummary, String> {
        let accounts = read_accounts_at(&accounts_json_path(&app_data))?;
        let now = now_secs();
        let mut records = Vec::new();
        let mut seen_roots = std::collections::HashSet::new();
        for a in &accounts {
            if let Some(root) =
                crate::claude::claude_projects_root(Some(Path::new(&a.config_dir)), None)
            {
                // Dedupe: two account records with the same config dir would otherwise scan the
                // same transcripts twice and double the spend total.
                if seen_roots.insert(root.clone()) {
                    collect_usage_records(&root, now - WINDOW_7D, &mut records);
                }
            }
        }
        Ok(spend_summary(&records, now))
    })
    .await
    .map_err(|e| format!("accounts_spend task failed: {e}"))?
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
                let (email, organization, account_uuid) = match identity {
                    Some(i) => (Some(i.email), i.organization, i.account_uuid),
                    None => (None, None, None),
                };
                AccountIdentity { id: a.id.clone(), email, organization, account_uuid }
            })
            .collect())
    })
    .await
    .map_err(|e| format!("accounts_identities task failed: {e}"))?
}

/// The newest REAL rate-limit event per account, within the recent lookback window. Accounts with
/// no recent limit are omitted, so an empty vec means "nothing is rate-limited right now".
///
/// This is the sole producer of exhaustion signal. It replaces the Phase-1 path, which inferred a
/// limit from terminal text and consequently benched accounts whenever an agent discussed rate
/// limiting while never firing on a genuine limit. See [`AccountLimitEvent`].
///
/// `async` + `spawn_blocking`: walks every account's transcript tree, so it must not run on the
/// event-loop thread. The mtime pre-filter keeps the walk cheap between limits (the common case).
#[tauri::command]
pub async fn accounts_limit_events(app: AppHandle) -> Result<Vec<AccountLimitEvent>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AccountLimitEvent>, String> {
        let accounts = read_accounts_at(&accounts_json_path(&app_data))?;
        let now = now_secs();
        Ok(accounts
            .iter()
            .filter_map(|a| limit_event_for_account(a, now))
            .collect())
    })
    .await
    .map_err(|e| format!("accounts_limit_events task failed: {e}"))?
}

/// Per-account learned rate-limit ceilings (see [`AccountCeiling`]). Cached for
/// [`CEILING_CACHE_TTL`] — learning walks 30 days of transcripts, far too expensive per poll.
///
/// `async` + `spawn_blocking`: the heaviest read in this module by a wide margin.
#[tauri::command]
pub async fn accounts_ceilings(app: AppHandle) -> Result<Vec<AccountCeiling>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AccountCeiling>, String> {
        let now = now_secs();
        if let Ok(guard) = ceiling_cache().lock() {
            if let Some((at, ref v)) = *guard {
                if now - at < CEILING_CACHE_TTL {
                    return Ok(v.clone());
                }
            }
        }
        let accounts = read_accounts_at(&accounts_json_path(&app_data))?;
        let out: Vec<AccountCeiling> =
            accounts.iter().map(|a| ceiling_for_account(a, now)).collect();
        if let Ok(mut guard) = ceiling_cache().lock() {
            *guard = Some((now, out.clone()));
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("accounts_ceilings task failed: {e}"))?
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
        let (t5, t7) = bucket_tokens(&token_pairs(&out), epoch + 10);
        // 17 tokens per transcript, not 20: token_pairs uses `limit_tokens`, which excludes the
        // fixture's 3 cache_read tokens (see limit_tokens_excludes_cache_reads_while_spend_keeps_them).
        assert_eq!(t5, 34, "real transcript + symlinked transcript file both counted");
        assert_eq!(t7, 34, "dir symlink cycle skipped (no hang); file symlink counted");

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
        let (_t5, t7) = bucket_tokens(&token_pairs(&out), epoch + 10);
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

    /// A `(modified, len)` pair distinct from `base`, for the miss cases.
    /// Memo-test shorthand: a SpendRecord with only (ts, output) set — the shape the old
    /// (ts, tokens) tuple carried.
    fn rec(ts: i64, output: u64) -> SpendRecord {
        SpendRecord { ts, model: None, input: 0, output, cache_write: 0, cache_read: 0 }
    }

    /// A (modified, len) pair distinct from base, for the miss cases.
    fn shifted(base: SystemTime) -> SystemTime {
        base + std::time::Duration::from_secs(1)
    }

    #[test]
    fn usage_memo_hits_only_on_an_unchanged_file_identity() {
        let path = Path::new("/tmp/sparkle-usage-memo/a.jsonl");
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let mut cache = UsageCache::new();
        // A FULL record — model and every counter class — so a cache path that blanked any
        // field would fail here, not just totals (roborev 47050).
        let full = SpendRecord {
            ts: 100,
            model: Some("claude-opus-4-8".into()),
            input: 3,
            output: 20,
            cache_write: 7,
            cache_read: 11,
        };
        usage_cache_store(&mut cache, path, at, 42, vec![full.clone()]);

        assert_eq!(
            usage_cache_lookup(&cache, path, at, 42),
            Some([full].as_slice()),
            "same mtime + same length is the same bytes — reuse the parse"
        );
        assert!(
            usage_cache_lookup(&cache, path, shifted(at), 42).is_none(),
            "an appended-to transcript has a newer mtime — must re-parse"
        );
        assert!(
            usage_cache_lookup(&cache, path, at, 43).is_none(),
            "a different length is different bytes — must re-parse"
        );
        assert!(
            usage_cache_lookup(&cache, Path::new("/tmp/other.jsonl"), at, 42).is_none(),
            "the memo is keyed per file"
        );
    }

    #[test]
    fn usage_memo_keeps_one_entry_per_file_across_revisions() {
        // An append-only transcript is re-parsed as it grows; each parse must REPLACE its entry,
        // never accumulate one per revision (that would make the memo grow without bound on the
        // handful of transcripts actually being written to).
        let path = Path::new("/tmp/sparkle-usage-memo/grows.jsonl");
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let mut cache = UsageCache::new();
        usage_cache_store(&mut cache, path, at, 10, vec![rec(1, 5)]);
        usage_cache_store(&mut cache, path, shifted(at), 20, vec![rec(1, 5), rec(2, 7)]);

        assert_eq!(cache.len(), 1, "one entry per path, not per revision");
        assert_eq!(
            usage_cache_lookup(&cache, path, shifted(at), 20),
            Some([rec(1, 5), rec(2, 7)].as_slice()),
            "the latest parse wins"
        );
        assert!(
            usage_cache_lookup(&cache, path, at, 10).is_none(),
            "the superseded revision is gone"
        );
    }

    #[test]
    fn usage_memo_drops_everything_once_past_its_cap() {
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let mut cache = UsageCache::new();
        for i in 0..USAGE_CACHE_MAX_FILES {
            usage_cache_store(&mut cache, &PathBuf::from(format!("/t/{i}.jsonl")), at, 1, vec![]);
        }
        assert_eq!(cache.len(), USAGE_CACHE_MAX_FILES);

        usage_cache_store(&mut cache, Path::new("/t/one-too-many.jsonl"), at, 1, vec![]);
        assert_eq!(cache.len(), 1, "at the cap a NEW file clears the memo first");

        // Re-storing a path already held must NOT trip the clear — that would throw away the whole
        // memo every scan once the tree is big enough to sit at the cap.
        let mut full = UsageCache::new();
        for i in 0..USAGE_CACHE_MAX_FILES {
            usage_cache_store(&mut full, &PathBuf::from(format!("/t/{i}.jsonl")), at, 1, vec![]);
        }
        usage_cache_store(&mut full, Path::new("/t/0.jsonl"), shifted(at), 2, vec![]);
        assert_eq!(full.len(), USAGE_CACHE_MAX_FILES, "a re-parse of a known file is not growth");
    }

    #[test]
    fn memoized_scan_reuses_the_parse_instead_of_rereading() {
        // Proves the memo is actually consulted: parse a transcript, then DELETE it and rescan with
        // the stat taken while it existed. An uncached parse of a missing file yields nothing, so
        // getting the records back can only come from the memo.
        let base = unique_dir("usage-memo");
        let path = base.join("t.jsonl");
        let ts = "2026-06-25T21:20:25.931Z";
        let epoch = parse_iso8601_to_epoch(ts).unwrap();
        std::fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"usage\":{{\"input_tokens\":10,\"output_tokens\":5}}}}}}\n"
            ),
        )
        .unwrap();
        let meta = std::fs::metadata(&path).unwrap();

        let mut first = Vec::new();
        collect_usage_from_file_memoized(&path, Some(&meta), &mut first);
        assert_eq!(
            first,
            vec![SpendRecord { ts: epoch, model: None, input: 10, output: 5, cache_write: 0, cache_read: 0 }],
            "cold scan parses the file"
        );

        std::fs::remove_file(&path).unwrap();
        let mut second = Vec::new();
        collect_usage_from_file_memoized(&path, Some(&meta), &mut second);
        assert_eq!(second, first, "warm scan is served from the memo, not the disk");

        // No stat to key on (the caller's fail-open path) → parse, which now finds nothing.
        let mut unkeyed = Vec::new();
        collect_usage_from_file_memoized(&path, None, &mut unkeyed);
        assert!(unkeyed.is_empty(), "without a stat the memo is bypassed entirely");

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
        // The fixture record is input 10 + output 5 + cache_write 2 + cache_read 3. The near-cap
        // windows report 17, NOT 20 — cache reads don't count toward a rate limit and including
        // them made the tally both a worse predictor and orders of magnitude too large.
        assert_eq!(usage.tokens_5h, 17);
        assert_eq!(usage.tokens_7d, 17);
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
        assert_eq!(
            id,
            Some(OauthIdentity {
                email: "me@example.com".to_string(),
                organization: Some("Acme Org".to_string()),
                account_uuid: None,
            })
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_oauth_identity_reads_account_uuid() {
        // accountUuid is the ONLY field that can tell two registered accounts apart when both hold
        // a login to the same Anthropic account — the real-world failure this plumbing exists for.
        let base = unique_dir("identity-uuid");
        write_claude_json(
            &base,
            r#"{"oauthAccount":{"emailAddress":"me@example.com","organizationName":"Acme Org","accountUuid":"5fb3d67c-f4ed-417b-9bf2-f9156450eb73"}}"#,
        );
        assert_eq!(
            read_oauth_identity_at(Some(&base), None),
            Some(OauthIdentity {
                email: "me@example.com".to_string(),
                organization: Some("Acme Org".to_string()),
                account_uuid: Some("5fb3d67c-f4ed-417b-9bf2-f9156450eb73".to_string()),
            })
        );
        // Empty uuid is treated as absent, not as a value that could match another empty one.
        write_claude_json(
            &base,
            r#"{"oauthAccount":{"emailAddress":"me@example.com","accountUuid":""}}"#,
        );
        assert_eq!(
            read_oauth_identity_at(Some(&base), None).and_then(|i| i.account_uuid),
            None
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_oauth_identity_email_present_org_absent_or_empty() {
        let base = unique_dir("identity-no-org");
        // organizationName missing entirely.
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":"solo@example.com"}}"#);
        assert_eq!(
            read_oauth_identity_at(Some(&base), None),
            Some(OauthIdentity {
                email: "solo@example.com".to_string(),
                organization: None,
                account_uuid: None,
            })
        );
        // organizationName present but empty → treated as None.
        write_claude_json(
            &base,
            r#"{"oauthAccount":{"emailAddress":"solo@example.com","organizationName":""}}"#,
        );
        assert_eq!(
            read_oauth_identity_at(Some(&base), None),
            Some(OauthIdentity {
                email: "solo@example.com".to_string(),
                organization: None,
                account_uuid: None,
            })
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
            Some(OauthIdentity {
                email: "default@example.com".to_string(),
                organization: Some("Home Org".to_string()),
                account_uuid: None,
            })
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

    // ---- per-model spend pricing --------------------------------------------------------------

    #[test]
    fn base_model_id_strips_date_and_bracket() {
        // Dated suffix stripped.
        assert_eq!(base_model_id("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
        // Context-variant bracket stripped.
        assert_eq!(base_model_id("claude-opus-4-8[1m]"), "claude-opus-4-8");
        // Both a bracket AND (hypothetically) a date — bracket handled first.
        assert_eq!(base_model_id("claude-opus-4-8[1m]"), "claude-opus-4-8");
        // Already-base ids pass through untouched.
        assert_eq!(base_model_id("claude-opus-4-8"), "claude-opus-4-8");
        assert_eq!(base_model_id("claude-sonnet-5"), "claude-sonnet-5");
        // A trailing "-8digits" that isn't a date-shaped tail is only stripped when it's exactly
        // dash+8 digits; a short id is left alone.
        assert_eq!(base_model_id("short"), "short");
    }

    #[test]
    fn rate_for_model_maps_known_and_flags_unknown() {
        assert!(!rate_for_model(Some("claude-haiku-4-5-20251001")).1, "haiku is known");
        assert!(!rate_for_model(Some("claude-sonnet-4-6")).1, "sonnet-4-6 is known");
        assert!(!rate_for_model(Some("claude-sonnet-5")).1, "sonnet-5 shares the mid tier");
        assert!(!rate_for_model(Some("claude-opus-4-8[1m]")).1, "opus 1M variant is known");
        // Unknown model AND absent model both fall back (flagged), never dropped.
        let (fallback_rate, is_fb) = rate_for_model(Some("claude-fable-5"));
        assert!(is_fb, "an unpriced model is flagged");
        assert_eq!(fallback_rate.input, RATE_SONNET.input, "fallback is the mid (sonnet) tier");
        assert!(rate_for_model(None).1, "a record with no model is flagged too");
    }

    #[test]
    fn cost_usd_prices_each_token_class_at_its_rate() {
        // Opus: input $5, output $25, cache-write $6.25, cache-read $0.50 per MTok.
        // 1M of each class → 5 + 25 + 6.25 + 0.50 = $36.75.
        let rec = SpendRecord {
            ts: 0,
            model: Some("claude-opus-4-8".to_string()),
            input: 1_000_000,
            output: 1_000_000,
            cache_write: 1_000_000,
            cache_read: 1_000_000,
        };
        let (usd, fallback) = rec.cost_usd();
        assert!((usd - 36.75).abs() < 1e-9, "opus per-class sum, got {usd}");
        assert!(!fallback);

        // An unknown model is priced at the fallback (sonnet) rate and flagged, never $0.
        let unknown = SpendRecord { model: Some("mystery".into()), ..rec.clone() };
        let (u_usd, u_fb) = unknown.cost_usd();
        assert!(u_fb, "unknown model flagged");
        assert!(u_usd > 0.0, "unknown model still priced, not dropped");
        // sonnet: 3 + 15 + 3.75 + 0.30 = $22.05 for 1M of each class.
        assert!((u_usd - 22.05).abs() < 1e-9, "fallback priced at sonnet rate, got {u_usd}");
    }

    #[test]
    fn spend_summary_buckets_today_and_7d_and_counts_fallback() {
        let now = 1_000_000_000;
        let haiku = |ts: i64| SpendRecord {
            ts,
            model: Some("claude-haiku-4-5".to_string()),
            input: 1_000_000, // haiku input $1/MTok → $1.00 each
            output: 0,
            cache_write: 0,
            cache_read: 0,
        };
        let unknown = SpendRecord {
            ts: now - 60,
            model: Some("who-knows".to_string()),
            input: 1_000_000, // fallback (sonnet) input $3/MTok → $3.00, flagged
            output: 0,
            cache_write: 0,
            cache_read: 0,
        };
        let records = vec![
            haiku(now - 60),               // within 24h → today + 7d ($1)
            haiku(now - WINDOW_24H - 60),  // outside 24h, inside 7d → 7d only ($1)
            haiku(now - WINDOW_7D - 60),   // older than 7d → excluded entirely
            unknown,                       // within 24h, fallback-priced ($3)
        ];
        let s = spend_summary(&records, now);
        assert!((s.spend_today_usd - 4.0).abs() < 1e-9, "today = $1 haiku + $3 unknown, got {}", s.spend_today_usd);
        assert!((s.spend_7d_usd - 5.0).abs() < 1e-9, "7d = $1 + $1 + $3, got {}", s.spend_7d_usd);
        assert_eq!(s.tokens_today, 2_000_000, "today tokens = 1M haiku + 1M unknown");
        assert_eq!(s.tokens_7d, 3_000_000, "7d tokens = 3 × 1M (the >7d record excluded)");
        assert_eq!(s.fallback_model_records, 1, "exactly one in-window unknown-model record");
    }

    #[test]
    fn collect_usage_from_file_captures_model_and_separate_counters() {
        let base = unique_dir("spend-parse");
        let ts = "2026-06-25T21:20:25.931Z";
        let epoch = parse_iso8601_to_epoch(ts).unwrap();
        let body = format!(
            concat!(
                // A real usage line WITH a model and all four counters distinct.
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{",
                "\"model\":\"claude-opus-4-8\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":5,",
                "\"cache_creation_input_tokens\":2,\"cache_read_input_tokens\":3}}}}}}\n",
                // A usage line with NO model → model None, still counted.
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"usage\":",
                "{{\"input_tokens\":1,\"output_tokens\":0,\"cache_creation_input_tokens\":0,",
                "\"cache_read_input_tokens\":0}}}}}}\n",
            ),
            ts = ts
        );
        let path = base.join("sess.jsonl");
        std::fs::write(&path, body).unwrap();

        let mut out = Vec::new();
        collect_usage_from_file(&path, &mut out);
        assert_eq!(out.len(), 2, "both usage lines parsed");

        let first = &out[0];
        assert_eq!(first.ts, epoch);
        assert_eq!(first.model.as_deref(), Some("claude-opus-4-8"));
        // The four counters are kept SEPARATE (not pre-summed).
        assert_eq!((first.input, first.output, first.cache_write, first.cache_read), (10, 5, 2, 3));
        assert_eq!(first.total_tokens(), 20);

        // The model-less line: None model, priced at the flagged fallback rate.
        assert_eq!(out[1].model, None);
        assert!(out[1].cost_usd().1, "a model-less record uses the flagged fallback rate");

        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- limit tally unit ------------------------------------------------------

    #[test]
    fn limit_tokens_excludes_cache_reads_while_spend_keeps_them() {
        // The split is the whole point: cache reads are real processed tokens (spend) but swamp the
        // rate-limit signal (headroom). Measured on 11 real limit episodes, including them loosened
        // the predictor (CoV 0.24 → 0.31) and inflated the tally ~24x into meaninglessness.
        let r = SpendRecord {
            ts: 0,
            model: None,
            input: 10,
            output: 5,
            cache_write: 2,
            cache_read: 1_000,
        };
        assert_eq!(r.limit_tokens(), 17, "input + output + cache_write only");
        assert_eq!(r.total_tokens(), 1_017, "spend still counts every token processed");
        // token_pairs (which feeds the 5h/7d near-cap windows) must use the limit unit.
        assert_eq!(token_pairs(&[r]), vec![(0, 17)]);
    }

    #[test]
    fn limit_tokens_saturates_rather_than_overflowing() {
        let r = SpendRecord {
            ts: 0,
            model: None,
            input: u64::MAX,
            output: u64::MAX,
            cache_write: u64::MAX,
            cache_read: 0,
        };
        assert_eq!(r.limit_tokens(), u64::MAX);
    }

    // ---- structured rate-limit event detection ---------------------------------

    /// A real `error: "rate_limit"` transcript record, as Claude Code writes it.
    fn limit_line(ts: &str, text: &str) -> String {
        format!(
            r#"{{"type":"assistant","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"timestamp":"{ts}","message":{{"model":"<synthetic>","role":"assistant","content":[{{"type":"text","text":"{text}"}}]}}}}"#
        )
    }

    #[test]
    fn finds_the_newest_limit_event_in_a_transcript() {
        let base = unique_dir("limit-newest");
        let f = base.join("t.jsonl");
        std::fs::write(
            &f,
            format!(
                "{}\n{}\n{}\n",
                limit_line("2026-07-26T10:00:00.000Z", "resets 1pm (America/Bogota)"),
                r#"{"type":"assistant","timestamp":"2026-07-26T11:00:00.000Z","message":{"usage":{"input_tokens":5}}}"#,
                limit_line("2026-07-26T15:55:24.145Z", "You've hit your session limit \\u00b7 resets 2:20pm (America/Bogota)"),
            ),
        )
        .unwrap();
        let got = latest_limit_event_in_file(&f, 0).expect("a limit event");
        assert_eq!(got.0, parse_iso8601_to_epoch("2026-07-26T15:55:24Z").unwrap());
        assert!(got.1.contains("2:20pm (America/Bogota)"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ignores_prose_that_merely_mentions_rate_limit() {
        // THE regression guard. The Phase-1 detector benched two healthy accounts for 4h apiece
        // because an agent's own output discussed rate limiting. A transcript full of that prose
        // must yield NOTHING: the discriminator is the `error` FIELD on a parsed record, never a
        // substring — note these lines all contain the literal `"rate_limit"` and still don't match.
        let base = unique_dir("limit-prose");
        let f = base.join("t.jsonl");
        std::fs::write(
            &f,
            concat!(
                r#"{"type":"assistant","timestamp":"2026-07-26T15:00:00.000Z","message":{"content":[{"type":"text","text":"The matcher looks for \"rate_limit\" in the envelope."}]}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-07-26T15:01:00.000Z","message":{"content":[{"type":"text","text":"429 rate_limit_error — you've hit your session limit · resets 2:20pm (America/Bogota)"}]}}"#,
                "\n",
                r#"{"type":"assistant","error":"api_error","timestamp":"2026-07-26T15:02:00.000Z","message":{"content":[{"type":"text","text":"Unable to connect"}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        assert_eq!(latest_limit_event_in_file(&f, 0), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn respects_the_lookback_cutoff_and_survives_malformed_lines() {
        let base = unique_dir("limit-cutoff");
        let f = base.join("t.jsonl");
        let old_ts = "2026-07-20T00:00:00.000Z";
        std::fs::write(
            &f,
            format!(
                "not json at all\n{}\n{{\"truncated\":\n",
                limit_line(old_ts, "resets 5pm (America/Bogota)")
            ),
        )
        .unwrap();
        let old = parse_iso8601_to_epoch(old_ts).unwrap();
        // Inside the window → found (and the garbage lines don't abort the scan).
        assert!(latest_limit_event_in_file(&f, old - 60).is_some());
        // Outside the window → skipped.
        assert_eq!(latest_limit_event_in_file(&f, old + 60), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_record_without_a_text_block_is_skipped_not_fatal() {
        let base = unique_dir("limit-notext");
        let f = base.join("t.jsonl");
        std::fs::write(
            &f,
            concat!(
                r#"{"type":"assistant","error":"rate_limit","timestamp":"2026-07-26T15:00:00.000Z","message":{"content":[]}}"#,
                "\n",
                r#"{"type":"assistant","error":"rate_limit","timestamp":"2026-07-26T15:01:00.000Z"}"#,
                "\n",
            ),
        )
        .unwrap();
        assert_eq!(latest_limit_event_in_file(&f, 0), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn walks_nested_project_dirs_for_the_newest_event() {
        let base = unique_dir("limit-walk");
        let deep = base.join("proj-a").join("nested");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(
            base.join("proj-a").join("old.jsonl"),
            format!("{}\n", limit_line("2026-07-26T09:00:00.000Z", "resets 1pm (America/Bogota)")),
        )
        .unwrap();
        std::fs::write(
            deep.join("new.jsonl"),
            format!("{}\n", limit_line("2026-07-26T15:55:24.145Z", "resets 2:20pm (America/Bogota)")),
        )
        .unwrap();
        // Non-transcript files are ignored.
        std::fs::write(base.join("notes.txt"), "rate_limit everywhere").unwrap();

        let mut best = None;
        latest_limit_event(&base, 0, &mut best);
        let (ts, text) = best.expect("newest event across the tree");
        assert_eq!(ts, parse_iso8601_to_epoch("2026-07-26T15:55:24Z").unwrap());
        assert!(text.contains("2:20pm"));
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- learned ceilings ------------------------------------------------------

    #[test]
    fn limit_episodes_collapses_a_burst_into_one_sample() {
        // A single limit fails every in-flight request at once, so one episode writes many records
        // seconds apart. Counting each would weight that episode dozens of times in the median.
        // Real data: 144 records collapsed to 12 episodes.
        let burst = vec![1000, 1002, 1005, 1060, 1200];
        assert_eq!(limit_episodes(burst), vec![1000]);
        // A genuinely separate limit more than 5h later is its own episode.
        let two = vec![1000, 1005, 1000 + WINDOW_5H + 1];
        assert_eq!(limit_episodes(two), vec![1000, 1000 + WINDOW_5H + 1]);
        // Unsorted input is handled.
        assert_eq!(limit_episodes(vec![1000 + WINDOW_5H + 1, 1000]), vec![1000, 1000 + WINDOW_5H + 1]);
        assert_eq!(limit_episodes(vec![]), Vec::<i64>::new());
    }

    #[test]
    fn consumption_before_sums_only_the_preceding_5h() {
        let rec = |ts: i64, n: u64| SpendRecord {
            ts,
            model: None,
            input: n,
            output: 0,
            cache_write: 0,
            cache_read: 9_999, // must NOT be counted
        };
        let at = 100_000;
        let records = vec![
            rec(at - WINDOW_5H - 10, 1), // just outside → excluded
            rec(at - WINDOW_5H + 10, 2), // inside
            rec(at - 10, 4),             // inside
            rec(at, 8),                  // at the boundary → included
            rec(at + 10, 16),            // after the limit → excluded
        ];
        assert_eq!(consumption_before(&records, at), 2 + 4 + 8);
    }

    #[test]
    fn median_handles_odd_even_and_avoids_overflow() {
        assert_eq!(median(&[5]), 5);
        assert_eq!(median(&[1, 3, 5]), 3);
        assert_eq!(median(&[10, 20, 30, 40]), 25);
        // Averaging two near-u64::MAX values must not overflow.
        assert_eq!(median(&[u64::MAX - 2, u64::MAX]), u64::MAX - 1);
    }

    /// Build a transcript pairing each `(limit_iso, usage_iso, tokens)` into usage-then-limit, so
    /// `ceiling_for_account` can learn from it. `tokens` lands in `input_tokens`; a fixed
    /// `cache_read` rides along and must never appear in a sample.
    fn ceiling_fixture(dir: &Path, episodes: &[(&str, &str, u64)]) {
        let projects = dir.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let mut body = String::new();
        for (usage_iso, limit_iso, tokens) in episodes {
            body.push_str(&format!(
                "{{\"timestamp\":\"{usage_iso}\",\"type\":\"assistant\",\"message\":{{\"usage\":{{\"input_tokens\":{tokens},\"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":9999}}}}}}\n"
            ));
            body.push_str(&limit_line(limit_iso, "resets 9pm (America/Los_Angeles)"));
            body.push('\n');
        }
        std::fs::write(projects.join("s.jsonl"), body).unwrap();
    }

    #[test]
    fn ceiling_needs_enough_samples_before_it_is_trusted() {
        // Two episodes is not evidence; the banner must not fire off an anomaly.
        let base = unique_dir("ceiling-thin");
        ceiling_fixture(
            &base,
            &[
                ("2026-07-20T09:59:00.000Z", "2026-07-20T10:00:00.000Z", 100),
                ("2026-07-20T19:59:00.000Z", "2026-07-20T20:00:00.000Z", 100),
            ],
        );
        let now = parse_iso8601_to_epoch("2026-07-21T00:00:00.000Z").unwrap();
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now);
        assert_eq!(got.samples, vec![100, 100], "cache reads excluded from the sample");
        assert_eq!(got.ceiling, None, "below CEILING_MIN_SAMPLES → not trusted");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ceiling_is_the_median_of_consumption_at_past_limits() {
        let base = unique_dir("ceiling-median");
        // Four episodes, each >5h apart so they don't collapse, with consumption 100/300/200/400.
        ceiling_fixture(
            &base,
            &[
                ("2026-07-18T09:59:00.000Z", "2026-07-18T10:00:00.000Z", 100),
                ("2026-07-19T09:59:00.000Z", "2026-07-19T10:00:00.000Z", 300),
                ("2026-07-20T09:59:00.000Z", "2026-07-20T10:00:00.000Z", 200),
                ("2026-07-21T09:59:00.000Z", "2026-07-21T10:00:00.000Z", 400),
            ],
        );
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now);
        assert_eq!(got.samples.len(), 4);
        // sorted: 100,200,300,400 → median averages the middle pair.
        assert_eq!(got.ceiling, Some(250));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ceiling_ignores_episodes_with_no_usage_evidence() {
        // A limit with no preceding usage records (pruned transcripts, or a window inherited from
        // elsewhere) yields consumption 0. Counting it would drag the median toward zero and make
        // the banner fire permanently.
        let base = unique_dir("ceiling-zero");
        let projects = base.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let mut body = String::new();
        // Three episodes WITH usage...
        for (u, l, t) in [
            ("2026-07-18T09:59:00.000Z", "2026-07-18T10:00:00.000Z", 100u64),
            ("2026-07-19T09:59:00.000Z", "2026-07-19T10:00:00.000Z", 100),
            ("2026-07-20T09:59:00.000Z", "2026-07-20T10:00:00.000Z", 100),
        ] {
            body.push_str(&format!(
                "{{\"timestamp\":\"{u}\",\"type\":\"assistant\",\"message\":{{\"usage\":{{\"input_tokens\":{t}}}}}}}\n"
            ));
            body.push_str(&limit_line(l, "resets 9pm (America/Los_Angeles)"));
            body.push('\n');
        }
        // ...and one bare limit with nothing before it.
        body.push_str(&limit_line("2026-07-21T10:00:00.000Z", "resets 9pm (America/Los_Angeles)"));
        body.push('\n');
        std::fs::write(projects.join("s.jsonl"), body).unwrap();

        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now);
        assert_eq!(got.samples, vec![100, 100, 100], "the evidence-free episode is dropped");
        assert_eq!(got.ceiling, Some(100));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ceiling_is_none_for_an_account_that_never_hit_a_limit() {
        let base = unique_dir("ceiling-clean");
        std::fs::create_dir_all(base.join("projects")).unwrap();
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now);
        assert!(got.samples.is_empty());
        assert_eq!(got.ceiling, None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn account_ceiling_serializes_camel_case_keys() {
        let c = AccountCeiling { id: "a".into(), samples: vec![1, 2, 3], ceiling: Some(2) };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v.get("ceiling").unwrap(), 2);
        assert!(v.get("samples").is_some());
        // A null ceiling must survive as null (the frontend keys "can't warn" off it).
        let none = AccountCeiling { id: "a".into(), samples: vec![], ceiling: None };
        assert!(serde_json::to_value(&none).unwrap().get("ceiling").unwrap().is_null());
    }

    #[test]
    fn account_limit_event_serializes_camel_case_keys() {
        // Pins the wire contract the TS boundary reads (see services/rateLimitWatch LimitEvent).
        let ev = AccountLimitEvent {
            id: "ef6ce18fe79bcf53".into(),
            at_epoch: 1785095724,
            text: "You've hit your session limit · resets 2:20pm (America/Bogota)".into(),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert!(v.get("atEpoch").is_some(), "atEpoch must be camelCase on the wire");
        assert!(v.get("at_epoch").is_none());
        assert_eq!(v.get("id").unwrap(), "ef6ce18fe79bcf53");
    }
}

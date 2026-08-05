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

use std::collections::HashSet;
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
    /// added account this is `<app_data>/accounts/<id>/`.
    ///
    /// EMPTY means "export no `CLAUDE_CONFIG_DIR` at all" — the imported default account, which
    /// runs as the user's plain `claude` does (config at `$HOME/.claude.json`, transcripts under
    /// `$HOME/.claude/projects`). It is a real value, not a missing one, so every consumer must
    /// treat it as unset rather than joining onto it: see [`identity_json_path`] and
    /// `claude::claude_projects_root`. Installs predating that fix carry a literal `$HOME/.claude`
    /// here; that stays self-consistent (the spawn exports it, so Claude Code does put its config
    /// under it) and is migrated only in the one shape where doing so cannot change which Anthropic
    /// account the user runs as — see [`default_config_dir_needs_normalizing`].
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

/// Cross-project Claude Code spend, returned by [`accounts_spend`].
///
/// NOTHING IN THE UI RENDERS THIS TODAY. It backed the concierge spend pill, which was deleted:
/// this is an unbilled trailing-24h LIST-PRICE estimate that only counts UP, and it sat 8px from
/// the remaining credit balance (`me.balanceCents`, real money, counting DOWN) with both rendered
/// as "$…". See PRD/sparkle/concierge-chrome-and-credits.md. The command stays registered because
/// the transcript scan and price table below are the expensive part; a future spend surface should
/// re-add the TS binding in `services/accountStore.ts` and label the figure as an estimate.
///
/// `spend_today_usd` is the estimated USD value of every account's token usage in the
/// trailing 24h (`WINDOW_24H`), priced per-model through `spend::estimate_cost_usd` — the Spend
/// pane's table; the 7d figures are the same over the longer window. `fallback_model_records`
/// counts in-window records whose model has NO published rate: their TOKENS are counted and their
/// DOLLARS are omitted, so a nonzero value means the dollar figure is an under-statement, not an
/// estimate. (No UI surfaces it yet — bead sparkle-1m8c.) These are *estimates* (list-price
/// valuations of Max-plan usage), not a billed amount.
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

/// Trailing usage windows, in seconds. `WINDOW_24H` ("today") backs [`accounts_spend`], which no
/// UI calls since the concierge spend pill was deleted; the 5h/7d pair backs the per-account
/// near-cap tallies, which are still rendered.
const WINDOW_5H: i64 = 5 * 60 * 60;
const WINDOW_24H: i64 = 24 * 60 * 60;
const WINDOW_7D: i64 = 7 * 24 * 60 * 60;

// ---- path helpers -------------------------------------------------------------

/// `<app_data>/accounts.json` — the metadata file.
///
/// `pub(crate)` so `hooks.rs` can enumerate the registered config dirs: Claude Code plugins are
/// installed PER config tree, and an agent spawned on a non-default account resolves plugins under
/// that account's dir, not `~/.claude`.
pub(crate) fn accounts_json_path(app_data: &Path) -> PathBuf {
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
///
/// `pub(crate)` for the same reason as [`accounts_json_path`].
pub(crate) fn read_accounts_at(path: &Path) -> Result<Vec<Account>, String> {
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

/// Whether a pre-fix default record should be normalized to the empty "no override" sentinel.
///
/// True when the record is the default, points literally at `<home>/.claude`, and that directory
/// holds NO completed login.
///
/// The safety argument is entirely in that last clause: with no `oauthAccount` at
/// `<home>/.claude/.claude.json` there is no Anthropic account to switch away from, so the rewrite
/// cannot move the user between accounts. It only stops Sparkle forcing every spawn onto a config
/// path their terminal `claude` will never read.
///
/// This deliberately does NOT also require a login at `<home>/.claude.json`. An earlier version did,
/// reasoning that with neither file holding a login there was nothing to migrate to — but that
/// leaves the record exporting `CLAUDE_CONFIG_DIR=$HOME/.claude`, so the user's very next sign-in
/// (through Sparkle or the login modal) lands in `$HOME/.claude/.claude.json` and forks from their
/// terminal login right then. That is the trap this exists to close, merely deferred; a fresh
/// install with no login anywhere is the most common way to walk into it.
///
/// A `<home>/.claude` that DOES hold a login is still left alone: it is self-consistent — the spawn
/// exports it, so Claude Code really does keep its config there — and migrating it would silently
/// move the user onto a different Anthropic account.
fn default_config_dir_needs_normalizing(acct: &Account, home: Option<&Path>) -> bool {
    let Some(home) = home else { return false };
    if !acct.is_default || Path::new(&acct.config_dir) != home.join(".claude") {
        return false;
    }
    read_oauth_identity_at(Some(Path::new(&acct.config_dir)), None).is_none()
}

/// Apply [`default_config_dir_needs_normalizing`], rewriting the record to `effective` — the value
/// a spawn will actually see (see `claude::effective_spawn_config_dir`), which is usually "" but is
/// the user's own path when their login shell exports one.
///
/// Returns whether a record was rewritten. Persists only on a real change, so a user whose login
/// shell happens to export `$HOME/.claude` doesn't get a redundant write on every app start.
fn normalize_default_config_dir_at(
    accounts_path: &Path,
    home: Option<&Path>,
    effective: &str,
) -> Result<bool, String> {
    let mut accounts = read_accounts_at(accounts_path)?;
    let Some(acct) = accounts
        .iter_mut()
        .find(|a| default_config_dir_needs_normalizing(a, home))
    else {
        return Ok(false);
    };
    if acct.config_dir == effective {
        return Ok(false);
    }
    acct.config_dir = effective.to_string();
    write_accounts_at(accounts_path, &accounts)?;
    Ok(true)
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
/// `(input, output, cache_write_5m, cache_write_1h, cache_read)`. Defensive: any missing or
/// non-numeric field is 0.
fn read_usage_counts(usage: &serde_json::Value) -> (u64, u64, u64, u64, u64) {
    let g = |k: &str| usage.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
    // The TTL split comes from `spend::cache_write_split`, not a copy of it: 1h writes bill at 2x
    // input and 5m at 1.25x, so a second implementation here is a second chance to diverge from the
    // pane — which is what reading only the flat `cache_creation_input_tokens` did.
    let (cache_5m, cache_1h) = crate::spend::cache_write_split(usage);
    (g("input_tokens"), g("output_tokens"), cache_5m, cache_1h, g("cache_read_input_tokens"))
}

/// Sum the four token counters Claude Code records in a `usage` object. Defensive:
/// any missing/non-numeric field contributes 0. The production path reads the counters SEPARATELY
/// via [`read_usage_counts`] (each is priced at its own rate); this total-sum helper is retained
/// only for the defensiveness unit test, hence `#[cfg(test)]`.
#[cfg(test)]
fn sum_usage_tokens(usage: &serde_json::Value) -> u64 {
    let (i, o, cw5, cw1h, cr) = read_usage_counts(usage);
    i.saturating_add(o).saturating_add(cw5).saturating_add(cw1h).saturating_add(cr)
}

// ---- per-model USD pricing (pure) --------------------------------------------------------------
//
// [`accounts_spend`] reports a dollar figure, so we value each usage record at Anthropic list price
// by model — through `spend::estimate_cost_usd`, NOT a table of our own. (The pill this originally
// fed is gone and no UI calls the command today; see [`SpendSummary`]. References to "the pill"
// below are the historical consumer, kept because they explain WHY these bugs were fixed this way.)
// This module used to carry
// one (four models, everything else priced at the Sonnet rate), which is how the same day's
// transcripts came out 5x low in the pill for `claude-opus-4-*`, ~40% low for `claude-opus-4-5-*`,
// and with an invented price for models the pane honestly reported as unpriced. NOTE these value
// *Max-plan* usage at list price — an estimate of what the same tokens would cost on the metered
// API, not a billed amount.

/// One usage record: a timestamp, the model that produced it (if recorded), and the four token
/// counters kept SEPARATE (each is priced at its own rate). Replaces the old `(ts, total)` tuple so
/// the spend path can price per class while the token-tally path just sums via [`token_pairs`].
#[derive(Clone, Debug, PartialEq)]
struct SpendRecord {
    ts: i64,
    /// `message.id`, when the line carries one — the resume-dedup key. See
    /// [`dedupe_by_message_id`].
    message_id: Option<String>,
    model: Option<String>,
    input: u64,
    output: u64,
    /// Cache WRITES, split by TTL because they bill differently (1.25x vs 2x input).
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
}

impl SpendRecord {
    /// Total tokens across all four classes — the SPEND unit (how many tokens were processed).
    /// Correct for the spend pill, wrong for headroom: see [`SpendRecord::limit_tokens`].
    fn total_tokens(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_write_5m)
            .saturating_add(self.cache_write_1h)
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
    ///
    /// Both cache-WRITE TTLs count: they differ in price, not in whether they consumed the limit.
    fn limit_tokens(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_write_5m)
            .saturating_add(self.cache_write_1h)
    }

    /// The record's list-price USD value, or `None` when its model has no published rate.
    ///
    /// Priced through `spend::estimate_cost_usd` — the SAME table the Spend pane and the published
    /// Builder Index row use. This module used to carry its own four-model table with a Sonnet
    /// fallback, which valued `claude-opus-4-*` at a fifth of the pane's figure and gave unknown
    /// models an invented Sonnet price, so the app showed three different dollar amounts for one
    /// day's transcripts. `None` (rather than a guess) is why the pill can say the total EXCLUDES
    /// something instead of quietly understating it.
    ///
    fn cost_usd(&self) -> Option<f64> {
        crate::spend::estimate_cost_usd(
            self.model.as_deref()?,
            self.input,
            self.output,
            self.cache_write_5m,
            self.cache_write_1h,
            self.cache_read,
        )
    }
}

/// Collapse spend records to `(ts, limit_tokens)` pairs — the input `bucket_tokens` expects for the
/// 5h/7d near-cap tallies, which don't care about model or per-class split.
///
/// Uses [`SpendRecord::limit_tokens`] (cache reads excluded), NOT `total_tokens`: these windows
/// exist to predict a rate limit, and cache reads make that prediction both looser and unreadable.
/// The spend path keeps `total_tokens` — counting every token processed is the right answer there.
///
/// Takes an ITERATOR, not a slice, so it can be fed the borrowed output of
/// [`dedupe_by_message_id`] without cloning every record into a flat vec first.
fn token_pairs<'a>(records: impl IntoIterator<Item = &'a SpendRecord>) -> Vec<(i64, u64)> {
    records
        .into_iter()
        .map(|r| (r.ts, r.limit_tokens()))
        .collect()
}

/// Window, then drop the duplicate copies a RESUME makes: `claude --resume` copies prior turns into
/// the new transcript, so the same `message.id` appears in several files under the same root.
///
/// **Every consumer of a `SpendRecord` vector goes through this — there is exactly one copy of the
/// rule on purpose.** It was originally wired into [`spend_summary`] alone, and the two LIMIT
/// surfaces ([`usage_for_account`]'s 5h/7d tallies and [`ceiling_for_account`] via
/// [`consumption_before`]) consumed the same vector raw, so a resumed session's copied turns were
/// counted twice in exactly the tallies that decide when the user gets throttled: the cost pill read
/// correctly while the limit read high, and the user was benched early against usage they never
/// spent. A third divergent copy is how that happened; keep it at one.
///
/// Last copy wins IN INPUT ORDER, matching `spend::dedupe_window`. That makes the result
/// order-dependent, which is why every caller must hand records over in the SAME order — the
/// deterministic oldest-mtime-first order `collect_usage_records_across` produces. (Copies of one
/// turn carry identical token counts, so the choice does not move a tally today; it would the moment
/// one surface sorted and another didn't.)
///
/// Records with no id can't be matched and are all kept (the same accepted limit the pane has).
///
/// `first_ts`/`now` are INCLUSIVE bounds.
fn dedupe_by_message_id(records: &[SpendRecord], first_ts: i64, now: i64) -> Vec<&SpendRecord> {
    let mut position: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    let mut chosen: Vec<&SpendRecord> = Vec::new();
    for r in records {
        // Window FIRST, then dedupe — the order `spend::dedupe_window` uses, and it decides
        // contested cases. Deduping first let an out-of-window resume copy win the id and then be
        // filtered away, silently dropping the in-window turn entirely. The upper bound matters
        // too: a clock-skewed transcript otherwise counts here and not in the pane.
        if r.ts < first_ts || r.ts > now {
            continue;
        }
        match r.message_id.as_deref() {
            None => chosen.push(r),
            Some(id) => match position.get(id) {
                Some(&i) => chosen[i] = r,
                None => {
                    position.insert(id, chosen.len());
                    chosen.push(r);
                }
            },
        }
    }
    chosen
}

/// Aggregate spend records into the trailing-24h ("today") and trailing-7d spend/token totals at
/// `now`. Records outside the 7d window are ignored (it is a superset of today). A record whose
/// model has NO published price increments `fallback_model_records`: its tokens are counted and its
/// dollars are omitted — the totals under-state rather than lean on an invented rate, which is the
/// pane's stance and the one the published leaderboard row uses.
fn spend_summary(records: &[SpendRecord], now: i64) -> SpendSummary {
    let mut spend_today = 0.0f64;
    let mut tokens_today = 0u64;
    let mut spend_7d = 0.0f64;
    let mut tokens_7d = 0u64;
    let mut fallback_model_records = 0u64;
    for r in dedupe_by_message_id(records, now - WINDOW_7D, now) {
        let toks = r.total_tokens();
        tokens_7d = tokens_7d.saturating_add(toks);
        match r.cost_usd() {
            Some(usd) => {
                spend_7d += usd;
                if r.ts >= now - WINDOW_24H {
                    spend_today += usd;
                }
            }
            // Tokens still count; the DOLLARS can't, because we have no rate. Surfaced through
            // `fallback_model_records` rather than valued at a guessed rate.
            None => fallback_model_records += 1,
        }
        if r.ts >= now - WINDOW_24H {
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
    /// The SCAN GENERATION that last used this entry (stored or hit). Drives eviction — see
    /// [`usage_cache_store`]. A generation, not a timestamp: within one pass every entry is "recent",
    /// so a plain LRU under a cyclic scan evicts the files this pass visited FIRST and the next pass
    /// starts at exactly those — the classic 0%-hit-rate case. `mtime` stays the validity key and
    /// says nothing about usefulness: an old-mtime transcript is append-only and settled, so it hits
    /// forever, while the newest file is the one about to be appended to and invalidated anyway —
    /// which is also why the hard-cap tier evicts NEWEST-mtime first. See
    /// [`crate::spend::evict_two_tier`], the policy both transcript memos share.
    last_touch: u64,
}

/// The ceiling enforced at the END of every pass, live pass or not — `spend::evict_two_tier`'s
/// tier 2. A single pass can transiently exceed it while it runs.
const USAGE_CACHE_HARD_CAP: usize = 2 * USAGE_CACHE_MAX_FILES;

type UsageCache = std::collections::HashMap<PathBuf, CachedFileUsage>;

/// Monotonic scan counter, so "used by the pass that is running" is a comparison rather than a
/// clock read. Mirrors `spend.rs`'s memo generation.
struct UsagePass(u64);

impl UsagePass {
    /// Monotonic, and LIVE until this value drops. RAII rather than a mint/retire pair so a panic
    /// between them cannot leak the generation into the live set — every entry stamped with it
    /// would then be exempt from tier-1 eviction forever, and this memo has no stale sweep to heal
    /// it.
    fn start() -> Self {
        static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let g = GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        live_usage_passes()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(g);
        Self(g)
    }

    fn id(&self) -> u64 {
        self.0
    }
}

impl Drop for UsagePass {
    fn drop(&mut self) {
        live_usage_passes()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// Working-set target for the memo. One entry holds only the usage-bearing records of its
/// transcript (a handful of [`SpendRecord`]s), so this is generous. It is a TARGET, not the bound:
/// a pass may exceed it while its own entries are exempt from eviction — [`USAGE_CACHE_HARD_CAP`]
/// is what actually bounds the footprint. See [`crate::spend::evict_two_tier`].
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
    cache: &'a mut UsageCache,
    path: &Path,
    modified: SystemTime,
    len: u64,
    generation: u64,
) -> Option<&'a [SpendRecord]> {
    let hit = cache.get_mut(path)?;
    if hit.modified != modified || hit.len != len {
        return None;
    }
    // A hit is a USE, and it also marks the entry as belonging to the running pass — which is what
    // keeps eviction from throwing away the working set mid-scan.
    hit.last_touch = generation;
    Some(hit.records.as_slice())
}

/// Memoize `records` for `path` under the identity it was parsed at. STORE-ONLY by design: eviction
/// happens once per pass in [`finish_usage_pass`], because mid-walk "this pass hasn't touched it"
/// means "hasn't REACHED it yet". Replacing by path (not inserting a new key per revision) keeps an
/// append-only transcript to ONE entry no matter how often it grows.
fn usage_cache_store(
    cache: &mut UsageCache,
    path: &Path,
    modified: SystemTime,
    len: u64,
    records: Vec<SpendRecord>,
    generation: u64,
) {
    cache.insert(
        path.to_path_buf(),
        CachedFileUsage {
            modified,
            len,
            records,
            last_touch: generation,
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
/// `generation` marks every entry this pass touches, so eviction can leave the working set alone —
/// see [`evict_usage_cache`].
///
/// Degrades to the uncached parse whenever the memo can't be trusted or reached: no stat (`meta`
/// is `None` — the caller's fail-open path) or a poisoned lock.
fn collect_usage_from_file_memoized(
    path: &Path,
    meta: Option<&std::fs::Metadata>,
    out: &mut Vec<SpendRecord>,
    generation: u64,
) {
    let Some((modified, len)) = meta.and_then(|m| m.modified().ok().map(|t| (t, m.len()))) else {
        collect_usage_from_file(path, out);
        return;
    };
    if let Ok(mut cache) = usage_cache().lock() {
        if let Some(records) = usage_cache_lookup(&mut cache, path, modified, len, generation) {
            out.extend_from_slice(records);
            return;
        }
    }
    let mut fresh = Vec::new();
    collect_usage_from_file(path, &mut fresh);
    if let Ok(mut cache) = usage_cache().lock() {
        usage_cache_store(&mut cache, path, modified, len, fresh.clone(), generation);
    }
    out.append(&mut fresh);
}

/// Pull [`SpendRecord`]s (timestamp, model, per-class token counts) from one `.jsonl` transcript
/// into `out`. Best-effort and DEFENSIVE: a missing file, a non-JSON line, or a line missing
/// `timestamp`/`usage` is skipped rather than failing the whole scan. The `usage` object and the
/// `model` are read from `message.*` (where Claude Code records them), falling back to a top-level
/// `usage` for robustness. `model` is `None` when absent — no published rate, so its tokens are
/// counted and its dollars omitted.
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
        let (input, output, cache_write_5m, cache_write_1h, cache_read) = read_usage_counts(usage);
        // `message.model` names the model that produced the usage; fall back to a top-level `model`.
        let model = message
            .and_then(|m| m.get("model"))
            .or_else(|| v.get("model"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let message_id = message
            .and_then(|m| m.get("id"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let rec = SpendRecord {
            ts,
            message_id,
            model,
            input,
            output,
            cache_write_5m,
            cache_write_1h,
            cache_read,
        };
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
///
/// Single-root convenience: one root, one pass, eviction at the end. Production callers go through
/// [`collect_usage_records_across`] with a generation that spans every root of their pass, so this
/// is `#[cfg(test)]` — a per-root pass boundary is exactly the bug `finish_usage_pass` documents.
#[cfg(test)]
fn collect_usage_records(projects_root: &Path, cutoff_epoch: i64, out: &mut Vec<SpendRecord>) {
    let pass = UsagePass::start();
    let touched = collect_usage_records_across(
        std::slice::from_ref(&projects_root.to_path_buf()),
        cutoff_epoch,
        out,
        pass.id(),
    );
    finish_usage_pass(pass, touched > 0);
}

/// Walk EVERY root, then parse oldest-mtime first (ties by path) across all of them, with the memo
/// `generation` handed in.
///
/// Both halves matter. The ORDER is `spend::load_records`' order, and it is the reason its "last
/// copy of an id wins" rule means "attributed to the newer transcript": parsing in `read_dir` order
/// left that winner inode-dependent, so the pill's totals could differ run-to-run on one tree.
/// Sorting per ROOT wasn't enough either — that yields "root order, then mtime", so an id contested
/// ACROSS roots still resolved differently here than in the pane, which sorts the whole set.
///
/// One `generation` for the whole pass, across every root: eviction must not treat the roots as
/// separate scans, or it throws away the working set mid-pass.
/// Returns how many FILES this walk touched, which is what `touched_any` needs to mean: a machine
/// with accounts configured but no `projects/` dir under any of them has a non-empty account list
/// and reads nothing, and evicting on behalf of that pass trims the memo for nobody.
fn collect_usage_records_across(
    roots: &[PathBuf],
    cutoff_epoch: i64,
    out: &mut Vec<SpendRecord>,
    generation: u64,
) -> usize {
    // Two roots can OVERLAP without being identical — one nested under the other — and the
    // canonical-key set only catches identical trees. The same transcript would then be parsed
    // twice and its id-less records counted twice. Deduped on the PATH as the walk goes, not by
    // adjacency after the sort: each root's walk takes its own `metadata`, so a transcript appended
    // to between two walks gets two different mtimes, lands non-adjacent, and slips through — and
    // the file most likely to be appended mid-walk is the active session's.
    let mut files: Vec<(PathBuf, Option<std::fs::Metadata>, SystemTime)> = Vec::new();
    // Keyed on the CANONICAL path, like every other overlap guard on this path. Two roots can reach
    // one file by different spellings — `~/.claude/projects` and an account `projects/` symlinked
    // to it survive `order_roots` as distinct roots, and `order_roots`' own doc names that shape as
    // one that occurs — so a raw-path set would let the same transcript through twice. The RAW path
    // is what goes into `files`, so the memo key and the walk still agree.
    // Skipped entirely for a single root: `canonical_key` is an `fs::canonicalize` per file, and
    // with one root a cross-root duplicate cannot exist. `usage_for_account` always passes exactly
    // one root, on the agent-spawn critical path over the largest tree in the install.
    let single = roots.len() < 2;
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for root in roots {
        let mut found = Vec::new();
        collect_usage_files(root, cutoff_epoch, &mut found);
        if single {
            files.append(&mut found);
            continue;
        }
        // Only ACROSS roots. A file reached from a previous root is dropped; duplicates WITHIN one
        // root are left alone, because a transcript symlinked into a second project under the same
        // root is long-standing counted behavior with its own tests — changing that is a separate
        // decision from closing the root-overlap hole.
        let keys: Vec<PathBuf> =
            found.iter().map(|(p, _, _)| crate::spend::canonical_key(p)).collect();
        files.extend(
            found
                .into_iter()
                .zip(keys.iter())
                .filter(|(_, key)| !seen.contains(*key))
                .map(|(f, _)| f),
        );
        seen.extend(keys);
    }
    files.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.cmp(&b.0)));
    for (path, meta, _) in &files {
        // Memoized on the stat taken during the walk. Sound because these transcripts are
        // APPEND-ONLY — the writer only ever adds lines — so an unchanged (mtime, len) is an
        // unchanged file. That invariant lives outside this module; if transcripts ever gain
        // in-place rewrites, the memo key has to become a digest rather than an identity.
        collect_usage_from_file_memoized(path, meta.as_ref(), out, generation);
    }
    files.len()
}

/// Trim the memo at the end of a PASS. Call once per command, after every root of that pass has
/// been walked — never per root or per account.
///
/// `accounts_usage` maps over accounts, and each account used to mint its own generation and evict
/// at the end of its own walk against the PROCESS-WIDE memo: account 1's eviction saw accounts
/// 2..N's entries as another generation's and trimmed them, account 2 re-parsed what was just
/// dropped and evicted account 1's, and so on. That caller sits on the agent-spawn critical path.
///
/// `touched_any` skips the work for a pass that read nothing (no accounts, or every `config_dir`
/// resolving to no projects root): evicting on behalf of a pass that opened no files would trim the
/// memo for nobody's benefit.
///
/// The policy is [`crate::spend::evict_two_tier`] — ONE implementation for both transcript memos,
/// which had already drifted into documenting opposite rationales for the same tier.
fn finish_usage_pass(pass: UsagePass, touched_any: bool) {
    if touched_any {
        if let Ok(mut cache) = usage_cache().lock() {
            crate::spend::evict_two_tier(
                &mut cache,
                USAGE_CACHE_MAX_FILES,
                USAGE_CACHE_HARD_CAP,
                |g| {
                    g != pass.id()
                        && live_usage_passes()
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .contains(&g)
                },
                |c| (c.last_touch, c.modified),
            );
        }
    }
    // `pass` drops here, clearing itself from the live set. Note the `is_live` closure above
    // excludes THIS pass explicitly: its entries are the ones being trimmed against, and it is
    // still registered while the closure runs.
}

/// The usage-scan generations currently RUNNING — tier 1 of the eviction never touches their
/// entries. Commands OVERLAP (`accounts_usage` and `accounts_spend` are separate `spawn_blocking`
/// tasks over one process-wide memo), so "not my generation" is not the same as "nobody wants it":
/// whichever finished first used to trim the other's working set out from under it.
fn live_usage_passes() -> &'static std::sync::Mutex<HashSet<u64>> {
    static LIVE: std::sync::OnceLock<std::sync::Mutex<HashSet<u64>>> = std::sync::OnceLock::new();
    LIVE.get_or_init(|| std::sync::Mutex::new(HashSet::new()))
}

/// The walk half of [`collect_usage_records_across`]: every in-window `.jsonl` under `root`, with the stat
/// that both filtered it and keys the memo, plus its mtime as the sort key.
fn collect_usage_files(
    root: &Path,
    cutoff_epoch: i64,
    out: &mut Vec<(PathBuf, Option<std::fs::Metadata>, SystemTime)>,
) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            collect_usage_files(&path, cutoff_epoch, out);
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
            let modified = meta.as_ref().and_then(|m| m.modified().ok());
            if cutoff_epoch > 0 {
                if let Some(modified) = modified {
                    if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
                        if (dur.as_secs() as i64) < cutoff_epoch {
                            continue;
                        }
                    }
                }
            }
            // Unreadable mtime sorts oldest — it already failed OPEN into the window above, and an
            // arbitrary-but-fixed position keeps the order deterministic.
            out.push((path, meta, modified.unwrap_or(UNIX_EPOCH)));
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

/// The transcript root for one account, resolved the SAME way session detection does.
///
/// Passing `$HOME` matters: the default account stores an EMPTY `config_dir` (see
/// [`Account::config_dir`]), and without a home to fall back on that resolves to `None` — the
/// account would report no transcripts at all, hence zero usage, no learned ceiling, and no
/// rate-limit events, while its sessions pile up under `$HOME/.claude/projects`.
fn projects_root_for_account(acct: &Account) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    crate::claude::claude_projects_root(Some(Path::new(&acct.config_dir)), home.as_deref())
}

/// The newest rate-limit event for one account within the lookback window, or `None` if it hasn't
/// hit a limit recently.
fn limit_event_for_account(acct: &Account, now: i64) -> Option<AccountLimitEvent> {
    let root = projects_root_for_account(acct)?;
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

/// Sum `limit_tokens` over the 5h window ending at `at`, counting a resumed session's copied turns
/// ONCE — through the same [`dedupe_by_message_id`] gate the pill and the 5h/7d tallies use.
///
/// Without the dedupe every learned ceiling sample was inflated by whatever the account's resumes
/// had copied forward, so the median ceiling — the number the near-cap banner fires against — sat
/// above the real limit.
///
/// The window is `[at - WINDOW_5H, at]`, inclusive at BOTH ends, which is `bucket_tokens`' 5h
/// boundary. It used to be exclusive at the low end: a one-second disagreement between the tally
/// that shows headroom and the sample that learns the cap, with no reason behind it.
///
/// `records` need not be sorted (this is a full scan), and must NOT be pre-sorted: the dedupe is
/// last-copy-wins on input order, so every surface has to see the collection order.
fn consumption_before(records: &[SpendRecord], at: i64) -> u64 {
    dedupe_by_message_id(records, at - WINDOW_5H, at)
        .into_iter()
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
    if let Some(root) = projects_root_for_account(acct) {
        let since = now - CEILING_LEARN_WINDOW;
        let mut times = Vec::new();
        collect_limit_event_times(&root, since, &mut times);
        let episodes = limit_episodes(times);
        if !episodes.is_empty() {
            let mut records = Vec::new();
            // Its OWN pass, not a bare walk: this runs from `accounts_ceilings`, which is a
            // separate `spawn_blocking` task from `accounts_usage`/`accounts_spend` over the same
            // process-wide memo. Registering the pass is what keeps a concurrent scan from evicting
            // this one's working set mid-walk (see `finish_usage_pass` / `live_usage_passes`).
            let pass = UsagePass::start();
            let touched = collect_usage_records_across(
                std::slice::from_ref(&root),
                since,
                &mut records,
                pass.id(),
            );
            finish_usage_pass(pass, touched > 0);
            // NOT sorted by ts: `consumption_before` is a full scan that doesn't need it, and its
            // resume dedupe is last-copy-wins on INPUT order. Sorting here would have handed this
            // surface a different order than the pill and the 5h/7d tallies see, which is a fresh
            // way for the three to disagree about one turn. Collection order everywhere.
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
/// Usage for EVERY account in one pass: one generation across all of them, eviction once at the
/// end. Extracted from the command body so the invariant is testable — inlined there, reverting to
/// a generation per account left every test green while restoring the memo thrash.
fn usage_for_accounts(accounts: &[Account], now: i64) -> Vec<AccountUsage> {
    let pass = UsagePass::start();
    let mut touched = 0usize;
    let usage: Vec<AccountUsage> = accounts
        .iter()
        .map(|a| {
            let (u, n) = usage_for_account(a, now, pass.id());
            touched += n;
            u
        })
        .collect();
    finish_usage_pass(pass, touched > 0);
    usage
}

fn usage_for_account(acct: &Account, now: i64, generation: u64) -> (AccountUsage, usize) {
    let mut records = Vec::new();
    let mut touched = 0usize;
    // Through the shared resolver, which passes `$HOME`: the DEFAULT account stores an empty
    // config_dir, and without that fallback it resolves to None and reports zero usage while its
    // sessions pile up under `$HOME/.claude/projects`.
    if let Some(root) = projects_root_for_account(acct) {
        // Only files touched within the trailing 7d window can hold in-window records; older ones
        // are skipped by mtime before we open them (see `collect_usage_files`).
        //
        // The caller's `generation` — every account in one `accounts_usage` call is ONE pass over
        // the shared memo, and eviction happens after the last of them (`finish_usage_pass`).
        touched = collect_usage_records_across(
            std::slice::from_ref(&root),
            now - WINDOW_7D,
            &mut records,
            generation,
        );
    }
    // Through the SHARED resume dedupe, on the same window the spend pill uses, before bucketing:
    // a resumed session copies its earlier turns into the new transcript, and counting those twice
    // inflates the very tallies that throttle the user (see `dedupe_by_message_id`). Deduped ONCE
    // over the 7d window and then split into 5h/7d, so the two windows can't pick different copies
    // of one turn — the same shape `spend_summary` uses for today/7d.
    let (tokens_5h, tokens_7d) =
        bucket_tokens(&token_pairs(dedupe_by_message_id(&records, now - WINDOW_7D, now)), now);
    (
        AccountUsage {
            id: acct.id.clone(),
            tokens_5h,
            tokens_7d,
            exhausted_until: acct.exhausted_until.filter(|&e| e > now),
        },
        touched,
    )
}

// ---- real OAuth identity (pure) -----------------------------------------------

/// The `.claude.json` file Claude Code actually reads for a given account.
///
/// Claude Code keeps that file in one of TWO places, and they are not the same directory:
///
/// * `CLAUDE_CONFIG_DIR=<dir>` set → `<dir>/.claude.json`
/// * the variable UNSET          → `$HOME/.claude.json` — **not** `$HOME/.claude/.claude.json`
///
/// `$HOME/.claude` is the state directory (`projects/`, `settings.json`, …), which is exactly why
/// the two get conflated. Verified against claude 2.1.220: `claude mcp add --scope user` writes
/// `$HOME/.claude.json` with the variable unset and `<dir>/.claude.json` with it set.
///
/// Getting this wrong is not cosmetic. Reading `$HOME/.claude/.claude.json` for a user whose
/// terminal login lives at `$HOME/.claude.json` reports "not signed in" for an account that IS
/// signed in, which walks them into a second `claude login` — frequently as a DIFFERENT Anthropic
/// account than the one their terminal uses. That is how a config dir ends up holding a login with
/// nothing to do with the nickname typed when it was created, and how the terminal's real login
/// ends up orphaned: registered nowhere, so nothing in Sparkle ever reads it.
///
/// An explicit non-empty `config_dir` means the spawn sets `CLAUDE_CONFIG_DIR` to it, so the first
/// form applies; empty/absent means the spawn sets nothing, so the second does. Returns `None` only
/// when neither a usable explicit dir nor a home is available.
fn identity_json_path(config_dir: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    match config_dir.filter(|d| !d.as_os_str().is_empty()) {
        Some(d) => Some(d.join(".claude.json")),
        None => home.map(|h| h.join(".claude.json")),
    }
}

/// Read the REAL authenticated identity Claude Code records in its config file
/// (see [`identity_json_path`]) under `oauthAccount` (`emailAddress`,
/// `organizationName`). DEFENSIVE and never errors: a missing file, unparseable JSON,
/// a missing/empty `oauthAccount`, or a missing/empty `emailAddress` all yield `None`
/// (an account dir created but never logged into — "not signed in"). The org is `None`
/// when absent/empty even if the email is present. The email is the authoritative
/// label; the nickname is only a secondary alias.
fn read_oauth_identity_at(
    config_dir: Option<&Path>,
    home: Option<&Path>,
) -> Option<OauthIdentity> {
    let bytes = std::fs::read(identity_json_path(config_dir, home)?).ok()?;
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
///
/// `config_dir` = the value a spawn will actually see (`claude::effective_spawn_config_dir`):
/// Sparkle's own `$CLAUDE_CONFIG_DIR` if it was launched with one, else whatever the login shell
/// exports, else the EMPTY string — meaning "set no `CLAUDE_CONFIG_DIR` on the spawn at all".
///
/// Empty is load-bearing, not a missing value. It used to synthesize `$HOME/.claude` here, on the
/// reasonable-looking assumption that `CLAUDE_CONFIG_DIR=$HOME/.claude` is what "no override" means.
/// It isn't: setting the variable MOVES the config file from `$HOME/.claude.json` to
/// `$HOME/.claude/.claude.json` (see [`identity_json_path`]). So importing the user's default
/// pointed at a config Claude Code had never written — a blank, logged-out profile — while their
/// real terminal login sat unread at `$HOME/.claude.json`. The account read "not signed in", the
/// user logged in again (often as a different Anthropic account), and the nickname they had typed
/// no longer described the login the dir held.
///
/// Storing the empty string instead makes the default account genuinely the terminal's account:
/// the spawn omits the export, so Claude Code resolves `$HOME/.claude.json` and
/// `$HOME/.claude/projects` exactly as `claude` does with no Sparkle involved.
///
/// Because `import_default_at` returns an existing default untouched, a fix here would otherwise
/// only ever reach fresh installs — leaving every existing user still walking into the original
/// trap. So this first runs [`normalize_default_config_dir_at`], which repairs the one pre-fix
/// shape that can be repaired without changing which Anthropic account anyone runs as.
#[tauri::command]
pub fn accounts_import_default(
    app: AppHandle,
    lock: State<'_, AccountsLock>,
) -> Result<Account, String> {
    let _guard = lock.guard();
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    let accounts_path = accounts_json_path(&app_data);
    let home = std::env::var_os("HOME").map(PathBuf::from);

    // Steady state — a default that exists and needs no repair — must cost one file read and
    // nothing else. `effective_spawn_config_dir` may run a login shell (100-500ms of dotfiles) and
    // this command is called on every app start, so resolve it only when it will be used.
    if let Some(existing) = read_accounts_at(&accounts_path)?.iter().find(|a| a.is_default) {
        if !default_config_dir_needs_normalizing(existing, home.as_deref()) {
            return Ok(existing.clone());
        }
    }

    let effective = crate::claude::effective_spawn_config_dir();
    normalize_default_config_dir_at(&accounts_path, home.as_deref(), &effective)?;
    let id = generate_account_id()?;
    import_default_at(&accounts_path, effective, id, now_secs())
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
        Ok(usage_for_accounts(&accounts, now))
    })
    .await
    .map_err(|e| format!("accounts_usage task failed: {e}"))?
}

/// Cross-project Claude Code spend "today" (trailing 24h) plus a 7d figure. Scans the same roots as
/// the Spend pane (`spend::transcript_roots`) plus any account whose config dir lives outside
/// app-data, dedupes resumed turns by message id, and values each record through the pane's price
/// table (see [`spend_summary`] / [`SpendRecord::cost_usd`]).
///
/// NO UI CALLS THIS. Its only consumer was the concierge spend pill, deleted because an unbilled
/// list-price estimate that counts UP was being read as the credit balance, which counts DOWN (see
/// [`SpendSummary`]). Kept registered rather than removed: the scan and pricing below are the
/// expensive part and would only have to be rebuilt. A future spend surface reconnects by re-adding
/// the binding in `services/accountStore.ts`. Do not confuse this with Settings → History & Spend,
/// which is the separate `spend_report` command.
///
/// The windows are deliberately ROLLING (trailing 24h / 7d), where the pane buckets by UTC civil
/// day — that difference is intentional and was visible in the labels ("today" vs a dated
/// calendar). Everything else — roots, dedupe, prices — is shared, because those three disagreeing
/// is just three wrong numbers.
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
        // `spend::transcript_roots` FIRST, so the pill covers exactly what the Spend pane covers:
        // `~/.claude` plus every account store under app-data, deduped canonically. Scanning only
        // the dirs named in accounts.json meant a fresh install — or any machine whose usage lives
        // in ~/.claude — showed $0.00 in the pill next to a pane full of real spend.
        //
        // Scanned in the ORDER that function returns (a Vec, not a set): with last-copy-wins dedupe
        // the scan order decides which copy of a contested id survives, so iterating a HashSet made
        // the totals vary between runs of the same tree. Membership is tracked on the CANONICAL key
        // for the same reason `transcript_roots` dedupes that way — two spellings of one tree would
        // otherwise scan twice, and the id-less records would double-count.
        let mut roots = crate::spend::transcript_roots(Some(&app_data));
        let mut seen_roots: HashSet<PathBuf> =
            roots.iter().map(|p| crate::spend::canonical_key(p)).collect();
        // Plus any account whose config dir points somewhere else entirely (an imported account
        // living outside app-data).
        for a in &accounts {
            if let Some(root) = projects_root_for_account(a) {
                // Dedupe: two account records with the same config dir would otherwise scan the
                // same transcripts twice and double the spend total. This also collapses a pre-fix
                // default (`$HOME/.claude`) and a post-fix one (`""`) — both resolve to
                // `$HOME/.claude/projects` — so a migrated install can't double-count.
                //
                // On the CANONICAL key, not the raw path: that collapses the two spellings above
                // AND a symlinked store, which a raw-path set lets through. Collected into `roots`
                // rather than scanned here, so the whole pass is one walk with one memo generation
                // (below) — a per-root scan is exactly the pass boundary `finish_usage_pass`
                // documents as the bug.
                if seen_roots.insert(crate::spend::canonical_key(&root)) {
                    roots.push(root);
                }
            }
        }
        // ONE walk, ONE global sort, ONE memo generation for the whole pass — see
        // `collect_usage_records_across`.
        let pass = UsagePass::start();
        let touched =
            collect_usage_records_across(&roots, now - WINDOW_7D, &mut records, pass.id());
        finish_usage_pass(pass, touched > 0);
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
/// user actually authenticated. `config_dir` omitted/empty → `$HOME/.claude.json`, where a plain
/// `claude login` with no `CLAUDE_CONFIG_DIR` puts it (the first-run case, before any named account
/// exists — see [`identity_json_path`] for why that is NOT `$HOME/.claude/.claude.json`). Never
/// errors — an unreadable/missing file is "not signed in". Note: this detects the OAuth
/// (`claude login`) flow, which is exactly what the step runs.
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

// ── LIVE auth status ────────────────────────────────────────────────────────────────────────────
//
// WHY `claude_signed_in` ABOVE IS NOT ENOUGH, AND WHAT WENT WRONG.
//
// `claude_signed_in` answers "did `claude auth login` ever finish here?" by looking for a recorded
// `oauthAccount.emailAddress`. That email is written once and NEVER REMOVED when the session lapses,
// so the answer stays `true` forever after the first sign-in. It is a memory, not a reading.
//
// The founder opened Sparkle on a second machine and asked the concierge a question. The concierge
// child failed with:
//
//     Failed to authenticate: OAuth session expired and could not be refreshed
//
// The readiness gate had already asked `claude_signed_in`, been told `true` (the email was still
// there from a login weeks earlier), and stayed invisible. So the app's own model of auth said
// "fine" while every `claude` child on the machine was failing — and the user was left retrying a
// request that could not succeed. NO amount of reordering onboarding fixes that: the first run had
// genuinely succeeded. What was missing was a probe that can come back FALSE after having been true.
//
// `claude auth status --json` is that probe — the CLI's own answer about its own credentials:
//
//     { "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
//       "email": "…", "orgId": "…", "orgName": "…", "subscriptionType": "max" }
//
// FAIL-OPEN, DELIBERATELY. This drives a gate that can block the whole app, so an unreadable probe
// must never be the thing that locks a working user out. Binary missing, subcommand unknown (an
// older Claude Code), timeout, garbage on stdout — every one of those falls back to the recorded
// identity and reports `source: "recorded"`, and the gate treats that as signed in. Only a probe
// that RAN and said `loggedIn: false` is allowed to block. The cost of that choice is that an
// expired session on a machine whose probe is broken still reaches the concierge — where the
// failure notice now names it and offers re-auth in place, which is the second half of this fix.

/// How the auth answer was obtained. The frontend gates on this: only `Cli` is a live reading, so
/// only `Cli` may be trusted to say NO.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthStatusSource {
    /// `claude auth status --json` ran and parsed. The only source that can prove a session is dead.
    Cli,
    /// The CLI probe was unavailable/unreadable; this is the remembered `.claude.json` identity.
    Recorded,
    /// Neither a CLI answer nor a recorded identity — nobody has ever signed in here.
    Absent,
}

/// Live Claude Code authentication status for one config dir.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    /// Whether Claude Code can currently authenticate. See [`AuthStatusSource`] for how much this
    /// is worth: a `false` from `Recorded`/`Absent` means "never signed in", a `false` from `Cli`
    /// means "signed in once, and the session is now dead".
    pub logged_in: bool,
    pub source: AuthStatusSource,
    pub email: Option<String>,
    /// e.g. "claude.ai" | "console". `None` when the CLI did not answer.
    pub auth_method: Option<String>,
    /// e.g. "max" | "pro". `None` when the CLI did not answer or the account has no subscription.
    pub subscription_type: Option<String>,
}

/// How long we let `claude auth status` run before giving up and falling back to the recorded
/// identity. The observed cost is a few hundred ms; 8s is generous headroom for a cold node start
/// on a slow disk while still bounding the app's first paint.
const AUTH_STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Parse `claude auth status --json` stdout. PURE — the whole point, so the shape contract is
/// unit-tested without spawning a process.
///
/// Returns `None` for anything that is not a JSON object carrying a boolean `loggedIn`. That
/// strictness is intentional: a `None` falls back to the recorded identity (fail-open), whereas a
/// half-parsed object could report `logged_in: false` from `Cli` and BLOCK THE APP on garbage. The
/// only input allowed to block is one that unambiguously said so.
fn parse_claude_auth_status(stdout: &str) -> Option<ClaudeAuthStatus> {
    // The CLI prints a banner/warning line before the JSON on some installs, so scan for the first
    // line that opens an object rather than assuming stdout is pure JSON.
    let start = stdout.find('{')?;
    let v: serde_json::Value = serde_json::from_str(stdout[start..].trim())
        .ok()
        .or_else(|| serde_json::from_str(stdout[start..].lines().next()?.trim()).ok())?;
    let logged_in = v.get("loggedIn")?.as_bool()?;
    let str_field = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(ClaudeAuthStatus {
        logged_in,
        source: AuthStatusSource::Cli,
        email: str_field("email"),
        auth_method: str_field("authMethod"),
        subscription_type: str_field("subscriptionType"),
    })
}

/// The recorded-identity fallback, as a [`ClaudeAuthStatus`]. Never blocks: an identity on disk is
/// reported `logged_in: true` with `source: Recorded`, and the absence of one is the only way to
/// get `Absent` — i.e. a genuinely fresh machine, which SHOULD be gated.
fn recorded_auth_status(config_dir: Option<&Path>, home: Option<&Path>) -> ClaudeAuthStatus {
    match read_oauth_identity_at(config_dir, home) {
        Some(id) => ClaudeAuthStatus {
            logged_in: true,
            source: AuthStatusSource::Recorded,
            email: Some(id.email),
            auth_method: None,
            subscription_type: None,
        },
        None => ClaudeAuthStatus {
            logged_in: false,
            source: AuthStatusSource::Absent,
            email: None,
            auth_method: None,
            subscription_type: None,
        },
    }
}

/// Build the `claude auth status --json` command, fully configured. Split from the run so a test can
/// assert the ENVIRONMENT without spawning anything — the scrub below is invisible at runtime when
/// it regresses, so it needs a pinned contract rather than a comment (roborev 57985).
fn claude_auth_status_command(claude_path: &str, config_dir: Option<&Path>) -> std::process::Command {
    let mut cmd = std::process::Command::new(claude_path);
    cmd.args(["auth", "status", "--json"]);

    // SCRUB THE ANTHROPIC ENV — and this is not boilerplate, it is the difference between this probe
    // working and actively re-creating the bug it exists to fix.
    //
    // The concierge's own `claude -p` child runs with these stripped (see
    // `claude_oneshot::scrub_anthropic_env`), so it authenticates via subscription OAuth. If THIS
    // probe inherited them, it would answer about a different credential than the one that actually
    // failed: an inherited `ANTHROPIC_API_KEY` makes `claude auth status` report a healthy API-key
    // posture while the concierge's OAuth session is dead — i.e. exactly the false "you're signed
    // in" that let the founder's expired session reach the concierge unannounced. An inherited
    // `ANTHROPIC_BASE_URL` gives the inverse: a probe that says logged-out and is allowed to BLOCK
    // the whole app over a credential the concierge never uses.
    //
    // Deliberately the same list as claude_oneshot's, referenced rather than re-typed, so a name
    // added there cannot be silently missing here.
    crate::claude_oneshot::scrub_anthropic_env_for(&mut cmd);

    if let Some(dir) = config_dir.filter(|d| !d.as_os_str().is_empty()) {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    // `claude` is a `#!/usr/bin/env node` shebang on a normal install, so node has to be findable.
    // A GUI app's PATH does not include ~/.local/bin; prepend it the same way every spawn path does.
    if let Some(home) = std::env::var_os("HOME") {
        let path = std::env::var("PATH").unwrap_or_default();
        let home_str = home.to_string_lossy().into_owned();
        cmd.env("PATH", format!("{home_str}/.local/bin:{path}"));
        // A Dock-launched bundle has CWD `/`, which some `claude` paths object to. Same reasoning as
        // `hooks.rs::claude_command`.
        cmd.current_dir(&home);
    }
    cmd
}

/// Run `claude auth status --json`, bounded by [`AUTH_STATUS_TIMEOUT`], and return its stdout.
///
/// USES THE REPO'S HARDENED CAPTURE (`worktree::output_with_timeout`) rather than a hand-rolled
/// `try_wait` loop, and the reason is a deadlock this originally had. With `stdout` piped but never
/// drained while polling, a child that writes past the ~64 KB pipe buffer blocks on write, so it
/// never exits, so `try_wait` never reports it — the probe burns the full 8s and is then killed.
/// That failure is SILENT by construction: it falls back to `source: "recorded"`, the stale memory
/// this whole command exists to stop trusting. So a merely chatty CLI (banners, a debug env var)
/// would quietly degrade the live reading to the old broken answer, on a path polled per window
/// focus. `output_with_timeout` drains both streams on reader threads and kills the whole process
/// group on expiry (roborev 57985).
fn run_claude_auth_status(claude_path: &str, config_dir: Option<&Path>) -> Option<String> {
    let cmd = claude_auth_status_command(claude_path, config_dir);
    let out = crate::worktree::output_with_timeout(cmd, AUTH_STATUS_TIMEOUT).ok()?;
    // Not gated on `status.success()`: a CLI that exits non-zero while still printing a valid
    // `{"loggedIn":false}` is telling us exactly what we asked. `parse_claude_auth_status` is the
    // one that decides whether the bytes mean anything.
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if stdout.trim().is_empty() {
        return None;
    }
    Some(stdout)
}

/// Blocking core of [`claude_auth_status`]. Split out so the fail-open decision tree is testable:
/// `probe` stands in for the subprocess, so a test can drive "CLI says no", "CLI says yes",
/// "CLI unavailable", and "garbage" without a `claude` binary on the machine.
fn claude_auth_status_with(
    config_dir: Option<&Path>,
    home: Option<&Path>,
    probe: impl FnOnce() -> Option<String>,
) -> ClaudeAuthStatus {
    match probe().as_deref().and_then(parse_claude_auth_status) {
        Some(live) => live,
        // FAIL-OPEN. The probe could not speak, so it does not get a vote — see the module note.
        None => recorded_auth_status(config_dir, home),
    }
}

/// Whether Claude Code can authenticate RIGHT NOW for the given config dir — the reading behind the
/// auth gate and the concierge's re-auth prompt. Unlike [`claude_signed_in`], this can return
/// `logged_in: false` for a machine that signed in successfully in the past, which is the entire
/// reason it exists (see the module note above for the failure it closes).
///
/// `async` + `spawn_blocking`: runs a subprocess and reads a file, neither of which may touch the
/// event loop. On a JoinError we report the fail-open `Recorded`/`Absent` answer rather than
/// inventing a `false` that could gate the app.
#[tauri::command]
pub async fn claude_auth_status(config_dir: Option<String>) -> ClaudeAuthStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let dir = config_dir.filter(|s| !s.is_empty()).map(PathBuf::from);
        let claude = crate::preflight::cached_claude_path();
        claude_auth_status_with(dir.as_deref(), home.as_deref(), || {
            run_claude_auth_status(claude.as_deref()?, dir.as_deref())
        })
    })
    .await
    .unwrap_or(ClaudeAuthStatus {
        logged_in: true,
        source: AuthStatusSource::Recorded,
        email: None,
        auth_method: None,
        subscription_type: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Event-loop offload guards ───────────────────────────────────────────────────────────────
    //
    // EVERY `async` `#[tauri::command]` in this module is asserted below. Add a new one and add its
    // assertion here — this comment is the ENTIRE maintenance contract, because nothing else
    // enforces the count.
    //
    // Say it exactly once, and here. An earlier version of this header enumerated "these four" with
    // their individual IO justifications while the test ten lines below claimed to be exhaustive:
    // two inventory statements that disagreed, with no way to tell which governed. That is not a
    // cosmetic problem — it is the artifact that let three heavy scanners go unguarded in the first
    // place (roborev 55742, then 55762 for the half-applied fix). Per-command justifications now
    // live inline next to their assertions, so there is one inventory, in one place.
    //
    // Why it matters: a non-async `#[tauri::command]` runs INLINE on the Tauri event-loop thread, so
    // a command doing real blocking filesystem work would freeze the UI. The coercion only
    // type-checks while the command returns a future: revert a `pub async fn` to `pub fn` and its
    // return type becomes a plain `Result`/`bool`, which is not a `Future`, and the build breaks
    // here. Every other test in this module drives the pure `*_at` / `*_sync` cores, so without
    // these guards such a revert would pass silently.
    //
    // The commands taking an `AppHandle` can't be *invoked* without a running Tauri app, but the
    // guard is a compile-time check and needs no instance.

    fn assert_async_command<A, Fut: std::future::Future>(_f: fn(A) -> Fut) {}

    #[test]
    fn every_async_command_stays_off_the_event_loop() {
        // EXHAUSTIVE by intent, not a sample: every `async` command in this module belongs here, so
        // the list must be extended whenever one is added. The first version of this guard covered
        // only the four JSON readers while its comment read as a complete inventory of the module's
        // at-risk commands — the three heavy scanners below were unguarded, so reverting any of them
        // to `pub fn` still compiled and the whole suite stayed green. That is precisely the
        // regression this test exists to prevent (roborev 55742).
        assert_async_command(accounts_list);
        // Walks every account's transcript tree.
        assert_async_command(accounts_usage);
        // Opens `accounts.json` PLUS every account's own `.claude.json`.
        assert_async_command(accounts_identities);
        assert_async_command(claude_signed_in);
        // Spawns `claude auth status` and waits on it — the only command here that blocks on a
        // SUBPROCESS rather than a file, so reverting it to `pub fn` would freeze the UI for up to
        // AUTH_STATUS_TIMEOUT on every window focus.
        assert_async_command(claude_auth_status);
        // Also transcript-tree scanners.
        assert_async_command(accounts_spend);
        assert_async_command(accounts_limit_events);
        // Documented in-module as "the heaviest read in this module by a wide margin".
        assert_async_command(accounts_ceilings);
    }

    #[test]
    fn claude_signed_in_drives_the_async_command_end_to_end() {
        // Scope, stated honestly: this drives the real `async` command rather than the sync core, so
        // the command is reachable and its result travels back out through the await correctly.
        //
        // It does NOT prove the work happened on the blocking pool, and it does NOT exercise the
        // JoinError arm — an earlier name and comment here claimed both (roborev 55742). Neither
        // claim held: rewrite the body as `pub async fn claude_signed_in(d) -> bool {
        // claude_signed_in_sync(d) }` — no `spawn_blocking`, blocking IO inline on an async worker —
        // and this test still passes, as does the coercion guard above. The `false` case below comes
        // from a missing `.claude.json`, not from a task failure, so `unwrap_or(false)` could become
        // `unwrap()` invisibly.
        //
        // Left as an end-to-end reachability test rather than fabricating that coverage: forcing a
        // real JoinError needs a panicking closure, and asserting the thread identity needs
        // production code to report it. Both are worth doing when something depends on them; the
        // compile-time guard above is what actually holds the `async` shape in place today.
        let base = unique_dir("signed-in-async");
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#);
        assert!(tauri::async_runtime::block_on(claude_signed_in(Some(
            base.to_string_lossy().into_owned()
        ))));
        // A dir with no .claude.json → false, through the same async path.
        let empty = unique_dir("signed-in-async-empty");
        assert!(!tauri::async_runtime::block_on(claude_signed_in(Some(
            empty.to_string_lossy().into_owned()
        ))));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&empty);
    }

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

    /// Memo-test shorthand: a SpendRecord with only (ts, output) set — the shape the old
    /// (ts, tokens) tuple carried.
    fn rec(ts: i64, output: u64) -> SpendRecord {
        SpendRecord {
            ts,
            message_id: None,
            model: None,
            input: 0,
            output,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 0,
        }
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
            message_id: Some("msg_full".into()),
            model: Some("claude-opus-4-8".into()),
            input: 3,
            output: 20,
            cache_write_5m: 7,
            cache_write_1h: 0,
            cache_read: 11,
        };
        usage_cache_store(&mut cache, path, at, 42, vec![full.clone()], 1);

        assert_eq!(
            usage_cache_lookup(&mut cache, path, at, 42, 1),
            Some([full].as_slice()),
            "same mtime + same length is the same bytes — reuse the parse"
        );
        assert!(
            usage_cache_lookup(&mut cache, path, shifted(at), 42, 1).is_none(),
            "an appended-to transcript has a newer mtime — must re-parse"
        );
        assert!(
            usage_cache_lookup(&mut cache, path, at, 43, 1).is_none(),
            "a different length is different bytes — must re-parse"
        );
        assert!(
            usage_cache_lookup(&mut cache, Path::new("/tmp/other.jsonl"), at, 42, 1).is_none(),
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
        usage_cache_store(&mut cache, path, at, 10, vec![rec(1, 5)], 1);
        usage_cache_store(&mut cache, path, shifted(at), 20, vec![rec(1, 5), rec(2, 7)], 1);

        assert_eq!(cache.len(), 1, "one entry per path, not per revision");
        assert_eq!(
            usage_cache_lookup(&mut cache, path, shifted(at), 20, 1),
            Some([rec(1, 5), rec(2, 7)].as_slice()),
            "the latest parse wins"
        );
        assert!(
            usage_cache_lookup(&mut cache, path, at, 10, 1).is_none(),
            "the superseded revision is gone"
        );
    }

    #[test]
    fn usage_memo_evicts_after_the_pass_never_a_live_pass_and_converges() {
        let at = |secs: u64| SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        let base = 1_700_000_000;
        let (target, hard_cap) = (10usize, 20usize);
        let live = |gens: &[u64]| {
            let set: HashSet<u64> = gens.iter().copied().collect();
            move |g: u64| set.contains(&g)
        };
        let evict = |c: &mut UsageCache, gens: &[u64]| {
            crate::spend::evict_two_tier(c, target, hard_cap, live(gens), |v| (v.last_touch, v.modified));
        };

        let mut cache = UsageCache::new();
        // Pass 1 fills the memo past the target. Distinct mtimes, oldest first.
        for i in 0..16u64 {
            usage_cache_store(&mut cache, &PathBuf::from(format!("/t/{i}.jsonl")), at(base + i), 1, vec![], 1);
        }
        assert_eq!(cache.len(), 16, "storing never evicts — that is the pass's own working set");

        // Pass 2 starts where the scan starts: the OLDEST files. Those hit, marking them as pass 2's.
        for i in 0..4u64 {
            assert!(
                usage_cache_lookup(&mut cache, &PathBuf::from(format!("/t/{i}.jsonl")), at(base + i), 1, 2).is_some(),
                "a second pass over the same files must HIT, not re-parse"
            );
        }
        // A new session transcript appears mid-pass — storing must not evict anything.
        usage_cache_store(&mut cache, Path::new("/t/new.jsonl"), at(base + 999), 1, vec![], 2);
        for i in 4..16u64 {
            assert!(
                cache.contains_key(&PathBuf::from(format!("/t/{i}.jsonl"))),
                "an entry this pass has not REACHED yet must survive a mid-walk store"
            );
        }

        // End of pass 2 — but pass 3 is ALSO live (the commands overlap). Nothing belonging to
        // either may be evicted; that mutual trimming is the bug the live registry closes.
        usage_cache_store(&mut cache, Path::new("/t/other.jsonl"), at(base + 5), 1, vec![], 3);
        evict(&mut cache, &[2, 3]);
        for i in 0..4u64 {
            assert!(cache.contains_key(&PathBuf::from(format!("/t/{i}.jsonl"))), "pass 2's entries");
        }
        assert!(cache.contains_key(Path::new("/t/other.jsonl")), "the CONCURRENT pass's entry");
        assert_eq!(cache.len(), target, "trimmed to the target out of pass 1's leftovers only");

        // Tier 2: a first pass over a tree larger than the cap has NO evictable entries under tier
        // 1 (they are all its own), so without a hard cap the memo simply grows.
        let mut huge = UsageCache::new();
        for i in 0..(hard_cap + 5) as u64 {
            usage_cache_store(&mut huge, &PathBuf::from(format!("/h/{i}.jsonl")), at(base + i), 1, vec![], 7);
        }
        evict(&mut huge, &[7]);
        assert_eq!(huge.len(), hard_cap, "the hard cap is enforced against a live pass too");
        assert!(
            huge.contains_key(Path::new("/h/0.jsonl")),
            "the settled, oldest transcript is kept — it stays valid and hits forever"
        );
        assert!(
            !huge.contains_key(&PathBuf::from(format!("/h/{}.jsonl", hard_cap + 4))),
            "the newest is the one dropped — an append was about to invalidate it anyway"
        );

        // CONVERGENCE: pass 8 re-walks the same oversized tree. The retained entries hit, the
        // dropped newest ones are re-parsed and re-stored, and eviction settles on the SAME set.
        let after_first: Vec<PathBuf> = {
            let mut k: Vec<PathBuf> = huge.keys().cloned().collect();
            k.sort();
            k
        };
        for p in &after_first {
            let i: u64 = p.file_stem().unwrap().to_string_lossy().parse().unwrap();
            assert!(usage_cache_lookup(&mut huge, p, at(base + i), 1, 8).is_some(), "retained ⇒ hits");
        }
        for i in hard_cap as u64..(hard_cap + 5) as u64 {
            usage_cache_store(&mut huge, &PathBuf::from(format!("/h/{i}.jsonl")), at(base + i), 1, vec![], 8);
        }
        evict(&mut huge, &[8]);
        let after_second: Vec<PathBuf> = {
            let mut k: Vec<PathBuf> = huge.keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(after_second, after_first, "an oversized tree reaches a STABLE set, not a thrash");
    }

    /// One generation per COMMAND, spanning every account. Per-account generations made account 1's
    /// walk-end eviction trim accounts 2..N's entries out of the process-wide memo — on the
    /// agent-spawn critical path.
    #[test]
    fn usage_for_accounts_is_one_pass_over_every_account() {
        let base = unique_dir("accounts-pass");
        let mk = |name: &str, tokens: u64| {
            let cfg = base.join(name);
            let proj = cfg.join("projects").join("p");
            std::fs::create_dir_all(&proj).unwrap();
            std::fs::write(
                proj.join("s.jsonl"),
                format!(
                    "{{\"timestamp\":\"2026-06-25T21:20:25.931Z\",\"type\":\"assistant\",\
                     \"message\":{{\"model\":\"claude-haiku-4-5\",\"usage\":{{\
                     \"input_tokens\":{tokens},\"output_tokens\":0,\
                     \"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}}}}\n"
                ),
            )
            .unwrap();
            Account {
                id: name.into(),
                nickname: name.into(),
                config_dir: cfg.to_string_lossy().into_owned(),
                is_default: false,
                created_at: 0,
                exhausted_until: None,
            }
        };
        let accounts = vec![mk("acct-a", 11), mk("acct-b", 22)];
        let now = parse_iso8601_to_epoch("2026-06-25T21:30:00.000Z").unwrap();

        let usage = usage_for_accounts(&accounts, now);
        assert_eq!(usage.len(), 2);
        assert_eq!(usage[0].tokens_7d, 11, "each account still sees only its own transcripts");
        assert_eq!(usage[1].tokens_7d, 22);

        // The INVARIANT, asserted directly rather than through eviction: both accounts' entries
        // carry the SAME generation. Checking only that both survived proved nothing at this scale
        // — eviction is gated on len() > 20_000, so a generation per account passed too.
        let cache = usage_cache().lock().unwrap();
        let stamps: HashSet<u64> = cache
            .iter()
            .filter(|(p, _)| p.starts_with(&base))
            .map(|(_, c)| c.last_touch)
            .collect();
        assert_eq!(stamps.len(), 1, "one generation across every account in the call");
        drop(cache);

        let _ = std::fs::remove_dir_all(&base);
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
        collect_usage_from_file_memoized(&path, Some(&meta), &mut first, 1);
        assert_eq!(
            first,
            vec![SpendRecord {
                ts: epoch,
                message_id: None,
                model: None,
                input: 10,
                output: 5,
                cache_write_5m: 0,
                cache_write_1h: 0,
                cache_read: 0,
            }],
            "cold scan parses the file"
        );

        std::fs::remove_file(&path).unwrap();
        let mut second = Vec::new();
        collect_usage_from_file_memoized(&path, Some(&meta), &mut second, 2);
        assert_eq!(second, first, "warm scan is served from the memo, not the disk");

        // No stat to key on (the caller's fail-open path) → parse, which now finds nothing.
        let mut unkeyed = Vec::new();
        collect_usage_from_file_memoized(&path, None, &mut unkeyed, 3);
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
        let usage = usage_for_account(&acct, recent_epoch + 10, 1).0;
        // The fixture record is input 10 + output 5 + cache_write 2 + cache_read 3. The near-cap
        // windows report 17, NOT 20 — cache reads don't count toward a rate limit and including
        // them made the tally both a worse predictor and orders of magnitude too large.
        assert_eq!(usage.tokens_5h, 17);
        assert_eq!(usage.tokens_7d, 17);
        assert_eq!(usage.exhausted_until, None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The bug this file's dedupe was originally only HALF fixed for: `spend_summary` deduped
    /// resumed turns, `usage_for_account` did not, so the 5h/7d LIMIT tallies — the ones that drive
    /// the headroom display and throttle the user — counted a resumed session's copied turns twice
    /// and benched the account early against usage it never spent.
    ///
    /// End-to-end through the real scan: two transcripts under one root, the second a `--resume`
    /// of the first, so it carries a COPY of the earlier turn (same `message.id`) plus its own new
    /// one. Raw, that reads 17 + 17 + 100 = 134 in the 7d window; deduped it is 117.
    #[test]
    fn usage_tallies_count_a_resumed_turn_once() {
        let base = unique_dir("usage-resume");
        let config = base.join("acct-config");
        let slug_dir = config.join("projects").join("-tmp-proj");
        std::fs::create_dir_all(&slug_dir).unwrap();

        let new_iso = "2026-06-25T21:20:25.931Z";
        let now = parse_iso8601_to_epoch(new_iso).unwrap() + 10;
        // The copied turn sits OUTSIDE the 5h window and inside 7d, so the two tallies are
        // distinguishable: only the 7d one can double-count it.
        let old_iso = "2026-06-25T12:00:00.000Z";
        assert!(parse_iso8601_to_epoch(old_iso).unwrap() < now - WINDOW_5H);

        // limit_tokens 17 (the 3 cache_read tokens never count toward a limit).
        let old_turn = format!(
            concat!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"id\":\"msg_old\",",
                "\"usage\":{{\"input_tokens\":10,\"output_tokens\":5,",
                "\"cache_creation_input_tokens\":2,\"cache_read_input_tokens\":3}}}}}}\n"
            ),
            ts = old_iso
        );
        // The turn only the resumed session produced: limit_tokens 100.
        let new_turn = format!(
            concat!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"id\":\"msg_new\",",
                "\"usage\":{{\"input_tokens\":100,\"output_tokens\":0}}}}}}\n"
            ),
            ts = new_iso
        );
        std::fs::write(slug_dir.join("a-original.jsonl"), &old_turn).unwrap();
        std::fs::write(
            slug_dir.join("b-resumed.jsonl"),
            format!("{old_turn}{new_turn}"),
        )
        .unwrap();

        let acct = sample("r1", false, config.to_str().unwrap());
        let usage = usage_for_account(&acct, now, 1).0;
        assert_eq!(usage.tokens_5h, 100, "only the new turn is inside 5h");
        assert_eq!(
            usage.tokens_7d, 117,
            "the resumed copy of msg_old is counted ONCE (117, not 134)"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The same double-count reached the LEARNED CEILING: `ceiling_for_account` pairs each past
    /// limit episode with the consumption preceding it, and consumption over a resumed session read
    /// high, so every sample — and the median the near-cap banner fires against — sat above the real
    /// cap. Raw this sample is 200; deduped it is 100.
    #[test]
    fn ceiling_samples_count_a_resumed_turn_once() {
        let base = unique_dir("ceiling-resume");
        let projects = base.join("projects");
        std::fs::create_dir_all(&projects).unwrap();

        let usage_iso = "2026-07-20T09:00:00.000Z";
        let limit_iso = "2026-07-20T10:00:00.000Z";
        let turn = format!(
            concat!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"id\":\"msg_c\",",
                "\"usage\":{{\"input_tokens\":100,\"output_tokens\":0,",
                "\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":9999}}}}}}\n"
            ),
            ts = usage_iso
        );
        let limit = format!("{}\n", limit_line(limit_iso, "resets 9pm (America/Los_Angeles)"));
        std::fs::write(projects.join("a-original.jsonl"), format!("{turn}{limit}")).unwrap();
        // The resume copies BOTH lines forward. The duplicate limit event collapses into the same
        // episode (`limit_episodes`); the duplicate turn is what must not double the sample.
        std::fs::write(projects.join("b-resumed.jsonl"), format!("{turn}{limit}")).unwrap();

        let now = parse_iso8601_to_epoch("2026-07-21T00:00:00.000Z").unwrap();
        let got = ceiling_for_account(&sample("c9", false, base.to_str().unwrap()), now);
        assert_eq!(got.samples, vec![100], "one episode, and its consumption is 100 (not 200)");
        assert_eq!(got.ceiling, None, "one sample is below CEILING_MIN_SAMPLES");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The three surfaces that consume a `SpendRecord` vector — the spend pill, the 5h/7d limit
    /// tallies, and the ceiling learner — must all count a resumed turn exactly ONCE. They diverged
    /// before because the dedupe lived at one call site; this pins them together so a fourth copy of
    /// the rule can't quietly reappear.
    #[test]
    fn spend_and_limit_paths_agree_on_the_resume_dedupe() {
        let now = 1_000_000_000;
        let turn = || SpendRecord {
            ts: now - 60,
            message_id: Some("msg_shared".to_string()),
            model: Some("claude-haiku-4-5".to_string()),
            input: 1_000,
            output: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 7,
        };
        // The original and the copy a resume wrote — one turn, two records.
        let records = vec![turn(), turn()];
        let once = turn();

        // Spend unit: every token processed, cache reads included.
        let s = spend_summary(&records, now);
        assert_eq!(s.tokens_today, once.total_tokens());
        assert_eq!(s.tokens_7d, once.total_tokens(), "1007, not 2014");

        // Limit unit: cache reads excluded. Same expression `usage_for_account` buckets.
        let pairs = token_pairs(dedupe_by_message_id(&records, now - WINDOW_7D, now));
        assert_eq!(
            bucket_tokens(&pairs, now),
            (once.limit_tokens(), once.limit_tokens()),
            "1000 in each window, not 2000"
        );

        // Ceiling unit: the 5h consumption a limit episode would learn from.
        assert_eq!(consumption_before(&records, now), once.limit_tokens());
    }

    #[test]
    fn usage_surfaces_exhausted_until_only_while_in_future() {
        let acct = Account {
            exhausted_until: Some(500),
            ..sample("e1", false, "/nonexistent")
        };
        // Reset epoch in the future → surfaced.
        assert_eq!(usage_for_account(&acct, 400, 1).0.exhausted_until, Some(500));
        // Reset epoch in the past → cleared.
        assert_eq!(usage_for_account(&acct, 600, 1).0.exhausted_until, None);
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
            usage_for_account(&read[0], reset_secs - 60, 1).0.exhausted_until,
            Some(reset_secs),
            "still exhausted just before the reset"
        );
        assert_eq!(
            usage_for_account(&read[0], reset_secs + 60, 1).0.exhausted_until,
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

    // ── Live auth status (the expired-session gate) ─────────────────────────────────────────────

    #[test]
    fn parse_claude_auth_status_reads_the_cli_json_verbatim() {
        // The exact shape `claude auth status --json` prints on 2.1.221, captured from the CLI.
        let out = r#"{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "someone@example.com",
  "orgId": "00000000-0000-0000-0000-000000000000",
  "orgName": "Example Org",
  "subscriptionType": "max"
}"#;
        let s = parse_claude_auth_status(out).expect("valid CLI JSON must parse");
        assert!(s.logged_in);
        assert_eq!(s.source, AuthStatusSource::Cli);
        assert_eq!(s.email.as_deref(), Some("someone@example.com"));
        assert_eq!(s.auth_method.as_deref(), Some("claude.ai"));
        assert_eq!(s.subscription_type.as_deref(), Some("max"));
    }

    #[test]
    fn parse_claude_auth_status_tolerates_a_banner_line_before_the_json() {
        // Some installs print an update/warning notice ahead of the payload. Scanning for the first
        // `{` rather than assuming pure JSON keeps a chatty CLI from being read as "probe broken",
        // which would silently downgrade a live reading to the recorded fallback.
        let out = "Update available: 2.1.9 -> 2.1.221\n{\"loggedIn\":false}\n";
        let s = parse_claude_auth_status(out).expect("banner must not defeat the parse");
        assert!(!s.logged_in);
        assert_eq!(s.source, AuthStatusSource::Cli);
    }

    #[test]
    fn parse_claude_auth_status_rejects_anything_without_a_boolean_loggedin() {
        // Each of these must be `None` so the caller FAILS OPEN. If any parsed to a status, it would
        // arrive as `logged_in: false, source: Cli` — the one combination allowed to block the whole
        // app — on the strength of garbage.
        for junk in [
            "",
            "not json at all",
            "{}",
            r#"{"loggedIn":"yes"}"#,
            r#"{"logged_in":true}"#,
            r#"{"error":"unknown command 'auth'"}"#,
        ] {
            assert!(
                parse_claude_auth_status(junk).is_none(),
                "must not parse: {junk:?}"
            );
        }
    }

    // THE PROBE MUST ASK ABOUT THE SAME CREDENTIAL THE CONCIERGE USES. Asserted on the built
    // Command's env rather than by spawning, because this scrub is invisible at runtime when it
    // regresses: with `ANTHROPIC_API_KEY` inherited, `claude auth status` cheerfully reports a
    // healthy API-key posture while the concierge's OAuth session is dead — the exact false
    // "you're signed in" this command was added to end (roborev 57985).
    #[test]
    fn the_auth_probe_scrubs_every_anthropic_env_override() {
        let cmd = claude_auth_status_command("/bin/claude", None);
        let removed: Vec<String> = cmd
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        for name in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_API",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_CUSTOM_HEADERS",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
        ] {
            assert!(
                removed.contains(&name.to_string()),
                "{name} not scrubbed from the auth probe; got {removed:?}"
            );
        }
    }

    #[test]
    fn the_auth_probe_asks_the_cli_for_json_status() {
        // Pins the argv. `auth status --json` is three separate facts (the `auth` prefix that the
        // login bug was missing, the `status` subcommand, and the JSON the parser expects), and
        // getting any of them wrong degrades silently to the recorded fallback.
        let cmd = claude_auth_status_command("/bin/claude", None);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["auth", "status", "--json"]);
    }

    #[test]
    fn the_auth_probe_targets_an_explicit_account_config_dir() {
        let cmd = claude_auth_status_command("/bin/claude", Some(Path::new("/acc/dir")));
        let set: Vec<(String, String)> = cmd
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
            .collect();
        assert!(
            set.contains(&("CLAUDE_CONFIG_DIR".to_string(), "/acc/dir".to_string())),
            "an explicit account dir must be probed in its own config dir; got {set:?}"
        );
        // And with no dir given, nothing is set — the machine-wide login is the target.
        let plain = claude_auth_status_command("/bin/claude", None);
        assert!(
            !plain
                .get_envs()
                .any(|(k, v)| k == "CLAUDE_CONFIG_DIR" && v.is_some()),
            "no config dir given must mean the machine-wide login, not an empty override"
        );
    }

    #[test]
    fn a_live_cli_no_beats_a_recorded_yes() {
        // THE FOUNDER'S BUG, as a unit test. The machine has a perfectly good recorded identity from
        // a login that succeeded weeks ago — `claude_signed_in_sync` says `true` for this same dir —
        // but the CLI now reports the session dead. The live reading must win, because the recorded
        // one is what let an expired session masquerade as healthy all the way to the concierge.
        let base = unique_dir("auth-live-no");
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#);
        assert!(
            claude_signed_in_sync(Some(base.to_string_lossy().into_owned())),
            "precondition: the stale recorded identity still reads as signed in"
        );

        let s = claude_auth_status_with(Some(&base), None, || {
            Some(r#"{"loggedIn":false}"#.to_string())
        });
        assert!(!s.logged_in, "a live CLI 'no' must not be overridden");
        assert_eq!(s.source, AuthStatusSource::Cli);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_unavailable_probe_falls_back_to_the_recorded_identity() {
        // FAIL-OPEN. `None` from the probe means the binary is missing, the subcommand is unknown on
        // an older Claude Code, or it timed out. None of those is evidence the user is signed out,
        // and this drives a gate that can block the app — so the recorded identity carries it, and
        // `source` says the answer is only a memory.
        let base = unique_dir("auth-probe-dead");
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#);
        let s = claude_auth_status_with(Some(&base), None, || None);
        assert!(s.logged_in, "a broken probe must never lock the user out");
        assert_eq!(s.source, AuthStatusSource::Recorded);
        assert_eq!(s.email.as_deref(), Some("me@example.com"));

        // Garbage on stdout takes the same path as no answer at all.
        let s = claude_auth_status_with(Some(&base), None, || Some("segfault".to_string()));
        assert!(s.logged_in);
        assert_eq!(s.source, AuthStatusSource::Recorded);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_fresh_machine_with_no_probe_and_no_identity_is_absent() {
        // The genuine first-run case — nothing has ever signed in here. This is the ONE way to get a
        // blocking `false` without a live CLI answer, and it is correct: there is nothing to lock the
        // user out OF, because they cannot run an agent either.
        let base = unique_dir("auth-fresh");
        std::fs::create_dir_all(&base).unwrap();
        let s = claude_auth_status_with(Some(&base), None, || None);
        assert!(!s.logged_in);
        assert_eq!(s.source, AuthStatusSource::Absent);
        assert_eq!(s.email, None);
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
    fn identity_json_path_uses_home_dot_claude_json_not_the_state_dir() {
        // THE bug this function exists to prevent. With no CLAUDE_CONFIG_DIR, Claude Code's config
        // is $HOME/.claude.json — the FILE beside the state dir, not a file inside it. Reading
        // $HOME/.claude/.claude.json instead reports "not signed in" for a signed-in user.
        let home = Path::new("/home/me");
        assert_eq!(
            identity_json_path(None, Some(home)),
            Some(PathBuf::from("/home/me/.claude.json"))
        );
        assert_ne!(
            identity_json_path(None, Some(home)),
            Some(PathBuf::from("/home/me/.claude/.claude.json")),
            "the state dir is not the config file's home"
        );
        // An empty config dir is the default account and resolves the same way.
        assert_eq!(
            identity_json_path(Some(Path::new("")), Some(home)),
            Some(PathBuf::from("/home/me/.claude.json"))
        );
        // An explicit dir means the spawn exports CLAUDE_CONFIG_DIR=<dir>, so the config lands
        // INSIDE it — including when that dir happens to be ~/.claude (pre-fix installs).
        assert_eq!(
            identity_json_path(Some(Path::new("/data/accounts/x")), Some(home)),
            Some(PathBuf::from("/data/accounts/x/.claude.json"))
        );
        assert_eq!(
            identity_json_path(Some(Path::new("/home/me/.claude")), Some(home)),
            Some(PathBuf::from("/home/me/.claude/.claude.json"))
        );
        // No dir and no home → None.
        assert_eq!(identity_json_path(None, None), None);
        // GUARD: an empty config dir WITHOUT a home fallback → None (the way `accounts_identities`
        // calls it for a NAMED account: passing home = None so an empty/missing dir can't
        // mislabel the home user's identity as this account's).
        assert_eq!(identity_json_path(Some(Path::new("")), None), None);
        assert_eq!(read_oauth_identity_at(Some(Path::new("")), None), None);
    }

    #[test]
    fn read_oauth_identity_defaults_to_home_dot_claude_json_when_dir_absent() {
        // End-to-end of the above: the identity of a user who just runs `claude` in a terminal.
        let home = unique_dir("identity-home");
        std::fs::write(
            home.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"default@example.com","organizationName":"Home Org"}}"#,
        )
        .unwrap();
        // A stale config left in the STATE dir must not be mistaken for the live one — this is
        // precisely the file pair that made Sparkle report the wrong account.
        write_claude_json(
            &home.join(".claude"),
            r#"{"oauthAccount":{"emailAddress":"stale@example.com"}}"#,
        );
        assert_eq!(
            read_oauth_identity_at(None, Some(&home)),
            Some(OauthIdentity {
                email: "default@example.com".to_string(),
                organization: Some("Home Org".to_string()),
                account_uuid: None,
            })
        );
        // And the same for the default account, which stores its config dir as "".
        assert_eq!(
            read_oauth_identity_at(Some(Path::new("")), Some(&home)).map(|i| i.email),
            Some("default@example.com".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A `$HOME` stand-in: `.claude/` (state dir) plus optionally a login in either location.
    /// `state_email` seeds `<home>/.claude/.claude.json`; `home_email` seeds `<home>/.claude.json`.
    fn fake_home(tag: &str, state_email: Option<&str>, home_email: Option<&str>) -> PathBuf {
        let home = unique_dir(tag);
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        if let Some(e) = state_email {
            write_claude_json(
                &home.join(".claude"),
                &format!(r#"{{"oauthAccount":{{"emailAddress":"{e}"}}}}"#),
            );
        }
        if let Some(e) = home_email {
            std::fs::write(
                home.join(".claude.json"),
                format!(r#"{{"oauthAccount":{{"emailAddress":"{e}"}}}}"#),
            )
            .unwrap();
        }
        home
    }

    fn default_at(home: &Path) -> Account {
        sample("d", true, home.join(".claude").to_str().unwrap())
    }

    #[test]
    fn pre_fix_default_is_normalized_only_when_the_rewrite_cannot_change_accounts() {
        // The user never completed the duplicate login the old bug pushed them toward, so
        // `<home>/.claude` is empty and their real login sits unread at `<home>/.claude.json`.
        // Rewriting cannot switch accounts — there is none at `<home>/.claude` to leave.
        let home = fake_home("norm-yes", None, Some("real@example.com"));
        assert!(default_config_dir_needs_normalizing(&default_at(&home), Some(&home)));
        let _ = std::fs::remove_dir_all(&home);

        // The user DID log in under `<home>/.claude`. That record is self-consistent, and migrating
        // it would silently move their agents from one Anthropic account to another.
        let home = fake_home("norm-both", Some("sparkle@example.com"), Some("real@example.com"));
        assert!(!default_config_dir_needs_normalizing(&default_at(&home), Some(&home)));
        let _ = std::fs::remove_dir_all(&home);

        // NO login anywhere — a fresh install. Still migrate: leaving the record exporting
        // `$HOME/.claude` means the user's very NEXT sign-in lands there and forks from the
        // terminal login right then, which is the whole trap merely deferred.
        let home = fake_home("norm-neither", None, None);
        assert!(default_config_dir_needs_normalizing(&default_at(&home), Some(&home)));
        // A NAMED account is never touched, whatever its dir holds.
        let mut named = default_at(&home);
        named.is_default = false;
        assert!(!default_config_dir_needs_normalizing(&named, Some(&home)));
        // Nor is a default pointing somewhere other than `<home>/.claude`.
        assert!(!default_config_dir_needs_normalizing(
            &sample("d", true, "/data/accounts/x"),
            Some(&home)
        ));
        // Already migrated → no-op (and no re-entry loop on every app start).
        assert!(!default_config_dir_needs_normalizing(&sample("d", true, ""), Some(&home)));
        // No home to compare against → never guess.
        assert!(!default_config_dir_needs_normalizing(&default_at(&home), None));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn normalize_rewrites_the_record_once_and_is_idempotent() {
        let home = fake_home("norm-write", None, Some("real@example.com"));
        let base = unique_dir("norm-write-accts");
        let path = accounts_json_path(&base);
        write_accounts_at(&path, &[default_at(&home), sample("n", false, "/data/x")]).unwrap();

        assert!(normalize_default_config_dir_at(&path, Some(&home), "").unwrap());
        let after = read_accounts_at(&path).unwrap();
        assert_eq!(after[0].config_dir, "", "default migrated to the no-override sentinel");
        assert_eq!(after[1].config_dir, "/data/x", "named account untouched");

        // Second pass changes nothing and reports no write.
        assert!(!normalize_default_config_dir_at(&path, Some(&home), "").unwrap());
        assert_eq!(read_accounts_at(&path).unwrap(), after);

        // And the migrated record now resolves to the terminal's real login.
        assert_eq!(
            read_oauth_identity_at(Some(Path::new(&after[0].config_dir)), Some(&home))
                .map(|i| i.email),
            Some("real@example.com".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn normalize_stores_the_login_shells_dir_when_it_has_one() {
        // A user whose `.zprofile` exports CLAUDE_CONFIG_DIR: the spawn (`zsh -l -c`) sources that
        // FIRST, so the child really does use their dir. Recording "" would point every read —
        // identity, transcripts, session detection — at $HOME while the child used /custom/dir.
        let home = fake_home("norm-shell", None, Some("real@example.com"));
        let base = unique_dir("norm-shell-accts");
        let path = accounts_json_path(&base);
        write_accounts_at(&path, &[default_at(&home)]).unwrap();

        assert!(normalize_default_config_dir_at(&path, Some(&home), "/custom/dir").unwrap());
        assert_eq!(read_accounts_at(&path).unwrap()[0].config_dir, "/custom/dir");
        // Read and write sides now agree on where that account's transcripts live.
        assert_eq!(
            projects_root_for_account(&read_accounts_at(&path).unwrap()[0]),
            Some(PathBuf::from("/custom/dir/projects"))
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&base);

        // And when the shell's value IS `<home>/.claude`, the record already says that — no
        // pointless rewrite on every app start.
        let home = fake_home("norm-shell-same", None, None);
        let base = unique_dir("norm-shell-same-accts");
        let path = accounts_json_path(&base);
        write_accounts_at(&path, &[default_at(&home)]).unwrap();
        let same = home.join(".claude").to_string_lossy().into_owned();
        assert!(!normalize_default_config_dir_at(&path, Some(&home), &same).unwrap());
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn spend_and_usage_still_see_a_migrated_default() {
        // Regression guard for the call site `accounts_spend` uses: with config_dir "", resolving
        // WITHOUT a home yields None and the default account silently drops out of spend totals.
        let home = fake_home("spend-empty", None, Some("real@example.com"));
        let migrated = sample("d", true, "");
        // Seed a transcript where a no-override spawn would actually write it.
        let slug = home.join(".claude").join("projects").join("-tmp-proj");
        std::fs::create_dir_all(&slug).unwrap();
        std::fs::write(
            slug.join("s.jsonl"),
            b"{\"timestamp\":\"2099-01-01T00:00:00Z\",\"message\":{\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":10,\"output_tokens\":20}}}\n",
        )
        .unwrap();

        // The un-homed form is exactly what dropped the account; supplying the home is the fix.
        // (Asserted against the resolver directly rather than through `projects_root_for_account`,
        // which reads $HOME — mutating that would race every other test in this binary.)
        assert_eq!(
            crate::claude::claude_projects_root(Some(Path::new(&migrated.config_dir)), None),
            None,
            "this is the shape that silently skipped the default account"
        );
        let root = crate::claude::claude_projects_root(
            Some(Path::new(&migrated.config_dir)),
            Some(&home),
        );
        assert_eq!(root, Some(home.join(".claude").join("projects")));
        let mut records = Vec::new();
        collect_usage_records(&root.unwrap(), 0, &mut records);
        assert!(!records.is_empty(), "a migrated default must still contribute usage records");

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn import_default_stores_empty_config_dir_when_no_env_override() {
        // "No CLAUDE_CONFIG_DIR" must be recorded as EMPTY, not as $HOME/.claude: exporting
        // $HOME/.claude relocates the config to $HOME/.claude/.claude.json, so the imported
        // "default" would be a blank profile rather than the terminal's actual login.
        let base = unique_dir("import-default-empty");
        let path = accounts_json_path(&base);
        let acct = import_default_at(&path, String::new(), "d1".into(), 7).unwrap();
        assert_eq!(acct.config_dir, "");
        assert!(acct.is_default);

        // Idempotent: a second import returns the SAME record rather than adding another default.
        let again = import_default_at(&path, "/some/other".into(), "d2".into(), 9).unwrap();
        assert_eq!(again, acct);
        assert_eq!(read_accounts_at(&path).unwrap().len(), 1);

        // An empty config dir must never be turned into a relative `projects/` root, and must
        // never be deleted as if it were a real per-account dir.
        assert_eq!(dir_to_remove_on_remove(&acct), None);
        assert_eq!(
            crate::claude::claude_projects_root(Some(Path::new("")), Some(Path::new("/home/me"))),
            Some(PathBuf::from("/home/me/.claude/projects"))
        );
        let _ = std::fs::remove_dir_all(&base);
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

    /// The price TABLE being shared isn't enough if the INPUTS aren't: reading only the flat
    /// `cache_creation_input_tokens` billed every 1h-TTL write at 1.25x here and 2x in the pane.
    #[test]
    fn read_usage_counts_splits_cache_writes_by_ttl_like_the_pane() {
        let with_breakdown = serde_json::json!({
            "input_tokens": 1,
            "output_tokens": 2,
            "cache_creation_input_tokens": 900,
            "cache_creation": { "ephemeral_5m_input_tokens": 600, "ephemeral_1h_input_tokens": 300 },
            "cache_read_input_tokens": 50
        });
        assert_eq!(read_usage_counts(&with_breakdown), (1, 2, 600, 300, 50));

        // No breakdown (older transcripts): the whole total is the default 5m TTL, never guessed high.
        let flat = serde_json::json!({
            "input_tokens": 1, "output_tokens": 2,
            "cache_creation_input_tokens": 900, "cache_read_input_tokens": 50
        });
        assert_eq!(read_usage_counts(&flat), (1, 2, 900, 0, 50));

        // And the record built from the breakdown costs what the pane's record costs.
        let rec = SpendRecord {
            ts: 0,
            message_id: None,
            model: Some("claude-opus-4-8".into()),
            input: 1,
            output: 2,
            cache_write_5m: 600,
            cache_write_1h: 300,
            cache_read: 50,
        };
        assert_eq!(
            rec.cost_usd(),
            crate::spend::estimate_cost_usd("claude-opus-4-8", 1, 2, 600, 300, 50)
        );
    }

    /// Set a file's mtime exactly. Sleeping between writes leaves the ordering at the mercy of the
    /// filesystem's timestamp granularity, which turns an ordering test into a coin flip on some
    /// hosts.
    fn set_mtime(path: &Path, epoch_secs: u64) {
        let t = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(epoch_secs);
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }

    /// The registry's LIFECYCLE through the real guard: live while the `UsagePass` exists,
    /// evictable once it drops. Deleting the retire step left every test green while making every
    /// generation permanently live — tier 1 then matches nothing, forever, and this memo has no
    /// stale sweep to heal it.
    #[test]
    fn a_usage_pass_is_exempt_while_live_and_evictable_once_it_ends() {
        let live = UsagePass::start();
        let dead = UsagePass::start();
        let (live_id, dead_id) = (live.id(), dead.id());
        drop(dead);

        let mut cache = UsageCache::new();
        usage_cache_store(&mut cache, Path::new("/live.jsonl"), SystemTime::UNIX_EPOCH, 1, vec![], live_id);
        usage_cache_store(&mut cache, Path::new("/dead.jsonl"), SystemTime::UNIX_EPOCH, 1, vec![], dead_id);

        // The production predicate, not a stub.
        let is_live =
            |g: u64| live_usage_passes().lock().unwrap_or_else(|e| e.into_inner()).contains(&g);
        crate::spend::evict_two_tier(&mut cache, 1, 100, is_live, |c| (c.last_touch, c.modified));

        assert!(cache.contains_key(Path::new("/live.jsonl")), "a running pass's entry is exempt");
        assert!(!cache.contains_key(Path::new("/dead.jsonl")), "a finished pass's entry is not");

        drop(live);
        assert!(
            !live_usage_passes().lock().unwrap().contains(&live_id),
            "the guard clears itself — no leak, even on an unwind"
        );
    }

    /// Two roots reaching ONE tree by different spellings — an account `projects/` symlinked to
    /// `~/.claude/projects`. A nested-directory test can't catch this: there both roots produce
    /// identical raw paths, so a raw-path key passes.
    #[test]
    fn two_spellings_of_one_tree_scan_it_once() {
        let base = unique_dir("aliased-roots");
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(
            real.join("s.jsonl"),
            "{\"timestamp\":\"2026-06-25T21:20:25.931Z\",\"type\":\"assistant\",\
             \"message\":{\"model\":\"claude-haiku-4-5\",\"usage\":{\"input_tokens\":9,\
             \"output_tokens\":0,\"cache_creation_input_tokens\":0,\
             \"cache_read_input_tokens\":0}}}\n",
        )
        .unwrap();
        let alias = base.join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();

        let mut out = Vec::new();
        collect_usage_records_across(&[real.clone(), alias.clone()], 0, &mut out, 1);
        assert_eq!(out.len(), 1, "one file behind two spellings is parsed once");
        assert_eq!(out[0].input, 9);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Overlapping roots — one nested under the other — are not caught by the canonical-key set,
    /// which only collapses IDENTICAL trees. Without a path dedupe the shared transcript is parsed
    /// twice and its id-less records count twice.
    #[test]
    fn overlapping_roots_scan_a_shared_transcript_once() {
        let base = unique_dir("nested-roots");
        let outer = base.join("outer");
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        // No message id, so nothing downstream can collapse the duplicate for us.
        let body = "{\"timestamp\":\"2026-06-25T21:20:25.931Z\",\"type\":\"assistant\",\
                    \"message\":{\"model\":\"claude-haiku-4-5\",\"usage\":{\"input_tokens\":7,\
                    \"output_tokens\":0,\"cache_creation_input_tokens\":0,\
                    \"cache_read_input_tokens\":0}}}\n";
        std::fs::write(nested.join("s.jsonl"), body).unwrap();

        let mut out = Vec::new();
        collect_usage_records_across(&[outer.clone(), nested.clone()], 0, &mut out, 1);
        assert_eq!(out.len(), 1, "the shared transcript is parsed once, not once per root");
        assert_eq!(out[0].input, 7);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Sorting per ROOT yields "root order, then mtime", so an id contested ACROSS roots still
    /// resolved differently here than in the pane, which sorts the whole set. One global sort.
    #[test]
    fn collect_usage_records_across_sorts_every_root_together() {
        let base = unique_dir("scan-order-roots");
        let a = base.join("a");
        let b = base.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let line = |ts: &str, input: u64| {
            format!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"id\":\"msg_1\",\
                 \"model\":\"claude-haiku-4-5\",\"usage\":{{\"input_tokens\":{input},\
                 \"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}}}}\n"
            )
        };
        // The NEWER file lives in the FIRST root, so root-order-then-mtime and global-mtime
        // disagree — the only arrangement that can tell them apart. mtimes are SET, not slept for.
        std::fs::write(b.join("older.jsonl"), line("2026-06-25T21:20:25.931Z", 111)).unwrap();
        std::fs::write(a.join("newer.jsonl"), line("2026-06-25T21:20:26.931Z", 222)).unwrap();
        set_mtime(&b.join("older.jsonl"), 1_700_000_000);
        set_mtime(&a.join("newer.jsonl"), 1_700_000_060);

        let mut out = Vec::new();
        collect_usage_records_across(&[a.clone(), b.clone()], 0, &mut out, 1);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].input, 111, "oldest mtime first, whichever root it is in");
        assert_eq!(out[1].input, 222, "so last-copy-wins still means the newer transcript");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The pane's `dedupe_window` means "the newer transcript wins" only because `load_records`
    /// hands it records oldest-mtime-first. Parsing in `read_dir` order made the pill's winner
    /// inode-dependent — different between runs on one tree, and different from the pane's.
    #[test]
    fn collect_usage_records_parses_oldest_transcript_first() {
        let base = unique_dir("scan-order");
        let proj = base.join("projects").join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let line = |ts: &str, input: u64| {
            format!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\"id\":\"msg_1\",\
                 \"model\":\"claude-haiku-4-5\",\"usage\":{{\"input_tokens\":{input},\
                 \"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}}}}\n"
            )
        };
        // `zzz` is the OLDER file and sorts LAST alphabetically, so read_dir/path order and mtime
        // order disagree — the only arrangement in which this assertion means anything. mtimes are
        // SET, not slept for: a filesystem with coarse granularity would otherwise tie them and the
        // path tiebreak would invert the expectation, failing for a reason unrelated to the code.
        std::fs::write(proj.join("zzz.jsonl"), line("2026-06-25T21:20:25.931Z", 111)).unwrap();
        std::fs::write(proj.join("aaa.jsonl"), line("2026-06-25T21:20:26.931Z", 222)).unwrap();
        set_mtime(&proj.join("zzz.jsonl"), 1_700_000_000);
        set_mtime(&proj.join("aaa.jsonl"), 1_700_000_060);

        let mut out = Vec::new();
        collect_usage_records(&proj, 0, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].input, 111, "the older transcript is parsed first");
        assert_eq!(out[1].input, 222, "so last-copy-wins attributes the turn to the newer one");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The pill and the Spend pane must value the SAME record identically. They used to disagree by
    /// 5x on `claude-opus-4-*` and ~40% on `claude-opus-4-5-*`, because this module carried its own
    /// four-model table with a Sonnet fallback for everything else.
    #[test]
    fn cost_usd_uses_the_same_price_table_as_the_spend_pane() {
        let one_of_each = |model: &str| SpendRecord {
            ts: 0,
            message_id: None,
            model: Some(model.to_string()),
            input: 1_000_000,
            output: 1_000_000,
            cache_write_5m: 1_000_000,
            cache_write_1h: 0,
            cache_read: 1_000_000,
        };
        for model in [
            "claude-opus-4-8",
            "claude-opus-4-5-20251101",
            "claude-opus-4-20250514",
            "claude-haiku-4-5-20251001",
            "claude-sonnet-5",
        ] {
            let rec = one_of_each(model);
            let pane = crate::spend::estimate_cost_usd(model, 1_000_000, 1_000_000, 1_000_000, 0, 1_000_000);
            assert_eq!(rec.cost_usd(), pane, "{model} must cost the same in both surfaces");
            assert!(rec.cost_usd().is_some(), "{model} is priced");
        }
        // An unpriced model yields NO dollar figure rather than a guessed one — the pane's stance,
        // and the only one that lets the pill say the total excludes something.
        assert_eq!(one_of_each("totally-unknown-model").cost_usd(), None);
        assert_eq!(SpendRecord { model: None, ..one_of_each("x") }.cost_usd(), None);
    }

    /// The window is applied BEFORE the dedupe, as in `spend::dedupe_window`. Deduping first let an
    /// out-of-window copy win its id and then be filtered away, dropping the in-window turn
    /// entirely — a silent undercount that only shows up when a resume straddles the window edge.
    /// The upper bound matters for the same reason: a clock-skewed transcript must not count here
    /// while the pane drops it.
    #[test]
    fn spend_summary_windows_before_deduping_and_drops_future_records() {
        let now = 1_000_000_000;
        let copy = |ts: i64, input: u64| SpendRecord {
            ts,
            message_id: Some("msg_1".to_string()),
            model: Some("claude-haiku-4-5".to_string()),
            input,
            output: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 0,
        };

        // The OUT-OF-WINDOW copy comes last, so a dedupe-first pass would let it win the id.
        let s = spend_summary(&[copy(now - 60, 1_000_000), copy(now - WINDOW_7D - 60, 9)], now);
        assert_eq!(s.tokens_7d, 1_000_000, "the in-window copy is the one that counts");
        assert!((s.spend_7d_usd - 1.0).abs() < 1e-9);

        // A clock-skewed record dated in the future is dropped, not counted twice over.
        let future = spend_summary(&[copy(now + 3_600, 5_000_000)], now);
        assert_eq!(future.tokens_7d, 0, "a future-dated record is out of the window");
    }

    /// A resume copies prior turns into the new transcript; both files are under the same root, so
    /// the pill saw the same turn twice while the pane (which dedupes) saw it once.
    #[test]
    fn spend_summary_counts_a_resumed_turn_once() {
        let now = 1_000_000_000;
        let turn = |input: u64| SpendRecord {
            ts: now - 60,
            message_id: Some("msg_1".to_string()),
            model: Some("claude-haiku-4-5".to_string()),
            input,
            output: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 0,
        };
        // The original and the copy a resume wrote; the LAST copy wins, as in spend::dedupe_window.
        let s = spend_summary(&[turn(1_000_000), turn(2_000_000)], now);
        assert_eq!(s.tokens_today, 2_000_000, "one turn, not two");
        assert!((s.spend_today_usd - 2.0).abs() < 1e-9, "haiku $1/MTok × 2M, got {}", s.spend_today_usd);
    }

    // ── A REGISTERED COMMAND WITH NO CALLER (roborev 53601) ───────────────────────────────────────
    // `accounts_spend` is still in lib.rs's invoke_handler, but the concierge spend pill that used
    // to call it was deleted along with `stores/spendStore.ts` — so nothing in the app exercises it
    // end-to-end any more. That is a deliberate decision (the transcript scan and price table are
    // the expensive part and would only have to be rebuilt), but it means the ONLY thing standing
    // between this command and silent rot is what is asserted here.
    //
    // The three tests above already cover `spend_summary`'s arithmetic — windows, dedupe, bucketing,
    // the unpriced-model flag. What they do NOT cover is the two things that can break with no
    // compile error anywhere in the workspace, precisely because there is no TS caller left to break.

    #[test]
    fn accounts_spend_stays_registered_so_a_future_binding_has_something_to_call() {
        // Deleting the handler line compiles fine and breaks nothing — until someone re-adds the
        // frontend binding and gets "command not found" at runtime. Read from lib.rs's own source,
        // the same include_str! coherence trick worktree.rs and capture_window.rs use.
        let lib_rs = include_str!("lib.rs");
        assert!(
            lib_rs.contains("accounts::accounts_spend"),
            "accounts_spend was dropped from lib.rs's invoke_handler. It has no TS caller today \
             (the concierge spend pill was deleted), so nothing else would have failed. Either \
             restore the registration or delete the command, SpendSummary and these tests together."
        );
    }

    #[test]
    fn spend_summary_serializes_the_camelCase_wire_shape_a_future_binding_needs() {
        // The field NAMES are the contract a re-added `services/accountStore.ts` binding would be
        // written against, and `#[serde(rename_all = "camelCase")]` means a Rust-side rename changes
        // the JSON key silently — no compile error, and no TS consumer left to notice. Asserted as
        // the exact key set rather than field-by-field so an ADDED field also has to be considered.
        let s = spend_summary(&[], 1_000_000_000);
        let v = serde_json::to_value(&s).expect("SpendSummary serializes");
        let obj = v.as_object().expect("SpendSummary is a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "fallbackModelRecords",
                "spend7dUsd",
                "spendTodayUsd",
                "tokens7d",
                "tokensToday",
            ],
            "the SpendSummary wire shape changed; a re-added TS binding would read undefined"
        );
    }

    #[test]
    fn spend_summary_today_is_always_a_subset_of_7d() {
        // The invariant that makes the two windows readable together, and the one a future edit to
        // the bucketing is most likely to break: "today" is the trailing 24h INSIDE the trailing 7d,
        // so neither its dollars nor its tokens can ever exceed the wider window's.
        let now = 1_000_000_000;
        let rec = |ts: i64, id: &str| SpendRecord {
            ts,
            message_id: Some(id.to_string()),
            model: Some("claude-haiku-4-5".to_string()),
            input: 1_000_000,
            output: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 0,
        };
        for records in [
            vec![],
            vec![rec(now - 60, "a")],
            vec![rec(now - 60, "a"), rec(now - WINDOW_24H - 60, "b")],
            vec![rec(now - WINDOW_24H - 60, "b"), rec(now - WINDOW_7D - 60, "c")],
        ] {
            let s = spend_summary(&records, now);
            assert!(
                s.spend_today_usd <= s.spend_7d_usd + 1e-9,
                "today ${} exceeds 7d ${}",
                s.spend_today_usd,
                s.spend_7d_usd
            );
            assert!(
                s.tokens_today <= s.tokens_7d,
                "today {} tokens exceeds 7d {}",
                s.tokens_today,
                s.tokens_7d
            );
        }
    }

    #[test]
    fn spend_summary_buckets_today_and_7d_and_counts_fallback() {
        let now = 1_000_000_000;
        let haiku = |ts: i64, id: &str| SpendRecord {
            ts,
            message_id: Some(id.to_string()),
            model: Some("claude-haiku-4-5".to_string()),
            input: 1_000_000, // haiku input $1/MTok → $1.00 each
            output: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 0,
        };
        let unknown = SpendRecord {
            ts: now - 60,
            message_id: Some("unk".to_string()),
            model: Some("totally-unknown-model".to_string()),
            input: 1_000_000, // no published rate: tokens count, dollars can't
            output: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 0,
        };
        let records = vec![
            haiku(now - 60, "a"),               // within 24h → today + 7d ($1)
            haiku(now - WINDOW_24H - 60, "b"),  // outside 24h, inside 7d → 7d only ($1)
            haiku(now - WINDOW_7D - 60, "c"),   // older than 7d → excluded entirely
            unknown,                            // within 24h, UNPRICED (tokens only)
        ];
        let s = spend_summary(&records, now);
        assert!((s.spend_today_usd - 1.0).abs() < 1e-9, "today = $1 haiku; the unpriced record adds tokens, not dollars, got {}", s.spend_today_usd);
        assert!((s.spend_7d_usd - 2.0).abs() < 1e-9, "7d = $1 + $1, got {}", s.spend_7d_usd);
        assert_eq!(s.tokens_today, 2_000_000, "today tokens = 1M haiku + 1M unknown");
        assert_eq!(s.tokens_7d, 3_000_000, "7d tokens = 3 × 1M (the >7d record excluded)");
        assert_eq!(s.fallback_model_records, 1, "exactly one in-window unpriced-model record");
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
        assert_eq!(
            (first.input, first.output, first.cache_write_5m, first.cache_write_1h, first.cache_read),
            (10, 5, 2, 0, 3)
        );
        assert_eq!(first.total_tokens(), 20);

        // The model-less line: None model, so no dollar figure — its tokens still count, but the
        // pill reports it as unpriced instead of inventing a rate.
        assert_eq!(out[1].model, None);
        assert_eq!(out[1].cost_usd(), None, "a model-less record has no published rate");

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
            // Split across both TTLs on purpose: they price differently but count the same toward
            // a limit, so a `limit_tokens` that dropped either half would still pass a fixture
            // that put all the cache writes in one field.
            cache_write_5m: 1,
            cache_write_1h: 1,
            cache_read: 1_000,
            message_id: None,
        };
        assert_eq!(r.limit_tokens(), 17, "input + output + both cache-write TTLs only");
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
            cache_write_5m: u64::MAX,
            cache_write_1h: u64::MAX,
            cache_read: 0,
            message_id: None,
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
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 9_999, // must NOT be counted
            message_id: None,
        };
        let at = 100_000;
        let records = vec![
            rec(at - WINDOW_5H - 10, 1), // just outside → excluded
            rec(at - WINDOW_5H, 32),     // ON the low boundary → included, as in `bucket_tokens`
            rec(at - WINDOW_5H + 10, 2), // inside
            rec(at - 10, 4),             // inside
            rec(at, 8),                  // at the boundary → included
            rec(at + 10, 16),            // after the limit → excluded
        ];
        assert_eq!(consumption_before(&records, at), 32 + 2 + 4 + 8);
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

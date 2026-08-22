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
use tauri::{AppHandle, Manager, State};

use crate::identity_log::{self, IdentityLog};

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
    /// The [`identity_key`] that was signed in when [`exhausted_until`] was recorded.
    ///
    /// An exhaustion is a fact about an ANTHROPIC ACCOUNT, but it is stored on a REGISTRATION — and
    /// the identity behind a registration can change under it ("Switch login"). Without this, the
    /// new login inherits a bench it never earned: `usage_for_account` surfaces the old identity's
    /// `exhausted_until`, so `pickAccount` skips a perfectly usable account until that epoch passes.
    /// That is the same account-keyed-state-outliving-its-identity bug as the learned ceiling, on a
    /// different field (knightwatch, 2026-08-04).
    ///
    /// `None` on rows written before this field existed. Those are HONOURED rather than dropped:
    /// a limit resets within ~5h so they age out on their own, and wrongly routing work INTO an
    /// exhausted account is the worse of the two errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exhausted_identity: Option<String>,
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
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
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

    /// The identity a `claude` launched from the user's own LOGIN SHELL would run as. `Some` ONLY
    /// on the default account.
    ///
    /// Resolved through [`shell_identity_at`], i.e. `crate::claude::effective_spawn_config_dir()` —
    /// the `CLAUDE_CONFIG_DIR` that shell really exports, falling back to `$HOME/.claude.json` when
    /// it exports none (see [`identity_json_path`]). It is NOT hardcoded to `$HOME`: for a user who
    /// exports one in their dotfiles, the terminal reads that dir's config, which is the same file
    /// the default account reads, and reporting `$HOME`'s login as "your terminal" would announce a
    /// fork that does not exist.
    ///
    /// This exists because the two can legitimately diverge and nothing used to say so. A default
    /// account whose `config_dir` is `$HOME/.claude`, on a machine whose shell exports nothing,
    /// makes Sparkle export `CLAUDE_CONFIG_DIR=$HOME/.claude` and read
    /// `$HOME/.claude/.claude.json` while the terminal reads `$HOME/.claude.json`. On the machine
    /// that motivated this both files held valid logins to DIFFERENT Anthropic accounts, and the UI
    /// showed only one of them — so "my account is wrong" was really "Sparkle and my terminal are
    /// two different people".
    ///
    /// `shell_account_uuid != account_uuid` is the FORK condition the UI surfaces. We surface it and
    /// let the human choose; we never silently resolve it, which is exactly what
    /// [`default_config_dir_needs_normalizing`] refuses to do and for the same reason.
    ///
    /// `None` for a named account: its dir is its own truth and the shell's login says nothing
    /// about it.
    pub shell_email: Option<String>,
    pub shell_account_uuid: Option<String>,
    /// True when this account's config dir is known — from the identity-epoch ledger
    /// ([`crate::identity_log`]) — to have hosted a DIFFERENT identity key inside the ceiling learn
    /// window. Its learned history is therefore not attributable to the current login, which is what
    /// resets the ceiling (see [`AccountCeiling::reset_by_identity_change`]).
    ///
    /// The IDENTITY KEY, not the `accountUuid`: see [`identity_key`]. A login predating that field
    /// is tracked by email rather than being skipped, and one merely *gaining* a uuid it did not
    /// report before is a ladder climb, not a takeover — so this stays `false` through it.
    pub identity_changed: bool,
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
/// Tighten `path` to `mode` if it is currently WIDER, leaving an already-stricter mode alone.
///
/// Self-healing, not just correct-going-forward: every existing install already has a 0644
/// `accounts.json` and a 0755 `accounts/` on disk, and those users get nothing from a fix that only
/// applies at creation time. Never widens — a deployment that keeps things at 0400 must not be
/// loosened by its own hardening. No-op off Unix so the Windows build still compiles
/// (security audit 2026-08-08, M2).
#[cfg(unix)]
fn tighten_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else { return };
    let current = meta.permissions().mode() & 0o777;
    if current & !mode != 0 {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(current & mode));
    }
}
#[cfg(not(unix))]
fn tighten_mode(_path: &Path, _mode: u32) {}

fn write_accounts_at(path: &Path, accounts: &[Account]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir app data dir: {e}"))?;
        // The DIRECTORY too, not just the file. `create_dir_all` leaves the OS default (0755), so
        // any other local user could list every registered account — an agent did not even have to
        // guess an id. Matches what each per-account config dir already does two functions away.
        tighten_mode(parent, 0o700);
    }
    let json = serde_json::to_vec_pretty(accounts).map_err(|e| format!("serialize accounts: {e}"))?;
    // Temp file in the same dir so the final rename stays on one filesystem (atomic).
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("write accounts.json tmp: {e}"))?;
    // MODE SET ON THE TEMP FILE, BEFORE THE RENAME. `fs::write` creates at the umask default
    // (usually 0644), and a rename carries the source's mode across — so chmod'ing after the rename
    // leaves a window in which the real `accounts.json` exists world-readable. Ordering is the whole
    // point: same file, same bits, different exposure.
    //
    // The file holds no tokens, but it does carry account nicknames, the absolute path of every
    // account's config dir (a map of where the credentials live), and via `exhausted_identity` the
    // user's plaintext email.
    tighten_mode(&tmp, 0o600);
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup of the orphan temp
        format!("rename accounts.json into place: {e}")
    })?;
    // Self-heal an install that already has a 0644 file from before this fix.
    tighten_mode(path, 0o600);
    Ok(())
}

// ---- mutations (pure) ---------------------------------------------------------

/// Seed Sparkle's OWN control-plane allowlist into an added account's `settings.json`.
///
/// `CLAUDE_CONFIG_DIR` REPLACES `$HOME/.claude` rather than layering on it, so a `claude` Sparkle
/// runs on an added account reads none of the user's own grants. Agents that live in a managed
/// worktree are still covered — project settings resolve from the cwd, not from the config dir, so
/// the `.claude/settings.local.json` Sparkle writes into every worktree applies on any account.
/// The gap is every `claude` Sparkle runs OUTSIDE a managed worktree (concierge turns, one-shot
/// probes, improvement passes): those have no project layer at all, so on an added account they
/// cannot call Sparkle's own control plane without stopping to ask a human.
///
/// This is the narrowest place that closes it: the directory is Sparkle's own, created by Sparkle,
/// and only Sparkle's own rules are written into it. The user's PERSONAL grants are deliberately
/// not copied across accounts — replicating something like `bypassPermissions` onto a second
/// identity is a decision for the human, not a side effect of adding an account.
///
/// Best-effort and non-destructive: a `settings.json` that is present but unparseable is left
/// alone rather than replaced, because overwriting real state (an in-progress `claude login`, a
/// hand-edited file) to fix a permission nit is a far worse outcome than an extra prompt.
pub(crate) fn ensure_account_allowlist_at(config_dir: &Path) -> Result<(), String> {
    let file = config_dir.join("settings.json");
    // ══ ONLY `NotFound` MEANS "ABSENT" (knightwatch probe 1, blocking) ═══════════════════════════
    // This was `read_to_string(&file).ok()`, which collapses EVERY read failure into `None` — and
    // `None` is precisely the input that makes `merge_allowed_tools_settings` synthesise a FRESH
    // settings object. So an unreadable-but-present file (invalid UTF-8, EACCES, EIO, a transient
    // I/O error) was treated as a missing one and then OVERWRITTEN, erasing whatever it held:
    // permission DENIES, hooks, preferences. That is the exact opposite of this function's own
    // documented contract two paragraphs up, and it is unrecoverable — there is no prior copy.
    //
    // A read error that is not `NotFound` is therefore propagated, which lands in the same
    // best-effort caller arm as the unparseable-JSON case below: log and move on, leaving the file
    // untouched. An extra permission prompt is a nuisance; a destroyed settings.json is not.
    let existing = match std::fs::read_to_string(&file) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!(
                "cannot read account settings.json ({e}), leaving it untouched: {}",
                file.display()
            ))
        }
    };
    if let Some(s) = existing.as_deref() {
        if serde_json::from_str::<serde_json::Value>(s).is_err() {
            return Err(format!(
                "account settings.json is not valid JSON, leaving it untouched: {}",
                file.display()
            ));
        }
    }
    let merged = crate::worktree::merge_allowed_tools_settings(existing.as_deref());
    // …and the bypass-consent record. Claude Code gates BOTH `--dangerously-skip-permissions` (how
    // Sparkle launches every unattended worker) and `permissions.defaultMode: "bypassPermissions"`
    // behind a one-time interactive disclaimer, and an added account's config dir has never seen a
    // human press "Yes, I accept". So an agent spawned into a fresh account dir does not prompt —
    // it HANGS on a dialog nobody is watching, having produced nothing. Two workers were wedged
    // exactly this way, alive and idle for fourteen minutes with zero tool calls, while this was
    // being written; the human hit the same dialog by hand the same afternoon.
    //
    // ONLY the acceptance record is seeded here, never `defaultMode` and never the deny list: an
    // account-level bypass would apply to every `claude` on that identity, including runs with no
    // worktree and no guard hook. That is the distinction the paragraph above this function draws
    // between Sparkle's own rules (which belong here) and the user's personal grants (which do not)
    // — a consent record is neither a grant nor a personal preference, it is the acknowledgement
    // that makes the flags Sparkle already passes on the command line usable unattended.
    let merged = crate::worktree::merge_bypass_consent_settings(Some(&merged));
    if existing.as_deref() == Some(merged.as_str()) {
        return Ok(()); // already current — do not rewrite the file for nothing
    }
    std::fs::create_dir_all(config_dir).map_err(|e| format!("mkdir account dir: {e}"))?;
    // ══ WRITE VIA TEMP+RENAME, NOT IN PLACE (same probe) ═════════════════════════════════════════
    // `std::fs::write` TRUNCATES the live file and then fills it. A crash, a full disk, or the app
    // quitting inside that window leaves a truncated or empty settings.json where a working one
    // used to be — and a live `claude` on that account reads this file. `atomic_write_settings`
    // writes a sibling temp and renames it over the target, so a reader sees either the old file or
    // the new one and never a half-written one. It also re-validates the JSON before writing, which
    // makes "never clobber with invalid JSON" true on this path too rather than only on the hooks
    // path that already used it.
    crate::hooks::atomic_write_settings(&file, &merged)
        .map_err(|e| format!("write account settings.json: {e}"))
}

/// The Claude Code state file inside a config dir. Holds the onboarding markers and, once a login
/// completes, `oauthAccount`.
const CLAUDE_JSON: &str = ".claude.json";

/// The `lastOnboardingVersion` written into a FRESH marker. A stale value is harmless: it does not
/// re-run the wizard (`hasCompletedOnboarding` is the gate), it only lets Claude Code offer steps
/// added since. Deliberately not bumped automatically — nothing here should claim the user has seen
/// a screen that did not exist when this was written.
const ONBOARDING_VERSION: &str = "2.1.229";

/// Mark Claude Code's first-run onboarding as ALREADY DONE for `config_dir`.
///
/// `CLAUDE_CONFIG_DIR` replaces `$HOME/.claude` wholesale, so a config dir Sparkle mints starts with
/// no `.claude.json` at all — and Claude Code reads that as a first run. An agent spawned there gets
/// the theme picker and then "Select login method", and **the brief Sparkle types is consumed by the
/// wizard**. The agent reports as running and executes nothing. That is how one restart put an
/// entire 80-agent fleet into onboarding and cost the founder an evening.
///
/// ENSURES A KEY, RATHER THAN CREATING A FILE, and the distinction is the whole point. The obvious
/// shape — write the marker when `.claude.json` is absent — silently skips the worse case: a file
/// that EXISTS, carries a real `oauthAccount`, and simply has no `hasCompletedOnboarding`. Claude
/// Code runs the wizard for those too, and a create-if-missing pass steps right over them. Measured
/// on the founder's machine: two dirs were missing the file, but THREE signed-in dirs had the file
/// without the key — including a registered, actively-routed account. Fixing only the first two left
/// the fleet still landing in the picker.
///
/// Non-destructive, mirroring [`ensure_account_allowlist_at`] exactly, because this file holds the
/// login and there is no second copy:
///   * only `NotFound` counts as absent — an unreadable file is propagated, never treated as missing
///     and then overwritten;
///   * an unparseable file is refused and left byte-for-byte intact;
///   * an existing object is MERGED into (every other key survives), never replaced;
///   * a dir already marked complete is not rewritten at all;
///   * the write goes through [`crate::hooks::atomic_write_settings`], so a reader never sees a
///     partial file — and, because that is NOT the same guarantee, the read-modify-write is also
///     guarded against a LOST UPDATE (see below).
///
/// ══ ATOMIC WRITES DO NOT PREVENT A LOST UPDATE, AND THIS FILE HAS A LIVE SECOND WRITER ═════════
/// `.claude.json` is not `settings.json`. Claude Code OWNS it and rewrites the whole file itself —
/// on startup, on project-history updates, and at the moment a login completes. So this heal's
/// read → modify → rename has a window: anything `claude` writes between our read and our rename is
/// discarded wholesale, and the write most likely to land in that window is the freshly-completed
/// `oauthAccount`. Losing that is the unrecoverable case this function is otherwise written to
/// avoid, and it applies to precisely the population the heal targets — an already-signed-in dir
/// missing the key, healed by `accounts_list` while agents are live on it.
///
/// Atomicity answers concurrent READERS only, so it does not cover this; the guard is a
/// compare-and-swap on the file's (len, mtime). If either changed between the read and the write,
/// someone else wrote and we ABORT rather than clobber. The caller is best-effort and simply logs,
/// and the next `accounts_list` retries — a heal deferred by one pass costs nothing, while a heal
/// that eats a login costs the account.
///
/// It narrows the window rather than closing it: a write landing inside the stat-to-rename gap is
/// still lost, and mtime granularity can hide a same-instant write. There is no file lock available
/// across our process and Claude Code's, so this is the strongest guard on offer — stated plainly
/// so the next reader does not mistake it for mutual exclusion.
pub(crate) fn ensure_onboarding_marker_at(config_dir: &Path) -> Result<(), String> {
    ensure_onboarding_marker_with(config_dir, || {})
}

/// [`ensure_onboarding_marker_at`] with a seam that runs AFTER the read and BEFORE the write.
///
/// The seam exists so the lost-update guard can actually be tested. The race it defends against is
/// a write landing inside that exact window, and there is no way to produce that interleaving from
/// outside the function: writing the file before the call simply means the function reads the newer
/// content, whose stamp then matches at write time — a test written that way passes whether or not
/// the guard exists, which is the vacuous shape AGENTS.md warns about. Production passes a no-op, so
/// this is a seam on the real path rather than a second implementation.
fn ensure_onboarding_marker_with(
    config_dir: &Path,
    between_read_and_write: impl FnOnce(),
) -> Result<(), String> {
    let file = config_dir.join(CLAUDE_JSON);
    let existing = match std::fs::read_to_string(&file) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!(
                "cannot read account {CLAUDE_JSON} ({e}), leaving it untouched: {}",
                file.display()
            ))
        }
    };
    // The stamp we will re-check right before writing. `None` when the file is absent, which the
    // check below treats as "must still be absent" — a file that APPEARED since the read is a write
    // by someone else, and the empty object we built is not a merge of it.
    let stamp_at_read = file_stamp(&file);

    let mut obj = match existing.as_deref() {
        None => serde_json::Map::new(),
        Some(s) => match serde_json::from_str::<serde_json::Value>(s) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => {
                return Err(format!(
                    "account {CLAUDE_JSON} is not a JSON object, leaving it untouched: {}",
                    file.display()
                ))
            }
        },
    };

    if obj.get("hasCompletedOnboarding") == Some(&serde_json::Value::Bool(true)) {
        return Ok(()); // already complete — do not rewrite the file for nothing
    }

    obj.insert("hasCompletedOnboarding".into(), serde_json::Value::Bool(true));
    // `entry`-style defaults: fill these ONLY when absent, so a user's own theme or a real
    // `projects` map is never overwritten by a heal.
    for (k, v) in [
        ("lastOnboardingVersion", serde_json::json!(ONBOARDING_VERSION)),
        ("theme", serde_json::json!("dark")),
        ("hasSeenAutoModeEntryWarning", serde_json::json!(true)),
        ("hasResetAutoModeOptInForDefaultOffer", serde_json::json!(true)),
        ("projects", serde_json::json!({})),
    ] {
        obj.entry(k).or_insert(v);
    }

    std::fs::create_dir_all(config_dir).map_err(|e| format!("mkdir account dir: {e}"))?;
    let json = serde_json::to_string(&serde_json::Value::Object(obj))
        .map_err(|e| format!("serialize {CLAUDE_JSON}: {e}"))?;
    between_read_and_write(); // no-op in production; the test's simulated concurrent login
    // COMPARE-AND-SWAP: refuse if anyone wrote since we read. See the header — the write we are most
    // likely to be racing is a completed login, and overwriting that is unrecoverable.
    if file_stamp(&file) != stamp_at_read {
        return Err(format!(
            "{CLAUDE_JSON} changed while healing it (a live claude wrote to it); \
             leaving it alone and retrying on the next pass: {}",
            file.display()
        ));
    }
    crate::hooks::atomic_write_settings(&file, &json)
        .map_err(|e| format!("write account {CLAUDE_JSON}: {e}"))?;
    tighten_mode(&file, 0o600); // it holds the login once one completes
    Ok(())
}

/// `(len, mtime)` for `path`, or `None` when it does not exist / cannot be stat'd.
///
/// The change-detection stamp for the compare-and-swap in [`ensure_onboarding_marker_at`]. Both
/// components matter: a rewrite that happens to preserve the byte length still moves mtime, and a
/// same-mtime rewrite (coarse filesystem timestamps) usually changes the length. Neither is
/// sufficient alone and together they are still only a narrowing — which the caller's doc says.
fn file_stamp(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// Pre-seed Claude Code's per-project folder-TRUST acceptance for `worktree_path` into `config_dir`'s
/// `.claude.json`, so a worker spawned in that worktree with `--dangerously-skip-permissions` does
/// NOT stop on the interactive "Is this a project you trust? / 1. Yes, I trust this folder / 2. No,
/// exit" dialog.
///
/// ── A SEPARATE GATE FROM THE BYPASS CONSENT RECORD ──────────────────────────────────────────────
/// [`ensure_account_allowlist_at`] seeds `skipDangerousModePermissionPrompt` — the acceptance of the
/// `--dangerously-skip-permissions` DISCLAIMER. Folder trust is a DIFFERENT gate that the flag does
/// NOT waive. Verified against the shipped Claude Code 2.1.235 bundle: trust is read as
/// `config.projects[<abs cwd>].hasTrustDialogAccepted === true`, and the functions that gate on it
/// short-circuit only on `CLAUDE_CODE_SANDBOXED` / a managed-sandbox check / a parent-dir trust walk
/// — `--dangerously-skip-permissions` is not among them. So a worker whose config dir has never seen
/// THIS project still hits the trust dialog even with every permission bypass in place.
///
/// A fresh worktree path is a project the config dir has never trusted, by construction — and a
/// respawn after an app restart lands a worker into a worktree/config-dir pair that never recorded
/// it. The worker then HANGS on a dialog nobody is watching, alive and idle with zero tool calls
/// ("refused a write into a blocked prompt on a Claude Code screen"). This is one half of the
/// restart-wedge; the other half (onboarding, bypass consent) is already seeded above.
///
/// ── WHY THIS IS SAFE AT THIS SCOPE ──────────────────────────────────────────────────────────────
/// It trusts exactly ONE directory: Sparkle's own throwaway worktree, created by Sparkle under its
/// managed worktrees root, for Sparkle's own unattended worker. That is precisely the intent — the
/// app pre-trusts the directories IT made for the workers IT spawns — and it grants nothing wider:
/// it is not an account-level bypass, it does not trust the filesystem, and it touches no path the
/// user did not already delegate to Sparkle by choosing to run agents in it.
///
/// Non-destructive and CAS-guarded, IDENTICAL to [`ensure_onboarding_marker_at`] because it writes
/// the same live file Claude Code owns (`.claude.json`): only `NotFound` counts as absent; an
/// unparseable file is refused untouched; an existing `projects` map and every other key survive; a
/// worktree already carrying `hasTrustDialogAccepted: true` is not rewritten; the write goes through
/// [`crate::hooks::atomic_write_settings`]; and a compare-and-swap on `(len, mtime)` aborts rather
/// than clobber a login `claude` completed between our read and our write.
pub(crate) fn ensure_project_trusted_at(config_dir: &Path, worktree_path: &str) -> Result<(), String> {
    // BOUNDED RETRY, because the CAS below aborts rather than clobber a concurrent writer and a
    // single abort used to degrade — silently — into exactly the dialog this function exists to
    // prevent. `.claude.json` is written by every live `claude` in the fleet AND by every other
    // pane's seed, so on a machine running dozens of agents losing the race once is ordinary, not
    // exceptional. Retrying re-reads the file the winner just wrote, so each attempt is a fresh
    // read-modify-write and never resurrects stale content.
    const ATTEMPTS: usize = 5;
    let mut last = String::new();
    for attempt in 0..ATTEMPTS {
        match ensure_project_trusted_with(config_dir, worktree_path, || {}) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e;
                // Brief, growing backoff so a burst of concurrent seeds de-synchronizes instead of
                // colliding on the same instant. Short by design: this sits on the spawn path.
                if attempt + 1 < ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(20 * (attempt as u64 + 1)));
                }
            }
        }
    }
    Err(format!("folder-trust seed failed after {ATTEMPTS} attempts: {last}"))
}

/// Seed folder trust for `worktree_path` into EVERY registered account's config dir, plus `$HOME`
/// for the imported default account.
///
/// ── WHY EVERY ACCOUNT AND NOT JUST THE CHOSEN ONE ───────────────────────────────────────────────
/// Trust is recorded per (config dir × key). Sparkle runs multi-account rotation, and each account
/// has its OWN `CLAUDE_CONFIG_DIR` — so seeding only the account picked at spawn leaves the agent
/// one rotation away from an unseeded config dir and a fresh dialog. Rotation happens for reasons
/// that have nothing to do with this agent (a usage limit on an unrelated account, a manual switch),
/// so the re-prompt lands unpredictably and looks like a new bug every time.
///
/// Measured at filing time: the key that IS read was trusted in 5 of 12 account config dirs for one
/// project and ZERO of 12 for another, which is why that project's agents prompted without fail.
///
/// Best-effort PER ACCOUNT: one unwritable or unparseable config dir must not stop the others, so
/// failures are collected and returned as a summary rather than short-circuiting. An `Err` here is
/// still only a warning to the caller — the worst case is the pre-existing single prompt.
pub(crate) fn ensure_project_trusted_everywhere(
    app_data: &Path,
    worktree_path: &str,
) -> Result<(), String> {
    let dirs = seedable_config_dirs(app_data);

    let mut failures: Vec<String> = Vec::new();
    for dir in &dirs {
        // Only seed a config dir that EXISTS. Creating one for an account that was removed, or that
        // the user never logged into, would fabricate a config dir Claude Code then treats as a real
        // (logged-out) account — see `projects_entry_has_real_work`, which reads a trust-only entry
        // as "not real work" precisely so this cannot be mistaken for a login.
        if !dir.is_dir() {
            continue;
        }
        if let Err(e) = ensure_project_trusted_at(dir, worktree_path) {
            failures.push(format!("{}: {e}", dir.display()));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "folder trust seeded with {} failure(s): {}",
            failures.len(),
            failures.join("; ")
        ))
    }
}

/// The config dirs Sparkle may pre-seed trust into, for the AHEAD-OF-TIME paths (cross-account seed
/// and the sweep) that write to accounts this spawn is not using.
///
/// ── WHY `$HOME` IS CONDITIONAL HERE AND UNCONDITIONAL AT THE SPAWN ──────────────────────────────
/// `$HOME/.claude.json` is not just "the default account" — it is the user's OWN Claude Code config,
/// the one their plain `claude` in a terminal reads. Seeding a project root into it changes the
/// behaviour of a tool Sparkle does not own, outside Sparkle.
///
/// At a SPAWN that is still correct and necessary: the user picked the default account, so the agent
/// genuinely runs as their plain `claude` and the record is about a directory they are launching an
/// agent in right now. Ahead of time it is not: sweeping every project root into the personal config
/// of a user who may not even USE the default account would make a trust decision on their behalf
/// for sessions that have nothing to do with Sparkle.
///
/// So `$HOME` is included ONLY when a default account is actually REGISTERED (an `accounts.json`
/// entry that is `is_default`, or one carrying an empty `config_dir`, which is how the imported
/// default account is spelled). Note the trust key for a worktree is its MAIN REPO ROOT, so this is
/// a real widening to guard — it is not confined to Sparkle's own worktrees the way the screen-level
/// auto-answer is.
fn seedable_config_dirs(app_data: &Path) -> Vec<PathBuf> {
    let accounts = read_accounts_at(&accounts_json_path(app_data)).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let has_default = accounts
        .iter()
        .any(|a| a.is_default || a.config_dir.is_empty());
    if has_default {
        if let Some(h) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
            dirs.push(PathBuf::from(h));
        }
    }
    for a in accounts {
        if !a.config_dir.is_empty() {
            dirs.push(PathBuf::from(a.config_dir));
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

/// THE BACKSTOP SWEEP. Reconcile folder trust for every agent worktree on disk against every
/// account config dir, so a wedged agent is impossible rather than merely unlikely.
///
/// ── WHY A SWEEP IS NEEDED WHEN THE SPAWN ALREADY SEEDS ──────────────────────────────────────────
/// The per-spawn seed only ever runs at a spawn. It therefore cannot repair:
///   * the worktrees that already exist having never been seeded correctly (63 of 117 on the
///     reporting machine, because the seed wrote a key nothing read — bead `sparkle-ubee5u`);
///   * an account added, re-logged-in, or adopted AFTER the agents were spawned;
///   * a `.claude.json` that Claude Code itself replaced wholesale, taking the record with it.
/// In each of those the agent is already sitting on the dialog when the seed would have run, and
/// nothing goes back to look. That is exactly the reported symptom: a column of red agents that need
/// nothing from the human.
///
/// Cheap by construction: keys are de-duplicated across worktrees FIRST (every agent worktree of one
/// project shares its main checkout's key), so this is a handful of small JSON read-modify-writes,
/// not one per worktree. Returns the number of (key-set × config dir) seeds attempted.
///
/// Best-effort throughout — this runs on a listing path, and a failure to pre-seed must never take
/// the user's accounts away from them.
pub(crate) fn sweep_folder_trust_at(app_data: &Path) -> Result<usize, String> {
    let keys = crate::claude_trust::managed_worktree_trust_keys(app_data);
    if keys.is_empty() {
        return Ok(0);
    }
    let dirs = seedable_config_dirs(app_data);

    let mut seeded = 0usize;
    for dir in &dirs {
        // Never CREATE a config dir here — see `ensure_project_trusted_everywhere` for why a
        // fabricated dir is worse than a missing one.
        if !dir.is_dir() {
            continue;
        }
        if let Err(e) = ensure_keys_trusted_at(dir, &keys) {
            tracing::warn!(dir = %dir.display(), error = %e, "folder-trust sweep skipped a config dir");
            continue;
        }
        seeded += 1;
    }
    Ok(seeded)
}

/// [`ensure_keys_trusted_with`] with the same bounded CAS retry [`ensure_project_trusted_at`] uses.
fn ensure_keys_trusted_at(config_dir: &Path, keys: &[String]) -> Result<(), String> {
    const ATTEMPTS: usize = 5;
    let mut last = String::new();
    for attempt in 0..ATTEMPTS {
        match ensure_keys_trusted_with(config_dir, keys, || {}) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e;
                if attempt + 1 < ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(20 * (attempt as u64 + 1)));
                }
            }
        }
    }
    Err(format!("folder-trust seed failed after {ATTEMPTS} attempts: {last}"))
}

/// [`ensure_project_trusted_at`] with a seam that runs AFTER the read and BEFORE the write, so the
/// lost-update guard is testable on the real path (see [`ensure_onboarding_marker_with`] for why a
/// pre-write mutation is the only interleaving that exercises the CAS). Production passes a no-op.
fn ensure_project_trusted_with(
    config_dir: &Path,
    worktree_path: &str,
    between_read_and_write: impl FnOnce(),
) -> Result<(), String> {
    // THE KEYS CLAUDE CODE ACTUALLY READS — see `crate::claude_trust` and bead `sparkle-ubee5u`.
    let keys = crate::claude_trust::trust_keys_for(Path::new(worktree_path));
    ensure_keys_trusted_with(config_dir, &keys, between_read_and_write)
}

/// Seed an explicit, already-derived set of trust keys.
///
/// Split out from [`ensure_project_trusted_with`] so the startup sweep can work on keys that have
/// been DE-DUPLICATED across worktrees. Every agent worktree of one project derives the SAME key
/// (its main checkout), so sweeping by worktree would perform ~117 × 12 read-modify-writes on this
/// machine to write a handful of distinct values; sweeping by key performs a handful.
fn ensure_keys_trusted_with(
    config_dir: &Path,
    keys: &[String],
    between_read_and_write: impl FnOnce(),
) -> Result<(), String> {
    let file = config_dir.join(CLAUDE_JSON);
    let existing = match std::fs::read_to_string(&file) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!(
                "cannot read account {CLAUDE_JSON} ({e}), leaving it untouched: {}",
                file.display()
            ))
        }
    };
    let stamp_at_read = file_stamp(&file);

    let mut obj = match existing.as_deref() {
        None => serde_json::Map::new(),
        Some(s) => match serde_json::from_str::<serde_json::Value>(s) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => {
                return Err(format!(
                    "account {CLAUDE_JSON} is not a JSON object, leaving it untouched: {}",
                    file.display()
                ))
            }
        },
    };

    // Already trusted under EVERY key → do not rewrite the file for nothing. It must be every key,
    // not any: a partial record is what a half-completed earlier seed leaves behind, and treating
    // that as done is how the missing key never gets written.
    let all_present = keys.iter().all(|k| {
        obj.get("projects")
            .and_then(|p| p.as_object())
            .and_then(|p| p.get(k))
            .and_then(|w| w.as_object())
            .and_then(|w| w.get("hasTrustDialogAccepted"))
            == Some(&serde_json::Value::Bool(true))
    });
    if all_present {
        return Ok(());
    }

    // Merge into the projects map, preserving every OTHER project entry and every other key on THIS
    // project. `entry`-style: only `hasTrustDialogAccepted` is written; a `projects` map the user (or
    // a live claude) already built is extended, never replaced.
    let projects = obj
        .entry("projects")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !projects.is_object() {
        *projects = serde_json::Value::Object(serde_json::Map::new());
    }
    let projects = projects.as_object_mut().unwrap();
    // ONE read-modify-write for ALL keys — not one write per key. Each write is CAS-guarded against
    // a live `claude`, so writing them separately would multiply the chance of losing the race by
    // the number of keys and could leave the derived key (the one that matters) unwritten.
    for key in keys {
        let entry = projects
            .entry(key.clone())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if !entry.is_object() {
            *entry = serde_json::Value::Object(serde_json::Map::new());
        }
        entry.as_object_mut().unwrap().insert(
            "hasTrustDialogAccepted".into(),
            serde_json::Value::Bool(true),
        );
    }

    std::fs::create_dir_all(config_dir).map_err(|e| format!("mkdir account dir: {e}"))?;
    let json = serde_json::to_string(&serde_json::Value::Object(obj))
        .map_err(|e| format!("serialize {CLAUDE_JSON}: {e}"))?;
    between_read_and_write();
    if file_stamp(&file) != stamp_at_read {
        return Err(format!(
            "{CLAUDE_JSON} changed while seeding folder trust (a live claude wrote to it); \
             leaving it alone and retrying on the next spawn: {}",
            file.display()
        ));
    }
    crate::hooks::atomic_write_settings(&file, &json)
        .map_err(|e| format!("write account {CLAUDE_JSON}: {e}"))?;
    tighten_mode(&file, 0o600); // it holds the login once one completes
    Ok(())
}

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
    // Sparkle's control plane must reach this identity too — see `ensure_account_allowlist_at`.
    // Best-effort: an account that exists but is missing one permission rule is still a usable
    // account, so this must never be the reason adding one fails.
    if let Err(e) = ensure_account_allowlist_at(&dir) {
        tracing::warn!(error = %e, "could not seed the account's Sparkle allowlist");
    }
    // Onboarding marker, for the same reason and on the same best-effort terms: an account whose
    // dir has no `.claude.json` sends every agent spawned on it into Claude Code's first-run wizard,
    // which SWALLOWS the brief. See `ensure_onboarding_marker_at`.
    if let Err(e) = ensure_onboarding_marker_at(&dir) {
        tracing::warn!(error = %e, "could not seed the account's onboarding marker");
    }
    let acct = Account {
        id,
        nickname,
        config_dir: dir.to_string_lossy().into_owned(),
        is_default: false,
        created_at: now,
        exhausted_until: None,
        exhausted_identity: None,
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
    // IDEMPOTENT ON PURPOSE — removing an account that is already gone is SUCCESS, not an error.
    //
    // The founder deleted an account, saw the row still on screen (the UI waited on this call
    // before dropping it), clicked again, and got `account not found: <id>` in an error box — a
    // failure notice for an operation that had in fact done exactly what he asked, twice. The
    // caller's own retry, a double-click, and two panes racing the same delete all produce that
    // shape, and in every one of them the END STATE the caller wanted is already true.
    //
    // Contrast `set_nickname_at` / `mark_exhausted_at` above, which keep the not-found error: those
    // ask to MUTATE a record, so a missing one means the write went nowhere and the caller must
    // hear about it. A delete is the one operation whose goal is the record's absence.
    let Some(pos) = accounts.iter().position(|a| a.id == id) else {
        return Ok(());
    };
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
        exhausted_identity: None,
    };
    accounts.push(acct.clone());
    write_accounts_at(accounts_path, &accounts)?;
    Ok(acct)
}

/// The nickname a RETAINED-EXPIRED account is adopted under. Its dir was signed in once but the
/// login is gone (Claude Code deletes `oauthAccount` from `.claude.json` when the OAuth session
/// expires or is logged out), so no email can be read from disk to label it. The real identity
/// returns the moment the founder re-authenticates it; until then this generic alias sits in the
/// secondary slot while the identity slot honestly reads "Not signed in" / "Login expired". It is
/// deliberately NOT an email guess — a wrong identity is worse than none.
pub(crate) const EXPIRED_LOGIN_NICKNAME: &str = "Login expired — reconnect";

/// What a config dir's `.claude.json` reveals about whether a completed login ever lived there.
///
/// The three cases are exactly what [`adopt_orphan_dirs_at`] must tell apart. Claude Code clears
/// `oauthAccount` from `.claude.json` when a session expires, so a dir the founder logged into
/// months ago and never re-authed looks — to [`read_oauth_identity_at`] alone — identical to a dir
/// nobody ever touched. That collapse is the whole reason the founder's expired accounts vanished
/// from the list: the recovery scan skipped them as "empty". This restores the distinction.
enum LoginEvidence {
    /// A live `oauthAccount.emailAddress`: a usable identity, adopted with the email as its label.
    SignedIn(OauthIdentity),
    /// No usable `oauthAccount`, but the dir carries PURELY ON-DISK proof a login once completed and
    /// the account was USED — a `history.jsonl` of past interactive prompts, or a `.claude.json`
    /// `projects` entry Claude Code populated with real work. This is the EXPIRED case: RETAIN it so
    /// the founder can re-authenticate, never drop it to an empty list.
    ///
    /// The signals here are deliberately ones a COMPLETED login / real use leaves and that Sparkle's
    /// own add / spawn / token-paste footprint does NOT forge. Every forgeable signal is excluded,
    /// because a never-signed-in "Signing in…" dir carries all of them (verified on the founder's
    /// machine — a cancelled add left `userID` + `hasCompletedOnboarding` + an empty `projects` map,
    /// no `oauthAccount`, no `history.jsonl`):
    ///   * `hasCompletedOnboarding` is seeded by Sparkle at [`add_account_at`] time (see
    ///     [`ensure_onboarding_marker_at`]);
    ///   * Claude Code writes a `userID` on its first startup, before "Select login method";
    ///   * `ensure_project_trusted_at` seeds `projects[<worktree>].hasTrustDialogAccepted` at spawn
    ///     prep — so a `projects` ENTRY is proof only when it carries a key BEYOND that one trust key
    ///     (real Claude Code work: `lastCost`, `mcpServers`, `history`, …), which Sparkle never writes;
    ///   * the token-paste flow (`account_usage::account_set_oauth_token`) writes `.credentials.json`
    ///     BEFORE the CLI verifies the token and leaves it there on rejection, so neither the file's
    ///     existence NOR a readable token in it proves a completed login — the credential is excluded
    ///     entirely.
    ///
    /// WHY FILESYSTEM-ONLY, AND WHY NOT the keychain. An earlier cut probed the credential via
    /// [`crate::account_usage::has_readable_credential`]. That probe is wrong for THIS caller on four
    /// counts, and adoption is a ONE-WAY PERSISTENT write, so each is a permanent phantom row:
    ///   * it FAILS OPEN — every non-`NoEntry` keychain error (a locked login keychain, a host with no
    ///     secret-service backend, a `PlatformFailure`) is treated as "usable", so one bad keychain
    ///     moment would adopt EVERY orphan, including the never-signed-in shells this exists to skip;
    ///   * it can raise a BLOCKING macOS keychain modal per dir — Sparkle is not on those items' ACLs
    ///     — inside `accounts_list`'s `call_once`, freezing the 5s-polled account list app-wide;
    ///   * a successful read WRITES a plaintext token cache into a dir Sparkle holds no record for;
    ///   * it accepts an UNVERIFIED pasted token (previous bullet).
    /// Adoption retries every launch, so UNDER-retaining is free (re-add / re-auth) while
    /// OVER-retaining is permanent — the safe direction is on-disk proof that cannot fail open. A real
    /// login used only headlessly that lost BOTH its row and every on-disk trace is the one case this
    /// forgoes; it is recovered by re-adding, which is cheaper than any phantom row.
    ///
    /// Counting any forgeable signal as a past login is what minted phantom "Login expired —
    /// reconnect" rows for accounts that were never signed in, and made a removed one reappear after
    /// a restart when its dir outlived the row (see [`read_login_evidence`]).
    SignedOutButUsed,
    /// Nothing but Claude Code's own first-run footprint (`projects/`, telemetry) with no completed
    /// login. Adopting one would hand the auto-picker a zero-usage account that wins every spawn and
    /// lands each agent at a login prompt — bead `sparkle-gms0`. Skipped, exactly as before.
    NeverLoggedIn,
}

/// Classify a config dir by its login evidence (see [`LoginEvidence`]). PURELY FILESYSTEM — a
/// `history.jsonl` stat and one `.claude.json` read, no keychain, no token read, no side effects (see
/// the `SignedOutButUsed` docs for why the keychain probe is deliberately not used here). Reads
/// `.claude.json` via the SAME [`identity_json_path`] resolution the identity badge uses, so an
/// explicit dir and the default account agree. Deterministic, so its tests need no injected seam.
fn read_login_evidence(dir: &Path) -> LoginEvidence {
    // A live login is unambiguous — reuse the identity read the badge trusts.
    if let Some(id) = read_oauth_identity_at(Some(dir), None) {
        return LoginEvidence::SignedIn(id);
    }
    // No live `oauthAccount`: retain only on unforgeable on-disk proof of real use.
    if login_use_evidence_on_disk(dir) {
        LoginEvidence::SignedOutButUsed
    } else {
        LoginEvidence::NeverLoggedIn
    }
}

/// Purely on-disk proof that a login completed AND the dir was used — no keychain, no token read, no
/// side effects. True iff Claude Code's interactive prompt history exists, or its `.claude.json`
/// `projects` map holds an entry recording real work (see [`project_entry_shows_real_work`]).
fn login_use_evidence_on_disk(dir: &Path) -> bool {
    // Cheapest first: a stat, no parse. `history.jsonl` is interactive-REPL history — Sparkle never
    // writes it, and a cancelled `claude auth login` never runs the REPL that would.
    if dir.join("history.jsonl").exists() {
        return true;
    }
    identity_json_path(Some(dir), None)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| {
            v.get("projects")
                .and_then(|p| p.as_object())
                .map(project_entry_shows_real_work)
        })
        .unwrap_or(false)
}

/// The one trust key [`ensure_project_trusted_at`] seeds into a `projects` entry at spawn prep. It is
/// the ONLY key Sparkle writes there, so it is the exact key a real-work check must discount.
const TRUST_SEED_KEY: &str = "hasTrustDialogAccepted";

/// Does any `projects` entry carry a key BEYOND [`TRUST_SEED_KEY`]? Claude Code records real work
/// (`lastCost`, `mcpServers`, `history`, `hasCompletedProjectOnboarding`, …) on an entry only after
/// the account actually ran in that directory; Sparkle's trust seed writes `hasTrustDialogAccepted`
/// alone. So "an entry with any other key" is real use that a never-signed-in, spawn-trusted dir
/// cannot forge. An empty entry (`{}`) or a trust-only entry is NOT proof.
fn project_entry_shows_real_work(projects: &serde_json::Map<String, serde_json::Value>) -> bool {
    projects.values().any(|entry| {
        entry
            .as_object()
            .is_some_and(|e| e.keys().any(|k| k != TRUST_SEED_KEY))
    })
}

/// Record `email` as this config dir's Claude identity by filling `oauthAccount.emailAddress` in its
/// `.claude.json`. This is what makes a TOKEN-authenticated account ROUTABLE: a pasted-token account
/// has a `.credentials.json` but no `oauthAccount`, so `read_oauth_identity_at` → `getIdentities`
/// reports `email: null`, `isSignedIn` is false, and `pickAccount` can never route a spawn to it —
/// the account renders "not signed in" despite a working credential. The token form calls this ONLY
/// after `claude auth status` confirms a live CLI login, so the email it records is one the CLI just
/// authenticated with, never a guess.
///
/// Pure over the path it is handed, and CONSERVATIVE: it fills `emailAddress` only when absent/empty
/// and preserves every other key and every other `oauthAccount` field, so a real login's richer
/// identity (accountUuid, org) is never clobbered by this bridge value, and it is idempotent (a
/// second call on an already-identified file rewrites nothing).
fn record_oauth_email_at(claude_json_path: &Path, email: &str) -> Result<(), String> {
    let email = email.trim();
    if email.is_empty() {
        return Err("refusing to record an empty account email".into());
    }
    let mut obj = match std::fs::read_to_string(claude_json_path) {
        Ok(s) => match serde_json::from_str::<serde_json::Value>(&s) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => {
                return Err(format!(
                    "account {CLAUDE_JSON} is not a JSON object, leaving it untouched: {}",
                    claude_json_path.display()
                ))
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", claude_json_path.display())),
    };
    let oauth = obj
        .entry("oauthAccount")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let serde_json::Value::Object(oauth_map) = oauth else {
        return Err(format!(
            "oauthAccount in {CLAUDE_JSON} is not an object, leaving it untouched: {}",
            claude_json_path.display()
        ));
    };
    let already = oauth_map
        .get("emailAddress")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|s| !s.is_empty());
    if already {
        return Ok(()); // already identified — never overwrite a real login's email
    }
    oauth_map.insert("emailAddress".into(), serde_json::json!(email));
    if let Some(parent) = claude_json_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir account dir: {e}"))?;
    }
    let json = serde_json::to_string(&serde_json::Value::Object(obj))
        .map_err(|e| format!("serialize {CLAUDE_JSON}: {e}"))?;
    crate::hooks::atomic_write_settings(claude_json_path, &json)
        .map_err(|e| format!("write account {CLAUDE_JSON}: {e}"))?;
    tighten_mode(claude_json_path, 0o600);
    Ok(())
}

/// Re-register config dirs that hold a REAL login but have no `accounts.json` record.
///
/// ══ WHY ORPHANS EXIST AT ALL ═══════════════════════════════════════════════════════════════════
/// An account's dir is `accounts/<random id>` minted at add time, and the macOS keychain credential
/// is keyed by `sha256(<that path>)[:8]`. So the credential is bound to a path containing a random
/// id, and NOTHING binds an account record to the Anthropic identity it holds. Remove the record —
/// or lose it any other way — and a fully credentialed directory is left on disk that no code can
/// find, while re-adding "the same" account mints a brand new empty dir and prompts for a fresh
/// login. Measured on the founder's machine: 6 of 12 dirs were orphans, 4 of them holding valid
/// logins for identities he was actively trying to use.
///
/// That is also the answer to the founder's own clue — "when I add new accounts, we don't have this
/// issue". The ADD path seeds a dir correctly; there was simply no path that ever looked at a dir
/// again afterwards.
///
/// ══ RETAIN A USED LOGIN, SKIP AN EMPTY DIR ═════════════════════════════════════════════════════
/// Classification is [`read_login_evidence`], which distinguishes THREE cases where this once saw
/// two. A live `oauthAccount.emailAddress` ([`read_oauth_identity_at`], the identity badge's test)
/// is adopted under its email. A dir with NO live `oauthAccount` but unforgeable ON-DISK proof of
/// past use — a `history.jsonl`, or a `.claude.json` `projects` entry carrying real Claude Code work
/// (a key beyond `hasTrustDialogAccepted`) — is an EXPIRED login (Claude Code deletes `oauthAccount`
/// on expiry) and is RETAINED under [`EXPIRED_LOGIN_NICKNAME`] so it never vanishes from the list;
/// this is the founder's #1 ask — an expired account must stay visible with a re-login path, not
/// silently disappear. `userID`, `hasCompletedOnboarding`, a bare/trust-only `projects` map, and a
/// `.credentials.json` (written pre-verify) are all DELIBERATELY EXCLUDED — Sparkle's own footprint
/// forges every one before a login completes (see [`LoginEvidence::SignedOutButUsed`]).
///
/// A dir with neither — bare `projects/` + telemetry footprint, never logged in — is still left
/// alone, and that exclusion is load-bearing rather than tidiness. An un-logged-in dir has no
/// transcripts, so its usage tally is zero — the most headroom there is — and adopting it would hand
/// the auto-picker an account that wins every spawn and drops each agent at a login prompt (bead
/// `sparkle-gms0`). The retained-expired account is SAFE from that trap for the same reason it is
/// visible: with no readable email it fails `isSignedIn`, so `rotationReadiness`/`pickAccount`
/// exclude it from routing while the list still shows it. Two never-logged dirs existed on the
/// founder's machine (Claude Code's own footprint, no completed login), so the skip is the common
/// case, not a corner.
///
/// Keyed by the DIR NAME as the account id, which preserves the `account_config_dir` invariant that
/// an account's dir is `accounts/<its id>`. Idempotent: a dir already referenced by a record is
/// skipped, so re-running adopts nothing. Returns the records it added.
fn adopt_orphan_dirs_at(
    app_data: &Path,
    accounts_path: &Path,
    now: i64,
) -> Result<Vec<Account>, String> {
    let mut accounts = read_accounts_at(accounts_path)?;
    // Match on the config_dir PATH, not the id: that is the field a spawn actually exports, so a
    // record pointing at this dir under any id means the dir is already claimed.
    let claimed: HashSet<PathBuf> = accounts.iter().map(|a| PathBuf::from(&a.config_dir)).collect();

    let root = app_data.join("accounts");
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        // No accounts dir yet is a clean install, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read accounts dir: {e}")),
    };

    let mut adopted = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || claimed.contains(&dir) {
            continue;
        }
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else { continue };
        // Classify by login evidence: adopt a live login under its email, RETAIN an expired login
        // (used once, `oauthAccount` since cleared by Claude Code) under a generic label so it never
        // vanishes from the list, and skip a dir that never held a login. Adopting the last would
        // give the picker a zero-usage account that wins every spawn (bead `sparkle-gms0`).
        let nickname = match read_login_evidence(&dir) {
            LoginEvidence::SignedIn(identity) => identity.email,
            LoginEvidence::SignedOutButUsed => EXPIRED_LOGIN_NICKNAME.to_string(),
            LoginEvidence::NeverLoggedIn => continue,
        };
        // Id collision with an existing record would break the dir↔id invariant; skip rather than
        // mint a second record for one id.
        if accounts.iter().any(|a| a.id == name) {
            continue;
        }
        adopted.push(Account {
            id: name.to_string(),
            nickname,
            config_dir: dir.to_string_lossy().into_owned(),
            is_default: false,
            created_at: now,
            exhausted_until: None,
            exhausted_identity: None,
        });
    }

    if adopted.is_empty() {
        return Ok(Vec::new()); // nothing to write — do not rewrite accounts.json for nothing
    }
    accounts.extend(adopted.iter().cloned());
    write_accounts_at(accounts_path, &accounts)?;
    Ok(adopted)
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
fn mark_exhausted_at(
    accounts_path: &Path,
    id: &str,
    until_epoch: i64,
    home: Option<&Path>,
) -> Result<(), String> {
    let mut accounts = read_accounts_at(accounts_path)?;
    let acct = accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("account not found: {id}"))?;
    // ONE ownership record: both fields move together or neither does. Policy and its rationale
    // live once, on [`effective_exhaustion`].
    //
    // The skip is conditional on a LIVE bench. "Change nothing and let the poll retry" is only safe
    // while the recorded bench is still protecting the account; once it has expired the owner is
    // stale metadata guarding nothing, and skipping would drop a genuinely observed rate limit —
    // permanently, for a config dir that is persistently unresolvable (removed, logged out, or a
    // named account whose `config_dir` is empty, which resolves to `None` by design). The account
    // would then never be benchable again and `pickAccount` would keep routing work into it, which
    // is the worse of the two errors this whole field exists to avoid.
    let live_bench = acct.exhausted_until.is_some_and(|e| e > now_secs());
    match identity_key_for(acct, home) {
        Some(key) => {
            acct.exhausted_until = Some(until_epoch);
            acct.exhausted_identity = Some(key);
        }
        // Unresolvable with an OWNED live bench: keep both, retry next poll. The owner qualifier is
        // load-bearing — an UNOWNED bench has no owner to be stale, so blocking there is pure loss.
        // Concretely, a named account with an empty `config_dir` (persistently unresolvable by
        // design) records a limit unowned at 2:00 resetting 3:00; a new limit at 2:30 resetting 6:00
        // would be refused, the 3:00 bench would expire, and `pickAccount` would route work into an
        // account genuinely limited until 6:00. The unowned case falls through to the write below.
        None if live_bench && acct.exhausted_identity.is_some() => {
            return Err("identity unresolvable; bench not recorded".to_string());
        }
        // Unresolvable with nothing live to protect: record the limit as UNOWNED rather than lose
        // it. The read side honours an unowned bench, and it ages out inside the limit window.
        None => {
            acct.exhausted_until = Some(until_epoch);
            acct.exhausted_identity = None;
        }
    }
    write_accounts_at(accounts_path, &accounts)
}

/// The id of the account registered under `config_dir`, or `None`. Pure so the mapping — the one
/// piece of new logic on the concierge's rotation-bench path — is unit-testable without an
/// `AppHandle` or a filesystem.
///
/// An EMPTY `config_dir` never matches: the shared `$HOME/.claude` default records `config_dir: ""`
/// (meaning "export no override"), and benching the default by a blank string would be ambiguous —
/// the concierge steers AWAY from a clobbered default rather than benching it by id (see
/// `bench_config_dir_auth_dead`). A blank query against a stored blank must therefore be a miss, not
/// a match on whichever default happens to be first.
pub(crate) fn account_id_for_config_dir(accounts: &[Account], config_dir: &str) -> Option<String> {
    if config_dir.is_empty() {
        return None;
    }
    accounts
        .iter()
        .find(|a| a.config_dir == config_dir)
        .map(|a| a.id.clone())
}

/// Bench the account registered under `config_dir` as auth-dead for `secs` seconds, so every consumer
/// that reads `exhausted_until` — the concierge's next resolution, the roborev shim, build agents —
/// routes around it. Reuses [`mark_exhausted_at`] (the SAME write `accounts_mark_exhausted` makes,
/// with the same identity-owner bookkeeping and sibling fan-out on read) and republishes the roborev
/// candidate list, so one bench converges the whole fleet.
///
/// Returns `Ok(false)` — never an error — when nothing matches or `config_dir` is empty (the default
/// account): a rotation whose dead account cannot be identified still succeeds at its real job, which
/// is running the retry on the healthy account. The [`AccountsLock`] is taken for the read-modify-write,
/// exactly as `accounts_mark_exhausted` does, so a concurrent writer cannot interleave.
pub(crate) fn bench_config_dir_auth_dead(
    app: &AppHandle,
    config_dir: &str,
    secs: i64,
) -> Result<bool, String> {
    if config_dir.is_empty() {
        return Ok(false);
    }
    let lock = app.state::<AccountsLock>();
    let _guard = lock.guard();
    let app_data = crate::worktree::app_data_dir_pub(app)?;
    let path = accounts_json_path(&app_data);
    let accounts = read_accounts_at(&path)?;
    let Some(id) = account_id_for_config_dir(&accounts, config_dir) else {
        return Ok(false);
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    mark_exhausted_at(&path, &id, now_secs() + secs, home.as_deref())?;
    if let Some(h) = home.as_deref() {
        republish_roborev_candidates(&app_data, h);
    }
    Ok(true)
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

// ---- the transcript directory-listing cache -------------------------------------
//
// Four commands walk the SAME `projects/**` tree — `accounts_usage`, `accounts_spend`,
// `accounts_ceilings`, `accounts_limit_events` — and every one of them used to `read_dir` the whole
// thing from scratch, on every call. Measured on the founder's machine (2026-08-13), one root:
//
//     20,515 directories · 56,060 dirents · 17,470 `.jsonl`  →  2.4-4.0 s per walk
//
// against a caller that re-asks every `ACCOUNT_CACHE_TTL_MS` (5 s, `accountSelection.ts`) and sits
// on the agent-spawn path. A walk that takes longer than the interval which triggers it IS a pinned
// worker, which is what a `sample` of v0.103.0 caught: 4354/4354 samples of one tokio blocking
// worker inside `collect_usage_files`, bottoming out in `__getdirentries64`. It scales with the
// fleet — those 20,515 dirs are one session sidecar dir plus one `tool-results/` dir per session,
// and 56 live agents mint them continuously.
//
// So: stop re-reading directories that did not change. A directory's own mtime is bumped by every
// create / unlink / rename INSIDE it — exactly the set of changes that can alter the listing — so it
// is a sound validity key for that listing. An APPEND to a transcript does NOT bump it, and that is
// fine: the walker stats every `.jsonl` the listing hands back regardless, because that stat is what
// feeds both the 7d cutoff filter and the parse memo. Nothing about which files are found, or in
// what order they are parsed, changes — this is a syscall cut, not a policy change.
//
// Measured on the same tree, running the real before/after code INTERLEAVED (so load drift hits
// both arms equally) while the fleet was live, six pairs, identical 4,251-file results every pair:
//
//     read_dir calls per pass   20,515  ->  0        (deterministic — this is the profiled frame)
//     wall clock, median         6,861 ms -> 1,593 ms   (4.3x; 3.3x at the min)
//
// Trust those two lines in that order. The read_dir count is a property of the algorithm; the wall
// clock is not — one BEFORE pass ranged 2.8 s to 25.4 s on one tree inside a minute, and one AFTER
// pass came in slower than its own BEFORE on pure load noise. A 25 s walk on a blocking worker
// against a 5 s poll is the UI hang this started from.
//
// What remains is the ~17,470 `std::fs::metadata` calls, one per `.jsonl`, and they are NOT an
// oversight this cache forgot to cover: an append leaves the parent's mtime untouched, so a
// transcript must be stat'd every pass however settled its directory is — the same fact that makes
// caching the LISTING sound. Cutting those needs a bulk stat (`getattrlistbulk`, a libc dependency
// and a macOS-only path) or a change to what "in-window" means. Bigger and riskier than this.

/// How settled a directory's mtime must be before its listing may be cached.
///
/// The one race an mtime key has: we stat at t0 and `read_dir` at t1, so a create landing in
/// (t0, t1) that our listing missed must still leave a mtime DIFFERENT from the one we recorded, or
/// the next pass takes the cached listing and never learns the file exists. That holds whenever the
/// filesystem's timestamp granularity is finer than t1-t0 (APFS is nanoseconds) and fails on a
/// 1-second-granularity one. Refusing to cache a directory whose mtime is younger than this closes
/// it on ANY granularity: a directory being written to right now is simply re-listed every pass —
/// which is both correct and nearly free, since on a live machine that is a handful of active
/// session dirs out of twenty thousand.
const DIR_CACHE_SETTLE: std::time::Duration = std::time::Duration::from_secs(2);

/// Working-set bound for the listing cache. The founder's primary tree alone is ~20,500 directories
/// and a pass spans several roots, so this is several trees' worth. Past it the least-recently-used
/// listings go: a dropped listing costs one `read_dir`, never a wrong answer.
const DIR_CACHE_MAX: usize = 100_000;

/// One directory's `.jsonl` children and real subdirectories, valid while its mtime is unchanged.
struct DirListing {
    /// The directory's mtime when we listed it — the validity key.
    modified: SystemTime,
    /// NAMES, not full paths, and behind an `Arc` so a cache hit is two refcount bumps rather than a
    /// deep clone under the lock. Storing paths would duplicate this map's own keys (~150 bytes
    /// each on a worktree tree) for no gain: the walker builds a `PathBuf` per child regardless, to
    /// stat it.
    dirs: std::sync::Arc<[std::ffi::OsString]>,
    files: std::sync::Arc<[std::ffi::OsString]>,
    /// LRU key for [`crate::spend::evict_two_tier`] — the same bound both transcript memos use.
    last_touch: u64,
}

type DirCache = std::collections::HashMap<PathBuf, DirListing>;

/// Process-wide, like the parse memo beside it: every window's `accounts_usage` and every concurrent
/// `accounts_spend` walk the same tree, so a per-call cache would help none of them.
fn dir_cache() -> &'static std::sync::Mutex<DirCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<DirCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(DirCache::new()))
}

/// Monotonic LRU stamp, so recency is a comparison rather than a clock read.
fn dir_cache_tick() -> u64 {
    static TICK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    TICK.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// `dir`'s real subdirectories and `.jsonl` children, served from the mtime-keyed cache when the
/// directory has not changed since we last listed it. `None` when it cannot be read at all.
///
/// `now` is the WALK's start instant, handed in rather than read per directory: one clock read per
/// pass instead of twenty thousand, and every directory of one walk judges "settled" against the
/// same instant.
///
/// The third element is whether this call actually performed a `read_dir`. That is the side effect
/// this cache exists to remove, so the walkers report it upward and the tests assert on it — the
/// records come back identical either way, which is precisely why a records-only assertion could
/// not tell a working cache from a missing one.
fn list_transcript_dir(
    dir: &Path,
    now: SystemTime,
) -> Option<(
    std::sync::Arc<[std::ffi::OsString]>,
    std::sync::Arc<[std::ffi::OsString]>,
    bool,
)> {
    // FOLLOWS symlinks, matching `read_dir` (which follows the directory it is handed): an account
    // `projects/` symlinked at another tree must be judged by the TARGET's mtime, or its listing
    // would be pinned on a link node that never changes.
    let modified = std::fs::metadata(dir).ok().and_then(|m| m.modified().ok());
    if let Some(modified) = modified {
        let tick = dir_cache_tick();
        if let Ok(mut cache) = dir_cache().lock() {
            if let Some(hit) = cache.get_mut(dir) {
                if hit.modified == modified {
                    hit.last_touch = tick;
                    return Some((hit.dirs.clone(), hit.files.clone(), false));
                }
            }
        }
    }

    let entries = std::fs::read_dir(dir).ok()?;
    let mut dirs: Vec<std::ffi::OsString> = Vec::new();
    let mut files: Vec<std::ffi::OsString> = Vec::new();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let name = entry.file_name();
        // `file_type()` reports the LINK itself (it does not follow), so `is_dir()` is true only for
        // a true directory and a symlinked dir is never descended into. That is the cycle guard the
        // walkers document; splitting the listing out must not quietly relax it.
        if ft.is_dir() {
            dirs.push(name);
        } else if Path::new(&name)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        {
            files.push(name);
        }
    }
    let dirs: std::sync::Arc<[std::ffi::OsString]> = dirs.into();
    let files: std::sync::Arc<[std::ffi::OsString]> = files.into();
    if let Some(modified) = modified {
        if now
            .duration_since(modified)
            .is_ok_and(|age| age >= DIR_CACHE_SETTLE)
        {
            if let Ok(mut cache) = dir_cache().lock() {
                cache.insert(
                    dir.to_path_buf(),
                    DirListing {
                        modified,
                        dirs: dirs.clone(),
                        files: files.clone(),
                        last_touch: dir_cache_tick(),
                    },
                );
            }
        }
    }
    Some((dirs, files, true))
}

/// Bound the listing cache at the end of a walk. Plain LRU: unlike the parse memo there is no live
/// pass to exempt, because evicting an entry a running walk still wants costs it one `read_dir` and
/// nothing else. Reuses [`crate::spend::evict_two_tier`] so the bound has one implementation across
/// all three caches on this path.
fn evict_dir_cache() {
    if let Ok(mut cache) = dir_cache().lock() {
        crate::spend::evict_two_tier(
            &mut cache,
            DIR_CACHE_MAX,
            DIR_CACHE_MAX,
            |_| false,
            |l| (l.last_touch, l.modified),
        );
    }
}

/// The walk half of [`collect_usage_records_across`]: every in-window `.jsonl` under `root`, with the stat
/// that both filtered it and keys the memo, plus its mtime as the sort key.
///
/// Returns how many directories it actually `read_dir`ed — see [`list_transcript_dir`] for why that
/// is the number a test has to assert on.
fn collect_usage_files(
    root: &Path,
    cutoff_epoch: i64,
    out: &mut Vec<(PathBuf, Option<std::fs::Metadata>, SystemTime)>,
) -> usize {
    let reads = collect_usage_files_at(root, cutoff_epoch, out, SystemTime::now());
    evict_dir_cache();
    reads
}

/// [`collect_usage_files`] with the walk's start instant injected, so the recursion reads the clock
/// once and every directory judges [`DIR_CACHE_SETTLE`] against the same value.
///
/// Subdirectories are descended BEFORE this level's files are stat'd, where the old `read_dir` loop
/// interleaved them. Emission order is not observable: `collect_usage_records_across` sorts the
/// whole set by (mtime, path), a TOTAL order, before anything is parsed.
fn collect_usage_files_at(
    root: &Path,
    cutoff_epoch: i64,
    out: &mut Vec<(PathBuf, Option<std::fs::Metadata>, SystemTime)>,
    now: SystemTime,
) -> usize {
    let Some((dirs, files, did_read)) = list_transcript_dir(root, now) else {
        return 0;
    };
    let mut reads = usize::from(did_read);
    for name in dirs.iter() {
        reads += collect_usage_files_at(&root.join(name), cutoff_epoch, out, now);
    }
    for name in files.iter() {
        let path = root.join(name);
        // Skip transcripts untouched since before the 7d window (all their records are stale).
        // Use std::fs::metadata (which FOLLOWS symlinks) rather than DirEntry::metadata (an
        // lstat that returns the symlink node's own mtime): a symlinked transcript must be
        // judged by its TARGET's mtime — the real file we'd otherwise parse — or a link node
        // older than the window would wrongly skip a target being appended today (under-count).
        // Fail open: if the stat/mtime read errors (e.g. broken symlink), we don't skip.
        // The same stat also keys the parse memo below, so an in-window file costs one stat.
        //
        // This stat is NOT cacheable on the directory's mtime, and that is the whole reason the
        // listing cache is sound: an append leaves the parent directory untouched, so the file has
        // to be stat'd on every pass no matter how settled its directory is.
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
    reads
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
/// subdirectories only) and its mtime pre-filter — and, since both walk the same tree on their own
/// cadences, its [`list_transcript_dir`] listing cache. `accounts_limit_events` is polled by the
/// frontend, so this is the same pinned-worker shape `collect_usage_files` documents, on a second
/// command.
///
/// Returns how many directories it actually `read_dir`ed, for the same reason that function does.
fn latest_limit_event(
    projects_root: &Path,
    since_epoch: i64,
    best: &mut Option<(i64, String)>,
) -> usize {
    let reads = latest_limit_event_at(projects_root, since_epoch, best, SystemTime::now());
    evict_dir_cache();
    reads
}

/// [`latest_limit_event`] with the walk's start instant injected — one clock read per pass.
fn latest_limit_event_at(
    root: &Path,
    since_epoch: i64,
    best: &mut Option<(i64, String)>,
    now: SystemTime,
) -> usize {
    let Some((dirs, files, did_read)) = list_transcript_dir(root, now) else {
        return 0;
    };
    let mut reads = usize::from(did_read);
    for name in dirs.iter() {
        reads += latest_limit_event_at(&root.join(name), since_epoch, best, now);
    }
    for name in files.iter() {
        let path = root.join(name);
        // Transcripts are append-only, so a file untouched since before the lookback cannot
        // hold an in-window event. Fail OPEN on a stat error (parse it) — missing a real limit
        // is worse than an extra read. `metadata` (not `DirEntry::metadata`) so a symlinked
        // transcript is judged by its target's mtime. Not cacheable on the directory's mtime: an
        // append leaves the parent untouched, which is exactly why the listing cache is sound.
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
    reads
}

// ---- OAuth-expiry ("auth-dead") detection for the roborev shim -----------------
//
// The AUTH analogue of a rate-limit event. An account whose OAuth session can no longer be refreshed
// is still signed in — its keychain credential reads fine, so `has_readable_credential` keeps it in
// the roborev candidate pool — but every `claude` under it fails at auth time. Worse, an
// unauthenticated account has consumed zero tokens, so it scores as the account with the MOST
// headroom and roborev routes EVERY review to the one login guaranteed to fail.
//
// We detect it the same way we detect a quota wall: by scanning the account's OWN transcripts (by
// FILE, so attribution is free) for the structured API-error record Claude Code writes when auth
// fails, and matching it against `roborev_account::is_auth_expired`. The result feeds
// `publish_candidates_excluding_auth_dead`, which drops the dead login from the next shim's list.
// Unlike a rate-limit event this has no reset instant, so it is NOT surfaced to the limit modal — it
// is roborev-scoped.
//
// RECOVERY: we compare the account's newest auth-error timestamp against its newest
// AFFIRMATIVE-SUCCESS turn (an assistant turn carrying `message.usage`, never a bare `user` line, a
// quota record, or a differently-worded error — see `is_successful_turn`), and mark it dead only when
// the error is the newer of the two. Two things clear a bench, and NEITHER is a bare `claude login`
// (which writes no session turn): (1) a COMPLETED run under the account writes a newer usage turn —
// which happens when the interactive fleet shares the account; (2) the auth error AGES OUT of the
// `AUTH_EXPIRY_LOOKBACK` window (its transcript mtime falls before the floor), after which roborev
// retries the account and re-benches only if it fails again. This matters because an auth-dead
// account is DROPPED from the candidate list, so roborev never execs `claude` under it — a
// roborev-ONLY account therefore cannot write its own clearing turn and heals solely via (2), the
// bounded lookback expiry. The scan is also FLOORED at the identity takeover (the same floor the
// rate-limit
// path uses), so a config dir that was re-logged into a DIFFERENT account never inherits the
// previous login's death.
//
// LIMITATION (bead sparkle-2kg6re): this depends on Claude Code persisting the auth failure as a
// transcript record. A failure that aborts BEFORE any session JSONL is written would leave nothing to
// scan, making this path inert for that shape. BUG 1's straight-exec fix is independent of this and
// already resolves the live outage; the robust future source is roborev's own `~/.roborev/reviews.db`
// job outcomes. What is committed here is correct WHEN a record exists, and cannot false-positive on
// prose (see `record_is_auth_expiry`'s discriminator).

/// How far back to look for an auth-expiry record. Same lookback as a limit event — and it doubles as
/// the bench-EXPIRY for a roborev-only account (case (2) in the recovery note): once the error is
/// older than this, it is no longer read, so the account is retried.
const AUTH_EXPIRY_LOOKBACK: i64 = LIMIT_EVENT_LOOKBACK;

/// Is this transcript record Claude Code's own API-ERROR turn AND does its text carry the OAuth
/// refresh-failure signature? The `isApiErrorMessage`/top-level-`error` gate is the discriminator —
/// the same discipline the rate-limit scanner uses — so an assistant merely QUOTING "please run
/// /login" in ordinary prose can never bench a healthy account.
fn record_is_auth_expiry(v: &serde_json::Value) -> bool {
    let is_api_error = v.get("isApiErrorMessage").and_then(serde_json::Value::as_bool) == Some(true);
    let top_error = v.get("error").and_then(serde_json::Value::as_str);
    if !is_api_error && top_error.is_none() {
        return false;
    }
    if let Some(t) = limit_event_text(v) {
        if crate::roborev_account::is_auth_expired(&t) {
            return true;
        }
    }
    if top_error.is_some_and(crate::roborev_account::is_auth_expired) {
        return true;
    }
    v.get("result")
        .and_then(serde_json::Value::as_str)
        .is_some_and(crate::roborev_account::is_auth_expired)
}

/// An AFFIRMATIVE success turn — the only thing that counts as "recovered". A signed-in `claude -p`
/// writes an assistant turn carrying `message.usage`; a bare `user` turn (Claude Code appends the
/// user half BEFORE the request is even made), a quota record, or a differently-worded API error are
/// all NON-successes and must NOT clear a bench. Mirrors the discriminator discipline
/// [`record_is_auth_expiry`] applies to the error side, so one unmatched error line can never
/// un-bench an account the scan already proved dead.
fn is_successful_turn(v: &serde_json::Value) -> bool {
    let is_error = v.get("isApiErrorMessage").and_then(serde_json::Value::as_bool) == Some(true)
        || v.get("error").is_some();
    !is_error
        && v.get("type").and_then(serde_json::Value::as_str) == Some("assistant")
        && v.get("message").and_then(|m| m.get("usage")).is_some()
}

/// The error-side cheap-reject predicate: does this ALREADY-LOWERCASED transcript line carry any auth
/// marker? Its own function so the coupling test
/// (`every_auth_phrase_survives_the_scan_prefilter`) exercises the REAL predicate rather than a
/// copy — editing these tokens reds that test.
fn line_carries_auth_marker(lower: &str) -> bool {
    lower.contains("oauth") || lower.contains("login") || lower.contains("refreshed")
}

/// Fold one transcript's in-window records into the newest AUTH-ERROR and newest AFFIRMATIVE-SUCCESS
/// timestamps, so the caller can tell "failed and never recovered" from "failed, then succeeded".
/// Defensive throughout: an unreadable file or an unparseable line is skipped, never fatal.
///
/// A CHEAP REJECT runs before any JSON parse — the sibling rate-limit scanner spends one, and this
/// path runs synchronously under `AccountsLock` from `accounts_mark_exhausted`, so a full parse of
/// every transcript line (each carrying whole tool results) would block the accounts lock. A line can
/// only matter if it carries an auth marker (error side: [`line_carries_auth_marker`]'s
/// `oauth`/`login`/`refreshed`, a maintained SUPERSET of
/// [`crate::roborev_account::AUTH_EXPIRY_PHRASES`] — NOT immune to drift, so
/// `every_auth_phrase_survives_the_scan_prefilter` reds the suite if a phrase is added that these
/// tokens don't cover) or `"usage"` (success side); everything else — the bulk of the corpus — is
/// skipped.
fn fold_auth_signals(path: &Path, floor: i64, newest_error: &mut Option<i64>, newest_ok: &mut Option<i64>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        let maybe_error = line_carries_auth_marker(&lower);
        let maybe_ok = line.contains("\"usage\"");
        if !maybe_error && !maybe_ok {
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
        if ts < floor {
            continue;
        }
        if maybe_error && record_is_auth_expiry(&v) {
            if newest_error.is_none_or(|e| ts > e) {
                *newest_error = Some(ts);
            }
        } else if maybe_ok && is_successful_turn(&v) && newest_ok.is_none_or(|o| ts > o) {
            *newest_ok = Some(ts);
        }
    }
}

/// Recursively fold every in-window transcript under `root` into the newest-error / newest-ok pair.
/// Mirrors [`latest_limit_event_at`]'s traversal (symlink-cycle guard, mtime pre-filter, listing
/// cache). No short-circuit: recovery is a CROSS-file comparison, so a later clean file must be seen
/// even after an earlier file's error record.
fn fold_auth_signals_at(
    root: &Path,
    floor: i64,
    newest_error: &mut Option<i64>,
    newest_ok: &mut Option<i64>,
    now: SystemTime,
) {
    let Some((dirs, files, _did_read)) = list_transcript_dir(root, now) else {
        return;
    };
    for name in files.iter() {
        let path = root.join(name);
        if let Some(modified) = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok()) {
            if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
                if (dur.as_secs() as i64) < floor {
                    continue;
                }
            }
        }
        fold_auth_signals(&path, floor, newest_error, newest_ok);
    }
    for name in dirs.iter() {
        fold_auth_signals_at(&root.join(name), floor, newest_error, newest_ok, now);
    }
}

/// True when the newest auth-relevant signal under `root` (at/after `floor`) is an auth-error with no
/// later successful turn — i.e. the login failed auth and has not recovered. Extracted from
/// [`account_shows_auth_expiry`] so the recovery logic is unit-testable against a temp transcript
/// tree without going through account/identity resolution.
fn root_is_auth_dead(root: &Path, floor: i64, now: SystemTime) -> bool {
    let mut newest_error = None;
    let mut newest_ok = None;
    fold_auth_signals_at(root, floor, &mut newest_error, &mut newest_ok, now);
    match newest_error {
        // Dead iff nothing succeeded at or after the failure. `>=` (not `>`) so a same-timestamp
        // ordinary turn does not out-vote the error it accompanies.
        Some(err) => newest_ok.is_none_or(|ok| err >= ok),
        None => false,
    }
}

/// True if this account's transcripts show an unrecovered OAuth-expiry — its login is signed in but
/// auth-dead and roborev must route around it. Floored at the identity takeover (same as
/// [`limit_event_for_account`]) so a previous login's death in the same tree can't bench the current
/// one.
fn account_shows_auth_expiry(acct: &Account, now: i64, home: Option<&Path>, log: &IdentityLog) -> bool {
    let Some(root) = projects_root_for_account_at(acct, home) else {
        return false;
    };
    let floor = identity_key_for(acct, home)
        .and_then(|k| identity_log::takeover_at(log, &acct.config_dir, &k))
        .map_or(now - AUTH_EXPIRY_LOOKBACK, |t| t.max(now - AUTH_EXPIRY_LOOKBACK));
    let dead = root_is_auth_dead(&root, floor, SystemTime::now());
    evict_dir_cache();
    dead
}

/// Given the directly-observed dead config dirs and each account's `(config_dir, identity_key)`,
/// expand the dead set so a dead login's SIBLING registrations (a second account row pointing at the
/// same underlying login) are excluded too — the identity-aware benching the interactive fleet
/// already applies to quota walls. Pure, so the expansion is unit-testable without `.claude.json` IO.
fn expand_auth_dead_across_identity(
    directly_dead: &HashSet<String>,
    account_identities: &[(String, Option<String>)],
) -> HashSet<String> {
    let dead_identities: HashSet<String> = account_identities
        .iter()
        .filter(|(dir, _)| directly_dead.contains(dir))
        .filter_map(|(_, key)| key.clone())
        .collect();
    let mut out = directly_dead.clone();
    if dead_identities.is_empty() {
        return out;
    }
    for (dir, key) in account_identities {
        if key.as_ref().is_some_and(|k| dead_identities.contains(k)) {
            out.insert(dir.clone());
        }
    }
    out
}

/// The set of config dirs roborev must EXCLUDE for OAuth-expiry, expanded across identity.
fn roborev_auth_dead_dirs(
    accounts: &[Account],
    home: Option<&Path>,
    log: &IdentityLog,
    now: i64,
) -> HashSet<String> {
    let directly_dead: HashSet<String> = accounts
        .iter()
        .filter(|a| account_shows_auth_expiry(a, now, home, log))
        .map(|a| a.config_dir.clone())
        .collect();
    if directly_dead.is_empty() {
        return directly_dead;
    }
    let identities: Vec<(String, Option<String>)> = accounts
        .iter()
        .map(|a| (a.config_dir.clone(), identity_key_for(a, home)))
        .collect();
    expand_auth_dead_across_identity(&directly_dead, &identities)
}

/// The transcript root for one account, resolved the SAME way session detection does.
///
/// Passing `$HOME` matters: the default account stores an EMPTY `config_dir` (see
/// [`Account::config_dir`]), and without a home to fall back on that resolves to `None` — the
/// account would report no transcripts at all, hence zero usage, no learned ceiling, and no
/// rate-limit events, while its sessions pile up under `$HOME/.claude/projects`.
fn projects_root_for_account(acct: &Account) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    projects_root_for_account_at(acct, home.as_deref())
}

/// [`projects_root_for_account`] with `$HOME` injected, so callers that already hold a home (and
/// unit tests driving a fake one) resolve the same root without touching process env.
fn projects_root_for_account_at(acct: &Account, home: Option<&Path>) -> Option<PathBuf> {
    crate::claude::claude_projects_root(Some(Path::new(&acct.config_dir)), home)
}

/// The newest rate-limit event for one account within the lookback window, or `None` if it hasn't
/// hit a limit recently.
fn limit_event_for_account(
    acct: &Account,
    now: i64,
    home: Option<&Path>,
    log: &IdentityLog,
) -> Option<AccountLimitEvent> {
    let root = projects_root_for_account(acct)?;
    // Floor the scan at the moment the CURRENT identity took over this directory. Transcripts have
    // no account marker, so a rate-limit event written by the previous login sits in the same tree
    // and would otherwise be re-read and re-bench the new one — the frontend polls this and calls
    // `markExhausted` on what it finds. Same boundary the learned ceiling already respects.
    let floor = identity_key_for(acct, home)
        .and_then(|k| identity_log::takeover_at(log, &acct.config_dir, &k))
        .map_or(now - LIMIT_EVENT_LOOKBACK, |t| t.max(now - LIMIT_EVENT_LOOKBACK));
    let mut best = None;
    latest_limit_event(&root, floor, &mut best);
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

    /// The `accountUuid` the samples were measured against, when the login records one.
    ///
    /// **This is the WIRE value only, and `None` here does NOT mean `ceiling` is `None`.** A login
    /// predating the `accountUuid` field reports no uuid while being fully signed in and fully
    /// attributable by email, and it keeps its ceiling — see [`identity_key`], which is what the
    /// history is actually filed under, and the test
    /// `a_login_predating_account_uuid_still_learns_its_ceiling`.
    ///
    /// A consumer must therefore NOT read `accountUuid == null` as "no ceiling here". What is
    /// unconditional is the other direction: a directory with NO resolvable identity at all (no
    /// uuid *and* no email) yields `ceiling: None`, because a number learned from a directory we
    /// cannot attribute to anybody is not a fact about anybody.
    pub account_uuid: Option<String>,
    /// True when this directory's history is not attributable to `account_uuid`, so samples were
    /// discarded. Two causes, both "somebody else's usage is in here": the identity behind the dir
    /// CHANGED inside the learn window (the ledger's takeover cut), or a terminal `claude` running
    /// as a different identity is writing into the SAME transcript tree concurrently (see
    /// [`shares_transcripts_with_a_different_shell_identity`]). `ceiling` may be `None` purely for
    /// this reason, and that is the intended outcome — see the note below on why an unknown ceiling
    /// is the safe answer.
    pub reset_by_identity_change: bool,
}

/// Every rate-limit event time under `projects_root` at or after `since_epoch` (not just the
/// newest, unlike [`latest_limit_event`]) — the raw material for learning.
///
/// Third walker over the SAME tree, so it shares the [`list_transcript_dir`] listing cache with the
/// other two. Its own per-file work is already gated behind a 30d mtime pre-filter, which left the
/// directory traversal as the whole of its steady-state cost.
///
/// Returns how many directories it actually `read_dir`ed — see [`collect_usage_files`].
fn collect_limit_event_times(projects_root: &Path, since_epoch: i64, out: &mut Vec<i64>) -> usize {
    let reads = collect_limit_event_times_at(projects_root, since_epoch, out, SystemTime::now());
    evict_dir_cache();
    reads
}

/// [`collect_limit_event_times`] with the walk's start instant injected — one clock read per pass.
fn collect_limit_event_times_at(
    root: &Path,
    since_epoch: i64,
    out: &mut Vec<i64>,
    now: SystemTime,
) -> usize {
    let Some((dirs, files, did_read)) = list_transcript_dir(root, now) else {
        return 0;
    };
    let mut reads = usize::from(did_read);
    for name in dirs.iter() {
        reads += collect_limit_event_times_at(&root.join(name), since_epoch, out, now);
    }
    for name in files.iter() {
        let path = root.join(name);
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
    reads
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
/// preceded it — **for the identity currently behind the config dir, and nobody else**.
///
/// Ceilings are measured from transcripts, and transcripts carry no account marker (verified:
/// sampled records expose only `sessionId`/`type`/`leafUuid`/`mode`), so history CANNOT be
/// re-attributed after a different Anthropic account signs into the same directory. The
/// identity-epoch ledger ([`crate::identity_log`]) records *when* each uuid was seen behind each
/// dir, and this is what that record is for: if the current uuid took over at `T` and `T` falls
/// inside the learn window, everything older belongs to someone else and is dropped.
///
/// Two consequences, both deliberate:
///
/// * Episodes are kept only when their WHOLE 5h consumption window post-dates the takeover
///   (`ep - WINDOW_5H >= T`), not merely the episode itself. An episode straddling the boundary
///   would be sampled against truncated records, which under-states consumption, which lowers the
///   median, which makes the near-cap banner fire EARLY. That is the unsafe direction.
/// * Falling under [`CEILING_MIN_SAMPLES`] yields `ceiling: None`. A pre-boundary ceiling is NEVER
///   carried forward. `switchRecommendation` treats an unknown ceiling as `unknown`, which cannot
///   raise a `warn` — so the failure mode is silence, not moving the user's work to another account
///   on a number measured against a different person.
///
/// Pure given the filesystem and the ledger; the caching wrapper is [`accounts_ceilings`].
fn ceiling_for_account(
    acct: &Account,
    now: i64,
    home: Option<&Path>,
    shell_config_dir: &str,
    log: &IdentityLog,
) -> AccountCeiling {
    let identity = identity_for_account(acct, home);
    // The WIRE value (what the UI reports) and the FILING key are different questions: an older
    // login has no uuid to report but is still perfectly attributable by email. See `identity_key`.
    let account_uuid = identity.as_ref().and_then(|i| i.account_uuid.clone());
    let identity_key = identity.as_ref().map(identity_key);
    // The ledger separates identities that held a directory in SEQUENCE. It cannot separate two
    // holding it at once, which is what the founder's forked default does — see
    // `shares_transcripts_with_a_different_shell_identity`. Such a directory is unattributable, and
    // an unattributable directory yields no ceiling.
    let shell_commingled = shares_transcripts_with_a_different_shell_identity(
        acct,
        identity.as_ref(),
        home,
        shell_config_dir,
    );
    let window_start = now - CEILING_LEARN_WINDOW;
    // The moment the CURRENT identity took over this directory, when that is inside the learn
    // window. `None` when the ledger has never seen a different identity here — which is also the
    // state on first run, so an upgrade does not blank every learned ceiling.
    let takeover = identity_key
        .as_deref()
        .and_then(|k| identity_log::takeover_at(log, &acct.config_dir, k))
        .filter(|t| *t > window_start);
    // Records are collected from the takeover; episodes are kept from a further 5h in, so every
    // sample's consumption window is fully covered by records this identity actually produced.
    let record_floor = takeover.unwrap_or(window_start);
    let episode_floor = takeover.map_or(window_start, |t| t + WINDOW_5H);

    let mut samples = Vec::new();
    let mut reset_by_identity_change = false;
    if let Some(root) = projects_root_for_account(acct) {
        // Collected over the FULL window, then cut: knowing how many episodes the takeover
        // discarded is what `reset_by_identity_change` reports.
        let mut times = Vec::new();
        collect_limit_event_times(&root, window_start, &mut times);
        let all_episodes = limit_episodes(times);
        let episodes: Vec<i64> =
            all_episodes.iter().copied().filter(|t| *t >= episode_floor).collect();
        // Only ever true because of the takeover cut: with no takeover `episode_floor` IS the
        // window start, which `collect_limit_event_times` already filtered on.
        reset_by_identity_change = takeover.is_some() && episodes.len() < all_episodes.len();
        if !episodes.is_empty() {
            let mut records = Vec::new();
            // Its OWN pass, not a bare walk: this runs from `accounts_ceilings`, which is a
            // separate `spawn_blocking` task from `accounts_usage`/`accounts_spend` over the same
            // process-wide memo. Registering the pass is what keeps a concurrent scan from evicting
            // this one's working set mid-walk (see `finish_usage_pass` / `live_usage_passes`).
            let pass = UsagePass::start();
            // From `record_floor`, NOT `since`: usage this identity did not produce must not be
            // able to reach `consumption_before` at all.
            let touched = collect_usage_records_across(
                std::slice::from_ref(&root),
                record_floor,
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
    if shell_commingled {
        // Reported through the same flag the takeover cut uses: from the consumer's side both mean
        // "this directory's history is not attributable to this identity, so there is no number".
        reset_by_identity_change = true;
    }
    // A RESOLVABLE IDENTITY is a hard precondition, not a formality: a ceiling is a claim about a
    // specific Anthropic account, so a directory we cannot attribute to one yields no ceiling even
    // when it has plenty of samples. Note this gates on `identity_key`, not on `account_uuid` — an
    // older login has no uuid to report yet is fully attributable by email, and gating on the uuid
    // would silently and permanently disable the near-cap banner for it. See `identity_key`.
    let ceiling = if identity_key.is_some() && !shell_commingled && samples.len() >= CEILING_MIN_SAMPLES
    {
        let mut s = samples.clone();
        s.sort_unstable();
        Some(median(&s))
    } else {
        None
    };
    AccountCeiling {
        id: acct.id.clone(),
        samples,
        ceiling,
        account_uuid,
        reset_by_identity_change,
    }
}

/// Cache for [`accounts_ceilings`]: `(key, computed_at, value)`.
///
/// The KEY is the fix for a real bug: this was `(computed_at, value)`, keyed on **nothing at all**
/// and served for [`CEILING_CACHE_TTL`] regardless of which accounts existed, whether one had been
/// added or removed, or whether a fresh `claude login` had changed the identity behind a config dir.
/// Adding an account showed the previous account set's ceilings for 15 minutes; signing a different
/// person into a directory kept serving the old person's number — which is precisely the
/// mis-attribution the identity work exists to stop. Shortening the TTL would not have fixed it,
/// only narrowed the window.
type CeilingCache = Option<(String, i64, Vec<AccountCeiling>)>;

fn ceiling_cache() -> &'static std::sync::Mutex<CeilingCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<CeilingCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// Everything a cached ceiling set is only valid FOR: the app-data root it was computed against,
/// every account's id / config dir / default-ness / currently-resolved [`identity_key`], AND the
/// SHELL's config dir plus the identity behind it.
///
/// The account half keys on the identity KEY rather than the raw `accountUuid`, so a re-login that
/// changes only the email — the discriminator for a pre-`accountUuid` login — still invalidates.
/// Keying on the uuid would serve a stale ceiling for up to the TTL after exactly the swap this
/// feature exists to detect.
///
/// The shell half is not incidental — it is an input to the result. `ceiling_for_account` suppresses
/// the ceiling when a default account shares one transcript tree with a differently-signed-in
/// terminal, so `claude auth login` in that terminal flips the answer while nothing about any
/// account record changes. Leaving it out of the key would serve the pre-login number for the full
/// [`CEILING_CACHE_TTL`] — the exact staleness this key was introduced to end, merely relocated to
/// the one directory the key did not cover.
///
/// `\0` separated because it is the one byte a path cannot contain, so no two distinct inputs can
/// collide by concatenation.
fn ceiling_cache_key(
    app_data: &Path,
    accounts: &[Account],
    uuids: &[Option<String>],
    shell_config_dir: &str,
    shell_key: Option<&str>,
) -> String {
    let mut key = app_data.to_string_lossy().into_owned();
    key.push('\0');
    key.push_str(shell_config_dir);
    key.push('\0');
    key.push_str(shell_key.unwrap_or("-"));
    for (a, uuid) in accounts.iter().zip(uuids) {
        key.push('\0');
        key.push_str(&a.id);
        key.push('\0');
        key.push_str(&a.config_dir);
        key.push('\0');
        key.push(if a.is_default { 'd' } else { 'n' });
        key.push('\0');
        key.push_str(uuid.as_deref().unwrap_or("-"));
    }
    key
}

/// A cached ceiling set, but only when it was computed for exactly this `key` and is still inside
/// [`CEILING_CACHE_TTL`]. Split out from the command so both halves of the invalidation — the key
/// and the TTL — are testable without a Tauri runtime.
fn ceiling_cache_lookup(cache: &CeilingCache, key: &str, now: i64) -> Option<Vec<AccountCeiling>> {
    let (cached_key, at, value) = cache.as_ref()?;
    if cached_key != key || now - at >= CEILING_CACHE_TTL {
        return None;
    }
    Some(value.clone())
}

/// The still-in-effect exhaustion for this account, or `None`.
///
/// An exhaustion is a fact about an ANTHROPIC ACCOUNT but is stored on a REGISTRATION, and the
/// identity behind a registration can change under it ("Switch login"). Surfacing it blindly hands
/// the new login a bench it never earned — `pickAccount` then skips a perfectly usable account
/// until the epoch passes. Same class as the learned ceiling carrying another person's history,
/// on a different field.
///
/// It must still be in the future, and then the policy is THREE-way, not two:
///   * recorded owner matches the current identity → honoured;
///   * the current identity cannot be RESOLVED → honoured. "Can't tell" is not "somebody else",
///     and the config file is rewritten continuously so an unreadable tick is routine;
///   * a KNOWN different login → cleared.
///
/// A row with no recorded identity predates the field and is honoured too: the limit resets within
/// ~5h so it ages out by itself. Throughout, routing work INTO an exhausted account is the worse of
/// the two errors, which is why every uncertain case honours the bench rather than dropping it.
///
/// Why "cannot resolve" is honoured rather than cleared: Claude Code rewrites
/// `<config_dir>/.claude.json` continuously, so a truncated mid-write read is a routine tick and
/// `limitSync` samples it on a 60s poll. Clearing there would make a rate-limited account read as
/// healthy and cost an `accounts.json` read-modify-write under `AccountsLock` every poll instead of
/// a no-op. The matching write-side rule is that both fields move together or neither does — never
/// a new timestamp under a stale owner, and never a cleared owner under a live bench.
///
/// The comparison checks BOTH rungs of the identity ladder (uuid and email form), because
/// [`identity_key`] returns the uuid once a login records one, so an unchanged login's key changes
/// the first time `accountUuid` appears — a ladder climb is not a different account.
fn effective_exhaustion(acct: &Account, current: Option<&OauthIdentity>, now: i64) -> Option<i64> {
    let until = acct.exhausted_until.filter(|&e| e > now)?;
    // BOTH rungs of the ladder, not just the preferred key. `identity_key` returns the uuid when the
    // login records one and the email form otherwise, so ONE unchanged login's key CHANGES the
    // moment Claude Code refreshes a profile and `accountUuid` first appears. Comparing only the
    // preferred key reads that as a different account and drops a real bench — the same
    // ladder-climb-is-not-a-takeover rule already implemented for the identity ledger, which I
    // failed to carry across to this comparison.
    let matches = |owner: &str| {
        current.is_some_and(|c| {
            c.account_uuid.as_deref() == Some(owner) || email_key(c) == owner
        })
    };
    match (acct.exhausted_identity.as_deref(), current) {
        (None, _) => Some(until), // legacy row: honour, it expires on its own
        // Cleared ONLY for a KNOWN different login — matched on either rung.
        (Some(owner), Some(_)) => matches(owner).then_some(until),
        (Some(_), None) => Some(until), // can't tell ≠ somebody else — see the policy above
    }
}

/// The later of two optional walls, treating `None` as "no wall". Used to fold a sibling's
/// exhaustion into an account's own: the identity stays benched until the LAST of its walls clears,
/// which is the fail-safe direction — never route work into a quota pool a sibling reports walled.
fn later_wall(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    }
}

/// Identity-aware effective exhaustion: `target`'s own [`effective_exhaustion`] rolled together with
/// every SIBLING registration that resolves to the SAME identity.
///
/// [`effective_exhaustion`] is strictly per-CONFIG-DIR: it answers only "is THIS registration's own
/// bench still owned by the login in it". But a rate limit is a fact about an ANTHROPIC ACCOUNT, and
/// the ~10 registered dirs collapse to ~4 distinct logins (multiple dirs per account — "DROdio
/// Storytell" and "DROdio Gmail" both resolve to one `accountUuid`; see
/// [`AccountIdentity::account_uuid`]). So when one dir of a login hits its wall, its sibling dirs
/// still read `exhausted_until: null` and the headroom ranker sees "healthy" accounts that are really
/// walled quota pools — which is the root cause of rotation repeatedly landing the fleet on walls.
///
/// Two dirs are SIBLINGS iff their live identities resolve to the SAME [`identity_key`] — the
/// `accountUuid` when present, its email form otherwise. Email STRING matching is deliberately NOT
/// used: two dirs can hold logins to one account under one email, which is the whole reason
/// `accountUuid` is the discriminator. An identity reads as exhausted if ANY sibling is currently
/// walled, and the epoch returned is the LATEST such wall (see [`later_wall`]) so the identity stays
/// benched until the last sibling clears.
///
/// UNKNOWN identity NEVER merges. A dir whose `.claude.json` does not resolve to an identity is
/// treated on its OWN — "can't resolve" is not "the same account as another unresolvable dir", the
/// same fail-safe [`effective_exhaustion`] applies to an unreadable owner. Merging two unknowns would
/// invent a sibling relationship on no evidence and could bench a genuinely healthy account.
///
/// `identities` is parallel to `accounts`; each entry is that account's live identity (`None` =
/// unresolvable). Kept as an injected slice rather than read here so the contagion logic is
/// unit-testable without the filesystem — [`resolve_identities`] is the file-reading half.
fn effective_exhaustion_across_identity_with(
    accounts: &[Account],
    identities: &[Option<OauthIdentity>],
    target_idx: usize,
    now: i64,
) -> Option<i64> {
    let target = &accounts[target_idx];
    let target_identity = identities[target_idx].as_ref();
    let mut wall = effective_exhaustion(target, target_identity, now);
    // Unknown identity: never merge with anyone. Treat this dir strictly on its own.
    let Some(target_key) = target_identity.map(identity_key) else {
        return wall;
    };
    for (i, sib) in accounts.iter().enumerate() {
        if i == target_idx {
            continue;
        }
        // A sibling with an unresolvable identity is never merged — unknown != same.
        let Some(sib_key) = identities[i].as_ref().map(identity_key) else {
            continue;
        };
        if sib_key != target_key {
            continue;
        }
        // The sibling's OWN effective exhaustion (ownership-checked against ITS current login), so a
        // sibling whose bench belongs to a since-switched login does not contaminate this one.
        wall = later_wall(wall, effective_exhaustion(sib, identities[i].as_ref(), now));
    }
    wall
}

/// Resolve every account's live identity in one pass — the file-reading half that
/// [`effective_exhaustion_across_identity_with`] is factored out from, so the contagion logic stays
/// unit-testable without touching the filesystem.
fn resolve_identities(accounts: &[Account], home: Option<&Path>) -> Vec<Option<OauthIdentity>> {
    accounts.iter().map(|a| identity_for_account(a, home)).collect()
}

/// Usage for EVERY account in one pass: one generation across all of them, eviction once at the
/// end. Extracted from the command body so the invariant is testable — inlined there, reverting to
/// a generation per account left every test green while restoring the memo thrash.
fn usage_for_accounts(accounts: &[Account], now: i64) -> Vec<AccountUsage> {
    let pass = UsagePass::start();
    let mut touched = 0usize;
    let mut usage: Vec<AccountUsage> = accounts
        .iter()
        .map(|a| {
            let (u, n) = usage_for_account(a, now, pass.id());
            touched += n;
            u
        })
        .collect();
    finish_usage_pass(pass, touched > 0);
    // Identity-level contagion. `usage_for_account` set each `exhausted_until` from that dir's OWN
    // bench alone, but a login's multiple config dirs share one Anthropic quota pool: a wall on ANY
    // sibling dir of the same identity walls this one too. Resolve identities once and fold siblings
    // in — without this the headroom ranker (and roborev, downstream) reads a walled login's other
    // dirs as healthy and rotation lands the fleet straight back onto the wall (sparkle-xsr6o).
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let identities = resolve_identities(accounts, home.as_deref());
    for (i, u) in usage.iter_mut().enumerate() {
        u.exhausted_until = effective_exhaustion_across_identity_with(accounts, &identities, i, now);
    }
    usage
}

// ---- the usage-RESULT memo (sparkle-xwnawc) -----------------------------------
//
// `usage_for_accounts` is the second off-main hot loop the founder's 2026-08-22 hang sample caught:
// 2,136 ms of one core in `stat()` walking the default account's ~17,316 `.jsonl` transcripts. The
// dir-LISTING cache (above) already took `read_dir` to zero on a settled tree, and the parse memo
// skips re-parsing an unchanged file — but the per-file `stat` is unavoidable PER PASS (an append
// bumps no directory mtime, so every file must be stat'd to catch it), so the only remaining lever
// is running FEWER passes.
//
// The passes that pile up are the ones no user asked for: `ProviderUnavailableBanner` re-reads on
// `USAGE_LIMIT_RECHECK_MS` (10s) for the whole time a limit is showing — hours — and each tick
// misses the frontend's own 5s `ACCOUNT_CACHE_TTL_MS` and pays the full walk (`sparkle-608gg` closed
// the IDENTITIES half of this; the token walk stayed). A short result memo lets that poll, and any
// burst of overlapping callers, share ONE walk.
//
// SAFE because it re-runs the moment anything that is NOT a slow-moving transcript tally moves. The
// key hashes each account's (id, config_dir, exhausted_until, exhausted_identity) AND its RESOLVED
// on-disk identity — the last of which is load-bearing and easy to miss (roborev 67848): the output
// `exhausted_until` is computed from `effective_exhaustion(acct, identity_for_account(acct, HOME))`
// and the cross-identity contagion fold (`sparkle-xsr6o`), both of which read `<config_dir>/.claude.
// json`. A terminal `claude login` / profile switch rewrites that file WITHOUT touching accounts.json,
// so keying on `Account` fields alone would keep serving `exhaustedUntil: null` for up to the TTL
// after a switch onto a walled login — routing a spawn straight onto the wall the fold exists to
// avoid. Hashing `identity_key_for` per account closes that (it also flips when `accountUuid` first
// appears — a re-walk in the safe direction). The identity read is the cheap half — a small JSON
// parse next to the 2.1s stat walk it guards.
//
// What it lets go stale is only `tokens_5h` / `tokens_7d` and a transcript-borne rate-limit event,
// all of which move on the scale of turns-per-minute against 5h/7d windows — 15s cannot shift a
// ranking or a reset countdown. The explicit-bench path (`republish_roborev_candidates`) deliberately
// calls the UNCACHED `usage_for_accounts`: it runs right after writing a bench and must observe it.
const USAGE_RESULT_TTL_SECS: i64 = 15;

/// One cached usage snapshot: the account-set key it was computed for, the epoch it was computed at,
/// and the result. A single slot (there is effectively one account set) — a newer set simply
/// overwrites it.
struct UsageResultCache {
    key: u64,
    at: i64,
    result: Vec<AccountUsage>,
}

fn usage_result_cache() -> &'static std::sync::Mutex<Option<UsageResultCache>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<UsageResultCache>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// The memo key: everything `usage_for_accounts`' result depends on that is NOT a transcript tally.
/// Any change here (add/remove/bench/switch-login) must force a fresh walk, so all of it is hashed —
/// including the RESOLVED on-disk identity, which a bare `Account` cannot see (roborev 67848). Reads
/// each account's `.claude.json` via `identity_key_for`; cheap next to the walk it gates.
fn usage_accounts_key(accounts: &[Account], home: Option<&Path>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    accounts.len().hash(&mut h);
    for a in accounts {
        a.id.hash(&mut h);
        a.config_dir.hash(&mut h);
        a.exhausted_until.hash(&mut h);
        a.exhausted_identity.hash(&mut h);
        // The live login behind this dir. `None` (a dir never logged into) hashes distinctly from any
        // resolved key, so a login appearing or disappearing also moves the key.
        identity_key_for(a, home).hash(&mut h);
    }
    h.finish()
}

/// [`usage_for_accounts`] served from a short-TTL result memo — the production entry point for the
/// banner/spawn/AccountsScreen path (the `accounts_usage` command). See the module comment above for
/// why this is sound. The cache slot is a parameter so the TTL/key logic is testable against a fresh,
/// isolated slot without the process-wide static; production passes [`usage_result_cache`].
fn usage_for_accounts_cached_in(
    accounts: &[Account],
    now: i64,
    home: Option<&Path>,
    cache: &std::sync::Mutex<Option<UsageResultCache>>,
) -> Vec<AccountUsage> {
    let key = usage_accounts_key(accounts, home);
    // Held ACROSS the walk on purpose (roborev 67848): the lock used to be dropped before computing
    // and re-taken only to store, so concurrent callers all missed and all paid the full 2.1s stat
    // walk — no coalescing, just sequential reuse. `accounts_usage` runs on `spawn_blocking` and
    // EVERY window's banner hits it, so N windows ticking in the same second stacked N walks on the
    // blocking pool — the exact core-burn this memo exists to stop. Holding the lock makes a
    // concurrent caller for the same key wait and then hit the entry this one stores: one walk, not N.
    // Poison is recovered rather than propagated — a panicked walk must not wedge every later usage
    // read behind a poisoned lock.
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = guard.as_ref() {
        // `now >= c.at` guards a clock that went backwards (also a test injecting an earlier
        // instant): treat that as a miss rather than serving from a future entry.
        if c.key == key && now >= c.at && now - c.at < USAGE_RESULT_TTL_SECS {
            return c.result.clone();
        }
    }
    let result = usage_for_accounts(accounts, now);
    *guard = Some(UsageResultCache { key, at: now, result: result.clone() });
    result
}

/// Production wrapper: [`usage_for_accounts_cached_in`] against the process-wide slot, resolving
/// `HOME` the same way `usage_for_accounts` does so the key sees the default account's identity.
fn usage_for_accounts_cached(accounts: &[Account], now: i64) -> Vec<AccountUsage> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    usage_for_accounts_cached_in(accounts, now, home.as_deref(), usage_result_cache())
}

/// Compute the usage snapshot for one account at `now`. Resolves the transcript root the SAME way
/// session detection does (`claude.rs::claude_projects_root`, passing the account's own
/// `config_dir`), then buckets. The stored `exhausted_until` is surfaced through
/// [`effective_exhaustion`] — being in the future is necessary but NOT sufficient, since a bench
/// belongs to the login that earned it rather than to the registration it is stored on.
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
            exhausted_until: effective_exhaustion(
                acct,
                identity_for_account(acct, std::env::var_os("HOME").map(PathBuf::from).as_deref())
                    .as_ref(),
                now,
            ),
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

/// The live identity behind ONE account's own config dir.
///
/// The `<home>` fallback is passed only for the DEFAULT account. A named account with an empty
/// `config_dir` must NOT fall back to the home identity — that would label the home user's email as
/// this account's, the exact trust bug this plumbing exists to prevent; it resolves to `None`
/// ("not signed in") instead.
fn identity_for_account(acct: &Account, home: Option<&Path>) -> Option<OauthIdentity> {
    let home_for = if acct.is_default { home } else { None };
    read_oauth_identity_at(Some(Path::new(&acct.config_dir)), home_for)
}


/// The key an account's learned history is filed under: the Anthropic `accountUuid` when the login
/// records one, otherwise the verified email.
///
/// Keying on the uuid ALONE is wrong, and costs a real capability rather than merely being untidy.
/// A login predating the `accountUuid` field reports `None` (documented on
/// [`OauthIdentity::account_uuid`]) while being fully signed in and fully attributable. Gating on
/// the uuid would return `ceiling: None` for such an account *forever*; `switchRecommendation`
/// reads that as `unknown`, so the near-cap banner could never fire for it again — and nothing
/// would distinguish that from the intended "this directory is unattributable" case. A silent,
/// permanent capability loss with no visible cause is worse than the imprecision it avoids.
///
/// The email is a weaker discriminator than the uuid — two config dirs can hold logins to the same
/// account under one email, which is exactly why `accountUuid` was added — so it is only ever the
/// fallback, never preferred. It is prefixed so a ledger row can never be mistaken for a uuid.
///
/// `None` only when NEITHER resolves (a dir never logged into). That single case is what the
/// contract means by unattributable.
fn identity_key(id: &OauthIdentity) -> String {
    id.account_uuid.clone().unwrap_or_else(|| email_key(id))
}

/// The email-form key for an identity — what [`identity_key`] returns when there is no uuid, and
/// always computable regardless.
///
/// The ledger needs BOTH forms, because the ladder is not stable over time for one account: a login
/// predating `accountUuid` is filed under its email, and when the field later appears its key
/// changes with no fork having occurred. Passing the email form alongside lets the ledger recognise
/// that climb and continue the existing epoch instead of recording a false takeover — see
/// `identity_log::apply_observation`.
fn email_key(id: &OauthIdentity) -> String {
    format!("email:{}", id.email)
}

/// [`identity_key`] for an account, or `None` when it has no resolvable identity at all.
fn identity_key_for(acct: &Account, home: Option<&Path>) -> Option<String> {
    identity_for_account(acct, home).as_ref().map(identity_key)
}

/// [`identity_key`] for the identity behind the user's LOGIN SHELL, or `None` when it has none.
///
/// Extracted as its own seam purely so it can be TESTED. It is the one derivation that is unique to
/// the cache-key path, and inlined in `accounts_ceilings` — a `#[tauri::command]` body — nothing
/// could reach it: `ceiling_cache_key` takes the shell identity as an opaque `Option<&str>`, so its
/// shell cases pass string literals and stay green whether the caller derives the identity KEY or
/// the raw `accountUuid`. That is a vacuous test of exactly the regression this ladder prevents
/// (AGENTS.md: an assertion that would pass against the pre-change code proves nothing).
///
/// The failure it silently permitted: a terminal `claude auth login` into an account predating
/// `accountUuid` leaves the shell half of the key unchanged, the cache hits, and the pre-login —
/// possibly another person's — ceiling is served for the full [`CEILING_CACHE_TTL`].
fn shell_identity_key_at(shell_config_dir: &str, home: Option<&Path>) -> Option<String> {
    shell_identity_at(shell_config_dir, home).as_ref().map(identity_key)
}

/// Do two resolved identities denote DIFFERENT Anthropic accounts?
///
/// The uuid decides when BOTH sides record one. When either does not, a bare `!=` on the uuids
/// would read `None != Some(x)` as a difference and invent one — announcing a fork between what may
/// well be the same account. So fall back to the email, which `read_oauth_identity_at` guarantees
/// is present and non-empty on every resolved identity. Never claims a difference it cannot show.
fn identities_differ(a: &OauthIdentity, b: &OauthIdentity) -> bool {
    match (a.account_uuid.as_deref(), b.account_uuid.as_deref()) {
        (Some(x), Some(y)) => x != y,
        _ => a.email != b.email,
    }
}

/// The identity a `claude` launched from the user's own LOGIN SHELL would run as.
///
/// `shell_config_dir` is `crate::claude::effective_spawn_config_dir()` — the `CLAUDE_CONFIG_DIR`
/// that shell actually exports, "" for none. Reading `$HOME/.claude.json` unconditionally would be
/// wrong for the user who exports one in `.zprofile`/`.zlogin`: their terminal reads
/// `<their dir>/.claude.json`, which is the SAME file the default account reads (that is why
/// `accounts_ensure_default` stores `effective_spawn_config_dir()` as the default's `config_dir`),
/// so there is no fork — but `$HOME/.claude.json` would hold a stale or unrelated login and we
/// would report one. Announcing a fork that does not exist is precisely the "a wrong identity is
/// worse than none" failure this surface was built to prevent.
fn shell_identity_at(shell_config_dir: &str, home: Option<&Path>) -> Option<OauthIdentity> {
    read_oauth_identity_at(Some(Path::new(shell_config_dir)), home)
}

/// Whether this account's transcript tree is ALSO written by a terminal `claude` running as a
/// DIFFERENT identity — the founder's own configuration, and a case the temporal ledger cannot fix.
///
/// With `config_dir = $HOME/.claude` the default account's projects root is
/// `$HOME/.claude/projects`, which is byte-identical to where a plain terminal `claude` (no
/// `CLAUDE_CONFIG_DIR`) writes. Two identities are then appending to ONE tree *concurrently*. That
/// is not a takeover: no uuid ever changes behind the config file, so `takeover_at` stays `None`,
/// nothing is cut, and the learned median silently mixes both people's consumption.
///
/// The ledger records WHEN an identity held a directory; it has nothing to say about two holding it
/// at once. So the only honest answer is that this directory is unattributable, and by the module's
/// own rule an unattributable directory yields no ceiling.
///
/// Narrow by construction: it requires the default account, two RESOLVABLE and DIFFERENT
/// identities, and the two roots to be the same path. A normalized default (`config_dir = ""`) and
/// an exported `CLAUDE_CONFIG_DIR` both read the same config file as the shell, so both resolve to
/// the same identity and are excluded.
///
/// "Different" is [`identities_differ`], not a bare uuid `!=`: a login predating `accountUuid`
/// would otherwise compare `None != Some(x)` and be declared a different account, blanking the
/// ceiling of an account that is not commingled at all.
fn shares_transcripts_with_a_different_shell_identity(
    acct: &Account,
    identity: Option<&OauthIdentity>,
    home: Option<&Path>,
    shell_config_dir: &str,
) -> bool {
    if !acct.is_default {
        return false;
    }
    let (Some(mine), Some(shell)) = (identity, shell_identity_at(shell_config_dir, home)) else {
        return false;
    };
    if !identities_differ(mine, &shell) {
        return false;
    }
    let shell_root =
        crate::claude::claude_projects_root(Some(Path::new(shell_config_dir)), home);
    shell_root.is_some() && projects_root_for_account_at(acct, home) == shell_root
}

/// Pure core of [`accounts_identities`].
///
/// Resolves every account's live identity, folds the observations into the identity-epoch ledger at
/// `log_path`, and builds the wire rows — including the SHELL identity, read once via
/// [`shell_identity_at`] (`shell_config_dir` when the login shell exports one, `$HOME/.claude.json`
/// otherwise) and attached only to the default account.
///
/// Takes the home, the shell's config dir and the ledger path rather than reading `$HOME` or
/// running a login shell itself, so the founder's exact forked state is reproducible in a unit test
/// without mutating process env.
fn identities_at(
    accounts: &[Account],
    home: Option<&Path>,
    shell_config_dir: &str,
    log_path: &Path,
    now: i64,
) -> Vec<AccountIdentity> {
    let resolved: Vec<Option<OauthIdentity>> =
        accounts.iter().map(|a| identity_for_account(a, home)).collect();
    let observations: Vec<(String, Option<(String, String)>)> = accounts
        .iter()
        .zip(&resolved)
        .map(|(a, id)| {
            (a.config_dir.clone(), id.as_ref().map(|i| (identity_key(i), email_key(i))))
        })
        .collect();
    // Recording is best-effort by construction (see `record_observations`): a failed ledger write
    // must never keep the user from seeing who they are signed in as.
    let log = identity_log::record_observations(log_path, &observations, now);
    // ONE read for every account: the shell config is a single file, and it is the same file
    // whichever account we are describing.
    let shell = shell_identity_at(shell_config_dir, home);
    let since = now - CEILING_LEARN_WINDOW;
    accounts
        .iter()
        .zip(resolved)
        .map(|(a, id)| {
            let key = id.as_ref().map(identity_key);
            let (email, organization, account_uuid) = match id {
                Some(i) => (Some(i.email), i.organization, i.account_uuid),
                None => (None, None, None),
            };
            // Keyed on the identity KEY, matching what was just written to the ledger — an older
            // login has no uuid but still gets a real epoch, so it still reports a takeover.
            let identity_changed = key
                .as_deref()
                .and_then(|k| identity_log::takeover_at(&log, &a.config_dir, k))
                .is_some_and(|t| t > since);
            let (shell_email, shell_account_uuid) = if a.is_default {
                (
                    shell.as_ref().map(|s| s.email.clone()),
                    shell.as_ref().and_then(|s| s.account_uuid.clone()),
                )
            } else {
                (None, None)
            };
            AccountIdentity {
                id: a.id.clone(),
                email,
                organization,
                account_uuid,
                shell_email,
                shell_account_uuid,
                identity_changed,
            }
        })
        .collect()
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
    tauri::async_runtime::spawn_blocking(move || {
        // ══ ADOPT ORPHANED CREDENTIALED DIRS — ONCE PER PROCESS ══════════════════════════════════
        // A dir holding a real login with no `accounts.json` record is invisible to everything, and
        // re-adding "the same" account mints a fresh empty one instead of reusing it. See
        // `adopt_orphan_dirs_at` for how they arise.
        //
        // ONCE, not on every call, and the reason is cost rather than correctness: this list is
        // polled on a 5s TTL by the whole app, and the scan reads each dir's `.claude.json` — files
        // that reach 35 KB apiece on a real machine. Orphans appear when a record is removed or
        // lost, which is rare and always precedes a restart in practice, so first-call is the right
        // cadence. Best-effort: an adoption failure must never hide the user's accounts.
        static ADOPTED: std::sync::Once = std::sync::Once::new();
        ADOPTED.call_once(|| {
            match adopt_orphan_dirs_at(&app_data, &accounts_json_path(&app_data), now_secs()) {
                Ok(a) if !a.is_empty() => {
                    tracing::info!(count = a.len(), "adopted orphaned credentialed account dirs");
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "could not scan for orphaned account dirs"),
            }
        });
        let accounts = read_accounts_at(&accounts_json_path(&app_data))?;
        // Heal accounts added BEFORE Sparkle seeded its allowlist at creation. Seeding only on
        // `accounts_add` would leave every already-registered identity permanently grant-less, and
        // this list is read before the picker chooses one — so an account is repaired before it can
        // be spawned on. Idempotent (a current file is not rewritten) and best-effort: never fail
        // the listing over it, or a bad file would hide the user's accounts entirely.
        for a in accounts.iter().filter(|a| !a.is_default && !a.config_dir.is_empty()) {
            if let Err(e) = ensure_account_allowlist_at(Path::new(&a.config_dir)) {
                tracing::warn!(account = %a.id, error = %e, "could not heal the account's Sparkle allowlist");
            }
            // Heal the onboarding marker on the SAME pass, and for a strictly larger population than
            // "accounts added before the fix": a dir can lose the marker at any time, because
            // `.claude.json` is Claude Code's own file and a fresh one starts without it. This runs
            // before the picker chooses, so an account is repaired before it can be spawned on.
            if let Err(e) = ensure_onboarding_marker_at(Path::new(&a.config_dir)) {
                tracing::warn!(account = %a.id, error = %e, "could not heal the account's onboarding marker");
            }
        }
        // FOLDER-TRUST BACKSTOP, on the same "repair before it can be spawned on" pass and for the
        // same reason — but keyed by WORKTREE rather than by account, because trust is recorded per
        // (config dir × key) and an account healed here would still meet an unseeded worktree.
        //
        // Once per app run: the population it reconciles only grows by a spawn, and every spawn
        // seeds itself. Doing it on each listing would re-walk the worktrees tree on a hot path for
        // nothing.
        static TRUST_SWEPT: std::sync::Once = std::sync::Once::new();
        TRUST_SWEPT.call_once(|| match sweep_folder_trust_at(&app_data) {
            Ok(0) => {}
            Ok(n) => tracing::info!(config_dirs = n, "swept folder trust for managed worktrees"),
            Err(e) => tracing::warn!(error = %e, "could not sweep folder trust"),
        });
        Ok(accounts)
    })
    .await
    .map_err(|e| format!("accounts_list task failed: {e}"))?
}

/// Pre-seed folder-trust acceptance for a worker's `worktree` into the account it will run under, so
/// the spawned `claude --dangerously-skip-permissions` skips Claude Code's "Is this a project you
/// trust?" dialog instead of hanging on it. Call this at spawn prep, AFTER the account is chosen and
/// BEFORE building the exec — it needs both the worktree path and the account's config dir.
///
/// `config_dir` is the chosen account's isolated config dir; empty/absent means the DEFAULT account,
/// whose `.claude.json` lives at `$HOME/.claude.json` (Claude Code reads `$HOME` when
/// `CLAUDE_CONFIG_DIR` is unset — mirroring [`crate::claude::spawn_env_config_dir`]'s empty rule).
///
/// Best-effort by contract: the caller warns and spawns anyway on `Err`, because a failure here is at
/// worst the pre-existing behavior (one trust prompt), never a reason to refuse to start the worker.
/// Runs on the blocking pool: it is a `.claude.json` read-modify-write, filesystem I/O that must not
/// stall the UI thread.
#[tauri::command]
pub async fn ensure_project_trusted(
    app: AppHandle,
    config_dir: Option<String>,
    worktree: String,
) -> Result<(), String> {
    let app_data = crate::worktree::app_data_dir_pub(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        let dir: PathBuf = match config_dir.filter(|s| !s.is_empty()) {
            Some(c) => PathBuf::from(c),
            None => match std::env::var_os("HOME").filter(|h| !h.is_empty()) {
                Some(h) => PathBuf::from(h),
                None => {
                    return Err(
                        "HOME is unset; cannot resolve the default account's .claude.json".into(),
                    )
                }
            },
        };
        // The account this spawn will actually run under, FIRST and on its own — it is the one that
        // must be right for THIS launch, and its result is what the caller is told about.
        let chosen = ensure_project_trusted_at(&dir, &worktree);
        // …then every other account, so a later rotation cannot re-earn the dialog. Advisory: a
        // failure to pre-seed an account this agent is not currently using must not be reported as a
        // failure of this spawn's own seeding.
        if let Some(app_data) = app_data {
            if let Err(e) = ensure_project_trusted_everywhere(&app_data, &worktree) {
                tracing::warn!(worktree = %worktree, error = %e, "partial cross-account folder-trust seed");
            }
        }
        chosen
    })
    .await
    .map_err(|e| format!("ensure_project_trusted task failed: {e}"))?
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

/// Record the Claude identity (email) for a token-authenticated account so it becomes routable.
///
/// Called by the paste-a-token flow AFTER `claude auth status` confirms a live CLI login: the token
/// works, so `email` is the account the CLI authenticated as. Writes `oauthAccount.emailAddress` into
/// the dir's `.claude.json` (see [`record_oauth_email_at`]) — the sole signal behind
/// `read_oauth_identity_at`/`isSignedIn`/`pickAccount`, without which a valid pasted token can never
/// receive a spawn. `config_dir` empty resolves to the default account's `$HOME/.claude.json`.
#[tauri::command]
pub fn account_record_oauth_identity(
    lock: State<'_, AccountsLock>,
    config_dir: String,
    email: String,
) -> Result<(), String> {
    let _guard = lock.guard();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let path = identity_json_path(Some(Path::new(&config_dir)), home.as_deref())
        .ok_or_else(|| "cannot resolve the account's config path (no HOME?)".to_string())?;
    record_oauth_email_at(&path, &email)
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
    // Capture the whole record BEFORE the row is gone — afterwards there is nothing to look it up
    // by, and `is_default` decides whether the prune below may run at all.
    let removed = read_accounts_at(&accounts_json_path(&app_data))
        .ok()
        .and_then(|v| v.into_iter().find(|a| a.id == id));
    // LOG THE CAUSE BEFORE RETURNING IT. A removal that fails and then succeeds on a later attempt
    // is a race or a lock, not a fluke, and diagnosing it needs the error that actually occurred —
    // but the only copy used to be the string handed to the frontend, which discarded it (a Tauri
    // command rejects with a bare STRING, so the screen's `e instanceof Error` test was false and it
    // substituted its own generic "Failed to remove"). The founder hit exactly that: repeated
    // failures, a later success, and nothing in the log to say why. Now the reason survives the
    // attempt regardless of what any caller does with it.
    if let Err(e) = remove_account_at(&accounts_json_path(&app_data), &id) {
        tracing::warn!(account = %id, error = %e, "accounts_remove failed");
        return Err(e);
    }
    // Drop this directory's identity history too, so a removed account's absolute path and every
    // email/uuid that ever held it do not outlive it with nothing reading them (knightwatch probe 3).
    //
    // ONLY when the directory is actually deleted. `dir_to_remove_on_remove` deliberately returns
    // `None` for the default, so the user's real `~/.claude` SURVIVES a "remove" and is re-imported
    // on the next launch by `accounts_ensure_default`. Pruning there would delete the takeover
    // boundary for a live directory — and that boundary is precisely what stops a ceiling being
    // learned across an identity change, so the damage would outlast the removal on a directory
    // still in daily use. Retention only justifies dropping history for a tree that is going away.
    if let Some(acct) = removed.filter(|a| !a.is_default) {
        identity_log::forget_config_dir_at(
            &identity_log::identity_log_path(&app_data),
            &acct.config_dir,
        );
    }
    Ok(())
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
    let home = std::env::var_os("HOME").map(PathBuf::from);
    mark_exhausted_at(&accounts_json_path(&app_data), &id, until_epoch, home.as_deref())?;
    // An observed wall is exactly the moment roborev must stop using that account. Republishing the
    // shim's candidate list HERE is what closes the rotation loop: the daemon is a launchd agent
    // Sparkle cannot signal, so the next review job discovers the change by reading this file.
    // Best-effort — a failed republish leaves the previous list in place (stale, but valid), and
    // must never fail the exhaustion write that the whole fleet depends on.
    if let Some(h) = home.as_deref() {
        republish_roborev_candidates(&app_data, h);
    }
    Ok(())
}

/// Recompute the roborev shim's account candidates from the accounts on disk.
///
/// Lives here rather than in `roborev_account` because it needs `read_accounts_at` +
/// `usage_for_accounts`, both private to this module. Errors are swallowed deliberately: every
/// caller is a best-effort refresh on a path whose real job is something else.
pub(crate) fn republish_roborev_candidates(app_data: &Path, home: &Path) {
    let Ok(all) = read_accounts_at(&accounts_json_path(app_data)) else {
        return;
    };

    // Drop registrations that are not actually signed in. WITHOUT this the rotation is worse than
    // no rotation: an unauthenticated account has consumed zero tokens, so it scores as the account
    // with the MOST headroom and every review is routed to the one account guaranteed to fail
    // ("Not logged in · Please run /login" — already 175 of the recorded failures).
    //
    // Fail OPEN if the check excludes everything: a credential probe that cannot read anything (a
    // keychain quirk, a locked login session) must not silently stop all reviews. Better to try a
    // possibly-stale account than to publish STANDDOWN on the strength of a failed probe.
    let signed_in: Vec<Account> = all
        .iter()
        .filter(|a| crate::account_usage::has_readable_credential(&a.config_dir))
        .cloned()
        .collect();
    let accounts = if signed_in.is_empty() { all } else { signed_in };

    let now = now_secs();
    let usages = usage_for_accounts(&accounts, now);
    let tallies: Vec<(String, u64)> = usages.iter().map(|u| (u.id.clone(), u.tokens_5h)).collect();
    let headroom = crate::roborev_account::headroom_from_tokens(&tallies);
    // TWO corrections compose here, both feeding the same publish:
    //
    // (1) IDENTITY-AWARE QUOTA EXHAUSTION (sparkle-xsr6o): `usage_for_accounts` computes exhaustion
    // per IDENTITY, so carry it onto the accounts roborev ranks — its ranker reads the raw
    // `exhausted_until` field (a deliberately pure, no-filesystem module), so the correction is
    // written back onto that field rather than duplicating the identity plumbing into it. Without it
    // a review routes to a sibling dir of a walled login and re-hits the same quota pool immediately.
    let corrected: Vec<Account> = accounts
        .iter()
        .map(|a| {
            let mut a = a.clone();
            a.exhausted_until = usages
                .iter()
                .find(|u| u.id == a.id)
                .and_then(|u| u.exhausted_until);
            a
        })
        .collect();

    // (2) REACTIVE OAUTH-EXPIRY BENCHING (sparkle-2kg6re): an account that is signed in but auth-dead
    // reads healthy to every OTHER signal (readable credential, zero usage ⇒ most headroom), so
    // without this it wins the ranking and every review dies at auth. Detected by scanning each
    // account's own transcripts for Claude Code's auth-error record, expanded across identity, and
    // dropped from the list — with the last-healthy guard inside the ranker, so this never strands
    // roborev. The scan reads config dirs / transcripts / identity, NOT `exhausted_until`, so it runs
    // on `accounts` (pre-correction) and composes with (1) rather than depending on it. Use the
    // caller's own `home` (it is `$HOME`; threading it the whole way through the usage path above is a
    // separate change) so the default account's roots resolve from a home a test can inject.
    let log = identity_log::read_log_at(&identity_log::identity_log_path(app_data));
    let auth_dead = roborev_auth_dead_dirs(&accounts, Some(home), &log, now);

    // Publish once: identity-CORRECTED accounts (so ranking/`is_healthy` is identity-aware) AND the
    // auth-dead exclusion. Both features hold — an auth-dead identity is excluded, and a walled
    // login's siblings are benched by the corrected exhaustion.
    let _ = crate::roborev_account::publish_candidates_excluding_auth_dead(
        home, &corrected, &headroom, &auth_dead, now,
    );
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
        // Cached: this command is the banner's 10s re-read and the spawn/AccountsScreen path, the
        // "runs constantly" caller. The memo coalesces both overlapping (single-flight under the
        // lock) and back-to-back walks, and re-runs the instant the account set, a bench, or a login
        // changes — see `usage_for_accounts_cached_in`.
        Ok(usage_for_accounts_cached(&accounts, now))
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
/// Also reports, on the DEFAULT account only, the identity a plain terminal `claude` would use
/// (`shell_email` / `shell_account_uuid`), so a fork between Sparkle and the user's shell is
/// visible instead of silent — see [`AccountIdentity::shell_email`]. And it is the hook that keeps
/// the identity-epoch ledger current; see [`identities_at`].
///
/// `async` + `spawn_blocking`: this opens `accounts.json` PLUS every account's own `.claude.json`,
/// so it is the heaviest read here — it must never run inline on the Tauri event-loop thread.
#[tauri::command]
pub async fn accounts_identities(app: AppHandle) -> Result<Vec<AccountIdentity>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AccountIdentity>, String> {
        let accounts = read_accounts_at(&accounts_json_path(&app_data))?;
        let home = std::env::var_os("HOME").map(PathBuf::from);
        // Through the login shell's REAL export, not a hardcoded `$HOME` — a user who exports
        // `CLAUDE_CONFIG_DIR` in their dotfiles reads that dir's config, and reporting `$HOME`'s
        // login as "your terminal" would invent a fork. Cached for the process after the first call.
        let shell_config_dir = crate::claude::effective_spawn_config_dir();
        Ok(identities_at(
            &accounts,
            home.as_deref(),
            &shell_config_dir,
            &identity_log::identity_log_path(&app_data),
            now_secs(),
        ))
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
        // The ledger, so a rate-limit event written by a PREVIOUS login in the same config dir is
        // not re-read and used to bench the current one. Both resolved ONCE here rather than per
        // account — and `home` is threaded rather than read from process env inside the helper, so
        // the takeover floor is reachable from a unit test (the same reason every sibling on this
        // path takes it).
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let log = identity_log::read_log_at(&identity_log::identity_log_path(&app_data));
        Ok(accounts
            .iter()
            .filter_map(|a| limit_event_for_account(a, now, home.as_deref(), &log))
            .collect())
    })
    .await
    .map_err(|e| format!("accounts_limit_events task failed: {e}"))?
}

/// Per-account learned rate-limit ceilings (see [`AccountCeiling`]). Cached for
/// [`CEILING_CACHE_TTL`] — learning walks 30 days of transcripts, far too expensive per poll —
/// but keyed on the account set, each account's resolved identity, and the SHELL's dir and identity
/// ([`ceiling_cache_key`]) — so adding an account, or a fresh `claude auth login` behind any config
/// dir INCLUDING the terminal's, invalidates it immediately rather than serving the previous
/// person's number for 15 minutes.
///
/// `async` + `spawn_blocking`: the heaviest read in this module by a wide margin.
#[tauri::command]
pub async fn accounts_ceilings(app: AppHandle) -> Result<Vec<AccountCeiling>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<AccountCeiling>, String> {
        let now = now_secs();
        // Reading `accounts.json` plus one `.claude.json` per account is cheap — microseconds
        // against the 30-day transcript walk the cache exists to avoid — and it is what the cache
        // must be keyed on, so it happens BEFORE the lookup rather than after it.
        let accounts = read_accounts_at(&accounts_json_path(&app_data))?;
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let uuids: Vec<Option<String>> =
            accounts.iter().map(|a| identity_key_for(a, home.as_deref())).collect();
        // The SHELL's dir and identity are inputs to the result (they can suppress a ceiling), so
        // they are resolved before the lookup and keyed on. Stated tradeoff: this makes a cache HIT
        // pay `effective_spawn_config_dir()` — a login-shell probe of 100-500ms, but `OnceLock`-
        // cached, so once per process rather than never. Serving one person's ceiling to another
        // for 15 minutes is the worse bargain.
        //
        // The shell side is keyed by `identity_key` too, not its raw uuid: a shell re-login into an
        // account predating `accountUuid` would otherwise leave the key unchanged and serve the
        // pre-login ceiling — the same hole this key closes for the account side.
        let shell_config_dir = crate::claude::effective_spawn_config_dir();
        let shell_key = shell_identity_key_at(&shell_config_dir, home.as_deref());
        let key = ceiling_cache_key(
            &app_data,
            &accounts,
            &uuids,
            &shell_config_dir,
            shell_key.as_deref(),
        );
        if let Ok(guard) = ceiling_cache().lock() {
            if let Some(hit) = ceiling_cache_lookup(&guard, &key, now) {
                return Ok(hit);
            }
        }
        // Record here too, not only on the identity path: this is the surface whose correctness
        // depends on the takeover being on record, and it has already resolved every uuid.
        // Both key forms, like the identity path: the email form is what lets a login whose
        // `accountUuid` has only just appeared continue its epoch rather than read as a takeover.
        let observations: Vec<(String, Option<(String, String)>)> = accounts
            .iter()
            .map(|a| {
                (
                    a.config_dir.clone(),
                    identity_for_account(a, home.as_deref())
                        .as_ref()
                        .map(|i| (identity_key(i), email_key(i))),
                )
            })
            .collect();
        let log = identity_log::record_observations(
            &identity_log::identity_log_path(&app_data),
            &observations,
            now,
        );
        let shell_config_dir = crate::claude::effective_spawn_config_dir();
        let out: Vec<AccountCeiling> = accounts
            .iter()
            .map(|a| ceiling_for_account(a, now, home.as_deref(), &shell_config_dir, &log))
            .collect();
        if let Ok(mut guard) = ceiling_cache().lock() {
            *guard = Some((key, now, out.clone()));
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

    /// accounts.json must be owner-only, and so must the directory holding it (audit M2).
    #[test]
    #[cfg(unix)]
    fn accounts_json_and_its_dir_are_owner_only_and_self_heal() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("accounts-store");
        let path = dir.join("accounts.json");

        write_accounts_at(&path, &[]).unwrap();

        let fmode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let dmode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(fmode, 0o600, "accounts.json must not be world-readable");
        assert_eq!(dmode & 0o077, 0, "the accounts dir must not be listable by others");

        // SELF-HEALING: an install created before this fix already has a 0644 file on disk, and a
        // creation-time-only fix would never reach it.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_accounts_at(&path, &[]).unwrap();
        let healed = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(healed, 0o600, "a pre-existing 0644 file must be tightened");
    }

    #[test]
    #[cfg(unix)]
    fn tighten_mode_never_widens_an_already_stricter_file() {
        // A deployment that keeps its files at 0400 must not be LOOSENED by our own hardening.
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("x");
        std::fs::write(&f, b"x").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o400)).unwrap();
        tighten_mode(&f, 0o600);
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o400);
    }
    /// Build an `OauthIdentity` for the exhaustion tests. `uuid`/`email` are independent so both
    /// rungs of the identity ladder can be exercised.
    fn oauth(uuid: Option<&str>, email: &str) -> OauthIdentity {
        OauthIdentity {
            email: email.to_string(),
            organization: None,
            account_uuid: uuid.map(str::to_string),
        }
    }

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
        exhausted_identity: None,
        }
    }

    /// The one piece of NEW logic on the concierge's rotation-bench path: map the failed
    /// `config_dir` back to the account id `mark_exhausted_at` benches. Asserts the SIDE EFFECT — the
    /// id that gets benched — for each shape, including the two that must NOT bench a wrong account:
    /// an empty query (the shared default) and a non-matching dir.
    #[test]
    fn account_id_for_config_dir_maps_only_a_real_dedicated_dir() {
        let accounts = vec![
            sample("default", true, ""),
            sample("acct-b", false, "/accounts/acct-b"),
            sample("acct-c", false, "/accounts/acct-c"),
        ];
        assert_eq!(account_id_for_config_dir(&accounts, "/accounts/acct-b").as_deref(), Some("acct-b"));
        assert_eq!(account_id_for_config_dir(&accounts, "/accounts/acct-c").as_deref(), Some("acct-c"));
        // An empty query must NOT match the default's empty `config_dir` — benching the default by a
        // blank string is exactly the ambiguity this guard prevents.
        assert_eq!(account_id_for_config_dir(&accounts, ""), None);
        // A dir no account is registered under benches nothing rather than the wrong account.
        assert_eq!(account_id_for_config_dir(&accounts, "/accounts/gone"), None);
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
        exhausted_identity: None,
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

    // sparkle-xwnawc: the result memo must (a) serve a repeat call within the TTL WITHOUT re-walking
    // the transcript tree — that is the whole point, coalescing the banner's 10s re-read — and (b)
    // re-walk once the TTL passes. Proven by the strongest available side effect: DELETE the
    // transcripts between calls. An actual walk of a deleted tree yields 0; getting the pre-deletion
    // tally back can ONLY mean the walk was skipped.
    #[test]
    fn the_usage_result_memo_skips_the_walk_within_ttl_and_rewalks_after() {
        let base = unique_dir("usage-result-memo");
        let cfg = base.join("acct");
        let proj = cfg.join("projects").join("p");
        let ts = "2026-06-25T21:20:25.931Z";
        let now = parse_iso8601_to_epoch("2026-06-25T21:30:00.000Z").unwrap();
        let seed = |tokens: u64| {
            std::fs::create_dir_all(&proj).unwrap();
            std::fs::write(
                proj.join("s.jsonl"),
                format!(
                    "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\
                     \"usage\":{{\"input_tokens\":{tokens},\"output_tokens\":0}}}}}}\n"
                ),
            )
            .unwrap();
        };
        let account = || Account {
            id: "acct".into(),
            nickname: "acct".into(),
            config_dir: cfg.to_string_lossy().into_owned(),
            is_default: false,
            created_at: 0,
            exhausted_until: None,
            exhausted_identity: None,
        };
        // A FRESH, isolated slot — never the process-wide static — so this is deterministic and does
        // not contend with any other test.
        let slot = std::sync::Mutex::new(None);

        seed(11);
        let accounts = vec![account()];
        let a = usage_for_accounts_cached_in(&accounts, now, None, &slot);
        assert_eq!(a[0].tokens_7d, 11, "cold call walks and tallies the seeded transcript");

        // Delete the whole tree. A real walk now yields 0.
        std::fs::remove_dir_all(&base).unwrap();

        // Within the TTL: MUST be served from the memo (11), not re-walked (which would be 0).
        let b = usage_for_accounts_cached_in(&accounts, now + USAGE_RESULT_TTL_SECS - 1, None, &slot);
        assert_eq!(
            b[0].tokens_7d, 11,
            "a repeat call within the TTL must reuse the cached result and NOT re-walk \
             (a re-walk of the deleted tree would be 0)"
        );

        // Past the TTL: MUST re-walk, and the walk now sees the deleted tree → 0.
        let c = usage_for_accounts_cached_in(&accounts, now + USAGE_RESULT_TTL_SECS, None, &slot);
        assert_eq!(
            c[0].tokens_7d, 0,
            "once the TTL elapses the memo must re-walk — and the tree is gone, so the tally is 0"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // sparkle-xwnawc: the memo must NOT outlive a change to anything that is not a slow transcript
    // tally. A bench (or add/remove/switch-login) changes the key, so even inside the TTL the next
    // call re-walks rather than serving a snapshot taken before the change.
    #[test]
    fn a_bench_changes_the_key_and_forces_a_rewalk_inside_the_ttl() {
        let base = unique_dir("usage-result-memo-key");
        let cfg = base.join("acct");
        let proj = cfg.join("projects").join("p");
        let ts = "2026-06-25T21:20:25.931Z";
        let now = parse_iso8601_to_epoch("2026-06-25T21:30:00.000Z").unwrap();
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join("s.jsonl"),
            format!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\
                 \"usage\":{{\"input_tokens\":11,\"output_tokens\":0}}}}}}\n"
            ),
        )
        .unwrap();
        let account = |exhausted: Option<i64>| Account {
            id: "acct".into(),
            nickname: "acct".into(),
            config_dir: cfg.to_string_lossy().into_owned(),
            is_default: false,
            created_at: 0,
            exhausted_until: exhausted,
            exhausted_identity: None,
        };
        let slot = std::sync::Mutex::new(None);

        let a = usage_for_accounts_cached_in(&[account(None)], now, None, &slot);
        assert_eq!(a[0].tokens_7d, 11, "cold call walks");

        // Delete the tree so any real re-walk is observable as 0.
        std::fs::remove_dir_all(&base).unwrap();

        // Same instant window, but the account is now benched → the key differs → the memo entry is
        // NOT reused and the call re-walks (seeing the deleted tree → 0). If the key ignored
        // `exhausted_until` this would wrongly return 11.
        let b = usage_for_accounts_cached_in(&[account(Some(now + 3600))], now + 1, None, &slot);
        assert_eq!(
            b[0].tokens_7d, 0,
            "a bench must change the key and force a fresh walk even inside the TTL"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // roborev 67848: the output `exhausted_until` depends on the account's LIVE on-disk identity
    // (`.claude.json`), which a `claude login` / "Switch login" rewrites without touching
    // accounts.json. The memo key must therefore fold in the resolved identity, or a switch onto a
    // walled login would keep being reported healthy for the whole TTL. Proven by switching the
    // identity (and only the identity — the `Account` struct is byte-identical across the two calls)
    // between two within-TTL calls; the transcript tree is deleted too so the forced re-walk is
    // observable as 0. Drop the `identity_key_for` hash and this returns the cached 11.
    #[test]
    fn a_login_switch_changes_the_key_and_forces_a_rewalk_inside_the_ttl() {
        let base = unique_dir("usage-result-memo-identity");
        let cfg = base.join("acct");
        let proj = cfg.join("projects").join("p");
        let ts = "2026-06-25T21:20:25.931Z";
        let now = parse_iso8601_to_epoch("2026-06-25T21:30:00.000Z").unwrap();
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join("s.jsonl"),
            format!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\
                 \"usage\":{{\"input_tokens\":11,\"output_tokens\":0}}}}}}\n"
            ),
        )
        .unwrap();
        // A non-default account reads its identity from `<config_dir>/.claude.json`, so `home` is
        // irrelevant here and passed as `None`.
        let login = |uuid: &str| {
            std::fs::write(
                cfg.join(".claude.json"),
                format!(
                    "{{\"oauthAccount\":{{\"emailAddress\":\"user@example.com\",\
                     \"accountUuid\":\"{uuid}\"}}}}"
                ),
            )
            .unwrap();
        };
        let account = || Account {
            id: "acct".into(),
            nickname: "acct".into(),
            config_dir: cfg.to_string_lossy().into_owned(),
            is_default: false,
            created_at: 0,
            exhausted_until: None,
            exhausted_identity: None,
        };
        let slot = std::sync::Mutex::new(None);

        login("uuid-one");
        let a = usage_for_accounts_cached_in(&[account()], now, None, &slot);
        assert_eq!(a[0].tokens_7d, 11, "cold call walks under the first login");

        // Switch the login on disk and delete the transcripts. The `Account` value is unchanged.
        login("uuid-two");
        std::fs::remove_dir_all(cfg.join("projects")).unwrap();

        let b = usage_for_accounts_cached_in(&[account()], now + 1, None, &slot);
        assert_eq!(
            b[0].tokens_7d, 0,
            "a login switch must change the key and force a fresh walk even inside the TTL — \
             otherwise a switch onto a walled login is served as healthy"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // roborev 67849: the three tests above inject their own slot, leaving the PRODUCTION seam — the
    // `usage_for_accounts_cached` wrapper that binds the memo to the process-wide static, and the
    // `accounts_usage` line that calls it — covered by nothing (reverting that line to the uncached
    // walk would keep the suite green: the "defaulted seam every test injects", sparkle-lgbwf). This
    // drives the real wrapper. It is stable under parallel execution: no other test touches that
    // static slot, and `unique_dir` gives a key no other account shares.
    #[test]
    fn the_production_usage_memo_wrapper_binds_the_process_wide_slot() {
        let base = unique_dir("usage-result-memo-prod");
        let cfg = base.join("acct");
        let proj = cfg.join("projects").join("p");
        let ts = "2026-06-25T21:20:25.931Z";
        let now = parse_iso8601_to_epoch("2026-06-25T21:30:00.000Z").unwrap();
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join("s.jsonl"),
            format!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"assistant\",\"message\":{{\
                 \"usage\":{{\"input_tokens\":11,\"output_tokens\":0}}}}}}\n"
            ),
        )
        .unwrap();
        let accounts = vec![Account {
            id: "prod-wrapper-acct".into(),
            nickname: "acct".into(),
            config_dir: cfg.to_string_lossy().into_owned(),
            is_default: false,
            created_at: 0,
            exhausted_until: None,
            exhausted_identity: None,
        }];

        let a = usage_for_accounts_cached(&accounts, now);
        assert_eq!(a[0].tokens_7d, 11, "cold call through the real wrapper walks");

        // Delete the tree: a real walk now yields 0, so returning 11 proves the wrapper's static slot
        // served it.
        std::fs::remove_dir_all(&base).unwrap();
        let b = usage_for_accounts_cached(&accounts, now + USAGE_RESULT_TTL_SECS - 1);
        assert_eq!(
            b[0].tokens_7d, 11,
            "the production wrapper must serve a within-TTL call from the process-wide slot — \
             reverting accounts_usage to the uncached walk fails here"
        );

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
        write_identity(&base, FIXTURE_UUID);
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
        let got = ceiling_for_account(&sample("c9", false, base.to_str().unwrap()), now, None, "", &no_log());
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
    fn the_ledger_prune_spares_a_default_whose_directory_survives_removal() {
        // roborev 58164: the prune had no is_default guard, while `dir_to_remove_on_remove`
        // deliberately keeps a default's directory on disk (it is the user's real ~/.claude and is
        // re-imported next launch). Pruning there deletes the takeover boundary for a LIVE tree —
        // and that boundary is what stops a ceiling being learned across an identity change, so the
        // damage outlives the removal. Named/non-default dirs are genuinely deleted, so their
        // history should go with them.
        let home = unique_dir("prune-default-guard");
        let default_acct = sample("d", true, home.join(".claude").to_str().unwrap());
        let named = sample("n", false, home.join("named").to_str().unwrap());
        assert!(
            dir_to_remove_on_remove(&default_acct).is_none(),
            "a default's directory survives removal, so its history must too"
        );
        assert!(
            dir_to_remove_on_remove(&named).is_some(),
            "a named account's directory is deleted, so pruning its history is right"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn mark_exhausted_records_WHO_was_signed_in_when_the_bench_was_taken() {
        // THE WRITE HALF, which nothing pinned. The existing callers pass `home: None` against a
        // `sample()` whose config_dir does not exist, so `identity_key_for` returns None and the
        // assignment is a no-op — delete the line and the suite stays green while every exhaustion
        // becomes a "legacy" row that `effective_exhaustion` honours unconditionally, restoring the
        // bug in full. My own mutation check only exercised the READ side (roborev 58210).
        let dir = unique_dir("mark-exhausted-identity");
        write_claude_json(
            &dir,
            r#"{"oauthAccount":{"emailAddress":"me@example.com","accountUuid":"uuid-mine"}}"#,
        );
        let path = dir.join("accounts.json");
        write_accounts_at(&path, &[sample("a", false, dir.to_str().unwrap())]).unwrap();

        let until = now_secs() + 3_600;
        mark_exhausted_at(&path, "a", until, None).unwrap();

        let stored = read_accounts_at(&path).unwrap();
        assert_eq!(
            stored[0].exhausted_identity.as_deref(),
            Some("uuid-mine"),
            "the bench must record WHICH login earned it"
        );
        // …and it round-trips: a different login does not inherit it, the same one does.
        assert_eq!(
            effective_exhaustion(&stored[0], Some(&oauth(Some("uuid-other"), "other@x.com")), now_secs()),
            None
        );
        assert_eq!(
            effective_exhaustion(&stored[0], Some(&oauth(Some("uuid-mine"), "me@example.com")), now_secs()),
            Some(until)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_limit_event_from_the_previous_login_does_not_bench_the_current_one() {
        // THE TAKEOVER FLOOR, which had no test and was unreachable from one until `home` was
        // threaded through instead of read from process env. Transcripts carry no account marker, so
        // the previous login's rate-limit event sits in the same tree; the frontend polls this and
        // calls markExhausted on whatever it finds. Replacing the floor with a bare lookback
        // restores the pre-fix behaviour, and nothing caught that (roborev 58210).
        let dir = unique_dir("limit-event-takeover-floor");
        write_claude_json(&dir, r#"{"oauthAccount":{"accountUuid":"uuid-new","emailAddress":"n@x.com"}}"#);
        let projects = dir.join("projects");
        std::fs::create_dir_all(&projects).unwrap();

        let old_iso = "2026-07-22T10:30:00.000Z"; // the PREVIOUS login's event
        let new_iso = "2026-07-22T11:30:00.000Z"; // ours
        let takeover = parse_iso8601_to_epoch("2026-07-22T11:00:00.000Z").unwrap();
        let now = parse_iso8601_to_epoch("2026-07-22T12:00:00.000Z").unwrap();
        let after = parse_iso8601_to_epoch(new_iso).unwrap();
        let before = parse_iso8601_to_epoch(old_iso).unwrap();

        // OLDER event only: with no boundary it is visible, which is what makes the assertion below
        // meaningful rather than a restatement of "the newest wins".
        std::fs::write(projects.join("s.jsonl"), format!("{}\n", limit_line(old_iso, "old login"))).unwrap();
        let acct = sample("a", false, dir.to_str().unwrap());
        assert_eq!(
            limit_event_for_account(&acct, now, None, &no_log()).map(|e| e.at_epoch),
            Some(before),
            "with no ledger boundary the pre-takeover event IS returned"
        );

        // Same transcript, but the ledger says a different login held this dir until `takeover`.
        let log = log_with_takeover(&dir, "uuid-old", "uuid-new", takeover);
        assert_eq!(
            limit_event_for_account(&acct, now, None, &log),
            None,
            "someone else's rate-limit event must not bench the current login"
        );

        // And our OWN post-takeover event still benches us.
        std::fs::write(
            projects.join("s.jsonl"),
            format!("{}\n{}\n", limit_line(old_iso, "old login"), limit_line(new_iso, "ours")),
        )
        .unwrap();
        assert_eq!(
            limit_event_for_account(&acct, now, None, &log).map(|e| e.at_epoch),
            Some(after),
            "our own event after the takeover is still ours"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_re_mark_with_an_unreadable_config_does_not_erase_the_recorded_owner() {
        // roborev 58228. The write side used to assign unconditionally, so a transiently
        // unresolvable read (Claude Code rewrites .claude.json continuously; limitSync re-marks on a
        // poll cadence, sampling that window repeatedly) overwrote a KNOWN owner with None. That
        // turns the row into a LEGACY row, legacy rows are honoured unconditionally, and the next
        // genuinely different login then inherits a bench it never earned — with the provenance
        // destroyed and unrecoverable. Losing it on a RE-mark is strictly worse than never having it.
        let dir = unique_dir("remark-keeps-owner");
        write_claude_json(
            &dir,
            r#"{"oauthAccount":{"emailAddress":"me@example.com","accountUuid":"uuid-mine"}}"#,
        );
        let path = dir.join("accounts.json");
        write_accounts_at(&path, &[sample("a", false, dir.to_str().unwrap())]).unwrap();

        // Real-time-relative: `mark_exhausted_at` compares against `now_secs()` to decide whether a
        // LIVE bench is on record, so a fixed 2023 epoch would read as already expired.
        let until = now_secs() + 3_600;
        mark_exhausted_at(&path, "a", until, None).unwrap();
        assert_eq!(read_accounts_at(&path).unwrap()[0].exhausted_identity.as_deref(), Some("uuid-mine"));

        // The config becomes unreadable mid-write, and a poll re-marks in that tick.
        std::fs::remove_file(dir.join(".claude.json")).unwrap();
        let _ = mark_exhausted_at(&path, "a", until + 3_600, None); // reported as Err, retried next poll

        let stored = read_accounts_at(&path).unwrap();
        assert_eq!(
            stored[0].exhausted_identity.as_deref(),
            Some("uuid-mine"),
            "an unreadable tick must not erase who earned the bench"
        );
        // Which is what keeps the inheritance guard working afterwards.
        assert_eq!(
            effective_exhaustion(&stored[0], Some(&oauth(Some("uuid-other"), "other@x.com")), now_secs()),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bench_is_never_paired_with_a_stale_owner() {
        // The half-measure that preserving the owner introduced: advancing `exhausted_until` while
        // keeping the PREVIOUS login's name pairs a new login's bench with the old owner. Once the
        // config resolves, effective_exhaustion reads that as a mismatch, drops a REAL bench, and
        // pickAccount routes work into a still-rate-limited login. The two fields are one record.
        let dir = unique_dir("bench-pair-atomic");
        write_claude_json(&dir, r#"{"oauthAccount":{"emailAddress":"a@x.com","accountUuid":"uuid-a"}}"#);
        let path = dir.join("accounts.json");
        write_accounts_at(&path, &[sample("a", false, dir.to_str().unwrap())]).unwrap();
        let until = now_secs() + 3_600; // a LIVE bench — the arm under test only skips for one
        mark_exhausted_at(&path, "a", until, None).unwrap();

        // The config becomes unreadable and a NEW limit is observed in that tick.
        std::fs::remove_file(dir.join(".claude.json")).unwrap();
        // Reported as a FAILURE, not silently swallowed: limitSync's contract is "report only the
        // writes that actually LANDED", and it retries on the next poll.
        assert!(
            mark_exhausted_at(&path, "a", until + 3_600, None).is_err(),
            "an unrecordable bench must not report success"
        );

        let stored = read_accounts_at(&path).unwrap();
        assert_eq!(
            (stored[0].exhausted_until, stored[0].exhausted_identity.as_deref()),
            (Some(until), Some("uuid-a")),
            "neither field moves without the other — no new timestamp under a stale owner"
        );
        // …so the standing bench still protects its own account rather than being dropped as a
        // mismatch the moment the identity resolves again.
        assert_eq!(
            effective_exhaustion(&stored[0], Some(&oauth(Some("uuid-a"), "a@x.com")), now_secs()),
            Some(until)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unowned_live_bench_can_still_be_extended() {
        // The regression my own previous fix introduced: `None if live_bench => Err` fired even with
        // NO owner on record. An unowned bench has no owner to be stale, so refusing there is pure
        // loss. A named account with an empty config_dir is persistently unresolvable BY DESIGN, so
        // it would record a limit unowned at 2:00 resetting 3:00, refuse the 2:30 limit resetting
        // 6:00, let the 3:00 bench expire, and read healthy while genuinely limited until 6:00.
        let dir = unique_dir("unowned-bench-extend");
        let path = dir.join("accounts.json");
        std::fs::create_dir_all(&dir).unwrap();
        let mut acct = sample("a", false, dir.to_str().unwrap());
        acct.exhausted_until = Some(now_secs() + 600); // LIVE…
        acct.exhausted_identity = None; // …but UNOWNED
        write_accounts_at(&path, &[acct]).unwrap();

        // No .claude.json here, so the identity is unresolvable — the arm under test.
        let later = now_secs() + 7_200;
        mark_exhausted_at(&path, "a", later, None)
            .expect("an UNOWNED live bench has no owner to protect — the later limit must land");

        let stored = read_accounts_at(&path).unwrap();
        assert_eq!(stored[0].exhausted_until, Some(later), "the longer limit is recorded");
        assert_eq!(stored[0].exhausted_identity, None, "and stays unowned");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_bench_does_not_block_recording_a_new_one() {
        // The hole the "change nothing" arm left: it was justified by "the standing bench protects
        // the account meanwhile", which is false once that bench has EXPIRED. Nothing ever clears
        // exhausted_identity, so a row keeps its owner forever — and for a config dir that is
        // persistently unresolvable the account could then NEVER be benched again, with pickAccount
        // routing work into a genuinely rate-limited login indefinitely.
        let dir = unique_dir("expired-bench-rerecord");
        write_claude_json(&dir, r#"{"oauthAccount":{"emailAddress":"a@x.com","accountUuid":"uuid-a"}}"#);
        let path = dir.join("accounts.json");
        let mut acct = sample("a", false, dir.to_str().unwrap());
        // A bench that has already aged out, still carrying its owner.
        acct.exhausted_until = Some(now_secs() - 60);
        acct.exhausted_identity = Some("uuid-a".to_string());
        write_accounts_at(&path, &[acct]).unwrap();

        // The config is unreadable when the NEW limit is observed.
        std::fs::remove_file(dir.join(".claude.json")).unwrap();
        let future = now_secs() + 3_600;
        mark_exhausted_at(&path, "a", future, None).expect("an expired bench must not block a new one");

        let stored = read_accounts_at(&path).unwrap();
        assert_eq!(stored[0].exhausted_until, Some(future), "the new limit IS recorded");
        assert_eq!(
            stored[0].exhausted_identity, None,
            "recorded UNOWNED rather than under the stale owner — honoured, and it ages out"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_login_that_gains_a_uuid_keeps_its_own_bench() {
        // THE LADDER, on this comparison too. identity_key is uuid-else-email, so one unchanged
        // login's key changes from `email:<addr>` to `<uuid>` the moment Claude Code refreshes the
        // profile and the field first appears. Comparing only the preferred key reads that as a
        // different account and drops a real bench. I implemented this rule for the identity ledger
        // and failed to carry it here (roborev, PR #1243).
        let now = 1_700_000_000;
        let mut acct = sample("a", false, "/dirs/a");
        acct.exhausted_until = Some(now + 3_600);
        acct.exhausted_identity = Some("email:same@example.com".to_string()); // filed pre-uuid

        // Same login, now reporting a uuid it never reported before.
        assert_eq!(
            effective_exhaustion(&acct, Some(&oauth(Some("uuid-same"), "same@example.com")), now),
            Some(now + 3_600),
            "a ladder climb is the same login — its bench must survive"
        );
        // And a genuinely different login still does not inherit it.
        assert_eq!(
            effective_exhaustion(&acct, Some(&oauth(Some("uuid-other"), "other@example.com")), now),
            None
        );
    }

    #[test]
    fn an_exhaustion_does_not_survive_a_switch_to_a_different_login() {
        // knightwatch: an exhaustion is a fact about an ANTHROPIC ACCOUNT but is stored on a
        // REGISTRATION, and "Switch login" changes the identity under it. Surfacing it blindly
        // hands the NEW login a bench it never earned, so pickAccount skips a usable account until
        // the epoch passes — the same account-keyed-state-outliving-its-identity bug as the ceiling.
        let now = 1_700_000_000;
        let mut acct = sample("a", false, "/dirs/a");
        acct.exhausted_until = Some(now + 3_600);
        acct.exhausted_identity = Some("uuid-old".to_string());

        assert_eq!(
            effective_exhaustion(&acct, Some(&oauth(Some("uuid-old"), "old@x.com")), now),
            Some(now + 3_600),
            "the login that EARNED the bench still serves it"
        );
        assert_eq!(
            effective_exhaustion(&acct, Some(&oauth(Some("uuid-new"), "new@x.com")), now),
            None,
            "a different login must NOT inherit it"
        );
        // "We cannot resolve who is behind the directory right now" is NOT "somebody else". The
        // config file is rewritten continuously, so one truncated read would otherwise drop a live
        // bench for a tick and show a rate-limited account as healthy. The WRITE side already
        // honours the unresolvable case, and this makes the read side agree (roborev 58210).
        assert_eq!(
            effective_exhaustion(&acct, None, now),
            Some(now + 3_600),
            "an unreadable identity keeps the bench — can't-tell is not somebody-else"
        );

        // Legacy rows carry no owner. Honour them: a limit resets within ~5h so they age out on
        // their own, and routing work INTO an exhausted account is the worse of the two errors.
        let mut legacy = sample("b", false, "/dirs/b");
        legacy.exhausted_until = Some(now + 3_600);
        assert_eq!(effective_exhaustion(&legacy, Some(&oauth(Some("uuid-any"), "any@x.com")), now), Some(now + 3_600));

        // And an expired exhaustion is never surfaced, whoever owned it.
        let mut past = sample("c", false, "/dirs/c");
        past.exhausted_until = Some(now - 1);
        past.exhausted_identity = Some("uuid-old".to_string());
        assert_eq!(effective_exhaustion(&past, Some(&oauth(Some("uuid-old"), "old@x.com")), now), None);
    }

    #[test]
    fn a_wall_on_one_dir_benches_its_same_identity_sibling() {
        // THE ROOT FIX (sparkle-xsr6o). effective_exhaustion is strictly per-config-dir, so a login's
        // OTHER dirs read exhausted_until:null while one is walled — the headroom ranker then sees
        // "healthy" accounts that are really one walled quota pool. Two dirs, SAME login: A walled, B
        // not → B must read as walled too.
        let now = 1_700_000_000;
        let mut a = sample("a", false, "/dirs/a");
        a.exhausted_until = Some(now + 3_600);
        a.exhausted_identity = Some("uuid-shared".to_string());
        let b = sample("b", false, "/dirs/b"); // no bench of its own
        let accounts = vec![a, b];
        let ids = vec![
            Some(oauth(Some("uuid-shared"), "shared@x.com")),
            Some(oauth(Some("uuid-shared"), "shared@x.com")),
        ];
        assert_eq!(
            effective_exhaustion_across_identity_with(&accounts, &ids, 1, now),
            Some(now + 3_600),
            "a healthy dir of a walled login must read as walled (contagion)"
        );
        // A itself is still walled.
        assert_eq!(
            effective_exhaustion_across_identity_with(&accounts, &ids, 0, now),
            Some(now + 3_600)
        );

        // PAIRED negative: with NO wall anywhere on the identity, B stays healthy — proving the wall
        // CAUSED the contagion, not a function that always returns Some.
        let mut healthy = accounts.clone();
        healthy[0].exhausted_until = None;
        healthy[0].exhausted_identity = None;
        assert_eq!(
            effective_exhaustion_across_identity_with(&healthy, &ids, 1, now),
            None,
            "no wall on the identity → no false bench"
        );
    }

    #[test]
    fn a_wall_takes_the_latest_sibling_epoch() {
        // The identity stays benched until the LAST of its dirs clears — the fail-safe direction, so
        // work is never routed into a pool a sibling still reports walled.
        let now = 1_700_000_000;
        let mut a = sample("a", false, "/dirs/a");
        a.exhausted_until = Some(now + 1_000);
        a.exhausted_identity = Some("uuid-shared".to_string());
        let mut b = sample("b", false, "/dirs/b");
        b.exhausted_until = Some(now + 9_000); // the later wall
        b.exhausted_identity = Some("uuid-shared".to_string());
        let accounts = vec![a, b];
        let ids = vec![
            Some(oauth(Some("uuid-shared"), "shared@x.com")),
            Some(oauth(Some("uuid-shared"), "shared@x.com")),
        ];
        assert_eq!(
            effective_exhaustion_across_identity_with(&accounts, &ids, 0, now),
            Some(now + 9_000),
            "the identity is benched until its latest sibling wall clears"
        );
    }

    #[test]
    fn a_wall_does_not_bench_a_different_identity() {
        // PAIRED with the contagion test: DIFFERENT logins must not cross-contaminate, or the fix
        // would bench genuinely healthy accounts and make rotation worse, not better.
        let now = 1_700_000_000;
        let mut a = sample("a", false, "/dirs/a");
        a.exhausted_until = Some(now + 3_600);
        a.exhausted_identity = Some("uuid-a".to_string());
        let b = sample("b", false, "/dirs/b");
        let accounts = vec![a, b];
        let ids = vec![
            Some(oauth(Some("uuid-a"), "a@x.com")),
            Some(oauth(Some("uuid-b"), "b@x.com")), // a DIFFERENT login
        ];
        assert_eq!(
            effective_exhaustion_across_identity_with(&accounts, &ids, 1, now),
            None,
            "a wall on a different account must not bench this one"
        );
        // A stays walled on its own.
        assert_eq!(
            effective_exhaustion_across_identity_with(&accounts, &ids, 0, now),
            Some(now + 3_600)
        );
    }

    #[test]
    fn an_unknown_identity_dir_is_never_merged() {
        // "Can't resolve" is not "the same account as another unresolvable dir". Merging two unknowns
        // would invent a sibling relationship on no evidence and bench a genuinely healthy account.
        let now = 1_700_000_000;
        let mut a = sample("a", false, "/dirs/a");
        a.exhausted_until = Some(now + 3_600);
        a.exhausted_identity = None; // legacy/unowned bench — honoured for A itself
        let b = sample("b", false, "/dirs/b");
        let accounts = vec![a, b];
        let ids: Vec<Option<OauthIdentity>> = vec![None, None]; // BOTH unresolvable

        assert_eq!(
            effective_exhaustion_across_identity_with(&accounts, &ids, 1, now),
            None,
            "an unknown-identity dir must not inherit another unknown dir's wall"
        );
        // A still honours its OWN bench (can't-tell owner is not somebody-else).
        assert_eq!(
            effective_exhaustion_across_identity_with(&accounts, &ids, 0, now),
            Some(now + 3_600)
        );

        // And a KNOWN walled login must not leak into an unresolvable sibling dir either.
        let mut accounts2 = accounts.clone();
        accounts2[0].exhausted_identity = Some("uuid-a".to_string());
        let ids_mixed = vec![Some(oauth(Some("uuid-a"), "a@x.com")), None];
        assert_eq!(
            effective_exhaustion_across_identity_with(&accounts2, &ids_mixed, 1, now),
            None,
            "a known login's wall must not bench an unresolvable dir"
        );
    }

    #[test]
    fn usage_for_accounts_applies_identity_level_contagion() {
        // THE WIRING, through the real production entry point. Deleting the contagion post-pass in
        // `usage_for_accounts` leaves the healthy same-login sibling reading as healthy — the whole
        // bug — while every pure-core test above stays green. This is the test that catches that.
        let base = unique_dir("identity-contagion-wiring");
        let dir_a = base.join("a");
        let dir_b = base.join("b");
        // Both dirs resolve to the SAME accountUuid — the real "two dirs, one login" shape.
        write_claude_json(
            &dir_a,
            r#"{"oauthAccount":{"emailAddress":"shared@x.com","accountUuid":"uuid-shared"}}"#,
        );
        write_claude_json(
            &dir_b,
            r#"{"oauthAccount":{"emailAddress":"shared@x.com","accountUuid":"uuid-shared"}}"#,
        );

        let now = now_secs();
        let until = now + 3_600;
        let mut a = sample("a", false, dir_a.to_str().unwrap());
        a.exhausted_until = Some(until);
        a.exhausted_identity = Some("uuid-shared".to_string());
        let b = sample("b", false, dir_b.to_str().unwrap()); // no bench of its own

        let usage = usage_for_accounts(&[a, b], now);
        let wall_for = |id: &str| usage.iter().find(|u| u.id == id).unwrap().exhausted_until;
        assert_eq!(wall_for("a"), Some(until), "the walled dir stays walled");
        assert_eq!(
            wall_for("b"),
            Some(until),
            "its healthy same-login sibling must now read as walled too"
        );

        // PAIRED negative through the SAME entry point: a DIFFERENT login on dir B stays healthy.
        write_claude_json(
            &dir_b,
            r#"{"oauthAccount":{"emailAddress":"other@x.com","accountUuid":"uuid-other"}}"#,
        );
        let mut a2 = sample("a", false, dir_a.to_str().unwrap());
        a2.exhausted_until = Some(until);
        a2.exhausted_identity = Some("uuid-shared".to_string());
        let b2 = sample("b", false, dir_b.to_str().unwrap());
        let usage2 = usage_for_accounts(&[a2, b2], now);
        assert_eq!(
            usage2.iter().find(|u| u.id == "b").unwrap().exhausted_until,
            None,
            "a different login must not be benched by the wall on dir A"
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

    /// Deleting an account that is ALREADY gone is success, not `account not found`.
    ///
    /// This is the second click. The founder removed an account, the row stayed on screen while the
    /// call was in flight, he clicked again, and the second call reported failure for a delete that
    /// had already succeeded. The assertion is on the SECOND call's result and on the store being
    /// untouched by it — not merely on the first, which passed before this change too.
    #[test]
    fn remove_is_idempotent_when_the_account_is_already_gone() {
        let base = std::env::temp_dir().join(format!("sparkle-remove-idem-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&base);
        let path = base.join("accounts.json");
        let keep_dir = base.join("keep");
        let gone_dir = base.join("gone");
        let _ = std::fs::create_dir_all(&keep_dir);
        let _ = std::fs::create_dir_all(&gone_dir);
        write_accounts_at(
            &path,
            &vec![
                sample("keep", false, keep_dir.to_str().unwrap()),
                sample("gone", false, gone_dir.to_str().unwrap()),
            ],
        )
        .unwrap();

        remove_account_at(&path, "gone").unwrap();
        assert_eq!(read_accounts_at(&path).unwrap().len(), 1);

        // THE SECOND CLICK: same id, now absent. Ok, and the surviving account is left alone.
        remove_account_at(&path, "gone").expect("removing an absent account must be Ok");
        let left = read_accounts_at(&path).unwrap();
        assert_eq!(left.len(), 1, "a no-op remove must not disturb the store");
        assert_eq!(left[0].id, "keep");
        assert!(keep_dir.exists(), "a no-op remove must not delete another account's dir");

        // An id that NEVER existed is the same no-op — nothing to find, nothing to report.
        remove_account_at(&path, "never-existed").expect("unknown id must be Ok");
        assert_eq!(read_accounts_at(&path).unwrap().len(), 1);

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

        mark_exhausted_at(&path, "x1", 999, None).unwrap();
        assert_eq!(read_accounts_at(&path).unwrap()[0].exhausted_until, Some(999));

        // Operating on an unknown id is an error, not a silent no-op.
        assert!(set_nickname_at(&path, "missing", "z".into()).is_err());
        assert!(mark_exhausted_at(&path, "missing", 1, None).is_err());

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

    /// An added account's config dir REPLACES `$HOME/.claude`, so it must carry Sparkle's own
    /// control-plane rules or every non-worktree `claude` on that identity prompts a human.
    /// Asserts the rule is READABLE BACK from the account's settings.json (the side effect), not
    /// merely that the directory exists — which was already true before the change.
    #[test]
    fn adding_an_account_seeds_sparkles_control_plane_allowlist() {
        let tmp = unique_dir("seed-allowlist");
        let acct = add_account_at(&tmp, &accounts_json_path(&tmp), "Second".into(), "abc123".into(), 1)
            .unwrap();

        let body = std::fs::read_to_string(Path::new(&acct.config_dir).join("settings.json"))
            .expect("a new account must get a settings.json");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let rules: Vec<&str> = v["permissions"]["allow"]
            .as_array()
            .expect("permissions.allow")
            .iter()
            .filter_map(|r| r.as_str())
            .collect();
        assert!(
            rules.contains(&"mcp__sparkle-control"),
            "added account cannot call Sparkle's control plane: {rules:?}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The heal must ADD to a real settings.json rather than replace it, and must refuse outright
    /// when the file is not parseable — losing a human's config to fix a permission nit is the
    /// worse failure by far.
    #[test]
    fn healing_an_account_preserves_existing_settings_and_refuses_garbage() {
        let tmp = unique_dir("heal-allowlist");

        // Real, parseable config with the user's own keys → merged, everything preserved.
        std::fs::write(tmp.join("settings.json"), r#"{"theme":"dark","permissions":{"allow":["Bash(ls)"]}}"#)
            .unwrap();
        ensure_account_allowlist_at(&tmp).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.join("settings.json")).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark", "unrelated user keys must survive the heal");
        let rules: Vec<&str> =
            v["permissions"]["allow"].as_array().unwrap().iter().filter_map(|r| r.as_str()).collect();
        assert!(rules.contains(&"Bash(ls)"), "user rule dropped: {rules:?}");
        assert!(rules.contains(&"mcp__sparkle-control"), "control plane not added: {rules:?}");

        // Unparseable → refused, and the bytes are left exactly as they were.
        std::fs::write(tmp.join("settings.json"), "{ not json").unwrap();
        assert!(ensure_account_allowlist_at(&tmp).is_err());
        assert_eq!(
            std::fs::read_to_string(tmp.join("settings.json")).unwrap(),
            "{ not json",
            "an unparseable settings.json must be left byte-for-byte intact"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A FRESHLY created account dir must already carry the bypass-consent record, because the very
    /// first thing that happens to it is an unattended `claude --dangerously-skip-permissions`
    /// spawn — and that flag is gated by the same one-time disclaimer as `bypassPermissions`. With
    /// no human at the terminal a missing record is not an extra prompt, it is a hang: two spawned
    /// workers sat alive and idle for fourteen minutes with zero tool calls on exactly this.
    ///
    /// The negative half is the point of the test, not decoration: the account layer seeds the
    /// ACKNOWLEDGEMENT and must never seed the bypass itself, which belongs only to a managed
    /// worktree (where the PreToolUse guard and the deny list are also installed).
    #[test]
    fn a_fresh_account_dir_carries_the_consent_record_but_not_the_bypass() {
        let tmp = unique_dir("consent-seed");
        // No settings.json at all — the state `accounts_add` leaves behind.
        ensure_account_allowlist_at(&tmp).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.join("settings.json")).unwrap()).unwrap();
        assert_eq!(
            v["skipDangerousModePermissionPrompt"], true,
            "a fresh account dir must not make the next agent stop on the bypass disclaimer"
        );
        assert!(
            v["permissions"]["defaultMode"].is_null(),
            "the bypass itself is worktree-scoped and must NOT be written at the account level"
        );
        assert!(
            v["permissions"]["deny"].is_null(),
            "the deny list rides with the bypass, in the worktree — not here"
        );
        // Idempotent: a second heal of the now-current file rewrites nothing.
        let before = std::fs::read_to_string(tmp.join("settings.json")).unwrap();
        ensure_account_allowlist_at(&tmp).unwrap();
        assert_eq!(before, std::fs::read_to_string(tmp.join("settings.json")).unwrap());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A settings.json that EXISTS but cannot be READ must be left alone — not treated as absent.
    ///
    /// This is the blocking knightwatch probe on PR #1302. The heal used
    /// `read_to_string(&file).ok()`, which turns every read failure into `None`, and `None` is the
    /// input that makes the merge synthesise a FRESH settings object — which was then written over
    /// the real file. So a file holding permission DENIES, hooks and preferences was destroyed by a
    /// routine best-effort heal, with no prior copy to recover from.
    ///
    /// Invalid UTF-8 is the cheap, deterministic way to produce that read failure (`read_to_string`
    /// returns `InvalidData`, not `NotFound`). The unparseable-JSON test above does NOT cover this:
    /// that file reads fine and is rejected later by the JSON parse. This one never gets that far.
    ///
    /// ASSERTS THE SIDE EFFECT — the bytes on disk — not merely the returned `Err`. A version that
    /// returned an error and still wrote would satisfy an `is_err()` check and lose the file anyway.
    #[test]
    fn healing_leaves_an_unreadable_settings_file_byte_for_byte_intact() {
        let tmp = unique_dir("heal-unreadable");
        let file = tmp.join("settings.json");
        // Lone continuation bytes: valid on disk, not valid UTF-8.
        let raw: &[u8] = &[0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x22, 0x7d];
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(&file, raw).unwrap();

        assert!(
            ensure_account_allowlist_at(&tmp).is_err(),
            "an unreadable settings.json must be refused, not silently treated as absent"
        );
        assert_eq!(
            std::fs::read(&file).unwrap(),
            raw,
            "the heal overwrote a file it could not read — this is the data-loss path"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ---- onboarding marker ----------------------------------------------------------------
    //
    // The fleet-into-the-wizard bug. A config dir with no `hasCompletedOnboarding: true` makes
    // Claude Code run its first-run wizard, which CONSUMES the brief Sparkle types — the agent
    // reports as running and executes nothing.

    /// A dir with no `.claude.json` at all gets the marker written.
    #[test]
    fn an_absent_claude_json_gets_an_onboarding_marker() {
        let tmp = unique_dir("onboard-absent");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!tmp.join(".claude.json").exists(), "precondition: no marker yet");

        ensure_onboarding_marker_at(&tmp).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(
            v["hasCompletedOnboarding"], true,
            "an agent spawned here would still get the first-run wizard"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// THE CASE A CREATE-IF-MISSING PASS SKIPS, and the reason the first hotfix did not work.
    ///
    /// A `.claude.json` that EXISTS and holds a real login, but carries no `hasCompletedOnboarding`,
    /// still sends Claude Code into the wizard. Measured on the founder's machine: two dirs were
    /// missing the file entirely, but THREE signed-in dirs had the file WITHOUT the key — one of
    /// them a registered account the router was actively selecting. Seeding only the absent ones
    /// left the fleet landing in the picker.
    ///
    /// Asserts BOTH halves, because they are the two ways this can be wrong: the marker must be
    /// added (or the wizard still runs), and `oauthAccount` must survive (or the fix logs the user
    /// out — strictly worse than the bug, and unrecoverable, since the credential is keychain-keyed
    /// by the dir path).
    #[test]
    fn healing_onboarding_preserves_an_existing_login() {
        let tmp = unique_dir("onboard-existing-login");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"someone@example.com"},"theme":"light","numStartups":7}"#,
        )
        .unwrap();

        ensure_onboarding_marker_at(&tmp).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(
            v["hasCompletedOnboarding"], true,
            "a present-but-unmarked file must be HEALED, not skipped — this is the whole bug"
        );
        assert_eq!(
            v["oauthAccount"]["emailAddress"], "someone@example.com",
            "the heal destroyed the login; the credential cannot be recovered"
        );
        assert_eq!(v["theme"], "light", "a user's own theme must not be overwritten by the default");
        assert_eq!(v["numStartups"], 7, "unrelated Claude Code state must survive");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Already complete → not rewritten AT ALL. Asserts the bytes, not just the `Ok`: rewriting a
    /// live `.claude.json` on every `accounts_list` would churn the file Claude Code is reading.
    #[test]
    fn healing_onboarding_does_not_rewrite_a_dir_already_complete() {
        let tmp = unique_dir("onboard-already");
        std::fs::create_dir_all(&tmp).unwrap();
        // Deliberately compact and key-ordered unlike our own writer's output, so a rewrite shows up.
        let original = r#"{"hasCompletedOnboarding":true,"zzz":1}"#;
        std::fs::write(tmp.join(".claude.json"), original).unwrap();

        ensure_onboarding_marker_at(&tmp).unwrap();

        assert_eq!(
            std::fs::read_to_string(tmp.join(".claude.json")).unwrap(),
            original,
            "an already-complete marker must be left byte-for-byte alone"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Unparseable → refused, bytes intact. Same data-loss reasoning as the settings.json twin: this
    /// file holds the login, and there is no prior copy.
    #[test]
    fn healing_onboarding_leaves_an_unparseable_claude_json_intact() {
        let tmp = unique_dir("onboard-garbage");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(".claude.json"), "{ not json").unwrap();

        assert!(ensure_onboarding_marker_at(&tmp).is_err());
        assert_eq!(
            std::fs::read_to_string(tmp.join(".claude.json")).unwrap(),
            "{ not json",
            "an unparseable .claude.json must be left byte-for-byte intact"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A CONCURRENT WRITE MUST NOT BE CLOBBERED — the lost-update case atomicity does not cover.
    ///
    /// `.claude.json` is Claude Code's own file and it rewrites the whole thing, including at the
    /// instant a login completes. A read → modify → rename therefore has a window in which someone
    /// else's write is discarded wholesale, and the one most likely to land in it is the freshly
    /// written `oauthAccount` — the unrecoverable loss this whole function is shaped to avoid.
    ///
    /// The write is driven through the `between_read_and_write` seam so it lands in the ONE window
    /// that matters. Writing the file before the call would not test this at all: the function would
    /// read the newer content and its stamp would match at write time, so the test would pass with
    /// the guard deleted.
    ///
    /// ASSERTS THE SIDE EFFECT — the login on disk — not merely the returned `Err`. An
    /// implementation that returned an error and still wrote would satisfy an `is_err()` check while
    /// destroying the credential.
    #[test]
    fn healing_onboarding_refuses_to_clobber_a_write_that_landed_mid_heal() {
        let tmp = unique_dir("onboard-lost-update");
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join(".claude.json");
        // Pre-existing signed-in dir with no marker — the exact population the heal targets.
        std::fs::write(&file, r#"{"oauthAccount":{"emailAddress":"before@example.com"}}"#).unwrap();

        // A login completing while the heal is in flight. Longer body so the length differs, and a
        // slept mtime so the stamp moves even on a coarse-timestamp filesystem.
        let after = r#"{"oauthAccount":{"emailAddress":"after@example.com","organizationName":"Org"}}"#;
        let f = file.clone();
        let res = ensure_onboarding_marker_with(&tmp, move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::write(&f, after).unwrap();
        });

        assert!(res.is_err(), "the heal must ABORT when the file changed under it");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            v["oauthAccount"]["emailAddress"], "after@example.com",
            "the heal overwrote a login written while it was in flight — unrecoverable"
        );
        assert_eq!(
            v["oauthAccount"]["organizationName"], "Org",
            "the concurrent write must survive WHOLE, not be partially merged"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ---- folder trust (the restart-wedge's first half) ------------------------------------

    /// THE AHEAD-OF-TIME PATHS MUST NOT TOUCH THE USER'S PERSONAL CONFIG UNINVITED.
    ///
    /// `$HOME/.claude.json` is the config the user's own `claude` reads in a terminal, and the trust
    /// key for a worktree is its MAIN REPO ROOT — so sweeping it in would grant trust for sessions
    /// that have nothing to do with Sparkle, on behalf of a user who may not even use the default
    /// account. Asserts the SELECTION, in both directions, because a one-directional test ("it is
    /// included when a default exists") passes for an implementation that always includes it.
    #[test]
    fn home_is_seeded_ahead_of_time_only_when_a_default_account_is_registered() {
        let tmp = unique_dir("trust-home-scope");
        std::fs::create_dir_all(&tmp).unwrap();
        let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/nonexistent".into()));

        // No default account registered → the personal config must be left alone.
        std::fs::write(
            tmp.join("accounts.json"),
            r#"[{"id":"a","nickname":"a","configDir":"/tmp/acct-a","isDefault":false,"createdAt":0}]"#,
        )
        .unwrap();
        let dirs = seedable_config_dirs(&tmp);
        assert!(
            !dirs.contains(&home),
            "with no default account registered, the sweep must not write the user's own \
             ~/.claude.json — that changes their plain `claude` outside Sparkle. Got: {dirs:?}"
        );
        assert!(dirs.contains(&PathBuf::from("/tmp/acct-a")), "the real account must be seeded");

        // A registered default account → $HOME is legitimately that account's config.
        std::fs::write(
            tmp.join("accounts.json"),
            r#"[{"id":"d","nickname":"d","configDir":"","isDefault":true,"createdAt":0}]"#,
        )
        .unwrap();
        let dirs = seedable_config_dirs(&tmp);
        assert!(
            dirs.contains(&home),
            "a REGISTERED default account keeps its config at $HOME, so it must be seeded or every \
             agent on it stops on the dialog. Got: {dirs:?}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// THE BACKSTOP, END TO END: a worktree that was NEVER seeded gets healed by the sweep, into an
    /// account that has never seen it.
    ///
    /// This is the case the per-spawn seed structurally cannot reach — the agent is already sitting
    /// on the dialog by the time a spawn would have seeded anything — and it is the shape of the
    /// reported symptom (a column of red agents needing nothing from the human). Asserts the record
    /// landed in the ACCOUNT's config under the key Claude Code reads, not merely that the sweep
    /// returned a count.
    #[test]
    fn the_sweep_heals_a_worktree_that_was_never_seeded() {
        let tmp = unique_dir("trust-sweep");
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str], cwd: &Path| -> bool {
            std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        // A project repo, and an agent worktree laid out the way Sparkle lays them out:
        // <app_data>/worktrees/<projectId>/<agentId>
        let main = tmp.join("proj");
        std::fs::create_dir_all(&main).unwrap();
        if !git(&["init", "-q", "-b", "main"], &main) {
            eprintln!("skipping: git unavailable");
            let _ = std::fs::remove_dir_all(&tmp);
            return;
        }
        git(&["config", "user.email", "t@t"], &main);
        git(&["config", "user.name", "t"], &main);
        std::fs::write(main.join("f.txt"), "hi").unwrap();
        git(&["add", "-A"], &main);
        assert!(git(&["commit", "-qm", "init"], &main));

        let app_data = tmp.join("appdata");
        let wt = app_data.join("worktrees").join("proj-1").join("agent-1");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        assert!(git(
            &["worktree", "add", "-q", "-b", "feature", wt.to_str().unwrap(), "main"],
            &main
        ));

        // An account whose config has NEVER recorded this project — the untrusted starting state.
        let acct = app_data.join("accounts").join("acct-1");
        std::fs::create_dir_all(&acct).unwrap();
        std::fs::write(
            app_data.join("accounts.json"),
            serde_json::to_string(&serde_json::json!([{
                "id": "acct-1",
                "nickname": "one",
                "configDir": acct.to_string_lossy(),
                "isDefault": false,
                "createdAt": 0,
            }]))
            .unwrap(),
        )
        .unwrap();

        let swept = sweep_folder_trust_at(&app_data).unwrap();
        assert!(swept >= 1, "the sweep must have seeded at least the registered account");

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(acct.join(".claude.json")).unwrap())
                .unwrap();
        let main_key = main.canonicalize().unwrap().to_string_lossy().to_string();
        assert_eq!(
            v["projects"][&main_key]["hasTrustDialogAccepted"],
            true,
            "the sweep must heal an unseeded worktree under the key Claude Code reads ({main_key}); \
             without it an already-spawned agent stays parked on the dialog forever. Wrote: {v:#}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// THE TEST THAT WOULD HAVE CAUGHT `sparkle-ubee5u` ON DAY ONE, and the one that reds if the
    /// prompt can come back.
    ///
    /// Every test above this line seeds a MADE-UP path string (`/wt/acme/agent-7`) and then asserts
    /// that same string came back out of the JSON. That is a tautology about a map — it passed for
    /// the entire life of the bug, because the thing that was wrong was never the writing, it was
    /// WHICH KEY to write. Claude Code resolves a linked worktree's trust under the MAIN REPOSITORY
    /// ROOT, so the worktree-path key the seed wrote was read by nothing and every fresh agent
    /// stopped on the dialog.
    ///
    /// So this test uses a REAL git worktree cut by REAL git, and asserts the seed wrote the key the
    /// CLI will actually index by. Feed it a fabricated fixture and it goes back to proving nothing.
    #[test]
    fn seeding_folder_trust_writes_the_key_claude_code_reads_for_a_real_worktree() {
        let tmp = unique_dir("trust-real-worktree");
        std::fs::create_dir_all(&tmp).unwrap();
        let main = tmp.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let git = |args: &[&str], cwd: &Path| -> bool {
            std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !git(&["init", "-q", "-b", "main"], &main) {
            eprintln!("skipping: git unavailable");
            let _ = std::fs::remove_dir_all(&tmp);
            return;
        }
        git(&["config", "user.email", "t@t"], &main);
        git(&["config", "user.name", "t"], &main);
        std::fs::write(main.join("f.txt"), "hi").unwrap();
        git(&["add", "-A"], &main);
        assert!(git(&["commit", "-qm", "init"], &main));
        let wt = tmp.join("wt");
        assert!(git(
            &["worktree", "add", "-q", "-b", "feature", wt.to_str().unwrap(), "main"],
            &main
        ));

        let cfg = tmp.join("cfg");
        std::fs::create_dir_all(&cfg).unwrap();
        ensure_project_trusted_at(&cfg, wt.to_str().unwrap()).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(cfg.join(".claude.json")).unwrap())
                .unwrap();
        let main_key = main.canonicalize().unwrap().to_string_lossy().to_string();
        assert_eq!(
            v["projects"][&main_key]["hasTrustDialogAccepted"],
            true,
            "the seed must write the MAIN REPO ROOT key ({main_key}) — that is the only key Claude \
             Code indexes for a linked worktree, and writing anything else means every fresh agent \
             stops on the trust dialog (sparkle-ubee5u). Wrote: {v:#}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// THE SIDE EFFECT THAT SKIPS THE DIALOG. Claude Code 2.1.235 shows "Is this a project you
    /// trust?" unless `config.projects[<abs cwd>].hasTrustDialogAccepted === true` is in
    /// `.claude.json` — and `--dangerously-skip-permissions` does NOT waive it. So the record this
    /// writes is exactly what an unattended worker needs to not hang on that dialog. Asserts the
    /// written boolean, not the `Ok`: a version that returned `Ok` and wrote nothing (or wrote the
    /// wrong key/path) would pass an `is_ok()` check and still wedge every respawned worker.
    #[test]
    fn seeding_folder_trust_writes_the_record_that_skips_the_dialog() {
        let tmp = unique_dir("trust-absent");
        std::fs::create_dir_all(&tmp).unwrap();
        let wt = "/wt/acme/agent-7";
        assert!(!tmp.join(".claude.json").exists(), "precondition: no config yet");

        ensure_project_trusted_at(&tmp, wt).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(
            v["projects"][wt]["hasTrustDialogAccepted"], true,
            "a worker spawned in this worktree would still stop on the trust dialog"
        );
    }

    /// The seed must EXTEND `.claude.json`, never replace it: the file holds the account's login and
    /// any other project's trust record, and this write happens right before a spawn on a live file.
    /// Asserts the new record AND that the login, an unrelated project's trust, and a top-level key
    /// all survive — the four ways a careless `projects: {..}` overwrite would lose real state.
    #[test]
    fn seeding_folder_trust_preserves_other_projects_the_login_and_keys() {
        let tmp = unique_dir("trust-preserve");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"me@example.com"},"numStartups":9,
                "projects":{"/wt/other/agent-1":{"hasTrustDialogAccepted":true,"history":[1,2]}}}"#,
        )
        .unwrap();
        let wt = "/wt/acme/agent-7";

        ensure_project_trusted_at(&tmp, wt).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(v["projects"][wt]["hasTrustDialogAccepted"], true, "our record must be written");
        assert_eq!(
            v["projects"]["/wt/other/agent-1"]["hasTrustDialogAccepted"], true,
            "another worktree's trust must survive"
        );
        assert_eq!(
            v["projects"]["/wt/other/agent-1"]["history"],
            serde_json::json!([1, 2]),
            "the other project's own keys must survive whole"
        );
        assert_eq!(
            v["oauthAccount"]["emailAddress"], "me@example.com",
            "the seed destroyed the login — unrecoverable"
        );
        assert_eq!(v["numStartups"], 9, "unrelated top-level Claude Code state must survive");
    }

    /// Already trusted → not rewritten AT ALL (byte-for-byte), so a spawn does not churn the live
    /// `.claude.json` Claude Code is reading every time an already-trusted worktree reopens.
    #[test]
    fn seeding_folder_trust_does_not_rewrite_an_already_trusted_worktree() {
        let tmp = unique_dir("trust-already");
        std::fs::create_dir_all(&tmp).unwrap();
        let wt = "/wt/acme/agent-7";
        // Compact, key-ordered unlike our writer's output, so any rewrite is visible.
        let original =
            r#"{"projects":{"/wt/acme/agent-7":{"hasTrustDialogAccepted":true}},"zzz":1}"#;
        std::fs::write(tmp.join(".claude.json"), original).unwrap();

        ensure_project_trusted_at(&tmp, wt).unwrap();

        assert_eq!(
            std::fs::read_to_string(tmp.join(".claude.json")).unwrap(),
            original,
            "an already-trusted worktree must leave the file byte-for-byte alone"
        );
    }

    /// Unparseable → refused, bytes intact. Same data-loss reasoning as the onboarding twin: this
    /// file holds the login and there is no prior copy, so a spawn-time seed must never clobber it.
    #[test]
    fn seeding_folder_trust_leaves_an_unparseable_claude_json_intact() {
        let tmp = unique_dir("trust-garbage");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(".claude.json"), "{ not json").unwrap();

        assert!(ensure_project_trusted_at(&tmp, "/wt/acme/agent-7").is_err());
        assert_eq!(
            std::fs::read_to_string(tmp.join(".claude.json")).unwrap(),
            "{ not json",
            "an unparseable .claude.json must be left byte-for-byte intact"
        );
    }

    /// A login completing DURING the seed must survive whole — the lost-update window atomicity does
    /// not cover, driven through the `between_read_and_write` seam so the concurrent write lands in
    /// the one window that matters. Asserts the SIDE EFFECT (the login on disk), not just `Err`: an
    /// implementation that errored and still wrote would satisfy `is_err()` while destroying the
    /// credential. Writing the file before the call would pass with the CAS deleted (the function
    /// would read the newer content and its stamp would match), which is the vacuous shape to avoid.
    #[test]
    fn seeding_folder_trust_refuses_to_clobber_a_write_that_landed_mid_seed() {
        let tmp = unique_dir("trust-lost-update");
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join(".claude.json");
        std::fs::write(&file, r#"{"oauthAccount":{"emailAddress":"before@example.com"}}"#).unwrap();

        let after = r#"{"oauthAccount":{"emailAddress":"after@example.com","organizationName":"Org"}}"#;
        let f = file.clone();
        let res = ensure_project_trusted_with(&tmp, "/wt/acme/agent-7", move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::write(&f, after).unwrap();
        });

        assert!(res.is_err(), "the seed must ABORT when the file changed under it");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            v["oauthAccount"]["emailAddress"], "after@example.com",
            "the seed overwrote a login written while it was in flight — unrecoverable"
        );
        assert_eq!(
            v["oauthAccount"]["organizationName"], "Org",
            "the concurrent write must survive WHOLE, not be partially merged"
        );
    }

    // ---- orphan adoption ------------------------------------------------------------------
    //
    // A credentialed dir with no `accounts.json` record is invisible to every surface, and
    // re-adding "the same" account mints a fresh empty dir rather than reusing it. 6 of 12 dirs on
    // the founder's machine were orphans; 4 held valid logins he was actively trying to use.

    /// Writes one orphan dir holding a completed login, and one holding none.
    fn seed_orphans(root: &Path) {
        let signed_in = root.join("accounts").join("aaa111");
        std::fs::create_dir_all(&signed_in).unwrap();
        std::fs::write(
            signed_in.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"recovered@example.com","organizationName":"Org"}}"#,
        )
        .unwrap();

        // Claude Code's own footprint for a dir it was launched into but never signed into.
        let never = root.join("accounts").join("bbb222");
        std::fs::create_dir_all(never.join("projects")).unwrap();
    }

    #[test]
    fn adoption_registers_a_credentialed_dir_that_has_no_record() {
        let tmp = unique_dir("adopt-basic");
        std::fs::create_dir_all(&tmp).unwrap();
        seed_orphans(&tmp);
        let accounts_path = tmp.join("accounts.json");

        let adopted = adopt_orphan_dirs_at(&tmp, &accounts_path, 1_700_000_000).unwrap();

        assert_eq!(adopted.len(), 1, "expected exactly the signed-in orphan: {adopted:?}");
        assert_eq!(adopted[0].id, "aaa111");
        assert_eq!(adopted[0].nickname, "recovered@example.com");
        // ASSERTS THE SIDE EFFECT — the record is on disk, not merely in the return value.
        let on_disk = read_accounts_at(&accounts_path).unwrap();
        assert!(on_disk.iter().any(|a| a.id == "aaa111"), "not persisted: {on_disk:?}");
        // The dir↔id invariant `account_config_dir` relies on.
        assert_eq!(
            PathBuf::from(&adopted[0].config_dir),
            account_config_dir(&tmp, "aaa111")
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// NEVER adopt a dir with no completed login — this keeps `sparkle-gms0` closed.
    ///
    /// An un-logged-in dir has no transcripts, so its usage tally is zero: the most headroom in the
    /// pool. Adopting one would hand the auto-picker an account that wins EVERY spawn and drops each
    /// agent at a login prompt — the exact fleet-wide failure the signed-in filter exists to stop,
    /// re-opened from a new direction. Two such dirs existed on the founder's machine, so this is
    /// the common case rather than a corner.
    #[test]
    fn adoption_skips_a_dir_that_was_never_signed_into() {
        let tmp = unique_dir("adopt-skips-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        seed_orphans(&tmp);
        let accounts_path = tmp.join("accounts.json");

        adopt_orphan_dirs_at(&tmp, &accounts_path, 1_700_000_000).unwrap();

        let on_disk = read_accounts_at(&accounts_path).unwrap();
        assert!(
            !on_disk.iter().any(|a| a.id == "bbb222"),
            "adopted a dir with no login — it would win every auto-pick and prompt each agent: {on_disk:?}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// THE FOUNDER'S #1 ASK, PINNED: an account whose OAuth login EXPIRED — Claude Code has since
    /// deleted `oauthAccount` from its `.claude.json` — is RETAINED, not dropped. Before this it
    /// looked identical to a never-used dir and vanished, leaving the founder with an empty accounts
    /// modal while the credentialed dir sat on disk. Paired with a bare-footprint dir in the SAME
    /// sweep, so the test proves the DISTINCTION (retain the used one, skip the empty one) rather
    /// than "adopt everything". Deleting the `SignedOutButUsed` retain branch fails the retain
    /// assertion — the mutation guard the retain-on-expiry requirement rides on.
    #[test]
    fn adoption_retains_an_expired_login_that_lost_its_oauth_account() {
        let tmp = unique_dir("adopt-expired");
        std::fs::create_dir_all(&tmp).unwrap();

        // Was signed in but the `oauthAccount` block is gone — the shape an expired login leaves on
        // disk. `history.jsonl` (real interactive use) is what carries the RETAIN here; the `userID`
        // and `hasCompletedOnboarding` in `.claude.json` are deliberately INERT (Sparkle forges both),
        // so removing the history line — not the json — is what would drop this dir.
        let expired = tmp.join("accounts").join("ccc333");
        std::fs::create_dir_all(&expired).unwrap();
        std::fs::write(
            expired.join(".claude.json"),
            r#"{"userID":"u-123","hasCompletedOnboarding":true}"#,
        )
        .unwrap();
        std::fs::write(expired.join("history.jsonl"), "{\"display\":\"hi\"}\n").unwrap();

        // Never logged in — bare footprint. Must STILL be skipped (sparkle-gms0), so the retain
        // above cannot be "adopt any dir".
        let empty = tmp.join("accounts").join("ddd444");
        std::fs::create_dir_all(empty.join("projects")).unwrap();

        let accounts_path = tmp.join("accounts.json");
        let adopted = adopt_orphan_dirs_at(&tmp, &accounts_path, 1_700_000_000).unwrap();

        // Retained, under the generic reconnect label (no email is readable from an expired dir).
        let retained = adopted.iter().find(|a| a.id == "ccc333");
        assert!(retained.is_some(), "expired login was dropped, not retained: {adopted:?}");
        assert_eq!(retained.unwrap().nickname, EXPIRED_LOGIN_NICKNAME);
        // SIDE EFFECT on disk — the row a "Renew Login" control attaches to must actually persist.
        let on_disk = read_accounts_at(&accounts_path).unwrap();
        assert!(on_disk.iter().any(|a| a.id == "ccc333"), "not persisted: {on_disk:?}");
        // The distinction holds: the bare dir is still skipped.
        assert!(
            !adopted.iter().any(|a| a.id == "ddd444"),
            "adopted a never-logged dir — it would win every auto-pick: {adopted:?}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// THE FOUNDER'S #1/#2 ASK, PINNED THROUGH THE REAL ADD FLOW: an account created by
    /// [`add_account_at`] whose sign-in never completed must NOT be resurrected by adoption once its
    /// row is gone but its dir survives (a removal whose `remove_dir_all` failed, or an app quit
    /// before the frontend's undo ran). Seeds the dir with the PRODUCTION seeding — `add_account_at`
    /// itself, which writes the onboarding marker and lets `claude` startup add a `userID` — so the
    /// test cannot drift from what the add flow actually leaves on disk. Then drops the row and runs
    /// adoption: the dir must be skipped, not re-minted into a phantom "Login expired — reconnect".
    ///
    /// SIDE EFFECT asserted: no row for the orphan id in `accounts.json` after the sweep. Deleting
    /// the `NeverLoggedIn` skip (adopting the dir) reddens this — the guard the don't-resurrect
    /// requirement rides on. The paired retain test above proves the sweep still ADOPTS a genuinely
    /// used dir, so this is not "adopt nothing".
    #[test]
    fn a_never_completed_signin_is_not_resurrected_by_adoption() {
        let tmp = unique_dir("no-resurrect");
        let app_data = tmp.clone();
        let accounts_path = accounts_json_path(&tmp);

        // Real add flow: creates <app_data>/accounts/<id>/ and seeds the onboarding marker, exactly
        // as "Add account" does before `claude auth login` runs.
        let created = add_account_at(&app_data, &accounts_path, "Foo".into(), "orphanid".into(), 1)
            .unwrap();
        // Simulate `claude auth login` STARTING (writes a startup `userID`) but never completing:
        // no `oauthAccount`, no `history.jsonl`, empty real work. This is the founder's "Signing in…"
        // shape, hardened with every forgeable signal a real cancelled add can leave behind.
        let dir = PathBuf::from(&created.config_dir);
        ensure_onboarding_marker_at(&dir).unwrap(); // idempotent; mirrors the marker already seeded
        let cj = dir.join(".claude.json");
        let mut obj: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(&cj).unwrap()).unwrap();
        obj.insert("userID".into(), serde_json::json!("7ec77cf4d0743bc6"));
        // …a trust-seeded projects entry, as `ensure_project_trusted_at` writes at spawn prep — a
        // never-signed-in account CAN be chosen for a spawn (a pin, or the no-account-signed-in
        // fallback), and that must not later convert the dir to a retained login.
        obj.insert(
            "projects".into(),
            serde_json::json!({"/some/worktree": {"hasTrustDialogAccepted": true}}),
        );
        std::fs::write(&cj, serde_json::to_string(&obj).unwrap()).unwrap();
        // …and a rejected pasted token: `account_set_oauth_token` writes `.credentials.json` BEFORE
        // the CLI verifies it, and a rejected paste leaves this well-formed blob on disk. It must
        // NOT count as a completed login.
        std::fs::write(
            dir.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-BOGUS","refreshToken":null,"expiresAt":0}}"#,
        )
        .unwrap();
        // Sanity on the seeded shape: onboarding + userID + trust entry + a rejected credential
        // present, but no completed-login evidence (no oauthAccount, no history.jsonl, no real work).
        assert_eq!(obj.get("hasCompletedOnboarding"), Some(&serde_json::Value::Bool(true)));
        assert!(obj.get("oauthAccount").is_none());
        assert!(!dir.join("history.jsonl").exists());

        // The row is gone (removed) but the dir survives — the state a failed `remove_dir_all` or an
        // app quit before the frontend undo leaves behind.
        write_accounts_at(&accounts_path, &[]).unwrap();

        let adopted = adopt_orphan_dirs_at(&app_data, &accounts_path, 2).unwrap();

        assert!(
            !adopted.iter().any(|a| a.id == "orphanid"),
            "a never-completed sign-in was resurrected by adoption: {adopted:?}"
        );
        // SIDE EFFECT: nothing was written back for it.
        let on_disk = read_accounts_at(&accounts_path).unwrap();
        assert!(
            !on_disk.iter().any(|a| a.id == "orphanid"),
            "phantom row persisted to accounts.json: {on_disk:?}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// `read_login_evidence` tells the three cases apart — the classifier the retain/skip decision
    /// rides on. Flipping an input (drop the `oauthAccount`, or strip the use-evidence) moves the
    /// verdict, which is what keeps the adoption test above non-vacuous.
    #[test]
    fn login_evidence_distinguishes_signed_in_expired_and_empty() {
        let tmp = unique_dir("login-evidence");

        let signed_in = tmp.join("s");
        std::fs::create_dir_all(&signed_in).unwrap();
        std::fs::write(
            signed_in.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"live@example.com"}}"#,
        )
        .unwrap();
        assert!(matches!(read_login_evidence(&signed_in), LoginEvidence::SignedIn(_)));

        // A `projects` entry Claude Code populated with REAL work (a key beyond the trust seed)
        // proves the account ran — covers a headless login whose `oauthAccount` was later cleared.
        let expired = tmp.join("e");
        std::fs::create_dir_all(&expired).unwrap();
        std::fs::write(
            expired.join(".claude.json"),
            r#"{"machineID":"m","projects":{"/repo":{"hasTrustDialogAccepted":true,"lastCost":0.42}}}"#,
        )
        .unwrap();
        assert!(matches!(read_login_evidence(&expired), LoginEvidence::SignedOutButUsed));

        // A `.credentials.json` — even one holding a WELL-FORMED token — is NOT proof (High finding).
        // The token-paste flow writes exactly this shape BEFORE the CLI verifies it, and a rejected
        // paste leaves it on disk (`AccountTokenForm` only shows an error). The credential is excluded
        // from the classifier entirely, so a never-signed-in dir carrying a rejected token must still
        // be NeverLoggedIn.
        let bad_cred = tmp.join("bad-cred");
        std::fs::create_dir_all(&bad_cred).unwrap();
        std::fs::write(bad_cred.join(".claude.json"), r#"{"machineID":"m"}"#).unwrap();
        std::fs::write(
            bad_cred.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-BOGUS","refreshToken":null,"expiresAt":0}}"#,
        )
        .unwrap();
        assert!(
            matches!(read_login_evidence(&bad_cred), LoginEvidence::NeverLoggedIn),
            "an unverified pasted token in .credentials.json (the real rejected-paste shape) must \
             not count as a completed login"
        );

        // history.jsonl alone also proves it, even with a bare `.claude.json`.
        let expired2 = tmp.join("e2");
        std::fs::create_dir_all(&expired2).unwrap();
        std::fs::write(expired2.join(".claude.json"), r#"{"machineID":"m"}"#).unwrap();
        std::fs::write(expired2.join("history.jsonl"), "{}\n").unwrap();
        assert!(matches!(read_login_evidence(&expired2), LoginEvidence::SignedOutButUsed));

        // A TRUST-SEEDED `projects` entry is NOT proof (Medium finding): `ensure_project_trusted_at`
        // writes `projects[<worktree>].hasTrustDialogAccepted` at spawn prep, before any login. A
        // never-signed-in dir spawned on once carries this shape and must still be NeverLoggedIn.
        let trust_only = tmp.join("trust-only");
        std::fs::create_dir_all(&trust_only).unwrap();
        std::fs::write(
            trust_only.join(".claude.json"),
            r#"{"userID":"u-1","hasCompletedOnboarding":true,"projects":{"/some/worktree":{"hasTrustDialogAccepted":true}}}"#,
        )
        .unwrap();
        assert!(
            matches!(read_login_evidence(&trust_only), LoginEvidence::NeverLoggedIn),
            "a trust-seeded projects entry (Sparkle's own spawn footprint) must not count as a login"
        );

        // Bare footprint, no login evidence → never adopted.
        let empty = tmp.join("n");
        std::fs::create_dir_all(empty.join("projects")).unwrap();
        std::fs::write(empty.join(".claude.json"), r#"{"machineID":"m"}"#).unwrap();
        assert!(matches!(read_login_evidence(&empty), LoginEvidence::NeverLoggedIn));

        // ══ THE FOUNDER'S "Signing in…" SHAPE — A SIGN-IN THAT NEVER COMPLETED ═══════════════════
        // Verbatim from the founder's machine (dirs 17f9e44…, c93e7cb…): Sparkle seeded
        // `hasCompletedOnboarding` at add time, Claude Code wrote a `userID` on startup, and the
        // `claude auth login` was cancelled — so there is NO `oauthAccount`, NO `history.jsonl`, and
        // an EMPTY `projects` map. The old classifier read `userID`/`hasCompletedOnboarding` as proof
        // of a past login and adopted this as a phantom "Login expired — reconnect" account (and
        // resurrected removed ones on restart). It must classify as NeverLoggedIn.
        let never = tmp.join("signing-in");
        std::fs::create_dir_all(&never).unwrap();
        std::fs::write(
            never.join(".claude.json"),
            r#"{"userID":"7ec77cf4","hasCompletedOnboarding":true,"machineID":"m","projects":{}}"#,
        )
        .unwrap();
        assert!(
            matches!(read_login_evidence(&never), LoginEvidence::NeverLoggedIn),
            "a never-completed sign-in (Sparkle onboarding + startup userID, no oauth/history/projects) \
             must not count as a past login"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A token-authenticated account becomes ROUTABLE: recording its email fills
    /// `oauthAccount.emailAddress`, which is exactly what `read_oauth_identity_at` (the signal behind
    /// `isSignedIn`/`pickAccount`) reads back. Before this a valid pasted token had `email: null` and
    /// could never receive a spawn. Deleting the `emailAddress` insert makes the readback None and
    /// reddens this — the mutation guard for "the pasted token can actually be used".
    #[test]
    fn recording_an_email_makes_a_token_account_routable() {
        let tmp = unique_dir("record-email");
        let dir = tmp.join("acct");
        std::fs::create_dir_all(&dir).unwrap();
        // A token-only dir: some footprint but NO oauthAccount, so it is not identifiable yet.
        std::fs::write(dir.join(".claude.json"), r#"{"userID":"u-1"}"#).unwrap();
        assert!(
            read_oauth_identity_at(Some(&dir), None).is_none(),
            "precondition: no identity before recording"
        );

        record_oauth_email_at(&dir.join(".claude.json"), "me@example.com").unwrap();

        // SIDE EFFECT: the identity the router keys on now resolves.
        let id = read_oauth_identity_at(Some(&dir), None).expect("must be identifiable now");
        assert_eq!(id.email, "me@example.com");
        // Conservative merge: the pre-existing key survived (not a clobber of the whole file).
        let back: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(back.get("userID").and_then(serde_json::Value::as_str), Some("u-1"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Never overwrites a REAL login's identity — idempotent and conservative, so a renew that lands
    /// on an already-signed-in dir can't downgrade its richer identity to a bare email.
    #[test]
    fn recording_an_email_never_overwrites_an_existing_identity() {
        let tmp = unique_dir("record-email-noclobber");
        let dir = tmp.join("acct");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"real@example.com","accountUuid":"uuid-x"}}"#,
        )
        .unwrap();

        record_oauth_email_at(&dir.join(".claude.json"), "bridge@example.com").unwrap();

        let id = read_oauth_identity_at(Some(&dir), None).unwrap();
        assert_eq!(id.email, "real@example.com", "must not overwrite the real login email");
        assert_eq!(id.account_uuid.as_deref(), Some("uuid-x"), "must preserve the uuid");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Idempotent: a second pass adopts nothing and does not duplicate the first pass's record.
    #[test]
    fn adoption_is_idempotent() {
        let tmp = unique_dir("adopt-idempotent");
        std::fs::create_dir_all(&tmp).unwrap();
        seed_orphans(&tmp);
        let accounts_path = tmp.join("accounts.json");

        assert_eq!(adopt_orphan_dirs_at(&tmp, &accounts_path, 1).unwrap().len(), 1);
        let second = adopt_orphan_dirs_at(&tmp, &accounts_path, 2).unwrap();

        assert!(second.is_empty(), "second pass re-adopted: {second:?}");
        let on_disk = read_accounts_at(&accounts_path).unwrap();
        assert_eq!(
            on_disk.iter().filter(|a| a.id == "aaa111").count(),
            1,
            "duplicate record for one dir: {on_disk:?}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A dir an existing record ALREADY points at is not adopted a second time — matched on the
    /// config_dir path, since that is the field a spawn actually exports.
    #[test]
    fn adoption_leaves_an_already_registered_dir_alone() {
        let tmp = unique_dir("adopt-claimed");
        std::fs::create_dir_all(&tmp).unwrap();
        seed_orphans(&tmp);
        let accounts_path = tmp.join("accounts.json");
        // Register the dir under a DIFFERENT id, so only path-matching can catch it.
        write_accounts_at(
            &accounts_path,
            &[Account {
                id: "some-other-id".to_string(),
                nickname: "Mine".to_string(),
                config_dir: account_config_dir(&tmp, "aaa111").to_string_lossy().into_owned(),
                is_default: false,
                created_at: 1,
                exhausted_until: None,
                exhausted_identity: None,
            }],
        )
        .unwrap();

        let adopted = adopt_orphan_dirs_at(&tmp, &accounts_path, 2).unwrap();

        assert!(adopted.is_empty(), "re-adopted a claimed dir: {adopted:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The PRODUCTION call site, not just the helper: adding an account must leave a dir an agent
    /// can actually be spawned into. Without this, the seam is defaulted-and-untested by
    /// construction — delete the call in `add_account_at` and every unit test above still passes.
    #[test]
    fn adding_an_account_seeds_the_onboarding_marker() {
        let tmp = unique_dir("onboard-add-account");
        std::fs::create_dir_all(&tmp).unwrap();
        let accounts_path = tmp.join("accounts.json");

        let acct =
            add_account_at(&tmp, &accounts_path, "Test".to_string(), "abc123".to_string(), 1_700_000_000)
                .unwrap();

        let marker = Path::new(&acct.config_dir).join(".claude.json");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(
            v["hasCompletedOnboarding"], true,
            "a freshly added account still spawns agents into the first-run wizard"
        );
        let _ = std::fs::remove_dir_all(&tmp);
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

    // ---- the directory-listing cache ------------------------------------------------
    //
    // These assert the SIDE EFFECT — how many directories the walk actually `read_dir`ed — and not
    // the records it returned. That distinction is the whole point: the records are byte-identical
    // with the cache working, missing, or subtly wrong, so an assertion on them would have passed
    // against the pinned-worker version this cache replaces and proved nothing at all.

    /// mtime on a DIRECTORY. `set_mtime` opens `write(true)`, which is `EISDIR` on a directory, so
    /// the read-only open is not a stylistic difference — it is the only one that works.
    fn set_dir_mtime(path: &Path, epoch_secs: u64) {
        let t = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(epoch_secs);
        let f = std::fs::File::open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }

    /// Age every directory in `dirs` well past [`DIR_CACHE_SETTLE`], so the listing cache is allowed
    /// to memoize it. Slept-for time would be the alternative and is both slower and flakier.
    fn settle(dirs: &[PathBuf]) {
        let old = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 3600;
        for d in dirs {
            set_dir_mtime(d, old);
        }
    }

    fn walked_names(files: &[(PathBuf, Option<std::fs::Metadata>, SystemTime)]) -> Vec<String> {
        let mut v: Vec<String> = files
            .iter()
            .map(|(p, _, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    /// THE REGRESSION. Every caller of this walk — `accounts_usage` on the agent-spawn path,
    /// `accounts_spend`, `accounts_ceilings` — re-`read_dir`ed the entire transcript tree on every
    /// single call. Measured on the founder's machine: 20,515 directories, 56,060 dirents, 2.4-4.0s
    /// a pass, against a caller that re-asks every 5s — so a tokio blocking worker sat at 100%
    /// continuously, which is precisely what a `sample` of v0.103.0 caught (4354/4354 samples inside
    /// `collect_usage_files`, bottoming out in `__getdirentries64`).
    ///
    /// The assertion is the syscall count, not the records: an unchanged tree must be walked with
    /// ZERO directory reads. Before the listing cache that number was 4 both times while the records
    /// were identical, so nothing about the returned data could have caught this.
    #[test]
    fn a_second_walk_of_an_unchanged_tree_reads_no_directories() {
        let base = unique_dir("dir-cache-unchanged");
        // The real shape: projects/<slug>/<session>/tool-results — `tool-results` is the one that
        // dominates on a live machine (8,267 of them, holding no `.jsonl` at all).
        let root = base.join("projects");
        let slug = root.join("p");
        let session = slug.join("s");
        let tool_results = session.join("tool-results");
        std::fs::create_dir_all(&tool_results).unwrap();
        std::fs::write(slug.join("a.jsonl"), "").unwrap();
        std::fs::write(session.join("b.jsonl"), "").unwrap();
        std::fs::write(tool_results.join("blob.txt"), "not a transcript").unwrap();
        settle(&[root.clone(), slug.clone(), session.clone(), tool_results.clone()]);

        let mut first = Vec::new();
        let cold = collect_usage_files(&root, 0, &mut first);
        assert_eq!(cold, 4, "cold: root + slug + session + tool-results are all listed");
        assert_eq!(walked_names(&first), vec!["a.jsonl", "b.jsonl"]);

        let mut second = Vec::new();
        let warm = collect_usage_files(&root, 0, &mut second);
        assert_eq!(warm, 0, "nothing changed, so nothing is re-listed — this is the fix");
        assert_eq!(
            walked_names(&second),
            walked_names(&first),
            "and the walk still finds exactly the same transcripts"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The PAIRED half of the test above, and the one that makes it mean something. "The second walk
    /// read no directories" is also what a walk that had quietly stopped looking would report, so on
    /// its own it is ambiguous. This pins the cause: the same setup, one new transcript, and the walk
    /// finds it — because creating a file bumps its directory's mtime, which is the cache's key.
    #[test]
    fn a_new_transcript_invalidates_only_its_own_directory() {
        let base = unique_dir("dir-cache-new-file");
        let root = base.join("projects");
        let slug = root.join("p");
        let session = slug.join("s");
        std::fs::create_dir_all(&session).unwrap();
        std::fs::write(slug.join("a.jsonl"), "").unwrap();
        settle(&[root.clone(), slug.clone(), session.clone()]);

        let mut first = Vec::new();
        assert_eq!(collect_usage_files(&root, 0, &mut first), 3);
        assert_eq!(walked_names(&first), vec!["a.jsonl"]);

        std::fs::write(session.join("new.jsonl"), "").unwrap();

        let mut second = Vec::new();
        let reads = collect_usage_files(&root, 0, &mut second);
        assert_eq!(
            walked_names(&second),
            vec!["a.jsonl", "new.jsonl"],
            "a transcript written into a CACHED directory is still found"
        );
        assert_eq!(
            reads, 1,
            "and only the directory that changed is re-listed — root and slug stay cached"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Removal is the other direction, and it is not symmetric with creation for free: a cache keyed
    /// on anything but the directory itself would keep serving a transcript that no longer exists,
    /// and every later pass would stat a missing path.
    #[test]
    fn a_deleted_transcript_leaves_the_cached_listing() {
        let base = unique_dir("dir-cache-delete");
        let root = base.join("projects");
        let slug = root.join("p");
        std::fs::create_dir_all(&slug).unwrap();
        std::fs::write(slug.join("a.jsonl"), "").unwrap();
        std::fs::write(slug.join("gone.jsonl"), "").unwrap();
        settle(&[root.clone(), slug.clone()]);

        let mut first = Vec::new();
        collect_usage_files(&root, 0, &mut first);
        assert_eq!(walked_names(&first), vec!["a.jsonl", "gone.jsonl"]);

        std::fs::remove_file(slug.join("gone.jsonl")).unwrap();

        let mut second = Vec::new();
        collect_usage_files(&root, 0, &mut second);
        assert_eq!(walked_names(&second), vec!["a.jsonl"]);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// [`DIR_CACHE_SETTLE`] is not decoration. A directory written to within the window is refused
    /// the cache entirely, which is what closes the stat-then-`read_dir` race on a filesystem whose
    /// timestamps are coarser than that gap. Delete the settle check and this test goes red while
    /// every other one here stays green — the live session dirs are exactly the ones at risk.
    #[test]
    fn a_directory_written_to_right_now_is_never_cached() {
        let base = unique_dir("dir-cache-unsettled");
        let root = base.join("projects");
        let slug = root.join("p");
        std::fs::create_dir_all(&slug).unwrap();
        std::fs::write(slug.join("a.jsonl"), "").unwrap();
        // Deliberately NOT settled: both directories carry a mtime of a moment ago.

        let mut first = Vec::new();
        assert_eq!(collect_usage_files(&root, 0, &mut first), 2);
        let mut second = Vec::new();
        assert_eq!(
            collect_usage_files(&root, 0, &mut second),
            2,
            "a just-touched directory is re-listed every pass rather than memoized on a mtime that \
             may not yet be able to distinguish a concurrent write"
        );
        assert_eq!(walked_names(&second), vec!["a.jsonl"]);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// THREE commands walk this one tree on three different cadences — `accounts_usage`,
    /// `accounts_limit_events`, `accounts_ceilings` — and each had its own copy of the recursion.
    /// Wiring only the walker the profile happened to name would have left the other two re-listing
    /// the same 20,515 directories, so the worker stays hot and the sample just moves to a different
    /// frame. They share ONE cache: a tree the usage walk just listed leaves the other two nothing
    /// to list.
    ///
    /// Both halves are asserted, and the second is what stops the first from being vacuous: zero
    /// directory reads is also what a walker that had quietly stopped looking would report, so the
    /// limit event must still be FOUND off the cached listing.
    #[test]
    fn all_three_walkers_share_one_listing_cache() {
        let base = unique_dir("dir-cache-shared");
        let root = base.join("projects");
        let slug = root.join("p");
        std::fs::create_dir_all(&slug).unwrap();
        std::fs::write(
            slug.join("a.jsonl"),
            format!("{}\n", limit_line("2026-07-26T15:00:00.000Z", "you've hit your limit")),
        )
        .unwrap();
        settle(&[root.clone(), slug.clone()]);

        let mut files = Vec::new();
        assert_eq!(
            collect_usage_files(&root, 0, &mut files),
            2,
            "the usage walk lists root + slug cold"
        );

        let mut best = None;
        assert_eq!(
            latest_limit_event(&root, 0, &mut best),
            0,
            "`accounts_limit_events` re-lists nothing — it reads the usage walk's listing"
        );
        assert!(best.is_some(), "and it still finds the limit event off that listing");

        let mut times = Vec::new();
        assert_eq!(
            collect_limit_event_times(&root, 0, &mut times),
            0,
            "nor does the ceiling learner"
        );
        assert_eq!(times.len(), 1, "which still sees the event too");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The cache must not change the ANSWER, only the syscalls — including the property the walk's
    /// own doc leans on: a symlinked directory is never descended into (the cycle guard), while a
    /// symlinked `.jsonl` is still counted. Splitting the listing out of the recursion is exactly the
    /// kind of refactor that relaxes that quietly.
    #[test]
    fn the_listing_cache_preserves_the_symlink_rules() {
        let base = unique_dir("dir-cache-symlink");
        let root = base.join("projects");
        let real = base.join("outside");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(real.join("hidden.jsonl"), "").unwrap();
        std::fs::write(real.join("target.jsonl"), "").unwrap();
        // A symlinked DIR under the root: never descended, so `hidden.jsonl` is not counted.
        std::os::unix::fs::symlink(&real, root.join("linkdir")).unwrap();
        // A symlinked FILE: real usage, still counted.
        std::os::unix::fs::symlink(real.join("target.jsonl"), root.join("link.jsonl")).unwrap();
        settle(&[root.clone()]);

        for pass in 0..2 {
            let mut out = Vec::new();
            collect_usage_files(&root, 0, &mut out);
            assert_eq!(
                walked_names(&out),
                vec!["link.jsonl"],
                "pass {pass}: symlinked dir not descended, symlinked transcript counted"
            );
        }

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

    // ---- OAuth-expiry ("auth-dead") detection ----------------------------------

    /// An API-error transcript turn as Claude Code writes it when auth fails: `isApiErrorMessage`
    /// true, with the error text in the single content block.
    fn auth_line(ts: &str, text: &str) -> String {
        format!(
            r#"{{"type":"assistant","isApiErrorMessage":true,"timestamp":"{ts}","message":{{"model":"<synthetic>","role":"assistant","content":[{{"type":"text","text":"{text}"}}]}}}}"#
        )
    }

    /// An ordinary (successful) assistant turn — the "recovery" signal.
    fn ok_line(ts: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"text","text":"reviewing the diff"}}],"usage":{{"input_tokens":5}}}}}}"#
        )
    }

    #[test]
    fn record_is_auth_expiry_matches_all_error_carriers_and_no_prose() {
        // content-text carrier (isApiErrorMessage true).
        let v: serde_json::Value = serde_json::from_str(&auth_line(
            "2026-07-26T15:00:00.000Z",
            "OAuth session expired \\u00b7 please run /login",
        ))
        .unwrap();
        assert!(record_is_auth_expiry(&v));
        // top-level `error` string carrier.
        let v: serde_json::Value = serde_json::from_str(
            r#"{"type":"result","error":"OAuth token has expired and could not be refreshed","timestamp":"2026-07-26T15:00:00.000Z"}"#,
        )
        .unwrap();
        assert!(record_is_auth_expiry(&v), "top-level error branch missed");
        // `result` string carrier (with the isApiErrorMessage gate set).
        let v: serde_json::Value = serde_json::from_str(
            r#"{"type":"result","isApiErrorMessage":true,"result":"Please run `claude login`","timestamp":"2026-07-26T15:00:00.000Z"}"#,
        )
        .unwrap();
        assert!(record_is_auth_expiry(&v), "result branch missed");

        // NEGATIVES — the discriminator holds: prose (no error flag) and a quota record are not auth.
        let prose: serde_json::Value = serde_json::from_str(
            r#"{"type":"assistant","timestamp":"t","message":{"content":[{"type":"text","text":"please run /login to fix an OAuth session that could not be refreshed"}]}}"#,
        )
        .unwrap();
        assert!(!record_is_auth_expiry(&prose), "prose was read as auth-death");
        let quota: serde_json::Value =
            serde_json::from_str(&limit_line("t", "You've hit your session limit")).unwrap();
        assert!(!record_is_auth_expiry(&quota), "a quota record was read as auth-death");
    }

    #[test]
    fn an_unrecovered_oauth_expiry_marks_the_account_dead() {
        // Uppercase form AND the backtick `claude login` form — both must survive the pre-filter
        // (the regression the reviewer flagged: a case-sensitive pre-filter narrower than the matcher).
        for text in [
            "OAUTH SESSION EXPIRED",
            "Please run `claude login` to continue",
            "your session could not be refreshed",
        ] {
            let base = unique_dir("auth-dead");
            let f = base.join("t.jsonl");
            let ts = "2026-07-26T15:00:00.000Z";
            std::fs::write(&f, format!("{}\n{}\n", ok_line("2026-07-26T14:00:00.000Z"), auth_line(ts, text)))
                .unwrap();
            assert!(root_is_auth_dead(&base, 0, SystemTime::now()), "not marked dead for: {text}");

            // Paired: floor AFTER the error (the identity-takeover / lookback floor) drops it — a
            // previous login's death cannot bench the current one.
            let after = parse_iso8601_to_epoch(ts).unwrap() + 10;
            assert!(!root_is_auth_dead(&base, after, SystemTime::now()), "floored error still benched: {text}");
            let _ = std::fs::remove_dir_all(&base);
        }
    }

    #[test]
    fn a_later_successful_turn_clears_the_bench() {
        // THE self-healing guard: an auth error FOLLOWED by a successful turn (a re-login) must NOT
        // leave the account benched. This is the behavior the doc claims and the reviewer said the
        // short-circuiting scanner did not implement.
        let recovered = unique_dir("auth-recovered");
        std::fs::write(
            recovered.join("t.jsonl"),
            format!(
                "{}\n{}\n",
                auth_line("2026-07-26T15:00:00.000Z", "OAuth session expired"),
                ok_line("2026-07-26T15:30:00.000Z"), // later success
            ),
        )
        .unwrap();
        assert!(!root_is_auth_dead(&recovered, 0, SystemTime::now()), "recovered account still benched");

        // PAIRED: success THEN error, nothing newer -> IS dead, so the test can't pass by never
        // marking anything dead. Separate dir so the two cases can't cross-contaminate.
        let still_dead = unique_dir("auth-still-dead");
        std::fs::write(
            still_dead.join("t.jsonl"),
            format!(
                "{}\n{}\n",
                ok_line("2026-07-26T15:00:00.000Z"),
                auth_line("2026-07-26T15:30:00.000Z", "OAuth session expired"),
            ),
        )
        .unwrap();
        assert!(root_is_auth_dead(&still_dead, 0, SystemTime::now()), "error-latest account not benched");
        let _ = std::fs::remove_dir_all(&recovered);
        let _ = std::fs::remove_dir_all(&still_dead);
    }

    /// COUPLING: the cheap reject in `fold_auth_signals` is a second correctness gate — a line it
    /// drops is never parsed — so its token set MUST subsume every phrase the matcher accepts, or the
    /// detector goes silently inert for a new phrase. Assert every `AUTH_EXPIRY_PHRASES` entry trips
    /// the prefilter predicate, so adding a phrase that these tokens miss reds the suite instead.
    #[test]
    fn every_auth_phrase_survives_the_scan_prefilter() {
        for p in crate::roborev_account::AUTH_EXPIRY_PHRASES {
            // is_auth_expired lowercases the INPUT and tests the phrase verbatim, so an uppercase
            // phrase can NEVER match — permanently inert. Enforce the "keep it lowercase" invariant
            // here, WITHOUT laundering the case (comparing p to its own lowercase, not lowercasing
            // before the prefilter check below).
            assert_eq!(*p, p.to_ascii_lowercase(), "phrase '{p}' must be lowercase or is_auth_expired can't match it");
            // Call the REAL prefilter predicate (not a re-declared copy): a phrase it drops is never
            // parsed, so narrowing the tokens in `line_carries_auth_marker` reds this test.
            assert!(line_carries_auth_marker(p), "phrase '{p}' is dropped by the fold_auth_signals prefilter");
        }
    }

    #[test]
    fn is_successful_turn_requires_an_affirmative_usage_bearing_assistant_turn() {
        let ok: serde_json::Value = serde_json::from_str(&ok_line("t")).unwrap();
        assert!(is_successful_turn(&ok), "a usage-bearing assistant turn is a success");
        // A user turn is NOT a success even if it carries a usage field (Claude Code writes the user
        // half before the request), so it can never clear a bench.
        let user: serde_json::Value = serde_json::from_str(
            r#"{"type":"user","timestamp":"t","usage":{"input_tokens":1},"message":{"role":"user","content":[]}}"#,
        )
        .unwrap();
        assert!(!is_successful_turn(&user), "a user turn must not count as success");
        // An assistant turn flagged as an API error is not a success.
        let err: serde_json::Value = serde_json::from_str(
            r#"{"type":"assistant","isApiErrorMessage":true,"timestamp":"t","message":{"usage":{"input_tokens":1}}}"#,
        )
        .unwrap();
        assert!(!is_successful_turn(&err), "an API-error turn must not count as success");
        // An assistant turn with no usage is not an affirmative success.
        let no_usage: serde_json::Value = serde_json::from_str(
            r#"{"type":"assistant","timestamp":"t","message":{"content":[]}}"#,
        )
        .unwrap();
        assert!(!is_successful_turn(&no_usage), "an assistant turn without usage is not affirmative");
    }

    #[test]
    fn a_non_success_record_after_an_auth_error_does_not_clear_the_bench() {
        // THE finding-A guard: only an AFFIRMATIVE success un-benches. A bare `user` turn (written
        // BEFORE the request), a quota record, and a differently-worded API error are each strictly
        // NEWER than the auth error yet must leave the account DEAD — one unmatched line cannot
        // un-bench a login the scan already proved dead.
        let auth_ts = "2026-07-26T15:00:00.000Z";
        let later_ts = "2026-07-26T15:30:00.000Z";
        let cases = [
            ("user turn carrying usage", format!(r#"{{"type":"user","timestamp":"{later_ts}","usage":{{"input_tokens":1}},"message":{{"role":"user","content":[]}}}}"#)),
            ("quota record", limit_line(later_ts, "You've hit your session limit")),
            ("different API error", format!(r#"{{"type":"assistant","isApiErrorMessage":true,"timestamp":"{later_ts}","message":{{"usage":{{"output_tokens":1}},"content":[{{"type":"text","text":"API Error: 500"}}]}}}}"#)),
        ];
        for (label, later) in cases {
            let base = unique_dir("auth-nonsuccess");
            std::fs::write(
                base.join("t.jsonl"),
                format!("{}\n{}\n", auth_line(auth_ts, "OAuth session expired"), later),
            )
            .unwrap();
            assert!(root_is_auth_dead(&base, 0, SystemTime::now()), "{label} wrongly cleared the bench");
            let _ = std::fs::remove_dir_all(&base);
        }
    }

    #[test]
    fn a_quota_record_does_not_mark_auth_dead() {
        // The two failure families stay DISJOINT: a rate-limit record is owned by the exhausted_until
        // path. (It also counts as ordinary activity, never as an auth error.)
        let base = unique_dir("auth-quota");
        let f = base.join("t.jsonl");
        std::fs::write(
            &f,
            format!("{}\n", limit_line("2026-07-26T15:00:00.000Z", "You've hit your session limit")),
        )
        .unwrap();
        assert!(!root_is_auth_dead(&base, 0, SystemTime::now()), "a quota wall was misread as auth-death");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn expand_auth_dead_across_identity_covers_sibling_registrations() {
        // Two registrations for ONE login (same identity key), only one directly observed dead: the
        // sibling must be excluded too. A third account on a DIFFERENT identity stays alive.
        let directly_dead: HashSet<String> = ["/dir/a".to_string()].into_iter().collect();
        let identities = vec![
            ("/dir/a".to_string(), Some("login-1".to_string())),
            ("/dir/b".to_string(), Some("login-1".to_string())), // sibling of A
            ("/dir/c".to_string(), Some("login-2".to_string())), // different login
        ];
        let out = expand_auth_dead_across_identity(&directly_dead, &identities);
        assert!(out.contains("/dir/a") && out.contains("/dir/b"), "sibling not expanded: {out:?}");
        assert!(!out.contains("/dir/c"), "unrelated login wrongly benched: {out:?}");

        // A dead dir with NO resolvable identity must not drag anyone else down (and must not panic).
        let directly_dead: HashSet<String> = ["/dir/x".to_string()].into_iter().collect();
        let identities = vec![
            ("/dir/x".to_string(), None),
            ("/dir/y".to_string(), Some("login-9".to_string())),
        ];
        let out = expand_auth_dead_across_identity(&directly_dead, &identities);
        assert_eq!(out, ["/dir/x".to_string()].into_iter().collect::<HashSet<_>>(), "identity-less dead over-expanded: {out:?}");
    }

    /// END-TO-END wiring: detection -> identity expansion -> the returned dead set. Proves the
    /// production `roborev_auth_dead_dirs` actually benches a dead login's SIBLING registration
    /// (only one has the error transcript) and leaves an unrelated login alone. Deleting the
    /// expansion call would fail this, which the pure-helper test alone could not catch.
    #[test]
    fn roborev_auth_dead_dirs_benches_sibling_registrations_of_a_dead_login() {
        let home = unique_dir("auth-e2e");
        let dir_a = home.join("acct-a");
        let dir_b = home.join("acct-b");
        let dir_c = home.join("acct-c");
        // A and B are two registrations of ONE login; C is a different login.
        write_claude_json(&dir_a, r#"{"oauthAccount":{"emailAddress":"dead@x.com"}}"#);
        write_claude_json(&dir_b, r#"{"oauthAccount":{"emailAddress":"dead@x.com"}}"#);
        write_claude_json(&dir_c, r#"{"oauthAccount":{"emailAddress":"live@x.com"}}"#);
        // An in-window auth-error transcript ONLY under A.
        let ts = "2026-07-26T15:00:00.000Z";
        let proj_a = dir_a.join("projects").join("p");
        std::fs::create_dir_all(&proj_a).unwrap();
        std::fs::write(proj_a.join("x.jsonl"), format!("{}\n", auth_line(ts, "OAuth session expired"))).unwrap();

        let now = parse_iso8601_to_epoch(ts).unwrap() + 100;
        let accounts = vec![
            sample("a", false, dir_a.to_str().unwrap()),
            sample("b", false, dir_b.to_str().unwrap()),
            sample("c", false, dir_c.to_str().unwrap()),
        ];
        let dead = roborev_auth_dead_dirs(&accounts, Some(&home), &no_log(), now);
        assert!(dead.contains(dir_a.to_str().unwrap()), "A (directly dead) missing: {dead:?}");
        assert!(dead.contains(dir_b.to_str().unwrap()), "B (sibling of A's login) not benched: {dead:?}");
        assert!(!dead.contains(dir_c.to_str().unwrap()), "C (different login) wrongly benched: {dead:?}");

        // PAIRED NEGATIVE: give B a DIFFERENT login — now only A comes back, so the test can't pass
        // by returning everything.
        write_claude_json(&dir_b, r#"{"oauthAccount":{"emailAddress":"other@x.com"}}"#);
        let dead = roborev_auth_dead_dirs(&accounts, Some(&home), &no_log(), now);
        assert!(
            dead.contains(dir_a.to_str().unwrap()) && !dead.contains(dir_b.to_str().unwrap()),
            "with distinct logins only A is dead: {dead:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The `home` argument is LOAD-BEARING at THIS function's boundary, not inert: for the DEFAULT
    /// account (empty `config_dir`) the transcript root is `<home>/.claude/projects`, so the scan can
    /// only find its auth-error via the injected home, and passing `None` misses it. NOTE this pins
    /// `roborev_auth_dead_dirs` genuinely consulting `home`; it does NOT observe
    /// `republish_roborev_candidates`'s choice of `home` vs a fresh env read at the call site — that
    /// choice is unobserved by any test and is behaviorally identical while both callers pass `$HOME`.
    #[test]
    fn roborev_auth_dead_dirs_consults_home_for_the_default_account() {
        let home = unique_dir("auth-default-home");
        let proj = home.join(".claude").join("projects").join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let ts = "2026-07-26T15:00:00.000Z";
        std::fs::write(proj.join("x.jsonl"), format!("{}\n", auth_line(ts, "OAuth session expired"))).unwrap();
        let now = parse_iso8601_to_epoch(ts).unwrap() + 100;
        let accounts = vec![sample("d", true, "")]; // default account: empty config_dir

        let dead = roborev_auth_dead_dirs(&accounts, Some(&home), &no_log(), now);
        assert!(dead.contains(""), "default account not detected via injected home: {dead:?}");

        // PAIRED: without a home the default account's transcript root is unresolvable
        // (`claude_projects_root(Some(""), None)` → `None`), so it is missed — this shows the
        // `Some(&home)` arm above passed BECAUSE of the home, not vacuously. It pins that THIS
        // function consults `home`, not that any caller threads it (see the doc block above).
        let dead_none = roborev_auth_dead_dirs(&accounts, None, &no_log(), now);
        assert!(!dead_none.contains(""), "default account resolved without home: {dead_none:?}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// THE MERGE-COMPOSITION GUARD (#2026 × #2043). `republish_roborev_candidates` is the ONLY place
    /// #2026's identity-aware exhaustion and #2043's auth-dead exclusion compose, and a clean git
    /// resolution of that hunk could silently drop either. Drive the real function end-to-end and
    /// assert BOTH exclusions hold in the WRITTEN candidate file: reverting `&corrected`→`&accounts`
    /// re-admits the quota-sibling (its own dir carries no bench, only the identity path sees it),
    /// and dropping the `auth_dead` argument re-admits the auth-dead account.
    #[test]
    fn republish_composes_identity_aware_exhaustion_and_auth_dead_exclusion() {
        let base = unique_dir("republish-compose");
        let app_data = base.join("app_data");
        std::fs::create_dir_all(&app_data).unwrap();
        let home = base.join("home");
        std::fs::create_dir_all(&home).unwrap();

        let dir_a = base.join("a"); // quota-walled (own bench), identity uuid-shared
        let dir_b = base.join("b"); // sibling of A (uuid-shared), NO own bench — only the identity path excludes
        let dir_c = base.join("c"); // auth-dead (auth-error transcript), identity uuid-c
        let dir_d = base.join("d"); // healthy
        let dir_e = base.join("e"); // healthy (keeps ≥ MIN_HEALTHY_TO_RUN after exclusions)
        write_claude_json(&dir_a, r#"{"oauthAccount":{"emailAddress":"shared@x.com","accountUuid":"uuid-shared"}}"#);
        write_claude_json(&dir_b, r#"{"oauthAccount":{"emailAddress":"shared@x.com","accountUuid":"uuid-shared"}}"#);
        write_claude_json(&dir_c, r#"{"oauthAccount":{"emailAddress":"c@x.com","accountUuid":"uuid-c"}}"#);
        write_claude_json(&dir_d, r#"{"oauthAccount":{"emailAddress":"d@x.com","accountUuid":"uuid-d"}}"#);
        write_claude_json(&dir_e, r#"{"oauthAccount":{"emailAddress":"e@x.com","accountUuid":"uuid-e"}}"#);

        // C's auth-error transcript. A far-future timestamp keeps it in-window regardless of the real
        // `now_secs()` republish reads internally (the scan floors below, not above, the window).
        let proj_c = dir_c.join("projects").join("p");
        std::fs::create_dir_all(&proj_c).unwrap();
        std::fs::write(
            proj_c.join("x.jsonl"),
            format!("{}\n", auth_line("2099-01-01T00:00:00.000Z", "OAuth session expired")),
        )
        .unwrap();

        // A carries its own quota wall + identity; usage_for_accounts propagates it to sibling B.
        let now = now_secs();
        let mut a = sample("a", false, dir_a.to_str().unwrap());
        a.exhausted_until = Some(now + 3_600);
        a.exhausted_identity = Some("uuid-shared".to_string());
        let accounts = vec![
            a,
            sample("b", false, dir_b.to_str().unwrap()),
            sample("c", false, dir_c.to_str().unwrap()),
            sample("d", false, dir_d.to_str().unwrap()),
            sample("e", false, dir_e.to_str().unwrap()),
        ];
        write_accounts_at(&accounts_json_path(&app_data), &accounts).unwrap();

        republish_roborev_candidates(&app_data, &home);

        let published = std::fs::read_to_string(crate::roborev_account::candidates_path(&home))
            .expect("candidate file written");
        // #2026 path: A (own wall) AND B (identity-contagion via `corrected`) are both excluded.
        assert!(!published.contains(dir_a.to_str().unwrap()), "quota-walled A published: {published}");
        assert!(!published.contains(dir_b.to_str().unwrap()), "identity-sibling B published — `corrected` dropped? {published}");
        // #2043 path: C (auth-dead) is excluded.
        assert!(!published.contains(dir_c.to_str().unwrap()), "auth-dead C published — `auth_dead` dropped? {published}");
        // Paired: the healthy pair IS published, so the assertion can't pass via an empty/STANDDOWN list.
        assert!(!published.contains(crate::roborev_account::STANDDOWN), "unexpected stand-down: {published}");
        assert!(published.contains(dir_d.to_str().unwrap()), "healthy D missing: {published}");
        assert!(published.contains(dir_e.to_str().unwrap()), "healthy E missing: {published}");
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

    /// The `accountUuid` [`ceiling_fixture`] signs its directory in as. A ceiling is a claim about a
    /// specific Anthropic account, so every ceiling scenario needs one.
    const FIXTURE_UUID: &str = "uuid-a";

    /// Sign `dir` in as `uuid` — a `.claude.json` with an `oauthAccount` carrying that `accountUuid`.
    fn write_identity(dir: &Path, uuid: &str) {
        write_claude_json(
            dir,
            &format!(
                r#"{{"oauthAccount":{{"emailAddress":"{uuid}@example.com","accountUuid":"{uuid}"}}}}"#
            ),
        );
    }

    /// An empty ledger: "we have never observed a different identity behind this dir", the state of
    /// every install before this code ran and the baseline for the no-regression ceiling tests.
    fn no_log() -> IdentityLog {
        IdentityLog::new()
    }

    /// Build a transcript pairing each `(limit_iso, usage_iso, tokens)` into usage-then-limit, so
    /// `ceiling_for_account` can learn from it. `tokens` lands in `input_tokens`; a fixed
    /// `cache_read` rides along and must never appear in a sample.
    ///
    /// Also signs the dir in as [`FIXTURE_UUID`]: without a resolvable identity `ceiling_for_account`
    /// returns `None` by contract, so an unsigned fixture could not exercise the learner at all.
    fn ceiling_fixture(dir: &Path, episodes: &[(&str, &str, u64)]) {
        write_identity(dir, FIXTURE_UUID);
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
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now, None, "", &no_log());
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
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now, None, "", &no_log());
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
        write_identity(&base, FIXTURE_UUID);
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
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now, None, "", &no_log());
        assert_eq!(got.samples, vec![100, 100, 100], "the evidence-free episode is dropped");
        assert_eq!(got.ceiling, Some(100));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ceiling_is_none_for_an_account_that_never_hit_a_limit() {
        let base = unique_dir("ceiling-clean");
        // Signed in — so `None` here is "no limit events", not "no identity".
        write_identity(&base, FIXTURE_UUID);
        std::fs::create_dir_all(base.join("projects")).unwrap();
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now, None, "", &no_log());
        assert!(got.samples.is_empty());
        assert_eq!(got.ceiling, None);
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- ceilings keyed on IDENTITY, not directory ---------------------------------

    /// A ledger in which `prev` held `dir` first and `next` took it over at `takeover`.
    fn log_with_takeover(dir: &Path, prev: &str, next: &str, takeover: i64) -> IdentityLog {
        let mut log = IdentityLog::new();
        let key = dir.to_str().unwrap();
        // Distinct email forms: these are takeovers between different logins, not ladder climbs.
        identity_log::apply_observation(&mut log, key, prev, "email:prev@test.invalid", takeover - 1000);
        identity_log::apply_observation(&mut log, key, next, "email:next@test.invalid", takeover);
        log
    }

    /// The four-episode fixture the ceiling tests share: consumption 100/300/200/400 → median 250.
    fn four_episode_fixture(base: &Path) {
        ceiling_fixture(
            base,
            &[
                ("2026-07-18T09:59:00.000Z", "2026-07-18T10:00:00.000Z", 100),
                ("2026-07-19T09:59:00.000Z", "2026-07-19T10:00:00.000Z", 300),
                ("2026-07-20T09:59:00.000Z", "2026-07-20T10:00:00.000Z", 200),
                ("2026-07-21T09:59:00.000Z", "2026-07-21T10:00:00.000Z", 400),
            ],
        );
    }

    #[test]
    fn ceiling_resets_to_none_when_the_identity_behind_the_dir_changed_midwindow() {
        // THE headline case. Four limit episodes in one config dir — plenty to learn a ceiling from,
        // and the pre-change code returned one. But a DIFFERENT Anthropic account signed into that
        // directory partway through the window, and transcripts carry no account marker, so the
        // older episodes cannot be attributed to the current login. Carrying that median forward
        // would warn (or fail over) the current user against a number measured on someone else.
        let base = unique_dir("ceiling-identity-reset");
        four_episode_fixture(&base);
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let acct = sample("c1", false, base.to_str().unwrap());

        // Control: with no recorded identity change the very same fixture DOES learn a ceiling.
        // Without this line the assertions below could pass on a fixture that never worked.
        let control = ceiling_for_account(&acct, now, None, "", &no_log());
        assert_eq!(control.ceiling, Some(250));
        assert!(!control.reset_by_identity_change);

        // Now the ledger says the current uuid only took the directory over on 07-20, so the 07-18
        // and 07-19 episodes belong to whoever had it before.
        let takeover = parse_iso8601_to_epoch("2026-07-20T00:00:00.000Z").unwrap();
        let log = log_with_takeover(&base, "uuid-previous", FIXTURE_UUID, takeover);
        let got = ceiling_for_account(&acct, now, None, "", &log);

        assert!(got.reset_by_identity_change, "samples were dropped for an identity change");
        assert_eq!(got.ceiling, None, "under CEILING_MIN_SAMPLES → unknown, NEVER the old median");
        assert!(
            got.samples.len() < CEILING_MIN_SAMPLES,
            "only post-takeover episodes survive: {:?}",
            got.samples
        );
        assert_eq!(got.samples, vec![200, 400], "and they are exactly the post-takeover pair");
        assert_eq!(got.account_uuid.as_deref(), Some(FIXTURE_UUID), "whose ceiling this would be");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_takeover_that_still_leaves_enough_samples_learns_from_only_those() {
        // The reset is a CUT, not a blanket refusal: drop one episode and the remaining three are a
        // legitimate measurement of the current identity. `reset_by_identity_change` still reports
        // that history was discarded, so the UI can explain a number that moved.
        let base = unique_dir("ceiling-identity-cut");
        four_episode_fixture(&base);
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let takeover = parse_iso8601_to_epoch("2026-07-18T20:00:00.000Z").unwrap();
        let log = log_with_takeover(&base, "uuid-previous", FIXTURE_UUID, takeover);
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now, None, "", &log);
        assert!(got.reset_by_identity_change);
        assert_eq!(got.samples, vec![300, 200, 400], "the 07-18 episode is the previous identity's");
        assert_eq!(got.ceiling, Some(300), "median of what is genuinely ours");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_unchanged_identity_learns_its_ceiling_normally() {
        // The no-regression guard. Everything above must not cost the ordinary case its ceiling.
        let base = unique_dir("ceiling-identity-stable");
        four_episode_fixture(&base);
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let acct = sample("c1", false, base.to_str().unwrap());

        // (a) A ledger holding ONLY this uuid — the shape after a first sighting, which is what
        //     every existing install looks like the moment this ships. A first epoch is not a
        //     takeover; reading it as one would blank every learned ceiling on upgrade.
        let mut first_sighting = IdentityLog::new();
        identity_log::apply_observation(
            &mut first_sighting,
            base.to_str().unwrap(),
            FIXTURE_UUID,
            "email:fixture@test.invalid",
            now - 10,
        );
        let got = ceiling_for_account(&acct, now, None, "", &first_sighting);
        assert_eq!(got.ceiling, Some(250));
        assert!(!got.reset_by_identity_change);
        assert_eq!(got.samples.len(), 4);

        // (b) A takeover that happened BEFORE the 30-day learn window is already aged out by the
        //     window itself — it must not keep cutting forever.
        let old = log_with_takeover(
            &base,
            "uuid-previous",
            FIXTURE_UUID,
            now - CEILING_LEARN_WINDOW - 24 * 60 * 60,
        );
        let got = ceiling_for_account(&acct, now, None, "", &old);
        assert_eq!(got.ceiling, Some(250), "a takeover outside the window cuts nothing");
        assert!(!got.reset_by_identity_change);

        // (c) Another dir's churn is not ours.
        let elsewhere = log_with_takeover(
            Path::new("/somewhere/else"),
            "uuid-previous",
            FIXTURE_UUID,
            parse_iso8601_to_epoch("2026-07-20T00:00:00.000Z").unwrap(),
        );
        assert_eq!(ceiling_for_account(&acct, now, None, "", &elsewhere).ceiling, Some(250));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ceiling_is_none_when_the_account_has_no_resolvable_identity() {
        // A ceiling is a claim about a specific Anthropic account. A directory full of limit events
        // that we cannot attribute to anyone yields samples but NO ceiling — `account_uuid: None`
        // and `ceiling: None` travel together, by contract (§4b).
        let base = unique_dir("ceiling-no-identity");
        four_episode_fixture(&base);
        std::fs::remove_file(base.join(".claude.json")).unwrap(); // never logged in
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let got = ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now, None, "", &no_log());
        assert_eq!(got.account_uuid, None);
        assert_eq!(got.ceiling, None, "unattributable history is not a ceiling");
        assert_eq!(got.samples.len(), 4, "the samples are still reported, just not trusted");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_shell_half_of_the_cache_key_uses_the_identity_LADDER_not_the_raw_uuid() {
        // The one behaviour unique to the cache-key path, and previously untestable: it was inlined
        // in a #[tauri::command] body, and `ceiling_cache_key` takes the shell identity as an opaque
        // Option<&str>, so its shell cases pass literals and stay green either way. This asserts the
        // DERIVATION, so it fails if `shell_identity_key_at` reverts to `.and_then(|s| s.account_uuid)`.
        //
        // What that revert would silently permit: a terminal `claude auth login` into an account
        // predating `accountUuid` leaves the shell half of the key unchanged, the cache hits, and
        // the pre-login (possibly another person's) ceiling is served for the full TTL.
        let dir = unique_dir("shell-identity-key");

        // A shell login WITHOUT accountUuid — the pre-field shape. Raw-uuid derivation gives None.
        write_claude_json(&dir, r#"{"oauthAccount":{"emailAddress":"shell-old@example.com"}}"#);
        assert_eq!(
            shell_identity_key_at(dir.to_str().unwrap(), None),
            Some("email:shell-old@example.com".to_string()),
            "an email-only shell login must still produce a key, or a re-login cannot invalidate"
        );

        // A shell login WITH accountUuid — the uuid wins, since it is the stronger discriminator.
        write_claude_json(
            &dir,
            r#"{"oauthAccount":{"emailAddress":"shell-new@example.com","accountUuid":"uuid-shell"}}"#,
        );
        assert_eq!(
            shell_identity_key_at(dir.to_str().unwrap(), None),
            Some("uuid-shell".to_string())
        );

        // Signing the terminal OUT changes the key, so the cached ceiling cannot survive it.
        std::fs::remove_file(dir.join(".claude.json")).unwrap();
        assert_eq!(shell_identity_key_at(dir.to_str().unwrap(), None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_login_predating_account_uuid_still_learns_its_ceiling() {
        // THE LADDER (contract §4b). `accountUuid` is absent on logins that predate the field, and
        // such an account is SIGNED IN and fully attributable — just by email. Gating the ceiling on
        // the uuid returned `None` for it forever, so `switchRecommendation` read `unknown` and the
        // near-cap banner could never fire again, with nothing to distinguish it from a directory
        // that genuinely belongs to nobody. That is a silent, permanent capability loss.
        //
        // Fails against a uuid-only gate: `ceiling` comes back `None` there.
        let base = unique_dir("ceiling-email-only-identity");
        four_episode_fixture(&base);
        // Signed in, with an email and NO accountUuid — the pre-field login shape.
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":"old@example.com"}}"#);
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();

        let got =
            ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now, None, "", &no_log());

        assert_eq!(got.ceiling, Some(250), "an email-attributable login keeps its ceiling");
        assert_eq!(got.account_uuid, None, "and still reports no uuid on the wire");
        assert!(!got.reset_by_identity_change);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_email_keyed_identity_still_gets_its_history_cut_on_a_takeover() {
        // The ladder must not weaken the reset: an email-keyed identity that TOOK OVER a directory
        // inside the learn window still discards the previous occupant's episodes. Otherwise the
        // fallback would quietly reintroduce the very bug the ledger exists to fix.
        let base = unique_dir("ceiling-email-only-takeover");
        four_episode_fixture(&base);
        write_claude_json(&base, r#"{"oauthAccount":{"emailAddress":"old@example.com"}}"#);
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let takeover = parse_iso8601_to_epoch("2026-07-18T20:00:00.000Z").unwrap();

        // The ledger files this identity under its EMAIL key, exactly as `identity_key` writes it.
        let log = log_with_takeover(&base, "uuid-previous", "email:old@example.com", takeover);
        let got =
            ceiling_for_account(&sample("c1", false, base.to_str().unwrap()), now, None, "", &log);

        assert!(got.reset_by_identity_change, "an email-keyed takeover still cuts");
        assert_eq!(got.samples, vec![300, 200, 400], "the 07-18 episode is the previous identity's");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_uuid_less_login_is_not_mistaken_for_a_different_account() {
        // `identities_differ` must never read a MISSING uuid as a mismatch. A bare `!=` makes
        // `None != Some(x)` true, which invents a fork between what may be one account — the
        // "a wrong identity is worse than none" failure (§5) in the surface built to prevent it.
        let with_uuid = |u: &str, e: &str| OauthIdentity {
            email: e.to_string(),
            organization: None,
            account_uuid: Some(u.to_string()),
        };
        let no_uuid = |e: &str| OauthIdentity {
            email: e.to_string(),
            organization: None,
            account_uuid: None,
        };

        // Rung 1 — both uuids present: the uuid decides, even when the emails agree.
        assert!(identities_differ(&with_uuid("a", "same@x.com"), &with_uuid("b", "same@x.com")));
        assert!(!identities_differ(&with_uuid("a", "one@x.com"), &with_uuid("a", "two@x.com")));

        // Rung 2 — a uuid missing on EITHER side: fall back to the email, do not read the gap as a
        // difference. This is the case a bare `!=` gets wrong.
        assert!(
            !identities_differ(&no_uuid("same@x.com"), &with_uuid("b", "same@x.com")),
            "a missing uuid is unknown, NOT a different account"
        );
        assert!(
            !identities_differ(&with_uuid("b", "same@x.com"), &no_uuid("same@x.com")),
            "and it is symmetric"
        );
        assert!(identities_differ(&no_uuid("one@x.com"), &no_uuid("two@x.com")));
        assert!(!identities_differ(&no_uuid("same@x.com"), &no_uuid("same@x.com")));
    }

    #[test]
    fn ceiling_cache_is_keyed_on_the_account_set_and_their_identities() {
        // It used to be keyed on NOTHING — one process-global `(computed_at, value)` served for 15
        // minutes however the accounts changed. Adding an account showed the old set's ceilings;
        // a fresh login behind a dir kept serving the previous person's number, which is exactly
        // the mis-attribution this work exists to stop.
        let app_data = Path::new("/app/data");
        let a = sample("a1", true, "");
        let b = sample("b2", false, "/data/accounts/b2");
        let key = |accts: &[Account], uuids: &[Option<String>]| {
            ceiling_cache_key(app_data, accts, uuids, "", Some("u-shell"))
        };
        let base = key(&[a.clone(), b.clone()], &[Some("u-a".into()), Some("u-b".into())]);

        // Same everything → hit.
        let cache: CeilingCache = Some((base.clone(), 1_000, vec![]));
        assert!(ceiling_cache_lookup(&cache, &base, 1_000 + CEILING_CACHE_TTL - 1).is_some());
        // TTL still expires it.
        assert!(ceiling_cache_lookup(&cache, &base, 1_000 + CEILING_CACHE_TTL).is_none());

        // A DIFFERENT identity behind the same dir must miss, inside the TTL.
        let relogin = key(&[a.clone(), b.clone()], &[Some("u-a".into()), Some("u-NEW".into())]);
        assert_ne!(relogin, base);
        assert!(ceiling_cache_lookup(&cache, &relogin, 1_001).is_none());
        // Signing OUT (uuid → None) must miss too.
        let signed_out = key(&[a.clone(), b.clone()], &[Some("u-a".into()), None]);
        assert!(ceiling_cache_lookup(&cache, &signed_out, 1_001).is_none());
        // Removing an account must miss.
        let removed = key(&[a.clone()], &[Some("u-a".into())]);
        assert!(ceiling_cache_lookup(&cache, &removed, 1_001).is_none());
        // Adding one must miss.
        let added = key(
            &[a.clone(), b.clone(), sample("c3", false, "/data/accounts/c3")],
            &[Some("u-a".into()), Some("u-b".into()), Some("u-c".into())],
        );
        assert!(ceiling_cache_lookup(&cache, &added, 1_001).is_none());
        // Repointing an account's config dir must miss.
        let moved = key(
            &[a.clone(), sample("b2", false, "/data/accounts/OTHER")],
            &[Some("u-a".into()), Some("u-b".into())],
        );
        assert!(ceiling_cache_lookup(&cache, &moved, 1_001).is_none());
        // A different app_data root must miss.
        assert!(ceiling_cache_lookup(
            &cache,
            &ceiling_cache_key(
                Path::new("/other/data"),
                &[a.clone(), b.clone()],
                &[Some("u-a".into()), Some("u-b".into())],
                "",
                Some("u-shell")
            ),
            1_001
        )
        .is_none());

        // THE SHELL'S OWN LOGIN must miss too. `ceiling_for_account` suppresses the ceiling when a
        // default account shares a transcript tree with a differently-signed-in terminal, so
        // `claude auth login` in that terminal flips the answer while NOTHING about any account
        // record changes. Without this the pre-login number would be served for the full TTL — the
        // very staleness the key exists to end, relocated to the one dir it did not cover.
        let accts = [a.clone(), b.clone()];
        let ids = [Some("u-a".to_string()), Some("u-b".to_string())];
        let shell_relogin = ceiling_cache_key(app_data, &accts, &ids, "", Some("u-shell-NEW"));
        assert_ne!(shell_relogin, base);
        assert!(ceiling_cache_lookup(&cache, &shell_relogin, 1_001).is_none());
        // As must the shell signing out, or exporting a different CLAUDE_CONFIG_DIR.
        assert!(
            ceiling_cache_lookup(&cache, &ceiling_cache_key(app_data, &accts, &ids, "", None), 1_001)
                .is_none()
        );
        assert!(ceiling_cache_lookup(
            &cache,
            &ceiling_cache_key(app_data, &accts, &ids, "/exported", Some("u-shell")),
            1_001
        )
        .is_none());
    }

    // ---- shell identity on the default account -------------------------------------

    #[test]
    fn shell_identity_pins_the_founders_forked_default_account() {
        // The founder's EXACT measured state (identity-truth contract §1). His default account has
        // `config_dir = <home>/.claude`, so Sparkle exports CLAUDE_CONFIG_DIR and reads
        // `<home>/.claude/.claude.json`; his terminal exports nothing and reads `<home>/.claude.json`.
        // BOTH hold valid logins, to DIFFERENT Anthropic accounts. Before this, the UI showed only
        // the first and there was no way to see the fork at all.
        let home = fake_home("shell-fork", Some("storytell@example.com"), Some("gmail@example.com"));
        let log_path = home.join("account-identity-log.json");
        let default = sample("d", true, home.join(".claude").to_str().unwrap());
        let named_dir = home.join("named");
        write_claude_json(&named_dir, r#"{"oauthAccount":{"emailAddress":"named@example.com"}}"#);
        let named = sample("n", false, named_dir.to_str().unwrap());

        let got = identities_at(&[default, named], Some(&home), "", &log_path, 1_700_000_000);

        assert_eq!(
            got[0].email.as_deref(),
            Some("storytell@example.com"),
            "Sparkle runs the default account as this"
        );
        assert_eq!(
            got[0].shell_email.as_deref(),
            Some("gmail@example.com"),
            "...while a plain terminal `claude` is this person — the fork, now visible"
        );
        assert_ne!(got[0].email, got[0].shell_email, "which is the whole point");

        // A NAMED account's dir is its own truth; the shell's login says nothing about it, and
        // reporting it here would re-create the mislabelling this module exists to prevent.
        assert_eq!(got[1].email.as_deref(), Some("named@example.com"));
        assert_eq!(got[1].shell_email, None);
        assert_eq!(got[1].shell_account_uuid, None);

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn shell_identity_matches_when_the_default_account_is_not_forked() {
        // A normalized default (`config_dir = ""`, export nothing) reads the SAME file the terminal
        // does, so the two agree and the UI has no fork to report.
        let home = fake_home("shell-same", None, Some("only@example.com"));
        let log_path = home.join("account-identity-log.json");
        let got = identities_at(&[sample("d", true, "")], Some(&home), "", &log_path, 1_700_000_000);
        assert_eq!(got[0].email.as_deref(), Some("only@example.com"));
        assert_eq!(got[0].shell_email.as_deref(), Some("only@example.com"));
        let _ = std::fs::remove_dir_all(&home);

        // No terminal login at all → nothing to report, not a fabricated fork.
        let home = fake_home("shell-none", Some("sparkle@example.com"), None);
        let log_path = home.join("account-identity-log.json");
        let acct = sample("d", true, home.join(".claude").to_str().unwrap());
        let got = identities_at(&[acct], Some(&home), "", &log_path, 1_700_000_000);
        assert_eq!(got[0].email.as_deref(), Some("sparkle@example.com"));
        assert_eq!(got[0].shell_email, None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn shell_identity_follows_an_exported_claude_config_dir() {
        // A user who exports CLAUDE_CONFIG_DIR in .zprofile/.zlogin: their terminal reads
        // `<their dir>/.claude.json`, and `accounts_ensure_default` stores that same dir as the
        // default account's config_dir — so the two read ONE file and there is NO fork.
        // Hardcoding `$HOME/.claude.json` as "the shell" would report the stale login sitting there
        // and announce a fork that does not exist: a fabricated identity presented as verified
        // truth, in the surface built to prevent exactly that.
        let home = fake_home("shell-exported", None, Some("stale@example.com"));
        let exported = home.join("exported");
        write_claude_json(
            &exported,
            r#"{"oauthAccount":{"emailAddress":"work@example.com","accountUuid":"u-work"}}"#,
        );
        let log_path = home.join("account-identity-log.json");
        let acct = sample("d", true, exported.to_str().unwrap());

        let got = identities_at(
            &[acct],
            Some(&home),
            exported.to_str().unwrap(),
            &log_path,
            1_700_000_000,
        );
        assert_eq!(got[0].email.as_deref(), Some("work@example.com"));
        assert_eq!(
            got[0].shell_email.as_deref(),
            Some("work@example.com"),
            "same file as the account reads — no fork to report"
        );
        assert_eq!(got[0].shell_email, got[0].email);
        assert_eq!(got[0].shell_account_uuid.as_deref(), Some("u-work"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_default_account_sharing_one_transcript_tree_with_the_shell_has_no_ceiling() {
        // The founder's configuration, and the case the temporal ledger CANNOT fix. With
        // `config_dir = <home>/.claude` the account's projects root is `<home>/.claude/projects` —
        // byte-identical to where a plain terminal `claude` writes. Two identities append to ONE
        // tree concurrently, so no uuid ever changes behind the config file, `takeover_at` stays
        // None, nothing is cut, and the median silently mixes both people's consumption. Claiming
        // `accountUuid: <sparkle's>` over that sample set is a false attribution.
        let home = unique_dir("ceiling-commingled");
        let state = home.join(".claude");
        four_episode_fixture(&state); // signs <home>/.claude in as FIXTURE_UUID + writes transcripts
        let now = parse_iso8601_to_epoch("2026-07-22T00:00:00.000Z").unwrap();
        let acct = sample("d", true, state.to_str().unwrap());

        // Control: the terminal is signed in as the SAME account, so one tree is fine and the
        // ceiling is learned exactly as before. Without this the assertion below could pass on a
        // fixture that never produced a ceiling at all.
        std::fs::write(
            home.join(".claude.json"),
            format!(
                r#"{{"oauthAccount":{{"emailAddress":"same@example.com","accountUuid":"{FIXTURE_UUID}"}}}}"#
            ),
        )
        .unwrap();
        let control = ceiling_for_account(&acct, now, Some(&home), "", &no_log());
        assert_eq!(control.ceiling, Some(250), "same identity in one tree still learns");
        assert!(!control.reset_by_identity_change);

        // Now the terminal is a DIFFERENT Anthropic account writing into the same tree.
        std::fs::write(
            home.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"other@example.com","accountUuid":"uuid-shell"}}"#,
        )
        .unwrap();
        let got = ceiling_for_account(&acct, now, Some(&home), "", &no_log());
        assert_eq!(got.ceiling, None, "commingled transcripts are not attributable to anyone");
        assert!(got.reset_by_identity_change, "and the UI is told why the number is gone");
        assert_eq!(got.account_uuid.as_deref(), Some(FIXTURE_UUID), "still whose account this is");

        // A NAMED account is never affected: its dir is its own, whatever the shell is doing.
        let mut named = acct.clone();
        named.is_default = false;
        assert_eq!(
            ceiling_for_account(&named, now, Some(&home), "", &no_log()).ceiling,
            Some(250)
        );
        // Nor is a default whose transcripts live somewhere else entirely.
        let elsewhere = sample("d", true, home.join("other").to_str().unwrap());
        four_episode_fixture(&home.join("other"));
        assert_eq!(
            ceiling_for_account(&elsewhere, now, Some(&home), "", &no_log()).ceiling,
            Some(250),
            "different tree → the shell's identity is irrelevant"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_identity_read_records_the_ledger_and_reports_a_change() {
        // The identity read is the ledger's hook. Reading the same identity twice must not fabricate
        // a takeover; reading a DIFFERENT one must open an epoch and flip `identity_changed`, which
        // is the same boundary the ceiling reset keys on.
        let home = unique_dir("identities-ledger");
        let dir = home.join("acct");
        write_identity(&dir, "uuid-one");
        let log_path = home.join("account-identity-log.json");
        let acct = sample("a", false, dir.to_str().unwrap());
        let t0 = 1_700_000_000;

        let got = identities_at(std::slice::from_ref(&acct), None, "", &log_path, t0);
        assert_eq!(got[0].account_uuid.as_deref(), Some("uuid-one"));
        assert!(!got[0].identity_changed, "a first sighting is not a change");

        // Same identity later: ONE epoch, tail moved.
        let got = identities_at(std::slice::from_ref(&acct), None, "", &log_path, t0 + 3600);
        assert!(!got[0].identity_changed);
        let log = identity_log::read_log_at(&log_path);
        let key = dir.to_str().unwrap();
        assert_eq!(log[key].len(), 1, "same uuid must not open a second epoch");
        assert_eq!(log[key][0].first_seen_at, t0);
        assert_eq!(log[key][0].last_seen_at, t0 + 3600, "lastSeenAt bumped in place");

        // A different login into the same dir opens an epoch and is reported as a change.
        write_identity(&dir, "uuid-two");
        let got = identities_at(std::slice::from_ref(&acct), None, "", &log_path, t0 + 7200);
        assert_eq!(got[0].account_uuid.as_deref(), Some("uuid-two"));
        assert!(got[0].identity_changed, "the fork the ceiling reset keys on");
        let log = identity_log::read_log_at(&log_path);
        assert_eq!(log[key].len(), 2);
        assert_eq!(log[key][1].first_seen_at, t0 + 7200);
        // No orphan temp left behind by any of those writes.
        assert!(!log_path.with_extension("json.tmp").exists());

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_ledger_write_failure_never_breaks_the_identity_read() {
        // Identity DISPLAY must not depend on the ledger. Point it at a path that cannot be created
        // (a directory where the file should be) and the emails still come back.
        let home = unique_dir("identities-ledger-broken");
        let dir = home.join("acct");
        write_identity(&dir, "uuid-one");
        let log_path = home.join("blocked");
        std::fs::create_dir_all(&log_path).unwrap(); // rename onto a dir fails
        let got =
            identities_at(&[sample("a", false, dir.to_str().unwrap())], None, "", &log_path, 1_700_000);
        assert_eq!(got[0].account_uuid.as_deref(), Some("uuid-one"));
        assert_eq!(got[0].email.as_deref(), Some("uuid-one@example.com"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn account_ceiling_serializes_camel_case_keys() {
        let c = AccountCeiling {
            id: "a".into(),
            samples: vec![1, 2, 3],
            ceiling: Some(2),
            account_uuid: Some("c70bea4e".into()),
            reset_by_identity_change: false,
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v.get("ceiling").unwrap(), 2);
        assert!(v.get("samples").is_some());
        // The FROZEN wire names the TS side reads (PRD/sparkle/claude-account-identity-truth.md §4b).
        assert_eq!(v.get("accountUuid").unwrap(), "c70bea4e");
        assert_eq!(v.get("resetByIdentityChange").unwrap(), false);
        assert!(v.get("account_uuid").is_none() && v.get("reset_by_identity_change").is_none());
        // A null ceiling must survive as null (the frontend keys "can't warn" off it), and so must a
        // null accountUuid — "we don't know whose this is" is a distinct state from "no ceiling".
        let none = AccountCeiling {
            id: "a".into(),
            samples: vec![],
            ceiling: None,
            account_uuid: None,
            reset_by_identity_change: true,
        };
        let v = serde_json::to_value(&none).unwrap();
        assert!(v.get("ceiling").unwrap().is_null());
        assert!(v.get("accountUuid").unwrap().is_null());
        assert_eq!(v.get("resetByIdentityChange").unwrap(), true);
    }

    #[test]
    fn account_identity_serializes_camel_case_keys() {
        // The FROZEN wire the two TS units build against (§4a of the identity-truth contract): a
        // rename here breaks them silently, since a missing key deserializes to `undefined`.
        let v = serde_json::to_value(AccountIdentity {
            id: "133420d1".into(),
            email: Some("work@example.com".into()),
            organization: None,
            account_uuid: Some("c70bea4e".into()),
            shell_email: Some("personal@example.com".into()),
            shell_account_uuid: Some("5fb3d67c".into()),
            identity_changed: true,
        })
        .unwrap();
        assert_eq!(v.get("shellEmail").unwrap(), "personal@example.com");
        assert_eq!(v.get("shellAccountUuid").unwrap(), "5fb3d67c");
        assert_eq!(v.get("identityChanged").unwrap(), true);
        assert!(v.get("shell_email").is_none() && v.get("identity_changed").is_none());
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

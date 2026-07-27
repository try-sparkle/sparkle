//! Opt-in Builder Index (tokenmaxxing / tkmx) reporting — bead sparkle-s3g2.6.
//!
//! One consented click publishes this machine's DAILY TOKEN TOTALS to the public tokenmaxxing
//! leaderboard, whose operator has confirmed the integration is welcome. Everything here is
//! DEFAULT-OFF and triple-gated: `[tools].builder_index` must be on, the one-time consent modal
//! must have been answered "publish", and a username + API key must be stored. Miss any one of
//! those and [`report_once`] returns [`ReportOutcome::Skipped`] without opening a socket.
//!
//! WHAT LEAVES THE MACHINE (and nothing else):
//!   • one row per (calendar day, model): five token counters + an estimated cost
//!   • the username the user typed and a per-machine `client_id`
//! There are no file paths, no project or session names, no prompts, no code, no keys — the
//! rollup below is built from [`crate::spend::UsageRecord`] and structurally cannot carry them
//! (a record's `project`/`session` fields are dropped by [`rollup`], not merely omitted).
//!
//! WHY IT'S NATIVE. The community pipeline (tkmx-client + agentsview) UNDERREPORTED this machine
//! by ~84% (verified 2026-07-24: ~12.6B tokens/7d actual vs 2.03B on the profile), because
//! agentsview only indexes `~/.claude` and never sees Sparkle's per-account
//! `accounts/<id>/projects` stores. So the reporter reuses `spend.rs`'s scan — the one that
//! already walks every account store — rather than shelling out to a tool with that blind spot.
//!
//! WIRE PROTOCOL — read off github.com/srosro/tkmx-client v1.3.0 (reporter/report.ts,
//! reporter/usage.ts, reporter/merge.ts), not guessed:
//!   POST {SERVER_URL}/api/usage
//!   Authorization: Bearer <api key>          Content-Type: application/json
//!   { username, team, client_id, client_version, report_days,
//!     data: [ { date: "YYYY-MM-DD",
//!               modelBreakdowns: [ { modelName, inputTokens, outputTokens,
//!                                    cacheCreationTokens, cacheReadTokens, totalTokens,
//!                                    cost?, source } ] } ] }
//! The server's primary key is (username, date, model, client_id, source), so `client_id` must be
//! STABLE per machine or every re-derivation double-counts the overlapping days on the profile.
//! We derive it exactly as the reference client does — sha256(machine_id | username), first 32
//! hex chars — and then PIN it in the state file so a later `ioreg` failure can't mint a second id.
//!
//! Profile prose (`tools`, `projects`, `communities`, `about`, `hn_username`, `demo_video_url`)
//! is deliberately NOT sent. The reference client posts those from its `.env` on every run, so a
//! Sparkle report that included them as empty strings could blank a profile the user filled in
//! elsewhere. Omitting the keys leaves whatever the server already holds untouched.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::spend::UsageRecord;

/// tkmx's reporting API host. Matches `SERVER_URL`'s default in tkmx-client's reporter/report.ts
/// (the human-facing Builder Index lives at watchmepivot.com, which is NOT the API host —
/// posting there would 404). Overridable for dev via `TKMX_SERVER_URL`.
pub const DEFAULT_SERVER_URL: &str = "https://tokenmaxxing.odio.dev";

/// The `source` discriminator on every row we post. Part of the server's primary key, so it must
/// match what the reference client reports Claude Code usage under ("claude") or the same day's
/// tokens would land in a second, parallel row instead of merging.
const SOURCE: &str = "claude";

/// Sent as `client_version` so the operator can tell Sparkle-native reports apart from
/// tkmx-client's. Not a version bump surface — it carries the app version.
fn client_version() -> String {
    format!("sparkle-desktop/{}", env!("CARGO_PKG_VERSION"))
}

/// tkmx groups profiles by team; the reference client defaults to "default" when unset.
const DEFAULT_TEAM: &str = "default";

/// Keychain ACCOUNT for the tkmx API key. A distinct account under Sparkle's existing keychain
/// service — never the desktop-token or trial-device-token item. Read in-process via `keyring`
/// (like auth.rs / trial_remote.rs); the key never enters JS, a log line, or the payload.
const KEYCHAIN_USER: &str = "builder-index-api-key";

/// Default trailing window per report. Short on purpose: the server MERGES `data` rows by date,
/// so a small window is safe and cheap, and 7 days re-states the recent past on every cycle
/// (self-healing after an offline stretch) without re-uploading a month each time.
pub const DEFAULT_REPORT_DAYS: u32 = 7;
/// Cap on the caller-supplied window — a first sync may want more history, but not unbounded.
const MAX_REPORT_DAYS: u32 = 90;

/// Reporting cadence. Matches the community launchd reporter's 2h so a user running both doesn't
/// see wildly different freshness.
const REPORT_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);
/// Delay before the FIRST cycle. Startup must never wait on a transcript scan or a socket.
const FIRST_REPORT_DELAY: Duration = Duration::from_secs(5 * 60);
/// Bound the POST so an unreachable server can't park a blocking thread indefinitely (ureq has no
/// default request timeout — same reasoning as trial_remote.rs).
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// Spread of the per-cycle jitter, in seconds. Every Sparkle install waking on the same 2h
/// boundary would hand the leaderboard a synchronized thundering herd.
const JITTER_SPREAD_SECS: u64 = 15 * 60;

// ── persisted state ─────────────────────────────────────────────────────────────────────────

/// Everything the reporter remembers between launches EXCEPT the API key (keychain) and the
/// on/off switch (`[tools].builder_index` in config.toml).
///
/// Lives in its own JSON file rather than config.toml so the feature adds exactly ONE key to the
/// shared `[tools]` table — and so a hand-edited config can never silently un-consent or re-point
/// someone's `client_id`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct BuilderIndexState {
    /// The tokenmaxxing username reports are attributed to. Empty = not configured.
    pub username: String,
    /// Per-machine id, pinned on first successful derivation. See the module note on why it must
    /// never change for a given (machine, username).
    pub client_id: String,
    /// Epoch seconds the user answered the consent modal with "publish". `None` = never consented,
    /// which blocks reporting even if the toggle is somehow on.
    pub consented_at: Option<i64>,
    /// Epoch seconds of the last SUCCESSFUL post.
    pub last_report_at: Option<i64>,
    /// One-line outcome of the last cycle, surfaced under the Tools row. Never contains the key.
    pub last_status: Option<String>,
    /// Trailing window per report. 0 / absent means [`DEFAULT_REPORT_DAYS`].
    pub report_days: u32,
}

impl BuilderIndexState {
    fn window(&self) -> u32 {
        match self.report_days {
            0 => DEFAULT_REPORT_DAYS,
            n => n.clamp(1, MAX_REPORT_DAYS),
        }
    }
}

/// `<app_data>/builder-index.json`.
fn state_path(app_data: &Path) -> PathBuf {
    app_data.join("builder-index.json")
}

/// Serializes every read-modify-write of the state file.
///
/// Re-reading before a write narrows the window but does not close it: two cycles (the loop tick
/// and a "Report now") that both find an empty `client_id` can still both derive and both write,
/// and they disagree whenever exactly one `read_machine_id()` falls back to a random id — the
/// double-count failure the module header warns about. Holding this across the read AND the write
/// makes the sequence atomic within the process. (roborev 48167)
///
/// Process-wide, not per-path: there is exactly one app-data dir per process, and a global lock
/// held for two syscalls costs nothing.
fn state_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    // Poison-tolerant: a panic while holding it must not permanently wedge the reporter.
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Read the state file. A missing or unreadable/corrupt file degrades to the default (not
/// configured, not consented) — the fail-safe direction: we stop reporting, we never start.
pub fn load_state(app_data: &Path) -> BuilderIndexState {
    std::fs::read_to_string(state_path(app_data))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(app_data: &Path, state: &BuilderIndexState) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(state_path(app_data), text).map_err(|e| e.to_string())
}

// ── consent gate (pure) ─────────────────────────────────────────────────────────────────────

/// Why a cycle didn't post. Every variant is a REASON, not an error: a disabled or unconfigured
/// install is the normal state, and the loop keeps ticking quietly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// `[tools].builder_index` is off (the default).
    Disabled,
    /// The one-time consent modal has not been answered with "publish".
    NoConsent,
    /// No username stored.
    NoUsername,
    /// No API key in the keychain.
    NoApiKey,
    /// A key IS stored but can't be used as a header value (an old build, or another writer of the
    /// same item, stored one with an interior newline). Distinct from `NoApiKey` because "you
    /// haven't set one" and "the one you set is broken" need different fixes. (roborev 48168/48167)
    BadApiKey,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SkipReason::Disabled => "Builder Index is off",
            SkipReason::NoConsent => "waiting for consent",
            SkipReason::NoUsername => "no tokenmaxxing username set",
            SkipReason::NoApiKey => "no API key set",
            SkipReason::BadApiKey => "the stored API key is unusable — re-enter it",
        }
    }
}

/// The whole gate, as a pure function of the four inputs, so "off means off" is a unit test
/// rather than a claim about control flow buried in an async loop.
///
/// Order matters for the message the UI shows: the toggle is reported first, because an install
/// that never opted in should say so rather than nag for credentials it will never use.
pub fn consent_gate(
    enabled: bool,
    consented: bool,
    has_username: bool,
    has_api_key: bool,
) -> Result<(), SkipReason> {
    if !enabled {
        return Err(SkipReason::Disabled);
    }
    if !consented {
        return Err(SkipReason::NoConsent);
    }
    if !has_username {
        return Err(SkipReason::NoUsername);
    }
    if !has_api_key {
        return Err(SkipReason::NoApiKey);
    }
    Ok(())
}

/// The part of [`consent_gate`] that can be evaluated WITHOUT touching the keychain, so
/// `report_once_sync` can answer "off" / "no consent" / "no username" for free and only pay (and
/// risk a macOS auth prompt) for the key read once everything else has passed.
///
/// Delegates to [`consent_gate`] with `has_api_key = true` rather than restating the precedence.
/// Two copies of the ordering would let the modal's `blockedBy` message and the reason the loop
/// actually skipped drift apart silently. (roborev 48168/48167)
fn pre_key_gate(enabled: bool, state: &BuilderIndexState) -> Result<(), SkipReason> {
    consent_gate(
        enabled,
        state.consented_at.is_some(),
        !state.username.trim().is_empty(),
        true,
    )
}

// ── client id ───────────────────────────────────────────────────────────────────────────────

/// sha256(`machine_id` + "|" + `username`), first 32 hex chars — byte-for-byte the reference
/// client's `deriveClientId`, so a user migrating off tkmx-client keeps the same machine identity
/// and their existing rows keep merging instead of doubling.
pub fn derive_client_id(machine_id: &str, username: &str) -> String {
    let mut h = Sha256::new();
    h.update(machine_id.as_bytes());
    h.update(b"|");
    h.update(username.as_bytes());
    let digest = h.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..32].to_string()
}

/// This machine's stable hardware id, using the same source per OS as the reference client:
/// `IOPlatformUUID` on macOS, `/etc/machine-id` on Linux, `MachineGuid` on Windows.
/// `None` when it can't be read — the caller then falls back to a random id and PINS it.
fn read_machine_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        return extract_io_platform_uuid(&text);
    }
    #[cfg(target_os = "linux")]
    {
        for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(id) = std::fs::read_to_string(p) {
                let id = id.trim().to_string();
                if !id.is_empty() {
                    return Some(id);
                }
            }
        }
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        return extract_machine_guid(&text);
    }
    #[allow(unreachable_code)]
    None
}

/// Pull `IOPlatformUUID` out of `ioreg -rd1 -c IOPlatformExpertDevice` output. Split out from the
/// shell-out so the parse is testable without a Mac in the loop.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn extract_io_platform_uuid(ioreg_output: &str) -> Option<String> {
    for line in ioreg_output.lines() {
        // Per-line `continue`, never `?`: an early return on the first non-matching line would
        // make this find the UUID only when it happens to be the very first line of output.
        let Some(rest) = line.trim().strip_prefix("\"IOPlatformUUID\"") else { continue };
        // `"IOPlatformUUID" = "ABCD-..."` — take what's between the quotes after the `=`.
        let Some(eq) = rest.find('=') else { continue };
        let after = rest[eq + 1..].trim();
        let Some(inner) = after.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
            continue;
        };
        if !inner.is_empty() {
            return Some(inner.to_string());
        }
    }
    None
}

/// Pull `MachineGuid` out of `reg query …\Cryptography /v MachineGuid` output.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn extract_machine_guid(reg_output: &str) -> Option<String> {
    for line in reg_output.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() != Some("MachineGuid") {
            continue;
        }
        if parts.next() != Some("REG_SZ") {
            continue;
        }
        if let Some(v) = parts.next() {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// The pinned `client_id` for `username`, deriving + persisting one on first use.
///
/// Pinning is the point: the server keys rows on it, so re-deriving after a failed `ioreg` (which
/// would fall back to a random id) is exactly the double-counting failure the reference client's
/// `.env` warning is about.
fn ensure_client_id(app_data: &Path, state: &mut BuilderIndexState) -> String {
    if !state.client_id.is_empty() {
        return state.client_id.clone();
    }
    // Read AND write under the lock: re-reading alone only narrows the race (two cycles can both
    // see an empty pin, both derive, and disagree if exactly one read_machine_id() falls back to
    // random). (roborev 47460/48167)
    let _guard = state_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut fresh = load_state(app_data);
    if !fresh.client_id.is_empty() {
        state.client_id = fresh.client_id;
        return state.client_id.clone();
    }
    // Derive from the FRESH username, not the caller's snapshot. `builder_index_set_identity`
    // clears client_id on a rename precisely so the next cycle re-derives under the new name; an
    // in-flight cycle deriving from its stale username would pin sha256(machine|"old") next to
    // `username: "renamed"` — permanently attaching this machine's rows to the wrong profile,
    // which is the exact failure the clear-on-rename exists to prevent. (roborev 48168/48167)
    if !fresh.username.trim().is_empty() {
        state.username = fresh.username.clone();
    }
    let machine_id = read_machine_id().unwrap_or_else(random_machine_fallback);
    state.client_id = derive_client_id(&machine_id, state.username.trim());
    fresh.client_id = state.client_id.clone();
    let _ = save_state(app_data, &fresh);
    state.client_id.clone()
}

/// A one-shot random stand-in when the OS machine id is unreadable. Only ever used once, because
/// the derived id is pinned immediately afterwards.
fn random_machine_fallback() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

// ── wire payload ────────────────────────────────────────────────────────────────────────────

/// One (day, model) row. Field names are the EXACT camelCase keys tkmx-server reads — see
/// `ModelBreakdown` in tkmx-client's reporter/usage.ts. Renaming any of these silently drops the
/// counter server-side (the server reads by key; an unknown key is ignored, not rejected).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelBreakdown {
    #[serde(rename = "modelName")]
    pub model_name: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "cacheCreationTokens")]
    pub cache_creation_tokens: u64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: u64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    /// Estimated list-rate USD. OMITTED (not zero) for a model with no published price — a zero
    /// would read as "this was free" on the leaderboard rather than "we don't know".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Part of the server's primary key; always [`SOURCE`].
    pub source: String,
}

/// One calendar day's rows.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DailyUsage {
    /// `YYYY-MM-DD`, UTC.
    pub date: String,
    #[serde(rename = "modelBreakdowns")]
    pub model_breakdowns: Vec<ModelBreakdown>,
}

/// The POST body. See the module header for the full contract.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReportBody {
    pub username: String,
    pub team: String,
    pub client_id: String,
    pub client_version: String,
    pub report_days: u32,
    pub data: Vec<DailyUsage>,
}

// ── rollup (pure) ───────────────────────────────────────────────────────────────────────────

/// Roll records into the per-day, per-model rows the wire expects.
///
/// Contract, mirroring the Spend pane so the leaderboard and the pane can never disagree:
///   • the window is the `days` calendar days ending at `today`; anything outside is dropped
///     (including future-dated records from a clock-skewed synced transcript);
///   • a repeated message id is counted ONCE — resuming a session copies prior turns into a new
///     transcript, and without this a heavy resume user's leaderboard number is inflated;
///   • the window CLAMP is this function's own (`MAX_REPORT_DAYS` = 90, what the server accepts)
///     and is deliberately tighter than the pane's `MAX_WINDOW_DAYS` = 365. Totals agree with the
///     pane for any window ≤ 90, which is every window the reporter can ask for —
///     `BuilderIndexState::window` clamps to the same 90 before this is ever called;
///   • those first two rules are not reimplemented here: both come from `spend::dedupe_window`,
///     the same call `spend::aggregate_records` makes. This function used to keep the FIRST copy of
///     a repeated id while the pane kept the LAST, so the two surfaces could bucket the same turn
///     differently — a divergence a passing test suite would never show, because each module only
///     ever tested its own half;
///   • rows are summed per (date, model) — never concatenated — because the server's upsert would
///     otherwise see two rows colliding on the same primary key within one POST;
///   • days with no usage are OMITTED (unlike the pane's contiguous calendar): the server merges
///     `data` by date, so an empty row is pure noise;
///   • output order is deterministic (date asc, then model name) so two identical scans produce
///     byte-identical payloads.
///
/// KNOWN LIMIT, inherited from the scan: a turn whose transcript line carries no message id gets a
/// positional fallback key that includes its line ordinal, so the copy a resume writes into a new
/// transcript keys differently and is counted TWICE. The pane has the same blind spot, but here the
/// number is published — a heavy-resume user's leaderboard total reads high. Fixing it means a
/// resume-stable fallback key in `spend::parse_line`, not a second dedup rule here.
///
/// Takes BORROWED records (`WindowScan::records()` hands back the memo's blocks) so the reporter
/// never materializes a second copy of the scan.
///
/// Pure: no filesystem, no clock, no network. `today` is passed in.
pub fn rollup<'a>(
    records: impl Iterator<Item = &'a UsageRecord>,
    today: i64,
    days: u32,
) -> Vec<DailyUsage> {
    let window = days.clamp(1, MAX_REPORT_DAYS);
    let first_day = today - (window as i64 - 1);

    // (day, model) → accumulator. BTreeMap gives the deterministic (date, model) ordering for free.
    let mut buckets: std::collections::BTreeMap<(i64, String), ModelBreakdown> =
        std::collections::BTreeMap::new();

    for r in crate::spend::dedupe_window(records, first_day, today) {
        let entry = buckets
            .entry((r.day, r.model.clone()))
            .or_insert_with(|| ModelBreakdown {
                model_name: r.model.clone(),
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: 0,
                cost: None,
                source: SOURCE.to_string(),
            });
        entry.input_tokens = entry.input_tokens.saturating_add(r.input);
        entry.output_tokens = entry.output_tokens.saturating_add(r.output);
        entry.cache_creation_tokens = entry
            .cache_creation_tokens
            .saturating_add(crate::spend::record_cache_creation(r));
        entry.cache_read_tokens = entry.cache_read_tokens.saturating_add(r.cache_read);
        entry.total_tokens = entry
            .total_tokens
            .saturating_add(crate::spend::record_total_tokens(r));
        if let Some(c) = crate::spend::record_cost_usd(r) {
            entry.cost = Some(entry.cost.unwrap_or(0.0) + c);
        }
    }

    let mut out: Vec<DailyUsage> = Vec::new();
    for ((day, _model), row) in buckets {
        let date = crate::spend::epoch_day_label(day);
        match out.last_mut() {
            Some(d) if d.date == date => d.model_breakdowns.push(row),
            _ => out.push(DailyUsage { date, model_breakdowns: vec![row] }),
        }
    }
    out
}

/// The `last_status` line for a successful post. Pure so BOTH branches are testable — the PARTIAL
/// wording is the whole point of propagating `truncated`, and building it inline inside
/// `report_once_sync` left it unreachable from a test. (roborev 47904/47899)
pub fn posted_status(rows: usize, days: usize, truncated: bool) -> String {
    let base = format!("Reported {rows} row(s) across {days} day(s).");
    if truncated {
        // Say so out loud. "Reported N rows" over a capped scan is how a number ends up 84% low
        // and nobody notices.
        format!(
            "{base} PARTIAL — the transcript scan hit its file cap, so this understates your usage."
        )
    } else {
        base
    }
}

/// Total rows across every day — what the per-cycle log line reports.
pub fn row_count(data: &[DailyUsage]) -> usize {
    data.iter().map(|d| d.model_breakdowns.len()).sum()
}

// ── keychain ────────────────────────────────────────────────────────────────────────────────

fn entry() -> Result<keyring::Entry, String> {
    // Dev-suffixed keychain service in debug builds (mirrors auth.rs / trial_remote.rs).
    keyring::Entry::new(&crate::dev_identity::keychain_service(), KEYCHAIN_USER)
        .map_err(|e| e.to_string())
}

/// How many times the keychain has been reached for. Test-only: the module's headline property is
/// that a not-opted-in install never touches the keychain, and asserting the ORDER of statements in
/// `report_once_sync` is the only way to keep a later edit from quietly reintroducing an
/// unconditional read. (roborev 48168/48167)
#[cfg(test)]
static KEYCHAIN_READS: AtomicUsize = AtomicUsize::new(0);

/// The stored key, or a reason it can't be used.
///
/// Validated on READ as well as write: a key stored by an older build (or by any other writer of
/// the same keychain item) with an interior newline would otherwise malform the `Authorization`
/// header on every cycle forever, surfacing only as a generic transport error.
/// (roborev 47460/48168/48167)
fn read_api_key() -> Result<String, SkipReason> {
    #[cfg(test)]
    KEYCHAIN_READS.fetch_add(1, Ordering::SeqCst);
    let Some(k) = entry().ok().and_then(|e| e.get_password().ok()) else {
        return Err(SkipReason::NoApiKey);
    };
    let k = k.trim().to_string();
    if k.is_empty() {
        return Err(SkipReason::NoApiKey);
    }
    validate_api_key(&k).map_err(|_| SkipReason::BadApiKey)?;
    Ok(k)
}

/// Reject anything that can't be a header value BEFORE it reaches the keychain, so a bad paste
/// fails loudly in the settings dialog instead of turning into a confusing transport error every
/// two hours forever. (roborev 47460)
fn validate_api_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("the API key is empty".to_string());
    }
    if !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err(
            "that API key contains spaces, line breaks, or non-ASCII characters — check for a \
             stray newline in the paste"
                .to_string(),
        );
    }
    Ok(())
}

fn write_api_key(key: &str) -> Result<(), String> {
    validate_api_key(key)?;
    entry()?.set_password(key).map_err(|e| e.to_string())
}

fn delete_api_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Already absent is the state the caller wanted.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── reporting ───────────────────────────────────────────────────────────────────────────────

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The reporting host: [`DEFAULT_SERVER_URL`] unless `TKMX_SERVER_URL` names an HTTPS host.
///
/// The override is scheme-checked, not taken as-is. This request carries
/// `Authorization: Bearer <api key>`, so anything that can seed Sparkle's environment (a shell
/// profile, a stray launch agent) could otherwise redirect the key to an arbitrary host over
/// plaintext HTTP. An override that isn't `https://` is refused and logged rather than honored.
/// (roborev 47458)
fn server_url() -> String {
    let raw = std::env::var("TKMX_SERVER_URL").ok();
    resolve_server_url(raw.as_deref(), crate::dev_identity::is_dev())
}

/// The override decision, as a pure function of the raw env value and whether this is a dev build.
/// Split out so the refusal paths are testable without mutating the process environment (which is
/// global state shared with every other test in the binary). (roborev 47904/47899)
fn resolve_server_url(raw: Option<&str>, is_dev: bool) -> String {
    let Some(raw) = raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
        return DEFAULT_SERVER_URL.to_string();
    };
    // DEV BUILDS ONLY. A scheme check alone narrows the exfiltration primitive to TLS rather than
    // closing it: `TKMX_SERVER_URL=https://attacker.example` would still receive
    // `Authorization: Bearer <api key>` every cycle. A shipped build has no legitimate reason to
    // report anywhere but the real host, so the override simply doesn't exist there.
    // (roborev 47460/47904/47899)
    if !is_dev {
        tracing::warn!(
            "builder index: ignoring TKMX_SERVER_URL — the override is dev-builds-only, because \
             the request carries a bearer token"
        );
        return DEFAULT_SERVER_URL.to_string();
    }
    if is_safe_override(&raw) {
        tracing::info!(host = %raw, "builder index: using TKMX_SERVER_URL override");
        return raw;
    }
    tracing::warn!(
        value = %raw,
        "builder index: ignoring TKMX_SERVER_URL — only https:// (or a localhost dev server) is \
         accepted, because the request carries a bearer token"
    );
    DEFAULT_SERVER_URL.to_string()
}

/// An override is acceptable if it's HTTPS, or plain HTTP pointed at the loopback interface (the
/// only case where a cleartext bearer never leaves the machine).
fn is_safe_override(raw: &str) -> bool {
    if let Some(rest) = raw.strip_prefix("https://") {
        return !rest.is_empty();
    }
    if let Some(rest) = raw.strip_prefix("http://") {
        // A bracketed IPv6 host must be peeled BEFORE splitting on ':', or `[::1]` splits into a
        // bare "[" and the documented loopback case becomes unreachable. (roborev 47899)
        if let Some(after) = rest.strip_prefix('[') {
            return matches!(after.split(']').next(), Some("::1"));
        }
        let host = rest.split(['/', ':']).next().unwrap_or("");
        return host == "localhost" || host == "127.0.0.1";
    }
    false
}

/// What one cycle did. `Posted` carries the row count so the caller can log/show it.
#[derive(Clone, Debug, PartialEq)]
pub enum ReportOutcome {
    /// `truncated` = the transcript scan hit its file cap, so these numbers UNDERSTATE reality.
    /// It rides on the outcome (not just `last_status`) because the modal renders the fresh
    /// message and suppresses `last_status` — without this the warning existed only in the log,
    /// which is not "saying so out loud". (roborev 47899)
    Posted { rows: usize, days: usize, truncated: bool },
    Skipped(SkipReason),
}

/// Run one reporting cycle: gate → scan → roll up → POST.
///
/// Blocking (filesystem + network); callers wrap it in `spawn_blocking`. Returns `Err` only for a
/// real failure to report (offline, auth rejected, malformed response) — a gate miss is `Ok`.
fn report_once_sync(app_data: PathBuf, enabled: bool) -> Result<ReportOutcome, String> {
    let mut state = load_state(&app_data);
    // The keychain read is LAST and lazy, behind the cheap gates. An unsigned/adhoc dev binary
    // touching a keychain item owned by the signed app pops a macOS authorization prompt (see
    // dev_identity's header), so a default-off install must never reach for it — being prompted
    // every 2h by a feature you never opted into is exactly the opposite of inert. (roborev 47460)
    if let Err(reason) = pre_key_gate(enabled, &state) {
        return Ok(ReportOutcome::Skipped(reason));
    }
    let api_key = match read_api_key() {
        Ok(k) => k,
        Err(reason) => return Ok(ReportOutcome::Skipped(reason)),
    };

    let window = state.window();
    let client_id = ensure_client_id(&app_data, &mut state);
    let scan = crate::spend::load_window_records(Some(&app_data), window);
    let data = rollup(scan.records(), scan.today, window);
    let rows = row_count(&data);
    let days = data.len();
    if scan.truncated {
        tracing::warn!(
            rows,
            days,
            "builder index: transcript scan hit its file cap — this report is PARTIAL"
        );
    }

    let body = ReportBody {
        // `state.username` may have been refreshed by `ensure_client_id` above; using the caller's
        // original snapshot would post the OLD name alongside a freshly-derived new-name id.
        username: state.username.trim().to_string(),
        team: DEFAULT_TEAM.to_string(),
        client_id,
        client_version: client_version(),
        report_days: window,
        data,
    };
    // An empty `data: []` is still POSTed rather than short-circuited. That matches the reference
    // client (which falls through on an inactive day on purpose) and it is the only signal the
    // server gets that this machine is alive and still reporting — a silent gap and a genuinely
    // idle week would otherwise be indistinguishable on the profile.
    let payload = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let url = format!("{}/api/usage", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {api_key}"))
        .send_string(&payload);

    match resp {
        Ok(r) => {
            // A 200 is not proof of success: tkmx-server can answer 200 with an error payload
            // (unknown user, frozen profile). Recording "Reported N rows" then would send the user
            // to a profile that never updates, with no diagnostic. (roborev 47458)
            let body = r.into_string().unwrap_or_else(|e| {
                // A truncated/aborted body used to become "" ⇒ success. Say so instead of
                // silently recording a report we could not confirm landed. (roborev 47904)
                tracing::warn!(error = %e, "builder index: could not read the server response");
                String::new()
            });
            if let Some(err) = server_side_error(&body) {
                let msg = format!("server accepted the request but reported: {err}");
                record_outcome(&app_data, None, format!("Last report failed — {msg}."));
                return Err(msg);
            }
            record_outcome(
                &app_data,
                Some(now_secs()),
                posted_status(rows, days, scan.truncated),
            );
            Ok(ReportOutcome::Posted { rows, days, truncated: scan.truncated })
        }
        Err(e) => {
            // The error string can carry the URL but never the key (it lives only in a header we
            // build locally and ureq does not echo).
            let msg = match &e {
                ureq::Error::Status(code, _) => format!("server returned {code}"),
                ureq::Error::Transport(t) => format!("network error: {t}"),
            };
            record_outcome(&app_data, None, format!("Last report failed — {msg}."));
            Err(msg)
        }
    }
}

/// An explicit failure reported inside a 2xx body, or `None` when the response looks fine.
/// Non-JSON and unrecognized shapes are treated as success — the server's happy-path body is not
/// part of any documented contract, so we only act on an UNAMBIGUOUS failure marker.
fn server_side_error(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    // Prefer a human string wherever it lives: `error` as a string, `error.message`, or `message`.
    // Recognizing only two shapes let `{"ok":false}` and `{"error":{"message":…}}` fall through as
    // success — the "profile never updates, no diagnostic" outcome this exists to catch.
    // (roborev 47904)
    let detail = || {
        for key in ["error", "message"] {
            match v.get(key) {
                Some(serde_json::Value::String(m)) if !m.is_empty() => return m.clone(),
                Some(obj @ serde_json::Value::Object(_)) => {
                    return match obj.get("message").and_then(serde_json::Value::as_str) {
                        Some(m) if !m.is_empty() => m.to_string(),
                        _ => obj.to_string(),
                    };
                }
                _ => {}
            }
        }
        "the server reported a failure".to_string()
    };
    for key in ["success", "ok"] {
        if v.get(key).and_then(serde_json::Value::as_bool) == Some(false) {
            return Some(detail());
        }
    }
    if v.get("status").and_then(serde_json::Value::as_str) == Some("error") {
        return Some(detail());
    }
    match v.get("error") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(e)) if e.is_empty() => None,
        Some(_) => Some(detail()),
    }
}

/// Write back ONLY the fields the reporter owns, re-reading state immediately beforehand.
///
/// The naive read-modify-write held a whole `BuilderIndexState` across a filesystem scan and a
/// 20-second POST, so a "Turn off and forget" landing in that window was silently undone — the
/// reporter restored the username, the pinned `client_id`, and (worst) `consented_at`, meaning a
/// withdrawn consent came back on its own. Re-loading here narrows the window to two adjacent
/// syscalls and, more importantly, means a concurrent write to the user-owned fields survives:
/// we never copy them forward from our stale snapshot. (roborev 47458)
fn record_outcome(app_data: &Path, reported_at: Option<i64>, status: String) {
    let _guard = state_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut fresh = load_state(app_data);
    // Withdrawn mid-cycle ⇒ write NOTHING. `builder_index_forget` is documented as complete
    // erasure, and re-creating the file with "Reported 12 rows…" would leave the user who just
    // asked to be forgotten looking at a bookkeeping record of a report tied to the identity they
    // deleted. Nothing the reporter owns is meaningful without consent. (roborev 47904/47899)
    if fresh.consented_at.is_none() {
        return;
    }
    if let Some(t) = reported_at {
        fresh.last_report_at = Some(t);
    }
    fresh.last_status = Some(status);
    let _ = save_state(app_data, &fresh);
}

/// Random per-cycle jitter in [0, [`JITTER_SPREAD_SECS`]).
///
/// Actually random, not clock-derived: a function of the wall clock gives every install whose
/// cycle lands in the same second the SAME offset, which is the thundering herd this exists to
/// prevent rather than a fix for it. (roborev 47460)
fn jitter_secs() -> u64 {
    use rand::Rng;
    rand::thread_rng().gen_range(0..JITTER_SPREAD_SECS)
}

/// Guard against two reporter loops (a second `setup` pass, a re-entrant spawn) racing the same
/// state file and posting twice per cycle.
static LOOP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Start the background reporter. Idempotent — a second call is a no-op.
///
/// Runs on its own OS thread rather than the async runtime: every step of a cycle is blocking
/// (a transcript scan, then a socket), so this would be a `spawn_blocking` per tick anyway, and a
/// dedicated thread that spends 2 hours asleep is cheaper than parking a runtime worker.
///
/// Never blocks startup — the first cycle is [`FIRST_REPORT_DELAY`] out. Offline is not an error
/// state: the cycle logs a warning and the next tick retries, and because the window is a trailing
/// 7 days, a machine that was offline for a week catches up in a single post.
///
/// The enable check is re-read from the live config EVERY cycle, not captured at spawn: a user who
/// turns the toggle off mid-session must stop being reported without restarting the app.
pub fn spawn_reporter(app: tauri::AppHandle) {
    if LOOP_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_REPORT_DELAY);
        loop {
            match app_data_dir(&app) {
                Ok(dir) => {
                    let enabled = crate::config::current_effective().config.tools.builder_index;
                    match report_once_sync(dir, enabled) {
                        Ok(ReportOutcome::Posted { rows, days, truncated }) => tracing::info!(
                            rows,
                            days,
                            truncated,
                            "builder index: reported daily token totals"
                        ),
                        Ok(ReportOutcome::Skipped(reason)) => {
                            tracing::debug!(reason = reason.as_str(), "builder index: cycle skipped")
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "builder index: report failed (will retry)")
                        }
                    }
                }
                Err(e) => tracing::warn!(error = %e, "builder index: no app data dir; skipping"),
            }
            std::thread::sleep(REPORT_INTERVAL + Duration::from_secs(jitter_secs()));
        }
    });
}

/// The app-data root, DEV-SUFFIXED in debug builds.
///
/// Must go through `dev_identity` for the same reason the keychain entry does: the two halves of
/// the gate have to agree. Using the raw `app_data_dir()` here while the API key comes from the
/// `-dev` keychain service means a debug run reads and WRITES the release install's reporter state
/// (inheriting consent it never asked for, re-pinning its `client_id`) and scans
/// `ai.sparkle.desktop/accounts/` while dev account stores live under `…-dev/accounts/` — which is
/// the exact multi-account blind spot this feature exists to close. (roborev 47458)
fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::dev_identity::app_data_dir(app)
}

// ── tauri commands ──────────────────────────────────────────────────────────────────────────

/// What the settings surface renders. Deliberately reports only WHETHER a key is stored.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderIndexStatus {
    pub enabled: bool,
    pub username: String,
    /// True when an API key is in the keychain. The key itself is never returned to JS.
    pub has_api_key: bool,
    pub consented: bool,
    pub client_id: String,
    pub report_days: u32,
    pub last_report_at: Option<i64>,
    pub last_status: Option<String>,
    /// `None` when a report would go out; otherwise why it wouldn't.
    pub blocked_by: Option<String>,
    pub server_url: String,
}

/// Current reporter status for the Tools row + settings modal.
#[tauri::command]
pub async fn builder_index_status(app: tauri::AppHandle) -> Result<BuilderIndexStatus, String> {
    let app_data = app_data_dir(&app)?;
    let enabled = crate::config::current_effective().config.tools.builder_index;
    tauri::async_runtime::spawn_blocking(move || {
        let state = load_state(&app_data);
        let consented = state.consented_at.is_some();
        // Same rule as the loop: an install that never opted in must not reach for the keychain
        // just because the settings pane was opened. On an unsigned dev build that read can pop
        // the macOS authorization prompt dev_identity warns about, and the "never touches the
        // keychain" invariant has to hold on EVERY path, not only the background one.
        // (roborev 48167)
        let key = if enabled || consented { read_api_key() } else { Err(SkipReason::NoApiKey) };
        let has_api_key = key.is_ok();
        let blocked_by = pre_key_gate(enabled, &state)
            .and(key.map(|_| ()))
            .err()
            .map(|r| r.as_str().to_string());
        BuilderIndexStatus {
            enabled,
            username: state.username.clone(),
            has_api_key,
            consented,
            client_id: state.client_id.clone(),
            report_days: state.window(),
            last_report_at: state.last_report_at,
            last_status: state.last_status.clone(),
            blocked_by,
            server_url: server_url(),
        }
    })
    .await
    .map_err(|e| format!("builder_index_status task failed: {e}"))
}

/// Store the tokenmaxxing username + API key and RECORD CONSENT. This is the write the consent
/// modal's confirm button makes — one call, so consent and credentials can't get out of step.
///
/// The key goes straight to the keychain and is never echoed back, logged, or written to disk.
/// An empty `api_key` keeps whatever key is already stored (so the modal can be re-opened to
/// change just the username without re-typing it).
#[tauri::command]
pub async fn builder_index_set_identity(
    app: tauri::AppHandle,
    username: String,
    api_key: String,
    consent: bool,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let username = username.trim().to_string();
        if username.is_empty() {
            return Err("a tokenmaxxing username is required".to_string());
        }
        if !api_key.trim().is_empty() {
            write_api_key(api_key.trim())?;
        }
        let mut state = load_state(&app_data);
        // Changing the username changes the derived client_id, so clear the pin and let the next
        // report re-derive it — reporting the OLD id under a new username would attach this
        // machine's rows to the wrong profile.
        if state.username != username {
            state.client_id = String::new();
        }
        state.username = username;
        if consent && state.consented_at.is_none() {
            state.consented_at = Some(now_secs());
        }
        save_state(&app_data, &state)
    })
    .await
    .map_err(|e| format!("builder_index_set_identity task failed: {e}"))?
}

/// Forget everything: consent, username, pinned client id, and the stored API key. The `[tools]`
/// toggle is the UI's business; this is the "and delete my credentials" half of turning it off.
#[tauri::command]
pub async fn builder_index_forget(app: tauri::AppHandle) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_api_key()?;
        save_state(&app_data, &BuilderIndexState::default())
    })
    .await
    .map_err(|e| format!("builder_index_forget task failed: {e}"))?
}

/// One-shot report, so the user can verify the integration immediately instead of waiting for the
/// next 2h tick. Same gate, same payload, same code path as the background loop.
#[tauri::command]
pub async fn builder_index_report_now(app: tauri::AppHandle) -> Result<ReportOutcome, String> {
    report_now(app).await
}

/// Shared body of the one-shot command and the loop's cycle.
async fn report_now(app: tauri::AppHandle) -> Result<ReportOutcome, String> {
    let app_data = app_data_dir(&app)?;
    let enabled = crate::config::current_effective().config.tools.builder_index;
    tauri::async_runtime::spawn_blocking(move || report_once_sync(app_data, enabled))
        .await
        .map_err(|e| format!("builder_index report task failed: {e}"))?
}

// `ReportOutcome` crosses the IPC boundary as `{"status":"posted","rows":12,"days":7}` /
// `{"status":"skipped","reason":"Builder Index is off"}` — a tagged shape the frontend can switch
// on without pattern-matching a bare string.
impl Serialize for ReportOutcome {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(None)?;
        match self {
            ReportOutcome::Posted { rows, days, truncated } => {
                m.serialize_entry("status", "posted")?;
                m.serialize_entry("rows", rows)?;
                m.serialize_entry("days", days)?;
                m.serialize_entry("truncated", truncated)?;
            }
            ReportOutcome::Skipped(reason) => {
                m.serialize_entry("status", "skipped")?;
                m.serialize_entry("reason", reason.as_str())?;
            }
        }
        m.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-07-24 as an epoch day, matching spend.rs's test anchor.
    fn today() -> i64 {
        // days_from_civil(2026, 7, 24) — computed here rather than importing spend's private
        // helper, and asserted against the label round-trip below.
        20_658
    }

    fn rec(day_offset: i64, model: &str, id: &str, input: u64, output: u64) -> UsageRecord {
        UsageRecord {
            id: id.into(),
            day: today() - day_offset,
            model: model.into(),
            session: "session-secret".into(),
            project: "a-private-project-name".into(),
            input,
            output,
            cache_5m: 0,
            cache_1h: 0,
            cache_read: 0,
        }
    }

    #[test]
    fn the_test_anchor_is_the_date_we_think_it_is() {
        assert_eq!(crate::spend::epoch_day_label(today()), "2026-07-24");
    }

    // ── rollup ───────────────────────────────────────────────────────────────────────────

    #[test]
    fn rollup_sums_one_row_per_day_and_model() {
        let recs = [
            rec(0, "claude-opus-5", "a", 100, 10),
            rec(0, "claude-opus-5", "b", 50, 5),
            rec(1, "claude-opus-5", "c", 7, 1),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 2, "two distinct days");
        // Oldest first.
        assert_eq!(data[0].date, "2026-07-23");
        assert_eq!(data[1].date, "2026-07-24");
        let m = &data[1].model_breakdowns[0];
        assert_eq!(m.model_name, "claude-opus-5");
        assert_eq!((m.input_tokens, m.output_tokens), (150, 15));
        assert_eq!(m.total_tokens, 165);
        assert_eq!(m.source, "claude");
    }

    #[test]
    fn rollup_keeps_multi_model_days_as_separate_rows_ordered_by_model() {
        // A day with three models must post three rows, not one merged blob — the server's key is
        // (user, date, model, client_id, source), so collapsing them would lose two thirds of it.
        let recs = [
            rec(0, "claude-sonnet-5", "s", 300, 30),
            rec(0, "claude-opus-5", "o", 100, 10),
            rec(0, "claude-haiku-4-5", "h", 20, 2),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 1);
        let names: Vec<&str> = data[0]
            .model_breakdowns
            .iter()
            .map(|m| m.model_name.as_str())
            .collect();
        assert_eq!(names, vec!["claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"]);
    }

    #[test]
    fn rollup_dedupes_repeated_message_ids() {
        // Resuming a session copies prior turns into a new transcript. Counting the copy would
        // inflate the public leaderboard number — the exact kind of error that discredits it.
        let recs = [
            rec(0, "claude-opus-5", "msg_1", 100, 0),
            rec(0, "claude-opus-5", "msg_1", 100, 0),
            rec(0, "claude-opus-5", "msg_2", 50, 0),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data[0].model_breakdowns[0].input_tokens, 150);
    }

    #[test]
    fn rollup_keeps_the_last_copy_of_a_repeated_id_like_the_pane_does() {
        // `load_window_records` hands records oldest-file-first, so the LAST copy of a repeated id
        // is the one the resume wrote — and the one the Spend pane attributes. Keeping the first
        // copy here (what this did before `dedupe_window` was shared) published a different number
        // than the pane showed whenever the copies differed at all.
        let recs = [
            rec(0, "claude-opus-5", "msg_1", 100, 0),
            rec(0, "claude-sonnet-5", "msg_1", 400, 0),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].model_breakdowns.len(), 1, "one turn, one row");
        let m = &data[0].model_breakdowns[0];
        assert_eq!(m.model_name, "claude-sonnet-5");
        assert_eq!(m.input_tokens, 400);
    }

    #[test]
    fn rollup_totals_match_the_spend_panes_totals_over_the_same_records() {
        // The "they can never disagree" invariant, asserted rather than assumed — on EVERY token
        // field and on cost, since the two accumulators map them independently and a mismapped
        // cache field is exactly the drift a totals-only check would miss. The fixture is built to
        // break dedupe/window drift too: a repeated id whose copies carry different counts, plus
        // an out-of-window record both sides must drop. Checked at both ends of the window range
        // the reporter can ask for (its own clamp is MAX_REPORT_DAYS, which the pane also accepts).
        let cached = |day_offset: i64, model: &str, id: &str, input: u64, c5: u64, c1h: u64, cr: u64| {
            UsageRecord {
                cache_5m: c5,
                cache_1h: c1h,
                cache_read: cr,
                ..rec(day_offset, model, id, input, 7)
            }
        };
        // The two msg_2 copies differ in INPUT as well as cache fields, so the absolute assertion
        // below can tell first-wins from last-wins. With identical inputs it could not.
        let recs = [
            cached(0, "claude-opus-5", "msg_1", 100, 11, 22, 33),
            cached(1, "claude-sonnet-5", "msg_2", 30, 1, 2, 3),
            cached(1, "claude-sonnet-5", "msg_2", 90, 4, 5, 6), // resume copy: the one counted
            cached(200, "claude-opus-5", "ancient", 100, 7, 8, 9), // outside every window here
            rec(0, "totally-unknown-model", "unpriced", 1_000, 0),
        ];

        for days in [7u32, MAX_REPORT_DAYS] {
            let pane = crate::spend::aggregate_records(recs.iter(), today(), days);
            let wire = rollup(recs.iter(), today(), days);
            let rows = || wire.iter().flat_map(|d| d.model_breakdowns.iter());
            let sum = |f: fn(&ModelBreakdown) -> u64| rows().map(f).sum::<u64>();

            assert_eq!(sum(|m| m.input_tokens), pane.totals.tokens.input, "{days}d input");
            assert_eq!(sum(|m| m.output_tokens), pane.totals.tokens.output, "{days}d output");
            assert_eq!(
                sum(|m| m.cache_creation_tokens),
                pane.totals.tokens.cache_creation,
                "{days}d cache creation"
            );
            assert_eq!(sum(|m| m.cache_read_tokens), pane.totals.tokens.cache_read, "{days}d cache read");
            assert_eq!(sum(|m| m.total_tokens), pane.totals.tokens.total, "{days}d total");

            let wire_cost: f64 = rows().filter_map(|m| m.cost).sum();
            assert!(
                (wire_cost - pane.totals.estimated_cost_usd).abs() < 1e-9,
                "{days}d cost: {wire_cost} vs {}",
                pane.totals.estimated_cost_usd
            );
            // The unpriced model contributes tokens to both and cost to neither.
            assert!(rows().any(|m| m.model_name == "totally-unknown-model" && m.cost.is_none()));
            assert_eq!(pane.unknown_models, vec!["totally-unknown-model".to_string()]);
        }

        let wire_input: u64 = rollup(recs.iter(), today(), 7)
            .iter()
            .flat_map(|d| d.model_breakdowns.iter())
            .map(|m| m.input_tokens)
            .sum();
        assert_eq!(
            wire_input, 1_190,
            "100 + 90 (the LAST copy of msg_2, not the 30) + 1000 unpriced; `ancient` is out of window"
        );
    }

    #[test]
    fn rollup_windows_out_old_and_future_records() {
        let recs = [
            rec(0, "claude-opus-5", "in", 10, 0),
            rec(30, "claude-opus-5", "old", 999, 0),
            // Clock skew on a synced transcript must not create a row dated after today.
            rec(-2, "claude-opus-5", "future", 500, 0),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].date, "2026-07-24");
        assert_eq!(data[0].model_breakdowns[0].input_tokens, 10);
    }

    #[test]
    fn rollup_omits_idle_days_entirely() {
        // Unlike the Spend pane's contiguous calendar: the server merges `data` by date, so a
        // zero row is noise. One record in a 7-day window ⇒ exactly one day posted.
        let data = rollup([rec(3, "claude-opus-5", "a", 1, 1)].iter(), today(), 7);
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].date, "2026-07-21");
        assert!(rollup([].iter(), today(), 7).is_empty());
    }

    #[test]
    fn rollup_carries_cost_only_for_priced_models() {
        let recs = [
            rec(0, "claude-opus-5", "priced", 1_000_000, 0),
            rec(0, "totally-unknown-model", "unpriced", 1_000_000, 0),
        ];
        let data = rollup(recs.iter(), today(), 7);
        let by_name = |n: &str| {
            data[0]
                .model_breakdowns
                .iter()
                .find(|m| m.model_name == n)
                .unwrap()
        };
        // $5/M input for opus-5.
        assert!((by_name("claude-opus-5").cost.unwrap() - 5.0).abs() < 1e-9);
        // Unknown price ⇒ NO cost key at all (a 0.0 would read as "free").
        assert_eq!(by_name("totally-unknown-model").cost, None);
        assert_eq!(by_name("totally-unknown-model").total_tokens, 1_000_000);
    }

    #[test]
    fn rollup_counts_cache_tokens_in_the_right_buckets() {
        let r = UsageRecord {
            id: "c".into(),
            day: today(),
            model: "claude-opus-5".into(),
            session: "s".into(),
            project: "p".into(),
            input: 1,
            output: 2,
            cache_5m: 40,
            cache_1h: 60,
            cache_read: 500,
        };
        let data = rollup([r].iter(), today(), 7);
        let m = &data[0].model_breakdowns[0];
        // The two TTL buckets sum into the single cacheCreationTokens field the wire has.
        assert_eq!(m.cache_creation_tokens, 100);
        assert_eq!(m.cache_read_tokens, 500);
        assert_eq!(m.total_tokens, 1 + 2 + 100 + 500);
    }

    #[test]
    fn rollup_is_deterministic_for_the_same_input() {
        let recs = [
            rec(2, "claude-sonnet-5", "a", 1, 1),
            rec(0, "claude-opus-5", "b", 1, 1),
            rec(2, "claude-opus-5", "c", 1, 1),
        ];
        let a = serde_json::to_string(&rollup(recs.iter(), today(), 7)).unwrap();
        let b = serde_json::to_string(&rollup(recs.iter(), today(), 7)).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn row_count_counts_every_model_row_not_days() {
        let recs = [
            rec(0, "claude-opus-5", "a", 1, 1),
            rec(0, "claude-sonnet-5", "b", 1, 1),
            rec(1, "claude-opus-5", "c", 1, 1),
        ];
        let data = rollup(recs.iter(), today(), 7);
        assert_eq!(data.len(), 2);
        assert_eq!(row_count(&data), 3);
    }

    // ── payload shape ────────────────────────────────────────────────────────────────────

    #[test]
    fn payload_uses_the_exact_keys_the_tkmx_server_reads() {
        // Locked against tkmx-client v1.3.0 (reporter/report.ts ReportBody, reporter/usage.ts
        // ModelBreakdown). A rename here is invisible at runtime — the server ignores unknown
        // keys — so this test is the only thing standing between a typo and a silently empty
        // profile.
        let body = ReportBody {
            username: "someone".into(),
            team: "default".into(),
            client_id: "abc123".into(),
            client_version: "sparkle-desktop/0.0.0".into(),
            report_days: 7,
            data: rollup([rec(0, "claude-opus-5", "a", 100, 10)].iter(), today(), 7),
        };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&body).unwrap()).unwrap();

        let mut top: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        top.sort();
        assert_eq!(
            top,
            vec!["client_id", "client_version", "data", "report_days", "team", "username"]
        );

        let day = &v["data"][0];
        let mut day_keys: Vec<&str> = day.as_object().unwrap().keys().map(String::as_str).collect();
        day_keys.sort();
        assert_eq!(day_keys, vec!["date", "modelBreakdowns"]);
        assert_eq!(day["date"], "2026-07-24");

        let m = &day["modelBreakdowns"][0];
        let mut m_keys: Vec<&str> = m.as_object().unwrap().keys().map(String::as_str).collect();
        m_keys.sort();
        assert_eq!(
            m_keys,
            vec![
                "cacheCreationTokens",
                "cacheReadTokens",
                "cost",
                "inputTokens",
                "modelName",
                "outputTokens",
                "source",
                "totalTokens",
            ]
        );
        assert_eq!(m["modelName"], "claude-opus-5");
        assert_eq!(m["inputTokens"], 100);
        assert_eq!(m["outputTokens"], 10);
        assert_eq!(m["totalTokens"], 110);
        assert_eq!(m["source"], "claude");
    }

    #[test]
    fn payload_never_carries_paths_projects_sessions_or_prompts() {
        // The privacy promise, asserted rather than described. The fixture records deliberately
        // carry a project label and a session id; neither may appear anywhere in the JSON.
        let data = rollup(
            [
                rec(0, "claude-opus-5", "a", 100, 10),
                rec(1, "claude-sonnet-5", "b", 5, 5),
            ]
            .iter(),
            today(),
            7,
        );
        let body = ReportBody {
            username: "someone".into(),
            team: "default".into(),
            client_id: "abc123".into(),
            client_version: client_version(),
            report_days: 7,
            data: data.clone(),
        };
        let json = serde_json::to_string(&body).unwrap();
        assert!(!json.contains("a-private-project-name"), "{json}");
        assert!(!json.contains("session-secret"), "{json}");
        // No path separators in the usage rows at all. (Checked on `data` rather than the whole
        // body because `client_version` is legitimately "sparkle-desktop/<version>".)
        let rows_json = serde_json::to_string(&data).unwrap();
        assert!(!rows_json.contains('/'), "no path separators in the rows: {rows_json}");
    }

    #[test]
    fn profile_prose_fields_are_omitted_not_blanked() {
        // Sending `tools: ""` / `about: ""` the way the reference client does would BLANK a
        // profile the user filled in from tkmx-client. Omitting the keys leaves them alone.
        let body = ReportBody {
            username: "someone".into(),
            team: "default".into(),
            client_id: "abc".into(),
            client_version: "v".into(),
            report_days: 7,
            data: vec![],
        };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&body).unwrap()).unwrap();
        for k in ["tools", "projects", "communities", "about", "hn_username", "demo_video_url"] {
            assert!(v.get(k).is_none(), "{k} must not be sent");
        }
    }

    // ── consent gate ─────────────────────────────────────────────────────────────────────

    #[test]
    fn a_disabled_toggle_blocks_reporting_even_when_fully_configured() {
        // The headline guarantee: off means no network, whatever else is stored.
        assert_eq!(consent_gate(false, true, true, true), Err(SkipReason::Disabled));
        assert_eq!(consent_gate(false, false, false, false), Err(SkipReason::Disabled));
    }

    #[test]
    fn consent_is_required_even_when_enabled_and_configured() {
        assert_eq!(consent_gate(true, false, true, true), Err(SkipReason::NoConsent));
    }

    #[test]
    fn missing_credentials_block_reporting() {
        assert_eq!(consent_gate(true, true, false, true), Err(SkipReason::NoUsername));
        assert_eq!(consent_gate(true, true, true, false), Err(SkipReason::NoApiKey));
    }

    #[test]
    fn the_gate_opens_only_when_all_four_conditions_hold() {
        assert_eq!(consent_gate(true, true, true, true), Ok(()));
    }

    #[test]
    fn a_gated_cycle_never_reaches_for_the_keychain() {
        // The commit's headline property, pinned about `report_once_sync` rather than about the
        // pure helper's shape — otherwise a later edit that precomputes `has_api_key` above the
        // gate silently reintroduces the macOS auth prompt for a never-opted-in install, and no
        // test notices. (roborev 48168/48167)
        let tmp = tempfile::tempdir().unwrap();
        let before = KEYCHAIN_READS.load(Ordering::SeqCst);

        // Disabled.
        report_once_sync(tmp.path().to_path_buf(), false).unwrap();
        // Enabled, but never consented.
        save_state(
            tmp.path(),
            &BuilderIndexState { username: "sam".into(), ..Default::default() },
        )
        .unwrap();
        report_once_sync(tmp.path().to_path_buf(), true).unwrap();
        // Consented, but no username.
        save_state(
            tmp.path(),
            &BuilderIndexState { consented_at: Some(1), ..Default::default() },
        )
        .unwrap();
        report_once_sync(tmp.path().to_path_buf(), true).unwrap();

        assert_eq!(
            KEYCHAIN_READS.load(Ordering::SeqCst),
            before,
            "a gated cycle must not read the keychain"
        );
    }

    #[test]
    fn a_gated_cycle_skips_without_touching_the_network() {
        // report_once_sync with `enabled = false` must return Skipped before it can scan or POST.
        // (There is no server in a unit test, so a POST attempt would surface as an Err.)
        let tmp = tempfile::tempdir().unwrap();
        let out = report_once_sync(tmp.path().to_path_buf(), false).unwrap();
        assert_eq!(out, ReportOutcome::Skipped(SkipReason::Disabled));
        // ...and it wrote no state file, so a disabled install leaves no reporting footprint.
        assert!(!tmp.path().join("builder-index.json").exists());
    }

    #[test]
    fn an_enabled_but_unconsented_cycle_also_skips() {
        let tmp = tempfile::tempdir().unwrap();
        let state = BuilderIndexState {
            username: "someone".into(),
            ..Default::default()
        };
        save_state(tmp.path(), &state).unwrap();
        let out = report_once_sync(tmp.path().to_path_buf(), true).unwrap();
        assert_eq!(out, ReportOutcome::Skipped(SkipReason::NoConsent));
    }

    // ── state ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn missing_or_corrupt_state_fails_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let fresh = load_state(tmp.path());
        assert_eq!(fresh, BuilderIndexState::default());
        assert!(fresh.consented_at.is_none(), "never consented by default");

        std::fs::write(tmp.path().join("builder-index.json"), "{ not json").unwrap();
        assert_eq!(load_state(tmp.path()), BuilderIndexState::default());
    }

    #[test]
    fn state_round_trips_and_forward_compatible_keys_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let state = BuilderIndexState {
            username: "sam".into(),
            client_id: "deadbeef".into(),
            consented_at: Some(1_700_000_000),
            last_report_at: Some(1_700_000_100),
            last_status: Some("Reported 3 row(s) across 2 day(s).".into()),
            report_days: 14,
        };
        save_state(tmp.path(), &state).unwrap();
        assert_eq!(load_state(tmp.path()), state);

        // A key written by a newer build must not reset the whole file to defaults.
        std::fs::write(
            tmp.path().join("builder-index.json"),
            r#"{"username":"sam","some_future_key":true}"#,
        )
        .unwrap();
        assert_eq!(load_state(tmp.path()).username, "sam");
    }

    #[test]
    fn the_report_window_defaults_and_clamps() {
        let d = |n: u32| BuilderIndexState { report_days: n, ..Default::default() }.window();
        assert_eq!(d(0), DEFAULT_REPORT_DAYS);
        assert_eq!(d(1), 1);
        assert_eq!(d(14), 14);
        assert_eq!(d(9_999), MAX_REPORT_DAYS);
    }

    // ── client id ────────────────────────────────────────────────────────────────────────

    #[test]
    fn client_id_matches_the_reference_clients_derivation() {
        // sha256("MACHINE|user") truncated to 32 hex chars — the same value tkmx-client's
        // deriveClientId produces, so migrating users keep their machine identity (and their
        // rows keep merging instead of double-counting).
        let id = derive_client_id("MACHINE", "user");
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        let expected = {
            let mut h = Sha256::new();
            h.update(b"MACHINE|user");
            let full: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
            full[..32].to_string()
        };
        assert_eq!(id, expected);
    }

    #[test]
    fn client_id_is_stable_per_machine_and_username() {
        assert_eq!(derive_client_id("m", "a"), derive_client_id("m", "a"));
        assert_ne!(derive_client_id("m", "a"), derive_client_id("m", "b"));
        assert_ne!(derive_client_id("m1", "a"), derive_client_id("m2", "a"));
    }

    #[test]
    fn ensure_client_id_pins_the_first_derivation() {
        // A later machine-id read failure must NOT mint a second id: the server keys rows on it,
        // and a "new machine" makes every overlapping day double-count on the public profile.
        let tmp = tempfile::tempdir().unwrap();
        let mut state = BuilderIndexState { username: "sam".into(), ..Default::default() };
        let first = ensure_client_id(tmp.path(), &mut state);
        assert!(!first.is_empty());
        // Reload from disk — the pin must have been persisted, not just held in memory.
        let mut reloaded = load_state(tmp.path());
        assert_eq!(ensure_client_id(tmp.path(), &mut reloaded), first);
    }

    #[test]
    fn machine_id_parsers_read_the_real_command_output() {
        let ioreg = r#"+-o Root  <class IORegistryEntry, id 0x100000100, retain 39>
    "IOPlatformUUID" = "F1D2D2F9-24E6-4A1B-9A0C-1A2B3C4D5E6F"
    "IOPlatformSerialNumber" = "C02XY1234567"
"#;
        assert_eq!(
            extract_io_platform_uuid(ioreg).as_deref(),
            Some("F1D2D2F9-24E6-4A1B-9A0C-1A2B3C4D5E6F")
        );
        assert_eq!(extract_io_platform_uuid("nothing here"), None);

        let reg = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    12345678-90ab-cdef-1234-567890abcdef\r\n\r\n";
        assert_eq!(
            extract_machine_guid(reg).as_deref(),
            Some("12345678-90ab-cdef-1234-567890abcdef")
        );
        assert_eq!(extract_machine_guid("MachineGuid REG_DWORD 5"), None);
    }

    // ── outcome wire shape ───────────────────────────────────────────────────────────────

    #[test]
    fn report_outcome_serializes_as_a_tagged_object() {
        let posted =
            serde_json::to_value(ReportOutcome::Posted { rows: 12, days: 7, truncated: false })
                .unwrap();
        assert_eq!(posted["status"], "posted");
        assert_eq!(posted["rows"], 12);
        assert_eq!(posted["days"], 7);
        // `truncated` must cross the IPC boundary: the modal shows the fresh outcome and suppresses
        // `last_status`, so without it a capped (understated) scan reads as a clean report on the
        // only surface the user actually looks at. (roborev 47899)
        assert_eq!(posted["truncated"], false);
        let partial =
            serde_json::to_value(ReportOutcome::Posted { rows: 1, days: 1, truncated: true })
                .unwrap();
        assert_eq!(partial["truncated"], true);

        let skipped = serde_json::to_value(ReportOutcome::Skipped(SkipReason::Disabled)).unwrap();
        assert_eq!(skipped["status"], "skipped");
        assert_eq!(skipped["reason"], "Builder Index is off");
    }

    #[test]
    fn the_api_host_is_the_reporting_host_not_the_profile_site() {
        // Verified against tkmx-client v1.3.0 reporter/report.ts: SERVER_URL defaults to the
        // odio.dev API host; watchmepivot.com serves the human-facing profile only.
        assert_eq!(DEFAULT_SERVER_URL, "https://tokenmaxxing.odio.dev");
        assert!(!DEFAULT_SERVER_URL.contains("watchmepivot"));
    }

    #[test]
    fn a_report_write_preserves_fields_the_reporter_does_not_own() {
        // The race this guards: `report_once_sync` snapshots state, then spends a scan + a 20s POST
        // before writing back. A "Turn off and forget" landing in that window used to be UNDONE —
        // the reporter restored username, client_id, and (worst) consented_at, silently
        // re-recording a consent the user had just withdrawn. `record_outcome` re-reads first and
        // touches only its own two fields. (roborev 47458)
        let tmp = tempfile::tempdir().unwrap();
        save_state(
            tmp.path(),
            &BuilderIndexState {
                username: "old".into(),
                client_id: "old-id".into(),
                consented_at: Some(1),
                ..Default::default()
            },
        )
        .unwrap();

        // …the user forgets everything while a cycle is in flight…
        save_state(tmp.path(), &BuilderIndexState::default()).unwrap();
        // …and the in-flight cycle then records its outcome.
        record_outcome(tmp.path(), Some(1_700_000_000), "Reported 3 row(s).".into());

        // NOTHING is written. `builder_index_forget` is complete erasure, so leaving behind
        // "Reported 3 row(s)" and a timestamp tied to the deleted identity — which the modal would
        // then show on the next open — is its own privacy defect, not just cosmetic.
        // (roborev 47904/47899)
        assert_eq!(load_state(tmp.path()), BuilderIndexState::default());
    }

    #[test]
    fn a_report_write_lands_when_consent_is_still_in_place() {
        // The other half of the bail-on-withdrawn rule: a normal cycle must still record itself,
        // and must not disturb the user-owned fields it read.
        let tmp = tempfile::tempdir().unwrap();
        save_state(
            tmp.path(),
            &BuilderIndexState {
                username: "sam".into(),
                client_id: "pinned".into(),
                consented_at: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        record_outcome(tmp.path(), Some(1_700_000_000), "Reported 3 row(s).".into());

        let after = load_state(tmp.path());
        assert_eq!(after.last_report_at, Some(1_700_000_000));
        assert_eq!(after.last_status.as_deref(), Some("Reported 3 row(s)."));
        assert_eq!(after.username, "sam");
        assert_eq!(after.client_id, "pinned");
        assert_eq!(after.consented_at, Some(5));
    }

    #[test]
    fn a_200_with_an_error_payload_is_not_treated_as_success() {
        // tkmx-server can answer 200 with a failure body. Recording "Reported N rows" then sends
        // the user to a profile that never updates, with no diagnostic. (roborev 47458)
        assert_eq!(
            server_side_error(r#"{"success":false,"error":"unknown user"}"#).as_deref(),
            Some("unknown user")
        );
        // A bare negative with no message still fails — with a generic reason rather than nothing.
        assert_eq!(
            server_side_error(r#"{"success":false}"#).as_deref(),
            Some("the server reported a failure")
        );
        assert_eq!(server_side_error(r#"{"error":"profile frozen"}"#).as_deref(), Some("profile frozen"));
        // Shapes a proxy or a future server version might use — recognizing only two of them meant
        // the rest fell through as success, which is the "profile never updates, no diagnostic"
        // outcome this check exists to prevent. (roborev 47904)
        assert!(server_side_error(r#"{"ok":false}"#).is_some());
        assert_eq!(
            server_side_error(r#"{"status":"error","message":"rate limited"}"#).as_deref(),
            Some("rate limited")
        );
        assert_eq!(
            server_side_error(r#"{"error":{"message":"unknown user"}}"#).as_deref(),
            Some("unknown user")
        );
        // Happy paths and anything we don't recognize are NOT failures — the success body isn't a
        // documented contract, so only an unambiguous marker counts.
        assert_eq!(server_side_error(r#"{"ok":true}"#), None);
        assert_eq!(server_side_error(r#"{"client_update":"1.4.0"}"#), None);
        assert_eq!(server_side_error(r#"{"error":null}"#), None);
        assert_eq!(server_side_error(r#"{"error":""}"#), None);
        assert_eq!(server_side_error(""), None);
        assert_eq!(server_side_error("not json at all"), None);
    }

    #[test]
    fn a_non_https_server_override_is_refused() {
        // The request carries `Authorization: Bearer <api key>`, so an unvalidated env override is
        // a key-exfiltration primitive for anything that can seed the environment. (roborev 47458)
        assert!(is_safe_override("https://staging.example.com"));
        assert!(is_safe_override("http://localhost:8080"));
        assert!(is_safe_override("http://127.0.0.1:8080"));
        // The documented IPv6 loopback case: splitting on ':' before peeling the bracket yielded a
        // bare "[", so this branch was unreachable and the doc comment was a lie. (roborev 47899)
        assert!(is_safe_override("http://[::1]:8080"));
        assert!(is_safe_override("http://[::1]/api"));
        assert!(!is_safe_override("http://[::2]:8080"));
        assert!(!is_safe_override("http://evil.example.com"));
        assert!(!is_safe_override("http://localhost.evil.example.com"));
        assert!(!is_safe_override("ftp://example.com"));
        assert!(!is_safe_override("example.com"));
        assert!(!is_safe_override("https://"));
    }

    #[test]
    fn jitter_stays_inside_its_spread_and_is_not_a_clock_function() {
        let samples: Vec<u64> = (0..64).map(|_| jitter_secs()).collect();
        assert!(samples.iter().all(|j| *j < JITTER_SPREAD_SECS));
        // A clock-derived "jitter" returns the same value for every call inside one second, which
        // is the synchronized herd it was supposed to prevent. (roborev 47460)
        assert!(
            samples.iter().any(|j| *j != samples[0]),
            "jitter must actually vary"
        );
    }

    #[test]
    fn the_pre_key_gate_answers_off_without_reaching_for_the_keychain() {
        // An unsigned dev binary touching the signed app's keychain item pops a macOS auth prompt,
        // so a default-off install must decide "no" before it ever gets there. This asserts the
        // gate's SHAPE (it takes only the toggle + the state file, no key) as well as its answers.
        // (roborev 47460)
        let configured = BuilderIndexState {
            username: "sam".into(),
            consented_at: Some(1),
            ..Default::default()
        };
        assert_eq!(pre_key_gate(false, &configured), Err(SkipReason::Disabled));
        assert_eq!(
            pre_key_gate(true, &BuilderIndexState { username: "sam".into(), ..Default::default() }),
            Err(SkipReason::NoConsent)
        );
        assert_eq!(
            pre_key_gate(
                true,
                &BuilderIndexState { consented_at: Some(1), username: "   ".into(), ..Default::default() }
            ),
            Err(SkipReason::NoUsername)
        );
        // Everything the gate can check without a key passes — the key read is what comes next.
        assert_eq!(pre_key_gate(true, &configured), Ok(()));
    }

    #[test]
    fn an_unusable_api_key_is_rejected_before_it_is_stored() {
        // The value is interpolated into an `Authorization` header. A stray newline from a paste
        // would malform every request, every cycle, forever — fail loudly in the dialog instead.
        // (roborev 47460)
        assert!(validate_api_key("tkmx_live_abc123").is_ok());
        assert!(validate_api_key("").is_err());
        assert!(validate_api_key("abc\ndef").is_err());
        assert!(validate_api_key("abc\r\ndef").is_err());
        assert!(validate_api_key("abc def").is_err());
        assert!(validate_api_key("abc–def").is_err(), "non-ASCII (en dash) rejected");
    }

    #[test]
    fn a_client_id_already_on_disk_always_wins() {
        // Two racing derivations (the loop + a "Report now") could pin DIFFERENT ids if one
        // read_machine_id() failed into the random fallback — the double-count failure the module
        // header warns about. An id already persisted is authoritative. (roborev 47460)
        let tmp = tempfile::tempdir().unwrap();
        save_state(
            tmp.path(),
            &BuilderIndexState {
                username: "sam".into(),
                client_id: "pinned-by-the-other-cycle".into(),
                ..Default::default()
            },
        )
        .unwrap();
        // This caller's in-memory snapshot predates that write and has no id.
        let mut stale = BuilderIndexState { username: "sam".into(), ..Default::default() };
        assert_eq!(ensure_client_id(tmp.path(), &mut stale), "pinned-by-the-other-cycle");
        assert_eq!(load_state(tmp.path()).client_id, "pinned-by-the-other-cycle");
    }

    #[test]
    fn a_pinned_id_is_derived_from_the_fresh_username_not_the_callers_stale_one() {
        // The rename race. `builder_index_set_identity` clears client_id on a rename precisely so
        // the next cycle re-derives under the new name. An in-flight cycle that derived from its
        // OWN (stale) snapshot would pin sha256(machine|"old") into a record whose username is
        // "renamed" — permanently attaching this machine's rows to the wrong profile, and sticky
        // because a non-empty pin short-circuits. Asserting merely "not empty" pins the bug.
        // (roborev 48168/48167)
        let tmp = tempfile::tempdir().unwrap();
        save_state(
            tmp.path(),
            &BuilderIndexState { username: "renamed".into(), consented_at: Some(7), ..Default::default() },
        )
        .unwrap();
        let mut stale = BuilderIndexState { username: "old".into(), ..Default::default() };
        let pinned = ensure_client_id(tmp.path(), &mut stale);

        // Whatever machine id this host produced, the id must be the "renamed" derivation of it —
        // never the "old" one.
        let machine = read_machine_id().unwrap_or_else(random_machine_fallback);
        if read_machine_id().is_some() {
            assert_eq!(pinned, derive_client_id(&machine, "renamed"));
            assert_ne!(pinned, derive_client_id(&machine, "old"));
        }
        // And the caller's own snapshot is refreshed, so its POST doesn't carry the old username
        // alongside the new-name id.
        assert_eq!(stale.username, "renamed");
        let after = load_state(tmp.path());
        assert_eq!(after.username, "renamed");
        assert_eq!(after.consented_at, Some(7));
        assert_eq!(after.client_id, pinned);
    }

    #[test]
    fn the_partial_marker_is_in_the_status_line_both_ways() {
        // The wording is the whole point of propagating `truncated`; built inline it was
        // unreachable from a test. (roborev 47904/47899)
        assert_eq!(posted_status(3, 2, false), "Reported 3 row(s) across 2 day(s).");
        let partial = posted_status(3, 2, true);
        assert!(partial.starts_with("Reported 3 row(s) across 2 day(s)."));
        assert!(partial.contains("PARTIAL"));
        assert!(partial.contains("understates your usage"));
    }

    #[test]
    fn a_hostile_server_override_is_ignored_in_a_release_build() {
        // The refusal paths, without mutating the process env (global state shared with every
        // other test in this binary). (roborev 47904/47899)
        let d = DEFAULT_SERVER_URL;
        // Release: the override does not exist, however well-formed.
        assert_eq!(resolve_server_url(Some("https://attacker.example"), false), d);
        assert_eq!(resolve_server_url(Some("https://staging.example.com"), false), d);
        // Dev: https and loopback are honored, everything else falls back.
        assert_eq!(
            resolve_server_url(Some("https://staging.example.com"), true),
            "https://staging.example.com"
        );
        assert_eq!(resolve_server_url(Some("http://localhost:8080"), true), "http://localhost:8080");
        assert_eq!(resolve_server_url(Some("http://evil.example.com"), true), d);
        // Absent / blank always means the default.
        assert_eq!(resolve_server_url(None, true), d);
        assert_eq!(resolve_server_url(Some("   "), true), d);
    }

    #[test]
    fn a_stored_key_that_cannot_be_a_header_value_gets_its_own_reason() {
        // "You haven't set a key" and "the key you set is broken" need different fixes, and the
        // second used to surface as a generic transport error every 2h forever.
        // (roborev 48168/48167)
        assert_eq!(SkipReason::NoApiKey.as_str(), "no API key set");
        assert_eq!(
            SkipReason::BadApiKey.as_str(),
            "the stored API key is unusable — re-enter it"
        );
        // read_api_key's validation is the same predicate the write path uses.
        assert!(validate_api_key("abc\ndef").is_err());
    }

    #[test]
    fn the_two_gates_can_never_disagree() {
        // pre_key_gate delegates to consent_gate, so the precedence exists once. If someone
        // reimplements it, this catches the divergence between the modal's `blockedBy` and the
        // reason the loop actually skipped. (roborev 48168/48167)
        for enabled in [false, true] {
            for consented in [false, true] {
                for named in [false, true] {
                    let state = BuilderIndexState {
                        username: if named { "sam".into() } else { String::new() },
                        consented_at: consented.then_some(1),
                        ..Default::default()
                    };
                    assert_eq!(
                        pre_key_gate(enabled, &state),
                        consent_gate(enabled, consented, named, true),
                        "enabled={enabled} consented={consented} named={named}"
                    );
                }
            }
        }
    }

    /// LIVE round-trip against the real tkmx server — the one check a unit test cannot give:
    /// that the payload this module builds is accepted end-to-end. `#[ignore]` + env-gated so CI
    /// and plain `cargo test` never touch the network or need credentials.
    ///
    /// Run: `TKMX_SERVER_URL=<staging> TKMX_USERNAME=<u> TKMX_API_KEY=<k> TKMX_TEAM=<t> \
    ///       TKMX_APP_DATA=<app-data-dir> cargo test --lib \
    ///       builder_index::tests::live_report_roundtrip -- --ignored --nocapture`
    ///
    /// NEVER posts to production. The server upserts by (client_id, date), so a run of this test
    /// would REPLACE today's real row for this machine — and with a partial scan behind it, replace
    /// it with an undercount, which is the exact ~84% underreporting the feature exists to fix. So
    /// `TKMX_SERVER_URL` must be set to something other than the production default, and the test
    /// refuses to run otherwise.
    ///
    /// `TKMX_APP_DATA` should be the app-data dir whose `accounts/` this machine really uses;
    /// without it the scan covers `~/.claude` ONLY, which is the same undercount in miniature.
    ///
    /// Everything else is real (that's the point): real transcript scan, real `rollup`, real
    /// `derive_client_id` off the real machine id, 1-day window to keep the upsert surface minimal.
    #[test]
    #[ignore]
    fn live_report_roundtrip() {
        let (Ok(username), Ok(api_key)) =
            (std::env::var("TKMX_USERNAME"), std::env::var("TKMX_API_KEY"))
        else {
            eprintln!("live_report_roundtrip: TKMX_USERNAME/TKMX_API_KEY not set — skipping");
            return;
        };
        // Check the RAW override, not `server_url()`'s result: `resolve_server_url` silently falls
        // back to the default in a release build or for a non-https/non-loopback URL, so testing
        // the resolved value reports "not set" for an override that IS set and was rejected.
        let raw = std::env::var("TKMX_SERVER_URL").unwrap_or_default();
        assert!(
            !raw.trim().is_empty(),
            "refusing to post to production: set TKMX_SERVER_URL to a staging server — this \
             upserts by (client_id, date) and would overwrite today's real row"
        );
        let target = server_url();
        assert_ne!(
            target.trim_end_matches('/'),
            DEFAULT_SERVER_URL.trim_end_matches('/'),
            "TKMX_SERVER_URL is set to {raw:?} but was REJECTED (an override must be https or \
             loopback, and only a debug build honours it), so this would have posted to production"
        );
        let team = std::env::var("TKMX_TEAM").unwrap_or_else(|_| DEFAULT_TEAM.to_string());

        let machine = read_machine_id().expect("machine id");
        let app_data = std::env::var_os("TKMX_APP_DATA").map(PathBuf::from);
        let scan = crate::spend::load_window_records(app_data.as_deref(), 1);
        let data = rollup(scan.records(), scan.today, 1);
        let rows = row_count(&data);
        let body = ReportBody {
            username: username.clone(),
            team,
            client_id: derive_client_id(&machine, &username),
            client_version: client_version(),
            report_days: 1,
            data,
        };
        let payload = serde_json::to_string(&body).expect("serialize");

        let url = format!("{}/api/usage", target.trim_end_matches('/'));
        let resp = ureq::post(&url)
            .timeout(HTTP_TIMEOUT)
            .set("Content-Type", "application/json")
            .set("Authorization", &format!("Bearer {api_key}"))
            .send_string(&payload)
            .expect("POST failed");
        let status = resp.status();
        let body = resp.into_string().expect("read response");
        eprintln!("live_report_roundtrip: {status} {body} ({rows} rows posted to {url})");
        assert_eq!(status, 200);
        assert!(
            server_side_error(&body).is_none(),
            "server reported an in-body error: {body}"
        );
    }
}

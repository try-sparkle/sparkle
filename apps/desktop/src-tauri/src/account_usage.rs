//! REAL per-account Claude subscription usage, fetched live from Anthropic's OAuth usage endpoint.
//!
//! This augments the LOCAL token-tally estimate in `accounts.rs` (which counts tokens out of each
//! account's own transcripts) with the account's actual server-side utilization: the 5-hour session
//! window and the 7-day window, each as a percent plus a reset instant.
//!
//! Secrets stay in Rust. The per-account OAuth **access token** is read here — from Sparkle's own
//! `<config_dir>/.sparkle-usage-cache.json` if fresh, else the account's `<config_dir>/.credentials.json`
//! if present, else the macOS keychain — and is used ONLY as the `Authorization: Bearer` on the one
//! outbound call. It is NEVER logged, printed, or handed to JS. Mirrors `auth.rs`'s keychain-read +
//! authed-`ureq`-GET style.
//!
//! ## Why the cache exists (keychain-prompt suppression)
//!
//! On macOS the `claude` CLI stores each account's OAuth credential ONLY in the login keychain —
//! there is no `.credentials.json` on disk — and Sparkle is not on that keychain item's ACL. So
//! every usage fetch that reached the keychain popped a "Sparkle wants to access key …" password
//! prompt, once PER ACCOUNT, on every refresh. To stop that, the FIRST successful keychain read for
//! an account is cached to `<config_dir>/.sparkle-usage-cache.json` (mode 0600, same user) together
//! with the token's `expiresAt`; subsequent fetches read that plain file — no keychain, no prompt —
//! until the token lapses (or the API answers 401), at which point exactly ONE fresh keychain read
//! re-populates it. This is a TTL cache, NOT an OAuth refresh: Sparkle deliberately does not call the
//! Claude OAuth token endpoint, because that endpoint ROTATES the refresh token and would invalidate
//! the credential `claude` itself relies on in the keychain, logging the user out.
//!
//! Security (same-user only): the cache holds the SAME token already in the user's login keychain,
//! written 0600 in the account's own config dir. It is never placed on a shared, cross-user, or
//! world-readable path. Low incremental risk relative to the keychain copy it mirrors.
//!
//! The parser (`parse_usage_response`) is deliberately DEFENSIVE: Anthropic sends nullable fields as
//! the key with a `null` VALUE (not an absent key), so every optional field is `Option<T>`. A parser
//! that rejected the whole payload when one field is null would silently make the feature inert — the
//! documented #1 failure mode for this seam. A missing/`null` window → `None`, never an error; and
//! unknown extra top-level keys are ignored (serde's default).

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The live usage endpoint. GET, bearer-authed, with the OAuth beta header.
///
/// The `anthropic-usage-ok` marker on the line below is the crate's ONE sanctioned direct-Anthropic
/// host reference (see the `no_anthropic_key` guard in `claude_oneshot.rs`): this call carries the
/// USER'S OWN OAuth Bearer — their Claude Code subscription — never a Sparkle-funded API key, and
/// the token stays on-device. The marker waives only the host-string check; a real `x-api-key` /
/// `anthropic-version` / `ANTHROPIC_API_KEY` path here would still fail that guard.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage"; // anthropic-usage-ok

/// Bound the HTTP call so a black-holed host can't freeze the calling thread — ureq has no default
/// request timeout. Mirrors `auth.rs`'s HTTP_TIMEOUT.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// The OAuth beta header the endpoint requires.
const OAUTH_BETA: &str = "oauth-2025-04-20";

// ---- output types (camelCase for the JS boundary) -----------------------------------------------

/// Live per-account usage returned by [`account_usage_live`] and produced by
/// [`parse_usage_response`]. Every field is optional because the upstream payload can send any
/// window as `null` (or omit it), and the UI must degrade to "—" rather than break.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageLive {
    /// 5-hour session window utilization percent (0–100), or `None` when the window is absent/null.
    pub five_hour_percent: Option<f64>,
    /// ISO-8601 instant the 5-hour window resets, or `None`.
    pub five_hour_resets_at: Option<String>,
    /// 7-day window utilization percent (0–100), or `None`.
    pub seven_day_percent: Option<f64>,
    /// ISO-8601 instant the 7-day window resets, or `None`.
    pub seven_day_resets_at: Option<String>,
    /// The raw `limits` array passed through for any richer surface (per-model scoped windows etc.).
    /// Empty when the payload carried none.
    pub limits: Vec<LiveLimit>,
    /// The USAGE-CREDITS meter (`extra_usage` upstream), or `None` when the payload omitted it or
    /// sent it as `null`. This is the field that answers "WHICH meter is this account spending
    /// against" — subscription windows above, or pay-as-you-go credits here.
    pub extra_usage: Option<LiveExtraUsage>,
}

/// The pay-as-you-go USAGE-CREDITS meter, re-serialized camelCase for JS. Present-and-enabled means
/// the account can spend BEYOND its subscription windows; `spend_limit_reached` is the hard stop.
/// Every field optional — the wire sends `null` for each of these on a subscription-only account.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveExtraUsage {
    /// Whether the usage-credits meter is turned on for this account.
    pub is_enabled: Option<bool>,
    /// The configured monthly credit ceiling, when one is set.
    pub monthly_limit: Option<f64>,
    /// Credits consumed so far this month.
    pub used_credits: Option<f64>,
    /// `used_credits` as a percent of `monthly_limit`, as upstream computes it.
    pub utilization: Option<f64>,
    /// TRUE once the account has hit its spend limit — the "your fleet is about to stall" signal.
    pub spend_limit_reached: Option<bool>,
}

/// One entry of the upstream `limits` array, re-serialized camelCase for JS. Every field is optional
/// (the wire sends nulls) — see the module docstring.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveLimit {
    pub kind: Option<String>,
    pub group: Option<String>,
    pub percent: Option<f64>,
    pub severity: Option<String>,
    pub resets_at: Option<String>,
    pub is_active: Option<bool>,
    /// WHICH model/surface this limit is scoped to, or `None` for an unscoped (account-wide) window.
    /// A `weekly_scoped` row without this is unreadable — you can see the percent but not whose it
    /// is. `None` covers both the `null` the wire sends on unscoped rows and an absent key.
    pub scope: Option<LiveLimitScope>,
}

/// The `scope` of a scoped limit, re-serialized camelCase for JS. Only `model` is projected; other
/// scope keys (`surface`, …) are deliberately not modelled — see [`WireLimitScope`].
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveLimitScope {
    pub model: Option<LiveLimitModel>,
}

/// The model a scoped limit belongs to. `display_name` is the human-readable one ("Fable").
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveLimitModel {
    pub id: Option<String>,
    pub display_name: Option<String>,
}

// ---- wire types (snake_case, exactly as Anthropic sends) ----------------------------------------

/// One usage window as Anthropic sends it. `#[serde(default)]` on each field so a present-but-partial
/// window (e.g. `utilization: null`) still deserializes to `None` rather than erroring.
#[derive(Deserialize, Default)]
struct WireWindow {
    #[serde(default)]
    utilization: Option<f64>,
    #[serde(default)]
    resets_at: Option<String>,
}

/// One `limits[]` entry as Anthropic sends it (snake_case), `scope` included — that key is what
/// attaches a MODEL to a `weekly_scoped` window. Other unknown keys are still ignored (serde's
/// default). Every field is `Option<T>` + `#[serde(default)]` so both `null` and absent map to
/// `None` rather than rejecting the whole payload — see the module docstring.
#[derive(Deserialize, Default)]
struct WireLimit {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    percent: Option<f64>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    resets_at: Option<String>,
    #[serde(default)]
    is_active: Option<bool>,
    #[serde(default)]
    scope: Option<WireLimitScope>,
}

/// `limits[].scope` as Anthropic sends it. `scope` itself is `null` on unscoped rows, hence the
/// `Option` on the FIELD above as well as on everything inside here.
///
/// `surface` is deliberately NOT modelled: it is `null` in every observed payload and its
/// non-null shape is unknown, so declaring a concrete type for it would be a guess that could
/// reject the whole payload the day upstream sends an object there. Unknown keys are ignored, which
/// is the fail-soft choice.
#[derive(Deserialize, Default)]
struct WireLimitScope {
    #[serde(default)]
    model: Option<WireLimitModel>,
}

/// `limits[].scope.model` as Anthropic sends it. `id` is `null` in the observed payload while
/// `display_name` carries the readable name.
#[derive(Deserialize, Default)]
struct WireLimitModel {
    #[serde(default, deserialize_with = "lenient_string")]
    id: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    display_name: Option<String>,
}

/// The top-level payload. `five_hour`/`seven_day` are `Option` so a `null` window (or an absent key)
/// yields `None`; unknown extra top-level keys (`seven_day_opus`, …) are ignored. `extra_usage` is
/// no longer among them — it is the usage-credits meter and is parsed below.
///
/// `limits` is `Option<Vec<…>>`, NOT a bare `Vec` with `#[serde(default)]`: `default` only covers an
/// ABSENT key, so `"limits": null` — the same null-valued-key shape the module docstring says the
/// wire uses — would fail deserialization with `invalid type: null, expected a sequence` and reject
/// the WHOLE payload, the exact all-or-nothing failure this module exists to prevent. `Option` +
/// `unwrap_or_default()` in the projection maps both null and absent to an empty vec.
#[derive(Deserialize, Default)]
struct WireUsage {
    #[serde(default)]
    five_hour: Option<WireWindow>,
    #[serde(default)]
    seven_day: Option<WireWindow>,
    #[serde(default)]
    limits: Option<Vec<WireLimit>>,
    /// The usage-credits meter. `Option` + `default` for the same reason as everything else here:
    /// `"extra_usage": null` must yield `None`, not reject the payload.
    #[serde(default)]
    extra_usage: Option<WireExtraUsage>,
}


// ---- tolerant scalar readers ---------------------------------------------------------------
//
// WHY THESE EXIST, since `Option<f64>` + `#[serde(default)]` looks like it already covers this.
//
// It covers `null` and ABSENT. It does not cover a WRONG TYPE — and modelling a subtree that was
// previously an ignored unknown key is exactly where a wrong type first becomes reachable. Before
// `extra_usage` was projected, serde skipped it whatever it contained; now a single member arriving
// as, say, a decimal STRING (`"used_credits": "199.50"`, an ordinary billing-API convention) makes
// `from_str::<WireUsage>` fail, `parse_usage_response` return `Err`, and `account_usage_live` reject
// the WHOLE payload. The 5-hour and 7-day bars would go dark — and precisely for the accounts that
// have credits enabled, i.e. the ones with the most to lose.
//
// That is the all-or-nothing failure `limits: Option<Vec<…>>` is shaped to avoid, and the same
// reasoning that made `WireLimitScope` decline to model `surface` at all. So the tolerance belongs
// on the MEMBERS: an unreadable member degrades to `None`, the siblings survive, and the account's
// subscription windows still render.
//
// Degrading to `None` is also the SAFE direction for the spend gate downstream: it reads an absent
// meter as `meter-unreadable` and REFUSES. A garbled figure can therefore never be mistaken for
// permission — the worst case is an advisor pass that declines to run, never one that spends.

/// A nullable number that upstream may send as a JSON string. Anything that is not a number or a
/// parseable numeric string becomes `None` rather than an error.
fn lenient_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    })
}

/// A nullable boolean that upstream may send as the strings "true"/"false". Anything else becomes
/// `None` — which the spend gate reads as "cannot prove credits are disarmed", so it refuses.
fn lenient_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Bool(b) => Some(b),
        serde_json::Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

/// A nullable string. A number is rendered rather than rejected (an id arriving unquoted is the
/// likely drift); anything structural becomes `None`.
fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

/// `extra_usage` as Anthropic sends it — the pay-as-you-go credits meter that sits alongside the
/// subscription windows. All five fields nullable; a subscription-only account sends
/// `is_enabled: false` with the rest `null`.
#[derive(Deserialize, Default)]
struct WireExtraUsage {
    #[serde(default, deserialize_with = "lenient_bool")]
    is_enabled: Option<bool>,
    #[serde(default, deserialize_with = "lenient_f64")]
    monthly_limit: Option<f64>,
    #[serde(default, deserialize_with = "lenient_f64")]
    used_credits: Option<f64>,
    #[serde(default, deserialize_with = "lenient_f64")]
    utilization: Option<f64>,
    #[serde(default, deserialize_with = "lenient_bool")]
    spend_limit_reached: Option<bool>,
}

impl From<WireLimit> for LiveLimit {
    fn from(w: WireLimit) -> Self {
        LiveLimit {
            kind: w.kind,
            group: w.group,
            percent: w.percent,
            severity: w.severity,
            resets_at: w.resets_at,
            is_active: w.is_active,
            scope: w.scope.map(LiveLimitScope::from),
        }
    }
}

impl From<WireLimitScope> for LiveLimitScope {
    fn from(w: WireLimitScope) -> Self {
        LiveLimitScope {
            model: w.model.map(LiveLimitModel::from),
        }
    }
}

impl From<WireLimitModel> for LiveLimitModel {
    fn from(w: WireLimitModel) -> Self {
        LiveLimitModel {
            id: w.id,
            display_name: w.display_name,
        }
    }
}

impl From<WireExtraUsage> for LiveExtraUsage {
    fn from(w: WireExtraUsage) -> Self {
        LiveExtraUsage {
            is_enabled: w.is_enabled,
            monthly_limit: w.monthly_limit,
            used_credits: w.used_credits,
            utilization: w.utilization,
            spend_limit_reached: w.spend_limit_reached,
        }
    }
}

/// PURE parser (no IO) — the whole reason the network shell below is a thin wrapper. Deserializes the
/// upstream JSON defensively and projects it to [`AccountUsageLive`].
///
/// Contract, all exercised by the unit tests:
///  * a present window → `Some(percent)` + `Some(resets_at)`;
///  * a `null` or absent window → `None` for both (NOT an `Err`);
///  * a present window whose `utilization` is `null` → `None` percent (proves the `Option<f64>`);
///  * a `limits[]` row's `scope` → `Some(..)` when scoped, `None` when the wire sent `null`/nothing;
///  * `extra_usage` → `Some(..)` when present, `None` when `null` or absent — never an `Err`;
///  * unknown extra top-level keys are ignored.
/// Only genuinely malformed JSON (not valid JSON at all) yields `Err`.
pub fn parse_usage_response(json: &str) -> Result<AccountUsageLive, String> {
    let wire: WireUsage =
        serde_json::from_str(json).map_err(|e| format!("usage parse failed: {e}"))?;
    Ok(AccountUsageLive {
        five_hour_percent: wire.five_hour.as_ref().and_then(|w| w.utilization),
        five_hour_resets_at: wire.five_hour.and_then(|w| w.resets_at),
        seven_day_percent: wire.seven_day.as_ref().and_then(|w| w.utilization),
        seven_day_resets_at: wire.seven_day.and_then(|w| w.resets_at),
        limits: wire
            .limits
            .unwrap_or_default()
            .into_iter()
            .map(LiveLimit::from)
            .collect(),
        extra_usage: wire.extra_usage.map(LiveExtraUsage::from),
    })
}

// ---- token source (per account) -----------------------------------------------------------------

/// The keychain service name for an EXPLICIT config dir: `"Claude Code-credentials-" + <first 8 hex
/// chars of sha256(P)>`, lowercase, where P is the absolute config-dir path with no trailing slash.
///
/// Pure — unit-tested against the SHA-256("abc") vector so the hashing/hex/truncation can't drift.
fn keychain_service(config_dir: &str) -> String {
    let digest = Sha256::digest(config_dir.as_bytes());
    // First 8 hex chars = the first 4 bytes, lowercase.
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("Claude Code-credentials-{hex}")
}

/// The BARE keychain service the `claude` CLI uses when `CLAUDE_CONFIG_DIR` is UNSET — i.e. for the
/// DEFAULT account (`config_dir: ""`, which `claudeSpawn.ts` exports no `CLAUDE_CONFIG_DIR` for).
/// Claude Code's `T7()` hashes the dir ONLY when the env var is set and uses this bare name when it
/// is not (documented in `services/claudeSpawn.ts:245`). The default account is the common case, so
/// deriving the hashed `sha256($HOME/.claude)` service for it — as an earlier cut did — looked up a
/// name the credential was never stored under and missed it entirely (worse: it could read an
/// unrelated hashed `$HOME/.claude` item as the default account's own usage).
const BARE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// The keychain service name(s) to probe for an account, IN ORDER. For the default account (the
/// config dir was empty) that is the bare service FIRST — where `claude` actually wrote it — then the
/// hashed `$HOME/.claude` form as a secondary probe (a machine may also carry a hashed item from a
/// `CLAUDE_CONFIG_DIR=~/.claude` run). For an explicit dir it is just the hashed form over the path
/// as given (byte-identity — see `resolve_config_dir_with`).
fn keychain_services(config_dir_was_empty: bool, resolved_dir: &str) -> Vec<String> {
    if config_dir_was_empty {
        vec![
            BARE_KEYCHAIN_SERVICE.to_string(),
            keychain_service(resolved_dir),
        ]
    } else {
        vec![keychain_service(resolved_dir)]
    }
}

/// Basename of Sparkle's own token cache inside an account's config dir. See the module docstring.
const SPARKLE_USAGE_CACHE_FILE: &str = ".sparkle-usage-cache.json";

/// Treat a cached token as expired this many milliseconds BEFORE its stated `expiresAt`, so we don't
/// hand out a token that lapses mid-request. Also absorbs small clock skew.
const CACHE_SKEW_MS: i64 = 60_000;

/// Sparkle's OWN cached copy of an account's OAuth credential, written 0600 in the account's config
/// dir so the keychain is read at most once per token lifetime instead of on every usage fetch. Holds
/// the SAME token already in the user's keychain — see the module docstring's security note.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct CachedCreds {
    /// The OAuth access token used as the `Authorization: Bearer`.
    access_token: String,
    /// The OAuth refresh token, when the source blob carried one. Cached for completeness/forward
    /// compatibility; the TTL cache does NOT use it to refresh (see the docstring on why).
    #[serde(default)]
    refresh_token: Option<String>,
    /// Epoch MILLISECONDS at which the access token expires (claude's `claudeAiOauth.expiresAt`).
    /// `0` means unknown, which [`cache_is_fresh`] treats as NOT fresh (re-read the keychain).
    #[serde(default)]
    expires_at: i64,
}

/// Pull `.claudeAiOauth.accessToken` out of a credentials JSON blob (the shape stored both in the
/// per-dir `.credentials.json` and in the keychain password). `None` if the shape is wrong or the
/// token is empty. Pure — never logs the token.
fn extract_access_token(creds_json: &str) -> Option<String> {
    extract_credentials(creds_json).map(|c| c.access_token)
}

/// Pull the full `{accessToken, refreshToken?, expiresAt?}` triple out of a credentials JSON blob.
/// Requires a non-empty `accessToken`; `refreshToken` and `expiresAt` default to `None`/`0` when
/// absent or null. Pure — never logs the token. This is the superset [`extract_access_token`] wraps.
fn extract_credentials(creds_json: &str) -> Option<CachedCreds> {
    let v: serde_json::Value = serde_json::from_str(creds_json).ok()?;
    let oauth = v.get("claudeAiOauth")?;
    let access_token = oauth
        .get("accessToken")?
        .as_str()
        .filter(|s| !s.is_empty())?
        .to_string();
    let refresh_token = oauth
        .get("refreshToken")
        .and_then(|r| r.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let expires_at = oauth.get("expiresAt").and_then(|e| e.as_i64()).unwrap_or(0);
    Some(CachedCreds {
        access_token,
        refresh_token,
        expires_at,
    })
}

/// Is a cached credential still usable at `now_ms`? Requires a non-empty token AND a known,
/// not-yet-lapsed `expires_at` (minus [`CACHE_SKEW_MS`]). An unknown expiry (`0`) is NOT fresh, so a
/// malformed cache falls back to the keychain rather than serving a token of unknown age forever.
fn cache_is_fresh(cached: &CachedCreds, now_ms: i64) -> bool {
    !cached.access_token.is_empty()
        && cached.expires_at > 0
        && now_ms < cached.expires_at - CACHE_SKEW_MS
}

/// Current wall-clock time in epoch milliseconds; `0` if the clock is before the epoch (never, in
/// practice). The injectable `now_ms` seam in [`read_access_token_cached`] uses this in production.
fn now_epoch_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read + parse Sparkle's cache file. `None` on any miss (absent, unreadable, or malformed) — the
/// caller then falls back to the keychain, so a corrupt cache degrades to a single prompt, never an
/// error. Production seam for [`read_access_token_cached`]'s `read_cache`.
fn read_cache_file(path: &Path) -> Option<CachedCreds> {
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Write Sparkle's cache file at mode 0600 (same user). Best-effort: a write failure is swallowed
/// because caching is only an optimization — the next fetch would simply read the keychain again.
/// Never logs the token. Production seam for [`read_access_token_cached`]'s `write_cache`.
fn write_cache_file(path: &Path, creds: &CachedCreds) {
    let json = match serde_json::to_string(creds) {
        Ok(j) => j,
        Err(_) => return,
    };
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
        {
            let _ = f.write_all(json.as_bytes());
        }
        // Re-assert 0600 in case the file pre-existed with looser permissions.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(path, json.as_bytes());
    }
}

/// The absolute path of Sparkle's cache file for `config_dir`, resolving the default account's empty
/// dir to `$HOME/.claude` the same way the token read does. `None` only when HOME is needed but unset.
fn cache_path_for(config_dir: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok();
    let dir = resolve_config_dir_with(config_dir, home.as_deref()).ok()?;
    Some(Path::new(&dir).join(SPARKLE_USAGE_CACHE_FILE))
}

/// Delete Sparkle's cache file for `config_dir` (best-effort). Called when the cached token is
/// REJECTED by the server (401) so the next read falls through to a fresh keychain read.
fn invalidate_cache(config_dir: &str) {
    if let Some(path) = cache_path_for(config_dir) {
        let _ = std::fs::remove_file(path);
    }
}

/// Resolve the config dir the command was handed. The ONLY transformation is: an EMPTY dir (the
/// default account stores `""`) resolves to `$HOME/.claude`.
///
/// It deliberately does NOT trim a trailing slash or otherwise normalize a non-empty path. Claude
/// Code derives its keychain service as `sha256(CLAUDE_CONFIG_DIR)[:8]` over the path **as given**
/// (bead `sparkle-znusx`; `services/claudeSpawn.test.ts` pins the login path passing `configDir`
/// unmodified), so any normalization here would hash different bytes than the credential was stored
/// under and MISS it. Byte-identity is the invariant; the empty→`$HOME/.claude` case is not a normal
/// path being normalized but the canonical default being constructed.
fn resolve_config_dir_with(config_dir: &str, home: Option<&str>) -> Result<String, String> {
    if !config_dir.is_empty() {
        return Ok(config_dir.to_string());
    }
    let home = home
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "no HOME env".to_string())?;
    Ok(format!("{}/.claude", home.trim_end_matches('/')))
}

/// Read the account's OAuth access token, secrets staying in Rust. FIRST tries the per-dir
/// `<P>/.credentials.json`; ELSE reads the macOS keychain (`service` derived from the path, `account`
/// = the current username). Returns a stable `Err(String)` on any miss — never panics, never logs
/// the token.
///
/// A thin wrapper over [`read_access_token_with`] that passes the REAL environment + IO through the
/// same seam the tests drive — so the precedence and fallback logic (the part most likely to be
/// wrong, and the path the default account with `config_dir: ""` depends on) is exercised without a
/// keychain, and the production call site is not left untested by construction.
/// Is there a usable credential for this config dir?
///
/// Used by roborev account rotation to drop registrations that are not actually signed in. That
/// filter is load-bearing, not cosmetic: an unauthenticated account has consumed ZERO tokens, so a
/// headroom ranking scores it as the emptiest account available and would route every review to the
/// one account guaranteed to fail. See [`crate::roborev_account`].
pub(crate) fn has_readable_credential(config_dir: &str) -> bool {
    // A liveness probe, not a refresh: serve the cached token if fresh (no keychain prompt).
    // Treat an ACL DENIAL as usable (see `credential_is_usable`) so a missing keychain grant
    // does not silently drop the account from the rotation pool.
    credential_is_usable(read_access_token(config_dir, false))
}

/// Decide the sign-in filter from a token read. PURE, so the three outcomes are testable without a
/// keychain — and the middle one is the point:
///  * `Ok` → signed in.
///  * an ACL DENIAL → **UNKNOWN, and we keep the account.** Sparkle could not read the credential,
///    but `claude` — which owns that keychain item — still can, so the account is very likely usable.
///    Reading a denial as "not signed in" silently shrinks the rotation pool by every account whose
///    ACL grant is missing, which on an unattended machine is potentially all of them.
///  * any other error → not signed in.
fn credential_is_usable(read: Result<String, String>) -> bool {
    match read {
        Ok(_) => true,
        Err(e) => is_keychain_permission_error(&e),
    }
}

/// Read the account's OAuth access token. `bypass_cache` skips serving Sparkle's cached token (the
/// forced "Refresh usage" path) — it still writes the cache on a successful read, and never deletes
/// it, so a failed forced read leaves any prior cached token intact.
fn read_access_token(config_dir: &str, bypass_cache: bool) -> Result<String, String> {
    let home = std::env::var("HOME").ok();
    let user = std::env::var("USER").ok();
    read_access_token_cached(
        config_dir,
        home.as_deref(),
        user.as_deref(),
        now_epoch_ms(),
        bypass_cache,
        read_cache_file,
        write_cache_file,
        |p| std::fs::read_to_string(p),
        |service, account| {
            let entry = keyring::Entry::new(service, account)
                .map_err(|e| KeychainMiss::Other(e.to_string()))?;
            entry.get_password().map_err(classify_keychain_error)
        },
    )
}

/// Prefix stamped on the error returned when the keychain REFUSED us an item that exists. Callers
/// match it with [`is_keychain_permission_error`] to tell "this account is not signed in" (a real
/// absence) from "we could not look" (an ACL gate) — the two need opposite handling, and collapsing
/// them into one opaque string is what made a permission gate read as usage-unavailable.
const KEYCHAIN_DENIED_PREFIX: &str = "keychain access not granted";

/// Does this `Err(String)` from the token read mean the keychain DENIED us, rather than that no
/// credential exists? A denial is an UNKNOWN outcome, not a negative one: the account may well be
/// signed in, so a caller must not conclude anything about its usage or auth state from it.
pub(crate) fn is_keychain_permission_error(msg: &str) -> bool {
    msg.starts_with(KEYCHAIN_DENIED_PREFIX)
}

/// Why one keychain probe did not yield a password. The distinction is NOT cosmetic — it decides
/// whether we probe the NEXT candidate service:
///  * [`KeychainMiss::NoEntry`] — no such item. macOS answers from the index without an ACL check,
///    so nothing was shown to anyone; probing the next service is free. The default account
///    legitimately takes this path on its bare-name probe (see [`keychain_services`]).
///  * [`KeychainMiss::Denied`] — the item EXISTS and macOS would not release it to this binary
///    (ACL not granted, auth failed, or the user dismissed the prompt). Probing the next service
///    means a SECOND modal for the same account, on a machine that just told us no.
///  * [`KeychainMiss::Other`] — we never got as far as a lookup (entry construction failed), so no
///    dialog was possible; treat it like an absence and keep probing.
enum KeychainMiss {
    /// No such keychain item. Raises no dialog; probe the next service.
    NoEntry,
    /// The item exists but was not released to us. Terminal for this account's probe.
    Denied(String),
    /// No lookup happened (entry construction failed). Probe the next service.
    Other(String),
}

/// Map a `keyring` failure onto [`KeychainMiss`]. `NoEntry` is the ONE variant that provably means
/// "nothing is stored here"; every other failure is a lookup that reached the keychain and came back
/// without the secret, which on macOS is the ACL/authorization path. Classifying those as `Denied`
/// is deliberately conservative: the cost of over-classifying is one skipped fallback probe that
/// would almost certainly have raised the same dialog, whereas under-classifying is the bug this
/// fixes — a second blocking modal per account on an unattended machine.
fn classify_keychain_error(err: keyring::Error) -> KeychainMiss {
    match err {
        keyring::Error::NoEntry => KeychainMiss::NoEntry,
        other => KeychainMiss::Denied(other.to_string()),
    }
}

/// The precedence + fallback logic WITHOUT the Sparkle cache — kept as a thin wrapper over
/// [`read_access_token_cached`] with the cache disabled (never a cache hit, writes discarded), so the
/// existing creds-file → keychain precedence tests exercise exactly that path unchanged.
#[cfg(test)]
fn read_access_token_with(
    config_dir: &str,
    home: Option<&str>,
    user: Option<&str>,
    read_file: impl Fn(&Path) -> std::io::Result<String>,
    read_keychain: impl Fn(&str, &str) -> Result<String, KeychainMiss>,
) -> Result<String, String> {
    read_access_token_cached(
        config_dir,
        home,
        user,
        0,
        false,
        |_p| None,
        |_p, _c| {},
        read_file,
        read_keychain,
    )
}

/// The full precedence + fallback logic, with the Sparkle cache and the two blocking IO operations
/// injected. Order:
///  0. Sparkle's own `<dir>/.sparkle-usage-cache.json` — a plain 0600 file, NO keychain, NO prompt —
///     used when present AND still fresh (token not lapsed); this is the prompt-suppression path.
///  1. `<dir>/.credentials.json` — used when it exists AND holds a non-empty token;
///  2. otherwise the keychain, trying each service in [`keychain_services`] until one yields a token.
/// On a hit from (1) or (2) the resolved credential is WRITTEN to the cache so the next fetch takes
/// path (0). A creds file present but carrying no usable token FALLS THROUGH to the keychain rather
/// than failing. The `read_*`/`write_cache` params are the real implementations in production and
/// fakes in tests.
///
/// `bypass_cache` SKIPS step (0) — the forced "Refresh usage" path reads the creds file / keychain
/// directly instead of serving a still-fresh cached token, then rewrites the cache from what it read.
/// It never deletes the cache, so a forced read that fails leaves the prior cached token in place.
#[allow(clippy::too_many_arguments)]
fn read_access_token_cached(
    config_dir: &str,
    home: Option<&str>,
    user: Option<&str>,
    now_ms: i64,
    bypass_cache: bool,
    read_cache: impl Fn(&Path) -> Option<CachedCreds>,
    write_cache: impl Fn(&Path, &CachedCreds),
    read_file: impl Fn(&Path) -> std::io::Result<String>,
    read_keychain: impl Fn(&str, &str) -> Result<String, KeychainMiss>,
) -> Result<String, String> {
    let was_empty = config_dir.is_empty();
    let dir = resolve_config_dir_with(config_dir, home)?;

    // 0. Sparkle's own cache FIRST — a plain file, so no keychain access and no macOS prompt. Only a
    // FRESH entry short-circuits; a stale/absent/corrupt one falls through to re-read below. SKIPPED
    // entirely when `bypass_cache` (the forced refresh): the read falls through to the keychain so the
    // token is re-resolved from source. The cache file is left ON DISK — not deleted — so a forced
    // read that then fails does not cost the account its previously-working cached token.
    let cache_path = Path::new(&dir).join(SPARKLE_USAGE_CACHE_FILE);
    if !bypass_cache {
        if let Some(cached) = read_cache(&cache_path) {
            if cache_is_fresh(&cached, now_ms) {
                return Ok(cached.access_token);
            }
        }
    }

    // 1. Per-dir credentials file, if it exists and holds a token.
    let creds_path = Path::new(&dir).join(".credentials.json");
    let mut blob: Option<String> = None;
    if let Ok(contents) = read_file(&creds_path) {
        if extract_access_token(&contents).is_some() {
            blob = Some(contents);
        }
    }

    // 2. macOS keychain. account = the current username. Probe each candidate service in order (the
    // default account needs the BARE name first, then the hashed form — see keychain_services); the
    // first that yields a usable token wins. A missing/failed entry falls through to the next.
    if blob.is_none() {
        let user = user
            .filter(|u| !u.is_empty())
            .ok_or_else(|| "no USER env for keychain lookup".to_string())?;
        let mut last_err: Option<String> = None;
        let mut denied: Option<String> = None;
        for service in keychain_services(was_empty, &dir) {
            match read_keychain(&service, user) {
                Ok(password) => {
                    if extract_access_token(&password).is_some() {
                        blob = Some(password);
                        break;
                    }
                }
                // Nothing stored under this service, or we never reached a lookup: no dialog was
                // raised, so trying the next candidate costs the user nothing.
                Err(KeychainMiss::NoEntry) => {
                    last_err = Some("no keychain entry for this account".to_string());
                }
                Err(KeychainMiss::Other(e)) => last_err = Some(e),
                // The keychain answered "no" for an item that exists. STOP: the default account
                // probes two services (see keychain_services), and continuing would raise a SECOND
                // modal for the same account on a machine that already declined the first.
                Err(KeychainMiss::Denied(e)) => {
                    denied = Some(e);
                    break;
                }
            }
        }
        if blob.is_none() {
            // A denial outranks an absence: it is an UNKNOWN outcome, not "this account has no
            // credential", and the prefix is what lets a caller tell the two apart.
            if let Some(e) = denied {
                return Err(format!("{KEYCHAIN_DENIED_PREFIX}: {e}"));
            }
            return Err(
                last_err.unwrap_or_else(|| "no access token in stored credentials".to_string())
            );
        }
    }

    // A credential was resolved from disk or the keychain. Cache it (with its expiry) so the NEXT
    // fetch takes path (0) and never touches the keychain until this token lapses.
    let blob = blob.expect("blob is Some here: every path above either set it or returned");
    let creds = extract_credentials(&blob)
        .ok_or_else(|| "no access token in stored credentials".to_string())?;
    write_cache(&cache_path, &creds);
    Ok(creds.access_token)
}

// ---- Tauri command ------------------------------------------------------------------------------

/// Fetch REAL live usage for the account identified by `config_dir`. Reads the bearer token (creds
/// file → keychain), calls Anthropic's OAuth usage endpoint, and returns the parsed windows.
///
/// On ANY failure (no token, network error, 401, unparseable body) returns `Err(String)` — the UI
/// degrades to "usage unavailable" and the local-tally estimate remains the fallback. Never panics.
///
/// `force` (default `false`, so an absent JS key behaves exactly as before) makes the token read
/// BYPASS Sparkle's `<dir>/.sparkle-usage-cache.json`: it skips serving the cached token and reads
/// the account's creds file / keychain directly, then rewrites the cache with whatever it read. This
/// is the "Refresh usage" button's path — the founder wants a deliberate, keychain-backed re-check on
/// demand, and a macOS keychain prompt on the forced read is EXPECTED and acceptable, not something
/// to suppress. A non-forced fetch keeps serving a fresh cached token with no keychain access (the
/// default, quiet path the per-account effect uses on every screen open).
///
/// HONEST SCOPE (do not overstate this): the cache holds only the OAuth **token**, never the usage
/// figures — `http_get_usage` runs on EVERY call, forced or not — so an un-forced fetch already
/// returns current 5h/7d numbers. What `force` changes is the TOKEN: it guarantees a fresh
/// keychain-backed read (the founder's expected "it really re-checked" signal, and it replaces a
/// token that silently rotated before its recorded expiry without waiting for a 401). It is
/// deliberately NON-DESTRUCTIVE — the bypass SKIPS the cache rather than deleting it, so a forced
/// read that fails (a denied keychain prompt) leaves the previously-cached token intact and the quiet
/// per-account effect keeps serving it, rather than turning every later screen open into a prompt.
///
/// BOTH the keychain read and the `ureq` call BLOCK: a macOS confidential-info prompt can stall the
/// `get_password` indefinitely, and a black-holed host holds the HTTP call up to `HTTP_TIMEOUT`
/// (15s). A Tauri `async` command runs on the SHARED tokio runtime, so doing that work inline would
/// pin a runtime worker for the whole duration — and the frontend fans this out across every account
/// at once, so N stalls could starve unrelated async IPC. We therefore run it on the blocking-task
/// pool via `spawn_blocking` (mirrors `window_screenshot.rs` / `onepassword.rs`) and await the join.
#[tauri::command]
pub async fn account_usage_live(
    config_dir: String,
    force: Option<bool>,
) -> Result<AccountUsageLive, String> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || fetch_usage_blocking(&config_dir, force))
        .await
        .map_err(|e| format!("usage task failed: {e}"))?
}

/// Outcome of one usage HTTP call, distinguishing the ONE status that means "this token is stale"
/// (401 → drop the cache and re-read the keychain once) from every other failure (surfaced as-is).
enum UsageFetchError {
    /// The server rejected the bearer token (HTTP 401). The cached token may have gone stale before
    /// its recorded `expiresAt` (e.g. `claude` rotated it); invalidate the cache and retry once.
    Unauthorized,
    /// Any other failure — network error, non-401 status, unreadable body.
    Other(String),
}

/// One bearer-authed GET of the usage endpoint, mapping a 401 to [`UsageFetchError::Unauthorized`].
fn http_get_usage(token: &str) -> Result<String, UsageFetchError> {
    match ureq::get(USAGE_URL)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .set("anthropic-beta", OAUTH_BETA)
        .call()
    {
        Ok(resp) => resp
            .into_string()
            .map_err(|e| UsageFetchError::Other(e.to_string())),
        Err(ureq::Error::Status(401, _)) => Err(UsageFetchError::Unauthorized),
        Err(e) => Err(UsageFetchError::Other(format!("usage fetch failed: {e}"))),
    }
}

/// The blocking body of [`account_usage_live`]: read the token, GET the endpoint, parse. Synchronous
/// on purpose — it runs on the blocking-task pool, never a shared async worker. `force` makes the
/// token read bypass the TTL cache (see [`account_usage_live`]); it is threaded into the read, NOT a
/// pre-emptive cache delete, so a failed forced read leaves the cached token intact.
fn fetch_usage_blocking(config_dir: &str, force: bool) -> Result<AccountUsageLive, String> {
    fetch_usage_with(
        config_dir,
        force,
        |cd, bypass_cache| read_access_token(cd, bypass_cache),
        |cd| invalidate_cache(cd),
        |token| http_get_usage(token),
    )
}

/// The token-read → fetch → (on 401) invalidate-and-retry-once flow, with the token read, cache
/// invalidation, and HTTP call injected so the 401 recovery is unit-testable without a keychain or a
/// network. A first-attempt 401 means the CACHED token was rejected: we drop the cache (so the retry
/// re-reads the keychain, popping exactly one prompt) and try once more. A second 401 is terminal —
/// we never loop.
///
/// `bypass_cache` is passed straight to the token read: when set, the read SKIPS Sparkle's cached
/// token and reads the creds file / keychain directly (rewriting the cache on success). This is the
/// forced "Refresh usage" path. Crucially it does NOT delete the cache up front — a forced read that
/// fails leaves the prior cached token in place — which is why it is a read flag rather than the
/// `invalidate` the 401 path (correctly) uses only after the server has PROVEN the token dead.
fn fetch_usage_with(
    config_dir: &str,
    bypass_cache: bool,
    read_token: impl Fn(&str, bool) -> Result<String, String>,
    invalidate: impl Fn(&str),
    http_get: impl Fn(&str) -> Result<String, UsageFetchError>,
) -> Result<AccountUsageLive, String> {
    let token = read_token(config_dir, bypass_cache)?;
    match http_get(&token) {
        Ok(text) => parse_usage_response(&text),
        Err(UsageFetchError::Other(e)) => Err(e),
        Err(UsageFetchError::Unauthorized) => {
            // Cached token rejected — drop the cache so the re-read hits the keychain, then retry ONCE.
            invalidate(config_dir);
            let token = read_token(config_dir, bypass_cache)?;
            match http_get(&token) {
                Ok(text) => parse_usage_response(&text),
                Err(UsageFetchError::Other(e)) => Err(e),
                Err(UsageFetchError::Unauthorized) => {
                    Err("usage fetch failed: unauthorized after keychain re-read".to_string())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The confirmed-live response shape, with NEUTRAL values (never a real account's numbers).
    const FIXTURE: &str = r#"{
      "five_hour":  { "utilization": 42.0, "resets_at": "2026-08-12T04:09:59.793055+00:00", "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
      "seven_day":  { "utilization": 15.0, "resets_at": "2026-08-17T10:59:59.793078+00:00", "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
      "seven_day_opus": null, "seven_day_sonnet": null, "seven_day_cowork": null,
      "extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null, "utilization": null, "spend_limit_reached": false },
      "limits": [
        { "kind": "session",       "group": "session", "percent": 42, "severity": "warning", "resets_at": "2026-08-12T04:09:59.793055+00:00", "scope": null, "is_active": true },
        { "kind": "weekly_all",    "group": "weekly",  "percent": 15, "severity": "normal",  "resets_at": "2026-08-17T10:59:59.793078+00:00", "scope": null, "is_active": false },
        { "kind": "weekly_scoped", "group": "weekly",  "percent": 0,  "severity": "normal",  "resets_at": null, "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null }, "is_active": false }
      ]
    }"#;

    #[test]
    fn parses_the_confirmed_fixture() {
        let out = parse_usage_response(FIXTURE).expect("fixture must parse");
        assert_eq!(out.five_hour_percent, Some(42.0));
        assert_eq!(out.seven_day_percent, Some(15.0));
        assert_eq!(
            out.five_hour_resets_at.as_deref(),
            Some("2026-08-12T04:09:59.793055+00:00")
        );
        assert_eq!(
            out.seven_day_resets_at.as_deref(),
            Some("2026-08-17T10:59:59.793078+00:00")
        );
        // The whole limits array survives the passthrough, including the scoped window with a null
        // reset and the extra `scope` key ignored.
        assert_eq!(out.limits.len(), 3);
        assert_eq!(out.limits[0].kind.as_deref(), Some("session"));
        assert_eq!(out.limits[0].is_active, Some(true));
        assert_eq!(out.limits[2].resets_at, None);

        // WHICH MODEL'S weekly window is this? Before `scope` was modelled, a `weekly_scoped` row
        // arrived with no model attached and this question was unanswerable from the projection —
        // so this assertion could not have passed against the previous code (non-vacuous).
        assert_eq!(out.limits[2].kind.as_deref(), Some("weekly_scoped"));
        assert_eq!(
            out.limits[2]
                .scope
                .as_ref()
                .and_then(|sc| sc.model.as_ref())
                .and_then(|m| m.display_name.as_deref()),
            Some("Fable")
        );
        // …and the model `id` upstream sends as null stays None rather than becoming an empty string.
        assert_eq!(
            out.limits[2]
                .scope
                .as_ref()
                .and_then(|sc| sc.model.as_ref())
                .and_then(|m| m.id.as_deref()),
            None
        );
        // The unscoped rows carry `"scope": null` on the wire — that must project to None, not to a
        // Some(..) holding an empty scope.
        assert!(out.limits[0].scope.is_none());
        assert!(out.limits[1].scope.is_none());

        // WHICH METER is this account spending against? `extra_usage` was dropped entirely before;
        // now the usage-credits meter is readable, and on this fixture it reads "off, not capped".
        let extra = out
            .extra_usage
            .as_ref()
            .expect("the fixture carries extra_usage, so it must project");
        assert_eq!(extra.is_enabled, Some(false));
        assert_eq!(extra.spend_limit_reached, Some(false));
        // The three nullable figures stay None rather than defaulting to 0 — a fabricated 0 credits
        // used would read as a live-but-unspent credits meter.
        assert_eq!(extra.monthly_limit, None);
        assert_eq!(extra.used_credits, None);
        assert_eq!(extra.utilization, None);
    }

    #[test]
    fn null_extra_usage_yields_none_and_the_rest_still_parses() {
        // FAIL-SOFT INVARIANT. `"extra_usage": null` is the same null-valued-key shape the windows
        // use. A non-`Option` field (or one relying on `#[serde(default)]` alone) would fail with
        // `invalid type: null, expected a struct` and reject the WHOLE payload — blanking the usage
        // display over one key. The windows and limits beside it must survive untouched.
        let json = r#"{
          "five_hour": { "utilization": 42.0, "resets_at": "2026-08-12T04:09:59+00:00" },
          "extra_usage": null,
          "limits": [ { "kind": "session", "percent": 42, "scope": null } ]
        }"#;
        let out = parse_usage_response(json).expect("a null extra_usage must not fail the parse");
        assert!(out.extra_usage.is_none());
        assert_eq!(out.five_hour_percent, Some(42.0));
        assert_eq!(out.limits.len(), 1);
        assert_eq!(out.limits[0].kind.as_deref(), Some("session"));
    }

    #[test]
    fn absent_scope_key_yields_none_and_the_rest_still_parses() {
        // The other half of the invariant: a `limits[]` row with NO `scope` key at all (and a
        // payload with no `extra_usage` key at all) must still parse everything else. Absent and
        // null both map to None — neither may reject the payload.
        let json = r#"{
          "seven_day": { "utilization": 15.0, "resets_at": "2026-08-17T10:59:59+00:00" },
          "limits": [
            { "kind": "weekly_all", "group": "weekly", "percent": 15, "is_active": false }
          ]
        }"#;
        let out = parse_usage_response(json).expect("an absent scope key must not fail the parse");
        assert_eq!(out.limits.len(), 1);
        assert!(out.limits[0].scope.is_none());
        assert_eq!(out.limits[0].percent, Some(15.0));
        assert!(out.extra_usage.is_none());
        assert_eq!(out.seven_day_percent, Some(15.0));
    }

    #[test]
    fn a_live_credits_meter_at_its_spend_limit_is_readable() {
        // The case the UI exists for: credits ON, money spent, and the hard stop reached. Every one
        // of these five fields has to survive the projection or the human sees a subscription-only
        // story while their fleet is actually burning credits (or already stopped).
        let json = r#"{
          "extra_usage": {
            "is_enabled": true, "monthly_limit": 200.0, "used_credits": 199.5,
            "utilization": 99.75, "spend_limit_reached": true
          }
        }"#;
        let out = parse_usage_response(json).expect("a populated extra_usage must parse");
        let extra = out.extra_usage.expect("extra_usage must project");
        assert_eq!(extra.is_enabled, Some(true));
        assert_eq!(extra.monthly_limit, Some(200.0));
        assert_eq!(extra.used_credits, Some(199.5));
        assert_eq!(extra.utilization, Some(99.75));
        assert_eq!(extra.spend_limit_reached, Some(true));
    }

    #[test]
    fn a_wrong_typed_credits_member_degrades_instead_of_taking_the_whole_payload_down() {
        // THE REGRESSION THIS MODULE IS SHAPED TO PREVENT, newly reachable because `extra_usage`
        // stopped being an ignored unknown key and became a modelled subtree.
        //
        // A decimal string for money is an ordinary billing-API convention. With plain
        // `Option<f64>` it is a HARD parse error, so `parse_usage_response` returns `Err` and
        // `account_usage_live` rejects the entire payload — the 5-hour and 7-day bars go dark, and
        // precisely for the accounts that have credits enabled. `Option` + `default` does not help:
        // it covers null and absent, never a wrong type.
        //
        // The assertion that carries the weight is the SIBLING one: `five_hour_percent` must still
        // be 42. A test that only checked the bad member could pass while the payload died.
        let json = r#"{
          "five_hour": { "utilization": 42.0 },
          "extra_usage": { "is_enabled": false, "used_credits": {"nested": "garbage"}, "monthly_limit": [1,2] }
        }"#;
        let out = parse_usage_response(json).expect("a wrong-typed member must NOT reject the payload");
        assert_eq!(out.five_hour_percent, Some(42.0), "the subscription window must survive");
        let extra = out.extra_usage.expect("the meter block itself still projects");
        assert_eq!(extra.used_credits, None, "an unreadable figure degrades to None");
        assert_eq!(extra.monthly_limit, None, "…and so does an unreadable ceiling");
        // The readable sibling inside the SAME block is still read — degradation is per-member.
        assert_eq!(extra.is_enabled, Some(false));
    }

    #[test]
    fn money_and_booleans_sent_as_strings_are_read_rather_than_discarded() {
        // The likeliest drift, and the one worth accepting rather than merely surviving: upstream
        // sending `"199.50"` instead of `199.5`. Degrading it to `None` would be safe but would
        // blank the figure the credits UI exists to show, so a parseable numeric string is read.
        let json = r#"{
          "extra_usage": {
            "is_enabled": "true", "used_credits": "199.50", "monthly_limit": "200",
            "spend_limit_reached": "false"
          }
        }"#;
        let out = parse_usage_response(json).expect("string-encoded scalars must parse");
        let extra = out.extra_usage.expect("meter must project");
        assert_eq!(extra.is_enabled, Some(true));
        assert_eq!(extra.used_credits, Some(199.5));
        assert_eq!(extra.monthly_limit, Some(200.0));
        assert_eq!(extra.spend_limit_reached, Some(false));
    }

    #[test]
    fn an_unreadable_is_enabled_degrades_toward_REFUSING_never_toward_permission() {
        // The direction of the degradation is the safety property, not an implementation detail.
        // `spendGate.ts` permits ONLY on an explicit `false`; `None` reads as "cannot prove credits
        // are disarmed" and refuses. So a garbled meter can never be mistaken for permission — the
        // worst case is an advisor pass that declines to run, never one that spends. A `false`
        // default here, which would look equally "safe" at a glance, would invert exactly that.
        let json = r#"{ "extra_usage": { "is_enabled": 1, "spend_limit_reached": "yes" } }"#;
        let out = parse_usage_response(json).expect("must not reject");
        let extra = out.extra_usage.expect("meter must project");
        assert_eq!(extra.is_enabled, None, "an unreadable armed-flag must NOT become false");
        assert_eq!(extra.spend_limit_reached, None, "nor must an unreadable limit become false");
    }

    #[test]
    fn a_wrong_typed_scope_model_name_does_not_reject_the_limits_array() {
        // Same class as the credits case, on the other subtree this branch newly models. The whole
        // `limits` array — and with it every subscription window — used to be at risk from one
        // unquoted id.
        let json = r#"{
          "five_hour": { "utilization": 7.0 },
          "limits": [
            { "kind": "weekly_scoped", "scope": { "model": { "id": 12345, "display_name": ["Fable"] } } }
          ]
        }"#;
        let out = parse_usage_response(json).expect("must not reject the payload");
        assert_eq!(out.five_hour_percent, Some(7.0));
        let scope = out.limits[0].scope.as_ref().expect("scope projects");
        let model = scope.model.as_ref().expect("model projects");
        assert_eq!(model.id.as_deref(), Some("12345"), "an unquoted id is rendered, not dropped");
        assert_eq!(model.display_name, None, "a structural value degrades to None");
    }

    #[test]
    fn the_serialized_key_names_are_exactly_what_the_advisor_spend_gate_reads() {
        // THE SEAM TEST, and the one the advisor could not write for itself.
        //
        // `services/advisor/spendGate.ts` reads `extraUsage.isEnabled` / `.spendLimitReached` /
        // `.usedCredits` off this payload, and until this passthrough landed there was no
        // serializing struct to check it against — so `deps.ts` carried an unverifiable cast and a
        // tripwire instead. The drift it could not catch is serde's: `rename_all` does NOT descend
        // into a nested struct, so an inner type missing its own `rename_all` would emit
        // `extraUsage.is_enabled`, every account would fold to "field absent", and the gate would
        // refuse FOREVER — indistinguishable from an account with credits armed, with nothing in
        // the app reporting the difference.
        //
        // Asserting on the SERIALIZED JSON rather than the Rust field names is the whole point: the
        // Rust names are snake_case in both the correct and the broken case, so only this can tell
        // them apart.
        let json = r#"{
          "extra_usage": {
            "is_enabled": false, "monthly_limit": 200.0, "used_credits": 47.5,
            "utilization": 23.75, "spend_limit_reached": false
          }
        }"#;
        let out = parse_usage_response(json).expect("fixture must parse");
        let v = serde_json::to_value(&out).expect("AccountUsageLive must serialize");

        // The outer key the gate destructures.
        let extra = v
            .get("extraUsage")
            .expect("the JS boundary must receive `extraUsage`, not `extra_usage`");
        // Every inner key the gate reads, by its exact camelCase name.
        for key in ["isEnabled", "monthlyLimit", "usedCredits", "utilization", "spendLimitReached"] {
            assert!(
                extra.get(key).is_some(),
                "spendGate.ts reads `extraUsage.{key}` — a missing inner rename_all would send \
                 snake_case here and leave the advisor permanently refusing",
            );
        }
        // …and the snake_case forms must NOT also be present, or a partial rename would pass above
        // while still sending the wrong shape.
        assert!(v.get("extra_usage").is_none(), "snake_case outer key must not reach JS");
        for key in ["is_enabled", "used_credits", "spend_limit_reached"] {
            assert!(extra.get(key).is_none(), "snake_case inner key `{key}` must not reach JS");
        }
        // The values survive too — a rename test that passed on an all-null meter would prove
        // nothing about the field the gate actually branches on.
        assert_eq!(extra.get("isEnabled").and_then(|x| x.as_bool()), Some(false));
        assert_eq!(extra.get("usedCredits").and_then(|x| x.as_f64()), Some(47.5));
    }

    #[test]
    fn extra_usage_with_null_members_parses_to_a_present_but_empty_meter() {
        // `extra_usage` PRESENT with every member null — proves the `Option` on each FIELD, not just
        // on the struct. A non-Option `bool` on `is_enabled` would error here and take the payload
        // with it.
        let json = r#"{
          "five_hour": { "utilization": 1.0 },
          "extra_usage": { "is_enabled": null, "monthly_limit": null, "used_credits": null, "utilization": null, "spend_limit_reached": null }
        }"#;
        let out = parse_usage_response(json).expect("null members must not fail the parse");
        let extra = out.extra_usage.expect("a present-but-empty meter is still Some");
        assert_eq!(extra.is_enabled, None);
        assert_eq!(extra.spend_limit_reached, None);
        assert_eq!(out.five_hour_percent, Some(1.0));
    }

    #[test]
    fn a_scope_with_a_null_model_still_parses() {
        // `scope` present but `scope.model` null — a shape upstream can send for a surface-scoped
        // (non-model) window. The row must survive with `scope: Some(..)` and `model: None`.
        let json = r#"{
          "limits": [ { "kind": "weekly_scoped", "percent": 3, "scope": { "model": null, "surface": null } } ]
        }"#;
        let out = parse_usage_response(json).expect("a null model must not fail the parse");
        let scope = out.limits[0].scope.as_ref().expect("scope object is present");
        assert!(scope.model.is_none());
        assert_eq!(out.limits[0].percent, Some(3.0));
    }

    #[test]
    fn null_window_yields_none_not_error() {
        // THE ASSERTION THAT MATTERS: a `null` five_hour window must parse to `None`, not blow up the
        // whole payload. If `five_hour` were a non-`Option` field, serde would ERROR on the null and
        // this would fail — proving the Option handling is load-bearing (non-vacuous).
        let json = r#"{
          "five_hour": null,
          "seven_day": { "utilization": 15.0, "resets_at": "2026-08-17T10:59:59+00:00" }
        }"#;
        let out = parse_usage_response(json).expect("a null window must not fail the parse");
        assert_eq!(out.five_hour_percent, None);
        assert_eq!(out.five_hour_resets_at, None);
        // The sibling window is unaffected.
        assert_eq!(out.seven_day_percent, Some(15.0));
    }

    #[test]
    fn absent_window_yields_none() {
        // A window key that is entirely absent must also be `None`, not an error (serde default).
        let out = parse_usage_response(r#"{ "seven_day_opus": null }"#).expect("absent keys ok");
        assert_eq!(out.five_hour_percent, None);
        assert_eq!(out.seven_day_percent, None);
        assert!(out.limits.is_empty());
    }

    #[test]
    fn null_limits_yields_empty_vec_not_error() {
        // `"limits": null` is the same null-valued-key shape the windows use. A bare `Vec` with
        // `#[serde(default)]` would reject the WHOLE payload here (`invalid type: null, expected a
        // sequence`) — the all-or-nothing failure this module exists to prevent. `Option<Vec>` +
        // unwrap_or_default maps it to an empty vec while the windows still parse.
        let json = r#"{ "five_hour": { "utilization": 5.0 }, "limits": null }"#;
        let out = parse_usage_response(json).expect("null limits must not fail the parse");
        assert!(out.limits.is_empty());
        assert_eq!(out.five_hour_percent, Some(5.0));
    }

    #[test]
    fn present_window_with_null_utilization_is_none_percent() {
        // A window OBJECT present but its `utilization` null — proves the `Option<f64>` on the field,
        // not just the `Option<WireWindow>` on the window. A non-Option `f64` here would error.
        let json = r#"{ "five_hour": { "utilization": null, "resets_at": "2026-08-12T04:09:59+00:00" } }"#;
        let out = parse_usage_response(json).expect("null utilization must not fail");
        assert_eq!(out.five_hour_percent, None);
        assert_eq!(
            out.five_hour_resets_at.as_deref(),
            Some("2026-08-12T04:09:59+00:00")
        );
    }

    #[test]
    fn serializes_camel_case_for_js_boundary() {
        let out = parse_usage_response(FIXTURE).unwrap();
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&out).unwrap()).unwrap();
        // The JS side reads these exact keys.
        assert_eq!(v["fiveHourPercent"], 42.0);
        assert_eq!(v["sevenDayPercent"], 15.0);
        assert_eq!(v["fiveHourResetsAt"], "2026-08-12T04:09:59.793055+00:00");
        assert_eq!(v["limits"][0]["isActive"], true);
    }

    #[test]
    fn malformed_json_is_err_not_panic() {
        assert!(parse_usage_response("not json at all").is_err());
    }

    #[test]
    fn keychain_service_matches_sha256_vector() {
        // SHA-256("abc") = ba7816bf8f01cfea41…; first 8 hex chars = "ba7816bf". A public test vector,
        // so this pins the hashing + lowercase-hex + 4-byte truncation without embedding any real
        // path. If any of those drifted, the derived keychain service name would be wrong and every
        // keychain read would miss.
        assert_eq!(keychain_service("abc"), "Claude Code-credentials-ba7816bf");
    }

    #[test]
    fn extract_access_token_reads_the_nested_field() {
        // Neutral, non-secret placeholder token.
        let creds = r#"{"claudeAiOauth":{"accessToken":"neutral-test-token","refreshToken":"r","expiresAt":123}}"#;
        assert_eq!(extract_access_token(creds).as_deref(), Some("neutral-test-token"));
        // Wrong shapes and empty tokens yield None, not a panic.
        assert_eq!(extract_access_token(r#"{"claudeAiOauth":{"accessToken":""}}"#), None);
        assert_eq!(extract_access_token(r#"{"other":1}"#), None);
        assert_eq!(extract_access_token("garbage"), None);
    }

    #[test]
    fn resolve_config_dir_preserves_exact_bytes() {
        // BYTE-IDENTITY (bead sparkle-znusx): the keychain service is sha256(config_dir) over the
        // path AS GIVEN. A trailing slash must be PRESERVED — trimming it would derive a different
        // service name than the credential `claude` stored, and the lookup would miss. This test
        // asserts NON-normalization on purpose; an earlier version enshrined the trim it forbids.
        assert_eq!(resolve_config_dir_with("/some/dir", None).unwrap(), "/some/dir");
        assert_eq!(resolve_config_dir_with("/some/dir/", None).unwrap(), "/some/dir/");
    }

    #[test]
    fn resolve_config_dir_empty_falls_back_to_home_claude() {
        // The DEFAULT account stores config_dir="" and depends on this resolution. Injected home so
        // the test is deterministic and doesn't mutate process env under parallel tests.
        assert_eq!(
            resolve_config_dir_with("", Some("/home/tester")).unwrap(),
            "/home/tester/.claude"
        );
        // A trailing slash on HOME is absorbed (we construct our own canonical path here).
        assert_eq!(
            resolve_config_dir_with("", Some("/home/tester/")).unwrap(),
            "/home/tester/.claude"
        );
        // No HOME at all is an error, not a panic.
        assert!(resolve_config_dir_with("", None).is_err());
    }

    #[test]
    fn read_access_token_prefers_creds_file_when_it_has_a_token() {
        // The creds file wins and the keychain is NEVER consulted.
        let token = read_access_token_with(
            "/cfg/a",
            None,
            Some("tester"),
            |_p| Ok(r#"{"claudeAiOauth":{"accessToken":"from-file"}}"#.to_string()),
            |_s, _u| panic!("keychain must not be read when the creds file has a token"),
        )
        .unwrap();
        assert_eq!(token, "from-file");
    }

    #[test]
    fn read_access_token_falls_through_to_keychain_when_creds_absent_or_empty() {
        // Creds file absent (io error) → keychain.
        let via_absent = read_access_token_with(
            "/cfg/a",
            None,
            Some("tester"),
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no file")),
            |_s, _u| Ok(r#"{"claudeAiOauth":{"accessToken":"from-keychain"}}"#.to_string()),
        )
        .unwrap();
        assert_eq!(via_absent, "from-keychain");

        // Creds file PRESENT but its token is empty → must FALL THROUGH to the keychain, not fail.
        let via_empty = read_access_token_with(
            "/cfg/a",
            None,
            Some("tester"),
            |_p| Ok(r#"{"claudeAiOauth":{"accessToken":""}}"#.to_string()),
            |_s, _u| Ok(r#"{"claudeAiOauth":{"accessToken":"from-keychain"}}"#.to_string()),
        )
        .unwrap();
        assert_eq!(via_empty, "from-keychain");
    }

    #[test]
    fn default_account_reads_the_bare_keychain_service_first() {
        // THE DEFAULT ACCOUNT (config_dir="") — the common case. `claude` spawns it with NO
        // CLAUDE_CONFIG_DIR, so its credential is under the BARE service "Claude Code-credentials",
        // NOT the hashed sha256($HOME/.claude) form (claudeSpawn.ts:245). The probe must ask for the
        // bare name first; asking only the hashed name (an earlier bug) missed the credential.
        let token = read_access_token_with(
            "",
            Some("/home/tester"),
            Some("tester"),
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no file")),
            move |service, user| {
                assert_eq!(user, "tester");
                if service == BARE_KEYCHAIN_SERVICE {
                    Ok(r#"{"claudeAiOauth":{"accessToken":"default-bare-token"}}"#.to_string())
                } else {
                    panic!("bare service must be tried first, got {service}");
                }
            },
        )
        .unwrap();
        assert_eq!(token, "default-bare-token");
    }

    #[test]
    fn default_account_falls_back_to_the_hashed_home_claude_service() {
        // If the bare item is absent, the default account probes the hashed $HOME/.claude form as a
        // secondary — a machine may hold that from a CLAUDE_CONFIG_DIR=~/.claude run. Proves the
        // ordered multi-probe, not just the first entry.
        let hashed = keychain_service("/home/tester/.claude");
        let token = read_access_token_with(
            "",
            Some("/home/tester"),
            Some("tester"),
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no file")),
            move |service, _u| {
                if service == BARE_KEYCHAIN_SERVICE {
                    // ABSENT, not denied — the one miss that must keep probing.
                    Err(KeychainMiss::NoEntry)
                } else if service == hashed {
                    Ok(r#"{"claudeAiOauth":{"accessToken":"hashed-fallback-token"}}"#.to_string())
                } else {
                    panic!("unexpected service {service}");
                }
            },
        )
        .unwrap();
        assert_eq!(token, "hashed-fallback-token");
    }

    #[test]
    fn explicit_config_dir_uses_only_the_hashed_service_over_the_exact_bytes() {
        // A NAMED account with an explicit dir: hashed service over the path AS GIVEN, and the bare
        // service is NOT consulted (that name belongs to the default account alone).
        let expected = keychain_service("/some/dir");
        let token = read_access_token_with(
            "/some/dir",
            None,
            Some("tester"),
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no file")),
            move |service, _u| {
                assert_eq!(service, expected, "must use the hashed service over the exact bytes");
                Ok(r#"{"claudeAiOauth":{"accessToken":"named-token"}}"#.to_string())
            },
        )
        .unwrap();
        assert_eq!(token, "named-token");
    }

    #[test]
    fn read_access_token_errors_without_a_user_for_the_keychain() {
        // No creds file and no USER → a stable Err, never a panic.
        let err = read_access_token_with(
            "/cfg/a",
            None,
            None,
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no file")),
            |_s, _u| Ok("unused".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("USER"));
    }

    // ---- keychain DENIAL vs ABSENCE -------------------------------------------------------------

    #[test]
    fn a_keychain_denial_stops_the_probe_instead_of_raising_a_second_prompt() {
        // THE BUG: the default account probes TWO services, so an ungranted machine got a modal per
        // service — two blocking dialogs for one account, on a machine with nobody at it. Assert the
        // SIDE EFFECT (which services were actually asked), not just the returned error: before the
        // fix the hashed service WAS probed after the bare one was denied.
        let probed = std::cell::RefCell::new(Vec::<String>::new());
        let err = read_access_token_with(
            "",
            Some("/home/tester"),
            Some("tester"),
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no file")),
            |service, _u| {
                probed.borrow_mut().push(service.to_string());
                Err(KeychainMiss::Denied("user declined".to_string()))
            },
        )
        .unwrap_err();

        assert_eq!(
            probed.borrow().as_slice(),
            &[BARE_KEYCHAIN_SERVICE.to_string()],
            "a denial must end the probe: the second service would be a second modal"
        );
        assert!(
            is_keychain_permission_error(&err),
            "a denial must be reported as a permission outcome, not as a missing credential: {err}"
        );
    }

    #[test]
    fn an_absent_entry_keeps_probing_and_is_not_reported_as_a_denial() {
        // The other half of the pair: the SAME setup, with the miss classified as an absence instead
        // of a denial, must probe BOTH services and must NOT claim a permission problem. Without
        // this, "stop on a miss" would pass the test above while breaking the default account.
        let probed = std::cell::RefCell::new(Vec::<String>::new());
        let err = read_access_token_with(
            "",
            Some("/home/tester"),
            Some("tester"),
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no file")),
            |service, _u| {
                probed.borrow_mut().push(service.to_string());
                Err(KeychainMiss::NoEntry)
            },
        )
        .unwrap_err();

        assert_eq!(probed.borrow().len(), 2, "an absence must fall through to the next service");
        assert!(
            !is_keychain_permission_error(&err),
            "an absent credential is not a permission problem: {err}"
        );
    }

    #[test]
    fn the_signin_filter_keeps_an_acl_denied_account_and_drops_a_credential_less_one() {
        // The consequence of the classification, at the one place it changes production behavior:
        // an unreadable-because-ungranted account must NOT be filtered out of roborev rotation.
        assert!(credential_is_usable(Ok("tok".to_string())));
        assert!(
            credential_is_usable(Err(format!("{KEYCHAIN_DENIED_PREFIX}: user declined"))),
            "a denial is UNKNOWN, not signed-out: dropping it removes a usable account"
        );
        assert!(!credential_is_usable(Err(
            "no access token in stored credentials".to_string()
        )));
    }

    #[test]
    fn classify_keychain_error_separates_no_entry_from_everything_else() {
        // NoEntry is the only variant that PROVES nothing is stored; every other failure reached the
        // keychain and came back without the secret, which is the ACL path.
        assert!(matches!(
            classify_keychain_error(keyring::Error::NoEntry),
            KeychainMiss::NoEntry
        ));
        assert!(matches!(
            classify_keychain_error(keyring::Error::Ambiguous(Vec::new())),
            KeychainMiss::Denied(_)
        ));
    }

    // ---- Sparkle usage-cache (keychain-prompt suppression) --------------------------------------

    use std::cell::RefCell;

    #[test]
    fn extract_credentials_reads_the_full_triple() {
        // Neutral, non-secret placeholders.
        let creds = r#"{"claudeAiOauth":{"accessToken":"neutral-access","refreshToken":"neutral-refresh","expiresAt":1710000000000}}"#;
        let c = extract_credentials(creds).expect("must parse");
        assert_eq!(c.access_token, "neutral-access");
        assert_eq!(c.refresh_token.as_deref(), Some("neutral-refresh"));
        assert_eq!(c.expires_at, 1710000000000);

        // Missing refresh/expiry default to None/0 (not an error), as long as the access token is there.
        let minimal = r#"{"claudeAiOauth":{"accessToken":"only-access"}}"#;
        let m = extract_credentials(minimal).expect("access-only must parse");
        assert_eq!(m.access_token, "only-access");
        assert_eq!(m.refresh_token, None);
        assert_eq!(m.expires_at, 0);

        // No usable access token → None, never a panic.
        assert!(extract_credentials(r#"{"claudeAiOauth":{"accessToken":""}}"#).is_none());
        assert!(extract_credentials(r#"{"other":1}"#).is_none());
    }

    #[test]
    fn cache_is_fresh_respects_expiry_and_skew() {
        let base = CachedCreds {
            access_token: "t".to_string(),
            refresh_token: None,
            expires_at: 1_000_000,
        };
        // Comfortably before expiry → fresh.
        assert!(cache_is_fresh(&base, 500_000));
        // Past expiry → stale.
        assert!(!cache_is_fresh(&base, 1_500_000));
        // Inside the skew window before expiry → treated as stale (don't hand out a token about to lapse).
        assert!(!cache_is_fresh(&base, 1_000_000 - (CACHE_SKEW_MS - 1)));
        // Unknown expiry (0) is never fresh, even "now".
        let unknown = CachedCreds {
            expires_at: 0,
            ..base.clone()
        };
        assert!(!cache_is_fresh(&unknown, 0));
        // Empty token is never fresh regardless of expiry.
        let empty = CachedCreds {
            access_token: String::new(),
            ..base
        };
        assert!(!cache_is_fresh(&empty, 500_000));
    }

    #[test]
    fn fresh_cache_is_served_without_touching_the_keychain() {
        // (a) A fresh cached token short-circuits: the keychain seam MUST NOT be called (it panics if
        // it is), and the creds-file reader is never consulted either. This is the whole point of the
        // fix — no keychain read means no macOS prompt.
        let now = 1_000_000i64;
        let token = read_access_token_cached(
            "/cfg/a",
            None,
            Some("tester"),
            now,
            false, // not a forced refresh → the fresh cache is allowed to serve
            move |_p| {
                Some(CachedCreds {
                    access_token: "cached-token".to_string(),
                    refresh_token: None,
                    expires_at: now + 10 * 60 * 1000, // 10 min out → fresh
                })
            },
            |_p, _c| panic!("must not WRITE the cache when a fresh entry already served the token"),
            |_p| panic!("must not read the creds file when the cache is fresh"),
            |_s, _u| panic!("must not read the keychain when the cache is fresh"),
        )
        .unwrap();
        assert_eq!(token, "cached-token");
    }

    #[test]
    fn bypass_cache_skips_a_fresh_cache_reads_the_keychain_and_does_not_delete() {
        // THE FORCED "Refresh usage" PATH, non-destructive. Same fresh cache as the test above, but
        // bypass_cache=true: the fresh entry must NOT be served (the keychain IS read), the freshly
        // read token is returned and REWRITTEN to the cache, and — the non-destructive property that
        // the review flagged — nothing ever deletes the cache file (there is no invalidate seam in
        // this read path at all). Non-vacuous against the previous test: flip bypass_cache back to
        // false with this exact setup and the keychain closure's panic fires instead.
        let now = 1_000_000i64;
        let wrote: RefCell<Option<CachedCreds>> = RefCell::new(None);
        let token = read_access_token_cached(
            "/cfg/a",
            None,
            Some("tester"),
            now,
            true, // forced refresh → skip the fresh cache, read the keychain
            move |_p| {
                Some(CachedCreds {
                    access_token: "stale-but-cached".to_string(),
                    refresh_token: None,
                    expires_at: now + 10 * 60 * 1000, // still fresh — yet must be bypassed
                })
            },
            |_p, c| *wrote.borrow_mut() = Some(c.clone()),
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no creds file")),
            |_s, _u| {
                Ok(r#"{"claudeAiOauth":{"accessToken":"forced-from-keychain","expiresAt":9999999999999}}"#.to_string())
            },
        )
        .unwrap();
        // Returned the KEYCHAIN token, not the (still-fresh) cached one — the cache was bypassed.
        assert_eq!(token, "forced-from-keychain");
        // And rewrote the cache from what it read, so the next quiet fetch is served again.
        let saved = wrote.into_inner().expect("a forced read must rewrite the cache on success");
        assert_eq!(saved.access_token, "forced-from-keychain");
    }

    #[test]
    fn stale_cache_falls_back_to_keychain_and_repopulates_the_cache() {
        // (b) A cache entry whose token has lapsed must NOT be served. We fall through to the keychain
        // and REWRITE the cache with the freshly-read credential (token + its expiresAt), so the very
        // next fetch takes the cache path again. Asserts the WRITE side effect, not just the return.
        let now = 2_000_000i64;
        let written: RefCell<Option<CachedCreds>> = RefCell::new(None);
        let token = read_access_token_cached(
            "/cfg/a",
            None,
            Some("tester"),
            now,
            false, // stale-cache fallback is exercised without forcing
            move |_p| {
                Some(CachedCreds {
                    access_token: "expired-cached".to_string(),
                    refresh_token: None,
                    expires_at: now - 1, // already lapsed → stale
                })
            },
            |_p, c| *written.borrow_mut() = Some(c.clone()),
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no file")),
            |_s, _u| {
                Ok(r#"{"claudeAiOauth":{"accessToken":"fresh-from-keychain","refreshToken":"kc-refresh","expiresAt":9999999999999}}"#.to_string())
            },
        )
        .unwrap();
        // Returned the keychain token, NOT the stale cached one.
        assert_eq!(token, "fresh-from-keychain");
        // And repopulated the cache with the fresh credential (side effect that suppresses the NEXT prompt).
        let saved = written.into_inner().expect("cache must be repopulated after a keychain read");
        assert_eq!(saved.access_token, "fresh-from-keychain");
        assert_eq!(saved.refresh_token.as_deref(), Some("kc-refresh"));
        assert_eq!(saved.expires_at, 9999999999999);
    }

    #[test]
    fn absent_cache_reads_keychain_and_writes_the_cache() {
        // No cache file at all (cold start) → keychain read, and the cache is created.
        let wrote = RefCell::new(false);
        let token = read_access_token_cached(
            "",
            Some("/home/tester"),
            Some("tester"),
            0,
            false, // cold start (no cache file) — bypass is irrelevant here
            |_p| None,
            |_p, c| {
                assert_eq!(c.access_token, "default-token");
                *wrote.borrow_mut() = true;
            },
            |_p| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no file")),
            |service, _u| {
                if service == BARE_KEYCHAIN_SERVICE {
                    Ok(r#"{"claudeAiOauth":{"accessToken":"default-token","expiresAt":9999999999999}}"#.to_string())
                } else {
                    Err(KeychainMiss::NoEntry)
                }
            },
        )
        .unwrap();
        assert_eq!(token, "default-token");
        assert!(wrote.into_inner(), "cold-start read must populate the cache");
    }

    #[test]
    fn fetch_retries_once_on_401_after_invalidating_the_cache() {
        // (c) The cached token is rejected (401) on the first call. We must invalidate the cache and
        // re-read (which in production hits the keychain), then succeed on the retry. Non-vacuous: the
        // token reader returns DIFFERENT values per call and the first token 401s, so a "no retry" or
        // "no invalidate" implementation fails.
        let reads = RefCell::new(0);
        let invalidated = RefCell::new(false);
        let out = fetch_usage_with(
            "/cfg/a",
            false,
            |_cd, _bypass| {
                let mut n = reads.borrow_mut();
                *n += 1;
                Ok(if *n == 1 {
                    "stale-token".to_string()
                } else {
                    "fresh-token".to_string()
                })
            },
            |_cd| *invalidated.borrow_mut() = true,
            |token| {
                if token == "stale-token" {
                    Err(UsageFetchError::Unauthorized)
                } else {
                    Ok(r#"{"five_hour":{"utilization":7.0}}"#.to_string())
                }
            },
        )
        .expect("retry with the re-read token must succeed");
        assert_eq!(out.five_hour_percent, Some(7.0));
        assert!(*invalidated.borrow(), "a 401 must invalidate the cache");
        assert_eq!(*reads.borrow(), 2, "the token must be re-read exactly once after the 401");
    }

    #[test]
    fn fetch_does_not_retry_on_a_non_401_error() {
        // A non-401 failure is surfaced as-is with NO invalidation and NO second read — we don't want
        // a network blip to trigger a keychain prompt.
        let reads = RefCell::new(0);
        let invalidated = RefCell::new(false);
        let err = fetch_usage_with(
            "/cfg/a",
            false,
            |_cd, _bypass| {
                *reads.borrow_mut() += 1;
                Ok("tok".to_string())
            },
            |_cd| *invalidated.borrow_mut() = true,
            |_token| Err(UsageFetchError::Other("network down".to_string())),
        )
        .unwrap_err();
        assert_eq!(err, "network down");
        assert!(!*invalidated.borrow(), "a non-401 must NOT invalidate the cache");
        assert_eq!(*reads.borrow(), 1, "a non-401 must NOT re-read the token");
    }

    #[test]
    fn fetch_gives_up_after_a_second_401_without_looping() {
        // Both attempts 401 (e.g. the account is genuinely signed out). We must stop after exactly two
        // reads — never loop — and return a terminal error.
        let reads = RefCell::new(0);
        let err = fetch_usage_with(
            "/cfg/a",
            false,
            |_cd, _bypass| {
                *reads.borrow_mut() += 1;
                Ok("tok".to_string())
            },
            |_cd| {},
            |_token| Err(UsageFetchError::Unauthorized),
        )
        .unwrap_err();
        assert!(err.contains("unauthorized"));
        assert_eq!(*reads.borrow(), 2, "must attempt exactly twice, then give up");
    }

    #[test]
    fn fetch_threads_bypass_cache_into_the_token_read_and_never_pre_invalidates() {
        // THE PLUMBING that carries the "Refresh usage" force flag: fetch_usage_with must hand its
        // `bypass_cache` straight to the token read (so the read skips the cached token) and must NOT
        // invalidate up front on the happy path — the review flagged the old pre-invalidate as
        // destructive-on-failure. Non-vacuous: the read closure records the bypass value it received,
        // and the invalidate seam records if it ran. force=true → read saw bypass=true, invalidate
        // never ran; the paired false case below proves the flag, not a hard-coded value, drives it.
        let saw_bypass = RefCell::new(None);
        let invalidated = RefCell::new(false);
        let out = fetch_usage_with(
            "/cfg/a",
            true,
            |_cd, bypass| {
                *saw_bypass.borrow_mut() = Some(bypass);
                Ok("tok".to_string())
            },
            |_cd| *invalidated.borrow_mut() = true,
            |_token| Ok(r#"{"five_hour":{"utilization":3.0}}"#.to_string()),
        )
        .expect("a forced fetch must succeed");
        assert_eq!(out.five_hour_percent, Some(3.0));
        assert_eq!(*saw_bypass.borrow(), Some(true), "force must reach the read as bypass_cache=true");
        assert!(
            !*invalidated.borrow(),
            "a successful forced fetch must NOT delete the cache (non-destructive)"
        );
    }

    #[test]
    fn non_forced_fetch_reads_with_bypass_false() {
        // The default (quiet) path the per-account effect uses: bypass_cache=false reaches the read,
        // so a still-fresh cached token keeps being served with no keychain prompt. Pairs with the
        // test above to pin that the read's bypass value tracks the flag rather than a constant.
        let saw_bypass = RefCell::new(None);
        let out = fetch_usage_with(
            "/cfg/a",
            false,
            |_cd, bypass| {
                *saw_bypass.borrow_mut() = Some(bypass);
                Ok("tok".to_string())
            },
            |_cd| {},
            |_token| Ok(r#"{"five_hour":{"utilization":9.0}}"#.to_string()),
        )
        .expect("a non-forced fetch must succeed");
        assert_eq!(out.five_hour_percent, Some(9.0));
        assert_eq!(*saw_bypass.borrow(), Some(false), "an un-forced fetch reads with bypass_cache=false");
    }

    #[test]
    fn write_cache_file_is_0600_and_round_trips() {
        // The on-disk cache must be same-user-only (0600) and readable back by our own reader.
        let dir = std::env::temp_dir().join(format!("sparkle-cache-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SPARKLE_USAGE_CACHE_FILE);
        let creds = CachedCreds {
            access_token: "round-trip-token".to_string(),
            refresh_token: Some("r".to_string()),
            expires_at: 123456789,
        };
        write_cache_file(&path, &creds);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "cache file must be mode 0600");
        }
        let back = read_cache_file(&path).expect("must read back");
        assert_eq!(back, creds);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }
}

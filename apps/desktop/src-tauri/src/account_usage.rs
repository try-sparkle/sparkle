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

use serde::{Deserialize, Serialize};
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

/// One `limits[]` entry as Anthropic sends it (snake_case). Extra keys like `scope` are ignored.
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
}

/// The top-level payload. `five_hour`/`seven_day` are `Option` so a `null` window (or an absent key)
/// yields `None`; unknown extra top-level keys (`seven_day_opus`, `extra_usage`, …) are ignored.
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
    read_access_token(config_dir).is_ok()
}

fn read_access_token(config_dir: &str) -> Result<String, String> {
    let home = std::env::var("HOME").ok();
    let user = std::env::var("USER").ok();
    read_access_token_cached(
        config_dir,
        home.as_deref(),
        user.as_deref(),
        now_epoch_ms(),
        read_cache_file,
        write_cache_file,
        |p| std::fs::read_to_string(p),
        |service, account| {
            keyring::Entry::new(service, account)
                .map_err(|e| e.to_string())?
                .get_password()
                .map_err(|e| format!("keychain read failed: {e}"))
        },
    )
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
    read_keychain: impl Fn(&str, &str) -> Result<String, String>,
) -> Result<String, String> {
    read_access_token_cached(
        config_dir,
        home,
        user,
        0,
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
#[allow(clippy::too_many_arguments)]
fn read_access_token_cached(
    config_dir: &str,
    home: Option<&str>,
    user: Option<&str>,
    now_ms: i64,
    read_cache: impl Fn(&Path) -> Option<CachedCreds>,
    write_cache: impl Fn(&Path, &CachedCreds),
    read_file: impl Fn(&Path) -> std::io::Result<String>,
    read_keychain: impl Fn(&str, &str) -> Result<String, String>,
) -> Result<String, String> {
    let was_empty = config_dir.is_empty();
    let dir = resolve_config_dir_with(config_dir, home)?;

    // 0. Sparkle's own cache FIRST — a plain file, so no keychain access and no macOS prompt. Only a
    // FRESH entry short-circuits; a stale/absent/corrupt one falls through to re-read below.
    let cache_path = Path::new(&dir).join(SPARKLE_USAGE_CACHE_FILE);
    if let Some(cached) = read_cache(&cache_path) {
        if cache_is_fresh(&cached, now_ms) {
            return Ok(cached.access_token);
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
        for service in keychain_services(was_empty, &dir) {
            match read_keychain(&service, user) {
                Ok(password) => {
                    if extract_access_token(&password).is_some() {
                        blob = Some(password);
                        break;
                    }
                }
                Err(e) => last_err = Some(e),
            }
        }
        if blob.is_none() {
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
/// BOTH the keychain read and the `ureq` call BLOCK: a macOS confidential-info prompt can stall the
/// `get_password` indefinitely, and a black-holed host holds the HTTP call up to `HTTP_TIMEOUT`
/// (15s). A Tauri `async` command runs on the SHARED tokio runtime, so doing that work inline would
/// pin a runtime worker for the whole duration — and the frontend fans this out across every account
/// at once, so N stalls could starve unrelated async IPC. We therefore run it on the blocking-task
/// pool via `spawn_blocking` (mirrors `window_screenshot.rs` / `onepassword.rs`) and await the join.
#[tauri::command]
pub async fn account_usage_live(config_dir: String) -> Result<AccountUsageLive, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_usage_blocking(&config_dir))
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
/// on purpose — it runs on the blocking-task pool, never a shared async worker.
fn fetch_usage_blocking(config_dir: &str) -> Result<AccountUsageLive, String> {
    fetch_usage_with(
        config_dir,
        |cd| read_access_token(cd),
        |cd| invalidate_cache(cd),
        |token| http_get_usage(token),
    )
}

/// The token-read → fetch → (on 401) invalidate-and-retry-once flow, with the token read, cache
/// invalidation, and HTTP call injected so the 401 recovery is unit-testable without a keychain or a
/// network. A first-attempt 401 means the CACHED token was rejected: we drop the cache (so the retry
/// re-reads the keychain, popping exactly one prompt) and try once more. A second 401 is terminal —
/// we never loop.
fn fetch_usage_with(
    config_dir: &str,
    read_token: impl Fn(&str) -> Result<String, String>,
    invalidate: impl Fn(&str),
    http_get: impl Fn(&str) -> Result<String, UsageFetchError>,
) -> Result<AccountUsageLive, String> {
    let token = read_token(config_dir)?;
    match http_get(&token) {
        Ok(text) => parse_usage_response(&text),
        Err(UsageFetchError::Other(e)) => Err(e),
        Err(UsageFetchError::Unauthorized) => {
            // Cached token rejected — drop the cache so the re-read hits the keychain, then retry ONCE.
            invalidate(config_dir);
            let token = read_token(config_dir)?;
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
                    Err("no bare entry".to_string())
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
                    Err("no entry".to_string())
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
            |_cd| {
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
            |_cd| {
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
            |_cd| {
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

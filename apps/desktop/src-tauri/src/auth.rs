// Desktop auth + credit API (design spec §3.1, §8). The long-lived bearer token lives in the
// macOS keychain and NEVER enters JS — every authenticated call is made here over HTTP via ureq
// (matching bridge.rs/naming.rs). Note: ureq is pulled WITHOUT the `json` feature, so request/
// response JSON is handled by hand with serde_json.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::Duration;
use subtle::ConstantTimeEq;

/// Holds a deep-link URL that arrived before the webview attached its listener (e.g. a cold
/// launch BY the sparkle:// link). AuthGate drains it on mount so the hand-off isn't lost.
#[derive(Default)]
pub struct DeepLinkPending(pub Mutex<Option<String>>);

/// The in-flight sign-in this app instance started: the opaque `state` we put in the auth URL and
/// the PKCE `verifier` we'll present on exchange (sparkle-kqg0). Held in memory only (never on the
/// wire, never in JS) and single-use — cleared on the first callback. Because it's in-memory, a
/// sign-in that spans an app restart must be re-initiated; that's acceptable (the flow is seconds
/// long and the app is always running when the user clicks "Sign in").
#[derive(Default)]
pub struct PendingSignIn(pub Mutex<Option<PendingAuth>>);

/// One pending sign-in's secrets. `state` binds the callback to the sign-in we started (defeats a
/// code planted by a malicious page); `verifier` is the PKCE secret proving the code was minted
/// for a challenge only we knew.
pub struct PendingAuth {
    state: String,
    verifier: String,
}

/// Stable error sentinel returned by `desktop_exchange_code` when a callback arrives but this
/// instance has no in-flight sign-in to match it against — the classic "quit mid-sign-in, the
/// `sparkle://auth?code=…` deep link relaunches a fresh process whose in-memory `PendingSignIn` is
/// empty" dead-end. The JS side (entitlement.ts `isNoPendingSignIn`) matches on this exact string to
/// tell that recoverable case ("just start sign-in again") apart from a genuine state mismatch / a
/// server rejection, and surface a clean "restart sign-in" affordance instead of failing silently.
pub const NO_PENDING_SIGNIN: &str = "no_pending_signin";

/// A high-entropy, URL-safe token of `nbytes` of OS randomness (base64url, unpadded).
fn random_b64url(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// PKCE S256 challenge for a verifier: base64url(SHA-256(verifier)), unpadded — matches the
/// server's lib/pkce.ts (which recomputes and compares this).
fn s256_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Constant-time equality of the stored vs returned sign-in `state`. `ct_eq` short-circuits only on
/// length (not secret here — state is a fixed-width token), then compares the bytes in constant
/// time so a partial-prefix match can't be timed out.
fn state_matches(expected: &str, got: &str) -> bool {
    bool::from(expected.as_bytes().ct_eq(got.as_bytes()))
}

/// What the JS side needs to build the sign-in URL: the `state` and `code_challenge` query params.
/// The verifier stays in Rust (in `PendingSignIn`) and is never handed to JS.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginSignIn {
    state: String,
    code_challenge: String,
}

/// Begin a sign-in: generate a fresh state + PKCE verifier/challenge, stash the secrets, and return
/// the public `state`/`code_challenge` for JS to append to the /desktop/callback URL. Overwrites any
/// prior pending sign-in (only the most recent hand-off can complete).
#[tauri::command]
pub fn desktop_begin_signin(pending: tauri::State<PendingSignIn>) -> BeginSignIn {
    let state = random_b64url(32);
    let verifier = random_b64url(32);
    let code_challenge = s256_challenge(&verifier);
    *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(PendingAuth {
        state: state.clone(),
        verifier,
    });
    BeginSignIn { state, code_challenge }
}

/// Take (and clear) any pending deep-link URL captured at launch.
#[tauri::command]
pub fn desktop_take_pending_deeplink(state: tauri::State<DeepLinkPending>) -> Option<String> {
    // Poison-tolerant: a panic elsewhere must not strand a captured cold-launch auth code here
    // (which would make sign-in impossible). The recovered guard still holds the pending URL.
    state.0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

const KEYCHAIN_USER: &str = "desktop-token";
const DEFAULT_ORCHESTRATION_URL: &str = "http://localhost:3001";
/// Bound every auth/credit HTTP call so a black-holed orchestration host can't freeze the calling
/// thread indefinitely — ureq has no default request timeout. These commands run on app load
/// (desktop_me) and on every credit spend (desktop_consume), so an unbounded hang is user-visible.
/// Mirrors trial_remote.rs.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Orchestration base URL. Override with ORCHESTRATION_URL for local dev (http://localhost:3001).
/// `pub(crate)` so the server-side AI proxy callers (ai.rs — Anthropic naming/chat/judge/attention)
/// hit the SAME orchestration host as the auth/credit commands.
pub(crate) fn base_url() -> String {
    std::env::var("ORCHESTRATION_URL").unwrap_or_else(|_| DEFAULT_ORCHESTRATION_URL.to_string())
}

/// The stored desktop bearer token, or None when signed out. `pub(crate)` so the AI proxy callers
/// (ai.rs) can authenticate their server-side `/ai/*` calls as this user — the token is read from
/// the keychain here and never crosses into JS (mirrors how the auth/credit commands work).
pub(crate) fn bearer_token() -> Option<String> {
    read_token()
}

fn entry() -> Result<keyring::Entry, String> {
    // Service name is dev-suffixed in debug builds (see dev_identity) so a dev build never touches
    // the production app's keychain ACL — avoids the macOS confidential-info prompt.
    keyring::Entry::new(&crate::dev_identity::keychain_service(), KEYCHAIN_USER)
        .map_err(|e| e.to_string())
}

fn read_token() -> Option<String> {
    let t = entry().ok()?.get_password().ok()?;
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// The stored desktop bearer token (or None if signed out), for other Rust modules that need to
/// authenticate a call to a Sparkle backend on the user's behalf (e.g. support.rs attaching it to
/// a ticket). The token stays in Rust — this never crosses into JS.
pub fn token() -> Option<String> {
    read_token()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    clerk_user_id: String,
    entitled: bool,
    balance_cents: i64,
    token_version: i64,
    // Display profile (Settings "Signed in as …"). #[serde(default)] so a response from an
    // older deployed server that predates these fields still deserializes.
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// Auto-top-up settings (credits-menu spec §3), passed through verbatim — without this field
    /// serde would silently DROP the server's `autoTopup` key and JS would always read undefined.
    /// Optional (and omitted when absent) to tolerate older orchestration servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auto_topup: Option<Value>,
}

/// True if a (non-empty) desktop bearer token is stored.
#[tauri::command]
pub fn desktop_has_token() -> bool {
    read_token().is_some()
}

/// The stored desktop bearer (or null if signed out). Exposed ONLY to the trusted local
/// webview so the in-app Socket.IO relay client can authenticate to the orchestration relay
/// as this user's Mac (role "host"). The token never leaves the device beyond that TLS socket.
#[tauri::command]
pub fn desktop_bearer_token() -> Option<String> {
    read_token()
}

/// Clear the stored token (local sign-out). Missing entry is treated as success.
#[tauri::command]
pub fn desktop_sign_out() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Redeem a one-time auth code (from the sparkle:// deep link) for the long-lived bearer, which
/// is then stored in the keychain. The code — not the bearer — is what travels through the URL.
///
/// Login-CSRF defense (sparkle-kqg0): before touching the network we take (single-use) the pending
/// sign-in this instance started and require the callback's `state` to match it (constant time). A
/// code planted by a malicious page carries a state we never issued — rejected here, so its code is
/// never sent to the server. On a match we present the PKCE `verifier`, which the server checks
/// against the challenge bound into the code.
/// `async` so Tauri runs the blocking `ureq` call off the main thread — this fires during sign-in,
/// where a stalled network (up to `HTTP_TIMEOUT` = 15s) would otherwise freeze the UI (see
/// desktop_me/desktop_consume above for the rationale).
#[tauri::command]
pub async fn desktop_exchange_code(
    code: String,
    state: String,
    pending: tauri::State<'_, PendingSignIn>,
) -> Result<(), String> {
    // Take-then-compare: burn the pending sign-in up front so even a valid state can't be replayed,
    // and so a forged callback can't leave a stale pending entry lying around.
    let pending_auth = pending
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or_else(|| NO_PENDING_SIGNIN.to_string())?;
    if !state_matches(&pending_auth.state, &state) {
        return Err("state mismatch".to_string());
    }

    let url = format!("{}/auth/desktop/exchange", base_url());
    let body = json!({ "code": code, "codeVerifier": pending_auth.verifier }).to_string();
    let resp = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .send_string(&body)
        .map_err(|e| format!("exchange failed: {e}"))?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let token = v
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "exchange response missing token".to_string())?;
    entry()?.set_password(token).map_err(|e| e.to_string())?;
    Ok(())
}

/// Mint a short 6-char pairing code to sign a phone in (POST /pair/code, authed). Returns the
/// code string for display ("Pair phone"). The phone types it to get its own bearer.
/// `async` so Tauri runs the blocking `ureq` call off the main thread (avoids a 15s UI freeze on a
/// stalled network — see desktop_me above).
#[tauri::command]
pub async fn desktop_pair_code() -> Result<String, String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/pair/code", base_url());
    let resp = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string("{}")
        .map_err(|e| format!("pair code failed: {e}"))?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v.get("code")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "pair response missing code".to_string())
}

/// Stable error sentinel: the deployed relay predates the device registry (GET /devices
/// 404s). The Settings pane compares against this exact string to show "relay update pending".
pub const DEVICES_UNSUPPORTED: &str = "devices_unsupported";

/// List the devices paired to this account (GET /devices, authed). Returns the relay JSON
/// verbatim (`{ devices: [{ id, name, platform, createdAt, lastSeenAt, current }] }`); the UI
/// owns the shape.
/// `async` so Tauri runs the blocking `ureq` call off the main thread (avoids a 15s UI freeze on a
/// stalled network — see desktop_me above).
#[tauri::command]
pub async fn list_paired_devices() -> Result<Value, String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/devices", base_url());
    match ureq::get(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        }
        Err(ureq::Error::Status(404, _)) => Err(DEVICES_UNSUPPORTED.to_string()),
        Err(e) => Err(format!("device list failed: {e}")),
    }
}

/// Unpair one device by id (DELETE /devices/:id, authed; server enforces the device belongs to
/// the caller). Revoke is idempotent, so a 404 (already revoked elsewhere, stale list, or a
/// pre-registry relay whose route is missing entirely) counts as success — the device is gone
/// either way, and list_paired_devices alone owns the DEVICES_UNSUPPORTED signal.
/// Device ids are relay-issued UUIDs; reject anything that could rewrite the request
/// path/query when interpolated into the URL — including "me", the one in-charset value the
/// relay routes differently (DELETE /devices/me = self-revoke, owned by the phone flow).
fn is_valid_device_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id != "me"
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `async` so Tauri runs the blocking `ureq` call off the main thread (avoids a 15s UI freeze on a
/// stalled network — see desktop_me above).
#[tauri::command]
pub async fn revoke_paired_device(id: String) -> Result<(), String> {
    if !is_valid_device_id(&id) {
        return Err("invalid device id".to_string());
    }
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/devices/{}", base_url(), id);
    match ureq::delete(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(_) | Err(ureq::Error::Status(404, _)) => Ok(()),
        Err(e) => Err(format!("unpair failed: {e}")),
    }
}

#[cfg(test)]
mod device_id_tests {
    use super::is_valid_device_id;

    #[test]
    fn accepts_relay_uuids() {
        assert!(is_valid_device_id("3920d3fa-b53c-4eb0-83ed-057297baee6c"));
        assert!(is_valid_device_id("abc_DEF-123"));
    }

    #[test]
    fn rejects_path_rewriting_and_route_changing_ids() {
        for bad in ["", "me", "../pair/code", "a/b", "a?x=1", "a#f", "a b", "a%2Fb"] {
            assert!(!is_valid_device_id(bad), "should reject {bad:?}");
        }
        assert!(!is_valid_device_id(&"a".repeat(65)));
    }
}

/// Entitlement + balance for the signed-in user. `async` (like `desktop_topup_checkout`) so Tauri
/// runs the blocking `ureq` call off the main thread — this fires on app load, where a stalled
/// network (up to `HTTP_TIMEOUT` = 15s) would otherwise freeze the UI.
#[tauri::command]
pub async fn desktop_me() -> Result<Me, String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/me", base_url());
    let resp = ureq::get(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("me failed: {e}"))?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Server-authoritative debit. Returns the orchestration JSON verbatim:
/// `{ ok: true, balanceAfterCents, ledgerId }` on success, or `{ ok: false, balanceCents }` on 402.
/// `async` (like `desktop_topup_checkout`) so Tauri runs the blocking `ureq` call off the main
/// thread — this fires on every credit spend, where a stalled network (up to `HTTP_TIMEOUT` = 15s)
/// would otherwise freeze the UI.
#[tauri::command]
pub async fn desktop_consume(
    cents: i64,
    reason: String,
    meta: Value,
    idempotency_key: Option<String>,
) -> Result<Value, String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/credits/consume", base_url());
    let body = json!({
        "cents": cents,
        "reason": reason,
        "meta": meta,
        "idempotencyKey": idempotency_key,
    })
    .to_string();
    let req = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json");
    match req.send_string(&body) {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        }
        Err(ureq::Error::Status(402, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            let v: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
            let bal = v.get("balanceCents").and_then(|b| b.as_i64()).unwrap_or(0);
            Ok(json!({ "ok": false, "balanceCents": bal }))
        }
        // Any NON-402 HTTP error (e.g. a 400 on a malformed debit) must not be silent: a swallowed
        // 400 here — from sending a non-integer `cents` — is exactly what made cloud dictation
        // invisibly fall back to the on-device model, tearing the Deepgram socket down ~200ms after
        // it opened. Log it loud (with status + a short body snippet) so it's never invisible again.
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            let snippet: String = text.chars().take(200).collect();
            tracing::warn!(
                target: "credits",
                status = code,
                reason = %reason,
                cents,
                body = %snippet,
                "consume rejected by server",
            );
            Err(format!("consume failed: HTTP {code}: {snippet}"))
        }
        Err(e) => {
            tracing::warn!(target: "credits", reason = %reason, cents, error = %e, "consume transport error");
            Err(format!("consume failed: {e}"))
        }
    }
}

/// Refund a specific prior debit by ledger id (refund-on-throw). Server-bounded to the caller's
/// own debit + idempotent, so it cannot mint credits.
/// `async` (like its debit partner `desktop_consume`) so Tauri runs the blocking `ureq` call off
/// the main thread — a stalled network (up to `HTTP_TIMEOUT` = 15s) would otherwise freeze the UI.
#[tauri::command]
pub async fn desktop_refund(ledger_id: String) -> Result<(), String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/credits/refund", base_url());
    let body = json!({ "ledgerId": ledger_id }).to_string();
    ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(&body)
        .map_err(|e| format!("refund failed: {e}"))?;
    Ok(())
}

/// Redeem a promo/override code. On success the server grants entitlement + credits; the caller
/// then re-fetches `/me`. A 400 (server rejected the code) maps to a stable "invalid_code" string
/// so the UI can show a friendly message; other failures bubble up verbatim.
/// `async` so Tauri runs the blocking `ureq` call off the main thread (avoids a 15s UI freeze on a
/// stalled network — see desktop_me above).
#[tauri::command]
pub async fn desktop_redeem_promo(code: String) -> Result<(), String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/billing/promo", base_url());
    let body = json!({ "code": code }).to_string();
    let req = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json");
    match req.send_string(&body) {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(400, _)) => Err("invalid_code".to_string()),
        Err(e) => Err(format!("promo redeem failed: {e}")),
    }
}

/// Redeem an admin-issued coupon (POST /billing/coupon — the `/admin coupons` system, distinct from
/// the single-code `/billing/promo` override). Returns the coupon result JSON verbatim on success —
/// `{type:"credit_grant", grantedCents, balanceCents}` (credits granted) or `{type:"discount", …}`
/// (a Stripe promo code to apply at checkout) — so the UI can react to the two kinds. Non-2xx maps
/// to the server's stable `error` code via server_error (e.g. "invalid_or_expired",
/// "already_redeemed"), mirroring desktop_topup_checkout's error style, so JS can string-match it.
/// `async` so Tauri runs the blocking ureq call off the main thread (see desktop_redeem_promo).
#[tauri::command]
pub async fn desktop_redeem_coupon(code: String) -> Result<Value, String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/billing/coupon", base_url());
    let body = json!({ "code": code }).to_string();
    let req = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json");
    match req.send_string(&body) {
        Ok(resp) => json_response(resp),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(server_error("coupon", code, &text))
        }
        Err(e) => Err(format!("coupon redeem failed: {e}")),
    }
}

// ---- Credits menu (design spec: docs/superpowers/specs/2026-07-01-credits-menu-design.md) ----
// Pure request-shape helpers below are unit-tested; the commands are thin ureq shells that follow
// desktop_me/desktop_redeem_promo's bearer + error-mapping style.

/// JSON body for POST /billing/checkout — pack omitted entirely when None (the server's zod
/// schema treats `pack` as optional, and card_setup/paywall kinds send no pack at all).
fn checkout_body(kind: &str, pack: Option<&str>) -> String {
    let mut v = json!({ "kind": kind });
    if let Some(p) = pack {
        v["pack"] = json!(p);
    }
    v.to_string()
}

/// Path + query for GET /credits/history. The cursor is opaque (base64url today), so escape
/// anything outside the URL-unreserved set rather than trusting the server's encoding choice.
fn history_path(cursor: Option<&str>, limit: Option<u32>) -> String {
    let mut path = format!("/credits/history?limit={}", limit.unwrap_or(20));
    if let Some(c) = cursor {
        path.push_str("&cursor=");
        for b in c.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    path.push(b as char)
                }
                _ => path.push_str(&format!("%{b:02X}")),
            }
        }
    }
    path
}

/// JSON body for PUT /billing/auto-topup (contract field names, camelCase).
fn auto_topup_body(enabled: bool, threshold_cents: i64, pack_id: &str) -> String {
    json!({ "enabled": enabled, "thresholdCents": threshold_cents, "packId": pack_id }).to_string()
}

/// Pull the server's stable machine-readable `error` code out of a non-2xx JSON body, if present
/// and non-empty (e.g. "bad_pack", "stripe_permission"). Returns None for an opaque/empty body so
/// callers degrade gracefully — the server error shape is evolving and we must not hard-depend on it.
fn parse_error_code(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .filter(|e| !e.is_empty())
}

/// Map a non-2xx body to the server's stable `error` code when parseable (so JS can string-match
/// e.g. "bad_pack", mirroring desktop_redeem_promo's "invalid_code"), else a loud status+snippet.
fn server_error(prefix: &str, code: u16, body: &str) -> String {
    if let Some(e) = parse_error_code(body) {
        return e;
    }
    let snippet: String = body.chars().take(200).collect();
    format!("{prefix} failed: HTTP {code}: {snippet}")
}

/// Machine-readable, self-classifying error for the checkout command, so the Credits pane can show
/// a failure-class-appropriate message (our-side config problem vs. offline vs. signed-out) instead
/// of one generic "try again". Encoded as a compact JSON string in the command's `Err` channel — the
/// only consumer is creditsMenuApi's startCheckout, which owns both ends of this contract.
///
/// `class` is the coarse bucket the JS keys off first: "not_signed_in" | "offline" | "server".
/// `status` is the upstream HTTP status (for "server") so JS can distinguish a 403 permission/config
/// failure or a 5xx from a benign 4xx. `code` carries the server's stable `error` string when it
/// sent one, purely as a hint — the JS classifier never *requires* it (the sibling server worker is
/// separately reshaping that body), so an opaque body still classifies correctly from class+status.
fn checkout_error(class: &str, status: Option<u16>, code: Option<&str>) -> String {
    json!({ "class": class, "status": status, "code": code }).to_string()
}

/// Parse a JSON response body, mapping transport/parse errors to strings.
fn json_response(resp: ureq::Response) -> Result<Value, String> {
    let text = resp.into_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Start a Stripe Checkout for a credits top-up (`kind:"topup"` + pack) or a card-save session
/// (`kind:"card_setup"`). Returns the hosted checkout URL for the JS side to open in the browser.
/// `async` (as are the three commands below) so Tauri runs the blocking ureq call off the main
/// thread — these fire from the interactive Credits pane, where a 15s freeze would be felt.
#[tauri::command]
pub async fn desktop_topup_checkout(kind: String, pack: Option<String>) -> Result<String, String> {
    // No local token → the session is gone; JS routes to sign-in rather than showing "try again".
    let token = read_token().ok_or_else(|| checkout_error("not_signed_in", None, None))?;
    let url = format!("{}/billing/checkout", base_url());
    let body = checkout_body(&kind, pack.as_deref());
    let req = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json");
    match req.send_string(&body) {
        Ok(resp) => {
            // A 2xx whose body we couldn't read/parse is most likely a transient blip (the server
            // IS up and accepted the request), so steer the user to retry — not to support.
            let v = json_response(resp).map_err(|_| checkout_error("offline", None, None))?;
            v.get("url")
                .and_then(|u| u.as_str())
                .map(|s| s.to_string())
                // A 2xx with no URL is a server-side contract/config break, not something a retry fixes.
                .ok_or_else(|| checkout_error("server", None, Some("missing_url")))
        }
        // Any upstream HTTP status: pass the status + the server's stable code (if any) to JS. The
        // prod 403 StripePermissionError (restricted key lacking customer_write) lands here and is
        // classified as an our-side config problem — not a "try again" the user can escape.
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(checkout_error("server", Some(code), parse_error_code(&text).as_deref()))
        }
        // Transport failure (DNS/connect/timeout) → treat as offline; a retry once connected is the fix.
        Err(_) => Err(checkout_error("offline", None, None)),
    }
}

/// Cursor-paginated credit ledger page. Returns the contract JSON verbatim:
/// `{ entries: [{id, createdAt, reason, deltaCents}], nextCursor? }`.
#[tauri::command]
pub async fn desktop_credit_history(
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}{}", base_url(), history_path(cursor.as_deref(), limit));
    match ureq::get(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(resp) => json_response(resp),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(server_error("history", code, &text))
        }
        Err(e) => Err(format!("history failed: {e}")),
    }
}

/// Current auto-top-up settings (contract `AutoTopup` shape, verbatim JSON).
#[tauri::command]
pub async fn desktop_auto_topup_get() -> Result<Value, String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/billing/auto-topup", base_url());
    match ureq::get(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(resp) => json_response(resp),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(server_error("auto-topup", code, &text))
        }
        Err(e) => Err(format!("auto-topup failed: {e}")),
    }
}

/// Save auto-top-up settings; returns the server-authoritative `AutoTopup` JSON.
#[tauri::command]
pub async fn desktop_auto_topup_set(
    enabled: bool,
    threshold_cents: i64,
    pack_id: String,
) -> Result<Value, String> {
    // The server is the authority, but a non-positive threshold is never meaningful — reject it
    // before it leaves the device (first line of defense against a runaway auto-top-up config).
    if threshold_cents <= 0 {
        return Err("bad_threshold".to_string());
    }
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/billing/auto-topup", base_url());
    let body = auto_topup_body(enabled, threshold_cents, &pack_id);
    let req = ureq::put(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json");
    match req.send_string(&body) {
        Ok(resp) => json_response(resp),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(server_error("auto-topup save", code, &text))
        }
        Err(e) => Err(format!("auto-topup save failed: {e}")),
    }
}

#[cfg(test)]
mod auth_binding_tests {
    use super::*;

    #[test]
    fn s256_challenge_matches_rfc7636_vector() {
        // RFC 7636 Appendix B: verifier → S256 challenge. Pinning this guarantees the desktop's
        // challenge is byte-identical to what the server (lib/pkce.ts) recomputes from the verifier.
        assert_eq!(
            s256_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn begin_signin_challenge_verifies_against_its_own_verifier() {
        // The challenge desktop_begin_signin publishes must be the S256 of the verifier it stashes,
        // or the server's PKCE check would reject every legitimate exchange.
        let verifier = random_b64url(32);
        let challenge = s256_challenge(&verifier);
        assert_eq!(challenge, s256_challenge(&verifier));
        // 32 bytes of entropy → 43-char unpadded base64url, the S256 challenge width the server
        // regex (^[A-Za-z0-9_-]{43}$) accepts.
        assert_eq!(challenge.len(), 43);
        assert_eq!(random_b64url(32).len(), 43);
    }

    #[test]
    fn no_pending_signin_sentinel_is_stable() {
        // Cross-language contract: entitlement.ts `isNoPendingSignIn` matches on this EXACT string to
        // recognize the "quit mid-sign-in, no in-flight sign-in to match the callback" case and offer
        // a clean restart. Renaming the constant without updating the JS matcher would silently
        // regress that recovery back to a dead-end — pin the wire value here so that can't happen.
        assert_eq!(NO_PENDING_SIGNIN, "no_pending_signin");
    }

    #[test]
    fn random_b64url_is_high_entropy_and_unique() {
        // Two draws must differ (a constant would be a catastrophic state/verifier bug).
        assert_ne!(random_b64url(32), random_b64url(32));
    }

    #[test]
    fn state_matches_accepts_equal_and_rejects_mismatch_or_length_diff() {
        let s = random_b64url(32);
        assert!(state_matches(&s, &s.clone()));
        // Same length, one differing char.
        let mut wrong = s.clone().into_bytes();
        wrong[0] ^= 0x01;
        // XOR may land outside base64url, but state_matches is a raw byte compare — still valid.
        assert!(!state_matches(&s, &String::from_utf8_lossy(&wrong)));
        // A returned state of a different length (e.g. the callback carried none) never matches.
        assert!(!state_matches(&s, ""));
        assert!(!state_matches(&s, &format!("{s}x")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_body_includes_pack_when_present() {
        let v: Value = serde_json::from_str(&checkout_body("topup", Some("pack_25"))).unwrap();
        assert_eq!(v["kind"], "topup");
        assert_eq!(v["pack"], "pack_25");
    }

    #[test]
    fn checkout_body_omits_pack_when_absent() {
        let v: Value = serde_json::from_str(&checkout_body("card_setup", None)).unwrap();
        assert_eq!(v["kind"], "card_setup");
        assert!(v.get("pack").is_none());
    }

    #[test]
    fn history_path_defaults_limit_to_20() {
        assert_eq!(history_path(None, None), "/credits/history?limit=20");
    }

    #[test]
    fn history_path_carries_limit_and_cursor() {
        assert_eq!(
            history_path(Some("abc-_123"), Some(50)),
            "/credits/history?limit=50&cursor=abc-_123"
        );
    }

    #[test]
    fn history_path_percent_encodes_cursor_outside_unreserved() {
        // Cursors are opaque base64url (already URL-safe); anything else must be escaped, not
        // pasted raw into the query string.
        assert_eq!(
            history_path(Some("a+b/c="), None),
            "/credits/history?limit=20&cursor=a%2Bb%2Fc%3D"
        );
        // Multibyte UTF-8: byte-wise encoding must emit one %XX per BYTE (a char-based encoder
        // would differ exactly here).
        assert_eq!(history_path(Some("é"), None), "/credits/history?limit=20&cursor=%C3%A9");
    }

    #[test]
    fn auto_topup_set_rejects_non_positive_threshold_before_any_io() {
        // The guard runs before the keychain/network, so this is deterministic in CI.
        let err = tauri::async_runtime::block_on(desktop_auto_topup_set(true, 0, "pack_25".into()))
            .unwrap_err();
        assert_eq!(err, "bad_threshold");
        let err =
            tauri::async_runtime::block_on(desktop_auto_topup_set(true, -500, "pack_25".into()))
                .unwrap_err();
        assert_eq!(err, "bad_threshold");
    }

    #[test]
    fn me_passes_auto_topup_through_and_tolerates_its_absence() {
        // Without the auto_topup field serde silently DROPS the server's key — JS would always
        // read undefined even against a current server. Pin the round-trip both ways.
        let with: Me = serde_json::from_str(
            r#"{"clerkUserId":"u1","entitled":true,"balanceCents":100,"tokenVersion":1,
                "autoTopup":{"enabled":true,"thresholdCents":500,"packId":"pack_25",
                             "hasSavedCard":true,"lastFailure":null}}"#,
        )
        .unwrap();
        let out = serde_json::to_value(&with).unwrap();
        assert_eq!(out["autoTopup"]["packId"], "pack_25");
        let without: Me = serde_json::from_str(
            r#"{"clerkUserId":"u1","entitled":true,"balanceCents":100,"tokenVersion":1}"#,
        )
        .unwrap();
        let out = serde_json::to_value(&without).unwrap();
        assert!(out.get("autoTopup").is_none());
    }

    #[test]
    fn auto_topup_body_uses_contract_field_names() {
        let v: Value = serde_json::from_str(&auto_topup_body(true, 500, "pack_25")).unwrap();
        assert_eq!(v["enabled"], true);
        assert_eq!(v["thresholdCents"], 500);
        assert_eq!(v["packId"], "pack_25");
    }

    #[test]
    fn server_error_prefers_stable_error_code() {
        assert_eq!(server_error("checkout", 409, r#"{"error":"bad_pack"}"#), "bad_pack");
    }

    #[test]
    fn parse_error_code_extracts_nonempty_error_else_none() {
        assert_eq!(parse_error_code(r#"{"error":"stripe_permission"}"#).as_deref(), Some("stripe_permission"));
        // Empty string, missing field, and opaque bodies all yield None (degrade gracefully).
        assert_eq!(parse_error_code(r#"{"error":""}"#), None);
        assert_eq!(parse_error_code(r#"{"message":"nope"}"#), None);
        assert_eq!(parse_error_code("<html>500</html>"), None);
    }

    #[test]
    fn checkout_error_is_structured_json_the_js_classifier_reads() {
        // 403 permission (the prod StripePermissionError) carries class+status+code so JS can
        // classify it as an our-side config problem without depending on the exact body shape.
        let v: Value =
            serde_json::from_str(&checkout_error("server", Some(403), Some("stripe_permission")))
                .unwrap();
        assert_eq!(v["class"], "server");
        assert_eq!(v["status"], 403);
        assert_eq!(v["code"], "stripe_permission");

        // Signed-out and offline carry no status/code but stay valid JSON with null fields.
        let so: Value = serde_json::from_str(&checkout_error("not_signed_in", None, None)).unwrap();
        assert_eq!(so["class"], "not_signed_in");
        assert!(so["status"].is_null());
        assert!(so["code"].is_null());
        let off: Value = serde_json::from_str(&checkout_error("offline", None, None)).unwrap();
        assert_eq!(off["class"], "offline");
    }

    #[test]
    fn server_error_falls_back_to_status_and_snippet() {
        assert_eq!(
            server_error("checkout", 500, "oops"),
            "checkout failed: HTTP 500: oops"
        );
        assert_eq!(
            server_error("history", 400, r#"{"message":"no error field"}"#),
            r#"history failed: HTTP 400: {"message":"no error field"}"#
        );
    }
}

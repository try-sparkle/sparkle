// Desktop auth + credit API (design spec §3.1, §8). The long-lived bearer token lives in the
// macOS keychain and NEVER enters JS — every authenticated call is made here over HTTP via ureq
// (matching bridge.rs/naming.rs). Note: ureq is pulled WITHOUT the `json` feature, so request/
// response JSON is handled by hand with serde_json.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;

/// Holds a deep-link URL that arrived before the webview attached its listener (e.g. a cold
/// launch BY the sparkle:// link). AuthGate drains it on mount so the hand-off isn't lost.
#[derive(Default)]
pub struct DeepLinkPending(pub Mutex<Option<String>>);

/// Take (and clear) any pending deep-link URL captured at launch.
#[tauri::command]
pub fn desktop_take_pending_deeplink(state: tauri::State<DeepLinkPending>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

const KEYCHAIN_SERVICE: &str = "ai.sparkle.desktop";
const KEYCHAIN_USER: &str = "desktop-token";
const DEFAULT_ORCHESTRATION_URL: &str = "http://localhost:3001";

/// Orchestration base URL. Override with ORCHESTRATION_URL for local dev (http://localhost:3001).
fn base_url() -> String {
    std::env::var("ORCHESTRATION_URL").unwrap_or_else(|_| DEFAULT_ORCHESTRATION_URL.to_string())
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())
}

fn read_token() -> Option<String> {
    let t = entry().ok()?.get_password().ok()?;
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    clerk_user_id: String,
    entitled: bool,
    balance_cents: i64,
    token_version: i64,
}

/// True if a (non-empty) desktop bearer token is stored.
#[tauri::command]
pub fn desktop_has_token() -> bool {
    read_token().is_some()
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
#[tauri::command]
pub fn desktop_exchange_code(code: String) -> Result<(), String> {
    let url = format!("{}/auth/desktop/exchange", base_url());
    let body = json!({ "code": code }).to_string();
    let resp = ureq::post(&url)
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

/// Entitlement + balance for the signed-in user.
#[tauri::command]
pub fn desktop_me() -> Result<Me, String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/me", base_url());
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("me failed: {e}"))?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Server-authoritative debit. Returns the orchestration JSON verbatim:
/// `{ ok: true, balanceAfterCents, ledgerId }` on success, or `{ ok: false, balanceCents }` on 402.
#[tauri::command]
pub fn desktop_consume(
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
#[tauri::command]
pub fn desktop_refund(ledger_id: String) -> Result<(), String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/credits/refund", base_url());
    let body = json!({ "ledgerId": ledger_id }).to_string();
    ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(&body)
        .map_err(|e| format!("refund failed: {e}"))?;
    Ok(())
}

/// Redeem a promo/override code. On success the server grants entitlement + credits; the caller
/// then re-fetches `/me`. A 400 (server rejected the code) maps to a stable "invalid_code" string
/// so the UI can show a friendly message; other failures bubble up verbatim.
#[tauri::command]
pub fn desktop_redeem_promo(code: String) -> Result<(), String> {
    let token = read_token().ok_or_else(|| "not signed in".to_string())?;
    let url = format!("{}/billing/promo", base_url());
    let body = json!({ "code": code }).to_string();
    let req = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json");
    match req.send_string(&body) {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(400, _)) => Err("invalid_code".to_string()),
        Err(e) => Err(format!("promo redeem failed: {e}")),
    }
}

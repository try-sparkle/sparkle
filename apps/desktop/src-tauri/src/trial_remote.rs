// Client side of the SERVER-authoritative anonymous trial meter (design: anonymous-free-trial).
// The opaque device token the orchestration server mints (POST /trial/init) is stored in the macOS
// keychain and NEVER enters JS — every call is made here over ureq, mirroring auth.rs. This is the
// seam the trial UI meter cuts over to so the 100-prompt cap is enforced server-side and resetting
// the device-local trial.json can no longer grant a fresh trial.
//
// SCAFFOLDING: these commands are wired and callable, but the live UI meter (trialMeter.ts) still
// reads the device-local counter (trial.rs) today. The cutover — have a worker send call
// `trial_remote_consume` and gate on its `{ ok }` / 402 — is the integration step (coordinated
// with the trial-flow owner). Until then the server counter simply isn't consulted on the hot path.
//
// Like auth.rs, this module is pure I/O (HTTP + keychain) and carries no Rust unit tests; the cap
// logic and endpoints are tested server-side in apps/orchestration (trialMath + routes tests).

use std::time::Duration;

use serde_json::{json, Value};

const KEYCHAIN_SERVICE: &str = "ai.sparkle.desktop";
const KEYCHAIN_USER: &str = "trial-device-token";
const DEFAULT_ORCHESTRATION_URL: &str = "http://localhost:3001";
/// Bound every trial HTTP call so a hung/unreachable orchestration server can't wedge the Tauri
/// command (and the worker awaiting it) indefinitely — ureq has no default request timeout.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Orchestration base URL. Override with ORCHESTRATION_URL for local dev (mirrors auth.rs).
fn base_url() -> String {
    std::env::var("ORCHESTRATION_URL").unwrap_or_else(|_| DEFAULT_ORCHESTRATION_URL.to_string())
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())
}

fn read_device_token() -> Option<String> {
    let t = entry().ok()?.get_password().ok()?;
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// Mint a fresh device token from the server and persist it in the keychain. Returns the token.
fn init_device_token() -> Result<String, String> {
    let url = format!("{}/trial/init", base_url());
    let resp = ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .send_string("{}")
        .map_err(|e| format!("trial init failed: {e}"))?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let token = v
        .get("deviceToken")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "trial init response missing deviceToken".to_string())?;
    entry()?.set_password(token).map_err(|e| e.to_string())?;
    Ok(token.to_string())
}

/// Read the stored device token, minting + persisting one on first use.
fn ensure_device_token() -> Result<String, String> {
    match read_device_token() {
        Some(t) => Ok(t),
        None => init_device_token(),
    }
}

/// POST `{ deviceToken }` to a `/trial/*` endpoint.
fn send_trial(path: &str, token: &str) -> Result<ureq::Response, ureq::Error> {
    let url = format!("{}{}", base_url(), path);
    let body = json!({ "deviceToken": token }).to_string();
    ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .send_string(&body)
}

/// Outcome of a `/trial/*` call that failed. Distinguishing these lets callers report a precise
/// message instead of a misleading HTTP error — and lets `consume` recognize the 402 cap.
enum TrialCallError {
    /// Couldn't obtain a device token at all (keychain/mint failure) — never sent a request.
    Mint(String),
    /// Server returned a non-2xx status; carries the status and the (already-read) body.
    Status(u16, String),
    /// Network/transport failure.
    Transport(String),
}

/// Read a ureq error into a TrialCallError, consuming the response body for status errors.
fn classify(e: ureq::Error) -> TrialCallError {
    match e {
        ureq::Error::Status(code, resp) => {
            TrialCallError::Status(code, resp.into_string().unwrap_or_default())
        }
        other => TrialCallError::Transport(other.to_string()),
    }
}

/// Send to a `/trial/*` endpoint, re-minting the token ONCE on a CONFIRMED unknown-token 404 so the
/// client self-heals if its server row was lost — without discarding a still-valid token on a
/// spurious 404 (a deploy blip / proxy error). A mint failure is surfaced explicitly (never a POST
/// with an empty token).
fn send_trial_reinit_on_404(path: &str) -> Result<ureq::Response, TrialCallError> {
    let token = ensure_device_token().map_err(TrialCallError::Mint)?;
    match send_trial(path, &token) {
        Ok(resp) => Ok(resp),
        Err(ureq::Error::Status(404, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            // Re-mint ONLY when the server CONFIRMS the token is unknown — not on any 404. The
            // contract is `{ "error": "unknown_device" }` (apps/orchestration/src/routes/trial.ts);
            // parse the typed field rather than substring-matching the raw body so an unrelated
            // occurrence (or a reworded error) can't misfire / silently stop matching.
            let unknown = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|e| e == "unknown_device"))
                .unwrap_or(false);
            if unknown {
                let fresh = init_device_token().map_err(TrialCallError::Mint)?;
                send_trial(path, &fresh).map_err(classify)
            } else {
                Err(TrialCallError::Status(404, body))
            }
        }
        Err(e) => Err(classify(e)),
    }
}

/// Ensure a device token exists (mint on first run) and return the current server-side usage:
/// `{ promptsUsed, remaining, cap }`.
#[tauri::command]
pub fn trial_remote_status() -> Result<Value, String> {
    match send_trial_reinit_on_404("/trial/status") {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        }
        Err(TrialCallError::Mint(m)) => Err(format!("could not obtain device token: {m}")),
        Err(TrialCallError::Status(code, body)) => Err(format!("trial status failed: HTTP {code}: {body}")),
        Err(TrialCallError::Transport(m)) => Err(format!("trial status failed: {m}")),
    }
}

/// Consume one trial prompt against the SERVER counter. Returns the orchestration JSON verbatim on
/// success (`{ ok: true, promptsUsed, remaining, cap }`), or a stable `{ ok: false, remaining: 0,
/// cap }` at the cap (mirrors desktop_consume's 402 shape) so the UI can gate without parsing HTTP.
#[tauri::command]
pub fn trial_remote_consume() -> Result<Value, String> {
    match send_trial_reinit_on_404("/trial/consume") {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        }
        Err(TrialCallError::Status(402, body)) => {
            let v: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));
            let cap = v.get("cap").and_then(|c| c.as_i64()).unwrap_or(0);
            Ok(json!({ "ok": false, "remaining": 0, "cap": cap }))
        }
        Err(TrialCallError::Mint(m)) => Err(format!("could not obtain device token: {m}")),
        Err(TrialCallError::Status(code, body)) => Err(format!("trial consume failed: HTTP {code}: {body}")),
        Err(TrialCallError::Transport(m)) => Err(format!("trial consume failed: {m}")),
    }
}

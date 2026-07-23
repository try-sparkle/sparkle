// Client side of the SERVER-authoritative anonymous trial meter (design: anonymous-free-trial).
// The opaque device token the orchestration server mints (POST /trial/init) is stored in the macOS
// keychain and NEVER enters JS — every call is made here over ureq, mirroring auth.rs.
//
// CUT OVER (was scaffolding): the hot path now runs through `trial_consume`, which asks the server
// to debit a prompt and folds the answer into the local mirror (trial.rs). Because the counter
// lives server-side keyed by the KEYCHAIN device token, deleting trial.json or reinstalling the app
// no longer grants a fresh trial. `trial_sync` is the read-only reconcile the UI runs at startup.
//
// Threading: every command here is `async` + `spawn_blocking`. The ureq calls are blocking and the
// re-mint retry chain can serialize several 15s timeouts; running that on the Tauri event-loop
// thread is exactly the UI freeze fixed in v0.36.0, and running it on an async-runtime worker would
// park a scheduler thread for the duration.
//
// Like auth.rs, the HTTP/keychain plumbing here carries no Rust unit tests (it needs a live server);
// the pure reconcile logic it feeds is unit-tested in trial.rs, and the cap/endpoint behavior is
// tested server-side in apps/orchestration (trialMath + routes tests).

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::trial::{reconcile_at, trial_json_path, ServerVerdict, TrialLock, TrialMeter};

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
    // Dev-suffixed keychain service in debug builds (mirrors auth.rs; see dev_identity).
    keyring::Entry::new(&crate::dev_identity::keychain_service(), KEYCHAIN_USER)
        .map_err(|e| e.to_string())
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
// result_large_err: ureq::Error embeds the Response for Status errors (~272 bytes). Boxing it
// would ripple through classify()'s by-value match for no gain — this runs a handful of times
// per trial session, never on a hot path.
#[allow(clippy::result_large_err)]
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

fn u32_field(v: &Value, key: &str) -> Option<u32> {
    v.get(key).and_then(|n| n.as_u64()).and_then(|n| u32::try_from(n).ok())
}

/// Read a 2xx `/trial/*` body into an authoritative verdict. A body missing any of the three numbers
/// is treated as `Unreachable` (fail-open) rather than guessed at — we only hard-block on answers we
/// actually understood.
fn verdict_from_body(text: &str) -> ServerVerdict {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return ServerVerdict::Unreachable;
    };
    match (u32_field(&v, "promptsUsed"), u32_field(&v, "remaining"), u32_field(&v, "cap")) {
        (Some(prompts_used), Some(remaining), Some(cap)) => {
            ServerVerdict::Answered { prompts_used, remaining, cap }
        }
        _ => ServerVerdict::Unreachable,
    }
}

/// Ask a `/trial/*` endpoint and classify the answer. NOTHING here fails the caller: an
/// unreachable/erroring server yields `Unreachable`, which reconcile treats as fail-open. Only an
/// affirmative 402 becomes `Exhausted`.
fn ask_server(path: &str) -> ServerVerdict {
    match send_trial_reinit_on_404(path) {
        Ok(resp) => match resp.into_string() {
            Ok(text) => verdict_from_body(&text),
            Err(_) => ServerVerdict::Unreachable,
        },
        Err(TrialCallError::Status(402, body)) => {
            let cap = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| u32_field(&v, "cap"));
            ServerVerdict::Exhausted { cap }
        }
        // Mint failures, transport errors and every other status (5xx, a proxy 404, …) are
        // "we couldn't ask" — never a reason to lock the user out.
        Err(TrialCallError::Mint(m)) => {
            log_unreachable(path, &format!("device token: {m}"));
            ServerVerdict::Unreachable
        }
        Err(TrialCallError::Status(code, body)) => {
            log_unreachable(path, &format!("HTTP {code}: {body}"));
            ServerVerdict::Unreachable
        }
        Err(TrialCallError::Transport(m)) => {
            log_unreachable(path, &m);
            ServerVerdict::Unreachable
        }
    }
}

fn log_unreachable(path: &str, why: &str) {
    eprintln!("[trial] {path} unreachable, failing open: {why}");
}

/// HTTP + the local read-modify-write, as one blocking unit. The `TrialLock` is taken only around
/// the file write (after the network call returns), so a slow request never holds it.
fn ask_and_reconcile(app: &AppHandle, path: &str, spent_one: bool) -> Result<TrialMeter, String> {
    let json_path = trial_json_path(app)?;
    let verdict = ask_server(path);
    let lock = app.state::<TrialLock>();
    let _g = lock.guard();
    reconcile_at(&json_path, verdict, spent_one)
}

/// Read-only reconcile: pull the server's authoritative counter and clamp the local mirror to it.
/// Run at startup for a NON-entitled user, so a reinstall lands on the hard block before the user
/// can send anything. Never spends a prompt; never fails the caller on a network error (it returns
/// the cached mirror with `serverConfirmed: false`).
#[tauri::command]
pub async fn trial_sync(app: AppHandle) -> Result<TrialMeter, String> {
    tauri::async_runtime::spawn_blocking(move || ask_and_reconcile(&app, "/trial/status", false))
        .await
        .map_err(|e| format!("trial sync task failed: {e}"))?
}

/// Debit ONE trial prompt against the SERVER counter — the hot path. Returns the reconciled meter:
/// `blocked: true` (from an affirmative 402, or a successful debit that left 0 remaining) is the
/// hard-block/upgrade signal the UI gates on. A server we couldn't reach fails OPEN: the local cache
/// is debited instead, `serverConfirmed` is false, and `blocked` is left exactly as the server last
/// set it.
#[tauri::command]
pub async fn trial_consume(app: AppHandle) -> Result<TrialMeter, String> {
    tauri::async_runtime::spawn_blocking(move || ask_and_reconcile(&app, "/trial/consume", true))
        .await
        .map_err(|e| format!("trial consume task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_well_formed_body_becomes_an_authoritative_answer() {
        let v = verdict_from_body(r#"{"ok":true,"promptsUsed":3,"remaining":97,"cap":100}"#);
        assert_eq!(v, ServerVerdict::Answered { prompts_used: 3, remaining: 97, cap: 100 });
    }

    #[test]
    fn a_body_reporting_zero_remaining_is_still_an_answer_not_a_failure() {
        // reconcile_at turns remaining:0 into the hard block; the parse must not swallow it.
        let v = verdict_from_body(r#"{"promptsUsed":100,"remaining":0,"cap":100}"#);
        assert_eq!(v, ServerVerdict::Answered { prompts_used: 100, remaining: 0, cap: 100 });
    }

    #[test]
    fn a_garbage_or_partial_body_fails_open_rather_than_guessing() {
        assert_eq!(verdict_from_body("<html>502</html>"), ServerVerdict::Unreachable);
        assert_eq!(verdict_from_body(r#"{"remaining":5}"#), ServerVerdict::Unreachable);
        assert_eq!(verdict_from_body(r#"{"promptsUsed":-1,"remaining":5,"cap":100}"#), ServerVerdict::Unreachable);
    }
}

// Generic Anthropic chat command for the Sparkle Chief interview/synthesis flows, plus the SHARED
// server-side AI proxy client used by every Anthropic caller in the app (naming, judge, attention
// summary, and this chat sink).
//
// Billing keystone (task #10): these calls no longer POST directly to api.anthropic.com with a
// BYOK key. They go through the orchestration `POST /ai/anthropic` route on the user's Sparkle
// bearer token (read from the OS keychain in auth.rs — it never enters JS). The SERVER holds the
// vendor key and meters entitlement + credits (Haiku at 10× actual tokens), so the desktop can no
// longer bypass the meter and no developer secret ships in the binary.
//
// MODEL NOTE: the proxy meters every model in its aiPricing table (`isMeteredAnthropicModel`
// server-side) — Haiku 4.5, Sonnet 4.6, and Opus 4.8 — and REJECTS any other model with 400
// `unsupported_model`. The generic chat sink here uses Sonnet 4.6 (restored from a temporary Haiku
// downgrade, bead sparkle-8k3v, that existed only while the server priced Haiku alone); the tiny
// classify calls (naming/judge/attention) stay on Haiku 4.5 in their own modules.
//
// ureq is pulled WITHOUT its optional `json` feature, so we serialize/parse with serde_json
// directly (send_string / into_string), never send_json/into_json.

use std::time::Duration;

use crate::auth;

/// Sonnet 4.6 — the generic-chat model (brainstorm / AI-composer / ThinkPanel task-planning). Metered
/// server-side at 10× ($3/$15 per MTok). Bare alias, no date suffix.
const CHAT_MODEL: &str = "claude-sonnet-4-6";

/// Bound the proxy call so a stalled orchestration host can't pin a spawn_blocking thread forever
/// (which would eventually exhaust the blocking pool). ureq has no default timeout. A hung endpoint
/// then hits the existing Err/degrade path. Connect is short; the read budget is per-caller (see
/// below). Mirrors connectivity.rs's AgentBuilder shape.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Generous read budget for the interview/synthesis chat sink, whose replies can be long and
/// slow-but-progressing.
const CHAT_READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Tight read budget for the tiny one-shot classification/label calls (naming/judge/attention);
/// their replies are ≤ a few dozen tokens and return fast, so a hung host degrades ~4× sooner than
/// the chat budget would allow. `pub(crate)` so those modules share the exact bound.
pub(crate) const CLASSIFY_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Default token budget when the caller passes 0, so a forgotten/zero `max_tokens` still yields a
/// usable reply rather than the API rejecting a zero budget.
const DEFAULT_MAX_TOKENS: u32 = 1024;

/// Upper bound on `max_tokens`. An unclamped budget from a compromised renderer would be a
/// costly-output amplifier (billed to the user's credits via the server meter). 8192 covers the
/// interview/synthesis replies this drives with headroom; anything larger is clamped down. (The
/// server independently caps forwarded output tokens too — this is defence in depth.)
const MAX_MAX_TOKENS: u32 = 8192;

/// Resolve the effective token budget: 0 (forgotten/unset) → default; otherwise the request,
/// clamped to `MAX_MAX_TOKENS`.
fn clamp_max_tokens(requested: u32) -> u32 {
    match requested {
        0 => DEFAULT_MAX_TOKENS,
        n => n.min(MAX_MAX_TOKENS),
    }
}

/// One-shot Anthropic chat: send `system` + `user`, return the model's first text block. Routed
/// through the server-side proxy on the user's Sparkle bearer (server holds the vendor key + meters
/// credits). Returns Err on any failure (not signed in, out of credits, network, empty result) so
/// the caller can degrade; an out-of-credits error is the typed `insufficient_credits:<bal>` string
/// the JS layer maps to the upsell UI.
#[tauri::command]
pub async fn anthropic_chat(
    system: String,
    user: String,
    max_tokens: u32,
) -> Result<String, String> {
    let user = user.trim().to_string();
    if user.is_empty() {
        return Err("empty user message".into());
    }
    // 0 → default; otherwise clamp so a hostile caller can't amplify metered spend.
    let max_tokens = clamp_max_tokens(max_tokens);

    let base = auth::base_url(); // just an env read — cheap, non-blocking.

    // ureq is blocking AND the keychain read (bearer_token) is a synchronous Security-framework
    // syscall that can block on a locked keychain — keep BOTH off the async runtime's worker by
    // resolving the token inside the blocking closure. No token → signed out; degrade.
    tauri::async_runtime::spawn_blocking(move || {
        let token = auth::bearer_token().ok_or_else(|| "not signed in".to_string())?;
        let json = call_anthropic_proxy(
            &base,
            &token,
            CHAT_MODEL,
            &system,
            &user,
            max_tokens,
            CHAT_READ_TIMEOUT,
        )?;
        extract_text(&json).ok_or_else(|| "anthropic chat returned no text".to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Build the JSON body POSTed to the orchestration `/ai/anthropic` route. Pure so the shape is
/// pinned by unit tests without a network call. Matches the server's `anthropicBody` zod schema:
/// `{ model, max_tokens, messages:[{role,content}], system? }`. `system` is omitted when empty.
pub(crate) fn build_proxy_body(
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{ "role": "user", "content": user }],
    });
    if !system.trim().is_empty() {
        body["system"] = serde_json::Value::String(system.to_string());
    }
    body
}

/// Map a proxy HTTP error status (+ its response body) to a typed error string the JS layer can
/// branch on. `402` carries the current balance so the UI can show "you have $X"; `403`/`503` are
/// stable sentinels; anything else is a generic message. Pure so it's unit-testable. Never echoes
/// the raw server body (it can contain request fragments).
pub(crate) fn classify_proxy_error(code: u16, body: &str) -> String {
    match code {
        402 => {
            let bal = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("balanceCents").and_then(serde_json::Value::as_i64))
                .unwrap_or(0);
            format!("insufficient_credits:{bal}")
        }
        403 => "not_entitled".to_string(),
        503 => "ai_unconfigured".to_string(),
        _ => format!("ai request failed (HTTP {code})"),
    }
}

/// Shared blocking client for the server-side Anthropic proxy. POSTs `{model,system,user,max_tokens}`
/// to `{base_url}/ai/anthropic` authenticated as the user's Sparkle bearer, and returns the parsed
/// JSON response (the Anthropic message shape plus an injected `balanceCents`) on success. `base_url`
/// and `token` are injected (not read from the keychain here) so the request shape + auth header are
/// unit-testable against a loopback server. `read_timeout` is per-caller (tight for the small
/// classification calls, generous for the chat sink). Used by every Anthropic caller.
pub(crate) fn call_anthropic_proxy(
    base_url: &str,
    token: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
    read_timeout: Duration,
) -> Result<serde_json::Value, String> {
    let body = build_proxy_body(model, system, user, max_tokens);
    let body_str = serde_json::to_string(&body).map_err(|e| format!("serialize: {e}"))?;
    let url = format!("{}/ai/anthropic", base_url.trim_end_matches('/'));

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(read_timeout)
        .build();
    let resp = agent
        .post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("content-type", "application/json")
        .send_string(&body_str);

    let raw = match resp {
        Ok(r) => r.into_string().map_err(|e| format!("read body: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            // Log the (bounded) body server-side for debugging; return only the typed sentinel.
            let detail = r.into_string().unwrap_or_default();
            tracing::debug!(code, detail = %detail.chars().take(200).collect::<String>(), "ai proxy returned an error status");
            return Err(classify_proxy_error(code, &detail));
        }
        Err(e) => {
            tracing::debug!(error = %e, "ai proxy request failed");
            return Err("ai request failed".into());
        }
    };
    serde_json::from_str(&raw).map_err(|e| format!("bad JSON: {e}"))
}

/// Pull the first non-empty text block from a Messages API response:
/// `{ "content": [ { "type": "text", "text": "..." }, ... ] }`. Skips non-text blocks (e.g.
/// `tool_use`) and empty/whitespace-only text blocks, so neither a leading tool block nor an empty
/// text block masks real text. Returns None when there is no usable text — the module's contract is
/// that an empty reply degrades through the caller's Err path, not a silent `Ok("")`.
pub(crate) fn extract_text(json: &serde_json::Value) -> Option<String> {
    let blocks = json.get("content")?.as_array()?;
    for block in blocks {
        if block.get("type").and_then(serde_json::Value::as_str) == Some("text") {
            if let Some(t) = block.get("text").and_then(serde_json::Value::as_str) {
                if !t.trim().is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_max_tokens_defaults_zero_and_caps_large() {
        assert_eq!(clamp_max_tokens(0), DEFAULT_MAX_TOKENS); // forgotten/unset → default
        assert_eq!(clamp_max_tokens(512), 512); // in-range request passes through
        assert_eq!(clamp_max_tokens(MAX_MAX_TOKENS), MAX_MAX_TOKENS);
        assert_eq!(clamp_max_tokens(u32::MAX), MAX_MAX_TOKENS); // hostile budget is capped
    }

    #[test]
    fn extract_text_pulls_first_text_block() {
        let j = serde_json::json!({
            "content": [
                { "type": "text", "text": "hello world" },
                { "type": "text", "text": "second" }
            ]
        });
        assert_eq!(extract_text(&j), Some("hello world".to_string()));
    }

    #[test]
    fn extract_text_skips_non_text_blocks() {
        let j = serde_json::json!({
            "content": [
                { "type": "tool_use", "id": "x" },
                { "type": "text", "text": "after tool" }
            ]
        });
        assert_eq!(extract_text(&j), Some("after tool".to_string()));
    }

    #[test]
    fn extract_text_none_when_missing_or_empty() {
        assert_eq!(extract_text(&serde_json::json!({ "content": [] })), None);
        assert_eq!(extract_text(&serde_json::json!({})), None);
        // content present but no text-type block.
        assert_eq!(
            extract_text(&serde_json::json!({ "content": [ { "type": "tool_use" } ] })),
            None
        );
    }

    #[test]
    fn build_proxy_body_shapes_the_request_and_omits_empty_system() {
        let b = build_proxy_body("claude-haiku-4-5", "you are terse", "hi", 256);
        assert_eq!(b["model"], "claude-haiku-4-5");
        assert_eq!(b["max_tokens"], 256);
        assert_eq!(b["system"], "you are terse");
        assert_eq!(b["messages"][0]["role"], "user");
        assert_eq!(b["messages"][0]["content"], "hi");

        // An empty/whitespace system is omitted entirely (not sent as "").
        let b2 = build_proxy_body("claude-haiku-4-5", "   ", "hi", 8);
        assert!(b2.get("system").is_none());
    }

    #[test]
    fn chat_model_is_sonnet_restored_from_haiku_downgrade() {
        // Guards the sparkle-8k3v restoration: the generic chat sink runs on Sonnet 4.6 again (the
        // server now meters Sonnet), not the temporary Haiku downgrade. Bare alias, no date suffix.
        assert_eq!(CHAT_MODEL, "claude-sonnet-4-6");
    }

    #[test]
    fn classify_proxy_error_maps_typed_statuses() {
        // 402 carries the balance so the UI can show "you have $X".
        assert_eq!(
            classify_proxy_error(402, r#"{"error":"insufficient_credits","balanceCents":1234}"#),
            "insufficient_credits:1234"
        );
        // 402 with an unparseable / balance-less body still yields the sentinel (balance 0).
        assert_eq!(classify_proxy_error(402, "nope"), "insufficient_credits:0");
        assert_eq!(classify_proxy_error(403, "{}"), "not_entitled");
        assert_eq!(classify_proxy_error(503, "{}"), "ai_unconfigured");
        assert_eq!(classify_proxy_error(500, "boom"), "ai request failed (HTTP 500)");
    }

    #[test]
    fn extract_text_ignores_the_injected_balance_field() {
        // The proxy returns the Anthropic message shape PLUS a sibling `balanceCents`; extract_text
        // must still pull the reply text and never confuse the extra field for content.
        let j = serde_json::json!({
            "content": [ { "type": "text", "text": "hello" } ],
            "balanceCents": 4200
        });
        assert_eq!(extract_text(&j), Some("hello".to_string()));
    }

    // A minimal one-shot loopback HTTP server: accept a single connection, capture the raw request,
    // and reply with `status` + `body`. Returns the captured request text so tests can assert the
    // method/path/headers we sent. Kept tiny (no deps) — enough to pin the proxy contract end-to-end.
    //
    // We deliberately do NOT send `Connection: close` and we `mem::forget` the socket after writing:
    // `call_anthropic_proxy` uses a POOLING ureq agent, which — on a fully-buffered 2xx body —
    // returns the underlying stream to its pool via a setsockopt that PANICS if the peer already
    // closed the socket (ureq response.rs). Keeping the socket open makes that pool-return succeed.
    // (One leaked test socket per call is harmless.)
    fn serve_once(status: &'static str, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("addr");
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            std::mem::forget(stream); // keep the socket open for ureq's pool-return (see note above)
            req
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn call_anthropic_proxy_posts_bearer_to_ai_anthropic_and_returns_balance() {
        let (base, handle) = serve_once(
            "200 OK",
            r#"{"content":[{"type":"text","text":"named it"}],"usage":{"input_tokens":5,"output_tokens":2},"balanceCents":4200}"#,
        );
        let json = call_anthropic_proxy(
            &base,
            "tok-abc",
            "claude-haiku-4-5",
            "sys",
            "hello",
            256,
            Duration::from_secs(5),
        )
        .expect("proxy call should succeed");
        let req = handle.join().expect("server thread");

        // We hit the right route, with the user's bearer, as a POST.
        assert!(req.starts_with("POST /ai/anthropic "), "unexpected request line: {req:?}");
        assert!(req.contains("Authorization: Bearer tok-abc"), "missing bearer: {req:?}");
        // The response passes through (text + the injected balance).
        assert_eq!(extract_text(&json), Some("named it".to_string()));
        assert_eq!(json.get("balanceCents").and_then(serde_json::Value::as_i64), Some(4200));
    }

    #[test]
    fn call_anthropic_proxy_maps_402_to_insufficient_credits() {
        let (base, handle) = serve_once(
            "402 Payment Required",
            r#"{"error":"insufficient_credits","balanceCents":15}"#,
        );
        let err = call_anthropic_proxy(&base, "tok", "claude-haiku-4-5", "", "hi", 8, Duration::from_secs(5))
            .expect_err("402 must be an Err");
        let _ = handle.join();
        assert_eq!(err, "insufficient_credits:15");
    }

    #[test]
    fn extract_text_skips_empty_text_blocks() {
        // An empty/whitespace-only text block is "no text" — fall through to the next real block,
        // or None so anthropic_chat returns Err rather than a silent Ok("").
        assert_eq!(
            extract_text(&serde_json::json!({ "content": [ { "type": "text", "text": "" } ] })),
            None
        );
        assert_eq!(
            extract_text(&serde_json::json!({ "content": [ { "type": "text", "text": "   " } ] })),
            None
        );
        assert_eq!(
            extract_text(&serde_json::json!({
                "content": [
                    { "type": "text", "text": "  " },
                    { "type": "text", "text": "real" }
                ]
            })),
            Some("real".to_string())
        );
    }
}

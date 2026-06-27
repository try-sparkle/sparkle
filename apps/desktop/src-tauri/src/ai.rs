// Generic Anthropic chat command for the Sparkle Chief interview/synthesis flows. Unlike
// `naming.rs` — which asks the cheapest Haiku model for a terse label — this command lets the
// caller supply an arbitrary system prompt, user message, and token budget, and uses a higher-
// quality model (Sonnet) since it drives interview/synthesis work where quality matters.
//
// Lives in Rust (not the webview) so the BYOK Anthropic key never ships in the JS bundle; it
// reuses `naming::resolve_anthropic_key` so key resolution (env → `.env.local`, exact paths only)
// is identical to the naming path. ureq is pulled WITHOUT its optional `json` feature, so we
// serialize/parse with serde_json directly (send_string / into_string), never send_json/into_json.

use crate::naming::resolve_anthropic_key;

/// Sonnet for interview/synthesis quality (vs. Haiku for naming). Bare alias, no date suffix.
const CHAT_MODEL: &str = "claude-sonnet-4-6";

/// Default token budget when the caller passes 0, so a forgotten/zero `max_tokens` still yields a
/// usable reply rather than the API rejecting a zero budget.
const DEFAULT_MAX_TOKENS: u32 = 1024;

/// One-shot Anthropic chat: send `system` + `user`, return the model's first text block. Returns
/// Err on any failure (no key, network, HTTP error, empty result) so the caller can degrade.
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
    let max_tokens = if max_tokens == 0 { DEFAULT_MAX_TOKENS } else { max_tokens };

    // ureq is blocking and so is key resolution (env / `.env.local` walk) — keep BOTH off the async
    // runtime's worker by resolving the key inside the blocking closure (mirrors `generate_agent_name`).
    tauri::async_runtime::spawn_blocking(move || {
        let key = resolve_anthropic_key().ok_or_else(|| {
            "no Anthropic API key (set ANTHROPIC_API_KEY or add it to .env.local)".to_string()
        })?;
        call_anthropic_chat(&key, &system, &user, max_tokens)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn call_anthropic_chat(
    key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let mut body = serde_json::json!({
        "model": CHAT_MODEL,
        "max_tokens": max_tokens,
        "messages": [{ "role": "user", "content": user }],
    });
    // Only attach `system` when non-empty: omitting it is cleaner than sending an empty string.
    if !system.trim().is_empty() {
        body["system"] = serde_json::Value::String(system.to_string());
    }
    let body_str = serde_json::to_string(&body).map_err(|e| format!("serialize: {e}"))?;

    let resp = ureq::post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", key)
        .set("anthropic-version", "2023-06-01")
        .set("content-type", "application/json")
        .send_string(&body_str);

    let raw = match resp {
        Ok(r) => r.into_string().map_err(|e| format!("read body: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            // Don't surface the upstream body to the UI: it can echo request context, and the API
            // key lives in this function. Log for debugging, return a generic message.
            let detail = r.into_string().unwrap_or_default();
            tracing::debug!(code, detail = %detail, "anthropic chat call returned an error status");
            return Err(format!("anthropic chat failed (HTTP {code})"));
        }
        Err(e) => {
            tracing::debug!(error = %e, "anthropic chat request failed");
            return Err("anthropic chat request failed".into());
        }
    };
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad JSON: {e}"))?;
    extract_text(&json).ok_or_else(|| "anthropic chat returned no text".to_string())
}

/// Pull the first non-empty text block from a Messages API response:
/// `{ "content": [ { "type": "text", "text": "..." }, ... ] }`. Skips non-text blocks (e.g.
/// `tool_use`) and empty/whitespace-only text blocks, so neither a leading tool block nor an empty
/// text block masks real text. Returns None when there is no usable text — the module's contract is
/// that an empty reply degrades through the caller's Err path, not a silent `Ok("")`.
fn extract_text(json: &serde_json::Value) -> Option<String> {
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

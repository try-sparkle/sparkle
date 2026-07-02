// Dynamic Claude model catalog (bead sparkle-i6rw, Phase 2): list the models the user's OWN
// Anthropic key can see via GET /v1/models, so the per-agent model picker can offer models newer
// than the curated list shipped in services/models.ts. This is a BYOK call — unlike the metered
// naming/judge/chat calls (which go through the server-side /ai/anthropic proxy), listing models
// is a free metadata GET, so it runs directly against api.anthropic.com on the user's key.
//
// Degradation contract: the command NEVER surfaces an error dialog. EVERY failure — no key
// configured (true for brand-new installs until the user authorizes), network error, non-200, bad
// JSON — resolves to an EMPTY list (Ok(vec![])). The frontend treats an empty list as "use the
// curated fallback list", so the picker silently degrades; nothing here may panic or block the UI
// (the blocking HTTP runs on spawn_blocking, mirroring ai.rs/naming.rs). The inner `fetch_models`
// still returns Result so the unit tests can assert the request/parse contract; only the public
// command flattens failures to an empty list.
//
// ureq is pulled WITHOUT its optional `json` feature, so parse with serde_json over into_string,
// never into_json.

use std::time::Duration;

const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Page size for /v1/models (API default is 20; 100 fetches the whole catalog in one page today).
const PAGE_LIMIT: u32 = 100;
/// Pagination cap: 4 pages × 100 models is far beyond any plausible catalog; the cap bounds a
/// misbehaving `has_more: true` loop rather than trusting the server to terminate us.
const MAX_PAGES: usize = 4;

// Mirror ai.rs's bounds: ureq has no default timeout, and a hung host would otherwise pin a
// spawn_blocking thread forever. The response is a small JSON list, so a tight read budget is fine.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(15);

/// One model as returned to the webview: `{ id, display_name }`. snake_case on purpose — the JS
/// boundary type (services/models.ts) mirrors the Anthropic wire shape.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
}

/// Parse one /v1/models response page: `{ "data": [{ "id", "display_name", ... }], "has_more",
/// "last_id" }`. Keeps only chat-relevant `claude-*` ids (the endpoint could grow embeddings or
/// other families). An entry with no usable `display_name` falls back to its id so the UI always
/// has a label. Returns (models, has_more, last_id) for the pagination loop.
fn parse_models_page(body: &str) -> Result<(Vec<ModelInfo>, bool, Option<String>), String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("bad JSON: {e}"))?;
    let data = v
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "missing data array".to_string())?;
    let mut models = Vec::new();
    for item in data {
        let Some(id) = item.get("id").and_then(serde_json::Value::as_str) else {
            continue; // shape drift on one entry must not sink the whole page
        };
        if !id.starts_with("claude-") {
            continue;
        }
        let display_name = item
            .get("display_name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string();
        models.push(ModelInfo { id: id.to_string(), display_name });
    }
    let has_more = v.get("has_more").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let last_id = v
        .get("last_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Ok((models, has_more, last_id))
}

/// A pagination cursor is interpolated into the query string, so accept only the model-id
/// alphabet. Anything else (a server bug or a tampered response) ends pagination with the page(s)
/// already fetched rather than building a malformed URL.
fn is_safe_cursor(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Fetch every page of /v1/models from `base_url` (injected so tests can point at a loopback
/// server) with the user's key. Fails the WHOLE call on any page error — a partial catalog would
/// silently hide models, and the frontend's curated fallback is better than a half-list.
fn fetch_models(base_url: &str, key: &str) -> Result<Vec<ModelInfo>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build();
    let base = base_url.trim_end_matches('/');
    let mut all = Vec::new();
    // Dedup by id across pages. Correct `after_id` cursoring shouldn't overlap, but a server hiccup
    // or a repeated `last_id` could echo a model twice; the picker shows a plain list, so keep the
    // first occurrence and drop repeats rather than surface duplicate rows.
    let mut seen = std::collections::HashSet::new();
    let mut after: Option<String> = None;
    // Distinguish a COMPLETE walk (some page reported has_more=false) from a truncated one so the
    // single post-loop check below can log the two silent-truncation exits (unusable cursor, page
    // cap) uniformly instead of scattering a warn at each break site.
    let mut complete = false;
    let mut truncation: Option<&str> = None;
    for _ in 0..MAX_PAGES {
        let mut url = format!("{base}/v1/models?limit={PAGE_LIMIT}");
        if let Some(a) = &after {
            url.push_str(&format!("&after_id={a}"));
        }
        let resp = agent
            .get(&url)
            .set("x-api-key", key)
            .set("anthropic-version", ANTHROPIC_VERSION)
            .call();
        let raw = match resp {
            Ok(r) => r.into_string().map_err(|e| format!("read body: {e}"))?,
            Err(ureq::Error::Status(code, r)) => {
                // Log a bounded body for debugging; return only a generic message (the body can
                // echo request fragments, and no caller branches on the detail).
                let detail = r.into_string().unwrap_or_default();
                tracing::debug!(
                    code,
                    detail = %detail.chars().take(200).collect::<String>(),
                    "models list returned an error status"
                );
                return Err(format!("models request failed (HTTP {code})"));
            }
            Err(e) => {
                tracing::debug!(error = %e, "models list request failed");
                return Err("models request failed".into());
            }
        };
        let (page, has_more, last_id) = parse_models_page(&raw)?;
        for m in page {
            if seen.insert(m.id.clone()) {
                all.push(m);
            }
        }
        if !has_more {
            complete = true;
            break;
        }
        match last_id.filter(|id| is_safe_cursor(id)) {
            Some(id) => after = Some(id),
            None => {
                // has_more=true but no usable cursor: stop with what we have.
                truncation = Some("has_more=true but no usable cursor");
                break;
            }
        }
    }
    // If the loop ran to the page cap without any page reporting has_more=false, it's a truncated
    // catalog too. Both silent-truncation exits log here (unlike a hard error, they degrade quietly)
    // so a genuinely-oversized or misbehaving catalog is diagnosable rather than invisibly hiding
    // models. Today's catalog fits one page, so neither should fire in practice.
    if !complete && truncation.is_none() {
        truncation = Some("hit page cap with has_more=true");
    }
    if let Some(reason) = truncation {
        tracing::warn!(models = all.len(), reason, "models list: returning a partial catalog");
    }
    Ok(all)
}

/// List the Claude models visible to the user's own (BYOK) Anthropic key. NEVER errors on a
/// missing key or a network/HTTP/parse failure — every such case resolves to an EMPTY list so the
/// frontend silently falls back to the curated list (no error dialog). The only Err path is a
/// spawn_blocking join failure, which is a genuine host bug worth surfacing in logs. Key resolution
/// reuses naming.rs's `resolve_env_secret` chain (env var `ANTHROPIC_API_KEY` or `ANTHROPIC_API`,
/// then the dev `.env.local` locations).
#[tauri::command]
pub async fn list_claude_models() -> Result<Vec<ModelInfo>, String> {
    // ureq is blocking and the dotenv reads are filesystem syscalls — keep both off the async
    // runtime's worker threads.
    tauri::async_runtime::spawn_blocking(|| {
        let Some(key) = crate::naming::resolve_env_secret(&["ANTHROPIC_API_KEY", "ANTHROPIC_API"])
        else {
            // No BYOK key configured — the common case on a fresh install. Empty, not Err, so the
            // UI just uses the curated list.
            return Vec::new();
        };
        // Any fetch failure (network, HTTP status, bad JSON) degrades to empty for the same reason.
        fetch_models(ANTHROPIC_BASE, &key).unwrap_or_default()
    })
    .await
    .map_err(|e| format!("join error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"{
        "data": [
            { "id": "claude-fable-5", "display_name": "Claude Fable 5", "created_at": "2026-05-01T00:00:00Z", "type": "model" },
            { "id": "claude-opus-4-8-20260115", "display_name": "Claude Opus 4.8", "type": "model" },
            { "id": "not-a-claude-model", "display_name": "Something Else", "type": "model" },
            { "id": "claude-haiku-4-5", "type": "model" }
        ],
        "has_more": true,
        "first_id": "claude-fable-5",
        "last_id": "claude-haiku-4-5"
    }"#;

    #[test]
    fn parses_ids_and_display_names_keeping_only_claude_models() {
        let (models, has_more, last_id) = parse_models_page(PAGE).expect("should parse");
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["claude-fable-5", "claude-opus-4-8-20260115", "claude-haiku-4-5"],
            "non-claude ids are filtered; order is preserved"
        );
        assert_eq!(models[0].display_name, "Claude Fable 5");
        assert!(has_more);
        assert_eq!(last_id.as_deref(), Some("claude-haiku-4-5"));
    }

    #[test]
    fn missing_or_empty_display_name_falls_back_to_the_id() {
        let (models, _, _) = parse_models_page(PAGE).expect("should parse");
        assert_eq!(models[2].display_name, "claude-haiku-4-5", "no display_name → id");
        let (m2, _, _) = parse_models_page(
            r#"{ "data": [ { "id": "claude-x", "display_name": "   " } ], "has_more": false }"#,
        )
        .expect("should parse");
        assert_eq!(m2[0].display_name, "claude-x", "blank display_name → id");
    }

    #[test]
    fn tolerates_a_malformed_entry_without_sinking_the_page() {
        let (models, has_more, last_id) = parse_models_page(
            r#"{ "data": [ { "display_name": "no id" }, { "id": "claude-y" } ], "has_more": false }"#,
        )
        .expect("should parse");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-y");
        assert!(!has_more);
        assert_eq!(last_id, None);
    }

    #[test]
    fn errors_on_bad_json_or_missing_data() {
        assert!(parse_models_page("not json").is_err());
        assert!(parse_models_page(r#"{ "models": [] }"#).is_err(), "wrong key is an error");
        assert!(parse_models_page(r#"{ "data": "nope" }"#).is_err(), "non-array data is an error");
    }

    #[test]
    fn empty_data_is_ok_and_empty() {
        let (models, has_more, _) =
            parse_models_page(r#"{ "data": [], "has_more": false }"#).expect("should parse");
        assert!(models.is_empty());
        assert!(!has_more);
    }

    #[test]
    fn cursor_safety_accepts_model_ids_and_rejects_url_metacharacters() {
        assert!(is_safe_cursor("claude-haiku-4-5"));
        assert!(is_safe_cursor("claude-opus-4-8-20260115"));
        assert!(!is_safe_cursor(""));
        assert!(!is_safe_cursor("claude&limit=1"));
        assert!(!is_safe_cursor("a b"));
        assert!(!is_safe_cursor("x#y"));
    }

    #[test]
    fn model_info_serializes_snake_case_for_the_js_boundary() {
        let j = serde_json::to_value(ModelInfo {
            id: "claude-x".into(),
            display_name: "Claude X".into(),
        })
        .expect("serialize");
        assert_eq!(j["id"], "claude-x");
        assert_eq!(j["display_name"], "Claude X");
    }

    // A minimal one-shot loopback server (same shape as ai.rs's) so the request contract — GET
    // /v1/models with x-api-key + anthropic-version headers — is pinned without the network.
    // See ai.rs for why the socket is mem::forget-ed (ureq's pooling agent panics on pool-return
    // if the peer already closed).
    fn serve_once(
        status: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
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
            std::mem::forget(stream);
            req
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn fetch_models_gets_v1_models_with_byok_headers() {
        let (base, handle) = serve_once(
            "200 OK",
            r#"{ "data": [ { "id": "claude-fable-5", "display_name": "Claude Fable 5" } ], "has_more": false }"#,
        );
        let models = fetch_models(&base, "sk-test-key").expect("fetch should succeed");
        let req = handle.join().expect("server thread");

        assert!(req.starts_with("GET /v1/models?limit="), "unexpected request line: {req:?}");
        assert!(req.contains("x-api-key: sk-test-key"), "missing BYOK header: {req:?}");
        assert!(req.contains("anthropic-version: 2023-06-01"), "missing version header: {req:?}");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-fable-5");
    }

    #[test]
    fn fetch_models_maps_an_error_status_to_err() {
        let (base, handle) = serve_once("401 Unauthorized", r#"{"error":{"type":"authentication_error"}}"#);
        let err = fetch_models(&base, "sk-bad").expect_err("401 must be an Err");
        let _ = handle.join();
        assert_eq!(err, "models request failed (HTTP 401)");
    }

    // A multi-shot loopback server: answers `responses.len()` requests in order on ONE keep-alive
    // connection, returning each request line so the pagination cursor can be asserted. ureq's
    // AgentBuilder pools connections and REUSES the socket for page 2+, so a per-request `accept()`
    // would block forever on a second connection that never comes — instead we accept once and read
    // each successive request off the same stream. Content-Length responses let ureq frame each body
    // and reuse the connection. mem::forget keeps the socket open for ureq's pool-return (see
    // `serve_once`). Drives the `has_more`/`after_id` loop end-to-end (roborev 27156/27157).
    fn serve_pages(
        responses: &'static [(&'static str, &'static str)],
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("addr");
        let handle = std::thread::spawn(move || {
            let mut reqs = Vec::new();
            let (mut stream, _) = listener.accept().expect("accept");
            for (status, body) in responses {
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break; // client closed early (e.g. pagination stopped before this page)
                }
                reqs.push(String::from_utf8_lossy(&buf[..n]).to_string());
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
            std::mem::forget(stream);
            reqs
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn fetch_models_paginates_and_concatenates_pages() {
        static PAGES: &[(&str, &str)] = &[
            (
                "200 OK",
                r#"{ "data": [ { "id": "claude-opus-4-8", "display_name": "Opus" } ], "has_more": true, "last_id": "claude-opus-4-8" }"#,
            ),
            (
                "200 OK",
                r#"{ "data": [ { "id": "claude-haiku-4-5", "display_name": "Haiku" } ], "has_more": false }"#,
            ),
        ];
        let (base, handle) = serve_pages(PAGES);
        let models = fetch_models(&base, "sk-test").expect("multi-page fetch should succeed");
        let reqs = handle.join().expect("server thread");

        assert_eq!(reqs.len(), 2, "should have made two page requests");
        assert!(
            reqs[1].contains("after_id=claude-opus-4-8"),
            "page 2 must carry the cursor from page 1's last_id: {:?}",
            reqs[1]
        );
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["claude-opus-4-8", "claude-haiku-4-5"],
            "pages are concatenated in order"
        );
    }

    #[test]
    fn fetch_models_dedupes_repeated_ids_across_pages() {
        static PAGES: &[(&str, &str)] = &[
            (
                "200 OK",
                r#"{ "data": [ { "id": "claude-opus-4-8", "display_name": "Opus" } ], "has_more": true, "last_id": "claude-opus-4-8" }"#,
            ),
            (
                "200 OK",
                r#"{ "data": [ { "id": "claude-opus-4-8", "display_name": "Opus dup" }, { "id": "claude-haiku-4-5", "display_name": "Haiku" } ], "has_more": false }"#,
            ),
        ];
        let (base, handle) = serve_pages(PAGES);
        let models = fetch_models(&base, "sk-test").expect("fetch should succeed");
        let _ = handle.join();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["claude-opus-4-8", "claude-haiku-4-5"],
            "a duplicate id across pages is dropped (first occurrence wins)"
        );
    }

    #[test]
    fn fetch_models_stops_on_an_unsafe_cursor_with_the_partial_page() {
        // has_more=true but last_id carries URL metacharacters: pagination must terminate with the
        // page already fetched rather than build a malformed follow-up URL. Only ONE response is
        // queued, so a second request would hang the test's accept — proving the loop stopped.
        static PAGES: &[(&str, &str)] = &[(
            "200 OK",
            r#"{ "data": [ { "id": "claude-opus-4-8", "display_name": "Opus" } ], "has_more": true, "last_id": "claude&evil=1" }"#,
        )];
        let (base, handle) = serve_pages(PAGES);
        let models = fetch_models(&base, "sk-test").expect("fetch should succeed");
        let _ = handle.join();
        assert_eq!(models.len(), 1, "unsafe cursor ends pagination with the partial result");
    }
}

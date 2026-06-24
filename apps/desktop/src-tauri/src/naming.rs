// Auto-naming: turn an agent's first (or meaningfully-changed) prompt into a 2–4 word
// label by asking the cheapest Claude model (Haiku 4.5) for a terse summary. The call
// lives in Rust — not the webview — so the BYOK Anthropic key never ships in the JS
// bundle and we can read it from the user's `.env.local` on disk.
//
// Key resolution (first hit wins): ANTHROPIC_API_KEY env, ANTHROPIC_API env, then a
// `.env.local` walked up from the working dir / the executable, finally
// `$HOME/Projects/sparkle/.env.local`. Either `ANTHROPIC_API_KEY=` or `ANTHROPIC_API=`
// is accepted inside the file (the user named theirs `ANTHROPIC_API`).
//
// Everything degrades gracefully: no key, or any network/parse failure, returns Err — the
// frontend treats that as "leave the current name alone", so the feature is a no-op until
// a key exists rather than a hard error.

use std::path::{Path, PathBuf};

/// Cheapest current Claude model — plenty for a four-word summary. (See the claude-api
/// skill: claude-haiku-4-5 is $1/$5 per MTok; the bare alias is complete, no date suffix.)
const NAMING_MODEL: &str = "claude-haiku-4-5";

const SYSTEM_PROMPT: &str = "You name coding-agent sessions. Given the user's prompt to a \
coding agent, reply with a 2-4 word title (Title Case) summarizing the work. No quotes, no \
punctuation, no trailing period, no preamble — just the title. Example: 'Fix Login Redirect'.";

/// Pull `KEY=value` out of a dotenv-style file body, honoring optional surrounding quotes.
/// Candidate keys are tried in priority order — the first one present and non-empty wins,
/// regardless of where it sits in the file.
fn parse_env_value(body: &str, keys: &[&str]) -> Option<String> {
    for key in keys {
        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((k, v)) = line.split_once('=') else {
                continue;
            };
            let k = k.trim().trim_start_matches("export ").trim();
            if k == *key {
                let v = v.trim().trim_matches('"').trim_matches('\'').trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// Walk `start` and its ancestors looking for a `.env.local` that defines a key.
fn search_dotenv(start: &Path, keys: &[&str]) -> Option<String> {
    for dir in start.ancestors() {
        let candidate = dir.join(".env.local");
        if let Ok(body) = std::fs::read_to_string(&candidate) {
            if let Some(v) = parse_env_value(&body, keys) {
                return Some(v);
            }
        }
    }
    None
}

/// Best-effort BYOK key lookup. See module docs for the resolution order.
fn resolve_anthropic_key() -> Option<String> {
    let keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_API"];

    for k in keys {
        if let Ok(v) = std::env::var(k) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if let Some(v) = search_dotenv(&cwd, &keys) {
            return Some(v);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(v) = search_dotenv(dir, &keys) {
                return Some(v);
            }
        }
    }
    // Known dev location: the repo the desktop app is built from.
    if let Some(home) = std::env::var_os("HOME") {
        let dev = PathBuf::from(home).join("Projects/sparkle/.env.local");
        if let Ok(body) = std::fs::read_to_string(&dev) {
            if let Some(v) = parse_env_value(&body, &keys) {
                return Some(v);
            }
        }
    }
    None
}

/// Trim the model's reply down to a clean 2–4 word title. Defensive against the model
/// adding quotes, a leading "Title:", or running long.
fn sanitize_name(raw: &str) -> String {
    let mut s = raw.trim().trim_matches('"').trim_matches('\'').trim();
    // Drop a leading label like "Title:" / "Name:" if the model added one — but only for known
    // label words, so a real title that happens to contain a colon ("Fix: Auth Bug") is kept.
    if let Some((lead, rest)) = s.split_once(':') {
        let label = lead.trim().to_ascii_lowercase();
        if matches!(label.as_str(), "title" | "name" | "session" | "agent") {
            s = rest.trim();
        }
    }
    let words: Vec<&str> = s.split_whitespace().take(4).collect();
    words.join(" ").trim_end_matches(['.', ',']).to_string()
}

/// Generate a short agent name from a prompt. Returns Err on any failure (no key, network,
/// HTTP error, empty result) so the caller can silently keep the existing name.
#[tauri::command]
pub async fn generate_agent_name(prompt: String) -> Result<String, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("empty prompt".into());
    }
    let key = resolve_anthropic_key()
        .ok_or_else(|| "no Anthropic API key (set ANTHROPIC_API_KEY or add it to .env.local)".to_string())?;

    // ureq is blocking; keep it off the async runtime's worker.
    tauri::async_runtime::spawn_blocking(move || call_anthropic(&key, &prompt))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn call_anthropic(key: &str, prompt: &str) -> Result<String, String> {
    // Serialize/parse via serde_json directly so we don't depend on ureq's optional `json`
    // feature (the crate is pulled in without it).
    let body = serde_json::json!({
        "model": NAMING_MODEL,
        "max_tokens": 24,
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let body_str = serde_json::to_string(&body).map_err(|e| format!("serialize: {e}"))?;

    let resp = ureq::post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", key)
        .set("anthropic-version", "2023-06-01")
        .set("content-type", "application/json")
        .send_string(&body_str);

    let raw = match resp {
        Ok(r) => r.into_string().map_err(|e| format!("read body: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            return Err(format!("Anthropic HTTP {code}: {detail}"));
        }
        Err(e) => return Err(format!("request failed: {e}")),
    };
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad JSON: {e}"))?;

    // Messages API: { "content": [ { "type": "text", "text": "..." }, ... ] }
    let mut text = String::new();
    if let Some(blocks) = json.get("content").and_then(serde_json::Value::as_array) {
        for block in blocks {
            if block.get("type").and_then(serde_json::Value::as_str) == Some("text") {
                if let Some(t) = block.get("text").and_then(serde_json::Value::as_str) {
                    text = t.to_string();
                    break;
                }
            }
        }
    }

    let name = sanitize_name(&text);
    if name.is_empty() {
        return Err("model returned no usable name".into());
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_either_key_name() {
        let body = "# comment\nANTHROPIC_API=\"dummy-value-123\"\nOTHER=1\n";
        assert_eq!(
            parse_env_value(body, &["ANTHROPIC_API_KEY", "ANTHROPIC_API"]),
            Some("dummy-value-123".to_string())
        );
    }

    #[test]
    fn prefers_first_listed_key() {
        let body = "ANTHROPIC_API=second\nANTHROPIC_API_KEY=first\n";
        assert_eq!(
            parse_env_value(body, &["ANTHROPIC_API_KEY", "ANTHROPIC_API"]),
            Some("first".to_string())
        );
    }

    #[test]
    fn empty_value_is_ignored() {
        let body = "ANTHROPIC_API=\n";
        assert_eq!(parse_env_value(body, &["ANTHROPIC_API"]), None);
    }

    #[test]
    fn sanitize_trims_quotes_prefix_and_length() {
        assert_eq!(sanitize_name("\"Fix Login Redirect\""), "Fix Login Redirect");
        assert_eq!(sanitize_name("Title: Add Dark Mode"), "Add Dark Mode");
        assert_eq!(sanitize_name("One Two Three Four Five"), "One Two Three Four");
        assert_eq!(sanitize_name("Refactor Auth."), "Refactor Auth");
        // A real title containing a colon must NOT have its first word eaten.
        assert_eq!(sanitize_name("Fix: Auth Bug"), "Fix: Auth Bug");
    }
}

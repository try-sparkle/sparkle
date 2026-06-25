// Auto-naming: turn an agent's first (or meaningfully-changed) prompt into a 2–4 word
// label by asking the cheapest Claude model (Haiku 4.5) for a terse summary. The call
// lives in Rust — not the webview — so the BYOK Anthropic key never ships in the JS
// bundle and we can read it from the user's `.env.local` on disk.
//
// Key resolution (first hit wins): ANTHROPIC_API_KEY env, ANTHROPIC_API env, then `.env.local`
// at EXACT paths only — the current dir (DEBUG builds only) and `$HOME/Projects/sparkle/.env.local`.
// We deliberately do NOT walk parent directories (that was a key-injection vector); see
// `resolve_anthropic_key`. Either `ANTHROPIC_API_KEY=` or `ANTHROPIC_API=` is accepted inside the
// file (the user named theirs `ANTHROPIC_API`).
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

/// Read ONE dotenv file at the exact `path` and pull the first matching key. Deliberately not
/// a directory walk — see `resolve_anthropic_key` for why ancestor traversal is unsafe.
fn read_dotenv_key(path: &Path, keys: &[&str]) -> Option<String> {
    let body = std::fs::read_to_string(path).ok()?;
    parse_env_value(&body, keys)
}

/// Best-effort secret lookup shared by the BYOK integrations (Anthropic key, Chief PAT).
/// Resolution order (first non-empty wins):
///   1. each name in `keys` as a process env var (all builds).
///   2. DEBUG builds only: `.env.local` in the process's current dir (the repo root in `tauri dev`).
///   3. `$HOME/Projects/sparkle/.env.local` — the known dev repo location (all builds).
///
/// SECURITY: we read only those EXACT paths and never walk parent directories. A prior version
/// walked the ancestors of `current_dir()` and `current_exe()` for any `.env.local`, which let
/// anyone who could drop a `.env.local` into a parent dir of the app's working/exe dir (a shared
/// project folder, `/Applications`, a temp dir the CWD happened to land in) substitute their OWN
/// secret — a key-injection vector. The CWD read (#2) is itself a narrower variant (current_dir()
/// is wherever the binary was launched from), so it's gated to DEBUG builds and never compiled
/// into the packaged app; the `$HOME/Projects/sparkle` path (#3) sits inside the user's own home,
/// where writing already implies the user's own privileges. Reading at runtime (not build time)
/// keeps secrets out of the shipped bundle/binary. (Longer term these should live in the OS
/// keychain — see the TODO in lib.rs.)
pub(crate) fn resolve_env_secret(keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Ok(v) = std::env::var(k) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }

    // Dev convenience only — not compiled into release/packaged builds (see SECURITY note).
    #[cfg(debug_assertions)]
    {
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(v) = read_dotenv_key(&cwd.join(".env.local"), keys) {
                return Some(v);
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let dev = PathBuf::from(home).join("Projects/sparkle/.env.local");
        if let Some(v) = read_dotenv_key(&dev, keys) {
            return Some(v);
        }
    }
    None
}

/// Best-effort BYOK key lookup. See module docs for the resolution order.
fn resolve_anthropic_key() -> Option<String> {
    resolve_env_secret(&["ANTHROPIC_API_KEY", "ANTHROPIC_API"])
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
            // Don't surface the upstream response body to the UI: it can echo request context,
            // and the API key lives in this function. Log it for debugging, return a generic msg.
            let detail = r.into_string().unwrap_or_default();
            tracing::debug!(code, detail = %detail, "anthropic naming call returned an error status");
            return Err(format!("naming failed (Anthropic HTTP {code})"));
        }
        Err(e) => {
            tracing::debug!(error = %e, "anthropic naming request failed");
            return Err("naming request failed".into());
        }
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
        // Fixture value is a deliberately non-secret-shaped placeholder: this test only
        // exercises dotenv parsing, and a real key prefix here would (correctly) trip the
        // publish leak-gate since this file is in the public export.
        let body = "# comment\nANTHROPIC_API=\"dummy-key-value\"\nOTHER=1\n";
        assert_eq!(
            parse_env_value(body, &["ANTHROPIC_API_KEY", "ANTHROPIC_API"]),
            Some("dummy-key-value".to_string())
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
    fn resolve_env_secret_reads_a_process_env_var() {
        // Uniquely-named so it can't collide with a real var, and — since resolve_env_secret also
        // walks cwd/$HOME `.env.local` — so no stray dotenv along that chain could define it and
        // make the absent-case assertion below flaky. The env var is the first link in the chain;
        // the second assertion exercises the full fall-through to a clean None.
        let key = "SPARKLE_CHIEF_RESOLVER_TEST_KEY";
        std::env::set_var(key, "  pat_resolved  ");
        assert_eq!(resolve_env_secret(&[key]), Some("pat_resolved".to_string()));
        std::env::remove_var(key);
        assert_eq!(resolve_env_secret(&[key]), None, "absent var, no dotenv hit → None");
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

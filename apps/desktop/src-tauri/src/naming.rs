// Auto-naming: turn an agent's first (or meaningfully-changed) prompt into THREE length
// variants of a label (short 2–4 / medium 5–6 / long 8–10 words) by asking the cheapest
// Claude model (Haiku 4.5) for a terse summary in one call. The webview picks the longest
// variant that fits the sidebar column and reveals the long form on hover. The call lives
// in Rust — not the webview — so the BYOK Anthropic key never ships in the JS bundle and we
// can read it from the user's `.env.local` on disk.
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

const SYSTEM_PROMPT: &str = "You name coding-agent sessions by the SUBSTANCE of the work — the \
feature, component, or problem being worked on — NOT by restating an operational command. \
Given the user's prompt, do EXACTLY ONE of these:\n\
- Reply with EXACTLY the single word SKIP (and nothing else) ONLY when the prompt is purely an \
operational/process command, an acknowledgement, or a greeting with NO subject of work to name \
(e.g. 'push to production', 'commit and push', 'run the tests', 'continue', 'retry', 'looks good', \
'thanks', 'hi'). When in doubt, do NOT skip — name it.\n\
- Otherwise, name the subject of the work. A QUESTION, COMPLAINT, BUG REPORT, INVESTIGATION, or \
DISCUSSION about a feature, component, or problem DOES have a subject and MUST be named by that \
subject — never skipped just because it is not phrased as an imperative command. Summarize the \
SAME work as three Title Case titles of increasing length. Reply with ONLY a JSON object — no \
preamble, no markdown fences: \
{\"short\": \"2-4 words\", \"medium\": \"5-6 words\", \"long\": \"8-10 words\"}. Each value is a \
title (no surrounding quotes, no trailing punctuation). Name the subject of the work, e.g. \
'Voice Dictation Pipeline', never a command like 'Push Code Changes'.\n\
Examples:\n\
{\"short\": \"Fix Login Redirect\", \"medium\": \"Fix OAuth Login Redirect Loop\", \
\"long\": \"Fix OAuth Login Redirect Loop After Token Refresh\"}\n\
{\"short\": \"Deepgram Dictation Streaming\", \"medium\": \"Debug Deepgram Live Dictation Streaming\", \
\"long\": \"Investigate Why Deepgram Cloud Dictation Is Not Streaming Live\"}";

/// The three length variants of an auto-name. Serialized to the webview as
/// `{ short, medium, long }`; the UI renders the longest one that fits the column.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AgentName {
    pub short: String,
    pub medium: String,
    pub long: String,
}

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

/// Best-effort BYOK key lookup. See module docs for the resolution order. `pub(crate)` so the
/// generic chat command in `ai.rs` reuses the exact same resolver (env → `.env.local`).
pub(crate) fn resolve_anthropic_key() -> Option<String> {
    resolve_env_secret(&["ANTHROPIC_API_KEY", "ANTHROPIC_API"])
}

/// Best-effort Deepgram key lookup for the cloud dictation path. The user named theirs
/// `DEEPGRAM_API` in `.env.local` (mirroring the `ANTHROPIC_API` convention); also accept the
/// conventional `DEEPGRAM_API_KEY`. Same resolution order and security posture as the Anthropic
/// key (runtime read, exact paths only) — see `resolve_env_secret`.
pub(crate) fn resolve_deepgram_key() -> Option<String> {
    resolve_env_secret(&["DEEPGRAM_API_KEY", "DEEPGRAM_API"])
}

/// Trim the model's reply down to a clean title of at most `max_words` words. Defensive
/// against the model adding quotes, a leading "Title:", or running long.
fn sanitize_name(raw: &str, max_words: usize) -> String {
    let mut s = raw.trim().trim_matches('"').trim_matches('\'').trim();
    // Drop a leading label like "Title:" / "Name:" if the model added one — but only for known
    // label words, so a real title that happens to contain a colon ("Fix: Auth Bug") is kept.
    if let Some((lead, rest)) = s.split_once(':') {
        let label = lead.trim().to_ascii_lowercase();
        if matches!(label.as_str(), "title" | "name" | "session" | "agent") {
            s = rest.trim();
        }
    }
    let words: Vec<&str> = s.split_whitespace().take(max_words).collect();
    words.join(" ").trim_end_matches(['.', ',']).to_string()
}

/// Parse the model's reply into the three length variants. The model is asked for a bare JSON
/// object, but tolerate stray prose or ```json fences by slicing from the first `{` to the
/// last `}`. Returns None if no usable object is found so the caller can fall back.
fn parse_variants(text: &str) -> Option<AgentName> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let slice = text.get(start..=end)?;
    let v: serde_json::Value = serde_json::from_str(slice).ok()?;
    let field = |k: &str, cap: usize| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(|s| sanitize_name(s, cap))
            .unwrap_or_default()
    };
    let name = normalize(AgentName {
        short: field("short", 4),
        medium: field("medium", 6),
        long: field("long", 10),
    });
    // At least one variant must have survived sanitizing.
    if name.short.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Backfill any empty variant from a longer-then-shorter neighbor so the UI always has a
/// non-empty string to show at every length (e.g. the model omitted "long" → reuse "medium").
fn normalize(mut n: AgentName) -> AgentName {
    if n.medium.is_empty() {
        n.medium = if !n.long.is_empty() { n.long.clone() } else { n.short.clone() };
    }
    if n.long.is_empty() {
        n.long = n.medium.clone();
    }
    if n.short.is_empty() {
        n.short = n.medium.clone();
    }
    n
}

/// Interpret the model's reply text into the three name variants. Returns Err when the prompt
/// was operational or too thin to describe work (the model replies with a bare `SKIP` token) or
/// when no usable title can be derived — both flow through the caller's swallow-on-error path,
/// leaving the agent's current name untouched.
fn interpret_reply(text: &str) -> Result<AgentName, String> {
    let trimmed = text.trim();
    // A reply containing `{` is an attempted JSON object (the format we asked for); one without is
    // either the bare SKIP sentinel or a plain-title reply that ignored the JSON instruction. We
    // branch on that up front so the plain-title fallback below can NEVER stringify broken JSON.
    if !trimmed.contains('{') {
        // SKIP sentinel: match only the BARE token (optionally wrapped in quotes/punctuation).
        let token = trimmed.trim_matches(|c: char| !c.is_alphanumeric());
        if token.eq_ignore_ascii_case("SKIP") {
            return Err("naming skipped (operational or low-content prompt)".into());
        }
        // Plain-title fallback: a model that ignored the JSON instruction and returned a bare
        // title still yields a usable (if uniform) name derived from the whole reply.
        let long = sanitize_name(text, 10);
        if long.is_empty() {
            return Err("model returned no usable name".into());
        }
        return Ok(normalize(AgentName {
            short: sanitize_name(text, 4),
            medium: sanitize_name(text, 6),
            long,
        }));
    }
    // Attempted JSON: parse the object. If it doesn't parse — e.g. the reply was truncated
    // mid-object so there's no closing `}` — we must NOT fall back to stringifying the raw braces
    // (that leaked names like `{"short": "…`). Fail instead, so the caller keeps the existing name.
    parse_variants(text).ok_or_else(|| "naming reply was malformed or truncated JSON".to_string())
}

/// Generate the three length variants of an agent name from a prompt. Returns Err on any
/// failure (no key, network, HTTP error, empty result) so the caller can silently keep the
/// existing name.
#[tauri::command]
pub async fn generate_agent_name(prompt: String) -> Result<AgentName, String> {
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

fn call_anthropic(key: &str, prompt: &str) -> Result<AgentName, String> {
    // Serialize/parse via serde_json directly so we don't depend on ureq's optional `json`
    // feature (the crate is pulled in without it).
    let body = serde_json::json!({
        // Three titles (plus JSON braces/keys/quotes, and a ```json fence the model often adds)
        // need real headroom: at 200 a slightly verbose reply truncated mid-JSON, leaving no
        // closing `}` so parse_variants failed and the raw braces leaked into the name. 512 gives
        // comfortable room for all three variants + fence and is still cheap on Haiku.
        "model": NAMING_MODEL,
        "max_tokens": 512,
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

    interpret_reply(&text)
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
    fn parses_the_deepgram_key_under_either_name() {
        // The cloud dictation path resolves the same way; the user's file uses DEEPGRAM_API.
        let body = "DEEPGRAM_API=\"dg-dummy\"\n";
        assert_eq!(
            parse_env_value(body, &["DEEPGRAM_API_KEY", "DEEPGRAM_API"]),
            Some("dg-dummy".to_string())
        );
        let body2 = "DEEPGRAM_API_KEY=dg-conventional\n";
        assert_eq!(
            parse_env_value(body2, &["DEEPGRAM_API_KEY", "DEEPGRAM_API"]),
            Some("dg-conventional".to_string())
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
        assert_eq!(sanitize_name("\"Fix Login Redirect\"", 4), "Fix Login Redirect");
        assert_eq!(sanitize_name("Title: Add Dark Mode", 4), "Add Dark Mode");
        assert_eq!(sanitize_name("One Two Three Four Five", 4), "One Two Three Four");
        assert_eq!(sanitize_name("Refactor Auth.", 4), "Refactor Auth");
        // A real title containing a colon must NOT have its first word eaten.
        assert_eq!(sanitize_name("Fix: Auth Bug", 4), "Fix: Auth Bug");
    }

    #[test]
    fn sanitize_respects_the_word_cap() {
        let six = "One Two Three Four Five Six Seven Eight";
        assert_eq!(sanitize_name(six, 6), "One Two Three Four Five Six");
        assert_eq!(sanitize_name(six, 10), "One Two Three Four Five Six Seven Eight");
    }

    #[test]
    fn parses_the_three_variant_object() {
        let reply = r#"{"short":"Fix Login Redirect","medium":"Fix OAuth Login Redirect Loop","long":"Fix OAuth Login Redirect Loop After Token Refresh"}"#;
        let n = parse_variants(reply).expect("should parse");
        assert_eq!(n.short, "Fix Login Redirect");
        assert_eq!(n.medium, "Fix OAuth Login Redirect Loop");
        assert_eq!(n.long, "Fix OAuth Login Redirect Loop After Token Refresh");
    }

    #[test]
    fn parses_through_markdown_fences_and_prose() {
        let reply = "Sure! Here you go:\n```json\n{\"short\": \"Add Dark Mode\", \"medium\": \"Add Dark Mode Toggle Setting\", \"long\": \"Add Dark Mode Toggle To Settings Page Header\"}\n```";
        let n = parse_variants(reply).expect("should parse despite fences");
        assert_eq!(n.short, "Add Dark Mode");
        assert_eq!(n.medium, "Add Dark Mode Toggle Setting");
    }

    #[test]
    fn parse_caps_each_variant_length() {
        // Model ignores the word budgets — we still clamp to 4/6/10.
        let reply = r#"{"short":"A B C D E F","medium":"A B C D E F G H","long":"A B C D E F G H I J K L"}"#;
        let n = parse_variants(reply).expect("should parse");
        assert_eq!(n.short.split_whitespace().count(), 4);
        assert_eq!(n.medium.split_whitespace().count(), 6);
        assert_eq!(n.long.split_whitespace().count(), 10);
    }

    #[test]
    fn normalize_backfills_missing_variants() {
        // Only "short" present → medium and long reuse it.
        let n = normalize(AgentName {
            short: "Fix Bug".into(),
            medium: String::new(),
            long: String::new(),
        });
        assert_eq!(n.medium, "Fix Bug");
        assert_eq!(n.long, "Fix Bug");
        // Only "long" present → short and medium reuse it.
        let n = normalize(AgentName {
            short: String::new(),
            medium: String::new(),
            long: "Fix The Login Redirect Loop Bug".into(),
        });
        assert_eq!(n.short, "Fix The Login Redirect Loop Bug");
        assert_eq!(n.medium, "Fix The Login Redirect Loop Bug");
    }

    #[test]
    fn parse_variants_rejects_non_object() {
        assert!(parse_variants("just a plain title, no json").is_none());
    }

    #[test]
    fn interpret_reply_skips_the_bare_sentinel() {
        // The model returns a bare SKIP token for operational/thin prompts → Err so the caller
        // (and the frontend's swallow-on-error path) leaves the existing name untouched.
        assert!(interpret_reply("SKIP").is_err());
        assert!(interpret_reply("skip").is_err());
        assert!(interpret_reply("  SKIP.  ").is_err());
        assert!(interpret_reply("\"SKIP\"").is_err());
    }

    #[test]
    fn interpret_reply_keeps_a_real_title_containing_the_word_skip() {
        // A genuine title with "skip" in it arrives as a JSON object, NOT the bare sentinel —
        // it must be named normally, not dropped.
        let reply = r#"{"short":"Skip Onboarding","medium":"Skip Onboarding Step Flow","long":"Add A Skip Button To The Onboarding Step Flow"}"#;
        let n = interpret_reply(reply).expect("a titled object must not be treated as SKIP");
        assert_eq!(n.short, "Skip Onboarding");
    }

    #[test]
    fn interpret_reply_parses_the_variant_object() {
        let reply = r#"{"short":"Fix Auth Bug","medium":"Fix OAuth Login Bug","long":"Fix OAuth Login Bug On Token Refresh"}"#;
        let n = interpret_reply(reply).expect("should parse");
        assert_eq!(n.short, "Fix Auth Bug");
        assert_eq!(n.medium, "Fix OAuth Login Bug");
    }

    #[test]
    fn interpret_reply_falls_back_to_a_plain_title() {
        let n = interpret_reply("Voice Dictation Pipeline").expect("plain title is usable");
        assert_eq!(n.long, "Voice Dictation Pipeline");
        assert_eq!(n.short, "Voice Dictation Pipeline"); // ≤4 words, so short == full
    }

    #[test]
    fn interpret_reply_errors_on_empty() {
        assert!(interpret_reply("   ").is_err());
    }

    #[test]
    fn system_prompt_instructs_naming_of_questions_not_just_commands() {
        // Regression guard: a substantive QUESTION/COMPLAINT/BUG-REPORT (which has a subject of
        // work) was being answered with SKIP by the model, so agents that opened with such a prompt
        // (e.g. "are we using Deepgram? I don't see live streaming") kept their default "Build N"
        // name. The fix lives in the system prompt: it must explicitly tell the model that a
        // question/discussion still has a subject to name, while still allowing SKIP for pure
        // operational commands. Keep both halves so a future edit can't silently regress either.
        assert!(SYSTEM_PROMPT.contains("QUESTION"), "prompt must name questions, not skip them");
        assert!(SYSTEM_PROMPT.contains("do NOT skip"), "prompt must bias toward naming when unsure");
        assert!(SYSTEM_PROMPT.contains("SKIP"), "prompt must still allow SKIP for operational commands");
    }

    #[test]
    fn interpret_reply_rejects_truncated_json_instead_of_leaking_braces() {
        // The real bug from the field: too small a max_tokens cut the reply off mid-"medium", so
        // there's no closing `}`. parse_variants can't parse it, and the OLD plain-title fallback
        // stringified the raw braces into the name (e.g. `{"short": "URL Path…`). A reply that is
        // an ATTEMPTED JSON object (contains `{`) but won't parse must now error, so the caller
        // keeps the existing name rather than showing raw JSON.
        let truncated =
            "```json\n{ \"short\": \"URL Path Clickable File Navigation\", \"medium\": \"Make";
        let out = interpret_reply(truncated);
        assert!(out.is_err(), "truncated JSON must error, not become a name: {out:?}");

        // And on the failure path nothing leaks: if it ever did return Ok, no variant may carry a
        // stray brace or quote from the raw reply.
        if let Ok(n) = out {
            for v in [&n.short, &n.medium, &n.long] {
                assert!(!v.contains('{') && !v.contains('"'), "leaked raw JSON into a name: {v}");
            }
        }
    }
}

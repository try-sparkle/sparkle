// Auto-naming: turn an agent's first (or meaningfully-changed) prompt into a short TITLE plus a
// one-sentence DESCRIPTION of the work, by asking the cheapest Claude model (Haiku 4.5) in one
// call. The sidebar shows the title (truncated to fit the column) and reveals the title + the
// description on hover. The call lives in Rust — not the webview — so the user's Sparkle bearer
// token never ships in the JS bundle.
//
// Billing (task #10): the Anthropic call goes through the orchestration `POST /ai/anthropic` proxy
// on the user's keychain bearer (see `ai::call_anthropic_proxy`). The SERVER holds the vendor key
// and meters credits — there is no BYOK Anthropic key on the desktop anymore, so no developer
// secret ships in the binary. Cloud dictation moved the SAME way (task #13): the Deepgram key +
// meter now live behind the orchestration `/ai/deepgram` relay, so the local Deepgram key resolver
// was removed too. (The `resolve_env_secret` helper below survives ONLY for the Chief PAT.)
//
// Everything degrades gracefully: signed out, out of credits, or any network/parse failure returns
// Err — the frontend treats that as "leave the current name alone", so the feature is a no-op until
// the user is signed in with credit rather than a hard error.

use std::path::{Path, PathBuf};

/// Cheapest current Claude model — plenty for a short title + one-sentence summary. (See the
/// claude-api skill: claude-haiku-4-5 is $1/$5 per MTok; the bare alias is complete, no date suffix.)
const NAMING_MODEL: &str = "claude-haiku-4-5";

const SYSTEM_PROMPT: &str = "You name coding-agent sessions by the SUBSTANCE of the work — the \
feature, component, or problem being worked on — NOT by restating an operational command. \
Given the user's prompt, do EXACTLY ONE of these:\n\
- Reply with EXACTLY the single word SKIP (and nothing else) ONLY when the prompt is a bare \
operational/process command or acknowledgement with literally nothing else to name (e.g. 'push to \
production', 'commit and push', 'run the tests', 'continue', 'retry', 'looks good', 'thanks'). A \
greeting, a question about your capabilities, or any conversational/meta prompt is NOT a skip — give \
it a short topical name (e.g. 'Capabilities Overview', 'Getting Started'). Strongly prefer naming: \
when in any doubt, do NOT skip.\n\
- Otherwise, name the topic. A QUESTION, COMPLAINT, BUG REPORT, INVESTIGATION, DISCUSSION, GREETING, \
or META/CONVERSATIONAL prompt (including asking what you can do) all have a topic and MUST be named \
by it — never skipped just because it is not phrased as an imperative command. Reply with ONLY a \
JSON object — no preamble, no markdown fences: \
{\"title\": \"3-5 words\", \"description\": \"one short sentence\"}. The title is a 3–5 word Title \
Case label of the work (no surrounding quotes, no trailing punctuation). The description is one \
short plain sentence (≤ ~16 words) saying what the work is about. Name the subject of the work, \
e.g. 'Voice Dictation Pipeline', never a command like 'Push Code Changes'.\n\
Examples:\n\
{\"title\": \"Fix OAuth Redirect Loop\", \"description\": \"Stops the login page from looping after \
a token refresh\"}\n\
{\"title\": \"Deepgram Dictation Streaming\", \"description\": \"Investigates why cloud dictation is \
not streaming live transcripts\"}\n\
{\"title\": \"Agent Capabilities Overview\", \"description\": \"User asks what the agent can do\"}";

/// An auto-generated agent name: a short `title` for the sidebar plus a one-sentence
/// `description` revealed on hover. Serialized to the webview as `{ title, description }`.
/// `description` may be empty (e.g. a plain-title fallback or a Claude Code session title).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AgentName {
    pub title: String,
    pub description: String,
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
/// a directory walk — see `resolve_env_secret` for why ancestor traversal is unsafe.
fn read_dotenv_key(path: &Path, keys: &[&str]) -> Option<String> {
    let body = std::fs::read_to_string(path).ok()?;
    parse_env_value(&body, keys)
}

/// Best-effort secret lookup for the remaining local integration (the Chief PAT). The Anthropic and
/// Deepgram key resolvers were removed — both now run server-side through the `/ai/*` proxies.
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

/// Clean up the one-sentence description: strip surrounding quotes / a "Description:" label and
/// collapse whitespace, then cap the length so a runaway reply can't blow out the hover card.
/// Unlike the title we keep internal sentence punctuation but cap to `MAX_DESC_WORDS` words.
fn sanitize_description(raw: &str) -> String {
    const MAX_DESC_WORDS: usize = 30;
    let mut s = raw.trim().trim_matches('"').trim_matches('\'').trim();
    if let Some((lead, rest)) = s.split_once(':') {
        let label = lead.trim().to_ascii_lowercase();
        if matches!(label.as_str(), "description" | "desc" | "summary" | "about") {
            s = rest.trim();
        }
    }
    s.split_whitespace().take(MAX_DESC_WORDS).collect::<Vec<_>>().join(" ")
}

/// Parse the model's reply into a title + description. The model is asked for a bare JSON object,
/// but tolerate stray prose or ```json fences by slicing from the first `{` to the last `}`.
/// Returns None if no usable title is found so the caller can fall back.
fn parse_name(text: &str) -> Option<AgentName> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let slice = text.get(start..=end)?;
    let v: serde_json::Value = serde_json::from_str(slice).ok()?;
    let title = v
        .get("title")
        .and_then(serde_json::Value::as_str)
        .map(|s| sanitize_name(s, 5))
        .unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    let description = v
        .get("description")
        .and_then(serde_json::Value::as_str)
        .map(sanitize_description)
        .unwrap_or_default();
    Some(AgentName { title, description })
}

/// True when a non-JSON reply opens like a conversational message (a refusal, apology, or
/// clarifying question) rather than a bare title — e.g. "I can see you've shared an image, but
/// I'm unable…" or "I don't see any image attached. Could you…". The model emits these when the
/// prompt has nothing nameable (it should have replied SKIP, but doesn't always). A real
/// plain-title fallback is a Title-Case noun phrase ("Voice Dictation Pipeline") and never opens
/// with first-person / apologetic / interrogative phrasing, so matching these leading markers
/// can't swallow a genuine title. Defense-in-depth behind the frontend fix that stops sending
/// attachment-only messages to the model at all.
fn looks_conversational(text: &str) -> bool {
    let lower = text.trim_start().to_ascii_lowercase();
    // Each opener is followed by a space in real refusals/questions; generic single words
    // ("sorry", "hmm") carry their trailing separator so they can't swallow a genuine Title-Case
    // fallback like "Sorry State Of Logging". Broader phrases that are implausible title prefixes
    // ("i can see", "could you") need no separator. "can you" is intentionally omitted (it's a
    // plausible feature title, e.g. "Can You Hear Me Indicator"; the refusal form "could you" is
    // covered).
    const OPENERS: &[&str] = &[
        "i can see", "i see", "i notice", "i don't", "i do not", "i can't", "i cannot",
        "i'm sorry", "i am sorry", "i'm unable", "i am unable", "i'm not able", "i am not able",
        "i'd be happy", "i would be happy", "i'd need", "i don’t", "i can’t", "i’m sorry",
        "i’m unable", "sorry,", "sorry ", "unfortunately", "it looks like", "it seems", "could you",
        "please provide", "please share", "to name", "there's no", "there is no",
        "no image", "hmm,", "hmm ",
    ];
    OPENERS.iter().any(|o| lower.starts_with(o))
}

/// Interpret the model's reply text into a name. Returns Err when the prompt was operational or
/// too thin to describe work (the model replies with a bare `SKIP` token) or when no usable title
/// can be derived — both flow through the caller's swallow-on-error path, leaving the agent's
/// current name untouched.
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
        // A conversational reply (refusal/apology/clarifying question) is not a title — reject it
        // so we never turn "I can see you've shared an image, but I'm unable…" into a 5-word name.
        if looks_conversational(text) {
            return Err("naming reply was conversational, not a title".into());
        }
        // Plain-title fallback: a model that ignored the JSON instruction and returned a bare
        // title still yields a usable title (with no description).
        let title = sanitize_name(text, 5);
        if title.is_empty() {
            return Err("model returned no usable name".into());
        }
        return Ok(AgentName { title, description: String::new() });
    }
    // Attempted JSON: parse the object. If it doesn't parse — e.g. the reply was truncated mid-
    // object so there's no closing `}` — we must NOT fall back to stringifying the raw braces
    // (that leaked names like `{"title": "…`). Fail instead, so the caller keeps the existing name.
    parse_name(text).ok_or_else(|| "naming reply was malformed or truncated JSON".to_string())
}

/// Generate a title + description for an agent from a prompt. Returns Err on any failure (no key,
/// network, HTTP error, empty result) so the caller can silently keep the existing name.
#[tauri::command]
pub async fn generate_agent_name(prompt: String) -> Result<AgentName, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("empty prompt".into());
    }
    // The Anthropic call runs server-side on the user's Sparkle bearer (from the keychain).
    let base = crate::auth::base_url(); // just an env read — cheap, non-blocking.

    // ureq is blocking AND the keychain read is a syscall that can block on a locked keychain — keep
    // BOTH off the async runtime's worker by resolving the token inside the blocking closure. No
    // token → signed out; degrade (leave the name as-is) rather than call the proxy.
    tauri::async_runtime::spawn_blocking(move || {
        let token = crate::auth::bearer_token().ok_or_else(|| "not signed in".to_string())?;
        call_anthropic(&base, &token, &prompt)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn call_anthropic(base: &str, token: &str, prompt: &str) -> Result<AgentName, String> {
    // A short title + one sentence (plus JSON braces/keys/quotes, and a ```json fence the model
    // often adds) fits comfortably in 256 tokens. The proxy holds the vendor key + meters credits.
    let json = crate::ai::call_anthropic_proxy(
        base,
        token,
        NAMING_MODEL,
        SYSTEM_PROMPT,
        prompt,
        256,
        crate::ai::CLASSIFY_READ_TIMEOUT,
    )?;
    let text = crate::ai::extract_text(&json)
        .ok_or_else(|| "naming returned no text".to_string())?;
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
    fn sanitize_description_strips_label_and_caps_length() {
        assert_eq!(
            sanitize_description("\"Stops the login loop after refresh\""),
            "Stops the login loop after refresh"
        );
        assert_eq!(
            sanitize_description("Description: Investigates the streaming bug"),
            "Investigates the streaming bug"
        );
        // Runaway reply is capped to 30 words.
        let long = (1..=40).map(|n| n.to_string()).collect::<Vec<_>>().join(" ");
        assert_eq!(sanitize_description(&long).split_whitespace().count(), 30);
    }

    #[test]
    fn sanitize_description_keeps_non_label_colons() {
        // A colon that is NOT a known label prefix (a URL, or "Foo: bar" where Foo isn't a label
        // word) must be preserved verbatim — only "Description:"/"Desc:"/"Summary:"/"About:" strip.
        assert_eq!(
            sanitize_description("Fixes the http://x.test redirect"),
            "Fixes the http://x.test redirect"
        );
        assert_eq!(
            sanitize_description("Adds a Status: ready badge to the header"),
            "Adds a Status: ready badge to the header"
        );
    }

    #[test]
    fn parses_title_and_description() {
        let reply = r#"{"title":"Fix Login Redirect","description":"Stops the OAuth login loop after a token refresh"}"#;
        let n = parse_name(reply).expect("should parse");
        assert_eq!(n.title, "Fix Login Redirect");
        assert_eq!(n.description, "Stops the OAuth login loop after a token refresh");
    }

    #[test]
    fn parses_through_markdown_fences_and_prose() {
        let reply = "Sure! Here you go:\n```json\n{\"title\": \"Add Dark Mode\", \"description\": \"Adds a dark mode toggle to the settings page\"}\n```";
        let n = parse_name(reply).expect("should parse despite fences");
        assert_eq!(n.title, "Add Dark Mode");
        assert_eq!(n.description, "Adds a dark mode toggle to the settings page");
    }

    #[test]
    fn parse_caps_the_title_length() {
        // Model ignores the word budget — we still clamp the title to 5 words. Description is free.
        let reply = r#"{"title":"A B C D E F G","description":"a b c d e"}"#;
        let n = parse_name(reply).expect("should parse");
        assert_eq!(n.title.split_whitespace().count(), 5);
    }

    #[test]
    fn parse_name_rejects_a_missing_title() {
        // A JSON object with no usable title is not a name.
        assert!(parse_name(r#"{"description":"only a description"}"#).is_none());
        assert!(parse_name("just a plain title, no json").is_none());
    }

    #[test]
    fn parse_name_tolerates_a_missing_description() {
        let n = parse_name(r#"{"title":"Voice Dictation Pipeline"}"#).expect("title alone is usable");
        assert_eq!(n.title, "Voice Dictation Pipeline");
        assert_eq!(n.description, "");
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
        let reply = r#"{"title":"Skip Onboarding Step","description":"Adds a skip button to the onboarding flow"}"#;
        let n = interpret_reply(reply).expect("a titled object must not be treated as SKIP");
        assert_eq!(n.title, "Skip Onboarding Step");
    }

    #[test]
    fn interpret_reply_parses_the_object() {
        let reply = r#"{"title":"Fix Auth Bug","description":"Fixes the OAuth login bug on token refresh"}"#;
        let n = interpret_reply(reply).expect("should parse");
        assert_eq!(n.title, "Fix Auth Bug");
        assert_eq!(n.description, "Fixes the OAuth login bug on token refresh");
    }

    #[test]
    fn interpret_reply_falls_back_to_a_plain_title() {
        let n = interpret_reply("Voice Dictation Pipeline").expect("plain title is usable");
        assert_eq!(n.title, "Voice Dictation Pipeline");
        assert_eq!(n.description, ""); // no JSON → no description
    }

    #[test]
    fn interpret_reply_errors_on_empty() {
        assert!(interpret_reply("   ").is_err());
    }

    #[test]
    fn interpret_reply_rejects_conversational_refusals() {
        // The field bug: an attachment-only message fed the naming model emoji-count markers, so
        // Haiku replied conversationally and that text became the agent name. The frontend now
        // stops sending those, but as defense-in-depth a non-JSON reply that opens like a refusal/
        // apology/clarifying question must be rejected, not turned into a 5-word title.
        for reply in [
            "I can see you've shared an image, but I'm unable to view its contents.",
            "I don't see any image attached to your message. Could you re-send it?",
            "I'm sorry, but I can't determine what work to name from this.",
            "Unfortunately there isn't enough here to name a session.",
            "Could you tell me what you'd like to work on?",
        ] {
            assert!(interpret_reply(reply).is_err(), "should reject conversational reply: {reply:?}");
        }
    }

    #[test]
    fn interpret_reply_still_keeps_a_genuine_plain_title() {
        // The conversational guard must not swallow real Title-Case plain-title fallbacks.
        for title in ["Voice Dictation Pipeline", "Fix OAuth Redirect Loop", "Image Upload Flow"] {
            let n = interpret_reply(title).expect("a genuine plain title must survive");
            assert_eq!(n.title, sanitize_name(title, 5));
        }
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
        assert!(SYSTEM_PROMPT.contains("description"), "prompt must ask for a description, not just a title");
    }

    #[test]
    fn interpret_reply_rejects_truncated_json_instead_of_leaking_braces() {
        // The real bug from the field: too small a max_tokens cut the reply off mid-object, so
        // there's no closing `}`. parse_name can't parse it, and a naive plain-title fallback
        // would stringify the raw braces into the name (e.g. `{"title": "URL Path…`). A reply that
        // is an ATTEMPTED JSON object (contains `{`) but won't parse must error, so the caller
        // keeps the existing name rather than showing raw JSON.
        let truncated = "```json\n{ \"title\": \"URL Path Clickable Navigation\", \"description\": \"Make";
        let out = interpret_reply(truncated);
        assert!(out.is_err(), "truncated JSON must error, not become a name: {out:?}");

        // And on the failure path nothing leaks: if it ever did return Ok, neither field may carry
        // a stray brace or quote from the raw reply.
        if let Ok(n) = out {
            for v in [&n.title, &n.description] {
                assert!(!v.contains('{') && !v.contains('"'), "leaked raw JSON into a name: {v}");
            }
        }
    }
}

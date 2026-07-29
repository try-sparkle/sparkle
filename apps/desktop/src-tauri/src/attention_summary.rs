// Attention summarizer: given the tail of an agent's terminal screen at the moment it started
// asking the user something (a `waiting` question or an `approval` prompt), produce a short,
// notification-friendly line saying WHAT it's asking — used as the macOS banner body so the ping
// tells you the actual question instead of a generic "Needs your answer".
//
// Like judge.rs / naming.rs this asks the cheapest Claude model (Haiku 4.5) and lives in Rust rather
// than the webview. It runs on the USER'S OWN Claude Code subscription via `claude_oneshot` — their
// authenticated `claude` CLI — not on a Sparkle-funded vendor key. Degrades gracefully: no CLI, not
// signed into Claude Code, timeout, busy, parse or empty all return Err, and the caller
// (useAttentionNotifications) falls back to the existing generic body, so the feature is a no-op
// rather than a blank banner.

use crate::claude_oneshot::{run, OneShot, Tier, CLASSIFY_TIMEOUT};

/// Cheapest current Claude model — a one-line summary needs nothing more. (claude-api skill:
/// claude-haiku-4-5 is $1/$5 per MTok; the bare alias is complete, no date suffix.) Pinning it also
/// matters now that this runs on the user's own subscription: inheriting a user configured on Opus
/// would burn ~30x their quota rendering a single notification line.
const SUMMARY_MODEL: &str = "claude-haiku-4-5";

/// A single short line out (≤ ~12 words), so a tiny budget is plenty.
const SUMMARY_MAX_TOKENS: u32 = 40;

/// Bound the input so a giant scrollback can't amplify the user's subscription spend. The ask always
/// sits at the END of the visible screen, so we keep the TAIL.
const SCREEN_TAIL_CHARS: usize = 2000;

/// Hard cap on the returned summary length (chars) — a notification body shows only a line or two,
/// and this also defends against a model that ignores the word limit.
const SUMMARY_CAP_CHARS: usize = 100;

const SYSTEM_PROMPT: &str = "You write a SINGLE short macOS-notification body line summarizing what \
a coding agent is asking the user to answer or approve. You are given the tail of the agent's \
terminal screen; the question or approval prompt sits at the end. Write at most 12 words, in plain \
text, in the agent's voice or neutral phrasing (e.g. 'Want me to hold until you give the \
go-ahead?'). Output ONLY that one line — no quotes, no preamble, no label, no trailing whitespace, \
no markdown.";

/// Take the last `max` chars of `s` (on a char boundary), trimmed. The ask lives at the end of the
/// visible screen, so the tail is the part that matters.
fn tail(s: &str, max: usize) -> String {
    let t = s.trim();
    let n = t.chars().count();
    if n <= max {
        return t.to_string();
    }
    t.chars().skip(n - max).collect::<String>().trim().to_string()
}

/// Collapse internal whitespace runs (incl. newlines) to single spaces, trim, and hard-cap to
/// `SUMMARY_CAP_CHARS` on a char boundary. Keeps the banner to one tidy line regardless of what the
/// model returned. Exposed for testing so the cap/collapse is pinned without a network call.
fn clean_summary(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= SUMMARY_CAP_CHARS {
        return collapsed;
    }
    collapsed
        .chars()
        .take(SUMMARY_CAP_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Summarize what an agent is asking the user, from the tail of its terminal screen. Returns the
/// cleaned one-line body. Returns Err on any failure (no key, empty input/result, network, HTTP
/// error, parse) so the caller degrades to the generic notification body.
#[tauri::command]
pub async fn summarize_attention(
    screen: String,
    // Display name of the project whose agent is asking. Diagnostic only now — it used to attribute
    // a credit debit, and there is no longer a debit to attribute.
    project: Option<String>,
) -> Result<String, String> {
    let screen = tail(&screen, SCREEN_TAIL_CHARS);
    // Nothing to summarize — an empty screen isn't an ask. (The caller pre-filters, but a
    // direct/empty call must not spend a turn of the user's quota.)
    if screen.is_empty() {
        return Err("empty screen".into());
    }

    // Spawning the CLI and waiting out its wall clock is blocking work — keep it off the async
    // runtime's worker threads, exactly as the proxy call it replaced did. The Sparkle bearer read
    // and its "not signed in" precondition are gone: this runs on the user's own Claude Code login.
    tauri::async_runtime::spawn_blocking(move || call_summarize(&screen, project.as_deref()))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Build the request. Split out so the encoded decisions are testable — each compiles fine when
/// wrong and produces no visible error. See the test.
fn summary_request<'a>(screen: &'a str, project: Option<&'a str>) -> OneShot<'a> {
    OneShot {
        model: SUMMARY_MODEL,
        system: SYSTEM_PROMPT,
        user: screen,
        max_tokens: SUMMARY_MAX_TOKENS,
        timeout: CLASSIFY_TIMEOUT,
        // Background: the notification already has a usable generic body, so nothing is blocked on
        // this landing.
        tier: Tier::Background,
        // The summary is a pure function of the screen tail. An agent that re-raises the same
        // unanswered prompt must not re-summarize it.
        cacheable: true,
        purpose: "attention-summary",
        project,
    }
}

fn call_summarize(screen: &str, project: Option<&str>) -> Result<String, String> {
    let text = run(summary_request(screen, project))?;
    let cleaned = clean_summary(&text);
    if cleaned.is_empty() {
        return Err("summarize returned empty text".into());
    }
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attention_summary_runs_in_the_background_tier_and_caches() {
        // Same reasoning as judge/naming: the notification already has a usable generic body, so
        // nothing is blocked on this, and a re-raised identical prompt must not re-summarize.
        let req = summary_request("Do you want to continue? (y/n)", None);
        assert_eq!(req.tier, crate::claude_oneshot::Tier::Background);
        assert!(req.cacheable);
        assert_eq!(req.model, "claude-haiku-4-5");
    }

    #[test]
    fn tail_keeps_the_end_within_the_budget() {
        assert_eq!(tail("short", 100), "short");
        // The ask is at the end — tail keeps it, drops the lead.
        let long = format!("{}HOLD HERE?", "x".repeat(50));
        assert_eq!(tail(&long, 10), "HOLD HERE?");
    }

    #[test]
    fn tail_bounds_a_giant_screen() {
        let giant = format!("{}Want me to hold?", "noise ".repeat(2000));
        let t = tail(&giant, SCREEN_TAIL_CHARS);
        assert!(t.ends_with("Want me to hold?"));
        assert!(t.chars().count() <= SCREEN_TAIL_CHARS);
    }

    #[test]
    fn clean_summary_collapses_whitespace() {
        assert_eq!(
            clean_summary("  Want me   to\nhold\there?  "),
            "Want me to hold here?"
        );
    }

    #[test]
    fn clean_summary_caps_a_long_line() {
        let long = "word ".repeat(60); // 300 chars before collapse
        let cleaned = clean_summary(&long);
        assert!(cleaned.chars().count() <= SUMMARY_CAP_CHARS);
    }

    #[test]
    fn clean_summary_passes_a_short_line_through() {
        assert_eq!(
            clean_summary("Want me to hold until you give the go-ahead?"),
            "Want me to hold until you give the go-ahead?"
        );
    }

    #[test]
    fn clean_summary_empty_when_only_whitespace() {
        assert_eq!(clean_summary("   \n\t  "), "");
    }
}

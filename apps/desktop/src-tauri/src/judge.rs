// Followup judge (tune-coloring): given the TASK an agent was working on and its FINAL message,
// decide whether the finished turn is BLOCKED on the user (a closeout ask like "want me to land
// it?") versus genuinely done or merely offering optional new work. The frontend turns a
// "blocked on you" verdict into a RED status; everything else stays gray.
//
// Like naming.rs this asks the cheapest Claude model (Haiku 4.5) and lives in Rust — not the
// webview — so the BYOK Anthropic key never ships in the JS bundle. It reuses
// `naming::resolve_anthropic_key` for identical key resolution and `ai::extract_text` for the
// Messages-API reply shape. Degrades gracefully: no key / network / parse failure returns Err, and
// the caller treats any failure as "not a followup" (gray), so the feature is a no-op until a key
// exists rather than a hard error or a false red.

use std::time::Duration;

use crate::ai::extract_text;
use crate::naming::resolve_anthropic_key;

/// Cheapest current Claude model — a one-word classification needs nothing more. (claude-api skill:
/// claude-haiku-4-5 is $1/$5 per MTok; the bare alias is complete, no date suffix.)
const JUDGE_MODEL: &str = "claude-haiku-4-5";

/// Bound the Anthropic call so a stalled api.anthropic.com can't pin a spawn_blocking thread
/// forever and exhaust the blocking pool. ureq has no default timeout; a hung endpoint then hits
/// the existing Err path (which the caller degrades to gray). A one-word verdict returns fast, so
/// the read budget is modest. Mirrors connectivity.rs's AgentBuilder shape.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// One word out, so a tiny budget is plenty (a couple tokens of headroom over "FOLLOWUP").
const JUDGE_MAX_TOKENS: u32 = 8;

/// Bound the inputs so a giant transcript can't amplify BYOK token spend. The ask always sits at
/// the END of the final message, so we keep its TAIL; the task is short context, so we keep its head.
const RESPONSE_TAIL_CHARS: usize = 2000;
const TASK_HEAD_CHARS: usize = 400;

const SYSTEM_PROMPT: &str = "You classify whether a coding agent's finished message hands the turn \
back to the user. You are given THE TASK the agent was working on and its FINAL MESSAGE. Reply with \
EXACTLY ONE word: FOLLOWUP or DONE. Output only that word — no punctuation, no explanation.\n\
Reply FOLLOWUP when the agent ended its turn waiting on the user — it needs the user to do, decide, \
answer, or approve something before the work moves forward. This INCLUDES a yes/no offer to take the \
OBVIOUS NEXT ACTION on the TASK AT HAND and then stopping for the answer: 'Want me to open it?', \
'Should I land it now?', 'Want me to land it and cut the release?' — the turn is over and the next \
step is blocked on the user's reply. It also includes approving/confirming a land/merge/push/deploy, \
answering a question the agent needs in order to continue, choosing between options it laid out, or a \
manual step only the user can do. The defining trait: the agent stopped and the ball is in the \
user's court.\n\
Reply DONE only when nothing is awaited from the user: a plain completion report with no ask, or an \
offer of genuinely NEW, tangential, or unrequested work BEYOND the task at hand (e.g. 'want me to \
also tackle that unrelated bug?', 'should I refactor a different module next?'). An offer to do the \
next obvious step OF THIS TASK is FOLLOWUP, not DONE.\n\
When genuinely unsure, reply FOLLOWUP.";

/// Take the last `max` chars of `s` (on a char boundary), trimmed. The closeout ask lives at the
/// end of a finished turn, so the tail is the part that matters.
fn tail(s: &str, max: usize) -> String {
    let t = s.trim();
    let n = t.chars().count();
    if n <= max {
        return t.to_string();
    }
    t.chars().skip(n - max).collect::<String>().trim().to_string()
}

/// Take the first `max` chars of `s` (on a char boundary), trimmed.
fn head(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect::<String>().trim().to_string()
}

/// Build the user message handed to the judge. Exposed for testing so the truncation/labeling is
/// pinned without a network call.
fn build_user_message(task: &str, response: &str) -> String {
    let task = head(task, TASK_HEAD_CHARS);
    let response = tail(response, RESPONSE_TAIL_CHARS);
    let task_line = if task.is_empty() { "(unknown)".to_string() } else { task };
    format!("TASK: {task_line}\n\nFINAL MESSAGE:\n{response}")
}

/// Classify a finished turn. Returns the model's one-word verdict text (typically "FOLLOWUP" or
/// "DONE"); the frontend interprets it leniently (turnFollowup.ts). Returns Err on any failure (no
/// key, empty response, network, HTTP error, empty result) so the caller degrades to gray.
#[tauri::command]
pub async fn judge_turn_followup(task: String, response: String) -> Result<String, String> {
    let response = response.trim().to_string();
    // Nothing to judge — an empty turn isn't an ask. (The frontend already pre-filters, but a
    // direct/empty call must not bill a request.)
    if response.is_empty() {
        return Err("empty response".into());
    }
    let key = resolve_anthropic_key().ok_or_else(|| {
        "no Anthropic API key (set ANTHROPIC_API_KEY or add it to .env.local)".to_string()
    })?;

    // ureq is blocking; keep it off the async runtime's worker.
    tauri::async_runtime::spawn_blocking(move || call_judge(&key, &task, &response))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn call_judge(key: &str, task: &str, response: &str) -> Result<String, String> {
    let user = build_user_message(task, response);
    let body = serde_json::json!({
        "model": JUDGE_MODEL,
        "max_tokens": JUDGE_MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": user }],
    });
    let body_str = serde_json::to_string(&body).map_err(|e| format!("serialize: {e}"))?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build();
    let resp = agent
        .post("https://api.anthropic.com/v1/messages")
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
            tracing::debug!(code, detail = %detail, "anthropic judge call returned an error status");
            return Err(format!("judge failed (Anthropic HTTP {code})"));
        }
        Err(e) => {
            tracing::debug!(error = %e, "anthropic judge request failed");
            return Err("judge request failed".into());
        }
    };
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad JSON: {e}"))?;
    extract_text(&json).ok_or_else(|| "judge returned no text".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_end_within_the_budget() {
        assert_eq!(tail("short", 100), "short");
        // The ask is at the end — tail keeps it, drops the lead.
        let long = format!("{}LAND IT?", "x".repeat(50));
        assert_eq!(tail(&long, 8), "LAND IT?");
    }

    #[test]
    fn head_keeps_the_start_within_the_budget() {
        assert_eq!(head("short", 100), "short");
        assert_eq!(head("abcdefghij", 4), "abcd");
    }

    #[test]
    fn build_user_message_labels_and_truncates() {
        let msg = build_user_message("Fix the login loop", "All done. Want me to land it?");
        assert!(msg.starts_with("TASK: Fix the login loop"));
        assert!(msg.contains("FINAL MESSAGE:"));
        assert!(msg.ends_with("Want me to land it?"));
    }

    #[test]
    fn build_user_message_marks_an_unknown_task() {
        let msg = build_user_message("   ", "Want me to land it?");
        assert!(msg.starts_with("TASK: (unknown)"));
    }

    #[test]
    fn build_user_message_bounds_a_giant_response() {
        let giant = format!("{}Want me to land it?", "noise ".repeat(2000));
        let msg = build_user_message("task", &giant);
        // The label + tail survive; the giant lead is dropped to bound token spend.
        assert!(msg.contains("Want me to land it?"));
        assert!(msg.chars().count() < RESPONSE_TAIL_CHARS + TASK_HEAD_CHARS + 64);
    }
}

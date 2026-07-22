// Followup judge (tune-coloring): given the TASK an agent was working on and its FINAL message,
// decide whether the finished turn is BLOCKED on the user (a closeout ask like "want me to land
// it?") versus genuinely done or merely offering optional new work. The frontend turns a
// "blocked on you" verdict into a RED status; everything else stays gray.
//
// Like naming.rs this asks the cheapest Claude model (Haiku 4.5) and lives in Rust — not the
// webview — so the user's Sparkle bearer never ships in the JS bundle. The call goes through the
// server-side `/ai/anthropic` proxy (`ai::call_anthropic_proxy`); the server holds the vendor key
// and meters credits. Degrades gracefully: signed out / out of credits / network / parse failure
// returns Err, and the caller treats any failure as "not a followup" (gray), so the feature is a
// no-op until the user is signed in with credit rather than a hard error or a false red.

use crate::ai::{call_anthropic_proxy, extract_text, CLASSIFY_READ_TIMEOUT};

/// Cheapest current Claude model — a one-word classification needs nothing more. (claude-api skill:
/// claude-haiku-4-5 is $1/$5 per MTok; the bare alias is complete, no date suffix.) It is also the
/// only model the server-side proxy meters, so every proxied call must use it.
const JUDGE_MODEL: &str = "claude-haiku-4-5";

/// One word out, so a tiny budget is plenty (a couple tokens of headroom over "FOLLOWUP").
const JUDGE_MAX_TOKENS: u32 = 8;

/// Bound the inputs so a giant transcript can't amplify BYOK token spend. The ask always sits at
/// the END of the final message, so we keep its TAIL; the task is short context, so we keep its head.
const RESPONSE_TAIL_CHARS: usize = 2000;
const TASK_HEAD_CHARS: usize = 400;

const SYSTEM_PROMPT: &str = "You classify whether a coding agent's finished message leaves the work \
BLOCKED on the user — stopped, unable to move forward until the user acts. You are given THE TASK the \
agent was working on and its FINAL MESSAGE. Reply with EXACTLY ONE word: FOLLOWUP or DONE. Output \
only that word — no punctuation, no explanation.\n\
Reply FOLLOWUP only when a SPECIFIC next step is parked on the user. Concretely: (a) the agent has \
PREPARED a concrete next action on THE WORK IT JUST DID and is stopping for a go/no-go before doing \
it — 'Want me to land it now?', 'Should I open the PR?', 'Want me to land it and cut the release?'; \
(b) it needs the user to approve/confirm a specific land/merge/push/deploy; (c) it asked a specific \
question whose answer it NEEDS to continue work already underway, or to choose between concrete \
options it laid out; or (d) a manual step only the user can do stands between it and finishing. The \
defining trait: a specific, identifiable next step exists and is blocked solely on the user's reply.\n\
Reply DONE when nothing blocks the work. This INCLUDES three important cases: (1) a plain completion \
or status report with no ask; (2) an offer of NEW, additional, tangential, or optional work BEYOND \
what was asked, EVEN phrased as an offer — 'Want me to kick off new work?', 'Should I also tackle \
that unrelated bug?', 'Want me to refactor a different module next?'; and (3) a FINISHED task that \
ends by asking OPEN-ENDEDLY what to do next — 'What would you like to pick up next?', 'Where should I \
focus?', 'Anything else you'd like?'. A status recap that concludes 'nothing needs your attention — \
what next?' is DONE: the report is the task, it is complete, and the agent is merely soliciting the \
next task, not blocked on one.\n\
Decide by the SHAPE of the ask: a concrete staged action awaiting go/no-go is FOLLOWUP; an \
open-ended 'what would you like next?' is DONE. When the ask is open-ended, prefer DONE. Only reply \
FOLLOWUP when a specific next step is genuinely stuck on the user and you cannot tell whether it was \
requested.";

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
    // Server-side proxy on the user's bearer (see module docs).
    let base = crate::auth::base_url(); // just an env read — cheap, non-blocking.

    // ureq is blocking AND the keychain read is a syscall that can block on a locked keychain — keep
    // BOTH off the async runtime's worker by resolving the token inside the blocking closure. No
    // token → signed out; degrade (gray verdict) rather than call the proxy.
    tauri::async_runtime::spawn_blocking(move || {
        let token = crate::auth::bearer_token().ok_or_else(|| "not signed in".to_string())?;
        call_judge(&base, &token, &task, &response)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn call_judge(base: &str, token: &str, task: &str, response: &str) -> Result<String, String> {
    let user = build_user_message(task, response);
    let json = call_anthropic_proxy(
        base,
        token,
        JUDGE_MODEL,
        SYSTEM_PROMPT,
        &user,
        JUDGE_MAX_TOKENS,
        CLASSIFY_READ_TIMEOUT,
        Some("Checking whether an agent needs you"), // metering description shown in the credit history
    )?;
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

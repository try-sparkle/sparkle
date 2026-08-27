// Followup judge (tune-coloring): given the TASK an agent was working on and its FINAL message,
// decide whether the finished turn is BLOCKED on the user (a closeout ask like "want me to land
// it?") versus genuinely done or merely offering optional new work. The frontend turns a
// "blocked on you" verdict into a RED status; everything else stays gray.
//
// Like naming.rs this asks the cheapest Claude model (Haiku 4.5) and lives in Rust rather than the
// webview. It runs on the USER'S OWN Claude Code subscription via `claude_oneshot` — their
// authenticated `claude` CLI — not on a Sparkle-funded vendor key. It used to POST to the
// orchestration `/ai/anthropic` proxy, whose key ran out of credit on 2026-07-28 and took every
// verdict down with it; there is no longer a Sparkle-side key to exhaust, and no credit to meter.
//
// FAILURE CONTRACT — read this before changing the caller. Every failure (no `claude` on PATH, not
// signed into Claude Code, timeout, busy, parse failure) returns Err, and Err means EXACTLY ONE
// thing: NO VERDICT EXISTS. It does not mean "done" and it does not mean "needs you". The caller
// must paint no status from it.
//
// That distinction is the whole lesson of 2026-07-28. The caller then failed CLOSED to red whenever
// the turn's tail carried a phrase like "want me to" — a rule written for users who had simply never
// configured a key, where guessing was bounded. When the backend died for everyone at once, the
// guess became the ONLY verdict any agent got, and paged the human on nearly every finished turn.
// Neither guess is available to a component that could not run. Say nothing, and let the caller
// decide what to render.

use crate::claude_oneshot::{run, OneShot, Tier, CLASSIFY_TIMEOUT};

/// Cheapest current Claude model — a one-word classification needs nothing more. (claude-api skill:
/// claude-haiku-4-5 is $1/$5 per MTok; the bare alias is complete, no date suffix.) Pinning it also
/// matters now that this runs on the user's own subscription: inheriting a user configured on Opus
/// would burn ~30x their quota rendering a single word.
const JUDGE_MODEL: &str = "claude-haiku-4-5";

/// One word out, so a tiny budget is plenty (a couple tokens of headroom over "FOLLOWUP").
const JUDGE_MAX_TOKENS: u32 = 8;

/// Bound the inputs so a giant transcript can't amplify the user's subscription spend. The ask
/// always sits at the END of the final message, so we keep its TAIL; the task is short context, so
/// we keep its head.
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
/// "DONE"); the frontend interprets it leniently (turnFollowup.ts). Returns Err on any failure —
/// see the FAILURE CONTRACT in the module docs: Err means no verdict exists, not "done".
///
/// Note what is NO LONGER here: the Sparkle bearer-token read and its "not signed in" precondition.
/// The judge runs on the user's own Claude Code login now, so it works whether or not they have a
/// Sparkle account.
#[tauri::command]
pub async fn judge_turn_followup(
    // INJECTED BY TAURI — the JS call signature is unchanged. It carries the health signal for a
    // real spawn back to `aiServiceHealthStore`; see `claude_oneshot::AI_SPAWN_OK_EVENT`.
    app: tauri::AppHandle,
    task: String,
    response: String,
    // Display name of the project whose agent produced this turn. Diagnostic only now — it used to
    // attribute a credit debit, and there is no longer a debit to attribute.
    project: Option<String>,
    // The account config dir this call should run under, or None to inherit the ambient default
    // account. The JS failover selector supplies a healthy account here when the default is walled.
    // See `claude_oneshot::OneShot::config_dir`.
    config_dir: Option<String>,
) -> Result<String, String> {
    let response = response.trim().to_string();
    // Nothing to judge — an empty turn isn't an ask. (The frontend already pre-filters, but a
    // direct/empty call must not spend a turn of the user's quota.)
    if response.is_empty() {
        return Err("empty response".into());
    }

    // Spawning the CLI and waiting out its wall clock is blocking work — keep it off the async
    // runtime's worker threads, exactly as the proxy call it replaced did.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        call_judge(&task, &response, project.as_deref(), config_dir.as_deref())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?;
    crate::claude_oneshot::finish_cacheable(&app, outcome)
}

/// Build the request. Split out from `call_judge` so the three decisions encoded here are TESTABLE:
/// each one compiles fine when wrong and produces no visible error at runtime, so without a test
/// they are only a comment.
fn judge_request<'a>(user: &'a str, project: Option<&'a str>) -> OneShot<'a> {
    OneShot {
        model: JUDGE_MODEL,
        system: SYSTEM_PROMPT,
        user,
        max_tokens: JUDGE_MAX_TOKENS,
        timeout: CLASSIFY_TIMEOUT,
        // Background: nobody is staring at a spinner waiting for this. It must never take the last
        // concurrency slot from a call the user IS waiting on — 50 agents finishing at once is the
        // ordinary case, not the edge case.
        tier: Tier::Background,
        // The verdict is a pure function of (task, final message), so an unchanged message must
        // never be re-judged. This is the single biggest saving in the whole migration: the judge's
        // job is largely re-answering questions it has already answered.
        cacheable: true,
        purpose: "judge",
        project,
        // Set per-call by `call_judge` from the JS failover selector; the builder defaults to the
        // ambient account. See `claude_oneshot::OneShot::config_dir`.
        config_dir: None,
    }
}

/// Returns the verdict text AND whether a real `claude` child produced it — the caller emits the
/// health signal from the latter. See `claude_oneshot::OneShotReply`.
/// Same `(Result, bool)` shape as naming/attention so all three funnel through
/// `claude_oneshot::finish_cacheable`. The judge has no post-processing that can reject a reply, so
/// the two shapes are equivalent HERE — it is written this way so the three call sites are
/// identical and a reader cannot mistake this one for the exception.
fn call_judge(
    task: &str,
    response: &str,
    project: Option<&str>,
    config_dir: Option<&str>,
) -> (Result<String, String>, bool) {
    let user = build_user_message(task, response);
    let mut req = judge_request(&user, project);
    // Route to the failover account when one was chosen; None/"" leaves the ambient default.
    req.config_dir = config_dir;
    match run(req) {
        Err(e) => (Err(e), false),
        Ok(reply) => (Ok(reply.text), reply.spawned),
    }
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
    fn the_judge_runs_in_the_background_tier_and_caches() {
        // Every one of these compiles when flipped and produces no visible error, which is exactly
        // why they need pinning:
        //  - Interactive would let a 50-agent judge storm take the last slot from a blocked human,
        //    the specific starvation the tier split exists to prevent.
        //  - cacheable:false would re-judge every unchanged final message, the migration's single
        //    biggest saving.
        //  - an unpinned model would inherit a user configured on Opus and burn ~30x their own
        //    subscription quota rendering one word.
        let req = judge_request("TASK: x\n\nFINAL MESSAGE:\ny", None);
        assert_eq!(req.tier, crate::claude_oneshot::Tier::Background);
        assert!(req.cacheable);
        assert_eq!(req.model, "claude-haiku-4-5");
        assert_eq!(req.max_tokens, JUDGE_MAX_TOKENS);
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
